// Rasterise a DOM subtree to PNG bytes, in the page, with no Playwright.
//
// The Node path screenshots elements through a headless browser. A page has no equivalent,
// so this takes the standard route: clone the subtree into an SVG <foreignObject>, load that
// as an image, draw it to a canvas.
//
// The catch, and the reason this file is mostly plumbing: an SVG loaded as an image is
// SEALED. It cannot reach the network, cannot read the document's stylesheets, and tainting
// rules mean a canvas that draws a cross-origin image cannot be read back. So everything the
// clone needs has to be inlined first — computed styles onto the elements themselves, fonts
// and images as data: URIs. Anything missed does not throw; it silently renders wrong, which
// is why compare.mjs diffs the result against the Playwright output pixel by pixel.

const INHERITED_ONLY = new Set(['cursor', 'pointer-events', 'user-select', '-webkit-user-select']);

// Copying every computed property onto every node is what makes the clone self-contained,
// but it also makes the SVG enormous. Only properties that differ from a default element of
// the same tag are worth writing, which cuts it by roughly an order of magnitude.
const SVG_NS = 'http://www.w3.org/2000/svg';

/* The probe MUST NOT live in the page.
 *
 * "Default" here has to mean the UA default, because the sealed SVG has no author stylesheet —
 * only the inline styles written below. Probing in the live document instead measures the page's
 * own CSS: a single `*{box-sizing:border-box}` rule makes border-box look like the default, so it
 * is skipped as redundant, and every padded box in the clone silently reverts to content-box and
 * grows by its padding. On a card that reads as the inner panel spilling over the frame.
 *
 * A blank same-origin iframe has a browsing context (so getComputedStyle works) and nothing but
 * the UA stylesheet in it. `about:blank` is synchronously scriptable, so no load wait is needed.
 */
function makeProbe(doc) {
  const f = doc.createElement('iframe');
  f.setAttribute('aria-hidden', 'true');
  f.style.cssText = 'position:fixed;left:-10000px;top:0;width:64px;height:64px;border:0;opacity:0;pointer-events:none';
  doc.body.appendChild(f);
  const d = f.contentDocument;
  d.open(); d.write('<!doctype html><html><head></head><body></body></html>'); d.close();
  return { frame: f, doc: d, win: f.contentWindow, cache: new Map() };
}

function defaultsFor(tag, ns, probe) {
  const key = `${ns}|${tag}`;
  let d = probe.cache.get(key);
  if (!d) {
    // An SVG element's defaults are nothing like an HTML element's — `fill`, `stroke` and
    // the geometry properties only exist in the SVG namespace, and createElement('path')
    // makes an HTMLUnknownElement whose computed style would filter out the wrong things.
    let el, host;
    if (ns === SVG_NS) {
      host = probe.doc.createElementNS(SVG_NS, 'svg');
      el = probe.doc.createElementNS(SVG_NS, tag);
      host.appendChild(el); probe.doc.body.appendChild(host);
    } else {
      el = probe.doc.createElement(tag); probe.doc.body.appendChild(el);
    }
    const cs = probe.win.getComputedStyle(el);
    d = {}; for (const p of cs) d[p] = cs.getPropertyValue(p);
    (host ?? el).remove();
    probe.cache.set(key, d);
  }
  return d;
}

const styleText = (cs, def) => {
  let text = '';
  for (const p of cs) {
    if (INHERITED_ONLY.has(p)) continue;
    const v = cs.getPropertyValue(p);
    if (v && v !== def[p]) text += `${p}:${v};`;
  }
  return text;
};

