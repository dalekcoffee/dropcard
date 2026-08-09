// Colour maths shared by the card builder and the icon renderer. Pure arithmetic, no I/O —
// which is what lets the browser export reuse it unchanged.

export const hex = ([r, g, b]) =>
  '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

// Deliberately the plain weighted average rather than the gamma-corrected WCAG relative
// luminance. Every threshold in cardTheme and inkFor was tuned against this curve; swapping in
// the "more correct" one re-picks accents and inks across the whole template set.
export const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

export const sat = ([r, g, b]) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
};

// WCAG-ish contrast, enough to choose between two candidate inks
export const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// Which ink reads on this backing: the card's paper if it stands out, otherwise plain
// white or near-black. A themed button that cannot be read is not on theme.
export function inkFor(backingRGB, theme) {
  const candidates = [theme.surfaceRGB, [255, 255, 255], [17, 17, 24]];
  return hex(candidates.find(c => contrast(c, backingRGB) >= 3.5) ??
             candidates.sort((a, b) => contrast(b, backingRGB) - contrast(a, backingRGB))[0]);
}
