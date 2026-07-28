/**
 * Tests for the melee attack-token pool and the circling geometry.
 * Run:  npx tsx scripts/test-attack-tokens.mts
 *
 * WHAT THIS SUITE IS FOR
 *
 * The pool decides two things that are easy to get subtly wrong and impossible
 * to eyeball: how many enemies may swing at once, and whether everyone
 * eventually gets a turn. A pool that grants correctly but starves the back of
 * the pack looks fine for the first two seconds and then reads as broken AI,
 * so most of what is below is about ROTATION rather than about the cap.
 *
 * Section 8 drives the real `stepAnimal` rather than the pool alone, because
 * every interesting failure so far has been in the seam: a pool that behaves
 * perfectly while the AI never calls it is the failure mode this suite exists
 * to make impossible.
 */

import {
  MeleeTokenPool, circleGoal, circleDir, circleRing, idHash, isExempt,
  CROWD_AT, CROWD_TOKENS, SOLO_TOKENS, LANDING_FLOOR_S, FOLLOW_THROUGH_S,
  INTENT_TTL_S, TOKEN_MAX_HOLD_S, CONTEND_PAD, RING_PAD_MIN, RING_PAD_MAX,
} from '../src/game/combat/attack-tokens';
import { stepAnimal, attackReach, attackCadence, onEntityDamaged } from '../src/game/entities/animal-ai';
import { SPECIES_DEFS } from '../src/game/entities/entity-types';
import type { EntityState } from '../src/game/entities/entity-manager';
import { mulberry32 } from '../src/game/mesh-utils';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const DT = 1 / 60;

/** Stable ids — `makeEntity` in test-animal-ai randomises them, which would
 *  make every tie-break assertion below non-reproducible. */
const id = (n: number): string => `tok:e${n}`;

function makeWolf(n: number, x: number, z: number): EntityState {
  return {
    id: id(n), species: 'wolf', x, y: 5, z, yaw: 0, hp: 30,
    mode: 'aggro', walkPhase: 0, colorVariant: 0, homeX: x, homeZ: z,
    stateTimer: 0, fleeTimer: 0,
  };
}

// ---------------------------------------------------------------------------
// 1. Capacity: one token for a duel, two for a crowd
// ---------------------------------------------------------------------------

{
  const pool = new MeleeTokenPool();
  // A single contender.
  pool.advance(DT);
  pool.requestSwing(id(0), 'wolf');
  pool.advance(DT);
  check('one contender gets one token', pool.tokenCapacity === SOLO_TOKENS,
    `capacity=${pool.tokenCapacity}`);

  // Two contenders is still a duel plus a flanker.
  const two = new MeleeTokenPool();
  for (let t = 0; t < 3; t++) {
    two.advance(DT);
    two.requestSwing(id(0), 'wolf');
    two.requestSwing(id(1), 'wolf');
  }
  check('two contenders still share one token', two.tokenCapacity === SOLO_TOKENS,
    `capacity=${two.tokenCapacity}`);
  check('...and only one of them holds it', two.heldCount <= SOLO_TOKENS,
    `held=${two.heldCount}`);

  // Three opens the second.
  const crowd = new MeleeTokenPool();
  for (let t = 0; t < 3; t++) {
    crowd.advance(DT);
    for (let i = 0; i < CROWD_AT; i++) crowd.requestSwing(id(i), 'wolf');
  }
  check('a crowd opens the second token', crowd.tokenCapacity === CROWD_TOKENS,
    `capacity=${crowd.tokenCapacity}`);
}

// ---------------------------------------------------------------------------
// 2. The cap actually holds under a mob
// ---------------------------------------------------------------------------

{
  const pool = new MeleeTokenPool();
  const N = 8;
  let worst = 0;
  for (let t = 0; t < 600; t++) {
    pool.advance(DT);
    let granted = 0;
    for (let i = 0; i < N; i++) {
      if (pool.requestSwing(id(i), 'wolf')) granted++;
    }
    if (granted > worst) worst = granted;
  }
  check('eight contenders never exceed the crowd cap', worst <= CROWD_TOKENS,
    `worst simultaneous grants = ${worst}`);
  check('...and the cap is actually being reached (not a mute button)',
    worst === CROWD_TOKENS, `worst=${worst}`);
}

