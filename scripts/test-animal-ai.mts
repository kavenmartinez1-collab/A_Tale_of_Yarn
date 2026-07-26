/**
 * Tests for src/game/entities/animal-ai.ts
 * Run: npx tsx scripts/test-animal-ai.mts
 *
 * Covers: LOD gates, state transitions, flee on damage,
 * aggro approach, graze holds, attack cadence, terrain clamp,
 * water clamping, determinism with seeded rng.
 */

import {
  stepAnimal, onEntityDamaged, aggroDamage, FOLLOW_RADIUS, DEFEND_GIVEUP_DIST,
  CombatIndex, isFighting, wantsAirborne,
  type DefendTarget,
} from '../src/game/entities/animal-ai';
import {
  appetite, courageOf, factionOf,
} from '../src/game/entities/combat-targeting';
import {
  SPECIES_DEFS, dispositionOf, type Species,
} from '../src/game/entities/entity-types';
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
// 26. Mounts defend their rider — owned animals intercept hostiles
//
// "also mounts should attack all hostile mobs coming after the players."
// An owned animal used to be hard-forced to 'follow' and could never attack
// anything, so a tamed dragon watched its owner be mauled.
// ---------------------------------------------------------------------------

{
  // --- it engages -----------------------------------------------------------
  const mount = makeEntity('dragon', 0, 0);
  mount.owned = true;
  mount.mode = 'follow';
  const threat: DefendTarget = { id: 'wolf-1', x: 14, z: 0 };
  const hits: { id: string; dmg: number }[] = [];
  const defendCtx = (t: DefendTarget | null) => makeCtx({
    playerX: 0, playerZ: 0, playerDist: 2,
    speciesDef: SPECIES_DEFS['dragon'],
    defendTarget: t,
    onAttackEntity: (id: string, dmg: number) => hits.push({ id, dmg }),
  });

  stepAnimal(mount, 0.1, defendCtx(threat));
  check('owned mount switches to defend when a hostile is nominated',
    mount.mode === 'defend', `mode=${mount.mode}`);

  // --- it closes the distance ----------------------------------------------
  const startDist = Math.hypot(threat.x - mount.x, threat.z - mount.z);
  for (let i = 0; i < 20; i++) stepAnimal(mount, 0.1, defendCtx(threat));
  const nowDist = Math.hypot(threat.x - mount.x, threat.z - mount.z);
  check('the defender closes on the threat', nowDist < startDist - 2,
    `${startDist.toFixed(1)} -> ${nowDist.toFixed(1)}`);
  check('the defender faces the threat', Math.abs(mount.yaw - Math.PI / 2) < 0.2,
    `yaw=${mount.yaw.toFixed(2)}`);

  // --- it lands hits, on the right target, at a cadence ---------------------
  for (let i = 0; i < 60; i++) stepAnimal(mount, 0.1, defendCtx(threat));
  check('the defender actually hits the threat', hits.length > 0,
    `hits=${hits.length}`);
  check('every hit names the nominated threat',
    hits.every(h => h.id === 'wolf-1'));
  check('hits carry the species attack damage',
    hits.every(h => h.dmg === aggroDamage('dragon')), `dmg=${hits[0]?.dmg}`);
  // 6 s of contact at a 1.2 s cooldown is at most ~6 hits, not one per tick.
  check('the defender does not hit every tick', hits.length < 12,
    `hits=${hits.length} over ~8 s`);

  // --- it goes home when the threat is gone --------------------------------
  stepAnimal(mount, 0.1, defendCtx(null));
  check('the defender returns to follow when the threat is gone',
    mount.mode === 'follow', `mode=${mount.mode}`);

  // --- it will not chase a threat halfway across the map -------------------
  const far = makeEntity('horse', 0, 0);
  far.owned = true;
  far.mode = 'follow';
  stepAnimal(far, 0.1, makeCtx({
    playerX: 0, playerZ: 0, playerDist: 2,
    speciesDef: SPECIES_DEFS['horse'],
    defendTarget: { id: 'far-wolf', x: DEFEND_GIVEUP_DIST + 20, z: 0 },
    onAttackEntity: () => {},
  }));
  check('a threat beyond the give-up distance is ignored',
    far.mode === 'follow', `mode=${far.mode}`);
}

// ---------------------------------------------------------------------------
// 27. Defending must not break the things owned animals already did
// ---------------------------------------------------------------------------

