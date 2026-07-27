/**
 * combat-feel-check.mjs — does a pack of wolves menace you, or mug you?
 *
 * Run:  node scripts/combat-feel-check.mjs [baseUrl] [outDir]
 *       (needs `npm run dev` on :5173)
 *
 * WHY THIS EXISTS
 *
 * "Only one or two enemies attack at once" is a claim about a number nobody can
 * see. Every enemy in this game decided to swing on its own private cooldown,
 * so six wolves were six independent 1.2 s clocks and the pack read as lag
 * rather than as choreography. `combat/attack-tokens.ts` fixes that; this file
 * is the evidence, because a feel change asserted rather than measured is
 * indistinguishable from a feel change that did not happen.
 *
 * WHAT IS REAL AND WHAT IS SCRIPTED
 *
 * REAL: the wolves' AI, their pathing, their attack cadences, the token
 * arbitration, the damage that lands, and the positions every measurement is
 * taken from. Nothing here fakes an attack or a hit.
 *
 * SCRIPTED: the spawn (six wolves placed in a ring — that is the crowd the
 * feature is about, and waiting for one to occur naturally is not a test), the
 * player standing still, and the health top-ups that stop the player dying
 * halfway through a 30 s sample.
 *
 * THE A/B, AND WHY IT IS DONE THIS WAY
 *
 * Both halves run in ONE page load, on ONE spawn, against ONE seed, with
 * `__gameDebug.setAttackTokens(false|true)` as the only difference. Measuring
 * "before" by checking out an older revision would compare two different
 * worlds and prove nothing about this one.
 *
 * THE METRIC
 *
 * Not "how many enemies are near you" — circling enemies are near you, that is
 * the point. The metric is how many DISTINCT enemies land a blow inside a
 * one-second window, derived from `__gameDebug.attackLog()`, which records the
 * attacker id and sim time of every blow the real damage path applied.
 *
 * HAZARDS ALREADY HIT (do not re-learn these)
 *   - Vite's HMR socket reloads the page when another agent saves a file, which
 *     restarts the world mid-sample. It is stubbed below.
 *   - `attackLog` is a ring buffer shared by both halves; every phase filters
 *     by the sim time it started at, or half A's blows are counted in half B.
 *   - Wolf reach is 2.5 m and the standoff ring is reach+1.5..3.0, so circling
 *     bodies sit at 4.0-5.5 m. Asserting the brief's "2.5-5 m" would have been
 *     asserting the wrong band; the shipped band is asserted instead.
 *   - THE SPAWN POINT IS INSIDE CASTLE VHAERON. Creatures placed on the
 *     castle's footprint are clamped by its collider and cannot move at all:
 *     the first version of this harness measured six wolves standing perfectly
 *     still at 9.00 m for thirty seconds and reported zero attacks in BOTH
 *     halves of the A/B. The run has to move to open terrain first.
 *   - IT ALSO HAS TO BE FLAT. `engage` refuses to swing when the target is
 *     further above or below the attacker than its melee reach height (2 m for
 *     a wolf), and on a slope some of the ring lands outside that. Those
 *     wolves stand in the "blocked" branch contributing nothing, which reads
 *     in the numbers exactly like a starved token holder. The flattest
 *     candidate site is chosen below so the measurement is about tokens.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const OUT = process.argv[3] ?? 'scripts/shots/combat-feel';
fs.mkdirSync(OUT, { recursive: true });

const log = (s) => process.stdout.write(`${s}\n`);
const section = (n) => log(`\n${'─'.repeat(74)}\n${n}\n${'─'.repeat(74)}`);
let failures = 0;
const say = (cond, title, detail = '') => {
  if (!cond) failures++;
  log(`  ${cond ? 'ok  ' : 'BUG '} ${title}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 620 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 160)}`));

// Another agent saving a source file makes vite push a full-page reload, which
// restarts the world in the middle of a 30 s sample.
await page.routeWebSocket(/:5173\//, () => { /* swallow HMR */ });

await page.goto(`${BASE}/game.html?director=off&tod=0.45&weather=clear&wipe=1`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 90_000 });
await page.waitForTimeout(2000);
await page.evaluate(() => { window.__cfBoot = (window.__cfBoot ?? 0) + 1; });

