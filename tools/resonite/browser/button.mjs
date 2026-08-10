// The dispenser's button face: one of the two card icons on a backing, in the card's colours.
//
// Ports icon.mjs's renderButtonFace off Playwright and pngjs. Deliberately NOT card-shaped — it
// has to read as something to press rather than as another card lying around.

import { rasterise } from './raster.mjs';
import { CARD_ICONS } from './icons.mjs';

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
