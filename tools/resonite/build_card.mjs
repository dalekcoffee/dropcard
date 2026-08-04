// Prototype: dropcard → .resonitepackage (baked variant).
// Proves the pipeline end-to-end before the browser port and the 42-template decomposition.
import { ProtoFlux } from './protoflux.mjs';
import { Int32 } from 'bson';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const FE = '[FrooxEngine]FrooxEngine.';
const CP = {
  ObjectRoot: FE + 'ObjectRoot',
  Grabbable:  FE + 'Grabbable',
  BoxCollider: FE + 'BoxCollider',
  QuadMesh:   FE + 'QuadMesh',
  MeshRenderer: FE + 'MeshRenderer',
  Unlit:      FE + 'UnlitMaterial',
  StaticTexture2D: FE + 'StaticTexture2D',
};
const TYPE_VERSIONS = { [CP.Grabbable]: 2, [CP.BoxCollider]: 1, [CP.QuadMesh]: 1 };

// True business-card width read too small in VR (owner scaled the prototype to 2,2,2),
// so ship at 2x. The app renders 1.6:1, so height follows from the width.
const CARD_W = 0.1712, ASPECT = 1.6, CARD_H = CARD_W / ASPECT, CARD_T = 0.0008;

const pf = ProtoFlux();
const D = pf.D;

function asset(classpath, fields = {}) {
  const id = pf.nextId();
  const data = { ID: id, persistent: pf.fd(true), UpdateOrder: pf.fi(0), Enabled: pf.fd(true) };
  for (const [k, v] of Object.entries(fields)) data[k] = pf.fd(v);
  return { entry: { Type: pf.typeIndex(classpath), Data: data }, id };
}

function face(name, pngPath) {
  const png = readFileSync(new URL(pngPath, import.meta.url));
  const hash = createHash('sha256').update(png).digest('hex');
  const tex = asset(CP.StaticTexture2D, {
    URL: `@packdb:///${hash}`,
    Uncompressed: false, DirectLoad: false, ForceExactVariant: false,
    PreferredProfile: 'sRGB', MipMapBias: D(0), IsNormalMap: false,
    WrapModeU: 'Clamp', WrapModeV: 'Clamp',
    PowerOfTwoAlignThreshold: D(0.05), CrunchCompressed: false,
    MipMaps: true, KeepOriginalMipMaps: false, MipMapFilter: 'Box', Readable: false,
  });
  const mat = asset(CP.Unlit, {
    TintColor: [D(1), D(1), D(1), D(1), 'sRGB'],
    Texture: tex.id, BlendMode: 'Alpha', AlphaCutoff: D(0.5),
    UseVertexColors: false, ZWrite: 'On', RenderQueue: new Int32(-1),
  });
  return { name, hash, png, tex, mat };
}

const front = face('Front', './card-front.png');
const back  = face('Back',  './card-back.png');

function faceSlot(f, z, flip) {
  const quad = pf.component(CP.QuadMesh, {
    // QuadMesh.Facing = Rotation * float3.Backward, so an identity rotation points the
    // quad at -Z and you read it mirrored from the front. 180 deg about Y is the engine's
    // own v1 convention (floatQ.LookRotation(-forward, up)).
    Rotation: [D(0), D(1), D(0), D(0)], Size: [D(CARD_W), D(CARD_H)],
    UVOffset: [D(0), D(0)], UVScale: [D(1), D(1)], ScaleUVWithSize: false,
  });
  const rend = pf.component(CP.MeshRenderer, {
    Mesh: quad.id, Materials: pf.list([f.mat.id]), MaterialPropertyBlocks: [],
    ShadowCastMode: 'On', SortingOrder: new Int32(0),
  });
  const slot = pf.makeSlot(f.name, [quad.comp, rend.comp], [0, 0, z]);
  if (flip) slot.Rotation.Data = [D(0), D(1), D(0), D(0)]; // 180° about Y so the back faces out
  return slot;
}

const root = pf.makeSlot('dropcard', [
  pf.component(CP.ObjectRoot, {}).comp,
  pf.component(CP.Grabbable, { Scalable: true }).comp,
  pf.component(CP.BoxCollider, { Size: [D(CARD_W), D(CARD_H), D(CARD_T)], Type: 'Static', Mass: D(0.1) }).comp,
], [0, 0, 0], [faceSlot(front, CARD_T / 2, false), faceSlot(back, -CARD_T / 2, true)], null, pf.rootId);

const res = await pf.exportPackage({
  name: 'dropcard Sample',
  root,
  assets: [front.tex.entry, front.mat.entry, back.tex.entry, back.mat.entry],
  embeddedAssets: [
    { hash: front.hash, bytes: front.png },
    { hash: back.hash,  bytes: back.png },
  ],
  outPath: 'out/dropcard_Sample_baked.resonitepackage',
  typeVersions: TYPE_VERSIONS,
});
console.log('card size:', (CARD_W*1000).toFixed(1)+'mm ×', (CARD_H*1000).toFixed(1)+'mm');
