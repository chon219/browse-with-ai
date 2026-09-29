import { describe, expect, it, vi } from 'vitest';
import { deleteWorkspace, listFiles, onWorkspaceChange, readBytes, readFile, runWorkspaceAction } from '../../src/storage/workspace';
import { attachFiles, deleteTask, getTask, saveTask, sendTaskMessage, workspaceAction, workspaceWriteBytes } from '../../src/storage/db';
import { conversationContext } from '../../src/agent/prompts';
import { conversationMarkdown } from '../../src/shared/conversation';
import { ATTACHMENT_LIMITS, textContent, uploadPath, WORKSPACE_LIMITS, workspaceActionSchema, workspacePath } from '../../src/shared/workspace';
import { LocalizedError } from '../../src/i18n';
import { fakeFileSystem } from '../fixtures/fake-file-system';
import type { Command, Task } from '../../src/shared/types';

const task = (): Task => ({ id: crypto.randomUUID(), goal: '整理价格', status: 'ready', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resultText: '', elapsedMs: 0 });
const bytes = (text: string) => new TextEncoder().encode(text);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const errorKey = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error instanceof LocalizedError ? error.text.key : error);

it('refreshes workspace subscribers for file mutations, not task updates or reads', async () => {
  fakeFileSystem(vi.stubGlobal);
  const remote = new Set<(message: Command) => void>();
  const sendMessage = vi.fn(async () => {});
  vi.stubGlobal('chrome', { runtime: { id: 'test', sendMessage, onMessage: {
    addListener: (listener: (message: Command) => void) => remote.add(listener),
    removeListener: (listener: (message: Command) => void) => remote.delete(listener),
  } } });
  const changed = vi.fn(); const stop = onWorkspaceChange('files', changed);
  await runWorkspaceAction('files', { name: 'write_file', path: 'a.txt', content: 'a' });
  await runWorkspaceAction('files', { name: 'read_file', path: 'a.txt' });
  await runWorkspaceAction('other', { name: 'write_file', path: 'a.txt', content: 'a' });
  expect(changed).toHaveBeenCalledTimes(1);
  for (const listener of remote) listener({ type: 'taskUpdated', taskId: 'files', requestId: '1' });
  expect(changed).toHaveBeenCalledTimes(1);
  for (const listener of remote) listener({ type: 'workspaceUpdated', taskId: 'files', requestId: '2' });
  await runWorkspaceAction('files', { name: 'delete_file', path: 'a.txt' });
  expect(changed).toHaveBeenCalledTimes(3);
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'workspaceUpdated', taskId: 'files' }));
  stop(); expect(remote.size).toBe(0);
  await runWorkspaceAction('files', { name: 'write_file', path: 'b.txt', content: 'b' });
  expect(changed).toHaveBeenCalledTimes(3);
});

describe('workspace paths', () => {
  it('accepts relative paths and rejects ones that leave the workspace', () => {
    expect(workspacePath('notes.md')).toEqual(['notes.md']);
    expect(workspacePath('./data/prices.csv')).toEqual(['data', 'prices.csv']);
    expect(workspacePath('data\\prices.csv')).toEqual(['data', 'prices.csv']);
    for (const path of ['../secret', 'a/../../b', '/etc/passwd', 'a//b', 'a/', ' notes.md', 'con.', 'a/b/c/d/e/f', 'what?.md', 'x'.repeat(201)]) expect(workspacePath(path), path).toBeUndefined();
  });
  it('validates tool arguments', () => {
    expect(workspaceActionSchema.safeParse({ name: 'write_file', path: 'a.md', content: 'x' }).success).toBe(true);
    expect(workspaceActionSchema.safeParse({ name: 'write_file', path: 'a.md' }).success).toBe(false);
    expect(workspaceActionSchema.safeParse({ name: 'read_file', path: 'a.md', offset: -1 }).success).toBe(false);
  });
});

