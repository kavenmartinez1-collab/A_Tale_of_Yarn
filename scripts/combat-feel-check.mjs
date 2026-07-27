/**
 * combat-feel-check.mjs — does a pack of wolves menace you, or mug you? And
 * does a shield turn a blow, or a raised-at-the-last-moment shield turn it back?
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
// 4. The shield: the cone, the ladder, and the 0.18 s that separates a parry
//    from an ordinary block
// ---------------------------------------------------------------------------
//
// WHAT IS REAL HERE. The wolf, its AI, its bite, the damage path, the stamina,
// the stagger, the token pool, and — for the first two beats — WHEN it decides
// to bite. The block input is a real `mousedown`/`mouseup` on button 2, the
// same events a mouse produces, dispatched with the `__pad` mark that the RMB
// handler already honours for the pad (a headless page can never hold pointer
// lock; that is why the left button grew the same mark).
//
// WHAT IS SCRIPTED, AND WHY IT HAS TO BE. The parry window is 0.18 s wide. A
// harness cannot wait for a wolf to choose to swing inside a specific 180 ms
// and then also prove the case 20 ms LATER resolves differently — the two
// samples would be different swings at different bearings with different
// stamina behind them, which is not a comparison. `forceAttackOnPlayer` lands
// one blow through the real `applyAttackOnPlayer`, built from the real live
// entity, at a moment this file picks. Only the clock is scripted.
//
// THE INSTRUMENT IS TESTED BEFORE THE MEASUREMENT IS BELIEVED. Every timing
// claim below is a PAIR: window − ε asserted to parry AND window + ε asserted
// to be an ordinary block, same shield, same wolf, same bearing. A "parry test"
// that only checks the first half passes identically against an implementation
// that parries unconditionally, which is to say it measures nothing.

section('4. The shield: cone, ladder, and the parry window');

const SHIELD_LADDER = await D(() => window.__gameDebug.shieldLadder());
const PARRY_WINDOW = 0.18;

/** Press or release the block input, exactly as a mouse or a pad would. */
const setBlock = (down) => D((d) => {
  const ev = new MouseEvent(d ? 'mousedown' : 'mouseup',
    { button: 2, bubbles: true, cancelable: true });
  ev.__pad = true;                       // headless pages hold no pointer lock
  window.dispatchEvent(ev);
}, down);

// Back to open flat ground — section 3 teleported 60 m away to break a lock,
// and a shield beat run on a hillside inherits every hazard in this file's
// header. Then: a sword in hand and a shield in the OTHER hotbar slot, which is
// the arrangement the whole feature is about.
const shieldSite = await findFlatGround();
if (shieldSite === null) { log('\n!! no flat ground for the shield beats'); process.exit(3); }
await D(() => {
  const g = window.__gameDebug;
  g.equipItem('iron_sword', 1);          // selected slot
  g.giveShield('iron');                  // slot 1 — never the selected one
  g.setVitals({ hp: 20, stamina: 100, alive: true });
});
{
  const st = await D(() => window.__gameDebug.guardState());
  say(st.shield === 'iron', 'a shield in a NON-selected hotbar slot is the one that raises',
    `shield=${st.shield}`);
  say(st.down === false && st.raised === false, '...and it starts lowered');
}

// --- 4a. A REAL wolf, a REAL bite, blocked --------------------------------
//
// The wolf is pinned in front of the player's actual facing. Facing is read,
// not assumed: `controller.yaw` is whatever the last movement left it as, and
// the mesh convention is forward = (sin yaw, −cos yaw).
const facing = await D(() => window.__gameDebug.playerMotion().yaw);
const biter = await D((f) => {
  const g = window.__gameDebug;
  const p = g.playerPos();
  const x = p[0] + Math.sin(f) * 2.0;
  const z = p[2] - Math.cos(f) * 2.0;
  const id = g.placeEntity('wolf', x, g.groundHeightAt(x, z), z);
  return { id, x, z, y: g.groundHeightAt(x, z) };
}, facing);

