# dropcard

VTuber ID card maker for [oshi.social](https://oshi.social) and the wider fediverse.

**Live:** https://dropcard.dalek.coffee
**Version:** 0.0.1 beta

Build a VTuber ID card from 42 templates — laminated IDs, TCG cards, event
passes, mixtapes, seed packets, gold records — then export it as a PNG or as a
two-sided business card for [Resonite](https://resonite.com).

## What it does

- **Import from the fediverse.** Paste a Misskey, Sharkey or Mastodon handle and
  the card fills itself in — name, bio, pronouns, birthday, links, avatar and
  banner. Your server's custom emoji become pickable oshi marks.
- **42 templates**, landscape and portrait, each with its own material, die cut,
  typeface, background field and matching reverse.
- **Oshi marks.** One glyph — built-in or a server emoji — drives the background
  field, confetti, seals and bullets across the whole card.
- **Auto-fit.** Cards measure themselves and only shrink their type when content
  genuinely overflows, so nothing gets clipped and nothing is small for no reason.
- **Event passes** with fourteen access tiers, colour-coded stripes and a punched
  lanyard slot.
- **Batch export** from a CSV — one row per card, blank cells inherit the current
  design. Built for printing a run of passes.
- **Resonite export**, standard (every element editable in game) or baked (one
  flattened sheet).

## Repository layout

| Path          | What it is                                                    |
| ------------- | ------------------------------------------------------------- |
| `index.html`  | The entire application — one self-contained file               |
| `favicon.svg` | Site icon                                                      |
| `CNAME`       | Points GitHub Pages at `dropcard.dalek.coffee`                 |
| `.nojekyll`   | Stops Pages from running the file through Jekyll               |

There is no build step, no package manager and no dependencies to install.
`index.html` ships as a bundle: a small unpacker in the `<head>` inflates
gzipped, base64-encoded assets — React, the fonts, the icon set — from inline
`<script type="__bundler/*">` blocks, then swaps the real document in. That is
why the file is ~7 MB and why it is not meaningfully diffable.

Nothing is fetched from a third party unless you ask for it:

- **Google Fonts** is **off until you switch it on.** The card typefaces live on
  Google's servers, and requesting one hands Google the visitor's IP, so
  dropcard asks for nothing until someone opts in under *Style → Card font*.
  Every stack falls back to a system face, so cards look right either way.
  Switching it back off removes the stylesheet links and stops any further
  requests.
- **Fediverse instances** are contacted only when you import a handle, and only
  the instance you named. The request goes straight from your browser — nothing
  proxies it.

Everything else, including React, is inlined and works offline.

The opt-in answer is the one thing kept between visits, under the
`dropcard:google-fonts` key in `localStorage`. Nothing else is stored, there are
no cookies, and no analytics of any kind. Cards are rendered and exported
entirely in the browser — what you type never leaves the page.

## Local preview

Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000   # then visit http://localhost:8000
```

## Deploying

The site is served straight from the default branch — a push to `main` is a
deploy.

1. **Settings → Pages → Build and deployment**, source *Deploy from a branch*,
   branch `main`, folder `/ (root)`.
2. Under **Custom domain**, enter `dropcard.dalek.coffee`. `CNAME` already
   declares it, so Pages should pick it up on its own.
3. Add the DNS record at the `dalek.coffee` registrar:

   | Type    | Name       | Value                   |
   | ------- | ---------- | ----------------------- |
   | `CNAME` | `dropcard` | `dalekcoffee.github.io` |

4. Once the domain verifies, tick **Enforce HTTPS**.

DNS can take up to an hour to propagate; until it does, Pages also serves the
site at `dalekcoffee.github.io/dropcard`.

## Editing

The app source lives in the Claude design project, not in this repository —
`index.html` here is the exported build. Re-export from the design project to
update the site, rather than hand-editing the bundle.

## Licence

All rights reserved for now.
