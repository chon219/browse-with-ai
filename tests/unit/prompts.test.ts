import { describe, expect, it } from 'vitest';
import { CONTEXT } from '../../src/shared/tuning';
import { estimateTokens } from '../../src/shared/usage';
import { appendHistory, callForHistory, modelHistory, summarizeObservation, taskTitle, type HistoryEntry, type ObservationEntry } from '../../src/agent/prompts';
import type { Task } from '../../src/shared/types';

const page = (url: string, text = 'x'.repeat(2000)): ObservationEntry => ({ kind: 'observation', action: { id: url, tool: 'browser', arguments: { action: { name: 'read', tabId: 1 } } }, tabId: 1,
  snapshot: { url, title: url, text, snapshotId: 's-' + url, elements: [{ id: 'e1', kind: 'link', text: 'a' }] } });
const observation = (entry: HistoryEntry): ObservationEntry => {
  if (entry.kind !== 'observation') throw new Error('Expected an observation');
  return entry;
};

describe('task titles', () => {
  it('cleans up the model reply', () => {
    expect(taskTitle('「京东隔尿垫比价」')).toBe('京东隔尿垫比价');
    expect(taskTitle('标题：京东隔尿垫比价。\n这是一个比价任务')).toBe('京东隔尿垫比价');
    expect(taskTitle('"Compare  diaper pad prices."')).toBe('Compare diaper pad prices');
    expect(taskTitle('x'.repeat(60))).toHaveLength(40);
    for (const empty of ['', '  ', '“”', null, undefined]) expect(taskTitle(empty)).toBeUndefined();
  });
});

