/**
 * Road-network visual QA.
 *
 *   npx tsx scripts/road-sites.mts      # pick sites FROM the road graph
 *   node scripts/shot-roads.mjs [outDir]
 *
 * Sites come from scripts/road-sites.json, which is generated from the actual
 * road graph — the harness never invents a coordinate and hopes a road is
 * there. Each site is shot twice, from the ground and from above, because a
 * ground shot alone cannot show where a road goes and an aerial alone cannot
 * show what the surface looks like.
 *
 * Camera convention (src/game/camera.ts:42): forward is
 * (-sin yaw · cos pitch, -sin pitch, -cos yaw · cos pitch), so yaw 0 looks
 * down -Z and a look-at direction (dx, dz) is yaw = atan2(-dx, -dz).
 *
 * The report prints, per shot, where the player ACTUALLY ended up versus where
 * it was sent. A teleport that silently failed would otherwise produce a
 * perfectly plausible photograph of the wrong place — this repo has shipped
 * that mistake before.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] || 'scripts/shots/roads';
const sites = JSON.parse(fs.readFileSync('scripts/road-sites.json', 'utf-8'));
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

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

const rows = [];
let failures = 0;

for (const site of sites) {
  // Camera pitch sign: forward.y = -sin(pitch), and the eye sits at
  // target - forward*dist, so POSITIVE pitch lifts the camera and looks down.
  // Negative pitch buries it and the ground clamp in camera.ts pins it just
  // above the terrain — which is how the first run produced ten "aerial" shots
  // taken from knee height.
  for (const view of [
    { tag: 'eye', pitch: 0.06, dist: 7 },
    { tag: 'air', pitch: 0.62, dist: 70 },
  ]) {
    const name = `${site.name}-${view.tag}`;
    try {
      const placed = await page.evaluate(({ s, v }) => {
        const d = window.__gameDebug;
        d.teleport(s.at[0], s.at[1]);
        const dx = s.look[0] - s.at[0];
        const dz = s.look[1] - s.at[1];
        d.setCamera(Math.atan2(-dx, -dz), v.pitch, v.dist);
        return d.playerPos();
      }, { s: site, v: view });

      // Terrain streams 2 chunks/frame and the road network resolves its
      // coverage lazily on first touch, so a short wait photographs a hole.
      await page.waitForTimeout(6_000);

      const err = await page.evaluate(() => window.__gameError);
      if (err) { console.log(`${name}: GPU ERROR ${err}`); failures++; continue; }
      const stats = await page.evaluate(() => window.__gameStats);
      await page.screenshot({ path: path.join(outDir, `${name}.png`) });

      const drift = Math.hypot(placed[0] - site.at[0], placed[2] - site.at[1]);
      rows.push({
        name,
        sentTo: site.at.map((v) => Math.round(v)),
        landedAt: [Math.round(placed[0]), Math.round(placed[2])],
        driftM: Number(drift.toFixed(1)),
        groundY: Number(placed[1].toFixed(2)),
        fps: Math.round(stats?.fps ?? 0),
        chunks: stats?.chunkCount ?? 0,
        note: site.note,
      });
      const masks = site.verify.map((v) => v[2].toFixed(2)).join('/');
      console.log(`${name.padEnd(20)} fps ${String(Math.round(stats?.fps ?? 0)).padStart(3)}`
        + `  chunks ${String(stats?.chunkCount ?? 0).padStart(3)}`
        + `  drift ${drift.toFixed(1)} m  mask@0/10/25/45m ${masks}  ${site.note}`);
      if (drift > 2) {
        console.log('   !! teleport drift — this shot may not be the place it claims');
        failures++;
      }
    } catch (e) {
      console.log(`${name}: FAILED ${String(e).split('\n')[0].slice(0, 160)}`);
      failures++;
    }
  }
}

fs.writeFileSync(path.join(outDir, 'report.json'),
  JSON.stringify({ shots: rows, errors }, null, 1), 'utf-8');

await browser.close();
console.log(errors.length ? `\n${errors.length} page error(s):` : '\nno page errors');
for (const e of errors.slice(0, 8)) console.log('  ' + e);
console.log(failures ? `\n${failures} shot(s) failed` : `\nall shots captured → ${outDir}`);
process.exit(failures || errors.length ? 1 : 0);
