"""Wire "Export for Resonite" to the real thing.

The menu already promises what this does — "standard keeps every element editable in game,
baked merges them so the card cannot be changed" — but both items downloaded PNGs, leaving the
user to assemble a card by hand. They now build a `.resonitepackage`: a two-sided card, sized in
millimetres, with the text as live TextRenderers, the social chips as working hyperlinks, and an
add-contact button on the name and the photo.

Two edits:

1. The export bundle goes in as its own <script> in the outer document, before the app's own
   block, so `window.dropcardResonite` exists by the time anything can be clicked. It is built
   by tools/resonite/browser/bundle.mjs from the same modules the Node build and the test
   harnesses use — run that first; this step will not invent it.

2. The two handlers call it. They also force the preview to show BOTH faces first: the exporter
   measures `#oshi-front-node` and `#oshi-back-node` out of the live DOM, and a preview set to
   one side does not render the other, which would silently produce a one-sided card. The
   previous PNG behaviour is kept as a fallback for the case where the bundle is missing, so a
   failed patch degrades to the old export rather than to a dead button.
"""
import re, json, pathlib, sys

P = sys.argv[1]
HERE = pathlib.Path(__file__).parent
BUNDLE = HERE.parent / "resonite" / "browser" / "dropcard-resonite.js"

if not BUNDLE.is_file():
    sys.exit(f"missing {BUNDLE}\n  build it first:  node tools/resonite/browser/bundle.mjs")
bundle = BUNDLE.read_text(encoding="utf-8")
if "window.dropcardResonite" not in bundle:
    sys.exit(f"{BUNDLE} does not define window.dropcardResonite — is it the flattened bundle?")

src = pathlib.Path(P).read_text(encoding="utf-8")

# ── 1. the app's handlers, inside the page template ──────────────────────────
m = re.search(r'(<script type="__bundler/template">\s*)(.*?)(\s*</script>)', src, re.S)
tpl = json.loads(m.group(2))


def sub(old, new, why):
    global tpl
    n = tpl.count(old)
    assert n == 1, f"{why}: expected 1 match, found {n}"
    tpl = tpl.replace(old, new)
    print(f"  ✓ {why}")


sub(
    """  onResStandard = ()=>{ this.setState({resMenu:false}); setTimeout(()=>this.exportBoth(),40); };""",
    """  onResStandard = ()=>{ this.setState({resMenu:false}); this.resExport(false); };""",
    "standard -> package",
)
sub(
    """              <button class="btn btn-ghost" sc-camel-on-click="{{ onResBaked }}" style="justify-content:flex-start;align-items:flex-start;text-align:left;height:auto;padding:9px 10px">
                <i class="ph ph-fire" style="margin-top:2px"></i>""",
    """              <button class="btn btn-ghost" sc-camel-on-click="{{ onResDispenser }}" style="justify-content:flex-start;align-items:flex-start;text-align:left;height:auto;padding:9px 10px">
                <i class="ph ph-hand-tap" style="margin-top:2px"></i>
                <span style="display:flex;flex-direction:column;gap:2px;min-width:0">
                  <span style="font-weight:600">Export dispenser</span>
                  <span class="text-muted" style="font-size:11px;line-height:1.45;white-space:normal">A button that hands a copy of your card to whoever presses it. Hold it once and it learns your contact.</span>
                </span>
              </button>
              <button class="btn btn-ghost" sc-camel-on-click="{{ onResBaked }}" style="justify-content:flex-start;align-items:flex-start;text-align:left;height:auto;padding:9px 10px">
                <i class="ph ph-fire" style="margin-top:2px"></i>""",
    "dispenser menu item",
)

sub(
    """      resMenuOpen:!!s.resMenu, onToggleResMenu:this.toggleResMenu,
      onResStandard:this.onResStandard, onResBaked:this.onResBaked,""",
    """      resMenuOpen:!!s.resMenu, onToggleResMenu:this.toggleResMenu,
      onResStandard:this.onResStandard, onResBaked:this.onResBaked,
      onResDispenser:this.onResDispenser,""",
    "dispenser handler binding",
)

sub(
    """  onResBaked = ()=>{ this.setState({resMenu:false}); setTimeout(()=>this.exportBaked(),40); };
  exportBaked = ()=>this.bakeSheet()""",
    """  onResBaked = ()=>{ this.setState({resMenu:false}); this.resExport(true); };
  /* Both faces have to be in the DOM to be measured, and a preview showing one side does not
     render the other — exporting from there would quietly give a one-sided card. So switch to
     both, let it paint, export, then put the view back where it was.
     If the export bundle is missing the old PNG behaviour still runs, so a patch that did not
     apply degrades to the previous export rather than to a button that does nothing. */
  resExport = (baked)=>{
    const api = window.dropcardResonite;
    if(!api){ setTimeout(()=>baked?this.exportBaked():this.exportBoth(),40); return; }
    const F=this.state.fields||{};
    const name=(TEMPLATE_LIST.find(t=>t.id===this.state.template)||{}).name||'Card';
    const was=this.state.side;
    const go=()=>api.downloadWithStatus({ bake:baked, template:name,
        fields:{ Name:F.name, Nickname:F.nickname } })
      .then(()=>{ if(was!=='both') this.setState({side:was}); });
    if(was!=='both') this.setState({side:'both'}, ()=>setTimeout(go,320)); else setTimeout(go,40);
  };
  exportBaked = ()=>this.bakeSheet()""",
    "baked -> package, plus the both-faces guard",
)

sub(
    """  resExport = (baked)=>{""",
    """  onResDispenser = ()=>{ this.setState({resMenu:false}); this.resExport(false, true); };
  resExport = (baked, dispenser)=>{""",
    "dispenser handler",
)

sub(
    """    const go=()=>api.downloadWithStatus({ bake:baked, template:name,
        fields:{ Name:F.name, Nickname:F.nickname } })""",
    """    const go=()=>api.downloadWithStatus({ bake:baked, dispenser:!!dispenser, template:name,
        fields:{ Name:F.name, Nickname:F.nickname } })""",
    "pass the dispenser flag through",
)

enc = json.dumps(tpl, ensure_ascii=False).replace("</", "<\\u002F")
src = src[: m.start(2)] + enc + src[m.end(2) :]

# ── 2. the bundle itself, ahead of the app ───────────────────────────────────
# A </script> inside the source would close this tag early; there is none, but check rather
# than assume, since the failure would be a blank page.
if "</script" in bundle.lower():
    sys.exit("the export bundle contains a literal </script> and cannot be inlined as-is")

MARK = "<!-- dropcard: Resonite export -->"
if MARK in src:
    sys.exit("this file already carries the Resonite export bundle")

anchor = '<script type="__bundler/manifest"'
n = src.count(anchor)
assert n == 1, f"expected 1 bundler manifest, found {n}"
src = src.replace(anchor, f"{MARK}\n<script>\n{bundle}\n</script>\n{anchor}", 1)
print(f"  ✓ export bundle inlined ({len(bundle)/1024:.0f} KB)")

pathlib.Path(P).write_text(src, encoding="utf-8")
print("written")
