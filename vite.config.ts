import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/** The extension pages. scripts/build.mjs builds this first, then the other bundles. */
export default defineConfig({
  // @langchain/core imports the LangSmith SDK for tracing, which the extension never enables.
  resolve: { alias: [{ find: /^langsmith(\/.*)?$/, replacement: resolve('vendor/langsmith-stub.js') }] },
  build: { target: 'es2022', rollupOptions: { input: { task: resolve('task.html'), sidepanel: resolve('sidepanel.html'), settings: resolve('settings.html'), print: resolve('print.html') } } },
});
