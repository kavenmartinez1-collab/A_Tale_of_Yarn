/**
 * What does the NPC draw path cost at a castle?
 *
 *   node scripts/npc-draw-perf.mjs [baseUrl]
 *
 * Uncapped and vsync off, because the thing being measured is a few ms inside
 * a 16.7 ms budget: with vsync on every sample quantises to 16.67 and the fix
 * is invisible. `--disable-frame-rate-limit --disable-gpu-vsync` makes rAF run
 * as fast as the frame allows, so the delta IS the frame cost.
 *
 * ## Two things this probe had to learn the hard way
 *
 * **A marker is not a scene.** Measuring at a fixed castle marker gave 17 NPCs
 * in range on one run and 5 on the next, and scored the draw path as free both
 * times — once because it was saturated and once because there was nothing to
 * draw. Which NPCs exist near a point depends on which settlement cells have
 * been streamed, which is CUMULATIVE and therefore path-dependent. So the run
 * sweeps every castle marker first to warm the settlement cache, and then
 * REFUSES TO MEASURE unless the draw path is actually saturated.
 *
 * **A/B in one run, not before/after across two.** `fps-probe.mjs` records why:
 * a sequential before/after of this game once reported a 33 fps difference that
 * turned out to be chunk streaming drifting under the measurement. So the LOD
 * is toggled in-page via `__gameDebug.setNpcLod` and the conditions alternate.
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const MARKER = process.argv[3] ?? 'wallSE';
const ROUNDS = 3;

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: [
    '--enable-unsafe-webgpu', '--use-angle=d3d11',
    '--disable-frame-rate-limit', '--disable-gpu-vsync',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 180)}`));

// Other agents edit this repo live; every save makes vite push a full-page
// reload and restarts the world mid-measurement. Stub the socket.
await page.routeWebSocket(/:5173\//, () => { /* swallow HMR */ });

await page.goto(`${BASE}/game.html?director=off&tod=0.45&weather=clear`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 90_000 });
await page.waitForTimeout(2500);

const alive = async () => page.evaluate(() => typeof window.__gameDebug === 'object');

const npcDists = () => page.evaluate(() => {
  const p = window.__gameDebug.playerPos();
  return window.__gameDebug.npcs()
    .map((n) => Math.hypot(n.x - p[0], n.z - p[2])).sort((a, b) => a - b);
});

// FIND A SATURATED SCENE, and do not assume one exists where it did last time.
//
// The castle's own crowd turned out to be TRANSIENT: NPCs near the south wall
// were walking somewhere, and a probe sampling ten seconds later than another
// sees a different number. Sitting at `wallSE` watching the distances climb
// 82 -> 117 m over two minutes is what settled it. A village crowd is
// structural — people are at their homes and their pads — so that is where
// twelve drawn NPCs can be relied on.
//
// So: try placements in order, take the first that saturates, and SAY WHICH.
// A run that cannot saturate reports that instead of reporting a number.
const places = [
  ['castle gate', () => window.__gameDebug.teleportToNearestSettlement('castle')],
  ['village',     () => window.__gameDebug.teleportToNearestSettlement('village')],
  ['settlement',  () => window.__gameDebug.teleportToNearestSettlement()],
];

let where = null;
let d = [];
let drawn = 0;
for (const [name, go] of places) {
  const ok = await page.evaluate(go);
  if (!ok) { console.log(`  ${name}: no such site nearby`); continue; }
  await page.waitForTimeout(14_000);
  d = await npcDists();
  drawn = d.filter((x) => x <= 120).length;
  console.log(`  ${name}: ${drawn} NPCs within render distance`);
  if (drawn >= 10) { where = name; break; }
}
if (where === null) {
  console.error(`!! NOT SATURATED anywhere tried (best ${drawn}).`
    + ' The NPC draw path is not under load, so this run measures nothing.');
  await browser.close();
  process.exit(3);
}

const spread = d.filter((x) => x <= 120).slice(0, 12);
console.log(`\nmeasuring at ${where}: ${drawn} NPCs in range;`
  + ` nearest 12 span ${spread[0].toFixed(0)}-${spread[spread.length - 1].toFixed(0)} m`);
void MARKER;

const sample = async (n) => page.evaluate(async (count) => {
  const out = [];
  let last = performance.now();
  await new Promise((res) => {
    let k = 0;
    const tick = () => {
      const now = performance.now();
      out.push(now - last);
      last = now;
      if (++k >= count) res(); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return out;
}, n);

const stats = (s) => {
  const v = [...s].sort((a, b) => a - b);
  return {
    mean: v.reduce((a, b) => a + b, 0) / v.length,
    med: v[Math.floor(v.length / 2)],
    p95: v[Math.floor(v.length * 0.95)],
  };
};

const measure = async (lodOn) => {
  await page.evaluate((on) => window.__gameDebug.setNpcLod(on), lodOn);
  await sample(50);                       // settle into the new condition
  const s = stats(await sample(200));
  s.cost = await page.evaluate(() => window.__gameDebug.npcDrawCost());
  return s;
};

const off = [];
const on = [];
for (let r = 0; r < ROUNDS; r++) {
  const a = await measure(false);
  const b = await measure(true);
  off.push(a); on.push(b);
  console.log(`round ${r + 1}  LOD off: mean ${a.mean.toFixed(2)} p95 ${a.p95.toFixed(2)}`
    + ` (rebuilds ${a.cost.spent + a.cost.forced}/${a.cost.drawn}, ${a.cost.ms.toFixed(2)} ms)`
    + `   LOD on: mean ${b.mean.toFixed(2)} p95 ${b.p95.toFixed(2)}`
    + ` (rebuilds ${b.cost.spent + b.cost.forced}/${b.cost.drawn}, ${b.cost.ms.toFixed(2)} ms)`);
}

if (!(await alive())) {
  console.error('!! RUN INVALID — page reloaded mid-run');
  process.exit(2);
}

const med = (arr, k) => {
  const v = arr.map((x) => x[k]).sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
};
console.log(`\n${where.toUpperCase()}, ${drawn} NPCs in range`);
console.log(`  BEFORE (no LOD, no budget): mean ${med(off, 'mean').toFixed(2)} ms  p95 ${med(off, 'p95').toFixed(2)} ms`);
console.log(`  AFTER  (id-keyed + LOD):    mean ${med(on, 'mean').toFixed(2)} ms  p95 ${med(on, 'p95').toFixed(2)} ms`);
console.log(`  delta: mean ${(med(off, 'mean') - med(on, 'mean')).toFixed(2)} ms`
  + `  p95 ${(med(off, 'p95') - med(on, 'p95')).toFixed(2)} ms`);
if (errors.length) console.log(`errors: ${errors.slice(0, 3).join(' | ')}`);

await browser.close();
