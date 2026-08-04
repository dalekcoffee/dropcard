// dropcard → .resonitepackage, LAYERED: background plate + one live TextRenderer per run.
// Fonts are the card's OWN Google families, fetched as real TTF and bundled into the
// package, so nothing depends on a Resonite stock font resolving.
import { ProtoFlux } from './protoflux.mjs';
import { fetchTTF } from './fetchfont.mjs';
import { Int32 } from 'bson';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const FE = '[FrooxEngine]FrooxEngine.';
const CP = {
  ObjectRoot:FE+'ObjectRoot', Grabbable:FE+'Grabbable', BoxCollider:FE+'BoxCollider',
  QuadMesh:FE+'QuadMesh', MeshRenderer:FE+'MeshRenderer', Unlit:FE+'UnlitMaterial',
  Hyperlink:FE+'Hyperlink',
  StaticTexture2D:FE+'StaticTexture2D', TextRenderer:FE+'TextRenderer',
  TextUnlit:FE+'TextUnlitMaterial', StaticFont:FE+'StaticFont',
};
const TYPE_VERSIONS = { [CP.Grabbable]:2, [CP.BoxCollider]:1, [CP.QuadMesh]:1, [CP.TextRenderer]:5 };

const CARD_W = 0.1712;
// The two face plates only need enough separation to not z-fight — at 0.8mm you could
// see daylight between them at the card's edge. The grab collider stays thick enough to
// be a comfortable target; it is invisible, so it costs nothing.
const CARD_GAP = 0.0001;    // 0.1mm between the plates
const COLLIDER_T = 0.002;   // 2mm grab volume
const faces = JSON.parse(readFileSync(new URL('./layers.json', import.meta.url),'utf8'));
const PX_W = faces.front.card.w, PX_H = faces.front.card.h;
const S = CARD_W / PX_W;                 // px → metres, applied once on the Text root's scale
const CARD_H = PX_H * S;

// Explicit draw order. RenderQueue >= 0 overrides the blend-mode default absolutely, so
// pinning the plates to the normal transparent queue and pushing text past it removes the
// distance-sort tie that made runs disappear from certain angles. The plates keep
// ZWrite On, so the far face's text still depth-fails against the near plate.
const Q_PLATE = 3000, Q_GFX = 3050, Q_TEXT = 3100;
const TEXT_Z = 6;                       // px in front of the plate (~1mm at card scale)
const LINK_Z = 4, LINK_DEPTH = 8;       // link colliders sit just under the type
const GFX_Z = 3;                        // graphics ride between the plate and the type

const pf = ProtoFlux(); const D = pf.D;
const asset = (cp, f={}) => { const id = pf.nextId();
  const data = { ID:id, persistent:pf.fd(true), UpdateOrder:pf.fi(0), Enabled:pf.fd(true) };
  for (const [k,v] of Object.entries(f)) data[k] = pf.fd(v);
  return { entry:{ Type:pf.typeIndex(cp), Data:data }, id }; };

const assets = [], embeds = [];

// ── fonts: one bundled TTF per family+weight the card actually uses ──────────────
const wanted = new Map();
for (const side of ['front','back']) for (const L of faces[side].layers)
  wanted.set(`${L.family}|${L.weight}`, { family:L.family, weight:L.weight });
const fonts = new Map();
for (const [key, { family, weight }] of wanted) {
  const ttf = await fetchTTF(family, weight);
  const hash = createHash('sha256').update(ttf.bytes).digest('hex');
  const a = asset(CP.StaticFont, { URL:`@packdb:///${hash}`,
    Padding:new Int32(4), PixelRange:new Int32(4), GlyphEmSize:new Int32(64), MipMaps:true });
  assets.push(a.entry); embeds.push({ hash, bytes:Buffer.from(ttf.bytes) });
  fonts.set(key, a);
  console.log(`  bundled ${family} ${weight}  ${(ttf.bytes.length/1024).toFixed(0)}kB`);
}

