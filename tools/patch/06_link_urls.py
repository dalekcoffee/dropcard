"""A link that is already a URL is not a handle.

Reported from Resonite: the Twitch chip on an imported card opened
`https://twitch.tv/https://twitch.tv/dalekcoffee`. Two faults stacked up.

1. Every preset builds its href by pasting the stored value onto a base —
   `url: u => 'https://twitch.tv/' + bareU(u)` — and `bareU` only strips a leading '@'. Hand it
   an absolute URL and it prefixes one URL with another. A few presets (youtube, soundcloud,
   carrd) already guarded against this; the rest did not. Guarding once at the point the href is
   built covers every preset, including any added later.

2. A Misskey/Sharkey profile field goes into the card verbatim, while the Mastodon path runs the
   same value through `_handle()`, which peels the site off a URL and leaves the handle. So an
   import from oshi.social — which runs Sharkey — stored the whole URL where a handle belonged.
   That is where the absolute URL came from, and it is also why the chip read
   "https://twitch.tv/dalekcoffee" instead of "dalekcoffee".

Fixing only the second would leave anyone who pastes a full URL into the field with a broken
link, so both are fixed.

This was invisible until the Resonite export made the hrefs real: on the web the chips are not
anchors, so nothing ever followed one.
"""
import re, json, pathlib, sys

P = sys.argv[1]
src = pathlib.Path(P).read_text(encoding="utf-8")
m = re.search(r'(<script type="__bundler/template">\s*)(.*?)(\s*</script>)', src, re.S)
tpl = json.loads(m.group(2))


def sub(old, new, why):
    global tpl
    n = tpl.count(old)
    assert n == 1, f"{why}: expected 1 match, found {n}"
    tpl = tpl.replace(old, new)
    print(f"  ✓ {why}")


# ── 1. never prefix something that is already absolute ───────────────────────
sub(
    """        return { key:l.key, icon:meta.icon, value, label:l.label||'', text, url: value?meta.url(value):'' }; })""",
    """        /* A value that is already an absolute URL is the href — the presets build one by
           pasting a handle onto a base, so letting one through would produce
           https://twitch.tv/https://twitch.tv/name. Guarded here rather than in each preset so
           it holds for every network, including ones added later. */
        const abs = /^https?:\\/\\//i.test(value);
        return { key:l.key, icon:meta.icon, value, label:l.label||'', text,
                 url: value ? (abs ? value : meta.url(value)) : '' }; })""",
    "an absolute value is used as the href, not prefixed",
)

# ── 2. Misskey profile fields get the same treatment Mastodon's already get ──
sub(
    """        return { soft:'misskey', name:u.name, username:u.username, about:this._txt(u.description),
          birthday:u.birthday, avatar:SAFE_URL(u.avatarUrl), banner:SAFE_URL(u.bannerUrl), emojis:u.emojis,
          fields:(u.fields||[]).map(f=>({name:f.name||'', value:(f.value||'').trim()})) }; }""",
    """        return { soft:'misskey', name:u.name, username:u.username, about:this._txt(u.description),
          birthday:u.birthday, avatar:SAFE_URL(u.avatarUrl), banner:SAFE_URL(u.bannerUrl), emojis:u.emojis,
          // _handle peels the site off a URL and leaves the handle, which is what the card wants
          // to show and what the link presets expect. The Mastodon branch already did this; a
          // Sharkey profile field was going in verbatim, so oshi.social imports stored whole URLs.
          fields:(u.fields||[]).map(f=>({name:f.name||'', value:this._handle((f.value||'').trim())})) }; }""",
    "Misskey profile fields peel a URL down to a handle",
)

enc = json.dumps(tpl, ensure_ascii=False).replace("</", "<\\u002F")
pathlib.Path(P).write_text(src[: m.start(2)] + enc + src[m.end(2) :], encoding="utf-8")
print("written")
