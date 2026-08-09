// Build every card captured by batch.mjs.
//
// This is the NODE driver. The construction itself lives in scene.mjs, which knows nothing
// about Node or the DOM — the browser export runs the same code with different plumbing.
// Everything here is the plumbing: files off disk, fonts over the network, Playwright for the
// hover overlays, and the bson/brotli/jszip encoder.
import { ProtoFlux } from './protoflux.mjs';
import { fetchTTF, fetchWOFF2, fetchTTFFromRepo } from './fetchfont.mjs';
import { cardTheme, renderOverlay } from './icon.mjs';
import { cardRoot as buildCard, assertFacing, TV, CP, LONG_EDGE, CARD_GAP, COLLIDER_T } from './scene.mjs';
import { Int32 } from 'bson';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Where font bytes come from. DROPCARD_FONTS picks:
//   cdn   (default) Google's CDN via a spoofed old-Android UA — a per-weight STATIC instance,
//                   which is what the templates' bold headings need. Node only: a page cannot
//                   set a User-Agent, so a browser is always served woff2.
//   repo            the Google Fonts repository — real TrueType, `access-control-allow-origin:
//                   *`, and a .ttf suffix, so it is the only source a BROWSER can use. Most
//                   families are variable-only there, and StaticFont has no variation axis
//                   (nor does anything else in the engine), so every weight of a family would
//                   import at the variable font's default instance.
//   woff2           settled, and the answer is no: Resonite loads the file and draws every
//                   glyph as a NO GLYPH box, because for an extensionless packdb:// URL the
//                   extension is sniffed from content (Font.cs:262) and the sniffer does not
//                   know 'wOF2'. Kept so the finding stays reproducible.
const FONT_SOURCE = process.env.DROPCARD_FONTS || 'cdn';
const FETCH = { cdn: fetchTTF, repo: fetchTTFFromRepo, woff2: fetchWOFF2 }[FONT_SOURCE];
if (!FETCH) throw new Error(`DROPCARD_FONTS must be cdn, repo or woff2 — got "${FONT_SOURCE}"`);
const ttfCache = new Map();   // family|weight -> { bytes, variable }, shared across cards
async function ttf(family, weight) {
  const k = `${family}|${weight}`;
  if (!ttfCache.has(k)) { const f = await FETCH(family, weight);
    ttfCache.set(k, { bytes: Buffer.from(f.bytes), variable: !!f.variable }); }
  return ttfCache.get(k);
}

const sha256 = async (bytes) => createHash('sha256').update(bytes).digest('hex');

/* The scene builder asks for an image more than once — once to hash it, once to reference it —
   and matches them by identity, so the same read has to hand back the same array. */
function fileImages(prefix) {
  const cache = new Map();
  return (kind, side, i) => {
    const name = kind === 'bg' ? `${prefix}-bg-${side}.png` : `${prefix}-gfx-${side}-${i}.png`;
    if (!cache.has(name)) cache.set(name, readFileSync(new URL(`./${name}`, import.meta.url)));
    return cache.get(name);
  };
}

// Same call shape the instancer has always used, so it needs no changes.
export async function cardRoot(pf, asset, assets, embeds, prefix, job, page = null) {
  return buildCard({
    pf, asset, assets, embeds, job,
    imageFor: fileImages(prefix),
    sha256,
    fontFor: ttf,
    theme: page ? cardTheme(job, prefix, import.meta.url) : null,
    overlayFor: page ? (o => renderOverlay(page, o)) : null,
    // Normally empty — the dispenser bakes the owner in once it knows who that is. Set
    // DROPCARD_USERID to hardcode one for testing the click end to end.
    userId: process.env.DROPCARD_USERID || '',
    log: (...a) => console.log(...a),
  });
}

export { TV, CP, LONG_EDGE, CARD_GAP, COLLIDER_T, assertFacing };

export function newEncoder() {
  const pf = ProtoFlux();
  const assets = [], embeds = [];
  const asset = (cp, f={}) => { const id = pf.nextId();
    const data = { ID:id, persistent:pf.fd(true), UpdateOrder:pf.fi(0), Enabled:pf.fd(true) };
    for (const [k,v] of Object.entries(f)) data[k] = pf.fd(v);
    return { entry:{ Type:pf.typeIndex(cp), Data:data }, id }; };
  return { pf, asset, assets, embeds };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = JSON.parse(readFileSync(new URL('./batch-layers.json', import.meta.url),'utf8'));
  const { chromium } = (await import('/opt/node22/lib/node_modules/playwright/index.js')).default;
  const browser = await chromium.launch();          // one session for every overlay raster
  const page = await (await browser.newContext({ viewport:{width:600,height:600} })).newPage();
  for (const [prefix, job] of Object.entries(all)) {
    console.log(prefix);
    const { pf, asset, assets, embeds } = newEncoder();
    const c = await cardRoot(pf, asset, assets, embeds, prefix, job, page);
    c.root.ID = pf.rootId;
    const r = await pf.exportPackage({ name:`dropcard ${job.template} (${job.content})`, root:c.root,
      assets, embeddedAssets:embeds, outPath:`out/dropcard_${prefix}.resonitepackage`, typeVersions:TV });
    console.log(`   ${job.template} ${(c.CARD_W*1000).toFixed(0)}×${(c.CARD_H*1000).toFixed(0)}mm  ` +
                `fonts=${c.fonts.size} embeds=${embeds.length} ${r.ok?'ok':'DANGLING'}` +
                (c.dilations.some(d => d > 0) ? `  synthetic weight: dilate ${c.dilations.join('/')}` : ''));
    for (const t of c.touchReport)
      console.log(`     contact ${t.side.padEnd(5)} ${t.what.padEnd(20)} ` +
                  `${t.w.toFixed(0)}×${t.h.toFixed(0)}px at ${t.x.toFixed(0)},${t.y.toFixed(0)}`);
  }
  await browser.close();
}