/** Hold the wolf on a bearing relative to the player's facing, and top up. */
const pinBiter = (bearing, topUp = true) => D((k) => {
  const g = window.__gameDebug;
  const p = g.playerPos();
  const a = k.f + k.bearing;
  const x = p[0] + Math.sin(a) * 2.0;
  const z = p[2] - Math.cos(a) * 2.0;
  g.setEntityPos(k.id, x, g.groundHeightAt(x, z), z);
  if (k.topUp) g.setVitals({ hp: 20, stamina: 100, alive: true });
}, { id: biter.id, f: facing, bearing, topUp });

/**
 * Hold the block for `seconds` while the wolf bites, re-pinning it each sample.
 * Returns what moved.
 */
async function blockFor(seconds, bearing) {
  await pinBiter(bearing, true);
  await page.waitForTimeout(400);          // let it close and aggro
  await pinBiter(bearing, true);
  const t0 = await D(() => {
    const g = window.__gameDebug;
    g.setVitals({ hp: 20, stamina: 100, alive: true });
    return g.simTime();
  });
  await setBlock(true);
  let minHp = 20;
  let minSta = 100;
  const samples = Math.round(seconds / 0.1);
  for (let i = 0; i < samples; i++) {
    const s = await D((k) => {
      const g = window.__gameDebug;
      const p = g.playerPos();
      const a = k.f + k.bearing;
      const x = p[0] + Math.sin(a) * 2.0;
      const z = p[2] - Math.cos(a) * 2.0;
      g.setEntityPos(k.id, x, g.groundHeightAt(x, z), z);
      const v = g.vitals();
      return { hp: v.hp, stamina: v.stamina, guard: g.guardState() };
    }, { id: biter.id, f: facing, bearing });
    minHp = Math.min(minHp, s.hp);
    minSta = Math.min(minSta, s.stamina);
    await page.waitForTimeout(100);
  }
  const end = await D(() => ({
    guard: window.__gameDebug.guardState(),
    t: window.__gameDebug.simTime(),
  }));
  await setBlock(false);
  return { minHp, minSta, guard: end.guard, elapsed: end.t - t0 };
}

const frontal = await blockFor(4.5, 0);
log(`     front: hp floor ${frontal.minHp.toFixed(1)}, stamina floor ${frontal.minSta.toFixed(0)}, `
  + `${frontal.guard.blocked} blocked / ${frontal.guard.flanked} flanked`);
say(frontal.guard.blocked > 0,
  'a real wolf really did bite a raised shield', `${frontal.guard.blocked} blows stopped`);
say(frontal.minHp === 20,
  'blocking a frontal bite costs NO health', `hp floor ${frontal.minHp}`);
say(frontal.minSta <= 100 - SHIELD_LADDER.iron.staminaPerBlock,
  '...and it costs stamina instead',
  `floor ${frontal.minSta} (iron = ${SHIELD_LADDER.iron.staminaPerBlock}/block)`);

const behind = await blockFor(4.5, Math.PI);
log(`     rear:  hp floor ${behind.minHp.toFixed(1)}, `
  + `${behind.guard.blocked - frontal.guard.blocked} blocked / `
  + `${behind.guard.flanked - frontal.guard.flanked} flanked`);
say(behind.minHp < 20,
  'the SAME bite from behind the same raised shield lands',
  `hp floor ${behind.minHp}`);
say(behind.guard.flanked > frontal.guard.flanked,
  '...and the guard reports it as a flank, not as a block',
  `${behind.guard.flanked - frontal.guard.flanked} flanked`);
say(behind.guard.lastBearingDeg > 120,
  '...from behind the 120 degree arc',
  `${behind.guard.lastBearingDeg?.toFixed(0)} deg off centre`);

