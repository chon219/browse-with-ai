import { afterEach, expect, it, vi } from 'vitest';
import { waitForPage } from '../../src/background/navigation';
import { PAGE_WAIT } from '../../src/shared/tuning';

vi.mock('../../src/storage/settings', () => ({ loadWebPolicy: async () => undefined }));
afterEach(() => vi.useRealTimers());

function browser() {
  const get = vi.fn().mockResolvedValue({ status: 'loading', url: 'https://example.com/' });
  const executeScript = vi.fn().mockResolvedValue([{ frameId: 0, result: { url: 'https://example.com/', ready: true } }]);
  const removeListener = vi.fn();
  vi.stubGlobal('chrome', { tabs: { get, onUpdated: { addListener: vi.fn(), removeListener } }, scripting: { executeScript } });
  return { get, executeScript, removeListener };
}

it('continues with a parsed document while the tab still loads resources', async () => {
  const { executeScript, removeListener } = browser();
  await waitForPage(1, async () => {});
  expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ injectImmediately: true, target: { tabId: 1 } }));
  expect(removeListener).toHaveBeenCalledOnce();
});

it('does not accept the old document during navigation', async () => {
  vi.useFakeTimers();
  const { get, executeScript } = browser();
  get.mockResolvedValueOnce({ status: 'loading', url: 'https://example.com/old', pendingUrl: 'https://example.com/' });
  const waiting = waitForPage(1, async () => {});
  await vi.advanceTimersByTimeAsync(0);
  expect(executeScript).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(PAGE_WAIT.recheckMs);
  await waiting;
});

it('retries when the document changes during the readiness probe', async () => {
  vi.useFakeTimers();
  const { executeScript } = browser();
  executeScript.mockResolvedValueOnce([{ frameId: 0, result: { url: 'https://example.com/old', ready: true } }]);
  const waiting = waitForPage(1, async () => {});
  await vi.advanceTimersByTimeAsync(PAGE_WAIT.recheckMs);
  await waiting;
  expect(executeScript).toHaveBeenCalledTimes(2);
});

it('still times out when no document becomes ready and removes its listener', async () => {
  vi.useFakeTimers();
  const { executeScript, removeListener } = browser();
  executeScript.mockResolvedValue([{ frameId: 0, result: { url: 'https://example.com/', ready: false } }]);
  const result = expect(waitForPage(1, async () => {})).rejects.toThrow('页面加载超时');
  await vi.advanceTimersByTimeAsync(PAGE_WAIT.loadMs);
  await result;
  expect(removeListener).toHaveBeenCalledOnce();
});

it('honors cancellation after probing the page', async () => {
  const { removeListener } = browser();
  const assertRunning = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('cancelled'));
  await expect(waitForPage(1, assertRunning)).rejects.toThrow('cancelled');
  expect(removeListener).toHaveBeenCalledOnce();
});
