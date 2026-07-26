/**
 * Minimal fps A/B probe — does the projectile system cost frames?
 *
 *   node scripts/fps-probe.mjs
 *
 * INTERLEAVED, not sequential. The first version measured "empty" then
 * "loaded" once each and reported a 33 fps drop that turned out to be chunk
 * streaming and machine contention drifting under the measurement — the very
 * next condition, which had MORE arrows, ran at a clean 60. Alternating A/B/A/B
 * and comparing medians cancels drift; a real cost survives it.
 *
 * The arrows are planted in a tight ring around the player, which is the worst
 * case for both the mesh (every one of them inside the cull radius) and the
 * shadow pass (all of them inside the near cascade).
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173/game.html?director=off&tod=0.55&weather=clear';
const AT = [244, -304];
const ROUNDS = 4;

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 90000 });
await page.evaluate(([x, z]) => window.__gameDebug.teleport(x, z), AT);
// Long warm-up: chunk streaming alone costs 30+ fps for the first few seconds
// and will masquerade as whatever is being measured.
await page.waitForTimeout(12000);

async function sampleFps(n) {
  const vals = [];
  for (let i = 0; i < n; i++) {
    await page.waitForTimeout(550);
    vals.push(await page.evaluate(() => window.__gameStats.fps ?? 0));
  }
  vals.sort((a, b) => a - b);
  return { med: vals[Math.floor(vals.length / 2)], vals };
}

/** Plant `n` arrows in a ring around the player and hold them there. */
async function fill(n) {
  await page.evaluate((count) => {
    const dbg = window.__gameDebug;
    const p = dbg.playerPos();
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const r = 4 + (i % 6);
      dbg.injectProjectile(p[0] + Math.cos(a) * r, p[1] + 0.6,
        p[2] + Math.sin(a) * r, 'arrow', 0);
    }
  }, n);
  await page.waitForTimeout(1200); // let them settle into the ground
}

async function clear() {
  await page.evaluate(() => {
    // Walking far away releases nothing, so drain the pool by outliving it:
    // fire nothing and wait for the stuck timers is too slow, so overwrite the
    // pool with stones, which do not stick and retire on contact.
    const dbg = window.__gameDebug;
    const p = dbg.playerPos();
    for (let i = 0; i < 70; i++) {
      dbg.injectProjectile(p[0], p[1] + 0.3, p[2], 'stone', 0);
    }
  });
  await page.waitForTimeout(1500);
}

const empties = [];
const loaded = [];
for (let r = 0; r < ROUNDS; r++) {
  await clear();
  const e = await sampleFps(6);
  const nEmpty = await page.evaluate(() => window.__gameDebug.projectiles().length);
  empties.push(e.med);

  await fill(64);
  const l = await sampleFps(6);
  const nLoaded = await page.evaluate(() => window.__gameDebug.projectiles().length);
  loaded.push(l.med);

  console.log(`round ${r + 1}:  empty(${nEmpty}) ${e.med.toFixed(1)} ` +
    `[${e.vals.map((v) => v.toFixed(0)).join(' ')}]   ` +
    `loaded(${nLoaded}) ${l.med.toFixed(1)} [${l.vals.map((v) => v.toFixed(0)).join(' ')}]`);
}

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(`\nmedian empty  ${med(empties).toFixed(1)}`);
console.log(`median loaded ${med(loaded).toFixed(1)}`);
console.log(`cost of 64 planted arrows: ${(med(empties) - med(loaded)).toFixed(1)} fps`);

await browser.close();
