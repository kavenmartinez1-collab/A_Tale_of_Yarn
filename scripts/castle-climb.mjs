/**
 * Walks every storey of the keep, bottom to top, under real WASD.
 *
 *   node scripts/castle-climb.mjs [outDir]
 *
 * ## Why
 *
 * `castle-escape.mjs` walks the undercroft-to-courtyard climb and stops there,
 * because that is the route the opening uses. The four flights above it —
 * L1 to L2, L2 to L3, L3 to the keep roof, and the roof to the dragon's arena —
 * have only ever been proved by the reachability flood and by
 * `castleTeleport`, which puts the player down 40 cm above a marker and asks
 * no questions about how they would have got there.
 *
 * That is exactly the gap the wall-walk lived in for the whole life of this
 * castle: reachable in the flood, in budget in the mesh, and unwalkable. So
 * this climbs all five flights with the keys a player would press and asserts
 * the storey height at the top of each — a beat that arrives at the right XZ on
 * the WRONG floor is the failure this is looking for, and position alone cannot
 * see it.
 *
 * Camera: orbit yaw 0 is BEHIND the player; walking at (tx,tz) is
 * `setCamera(atan2(-(tx-px), -(tz-pz)), ...)`. Indoors, pitch ~0.55 at ~4.5 m.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] || 'scripts/shots/castle-climb';
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

await page.goto('http://localhost:5173/game.html?wipe=1&director=off&tod=0.34&weather=clear',
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 90_000 });
await page.waitForTimeout(2500);
await page.evaluate(() => { window.__climbToken = 1; });

let shot = 0;
const log = [];
const failures = [];
let reloads = 0;
let reboots = 0;
let lastFrames = 0;

function expect(name, cond, detail) {
  if (!cond) {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  !! FAILED: ${name}${detail ? ` — ${detail}` : ''}`);
  } else console.log(`  ok  ${name}`);
}

/** Survive — and record — a Vite reload; three agents share this repo. */
async function alive(fn, arg) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ok = await page.evaluate(() => window.__gameReady === true
        && window.__climbToken === 1
        && typeof window.__gameDebug?.playerPos === 'function');
      if (ok) {
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
    await page.evaluate(() => { window.__climbToken = 1; }).catch(() => {});
  }
  throw new Error('page never came back after a reload');
}

async function snap(note) {
  const st = await alive(() => ({
    pos: window.__gameDebug.playerPos().map((v) => Math.round(v * 100) / 100),
    motion: window.__gameDebug.playerMotion(),
    roofed: window.__gameDebug.castle().roofed,
    fps: Math.round(window.__gameStats.fps ?? 0),
  }));
  const name = `${String(shot).padStart(2, '0')}-${note.replace(/[^a-z0-9]+/gi, '-')}.png`;
  await page.screenshot({ path: path.join(outDir, name) });
  log.push({ shot: name, note, ...st });
  console.log(`  ${name.padEnd(32)} pos ${JSON.stringify(st.pos)} `
    + `grounded=${st.motion.grounded} roofed=${st.roofed} fps=${st.fps}`);
  shot++;
  return st;
}

const NAMES = ['spawn', 'undercroftStairFoot', 'undercroftStairHead', 'L1hall',
  'stair12', 'stair12Head', 'L2hall', 'stair23', 'stair23Head', 'L3hall',
  'throne', 'stair3T', 'stair3THead', 'keepRoof', 'towerBase',
  'towerStairHead', 'arena'];
const marks = await alive((names) => {
  const g = window.__gameDebug;
  const out = {};
  for (const n of names) out[n] = g.castleMarkerPos(n);
  return out;
}, NAMES);
for (const [k, v] of Object.entries(marks)) {
  if (v === null) throw new Error(`marker "${k}" is missing`);
  console.log(`  ${k.padEnd(22)} ${v.map((n) => n.toFixed(1)).join(', ')}`);
}

