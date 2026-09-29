import { test, expect } from '@playwright/test';
import path from 'node:path';
import { harness } from './support/harness';
import { start, readTasks, deletedRecords, tool, startFormTask, submittedTitles } from './support/tasks';

test('deleting a conversation clears every turn, supports cancelling, and keeps the selected conversation', async () => {
  const h = await harness();
  try {
    await start(h.page, '第一段待删除的对话');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 60_000 });
    const first = (await readTasks(h.page))[0];
    await h.page.getByLabel('消息', { exact: true }).fill('再打开一次指南');
    await h.page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(async () => { const task = (await readTasks(h.page))[0]; return [task.turn, task.status]; }, { timeout: 60_000 }).toEqual([1, 'completed']);
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 60_000 });
    await h.page.getByRole('button', { name: '新建对话', exact: true }).click();
    await start(h.page, '保留的第二段对话');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 60_000 });
    const row = h.page.locator('.history-row').filter({ hasText: first.goal });
    await row.getByRole('button', { name: '删除对话', exact: true }).click();
    await h.page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    expect(await readTasks(h.page)).toHaveLength(2);
    await row.getByRole('button', { name: '删除对话', exact: true }).click();
    await h.page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(h.page.locator('.task-header h2')).toHaveText('保留的第二段对话');
    expect(await deletedRecords(h.page, first.id)).toEqual([0, 0, 0, 0]);
    await h.page.reload();
    await expect(h.page.locator('.history-row')).toHaveCount(1);
    await h.page.getByRole('button', { name: '删除对话', exact: true }).click();
    await h.page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
    await expect(h.page.getByTestId('new-thread')).toBeVisible();
    await expect(h.page.locator('.history-row')).toHaveCount(0);
    await h.page.reload(); await expect(h.page.getByTestId('new-thread')).toBeVisible();
    expect(await readTasks(h.page)).toEqual([]); expect(h.errors).toEqual([]);
  } finally { h.hold.active = false; await h.context.close(); }
});

test('deleting a running conversation from the side panel stops the runner and prevents late persistence', async () => {
  const h = await harness();
  try {
    h.hold.active = true;
    await start(h.page, '删除正在执行的对话');
    await expect.poll(() => h.hold.reached, { timeout: 45_000 }).toBe(true);
    const task = (await readTasks(h.page))[0]; const requestsBefore = h.requests.length;
    const openedPages = h.context.pages().filter(page => page.url().startsWith('https://pages-fixture.example/'));
    const panel = await h.context.newPage(); await panel.goto(`chrome-extension://${h.id}/sidepanel.html`);
    await panel.getByRole('button', { name: '对话记录', exact: true }).click();
    await panel.getByRole('button', { name: '删除对话', exact: true }).click();
    await panel.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
    await expect(panel.locator('.history-row')).toHaveCount(0);
    await expect(h.page.getByTestId('new-thread')).toBeVisible();
    await expect.poll(() => h.page.evaluate(async () => (await navigator.locks.query()).held?.length ?? 0)).toBe(0);
    h.hold.active = false;
    expect(await deletedRecords(panel, task.id)).toEqual([0, 0, 0, 0]);
    await expect.poll(() => panel.evaluate(async () => Object.keys((await chrome.storage.session.get('taskTabs')).taskTabs ?? {}).length)).toBe(0);
    expect(openedPages.length).toBeGreaterThan(0); expect(openedPages.every(page => !page.isClosed())).toBe(true);
    await h.page.reload(); await expect(h.page.getByTestId('new-thread')).toBeVisible();
    expect(await deletedRecords(panel, task.id)).toEqual([0, 0, 0, 0]);
    expect(h.requests).toHaveLength(requestsBefore); expect(h.errors).toEqual([]);
  } finally { h.hold.active = false; await h.context.close(); }
});

