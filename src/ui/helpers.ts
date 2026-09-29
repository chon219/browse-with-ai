import type React from 'react';
import { isLocalText, t, type MessageKey } from '../i18n';
import type { Task } from '../shared/types';
import { BLOB_URL } from '../shared/tuning';

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), BLOB_URL.downloadMs);
}

/** The task's status as shown everywhere: a blocked task waiting on a confirmation says so. */
export const taskStatusLabel = (task: Task) => task.pendingApproval && task.status === 'blocked' ? t('status.awaitingApproval') : t(`status.${task.status}`);
/** Token counts as 950, 12.3k, 500k or 1.25M. */
export const formatTokens = (n: number) => n < 1000 ? String(n) : n < 1_000_000 ? `${+(n / 1000).toFixed(1)}k` : `${+(n / 1_000_000).toFixed(2)}M`;
/** File sizes in B, KB or MB. */
export const formatSize = (bytes: number) => bytes < 1000 ? `${bytes} B` : bytes < 1_000_000 ? `${(bytes / 1000).toFixed(1)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;
/** Errors that retrying cannot fix until the model settings change. */
const SETTINGS_ERRORS: MessageKey[] = ['model.notConfigured', 'model.authFailed', 'model.toolTestFailed', 'runner.configureFirst', 'app.configureModelFirst', 'settings.invalidApiUrl', 'settings.httpsRequired'];
export const needsSettings = (task: Task) => (task.status === 'paused' && task.pause?.kind === 'tokens') || task.status === 'error' && isLocalText(task.error) && SETTINGS_ERRORS.includes(task.error.key);
/** Enter sends; Shift+Enter and IME composition insert a newline. */
export const submitOnEnter = (submit: () => void) => (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
};
