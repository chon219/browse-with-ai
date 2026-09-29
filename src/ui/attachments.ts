import type React from 'react';
import { useCallback, useRef, useState } from 'react';
import { LocalizedError } from '../i18n';
import { ATTACHMENT_LIMITS, isImage, mediaType, WORKSPACE_LIMITS } from '../shared/workspace';

/** A file the user picked or pasted, waiting to be stored with the next message. */
export interface Attachment { name: string; bytes: Uint8Array; size: number; /** An object URL for image thumbnails. */ preview?: string }

async function readAttachment(file: File): Promise<Attachment> {
  if (file.size > WORKSPACE_LIMITS.fileBytes) throw new LocalizedError('attach.tooLarge', { name: file.name, limit: WORKSPACE_LIMITS.fileBytes / 1_000_000 });
  // Pasted screenshots come without a useful name.
  const name = file.name && file.name !== 'image.png' ? file.name : `screenshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
  const type = mediaType(name);
  return { name, bytes: new Uint8Array(await file.arrayBuffer()), size: file.size, ...(isImage(type) ? { preview: URL.createObjectURL(file) } : {}) };
}
/** Read picked files before merging them into the latest draft. Invalid files are skipped; the first problem is reported. */
export async function readAttachments(files: File[]): Promise<{ files: Attachment[]; error?: LocalizedError }> {
  const next: Attachment[] = []; let error: LocalizedError | undefined;
  for (const file of files) {
    if (next.length >= ATTACHMENT_LIMITS.files) { error ??= new LocalizedError('attach.tooMany', { limit: ATTACHMENT_LIMITS.files }); break; }
    try { next.push(await readAttachment(file)); } catch (e) { if (e instanceof LocalizedError) error ??= e; else throw e; }
  }
  return { files: next, error };
}
/** Append newly read files, keeping at most `limit`; the rest are returned as dropped so their thumbnails can be released. */
export function mergeAttachments(current: Attachment[], added: Attachment[], limit: number = ATTACHMENT_LIMITS.files) {
  const room = Math.max(0, limit - current.length);
  return { files: [...current, ...added.slice(0, room)], dropped: added.slice(room) };
}
export type SetAttachments = (next: Attachment[] | ((current: Attachment[]) => Attachment[])) => void;
/** Files waiting to be sent. Updates apply synchronously to the latest list, so concurrent adds and sends never work from a stale copy. */
export function useAttachments() {
  const [files, setFiles] = useState<Attachment[]>([]); const latest = useRef(files);
  const set: SetAttachments = useCallback(next => { latest.current = typeof next === 'function' ? next(latest.current) : next; setFiles(latest.current); }, []);
  return [files, set, latest] as const;
}
/** Release thumbnails of attachments that were sent or removed. */
export const releaseAttachments = (files: Attachment[]) => files.forEach(file => file.preview && URL.revokeObjectURL(file.preview));
/** Files pasted into a message box, if any; text pastes are left alone. */
export const pastedFiles = (event: React.ClipboardEvent) => [...event.clipboardData.files];
