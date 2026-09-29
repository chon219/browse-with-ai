import { test, expect } from '@playwright/test';
import { harness } from './support/harness';
import { start, readTasks, seedRunningTask, configureTokenLimit } from './support/tasks';

test('an explicit token limit pauses with a summary and resumes after disabling it', async () => {
  const h = await harness(); let finish = false; let requests = 0; let decisions = 0;
  try {
    await configureTokenLimit(h, 50);
    await h.context.route('https://model-fixture.example/**', async route => {
      requests++; const body = route.request().postDataJSON(); const system = body.messages[0].content;
      const fn = finish ? { name: 'finish_task', arguments: JSON.stringify({ outcome: 'success', answer: 'Done', verification: 'Checked' }) }
        : { name: 'browser', arguments: JSON.stringify({ action: { name: 'open', url: 'https://pages-fixture.example/page-' + ++decisions } }) };
      const message = system.includes('BWAI_DECIDE') ? { content: null, tool_calls: [{ id: crypto.randomUUID(), type: 'function', function: fn }] }
        : { content: system.includes('BWAI_PROGRESS') ? '已保存页面资料，尚需整理。' : '完成' };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', ...message } }], usage: { prompt_tokens: system.includes('BWAI_DECIDE') ? 8000 : 500, completion_tokens: 100 } }) });
    });
    await start(h.page, '收集页面资料');
    await expect(h.page.getByTestId('task-status')).toHaveText('已暂停', { timeout: 45_000 });
    const before = (await readTasks(h.page))[0]; expect(before.pause?.kind).toBe('tokens');
    await expect(h.page.getByText('已保存页面资料，尚需整理。', { exact: true })).toBeVisible();
    await h.page.reload(); await expect(h.page.getByTestId('task-status')).toHaveText('已暂停');
    const count = requests;
    await h.page.getByRole('button', { name: '继续任务', exact: true }).click();
    await expect.poll(async () => (await readTasks(h.page))[0].status).toBe('paused'); expect(requests).toBe(count);
    await configureTokenLimit(h); finish = true;
    await h.page.getByRole('button', { name: '继续任务', exact: true }).click();
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 45_000 });
    expect((await readTasks(h.page))[0].id).toBe(before.id); expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});

test('old page, step and time quotas do not interrupt a progressing task or expose step counts', async () => {
  const h = await harness();
  try {
    const task = await seedRunningTask(h.page);
    await h.page.evaluate(async id => {
      const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('bwai'); request.onsuccess = () => resolve(request.result); });
      await new Promise<void>(resolve => { const tx = db.transaction('tasks', 'readwrite'); const request = tx.objectStore('tasks').get(id);
        request.onsuccess = () => tx.objectStore('tasks').put({ ...request.result, status: 'ready', goal: '打开操作指南并查看下一页', elapsedMs: 9_000_000, limits: { pages: 1, steps: 1, minutes: 1, kTokens: 50 } });
        tx.oncomplete = () => { db.close(); resolve(); }; });
    }, task.id);
    await h.page.goto(`chrome-extension://${h.id}/task.html?task=${task.id}`);
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 45_000 });
    const after = (await readTasks(h.page))[0]; expect(after.visitedUrls).toHaveLength(3); expect(after.elapsedMs).toBeGreaterThanOrEqual(9_000_000);
    await expect(h.page.getByTestId('run-usage')).toHaveCount(0);
    await expect(h.page.getByRole('button', { name: '继续执行', exact: true })).toHaveCount(0);
  } finally { await h.context.close(); }
});

test('persistent invalid decisions pause for lack of progress and can be resumed', async () => {
  const h = await harness(); let finish = false;
  try {
    await h.context.route('https://model-fixture.example/**', route => {
      const body = route.request().postDataJSON();
      const message = body.messages[0].content.includes('BWAI_DECIDE') ? { content: null, tool_calls: [{ id: crypto.randomUUID(), type: 'function', function: finish
        ? { name: 'finish_task', arguments: JSON.stringify({ outcome: 'success', answer: 'Done', verification: 'Checked' }) }
        : { name: 'unknown_tool', arguments: '{}' } }] } : { content: 'Done' };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', ...message } }] }) });
    });
    await start(h.page, '处理任务'); await expect(h.page.getByTestId('task-status')).toHaveText('已暂停', { timeout: 45_000 });
    expect((await readTasks(h.page))[0].pause?.kind).toBe('stalled');
    await expect(h.page.locator('.task-header')).toContainText('结果没有变化');
    await h.page.reload(); finish = true;
    await h.page.getByRole('button', { name: '继续任务', exact: true }).click();
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 45_000 });
  } finally { await h.context.close(); }
});
