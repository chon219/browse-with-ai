import { FakeChatModel } from '@langchain/core/utils/testing';
import { Command } from '@langchain/langgraph/web';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { describe, expect, it, vi } from 'vitest';
import { createTaskAgent } from '../../src/agent/agent';
import type { AgentContext, AgentStore } from '../../src/agent/ports';
import type { ModelReply } from '../../src/agent/model';
import { toolRegistry, type ToolHandler } from '../../src/agent/tools';
import type { Operation, Task } from '../../src/shared/types';

const decision = (name: string, args: unknown): ModelReply => ({ content: null, tool_calls: [{
  id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) },
}] });
const finished = () => decision('finish_task', { outcome: 'success', answer: 'Answer: 42',  verification: 'Observed the result' });

/** A different host: no extension APIs, network, IndexedDB or workspace file system. */
function host(decide: AgentContext['request'], execute: ToolHandler['execute'] = async () => ({ note: '42' })) {
  vi.stubGlobal('chrome', undefined);
  vi.stubGlobal('indexedDB', undefined);
  vi.stubGlobal('navigator', undefined);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('The core must not use HTTP directly'); }));
  let task: Task = { id: crypto.randomUUID(), title: 'Test', goal: 'Compute', status: 'running',
    createdAt: '2026-01-01', updatedAt: '2026-01-01',
    messages: [], resultText: '', elapsedMs: 0 };
  const operations = new Map<string, Operation>();
  const store: AgentStore = {
    task: async () => task,
    update: async patch => { task = { ...task, ...patch }; },
    append: async message => { task = { ...task, messages: [...task.messages!, { ...message, at: '2026-01-01' }] }; },
    operation: async id => operations.get(id),
    saveOperation: async operation => { operations.set(operation.id, operation); },
    recordUsage: async () => {},
  };
  const controller = new AbortController();
  const context: AgentContext = { name: async () => {}, request: vi.fn(async (phase, state, live) => {
    return decide(phase, state, live);
  }) };
  const tool = { definition: { type: 'function' as const, function: { name: 'calculator', description: 'Calculate', parameters: { type: 'object' } } }, execute: vi.fn(execute) };
  const tools = toolRegistry([tool], async () => { throw new Error('No confirmation expected'); });
  const checkpointer = new MemorySaver();
  const graph = () => createTaskAgent({ model: new FakeChatModel({}), task, signal: controller.signal, elapsed: () => 1, store, context, tools, checkpointer });
  return { graph, store, tool, tools, context, controller, config: { configurable: { thread_id: task.id } }, input: { messages: [], goal: task.goal, history: [], rounds: 0 } };
}

