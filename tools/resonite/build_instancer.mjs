// dropcard dispenser: a button that hands a copy of the card to whoever clicks it.
//
// ButtonEvents subscribes the engine's Local* event family, so the impulse chain runs ONLY
// on the pressing user's client (protoflux/engine-integration.md §3.3). That means LocalUser
// inside this graph IS the person who clicked — no cross-user permission problem, and the
// copy appears in front of THEIR head. Writes replicate afterwards as ordinary deltas.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Int32 } from 'bson';
import pkg from '/opt/node22/lib/node_modules/playwright/index.js'; const { chromium } = pkg;
import { cardRoot, newEncoder, assertFacing, TV, CP as CARD_CP } from './build_batch.mjs';
import { cardTheme, resolveIcon, renderButtonFace, BACKINGS } from './icon.mjs';
import { inkFor } from './colour.mjs';

import { dispenserRoot } from './instancer.mjs';

// --icon=landscape|vertical|auto  --backing=rounded|square|circle|none
// --backing-color=#rrggbb|theme   --icon-color=#rrggbb|theme
const OPT = Object.fromEntries(process.argv.filter(a => a.startsWith('--') && a.includes('='))
  .map(a => a.slice(2).split('=')));
const hexToRGB = h => { const s = h.replace('#','');
  const n = s.length === 3 ? [...s].map(c => c + c) : s.match(/../g);
  return n.map(v => parseInt(v, 16)); };
const prefixArg = process.argv.slice(2).find(a => !a.startsWith('-')) || 'info-editorial';
const { pf, asset, assets, embeds } = newEncoder();

const all = JSON.parse(readFileSync(new URL('./batch-layers.json', import.meta.url),'utf8'));
const job = all[prefixArg];
if (!job) throw new Error(`no capture named ${prefixArg} in batch-layers.json`);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport:{width:600,height:600},
  deviceScaleFactor:1 })).newPage();
const card = await cardRoot(pf, asset, assets, embeds, prefixArg, job, page);

const theme = cardTheme(job, prefixArg, import.meta.url);
const backing = OPT.backing ?? 'rounded';
if (!BACKINGS[backing]) throw new Error(
  `unknown backing "${backing}" — one of ${Object.keys(BACKINGS).join(', ')}`);
const backingColor = (!OPT['backing-color'] || OPT['backing-color'] === 'theme')
  ? theme.accent : OPT['backing-color'];
const ink = (!OPT['icon-color'] || OPT['icon-color'] === 'theme')
  ? inkFor(backing === 'none' ? theme.surfaceRGB : hexToRGB(backingColor), theme)
  : OPT['icon-color'];
const iconFile = resolveIcon(OPT.icon ?? 'auto', job);
const facePNG = await renderButtonFace(page, { iconFile, size:512, ink, backing,
  backingColor, dir:import.meta.url });
await browser.close();

const faceHash = createHash('sha256').update(facePNG).digest('hex');
const { root, nodes } = dispenserRoot({ pf, asset, assets, embeds, CP: CARD_CP, card,
  buttonPng: facePNG, hashOf: () => faceHash });

const r = await pf.exportPackage({ name:`dropcard dispenser (${job.template})`, root,
  assets, embeddedAssets:embeds, outPath:'out/dropcard_dispenser.resonitepackage',
  typeVersions:TV });
console.log(`  nodes=${nodes}  card=${(card.CARD_W*1000).toFixed(0)}×${(card.CARD_H*1000).toFixed(0)}mm  ${r.ok?'ok':'DANGLING'}`);
console.log(`  button: ${iconFile.replace('CardIcon','').replace('.svg','').toLowerCase()} icon, ` +
            `${backing} backing ${backing==='none'?'':backingColor}, ink ${ink}  ` +
            `(card theme: surface ${theme.surface}, accent ${theme.accent})`);
