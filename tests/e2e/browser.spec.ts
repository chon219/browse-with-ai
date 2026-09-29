import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RpcResult } from '../../src/shared/types';
import { display } from '../../src/i18n';
import { harness } from './support/harness';
import { start, readTasks, seedRunningTask, tool, queryFixture, startFormTask, submittedTitles } from './support/tasks';

test('tabs the agent opens are grouped per conversation and are closed at the end only when the setting is on', async () => {
  const h = await harness();
  // A group disappears with its last tab, possibly between these two queries while tabs are closing.
  const agentTabs = () => h.page.evaluate(async () => {
    const tabs = (await chrome.tabs.query({})).filter(tab => /bing\.com|pages-fixture\.example/.test(tab.url ?? ''));
    return Promise.all(tabs.map(async tab => ({ url: tab.url!, group: tab.groupId === -1 ? undefined : (await chrome.tabGroups.get(tab.groupId).catch(() => undefined))?.title })));
  });
  try {
    await start(h.page, '查找浏览器操作指南');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 60_000 });
    const opened = await agentTabs();
    expect(opened.length).toBeGreaterThan(0);
    // The model named the conversation; the list and header show the name, and the group is named after it.
    expect(new Set(opened.map(tab => tab.group))).toEqual(new Set(['BWAI · 浏览器指南']));
    await expect(h.page.locator('.task-header h2')).toHaveText('浏览器指南');
    await expect(h.page.locator('.history-item span').first()).toHaveText('浏览器指南');
    // Off by default: the pages stay open after the task ends.
    await h.page.waitForTimeout(500); expect(await agentTabs()).toHaveLength(opened.length);

    const settingsPage = await h.context.newPage(); await settingsPage.goto(`chrome-extension://${h.id}/settings.html`);
    const option = settingsPage.getByLabel('任务结束后关闭 Agent 打开的标签页');
    await expect(option).not.toBeChecked(); await option.check();
    await settingsPage.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(settingsPage.getByRole('status')).toContainText('设置已保存');
    await settingsPage.close(); await h.page.bringToFront();

    await h.page.getByRole('button', { name: '新建对话', exact: true }).click();
    await start(h.page, '再查一次浏览器操作指南');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 60_000 });
    // Only the finished conversation's own tabs close; the first conversation's stay.
    await expect.poll(agentTabs).toEqual(opened);
    // Deleting a conversation closes its tabs too while the setting is on.
    await h.page.locator('.history-row').filter({ hasText: /^浏览器指南/ }).getByRole('button', { name: '删除对话', exact: true }).click();
    await expect(h.page.getByRole('dialog').locator('.delete-goal')).toHaveText('浏览器指南');
    await h.page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
    await expect.poll(agentTabs).toEqual([]);
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});

test('MV3 executes a search and navigation task and exports the conversation without a development server', async () => {
  const h = await harness();
  try {
    await start(h.page, '查找浏览器操作指南，打开页面并查看下一页');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 60_000 });
    await expect(h.page.getByTestId('task-result')).toContainText('已打开操作指南并查看下一页');
    const tasks = await readTasks(h.page); expect(tasks[0].visitedUrls).toEqual(expect.arrayContaining(['https://pages-fixture.example/page-1', 'https://pages-fixture.example/page-2']));
    expect(new Set(tasks[0].visitedUrls).size).toBe(tasks[0].visitedUrls!.length);
    const download = h.page.waitForEvent('download'); await h.page.getByRole('button', { name: '导出 Markdown' }).click();
    expect((await download).suggestedFilename()).toMatch(/\.md$/);
    expect(h.requests.some(r => r.includes('恶意测试内容'))).toBe(true);
    expect(h.requests.every(r => !r.includes('fixture-secret'))).toBe(true);
    const worker = h.context.serviceWorkers()[0];
    const userTab = await h.context.newPage(); await userTab.goto('https://pages-fixture.example/user-page');
    const forbidden = await h.page.evaluate(async taskId => {
      const tabs = await chrome.tabs.query({ url: 'https://pages-fixture.example/user-page' });
      return chrome.runtime.sendMessage({ type: 'tool', taskId, requestId: crypto.randomUUID(), search: 'bing', action: { name: 'read', tabId: tabs[0].id } });
    }, tasks[0].id);
    expect(JSON.stringify(forbidden)).toContain('停止');
    expect(worker).toBeTruthy(); expect(h.errors).toEqual([]);
    await h.page.screenshot({ path: path.join(h.dir, 'browser-complete.png'), fullPage: true });
  } finally { h.hold.active = false; await h.context.close(); }
});

