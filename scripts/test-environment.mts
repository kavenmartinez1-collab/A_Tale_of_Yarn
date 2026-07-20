/**
 * Deterministic tests for the day/night environment (src/game/environment.ts).
 * Pure CPU — no GPU, no server. Run:  npx tsx scripts/test-environment.mts
 *
 * The golden FNV hash is the determinism tripwire: if envAt output changes
 * for any reason, this fails and the change must be deliberate (update the
 * constant in the same commit and eyeball the sky in-game with ?tod= pins).
 */

import { envAt, DAY_LENGTH_S, type Environment } from '../src/game/environment';

/** Update ONLY on deliberate environment-curve changes (see header). */
// Old hash (pre blue-hour keys / purple dusk): 0x98239a49
const GOLDEN_HASH: number | null = 0xb0dc84d9;

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

function flat(e: Environment): number[] {
  return [
    ...e.sunDir, ...e.sunColor, e.ambient, ...e.skyZenith, ...e.fogColor,
    e.fogDensity, e.starVis,
  ];
}

// --- sample the full cycle at 1/2048 steps ----------------------------------

const N = 2048;
const FIELDS = flat(envAt(0)).length;
const samples = new Float32Array(N * FIELDS);
let allFinite = true;
let sunNormalized = true;
let maxDelta = 0; // worst adjacent-sample jump across any scalar field
let prev = flat(envAt(0));
for (let i = 0; i < N; i++) {
  const cur = flat(envAt(i / N));
  samples.set(cur, i * FIELDS);
  for (let k = 0; k < FIELDS; k++) {
    if (!Number.isFinite(cur[k])) allFinite = false;
  }
  if (i > 0) {
    for (let k = 0; k < FIELDS; k++) {
      maxDelta = Math.max(maxDelta, Math.abs(cur[k] - prev[k]));
    }
  }
  prev = cur;
}
// Wrap continuity: last sample vs tod=1 (== tod=0).
{
  const wrapA = flat(envAt((N - 1) / N));
  const wrapB = flat(envAt(1));
  for (let k = 0; k < FIELDS; k++) {
    maxDelta = Math.max(maxDelta, Math.abs(wrapB[k] - wrapA[k]));
  }
}

check('all env values finite', allFinite);
check('no pops across the cycle (incl. wrap)', maxDelta < 0.05,
  `maxDelta=${maxDelta.toFixed(4)}`);

for (let i = 0; i < N; i += 64) {
  const d = envAt(i / N).sunDir;
  const len = Math.hypot(d[0], d[1], d[2]);
  if (Math.abs(len - 1) > 1e-6) sunNormalized = false;
}
check('sunDir stays normalized', sunNormalized);

// Sun geometry: up at noon, down at midnight, near horizon at dawn/dusk.
check('sun up at noon', envAt(0.5).sunDir[1] > 0.7,
  `y=${envAt(0.5).sunDir[1].toFixed(2)}`);
check('sun down at midnight', envAt(0).sunDir[1] < -0.7,
  `y=${envAt(0).sunDir[1].toFixed(2)}`);
check('sun near horizon at dawn', Math.abs(envAt(0.25).sunDir[1]) < 0.1);
check('sun near horizon at dusk', Math.abs(envAt(0.75).sunDir[1]) < 0.1);

// Day/night contrast: bright noon, dark midnight, stars only at night.
check('noon brighter than midnight',
  envAt(0.5).sunColor[1] > envAt(0).sunColor[1] + 0.5);
check('stars full at midnight', envAt(0).starVis === 1);
check('stars off at noon', envAt(0.5).starVis === 0);
check('tod wraps (envAt(1.3) == envAt(0.3))',
  JSON.stringify(envAt(1.3)) === JSON.stringify(envAt(0.3)));
check('day length is 15 min', DAY_LENGTH_S === 900);

// Golden hash over the sampled cycle.
const hash = fnv1a(new Uint8Array(samples.buffer));
if (GOLDEN_HASH === null) {
  console.log(`golden hash: 0x${hash.toString(16)} (bake into GOLDEN_HASH)`);
} else {
  check('golden environment hash', hash === GOLDEN_HASH,
    `got 0x${hash.toString(16)}, want 0x${GOLDEN_HASH.toString(16)}`);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
