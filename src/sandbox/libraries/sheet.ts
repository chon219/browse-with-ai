import * as XLSX from 'xlsx';
import type { CP$Module } from 'xlsx/dist/cpexcel.full.mjs';
import { clip, register, type ConvertLimits } from './common';

/** Set by lib-code-pages.js; the sandbox worker sets bwaiLibraryBase to where the library bundles are. */
declare const importScripts: ((...urls: string[]) => void) | undefined;
const scope = globalThis as { bwaiCodePages?: CP$Module; bwaiLibraryBase?: string };

// Code pages for older .xls files, such as those saved by Chinese editions of Excel. SheetJS reads
// them only through the table's utils, and only for such files (not for .xlsx, .ods or CSV), so the
// tables load on that first use; importScripts is synchronous, as SheetJS's reading is.
XLSX.set_cptable({
  get utils() {
    if (!scope.bwaiCodePages) {
      if (typeof importScripts !== 'function' || !scope.bwaiLibraryBase) throw new Error('Code pages for this spreadsheet are not available');
      importScripts(new URL('lib-code-pages.js', scope.bwaiLibraryBase).href);
    }
    return scope.bwaiCodePages!.utils;
  },
});

/** Each sheet as CSV under its name; formulas are shown as their last saved value. */
export async function sheetText(bytes: Uint8Array, limits: ConvertLimits) {
  const workbook = XLSX.read(bytes, { type: 'array', dense: true, cellHTML: false, cellFormula: false });
  const text = workbook.SheetNames.map(name => `## Sheet: ${name}\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name], { blankrows: false }).trimEnd()}`).join('\n\n');
  return clip(text, limits.chars);
}
register('XLSX', XLSX, sheetText);
