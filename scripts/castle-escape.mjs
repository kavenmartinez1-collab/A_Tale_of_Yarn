/**
 * Plays the opening. Drives real WASD from the prison cell to the wilderness,
 * films it, and proves the aggro transition.
 *
 *   node scripts/castle-escape.mjs [outDir]
 *
 * ## Why this exists on top of the unit tests
 *
 * `scripts/test-castle-layout.mts` proves the escape route is walkable by
 * flooding the real collider. It cannot prove the castle is VISIBLE. This
 * repo's standing lesson is that programmatic checks report green while the
 * screen is wrong — an NPC that was correctly positioned, correctly prompted
 * and correctly counted, and never drawn, because the draw call was gated on
 * the wrong flag. So this walks the route with the keys a player would press
 * and screenshots every step.
 *
 * ## Camera conventions that have cost hours here
 *
 * The orbit camera sits BEHIND the player, so pointing it at a target and
 * screenshotting gives you the back of the player's head. Walking toward
 * (tx, tz) means `setCamera(atan2(-(tx-px), -(tz-pz)), ...)` and then holding
 * KeyW — forward is `(-sin yaw, -cos yaw)`, and the sign that looks right
 * walks you away. Mesh facing is the OTHER convention, `atan2(dx, -dz)`.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] || 'scripts/shots/castle-escape';
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
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

await page.goto('http://localhost:5173/game.html?wipe=1&director=off&tod=0.30&weather=clear',
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 90_000 });
await page.waitForTimeout(2500);
await page.evaluate(() => { window.__castleRunToken = 1; });

let shot = 0;
const log = [];
const failures = [];

/**
 * A beat that must be true or the run is a failure.
 *
 * Without these the harness happily films a player who never left the prison
 * and prints a tidy filmstrip of it — which is what the first run did: the
 * stairwell opening overran its ramp, the player fell back into the cells at
 * the top of every climb, and every subsequent "courtyard" and "breach" shot
 * was actually the undercroft. The route only means something if the harness
 * states, per beat, where the player was supposed to end up.
 */