const textMat = asset(CP.TextUnlit, {
  TintColor:[D(1),D(1),D(1),D(1),'sRGB'], OutlineColor:[D(0),D(0),D(0),D(0),'sRGB'],
  // TextUnlitMaterial.OnAwake sets BackgroundColor = colorX.Black, i.e. OPAQUE black.
  // Leaving it unset paints a black box behind every glyph, so clear its alpha.
  BackgroundColor:[D(0),D(0),D(0),D(0),'sRGB'],
  AutoBackgroundColor:false, GlyphRenderMethod:'MSDF', PixelRange:D(4),
  FaceDilate:D(0), OutlineThickness:D(0), FaceSoftness:D(0),
  BlendMode:'Alpha', Sidedness:'Double', ZWrite:'Auto', RenderQueue:new Int32(Q_TEXT) });
assets.push(textMat.entry);

function texturedQuad(png, { w, h, tint = [1,1,1,1], queue }) {
  const hash = createHash('sha256').update(png).digest('hex');
  const tex = asset(CP.StaticTexture2D, { URL:`@packdb:///${hash}`,
    Uncompressed:false, DirectLoad:false, ForceExactVariant:false, PreferredProfile:'sRGB',
    MipMapBias:D(0), IsNormalMap:false, WrapModeU:'Clamp', WrapModeV:'Clamp',
    PowerOfTwoAlignThreshold:D(0.05), CrunchCompressed:false,
    MipMaps:true, KeepOriginalMipMaps:false, MipMapFilter:'Box', Readable:false });
  const mat = asset(CP.Unlit, { TintColor:[D(tint[0]),D(tint[1]),D(tint[2]),D(tint[3]),'sRGB'], Texture:tex.id,
    BlendMode:'Alpha', AlphaCutoff:D(0.5), UseVertexColors:false,
    ZWrite: queue === Q_PLATE ? 'On' : 'Auto', RenderQueue:new Int32(queue) });
  assets.push(tex.entry, mat.entry); embeds.push({ hash, bytes:png });
  const quad = pf.component(CP.QuadMesh, {
    Rotation:[D(0),D(1),D(0),D(0)],           // face +Z; identity faces away and reads mirrored
    Size:[D(w),D(h)], UVOffset:[D(0),D(0)], UVScale:[D(1),D(1)], ScaleUVWithSize:false });
  const rend = pf.component(CP.MeshRenderer, { Mesh:quad.id, Materials:pf.list([mat.id]),
    MaterialPropertyBlocks:[], ShadowCastMode:'On', SortingOrder:new Int32(0) });
  return [quad.comp, rend.comp];
}

const plate = (side) => pf.makeSlot('Background',
  texturedQuad(readFileSync(new URL(`./bg-${side}.png`, import.meta.url)),
               { w:CARD_W, h:CARD_H, queue:Q_PLATE }), [0,0,0]);

// A graphic the type system can't express (circular <textPath> seals) still gets its own
// slot — an unbaked export bakes nothing into the plate. Its effective opacity rides on the
// material tint, since cloning it out of the card for rastering drops inherited alpha.
function gfxSlot(side) {
  return (g, i) => pf.makeSlot(`${String(i+1).padStart(2,'0')} ${g.name || 'graphic'}`,
    texturedQuad(readFileSync(new URL(`./gfx-${side}-${i}.png`, import.meta.url)),
                 { w:g.w, h:g.h, tint:[1,1,1,g.alpha ?? 1], queue:Q_GFX }),
    [ (g.x + g.w/2) - PX_W/2, -((g.y + g.h/2) - PX_H/2), -GFX_Z ]);
}

const ALIGN = { left:'Left', center:'Center', right:'Right', justify:'Justify', start:'Left', end:'Right' };
const slug = (t) => (t.replace(/\s+/g,' ').trim().slice(0,24) || 'Text');

