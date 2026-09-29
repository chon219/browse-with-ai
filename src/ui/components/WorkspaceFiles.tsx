import { useEffect, useRef, useState } from 'react';
import { listFiles, onWorkspaceChange, readBytes, readFileHeader } from '../../storage/workspace';
import { display, errorText, getLocale, t, type Text } from '../../i18n';
import { documentKind, isImage, isPrintable, textContent, type WorkspaceFile } from '../../shared/workspace';
import { convertDocument } from '../../agent/code-runner';
import { downloadBlob, formatSize } from '../helpers';
import { BLOB_URL } from '../../shared/tuning';
import type { Task } from '../../shared/types';
import { archiveSource, isPageArchive, pageAddress, pageResources, type ResourceFile } from '../page-resources';

function download(file: WorkspaceFile, bytes: Uint8Array, text: string | undefined) {
  // A byte order mark lets spreadsheet apps detect UTF-8 in CSV files.
  const parts: BlobPart[] = text !== undefined && file.type === 'text/csv' ? ['﻿', text] : [bytes as Uint8Array<ArrayBuffer>];
  const blob = new Blob(parts, { type: text !== undefined ? `${file.type};charset=utf-8` : file.type });
  downloadBlob(blob, file.path.split('/').pop()!);
}
const modified = (file: WorkspaceFile) => new Date(file.modifiedAt).toLocaleString(getLocale(), { dateStyle: 'short', timeStyle: 'short' });
/** A file being previewed: text files as text, images as images, and documents as their extracted text once ready. */
interface Preview { file: ResourceFile; bytes?: Uint8Array; text?: string; image?: string; failed?: boolean; extracted?: string; extractError?: Text; printFailed?: boolean }
const blobUrl = (preview: Preview) => URL.createObjectURL(new Blob([preview.bytes as Uint8Array<ArrayBuffer>], { type: preview.file.type }));
/** Chrome's own viewer shows the PDF; the URL is released once the new tab has loaded it. */
function openPdf(preview: Preview) { const url = blobUrl(preview); window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), BLOB_URL.pdfMs); }

