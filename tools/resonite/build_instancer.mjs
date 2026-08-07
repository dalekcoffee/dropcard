// dropcard dispenser: a button that hands a copy of the card to whoever clicks it.
//
// ButtonEvents subscribes the engine's Local* event family, so the impulse chain runs ONLY
// on the pressing user's client (protoflux/engine-integration.md §3.3). That means LocalUser
// inside this graph IS the person who clicked — no cross-user permission problem, and the
// copy appears in front of THEIR head. Writes replicate afterwards as ordinary deltas.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Int32 } from 'bson';
import pkg from '/opt/node22/lib/node_modules/playwright/index.js'; const { chromium } = pkg;
import { cardRoot, newEncoder, assertFacing, TV, CP as CARD_CP } from './build_batch.mjs';
import { cardTheme, inkFor, resolveIcon, renderButtonFace, BACKINGS } from './icon.mjs';

const FE = '[FrooxEngine]FrooxEngine.';
const PB = '[ProtoFluxBindings]FrooxEngine.ProtoFlux.Runtimes.Execution.Nodes.';
const GREF = (t) => `${FE}ProtoFlux.GlobalReference<${t}>`;
const N = {
  ButtonEvents:  PB + 'FrooxEngine.Interaction.ButtonEvents',
  DuplicateSlot: PB + 'FrooxEngine.Slots.DuplicateSlot',
  SetParent:     PB + 'FrooxEngine.Slots.SetParent',
  SetActive:     PB + 'FrooxEngine.Slots.SetSlotActiveSelf',
  LocalUser:     PB + 'FrooxEngine.Users.LocalUser',
  BodyNodeSlot:  PB + 'FrooxEngine.Avatar.BodyNodeSlot',
  RootSlot:      PB + 'FrooxEngine.Slots.RootSlot',
  LocalToGlobal: PB + 'FrooxEngine.Transform.LocalPointToGlobal',
  GlobalXform:   PB + 'FrooxEngine.Transform.GlobalTransform',
  SetGlobalPR:   PB + 'FrooxEngine.Transform.SetGlobalPositionRotation',
  InBodyNode:    PB + 'ValueInput<[Renderite.Shared]Renderite.Shared.BodyNode>',
  InFloat3:      PB + 'ValueInput<float3>',
  InBool:        PB + 'ValueInput<bool>',
  RefButton:     GREF(`${FE}IButton`),
  RefSlot:       GREF(`${FE}Slot`),
  ElemSlot:      '[ProtoFluxBindings]FrooxEngine.FrooxEngine.ProtoFlux.CoreNodes.ElementSource<[FrooxEngine]FrooxEngine.Slot>',
  // baking the owner's id into the template's ContactLinks
  Update:        PB + 'Actions.Update',
  If:            PB + 'If',
  GetActiveUser: PB + 'FrooxEngine.Slots.GetActiveUser',
  UserUserID:    PB + 'FrooxEngine.Users.UserUserID',
  NotNullUser:   PB + `NotNull<${FE}User>`,
  IsStringEmpty: PB + 'Strings.IsStringEmpty',
  AndBool:       PB + 'Operators.AND_Bool',
  RefStrField:   GREF(`${FE}IValue<string>`),
  StrSource:     '[ProtoFluxBindings]FrooxEngine.FrooxEngine.ProtoFlux.CoreNodes.ObjectValueSource<string>',
  WriteStr:      PB + `ObjectWrite<${FE}ProtoFlux.FrooxEngineContext,string>`,
};
const TOUCH_BUTTON = FE + 'TouchButton';

// --icon=landscape|vertical|auto  --backing=square|pill|none
// --backing-color=#rrggbb|theme   --icon-color=#rrggbb|theme
const OPT = Object.fromEntries(process.argv.filter(a => a.startsWith('--') && a.includes('='))
  .map(a => a.slice(2).split('=')));