test('closing side panel keeps work running; closing task page and restarting Chrome preserves resumable state', async () => {
  const h = await harness(); let context = h.context;
  try {
    h.hold.active = true;
    await start(h.page, '验证跨浏览器重启的任务恢复');
    await expect.poll(() => h.hold.reached, { timeout: 45_000 }).toBe(true);
    const sidebar = await context.newPage(); await sidebar.goto(`chrome-extension://${h.id}/sidepanel.html`); await sidebar.close();
    expect((await readTasks(h.page))[0].status).toBe('running');
    const taskUrl = h.page.url(); await h.page.close();
    h.hold.active = false;
    const recoveryPanel = await context.newPage(); await recoveryPanel.goto(`chrome-extension://${h.id}/sidepanel.html`);
    await recoveryPanel.getByRole('button', { name: '对话记录', exact: true }).click();
    await recoveryPanel.getByRole('button', { name: /验证跨浏览器重启的任务恢复/ }).click();
    const newTaskPage = context.waitForEvent('page');
    await recoveryPanel.getByRole('button', { name: '打开任务页', exact: true }).click();
    const reopened = await newTaskPage; await reopened.waitForLoadState('domcontentloaded');
    await expect(reopened.getByTestId('task-status')).toHaveText('已暂停');
    expect((await readTasks(reopened))[0].visitedUrls).toHaveLength(2);
    await context.close(); context = await h.launch();
    const page = await context.newPage(); await page.goto(taskUrl);
    await expect(page.getByTestId('task-status')).toHaveText('已暂停');
    await page.getByRole('button', { name: '继续任务' }).click();
    await expect(page.getByTestId('task-status')).toHaveText('已完成', { timeout: 60_000 });
    expect((await readTasks(page))[0].visitedUrls).toHaveLength(3);
    expect(h.requests.filter(r => r.includes('BWAI_PLAN'))).toHaveLength(0);
    expect(h.errors).toEqual([]);
  } finally { h.hold.active = false; await context.close(); }
});

test('pause aborts the model request and cancel prevents further browser actions', async () => {
  const h = await harness();
  try {
    h.hold.active = true;
    await start(h.page, '验证暂停和取消');
    await expect.poll(() => h.hold.reached, { timeout: 45_000 }).toBe(true);
    await h.page.getByRole('button', { name: '暂停', exact: true }).click();
    await expect(h.page.getByTestId('task-status')).toHaveText('已暂停');
    await h.page.getByRole('button', { name: '取消任务' }).click();
    await expect(h.page.getByTestId('task-status')).toHaveText('已取消');
    h.hold.active = false;
    const [task] = await readTasks(h.page);
    const result = await tool(h.page, task.id, { name: 'open', url: 'https://pages-fixture.example/should-not-open' });
    expect(JSON.stringify(result)).toContain('停止');
    expect((await readTasks(h.page))[0].visitedUrls).toHaveLength(2);
  } finally { h.hold.active = false; await h.context.close(); }
});

test('closing the task page asks first only while a task is running there', async () => {
  const h = await harness();
  try {
    h.hold.active = true;
    await start(h.page, '验证关闭任务页的提示');
    await expect.poll(() => h.hold.reached, { timeout: 45_000 }).toBe(true);
    await expect(h.page.getByTestId('task-status')).toHaveText('执行中');
    await expect(h.page.getByText('任务正在此页执行，关闭此页会暂停任务。', { exact: true })).toBeVisible();
    const dialogs: string[] = [];
    h.page.on('dialog', dialog => { dialogs.push(dialog.type()); void dialog.dismiss(); });
    // Staying on the page keeps the task running.
    await h.page.close({ runBeforeUnload: true });
    await expect.poll(() => dialogs).toEqual(['beforeunload']);
    expect(h.page.isClosed()).toBe(false);
    await expect(h.page.getByTestId('task-status')).toHaveText('执行中');
    // Once a pause is requested, closing loses nothing and does not ask.
    await h.page.getByRole('button', { name: '暂停', exact: true }).click();
    await expect(h.page.getByTestId('task-status')).toHaveText('已暂停');
    await h.page.close({ runBeforeUnload: true });
    await expect.poll(() => h.page.isClosed()).toBe(true);
    expect(dialogs).toEqual(['beforeunload']);
    h.hold.active = false;
  } finally { await h.context.close(); }
});

