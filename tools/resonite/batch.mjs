// Render several templates in one browser session and extract each as its own layer set.
import pkg from '/opt/node22/lib/node_modules/playwright/index.js'; const { chromium } = pkg;
import { writeFileSync } from 'node:fs';

const SAMPLE = {
  'Name':'Kiri Nakamura', 'Nickname':'Kiri', 'Pronouns':'she/her', 'Birthday':'3/14',
  'Languages':'English, 日本語', 'Role':'Variety VTuber',
  'Streams':'Rhythm games, Art, Karaoke',
  'Motto':'Press start, then keep pressing.',
  'About':'Three years of rhythm games and terrible karaoke. I stream most evenings and I will absolutely read your chat message twice.',
  'Dislikes':'Input lag, cold coffee, autotune',
};
// the template list is filtered by the orientation toggle, so each job states its own
const JOBS = [
  { prefix:'blank-passport', template:'Passport',     orient:'Landscape', content:'blank'  },
  { prefix:'blank-trading',  template:'Trading Card', orient:'Portrait',  content:'blank'  },
  { prefix:'blank-devcard',  template:'Dev Card',     orient:'Landscape', content:'blank'  },
  { prefix:'info-biopanel',  template:'Bio Panel',    orient:'Portrait',  content:'sample' },
  { prefix:'info-editorial', template:'Editorial',    orient:'Landscape', content:'sample' },
  { prefix:'info-ticket',    template:'Ticket',       orient:'Landscape', content:'sample' },
];

const b = await chromium.launch();
const ctx = await b.newContext({ viewport:{width:1500,height:950}, deviceScaleFactor:2 });
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:8899/index.html', { waitUntil:'load', timeout:90000 });
await p.waitForTimeout(9000);
await p.addStyleTag({ content:`html,body,#dc-root,#oshi-stage{background:transparent !important}` });

// React tracks input values on the DOM node, so a plain .value assignment is ignored —
// go through the native setter and fire the event React actually listens for.
const setNative = async (page, handle, value) => page.evaluate(([el, v]) => {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles:true }));
  el.dispatchEvent(new Event('change', { bubbles:true }));
}, [handle, value]);

async function applyContent(mode) {
  await p.locator('button:has-text("Details")').first().click();
  await p.waitForTimeout(900);
  const fields = await p.$$('input[type="text"], input:not([type]), textarea');
  let touched = 0;
  for (const el of fields) {
    const info = await el.evaluate(e => {
      if (e.type === 'file' || e.type === 'color' || e.offsetParent === null) return null;
      const f = e.closest('.field');
      return { label:(f?.querySelector('label')?.textContent || '').trim(), ph:e.placeholder || '' };
    });
    if (!info) continue;
    if (mode === 'blank') { await setNative(p, el, ''); touched++; }
    else {
      const key = Object.keys(SAMPLE).find(k => info.label.toLowerCase().startsWith(k.toLowerCase()));
      if (key) { await setNative(p, el, SAMPLE[key]); touched++; }
    }
  }
  await p.waitForTimeout(1200);
  return touched;
}

