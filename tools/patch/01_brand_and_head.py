import re, json, sys, pathlib

import sys
SRC = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else sys.argv[1]

src = pathlib.Path(SRC).read_text(encoding="utf-8")

m = re.search(r'(<script type="__bundler/template">\s*)(.*?)(\s*</script>)', src, re.S)
assert m, "template block not found"
tpl = json.loads(m.group(2))

# ---- brand renames (user-visible strings only; CSS class prefixes left alone) ----
renames = [
    ("\n      OshiCard\n",            "\n      dropcard\n"),
    ("'OSHICARD'",                    "'DROPCARD'"),
    ("'OSHICARD · VTUBER ID'",   "'DROPCARD · VTUBER ID'"),
    ("'oshi-batch-template.csv'",     "'dropcard-batch-template.csv'"),
    ("'oshi-card'",                   "'dropcard'"),
]
for old, new in renames:
    n = tpl.count(old)
    assert n == 1, f"expected 1 occurrence of {old!r}, found {n}"
    tpl = tpl.replace(old, new)

# ---- head metadata ----
TITLE = "dropcard — VTuber ID card maker"
DESC = ("Build a VTuber ID card from 42 templates, import your profile from Misskey, "
        "Sharkey or Mastodon, and export it as a PNG or a two-sided Resonite business card.")
URL = "https://dropcard.dalek.coffee/"

META = f'''<title>{TITLE}</title>
<meta name="description" content="{DESC}">
<link rel="canonical" href="{URL}">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<meta name="theme-color" content="#161826">
<meta property="og:type" content="website">
<meta property="og:site_name" content="dropcard">
<meta property="og:url" content="{URL}">
<meta property="og:title" content="{TITLE}">
<meta property="og:description" content="{DESC}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="{TITLE}">
<meta name="twitter:description" content="{DESC}">
'''

anchor = '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
assert tpl.count(anchor) == 1, "viewport anchor not unique in template"
tpl = tpl.replace(anchor, anchor + META)

# Re-encode. The bundler escapes "</script>" as "</script>" inside the JSON string
# so the payload can't terminate its own host <script> tag; preserve that invariant.
enc = json.dumps(tpl, ensure_ascii=False).replace("</", "<\\u002F")
src = src[:m.start(2)] + enc + src[m.end(2):]

# ---- wrapper <head>: what crawlers and the pre-unpack tab actually see ----
assert src.count("<title>Bundled Page</title>") == 1
src = src.replace("<title>Bundled Page</title>", META.strip())

pathlib.Path(OUT).write_text(src, encoding="utf-8")
print("wrote", OUT, len(src), "bytes")