test('browser tools enforce ownership, stale snapshots and uncertain operation recovery while returning verification pages', async () => {
  const h = await harness();
  try {
    const task = await seedRunningTask(h.page);
    const foreign = await h.context.newPage(); await foreign.goto('https://pages-fixture.example/user-page');
    const foreignTabId = await h.page.evaluate(async () => (await chrome.tabs.query({ url: 'https://pages-fixture.example/user-page' }))[0].id!);
    expect(display((await tool(h.page, task.id, { name: 'read', tabId: foreignTabId })).result?.error)).toContain('本任务');
    expect((await tool(h.page, task.id, { name: 'evaluate', script: 'chrome.storage.local.get()' })).ok).toBe(false);
    expect(display((await tool(h.page, task.id, { name: 'open', url: 'javascript:alert(1)' })).result?.error)).toContain('协议');
    const opened = (await tool(h.page, task.id, { name: 'open', url: 'https://pages-fixture.example/page-1' })).result!;
    expect(opened.snapshot?.text).toContain('恶意测试内容');
    // Agent tabs open in the background, and switching to one reads it without bringing it to the front.
    const switched = (await tool(h.page, task.id, { name: 'switch_tab', tabId: opened.tabId! })).result!;
    expect(switched.snapshot?.url).toBe(opened.snapshot?.url);
    expect(await h.page.evaluate(async id => (await chrome.tabs.get(id)).active, opened.tabId!)).toBe(false);
    const source = h.context.pages().find(p => p.url() === opened.snapshot?.url)!;
    // Changing the target itself makes the snapshot stale.
    await source.evaluate(() => { document.querySelector('a')!.setAttribute('href', 'https://pages-fixture.example/page-3'); });
    const target = opened.snapshot!.elements.find(e => e.href?.includes('page-2'))!;
    const stale = await tool(h.page, task.id, { name: 'follow', tabId: opened.tabId!, snapshotId: opened.snapshot!.snapshotId, elementId: target.id });
    expect(display(stale.result?.error)).toContain('过期');
    const fresh = (await tool(h.page, task.id, { name: 'read', tabId: opened.tabId! })).result!;
    const expand = fresh.snapshot!.elements.find(e => e.tag === 'summary')!;
    // Unrelated page changes, such as ads or lazy-loaded content, do not.
    await source.evaluate(() => { document.body.appendChild(document.createElement('div')); document.title = 'updated'; });
    const expanded = await tool(h.page, task.id, { name: 'click', tabId: opened.tabId!, snapshotId: fresh.snapshot!.snapshotId, elementId: expand.id });
    expect(expanded.result?.snapshot?.text).toBeTruthy();
    expect(await source.locator('details').getAttribute('open')).not.toBeNull();
    await source.evaluate(() => { document.body.innerHTML = '<h1>Verify you are human</h1>'; });
    const verification = await tool(h.page, task.id, { name: 'read', tabId: opened.tabId! });
    expect(verification.result?.blocked).toBeUndefined();
    expect(verification.result?.snapshot?.text).toContain('Verify you are human');

    const uncertainId = crypto.randomUUID();
    await h.page.evaluate(async ({ taskId, id }) => {
      const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open('bwai'); req.onsuccess = () => resolve(req.result); });
      await new Promise<void>(resolve => { const tx = db.transaction('operations', 'readwrite'); tx.objectStore('operations').put({ id, taskId, action: { name: 'open', url: 'https://pages-fixture.example/unknown' }, phase: 'pending', startedAt: new Date().toISOString() }); tx.oncomplete = () => { db.close(); resolve(); }; });
    }, { taskId: task.id, id: uncertainId });
    const before = h.context.pages().length;
    const unknown = await tool(h.page, task.id, { name: 'open', url: 'https://pages-fixture.example/unknown' }, uncertainId);
    expect(display(unknown.result?.error)).toContain('结果未知'); expect(h.context.pages()).toHaveLength(before);
    await h.page.evaluate(async taskId => {
      const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open('bwai'); req.onsuccess = () => resolve(req.result); });
      await new Promise<void>(resolve => { const tx = db.transaction('tasks', 'readwrite'); const req = tx.objectStore('tasks').get(taskId); req.onsuccess = () => tx.objectStore('tasks').put({ ...req.result, limits: { pages: 1, steps: 60, minutes: 15, kTokens: 500 } }); tx.oncomplete = () => { db.close(); resolve(); }; });
    }, task.id);
    // Old saved quotas do not prevent useful navigation.
    expect((await tool(h.page, task.id, { name: 'open', url: 'https://pages-fixture.example/page-3' })).result?.snapshot?.url).toContain('page-3');
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});

