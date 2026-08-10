"""Import fills what it can and leaves the rest alone.

A fediverse profile carries a name, a bio, an avatar and maybe a few link fields. It carries
nothing at all about what you stream, what you dislike, or your favourite season. The import
used to CLEAR every slot the profile couldn't speak to — so importing a handle emptied the
Language, Pronouns, I Stream, I Dislike and My Favorites panels, leaving blank boxes on the
card with no hint that anything belonged in them.

That clearing existed for one real reason: Mastodon carries pronouns, birthday and links only
in free-form profile fields, and those are read AFTER this point using "is the slot empty?" as
the test for whether they may fill it. Wiping the samples first made every slot look free.

So the wipe is removed and that test is widened instead — from "empty" to "empty or still the
sample we shipped", which `blank()` already answers. A profile field still wins over a
placeholder; a placeholder now survives when there is nothing to replace it with.

Sample LINKS are the one thing still cleared. The rest of the placeholder data is inert — nobody
acts on "Season: Fall" — but a leftover twitch.tv/SampleVT is a claim about where to find
someone, and it is one a reader could follow to the wrong place.
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


# ── 1. stop emptying the slots the profile has nothing to say about ──────────
sub(
    """      if(u.about) F.about=u.about; else if(blank('about')) F.about='';
      if(u.birthday){ const b=String(u.birthday).split('-'); if(b.length===3) F.birthday=(+b[1])+'/'+(+b[2]); }
      else if(blank('birthday')) F.birthday='';
      if(blank('pronouns')) F.pronouns=''; if(blank('languages')) F.languages='';
      if(blank('role')) F.role=''; if(blank('motto')) F.motto='';
      if(blank('streams')) F.streams=''; if(blank('dislikes')) F.dislikes='';
      Object.keys(F.fav||{}).forEach(k=>{ const v=String(F.fav[k]||'').trim();
        if(!v||v===String((SAMPLE_FIELDS.fav||{})[k]||'').trim()) F.fav[k]=''; });
      F.links=F.links.filter(l=>!sampleLink(l.key,(l.value||'').trim()));""",
    """      /* Import is additive. A profile knows your name and bio; it knows nothing about what
         you stream or your favourite season, and "the profile was silent" is not the same as
         "you wanted this empty" — clearing those slots would leave blank panels on the card
         with nothing to say what belongs in them. Anything the import can't speak to keeps
         the sample it already held, so it stays visible and obviously yours to edit. */
      if(u.about) F.about=u.about;
      if(u.birthday){ const b=String(u.birthday).split('-'); if(b.length===3) F.birthday=(+b[1])+'/'+(+b[2]); }
      /* Links are the one exception, and they go. A leftover "Season: Fall" reads as a
         placeholder nobody would act on; a leftover twitch.tv/SampleVT reads as a claim about
         where to find you, and it is one someone could actually follow. Whatever the profile
         does supply is added back a few lines down. */
      F.links=F.links.filter(l=>!sampleLink(l.key,(l.value||'').trim()));""",
    "import no longer clears unfilled fields, except sample links",
)

# ── 2. a profile field must still beat a placeholder ─────────────────────────
# Now that samples survive, "!F.x" no longer means "nothing here yet" — it is false for every
# slot holding a sample, which would lock Mastodon's profile fields out of the very slots they
# are the only source for. blank() is the test that was always meant: empty, or still ours.
sub(
    """        if(n.includes('pronoun')&&!F.pronouns) F.pronouns=val;
        else if((n.includes('birth')||n.includes('bday'))&&!F.birthday) F.birthday=val;
        else if(n.includes('lang')&&!F.languages) F.languages=val;
        else if(/^(role|title|job|what i do)$/.test(n)&&!F.role) F.role=val;
        else if(/^(motto|tagline|catchphrase)$/.test(n)&&!F.motto) F.motto=val;""",
    """        if(n.includes('pronoun')&&blank('pronouns')) F.pronouns=val;
        else if((n.includes('birth')||n.includes('bday'))&&blank('birthday')) F.birthday=val;
        else if(n.includes('lang')&&blank('languages')) F.languages=val;
        else if(/^(role|title|job|what i do)$/.test(n)&&blank('role')) F.role=val;
        else if(/^(motto|tagline|catchphrase)$/.test(n)&&blank('motto')) F.motto=val;""",
    "profile fields overwrite samples, not just blanks",
)

enc = json.dumps(tpl, ensure_ascii=False).replace("</", "<\\u002F")
pathlib.Path(P).write_text(src[: m.start(2)] + enc + src[m.end(2) :], encoding="utf-8")
print("written")
