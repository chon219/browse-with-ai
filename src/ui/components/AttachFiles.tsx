import { useEffect, useRef, useState, type RefObject } from 'react';
import { t } from '../../i18n';
import { AttachIcon } from './icons';
import { formatSize } from '../helpers';
import { readBytes } from '../../storage/workspace';
import { isImage, type AttachedFile } from '../../shared/workspace';
import type { Attachment } from '../attachments';

/** Opens the file picker; with `compact`, an icon-only button for the conversation composer. */
export function AttachButton({ onAdd, compact = false, inputRef }: { onAdd: (files: File[]) => void; compact?: boolean; inputRef?: RefObject<HTMLInputElement | null> }) {
  const localInput = useRef<HTMLInputElement>(null);
  const input = inputRef ?? localInput;
  return <>
    <button type="button" className={compact ? 'quiet icon attach-files' : 'chip attach-files'} aria-label={t('app.attachFiles')} title={t('app.attachFilesHint')} onClick={() => input.current?.click()}>
      <AttachIcon/>{!compact && <span>{t('app.attachFiles')}</span>}
    </button>
    <input ref={input} type="file" multiple hidden data-testid="attach-input" onChange={event => { onAdd([...event.target.files ?? []]); event.target.value = ''; }}/>
  </>;
}
/** Files waiting to be sent with the next message, with their size and, for images, a thumbnail. */
export function FileChips({ files, onRemove }: { files: Attachment[]; onRemove: (index: number) => void }) {
  return <>{files.map((file, index) => <span key={`${file.name}:${index}`} className="file-chip">
    {file.preview ? <img src={file.preview} alt=""/> : <AttachIcon/>}
    <span title={file.name}>{file.name}</span><small>{formatSize(file.size)}</small>
    <button type="button" className="quiet icon" aria-label={t('app.removeFile', { name: file.name })} onClick={() => onRemove(index)}>×</button>
  </span>)}</>;
}
/** A thumbnail of a workspace image, loaded when shown. */
function WorkspaceThumbnail({ taskId, path }: { taskId: string; path: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let current: string | undefined; let live = true;
    readBytes(taskId, path).then(bytes => { if (live) setUrl(current = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>]))); }, () => {});
    return () => { live = false; if (current) URL.revokeObjectURL(current); };
  }, [taskId, path]);
  return url ? <img src={url} alt=""/> : <AttachIcon/>;
}
/** The files attached to a sent message. */
export function MessageFiles({ taskId, files }: { taskId: string; files: AttachedFile[] }) {
  return <ul className="message-files" aria-label={t('chat.attachments')}>
    {files.map(file => <li key={file.path} title={file.path}>
      {isImage(file.type) ? <WorkspaceThumbnail taskId={taskId} path={file.path}/> : <AttachIcon/>}
      <span>{file.path.replace(/^uploads\//, '')}</span><small>{formatSize(file.size)}</small>
    </li>)}
  </ul>;
}
