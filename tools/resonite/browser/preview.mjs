// Show the add-contact button on the card in the site, before anyone exports anything.
//
// The button is placed by searching the face for a corner nothing is drawn in, which is the
// right design — no template reserves a spot — but it made the result invisible until you had
// the package open in Resonite. This draws it on the preview, in the place and the colours it
// will actually have, so choosing a corner is a thing you can see rather than guess at.
//
// It is the SAME element the export rasterises (button.mjs buildContactBadge) at the SAME box
// (badge.mjs badgeBox) in the SAME colours (overlay.mjs cardTheme, off the same plate the
// exporter reads) — not a mock-up that has to be kept looking alike.
//
// Nothing is inserted into the app's own DOM. The overlay is a fixed-position layer on
// document.body, clipped to the stage, positioned from the visible card's bounding box. The app
// re-renders its whole card subtree on every keystroke; an unmanaged child inside it would be
// destroyed, or worse, confuse the diff.

import { measureFace } from './capture.mjs';
import { rasterise } from './raster.mjs';
import { cardTheme } from './overlay.mjs';
import { buildContactBadge } from './button.mjs';
import { badgeBox } from '../badge.mjs';
import { drewOwnButton } from '../scene.mjs';
import { inkFor } from '../colour.mjs';

const LAYER = 'data-dc-contact-preview';
const SETTLE = 380;      // ms of quiet before the plate is read again

let layer = null, chip = null, timer = 0, raf = 0;
let want = { on: false, spot: 'auto', side: 'both' };
let themeCache = null;   // { sig, theme }
let reading = false;

/* A fingerprint of what the front face currently looks like. Colours live in inline styles, so
   two cards can differ only in a hex digit — the length of the markup is not enough to tell
   them apart, and re-reading the plate on every keystroke is not affordable. */
function fingerprint(el) {
  const s = el.innerHTML;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${h}|${s.length}|${Math.round(el.getBoundingClientRect().width)}`;
}

/** The card the user is looking at — not #oshi-front-node, which is the off-screen measuring copy. */
function visibleFront(side) {
  if (side === 'back') return null;
  const stage = document.getElementById('oshi-stage');
  if (!stage) return null;
  /* The preview is drawn inside one scaled row. It is the first transformed element under the
     stage in document order — the card's own transformed bits (a rotated stamp, a tilted photo)
     are all descendants of it, so they can never be found first. */
  const row = [...stage.querySelectorAll('div')].find(e =>
    !e.closest('#oshi-front-node') && !e.closest('#oshi-back-node') &&
    getComputedStyle(e).transform !== 'none' && e.children.length > 0);
  const card = row?.children[0];              // front first, back second; back-only returned above
  const r = card?.getBoundingClientRect();
  return r && r.width > 8 ? { card, rect: r, stage: stage.getBoundingClientRect() } : null;
}

function teardown() {
  cancelAnimationFrame(raf); raf = 0;
  layer?.remove();
  layer = chip = null;
}

/** Keep the overlay over the card as the stage scrolls, the window resizes, the card rescales. */
function follow(box, cardW) {
  cancelAnimationFrame(raf);
  const tick = () => {
    const v = visibleFront(want.side);
    if (!want.on || !v || !layer) { teardown(); return; }
    const k = v.rect.width / cardW;
    Object.assign(layer.style, { left: `${v.stage.left}px`, top: `${v.stage.top}px`,
      width: `${v.stage.width}px`, height: `${v.stage.height}px` });
    Object.assign(chip.style, {
      left: `${v.rect.left - v.stage.left + box.x * k}px`,
      top: `${v.rect.top - v.stage.top + box.y * k}px`,
      width: `${box.w * k}px`, height: `${box.h * k}px` });
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

async function paint() {
  const el = document.getElementById('oshi-front-node');
  const v = visibleFront(want.side);
  if (!want.on || !el || !v) { teardown(); return; }

  const { data, textEls, gfxEls } = measureFace(el);
  // a template that prints its own button is already showing it — a chip would be a second one
  if (drewOwnButton(data)) { teardown(); return; }

  const sig = fingerprint(el);
  if (themeCache?.sig !== sig) {
    /* A read is already in flight for an older card. Come back rather than dropping this one:
       the in-flight read will store a fingerprint that no longer matches, and without a retry
       the preview would sit on a stale colour until the next thing the user touched. */
    if (reading) { clearTimeout(timer); timer = setTimeout(() => { paint().catch(teardown); }, SETTLE); return; }
    reading = true;
    try {
      /* Exactly the plate the standard export reads its colours from: the face with its text
         and graphics hidden. Reading a different picture would give a different accent, and the
         preview would promise a colour the package does not deliver. */
      const hidden = new Set([...textEls, ...gfxEls]);
      const bg = await rasterise(el, { scale: 1, hide: (n) => hidden.has(n) });
      themeCache = { sig, theme: await cardTheme(bg, { faces: { front: data } }) };
    } catch { themeCache = themeCache || { sig, theme: null }; }
    finally { reading = false; }
    if (!want.on) { teardown(); return; }
  }
  const theme = themeCache?.theme;
  if (!theme) { teardown(); return; }

  const box = badgeBox(data, { spot: want.spot, extra: [] });
  const k = v.rect.width / data.card.w;
  const fam = (data.layers.find(L => L.family) || {}).family;

  if (!layer) {
    layer = document.createElement('div');
    layer.setAttribute(LAYER, '');
    // clipped to the stage, so a scrolled-away card does not leave its button floating
    layer.style.cssText = 'position:fixed;overflow:hidden;pointer-events:none;z-index:30';
    document.body.appendChild(layer);
  }
  chip?.remove();
  chip = buildContactBadge({ w: Math.round(box.w * k), h: Math.round(box.h * k),
                             plate: theme.accent, ink: inkFor(theme.accentRGB, theme),
                             family: fam, icon: data.card.w >= data.card.h ? 'landscape' : 'vertical' });
  chip.style.position = 'absolute';
  // a hairline ring, only in the preview: the exported chip sits ON the card in world, and on a
  // card whose accent is close to its paper the preview needs to read as an object on top of it
  chip.style.boxShadow = '0 1px 4px rgba(0,0,0,.30)';
  layer.appendChild(chip);
  chip.__fit();
  follow(box, data.card.w);
}

/**
 * Called by the app on mount and on every update.
 * @param on    whether the export will include the button
 * @param spot  'auto' or a named corner — the same value the export is given
 * @param side  which face the preview is showing; 'back' means there is nothing to draw on
 */
export function contactPreview({ on = true, spot = 'auto', side = 'both' } = {}) {
  want = { on, spot, side };
  clearTimeout(timer);
  if (!on || side === 'back') { teardown(); return; }
  timer = setTimeout(() => { paint().catch(() => teardown()); }, SETTLE);
}
