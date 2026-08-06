// dropcard dispenser: a button that hands a copy of the card to whoever clicks it.
//
// ButtonEvents subscribes the engine's Local* event family, so the impulse chain runs ONLY
// on the pressing user's client (protoflux/engine-integration.md §3.3). That means LocalUser
// inside this graph IS the person who clicked — no cross-user permission problem, and the
// copy lands in their own hand. Writes replicate afterwards as ordinary deltas.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Int32 } from 'bson';
import { cardRoot, newEncoder, TV, CP as CARD_CP } from './build_batch.mjs';

const FE = '[FrooxEngine]FrooxEngine.';
const PB = '[ProtoFluxBindings]FrooxEngine.ProtoFlux.Runtimes.Execution.Nodes.';
const GREF = (t) => `${FE}ProtoFlux.GlobalReference<${t}>`;
const N = {
  ButtonEvents:  PB + 'FrooxEngine.Interaction.ButtonEvents',
  DuplicateSlot: PB + 'FrooxEngine.Slots.DuplicateSlot',
  SetParent:     PB + 'FrooxEngine.Slots.SetParent',
  SetActive:     PB + 'FrooxEngine.Slots.SetSlotActiveSelf',
  LocalUser:     PB + 'FrooxEngine.Users.LocalUser',
  UserUserRoot:  PB + 'FrooxEngine.Users.UserUserRoot',
  LeftHandPos:   PB + 'FrooxEngine.Users.Roots.LeftHandPosition',
  RightHandPos:  PB + 'FrooxEngine.Users.Roots.RightHandPosition',
  BodyNodeSlot:  PB + 'FrooxEngine.Avatar.BodyNodeSlot',
  Distance:      PB + 'Operators.Distance_Float3',
  LessThan:      PB + 'Operators.ValueLessThan<float>',
  CondNode:      PB + 'ValueConditional<[Renderite.Shared]Renderite.Shared.BodyNode>',
  InBodyNode:    PB + 'ValueInput<[Renderite.Shared]Renderite.Shared.BodyNode>',
  InBool:        PB + 'ValueInput<bool>',
  RefButton:     GREF(`${FE}IButton`),
  ElemSlot:      '[ProtoFluxBindings]FrooxEngine.FrooxEngine.ProtoFlux.CoreNodes.ElementSource<[FrooxEngine]FrooxEngine.Slot>',
};
const TOUCH_BUTTON = FE + 'TouchButton';

const BTN = 0.05;            // 50mm button face
const prefixArg = process.argv[2] || 'info-editorial';
// --minimal drops the hand heuristic (distance/compare/conditional) and spawns straight
// into the right hand. If minimal works and full doesn't, the hand maths is at fault;
// if neither works, the button or the ButtonEvents binding is.
const MINIMAL = process.argv.includes('--minimal');

const { pf, asset, assets, embeds } = newEncoder();
const D = pf.D;

// a ProtoFlux node whose field IDs are exposed, so outputs can be addressed by field
// (DuplicateSlot.Duplicate is a null sentinel that downstream nodes reference by ITS id)
const nodes = [];
function fnode(classpath, fields, name) {
  const id = pf.nextId();
  const data = { ID:id, 'persistent-ID':pf.nextId(), UpdateOrder:pf.fi(0), Enabled:pf.fd(true) };
  const f = {};
  for (const [k,v] of Object.entries(fields)) { const w = pf.fd(v); data[k] = w; f[k] = w.ID; }
  const comp = { Type: pf.typeIndex(classpath), Data: data };
  const n = { id, f, comp, data, name };
  nodes.push(n);
  return n;
}
const wire = (n, field, value) => { n.data[field].Data = value; };

// ── the card being dispensed ────────────────────────────────────────────────
const all = JSON.parse(readFileSync(new URL('./batch-layers.json', import.meta.url),'utf8'));
const job = all[prefixArg];
if (!job) throw new Error(`no capture named ${prefixArg} in batch-layers.json`);
const card = await cardRoot(pf, asset, assets, embeds, prefixArg, job);
card.root.Name.Data = 'Card Template';
card.root.Active.Data = false;          // the template itself never shows
card.root.Position.Data = [D(0), D(-0.25), D(0)];

// ── the button ─────────────────────────────────────────────────────────────
// Deliberately NOT card-shaped: a coloured slab with a printed label, so it reads as
// something to press rather than as another card lying around.
const BTN_W = 0.16, BTN_H = 0.055;
const solid = (rgb) => asset(CARD_CP.Unlit, {
  TintColor:[D(rgb[0]),D(rgb[1]),D(rgb[2]),D(1),'sRGB'],
  BlendMode:'Opaque', AlphaCutoff:D(0.5), UseVertexColors:false,
  ZWrite:'On', RenderQueue:new Int32(2000) });

const faceMat = solid([0.41,0.41,0.97]);      // dropcard blurple
const backMat = solid([0.09,0.09,0.15]);
assets.push(faceMat.entry, backMat.entry);

