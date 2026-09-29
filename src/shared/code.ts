import { z } from 'zod';
import type { Text } from '../i18n';

/** JavaScript the agent runs in the sandbox page (see src/sandbox/sandbox.ts). */
export const CODE_LIMITS = { sourceChars: 20_000, timeoutMs: 10_000, outputChars: 20_000, archiveChars: 2_000_000, fileCalls: 200 } as const;
export const runCodeSchema = z.object({ code: z.string().min(1).max(CODE_LIMITS.sourceChars) }).strict();
/** What a run printed and returned; `error` is a thrown error or a timeout. */
export interface CodeRun { logs: string; result?: string; error?: Text; changedFiles?: string[]; truncated?: boolean;
  outputFiles?: Partial<Record<'logs' | 'result' | 'error', string>>;
  outputChars?: Partial<Record<'logs' | 'result' | 'error', number>>;
  archiveTruncated?: boolean; outputSaveError?: string }
/** Workspace operations sandboxed code may request, as `files.<method>` inside the sandbox. */
export const SANDBOX_FILE_OPS = ['list_files', 'read_file', 'read_bytes', 'write_file', 'write_bytes', 'append_file', 'delete_file'] as const;