// ---------------------------------------------------------------------------
// 3. Rotation: nobody starves
//
// The assertion that matters most. A pool that always grants to the same two
// enemies passes section 2 perfectly and produces six statues on screen.
// ---------------------------------------------------------------------------

{
  const pool = new MeleeTokenPool();
  const N = 6;
  const turns = new Array<number>(N).fill(0);
  // 20 s at 60 Hz. Each holder reports its swing after a wolf cadence (1.2 s).
  const heldFor = new Array<number>(N).fill(0);
  for (let t = 0; t < 1200; t++) {
    pool.advance(DT);
    for (let i = 0; i < N; i++) {
      const got = pool.requestSwing(id(i), 'wolf');
      if (!got) { heldFor[i] = 0; continue; }
      heldFor[i]! += DT;
      if (heldFor[i]! >= 1.2) {
        heldFor[i] = 0;
        turns[i]!++;
        pool.noteSwing(id(i));
      }
    }
  }
  const min = Math.min(...turns);
  const max = Math.max(...turns);
  check('every contender gets a turn over 20 s', min > 0,
    `turns=[${turns.join(',')}]`);
  check('turns are shared, not hoarded (max <= 2x min)', max <= min * 2,
    `min=${min} max=${max} turns=[${turns.join(',')}]`);
}

// ---------------------------------------------------------------------------
// 4. Exempt species: a boss does not queue
// ---------------------------------------------------------------------------

{
  check('the Evil King is exempt', isExempt('evil_king'));
  check('the black dragon is exempt', isExempt('black_dragon'));
  check('a skeleton is not exempt', !isExempt('skeleton'));
  check('a wolf is not exempt', !isExempt('wolf'));

  const pool = new MeleeTokenPool();
  // Saturate with wolves first, so every token is taken.
  for (let t = 0; t < 5; t++) {
    pool.advance(DT);
    for (let i = 0; i < 6; i++) pool.requestSwing(id(i), 'wolf');
  }
  check('the pit is saturated', pool.heldCount === CROWD_TOKENS,
    `held=${pool.heldCount}`);
  check('a boss swings anyway', pool.requestSwing('boss', 'evil_king'));
  check('...without consuming a token', pool.heldCount === CROWD_TOKENS,
    `held=${pool.heldCount}`);
  check('...and without joining the contender count',
    !pool.holds('boss'));
  // And the landing floor does not hold him either.
  pool.mayLand('wolf');
  check('a boss ignores the landing floor', pool.mayLand('evil_king'));
}

// ---------------------------------------------------------------------------
// 5. The landing floor (the dungeon's old grace window, relocated)
// ---------------------------------------------------------------------------

{
  const pool = new MeleeTokenPool();
  check('the first blow lands', pool.mayLand('skeleton'));
  check('an immediate second blow does not', !pool.mayLand('skeleton'));
  // Advance to just under the floor.
  let t = 0;
  while (t < LANDING_FLOOR_S - 0.05) { pool.advance(DT); t += DT; }
  check('...still not, just under the floor', !pool.mayLand('skeleton'));
  while (t < LANDING_FLOOR_S + 0.05) { pool.advance(DT); t += DT; }
  check('...and lands again once the floor has passed', pool.mayLand('skeleton'));
  check('refusals are counted for the dungeon test', pool.deniedByRate >= 2,
    `deniedByRate=${pool.deniedByRate}`);
}

// ---------------------------------------------------------------------------
// 6. Housekeeping: intent expiry, follow-through, reset
// ---------------------------------------------------------------------------

{
  const pool = new MeleeTokenPool();
  pool.advance(DT);
  pool.requestSwing(id(0), 'wolf');
  pool.advance(DT);
  pool.requestSwing(id(0), 'wolf');
  check('a contender that asked holds a token', pool.holds(id(0)));

  // Stop asking — died, de-aggroed, streamed away.
  let t = 0;
  while (t < INTENT_TTL_S + 0.1) { pool.advance(DT); t += DT; }
  check('a contender that stops asking is dropped', pool.contenderCount === 0,
    `contenders=${pool.contenderCount}`);
  check('...and its token is returned', pool.heldCount === 0,
    `held=${pool.heldCount}`);
}