/** Refresh on file changes, independently of task messages, usage and execution state. */
export function WorkspaceFiles({ task }: { task: Task }) {
  const taskId = task.id;
  const [files, setFiles] = useState<ResourceFile[]>([]);
  const [open, setOpen] = useState<Preview>();
  const dialog = useRef<HTMLDialogElement>(null); const closeButton = useRef<HTMLButtonElement>(null); const previewRun = useRef(0);
  const close = () => { previewRun.current++; setOpen(undefined); };
  useEffect(() => {
    let sequence = 0;
    let cached = new Map<string, ResourceFile>();
    const refresh = () => {
      const run = ++sequence;
      void listFiles(taskId).then(found => Promise.all(found.map(async file => {
        const old = cached.get(file.path);
        if (old && old.size === file.size && old.modifiedAt === file.modifiedAt) return old;
        if (!isPageArchive(file.path)) return file;
        try { return { ...file, page: archiveSource(file.path, await readFileHeader(taskId, file.path)) }; }
        catch { return file; }
      }))).then(found => {
        if (run !== sequence) return;
        cached = new Map(found.map(file => [file.path, file])); setFiles(found);
      }, () => { if (run === sequence) setFiles([]); });
    };
    const stop = onWorkspaceChange(taskId, refresh);
    refresh();
    return () => { sequence++; stop(); };
  }, [taskId]);
  useEffect(() => { if (open) { if (!dialog.current?.open) { dialog.current?.showModal(); closeButton.current?.focus(); } } else dialog.current?.close(); }, [open]);
  useEffect(() => () => { if (open?.image) URL.revokeObjectURL(open.image); }, [open?.image]);
  async function preview(file: ResourceFile) {
    const run = ++previewRun.current; setOpen({ file });
    try {
      const bytes = await readBytes(taskId, file.path);
      const loaded: Preview = isImage(file.type) ? { file, bytes, image: blobUrl({ file, bytes }) } : { file, bytes, text: documentKind(file.type) ? undefined : textContent(bytes) };
      // The preview moved on (closed or another file) before this one loaded: release its image now.
      if (run !== previewRun.current) { if (loaded.image) URL.revokeObjectURL(loaded.image); return; }
      setOpen(state => state?.file === file ? loaded : state);
      const kind = loaded.text === undefined ? documentKind(file.type) : undefined;
      if (kind) {
        const done = await convertDocument(bytes, kind).then(extracted => ({ extracted }), (error: unknown) => ({ extractError: errorText(error, 'document.failed') }));
        setOpen(state => state?.file === file ? { ...state, ...done } : state);
      }
    } catch { setOpen(state => state?.file === file ? { file, failed: true } : state); }
  }
  const resources = pageResources(files, task.visitedUrls ?? [], [
    ...(task.contextTab ? [task.contextTab] : []), ...(task.lastPage ? [task.lastPage] : []), ...(task.visitedPages ?? []),
  ]);
  return <>
    <details className="files" data-testid="workspace-files">
      <summary>{t('app.files')} <span className="count">{resources.files.length}</span></summary>
      <p className="hint">{t(resources.files.length ? 'app.filesHint' : 'app.filesEmpty')}</p>
      {!!resources.files.length && <ul>{resources.files.map(file => <li key={file.path}>
        <button className="file-item" aria-label={t('app.previewFile', { path: file.path })} onClick={() => void preview(file)}>
          <span className="file-path">{file.path}</span><small>{formatSize(file.size)} · {modified(file)}</small>
        </button>
      </li>)}</ul>}
    </details>
    {!!resources.pages.length && <details className="visited" data-testid="visited-pages">
      <summary>{t('app.visitedPages')} <span className="count">{resources.pages.length}</span></summary>
      <ul className="page-list">{resources.pages.map(page => <li className="page-resource" key={page.url}>
        <div className="page-heading">
          <a className="page-title" href={page.url} target="_blank" rel="noreferrer" title={page.title ? `${page.title}\n${page.url}` : page.url}>{page.title || page.url}</a>
          {!!page.files.length && <button type="button" className="secondary page-preview" aria-label={t('app.previewPage', { title: page.title || page.url })} onClick={() => void preview(page.files[0])}>{t('app.previewMarkdown')}</button>}
        </div>
        <span className="page-address" title={page.url}>{pageAddress(page.url)}</span>
        {page.files.length ? <>
          {page.files.length > 1 && <details className="page-versions">
            <summary>{t('app.pageSnapshots', { count: page.files.length })}</summary>
            <ul>{page.files.map((file, index) => <li key={file.path}><button type="button" className="file-item" title={file.path} onClick={() => void preview(file)}>
              <span>{t('app.previewSnapshot', { index: page.files.length - index, at: modified(file) })}</span><small>{formatSize(file.size)}</small>
            </button></li>)}</ul>
          </details>}
        </> : <span className="hint">{t('app.noPageSnapshot')}</span>}
      </li>)}</ul>
    </details>}
    <dialog ref={dialog} className="file-dialog" aria-labelledby="file-title" onClose={close}>
      {open && <>
        <h2 id="file-title">{open.file.page?.title || open.file.path}</h2>
        {open.file.page && <p className="page-source"><a href={open.file.page.url} target="_blank" rel="noreferrer">{open.file.page.url}</a><small>{open.file.path}</small></p>}
        <p className="hint">{formatSize(open.file.size)} · {modified(open.file)}</p>
        {open.failed ? <p role="alert">{t('app.fileLoadFailed')}</p>
          : open.image ? <div className="file-image"><img src={open.image} alt={open.file.path}/></div>
          : open.extracted !== undefined ? <><p className="hint">{t('app.extractedText')}</p><pre className="file-content" tabIndex={0}>{open.extracted || t('app.noExtractedText')}</pre></>
          : open.extractError ? <p className="file-unavailable" role="alert">{display(open.extractError)}</p>
          : open.bytes && open.text === undefined && documentKind(open.file.type) ? <p className="file-unavailable">{t('app.extractingText')}</p>
          : open.bytes && open.text === undefined ? <p className="file-unavailable">{t('app.filePreviewUnavailable')}</p>
          : <pre className="file-content" tabIndex={0}>{open.text ?? ''}</pre>}
        {open.printFailed && <p role="alert">{t('common.operationFailed')}</p>}
        <div className="buttons">
          <button ref={closeButton} className="secondary" onClick={close}>{t('common.close')}</button>
          {open.bytes && open.file.type === 'application/pdf' && <button className="secondary" onClick={() => openPdf(open)}>{t('app.openPdf')}</button>}
          {open.text !== undefined && isPrintable(open.file.type) && <button className="secondary" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL(`print.html?${new URLSearchParams({ task: taskId, path: open.file.path })}`) }).catch(() => setOpen(state => state && { ...state, printFailed: true }))}>{t('app.printPdf')}</button>}
          <button disabled={!open.bytes} onClick={() => open.bytes && download(open.file, open.bytes, open.text)}>{t('app.downloadFile')}</button>
        </div>
      </>}
    </dialog>
  </>;
}
