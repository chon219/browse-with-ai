import { describe, expect, it, vi } from 'vitest';
import { formatSize, formatTokens, needsSettings, submitOnEnter, taskStatusLabel } from '../../src/ui/helpers';
import { mergeAttachments, type Attachment } from '../../src/ui/attachments';
import { reuseTasks } from '../../src/ui/app-state';
import { translate } from '../../src/i18n';
import { msg } from '../../src/i18n';
import type { Task } from '../../src/shared/types';

const task = (patch: Partial<Task>): Task => ({ id: 't', goal: 'g', status: 'running', createdAt: '', updatedAt: '', resultText: '', elapsedMs: 0, ...patch });

describe('UI helpers', () => {
  it('labels a blocked task waiting on a confirmation the same way everywhere', () => {
    expect(taskStatusLabel(task({ status: 'blocked', pendingApproval: { requestId: 'r', description: 'd', url: 'https://example.com/' } }))).toBe('等待确认');
    expect(taskStatusLabel(task({ status: 'blocked' }))).toBe('等待处理');
    expect(taskStatusLabel(task({ status: 'error' }))).toBe('执行出错');
  });
  it('shortens token counts', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_345)).toBe('12.3k'); expect(formatTokens(500_000)).toBe('500k');
    expect(formatTokens(1_250_000)).toBe('1.25M');
  });
  it('points to settings only for errors that settings can fix', () => {
    expect(needsSettings(task({ status: 'error', error: msg('model.authFailed') }))).toBe(true);
    expect(needsSettings(task({ status: 'error', error: msg('model.networkFailed') }))).toBe(false);
    expect(needsSettings(task({ status: 'error', error: '模型鉴权失败' }))).toBe(false);
    expect(needsSettings(task({ status: 'paused', error: msg('model.authFailed') }))).toBe(false);
  });
  it('formats file sizes', () => {
    expect(formatSize(999)).toBe('999 B'); expect(formatSize(1500)).toBe('1.5 KB'); expect(formatSize(2_500_000)).toBe('2.5 MB');
  });
  it('sends on Enter but not with Shift or during IME composition', () => {
    const press = (key: string, shiftKey = false, isComposing = false) => {
      const submit = vi.fn(); const preventDefault = vi.fn();
      submitOnEnter(submit)({ key, shiftKey, nativeEvent: { isComposing }, preventDefault } as never);
      return [submit.mock.calls.length, preventDefault.mock.calls.length];
    };
    expect(press('Enter')).toEqual([1, 1]);
    expect(press('Enter', true)).toEqual([0, 0]); expect(press('Enter', false, true)).toEqual([0, 0]); expect(press('a')).toEqual([0, 0]);
  });
  it('adds picked files up to the limit and reports the rest as dropped', () => {
    const file = (name: string): Attachment => ({ name, bytes: new Uint8Array(), size: 0 });
    const [a, b, c] = [file('a'), file('b'), file('c')];
    expect(mergeAttachments([a], [b, c], 2)).toEqual({ files: [a, b], dropped: [c] });
    expect(mergeAttachments([a, b], [c], 2)).toEqual({ files: [a, b], dropped: [c] });
  });
  it('keeps unchanged task objects across reloads', () => {
    const one = task({ id: '1', updatedAt: 'x' }); const two = task({ id: '2', updatedAt: 'x' });
    const current = [one, two];
    expect(reuseTasks(current, [{ ...one }, { ...two }])).toBe(current);
    const updated = { ...two, updatedAt: 'y' }; const next = reuseTasks(current, [{ ...one }, updated]);
    expect(next[0]).toBe(one); expect(next[1]).toBe(updated);
  });
  it('shows the key itself when no catalog has it', () => {
    expect(translate('zh-CN', 'nope.missing' as never)).toBe('nope.missing');
  });
});
