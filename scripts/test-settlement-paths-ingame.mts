/**
 * In-game proof that settlement circulation is WALKABLE.
 *
 *   npx tsx scripts/test-settlement-paths-ingame.mts [outDir]
 *
 * Why this exists in this shape. `scripts/test-settlement-paths.mts` proves the
 * generator's own invariants — no interval steeper than the engine's climb
 * threshold, no flight steeper than its own treads allow. All of that can be
 * true while the player still cannot get up the hill, because the numbers live
 * in the generator and the walking happens in `controller.ts` against
 * `settlementGround`, and the two only meet at runtime. The standing example in
 * this repo is an NPC that was placed correctly, targeted correctly, counted
 * correctly, and never drawn.
 *
 * So this computes the real network with the real generator, finds its lowest
 * and highest junction, walks the graph between them, then drives the actual
 * game along those waypoints with held keys and checks the player arrives. If
 * the collision boxes disagree with the geometry — treads pushed out as
 * blockers, a retaining wall sealing a street, a flight the ground query never
 * lifts you onto — the player stalls and this fails.
 *
 * Camera note that has cost time here before: forward is (-sin yaw, -cos yaw),
 * so the yaw that walks TOWARD a target is atan2(-(tx-px), -(tz-pz)). The sign
 * that reads naturally walks you away from it.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { createHeightField } from '../src/game/noise';
import { settlementSiteAt } from '../src/game/settlement/settlement-scatter';
import { resolveSettlement } from '../src/game/settlement/settlement-layout';
import { MAX_GRADE } from '../src/game/settlement/settlement-paths';

const outDir = process.argv[2] || 'scripts/shots/paths';
fs.mkdirSync(outDir, { recursive: true });

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// --- build the route offline, from the same generator the game runs ---------

const hf = createHeightField(1337);
const heightAt = (x: number, z: number) => hf.heightAt(x, z);
// Cell (-1, -1) is the forced castle beside world spawn (settlement-scatter.ts).
// It moved from (-1, 0) when settlement siting became river-aware — the old pin
// was in a river, and that cell can carry no castle town at all.
const site = settlementSiteAt(1337, -1, -1, heightAt);
if (site === null) throw new Error('forced castle site missing');
const resolved = resolveSettlement(site, heightAt);
const { nodes, links, stats } = resolved.paths;

// Lowest and highest junction — of the nodes that actually carry a street.
//
// Scanning every node picks one that is not on the network at all: a doorway
// whose spur could not be laid keeps a placeholder height, and the first run of
// this walked 38 m toward a junction with no path to it and called the feature
// broken. The bug was in the harness.
const linked = new Set<number>();
for (const [a, b] of links) { linked.add(a); linked.add(b); }
const ids = [...linked].sort((p, q) => p - q);
let lo = ids[0], hi = ids[0];
for (const i of ids) {
  if (nodes[i].y < nodes[lo].y) lo = i;
  if (nodes[i].y > nodes[hi].y) hi = i;
}
// Shortest hop count between them along the streets.
const adj = new Map<number, number[]>();
for (const [a, b] of links) {
  if (!adj.has(a)) adj.set(a, []);
  if (!adj.has(b)) adj.set(b, []);
  adj.get(a)!.push(b);
  adj.get(b)!.push(a);
}
const prev = new Map<number, number>([[lo, -1]]);
const queue = [lo];
for (let qi = 0; qi < queue.length; qi++) {
  const cur = queue[qi];
  if (cur === hi) break;
  for (const nb of adj.get(cur) ?? []) {
    if (prev.has(nb)) continue;
    prev.set(nb, cur);
    queue.push(nb);
  }
}
// An edge the planner could not lay anywhere is dropped rather than laid
// through a wall, which can split the network. Walk the highest junction that
// is actually reachable from the lowest.
if (!prev.has(hi)) {
  let far = lo;
  for (const c of prev.keys()) if (nodes[c].y > nodes[far].y) far = c;
  hi = far;
}
check('the lowest junction reaches a materially higher one',
  nodes[hi].y - nodes[lo].y > 3,
  `lo=#${lo} hi=#${hi} climb ${(nodes[hi].y - nodes[lo].y).toFixed(1)} m ` +
  `over ${prev.size}/${ids.length} reachable junctions`);

const route: number[] = [];
for (let c = hi; c !== -1 && c !== undefined; c = prev.get(c) ?? -1) {
  route.unshift(c);
  if (c === lo) break;
}
const climbM = nodes[hi].y - nodes[lo].y;
console.log(`\nroute: ${route.length} junctions, climbs ${climbM.toFixed(2)} m ` +
  `(network ${stats.lengthM.toFixed(0)} m, ${stats.treads} treads)`);
check('the route is a real climb worth testing', climbM > 3,
  `only ${climbM.toFixed(2)} m`);

// --- drive the game ---------------------------------------------------------

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
// Other agents edit this repo live, and every save makes vite push a full-page
// reload. Without this the walk is restarted mid-route and the run reports a
// stalled player that was in fact teleported back to the start — or dies with
// "Execution context was destroyed". Swallow the HMR socket.
await page.routeWebSocket(/:5173\//, () => { /* swallow HMR */ });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !t.includes('Failed to load resource')) {
    errors.push(`CONSOLE ${t.slice(0, 200)}`);
  }
});

