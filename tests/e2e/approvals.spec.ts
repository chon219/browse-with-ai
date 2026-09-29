import { test, expect } from '@playwright/test';
import path from 'node:path';
import type { BrowserAction } from '../../src/shared/types';
import { display } from '../../src/i18n';
import { harness } from './support/harness';
import { readTasks, seedRunningTask, tool, startFormTask, submittedTitles } from './support/tasks';

test('approval previews keep distinct fields with identical labels', async () => {
  const h = await harness();
  try {
    await h.context.route('https://preview-fixture.example/**', route => route.fulfill({ contentType: 'text/html', body:
      '<!doctype html><title>Preview</title><form><label>Name<input name="first" value="first"></label><label>Name<input name="second" value="second"></label></form>' }));
    const task = await seedRunningTask(h.page);
    const opened = (await tool(h.page, task.id, { name: 'open', url: 'https://preview-fixture.example/' })).result!;
    const field = opened.snapshot!.elements.find(ref => ref.value === 'first')!;
    const result = (await tool(h.page, task.id, { name: 'fill', tabId: opened.tabId!, snapshotId: opened.snapshot!.snapshotId,
      elementId: field.id, value: 'updated', effect: 'write' })).result!;
    expect(result.approval?.fields).toEqual([{ label: 'Name', value: 'second' }, { label: 'Name', value: 'updated' }]);
    expect(result.approval?.fieldsTruncated).toBe(false);
    const source = h.context.pages().find(page => page.url() === 'https://preview-fixture.example/')!;
    await expect(source.locator('[name=first]')).toHaveValue('first');
  } finally { await h.context.close(); }
});

