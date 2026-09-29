import { forgetPageTargets } from './page-tools';
import { closesAgentTabs, loadWebPolicy } from '../storage/settings';
import { getTask, patchTask } from '../storage/db';
import { validatePageUrl } from '../shared/web-policy';
import type { Task } from '../shared/types';
import { LocalizedError } from '../i18n';

const registryKey = 'taskTabs';
/** Session storage is cleared when the extension is updated, so entries always have the current shape. */
type TabRegistry = Record<string, { taskId: string; createdByTask: boolean; searchUrl?: string }>;
export async function registry(): Promise<TabRegistry> { return (await chrome.storage.session.get(registryKey))[registryKey] as TabRegistry ?? {}; }
export const owner = (entry: TabRegistry[string] | undefined) => entry?.taskId;
export async function track(tabId: number, taskId: string, createdByTask = true, searchUrl?: string) { const tabs = await registry(); tabs[String(tabId)] = { taskId, createdByTask, ...(searchUrl ? { searchUrl } : {}) }; await chrome.storage.session.set({ [registryKey]: tabs }); }
export async function untrack(tabId: number) { await forgetPageTargets(tabId); const tabs = await registry(); if (String(tabId) in tabs) { delete tabs[String(tabId)]; await chrome.storage.session.set({ [registryKey]: tabs }); } }
/** Close a tab the task just opened and no longer needs. */
export async function discard(tabId: number) { await untrack(tabId); await chrome.tabs.remove(tabId).catch(() => {}); }
const groupsKey = 'taskTabGroups';
const groupTitle = (task: Task | undefined) => { const name = task?.title ?? task?.goal ?? ''; return `BWAI · ${name.length > 24 ? name.slice(0, 24) + '…' : name}`; };
/** Keep a conversation's tab group named after it, e.g. once the model has named it. */
export async function syncGroupTitle(taskId: string) {
  const groupId = ((await chrome.storage.session.get(groupsKey))[groupsKey] as Record<string, number> | undefined)?.[taskId];
  if (groupId === undefined) return;
  const [group, task] = await Promise.all([chrome.tabGroups.get(groupId).catch(() => undefined), getTask(taskId)]);
  if (group && task && group.title !== groupTitle(task)) await chrome.tabGroups.update(groupId, { title: groupTitle(task) }).catch(() => {});
}
/** Put a tab the task opened into the conversation's tab group, creating one in the tab's window when needed. Grouping is cosmetic, so it never fails a tool. */
export async function groupTab(tabId: number, taskId: string) {
  try {
    const groups = (await chrome.storage.session.get(groupsKey))[groupsKey] as Record<string, number> ?? {};
    const tab = await chrome.tabs.get(tabId);
    const existing = groups[taskId] === undefined ? undefined : await chrome.tabGroups.get(groups[taskId]).catch(() => undefined);
    if (existing?.windowId === tab.windowId) { await chrome.tabs.group({ groupId: existing.id, tabIds: tabId }); return; }
    const groupId = await chrome.tabs.group({ tabIds: tabId, createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(groupId, { title: groupTitle(await getTask(taskId)), color: 'green' });
    await chrome.storage.session.set({ [groupsKey]: { ...groups, [taskId]: groupId } });
  } catch (error) { console.warn('BWAI could not group a task tab', error); }
}
async function forgetGroup(taskId: string) {
  const groups = (await chrome.storage.session.get(groupsKey))[groupsKey] as Record<string, number> ?? {};
  if (taskId in groups) { delete groups[taskId]; await chrome.storage.session.set({ [groupsKey]: groups }); }
}
/** Close the tabs a task opened itself; tabs the user handed to it stay open. */
export async function closeTaskTabs(taskId: string) {
  const entries = await registry();
  const ids = Object.entries(entries).filter(([, entry]) => entry.taskId === taskId && entry.createdByTask).map(([id]) => Number(id));
  if (!ids.length) return;
  for (const id of ids) delete entries[String(id)];
  await chrome.storage.session.set({ [registryKey]: entries });
  await Promise.all(ids.map(id => chrome.tabs.remove(id).catch(() => {})));
}
export async function ownedTab(tabId: number, taskId: string) {
  if (owner((await registry())[String(tabId)]) !== taskId) throw new LocalizedError('bg.tabNotOwned');
  const tab = await chrome.tabs.get(tabId); validatePageUrl(tab.url ?? tab.pendingUrl ?? '', await loadWebPolicy()); return tab;
}

/** Release ownership only after the caller has drained in-flight tools. */
export async function cleanupTaskTabs(taskId: string) {
  if (await closesAgentTabs()) await closeTaskTabs(taskId);
  await forgetGroup(taskId);
  const entries = await registry();
  for (const [id, entry] of Object.entries(entries)) if (owner(entry) === taskId) delete entries[id];
  await chrome.storage.session.set({ [registryKey]: entries });
}

export async function pruneClosedTab(tabId: number) {
  const taskId = owner((await registry())[String(tabId)]);
  await untrack(tabId);
  const task = taskId ? await getTask(taskId) : undefined;
  if (!task || (task.lastPage?.id !== tabId && task.contextTab?.id !== tabId)) return;
  await patchTask(task.id, { ...(task.lastPage?.id === tabId ? { lastPage: undefined } : {}), ...(task.contextTab?.id === tabId ? { contextTab: undefined } : {}) });
}

export async function attachTab(taskId: string, tabId: number, expectedUrl: string) {
  const task = await getTask(taskId); if (!task || task.status !== 'ready') throw new LocalizedError('bg.attachOnlyReady');
  const tab = await chrome.tabs.get(tabId); const url = validatePageUrl(tab.url ?? '', await loadWebPolicy());
  if (url !== expectedUrl) throw new LocalizedError('bg.pageChanged');
  const previousOwner = owner((await registry())[String(tabId)]);
  if (previousOwner && previousOwner !== task.id && (await getTask(previousOwner))?.status === 'running') throw new LocalizedError('bg.tabInUse');
  await track(tabId, task.id, false);
  await patchTask(task.id, { contextTab: { id: tabId, url, title: tab.title ?? url } });
}
