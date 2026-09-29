import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appendDebug, clearDebug, createDebugSink, debugData, DEBUG_LIMITS, readDebug } from '../../src/storage/debug';
import { debugSpan } from '../../src/shared/debug';
import { initialSettings } from '../../src/shared/settings';
import { loadConfig, storeConfig } from '../../src/storage/settings';

beforeEach(async () => { await clearDebug(); vi.spyOn(console, 'debug').mockImplementation(() => {}); });

describe('debug diagnostics', () => {
  it('defaults to off for new and existing settings and preserves explicit choices', async () => {
    let settings: Record<string, unknown> = { ...initialSettings }; delete settings.debug;
    vi.stubGlobal('chrome', { storage: {
      local: { get: async () => ({ settings }), set: async (value: { settings?: Record<string, unknown> }) => { if (value.settings) settings = value.settings; }, remove: async () => {} },
      session: { get: async () => ({ apiKey: 'test-key' }), set: async () => {}, remove: async () => {} },
    } });
    expect(initialSettings.debug).toBe(false);
    expect((await loadConfig()).debug).toBe(false);
    await storeConfig({ ...await loadConfig(), debug: true });
    expect((await loadConfig()).debug).toBe(true);
    await storeConfig({ ...await loadConfig(), debug: false });
    expect((await loadConfig()).debug).toBe(false);
  });

  it('records correlated inputs, outputs and errors; disabled logging writes nothing', async () => {
    const sink = createDebugSink('conversation', 2, true, 'secret-key');
    const args = { code: 'return 42', apiKey: 'secret-key' };
    await expect(debugSpan(sink, 'tool.execute', args, async () => 42)).resolves.toBe(42);
    args.code = 'changed later';
    const failure = new Error('Failed secret-key');
    await expect(debugSpan(sink, 'model.request', {}, async () => { throw failure; })).rejects.toBe(failure);
    const records = await readDebug();
    expect(records.map(r => r.event)).toEqual(['tool.execute.start', 'tool.execute.result', 'model.request.start', 'model.request.error']);
    expect(new Set(records.map(r => r.runId)).size).toBe(1);
    expect(records.every(r => r.taskId === 'conversation' && r.turn === 2)).toBe(true);
    const first = records[0].data as { callId: string; input: { code: string } };
    expect(first.input.code).toBe('return 42');
    expect(records[1].data).toMatchObject({ callId: first.callId, result: 42 });
    expect(records[3].data).toMatchObject({ error: { name: 'Error', message: 'Failed [redacted]' } });
    expect(JSON.stringify(records)).not.toContain('secret-key');
    await debugSpan(createDebugSink('other', 0, false), 'tool.execute', {}, async () => 9);
    expect(await readDebug()).toHaveLength(4);
  });

  it('ignores logger failures while preserving the operation result or exception', async () => {
    const sink = vi.fn(async () => { throw new Error('Storage full'); });
    await expect(debugSpan(sink, 'test', {}, async () => 'done')).resolves.toBe('done');
    const failure = new Error('Actual failure');
    await expect(debugSpan(sink, 'test', {}, async () => { throw failure; })).rejects.toBe(failure);
  });

  it('handles cycles, errors and images, and explicitly marks truncated data', () => {
    const error = new Error('broken'); error.cause = error;
    const data = debugData({ error, image: 'data:image/png;base64,AAAA', bytes: new Uint8Array(10) });
    expect(JSON.stringify(data)).toContain('circular');
    expect(JSON.stringify(data)).not.toContain('base64');
    expect(data).toMatchObject({ bytes: { binaryBytes: 10 } });
    expect(debugData({ text: 'a'.repeat(DEBUG_LIMITS.dataChars * 2) })).toMatchObject({ truncated: true, originalChars: expect.any(Number) });
  });

  it('retains only the newest bounded records and can clear them independently of tasks', async () => {
    for (let i = 0; i < DEBUG_LIMITS.entries + 3; i++) {
      await appendDebug({ at: '2026-09-26', taskId: 'task', turn: 0, runId: 'run', event: 'test', data: { i } });
    }
    const records = await readDebug();
    expect(records).toHaveLength(DEBUG_LIMITS.entries);
    expect(records[0].data).toEqual({ i: 3 });
    expect(records.at(-1)!.data).toEqual({ i: DEBUG_LIMITS.entries + 2 });
    await clearDebug(); expect(await readDebug()).toEqual([]);
  });
});
