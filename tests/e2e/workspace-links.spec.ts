import { test, expect } from '@playwright/test';
import { harness } from './support/harness';
import { start, readTasks } from './support/tasks';
import { modelInput } from '../fixtures/model-input';

test('file references in replies open the shared preview, stay conversation-scoped and update after deletion', async () => {
  const h = await harness();
  const filePath = 'reports/季度 报告.csv';
  const destination = filePath.split('/').map(encodeURIComponent).join('/');
  try {
    await h.context.route('https://model-fixture.example/**', async route => {
      const body = route.request().postDataJSON();
      if (!body.messages[0].content.includes('BWAI_DECIDE')) { await route.fallback(); return; }
      const input = modelInput(body);
      const answer = `[下载报告](${destination})\n\n[工作区链接](workspace:${destination})\n\n旧回复中的文件名：\`季度 报告.csv\`\n\n\`report.txt\`\n\n[不存在](missing.csv) [越界](../${destination}) [外部地址](https://unvisited.example/)\n\n\`\`\`text\n${filePath}\n\`\`\``;
      const fn = input.observations.length || input.goal === '没有文件的新对话'
        ? { name: 'finish_task', arguments: JSON.stringify({ outcome: 'success', answer, verification: '工作区写入结果已返回' }) }
        : { name: 'run_code', arguments: JSON.stringify({ code: `await files.write(${JSON.stringify(filePath)}, '项目,金额\\nA,10\\n'); await files.write('a/report.txt', 'A'); await files.write('b/report.txt', 'B'); return await files.list();` }) };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: crypto.randomUUID(), type: 'function', function: fn }] } }] }) });
    });
    await start(h.page, '生成可预览的报告');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成');
    const [task] = await readTasks(h.page);
    const result = h.page.getByTestId('task-result');
    await expect(result.locator('button.workspace-link')).toHaveCount(3);
    await expect(result.locator('pre button')).toHaveCount(0);
    await expect(result.locator('a')).toHaveCount(0);
    const originalUrl = h.page.url();
    for (const name of ['下载报告', '工作区链接', '季度 报告.csv']) {
      await result.getByRole('button', { name, exact: true }).click();
      const dialog = h.page.getByRole('dialog');
      await expect(dialog.getByRole('heading')).toHaveText(filePath);
      await expect(dialog.locator('.file-content')).toHaveText('项目,金额\nA,10\n');
      await h.page.keyboard.press('Escape');
      expect(h.page.url()).toBe(originalUrl);
    }
    await h.page.reload();
    await result.getByRole('button', { name: '下载报告', exact: true }).click();
    const download = h.page.waitForEvent('download');
    await h.page.getByRole('dialog').getByRole('button', { name: '下载', exact: true }).click();
    expect((await download).suggestedFilename()).toBe('季度 报告.csv');
    await h.page.keyboard.press('Escape');
    await h.page.getByRole('button', { name: '新建对话', exact: true }).click();
    await start(h.page, '没有文件的新对话');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成');
    await expect(result.locator('button.workspace-link')).toHaveCount(0);
    await h.page.goto(originalUrl);
    await expect(result.locator('button.workspace-link')).toHaveCount(3);
    const panel = await h.context.newPage();
    await panel.setViewportSize({ width: 380, height: 760 });
    await panel.goto(`chrome-extension://${h.id}/sidepanel.html?task=${task.id}`);
    await panel.getByTestId('task-result').getByRole('button', { name: '下载报告', exact: true }).click();
    await expect(panel.getByRole('dialog').getByRole('heading')).toHaveText(filePath);
    await panel.keyboard.press('Escape');
    await h.page.evaluate(async id => {
      const directory = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('tasks')).getDirectoryHandle(id);
      await (await directory.getDirectoryHandle('reports')).removeEntry('季度 报告.csv');
    }, task.id);
    await h.context.serviceWorkers()[0].evaluate(async taskId => { await chrome.runtime.sendMessage({ type: 'workspaceUpdated', taskId, requestId: crypto.randomUUID() }).catch(() => {}); }, task.id);
    await expect(result.locator('button.workspace-link')).toHaveCount(0);
    await expect(panel.getByTestId('task-result').locator('button.workspace-link')).toHaveCount(0);
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});
