/**
 * Does the dismounted King actually take the player's hit points off?
 *
 *   node scripts/king-melee-check.mjs [outDir]
 *
 * ## Why this exists next to `castle-siege.mjs`
 *
 * The siege drives the whole fight to both bosses dead and proves a great deal,
 * but at its last beat it grinds the King down with `castleDamageBoss` and
 * never once asks whether HE can hurt the PLAYER. That is the exact shape of
 * the bug the user reported: every counter green, the phase machine reaching
 * 'dismounted', the King alive and moving, and the health bar completely still.
 *
 * So the only claims here are ones the siege cannot make, and each is a health
 * curve rather than a swing counter:
 *
 *   1. the fight reaches 'dismounted'  — the dragon dies, the King is unseated
 *   2. HE CLOSES AND HE HURTS YOU      — dropped 20 m off, he must walk in and
 *                                        take hit points off a standing player
 *   3. he cannot reach across the arena — held at 60 m, hp must not move
 *   4. he cannot reach through a floor  — player two storeys up in the keep,
 *                                        King directly below, hp must not move
 *
 * Beats 3 and 4 are not padding. The fix is "let the boss attack", and the way
 * that fix goes wrong is a boss who attacks through walls and across the map.
 *
 * ## Hazards this file is built against
 *
 * Three agents are live in this repo and any of them can hot-reload the page
 * mid-run, so `alive()` and the frame-counter check are lifted from
 * `castle-siege.mjs`: a run that reboots is reported as suspect, not summarised
 * as fact.
 *
 * The King is placed with `setEntityPos` at the PLAYER'S OWN y, never with the
 * generic `teleport(x, z)` hook. `teleport` resolves height off the raw
 * heightfield, and the castle keep has four storeys stacked over a motte — a
 * player "teleported to the arena" that way arrives on the hillside under the
 * building, and every number after that is about two creatures in different
 * rooms.
 *
 * The player has 20 max hp and the King hits for 5, so a window long enough to
 * see four blows is long enough to die in. Health is topped back up between
 * samples and the beat reports DAMAGE TAKEN accumulated across those top-ups,
 * not the raw bar — a bar reading 20 the whole time because the harness healed
 * it is precisely the sort of green check this repo has been burned by.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] || 'scripts/shots/king-melee';
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
await page.evaluate(() => { window.__kmToken = 1; });

let shot = 0;
const failures = [];
const log = [];
let reloads = 0, reboots = 0, lastFrames = 0;

function expect(name, cond, detail) {
  if (!cond) {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  !! FAILED: ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`  ok  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function alive(fn, arg) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ok = await page.evaluate(() => window.__gameReady === true
        && window.__kmToken === 1
        && typeof window.__gameDebug?.castleFight === 'function');
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
    await page.evaluate(() => { window.__kmToken = 1; }).catch(() => {});
  }
  throw new Error('page never came back after a reload');
}

/** Point the orbit camera AT the King. yaw 0 is BEHIND the player. */
async function lookAtKing(pitch = 0.16, dist = 9) {
  await alive(([p, d]) => {
    const g = window.__gameDebug;
    const k = g.castleKing();
    if (k === null) return;
    const [px, , pz] = g.playerPos();
    g.setCamera(Math.atan2(-(k.x - px), -(k.z - pz)), p, d);
  }, [pitch, dist]);
}

async function snap(note) {
  const name = `${String(shot).padStart(2, '0')}-${note.replace(/[^a-z0-9]+/gi, '-')}.png`;
  await page.screenshot({ path: path.join(outDir, name) });
  console.log(`  ${name}`);
  shot++;
  return name;
}

/**
 * Sample the player's health once a second while the King does whatever the AI
 * tells him to.
 *
 * `place` runs before each sample and returns the King's target position, or
 * null to leave him alone. Beat 2 places him once and then lets him walk;
 * beats 3 and 4 re-place him every sample so he cannot close the gap the beat
 * is about.
 */