{
  // The follow-through: a reported swing frees the token a beat later, not
  // instantly, and not never.
  const pool = new MeleeTokenPool();
  pool.advance(DT);
  pool.requestSwing(id(0), 'wolf');
  pool.noteSwing(id(0));
  check('the token survives the instant of the blow', pool.holds(id(0)));
  let t = 0;
  while (t < FOLLOW_THROUGH_S - 0.05) {
    pool.advance(DT); pool.requestSwing(id(0), 'wolf'); t += DT;
  }
  check('...through the follow-through', pool.holds(id(0)), `t=${t.toFixed(2)}`);
  while (t < FOLLOW_THROUGH_S + 0.05) {
    pool.advance(DT); t += DT;
  }
  check('...and is released after it', !pool.holds(id(0)), `t=${t.toFixed(2)}`);
}

{
  // A holder that never reports a swing must not leak its token forever.
  const pool = new MeleeTokenPool();
  pool.advance(DT);
  pool.requestSwing(id(0), 'wolf');
  let t = 0;
  while (t < TOKEN_MAX_HOLD_S + 0.1) {
    pool.advance(DT); pool.requestSwing(id(0), 'wolf'); t += DT;
  }
  check('a silent holder loses its token to the safety net',
    pool.heldCount <= SOLO_TOKENS, `held=${pool.heldCount}`);
}

{
  const pool = new MeleeTokenPool();
  pool.advance(DT);
  pool.requestSwing(id(0), 'wolf');
  pool.mayLand('wolf');
  pool.reset();
  check('reset clears contenders', pool.contenderCount === 0);
  check('reset clears holders', pool.heldCount === 0);
  check('reset clears counters', pool.deniedByRate === 0 && pool.deniedByToken === 0);
  check('reset re-arms the landing floor', pool.mayLand('wolf'));
}

// ---------------------------------------------------------------------------
// 7. Determinism, and no wall clock
// ---------------------------------------------------------------------------

{
  const run = (): string[] => {
    const pool = new MeleeTokenPool();
    const out: string[] = [];
    for (let t = 0; t < 300; t++) {
      pool.advance(DT);
      for (let i = 0; i < 5; i++) {
        if (pool.requestSwing(id(i), 'wolf')) out.push(`${t}:${i}`);
      }
    }
    return out;
  };
  const a = run();
  const b = run();
  check('the same inputs produce the same grants', a.join('|') === b.join('|'),
    `${a.length} vs ${b.length} grants`);

  // Pause safety is structural: nothing moves unless `advance` is called.
  const pool = new MeleeTokenPool();
  pool.advance(DT);
  pool.requestSwing(id(0), 'wolf');
  pool.noteSwing(id(0));
  const heldBefore = pool.holds(id(0));
  // Simulate a long pause: no `advance` calls at all.
  for (let i = 0; i < 1000; i++) pool.holds(id(0));
  check('a pause (no advance) freezes every token timer',
    pool.holds(id(0)) === heldBefore && pool.holds(id(0)));
}

// ---------------------------------------------------------------------------
// 8. Circling geometry
// ---------------------------------------------------------------------------

