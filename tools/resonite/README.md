# Resonite export

Turns a rendered dropcard into a `.resonitepackage` you can drag into
[Resonite](https://resonite.com). Work in progress — the card itself is done; the
instancer and installer are not built yet.

## Running it

Needs the site served locally, because the builders read the *rendered* card out of a
real browser rather than reimplementing the templates:

```sh
npx http-server -p 8899 -s ../..      # serve the repo root
npm install                           # bson, brotli-wasm, jszip, pngjs
node extract.mjs                      # → bg-*.png, gfx-*.png, layers.json
node build_layered.mjs                # → out/dropcard_Sample_layered.resonitepackage
node build_card.mjs                   # → out/dropcard_Sample_baked.resonitepackage

node batch.mjs                        # several templates in one browser session
node build_batch.mjs                  # → one package per captured template
node build_instancer.mjs info-ticket  # → out/dropcard_dispenser.resonitepackage

node verify.mjs out/dropcard_info-editorial.resonitepackage
```

`verify.mjs` decodes a built package and checks the two faults that are invisible in a render
— a touchable collider straddling the card plane, and any element facing away from the side it
sits on (which reads mirrored). Run it on anything you are about to hand someone.

`extract.mjs` drives Chromium through Playwright (`/opt/pw-browsers`, preinstalled).

## Why it reads the DOM

The 41 card templates are imperative render functions, so there is no data structure
describing "where the name goes". Instead the extractor measures the card *after* it
renders — element rectangles, computed font family/weight/size/colour, effective
opacity, and the `data-url` the app already puts on each social chip.

That makes the exporter **template-agnostic**: it works for every template, including
ones added later, with no per-template code.

## The two exports

- **Baked** — one quad per face, the whole card as a single texture.
- **Layered** — nothing is baked. A background plate, one slot per graphic, one slot per
  text run as a live `TextRenderer`, and a collider + `Hyperlink` per social chip. Fonts
  are the card's own Google families, fetched as real TTF and bundled into the package.

## Scope

Card + instancer only. There is deliberately **no badge/nameplate auto-mounting and no
installer UI**: the space above a player's head is already crowded and laid out differently
for everyone, so anything that placed itself there would fight whatever they already run.
The dispenser is a grabbable object and the user parents it wherever they want.

That is why the root carries `Grabbable` and a separate **Handle** tab. Grab and click must
not compete for one collider: the button's collider carries `TouchButton` (`ITouchable` wins
there), while the handle's collider carries only geometry, so pointing at it grabs the whole
object instead of pressing it.

## The dispenser's button

The button face is one of two card icons (`icons/`, landscape and diagonal) on a backing,
rasterised through the same browser that renders the cards. All of it is optional:

```sh
node build_instancer.mjs info-ticket \
  --icon=landscape|vertical|auto  --backing=rounded|square|circle|none \
  --backing-color=#7755cc|theme   --icon-color=#ffffff|theme
```

`rounded` is the default and `square` means square — no corners taken off. `auto` follows
the card's orientation, and `theme` reads the colours back out of the card
itself — no template declares them. The paper colour is the commonest opaque colour in the
plate raster; the accent is the most saturated colour the card spends real area on, with a
brightness floor so a near-black like `#110000` (fully saturated, and just ink) cannot win,
and printed bands beating text because a template's accent is usually a filled area. The ink
is whichever of the card's paper, white, or near-black clears 3.5:1 on the chosen backing —
a themed button nobody can read is not on theme. `--backing=none` leaves the icon alone with
no plate, and picks its ink against the card's paper.

The icon is sized by **measuring its ink**, not by padding its box. The landscape badge fills
its viewBox edge to edge while the diagonal one is a diamond inscribed in the same square, so
an identical box leaves the diagonal one visibly smaller — most obviously in a circle, where
it lost about 12% of the radius. `renderButtonFace` draws the icon once with no backing, finds
how far the ink reaches, and scales to a common target. Any icon added later gets the same
weight for free.

These are the options the app's export panel is meant to offer, which is why they live in
`icon.mjs` rather than being baked into the builder.

## Add-contact

`ContactLink` (`[Category("Cloud")]`, old name `FriendLink`) holds a `Sync<string> UserId`
and opens the contact panel on touch. `CanTouchInteract` returns `!IsUnderLocalUser`, so it
refuses its own owner — free correct behaviour.

