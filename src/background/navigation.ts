import { loadWebPolicy } from '../storage/settings';
import { validatePageUrl } from '../shared/web-policy';
import { PAGE_WAIT } from '../shared/tuning';
import { LocalizedError } from '../i18n';

/**
 * Watch a tab for updates from now on. `next(ms, starts)` resolves true on the first update seen since the last call
 * (only a navigation starting, when `starts`), or false after `ms` without one; `stop` releases the listener.
 */
export function watchTab(tabId: number) {
  let seen = false; let started = false; let wake: (() => void) | undefined;
  const listener = (id: number, change: chrome.tabs.OnUpdatedInfo) => {
    if (id !== tabId) return;
    seen = true; if (change.status === 'loading' || change.url) started = true; wake?.();
  };
  chrome.tabs.onUpdated.addListener(listener);
  const next = (ms: number, starts = false) => new Promise<boolean>(resolve => {
    const done = () => (starts ? started : seen);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: boolean) => { clearTimeout(timer); wake = undefined; seen = false; resolve(value); };
    if (done()) { finish(true); return; }
    timer = setTimeout(() => finish(false), ms);
    wake = () => { if (done()) finish(true); };
  });
  return { next, stop: () => chrome.tabs.onUpdated.removeListener(listener) };
}
/** Wait for a parsed document, not images, ads or other resources that can keep
 * the tab loading indefinitely. Recheck navigation and cancellation throughout. */
export async function waitForPage(tabId: number, assertRunning: () => Promise<void>) {
  const deadline = Date.now() + PAGE_WAIT.loadMs; const watch = watchTab(tabId);
  try {
    while (Date.now() < deadline) {
      await assertRunning();
      const tab = await chrome.tabs.get(tabId);
      if (tab.url && tab.url !== 'about:blank' && (!tab.pendingUrl || tab.pendingUrl === tab.url)) {
        validatePageUrl(tab.url, await loadWebPolicy());
        if (tab.status === 'complete') return;
        // Default script injection waits for document_idle, which would put the
        // same load dependency back into this readiness check.
        const documents = await chrome.scripting.executeScript({ target: { tabId }, injectImmediately: true,
          func: () => ({ url: location.href, ready: document.readyState !== 'loading' }),
        }).catch(() => []); // A navigation can replace the document during injection.
        await assertRunning();
        const current = await chrome.tabs.get(tabId);
        if ((!current.pendingUrl || current.pendingUrl === current.url) && documents.some(frame => frame.frameId === 0 && frame.result?.ready && frame.result.url === current.url)) {
          validatePageUrl(current.url!, await loadWebPolicy());
          return;
        }
      }
      await watch.next(Math.min(PAGE_WAIT.recheckMs, Math.max(0, deadline - Date.now())));
    }
  } finally { watch.stop(); }
  throw new LocalizedError('bg.pageTimeout');
}
/** After back or a click, give the tab up to `ms` to start navigating, then wait for whatever page it shows; a page that stays put is read promptly. */
export async function settle(watch: ReturnType<typeof watchTab>, ms: number, tabId: number, assertRunning: () => Promise<void>) {
  try { await watch.next(ms, true); } finally { watch.stop(); }
  await waitForPage(tabId, assertRunning);
}
