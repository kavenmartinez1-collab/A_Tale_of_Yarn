/**
 * Walks the curtain wall-walk. Real WASD, the whole circuit, filmed.
 *
 *   node scripts/castle-wallwalk.mjs [outDir]
 *
 * ## Why a second Playwright harness
 *
 * `test-castle-layout.mts` drives the same route through the same collider and
 * asserts the same things, and it is not enough. The 200 m of wall-walk this
 * exists to prove out was, until this pass, a plane the player could stand on
 * and not move off — and every numeric check in the repo passed the entire
 * time, because the deck was declared correctly and the wall was simply built
 * 1.4 m too tall around it. The route was reachable in the flood, the ramps
 * were within gradient, the mesh was in budget. Nobody had walked it.
 *
 * So this walks it with the keys a player would press, and it samples
 * `playerMotion().grounded` EVERY tick rather than once per beat: a beat that
 * ends in the right place having fallen into the courtyard and climbed back out
 * is a beat that passes on position alone.
 *
 * ## Camera conventions that have cost hours here
 *
 * Orbit yaw 0 is BEHIND the player. Walking toward (tx, tz) is
 * `setCamera(atan2(-(tx-px), -(tz-pz)), ...)` then holding KeyW — forward is
 * `(-sin yaw, -cos yaw)`, and the sign that looks right walks you away.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] || 'scripts/shots/castle-wallwalk';
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
await page.evaluate(() => { window.__wallWalkToken = 1; });

let shot = 0;
const log = [];
const failures = [];

function expect(name, cond, detail) {
  if (!cond) {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  !! FAILED: ${name}${detail ? ` — ${detail}` : ''}`);
  } else console.log(`  ok  ${name}`);
}

let reloads = 0;
let reboots = 0;
let lastFrames = 0;

/**
 * Survive a Vite hot-reload, and REFUSE to believe a run that had one.
 *
 * Three agents are live in this repo and any of them writing a source file
 * mid-run replaces every manager behind `__gameDebug`. A filmstrip here once
 * had every frame at the spawn position for exactly that reason and the beats
 * were filed as successes, so the sentinel is checked before every evaluate and
 * the reboot count rides in the verdict.
 */
async function alive(fn, arg) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ok = await page.evaluate(() => window.__gameReady === true
        && window.__wallWalkToken === 1
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
    await page.evaluate(() => { window.__wallWalkToken = 1; }).catch(() => {});
  }
  throw new Error('page never came back after a reload');
}

async function snap(note) {
  const st = await alive(() => ({
    pos: window.__gameDebug.playerPos().map((v) => Math.round(v * 100) / 100),
    motion: window.__gameDebug.playerMotion(),
    fps: Math.round(window.__gameStats.fps ?? 0),
  }));
  const name = `${String(shot).padStart(2, '0')}-${note.replace(/[^a-z0-9]+/gi, '-')}.png`;
  await page.screenshot({ path: path.join(outDir, name) });
  log.push({ shot: name, note, ...st });
  console.log(`  ${name.padEnd(34)} pos ${JSON.stringify(st.pos)} `
    + `grounded=${st.motion.grounded} fps=${st.fps}`);
  shot++;
  return st;
}

// --- the route, read out of the layout -----------------------------------

const marks = await alive((names) => {
  const g = window.__gameDebug;
  const out = {};
  for (const n of names) out[n] = g.castleMarkerPos(n);
  return out;
}, ['frontCourt', 'backCourt',
  'wallStairW', 'wallHeadW', 'wallDeckW', 'wallNW', 'wallGate', 'wallNE',
  'wallBreachN', 'wallSW', 'wallSE', 'wallBreachS', 'wallDeckE', 'wallHeadE',
  'wallStairE']);
for (const [k, v] of Object.entries(marks)) {
  if (v === null) throw new Error(`marker "${k}" is missing`);
}
const DECK_Y = marks.wallNW[1];
console.log(`deck height ${DECK_Y.toFixed(2)}  (world)`);

/**
 * Walk to a marker, sampling `grounded` and Y every tick on the way.
 *
 * `minY`/`ungrounded` are the whole point: arriving is not the claim. The claim
 * is that the player was on the deck for the entire leg. A leg that drops into
 * the courtyard and walks back up the flight arrives at the right marker.
 */
