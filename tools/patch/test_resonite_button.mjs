// Does the shipped "Export for Resonite" menu actually save a package?
//
//   npx http-server -p 8899 -s .        # serve the patched build
//   node tools/patch/test_resonite_button.mjs
//
// Drives the real UI: opens the menu, clicks each item, catches the download, and hands the
// bytes to verify.mjs. Nothing is stubbed except the font host, whose requests are served
// through Node because this sandbox blocks the browser's egress entirely.
//
// It also covers the case that made this worth testing through the UI rather than through the
// module: exporting while the preview shows a single side. The exporter measures both faces out
// of the live DOM, and a one-sided preview does not render the other, so the handler has to
// switch the view first — and put it back afterwards.
import pkg from '/opt/node22/lib/node_modules/playwright/index.js'; const { chromium } = pkg;
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const VERIFY = new URL('../resonite/verify.mjs', import.meta.url).pathname;
const dir = mkdtempSync(path.join(tmpdir(), 'dc-btn-'));

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
p.on('pageerror', e => console.log('  page threw:', String(e).slice(0, 200)));
await p.route('**://raw.githubusercontent.com/**', async (route) => {
  try {
    const r = await fetch(route.request().url());
    if (!r.ok) return route.fulfill({ status: r.status, body: '' });
    route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' },
                    body: Buffer.from(await r.arrayBuffer()) });
  } catch { route.fulfill({ status: 599, body: '' }); }
});
await p.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'load', timeout: 90000 });
await p.waitForTimeout(8000);

const hasApi = await p.evaluate(() => typeof window.dropcardResonite?.downloadWithStatus === 'function');
console.log(hasApi ? '✓ the export bundle is present' : '✗ window.dropcardResonite is missing');
let failed = hasApi ? 0 : 1;

for (const [item, sideFirst] of [['Export standard', 'both'], ['Export dispenser', 'both'], ['Export baked', 'Front']]) {
  // start from a single-sided preview for the second run, to prove the handler restores it
  if (sideFirst !== 'both') {
    await p.locator(`button:has-text("${sideFirst}")`).first().click();
    await p.waitForTimeout(700);
  }
  const before = await p.evaluate(() => !!document.getElementById('oshi-back-node'));

  await p.locator('button:has-text("Export for Resonite")').first().click();
  await p.waitForTimeout(400);
  const wait = p.waitForEvent('download', { timeout: 120000 });
  await p.locator(`button:has-text("${item}")`).first().click();

  let file;
  try {
    const dl = await wait;
    file = path.join(dir, dl.suggestedFilename());
    await dl.saveAs(file);
  } catch (e) {
    failed++;
    const toast = await p.locator('.dc-res-toast').innerText().catch(() => '(no status shown)');
    console.log(`✗ ${item}: no download\n    status said: ${toast.replace(/\n/g, ' | ')}`);
    continue;
  }

  const size = (await import('node:fs')).statSync(file).size;
  console.log(`✓ ${item.padEnd(16)} ${path.basename(file)}  ${(size / 1e6).toFixed(2)} MB`);
  try {
    const v = execFileSync('node', [VERIFY, file], { encoding: 'utf8' });
    console.log('    ' + v.trim().split('\n').pop());
  } catch (e) { failed++; console.log('    ✗ verify.mjs rejected it:\n' + (e.stdout || e.message)); }

  // the preview must be back where it started
  await p.waitForTimeout(1200);
  const after = await p.evaluate(() => !!document.getElementById('oshi-back-node'));
  if (after !== before) { failed++; console.log(`    ✗ the preview was left showing ${after ? 'both sides' : 'one side'}`); }
  else if (sideFirst !== 'both') console.log('    ✓ single-sided preview restored, and the back was still captured');
}

await b.close();
process.exit(failed ? 1 : 0);
