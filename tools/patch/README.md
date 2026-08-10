# Re-applying repo edits to a fresh export

The app is authored in a Claude design project and exported as one ~7 MB bundled
`index.html`. That file is **not diffable** — the page lives inside it as a single
JSON-encoded string, so a re-export changes essentially every byte. Git can tell you *that*
it changed, never *what* changed.

So the repo's own edits are not merged. They are **re-applied**:

```sh
# 1. export a fresh index.html from the design project
# 2. re-apply everything this repo adds
python3 tools/patch/apply.py ~/Downloads/index.html -o index.html
# 3. verify (see below) — then commit
```

## Why not just edit the bundle and skip the design project

You can, and that is what happened for the first few rounds. It does not survive: the next
export from the design project silently reverts every one of these edits, and the failures
are invisible — the site still loads, still looks right, and is quietly missing the XSS
fix and calling Google on every page load again.

## What gets re-applied

| Step | What | Why it can't live in the design project |
| --- | --- | --- |
| `01_brand_and_head.py` | OshiCard → dropcard; `<title>`, description, canonical, theme colour, OG/Twitter | Export ships no `<title>` at all |
| `02_google_fonts_optin.py` | Google Fonts off until opted in | A raw export fetches from Google on load, before any interaction |
| `03_sanitize_import.py` | `DOMParser` bio stripping; URL + host allowlists on fediverse import | Security fix |
| `04_import_keeps_defaults.py` | an import fills what it can and leaves the rest on its sample | Behaviour the export does not ship |
| `05_resonite_export.py` | the Export for Resonite menu builds a real `.resonitepackage` | Needs `tools/resonite/browser/dropcard-resonite.js` inlined |
| `06_link_urls.py` | an absolute link value is the href; Misskey fields peel to a handle | Bug fix |
| `07_resonite_panel.py` | a Resonite rail tab; every template's card gets an add-contact button | Panel + template wording |

## It fails loudly on purpose

Every edit is an exact-string match with a count assertion. If the design project moves the
code an anchor sits on, the step **exits non-zero and names the anchor** instead of skipping
it. Re-anchor the step against the new export — do not remove the assertion.

That is the whole design. A silently skipped patch here ships a security regression that
nothing else would catch.

## Verify after patching

Do not trust "it looks fine". Both of the risky patches have real tests:

```sh
npx http-server -p 8899 -s .      # serve the patched build

# font gate: expect 0 requests to fonts.googleapis.com before opting in,
# >0 after, and the choice to survive a reload in both directions
# xss: expect NOTHING to execute for javascript:, data:text/html, vbscript:,
# <img onerror>, <svg onload>, <iframe javascript:>
```

The harnesses used for those live in the session scratch rather than here; if you need them
again, ask and they can be committed properly.

## Provenance

`apply.py` is verified to reproduce the shipped `index.html` **byte for byte** from the
original raw export. If you change a step, re-run that check before committing.
