import { CODE_LIMITS, SANDBOX_FILE_OPS, type CodeRun } from '../shared/code';
import { DOCUMENT_LIMITS, workspaceActionSchema, type DocumentKind } from '../shared/workspace';
import { SANDBOX, STORAGE } from '../shared/tuning';
import { listFiles, readBytes, readFile } from '../storage/workspace';
import { workspaceAction, workspaceWriteBytes } from '../storage/db';
import { LocalizedError, msg, translate } from '../i18n';
import { prepareCodeOutput } from './code-output';

/**
 * Runs agent-written JavaScript in the sandbox page (src/sandbox/sandbox.ts) through a hidden frame
 * of the task page. The frame can only reach the running conversation's workspace, through the
 * operations relayed here.
 */
interface RunFiles { taskId: string; changed: Set<string> }
interface SandboxReply { logs?: string; result?: string; error?: string; timedOut?: boolean; logsChars?: number; resultChars?: number; errorChars?: number }
interface Pending { signal?: AbortSignal; files?: RunFiles; finish(reply: SandboxReply): void }
const requests = new Map<string, Pending>();
let frame: Promise<Window> | undefined;

function sandbox(): Promise<Window> {
  return frame ??= new Promise<Window>((resolve, reject) => {
    const element = document.createElement('iframe');
    element.src = chrome.runtime.getURL('sandbox.html'); element.hidden = true; element.title = 'BWAI sandbox';
    const timer = setTimeout(() => { frame = undefined; window.removeEventListener('message', ready); element.remove(); reject(new LocalizedError('code.unavailable')); }, SANDBOX.loadMs);
    const ready = (event: MessageEvent) => {
      if (event.source !== element.contentWindow || event.data?.type !== 'ready') return;
      clearTimeout(timer); window.removeEventListener('message', ready); resolve(element.contentWindow!);
    };
    window.addEventListener('message', ready);
    window.addEventListener('message', relay);
    document.body.append(element);
  });
}

const clip = (text: string) => text.length > CODE_LIMITS.outputChars ? text.slice(0, CODE_LIMITS.outputChars) + '…' : text;
/** Errors reach the code as exceptions; keep them in the model's canonical language. */
const errorMessage = (error: unknown) => error instanceof LocalizedError ? translate('en', error.text.key, error.text.params) : error instanceof Error ? error.message : String(error);

async function fileOperation(run: RunFiles, op: string, args: Record<string, unknown>) {
  if (!(SANDBOX_FILE_OPS as readonly string[]).includes(op)) throw new Error(`Unknown file operation ${op}`);
  if (op === 'list_files') return listFiles(run.taskId);
  if (op === 'read_file') return readFile(run.taskId, String(args.path));
  if (op === 'read_bytes') return readBytes(run.taskId, String(args.path));
  if (op === 'write_bytes') {
    const bytes = args.bytes instanceof Uint8Array ? args.bytes : args.bytes instanceof ArrayBuffer ? new Uint8Array(args.bytes) : undefined;
    if (!bytes) throw new Error('files.writeBytes needs a Uint8Array or an ArrayBuffer');
    run.changed.add((await workspaceWriteBytes(run.taskId, String(args.path), bytes)).path);
    return null;
  }
  const action = workspaceActionSchema.parse({ ...args, name: op });
  const result = await workspaceAction(run.taskId, action);
  const path = result.written?.path ?? result.deleted; if (path) run.changed.add(path);
  return null;
}
async function relay(event: MessageEvent) {
  const source = await frame?.catch(() => undefined);
  if (!source || event.source !== source) return;
  const data = event.data;
  const pending = requests.get(data?.id);
  if (!pending) return;
  if (data.type === 'file' && pending.files) {
    try {
      pending.signal?.throwIfAborted();
      const value = await fileOperation(pending.files, data.op, data.args ?? {});
      source.postMessage({ type: 'fileResult', id: data.id, callId: data.callId, ok: true, value }, '*');
    } catch (error) { source.postMessage({ type: 'fileResult', id: data.id, callId: data.callId, ok: false, error: errorMessage(error) }, '*'); }
  } else if (data.type === 'done') pending.finish({
    logs: String(data.logs ?? ''),
    ...(typeof data.result === 'string' ? { result: data.result } : {}),
    ...(typeof data.error === 'string' ? { error: data.error } : {}),
    timedOut: !!data.timedOut, logsChars: data.logsChars, resultChars: data.resultChars, errorChars: data.errorChars,
  });
}

/** Both worker operations share cancellation, timeout and listener cleanup. */
async function request(message: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal, files?: RunFiles): Promise<SandboxReply> {
  signal?.throwIfAborted();
  const target = await sandbox();
  signal?.throwIfAborted();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); requests.delete(id); signal?.removeEventListener('abort', abort); };
    const cancel = () => target.postMessage({ type: 'cancel', id }, '*');
    const abort = () => { cleanup(); cancel(); reject(signal!.reason); };
    // Workers enforce their own deadline; this covers a sandbox that stops responding.
    const timer = setTimeout(() => { cleanup(); cancel(); resolve({ timedOut: true }); }, timeoutMs + SANDBOX.graceMs);
    requests.set(id, { signal, files, finish: reply => { cleanup(); resolve(reply); } });
    signal?.addEventListener('abort', abort, { once: true });
    try { target.postMessage({ ...message, id, timeoutMs }, '*'); }
    catch (error) { cleanup(); reject(error); }
  });
}

/** Run code and archive long output after the worker has finished. */
export async function runCode(taskId: string, code: string, signal: AbortSignal): Promise<CodeRun> {
  const files: RunFiles = { taskId, changed: new Set() };
  const reply = await request({ type: 'run', code, archiveChars: CODE_LIMITS.archiveChars, fileCalls: CODE_LIMITS.fileCalls }, CODE_LIMITS.timeoutMs, signal, files);
  signal.throwIfAborted();
  const output = await prepareCodeOutput(reply, (path, content) => {
    signal.throwIfAborted();
    return workspaceAction(taskId, { name: 'write_file', path, content });
  });
  signal.throwIfAborted();
  return { ...output,
    ...(reply.timedOut ? { error: msg('code.timeout', { seconds: CODE_LIMITS.timeoutMs / 1000 }) } : {}),
    ...(files.changed.size ? { changedFiles: [...files.changed] } : {}),
  };
}

/** Recently extracted documents by content hash, so reading a long document slice by slice parses it once. */
const extracted = new Map<string, string>();

/** The text of a PDF, Word document, or spreadsheet, extracted in the sandbox. Throws a LocalizedError when it cannot be read. */
export async function convertDocument(bytes: Uint8Array, kind: DocumentKind, signal?: AbortSignal): Promise<string> {
  const key = kind + ':' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))].map(b => b.toString(16).padStart(2, '0')).join('');
  const known = extracted.get(key);
  if (known !== undefined) { extracted.delete(key); extracted.set(key, known); return known; }
  const reply = await request({ type: 'convert', kind, bytes, limits: { pages: DOCUMENT_LIMITS.pages, chars: DOCUMENT_LIMITS.chars } }, DOCUMENT_LIMITS.timeoutMs, signal);
  if (reply.timedOut) throw new LocalizedError('document.timeout', { seconds: DOCUMENT_LIMITS.timeoutMs / 1000 });
  if (typeof reply.result !== 'string') throw new LocalizedError('document.failed', { reason: clip(String(reply.error ?? '')) });
  extracted.set(key, reply.result);
  if (extracted.size > STORAGE.extractedDocuments) extracted.delete(extracted.keys().next().value!);
  return reply.result;
}
