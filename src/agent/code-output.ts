import { CODE_LIMITS, type CodeRun } from '../shared/code';

/** Archive before cropping the model preview. Failure to save output does not
 * change whether the user's code ran, and is reported explicitly. */
export async function prepareCodeOutput(data: { logs?: string; result?: string; error?: string; logsChars?: number; resultChars?: number; errorChars?: number },
  save: (path: string, content: string) => Promise<unknown>): Promise<CodeRun> {
  const run: CodeRun = { logs: '' };
  for (const key of ['logs', 'result', 'error'] as const) {
    const text = data[key]; if (text === undefined) continue;
    const captured = text.slice(0, CODE_LIMITS.archiveChars);
    const reported = data[`${key}Chars`];
    const total = Math.max(text.length, typeof reported === 'number' && Number.isFinite(reported) ? reported : 0);
    run[key] = captured.length > CODE_LIMITS.outputChars ? captured.slice(0, CODE_LIMITS.outputChars) + '…' : captured;
    if (total <= CODE_LIMITS.outputChars) continue;
    run.truncated = true; (run.outputChars ??= {})[key] = total;
    if (total > captured.length) run.archiveTruncated = true;
    try {
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(captured)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const path = `code-output/${digest.slice(0, 32)}-${key}.txt`;
      await save(path, captured);
      (run.outputFiles ??= {})[key] = path;
    } catch { run.outputSaveError = 'Could not save the full code output. Only the preview is available; save a smaller structured result or free workspace space before retrying.'; }
  }
  return run;
}