test('asks for missing information and continues the same task after the user answers', async () => {
  const h = await harness();
  try {
    const form = await h.context.newPage(); await form.goto('https://form-fixture.example/editor');
    await h.page.getByText('附加网页', { exact: true }).click(); await h.page.getByLabel('起始网页').selectOption({ label: '编辑表单' });
    await start(h.page, '在当前页面填写并提交表单，需要补充标题');
    await expect(h.page.getByTestId('chat-question')).toContainText('表单标题应该填写什么', { timeout: 45_000 });
    // The question message precedes the graph checkpoint and blocked-task patch.
    await expect.poll(async () => (await readTasks(h.page))[0].pendingQuestion).toContain('标题');
    const [before] = await readTasks(h.page); expect(before.pendingQuestion).toContain('标题');
    await h.page.locator('#instruction').fill('使用新标题');
    await h.page.getByRole('button', { name: '回答并继续' }).click();
    await expect(h.page.getByTestId('task-status')).toHaveText('等待确认', { timeout: 45_000 });
    await expect(h.page.getByTestId('approval')).toContainText('新标题');
    expect((await readTasks(h.page))[0].id).toBe(before.id);
    expect(await submittedTitles(form)).toEqual([]);
    await h.page.getByRole('button', { name: '确认执行这一步' }).click();
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 45_000 });
    expect(await submittedTitles(form)).toEqual(['新标题']);
  } finally { await h.context.close(); }
});

test('continues after completion with the same page and conversation, fresh usage accounting and a new approval', async () => {
  const h = await harness(); let context = h.context;
  try {
    const form = await startFormTask(h);
    const first = (await readTasks(h.page))[0]; const firstApproval = first.pendingApproval!.requestId;
    await h.page.getByRole('button', { name: '确认执行这一步' }).click();
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 45_000 });
    const taskUrl = h.page.url(); const pageCount = context.pages().length;
    await h.page.getByLabel('消息', { exact: true }).fill('把刚才的标题改成续聊标题，然后再次提交');
    await h.page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(h.page.getByTestId('task-status')).toHaveText('等待确认', { timeout: 45_000 });
    const current = (await readTasks(h.page))[0];
    expect(current.id).toBe(first.id); expect(current.turn).toBe(1); expect(current.pendingApproval?.requestId).not.toBe(firstApproval);
    expect(context.pages()).toHaveLength(pageCount); expect(await submittedTitles(form)).toEqual(['BWAI 示例']);
    await expect(h.page.getByTestId('approval')).toContainText('续聊标题');
    await h.page.getByRole('button', { name: '确认执行这一步' }).click();
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 45_000 });
    expect(await submittedTitles(form)).toEqual(['BWAI 示例', '续聊标题']);
    await expect(h.page.getByTestId('task-result')).toHaveCount(2);
    const saved = (await readTasks(h.page))[0];
    expect(saved.messages?.filter(m => m.role === 'user')).toHaveLength(2);
    expect(saved.messages?.filter(m => m.kind === 'result')).toHaveLength(2);
    await h.page.screenshot({ path: path.join(h.dir, 'conversation-followup.png'), fullPage: true });
    await context.close(); context = await h.launch();
    const reopened = await context.newPage(); await reopened.goto(taskUrl);
    await expect(reopened.getByTestId('task-result')).toHaveCount(2);
    await expect(reopened.getByLabel('消息', { exact: true })).toBeEnabled();
    expect((await readTasks(reopened))).toHaveLength(1);
  } finally { await context.close(); }
});

