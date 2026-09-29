import { test, expect } from '@playwright/test';
import { harness } from './support/harness';
import { start, readTasks, submittedTitles } from './support/tasks';
test('reloads a pending agent approval and resumes the original operation exactly once', async () => {
  const h = await harness();
  try {
    const form = await h.context.newPage(); await form.goto('https://form-fixture.example/editor');
    await h.page.getByText('附加网页', { exact: true }).click();
    await h.page.getByLabel('起始网页').selectOption({ label: '编辑表单' });
    await start(h.page, '在当前页面填写并提交表单，提交前让我确认');
    await expect(h.page.getByTestId('task-status')).toHaveText('等待确认', { timeout: 15000 });
    const approvalId = (await readTasks(h.page))[0].pendingApproval!.requestId;
    await h.page.reload();
    await expect(h.page.getByTestId('task-status')).toHaveText('等待确认');
    expect((await readTasks(h.page))[0].pendingApproval!.requestId).toBe(approvalId);
    await h.page.getByRole('button', { name: '确认执行这一步' }).click();
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 15000 });
    expect(await submittedTitles(form)).toEqual(['BWAI 示例']);
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});
