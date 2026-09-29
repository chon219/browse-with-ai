import { modelResponse } from '../fixtures/model-response';
import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { chat, modelMessages, testConnection } from '../../src/agent/model';
const config = { baseUrl: 'https://model.example/v1', model: 'test', apiKey: 'secret-key', remember: false, search: 'bing' as const };
describe('model transport', () => {
  it('replays tool history as native calls without the legacy adapter warning', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetcher = vi.fn(async (_url, _init) => modelResponse({ choices: [{ message: { content: 'Done' } }] }));
    vi.stubGlobal('fetch', fetcher);
    const calls = [{ id: 'round-1', type: 'function' as const, function: { name: 'browser', arguments: '{"action":{"name":"list_tabs"}}' } }];
    const history = [
      { role: 'assistant' as const, content: null, tool_calls: calls },
      { role: 'tool' as const, content: '{"tabs":[]}', tool_call_id: 'round-1' },
    ];
    expect((modelMessages(history)[0] as AIMessage).tool_calls).toEqual([
      { id: 'round-1', name: 'browser', args: { action: { name: 'list_tabs' } } },
    ]);
    await chat(config, history, new AbortController().signal);
    expect(JSON.parse(fetcher.mock.calls[0][1].body).messages).toEqual([
      { role: 'assistant', content: '', tool_calls: calls },
      { role: 'tool', content: '{"tabs":[]}', tool_call_id: 'round-1' },
    ]);
    expect(warning).not.toHaveBeenCalled();
  });

  it('preserves malformed tool arguments in replay so the model can repair them', async () => {
    const fetcher = vi.fn(async (_url, _init) => modelResponse({ choices: [{ message: { content: 'Done' } }] }));
    vi.stubGlobal('fetch', fetcher);
    const calls = [{ id: 'broken', type: 'function' as const, function: { name: 'browser', arguments: '{"action":' } }];
    await chat(config, [
      { role: 'assistant', content: '', tool_calls: calls },
      { role: 'tool', content: 'Invalid JSON; no action was performed.', tool_call_id: 'broken' },
    ], new AbortController().signal);
    expect(JSON.parse(fetcher.mock.calls[0][1].body).messages[0].tool_calls).toEqual(calls);
  });

  it('uses the configured compatible endpoint, forced tool and output limit through LangChain', async () => {
    const fetcher = vi.fn(async (_url, _init) => modelResponse({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }));
    vi.stubGlobal('fetch', fetcher);
    const tools = [{ type: 'function' as const, function: { name: 'check', description: 'Check', parameters: { type: 'object' } } }];
    const reply = await chat(config, [{ role: 'user', content: 'Check' }], new AbortController().signal, tools, 'check', 1234);
    expect(String(fetcher.mock.calls[0][0])).toBe('https://model.example/v1/chat/completions');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ model: config.model, max_tokens: 1234,
      tool_choice: { type: 'function', function: { name: 'check' } }, messages: [{ role: 'user', content: 'Check' }] });
    expect(reply.usage).toEqual({ prompt: 12, completion: 3 });
  });

  it('redacts the native model message retained by createAgent for checkpoint writes', async () => {
    const native = new AIMessage({ content: 'echo secret-key', additional_kwargs: {
      tool_calls: [{ id: 'call', type: 'function', function: { name: 'browser', arguments: '{"value":"secret-key"}' } }],
    } });
    const reply = await chat(config, [], new AbortController().signal, undefined, undefined, undefined, async () => native);
    expect(JSON.stringify(native)).not.toContain(config.apiKey);
    expect(JSON.stringify(reply)).not.toContain(config.apiKey);
  });

  it.each(['length', 'content_filter'])('rejects %s responses without returning or retrying partial tool calls', async finish_reason => {
    const fetcher = vi.fn().mockResolvedValue(modelResponse({ choices: [{ finish_reason, message: { content: 'partial', tool_calls: [{ id: 'partial', type: 'function', function: { name: 'browser', arguments: '{"action":' } }] } }] }));
    vi.stubGlobal('fetch', fetcher);
    await expect(chat(config, [], new AbortController().signal)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not retry authentication errors or include response bodies in errors', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('secret-key', { status: 401 })); vi.stubGlobal('fetch', fetcher);
    await expect(chat(config, [], new AbortController().signal)).rejects.toThrow('鉴权失败'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('retries rate limits twice then succeeds, redacting echoed credentials', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 429 })).mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValue(modelResponse({ choices: [{ message: { content: 'echo secret-key' } }] }));
    vi.stubGlobal('fetch', fetcher);
    const result = await chat(config, [], new AbortController().signal); expect(fetcher).toHaveBeenCalledTimes(3); expect(result.content).not.toContain(config.apiKey);
  });
  it('cancels immediately without issuing a request', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); const controller = new AbortController(); controller.abort();
    await expect(chat(config, [], controller.signal)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('fails the connection test if tool calling is not supported', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(modelResponse({ choices: [{ message: { content: 'hello' } }] })));
    await expect(testConnection(config, new AbortController().signal)).rejects.toThrow('工具调用测试');
  });
  it('stops after two retries when every request times out', async () => {
    const fetcher = vi.fn().mockRejectedValue(new DOMException('Timed out', 'TimeoutError'));
    vi.stubGlobal('fetch', fetcher);
    await expect(chat(config, [], new AbortController().signal)).rejects.toThrow('超时');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