test('a chat message replaces a pending approval and steers the next decision before submitting', async () => {
  const h = await harness();
  try {
    const form = await startFormTask(h); const oldApproval = (await readTasks(h.page))[0].pendingApproval!.requestId;
    await h.page.getByLabel('消息', { exact: true }).fill('先把标题改成新标题，再让我确认');
    await h.page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(async () => (await readTasks(h.page))[0].pendingApproval?.requestId, { timeout: 45_000 }).not.toBe(oldApproval);
    await expect(h.page.getByTestId('task-status')).toHaveText('等待确认', { timeout: 45_000 });
    await expect(h.page.getByTestId('approval')).toContainText('新标题');
    await expect(h.page.getByTestId('approval-history')).toContainText('已被新要求替代');
    expect(await submittedTitles(form)).toEqual([]);
    await h.page.getByRole('button', { name: '确认执行这一步' }).click();
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 45_000 });
    expect(await submittedTitles(form)).toEqual(['新标题']);
    expect((await readTasks(h.page))[0].turn ?? 0).toBe(0);
  } finally { await h.context.close(); }
});

test('a message sent while the result is generating is handled before ending execution', async () => {
  const h = await harness();
  try {
    const form = await startFormTask(h);
    h.hold.phase = 'result'; h.hold.active = true;
    await h.page.getByRole('button', { name: '确认执行这一步' }).click();
    await expect.poll(() => h.hold.reached, { timeout: 45_000 }).toBe(true);
    await h.page.getByLabel('消息', { exact: true }).fill('再把标题更新为新标题并提交');
    await h.page.getByRole('button', { name: '发送', exact: true }).click();
    h.hold.active = false;
    await expect(h.page.getByTestId('task-status')).toHaveText('等待确认', { timeout: 45_000 });
    await expect(h.page.getByTestId('approval')).toContainText('新标题');
    expect((await readTasks(h.page))[0].messages?.filter(m => m.kind === 'result')).toHaveLength(0);
    await h.page.getByRole('button', { name: '确认执行这一步' }).click();
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 45_000 });
    expect(await submittedTitles(form)).toEqual(['BWAI 示例', '新标题']);
    expect((await readTasks(h.page))[0].messages?.filter(m => m.kind === 'result')).toHaveLength(1);
  } finally { h.hold.active = false; await h.context.close(); }
});