/**
 * Walk to a marker and assert the storey.
 *
 * `floorOf` is the marker whose Y the player must end up on. That is the whole
 * point of this harness: `castleTeleport` can put you at the top of a flight
 * without the flight existing, and XZ arrival cannot tell one storey from the
 * one below it when the stair shaft is vertical.
 */
async function climb(to, seconds, note, { pitch = 0.5, dist = 4.5, tol = 2.4,
  sprint = false, slackY = 1.2, nudge = null } = {}) {
  // `nudge` walks to a point offset from the marker in XZ. The storey is still
  // asserted against the marker itself, so a dogleg cannot quietly land a floor
  // out and call it arrival.
  const target = nudge === null
    ? [marks[to][0], marks[to][2]]
    : [marks[to][0] + nudge[0], marks[to][2] + nudge[1]];
  const TICK = 0.25;
  const steps = Math.max(1, Math.round(seconds / TICK));
  let arrived = false;
  let ungrounded = 0;
  let samples = 0;
  if (sprint) await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  for (let i = 0; i < steps && !arrived; i++) {
    const s = await alive(([t, p, d, tl]) => {
      const g = window.__gameDebug;
      const [px, , pz] = g.playerPos();
      g.setCamera(Math.atan2(-(t[0] - px), -(t[1] - pz)), p, d);
      return { done: Math.hypot(t[0] - px, t[1] - pz) <= tl, g: g.playerMotion().grounded };
    }, [target, pitch, dist, tol]);
    arrived = s.done;
    samples++;
    if (!s.g) ungrounded++;
    await page.waitForTimeout(TICK * 1000);
  }
  await page.keyboard.up('KeyW');
  if (sprint) await page.keyboard.up('ShiftLeft');
  await page.waitForTimeout(300);
  const st = await snap(note);
  const left = Math.hypot(st.pos[0] - target[0], st.pos[2] - target[1]);
  const dy = st.pos[1] - marks[to][1];
  console.log(`     ${left.toFixed(1)} m short, y ${st.pos[1].toFixed(2)} `
    + `(${dy >= 0 ? '+' : ''}${dy.toFixed(2)} vs marker), ungrounded ${ungrounded}/${samples}`);
  expect(`${note}: arrived`, arrived, `${left.toFixed(1)} m short`);
  expect(`${note}: on the right storey`, Math.abs(dy) < slackY,
    `${dy.toFixed(2)} m off ${to}`);
  return st;
}

console.log('\n=== undercroft to the courtyard ===');
await alive(() => window.__gameDebug.castleTeleport('spawn'));
await page.waitForTimeout(700);
await alive(() => window.__gameDebug.setCamera(0, 0.3, 5));
await snap('the-cell');
await climb('undercroftStairFoot', 16, 'undercroft-stair-foot');

/**
 * Climb ONE flight, in isolation: drop in at its foot and walk to its head.
 *
 * The first three versions of this harness tried to walk the whole keep in one
 * route — hall, through a wing door, down the wing to the stair, up it, back
 * out through the wing above. That is a pathfinding problem, and it failed
 * differently every run: a beat that stops 6 m short against a wing wall on the
 * RIGHT storey looks exactly like a beat that fell down a stairwell, and one
 * run in three the player never left the undercroft at all. None of that is
 * evidence about the flights, which is what this file is for.
 *
 * So each flight is filmed on its own. `castleTeleport` puts the player 40 cm
 * over the foot marker, and from there it is real input the whole way up. The
 * assertion is the storey: the head marker's own Y, which is `LEVEL_Y[n+1]`,
 * and no amount of arriving at the right XZ can fake it.
 */
