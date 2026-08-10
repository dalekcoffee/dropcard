// The card's own colours, and the hover label drawn in them — in the page.
//
// Ports icon.mjs's cardTheme and renderOverlay off pngjs and Playwright. The theme is read
// back out of the plate raster that was just captured, so no template has to declare one.

import { rasterise } from './raster.mjs';
import { hex, lum, sat } from '../colour.mjs';

export const b64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

// PNG bytes -> RGBA pixels, without a decoder: the browser has one.
async function pixels(png) {
  const bmp = await createImageBitmap(new Blob([png], { type: 'image/png' }));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  bmp.close();
  return d;
}

/**
 * The card's paper and accent, read out of the plate.
 * @param bgPng  the front face's plate raster
 * @param job    the capture, for the fallback that reads accent off the text runs
 */
export async function cardTheme(bgPng, job) {
  const data = await pixels(bgPng);
  const bins = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 250) continue;
    const k = (data[i] >> 4) * 256 + (data[i + 1] >> 4) * 16 + (data[i + 2] >> 4);
    bins.set(k, (bins.get(k) ?? 0) + 1);
  }
  const unbin = k => [((k / 256) | 0) * 17, (((k / 16) | 0) % 16) * 17, (k % 16) * 17];
  const byCount = [...bins].sort((a, b) => b[1] - a[1]);
  if (!byCount.length) return { surface: '#ffffff', accent: '#111118', surfaceRGB: [255,255,255], accentRGB: [17,17,24] };
  const surface = unbin(byCount[0][0]);

  /* accent: the most saturated colour the card actually spends area on. Near-blacks are
     excluded by the brightness floor — #110000 is technically fully saturated and is just ink.
     Printed bands beat text, because a template's accent is usually a filled area (Ticket's
     header) while its saturated text can be a one-off heading. */
  const total = byCount.reduce((n, [, c]) => n + c, 0);
  const usable = o => sat(o) > 0.28 && Math.max(...o) > 70 && lum(o) < 0.88;
  let accent = byCount.map(([k, c]) => ({ rgb: unbin(k), c }))
    .filter(o => o.c > total * 0.01 && usable(o.rgb))
    .sort((a, b) => sat(b.rgb) - sat(a.rgb))[0]?.rgb;
  if (!accent) {
    accent = Object.values(job.faces).flatMap(f => f.layers || [])
      .filter(L => L.rgba[3] > 0.5)
      .map(L => ({ rgb: L.rgba.slice(0, 3).map(v => v * 255), area: L.w * L.h }))
      .filter(o => usable(o.rgb))
      .sort((a, b) => sat(b.rgb) * Math.sqrt(b.area) - sat(a.rgb) * Math.sqrt(a.area))[0]?.rgb;
  }
  if (!accent) accent = lum(surface) > 0.5 ? [24, 24, 34] : [235, 235, 245];
  return { surface: hex(surface), accent: hex(accent), surfaceRGB: surface, accentRGB: accent };
}

/**
 * The hover overlay that covers an add-contact target. Rendered at the target's own aspect so
 * the quad never stretches it, in the card's accent and its own bundled typeface, so it reads
 * as part of the template rather than as a system tooltip.
 */
export async function renderOverlay({ w, h, text = 'Add contact', plate, ink, fontBytes, family }) {
  const scale = 512 / Math.max(w, h);
  const W = Math.round(w * scale), H = Math.round(h * scale);
  const radius = Math.round(Math.min(W, H) * 0.16);
  const pad = Math.round(Math.min(W, H) * 0.1);
  const stack = fontBytes ? `"dc-ov-face", ${family || 'sans-serif'}` : (family || 'sans-serif');

  /* The face is declared as a document @font-face rather than handed to the rasteriser: the
     clone is sealed and can only use faces that are already declared, and raster.mjs passes a
     data: URI src through untouched. Removed again straight after, so it cannot leak into the
     plate captures. */
  const style = document.createElement('style');
  style.textContent = fontBytes
    ? `@font-face{font-family:"dc-ov-face";src:url(data:font/ttf;base64,${b64(fontBytes)}) format("truetype")}`
    : '';
  document.head.appendChild(style);
  if (fontBytes) { try { await document.fonts.load(`16px "dc-ov-face"`); } catch { /* fall back to the stack */ } }

  /* On a squarish target — the avatar frame — one line has to shrink to nothing to fit the
     width. Break it across lines instead, explicitly rather than by letting it wrap, so the
     measuring pass sees exactly the layout the final render will use. */
  const body = (w / h < 2.2) ? text.split(/\s+/) : [text];

  /* Built through the CSSOM rather than an interpolated style="" attribute. A family name is
     quoted — the stack reads `"dc-ov-face", Lexend` — and dropping that into an attribute
     string closes the attribute on its first inner quote, leaving the rest to parse as bare
     attributes. The clone then serialises to markup that is not well-formed XML and the SVG
     silently refuses to load. Assigning the property escapes it properly. */
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;z-index:-1;pointer-events:none';
  const box = document.createElement('div');
  Object.assign(box.style, { width: `${W}px`, height: `${H}px`, borderRadius: `${radius}px`,
    background: plate, display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxSizing: 'border-box', padding: `${pad}px` });
  const span = document.createElement('span');
  Object.assign(span.style, { fontFamily: stack, fontSize: '100px', lineHeight: '1.15',
    color: ink, whiteSpace: 'nowrap', textAlign: 'center', letterSpacing: '0.01em' });
  body.forEach((line, i) => {
    if (i) span.appendChild(document.createElement('br'));
    span.appendChild(document.createTextNode(line));
  });
  box.appendChild(span); host.appendChild(box);
  document.body.appendChild(host);

  try {
    // one measuring pass, because the targets range from a wide name band to a square avatar
    const fit = Math.min((box.clientWidth - pad * 2) / span.offsetWidth,
                         (box.clientHeight - pad * 2) / span.offsetHeight);
    span.style.fontSize = Math.max(8, Math.floor(100 * fit)) + 'px';
    return await rasterise(box, { scale: 1 });
  } finally {
    host.remove();
    style.remove();
  }
}
