/**
 * Deterministic tests for the terrain height field (mountains included).
 * Pure CPU — no GPU, no server. Run:  npx tsx scripts/test-heightfield.mts
 *
 * The golden FNV hash is the determinism tripwire: if heightAt output
 * changes for any reason, this fails and the change must be deliberate
 * (update the constant in the same commit and re-verify terrain in-game —
 * NOTE: a height change also moves dungeon-entrance sites and spawn).
 */

import { createHeightField } from '../src/game/noise';

/** Update ONLY on deliberate heightfield changes (see header). */
const GOLDEN_HASH: number | null = 0x863c6e;

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

// --- sample grid: ±4 km at 25 m steps (321×321 = 103k samples) -------------

const field = createHeightField(WORLD_SEED);
const EXTENT = 4000;
const STEP = 25;
const N = (2 * EXTENT) / STEP + 1;
const samples = new Float32Array(N * N);
let min = Infinity;
let max = -Infinity;
let allFinite = true;
let spawnMax = -Infinity;   // relief inside the spawn-safe radius (< 390 m)
let i = 0;
for (let zi = 0; zi < N; zi++) {
  for (let xi = 0; xi < N; xi++) {
    const x = -EXTENT + xi * STEP;
    const z = -EXTENT + zi * STEP;
    const h = field.heightAt(x, z);
    samples[i++] = h;
    if (!Number.isFinite(h)) allFinite = false;
    if (h < min) min = h;
    if (h > max) max = h;
    if (Math.hypot(x, z) < 390 && h > spawnMax) spawnMax = h;
  }
}

check('all heights finite', allFinite);
check('min height sane', min > -80, `min=${min.toFixed(1)}`);
check('max height within mountain budget', max < 260, `max=${max.toFixed(1)}`);
check('mountains exist somewhere', max > 80, `max=${max.toFixed(1)}`);
check('spawn area stays gentle relief', spawnMax < 55,
  `spawnMax=${spawnMax.toFixed(1)}`);

// Determinism: same seed twice ⇒ identical; different seed ⇒ different.
const again = createHeightField(WORLD_SEED);
const other = createHeightField(WORLD_SEED + 1);
let identical = true;
let differs = false;
for (let k = 0; k < 500; k++) {
  const x = -EXTENT + ((k * 977) % (2 * EXTENT));
  const z = -EXTENT + ((k * 1409) % (2 * EXTENT));
  if (field.heightAt(x, z) !== again.heightAt(x, z)) identical = false;
  if (field.heightAt(x, z) !== other.heightAt(x, z)) differs = true;
}
check('same seed reproduces bit-identical heights', identical);
check('different seed produces different heights', differs);

// Golden hash over the sample grid.
const hash = fnv1a(new Uint8Array(samples.buffer));
if (GOLDEN_HASH === null) {
  console.log(`golden hash: 0x${hash.toString(16)} (bake into GOLDEN_HASH)`);
} else {
  check('golden heightfield hash', hash === GOLDEN_HASH,
    `got 0x${hash.toString(16)}, want 0x${GOLDEN_HASH.toString(16)}`);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
