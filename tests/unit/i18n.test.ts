import { describe, expect, it, vi } from 'vitest';
import { detectLocale, display, loadLanguage, msg, resolveLocale, setLocale, storeLanguage, t } from '../../src/i18n';
import { conversationContext, forModel, systemPrompt } from '../../src/agent/prompts';
import { messageText } from '../../src/shared/conversation';
import { patchTask, saveTask } from '../../src/storage/db';
import { zhCN } from '../../src/i18n/locales/zh-CN';
import { en } from '../../src/i18n/locales/en';
import { validatePageUrl } from '../../src/shared/web-policy';
import type { Task } from '../../src/shared/types';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

describe('i18n', () => {
  it('keeps every locale in sync with the source catalog, including placeholders', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
    for (const key of Object.keys(zhCN) as (keyof typeof zhCN)[]) {
      expect(en[key].trim(), key).not.toBe('');
      expect(placeholders(en[key]), key).toEqual(placeholders(zhCN[key]));
    }
  });
  it('detects and resolves the locale from the browser language', () => {
    expect(detectLocale('zh-CN')).toBe('zh-CN'); expect(detectLocale('zh-TW')).toBe('zh-CN');
    expect(detectLocale('en-US')).toBe('en'); expect(detectLocale('fr')).toBe('en');
    expect(resolveLocale('en')).toBe('en'); expect(resolveLocale('unknown')).toBe(detectLocale());
  });
  it('translates and interpolates in the active locale', () => {
    setLocale('en');
    expect(t('limits.tokenRange', { min: 50000, max: 5000000 })).toBe('Token limit must be an integer between 50000 and 5000000');
    expect(() => validatePageUrl('not a url')).toThrow('Invalid URL');
    setLocale('zh-CN');
    expect(t('step.deciding', { round: 3 })).toBe('正在分析任务，等待模型回复');
  });
  it('keeps agent prompts independent of the interface language except for the reply language', () => {
    for (const phase of ['decide', 'progress'] as const) {
      const zh = systemPrompt(phase, 'zh-CN'); const english = systemPrompt(phase, 'en');
      expect(zh).toContain(`BWAI_${phase.toUpperCase()}`); expect(zh).not.toMatch(/[一-鿿]/);
      expect(zh.replace('Simplified Chinese', 'English')).toBe(english);
    }
  });
  it('shows observations to the model canonically, with guidance the user does not see', () => {
    setLocale('zh-CN');
    const observation = { error: msg('bg.rejected'), snapshot: { title: '页面' } };
    expect(forModel(observation)).toEqual({ error: 'You rejected this step; it was not performed. Do not attempt the same action again; choose an alternative or explain that the task is incomplete.', snapshot: { title: '页面' } });
    expect(display(observation.error)).toBe('你拒绝了这一步，操作未执行。');
    expect(forModel({ error: 'legacy text' })).toEqual({ error: 'legacy text' });
  });
  it('re-renders persisted activity and errors in the current locale', async () => {
    setLocale('zh-CN');
    const task = { id: crypto.randomUUID(), goal: '打开网页', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resultText: '', elapsedMs: 0 } as Task;
    await saveTask(task);
    await patchTask(task.id, {}, msg('step.action', { action: msg('action.open'), detail: ' · https://example.com/' }));
    const saved = await patchTask(task.id, { status: 'blocked', error: msg('bg.sitePermission') });
    const [activity, blocked] = saved.messages!.slice(-2);
    expect(activity.content).toBe('打开网页 · https://example.com/'); expect(activity.localText?.key).toBe('step.action');
    setLocale('en');
    expect(messageText(activity)).toBe('Open page · https://example.com/');
    expect(messageText(blocked)).toBe(en['bg.sitePermission']);
    expect(conversationContext(saved).at(-1)?.content).toBe(en['bg.sitePermission']);
    expect(messageText({ ...activity, localText: undefined })).toBe('打开网页 · https://example.com/');
  });
  it('stores the language setting and falls back to automatic detection', async () => {
    const store: Record<string, unknown> = {};
    vi.stubGlobal('chrome', { storage: { local: {
      get: vi.fn(async (key: string) => ({ [key]: store[key] })),
      set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(store, items); }),
      remove: vi.fn(async (key: string) => { delete store[key]; }),
    } } });
    expect(await loadLanguage()).toBe('auto');
    await storeLanguage('en'); expect(await loadLanguage()).toBe('en'); expect(t('app.send')).toBe('Send');
    await storeLanguage('auto'); expect(await loadLanguage()).toBe('auto'); expect(store).not.toHaveProperty('language');
  });
});
