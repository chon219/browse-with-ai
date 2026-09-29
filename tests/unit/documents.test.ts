import { describe, expect, it } from 'vitest';
import { sheetText } from '../../src/sandbox/libraries/sheet';
import { docxText, htmlToMarkdown } from '../../src/sandbox/libraries/docx';
import { pdfText } from '../../src/sandbox/libraries/pdf';
import { documentKind, mediaType } from '../../src/shared/workspace';
import { pdfDocument, wordDocument, workbook } from '../fixtures/documents';

const limits = { pages: 300, chars: 2_000_000 };

describe('document text', () => {
  it('recognises the document types it can read', () => {
    expect(['a.pdf', 'a.docx', 'a.xlsx', 'a.xls', 'a.ods', 'a.xlsm', 'a.zip', 'a.doc'].map(path => documentKind(mediaType(path)))).toEqual(['pdf', 'docx', 'sheet', 'sheet', 'sheet', 'sheet', undefined, undefined]);
  });
  it('reads every sheet of a workbook as CSV', async () => {
    const bytes = workbook({ 报价: [['商品', '价格'], ['A, 大号', 10], [], ['B', 12.5]], Notes: [['备注'], ['含税']] });
    expect(await sheetText(bytes, limits)).toBe('## Sheet: 报价\n商品,价格\n"A, 大号",10\nB,12.5\n\n## Sheet: Notes\n备注\n含税');
  });
  it('reads a Word document as Markdown with its headings and tables', async () => {
    const bytes = await wordDocument('季度报价', '价格含税 & 运费。', [['商品', '价格'], ['A', '10']]);
    expect(await docxText(bytes, limits)).toBe('# 季度报价\n\n价格含税 & 运费。\n\n| 商品 | 价格 |\n| --- | --- |\n| A | 10 |');
  });
  it('converts lists, escapes table cells, and keeps text that looks like markup', () => {
    expect(htmlToMarkdown('<ul><li>one</li><li><p>two</p></li></ul><table><tr><td>a|b</td></tr></table><p>&lt;b&gt; &amp;amp;</p>')).toBe('- one\n- two\n\n| a\\|b |\n| --- |\n\n<b> &amp;');
  });
  it('reads the text of each PDF page, within the page limit', async () => {
    expect(await pdfText(pdfDocument(['Hello page one', 'Second page']), limits)).toBe('--- Page 1 ---\nHello page one\n\n--- Page 2 ---\nSecond page');
    expect(await pdfText(pdfDocument(['One', 'Two', 'Three']), { pages: 2, chars: 1000 })).toBe('--- Page 1 ---\nOne\n\n--- Page 2 ---\nTwo\n\n(Only the first 2 of 3 pages were read.)');
  });
  it('says when text was left out', async () => {
    expect(await sheetText(workbook({ S: [['x'.repeat(50)]] }), { pages: 1, chars: 20 })).toBe('## Sheet: S\nxxxxxxxx\n(Text after 20 characters was left out.)');
  });
});

describe('Word documents from Markdown', () => {
  const png = (width: number, height: number) => { const bytes = new Uint8Array(33); bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); const view = new DataView(bytes.buffer); view.setUint32(16, width); view.setUint32(20, height); return bytes; };
  it('keeps headings, emphasis, lists, tables, quotes, and code, as the reader sees them', async () => {
    const { markdownToDocx } = await import('../../src/sandbox/libraries/word');
    const markdown = '# 季度报告\n\n本季度**销售额**增长 *12%*，详见[官网](https://example.com)。\n\n## 明细\n\n- 华东\n  - 上海\n- 华南\n\n1. 第一步\n2. 第二步\n\n| 地区 | 金额 |\n| --- | ---: |\n| 华东 | 120 |\n| 华南 | 80 |\n\n> 数据截至九月。\n\n```\nsum = 200\n```';
    const bytes = await markdownToDocx(markdown);
    expect([...bytes.subarray(0, 2)]).toEqual([0x50, 0x4b]);
    const back = await docxText(bytes, limits);
    expect(back).toContain('# 季度报告');
    expect(back).toContain('本季度销售额增长 12%，详见官网。');
    expect(back).toContain('## 明细');
    expect(back).toContain('| 地区 | 金额 |\n| --- | --- |\n| 华东 | 120 |\n| 华南 | 80 |');
    for (const line of ['华东', '上海', '华南', '第一步', '第二步', '数据截至九月。', 'sum = 200']) expect(back).toContain(line);
  });
  it('embeds workspace images at page width and keeps the alt text of images it cannot read', async () => {
    const { imageInfo, markdownToDocx } = await import('../../src/sandbox/libraries/word');
    expect(imageInfo(png(1200, 600))).toEqual({ type: 'png', width: 1200, height: 600 });
    expect(imageInfo(new Uint8Array([1, 2, 3]))).toBeUndefined();
    const images = async (path: string) => { if (path === 'charts/a.png') return png(1200, 600); throw new Error('missing'); };
    const bytes = await markdownToDocx('![图表](charts/a.png)\n\n![缺失](missing.png)\n\n![远程](https://example.com/x.png)', { images });
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.values(zip.files).filter(file => !file.dir && file.name.startsWith('word/media/'))).toHaveLength(1);
    const xml = await zip.file('word/document.xml')!.async('string');
    // 600 × 300 pixels, in EMU.
    expect(xml).toContain('cx="5715000" cy="2857500"');
    expect(xml).toContain('[缺失]'); expect(xml).toContain('[远程]');
  });
});
