import type { BrowserContext } from '@playwright/test';
import type { BrowserAction } from '../../../src/shared/types';
import { modelInput } from '../../fixtures/model-input';

export interface ModelHold { active: boolean; reached: boolean; phase?: 'decide' | 'result' }
const isFormTask = (input: { goal: string; conversation?: { role: string; content: string }[] }) => input.goal.includes('填写并提交表单') || input.conversation?.some(m => m.role === 'user' && m.content.includes('填写并提交表单'));

/** Simulated model decisions shared by the extension scenarios. */
export async function installModelFixture(context: BrowserContext, requests: string[], hold: ModelHold) {
  await context.route('https://model-fixture.example/**', async route => {
    requests.push(route.request().postData() ?? '');
    const body = route.request().postDataJSON();
    // Requests may carry images: user content is then a list whose text part holds the input.
    const text = (content: unknown) => Array.isArray(content) ? content.find((part: { type: string }) => part.type === 'text')?.text ?? '' : content as string;
    const system = text(body.messages[0].content);
    let message: Record<string, unknown>;
    // The image-input check: this fixture model cannot read images.
    if (body.messages.length === 1 && Array.isArray(body.messages[0].content)) message = { content: 'I cannot see the image.' };
    else if (body.tool_choice?.function?.name === 'connection_test') message = { content: null, tool_calls: [{ id: 'test', type: 'function', function: { name: 'connection_test', arguments: '{"ok":true}' } }] };
    // Only one fixture goal gets a name, so other tests keep seeing the goal as the title.
    else if (system.includes('BWAI_TITLE')) message = { content: modelInput(body).goal === '查找浏览器操作指南' ? '“浏览器指南”' : '' };
    else if (system.includes('BWAI_PROGRESS')) message = { content: '已搜索操作指南，还没有打开指南页面。' };
    else {
      const input = modelInput(body);
      if (hold.active && hold.phase !== 'result' && input.observations.some((item: any) => item.snapshot?.url === 'https://pages-fixture.example/page-1')) {
        hold.reached = true;
        while (hold.active && !context.pages().every(p => p.isClosed())) await new Promise(r => setTimeout(r, 50));
      }
      const latest = input.observations.at(-1);
      const last = latest?.kind === 'observation' ? latest : undefined;
      if (input.goal.includes('运行沙箱代码')) {
        const probe = [
          "await files.write('data/nums.txt', '3\\n1\\n2');",
          "const nums = (await files.read('data/nums.txt')).split('\\n').map(Number).sort((a, b) => a - b);",
          "console.log('sorted', nums);",
          "await files.write('data/sorted.txt', nums.join(','));",
          "await files.writeBytes('data/raw.bin', new Uint8Array([0, 255, 7])); const raw = [...await files.readBytes('data/raw.bin')];",
          "let binaryText = 'readable'; try { await files.read('data/raw.bin'); } catch (error) { binaryText = error.message; }",
          "let network = 'allowed'; try { await fetch('https://pages-fixture.example/page-1'); } catch { network = 'blocked'; }",
          "let storage = 'open'; try { await new Promise((resolve, reject) => { const request = indexedDB.open('bwai'); request.onsuccess = resolve; request.onerror = reject; }); } catch { storage = 'denied'; }",
          "let escape = 'none'; try { await files.read('../other/secret.txt'); escape = 'read'; } catch (error) { escape = error.message; }",
          "return { nums, raw, binaryText, network, storage, extension: typeof chrome !== 'undefined' && !!chrome.runtime?.id, escape, files: (await files.list()).map(file => file.path).sort() };",
        ].join('\n');
        const code = [probe, 'while (true) {}'][input.observations.length];
        const fn = code ? { name: 'run_code', arguments: JSON.stringify({ code }) }
          : { name: 'finish_task', arguments: JSON.stringify({ outcome: 'success', answer: '代码已运行', verification: '沙箱返回了排序结果' }) };
        message = { content: null, tool_calls: [{ id: crypto.randomUUID(), type: 'function', function: fn }] };
      } else if (input.goal.includes('生成 Word 报告')) {
        const code = "const markdown = '# 周报\\n\\n本周完成 **3** 项任务。\\n\\n| 任务 | 状态 |\\n| --- | --- |\\n| 发货 | 完成 |\\n\\n![图表](uploads/chart.png)';"
          + " await files.writeBytes('周报.docx', await markdownToDocx(markdown, { images: files.readBytes })); return (await files.list()).find(file => file.path === '周报.docx').size;";
        const fn = input.observations.length ? { name: 'finish_task', arguments: JSON.stringify({ outcome: 'success', answer: '已生成周报', verification: '周报.docx 已写入' }) }
          : { name: 'run_code', arguments: JSON.stringify({ code }) };
        message = { content: null, tool_calls: [{ id: crypto.randomUUID(), type: 'function', function: fn }] };
      } else if (input.goal.includes('读取附件文档')) {
        // Read each document, then summarise the spreadsheet with SheetJS in the sandbox.
        const reads = ['uploads/报价.xlsx', 'uploads/说明.docx', 'uploads/manual.pdf'];
        const summary = "const book = XLSX.read(await files.readBytes('uploads/报价.xlsx')); const rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]]);"
          + " const out = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(out, XLSX.utils.json_to_sheet([{ 合计: rows.reduce((sum, row) => sum + row.价格, 0) }]), '汇总');"
          + " await files.writeBytes('汇总.xlsx', XLSX.write(out, { type: 'array', bookType: 'xlsx' })); return { rows, docx: typeof mammoth.convertToHtml, pdf: typeof pdfjsLib.getDocument };";
        const step = input.observations.length;
        const fn = step < reads.length ? { name: 'workspace', arguments: JSON.stringify({ action: { name: 'read_file', path: reads[step] } }) }
          : step === reads.length ? { name: 'run_code', arguments: JSON.stringify({ code: summary }) }
          : { name: 'finish_task', arguments: JSON.stringify({ outcome: 'success', answer: '已读取文档', verification: '三个文档都读到了文字' }) };
        message = { content: null, tool_calls: [{ id: crypto.randomUUID(), type: 'function', function: fn }] };
      } else if (input.goal.includes('写入工作区文件')) {
        const fn = input.workspaceFiles.length ? { name: 'finish_task', arguments: JSON.stringify({ outcome: 'success', answer: '已保存价格表', verification: 'workspaceFiles 中已有 report/prices.csv' }) }
          : { name: 'workspace', arguments: JSON.stringify({ action: { name: 'write_file', path: 'report/prices.csv', content: '商品,价格\nA,10\n' } }) };
        message = { content: null, tool_calls: [{ id: crypto.randomUUID(), type: 'function', function: fn }] };
      } else if (isFormTask(input)) {
        if (input.goal.includes('需要补充标题') && !input.instructions.length) {
          message = { content: null, tool_calls: [{ id: crypto.randomUUID(), type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: '表单标题应该填写什么？' }) } }] };
        } else {
        const previousAction = last?.action?.arguments?.action ?? last?.action;
        const requested = input.instructions.at(-1)?.text ?? input.goal;
        const desiredTitle = requested.includes('续聊标题') ? '续聊标题' : requested.includes('新标题') ? '新标题' : 'BWAI 示例';
        let action: BrowserAction | undefined;
        let done: 'success' | 'incomplete' | undefined;
        if (last?.error?.includes('rejected')) done = 'incomplete';
        else if (last?.snapshot?.text.includes('已保存 ' + desiredTitle)) done = 'success';
        else if (!last?.snapshot || last.error) action = { name: 'read', tabId: input.currentPage.id };
        else {
          const snapshot = last.snapshot;
          const ref = (kind: string) => snapshot.elements.find((e: { kind: string }) => e.kind === kind).id;
          const base = { tabId: last.tabId, snapshotId: snapshot.snapshotId };
          if (previousAction?.name === 'fill') action = { name: 'select', ...base, elementId: ref('select'), value: 'books' };
          else if (previousAction?.name === 'select') action = { name: 'check', ...base, elementId: ref('checkbox'), checked: true };
          else if (previousAction?.name === 'check') action = { name: 'click', effect: 'write', ...base, elementId: snapshot.elements.find((e: { text: string }) => e.text === '保存').id };
          else action = { name: 'fill', ...base, elementId: ref('input'), value: desiredTitle };
        }
        message = { content: null, tool_calls: [{ id: 'form-call', type: 'function', function: action ? { name: 'browser', arguments: JSON.stringify({ action }) } : { name: 'finish_task', arguments: JSON.stringify({ outcome: done, answer: done === 'success' ? '已提交' : '用户拒绝提交', verification: done === 'success' ? '页面明确显示已保存' : '工具返回用户拒绝，未执行提交' }) } }] };
        }
      } else {
      const siteTask = input.goal.includes('catalog-fixture.example');
      const siteAction = !siteTask ? null : !last ? { name: 'open', url: 'https://catalog-fixture.example/' } : last.snapshot?.url.includes('search=') ? null
        : last.snapshot.elements.find((e: { kind: string }) => e.kind === 'input')?.value !== '星际旅行'
          ? { name: 'fill', tabId: last.tabId, snapshotId: last.snapshot.snapshotId, elementId: last.snapshot.elements.find((e: { kind: string }) => e.kind === 'input').id, value: '星际旅行', effect: 'read' }
          : { name: 'click', tabId: last.tabId, snapshotId: last.snapshot.snapshotId, elementId: last.snapshot.elements.find((e: { kind: string }) => e.kind === 'button').id, effect: 'read' };
      const action = siteTask ? siteAction : !input.observations.length ? { name: 'search', query: '浏览器操作指南' }
        : last?.snapshot?.url === 'https://pages-fixture.example/page-2' ? null
        : last?.snapshot?.url === 'https://pages-fixture.example/page-1' ? { name: 'follow', tabId: last.tabId, snapshotId: last.snapshot.snapshotId, elementId: last.snapshot.elements.find((e: { href?: string }) => e.href?.includes('page-2')).id }
        : { name: 'open', url: 'https://pages-fixture.example/page-1' };
      if (action) message = { content: null, tool_calls: [{ id: crypto.randomUUID(), type: 'function', function: { name: 'browser', arguments: JSON.stringify({ action }) } }] };
      else message = { content: null, tool_calls: [{ id: crypto.randomUUID(), type: 'function', function: { name: 'finish_task', arguments: JSON.stringify({ outcome: 'success', verification: '页面内容包含需要的结果', answer: siteTask ? '已读取实际站内搜索结果。' : '已打开指南和下一页。' }) } }] };
      }
    }
    const call = (message.tool_calls as { function: { name: string; arguments: string } }[] | undefined)?.[0];
    if (call?.function.name === 'finish_task') {
      const input = modelInput(body); const finish = JSON.parse(call.function.arguments);
      if (hold.active && hold.phase === 'result') { hold.reached = true; while (hold.active) await new Promise(resolve => setTimeout(resolve, 50)); }
      finish.answer = isFormTask(input) ? finish.outcome === 'success' ? '表单已提交，页面显示“已保存”，标题与分类已核对。' : '没有提交表单：用户拒绝了提交操作。'
        : input.goal.includes('catalog-fixture.example') ? '已完成站内搜索。'
        : '已打开操作指南并查看下一页。\n\n' + input.visitedUrls.filter((url: string) => url.includes('pages-fixture.example')).map((url: string) => `[查看页面](${url})`).join('\n');
      call.function.arguments = JSON.stringify(finish);
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', ...message } }] }) }).catch(() => {});
  });
}