**The name and the profile picture are the buttons**, with a themed "Add contact" overlay on
hover. No template edits needed: the exporter finds the name by matching the `name`/
`nickname` field values against captured text runs, and the avatar by matching the `<img>`
src. Element colour/font/size are already captured, so the overlay can be drawn in each
template's own theme.

A target may be **bigger than its element, never overlapping its neighbours**. The builder
takes the glyph box, tries pads of 8 / 4 / 0 card px and keeps the largest that clears every
other text run and social chip on that face, then trims against anything still in the way and
clamps to the card edge. The placeholder frame gets the same treatment from the other end: the
icon glyph is small, so it grows 1.9x (capped at 260px) unless that would touch something.

**Hover and click can share one collider.** Two `ITouchable`s cannot —
`RaycastTouchSource` takes a single `GetComponentInParentsUntilBlock` — but they don't need
to. `TouchButton` is the touchable and dispatches its press to every `IButtonPressReceiver`
**on its own slot** (`TouchButton.cs:186`), and `ContactLink` is one. So:

```
slot: BoxCollider + TouchButton + ContactLink + ValueDriver<bool>
      ValueDriver.ValueSource = TouchButton.IsHovering  ->  DriveTarget = overlay slot .Active
      TouchButton press       -> ForeachComponent -> ContactLink.Pressed()
  └─ "Add contact (on hover)"   a textured quad, Active=false, 9px proud of the face
```

The overlay is **a plain textured quad and a `ValueDriver<bool>`, no ProtoFlux** — a card has
to work on its own, sitting on a shelf away from any dispenser. `ValueDriver` points its
`ValueSource` straight at the `IsHovering` field (it is an ordinary component, not a flux node,
so it needs no proxy pair) and its `DriveTarget` at the overlay slot's `Active` field.

`IsHovering` has to be written into the export **explicitly**: this encoder serialises only the
fields it is handed, and a sync member with no serialised entry has no ID for the driver to
point at.

Each overlay is rastered at its target's own aspect, in the card's accent at 93% and the
typeface the card spends the most area in, so it reads as part of the template. On a squarish
target — the avatar frame — the label is split across lines explicitly rather than left to
wrap, so the measuring pass sees the same layout the final render uses; one line there shrinks
to about a third the size.

Note `IsHovering` is a **synced** field, so the overlay shows to everyone, not only the person
hovering. The local-only alternative is `TouchButton`'s `LocalHover*` C# events, which are
reachable only from ProtoFlux — and that would put a graph on every card.

## Baking in the UserId (built)

The card ships with `ContactLink.UserId` **empty**, because a card that hands out someone
else's contact is worse than one that hands out none. The dispenser fills it in, on its own
graph — never on the card:

```
Update ─► If(owner exists AND id still blank) ─► ObjectWrite ─► ObjectWrite ─► …
            │                                     Variable = ObjectValueSource<string>
GetActiveUser(dispenser root) ─► UserUserID ──────Value ──────┘
```

**`GetActiveUser` on the dispenser's own root is what "holding it" means.** A grabbed object
is parented under the grabber's `UserRoot`, so the slot's active user *is* whoever picked it
up, and the value stays baked after they put it down. Parenting it under yourself by hand
works the same way. Reading the presser instead would let a stranger who clicks your
dispenser become its owner.

**The gate is what makes it a bake.** `owner exists AND the id is still blank` — so it writes
once and a later grab by somebody else cannot overwrite it. That gate is the entire reason
this is a write rather than a drive; a drive re-evaluates and would follow whoever touched it
last.

**`Update` runs on the host only**, so one client does the write instead of all of them
racing: `UserUpdateBase.ShouldRegister` falls back to `World.HostUser` when `UpdatingUser` is
null and `SkipIfNull` is false, then registers only if that user is local.

`UserUserID` gives the real `U-…` id, not `UserUsername` — a username can change while the id
stays put, so `"U-" + username` would be wrong.

**Writing a scene FIELD takes the proxy pair, same as `DuplicateSlot.Template`.** The obvious
candidate is wrong twice over: `WriteObjectToGlobal<T>.Global` is an `IGlobalValueProxy<T>`,
i.e. a `GlobalValue<T>` component's own value, not a field somewhere in the scene. The real
shape is

```
GlobalReference<[FrooxEngine]FrooxEngine.IValue<string>>   Reference = the UserId FIELD id
  └─ ObjectValueSource<string>                            Source    = that GlobalReference
       └─ ObjectWrite<…FrooxEngineContext,string>          Variable  = that source
```

