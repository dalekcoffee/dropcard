// Real TrueType for a family+weight, fetched from a page.
//
// A page cannot set a User-Agent, so Google's css2 endpoint always serves it woff2 — and
// Resonite draws every glyph of a woff2 as a NO GLYPH box, because for an extensionless
// packdb:// URL it sniffs the format from the file's own bytes and does not recognise 'wOF2'.
// That was settled by importing one, not guessed.
//
// The Google Fonts REPOSITORY holds the original TrueType, serves
// `access-control-allow-origin: *`, and its URLs end in .ttf. It is the only source a browser
// can use, so the browser export always takes this route where the Node build defaults to the
// CDN. The cost is that most families are variable-only there, and StaticFont has no variation
// axis — hence scene.mjs's synthetic weight, which thickens the glyphs at the material level.

const STYLE = { 100:'Thin', 200:'ExtraLight', 300:'Light', 400:'Regular', 500:'Medium',
                600:'SemiBold', 700:'Bold', 800:'ExtraBold', 900:'Black' };
const RAW = 'https://raw.githubusercontent.com/google/fonts/main';

// Cards can name a system face (a monospace tag set in "Courier New", say) that Google either
// doesn't host or serves from an extensionless URL. Substitute the nearest family we can
// actually bundle rather than shipping a card with no glyphs.
const FALLBACK = [
  [/mono|courier|consol|menlo/i,             'Space Mono'],
  [/serif|georgia|times|garamond|playfair/i, 'Newsreader'],
  [/./,                                      'Lexend'],
];
const substitute = (family) => (FALLBACK.find(([re]) => re.test(family)) || [, 'Lexend'])[1];

async function fromRepo(family, weight, log) {
  const slug = family.toLowerCase().replace(/[^a-z0-9]/g, '');
  const camel = family.replace(/[^A-Za-z0-9]/g, '');
  const style = STYLE[weight] ?? 'Regular';
  // A static per-weight file first: a variable font imports at its default instance, so a 700
  // run would come out at 400. The variable file is the fallback, not the preference.
  const candidates = [];
  for (const lic of ['ofl', 'apache', 'ufl']) {
    candidates.push(`${lic}/${slug}/static/${camel}-${style}.ttf`);
    candidates.push(`${lic}/${slug}/${camel}-${style}.ttf`);
    candidates.push(`${lic}/${slug}/${camel}%5Bwght%5D.ttf`);
    candidates.push(`${lic}/${slug}/${camel}%5Bopsz,wght%5D.ttf`);
  }
  for (const path of candidates) {
    try {
      const r = await fetch(`${RAW}/${path}`);
      if (!r.ok) continue;
      const bytes = new Uint8Array(await r.arrayBuffer());
      const magic = [...bytes.slice(0, 4)].map(b => b.toString(16).padStart(2, '0')).join('');
      if (magic !== '00010000' && magic !== '4f54544f') continue;   // TrueType / OpenType-CFF
      return { bytes, family, weight, variable: path.includes('%5B') };
    } catch { /* try the next candidate */ }
  }
  const alt = substitute(family);
  if (alt !== family) {
    const viaAlt = await fromRepo(alt, weight, log).catch(() => null);
    if (viaAlt) { log(`${family} ${weight} is not in the fonts repo — using ${alt}`);
                  return { ...viaAlt, substitutedFor: family }; }
  }
  throw new Error(`no TrueType available for ${family} ${weight}`);
}

/** A fetcher with a cache, shaped as scene.mjs's fontFor. */
export function fontLoader(log = () => {}) {
  const cache = new Map();
  return (family, weight) => {
    const k = `${family}|${weight}`;
    if (!cache.has(k)) cache.set(k, fromRepo(family, weight, log));
    return cache.get(k);
  };
}
