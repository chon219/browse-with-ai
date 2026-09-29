import { useEffect, useRef, useState } from 'react';
import { allTasks, getTask, onLocalTaskChange } from '../storage/db';
import { loadWebPolicy } from '../storage/settings';
import { normalizeWebPolicy, policyPermissionPatterns, validatePageUrl } from '../shared/web-policy';
import type { Command, Task } from '../shared/types';

const newestFirst = (a: Task, b: Task) => b.createdAt.localeCompare(a.createdAt);
/** The next list, reusing unchanged task objects (and the list itself) so rows do not re-render needlessly. */
export function reuseTasks(current: Task[], next: Task[]): Task[] {
  const known = new Map(current.map(task => [task.id, task]));
  const merged = next.map(task => { const old = known.get(task.id); return old && old.updatedAt === task.updatedAt ? old : task; });
  return merged.length === current.length && merged.every((task, i) => task === current[i]) ? current : merged;
}

/** All conversations, kept current from local changes, other extension pages, and a slow fallback reload. */
export function useTasks(onDeleted: (taskId: string) => void) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const deleted = useRef(onDeleted); deleted.current = onDeleted;
  useEffect(() => {
    let live = true;
    // Every targeted reload takes a sequence number; a full reload started before a conversation's latest targeted
    // reload keeps what that one found (including a deletion) instead of its own, possibly older, copy.
    let sequence = 0; const touched = new Map<string, number>();
    const refresh = () => {
      const started = sequence;
      void allTasks().then(found => {
        if (!live) return;
        setTasks(current => {
          const newer = [...touched].filter(([, at]) => at > started).map(([id]) => id);
          const kept = newer.length ? [...found.filter(task => !newer.includes(task.id)), ...current.filter(task => newer.includes(task.id))].sort(newestFirst) : found;
          return reuseTasks(current, kept);
        });
      }, () => {});
    };
    // Reload only the changed conversation; the full reload covers missed notifications.
    const refreshTask = (id: string) => {
      const at = ++sequence; touched.set(id, at);
      void getTask(id).then(task => {
        // A later reload of the same conversation supersedes this one.
        if (!live || touched.get(id) !== at) return;
        setTasks(current => {
          const old = current.find(item => item.id === id);
          if (task && old?.updatedAt === task.updatedAt) return current;
          if (!task && !old) return current;
          return task ? [task, ...current.filter(item => item.id !== id)].sort(newestFirst) : current.filter(item => item.id !== id);
        });
      }, () => {});
    };
    const listener = (message: Command) => {
      if (message.type === 'taskUpdated' || message.type === 'taskDeleted') refreshTask(message.taskId);
      if (message.type === 'taskDeleted') deleted.current(message.taskId);
    };
    refresh();
    const stopLocal = onLocalTaskChange(refreshTask);
    chrome.runtime.onMessage.addListener(listener);
    const timer = setInterval(refresh, 15_000);
    return () => { live = false; stopLocal(); chrome.runtime.onMessage.removeListener(listener); clearInterval(timer); };
  }, []);
  return [tasks, setTasks] as const;
}

/** Web access permission for the current policy, and the tabs a new conversation may start from. */
export function usePageAccess() {
  const [webPolicy, setWebPolicy] = useState(normalizeWebPolicy());
  const [authorized, setAuthorized] = useState(false);
  const [availableTabs, setAvailableTabs] = useState<chrome.tabs.Tab[]>([]);
  const [contextTabId, setContextTabId] = useState('');
  // Only the latest of overlapping refreshes applies its result.
  const accessRun = useRef(0); const tabsRun = useRef(0);
  async function refreshAccess() {
    const run = ++accessRun.current;
    const policy = await loadWebPolicy();
    const origins = policyPermissionPatterns(policy);
    const granted = !origins.length || await chrome.permissions.contains({ origins });
    if (run !== accessRun.current) return;
    setWebPolicy(policy); setAuthorized(granted);
  }
  async function refreshTabs() {
    const run = ++tabsRun.current;
    const policy = await loadWebPolicy();
    const tabs = await chrome.tabs.query({ currentWindow: true });
    if (run !== tabsRun.current) return;
    const allowed = tabs.filter(tab => { try { validatePageUrl(tab.url ?? '', policy); return true; } catch { return false; } });
    setAvailableTabs(allowed);
    setContextTabId(current => !current || allowed.some(tab => String(tab.id) === current) ? current : '');
  }
  useEffect(() => {
    void refreshAccess(); void refreshTabs();
    const settingsListener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes.settings) { void refreshAccess(); void refreshTabs(); }
    };
    const permissionListener = () => { void refreshAccess(); };
    chrome.storage.onChanged.addListener(settingsListener);
    chrome.permissions.onAdded.addListener(permissionListener);
    chrome.permissions.onRemoved.addListener(permissionListener);
    return () => {
      chrome.storage.onChanged.removeListener(settingsListener);
      chrome.permissions.onAdded.removeListener(permissionListener);
      chrome.permissions.onRemoved.removeListener(permissionListener);
    };
  }, []);
  /** Ask for the policy's origins; resolves to whether access was granted. */
  async function requestAccess() {
    const origins = policyPermissionPatterns(webPolicy);
    const granted = !origins.length || await chrome.permissions.request({ origins });
    // Supersedes any check still under way.
    accessRun.current++; setAuthorized(granted); return granted;
  }
  return { authorized, requestAccess, availableTabs, refreshTabs, contextTabId, setContextTabId };
}