describe('agent core with an independent host', () => {
  it('loads only the selected pinned skill and retains it through checkpoint recovery', async () => {
    let calls = 0;
    const skill = { id: 'skill', name: 'Check prices', description: 'Price comparison', instructions: 'Verify the variant and final price.', version: 1, createdAt: '', updatedAt: '', sourceTaskId: 'source', sourceTurn: 0 };
    const h = host(async (_phase, state) => {
      if (++calls === 1) { expect(state.loadedSkill).toBeNull(); return decision('load_skill', {}); }
      expect(state.loadedSkill).toEqual(skill);
      return calls === 2 ? decision('ask_user', { question: 'Which variant?' }) : finished();
    });
    await h.store.update({ skill });
    await h.graph().invoke(h.input, h.config);
    await h.store.update({ instructions: [{ at: '', text: '256GB' }] });
    expect((await h.graph().invoke(new Command({ resume: true }), h.config)).loadedSkill).toEqual(skill);
    expect(h.tool.execute).not.toHaveBeenCalled();
  });

  it('rejects skill loading without a selection and invalid load arguments', async () => {
    let calls = 0;
    const h = host(async (_phase, state) => {
      if (++calls === 1) return decision('load_skill', { id: 'unselected' });
      if (calls === 2) { expect(JSON.stringify(state.history)).toContain('empty object'); return decision('load_skill', {}); }
      expect(JSON.stringify(state.history)).toContain('No skill was selected');
      expect(state.loadedSkill).toBeNull();
      return finished();
    });
    await h.graph().invoke(h.input, h.config);
  });
  it('persists notes through checkpoint recovery and hydrates a follow-up turn', async () => {
    const notes = 'Verified: 42 from https://example.com/. Failed: none. Remaining: confirm units.';
    let calls = 0;
    const h = host(async (_phase, state) => {
      calls++;
      if (calls === 1) return decision('update_task_notes', { notes });
      expect(state.taskNotes).toBe(notes);
      if (calls === 2) return decision('ask_user', { question: 'Which units?' });
      return finished();
    });
    const first = h.graph();
    await first.invoke(h.input, h.config);
    expect((await first.graph.getState(h.config)).values.taskNotes).toBe(notes);
    expect((await h.store.task())!.taskNotes).toBe(notes);
    await h.store.update({ instructions: [{ at: '2026-01-01', text: 'Hours' }] });
    const result = await h.graph().invoke(new Command({ resume: true }), h.config);
    expect(result.taskNotes).toBe(notes);
    expect(JSON.stringify(result.history)).not.toContain(notes);
    expect(result.history.some(entry => entry.kind === 'observation' && entry.action.tool === 'update_task_notes')).toBe(true);
    await h.store.update({ turn: 1, instructions: [] });
    const followup = await h.graph().invoke({ ...h.input, goal: 'Compare again' }, { configurable: { thread_id: `${h.config.configurable.thread_id}:turn:1` } });
    expect(followup.taskNotes).toBe(notes);
    expect(calls).toBe(4);
    expect(h.tool.execute).not.toHaveBeenCalled();
  });

  it.each([{}, { notes: ' ' }, { notes: 'x'.repeat(12001) }])('rejects invalid notes without replacing saved progress: %j', async args => {
    let calls = 0;
    const h = host(async (_phase, state) => {
      if (++calls === 1) return decision('update_task_notes', args);
      expect(state.taskNotes).toBe('Keep existing evidence');
      expect(JSON.stringify(state.history)).toContain('update_task_notes requires');
      return finished();
    });
    await h.store.update({ taskNotes: 'Keep existing evidence' });
    await h.graph().invoke(h.input, h.config);
    expect((await h.store.task())!.taskNotes).toBe('Keep existing evidence');
  });

  it('pauses instead of allowing an endless loop of unchanged notes', async () => {
    const h = host(async () => decision('update_task_notes', { notes: 'No new information' }));
    const result = await h.graph().invoke(h.input, h.config);
    expect(result.taskNotes).toBe('No new information');
    expect(result.pause?.kind).toBe('stalled');
  });

  it('executes a newly registered capability without browser or storage adapters', async () => {
    let calls = 0;
    const h = host(async () => ++calls === 1 ? decision('calculator', { expression: '6 * 7' }) : finished());
    const result = await h.graph().invoke(h.input, h.config);
    expect(result.resultText).toBe('Answer: 42');
    expect(result.outcome).toBe('success');
    expect(h.tool.execute).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.tool.execute.mock.calls[0][0].function.arguments)).toEqual({ expression: '6 * 7' });
    expect(result.history.some(entry => JSON.stringify(entry).includes('42'))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resumes a user question through a newly constructed graph and the same checkpoint', async () => {
    let calls = 0;
    const h = host(async () => ++calls === 1 ? decision('ask_user', { question: 'Which value?' }) : finished());
    const first = h.graph();
    await first.invoke(h.input, h.config);
    expect((await first.graph.getState(h.config)).tasks.some(task => task.interrupts?.length)).toBe(true);
    expect(calls).toBe(1);
    await h.store.update({ instructions: [{ at: '2026-01-01', text: 'Use 42' }] });
    const resumed = h.graph();
    const result = await resumed.invoke(new Command({ resume: true }), h.config);
    expect(result.resultText).toBe('Answer: 42');
    expect((await resumed.graph.getState(h.config)).next).toEqual([]);
    expect(vi.mocked(h.context.request).mock.calls.filter(([phase]) => phase === 'decide')).toHaveLength(2);
  });

  it('discards a pending decision when a new instruction arrives and decides again', async () => {
    let calls = 0;
    const h = host(async () => {
      if (++calls > 1) return finished();
      await h.store.update({ instructions: [{ at: '2026-01-01', text: 'Stop computing and summarize' }] });
      return decision('calculator', { expression: '6 * 7' });
    });
    const result = await h.graph().invoke(h.input, h.config);
    expect(result.outcome).toBe('success');
    expect(h.tool.execute).not.toHaveBeenCalled();
    expect(vi.mocked(h.context.request).mock.calls.filter(([phase]) => phase === 'decide')).toHaveLength(2);
  });

  it('stops after cancellation during a tool call without making another decision', async () => {
    const h = host(async () => decision('calculator', {}), async () => {
      h.controller.abort(new Error('Stopped by the host'));
      return { note: 'The already dispatched operation returned' };
    });
    await expect(h.graph().invoke(h.input, h.config)).rejects.toThrow('Stopped by the host');
    expect(h.tool.execute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.context.request).mock.calls.filter(([phase]) => phase === 'decide')).toHaveLength(1);
  });

  it('passes the withdrawn decision to the executor when instructions supersede a confirmation', async () => {
    let calls = 0;
    const approval = { requestId: 'pending', description: 'Open the page', url: 'https://example.com/' };
    const h = host(async () => ++calls === 1 ? decision('calculator', {}) : finished(), async () => {
      const task = (await h.store.task())!;
      await h.store.saveOperation({ id: approval.requestId, taskId: task.id, phase: 'done', startedAt: '2026-01-01',
        action: { name: 'open', url: approval.url }, result: { blocked: 'Confirm', approval } });
      return { blocked: 'Confirm', approval };
    });
    const first = h.graph();
    await first.invoke(h.input, h.config);
    expect((await first.graph.getState(h.config)).tasks.some(task => task.interrupts?.length)).toBe(true);
    await h.store.update({ instructions: [{ at: '2026-01-01', text: 'Do something else' }] });
    h.tools.resume = vi.fn(async operation => {
      expect(operation.approvalDecision).toBe('rejected');
      expect(operation.supersededBy).toBe('new-message');
      return { error: 'Withdrawn' };
    });
    const result = await h.graph().invoke(new Command({ resume: true }), h.config);
    expect(h.tools.resume).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('success');
  });
});
