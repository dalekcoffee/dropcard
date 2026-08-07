// The dispenser's button face: one of the two card icons on a backing, in the card's own
// colours. Kept out of build_instancer.mjs because it is the piece with real choices in it
// — shape, colours, transparency — and those choices are meant to reach the app later as
// export options rather than staying hardcoded here.
//
//   icon     landscape | vertical | auto   (auto follows the card's orientation)
//   backing  rounded | square | circle | none   (none = the icon alone, no plate behind it)
//   colours  a #rrggbb, or 'theme' to take them from the card
//
// Everything is rasterised in the browser that is already open for the capture, so the SVG
// is rendered by the same engine that renders the cards rather than by a second SVG stack.
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

export const ICONS = { landscape:'CardIconLandscape.svg', vertical:'CardIconVertical.svg' };

const hex = ([r, g, b]) => '#' + [r, g, b].map(v =>
  Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const lum = ([r, g, b]) => (0.2126*r + 0.7152*g + 0.0722*b) / 255;
const sat = ([r, g, b]) => { const mx = Math.max(r,g,b), mn = Math.min(r,g,b);
  return mx === 0 ? 0 : (mx - mn) / mx; };
// WCAG-ish contrast, enough to choose between two candidate inks
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05); };

// The card's own colours, read back out of what was already captured: the plate raster for
// the paper, the text runs for the ink and the accent. No template needs to declare a theme.
export function cardTheme(job, prefix, dir) {
  const png = PNG.sync.read(readFileSync(new URL(`./${prefix}-bg-front.png`, dir)));
  const bins = new Map();
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i+3] < 250) continue;
    const k = (png.data[i] >> 4) * 256 + (png.data[i+1] >> 4) * 16 + (png.data[i+2] >> 4);
    bins.set(k, (bins.get(k) ?? 0) + 1);
  }
  const unbin = k => [((k / 256) | 0) * 17, (((k / 16) | 0) % 16) * 17, (k % 16) * 17];
  const byCount = [...bins].sort((a, b) => b[1] - a[1]);
  const surface = unbin(byCount[0][0]);

  // accent: the most saturated colour the card actually spends area on. Near-blacks are
  // excluded by the brightness floor — #110000 is technically fully saturated and is just
  // ink. Printed bands beat text, because a template's accent is usually a filled area
  // (Ticket's header) while its saturated text can be a one-off heading.
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
  return { surface: hex(surface), accent: hex(accent),
           surfaceRGB: surface, accentRGB: accent };
}

// Which ink reads on this backing: the card's paper if it stands out, otherwise plain
// white or near-black. A themed button that cannot be read is not on theme.
export function inkFor(backingRGB, theme) {
  const candidates = [theme.surfaceRGB, [255,255,255], [17,17,24]];
  return hex(candidates.find(c => contrast(c, backingRGB) >= 3.5) ??
             candidates.sort((a, b) => contrast(b, backingRGB) - contrast(a, backingRGB))[0]);
}

export function resolveIcon(which, job) {
  if (which === 'landscape' || which === 'vertical') return ICONS[which];
  const f = job.faces.front.card;                       // auto: follow the card
  return f.w >= f.h ? ICONS.landscape : ICONS.vertical;
}

// Rasterise backing + icon to a square PNG. `page` is an already-open Playwright page.
export const BACKINGS = {
  // radius as a fraction of the face, and how far the icon insets from the backing's edge.
  // A circle takes the LEAST inset, not the most: the icons are widest across their middle,
  // which is exactly where a circle is furthest out, so they sit in it comfortably.
  rounded: { radius: 0.22, pad: 0.18 },
  square:  { radius: 0,    pad: 0.18 },
  circle:  { radius: 0.5,  pad: 0.15 },
  none:    { radius: 0,    pad: 0.02 },
};

// How far the drawn ink should reach, as a fraction of the face's half-size. Fitting the
// icon's BOX to the backing is not enough: the landscape badge fills its viewBox edge to
// edge, while the diagonal one is a diamond inscribed in the same square, so the same box
// leaves it visibly smaller. Measuring the ink and scaling to a common target makes any
// icon carry the same weight, including ones added later.
const INK_REACH = { rounded: 0.66, square: 0.66, circle: 0.88, none: 0.92 };

async function draw(page, { svg, size, radius, plate, boxFrac }) {
  const box = Math.round(size * boxFrac);
  await page.setContent(`<body style="margin:0;background:transparent">
    <div id="dc-btn" style="width:${size}px;height:${size}px;border-radius:${radius};
         background:${plate};display:flex;align-items:center;justify-content:center;
         box-sizing:border-box">
      <div style="width:${box}px;height:${box}px;display:flex">${svg}</div></div></body>`);
  await page.evaluate(() => { const s = document.querySelector('#dc-btn svg');
    s.setAttribute('width', '100%'); s.setAttribute('height', '100%');
    s.style.width = '100%'; s.style.height = '100%'; });
  return page.locator('#dc-btn').screenshot({ omitBackground: true });
}

export async function renderButtonFace(page, { iconFile, size = 512, ink, backing, backingColor, dir }) {
  let svg = readFileSync(new URL(`./icons/${iconFile}`, dir), 'utf8');
  svg = svg.replace(/<\?xml[^>]*\?>/, '').replace(/fill="#000000"/g, `fill="${ink}"`)
           .replace(/(width|height)="\d+px"/g, '');
  const spec = BACKINGS[backing];
  const radius = spec.radius >= 0.5 ? '50%' : `${Math.round(size * spec.radius)}px`;
  const plate = backing === 'none' ? 'transparent' : backingColor;
  const round = backing === 'circle';

  // probe with no backing, so only the icon's own ink is measured, then scale to the target
  const probeFrac = 1 - 2 * spec.pad;
  const probe = PNG.sync.read(await draw(page, { svg, size:256, radius:'0',
    plate:'transparent', boxFrac:probeFrac }));
  const c = 128; let reach = 0;
  for (let y = 0; y < probe.height; y++) for (let x = 0; x < probe.width; x++) {
    if (probe.data[(y * probe.width + x) * 4 + 3] < 128) continue;
    const dx = Math.abs(x + 0.5 - c), dy = Math.abs(y + 0.5 - c);
    reach = Math.max(reach, round ? Math.hypot(dx, dy) : Math.max(dx, dy));
  }
  const grow = reach > 0 ? Math.min(1.6, Math.max(1, (INK_REACH[backing] * c) / reach)) : 1;
  return draw(page, { svg, size, radius, plate, boxFrac: probeFrac * grow });
}
