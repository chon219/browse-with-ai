import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const directory = new URL('../public/icons/', import.meta.url);
const svg = await readFile(new URL('bwai.svg', directory), 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>body{margin:0}img{display:block}</style><img width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`);
    await page.locator('img').evaluate(image => image.decode());
    const path = fileURLToPath(new URL(`bwai-${size}.png`, directory));
    await page.screenshot({ path, omitBackground: true });
    console.log(`Generated ${size} × ${size} icon`);
  }
} finally {
  await browser.close();
}
