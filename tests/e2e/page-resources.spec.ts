import { test, expect } from '@playwright/test';
import path from 'node:path';
import { harness } from './support/harness';
import { start, readTasks } from './support/tasks';

test('browsing history connects readable titles to archived Markdown, including existing conversations and versions', async () => {
  const h = await harness();
  try {
    await start(h.page, '查找浏览器操作指南');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成');
    const [task] = await readTasks(h.page);
    expect(task.visitedPages).toContainEqual({ url: 'https://pages-fixture.example/page-1', title: '浏览器操作指南 1' });
    const history = h.page.getByTestId('visited-pages');
    await history.locator(':scope > summary').click();
    const guide = history.locator('.page-resource').filter({ has: h.page.locator('a.page-title[href="https://pages-fixture.example/page-1"]') });
    await expect(guide.locator('.page-title')).toHaveText('浏览器操作指南 1');
    await guide.getByRole('button', { name: '预览 浏览器操作指南 1 的 Markdown', exact: true }).click();
    const dialog = h.page.getByRole('dialog');
    await expect(dialog.getByRole('heading')).toHaveText('浏览器操作指南 1');
    await expect(dialog.locator('pre')).toContainText('URL: https://pages-fixture.example/page-1');
    await expect(dialog.locator('.page-source a')).toHaveAttribute('href', 'https://pages-fixture.example/page-1');
    const download = h.page.waitForEvent('download');
    await dialog.getByRole('button', { name: '下载', exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/\.md$/);
    await h.page.keyboard.press('Escape');

    // Older conversations have only visitedUrls. Their existing archive headers still supply titles.
    await h.page.evaluate(async task => {
      const directory = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('tasks')).getDirectoryHandle(task.id);
      const pages = await directory.getDirectoryHandle('pages');
      const write = async (name: string, content: string) => {
        const stream = await (await pages.getFileHandle(name, { create: true })).createWritable();
        await stream.write(content); await stream.close();
      };
      await write(`${'f'.repeat(32)}.md`, 'URL: https://pages-fixture.example/page-1#updated\nTitle: 浏览器操作指南 1（更新）\n\n更新后的网页快照');
      await write('notes.md', '这是普通文件，不是自动保存的网页');
      delete task.visitedPages;
      const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('bwai'); request.onsuccess = () => resolve(request.result); });
      await new Promise<void>(resolve => { const tx = db.transaction('tasks', 'readwrite'); tx.objectStore('tasks').put(task); tx.oncomplete = () => { db.close(); resolve(); }; });
    }, task);
    await h.page.reload();
    await history.locator(':scope > summary').click();
    await expect(guide.locator('.page-title')).toHaveText('浏览器操作指南 1（更新）');
    await expect(guide.locator('.page-versions > summary')).toHaveText('2 份网页快照');
    await guide.getByRole('button', { name: '预览 浏览器操作指南 1（更新） 的 Markdown', exact: true }).click();
    await expect(dialog.locator('pre')).toContainText('更新后的网页快照');
    await h.page.keyboard.press('Escape');
    await guide.locator('.page-versions > summary').click();
    await guide.locator('.page-versions button').last().click();
    await expect(dialog.locator('pre')).not.toContainText('更新后的网页快照');
    await h.page.keyboard.press('Escape');
    const files = h.page.getByTestId('workspace-files');
    await files.locator('summary').click();
    await expect(files.getByRole('button', { name: '预览 pages/notes.md', exact: true })).toBeVisible();
    await expect(files.locator('.file-item')).toHaveCount(1);
    await files.locator('summary').click();
    await h.page.setViewportSize({ width: 380, height: 760 });
    await h.page.screenshot({ path: path.join(h.dir, 'page-resources.png') });
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});