async function watchHp(seconds, label, place) {
  const samples = [];
  let taken = 0;
  await alive(() => window.__gameDebug.setVitals({ hp: 20 }));
  for (let s = 0; s < seconds; s++) {
    const r = await alive(([n, put]) => {
      const g = window.__gameDebug;
      if (put !== null) g.setEntityPos(g.castleKing().id, put[0], put[1], put[2]);
      const k = g.castleKing();
      const v = g.vitals();
      const f = g.castleFight();
      const [px, py, pz] = g.playerPos();
      const out = {
        hp: v.hp, kingMode: f.kingMode, kingHp: f.kingHp, phase: f.phase,
        dxz: Math.hypot(k.x - px, k.z - pz), dy: k.y - py,
        kx: k.x, ky: k.y, kz: k.z, px, py, pz,
      };
      if (v.hp < 20) g.setVitals({ hp: 20 });
      return out;
    }, [s, place === undefined ? null : await place(s)]);
    taken += 20 - r.hp;
    samples.push({
      t: s, hp: r.hp, taken,
      dxz: Math.round(r.dxz * 10) / 10, dy: Math.round(r.dy * 10) / 10,
      mode: r.kingMode,
      kx: Math.round(r.kx * 10) / 10, kz: Math.round(r.kz * 10) / 10,
    });
    await page.waitForTimeout(1000);
  }
  console.log(`  ${label}`);
  console.log(`    hp each second:  ${samples.map((s) => s.hp).join(' ')}`);
  console.log(`    damage taken:    ${samples.map((s) => s.taken).join(' ')}  (cumulative)`);
  console.log(`    horiz. gap (m):  ${samples.map((s) => s.dxz).join(' ')}`);
  console.log(`    vert. gap (m):   ${samples.map((s) => s.dy).join(' ')}`);
  console.log(`    king x/z:        ${samples.map((s) => `${s.kx}/${s.kz}`).join(' ')}`);
  console.log(`    king mode:       ${[...new Set(samples.map((s) => s.mode))].join(' -> ')}`);
  log.push({ label, samples });
  return { taken, samples };
}

const verdict = {};

// ===========================================================================
console.log('\n=== 1. drive the fight to `dismounted` ===');
// ===========================================================================

// DELIBERATELY NOT `castleSetAlarm('hunting')`.
//
// The first two runs of this file did set it, and measured 190 hp of damage in
// beat 2 — plus 102 hp with the King held 60 m away and 96 hp through two
// storeys of masonry. None of it was his. Waking the castle sends a dozen
// goblins and skeletons after a player standing in their hall, and removing
// them does not help: `castleManager` re-places its garrison, so they were back
// inside a second and the "cleared room" control still bled 62 hp.
//
// The alarm is not needed. `tickCastleBoss` steps the fight machine whenever
// the dragon is dead regardless of the alarm, so killing the mount is enough to
// reach 'dismounted' — and with the castle still dormant the garrison is never
// ticked at all (`isGarrisonId(e.id) && !castleManager.hostile` skips them),
// which leaves exactly one thing in the building that can throw a punch.
// The `arena` marker, not a keep floor. This is the tower top the fight is
// actually staged on — `dragonPerch` is 6 m away at the same height — and it
// is open ground with a parapet round it. An earlier run of this file measured
// beat 2 inside `L1hall` and reported "the King does not close": he had been
// dropped 20 m along +X, which is the far side of an interior wall, and the
// honest answer was that he had walked up to the masonry between them and
// stopped. Right conclusion, wrong room.
await alive(() => window.__gameDebug.castleTeleport('arena'));
await page.waitForTimeout(1500);

// Kill the dragon outright. The siege already proves the phase ladder and the
// player's own swing; re-proving them here would only make this run slower and
// more fragile.
for (let i = 0; i < 40; i++) {
  const hp = await alive((n) => window.__gameDebug.castleDamageBoss('dragon', n), 40);
  await page.waitForTimeout(250);
  if (hp === null || hp <= 0) break;
}
await page.waitForTimeout(2500);

// Wildlife that wandered in is not garrison and does not come back, so it can
// simply go. The dragon's corpse stays: removing the entity makes
// `castleFight().dragonMode` null and the death beat above unprovable.
const cleared = await alive(() => {
  const g = window.__gameDebug;
  const keep = new Set([g.castleKing()?.id, g.castleDragon()?.id]);
  const [px, , pz] = g.playerPos();
  let removed = 0;
  for (const e of g.entities()) {
    if (keep.has(e.id)) continue;
    if (Math.hypot(e.x - px, e.z - pz) > 200) continue;
    g.removeEntity(e.id);
    removed++;
  }
  return removed;
});
console.log(`  cleared ${cleared} stray entities within 200 m`);

const f0 = await alive(() => window.__gameDebug.castleFight());
console.log(`  phase=${f0.phase} dragon=${f0.dragonMode} king=${f0.kingMode} `
  + `kingHp=${f0.kingHp} kingMounted=${f0.kingMounted}`);
verdict.phase = f0.phase;
expect('the dragon is dead', f0.dragonMode === 'dead', f0.dragonMode);
expect('the fight reached dismounted', f0.phase === 'dismounted', f0.phase);
expect('the King is off the saddle', f0.kingMounted === false, `${f0.kingMounted}`);
expect('the King is alive', f0.kingMode !== 'dead' && f0.kingHp > 0,
  `mode=${f0.kingMode} hp=${f0.kingHp}`);

