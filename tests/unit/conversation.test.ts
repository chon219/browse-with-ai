import { describe, expect, it } from 'vitest';
import { appendMessage, completeTurn, database, getTask, operations, patchTask, saveOperation, saveTask, sendTaskMessage } from '../../src/storage/db';
import { conversationMessages, threadId } from '../../src/shared/conversation';
import type { Task } from '../../src/shared/types';

const makeTask = (): Task => ({ id: crypto.randomUUID(), goal: '填写表单', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resultText: '', elapsedMs: 0, });
describe('conversation lifecycle', () => {
  it('continues a completed conversation with fresh execution identity and existing pages and results', async () => {
    const task = makeTask(); task.contextTab = { id: 123, url: 'https://example.com/form', title: '表单' }; await saveTask(task);
    await patchTask(task.id, { status: 'completed', resultText: '已填写', outcome: 'success', elapsedMs: 60_000 });
    const next = await sendTaskMessage(task.id, '再修改标题');
    expect(next.id).toBe(task.id); expect(next.turn).toBe(1); expect(next.turnGoal).toBe('再修改标题');
    expect(next.status).toBe('ready'); expect(next.elapsedMs).toBe(0); expect(next.turnVisitedUrls).toEqual([]);
    expect(next.contextTab).toEqual(task.contextTab); expect(next.resultText).toBe('');
    expect(next.messages?.filter(m => m.role === 'user').map(m => m.content)).toEqual(['填写表单', '再修改标题']);
    expect(next.messages?.find(m => m.kind === 'result')?.content).toBe('已填写');
    expect(threadId(next)).not.toBe(threadId(task));
  });
  it('a new instruction invalidates a pending approval rather than approving old content', async () => {
    const task = makeTask(); const requestId = 'approval-' + task.id; await saveTask(task);
    const approval = { requestId, description: '保存', url: 'https://example.com/form', elementText: '保存', tabId: 123 };
    await saveOperation({ id: requestId, taskId: task.id, action: { name: 'click', tabId: 123, snapshotId: 's', elementId: 'e1' }, phase: 'done', startedAt: task.createdAt, result: { approval } });
    await patchTask(task.id, { status: 'blocked', pendingApproval: approval });
    const next = await sendTaskMessage(task.id, '标题改为新标题');
    expect(next.status).toBe('ready'); expect(next.pendingApproval).toBeUndefined();
    expect((await operations(task.id))[0].approvalDecision).toBe('rejected');
    expect((await operations(task.id))[0].supersededBy).toBeTruthy();
    expect(next.messages?.find(m => m.kind === 'approval')?.decision).toBe('superseded');
  });
  it('does not finish over a newly arrived message and does not duplicate committed results', async () => {
    const task = makeTask(); await saveTask(task);
    await sendTaskMessage(task.id, '还有一个要求');
    expect(await completeTurn(task.id, 0, 0, { status: 'completed', resultText: '旧结果' })).toBe(false);
    expect(await completeTurn(task.id, 0, 1, { status: 'completed', resultText: '新结果' })).toBe(true);
    await patchTask(task.id, { status: 'completed', resultText: '新结果' });
    const saved = (await getTask(task.id))!;
    expect(saved.messages?.filter(m => m.kind === 'result')).toHaveLength(1);
    expect(saved.messages?.find(m => m.kind === 'result')?.content).toBe('新结果');
  });
  it('old runner writes cannot overwrite a new conversation turn', async () => {
    const task = makeTask(); await saveTask(task); await patchTask(task.id, { status: 'cancelled' });
    await sendTaskMessage(task.id, '重新开始');
    await patchTask(task.id, { status: 'paused', elapsedMs: 99_000 }, '旧回调', 0);
    await appendMessage(task.id, { id: 'old-plan', turn: 0, role: 'assistant', kind: 'message', content: '旧计划' });
    const next = (await getTask(task.id))!;
    expect(next.status).toBe('ready'); expect(next.elapsedMs).toBe(0); expect(next.messages?.some(m => m.id === 'old-plan')).toBe(false);
  });
  it('starts a saved task from its first message and treats repeated send IDs idempotently', async () => {
    const task = makeTask(); task.status = 'completed';
    await (await database()).put('tasks', task);
    expect(conversationMessages(task).map(m => m.content)).toEqual(['填写表单']);
    await sendTaskMessage(task.id, '继续', { messageId: 'one-message' }); await sendTaskMessage(task.id, '继续', { messageId: 'one-message' });
    expect((await getTask(task.id))?.messages?.filter(m => m.content === '继续')).toHaveLength(1);
    expect((await getTask(task.id))?.turn).toBe(1);
  });
});