const slab = (mat, z, flip, name) => {
  const q = pf.component(CARD_CP.QuadMesh, { Rotation:[D(0),D(flip?0:1),D(0),D(flip?1:0)],
    Size:[D(BTN_W),D(BTN_H)], UVOffset:[D(0),D(0)], UVScale:[D(1),D(1)], ScaleUVWithSize:false });
  const r = pf.component(CARD_CP.MeshRenderer, { Mesh:q.id, Materials:pf.list([mat.id]),
    MaterialPropertyBlocks:[], ShadowCastMode:'On', SortingOrder:new Int32(0) });
  return pf.makeSlot(name, [q.comp, r.comp], [0,0,z]);
};

// reuse a font the card already bundles rather than fetching another one
const labelFont = [...card.fonts.values()][0];
const labelMat = asset(CARD_CP.TextUnlit, {
  TintColor:[D(1),D(1),D(1),D(1),'sRGB'], OutlineColor:[D(0),D(0),D(0),D(0),'sRGB'],
  BackgroundColor:[D(0),D(0),D(0),D(0),'sRGB'], AutoBackgroundColor:false,
  GlyphRenderMethod:'MSDF', PixelRange:D(4), FaceDilate:D(0), OutlineThickness:D(0),
  FaceSoftness:D(0), BlendMode:'Alpha', Sidedness:'Double', ZWrite:'Auto', RenderQueue:new Int32(3100) });
assets.push(labelMat.entry);
const label = pf.makeSlot('Label', [pf.component(CARD_CP.TextRenderer, {
  Text: MINIMAL ? 'TAP  (MINIMAL)' : 'TAP  FOR  A  CARD', ParseRichText:false, NullText:null,
  Size:D(0.018 * 10),                       // TextRenderer multiplies Size by 0.1
  HorizontalAlign:'Center', VerticalAlign:'Middle', AlignmentMode:'Geometric',
  Color:[D(1),D(1),D(1),D(1),'sRGB'], Materials:pf.list([labelMat.id]), LineHeight:D(0.8),
  Bounded:true, BoundsSize:[D(BTN_W*0.9),D(BTN_H*0.8)], BoundsAlignment:'MiddleCenter',
  MaskPattern:null, HorizontalAutoSize:false, VerticalAutoSize:false,
  Font:labelFont.id }).comp], [0,0,0.0015]);   // own rotation => POSITIVE z to face out
label.Rotation.Data = [D(0),D(1),D(0),D(0)];
// a second label on the far side: no rotation means it faces -Z, so it reads correctly
// from behind too. A test rig shouldn't depend on which way the import happens to land.
const labelBack = pf.makeSlot('Label (back)', [pf.component(CARD_CP.TextRenderer, {
  Text: MINIMAL ? 'TAP  (MINIMAL)' : 'TAP  FOR  A  CARD', ParseRichText:false, NullText:null,
  Size:D(0.018 * 10), HorizontalAlign:'Center', VerticalAlign:'Middle', AlignmentMode:'Geometric',
  Color:[D(1),D(1),D(1),D(1),'sRGB'], Materials:pf.list([labelMat.id]), LineHeight:D(0.8),
  Bounded:true, BoundsSize:[D(BTN_W*0.9),D(BTN_H*0.8)], BoundsAlignment:'MiddleCenter',
  MaskPattern:null, HorizontalAutoSize:false, VerticalAutoSize:false,
  Font:labelFont.id }).comp], [0,0,-0.0015]);

const btnCol = pf.component(CARD_CP.BoxCollider, { Size:[D(BTN_W),D(BTN_H),D(0.012)],
  Type:'Static', Mass:D(0.1), CharacterCollider:false, IgnoreRaycasts:false });
const touch = pf.component(TOUCH_BUTTON, {
  AcceptPhysicalTouch:true, AcceptRemoteTouch:true, AcceptOutOfSightTouch:false });
const buttonSlot = pf.makeSlot('Button — press me', [btnCol.comp, touch.comp], [0,0,0],
  [ slab(faceMat, 0.0005, false, 'Face'), slab(backMat, -0.0005, true, 'Back'), label, labelBack ]);

// ── the graph ───────────────────────────────────────────────────────────────
const refBtn  = fnode(N.RefButton,  { Reference: touch.id }, 'Button ref');
const evt     = fnode(N.ButtonEvents, { Button:refBtn.id, Pressed:null, Pressing:null,
  Released:null, HoverEnter:null, HoverStay:null, HoverLeave:null,
  Source:null, GlobalPoint:null, LocalPoint:null, NormalizedPoint:null }, 'ButtonEvents');
