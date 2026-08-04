// Resolve a Google Fonts family+weight to real TrueType bytes.
// css2 serves woff2 to modern UAs and EOT to an IE UA; an old Android UA is the one that
// yields a plain .ttf, which is what Resonite's StaticFont wants.
const UA = 'Mozilla/5.0 (Linux; U; Android 2.2; en-us; Nexus One Build/FRF91) '
         + 'AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1';

export async function fetchTTF(family, weight = 400) {
  const q = `family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${weight}`;
  const css = await (await fetch(`https://fonts.googleapis.com/css2?${q}`, { headers:{ 'User-Agent':UA } })).text();
  const m = /url\((https:[^)]+?\.ttf)\)/.exec(css);
  if (!m) throw new Error(`no .ttf url for ${family} ${weight} — got:\n${css.slice(0,240)}`);
  const r = await fetch(m[1], { headers:{ 'User-Agent':UA } });
  if (!r.ok) throw new Error(`font fetch ${r.status} for ${family} ${weight}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const magic = Buffer.from(bytes.slice(0, 4)).toString('hex');
  // 00010000 = TrueType, 4f54544f = 'OTTO' (OpenType/CFF). Anything else isn't a usable font.
  if (magic !== '00010000' && magic !== '4f54544f')
    throw new Error(`${family} ${weight}: not a font (magic ${magic}, ${bytes.length}b)`);
  return { bytes, magic, url:m[1], family, weight };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [fam, w] of [['Poppins',400],['Poppins',600],['Poppins',700],['Baloo 2',700],['Space Mono',400]]) {
    try { const f = await fetchTTF(fam, w);
      console.log(`✓ ${fam} ${w}: ${f.bytes.length}b magic=${f.magic} (${f.magic==='00010000'?'TrueType':'OpenType'})`);
    } catch (e) { console.log(`✗ ${fam} ${w}: ${e.message.split('\n')[0]}`); }
  }
}