// Text lives in px space under a single scaled parent, so the numbers stay readable.
// TextRenderer multiplies Size by 0.1 internally (TextRenderer.cs:405,
// `_renderManager.Size = Size * 0.1f`), so em-height of N px means Size = N * 10.
const SIZE_GAIN = 10;
// LineHeight passes through raw, but the engine's "normal" is 0.8 where CSS normal
// is ~1.2 — map the CSS ratio onto that basis. Only affects multi-line runs.
const LH_BASIS = 0.8 / 1.2;
function textSlot(L, i) {
  const tr = pf.component(CP.TextRenderer, {
    Text:L.text, ParseRichText:false, NullText:null,
    Size:D(L.fontPx * SIZE_GAIN),
    HorizontalAlign:ALIGN[L.align] ?? 'Left', VerticalAlign:'Middle', AlignmentMode:'Geometric',
    Color:[D(L.rgba[0]),D(L.rgba[1]),D(L.rgba[2]),D(L.rgba[3]),'sRGB'],
    Materials:pf.list([textMat.id]),
    LineHeight:D((L.lineHeight / L.fontPx) * LH_BASIS),
    Bounded:true, BoundsSize:[D(L.w),D(L.h)], BoundsAlignment:'MiddleCenter',
    MaskPattern:null, HorizontalAutoSize:false, VerticalAutoSize:false,
    Font:fonts.get(`${L.family}|${L.weight}`).id });
  return pf.makeSlot(`${String(i+1).padStart(2,'0')} ${slug(L.text)}`, [tr.comp],
    [ (L.x + L.w/2) - PX_W/2, -((L.y + L.h/2) - PX_H/2), -TEXT_Z ]);
}

// Hyperlink is ITouchable, so a plain collider on the chip makes it clickable in-world.
// URL serialises as a plain string with an '@' prefix — verified against a real decoded
// save (StreamRedeems), not inferred.
function linkSlot(L, i) {
  const col = pf.component(CP.BoxCollider, {
    Size:[D(L.w), D(L.h), D(LINK_DEPTH)], Type:'Static', Mass:D(0.1), CharacterCollider:false, IgnoreRaycasts:false });
  const link = pf.component(CP.Hyperlink, {
    URL:`@${L.url}`, OpenOnce:false, Reason:`dropcard link — ${L.network}` });
  return pf.makeSlot(`${String(i+1).padStart(2,'0')} ${L.network}${L.handle?' '+L.handle:''}`,
    [col.comp, link.comp], [ (L.x + L.w/2) - PX_W/2, -((L.y + L.h/2) - PX_H/2), -LINK_Z ]);
}

function faceSlot(side, z, flip) {
  const px = (name, children) => { const r = pf.makeSlot(name, [], [0,0,0], children);
    r.Scale.Data = [D(S), D(S), D(S)];       // the single px→metre conversion
    r.Rotation.Data = [D(0),D(1),D(0),D(0)]; // match the plate's +Z facing
    return r; };
  const kids = [plate(side)];
  const gfx = faces[side].gfx || [];
  if (gfx.length) kids.push(px('Graphics', gfx.map(gfxSlot(side))));
  kids.push(px('Text', faces[side].layers.map(textSlot)));
  const links = faces[side].links || [];
  if (links.length) kids.push(px('Links', links.map(linkSlot)));
  const slot = pf.makeSlot(side==='front'?'Front':'Back', [], [0,0,z], kids);
  if (flip) slot.Rotation.Data = [D(0),D(1),D(0),D(0)];
  return slot;
}

const root = pf.makeSlot('dropcard', [
  pf.component(CP.ObjectRoot, {}).comp,
  pf.component(CP.Grabbable, { Scalable:true }).comp,
  pf.component(CP.BoxCollider, { Size:[D(CARD_W),D(CARD_H),D(COLLIDER_T)], Type:'Static', Mass:D(0.1) }).comp,
], [0,0,0], [faceSlot('front', CARD_GAP/2, false), faceSlot('back', -CARD_GAP/2, true)], null, pf.rootId);

await pf.exportPackage({ name:'dropcard Sample (layered)', root, assets, embeddedAssets:embeds,
  outPath:'out/dropcard_Sample_layered.resonitepackage', typeVersions:TYPE_VERSIONS });
console.log(`layers: front=${faces.front.layers.length} back=${faces.back.layers.length}  links=${(faces.front.links||[]).length + (faces.back.links||[]).length}  fonts bundled=${fonts.size}`);
console.log(`card: ${(CARD_W*1000).toFixed(1)}mm × ${(CARD_H*1000).toFixed(1)}mm   text scale=${S}`);
