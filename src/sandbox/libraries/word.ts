import * as docx from 'docx';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import type { Nodes, PhrasingContent, RootContent, Table } from 'mdast';

/**
 * Word documents from Markdown, for agent code: `await markdownToDocx(markdown)` returns the bytes of
 * a .docx with headings, paragraphs, lists, tables, quotes, code, links, and emphasis. Images need
 * `{ images: files.readBytes }` to read them from the workspace (PNG, JPEG, GIF, or BMP); others keep their alt text.
 */
export interface MarkdownToDocxOptions { images?: (path: string) => Promise<Uint8Array>; title?: string }

type Inline = docx.ParagraphChild;
interface Marks { bold?: boolean; italics?: boolean; strike?: boolean; code?: boolean }
const MONO = 'Consolas';
/** Page width inside the default margins, in pixels at 96 dpi. */
const CONTENT_WIDTH = 600;
const HEADINGS = [docx.HeadingLevel.HEADING_1, docx.HeadingLevel.HEADING_2, docx.HeadingLevel.HEADING_3, docx.HeadingLevel.HEADING_4, docx.HeadingLevel.HEADING_5, docx.HeadingLevel.HEADING_6];
const ALIGN = { left: docx.AlignmentType.LEFT, center: docx.AlignmentType.CENTER, right: docx.AlignmentType.RIGHT } as const;

/** An image's type and size from its header, or undefined for formats Word documents cannot hold here. */
export function imageInfo(bytes: Uint8Array): { type: 'png' | 'jpg' | 'gif' | 'bmp'; width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length > 24 && view.getUint32(0) === 0x89504e47) return { type: 'png', width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return { type: 'gif', width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (bytes.length > 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) return { type: 'bmp', width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) };
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // Walk the segments to the frame header, which holds the size.
    for (let at = 2; at + 9 < bytes.length;) {
      if (bytes[at] !== 0xff) { at++; continue; }
      const marker = bytes[at + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { type: 'jpg', width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
      at += 2 + view.getUint16(at + 2);
    }
  }
  return undefined;
}

function text(node: Nodes): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  return 'children' in node ? (node.children as Nodes[]).map(text).join('') : '';
}

