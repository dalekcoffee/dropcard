// Read a rendered card face apart into the layers the exporter needs, in the page.
//
// This is the same measurement batch.mjs runs through Playwright, moved into the tab. It gives
// back exactly the shape scene.mjs consumes — { card, layers, links, gfx, avatar } — plus the
// rasters, so the Node capture and this one stay interchangeable and can be diffed.
//
// Nothing here mutates the page for longer than a call takes: the plate is rendered from a
// clone with the text and graphics hidden, never by hiding them in the live DOM.

import { rasterise } from './raster.mjs';

/* A text run's ELEMENT box is its layout box, routinely the full width of the card or column.
   Sizing a collider to that gives a band across the face that swallows the social chips. Range
   rects give the box the GLYPHS actually occupy, which is what anything clickable is cut to. */
function tightBox(el, R) {
  const rects = [];
  for (const n of el.childNodes) {
    if (n.nodeType !== 3 || !n.textContent.trim()) continue;
    const rg = document.createRange();
    rg.selectNodeContents(n);
    for (const r of rg.getClientRects()) if (r.width > 0 && r.height > 0) rects.push(r);
  }
  if (!rects.length) return null;
  const x0 = Math.min(...rects.map(r => r.left)), y0 = Math.min(...rects.map(r => r.top));
  const x1 = Math.max(...rects.map(r => r.right)), y1 = Math.max(...rects.map(r => r.bottom));
  return { x: x0 - R.x, y: y0 - R.y, w: x1 - x0, h: y1 - y0 };
}

/**
 * Measure one face and rasterise its plate and graphics.
 * @param root  the card face element (#oshi-front-node / #oshi-back-node)
 * @param scale device pixels per CSS pixel; 2 matches what the Node capture produces
 */
export async function captureFace(root, { scale = 2, bake = false } = {}) {
  const R = root.getBoundingClientRect();
  const layers = [], gfxEls = [], textEls = [];

  (function walk(el) {
    for (const c of el.children) {
      const own = [...c.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
      const r = c.getBoundingClientRect(), cs = getComputedStyle(c);
      if (own && !c.closest('svg') && r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && +cs.opacity > 0) {
        const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(cs.color) || [];
        layers.push({ text: own, x: r.x - R.x, y: r.y - R.y, w: r.width, h: r.height, tight: tightBox(c, R),
          family: (cs.fontFamily.split(',')[0] || '').trim().replace(/^["']|["']$/g, ''),
          fontPx: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight) || 400, align: cs.textAlign,
          lineHeight: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2,
          rgba: [(+m[1] || 0) / 255, (+m[2] || 0) / 255, (+m[3] || 0) / 255, m[4] === undefined ? 1 : +m[4]] });
        textEls.push(c);
      }
      walk(c);
    }
  })(root);

  const links = [...root.querySelectorAll('[data-url]')]
    .map(e => { const r = e.getBoundingClientRect();
      return { url: e.dataset.url, network: e.dataset.network || 'link', handle: e.dataset.handle || '',
               x: r.x - R.x, y: r.y - R.y, w: r.width, h: r.height }; })
    .filter(l => /^https?:\/\//i.test(l.url));

  const gfx = [];
  root.querySelectorAll('svg, img').forEach(e => {
    if (e.tagName.toLowerCase() === 'svg' && e.parentElement.closest('svg')) return;
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    let alpha = 1;
    for (let n = e; n && n !== root.parentElement; n = n.parentElement) {
      const o = parseFloat(getComputedStyle(n).opacity); if (!isNaN(o)) alpha *= o;
    }
    gfx.push({ x: r.x - R.x, y: r.y - R.y, w: r.width, h: r.height, alpha,
               name: (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24) || e.tagName.toLowerCase() });
    gfxEls.push(e);
  });

  /* The avatar region, whether or not a picture was set. A real avatar is an <img>; with none,
     templates draw a placeholder icon-font glyph (ph-user) inside the frame, and the FRAME is
     what we want — the glyph is only 82px inside a 282x250 box. */
  let avatar = null;
  const img = [...root.querySelectorAll('img')]
    .map(e => ({ e, r: e.getBoundingClientRect() }))
    .filter(o => o.r.width > 24 && o.r.height > 24)
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
  if (img) {
    avatar = { x: img.r.x - R.x, y: img.r.y - R.y, w: img.r.width, h: img.r.height, hasImage: true };
  } else {
    /* The GLYPH's own box, not its parent: the parent is the avatar frame in some templates but
       a whole layout column in others (Editorial gives 360x625 on a 1000x625 card, which would
       swallow half the face). The glyph is centred in the frame, so a modest symmetric
       expansion stays inside it whatever the template. */
    const icon = root.querySelector('i[class*="ph-user"], i[class*="ph-person"], i[class*="ph-image"]');
    if (icon) {
      const r = icon.getBoundingClientRect();
      if (r.width > 16 && r.height > 16)
        avatar = { x: r.x - R.x, y: r.y - R.y, w: r.width, h: r.height, hasImage: false, isGlyph: true };
    }
  }

  /* The plate. Standard hides every text run and graphic so neither is baked into it — text
     becomes live TextRenderers in world and each graphic gets its own quad, which is what makes
     the card editable there. Baked keeps them, and then nothing else needs rendering at all.
     The measurements are taken either way: baked still uses them to place the add-contact
     targets, which are colliders rather than artwork. */
  const hidden = new Set([...textEls, ...gfxEls]);
  const bg = await rasterise(root, { scale, hide: bake ? undefined : (n => hidden.has(n)) });
  const gfxPngs = [];
  if (!bake) for (const e of gfxEls) gfxPngs.push(await rasterise(e, { scale }));

  return { data: { card: { w: R.width, h: R.height }, layers, links, gfx, avatar }, bg, gfxPngs };
}

/**
 * Both faces plus the field values the builder needs to recognise the name run.
 * @param fields  { Name, Nickname } as the card is currently showing them
 */
export async function captureCard(fields, { scale = 2, bake = false } = {}) {
  const faces = {}, rasters = {};
  for (const side of ['front', 'back']) {
    const el = document.getElementById(`oshi-${side}-node`);
    if (!el) continue;
    const { data, bg, gfxPngs } = await captureFace(el, { scale, bake });
    faces[side] = data;
    rasters[`bg|${side}`] = bg;
    gfxPngs.forEach((p, i) => { rasters[`gfx|${side}|${i}`] = p; });
  }
  // scene.mjs asks for an image more than once and matches by identity, so hand back the
  // same array every time rather than a fresh view
  const imageFor = (kind, side, i) => {
    const key = kind === 'bg' ? `bg|${side}` : `gfx|${side}|${i}`;
    const v = rasters[key];
    if (!v) throw new Error(`no raster captured for ${key}`);
    return v;
  };
  return { faces, fields, imageFor };
}
