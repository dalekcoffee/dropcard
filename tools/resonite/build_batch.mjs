// Build every card captured by batch.mjs. Same construction as build_layered.mjs, but
// parameterised per card and sized from the LONG edge so portrait templates don't come
// out oversized.
import { ProtoFlux } from './protoflux.mjs';
import { fetchTTF } from './fetchfont.mjs';
import { Int32 } from 'bson';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const FE = '[FrooxEngine]FrooxEngine.';
const CP = { ObjectRoot:FE+'ObjectRoot', Grabbable:FE+'Grabbable', BoxCollider:FE+'BoxCollider',
  QuadMesh:FE+'QuadMesh', MeshRenderer:FE+'MeshRenderer', Unlit:FE+'UnlitMaterial',
  Hyperlink:FE+'Hyperlink', StaticTexture2D:FE+'StaticTexture2D', TextRenderer:FE+'TextRenderer',
  TextUnlit:FE+'TextUnlitMaterial', StaticFont:FE+'StaticFont',
  ContactLink:FE+'ContactLink', TouchButton:FE+'TouchButton' };
const TV = { [CP.Grabbable]:2, [CP.BoxCollider]:1, [CP.QuadMesh]:1, [CP.TextRenderer]:5 };

const LONG_EDGE = 0.1712;   // the card's long side, whatever its orientation
const CARD_GAP = 0.0001, COLLIDER_T = 0.002;
const Q_PLATE = 3000, Q_GFX = 3050, Q_TEXT = 3100;
const TEXT_Z = 6, GFX_Z = 3, LINK_Z = 4, LINK_DEPTH = 8;
const CONTACT_Z = 5, CONTACT_DEPTH = 8;
const SIZE_GAIN = 10, LH_BASIS = 0.8 / 1.2;
const ALIGN = { left:'Left', center:'Center', right:'Right', justify:'Justify', start:'Left', end:'Right' };
const slug = t => (t.replace(/\s+/g,' ').trim().slice(0,24) || 'Text');

const ttfCache = new Map();   // family|weight -> bytes, shared across cards
async function ttf(family, weight) {
  const k = `${family}|${weight}`;
  if (!ttfCache.has(k)) ttfCache.set(k, Buffer.from((await fetchTTF(family, weight)).bytes));
  return ttfCache.get(k);
}

