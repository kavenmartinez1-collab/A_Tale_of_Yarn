/**
 * People density — how inhabited the world actually is, as a number.
 *
 *   npx tsx scripts/npc-density.mts        (dev server must be running)
 *
 * The peer of `entity-density.mjs`, which does the same for wildlife, and it
 * exists for the same reason: "the world feels empty" is easy to argue about
 * and hard to act on, and one walked route cannot answer it. A single route
 * confuses a quiet road with a quiet world.
 *
 * Two samples, because they answer two different questions:
 *
 *   SETTLEMENTS — teleport to real settlement centres of every kind and count
 *   who is actually there in the running game. This catches the failure the
 *   pure-CPU probe cannot: an NPC that spawns correctly, is placed correctly,
 *   and is never rendered or ticked at all.
 *
 *   ROADS — teleport to points sampled along the real road network. This is
 *   the number that matters most, because the player spends most of their time
 *   between places rather than in them.
 *
 * The headline figures are the last two of each block: the share of sampled
 * positions with NOBODY within 100 m and within 60 m. Against a renderer that
 * draws NPCs to 120 m, those are the odds that standing somewhere shows you no
 * people at all.
 *
 * Baseline before the 2026-07-26 population pass, measured by running this
 * harness against reverted sources. The sample POINTS differ between the two
 * runs — the pass changed which settlements exist and where — so this is the
 * same methodology over each world as it was, not a paired comparison:
 *
 *   settlements: mean 1.51 within 100 m | nobody within 100 m 57%
 *                ruins 0.0 (21/21 empty) ranch 1.7 village 4.3 town 7.0 castle 7.0
 *   roads:       mean 0.00 within 100 m | nobody within 100 m 100%
 *                median nearest person 175 m
 *
 * After:
 *   settlements: mean 4.54 within 100 m | nobody within 100 m 25%
 *                ruins 1.1 (7/14 empty) ranch 2.8 village 7.4 town 14.3 castle 18.0
 *   roads:       mean 1.02 within 100 m | nobody within 100 m 50%
 *                median nearest person 92 m
 */
import { chromium } from '@playwright/test';
import { createHeightField } from '../src/game/noise';
import { sharedRoadNetwork } from '../src/game/world/roads';
import { settlementSiteAt, SCELL } from '../src/game/settlement/settlement-scatter';

const SEED = 1337;
const BASE = 'http://127.0.0.1:5173';

// --- pick the sample points on the CPU, where the world is cheap to query ---

const hf = createHeightField(SEED);
const heightAt = (x: number, z: number): number => hf.heightAt(x, z);
const roads = sharedRoadNetwork(SEED, hf);

/** Settlement centres of every kind, spread over the world. */
const settlements: { x: number; z: number; kind: string }[] = [];
for (let cz = -5; cz <= 5; cz++) {
  for (let cx = -5; cx <= 5; cx++) {
    const s = settlementSiteAt(SEED, cx, cz, heightAt);
    if (s !== null) settlements.push({ x: s.x, z: s.z, kind: s.kind });
  }
}

/**
 * Points on the road, one every ~250 m of a sampled set of edges. Taken from
 * the graph rather than by probing `nearestRoad` on a grid, so every sample is
 * genuinely ON the paving rather than near it.
 */
const roadPts: { x: number; z: number }[] = [];
for (let cz = -4; cz <= 4 && roadPts.length < 220; cz++) {
  for (let cx = -4; cx <= 4 && roadPts.length < 220; cx++) {
    const g = roads.graphIn(cx * SCELL, cz * SCELL,
      (cx + 1) * SCELL, (cz + 1) * SCELL);
    for (const e of g.edges) {
      if (e.a === e.b) continue;
      let acc = 0;
      for (let i = 0; i + 5 < e.pts.length; i += 3) {
        const seg = Math.hypot(e.pts[i + 3] - e.pts[i], e.pts[i + 4] - e.pts[i + 1]);
        acc += seg;
        if (acc < 250) continue;
        acc = 0;
        const x = e.pts[i];
        const z = e.pts[i + 1];
        if (Math.floor(x / SCELL) !== cx || Math.floor(z / SCELL) !== cz) continue;
        roadPts.push({ x, z });
      }
    }
  }
}

console.log(`sampling ${settlements.length} settlements and ${roadPts.length} road points`);

// --- drive the real game -----------------------------------------------------

const headed = process.argv.includes('--headed');
const browser = await chromium.launch({
  channel: 'chrome', headless: !headed,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 700, height: 500 } });
