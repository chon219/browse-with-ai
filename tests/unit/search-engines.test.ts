import { describe, expect, it, vi } from 'vitest';
import { SEARCH_ENGINES, searchUrl } from '../../src/shared/search-engines';
import { initialSettings } from '../../src/shared/settings';
import { loadConfig } from '../../src/storage/settings';

describe('search configuration', () => {
  it('defaults to the browser provider and preserves existing provider choices', async () => {
    expect(initialSettings.search).toBe('browser');
    const local = vi.fn().mockResolvedValue({});
    vi.stubGlobal('chrome', { storage: { local: { get: local }, session: { get: vi.fn().mockResolvedValue({}) } } });
    expect((await loadConfig()).search).toBe('browser');
    local.mockResolvedValue({ settings: { search: 'google', model: 'existing-model' } });
    expect((await loadConfig()).search).toBe('google');
    expect((await loadConfig()).model).toBe('existing-model');
    local.mockResolvedValue({ settings: { search: 'unknown-provider' } });
    expect((await loadConfig()).search).toBe('browser');
  });
  it.each(SEARCH_ENGINES.filter(p => p.id !== 'browser'))('encodes $label search URLs', provider => {
    const query = '浏览器 A&B / ?#';
    const value = searchUrl(query, provider.id);
    const url = new URL(value);
    expect(url.searchParams.get(provider.parameter)).toBe(query);
    expect(url.hash).toBe(''); expect(url.origin).toBe(new URL(provider.url).origin);
  });
  it('does not fabricate a URL for the browser default', () => {
    expect(() => searchUrl('anything', 'browser')).toThrow('Chrome');
  });
});
