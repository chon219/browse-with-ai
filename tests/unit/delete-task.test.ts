import { describe, expect, it } from 'vitest';
import { database, deleteTask, getTask, operations, patchTask, saveOperation, saveTask, sendTaskMessage } from '../../src/storage/db';
import { IndexedDBSaver } from '../../src/agent/checkpointer';
import type { Task } from '../../src/shared/types';

const makeTask = (id: string = crypto.randomUUID()): Task => ({ id, goal: '待删除对话', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resultText: '', elapsedMs: 0 });
const checkpoint = { v: 4, id: '1', ts: new Date().toISOString(), channel_values: { value: 1 }, channel_versions: {}, versions_seen: {} };
const metadata = { source: 'input' as const, step: 0, parents: {} };
async function seed(task: Task, threads = [task.id]) {
  await saveTask(task);
  await saveOperation({ id: `${task.id}:op`, taskId: task.id, action: { name: 'read', tabId: 1 }, phase: 'pending', startedAt: task.createdAt });
  const saver = new IndexedDBSaver(task.id);
  for (const thread of threads) for (const ns of ['', 'child']) {
    const config = await saver.put({ configurable: { thread_id: thread, checkpoint_ns: ns } }, checkpoint, metadata);
    await saver.putWrites(config, [['value', 2]], 'node');
  }
  return saver;
}

describe('conversation deletion', () => {
  it('removes all turns and namespaces atomically without touching another conversation', async () => {
    const task = makeTask(); const other = makeTask(`${task.id}-other`);
    const threads = [task.id, `${task.id}:turn:1`, `${task.id}:turn:3`];
    const saver = await seed(task, threads); await seed(other);
    await deleteTask(task.id); await deleteTask(task.id);
    expect(await getTask(task.id)).toBeUndefined(); expect(await operations(task.id)).toEqual([]);
    for (const thread of threads) for (const ns of ['', 'child']) expect(await saver.getTuple({ configurable: { thread_id: thread, checkpoint_ns: ns } })).toBeUndefined();
    const db = await database();
    expect((await db.getAll('writes')).some(row => threads.includes(row.thread))).toBe(false);
    expect(await getTask(other.id)).toBeDefined(); expect(await operations(other.id)).toHaveLength(1);
    expect((await saver.getTuple({ configurable: { thread_id: other.id } }))?.pendingWrites).toHaveLength(1);
  });
  it('rejects stale edits and prevents late operations and checkpoint writes from recreating deleted data', async () => {
    const task = makeTask(); const saver = await seed(task);
    const config = { configurable: { thread_id: task.id, checkpoint_id: checkpoint.id } };
    await Promise.all([deleteTask(task.id), saver.put(config, checkpoint, metadata), saver.putWrites(config, [['value', 3]], 'late')]);
    await saveOperation({ id: 'late-op', taskId: task.id, action: { name: 'read', tabId: 1 }, phase: 'done', startedAt: task.createdAt });
    await saver.put(config, checkpoint, metadata); await saver.putWrites(config, [['value', 4]], 'later');
    await expect(patchTask(task.id, { status: 'running' })).rejects.toThrow('不存在');
    await expect(sendTaskMessage(task.id, '继续')).rejects.toThrow('不存在');
    expect(await getTask(task.id)).toBeUndefined(); expect(await operations(task.id)).toEqual([]);
    expect(await saver.getTuple(config)).toBeUndefined();
    expect((await (await database()).getAll('writes')).some(row => row.thread === task.id)).toBe(false);
  });
});
