import { openDB, type IDBPDatabase } from 'idb';
import type { Task, Operation, ConversationMessage } from '../shared/types';
import { isFinished, now } from '../shared/types';
import { conversationMessages, upsertMessage } from '../shared/conversation';
import { deleteAllWorkspaces, deleteWorkspace, listFiles, runWorkspaceAction, withWorkspaceLock, writeFile } from './workspace';
import { ATTACHMENT_LIMITS, uploadPath, type AttachedFile, type WorkspaceAction, type WorkspaceFile, type WorkspaceResult } from '../shared/workspace';
import { validateTokenLimit } from '../shared/budget';
import { addUsage, type RequestUsage } from '../shared/usage';
import { MESSAGE_CHARS, STORAGE } from '../shared/tuning';
import { asContent, LocalizedError, type Text } from '../i18n';

let connection: Promise<IDBPDatabase> | undefined;
const STORES = ['tasks', 'operations', 'checkpoints', 'writes'] as const;
/** Kept in the operations store without a task ID, so no task's operations include it. */
const WORKSPACE_WIPE = 'meta:workspaceWipePending';
/**
 * One shared connection per context; reopened if the browser closes it or a newer version needs it.
 * Schema changes reset prior task data and workspace files; no legacy records are migrated.
 * The files go after the upgrade commits, so a marker keeps the deletion pending until it succeeds.
 */
export const database = () => connection ??= (async () => {
  const db = await openDB('bwai', 6, {
    upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        db.createObjectStore('tasks', { keyPath: 'id' });
        db.createObjectStore('operations', { keyPath: 'id' }).createIndex('taskId', 'taskId');
        db.createObjectStore('checkpoints'); db.createObjectStore('writes');
      } else {
        for (const name of STORES) void tx.objectStore(name).clear();
        void tx.objectStore('operations').put({ id: WORKSPACE_WIPE });
      }
    },
    blocking() { void connection?.then(db => db.close()); connection = undefined; },
    terminated() { connection = undefined; },
  });
  if (await db.get('operations', WORKSPACE_WIPE)) {
    try { await deleteAllWorkspaces(); await db.delete('operations', WORKSPACE_WIPE); }
    catch (error) { db.close(); throw error; }
  }
  return db;
})().catch(error => { connection = undefined; throw error; });
/**
 * Checkpoint and write keys are JSON arrays, so keys sharing leading elements share a string
 * prefix and form a contiguous range. Checkpoint IDs are time-ordered, so ranges are too.
 */
