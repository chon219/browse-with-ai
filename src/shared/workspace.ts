import { z } from 'zod';

/** Files kept with a conversation, text or binary. Paths are relative to that conversation's own directory. */
export const WORKSPACE_LIMITS = { fileBytes: 10_000_000, totalBytes: 100_000_000, files: 200, depth: 5, pathLength: 200, readChars: 12_000 } as const;

const segment = /^[^/\\\u0000-\u001f<>:"|?*]+$/;
/** Split a relative path into safe segments, or return undefined when it would leave the workspace or is not a valid file name. */
export function workspacePath(path: string): string[] | undefined {
  if (path.length > WORKSPACE_LIMITS.pathLength) return undefined;
  const parts = path.replace(/\\/g, '/').replace(/^\.\//, '').split('/');
  if (!parts.length || parts.length > WORKSPACE_LIMITS.depth) return undefined;
  const valid = parts.every(part => part !== '.' && part !== '..' && part.trim() === part && part.length <= 100 && segment.test(part) && !part.endsWith('.'));
  return valid ? parts : undefined;
}

/** Files the user attaches to one message; they are stored under `uploads/`. */
export const ATTACHMENT_LIMITS = { files: 10 } as const;
/** Where a file the user attached is stored: under uploads/, with characters paths cannot hold replaced, numbered when the name is taken. */
export function uploadPath(name: string, taken: ReadonlySet<string>): string {
  const clean = name.replace(/[/\\\u0000-\u001f<>:"|?*]/g, '_').trim().replace(/[.\s]+$/, '') || 'file';
  const dot = clean.lastIndexOf('.');
  const base = (dot > 0 ? clean.slice(0, dot) : clean).slice(0, 80).trim() || 'file';
  const extension = dot > 0 ? clean.slice(dot, dot + 16) : '';
  for (let n = 1; ; n++) {
    const path = `uploads/${n === 1 ? base : `${base} (${n})`}${extension}`;
    if (!taken.has(path)) return path;
  }
}
/** The text of a file when it is UTF-8 text, without a byte order mark; undefined for anything else. */
export function textContent(bytes: Uint8Array): string | undefined {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return undefined; }
  return text.includes('\u0000') ? undefined : text;
}

const TYPES: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', html: 'text/html', htm: 'text/html', xml: 'application/xml', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  pdf: 'application/pdf', zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12', xls: 'application/vnd.ms-excel', ods: 'application/vnd.oasis.opendocument.spreadsheet',
};
/** The media type of a workspace file, from its extension. */
export const mediaType = (path: string) => TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
/** Files the print page can show for saving as PDF (see src/ui/print-document.ts). */
export const isPrintable = (type: string) => type === 'text/markdown' || type === 'text/html';
/** Raster images a vision model can be shown and the page can preview. */
export const isImage = (type: string) => ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type);

/** Documents whose text the sandbox can extract (see src/sandbox/libraries). */
export type DocumentKind = 'pdf' | 'docx' | 'sheet';
export const DOCUMENT_LIMITS = { timeoutMs: 30_000, pages: 300, chars: 2_000_000 } as const;
const DOCUMENT_TYPES: Record<string, DocumentKind> = {
  'application/pdf': 'pdf', [TYPES.docx]: 'docx', [TYPES.xlsx]: 'sheet', [TYPES.xlsm]: 'sheet', [TYPES.xls]: 'sheet', [TYPES.ods]: 'sheet',
};
export const documentKind = (type: string): DocumentKind | undefined => DOCUMENT_TYPES[type];

/** One slice of a file's text, starting at offset, with the offset of the next slice when more remains. */
export function textSlice(path: string, text: string, offset = 0) {
  const end = offset + WORKSPACE_LIMITS.readChars;
  return { path, content: text.slice(offset, end), totalChars: text.length, ...(end < text.length ? { nextOffset: end } : {}) };
}

const path = z.string().min(1).max(WORKSPACE_LIMITS.pathLength);
export const workspaceActionSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('list_files') }).strict(),
  z.object({ name: z.literal('read_file'), path, offset: z.number().int().min(0).optional() }).strict(),
  z.object({ name: z.enum(['write_file', 'append_file']), path, content: z.string().max(WORKSPACE_LIMITS.fileBytes) }).strict(),
  z.object({ name: z.literal('delete_file'), path }).strict(),
  z.object({ name: z.literal('view_image'), path }).strict(),
]);
export type WorkspaceAction = z.infer<typeof workspaceActionSchema>;
export interface WorkspaceFile { path: string; size: number; modifiedAt: string; type: string }
export interface WorkspaceResult {
  files?: WorkspaceFile[];
  /** A text file's content, or a document's extracted text (with convertedFrom, its type), or for other binary files only their type and size. */
  file?: { path: string; content: string; totalChars: number; nextOffset?: number; convertedFrom?: string } | { path: string; binary: true; type: string; size: number };
  written?: WorkspaceFile; deleted?: string;
  /** An image the model asked to see; it is sent with the next request. */
  image?: { path: string; type: string; size: number };
}
/** A file the user attached to a message, as stored in the workspace. */
export interface AttachedFile { path: string; size: number; type: string }