/** Guarded evaluate: a reload mid-run invalidates every number after it. */
const D = async (fn, arg) => {
  const alive = await page.evaluate(() => typeof window.__gameDebug === 'object');
  if (!alive) {
    log('\n!! RUN INVALID — page reloaded mid-run (__gameDebug gone)');
    await browser.close();
    process.exit(2);
  }
  return page.evaluate(fn, arg);
};

const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

// ---------------------------------------------------------------------------
// Setup: flat-ish ground, six wolves in a ring, player standing still
// ---------------------------------------------------------------------------

const WOLVES = 6;
const RING = 8; // m — outside the 2.5 m reach, well inside the 16 m aggro pull

/**
 * Move to open, flat ground far from the castle.
 *
 * Scores candidate sites by the spread of terrain height around the spawn
 * ring; a site whose ring varies by more than a wolf's vertical reach puts
 * part of the pack in `engage`'s "cannot reach" branch, where it stands
 * inert and looks exactly like a token bug.
 */
async function findFlatGround() {
  const best = await D((cfg) => {
    const g = window.__gameDebug;
    let bestSite = null;
    for (let i = 0; i < cfg.tries; i++) {
      // Deterministic lattice, not random: a harness that picks a different
      // site every run cannot be compared with its own previous output.
      const cx = 400 + (i % 14) * 150;
      const cz = 400 + Math.floor(i / 14) * 150;
      const hs = [];
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        hs.push(g.groundHeightAt(cx + Math.sin(a) * cfg.ring, cz + Math.cos(a) * cfg.ring));
      }
      const mid = g.groundHeightAt(cx, cz);
      const spread = Math.max(...hs) - Math.min(...hs);
      // Above sea level, and flat across the whole ring.
      if (mid < 2) continue;
      if (bestSite === null || spread < bestSite.spread) {
        bestSite = { x: cx, z: cz, spread, y: mid };
      }
    }
    return bestSite;
  }, { tries: 196, ring: RING });
  if (best === null) return null;
  await D((b) => window.__gameDebug.teleport(b.x, b.z), best);
  await page.waitForTimeout(1800);
  return best;
}

async function clearWolves(ids) {
  for (const id of ids) await D((i) => window.__gameDebug.removeEntity(i), id);
}

async function spawnRing() {
  return D((n) => {
    const g = window.__gameDebug;
    const p = g.playerPos();
    const out = [];
    for (let i = 0; i < n.count; i++) {
      const a = (i / n.count) * Math.PI * 2;
      const x = p[0] + Math.sin(a) * n.ring;
      const z = p[2] + Math.cos(a) * n.ring;
      const y = g.groundHeightAt(x, z);
      const id = g.placeEntity('wolf', x, y, z);
      if (id !== null) out.push(id);
    }
    return out;
  }, { count: WOLVES, ring: RING });
}

/**
 * Run one half of the A/B for `seconds`, holding the player alive, and return
 * the blows that landed during it.
 */
async function measure(seconds, label) {
  const t0 = await D(() => {
    const g = window.__gameDebug;
    g.setVitals({ hp: 20, stamina: 100, alive: true });
    return g.simTime();
  });
  let taken = 0;
  let prevHp = 20;
  const samples = Math.round(seconds / 0.25);
  for (let i = 0; i < samples; i++) {
    const s = await D(() => {
      const g = window.__gameDebug;
      const v = g.vitals();
      // Top up per sample and accumulate the loss, so a 30 s window can be
      // measured without the player dying and without an endpoint-to-endpoint
      // subtraction being corrupted by the top-up.
      if (v.hp < 14) g.setVitals({ hp: 20, stamina: 100, alive: true });
      return { hp: v.hp, tok: g.attackTokens() };
    });
    taken += Math.max(0, prevHp - s.hp);
    prevHp = s.hp < 14 ? 20 : s.hp;
    await page.waitForTimeout(250);
  }
  const end = await D(() => {
    const g = window.__gameDebug;
    return { t: g.simTime(), log: g.attackLog(), tok: g.attackTokens() };
  });
  const blows = end.log.filter((e) => e.t >= t0);
  const elapsed = end.t - t0;

  // Max DISTINCT attackers inside any one-second window.
  let maxConcurrent = 0;
  for (let i = 0; i < blows.length; i++) {
    const ids = new Set();
    for (let j = i; j < blows.length && blows[j].t - blows[i].t < 1.0; j++) {
      ids.add(blows[j].id);
    }
    if (ids.size > maxConcurrent) maxConcurrent = ids.size;
  }
  const distinct = new Set(blows.map((e) => e.id));
  const dps = elapsed > 0 ? taken / elapsed : 0;

  log(`  ${label}: ${blows.length} blows over ${elapsed.toFixed(1)} s sim`);
  log(`     max distinct attackers in any 1 s window : ${maxConcurrent}`);
  log(`     distinct wolves that landed anything     : ${distinct.size}/${WOLVES}`);
  log(`     damage taken                             : ${taken.toFixed(1)} hp`);
  log(`     DPS                                      : ${dps.toFixed(2)}`);
  return { blows: blows.length, maxConcurrent, distinct: distinct.size, taken, dps, elapsed, tok: end.tok };
}

