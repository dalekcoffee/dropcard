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

function defaultsFor(tag, ns, cache, doc) {
  const key = `${ns}|${tag}`;
  let d = cache.get(key);
  if (!d) {
    // An SVG element's defaults are nothing like an HTML element's — `fill`, `stroke` and
    // the geometry properties only exist in the SVG namespace, and createElement('path')
    // makes an HTMLUnknownElement whose computed style would filter out the wrong things.
    let probe, host;
    if (ns === SVG_NS) {
      host = doc.createElementNS(SVG_NS, 'svg');
      probe = doc.createElementNS(SVG_NS, tag);
      host.appendChild(probe); doc.body.appendChild(host);
    } else {
      probe = doc.createElement(tag); doc.body.appendChild(probe);
    }
    const cs = getComputedStyle(probe);
    d = {}; for (const p of cs) d[p] = cs.getPropertyValue(p);
    (host ?? probe).remove();
    cache.set(key, d);
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

// `cloneNode` does not carry ::before / ::after, and the rules that would recreate them are
// gone too — only @font-face survives into the clone. Icon fonts live entirely in those
// pseudo-elements, so without this every glyph on the card silently vanishes: the avatar
// placeholder, the social chips, the decorative marks. Each one becomes a real span.
function addPseudos(src, dst, cache, doc) {
  for (const which of ['::before', '::after']) {
    const cs = getComputedStyle(src, which);
    const raw = cs.content;
    if (!raw || raw === 'none' || raw === 'normal') continue;
    const span = doc.createElement('span');
    span.setAttribute('style', styleText(cs, defaultsFor('span', null, cache, doc)) + ';content:normal;');
    // a computed `content` is a quoted string, possibly with \XXXX escapes for a glyph
    const str = /^["'](.*)["']$/s.exec(raw);
    if (str) span.textContent = str[1].replace(/\\([0-9a-fA-F]{1,6})\s?/g,
      (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
    which === '::before' ? dst.prepend(span) : dst.append(span);
  }
}

function inlineStyles(src, dst, cache, doc) {
  const cs = getComputedStyle(src);
  if (dst.nodeType === 1 && dst.tagName)
    dst.setAttribute('style', styleText(cs, defaultsFor(dst.tagName.toLowerCase(), src.namespaceURI, cache, doc)));
  const sk = src.children, dk = dst.children;
  for (let i = 0; i < sk.length && i < dk.length; i++) inlineStyles(sk[i], dk[i], cache, doc);
  if (dst.nodeType === 1) addPseudos(src, dst, cache, doc);   // after, so indices stay aligned
}

const asDataURI = async (url, mime) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  let bin = ''; for (const b of buf) bin += String.fromCharCode(b);
  return `data:${mime || r.headers.get('content-type') || 'application/octet-stream'};base64,${btoa(bin)}`;
};

// Every @font-face the document has loaded, re-declared with its file inlined. Without this
// the clone falls back to a system face and every glyph shifts.
async function inlineFonts(doc) {
  const seen = new Map();
  for (const sheet of doc.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }   // cross-origin sheet
    for (const rule of rules ?? []) {
      if (rule.constructor.name !== 'CSSFontFaceRule') continue;
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

async function inlineImages(root) {
  await Promise.all([...root.querySelectorAll('img')].map(async (img) => {
    if (!img.src || img.src.startsWith('data:')) return;
    try { img.setAttribute('src', await asDataURI(img.src)); }
    catch { img.removeAttribute('src'); }
  }));
}

/**
 * @param el       the element to rasterise
 * @param scale    device pixels per CSS pixel (2 matches the Playwright capture)
 * @param hide     predicate: elements it returns true for are removed from the clone,
 *                 which is how the plate is captured without its text and graphics
 * @returns {Promise<Uint8Array>} PNG bytes with a transparent background
 */
export async function rasterise(el, { scale = 2, hide = () => false } = {}) {
  const doc = el.ownerDocument;
  const rect = el.getBoundingClientRect();
  const w = Math.round(rect.width), h = Math.round(rect.height);

  const clone = el.cloneNode(true);
  // walk both trees together so the predicate sees the ORIGINAL nodes, which still have
  // their ids, dataset and layout — a detached clone has no layout at all
  (function prune(s, d) {
    const sk = [...s.children], dk = [...d.children];
    for (let i = 0; i < sk.length; i++) {
      if (hide(sk[i])) dk[i].remove(); else prune(sk[i], dk[i]);
    }
  })(el, clone);
  inlineStyles(el, clone, new Map(), doc);
  await inlineImages(clone);
  const fontCss = await inlineFonts(doc);

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
