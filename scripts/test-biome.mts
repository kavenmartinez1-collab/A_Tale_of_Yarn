/**
 * Deterministic tests for the biome field + river factor.
 * Pure CPU — no GPU, no server. Run:  npx tsx scripts/test-biome.mts
 *
 * The golden FNV hash is the determinism tripwire: if biomeAt output changes
 * for any reason, this fails and the change must be deliberate (update the
 * constant in the same commit).
 */

import { createHeightField } from '../src/game/noise';
import { createBiomeField, type Biome } from '../src/game/biome';

/** Update ONLY on deliberate biome/heightfield changes. */
const GOLDEN_HASH: number | null = 0xca821251;

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

// Biome → integer for hashing.
const BIOME_ID: Record<Biome, number> = {
  ocean: 0, beach: 1, desert: 2, plains: 3, forest: 4,
  dense_forest: 5, jungle: 6, mountain_forest: 7, alpine: 8,
};

const EXTENT = 4000;
const STEP = 25;
const N = (2 * EXTENT) / STEP + 1;

const hf = createHeightField(WORLD_SEED);
const bf = createBiomeField(WORLD_SEED, hf);

// --- sample grid ±4 km at 25 m steps (321×321 = 103k samples) -----------

const samples = new Uint8Array(N * N);
const histogram: Record<string, number> = {};
for (const b of Object.keys(BIOME_ID)) histogram[b] = 0;

let i = 0;
for (let zi = 0; zi < N; zi++) {
  for (let xi = 0; xi < N; xi++) {
    const x = -EXTENT + xi * STEP;
    const z = -EXTENT + zi * STEP;
    const b = bf.biomeAt(x, z);
    histogram[b]++;
    samples[i++] = BIOME_ID[b];
  }
}

const total = N * N;

// --- histogram sanity checks ---------------------------------------------

const distinctBiomes = Object.values(histogram).filter((c) => c > 0).length;
check('≥5 distinct biomes present', distinctBiomes >= 5,
  `distinct=${distinctBiomes}`);

const maxFrac = Math.max(...Object.values(histogram)) / total;
check('no single biome >70%', maxFrac < 0.70,
  `maxFrac=${(maxFrac * 100).toFixed(1)}%`);

// Plains + forest should dominate together (between 30 % and 80 % combined).
const plainsForest = (histogram.plains + histogram.forest) / total;
check('plains+forest dominate (30–80%)', plainsForest >= 0.30 && plainsForest <= 0.80,
  `plainsForest=${(plainsForest * 100).toFixed(1)}%`);

// Each of the key lowland biomes must be visible somewhere.
const required: Biome[] = ['plains', 'forest', 'desert', 'jungle'];
for (const b of required) {
  check(`biome '${b}' exists`, histogram[b] > 0, `count=${histogram[b]}`);
}

// --- spawn point assertions -----------------------------------------------

const spawnBiome = bf.biomeAt(32, 32);
// beach (h<4) is dry land above sea level and is valid for spawn;
// only ocean (submerged) and alpine (treeline) are disqualifying.
const landBiomes: Biome[] = [
  'beach', 'plains', 'forest', 'dense_forest', 'jungle',
  'mountain_forest', 'desert',
];
check('spawn is a habitable biome (not ocean/alpine)',
  landBiomes.includes(spawnBiome), `spawnBiome=${spawnBiome}`);

// riverFactor must be 0 at the spawn origin (suppression radius).
const spawnRF = hf.riverFactor(32, 32);
check('riverFactor(32,32) === 0 (spawn safety)', spawnRF === 0,
  `riverFactor=${spawnRF}`);

// --- river existence -------------------------------------------------------

let riverCount = 0;
for (let zi = 0; zi < N; zi++) {
  for (let xi = 0; xi < N; xi++) {
    const x = -EXTENT + xi * STEP;
    const z = -EXTENT + zi * STEP;
    if (hf.riverFactor(x, z) > 0.5) riverCount++;
  }
}
check('rivers exist in the world (some riverFactor > 0.5)', riverCount > 0,
  `riverCount=${riverCount}`);

// --- determinism -----------------------------------------------------------

const hf2 = createHeightField(WORLD_SEED);
const bf2 = createBiomeField(WORLD_SEED, hf2);
const hf3 = createHeightField(WORLD_SEED + 1);
const bf3 = createBiomeField(WORLD_SEED + 1, hf3);

let identical = true;
let differs = false;
for (let k = 0; k < 500; k++) {
  const x = -EXTENT + ((k * 977) % (2 * EXTENT));
  const z = -EXTENT + ((k * 1409) % (2 * EXTENT));
  if (bf.biomeAt(x, z) !== bf2.biomeAt(x, z)) identical = false;
  if (bf.biomeAt(x, z) !== bf3.biomeAt(x, z)) differs = true;
}
check('same seed reproduces identical biomes', identical);
check('different seed produces different biomes', differs);

// --- tint sanity -----------------------------------------------------------

const tint = bf.tintAt(32, 32);
check('tintAt returns 3-element array', Array.isArray(tint) && tint.length === 3);
check('tint values in [0,1]',
  tint.every((v) => v >= 0 && v <= 1),
  `tint=[${tint.map((v) => v.toFixed(3)).join(', ')}]`);

// --- golden hash -----------------------------------------------------------

const hash = fnv1a(samples);
if (GOLDEN_HASH === null) {
  console.log(`golden biome hash: 0x${hash.toString(16)} (bake into GOLDEN_HASH)`);
} else {
  check('golden biome hash', hash === GOLDEN_HASH,
    `got 0x${hash.toString(16)}, want 0x${GOLDEN_HASH.toString(16)}`);
}

// --- summary ---------------------------------------------------------------

const histStr = Object.entries(histogram)
  .filter(([, c]) => c > 0)
  .map(([b, c]) => `${b}:${(c / total * 100).toFixed(1)}%`)
  .join('  ');
console.log(`Histogram: ${histStr}`);
console.log(`Spawn biome: ${spawnBiome}  riverCount>0.5: ${riverCount}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
