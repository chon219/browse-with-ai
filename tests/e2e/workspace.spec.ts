import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { modelInput } from '../fixtures/model-input';
import { pdfDocument, wordDocument, workbook } from '../fixtures/documents';
import { pngImage } from '../fixtures/images';
import { harness } from './support/harness';
import { start, readTasks } from './support/tasks';

test('files the agent writes are listed, previewed, downloaded and deleted with the conversation', async () => {
  const h = await harness();
  const workspaceEntries = () => h.page.evaluate(async () => {
    const names: string[] = [];
    try { for await (const name of (await (await navigator.storage.getDirectory()).getDirectoryHandle('tasks')).keys()) names.push(name); } catch { /* no workspace yet */ }
    return names;
  });
  try {
    await start(h.page, '写入工作区文件');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 60_000 });
    const files = h.page.getByTestId('workspace-files');
    await expect(files.locator('summary')).toContainText('1');
    await files.locator('summary').click();
    await files.getByRole('button', { name: '预览 report/prices.csv', exact: true }).click();
    const dialog = h.page.getByRole('dialog');
    await expect(dialog.getByRole('heading')).toHaveText('report/prices.csv');
    await expect.poll(() => dialog.locator('pre').textContent()).toBe('商品,价格\nA,10\n');
    const downloading = h.page.waitForEvent('download');
    await dialog.getByRole('button', { name: '下载', exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('prices.csv');
    expect((await readFile(await download.path())).toString('utf8')).toBe('\ufeff商品,价格\nA,10\n');
    await h.page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
    const [task] = await readTasks(h.page);
    expect(task.messages!.filter(message => message.role === 'activity').map(message => message.content).join('\n')).toContain('写入文件 · report/prices.csv');
    expect(await workspaceEntries()).toEqual([encodeURIComponent(task.id)]);
    await h.page.getByRole('button', { name: '删除对话', exact: true }).click();
    await h.page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
    await expect(h.page.getByTestId('new-thread')).toBeVisible();
    await expect.poll(workspaceEntries).toEqual([]);
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});

test('working notes survive into model requests and oversized code output is explicitly marked', async () => {
  const h = await harness();
  let step = 0;
  let notesInResult = false, sawTruncation = false;
  try {
    await h.context.route('https://model-fixture.example/**', async route => {
      const body = route.request().postDataJSON();
      const system = body.messages[0].content;
      const input = modelInput(body);
      let message: Record<string, unknown> = { content: 'Ready' };
      if (system.includes('BWAI_DECIDE')) {
        const fn = step++ === 0 ? { name: 'update_task_notes', arguments: JSON.stringify({ notes: 'Phone A: 27 hours. Phone B: 34 hours. Sources: https://a.example/ and https://b.example/. Remaining: none.' }) }
          : step === 2 ? { name: 'run_code', arguments: JSON.stringify({ code: 'console.log("x".repeat(25000)); console.log("ARCHIVE_TAIL"); return { compared: true };' }) }
          : { name: 'finish_task', arguments: JSON.stringify({ outcome: 'success', answer: 'Compared', verification: 'Both sources retained in task notes' }) };
        if (step === 3) {
          notesInResult = input.taskNotes.includes('Phone A: 27 hours') && input.taskNotes.includes('Phone B: 34 hours');
          const observation = input.observations.at(-1);
          sawTruncation = observation.code.truncated === true && observation.note.includes('truncated');
        }
        message = { content: null, tool_calls: [{ id: `notes-${step}`, type: 'function', function: fn }] };
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', ...message } }] }) });
    });
    await start(h.page, 'Compare the collected specifications');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 45000 });
    expect(step).toBe(3);
    expect(notesInResult).toBe(true);
    expect(sawTruncation).toBe(true);
    const task = (await readTasks(h.page))[0];
    expect(task.taskNotes).toContain('Phone A: 27 hours');
    const run = task.messages!.find(message => message.kind === 'code')!.code!;
    const archived = await h.page.evaluate(async ({ id, path }) => {
      let directory = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('tasks')).getDirectoryHandle(id);
      const parts = path.split('/'); for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
      return (await (await directory.getFileHandle(parts.at(-1)!)).getFile()).text();
    }, { id: task.id, path: run.outputFiles!.logs! });
    expect(archived).toContain('ARCHIVE_TAIL');
  } finally { await h.context.close(); }
});

