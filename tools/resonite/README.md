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
```

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

## Things the engine does that will bite you

Each of these cost a round trip to find, so they are written down:

- **`QuadMesh.Facing = Rotation * float3.Backward`.** An identity rotation points the quad
  at −Z and it reads mirrored. `[0,1,0,0]` is the engine's own v1 convention. Anything
  parented under a face needs the same treatment or it renders backwards *and* X-mirrored.
- **`TextRenderer.Size` is multiplied by `0.1` internally** (`TextRenderer.cs`), so an
  em-height of N px means `Size = N * 10`.
- **`TextUnlitMaterial.BackgroundColor` defaults to opaque black.** Leave it unset and every
  glyph gets a black box behind it.
- **`RenderQueue` defaults to −1 (auto)**, which puts plates and text in the same queue and
  lets view angle decide the winner. Pinned here: plates 3000, graphics 3050, text 3100.
- **`Uri` fields serialise as a plain string with an `@` prefix** — `"@https://…"`.
- **`Compression.None` does not load.** `DataTreeConverter` throws on it; only LZ4, LZMA and
  Brotli are accepted, so a browser port still needs a real compressor.
- **Google Fonts serves woff2 to modern user agents and EOT to an IE one.** Only an old
  Android UA yields a plain `.ttf`. `fetchfont.mjs` checks the magic bytes and throws
  rather than shipping a dead font.
- **SVG text cannot become a `TextRenderer`** — the seals lay text around a circle with
  `<textPath>`. Those become their own image layer, never baked into the plate. Cloning one
  out for rastering drops inherited opacity, so the effective alpha rides on the tint.

## Credit

`protoflux.mjs` is copied verbatim from
[dalekcoffee/resonite-knowledge-library](https://github.com/dalekcoffee/resonite-knowledge-library)
(`protoflux/skill/scripts/`), where the format itself is documented. Keep it in sync there
rather than editing this copy.
