// Does the exported text sit where the browser drew it, with room not to wrap?
//
//   npx http-server -p 8899 -s ../..
//   node browser/bounds.mjs ["Template" ...]
//
// A bounded TextRenderer breaks at BoundsSize, and the browser's line box is measured to the
// pixel — the box around "dalekcoffee" is exactly as wide as "dalekcoffee". Resonite's MSDF
// layout rounds advances its own way, so a run that exactly filled its box came back wrapped:
// the Twitch chip on the character-select card read "dalekcoffe" above a lone "e", spilling
// outside the chip's own artwork. scene.mjs now gives every SINGLE-LINE run slack and moves the
// slot by half of it, so the bounds grow away from whichever edge the text is aligned to.
//
// That is two claims, and both are checked here against the decoded package rather than the
// tree the builder blessed:
//
//   * every single-line run has room to spare — bounds wider than the glyphs by a real margin
//   * nothing moved — the aligned edge of each run is where the browser put it, to the pixel
//
// Runs that the browser already wrapped are left alone deliberately: their line breaks are part
// of the layout, and a wider box would re-break them somewhere else. They are reported, not
// padded, so a regression that starts padding them shows up here.
import pkg from '/opt/node22/lib/node_modules/playwright/index.js'; const { chromium } = pkg;
import { createRequire } from 'node:module';

// the builder's own rule, not a copy of it — a second copy would drift and stop testing anything
import { isSingleLine, slackFor } from '../scene.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const JSZip = require('jszip'), BSON = require('bson'), brotli = require('brotli-wasm');

const TEMPLATES = process.argv.slice(2).length ? process.argv.slice(2)
  : ['Classic ID', 'Char. Select', 'Dev Card'];
const EDGE_TOL = 0.51;        // half a card pixel: rounding, not drift
const MIN_SLACK = 2.9;        // scene.mjs gives at least 3

const d = f => (f && typeof f === 'object' && 'Data' in f) ? f.Data : f;

async function textRuns(bytes) {
  const zip = await JSZip.loadAsync(Buffer.from(bytes));
  const rec = JSON.parse(await zip.file('R-Main.record').async('string'));
  const buf = Buffer.from(await zip.file('Assets/' + rec.assetUri.split('/').pop()).async('arraybuffer'));
  const doc = BSON.deserialize(Buffer.from(brotli.decompress(buf.subarray(9))), { promoteValues: true });
  const T = doc.Types, out = [];
  (function walk(s, front) {
    const name = d(s.Name);
    const mine = front || name === 'Front';
    for (const c of d(s.Components) ?? [])
      if (/TextRenderer/.test(T[c.Type]) && mine)
        // "@SampleVT" is stored as "@@SampleVT": a single leading '@' makes the data tree read
        // the field back as a URL, so the encoder doubles it exactly as the engine un-doubles it
        out.push({ text: String(d(c.Data.Text)).replace(/^@@/, '@'),
                   align: d(c.Data.HorizontalAlign),
                   bounds: d(c.Data.BoundsSize), pos: d(s.Position) });
    for (const k of (Array.isArray(s.Children) ? s.Children : d(s.Children)) ?? []) walk(k, mine);
  })(doc.Object, false);
  return out;
}

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
await p.locator('nav button:has-text("Layout")').first().click();
await p.waitForTimeout(600);