test('live public website can be read by the installed extension', async () => {
  test.skip(process.env.BWAI_LIVE_BROWSER !== '1', 'Set BWAI_LIVE_BROWSER=1 to use the public internet.');
  const h = await harness();
  try {
    const task = await seedRunningTask(h.page);
    const result = await tool(h.page, task.id, { name: 'open', url: 'https://example.com/' });
    expect(result.result?.snapshot?.title).toContain('Example Domain');
    expect(result.result?.snapshot?.text).toContain('documentation');
  } finally { await h.context.close(); }
});

test('missing website permissions blocks navigation before creating a target tab', async () => {
  const h = await harness(false);
  try {
    await expect(h.page.getByRole('button', { name: '启用网页访问' })).toBeVisible();
    const task = await seedRunningTask(h.page); const before = h.context.pages().length;
    const result = await tool(h.page, task.id, { name: 'open', url: 'https://pages-fixture.example/page-1' });
    expect(display(result.result?.blocked)).toContain('权限未授予');
    expect(h.context.pages()).toHaveLength(before);
  } finally { await h.context.close(); }
});

test('agent uses the site search form and returns its result', async () => {
  const h = await harness(); const urls: string[] = [];
  try {
    h.context.on('request', req => urls.push(req.url()));
    await start(h.page, '去 catalog-fixture.example 搜索 星际旅行');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 45_000 });
    const resultUrl = urls.find(url => url.includes('catalog-fixture.example/torrents.php?'));
    expect(resultUrl).toBeTruthy(); const params = new URL(resultUrl!).searchParams;
    expect(params.get('search')).toBe('星际旅行'); expect(params.get('search_area')).toBe('title'); expect(params.get('search_mode')).toBe('0');
    expect(urls.some(url => /www\.(bing|google)\.com/.test(url))).toBe(false);
    expect((await readTasks(h.page))[0].visitedUrls).toHaveLength(2);
    await expect(h.page.getByTestId('task-result')).toHaveText('已完成站内搜索。');
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});

