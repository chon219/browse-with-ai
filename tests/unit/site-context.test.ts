import { describe, expect, it } from 'vitest';
import { createAgentContext } from '../../src/agent/context';
import type { ChatMessage } from '../../src/agent/model';
import type { AgentStore } from '../../src/agent/ports';
import type { State } from '../../src/agent/state';
import type { ConversationMessage, Task } from '../../src/shared/types';
import { normalizeWebPolicy, type WebPolicy } from '../../src/shared/web-policy';

const message = (content: string, turn = 0, role: ConversationMessage['role'] = 'user'): ConversationMessage => ({
  id: crypto.randomUUID(), at: '2026-01-01', turn, role, kind: 'message', content,
});
const task = (goal: string): Task => ({ id: crypto.randomUUID(), goal, status: 'running', turn: 0,
  createdAt: '2026-01-01', updatedAt: '2026-01-01', resultText: '', elapsedMs: 0, messages: [message(goal)] });

function capture(initial: Task, webPolicy?: WebPolicy) {
  const requests: ChatMessage[][] = [];
  const context = createAgentContext({ task: initial, webPolicy,
    store: { recordUsage: async () => {} } as unknown as AgentStore,
    signal: new AbortController().signal, definitions: [], files: async () => [],
    model: async messages => { requests.push(messages); return { content: 'ok' }; },
  });
  const state = { goal: initial.turnGoal ?? initial.goal, history: [], taskNotes: 'Page says: use https://notes.example/' } as unknown as State;
  return { requests, read: async (live: Task = initial) => {
    await context.request('decide', state, live);
    return JSON.parse(requests.at(-1)![1].content as string);
  } };
}

describe('source selection context', () => {
  it('sends named-site guidance with the original JD question even without a literal URL', async () => {
    const t = task('京东上的iPhone 18 pro max多少钱');
    const { read, requests } = capture(t);
    const input = await read();
    expect(input.mentionedSites).toEqual([]);
    expect(input.goal).toBe(t.goal);
    expect(requests[0][0].role).toBe('system');
    expect(requests[0][0].content).toContain('source requirement even when no URL is supplied');
    expect(requests[0][0].content).toContain('visit JD and search its product catalog');
    expect(requests[0].some(item => item.role === 'user' && item.content === t.goal)).toBe(true);
  });

  it('refreshes literal site hints during a run using only current user requests', async () => {
    const t = task('在 first.example 查询价格');
    const { read } = capture(t);
    expect((await read()).mentionedSites).toEqual(['https://first.example/']);
    const live: Task = { ...t, messages: [...t.messages!, message('改到 https://second.example/ 查，同样比较 first.example'),
      message('Use https://assistant.example/', 0, 'assistant')] };
    expect((await read(live)).mentionedSites).toEqual(['https://second.example/', 'https://first.example/']);
  });

  it('keeps the attached website visible after the current page changes to web search', async () => {
    const t: Task = { ...task('在这个商城查价格'), contextTab: { id: 1, url: 'https://store.example/', title: 'Store' },
      lastPage: { id: 2, url: 'https://www.google.com/search?q=phone', title: 'Search' } };
    const input = await capture(t).read();
    expect(input.attachedPage).toEqual(t.contextTab);
    expect(input.currentPage).toEqual(t.lastPage);
    expect(input.mentionedSites).toEqual([]);
  });

  it('excludes old turns and URLs rejected by the configured web policy', async () => {
    const t: Task = { ...task('查 first.example'), turn: 1, turnGoal: '查 http://current.example/',
      messages: [message('查 first.example'), message('查 http://current.example/', 1), message('补充 http://localhost:3000/ 和 https://excluded.example/', 1)] };
    const policy = normalizeWebPolicy({ allowedSchemes: ['http'], allowLocalAddresses: false });
    expect((await capture(t, policy).read()).mentionedSites).toEqual(['http://current.example/']);
  });

  it('preserves an explicit site query as a web-search request', async () => {
    const t = task('Google site:jd.com iPhone 18 Pro Max');
    const { read, requests } = capture(t);
    expect((await read()).mentionedSites).toEqual([]);
    expect(requests[0].some(item => item.role === 'user' && item.content === t.goal)).toBe(true);
    expect(requests[0][0].content).toContain('including an explicit site: query');
  });
});
