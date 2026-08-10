// Where does the "Add contact" button land, on every template?
//
//   npx http-server -p 8899 -s ../..
//   node browser/spots.mjs [--portrait] [--json]
//
// The button is placed rather than declared: badge.mjs searches the face's own measurements for
// a corner nothing is drawn in. That is the right design — no template reserves a spot, and none
// has to be edited when a new one is added — but it means the placement is only as good as the
// search, and there is no way to eyeball forty-odd templates by exporting them one at a time.
//
// So this measures every template in the picker (no rasters, no fonts, no encoding — measureFace
// only, which is a second per template rather than half a minute) and reports:
//
//   * which templates drew their own add-friend button and had it made to work instead
//   * where the button went, and whether it had to shrink or sit over the artwork
//   * anything it overlaps that it should not — the check that actually fails the run
//
// Exits non-zero if any template ends up with no reachable button, or with one over live text.
import pkg from '/opt/node22/lib/node_modules/playwright/index.js'; const { chromium } = pkg;

const JSON_OUT = process.argv.includes('--json');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
p.on('pageerror', e => console.log('  page threw:', String(e).slice(0, 200)));
await p.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'load', timeout: 90000 });
await p.waitForTimeout(8000);

/* Driven through the picker rather than by setting state, because the app exposes no handle —
   and because what the picker OFFERS is the real list: it is filtered by orientation, and the
   oshi.social templates stay hidden until an import unlocks them. Anything it will not show
   cannot be exported either. */
const TEMPLATES = p.locator('aside .field:has(> label:text-is("Template")) button');

await p.locator('nav button:has-text("Layout")').first().click();
await p.waitForTimeout(600);

const rows = [];
let failed = 0;
for (const orientation of (process.argv.includes('--portrait') ? ['Portrait']
                          : process.argv.includes('--landscape') ? ['Landscape']
                          : ['Landscape', 'Portrait'])) {
  await p.locator('aside label.seg-opt', { hasText: orientation }).first().click();
  await p.waitForTimeout(800);
  const names = await TEMPLATES.allInnerTexts();

for (let i = 0; i < names.length; i++) {
  const t = { name: names[i].trim().replace(/\s+/g, ' '), orientation };
  await TEMPLATES.nth(i).click();
  await p.waitForTimeout(700);
  const r = await p.evaluate(async () => {
    const { measureFace } = await import('/tools/resonite/browser/capture.mjs');
    const { badgeBox } = await import('/tools/resonite/badge.mjs');
    const el = document.getElementById('oshi-front-node');
    if (!el) return { error: 'no front node' };
    const { data } = measureFace(el);
    const drawn = (data.layers || []).filter(L => /^add\s*(friend|contact)$/i.test((L.text || '').trim()))
      .map(L => ({ x: L.x, y: L.y, w: L.w, h: L.h }));
    if (drawn.length) return { drawn, card: data.card };
    const box = badgeBox(data, { spot: 'auto' });
    // what it sits on: text is a failure, decoration is only worth reporting
    const hit = (a, o) => a.x < o.x + o.w && o.x < a.x + a.w && a.y < o.y + o.h && o.y < a.y + a.h;
    const onText = (data.layers || [])
      .map(L => ({ t: L.text, ...(L.tight || { x: L.x, y: L.y, w: L.w, h: L.h }) }))
      .filter(o => hit(box, o)).map(o => o.t.slice(0, 20));
    const onLink = (data.links || []).filter(o => hit(box, o)).map(o => o.network);
    const onArt = (data.gfx || []).filter(o => hit(box, o)).length;
    return { box, card: data.card, onText, onLink, onArt };
  }).catch(e => ({ error: String(e).slice(0, 160) }));

  rows.push({ ...t, ...r });
  const label = `${t.name} · ${orientation.toLowerCase()}`.padEnd(32);
  if (r.error) { failed++; console.log(`✗ ${label} ${r.error}`); continue; }
  if (r.drawn) { console.log(`· ${label} template drew its own — ${r.drawn.length} made live`); continue; }
  const bad = (r.onText || []).length || (r.onLink || []).length;
  if (bad) failed++;
  const flags = [r.box.tight ? 'shrunk' : '', r.box.over ? 'over art' : '',
                 r.onArt ? `on ${r.onArt} graphic${r.onArt === 1 ? '' : 's'}` : '',
                 (r.onText || []).length ? `ON TEXT: ${r.onText.join(', ')}` : '',
                 (r.onLink || []).length ? `ON LINKS: ${r.onLink.join(', ')}` : '']
    .filter(Boolean).join(', ');
  console.log(`${bad ? '✗' : '✓'} ${label} ${r.box.spot.padEnd(13)} ` +
              `${r.box.w}×${r.box.h} at ${r.box.x},${r.box.y}` + (flags ? `  [${flags}]` : ''));
}
}

if (JSON_OUT) console.log(JSON.stringify(rows, null, 1));
console.log(`\n${rows.length} templates, ${rows.filter(r => r.drawn).length} with a button of their own, ` +
            `${failed} problem${failed === 1 ? '' : 's'}`);
await b.close();
process.exit(failed ? 1 : 0);
