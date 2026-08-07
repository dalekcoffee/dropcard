// Decode a built .resonitepackage and check the two things that are invisible until
// someone is holding the card in VR.
//
//   node verify.mjs out/dropcard_info-editorial.resonitepackage
//
// COLLIDERS — the card is under a fifth of a millimetre thick, so a touch collider that is
// a little too deep, or cut to a text element's full-width LAYOUT box rather than the box
// the glyphs occupy, reaches through to the other face and answers clicks meant for it.
//
// FACING — an element whose ancestors and own mesh rotation compose to identity faces -Z;
// one that composes to 180-about-Y faces +Z. Facing away from the side of the card it sits
// on is what makes it read mirrored. Three elements have shipped that way.
//
// The builder asserts facing too (build_batch.mjs assertFacing), on the tree it is about to
// write. This one re-checks it from the DECODED BYTES, so a change in the encoder cannot
// quietly produce a package that differs from the tree the builder blessed.
//
// Exits non-zero on either fault.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const JSZip = require('jszip'), BSON = require('bson'), brotli = require('brotli-wasm');
const { readFileSync } = require('fs');

const path = process.argv[2];
if (!path) { console.error('usage: node verify.mjs <package>'); process.exit(2); }

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

let bad = 0, mirrored = 0;
const isY180 = r => Math.abs(r[1] - 1) < 1e-6 && Math.abs(r[3]) < 1e-6;
// mesh id -> its own rotation, so a MeshRenderer can be resolved to the quad it draws
const quadRot = new Map();
(function meshes(s) {
  for (const c of d(s.Components) ?? [])
    if (/QuadMesh/.test(T[c.Type])) quadRot.set(c.Data.ID, d(c.Data.Rotation));
  for (const c of (Array.isArray(s.Children) ? s.Children : d(s.Children)) ?? []) meshes(c);
})(doc.Object);

// The straddle rule is about the CARD: two plates a tenth of a millimetre apart, where a
// collider that crosses the plane answers the far face's clicks. It does not apply to the
// dispenser's button, which is a 12mm slab you are meant to press from either side — so it
// is only enforced inside a face subtree.
function walk(s, R, P, S, depth, onFace = false) {
  const rot = d(s.Rotation) ?? [0, 0, 0, 1], pos = d(s.Position) ?? [0, 0, 0], sc = d(s.Scale) ?? [1, 1, 1];
  const world = apply(R, pos.map((c, i) => c * S[i])).map((c, i) => c + P[i]);
  const netR = flipped(rot) ? !R : R;
  const netS = S.map((c, i) => c * sc[i]);
  const comps = d(s.Components) ?? [];
  const name = d(s.Name) ?? '?';
  onFace = onFace || name === 'Front' || name === 'Back';
  for (const c of comps) {
    if (!/BoxCollider/.test(T[c.Type])) continue;
    const sz = d(c.Data.Size).map((v, i) => v * netS[i]);
    const lo = world[2] - sz[2] / 2, hi = world[2] + sz[2] / 2;
    const touch = comps.some(k => /TouchButton|Hyperlink/.test(T[k.Type]));
    let note = touch ? 'touchable' : 'inert';
    if (touch && onFace && lo <= 0 && hi >= 0) { note = '*** STRADDLES THE CARD PLANE ***'; bad++; }
    console.log(`${'  '.repeat(depth)}${name.padEnd(38 - depth * 2)} ` +
      `x=[${mm(world[0] - sz[0] / 2)}..${mm(world[0] + sz[0] / 2)}] ` +
      `y=[${mm(world[1] - sz[1] / 2)}..${mm(world[1] + sz[1] / 2)}] ` +
      `z=[${mm(lo)}..${mm(hi)}]  ${note}`);
  }
  // facing: netR is already the composed ancestor rotation INCLUDING this slot's own
  const face = (flip, what) => {
    const wantPositiveZ = flip;
    if (Math.abs(world[2]) < 1e-9 || (world[2] > 0) !== wantPositiveZ) {
      console.log(`${'  '.repeat(depth)}${name.padEnd(38 - depth * 2)} ` +
        `faces ${wantPositiveZ ? '+Z' : '-Z'} at z=${mm(world[2])}  *** MIRRORED (${what}) ***`);
      mirrored++;
    }
  };
  for (const c of comps) {
    if (/TextRenderer/.test(T[c.Type])) face(netR, 'TextRenderer');
    if (/MeshRenderer/.test(T[c.Type])) {
      const rot = quadRot.get(d(c.Data.Mesh));
      if (rot) face(isY180(rot) ? !netR : netR, 'quad');
    }
  }
  for (const c of (Array.isArray(s.Children) ? s.Children : d(s.Children)) ?? [])
    walk(c, netR, world, netS, depth + 1, onFace);
}
walk(doc.Object, false, [0, 0, 0], [1, 1, 1], 0);
if (bad || mirrored) {
  if (bad) console.error(`\n${bad} touchable collider(s) reach through to the other face`);
  if (mirrored) console.error(`${mirrored} element(s) face away from their own side and will read mirrored`);
  process.exit(1);
}
console.log(`\nok — ${quadRot.size} quads, no collider reaches the far face, nothing mirrored`);
