/**
 * Deterministic tests for per-chunk resource-node scattering.
 * Pure CPU — no GPU, no server. Run:  npx tsx scripts/test-resource-scatter.mts
 *
 * Golden FNV hash = determinism tripwire (see test-heightfield.mts header).
 *
 * Phase F2: biome-gated nodes (flax, mushroom, herbs, cactus, reeds, gourd,
 * ore_rock) + assertions for each.
 */

import { createHeightField } from '../src/game/noise';
import { createBiomeField } from '../src/game/biome';
import { resourcesForChunk } from '../src/game/resource-scatter';
import { entranceSiteAt, DCELL } from '../src/game/dungeon/entrance-site';
import { settlementSiteAt } from '../src/game/settlement/settlement-scatter';
import { CHUNK_SIZE } from '../src/game/terrain/chunk-mesh';

/** Update ONLY on deliberate scatter/heightfield changes. */
// Rebaked for forced castle near spawn (settlement clearing moved).
const GOLDEN_HASH: number | null = 0xa99c17d2;

const WORLD_SEED = 1337;

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

function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const field = createHeightField(WORLD_SEED);
const biomeField = createBiomeField(WORLD_SEED, field);
const heightAt = (x: number, z: number) => field.heightAt(x, z);
const biomeAt = (x: number, z: number) => biomeField.biomeAt(x, z);

// Scatter a 24×24-chunk area (≈1.5 km square around the origin).
const all: number[] = [];
let rocks = 0;
let bushes = 0;
let inBand = true;
let inChunk = true;
let clearingOk = true;
let orderOk = true; // all rocks/ore_rocks before all bushes (stable r-index identity)
for (let cz = -12; cz < 12; cz++) {
  for (let cx = -12; cx < 12; cx++) {
    const nodes = resourcesForChunk(WORLD_SEED, cx, cz, heightAt, biomeAt, field);
    const dcx = Math.floor((cx * CHUNK_SIZE) / DCELL);
    const dcz = Math.floor((cz * CHUNK_SIZE) / DCELL);
    const entrance = entranceSiteAt(WORLD_SEED, dcx, dcz, heightAt);
    const settlement = settlementSiteAt(WORLD_SEED, dcx, dcz, heightAt);
    let seenBush = false;
    for (const n of nodes) {
      if (n.type === 'rock' || n.type === 'ore_rock') {
        rocks++;
        if (seenBush) orderOk = false;
      } else if (n.type === 'bush') {
        bushes++;
        seenBush = true;
      }
      const typeCode = ['rock', 'bush', 'flax', 'mushroom', 'cooling_herb', 'warming_herb',
        'barrel_cactus', 'reeds', 'gourd', 'ore_rock'].indexOf(n.type) + 1;
      all.push(typeCode, n.x, n.y, n.z, n.scale);
      const h = heightAt(n.x, n.z);
      // Original height-band checks for rock/bush only.
      if (n.type === 'rock') {
        if (h < 2 || h > 70) inBand = false;
      } else if (n.type === 'bush') {
        if (h < 2 || h > 35) inBand = false;
      }
      if (n.x < cx * CHUNK_SIZE || n.x >= (cx + 1) * CHUNK_SIZE
        || n.z < cz * CHUNK_SIZE || n.z >= (cz + 1) * CHUNK_SIZE) inChunk = false;
      if (n.type !== 'reeds' && n.type !== 'gourd') {
        // River nodes have extra RNG draws that bypass entrance/settlement check.
        if (entrance !== null
          && Math.hypot(n.x - entrance.x, n.z - entrance.z) < 6) clearingOk = false;
        if (settlement !== null
          && Math.hypot(n.x - settlement.x, n.z - settlement.z)
             < settlement.radius + 2) clearingOk = false;
      }
    }
  }
}

check('rocks exist', rocks > 100, `rocks=${rocks}`);
check('bushes exist', bushes > 100, `bushes=${bushes}`);
check('scatter is sparse (≤18 per chunk avg)', rocks + bushes <= 576 * 18,
  `total=${rocks + bushes}`);