const hexToRGB = h => { const s = h.replace('#','');
  const n = s.length === 3 ? [...s].map(c => c + c) : s.match(/../g);
  return n.map(v => parseInt(v, 16)); };
const prefixArg = process.argv.slice(2).find(a => !a.startsWith('-')) || 'info-editorial';
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
// one browser for the whole build: the card's hover overlays and the button face
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport:{width:600,height:600},
  deviceScaleFactor:1 })).newPage();
const card = await cardRoot(pf, asset, assets, embeds, prefixArg, job, page);
card.root.Name.Data = 'Card Template — every dispensed card is a copy of this';
card.root.Active.Data = false;          // the template itself never shows
card.root.Position.Data = [0, 0, 0].map(D);   // placement is set explicitly on each copy

// Where a dispensed card appears: straight out from the head, a little below eye line, in
// the world rather than attached to anything. Parenting it to a hand only works if you have
// a second hand free to take it off the first — which desktop users do not.
const SPAWN_AHEAD = 0.45, SPAWN_BELOW = 0.12;   // metres

// ── the button ─────────────────────────────────────────────────────────────
// The card icon on a backing, in the card's own colours. Deliberately NOT card-shaped: it
// reads as something to press rather than as another card lying around. Every choice here
// is meant to become an export option in the app, so none of it is hardcoded — see icon.mjs.
const theme = cardTheme(job, prefixArg, import.meta.url);
const backing = OPT.backing ?? 'rounded';        // rounded | square | circle | none
if (!BACKINGS[backing]) throw new Error(
  `unknown backing "${backing}" — one of ${Object.keys(BACKINGS).join(', ')}`);
const backingColor = (!OPT['backing-color'] || OPT['backing-color'] === 'theme')
  ? theme.accent : OPT['backing-color'];
const ink = (!OPT['icon-color'] || OPT['icon-color'] === 'theme')
  ? inkFor(backing === 'none' ? theme.surfaceRGB : hexToRGB(backingColor), theme)
  : OPT['icon-color'];
const iconFile = resolveIcon(OPT.icon ?? 'auto', job);

const facePNG = await renderButtonFace(page, { iconFile, size:512, ink, backing,
  backingColor, dir:import.meta.url });
await browser.close();

const BTN_W = 0.075, BTN_H = 0.075;
const faceHash = createHash('sha256').update(facePNG).digest('hex');
const faceTex = asset(CARD_CP.StaticTexture2D, { URL:`@packdb:///${faceHash}`, Uncompressed:false,
  DirectLoad:false, ForceExactVariant:false, PreferredProfile:'sRGB', MipMapBias:D(0),
  IsNormalMap:false, WrapModeU:'Clamp', WrapModeV:'Clamp', PowerOfTwoAlignThreshold:D(0.05),
  CrunchCompressed:false, MipMaps:true, KeepOriginalMipMaps:false, MipMapFilter:'Box', Readable:false });
// Queue 3000, not 2000. Anything under 2500 is opaque, and the engine's screen-space passes
// — light shafts, bloom occlusion — build their depth from the opaque queue. An alpha-blended
// quad in there writes depth across its WHOLE rectangle, cut-away corners included, so the
// sun got occluded by the parts of the button that are not there and ghosted a second copy of
// itself at each corner. The card plates have always been at 3000 for the same reason.
const faceMat = asset(CARD_CP.Unlit, { TintColor:[D(1),D(1),D(1),D(1),'sRGB'], Texture:faceTex.id,
  BlendMode:'Alpha', AlphaCutoff:D(0.5), UseVertexColors:false, ZWrite:'On',
  RenderQueue:new Int32(3000) });
assets.push(faceTex.entry, faceMat.entry);
embeds.push({ hash:faceHash, bytes:facePNG });

