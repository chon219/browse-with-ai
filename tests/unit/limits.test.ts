import { describe, expect, it, vi } from 'vitest';
import { normalizeTokenLimit, validateTokenLimit } from '../../src/shared/budget';
import { loadConfig, storeConfig } from '../../src/storage/settings';

describe('optional token limits', () => {
  it('defaults to unrestricted and accepts only explicit valid limits', () => {
    expect(normalizeTokenLimit(undefined)).toBeUndefined();
    expect(normalizeTokenLimit({ kTokens: 500 })).toBeUndefined();
    expect(normalizeTokenLimit(500_000)).toBe(500_000);
    expect(() => validateTokenLimit(0)).toThrow('Token');
    expect(validateTokenLimit(undefined)).toBeUndefined();
  });
  it('does not inherit old automatic budgets, and saves an explicit cap or disables it', async () => {
    const set = vi.fn(async () => {});
    vi.stubGlobal('chrome', { storage: {
      local: { get: vi.fn(async () => ({ settings: { model: 'test', executionLimits: { pages: 1, steps: 1, minutes: 1, kTokens: 500 } } })), set, remove: vi.fn() },
      session: { get: vi.fn(async () => ({ apiKey: 'key' })), set: vi.fn(), remove: vi.fn() },
    } });
    const config = await loadConfig();
    expect(config.tokenLimit).toBeUndefined(); expect(config).not.toHaveProperty('executionLimits');
    await storeConfig({ ...config, tokenLimit: 200_000 });
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ settings: expect.objectContaining({ tokenLimit: 200_000 }) }));
    await storeConfig({ ...config, tokenLimit: undefined });
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ settings: expect.objectContaining({ tokenLimit: undefined }) }));
  });
});