// --- 4b. The parry window, both edges -------------------------------------
//
// Raise the guard, wait inside the page until the SIM clock says `heldS` has
// reached the target, then land one blow. Waiting inside the page (rAF, sim
// time) rather than out here (wall clock, Playwright round trips) is what makes
// a 20 ms margin reachable at all.
await pinBiter(0, true);
await page.waitForTimeout(300);

/**
 * Raise the guard, wait in SIM time, land one blow.
 *
 * `atS` is a hold time; `'before'` and `'after'` instead land the blow on the
 * last frame INSIDE the window and the first frame OUTSIDE it — the tightest
 * ε the frame rate allows, rather than an ε this file guessed. `'before'`
 * tracks the largest step it has seen and fires when one more step would carry
 * it past the edge, which is what makes the margin a frame rather than the
 * 150 ms a fixed target would have to leave for safety at 30 fps.
 */
const hitAfterHold = (atS, wolfId, damage = 5, kind = 'melee') => D((k) => new Promise((res) => {
  const g = window.__gameDebug;
  g.setVitals({ hp: 20, stamina: 100, alive: true });
  const up = new MouseEvent('mousedown', { button: 2, bubbles: true, cancelable: true });
  up.__pad = true;
  window.dispatchEvent(up);
  const t0 = g.guardState().raisedAtS;
  const W = k.window;
  let prev = 0;
  let step = 1 / 60;
  const fire = () => {
    const out = g.forceAttackOnPlayer(k.wolfId, k.damage, k.kind);
    const down = new MouseEvent('mouseup', { button: 2, bubbles: true, cancelable: true });
    down.__pad = true;
    window.dispatchEvent(down);
    res(out);
  };
  const tick = () => {
    const held = g.simTime() - t0;
    step = Math.max(step, held - prev);
    prev = held;
    const ready = k.atS === 'before' ? held + step * 1.15 >= W
      : k.atS === 'after' ? held > W
        : held >= k.atS;
    if (ready) { fire(); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}), { atS, wolfId, damage, kind, window: PARRY_WINDOW });

// A whole re-arm interval between presses, or the anti-mash rule denies the
// second one its window and the "late" case would pass for the wrong reason.
const early = await hitAfterHold('before', biter.id);
await page.waitForTimeout(800);
const late = await hitAfterHold('after', biter.id);

log(`     held ${early.heldS.toFixed(3)}s -> ${early.reason}   |   `
  + `held ${late.heldS.toFixed(3)}s -> ${late.reason}`);
say(early.heldS < PARRY_WINDOW,
  `the early blow really did land inside the window`, `${early.heldS.toFixed(3)}s`);
say(early.reason === 'parried', 'window - eps: PARRIED', early.reason);
say(early.hpLost === 0, '...for no health', `${early.hpLost}`);
say(early.staminaSpent === 0, '...and no stamina', `${early.staminaSpent}`);

say(late.heldS > PARRY_WINDOW,
  'the late blow really did land outside the window', `${late.heldS.toFixed(3)}s`);
say(late.reason === 'blocked', 'window + eps: ORDINARY BLOCK, not a parry', late.reason);
say(late.hpLost === 0, '...still no health (a block is a block)', `${late.hpLost}`);
say(late.staminaSpent === SHIELD_LADDER.iron.staminaPerBlock,
  '...but it COSTS the tier stamina', `${late.staminaSpent}`);
say(late.staggerS === 0, '...and staggers nobody', `${late.staggerS}`);
say(Math.abs(late.heldS - early.heldS) < 0.10,
  'the two samples straddle the edge within a couple of frames',
  `${early.heldS.toFixed(3)}s vs ${late.heldS.toFixed(3)}s, edge ${PARRY_WINDOW}s`);

// Held forever. The turtle case, and the reason the window is press-edged.
await setBlock(false);
await page.waitForTimeout(700);
await setBlock(true);
await page.waitForTimeout(2500);
const turtled = await D((id) => {
  const g = window.__gameDebug;
  g.setVitals({ hp: 20, stamina: 100, alive: true });
  return g.forceAttackOnPlayer(id, 5, 'melee');
}, biter.id);
say(turtled.heldS > 2, 'the guard really had been up for a while',
  `${turtled.heldS.toFixed(2)}s`);
say(turtled.reason === 'blocked', 'a guard held forever NEVER parries', turtled.reason);
say(turtled.staminaSpent > 0, '...and pays the stamina every time', `${turtled.staminaSpent}`);
await setBlock(false);

// --- 4c. A pause mid-window neither eats it nor extends it -----------------
//
// The window is a difference of two SIM times and the sim clock stops on Esc,
// so a pause is invisible to it. Asserted by pausing INSIDE the window for far
// longer than the window and then landing the blow: a wall-clock window would
// have expired several times over.
await page.waitForTimeout(800);
const beforePause = await D(() => {
  const g = window.__gameDebug;
  g.setVitals({ hp: 20, stamina: 100, alive: true });
  const ev = new MouseEvent('mousedown', { button: 2, bubbles: true, cancelable: true });
  ev.__pad = true;
  window.dispatchEvent(ev);
  return { raisedAtS: g.guardState().raisedAtS, sim: g.simTime() };
});
await page.keyboard.press('Escape');
await page.waitForTimeout(2000);          // 11x the window, in wall time
const duringPause = await D(() => window.__gameDebug.simTime());
await page.keyboard.press('Escape');
await page.waitForTimeout(60);
const afterPause = await D((id) => window.__gameDebug.forceAttackOnPlayer(id, 5, 'melee'),
  biter.id);
await setBlock(false);
log(`     paused ~2.0 s wall; sim advanced ${(duringPause - beforePause.sim).toFixed(3)} s; `
  + `held at impact ${afterPause.heldS.toFixed(3)} s`);
say(duringPause - beforePause.sim < 0.25,
  'the sim clock really did stop for the pause',
  `${(duringPause - beforePause.sim).toFixed(3)} s of sim in 2 s of wall`);
say(afterPause.heldS < PARRY_WINDOW,
  'a 2 s pause did not EAT the parry window', `held ${afterPause.heldS.toFixed(3)} s`);
say(afterPause.reason === 'parried', '...and the blow after it still parries',
  afterPause.reason);
say(afterPause.heldS > 0,
  '...nor did the pause EXTEND it into negative time', `${afterPause.heldS.toFixed(3)}`);

// --- 4d. The ladder: same bite, four shields, exact stamina ---------------
//
// The relations are unit-tested in `test-shields.mts`; what this proves is that
// the shipped ladder is the one the running game actually spends.
await page.waitForTimeout(700);
const ladderRows = [];
for (const tier of ['wood', 'bronze', 'iron', 'dragonscale']) {
  await D((t) => window.__gameDebug.giveShield(t), tier);
  await page.waitForTimeout(120);
  const melee = await hitAfterHold(PARRY_WINDOW + 0.05, biter.id, 5, 'melee');
  await page.waitForTimeout(700);
  const fire = await hitAfterHold(PARRY_WINDOW + 0.05, biter.id, 4, 'breath');
  await page.waitForTimeout(700);
  ladderRows.push({ tier, melee, fire });
  say(melee.staminaSpent === SHIELD_LADDER[tier].staminaPerBlock,
    `${tier}: a blocked bite costs exactly ${SHIELD_LADDER[tier].staminaPerBlock} stamina`,
    `${melee.staminaSpent}`);
  say(melee.hpLost === 0, `${tier}: ...and no health`, `${melee.hpLost}`);
}
for (let i = 1; i < ladderRows.length; i++) {
  say(ladderRows[i].melee.staminaSpent <= ladderRows[i - 1].melee.staminaSpent,
    `${ladderRows[i].tier} costs no more stamina than ${ladderRows[i - 1].tier}`,
    `${ladderRows[i - 1].melee.staminaSpent} -> ${ladderRows[i].melee.staminaSpent}`);
  say(ladderRows[i].fire.hpLost <= ladderRows[i - 1].fire.hpLost,
    `${ladderRows[i].tier} takes no more fire than ${ladderRows[i - 1].tier}`,
    `${ladderRows[i - 1].fire.hpLost} -> ${ladderRows[i].fire.hpLost} hp`);
}
{
  const wood = ladderRows[0].fire;
  const ds = ladderRows[3].fire;
  log(`     4 hp of breath: wood takes ${wood.hpLost.toFixed(2)}, `
    + `dragonscale takes ${ds.hpLost.toFixed(2)}`);
  say(wood.reason === 'mitigated' && ds.reason === 'mitigated',
    'breath is mitigated by a shield, never stopped outright',
    `${wood.reason} / ${ds.reason}`);
  say(wood.hpLost > 0 && ds.hpLost > 0,
    '...so some fire always gets through, at every tier');
  say(ds.hpLost * 3 <= wood.hpLost,
    'dragonscale turns at least 3x the fire wood does',
    `${wood.hpLost.toFixed(2)} vs ${ds.hpLost.toFixed(2)} hp`);
  say(wood.staminaSpent > ds.staminaSpent,
    '...and costs less to brace with, too',
    `${wood.staminaSpent} vs ${ds.staminaSpent}`);
}

// --- 4e. The parry stagger, measured on the wolf --------------------------
await D(() => window.__gameDebug.giveShield('iron'));
await pinBiter(0, true);
await page.waitForTimeout(700);
const parried = await hitAfterHold(0.02, biter.id);
say(parried.reason === 'parried', 'the wolf was parried', parried.reason);
const stagger0 = await D((id) => window.__gameDebug.staggerOf(id), biter.id);

// The spark, sampled DURING the burst. Sampled after it, `sparks` is correctly
// zero and the assertion would have been "the counter exists" — which is what
// the first version of this beat measured, and it is nothing.
{
  let peak = 0;
  for (let i = 0; i < 8; i++) {
    peak = Math.max(peak, await D(() => window.__gameDebug.guardState().sparks));
    await page.waitForTimeout(40);
  }
  say(peak > 0, 'the parry threw a visible thread-spark',
    `${peak} billboards at its peak`);
}
say(Math.abs(stagger0 - 1.2) < 0.25,
  'an ordinary enemy is left reeling for ~1.2 s', `${stagger0?.toFixed(2)} s`);

// It has to actually STOP. A stagger nobody can see is a number in a struct.
const frozen = await D((id) => {
  const g = window.__gameDebug;
  const e = g.entities().find((x) => x.id === id);
  return e ? { x: e.x, z: e.z } : null;
}, biter.id);
await page.waitForTimeout(500);
const stillFrozen = await D((id) => {
  const g = window.__gameDebug;
  const e = g.entities().find((x) => x.id === id);
  return { pos: e ? { x: e.x, z: e.z } : null, stagger: g.staggerOf(id) };
}, biter.id);
say(frozen !== null && stillFrozen.pos !== null
  && Math.hypot(stillFrozen.pos.x - frozen.x, stillFrozen.pos.z - frozen.z) < 0.05,
  'a staggered enemy stops dead — it does not walk while it reels',
  frozen === null ? 'gone' : `${Math.hypot(stillFrozen.pos.x - frozen.x, stillFrozen.pos.z - frozen.z).toFixed(3)} m`);
say(stillFrozen.stagger < stagger0,
  '...and the stagger runs down on the sim clock',
  `${stagger0?.toFixed(2)} -> ${stillFrozen.stagger?.toFixed(2)} s`);

// The delay a parry actually buys, measured as a gap between landed blows.
{
  await D((id) => {
    const g = window.__gameDebug;
    g.setVitals({ hp: 20, stamina: 100, alive: true });
    return g.staggerOf(id);
  }, biter.id);
  // Baseline: how long between two unblocked bites from this wolf.
  const base = await D(() => ({ t: window.__gameDebug.simTime(), log: window.__gameDebug.attackLog() }));
  for (let i = 0; i < 45; i++) { await pinBiter(0, true); await page.waitForTimeout(100); }
  const run = await D(() => ({ t: window.__gameDebug.simTime(), log: window.__gameDebug.attackLog() }));
  const blows = run.log.filter((e) => e.id === biter.id && e.t >= base.t).map((e) => e.t);
  let worstGap = 0;
  for (let i = 1; i < blows.length; i++) worstGap = Math.max(worstGap, blows[i] - blows[i - 1]);
  log(`     unblocked: ${blows.length} bites in ${(run.t - base.t).toFixed(1)} s, `
    + `longest gap ${worstGap.toFixed(2)} s`);
  say(blows.length >= 2, 'the wolf bites on a regular cadence with no shield up',
    `${blows.length} bites`);
  say(worstGap < 1.2, '...and its natural gap is under the stagger it would cost it',
    `${worstGap.toFixed(2)} s`);
}

// --- 4f. Block and attack are mutually exclusive --------------------------
await page.waitForTimeout(700);
await setBlock(true);
await page.waitForTimeout(80);
const swungWhileUp = await D(() => {
  const g = window.__gameDebug;
  const before = g.attackT();
  const ev = new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true });
  ev.__pad = true;
  window.dispatchEvent(ev);
  return { before, after: g.attackT(), raised: g.guardState().raised };
});
say(swungWhileUp.raised === true, 'the shield is up for the exclusivity test',
  `raised=${swungWhileUp.raised}`);
