// Export the card on screen as a .resonitepackage, entirely in the page.
//
//   const { blob, filename, report } = await exportResonite({ fields, onProgress });
//
// The whole pipeline: measure both faces and rasterise their plates (capture.mjs), fetch the
// typefaces they use (fonts.mjs), build the slot tree (../scene.mjs — the same construction the
// Node build runs), and encode it (encoder.mjs over pack.mjs). Nothing is uploaded; the only
// requests are for the font files, and they go to the Google Fonts repository.

import { captureCard, scanFamilies } from './capture.mjs';
import { fontLoader } from './fonts.mjs';
import { cardTheme, renderOverlay } from './overlay.mjs';
import { newEncoder } from './encoder.mjs';
import { sha256 } from './pack.mjs';
import { cardRoot, TV } from '../scene.mjs';

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

  const fontFor = fontLoader(log);

  /* Load the real typefaces into the PAGE before measuring anything.
   *
   * Every text run is exported with the box the browser laid it out in, and is then rebuilt in
   * world using the font we embed. If the page was showing a system fallback — which it is by
   * default, since Google Fonts stay off until asked — those two disagree, and a line that just
   * fitted on screen wraps in world: "Animal" comes back as "Anima" above a lone "l".
   *
   * Registering the fetched faces under the names the CSS already asks for makes the measurement
   * and the export the same font. It costs no extra request, since those bytes are needed for
   * the package anyway, and it corrects the preview at the same time — so what is on screen is
   * what lands in world. */
  if (!bake) {
    onProgress('fonts', 'fetching the typefaces');
    const wanted = [];
    for (const side of ['front', 'back']) {
      const el = document.getElementById(`oshi-${side}-node`);
      if (!el) continue;
      for (const f of scanFamilies(el))
        if (!wanted.some(w => w.family === f.family && w.weight === f.weight)) wanted.push(f);
    }
    await Promise.all(wanted.map(async ({ family, weight }) => {
      try {
        const { bytes } = await fontFor(family, weight);
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const face = new FontFace(family, buf, { weight: String(weight) });
        await face.load();
        document.fonts.add(face);
      } catch { /* fontFor logs a substitution; the capture then falls back as it used to */ }
    }));
    try { await document.fonts.ready; } catch { /* not fatal */ }
    // two frames, so the relayout the new faces cause is done before anything is measured
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  onProgress('capture', 'reading the card');
  const missed = new Set();
  const { faces, imageFor } = await captureCard(fields, { bake, missed });
  if (!faces.front) throw new Error('no front face on the page to export');
  if (missed.size)
    log(`Could not copy ${missed.size === 1 ? 'an image' : missed.size + ' images'} into the card — ` +
        `the server hosting ${missed.size === 1 ? 'it' : 'them'} does not allow it to be read. ` +
        `Uploading your avatar under Details embeds it properly.`);

  const job = { template, faces, fields };

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
