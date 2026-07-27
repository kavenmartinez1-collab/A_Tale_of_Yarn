/**
 * Does SettlementManager give its GPU buffers back?
 *
 *   node scripts/settlement-evict-check.mjs
 *
 * A castle town is ~2 MB of vertex buffer across 9 palette batches, and none of
 * it was ever freed: every settlement the player walked near stayed resident
 * for the whole session. This drives the real game on a teleport tour of 14
 * settlements and asks the three questions that matter:
 *
 *   1. Does walking away actually free it? Measured as bytes of GPUBuffer held,
 *      from the manager's own `__settlementDebug`, AND as an independent count
 *      of `GPUBuffer.destroy()` calls patched in from outside the game — the
 *      manager could otherwise report a number it merely believes.
 *   2. Does coming back rebuild the SAME town? Every `queue.writeBuffer` into a
 *      settlement buffer is hashed on its way to the GPU, so the second visit
 *      is compared byte for byte against the first. This is the check that
 *      makes eviction safe: a rebuild that differed would be a world quietly
 *      changing behind the player's back.
 *   3. What does the rebuild cost, on the real data path rather than a bench?
 *
 * The instrumentation is entirely in this file — the game hashes and counts
 * nothing for this test's benefit, so what is measured is what ships.
 *
 * Needs the dev server (`npm run dev`).
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173';

/**
 * Settlement centres for seed 1337 (`settlementSiteAt`), ordered so the
 * biggest mesh is first: the castle town is 9 palette batches and ~2 MB, a
 * ruin is 5 batches and a fraction of that. Re-derive these if the scatter
 * changes — a tour of empty ground would pass every check by holding nothing.
 */
const TOUR = [
  [-242, -320],   // castle  (Ashfield — the forced near-spawn pin)
  [-374, -853],   // town
  [1856, 1873],   // town
  [-1419, -1141], // village
  [-1371, -788],  // village
  [100, -660],    // village
  [-1768, 328],   // ranch
  [-190, 239],    // ranch
  [1801, 1281],   // ranch
  [-1188, 1805],  // ranch
  [-1646, -1427], // ruins
  [1248, -1438],  // ruins
  [-1631, -639],  // ruins
  [774, -307],    // ruins
];
/**
 * Somewhere over 3 km from every settlement on the tour, so both tiers fire.
 * There is nowhere in this world more than ~2.9 km from SOME settlement, which
 * is the point: `FORGET_DIST` is a per-settlement distance, not a search for
 * empty wilderness, and what is asserted below is that the TOURED towns are
 * gone — not that the manager is holding nothing at all.
 */
