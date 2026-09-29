import { describe, expect, it, vi } from 'vitest';
import { prepareCodeOutput } from '../../src/agent/code-output';
import { CODE_LIMITS } from '../../src/shared/code';

describe('code output archives', () => {
  it('saves all streams before returning bounded previews', async () => {
    const save = vi.fn(async () => {});
    const logs = 'l'.repeat(25000) + 'LAST_LOG', result = 'r'.repeat(26000) + 'LAST_RESULT', error = 'e'.repeat(27000);
    const output = await prepareCodeOutput({ logs, result, error }, save);
    expect(save).toHaveBeenCalledTimes(3);
    expect(save.mock.calls as unknown[][]).toEqual(expect.arrayContaining([
      [output.outputFiles!.logs, logs], [output.outputFiles!.result, result], [output.outputFiles!.error, error],
    ]));
    expect(output.logs).toHaveLength(CODE_LIMITS.outputChars + 1);
    expect(output.outputChars?.logs).toBe(logs.length);
    expect(output.archiveTruncated).toBeUndefined();
  });
  it('reports capture loss and save failure separately from successful code execution', async () => {
    const output = await prepareCodeOutput({ logs: 'x'.repeat(25000), logsChars: 30000 }, async () => { throw new Error('full'); });
    expect(output.archiveTruncated).toBe(true);
    expect(output.outputSaveError).toBeTruthy();
    expect(output.error).toBeUndefined();
    expect(output.outputFiles).toBeUndefined();
  });
});