async function leg(toName, seconds, note, { onDeck = true, tol = 1.6, pitch = 0.16,
  dist = 6.5, expectStuck = false } = {}) {
  const target = [marks[toName][0], marks[toName][2]];
  const TICK = 0.25;
  const steps = Math.max(1, Math.round(seconds / TICK));
  let arrived = false;
  let ungrounded = 0;
  let minY = Infinity;
  let samples = 0;
  await page.keyboard.down('KeyW');
  for (let i = 0; i < steps && !arrived; i++) {
    const s = await alive(([t, p, d, tl]) => {
      const g = window.__gameDebug;
      const [px, py, pz] = g.playerPos();
      g.setCamera(Math.atan2(-(t[0] - px), -(t[1] - pz)), p, d);
      const mo = g.playerMotion();
      return { done: Math.hypot(t[0] - px, t[1] - pz) <= tl, y: py, g: mo.grounded };
    }, [target, pitch, dist, tol]);
    arrived = s.done;
    samples++;
    if (!s.g) ungrounded++;
    if (s.y < minY) minY = s.y;
    await page.waitForTimeout(TICK * 1000);
  }
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(250);
  const st = await snap(note);
  const left = Math.hypot(st.pos[0] - target[0], st.pos[2] - target[1]);
  const drop = DECK_Y - minY;
  console.log(`     ${left.toFixed(1)} m short, lowest y ${minY.toFixed(2)} `
    + `(${drop.toFixed(2)} below deck), ungrounded ${ungrounded}/${samples}`);
  if (expectStuck) {
    expect(`${note}: stopped short, as the breach should`, !arrived,
      `arrived anyway, ${left.toFixed(1)} m`);
  } else {
    expect(`${note}: arrived`, arrived, `${left.toFixed(1)} m short`);
  }
  if (onDeck) {
    // 0.6 m of slack: the controller lands a hair under the plane between
    // substeps and `grounded` flickers on a slope, but a fall off the wall is
    // 7.6 m and cannot hide in that.
    expect(`${note}: never left the deck`, drop < 0.6, `dropped ${drop.toFixed(2)} m`);
    expect(`${note}: stayed grounded`, ungrounded <= Math.max(1, samples * 0.12),
      `${ungrounded}/${samples} airborne ticks`);
  }
  return { left, minY, ungrounded, samples };
}

// --- the walk -------------------------------------------------------------

console.log('\n=== up the west flight ===');
await alive(() => window.__gameDebug.castleTeleport('frontCourt'));
await page.waitForTimeout(600);
await alive(() => window.__gameDebug.setCamera(0.9, 0.2, 7));
await snap('front-courtyard');

await leg('wallStairW', 16, 'foot-of-the-west-flight', { onDeck: false, tol: 2.2 });
const climb = await leg('wallHeadW', 16, 'top-of-the-west-flight',
  { onDeck: false, tol: 2.0 });
const headY = (await alive(() => window.__gameDebug.playerPos()))[1];
expect('the west flight reaches the deck', Math.abs(headY - DECK_Y) < 0.6,
  `stair head y ${headY.toFixed(2)} vs deck ${DECK_Y.toFixed(2)}`);

console.log('\n=== the circuit, anticlockwise ===');
await leg('wallDeckW', 10, 'onto-the-west-deck');
await leg('wallNW', 20, 'nw-corner-tower');
await leg('wallGate', 30, 'over-the-gatehouse');
await leg('wallNE', 30, 'ne-corner-tower');
await leg('wallBreachN', 30, 'east-deck-to-the-breach');
await leg('wallBreachS', 14, 'the-breach-stops-the-walk',
  { expectStuck: true, tol: 1.6 });

console.log('\n=== back round the other way ===');
await leg('wallNE', 30, 'back-to-the-ne-corner');
await leg('wallGate', 30, 'back-over-the-gate');
await leg('wallNW', 30, 'back-to-the-nw-corner');
await leg('wallDeckW', 20, 'back-down-the-west-deck');
await leg('wallSW', 26, 'sw-corner-tower');
await leg('wallSE', 40, 'along-the-south-deck');
await leg('wallDeckE', 20, 'up-the-east-deck');
await leg('wallHeadE', 10, 'east-stair-head');
await leg('wallStairE', 16, 'down-into-the-back-courtyard', { onDeck: false, tol: 2.4 });
const footY = (await alive(() => window.__gameDebug.playerPos()))[1];
expect('the east flight comes back down to the courtyard',
  Math.abs(footY - marks.wallStairE[1]) < 1.0,
  `foot y ${footY.toFixed(2)} vs courtyard ${marks.wallStairE[1].toFixed(2)}`);

// --- the silhouette the change is really about ---------------------------

console.log('\n=== exterior ===');
for (const [name, dx, dz, pitch, dist] of [
  ['silhouette-east', 180, 60, 0.16, 130],
  ['silhouette-northeast', 150, -140, 0.14, 150],
  ['silhouette-south', 20, 190, 0.14, 150],
]) {
  const centre = [-320, 40];
  await alive(([x, z]) => window.__gameDebug.teleport(x, z),
    [centre[0] + dx, centre[1] + dz]);
  await page.waitForTimeout(900);
  await alive(([c, p, d]) => {
    const g = window.__gameDebug;
    const [px, , pz] = g.playerPos();
    g.setCamera(Math.atan2(-(c[0] - px), -(c[1] - pz)), p, d);
  }, [centre, pitch, dist]);
  await page.waitForTimeout(700);
  await snap(name);
}

// --- verdict --------------------------------------------------------------

const verdict = {
  beatFailures: failures,
  deckY: DECK_Y,
  climbShort: climb.left,
  reloads, reboots,
  errors: errors.slice(0, 10),
};
fs.writeFileSync(path.join(outDir, 'session.json'),
  JSON.stringify({ verdict, log }, null, 2));

console.log(`\n${failures.length} BEAT FAILURE(S)`);
for (const f of failures) console.log(`  !! ${f}`);
if (reboots > 0) {
  console.log(`!! ${reboots} mid-run reboot(s) — this filmstrip is NOT trustworthy`);
}
console.log(errors.length ? `${errors.length} page errors` : 'no page errors');
await browser.close();
if (errors.length || failures.length || reboots) process.exitCode = 1;
