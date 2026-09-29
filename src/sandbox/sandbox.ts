/**
 * Runs agent-written JavaScript away from the extension. This page is declared as a manifest sandbox:
 * it has an opaque origin, no extension APIs or extension storage, and a CSP without network access.
 * Code never runs on this page itself: each run gets a fresh worker, so a run that does not finish
 * in time is simply terminated. File access is relayed to the task page, which applies the limits.
 * The same workers extract the text of documents with the bundled libraries (see ./libraries), since
 * parsing files from the web is risky too.
 */
interface Run { type: 'run'; id: string; code: string; timeoutMs: number; archiveChars: number; fileCalls: number }
interface Convert { type: 'convert'; id: string; kind: string; bytes: Uint8Array; timeoutMs: number; limits: Record<string, number> }

/** Library bundles, by the globals each defines; a run loads those its code uses (as name. or name(). */
const LIBRARIES: Record<string, string> = { pdfjsLib: 'lib-pdf.js', mammoth: 'lib-docx.js', XLSX: 'lib-sheet.js', docx: 'lib-word.js', markdownToDocx: 'lib-word.js' };
/** The bundle that extracts each kind of document. */
const CONVERTERS: Record<string, string> = { pdf: 'lib-pdf.js', docx: 'lib-docx.js', sheet: 'lib-sheet.js' };
const libraryUrl = (file: string) => new URL(file, location.href).href;

/** Available in the worker, which the DOM typings do not describe. */
declare function importScripts(...urls: string[]): void;

/** The worker's whole program. Serialized with toString, so it may not refer to anything outside itself. */
function workerMain() {
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextCall = 0; let logs = ''; let archiveChars = 0; let logsChars = 0;
  const format = (value: unknown) => {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
  };
  const log = (...values: unknown[]) => {
    const line = (logsChars ? '\n' : '') + values.map(format).join(' ');
    logsChars += line.length;
    if (logs.length < archiveChars) logs += line.slice(0, archiveChars - logs.length);
  };
  const call = (op: string, args: Record<string, unknown>) => new Promise((resolve, reject) => {
    const callId = ++nextCall; pending.set(callId, { resolve, reject });
    postMessage({ type: 'file', callId, op, args });
  });
  const files = Object.freeze({
    list: () => call('list_files', {}),
    read: (path: string) => call('read_file', { path }),
    readBytes: (path: string) => call('read_bytes', { path }),
    write: (path: string, content: unknown) => call('write_file', { path, content: format(content) }),
    writeBytes: (path: string, bytes: Uint8Array | ArrayBuffer) => call('write_bytes', { path, bytes }),
    append: (path: string, content: unknown) => call('append_file', { path, content: format(content) }),
    delete: (path: string) => call('delete_file', { path }),
  });
  const sandboxConsole = Object.freeze({ log, info: log, warn: log, error: log, debug: log });
  const describe = (error: unknown) => error instanceof Error ? `${error.name}: ${error.message}` : format(error);
  onmessage = async (event: MessageEvent) => {
    const data = event.data;
    // Library bundles load further bundles of their own (such as lib-code-pages.js) from here.
    if (data?.libraryBase) Object.assign(self, { bwaiLibraryBase: data.libraryBase });
    if (data?.type === 'fileResult') {
      const waiting = pending.get(data.callId); pending.delete(data.callId);
      if (data.ok) waiting?.resolve(data.value); else waiting?.reject(new Error(data.error));
      return;
    }
    // A library bundle defines bwaiConvert along with its global.
    if (data?.type === 'convert') {
      try {
        importScripts(data.library);
        const convert = (self as unknown as { bwaiConvert: (bytes: Uint8Array, limits: Record<string, number>) => Promise<string> }).bwaiConvert;
        postMessage({ type: 'done', logs: '', result: await convert(data.bytes, data.limits) });
      } catch (error) { postMessage({ type: 'done', logs: '', error: describe(error) }); }
      return;
    }
    if (data?.type !== 'run') return;
    archiveChars = data.archiveChars;
    try {
      const used = Object.entries(data.libraries as Record<string, string>).filter(([name]) => new RegExp(`\\b${name}\\s*[.(]`).test(data.code));
      for (const url of new Set(used.map(([, url]) => url))) importScripts(url);
      const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
      const value = await new AsyncFunction('files', 'console', data.code)(files, sandboxConsole);
      const result = value === undefined ? undefined : format(value);
      postMessage({ type: 'done', logs, logsChars, ...(result === undefined ? {} : { result: result.slice(0, archiveChars), resultChars: result.length }) });
    } catch (error) {
      const text = describe(error);
      postMessage({ type: 'done', logs, logsChars, error: text.slice(0, archiveChars), errorChars: text.length });
    }
  };
}

const workerUrl = URL.createObjectURL(new Blob([`(${workerMain.toString()})()`], { type: 'text/javascript' }));
const runs = new Map<string, { worker: Worker; finish: (message: Record<string, unknown>) => void }>();
const reply = (message: Record<string, unknown>) => window.parent.postMessage(message, '*');

function start(run: Run | Convert) {
  const worker = new Worker(workerUrl); let fileCalls = 0; const allowedCalls = run.type === 'run' ? run.fileCalls : 0;
  const finish = (message: Record<string, unknown>) => {
    if (!runs.has(run.id)) return;
    clearTimeout(timer); worker.terminate(); runs.delete(run.id);
    reply({ logs: '', ...message, type: 'done', id: run.id });
  };
  const timer = setTimeout(() => finish({ timedOut: true }), run.timeoutMs);
  worker.onmessage = event => {
    const data = event.data;
    if (data?.type === 'done') finish({ logs: data.logs, result: data.result, error: data.error, logsChars: data.logsChars, resultChars: data.resultChars, errorChars: data.errorChars });
    else if (data?.type === 'file') {
      if (++fileCalls > allowedCalls) worker.postMessage({ type: 'fileResult', callId: data.callId, ok: false, error: `More than ${allowedCalls} file operations in one run` });
      else reply({ type: 'file', id: run.id, callId: data.callId, op: data.op, args: data.args });
    }
  };
  worker.onerror = event => { event.preventDefault(); finish({ error: event.message || 'Worker error' }); };
  runs.set(run.id, { worker, finish });
  if (run.type === 'run') worker.postMessage({ ...run, libraryBase: libraryUrl('.'), libraries: Object.fromEntries(Object.entries(LIBRARIES).map(([name, file]) => [name, libraryUrl(file)])) });
  else if (!CONVERTERS[run.kind]) finish({ error: `Cannot read ${run.kind} documents` });
  else worker.postMessage({ type: 'convert', libraryBase: libraryUrl('.'), library: libraryUrl(CONVERTERS[run.kind]), bytes: run.bytes, limits: run.limits }, [run.bytes.buffer]);
}

window.addEventListener('message', event => {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (data?.type === 'run' || data?.type === 'convert') start(data as Run | Convert);
  else if (data?.type === 'fileResult') runs.get(data.id)?.worker.postMessage(data);
  else if (data?.type === 'cancel') runs.get(data.id)?.finish({ error: 'Cancelled' });
});
reply({ type: 'ready' });
