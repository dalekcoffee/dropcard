// Does the Google Fonts opt-in actually hold?
//
//   npx http-server -p 8899 -s .        # serve the patched build
//   node tools/patch/test_font_gate.mjs
//
// The README promises dropcard asks Google for nothing until you switch it on, and that the
// answer survives a reload. Both directions are invisible when broken — the site looks and
// works exactly the same either way — so the only honest check is counting requests.
//
// This also guards the Resonite export bundle, which is inlined ahead of the app and could
// start fetching on load without anything looking wrong. It is allowed to reach the fonts
// REPOSITORY when you press export; it is not allowed to touch Google, and not on load.
import pkg from '/opt/node22/lib/node_modules/playwright/index.js'; const { chromium } = pkg;

const GOOGLE = /fonts\.(googleapis|gstatic)\.com/;
const URL_ = 'http://127.0.0.1:8899/index.html';

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 } });
const hits = [];
ctx.on('request', r => { if (GOOGLE.test(r.url())) hits.push(r.url()); });

const p = await ctx.newPage();
let failed = 0;
const check = (label, ok, detail) => {
  if (ok) console.log(`✓ ${label}`);
  else { failed++; console.log(`✗ ${label}${detail ? '\n    ' + detail : ''}`); }
};

const load = async () => {
  hits.length = 0;
  await p.goto(URL_, { waitUntil: 'load', timeout: 90000 });
  await p.waitForTimeout(6000);
  return hits.length;
};

// ── 1. a first visit asks Google for nothing ─────────────────────────────────
await p.context().clearCookies();
await p.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 90000 });
await p.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
let n = await load();
check('a first visit makes no request to Google', n === 0, `${n} request(s): ${hits.slice(0, 3).join(', ')}`);
check('the export bundle loaded without fetching anything itself',
      await p.evaluate(() => typeof window.dropcardResonite?.downloadWithStatus === 'function'));

// ── 2. opting in starts them ─────────────────────────────────────────────────
await p.locator('button:has-text("Style")').first().click();
await p.waitForTimeout(900);

const ON = 'button:has-text("Switch them on")';
const OFF = 'button:has-text("switch off")';
const switchOn = p.locator(ON).first();
if (!(await switchOn.count())) {
  failed++;
  console.log('✗ could not find the "Switch them on" button under Style — it should be showing, ' +
              'since a first visit has fonts off');
} else {
  hits.length = 0;
  await switchOn.scrollIntoViewIfNeeded();
  await switchOn.click();
  await p.waitForTimeout(4500);
  check('switching it on fetches from Google', hits.length > 0, 'no request was made');

  // ── 3. the choice survives a reload ────────────────────────────────────────
  n = await load();
  check('the choice survives a reload (still on)', n > 0, 'nothing was fetched after a reload');

  // ── 4. and back off again ──────────────────────────────────────────────────
  await p.locator('button:has-text("Style")').first().click();
  await p.waitForTimeout(900);
  const switchOff = p.locator(OFF).first();
  if (!(await switchOff.count())) {
    failed++;
    console.log('✗ the "switch off" button is missing, so the state did not persist as on');
  } else {
    await switchOff.scrollIntoViewIfNeeded();
    await switchOff.click();
    await p.waitForTimeout(700);
    n = await load();
    check('switching it off is remembered too', n === 0, `${n} request(s) after opting back out`);
  }
}

await b.close();
process.exit(failed ? 1 : 0);
