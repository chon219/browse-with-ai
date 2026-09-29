/**
 * Operational constants tuned by hand, in one place. Optional token limits live in shared/budget.ts;
 * code, workspace, document, and attachment limits live with their schemas in shared/code.ts and shared/workspace.ts.
 */

/** Longest message a user can send, in characters. */
export const MESSAGE_CHARS = 4000;
/** Model requests: per-attempt timeout, attempts, and exponential backoff plus random jitter between retryable failures. */
export const MODEL_REQUEST = { timeoutMs: 60_000, attempts: 3, backoffMs: 500, jitterMs: 200 } as const;
/** What the model sees: recent messages and their length, observations kept in history and the preview of older ones, images per request and their estimated tokens. */
export const CONTEXT = { messages: 16, messageChars: 6000, history: 32, historyTokens: 24000, summaryChars: 600, notesChars: 12000, images: 4, imageTokens: 1000 } as const;
/** Images sent to the model: the longest side, and the size up to which an image within it is sent unchanged. */
export const IMAGE = { maxSide: 1568, keepBytes: 1_500_000 } as const;
/** Kept state: checkpoints per thread, activity entries per conversation, and extracted documents cached in the task page. */
export const STORAGE = { checkpoints: 3, activity: 300, extractedDocuments: 8 } as const;
/** Progressing tasks have no fixed round ceiling; consecutive failures pause separately. */
export const GRAPH_RECURSION_LIMIT = Number.MAX_SAFE_INTEGER;
export const NO_PROGRESS_LIMIT = 6;
/** Sandbox frame: time to load, and grace beyond a run's own timeout before the task page gives up on it. */
export const SANDBOX = { loadMs: 10_000, graceMs: 5000 } as const;
/** Background page waits: document readiness timeout, longest pause between checks, and the longest wait for a navigation to start after back or a click. */
export const PAGE_WAIT = { loadMs: 20_000, recheckMs: 250, backMs: 250, settleMs: 400 } as const;
/** Blob URL lifetimes: a download, and a PDF opened in a new tab. */
export const BLOB_URL = { downloadMs: 1000, pdfMs: 60_000 } as const;
