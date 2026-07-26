/**
 * Walks a road the way a player would, and checks the thing screenshots
 * cannot: that the road is actually traversable, and that the surface you
 * stand on is the surface you see.
 *
 *   npx tsx scripts/road-sites.mts     # sites, from the real road graph
 *   node scripts/walk-roads.mjs [outDir]
 *
 * Two measurements matter here.
 *
 * 1. DID THE PLAYER MOVE. Real WASD through the page, distance measured from
 *    the recorded track. A road you cannot walk down is not a road, and this
 *    repo's play harness exists because programmatic checks kept reporting
 *    success over a game that was doing nothing.
 *
 * 2. WHICH SURFACE IS THE PLAYER ON. Every recorded position is replayed
 *    offline against BOTH height fields — the base one and the road-carved
 *    one. Collision reads whichever field `main.ts` hands it, so this prints
 *    exactly what the outstanding one-line wiring change is worth: if the
 *    player tracks `base` while the terrain renders `carved`, they float above
 *    or sink into every cutting, and the gap below is that error in metres.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { createHeightField } from '../src/game/noise.ts';
import { createRoadNetwork, carveRoads } from '../src/game/world/roads.ts';

const outDir = process.argv[2] || 'scripts/shots/roads-walk';
const sites = JSON.parse(fs.readFileSync('scripts/road-sites.json', 'utf-8'));
fs.mkdirSync(outDir, { recursive: true });

const WORLD_SEED = 1337;
const base = createHeightField(WORLD_SEED);
const roads = createRoadNetwork(WORLD_SEED, base);
const carved = carveRoads(base, roads);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 300)}`));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !t.includes('Failed to load resource')) {
    errors.push(`CONSOLE ${t.slice(0, 300)}`);
  }
});

await page.goto('http://localhost:5173/game.html?director=off&tod=0.34&weather=clear',
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 90_000 });
await page.waitForTimeout(2_000);

// Walk the three most interesting: into a castle, through a fork, over relief.
const walks = ['castle-gate-0', 'fork-1', 'terrain-0']
  .map((n) => sites.find((s) => s.name === n))
  .filter((s) => s !== undefined);

const STEP_MS = 700;
const report = [];

for (const site of walks) {
  const dir = path.join(outDir, site.name);
  fs.mkdirSync(dir, { recursive: true });

  await page.evaluate((s) => {
    const d = window.__gameDebug;
    d.teleport(s.at[0], s.at[1]);
    const dx = s.look[0] - s.at[0];
    const dz = s.look[1] - s.at[1];
    d.setCamera(Math.atan2(-dx, -dz), 0.05, 8);
  }, site);
  await page.waitForTimeout(3_500); // let terrain stream in before walking

  const track = [];
  let reloads = 0;
  await page.keyboard.down('KeyW');
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(STEP_MS);
    const st = await page.evaluate(() => {
      if (!window.__gameDebug || !window.__gameReady || !window.__gameStats) return null;
      const g = window.__gameStats;
      return { pos: g.playerPos, fps: g.fps, grounded: g.grounded, err: window.__gameError };
    });
    if (st === null || !st.pos) { reloads++; continue; }
    track.push(st);
    if (i % 4 === 0) {
      await page.screenshot({ path: path.join(dir, `${String(i).padStart(2, '0')}.png`) });
    }
  }
  await page.keyboard.up('KeyW');

  if (track.length < 2) {
    console.log(`${site.name}: no usable samples (${reloads} dropped) — INVALID`);
    report.push({ site: site.name, invalid: true, reloads });
    continue;
  }

  // Path length along the track, not start-to-end: a road that curves would
  // otherwise under-report, and a player pinned against a rock would look like
  // progress if they drifted sideways.
  let walked = 0;
  for (let i = 1; i < track.length; i++) {
    walked += Math.hypot(track[i].pos[0] - track[i - 1].pos[0],
                         track[i].pos[2] - track[i - 1].pos[2]);
  }

  // Replay the track against both fields.
  let onRoad = 0;
  let sumBase = 0;
  let sumCarved = 0;
  let worstCarved = 0;
  for (const s of track) {
    const [x, y, z] = s.pos;
    const m = roads.maskAt(x, z);
    if (m > 0.4) onRoad++;
    sumBase += Math.abs(y - base.heightAt(x, z));
    const dc = Math.abs(y - carved.heightAt(x, z));
    sumCarved += dc;
    if (dc > worstCarved) worstCarved = dc;
  }
  const n = track.length;
  const fps = track.map((s) => Math.round(s.fps ?? 0)).filter((v) => v > 0);
  const row = {
    site: site.name,
    frames: n,
    walkedM: Number(walked.toFixed(1)),
    onRoadFrames: `${onRoad}/${n}`,
    minFps: fps.length ? Math.min(...fps) : null,
    meanGapToBase: Number((sumBase / n).toFixed(2)),
    meanGapToCarved: Number((sumCarved / n).toFixed(2)),
    worstGapToCarved: Number(worstCarved.toFixed(2)),
    reloads,
    err: track.some((s) => s.err) ? 'GPU ERROR' : null,
  };
  report.push(row);
  console.log(`${site.name.padEnd(15)} walked ${row.walkedM} m over ${n} frames, `
    + `on road ${row.onRoadFrames}, min fps ${row.minFps}`);
  console.log(`  player Y vs BASE field   mean |Δ| ${row.meanGapToBase} m`);
  console.log(`  player Y vs CARVED field mean |Δ| ${row.meanGapToCarved} m `
    + `(worst ${row.worstGapToCarved} m)`);
  fs.writeFileSync(path.join(dir, 'track.json'), JSON.stringify(track, null, 1), 'utf-8');
}

fs.writeFileSync(path.join(outDir, 'report.json'),
  JSON.stringify({ walks: report, errors }, null, 1), 'utf-8');

await browser.close();
console.log(errors.length ? `\n${errors.length} page error(s):` : '\nno page errors');
for (const e of errors.slice(0, 8)) console.log('  ' + e);

const bad = report.filter((r) => r.invalid || (r.walkedM ?? 0) < 8);
console.log(bad.length
  ? `\n${bad.length} walk(s) did not cover ground — treat those numbers as meaningless`
  : `\nall walks traversed the road → ${outDir}`);
process.exit(bad.length || errors.length ? 1 : 0);
