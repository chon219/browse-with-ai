import { test, expect } from '@playwright/test';
import { harness } from './support/harness';
import { start } from './support/tasks';

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

test('shows model waiting, concrete tool progress and both content and action-reason explanations', async () => {
  const h = await harness();
  const initial = gate(), pageOne = gate(), review = gate(), pageTwo = gate();
  let decisions = 0;
  try {
    await h.context.route('https://progress-fixture.example/**', async route => {
      const first = route.request().url().endsWith('/one');
      await (first ? pageOne : pageTwo).promise;
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<title>${first ? '商品搜索' : '商品详情'}</title><h1>价格信息</h1>` });
    });
    await h.context.route('https://model-fixture.example/**', async route => {
      const body = route.request().postDataJSON();
      let message: Record<string, unknown> = { role: 'assistant', content: '价格核对' };
      if (body.messages[0].content.includes('BWAI_DECIDE')) {
        const step = ++decisions;
        if (step === 1) await initial.promise;
        if (step === 2) await review.promise;
        const fn = step < 3 ? { name: 'browser', arguments: JSON.stringify({ action: {
          name: 'open', url: `https://progress-fixture.example/${step === 1 ? 'one' : 'two'}`, effect: 'read',
          reason: step === 1 ? '读取搜索结果。' : '搜索结果缺少规格，我会打开商品详情核对。',
        } }) } : { name: 'finish_task', arguments: JSON.stringify({ answer: '已核对。', outcome: 'success', verification: '已读取两个页面' }) };
        message = { role: 'assistant', content: step === 1 ? '我会先读取商品搜索结果，确认是否有价格。' : null,
          tool_calls: [{ id: `progress-${step}`, type: 'function', function: fn }] };
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message }] }) });
    });
    await start(h.page, '核对商品价格');
    const progress = h.page.getByTestId('task-progress');
    await expect(progress).toContainText('正在分析任务，等待模型回复');
    initial.release();
    await expect(h.page.getByTestId('chat-message').filter({ hasText: '我会先读取商品搜索结果' })).toBeVisible();
    await expect(progress).toContainText('打开网页 · https://progress-fixture.example/one');
    pageOne.release();
    await expect(progress).toContainText('正在分析「商品搜索」，等待模型回复');
    review.release();
    await expect(h.page.getByTestId('chat-message').filter({ hasText: '搜索结果缺少规格' })).toBeVisible();
    await expect(progress).toContainText('打开网页 · https://progress-fixture.example/two');
    pageTwo.release();
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成');
    await expect(progress).toHaveCount(0);
    expect(h.errors).toEqual([]);
  } finally {
    for (const pending of [initial, pageOne, review, pageTwo]) pending.release();
    await h.context.unrouteAll({ behavior: 'wait' });
    await h.context.close();
  }
});
