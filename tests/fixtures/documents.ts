import * as XLSX from 'xlsx';
import JSZip from 'jszip';

/** Small but real documents for the unit and extension tests. */

/** A workbook with one sheet per entry, each given as rows. */
export function workbook(sheets: Record<string, (string | number)[][]>) {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }));
}

/** A Word document with a heading, a paragraph, and a table (the first row is the header). */
export async function wordDocument(heading: string, paragraph: string, table: string[][]) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const run = (text: string) => `<w:r><w:t xml:space="preserve">${escape(text)}</w:t></w:r>`;
  const row = (cells: string[]) => `<w:tr>${cells.map(cell => `<w:tc><w:p>${run(cell)}</w:p></w:tc>`).join('')}</w:tr>`;
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>`
    + `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${run(heading)}</w:p><w:p>${run(paragraph)}</w:p><w:tbl>${table.map(row).join('')}</w:tbl></w:body></w:document>`);
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
}

/** A PDF with one line of ASCII text on each page, in a standard font. */
export function pdfDocument(lines: string[]) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${lines.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${lines.length} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  lines.forEach((line, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let body = '%PDF-1.4\n'; const offsets: number[] = [];
  objects.forEach((object, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(body);
}