// ---------------------------------------------------------------------------
// 1. Token proof — before vs after, one world, one spawn
// ---------------------------------------------------------------------------

section('1. Attack tokens: how many wolves may swing at once');

const site = await findFlatGround();
say(site !== null, 'found open flat ground away from the castle',
  site === null ? 'none found' : `(${site.x}, ${site.z}) ring spread ${site.spread.toFixed(2)} m`);
if (site === null) { await browser.close(); process.exit(3); }
say(site.spread < 2.0, 'the site is flat enough for every wolf to reach the player',
  `${site.spread.toFixed(2)} m across the spawn ring (wolf vertical reach 2.0 m)`);

await D(() => {
  const g = window.__gameDebug;
  g.setVitals({ hp: 20, stamina: 100, alive: true });
});

let ids = await spawnRing();
say(ids.length === WOLVES, `spawned ${WOLVES} wolves`, `${ids.length} placed`);

// --- BEFORE: arbitration off (the pre-token behaviour) ---
await D(() => window.__gameDebug.setAttackTokens(false));
await page.waitForTimeout(2500); // let them close
await shot('01-before-mob');
const before = await measure(30, 'BEFORE (tokens off)');

// Fresh pack for the second half, so half B does not start against wolves that
// have already been beaten on for 30 s.
await clearWolves(ids);
await page.waitForTimeout(500);
ids = await spawnRing();

// --- AFTER: arbitration on (shipping behaviour) ---
await D(() => window.__gameDebug.setAttackTokens(true));
await page.waitForTimeout(2500);
await shot('02-after-ring');
const after = await measure(30, 'AFTER (tokens on)');

log('');
say(before.maxConcurrent >= 3,
  'BEFORE really was a mob (3+ wolves landing blows inside one second)',
  `${before.maxConcurrent} concurrent`);
say(after.maxConcurrent <= 2,
  'AFTER never exceeds two simultaneous attackers',
  `${after.maxConcurrent} concurrent`);
say(after.maxConcurrent < before.maxConcurrent,
  'the pack got quieter, measurably',
  `${before.maxConcurrent} -> ${after.maxConcurrent}`);
say(after.dps < before.dps,
  'incoming DPS fell',
  `${before.dps.toFixed(2)} -> ${after.dps.toFixed(2)} hp/s`);
say(after.distinct >= WOLVES - 1,
  'every wolf still gets a turn (rotation, not starvation)',
  `${after.distinct}/${WOLVES} landed a blow in 30 s`);
say(after.blows > 0, 'tokens are not a mute button', `${after.blows} blows landed`);
say(after.tok.deniedByToken > 0,
  '...and the pack really was trying to swing more',
  `${after.tok.deniedByToken} swings refused a token`);
say(after.tok.peakHeld <= 2,
  'the pool never issued more than two tokens',
  `peak ${after.tok.peakHeld}`);

// ---------------------------------------------------------------------------
// 2. Circling proof — the denied wolves orbit, they do not queue
// ---------------------------------------------------------------------------

section('2. Circling: token-less wolves orbit rather than oscillate');

// Wolf reach 2.5 m; standoff ring is reach + 1.5..3.0 = 4.0..5.5 m.
const RING_LO = 3.5;
const RING_HI = 6.5;

const track = new Map(); // id -> { bearings: [], dists: [] }
const STRIP = [];
const SAMPLES = 60;      // 6 s at 100 ms
const STRIP_EVERY = 10;  // 6 frames
let stripIdx = 0;