const refTpl  = fnode(N.ElemSlot, { Source: card.root.ID }, 'Card template source');
const dup     = fnode(N.DuplicateSlot, { Next:null, Template:refTpl.id, OverrideParent:null, Duplicate:null }, 'DuplicateSlot');
const setPar  = fnode(N.SetParent, { Next:null, Instance:dup.f.Duplicate, NewParent:null, PreserveGlobalPosition:null }, 'SetParent');
const trueIn  = fnode(N.InBool, { Value:true }, 'true');
const setAct  = fnode(N.SetActive, { Next:null, Instance:dup.f.Duplicate, Active:trueIn.id }, 'SetSlotActiveSelf');

const me = fnode(N.LocalUser, {}, 'LocalUser');
let handNodeSource;
if (MINIMAL) {
  handNodeSource = fnode(N.InBodyNode, { Value:'RightHand' }, 'RightHand (fixed)').id;
} else {
  const myRoot  = fnode(N.UserUserRoot, { User:me.id }, 'UserUserRoot');
  const lPos    = fnode(N.LeftHandPos,  { UserRoot:myRoot.id }, 'LeftHandPosition');
  const rPos    = fnode(N.RightHandPos, { UserRoot:myRoot.id }, 'RightHandPosition');
  const dL      = fnode(N.Distance, { A:evt.f.GlobalPoint, B:lPos.id }, 'Distance to left hand');
  const dR      = fnode(N.Distance, { A:evt.f.GlobalPoint, B:rPos.id }, 'Distance to right hand');
  const leftWin = fnode(N.LessThan, { A:dL.id, B:dR.id }, 'left hand closer?');
  const inL     = fnode(N.InBodyNode, { Value:'LeftHand' },  'LeftHand');
  const inR     = fnode(N.InBodyNode, { Value:'RightHand' }, 'RightHand');
  handNodeSource = fnode(N.CondNode, { Condition:leftWin.id, OnTrue:inL.id, OnFalse:inR.id }, 'pick hand').id;
}
const hand = fnode(N.BodyNodeSlot, { Source:me.id, Node:handNodeSource }, 'hand slot');

// impulse chain: press → duplicate → parent into the hand → make it visible
wire(evt,    'Pressed',   dup.id);
wire(dup,    'Next',      setPar.id);
wire(setPar, 'NewParent', hand.id);
wire(setPar, 'Next',      setAct.id);

// pretty-flux §2: laid out deliberately rather than dumped on a grid. Data flows
// left→right on its own row, the impulse chain runs on a row below it, and every
// constant/source sits ~0.22 left of the node it feeds. Checked by hand for backward
// wires (a producer right of its consumer's input port folds the corner).
// NOT yet run through the §3 autorouter (router.mjs) — no relays are inserted.
const AT = {
  'Button ref':             [-1.40, -0.25], 'ButtonEvents':      [-1.16, -0.25],
  'Card template source':   [-0.92, -0.45], 'DuplicateSlot':     [-0.68, -0.25],
  'SetParent':              [ 0.28, -0.25], 'true':              [ 0.28, -0.47],
  'SetSlotActiveSelf':      [ 0.52, -0.25],
  'LocalUser':              [-1.40,  0.50], 'UserUserRoot':      [-1.16,  0.50],
  'LeftHandPosition':       [-0.92,  0.64], 'RightHandPosition': [-0.92,  0.36],
  'Distance to left hand':  [-0.68,  0.64], 'Distance to right hand': [-0.68, 0.36],
  'left hand closer?':      [-0.44,  0.50],
  'LeftHand':               [-0.44,  0.22], 'RightHand':         [-0.44,  0.08],
  'RightHand (fixed)':      [-0.44,  0.15],
  'pick hand':              [-0.20,  0.15], 'hand slot':         [ 0.04,  0.15],
};
const fluxSlot = pf.makeSlot('ProtoFlux', [], [0, -0.55, 0],
  nodes.map((n) => {
    const at = AT[n.name];
    if (!at) throw new Error(`no pretty-flux placement for node "${n.name}"`);
    return pf.makeSlot(n.name, [n.comp], [at[0], at[1], 0]);
  }));

// No Grabbable on the test rig ON PURPOSE. Pointing a laser at a grabbable object and
// clicking grabs it, which would mask the touch we're trying to test. Move it with the
// inspector/dev tool instead; the shipped badge won't be grabbable either.
const root = pf.makeSlot('dropcard dispenser', [
  pf.component(CARD_CP.ObjectRoot, {}).comp,
], [0,0,0], [buttonSlot, card.root, fluxSlot], null, pf.rootId);

const r = await pf.exportPackage({ name:`dropcard dispenser${MINIMAL?' minimal':''} (${job.template})`, root,
  assets, embeddedAssets:embeds, outPath:`out/dropcard_dispenser${MINIMAL?'_minimal':''}.resonitepackage`,
  typeVersions:TV });
console.log(`  nodes=${nodes.length}  card=${(card.CARD_W*1000).toFixed(0)}×${(card.CARD_H*1000).toFixed(0)}mm  ${r.ok?'ok':'DANGLING'}`);
