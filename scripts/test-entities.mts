/**
 * Tests for the animal/creature entity system.
 * Run: npx tsx scripts/test-entities.mts
 *
 * Covers: entity-types.ts, animal-drops.ts, entity-scatter.ts
 * Harness pattern matches test-vitals.mts: check() + FNV-1a-32 golden.
 */

import { SPECIES_DEFS, DRAGON_FLIGHT_ENABLED, ECELL, type Species } from '../src/game/entities/entity-types';
import { DROP_TABLE, rollDrops } from '../src/game/entities/animal-drops';
import { entitiesForCell } from '../src/game/entities/entity-scatter';
import { ITEM_DEFS } from '../src/game/items';
import { createHeightField } from '../src/game/noise';
import { createBiomeField, type Biome } from '../src/game/biome';

// ---------------------------------------------------------------------------
// Harness
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

function fnv32a(str: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Mulberry32 for use in rollDrops tests. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const SEED = 1337;
const hf = createHeightField(SEED);
const bf = createBiomeField(SEED, hf);
const heightAt = (x: number, z: number) => hf.heightAt(x, z);
const biomeAt  = (x: number, z: number) => bf.biomeAt(x, z);

const ALL_SPECIES = Object.keys(SPECIES_DEFS) as Species[];
const ALL_BIOMES: Biome[] = [
  'ocean', 'beach', 'desert', 'plains', 'forest',
  'dense_forest', 'jungle', 'mountain_forest', 'alpine',
];
const ALL_ITEM_IDS = new Set(Object.keys(ITEM_DEFS));

// ---------------------------------------------------------------------------
// 1. SPECIES_DEFS — structural checks
// ---------------------------------------------------------------------------

{
  // Twelve overworld creatures plus the four dungeon enemies. The enemies
  // carry `biomes: []` so they can never leak into the overworld — asserted
  // separately below rather than assumed from this list.
  const expectedAll: Species[] = [
    'rabbit', 'deer', 'bird', 'horse', 'cow',
    'donkey', 'wolf', 'bear', 'dragon', 'wyvern', 'griffin', 'sea_serpent',
    'goblin', 'goblin_archer', 'skeleton', 'dread_king',
    // The final boss and his mount. Both are `biomes: []`, `rare: false` and
    // `mountable: false` — placed by the castle script, never scattered and
    // never ridden by the player — so the three counts below are unchanged.
    'evil_king', 'black_dragon',
  ];
  check(
    'SPECIES_DEFS has exactly 18 species',
    ALL_SPECIES.length === expectedAll.length &&
      expectedAll.every((s) => s in SPECIES_DEFS),
    `got ${ALL_SPECIES.length}: ${ALL_SPECIES.join(', ')}`,
  );
}

{
  const rares = ALL_SPECIES.filter((s) => SPECIES_DEFS[s].rare);
  check(
    'Rare species are exactly dragon, wyvern, griffin, sea_serpent',
    rares.length === 4 &&
      rares.includes('dragon') &&
      rares.includes('wyvern') &&
      rares.includes('griffin') &&
      rares.includes('sea_serpent'),
    `got: ${rares.join(', ')}`,
  );
}

{
  const mountables = ALL_SPECIES.filter((s) => SPECIES_DEFS[s].mountable);
  const expected = ['horse', 'cow', 'donkey', 'dragon', 'wyvern', 'griffin'] as Species[];
  check(
    'Mountable species are exactly horse, cow, donkey, dragon, wyvern, griffin',
    mountables.length === 6 && expected.every((s) => mountables.includes(s)),
    `got: ${mountables.join(', ')}`,
  );
}

{
  let allValid = true;
  for (const s of ALL_SPECIES) {
    for (const b of SPECIES_DEFS[s].biomes) {
      if (!ALL_BIOMES.includes(b)) {
        allValid = false;
        console.error(`  ${s} has invalid biome: ${b}`);
      }
    }
  }
  check('Every biomes[] entry is a valid Biome', allValid);
}

{
  let allValid = true;
  for (const s of ALL_SPECIES) {
    const food = SPECIES_DEFS[s].favoriteFood;
    if (food !== undefined && !ALL_ITEM_IDS.has(food)) {
      allValid = false;
      console.error(`  ${s}.favoriteFood '${food}' is not a valid GameItemId`);
    }
  }
  check('Every favoriteFood is a valid GameItemId', allValid);
}

check('DRAGON_FLIGHT_ENABLED is true (demo flight)', DRAGON_FLIGHT_ENABLED === true);
check('ECELL is 512', ECELL === 512);

// ---------------------------------------------------------------------------
// 2. DROP_TABLE — structural checks
// ---------------------------------------------------------------------------

{
  let allPresent = true;
  for (const s of ALL_SPECIES) {
    if (!(s in DROP_TABLE) || DROP_TABLE[s].length === 0) {
      allPresent = false;
      console.error(`  Missing or empty drop table for: ${s}`);
    }
  }
  check('Every species has at least one drop entry', allPresent);
}

{
  let allValid = true;
  for (const s of ALL_SPECIES) {
    for (const row of DROP_TABLE[s]) {
      if (!ALL_ITEM_IDS.has(row.id)) {
        allValid = false;
        console.error(`  ${s} drop '${row.id}' is not a valid GameItemId`);
      }
      if (row.min > row.max) {
        allValid = false;
        console.error(`  ${s} drop '${row.id}': min(${row.min}) > max(${row.max})`);
      }
      if (row.chance <= 0 || row.chance > 1) {
        allValid = false;
        console.error(`  ${s} drop '${row.id}': chance(${row.chance}) out of (0,1]`);
      }
    }
  }
  check('All drop rows: valid id, min<=max, 0<chance<=1', allValid);
}

// ---------------------------------------------------------------------------
// 3. rollDrops — determinism and correctness
// ---------------------------------------------------------------------------

{
  // Determinism: two calls with same seed produce identical output.
  const rng1 = mulberry32(0xdeadbeef);
  const rng2 = mulberry32(0xdeadbeef);
  const d1 = rollDrops('deer', rng1);
  const d2 = rollDrops('deer', rng2);
  check(
    'rollDrops determinism (deer)',
    JSON.stringify(d1) === JSON.stringify(d2),
  );
}

{
  // Guaranteed drops (chance 1.0) always present.
  for (let i = 0; i < 200; i++) {
    const rng = mulberry32(i * 7 + 1);
    const drops = rollDrops('rabbit', rng);
    const ids = drops.map((d) => d.id);
    if (!ids.includes('hide') || !ids.includes('meat_raw')) {
      check(`rabbit guaranteed drops present (seed ${i})`, false, `got: ${ids.join(', ')}`);
      break;
    }
  }
  check('Guaranteed drops (rabbit hide+meat_raw) always present over 200 rolls', true);
}

{
  // Counts are within [min, max] over 200 rolls.
  let ok = true;
  for (let i = 0; i < 200; i++) {
    const rng = mulberry32(i * 13 + 2);
    const drops = rollDrops('sea_serpent', rng);
    for (const d of drops) {
      const row = DROP_TABLE['sea_serpent'].find((r) => r.id === d.id)!;
      if (d.count < row.min || d.count > row.max) {
        ok = false;
        console.error(`  sea_serpent '${d.id}' count ${d.count} outside [${row.min},${row.max}]`);
      }
    }
  }
  check('sea_serpent drop counts within [min,max] over 200 rolls', ok);
}

{
  // Chance-gated drop (bird egg_bird @0.25) appears at plausible rate.
  let eggCount = 0;
  const TRIALS = 500;
  for (let i = 0; i < TRIALS; i++) {
    const rng = mulberry32(i * 31 + 5);
    const drops = rollDrops('bird', rng);
    if (drops.some((d) => d.id === 'egg_bird')) eggCount++;
  }
  const rate = eggCount / TRIALS;
  check(
    `bird egg_bird rate between 15% and 35% over ${TRIALS} rolls`,
    rate >= 0.15 && rate <= 0.35,
    `got ${(rate * 100).toFixed(1)}%`,
  );
}

{
  // dragon egg_dragon @0.15 — plausible rate over 500 rolls.
  let count = 0;
  const TRIALS = 500;
  for (let i = 0; i < TRIALS; i++) {
    const rng = mulberry32(i * 17 + 3);
    const drops = rollDrops('dragon', rng);
    if (drops.some((d) => d.id === 'egg_dragon')) count++;
  }
  const rate = count / TRIALS;
  check(
    `dragon egg_dragon rate between 8% and 25% over ${TRIALS} rolls`,
    rate >= 0.08 && rate <= 0.25,
    `got ${(rate * 100).toFixed(1)}%`,
  );
}

// ---------------------------------------------------------------------------
// 4. entitiesForCell — determinism and structural checks
// ---------------------------------------------------------------------------

{
  // Determinism: two independent calls must be deep-equal.
  const a = entitiesForCell(SEED, 3, 5, heightAt, biomeAt);
  const b = entitiesForCell(SEED, 3, 5, heightAt, biomeAt);
  check(
    'entitiesForCell determinism (cx=3, cz=5)',
    JSON.stringify(a) === JSON.stringify(b),
  );
}

{
  // Id format: all ids match "cx,cz:eN" and are in ascending order.
  const spawns = entitiesForCell(SEED, 1, 2, heightAt, biomeAt);
  let ok = true;
  for (let i = 0; i < spawns.length; i++) {
    const expected = `1,2:e${i}`;
    if (spawns[i].id !== expected) {
      ok = false;
      console.error(`  id[${i}] expected '${expected}' got '${spawns[i].id}'`);
    }
  }
  check('entitiesForCell id format and stable ordering (cx=1,cz=2)', ok);
}

{
  // All common (non-water) spawns are on land h>=1.
  let ok = true;
  for (let cx = -2; cx <= 2; cx++) {
    for (let cz = -2; cz <= 2; cz++) {
      const spawns = entitiesForCell(SEED, cx, cz, heightAt, biomeAt);
      for (const sp of spawns) {
        const def = SPECIES_DEFS[sp.species];
        const h = heightAt(sp.x, sp.z);
        if (def.water) {
          if (h >= -8) {
            ok = false;
            console.error(`  water species ${sp.species} at h=${h.toFixed(1)} (expected <-8)`);
          }
        } else {
          if (h < 1) {
            ok = false;
            console.error(`  land species ${sp.species} at h=${h.toFixed(1)} (expected >=1)`);
          }
        }
      }
    }
  }
  check('All spawns satisfy h>=1 (land) or h<-8 (water) in 5x5 cell grid', ok);
}

{
  // Species are valid — every spawned species is a known key.
  const spawns = entitiesForCell(SEED, 0, 0, heightAt, biomeAt);
  let ok = true;
  for (const sp of spawns) {
    if (!(sp.species in SPECIES_DEFS)) {
      ok = false;
      console.error(`  unknown species: ${sp.species}`);
    }
  }
  check('All spawned species are valid Species keys', ok);
}

// ---------------------------------------------------------------------------
// 5. Rare frequency — 24x24 cell grid
// ---------------------------------------------------------------------------

{
  const GRID = 24;
  let rareCells = 0;
  const totalCells = GRID * GRID;

  for (let cx = 0; cx < GRID; cx++) {
    for (let cz = 0; cz < GRID; cz++) {
      const spawns = entitiesForCell(SEED, cx, cz, heightAt, biomeAt);
      if (spawns.some((sp) => SPECIES_DEFS[sp.species].rare)) {
        rareCells++;
      }
    }
  }

  const rareFraction = rareCells / totalCells;
  check(
    'Rare spawns exist in 24x24 grid (> 0 cells)',
    rareCells > 0,
    `rareCells=${rareCells}`,
  );
  check(
    `Rare cell fraction < 5% (got ${(rareFraction * 100).toFixed(2)}%)`,
    rareFraction < 0.05,
    `rareCells=${rareCells}/${totalCells}`,
  );

  console.log(
    `  Rare-cell info: ${rareCells}/${totalCells} cells = ${(rareFraction * 100).toFixed(2)}%`,
  );
}

// ---------------------------------------------------------------------------
// 6. FNV-1a-32 golden — 3x3 cells around origin, seed 1337
// ---------------------------------------------------------------------------

{
  const cells: ReturnType<typeof entitiesForCell>[] = [];
  for (let cx = -1; cx <= 1; cx++) {
    for (let cz = -1; cz <= 1; cz++) {
      cells.push(entitiesForCell(SEED, cx, cz, heightAt, biomeAt));
    }
  }

  const goldenJson = JSON.stringify(cells);
  const goldenHash = fnv32a(goldenJson);

  // Baked hash (computed on first run, then hardcoded):
  // Rebaselined for the spawn-density pass: 7–11 groups of 2–5 (was 2–5 of
  // 1–3), plus anchors now retry up to 5 times to find land instead of being
  // dropped when they fall in water. Measured effect on a player standing on
  // land: animals within 100 m 0.93 -> 3.30, median nearest 146 m -> 64 m.
  // Previous: 0x7d751885 (wolf/bear biome expansion).
  const GOLDEN_HASH = 0x7931ab44;

  check(
    `FNV-32 golden hash == 0x${GOLDEN_HASH.toString(16).padStart(8, '0')}`,
    goldenHash === GOLDEN_HASH,
    `got 0x${goldenHash.toString(16).padStart(8, '0')}`,
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