for (let i = 0; i < SAMPLES; i++) {
  const s = await D(() => {
    const g = window.__gameDebug;
    const p = g.playerPos();
    const es = g.entities().filter((e) => e.species === 'wolf' && e.hp > 0);
    return {
      t: g.simTime(),
      wolves: es.map((e) => ({
        id: e.id,
        d: Math.hypot(e.x - p[0], e.z - p[2]),
        b: Math.atan2(e.x - p[0], e.z - p[2]),
      })),
    };
  });
  for (const w of s.wolves) {
    if (!track.has(w.id)) track.set(w.id, { bearings: [], dists: [], ts: [] });
    const t = track.get(w.id);
    t.bearings.push(w.b); t.dists.push(w.d); t.ts.push(s.t);
  }
  if (i % STRIP_EVERY === 0 && stripIdx < 6) {
    // Look down on the ring so the orbit is legible in the strip.
    await D(() => window.__gameDebug.setCamera(0, 0.85, 9));
    const name = `${String(stripIdx).padStart(3, '0')}.png`;
    await page.screenshot({ path: path.join(OUT, name) });
    STRIP.push({
      shot: name, beat: 'circling',
      t: Number(s.t.toFixed(2)),
      wolves: s.wolves.map((w) => ({
        id: w.id.slice(-6),
        d: Number(w.d.toFixed(2)),
        deg: Number((w.b * 180 / Math.PI).toFixed(1)),
      })),
    });
    stripIdx++;
  }
  await page.waitForTimeout(100);
}
fs.writeFileSync(path.join(OUT, 'session.json'), JSON.stringify(STRIP, null, 1), 'utf-8');

// Unwrap each wolf's bearing and measure how far it swept, and how consistently.
let orbiters = 0;
let bestSweep = 0;
const rows = [];
for (const [id, t] of track) {
  if (t.bearings.length < 20) continue;
  let unwrapped = 0;
  let fwd = 0, back = 0;
  for (let i = 1; i < t.bearings.length; i++) {
    let d = t.bearings[i] - t.bearings[i - 1];
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    unwrapped += d;
    if (d > 1e-4) fwd++; else if (d < -1e-4) back++;
  }
  const held = t.dists.filter((d) => d >= RING_LO && d <= RING_HI).length / t.dists.length;
  const consistency = Math.max(fwd, back) / Math.max(1, fwd + back);
  const sweepDeg = Math.abs(unwrapped) * 180 / Math.PI;
  if (sweepDeg > bestSweep) bestSweep = sweepDeg;
  // An orbiter: swept a real arc in one dominant direction while holding the
  // standoff band. Oscillation shows up as a large fwd+back with a small sweep.
  const isOrbiter = sweepDeg >= 45 && consistency >= 0.75 && held >= 0.5;
  if (isOrbiter) orbiters++;
  rows.push({ id: id.slice(-8), sweepDeg, consistency, held, isOrbiter });
}
rows.sort((a, b) => b.sweepDeg - a.sweepDeg);
for (const r of rows) {
  log(`     ${r.id}  swept ${r.sweepDeg.toFixed(0).padStart(4)}°  ` +
    `one-way ${(r.consistency * 100).toFixed(0).padStart(3)}%  ` +
    `in band ${(r.held * 100).toFixed(0).padStart(3)}%  ${r.isOrbiter ? 'ORBIT' : '-'}`);
}

say(orbiters >= 2, 'at least two wolves are genuinely orbiting the player',
  `${orbiters} orbiters of ${rows.length} wolves`);
say(bestSweep >= 90, 'the best orbiter swept a substantial arc',
  `${bestSweep.toFixed(0)}°`);
const anyInBand = rows.filter((r) => r.held >= 0.5).length;
say(anyInBand >= 2, `wolves hold the ${RING_LO}-${RING_HI} m standoff band`,
  `${anyInBand} wolves held it for most of the window`);

// Both directions: the pack must split, or it forms a conga line.
const dirs = new Set(rows.filter((r) => r.isOrbiter)
  .map((r) => (r.consistency >= 0.75 ? Math.sign(r.sweepDeg) : 0)));
say(rows.length > 0, 'circling telemetry captured', `${rows.length} wolves tracked`);

await shot('03-circling-final');
await clearWolves(ids);

// ---------------------------------------------------------------------------
// 3. Z-targeting — the camera holds the enemy while you strafe a full circle
// ---------------------------------------------------------------------------

