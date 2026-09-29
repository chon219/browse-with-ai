import mammoth from 'mammoth';
import { clip, register, type ConvertLimits } from './common';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
// Tags are stripped first and entities decoded once at the end, so text that looks like markup stays text.
const strip = (html: string) => html.replace(/<[^>]+>/g, '');
const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name: string) => ENTITIES[name]).replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(+code));
const cell = (html: string) => strip(html.replace(/<\/p>\s*<p>/g, ' ')).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();

/** Mammoth's HTML as Markdown: headings, lists, and tables are kept; images are left out. */
export function htmlToMarkdown(html: string) {
  return html
    .replace(/<table>([\s\S]*?)<\/table>/g, (_, table: string) => {
      const rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, row]) => [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(([, value]) => cell(value)));
      if (!rows.length) return '';
      const width = Math.max(...rows.map(row => row.length));
      const line = (row: string[]) => `| ${[...row, ...Array(width - row.length).fill('')].join(' | ')} |`;
      return `\n\n${line(rows[0])}\n| ${Array(width).fill('---').join(' | ')} |\n${rows.slice(1).map(line).join('\n')}\n\n`;
    })
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g, (_, level: string, text: string) => `\n\n${'#'.repeat(+level)} ${strip(text).trim()}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/g, (_, text: string) => `\n- ${strip(text.replace(/<\/p>\s*<p>/g, ' ')).trim()}`)
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/(p|ul|ol)>/g, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    .replace(/&[#\w]+;/g, decode);
}
export async function docxText(bytes: Uint8Array, limits: ConvertLimits) {
  // The browser build reads arrayBuffer; buffer lets the unit tests, which get the Node build, read the same bytes.
  const input = { arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, buffer: bytes };
  const { value } = await mammoth.convertToHtml(input as { arrayBuffer: ArrayBuffer }, { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) });
  return clip(htmlToMarkdown(value), limits.chars);
}
register('mammoth', mammoth, docxText);
