import { describe, expect, it } from 'vitest';
import { actionSchema, declaresEffect } from '../../src/shared/policy';
import { validatePageUrl } from '../../src/shared/web-policy';
import { searchUrl } from '../../src/shared/search-engines';
import { formatTaskResult } from '../../src/agent/results';
describe('browser operation boundaries', () => {
  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'https://a:b@example.com/', 'https://example.com/?api_key=secret'])('rejects URLs excluded by the default policy: %s', url => { expect(() => validatePageUrl(url)).toThrow(); });
  it('rejects arbitrary tools and unexpected script parameters', () => {
    expect(actionSchema.safeParse({ name: 'evaluate', script: 'steal()' }).success).toBe(false);
    expect(actionSchema.safeParse({ name: 'read', tabId: 1, script: 'steal()' }).success).toBe(false);
    expect(searchUrl('a & b', 'bing')).toContain('q=a%20%26%20b');
  });
  it('keeps login pages readable for manual handoff, but excludes tracker credentials and downloads', () => {
    expect(validatePageUrl('https://example.com/login.php')).toBe('https://example.com/login.php');
    expect(() => validatePageUrl('https://example.com/browse?passkey=private')).toThrow('参数');
    expect(() => validatePageUrl('https://example.com/download.php?id=123')).toThrow('下载');
    expect(() => validatePageUrl('https://example.com/file.torrent')).toThrow('文件后缀');
  });
  it('only links to visited pages and preserves plain task replies', () => {
    const text = formatTaskResult('[页面](https://example.com/a) [其他](https://unknown.example/)', ['https://example.com/a']);
    expect(text).toBe('[页面](https://example.com/a) 其他'); expect(text).not.toContain('unknown.example'); expect(text).toContain('https://example.com/a');
    expect(formatTaskResult('已填写表单。')).toBe('已填写表单。');
  });
  it('does not allow the model to approve its own actions', () => {
    expect(actionSchema.safeParse({ name: 'click', tabId: 1, snapshotId: 's', elementId: 'e1', approved: true }).success).toBe(false);
  });
  it.each(['site_search', 'next', 'expand'])('removes the specialized %s action', name => {
    expect(actionSchema.safeParse({ name, tabId: 1, snapshotId: 's', elementId: 'e1' }).success).toBe(false);
  });

});

describe('model-declared effect', () => {
  const click = { name: 'click', tabId: 1, snapshotId: 's1', elementId: 'e1' };
  it('accepts an optional effect and reason on page changes only', () => {
    expect(actionSchema.parse({ ...click, effect: 'write', reason: 'Posts the comment' })).toMatchObject({ effect: 'write', reason: 'Posts the comment' });
    expect(actionSchema.parse(click)).toEqual(click);
    expect(() => actionSchema.parse({ ...click, effect: 'harmless' })).toThrow();
    expect(actionSchema.parse({ name: 'open', url: 'https://example.com/', effect: 'read' })).toHaveProperty('effect', 'read');
  });
  it('only a write or irreversible prediction asks for approval', () => {
    expect(declaresEffect({ effect: 'write' })).toBe(true);
    expect(declaresEffect({ effect: 'irreversible' })).toBe(true);
    expect(declaresEffect({ effect: 'read' })).toBe(false);
    expect(declaresEffect({})).toBe(false);
  });
});
