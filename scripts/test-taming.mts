/**
 * Tests for src/game/entities/taming.ts — pure taming/egg/growth model.
 * Run: npx tsx scripts/test-taming.mts
 *
 * Style matches test-vitals.mts: check() + summary + exit 1 on failure.
 */

import {
  TAME_THRESHOLD, TEMPER_PER_BUCK, TEMPER_PER_FEED, BUCK_CHANCE,
  EGG_HATCH_S, EGG_HEAT_RADIUS, GROWTH_S, FEED_GROWTH_BONUS_S, TAMING_KEY,
  createTamedState, needsTaming, attemptMount, feed,
  heatEgg, growBaby, feedBaby, eggSpeciesFor,
  serializeTamingRegistry, deserializeTamingRegistry,
  type TamedState, type EggState, type GrowthState, type TamingRegistry,
} from '../src/game/entities/taming';

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
// FNV-1a-32 (offset 0x811c9dc5, prime 0x01000193)
// ---------------------------------------------------------------------------

function fnv32a(str: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h  = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// ---------------------------------------------------------------------------
// Seeded mulberry32 PRNG (deterministic)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s  = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t  = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 1. Constants
// ---------------------------------------------------------------------------

check('TAME_THRESHOLD == 80',          TAME_THRESHOLD === 80);
check('TEMPER_PER_BUCK == 5',          TEMPER_PER_BUCK === 5);
check('TEMPER_PER_FEED == 8',          TEMPER_PER_FEED === 8);
check('BUCK_CHANCE == 0.5',            BUCK_CHANCE === 0.5);
check('EGG_HATCH_S == 120',            EGG_HATCH_S === 120);
check('EGG_HEAT_RADIUS == 6',          EGG_HEAT_RADIUS === 6);
check('GROWTH_S == 1200',              GROWTH_S === 1200);
check('FEED_GROWTH_BONUS_S == 60',     FEED_GROWTH_BONUS_S === 60);
check('TAMING_KEY',                    TAMING_KEY === 'artifex-taming:v1');

// ---------------------------------------------------------------------------
// 2. createTamedState — defaults
// ---------------------------------------------------------------------------

{
  const s = createTamedState();
  check('createTamedState: temper == 0',   s.temper === 0);
  check('createTamedState: tamed == false', s.tamed  === false);
}

// ---------------------------------------------------------------------------
// 3. needsTaming — exact set
// ---------------------------------------------------------------------------

// Requires taming: mountable && rare
check('needsTaming dragon == true',   needsTaming('dragon')   === true);
check('needsTaming griffin == true',  needsTaming('griffin')  === true);

// Common mountables: mountable && !rare → no taming required
check('needsTaming horse == false',   needsTaming('horse')   === false);
check('needsTaming cow == false',     needsTaming('cow')     === false);
check('needsTaming donkey == false',  needsTaming('donkey')  === false);

// Non-mountable species → also false (mountable is false)
check('needsTaming rabbit == false',      needsTaming('rabbit')     === false);
check('needsTaming deer == false',        needsTaming('deer')       === false);
check('needsTaming bird == false',        needsTaming('bird')       === false);
check('needsTaming sea_serpent == false', needsTaming('sea_serpent') === false);

// ---------------------------------------------------------------------------
// 4. attemptMount — non-mountable species → 'refused'
// ---------------------------------------------------------------------------

{
  const s    = createTamedState();
  const rng  = mulberry32(1);

  for (const sp of ['rabbit', 'deer', 'bird', 'sea_serpent'] as const) {
    const r = attemptMount(s, sp, rng);
    check(`attemptMount ${sp} → refused`, r.result === 'refused');
  }
}

// ---------------------------------------------------------------------------
// 5. attemptMount — common mountables → 'mounted' without taming
// ---------------------------------------------------------------------------

{
  const s   = createTamedState();   // untamed, temper 0
  const rng = mulberry32(42);

  for (const sp of ['horse', 'cow', 'donkey'] as const) {
    const r = attemptMount(s, sp, rng);
    check(`attemptMount ${sp} untamed → mounted`, r.result === 'mounted');
    check(`attemptMount ${sp} tamed flag unchanged`, r.state.tamed === false);
  }
}

// ---------------------------------------------------------------------------
// 6. attemptMount — rare species: already tamed → 'mounted'
// ---------------------------------------------------------------------------

{
  const s:   TamedState = { temper: 80, tamed: true };
  const rng  = mulberry32(7);

  const r = attemptMount(s, 'dragon', rng);
  check('tamed dragon → mounted', r.result === 'mounted');
}

// ---------------------------------------------------------------------------
// 7. Buck accumulation — seeded PRNG — 16 bucks to reach temper 80 (tamed)
//
// mulberry32(seed=99): we drive attempts until tamed is set.
// Expected: every buck adds +5; 16 bucks → temper = 80 → tamed.
// We verify the count and the exact final temper.
// ---------------------------------------------------------------------------

{
  let state  = createTamedState();
  const rng  = mulberry32(99);
  let bucks  = 0;
  let rides  = 0;
  let iters  = 0;

  while (!state.tamed && iters < 1000) {
    const r = attemptMount(state, 'dragon', rng);
    state   = r.state;
    if (r.result === 'bucked')        bucks++;
    if (r.result === 'accepted-ride') rides++;
    iters++;
  }

  check('dragon tamed after bucks + rides (tamed == true)', state.tamed === true);
  check('temper at taming == 80', state.temper === 80,
    `temper=${state.temper} bucks=${bucks} rides=${rides} iters=${iters}`);
  // Exactly 16 bucks are needed to reach 80 (16 × 5 = 80).
  check('exactly 16 bucks reach threshold (80 / 5)', bucks === 16,
    `bucks=${bucks} rides=${rides}`);
}

// ---------------------------------------------------------------------------
// 8. feed — favorite food adds TEMPER_PER_FEED; wrong food rejected
// ---------------------------------------------------------------------------

{
  const s = createTamedState();  // temper 0

  // Dragon favoriteFood = 'meat_cooked'
  const { accepted: ok1, state: s1 } = feed(s, 'dragon', 'meat_cooked');
  check('feed dragon meat_cooked accepted', ok1 === true);
  check('feed dragon: temper += 8', s1.temper === 8, `temper=${s1.temper}`);
  check('feed dragon: not yet tamed at 8', s1.tamed === false);

  // Wrong food
  const { accepted: ok2, state: s2 } = feed(s, 'dragon', 'flax');
  check('feed dragon wrong food rejected', ok2 === false);
  check('feed dragon wrong food: temper unchanged', s2.temper === 0);

  // Griffin favoriteFood = 'meat_raw'
  const { accepted: ok3, state: s3 } = feed(s, 'griffin', 'meat_raw');
  check('feed griffin meat_raw accepted', ok3 === true);
  check('feed griffin: temper += 8', s3.temper === 8);

  // Horse favoriteFood = 'healing_herb'
  const { accepted: ok4, state: s4 } = feed(s, 'horse', 'healing_herb');
  check('feed horse healing_herb accepted', ok4 === true);
  check('feed horse: temper += 8', s4.temper === 8);
}

// ---------------------------------------------------------------------------
// 9. feed — clamp at 100
// ---------------------------------------------------------------------------

{
  const s: TamedState = { temper: 97, tamed: true };
  const { accepted, state } = feed(s, 'dragon', 'meat_cooked');
  check('feed clamp: accepted', accepted === true);
  check('feed clamp: temper clamped to 100', state.temper === 100,
    `temper=${state.temper}`);
}

// ---------------------------------------------------------------------------
// 10. feed — tamed flag set exactly at threshold
// ---------------------------------------------------------------------------

{
  // temper starts at 72; one feed (+8) → 80 → tamed
  const s: TamedState = { temper: 72, tamed: false };
  const { accepted, state } = feed(s, 'dragon', 'meat_cooked');
  check('feed at 72 accepted', accepted === true);
  check('feed 72→80 sets tamed', state.tamed === true,
    `temper=${state.temper} tamed=${state.tamed}`);
}

// ---------------------------------------------------------------------------
// 11. heatEgg — accumulates only near fire; no accumulation without fire
// ---------------------------------------------------------------------------

{
  const egg: EggState = { species: 'dragon', heatS: 0, hatched: false };

  // Not near fire: no change
  const e1 = heatEgg(egg, 30, false);
  check('heatEgg: no heat without fire', e1.heatS === 0);
  check('heatEgg: not hatched without fire', e1.hatched === false);

  // Near fire: accumulates
  const e2 = heatEgg(e1, 60, true);
  check('heatEgg: 60 s near fire → heatS=60', e2.heatS === 60);
  check('heatEgg: not hatched at 60 s', e2.hatched === false);

  // Away from fire: no change to heatS
  const e3 = heatEgg(e2, 30, false);
  check('heatEgg: fire breaks do not drain heatS', e3.heatS === 60);
}

// ---------------------------------------------------------------------------
// 12. heatEgg — hatch at boundary exactly 120 s
// ---------------------------------------------------------------------------

{
  const egg: EggState = { species: 'griffin', heatS: 110, hatched: false };

  // 9 s more → 119 s: not yet hatched
  const e1 = heatEgg(egg, 9, true);
  check('heatEgg: 119 s not hatched', e1.hatched === false,
    `heatS=${e1.heatS}`);

  // 1 s more → exactly 120 s: hatched
  const e2 = heatEgg(e1, 1, true);
  check('heatEgg: exactly 120 s hatched', e2.hatched === true,
    `heatS=${e2.heatS}`);
  check('heatEgg: heatS == 120', e2.heatS === EGG_HATCH_S);
}

// ---------------------------------------------------------------------------
// 13. heatEgg — idempotent after hatch
// ---------------------------------------------------------------------------

{
  const egg: EggState = { species: 'bird', heatS: 120, hatched: true };

  const e1 = heatEgg(egg, 60, true);
  check('heatEgg idempotent: hatched stays true', e1.hatched === true);
  check('heatEgg idempotent: heatS stays 120',    e1.heatS === 120);
}

// ---------------------------------------------------------------------------
// 14. growBaby — age advances; adult at GROWTH_S
// ---------------------------------------------------------------------------

{
  const g: GrowthState = { species: 'dragon', ageS: 0, adult: false };

  const g1 = growBaby(g, 600);
  check('growBaby: 600 s ageS=600', g1.ageS === 600);
  check('growBaby: not adult at 600 s', g1.adult === false);

  const g2 = growBaby(g1, 600);
  check('growBaby: 600+600=1200 → adult', g2.adult === true);
  check('growBaby: ageS == 1200', g2.ageS === GROWTH_S);
}

// ---------------------------------------------------------------------------
// 15. growBaby — clamps at GROWTH_S (overshoot)
// ---------------------------------------------------------------------------

{
  const g: GrowthState = { species: 'griffin', ageS: 1100, adult: false };
  const g1 = growBaby(g, 200);
  check('growBaby clamp: ageS == 1200 not 1300', g1.ageS === GROWTH_S);
  check('growBaby clamp: adult == true', g1.adult === true);
}

// ---------------------------------------------------------------------------
// 16. growBaby — no change when already adult
// ---------------------------------------------------------------------------

{
  const g: GrowthState = { species: 'horse', ageS: 1200, adult: true };
  const g1 = growBaby(g, 999);
  check('growBaby: no change when adult', g1.ageS === 1200 && g1.adult === true);
}

// ---------------------------------------------------------------------------
// 17. feedBaby — favorite food advances ageS by FEED_GROWTH_BONUS_S
// ---------------------------------------------------------------------------

{
  const g: GrowthState = { species: 'dragon', ageS: 0, adult: false };

  const { accepted: ok1, state: g1 } = feedBaby(g, 'dragon', 'meat_cooked');
  check('feedBaby dragon meat_cooked accepted', ok1 === true);
  check('feedBaby: ageS += 60', g1.ageS === FEED_GROWTH_BONUS_S,
    `ageS=${g1.ageS}`);

  // Wrong food
  const { accepted: ok2, state: g2 } = feedBaby(g, 'dragon', 'flax');
  check('feedBaby wrong food rejected', ok2 === false);
  check('feedBaby wrong food: ageS unchanged', g2.ageS === 0);
}

// ---------------------------------------------------------------------------
// 18. feedBaby — clamp at GROWTH_S; adult set
// ---------------------------------------------------------------------------

{
  const g: GrowthState = { species: 'griffin', ageS: 1180, adult: false };
  const { accepted, state } = feedBaby(g, 'griffin', 'meat_raw');
  check('feedBaby near-adult accepted', accepted === true);
  check('feedBaby clamp at 1200', state.ageS === GROWTH_S, `ageS=${state.ageS}`);
  check('feedBaby: adult set when clamped', state.adult === true);
}

// ---------------------------------------------------------------------------
// 19. feedBaby — no-op when already adult
// ---------------------------------------------------------------------------

{
  const g: GrowthState = { species: 'horse', ageS: 1200, adult: true };
  const { accepted, state } = feedBaby(g, 'horse', 'healing_herb');
  check('feedBaby: rejected when already adult', accepted === false);
  check('feedBaby: ageS unchanged when adult', state.ageS === 1200);
}

// ---------------------------------------------------------------------------
// 20. eggSpeciesFor — all mappings + null
// ---------------------------------------------------------------------------

check('eggSpeciesFor egg_bird → bird',       eggSpeciesFor('egg_bird')    === 'bird');
check('eggSpeciesFor egg_dragon → dragon',   eggSpeciesFor('egg_dragon')  === 'dragon');
check('eggSpeciesFor egg_griffin → griffin', eggSpeciesFor('egg_griffin') === 'griffin');
check('eggSpeciesFor unknown → null',        eggSpeciesFor('egg_cow')     === null);
check('eggSpeciesFor empty → null',          eggSpeciesFor('')            === null);
check('eggSpeciesFor dragon (no prefix) → null', eggSpeciesFor('dragon') === null);

// ---------------------------------------------------------------------------
// 21. Serialize / deserialize round-trip
// ---------------------------------------------------------------------------

{
  const reg: TamingRegistry = {
    tamed: {
      'e-1': { temper: 45, tamed: false },
      'e-2': { temper: 80, tamed: true },
    },
    eggs: {
      'egg-a': { species: 'dragon', heatS: 75.5, hatched: false, x: 10, z: -20 },
    },
    babies: {
      'baby-1': { species: 'griffin', ageS: 600, adult: false, x: 5, z: 5 },
    },
  };

  const json = serializeTamingRegistry(reg);
  const restored = deserializeTamingRegistry(json);
  check('round-trip: not null', restored !== null);
  check('round-trip: JSON matches', JSON.stringify(restored) === JSON.stringify(reg));
}

// Empty registry round-trip
{
  const empty: TamingRegistry = { tamed: {}, eggs: {}, babies: {} };
  const r = deserializeTamingRegistry(serializeTamingRegistry(empty));
  check('empty registry round-trip', r !== null && JSON.stringify(r) === JSON.stringify(empty));
}

// ---------------------------------------------------------------------------
// 22. deserializeTamingRegistry — rejects malformed / invalid inputs
// ---------------------------------------------------------------------------

check('rejects malformed JSON',    deserializeTamingRegistry('{nope') === null);
check('rejects empty string',      deserializeTamingRegistry('') === null);
check('rejects null JSON',         deserializeTamingRegistry('null') === null);
check('rejects array',             deserializeTamingRegistry('[]') === null);

// temper NaN
{
  const bad = { tamed: { x: { temper: NaN, tamed: false } }, eggs: {}, babies: {} };
  check('rejects temper NaN', deserializeTamingRegistry(JSON.stringify(bad)) === null);
}

// temper > 100
{
  const bad = { tamed: { x: { temper: 101, tamed: false } }, eggs: {}, babies: {} };
  check('rejects temper > 100', deserializeTamingRegistry(JSON.stringify(bad)) === null);
}

// unknown egg species
{
  const bad = {
    tamed: {},
    eggs: { 'e': { species: 'unicorn', heatS: 0, hatched: false, x: 0, z: 0 } },
    babies: {},
  };
  check('rejects unknown egg species', deserializeTamingRegistry(JSON.stringify(bad)) === null);
}

// heatS negative
{
  const bad = {
    tamed: {},
    eggs: { 'e': { species: 'dragon', heatS: -1, hatched: false, x: 0, z: 0 } },
    babies: {},
  };
  check('rejects heatS negative', deserializeTamingRegistry(JSON.stringify(bad)) === null);
}

// non-object top-level (string)
check('rejects non-object (string)', deserializeTamingRegistry('"hello"') === null);

// unknown baby species
{
  const bad = {
    tamed: {},
    eggs: {},
    babies: { 'b': { species: 'unicorn', ageS: 0, adult: false, x: 0, z: 0 } },
  };
  check('rejects unknown baby species', deserializeTamingRegistry(JSON.stringify(bad)) === null);
}

// ---------------------------------------------------------------------------
// 23. FNV-32 golden — fixed taming scenario
//
// Scenario:
//  A. Dragon: 10 feed attempts with meat_cooked (temper 0 → 80 on 10th: 10×8=80).
//  B. Griffin: 5 feeds (temper 0 → 40, not yet tamed).
//  C. Dragon egg: heat 60 s (not hatched); then 70 more s → hatched.
//  D. Baby griffin: grow 300 s; feed once (meat_raw) → +60 → 360 s.
//  E. Snapshot the combined state as JSON; FNV hash it.
// ---------------------------------------------------------------------------

function runGoldenScenario(): object {
  // A. Dragon taming via feeding
  let dragon = createTamedState();
  for (let i = 0; i < 10; i++) {
    const r = feed(dragon, 'dragon', 'meat_cooked');
    dragon   = r.state;
  }

  // B. Griffin partial taming via feeding
  let griffin = createTamedState();
  for (let i = 0; i < 5; i++) {
    const r = feed(griffin, 'griffin', 'meat_raw');
    griffin  = r.state;
  }

  // C. Dragon egg incubation
  let egg: EggState = { species: 'dragon', heatS: 0, hatched: false };
  egg = heatEgg(egg, 60, true);   // 60 s near fire
  egg = heatEgg(egg, 30, false);  // 30 s away — no change
  egg = heatEgg(egg, 70, true);   // 70 s near fire → total 130 s → hatched (clamped to 120)

  // D. Baby griffin growth + one feed
  let baby: GrowthState = { species: 'griffin', ageS: 0, adult: false };
  baby = growBaby(baby, 300);
  const fedResult = feedBaby(baby, 'griffin', 'meat_raw');
  baby = fedResult.state;

  return { dragon, griffin, egg, baby };
}

const goldenObj  = runGoldenScenario();
const goldenJson = JSON.stringify(goldenObj);
const goldenHash = fnv32a(goldenJson);
const GOLDEN_HASH = 0xbdf6783a; // baked

check(
  `FNV-32 golden hash == 0x${GOLDEN_HASH.toString(16).padStart(8, '0')}`,
  goldenHash === GOLDEN_HASH,
  `got 0x${goldenHash.toString(16).padStart(8, '0')} — json: ${goldenJson}`,
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
