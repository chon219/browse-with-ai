import { LocalizedError } from '../i18n';
import { documentKind, isImage, mediaType, textContent, textSlice, WORKSPACE_LIMITS, workspacePath, type WorkspaceAction, type WorkspaceFile, type WorkspaceResult } from '../shared/workspace';
import type { Command } from '../shared/types';

const changes = new EventTarget();
function notifyFiles(taskId: string) {
  changes.dispatchEvent(new CustomEvent('change', { detail: taskId }));
  if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
    void chrome.runtime.sendMessage({ type: 'workspaceUpdated', taskId, requestId: crypto.randomUUID() } satisfies Command).catch(() => {});
  }
}
/** File mutations notify the originating page and other extension contexts. */
export function onWorkspaceChange(taskId: string, listener: () => void) {
  const local = (event: Event) => { if ((event as CustomEvent<string>).detail === taskId) listener(); };
  const remote = (message: Command) => { if (message.type === 'workspaceUpdated' && message.taskId === taskId) listener(); };
  changes.addEventListener('change', local);
  chrome.runtime.onMessage.addListener(remote);
  return () => { changes.removeEventListener('change', local); chrome.runtime.onMessage.removeListener(remote); };
}

/**
 * Each conversation's files live in the extension's origin private file system under
 * `tasks/<task ID>/`, shared by the task page, the side panel and the service worker.
 */

async function root(): Promise<FileSystemDirectoryHandle> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) throw new LocalizedError('workspace.unavailable');
  return navigator.storage.getDirectory();
}
async function taskDirectory(taskId: string, create: boolean) {
  const tasks = await (await root()).getDirectoryHandle('tasks', { create });
  return tasks.getDirectoryHandle(encodeURIComponent(taskId), { create });
}
const isError = (error: unknown, name: string) => error instanceof DOMException && error.name === name;
function parts(path: string) {
  const result = workspacePath(path); if (!result) throw new LocalizedError('workspace.invalidPath', { path });
  return result;
}
/** The directory holding `path` and the file name, or undefined when a directory on the way is missing. */
async function locate(taskId: string, path: string, create: boolean) {
  const names = parts(path);
  try {
    let directory = await taskDirectory(taskId, create);
    for (const name of names.slice(0, -1)) directory = await directory.getDirectoryHandle(name, { create });
    return { directory, name: names.at(-1)! };
  } catch (error) {
    if (isError(error, 'NotFoundError')) return undefined;
    if (isError(error, 'TypeMismatchError')) throw new LocalizedError('workspace.notAFile', { path });
    throw error;
  }
}
async function fileHandle(taskId: string, path: string, create = false) {
  const location = await locate(taskId, path, create);
  if (!location) throw new LocalizedError('workspace.notFound', { path });
  try { return await location.directory.getFileHandle(location.name, { create }); }
  catch (error) {
    if (isError(error, 'NotFoundError')) throw new LocalizedError('workspace.notFound', { path });
    if (isError(error, 'TypeMismatchError')) throw new LocalizedError('workspace.notAFile', { path });
    throw error;
  }
}