describe('workspace files', () => {
  it('writes, appends, lists, reads and deletes files per conversation', async () => {
    fakeFileSystem(vi.stubGlobal); const id = crypto.randomUUID(); const other = crypto.randomUUID();
    await runWorkspaceAction(id, { name: 'write_file', path: 'data/prices.csv', content: '商品,价格\n' });
    const appended = await runWorkspaceAction(id, { name: 'append_file', path: 'data/prices.csv', content: 'A,10\n' });
    expect(appended.written).toMatchObject({ path: 'data/prices.csv', size: new TextEncoder().encode('商品,价格\nA,10\n').length });
    await runWorkspaceAction(id, { name: 'write_file', path: 'notes.md', content: '# 进度' });
    await runWorkspaceAction(other, { name: 'write_file', path: 'notes.md', content: '另一个对话' });
    expect((await listFiles(id)).map(file => file.path)).toEqual(['notes.md', 'data/prices.csv']);
    expect(await readFile(id, 'data/prices.csv')).toBe('商品,价格\nA,10\n');
    expect(await readFile(other, 'notes.md')).toBe('另一个对话');
    expect(await runWorkspaceAction(id, { name: 'delete_file', path: 'notes.md' })).toEqual({ deleted: 'notes.md' });
    expect((await listFiles(id)).map(file => file.path)).toEqual(['data/prices.csv']);
    expect(await errorKey(readFile(id, 'notes.md'))).toBe('workspace.notFound');
    expect(await errorKey(runWorkspaceAction(id, { name: 'read_file', path: 'data' }))).toBe('workspace.notAFile');
    expect(await errorKey(runWorkspaceAction(id, { name: 'write_file', path: '../escape.md', content: 'x' }))).toBe('workspace.invalidPath');
    expect(await listFiles(crypto.randomUUID())).toEqual([]);
  });
  it('reads long files in parts', async () => {
    fakeFileSystem(vi.stubGlobal); const id = crypto.randomUUID(); const text = 'a'.repeat(WORKSPACE_LIMITS.readChars) + 'tail';
    await runWorkspaceAction(id, { name: 'write_file', path: 'long.txt', content: text });
    const first = await runWorkspaceAction(id, { name: 'read_file', path: 'long.txt' });
    expect(first.file).toMatchObject({ totalChars: text.length, nextOffset: WORKSPACE_LIMITS.readChars });
    const rest = await runWorkspaceAction(id, { name: 'read_file', path: 'long.txt', offset: first.file && 'nextOffset' in first.file ? first.file.nextOffset : 0 });
    expect(rest.file).toEqual({ path: 'long.txt', content: 'tail', totalChars: text.length });
  });
  it('enforces the file size limit, including appends', async () => {
    fakeFileSystem(vi.stubGlobal); const id = crypto.randomUUID(); const half = 'x'.repeat(WORKSPACE_LIMITS.fileBytes / 2 + 1);
    await runWorkspaceAction(id, { name: 'write_file', path: 'big.txt', content: half });
    expect(await errorKey(runWorkspaceAction(id, { name: 'append_file', path: 'big.txt', content: half }))).toBe('workspace.fileTooLarge');
    expect((await readFile(id, 'big.txt')).length).toBe(half.length);
  });
  it('is removed with its conversation, and is a no-op without a file system', async () => {
    await expect(deleteWorkspace(crypto.randomUUID())).resolves.toBeUndefined();
    fakeFileSystem(vi.stubGlobal); const t = task(); await saveTask(t);
    await runWorkspaceAction(t.id, { name: 'write_file', path: 'notes.md', content: 'x' });
    await deleteTask(t.id);
    expect(await getTask(t.id)).toBeUndefined(); expect(await listFiles(t.id)).toEqual([]);
  });
  it('never recreates the folder of a deleted conversation', async () => {
    const root = fakeFileSystem(vi.stubGlobal); const folder = async (id: string) => (await root.getDirectoryHandle('tasks', { create: true })).children.has(encodeURIComponent(id));
    // A write still under way when the conversation is deleted finishes first, then the folder goes.
    const racing = task(); await saveTask(racing);
    const writing = workspaceAction(racing.id, { name: 'write_file', path: 'data/late.csv', content: 'x' }).catch(error => error);
    await deleteTask(racing.id); await writing;
    expect(await folder(racing.id)).toBe(false);
    // A write that starts after the deletion is refused.
    const deleted = task(); await saveTask(deleted); await deleteTask(deleted.id);
    expect(await errorKey(workspaceAction(deleted.id, { name: 'write_file', path: 'notes.md', content: 'x' }))).toBe('db.conversationNotFound');
    expect(await folder(deleted.id)).toBe(false);
  });
});

