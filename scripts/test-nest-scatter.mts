/**
 * Pure unit tests for nest-scatter.ts.
 * Run: npx tsx scripts/test-nest-scatter.mts
 *
 * Covers: determinism, biome gating, height gating, rarity sanity,
 *         id format, nestEggItem mapping, FNV-1a-32 golden.
 */

import { nestsForCell, nestEggItem, type NestSite, type NestKind } from '../src/game/entities/nest-scatter';
import { ECELL } from '../src/game/entities/entity-types';
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

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SEED = 1337;
const hf = createHeightField(SEED);
const bf = createBiomeField(SEED, hf);
const heightAt = (x: number, z: number) => hf.heightAt(x, z);
const biomeAt  = (x: number, z: number) => bf.biomeAt(x, z);

const BIRD_BIOMES    = new Set<Biome>(['forest', 'dense_forest', 'jungle', 'mountain_forest']);
const DRAGON_BIOMES  = new Set<Biome>(['alpine', 'mountain_forest']);
const GRIFFIN_BIOMES = new Set<Biome>(['alpine']);

const KIND_BIOMES: Record<NestKind, Set<Biome>> = {
  bird:    BIRD_BIOMES,
  dragon:  DRAGON_BIOMES,
  griffin: GRIFFIN_BIOMES,
};

// ---------------------------------------------------------------------------
// 1. ECELL constant
// ---------------------------------------------------------------------------

check('ECELL is 512', ECELL === 512);

// ---------------------------------------------------------------------------
// 2. nestEggItem mapping
// ---------------------------------------------------------------------------

check('nestEggItem(bird) === egg_bird',       nestEggItem('bird')    === 'egg_bird');
check('nestEggItem(dragon) === egg_dragon',   nestEggItem('dragon')  === 'egg_dragon');
check('nestEggItem(griffin) === egg_griffin', nestEggItem('griffin') === 'egg_griffin');

// ---------------------------------------------------------------------------
// 3. Determinism: same seed+cell → identical arrays (two independent calls)
// ---------------------------------------------------------------------------

{
  for (const [cx, cz] of [[-3, 2], [0, 0], [5, -1], [10, 10]] as [number, number][]) {
    const a = nestsForCell(SEED, cx, cz, heightAt, biomeAt);
    const b = nestsForCell(SEED, cx, cz, heightAt, biomeAt);
    const match = JSON.stringify(a) === JSON.stringify(b);
    check(`determinism cell (${cx},${cz})`, match,
      `a.length=${a.length} b.length=${b.length}`);
  }
}

// ---------------------------------------------------------------------------
// 4. Different seeds → different results (for non-empty cells)
// ---------------------------------------------------------------------------

{
  // Run 20 cells until we find one that produces nests under SEED.
  let foundDiff = false;
  outer:
  for (let cx = -5; cx <= 5; cx++) {
    for (let cz = -5; cz <= 5; cz++) {
      const a = nestsForCell(SEED,      cx, cz, heightAt, biomeAt);
      const b = nestsForCell(SEED + 1,  cx, cz, heightAt, biomeAt);
      if (a.length > 0 || b.length > 0) {
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          foundDiff = true;
          break outer;
        }
      }
    }
  }
  check('different seeds produce different results', foundDiff);
}

// ---------------------------------------------------------------------------
// 5. Biome gating: every nest's biomeAt matches its kind's allowed set
// ---------------------------------------------------------------------------

{
  let allBiomesOk = true;
  for (let cx = -6; cx <= 6; cx++) {
    for (let cz = -6; cz <= 6; cz++) {
      const nests = nestsForCell(SEED, cx, cz, heightAt, biomeAt);
      for (const n of nests) {
        const biome = biomeAt(n.x, n.z);
        if (!KIND_BIOMES[n.kind].has(biome)) {
          allBiomesOk = false;
          console.error(`  Biome mismatch: ${n.id} kind=${n.kind} biome=${biome}`);
        }
      }
    }
  }
  check('all nest biomes match kind gate', allBiomesOk);
}

