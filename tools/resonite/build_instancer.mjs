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
  RefSlot:       GREF(`${FE}Slot`),
};
const TOUCH_BUTTON = FE + 'TouchButton';

const BTN = 0.05;            // 50mm button face
const prefixArg = process.argv[2] || 'info-editorial';

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

// ── the button ──────────────────────────────────────────────────────────────
const btnPng = readFileSync(new URL(`./${prefixArg}-bg-front.png`, import.meta.url));
const btnHash = createHash('sha256').update(btnPng).digest('hex');
const btnTex = asset(CARD_CP.StaticTexture2D, { URL:`@packdb:///${btnHash}`,
  Uncompressed:false, DirectLoad:false, ForceExactVariant:false, PreferredProfile:'sRGB',
  MipMapBias:D(0), IsNormalMap:false, WrapModeU:'Clamp', WrapModeV:'Clamp',
  PowerOfTwoAlignThreshold:D(0.05), CrunchCompressed:false, MipMaps:true,
  KeepOriginalMipMaps:false, MipMapFilter:'Box', Readable:false });
const btnMat = asset(CARD_CP.Unlit, { TintColor:[D(1),D(1),D(1),D(1),'sRGB'], Texture:btnTex.id,
  BlendMode:'Alpha', AlphaCutoff:D(0.5), UseVertexColors:false, ZWrite:'On', RenderQueue:new Int32(3000) });
assets.push(btnTex.entry, btnMat.entry);
if (!embeds.some(e => e.hash === btnHash)) embeds.push({ hash:btnHash, bytes:btnPng });

const btnH = BTN * (card.CARD_H / card.CARD_W);
const btnQuad = pf.component(CARD_CP.QuadMesh, { Rotation:[D(0),D(1),D(0),D(0)],
  Size:[D(BTN),D(btnH)], UVOffset:[D(0),D(0)], UVScale:[D(1),D(1)], ScaleUVWithSize:false });
const btnRend = pf.component(CARD_CP.MeshRenderer, { Mesh:btnQuad.id, Materials:pf.list([btnMat.id]),
  MaterialPropertyBlocks:[], ShadowCastMode:'On', SortingOrder:new Int32(0) });
const btnCol = pf.component(CARD_CP.BoxCollider, { Size:[D(BTN),D(btnH),D(0.01)],
  Type:'Static', Mass:D(0.1), CharacterCollider:false, IgnoreRaycasts:false });
const touch = pf.component(TOUCH_BUTTON, {
  AcceptPhysicalTouch:true, AcceptRemoteTouch:true, AcceptOutOfSightTouch:false });
const buttonSlot = pf.makeSlot('Button', [btnQuad.comp, btnRend.comp, btnCol.comp, touch.comp], [0,0,0]);

// ── the graph ───────────────────────────────────────────────────────────────
const refBtn  = fnode(N.RefButton,  { Reference: touch.id }, 'Button ref');
const evt     = fnode(N.ButtonEvents, { Button:refBtn.id, Pressed:null, Pressing:null,
  Released:null, HoverEnter:null, HoverStay:null, HoverLeave:null,
  Source:null, GlobalPoint:null, LocalPoint:null, NormalizedPoint:null }, 'ButtonEvents');
const refTpl  = fnode(N.RefSlot, { Reference: card.root.ID }, 'Template ref');
const dup     = fnode(N.DuplicateSlot, { Next:null, Template:refTpl.id, OverrideParent:null, Duplicate:null }, 'DuplicateSlot');
const setPar  = fnode(N.SetParent, { Next:null, Instance:dup.f.Duplicate, NewParent:null, PreserveGlobalPosition:null }, 'SetParent');
const trueIn  = fnode(N.InBool, { Value:true }, 'true');
const setAct  = fnode(N.SetActive, { Next:null, Instance:dup.f.Duplicate, Active:trueIn.id }, 'SetSlotActiveSelf');

const me      = fnode(N.LocalUser, {}, 'LocalUser');
const myRoot  = fnode(N.UserUserRoot, { User:me.id }, 'UserUserRoot');
const lPos    = fnode(N.LeftHandPos,  { UserRoot:myRoot.id }, 'LeftHandPosition');
const rPos    = fnode(N.RightHandPos, { UserRoot:myRoot.id }, 'RightHandPosition');
const dL      = fnode(N.Distance, { A:evt.f.GlobalPoint, B:lPos.id }, 'Distance to left hand');
const dR      = fnode(N.Distance, { A:evt.f.GlobalPoint, B:rPos.id }, 'Distance to right hand');
const leftWin = fnode(N.LessThan, { A:dL.id, B:dR.id }, 'left hand closer?');
const inL     = fnode(N.InBodyNode, { Value:'LeftHand' },  'LeftHand');
const inR     = fnode(N.InBodyNode, { Value:'RightHand' }, 'RightHand');
const pick    = fnode(N.CondNode, { Condition:leftWin.id, OnTrue:inL.id, OnFalse:inR.id }, 'pick hand');
const hand    = fnode(N.BodyNodeSlot, { Source:me.id, Node:pick.id }, 'hand slot');

// impulse chain: press → duplicate → parent into the hand → make it visible
wire(evt,    'Pressed',   dup.id);
wire(dup,    'Next',      setPar.id);
wire(setPar, 'NewParent', hand.id);
wire(setPar, 'Next',      setAct.id);

const fluxSlot = pf.makeSlot('ProtoFlux', [], [0, -0.1, 0],
  nodes.map((n, i) => pf.makeSlot(n.name, [n.comp], [(i % 5) * 0.12 - 0.24, -Math.floor(i / 5) * 0.1, 0])));

const root = pf.makeSlot('dropcard dispenser', [
  pf.component(CARD_CP.ObjectRoot, {}).comp,
  pf.component(CARD_CP.Grabbable, { Scalable:true }).comp,
], [0,0,0], [buttonSlot, card.root, fluxSlot], null, pf.rootId);

const r = await pf.exportPackage({ name:`dropcard dispenser (${job.template})`, root,
  assets, embeddedAssets:embeds, outPath:`out/dropcard_dispenser.resonitepackage`,
  typeVersions:TV });
console.log(`  nodes=${nodes.length}  card=${(card.CARD_W*1000).toFixed(0)}×${(card.CARD_H*1000).toFixed(0)}mm  ${r.ok?'ok':'DANGLING'}`);
