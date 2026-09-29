import { composeSnapshot, type ObservedFrame, type PageTargets } from './page-snapshot';
import { getLocale, LocalizedError, msg } from '../i18n';
import type { BrowserAction, BrowserResult, Confirmation } from '../shared/types';
import type { PageObservation } from '../shared/page';
import { pagePermissionPattern, validatePageUrl, type WebPolicy } from '../shared/web-policy';
import { workspaceAction } from '../storage/db';

type PageReply = BrowserResult & Partial<PageObservation> & { navigate?: string; settle?: boolean; refresh?: boolean; confirmation?: Confirmation };
const key = (tabId: number) => `pageTargets:${tabId}`;

async function allowed(url: string, policy: WebPolicy) {
  try {
    validatePageUrl(url, policy);
    return await chrome.permissions.contains({ origins: [pagePermissionPattern(url)] });
  } catch { return false; }
}

/** All frames are independently URL/permission checked. Frame document IDs and
 * their original snapshots survive worker restarts in session storage; the
 * content script still verifies actual node identity and form state on action. */
async function readPage(tabId: number, taskId: string, policy: WebPolicy, assertRunning: () => Promise<void>, frameId = 0, elementOffset = 0): Promise<PageReply> {
  await assertRunning();
  const injected = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'], injectImmediately: true });
  const observed = await Promise.all(injected.map(async target => {
    try {
      const reply = await chrome.tabs.sendMessage(tabId, { type: 'pageTool', action: { name: 'read', tabId, elementOffset: target.frameId === frameId ? elementOffset : 0 }, policy, locale: getLocale() }, { frameId: target.frameId, documentId: target.documentId }) as PageReply;
      if (!reply.snapshot || !reply.metadata || !await allowed(reply.snapshot.url, policy)) return undefined;
      return { frameId: target.frameId, documentId: target.documentId, snapshot: reply.snapshot, metadata: reply.metadata } satisfies ObservedFrame;
    } catch { return undefined; }
  }));
  const frames = observed.filter(frame => frame !== undefined);
  const top = frames.find(frame => frame.frameId === 0);
  if (!top) throw new LocalizedError('bg.scriptingBlocked');
  await assertRunning();
  if ((await chrome.tabs.get(tabId)).url !== top.snapshot.url) throw new LocalizedError('page.snapshotStale');
  if (!frames.some(frame => frame.frameId === frameId)) throw new LocalizedError('page.snapshotStale');
  const composed = composeSnapshot(frames, JSON.stringify(policy), frameId);
  await chrome.storage.session.set({ [key(tabId)]: composed.targets });
  const snapshot = composed.snapshot;
  if (composed.evidenceText) {
    // Keep the collected evidence retrievable after older observations shrink.
    // IDs in saved files are historical; only current snapshot references work.
    const content = `URL: ${snapshot.url}\nTitle: ${snapshot.title}\n\n${composed.evidenceText}`;
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const sourceFile = `pages/${digest.slice(0, 32)}.md`;
    try { await workspaceAction(taskId, { name: 'write_file', path: sourceFile, content }); snapshot.sourceFile = sourceFile; }
    catch { return { snapshot, tabId, note: msg('bg.pageEvidenceNotSaved') }; }
  }
  return { snapshot, tabId };
}

export async function executePageTool(tabId: number, taskId: string, action: BrowserAction, policy: WebPolicy, approved: boolean, assertRunning: () => Promise<void>): Promise<PageReply> {
  if (action.name === 'read') return readPage(tabId, taskId, policy, assertRunning, action.frameId, action.elementOffset);
  const saved = (await chrome.storage.session.get(key(tabId)))[key(tabId)] as PageTargets | undefined;
  let localAction: BrowserAction = action;
  let destination: chrome.tabs.MessageSendOptions = { frameId: 0 };
  if ('snapshotId' in action) {
    if (!saved || saved.snapshotId !== action.snapshotId || saved.policy !== JSON.stringify(policy) || saved.url !== (await chrome.tabs.get(tabId)).url) throw new LocalizedError('page.snapshotStale');
    const target = 'elementId' in action ? saved.elements[action.elementId] : undefined;
    if (!target || !await allowed(target.url, policy)) throw new LocalizedError('page.snapshotStale');
    localAction = { ...action, snapshotId: target.snapshotId, elementId: target.localId } as BrowserAction;
    destination = { frameId: target.frameId, documentId: target.documentId };
  }
  await assertRunning();
  if (action.name === 'scroll') await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'], injectImmediately: true });
  const reply = await chrome.tabs.sendMessage(tabId, { type: 'pageTool', action: localAction, approved, policy, locale: getLocale() }, destination) as PageReply;
  if (reply.element && action.name === 'read_element') reply.element = { ...reply.element, elementId: action.elementId, snapshotId: action.snapshotId };
  if (reply.snapshot || reply.refresh) return readPage(tabId, taskId, policy, assertRunning);
  const { metadata: _private, ...result } = reply;
  return { ...result, tabId };
}

export async function forgetPageTargets(tabId: number) { await chrome.storage.session.remove(key(tabId)); }
