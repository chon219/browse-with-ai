import { expect, it, vi } from 'vitest';
import { deleteSkill, getSkill, listSkills, saveSkill } from '../../src/storage/skills';
import { skillMarkdown } from '../../src/shared/skills';
import { draftSkill, skillEvidence } from '../../src/agent/skill-draft';
import type { Operation, Task } from '../../src/shared/types';
import { modelResponse } from '../fixtures/model-response';
import { saveTask, deleteTask } from '../../src/storage/db';

const draft = { name: 'Compare prices', description: 'Compare variants on a store website', instructions: 'Ask for variants. Locate current controls. Verify the final price and source.' };
const task = (): Task => ({ id: crypto.randomUUID(), goal: 'Compare prices', status: 'completed', outcome: 'success', createdAt: '', updatedAt: '', resultText: 'Verified price', elapsedMs: 0 });
const operation = (t: Task): Operation => ({ id: crypto.randomUUID(), taskId: t.id, phase: 'done', startedAt: '2026-01-01',
  action: { name: 'fill', tabId: 2, snapshotId: 'temporary', elementId: 'e1', value: 'private input' },
  result: { snapshot: { snapshotId: 'new', url: 'https://example.com/product?token=secret#private', title: 'Product', text: 'Price: 42', elements: [] } } });

it('keeps saved skills separate from tasks and protects edits from concurrent updates', async () => {
  const t = task(); await saveTask(t);
  const source = { sourceTaskId: t.id, sourceTurn: 0 };
  const first = await saveSkill(draft, source);
  const pinned = structuredClone(first);
  const second = await saveSkill({ ...draft, instructions: 'Updated workflow' }, source, first);
  expect(second.version).toBe(2);
  expect(pinned.instructions).toBe(draft.instructions);
  await expect(saveSkill(draft, source, first)).rejects.toThrow('其他页面');
  await deleteTask(t.id);
  expect(await getSkill(first.id)).toEqual(second);
  expect((await listSkills()).some(s => s.id === first.id)).toBe(true);
  expect(skillMarkdown(second)).toContain('description: "Compare variants');
  await deleteSkill(first.id);
  expect(await getSkill(first.id)).toBeUndefined();
  await expect(saveSkill(draft, source, second)).rejects.toThrow('其他页面');
  await expect(saveSkill({ ...draft, name: ' ' }, source)).rejects.toThrow('技能格式');
});

it('bounds extraction evidence and removes entered values, references and URL parameters', () => {
  const t = task(); const op = operation(t);
  const evidence = skillEvidence(t, [...Array.from({ length: 65 }, () => op), { ...op, turn: 1 }, { ...op, taskId: 'another' }]);
  expect(evidence.operationsTotal).toBe(65); expect(evidence.operationsOmitted).toBe(5);
  expect(evidence.steps).toHaveLength(60);
  const encoded = JSON.stringify(evidence);
  for (const value of ['tabId', 'snapshotId', 'elementId', 'private input', 'secret', '#private']) expect(encoded).not.toContain(value);
  expect(encoded).toContain('Price: 42');
});

it('preserves observed control labels and explicitly marks shortened evidence', () => {
  const t = task(); const op = operation(t);
  const previous: Operation = { ...op, id: 'before', action: { name: 'read', tabId: 2 }, result: { tabId: 2, snapshot: { ...op.result!.snapshot!, snapshotId: 'temporary', text: 'x'.repeat(1500), elements: [{ id: 'e1', kind: 'input', text: 'Search products' }] } } };
  const evidence = skillEvidence(t, [previous, op]);
  expect(evidence.steps[1].target).toEqual({ kind: 'input', label: 'Search products' });
  expect(evidence.steps[0].result?.page?.text).toContain('[Excerpt truncated]');
});

it('generates a schema-validated draft only from a successful task with executed evidence', async () => {
  const t = task(); const config = { baseUrl: 'https://model.example/v1', model: 'test', apiKey: 'key', remember: false, search: 'bing' as const };
  const fetcher = vi.fn(async (_url, _init) => modelResponse({ choices: [{ message: { content: null, tool_calls: [{ id: 'draft', type: 'function', function: { name: 'draft_skill', arguments: JSON.stringify(draft) } }] } }] }));
  vi.stubGlobal('fetch', fetcher);
  const signal = new AbortController().signal;
  await expect(draftSkill({ ...t, status: 'incomplete' }, [operation(t)], config, signal)).rejects.toThrow('成功完成');
  await expect(draftSkill(t, [], config, signal)).rejects.toThrow('操作记录');
  expect(fetcher).not.toHaveBeenCalled();
  expect((await draftSkill(t, [operation(t)], config, signal)).draft).toEqual(draft);
  const request = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(request.tool_choice.function.name).toBe('draft_skill');
  expect(request.messages[0].content).toContain('untrusted evidence');
  const aborted = new AbortController(); aborted.abort();
  await expect(draftSkill(t, [operation(t)], config, aborted.signal)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
