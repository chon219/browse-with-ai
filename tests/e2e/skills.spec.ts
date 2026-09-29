import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { harness } from './support/harness';
import { start, readTasks } from './support/tasks';
import { modelInput } from '../fixtures/model-input';

test('extracts, edits, exports and reuses a skill after deleting its source conversation', async () => {
  const h = await harness();
  let loaded = false, drafted = false;
  try {
    await expect(h.page.getByRole('complementary').getByRole('button', { name: '技能库', exact: true })).toBeVisible();
    await expect(h.page.getByRole('article').getByRole('button', { name: '技能库', exact: true })).toHaveCount(0);
    await h.context.route('https://model-fixture.example/**', async route => {
      const body = route.request().postDataJSON();
      const system = body.messages[0].content;
      let fn: { name: string; arguments: string };
      if (system.includes('BWAI_SKILL_DRAFT')) {
        const evidence = JSON.parse(body.messages[1].content);
        expect(evidence.steps.some((step: { phase: string }) => step.phase === 'done')).toBe(true);
        drafted = true;
        fn = { name: 'draft_skill', arguments: JSON.stringify({ name: '指南阅读流程', description: '查找并核对操作指南时使用', instructions: '## 输入\n需要查找的主题。\n## 步骤\n搜索主题，打开结果并核对正文。\n## 验证\n记录来源与相关步骤。' }) };
      } else if (system.includes('BWAI_DECIDE') && modelInput(body).availableSkills?.length) {
        const input = modelInput(body);
        if (!input.loadedSkill) {
          expect(JSON.stringify(body.messages)).not.toContain('保留来源链接');
          fn = { name: 'load_skill', arguments: '{}' };
        } else {
          loaded = true;
          expect(input.loadedSkill.instructions).toContain('保留来源链接');
          fn = { name: 'finish_task', arguments: JSON.stringify({ answer: '已按技能检查。', outcome: 'success', verification: '测试已加载技能版本' }) };
        }
      } else { await route.fallback(); return; }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: crypto.randomUUID(), type: 'function', function: fn }] } }] }) });
    });
    await start(h.page, '查找浏览器操作指南');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 45000 });
    const source = (await readTasks(h.page))[0];
    await expect(h.page.getByRole('article').getByRole('button', { name: '技能库', exact: true })).toHaveCount(0);
    await h.page.getByRole('button', { name: '提炼为技能', exact: true }).click();
    const dialog = h.page.getByRole('dialog', { name: '技能库', exact: true });
    await expect(dialog.getByLabel('技能名称')).toHaveValue('指南阅读流程');
    await dialog.getByLabel('流程与验证标准').fill('先确认主题，再读取指南并核对内容。保留来源链接。');
    const downloading = h.page.waitForEvent('download');
    await dialog.getByRole('button', { name: '导出 SKILL.md' }).click();
    const download = await downloading;
    expect(await readFile((await download.path())!, 'utf8')).toContain('保留来源链接');
    await dialog.getByRole('button', { name: '保存技能', exact: true }).click();
    await expect(dialog.locator('.skill-option-main').filter({ hasText: '指南阅读流程' })).toBeVisible();
    await dialog.locator('.skill-option-main').filter({ hasText: '指南阅读流程' }).click();
    await dialog.getByLabel('技能名称').fill('可复用指南');
    await dialog.getByRole('button', { name: '保存技能', exact: true }).click();
    await expect(dialog.locator('.skill-option-main').filter({ hasText: '可复用指南' })).toBeVisible();
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await h.page.locator('.history-row').filter({ hasText: source.title! }).getByRole('button', { name: '删除对话', exact: true }).click();
    await h.page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
    await h.page.reload();
    await h.page.getByRole('button', { name: '使用技能', exact: true }).click();
    await expect(dialog.locator('.skill-option-main')).toContainText('可复用指南');
    await dialog.locator('.skill-option-main').filter({ hasText: '可复用指南' }).click();
    await expect(h.page.getByRole('button', { name: '使用技能', exact: true })).toHaveText('可复用指南');
    await start(h.page, '按技能阅读指南');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 15000 });
    expect(drafted && loaded).toBe(true);
    const task = (await readTasks(h.page))[0];
    expect(task.skill?.version).toBe(2);
    await h.page.getByRole('button', { name: '技能库', exact: true }).click();
    await dialog.locator('.skill-option-main').filter({ hasText: '可复用指南' }).click();
    await dialog.getByLabel('技能名称').fill('未保存的技能名称');
    await h.page.setViewportSize({ width: 380, height: 760 });
    await expect(h.page.locator('.header-actions .skill-nav-button')).toHaveCount(1);
    await expect(h.page.locator('.conversations .skill-nav-button')).toHaveCount(0);
    await expect(dialog.getByLabel('技能名称')).toHaveValue('未保存的技能名称');
    await dialog.getByRole('button', { name: '删除技能', exact: true }).click();
    await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(dialog).toContainText('还没有保存的技能');
    expect((await readTasks(h.page))[0].skill?.instructions).toContain('保留来源链接');
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});