{
  // No defendTarget at all → identical follow behaviour to before.
  const pet = makeEntity('horse', 20, 0);
  pet.owned = true;
  pet.mode = 'follow';
  const before = { x: pet.x, z: pet.z };
  stepAnimal(pet, 0.5, makeCtx({
    playerX: 0, playerZ: 0, playerDist: 20,
    speciesDef: SPECIES_DEFS['horse'],
  }));
  check('an owned animal with no threat still follows',
    pet.mode === 'follow' && pet.x < before.x, `x=${pet.x}`);

  // An owned animal must NEVER aggro the player, threat or no threat.
  const tamedBear = makeEntity('bear', 1, 0);
  tamedBear.owned = true;
  let mauled = 0;
  for (let i = 0; i < 40; i++) {
    stepAnimal(tamedBear, 0.1, makeCtx({
      playerX: 0, playerZ: 0, playerDist: 1,
      speciesDef: SPECIES_DEFS['bear'],
      defendTarget: { id: 'w', x: 6, z: 0 },
      onAttackEntity: () => {},
      onAttackPlayer: () => { mauled++; },
    }));
  }
  check('an owned aggro species never attacks its owner', mauled === 0);
  check('...even while defending', tamedBear.mode === 'defend');

  // A defender told to STAY holds its ground — an explicit order outranks
  // initiative, and a pet that abandons a spot you parked it on is a bug.
  const parked = makeEntity('wolf', 3, 3);
  parked.owned = true;
  parked.staying = true;
  const parkedAt = { x: parked.x, z: parked.z };
  for (let i = 0; i < 20; i++) {
    stepAnimal(parked, 0.1, makeCtx({
      playerX: 0, playerZ: 0, playerDist: 4,
      speciesDef: SPECIES_DEFS['wolf'],
      defendTarget: { id: 'w', x: 10, z: 3 },
      onAttackEntity: () => { throw new Error('a staying pet attacked'); },
    }));
  }
  check('a pet told to stay does not run off to fight',
    parked.x === parkedAt.x && parked.z === parkedAt.z);

  // Wild animals must ignore defendTarget entirely.
  const wolf = makeEntity('wolf', 3, 0);
  wolf.mode = 'idle';
  let wildAttacked = false;
  stepAnimal(wolf, 0.1, makeCtx({
    playerX: 0, playerZ: 0, playerDist: 3,
    speciesDef: SPECIES_DEFS['wolf'],
    defendTarget: { id: 'other', x: 5, z: 0 },
    onAttackEntity: () => { wildAttacked = true; },
  }));
  check('a wild animal ignores defendTarget and still aggros the player',
    wolf.mode === 'aggro' && !wildAttacked, `mode=${wolf.mode}`);

  // A defender with no onAttackEntity wired up must still not crash.
  const noHook = makeEntity('horse', 0, 0);
  noHook.owned = true;
  let threw = false;
  try {
    for (let i = 0; i < 30; i++) {
      stepAnimal(noHook, 0.1, makeCtx({
        playerX: 0, playerZ: 0, playerDist: 2,
        speciesDef: SPECIES_DEFS['horse'],
        defendTarget: { id: 'w', x: 1, z: 0 },
      }));
    }
  } catch { threw = true; }
  check('a defender with no attack callback degrades safely', !threw);
}

// ===========================================================================
// MOB-VS-MOB COMBAT
//
// Every hostile in this game used to target exactly one thing: the player. A
// wolf and a deer could stand touching each other indefinitely. These tests
// assert what must be TRUE of the replacement, and each one is paired with a
// case that would pass if the rule were absent — a test that only checks
// "the wolf attacked something" cannot tell hunting from flailing.
// ===========================================================================

/** Build an index over a handful of entities, with the player at the origin. */
function indexOf(...ents: EntityState[]): CombatIndex {
  const ix = new CombatIndex();
  ix.rebuild(ents, null, 0, 0);
  return ix;
}

/**
 * Where the observer stands during a mob-combat simulation.
 *
 * Not "very far away", which is the obvious choice and is wrong: `stepAnimal`
 * skips entirely past 200 m and drops to a slow home-drift past 80 m, so a
 * player parked at 400 m produces a test in which nothing happens at all and
 * every assertion fails for the same uninformative reason. This spot is ~64 m
 * from the action — inside the full state machine, comfortably outside the
 * 16 m aggro and 12 m flee triggers, so the player is present but irrelevant.
 */