test('the side panel keeps a pending approval and the composer on screen', async () => {
  const h = await harness();
  try {
    const task = await seedRunningTask(h.page);
    const approval = { requestId: 'pending', description: '点击「提交」可能提交表单。', url: 'https://form-fixture.example/save', elementText: '提交', fields: [] };
    const at = new Date().toISOString();
    await h.page.evaluate(async ({ task, approval, at }) => {
      const messages = [{ id: 'goal', at, turn: 0, role: 'user', kind: 'message', content: task.goal },
        ...Array.from({ length: 12 }, (_, i) => ({ id: 'step-' + i, at, turn: 0, role: 'assistant', kind: 'message', content: '第 ' + (i + 1) + ' 步的说明，内容较长，用来把对话撑到超过一屏的高度。' })),
        { id: 'approval:pending', at, turn: 0, role: 'assistant', kind: 'approval', content: approval.description, approval }];
      const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open('bwai'); req.onsuccess = () => resolve(req.result); });
      await new Promise<void>(resolve => { const tx = db.transaction('tasks', 'readwrite'); tx.objectStore('tasks').put({ ...task, status: 'blocked', pendingApproval: approval, messages }); tx.oncomplete = () => { db.close(); resolve(); }; });
    }, { task, approval, at });
    const panel = await h.context.newPage(); await panel.setViewportSize({ width: 400, height: 800 });
    await panel.goto(`chrome-extension://${h.id}/sidepanel.html?task=${task.id}`);
    await expect(panel.getByTestId('task-status')).toHaveText('等待确认');
    for (const control of [panel.getByRole('button', { name: '确认执行这一步' }), panel.getByLabel('消息', { exact: true })]) {
      const box = (await control.boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(800);
    }
    // One scroll area: the conversation scrolls, the page does not.
    expect(await panel.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    // The list opens over the conversation, shows the same status, and closes on Escape.
    await expect(panel.locator('.history-row')).toBeHidden();
    await panel.getByRole('button', { name: '对话记录', exact: true }).click();
    await expect(panel.locator('.history-row').filter({ hasText: task.goal })).toContainText('等待确认');
    await panel.keyboard.press('Escape');
    await expect(panel.locator('.history-row')).toBeHidden();
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});

test('generic actions follow the model-declared effect independently of button labels', async () => {
  const h = await harness();
  try {
    await h.context.route('https://app-fixture.example/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<html><head><meta charset="utf-8"><title>脚本搜索</title></head><body><label>关键词<input name="query" type="search"></label><label>分类<select name="category"><option value="all">全部</option><option value="books">图书</option></select></label><button id="search">搜索</button><button id="delete">删除</button><p id="result">等待查询</p><script>document.getElementById('search').onclick=()=>document.getElementById('result').textContent='已找到：'+document.querySelector('input').value;document.getElementById('delete').onclick=()=>window.writeTriggered=true;</script></body></html>` }));
    const task = await seedRunningTask(h.page);
    let result = (await tool(h.page, task.id, { name: 'open', url: 'https://app-fixture.example/' })).result!;
    const tabId = result.tabId!;
    const input = result.snapshot!.elements.find(e => e.kind === 'input')!;
    result = (await tool(h.page, task.id, { name: 'fill', tabId, snapshotId: result.snapshot!.snapshotId, elementId: input.id, value: '浏览器自动化' })).result!;
    const select = result.snapshot!.elements.find(e => e.kind === 'select')!;
    result = (await tool(h.page, task.id, { name: 'select', tabId, snapshotId: result.snapshot!.snapshotId, elementId: select.id, value: 'books' })).result!;
    const button = result.snapshot!.elements.find(e => e.kind === 'button' && e.text === '搜索')!;
    result = (await tool(h.page, task.id, { name: 'click', tabId, snapshotId: result.snapshot!.snapshotId, elementId: button.id })).result!;
    expect(result.snapshot!.text).toContain('已找到：浏览器自动化');
    const page = h.context.pages().find(p => p.url().includes('app-fixture.example'))!;
    expect(await page.locator('select').inputValue()).toBe('books');
    const remove = result.snapshot!.elements.find(e => e.text === '删除')!;
    const blocked = await tool(h.page, task.id, { name: 'click', tabId, snapshotId: result.snapshot!.snapshotId, elementId: remove.id, effect: 'write' });
    expect(blocked.result?.approval?.elementText).toBe('删除');
    expect(await page.evaluate(() => (window as unknown as { writeTriggered?: boolean }).writeTriggered)).toBeUndefined();
    // Approvals follow the declared effect, regardless of the button label.
    const declared = await tool(h.page, task.id, { name: 'click', tabId, snapshotId: result.snapshot!.snapshotId, elementId: button.id, effect: 'write', reason: '保存本次查询' });
    expect(declared.result?.approval?.elementText).toBe('搜索');
    expect(declared.result?.approval?.reason).toBe('保存本次查询');
    const claimedRead = await tool(h.page, task.id, { name: 'click', tabId, snapshotId: result.snapshot!.snapshotId, elementId: remove.id, effect: 'read' });
    expect(claimedRead.result?.approval).toBeUndefined();
    expect(await page.evaluate(() => (window as unknown as { writeTriggered?: boolean }).writeTriggered)).toBe(true);
  } finally { await h.context.close(); }
});

test('field names and automatic submission do not override the model-declared action', async () => {
  const h = await harness();
  try {
    await h.context.route('https://field-fixture.example/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Fields</title>
      <form method="post" id="f"><label>Token<input name="token" value="existing-token" autocomplete="one-time-code"></label>
      <label>Password<input type="password" name="password" value="existing-password"></label>
      <label>Secret<select name="secret" onchange="this.form.requestSubmit()"><option value="a">A</option><option value="b">B</option></select></label><button>Save</button></form>
      <div contenteditable="true" aria-label="Editor">Draft</div><p id="result"></p>
      <script>window.submits=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submits++;document.querySelector('#result').textContent='Submitted '+document.querySelector('select').value};</script>` }));
    const task = await seedRunningTask(h.page);
    let result = (await tool(h.page, task.id, { name: 'open', url: 'https://field-fixture.example/' })).result!;
    expect(result.snapshot!.elements.find(ref => ref.text === 'Token')?.value).toBe('existing-token');
    expect(result.snapshot!.elements.find(ref => ref.text === 'Password')?.value).toBe('existing-password');
    const change = async (name: 'fill' | 'select', label: string, value: string) => {
      const ref = result.snapshot!.elements.find(ref => ref.text === label)!;
      result = (await tool(h.page, task.id, { name, tabId: result.tabId!, snapshotId: result.snapshot!.snapshotId, elementId: ref.id, value, effect: 'read' })).result!;
      expect(result.approval).toBeUndefined(); expect(result.blocked).toBeUndefined();
    };
    await change('fill', 'Password', 'updated-password');
    expect(result.snapshot!.elements.find(ref => ref.text === 'Password')?.value).toBe('updated-password');
    await change('fill', 'Editor', 'Updated draft');
    expect(result.snapshot!.elements.find(ref => ref.text === 'Editor')?.value).toBe('Updated draft');
    await change('select', 'Secret', 'b');
    expect(result.snapshot!.text).toContain('Submitted b');
    const page = h.context.pages().find(page => page.url().startsWith('https://field-fixture.example/'))!;
    expect(await page.evaluate(() => (window as unknown as { submits: number }).submits)).toBe(1);
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});

test('navigation approval follows effect declarations rather than URL words', async () => {
  const h = await harness();
  try {
    await h.context.route('https://navigation-fixture.example/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Navigation</title><a href="/delete?action=pay">Open destination</a>' }));
    const task = await seedRunningTask(h.page);
    const opened = (await tool(h.page, task.id, { name: 'open', url: 'https://navigation-fixture.example/delete?action=pay', effect: 'read' })).result!;
    expect(opened.snapshot).toBeTruthy(); expect(opened.approval).toBeUndefined();
    const ref = opened.snapshot!.elements.find(ref => ref.kind === 'link')!;
    const follow = (await tool(h.page, task.id, { name: 'follow', tabId: opened.tabId!, snapshotId: opened.snapshot!.snapshotId, elementId: ref.id, effect: 'write', reason: 'Changes account state' })).result!;
    expect(follow.approval?.elementText).toBe('Open destination');
    const count = h.context.pages().length;
    const newPage = (await tool(h.page, task.id, { name: 'open', url: 'https://navigation-fixture.example/ordinary', effect: 'irreversible', reason: 'Applies a change' })).result!;
    expect(newPage.approval?.reason).toBe('Applies a change');
    expect(h.context.pages()).toHaveLength(count);
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});

test('model-declared field writes need approval and are submitted once after it', async () => {
  const h = await harness();
  try {
    await h.context.route('https://autosubmit-fixture.example/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<html><head><meta charset="utf-8"><title>自动提交</title></head><body><form id="f" action="/filter" method="post"><label>排序<select name="sort" id="sort"><option value="new">最新</option><option value="old">最早</option></select></label><label>备注<input name="note" type="text"></label><button type="submit">保存</button></form><form action="/prefs" method="get"><label>语言<select name="lang" onchange="this.form.submit()"><option value="zh">中文</option><option value="en">English</option></select></label><button>应用</button></form><p id="result">未提交</p><script>window.submits=[];document.getElementById('sort').addEventListener('change',()=>document.getElementById('f').requestSubmit());document.getElementById('f').addEventListener('submit',e=>{e.preventDefault();window.submits.push(document.getElementById('sort').value);document.getElementById('result').textContent='已提交 '+document.getElementById('sort').value;});</script></body></html>` }));
    const task = await seedRunningTask(h.page);
    let result = (await tool(h.page, task.id, { name: 'open', url: 'https://autosubmit-fixture.example/' })).result!;
    const tabId = result.tabId!;
    const page = h.context.pages().find(p => p.url().includes('autosubmit-fixture.example'))!;
    const submits = () => page.evaluate(() => (window as unknown as { submits: string[] }).submits);
    // An ordinary field change needs no approval.
    const note = result.snapshot!.elements.find(e => e.kind === 'input')!;
    result = (await tool(h.page, task.id, { name: 'fill', tabId, snapshotId: result.snapshot!.snapshotId, elementId: note.id, value: '备注内容' })).result!;
    expect(result.approval).toBeUndefined(); expect(result.snapshot).toBeTruthy();
    const snapshotId = result.snapshot!.snapshotId;
    const [sort, lang] = result.snapshot!.elements.filter(e => e.kind === 'select');
    // A model-declared write asks before executing the change handler.
    const sortRequest = crypto.randomUUID();
    const intercepted = (await tool(h.page, task.id, { name: 'select', tabId, snapshotId, elementId: sort.id, value: 'old', effect: 'write' }, sortRequest)).result!;
    expect(intercepted.approval?.elementText).toBe('排序');
    expect(await submits()).toEqual([]); expect(await page.locator('#sort').inputValue()).toBe('new');
    // The model also declares the inline change as a write.
    const inline = (await tool(h.page, task.id, { name: 'select', tabId, snapshotId, elementId: lang.id, value: 'en', effect: 'write' })).result!;
    expect(inline.approval?.elementText).toBe('语言'); expect(page.url()).toBe('https://autosubmit-fixture.example/');
    expect(await page.locator('[name=lang]').inputValue()).toBe('zh');
    // After approval the change is applied and submitted exactly once, then re-read.
    await h.page.evaluate(async id => {
      const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open('bwai'); req.onsuccess = () => resolve(req.result); });
      await new Promise<void>(resolve => { const tx = db.transaction('operations', 'readwrite'); const req = tx.objectStore('operations').get(id); req.onsuccess = () => tx.objectStore('operations').put({ ...req.result, approvalDecision: 'approved' }); tx.oncomplete = () => { db.close(); resolve(); }; });
    }, sortRequest);
    const approved = (await tool(h.page, task.id, { name: 'select', tabId, snapshotId, elementId: sort.id, value: 'old', effect: 'write' }, sortRequest)).result!;
    expect(approved.snapshot?.text).toContain('已提交 old'); expect(await submits()).toEqual(['old']);
    const replay = (await tool(h.page, task.id, { name: 'select', tabId, snapshotId, elementId: sort.id, value: 'old', effect: 'write' }, sortRequest)).result!;
    expect(replay.snapshot?.text).toContain('已提交 old'); expect(await submits()).toEqual(['old']);
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});

