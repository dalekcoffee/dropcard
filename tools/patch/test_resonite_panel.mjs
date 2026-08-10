// Does the Resonite panel actually change what gets exported?
//
//   npx http-server -p 8899 -s .        # serve the patched build
//   node tools/patch/test_resonite_panel.mjs
//
// A settings panel is only worth having if the settings arrive somewhere. This drives the real
// sidebar — opens the Resonite tab, flips "Include the button", picks a corner — and then reads
// the slot tree out of the package the menu produced, which is the only place the answer is.
//
// Three things it will not let through:
//   * the tab missing, or the card back not having moved into it
//   * the button switched off and exported anyway (or on and absent)
//   * a corner chosen and ignored
import pkg from '/opt/node22/lib/node_modules/playwright/index.js'; const { chromium } = pkg;
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(new URL('../resonite/package.json', import.meta.url));
const JSZip = require('jszip'), BSON = require('bson'), brotli = require('brotli-wasm');

const d = f => (f && typeof f === 'object' && 'Data' in f) ? f.Data : f;

/** every slot name in the package, in tree order */
async function slotNames(file) {
  const zip = await JSZip.loadAsync(readFileSync(file));
  const rec = JSON.parse(await zip.file('R-Main.record').async('string'));
  const buf = Buffer.from(await zip.file('Assets/' + rec.assetUri.split('/').pop()).async('arraybuffer'));
  const doc = BSON.deserialize(Buffer.from(brotli.decompress(buf.subarray(9))), { promoteValues: true });
  const out = [];
  (function walk(s, at) {
    const name = d(s.Name);
    out.push({ name, path: `${at}/${name}`, pos: d(s.Position) });
    for (const c of (Array.isArray(s.Children) ? s.Children : d(s.Children)) ?? []) walk(c, `${at}/${name}`);
  })(doc.Object, '');
  return out;
}

const dir = mkdtempSync(path.join(tmpdir(), 'dc-panel-'));
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

let failed = 0;
const check = (ok, msg) => { if (!ok) failed++; console.log(`${ok ? '✓' : '✗'} ${msg}`); };

// ── the panel is there, and holds what it should ─────────────────────────────
const rail = p.locator('nav button:has-text("Resonite")');
check(await rail.count() === 1, 'a Resonite tab in the rail');
await rail.first().click();
await p.waitForTimeout(600);
check(await p.locator('aside h6:has-text("Card back")').count() === 1,
      'the card back moved into it');
check(await p.locator('aside h6:has-text("Add contact button")').count() === 1,
      'the add-contact settings are in it');

await p.locator('nav button:has-text("Layout")').first().click();
await p.waitForTimeout(500);
check(await p.locator('aside h6:has-text("Card back")').count() === 0,
      'and left the Layout tab');

// ── and the settings reach the package ───────────────────────────────────────
async function exportNow(label) {
  await p.locator('button:has-text("Export for Resonite")').first().click();
  await p.waitForTimeout(400);
  const wait = p.waitForEvent('download', { timeout: 180000 });
  await p.locator('button:has-text("Export standard")').first().click();
  const dl = await wait;
  const file = path.join(dir, `${label}-${dl.suggestedFilename()}`);
  await dl.saveAs(file);
  await p.waitForTimeout(800);
  return slotNames(file);
}

const isButton = (s) => /add contact — button$/.test(s.name);

await p.locator('nav button:has-text("Resonite")').first().click();
await p.waitForTimeout(500);

// off
await p.locator('aside label.seg-opt:has-text("Include the button")').first().click();
await p.waitForTimeout(400);
check(await p.locator('aside .field:has(> label:text-is("Where it sits"))').count() === 0,
      'the corner picker hides when the button is off');
let slots = await exportNow('off');
check(!slots.some(isButton), 'switched off, no button in the package');
check(slots.some(s => /add contact — (name|photo)/.test(s.name)),
      '…and the name and photo targets are still there');

// on, in a named corner
await p.locator('aside label.seg-opt:has-text("Include the button")').first().click();
await p.waitForTimeout(400);
await p.locator('aside select, aside sc-raw-select select').first()
  .selectOption('top-left').catch(async () => {
    await p.locator('aside sc-raw-select').first().selectOption('top-left');
  });
await p.waitForTimeout(500);
slots = await exportNow('topleft');
const btn = slots.find(isButton);
check(!!btn, 'switched on, the button is in the package');
if (btn) {
  /* Slot positions under a face are card-centred, in card pixels — the face's own group carries
     the scale to metres. A top-left button is left of centre and above it; y is up in world and
     down on the card, so "above" is a POSITIVE y here. */
  check(btn.pos[0] < 0 && btn.pos[1] > 0,
        `…in the top-left corner (x=${btn.pos[0].toFixed(4)}, y=${btn.pos[1].toFixed(4)})`);
  check(slots.some(s => s.path.endsWith(`${btn.name}/Chip`)), '…and it carries its artwork');
}

await b.close();
process.exit(failed ? 1 : 0);
