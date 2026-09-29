import { Command, REMOVE_ALL_MESSAGES } from '@langchain/langgraph/web';
import { RemoveMessage } from '@langchain/core/messages';
import { modelResponse } from '../fixtures/model-response';
import { describe, expect, it, vi } from 'vitest';
import { createExtensionAgent } from '../../src/agent/extension-agent';
import type { ChatMessage } from '../../src/agent/model';
import { getOperation, saveOperation, saveTask, sendTaskMessage } from '../../src/storage/db';
import type { Task, BrowserResult } from '../../src/shared/types';
import { msg } from '../../src/i18n';

const config = { baseUrl: 'https://model.example/v1', model: 'mock', apiKey: 'key', remember: false, search: 'bing' as const };
const task = (): Task => ({ id: crypto.randomUUID(), title: 'Task', goal: 'Read the page', status: 'running', createdAt: '', updatedAt: '', elapsedMs: 0, resultText: '' });
const reply = (message: object) => modelResponse({ choices: [{ message }] });
const call = (name: string, args: unknown) => ({ content: null, tool_calls: [{ id: 'call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const finish = (outcome = 'success') => call('finish_task', { answer: 'Complete answer', outcome, verification: 'Observed result' });

describe('native agent loop', () => {
  it('restarts a superseded final answer without losing observations or repeating actions', async () => {
    const t = task(); await saveTask(t);
    let decisions = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      if (++decisions === 3) {
        const messages = JSON.parse(init.body).messages as ChatMessage[];
        expect(messages.filter(message => message.role === 'tool')).toHaveLength(1);
        expect(messages.at(-1)?.content).toBe('Include the page title in the answer.');
      }
      return modelResponse({ choices: [{ message: decisions === 1
        ? call('browser', { action: { name: 'open', url: 'https://example.com/' } }) : finish() }] });
    }));
    const browser = vi.fn(async (): Promise<BrowserResult> => ({ tabId: 7, snapshot: { url: 'https://example.com/', title: 'Page', text: 'Observed', snapshotId: 's1', elements: [] } }));
    const make = () => createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 0, browser });
    const cfg = { configurable: { thread_id: t.id }, durability: 'sync' as const };
    await make().invoke({ messages: [], goal: t.goal }, cfg);
    await sendTaskMessage(t.id, 'Include the page title in the answer.');
    const agent = make(); const snapshot = await agent.graph.getState(cfg);
    const result = await agent.invoke({ ...snapshot.values, messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES })],
      resultText: '', pending: null, observation: null, blocked: '' }, cfg);
    expect(result.resultText).toBe('Complete answer'); expect(result.rounds).toBe(3);
    expect(result.revision).toBe(1); expect(result.history).toHaveLength(1);
    expect(browser).toHaveBeenCalledTimes(1); expect(decisions).toBe(3);
  });

  it.each(['done', 'pending'] as const)('recovers a %s browser operation after losing the tool response, without repeating its effect', async phase => {
    const t = task(); await saveTask(t);
    let decisions = 0; let effects = 0;
    vi.stubGlobal('fetch', vi.fn(async () => modelResponse({ choices: [{ message: ++decisions === 1
      ? call('browser', { action: { name: 'open', url: 'https://example.com/' } })
      : finish(phase === 'done' ? 'success' : 'incomplete') }] })));
    const result: BrowserResult = { tabId: 7, snapshot: { url: 'https://example.com/', title: 'Saved', text: 'Done', snapshotId: 's1', elements: [] } };
    const browser = vi.fn(async (action, id): Promise<BrowserResult> => {
      const old = await getOperation(id);
      if (old) return old.phase === 'done' ? old.result! : { error: msg('bg.unknownResult') };
      effects++;
      await saveOperation({ id, taskId: t.id, turn: 0, action, phase, startedAt: '', ...(phase === 'done' ? { result } : {}) });
      throw new Error('The task page closed before receiving the tool result');
    });
    const make = () => createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 0, browser });
    const cfg = { configurable: { thread_id: t.id }, durability: 'sync' as const };
    await expect(make().invoke({ messages: [], goal: t.goal }, cfg)).rejects.toThrow('task page closed');
    expect(decisions).toBe(1);
    // A failed tool is replayed from its checkpoint, not resumed as a human decision.
    const completed = await make().invoke(null, cfg);
    expect(completed.outcome).toBe(phase === 'done' ? 'success' : 'incomplete');
    expect(effects).toBe(1); expect(browser).toHaveBeenCalledTimes(2);
    expect(browser.mock.calls[0][1]).toBe(browser.mock.calls[1][1]);
    expect(decisions).toBe(2); expect(completed.history).toHaveLength(1);
  });

  it('answers a conversational question in one request', async () => {
    const t = task(); await saveTask(t);
    const fetch = vi.fn(async () => reply({ content: 'A direct answer.' })); vi.stubGlobal('fetch', fetch);
    const browser = vi.fn();
    const graph = createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 0, browser });
    const result = await graph.invoke({ messages: [], goal: t.goal, history: [], rounds: 0 }, { configurable: { thread_id: t.id } });
    expect(result.resultText).toBe('A direct answer.'); expect(fetch).toHaveBeenCalledTimes(1); expect(browser).not.toHaveBeenCalled();
  });

  it.each(['approved', 'rejected'] as const)('settles a %s approval into one native call/result pair', async decision => {
    const t = task(); await saveTask(t);
    const requests: { messages: ChatMessage[] }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return reply(requests.length === 1 ? call('browser', { action: { name: 'open', url: 'https://example.com/', effect: 'write' } }) : finish(decision === 'approved' ? 'success' : 'incomplete'));
    }));
    let executed = 0;
    const browser = vi.fn(async (action, id): Promise<BrowserResult> => {
      const old = await getOperation(id);
      if (old) {
        if (old.approvalDecision === 'rejected') return { error: msg('bg.rejected') };
        executed++;
        return { tabId: 7, snapshot: { url: 'https://example.com/', title: 'Page', text: 'Saved', snapshotId: 's1', elements: [] } };
      }
      const approval = { requestId: id, description: 'Open', url: 'https://example.com/' };
      await saveOperation({ id, taskId: t.id, turn: 0, action, phase: 'done', result: { approval }, startedAt: '' });
      return { approval, blocked: msg('bg.awaitingApproval') };
    });
    const make = () => createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 0, browser });
    const cfg = { configurable: { thread_id: t.id }, durability: 'sync' as const };
    const paused = await make().invoke({ messages: [], goal: t.goal, history: [], rounds: 0 }, cfg);
    expect(paused.pending?.id).toBe('call'); expect(paused.history).toHaveLength(0); expect(requests).toHaveLength(1);
    const old = (await getOperation(paused.observation!.approval!.requestId))!;
    await saveOperation({ ...old, approvalDecision: decision });
    const completed = await make().invoke(new Command({ resume: true }), cfg);
    expect(completed.resultText).toBe('Complete answer'); expect(executed).toBe(decision === 'approved' ? 1 : 0);
    expect(requests).toHaveLength(2);
    const messages = requests[1].messages;
    expect(JSON.parse(messages[1].content as string)).not.toHaveProperty('observations');
    const results = messages.filter(message => message.role === 'tool');
    expect(results).toHaveLength(1);
    const index = messages.indexOf(results[0]);
    expect(messages[index - 1].tool_calls?.[0]).toMatchObject({ id: results[0].tool_call_id, function: { name: 'browser' } });
    expect(completed.history).toHaveLength(1);
  });

  it('discards a decision superseded by a user message before executing it', async () => {
    const t = task(); await saveTask(t); let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      if (++calls === 1) {
        await sendTaskMessage(t.id, 'Do not open anything; answer from the conversation.');
        return reply(call('browser', { action: { name: 'open', url: 'https://example.com/' } }));
      }
      const messages = JSON.parse(init.body).messages as ChatMessage[];
      expect(messages.at(-1)).toMatchObject({ role: 'user', content: 'Do not open anything; answer from the conversation.' });
      expect(messages.some(message => message.tool_calls || message.role === 'tool')).toBe(false);
      return reply({ content: 'Answered without opening a page.' });
    }));
    const browser = vi.fn();
    const graph = createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 0, browser });
    const result = await graph.invoke({ messages: [], goal: t.goal, history: [], rounds: 0 }, { configurable: { thread_id: t.id } });
    expect(result.resultText).toBe('Answered without opening a page.'); expect(browser).not.toHaveBeenCalled(); expect(calls).toBe(2);
  });
});
