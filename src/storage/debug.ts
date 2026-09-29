import { openDB, type IDBPDatabase } from 'idb';
import type { DebugSink } from '../shared/debug';

export const DEBUG_LIMITS = { entries: 500, dataChars: 64_000 } as const;
export interface DebugRecord {
  id?: number; at: string; taskId: string; turn: number; runId: string; event: string; data: unknown;
}
let connection: Promise<IDBPDatabase> | undefined;
const database = () => connection ??= openDB('bwai-debug', 1, {
  upgrade(db) { db.createObjectStore('events', { keyPath: 'id', autoIncrement: true }); },
  blocking() { void connection?.then(db => db.close()); connection = undefined; },
  terminated() { connection = undefined; },
}).catch(error => { connection = undefined; throw error; });

/** Snapshot values now, omit binary image payloads, and bound storage even for giant prompts. */
export function debugData(data: unknown, apiKey = ''): unknown {
  const seen = new WeakSet<object>();
  const encoded = JSON.stringify(data, (key, value: unknown) => {
    if (/^(apiKey|authorization)$/i.test(key)) return '[redacted]';
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'string') {
      const text = apiKey ? value.split(apiKey).join('[redacted]') : value;
      return text.replace(/data:image\/[^;\s]+;base64,[a-z\d+/=]+/gi, '[image data omitted]');
    }
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[circular or repeated reference]';
      seen.add(value);
      if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack, cause: value.cause };
      if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return { binaryBytes: value.byteLength };
    }
    return value;
  }) ?? 'null';
  return encoded.length <= DEBUG_LIMITS.dataChars ? JSON.parse(encoded)
    : { truncated: true, originalChars: encoded.length, preview: encoded.slice(0, DEBUG_LIMITS.dataChars) };
}

export async function appendDebug(record: DebugRecord, apiKey = '') {
  const snapshot = { ...record, data: debugData(record.data, apiKey) };
  const tx = (await database()).transaction('events', 'readwrite');
  await tx.store.add(snapshot);
  let excess = await tx.store.count() - DEBUG_LIMITS.entries;
  let cursor = excess > 0 ? await tx.store.openCursor() : null;
  while (cursor && excess-- > 0) { await cursor.delete(); cursor = await cursor.continue(); }
  await tx.done;
  return snapshot;
}
export async function readDebug(): Promise<DebugRecord[]> { return (await database()).getAll('events'); }
export async function clearDebug() { await (await database()).clear('events'); }

/** One run includes all model, tool, workflow and runner events; disabled means no I/O. */
export function createDebugSink(taskId: string, turn: number, enabled: boolean, apiKey = ''): DebugSink | undefined {
  if (!enabled) return undefined;
  const runId = crypto.randomUUID();
  return async (event, data) => {
    try {
      const record = await appendDebug({ at: new Date().toISOString(), taskId, turn, runId, event, data }, apiKey);
      console.debug('[BWAI debug]', record);
    } catch { /* Full/unavailable storage must not prevent execution. */ }
  };
}