page.on('pageerror', (e) => console.log(`PAGE ERROR: ${e.message}`));
// A parallel agent is editing this repo, and every save fires Vite HMR, which
// destroys the page context mid-measurement and throws away the run. The game
// itself is loaded as a plain module graph, so blocking only the HMR client
// leaves the build intact and stops the reloads.
await page.route('**/@vite/client', (r) => r.abort());
await page.goto(`${BASE}/game.html?tod=0.45&weather=clear&director=off`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined,
  { timeout: 90000 });
await page.waitForTimeout(1500);

interface Row {
  x: number; z: number; tag: string;
  w100: number; w60: number; w30: number;
  trav100: number; nearest: number | null;
  fps: number; spent: number; wanted: number; budget: number;
}

async function sample(pts: { x: number; z: number; kind?: string }[], tag: string,
): Promise<Row[]> {
  return page.evaluate(async ({ pts, tag }) => {
    const g = (window as never as { __gameDebug: Record<string, (...a: never[]) => unknown> })
      .__gameDebug;
    const stats = (window as never as { __gameStats: { fps: number } }).__gameStats;
    const rows: Row[] = [];
    for (const p of pts as { x: number; z: number; kind?: string }[]) {
      (g.teleport as (x: number, z: number) => void)(p.x, p.z);
      // Long enough for the settlement/traveller stream to catch up and for a
      // few frames of NPC simulation to run.
      await new Promise((r) => setTimeout(r, 260));
      const pos = (g.playerPos as () => number[])();
      const npcs = (g.npcs as () => { id: string; x: number; z: number; hp: number }[])();
      const cost = (g.entityFrameCost as () => {
        spent: number; wanted: number; budget: number }) ();
      const live = npcs.filter((n) => n.hp > 0);
      const d = live.map((n) => ({
        d: Math.hypot(n.x - pos[0], n.z - pos[2]),
        trav: n.id.startsWith('wf_'),
      }));
      rows.push({
        x: Math.round(pos[0]), z: Math.round(pos[2]),
        tag: (p.kind ?? tag) as string,
        w100: d.filter((v) => v.d <= 100).length,
        w60: d.filter((v) => v.d <= 60).length,
        w30: d.filter((v) => v.d <= 30).length,
        trav100: d.filter((v) => v.d <= 100 && v.trav).length,
        nearest: d.length > 0 ? Math.round(Math.min(...d.map((v) => v.d))) : null,
        fps: Math.round(stats.fps),
        spent: cost.spent, wanted: cost.wanted, budget: cost.budget,
      });
    }
    return rows;
  }, { pts, tag }) as Promise<Row[]>;
}

function report(name: string, rows: Row[]): void {
  const n = rows.length;
  const mean = (f: (r: Row) => number): string =>
    (rows.reduce((a, r) => a + f(r), 0) / n).toFixed(2);
  const pct = (f: (r: Row) => boolean): string =>
    `${Math.round(rows.filter(f).length / n * 100)}%`;
  const nearest = rows.map((r) => r.nearest).filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  console.log(`\n=== ${name} (${n} positions) ===`);
  console.log(`  mean people within 100 m ${mean((r) => r.w100)}` +
    `  60 m ${mean((r) => r.w60)}  30 m ${mean((r) => r.w30)}`);
  console.log(`  of those within 100 m, road travellers: ${mean((r) => r.trav100)}`);
  console.log(`  median nearest person: ` +
    `${nearest.length > 0 ? `${nearest[Math.floor(nearest.length / 2)]} m` : 'none'}`);
  console.log(`  NOBODY within 100 m: ${pct((r) => r.w100 === 0)}` +
    `   within 60 m: ${pct((r) => r.w60 === 0)}`);
  console.log(`  fps mean ${mean((r) => r.fps)} min ${Math.min(...rows.map((r) => r.fps))}` +
    `  |  creature rebuilds wanted ${mean((r) => r.wanted)}` +
    ` spent ${mean((r) => r.spent)} of ${rows[0].budget}`);
}

const sRows = await sample(settlements, 'settlement');
report('settlement centres', sRows);
for (const kind of ['ruins', 'ranch', 'village', 'town', 'castle']) {
  const rows = sRows.filter((r) => r.tag === kind);
  if (rows.length === 0) continue;
  const m = (rows.reduce((a, r) => a + r.w100, 0) / rows.length).toFixed(1);
  const empty = rows.filter((r) => r.w100 === 0).length;
  console.log(`    ${kind.padEnd(8)} ${String(rows.length).padStart(3)} sites` +
    `  mean ${m} within 100 m  ${empty} with nobody`);
}

const rRows = await sample(roadPts, 'road');
report('road positions', rRows);

await browser.close();
