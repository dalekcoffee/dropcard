"""A Resonite panel in the sidebar, and an add-contact button on every card.

The add-contact button had no switch at all — everything about the export was decided in the
two-item menu above the preview. This gives it a rail tab of its own, the same grouping every
other kind of option already has.

Three edits:

1. **The templates that drew an add-friend button say "add contact" instead.** VR Social, VR
   Nameplate and the VR plate/profile back each print one; they were decoration. scene.mjs finds
   a run labelled add friend OR add contact and makes it a real ContactLink, so either wording
   works in world — but the card should say what the button does, and "contact" is the word
   Resonite itself uses.

2. **A Resonite tab** holding the add-contact settings: whether to include the button, and which
   corner it takes. Card back stays under Layout, where it has always been — it is picked while
   you are choosing the card's shape, not while you are setting up an export.

3. **The export handler passes them through, and the preview shows the result.** Both menu items
   go through resExport, so standard and baked pick the settings up together; and
   componentDidUpdate hands the same two settings to the preview overlay, so where the button
   goes and what it looks like is visible before anything is exported.

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


def rename(old, new, why):
    """A rename the design project may have already made.

    Unlike sub(), this one is allowed to find nothing — the point of the step is that the
    templates end up saying "add contact", and an export where they already do has satisfied it.
    Failing there would block every future export for having taken the fix upstream, which is
    backwards. What it will not tolerate is finding NEITHER wording: that means the button was
    renamed to something the exporter cannot recognise, and the card would ship with a button
    that does nothing.
    """
    global tpl
    n = tpl.count(old)
    if n:
        tpl = tpl.replace(old, new)
        print(f"  ✓ {why} ({n})")
        return
    have = tpl.count(new)
    if not have:
        sys.exit(f"{why}: found neither {old!r} nor {new!r}.\n"
                 f"  If a template's add-contact button was renamed, the exporter needs to be able\n"
                 f"  to find it: label it 'Add contact' (or 'Add friend'), or mark the element with\n"
                 f"  a data-dc-contact attribute, which works whatever it says.")
    print(f"  · {why} — already says so in the export ({have})")


# ── 1. the buttons the templates already drew ────────────────────────────────
rename("['ADD FRIEND','INVITE']", "['ADD CONTACT','INVITE']",
       "VR nameplate and VR profile back say add contact")
rename("'Add Friend'", "'Add contact'", "VR social says add contact")

# ── 2. the rail tab ──────────────────────────────────────────────────────────
sub("""  { id:'Links',   name:'Links',   icon:'ph ph-link',            title:'Socials, tip jars and sites' },""",
    """  { id:'Links',   name:'Links',   icon:'ph ph-link',            title:'Socials, tip jars and sites' },
  { id:'Resonite',name:'Resonite',icon:'ph ph-cube',            title:'Card back and add-contact button' },""",
    "Resonite tab in the rail")

PANEL = """      <sc-if value="{{ tabResonite }}" hint-placeholder-val="{{ false }}">
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

# ── 3. through to the exporter, and onto the preview ─────────────────────────
# componentDidUpdate already runs on every state change, which is exactly when the card could
# have moved, changed colour, or changed template. The overlay debounces for itself.
sub("""  componentDidUpdate(){ const s=this.state; this.runFit();""",
    """  componentDidUpdate(){ const s=this.state; this.runFit(); this.resPreview();""",
    "preview follows every update")

# and once on arrival, rather than relying on some later state change to trigger the first one
sub("""    this.runFit();
    this.measure();
    const st = document.getElementById('oshi-stage');""",
    """    this.runFit();
    this.measure();
    this.resPreview();
    const st = document.getElementById('oshi-stage');""",
    "preview drawn on arrival")

sub("""  componentWillUnmount(){ if(this.ro) this.ro.disconnect();""",
    """  /* Draw the add-contact button on the card, where it will land and in the colours it will
     have. The overlay lives in the export bundle — it measures the same face the exporter
     measures and reuses its placement — so a build without the bundle simply shows nothing
     rather than showing a button that is not really there. */
  resPreview = ()=>{ const api=window.dropcardResonite;
    if(api && api.contactPreview) api.contactPreview({ on:this.state.resContact!==false,
      spot:this.state.resSpot||'auto', side:this.state.side }); };
  componentWillUnmount(){ const api=window.dropcardResonite;
    if(api && api.contactPreview) api.contactPreview({on:false});
    if(this.ro) this.ro.disconnect();""",
    "preview torn down with the app")

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
