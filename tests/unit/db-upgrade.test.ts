import { describe, expect, it, vi } from 'vitest';
import { fakeFileSystem } from '../fixtures/fake-file-system';

/** Open the database as the previous schema did and store a conversation in it. */
async function createPreviousSchema(taskId: string) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('bwai', 5);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('tasks', { keyPath: 'id' });
      db.createObjectStore('operations', { keyPath: 'id' }).createIndex('taskId', 'taskId');
      db.createObjectStore('checkpoints'); db.createObjectStore('writes');
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['tasks', 'operations', 'checkpoints', 'writes'], 'readwrite');
    tx.objectStore('tasks').put({ id: taskId, goal: '旧对话', status: 'completed', report: '旧格式结果' });
    tx.objectStore('operations').put({ id: 'op', taskId });
    tx.objectStore('checkpoints').put('old', JSON.stringify([taskId, '', 'c1']));
    tx.objectStore('writes').put('old', JSON.stringify([taskId, '', 'c1', 'w', 0]));
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
  db.close();
}

describe('database upgrades', () => {
  it('deletes everything stored by the previous schema, including workspace files, and keeps working', async () => {
    const taskId = crypto.randomUUID(); await createPreviousSchema(taskId);
    fakeFileSystem(vi.stubGlobal);
    const { runWorkspaceAction, listFiles } = await import('../../src/storage/workspace');
    await runWorkspaceAction(taskId, { name: 'write_file', path: 'notes.md', content: '旧文件' });

    const { allTasks, database, operations, saveTask } = await import('../../src/storage/db');
    const db = await database();
    expect(db.version).toBe(6);
    expect(await allTasks()).toEqual([]); expect(await operations(taskId)).toEqual([]);
    expect(await db.count('checkpoints')).toBe(0); expect(await db.count('writes')).toBe(0);
    expect(await listFiles(taskId)).toEqual([]);

    const at = new Date().toISOString();
    await saveTask({ id: 'new', goal: '新对话', status: 'ready', createdAt: at, updatedAt: at, resultText: '', elapsedMs: 0 });
    expect((await allTasks()).map(task => task.goal)).toEqual(['新对话']);
  });
  it('keeps deleting the previous schema workspace files on later opens until it succeeds', async () => {
    const previous = await import('../../src/storage/db'); (await previous.database()).close();
    await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase('bwai'); request.onsuccess = resolve; request.onerror = reject; });
    const taskId = crypto.randomUUID(); await createPreviousSchema(taskId);
    const root = fakeFileSystem(vi.stubGlobal);
    const { runWorkspaceAction, listFiles } = await import('../../src/storage/workspace');
    await runWorkspaceAction(taskId, { name: 'write_file', path: 'notes.md', content: '旧文件' });
    const remove = vi.spyOn(root, 'removeEntry').mockRejectedValueOnce(new DOMException('busy', 'InvalidStateError'));

    vi.resetModules();
    const first = await import('../../src/storage/db');
    await expect(first.database()).rejects.toThrow('busy');
    expect(remove).toHaveBeenCalledTimes(1); expect(await listFiles(taskId)).toHaveLength(1);

    vi.resetModules();
    await (await import('../../src/storage/db')).database();
    expect(await listFiles(taskId)).toEqual([]);
    // Once done, a later open leaves new files alone.
    await runWorkspaceAction(taskId, { name: 'write_file', path: 'new.md', content: '新文件' });
    vi.resetModules();
    await (await import('../../src/storage/db')).database();
    expect(await listFiles(taskId)).toHaveLength(1);
  });
  it('opens again after a failed open', async () => {
    vi.resetModules();
    const { database } = await import('../../src/storage/db');
    const open = indexedDB.open.bind(indexedDB);
    const spy = vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => { throw new Error('blocked'); });
    await expect(database()).rejects.toThrow('blocked');
    spy.mockImplementation(open);
    expect((await database()).version).toBe(6);
  });
});
