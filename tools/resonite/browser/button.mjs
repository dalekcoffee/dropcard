// The buttons this exporter draws, in the card's own colours.
//
//   renderButtonFace     the dispenser's face: one of the two card icons on a backing. Ports
//                        icon.mjs's off Playwright and pngjs. Deliberately NOT card-shaped —
//                        it has to read as something to press rather than as another card
//                        lying around.
//   renderContactBadge   the "Add contact" chip that sits on the card itself.

import { rasterise } from './raster.mjs';
import { CARD_ICONS } from './icons.mjs';
import { b64 } from './overlay.mjs';

// radius as a fraction of the face, and how far the icon insets from the backing's edge.
// A circle takes the LEAST inset, not the most: the icons are widest across their middle,
// which is exactly where a circle is furthest out, so they sit in it comfortably.
export const BACKINGS = {
  rounded: { radius: 0.22, pad: 0.18 },
  square:  { radius: 0,    pad: 0.18 },
  circle:  { radius: 0.5,  pad: 0.15 },
  none:    { radius: 0,    pad: 0.02 },
};

/* How far the drawn ink should reach, as a fraction of the face's half-size. Fitting the icon's
   BOX to the backing is not enough: the landscape badge fills its viewBox edge to edge, while
   the diagonal one is a diamond inscribed in the same square, so the same box leaves it visibly
   smaller. Measuring the ink and scaling to a common target makes any icon carry the same
   weight, including ones added later. */
const INK_REACH = { rounded: 0.66, square: 0.66, circle: 0.88, none: 0.92 };

async function draw({ svg, size, radius, plate, boxFrac }) {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;z-index:-1;pointer-events:none';
  const box = document.createElement('div');
  Object.assign(box.style, { width: `${size}px`, height: `${size}px`, borderRadius: radius,
    background: plate, display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxSizing: 'border-box' });
  const inner = document.createElement('div');
  const b = Math.round(size * boxFrac);
  Object.assign(inner.style, { width: `${b}px`, height: `${b}px`, display: 'flex' });
  inner.innerHTML = svg;
  const s = inner.querySelector('svg');
  if (s) { s.setAttribute('width', '100%'); s.setAttribute('height', '100%');
           s.style.width = '100%'; s.style.height = '100%'; }
  box.appendChild(inner); host.appendChild(box);
  document.body.appendChild(host);
  try { return await rasterise(box, { scale: 1 }); } finally { host.remove(); }
}

const alphaOf = async (png) => {
  const bmp = await createImageBitmap(new Blob([png], { type: 'image/png' }));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0);
  const d = x.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return d;
};

/** auto follows the card's own orientation */
export const resolveIcon = (which, job) => {
  if (which === 'landscape' || which === 'vertical') return which;
  const f = job.faces.front.card;
  return f.w >= f.h ? 'landscape' : 'vertical';
};

export async function renderButtonFace({ icon = 'auto', job, size = 512, ink,
                                         backing = 'rounded', backingColor }) {
  const spec = BACKINGS[backing];
  if (!spec) throw new Error(`unknown backing "${backing}" — one of ${Object.keys(BACKINGS).join(', ')}`);
  const which = resolveIcon(icon, job);
  const svg = CARD_ICONS[which]
    .replace(/<\?xml[^>]*\?>/, '')
    .replace(/fill="#000000"/g, `fill="${ink}"`)
    .replace(/(width|height)="\d+px"/g, '');

  const radius = spec.radius >= 0.5 ? '50%' : `${Math.round(size * spec.radius)}px`;
  const plate = backing === 'none' ? 'transparent' : backingColor;
  const round = backing === 'circle';

  // probe with no backing, so only the icon's own ink is measured, then scale to the target
  const probeFrac = 1 - 2 * spec.pad;
  const probe = await alphaOf(await draw({ svg, size: 256, radius: '0', plate: 'transparent',
                                           boxFrac: probeFrac }));
  const c = probe.width / 2;
  let reach = 0;
  for (let y = 0; y < probe.height; y++) for (let x = 0; x < probe.width; x++) {
    if (probe.data[(y * probe.width + x) * 4 + 3] < 128) continue;
    const dx = Math.abs(x + 0.5 - c), dy = Math.abs(y + 0.5 - c);
    reach = Math.max(reach, round ? Math.hypot(dx, dy) : Math.max(dx, dy));
  }
  const grow = reach > 0 ? Math.min(1.6, Math.max(1, (INK_REACH[backing] * c) / reach)) : 1;
  const png = await draw({ svg, size, radius, plate, boxFrac: probeFrac * grow });
  return { png, icon: which };
}

