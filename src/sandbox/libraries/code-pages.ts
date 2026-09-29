/**
 * SheetJS's code pages (lib-code-pages.js), for older .xls files such as those saved by Chinese
 * editions of Excel. Most of lib-sheet.js's size would be these tables, so sheet.ts loads this
 * bundle only when SheetJS first needs one.
 */
import * as cpexcel from 'xlsx/dist/cpexcel.full.mjs';

Object.assign(globalThis, { bwaiCodePages: cpexcel });
