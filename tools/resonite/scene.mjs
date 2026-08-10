// The card scene: one .resonitepackage-shaped slot tree, built from a captured face set.
//
// Deliberately free of Node and of the DOM. Everything environment-specific arrives as an
// argument, so the same construction runs in the build script and in the browser tab:
//
//   pf, asset, assets, embeds  the encoder (protoflux.mjs in Node, browser/encoder.mjs in a page)
//   imageFor(kind, side, i)    PNG bytes: kind is 'bg' or 'gfx'. MUST return the same array
//                              each time it is asked for the same thing — see the hash pass.
//   sha256(bytes)              async hex digest
//   fontFor(family, weight)    async -> { bytes, variable }
//   overlayFor({...})          async -> PNG bytes for a hover label, or omit for none
//   contactButton              { spot, render({...}) -> PNG bytes } for the drawn "Add contact"
//                              chip, or null to leave the card with only its implicit targets
//   theme                      { surfaceRGB, accentRGB } for those overlays, or omit
//   userId                     baked into every ContactLink; normally '' and filled by the dispenser
//
// The two drivers are build_batch.mjs (Playwright + files) and browser/export.mjs (in-page).
import { inkFor } from './colour.mjs';
import { badgeBox } from './badge.mjs';

const FE = '[FrooxEngine]FrooxEngine.';
const CP = { ObjectRoot:FE+'ObjectRoot', Grabbable:FE+'Grabbable', BoxCollider:FE+'BoxCollider',
  QuadMesh:FE+'QuadMesh', MeshRenderer:FE+'MeshRenderer', Unlit:FE+'UnlitMaterial',
  Hyperlink:FE+'Hyperlink', StaticTexture2D:FE+'StaticTexture2D', TextRenderer:FE+'TextRenderer',
  TextUnlit:FE+'TextUnlitMaterial', StaticFont:FE+'StaticFont',
  ContactLink:FE+'ContactLink', TouchButton:FE+'TouchButton',
  BoolDriver:FE+'ValueDriver<bool>' };
const TV = { [CP.Grabbable]:2, [CP.BoxCollider]:1, [CP.QuadMesh]:1, [CP.TextRenderer]:5 };

const LONG_EDGE = 0.1712;   // the card's long side, whatever its orientation
const CARD_GAP = 0.0001, COLLIDER_T = 0.002;
const Q_PLATE = 3000, Q_GFX = 3050, Q_TEXT = 3100;
const TEXT_Z = 6, GFX_Z = 3, LINK_Z = 4, LINK_DEPTH = 4;
const CONTACT_Z = 5, CONTACT_DEPTH = 4, OVERLAY_Z = 9, Q_OVERLAY = 3150;
const SHIELD_Z = 1, SHIELD_DEPTH = 1.6, SHIELD_PAD = 2;
const CONTACT_PADS = [8, 4, 0];   // comfort margin, in card px, largest that still fits
// Every touch collider stays on its own face's side of the card — it sits Z px in front of
// its face and is DEPTH px thick, so DEPTH < 2*Z. This keeps the boxes from poking out of
// the far side when you visualise them; it does NOT stop a click reaching through (see the
// shield comment below — nothing does, at this thickness). Shields must also sit NEARER the
// card than the buttons of their own face, or they would shadow them.
for (const [what, z, d] of [['link', LINK_Z, LINK_DEPTH], ['contact', CONTACT_Z, CONTACT_DEPTH],
                            ['shield', SHIELD_Z, SHIELD_DEPTH]])
  if (d >= 2 * z) throw new Error(`${what} collider depth ${d} punches through the card at z=${z}`);
if (SHIELD_Z + SHIELD_DEPTH / 2 >= Math.min(LINK_Z, CONTACT_Z) - Math.max(LINK_DEPTH, CONTACT_DEPTH) / 2)
  throw new Error('shields reach out past this face\'s own buttons and would shadow them');
const SIZE_GAIN = 10, LH_BASIS = 0.8 / 1.2;
const ALIGN = { left:'Left', center:'Center', right:'Right', justify:'Justify', start:'Left', end:'Right' };
const slug = t => (t.replace(/\s+/g,' ').trim().slice(0,24) || 'Text');

/* Did the browser fit this run on one line?
 *
 * The GLYPH height decides it, not the element's. A chip pads its text, so its box can be twice
 * the line height while holding a single line; the box the glyphs occupy cannot. Runs the
 * browser wrapped are left exactly as they are — their line breaks are part of the layout.
 *
 * Exported so browser/bounds.mjs checks the same runs the builder padded, rather than a second
 * copy of this rule that could drift from it.
 */