/* ── the add-contact chip ────────────────────────────────────────────────────
 *
 * Drawn rather than assembled from a text run and a quad, for the same reason the hover label
 * is: it has to look like it belongs to the template, and a TextRenderer would need the card's
 * typeface embedded even for a baked export, which otherwise pulls no fonts at all.
 *
 * The card icon carries the label. It is the mark the dispenser already uses, so a dropcard
 * reads the same on the card, on its dispenser and in the site's own menu. */
const BADGE_LABEL = 'Add contact';

export async function renderContactBadge({ w, h, plate, ink, fontBytes, family,
                                           label = BADGE_LABEL, icon = 'landscape' }) {
  const K = Math.max(3, Math.min(9, 640 / Math.max(1, w)));
  const W = Math.round(w * K), H = Math.round(h * K);
  const padX = Math.round(H * 0.40), gap = Math.round(H * 0.26);
  const glyph = Math.round(H * 0.56);
  const stack = fontBytes ? `"dc-badge-face", ${family || 'sans-serif'}` : (family || 'sans-serif');

  // Same trick overlay.mjs uses: the rasteriser's clone is sealed and can only draw with faces
  // the document already declares, and a data: URI src passes through it untouched.
  const style = document.createElement('style');
  style.textContent = fontBytes
    ? `@font-face{font-family:"dc-badge-face";src:url(data:font/ttf;base64,${b64(fontBytes)}) format("truetype")}`
    : '';
  document.head.appendChild(style);
  if (fontBytes) { try { await document.fonts.load('16px "dc-badge-face"'); } catch { /* fall back */ } }

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;z-index:-1;pointer-events:none';
  const box = document.createElement('div');
  Object.assign(box.style, { width: `${W}px`, height: `${H}px`, borderRadius: `${H / 2}px`,
    background: plate, display: 'flex', alignItems: 'center', justifyContent: 'center',
    gap: `${gap}px`, boxSizing: 'border-box', padding: `0 ${padX}px`, overflow: 'hidden' });

  const mark = document.createElement('div');
  Object.assign(mark.style, { width: `${glyph}px`, height: `${glyph}px`, flex: 'none', display: 'flex' });
  mark.innerHTML = (CARD_ICONS[icon] || CARD_ICONS.landscape)
    .replace(/<\?xml[^>]*\?>/, '')
    .replace(/fill="#000000"/g, `fill="${ink}"`)
    .replace(/(width|height)="\d+px"/g, '');
  const s = mark.querySelector('svg');
  if (s) { s.setAttribute('width', '100%'); s.setAttribute('height', '100%');
           s.style.width = '100%'; s.style.height = '100%'; }

  const span = document.createElement('span');
  Object.assign(span.style, { fontFamily: stack, fontSize: `${Math.round(H * 0.46)}px`,
    fontWeight: '600', lineHeight: '1', color: ink, whiteSpace: 'nowrap',
    letterSpacing: '0.005em' });
  span.textContent = label;

  box.appendChild(mark); box.appendChild(span); host.appendChild(box);
  document.body.appendChild(host);
  try {
    /* One measuring pass. The chip's width comes from the card, not from the label, so on a
       template where it had to shrink the words have to come back to meet it — and a chip
       reading "Add conta" is worse than a slightly small one. */
    const room = W - padX * 2 - glyph - gap;
    if (span.offsetWidth > room)
      span.style.fontSize = Math.max(8, Math.floor(parseFloat(span.style.fontSize) * room / span.offsetWidth)) + 'px';
    return await rasterise(box, { scale: 1 });
  } finally { host.remove(); style.remove(); }
}
