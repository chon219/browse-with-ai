import { expect, it } from 'vitest';
import { browserProgress, decisionProgress } from '../../src/agent/progress';
import { AgentState } from '../../src/agent/state';
import { display } from '../../src/i18n';

const state = () => AgentState.parse({ history: [{ kind: 'observation', tabId: 7,
  action: { id: '1', tool: 'browser', arguments: { action: { name: 'read', tabId: 7 } } },
  snapshot: { title: '商品搜索', url: 'https://example.com/', snapshotId: 'current', text: 'Products', elements: [{ id: 'e1', kind: 'input', text: '搜索关键词' }] },
}] });

it('describes the actual page, target, scroll direction and wait duration without field values', () => {
  expect(display(browserProgress({ name: 'fill', tabId: 7, snapshotId: 'current', elementId: 'e1', value: 'private-value' }, state())))
    .toBe('填写输入框 · 商品搜索 · 搜索关键词');
  expect(display(browserProgress({ name: 'wait', tabId: 7, milliseconds: 1500 }, state())))
    .toBe('等待页面更新 · 商品搜索 · 1.5s');
  expect(display(browserProgress({ name: 'scroll', tabId: 7, direction: 'down' }, state())))
    .toBe('向下滚动页面 · 商品搜索');
  expect(display(browserProgress({ name: 'click', tabId: 7, snapshotId: 'expired', elementId: 'e1' }, state())))
    .toBe('点击页面元素 · 商品搜索');
});

it('distinguishes waiting for the model from executing an action and recovering from feedback', () => {
  expect(display(decisionProgress(state()))).toBe('正在分析「商品搜索」，等待模型回复');
  const failed = state();
  failed.history.push({ kind: 'note', text: 'Invalid arguments' });
  expect(display(decisionProgress(failed))).toContain('等待模型调整下一步');
  expect(display(decisionProgress(AgentState.parse({})))).toBe('正在分析任务，等待模型回复');
});
