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

node verify_colliders.mjs out/dropcard_info-editorial.resonitepackage
```

`verify_colliders.mjs` decodes a built package and prints every collider in world-space
millimetres, failing if a touchable one straddles the card plane. Run it on anything you are
about to hand someone: collider faults are invisible in a render and only show up when the
card is in someone's hands.

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

## Add-contact (design settled, not built yet)

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
slot: BoxCollider + TouchButton + ContactLink
      TouchButton.IsHovering -> drives the overlay's active state
      TouchButton press      -> ForeachComponent -> ContactLink.Pressed()
```

**Filling in the UserId without asking anyone to type it.** Leave it blank in the export;
on the INSTANCER (never the card), detect the owner and bake the value in once:

```
GetActiveUser / GetUserFromComponent -> UserUserID -> write into the template's ContactLink.UserId
```

The write node is **`WriteObjectToGlobal<string>`** — a real one-shot write, not a drive:

```csharp
public readonly GlobalRef<T> Global;   // proxy pointing at ContactLink.UserId
public ObjectInput<T> Value;
protected override IOperation Run(C ctx) { if (Global.Write(Value.Evaluate(ctx), ctx)) … }
```

`ObjectWrite<T>` is the sibling that writes a graph variable rather than a scene field, and
`DataModelObjectFieldStore<T>` is a graph variable of its own (it holds its own `Value`), so
neither is the one. Gate the write with `FireOnTrue` on "owner is known" so it fires on the
edge and never rewrites.

`UserUserID` gives the real `U-…` id, not `UserUsername` — a username can be changed while
the id stays put, so `"U-" + username` would be wrong. Write it, do **not** drive it: a drive
re-evaluates, so a different user grabbing the card would rewrite the owner. Doing it on the
instancer keeps the card itself inert. The remaining open piece is which one-shot write node
to use.

## Things the engine does that will bite you

Each of these cost a round trip to find, so they are written down:

- **Facing. Get this wrong and things ship mirrored — it has happened twice.**
  `QuadMesh.Facing = Rotation * float3.Backward`, so an identity rotation points a quad
  at −Z and it reads mirrored; `[0,1,0,0]` (the engine's own v1 convention) faces +Z.
  TextRenderer behaves the same way. The rule, in full:

  > An element shows its front to +Z only if its own rotation **times every ancestor's**
  > rotation is 180° about Y. Position is expressed in the PARENT's frame and is *not*
  > affected by the element's own rotation.

  Which gives two opposite cases, and mixing them up is the trap:
  - element carrying its **own** `[0,1,0,0]` → its local z must be **positive** to sit toward
    the viewer (the button label).
  - element **under a parent** carrying `[0,1,0,0]` → its local z must be **negative**,
    because the parent's rotation negates it (the card's text/graphics/links).
- **`TextRenderer.Size` is multiplied by `0.1` internally** (`TextRenderer.cs`), so an
  em-height of N px means `Size = N * 10`.
- **`TextUnlitMaterial.BackgroundColor` defaults to opaque black.** Leave it unset and every
  glyph gets a black box behind it.
- **`RenderQueue` defaults to −1 (auto)**, which puts plates and text in the same queue and
  lets view angle decide the winner. Pinned here: plates 3000, graphics 3050, text 3100.
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
- **Nothing stops a click at the far face.** The two plates are 0.1mm apart and a bare quad
  has no collider, so a click aimed at the front that misses the front's own buttons carries
  on and presses the back's. Two things keep the faces apart, and both are needed: each
  plate carries an inert `BoxCollider` of its own as a backstop, and every touch collider
  stands off far enough that `DEPTH < 2 * Z` — a build-time assertion in `build_batch.mjs`.
  Standoff alone is not enough, because a physical touch resolves by proximity rather than by
  a ray and will happily reach the nearer of two colliders a millimetre apart.
- **SVG text cannot become a `TextRenderer`** — the seals lay text around a circle with
  `<textPath>`. Those become their own image layer, never baked into the plate. Cloning one
  out for rastering drops inherited opacity, so the effective alpha rides on the tint.

## Credit

`protoflux.mjs` is copied verbatim from
[dalekcoffee/resonite-knowledge-library](https://github.com/dalekcoffee/resonite-knowledge-library)
(`protoflux/skill/scripts/`), where the format itself is documented. Keep it in sync there
rather than editing this copy.
