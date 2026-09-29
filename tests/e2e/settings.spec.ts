import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { harness } from './support/harness';
import { start } from './support/tasks';

test('the side panel opens settings in place, keeps a draft when going back, and saves', async () => {
  const h = await harness();
  try {
    const panel = await h.context.newPage(); await panel.setViewportSize({ width: 400, height: 900 });
    await panel.goto(`chrome-extension://${h.id}/sidepanel.html`);
    const pages = h.context.pages().length;
    const settingsButton = panel.getByRole('button', { name: '设置', exact: true });
    await settingsButton.click();
    const settings = panel.getByTestId('settings');
    await expect(settings.getByRole('heading', { name: '设置', level: 1 })).toBeVisible();
    await expect(settingsButton).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByLabel('消息', { exact: true })).toBeHidden();
    expect(h.context.pages()).toHaveLength(pages);
    await expect(settings.getByLabel('搜索引擎', { exact: true })).toHaveValue('bing');
    // Going back keeps an unsaved edit; opening settings again shows it.
    await settings.getByLabel('模型名称').fill('draft-model');
    await expect(settings.getByText('有未保存的修改')).toBeVisible();
    await settings.getByRole('button', { name: '← 返回' }).click();
    await expect(settings).toBeHidden(); await expect(panel.getByLabel('消息', { exact: true })).toBeVisible();
    await settingsButton.click();
    await expect(settings.getByLabel('模型名称')).toHaveValue('draft-model');
    await settings.getByLabel('模型名称').fill('fixture-model');
    await settings.getByLabel('搜索引擎', { exact: true }).selectOption('duckduckgo');
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(settings.getByRole('status')).toContainText('设置已保存');
    expect(await panel.evaluate(async () => ((await chrome.storage.local.get('settings')).settings as { search: string }).search)).toBe('duckduckgo');
    // The settings button toggles back to the conversation.
    await settingsButton.click(); await expect(settings).toBeHidden();
    await expect(settingsButton).toHaveAttribute('aria-pressed', 'false');
    expect(h.context.pages()).toHaveLength(pages);
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});

test('debug defaults off, can be enabled, exports internal details and can be disabled and cleared', async () => {
  const h = await harness();
  try {
    await start(h.page, '查找浏览器操作指南，打开页面并查看下一页');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 60_000 });
    const settings = await h.context.newPage(); await settings.goto(`chrome-extension://${h.id}/settings.html`);
    await expect(settings.getByLabel('开启 Debug 日志')).not.toBeChecked();
    expect(await settings.evaluate(async () => (await indexedDB.databases()).some(db => db.name === 'bwai-debug'))).toBe(false);
    await settings.getByLabel('开启 Debug 日志').check();
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(settings.getByRole('status')).toContainText('设置已保存');
    await settings.reload();
    await expect(settings.getByLabel('开启 Debug 日志')).toBeChecked();
    await h.page.locator('.new-conversation-button').click();
    await start(h.page, '查找浏览器操作指南并记录调试日志');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 60_000 });
    const records = () => settings.evaluate(() => new Promise<{ event: string; taskId: string; runId: string }[]>((resolve, reject) => {
      const open = indexedDB.open('bwai-debug', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result; const request = db.transaction('events').objectStore('events').getAll();
        request.onsuccess = () => { resolve(request.result); db.close(); };
        request.onerror = () => { reject(request.error); db.close(); };
      };
    }));
    await expect.poll(async () => (await records()).some(r => r.event === 'runner.stop')).toBe(true);
    await settings.reload();
    const entries = await records();
    expect(entries.map(r => r.event)).toEqual(expect.arrayContaining(['agent.decide.start', 'model.request.start', 'model.request.result', 'tool.execute.start', 'tool.execute.result', 'runner.checkpoint.saved']));
    expect(entries.every(r => r.taskId && r.runId)).toBe(true);
    const download = settings.waitForEvent('download'); await settings.getByRole('button', { name: '导出调试日志' }).click();
    const file = await download; const exported = JSON.parse(await readFile((await file.path())!, 'utf8'));
    expect(exported.format).toBe('bwai-debug-v1'); expect(exported.entries.length).toBe(entries.length);
    expect(JSON.stringify(exported)).toContain('tool_calls');
    expect(JSON.stringify(exported)).not.toContain('fixture-secret');
    await settings.getByLabel('开启 Debug 日志').uncheck();
    await expect(settings.getByText('有未保存的修改', { exact: true })).toBeVisible();
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(settings.getByRole('status')).toContainText('设置已保存');
    await settings.reload(); await expect(settings.getByLabel('开启 Debug 日志')).not.toBeChecked();
    await settings.getByRole('button', { name: '清空调试日志' }).click();
    await expect.poll(async () => (await records()).length).toBe(0);
    await h.page.locator('.new-conversation-button').click();
    await start(h.page, '再次查找浏览器操作指南');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 60_000 });
    expect(await records()).toEqual([]);
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});

