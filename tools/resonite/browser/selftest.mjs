// Does the dependency-free encoder produce the same package as the Node one?
//
//   node browser/selftest.mjs out/dropcard_info-editorial.resonitepackage
//
// Takes a package the Node builders made, decodes it with the real bson/brotli/jszip, feeds
// the decoded tree straight back through browser/pack.mjs, and decodes THAT with the real
// libraries again. If the two decodes agree, the hand-written BSON writer, the stored-Brotli
// stream and the zip writer are all reading back as the engine's own libraries expect.
//
// Runs in Node because that is where the reference libraries are; pack.mjs itself uses only
// TextEncoder, DataView, CompressionStream and crypto.subtle, all of which Node 22 has for
// the same reason browsers do.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildPackage, I32, I64, F64 } from './pack.mjs';

const require = createRequire(import.meta.url);
const JSZip = require('jszip'), BSON = require('bson'), brotli = require('brotli-wasm');

async function readPackage(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const rec = JSON.parse(await zip.file('R-Main.record').async('string'));
  const mainHash = rec.assetUri.split('/').pop();
  const blob = Buffer.from(await zip.file(`Assets/${mainHash}`).async('arraybuffer'));
  const doc = BSON.deserialize(Buffer.from(brotli.decompress(blob.subarray(9))),
    { promoteValues: false, promoteLongs: false });
  const embedded = [];
  for (const e of rec.assetManifest ?? [])
    embedded.push({ hash: e.hash, bytes: new Uint8Array(await zip.file(`Assets/${e.hash}`).async('arraybuffer')) });
  return { rec, doc, embedded };
}

// BSON wrapper types -> the tagged forms pack.mjs takes, so the same values go back in
const retag = (v) => {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(retag);
  if (typeof v !== 'object') return v;
  if (v._bsontype === 'Int32') return I32(v.value);
  if (v._bsontype === 'Double') return F64(v.value);
  if (v._bsontype === 'Long') return I64(v.toString());
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return new Uint8Array(v);
  const out = {}; for (const [k, x] of Object.entries(v)) out[k] = retag(x); return out;
};

// compare the two decodes, ignoring only the wrapper class identity
const norm = (v) => {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(norm);
  if (typeof v !== 'object') return v;
  if (v._bsontype === 'Int32' || v._bsontype === 'Double') return { t: v._bsontype, v: v.value };
  if (v._bsontype === 'Long') return { t: 'Long', v: v.toString() };
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return { t: 'bin', v: Buffer.from(v).toString('base64') };
  const out = {}; for (const [k, x] of Object.entries(v)) out[k] = norm(x); return out;
};

const src = process.argv[2];
if (!src) { console.error('usage: node browser/selftest.mjs <package>'); process.exit(2); }

const A = await readPackage(readFileSync(src));
const typeVersions = {};
for (const [k, v] of Object.entries(A.doc.TypeVersions ?? {})) typeVersions[k] = v.value ?? v;

const rebuilt = await buildPackage({
  name: A.rec.name, types: A.doc.Types, typeVersions,
  object: retag(A.doc.Object), assets: retag(A.doc.Assets),
  embeddedAssets: A.embedded, version: A.doc.VersionNumber,
});
const outPath = src.replace(/\.resonitepackage$/, '_browser.resonitepackage');
writeFileSync(outPath, rebuilt);

const B = await readPackage(rebuilt);
const a = JSON.stringify(norm(A.doc)), b = JSON.stringify(norm(B.doc));

console.log(`node    ${readFileSync(src).length} bytes   blob ${A.rec.assetManifest.length} embedded assets`);
console.log(`browser ${rebuilt.length} bytes -> ${outPath}`);
if (a !== b) {
  // narrow it down rather than dumping two megabytes of JSON
  for (const k of new Set([...Object.keys(A.doc), ...Object.keys(B.doc)])) {
    const x = JSON.stringify(norm(A.doc[k])), y = JSON.stringify(norm(B.doc[k]));
    if (x !== y) console.error(`  MISMATCH in ${k}: node ${x?.length} chars vs browser ${y?.length}`);
  }
  console.error('\ndecoded trees differ');
  process.exit(1);
}
const sameAssets = A.embedded.length === B.embedded.length &&
  A.embedded.every((e, i) => e.hash === B.embedded[i].hash &&
    Buffer.compare(Buffer.from(e.bytes), Buffer.from(B.embedded[i].bytes)) === 0);
if (!sameAssets) { console.error('embedded assets differ'); process.exit(1); }

console.log(`\nok — decoded trees identical (${a.length} chars), ` +
            `${A.embedded.length} embedded assets byte-identical`);
