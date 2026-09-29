/**
 * Builds the extension into dist: the extension pages first (that build empties dist), then the
 * service worker, content script, sandbox page and document libraries in parallel. Each of the
 * latter is a single self-contained file that manifest.json, sandbox.html or sandbox.ts loads by name.
 */
import { build } from 'vite';
import { statSync } from 'node:fs';

/** One bundle, as an IIFE (for importScripts and content scripts) unless another format is given. */
const bundle = (entry, fileName, { name = 'BWAISandbox', format = 'iife', resolve } = {}) => ({
  configFile: false, logLevel: 'warn', publicDir: false, resolve,
  build: { target: 'es2022', emptyOutDir: false, lib: { entry, name, formats: [format], fileName: () => fileName } },
});
// The library bundles run in workers: packages with a worker build (such as the Markdown parser's entity decoder) must not get their DOM build.
const inWorker = { resolve: { conditions: ['worker', 'module', 'browser', 'production'] } };

const BUNDLES = [
  bundle('src/background/background.ts', 'background.js', { format: 'es' }),
  bundle('src/content/content.ts', 'content.js', { name: 'BWAIContent' }),
  bundle('src/sandbox/sandbox.ts', 'sandbox.js'),
  bundle('src/sandbox/libraries/pdf.ts', 'lib-pdf.js', inWorker),
  bundle('src/sandbox/libraries/docx.ts', 'lib-docx.js', inWorker),
  bundle('src/sandbox/libraries/sheet.ts', 'lib-sheet.js', inWorker),
  bundle('src/sandbox/libraries/code-pages.ts', 'lib-code-pages.js', inWorker),
  bundle('src/sandbox/libraries/word.ts', 'lib-word.js', inWorker),
];

await build({ configFile: 'vite.config.ts' });
await Promise.all(BUNDLES.map(config => build(config)));
for (const { build: { lib } } of BUNDLES) {
  const file = lib.fileName();
  console.log(`dist/${file.padEnd(20)} ${(statSync(`dist/${file}`).size / 1024).toFixed(1).padStart(8)} kB`);
}