// every family named anywhere in a computed font-family stack, lowercased and unquoted
const noteFamilies = (cs, into) => {
  for (const f of (cs.fontFamily || '').split(','))
    into.add(f.trim().replace(/^["']|["']$/g, '').toLowerCase());
};

// `cloneNode` does not carry ::before / ::after, and the rules that would recreate them are
// gone too — only @font-face survives into the clone. Icon fonts live entirely in those
// pseudo-elements, so without this every glyph on the card silently vanishes: the avatar
// placeholder, the social chips, the decorative marks. Each one becomes a real span.
function addPseudos(src, dst, doc, probe, families) {
  for (const which of ['::before', '::after']) {
    const cs = getComputedStyle(src, which);
    const raw = cs.content;
    if (!raw || raw === 'none' || raw === 'normal') continue;
    noteFamilies(cs, families);      // icon fonts live only here
    const span = doc.createElement('span');
    span.setAttribute('style', styleText(cs, defaultsFor('span', null, probe)) + ';content:normal;');
    // a computed `content` is a quoted string, possibly with \XXXX escapes for a glyph
    const str = /^["'](.*)["']$/s.exec(raw);
    if (str) span.textContent = str[1].replace(/\\([0-9a-fA-F]{1,6})\s?/g,
      (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
    which === '::before' ? dst.prepend(span) : dst.append(span);
  }
}

function inlineStyles(src, dst, doc, probe, families) {
  const cs = getComputedStyle(src);
  noteFamilies(cs, families);
  if (dst.nodeType === 1 && dst.tagName)
    dst.setAttribute('style', styleText(cs, defaultsFor(dst.tagName.toLowerCase(), src.namespaceURI, probe)));
  const sk = src.children, dk = dst.children;
  for (let i = 0; i < sk.length && i < dk.length; i++) inlineStyles(sk[i], dk[i], doc, probe, families);
  if (dst.nodeType === 1) addPseudos(src, dst, doc, probe, families);   // after, so indices stay aligned
}

/* One export rasterises a dozen times — two plates, every graphic, an overlay per contact
   target — and each of those inlines the same handful of font files and images. Fetching and
   base64-ing them once per export rather than once per raster is most of the difference
   between a slow export and a quick one, and none of these can change while it runs. */
const uriCache = new Map();
const asDataURI = (url, mime) => {
  if (!uriCache.has(url)) uriCache.set(url, (async () => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i += 0x8000)
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return `data:${mime || r.headers.get('content-type') || 'application/octet-stream'};base64,${btoa(bin)}`;
  })().catch((e) => { uriCache.delete(url); throw e; }));
  return uriCache.get(url);
};

/* The @font-face rules THIS SUBTREE uses, re-declared with their files inlined. Without them
   the clone falls back to a system face and every glyph shifts.
 *
 * Only the families actually named in the clone's computed styles. dropcard declares every
 * typeface it offers plus a full icon font, and inlining the lot put ~9MB of base64 into each
 * SVG — enough that the image simply stopped decoding once anything else was added, which is
 * how the hover overlay came to fail while the card itself squeaked through. A card uses two
 * to four faces; those are the ones that matter, and skipping the rest takes the payload down
 * by well over an order of magnitude. */
async function inlineFonts(doc, families) {
  const seen = new Map();
  for (const sheet of doc.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }   // cross-origin sheet
    for (const rule of rules ?? []) {
      if (rule.constructor.name !== 'CSSFontFaceRule') continue;
      const fam = rule.style.getPropertyValue('font-family').trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (!families.has(fam)) continue;
      const key = rule.cssText;
      if (seen.has(key)) continue;
      const m = /url\((['"]?)(https?:[^)'"]+)\1\)/.exec(rule.style.getPropertyValue('src'));
      if (!m) { seen.set(key, rule.cssText); continue; }   // already a data: URI — take it as is
      try { seen.set(key, rule.cssText.replace(m[2], await asDataURI(m[2]))); }
      catch { /* a font we cannot reach is better skipped than fatal */ }
    }
  }
  return [...seen.values()].join('\n');
}

async function inlineImages(root, missed) {
  await Promise.all([...root.querySelectorAll('img')].map(async (img) => {
    if (!img.src || img.src.startsWith('data:')) return;
    try { img.setAttribute('src', await asDataURI(img.src)); }
    catch { missed?.add(img.src); img.removeAttribute('src'); }
  }));
}

/* Pictures reach a card through CSS as often as through <img>.
 *
 * The avatar is the one that matters: the templates paint it as a `background-image` on a div,
 * not as an <img>, so inlining <img> src attributes alone left the frame empty on every
 * imported card. The clone is sealed and cannot fetch, so any url() still pointing at the
 * network simply does not draw.
 *
 * A cross-origin fetch is the limit here. Displaying a remote image needs no permission, but
 * READING its bytes does, so a media host that sends no access-control-allow-origin cannot be
 * copied into the card at all. Those URLs are collected rather than swallowed, so the export
 * can say whose picture it could not take. */
async function inlineCssUrls(root, missed) {
  const nodes = [root, ...root.querySelectorAll('*')];
  await Promise.all(nodes.map(async (n) => {
    const style = n.getAttribute && n.getAttribute('style');
    if (!style || !/url\(\s*['"]?https?:/i.test(style)) return;
    const urls = [...new Set([...style.matchAll(/url\(\s*(['"]?)(https?:[^)'"]+)\1\s*\)/gi)].map(m => m[2]))];
    let out = style;
    for (const u of urls) {
      try { out = out.split(u).join(await asDataURI(u)); }
      catch { missed?.add(u); }
    }
    n.setAttribute('style', out);
  }));
}

/**
 * @param el       the element to rasterise
 * @param scale    device pixels per CSS pixel (2 matches the Playwright capture)
 * @param missed   optional Set; URLs whose bytes could not be read (a host that allows the
 *                 picture to be shown but not copied) are added to it
 * @param hide     predicate: elements it returns true for are made invisible in the clone,
 *                 which is how the plate is captured without its text and graphics.
 *                 They keep their boxes — see the note at the marking pass below.
 * @returns {Promise<Uint8Array>} PNG bytes with a transparent background
 */
export async function rasterise(el, { scale = 2, hide = () => false, missed = null } = {}) {
  const doc = el.ownerDocument;
  const rect = el.getBoundingClientRect();
  const w = Math.round(rect.width), h = Math.round(rect.height);

  const clone = el.cloneNode(true);
  // Walk both trees together so the predicate sees the ORIGINAL nodes, which still have their
  // ids, dataset and layout — a detached clone has no layout at all.
  //
  // Hidden means INVISIBLE, not absent. Removing a node reflows everything around it: drop the
  // row of social chips off the bottom of a card and the panel above it stretches to take the
  // space, so the plate comes back with its whole layout rearranged. `visibility:hidden` keeps
  // the box and paints nothing, which is what the Node exporter does and therefore what the
  // plate has to be. Marked here and applied after inlineStyles, which would otherwise
  // overwrite the style attribute this sets.
  (function mark(s, d) {
    const sk = [...s.children], dk = [...d.children];
    for (let i = 0; i < sk.length; i++) {
      if (hide(sk[i])) dk[i].setAttribute('data-dc-hidden', '');
      mark(sk[i], dk[i]);
    }
  })(el, clone);
  const probe = makeProbe(doc);
  const families = new Set();
  try { inlineStyles(el, clone, doc, probe, families); } finally { probe.frame.remove(); }
  // Descendants keep no visibility of their own — a computed `visible` matches the tag default
  // and so is never written out — which leaves them inheriting the hidden they sit under.
  for (const n of clone.querySelectorAll('[data-dc-hidden]')) {
    n.setAttribute('style', (n.getAttribute('style') || '') + ';visibility:hidden;');
    n.removeAttribute('data-dc-hidden');
  }
  await inlineImages(clone, missed);
  await inlineCssUrls(clone, missed);
  const fontCss = await inlineFonts(doc, families);

  // The element's own box becomes the viewport, so its position on the page is irrelevant —
  // but it must stay POSITIONED. Dropping to `static` hands every absolutely-positioned
  // descendant a different containing block, and the decorative panels and avatar frame fly
  // off the card. `relative` neutralises the page position without changing what the
  // children resolve against.
  clone.setAttribute('style', (clone.getAttribute('style') || '') +
    `;margin:0;position:relative;left:auto;top:auto;right:auto;bottom:auto;` +
    `transform:none;width:${w}px;height:${h}px;`);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><style type="text/css">${fontCss.replace(/[<&]/g, c => c === '<' ? '&lt;' : '&amp;')}</style></defs>` +
    `<foreignObject width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml">${new XMLSerializer().serializeToString(clone)}</div>` +
    `</foreignObject></svg>`;

  const img = new Image();
  img.decoding = 'sync';
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error('the SVG clone would not load — something is still ' +
      'referencing the network, or the markup is not well-formed XHTML'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });

  const canvas = doc.createElement('canvas');
  canvas.width = w * scale; canvas.height = h * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0);

  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}
