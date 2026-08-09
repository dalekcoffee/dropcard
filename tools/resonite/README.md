# Resonite export

Build tools that turn a rendered dropcard into a `.resonitepackage` — a two-sided card you
can drag into [Resonite](https://resonite.com), plus a dispenser that hands out copies.

Not part of the site build. `index.html` ships without any of this.

## Running it

The builders read the *rendered* card out of a real browser rather than reimplementing the
templates, so the site has to be served locally first:

```sh
npx http-server -p 8899 -s ../..      # serve the repo root
npm install

node batch.mjs                        # capture several templates in one browser session
node build_batch.mjs                  # → out/, one package per captured template
node build_instancer.mjs info-ticket  # → out/dropcard_dispenser.resonitepackage

node verify.mjs out/dropcard_info-ticket.resonitepackage
```

Always run `verify.mjs` on anything you are about to hand someone. It catches the faults that
are invisible in a render and only show up once the card is in front of you in VR.

### Options

| | |
| --- | --- |
| `DROPCARD_FONTS=cdn\|repo` | where font bytes come from; `cdn` gives truer weights |
| `DROPCARD_USERID=U-…` | bake a contact id in for testing, instead of leaving it blank |
| `--backing=rounded\|square\|circle\|none` | the dispenser button's shape |
| `--icon=landscape\|vertical\|auto`, `--backing-color=`, `--icon-color=` | its art and colours |

`browser/` holds the dependency-free port — `pack.mjs` writes a package using only browser
primitives, `raster.mjs` rasterises the card in-page, and `selftest.mjs` / `compare.mjs` check
each against the Node output. Not wired into the site yet.

## Provenance

`protoflux.mjs` is a reduced copy of a general-purpose Resonite encoder kept in a private
repository, cut down to the parts dropcard calls. The package format, and the engine
behaviours these builders work around, are documented there rather than here. Fixes made to
this copy — such as the leading-`@` escaping — should be carried back upstream.
