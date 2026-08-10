// Export a card from the page, then check the bytes the page produced.
//
//   npx http-server -p 8899 -s ../..
//   node browser/e2e.mjs ["Template|Orientation" ...]
//
// The modules are loaded into the tab as real ES modules off the same server, so this exercises
// the code that ships rather than a copy of it. What comes back is a .resonitepackage built
// with no Node in the loop at all; it is written to out/ and handed to verify.mjs, the same
// gate the Node builds go through.
//
// One thing is bridged rather than exercised: font files. This sandbox blocks the browser's
// egress outright — every https request from the page fails with ERR_CONNECTION_RESET, with or
// without the agent proxy, while Node's own fetch works — so requests to the fonts repo are
// served through Node here. Everything downstream of the bytes is the real path; only the
// hop that fetches them is stood in for. A real browser makes that request itself.
import pkg from '/opt/node22/lib/node_modules/playwright/index.js'; const { chromium } = pkg;
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/* --bundle exercises browser/dropcard-resonite.js — the flattened script the app actually
   carries — instead of the module graph. Both are worth running: the modules are what gets
   edited, the bundle is what ships, and only the second can catch a flattening fault. */
const BUNDLED = process.argv.includes('--bundle');
const args = process.argv.slice(2).filter(a => a !== '--bundle');
const TEMPLATES = args.length ? args
  : ['Editorial|Landscape', 'Editorial|Landscape|baked', 'Trading Card|Portrait'];
const FONT_HOST = 'raw.githubusercontent.com';

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
p.on('pageerror', e => console.log('  page threw:', String(e).slice(0, 300)));

let fontHits = 0;
await p.route(`**://${FONT_HOST}/**`, async (route) => {
  fontHits++;
  try {
    const r = await fetch(route.request().url());
    if (!r.ok) return route.fulfill({ status: r.status, body: '' });
    route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' },
                    body: Buffer.from(await r.arrayBuffer()) });
  } catch { route.fulfill({ status: 599, body: '' }); }
});

await p.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'load', timeout: 90000 });
await p.waitForTimeout(9000);
if (BUNDLED) await p.addScriptTag({ path: new URL('./dropcard-resonite.js', import.meta.url).pathname });
console.log(BUNDLED ? 'using the flattened bundle' : 'using the ES modules');

mkdirSync(new URL('../out/', import.meta.url), { recursive: true });
let failed = 0;
for (const spec of TEMPLATES) {
  const [template, orient, mode] = spec.split('|');
  const bake = mode === 'baked';
  await p.locator('button:has-text("Layout")').first().click(); await p.waitForTimeout(600);
  await p.getByText(orient, { exact: true }).first().click(); await p.waitForTimeout(900);
  await p.locator(`button:has-text("${template}")`).first().click(); await p.waitForTimeout(1400);

  const t0 = Date.now(); fontHits = 0;
  const out = await p.evaluate(async ([template, bake, bundled]) => {
    const m = bundled ? window.dropcardResonite : await import('/tools/resonite/browser/export.mjs');
    const steps = [];
    try {
      const { blob, filename, report } = await m.exportResonite({
        fields: { Name: 'Sample', Nickname: 'Sampy' }, template, bake,
        onProgress: (s, d) => steps.push(`${s}: ${d}`) });
      return { ok: true, bytes: [...new Uint8Array(await blob.arrayBuffer())], filename, report, steps };
    } catch (e) { return { ok: false, error: String(e && e.stack || e), steps }; }
  }, [template, bake, BUNDLED]).catch(e => ({ ok: false, error: String(e), steps: [] }));

  if (!out.ok) {
    failed++;
    console.log(`✗ ${template}\n    ${String(out.error).split('\n').slice(0, 5).join('\n    ')}`);
    if (out.steps?.length) console.log(`    got as far as: ${out.steps[out.steps.length - 1]}`);
    continue;
  }

  const path = new URL(`../out/page_${out.filename}`, import.meta.url);
  writeFileSync(path, Buffer.from(out.bytes));
  const r = out.report;
  console.log(`✓ ${template.padEnd(14)} ${(bake ? 'baked' : 'standard').padEnd(9)} ${r.widthMM}×${r.heightMM}mm  fonts=${r.fonts} ` +
              `embedded=${r.embedded} contacts=${r.contacts}  ${(r.bytes / 1e6).toFixed(2)}MB  ` +
              `${fontHits} font request(s)  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const n of r.notes) console.log(`    note: ${n}`);

  try {
    const v = execFileSync('node', [new URL('../verify.mjs', import.meta.url).pathname, path.pathname],
                           { encoding: 'utf8' });
    console.log('    ' + v.trim().split('\n').pop());
  } catch (e) { failed++; console.log('    ✗ verify.mjs rejected it:\n' + (e.stdout || e.message)); }
}
await b.close();
process.exit(failed ? 1 : 0);