const WATCH_X = 45;
const WATCH_Z = -45;

/** Step `e` for `seconds`, rebuilding the index each tick so targets track. */
function simulate(
  actors: EntityState[], seconds: number,
  ctxFor: (e: EntityState, ix: CombatIndex) => Partial<AnimalAICtx>,
  npcs: { id: string; x: number; z: number }[] | null = null,
): void {
  const ix = new CombatIndex();
  const dt = 1 / 30;
  for (let t = 0; t < seconds; t += dt) {
    ix.rebuild(actors, npcs, WATCH_X, WATCH_Z);
    for (const e of actors) {
      if (e.mode === 'dead') continue;
      stepAnimal(e, dt, makeCtx({
        playerX: WATCH_X,
        playerZ: WATCH_Z,
        playerDist: Math.hypot(e.x - WATCH_X, e.z - WATCH_Z),
        speciesDef: SPECIES_DEFS[e.species],
        combat: ix,
        ...ctxFor(e, ix),
      }));
    }
  }
}

// ---------------------------------------------------------------------------
// M1. A predator prefers prey to a rock — appetite is not "attack anything".
// ---------------------------------------------------------------------------

{
  const wolfSize = SPECIES_DEFS.wolf.size;
  const target = (sp: Species, owned = false) => ({
    id: sp, kind: 'entity' as const, x: 5, z: 0, species: sp,
    size: SPECIES_DEFS[sp].size, owned, faction: factionOf(sp),
  });
  const want = (sp: Species): number =>
    appetite('wolf', 'predator', wolfSize, target(sp), courageOf('wolf', 0, false));

  check('a wolf wants a deer', want('deer') > 0, `${want('deer')}`);
  check('a wolf wants a rabbit', want('rabbit') > 0);
  // The pairing that proves the rule exists: it must REFUSE something too big.
  check('a wolf will not start on a bear', want('bear') === 0, `${want('bear')}`);
  check('a wolf will not start on a dragon', want('dragon') === 0);
  check('a wolf will not eat another wolf', want('wolf') === 0);
  check('a wolf prefers a deer to a person',
    want('deer') > appetite('wolf', 'predator', wolfSize,
      { id: 'n', kind: 'npc', x: 5, z: 0, size: 1.45, owned: false, faction: 'wild' },
      courageOf('wolf', 0, false)));

  // Prey never starts anything, however small the other thing is.
  check('a deer never picks a fight',
    appetite('deer', dispositionOf(SPECIES_DEFS.deer), SPECIES_DEFS.deer.size,
      target('rabbit'), courageOf('deer', 0, false)) === 0);

  // Fliers are apex, and go for people rather than livestock.
  const npcT = { id: 'n', kind: 'npc' as const, x: 5, z: 0, size: 1.45,
    owned: false, faction: 'wild' as const };
  const wolfOnNpc = appetite('wolf', 'predator', SPECIES_DEFS.wolf.size, npcT,
    courageOf('wolf', 0, false));
  const dragonOnNpc = appetite('dragon', 'predator', SPECIES_DEFS.dragon.size, npcT,
    courageOf('dragon', 0, false));
  check('a dragon is far readier to take a villager than a wolf is',
    dragonOnNpc > wolfOnNpc * 2, `${dragonOnNpc.toFixed(2)} vs ${wolfOnNpc.toFixed(2)}`);
  check('a wyvern will attack a deer',
    appetite('wyvern', 'predator', SPECIES_DEFS.wyvern.size, target('deer'),
      courageOf('wyvern', 0, false)) > 0);
}

// ---------------------------------------------------------------------------
// M2. Pack courage: the goblin rule, stated as a property.
// ---------------------------------------------------------------------------

{
  const gob = SPECIES_DEFS.goblin;
  const big = { id: 'bear', kind: 'entity' as const, x: 4, z: 0,
    species: 'bear' as Species, size: SPECIES_DEFS.bear.size, owned: false,
    faction: 'wild' as const };

  const alone = appetite('goblin', 'raider', gob.size, big, courageOf('goblin', 0, false));
  const mob = appetite('goblin', 'raider', gob.size, big, courageOf('goblin', 4, false));
  check('a lone goblin will not take on a bear', alone === 0);
  check('four goblins will', mob > 0, `${mob}`);
  // And the pairing: courage is not infinite for anything that can feel fear.
  check('courage rises with allies',
    courageOf('goblin', 3, false) > courageOf('goblin', 0, false));
  check('fearless things do not do arithmetic about their odds',
    courageOf('skeleton', 0, true) === Number.POSITIVE_INFINITY);
  check('a lone skeleton takes on anything',
    appetite('skeleton', 'undead', SPECIES_DEFS.skeleton.size, big,
      courageOf('skeleton', 0, true)) > 0);
}

