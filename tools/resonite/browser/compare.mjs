// Does the in-page rasteriser agree with the Playwright screenshots the Node path uses?
//
//   node browser/compare.mjs            (needs the site served on :8899)
//
// Renders every captured template's front face BOTH ways in the same browser session — once
// through Playwright's element screenshot, once through raster.mjs inside the page — and
// diffs them pixel by pixel. A <foreignObject> clone fails silently rather than loudly: a
// missing font or an unreachable image just renders differently. Counting pixels is the only
// honest check.
//
// Both captures are of the same element in the same state, with nothing hidden. Comparing
// against the stored *-bg-front.png would be wrong: those have the text and graphics layers
// hidden, so a full render differs from them by design.
import pkg from '/opt/node22/lib/node_modules/playwright/index.js'; const { chromium } = pkg;
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

const JOBS = JSON.parse(readFileSync(new URL('../batch-layers.json', import.meta.url), 'utf8'));
const RASTER = readFileSync(new URL('./raster.mjs', import.meta.url), 'utf8');

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'load', timeout: 90000 });
await p.waitForTimeout(9000);
await p.addStyleTag({ content: 'html,body,#dc-root,#oshi-stage{background:transparent !important}' });
await p.addScriptTag({ content: RASTER.replace(/^export /gm, 'window.__dc_')
  .replace('window.__dc_async function rasterise', 'window.__dc_rasterise = async function') + '\n' });

let worst = 0;
for (const [prefix, job] of Object.entries(JOBS)) {
  await p.locator('button:has-text("Layout")').first().click(); await p.waitForTimeout(600);
  await p.getByText(job.orient, { exact: true }).first().click(); await p.waitForTimeout(900);
  await p.locator(`button:has-text("${job.template}")`).first().click(); await p.waitForTimeout(1400);

  // batch.mjs pins the node to 0,0 with transform:none before capturing, because an element
  // screenshot is a crop of the page and the preview shows the card scaled and rotated.
  // Same preparation here, or the reference image is mostly empty viewport.
  await p.evaluate(() => { const el = document.getElementById('oshi-front-node');
    el.dataset._old = el.style.cssText;
    el.style.position = 'fixed'; el.style.left = '0px'; el.style.top = '0px';
    el.style.zIndex = '99999'; el.style.transform = 'none';
    document.querySelectorAll('body *').forEach(e => {
      e.dataset._vis = e.style.visibility || ''; e.style.visibility = 'hidden'; });
    el.style.visibility = 'visible';
    el.querySelectorAll('*').forEach(e => { e.style.visibility = ''; }); });
  await p.waitForTimeout(500);
  const shot = await p.locator('#oshi-front-node').screenshot({ omitBackground: true });
  const png = await p.evaluate(async () => {
    const el = document.getElementById('oshi-front-node');
    return [...await window.__dc_rasterise(el, { scale: 2 })];
  });
  await p.evaluate(() => { const el = document.getElementById('oshi-front-node');
    document.querySelectorAll('body *').forEach(e => {
      if (e.dataset._vis !== undefined) { e.style.visibility = e.dataset._vis; delete e.dataset._vis; } });
    el.style.cssText = el.dataset._old; });
  const mine = PNG.sync.read(Buffer.from(png));
  const theirs = PNG.sync.read(shot);

  if (mine.width !== theirs.width || mine.height !== theirs.height) {
    console.log(`${prefix.padEnd(16)} SIZE MISMATCH ${mine.width}x${mine.height} vs ${theirs.width}x${theirs.height}`);
    worst = 100; continue;
  }
  let diff = 0;
  for (let i = 0; i < mine.data.length; i += 4) {
    const d = Math.abs(mine.data[i] - theirs.data[i]) + Math.abs(mine.data[i+1] - theirs.data[i+1])
            + Math.abs(mine.data[i+2] - theirs.data[i+2]) + Math.abs(mine.data[i+3] - theirs.data[i+3]);
    if (d > 24) diff++;
  }
  const pct = 100 * diff / (mine.width * mine.height);
  worst = Math.max(worst, pct);
  writeFileSync(new URL(`../cmp-${prefix}-browser.png`, import.meta.url), Buffer.from(png));
  writeFileSync(new URL(`../cmp-${prefix}-playwright.png`, import.meta.url), shot);
  console.log(`${prefix.padEnd(16)} ${pct.toFixed(2)}% of pixels differ` + (pct > 2 ? '   <-- look at it' : ''));
}
await b.close();
console.log(`\nworst ${worst.toFixed(2)}%`);
process.exit(worst > 2 ? 1 : 0);
