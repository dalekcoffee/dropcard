"""A Resonite panel in the sidebar, and an add-contact button on every card.

The export's own settings had nowhere to live. "Card back" sat under Layout with a note saying
it was for Resonite, the add-contact button had no switch at all, and everything else about the
export was decided in the two-item menu above the preview. This gives them a rail tab of their
own — the same grouping every other kind of option already has.

Three edits:

1. **The templates that drew an add-friend button say "add contact" instead.** VR Social, VR
   Nameplate and the VR plate/profile back each print one; they were decoration. scene.mjs finds
   a run labelled add friend OR add contact and makes it a real ContactLink, so either wording
   works in world — but the card should say what the button does, and "contact" is the word
   Resonite itself uses.

2. **A Resonite tab**, holding the card back (moved out of Layout, where it never belonged) and
   the add-contact settings: whether to include the button, and which corner it takes.

3. **The export handler passes them through.** Both menu items go through resExport, so standard
   and baked pick the settings up together.

Runs after 05, which is what puts resExport there in the first place.
"""
import re, json, pathlib, sys

P = sys.argv[1]
src = pathlib.Path(P).read_text(encoding="utf-8")

m = re.search(r'(<script type="__bundler/template">\s*)(.*?)(\s*</script>)', src, re.S)
tpl = json.loads(m.group(2))


def sub(old, new, why, count=1):
    global tpl
    n = tpl.count(old)
    assert n == count, f"{why}: expected {count} match(es), found {n}"
    tpl = tpl.replace(old, new)
    print(f"  ✓ {why}")


# ── 1. the buttons the templates already drew ────────────────────────────────
sub("['ADD FRIEND','INVITE']", "['ADD CONTACT','INVITE']",
    "VR nameplate and VR profile back say add contact", count=2)
sub("'Add Friend'", "'Add contact'", "VR social says add contact")

# ── 2. the rail tab ──────────────────────────────────────────────────────────
sub("""  { id:'Links',   name:'Links',   icon:'ph ph-link',            title:'Socials, tip jars and sites' },""",
    """  { id:'Links',   name:'Links',   icon:'ph ph-link',            title:'Socials, tip jars and sites' },
  { id:'Resonite',name:'Resonite',icon:'ph ph-cube',            title:'Card back and add-contact button' },""",
    "Resonite tab in the rail")

CARD_BACK = """<section style="margin-bottom:26px">
        <h6 style="margin:0 0 4px">Card back <span class="text-muted" style="font-weight:400;text-transform:none;letter-spacing:0;font-size:11px">— for Resonite business cards</span></h6>
        <p class="text-muted" style="font-size:12px;margin:0 0 10px">Pick a back design, then use <b style="color:var(--color-neutral-200);font-weight:600">Export for Resonite</b> — standard keeps every element editable in game, baked merges them so the card cannot be changed. Toggle Front / Back above the preview to see it.</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <sc-for list="{{ backChoices }}" as="bk" hint-placeholder-count="4">
            <button sc-camel-on-click="{{ bk.onPick }}" style="{{ bk.style }}"><i class="{{ bk.icon }}" style="font-size:17px"></i><span style="font-size:13px;font-weight:600">{{ bk.name }}</span></button>
          </sc-for>
        </div>
      </section>"""

# lift it out of Layout — it is a Resonite setting and now has somewhere to be
sub("\n\n      " + CARD_BACK + "\n", "\n", "card back leaves the Layout tab")

PANEL = """      <sc-if value="{{ tabResonite }}" hint-placeholder-val="{{ false }}">
      """ + CARD_BACK + """

      <section style="margin-bottom:26px">
        <h6 style="margin:0 0 4px">Add contact button</h6>
        <p class="text-muted" style="font-size:12px;margin:0 0 10px">Exported cards carry a button that adds you as a contact in Resonite. Templates that already print one have that made to work; the rest get a small chip in the card's own colours. Your name and your photo are always targets too.</p>
        <label class="seg-opt" style="margin-bottom:12px"><input type="checkbox" checked="{{ resContact }}" sc-camel-on-change="{{ onResContact }}">Include the button</label>
        <sc-if value="{{ resContact }}" hint-placeholder-val="{{ true }}">
          <div class="field">
            <label>Where it sits</label>
            <sc-raw-select class="input" value="{{ resSpot }}" sc-camel-on-change="{{ onResSpot }}" style="width:100%">
              <sc-for list="{{ resSpotChoices }}" as="sp" hint-placeholder-count="5"><option value="{{ sp.value }}">{{ sp.label }}</option></sc-for>
            </sc-raw-select>
            <p class="text-muted" style="font-size:11px;margin:6px 0 0;line-height:1.5">Automatic takes the emptiest corner of the front. A corner you pick is honoured as closely as the card's own contents allow — the button never covers your text or your links.</p>
          </div>
        </sc-if>
      </section>

      </sc-if>

"""
sub("""      <sc-if value="{{ tabBatch }}" hint-placeholder-val="{{ false }}">""",
    PANEL + """      <sc-if value="{{ tabBatch }}" hint-placeholder-val="{{ false }}">""",
    "Resonite panel markup")

sub("""      tabCard:this.curTab()==='Card',     tabBatch:this.curTab()==='Batch',""",
    """      tabCard:this.curTab()==='Card',     tabBatch:this.curTab()==='Batch',
      tabResonite:this.curTab()==='Resonite',
      /* Default ON, and stored as "not off" so a card made before this existed still exports
         with a button. The spot is a preference, not a promise: badge.mjs honours it as far as
         the card's own contents allow and falls back to whatever corner is actually free. */
      resContact:s.resContact!==false, onResContact:e=>this.setState({resContact:e.target.checked}),
      resSpot:s.resSpot||'auto', onResSpot:e=>this.setState({resSpot:e.target.value}),
      resSpotChoices:[{value:'auto',label:'Automatic'},{value:'bottom-right',label:'Bottom right'},
        {value:'bottom-left',label:'Bottom left'},{value:'top-right',label:'Top right'},
        {value:'top-left',label:'Top left'}],""",
    "Resonite panel state")

# ── 3. through to the exporter ───────────────────────────────────────────────
sub("""    const go=()=>api.downloadWithStatus({ bake:baked, template:name,
        fields:{ Name:F.name, Nickname:F.nickname } })""",
    """    const go=()=>api.downloadWithStatus({ bake:baked, template:name,
        addContact:this.state.resContact!==false, contactSpot:this.state.resSpot||'auto',
        fields:{ Name:F.name, Nickname:F.nickname } })""",
    "add-contact settings reach the export")

enc = json.dumps(tpl, ensure_ascii=False).replace("</", "<\\u002F")
src = src[: m.start(2)] + enc + src[m.end(2) :]
pathlib.Path(P).write_text(src, encoding="utf-8")
print("written")
