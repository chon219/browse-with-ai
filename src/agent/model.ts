import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, defaultToolCallParser, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel, BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models';
import type { ModelConfig } from '../shared/types';
import type { RequestUsage } from '../shared/usage';
import { endpoint } from '../shared/settings';
import { MODEL_REQUEST } from '../shared/tuning';
import { LocalizedError, type MessageKey, type Params, t } from '../i18n';
export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface ChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | ContentPart[] | null; tool_calls?: ToolCall[]; tool_call_id?: string }
const hasImages = (messages: ChatMessage[]) => messages.some(m => Array.isArray(m.content) && m.content.some(part => part.type === 'image_url'));
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface FunctionTool { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface ModelReply { content: string | null; tool_calls?: ToolCall[]; usage?: RequestUsage }
/** Allows createAgent's model middleware to invoke the same configured transport. */
export type ModelInvoker = (model: BaseChatModel, messages: BaseMessage[], options: BaseChatModelCallOptions) => Promise<AIMessage>;

export function createModel(config: ModelConfig, maxTokens?: number) {
  return new ChatOpenAI({
    model: config.model, apiKey: config.apiKey, maxTokens, maxRetries: 0,
    timeout: MODEL_REQUEST.timeoutMs, streaming: false, useResponsesApi: false,
    configuration: { baseURL: endpoint(config.baseUrl).replace(/\/chat\/completions$/, ''), dangerouslyAllowBrowser: true },
  });
}

export function modelMessages(messages: ChatMessage[]): BaseMessage[] {
  return messages.map(message => {
    const content = message.content ?? '';
    if (message.role === 'system') return new SystemMessage({ content });
    if (message.role === 'user') return new HumanMessage({ content });
    if (message.role === 'tool') return new ToolMessage({ content, tool_call_id: message.tool_call_id! });
    const [tool_calls, invalid_tool_calls] = defaultToolCallParser(message.tool_calls ?? []);
    return new AIMessage({ content, tool_calls, invalid_tool_calls, additional_kwargs: { tool_calls: message.tool_calls } });
  });
}
const tokenCount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
/** Token usage as reported in a Chat Completions response, when the service reports it. */
function reportedUsage(usage: { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined): RequestUsage | undefined {
  const prompt = tokenCount(usage?.prompt_tokens); const completion = tokenCount(usage?.completion_tokens);
  return prompt === undefined ? undefined : { prompt, completion: completion ?? 0 };
}
export class ModelError extends LocalizedError { constructor(key: MessageKey, params?: Params, public retryable = false, public usage?: RequestUsage) { super(key, params); } }
function redact(text: string, key: string) { return key ? text.split(key).join(t('model.redacted')) : text; }
function redactMessage(message: AIMessage, key: string) {
  const fields = { id: message.id, content: message.content, tool_calls: message.tool_calls, invalid_tool_calls: message.invalid_tool_calls,
    additional_kwargs: message.additional_kwargs, response_metadata: message.response_metadata, usage_metadata: message.usage_metadata };
  const safe = JSON.parse(JSON.stringify(fields, (_field, value) => typeof value === 'string' ? redact(value, key) : value));
  Object.assign(message, new AIMessage(safe));
}
export async function chat(config: ModelConfig, messages: ChatMessage[], signal: AbortSignal, tools?: FunctionTool[], forceTool?: string, maxTokens?: number, invoke?: ModelInvoker): Promise<ModelReply> {
  if (!config.model.trim() || !config.apiKey.trim()) throw new ModelError('model.notConfigured');
  for (let attempt = 0; attempt < (maxTokens === undefined ? MODEL_REQUEST.attempts : 1); attempt++) {
    signal.throwIfAborted();
    try {
      const model = createModel(config, maxTokens);
      const options = { signal: AbortSignal.any([signal, AbortSignal.timeout(MODEL_REQUEST.timeoutMs)]),
        ...(tools ? { tools, tool_choice: forceTool ? { type: 'function' as const, function: { name: forceTool } } : 'auto' as const } : {}) };
      const reply = invoke ? await invoke(model, modelMessages(messages), options) : await model.invoke(modelMessages(messages), options);
      // createAgent retains this message for checkpoint writes. Redact its native
      // representation too, including malformed tool arguments and provider metadata.
      redactMessage(reply, config.apiKey);
      const usage = reportedUsage(reply.response_metadata.usage as Parameters<typeof reportedUsage>[0])
        ?? (tokenCount(reply.usage_metadata?.input_tokens) === undefined ? undefined : { prompt: reply.usage_metadata!.input_tokens, completion: reply.usage_metadata?.output_tokens ?? 0 });
      const finish = reply.response_metadata.finish_reason;
      if (finish === 'length') throw new ModelError('model.outputTruncated', undefined, false, usage);
      if (finish === 'content_filter') throw new ModelError('model.outputFiltered', undefined, false, usage);
      const calls = reply.additional_kwargs.tool_calls ?? [
        ...(reply.tool_calls ?? []).map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })),
        ...(reply.invalid_tool_calls ?? []).map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.args } })),
      ];
      if (!Array.isArray(calls) || calls.some(c => typeof c.id !== 'string' || c.type !== 'function' || typeof c.function?.name !== 'string' || typeof c.function?.arguments !== 'string')) throw new ModelError('model.invalidToolCalls');
      return { ...(usage ? { usage } : {}), content: redact(reply.text, config.apiKey),
        tool_calls: calls.map(c => ({ id: c.id!, type: 'function', function: { name: c.function.name!, arguments: redact(c.function.arguments!, config.apiKey) } })) };
    } catch (err) {
      signal.throwIfAborted();
      const error = transportError(err, hasImages(messages));
      if (!error.retryable) throw error;
      if (maxTokens !== undefined || attempt === MODEL_REQUEST.attempts - 1) throw error;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, MODEL_REQUEST.backoffMs * 2 ** attempt + Math.random() * MODEL_REQUEST.jitterMs);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
  }
  throw new ModelError('model.failed');
}
function transportError(error: unknown, images: boolean): ModelError {
  if (error instanceof ModelError) return error;
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : undefined;
  if (status === 401 || status === 403) return new ModelError('model.authFailed');
  if (status === 400 && images) return new ModelError('model.imagesRejected');
  if (status) return new ModelError('model.httpFailed', { status }, status === 429 || status >= 500);
  // LangChain middleware wraps errors in .cause. Never expose provider response bodies.
  if (error instanceof Error && error.name !== 'APIConnectionError' && error.cause) return transportError(error.cause, images);
  return new ModelError('model.networkFailed', undefined, true);
}
export async function testConnection(config: ModelConfig, signal: AbortSignal) {
  const tool: FunctionTool = { type: 'function', function: { name: 'connection_test', description: 'Return the test result', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } };
  const result = await chat(config, [{ role: 'user', content: 'Call connection_test with ok=true.' }], signal, [tool], 'connection_test');
  const call = result.tool_calls?.find(c => c.function.name === 'connection_test');
  if (!call || JSON.parse(call.function.arguments).ok !== true) throw new LocalizedError('model.toolTestFailed');
}
/**
 * Whether the model reads images: it is shown a freshly drawn number and must say which. A service that
 * rejects the image, or a model that cannot read it, does not support image input.
 */
export async function probeVision(config: ModelConfig, signal: AbortSignal, probe: { dataUrl: string; answer: string }): Promise<boolean> {
  try {
    const reply = await chat(config, [{ role: 'user', content: [
      { type: 'text', text: 'What number is shown in this image? Reply with the digits only.' },
      { type: 'image_url', image_url: { url: probe.dataUrl } },
    ] }], signal);
    return (reply.content ?? '').replace(/\D/g, '') === probe.answer;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ModelError && ['model.imagesRejected', 'model.httpFailed', 'model.incompatible'].includes(error.text.key)) return false;
    throw error;
  }
}