test('agent code runs in a sandbox with workspace access only and is stopped when it runs too long', async () => {
  const h = await harness();
  try {
    await start(h.page, '运行沙箱代码');
    // Usage shows up while the task is still running (the second run takes ten seconds).
    await expect(h.page.getByTestId('token-usage')).toBeVisible();
    await expect(h.page.getByTestId('task-status')).toHaveText('执行中');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 60_000 });
    const [task] = await readTasks(h.page);
    const runs = task.messages!.filter(m => m.kind === 'code');
    // Naming, planning, three decisions and the result; the fixture model reports no usage, so every figure is an estimate.
    expect(task.usage).toMatchObject({ requests: 4, estimated: true });
    const tokens = (n: number) => n < 1000 ? String(n) : `${+(n / 1000).toFixed(1)}k`;
    await expect(h.page.getByTestId('token-usage').locator('.stat')).toHaveText([`上下文 ≈${tokens(task.usage!.contextTokens)}`, `消耗 ≈${tokens(task.usage!.promptTokens + task.usage!.completionTokens)} tokens`]);
    expect(runs).toHaveLength(2);
    expect(runs[0].code!.error).toBeUndefined();
    expect(runs[0].code!.logs).toBe('sorted [1,2,3]');
    expect(JSON.parse(runs[0].code!.result!)).toEqual({ nums: [1, 2, 3], raw: [0, 255, 7], binaryText: 'data/raw.bin is not a text file', network: 'blocked', storage: 'denied', extension: false, escape: 'Invalid file path: ../other/secret.txt', files: ['data/nums.txt', 'data/raw.bin', 'data/sorted.txt'] });
    expect(runs[0].code!.changedFiles).toEqual(['data/nums.txt', 'data/sorted.txt', 'data/raw.bin']);
    expect(runs[1]).toMatchObject({ content: '代码运行出错', code: { source: 'while (true) {}', error: { key: 'code.timeout' } } });
    const activity = h.page.getByTestId('code-run').first();
    await activity.locator('xpath=ancestor::details[contains(@class, "chat-activity")]').locator('summary').first().click();
    await activity.locator('summary').click();
    await expect(activity.locator('pre').first()).toContainText("files.write('data/sorted.txt'");
    const files = h.page.getByTestId('workspace-files');
    await files.locator('summary').click();
    await expect(files.getByRole('button', { name: '预览 data/sorted.txt', exact: true })).toBeVisible();
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});

