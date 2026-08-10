// Read a rendered card face apart into the layers the exporter needs, in the page.
//
// This is the same measurement batch.mjs runs through Playwright, moved into the tab. It gives
// back exactly the shape scene.mjs consumes — { card, layers, links, gfx, avatar } — plus the
// rasters, so the Node capture and this one stay interchangeable and can be diffed.
//
// Nothing here mutates the page for longer than a call takes: the plate is rendered from a
// clone with the text and graphics hidden, never by hiding them in the live DOM.

import { rasterise } from './raster.mjs';

/* A text run with an emoji in it cannot be a TextRenderer.
 *
 * The typefaces a card uses are text fonts — Lexend, Poppins, Cormorant — and none of them
 * carry emoji. Resonite has no font fallback chain, so every emoji in an exported run drew as a
 * NO GLYPH box: "Dalek ☕🐱" came out as "Dalek □□". Custom server emoji are already fine, since
 * the app renders those as <img> and they are captured as graphics.
 *
 * So a run containing emoji is captured as a picture of itself instead. It costs the ability to
 * retype that one run in world, which is a smaller loss than the run being unreadable, and it
 * keeps the card looking like the card. Runs without emoji are untouched and stay editable. */
const HAS_EMOJI = /\p{Extended_Pictographic}/u;

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
  /* A custom emoji is an <img> sitting in the middle of the run, and it is part of the name as
     far as anyone reading the card is concerned. Measuring only the text nodes left it outside
     the box twice over: the add-contact target stopped at "Dalek" and did not cover the emoji,
     and the run's own raster was cut to the text, clipping an emoji that hangs below the line
     into what looked like a second row. */
  for (const im of el.querySelectorAll('img')) {
    const r = im.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) rects.push(r);
  }
  if (!rects.length) return null;
  const x0 = Math.min(...rects.map(r => r.left)), y0 = Math.min(...rects.map(r => r.top));
  const x1 = Math.max(...rects.map(r => r.right)), y1 = Math.max(...rects.map(r => r.bottom));
  return { x: x0 - R.x, y: y0 - R.y, w: x1 - x0, h: y1 - y0 };
}

