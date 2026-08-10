// Does an import leave alone what it can't fill in?
//
//   npx http-server -p 8899 -s .        # serve the patched build
//   node tools/patch/test_import_defaults.mjs
//
// A fediverse profile has nothing to say about what you stream or your favourite season, and
// the import used to clear those slots anyway — the card came back with empty panels and no
// hint that anything belonged in them. The failure is quiet: the page loads, the card renders,
// it is just missing half of itself. So it gets a test.
//
// Both instances are stubbed, so nothing here touches the network. Case 1 is the bare profile
// that caused the report; case 2 guards the reason the clearing existed in the first place —
// Mastodon carries pronouns, birthday and links ONLY in free-form profile fields, and those
// must still win over a placeholder or the fix has traded one silent loss for another.
import pkg from '/opt/node22/lib/node_modules/playwright/index.js'; const { chromium } = pkg;

const HOST = 'example.social';
const BARE = { username: 'sampleuser', name: 'Sample User', description: 'A bio and nothing else.' };
const RICH = { ...BARE, fields: [
  { name: 'Pronouns', value: 'she/her' },
  { name: 'Birthday', value: '3/14' },
  { name: 'Language', value: 'Japanese' },
  { name: 'Twitch', value: 'realvt' },
] };

// the sample values the card ships with, and where each one shows up on Classic ID
const SAMPLES = ['they/them', 'English', 'Iced tea', 'Sample dish', 'Bugs', 'Just chatting'];
// the sample LINKS, which are the one thing an import is supposed to clear: inert placeholder
// text is harmless, but a social handle is a claim about where to find someone
const SAMPLE_LINKS = ['SampleVT'];

const b = await chromium.launch();
let failed = 0;

for (const [label, profile, expect, absent] of [
  ['bare profile keeps every sample', BARE, SAMPLES, SAMPLE_LINKS],
  ['profile fields beat the samples', RICH, ['she/her', 'Japanese', 'Iced tea', 'Sample dish', 'realvt'], SAMPLE_LINKS],
]) {
  const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
  await p.route(`**://${HOST}/api/users/show`, r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(profile) }));
  await p.route(`**://${HOST}/api/emojis`, r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"emojis":[]}' }));
  await p.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'load', timeout: 90000 });
  await p.waitForTimeout(7000);

  await p.locator('button:has-text("Import")').first().click();
  await p.waitForTimeout(500);
  await p.locator('input[placeholder*="@username"]').first().fill(`@${profile.username}@${HOST}`);
  await p.locator('button:has-text("Import")').last().click();
  await p.waitForTimeout(3000);

  // both faces: the links live on the back, the placeholder panels on the front
  const front = await p.locator('#oshi-front-node').innerText();
  const back = await p.locator('#oshi-back-node').innerText().catch(() => '');
  const card = front + '\n' + back;
  const gone = expect.filter(s => !card.includes(s));
  const lingering = (absent || []).filter(s => card.includes(s));
  const namedOK = card.includes('Sample User');   // the import did actually land

  if (gone.length || lingering.length || !namedOK) {
    failed++;
    console.log(`✗ ${label}`);
    if (!namedOK) console.log('    the import itself did not apply — name never reached the card');
    if (gone.length) console.log('    missing from the card after import: ' + gone.join(', '));
    if (lingering.length) console.log('    sample links survived the import: ' + lingering.join(', '));
  } else {
    console.log(`✓ ${label}`);
  }
  await p.close();
}

await b.close();
process.exit(failed ? 1 : 0);
