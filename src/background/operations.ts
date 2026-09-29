import { executePageTool } from './page-tools';
import { discard, groupTab, ownedTab, owner, registry, track, untrack } from './tabs';
import { settle, waitForPage, watchTab } from './navigation';
import { actionSchema, declaresEffect } from '../shared/policy';
import { pagePermissionPattern, policyPermissionPatterns, validatePageUrl } from '../shared/web-policy';
import { searchUrl } from '../shared/search-engines';
import { loadWebPolicy } from '../storage/settings';
import { database, getTask, getOperation, patchTask, saveOperation, updatedTime } from '../storage/db';
import { now, type BrowserAction, type BrowserResult, type Command, type Confirmation, type Operation, type Task, type ToolMessage } from '../shared/types';
import { conversationMessages } from '../shared/conversation';
import { PAGE_WAIT } from '../shared/tuning';
import { errorText, LocalizedError, type LocalText, msg } from '../i18n';

async function assertRunning(taskId: string, turn = 0) { const task = await getTask(taskId); if (task?.status !== 'running' || (task.turn ?? 0) !== turn) throw new LocalizedError('bg.notRunning'); }
async function pagePermissionError(url: string): Promise<LocalText | undefined> {
  if (new URL(url).protocol === 'file:' && !(await chrome.extension.isAllowedFileSchemeAccess())) return msg('bg.fileAccess');
  if (!(await chrome.permissions.contains({ origins: [pagePermissionPattern(url)] }))) return msg('bg.sitePermission');
}
async function pageTool(tabId: number, taskId: string, action: BrowserAction, approved = false, turn = 0): Promise<BrowserResult & { navigate?: string; settle?: boolean; confirmation?: Confirmation }> {
  const tab = await ownedTab(tabId, taskId);
  const policy = await loadWebPolicy();
  const permissionError = await pagePermissionError(tab.url!); if (permissionError) return { blocked: permissionError, tabId };
  await assertRunning(taskId, turn);
  const response = await executePageTool(tabId, taskId, action, policy, approved, () => assertRunning(taskId, turn));
  const entry = (await registry())[String(tabId)];
  if (response.snapshot && entry?.searchUrl?.split('#')[0] === response.snapshot.url.split('#')[0]) response.snapshot.isSearchResult = true;
  return { ...response, tabId };
}
function confirmationResult(message: ToolMessage, confirmation: Confirmation, tabId?: number): BrowserResult {
  return { tabId, blocked: msg('bg.awaitingApproval'), approval: { ...confirmation, requestId: message.requestId, tabId } };
}
async function execute(message: ToolMessage, approved = false): Promise<BrowserResult> {
  const action = actionSchema.parse(message.action); const { taskId } = message;
  const turn = message.turn ?? 0;
  await assertRunning(taskId, turn);
  const policy = await loadWebPolicy();
  if (action.name === 'list_tabs') {
    const entries = await registry(); const tabs = await chrome.tabs.query({});
    const granted = tabs.filter(t => { if (!t.id || owner(entries[String(t.id)]) !== taskId) return false; try { validatePageUrl(t.url ?? '', policy); return true; } catch { return false; } }).map(t => ({ id: t.id!, title: t.title ?? '', url: t.url ?? '', active: t.active }));
    return { tabs: granted, ...(granted.length ? {} : { note: msg('bg.noTaskTabs') }) };
  }
  if (action.name === 'search' || action.name === 'open') {
    if (action.name === 'search' && message.search === 'browser') {
      if (!policy.allowedSchemes.some(scheme => scheme === 'http' || scheme === 'https')) return { error: msg('bg.noHttpSearch') };
      if (!chrome.search?.query) return { blocked: msg('bg.browserSearchUnavailable') };
      const origins = policyPermissionPatterns(policy).filter(pattern => !pattern.startsWith('file:'));
      if (!(await chrome.permissions.contains({ origins }))) return { blocked: msg('bg.enableWebAccess') };
      const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
      await track(tab.id!, taskId); await groupTab(tab.id!, taskId);
      try { await assertRunning(taskId, turn); } catch (e) { await discard(tab.id!); throw e; }
      try { await chrome.search.query({ text: action.query, tabId: tab.id! }); }
      catch { await discard(tab.id!); return { blocked: msg('bg.browserSearchFailed') }; }
      await waitForPage(tab.id!, () => assertRunning(taskId, turn));
      await track(tab.id!, taskId, true, (await chrome.tabs.get(tab.id!)).url);
      return pageTool(tab.id!, taskId, { name: 'read', tabId: tab.id! }, false, turn);
    }
    const url = validatePageUrl(action.name === 'search' ? searchUrl(action.query, message.search) : action.url, policy);
    if (!approved && action.name === 'open' && declaresEffect(action)) return confirmationResult(message, { url, description: msg('bg.openNeedsApproval'), ...(action.reason ? { reason: action.reason } : {}) });
    const permissionError = await pagePermissionError(url); if (permissionError) return { blocked: permissionError };
    // Register an inert tab before navigation so recovery never touches a user's tab.
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    await track(tab.id!, taskId); await groupTab(tab.id!, taskId);
    try { await assertRunning(taskId, turn); } catch (e) { await discard(tab.id!); throw e; }
    await chrome.tabs.update(tab.id!, { url }); await waitForPage(tab.id!, () => assertRunning(taskId, turn));
    // Remember where the search landed, so its snapshot is marked as search results.
    if (action.name === 'search') await track(tab.id!, taskId, true, (await chrome.tabs.get(tab.id!)).url ?? url);
    return pageTool(tab.id!, taskId, { name: 'read', tabId: tab.id! }, false, turn);
  }
  await ownedTab(action.tabId, taskId);
  if (action.name === 'close') {
    const entry = (await registry())[String(action.tabId)];
    if (!entry?.createdByTask) return { error: msg('bg.keepUserTab') };
    await assertRunning(taskId, turn); await chrome.tabs.remove(action.tabId); await untrack(action.tabId); return { closed: true };
  }
  // Switching only moves the task's attention; the user's own tab stays in front.
  if (action.name === 'switch_tab') return pageTool(action.tabId, taskId, { name: 'read', tabId: action.tabId }, false, turn);
  if (action.name === 'back') { const watch = watchTab(action.tabId); try { await chrome.tabs.goBack(action.tabId); } catch (e) { watch.stop(); throw e; } await settle(watch, PAGE_WAIT.backMs, action.tabId, () => assertRunning(taskId, turn)); return pageTool(action.tabId, taskId, { name: 'read', tabId: action.tabId }, false, turn); }
  if (action.name === 'wait') { await new Promise(r => setTimeout(r, action.milliseconds)); await waitForPage(action.tabId, () => assertRunning(taskId, turn)); return pageTool(action.tabId, taskId, { name: 'read', tabId: action.tabId }, false, turn); }
  // Watch from before the action, so a navigation it starts is seen however quickly it follows.
  const watch = watchTab(action.tabId);
  let result: Awaited<ReturnType<typeof pageTool>>;
  try { result = await pageTool(action.tabId, taskId, action, approved, turn); } catch (e) { watch.stop(); throw e; }
  if (!result.settle) watch.stop();
  if (result.confirmation) return confirmationResult(message, result.confirmation, action.tabId);
  if (result.settle) {
    await settle(watch, PAGE_WAIT.settleMs, action.tabId, () => assertRunning(taskId, turn));
    return pageTool(action.tabId, taskId, { name: 'read', tabId: action.tabId }, false, turn);
  }
  if (result.navigate) {
    await assertRunning(taskId, turn);
    const url = validatePageUrl(result.navigate, await loadWebPolicy());
    const permissionError = await pagePermissionError(url); if (permissionError) return { blocked: permissionError, tabId: action.tabId };
    await chrome.tabs.update(action.tabId, { url });
    await waitForPage(action.tabId, () => assertRunning(taskId, turn));
    return pageTool(action.tabId, taskId, { name: 'read', tabId: action.tabId }, false, turn);
  }
  return result;
}
export async function perform(message: ToolMessage): Promise<BrowserResult> {
  // Reject malformed actions before anything is recorded for them.
  actionSchema.parse(message.action);
  const task = await getTask(message.taskId); const turn = message.turn ?? 0;
  if (!task || (task.turn ?? 0) !== turn) return { error: msg('bg.turnEnded') };
  const old = await getOperation(message.requestId);
  if (old && (old.taskId !== message.taskId || (old.turn ?? 0) !== turn)) return { error: msg('bg.staleTurnOperation') };
  if (old?.phase === 'done' && old.result?.approval && old.approvalDecision === 'rejected') {
    const result = { error: old.supersededBy ? msg('bg.superseded') : msg('bg.rejected') };
    await saveOperation({ ...old, result }); return result;
  }
  const approved = old?.phase === 'done' && !!old.result?.approval && old.approvalDecision === 'approved';
  if (old?.phase === 'done' && !approved) return old.result!;
  if (old && old.phase === 'pending') {
    const result = { error: msg('bg.unknownResult') };
    await saveOperation({ ...old, phase: 'done', result }); return result;
  }
  await assertRunning(message.taskId, turn);
  // Consuming the approval and marking the operation pending happen before the side effect.
  // A crashed/unknown approved operation is never automatically retried.
  const action = approved ? old!.action as BrowserAction : message.action;
  const op: Operation = { ...old, id: message.requestId, taskId: message.taskId, turn, action, phase: 'pending', startedAt: old?.startedAt ?? now() };
  await saveOperation(op);
  let result: BrowserResult;
  try { result = await execute({ ...message, action }, approved); } catch (e) { result = { error: errorText(e, 'bg.pageActionFailed') }; }
  await saveOperation({ ...op, phase: 'done', result });
  if (result.snapshot) {
    const url = new URL(result.snapshot.url); url.hash = '';
    const latest = await getTask(message.taskId);
    if (!latest) return { error: msg('bg.conversationDeleted') };
    const visited = [...new Set([...(latest?.visitedUrls ?? []), url.href])];
    const turnVisitedUrls = [...new Set([...(latest?.turnVisitedUrls ?? []), url.href])];
    const visitedPages = [...(latest.visitedPages ?? [])];
    const pageIndex = visitedPages.findIndex(page => page.url === url.href);
    const page = { url: url.href, title: result.snapshot.title.trim() || visitedPages[pageIndex]?.title || '' };
    if (pageIndex < 0) visitedPages.push(page); else visitedPages[pageIndex] = page;
    await patchTask(message.taskId, { visitedUrls: visited, visitedPages, turnVisitedUrls, lastPage: result.tabId ? { id: result.tabId, url: result.snapshot.url, title: result.snapshot.title } : latest?.lastPage }, undefined, turn);
  }
  return result;
}

/** Record the decision and ready state in the same database transaction. */
export async function decideApproval(message: Extract<Command, { type: 'approval' }>) {
  const tx = (await database()).transaction(['tasks', 'operations'], 'readwrite');
  const task = await tx.objectStore('tasks').get(message.taskId) as Task | undefined;
  const op = await tx.objectStore('operations').get(message.requestId) as Operation | undefined;
  if (!task || task.status !== 'blocked' || task.pendingApproval?.requestId !== message.requestId || !op?.result?.approval || op.taskId !== task.id || (op.turn ?? 0) !== (task.turn ?? 0) || op.phase !== 'done' || op.approvalDecision) {
    await tx.done; throw new LocalizedError('bg.approvalInvalid');
  }
  await tx.objectStore('operations').put({ ...op, approvalDecision: message.decision, approvalAt: now() });
  const messages = conversationMessages(task).map(m => m.approval?.requestId === message.requestId ? { ...m, decision: message.decision } : m);
  await tx.objectStore('tasks').put({ ...task, status: 'ready', messages, updatedAt: updatedTime(task) }); await tx.done;
  await patchTask(task.id, {}, msg(message.decision === 'approved' ? 'bg.userApproved' : 'bg.userRejected'));
}
