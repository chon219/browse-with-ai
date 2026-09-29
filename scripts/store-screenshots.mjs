import { chromium, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const extension = path.join(root, 'dist');
const at = '2026-09-29T09:40:00.000Z';
const data = {
  en: {
    directory: 'global', title: 'Sample sales overview',
    goal: 'Analyze this sample sales CSV and save a summary report.',
    heading: 'Sales at a glance', summary: '**$1,500** in revenue · **63** units · **4** products',
    columns: ['Product', 'Units', 'Revenue'], products: ['Notebook', 'Desk lamp', 'Water bottle', 'Backpack'],
    downloads: 'Download your [report](sales-report.md) or [summary CSV](sales-summary.csv).',
    history: ['Product comparison · Example', 'Reading notes · Example'],
    skills: [
      ['Compare products', 'Compare products using official sources. Organize key features, prices, and source links in a table.', 'Confirm the products and comparison criteria. Read official sources, record relevant details with links, and verify the final table.'],
      ['Analyze a spreadsheet', 'Summarize an attached spreadsheet, check its data, and save a report with the main findings.', 'Read the attached file. Check the columns and data types, calculate requested summaries, and verify totals before saving the report.'],
      ['Research a topic', 'Gather information from source pages and turn it into a concise report with references.', 'Confirm the topic and questions. Read relevant sources, organize findings with links, and check that the report answers the request.'],
    ],
  },
  'zh-CN': {
    directory: 'zh-CN', title: '示例销售数据分析',
    goal: '分析这份示例销售 CSV，并保存一份汇总报告。',
    heading: '销售数据一览', summary: '销售额 **$1,500** · 销量 **63 件** · **4 类商品**',
    columns: ['商品', '销量', '销售额'], products: ['笔记本', '台灯', '水杯', '背包'],
    downloads: '下载[分析报告](sales-report.md)或[汇总 CSV](sales-summary.csv)。',
    history: ['商品对比 · 示例', '阅读笔记 · 示例'],
    skills: [
      ['商品信息对比', '从官方来源比较商品，将主要功能、价格和来源链接整理成表格。', '确认商品和比较维度，读取官方来源，记录相关信息与链接，核对最终表格。'],
      ['电子表格分析', '汇总附件中的电子表格，检查数据，并将主要发现保存为报告。', '读取附件，检查列与数据类型，计算所需汇总指标，核对总数后保存报告。'],
      ['主题资料研究', '从来源网页收集资料，整理成带有参考链接的简明报告。', '确认主题与问题，读取相关来源，整理发现及链接，并检查报告是否回应用户要求。'],
    ],
  },
};

async function capture(page, directory, filename) {
  await page.evaluate(() => document.fonts.ready);
  await page.locator('.mark').evaluate(image => image.decode());
  await page.mouse.move(1279, 799);
  const destination = path.join(directory, filename);
  await page.screenshot({ path: destination, animations: 'disabled', omitBackground: false });
  const png = await readFile(destination);
  if (png.readUInt32BE(16) !== 1280 || png.readUInt32BE(20) !== 800 || png[24] !== 8 || png[25] !== 2) {
    throw new Error(`Expected a 1280 × 800, 24-bit RGB PNG: ${destination}`);
  }
  console.log(path.relative(root, destination));
}

for (const [locale, copy] of Object.entries(data)) {
  const directory = path.join(root, 'store', 'screenshots', copy.directory);
  await mkdir(directory, { recursive: true });
  const profile = await mkdtemp(path.join(tmpdir(), 'bwai-store-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true, locale, colorScheme: 'light',
      viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${id}/task.html`);
    await page.locator('.new-conversation-button').waitFor();

    const units = [18, 12, 24, 9], prices = [12, 35, 18, 48];
    const rows = copy.products.map((product, i) => [product, units[i], units[i] * prices[i]]);
    const table = [copy.columns.join(' | '), '--- | ---: | ---:', ...rows.map(row => `${row[0]} | ${row[1]} | $${row[2]}`)].join('\n');
    const answer = `## ${copy.heading}\n\n${copy.summary}\n\n${table}\n\n${copy.downloads}`;
    const csv = [copy.columns.join(','), ...rows.map(row => row.join(','))].join('\n') + '\n';
    const goalMessage = { id: 'initial', at, turn: 0, role: 'user', kind: 'message', content: copy.goal,
      attachments: [{ path: 'uploads/sample-sales.csv', name: 'sample-sales.csv', size: Buffer.byteLength(csv), type: 'text/csv' }] };
    const task = { id: 'store-sales-example', title: copy.title, goal: copy.goal, status: 'completed', outcome: 'success',
      createdAt: at, updatedAt: at, elapsedMs: 0, resultText: answer, messages: [goalMessage,
        { id: 'result', at, turn: 0, role: 'assistant', kind: 'result', content: answer, outcome: 'success' }] };
    const tasks = [task, ...copy.history.map((title, i) => ({ ...task, id: `store-history-${i}`, title, goal: title,
      createdAt: `2026-09-2${8 - i}T09:00:00.000Z`, messages: [], resultText: '' }))];
    const skills = copy.skills.map(([name, description, instructions], i) => ({ id: `store-skill-${i}`, name, description, instructions,
      version: 1, createdAt: at, updatedAt: at, sourceTaskId: task.id, sourceTurn: 0 }));

    await page.evaluate(async ({ locale, tasks, skills, csv, answer }) => {
      await chrome.storage.local.set({ language: locale });
      const open = name => new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      for (const [name, store, records] of [['bwai', 'tasks', tasks], ['bwai-skills', 'skills', skills]]) {
        const db = await open(name);
        await new Promise((resolve, reject) => {
          const tx = db.transaction(store, 'readwrite');
          for (const record of records) tx.objectStore(store).put(record);
          tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
        });
        db.close();
      }
      const root = await navigator.storage.getDirectory();
      const taskRoot = await (await root.getDirectoryHandle('tasks', { create: true })).getDirectoryHandle(tasks[0].id, { create: true });
      for (const [filename, content] of [['uploads/sample-sales.csv', csv], ['sales-summary.csv', csv], ['sales-report.md', answer]]) {
        const segments = filename.split('/'); let directory = taskRoot;
        for (const segment of segments.slice(0, -1)) directory = await directory.getDirectoryHandle(segment, { create: true });
        const writer = await (await directory.getFileHandle(segments.at(-1), { create: true })).createWritable();
        await writer.write(content); await writer.close();
      }
    }, { locale, tasks, skills, csv, answer });

    await page.reload();
    await expect(page.locator('.history-row')).toHaveCount(3);
    await expect(page.locator('.suggested-tasks button')).toHaveCount(5);
    await capture(page, directory, '01-start-a-task.png');

    await page.locator('.history-item').filter({ hasText: copy.title }).click();
    await expect(page.getByTestId('task-result')).toContainText(copy.heading);
    await expect(page.locator('.workspace-link')).toHaveCount(2);
    await page.getByRole('log').evaluate(element => { element.scrollTop = 0; });
    await capture(page, directory, '02-analyze-files.png');

    await page.locator('.new-conversation-button').click();
    await page.locator('.conversations .skill-nav-button').click();
    await expect(page.locator('.skill-dialog[open] .skill-option-main')).toHaveCount(3);
    await capture(page, directory, '03-reuse-skills.png');
    if (errors.length) throw new Error(errors.join('\n'));
  } finally {
    await context?.close();
    const resolved = await realpath(profile);
    const temporaryRoot = await realpath(tmpdir());
    if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('bwai-store-')) throw new Error('Unexpected browser profile path');
    await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}
