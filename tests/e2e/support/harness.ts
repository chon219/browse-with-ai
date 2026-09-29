import { expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { cp, mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { SearchEngine } from '../../../src/shared/search-engines';
import { setLocale } from '../../../src/i18n';
import { installModelFixture, type ModelHold } from './model-fixture';
import { installPageFixtures } from './page-fixtures';

// Tool results carry catalog keys; render them like the zh-CN test browser.
setLocale('zh-CN');

export type Harness = { context: BrowserContext; page: Page; id: string; dir: string; requests: string[]; errors: string[]; hold: ModelHold; launch: () => Promise<BrowserContext> };

export async function harness(grantWebAccess = true, searchEngine: SearchEngine = 'bing', grantFileAccess = false): Promise<Harness> {
  const root = path.resolve('test-results'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'extension-')); const extension = path.join(dir, 'dist');
  await cp(path.resolve('dist'), extension, { recursive: true });
  // Permission prompts are not supported in headless Chrome. Only the test copy is pre-granted.
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = grantWebAccess ? ['http://*/*', 'https://*/*'] : ['https://model-fixture.example/*'];
  if (grantFileAccess) manifest.host_permissions.push('file:///*');
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  const profile = path.join(dir, 'profile'); const requests: string[] = []; const errors: string[] = [];
  const hold: Harness['hold'] = { active: false, reached: false };
  const launch = async () => {
    const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, locale: 'zh-CN', viewport: { width: 1280, height: 950 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run', '--lang=zh-CN'] });
    context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
    await installModelFixture(context, requests, hold);
    await installPageFixtures(context);
    return context;
  };
  const context = await launch(); let worker = context.serviceWorkers()[0]; if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage(); await page.goto(`chrome-extension://${id}/task.html`);
  const optionsPage = context.waitForEvent('page'); await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = await optionsPage; await settings.waitForURL(`chrome-extension://${id}/settings.html`);
  await expect(settings.getByLabel('搜索引擎', { exact: true })).toHaveValue('browser');
  await settings.getByLabel('API Base URL').fill('https://model-fixture.example/v1');
  await settings.getByLabel('模型名称').fill('fixture-model'); await settings.getByLabel('API Key', { exact: true }).fill('fixture-secret');
  await settings.getByLabel('搜索引擎', { exact: true }).selectOption(searchEngine);
  await settings.getByLabel('记住到本机').check(); await settings.getByRole('button', { name: '保存并测试连接' }).click();
  await expect(settings.getByRole('status')).toContainText('连接成功');
  await settings.close(); await page.bringToFront();
  return { context, page, id, dir, requests, errors, hold, launch };
}