export async function markdownToDocx(markdown: string, options: MarkdownToDocxOptions = {}): Promise<Uint8Array> {
  const tree = fromMarkdown(String(markdown), { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  let orderedLists = 0;

  async function inline(nodes: PhrasingContent[], marks: Marks = {}): Promise<Inline[]> {
    const runs: Inline[] = [];
    for (const node of nodes) {
      const run = (value: string, extra: Marks = {}) => {
        const style = { ...marks, ...extra };
        return new docx.TextRun({ text: value, bold: style.bold, italics: style.italics, strike: style.strike, ...(style.code ? { font: MONO, shading: { type: docx.ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' } } : {}) });
      };
      switch (node.type) {
        case 'text': runs.push(run(node.value)); break;
        case 'inlineCode': runs.push(run(node.value, { code: true })); break;
        case 'strong': runs.push(...await inline(node.children, { ...marks, bold: true })); break;
        case 'emphasis': runs.push(...await inline(node.children, { ...marks, italics: true })); break;
        case 'delete': runs.push(...await inline(node.children, { ...marks, strike: true })); break;
        case 'break': runs.push(new docx.TextRun({ text: '', break: 1 })); break;
        case 'link': runs.push(new docx.ExternalHyperlink({ link: node.url, children: [new docx.TextRun({ text: text(node) || node.url, style: 'Hyperlink' })] })); break;
        case 'image': {
          const bytes = options.images && !/^[a-z][a-z0-9+.-]*:/i.test(node.url) ? await options.images(decodeURI(node.url)).catch(() => undefined) : undefined;
          const info = bytes && imageInfo(bytes);
          if (bytes && info && info.width > 0 && info.height > 0) {
            const scale = Math.min(1, CONTENT_WIDTH / info.width);
            runs.push(new docx.ImageRun({ type: info.type, data: bytes, transformation: { width: Math.round(info.width * scale), height: Math.round(info.height * scale) }, altText: { name: node.alt ?? '', description: node.alt ?? '', title: node.title ?? node.alt ?? '' } }));
          } else if (node.alt) runs.push(run(`[${node.alt}]`));
          break;
        }
        case 'html': runs.push(run(node.value)); break;
        default: if ('children' in node) runs.push(...await inline(node.children as PhrasingContent[], marks)); else runs.push(run(text(node)));
      }
    }
    return runs;
  }

  async function table(node: Table): Promise<docx.Table> {
    const columns = Math.max(...node.children.map(row => row.children.length));
    const rows = await Promise.all(node.children.map(async (row, index) => new docx.TableRow({
      tableHeader: index === 0,
      children: await Promise.all(Array.from({ length: columns }, async (_, column) => {
        const cell = row.children[column];
        const align = node.align?.[column];
        return new docx.TableCell({
          ...(index === 0 ? { shading: { type: docx.ShadingType.CLEAR, fill: 'F1F3F5', color: 'auto' } } : {}),
          children: [new docx.Paragraph({ ...(align ? { alignment: ALIGN[align] } : {}), children: cell ? await inline(cell.children, index === 0 ? { bold: true } : {}) : [] })],
        });
      })),
    })));
    return new docx.Table({ width: { size: 100, type: docx.WidthType.PERCENTAGE }, rows });
  }

  async function blocks(nodes: RootContent[], context: { level?: number; quote?: boolean } = {}): Promise<(docx.Paragraph | docx.Table)[]> {
    const out: (docx.Paragraph | docx.Table)[] = [];
    const quote = context.quote ? { indent: { left: 720 }, border: { left: { style: docx.BorderStyle.SINGLE, size: 12, color: 'D0D7DE', space: 8 } } } : {};
    for (const node of nodes) {
      switch (node.type) {
        case 'heading': out.push(new docx.Paragraph({ heading: HEADINGS[node.depth - 1], children: await inline(node.children) })); break;
        case 'paragraph': out.push(new docx.Paragraph({ ...quote, children: await inline(node.children) })); break;
        case 'blockquote': out.push(...await blocks(node.children, { ...context, quote: true })); break;
        case 'code': for (const line of node.value.split('\n')) out.push(new docx.Paragraph({ shading: { type: docx.ShadingType.CLEAR, fill: 'F6F8FA', color: 'auto' }, spacing: { before: 0, after: 0 }, children: [new docx.TextRun({ text: line, font: MONO, size: 18 })] })); break;
        case 'thematicBreak': out.push(new docx.Paragraph({ border: { bottom: { style: docx.BorderStyle.SINGLE, size: 6, color: 'D0D7DE', space: 1 } }, children: [] })); break;
        case 'table': out.push(await table(node)); break;
        case 'list': {
          const level = context.level ?? 0; const instance = node.ordered ? ++orderedLists : 0;
          for (const item of node.children) {
            let first = true;
            for (const child of item.children) {
              if (child.type === 'list') { out.push(...await blocks([child], { ...context, level: level + 1 })); continue; }
              if (child.type !== 'paragraph' || !first) { out.push(...await blocks([child], context)); continue; }
              const check = item.checked === true ? '☑ ' : item.checked === false ? '☐ ' : '';
              const children = [...(check ? [new docx.TextRun(check)] : []), ...await inline(child.children)];
              out.push(new docx.Paragraph({ ...quote, children, ...(node.ordered ? { numbering: { reference: 'ordered', level: Math.min(level, 8), instance } } : { bullet: { level: Math.min(level, 8) } }) }));
              first = false;
            }
          }
          break;
        }
        case 'html': out.push(new docx.Paragraph({ children: [new docx.TextRun(node.value)] })); break;
        default: if ('children' in node) out.push(...await blocks(node.children as RootContent[], context));
      }
    }
    return out;
  }

  const firstHeading = tree.children.find(node => node.type === 'heading');
  const document = new docx.Document({
    title: options.title ?? (firstHeading ? text(firstHeading) : undefined),
    // Chinese text falls back to a common Chinese font where the Latin one has no glyphs.
    styles: { default: { document: { run: { font: { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: 'Microsoft YaHei' }, size: 22 } } } },
    numbering: { config: [{ reference: 'ordered', levels: Array.from({ length: 9 }, (_, level) => ({ level, format: docx.LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: docx.AlignmentType.START, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } })) }] },
    sections: [{ children: await blocks(tree.children) }],
  });
  return new Uint8Array(await docx.Packer.toArrayBuffer(document));
}
Object.assign(globalThis, { docx, markdownToDocx });
