// The dispenser's button face: one of the two card icons on a backing, in the card's own
// colours. Kept out of build_instancer.mjs because it is the piece with real choices in it
// — shape, colours, transparency — and those choices are meant to reach the app later as
// export options rather than staying hardcoded here.
//
//   icon     landscape | vertical | auto   (auto follows the card's orientation)
//   backing  square    | pill     | none   (none = the icon alone, no plate behind it)
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
export async function renderButtonFace(page, { iconFile, size = 512, ink, backing, backingColor, dir }) {
  let svg = readFileSync(new URL(`./icons/${iconFile}`, dir), 'utf8');
  svg = svg.replace(/<\?xml[^>]*\?>/, '').replace(/fill="#000000"/g, `fill="${ink}"`)
           .replace(/(width|height)="\d+px"/g, '');
  const radius = backing === 'pill' ? '50%' : backing === 'square' ? `${Math.round(size * 0.22)}px` : '0';
  const plate = backing === 'none' ? 'transparent' : backingColor;
  const pad = backing === 'none' ? 0.02 : backing === 'pill' ? 0.22 : 0.18;
  const inset = Math.round(size * pad);

  await page.setContent(`<body style="margin:0;background:transparent">
    <div id="dc-btn" style="width:${size}px;height:${size}px;border-radius:${radius};
         background:${plate};display:flex;align-items:center;justify-content:center;
         box-sizing:border-box;padding:${inset}px">
      <div style="width:100%;height:100%;display:flex">${svg}</div></div></body>`);
  await page.evaluate(() => { const s = document.querySelector('#dc-btn svg');
    s.setAttribute('width', '100%'); s.setAttribute('height', '100%');
    s.style.width = '100%'; s.style.height = '100%'; });
  return page.locator('#dc-btn').screenshot({ omitBackground: true });
}