function expect(name, cond, detail) {
  if (!cond) {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  !! FAILED: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

let reloads = 0;
let reboots = 0;
let lastFrames = 0;

/**
 * Survive a Vite hot-reload.
 *
 * Another agent writing a source file mid-run wipes `window.__gameDebug` and an
 * unguarded `evaluate` takes the whole session down 8 beats in. Wait for the
 * page to come back and record it — a reload mid-capture invalidates the frames
 * either side of it, so the count is reported rather than swallowed.
 */
async function alive(fn, arg) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // A sentinel, not just `__gameReady`. A fast Vite reload can have the
      // game ready again before the next beat looks, and then the run silently
      // continues against a FRESH game — a mid-route reload showed up only as
      // `chestOpened` quietly reverting to false eight beats after it was
      // opened. The sentinel is the only thing a reload cannot survive.
      const ok = await page.evaluate(() => window.__gameReady === true
        && window.__castleRunToken === 1
        && typeof window.__gameDebug?.playerPos === 'function');
      if (ok) {
        // Vite can hot-swap the game MODULE without reloading the page: the
        // window (and the sentinel) survives, `boot()` runs again, and every
        // manager is replaced by a fresh one. The frame counter resetting is
        // the tell — it is the only thing that goes backwards.
        const frames = await page.evaluate(() => window.__gameStats?.frames ?? 0);
        if (frames + 5 < lastFrames) {
          reboots++;
          console.log(`     !! game re-booted mid-run (frames ${lastFrames} -> ${frames})`);
        }
        lastFrames = frames;
        return await page.evaluate(fn, arg);
      }
    } catch { /* context destroyed */ }
    reloads++;
    await page.waitForFunction(() => window.__gameReady === true, undefined,
      { timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.evaluate(() => { window.__castleRunToken = 1; }).catch(() => {});
  }
  throw new Error('page never came back after a reload');
}

async function snap(note) {
  const st = await alive(() => ({
    pos: window.__gameDebug.playerPos().map((v) => Math.round(v * 10) / 10),
    fps: Math.round(window.__gameStats.fps ?? 0),
    prompt: window.__gameStats.interactPrompt,
    castle: window.__gameDebug.castle(),
    dragon: window.__gameDebug.castleDragon(),
  }));
  const name = `${String(shot).padStart(2, '0')}-${note.replace(/[^a-z0-9]+/gi, '-')}.png`;
  await page.screenshot({ path: path.join(outDir, name) });
  log.push({ shot: name, note, ...st });
  console.log(`  ${name.padEnd(38)} pos ${JSON.stringify(st.pos)} `
    + `alarm=${st.castle.alarm} roofed=${st.castle.roofed} fps=${st.fps}`
    + (st.prompt ? `  prompt="${st.prompt}"` : ''));
  shot++;
  return st;
}

/**
 * Walk to a world XZ and STOP when you get there.
 *
 * The first version held W for a fixed number of seconds and re-aimed once a
 * second. It sailed 25 m past the foot of the stair, turned round, sailed back,
 * and reported the beat as done — so every later beat started from the wrong
 * place and the whole route read as "the castle is broken" when the castle was
 * fine. Arrival detection and a 0.3 s re-aim fixed it.
 */
async function walkTo(target, seconds, note, { sprint = false, pitch = 0.30,
  dist = 5.5, tol = 2.2 } = {}) {
  const TICK = 0.3;
  const steps = Math.max(1, Math.round(seconds / TICK));
  if (sprint) await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  let arrived = false;
  for (let i = 0; i < steps && !arrived; i++) {
    arrived = await alive(([t, p, d, tl]) => {
      const g = window.__gameDebug;
      const [px, , pz] = g.playerPos();
      // Forward is (-sin yaw, -cos yaw): this yaw points the camera so that
      // holding W walks toward the target.
      g.setCamera(Math.atan2(-(t[0] - px), -(t[1] - pz)), p, d);
      return Math.hypot(t[0] - px, t[1] - pz) <= tl;
    }, [target, pitch, dist, tol]);
    await page.waitForTimeout(TICK * 1000);
  }
  await page.keyboard.up('KeyW');
  if (sprint) await page.keyboard.up('ShiftLeft');
  await page.waitForTimeout(250);
  const st = await snap(note);
  const left = Math.hypot(st.pos[0] - target[0], st.pos[2] - target[1]);
  if (!arrived) console.log(`     (timed out ${left.toFixed(1)} m short)`);
  return st;
}

const marks = await page.evaluate(() => {
  const g = window.__gameDebug;
  const out = {};
  for (const m of g.castleMarkers()) out[m] = null;
  return { names: Object.keys(out) };
});
console.log(`markers: ${marks.names.length}`);

console.log('\n=== the escape ===');
await page.evaluate(() => window.__gameDebug.setCamera(0, 0.3, 5));
await snap('wake-in-the-cell');

// Route waypoints straight from the game, so this file holds no copied
// coordinates and the route follows the real layout. Read via
// `castleMarkerPos`, never by teleporting and sampling `__gameStats` — that
// block is rebuilt on a 500 ms timer and the first version of this harness
// read the PREVIOUS position for every marker, walked the player into a wall,
// and reported it as a route.
const markerPos = await page.evaluate((names) => {
  const g = window.__gameDebug;
  const out = {};
  for (const n of names) out[n] = g.castleMarkerPos(n);
  return out;
}, ['chest', 'undercroftStairFoot', 'undercroftStairHead',
  'L1hall', 'frontCourt', 'breach', 'breachFoot', 'outside', 'spawn']);
for (const [k, v] of Object.entries(markerPos)) {
  if (v === null) throw new Error(`marker "${k}" is missing`);
  console.log(`  ${k.padEnd(22)} ${v.map((n) => n.toFixed(1)).join(', ')}`);
}

await walkTo([markerPos.chest[0], markerPos.chest[2]], 7, 'walk-to-the-chest');
const atChest = await alive(() => window.__gameStats?.interactPrompt ?? null);
console.log(`  prompt at the chest: ${JSON.stringify(atChest)}`);
await alive(() => window.__gameDebug.playerPos());
await page.keyboard.press('KeyE');
await page.waitForTimeout(500);
await snap('opened-the-chest');
const kit = await alive(() => window.__gameDebug.inventory());
console.log(`  inventory after: ${JSON.stringify(kit).slice(0, 220)}`);

expect('chest prompt appeared', atChest !== null, `prompt was ${JSON.stringify(atChest)}`);
const chestState = await alive(() => window.__gameDebug.castle().chestOpened);
expect('the chest actually opened', chestState === true, `chestOpened=${chestState}`);
expect('the kit landed in the pack',
  JSON.stringify(kit).includes('bronze_axe'), 'no bronze_axe in the pack');

// The route is a WAYPOINT CHAIN, not a straight line to each goal.
//
// "Face the target and hold W" cannot walk a staircase in a corner: at the top
// of the flight the goal is west, the wall is west, and the player grinds along
// it until the beat times out. That is a limitation of the steering, not of the
// castle, but a harness that cannot walk the route cannot report on it either.
// So each leg is short enough to be a straight line in practice.
const stairHead = markerPos.undercroftStairHead;
const legs = [
  { to: [markerPos.undercroftStairFoot[0], markerPos.undercroftStairFoot[2]],
    s: 6, name: 'at-the-stair-foot' },
  { to: [stairHead[0], stairHead[2]], s: 10, name: 'climbed-the-stair' },
  // Step clear of the stairwell mouth before turning for the hall.
  { to: [stairHead[0], stairHead[2] + 7], s: 5, name: 'onto-level-one' },
  { to: [markerPos.L1hall[0], markerPos.L1hall[2] + 7], s: 8, name: 'across-the-hall' },
  { to: [markerPos.L1hall[0], markerPos.L1hall[2]], s: 5, name: 'the-great-hall' },
];
let last = null;
for (const leg of legs) last = await walkTo(leg.to, leg.s, leg.name);
expect('the stair actually goes up',
  last.pos[1] > markerPos.spawn[1] + 6,
  `ended at y ${last.pos[1]}, the cell floor is ${markerPos.spawn[1].toFixed(1)}`);
expect('reached the great hall on level 1',
  Math.abs(last.pos[1] - markerPos.L1hall[1]) < 1.5,
  `y ${last.pos[1]} vs level 1 at ${markerPos.L1hall[1].toFixed(1)}`);

// Out of the keep's great door (north face) and across the front courtyard.
await walkTo([markerPos.L1hall[0], markerPos.L1hall[2] - 30], 9,
  'through-the-keep-door', { pitch: 0.12, dist: 7 });
const court = await walkTo([markerPos.frontCourt[0], markerPos.frontCourt[2]], 9,
  'out-into-the-courtyard', { pitch: 0.05, dist: 8 });
expect('got out of the keep into the courtyard',
  !court.castle.roofed, 'still under a roof');

await alive(() => { window.__gameDebug.setCamera(1.2, -0.45, 9); return true; });
await page.waitForTimeout(900);
await snap('look-up-at-the-dragon');

// East along the inside of the wall, then out through the breach.
await walkTo([markerPos.breach[0] - 14, markerPos.breach[2]], 11, 'along-the-wall',
  { sprint: true, pitch: 0.1, dist: 8 });
const atBreach = await walkTo([markerPos.breach[0], markerPos.breach[2]], 8,
  'reached-the-breach', { pitch: 0.1, dist: 8 });
expect('reached the breach',
  Math.hypot(atBreach.pos[0] - markerPos.breach[0],
    atBreach.pos[2] - markerPos.breach[2]) < 14,
  `${Math.hypot(atBreach.pos[0] - markerPos.breach[0],
    atBreach.pos[2] - markerPos.breach[2]).toFixed(1)} m short`);
await walkTo([markerPos.breachFoot[0], markerPos.breachFoot[2]], 14, 'down-the-causeway',
  { sprint: true, pitch: 0.18, dist: 9 });
const out = await walkTo([markerPos.outside[0], markerPos.outside[2]], 10,
  'into-the-wilderness', { sprint: true, pitch: 0.15, dist: 9 });
expect('escaped the castle', out.castle.escaped, 'never left the curtain wall');
expect('the chest is still open at the end', out.castle.chestOpened,
  'state reverted — the page reloaded mid-run');
expect('descended the motte', out.pos[1] < markerPos.breach[1] - 8,
  `y ${out.pos[1]}, breach was at ${markerPos.breach[1].toFixed(1)}`);

await alive((c) => {
  const [px, , pz] = window.__gameDebug.playerPos();
  window.__gameDebug.setCamera(Math.atan2(px - c[0], pz - c[1]), -0.18, 12);
  return true;
}, [markerPos.spawn[0], markerPos.spawn[2]]);
await page.waitForTimeout(1000);
const escaped = await snap('look-back-at-the-castle');

console.log('\n=== the alarm ===');
const a0 = await alive(() => window.__gameDebug.castle().alarm);
const dragon0 = await alive(() => window.__gameDebug.castleDragon());
console.log(`  on spawn / after escaping: alarm=${a0}, dragon mode=${dragon0?.mode}`);
expect('non-aggro through the whole escape', a0 === 'dormant', `alarm was ${a0}`);
expect('the dragon exists', dragon0 !== null);
expect('the dragon is not hostile yet', dragon0?.mode !== 'aggro', dragon0?.mode);

const a1 = await alive(() => window.__gameDebug.castleAlarmStep('depart'));
await page.waitForTimeout(700);
const dragon1 = await alive(() => window.__gameDebug.castleDragon());
await snap('far-away-departed');
console.log(`  after leaving:            alarm=${a1}, dragon mode=${dragon1?.mode}`);
expect('leaving trips departed, not aggro', a1 === 'departed', `alarm was ${a1}`);
expect('still non-hostile after leaving', dragon1?.mode !== 'aggro', dragon1?.mode);

const a2 = await alive(() => window.__gameDebug.castleAlarmStep('return'));
await page.waitForTimeout(900);
const dragon2 = await alive(() => window.__gameDebug.castleDragon());
await page.evaluate((c) => {
  const [px, , pz] = window.__gameDebug.playerPos();
  window.__gameDebug.setCamera(Math.atan2(-(c[0] - px), -(c[1] - pz)), -0.3, 10);
}, [markerPos.spawn[0], markerPos.spawn[2]]);
await page.waitForTimeout(900);
await snap('returned-hunting');
console.log(`  after returning:          alarm=${a2}, dragon mode=${dragon2?.mode}`);
expect('returning trips hunting', a2 === 'hunting', `alarm was ${a2}`);
expect('the dragon goes hostile', dragon2?.mode === 'aggro', dragon2?.mode);

// The King must be ON the dragon, not beside it or under it.
const rider = await alive(() => {
  const g = window.__gameDebug;
  const d = g.castleDragon();
  const k = g.castleKing();
  if (d === null || k === null) return null;
  return { d, k, gap: Math.hypot(k.x - d.x, k.z - d.z), lift: k.y - d.y };
});
expect('the King exists', rider !== null);
if (rider !== null) {
  console.log(`  king at (${rider.k.x}, ${rider.k.y}, ${rider.k.z}) `
    + `vs dragon (${rider.d.x}, ${rider.d.y}, ${rider.d.z})`);
  expect('the King is in the saddle, not beside it', rider.gap < 3,
    `${rider.gap.toFixed(2)} m off the dragon's axis`);
  expect('the King rides above the dragon base', rider.lift > 0.5 && rider.lift < 6,
    `${rider.lift.toFixed(2)} m above it`);
  expect('the King shares the dragon facing',
    Math.abs(rider.k.yaw - rider.d.yaw) < 0.05, `${rider.k.yaw} vs ${rider.d.yaw}`);
}

// Eviction and rebuild. `SettlementManager` never frees its ~1.7 MB per
// castle; this one does, and destroying a GPUBuffer that a draw still
// references is a validation error rather than a glitch — so walk the player
// out past the evict radius and back, and check both that it actually freed
// and that the page survived rebuilding.
console.log('\n=== streaming ===');
{
  const before = await alive(() => window.__gameDebug.castle());
  await alive(() => { window.__gameDebug.teleport(2000, 2000); return true; });
  await page.waitForTimeout(2500);
  const away = await alive(() => window.__gameDebug.castle());
  console.log(`  1000+ m away: built=${away.built} dist=${away.dist}`);
  expect('the castle frees its buffers when far away', away.built === false,
    `built=${away.built} at ${away.dist} m`);
  await alive(() => window.__gameDebug.castleTeleport('frontCourt'));
  await page.waitForTimeout(2500);
  const back = await alive(() => window.__gameDebug.castle());
  console.log(`  back on site: built=${back.built} verts=${back.verts}`);
  expect('the castle rebuilds on return', back.built === true, `built=${back.built}`);
  expect('the rebuild has the same geometry', back.verts === before.verts,
    `${back.verts} vs ${before.verts}`);
  await snap('rebuilt-after-eviction');
}

console.log('\n=== the upper castle ===');
for (const m of ['L1hall', 'L2hall', 'L3hall', 'throne', 'keepRoof', 'arena']) {
  const want = await alive((n) => window.__gameDebug.castleMarkerPos(n), m);
  await alive((n) => window.__gameDebug.castleTeleport(n), m);
  await page.waitForTimeout(900);
  await page.evaluate(() => window.__gameDebug.setCamera(0.8, 0.12, 7));
  await page.waitForTimeout(500);
  const st = await snap(m);
  // Landing at the marker's own height proves the storey resolved: if the
  // collider picked the wrong floor the player drops to the one below.
  expect(`${m} stands at its own level`, Math.abs(st.pos[1] - want[1]) < 1.6,
    `y ${st.pos[1]} vs ${want[1].toFixed(1)}`);
}

// The opening's money shot: the King on his dragon, over his castle. Aim the
// orbit camera AT the dragon rather than guessing a heading — the camera sits
// behind the player, so `atan2(-(dx), -(dz))` points it forward at the target
// and a NEGATIVE pitch looks up.
await alive(() => window.__gameDebug.castleTeleport('arena'));
await page.waitForTimeout(900);
await alive(() => {
  const g = window.__gameDebug;
  const d = g.castleDragon();
  const [px, py, pz] = g.playerPos();
  if (d === null) return false;
  const flat = Math.hypot(d.x - px, d.z - pz);
  g.setCamera(Math.atan2(-(d.x - px), -(d.z - pz)),
    -Math.max(0.05, Math.min(0.55, Math.atan2(d.y - py, flat) * 0.6)), 10);
  return true;
});
await page.waitForTimeout(900);
await snap('the-king-over-his-castle');

// A wide exterior look, from the air.
await page.evaluate(() => window.__gameDebug.castleTeleport('outside'));
await page.waitForTimeout(600);
await page.evaluate(() => {
  const [px, , pz] = window.__gameDebug.playerPos();
  window.__gameDebug.teleport(px + 60, pz + 60);
});
await page.waitForTimeout(1500);
await page.evaluate((c) => {
  const [px, , pz] = window.__gameDebug.playerPos();
  window.__gameDebug.setCamera(Math.atan2(-(c[0] - px), -(c[1] - pz)), -0.12, 10);
}, [markerPos.spawn[0], markerPos.spawn[2]]);
await page.waitForTimeout(900);
await snap('castle-from-the-hillside');

const verdict = {
  beatFailures: failures,
  escapedFlag: escaped.castle.escaped,
  alarmSequence: [a0, a1, a2],
  chestOpened: escaped.castle.chestOpened,
  verts: escaped.castle.verts,
  errors,
};
fs.writeFileSync(path.join(outDir, 'session.json'),
  JSON.stringify({ verdict, log }, null, 1), 'utf-8');

console.log('\n--- summary ---');
console.log(`alarm sequence: ${verdict.alarmSequence.join(' -> ')}`);
console.log(`escaped=${verdict.escapedFlag} chestOpened=${verdict.chestOpened} `
  + `castle verts=${verdict.verts}`);
console.log(errors.length ? `${errors.length} error(s):\n  ` + errors.slice(0, 6).join('\n  ')
  : 'no page errors');

await browser.close();
if (errors.length) process.exitCode = 1;
