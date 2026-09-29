import { BaseCheckpointSaver, WRITES_IDX_MAP, type Checkpoint, type CheckpointMetadata, type CheckpointTuple, type CheckpointListOptions, type CheckpointPendingWrite, type PendingWrite } from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';
import { database, keyPrefix } from '../storage/db';
import { STORAGE } from '../shared/tuning';
import { LocalizedError } from '../i18n';
type Serialized = [string, Uint8Array];
interface RecordRow { thread: string; ns: string; id: string; parent?: string; checkpoint: Serialized; metadata: Serialized }
interface WriteRow { thread: string; ns: string; checkpoint: string; task: string; index: number; channel: string; value: Serialized }
const fields = (config: RunnableConfig) => ({ thread: String(config.configurable?.thread_id ?? ''), ns: String(config.configurable?.checkpoint_ns ?? ''), id: config.configurable?.checkpoint_id as string | undefined });
const configFor = (thread: string, ns: string, id: string): RunnableConfig => ({ configurable: { thread_id: thread, checkpoint_ns: ns, checkpoint_id: id } });
const keyFor = (thread: string, ns: string, id: string) => JSON.stringify([thread, ns, id]);

/** Only the latest checkpoints are needed to resume; older ones and their writes are pruned. */

export class IndexedDBSaver extends BaseCheckpointSaver {
  constructor(private readonly ownerTaskId?: string) { super(); }
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { thread, ns, id } = fields(config); const db = await database();
    const row: RecordRow | undefined = id ? await db.get('checkpoints', keyFor(thread, ns, id))
      : (await db.transaction('checkpoints').store.openCursor(keyPrefix(thread, ns), 'prev'))?.value;
    if (!row) return undefined;
    const writes = (await db.getAll('writes', keyPrefix(thread, ns, row.id)) as WriteRow[]).sort((a, b) => a.task.localeCompare(b.task) || a.index - b.index);
    const checkpoint = await this.serde.loadsTyped(...row.checkpoint) as Checkpoint;
    const pendingWrites = await Promise.all(writes.map(async write => [write.task, write.channel, await this.serde.loadsTyped(...write.value)] as CheckpointPendingWrite));
    return { config: configFor(thread, ns, row.id), checkpoint, pendingWrites,
      metadata: await this.serde.loadsTyped(...row.metadata) as CheckpointMetadata,
      parentConfig: row.parent ? configFor(thread, ns, row.parent) : undefined };
  }
  async *list(config: RunnableConfig, options: CheckpointListOptions = {}): AsyncGenerator<CheckpointTuple> {
    const f = fields(config); let remaining = options.limit ?? Infinity;
    const db = await database();
    const scoped = f.thread ? await db.getAll('checkpoints', config.configurable?.checkpoint_ns === undefined ? keyPrefix(f.thread) : keyPrefix(f.thread, f.ns)) : await db.getAll('checkpoints');
    const rows = (scoped as RecordRow[]).filter(r => !f.id || r.id === f.id).sort((a, b) => b.id.localeCompare(a.id));
    for (const row of rows) {
      if (remaining <= 0) break;
      if (options.before?.configurable?.checkpoint_id && row.id >= options.before.configurable.checkpoint_id) continue;
      const tuple = (await this.getTuple(configFor(row.thread, row.ns, row.id)))!;
      if (options.filter && !Object.entries(options.filter).every(([k, v]) => (tuple.metadata as unknown as Record<string, unknown>)?.[k] === v)) continue;
      remaining--; yield tuple;
    }
  }
  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    const { thread, ns, id } = fields(config); if (!thread) throw new LocalizedError('checkpoint.missingThread');
    const row: RecordRow = { thread, ns, id: checkpoint.id, parent: id, checkpoint: await this.serde.dumpsTyped(checkpoint), metadata: await this.serde.dumpsTyped(metadata) };
    const tx = (await database()).transaction(['tasks', 'checkpoints', 'writes'], 'readwrite');
    if (!this.ownerTaskId || await tx.objectStore('tasks').get(this.ownerTaskId)) {
      const checkpoints = tx.objectStore('checkpoints');
      await checkpoints.put(row, keyFor(thread, ns, checkpoint.id));
      let cursor = await checkpoints.openCursor(keyPrefix(thread, ns), 'prev');
      for (let kept = 0; cursor; cursor = await cursor.continue()) {
        if (++kept <= STORAGE.checkpoints) continue;
        await tx.objectStore('writes').delete(keyPrefix(thread, ns, (cursor.value as RecordRow).id));
        await cursor.delete();
      }
    }
    await tx.done;
    return configFor(thread, ns, checkpoint.id);
  }
  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const { thread, ns, id } = fields(config); if (!thread || !id) throw new LocalizedError('checkpoint.missingWriteIds');
    const rows = await Promise.all(writes.map(async ([channel, value], i): Promise<WriteRow> => ({ thread, ns, checkpoint: id, task: taskId, index: WRITES_IDX_MAP[channel] ?? i, channel, value: await this.serde.dumpsTyped(value) })));
    const tx = (await database()).transaction(['tasks', 'writes'], 'readwrite');
    if (this.ownerTaskId && !await tx.objectStore('tasks').get(this.ownerTaskId)) { await tx.done; return; }
    const store = tx.objectStore('writes');
    for (const row of rows) {
      const key = JSON.stringify([thread, ns, id, taskId, row.index]);
      if (row.index >= 0 && await store.get(key)) continue;
      await store.put(row, key);
    }
    await tx.done;
  }
  async deleteThread(threadId: string) {
    const tx = (await database()).transaction(['checkpoints', 'writes'], 'readwrite');
    await Promise.all([tx.objectStore('checkpoints').delete(keyPrefix(threadId)), tx.objectStore('writes').delete(keyPrefix(threadId)), tx.done]);
  }
}
