/**
 * Deterministic tests for per-chunk tree scattering.
 * Pure CPU — no GPU, no server. Run:  npx tsx scripts/test-tree-scatter.mts
 *
 * Golden FNV hash = determinism tripwire (see test-heightfield.mts header).
 *
 * Phase F2: biomeAt threaded in; per-biome assertions added.
 */

import { createHeightField } from '../src/game/noise';
import { createBiomeField } from '../src/game/biome';
import { treesForChunk } from '../src/game/tree-scatter';
import { entranceSiteAt, DCELL } from '../src/game/dungeon/entrance-site';
import { settlementSiteAt } from '../src/game/settlement/settlement-scatter';
import { CHUNK_SIZE } from '../src/game/terrain/chunk-mesh';

/** Update ONLY on deliberate scatter/heightfield changes. */
// Rebaked for forced castle near spawn (settlement clearing moved).
// Rebaked by the settlement community pass: SETTLEMENT_RADIUS.castle went
// 50 -> 68 (a castle town needs room outside its gate) and the castle
// flatness budget 7 -> 9, which moves every castle candidate in the world.
// (tree scatter clears settlement.radius + 3, so castle clearings grew.)
// Previous: 0xeefa419e
const GOLDEN_HASH: number | null = 0x733ea40a;

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
let total = 0;
let inBand = true;
let inChunk = true;
let clearingOk = true;
for (let cz = -12; cz < 12; cz++) {
  for (let cx = -12; cx < 12; cx++) {
    const trees = treesForChunk(WORLD_SEED, cx, cz, heightAt, biomeAt);
    total += trees.length;
    const dcx = Math.floor((cx * CHUNK_SIZE) / DCELL);
    const dcz = Math.floor((cz * CHUNK_SIZE) / DCELL);
    const entrance = entranceSiteAt(WORLD_SEED, dcx, dcz, heightAt);
    const settlement = settlementSiteAt(WORLD_SEED, dcx, dcz, heightAt);
    for (const t of trees) {
      all.push(t.x, t.y, t.z, t.scale);
      const h = heightAt(t.x, t.z);
      if (h < 2 || h > 42) inBand = false;
      if (t.x < cx * CHUNK_SIZE || t.x >= (cx + 1) * CHUNK_SIZE
        || t.z < cz * CHUNK_SIZE || t.z >= (cz + 1) * CHUNK_SIZE) inChunk = false;
      if (entrance !== null
        && Math.hypot(t.x - entrance.x, t.z - entrance.z) < 6) clearingOk = false;
      if (settlement !== null
        && Math.hypot(t.x - settlement.x, t.z - settlement.z)
           < settlement.radius + 3) clearingOk = false;
    }
  }
}

check('forest is populated', total > 500, `total=${total}`);
check('forest is not a wall of trees', total < 30_000, `total=${total}`);
check('trees stay in the grass band (2..42 m)', inBand);
check('trees stay inside their own chunk', inChunk);
check('dungeon-entrance + settlement clearings respected', clearingOk);

// Determinism: recompute one chunk, must be bit-identical.
const a = JSON.stringify(treesForChunk(WORLD_SEED, 3, -2, heightAt, biomeAt));
const b = JSON.stringify(treesForChunk(WORLD_SEED, 3, -2, heightAt, biomeAt));
check('scatter is deterministic', a === b);

// --- Phase F2 biome assertions --------------------------------------------

// Alpine chunk (11,5): treeline — zero trees.
const alpineTrees = treesForChunk(WORLD_SEED, 11, 5, heightAt, biomeAt);
check('alpine chunk (11,5) has 0 trees (treeline)', alpineTrees.length === 0,
  `got ${alpineTrees.length}`);

// Desert chunk (1,-7): all trees must be cactus.
const desertTrees = treesForChunk(WORLD_SEED, 1, -7, heightAt, biomeAt);
const allCactus = desertTrees.length === 0 || desertTrees.every(t => t.kind === 'cactus');
check('desert chunk (1,-7) trees are all cactus', allCactus,
  `kinds=${desertTrees.map(t => t.kind).join(',')}`);

// Dense_forest chunk (-10,-12) must have more trees than plains chunk (-11,-10).
const denseForestTrees = treesForChunk(WORLD_SEED, -10, -12, heightAt, biomeAt);
const plainsTrees = treesForChunk(WORLD_SEED, -11, -10, heightAt, biomeAt);
check('dense_forest chunk has more trees than plains chunk',
  denseForestTrees.length > plainsTrees.length,
  `dense=${denseForestTrees.length} plains=${plainsTrees.length}`);

// Kind field must be present on all instances.
const kindOk = treesForChunk(WORLD_SEED, -3, 9, heightAt, biomeAt)
  .every(t => t.kind === 'oak' || t.kind === 'cactus' || t.kind === 'jungle');
check('all tree instances have a valid kind field', kindOk);

// --- Golden hash -----------------------------------------------------------
const hash = fnv1a(new Uint8Array(new Float32Array(all).buffer));
if (GOLDEN_HASH === null) {
  console.log(`golden hash: 0x${hash.toString(16)} (bake into GOLDEN_HASH)`);
} else {
  check('golden tree-scatter hash', hash === GOLDEN_HASH,
    `got 0x${hash.toString(16)}, want 0x${GOLDEN_HASH.toString(16)}`);
}

console.log(`${passed} passed, ${failed} failed  (${total} trees in 576 chunks)`);
if (failed > 0) process.exit(1);