// ===========================================================================
console.log('\n=== 1b. the room is empty: nothing else can be hurting anyone ===');
// ===========================================================================
//
// The control that makes every number below attributable. With the King held
// 200 m off, ANY damage at all is something this harness has not accounted for
// — a survivor, a fall, the weather, hunger — and the run should be thrown out
// rather than credited to the boss.

const baseline = await watchHp(6, 'King held 200 m away', async () => alive(() => {
  const g = window.__gameDebug;
  const [px, py, pz] = g.playerPos();
  return [px + 200, py, pz];
}));
verdict.baseline = baseline.taken;
expect('nothing but the King can hurt the player', baseline.taken === 0,
  `${baseline.taken} hp with the King 200 m away`);

// ===========================================================================
console.log('\n=== 2. he closes, and he hurts the player (THE claim) ===');
// ===========================================================================
//
// Dropped 20 m away, ONCE. Everything after that is his own AI: he has to
// notice the player, cross the floor and land blows. Placing him already in
// reach would prove the damage path and nothing about the fight.

// 6.5 m to the SOUTH, and every part of that was paid for.
//
// +X at 12 m put him on the far side of the DRAGON'S PERCH — a 5.2 m block of
// arena stone centred (-314, 49) that used to be walk-through and is collision
// as of the castle pass. He walked into it and stopped dead at exactly 12.0 m,
// in 'aggro', for sixteen seconds. That is the pathing being right and the
// harness being wrong: there is no way round a solid object for an AI whose
// entire movement is `moveToward`.
//
// +Z at 12 m then put him OFF THE ARENA. The tower top is a disc about 17 m
// across, so 12 m from its centre is past the parapet, and he fell the 10 m to
// the keep roof — which the `dy` column reported honestly as -10 while the
// beat was still claiming to measure two creatures on one floor.
//
// +Z at 6.5 m is on the disc and clear of the perch, and he STILL did not
// move: north is a blocked sector for a 1.125 m body (see beat 2b, which
// measures all four). South, east and west all work. So the beat approaches
// from the south, 6.5 m out — inside the disc, clear of the perch, and still
// 1.6 m outside his 4.9 m reach, so he has to come and get you.
const startAt = await alive(() => {
  const g = window.__gameDebug;
  const [px, py, pz] = g.playerPos();
  return [px, py, pz - 6.5];
});
let placedOnce = false;
const near = await watchHp(16, 'dropped 6.5 m off, on the arena', async () => {
  if (placedOnce) return null;
  placedOnce = true;
  return startAt;
});
expect('he stayed on the arena rather than falling off it',
  near.samples.every((s) => Math.abs(s.dy) < 1.5),
  `worst vertical gap ${Math.max(...near.samples.map((s) => Math.abs(s.dy)))} m`);
verdict.damageInReach = near.taken;
verdict.closedTo = near.samples.at(-1).dxz;
await lookAtKing();
await page.waitForTimeout(300);
await snap('the-king-on-foot');
expect('the King closes the distance',
  near.samples.at(-1).dxz < 8, `ended ${near.samples.at(-1).dxz} m away`);
expect('the dismounted King damages the player',
  near.taken > 0, `${near.taken} hp over 16 s`);
// 5 damage on a 1.9 s cadence: once he arrives, 16 s should be five-plus blows.
// Anything under two connected blows means he lands one and loses the player.
expect('he lands more than a lucky single blow',
  near.taken >= 10, `${near.taken} hp over 16 s`);

// ===========================================================================
console.log('\n=== 2b. which approaches across the arena does he have? ===');
// ===========================================================================
//
// Not a pass/fail on the AI — it is a map of the ARENA. The King's collision
// radius is `max(0.3, size * 0.45)` = 1.125 m against the player controller's
// 0.35 m, so there is stone on that tower top which the player walks through
// and he cannot. Whatever the count is, it is a number the fight's designer
// should see: every blocked sector is somewhere the player can stand and be
// unreachable, which is the same complaint as "he does no damage" wearing a
// different hat.

const compass = [['south', 0, -1], ['east', 1, 0], ['west', -1, 0], ['north', 0, 1]];
const passable = [];
for (const [name, ox, oz] of compass) {
  const before = await alive(([x, z]) => {
    const g = window.__gameDebug;
    g.setVitals({ hp: 20 });
    const [px, py, pz] = g.playerPos();
    const k = g.castleKing();
    g.setEntityPos(k.id, px + x * 6.5, py, pz + z * 6.5);
    const n = g.castleKing();
    return { x: n.x, z: n.z };
  }, [ox, oz]);
  await page.waitForTimeout(4000);
  const after = await alive(() => {
    const g = window.__gameDebug;
    const k = g.castleKing();
    const [px, , pz] = g.playerPos();
    return { x: k.x, z: k.z, d: Math.hypot(k.x - px, k.z - pz), hp: g.vitals().hp };
  });
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  const ok = moved > 0.5;
  if (ok) passable.push(name);
  console.log(`  from the ${name.padEnd(6)} moved ${moved.toFixed(2)} m, `
    + `gap -> ${after.d.toFixed(2)} m, player ${after.hp} hp   ${ok ? '' : '<- BLOCKED'}`);
}
verdict.arenaApproaches = passable;
expect('most of the arena is ground he can cross',
  passable.length >= 3, `${passable.length}/4 passable: ${passable.join(', ')}`);

