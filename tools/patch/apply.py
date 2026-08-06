#!/usr/bin/env python3
"""Re-apply dropcard's repo-side edits to a fresh design-project export.

The app is authored in a Claude design project and exported as one ~7 MB bundled
index.html: a small unpacker plus gzipped, base64-encoded assets, with the page itself
stored as a JSON string. That file is **not diffable** — a re-export changes essentially
every byte — so the repo's own changes cannot be merged in the usual sense. They are
re-applied instead.

    python3 tools/patch/apply.py <fresh-export.html> -o index.html

Each step is exact-string matching with a count assertion. If the design project moves the
code an anchor sits on, the step FAILS LOUDLY rather than silently skipping. That is the
whole point: a silently skipped patch here ships the XSS fix or the Google Fonts opt-in
missing, with no visible symptom.

Steps, in order:
  01  brand + head   OshiCard -> dropcard; title, description, canonical, OG/Twitter tags
  02  fonts          Google Fonts off until opted in (a raw export always fetches on load)
  03  sanitize       fediverse import: DOMParser bio stripping, URL and host allowlists

Afterwards, run the verification in tools/patch/README.md. Eyeballing is not enough — the
font gate and the sanitizers both have browser tests, and both failures are invisible.
"""
import argparse
import pathlib
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).parent
STEPS = [
    ("01_brand_and_head.py", "brand + page identity"),
    ("02_google_fonts_optin.py", "Google Fonts opt-in"),
    ("03_sanitize_import.py", "fediverse input sanitization"),
]
# a cheap "has this already been patched?" probe — added by step 03
ALREADY = "const SAFE_URL"


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("export", help="fresh index.html exported from the design project")
    ap.add_argument("-o", "--out", help="where to write (default: overwrite the input)")
    args = ap.parse_args()

    src = pathlib.Path(args.export)
    if not src.is_file():
        sys.exit(f"no such file: {src}")
    out = pathlib.Path(args.out) if args.out else src

    text = src.read_text(encoding="utf-8", errors="replace")
    if '<script type="__bundler/template">' not in text:
        sys.exit("not a bundled export: no __bundler/template block found")
    if ALREADY in text:
        sys.exit("this file already looks patched (found SAFE_URL) — patch the RAW export, "
                 "not an already-patched one")

    if out != src:
        shutil.copyfile(src, out)

    print(f"patching {out}  ({out.stat().st_size / 1e6:.1f} MB)")
    for script, label in STEPS:
        print(f"\n== {label} ==")
        r = subprocess.run([sys.executable, str(HERE / script), str(out)],
                           capture_output=True, text=True)
        sys.stdout.write(r.stdout)
        if r.returncode != 0:
            sys.stderr.write(r.stderr)
            sys.exit(f"\nFAILED at '{label}'. The export likely moved the code this step "
                     f"anchors on — re-anchor {script} against the new export rather than "
                     f"skipping it.")

    print(f"\nall {len(STEPS)} steps applied -> {out}")
    print("now verify: see tools/patch/README.md (font gate + XSS payloads have real tests)")


if __name__ == "__main__":
    main()
