import { describe, expect, it, vi } from 'vitest';
import { createAgentContext } from '../../src/agent/context';
import type { AgentStore } from '../../src/agent/ports';
import type { State } from '../../src/agent/state';
import type { Task } from '../../src/shared/types';
import { CONTEXT } from '../../src/shared/tuning';
import { ModelError } from '../../src/agent/model';

describe('working notes in model context', () => {
  it('advertises only selected skill metadata until loaded and retains its body independently of history', async () => {
    const skill = { id: 'skill', name: 'Compare prices', description: 'Use for product comparisons', instructions: 'Find the exact variant and verify the price.', version: 2, createdAt: '', updatedAt: '', sourceTaskId: 'source', sourceTurn: 0 };
    const task = { id: 'skill-context', goal: 'Compare', skill } as Task;
    const model = vi.fn(async () => ({ content: 'ok' }));
    const context = createAgentContext({ task, store: { recordUsage: async () => {} } as unknown as AgentStore,
      signal: new AbortController().signal, model, definitions: [], files: async () => [] });
    const state = { goal: task.goal, history: [], loadedSkill: null } as unknown as State;
    await context.request('decide', state, task);
    const calls = model.mock.calls as unknown as [Array<{ content: string }>][];
    expect(JSON.parse(calls[0][0][1].content).availableSkills).toEqual([{ name: skill.name, description: skill.description, version: 2 }]);
    expect(JSON.stringify(calls[0])).not.toContain(skill.instructions);
    state.loadedSkill = skill;
    await context.request('decide', state, task);
    expect(JSON.parse(calls[1][0][1].content).loadedSkill.instructions).toBe(skill.instructions);
  });
  it('recovers one output-limit failure internally and accounts for both attempts', async () => {
    const model = vi.fn().mockRejectedValueOnce(new ModelError('model.outputTruncated', undefined, false, { prompt: 100, completion: 30 }))
      .mockResolvedValue({ content: 'Complete answer', usage: { prompt: 110, completion: 10 } });
    const recordUsage = vi.fn(async () => {});
    const task = { id: 'retry', goal: 'Compare', turn: 0, } as Task;
    const context = createAgentContext({ task, store: { recordUsage, task: async () => task } as unknown as AgentStore,
      signal: new AbortController().signal, model, definitions: [], files: async () => [] });
    const reply = await context.request('decide', { goal: task.goal, history: [] } as unknown as State, task);
    expect(reply.content).toBe('Complete answer');
    expect(model).toHaveBeenCalledTimes(2);
    expect(model.mock.calls[1][0].at(-1).content).toContain('Return exactly one concise tool call');
    expect(recordUsage.mock.calls).toEqual([[{ prompt: 100, completion: 30 }], [{ prompt: 110, completion: 10 }]]);
  });
  it('does not loop indefinitely or retry filtered responses', async () => {
    for (const key of ['model.outputTruncated', 'model.outputFiltered'] as const) {
      const model = vi.fn().mockRejectedValue(new ModelError(key));
      const task = { id: key, goal: 'Compare', } as Task;
      const context = createAgentContext({ task, store: { recordUsage: async () => {}, task: async () => task } as unknown as AgentStore,
        signal: new AbortController().signal, model, definitions: [], files: async () => [] });
      await expect(context.request('decide', { goal: task.goal, history: [] } as unknown as State, task)).rejects.toBeInstanceOf(ModelError);
      expect(model).toHaveBeenCalledTimes(key === 'model.outputTruncated' ? 2 : 1);
    }
  });
  it('reloads notes for decisions and the final answer independently of observation eviction', async () => {
    const model = vi.fn(async () => ({ content: 'ok' }));
    const task = { id: 'notes', goal: 'Compare A and B', turn: 0, } as Task;
    const context = createAgentContext({ task, store: { recordUsage: vi.fn(async () => {}) } as unknown as AgentStore,
      signal: new AbortController().signal, model, definitions: [],
      files: async () => [] });
    const state = { goal: task.goal, history: [], rounds: 20, taskNotes: 'A: 27 hours; source: https://a.example/' } as unknown as State;
    await context.request('decide', state, task);
    state.taskNotes += '\nB: 34 hours; source: https://b.example/';
    await context.request('decide', state, task);
    const calls = model.mock.calls as unknown as [Array<{ content: string }>][];
    expect(JSON.parse(calls[0][0][1].content).taskNotes).toContain('A: 27 hours');
    expect(JSON.parse(calls[1][0][1].content).taskNotes).toContain('B: 34 hours');
    await context.request('progress', state, task);
    expect(JSON.parse(calls[2][0][1].content).taskNotes).toContain('B: 34 hours');
    state.taskNotes = 'x'.repeat(CONTEXT.notesChars + 100);
    await context.request('decide', state, task);
    const bounded = JSON.parse((model.mock.calls as unknown as [Array<{ content: string }>][])[3][0][1].content);
    expect(bounded.taskNotes).toHaveLength(CONTEXT.notesChars);
    expect(bounded.taskNotesTruncated).toBe(true);
  });
});
