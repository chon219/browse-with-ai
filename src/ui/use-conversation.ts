import { useState } from 'react';
import { allTasks, appendMessage, attachFiles, deleteTask, getTask, saveTask, sendTaskMessage } from '../storage/db';
import { readAttachments, mergeAttachments, releaseAttachments, useAttachments, type SetAttachments } from './attachments';
import { conversationMarkdown } from '../shared/conversation';
import { validatePageUrl } from '../shared/web-policy';
import { loadConfig, loadWebPolicy } from '../storage/settings';
import { ATTACHMENT_LIMITS } from '../shared/workspace';
import { now, type Command, type RpcResult, type Task } from '../shared/types';
import { normalizeTokenLimit } from '../shared/budget';
import { downloadBlob } from './helpers';
import { LocalizedError, t } from '../i18n';
import { usePageAccess, useTasks } from './app-state';
import { getSkill } from '../storage/skills';

async function rpc(message: Command) {
  const response = await chrome.runtime.sendMessage(message) as RpcResult | undefined;
  // No reply means no listener handled the request.
  if (!response) throw new LocalizedError('app.noResponse');
  if (!response.ok) throw new Error(response.error); return response;
}

/** Conversation drafts, persistence and execution actions shared by the task page and side panel. */
export function useConversation(isRunner: boolean) {
  const [selected, setSelected] = useState(new URLSearchParams(location.search).get('task') ?? '');
  const [deleting, setDeleting] = useState<Task>();
  const [tasks, setTasks] = useTasks(taskId => {
    setSelected(current => current === taskId ? '' : current);
    setDeleting(current => current?.id === taskId ? undefined : current);
    if (new URLSearchParams(location.search).get('task') === taskId) history.replaceState(null, '', location.pathname);
  });
  const access = usePageAccess();
  const [goal, setGoal] = useState(''); const [instruction, setInstruction] = useState('');
  const [skillId, setSkillId] = useState('');
  // Files waiting to go with the first message of a new conversation, or with the next message of the open one.
  const [draftFiles, setDraftFiles, latestDraftFiles] = useAttachments(); const [messageFiles, setMessageFiles, latestMessageFiles] = useAttachments();
  const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const task = tasks.find(item => item.id === selected);

  const dropFile = (set: SetAttachments) => (index: number) => set(current => { releaseAttachments(current.slice(index, index + 1)); return current.filter((_, i) => i !== index); });
  /** Read the files first, then add them to whatever is waiting by then: files added meanwhile are kept, and extras over the limit released. */
  async function pickFiles(files: File[], set: SetAttachments) {
    const result = await readAttachments(files);
    let dropped = false;
    set(current => { const merged = mergeAttachments(current, result.files); releaseAttachments(merged.dropped); dropped = !!merged.dropped.length; return merged.files; });
    setNotice(dropped ? t('attach.tooMany', { limit: ATTACHMENT_LIMITS.files }) : result.error?.message ?? '');
  }
  async function guard(action: () => Promise<unknown>) {
    setNotice(''); setBusy(true);
    try { await action(); } catch (e) { setNotice(e instanceof Error ? e.message : t('common.operationFailed')); } finally { setBusy(false); }
  }
  const guarded = (action: () => Promise<unknown>) => () => void guard(action);

  function newConversation() {
    releaseAttachments([...latestDraftFiles.current, ...latestMessageFiles.current]);
    setSelected(''); setGoal(''); setInstruction(''); setDraftFiles([]); setMessageFiles([]); access.setContextTabId(''); setNotice('');
    setSkillId('');
    void access.refreshTabs();
  }
  async function launchTask(taskId: string) {
    if (isRunner) {
      const { runTask } = await import('../agent/runner');
      // The run continues in the background; only a failure to start is reported here.
      void runTask(taskId).then(started => { if (!started) setNotice(t('runner.anotherRunning')); }, e => setNotice(e instanceof Error ? e.message : t('app.runFailed')));
    } else {
      // A runner page that was just opened or pointed at this task starts it on boot; only an existing one needs the start message.
      const opened = await rpc({ type: 'openRunner', taskId, requestId: crypto.randomUUID(), start: true });
      if (!opened.navigated) await rpc({ type: 'control', taskId, requestId: crypto.randomUUID(), command: 'start' });
    }
  }
  async function createTask() {
    if (!goal.trim()) throw new LocalizedError('app.goalRequired');
    if ((await allTasks()).some(item => item.status === 'running')) throw new LocalizedError('app.pauseRunningFirst');
    const saved = await loadConfig(); if (!saved.apiKey || !saved.model) throw new LocalizedError('app.configureModelFirst');
    const tab = access.contextTabId ? access.availableTabs.find(item => item.id === Number(access.contextTabId)) : undefined;
    if (access.contextTabId && !tab?.url) throw new LocalizedError('app.tabUnavailable');
    const files = latestDraftFiles.current;
    const skill = skillId ? await getSkill(skillId) : undefined;
    if (skillId && !skill) throw new LocalizedError('skills.missing');
    const id = crypto.randomUUID(); const at = now();
    await saveTask({ id, goal: goal.trim(), status: 'ready', skill, tokenLimit: normalizeTokenLimit(saved.tokenLimit), createdAt: at, updatedAt: at, resultText: '', elapsedMs: 0 });
    try {
      if (files.length) {
        const attachments = await attachFiles(id, files);
        await appendMessage(id, { id: 'initial', turn: 0, role: 'user', kind: 'message', content: goal.trim(), attachments });
      }
      if (tab?.url) await rpc({ type: 'attachTab', taskId: id, requestId: crypto.randomUUID(), tabId: Number(access.contextTabId), expectedUrl: tab.url });
    } catch (e) {
      // Remove the half-created conversation so sending again does not leave a duplicate.
      await rpc({ type: 'deleteTask', taskId: id, requestId: crypto.randomUUID() }).catch(() => deleteTask(id)).catch(() => {});
      throw e;
    }
    const created = await getTask(id);
    if (created) setTasks(current => [created, ...current.filter(item => item.id !== id)]);
    setSelected(id); setGoal(''); releaseAttachments(files); setDraftFiles(current => current.filter(file => !files.includes(file)));
    await launchTask(id);
  }
  async function pickCurrentPage() {
    await access.refreshTabs();
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active?.id) throw new LocalizedError('app.noActiveTab');
    validatePageUrl(active.url ?? '', await loadWebPolicy());
    access.setContextTabId(String(active.id));
  }
  async function enableAccess() { if (!await access.requestAccess()) throw new LocalizedError('app.webAccessDenied'); }
  async function deleteConversation() {
    if (!deleting) return;
    const id = deleting.id;
    await rpc({ type: 'deleteTask', taskId: id, requestId: crypto.randomUUID() });
    setTasks(current => current.filter(item => item.id !== id));
    setSelected(current => current === id ? '' : current);
    if (selected === id) { setInstruction(''); setGoal(''); access.setContextTabId(''); }
    setDeleting(undefined);
  }

  async function control(task: Task, command: 'start' | 'pause' | 'cancel') {
    if (command === 'start') return launchTask(task.id);
    if (isRunner) { const { releaseClose } = await import('../agent/runner'); releaseClose(task.id); }
    await rpc({ type: 'control', taskId: task.id, requestId: crypto.randomUUID(), command });
    // Runtime messages do not echo to their sending page.
    if (isRunner) { const { stopTask } = await import('../agent/runner'); stopTask(task.id); }
  }
  async function sendMessage(task: Task) {
    if (!instruction.trim()) return;
    const draft = instruction; const files = latestMessageFiles.current;
    const attachments = files.length ? await attachFiles(task.id, files) : undefined;
    const next = await sendTaskMessage(task.id, draft, { tokenLimit: normalizeTokenLimit((await loadConfig()).tokenLimit), attachments });
    // Only the files that went with the message; any added while sending wait for the next one.
    setInstruction(current => current === draft ? '' : current); releaseAttachments(files); setMessageFiles(current => current.filter(file => !files.includes(file)));
    if (next.status !== 'running' && next.pause?.kind !== 'tokens') await launchTask(task.id);
  }
  async function decideApproval(task: Task, decision: 'approved' | 'rejected') {
    if (!task.pendingApproval) return;
    await rpc({ type: 'approval', taskId: task.id, requestId: task.pendingApproval.requestId, decision });
    await launchTask(task.id);
  }

  function selectConversation(task: Task) {
    setSelected(task.id); setInstruction(''); releaseAttachments(latestMessageFiles.current); setMessageFiles([]);
  }
  return {
    tasks, task, selected, selectConversation, deleting, setDeleting,
    skillId, setSkillId,
    goal, setGoal, instruction, setInstruction, draftFiles, messageFiles, access, notice, setNotice, busy,
    guard, guarded, newConversation, createTask, deleteConversation, control, sendMessage, decideApproval,
    openRunner: (taskId: string) => rpc({ type: 'openRunner', taskId, requestId: crypto.randomUUID() }),
    exportConversation: (task: Task) => downloadBlob(new Blob([conversationMarkdown(task)], { type: 'text/markdown;charset=utf-8' }), t('export.filename', { id: task.id.slice(0, 8) })),
    pickDraftFiles: (files: File[]) => pickFiles(files, setDraftFiles),
    pickMessageFiles: (files: File[]) => pickFiles(files, setMessageFiles),
    removeDraftFile: dropFile(setDraftFiles), removeMessageFile: dropFile(setMessageFiles),
    pickCurrentPage, enableAccess,
  };
}