// ---------------------------------------------------------------------------
// 6. Height gating: every nest has y > 1
// ---------------------------------------------------------------------------

{
  let allHeightsOk = true;
  for (let cx = -6; cx <= 6; cx++) {
    for (let cz = -6; cz <= 6; cz++) {
      const nests = nestsForCell(SEED, cx, cz, heightAt, biomeAt);
      for (const n of nests) {
        if (n.y <= 1) {
          allHeightsOk = false;
          console.error(`  Height violation: ${n.id} y=${n.y}`);
        }
      }
    }
  }
  check('all nests have y > 1 (dry land)', allHeightsOk);
}

// ---------------------------------------------------------------------------
// 7. y == heightAt(x, z) for every nest
// ---------------------------------------------------------------------------

{
  let allYOk = true;
  for (let cx = -3; cx <= 3; cx++) {
    for (let cz = -3; cz <= 3; cz++) {
      const nests = nestsForCell(SEED, cx, cz, heightAt, biomeAt);
      for (const n of nests) {
        const expected = heightAt(n.x, n.z);
        if (Math.abs(n.y - expected) > 1e-9) {
          allYOk = false;
          console.error(`  y mismatch: ${n.id} n.y=${n.y} expected=${expected}`);
        }
      }
    }
  }
  check('nest.y === heightAt(x,z) for all nests', allYOk);
}

// ---------------------------------------------------------------------------
// 8. id format: nest_<kind>_<cx>_<cz>_<k>
// ---------------------------------------------------------------------------

{
  const ID_RE = /^nest_(bird|dragon|griffin)_(-?\d+)_(-?\d+)_(\d+)$/;
  let allIdsOk = true;
  for (let cx = -6; cx <= 6; cx++) {
    for (let cz = -6; cz <= 6; cz++) {
      const nests = nestsForCell(SEED, cx, cz, heightAt, biomeAt);
      for (const n of nests) {
        if (!ID_RE.test(n.id)) {
          allIdsOk = false;
          console.error(`  Bad id format: "${n.id}"`);
        }
        // id encodes correct kind and cell coords
        const m = ID_RE.exec(n.id)!;
        if (m[1] !== n.kind || Number(m[2]) !== cx || Number(m[3]) !== cz) {
          allIdsOk = false;
          console.error(`  Id/field mismatch: ${n.id} kind=${n.kind} cx=${cx} cz=${cz}`);
        }
      }
    }
  }
  check('all nest ids match format and encode correct kind+cell', allIdsOk);
}

// ---------------------------------------------------------------------------
// 9. id uniqueness within a sweep (no duplicates across all cells -6..6)
// ---------------------------------------------------------------------------

{
  const allIds: string[] = [];
  for (let cx = -6; cx <= 6; cx++) {
    for (let cz = -6; cz <= 6; cz++) {
      const nests = nestsForCell(SEED, cx, cz, heightAt, biomeAt);
      for (const n of nests) allIds.push(n.id);
    }
  }
  const uniqueIds = new Set(allIds);
  check('all nest ids unique across -6..6 sweep',
    uniqueIds.size === allIds.length,
    `total=${allIds.length} unique=${uniqueIds.size}`);
}

// ---------------------------------------------------------------------------
// 10. Rarity sanity over 400-cell sweep (20×20)
// ---------------------------------------------------------------------------