test('an interrupted approved submission is never replayed blindly', async () => {
  const h = await harness();
  try {
    const task = await seedRunningTask(h.page);
    const opened = (await tool(h.page, task.id, { name: 'open', url: 'https://form-fixture.example/editor' })).result!;
    const form = h.context.pages().find(p => p.url().includes('form-fixture.example'))!;
    const action: BrowserAction = { name: 'click', tabId: opened.tabId!, snapshotId: opened.snapshot!.snapshotId, elementId: opened.snapshot!.elements.find(e => e.text === '保存')!.id, effect: 'write' };
    const id = crypto.randomUUID();
    await h.page.evaluate(async ({ id, taskId, action }) => {
      const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open('bwai'); req.onsuccess = () => resolve(req.result); });
      await new Promise<void>(resolve => { const tx = db.transaction('operations', 'readwrite'); tx.objectStore('operations').put({ id, taskId, action, phase: 'pending', approvalDecision: 'approved', approvalAt: new Date().toISOString(), startedAt: new Date().toISOString() }); tx.oncomplete = () => { db.close(); resolve(); }; });
    }, { id, taskId: task.id, action });
    const result = await tool(h.page, task.id, action, id);
    expect(display(result.result?.error)).toContain('结果未知');
    expect(await submittedTitles(form)).toEqual([]);
  } finally { await h.context.close(); }
});

