import { Command } from '@langchain/langgraph/web';
import { modelResponse } from '../fixtures/model-response';
import { describe, expect, it, vi } from 'vitest';
import { createExtensionAgent } from '../../src/agent/extension-agent';
import { createAgentContext } from '../../src/agent/context';
import type { AgentStore } from '../../src/agent/ports';
import type { State } from '../../src/agent/state';
import { getTask, saveTask, sendTaskMessage } from '../../src/storage/db';
import { turnTokens } from '../../src/shared/budget';
import type { BrowserAction, Task } from '../../src/shared/types';

const config = { baseUrl: 'https://model.example/v1', model: 'mock', apiKey: 'key', remember: false, search: 'browser' as const };
const task = (): Task => ({ id: crypto.randomUUID(), title: 'Task', goal: 'Read pages', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resultText: '', elapsedMs: 9_000_000 });
const response = (message: object, tokens = 10) => modelResponse({ choices: [{ message }], usage: { prompt_tokens: tokens, completion_tokens: 10 } });
const tool = (name: string, args: unknown) => ({ content: null, tool_calls: [{ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const finish = () => tool('finish_task', { outcome: 'success', answer: 'Done',  verification: 'Observed' });
const page = async (action: BrowserAction) => ({ tabId: 7, snapshot: { url: action.name === 'open' ? action.url : 'https://example.com/', title: 'Page', text: 'Evidence', snapshotId: 's', elements: [] } });

describe('progress and optional token limits', () => {
  it('allows a pause summary to use reserved tokens after another decision would be refused', async () => {
    const t: Task = { ...task(), tokenLimit: 50_000, usage: { turn: 0, turnTokens: 44_000, promptTokens: 43_000, completionTokens: 1000, requests: 4, contextTokens: 1000 } };
    const model = vi.fn(async () => ({ content: 'Finished', usage: { prompt: 1000, completion: 100 } }));
    const context = createAgentContext({ task: t, store: { task: async () => t, recordUsage: vi.fn(async () => {}) } as unknown as AgentStore,
      signal: new AbortController().signal, model, definitions: [], files: async () => [] });
    const state = { goal: t.goal, history: [], rounds: 65, outcome: 'success', verification: 'Observed' } as unknown as State;
    await expect(context.request('decide', state, t)).rejects.toThrow('token');
    expect(model).not.toHaveBeenCalled();
    expect((await context.request('progress', state, t)).content).toBe('Finished');
    expect(model).toHaveBeenCalledTimes(1);
  });
  it('finishes after more than the old step, page, time and token budgets', async () => {
    const t = task(); await saveTask(t); let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); expect(body.max_tokens).toBeUndefined();
      if (!body.messages[0].content.includes('BWAI_DECIDE')) return response({ content: 'Done' }, 10_000);
      return response(++calls <= 65 ? tool('browser', { action: { name: 'open', url: 'https://example.com/' + calls } }) : finish(), 10_000);
    }));
    const browser = vi.fn(page);
    const graph = createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 9_000_000, browser });
    const result = await graph.invoke({ messages: [], goal: t.goal, rounds: 0, history: [] }, { configurable: { thread_id: t.id }, recursionLimit: 1000 });
    expect(result.resultText).toBe('Done'); expect(result.pause).toBeNull(); expect(browser).toHaveBeenCalledTimes(65);
    expect(turnTokens((await getTask(t.id))!)).toBeGreaterThan(500_000);
  });
  it('pauses an endless invalid-call loop and resets it on explicit resume', async () => {
    const t = task(); await saveTask(t); let recover = false;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      return response(body.messages[0].content.includes('BWAI_DECIDE') ? recover ? finish() : tool('unknown', {}) : { content: 'Done' });
    }));
    const make = () => createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 0, browser: vi.fn() });
    const cfg = { configurable: { thread_id: t.id } };
    const paused = await make().invoke({ messages: [], goal: t.goal, rounds: 0, history: [] }, cfg);
    expect(paused.pause?.kind).toBe('stalled'); expect(paused.rounds).toBe(6);
    recover = true;
    expect((await make().invoke(new Command({ resume: true }), cfg)).resultText).toBe('Done');
  });
  it('pauses repeated unchanged observations without making another model call', async () => {
    const t = task(); await saveTask(t);
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => response(JSON.parse(init.body).messages[0].content.includes('BWAI_DECIDE')
      ? tool('browser', { action: { name: 'read', tabId: 7 } }) : { content: 'Read' })));
    const browser = vi.fn(page);
    const graph = createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 0, browser });
    const result = await graph.invoke({ messages: [], goal: t.goal, rounds: 0, history: [] }, { configurable: { thread_id: t.id }, recursionLimit: 100 });
    expect(result.pause?.kind).toBe('stalled'); expect(browser).toHaveBeenCalledTimes(3);
  });
  it('reserves a summary, bounds output, and does not spend more on unchanged-cap resumes', async () => {
    const t = { ...task(), tokenLimit: 50_000 }; await saveTask(t); let calls = 0; let finished = false;
    const requests: Array<{ system: string; max: number }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); const system = body.messages[0].content;
      requests.push({ system, max: body.max_tokens });
      if (system.includes('BWAI_PROGRESS')) return response({ content: 'Collected evidence; more remains.' }, 1000);
      if (!system.includes('BWAI_DECIDE')) return response({ content: 'Done' }, 1000);
      return response(finished ? finish() : tool('browser', { action: { name: 'open', url: 'https://example.com/' + ++calls } }), 8000);
    }));
    const make = () => createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 0, browser: page });
    const cfg = { configurable: { thread_id: t.id }, recursionLimit: 100 };
    const paused = await make().invoke({ messages: [], goal: t.goal, rounds: 0, history: [] }, cfg);
    expect(paused.pause).toEqual({ kind: 'tokens', limit: 50_000 });
    expect(requests.filter(r => r.system.includes('BWAI_PROGRESS'))).toHaveLength(1);
    expect(requests.every(r => r.max > 0 && r.max <= 8000)).toBe(true);
    const count = requests.length;
    await make().invoke(new Command({ resume: true }), cfg); expect(requests).toHaveLength(count);
    t.tokenLimit = 500_000; finished = true;
    expect((await make().invoke(new Command({ resume: true }), cfg)).resultText).toBe('Done');
  });
  it('starts a new turn with a fresh optional limit and no previous pause', async () => {
    const t: Task = { ...task(), status: 'completed', tokenLimit: 50_000, pause: { kind: 'tokens', limit: 50_000 } }; await saveTask(t);
    const next = await sendTaskMessage(t.id, 'Again');
    expect(next.turn).toBe(1); expect(next.tokenLimit).toBeUndefined(); expect(next.pause).toBeUndefined(); expect(turnTokens(next)).toBe(0);
  });
});