{
  const reach = attackReach(SPECIES_DEFS['wolf']);
  // The ring sits in the band, past reach but inside the contend radius, or
  // enemies would orbit outside the distance at which they contend at all and
  // oscillate in and out of the fight.
  let minR = Infinity, maxR = -Infinity;
  for (let i = 0; i < 200; i++) {
    const r = circleRing(`ring:${i}`, reach);
    minR = Math.min(minR, r); maxR = Math.max(maxR, r);
  }
  check('every ring is past reach', minR >= reach + RING_PAD_MIN - 1e-9,
    `min=${minR.toFixed(2)} reach=${reach}`);
  check('every ring is inside the contend radius', maxR <= reach + CONTEND_PAD,
    `max=${maxR.toFixed(2)} limit=${reach + CONTEND_PAD}`);
  check('rings are spread, not identical', maxR - minR > (RING_PAD_MAX - RING_PAD_MIN) * 0.7,
    `spread=${(maxR - minR).toFixed(2)}`);

  // The pack must split both ways, or it forms a conga line.
  let cw = 0, ccw = 0;
  for (let i = 0; i < 400; i++) {
    if (circleDir(`dir:${i}`) === 1) cw++; else ccw++;
  }
  check('circling direction splits both ways', cw > 120 && ccw > 120,
    `cw=${cw} ccw=${ccw}`);

  // An orbit is monotonic in angle: the whole point of the assertion is to
  // tell orbiting from oscillating.
  {
    const wolfSpeed = SPECIES_DEFS['wolf'].speed;
    let ex = 4, ez = 0;
    const dir = circleDir('orbit:1');
    let prev = Math.atan2(ex, ez);
    let unwrapped = 0;
    let reversals = 0;
    for (let t = 0; t < 180; t++) {
      const g = circleGoal('orbit:1', ex, ez, 0, 0, reach, wolfSpeed, DT);
      // Move toward the goal exactly as `moveToward` would.
      const dx = g.x - ex, dz = g.z - ez;
      const d = Math.hypot(dx, dz);
      const step = Math.min(d, wolfSpeed * 0.75 * DT);
      if (d > 1e-6) { ex += (dx / d) * step; ez += (dz / d) * step; }
      const a = Math.atan2(ex, ez);
      let da = a - prev;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      if (t > 10 && da * dir < -1e-6) reversals++;
      unwrapped += da;
      prev = a;
    }
    check('a circling enemy orbits rather than oscillating', reversals === 0,
      `${reversals} reversals`);
    check('...in its own deterministic direction', unwrapped * dir > 0.5,
      `swept ${(unwrapped * dir).toFixed(2)} rad`);
    const finalR = Math.hypot(ex, ez);
    check('...holding its standoff ring', Math.abs(finalR - circleRing('orbit:1', reach)) < 0.35,
      `r=${finalR.toFixed(2)} want=${circleRing('orbit:1', reach).toFixed(2)}`);
  }

  // Degenerate input must not produce NaN.
  {
    const g = circleGoal('deg', 5, 5, 5, 5, reach, 4, DT);
    check('standing on the player produces a finite goal',
      Number.isFinite(g.x) && Number.isFinite(g.z), `${g.x},${g.z}`);
  }

  check('id hashing is stable', idHash('tok:e0') === idHash('tok:e0'));
  check('id hashing separates ids', idHash('tok:e0') !== idHash('tok:e1'));
}

// ---------------------------------------------------------------------------
// 9. Through the real AI: six wolves on a standing player
//
// The seam test. Everything above can pass while `stepAnimal` never consults
// the pool at all, which is precisely the bug this is here to catch.
// ---------------------------------------------------------------------------

{
  const pool = new MeleeTokenPool();
  const wolves: EntityState[] = [];
  for (let i = 0; i < 6; i++) {
    // Ring them around the player at contact range, as a pack arrives.
    const a = (i / 6) * Math.PI * 2;
    wolves.push(makeWolf(i, Math.sin(a) * 2.0, Math.cos(a) * 2.0));
  }

  let hits = 0;
  const attackedBy = new Set<string>();
  // Per-second buckets of how many distinct wolves landed a blow.
  let maxConcurrentSwings = 0;

  const ctxFor = (e: EntityState) => ({
    playerX: 0, playerZ: 0,
    playerDist: Math.hypot(e.x, e.z),
    playerY: 5,
    rng: mulberry32(99),
    heightAt: () => 5,
    speciesDef: SPECIES_DEFS['wolf'],
    onAttackPlayer: () => { hits++; attackedBy.add(e.id); },
    tokens: pool,
  });

  for (let t = 0; t < 1800; t++) { // 30 s
    pool.advance(DT);
    let swinging = 0;
    for (const w of wolves) {
      const before = hits;
      stepAnimal(w, DT, ctxFor(w));
      if (hits > before) swinging++;
    }
    if (swinging > maxConcurrentSwings) maxConcurrentSwings = swinging;
  }

  check('six wolves land blows on the player', hits > 0, `${hits} hits`);
  check('never more than one blow lands in a single tick',
    maxConcurrentSwings <= 1, `max ${maxConcurrentSwings} in one tick`);
  check('every wolf eventually gets a turn (no starvation)',
    attackedBy.size === 6, `${attackedBy.size}/6 wolves attacked`);
  // 30 s against a 0.8 s landing floor is at most 38 blows.
  const ceiling = Math.ceil(30 / LANDING_FLOOR_S) + 1;
  check('the pack cannot beat the landing floor', hits <= ceiling,
    `${hits} hits, ceiling ${ceiling}`);
  // And the denial paths were genuinely exercised — otherwise the ceiling
  // above is satisfied by wolves that simply never tried.
  check('...and they really were trying to land more',
    pool.deniedByToken > 0, `${pool.deniedByToken} swings refused a token`);

  // Token-denied wolves must have MOVED (circled), not stood in a scrum.
  const spread = wolves.map((w) => Math.hypot(w.x, w.z));
  check('circling wolves hold a standoff ring, not the player\'s face',
    Math.min(...spread) > 1.0,
    `closest ${Math.min(...spread).toFixed(2)} m`);
}

