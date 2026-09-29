import { test, expect } from '@playwright/test';
import { harness } from './support/harness';
import { seedRunningTask, tool } from './support/tasks';

test('reads and navigates parsed pages while an image keeps each tab loading', async () => {
  const h = await harness();
  let release!: () => void;
  const pendingResource = new Promise<void>(resolve => { release = resolve; });
  try {
    await h.context.route('https://slow-fixture.example/**', async route => {
      if (new URL(route.request().url()).pathname === '/slow.png') {
        await pendingResource;
        await route.fulfill({ status: 204 });
        return;
      }
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><title>慢速资源页面</title></head>
        <body><h1>正文已经加载</h1><p>商品价格：6999 元</p><a href="/next">下一页</a>
        <img src="/slow.png" alt="尚未加载的图片"><div style="height:2000px">页面内容</div></body></html>` });
    });
    const task = await seedRunningTask(h.page);
    const opened = (await tool(h.page, task.id, { name: 'open', url: 'https://slow-fixture.example/' })).result!;
    expect(opened.error).toBeUndefined();
    expect(opened.snapshot?.text).toContain('商品价格：6999 元');
    expect(await h.page.evaluate(async id => (await chrome.tabs.get(id)).status, opened.tabId!)).toBe('loading');

    const waited = (await tool(h.page, task.id, { name: 'wait', tabId: opened.tabId!, milliseconds: 100 })).result!;
    expect(waited.snapshot?.text).toContain('商品价格：6999 元');
    const scrolled = (await tool(h.page, task.id, { name: 'scroll', tabId: opened.tabId!, direction: 'down' })).result!;
    expect(scrolled.snapshot?.scroll?.top).toBeGreaterThan(0);
    const link = scrolled.snapshot!.elements.find(element => element.text === '下一页')!;
    const followed = (await tool(h.page, task.id, { name: 'follow', tabId: opened.tabId!, snapshotId: scrolled.snapshot!.snapshotId, elementId: link.id })).result!;
    expect(followed.snapshot?.url).toBe('https://slow-fixture.example/next');
    expect(followed.snapshot?.text).toContain('商品价格：6999 元');
    expect(await h.page.evaluate(async id => (await chrome.tabs.get(id)).status, opened.tabId!)).toBe('loading');
    expect(h.errors).toEqual([]);
  } finally {
    release();
    await h.context.unrouteAll({ behavior: 'wait' });
    await h.context.close();
  }
});