test('text files attached to messages are stored under uploads and shown with the message', async () => {
  const h = await harness();
  const csv = (content: string) => ({ name: 'prices.csv', mimeType: 'text/csv', buffer: Buffer.from(content) });
  try {
    const draft = h.page.getByTestId('new-thread');
    await draft.getByTestId('attach-input').setInputFiles([csv('商品,价格\nA,10\n'), { name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(10_000_001) }]);
    // A file over 10 MB is refused with a reason; others wait as chips, with their size, until the message is sent.
    await expect(h.page.getByRole('alert')).toContainText('big.bin 超过 10 MB 上限');
    await expect(draft.locator('.file-chip')).toHaveText(['prices.csv19 B×']);
    await draft.getByTestId('attach-input').setInputFiles([{ name: 'extra.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }]);
    await draft.getByRole('button', { name: '移除 extra.txt', exact: true }).click();
    await expect(draft.locator('.file-chip')).toHaveCount(1);
    await start(h.page, '整理附件里的价格');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 60_000 });
    await expect(h.page.locator('.chat-message.user .message-files').first()).toHaveText('prices.csv19 B');
    const [task] = await readTasks(h.page);
    expect(task.messages![0]).toMatchObject({ id: 'initial', content: '整理附件里的价格', attachments: [{ path: 'uploads/prices.csv', size: 19, type: 'text/csv' }] });
    expect(h.requests.filter(body => body.includes('BWAI_DECIDE')).some(body => modelInput(JSON.parse(body)).conversation.some((message: { attachments?: unknown }) => JSON.stringify(message.attachments).includes('uploads/prices.csv')))).toBe(true);
    const files = h.page.getByTestId('workspace-files'); await files.locator('summary').click();
    await expect(files.getByRole('button', { name: '预览 uploads/prices.csv', exact: true })).toBeVisible();

    // A follow-up message can carry files too; a taken name gets a number.
    await h.page.locator('.chat-composer.inline').getByTestId('attach-input').setInputFiles([csv('A,9\n')]);
    await expect(h.page.locator('.composer-files .file-chip')).toHaveText(['prices.csv4 B×']);
    await h.page.getByLabel('消息', { exact: true }).fill('再对比这份新的价格');
    await h.page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(h.page.locator('.composer-files')).toHaveCount(0);
    await expect.poll(async () => (await readTasks(h.page))[0].messages!.filter(m => m.role === 'user').at(-1)?.attachments?.map(file => file.path)).toEqual(['uploads/prices (2).csv']);
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 60_000 });
    await expect(files.getByRole('button', { name: '预览 uploads/prices (2).csv', exact: true })).toBeVisible();
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});

test('images and other binary files go through the workspace, and images reach a model that accepts them', async () => {
  const h = await harness();
  const png = pngImage(2, 2);
  // Neither text nor an image.
  const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0xe2, 0xe3, 0xcf, 0xd3, 0x00]);
  const vision = () => h.page.evaluate(async () => ((await chrome.storage.local.get('settings')).settings as { visionInput?: boolean }).visionInput);
  try {
    // The connection test asked the fixture model to read an image, and it could not.
    expect(await vision()).toBe(false);
    expect(h.requests.some(body => body.includes('"image_url"') && body.includes('What number is shown'))).toBe(true);
    await h.page.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings as object, visionInput: true } }); });
    const draft = h.page.getByTestId('new-thread');
    await draft.getByTestId('attach-input').setInputFiles([{ name: 'error.png', mimeType: 'image/png', buffer: png }, { name: 'report.pdf', mimeType: 'application/pdf', buffer: pdf }]);
    await expect(draft.locator('.file-chip img')).toHaveCount(1);
    await expect(draft.locator('.file-chip small')).toHaveText([`${png.length} B`, `${pdf.length} B`]);
    await start(h.page, '看看截图里是什么');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 60_000 });
    // Every decision of the turn carries the image; a small image is sent as it is.
    const decide = h.requests.filter(body => body.includes('BWAI_DECIDE'));
    expect(decide.length).toBeGreaterThan(0);
    for (const body of decide) expect(body).toContain(`"image_url":{"url":"data:image/png;base64,${png.toString('base64')}"}`);
    await expect(h.page.locator('.chat-message.user .message-files img')).toHaveCount(1);
    const files = h.page.getByTestId('workspace-files'); await files.locator('summary').click();
    await files.getByRole('button', { name: '预览 uploads/error.png', exact: true }).click();
    const dialog = h.page.getByRole('dialog');
    await expect(dialog.locator('.file-image img')).toHaveJSProperty('naturalWidth', 2);
    await h.page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
    await files.getByRole('button', { name: '预览 uploads/report.pdf', exact: true }).click();
    await expect(dialog.locator('.file-unavailable')).toBeVisible();
    const downloading = h.page.waitForEvent('download');
    await dialog.getByRole('button', { name: '下载', exact: true }).click();
    expect(await readFile(await (await downloading).path())).toEqual(pdf);
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});