test('settings opens separately, persists provider selection and leaves the task page intact', async () => {
  const h = await harness();
  try {
    const taskUrl = h.page.url();
    const next = h.context.waitForEvent('page'); await h.page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = await next; await settings.waitForURL(`chrome-extension://${h.id}/settings.html`);
    expect(h.page.url()).toBe(taskUrl); await expect(h.page.getByLabel('API Base URL')).toHaveCount(0);
    await expect(settings.getByLabel('搜索引擎', { exact: true })).toHaveValue('bing');
    expect(await settings.getByLabel('搜索引擎', { exact: true }).locator('option').allTextContents()).toEqual(['跟随浏览器', 'Google', 'Bing', '百度', 'DuckDuckGo', 'Brave Search', 'Startpage', 'Yahoo', 'Yandex']);
    await expect(settings.getByText('所有修改已保存', { exact: true })).toBeVisible();
    await settings.getByLabel('搜索引擎', { exact: true }).selectOption('duckduckgo');
    await expect(settings.getByText('有未保存的修改', { exact: true })).toBeVisible();
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(settings.getByRole('status')).toContainText('设置已保存');
    await expect(settings.getByText('所有修改已保存', { exact: true })).toBeVisible();
    await settings.reload(); await expect(settings.getByLabel('搜索引擎', { exact: true })).toHaveValue('duckduckgo');
    await expect(settings.getByLabel('模型名称')).toHaveValue('fixture-model');
    await h.page.getByRole('button', { name: '设置', exact: true }).click();
    await expect.poll(() => h.context.pages().filter(p => p.url() === `chrome-extension://${h.id}/settings.html`).length).toBe(1);
    await settings.screenshot({ path: path.join(h.dir, 'settings-page.png'), fullPage: true });
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});

test('switching the interface language applies to open pages immediately and persists', async () => {
  const h = await harness();
  try {
    const next = h.context.waitForEvent('page'); await h.page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = await next; await settings.waitForURL(`chrome-extension://${h.id}/settings.html`);
    await expect(settings.getByLabel('语言', { exact: true })).toHaveValue('auto');
    await settings.getByLabel('语言', { exact: true }).selectOption('en');
    await expect(settings.getByRole('button', { name: 'Save settings', exact: true })).toBeVisible();
    await expect(settings).toHaveTitle('BWAI · Settings'); expect(await settings.locator('html').getAttribute('lang')).toBe('en');
    expect(await settings.getByLabel('Search engine', { exact: true }).locator('option').first().textContent()).toBe('Browser default');
    await expect(h.page.getByRole('button', { name: 'New conversation', exact: true })).toBeVisible();
    await expect(h.page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await h.page.reload(); await expect(h.page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    await settings.getByLabel('Language', { exact: true }).selectOption('auto');
    await expect(h.page.getByRole('button', { name: '新建对话', exact: true })).toBeVisible();
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});
