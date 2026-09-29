import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { harness } from './support/harness';
import { start, readTasks } from './support/tasks';

async function composerInViewport(page: Page) {
  const input = page.locator('.chat-composer textarea');
  await expect(input).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => ({
    wide: document.documentElement.scrollWidth > innerWidth,
    tall: document.documentElement.scrollHeight > innerHeight,
  }))).toEqual({ wide: false, tall: false });
}

test('conversation keeps the composer visible across desktop, narrow task pages and side panels', async () => {
  const h = await harness();
  try {
    await h.page.setViewportSize({ width: 1280, height: 720 });
    await composerInViewport(h.page);
    await h.page.screenshot({ path: path.join(h.dir, 'desktop-new.png') });
    h.hold.active = true;
    await start(h.page, '查找产品说明并整理重点');
    await expect.poll(() => h.hold.reached).toBe(true);
    await composerInViewport(h.page);
    for (const width of [380, 320]) {
      await h.page.setViewportSize({ width, height: 568 });
      await expect(h.page.getByRole('button', { name: '暂停', exact: true })).toBeInViewport({ ratio: 1 });
      await expect(h.page.getByRole('button', { name: '取消任务', exact: true })).toBeInViewport({ ratio: 1 });
      await composerInViewport(h.page);
    }
    await h.page.screenshot({ path: path.join(h.dir, 'narrow-running.png') });
    await h.page.setViewportSize({ width: 1280, height: 720 });
    h.hold.active = false;
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成');
    await composerInViewport(h.page);
    await expect(h.page.getByTestId('token-usage').locator('.stat').first()).toBeInViewport();
    await expect(h.page.locator('.chat-activity > summary').first()).toContainText('查看执行过程');
    await expect(h.page.getByRole('button', { name: '提炼为技能', exact: true })).toBeVisible();
    await h.page.screenshot({ path: path.join(h.dir, 'desktop-result.png') });
    for (const width of [760, 380, 320]) {
      await h.page.setViewportSize({ width, height: 568 });
      await composerInViewport(h.page);
      await expect(h.page.getByRole('complementary')).toBeHidden();
      await h.page.getByRole('button', { name: '对话记录', exact: true }).click();
      await expect(h.page.getByRole('complementary')).toBeVisible();
      await h.page.keyboard.press('Escape');
      await expect(h.page.getByRole('button', { name: '对话记录', exact: true })).toBeFocused();
      await h.page.locator('.visited > summary').click();
      await composerInViewport(h.page);
      await h.page.locator('.visited > summary').click();
    }
    const panel = await h.context.newPage();
    await panel.setViewportSize({ width: 380, height: 760 });
    await panel.goto(`chrome-extension://${h.id}/sidepanel.html`);
    await expect(panel.locator('.header-actions').getByRole('button', { name: '技能库', exact: true })).toBeInViewport({ ratio: 1 });
    await panel.getByRole('button', { name: '技能库', exact: true }).click();
    await expect(panel.getByRole('dialog', { name: '技能库', exact: true })).toBeVisible();
    await panel.keyboard.press('Escape');
    await panel.getByRole('button', { name: '对话记录', exact: true }).click();
    await panel.locator('.history-item').first().click();
    await composerInViewport(panel);
    await expect(panel.getByTestId('token-usage').locator('.stat').first()).toBeInViewport();
    // The state and its actions can occupy a second row below the title.
    expect((await panel.locator('.task-header').boundingBox())!.height).toBeLessThan(190);
    await panel.screenshot({ path: path.join(h.dir, 'panel-result.png') });
    await panel.emulateMedia({ colorScheme: 'dark' });
    await panel.screenshot({ path: path.join(h.dir, 'panel-dark.png'), animations: 'disabled' });
    expect(h.errors).toEqual([]);
  } finally { h.hold.active = false; await h.context.close(); }
});

test('page context identifies the selected page and long conversations offer a return to latest', async () => {
  const h = await harness();
  try {
    const fixture = await h.context.newPage();
    await fixture.goto('https://form-fixture.example/editor');
    await expect(h.page.locator('.page-context')).toContainText('由 AI 打开所需网页');
    await h.page.getByRole('button', { name: '填写表单', exact: true }).click();
    await expect(h.page.getByLabel('起始网页')).toBeVisible();
    expect(await readTasks(h.page)).toHaveLength(0);
    await h.page.getByLabel('起始网页').selectOption({ label: '编辑表单' });
    await expect(h.page.locator('.page-context')).toContainText('编辑表单');
    await expect(h.page.locator('.page-context')).toContainText('form-fixture.example');
    await h.page.getByRole('button', { name: '不使用这个网页' }).click();
    await expect(h.page.locator('.page-context')).toContainText('由 AI 打开所需网页');
    await start(h.page, '查找浏览器操作指南');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成');
    const [task] = await readTasks(h.page);
    await h.page.evaluate(async task => {
      const db = await new Promise<IDBDatabase>(resolve => {
        const request = indexedDB.open('bwai'); request.onsuccess = () => resolve(request.result);
      });
      task.messages = Array.from({ length: 40 }, (_, i) => ({
        id: `history-${i}`, role: i % 2 ? 'assistant' as const : 'user' as const,
        kind: 'message' as const, content: `历史消息 ${i}\n用于验证滚动时仍可继续输入。`, at: task.createdAt, turn: 0,
      }));
      await new Promise<void>(resolve => {
        const tx = db.transaction('tasks', 'readwrite'); tx.objectStore('tasks').put(task);
        tx.oncomplete = () => { db.close(); resolve(); };
      });
    }, task);
    await h.page.reload();
    const log = h.page.getByRole('log');
    await expect(log).toContainText('历史消息 39');
    await log.evaluate(el => { el.scrollTop = 0; });
    await h.page.getByRole('button', { name: '回到最新消息' }).click();
    await expect.poll(() => log.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(5);
    await composerInViewport(h.page);
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});
