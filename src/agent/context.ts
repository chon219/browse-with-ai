import type { ChatMessage, ContentPart, FunctionTool, ModelReply, ModelInvoker } from './model';
import { ModelError } from './model';
import type { AgentContext, AgentStore } from './ports';
import type { State } from './state';
import type { Task } from '../shared/types';
import type { WorkspaceFile } from '../shared/workspace';
import { isImage } from '../shared/workspace';
import { conversationMessages } from '../shared/conversation';
import { TOKEN_LIMIT, TokenLimitError, turnTokens } from '../shared/budget';
import { estimateTokens, type RequestUsage } from '../shared/usage';
import { CONTEXT } from '../shared/tuning';
import type { WebPolicy } from '../shared/web-policy';
import { siteTargets } from './site-intent';
import { getLocale } from '../i18n';
import { conversationContext, forModel, modelHistory, systemPrompt, taskTitle, titlePrompt, type HistoryEntry } from './prompts';

interface ContextDeps {
  task: Task;
  store: AgentStore;
  signal: AbortSignal;
  model(messages: ChatMessage[], signal: AbortSignal, tools?: FunctionTool[], maxTokens?: number, invoke?: ModelInvoker): Promise<ModelReply>;
  definitions: FunctionTool[];
  files(): Promise<WorkspaceFile[]>;
  webPolicy?: WebPolicy;
  loadImage?: (path: string) => Promise<string>;
}

const promptTokens = (messages: ChatMessage[]) => messages.reduce((sum, m) => sum + (Array.isArray(m.content)
  ? m.content.reduce((part, item) => part + (item.type === 'text' ? estimateTokens(item.text) : CONTEXT.imageTokens), 0)
  : estimateTokens(m.content ?? '')), 0);

