import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import { clip, register, type ConvertLimits } from './common';

// PDF.js parses in this worker rather than starting a worker of its own.
Object.assign(globalThis, { pdfjsWorker });

/** The text of each page, marked with its number. Scanned pages have no text layer and come out empty. */
export async function pdfText(bytes: Uint8Array, limits: ConvertLimits) {
  const pdf = await pdfjsLib.getDocument({ data: bytes, useWasm: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: false }).promise;
  try {
    const pages = Math.min(pdf.numPages, limits.pages); let text = '';
    for (let number = 1; number <= pages && text.length < limits.chars; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent(); let pageText = '';
      for (const item of content.items) if ('str' in item) pageText += item.str + (item.hasEOL ? '\n' : '');
      text += `--- Page ${number} ---\n${pageText.trim()}\n\n`;
      page.cleanup();
    }
    if (pdf.numPages > pages) text += `(Only the first ${pages} of ${pdf.numPages} pages were read.)\n`;
    return clip(text.trimEnd(), limits.chars);
  } finally { await pdf.destroy(); }
}
register('pdfjsLib', pdfjsLib, pdfText);