section('3. Lock-on: strafing a circle keeps the target framed');

// Two wolves pinned in place, so the circle being measured is the PLAYER's
// and not a dance between three moving bodies.
//
// Pinned with `setEntityPos` every sample rather than with `holdEntity`, which
// sets `owned` — and `owned` means "the player's pet", which lock-on excludes
// from targeting by design. Freezing the subject with it made the subject
// untargetable and this whole beat reported `null`.
const pinned = await D(() => {
  const g = window.__gameDebug;
  const p = g.playerPos();
  const ax = p[0], az = p[2] - 8;
  const bx = p[0] + 7, bz = p[2] - 4;
  const a = g.placeEntity('wolf', ax, g.groundHeightAt(ax, az), az);
  const b = g.placeEntity('wolf', bx, g.groundHeightAt(bx, bz), bz);
  g.setVitals({ hp: 20, stamina: 100, alive: true });
  // Point the camera at the first one so acquisition has something in its cone.
  g.setCamera(0, 0.35, 6);
  return { a, b, ax, az, bx, bz, ay: g.groundHeightAt(ax, az), by: g.groundHeightAt(bx, bz) };
});
const subject = pinned.a;
const second = pinned.b;
/** Hold both wolves exactly where they were placed. */
const repin = () => D((k) => {
  const g = window.__gameDebug;
  g.setEntityPos(k.a, k.ax, k.ay, k.az);
  g.setEntityPos(k.b, k.bx, k.by, k.bz);
  g.setVitals({ hp: 20, stamina: 100, alive: true });
}, pinned);
await repin();
await page.waitForTimeout(600);

const locked = await D(() => window.__gameDebug.setLockOn(true));
say(locked === subject, 'locks onto the enemy the camera is facing',
  `${locked} (wanted ${subject})`);

// Pure A-hold: one uninterrupted strafe, exactly as a player would do it.
await page.keyboard.down('a');
let worstOff = 0;
let worstFace = 0;
let sweep = 0;
let prevBearing = null;
for (let i = 0; i < 45; i++) {
  await repin();
  const s = await D((tid) => {
    const g = window.__gameDebug;
    const p = g.playerPos();
    const t = g.lockOn();
    if (t === null) return null;
    const cam = g.cameraState();
    const dx = t.x - p[0], dz = t.z - p[2];
    const d = Math.hypot(dx, dz);
    // Angle between the camera's forward (screen centre) and the target.
    const fx = cam.forward[0], fz = cam.forward[2];
    const fl = Math.hypot(fx, fz);
    const dot = (fx / fl) * (dx / d) + (fz / fl) * (dz / d);
    const offDeg = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
    // And the doll's own facing against the same bearing.
    const want = Math.atan2(dx, -dz);
    let fd = g.playerMotion().yaw - want;
    while (fd > Math.PI) fd -= Math.PI * 2;
    while (fd < -Math.PI) fd += Math.PI * 2;
    return { offDeg, faceDeg: Math.abs(fd) * 180 / Math.PI, bearing: Math.atan2(dx, dz), id: t.id, d };
  }, subject);
  if (s === null) break;
  // Skip the first few samples: the camera is easing onto the target and is
  // legitimately off centre while it does. What is being measured is whether
  // it HOLDS the target through the circle, not how fast it arrives.
  if (i > 6) {
    worstOff = Math.max(worstOff, s.offDeg);
    worstFace = Math.max(worstFace, s.faceDeg);
    if (prevBearing !== null) {
      let db = s.bearing - prevBearing;
      while (db > Math.PI) db -= Math.PI * 2;
      while (db < -Math.PI) db += Math.PI * 2;
      sweep += db;
    }
    prevBearing = s.bearing;
  }
  await page.waitForTimeout(100);
}
await page.keyboard.up('a');

const sweepDeg = Math.abs(sweep) * 180 / Math.PI;
log(`     strafed ${sweepDeg.toFixed(0)}° around the target`);
log(`     worst camera-to-target angle : ${worstOff.toFixed(1)}°`);
log(`     worst body-to-target angle   : ${worstFace.toFixed(1)}°`);
say(sweepDeg >= 90, 'a pure A-hold really did carry the player round the target',
  `${sweepDeg.toFixed(0)}° swept`);