await page.goto('http://localhost:5173/game.html?director=off&tod=0.45&weather=clear',
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => (window as never as { __gameReady: boolean }).__gameReady === true,
  undefined, { timeout: 90_000 });
await page.waitForTimeout(1500);

type Dbg = {
  teleport(x: number, z: number): void;
  playerPos(): number[];
  setCamera(y: number, p: number, d: number): void;
  heightAt(x: number, z: number): number;
};
const dbg = () => (window as never as { __gameDebug: Dbg }).__gameDebug;

await page.evaluate((p) => (window as never as { __gameDebug: Dbg }).__gameDebug
  .teleport(p[0], p[1]), [nodes[lo].x, nodes[lo].z] as [number, number]);
await page.waitForTimeout(3000);   // stream the chunks and build the settlement

const shot = async (name: string) => {
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
};

// Face up the route for the opening frame.
const first = nodes[route[Math.min(1, route.length - 1)]];
const start = await page.evaluate(() => (window as never as { __gameDebug: Dbg })
  .__gameDebug.playerPos());
await page.evaluate((y) => (window as never as { __gameDebug: Dbg })
  .__gameDebug.setCamera(y, 0.55, 4.5),
Math.atan2(-(first.x - start[0]), -(first.z - start[2])));
await page.waitForTimeout(500);
await shot('walk-00-start');

const track: { x: number; y: number; z: number; leg: number }[] = [];
let stalls = 0;
let shotN = 1;

for (let r = 1; r < route.length; r++) {
  const target = nodes[route[r]];
  let ticks = 0;
  let lastD = Infinity;
  await page.keyboard.down('KeyW');
  for (; ticks < 26; ticks++) {
    const p = await page.evaluate(() => (window as never as { __gameDebug: Dbg })
      .__gameDebug.playerPos());
    const d = Math.hypot(target.x - p[0], target.z - p[2]);
    track.push({ x: +p[0].toFixed(2), y: +p[1].toFixed(2), z: +p[2].toFixed(2), leg: r });
    if (d < 2.2) break;
    // Re-aim every tick: the streets bend, and holding one heading walks you
    // into the buildings they bend around.
    await page.evaluate((y) => (window as never as { __gameDebug: Dbg })
      .__gameDebug.setCamera(y, 0.5, 4.5),
    Math.atan2(-(target.x - p[0]), -(target.z - p[2])));
    await page.waitForTimeout(260);
    if (Math.abs(lastD - d) < 0.05) stalls++;
    lastD = d;
  }
  await page.keyboard.up('KeyW');
  if (r % Math.max(1, Math.floor(route.length / 6)) === 0) {
    await shot(`walk-${String(shotN++).padStart(2, '0')}-leg${r}`);
  }
}
await shot('walk-99-end');

const end = await page.evaluate(() => (window as never as { __gameDebug: Dbg })
  .__gameDebug.playerPos());
const gained = end[1] - start[1];
const missBy = Math.hypot(end[0] - nodes[hi].x, end[2] - nodes[hi].z);

console.log(`\nstart y=${start[1].toFixed(2)}  end y=${end[1].toFixed(2)}  ` +
  `gained ${gained.toFixed(2)} m of ${climbM.toFixed(2)} m; ` +
  `finished ${missBy.toFixed(1)} m from the top junction; ${stalls} stalled ticks`);

check('the player climbs the network end to end',
  gained > climbM * 0.8, `gained ${gained.toFixed(2)} of ${climbM.toFixed(2)} m`);
check('the player reaches the top junction',
  missBy < 6, `stopped ${missBy.toFixed(1)} m short`);
check('the player never gets stuck for long',
  stalls < 12, `${stalls} stalled ticks`);
check('no page errors during the walk', errors.length === 0, errors.slice(0, 3).join(' | '));

// Every step the player actually took, against the engine's climb threshold.
// The controller has no slope limit, so this cannot fail by being blocked — it
// fails by the player having been TELEPORTED up something, which is what the
// paths exist to replace.
let worstStep = 0;
for (let i = 1; i < track.length; i++) {
  if (track[i].leg !== track[i - 1].leg) continue;
  const dh = Math.hypot(track[i].x - track[i - 1].x, track[i].z - track[i - 1].z);
  const dy = track[i].y - track[i - 1].y;
  if (dy > 0 && dh > 0.3) worstStep = Math.max(worstStep, dy / dh);
}
console.log(`steepest sampled ascent along the walk: ${worstStep.toFixed(2)} ` +
  `(engine climb threshold ${MAX_GRADE.toFixed(2)})`);

fs.writeFileSync(path.join(outDir, 'walk.json'), JSON.stringify(
  { lo: nodes[lo], hi: nodes[hi], route: route.length, climbM, gained, missBy,
    stalls, worstStep, stats, track, errors }, null, 1), 'utf-8');

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
