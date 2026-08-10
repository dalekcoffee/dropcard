# Resonite export

Build tools that turn a rendered dropcard into a `.resonitepackage` — a two-sided card you
can drag into [Resonite](https://resonite.com), plus a dispenser that hands out copies.

The site does this itself now — *Export for Resonite* builds the package in the page. What is
here is the same construction (`scene.mjs`, shared by both), plus the Node driver, the dispenser
builder, and the harnesses that keep the two honest.

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
| `DROPCARD_FONTS=cdn\|repo` | where font bytes come from; `cdn` gives truer weights, `repo` is what the browser uses |
| `DROPCARD_USERID=U-…` | bake a contact id in for testing, instead of leaving it blank |
| `--backing=rounded\|square\|circle\|none` | the dispenser button's shape |
| `--icon=landscape\|vertical\|auto`, `--backing-color=`, `--icon-color=` | its art and colours |

## What the site runs

`browser/` is the in-page path, using nothing a browser lacks: `pack.mjs` (BSON, a Brotli
stream, a zip, SHA-256), `raster.mjs`, `capture.mjs`, `fonts.mjs`, `overlay.mjs`, `button.mjs`,
`encoder.mjs`, `export.mjs` and `ui.mjs`. The card itself is built by `scene.mjs`, which the
Node driver uses too — there is one construction, not two. `badge.mjs` and `colour.mjs` sit
beside it: pure arithmetic, no DOM and no Node, so both paths place and colour the add-contact
button identically.

### The add-contact button

Every exported card carries one. Three templates print their own — VR Social, VR Nameplate and
the VR plate/profile back — and those runs are found by their label and made into real
`ContactLink`s rather than being covered by a second button. Every other template gets a chip
drawn in the card's accent, placed by `badge.mjs`: it searches the face's own measurements for a
corner nothing is drawn in, so no template reserves a spot and none has to be edited when one is
added. The name and the profile picture stay targets either way.

`browser/spots.mjs` sweeps the whole picker and fails if any template ends up with the button
over its text or links. Run it after touching `badge.mjs` or any template's layout.

#### Designing the button in the design project

The drawn chip is a **fallback**, not the intended look for every card. A template that prints
its own button always wins, and that button is designed where the rest of the card is designed —
in the design project, with the template's own type, colour and shape. Nothing here has to
change to add one, and no list has to be updated.

Two ways to make one, both authored entirely in the template's markup:

| | |
| --- | --- |
| **Label it** | An element whose own text is `Add contact` (any case; `Add friend` still matches, for cards made before this). |
| **Mark it** | Any element carrying `data-dc-contact`, whatever it says — `h('div', {'data-dc-contact':'', …}, 'Say hi')`. Use this for an icon-only button, or a label in another language. |

Either way the collider is cut to **that element's own box**, padding and border included, so
give the attribute to the button itself rather than to the text inside it. Put one on a face and
that face's chip disappears; the front decides whether a chip is drawn at all, so a button on the
back does not leave the front without one.

What stays in this repo: the fallback chip's own design (`browser/button.mjs`,
`buildContactBadge`) and where it lands (`badge.mjs`). Those are not reachable from the design
project.

`bundle.mjs` flattens those into `browser/dropcard-resonite.js`, which
`tools/patch/05_resonite_export.py` inlines into `index.html`. **Re-run the bundler before
patching** or the site ships a stale export.

Harnesses, in the order they are worth running:

| | |
| --- | --- |
| `browser/selftest.mjs` | `pack.mjs` round-trips against the Node encoder |
| `browser/parity.mjs` | the same scene through both encoders decodes to identical BSON |
| `browser/compare.mjs` | the in-page raster against Playwright's, pixel by pixel |
| `browser/e2e.mjs [--bundle]` | export from a real tab, then `verify.mjs` the bytes |
| `browser/spots.mjs` | where the add-contact button lands, on every template |
| `browser/bounds.mjs` | exported text has room not to wrap, and has not moved |

`../patch/test_resonite_button.mjs` drives the shipped menu, and
`../patch/test_resonite_panel.mjs` drives the sidebar's Resonite tab through to the bytes.

Browser egress is blocked in some sandboxes, so `e2e.mjs` serves the font host through Node.
Only that hop is stood in for; everything downstream is the real path.

## Provenance

`protoflux.mjs` is a reduced copy of a general-purpose Resonite encoder kept in a private
repository, cut down to the parts dropcard calls. The package format, and the engine
behaviours these builders work around, are documented there rather than here. Fixes made to
this copy — such as the leading-`@` escaping — should be carried back upstream.