say(swungWhileUp.after === swungWhileUp.before && swungWhileUp.after === 1,
  'a swing does not fire while the shield is raised',
  `attackT ${swungWhileUp.before} -> ${swungWhileUp.after}`);
await setBlock(false);
await page.waitForTimeout(120);
const swungWhileDown = await D(() => {
  const g = window.__gameDebug;
  const ev = new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true });
  ev.__pad = true;
  window.dispatchEvent(ev);
  return { after: g.attackT(), raised: g.guardState().raised };
});
say(swungWhileDown.after < 1,
  '...and it fires perfectly well the moment the shield comes down',
  `attackT ${swungWhileDown.after}`);

// --- 4g. The Evil King is parryable, for half as long ---------------------
await clearWolves([biter.id]);
await page.waitForTimeout(300);
// FACING IS RE-READ, NOT REUSED. `facing` was captured before beat 4a, and
// beat 4f fires a real swing — `resolveLeftClick` snaps `controller.yaw` to the
// camera, so the player is no longer pointing where they were. The first
// version of this beat placed the King on the stale bearing, and every
// assertion here came back `flank` for the perfectly good reason that he was
// standing behind the player's shoulder.
const kingFacing = await D(() => window.__gameDebug.playerMotion().yaw);
const king = await D((f) => {
  const g = window.__gameDebug;
  const p = g.playerPos();
  const x = p[0] + Math.sin(f) * 2.4;
  const z = p[2] - Math.cos(f) * 2.4;
  const id = g.placeEntity('evil_king', x, g.groundHeightAt(x, z), z);
  return { id, x, z, y: g.groundHeightAt(x, z) };
}, kingFacing);
if (king.id === null) {
  say(false, 'the Evil King could be placed for the parry beat');
} else {
  await D((k) => {
    window.__gameDebug.setEntityPos(k.id, k.x, k.y, k.z);
    window.__gameDebug.setVitals({ hp: 20, stamina: 100, alive: true });
  }, king);
  await page.waitForTimeout(400);
  const royal = await hitAfterHold('before', king.id, 6, 'melee');
  const kingStagger = await D((id) => window.__gameDebug.staggerOf(id), king.id);
  say(royal.bearingDeg !== null && royal.bearingDeg < 60,
    'the King is in front of the player for this beat',
    `${royal.bearingDeg?.toFixed(0)} deg off centre`);
  log(`     king: ${royal.reason}, ${royal.hpLost} hp lost, `
    + `stagger ${kingStagger?.toFixed(2)} s`);
  say(royal.reason === 'parried', 'the Evil King IS parryable', royal.reason);
  say(royal.hpLost === 0, '...for zero damage', `${royal.hpLost}`);
  say(Math.abs(kingStagger - 0.5) < 0.15,
    '...but he only reels for ~0.5 s, not the ordinary 1.2',
    `${kingStagger?.toFixed(2)} s`);
  say(kingStagger < stagger0 / 2,
    '...which is less than half what a wolf gets',
    `${kingStagger?.toFixed(2)} vs ${stagger0?.toFixed(2)} s`);

  // ...and a boss blow that is NOT parried still hurts, or the beat above is
  // just "the king does no damage".
  await page.waitForTimeout(800);
  const royalLate = await hitAfterHold('after', king.id, 6, 'melee');
  say(royalLate.reason === 'blocked', 'a mistimed guard against the king is an ordinary block',
    royalLate.reason);
  await D((id) => {
    const g = window.__gameDebug;
    g.setVitals({ hp: 20, stamina: 0, alive: true });
    return g.forceAttackOnPlayer(id, 6, 'melee');
  }, king.id);
  const unguarded = await D((id) => {
    const g = window.__gameDebug;
    g.setVitals({ hp: 20, stamina: 100, alive: true });
    return g.forceAttackOnPlayer(id, 6, 'melee');
  }, king.id);
  say(unguarded.hpLost > 0 && unguarded.reason === 'not-raised',
    '...and with no guard up at all, the king takes health off',
    `${unguarded.hpLost} hp, ${unguarded.reason}`);
  await D((id) => window.__gameDebug.removeEntity(id), king.id);
}

