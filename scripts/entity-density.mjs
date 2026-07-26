/**
 * Wildlife density — how populated the world actually feels, as a number.
 *
 *   node scripts/entity-density.mjs
 *
 * "The world feels empty" is the kind of complaint that is easy to argue about
 * and hard to act on, and the existing harnesses could not settle it: the
 * play session walks one route (so it confuses a quiet route with a quiet
 * world), and entity counts in its per-frame log count everything *live*,
 * including animals hundreds of metres away that no player will ever see.
 *
 * This samples many positions across many cells and biomes and reports what is
 * within sight of each one. The numbers that matter are the last two: the
 * fraction of land positions with nothing within 100 m / 60 m. Against a
 * renderer that draws creatures to 120 m, those are the odds that standing
 * anywhere in the world shows you no life at all.
 *
 * Baseline before the 2026-07-25 spawn pass, for comparison:
 *   mean live 38.1 | within 100 m 0.93 | within 60 m 0.35
 *   median nearest 146 m | nothing within 100 m 73% | within 60 m 90%
 *
 * Runs with the director ON, i.e. normal play. The play harness runs it off,
 * and that is a genuinely different spawn path (entitiesForCell vs
 * EcologySpec herds) — check both when changing spawn density.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 700, height: 500 } });
await page.goto('http://localhost:5173/game.html?tod=0.52&weather=clear',
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 60000 });
await page.waitForTimeout(1500);

const out = await page.evaluate(async () => {
  const g = window.__gameDebug;
  const rows = [];
  // Sample on a coarse grid so we cross many cells and biomes.
  for (let i = 0; i < 60; i++) {
    const x = 244 + (i % 10) * 340 - 1700;
    const z = -304 + Math.floor(i / 10) * 340 - 1000;
    g.teleport(x, z);
    await new Promise((r) => setTimeout(r, 130));
    const p = g.playerPos();
    const es = g.entities();
    const d = es.map((e) => Math.hypot(e.x - p[0], e.z - p[2]));
    rows.push({
      x: Math.round(p[0]), z: Math.round(p[2]),
      terrain: +g.heightAt(p[0], p[2]).toFixed(1),
      live: es.length,
      w40: d.filter((v) => v <= 40).length,
      w60: d.filter((v) => v <= 60).length,
      w100: d.filter((v) => v <= 100).length,
      nearest: d.length ? Math.round(Math.min(...d)) : null,
    });
  }
  return rows;
});

const land = out.filter((r) => r.terrain >= 1);
const sum = (k) => land.reduce((a, r) => a + r[k], 0);
const n = land.length;
console.log(`land samples: ${n} / ${out.length}`);
console.log(`mean live (3x3 cells): ${(sum('live') / n).toFixed(1)}`);
console.log(`mean within 100 m: ${(sum('w100') / n).toFixed(2)}`);
console.log(`mean within  60 m: ${(sum('w60') / n).toFixed(2)}`);
console.log(`mean within  40 m: ${(sum('w40') / n).toFixed(2)}`);
const nearest = land.map((r) => r.nearest).filter((v) => v !== null).sort((a, b) => a - b);
console.log(`nearest entity — median ${nearest[nearest.length >> 1]} m, ` +
  `p25 ${nearest[nearest.length >> 2]} m, p75 ${nearest[(nearest.length * 3) >> 2]} m`);
console.log(`samples with NOTHING within 100 m: ` +
  `${land.filter((r) => r.w100 === 0).length} / ${n}`);
console.log(`samples with NOTHING within  60 m: ` +
  `${land.filter((r) => r.w60 === 0).length} / ${n}`);
await browser.close();