{
  let birdCount = 0;
  let dragonCount = 0;
  let griffinCount = 0;

  for (let cx = -10; cx < 10; cx++) {
    for (let cz = -10; cz < 10; cz++) {
      const nests = nestsForCell(SEED, cx, cz, heightAt, biomeAt);
      for (const n of nests) {
        if (n.kind === 'bird')    birdCount++;
        if (n.kind === 'dragon')  dragonCount++;
        if (n.kind === 'griffin') griffinCount++;
      }
    }
  }

  console.log(`  Rarity sweep (400 cells): bird=${birdCount} dragon=${dragonCount} griffin=${griffinCount}`);

  check('bird nests noticeably more common than dragon across 400 cells',
    birdCount > dragonCount * 2,
    `bird=${birdCount} dragon=${dragonCount}`);
  check('bird nests noticeably more common than griffin across 400 cells',
    birdCount > griffinCount * 2,
    `bird=${birdCount} griffin=${griffinCount}`);
  check('dragon nests appear at least once across 400 cells',
    dragonCount > 0,
    `dragon=${dragonCount}`);
  check('griffin nests appear at least once across 400 cells',
    griffinCount > 0,
    `griffin=${griffinCount}`);
  check('bird nests appear at least once across 400 cells',
    birdCount > 0,
    `bird=${birdCount}`);
}

// ---------------------------------------------------------------------------
// 11. nestsForCell returns an array (never null/undefined)
// ---------------------------------------------------------------------------

{
  const result = nestsForCell(SEED, 999, 999, heightAt, biomeAt);
  check('nestsForCell always returns an array', Array.isArray(result));
}

// ---------------------------------------------------------------------------
// 12. Empty cell returns [] not error
// ---------------------------------------------------------------------------

{
  // Test many cells — even if all return empty, no exception thrown.
  let threw = false;
  try {
    for (let cx = 100; cx < 110; cx++) {
      for (let cz = 100; cz < 110; cz++) {
        nestsForCell(SEED, cx, cz, heightAt, biomeAt);
      }
    }
  } catch (e) {
    threw = true;
    console.error('  Exception in nestsForCell:', e);
  }
  check('nestsForCell never throws', !threw);
}

// ---------------------------------------------------------------------------
// 13. x coordinate is within cell bounds [cx*ECELL, (cx+1)*ECELL)
// ---------------------------------------------------------------------------

{
  let allInBounds = true;
  for (let cx = -6; cx <= 6; cx++) {
    for (let cz = -6; cz <= 6; cz++) {
      const nests = nestsForCell(SEED, cx, cz, heightAt, biomeAt);
      for (const n of nests) {
        const xOk = n.x >= cx * ECELL && n.x < (cx + 1) * ECELL;
        const zOk = n.z >= cz * ECELL && n.z < (cz + 1) * ECELL;
        if (!xOk || !zOk) {
          allInBounds = false;
          console.error(`  Out of cell bounds: ${n.id} x=${n.x} z=${n.z} cx=${cx} cz=${cz}`);
        }
      }
    }
  }
  check('all nest positions lie within their cell bounds', allInBounds);
}

// ---------------------------------------------------------------------------
// 14. Per-cell nest count never exceeds 2 (max is 2 bird nests)
// ---------------------------------------------------------------------------

{
  let allCountsOk = true;
  for (let cx = -6; cx <= 6; cx++) {
    for (let cz = -6; cz <= 6; cz++) {
      const nests = nestsForCell(SEED, cx, cz, heightAt, biomeAt);
      const byKind: Record<string, number> = {};
      for (const n of nests) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
      for (const [kind, cnt] of Object.entries(byKind)) {
        const maxExpected = kind === 'bird' ? 2 : 1;
        if (cnt > maxExpected) {
          allCountsOk = false;
          console.error(`  Too many ${kind} nests in (${cx},${cz}): ${cnt}`);
        }
      }
    }
  }
  check('nest count per kind per cell does not exceed maximum', allCountsOk);
}

// ---------------------------------------------------------------------------
// 15. NestSite fields are finite numbers
// ---------------------------------------------------------------------------

{
  let allFinite = true;
  for (let cx = -3; cx <= 3; cx++) {
    for (let cz = -3; cz <= 3; cz++) {
      const nests = nestsForCell(SEED, cx, cz, heightAt, biomeAt);
      for (const n of nests) {
        if (!isFinite(n.x) || !isFinite(n.y) || !isFinite(n.z)) {
          allFinite = false;
          console.error(`  Non-finite coord: ${n.id} x=${n.x} y=${n.y} z=${n.z}`);
        }
      }
    }
  }
  check('all NestSite x/y/z are finite numbers', allFinite);
}

