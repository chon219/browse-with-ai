import { attachTab, cleanupTaskTabs, closeTaskTabs, pruneClosedTab, syncGroupTitle } from './tabs';
import { decideApproval, perform } from './operations';
import { closesAgentTabs, restrictStorageAccess } from '../storage/settings';
import { deleteTask, getTask, patchTask } from '../storage/db';
import { isFinished, type Command, type RpcResult } from '../shared/types';
import { initLocale, LocalizedError, t, watchLocale } from '../i18n';

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
void restrictStorageAccess().catch(e => console.warn('storage access level', e));
const localeReady = initLocale(); watchLocale();
let queue: Promise<unknown> = Promise.resolve();
/** With the setting on, close a finished task's tabs, after any tool still in flight. */
function closeIfFinished(taskId: string) {
  const job = async () => {
    const task = await getTask(taskId);
    if (task && isFinished(task.status) && await closesAgentTabs()) await closeTaskTabs(taskId);
  };
  queue = queue.then(job, job).catch(error => console.warn('BWAI could not close task tabs', error));
}
/** Registry cleanup shares the tool queue, so it cannot race an operation using a tab. */
chrome.tabs.onRemoved.addListener(tabId => {
  const prune = () => pruneClosedTab(tabId);
  queue = queue.then(prune, prune).catch(error => console.warn('BWAI could not forget a closed tab', error));
});
chrome.runtime.onMessage.addListener((message: Command, sender, respond: (reply: RpcResult) => void) => {
  if (sender.id !== chrome.runtime.id || sender.tab?.url?.startsWith('http')) return;
  if (!sender.url?.startsWith(chrome.runtime.getURL('')) || !message?.taskId || !message.requestId) return;
  // A task page committed a change; a finished task may need its tabs closed.
  if (message.type === 'taskUpdated') { closeIfFinished(message.taskId); void syncGroupTitle(message.taskId).catch(() => {}); return; }
  if (message.type === 'taskDeleted' || message.type === 'workspaceUpdated') return;
  const handle = async (): Promise<RpcResult> => {
    await localeReady;
    if (message.type === 'deleteTask') {
      await deleteTask(message.taskId);
      // Drain in-flight tools before releasing tab ownership; opened pages stay available to the user unless the setting closes them.
      const cleanup = async () => { await cleanupTaskTabs(message.taskId); return { ok: true }; };
      return await (queue = queue.then(cleanup, cleanup)) as RpcResult;
    }
    if (message.type === 'attachTab') {
      await attachTab(message.taskId, message.tabId, message.expectedUrl); return { ok: true };
    }
    if (message.type === 'approval') {
      await decideApproval(message); return { ok: true };
    }
    if (message.type === 'tool') {
      if (!sender.url?.startsWith(chrome.runtime.getURL('task.html'))) throw new LocalizedError('bg.toolsRunnerOnly');
      return { ok: true, result: await perform(message) };
    }
    if (message.type === 'openRunner') {
      const task = await getTask(message.taskId); if (!task) throw new LocalizedError('db.taskNotFound');
      const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('task.html') + '*' });
      const url = chrome.runtime.getURL('task.html') + '?task=' + encodeURIComponent(message.taskId);
      const tab = tabs[0];
      if (tab?.id) {
        const existingId = new URL(tab.url!).searchParams.get('task');
        if (existingId !== message.taskId && (await getTask(existingId ?? ''))?.status === 'running') throw new LocalizedError('app.pauseRunningFirst');
        const navigated = existingId !== message.taskId;
        if (message.start && navigated && !isFinished(task.status)) await patchTask(task.id, { status: 'ready' });
        // Starting from the side panel keeps the user where they are; only opening the task page on request brings it forward.
        await chrome.tabs.update(tab.id, { active: !message.start, autoDiscardable: false, ...(navigated ? { url } : {}) });
        // A task page that loads a ready task starts it, so the caller must not also send control:start.
        return { ok: true, navigated };
      }
      if (message.start && !isFinished(task.status)) await patchTask(task.id, { status: 'ready' });
      const created = await chrome.tabs.create({ url, active: !message.start });
      // A discarded task page would stop its run.
      if (created.id) await chrome.tabs.update(created.id, { autoDiscardable: false }).catch(() => {});
      return { ok: true, navigated: true };
    }
    if (message.type === 'control') {
      if (message.command === 'pause' || message.command === 'cancel') {
        const task = await getTask(message.taskId);
        if (task && !isFinished(task.status)) await patchTask(message.taskId, { status: message.command === 'pause' ? 'paused' : 'cancelled' });
        // Changes made here are not echoed back to this listener.
        if (message.command === 'cancel') closeIfFinished(message.taskId);
      }
      return { ok: true };
    }
    return { ok: false, error: t('bg.unknownMessage') };
  };
  const result = message.type === 'tool' || message.type === 'attachTab' ? (queue = queue.then(handle, handle)) as Promise<RpcResult> : handle();
  void result.then(respond, e => respond({ ok: false, error: e instanceof Error ? e.message : t('bg.extensionFailed') }));
  return true;
});