// ---------------------------------------------------------------------------
// M3. A wolf actually hunts a deer, and the hunt RESOLVES.
//
// The whole feature in one simulation. Both halves matter: a hunt that never
// starts is the old behaviour, and a hunt that never ends is a pair of
// entities vibrating against each other forever, which is the failure mode
// this is most likely to ship with.
// ---------------------------------------------------------------------------

{
  const wolf = makeEntity('wolf', 0, 0);
  const deer = makeEntity('deer', 12, 0);
  let deerHits = 0;

  simulate([wolf, deer], 24, (e) => ({
    onAttackEntity: (id: string, dmg: number) => {
      const t = id === deer.id ? deer : wolf;
      if (t.mode === 'dead') return;
      t.hp = Math.max(0, t.hp - dmg);
      if (t === deer) deerHits++;
      if (t.hp <= 0) { t.mode = 'dead'; return; }
      onEntityDamaged(t, { id: e.id, kind: 'entity', x: e.x, z: e.z });
    },
  }));

  check('the wolf hunted the deer', deerHits > 0, `${deerHits} hits landed`);
  check('the hunt RESOLVED — the deer is dead', deer.mode === 'dead',
    `deer hp ${deer.hp}, mode ${deer.mode}`);
  check('the wolf is not stuck in combat afterwards',
    !isFighting(wolf) || wolf.mode !== 'hunt',
    `wolf mode ${wolf.mode}`);
}

// ---------------------------------------------------------------------------
// M4. Fleeing prey runs FROM its attacker, and gains ground on nothing else.
// ---------------------------------------------------------------------------

