// Does the browser encoder produce the SAME package as the Node one?
//
//   node browser/parity.mjs
//
// The Node output is the version that has actually been imported into Resonite and checked by
// hand. So rather than inventing a fresh notion of correctness for the browser path, this
// builds the identical scene through both encoders and compares the decoded documents field by
// field. Anything the browser encoder gets wrong — a Double written as an Int32, a dropped
// TypeVersion, a mangled colorX — changes a value here and fails.
//
// Runs in Node because that is where both encoders can be loaded at once; pack.mjs and
// encoder.mjs use nothing a browser lacks, which is what makes that possible.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { ProtoFlux as NodePF } from '../protoflux.mjs';
import { newEncoder as browserEncoder } from './encoder.mjs';
import { cardRoot, TV } from '../scene.mjs';
import { fetchTTFFromRepo } from '../fetchfont.mjs';

const require = createRequire(import.meta.url);
const JSZip = require('jszip'), BSON = require('bson'), brotli = require('brotli-wasm');

const sha256 = async (b) => createHash('sha256').update(b).digest('hex');
const fontCache = new Map();
const fontFor = async (family, weight) => {
  const k = `${family}|${weight}`;
  if (!fontCache.has(k)) { const f = await fetchTTFFromRepo(family, weight);
    fontCache.set(k, { bytes: Buffer.from(f.bytes), variable: !!f.variable }); }
  return fontCache.get(k);
};
const images = (prefix) => { const c = new Map();
  return (kind, side, i) => { const n = kind === 'bg' ? `${prefix}-bg-${side}.png` : `${prefix}-gfx-${side}-${i}.png`;
    if (!c.has(n)) c.set(n, readFileSync(new URL(`../${n}`, import.meta.url)));
    return c.get(n); }; };

function nodeEncoder() {
  const pf = NodePF();
  const assets = [], embeds = [];
  const asset = (cp, f = {}) => { const id = pf.nextId();
    const data = { ID: id, persistent: pf.fd(true), UpdateOrder: pf.fi(0), Enabled: pf.fd(true) };
    for (const [k, v] of Object.entries(f)) data[k] = pf.fd(v);
    return { entry: { Type: pf.typeIndex(cp), Data: data }, id }; };
  return { pf, asset, assets, embeds };
}

async function decodeBytes(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const rec = JSON.parse(await zip.file('R-Main.record').async('string'));
  const mainName = 'Assets/' + rec.assetUri.split('/').pop();
  const blob = Buffer.from(await zip.file(mainName).async('arraybuffer'));
  const bson = Buffer.from(brotli.decompress(blob.subarray(9)));   // 9 = FrDT header
  const doc = BSON.deserialize(bson, { promoteValues: false });
  /* Two differences are expected and carry no meaning.
     The object blob is Brotli, and the two paths compress it differently: Node runs a real
     compressor, the browser emits stored meta-blocks. Same bytes in, different stream out,
     so a different sha256 and a different assetUri — while the DOCUMENT inside is what the
     engine reads, and that is compared below both parsed and raw.
     JSZip also writes an explicit `Assets/` directory entry; a zip does not need one. */
  const sideAssets = Object.keys(zip.files)
    .filter(n => n !== mainName && n !== 'R-Main.record' && !n.endsWith('/')).sort();
  return { rec, doc, bson, sideAssets };
}

// BSON values compare by type AND number: an Int32 4 is not a Double 4 to the engine.
function walk(a, b, path, out) {
  const kind = (v) => v === null ? 'null'
    : (v && v._bsontype) ? v._bsontype
    : Array.isArray(v) ? 'array' : typeof v;
  if (kind(a) !== kind(b)) { out.push(`${path}: type ${kind(a)} vs ${kind(b)}`); return; }
  if (a === null) return;
  if (a && a._bsontype) {
    const [x, y] = [a.valueOf(), b.valueOf()].map(String);
    if (x !== y) out.push(`${path}: ${a._bsontype} ${x} vs ${y}`);
    return;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) { out.push(`${path}: length ${a.length} vs ${b.length}`); return; }
    for (let i = 0; i < a.length && out.length < 25; i++) walk(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.join() !== kb.join()) { out.push(`${path}: keys ${ka.join()} vs ${kb.join()}`); return; }
    for (const k of ka) { if (out.length >= 25) return; walk(a[k], b[k], `${path}.${k}`, out); }
    return;
  }
  if (a !== b) out.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

const all = JSON.parse(readFileSync(new URL('../batch-layers.json', import.meta.url), 'utf8'));
let failed = 0;
for (const [prefix, job] of Object.entries(all)) {
  const common = { job, imageFor: images(prefix), sha256, fontFor, userId: 'U-ParityTest' };

  const N = nodeEncoder();
  const nc = await cardRoot({ ...common, pf: N.pf, asset: N.asset, assets: N.assets, embeds: N.embeds });
  nc.root.ID = N.pf.rootId;
  const nodePkg = await N.pf.exportPackage({ name: `dropcard ${job.template}`, root: nc.root,
    assets: N.assets, embeddedAssets: N.embeds, typeVersions: TV,
    outPath: `/tmp/parity-${prefix}.resonitepackage` });

  const B = browserEncoder();
  const bc = await cardRoot({ ...common, pf: B.pf, asset: B.asset, assets: B.assets, embeds: B.embeds });
  bc.root.ID = B.pf.rootId;
  const browserPkg = await B.pf.exportPackage({ name: `dropcard ${job.template}`, root: bc.root,
    assets: B.assets, embeddedAssets: B.embeds, typeVersions: TV });

  const [a, b] = await Promise.all([
    decodeBytes(readFileSync(nodePkg.path)), decodeBytes(browserPkg.bytes)]);
  const diffs = [];
  walk(a.doc, b.doc, 'doc', diffs);
  // raw as well as parsed: identical parse trees can still come from different BSON, and
  // field order is part of what the engine reads back
  if (!a.bson.equals(b.bson))
    diffs.push(`serialised document differs: ${a.bson.length} vs ${b.bson.length} bytes`);
  if (a.sideAssets.join() !== b.sideAssets.join())
    diffs.push(`embedded assets differ:\n    ${a.sideAssets.join('\n    ')}\n  vs\n    ${b.sideAssets.join('\n    ')}`);
  for (const s of [a, b]) {
    const want = 'Assets/' + s.rec.assetUri.split('/').pop();
    if (s.sideAssets.includes(want)) diffs.push(`${want} listed twice`);
  }

  if (diffs.length) { failed++;
    console.log(`✗ ${prefix}`);
    for (const d of diffs.slice(0, 12)) console.log('    ' + d);
  } else {
    console.log(`✓ ${prefix.padEnd(16)} identical  (${a.doc.Types.length} types, ` +
                `${a.bson.length}b document, ${a.sideAssets.length} embedded assets)`);
  }
}
console.log(failed ? `\n${failed} package(s) differ` : '\nthe browser encoder writes byte-equivalent packages');
process.exit(failed ? 1 : 0);