async function flight(foot, head, seconds, note, opts = {}) {
  await alive((m) => window.__gameDebug.castleTeleport(m), foot);
  await page.waitForTimeout(800);
  const from = await alive(() => window.__gameDebug.playerPos());
  const rise = marks[head][1] - marks[foot][1];
  console.log(`  ${note}: from y ${from[1].toFixed(2)}, ${rise.toFixed(1)} m to climb`);
  const st = await climb(head, seconds, note, opts);
  if (opts.nudge !== undefined && opts.nudge !== null) return st;
  expect(`${note}: gained the full ${rise.toFixed(1)} m`,
    st.pos[1] - from[1] > rise - 1.0,
    `gained ${(st.pos[1] - from[1]).toFixed(2)} m`);
  return st;
}

console.log('\n=== every flight, one at a time ===');
await flight('undercroftStairFoot', 'undercroftStairHead', 26, 'undercroft-to-l1');
await flight('stair12', 'stair12Head', 26, 'l1-to-l2');
await flight('stair23', 'stair23Head', 30, 'l2-to-l3');
await flight('stair3T', 'stair3THead', 30, 'l3-to-the-keep-roof');
// The tower flight is 27 m of straight ramp in a 6 m wide slot inside a round
// shaft, and steering it in one 30 m leg drifts off the side about half the
// time. Two legs, aimed up the middle, is steering — not an extra claim.
await flight('towerBase', 'towerStairHead', 30, 'up-the-tower-flight',
  { pitch: 0.35, dist: 6, tol: 2.6, slackY: 12, nudge: [-14.5, 0] });
await climb('towerStairHead', 30, 'keep-roof-to-the-arena',
  { pitch: 0.35, dist: 6, tol: 2.6, slackY: 1.6 });
// Round the stair mouth, not across it. The arena disc has a 27 x 6 m hole in
// it where the tower flight surfaces, and the straight line from the top step
// to the middle of the disc goes through it — a 13.5 m drop back down the shaft
// at the door of the boss arena.
await climb('arena', 14, 'clear-of-the-stair-mouth',
  { pitch: 0.3, dist: 7, tol: 2.4, nudge: [12, 0] });
// ...and round the braziers, which are 1.2 m of solid basalt now that they are
// not something the player wades through. The disc's clear line to the middle
// is south of them.
await climb('arena', 16, 'past-the-braziers',
  { pitch: 0.3, dist: 7, tol: 2.4, nudge: [10, -7] });
await climb('arena', 20, 'out-onto-the-arena-disc',
  { pitch: 0.3, dist: 7, tol: 2.8, slackY: 1.2, nudge: [0, -3] });

console.log('\n=== and the rooms they land in ===');
await alive(() => window.__gameDebug.castleTeleport('L2hall'));
await page.waitForTimeout(700);
await alive(() => window.__gameDebug.setCamera(0.7, 0.35, 7));
await snap('level-2-hall');
await alive(() => window.__gameDebug.castleTeleport('throne'));
await page.waitForTimeout(700);
await alive(() => window.__gameDebug.setCamera(Math.PI, 0.3, 7));
await snap('the-throne-room');
await alive(() => window.__gameDebug.castleTeleport('keepRoof'));
await page.waitForTimeout(700);
await alive(() => window.__gameDebug.setCamera(0, 0.25, 8));
await snap('the-keep-roof');
await alive(() => window.__gameDebug.castleTeleport('arena'));
await page.waitForTimeout(700);
await alive(() => window.__gameDebug.setCamera(0, 0.25, 9));
await snap('the-dragon-s-arena');

const verdict = { beatFailures: failures, reloads, reboots, errors: errors.slice(0, 10) };
fs.writeFileSync(path.join(outDir, 'session.json'),
  JSON.stringify({ verdict, log }, null, 2));

console.log(`\n${failures.length} BEAT FAILURE(S)`);
for (const f of failures) console.log(`  !! ${f}`);
if (reboots > 0) console.log(`!! ${reboots} mid-run reboot(s) — NOT trustworthy`);
console.log(errors.length ? `${errors.length} page errors` : 'no page errors');
await browser.close();
if (errors.length || failures.length || reboots) process.exitCode = 1;
