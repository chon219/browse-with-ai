import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isImage, mediaType } from '../shared/workspace';

/*
 * A workspace Markdown or HTML file as a standalone document for Chrome to print, so the user can
 * save it as PDF. Its content may come from web pages: it is shown in a frame without scripts, and its
 * own policy blocks every request, so images can only be workspace files (inlined here) or data URLs.
 */
const POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
/** For Markdown: readable print typography with Chinese fonts, tables with borders, and A4 margins. */
const MARKDOWN_STYLE = `@page{size:A4;margin:18mm 16mm}
body{font:11pt/1.7 "PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC",system-ui,sans-serif;color:#1f2328;margin:0 auto;max-width:180mm;padding:12mm 0}
@media print{body{padding:0}}
h1{font-size:20pt;margin:0 0 12pt}h2{font-size:15pt;margin:18pt 0 8pt}h3{font-size:12.5pt;margin:14pt 0 6pt}
h1,h2,h3,h4{line-height:1.35;break-after:avoid}
p,li{orphans:2;widows:2}
table{border-collapse:collapse;width:100%;margin:10pt 0;font-size:10pt}
th,td{border:1px solid #c9ced6;padding:4pt 7pt;text-align:left;vertical-align:top}th{background:#f1f3f5}
tr{break-inside:avoid}
pre{background:#f6f8fa;padding:8pt 10pt;border-radius:4pt;white-space:pre-wrap;font-size:9pt}
code{font-family:ui-monospace,Consolas,monospace;font-size:.92em}
blockquote{margin:10pt 0;padding:2pt 12pt;border-left:3pt solid #d0d7de;color:#57606a}
img{max-width:100%}
a{color:#0b57d0}
hr{border:0;border-top:1px solid #d0d7de;margin:16pt 0}`;

const toDataUrl = (bytes: Uint8Array, type: string) => {
  let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(binary)}`;
};
/** Where a relative image reference points in the workspace, from the folder of the document. */
function workspaceTarget(documentPath: string, src: string) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/') || src.startsWith('#')) return undefined;
  let relative: string; try { relative = decodeURIComponent(src.split(/[?#]/)[0]); } catch { return undefined; }
  const parts = documentPath.split('/').slice(0, -1);
  for (const part of relative.split('/')) {
    if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

/** The document to print, as HTML for a frame's srcdoc. `load` reads another workspace file for images. */
export async function printDocument(path: string, text: string, load: (path: string) => Promise<Uint8Array>): Promise<string> {
  const markdown = mediaType(path) === 'text/markdown';
  const html = markdown ? `<!doctype html><html><head></head><body>${renderToStaticMarkup(React.createElement(Markdown, { remarkPlugins: [remarkGfm], skipHtml: true }, text))}</body></html>` : text;
  const document = new DOMParser().parseFromString(html, 'text/html');
  document.querySelectorAll('script, iframe, object, embed, base, meta[http-equiv]').forEach(element => element.remove());
  for (const image of document.querySelectorAll('img')) {
    const src = image.getAttribute('src') ?? ''; const target = workspaceTarget(path, src);
    if (src.startsWith('data:')) continue;
    const type = target ? mediaType(target) : '';
    const bytes = target && isImage(type) ? await load(target).catch(() => undefined) : undefined;
    if (bytes) image.setAttribute('src', toDataUrl(bytes, type)); else image.removeAttribute('src');
  }
  const head = document.head;
  head.prepend(Object.assign(document.createElement('meta'), { httpEquiv: 'Content-Security-Policy', content: POLICY }));
  head.prepend(Object.assign(document.createElement('meta'), { httpEquiv: 'Content-Type', content: 'text/html; charset=utf-8' }));
  // Chrome names the PDF after the title.
  if (!document.title.trim()) document.title = path.split('/').pop()!.replace(/\.[^.]+$/, '');
  if (markdown) head.append(Object.assign(document.createElement('style'), { textContent: MARKDOWN_STYLE }));
  return '<!doctype html>' + document.documentElement.outerHTML;
}
