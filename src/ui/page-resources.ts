import type { WorkspaceFile } from '../shared/workspace';

export interface PageSource { url: string; title: string }
export interface ResourceFile extends WorkspaceFile { page?: PageSource }
export interface PageResource extends PageSource { files: ResourceFile[] }

/** Match the archive format, not arbitrary Markdown documents in the workspace. */
export const isPageArchive = (path: string) => /^pages\/[a-f0-9]{32}\.md$/.test(path);

/** Use the same fragment-free identity as browsing history, and reject executable URLs. */
export function pageUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'file:'].includes(url.protocol)) return;
    url.hash = '';
    return url.href;
  } catch { return; }
}

export function archiveSource(path: string, prefix: string): PageSource | undefined {
  if (!isPageArchive(path)) return;
  const header = /^URL: ([^\r\n]+)\r?\nTitle: ([^\r\n]*)\r?\n/.exec(prefix);
  const url = header && pageUrl(header[1]);
  return url ? { url, title: header![2].trim() } : undefined;
}

/** Keep each saved version, but show a page only once. Unrecognized files remain ordinary files. */
export function pageResources(files: ResourceFile[], visitedUrls: string[], titles: PageSource[] = []) {
  const pages = new Map<string, PageResource>();
  const ensure = (value: string) => {
    const url = pageUrl(value);
    if (!url) return;
    if (!pages.has(url)) pages.set(url, { url, title: '', files: [] });
    return pages.get(url)!;
  };
  for (const url of visitedUrls) ensure(url);
  const ordinary: ResourceFile[] = [];
  for (const file of files) {
    const page = file.page && ensure(file.page.url);
    if (!page) { ordinary.push(file); continue; }
    page.files.push(file);
  }
  for (const page of pages.values()) {
    page.files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path));
    page.title = page.files.find(file => file.page?.title)?.page?.title ?? '';
  }
  for (const source of titles) {
    const page = pages.get(pageUrl(source.url) ?? '');
    if (page && source.title.trim()) page.title = source.title.trim();
  }
  return { files: ordinary, pages: [...pages.values()] };
}

/** Preserve the path to distinguish pages on the same host; the link retains the full URL. */
export function pageAddress(value: string): string {
  try { const url = new URL(value); return `${url.host}${url.pathname === '/' ? '' : url.pathname}${url.search}` || value; }
  catch { return value; }
}