export function keyPrefix(...parts: string[]): IDBKeyRange {
  const prefix = JSON.stringify(parts).slice(0, -1) + ',';
  return IDBKeyRange.bound(prefix, prefix + '\uffff');
}
/** Keys of every thread whose ID starts with `threadPrefix`. */
function threadPrefixRange(threadPrefix: string): IDBKeyRange {
  const prefix = JSON.stringify([threadPrefix]).slice(0, -2);
  return IDBKeyRange.bound(prefix, prefix + '\uffff');
}
export async function getTask(id: string): Promise<Task | undefined> { return (await database()).get('tasks', id); }
export async function taskOperations(taskId: string): Promise<Operation[]> {
  return (await (await database()).getAllFromIndex('operations', 'taskId', taskId) as Operation[]).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
export async function allTasks(): Promise<Task[]> {
  return ((await (await database()).getAll('tasks')) as Task[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function saveTask(task: Task) {
  const tx = (await database()).transaction('tasks', 'readwrite');
  const old = await tx.store.get(task.id) as Task | undefined;
  await tx.store.put({ ...task, messages: conversationMessages(task), updatedAt: old ? updatedTime(old) : task.updatedAt });
  await tx.done; await notify(task.id);
}
/** Drop the oldest activity entries beyond the cap; conversation messages are always kept. */
function capActivity(messages: ConversationMessage[]): ConversationMessage[] {
  let excess = messages.filter(m => m.role === 'activity').length - STORAGE.activity;
  return excess <= 0 ? messages : messages.filter(m => m.role !== 'activity' || excess-- <= 0);
}
function applyTaskPatch(old: Task, patch: Partial<Task>, step?: Text): Task {
  const at = updatedTime(old); const turn = old.turn ?? 0;
  const entry = step === undefined ? undefined : asContent(step);
  let messages = conversationMessages(old);
  if (entry) messages = capActivity([...messages, { id: crypto.randomUUID(), at, turn, role: 'activity', kind: 'status', ...entry }]);
  if (patch.pendingApproval) messages = upsertMessage(messages, { id: `approval:${patch.pendingApproval.requestId}`, at, turn, role: 'assistant', kind: 'approval', ...asContent(patch.pendingApproval.description), approval: patch.pendingApproval });
  if (patch.status === 'error' && patch.error) messages = upsertMessage(messages, { id: crypto.randomUUID(), at, turn, role: 'assistant', kind: 'error', ...asContent(patch.error) });
  if (patch.status === 'blocked' && patch.error && !patch.pendingApproval && !patch.pendingQuestion) messages = upsertMessage(messages, { id: crypto.randomUUID(), at, turn, role: 'assistant', kind: 'message', ...asContent(patch.error) });
  if (patch.resultText && ['completed', 'incomplete'].includes(patch.status ?? '')) messages = upsertMessage(messages, { id: `result:${turn}`, at, turn, role: 'assistant', kind: 'result', content: patch.resultText, outcome: patch.outcome, visitedUrls: old.visitedUrls });
  return { ...old, ...patch, messages, updatedAt: at };
}
/** Every committed task change advances the UI version, even within the same millisecond. */
export const updatedTime = (task: Task) => new Date(Math.max(Date.now(), (Date.parse(task.updatedAt) || 0) + 1)).toISOString();
/** Patch a task unless its turn moved on or `onlyIf` rejects its current state, e.g. a status the user set meanwhile. */
export async function patchTask(id: string, patch: Partial<Task>, step?: Text, expectedTurn?: number, onlyIf?: (task: Task) => boolean) {
  const db = await database(); const tx = db.transaction('tasks', 'readwrite');
  const old = await tx.store.get(id) as Task | undefined;
  if (!old) throw new LocalizedError('db.taskNotFound');
  if ((expectedTurn !== undefined && (old.turn ?? 0) !== expectedTurn) || (onlyIf && !onlyIf(old))) { await tx.done; return old; }
  const next = applyTaskPatch(old, patch, step);
  await tx.store.put(next); await tx.done; await notify(id); return next as Task;
}
const localChanges = new EventTarget();
/** Subscribe to task changes made in this context; other contexts are notified with runtime messages. */
export function onLocalTaskChange(listener: (taskId: string) => void) {
  const handler = (event: Event) => listener((event as CustomEvent<string>).detail);
  localChanges.addEventListener('change', handler);
  return () => localChanges.removeEventListener('change', handler);
}
/** Add one model request's tokens to the conversation; a deleted conversation or a turn that moved on is ignored. */
export async function recordUsage(id: string, request: RequestUsage, turn = 0) {
  const tx = (await database()).transaction('tasks', 'readwrite'); const task = await tx.store.get(id) as Task | undefined;
  if (!task || (task.turn ?? 0) !== turn) { await tx.done; return; }
  await tx.store.put({ ...task, usage: addUsage(task.usage, request, turn), updatedAt: updatedTime(task) }); await tx.done; await notify(id);
}
/** Persist elapsed time only: no message rebuild and no change notification (the UI shows whole minutes). */
export async function recordElapsed(id: string, elapsedMs: number, expectedTurn: number) {
  const tx = (await database()).transaction('tasks', 'readwrite');
  const task = await tx.store.get(id) as Task | undefined;
  if (!task) throw new LocalizedError('db.taskNotFound');
  if ((task.turn ?? 0) === expectedTurn && task.elapsedMs !== elapsedMs) await tx.store.put({ ...task, elapsedMs, updatedAt: updatedTime(task) });
  await tx.done;
}
async function notify(taskId: string) {
  localChanges.dispatchEvent(new CustomEvent('change', { detail: taskId }));
  if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
    await chrome.runtime.sendMessage({ type: 'taskUpdated', taskId, requestId: crypto.randomUUID() }).catch(() => {});
  }
}
export async function operations(taskId: string): Promise<Operation[]> { return (await database()).getAllFromIndex('operations', 'taskId', taskId); }
export async function getOperation(id: string): Promise<Operation | undefined> { return (await database()).get('operations', id); }
export async function saveOperation(op: Operation) {
  const tx = (await database()).transaction(['tasks', 'operations'], 'readwrite');
  if (await tx.objectStore('tasks').get(op.taskId)) await tx.objectStore('operations').put(op);
  await tx.done;
}
export async function deleteTask(taskId: string) {
  const tx = (await database()).transaction(['tasks', 'operations', 'checkpoints', 'writes'], 'readwrite');
  await tx.objectStore('tasks').delete(taskId);
  let operation = await tx.objectStore('operations').index('taskId').openCursor(taskId);
  while (operation) { await operation.delete(); operation = await operation.continue(); }
  // A conversation's threads are its task ID and `<task ID>:turn:<n>` (see threadId in conversation.ts).
  for (const name of ['checkpoints', 'writes'] as const) {
    for (const range of [keyPrefix(taskId), threadPrefixRange(`${taskId}:turn:`)]) await tx.objectStore(name).delete(range);
  }
  await tx.done;
  // After any file action already under way; later ones find the conversation gone (see workspaceAction).
  await withWorkspaceLock(taskId, () => deleteWorkspace(taskId));
  localChanges.dispatchEvent(new CustomEvent('change', { detail: taskId }));
  if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
    await chrome.runtime.sendMessage({ type: 'taskDeleted', taskId, requestId: crypto.randomUUID() }).catch(() => {});
  }
}
/**
 * Run an agent workspace action for a conversation that still exists. The check and the action share the
 * workspace lock with deleteTask, so a write can never recreate the folder of a conversation deleted meanwhile.
 */
export function workspaceAction(taskId: string, action: WorkspaceAction): Promise<WorkspaceResult> {
  return withWorkspaceLock(taskId, async () => {
    if (!await getTask(taskId)) throw new LocalizedError('db.conversationNotFound');
    return runWorkspaceAction(taskId, action);
  });
}
/** Write bytes for a conversation that still exists, under the same lock as workspaceAction. */
export function workspaceWriteBytes(taskId: string, path: string, bytes: Uint8Array): Promise<WorkspaceFile> {
  return withWorkspaceLock(taskId, async () => {
    if (!await getTask(taskId)) throw new LocalizedError('db.conversationNotFound');
    return writeFile(taskId, path, bytes);
  });
}
/** Store files the user attached under uploads/ in the conversation's workspace. */
export async function attachFiles(taskId: string, files: { name: string; bytes: Uint8Array }[]): Promise<AttachedFile[]> {
  if (files.length > ATTACHMENT_LIMITS.files) throw new LocalizedError('attach.tooMany', { limit: ATTACHMENT_LIMITS.files });
  return withWorkspaceLock(taskId, async () => {
    if (!await getTask(taskId)) throw new LocalizedError('db.conversationNotFound');
    const taken = new Set((await listFiles(taskId)).map(file => file.path)); const stored: AttachedFile[] = [];
    for (const file of files) {
      const path = uploadPath(file.name, taken); taken.add(path);
      const written = await writeFile(taskId, path, file.bytes); stored.push({ path, size: written.size, type: written.type });
    }
    return stored;
  });
}
export async function appendMessage(taskId: string, message: Omit<ConversationMessage, 'at'>, expectedTurn = message.turn) {
  const tx = (await database()).transaction('tasks', 'readwrite'); const task = await tx.store.get(taskId) as Task | undefined;
  if (!task) throw new LocalizedError('db.conversationNotFound');
  if ((task.turn ?? 0) !== expectedTurn) { await tx.done; return; }
  await tx.store.put({ ...task, messages: capActivity(upsertMessage(conversationMessages(task), { ...message, at: now() })), updatedAt: updatedTime(task) });
  await tx.done; await notify(taskId);
}
interface SendOptions { messageId?: string; tokenLimit?: number; attachments?: AttachedFile[] }
/**
 * Send a message; a message after a finished turn starts a new turn, which uses the optional token limit from current settings.
 * `attachments` are files already stored with attachFiles.
 */
export async function sendTaskMessage(taskId: string, text: string, { messageId = crypto.randomUUID(), tokenLimit, attachments }: SendOptions = {}): Promise<Task> {
  const content = text.trim(); if (!content || content.length > MESSAGE_CHARS) throw new LocalizedError('db.messageLength');
  const db = await database(); const tx = db.transaction(['tasks', 'operations'], 'readwrite');
  const task = await tx.objectStore('tasks').get(taskId) as Task | undefined;
  if (!task) throw new LocalizedError('db.conversationNotFound');
  const previous = conversationMessages(task);
  if (previous.some(m => m.id === messageId)) { await tx.done; return task; }
  const continuing = isFinished(task.status);
  const turn = (task.turn ?? 0) + (continuing ? 1 : 0); const at = updatedTime(task);
  let messages = previous;
  if (task.pendingApproval) {
    const op = await tx.objectStore('operations').get(task.pendingApproval.requestId) as Operation | undefined;
    const superseded = op?.phase === 'done' && !!op.result?.approval && op.approvalDecision !== 'rejected';
    if (superseded) await tx.objectStore('operations').put({ ...op, approvalDecision: 'rejected', approvalAt: at, supersededBy: messageId });
    messages = messages.map(m => m.approval?.requestId === task.pendingApproval?.requestId && (!m.decision || superseded) ? { ...m, decision: 'superseded' as const } : m);
  }
  messages = [...messages, { id: messageId, at, turn, role: 'user', kind: 'message', content, ...(attachments?.length ? { attachments } : {}) }];
  const next: Task = continuing ? { ...task, tokenLimit: validateTokenLimit(tokenLimit), turn, turnGoal: content, status: 'ready', instructions: [], elapsedMs: 0, turnVisitedUrls: [], resultText: '', outcome: undefined, pendingApproval: undefined, pendingQuestion: undefined, pause: undefined, error: undefined, messages, updatedAt: at }
    : { ...task, instructions: [...(task.instructions ?? []), { at, text: content }], pendingApproval: undefined, messages, status: task.pause?.kind === 'tokens' ? 'paused' : task.status === 'running' ? 'running' : 'ready', error: undefined, updatedAt: at };
  await tx.objectStore('tasks').put(next); await tx.done; await notify(taskId); return next;
}

/** Do not close a turn over a user message that arrived while its result was being generated. */
export async function completeTurn(taskId: string, turn: number, instructionCount: number, patch: Partial<Task>): Promise<boolean> {
  const tx = (await database()).transaction('tasks', 'readwrite'); const task = await tx.store.get(taskId) as Task | undefined;
  if (!task || task.status !== 'running' || (task.turn ?? 0) !== turn || (task.instructions?.length ?? 0) !== instructionCount) { await tx.done; return false; }
  await tx.store.put(applyTaskPatch(task, patch)); await tx.done; await notify(taskId); return true;
}
