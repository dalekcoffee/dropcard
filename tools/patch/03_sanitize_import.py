import re, json, pathlib

import sys
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

# ── 1. the helpers, next to the existing URL utilities ───────────────────────
sub("const bareU = u => String(u||'').trim().replace(/^@+/,'');",
"""/* Everything below this line can arrive from a stranger's profile on a server we don't
   control, so it gets treated as hostile until proven otherwise.
   SAFE_URL: absolute http(s) only — javascript:, data:, vbscript: and relative junk all
   collapse to ''. Used for anything that becomes an href or an <img src>.
   SAFE_HOST: a bare hostname, so a crafted handle can't reshape the API request path. */
const SAFE_URL = (u) => { const s = String(u == null ? '' : u).trim();
  if (!/^https?:\\/\\//i.test(s)) return '';
  try { const p = new URL(s); return (p.protocol === 'http:' || p.protocol === 'https:') ? p.href : ''; }
  catch (e) { return ''; } };
const SAFE_HOST = (h) => { const s = String(h == null ? '' : h).trim().toLowerCase();
  return /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(s) && s.includes('.') ? s : ''; };
const bareU = u => String(u||'').trim().replace(/^@+/,'');""",
"SAFE_URL / SAFE_HOST helpers")

# ── 2. bio stripping: an inert document instead of a live detached subtree ────
sub("""_txt(v){ if(v==null) return ''; const d=document.createElement('div');
    // paragraph and break boundaries carry no character, so the words either side would run together
    d.innerHTML=String(v).replace(/<\\s*(br|\\/p|\\/div|\\/li|\\/h[1-6])\\s*\\/?\\s*>/gi,'$& ');
    return (d.textContent||'').replace(/\\s+/g,' ').trim(); }""",
"""/* Bios are attacker-controlled HTML (Mastodon's `note`, Misskey's `description`). Assigning
     that to a detached div still builds real elements, so an <img onerror> can fire even though
     <script> wouldn't. DOMParser gives an inert document — no browsing context, no loads. */
  _txt(v){ if(v==null) return '';
    // paragraph and break boundaries carry no character, so the words either side would run together
    const html=String(v).replace(/<\\s*(br|\\/p|\\/div|\\/li|\\/h[1-6])\\s*\\/?\\s*>/gi,'$& ');
    const doc=new DOMParser().parseFromString(html,'text/html');
    return (doc.body ? doc.body.textContent||'' : '').replace(/\\s+/g,' ').trim(); }""",
"_txt uses DOMParser")

# ── 3. a profile field can carry href="javascript:..." just as easily as https ──
sub("""_href(v){ const m=String(v==null?'':v).match(/href="([^"]+)"/i); return m?m[1]:''; }""",
"""_href(v){ const m=String(v==null?'':v).match(/href="([^"]+)"/i); return m?SAFE_URL(m[1]):''; }""",
"_href scheme allowlist")

# ── 4. remote image sources ───────────────────────────────────────────────────
sub("birthday:u.birthday, avatar:u.avatarUrl, banner:u.bannerUrl, emojis:u.emojis,",
    "birthday:u.birthday, avatar:SAFE_URL(u.avatarUrl), banner:SAFE_URL(u.bannerUrl), emojis:u.emojis,",
    "misskey avatar/banner")
sub("birthday:'', avatar:a.avatar_static||a.avatar, banner:a.header_static||a.header, emojis:a.emojis,",
    "birthday:'', avatar:SAFE_URL(a.avatar_static||a.avatar), banner:SAFE_URL(a.header_static||a.header), emojis:a.emojis,",
    "mastodon avatar/banner")
sub("if(e.shortcode&&e.url) out.push({name:e.shortcode,url:e.url,category:e.category});",
    "if(e.shortcode&&SAFE_URL(e.url)) out.push({name:e.shortcode,url:SAFE_URL(e.url),category:e.category});",
    "mastodon emoji urls")
sub("if(e.name&&e.url) out.push({name:e.name,url:e.url,category:e.category});",
    "if(e.name&&SAFE_URL(e.url)) out.push({name:e.name,url:SAFE_URL(e.url),category:e.category});",
    "misskey emoji urls")

# ── 5. the host we're about to build an API URL from ─────────────────────────
sub("""else { const m=raw.match(/^@?([^@\\s]+)@([^@\\s]+)$/); if(m){ user=m[1]; host=m[2]; } }""",
    """else { const m=raw.match(/^@?([^@\\s]+)@([^@\\s]+)$/); if(m){ user=m[1]; host=SAFE_HOST(m[2]); } }""",
    "parseHandle host")

enc = json.dumps(tpl, ensure_ascii=False).replace("</", "<\\u002F")
pathlib.Path(P).write_text(src[:m.start(2)] + enc + src[m.end(2):], encoding="utf-8")
print("written")
