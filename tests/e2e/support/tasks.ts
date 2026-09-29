import { expect, type Page } from '@playwright/test';
import type { BrowserAction, BrowserResult, RpcResult, Task } from '../../../src/shared/types';
import type { Harness } from './harness';

export async function start(page: Page, goal: string) {
  await page.getByLabel('消息', { exact: true }).fill(goal);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByTestId('task-status')).toBeVisible();
}

export async function readTasks(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open('bwai'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    return new Promise<Task[]>(resolve => { const req = db.transaction('tasks').objectStore('tasks').getAll(); req.onsuccess = () => { resolve(req.result); db.close(); }; });
  });
}

export async function deletedRecords(page: Page, taskId: string) {
  return page.evaluate(async id => {
    const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open('bwai'); req.onsuccess = () => resolve(req.result); });
    const records = await Promise.all(['tasks', 'operations', 'checkpoints', 'writes'].map(name => new Promise<number>(resolve => {
      const request = db.transaction(name).objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result.filter(row => name === 'tasks' ? row.id === id : name === 'operations' ? row.taskId === id : row.thread === id || row.thread.startsWith(`${id}:turn:`)).length);
    })));
    db.close(); return records;
  }, taskId);
}

export async function seedRunningTask(page: Page) {
  const task: Task = { id: crypto.randomUUID(), goal: '工具边界测试', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resultText: '', elapsedMs: 0, };
  await page.evaluate(async task => {
    const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open('bwai'); req.onsuccess = () => resolve(req.result); });
    await new Promise<void>(resolve => { const tx = db.transaction('tasks', 'readwrite'); tx.objectStore('tasks').put(task); tx.oncomplete = () => { db.close(); resolve(); }; });
  }, task);
  return task;
}

export async function tool(page: Page, taskId: string, action: BrowserAction | Record<string, unknown>, requestId = crypto.randomUUID()): Promise<RpcResult> {
  return page.evaluate(args => chrome.runtime.sendMessage({ type: 'tool', search: 'bing', ...args }), { taskId, action, requestId });
}

export async function queryFixture(page: Page, taskId: string, observation: BrowserResult, query: string): Promise<BrowserResult> {
  const input = observation.snapshot!.elements.find(ref => ref.kind === 'input')!;
  const filled = (await tool(page, taskId, { name: 'fill', tabId: observation.tabId!, snapshotId: observation.snapshot!.snapshotId, elementId: input.id, value: query, effect: 'read' })).result!;
  const submit = filled.snapshot!.elements.find(ref => ref.kind === 'button')!;
  return (await tool(page, taskId, { name: 'click', tabId: filled.tabId!, snapshotId: filled.snapshot!.snapshotId, elementId: submit.id, effect: 'read' })).result!;
}

export async function startFormTask(h: Harness) {
  const form = await h.context.newPage(); await form.goto('https://form-fixture.example/editor');
  await h.page.getByText('附加网页', { exact: true }).click();
  await h.page.getByLabel('起始网页').selectOption({ label: '编辑表单' });
  await expect(h.page.locator('.attach-page')).toHaveText('编辑表单');
  await start(h.page, '在当前页面填写并提交表单，提交前让我确认');
  await expect(h.page.getByTestId('task-status')).toHaveText('等待确认', { timeout: 45_000 });
  return form;
}

export const submittedTitles = (page: Page) => page.evaluate(() => (window as unknown as { submittedTitles: string[] }).submittedTitles);

export async function configureTokenLimit(h: Harness, thousands?: number) {
  const opened = h.context.waitForEvent('page'); await h.page.getByRole('button', { name: '设置', exact: true }).click(); const settings = await opened;
  await settings.getByLabel('限制每轮 token 用量').setChecked(thousands !== undefined);
  if (thousands !== undefined) await settings.getByLabel('Token 上限（千）', { exact: true }).fill(String(thousands));
  await settings.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(settings.getByRole('status')).toContainText('设置已保存'); await settings.close();
}