test('uses the selected page and executes one submission only after a concrete approval', async () => {
  const h = await harness();
  try {
    const form = await startFormTask(h);
    expect(await submittedTitles(form)).toEqual([]);
    await expect(h.page.getByTestId('approval')).toContainText('BWAI 示例');
    await expect(h.page.getByTestId('approval')).toContainText('图书');
    const [before] = await readTasks(h.page); const requestId = before.pendingApproval!.requestId;
    await h.page.getByRole('button', { name: '确认执行这一步' }).click();
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 45_000 });
    expect(await submittedTitles(form)).toEqual(['BWAI 示例']);
    const [after] = await readTasks(h.page);
    expect(after.outcome).toBe('success'); expect(after.visitedUrls).toHaveLength(1);
    await expect(h.page.getByTestId('task-result')).toHaveText('表单已提交，页面显示“已保存”，标题与分类已核对。');
    const duplicate = await h.page.evaluate(args => chrome.runtime.sendMessage({ type: 'approval', decision: 'approved', ...args }), { taskId: after.id, requestId });
    expect(duplicate.ok).toBe(false); expect(await submittedTitles(form)).toHaveLength(1);
    expect(h.errors).toEqual([]);
    await h.page.screenshot({ path: path.join(h.dir, 'browse-with-ai-complete.png'), fullPage: true });
  } finally { await h.context.close(); }
});

test('rejecting a submission makes the task incomplete without changing the website', async () => {
  const h = await harness();
  try {
    const form = await startFormTask(h);
    await h.page.getByRole('button', { name: '拒绝这一步' }).click();
    await expect(h.page.getByTestId('task-status')).toHaveText('未完成', { timeout: 45_000 });
    expect(await submittedTitles(form)).toEqual([]);
    expect((await readTasks(h.page))[0].outcome).toBe('incomplete');
    await expect(h.page.getByTestId('task-result')).toContainText('没有提交');
  } finally { await h.context.close(); }
});

test('changed form values invalidate approval and require a new review', async () => {
  const h = await harness();
  try {
    const form = await startFormTask(h); const oldId = (await readTasks(h.page))[0].pendingApproval!.requestId;
    await form.getByLabel('标题', { exact: true }).fill('用户刚刚修改了标题');
    await h.page.getByRole('button', { name: '确认执行这一步' }).click();
    await expect.poll(async () => (await readTasks(h.page))[0].pendingApproval?.requestId, { timeout: 45_000 }).not.toBe(oldId);
    await expect(h.page.getByTestId('task-status')).toHaveText('等待确认', { timeout: 45_000 });
    expect(await submittedTitles(form)).toEqual([]);
    expect((await readTasks(h.page))[0].messages!.some(s => s.role === 'activity' && s.content.includes('用户确认'))).toBe(true);
    await h.page.getByRole('button', { name: '拒绝这一步' }).click();
    await expect(h.page.getByTestId('task-status')).toHaveText('未完成');
  } finally { await h.context.close(); }
});