let failed = 0;
for (const name of TEMPLATES) {
  const pick = p.locator('aside .field:has(> label:text-is("Template")) button', { hasText: name });
  if (!await pick.count()) {
    // portrait templates are not offered while the card is landscape
    await p.locator('aside label.seg-opt', { hasText: 'Portrait' }).first().click();
    await p.waitForTimeout(800);
  }
  await p.locator('aside .field:has(> label:text-is("Template")) button', { hasText: name })
    .first().click();
  await p.waitForTimeout(900);

  const out = await p.evaluate(async () => {
    const { exportResonite } = await import('/tools/resonite/browser/export.mjs');
    const { measureFace } = await import('/tools/resonite/browser/capture.mjs');
    const { blob } = await exportResonite({ fields: { Name: 'Sample', Nickname: 'Sampy' },
                                            dispenser: false, withOverlay: false });
    // measured AFTER the export, so the page is showing the same typefaces it was built with
    const { data } = measureFace(document.getElementById('oshi-front-node'));
    return { bytes: [...new Uint8Array(await blob.arrayBuffer())], face: data };
  }).catch(e => ({ error: String(e).slice(0, 300) }));

  if (out.error) { failed++; console.log(`✗ ${name}: ${out.error}`); continue; }

  const runs = await textRuns(out.bytes);
  const W = out.face.card.w, H = out.face.card.h;
  /* Paired by position, not by text. A card repeats itself — the Dev Card alone draws a dozen
     runs that are just `"` or `=` — so matching on the string picks the first one every time
     and reports the rest as having moved halfway across the card. */
  const pool = runs.map(r => ({ r, used: false }));
  const claim = (L) => {
    const cx = L.x + L.w / 2 - W / 2, cy = -(L.y + L.h / 2 - H / 2);
    let best = null;
    for (const c of pool) {
      if (c.used || c.r.text !== L.text) continue;
      const dist = Math.hypot(c.r.pos[0] - cx, c.r.pos[1] - cy);
      if (!best || dist < best.dist) best = { c, dist };
    }
    if (!best) return null;
    best.c.used = true;
    return best.c.r;
  };

  let padded = 0, wrapped = 0, bad = [];
  for (const L of out.face.layers) {
    if (L.asGraphic) continue;                       // drawn as a picture, no bounds to check
    const r = claim(L);
    if (!r) { bad.push(`"${L.text.slice(0, 24)}" is not in the package`); continue; }
    const slack = r.bounds[0] - L.w;
    const glyphs = (L.tight || { w: L.w }).w;

    if (isSingleLine(L)) {
      padded++;
      if (Math.abs(slack - slackFor(L)) > 0.01)
        bad.push(`"${L.text.slice(0, 24)}" got ${slack.toFixed(2)}px of slack, not ${slackFor(L).toFixed(2)}`);
      if (slack < MIN_SLACK)
        bad.push(`"${L.text.slice(0, 24)}" got ${slack.toFixed(2)}px of slack — it can still wrap`);
      if (r.bounds[0] - glyphs < MIN_SLACK)
        bad.push(`"${L.text.slice(0, 24)}" bounds ${r.bounds[0].toFixed(1)} vs ${glyphs.toFixed(1)}px of glyphs`);
    } else {
      wrapped++;
      if (Math.abs(slack) > 0.01)
        bad.push(`"${L.text.slice(0, 18)}" already wraps and was widened by ${slack.toFixed(2)}px — ` +
                 `its line breaks will move`);
    }

    // whichever edge the text is aligned to has to be exactly where it was measured
    const centre = r.pos[0] + W / 2;
    const got = r.align === 'Right' ? centre + r.bounds[0] / 2
              : r.align === 'Center' ? centre
              : centre - r.bounds[0] / 2;
    const want = r.align === 'Right' ? L.x + L.w : r.align === 'Center' ? L.x + L.w / 2 : L.x;
    if (Math.abs(got - want) > EDGE_TOL)
      bad.push(`"${L.text.slice(0, 24)}" moved ${(got - want).toFixed(2)}px (${r.align} edge)`);
  }

  if (bad.length) failed++;
  console.log(`${bad.length ? '✗' : '✓'} ${name.padEnd(14)} ${padded} single-line run(s) given slack, ` +
              `${wrapped} left as the browser wrapped them`);
  for (const m of bad.slice(0, 8)) console.log(`    ${m}`);
}

await b.close();
process.exit(failed ? 1 : 0);
