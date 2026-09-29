import { describe, expect, it, vi } from 'vitest';
import { getTask, onLocalTaskChange, patchTask, recordElapsed, recordUsage, saveTask } from '../../src/storage/db';
import type { Task } from '../../src/shared/types';
import { reuseTasks } from '../../src/ui/app-state';

const makeTask = (): Task => ({ id: crypto.randomUUID(), goal: '保留的目标', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resultText: '', elapsedMs: 0 });

describe('task storage', () => {
  it('caps activity entries without dropping conversation messages', async () => {
    const task = makeTask(); await saveTask(task);
    let saved = task;
    for (let i = 0; i < 305; i++) saved = await patchTask(task.id, {}, `步骤 ${i}`);
    const activity = saved.messages!.filter(m => m.role === 'activity');
    expect(activity).toHaveLength(300); expect(activity[0].content).toBe('步骤 5'); expect(activity.at(-1)?.content).toBe('步骤 304');
    expect(saved).not.toHaveProperty('steps');
    expect(saved.messages!.filter(m => m.role === 'user').map(m => m.content)).toEqual(['保留的目标']);
    await patchTask(task.id, { status: 'error', error: 'first failure' });
    await patchTask(task.id, {}, 'resumed');
    await patchTask(task.id, { status: 'error', error: 'second failure' });
    await patchTask(task.id, { status: 'blocked', error: 'first block' });
    await patchTask(task.id, { status: 'blocked', error: 'second block' });
    const messages = (await getTask(task.id))!.messages!;
    expect(messages.filter(m => m.kind === 'error').map(m => m.content)).toEqual(['first failure', 'second failure']);
    expect(messages.filter(m => m.kind === 'message' && m.role === 'assistant').map(m => m.content)).toEqual(['first block', 'second block']);
  });
  it('keeps usage and rapid task changes visible through the UI cache', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-01T00:00:00.000Z'));
    const task = { ...makeTask(), updatedAt: '2026-01-01T00:00:00.000Z' };
    await saveTask(task);
    await recordUsage(task.id, { prompt: 100, completion: 10 });
    const used = (await getTask(task.id))!;
    expect(reuseTasks([task], [used])[0].usage?.turnTokens).toBe(110);
    const paused = await patchTask(task.id, { status: 'paused' });
    expect(paused.updatedAt > used.updatedAt).toBe(true);
    expect(reuseTasks([used], [paused])[0].status).toBe('paused');
  });
  it('records elapsed time without rebuilding messages or notifying, and only for the current turn', async () => {
    const task = makeTask(); await saveTask(task);
    const before = await getTask(task.id);
    const changes: string[] = []; const stop = onLocalTaskChange(id => changes.push(id));
    await recordElapsed(task.id, 12_000, 0);
    await recordElapsed(task.id, 99_000, 1);
    stop();
    const after = await getTask(task.id);
    expect(after?.elapsedMs).toBe(12_000); expect(after?.messages).toEqual(before?.messages); expect(after!.updatedAt > before!.updatedAt).toBe(true);
    expect(changes).toEqual([]);
    await expect(recordElapsed(crypto.randomUUID(), 1, 0)).rejects.toThrow('任务不存在');
  });
  it('notifies listeners in the same context when a task changes', async () => {
    const task = makeTask(); const changes: string[] = []; const stop = onLocalTaskChange(id => changes.push(id));
    await saveTask(task); await patchTask(task.id, { status: 'paused' }); stop();
    expect(changes).toEqual([task.id, task.id]);
  });
  it('applies a conditional patch only when the current state allows it', async () => {
    const task = makeTask(); await saveTask(task);
    await patchTask(task.id, { status: 'cancelled' });
    // The runner's late status write loses to the user's cancel.
    const kept = await patchTask(task.id, { status: 'error', error: '失败' }, undefined, 0, live => live.status === 'running');
    expect(kept.status).toBe('cancelled'); expect((await getTask(task.id))?.status).toBe('cancelled');
    expect((await patchTask(task.id, { elapsedMs: 5 }, undefined, 0, live => live.status === 'cancelled')).elapsedMs).toBe(5);
  });
  it('counts tokens only for the current turn', async () => {
    const task = { ...makeTask(), turn: 2 }; await saveTask(task);
    await recordUsage(task.id, { prompt: 100, completion: 10 }, 1);
    expect((await getTask(task.id))?.usage).toBeUndefined();
    await recordUsage(task.id, { prompt: 100, completion: 10 }, 2);
    expect((await getTask(task.id))?.usage).toMatchObject({ turn: 2, turnTokens: 110, requests: 1 });
  });
});