// A quad's rotation decides both its facing and which way its texture reads: identity faces
// -Z and reads correctly from -Z; [0,1,0,0] faces +Z and reads correctly from +Z. So the two
// slabs carry opposite rotations and the icon is the right way round from either side —
// which also means it does not matter which way the dispenser lands on import.
const slab = (mat, z, flip, name) => {
  const q = pf.component(CARD_CP.QuadMesh, { Rotation:[D(0),D(flip?0:1),D(0),D(flip?1:0)],
    Size:[D(BTN_W),D(BTN_H)], UVOffset:[D(0),D(0)], UVScale:[D(1),D(1)], ScaleUVWithSize:false });
  const r = pf.component(CARD_CP.MeshRenderer, { Mesh:q.id, Materials:pf.list([mat.id]),
    MaterialPropertyBlocks:[], ShadowCastMode:'On', SortingOrder:new Int32(0) });
  return pf.makeSlot(name, [q.comp, r.comp], [0,0,z]);
};

const btnCol = pf.component(CARD_CP.BoxCollider, { Size:[D(BTN_W),D(BTN_H),D(0.012)],
  Type:'Static', Mass:D(0.1), CharacterCollider:false, IgnoreRaycasts:false });
const touch = pf.component(TOUCH_BUTTON, {
  AcceptPhysicalTouch:true, AcceptRemoteTouch:true, AcceptOutOfSightTouch:false });
const buttonSlot = pf.makeSlot('Button — press me', [btnCol.comp, touch.comp], [0,0,0],
  [ slab(faceMat, 0.0005, false, 'Face'), slab(faceMat, -0.0005, true, 'Back') ]);

// No separate grab handle. It was there on the theory that a TouchButton would swallow the
// grab, and that is not how the engine works: grab is a different input, and Grab() resolves
// through `Laser.CurrentHit` — the CLOSEST collider — then walks up for an IGrabbable
// (InteractionHandler.Grab). Touchables never enter that path unless they are ITouchGrabbable,
// which TouchButton is not. So pointing anywhere on the button and pressing grab picks up the
// whole dispenser, and the tab was only ever a black bar stuck to the side.

// ── the graph ───────────────────────────────────────────────────────────────
const refBtn  = fnode(N.RefButton,  { Reference: touch.id }, 'Button ref');
const evt     = fnode(N.ButtonEvents, { Button:refBtn.id, Pressed:null, Pressing:null,
  Released:null, HoverEnter:null, HoverStay:null, HoverLeave:null,
  Source:null, GlobalPoint:null, LocalPoint:null, NormalizedPoint:null }, 'ButtonEvents');
const tplProxy = fnode(N.RefSlot,  { Reference: card.root.ID }, 'Card template source');
const refTpl   = fnode(N.ElemSlot, { Source: tplProxy.id },     'Card template source');
const dup     = fnode(N.DuplicateSlot, { Next:null, Template:refTpl.id, OverrideParent:null, Duplicate:null }, 'DuplicateSlot');
const setPar  = fnode(N.SetParent, { Next:null, Instance:dup.f.Duplicate, NewParent:null, PreserveGlobalPosition:null }, 'SetParent');   // wired below
const trueIn  = fnode(N.InBool, { Value:true },  'true');
const falseIn = fnode(N.InBool, { Value:false }, 'false');
const setAct  = fnode(N.SetActive, { Next:null, Instance:dup.f.Duplicate, Active:trueIn.id }, 'SetSlotActiveSelf');

const me   = fnode(N.LocalUser, {}, 'LocalUser');
const head = fnode(N.BodyNodeSlot, { Source:me.id, Node:fnode(N.InBodyNode, { Value:'Head' }, 'Head').id },
  'head slot');
// One node does offset AND orientation: a point in the head's own frame, 0.45 ahead and
// 0.12 down, converted to world. No vector maths, no separate forward direction.
const where = fnode(N.LocalToGlobal, { Instance:head.id,
  LocalPoint:fnode(N.InFloat3, { Value:[D(0), D(-SPAWN_BELOW), D(SPAWN_AHEAD)] }, 'in front of me').id },
  'where to put it');