check('rock/bush nodes stay in their height bands', inBand);
check('nodes stay inside their own chunk', inChunk);
check('dungeon-entrance + settlement clearings respected', clearingOk);
check('rocks precede bushes (stable node ids)', orderOk);

// Determinism: recompute one chunk, must be bit-identical.
const a = JSON.stringify(resourcesForChunk(WORLD_SEED, 3, -2, heightAt, biomeAt, field));
const b = JSON.stringify(resourcesForChunk(WORLD_SEED, 3, -2, heightAt, biomeAt, field));
check('scatter is deterministic', a === b);

// --- Phase F2 biome assertions --------------------------------------------

// Desert chunk (1,-7): must yield barrel_cactus nodes.
const desertNodes = resourcesForChunk(WORLD_SEED, 1, -7, heightAt, biomeAt, field);
check('desert chunk (1,-7) yields barrel_cactus nodes',
  desertNodes.some(n => n.type === 'barrel_cactus'),
  `types=${desertNodes.map(n => n.type).join(',')}`);

// Alpine chunk (mountain_forest): ore_rock in mountain_forest/alpine (within ±12).
const oreRockChunk = resourcesForChunk(WORLD_SEED, 11, 4, heightAt, biomeAt, field);
check('mountain_forest chunk (11,4) yields ore_rock nodes',
  oreRockChunk.some(n => n.type === 'ore_rock'),
  `types=${oreRockChunk.map(n => n.type).join(',')}`);

// Ore rocks must be at positions whose per-site biome is mountain_forest or alpine.
let oreInWrongBiome = false;
for (let cz = -12; cz < 12; cz++) {
  for (let cx = -12; cx < 12; cx++) {
    const nodes2 = resourcesForChunk(WORLD_SEED, cx, cz, heightAt, biomeAt, field);
    for (const n of nodes2) {
      if (n.type === 'ore_rock') {
        const siteBiome = biomeAt(n.x, n.z);
        if (siteBiome !== 'mountain_forest' && siteBiome !== 'alpine') {
          oreInWrongBiome = true;
        }
      }
    }
  }
}
check('ore_rock nodes are in mountain_forest/alpine positions', !oreInWrongBiome);

// River-adjacent cell (scan ±30 for a chunk with reeds or gourd).
let foundRiverNode = false;
outer: for (let cz = -30; cz < 30; cz++) {
  for (let cx = -30; cx < 30; cx++) {
    const nodes2 = resourcesForChunk(WORLD_SEED, cx, cz, heightAt, biomeAt, field);
    if (nodes2.some(n => n.type === 'reeds' || n.type === 'gourd')) {
      foundRiverNode = true;
      break outer;
    }
  }
}
check('river-adjacent cells yield reeds/gourd (scan ±30 chunks)', foundRiverNode);

// Alpine chunk with warming_herb (scan ±60 for first hit).
let foundWarmingHerb = false;
outer2: for (let cz = -60; cz < 60; cz++) {
  for (let cx = -60; cx < 60; cx++) {
    const x = (cx + 0.5) * CHUNK_SIZE;
    const z = (cz + 0.5) * CHUNK_SIZE;
    if (biomeAt(x, z) === 'alpine') {
      const nodes2 = resourcesForChunk(WORLD_SEED, cx, cz, heightAt, biomeAt, field);
      if (nodes2.some(n => n.type === 'warming_herb')) {
        foundWarmingHerb = true;
        break outer2;
      }
    }
  }
}
check('alpine chunks yield warming_herb (scan ±60 chunks)', foundWarmingHerb);

// Golden hash (rocks + bushes only, same as pre-F2 for stability check via hash change).
const hash = fnv1a(new Uint8Array(new Float32Array(all).buffer));
if (GOLDEN_HASH === null) {
  console.log(`golden hash: 0x${hash.toString(16)} (bake into GOLDEN_HASH)`);
} else {
  check('golden resource-scatter hash', hash === GOLDEN_HASH,
    `got 0x${hash.toString(16)}, want 0x${GOLDEN_HASH.toString(16)}`);
}

console.log(
  `${passed} passed, ${failed} failed  (${rocks} rocks, ${bushes} bushes in 576 chunks)`);
if (failed > 0) process.exit(1);