test('browser default search uses the native search API in a new owned tab', async () => {
  const h = await harness(true, 'browser');
  try {
    const worker = h.context.serviceWorkers()[0];
    await worker.evaluate(() => {
      const scope = globalThis as unknown as { searchCalls: { text: string; tabId?: number }[] };
      scope.searchCalls = [];
      const api = chrome.search as unknown as { query: (info: { text: string; tabId?: number }) => Promise<void> };
      const query = api.query.bind(api);
      api.query = async info => { scope.searchCalls.push(info); await query(info); };
    });
    const task = await seedRunningTask(h.page); const originalUrl = h.page.url();
    const result = await h.page.evaluate(async taskId => chrome.runtime.sendMessage({ type: 'tool', taskId, requestId: crypto.randomUUID(), search: 'browser', action: { name: 'search', query: 'BWAI 默认搜索' } }), task.id) as RpcResult;
    expect(result.ok).toBe(true); expect(result.result?.snapshot).toBeTruthy();
    expect(result.result?.snapshot?.isSearchResult).toBe(true);
    expect(h.page.url()).toBe(originalUrl);
    const calls = await worker.evaluate(() => (globalThis as unknown as { searchCalls: { text: string; tabId?: number }[] }).searchCalls);
    expect(calls).toEqual([{ text: 'BWAI 默认搜索', tabId: result.result!.tabId }]);
    const reread = await tool(h.page, task.id, { name: 'read', tabId: result.result!.tabId! });
    expect(reread.result?.snapshot?.isSearchResult).toBe(true);
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});

test('local and private pages work by default and policy changes apply to open tabs and links', async () => {
  const h = await harness();
  try {
    await h.context.route(/^http:\/\/(localhost:43123|192\.168\.50\.5:4321|\[::1\]:43123)\//, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><head><meta charset="utf-8"><title>内部工具</title></head><body><h1>内部工具</h1><form action="/find" method="get"><label>搜索<input name="q" type="search"></label><button>搜索</button></form><a href="http://192.168.50.5:4321/dashboard">私网面板</a></body></html>' }));
    const task = await seedRunningTask(h.page);
    const local = (await tool(h.page, task.id, { name: 'open', url: 'http://localhost:43123/' })).result!;
    expect(local.snapshot?.title).toBe('内部工具');
    const query = await queryFixture(h.page, task.id, local, '本机测试');
    expect(new URL(query.snapshot!.url).searchParams.get('q')).toBe('本机测试');
    const link = query.snapshot!.elements.find(e => e.text === '私网面板')!;
    const privatePage = (await tool(h.page, task.id, { name: 'follow', tabId: query.tabId!, snapshotId: query.snapshot!.snapshotId, elementId: link.id })).result!;
    expect(privatePage).toMatchObject({ snapshot: { url: 'http://192.168.50.5:4321/dashboard' } });
    const ipv6 = (await tool(h.page, task.id, { name: 'open', url: 'http://[::1]:43123/' })).result!;
    expect(ipv6).toMatchObject({ snapshot: { title: '内部工具' } });
    const localAgain = (await tool(h.page, task.id, { name: 'open', url: 'http://localhost:43123/' })).result!;
    const next = h.context.waitForEvent('page'); await h.page.getByRole('button', { name: '设置', exact: true }).click(); const settings = await next;
    await expect(settings.getByLabel('允许本机地址')).toBeChecked(); await expect(settings.getByLabel('允许私网地址')).toBeChecked();
    await settings.getByLabel('允许私网地址').uncheck(); await settings.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(settings.getByRole('status')).toContainText('设置已保存');
    expect(display((await tool(h.page, task.id, { name: 'read', tabId: privatePage.tabId! })).result?.error)).toContain('私网');
    const stale = await tool(h.page, task.id, { name: 'fill', tabId: localAgain.tabId!, snapshotId: localAgain.snapshot!.snapshotId, elementId: localAgain.snapshot!.elements.find(ref => ref.kind === 'input')!.id, value: 'new', effect: 'read' });
    expect(display(stale.result?.error)).toContain('策略已变化');
    const refreshed = (await tool(h.page, task.id, { name: 'read', tabId: localAgain.tabId! })).result!;
    expect(refreshed.snapshot?.elements.some(e => e.href?.includes('192.168'))).toBe(false);
    const pageCount = h.context.pages().length;
    expect(display((await tool(h.page, task.id, { name: 'open', url: 'http://192.168.50.5:4321/' })).result?.error)).toContain('私网');
    expect(h.context.pages()).toHaveLength(pageCount);
    await settings.getByLabel('允许本机地址').uncheck(); await settings.getByLabel('禁用的 URL 参数').fill('custom_key'); await settings.getByLabel('禁用的文件后缀').fill('.docx');
    await settings.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(settings.getByRole('status')).toContainText('设置已保存');
    expect(display((await tool(h.page, task.id, { name: 'read', tabId: localAgain.tabId! })).result?.error)).toContain('本机');
    expect(display((await tool(h.page, task.id, { name: 'open', url: 'https://pages-fixture.example/?custom_key=x' })).result?.error)).toContain('参数');
    expect(display((await tool(h.page, task.id, { name: 'open', url: 'https://pages-fixture.example/a.docx' })).result?.error)).toContain('后缀');
    await settings.reload(); await expect(settings.getByLabel('允许私网地址')).not.toBeChecked(); await expect(settings.getByLabel('禁用的文件后缀')).toHaveValue('docx');
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});

test('enforces URL schemes while allowing model-selected cross-origin form submissions', async () => {
  const h = await harness();
  try {
    await h.context.route('https://forms-policy.example/**', route => route.fulfill({ contentType: 'text/html', body: '<html><head><title>Search form</title></head><body><form action="https://pages-fixture.example/find" method="get"><input type="search" name="q" placeholder="Search"><button>Search</button></form></body></html>' }));
    const task = await seedRunningTask(h.page);
    let page = (await tool(h.page, task.id, { name: 'open', url: 'https://forms-policy.example/' })).result!;
    const next = h.context.waitForEvent('page'); await h.page.getByRole('button', { name: '设置', exact: true }).click(); const settings = await next;
    await settings.getByLabel('HTTP', { exact: true }).uncheck();
    await settings.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(settings.getByRole('status')).toContainText('设置已保存');
    expect(display((await tool(h.page, task.id, { name: 'open', url: 'http://pages-fixture.example/' })).result?.error)).toContain('http');
    page = (await tool(h.page, task.id, { name: 'read', tabId: page.tabId! })).result!;
    const result = await queryFixture(h.page, task.id, page, 'cross origin');
    expect(result.snapshot?.url).toContain('https://pages-fixture.example/find?q=cross+origin');
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});

test('file scheme remains opt-in and respects Chrome file access permission', async () => {
  const h = await harness(true, 'bing', true);
  try {
    const filePath = path.join(h.dir, 'local-page.html'); await writeFile(filePath, '<html><head><title>Local file</title></head><body>Local page content</body></html>');
    const url = pathToFileURL(filePath).href; const task = await seedRunningTask(h.page);
    expect(display((await tool(h.page, task.id, { name: 'open', url })).result?.error)).toContain('file');
    const next = h.context.waitForEvent('page'); await h.page.getByRole('button', { name: '设置', exact: true }).click(); const settings = await next;
    await settings.getByLabel('file', { exact: true }).check(); await settings.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(settings.getByRole('status')).toContainText('设置已保存');
    const allowed = await h.page.evaluate(() => chrome.extension.isAllowedFileSchemeAccess());
    const result = (await tool(h.page, task.id, { name: 'open', url })).result!;
    if (allowed) expect(result.snapshot?.title).toBe('Local file');
    else expect(display(result.blocked)).toContain('允许访问文件网址');
  } finally { await h.context.close(); }
});

test('elapsed task time does not discard a granted operation or cause duplicate submission', async () => {
  const h = await harness();
  try {
    const form = await startFormTask(h); const before = (await readTasks(h.page))[0];
    await h.page.evaluate(async id => {
      const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('bwai'); request.onsuccess = () => resolve(request.result); });
      await new Promise<void>(resolve => { const tx = db.transaction('tasks', 'readwrite'); const request = tx.objectStore('tasks').get(id); request.onsuccess = () => tx.objectStore('tasks').put({ ...request.result, status: 'paused', elapsedMs: 9_000_000 }); tx.oncomplete = () => { db.close(); resolve(); }; });
    }, before.id);
    await h.page.reload();
    await h.page.getByRole('button', { name: '继续任务', exact: true }).click();
    await expect(h.page.getByTestId('task-status')).toHaveText('等待确认', { timeout: 45_000 });
    await h.page.getByRole('button', { name: '确认执行这一步' }).click();
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 45_000 });
    expect(await submittedTitles(form)).toEqual(['BWAI 示例']);
    expect((await readTasks(h.page))[0].messages?.filter(message => message.kind === 'approval')).toHaveLength(1);
  } finally { await h.context.close(); }
});
