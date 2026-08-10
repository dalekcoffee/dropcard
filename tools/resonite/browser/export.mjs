// Export the card on screen as a .resonitepackage, entirely in the page.
//
//   const { blob, filename, report } = await exportResonite({ fields, onProgress });
//
// The whole pipeline: measure both faces and rasterise their plates (capture.mjs), fetch the
// typefaces they use (fonts.mjs), build the slot tree (../scene.mjs — the same construction the
// Node build runs), and encode it (encoder.mjs over pack.mjs). Nothing is uploaded; the only
// requests are for the font files, and they go to the Google Fonts repository.

import { captureCard } from './capture.mjs';
import { fontLoader } from './fonts.mjs';
import { cardTheme, renderOverlay } from './overlay.mjs';
import { newEncoder } from './encoder.mjs';
import { sha256 } from './pack.mjs';
import { cardRoot, TV } from '../scene.mjs';

/* Is this family actually resolving, or is the browser quietly substituting?
 *
 * NOT document.fonts.check — that answers true for a family it has never heard of, on the
 * grounds that an unknown name is a system font it should assume exists. Measuring is the
 * reliable way: set the text in `"Family", <generic>` and compare against the generic alone.
 * If a real face is resolving, the widths differ for at least one generic. */
const familyAvailable = (() => {
  const GENERICS = ['monospace', 'serif', 'sans-serif'];
  const SAMPLE = 'MWmwiI0Oo@—llB';    // wide and narrow glyphs, so a substitution shows up
  let ctx = null, base = null, cache = new Map();
  return (family) => {
    if (cache.has(family)) return cache.get(family);
    try {
      if (!ctx) {
        ctx = document.createElement('canvas').getContext('2d');
        base = {};
        for (const g of GENERICS) { ctx.font = `72px ${g}`; base[g] = ctx.measureText(SAMPLE).width; }
      }
      let real = false;
      for (const g of GENERICS) {
        ctx.font = `72px "${family}", ${g}`;
        if (Math.abs(ctx.measureText(SAMPLE).width - base[g]) > 0.5) { real = true; break; }
      }
      cache.set(family, real);
      return real;
    } catch { return true; }          // can't tell — say nothing rather than warn wrongly
  };
})();

const safeName = (s) => (String(s || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'dropcard');

/**
 * @param fields      { Name, Nickname } as the card currently shows them — used to find the
 *                    name run that becomes an add-contact target
 * @param template    the template's display name, for the item's name in world
 * @param onProgress  (step, detail) for a status line; every step is a network-free local
 *                    operation except 'fonts'
 * @param withOverlay draw the hover label on each add-contact target
 * @param bake        merge the card's artwork into one texture per side instead of rebuilding
 *                    it as editable elements. Needs no typefaces, so it makes no requests.
 */
export async function exportResonite({ fields = {}, template = 'Card', bake = false,
                                       onProgress = () => {}, withOverlay = true } = {}) {
  const notes = [];
  const log = (m) => { notes.push(String(m).trim()); onProgress('note', String(m).trim()); };

  onProgress('capture', 'reading the card');
  const { faces, imageFor } = await captureCard(fields, { bake });
  if (!faces.front) throw new Error('no front face on the page to export');

  if (!bake) onProgress('fonts', 'fetching the typefaces');
  const fontFor = fontLoader(log);
  const job = { template, faces, fields };

  /* Google Fonts are off until the user turns them on, so most previews are drawn in a system
     fallback while the template still NAMES its intended family. The export embeds that family
     — it is the only one we can fetch, and it is what the template was designed in — which
     means the card in world can legitimately look better than the card on screen. Worth saying
     out loud rather than leaving as a surprise. */
  if (!bake) {
    const missing = [...new Set(Object.values(faces).flatMap(f => (f.layers || []).map(L => L.family)))]
      .filter(fam => fam && !/^(system-ui|sans-serif|serif|monospace|ui-|-apple)/i.test(fam))
      .filter(fam => !familyAvailable(fam));
    if (missing.length)
      log(`Your preview is using a system face, but the card will be built in ` +
          `${missing.slice(0, 3).join(', ')}. Turn on Google Fonts under Style to see it as it ` +
          `will look.`);
  }

  let theme = null, overlayFor = null;
  if (withOverlay) {
    theme = await cardTheme(imageFor('bg', 'front'), job);
    overlayFor = (o) => renderOverlay(o);
  }

  onProgress('build', 'laying out the card in world');
  const { pf, asset, assets, embeds } = newEncoder();
  const card = await cardRoot({ pf, asset, assets, embeds, job, imageFor, sha256, fontFor,
                                theme, overlayFor, userId: '', bake, log });
  card.root.ID = pf.rootId;

  onProgress('encode', 'writing the package');
  const result = await pf.exportPackage({ name: `dropcard — ${template}`, root: card.root,
    assets, embeddedAssets: embeds, typeVersions: TV });

  const base = safeName(fields.Nickname || fields.Name || 'dropcard');
  return {
    blob: new Blob([result.bytes], { type: 'application/octet-stream' }),
    filename: `${base}-${safeName(template).toLowerCase()}${bake ? '-baked' : ''}.resonitepackage`,
    report: {
      widthMM: +(card.CARD_W * 1000).toFixed(1), heightMM: +(card.CARD_H * 1000).toFixed(1),
      fonts: card.fonts.size, embedded: embeds.length, bytes: result.bytes.length,
      contacts: card.touchReport.length, noPicture: card.noPic, notes, baked: bake,
    },
  };
}

/** The whole thing, plus the download. */
export async function downloadResonite(opts = {}) {
  const { blob, filename, report } = await exportResonite(opts);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { filename, report };
}