export const isSingleLine = L =>
  !/[\n\r]/.test(L.text) && Math.min(L.h, L.tight?.h ?? L.h) < L.lineHeight * 1.75;
/* How much room to leave beyond the measured width. Generous on purpose: bounds are not drawn
   and not a collider, so the only thing extra width can do is stop a wrap. */
export const slackFor = L => isSingleLine(L) ? Math.max(6, L.fontPx * 0.9) : 0;

/* Some templates DREW an add-contact button already — "ADD CONTACT" on the VR plate and profile
   backs, "Add contact" on the VR social front. Those are buttons in every sense but the working
   one, so they are found by their label and made real, rather than having a second button drawn
   on top of a card that already looks like it has one. Matched loosely: friend or contact, any
   case, since a card someone made before this shipped still says friend.

   Exported because the preview and the placement sweep have to agree with the builder about
   which templates already have one — three copies of this rule would eventually disagree. */
export const TEMPLATE_BUTTON = /^add\s*(friend|contact)$/i;
/* …or an element the template marked with data-dc-contact, which is the way to give a button a
   label the matcher would not recognise. Captured by capture.mjs as `marks`. */
export const drewOwnButton = (face) =>
  (face.marks || []).length > 0 ||
  (face.layers || []).some(L => TEMPLATE_BUTTON.test((L.text || '').replace(/\s+/g, ' ').trim()));

// ── FACING ──────────────────────────────────────────────────────────────────
// Read this before adding anything visible. Three separate elements have shipped mirrored,
// and every time the cause was the same: a rotation constant copied from a neighbour that
// sat at a DIFFERENT DEPTH in the slot tree. The rule is not local, so it cannot be authored
// by copying — it depends on the product of every ancestor's rotation.
//
// A quad or a TextRenderer whose ancestors and own mesh rotation compose to identity faces
// -Z; one that composes to 180-about-Y faces +Z. Either is fine on its own — what makes it
// read mirrored is facing AWAY from the side of the card it sits on. So the whole rule is:
//
//     net rotation is 180-about-Y  <=>  the element sits at z > 0
//
// which `assertFacing` checks on the finished tree, on every build, for every element. That
// check is the fix; this comment is only here to explain it. Practical consequence: below a
// face slot, exactly ONE 180 must appear between the face and the pixels. `px()` supplies it
// for everything under it, so those quads take NO_ROT; a quad parented straight to the face
// supplies its own with Y180.
const Y180 = D => [D(0), D(1), D(0), D(0)];
const NO_ROT = D => [D(0), D(0), D(0), D(1)];
// how a call site says where it sits, so the reader never has to count 180s
const UNDER_PX = false, ON_THE_FACE = true;
const isY180 = r => r && Math.abs(Number(r[1]) - 1) < 1e-6 && Math.abs(Number(r[3])) < 1e-6;

export function assertFacing(root, pf, label = 'object') {
  const idx = cp => pf.typeIndex(cp).value;                 // typeIndex is idempotent
  const T = { quad: idx(CP.QuadMesh), rend: idx(CP.MeshRenderer), text: idx(CP.TextRenderer) };
  const quadRot = new Map();
  (function collect(s) {
    for (const c of s.Components.Data)
      if (c.Type.value === T.quad) quadRot.set(c.Data.ID, c.Data.Rotation?.Data);
    for (const c of s.Children) collect(c);
  })(root);

  const bad = [];
  (function walk(s, parity, z, scaleZ, path) {
    // only the ancestors' flip parity decides the SIGN of a local z offset
    const worldZ = z + (parity % 2 ? -1 : 1) * Number(s.Position.Data[2]) * scaleZ;
    const mine = parity + (isY180(s.Rotation.Data) ? 1 : 0);
    const myScale = scaleZ * Number(s.Scale.Data[2]);
    const here = `${path}/${s.Name.Data}`;
    const check = (p, what) => {
      const wantPositiveZ = p % 2 === 1;
      if (Math.abs(worldZ) < 1e-9 || (worldZ > 0) !== wantPositiveZ)
        bad.push(`${here} (${what}) faces ${wantPositiveZ ? '+Z' : '-Z'} but sits at ` +
                 `z=${(worldZ * 1000).toFixed(2)}mm — it will read MIRRORED`);
    };
    for (const c of s.Components.Data) {
      if (c.Type.value === T.text) check(mine, 'TextRenderer');
      if (c.Type.value === T.rend) {
        const rot = quadRot.get(c.Data.Mesh?.Data);
        if (rot !== undefined) check(mine + (isY180(rot) ? 1 : 0), 'quad');
      }
    }
    for (const c of s.Children) walk(c, mine, worldZ, myScale, here);
  })(root, 0, 0, 1, '');

  if (bad.length) throw new Error(`facing check failed on ${label}:\n  ` + bad.join('\n  '));
  return true;
}