/** Every family+weight the card sets text in, before anything is measured or drawn. */
export function scanFamilies(root) {
  const out = new Map();
  const note = (cs) => {
    const fam = (cs.fontFamily.split(',')[0] || '').trim().replace(/^["']|["']$/g, '');
    if (!fam || /^(system-ui|sans-serif|serif|monospace)$/i.test(fam)) return;
    out.set(`${fam}|${parseInt(cs.fontWeight) || 400}`, { family: fam, weight: parseInt(cs.fontWeight) || 400 });
  };
  (function walk(el) {
    for (const c of el.children) {
      const own = [...c.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
      if (own && !c.closest('svg')) note(getComputedStyle(c));
      walk(c);
    }
  })(root);
  return [...out.values()];
}

/**
 * Measure one face: everything the builder needs to know about it, and nothing drawn yet.
 *
 * Split out from captureFace because rasterising is by far the expensive half — a sweep that
 * only wants to know WHERE things are (browser/spots.mjs, which checks the add-contact button
 * lands somewhere sensible on all forty-odd templates) would otherwise pay for pictures it
 * throws away.
 *
 * @param root  the card face element (#oshi-front-node / #oshi-back-node)
 * @returns { data, textEls, gfxEls, rasterBoxes } — the elements are what captureFace hides
 *          from the plate and then draws one by one
 */
export function measureFace(root) {
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
          rgba: [(+m[1] || 0) / 255, (+m[2] || 0) / 255, (+m[3] || 0) / 255, m[4] === undefined ? 1 : +m[4]],
          // drawn as a picture instead of a TextRenderer — see HAS_EMOJI above. It stays in
          // `layers` so add-contact can still find the name run by its text.
          asGraphic: HAS_EMOJI.test(own) });
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

  /* A run drawn as a picture already contains its own images. Capturing those separately as
     well would draw each one twice — once inside the run's raster and once as its own quad,
     landing a pixel or two apart. On a name like "Dalek ☕:nkocat:" that showed as a second cat
     sitting below the signature line. */
  const inRaster = textEls.filter((_, i) => layers[i].asGraphic);
  const isInsideRaster = (e) => inRaster.some(t => t !== e && t.contains(e));

  const gfx = [];
  root.querySelectorAll('svg, img').forEach(e => {
    if (e.tagName.toLowerCase() === 'svg' && e.parentElement.closest('svg')) return;
    if (isInsideRaster(e)) return;
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

  /* The emoji-bearing runs join the graphics, each drawn from its own raster — over a box that
     covers the layout box AND everything drawn inside it. An inline emoji is taller than the
     line it sits on, so rasterising the layout box alone cut its bottom off. */
  const rasterBoxes = [];
  layers.forEach((L, i) => {
    if (!L.asGraphic) return;
    const t = L.tight || { x: L.x, y: L.y, w: L.w, h: L.h };
    const x0 = Math.floor(Math.min(L.x, t.x)) - 1, y0 = Math.floor(Math.min(L.y, t.y)) - 1;
    const x1 = Math.ceil(Math.max(L.x + L.w, t.x + t.w)) + 1;
    const y1 = Math.ceil(Math.max(L.y + L.h, t.y + t.h)) + 1;
    gfx.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, alpha: 1, name: L.text.slice(0, 24) });
    gfxEls.push(textEls[i]);
    rasterBoxes[gfxEls.length - 1] = { x: x0 - L.x, y: y0 - L.y, w: x1 - x0, h: y1 - y0 };
  });

  /* Buttons the template has MARKED as its add-contact button.
   *
   * A template that prints one is found by its label — "Add contact" — which needs no knowledge
   * of any of this to work. `data-dc-contact` is the way out for a button that says something
   * else: "Say hi", a bare icon, a card that speaks Japanese. Whatever carries the attribute
   * becomes the target, cut to that element's own box.
   *
   * The templates are authored in a design project, away from this repo, so the contract has to
   * be something that can be written there and nothing more. An attribute is that; a build step
   * or an import would not be. */
  const marks = [...root.querySelectorAll('[data-dc-contact]')].map(e => {
    const r = e.getBoundingClientRect();
    return { x: r.x - R.x, y: r.y - R.y, w: r.width, h: r.height,
             label: (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24) };
  }).filter(m => m.w > 8 && m.h > 8);

  /* The avatar region, whether or not a picture was set. A real avatar is an <img>; with none,
     templates draw a placeholder icon-font glyph (ph-user) inside the frame, and the FRAME is
     what we want — the glyph is only 82px inside a 282x250 box. */
  let avatar = null;
  /* A picture on a card is usually NOT an <img>: the templates paint the avatar as a
     background-image on a div so they can crop and filter it. Looking only for <img> meant an
     imported card reported no photo at all, so it got no add-contact target on the picture —
     and fell through to the placeholder branch, which then found nothing either because the
     placeholder is not drawn when there IS a photo. */
  const pictures = [...root.querySelectorAll('img, div, span')]
    .map(e => ({ e, r: e.getBoundingClientRect(),
                 real: e.tagName === 'IMG' ? !!e.currentSrc || !!e.src
                     : /^url\(/i.test(getComputedStyle(e).backgroundImage || '') }))
    .filter(o => o.real && o.r.width > 24 && o.r.height > 24)
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
  const img = pictures[0];
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

  return { data: { card: { w: R.width, h: R.height }, layers, links, gfx, avatar, marks },
           textEls, gfxEls, rasterBoxes };
}

/**
 * Measure one face and rasterise its plate and graphics.
 * @param scale device pixels per CSS pixel; 2 matches what the Node capture produces
 */
export async function captureFace(root, { scale = 2, bake = false, missed = null } = {}) {
  const { data, textEls, gfxEls, rasterBoxes } = measureFace(root);

  /* The plate. Standard hides every text run and graphic so neither is baked into it — text
     becomes live TextRenderers in world and each graphic gets its own quad, which is what makes
     the card editable there. Baked keeps them, and then nothing else needs rendering at all.
     The measurements are taken either way: baked still uses them to place the add-contact
     targets, which are colliders rather than artwork. */
  const hidden = new Set([...textEls, ...gfxEls]);
  const bg = await rasterise(root, { scale, missed, hide: bake ? undefined : (n => hidden.has(n)) });
  const gfxPngs = [];
  if (!bake) for (let i = 0; i < gfxEls.length; i++)
    gfxPngs.push(await rasterise(gfxEls[i], { scale, missed, box: rasterBoxes[i] || null }));

  return { data, bg, gfxPngs };
}

/**
 * Both faces plus the field values the builder needs to recognise the name run.
 * @param fields  { Name, Nickname } as the card is currently showing them
 */
export async function captureCard(fields, { scale = 2, bake = false, missed = null } = {}) {
  const faces = {}, rasters = {};
  for (const side of ['front', 'back']) {
    const el = document.getElementById(`oshi-${side}-node`);
    if (!el) continue;
    const { data, bg, gfxPngs } = await captureFace(el, { scale, bake, missed });
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
