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
  if (name.endsWith('-dark') && !name.startsWith('journeys') && !name.startsWith('film-journey')) return;
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
  // The film: one journey step and the outage, settled and paused.
  await page.getByRole('button', { name: 'Play the film of this project' }).click();
  await page.waitForSelector('.film');
  for (const [label, name] of [['What breaks', 'film-outage'], ['Someone clicks', 'film-journey']]) {
    const segs = page.locator('.f-seg');
    const n = await segs.count();
    let target = 0;
    for (let i = 0; i < n; i++) if ((await segs.nth(i).getAttribute('aria-label')).includes(label)) { target = i; if (label === 'What breaks') break; if (i > 0 && (await segs.nth(i - 1).getAttribute('aria-label')).includes(label)) { target = i; } }
    if (name === 'film-journey') {
      const firsts = [];
      for (let i = 0; i < n; i++) if ((await segs.nth(i).getAttribute('aria-label')).includes(label)) firsts.push(i);
      target = firsts[Math.min(3, firsts.length - 1)];
    }
    await segs.nth(target).click();
    await page.waitForTimeout(2300);
    await page.keyboard.press('Space');
    await page.evaluate(() => document.activeElement?.blur());
    await snap(page, `${name}-${scheme}`);
    await page.keyboard.press('Space');
  }
  await page.keyboard.press('Escape');
  await ctx.close();
}

await browser.close();
server.close();
