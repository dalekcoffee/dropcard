# dropcard

VTuber ID card maker for [oshi.social](https://oshi.social) and the wider fediverse.

**→ [dropcard.dalek.coffee](https://dropcard.dalek.coffee)** · v0.0.1 beta

Build a card from 42 templates — laminated IDs, TCG cards, event passes, mixtapes, seed
packets, gold records — then export it as a PNG, a print run from a CSV, or a two-sided card
for [Resonite](https://resonite.com) that you can drag straight into a world: real text, working
links, and an add-contact button on your name and photo.

Paste a Misskey, Sharkey or Mastodon handle and it fills itself in: name, bio, pronouns,
birthday, links, avatar, banner. Your server's custom emoji become pickable oshi marks.

Free, no accounts, no paywall.

## Privacy

Cards are rendered entirely in your browser — what you type never leaves the page. There are
no cookies and no analytics.

Three things reach the network, all only when you ask:

- **Google Fonts is off until you switch it on**, under *Style → Card font*. Requesting a
  typeface hands Google your IP, so dropcard requests nothing until you opt in. Every stack
  falls back to a system face, so cards look right either way.
- **A fediverse instance** is contacted only when you import a handle, and only the one you
  named. The request goes straight from your browser.
- **Exporting for Resonite** downloads the typefaces your card uses, so they can be embedded
  in the package and the text stays readable in world. They come from the Google Fonts
  repository on GitHub. *Export baked* needs no typefaces and makes no requests at all.

The opt-in answer is the only thing kept between visits (`dropcard:google-fonts` in
`localStorage`).

## Repository

`index.html` is the entire application, one self-contained file with no build step and no
dependencies. It is a bundle — a small unpacker inflates gzipped, base64-encoded assets from
inline `<script type="__bundler/*">` blocks — which is why it is ~7 MB and not meaningfully
diffable. The app source lives in a Claude design project; re-export from there rather than
hand-editing the bundle, then re-apply this repo's own edits with `tools/patch/apply.py`.

`tools/resonite/` builds the Resonite export. It is developer tooling and no part of the site.

A push to the default branch is a deploy; GitHub Pages serves the root, and `CNAME` points it
at the custom domain.

## Licence

All rights reserved for now.
