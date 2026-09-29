import { modelResponse } from '../fixtures/model-response';
import { modelInput } from '../fixtures/model-input';
import { describe, expect, it, vi } from 'vitest';
import { controlSchemas, controlTools, createAgentTools } from '../../src/agent/tools';
import { createExtensionAgent } from '../../src/agent/extension-agent';
import { saveTask } from '../../src/storage/db';
import { forModel } from '../../src/agent/prompts';
import type { AgentStore } from '../../src/agent/ports';
import type { State } from '../../src/agent/state';
import type { Task } from '../../src/shared/types';

const makeTask = (): Task => ({ id: crypto.randomUUID(), goal: 'Read the page', title: 'Read', status: 'running',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  elapsedMs: 0, resultText: '' });
const call = (name: string, args: string) => ({ id: 'c1', type: 'function' as const, function: { name, arguments: args } });

describe('tool argument feedback', () => {
  it('publishes the same control constraints that the graph enforces', () => {
    for (const tool of controlTools) {
      expect(tool.function.parameters).toMatchObject({ additionalProperties: false });
      if (tool.function.name === 'load_skill') continue;
      const properties = tool.function.parameters.properties as Record<string, object>;
      for (const field of tool.function.name === 'ask_user' ? ['question'] : tool.function.name === 'update_task_notes' ? ['notes'] : ['answer', 'verification']) {
        expect(properties[field]).toMatchObject({ minLength: 1, maxLength: field === 'notes' ? 12000 : field === 'answer' ? 24000 : 2000 });
      }
    }
    expect(controlSchemas.ask_user.safeParse({ question: 'x'.repeat(2001) }).success).toBe(false);
    expect(controlSchemas.ask_user.safeParse({ question: 'Hello?', approval: true }).success).toBe(false);
    expect(controlSchemas.finish_task.safeParse({ outcome: 'success', answer: ' ', verification: 'Observed' }).success).toBe(false);
  });
  it.each([
    ['browser', '{"action":', 'JSON', 'not valid JSON'],
    ['browser', '{"name":"read","tabId":7}', 'action', 'Invalid input'],
    ['browser', '{"action":{"name":"read","tabId":"7"}}', 'action.tabId', 'expected number'],
    ['browser', '{"action":{"name":"click","tabId":7,"elementId":"e1"}}', 'action.snapshotId', 'expected string'],
    ['browser', '{"action":{"name":"read","tabId":7,"effect":"read"}}', 'action', 'Unrecognized key'],
    ['workspace', '{"action":{"name":"read_file","path":"a.txt","offset":null}}', 'action.offset', 'expected number'],
    ['run_code', '{"code":""}', 'code', 'Too small'],
  ])('explains %s errors at %s without dispatching an action', async (name, args, field, reason) => {
    const update = vi.fn(); const saveOperation = vi.fn();
    const browser = vi.fn(); const workspace = vi.fn(); const runCode = vi.fn();
    const store: AgentStore = { task: async () => undefined, update, append: vi.fn(), operation: async () => undefined, saveOperation, recordUsage: vi.fn() };
    const tools = createAgentTools({ task: makeTask(), store, signal: new AbortController().signal, browser, workspace, runCode, imagesEnabled: false });
    const result = forModel(await tools.execute(call(name, args), { rounds: 1 } as State)) as { error: string; note: string };
    expect(result.error).toContain(field);
    expect(result.note).toContain(reason);
    expect(result.note).toContain('No action was performed');
    expect(browser).not.toHaveBeenCalled(); expect(workspace).not.toHaveBeenCalled(); expect(runCode).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled(); expect(saveOperation).not.toHaveBeenCalled();
    expect(tools.definitions.find(tool => tool.function.name === name)!.function.description).toContain('Arguments');
  });

  it('gives the next model decision enough feedback to repair a call and execute once', async () => {
    const task = makeTask(); await saveTask(task); let decisions = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); const system = body.messages[0].content;
      let message;
      if (!system.includes('BWAI_DECIDE')) message = { content: 'Read the page.' };
      else {
        decisions++;
        if (decisions === 2) {
          const feedback = modelInput(body).observations.at(-1);
          expect(feedback.note).toContain('action.tabId');
          expect(feedback.note).toContain('expected number');
        }
        const next = decisions === 1 ? call('browser', '{"action":{"name":"read","tabId":"7"}}')
          : decisions === 2 ? call('browser', '{"action":{"name":"read","tabId":7}}')
          : call('finish_task', "{\"outcome\":\"success\",\"verification\":\"Page returned\",\"answer\":\"Read\"}");
        message = { content: null, tool_calls: [next] };
      }
      return modelResponse({ choices: [{ message }] });
    }));
    const browser = vi.fn(async () => ({ tabId: 7, snapshot: { url: 'https://example.com/', title: 'Page', text: 'Done', snapshotId: 's1', elements: [] } }));
    const graph = createExtensionAgent({ task, config: { baseUrl: 'https://model.example/v1', model: 'mock', apiKey: 'key', remember: false, search: 'bing' }, signal: new AbortController().signal, elapsed: () => 1, browser });
    const result = await graph.invoke({ messages: [], goal: task.goal, history: [], rounds: 0 }, { configurable: { thread_id: task.id } });
    expect(result.outcome).toBe('success');
    expect(browser).toHaveBeenCalledTimes(1);
    expect(browser).toHaveBeenCalledWith({ name: 'read', tabId: 7 }, expect.any(String));
  });
});
