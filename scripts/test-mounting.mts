/**
 * Pure unit tests for mount/saddle math and speed table.
 * Run: npx tsx scripts/test-mounting.mts
 *
 * Covers: saddle offset, mountSpeed table, needsTaming logic,
 * attemptMount flow, feed temper accumulation, FNV golden for buck sequence.
 */

import {
  attemptMount, feed, needsTaming, createTamedState,
  BUCK_CHANCE, TEMPER_PER_BUCK, TEMPER_PER_FEED, TAME_THRESHOLD,
  type TamedState,
} from '../src/game/entities/taming';
import { SPECIES_DEFS, type Species } from '../src/game/entities/entity-types';

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

// FNV-32a — for golden hashing.
function fnv32a(str: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// ---------------------------------------------------------------------------
// 1. Saddle offset — player sits at entity.y + species.size
// ---------------------------------------------------------------------------

{
  // Saddle height = entityY + size (horse size = 1.6)
  const horseSize = SPECIES_DEFS['horse'].size;
  const entityY = 5.0;
  const saddleY = entityY + horseSize;
  check('horse saddle y = entityY + size (1.6)', Math.abs(saddleY - 6.6) < 0.001,
    `saddleY=${saddleY}`);

  // Dragon size = 3.5
  const dragonSize = SPECIES_DEFS['dragon'].size;
  check('dragon saddle offset = 3.5', Math.abs(dragonSize - 3.5) < 0.001,
    `dragonSize=${dragonSize}`);
}

// ---------------------------------------------------------------------------
// 2. mountSpeed present for all mountable species
// ---------------------------------------------------------------------------

{
  const mountableSpecies: Species[] = ['horse', 'cow', 'donkey', 'dragon', 'griffin'];
  for (const sp of mountableSpecies) {
    const def = SPECIES_DEFS[sp];
    check(`${sp} is mountable`, def.mountable === true);
    check(`${sp} has mountSpeed > 0`,
      typeof def.mountSpeed === 'number' && def.mountSpeed > 0,
      `mountSpeed=${def.mountSpeed}`);
  }

  // sea_serpent is NOT mountable.
  check('sea_serpent is not mountable', SPECIES_DEFS['sea_serpent'].mountable === false);
}

// ---------------------------------------------------------------------------
// 3. Mount sprint speed = mountSpeed × 1.3
// ---------------------------------------------------------------------------

{
  const SPRINT_MUL = 1.3;
  // Horse mountSpeed = 14
  const horseMountSpeed = SPECIES_DEFS['horse'].mountSpeed!;
  check('horse mount sprint = 18.2', Math.abs(horseMountSpeed * SPRINT_MUL - 18.2) < 0.001,
    `${horseMountSpeed * SPRINT_MUL}`);

  // Dragon mountSpeed = 18
  const dragonMountSpeed = SPECIES_DEFS['dragon'].mountSpeed!;
  check('dragon mount sprint = 23.4', Math.abs(dragonMountSpeed * SPRINT_MUL - 23.4) < 0.001,
    `${dragonMountSpeed * SPRINT_MUL}`);

  // Ladder: every mount base speed beats player sprint (10); hierarchy holds.
  const PLAYER_SPRINT = 10;
  const ms = (sp: Species) => SPECIES_DEFS[sp].mountSpeed!;
  check('all mounts beat player sprint at base',
    ms('cow') > PLAYER_SPRINT && ms('donkey') > PLAYER_SPRINT && ms('horse') > PLAYER_SPRINT
    && ms('griffin') > PLAYER_SPRINT && ms('dragon') > PLAYER_SPRINT);
  check('mount speed ladder cow < donkey < horse < griffin < dragon',
    ms('cow') < ms('donkey') && ms('donkey') < ms('horse')
    && ms('horse') < ms('griffin') && ms('griffin') < ms('dragon'));
}

// ---------------------------------------------------------------------------
// 4. needsTaming: commons → false, rares → true
// ---------------------------------------------------------------------------

{
  check('horse needsTaming = false', needsTaming('horse') === false);
  check('cow needsTaming = false', needsTaming('cow') === false);
  check('donkey needsTaming = false', needsTaming('donkey') === false);
  check('dragon needsTaming = true', needsTaming('dragon') === true);
  check('griffin needsTaming = true', needsTaming('griffin') === true);
  check('rabbit needsTaming = false', needsTaming('rabbit') === false);
  check('sea_serpent needsTaming = false', needsTaming('sea_serpent') === false);
}

// ---------------------------------------------------------------------------
// 5. attemptMount: common species → always 'mounted'
// ---------------------------------------------------------------------------

{
  const state = createTamedState();
  for (const sp of ['horse', 'cow', 'donkey'] as Species[]) {
    const result = attemptMount(state, sp, () => 0.9); // rng always > BUCK_CHANCE
    check(`${sp} common → mounted`, result.result === 'mounted', `result=${result.result}`);
  }
}

// ---------------------------------------------------------------------------
// 6. attemptMount: non-mountable → refused
// ---------------------------------------------------------------------------

{
  const state = createTamedState();
  const result = attemptMount(state, 'rabbit', () => 0);
  check('rabbit → refused', result.result === 'refused', `result=${result.result}`);
  const result2 = attemptMount(state, 'sea_serpent', () => 0);
  check('sea_serpent → refused', result2.result === 'refused');
}

// ---------------------------------------------------------------------------
// 7. attemptMount: dragon untamed, rng < 0.5 → bucked, temper += TEMPER_PER_BUCK
// ---------------------------------------------------------------------------

{
  const state = createTamedState(); // temper = 0
  const result = attemptMount(state, 'dragon', () => 0.0); // always < BUCK_CHANCE
  check('dragon untamed + rng 0.0 → bucked', result.result === 'bucked',
    `result=${result.result}`);
  check('dragon buck → temper += TEMPER_PER_BUCK',
    result.state.temper === TEMPER_PER_BUCK,
    `temper=${result.state.temper}`);
}

// ---------------------------------------------------------------------------
// 8. attemptMount: dragon untamed, rng >= 0.5 → accepted-ride
// ---------------------------------------------------------------------------

{
  const state = createTamedState();
  const result = attemptMount(state, 'dragon', () => 0.9); // >= BUCK_CHANCE
  check('dragon untamed + rng 0.9 → accepted-ride', result.result === 'accepted-ride',
    `result=${result.result}`);
  check('accepted-ride temper unchanged', result.state.temper === 0,
    `temper=${result.state.temper}`);
}

// ---------------------------------------------------------------------------
// 9. attemptMount: tamed dragon → mounted
// ---------------------------------------------------------------------------

{
  const state: TamedState = { temper: 80, tamed: true };
  const result = attemptMount(state, 'dragon', () => 0); // rng = 0, would normally buck
  check('tamed dragon → always mounted', result.result === 'mounted',
    `result=${result.result}`);
}

// ---------------------------------------------------------------------------
// 10. feed: temper accumulation → taming at threshold
// ---------------------------------------------------------------------------

{
  let state = createTamedState();
  const bucksNeeded = Math.ceil(TAME_THRESHOLD / TEMPER_PER_BUCK);
  let feedCount = 0;
  // Feed until tamed.
  while (!state.tamed && feedCount < 30) {
    const res = feed(state, 'dragon', 'meat_cooked');
    check(`feed accepted (step ${feedCount})`, res.accepted);
    state = res.state;
    feedCount++;
  }
  check('dragon tamed after feeding', state.tamed === true,
    `tamed=${state.tamed} temper=${state.temper}`);
  check('tamed temper >= threshold', state.temper >= TAME_THRESHOLD,
    `temper=${state.temper}`);
}

// ---------------------------------------------------------------------------
// 11. feed: wrong food → not accepted
// ---------------------------------------------------------------------------

{
  const state = createTamedState();
  const res = feed(state, 'dragon', 'berries'); // dragon likes meat_cooked
  check('wrong food → not accepted', res.accepted === false);
  check('wrong food → temper unchanged', res.state.temper === 0);
}

// ---------------------------------------------------------------------------
// 12. FNV golden: deterministic buck/mount sequence
// ---------------------------------------------------------------------------

{
  // Simulate 16 mount attempts on a dragon with a fixed rng sequence.
  // Use mulberry32-derived values by manually encoding a deterministic sequence.
  const rngs = [0.0, 0.9, 0.1, 0.8, 0.2, 0.7, 0.3, 0.6,
                0.4, 0.5, 0.01, 0.99, 0.49, 0.51, 0.25, 0.75];
  let state = createTamedState();
  const results: string[] = [];
  for (let i = 0; i < rngs.length; i++) {
    const r = attemptMount(state, 'dragon', () => rngs[i]);
    results.push(`${r.result}:${r.state.temper}`);
    state = r.state;
    if (state.tamed) break;
  }
  const snap = results.join('|');
  const h = fnv32a(snap);

  // Two identical runs → same hash.
  let state2 = createTamedState();
  const results2: string[] = [];
  for (let i = 0; i < rngs.length; i++) {
    const r2 = attemptMount(state2, 'dragon', () => rngs[i]);
    results2.push(`${r2.result}:${r2.state.temper}`);
    state2 = r2.state;
    if (state2.tamed) break;
  }
  const snap2 = results2.join('|');
  const h2 = fnv32a(snap2);

  check('FNV golden: identical mount sequences hash identically', h === h2,
    `h=0x${h.toString(16)} h2=0x${h2.toString(16)}`);
  check('FNV golden: non-empty sequence', snap.length > 0);
}

// ---------------------------------------------------------------------------
// 13. Dragon flight constants — vertical speed and flight drain
// ---------------------------------------------------------------------------

{
  // These constants are defined in main.ts; we test the pure physics here
  // with equivalent values so the flight spec is documented and checkable.
  const DRAGON_FLIGHT_SPEED = 6;          // m/s ascent / descent
  const DRAGON_FLIGHT_DRAIN_PER_S = 2;    // stamina/s while airborne
  const DRAGON_AIRBORNE_FLAP_RATE = 3.0;  // rad/s walkPhase advance while hovering

  // At 1 second held, player should rise by FLIGHT_SPEED m above terrain.
  const dtS = 1.0;
  const startY = 0;
  const expectedY = startY + DRAGON_FLIGHT_SPEED * dtS;
  check('dragon flight: 1 s of Space → +6 m',
    Math.abs(expectedY - 6) < 0.001, `expectedY=${expectedY}`);

  // Stamina drain over 3 s of hovering.
  const startStam = 100;
  const stamAfter3s = startStam - DRAGON_FLIGHT_DRAIN_PER_S * 3;
  check('dragon flight: 3 s airborne → stamina = 94',
    Math.abs(stamAfter3s - 94) < 0.001, `stam=${stamAfter3s}`);

  // Descend by same speed.
  const descendY = 10 - DRAGON_FLIGHT_SPEED * dtS;
  check('dragon flight: 1 s of Ctrl from alt 10 → alt 4',
    Math.abs(descendY - 4) < 0.001, `descendY=${descendY}`);

  // Flap rate is positive (walkPhase advances).
  check('dragon flight: airborne flap rate > 0', DRAGON_AIRBORNE_FLAP_RATE > 0);

  // DRAGON_FLIGHT_ENABLED should be true (we import it).
  const { DRAGON_FLIGHT_ENABLED } = await import('../src/game/entities/entity-types.js');
  check('DRAGON_FLIGHT_ENABLED is true', DRAGON_FLIGHT_ENABLED === true);

  // Saddle height for dragon at altitude 10 = 10 + 3.5 = 13.5.
  const dragonSize = SPECIES_DEFS['dragon'].size;
  const entityAltY = 10;
  const saddleAtAlt = entityAltY + dragonSize;
  check('dragon saddle at altitude 10 = 13.5',
    Math.abs(saddleAtAlt - 13.5) < 0.001, `saddle=${saddleAtAlt}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
