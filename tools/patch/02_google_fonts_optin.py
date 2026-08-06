import re, json, pathlib

import sys
P = sys.argv[1]
src = pathlib.Path(P).read_text(encoding="utf-8")
m = re.search(r'(<script type="__bundler/template">\s*)(.*?)(\s*</script>)', src, re.S)
tpl = json.loads(m.group(2))

def sub(old, new, why):
    n = tpl.count(old)
    assert n == 1, f"{why}: expected 1 match, got {n}"
    return tpl.replace(old, new)

# ---- 1. preference helpers, next to the font stacks -------------------------
old = "const FONT_STACK = (name)=>{"
new = """/* Google's font CDN sees a visitor's IP the moment a face is requested, so dropcard asks for
   nothing until someone opts in. That answer is the only thing kept between visits. */
const FONTS_KEY = 'dropcard:google-fonts';
const FONTS_PREF = ()=>{ try { return localStorage.getItem(FONTS_KEY)==='1'; } catch(e) { return false; } };
const FONTS_SAVE = (on)=>{ try { localStorage.setItem(FONTS_KEY, on?'1':'0'); } catch(e) {} };
const FONT_STACK = (name)=>{"""
tpl = sub(old, new, "font pref helpers")

# ---- 2. initial state -------------------------------------------------------
old = "importUrl:'', importStatus:null, oshiUnlocked:false, scale:0.55,"
new = "importUrl:'', importStatus:null, oshiUnlocked:false, scale:0.55, fontsOn:FONTS_PREF(),"
tpl = sub(old, new, "initial state")

# ---- 3. mount: don't reach for the catalogue unless invited -----------------
old = """    this.loadCatalogue();
    this.runFit();
    (this.state.customFonts||[]).forEach(n=>this.loadFamily(n));"""
new = """    if(this.state.fontsOn){ this.loadCatalogue(); (this.state.customFonts||[]).forEach(n=>this.loadFamily(n)); }
    this.runFit();"""
tpl = sub(old, new, "componentDidMount")

# ---- 4. the choke point every Google Fonts request passes through ----------
old = "fontLink(id,href){ if(document.getElementById(id)) return;"
new = "fontLink(id,href){ if(!this.state.fontsOn) return; if(document.getElementById(id)) return;"
tpl = sub(old, new, "fontLink guard")

# ---- 5. the toggle ----------------------------------------------------------
old = "  onCustomFontKey = (e)=>{"
new = """  /* Flipping this on fetches the whole catalogue at once; flipping it off pulls the stylesheet
     links back out, so the faces stop applying and nothing further is requested. */
  onToggleFonts = ()=>{ const on = !this.state.fontsOn; FONTS_SAVE(on);
    this.setState({fontsOn:on}, ()=>{
      if(on){ this.loadCatalogue(); (this.state.customFonts||[]).forEach(n=>this.loadFamily(n)); }
      else { Array.prototype.forEach.call(document.querySelectorAll('link[id^="oshi-f"]'), l=>l.remove()); }
      this.runFit();
    }); };
  onCustomFontKey = (e)=>{"""
tpl = sub(old, new, "onToggleFonts")

# ---- 6. props ---------------------------------------------------------------
old = "      fontGroups:this.fontGroups(),"
new = "      fontGroups:this.fontGroups(),\n      fontsOn:!!s.fontsOn, fontsOff:!s.fontsOn, onToggleFonts:this.onToggleFonts,"
tpl = sub(old, new, "props")

# ---- 7. markup --------------------------------------------------------------
old = """          <input class="input" value="{{ customFontInput }}" sc-camel-on-input="{{ onCustomFontInput }}" sc-camel-on-key-down="{{ onCustomFontKey }}" sc-camel-on-blur="{{ onCustomFont }}" placeholder="Any Google Font by name…" style="margin-top:6px">
          <p class="text-muted" style="font-size:11px;margin:5px 0 0;line-height:1.5">Type a family from <a href="https://fonts.google.com" target="_blank" rel="noopener">fonts.google.com</a> and press Enter — it loads and joins the list.</p>"""
new = """          <sc-if value="{{ fontsOn }}" hint-placeholder-val="{{ false }}">
            <input class="input" value="{{ customFontInput }}" sc-camel-on-input="{{ onCustomFontInput }}" sc-camel-on-key-down="{{ onCustomFontKey }}" sc-camel-on-blur="{{ onCustomFont }}" placeholder="Any Google Font by name…" style="margin-top:6px">
            <p class="text-muted" style="font-size:11px;margin:5px 0 0;line-height:1.5">Type a family from <a href="https://fonts.google.com" target="_blank" rel="noopener">fonts.google.com</a> and press Enter — it loads and joins the list.</p>
            <button class="btn" sc-camel-on-click="{{ onToggleFonts }}" style="width:100%;margin-top:7px;font-size:11.5px;justify-content:center"><i class="ph ph-toggle-right" style="font-size:14px;color:var(--color-accent)"></i>Google Fonts are on — switch off</button>
          </sc-if>
          <sc-if value="{{ fontsOff }}" hint-placeholder-val="{{ true }}">
            <div style="margin-top:7px;padding:9px 10px;border:1px solid var(--color-divider);border-radius:9px;background:var(--color-neutral-900)">
              <div style="display:flex;align-items:center;gap:7px;margin-bottom:5px">
                <i class="ph ph-text-aa" style="font-size:15px;color:var(--color-accent)"></i>
                <span style="font-size:12.5px;font-weight:600">Fancy fonts are off</span>
              </div>
              <p class="text-muted" style="font-size:11px;margin:0 0 8px;line-height:1.55">They come from Google, so switching them on means Google sees your IP — the same as on most of the web. Cards look good without them, you just get your system's faces. Pick a face up there and it'll show up properly the moment you flip this on.</p>
              <button class="btn" sc-camel-on-click="{{ onToggleFonts }}" style="width:100%;font-size:11.5px;justify-content:center"><i class="ph ph-toggle-left" style="font-size:14px"></i>Switch them on</button>
            </div>
          </sc-if>"""
tpl = sub(old, new, "markup")

enc = json.dumps(tpl, ensure_ascii=False).replace("</", "<\\u002F")
pathlib.Path(P).write_text(src[:m.start(2)] + enc + src[m.end(2):], encoding="utf-8")
print("patched OK")