const all = {};
for (const job of JOBS) {
  await p.locator('button:has-text("Layout")').first().click();
  await p.waitForTimeout(600);
  await p.getByText(job.orient, { exact:true }).first().click();
  await p.waitForTimeout(900);
  await p.locator(`button:has-text("${job.template}")`).first().click();
  await p.waitForTimeout(1400);
  const touched = await applyContent(job.content);

  // read back what the card is actually showing, so the builder can identify the name run
  const fieldVals = await p.evaluate(() => {
    const out = {};
    document.querySelectorAll('input, textarea').forEach(e => {
      if (e.type === 'file' || e.type === 'color' || e.offsetParent === null) return;
      const lab = (e.closest('.field')?.querySelector('label')?.textContent || '').trim();
      if (lab && e.value) out[lab] = e.value;
    });
    return out;
  });

  const faces = {};
  for (const side of ['front','back']) {
    const id = `oshi-${side}-node`;
    if (!(await p.$('#' + id))) continue;
    await p.evaluate((id)=>{ const el=document.getElementById(id); el.dataset._old=el.style.cssText;
      el.style.position='fixed'; el.style.left='0px'; el.style.top='0px'; el.style.zIndex='99999'; el.style.transform='none';
      for(let n=el.parentElement;n&&n!==document.body;n=n.parentElement) n.style.background='transparent'; }, id);
    await p.waitForTimeout(800);

    const data = await p.evaluate((id) => {
      const root=document.getElementById(id), R=root.getBoundingClientRect(), out=[];
      const walk=el=>{ for(const c of el.children){
        const own=[...c.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim();
        const r=c.getBoundingClientRect(), cs=getComputedStyle(c);
        if(own && !c.closest('svg') && r.width>0 && r.height>0 && cs.visibility!=='hidden' && +cs.opacity>0){
          const m=/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(cs.color)||[];
          out.push({ text:own, x:r.x-R.x, y:r.y-R.y, w:r.width, h:r.height,
            family:(cs.fontFamily.split(',')[0]||'').trim().replace(/^["']|["']$/g,''),
            fontPx:parseFloat(cs.fontSize), weight:parseInt(cs.fontWeight)||400, align:cs.textAlign,
            lineHeight:parseFloat(cs.lineHeight)||parseFloat(cs.fontSize)*1.2,
            rgba:[(+m[1]||0)/255,(+m[2]||0)/255,(+m[3]||0)/255,m[4]===undefined?1:+m[4]] });
          c.dataset._dcText='1';
        } walk(c); } };
      walk(root);
      const links=[...root.querySelectorAll('[data-url]')].map(e=>{ const r=e.getBoundingClientRect();
        return { url:e.dataset.url, network:e.dataset.network||'link', handle:e.dataset.handle||'',
                 x:r.x-R.x, y:r.y-R.y, w:r.width, h:r.height }; })
        .filter(l=>/^https?:\/\//i.test(l.url));
      const gfx=[];
      root.querySelectorAll('svg, img').forEach(e=>{
        if(e.tagName.toLowerCase()==='svg' && e.parentElement.closest('svg')) return;
        const r=e.getBoundingClientRect(); if(r.width<2||r.height<2) return;
        e.dataset._dcGfx=String(gfx.length);
        let alpha=1; for(let n=e;n&&n!==root.parentElement;n=n.parentElement){
          const o=parseFloat(getComputedStyle(n).opacity); if(!isNaN(o)) alpha*=o; }
        gfx.push({ x:r.x-R.x, y:r.y-R.y, w:r.width, h:r.height, alpha,
                   name:(e.textContent||'').trim().replace(/\s+/g,' ').slice(0,24)||e.tagName.toLowerCase() });
      });
      // The avatar region, whether or not a picture was set. A real avatar is an <img>;
      // with none, templates draw a placeholder icon-font glyph (ph-user) inside the frame,
      // and the FRAME is what we want — the glyph is only 82px inside a 282x250 box.
      let avatar = null;
      const img = [...root.querySelectorAll('img')]
        .map(e => ({ e, r: e.getBoundingClientRect() }))
        .filter(o => o.r.width > 24 && o.r.height > 24)
        .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
      if (img) {
        avatar = { x:img.r.x-R.x, y:img.r.y-R.y, w:img.r.width, h:img.r.height, hasImage:true };
      } else {
        // Use the GLYPH's own box, not its parent: the parent is the avatar frame in some
        // templates but a whole layout column in others (Editorial gives 360x625 on a
        // 1000x625 card, which would swallow half the face). The glyph is centred in the
        // frame, so a modest symmetric expansion stays inside it whatever the template.
        const icon = root.querySelector('i[class*="ph-user"], i[class*="ph-person"], i[class*="ph-image"]');
        if (icon) {
          const r = icon.getBoundingClientRect();
          if (r.width > 16 && r.height > 16)
            avatar = { x:r.x-R.x, y:r.y-R.y, w:r.width, h:r.height, hasImage:false, isGlyph:true };
        }
      }
      return { card:{ w:R.width, h:R.height }, layers:out, links, gfx, avatar };
    }, id);

    for (let g=0; g<data.gfx.length; g++) {
      await p.evaluate(([id,gi])=>{ const src=document.getElementById(id).querySelector(`[data-_dc-gfx="${gi}"]`);
        const r=src.getBoundingClientRect();
        const holder=document.createElement('div'); holder.id='__dc_gfx_holder';
        holder.style.cssText=`position:fixed;left:0;top:0;width:${r.width}px;height:${r.height}px;background:transparent;z-index:2147483647;overflow:hidden`;
        const c=src.cloneNode(true); c.style.width=r.width+'px'; c.style.height=r.height+'px'; c.style.margin='0';
        holder.appendChild(c); document.body.appendChild(holder);
        [...document.body.children].forEach(el=>{ if(el!==holder){ el.dataset._dcHid=el.style.visibility||' '; el.style.visibility='hidden'; } });
      }, [id,g]);
      await p.waitForTimeout(320);
      await p.locator('#__dc_gfx_holder').screenshot({ path:`${job.prefix}-gfx-${side}-${g}.png`, omitBackground:true });
      await p.evaluate(()=>{ document.getElementById('__dc_gfx_holder')?.remove();
        [...document.body.children].forEach(el=>{ if(el.dataset._dcHid!==undefined){ el.style.visibility=el.dataset._dcHid.trim(); delete el.dataset._dcHid; } }); });
    }

    await p.evaluate((id)=>{ document.getElementById(id).querySelectorAll('*').forEach(e=>{
      if(e.dataset._dcText || e.dataset._dcGfx!==undefined) e.style.visibility='hidden'; }); }, id);
    await p.waitForTimeout(500);
    await p.locator('#'+id).screenshot({ path:`${job.prefix}-bg-${side}.png`, omitBackground:true });
    await p.evaluate((id)=>{ const el=document.getElementById(id);
      el.querySelectorAll('*').forEach(e=>{ if(e.dataset._dcText||e.dataset._dcGfx!==undefined){ e.style.visibility=''; delete e.dataset._dcText; delete e.dataset._dcGfx; } });
      el.style.cssText=el.dataset._old; }, id);
    await p.waitForTimeout(250);
    faces[side]=data;
  }
  all[job.prefix]={ ...job, faces, fields:fieldVals };
  const f=faces.front, k=faces.back;
  console.log(`${job.prefix.padEnd(16)} ${job.template.padEnd(13)} ${job.content.padEnd(6)} fields=${String(touched).padStart(2)}  ` +
              `card=${f.card.w}x${f.card.h} front(${f.layers.length}t/${f.gfx.length}g${f.avatar?(f.avatar.hasImage?'/pic':'/NOPIC'):''}) back(${k?k.layers.length:0}t/${k?k.links.length:0}l)`);
}
writeFileSync('batch-layers.json', JSON.stringify(all, null, 1));
await b.close();