const AWAY = [8000, 8000];

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 620 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 180)}`));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !t.includes('Failed to load resource')) {
    errors.push(`CONSOLE ${t.slice(0, 160)}`);
  }
});

// Other agents edit this repo live; every save makes vite push a full-page
// reload and restarts the world mid-measurement. Stub the socket.
await page.routeWebSocket(/:5173\//, () => { /* swallow HMR */ });

// Patch WebGPU BEFORE the game loads. `writeBuffer` is hashed rather than
// recorded: a castle town is 2 MB and the tour is fourteen of them, so FNV-1a
// over the bytes is the whole comparison in eight hex digits.
await page.addInitScript(() => {
  const w = /** @type {any} */ (window);
  w.__sb = { writes: new Map(), destroyed: 0, destroyedBytes: 0 };
  const mine = (b) => typeof b.label === 'string'
    && (b.label.startsWith('settlement-') || b.label === 'object-offset(0,0,0)');

  const origWrite = GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer = function (buffer, offset, data, ...rest) {
    if (typeof buffer.label === 'string' && buffer.label.startsWith('settlement-')) {
      const bytes = new Uint8Array(
        data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length);
      let h = 0x811c9dc5;
      for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0;
      w.__sb.writes.set(buffer.label,
        `0x${h.toString(16).padStart(8, '0')}:${bytes.length}`);
    }
    return origWrite.call(this, buffer, offset, data, ...rest);
  };

  const origDestroy = GPUBuffer.prototype.destroy;
  GPUBuffer.prototype.destroy = function () {
    if (mine(this)) { w.__sb.destroyed++; w.__sb.destroyedBytes += this.size; }
    return origDestroy.call(this);
  };
});

await page.goto(`${BASE}/game.html?director=off&tod=0.45&weather=clear`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 90_000 });
await page.waitForTimeout(2500);

const D = async (fn, arg) => {
  const ok = await page.evaluate(() => typeof window.__gameDebug === 'object');
  if (!ok) {
    process.stdout.write('\n!! RUN INVALID — page reloaded mid-run (__gameDebug gone)\n');
    await browser.close();
    process.exit(2);
  }
  return page.evaluate(fn, arg);
};

let bugs = 0, oks = 0;
const note = (bad, title, detail) => {
  if (bad) bugs++; else oks++;
  process.stdout.write(`  ${bad ? 'BUG ' : 'ok  '} ${title}\n`);
  if (detail) process.stdout.write(`       ${detail}\n`);
};
const snap = () => D(() => ({
  ...(window.__settlementDebug ?? {}),
  destroyed: window.__sb.destroyed,
  destroyedBytes: window.__sb.destroyedBytes,
}));
const writes = () => D(() => Object.fromEntries(window.__sb.writes));
const MB = (n) => `${(n / 1048576).toFixed(2)} MB`;

const go = async ([x, z], settleMs = 1500) => {
  await D(([px, pz]) => { window.__gameDebug.teleport(px, pz); }, [x, z]);
  await page.waitForTimeout(settleMs);
};

// ---------------------------------------------------------------------------
// 1. The tour
// ---------------------------------------------------------------------------
process.stdout.write(`\n--- touring ${TOUR.length} settlements ---\n`);
let peakResident = 0, peakBytes = 0, cumulativeBytes = 0;
const touredKeys = new Set();
let firstVisit = null;

for (let i = 0; i < TOUR.length; i++) {
  const [x, z] = TOUR[i];
  await go([x, z]);
  const s = await snap();
  peakResident = Math.max(peakResident, s.resident ?? 0);
  peakBytes = Math.max(peakBytes, s.bytes ?? 0);
  for (const t of s.towns ?? []) touredKeys.add(t.key);
  if (i === 0) {
    firstVisit = await writes();
    cumulativeBytes = s.bytes ?? 0;
  } else {
    cumulativeBytes += (s.towns ?? []).reduce((a, t) => a + t.bytes, 0);
  }
  process.stdout.write(
    `  ${String(i + 1).padStart(2)}. (${String(x).padStart(6)},${String(z).padStart(6)})  `
    + `resident ${String(s.resident).padStart(2)}  buffers ${String(s.buffers).padStart(3)}  `
    + `held ${MB(s.bytes).padStart(8)}  freed so far ${MB(s.destroyedBytes)}\n`);
}

note(peakResident === 0 || peakResident > 6,
  'residency stays bounded across the tour',
  `peak ${peakResident} settlements / ${MB(peakBytes)} at once; without eviction`
  + ` all ${touredKeys.size} visited would still be held`);

// ---------------------------------------------------------------------------
// 2. Walking away frees it
// ---------------------------------------------------------------------------
await go(AWAY, 2500);
const drained = await snap();
process.stdout.write(`\n--- after moving to (${AWAY[0]}, ${AWAY[1]}) ---\n`);
process.stdout.write(
  `  resident ${drained.resident}  remembered ${drained.remembered}  held ${MB(drained.bytes)}\n`
  + `  freed in total: ${MB(drained.destroyedBytes)} across ${drained.destroyed} buffers\n`);

const stillHeld = (drained.towns ?? []).filter((t) => touredKeys.has(t.key));
note(stillHeld.length > 0, 'every toured settlement has given its buffers back',
  stillHeld.length ? `still held: ${stillHeld.map((t) => t.key).join(', ')}`
    : `${touredKeys.size} settlements freed`);
note(drained.destroyed === 0, 'the frees are real GPUBuffer.destroy() calls',
  `${drained.destroyed} destroys seen from outside the game, ${MB(drained.destroyedBytes)}`);
note(drained.remembered > TOUR.length, 'CPU layouts are dropped past FORGET_DIST too',
  `${drained.remembered} remembered after visiting ${TOUR.length}`);

// ---------------------------------------------------------------------------
// 3. Coming back rebuilds the same town, byte for byte
// ---------------------------------------------------------------------------
process.stdout.write('\n--- revisiting the first settlement (the castle town) ---\n');
await D(() => { window.__sb.writes.clear(); });
await go(TOUR[0], 2500);
const second = await writes();
const revisit = await snap();

// Compare only what was actually rebuilt. Standing at a settlement makes its
// NEIGHBOURS resident too, and which neighbours are in range differs by a metre
// of landing position between two visits — a buffer absent the second time was
// not rebuilt, which is not the same as rebuilt differently.
const rebuilt = Object.keys(second).filter((k) => firstVisit[k] !== undefined);
const differing = rebuilt.filter((k) => second[k] !== firstVisit[k]);
const target = `settlement-${await D(() => window.__settlementDebug.towns[0].key)}-`;
const targetKeys = Object.keys(firstVisit ?? {}).filter((k) => k.startsWith(target));
const targetRebuilt = targetKeys.filter((k) => second[k] === firstVisit[k]);
process.stdout.write(`  ${Object.keys(firstVisit ?? {}).length} settlement buffers on the `
  + `first visit, ${Object.keys(second).length} on the second, `
  + `${rebuilt.length} written both times\n`);
for (const k of targetKeys.slice(0, 3)) {
  process.stdout.write(`    ${k}: ${firstVisit[k]} -> ${second[k] ?? '(not rebuilt)'}\n`);
}
note(targetKeys.length === 0 || targetRebuilt.length !== targetKeys.length,
  'the revisited settlement is byte-for-byte the one that was evicted',
  `${targetRebuilt.length}/${targetKeys.length} of its buffers hash identically`);
note(rebuilt.length === 0 || differing.length > 0,
  'and so is every neighbour that came back with it',
  differing.length ? `DIFFER: ${differing.join(', ')}`
    : `${rebuilt.length}/${rebuilt.length} rebuilt buffers hash identically`);
note((revisit.bytes ?? 0) === 0, 'the revisited settlement is resident again',
  `${revisit.resident} resident, ${MB(revisit.bytes)}`);

// ---------------------------------------------------------------------------
// 4. What the rebuild costs
// ---------------------------------------------------------------------------
process.stdout.write('\n--- rebuild cost, isolated from terrain streaming ---\n');
/**
 * A teleport is the wrong instrument. Jumping 8 km makes the chunk manager
 * stream a whole region at once, and the 90 ms frame that produces says nothing
 * about a settlement rebuild — it is dominated by terrain the player would have
 * walked into gradually.
 *
 * So: park just OUTSIDE `BUILD_DIST` (780 m from the castle town, on a bearing
 * with no other settlement within build range), let everything settle, then hop
 * 100 m to 680 m — inside `BUILD_DIST`, still well outside the 360 m draw
 * distance. The terrain either side of a 100 m hop is already streamed, so the
 * only new work is the settlement. The control is the same hop repeated once
 * the town is already resident.
 */
const STAGE = [-995, -118];
const HOP = [-899, -144];
/**
 * Between `EVICT_DIST` and `FORGET_DIST` of the castle town, so its buffers are
 * gone but its resolved layout is kept — the warm case the two-tier design
 * exists for.
 */
const NEAR_AWAY = [-1594, 42];
const sample = () => page.evaluate(() => new Promise((res) => {
  let last = performance.now(), max = 0, n = 0;
  const tick = () => {
    const t = performance.now();
    max = Math.max(max, t - last);
    last = t;
    if (++n < 70) requestAnimationFrame(tick); else res(max);
  };
  requestAnimationFrame(tick);
}));

const cold = [], warm = [], control = [];
for (let i = 0; i < 5; i++) {
  // Cold: forgotten entirely, so the street solver runs again too.
  await go(AWAY, 1600);
  await go(STAGE, 2600);
  const before = (await snap()).resident;
  await D(([x, z]) => { window.__gameDebug.teleport(x, z); }, HOP);
  cold.push(await sample());
  const afterHop = await snap();
  if (i === 0) {
    process.stdout.write(`  staging at 780 m: ${before} resident; after the hop to 680 m: `
      + `${afterHop.resident} resident, ${MB(afterHop.bytes)}\n`);
  }
  // Control: the same hop with nothing left to build.
  await go(STAGE, 500);
  await D(([x, z]) => { window.__gameDebug.teleport(x, z); }, HOP);
  control.push(await sample());
  // Warm: buffers evicted, layout kept.
  await go(NEAR_AWAY, 1800);
  await go(STAGE, 1200);
  await D(([x, z]) => { window.__gameDebug.teleport(x, z); }, HOP);
  warm.push(await sample());
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const row = (label, a) => process.stdout.write(
  `  ${label.padEnd(30)} ${a.map((t) => t.toFixed(1).padStart(6)).join(' ')}  median ${med(a).toFixed(1)}\n`);
row('cold (past FORGET_DIST)', cold);
row('warm (past EVICT_DIST only)', warm);
row('control (nothing to build)', control);
process.stdout.write(`  attributable to a warm rebuild: `
  + `${(med(warm) - med(control)).toFixed(1)} ms; to a cold one: `
  + `${(med(cold) - med(control)).toFixed(1)} ms.\n`
  + `  Both land at 680 m; the town becomes visible at 360 m.\n`);
note(med(warm) > 60, 'a warm rebuild does not stall the frame loop',
  `worst frame ${med(warm).toFixed(1)} ms vs ${med(control).toFixed(1)} ms control`);

if (errors.length) {
  process.stdout.write('\npage errors:\n'
    + errors.slice(0, 6).map((e) => `  ${e}`).join('\n') + '\n');
}
process.stdout.write(`\nsettlement-evict-check: ${bugs} bugs, ${oks} ok\n`);
await browser.close();
process.exit(bugs > 0 ? 1 : 0);