/** Images, context selection, transport deadlines and token accounting are request concerns. */
export function createAgentContext(deps: ContextDeps): AgentContext {
  const { task, store, signal } = deps;
  const turn = task.turn ?? 0;
  let requests: Promise<unknown> = Promise.resolve();
  const images = new Map<string, Promise<string>>();

  function shownImages(live: Task | undefined, history: HistoryEntry[] = []): string[] {
    if (!deps.loadImage || !live) return [];
    const attached = conversationMessages(live).filter(m => m.role === 'user' && m.turn === turn)
      .flatMap(m => m.attachments ?? []).filter(file => isImage(file.type)).map(file => file.path);
    const latest = history.at(-1);
    const viewed = latest?.kind === 'observation' ? latest.workspace?.image?.path : undefined;
    return [...new Set([...attached.slice(-CONTEXT.images), ...(viewed ? [viewed] : [])])];
  }

  async function userContent(input: Record<string, unknown>, paths: string[]): Promise<ChatMessage['content']> {
    const loaded = await Promise.all(paths.map(async path => {
      if (!images.has(path)) images.set(path, deps.loadImage!(path));
      try { return { path, url: await images.get(path)! }; } catch { images.delete(path); return undefined; }
    }));
    const shown = loaded.filter(image => !!image);
    const text = JSON.stringify(forModel(shown.length ? { ...input, images: shown.map(image => image.path) } : input));
    return shown.length ? [{ type: 'text', text }, ...shown.map((image): ContentPart => ({ type: 'image_url', image_url: { url: image.url } }))] : text;
  }

  async function recordUsage(usage: RequestUsage) {
    const saved = store.recordUsage(usage);
    if (task.tokenLimit !== undefined) await saved;
    else await saved.catch(() => {});
  }

  async function requestOnce(messages: ChatMessage[], withTools = false, closing: 'none' | 'progress' = 'none', recovering = false, invoke?: ModelInvoker): Promise<ModelReply> {
    signal.throwIfAborted();
    const inputTokens = promptTokens(messages) + (withTools ? estimateTokens(JSON.stringify(deps.definitions)) : 0);
    let maxTokens: number | undefined;
    if (task.tokenLimit !== undefined) {
      const live = await store.task();
      const available = task.tokenLimit - turnTokens(live ?? task) - inputTokens - (closing === 'none' ? TOKEN_LIMIT.reserve : 0);
      if (available < 256) throw new TokenLimitError(task.tokenLimit);
      maxTokens = Math.min(closing === 'progress' ? TOKEN_LIMIT.summaryOutput : TOKEN_LIMIT.output, Math.floor(available));
    }
    let reply: ModelReply;
    try { reply = await deps.model(messages, signal, withTools ? deps.definitions : undefined, maxTokens, invoke); }
    catch (error) {
      if (error instanceof ModelError && ['model.outputTruncated', 'model.outputFiltered'].includes(error.text.key)) {
        await recordUsage(error.usage ?? { estimated: true, prompt: inputTokens, completion: maxTokens ?? 0 });
        if (error.text.key === 'model.outputTruncated' && !recovering) {
          const live = await store.task();
          if (task.tokenLimit === undefined || !live || turnTokens(live) < task.tokenLimit) {
            const instruction = withTools
              ? 'Your last response exceeded the output limit and no tool call from it was executed. Return exactly one concise tool call. Split large code or file writes into smaller steps.'
              : 'Your last response exceeded the output limit. Write a concise, complete response focusing on the requested results. Do not describe the technical retry.';
            return requestOnce([...messages, { role: 'system', content: instruction }], withTools, closing, true, invoke);
          }
        }
      }
      throw error;
    }
    const usage = reply.usage ?? {
      estimated: true,
      prompt: inputTokens,
      completion: estimateTokens((reply.content ?? '') + (reply.tool_calls ? JSON.stringify(reply.tool_calls) : '')),
    };
    await recordUsage(usage);
    return reply;
  }

  function request(messages: ChatMessage[], withTools = false, closing: 'none' | 'progress' = 'none', invoke?: ModelInvoker) {
    const run = () => requestOnce(messages, withTools, closing, false, invoke);
    // Naming and decisions may overlap; an explicit token cap serializes admission and accounting.
    if (task.tokenLimit === undefined) return run();
    const pending = requests.then(run, run); requests = pending.catch(() => {}); return pending;
  }

  async function input(phase: Parameters<AgentContext['request']>[0], state: State, live: Task | undefined) {
    const notes = state.taskNotes ?? live?.taskNotes ?? '';
    const taskNotes = { taskNotes: notes.slice(0, CONTEXT.notesChars), taskNotesTruncated: notes.length > CONTEXT.notesChars };
    if (phase === 'progress') return {
      ...taskNotes,
      goal: state.goal.slice(0, 1000),
      conversation: live ? conversationContext(live).slice(-3).map(message => ({ role: message.role, content: message.content.slice(0, 600) })) : [],
      observations: state.history.slice(-6).map(entry => {
        if (entry.kind === 'note') return { note: entry.text.slice(0, 600) };
        const file = entry.workspace?.file;
        return { url: entry.snapshot?.url, text: entry.snapshot?.text.slice(0, 600),
          file: file && { path: file.path, content: 'content' in file ? file.content.slice(0, 600) : undefined },
          written: entry.workspace?.written?.path, result: entry.code?.result?.slice(0, 600), logs: entry.code?.logs.slice(0, 600),
          error: typeof entry.error === 'string' ? entry.error.slice(0, 600) : entry.error };
      }),
    };
    const files = await deps.files().catch(() => []);
    const progressSummary = live && conversationMessages(live).filter(message => message.turn === turn && message.id.startsWith('pause:')).at(-1)?.content;
    const common = { goal: state.goal, ...(progressSummary ? { progressSummary: progressSummary.slice(0, CONTEXT.messageChars) } : {}),
      availableSkills: (live ?? task).skill ? [{ name: (live ?? task).skill!.name, description: (live ?? task).skill!.description, version: (live ?? task).skill!.version }] : [],
      ...(state.loadedSkill ? { loadedSkill: { name: state.loadedSkill.name, version: state.loadedSkill.version, instructions: state.loadedSkill.instructions } } : {}),
      workspaceFiles: files.sort((a, b) => Number(a.path.startsWith('pages/')) - Number(b.path.startsWith('pages/'))).slice(0, 50),
      workspaceFileCount: files.length, workspaceFilesTruncated: files.length > 50,
      conversationCount: live ? conversationMessages(live).filter(message => message.role !== 'activity' && message.kind !== 'approval').length : 0,
      ...taskNotes };
    const current = live ?? task;
    const userMessages = conversationMessages(current).filter(message => message.role === 'user' && message.turn === turn).slice(-CONTEXT.messages);
    const mentionedSites = [...new Set([...userMessages.reverse().map(message => message.content), state.goal]
      .flatMap(text => siteTargets(text, deps.webPolicy)))].slice(0, 5);
    const page = { currentPage: current.lastPage ?? current.contextTab, attachedPage: current.contextTab };
    return { ...common, ...page, mentionedSites, visitedUrls: live?.visitedUrls ?? [], ...(task.tokenLimit === undefined ? {} : { tokensRemaining: task.tokenLimit - turnTokens(live ?? task) }) };
  }

  return {
    async request(phase, state, live, invoke) {
      const history = phase === 'decide' ? state.history : [];
      return request([
        { role: 'system', content: systemPrompt(phase, getLocale()) },
        { role: 'user', content: await userContent(await input(phase, state, live), phase === 'progress' ? [] : shownImages(live, history)) },
        ...(phase === 'decide' ? modelHistory(live ?? task, history) : []),
      ], phase === 'decide', phase === 'progress' ? phase : 'none', invoke);
    },
    async name(goal) {
      try {
        const reply = await request([{ role: 'system', content: titlePrompt(getLocale()) }, { role: 'user', content: JSON.stringify({ goal }) }]);
        const title = taskTitle(reply.content);
        if (title) await store.update({ title });
      } catch { /* Naming is optional; keep the goal as the title. */ }
    },
  };
}