// Facing: the card's front is its own -Z, so giving it the head's rotation points that front
// straight back at the head. Same rotation, opposite side of the gap.
const headX = fnode(N.GlobalXform, { Instance:head.id, GlobalPosition:null, GlobalRotation:null,
  GlobalScale:null }, 'head orientation');
// Into the WORLD, not under the dispenser: a duplicate defaults to a sibling of its template,
// which would make every card ride along whenever the dispenser is picked up.
const world = fnode(N.RootSlot, {}, 'world root');
const place = fnode(N.SetGlobalPR, { Next:null, Instance:dup.f.Duplicate, Position:where.id,
  Rotation:headX.f.GlobalRotation }, 'put it in front of me');

// ── baking the owner's UserId into the template ─────────────────────────────
// The card's ContactLink ships with UserId EMPTY: a card that hands out someone else's
// contact is worse than one that hands out none. The dispenser fills it in once, from
// whoever is holding it — never from whoever presses it, so a stranger pressing your
// dispenser gets your card rather than becoming its owner.
//
// GetActiveUser on the dispenser's own root is what "holding it" means: a grabbed object is
// parented under the grabber's UserRoot, so its active user IS the person holding it, and it
// stays baked after they put it down. Same for parenting it under yourself by hand.
//
// The gate is `owner exists AND the id is still blank`, so the write happens once and a
// later grab by someone else cannot overwrite it — which is the whole reason this is a WRITE
// and not a drive. Update runs on the HOST only (UserUpdateBase.ShouldRegister falls back to
// World.HostUser when UpdatingUser is null and SkipIfNull is false), so exactly one client
// does it rather than all of them racing.
const rootProxy = fnode(N.RefSlot,  { Reference: pf.rootId }, 'Dispenser root source');
const rootSrc   = fnode(N.ElemSlot, { Source: rootProxy.id }, 'Dispenser root source');
const owner     = fnode(N.GetActiveUser, { Instance: rootSrc.id }, 'who is holding this');
const ownerId   = fnode(N.UserUserID,    { User: owner.id },       'their user id');
const haveOwner = fnode(N.NotNullUser,   { Instance: owner.id },   'someone is holding it');

// One GlobalReference + ObjectValueSource per ContactLink — a field is reached through a
// proxy pair, exactly as DuplicateSlot.Template is. The first source doubles as the READ
// used by the gate, so no extra node is needed to ask whether the id is already set.
const links = card.userIdFields.map((fieldId, i) => {
  const ref = fnode(N.RefStrField, { Reference: fieldId }, `UserId field ${i+1}`);
  return fnode(N.StrSource, { Source: ref.id }, `UserId field ${i+1}`);
});
if (!links.length) throw new Error('the card has no ContactLink to bake a UserId into');
const blank   = fnode(N.IsStringEmpty, { A: links[0].id }, 'id still blank?');
const ready   = fnode(N.AndBool, { A: haveOwner.id, B: blank.id }, 'ready to bake');
const gate    = fnode(N.If, { OnTrue:null, OnFalse:null, Condition: ready.id }, 'only once');
const tick    = fnode(N.Update, { UpdatingUser:null, SkipIfNull:null, OnUpdate: gate.id }, 'Update');
const writes  = links.map((src, i) => fnode(N.WriteStr,
  { OnWritten:null, OnFail:null, Variable: src.id, Value: ownerId.id }, `bake into contact ${i+1}`));
wire(gate, 'OnTrue', writes[0].id);
writes.forEach((w, i) => { if (writes[i+1]) wire(w, 'OnWritten', writes[i+1].id); });

