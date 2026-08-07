// Decode a built .resonitepackage and print every collider in WORLD space, in millimetres.
//
//   node verify_colliders.mjs out/dropcard_info-editorial.resonitepackage
//
// Exists because collider bugs on this card are invisible until someone is holding it in
// VR: the card is under a fifth of a millimetre thick, so a touch collider that is a
// little too deep, or cut to a text element's full-width LAYOUT box rather than the box
// the glyphs occupy, reaches straight through to the other face and answers clicks meant
// for it. Both of those have shipped. Read the numbers instead of the render.
//
// Exits non-zero if any touchable collider straddles the card plane.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const JSZip = require('jszip'), BSON = require('bson'), brotli = require('brotli-wasm');
const { readFileSync } = require('fs');

const path = process.argv[2];
if (!path) { console.error('usage: node verify_colliders.mjs <package>'); process.exit(2); }

const zip = await JSZip.loadAsync(readFileSync(path));
const rec = JSON.parse(await zip.file('R-Main.record').async('string'));
const buf = Buffer.from(await zip.file('Assets/' + rec.assetUri.split('/').pop()).async('arraybuffer'));
const doc = BSON.deserialize(Buffer.from(brotli.decompress(buf.subarray(9))), { promoteValues: true });  // 9 = FrDT header
const T = doc.Types;

const d = f => (f && typeof f === 'object' && 'Data' in f) ? f.Data : f;
// only identity and 180-about-Y occur in these cards, so the composed rotation is one bit
const flipped = r => Math.abs(r[1] - 1) < 1e-6 && Math.abs(r[3]) < 1e-6;
const apply = (f, p) => f ? [-p[0], p[1], -p[2]] : p;
const mm = n => (n * 1000).toFixed(2);

let bad = 0;
function walk(s, R, P, S, depth) {
  const rot = d(s.Rotation) ?? [0, 0, 0, 1], pos = d(s.Position) ?? [0, 0, 0], sc = d(s.Scale) ?? [1, 1, 1];
  const world = apply(R, pos.map((c, i) => c * S[i])).map((c, i) => c + P[i]);
  const netR = flipped(rot) ? !R : R;
  const netS = S.map((c, i) => c * sc[i]);
  const comps = d(s.Components) ?? [];
  const name = d(s.Name) ?? '?';
  for (const c of comps) {
    if (!/BoxCollider/.test(T[c.Type])) continue;
    const sz = d(c.Data.Size).map((v, i) => v * netS[i]);
    const lo = world[2] - sz[2] / 2, hi = world[2] + sz[2] / 2;
    const touch = comps.some(k => /TouchButton|Hyperlink/.test(T[k.Type]));
    let note = touch ? 'touchable' : 'inert';
    if (touch && lo <= 0 && hi >= 0) { note = '*** STRADDLES THE CARD PLANE ***'; bad++; }
    console.log(`${'  '.repeat(depth)}${name.padEnd(38 - depth * 2)} ` +
      `x=[${mm(world[0] - sz[0] / 2)}..${mm(world[0] + sz[0] / 2)}] ` +
      `y=[${mm(world[1] - sz[1] / 2)}..${mm(world[1] + sz[1] / 2)}] ` +
      `z=[${mm(lo)}..${mm(hi)}]  ${note}`);
  }
  for (const c of (Array.isArray(s.Children) ? s.Children : d(s.Children)) ?? [])
    walk(c, netR, world, netS, depth + 1);
}
walk(doc.Object, false, [0, 0, 0], [1, 1, 1], 0);
if (bad) { console.error(`\n${bad} touchable collider(s) reach through to the other face`); process.exit(1); }
