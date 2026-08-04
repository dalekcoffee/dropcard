// Pull the card apart: one background plate per face (with the type hidden) plus the
// geometry/typography of every text run, so each becomes its own editable slot in-world.
import pkg from '/opt/node22/lib/node_modules/playwright/index.js'; const { chromium } = pkg;
import { writeFileSync } from 'node:fs';

const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{width:1200,height:800}, deviceScaleFactor:2 })).newPage();
await p.goto('http://127.0.0.1:8899/index.html', { waitUntil:'load', timeout:90000 });
await p.waitForTimeout(8000);
await p.addStyleTag({ content:`html,body,#dc-root,#oshi-stage{background:transparent !important}` });

const faces = {};
for (const side of ['front','back']) {
  const id = `oshi-${side}-node`;
  await p.evaluate((id)=>{ const el=document.getElementById(id);
    el.dataset._old=el.style.cssText;
    el.style.position='fixed'; el.style.left='0px'; el.style.top='0px'; el.style.zIndex='99999'; el.style.transform='none';
    for(let n=el.parentElement;n&&n!==document.body;n=n.parentElement) n.style.background='transparent';
  }, id);
  await p.waitForTimeout(800);

  // 1. measure every text run against the card's own box
  const layers = await p.evaluate((id) => {
    const root = document.getElementById(id), R = root.getBoundingClientRect(), out = [];
    const walk = (el) => { for (const c of el.children) {
      const own = [...c.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim();
      const r = c.getBoundingClientRect(), cs = getComputedStyle(c);
      // SVG text (the seals use <textPath> around a circle) can't be reproduced by a flat
      // TextRenderer — pulling it out would lay it out straight and overlap real content.
      // Leave it baked into the background plate, where its curved layout survives intact.
      const inSvg = !!c.closest('svg');
      if (own && !inSvg && r.width>0 && r.height>0 && cs.visibility!=='hidden' && +cs.opacity>0) {
        const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(cs.color)||[];
        // first family in the stack, unquoted — that's what we fetch a real TTF for
        const fam = (cs.fontFamily.split(',')[0]||'').trim().replace(/^["']|["']$/g,'');
        out.push({ text: own, x:r.x-R.x, y:r.y-R.y, w:r.width, h:r.height, family: fam,
          fontPx: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight)||400,
          align: cs.textAlign, lineHeight: parseFloat(cs.lineHeight)||parseFloat(cs.fontSize)*1.2,
          rgba: [ (+m[1]||0)/255, (+m[2]||0)/255, (+m[3]||0)/255, m[4]===undefined?1:+m[4] ] });
        c.dataset._dcText = '1';
      }
      walk(c);
    }};
    walk(root);
    // the app already tags each social chip with its resolved URL — reuse that rather
    // than trying to reconstruct links from the rendered text
    const links = [...root.querySelectorAll('[data-url]')].map(e => {
      const r = e.getBoundingClientRect();
      return { url:e.dataset.url, network:e.dataset.network || 'link', handle:e.dataset.handle || '',
               x:r.x-R.x, y:r.y-R.y, w:r.width, h:r.height };
    }).filter(l => /^https?:\/\//i.test(l.url));
    // Graphics that a flat TextRenderer can't express (the seals draw text around a circle
    // with <textPath>). They still get their OWN layer rather than being merged into the
    // plate — an unbaked export shouldn't bake anything.
    const gfx = [];
    root.querySelectorAll('svg, img').forEach(e => {
      if (e.tagName.toLowerCase() === 'svg' && e.parentElement.closest('svg')) return;
      const b = e.getBoundingClientRect();
      if (b.width < 2 || b.height < 2) return;
      e.dataset._dcGfx = String(gfx.length);
      // cloning the node out of the card drops any opacity inherited from its ancestors
      // (the seals are deliberately faint), so carry the effective value through as a tint
      let alpha = 1;
      for (let n = e; n && n !== root.parentElement; n = n.parentElement) {
        const o = parseFloat(getComputedStyle(n).opacity);
        if (!isNaN(o)) alpha *= o;
      }
      gfx.push({ x:b.x-R.x, y:b.y-R.y, w:b.width, h:b.height, alpha,
                 name:(e.textContent||'').trim().replace(/\s+/g,' ').slice(0,24) || e.tagName.toLowerCase() });
    });
    return { card:{ w:R.width, h:R.height }, layers: out, links, gfx };
  }, id);

  // Each graphic is rastered on its own, cloned into an isolated transparent holder so the
  // card behind it doesn't bleed into the cut-out.
  for (let g = 0; g < layers.gfx.length; g++) {
    await p.evaluate(([id, gi]) => {
      const src = document.getElementById(id).querySelector(`[data-_dc-gfx="${gi}"]`);
      const r = src.getBoundingClientRect();
      const holder = document.createElement('div');
      holder.id = '__dc_gfx_holder';
      holder.style.cssText = `position:fixed;left:0;top:0;width:${r.width}px;height:${r.height}px;`
                           + 'background:transparent;z-index:2147483647;overflow:hidden';
      const c = src.cloneNode(true);
      c.style.width = r.width + 'px'; c.style.height = r.height + 'px'; c.style.margin = '0';
      holder.appendChild(c);
      document.body.appendChild(holder);
      // the holder is transparent, so ANY page content behind it bleeds into the cut-out —
      // the card is parked at fixed 0,0 and the app chrome is behind that. Hide the lot.
      [...document.body.children].forEach(el => {
        if (el !== holder) { el.dataset._dcHid = el.style.visibility || ' '; el.style.visibility = 'hidden'; }
      });
    }, [id, g]);
    await p.waitForTimeout(350);
    await p.locator('#__dc_gfx_holder').screenshot({ path:`gfx-${side}-${g}.png`, omitBackground:true });
    await p.evaluate(() => { document.getElementById('__dc_gfx_holder')?.remove();
      [...document.body.children].forEach(el => {
        if (el.dataset._dcHid !== undefined) { el.style.visibility = el.dataset._dcHid.trim(); delete el.dataset._dcHid; }
      }); });
  }

  // 2. background plate = the same card with every measured run hidden (layout preserved)
  await p.evaluate((id)=>{ document.getElementById(id).querySelectorAll('[data-_dc-text],[data-dc-text],[data-_dcText]')
    .forEach(e=>e.style.visibility='hidden');
    document.querySelectorAll('[data-_dc-text]').forEach(e=>e.style.visibility='hidden'); }, id);
  await p.evaluate((id)=>{ // dataset keys normalise to data-_dc-text / data-_dc-gfx
    document.getElementById(id).querySelectorAll('*').forEach(e=>{
      if(e.dataset._dcText || e.dataset._dcGfx!==undefined) e.style.visibility='hidden'; }); }, id);
  await p.waitForTimeout(600);
  await p.locator('#'+id).screenshot({ path:`bg-${side}.png`, omitBackground:true });

  await p.evaluate((id)=>{ const el=document.getElementById(id);
    el.querySelectorAll('*').forEach(e=>{ if(e.dataset._dcText){ e.style.visibility=''; delete e.dataset._dcText; delete e.dataset._dcGfx; } });
    el.style.cssText = el.dataset._old; }, id);
  await p.waitForTimeout(300);

  faces[side] = layers;
  console.log(`${side}: card ${layers.card.w}x${layers.card.h}, ${layers.layers.length} text layers, ${layers.links.length} links, ${layers.gfx.length} graphics -> bg-${side}.png`);
}
writeFileSync('layers.json', JSON.stringify(faces, null, 1));
await b.close();