// A variable font imports at its default instance, so Cormorant Garamond 400 and 700 are the
// same file and the engine draws them identically — confirmed in-world, headings came out the
// same weight as body copy. FaceDilate thickens MSDF glyphs at the material level and the
// engine uses it for its own UI text (0.2-0.4), so it can stand in for the missing cut.
// Only ever applied when the file cannot supply the weight itself; with a per-weight static
// from the CDN this is zero and the real cut does the work.
const DILATE_PER_100 = 0.05;
const dilateFor = (weight, variable) =>
  variable ? Math.max(0, (weight - 400)) / 100 * DILATE_PER_100 : 0;

/* bake: merge the card's own artwork into the plate instead of rebuilding it.
 *
 * Standard keeps every element separate — each text run is a live TextRenderer and each graphic
 * its own quad — so the card can be edited in world. Baked hands over the face as it was drawn:
 * one texture per side, nothing to take apart. imageFor must supply a plate rendered with the
 * text and graphics VISIBLE for that to be true, which is the browser capture's 'baked' mode.
 *
 * What is not visual stays either way: the links, the add-contact targets and the shields are
 * colliders, and baking artwork is no reason to stop the card working. It also means a baked
 * export needs no typefaces at all — nothing draws glyphs — so it makes no network requests. */
export async function cardRoot({ pf, asset, assets, embeds, job, imageFor, sha256, fontFor,
                                overlayFor = null, contactButton = null, theme = null,
                                userId = '', bake = false, log = () => {} }) {
  const faces = job.faces;
  const PX_W = faces.front.card.w, PX_H = faces.front.card.h;
  const S = LONG_EDGE / Math.max(PX_W, PX_H);
  const CARD_W = PX_W * S, CARD_H = PX_H * S;

  const D = pf.D;

  const wanted = new Map();
  // asGraphic runs are drawn from a raster, so they need no typeface of their own
  const drawnAsText = L => !L.asGraphic;
  if (!bake) for (const s of Object.keys(faces)) for (const L of faces[s].layers.filter(drawnAsText))
    wanted.set(`${L.family}|${L.weight}`, L);
  const fonts = new Map(), isVariable = new Map();
  for (const [k, L] of wanted) {
    const { bytes, variable } = await fontFor(L.family, L.weight);
    isVariable.set(k, variable);
    const hash = await sha256(bytes);
    const a = asset(CP.StaticFont, { URL:`@packdb:///${hash}`, Padding:pf.i32(4),
      PixelRange:pf.i32(4), GlyphEmSize:pf.i32(64), MipMaps:true });
    assets.push(a.entry);
    if (!embeds.some(e => e.hash === hash)) embeds.push({ hash, bytes });
    fonts.set(k, a);
  }
  // one material per distinct dilation, so a card with three weights costs three materials
  const textMats = new Map();
  const textMat = (dilate = 0) => {
    const k = dilate.toFixed(3);
    if (!textMats.has(k)) {
      const m = asset(CP.TextUnlit, {
        TintColor:[D(1),D(1),D(1),D(1),'sRGB'], OutlineColor:[D(0),D(0),D(0),D(0),'sRGB'],
        BackgroundColor:[D(0),D(0),D(0),D(0),'sRGB'], AutoBackgroundColor:false,
        GlyphRenderMethod:'MSDF', PixelRange:D(4), FaceDilate:D(dilate), OutlineThickness:D(0),
        FaceSoftness:D(0), BlendMode:'Alpha', Sidedness:'Double', ZWrite:'Auto',
        RenderQueue:pf.i32(Q_TEXT) });
      assets.push(m.entry); textMats.set(k, m);
    }
    return textMats.get(k);
  };

  // ownFlip: does this quad supply its OWN 180-about-Y? See FACING below — everything under a
  // face must contribute exactly one, and the `px` wrapper already supplies it for its children.
  // Deliberately has no default: a wrong guess here is invisible until someone reads the
  // card in VR, so a new call site must say where it sits.
  function texturedQuad(png, { w, h, tint=[1,1,1,1], queue, ownFlip }) {
    if (ownFlip === undefined) throw new Error('texturedQuad needs an explicit ownFlip');
    const hash = hashOf(png);
    const tex = asset(CP.StaticTexture2D, { URL:`@packdb:///${hash}`, Uncompressed:false,
      DirectLoad:false, ForceExactVariant:false, PreferredProfile:'sRGB', MipMapBias:D(0),
      IsNormalMap:false, WrapModeU:'Clamp', WrapModeV:'Clamp', PowerOfTwoAlignThreshold:D(0.05),
      CrunchCompressed:false, MipMaps:true, KeepOriginalMipMaps:false, MipMapFilter:'Box', Readable:false });
    const mat = asset(CP.Unlit, { TintColor:[D(tint[0]),D(tint[1]),D(tint[2]),D(tint[3]),'sRGB'],
      Texture:tex.id, BlendMode:'Alpha', AlphaCutoff:D(0.5), UseVertexColors:false,
      ZWrite: queue===Q_PLATE ? 'On' : 'Auto', RenderQueue:pf.i32(queue) });
    assets.push(tex.entry, mat.entry);
    if (!embeds.some(e => e.hash === hash)) embeds.push({ hash, bytes:png });
    const quad = pf.component(CP.QuadMesh, { Rotation: ownFlip ? Y180(D) : NO_ROT(D), Size:[D(w),D(h)],
      UVOffset:[D(0),D(0)], UVScale:[D(1),D(1)], ScaleUVWithSize:false });
    const rend = pf.component(CP.MeshRenderer, { Mesh:quad.id, Materials:pf.list([mat.id]),
      MaterialPropertyBlocks:[], ShadowCastMode:'On', SortingOrder:pf.i32(0) });
    return [quad.comp, rend.comp];
  }

  /* Slack, so a line the browser fitted does not wrap in world.
   *
   * A bounded TextRenderer breaks at BoundsSize, and the browser's line box is measured to the
   * pixel — the box around "dalekcoffee" is exactly as wide as "dalekcoffee". The engine's MSDF
   * layout rounds advances its own way, and over a dozen characters the difference is enough to
   * push the last glyph out: the chip came back as "dalekcoffe" above a lone "e", spilling
   * outside the chip's own artwork.
   *
   * Only SINGLE-LINE runs are widened. A run the browser already broke has a wrap pattern that
   * is part of the layout, and giving it a wider box would re-break it somewhere else.
   *
   * The slot then moves by half the slack, so the edge the text is aligned to stays exactly
   * where it was measured — the bounds grow away from the alignment, and nothing on the card
   * shifts. Height grows symmetrically and needs no compensation, since the text is centred in
   * it vertically; it costs nothing and keeps a tall glyph off the boundary. */
  const textSlot = (L,i) => {
    const align = ALIGN[L.align] ?? 'Left';
    const slack = slackFor(L);
    const dx = align === 'Left' || align === 'Justify' ? slack/2 : align === 'Right' ? -slack/2 : 0;
    return pf.makeSlot(`${String(i+1).padStart(2,'0')} ${slug(L.text)}`,
    [pf.component(CP.TextRenderer, {
      Text:L.text, ParseRichText:false, NullText:null, Size:D(L.fontPx*SIZE_GAIN),
      HorizontalAlign:align, VerticalAlign:'Middle', AlignmentMode:'Geometric',
      Color:[D(L.rgba[0]),D(L.rgba[1]),D(L.rgba[2]),D(L.rgba[3]),'sRGB'],
      Materials:pf.list([textMat(dilateFor(L.weight, isVariable.get(`${L.family}|${L.weight}`))).id]),
      LineHeight:D((L.lineHeight/L.fontPx)*LH_BASIS),
      Bounded:true, BoundsSize:[D(L.w+slack),D(L.h+slack/2)], BoundsAlignment:'MiddleCenter',
      MaskPattern:null, HorizontalAutoSize:false, VerticalAutoSize:false,
      Font:fonts.get(`${L.family}|${L.weight}`).id }).comp],
    [ (L.x+L.w/2+dx)-PX_W/2, -((L.y+L.h/2)-PX_H/2), -TEXT_Z ]);
  };

  const linkSlot = (L,i) => pf.makeSlot(`${String(i+1).padStart(2,'0')} ${L.network}${L.handle?' '+L.handle:''}`,
    [ pf.component(CP.BoxCollider, { Size:[D(L.w),D(L.h),D(LINK_DEPTH)], Type:'Static',
        Mass:D(0.1), CharacterCollider:false, IgnoreRaycasts:false }).comp,
      pf.component(CP.Hyperlink, { URL:`@${L.url}`, OpenOnce:false, Reason:`dropcard link — ${L.network}` }).comp ],
    [ (L.x+L.w/2)-PX_W/2, -((L.y+L.h/2)-PX_H/2), -LINK_Z ]);

  const gfxSlot = side => (g,i) => pf.makeSlot(`${String(i+1).padStart(2,'0')} ${g.name||'graphic'}`,
    texturedQuad(imageFor('gfx', side, i),
      { w:g.w, h:g.h, tint:[1,1,1,g.alpha ?? 1], queue:Q_GFX, ownFlip:UNDER_PX }),
    [ (g.x+g.w/2)-PX_W/2, -((g.y+g.h/2)-PX_H/2), -GFX_Z ]);

  // Beyond the button a template drew itself (TEMPLATE_BUTTON, above), add-contact lives on the
  // name and the profile picture as well, identified by VALUE — the name field's text, the
  // avatar's own box — so no template has to carry a marker for it.
  //
  // TouchButton is the slot's ITouchable — two ITouchables cannot share a slot, since
  // RaycastTouchSource resolves a single GetComponentInParentsUntilBlock — but ContactLink
  // does not need to be one: TouchButton dispatches its press to every IButtonPressReceiver
  // on its own slot (TouchButton.cs:186), and ContactLink is one. UserId is left EMPTY here;
  // the instancer bakes it in once it knows who owns the card.
  const contactTargets = (side) => {
    const f = faces[side], out = [];
    // A text run's ELEMENT box is its layout box, routinely the full width of the card or
    // column; sizing a collider to that gives a band across the face that swallows the
    // social chips. `tight` is the box the glyphs actually occupy.
    const glyphBox = L => L.tight || { x:L.x, y:L.y, w:L.w, h:L.h };
    const grow = (b, p) => ({ x:b.x-p, y:b.y-p, w:b.w+2*p, h:b.h+2*p });
    const hit = (a, b) => a.x < b.x+b.w && b.x < a.x+a.w && a.y < b.y+b.h && b.y < a.y+a.h;
    // trim b just far enough on its least-buried side to clear o
    const clip = (b, o) => {
      const cut = [[o.x+o.w-b.x,'L'], [b.x+b.w-o.x,'R'], [o.y+o.h-b.y,'T'], [b.y+b.h-o.y,'B']]
        .sort((p, q) => p[0]-q[0])[0];
      if (cut[0] <= 0) return b;
      if (cut[1]==='L') return { ...b, x:b.x+cut[0], w:b.w-cut[0] };
      if (cut[1]==='R') return { ...b, w:b.w-cut[0] };
      if (cut[1]==='T') return { ...b, y:b.y+cut[0], h:b.h-cut[0] };
      return { ...b, h:b.h-cut[0] };
    };
    // Comfortable but never overlapping: take the largest pad that clears every neighbour,
    // and if even the bare box collides, trim it. Colliders may be bigger than their
    // element; they may not reach into the next one.
    const fit = (base, near) => {
      for (const p of CONTACT_PADS) {
        const b = grow(base, p);
        if (!near.some(o => hit(b, o))) return b;
      }
      let b = { ...base };
      for (const o of near) if (hit(b, o)) b = clip(b, o);
      return (b.w > 8 && b.h > 8) ? b : null;
    };

    /* Match the name loosely, because the two sides are never spelled the same.
       The FIELD still holds what was typed — "Dalek :coffee: :nkocat:" — while the captured RUN
       holds what was drawn, with every custom shortcode already turned into an <img> and gone
       from the text. Comparing them literally meant a name with any server emoji in it never
       matched, so those cards got no add-contact on the name at all: it worked on the photo and
       on the back, and did nothing on the front. Strip shortcodes and emoji from both, then
       compare what is left. */
    const plain = (s) => String(s || '')
      .replace(/:[\w+-]+:/g, ' ')                        // custom emoji, written as shortcodes
      .replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, ' ')   // unicode emoji and joiners
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const names = [job.fields?.Name, job.fields?.Nickname]
      .filter(Boolean).map(plain).filter(Boolean);
    const texts = (f.layers || []).map(glyphBox);

    /* The template's own button, if it drew one. Its ELEMENT box is wanted here rather than
       the glyph box: on these templates that box is the drawn chip — its padding, its border,
       its fill — and a collider cut to the letters alone would leave the button's edges dead
       to the touch. */
    (f.layers || []).forEach((L) => {
      if (!TEMPLATE_BUTTON.test((L.text || '').replace(/\s+/g, ' ').trim())) return;
      out.push({ x: L.x, y: L.y, w: L.w, h: L.h, what: 'button (template)', drawn: true });
    });
    // and anything it marked explicitly, whatever the button happens to say
    (f.marks || []).forEach((m) => {
      if (out.some(o => hit(o, m))) return;          // already found by its label
      out.push({ x: m.x, y: m.y, w: m.w, h: m.h, what: 'button (marked)', drawn: true });
    });

    if (names.length) {
      (f.layers || []).forEach((L, i) => {
        if (!names.includes(plain(L.text))) return;
        const near = [...texts.filter((_, j) => j !== i), ...(f.links || []), ...out];
        const b = fit(glyphBox(L), near);
        if (b) out.push({ ...b, what:'name' });
      });
    }
    // The avatar region is a contact target whether or not a picture was set — with none,
    // templates still draw a placeholder inside the frame, so there is something to aim at.
    if (f.avatar) {
      const a = f.avatar;
      // a placeholder glyph is small; grow it into a comfortable target, but only as far as
      // the nearest other clickable/drawn item allows, so it can never cover one
      let box = { ...a };
      if (a.isGlyph) {
        const GROW = 1.9, CAP = 260;
        const w = Math.min(a.w * GROW, CAP), h = Math.min(a.h * GROW, CAP);
        const wide = { x: a.x + a.w/2 - w/2, y: a.y + a.h/2 - h/2, w, h };
        const clash = [...texts, ...(f.gfx||[]), ...(f.links||[]), ...out].some(r => hit(wide, r));
        if (!clash) box = wide;             // otherwise stay on the glyph rather than overlap
      }
      if (!out.some(o => hit(box, o)))
        out.push({ ...box, what: a.hasImage ? 'photo' : 'photo (placeholder)' });
    }
    // and never off the edge of the card, where a click would land on nothing
    const W = f.card.w, H = f.card.h;
    return out.map(t => { const x = Math.max(0, t.x), y = Math.max(0, t.y);
      return { ...t, x, y, w: Math.min(t.w + t.x - x, W - x), h: Math.min(t.h + t.y - y, H - y) };
    }).filter(t => t.w > 8 && t.h > 8);
  };

  // Field IDs of every ContactLink.UserId, so the instancer can bake the owner into them.
  // A component ID is not enough: writing a field needs the FIELD's id.
  const userIdFields = [];
  const contactSlot = (t, i) => {
    // Normally empty — the instancer bakes it in once it knows the owner. Set
    // DROPCARD_USERID to hardcode one for testing the click end to end.
    const link = pf.component(CP.ContactLink, { UserId: userId });
    userIdFields.push(link.comp.Data.UserId.ID);
    // IsHovering has to be written out explicitly: this encoder serialises only the fields it
    // is given, and an unserialised sync member has no ID for the driver to point at.
    const touch = pf.component(CP.TouchButton, { AcceptPhysicalTouch:true, AcceptRemoteTouch:true,
      AcceptOutOfSightTouch:false, IsHovering:false, IsPressed:false });
    const comps = [
      pf.component(CP.BoxCollider, { Size:[D(t.w),D(t.h),D(CONTACT_DEPTH)], Type:'Static',
        Mass:D(0.1), CharacterCollider:false, IgnoreRaycasts:false }).comp,
      touch.comp, link.comp ];
    const kids = [];
    /* The chip's artwork, when this target is one we drew. It sits at the depth the card's own
       graphics use rather than the overlay's, so it reads as printed on the card instead of
       floating a millimetre off it — with its collider still in front, where a finger meets it
       first. Always on, so it is a button you can see. */
    if (t.art)
      kids.push(pf.makeSlot('Chip',
        texturedQuad(t.art, { w:t.w, h:t.h, queue:Q_OVERLAY, ownFlip:UNDER_PX }),
        [0, 0, -(GFX_Z-CONTACT_Z)]));
    // The overlay is a plain textured quad — no UIX on the card. It sits in front of the
    // card's own text, starts inactive, and a ValueDriver turns it on straight from
    // TouchButton.IsHovering: no ProtoFlux, so a card works on its own away from a dispenser.
    if (t.overlay) {
      const lb = t.label || { w:t.w, h:t.h };
      const ov = pf.makeSlot('Add contact (on hover)',
        texturedQuad(t.overlay, { w:lb.w, h:lb.h, queue:Q_OVERLAY, ownFlip:UNDER_PX }),
        [0, 0, -(OVERLAY_Z-CONTACT_Z)]);
      ov.Active.Data = false;
      kids.push(ov);
      comps.push(pf.component(CP.BoolDriver, { ValueSource: touch.comp.Data.IsHovering.ID,
        DriveTarget: ov.Active.ID }).comp);
    }
    return pf.makeSlot(`${String(i+1).padStart(2,'0')} add contact — ${t.what}`, comps,
      [ (t.x+t.w/2)-PX_W/2, -((t.y+t.h/2)-PX_H/2), -CONTACT_Z ], kids);
  };

  const contacts = { front: contactTargets('front'), back: faces.back ? contactTargets('back') : [] };
  /* Only the FRONT decides whether a chip is drawn. The VR profile back carries an "ADD FRIEND"
     that its front does not, and counting that would leave the side you actually hand someone
     with no button on it. Every drawn button on either face is made to work regardless. */
  const drawnByTemplate = contacts.front.some(t => t.drawn);

  // the typeface the card spends the most area in, so anything we draw matches its voice
  const byArea = new Map();
  for (const f of Object.values(faces)) for (const L of f.layers || [])
    byArea.set(`${L.family}|${L.weight}`, (byArea.get(`${L.family}|${L.weight}`) ?? 0) + L.w * L.h);
  const [fam, wgt] = ([...byArea].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Lexend|500').split('|');
  // .bytes, not the record: this used to hand the whole { bytes, variable } across, which
  // stringifies to "[object Object]" inside the data: URL, so the face never loaded and the
  // overlay quietly fell back to a system font.
  // Baked cards embed no typeface, so there are no bytes to hand the label — the renderer
  // falls back to the face the page already has, which is the one the card is drawn in.
  const face = (overlayFor || contactButton) && theme
    ? (bake ? { bytes: null } : await fontFor(fam, +wgt)) : null;
  const ink = theme ? inkFor(theme.accentRGB, theme) : null;

  /* The drawn chip, for the templates that did not draw their own. Front only — one button per
     card is the point, and the front is the side that greets you. Where it goes is worked out
     from the face's own measurements, so no template has to reserve a spot and none has to be
     edited when a new one is added. */
  let badge = null;
  if (contactButton && theme && !drawnByTemplate) {
    const b = badgeBox(faces.front, { spot: contactButton.spot, extra: contacts.front });
    badge = { ...b, what: 'button' };
    contacts.front.push(badge);
    badge.art = await contactButton.render({ w:b.w, h:b.h, plate: theme.accent, ink,
                                             fontBytes: face?.bytes ?? null, family: fam });
    if (b.over)
      log('     ! the front had no clear corner for the add-contact button, so it sits over ' +
          'the card\'s artwork — drag it where you want it in world, or turn it off under Resonite.');
  }

  /* Hover overlays, in the card's own accent and typeface. Optional: with no renderer the
     targets still work, they just carry no label on hover.

     Sized to a LABEL rather than to the target. The overlay used to span whatever it covered,
     which on a name run is about right and on a profile picture is a plate the size of the
     photo — hovering the avatar blanked half the card behind a slab reading "Add contact".
     A capped pill centred in the target says the same thing without hiding the card. */
  if (overlayFor && theme) {
    const plate = `rgba(${theme.accentRGB.join(',')},0.93)`;
    for (const side of Object.keys(contacts)) for (const t of contacts[side]) {
      if (t.art) continue;                      // the chip already says what it does
      const lw = Math.min(t.w, Math.max(PX_W * 0.26, 64));
      t.label = { w: lw, h: Math.min(t.h, Math.max(lw / 3.2, 20)) };
      t.overlay = await overlayFor({ w:t.label.w, h:t.label.h, plate, ink,
                                     fontBytes:face.bytes, family:fam });
    }
  }

  /* Every raster the tree references, hashed before the tree is built.
     Content addressing is what ties a component to its bytes (`@packdb:///<sha256>`), and the
     web has no synchronous digest — crypto.subtle is promise-only. Rather than make the whole
     tree construction async, hash the images up front and look them up by reference while
     building. imageFor MUST therefore return the same array for the same arguments; both
     drivers cache for that reason. */
  const pngs = [];
  for (const side of Object.keys(faces)) {
    if (!faces[side]) continue;
    pngs.push(imageFor('bg', side));
    // baked draws no separate graphics, so none were rendered to hash
    if (!bake) (faces[side].gfx || []).forEach((_, i) => pngs.push(imageFor('gfx', side, i)));
  }
  for (const side of Object.keys(contacts)) for (const t of contacts[side]) {
    if (t.overlay) pngs.push(t.overlay);
    if (t.art) pngs.push(t.art);
  }
  const hashes = new Map();
  for (const p of pngs) if (!hashes.has(p)) hashes.set(p, await sha256(p));
  const hashOf = (p) => {
    const h = hashes.get(p);
    if (!h) throw new Error('an image reached texturedQuad that was never hashed — imageFor ' +
                            'must return the same array each time it is asked for one');
    return h;
  };

  // Standing off from the card does NOT stop a click reaching the far face, and neither does
  // putting plain geometry in the way: RaycastTouchSource walks EVERY hit in distance order
  // and skips the ones with no ITouchable above them, giving up only once it is
  // MaxTouchPenetrationDistance past the first hit — 10mm on the laser, 50mm by default.
  // The card is 4mm deep, buttons included. Nothing inert can shadow anything.
  //
  // So each face carries a SHIELD: a TouchButton with no receivers, at the mirrored footprint
  // of every button on the OTHER face, sitting nearer the card than this face's own buttons.
  // It is the first touchable the ray meets there, and it does nothing, so the far face's
  // add-contact is unreachable while this face's own buttons still win where they overlap.
  // Only the far side's footprints are covered, so the rest of the card still reads as
  // grabbable rather than as one card-sized button.
  const shieldsFor = side => {
    const other = side === 'front' ? 'back' : 'front';
    if (!faces[other]) return [];
    return [...contacts[other], ...(faces[other].links || [])]
      .map(b => ({ x: PX_W - (b.x + b.w) - SHIELD_PAD, y: b.y - SHIELD_PAD,
                   w: b.w + 2*SHIELD_PAD, h: b.h + 2*SHIELD_PAD }));
  };

  const shieldSlot = (b, i) => pf.makeSlot(`${String(i+1).padStart(2,'0')} shields the other face`,
    [ pf.component(CP.BoxCollider, { Size:[D(b.w),D(b.h),D(SHIELD_DEPTH)], Type:'Static',
        Mass:D(0.1), CharacterCollider:false, IgnoreRaycasts:false }).comp,
      pf.component(CP.TouchButton, { AcceptPhysicalTouch:true, AcceptRemoteTouch:true,
        AcceptOutOfSightTouch:false }).comp ],
    [ (b.x+b.w/2)-PX_W/2, -((b.y+b.h/2)-PX_H/2), -SHIELD_Z ]);

  const touchReport = [];
  function faceSlot(side, z, flip) {
    const f = faces[side]; if (!f) return null;
    const px = (name, kids) => { const r = pf.makeSlot(name, [], [0,0,0], kids);
      r.Scale.Data=[D(S),D(S),D(S)]; r.Rotation.Data=Y180(D); return r; };
    const kids = [ pf.makeSlot('Background',
      texturedQuad(imageFor('bg', side),
        { w:CARD_W, h:CARD_H, queue:Q_PLATE, ownFlip:ON_THE_FACE }), [0,0,0]) ];
    // baked: the plate already carries both, so rebuilding them would double them up
    if (!bake && f.gfx?.length)   kids.push(px('Graphics', f.gfx.map(gfxSlot(side))));
    // a run with emoji in it is in f.gfx instead — no text font has the glyphs, and Resonite
    // has no fallback, so a TextRenderer would draw NO GLYPH boxes
    const asText = f.layers.filter(drawnAsText);
    if (!bake && asText.length) kids.push(px('Text', asText.map(textSlot)));
    if (f.links?.length) kids.push(px('Links', f.links.map(linkSlot)));
    const ct = contacts[side];
    if (ct.length) { touchReport.push(...ct.map(t => ({ side, ...t })));
                     kids.push(px('Add contact', ct.map(contactSlot))); }
    const sh = shieldsFor(side);
    if (sh.length) kids.push(px('Shields', sh.map(shieldSlot)));
    const s = pf.makeSlot(side==='front'?'Front':'Back', [], [0,0,z], kids);
    if (flip) s.Rotation.Data=Y180(D);
    return s;
  }

  const root = pf.makeSlot(`dropcard — ${job.template}`, [
    pf.component(CP.ObjectRoot, {}).comp,
    pf.component(CP.Grabbable, { Scalable:true }).comp,
    pf.component(CP.BoxCollider, { Size:[D(CARD_W),D(CARD_H),D(COLLIDER_T)], Type:'Static', Mass:D(0.1) }).comp,
  // The FRONT faces -Z, which is what greets you on import. A spawned slot is given
  // `rotation = LocalUserViewRotation` (SlotPositioning.PositionInFrontOfUser), and the view
  // rotation's +Z points where you are looking — away from you. So +Z is the side you never
  // see first, and a card whose front faced +Z always landed showing its back.
  // Swapping the two (z, flip) pairs rotates the whole card; each face's own subtree turns
  // with its plate, so nothing inside it is mirrored by this.
  ], [0,0,0], [faceSlot('front', -CARD_GAP/2, true), faceSlot('back', CARD_GAP/2, false)].filter(Boolean),
     null);

  // Runs on every card, every build. This is what stops a fourth mirrored element.
  assertFacing(root, pf, `${job.template} card`);

  const noPic = Object.entries(faces)
    .filter(([, f]) => f.avatar && !f.avatar.hasImage).map(([side]) => side);
  if (noPic.length)
    log(`     ! no profile picture on the ${noPic.join(' and ')} — the add-contact ` +
                `target is the empty placeholder frame. Import or upload an avatar for a real one.`);
  return { root, CARD_W, CARD_H, S, fonts, noPic, touchReport, userIdFields, badge, drawnByTemplate,
         dilations: [...textMats.keys()].map(Number).sort((a,b)=>a-b) };
}

export { TV, CP, LONG_EDGE, CARD_GAP, COLLIDER_T, Q_PLATE, Q_GFX, Q_TEXT };