test('new conversations open on the right with compact suggestions and optional token limits', async () => {
  const h = await harness();
  try {
    const navigation = h.page.getByRole('complementary', { name: '对话导航' });
    const workspace = h.page.getByRole('article', { name: '对话工作区' });
    await expect(navigation.locator('textarea,input,select')).toHaveCount(0);
    await expect(workspace.getByLabel('消息', { exact: true })).toBeVisible();
    await expect(h.page.getByText('执行预算', { exact: true })).toHaveCount(0);
    const suggestions = workspace.locator('.suggested-tasks');
    expect((await suggestions.boundingBox())!.height).toBeLessThan(70);
    await suggestions.getByRole('button', { name: '调研对比', exact: true }).click();
    await expect(workspace.getByLabel('消息', { exact: true })).toHaveValue(/Excel 对比表/);
    await expect(workspace.getByLabel('起始网页')).toBeHidden();
    expect(await readTasks(h.page)).toHaveLength(0);
    await h.page.getByRole('button', { name: '新建对话', exact: true }).click();
    await suggestions.getByRole('button', { name: '生成报告', exact: true }).click();
    await expect(workspace.getByLabel('消息', { exact: true })).toHaveValue(/Word 文档/);
    await expect(workspace.getByLabel('起始网页')).toBeHidden();
    await h.page.getByRole('button', { name: '新建对话', exact: true }).click();
    const choosingFile = h.page.waitForEvent('filechooser');
    await suggestions.getByRole('button', { name: '分析表格', exact: true }).click();
    await (await choosingFile).setFiles({ name: 'data.csv', mimeType: 'text/csv', buffer: Buffer.from('item,value\nA,10\n') });
    await expect(workspace.locator('.file-chip')).toContainText('data.csv');
    await expect(workspace.getByLabel('消息', { exact: true })).toHaveValue(/检查缺失值和重复记录/);
    await expect(workspace.getByLabel('起始网页')).toBeHidden();
    expect(await readTasks(h.page)).toHaveLength(0);
    await h.page.getByRole('button', { name: '新建对话', exact: true }).click();
    await suggestions.getByRole('button', { name: '网页转表格', exact: true }).click();
    await expect(workspace.getByLabel('消息', { exact: true })).toHaveValue('将所选网页中的列表整理为 Excel，保留名称、关键字段和来源链接；缺失的信息标注为空，不要猜测。');
    await expect(workspace.getByLabel('起始网页')).toBeVisible();
    expect(await readTasks(h.page)).toHaveLength(0);
    await h.page.getByRole('button', { name: '新建对话', exact: true }).click();
    await expect(workspace.getByLabel('消息', { exact: true })).toBeFocused();
    await expect(workspace.getByLabel('消息', { exact: true })).toHaveValue('');

    const optionsPage = h.context.waitForEvent('page'); await h.page.getByRole('button', { name: '设置', exact: true }).click(); const settings = await optionsPage;
    await expect(settings.getByLabel('步数', { exact: true })).toHaveCount(0);
    await expect(settings.getByLabel('限制每轮 token 用量')).not.toBeChecked();
    await settings.getByLabel('限制每轮 token 用量').check();
    await settings.getByLabel('Token 上限（千）', { exact: true }).fill('300');
    await settings.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(settings.getByRole('status')).toContainText('设置已保存');
    await settings.reload(); await expect(settings.getByLabel('Token 上限（千）', { exact: true })).toHaveValue('300'); await settings.close();
    await start(h.page, '打开操作指南并查看下一页');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 45_000 });
    const original = (await readTasks(h.page))[0]; expect(original.tokenLimit).toBe(300_000);
    await expect(h.page.getByTestId('run-usage')).toHaveCount(0);
    expect(original.messages?.filter(message => message.role === 'activity').some(message => /第 \d+ 步/.test(message.content))).toBe(false);
    await h.page.getByRole('button', { name: '新建对话', exact: true }).click();
    await expect(h.page.getByTestId('new-thread')).toBeVisible();
    await expect(workspace.getByLabel('消息', { exact: true })).toHaveValue('');
    // No start page is attached, and the picker stays folded away.
    await expect(workspace.locator('.attach-page')).toHaveText('附加网页');
    await expect(workspace.getByLabel('起始网页')).toBeHidden();
    // The composer stays within the viewport when opening the picker or adding files.
    const send = workspace.getByRole('button', { name: '发送', exact: true });
    await workspace.locator('.attach-page').click(); await expect(workspace.getByLabel('起始网页')).toBeVisible();
    await workspace.getByTestId('attach-input').setInputFiles([{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }]);
    await expect(workspace.locator('.file-chip')).toHaveCount(1);
    await expect(send).toBeInViewport();
    await expect(workspace.getByLabel('起始网页')).toBeInViewport();
    await expect(workspace.locator('.file-chip')).toBeInViewport();
    await workspace.locator('.attach-page').click(); await expect(workspace.getByLabel('起始网页')).toBeHidden();
    await workspace.getByRole('button', { name: '移除 notes.txt', exact: true }).click();
    expect(await readTasks(h.page)).toHaveLength(1);
    await h.page.screenshot({ path: path.join(h.dir, 'new-thread-layout.png'), fullPage: true });
    await navigation.getByRole('button', { name: /打开操作指南并查看下一页/ }).click();
    await expect(h.page.getByTestId('task-result')).toBeVisible();
    expect((await readTasks(h.page))[0].id).toBe(original.id);
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});
