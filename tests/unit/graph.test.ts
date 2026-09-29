import { Command } from '@langchain/langgraph/web';
import { modelResponse } from '../fixtures/model-response';
import { modelInput } from '../fixtures/model-input';
import { describe, expect, it, vi } from 'vitest';
import { createExtensionAgent } from '../../src/agent/extension-agent';
import { sendTaskMessage, getOperation, getTask, saveOperation, saveTask } from '../../src/storage/db';
import type { Task, BrowserResult } from '../../src/shared/types';
import { siteTargets } from '../../src/agent/site-intent';
import { readFile } from '../../src/storage/workspace';
import { fakeFileSystem } from '../fixtures/fake-file-system';
const config = { baseUrl: 'https://model.example/v1', model: 'mock', apiKey: 'key', remember: false, search: 'bing' as const };
const task = (): Task => ({ id: crypto.randomUUID(), goal: '打开指定网页', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resultText: '', elapsedMs: 0 });
const page = (): BrowserResult => ({ snapshot: { url: 'https://pages.example/guide', title: 'Guide', text: '页面已打开。', snapshotId: 's', elements: [] } });
function modelMock() {
  let decisions = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body); const system = body.messages[0].content; const input = modelInput(body);
    if (system.includes('BWAI_TITLE')) return modelResponse({ choices: [{ message: { content: '「打开指定网页」' } }] });


    expect(input).not.toHaveProperty('sources'); expect(input).not.toHaveProperty('evidence');
    const ready = input.observations.some((item: any) => !!item.snapshot);
    const fn = ready ? { name: 'finish_task', arguments: JSON.stringify({ outcome: 'success', answer: '页面已打开。',  verification: '实际页面已经返回' }) }
      : { name: 'browser', arguments: JSON.stringify({ action: { name: 'open', url: 'https://pages.example/guide' } }) };
    return modelResponse({ choices: [{ message: { content: null, tool_calls: [{ id: 'c' + ++decisions, type: 'function', function: fn }] } }] });
  }));
}
describe('browser task flow', () => {
  it('allows another control page while blocking repeated reads of the same cursor', async () => {
    const { readsSamePage } = await import('../../src/agent/state');
    const state = { pageSignature: '7|hash', unchangedReads: 2, pageCursor: '0:100' } as import('../../src/agent/state').State;
    expect(readsSamePage(state, { name: 'read', tabId: 7, frameId: 0, elementOffset: 100 })).toBe(true);
    expect(readsSamePage(state, { name: 'read', tabId: 7, frameId: 0, elementOffset: 200 })).toBe(false);
    expect(readsSamePage(state, { name: 'read', tabId: 7 })).toBe(false);
  });
  it('executes none of a multi-call response and asks the model to choose one', async () => {
    const t = task(); await saveTask(t); let decisions = 0;
    const browser = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (!body.messages[0].content.includes('BWAI_DECIDE')) return modelResponse({ choices: [{ message: { content: 'ok' } }] });
      decisions++;
      if (decisions === 2) expect(modelInput(body).observations.at(-1).text).toContain('None were executed');
      const calls = decisions === 1 ? [1, 2].map(n => ({ id: String(n), type: 'function', function: { name: 'browser', arguments: JSON.stringify({ action: { name: 'open', url: `https://example.com/${n}` } }) } }))
        : [{ id: 'finish', type: 'function', function: { name: 'finish_task', arguments: JSON.stringify({ outcome: 'incomplete', answer: 'No action', verification: 'Nothing executed' }) } }];
      return modelResponse({ choices: [{ message: { content: null, tool_calls: calls } }] });
    }));
    const graph = createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 0, browser });
    await graph.invoke({ messages: [], goal: t.goal, history: [], rounds: 0 }, { configurable: { thread_id: t.id } });
    expect(browser).not.toHaveBeenCalled(); expect(decisions).toBe(2);
  });
  it.each(['run_code', 'workspace'] as const)('stops identical repeated %s reads and lets the model choose its next action', async toolName => {
    fakeFileSystem(vi.stubGlobal);
    const t = task(); await saveTask(t);
    let decisions = 0;
    const runCode = vi.fn(async () => ({ logs: '', result: 'same evidence' }));
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body), system = body.messages[0].content;
      if (!system.includes('BWAI_DECIDE')) return modelResponse({ choices: [{ message: { content: 'ok' } }] });
      const input = modelInput(body);
      const refused = input.observations.some((entry: unknown) => JSON.stringify(entry).includes('Choose a different action'));
      decisions++;
      const fn = refused ? { name: 'finish_task', arguments: JSON.stringify({ outcome: 'success', answer: 'Evidence collected', verification: 'Repeated read stopped' }) }
        : { name: toolName, arguments: toolName === 'run_code' ? JSON.stringify({ code: 'return "same evidence";' }, null, decisions % 2 ? 2 : undefined) : JSON.stringify({ action: { name: 'list_files' } }) };
      return modelResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `repeat-${decisions}`, type: 'function', function: fn }] } }] });
    }));
    const graph = createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 10, runCode, browser: vi.fn() });
    const result = await graph.invoke({ messages: [], goal: t.goal, history: [], rounds: 0 }, { configurable: { thread_id: t.id } });
    expect(decisions).toBe(5);
    expect(result.outcome).toBe('success');
    if (toolName === 'run_code') expect(runCode).toHaveBeenCalledTimes(3);
  });
  it('stops repeating a call that keeps returning the same result, such as an empty list_tabs', async () => {
    const t = { ...task(), }; await saveTask(t); const seen: { observations: any[] }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); const system = body.messages[0].content; const input = modelInput(body);
      if (system.includes('BWAI_TITLE')) return modelResponse({ choices: [{ message: { content: '查看标签页' } }] });


      seen.push(input);
      const refused = input.observations.some((item: unknown) => JSON.stringify(item).includes('was not run again'));
      // A model that keeps listing tabs, until the executor refuses.
      const fn = refused ? { name: 'finish_task', arguments: JSON.stringify({ outcome: 'incomplete', answer: '没有页面', verification: '标签页列表为空' }) }
        : { name: 'browser', arguments: JSON.stringify({ action: { name: 'list_tabs' } }) };
      return modelResponse({ choices: [{ message: { content: null, tool_calls: [{ id: 'l' + seen.length, type: 'function', function: fn }] } }] });
    }));
    const browser = vi.fn(async (): Promise<BrowserResult> => ({ tabs: [], note: { key: 'bg.noTaskTabs' } }));
    const graph = createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 10, browser });
    const result = await graph.invoke({ messages: [], goal: t.goal, history: [], rounds: 0 }, { configurable: { thread_id: t.id } });
    expect(browser).toHaveBeenCalledTimes(3); expect(result.outcome).toBe('incomplete');
    const entries = seen.at(-1)!.observations;
    expect(entries.map(entry => entry.unchanged ?? false)).toEqual([false, true, true, false]);
    expect(entries[0].note).toContain('Open the requested or known source directly');
    expect(entries[1].note).toBe('This call returned the same result as the previous one; do something else.');
    expect(entries[3].error).toContain('Choose a different action');
  });
  it('marks repeated identical pages and stops re-reading a page that does not change', async () => {
    const t = { ...task(), }; await saveTask(t); const seen: { observations: any[] }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); const system = body.messages[0].content; const input = modelInput(body);
      if (system.includes('BWAI_TITLE')) return modelResponse({ choices: [{ message: { content: '读取页面' } }] });


      seen.push(input);
      const refused = input.observations.some((item: unknown) => JSON.stringify(item).includes('The page has not changed'));
      // A model stuck on reading the same page, until the executor refuses.
      const fn = refused ? { name: 'finish_task', arguments: JSON.stringify({ outcome: 'incomplete', answer: '页面不变', verification: '多次读取结果相同' }) }
        : { name: 'browser', arguments: JSON.stringify({ action: { name: 'read', tabId: 7 } }) };
      return modelResponse({ choices: [{ message: { content: null, tool_calls: [{ id: 'r' + seen.length, type: 'function', function: fn }] } }] });
    }));
    const browser = vi.fn(async (): Promise<BrowserResult> => ({ tabId: 7, snapshot: { url: 'https://pages.example/list', title: 'List', text: '同样的内容', snapshotId: crypto.randomUUID(), elements: [] } }));
    const graph = createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 10, browser });
    const result = await graph.invoke({ messages: [], goal: t.goal, history: [], rounds: 0 }, { configurable: { thread_id: t.id } });
    expect(browser).toHaveBeenCalledTimes(3); expect(result.outcome).toBe('incomplete');
    const entries = seen.at(-1)!.observations;
    expect(entries.map(entry => entry.unchanged ?? false)).toEqual([false, true, true, false]);
    expect(entries[1].note).toBe('The page is identical to the previous observation.');
    expect(entries[3].error).toContain('Reading again returns the same content');
    expect((await getTask(t.id))!.messages!.filter(message => message.role === 'activity').map(message => message.content)).toContain('页面反馈：页面没有变化，未再次读取。');
  });
  it('ends a conversational answer without forcing a plan or finish call', async () => {
    const t = { ...task(), goal: '微软 CEO 是谁' }; await saveTask(t); const seen: { observations: any[] }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); const system = body.messages[0].content; const input = modelInput(body);
      if (system.includes('BWAI_TITLE')) return modelResponse({ choices: [{ message: { content: '微软 CEO' } }] });


      seen.push(input);
      // First a reply without a tool, then the answer again next to finish_task.
      const message = seen.length === 1 ? { content: '微软现任 CEO 是萨提亚·纳德拉。' }
        : { content: '微软现任 CEO 是萨提亚·纳德拉，自 2014 年起任职。', tool_calls: [{ id: 'f', type: 'function', function: { name: 'finish_task', arguments: JSON.stringify({ outcome: 'success', answer: '已回答', verification: '常识' }) } }] };
      return modelResponse({ choices: [{ message }] });
    }));
    const graph = createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 10, browser: vi.fn() });
    const result = await graph.invoke({ messages: [], goal: t.goal, history: [], rounds: 0 }, { configurable: { thread_id: t.id } });
    expect(result.resultText).toContain('萨提亚·纳德拉');
    expect(seen).toHaveLength(1);
    expect((await getTask(t.id))!.messages!.filter(m => m.role === 'assistant')).toHaveLength(0);
  });
  it('shows model progress alongside tool calls without generating a separate plan', async () => {
    const t = task(); await saveTask(t); let decisions = 0;
    const plan = '我会打开相关页面，查询最近六个月的 LPR 数据，整理成表格。';
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); const system = body.messages[0].content;
      if (system.includes('BWAI_TITLE')) return modelResponse({ choices: [{ message: { content: 'LPR' } }] });


      decisions++;
      // The plan again (spaced differently), then a new update, then the end.
      const content = decisions === 1 ? plan.replace(/ /g, '') : decisions === 2 ? '页面已打开，开始读取表格。' : null;
      const fn = decisions < 3 ? { name: 'browser', arguments: JSON.stringify({ action: { name: 'open', url: 'https://pages.example/guide' } }) }
        : { name: 'finish_task', arguments: JSON.stringify({ outcome: 'success', answer: '已整理', verification: '表格已生成' }) };
      return modelResponse({ choices: [{ message: { content, tool_calls: [{ id: 'l' + decisions, type: 'function', function: fn }] } }] });
    }));
    const graph = createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 10, browser: vi.fn(async () => page()) });
    await graph.invoke({ messages: [], goal: t.goal, history: [], rounds: 0 }, { configurable: { thread_id: t.id } });
    expect((await getTask(t.id))!.messages!.filter(m => m.role === 'assistant').map(m => m.content)).toEqual([plan.replace(/ /g, ''), '页面已打开，开始读取表格。']);
  });
  it('treats a scrolled or changed page as new', async () => {
    const { pageSignature } = await import('../../src/agent/state');
    const base = { url: 'https://pages.example/list', title: 'List', text: 'a', snapshotId: 's1', elements: [] };
    expect(pageSignature(1, base)).toBe(pageSignature(1, { ...base, snapshotId: 's2' }));
    expect(pageSignature(1, base)).not.toBe(pageSignature(2, base));
    expect(pageSignature(1, base)).not.toBe(pageSignature(1, { ...base, scroll: { top: 800, height: 4000, atBottom: false } }));
    expect(pageSignature(1, base)).not.toBe(pageSignature(1, { ...base, viewText: 'b' }));
  });
  it('runs code through the sandbox dependency and records it in the activity log', async () => {
    const t = task(); await saveTask(t); const browser = vi.fn(); const seen: { observations: any[] }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); const system = body.messages[0].content; const input = modelInput(body);
      if (system.includes('BWAI_TITLE')) return modelResponse({ choices: [{ message: { content: '测试任务' } }] });


      expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toContain('run_code');
      seen.push(input);
      const fn = input.observations.length ? { name: 'finish_task', arguments: JSON.stringify({ outcome: 'success', answer: '已计算', verification: '代码返回 6' }) }
        : { name: 'run_code', arguments: JSON.stringify({ code: 'return [1, 2, 3].reduce((a, b) => a + b)' }) };
      return modelResponse({ choices: [{ message: { content: null, tool_calls: [{ id: 'r' + seen.length, type: 'function', function: fn }] } }] });
    }));
    const runCode = vi.fn(async () => ({ logs: 'summing', result: '6' }));
    const graph = createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 10, browser, runCode });
    const result = await graph.invoke({ messages: [], goal: t.goal, history: [], rounds: 0 }, { configurable: { thread_id: t.id } });
    expect(runCode).toHaveBeenCalledWith('return [1, 2, 3].reduce((a, b) => a + b)'); expect(browser).not.toHaveBeenCalled();
    expect(result.outcome).toBe('success');
    expect(seen[1].observations[0].code).toEqual({ logs: 'summing', result: '6' });
    const record = (await getTask(t.id))!.messages!.find(m => m.kind === 'code');
    expect(record).toMatchObject({ role: 'activity', content: '代码已运行', code: { source: 'return [1, 2, 3].reduce((a, b) => a + b)', result: '6' } });
  });
  it('reads documents as their extracted text, slice by slice, and reports documents that cannot be read', async () => {
    fakeFileSystem(vi.stubGlobal); const t = task(); await saveTask(t); const seen: { observations: any[] }[] = [];
    const { workspaceWriteBytes } = await import('../../src/storage/db');
    await workspaceWriteBytes(t.id, 'uploads/报价.docx', new Uint8Array([0x50, 0x4b, 3, 4, 0xff]));
    await workspaceWriteBytes(t.id, 'uploads/broken.pdf', new Uint8Array([0x25, 0x50, 0xff]));
    const reads = [{ path: 'uploads/报价.docx' }, { path: 'uploads/报价.docx', offset: 12_000 }, { path: 'uploads/broken.pdf' }];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); const system = body.messages[0].content; const input = modelInput(body);
      if (!system.includes('BWAI_DECIDE')) return modelResponse({ choices: [{ message: { content: '好的' } }] });
      seen.push(input); const read = reads[seen.length - 1];
      const fn = read ? { name: 'workspace', arguments: JSON.stringify({ action: { name: 'read_file', ...read } }) }
        : { name: 'finish_task', arguments: JSON.stringify({ outcome: 'success', answer: '已读取', verification: '读到了内容' }) };
      return modelResponse({ choices: [{ message: { content: null, tool_calls: [{ id: 'd' + seen.length, type: 'function', function: fn }] } }] });
    }));
    const { LocalizedError } = await import('../../src/i18n');
    const readDocument = vi.fn(async (_path: string, kind: string) => {
      if (kind === 'pdf') throw new LocalizedError('document.failed', { reason: 'InvalidPDFException: Invalid PDF structure.' });
      return '# 报价\n' + '价'.repeat(15_000);
    });
    const graph = createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 10, browser: vi.fn(), readDocument });
    await graph.invoke({ messages: [], goal: t.goal, history: [], rounds: 0 }, { configurable: { thread_id: t.id } });
    expect(readDocument.mock.calls).toEqual([['uploads/报价.docx', 'docx'], ['uploads/报价.docx', 'docx'], ['uploads/broken.pdf', 'pdf']]);
    const [first, second, broken] = seen.at(-1)!.observations;
    // Recent file reads remain intact while the history fits its token budget.
    expect(first.workspace.file).toMatchObject({ path: 'uploads/报价.docx', totalChars: 15_005, nextOffset: 12_000, convertedFrom: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    expect(second.workspace.file).toMatchObject({ content: '价'.repeat(3005), totalChars: 15_005, convertedFrom: expect.any(String) });
    expect(second.workspace.file).not.toHaveProperty('nextOffset');
    expect(broken.error).toBe('Could not read the document: InvalidPDFException: Invalid PDF structure.');
  });
  it('writes workspace files without the browser and lists them for later decisions', async () => {
    fakeFileSystem(vi.stubGlobal); const t = task(); await saveTask(t); const browser = vi.fn(); const seen: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); const system = body.messages[0].content; const input = modelInput(body);
      if (system.includes('BWAI_TITLE')) return modelResponse({ choices: [{ message: { content: '测试任务' } }] });


      seen.push(input);
      const fn = input.workspaceFiles.length ? { name: 'finish_task', arguments: JSON.stringify({ outcome: 'success', answer: '已保存', verification: '文件已写入' }) }
        : { name: 'workspace', arguments: JSON.stringify({ action: { name: 'write_file', path: 'notes.md', content: '# 结果' } }) };
      return modelResponse({ choices: [{ message: { content: null, tool_calls: [{ id: 'w' + seen.length, type: 'function', function: fn }] } }] });
    }));
    const graph = createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 10, browser });
    const result = await graph.invoke({ messages: [], goal: t.goal, history: [], rounds: 0 }, { configurable: { thread_id: t.id } });
    expect(browser).not.toHaveBeenCalled(); expect(result.outcome).toBe('success');
    expect(await readFile(t.id, 'notes.md')).toBe('# 结果');
    const observation = (seen[1] as { observations: any[] }).observations[0];
    expect(observation.workspace.written).toMatchObject({ path: 'notes.md' }); expect(observation.action.arguments.action).toEqual({ name: 'write_file', path: 'notes.md', content: '[4 characters saved to notes.md]' });
  });
  it('records workspace writes and code runs so a replay after a crash never repeats them', async () => {
    fakeFileSystem(vi.stubGlobal); const t = task(); await saveTask(t); const seen: { observations: any[] }[] = [];
    const calls = [{ name: 'workspace', arguments: JSON.stringify({ action: { name: 'write_file', path: 'notes.md', content: '# 结果' } }) }, { name: 'run_code', arguments: JSON.stringify({ code: 'return 1' }) }];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); const system = body.messages[0].content; const input = modelInput(body);
      if (!system.includes('BWAI_DECIDE')) return modelResponse({ choices: [{ message: { content: '好的' } }] });
      seen.push(input);
      const fn = calls[seen.length - 1] ?? { name: 'finish_task', arguments: JSON.stringify({ outcome: 'incomplete', answer: '结果未知', verification: '没有重复执行' }) };
      return modelResponse({ choices: [{ message: { content: null, tool_calls: [{ id: 'x' + seen.length, type: 'function', function: fn }] } }] });
    }));
    // A crash after the write started, and a code run that finished before its checkpoint.
    const at = new Date().toISOString();
    await saveOperation({ id: `${t.id}:1:x1`, taskId: t.id, action: { name: 'workspace', action: { name: 'write_file', path: 'notes.md', content: '# 结果' } }, phase: 'pending', startedAt: at });
    await saveOperation({ id: `${t.id}:2:x2`, taskId: t.id, action: { name: 'run_code', code: 'return 1' }, phase: 'done', startedAt: at, result: { code: { logs: '', result: '1' } } });
    const runCode = vi.fn(async () => ({ logs: '', result: '2' }));
    const graph = createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 10, browser: vi.fn(), runCode });
    await graph.invoke({ messages: [], goal: t.goal, history: [], rounds: 0 }, { configurable: { thread_id: t.id } });
    const [write, run] = seen.at(-1)!.observations;
    expect(write.error).toContain('result is unknown'); expect(run.code).toMatchObject({ result: '1' });
    expect(runCode).not.toHaveBeenCalled(); await expect(readFile(t.id, 'notes.md')).rejects.toThrow();
    expect(await getOperation(`${t.id}:1:x1`)).toMatchObject({ phase: 'done', result: { error: { key: 'bg.unknownResult' } } });
  });
  it('uses website hints and completes from page observations', async () => {
    expect(siteTargets('去 byr.pt 搜索资源')).toEqual(['https://byr.pt/']);
    expect(siteTargets('Google site:byr.pt 资源')).toEqual([]);
    modelMock(); const t = task(); await saveTask(t); const browser = vi.fn(async () => page());
    const graph = createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 10, browser });
    const result = await graph.invoke({ messages: [], goal: t.goal, history: [], rounds: 0 }, { configurable: { thread_id: t.id } });
    expect(browser).toHaveBeenCalledTimes(1); expect(result.resultText).toBe('页面已打开。'); expect(result.outcome).toBe('success');
    expect((await getTask(t.id))!.title).toBe('打开指定网页');
    expect(result).not.toHaveProperty('evidence');
  });
  it('persists a human interrupt and resumes without repeating the previous action', async () => {
    modelMock(); const t = task(); await saveTask(t); let calls = 0;
    const browser = async (): Promise<BrowserResult> => ++calls === 1 ? { blocked: '请完成验证码' } : page();
    const make = () => createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 100, browser });
    const cfg = { configurable: { thread_id: t.id }, durability: 'sync' as const };
    await make().invoke({ messages: [], goal: t.goal, history: [], rounds: 0 }, cfg);
    expect((await make().graph.getState(cfg)).tasks.some(task => task.interrupts?.length)).toBe(true);
    const result = await make().invoke(new Command({ resume: true }), cfg);
    expect(result.resultText).toBe('页面已打开。'); expect(calls).toBe(2);
  });
  it('steers the next decision without a separate planning call or lost evidence', async () => {
    const t = task(); await saveTask(t); const decisions: { plan: string; observations: any[] }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); const system = body.messages[0].content; const input = modelInput(body);
      if (system.includes('BWAI_TITLE')) return modelResponse({ choices: [{ message: { content: 'LPR' } }] });


      decisions.push(input);
      const fn = decisions.length === 1 ? { name: 'browser', arguments: JSON.stringify({ action: { name: 'open', url: 'https://pages.example/guide' } }) }
        : { name: 'finish_task', arguments: JSON.stringify({ outcome: 'success', answer: '已查询', verification: '页面显示天气' }) };
      return modelResponse({ choices: [{ message: { content: null, tool_calls: [{ id: 'p' + decisions.length, type: 'function', function: fn }] } }] });
    }));
    // The user changes the request while the first page is opening.
    const browser = vi.fn(async () => { await sendTaskMessage(t.id, '算了，改为查一下今天的天气'); return page(); });
    const graph = createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 10, browser });
    const result = await graph.invoke({ messages: [], goal: t.goal, history: [], rounds: 0 }, { configurable: { thread_id: t.id } });
    expect(decisions[1]).toMatchObject({ instructions: [{ text: '算了，改为查一下今天的天气' }] });
    expect(decisions[1].observations.some(entry => JSON.stringify(entry).includes('https://pages.example/guide'))).toBe(true);
    expect(result.rounds).toBe(2); expect(browser).toHaveBeenCalledTimes(1);
  });
  it('does not plan again for an answer to its own question', async () => {
    const t = task(); await saveTask(t); let decisions = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); const system = body.messages[0].content;
      if (system.includes('BWAI_TITLE')) return modelResponse({ choices: [{ message: { content: '填写表单' } }] });


      const fn = ++decisions === 1 ? { name: 'ask_user', arguments: JSON.stringify({ question: '标题填什么？' }) }
        : { name: 'finish_task', arguments: JSON.stringify({ outcome: 'success', answer: '已填写。',  verification: '标题已填' }) };
      return modelResponse({ choices: [{ message: { content: null, tool_calls: [{ id: 'q' + decisions, type: 'function', function: fn }] } }] });
    }));
    const make = () => createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 10, browser: vi.fn() });
    const cfg = { configurable: { thread_id: t.id }, durability: 'sync' as const };
    await make().invoke({ messages: [], goal: t.goal, history: [], rounds: 0 }, cfg);
    await sendTaskMessage(t.id, '标题用“季度报告”');
    const result = await make().invoke(new Command({ resume: true }), cfg);
    expect(result.resultText).toBe('已填写。'); expect(decisions).toBe(2);
  });
  it('keeps acting despite a long total task duration', async () => {
    modelMock(); const t = task(); await saveTask(t); const browser = vi.fn(async () => page());
    const graph = createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 1_000_000, browser });
    const result = await graph.invoke({ messages: [], goal: t.goal, history: [], rounds: 0 }, { configurable: { thread_id: t.id } });
    expect(browser).toHaveBeenCalled(); expect(result.pause).toBeNull(); expect(result.resultText).not.toBe('');
    expect((await graph.graph.getState({ configurable: { thread_id: t.id } })).next).toEqual([]);
  });
  it('reads user additions and returns an ordinary response', async () => {
    const t = task(); await saveTask(t); await sendTaskMessage(t.id, '只填写，不要提交');
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); const input = modelInput(body);
      const message = body.messages[0].content.includes('BWAI_TITLE') ? { content: '填写字段' } : (() => {
        expect(input.instructions[0].text).toBe('只填写，不要提交');
        return { content: null, tool_calls: [{ id: 'done', type: 'function', function: { name: 'finish_task', arguments: "{\"outcome\":\"success\",\"answer\":\"已填写指定字段，没有提交表单。\",\"verification\":\"字段值与要求一致\"}" } }] };
      })();
      return modelResponse({ choices: [{ message }] });
    }));
    const graph = createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 10, browser: vi.fn() });
    const result = await graph.invoke({ messages: [], goal: t.goal, history: [], rounds: 0 }, { configurable: { thread_id: t.id } });
    expect(result.resultText).toBe('已填写指定字段，没有提交表单。');
  });
});
