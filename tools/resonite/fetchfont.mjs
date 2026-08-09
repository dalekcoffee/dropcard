// Resolve a font family+weight to real TrueType bytes.
// css2 serves woff2 to modern UAs and EOT to an IE UA; an old Android UA is the one that
// yields TrueType, which is what Resonite's StaticFont wants.
const UA = 'Mozilla/5.0 (Linux; U; Android 2.2; en-us; Nexus One Build/FRF91) '
         + 'AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1';

// Cards can name a system face (a monospace tag set in "Courier New", say) that Google
// either doesn't host or serves from an extensionless /l/font URL. Substitute the nearest
// family we can actually bundle rather than shipping a card with no glyphs.
const FALLBACK = [
  [/mono|courier|consol|menlo/i,            'Space Mono'],
  [/serif|georgia|times|garamond|playfair/i,'Newsreader'],
  [/./,                                     'Lexend'],
];
const substitute = (family) => (FALLBACK.find(([re]) => re.test(family)) || [, 'Lexend'])[1];

// A browser cannot set User-Agent, so a page always gets woff2 — which is what the site
// export will have to embed. FontX.Load lists woff2, but for a packdb:// URL with no suffix
// Resonite sniffs the extension from content (Font.cs:262) using a library outside the
// decompiled set, so whether it recognises 'wOF2' has to be settled by importing one.
const MODERN_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) '
                + 'Chrome/126.0.0.0 Safari/537.36';

export async function fetchWOFF2(family, weight = 400) {
  const q = `family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${weight}`;
  const css = await (await fetch(`https://fonts.googleapis.com/css2?${q}`,
    { headers:{ 'User-Agent':MODERN_UA } })).text();
  const m = /url\((https:[^)]+?\.woff2)\)/.exec(css);
  if (!m) throw new Error(`no woff2 for ${family} ${weight}`);
  const bytes = new Uint8Array(await (await fetch(m[1], { headers:{ 'User-Agent':MODERN_UA } })).arrayBuffer());
  const magic = Buffer.from(bytes.slice(0, 4)).toString('hex');
  if (magic !== '774f4632') throw new Error(`${family}: not woff2 (magic ${magic})`);   // 'wOF2'
  return { bytes, magic, url:m[1], family, weight };
}

async function tryFetch(family, weight) {
  const q = `family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${weight}`;
  const css = await (await fetch(`https://fonts.googleapis.com/css2?${q}`, { headers:{ 'User-Agent':UA } })).text();
  // prefer an explicit .ttf; otherwise take whatever the sheet declares as truetype
  const m = /url\((https:[^)]+?\.ttf)\)/.exec(css)
         || /url\((https:[^)]+?)\)\s*format\(['"]truetype['"]\)/.exec(css);
  if (!m) return null;
  const r = await fetch(m[1], { headers:{ 'User-Agent':UA } });
  if (!r.ok) return null;
  const bytes = new Uint8Array(await r.arrayBuffer());
  const magic = Buffer.from(bytes.slice(0, 4)).toString('hex');
  // 00010000 = TrueType, 4f54544f = 'OTTO' (OpenType/CFF). Anything else isn't a font.
  if (magic !== '00010000' && magic !== '4f54544f') return null;
  return { bytes, magic, url:m[1], family, weight };
}

// The route a BROWSER can use. css2 picks its format from the User-Agent, which a page
// cannot set, so a tab is always served woff2 — and Resonite will not take woff2 from an
// extensionless packdb:// URL: it loads the file and renders every glyph as a NO GLYPH box,
// because the extension is sniffed from content (Font.cs:262) and the sniffer does not know
// 'wOF2'. Tested in-world; that is not a guess.
//
// The Google Fonts REPOSITORY, though, holds the original TrueType, serves
// `access-control-allow-origin: *`, and its URLs end in .ttf. Same bytes a browser can
// actually reach, and an explicit extension so nothing has to be sniffed.
const STYLE = { 100:'Thin', 200:'ExtraLight', 300:'Light', 400:'Regular', 500:'Medium',
                600:'SemiBold', 700:'Bold', 800:'ExtraBold', 900:'Black' };
const RAW = 'https://raw.githubusercontent.com/google/fonts/main';

export async function fetchTTFFromRepo(family, weight = 400) {
  const slug = family.toLowerCase().replace(/[^a-z0-9]/g, '');
  const camel = family.replace(/[^A-Za-z0-9]/g, '');
  const style = STYLE[weight] ?? 'Regular';
  // A static per-weight file first: a variable font would import at its default instance, so
  // a 700 run would come out at 400. The variable file is the fallback, not the preference.
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
      if (magic !== '00010000' && magic !== '4f54544f') continue;
      return { bytes, magic, url: `${RAW}/${path}`, family, weight,
               variable: path.includes('%5B') };
    } catch { /* try the next candidate */ }
  }
  const alt = substitute(family);
  if (alt !== family) {
    const viaAlt = await fetchTTFFromRepo(alt, weight).catch(() => null);
    if (viaAlt) { console.log(`     ! ${family} ${weight} not in the fonts repo — substituted ${alt}`);
                  return { ...viaAlt, substitutedFor: family }; }
  }
  throw new Error(`no TTF in the Google Fonts repo for ${family} ${weight}`);
}

export async function fetchTTF(family, weight = 400) {
  const direct = await tryFetch(family, weight).catch(() => null);
  if (direct) return direct;
  const alt = substitute(family);
  const viaAlt = alt !== family ? await tryFetch(alt, weight).catch(() => null) : null;
  if (viaAlt) { console.log(`     ! ${family} ${weight} unavailable as TTF — substituted ${alt}`); return { ...viaAlt, substitutedFor:family }; }
  throw new Error(`no usable TTF for ${family} ${weight} (and fallback ${alt} failed)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [fam, w] of [['Lexend',700],['Caveat',400],['Courier New',400],['Nonexistent Face XYZ',400]]) {
    try { const f = await fetchTTF(fam, w);
      console.log(`✓ ${fam} ${w}: ${f.bytes.length}b magic=${f.magic}${f.substitutedFor?` (as ${f.family})`:''}`);
    } catch (e) { console.log(`✗ ${fam} ${w}: ${e.message}`); }
  }
}
