import { useEffect, useRef, useState } from 'react';
import { readBytes } from '../../storage/workspace';
import { display, errorText, getLocale, t, type Text } from '../../i18n';
import { documentKind, isImage, isPrintable, textContent, type WorkspaceFile } from '../../shared/workspace';
import { convertDocument } from '../../agent/code-runner';
import { downloadBlob, formatSize } from '../helpers';
import { BLOB_URL } from '../../shared/tuning';
import type { ResourceFile } from '../page-resources';

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

export function WorkspacePreview({ taskId, file, onClose }: { taskId: string; file?: ResourceFile; onClose: () => void }) {
  const [open, setOpen] = useState<Preview>();
  const dialog = useRef<HTMLDialogElement>(null); const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let live = true; let imageUrl: string | undefined;
    if (!file) { setOpen(undefined); return; }
    setOpen({ file });
    void (async () => {
      try {
        const bytes = await readBytes(taskId, file.path);
        if (!live) return;
        const loaded: Preview = isImage(file.type)
          ? { file, bytes, image: imageUrl = blobUrl({ file, bytes }) }
          : { file, bytes, text: documentKind(file.type) ? undefined : textContent(bytes) };
        setOpen(loaded);
        const kind = loaded.text === undefined ? documentKind(file.type) : undefined;
        if (kind) {
          const done = await convertDocument(bytes, kind).then(extracted => ({ extracted }), (error: unknown) => ({ extractError: errorText(error, 'document.failed') }));
          if (live) setOpen({ ...loaded, ...done });
        }
      } catch { if (live) setOpen({ file, failed: true }); }
    })();
    return () => { live = false; if (imageUrl) URL.revokeObjectURL(imageUrl); };
  }, [taskId, file]);
  useEffect(() => {
    if (open) { if (!dialog.current?.open) { dialog.current?.showModal(); closeButton.current?.focus(); } }
    else dialog.current?.close();
  }, [open]);
  return (
    <dialog ref={dialog} className="file-dialog" aria-labelledby="file-title" onClose={onClose}>
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
          <button ref={closeButton} className="secondary" onClick={onClose}>{t('common.close')}</button>
          {open.bytes && open.file.type === 'application/pdf' && <button className="secondary" onClick={() => openPdf(open)}>{t('app.openPdf')}</button>}
          {open.text !== undefined && isPrintable(open.file.type) && <button className="secondary" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL(`print.html?${new URLSearchParams({ task: taskId, path: open.file.path })}`) }).catch(() => setOpen(state => state && { ...state, printFailed: true }))}>{t('app.printPdf')}</button>}
          <button disabled={!open.bytes} onClick={() => open.bytes && download(open.file, open.bytes, open.text)}>{t('app.downloadFile')}</button>
        </div>
      </>}
    </dialog>
  );
}