// ===========================================================================
console.log('\n=== 3. he cannot reach across the arena ===');
// ===========================================================================

const far = await watchHp(8, 'held at 60 m', async () => alive(() => {
  const g = window.__gameDebug;
  const [px, py, pz] = g.playerPos();
  return [px + 60, py, pz];
}));
verdict.damageAtRange = far.taken;
expect('the King does no damage from 60 m', far.taken === 0, `${far.taken} hp`);

// ===========================================================================
console.log('\n=== 4. he cannot reach up through the tower ===');
// ===========================================================================
//
// The parapet question in the form that cannot be argued with. The player
// stays on the arena (71.1 m) and the King is held on the keep roof 10 m
// below, horizontal gap ~0 — well inside the 4.9 m reach `engage` measures,
// because `engage` measures it in the XZ plane and nothing else. A man with a
// 3.1 m sword who can kill you through ten metres of tower is not a fight.
//
// NOTE FOR THE READER OF A FAILING RUN: the gate that answers this lives in
// `animal-ai.ts` and needs one field, `playerY`, in the context object
// `main.ts` builds at its `stepAnimal` call. Until that line is added the gate
// is inert by design — absent `playerY` means "no vertical test", which is
// exactly what every caller did before the field existed — and this beat will
// fail. It is not measuring nothing; it is measuring the wiring.

const roof = await alive(() => window.__gameDebug.castleMarkerPos('keepRoof'));
const below = await watchHp(8, 'player on the arena, King 10 m below on the keep roof',
  async () => alive((r) => {
    const [px, , pz] = window.__gameDebug.playerPos();
    return [px, r[1], pz];
  }, roof));
verdict.damageThroughFloor = below.taken;
verdict.floorGapY = below.samples.at(-1).dy;
await lookAtKing(-0.5, 14);
await page.waitForTimeout(300);
await snap('ten-metres-below');
expect('the King cannot hit a player 10 m above him',
  below.taken === 0,
  `${below.taken} hp across ${Math.abs(below.samples.at(-1).dy)} m — `
  + 'needs the `playerY` line in main.ts');

// ---------------------------------------------------------------------------

verdict.beatFailures = failures;
verdict.reloads = reloads;
verdict.reboots = reboots;
verdict.errors = errors;
fs.writeFileSync(path.join(outDir, 'session.json'),
  JSON.stringify({ verdict, log }, null, 1), 'utf-8');

console.log('\n--- summary ---');
console.log(`phase reached:       ${verdict.phase}`);
console.log(`baseline (6 s):      ${verdict.baseline} hp taken with the King 200 m off`);
console.log(`in reach (16 s):     ${verdict.damageInReach} hp taken, closed to ${verdict.closedTo} m`);
console.log(`held at 60 m (8 s):  ${verdict.damageAtRange} hp taken`);
console.log(`through the floor:   ${verdict.damageThroughFloor} hp taken `
  + `across ${verdict.floorGapY} m of vertical gap`);
console.log(failures.length ? `\n${failures.length} BEAT FAILURE(S):\n  ` + failures.join('\n  ')
  : '\nall beats passed');
console.log(errors.length ? `${errors.length} page error(s):\n  ` + errors.slice(0, 6).join('\n  ')
  : 'no page errors');

// A reloaded run is not a weak run, it is NOT A RUN.
//
// Three agents share this repo and a Vite hot-swap re-boots the world under
// the harness: entities are re-seeded, the King goes back on his dragon and
// the player goes back to spawn. One run of this file reported "moved 87 m,
// ends 89 m away, 0 damage" across every beat and every number was the world
// starting again — while another agent's half-saved `inventory.ts` threw
// `does not provide an export named 'refillTintreach'` three times. Printed as
// a summary that reads exactly like a broken boss.
if (reboots > 0 || reloads > 0) {
  console.log(`\n*** RUN INVALID: ${reloads} reload(s), ${reboots} reboot(s). `
    + 'The world restarted mid-measurement — re-run, do not read the numbers '
    + 'above. ***');
  verdict.invalid = true;
  fs.writeFileSync(path.join(outDir, 'session.json'),
    JSON.stringify({ verdict, log }, null, 1), 'utf-8');
  await browser.close();
  process.exit(2);
}

await browser.close();
if (failures.length > 0) process.exit(1);