test('PDF, Word and Excel attachments are read as text in the sandbox, and code can use the document libraries', async () => {
  const h = await harness();
  const xlsx = Buffer.from(workbook({ 报价: [['商品', '价格'], ['A', 10], ['B', 12.5]] }));
  const docx = Buffer.from(await wordDocument('交付说明', '周五前发货。', [['项目', '负责人'], ['包装', '小王']]));
  const pdf = Buffer.from(pdfDocument(['Manual page one', 'Safety notes']));
  const type = (name: string) => name.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : name.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf';
  try {
    await h.page.getByTestId('new-thread').getByTestId('attach-input').setInputFiles(([['报价.xlsx', xlsx], ['说明.docx', docx], ['manual.pdf', pdf]] as const).map(([name, buffer]) => ({ name, mimeType: type(name), buffer })));
    await start(h.page, '读取附件文档并汇总');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 60_000 });
    // The last decision sees the three reads (the latest in full, earlier ones summarised) and the code's result.
    const last = JSON.parse(h.requests.filter(body => body.includes('BWAI_DECIDE')).at(-1)!);
    const observations = modelInput(last).observations;
    expect(observations.slice(0, 3).map((entry: { workspace: { file: { convertedFrom: string } } }) => entry.workspace.file.convertedFrom)).toEqual([type('.xlsx'), type('.docx'), type('.pdf')]);
    expect(observations[2].workspace.file.content).toBe('--- Page 1 ---\nManual page one\n\n--- Page 2 ---\nSafety notes');
    const decisions = h.requests.filter(body => body.includes('BWAI_DECIDE')).map(body => modelInput(JSON.parse(body)).observations.at(-1) ?? '');
    expect(decisions.some(entry => JSON.stringify(entry).includes('## Sheet: 报价\\n商品,价格\\nA,10\\nB,12.5'))).toBe(true);
    expect(decisions.some(entry => JSON.stringify(entry).includes('# 交付说明\\n\\n周五前发货。\\n\\n| 项目 | 负责人 |\\n| --- | --- |\\n| 包装 | 小王 |'))).toBe(true);
    expect(JSON.parse(observations[3].code.result)).toEqual({ rows: [{ 商品: 'A', 价格: 10 }, { 商品: 'B', 价格: 12.5 }], docx: 'function', pdf: 'function' });
    // The workbook the code wrote is a real spreadsheet: the panel reads it back.
    const files = h.page.getByTestId('workspace-files'); await files.locator('summary').click();
    const dialog = h.page.getByRole('dialog');
    await files.getByRole('button', { name: '预览 汇总.xlsx', exact: true }).click();
    await expect(dialog.locator('.file-content')).toHaveText('## Sheet: 汇总\n合计\n22.5');
    await h.page.keyboard.press('Escape');
    await files.getByRole('button', { name: '预览 uploads/说明.docx', exact: true }).click();
    await expect(dialog.locator('.file-content')).toContainText('| 包装 | 小王 |');
    await h.page.keyboard.press('Escape');
    await files.getByRole('button', { name: '预览 uploads/manual.pdf', exact: true }).click();
    await expect(dialog.locator('.file-content')).toContainText('Safety notes');
    const opened = h.context.waitForEvent('page');
    await dialog.getByRole('button', { name: '在新标签页中打开', exact: true }).click();
    expect((await opened).url()).toMatch(/^blob:chrome-extension:/);
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});

test('code writes Word documents from Markdown with workspace images', async () => {
  const h = await harness();
  try {
    await h.page.getByTestId('new-thread').getByTestId('attach-input').setInputFiles([{ name: 'chart.png', mimeType: 'image/png', buffer: pngImage(1200, 300) }]);
    await start(h.page, '生成 Word 报告');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 60_000 });
    const [task] = await readTasks(h.page);
    const run = task.messages!.find(m => m.kind === 'code')!.code!;
    expect(run.error).toBeUndefined(); expect(run.changedFiles).toEqual(['周报.docx']);
    // The image is embedded, so the document is larger than the text alone.
    expect(Number(run.result)).toBeGreaterThan(8000);
    const files = h.page.getByTestId('workspace-files'); await files.locator('summary').click();
    await files.getByRole('button', { name: '预览 周报.docx', exact: true }).click();
    await expect(h.page.getByRole('dialog').locator('.file-content')).toHaveText('# 周报\n\n本周完成 3 项任务。\n\n| 任务 | 状态 |\n| --- | --- |\n| 发货 | 完成 |');
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});