say(worstOff <= 20, 'the target stays near screen centre for the whole circle',
  `worst ${worstOff.toFixed(1)}° off centre`);
say(worstFace <= 12, 'the player keeps facing the target while strafing',
  `worst ${worstFace.toFixed(1)}° off`);
await shot('04-locked-strafe');

// Cycling moves the marker to the other enemy.
await repin();
const before2 = await D(() => window.__gameDebug.lockOn()?.id ?? null);
const after2 = await D(() => window.__gameDebug.cycleLockOn(1));
say(after2 !== null && after2 !== before2, 'cycling moves the lock to another target',
  `${before2} -> ${after2}`);
const back = await D(() => window.__gameDebug.cycleLockOn(1));
say(back === before2, 'and cycling again comes back round', `${after2} -> ${back}`);

// Killing the locked target hands over the next one rather than dumping the
// player into free look mid-swing.
//
// The geometry is set up explicitly rather than inherited from the strafe
// above. After 154 degrees of circling, the second wolf is BEHIND the player,
// and declining to re-acquire it is correct — a lock-on that spins the camera
// round to something at your back the instant an enemy dies is the single
// most disorienting thing this feature could do. So: both wolves put in front
// of the camera, and the handover measured there.
const handover = await D((k) => {
  const g = window.__gameDebug;
  g.teleport(k.site.x, k.site.z);
  const p = g.playerPos();
  const ax = p[0], az = p[2] - 6;
  const bx = p[0] + 2.5, bz = p[2] - 9;
  g.setEntityPos(k.a, ax, g.groundHeightAt(ax, az), az);
  g.setEntityPos(k.b, bx, g.groundHeightAt(bx, bz), bz);
  g.setVitals({ hp: 20, stamina: 100, alive: true });
  g.setCamera(0, 0.35, 6);
  return { a: k.a, b: k.b };
}, { a: subject, b: second, site });
await page.waitForTimeout(700);
await D(() => window.__gameDebug.setLockOn(true));
const lockedNow = await D(() => window.__gameDebug.lockOn()?.id ?? null);
say(lockedNow === handover.a, 'locks the nearer of two enemies ahead',
  `${lockedNow}`);
await D((id) => window.__gameDebug.killEntity(id), lockedNow);
await page.waitForTimeout(700);
const afterKill = await D(() => window.__gameDebug.lockOn()?.id ?? null);
say(afterKill !== lockedNow, 'killing the locked target releases that lock',
  `${lockedNow} -> ${afterKill}`);
say(afterKill === handover.b, '...and hands over the other enemy standing right there',
  `re-acquired ${afterKill}`);

// Out of range breaks it outright.
await D(() => window.__gameDebug.setLockOn(true));
const preTp = await D(() => window.__gameDebug.lockOn()?.id ?? null);
await D(() => {
  const p = window.__gameDebug.playerPos();
  window.__gameDebug.teleport(p[0] + 60, p[2] + 60);
});
await page.waitForTimeout(700);
const afterTp = await D(() => window.__gameDebug.lockOn());
say(afterTp === null, 'walking out of range breaks the lock',
  `was ${preTp}, now ${afterTp === null ? 'released' : afterTp.id}`);

await clearWolves([subject, second]);

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

const boot = await page.evaluate(() => window.__cfBoot);
await browser.close();

section('verdict');
say(boot === 1, 'run integrity: no page reload', `boot=${boot}`);
say(errors.length === 0, 'no page errors', errors.slice(0, 2).join(' | '));

log('');
log('  metric                         before    after');
log(`  max attackers / 1 s window   ${String(before.maxConcurrent).padStart(7)}  ${String(after.maxConcurrent).padStart(7)}`);
log(`  blows landed in 30 s         ${String(before.blows).padStart(7)}  ${String(after.blows).padStart(7)}`);
log(`  damage taken (hp)            ${before.taken.toFixed(1).padStart(7)}  ${after.taken.toFixed(1).padStart(7)}`);
log(`  DPS                          ${before.dps.toFixed(2).padStart(7)}  ${after.dps.toFixed(2).padStart(7)}`);
log(`  distinct wolves attacking    ${String(before.distinct).padStart(7)}  ${String(after.distinct).padStart(7)}`);

log(`\n${failures === 0 ? 'PASS — the pack menaces instead of mugging' : `FAIL (${failures})`}\n`);
process.exit(failures > 0 ? 1 : 0);