// ---------------------------------------------------------------------------
// 16. Kinds are exactly the three expected strings
// ---------------------------------------------------------------------------

{
  const validKinds = new Set<string>(['bird', 'dragon', 'griffin']);
  let allKindsOk = true;
  for (let cx = -6; cx <= 6; cx++) {
    for (let cz = -6; cz <= 6; cz++) {
      const nests = nestsForCell(SEED, cx, cz, heightAt, biomeAt);
      for (const n of nests) {
        if (!validKinds.has(n.kind)) {
          allKindsOk = false;
          console.error(`  Unknown kind "${n.kind}" in ${n.id}`);
        }
      }
    }
  }
  check('all nest kinds are bird|dragon|griffin', allKindsOk);
}

// ---------------------------------------------------------------------------
// 17. Independence of kinds: presence of bird nest does not force dragon nest
// ---------------------------------------------------------------------------

{
  // Find a cell that has bird nests but no dragon/griffin.
  let foundBirdOnly = false;
  for (let cx = -10; cx <= 10 && !foundBirdOnly; cx++) {
    for (let cz = -10; cz <= 10 && !foundBirdOnly; cz++) {
      const nests = nestsForCell(SEED, cx, cz, heightAt, biomeAt);
      const hasBird    = nests.some(n => n.kind === 'bird');
      const hasDragon  = nests.some(n => n.kind === 'dragon');
      const hasGriffin = nests.some(n => n.kind === 'griffin');
      if (hasBird && !hasDragon && !hasGriffin) foundBirdOnly = true;
    }
  }
  check('bird-only cells exist (kinds are independent)', foundBirdOnly);
}

// ---------------------------------------------------------------------------
// 18. FNV-1a-32 golden over canonical snapshot: cells -6..6, seed 1337
// ---------------------------------------------------------------------------

{
  // Build snapshot: for each cell in row-major order, append all NestSite fields.
  const parts: string[] = [];
  for (let cx = -6; cx <= 6; cx++) {
    for (let cz = -6; cz <= 6; cz++) {
      const nests = nestsForCell(SEED, cx, cz, heightAt, biomeAt);
      for (const n of nests) {
        parts.push(`${n.id}:${n.kind}:${n.x.toFixed(6)}:${n.y.toFixed(6)}:${n.z.toFixed(6)}`);
      }
    }
  }
  const snap = parts.join('|');
  const h = fnv32a(snap);

  // Run a second time to confirm determinism of the hash itself.
  const parts2: string[] = [];
  for (let cx = -6; cx <= 6; cx++) {
    for (let cz = -6; cz <= 6; cz++) {
      const nests2 = nestsForCell(SEED, cx, cz, heightAt, biomeAt);
      for (const n of nests2) {
        parts2.push(`${n.id}:${n.kind}:${n.x.toFixed(6)}:${n.y.toFixed(6)}:${n.z.toFixed(6)}`);
      }
    }
  }
  const snap2 = parts2.join('|');
  const h2 = fnv32a(snap2);

  check('FNV golden: two identical sweeps produce identical hash', h === h2,
    `h=0x${h.toString(16)} h2=0x${h2.toString(16)}`);

  // Print hash for hard-coding (visible only on first run before baking).
  console.log(`  FNV-1a-32 golden hash: 0x${h.toString(16).padStart(8, '0')} (snap length=${snap.length})`);

  // Hard-coded golden — baked after first passing run.
  const GOLDEN = 0x9ffa3662;
  check('FNV golden matches baked constant',
    h === GOLDEN,
    `got=0x${h.toString(16).padStart(8, '0')} want=0x${GOLDEN.toString(16).padStart(8, '0')}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
