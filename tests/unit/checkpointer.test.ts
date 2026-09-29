import { describe, expect, it } from 'vitest';
import { Annotation, StateGraph, START, END } from '@langchain/langgraph/web';
import { IndexedDBSaver } from '../../src/agent/checkpointer';
import { database, deleteTask, keyPrefix } from '../../src/storage/db';

describe('IndexedDB checkpoint persistence', () => {
  it('reconstructs a graph and resumes a persisted interrupt without repeating completed work', async () => {
    let runs = 0;
    const State = Annotation.Root({ value: Annotation<number>() });
    const make = () => new StateGraph(State).addNode('first', s => { runs++; return { value: s.value + 1 }; })
      .addNode('human', s => ({ value: s.value + 2 }))
      .addEdge(START, 'first').addEdge('first', 'human').addEdge('human', END).compile({ checkpointer: new IndexedDBSaver(), interruptBefore: ['human'] });
    const config = { configurable: { thread_id: crypto.randomUUID() }, durability: 'sync' as const };
    const first = make(); await first.invoke({ value: 3 }, config);
    expect((await first.getState(config)).next).toContain('human');
    const second = make(); const result = await second.invoke(null, config);
    expect(result.value).toBe(6); expect(runs).toBe(1);
    const rows = []; for await (const row of new IndexedDBSaver().list(config)) rows.push(row);
    expect(rows.length).toBeGreaterThan(2);
    await new IndexedDBSaver().deleteThread(config.configurable.thread_id);
    expect(await new IndexedDBSaver().getTuple(config)).toBeUndefined();
  });
  it('isolates checkpoints by thread and namespace', async () => {
    const saver = new IndexedDBSaver(); const thread = crypto.randomUUID();
    const cp = { v: 4, id: '1', ts: new Date().toISOString(), channel_values: { n: 1 }, channel_versions: {}, versions_seen: {} };
    const cfg = await saver.put({ configurable: { thread_id: thread, checkpoint_ns: 'a' } }, cp, { source: 'input', step: 0, parents: {} });
    await saver.putWrites(cfg, [['n', 2]], 'task');
    await saver.putWrites(cfg, [['n', 99]], 'task');
    expect((await saver.getTuple(cfg))?.pendingWrites).toEqual([['task', 'n', 2]]);
    expect(await saver.getTuple({ configurable: { thread_id: thread, checkpoint_ns: 'b' } })).toBeUndefined();
    expect(await saver.getTuple({ configurable: { thread_id: thread + 'other', checkpoint_ns: 'a' } })).toBeUndefined();
  });
  const checkpoint = (id: string) => ({ v: 4, id, ts: new Date().toISOString(), channel_values: { n: Number(id) }, channel_versions: {}, versions_seen: {} });
  const meta = { source: 'loop' as const, step: 0, parents: {} };
  it('reads the latest checkpoint of a thread without mixing threads whose IDs share a prefix', async () => {
    const saver = new IndexedDBSaver(); const base = crypto.randomUUID();
    for (const [thread, id] of [[base, '1'], [base, '2'], [`${base}:turn:1`, '9'], [`${base}x`, '8']] as const) await saver.put({ configurable: { thread_id: thread, checkpoint_ns: '' } }, checkpoint(id), meta);
    expect((await saver.getTuple({ configurable: { thread_id: base, checkpoint_ns: '' } }))?.checkpoint.id).toBe('2');
    expect((await saver.getTuple({ configurable: { thread_id: `${base}:turn:1`, checkpoint_ns: '' } }))?.checkpoint.id).toBe('9');
    const listed = []; for await (const row of saver.list({ configurable: { thread_id: base } })) listed.push(row.checkpoint.id);
    expect(listed).toEqual(['2', '1']);
  });
  it('keeps only the latest checkpoints of a thread and prunes their writes', async () => {
    const saver = new IndexedDBSaver(); const thread = crypto.randomUUID();
    for (const id of ['1', '2', '3', '4', '5']) {
      const cfg = await saver.put({ configurable: { thread_id: thread, checkpoint_ns: '' } }, checkpoint(id), meta);
      await saver.putWrites(cfg, [['n', id]], 'task');
    }
    const listed = []; for await (const row of saver.list({ configurable: { thread_id: thread } })) listed.push(row.checkpoint.id);
    expect(listed).toEqual(['5', '4', '3']);
    const db = await database();
    expect(await db.getAll('writes', keyPrefix(thread))).toHaveLength(3);
  });
  it('deletes every turn of a conversation and nothing from other conversations', async () => {
    const saver = new IndexedDBSaver(); const id = crypto.randomUUID(); const other = `${id}-other`;
    for (const thread of [id, `${id}:turn:1`, `${id}:turn:12`, other]) await saver.put({ configurable: { thread_id: thread, checkpoint_ns: '' } }, checkpoint('1'), meta);
    await deleteTask(id);
    for (const thread of [id, `${id}:turn:1`, `${id}:turn:12`]) expect(await saver.getTuple({ configurable: { thread_id: thread, checkpoint_ns: '' } })).toBeUndefined();
    expect(await saver.getTuple({ configurable: { thread_id: other, checkpoint_ns: '' } })).toBeDefined();
  });
});