test('Markdown and HTML files open in a print page with workspace images and nothing remote', async () => {
  const h = await harness();
  const remote: string[] = []; await h.context.route('https://tracker.example/**', route => { remote.push(route.request().url()); return route.abort(); });
  const report = '# 季度报告\n\n| 商品 | 价格 |\n| --- | --- |\n| A | 10 |\n\n![图表](chart.png)\n\n![外链](https://tracker.example/pixel.png)\n\n<script>alert(1)</script>';
  const page = '<html><head><title>网页版</title><style>h1{color:rgb(200, 0, 0)}</style></head><body><h1>HTML 报告</h1><img src="chart.png"><script>document.title="changed"</script><img src="https://tracker.example/b.png"></body></html>';
  try {
    await h.page.getByTestId('new-thread').getByTestId('attach-input').setInputFiles([
      { name: 'report.md', mimeType: 'text/markdown', buffer: Buffer.from(report) }, { name: 'page.html', mimeType: 'text/html', buffer: Buffer.from(page) }, { name: 'chart.png', mimeType: 'image/png', buffer: pngImage(40, 20) }]);
    await start(h.page, '写入工作区文件');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 60_000 });
    const files = h.page.getByTestId('workspace-files'); await files.locator('summary').click();
    const dialog = h.page.getByRole('dialog');
    const openPrint = async (path: string) => {
      await files.getByRole('button', { name: `预览 ${path}`, exact: true }).click();
      const opened = h.context.waitForEvent('page');
      await dialog.getByRole('button', { name: '打印 / 存为 PDF', exact: true }).click();
      const print = await opened; await h.page.keyboard.press('Escape');
      await expect(print).toHaveTitle(`${path.split('/').pop()} · 打印`);
      return print.frameLocator('iframe.print-frame');
    };
    const markdown = await openPrint('uploads/report.md');
    await expect(markdown.locator('h1')).toHaveText('季度报告');
    await expect(markdown.locator('td')).toHaveText(['A', '10']);
    // The workspace image is inlined; the remote one and the raw HTML are dropped.
    await expect(markdown.locator('img[alt="图表"]')).toHaveJSProperty('naturalWidth', 40);
    await expect(markdown.locator('img[alt="外链"]')).not.toHaveAttribute('src');
    await expect(markdown.locator('script')).toHaveCount(0);
    expect(await markdown.locator('html').evaluate(() => document.title)).toBe('report');
    const html = await openPrint('uploads/page.html');
    // An HTML file keeps its own styles and title; its scripts never run.
    await expect(html.locator('h1')).toHaveCSS('color', 'rgb(200, 0, 0)');
    await expect(html.locator('img').first()).toHaveJSProperty('naturalWidth', 40);
    expect(await html.locator('html').evaluate(() => document.title)).toBe('网页版');
    expect(remote).toEqual([]);
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});

test('large images are scaled down before they are sent to the model', async () => {
  const h = await harness();
  try {
    await h.page.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings as object, visionInput: true } }); });
    await h.page.getByTestId('new-thread').getByTestId('attach-input').setInputFiles([{ name: 'wide.png', mimeType: 'image/png', buffer: pngImage(3200, 400) }]);
    await start(h.page, '看看这张长图');
    await expect(h.page.getByTestId('task-status')).toHaveText('已完成', { timeout: 60_000 });
    const body = JSON.parse(h.requests.find(request => request.includes('BWAI_DECIDE'))!);
    const url: string = body.messages[1].content.find((part: { type: string }) => part.type === 'image_url').image_url.url;
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true);
    const size = await h.page.evaluate(async source => { const image = new Image(); image.src = source; await image.decode(); return [image.naturalWidth, image.naturalHeight]; }, url);
    expect(size).toEqual([1568, 196]);
  } finally { await h.context.close(); }
});