async function walk(directory: FileSystemDirectoryHandle, prefix: string, found: WorkspaceFile[]) {
  for await (const [name, handle] of directory.entries()) {
    const path = prefix + name;
    if (handle.kind === 'directory') await walk(handle as FileSystemDirectoryHandle, path + '/', found);
    else { const file = await (handle as FileSystemFileHandle).getFile(); found.push({ path, size: file.size, modifiedAt: new Date(file.lastModified).toISOString(), type: mediaType(path) }); }
  }
  return found;
}
/** Every file in a conversation's workspace, most recently changed first. */
export async function listFiles(taskId: string): Promise<WorkspaceFile[]> {
  let directory: FileSystemDirectoryHandle;
  try { directory = await taskDirectory(taskId, false); } catch (error) { if (isError(error, 'NotFoundError')) return []; throw error; }
  return (await walk(directory, '', [])).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path));
}
export async function readBytes(taskId: string, path: string): Promise<Uint8Array> {
  return new Uint8Array(await (await (await fileHandle(taskId, path)).getFile()).arrayBuffer());
}
/** Read only an archive's header for the UI, without loading its potentially large body. */
export async function readFileHeader(taskId: string, path: string): Promise<string> {
  return (await (await fileHandle(taskId, path)).getFile()).slice(0, 8192).text();
}
/** A text file's content; binary files are refused rather than decoded into noise. */
export async function readFile(taskId: string, path: string): Promise<string> {
  const text = textContent(await readBytes(taskId, path));
  if (text === undefined) throw new LocalizedError('workspace.binary', { path });
  return text;
}
/** Write text or bytes; appending is for text. */
export async function writeFile(taskId: string, path: string, content: string | Uint8Array, append = false): Promise<WorkspaceFile> {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content).length : content.byteLength;
  const files = await listFiles(taskId); const existing = files.find(file => file.path === parts(path).join('/'));
  const size = bytes + (append ? existing?.size ?? 0 : 0);
  if (size > WORKSPACE_LIMITS.fileBytes) throw new LocalizedError('workspace.fileTooLarge', { path, limit: WORKSPACE_LIMITS.fileBytes / 1_000_000 });
  if (!existing && files.length >= WORKSPACE_LIMITS.files) throw new LocalizedError('workspace.tooManyFiles', { limit: WORKSPACE_LIMITS.files });
  const total = files.reduce((sum, file) => sum + (file === existing ? 0 : file.size), 0) + size;
  if (total > WORKSPACE_LIMITS.totalBytes) throw new LocalizedError('workspace.full', { limit: WORKSPACE_LIMITS.totalBytes / 1_000_000 });
  const handle = await fileHandle(taskId, path, true);
  const writable = await handle.createWritable({ keepExistingData: append });
  try {
    if (append) await writable.seek((await handle.getFile()).size);
    await writable.write(typeof content === 'string' ? content : new Blob([content as Uint8Array<ArrayBuffer>]));
  } finally { await writable.close(); }
  const file = await handle.getFile();
  notifyFiles(taskId);
  return { path: parts(path).join('/'), size: file.size, modifiedAt: new Date(file.lastModified).toISOString(), type: mediaType(path) };
}
async function deleteFile(taskId: string, path: string) {
  const location = await locate(taskId, path, false);
  try { if (!location) throw new DOMException('', 'NotFoundError'); await location.directory.removeEntry(location.name); }
  catch (error) { if (isError(error, 'NotFoundError')) throw new LocalizedError('workspace.notFound', { path }); throw error; }
  notifyFiles(taskId);
}
/** Serialize changes to a conversation's workspace across the extension's pages and its service worker. */
export function withWorkspaceLock<T>(taskId: string, run: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  return locks ? locks.request(`bwai-workspace:${taskId}`, run) as Promise<T> : run();
}
/** Remove a conversation's whole workspace. Contexts without a file system have nothing to remove. */
export async function deleteWorkspace(taskId: string) {
  try { await (await (await root()).getDirectoryHandle('tasks')).removeEntry(encodeURIComponent(taskId), { recursive: true }); }
  catch (error) { if (!(error instanceof LocalizedError) && !isError(error, 'NotFoundError')) throw error; }
}

/** Remove every conversation's workspace. */
export async function deleteAllWorkspaces() {
  try { await (await root()).removeEntry('tasks', { recursive: true }); }
  catch (error) { if (!(error instanceof LocalizedError) && !isError(error, 'NotFoundError')) throw error; }
}

/** Run one agent workspace action. */
export async function runWorkspaceAction(taskId: string, action: WorkspaceAction): Promise<WorkspaceResult> {
  switch (action.name) {
    case 'list_files': return { files: await listFiles(taskId) };
    case 'read_file': {
      const bytes = await readBytes(taskId, action.path); const path = parts(action.path).join('/');
      // Documents are binary even when their bytes happen to decode, as a PDF of plain ASCII does.
      const type = mediaType(path); const text = documentKind(type) ? undefined : textContent(bytes);
      if (text === undefined) return { file: { path, binary: true, type, size: bytes.byteLength } };
      return { file: textSlice(path, text, action.offset) };
    }
    case 'view_image': {
      const path = parts(action.path).join('/'); const type = mediaType(path);
      if (!isImage(type)) throw new LocalizedError('workspace.notImage', { path });
      return { image: { path, type, size: (await readBytes(taskId, path)).byteLength } };
    }
    case 'write_file': case 'append_file': return { written: await writeFile(taskId, action.path, action.content, action.name === 'append_file') };
    case 'delete_file': await deleteFile(taskId, action.path); return { deleted: parts(action.path).join('/') };
  }
}