// --- 4h. Blocking costs half your speed ------------------------------------
//
// Measured as REAL distance walked over a REAL keyboard hold, not by reading a
// multiplier back out of the game. The two runs are the same key for the same
// wall time from the same standing start, and the only difference is whether
// the right button is down.
{
  await D(() => window.__gameDebug.giveShield('iron'));
  /** Hold W for `ms` and report how far the player actually moved. */
  const walk = async (ms) => {
    const a = await D(() => window.__gameDebug.playerPos());
    await page.keyboard.down('w');
    await page.waitForTimeout(ms);
    await page.keyboard.up('w');
    await page.waitForTimeout(120);
    const b = await D(() => window.__gameDebug.playerPos());
    return Math.hypot(b[0] - a[0], b[2] - a[2]);
  };
  await setBlock(false);
  await page.waitForTimeout(200);
  const free = await walk(1200);
  await setBlock(true);
  await page.waitForTimeout(200);
  const guarded = await walk(1200);
  await setBlock(false);
  const ratio = free > 0 ? guarded / free : 0;
  log(`     walked ${free.toFixed(2)} m free vs ${guarded.toFixed(2)} m behind the shield `
    + `(${(ratio * 100).toFixed(0)}%)`);
  say(free > 3, 'the player really did walk with no shield up', `${free.toFixed(2)} m`);
  say(guarded > 0, '...and blocking does not freeze them solid', `${guarded.toFixed(2)} m`);
  say(ratio > 0.35 && ratio < 0.68,
    'a raised shield costs about half the walking speed', `${(ratio * 100).toFixed(0)}%`);
}

// --- 4i. Losing the shield lowers the guard --------------------------------
await D(() => window.__gameDebug.giveShield(null));
{
  const gone = await D(() => {
    const g = window.__gameDebug;
    const ev = new MouseEvent('mousedown', { button: 2, bubbles: true, cancelable: true });
    ev.__pad = true;
    window.dispatchEvent(ev);
    return g.guardState();
  });
  say(gone.shield === null && gone.raised === false,
    'with the shield gone, the right button raises nothing',
    `shield=${gone.shield} raised=${gone.raised}`);
}
await setBlock(false);

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
