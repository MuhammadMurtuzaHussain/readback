// Real screenshots of the real UI, on the fictional sample app. Nothing here is mocked.
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = 'dist/site';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  try {
    const file = path.join(root, url === '/' ? 'index.html' : url);
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(4174, r));

const exe = path.join(homedir(), 'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? exe });
await mkdir('public/shots', { recursive: true });

async function session(colorScheme) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, colorScheme });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
  await page.goto('http://localhost:4174/');
  await page.getByRole('button', { name: 'See a sample app' }).click();
  await page.waitForSelector('.story');
  return { ctx, page };
}
const tab = async (page, name) => {
  await page.getByRole('button', { name, exact: false }).first().click();
  await page.waitForTimeout(500);
};
const snap = async (page, name) => {
  if (name.endsWith('-dark') && !name.startsWith('journeys')) return;
  await page.screenshot({ path: `public/shots/${name}.png` });
};

for (const scheme of ['light', 'dark']) {
  const { ctx, page } = await session(scheme);
  await snap(page, `overview-${scheme}`);
  await tab(page, 'Map');
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await snap(page, `map-${scheme}`);
  await page.locator('.node', { hasText: 'Supabase' }).click();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
  await snap(page, `outage-${scheme}`);
  await ctx.setDefaultTimeout(5000);
  await page.setViewportSize({ width: 1040, height: 900 });
  await page.waitForTimeout(500);
  await page.locator('.map').screenshot({ path: `public/shots/hero-${scheme}.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
  await tab(page, 'Journeys');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(500);
  await snap(page, `journeys-${scheme}`);
  await tab(page, 'Parts');
  await snap(page, `parts-${scheme}`);
  await tab(page, 'Stack');
  await snap(page, `stack-${scheme}`);
  await tab(page, 'Risks');
  await snap(page, `risks-${scheme}`);
  await tab(page, 'Read it back');
  await snap(page, `readback-${scheme}`);
  await ctx.close();
}

await browser.close();
server.close();
