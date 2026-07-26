/**
 * Visual capture harness — loads /game.html in real Chrome (WebGPU) and
 * screenshots a fixed set of scenes so graphics changes can be eyeballed
 * side by side.
 *
 *   node scripts/shot.mjs <outDir> [sceneFilter]
 *
 * Requires the vite dev server on :5173 (npx vite).
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] || 'scripts/shots/current';
const filter = process.argv[3] || '';

const D = Math.PI / 180;

// tod: 0..1 fraction of day (0 = midnight, 0.5 = noon).
// cam: [yawDeg, pitchDeg, distance]; at: [x, z] world teleport target.
const SCENES = [
  { name: '1-forest-noon',  q: 'tod=0.50&weather=clear',  at: [180, -240], cam: [35, -8, 9] },
  { name: '2-coast-golden', q: 'tod=0.72&weather=clear',  at: [32, 40],    cam: [200, -4, 11] },
  { name: '3-night-camp',   q: 'tod=0.02&weather=clear',  at: [180, -240], cam: [120, -10, 8], fire: true },
  { name: '4-rain',         q: 'tod=0.42&weather=rain',   at: [-260, 120], cam: [70, -6, 10] },
  { name: '5-dawn-hills',   q: 'tod=0.27&weather=clear',  at: [520, -400], cam: [250, -3, 14] },
  { name: '6-village',      q: 'tod=0.60&weather=clear',  village: true,   cam: [140, -12, 12] },
  { name: '7-overcast',     q: 'tod=0.55&weather=overcast', at: [-120, -520], cam: [10, -6, 12] },
  // Close on the player: the knit material and fibre halo only read at this
  // distance, so it gets its own shot rather than being judged from 10 m out.
  { name: '8-character',    q: 'tod=0.62&weather=clear',  at: [244, -304], cam: [30, -6, 2.6] },
  { name: '9-character-backlit', q: 'tod=0.78&weather=clear', at: [244, -304], cam: [140, -4, 2.6] },
  // Interiors and creatures render through code paths the outdoor shots never
  // touch (torch point lights, the palette material table, the animal rig), so
  // they get their own scenes rather than being assumed fine.
  { name: '10-dungeon',  q: 'tod=0.5&weather=clear', dungeon: true, cam: [0, -4, 3.2] },
  { name: '11-building', q: 'tod=0.5&weather=clear', building: true, cam: [0, -6, 3.4] },
  { name: '12-animals',  q: 'tod=0.55&weather=clear', at: [244, -304], cam: [20, -10, 9],
    spawn: [['deer', 3, 3], ['wolf', -3, 4], ['cow', 6, -1], ['rabbit', 1, 5], ['bird', -5, -2]] },
  { name: '13-dragon',   q: 'tod=0.6&weather=clear',  at: [244, -304], cam: [20, -8, 16],
    spawn: [['dragon', 6, 6], ['griffin', -7, 3]] },
  { name: '14-deer-close', q: 'tod=0.55&weather=clear', at: [244, -304], cam: [45, -8, 4],
    spawn: [['deer', 2.0, 1.5]] },
  { name: '15-wolf-close', q: 'tod=0.55&weather=clear', at: [244, -304], cam: [45, -8, 4],
    spawn: [['wolf', 2.0, 1.5]] },
];

fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});

const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('  [pageerror]', e.message.slice(0, 300)));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !t.includes('Failed to load resource')) {
    console.error('  [console]', t.slice(0, 400));
  }
});

let failures = 0;
for (const scene of SCENES) {
  if (filter && !scene.name.includes(filter)) continue;
  process.stdout.write(`→ ${scene.name} ... `);
  try {
    await page.goto(`http://localhost:5173/game.html?director=off&${scene.q}`,
      { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__gameReady === true, undefined,
      { timeout: 60_000 });
    await page.waitForTimeout(1_200);

    await page.evaluate(async (s) => {
      const dbg = window.__gameDebug;
      if (!dbg) return;
      if (s.village) {
        dbg.teleportToNearestSettlementSign();
      } else if (s.dungeon) {
        dbg.enterNearestDungeon();
      } else if (s.building) {
        dbg.teleportToNearestSettlementSign();
        dbg.enterNearestBuilding();
      } else if (s.at) {
        // Spiral outward until we land on dry ground — several of the
        // hand-picked coordinates sit in below-sea-level basins, where the
        // shot is just the underwater tint.
        const [ax, az] = s.at;
        let best = null;
        for (const r of [0, 40, 90, 160, 250, 360]) {
          for (let a = 0; a < 8; a++) {
            const x = ax + Math.cos(a * Math.PI / 4) * r;
            const z = az + Math.sin(a * Math.PI / 4) * r;
            dbg.teleport(x, z);
            const y = dbg.playerPos()[1];
            if (best === null || y > best[2]) best = [x, z, y];
            if (y > 4) { r === 0 ? null : null; break; }
          }
          if (best && best[2] > 4) break;
        }
        if (best) dbg.teleport(best[0], best[1]);
      }
      if (s.fire) {
        const p = dbg.playerPos();
        dbg.placeFire(p[0] + 2.0, p[2] + 1.0, true);
      }
      for (const [species, dx, dz] of s.spawn ?? []) {
        dbg.spawnEntity(species, dx, dz);
      }
      dbg.setCamera(s.cam[0] * Math.PI / 180, s.cam[1] * Math.PI / 180, s.cam[2]);
    }, scene);

    // Let terrain stream in around the new position and the sky settle.
    await page.waitForTimeout(4_500);
    const err = await page.evaluate(() => window.__gameError);
    if (err) { console.log(`GPU ERROR: ${err}`); failures++; continue; }
    const stats = await page.evaluate(() => window.__gameStats);
    await page.screenshot({ path: path.join(outDir, `${scene.name}.png`) });
    const p = stats?.playerPos?.map((v) => Math.round(v)).join(',') ?? '?';
    console.log(`ok  (fps ${Math.round(stats?.fps ?? 0)}, chunks ${stats?.chunkCount ?? 0}, at ${p})`);
  } catch (e) {
    console.log(`FAILED: ${String(e).split('\n')[0].slice(0, 200)}`);
    failures++;
  }
}

await browser.close();
console.log(failures ? `\n${failures} scene(s) failed` : `\nall scenes captured → ${outDir}`);
process.exit(failures ? 1 : 0);
