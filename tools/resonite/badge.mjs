// Where the "Add contact" button goes on a card face.
//
// Pure geometry, no DOM and no Node, so the same placement runs in the build script and in the
// page — and can be tested on a captured face without rendering anything.
//
// The problem it solves: add-contact used to live only on the name run and the profile picture.
// That works when a template HAS both, and reads as nothing at all when it does not — a card
// whose name is drawn as artwork, or which shows no photo, exported with no way to add the
// person. Every template gets a real button instead, and the only question left is where it can
// sit without covering something.
//
// The answer is found rather than declared: no template needs to reserve a spot, and none of
// them has to be edited when one is added. The face's own measurements say what is occupied,
// and the button takes the emptiest corner that is left.

/** How big the button is, relative to the card. Chip-sized — it sits among the social chips. */
const H_FRAC = 0.058, H_MIN = 24, H_MAX = 46, ASPECT = 3.4;
/** Clear space kept around anything already drawn, and around the card's own edge. */
const CLEAR = 8, MARGIN_FRAC = 0.035;
/** Tried in order until one fits; below the last the button is too small to read. */
const SHRINK = [1, 0.88, 0.76, 0.64];

/* Corners, in the order a reader's eye forgives them. Bottom-right first: on a landscape card
   the top is the name and the left is the picture, and on a portrait one the bottom strip is
   the only band that is reliably free. The weights only break ties between corners that all
   have room — a corner that actually fits always beats a preferred one that does not. */
const CORNERS = [
  { spot: 'bottom-right', ax: 1, ay: 1, weight: 1.00 },
  { spot: 'bottom-left',  ax: 0, ay: 1, weight: 1.06 },
  { spot: 'top-right',    ax: 1, ay: 0, weight: 1.18 },
  { spot: 'top-left',     ax: 0, ay: 0, weight: 1.26 },
];

export const BADGE_SPOTS = ['auto', ...CORNERS.map(c => c.spot)];

const inflate = (r, p) => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p });
const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Everything on this face a button must not cover. */
function occupancy(face, extra = []) {
  const out = [];
  for (const L of face.layers || []) out.push(L.tight || { x: L.x, y: L.y, w: L.w, h: L.h });
  for (const g of face.gfx || []) out.push({ x: g.x, y: g.y, w: g.w, h: g.h });
  for (const l of face.links || []) out.push({ x: l.x, y: l.y, w: l.w, h: l.h });
  if (face.avatar) out.push({ x: face.avatar.x, y: face.avatar.y, w: face.avatar.w, h: face.avatar.h });
  for (const e of extra) out.push({ x: e.x, y: e.y, w: e.w, h: e.h });
  return out.map(r => inflate(r, CLEAR));
}

/** Every position the button may take, stepped across the face and always including the edges. */
function candidates(len, size, margin, step) {
  const last = len - margin - size;
  if (last < margin) return [];
  const out = [];
  for (let v = margin; v < last; v += step) out.push(v);
  out.push(last);
  return out;
}

/** The free position nearest this corner, or null if the corner has no room at all. */
function nearestFree(corner, { W, H, w, h, margin, blocked, step }) {
  const xs = candidates(W, w, margin, step), ys = candidates(H, h, margin, step);
  if (!xs.length || !ys.length) return null;
  const cx = corner.ax ? xs[xs.length - 1] : xs[0];
  const cy = corner.ay ? ys[ys.length - 1] : ys[0];
  let best = null;
  for (const y of ys) for (const x of xs) {
    const box = { x, y, w, h };
    if (blocked.some(o => hits(box, o))) continue;
    const d = Math.hypot(x - cx, y - cy);
    if (!best || d < best.d) best = { d, box };
  }
  return best;
}

/**
 * Pick the button's box on a face.
 *
 * @param face   one side of a capture — { card, layers, gfx, links, avatar }
 * @param spot   'auto' or one of BADGE_SPOTS; an explicit corner is honoured even if it has to
 *               shrink or, in the last resort, overlap
 * @param extra  boxes that are not in the capture but are already spoken for — the name and
 *               photo contact targets, which are placed before this one
 * @returns { x, y, w, h, spot, tight, over } — `tight` means it had to shrink, `over` means
 *          nothing was free and it is sitting on top of the card's own artwork
 */
export function badgeBox(face, { spot = 'auto', extra = [] } = {}) {
  const W = face.card.w, H = face.card.h;
  const short = Math.min(W, H);
  const margin = Math.round(short * MARGIN_FRAC);
  const h0 = Math.round(Math.max(H_MIN, Math.min(H_MAX, short * H_FRAC)));
  const step = Math.max(4, Math.round(short / 100));

  const wanted = spot === 'auto' ? CORNERS : CORNERS.filter(c => c.spot === spot);
  if (!wanted.length) throw new Error(`unknown add-contact spot "${spot}" — one of ${BADGE_SPOTS.join(', ')}`);

  const solid = occupancy(face, extra);
  // decoration is worth covering before the button is shrunk past legibility or dropped
  // altogether: a pattern behind the corner is not information, a line of text is
  const firm = occupancy({ ...face, gfx: [] }, extra);

  for (const blocked of [solid, firm]) {
    for (const k of SHRINK) {
      const h = Math.round(h0 * k), w = Math.round(h * ASPECT);
      if (w > W - 2 * margin) continue;
      let best = null;
      for (const c of wanted) {
        const f = nearestFree(c, { W, H, w, h, margin, blocked, step });
        if (!f) continue;
        const score = f.d * c.weight;
        if (!best || score < best.score) best = { score, box: f.box, spot: c.spot };
      }
      if (best) return { ...best.box, spot: best.spot, tight: k < 1, over: blocked === firm };
    }
  }

  /* Nothing was free at any size. Put it in the preferred corner anyway: a button that overlaps
     the artwork is recoverable — it can be dragged in world — and no button is not. */
  const c = wanted[0];
  const h = Math.round(h0 * SHRINK[SHRINK.length - 1]), w = Math.round(h * ASPECT);
  return { x: c.ax ? Math.max(margin, W - margin - w) : margin,
           y: c.ay ? Math.max(margin, H - margin - h) : margin,
           w: Math.min(w, W - 2 * margin), h, spot: c.spot, tight: true, over: true };
}
