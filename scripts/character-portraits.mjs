/**
 * Character portraits — the player doll under every configuration that
 * changes its geometry.
 *
 *   node scripts/character-portraits.mjs <outDir> [nameFilter]
 *
 * The creature harness proved that "looks fine" cannot be judged from the one
 * camera angle and one costume you happened to capture. The player character
 * has more variants than any creature — body, hair style, three armour slots,
 * four tiers, held item — and the interactions between them are exactly where
 * the defects live (hair through a helmet, armour that only recolours the
 * shirt). This shoots each combination from the same framing so they can be
 * compared honestly.
 *
 * Front view by default (orbit yaw 180 — yaw 0 is behind the player) because
 * that is where a face, a helmet and a chest plate read; pass a filter to
 * shoot one config from several angles.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] || 'scripts/shots/character';
const filter = process.argv[3] || '';

const IRON = { head: 'iron_helm', body: 'iron_chest', legs: 'iron_legs' };
const NONE = { head: null, body: null, legs: null };

/** name → { custom, armor, yaw } */
const CONFIGS = [
  { name: 'bare-male',      custom: { body: 'male', hairStyle: 1 }, armor: NONE },
  { name: 'bare-female',    custom: { body: 'female', hairStyle: 3 }, armor: NONE },
  { name: 'hair2-long',     custom: { body: 'male', hairStyle: 2 }, armor: NONE },
  { name: 'hair3-flowing',  custom: { body: 'female', hairStyle: 3 }, armor: NONE },
  // The interaction cases: a helmet over each hair style.
  { name: 'helm-hair1',     custom: { body: 'male', hairStyle: 1 }, armor: IRON },
  { name: 'helm-hair2',     custom: { body: 'male', hairStyle: 2 }, armor: IRON },
  { name: 'helm-hair3',     custom: { body: 'female', hairStyle: 3 }, armor: IRON },
  // Tiers, to see whether armour is geometry or a recolour.
  { name: 'tier-fiber',     custom: { body: 'male', hairStyle: 1 },
    armor: { head: 'fiber_hood', body: 'fiber_tunic', legs: 'fiber_leggings' } },
  { name: 'tier-leather',   custom: { body: 'male', hairStyle: 1 },
    armor: { head: 'leather_cap', body: 'leather_tunic', legs: 'leather_leggings' } },
  { name: 'tier-iron',      custom: { body: 'male', hairStyle: 1 }, armor: IRON },
  { name: 'tier-dragon',    custom: { body: 'male', hairStyle: 1 },
    armor: { head: 'dragonscale_helm', body: 'dragonscale_chest', legs: 'dragonscale_legs' } },
  // Side and back of the fullest configuration.
  { name: 'iron-side',      custom: { body: 'male', hairStyle: 2 }, armor: IRON, yaw: 90 },
  { name: 'iron-back',      custom: { body: 'male', hairStyle: 2 }, armor: IRON, yaw: 0 },
];

fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 620, height: 720 } });
page.on('pageerror', (e) => console.error('  [pageerror]', e.message.slice(0, 200)));

await page.goto('http://localhost:5173/game.html?director=off&tod=0.52&weather=clear',
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 60_000 });
await page.waitForTimeout(1500);
await page.addStyleTag({ content: '#hud,#overlay{display:none!important}' });

// Flat ground, nothing else alive in frame.
await page.evaluate(() => {
  const g = window.__gameDebug;
  let best = null;
  for (let gx = -6; gx <= 6; gx++) {
    for (let gz = -6; gz <= 6; gz++) {
      const x = 244 + gx * 9, z = -304 + gz * 9;
      const h = g.heightAt(x, z);
      if (h < 1.0) continue;
      let dev = 0;
      for (const [ox, oz] of [[-3, 0], [3, 0], [0, -3], [0, 3]]) {
        dev = Math.max(dev, Math.abs(g.heightAt(x + ox, z + oz) - h));
      }
      if (best === null || dev < best.dev) best = { x, z, dev };
    }
  }
  g.teleport(best.x, best.z);
  for (const e of g.entities()) g.killEntity(e.id);
});

const log = [];
for (const cfg of CONFIGS) {
  if (filter && !cfg.name.includes(filter)) continue;
  process.stdout.write(`${cfg.name.padEnd(16)} `);
  await page.evaluate((c) => {
    const g = window.__gameDebug;
    g.setCustomization(c.custom);
    g.setArmor(c.armor);
    for (const e of g.entities()) g.killEntity(e.id);
  }, cfg);
  // Camera low and close, looking slightly up at the doll.
  // Orbit yaw 0 sits BEHIND the player (standard third-person), so the front
  // of the character is at 180. The default here used to be 0 while the file
  // claimed to shoot front views, so every "front" portrait in this harness
  // was in fact the back of the doll's head — the same mistake the creature
  // harness made, caught only by noticing a face was never in frame.
  await page.evaluate((yaw) => window.__gameDebug.setCamera(
    yaw * Math.PI / 180, 0.06, 3.1), cfg.yaw ?? 180);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, `${cfg.name}.png`) });
  log.push({ shot: `${cfg.name}.png`, beat: cfg.name });
  console.log('ok');
}

fs.writeFileSync(path.join(outDir, 'session.json'),
  JSON.stringify(log, null, 1), 'utf-8');
await browser.close();
console.log(`\n${log.length} portraits -> ${outDir}`);
