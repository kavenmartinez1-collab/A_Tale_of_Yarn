/**
 * Tests for src/game/entities/animal-ai.ts
 * Run: npx tsx scripts/test-animal-ai.mts
 *
 * Covers: LOD gates, state transitions, flee on damage,
 * aggro approach, graze holds, attack cadence, terrain clamp,
 * water clamping, determinism with seeded rng.
 */

import { stepAnimal, onEntityDamaged, aggroDamage, FOLLOW_RADIUS } from '../src/game/entities/animal-ai';
import { SPECIES_DEFS } from '../src/game/entities/entity-types';
import type { EntityState } from '../src/game/entities/entity-manager';
import type { AnimalAICtx } from '../src/game/entities/animal-ai';
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntity(
  species: keyof typeof SPECIES_DEFS,
  x = 0,
  z = 0,
): EntityState {
  return {
    id: `test:${species}:${Math.random().toString(36).slice(2)}`,
    species,
    x, y: 5, z,
    yaw: 0,
    hp: SPECIES_DEFS[species].hp,
    mode: 'idle',
    walkPhase: 0,
    colorVariant: 0,
    homeX: x,
    homeZ: z,
    stateTimer: 0,
    fleeTimer: 0,
  };
}

function makeCtx(overrides: Partial<AnimalAICtx> = {}): AnimalAICtx {
  return {
    playerX: 0,
    playerZ: 0,
    playerDist: 50,
    rng: mulberry32(12345),
    heightAt: (_x, _z) => 5,
    speciesDef: SPECIES_DEFS['deer'],
    onAttackPlayer: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. LOD gate: skip when playerDist > 200 m
// ---------------------------------------------------------------------------

{
  const e = makeEntity('deer', 0, 0);
  e.mode = 'idle';
  e.stateTimer = 10; // long timer — won't expire in a tick

  const before = { ...e };
  stepAnimal(e, 1 / 60, makeCtx({ playerDist: 201 }));

  check('LOD skip: no update at playerDist 201 m (stateTimer unchanged)',
    e.stateTimer === before.stateTimer, `timer=${e.stateTimer}`);
  check('LOD skip: mode unchanged', e.mode === 'idle');
  check('LOD skip: position unchanged', e.x === before.x && e.z === before.z);
}

// ---------------------------------------------------------------------------
// 2. LOD slow wander: playerDist 80–200 m drifts toward home
// ---------------------------------------------------------------------------

{
  // Entity far from home.
  const e = makeEntity('deer', 100, 0);
  e.homeX = 0;
  e.homeZ = 0;

  const ctx = makeCtx({ playerDist: 100 }); // in slow-wander range
  stepAnimal(e, 0.5, ctx);

  // Should have moved toward (0,0) — x should decrease.
  check('LOD slow wander: entity moves toward home',
    e.x < 100, `x=${e.x}`);
}

// ---------------------------------------------------------------------------
// 3. Idle → wander transition
// ---------------------------------------------------------------------------

{
  const e = makeEntity('deer', 0, 0);
  e.mode = 'idle';
  e.stateTimer = 0; // already expired

  // Force rng toward wander branch (rng() >= 0.4).
  const rng = () => 0.5;
  stepAnimal(e, 1 / 60, makeCtx({ playerDist: 50, rng }));

  check('idle → wander when stateTimer expires', e.mode === 'wander');
}

// ---------------------------------------------------------------------------
// 4. Idle → graze transition
// ---------------------------------------------------------------------------

{
  const e = makeEntity('deer', 0, 0);
  e.mode = 'idle';
  e.stateTimer = 0;

  // Force rng toward graze branch (rng() < 0.4).
  const rng = () => 0.1;
  stepAnimal(e, 1 / 60, makeCtx({ playerDist: 50, rng }));

  check('idle → graze when stateTimer expires + rng < 0.4', e.mode === 'graze');
}

// ---------------------------------------------------------------------------
// 5. Non-aggro species flee when player < 12 m
// ---------------------------------------------------------------------------

{
  const e = makeEntity('rabbit', 0, 0);
  e.mode = 'idle';

  stepAnimal(e, 1 / 60, makeCtx({
    playerX: 0, playerZ: 0,
    playerDist: 5, // < 12 m
    speciesDef: SPECIES_DEFS['rabbit'],
  }));

  check('rabbit flees when player within 12 m', e.mode === 'flee',
    `mode=${e.mode}`);
  check('flee timer set', e.fleeTimer > 0, `fleeTimer=${e.fleeTimer}`);
}

// ---------------------------------------------------------------------------
// 6. Non-aggro species flee on damage
// ---------------------------------------------------------------------------

{
  const e = makeEntity('deer', 0, 0);
  e.mode = 'idle';

  onEntityDamaged(e);

  check('non-aggro deer enters flee on damage', e.mode === 'flee');
  check('flee timer > 0', e.fleeTimer > 0);
}

// ---------------------------------------------------------------------------
// 7. Flee duration: returns to idle after ~4 s
// ---------------------------------------------------------------------------

{
  const e = makeEntity('deer', 0, 0);
  e.mode = 'flee';
  e.fleeTimer = 4;

  // Step 4+ seconds worth of ticks at 1/60 s each → need ~242 ticks.
  // playerDist must be < LOD_SLOW_DIST (80) so the full state machine runs.
  for (let i = 0; i < 300; i++) {
    stepAnimal(e, 1 / 60, makeCtx({
      playerX: 0, playerZ: 0,
      playerDist: 50,
      speciesDef: SPECIES_DEFS['deer'],
    }));
    if (e.mode === 'idle') break;
  }

  check('flee returns to idle after timer expires', e.mode === 'idle',
    `mode=${e.mode}`);
}

// ---------------------------------------------------------------------------
// 8. Aggro species enters aggro mode when player < 16 m
// ---------------------------------------------------------------------------

{
  const e = makeEntity('dragon', 0, 0);
  e.mode = 'idle';

  stepAnimal(e, 1 / 60, makeCtx({
    playerX: 10, playerZ: 0,
    playerDist: 10, // < 16 m
    speciesDef: SPECIES_DEFS['dragon'],
  }));

  check('dragon enters aggro when player within 16 m', e.mode === 'aggro',
    `mode=${e.mode}`);
}

// ---------------------------------------------------------------------------
// 9. Aggro: attack fires when player within 2.5 m
// ---------------------------------------------------------------------------

{
  let attackCount = 0;
  const e = makeEntity('dragon', 0, 0);
  e.mode = 'aggro';
  e.stateTimer = 0; // ready to attack

  // Step with player at 1 m.
  stepAnimal(e, 1 / 60, makeCtx({
    playerX: 1, playerZ: 0,
    playerDist: 1, // within attack range
    speciesDef: SPECIES_DEFS['dragon'],
    onAttackPlayer: (dmg) => { attackCount++; check(`attack dmg > 0`, dmg > 0); },
  }));

  check('aggro dragon attacks within 2.5 m', attackCount > 0, `attacks=${attackCount}`);
}

// ---------------------------------------------------------------------------
// 10. Aggro on damage (aggro species)
// ---------------------------------------------------------------------------

{
  const e = makeEntity('griffin', 50, 50);
  e.mode = 'wander';

  onEntityDamaged(e);

  check('griffin enters aggro on damage', e.mode === 'aggro');
  check('aggro stateTimer reset', e.stateTimer === 0);
}

// ---------------------------------------------------------------------------
// 11. Attack cadence: 1.2 s between attacks
// ---------------------------------------------------------------------------

{
  let attacks = 0;
  const e = makeEntity('dragon', 0, 0);
  e.mode = 'aggro';
  e.stateTimer = 0;

  const ctx = makeCtx({
    playerX: 0.5, playerZ: 0,
    playerDist: 0.5,
    speciesDef: SPECIES_DEFS['dragon'],
    onAttackPlayer: () => { attacks++; },
  });

  // Step for exactly 1.2 s (72 ticks at 60 Hz).
  for (let i = 0; i < 72; i++) {
    stepAnimal(e, 1 / 60, ctx);
  }

  // Should have attacked ~1 time (first attack at tick 0, next at ~1.2 s).
  check('attack cadence: ~1 attack in 1.2 s', attacks === 1,
    `attacks=${attacks}`);
}

// ---------------------------------------------------------------------------
// 12. Terrain clamp: y follows heightAt
// ---------------------------------------------------------------------------

{
  const e = makeEntity('deer', 0, 0);
  e.mode = 'wander';
  (e as EntityState & { _wanderTX?: number; _wanderTZ?: number })._wanderTX = 5;
  (e as EntityState & { _wanderTX?: number; _wanderTZ?: number })._wanderTZ = 0;
  e.stateTimer = 10;

  const terrainY = 12;
  stepAnimal(e, 0.5, makeCtx({
    playerDist: 50,
    heightAt: () => terrainY,
    speciesDef: SPECIES_DEFS['deer'],
  }));

  check('terrain clamp: y == heightAt result',
    Math.abs(e.y - terrainY) < 0.001, `y=${e.y}`);
}

// ---------------------------------------------------------------------------
// 13. Water species clamped to y = -0.5
// ---------------------------------------------------------------------------

{
  const e = makeEntity('sea_serpent', 0, 0);
  e.mode = 'idle';
  e.y = 5; // wrong y

  stepAnimal(e, 0.1, makeCtx({
    playerDist: 50,
    heightAt: () => -15, // deep ocean
    speciesDef: SPECIES_DEFS['sea_serpent'],
  }));

  check('water species y clamped to -0.5', Math.abs(e.y - (-0.5)) < 0.001, `y=${e.y}`);
}

// ---------------------------------------------------------------------------
// 14. Water species pushed back to home if terrain height > -2
// ---------------------------------------------------------------------------

{
  const e = makeEntity('sea_serpent', 50, 50);
  e.homeX = 50;
  e.homeZ = 50;
  e.mode = 'wander';
  (e as EntityState & { _wanderTX?: number; _wanderTZ?: number })._wanderTX = 60;
  (e as EntityState & { _wanderTX?: number; _wanderTZ?: number })._wanderTZ = 60;
  e.stateTimer = 10;

  // heightAt returns -1 (shallow — should trigger push-back to home).
  stepAnimal(e, 0.5, makeCtx({
    playerDist: 50,
    heightAt: () => -1,
    speciesDef: SPECIES_DEFS['sea_serpent'],
  }));

  check('water species pushed back to home on shallow water',
    Math.abs(e.x - 50) < 0.001 && Math.abs(e.z - 50) < 0.001,
    `x=${e.x} z=${e.z}`);
}

// ---------------------------------------------------------------------------
// 15. aggroDamage
// ---------------------------------------------------------------------------

{
  // Explicit attackDmg wins over the size formula.
  check('dragon aggroDamage = 5 (attackDmg)', aggroDamage('dragon') === 5);
  check('griffin aggroDamage = 3 (attackDmg)', aggroDamage('griffin') === 3);
  check('sea_serpent aggroDamage = 4 (attackDmg)', aggroDamage('sea_serpent') === 4);
  check('wolf aggroDamage = 2 (attackDmg)', aggroDamage('wolf') === 2);
  check('bear aggroDamage = 4 (attackDmg)', aggroDamage('bear') === 4);
  // rabbit size=0.4 → fallback max(1, round(0.4)) = 1
  check('rabbit aggroDamage = 1 (non-aggro but formula still works)', aggroDamage('rabbit') === 1);
}

// ---------------------------------------------------------------------------
// 16. Dead entities: no update
// ---------------------------------------------------------------------------

{
  const e = makeEntity('deer', 0, 0);
  e.mode = 'dead';
  e.x = 5; e.z = 5;

  const beforeX = e.x;
  stepAnimal(e, 1, makeCtx({ playerDist: 1 }));

  check('dead entity: position unchanged', e.x === beforeX, `x=${e.x}`);
  check('dead entity: mode unchanged', e.mode === 'dead');
}

// ---------------------------------------------------------------------------
// 17. Determinism: identical seeded rng + state → identical result
// ---------------------------------------------------------------------------

{
  function runDeterministicSeq(): EntityState {
    const e = makeEntity('deer', 0, 0);
    e.mode = 'idle';
    e.stateTimer = 0;

    const rng = mulberry32(0xdeadbeef);
    for (let i = 0; i < 120; i++) {
      stepAnimal(e, 1 / 60, makeCtx({
        playerX: 10, playerZ: 0,
        playerDist: 10,
        rng: mulberry32(0xdeadbeef ^ i), // stable per step
        speciesDef: SPECIES_DEFS['deer'],
      }));
    }
    return e;
  }

  const r1 = runDeterministicSeq();
  const r2 = runDeterministicSeq();

  check('determinism: x', Math.abs(r1.x - r2.x) < 0.0001, `x1=${r1.x} x2=${r2.x}`);
  check('determinism: z', Math.abs(r1.z - r2.z) < 0.0001, `z1=${r1.z} z2=${r2.z}`);
  check('determinism: mode', r1.mode === r2.mode);
}

// ---------------------------------------------------------------------------
// 18. Territorial rares: pursue inside territory, walk home once it's left
// ---------------------------------------------------------------------------

{
  // Untamed dragon keeps pursuing while the player is inside its territory
  // (50 m of home), even past the plain 32 m aggro give-up distance.
  const e = makeEntity('dragon', 0, 0);
  e.mode = 'aggro';
  stepAnimal(e, 1 / 60, makeCtx({
    playerX: 45, playerZ: 0,
    playerDist: 45,
    speciesDef: SPECIES_DEFS['dragon'],
  }));
  check('territorial dragon keeps pursuing inside territory', e.mode === 'aggro',
    `mode=${e.mode}`);

  // Player leaves the territory (> 58 m from home) → dragon heads home.
  stepAnimal(e, 1 / 60, makeCtx({
    playerX: 70, playerZ: 0,
    playerDist: 70 - e.x,
    speciesDef: SPECIES_DEFS['dragon'],
  }));
  check('territorial dragon returns home when territory left', e.mode === 'wander',
    `mode=${e.mode}`);
}

{
  // Standing anywhere inside the territory provokes the dragon, even when
  // the dragon itself is farther away than the plain 16 m trigger.
  const e = makeEntity('dragon', 0, 0);
  e.mode = 'idle';
  e.stateTimer = 10;
  stepAnimal(e, 1 / 60, makeCtx({
    playerX: 40, playerZ: 0,
    playerDist: 40,
    speciesDef: SPECIES_DEFS['dragon'],
  }));
  check('entering dragon territory provokes aggro', e.mode === 'aggro',
    `mode=${e.mode}`);
}

{
  // Non-rare aggro species keep the old give-up rule (idle past 32 m).
  const e = makeEntity('sea_serpent', 0, 0);
  e.mode = 'aggro';
  // Sea serpent is water — territorial logic does not apply.
  stepAnimal(e, 1 / 60, makeCtx({
    playerX: 50, playerZ: 0,
    playerDist: 50,
    heightAt: () => -20,
    speciesDef: SPECIES_DEFS['sea_serpent'],
  }));
  check('water rare keeps plain aggro give-up (idle)', e.mode === 'idle',
    `mode=${e.mode}`);
}

// ---------------------------------------------------------------------------
// 19. Phase K: follow mode — owned entity follows player
// ---------------------------------------------------------------------------

{
  const e = makeEntity('horse', 20, 0);
  e.mode = 'idle';
  (e as EntityState & { owned?: boolean }).owned = true;

  // After one step, entity should be in follow mode and moved closer to player at (0,0).
  stepAnimal(e, 0.5, makeCtx({
    playerX: 0, playerZ: 0,
    playerDist: 20,
    speciesDef: SPECIES_DEFS['horse'],
  }));

  check('owned entity enters follow mode', e.mode === 'follow', `mode=${e.mode}`);
  check('owned entity moves toward player', e.x < 20, `x=${e.x}`);
}

// ---------------------------------------------------------------------------
// 20. Phase K: owned entity does not flee even when player is close
// ---------------------------------------------------------------------------

{
  const e = makeEntity('deer', 5, 0);
  e.mode = 'idle';
  (e as EntityState & { owned?: boolean }).owned = true;

  // Player within flee trigger distance (5 m < 12 m), but entity is owned.
  stepAnimal(e, 1 / 60, makeCtx({
    playerX: 0, playerZ: 0,
    playerDist: 5, // would normally trigger flee
    speciesDef: SPECIES_DEFS['deer'],
  }));

  check('owned entity does not flee when player is close', e.mode !== 'flee',
    `mode=${e.mode}`);
  check('owned entity stays in follow mode', e.mode === 'follow', `mode=${e.mode}`);
}

// ---------------------------------------------------------------------------
// 21. Phase K: owned dragon does not enter aggro
// ---------------------------------------------------------------------------

{
  const e = makeEntity('dragon', 10, 0);
  e.mode = 'idle';
  (e as EntityState & { owned?: boolean }).owned = true;

  // Player within aggro trigger distance (10 m < 16 m), but entity is owned.
  stepAnimal(e, 1 / 60, makeCtx({
    playerX: 0, playerZ: 0,
    playerDist: 10, // would normally trigger aggro for dragon
    speciesDef: SPECIES_DEFS['dragon'],
  }));

  check('owned dragon does not aggro', e.mode !== 'aggro', `mode=${e.mode}`);
  check('owned dragon stays in follow mode', e.mode === 'follow', `mode=${e.mode}`);
}

// ---------------------------------------------------------------------------
// 22. Phase K: owned entity stops moving when close to player
// ---------------------------------------------------------------------------

{
  const e = makeEntity('horse', 1.5, 0); // 1.5 m from player = within FOLLOW_STOP_DIST
  e.mode = 'follow';
  (e as EntityState & { owned?: boolean }).owned = true;
  const startX = e.x;

  stepAnimal(e, 0.5, makeCtx({
    playerX: 0, playerZ: 0,
    playerDist: 1.5, // < FOLLOW_STOP_DIST (2.5)
    speciesDef: SPECIES_DEFS['horse'],
  }));

  check('follow: entity stops when close enough (x unchanged)',
    Math.abs(e.x - startX) < 0.01, `x before=${startX} after=${e.x}`);
}

// ---------------------------------------------------------------------------
// 23. Phase K: FOLLOW_RADIUS is exported and correct
// ---------------------------------------------------------------------------

check('FOLLOW_RADIUS exported and = 30', FOLLOW_RADIUS === 30);

// ---------------------------------------------------------------------------
// 24. Stay/sit: owned entity told to stay holds position and sits
// ---------------------------------------------------------------------------

{
  const e = makeEntity('horse', 10, 0);
  e.mode = 'follow';
  e.owned = true;
  e.staying = true;
  const startX = e.x;
  const startZ = e.z;

  // Player far beyond FOLLOW_RADIUS — a following horse would teleport-catchup.
  stepAnimal(e, 0.5, makeCtx({
    playerX: 100, playerZ: 0,
    playerDist: 90,
    speciesDef: SPECIES_DEFS['horse'],
  }));

  check('staying: position unchanged even with player far away',
    e.x === startX && e.z === startZ, `x=${e.x} z=${e.z}`);
  check('staying: home synced to current spot', e.homeX === startX && e.homeZ === startZ);
  check('staying: sit eased upward', (e.sit ?? 0) > 0, `sit=${e.sit}`);

  // sit reaches 1 after enough time (0.4 s ease).
  stepAnimal(e, 0.5, makeCtx({
    playerX: 100, playerZ: 0, playerDist: 90,
    speciesDef: SPECIES_DEFS['horse'],
  }));
  check('staying: sit reaches 1', e.sit === 1, `sit=${e.sit}`);

  // Cancel stay: sit eases back down and follow resumes (teleport catchup;
  // playerDist 50 is within the full-AI LOD range but beyond FOLLOW_RADIUS).
  e.staying = false;
  stepAnimal(e, 0.1, makeCtx({
    playerX: 60, playerZ: 0, playerDist: 50,
    speciesDef: SPECIES_DEFS['horse'],
  }));
  check('stay cancelled: sit eases back down', (e.sit ?? 1) < 1, `sit=${e.sit}`);
  check('stay cancelled: follow resumes (moved)', e.x !== startX, `x=${e.x}`);
}

// ---------------------------------------------------------------------------
// 25. Stay/sit: non-owned entities ignore staying flag
// ---------------------------------------------------------------------------

{
  const e = makeEntity('deer', 5, 0);
  e.mode = 'idle';
  e.staying = true; // not owned — should be inert
  stepAnimal(e, 0.5, makeCtx({
    playerX: 0, playerZ: 0, playerDist: 5,
    speciesDef: SPECIES_DEFS['deer'],
  }));
  check('non-owned: staying flag does not sit', (e.sit ?? 0) === 0, `sit=${e.sit}`);
  check('non-owned: deer still flees when player close', e.mode === 'flee', `mode=${e.mode}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