export async function cardRoot(pf, asset, assets, embeds, prefix, job) {
  const faces = job.faces;
  const PX_W = faces.front.card.w, PX_H = faces.front.card.h;
  const S = LONG_EDGE / Math.max(PX_W, PX_H);
  const CARD_W = PX_W * S, CARD_H = PX_H * S;

  const D = pf.D;

  const wanted = new Map();
  for (const s of Object.keys(faces)) for (const L of faces[s].layers) wanted.set(`${L.family}|${L.weight}`, L);
  const fonts = new Map();
  for (const [k, L] of wanted) {
    const bytes = await ttf(L.family, L.weight);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const a = asset(CP.StaticFont, { URL:`@packdb:///${hash}`, Padding:new Int32(4),
      PixelRange:new Int32(4), GlyphEmSize:new Int32(64), MipMaps:true });
    assets.push(a.entry);
    if (!embeds.some(e => e.hash === hash)) embeds.push({ hash, bytes });
    fonts.set(k, a);
  }
  const textMat = asset(CP.TextUnlit, {
    TintColor:[D(1),D(1),D(1),D(1),'sRGB'], OutlineColor:[D(0),D(0),D(0),D(0),'sRGB'],
    BackgroundColor:[D(0),D(0),D(0),D(0),'sRGB'], AutoBackgroundColor:false,
    GlyphRenderMethod:'MSDF', PixelRange:D(4), FaceDilate:D(0), OutlineThickness:D(0),
    FaceSoftness:D(0), BlendMode:'Alpha', Sidedness:'Double', ZWrite:'Auto', RenderQueue:new Int32(Q_TEXT) });
  assets.push(textMat.entry);

  function texturedQuad(png, { w, h, tint=[1,1,1,1], queue }) {
    const hash = createHash('sha256').update(png).digest('hex');
    const tex = asset(CP.StaticTexture2D, { URL:`@packdb:///${hash}`, Uncompressed:false,
      DirectLoad:false, ForceExactVariant:false, PreferredProfile:'sRGB', MipMapBias:D(0),
      IsNormalMap:false, WrapModeU:'Clamp', WrapModeV:'Clamp', PowerOfTwoAlignThreshold:D(0.05),
      CrunchCompressed:false, MipMaps:true, KeepOriginalMipMaps:false, MipMapFilter:'Box', Readable:false });
    const mat = asset(CP.Unlit, { TintColor:[D(tint[0]),D(tint[1]),D(tint[2]),D(tint[3]),'sRGB'],
      Texture:tex.id, BlendMode:'Alpha', AlphaCutoff:D(0.5), UseVertexColors:false,
      ZWrite: queue===Q_PLATE ? 'On' : 'Auto', RenderQueue:new Int32(queue) });
    assets.push(tex.entry, mat.entry);
    if (!embeds.some(e => e.hash === hash)) embeds.push({ hash, bytes:png });
    const quad = pf.component(CP.QuadMesh, { Rotation:[D(0),D(1),D(0),D(0)], Size:[D(w),D(h)],
      UVOffset:[D(0),D(0)], UVScale:[D(1),D(1)], ScaleUVWithSize:false });
    const rend = pf.component(CP.MeshRenderer, { Mesh:quad.id, Materials:pf.list([mat.id]),
      MaterialPropertyBlocks:[], ShadowCastMode:'On', SortingOrder:new Int32(0) });
    return [quad.comp, rend.comp];
  }

  const textSlot = (L,i) => pf.makeSlot(`${String(i+1).padStart(2,'0')} ${slug(L.text)}`,
    [pf.component(CP.TextRenderer, {
      Text:L.text, ParseRichText:false, NullText:null, Size:D(L.fontPx*SIZE_GAIN),
      HorizontalAlign:ALIGN[L.align] ?? 'Left', VerticalAlign:'Middle', AlignmentMode:'Geometric',
      Color:[D(L.rgba[0]),D(L.rgba[1]),D(L.rgba[2]),D(L.rgba[3]),'sRGB'],
      Materials:pf.list([textMat.id]), LineHeight:D((L.lineHeight/L.fontPx)*LH_BASIS),
      Bounded:true, BoundsSize:[D(L.w),D(L.h)], BoundsAlignment:'MiddleCenter',
      MaskPattern:null, HorizontalAutoSize:false, VerticalAutoSize:false,
      Font:fonts.get(`${L.family}|${L.weight}`).id }).comp],
    [ (L.x+L.w/2)-PX_W/2, -((L.y+L.h/2)-PX_H/2), -TEXT_Z ]);

  const linkSlot = (L,i) => pf.makeSlot(`${String(i+1).padStart(2,'0')} ${L.network}${L.handle?' '+L.handle:''}`,
    [ pf.component(CP.BoxCollider, { Size:[D(L.w),D(L.h),D(LINK_DEPTH)], Type:'Static',
        Mass:D(0.1), CharacterCollider:false, IgnoreRaycasts:false }).comp,
      pf.component(CP.Hyperlink, { URL:`@${L.url}`, OpenOnce:false, Reason:`dropcard link — ${L.network}` }).comp ],
    [ (L.x+L.w/2)-PX_W/2, -((L.y+L.h/2)-PX_H/2), -LINK_Z ]);

  const gfxSlot = side => (g,i) => pf.makeSlot(`${String(i+1).padStart(2,'0')} ${g.name||'graphic'}`,
    texturedQuad(readFileSync(new URL(`./${prefix}-gfx-${side}-${i}.png`, import.meta.url)),
      { w:g.w, h:g.h, tint:[1,1,1,g.alpha ?? 1], queue:Q_GFX }),
    [ (g.x+g.w/2)-PX_W/2, -((g.y+g.h/2)-PX_H/2), -GFX_Z ]);

  // Add-contact lives on the name and the profile picture rather than a separate button:
  // no template needs a reserved spot, and it cannot cover the social chips. Identified by
  // VALUE (the name field's text, the avatar's <img>) so no template markers are required.
  //
  // TouchButton is the slot's ITouchable — two ITouchables cannot share a slot, since
  // RaycastTouchSource resolves a single GetComponentInParentsUntilBlock — but ContactLink
  // does not need to be one: TouchButton dispatches its press to every IButtonPressReceiver
  // on its own slot (TouchButton.cs:186), and ContactLink is one. UserId is left EMPTY here;
  // the instancer bakes it in once it knows who owns the card.
  const contactTargets = (side) => {
    const f = faces[side], out = [];
    const names = [job.fields?.Name, job.fields?.Nickname]
      .filter(Boolean).map(v => v.trim().toLowerCase());
    if (names.length) {
      for (const L of f.layers || []) {
        const t = L.text.trim().toLowerCase();
        if (names.includes(t)) out.push({ ...L, what: 'name' });
      }
    }
    for (const g of f.gfx || []) if (g.isAvatar) out.push({ ...g, what: 'avatar' });
    return out;
  };

  const contactSlot = (t, i) => pf.makeSlot(`${String(i+1).padStart(2,'0')} add contact — ${t.what}`,
    [ pf.component(CP.BoxCollider, { Size:[D(t.w),D(t.h),D(CONTACT_DEPTH)], Type:'Static',
        Mass:D(0.1), CharacterCollider:false, IgnoreRaycasts:false }).comp,
      pf.component(CP.TouchButton, { AcceptPhysicalTouch:true, AcceptRemoteTouch:true,
        AcceptOutOfSightTouch:false }).comp,
      // Normally empty — the instancer bakes it in once it knows the owner. Set
      // DROPCARD_USERID to hardcode one for testing the click end to end.
      pf.component(CP.ContactLink, { UserId: process.env.DROPCARD_USERID || '' }).comp ],
    [ (t.x+t.w/2)-PX_W/2, -((t.y+t.h/2)-PX_H/2), -CONTACT_Z ]);

  function faceSlot(side, z, flip) {
    const f = faces[side]; if (!f) return null;
    const px = (name, kids) => { const r = pf.makeSlot(name, [], [0,0,0], kids);
      r.Scale.Data=[D(S),D(S),D(S)]; r.Rotation.Data=[D(0),D(1),D(0),D(0)]; return r; };
    const kids = [ pf.makeSlot('Background',
      texturedQuad(readFileSync(new URL(`./${prefix}-bg-${side}.png`, import.meta.url)),
        { w:CARD_W, h:CARD_H, queue:Q_PLATE }), [0,0,0]) ];
    if (f.gfx?.length)   kids.push(px('Graphics', f.gfx.map(gfxSlot(side))));
    if (f.layers.length) kids.push(px('Text', f.layers.map(textSlot)));
    if (f.links?.length) kids.push(px('Links', f.links.map(linkSlot)));
    const ct = contactTargets(side);
    if (ct.length) kids.push(px('Add contact', ct.map(contactSlot)));
    const s = pf.makeSlot(side==='front'?'Front':'Back', [], [0,0,z], kids);
    if (flip) s.Rotation.Data=[D(0),D(1),D(0),D(0)];
    return s;
  }

  const root = pf.makeSlot(`dropcard — ${job.template}`, [
    pf.component(CP.ObjectRoot, {}).comp,
    pf.component(CP.Grabbable, { Scalable:true }).comp,
    pf.component(CP.BoxCollider, { Size:[D(CARD_W),D(CARD_H),D(COLLIDER_T)], Type:'Static', Mass:D(0.1) }).comp,
  ], [0,0,0], [faceSlot('front', CARD_GAP/2, false), faceSlot('back', -CARD_GAP/2, true)].filter(Boolean),
     null);

  return { root, CARD_W, CARD_H, S, fonts };
}

export { TV, CP, LONG_EDGE, CARD_GAP, COLLIDER_T };

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
  for (const [prefix, job] of Object.entries(all)) {
    console.log(prefix);
    const { pf, asset, assets, embeds } = newEncoder();
    const c = await cardRoot(pf, asset, assets, embeds, prefix, job);
    c.root.ID = pf.rootId;
    const r = await pf.exportPackage({ name:`dropcard ${job.template} (${job.content})`, root:c.root,
      assets, embeddedAssets:embeds, outPath:`out/dropcard_${prefix}.resonitepackage`, typeVersions:TV });
    console.log(`   ${job.template} ${(c.CARD_W*1000).toFixed(0)}×${(c.CARD_H*1000).toFixed(0)}mm  ` +
                `fonts=${c.fonts.size} embeds=${embeds.length} ${r.ok?'ok':'DANGLING'}`);
  }
}