describe('attached files', () => {
  it('names uploads safely and numbers names that are taken', () => {
    const taken = new Set(['uploads/prices.csv', 'uploads/prices (2).csv']);
    expect(uploadPath('prices.csv', taken)).toBe('uploads/prices (3).csv');
    expect(uploadPath('报价 单?.md', new Set())).toBe('uploads/报价 单_.md');
    expect(uploadPath('../../etc/passwd', new Set())).toBe('uploads/.._.._etc_passwd');
    for (const name of ['', '...', ' ', 'a'.repeat(300) + '.txt', 'notes.']) expect(workspacePath(uploadPath(name, new Set())), name).toBeDefined();
  });
  it('accepts UTF-8 text and rejects binary content', () => {
    expect(textContent(new TextEncoder().encode('商品,价格\nA,10'))).toBe('商品,价格\nA,10');
    expect(textContent(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe('a');
    expect(textContent(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeUndefined();
    expect(textContent(new Uint8Array([0x61, 0x00, 0x62]))).toBeUndefined();
  });
  it('stores attachments under uploads/ and records them on the message the model sees', async () => {
    fakeFileSystem(vi.stubGlobal); const t = { ...task(), status: 'completed' as const }; await saveTask(t);
    await runWorkspaceAction(t.id, { name: 'write_file', path: 'uploads/prices.csv', content: 'old' });
    const paths = await attachFiles(t.id, [{ name: 'prices.csv', bytes: bytes('A,10') }, { name: 'notes.md', bytes: bytes('# 备注') }]);
    expect(paths).toEqual([{ path: 'uploads/prices (2).csv', size: 4, type: 'text/csv' }, { path: 'uploads/notes.md', size: bytes('# 备注').byteLength, type: 'text/markdown' }]);
    expect(await readFile(t.id, 'uploads/prices (2).csv')).toBe('A,10');
    const next = await sendTaskMessage(t.id, '比较这两个文件', { attachments: paths });
    expect(next.messages!.at(-1)).toMatchObject({ role: 'user', content: '比较这两个文件', attachments: paths });
    expect(conversationContext(next).at(-1)).toMatchObject({ role: 'user', content: '比较这两个文件', attachments: paths });
    expect(conversationMarkdown(next)).toContain('附件: uploads/prices (2).csv, uploads/notes.md');
    await expect(attachFiles(t.id, Array.from({ length: ATTACHMENT_LIMITS.files + 1 }, (_, i) => ({ name: `${i}.txt`, bytes: bytes('x') })))).rejects.toThrow('最多附加');
    await deleteTask(t.id);
    expect(await errorKey(attachFiles(t.id, [{ name: 'late.txt', bytes: bytes('x') }]))).toBe('db.conversationNotFound');
  });
  it('keeps binary files byte for byte and describes them instead of decoding them', async () => {
    fakeFileSystem(vi.stubGlobal); const t = task(); await saveTask(t);
    const [image] = await attachFiles(t.id, [{ name: 'photo.png', bytes: PNG }]);
    expect(image).toEqual({ path: 'uploads/photo.png', size: PNG.byteLength, type: 'image/png' });
    expect(await readBytes(t.id, 'uploads/photo.png')).toEqual(PNG);
    expect(await runWorkspaceAction(t.id, { name: 'read_file', path: 'uploads/photo.png' })).toEqual({ file: { path: 'uploads/photo.png', binary: true, type: 'image/png', size: PNG.byteLength } });
    expect(await errorKey(readFile(t.id, 'uploads/photo.png'))).toBe('workspace.binary');
    expect(await runWorkspaceAction(t.id, { name: 'view_image', path: 'uploads/photo.png' })).toEqual({ image: { path: 'uploads/photo.png', type: 'image/png', size: PNG.byteLength } });
    await runWorkspaceAction(t.id, { name: 'write_file', path: 'notes.md', content: 'x' });
    expect(await errorKey(runWorkspaceAction(t.id, { name: 'view_image', path: 'notes.md' }))).toBe('workspace.notImage');
    expect(await workspaceWriteBytes(t.id, 'out/data.bin', new Uint8Array([1, 2, 3]))).toMatchObject({ path: 'out/data.bin', size: 3, type: 'application/octet-stream' });
    expect((await listFiles(t.id)).find(file => file.path === 'uploads/photo.png')).toMatchObject({ size: PNG.byteLength, type: 'image/png' });
  });
  it('allows files up to 10 MB', async () => {
    fakeFileSystem(vi.stubGlobal); const t = task(); await saveTask(t);
    expect(WORKSPACE_LIMITS.fileBytes).toBe(10_000_000);
    await expect(workspaceWriteBytes(t.id, 'big.bin', new Uint8Array(WORKSPACE_LIMITS.fileBytes))).resolves.toMatchObject({ size: WORKSPACE_LIMITS.fileBytes });
    expect(await errorKey(workspaceWriteBytes(t.id, 'bigger.bin', new Uint8Array(WORKSPACE_LIMITS.fileBytes + 1)))).toBe('workspace.fileTooLarge');
  });
});