describe('observation history', () => {
  it('keeps native call/result pairs intact after context compaction', () => {
    let history: HistoryEntry[] = [];
    for (let i = 0; i < 40; i++) history = appendHistory(history, page(`https://example.com/${i}`, 'x'.repeat(8000)));
    const task = { goal: 'Read pages', createdAt: '', turn: 0 } as Task;
    const messages = modelHistory(task, history);
    const results = messages.filter(message => message.role === 'tool');
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBe(history.length);
    for (const result of results) {
      const preceding = messages[messages.indexOf(result) - 1];
      expect(preceding.role).toBe('assistant');
      expect(preceding.tool_calls?.[0].id).toBe(result.tool_call_id);
    }
    const last = JSON.parse(results.at(-1)!.content as string);
    expect(last.snapshot.snapshotId).toBe('s-https://example.com/39');
  });
  it('expires old page references without discarding their evidence', () => {
    let history: HistoryEntry[] = [];
    for (const url of ['https://a.example/', 'https://b.example/', 'https://c.example/']) history = appendHistory(history, page(url));
    const parsed = history.map(observation);
    expect(parsed.map(entry => entry.snapshot!.url)).toEqual(['https://a.example/', 'https://b.example/', 'https://c.example/']);
    expect(parsed.slice(0, 2).every(entry => entry.snapshot!.summary && !entry.snapshot!.elements && !entry.snapshot!.snapshotId && entry.snapshot!.text.length === 2000 && entry.snapshot!.elementCount === 1)).toBe(true);
    expect(parsed[2].snapshot).toMatchObject({ snapshotId: 's-https://c.example/', elements: [{ id: 'e1' }] }); expect(parsed[2].snapshot!.summary).toBeUndefined();
  });
  it('keeps the page evidence path after its observation is summarized', () => {
    const entry: ObservationEntry = { ...page('https://a.example/'), snapshot: { ...page('https://a.example/').snapshot!, source: 'dom', sourceFile: 'pages/evidence.md', textChars: 50000 } };
    expect(observation(summarizeObservation(entry)).snapshot).toMatchObject({ summary: true, sourceFile: 'pages/evidence.md', textChars: 50000 });
  });
  it('keeps the latest snapshot in full when notes follow it', () => {
    const history = appendHistory(appendHistory([page('https://a.example/')], 'The user just sent a new message.'), 'Another note');
    expect(observation(history[0]).snapshot!.elements).toHaveLength(1);
    expect(history.slice(1)).toEqual([{ kind: 'note', text: 'The user just sent a new message.' }, { kind: 'note', text: 'Another note' }]);
  });
  it('bounds the history and leaves non-snapshot entries unchanged', () => {
    let history: HistoryEntry[] = [];
    for (let i = 0; i < CONTEXT.history + 4; i++) history = appendHistory(history, `note ${i}`);
    expect(history).toEqual(Array.from({ length: CONTEXT.history }, (_, i) => ({ kind: 'note', text: `note ${i + 4}` })));
    const error: ObservationEntry = { kind: 'observation', action: { id: 'e', tool: 'browser', arguments: {} }, error: 'failed' };
    expect(summarizeObservation(error)).toBe(error);
    expect(summarizeObservation(summarizeObservation(page('https://a.example/')))).toEqual(summarizeObservation(page('https://a.example/')));
  });
  it('keeps multiple full file reads next to the latest snapshot', () => {
    const read = (path: string): ObservationEntry => ({ kind: 'observation', action: { id: path, tool: 'workspace', arguments: { action: { name: 'read_file', path } } }, workspace: { file: { path, content: 'y'.repeat(2000), totalChars: 2000 } } });
    const history = [read('old.md'), page('https://a.example/'), read('new.md')].reduce(appendHistory, [] as HistoryEntry[]);
    const [old, snapshot, latest] = history.map(observation);
    expect(old.workspace!.file!).toMatchObject({ path: 'old.md' }); expect(old.workspace!.file!.summary).toBeUndefined(); expect('content' in old.workspace!.file! && old.workspace!.file.content).toHaveLength(2000);
    expect(snapshot.snapshot!.summary).toBeUndefined();
    expect('content' in latest.workspace!.file! && latest.workspace!.file.content).toHaveLength(2000);
  });
  it('keeps recent code results intact when they fit the token budget', () => {
    const run = (n: number): ObservationEntry => ({ kind: 'observation', code: { logs: 'l'.repeat(2000), result: String(n) }, action: { id: 'c', tool: 'run_code', arguments: { code: 'c'.repeat(3000) } } });
    const [older, latest] = [run(1), run(2)].reduce(appendHistory, [] as HistoryEntry[]).map(observation);
    expect(older.code).toMatchObject({ result: '1' }); expect(older.code!.summary).toBeUndefined(); expect(older.code!.logs.length).toBe(2000);
    expect(latest.code!.logs).toHaveLength(2000); expect(latest.code!.summary).toBeUndefined();
  });
  it('retains complementary A/B results and compacts oldest results only under pressure', () => {
    const run = (name: string, text: string): ObservationEntry => ({ kind: 'observation', code: { logs: '', result: text }, action: { id: name, tool: 'run_code', arguments: { code: name } } });
    let history = appendHistory([], run('A', 'a'.repeat(14000) + 'A_BATTERY=27'));
    history = appendHistory(history, run('B', 'b'.repeat(14000) + 'B_BATTERY=34'));
    expect(JSON.stringify(history)).toContain('A_BATTERY=27');
    expect(JSON.stringify(history)).toContain('B_BATTERY=34');
    for (let i = 0; i < 8; i++) history = appendHistory(history, run(String(i), 'c'.repeat(20000)));
    expect(history.some(entry => entry.kind === 'observation' && entry.code?.summary)).toBe(true);
    expect(observation(history.at(-1)!).code?.result).toHaveLength(20000);
    expect(history.reduce((sum, entry) => sum + estimateTokens(JSON.stringify(entry)), 0)).toBeLessThanOrEqual(CONTEXT.historyTokens);
  });
  it('keeps only the size of written file contents in tool arguments', () => {
    const write = { id: 'w', name: 'workspace', arguments: JSON.stringify({ action: { name: 'write_file', path: 'a.md', content: 'z'.repeat(5000) } }) };
    expect(callForHistory(write)).toEqual({ id: 'w', tool: 'workspace', arguments: { action: { name: 'write_file', path: 'a.md', content: '[5000 characters saved to a.md]' } } });
    const browser = { id: 'b', name: 'browser', arguments: '{"action":{"name":"list_tabs"}}' };
    expect(callForHistory(browser)).toEqual({ id: 'b', tool: 'browser', arguments: { action: { name: 'list_tabs' } } });
  });
});