and `Reference` must be the **field's** id, not the `ContactLink` component's. The
`ObjectValueSource` is also readable, so the same node feeds `IsStringEmpty` for the gate —
no extra node to ask whether the id is already set. Note the write's type argument spells out
the context (`ObjectWrite<[FrooxEngine]FrooxEngine.ProtoFlux.FrooxEngineContext,string>`)
where most bindings elide it; `ValueConditional<T>` and `NotNull<T>` next to it do not.

One chain per `ContactLink` on the card, wired `OnWritten → next`, so all of them are filled
from the one impulse: Editorial has three (name front, photo front, name back).

## Things the engine does that will bite you

Each of these cost a round trip to find, so they are written down:

- **Facing. Get this wrong and things ship mirrored — it has happened twice.**
  `QuadMesh.Facing = Rotation * float3.Backward`, so an identity rotation points a quad
  at −Z and it reads mirrored; `[0,1,0,0]` (the engine's own v1 convention) faces +Z.
  TextRenderer behaves the same way. The rule, in full:

  > An element shows its front to +Z only if its own rotation **times every ancestor's**
  > rotation is 180° about Y. Position is expressed in the PARENT's frame and is *not*
  > affected by the element's own rotation.

  Which reduces to one invariant, now **checked on every build** by `assertFacing` in
  `build_batch.mjs` and again from the decoded bytes by `verify.mjs`:

  > net rotation is 180-about-Y  ⇔  the element sits at z > 0

  Writing the rule down here was not enough — it shipped wrong three times anyway, always
  because a rotation constant was copied from a neighbour sitting at a **different depth**.
  The rule depends on the product of every ancestor's rotation, so it cannot be authored
  locally, which is why it is a build-time assertion rather than a convention. Practical
  consequence: below a face slot exactly ONE 180 must appear between the face and the pixels.
  `px()` supplies it for everything under it (those quads take `ownFlip: UNDER_PX`); a quad
  parented straight to the face supplies its own (`ownFlip: ON_THE_FACE`). `texturedQuad` has
  no default for that argument on purpose.
- **`TextRenderer.Size` is multiplied by `0.1` internally** (`TextRenderer.cs`), so an
  em-height of N px means `Size = N * 10`.
- **`TextUnlitMaterial.BackgroundColor` defaults to opaque black.** Leave it unset and every
  glyph gets a black box behind it.
- **`RenderQueue` defaults to −1 (auto)**, which puts plates and text in the same queue and
  lets view angle decide the winner. Pinned here: plates 3000, graphics 3050, text 3100.
- **Anything alpha-blended belongs at 3000+, never in the opaque queue.** Under 2500 is
  opaque, and the engine's screen-space passes build their depth from the opaque queue, so an
  alpha-blended quad down there writes depth across its WHOLE rectangle — cut-away corners
  included. The sun then reads as occluded by the parts of the object that are not there and
  ghosts a copy of itself at every transparent edge. It looks like god rays and it is a queue
  number. The dispenser's button face was at 2000 and did exactly this.
- **`Uri` fields serialise as a plain string with an `@` prefix** — `"@https://…"`.
- **`SetParent.PreserveGlobalPosition` is `[DefaultValue(true)]`.** Leave that input unbound
  and the reparented slot keeps its WORLD transform — it becomes a child of the hand but
  never moves, then trails it from across the room. Wire an explicit `ValueInput<bool>` =
  false, and the copy snaps into the parent's frame; its LOCAL transform then decides where
  it sits, so the template's own position is the in-hand offset.
- **Reading a scene element into a graph takes a PROXY PAIR, on one slot.**
  `ChangeableSource<E,T>.Source` is a `GlobalRef<E>` — it points at an
  `IGlobalValueProxy`, *not* at the element. So `DuplicateSlot.Template` needs:

  ```
  slot "…source"
    ├─ GlobalReference<Slot>   Reference = the target slot
    └─ ElementSource<Slot>     Source    = the GlobalReference above
  DuplicateSlot.Template       = the ElementSource
  ```

  Aim `ElementSource.Source` straight at the slot and it imports unbound — in-world the
  node shows as **"ChangeableSource"** with an empty `On: ()`, and nothing clones. Same
  shape as the `ValueFieldDrive` + `Proxy` pair. Classpath quirk: `…CoreNodes.ElementSource<…>`
  carries a DOUBLED `FrooxEngine.FrooxEngine`, and its field is `Source`, not `Reference`.
- **An invalid ProtoFlux group stays built but dead**, with no per-node error — one bad field
  kills every node in the connected component. Bisect with a minimal graph rather than
  guessing. Groups derive from wiring; there is no group entity in the file format.
- **`Compression.None` does not load.** `DataTreeConverter` throws on it; only LZ4, LZMA and
  Brotli are accepted, so a browser port still needs a real compressor.
- **Google Fonts serves woff2 to modern user agents and EOT to an IE one.** Only an old
  Android UA yields a plain `.ttf`. `fetchfont.mjs` checks the magic bytes and throws
  rather than shipping a dead font.
- **The card is sized from its LONG edge.** Portrait templates render 620x920 rather than
  1000x625, so scaling from width alone makes them oversized.
- **The two face plates need a gap of ~0.1mm, not more.** They are separate meshes because
  `QuadMesh.DualSided` puts both quads in submesh 0 (`implicit operator TriangleSubmesh`),
  so one material would cover both faces — same texture, back mirrored. `BoxMesh` has the
  same single-submesh limitation. At 0.8mm you can see daylight between the faces; the grab
  collider is decoupled and stays thick.
- **Not every family a card names is on Google Fonts** (templates set system faces like
  Courier New). `fetchfont.mjs` accepts `format('truetype')` URLs as well as `.ttf` ones and
  substitutes mono/serif/sans equivalents rather than failing the build.
- **A text element's rect is its LAYOUT box, not its text.** `getBoundingClientRect` on a
  block-level heading returns the full width of its column — Editorial's back name measures
  920px on a 1000px card. Rendering from that is harmless (the glyphs are aligned inside it)
  but a collider cut to it is a band across the whole face. Take the box the glyphs actually
  occupy: a `Range` over the element's own text nodes, unioned over `getClientRects()`.
- **A touch does not stop at the first collider, and inert geometry cannot shield anything.**
  `RaycastTouchSource.GetTouchable` does a `PortalRaycastAll`, then walks the hits in distance
  order looking for an `ITouchable` above each one, giving up only once a hit is
  `MaxTouchPenetrationDistance` beyond the first — `0.01f` on `InteractionLaser`, `0.05f` by
  default on `TouchSource`. That is 10-50mm through a card whose buttons span 4mm, so neither
  standoff nor a plain collider on the plate keeps a click off the far face. Both were tried;
  both failed.

  What works is a **shield**: a `TouchButton` with no `IButtonPressReceiver` beside it, placed
  at the mirrored footprint of every button on the other face and nearer the card than this
  face's own buttons. It is the first touchable the ray meets there and it does nothing, so
  the far face goes quiet while this face still wins where the two overlap. Shield only the
  far side's footprints — a card-sized one would work too, but then the whole card reads as a
  button. Grabbing is unaffected either way: `InteractionHandler.Grab` works off
  `Laser.CurrentHit`, the nearest collider, not off the touchable, and the root's grab box is
  nearer than any shield.
- **An imported item lands showing its −Z side.** `SlotPositioning.PositionInFrontOfUser`
  gives the spawned slot `rotation = LocalUserViewRotation`, and the view rotation's +Z points
  where you are looking, i.e. away from you. A card whose front faced +Z therefore always
  arrived back-first. The front sits at −Z for that reason.
- **An element screenshot is a CROP OF THE PAGE, not a render of the element.** Anything the
  app paints inside that rectangle comes along, and it shows up exactly where the card is
  meant to be see-through: Ticket's die-cut notches came back filled with whatever editor
  panel sat behind them, on the bottom edge but not the top, because that is where the panel
  happened to be. A transparent page background is not enough — the rest of the page has to
  be hidden outright and the card alone re-shown before the shot.
- **SVG text cannot become a `TextRenderer`** — the seals lay text around a circle with
  `<textPath>`. Those become their own image layer, never baked into the plate. Cloning one
  out for rastering drops inherited opacity, so the effective alpha rides on the tint.

## Credit

`protoflux.mjs` is copied verbatim from
[dalekcoffee/resonite-knowledge-library](https://github.com/dalekcoffee/resonite-knowledge-library)
(`protoflux/skill/scripts/`), where the format itself is documented. Keep it in sync there
rather than editing this copy.
