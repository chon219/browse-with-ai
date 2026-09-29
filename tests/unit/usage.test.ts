import { modelResponse } from '../fixtures/model-response';
import { describe, expect, it, vi } from 'vitest';
import { addUsage, estimateTokens } from '../../src/shared/usage';
import { chat } from '../../src/agent/model';
import { createExtensionAgent } from '../../src/agent/extension-agent';
import { getTask, saveTask } from '../../src/storage/db';
import type { Task } from '../../src/shared/types';

const config = { baseUrl: 'https://model.example/v1', model: 'test', apiKey: 'key', remember: false, search: 'bing' as const };
const task = (): Task => ({ id: crypto.randomUUID(), goal: '打开网页', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resultText: '', elapsedMs: 0 });
const reply = (message: object, usage?: object) => modelResponse({ choices: [{ message }], ...(usage ? { usage } : {}) });

describe('token usage', () => {
  it('estimates CJK text per character and other text per four characters', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('隔尿垫abcd')).toBe(4);
  });
  it('accumulates totals and keeps the latest request as the context size', () => {
    const first = addUsage(undefined, { prompt: 1000, completion: 50 });
    const second = addUsage(first, { prompt: 1800, completion: 20, estimated: true });
    expect(first).toEqual({ promptTokens: 1000, completionTokens: 50, requests: 1, contextTokens: 1000, turn: 0, turnTokens: 1050 });
    expect(second).toEqual({ promptTokens: 2800, completionTokens: 70, requests: 2, contextTokens: 1800, estimated: true, turn: 0, turnTokens: 2870 });
    // A new turn starts its own token count; the conversation total keeps growing.
    expect(addUsage(second, { prompt: 100, completion: 10 }, 1)).toMatchObject({ promptTokens: 2900, turn: 1, turnTokens: 110 });
  });
  it('reads usage reported by the model service', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply({ content: 'hi' }, { prompt_tokens: 120, completion_tokens: 7, total_tokens: 127 })).mockResolvedValueOnce(reply({ content: 'hi' })));
    expect((await chat(config, [], new AbortController().signal)).usage).toEqual({ prompt: 120, completion: 7 });
    expect((await chat(config, [], new AbortController().signal)).usage).toBeUndefined();
  });
  it('records every agent request on the conversation, estimating unreported ones', async () => {
    const t = task(); await saveTask(t);
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const system = JSON.parse(init.body).messages[0].content;
      if (system.includes('BWAI_TITLE')) return reply({ content: '打开网页' }, { prompt_tokens: 60, completion_tokens: 4 });


      return reply({ content: null, tool_calls: [{ id: 'f', type: 'function', function: { name: 'finish_task', arguments: JSON.stringify({ outcome: 'success', answer: '完成', verification: '已检查' }) } }] });
    }));
    const graph = createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 10, browser: vi.fn() });
    await graph.invoke({ messages: [], goal: t.goal, history: [], rounds: 0 }, { configurable: { thread_id: t.id } });
    const usage = (await getTask(t.id))!.usage!;
    expect(usage).toMatchObject({ requests: 2, estimated: true });
    // The decision request carries the tool definitions, so its estimate is larger than the naming request.
    expect(usage.promptTokens).toBeGreaterThan(60 + 1000);
    expect(usage.completionTokens).toBeGreaterThan(40);
  });
});