// impulse chain: press → duplicate → into the world → position it → only THEN show it,
// so nobody sees the copy at the world origin on the frame between reparenting and placing
wire(evt,    'Pressed',   dup.id);
wire(dup,    'Next',      setPar.id);
wire(setPar, 'NewParent', world.id);
wire(setPar, 'PreserveGlobalPosition', falseIn.id);
wire(setPar, 'Next',      place.id);
wire(place,  'Next',      setAct.id);

// pretty-flux §2: laid out deliberately rather than dumped on a grid. Data flows
// left→right on its own row, the impulse chain runs on a row below it, and every
// constant/source sits ~0.22 left of the node it feeds. Checked by hand for backward
// wires (a producer right of its consumer's input port folds the corner).
// NOT yet run through the §3 autorouter (router.mjs) — no relays are inserted.
const AT = {
  'Button ref':             [-1.40, -0.25], 'ButtonEvents':      [-1.16, -0.25],
  'Card template source':   [-0.92, -0.45], 'DuplicateSlot':     [-0.68, -0.25],
  'SetParent':              [ 0.28, -0.25], 'false':             [ 0.06, -0.47],
  'put it in front of me':  [ 0.52, -0.25], 'true':              [ 0.76, -0.47],
  'SetSlotActiveSelf':      [ 0.76, -0.25],
  'LocalUser':              [-1.40,  0.30], 'Head':              [-1.16,  0.46],
  'head slot':              [-0.92,  0.30], 'in front of me':    [-0.92,  0.58],
  'where to put it':        [-0.68,  0.44], 'head orientation':  [-0.68,  0.16],
  'world root':             [ 0.04,  0.02],
  // the bake, on its own band well below the dispense chain
  'Dispenser root source':  [-1.40,  1.20], 'who is holding this':   [-1.16, 1.20],
  'their user id':          [-0.92,  1.20], 'someone is holding it': [-0.92, 1.44],
  'id still blank?':        [-0.68,  1.60], 'ready to bake':         [-0.44, 1.52],
  'Update':                 [-0.44,  1.20], 'only once':             [-0.20, 1.20],
};
// one row per ContactLink, so the count follows the template rather than the layout map
links.forEach((_, i) => { AT[`UserId field ${i+1}`]    = [-1.40, 1.60 + i * 0.16]; });
writes.forEach((_, i) => { AT[`bake into contact ${i+1}`] = [0.04 + i * 0.24, 1.20]; });
const grouped = new Map();
for (const n of nodes) {
  if (!AT[n.name]) throw new Error(`no pretty-flux placement for node "${n.name}"`);
  (grouped.get(n.name) ?? grouped.set(n.name, []).get(n.name)).push(n);
}
const fluxSlot = pf.makeSlot('ProtoFlux', [], [0, -0.55, 0],
  [...grouped].map(([name, ns]) => pf.makeSlot(name, ns.map(n => n.comp), [AT[name][0], AT[name][1], 0])));

const root = pf.makeSlot('dropcard dispenser', [
  pf.component(CARD_CP.ObjectRoot, {}).comp,
  pf.component(CARD_CP.Grabbable, { Scalable:true }).comp,
], [0,0,0], [buttonSlot, card.root, fluxSlot], null, pf.rootId);

// the dispenser's own slabs obey the same rule as the card's layers
assertFacing(root, pf, 'dispenser');

const r = await pf.exportPackage({ name:`dropcard dispenser (${job.template})`, root,
  assets, embeddedAssets:embeds, outPath:'out/dropcard_dispenser.resonitepackage',
  typeVersions:TV });
console.log(`  nodes=${nodes.length}  card=${(card.CARD_W*1000).toFixed(0)}×${(card.CARD_H*1000).toFixed(0)}mm  ${r.ok?'ok':'DANGLING'}`);
console.log(`  button: ${iconFile.replace('CardIcon','').replace('.svg','').toLowerCase()} icon, ` +
            `${backing} backing ${backing==='none'?'':backingColor}, ink ${ink}  ` +
            `(card theme: surface ${theme.surface}, accent ${theme.accent})`);