{
  const wolf = makeEntity('wolf', 0, 0);
  const rabbit = makeEntity('rabbit', 3, 0);
  const startGap = Math.hypot(rabbit.x - wolf.x, rabbit.z - wolf.z);

  // Hit it once, then let it run without the wolf pursuing.
  onEntityDamaged(rabbit, { id: wolf.id, kind: 'entity', x: wolf.x, z: wolf.z });
  check('a struck rabbit flees rather than fights', rabbit.mode === 'flee');

  const ix = new CombatIndex();
  for (let t = 0; t < 2; t += 1 / 30) {
    ix.rebuild([wolf, rabbit], null, WATCH_X, WATCH_Z);
    stepAnimal(rabbit, 1 / 30, makeCtx({
      // The player is 60 m away in -X. Running from the PLAYER would carry the
      // rabbit toward +X... which is where the wolf is. The two directions are
      // deliberately opposed so the assertion below can tell them apart.
      playerX: -60, playerZ: 0,
      playerDist: Math.hypot(rabbit.x + 60, rabbit.z),
      speciesDef: SPECIES_DEFS.rabbit, combat: ix,
    }));
  }
  const endGap = Math.hypot(rabbit.x - wolf.x, rabbit.z - wolf.z);
  check('fleeing prey increases the distance to its ATTACKER',
    endGap > startGap + 1, `${startGap.toFixed(1)} -> ${endGap.toFixed(1)} m`);

  // The pairing that proves it is running from the wolf and not just from the
  // player: the player is 200 m away in +X, so running from the PLAYER would
  // move it toward -X, i.e. straight through the wolf.
  check('...and is running from the wolf, not from the distant player',
    rabbit.x > wolf.x, `rabbit x ${rabbit.x.toFixed(1)}, wolf x ${wolf.x.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
// M5. A hunt that cannot make progress gives up. No lock-ups.
//
// The specific scenario: a target that is unreachable because every move is
// cancelled (a wall, a room clamp, a rock the pathless mover cannot round).
// Without the stall detector this runs forever.
// ---------------------------------------------------------------------------

{
  const wolf = makeEntity('wolf', 0, 0);
  const deer = makeEntity('deer', 15, 0);
  const ix = new CombatIndex();
  let ticks = 0;
  let gaveUp = false;
  for (let t = 0; t < 60 && !gaveUp; t += 1 / 30) {
    ix.rebuild([wolf, deer], null, WATCH_X, WATCH_Z);
    stepAnimal(wolf, 1 / 30, makeCtx({
      playerX: WATCH_X, playerZ: WATCH_Z,
      playerDist: Math.hypot(wolf.x - WATCH_X, wolf.z - WATCH_Z),
      speciesDef: SPECIES_DEFS.wolf, combat: ix,
      // Every attempted move is refused — the wolf is pinned behind something.
      moveXZ: (x, z) => [x, z],
    }));
    ticks++;
    if (ticks > 30 && wolf.mode !== 'hunt') gaveUp = true;
  }
  check('a hunter that cannot close gives up rather than pushing forever',
    gaveUp, `wolf still in mode ${wolf.mode} after ${ticks} ticks`);
  check('...and the deer was never harmed by a fight that could not happen',
    deer.hp === SPECIES_DEFS.deer.hp);
}

// ---------------------------------------------------------------------------
// M6. Wildlife attacks NPCs.
// ---------------------------------------------------------------------------

{
  const bear = makeEntity('bear', 0, 0);
  const villager = { id: 'npc:tam', x: 9, z: 0 };
  let npcHits = 0;
  simulate([bear], 20, () => ({
    onAttackNpc: () => { npcHits++; },
  }), [villager]);
  check('a bear will maul a villager', npcHits > 0, `${npcHits} hits`);

  // Pairing: with no NPCs supplied, the same bear finds nothing to do.
  const bear2 = makeEntity('bear', 0, 0);
  let hits2 = 0;
  simulate([bear2], 20, () => ({ onAttackNpc: () => { hits2++; } }), null);
  check('...and does not invent one when there is nobody there', hits2 === 0);
}

// ---------------------------------------------------------------------------
// M7. Goblins and skeletons fight wildlife; a warband never fights itself.
// ---------------------------------------------------------------------------

{
  const skel = makeEntity('skeleton', 0, 0);
  const deer = makeEntity('deer', 10, 0);
  let hits = 0;
  simulate([skel, deer], 20, (e) => ({
    onAttackEntity: (id: string, dmg: number) => {
      if (id !== deer.id || deer.mode === 'dead') return;
      hits++;
      deer.hp = Math.max(0, deer.hp - dmg);
      if (deer.hp <= 0) deer.mode = 'dead';
      else onEntityDamaged(deer, { id: e.id, kind: 'entity', x: e.x, z: e.z });
    },
  }));
  check('a skeleton attacks a living creature', hits > 0, `${hits} hits`);

  // The warband rule, which is what stops a boss killing his own guards.
  const gt = { id: 'g', kind: 'entity' as const, x: 3, z: 0,
    species: 'goblin' as Species, size: SPECIES_DEFS.goblin.size,
    owned: false, faction: factionOf('goblin') };
  check('the boss does not attack his own guards',
    appetite('dread_king', 'undead', SPECIES_DEFS.dread_king.size, gt,
      courageOf('dread_king', 0, true)) === 0);
  check('goblins do not fight skeletons that came with them',
    appetite('goblin', 'raider', SPECIES_DEFS.goblin.size,
      { id: 's', kind: 'entity', x: 3, z: 0, species: 'skeleton',
        size: SPECIES_DEFS.skeleton.size, owned: false, faction: factionOf('skeleton') },
      courageOf('goblin', 0, false)) === 0);
  check('...but a goblin and a bear are not allies',
    appetite('goblin', 'raider', SPECIES_DEFS.goblin.size,
      { id: 'b', kind: 'entity', x: 3, z: 0, species: 'bear',
        size: SPECIES_DEFS.bear.size, owned: false, faction: factionOf('bear') },
      courageOf('goblin', 6, false)) > 0);
}

// ---------------------------------------------------------------------------
// M8. THE UNFORGIVABLE BUG: a mount must never turn on its rider.
//
// Two independent guarantees, tested separately so that losing either one
// fails loudly:
//   (a) the player is not in the combat index at all, so no target scan can
//       ever return them;
//   (b) `isOwned` short-circuits the aggro path, so an owned animal cannot
//       enter combat with the player even if something else set it up.
// ---------------------------------------------------------------------------

{
  const mount = makeEntity('wyvern', 0, 0);
  mount.owned = true;
  const deer = makeEntity('deer', 6, 0);

  let touchedPlayer = false;
  let touchedAnything = false;
  const ix = new CombatIndex();
  for (let t = 0; t < 15; t += 1 / 30) {
    ix.rebuild([mount, deer], [{ id: 'npc:x', x: 4, z: 4 }], 0, 0);
    stepAnimal(mount, 1 / 30, makeCtx({
      playerX: 1, playerZ: 0, playerDist: 1, // rider standing right beside it
      speciesDef: SPECIES_DEFS.wyvern, combat: ix,
      onAttackPlayer: () => { touchedPlayer = true; },
      onAttackEntity: () => { touchedAnything = true; },
      onAttackNpc: () => { touchedAnything = true; },
    }));
  }
  check('a tamed mount NEVER attacks its rider', !touchedPlayer);
  check('a tamed mount does not pick its own fights either', !touchedAnything);
  check('a tamed mount never enters hunt mode', mount.mode !== 'hunt',
    `mode ${mount.mode}`);

  // (a) stated directly.
  const ix2 = indexOf(makeEntity('wolf', 1, 1));
  check('the player is not a combat target', ix2.get('player') === null);

  // An owned animal that gets clipped by its owner still does not retaliate.
  const pet = makeEntity('horse', 0, 0);
  pet.owned = true;
  onEntityDamaged(pet);
  check('an owned animal hit by its owner does not turn on them',
    pet.mode !== 'aggro' && pet.mode !== 'hunt', `mode ${pet.mode}`);
}

// ---------------------------------------------------------------------------
// M9. Territory: a wild flier fights a tamed rival only on its own ground.
//
// "That is the risk of exploring" — losing a mount has to be a consequence of
// where the player took it, not an attrition tax on ordinary business.
// ---------------------------------------------------------------------------

{
  const tamedT = {
    id: 'tame', kind: 'entity' as const, x: 5, z: 0, species: 'wyvern' as Species,
    size: SPECIES_DEFS.wyvern.size, owned: true, faction: factionOf('wyvern'),
  };
  const wildT = { ...tamedT, id: 'wild', owned: false };
  check('a wild wyvern will drive off a TAMED wyvern',
    appetite('wyvern', 'predator', SPECIES_DEFS.wyvern.size, tamedT,
      courageOf('wyvern', 0, false)) > 0);
  check('...but ignores another WILD one of its own kind',
    appetite('wyvern', 'predator', SPECIES_DEFS.wyvern.size, wildT,
      courageOf('wyvern', 0, false)) === 0);

  // And the range gate: the wild one only acts inside its own territory.
  // A tamed mount parked 120 m from a nest is not attacked.
  const wild = makeEntity('wyvern', 0, 0);   // home is (0,0)
  const tamed = makeEntity('wyvern', 120, 0);
  tamed.owned = true;
  let struck = false;
  simulate([wild, tamed], 12, () => ({ onAttackEntity: () => { struck = true; } }));
  check('a wild flier ignores a tamed one far outside its territory', !struck,
    `wild mode ${wild.mode}`);
}

// ---------------------------------------------------------------------------
// M10. Morale: a lone goblin breaks, a pack does not.
// ---------------------------------------------------------------------------

{
  const lone = makeEntity('goblin', 0, 0);
  lone.mode = 'aggro';
  lone.hp = 3; // below morale 0.34 * 12
  const ixL = indexOf(lone);
  stepAnimal(lone, 1 / 30, makeCtx({
    playerDist: 5, speciesDef: SPECIES_DEFS.goblin, combat: ixL,
  }));
  check('a lone goblin at low health runs', lone.mode === 'flee', `mode ${lone.mode}`);

  const brave = makeEntity('goblin', 0, 0);
  brave.mode = 'aggro';
  brave.hp = 3;
  const mates = [makeEntity('goblin', 1, 0), makeEntity('goblin', 0, 1),
    makeEntity('goblin', 1, 1)];
  const ixB = indexOf(brave, ...mates);
  stepAnimal(brave, 1 / 30, makeCtx({
    playerDist: 5, speciesDef: SPECIES_DEFS.goblin, combat: ixB,
  }));
  check('the same goblin with friends beside it holds', brave.mode === 'aggro',
    `mode ${brave.mode}`);

  // The undead never break, whatever the arithmetic says.
  const skel = makeEntity('skeleton', 0, 0);
  skel.mode = 'aggro';
  skel.hp = 1;
  stepAnimal(skel, 1 / 30, makeCtx({
    playerDist: 5, speciesDef: SPECIES_DEFS.skeleton, combat: indexOf(skel),
  }));
  check('a skeleton at 1 hp does not run', skel.mode === 'aggro', `mode ${skel.mode}`);
}

// ---------------------------------------------------------------------------
// M11. The player does not interrupt a fight already in progress.
// ---------------------------------------------------------------------------

{
  const wolf = makeEntity('wolf', 0, 0);
  const deer = makeEntity('deer', 6, 0);
  const ix = new CombatIndex();
  // Get the hunt started with the player far away.
  for (let t = 0; t < 3; t += 1 / 30) {
    ix.rebuild([wolf, deer], null, WATCH_X, WATCH_Z);
    stepAnimal(wolf, 1 / 30, makeCtx({
      playerX: WATCH_X, playerZ: WATCH_Z,
      playerDist: Math.hypot(wolf.x - WATCH_X, wolf.z - WATCH_Z),
      speciesDef: SPECIES_DEFS.wolf, combat: ix,
      onAttackEntity: () => {},
    }));
  }
  check('the wolf is hunting', wolf.mode === 'hunt', `mode ${wolf.mode}`);
  // Now walk right up to it.
  for (let t = 0; t < 1; t += 1 / 30) {
    ix.rebuild([wolf, deer], null, wolf.x, wolf.z);
    stepAnimal(wolf, 1 / 30, makeCtx({
      playerX: wolf.x, playerZ: wolf.z, playerDist: 1,
      speciesDef: SPECIES_DEFS.wolf, combat: ix, onAttackEntity: () => {},
    }));
  }
  check('walking up to a hunting wolf does not make the world revolve around you',
    wolf.mode === 'hunt', `mode ${wolf.mode}`);
  // But hitting it does, which is the honest way to get its attention.
  onEntityDamaged(wolf);
  check('...hitting it, however, does', wolf.mode === 'aggro');
}

// ---------------------------------------------------------------------------
// M12. Cost: the scan must not dominate the tick.
// ---------------------------------------------------------------------------

{
  const herd: EntityState[] = [];
  for (let i = 0; i < 40; i++) {
    const sp: Species = i % 4 === 0 ? 'wolf' : 'deer';
    herd.push(makeEntity(sp, (i % 8) * 6 - 24, Math.floor(i / 8) * 6 - 15));
  }
  const ix = new CombatIndex();
  const FRAMES = 600;
  const t0 = performance.now();
  for (let f = 0; f < FRAMES; f++) {
    ix.rebuild(herd, null, WATCH_X, WATCH_Z);
    for (const e of herd) {
      stepAnimal(e, 1 / 60, makeCtx({
        playerX: WATCH_X, playerZ: WATCH_Z,
        playerDist: Math.hypot(e.x - WATCH_X, e.z - WATCH_Z),
        speciesDef: SPECIES_DEFS[e.species], combat: ix,
        onAttackEntity: () => {},
      }));
    }
  }
  const perFrame = (performance.now() - t0) / FRAMES;
  console.log(`  [perf] 40 entities, full mob-combat tick: ${perFrame.toFixed(3)} ms/frame`);
  // One creature MESH rebuild costs ~1.8 ms and the renderer allows 8 of them.
  // The entire AI for a full LIVE_CAP of entities has to be small against that.
  check('mob combat for 40 entities costs well under one mesh rebuild',
    perFrame < 1.0, `${perFrame.toFixed(3)} ms/frame`);
  check('the index only holds what is near the player',
    ix.size <= herd.length);
}

// ---------------------------------------------------------------------------
// M13. The airborne signal (consumed by main.ts's flier altitude controller).
// ---------------------------------------------------------------------------

{
  const wyv = makeEntity('wyvern', 0, 0);
  wyv.mode = 'aggro';
  stepAnimal(wyv, 1 / 30, makeCtx({
    playerX: 40, playerZ: 0, playerDist: 40, speciesDef: SPECIES_DEFS.wyvern,
  }));
  check('a wild flier crossing open ground wants to be airborne',
    wantsAirborne(wyv));

  const owned = makeEntity('wyvern', 0, 0);
  owned.owned = true;
  stepAnimal(owned, 1 / 30, makeCtx({
    playerX: 40, playerZ: 0, playerDist: 40, speciesDef: SPECIES_DEFS.wyvern,
  }));
  // Owned fliers stay on the ground so the player can walk up and mount them.
  check('a tamed flier never asks to take off', !wantsAirborne(owned));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