// ---------------------------------------------------------------------------
// 10. A lone enemy is completely unaffected
//
// The regression that would be easiest to ship without noticing: every duel in
// the game getting a hitch, or an extra cadence, because of a crowd feature.
// ---------------------------------------------------------------------------

{
  const withPool = (pool: MeleeTokenPool | null): number => {
    let attacks = 0;
    const e = makeWolf(0, 0.5, 0);
    e.mode = 'aggro';
    e.stateTimer = 0;
    for (let t = 0; t < 72; t++) { // exactly 1.2 s
      pool?.advance(DT);
      stepAnimal(e, DT, {
        playerX: 0, playerZ: 0, playerDist: 0.5, playerY: 5,
        rng: mulberry32(7), heightAt: () => 5,
        speciesDef: SPECIES_DEFS['wolf'],
        onAttackPlayer: () => { attacks++; },
        tokens: pool,
      });
    }
    return attacks;
  };
  const bare = withPool(null);
  const pooled = withPool(new MeleeTokenPool());
  check('a lone wolf attacks identically with and without a pool',
    bare === pooled, `bare=${bare} pooled=${pooled}`);
  check('...and that is one blow in 1.2 s', pooled === 1, `${pooled}`);
}

// ---------------------------------------------------------------------------
// 11. The first blow TELLS
//
// Regression for a playtest report: "I attack the boss and I hurt myself."
// Both aggro entries used to zero the swing clock, so an enemy provoked
// INSIDE its own reach — which is how every melee fight starts, because
// landing a sword means standing 3.2 m from something whose reach can be
// 4.1 m — retaliated on the very tick it was provoked. No windup ever
// reached the screen; the player's own attack and the counter-damage were
// simultaneous, and the counter was unparryable in practice. Entry now
// parks the clock a full cadence out, like every other branch in `engage`.
// ---------------------------------------------------------------------------

{
  const firstBlow = (
    species: 'wolf' | 'dread_king',
    provoke: (e: EntityState) => void,
  ): { aggro: boolean; hitAtS: number | null } => {
    let hitAtS: number | null = null;
    const e: EntityState = {
      id: `tell:${species}`, species, x: 0.5, y: 5, z: 0, yaw: 0, hp: 999,
      mode: 'idle', walkPhase: 0, colorVariant: 0, homeX: 0.5, homeZ: 0,
      stateTimer: 0, fleeTimer: 0,
    };
    provoke(e);
    for (let t = 0; t < 60 * 6 && hitAtS === null; t++) { // 6 s of fighting
      stepAnimal(e, DT, {
        playerX: 0, playerZ: 0, playerDist: 0.5, playerY: 5,
        rng: mulberry32(11), heightAt: () => 5,
        speciesDef: SPECIES_DEFS[species],
        onAttackPlayer: () => { if (hitAtS === null) hitAtS = (t + 1) * DT; },
        tokens: null,
      });
    }
    return { aggro: e.mode === 'aggro', hitAtS };
  };

  // (a) Provoked by damage — the reported case, on the boss's own species.
  const king = firstBlow('dread_king', (e) => onEntityDamaged(e));
  const kingCad = attackCadence(SPECIES_DEFS.dread_king);
  check('a struck Dread King turns hostile', king.aggro);
  check('...but his counter is NOT on the tick he was struck',
    king.hitAtS !== null && king.hitAtS > kingCad * 0.9,
    `first blow at ${king.hitAtS?.toFixed(2)} s against a ${kingCad} s cadence`);
  check('...and the counter does still arrive',
    king.hitAtS !== null && king.hitAtS < kingCad + 1.0,
    `first blow at ${king.hitAtS} s`);

  // (b) Provoked by proximity: walking up to it earns the same windup.
  const wolf = firstBlow('wolf', () => {});
  const wolfCad = attackCadence(SPECIES_DEFS.wolf);
  check('a walked-up-to wolf aggros', wolf.aggro);
  check('...and its first bite also waits out a full cadence',
    wolf.hitAtS !== null && wolf.hitAtS > wolfCad * 0.9,
    `first bite at ${wolf.hitAtS?.toFixed(2)} s against a ${wolfCad} s cadence`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
