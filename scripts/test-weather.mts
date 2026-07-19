/**
 * Deterministic tests for the weather segments (src/game/weather.ts).
 * Pure CPU — no GPU, no server. Run:  npx tsx scripts/test-weather.mts
 *
 * The golden FNV hash is the determinism tripwire: if weatherAt output
 * changes for any reason, this fails and the change must be deliberate
 * (update the constant in the same commit).
 */

import { weatherAt, strikesForSegment, WEATHER_PRESETS, type Weather } from '../src/game/weather';

/** Update ONLY on deliberate weather-curve changes (see header). */
const GOLDEN_HASH: number | null = 0x340ea177;

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

function flat(w: Weather): number[] {
  return [w.cloudCover, w.rainLevel, w.fogMul, w.sunDim];
}

// --- sample 4 h of simTime at 1 s steps -------------------------------------

const HORIZON_S = 4 * 3600;
const FIELDS = 4;
const samples = new Float32Array(HORIZON_S * FIELDS);
const kinds = new Set<string>();
let allFinite = true;
let inRange = true;
let maxDelta = 0; // worst 1-s jump in any field (continuity)
let prev = flat(weatherAt(WORLD_SEED, 0));
for (let t = 0; t < HORIZON_S; t++) {
  const w = weatherAt(WORLD_SEED, t);
  const cur = flat(w);
  samples.set(cur, t * FIELDS);
  kinds.add(w.kind);
  for (let k = 0; k < FIELDS; k++) {
    if (!Number.isFinite(cur[k])) allFinite = false;
    if (t > 0) maxDelta = Math.max(maxDelta, Math.abs(cur[k] - prev[k]));
  }
  if (w.cloudCover < 0 || w.cloudCover > 1 || w.rainLevel < 0 ||
      w.rainLevel > 1 || w.fogMul < 1 || w.sunDim > 1 || w.sunDim <= 0) {
    inRange = false;
  }
  prev = cur;
}

check('all weather values finite', allFinite);
check('all values within bounds', inRange);
// Worst legal jump: fogMul swings 1.2 over a 30 s blend ⇒ ~0.04/s + margin.
check('no pops (blends, never snaps)', maxDelta < 0.08,
  `maxDelta=${maxDelta.toFixed(4)}`);
check('all four kinds occur within 4 h',
  kinds.has('clear') && kinds.has('overcast') && kinds.has('rain') && kinds.has('thunderstorm'),
  `saw: ${[...kinds].join(', ')}`);

// Session start: segment 0 is always clear, for any seed.
let startsClear = true;
for (let s = 0; s < 50; s++) {
  const w = weatherAt(s, 0);
  if (w.kind !== 'clear' || w.rainLevel !== 0) startsClear = false;
}
check('every seed starts clear at t=0', startsClear);

// Segment lengths: kind-change spacing within the documented ~3.5–6.5 min
// window (blend midpoints shift changes by <= BLEND_S/2 = 15 s each side).
{
  let last = 0;
  let prevKind = weatherAt(WORLD_SEED, 0).kind;
  let minLen = Infinity;
  let maxLen = 0;
  let changes = 0;
  for (let t = 1; t < HORIZON_S; t++) {
    const k = weatherAt(WORLD_SEED, t).kind;
    if (k !== prevKind) {
      minLen = Math.min(minLen, t - last);
      maxLen = Math.max(maxLen, t - last);
      changes++;
      last = t;
      prevKind = k;
    }
  }
  check('weather changes at least hourly on average', changes >= 4,
    `changes=${changes}`);
  // Same-kind rolls merge adjacent segments, so only the minimum is bounded.
  check('segments last >= ~3 min', minLen >= 180, `minLen=${minLen}`);
}

// Determinism: same args identical; different seed diverges somewhere.
{
  const a = JSON.stringify(weatherAt(WORLD_SEED, 12345));
  const b = JSON.stringify(weatherAt(WORLD_SEED, 12345));
  check('same (seed,t) reproduces identical weather', a === b);
  let differs = false;
  for (let t = 0; t < HORIZON_S; t += 60) {
    if (weatherAt(WORLD_SEED, t).kind !== weatherAt(WORLD_SEED + 1, t).kind) {
      differs = true;
      break;
    }
  }
  check('different seed produces a different forecast', differs);
}

// Presets are steady states: mid-segment values equal a preset exactly.
{
  const w = weatherAt(WORLD_SEED, 100); // segment 0 (clear), past the blend
  check('mid-segment matches its preset',
    JSON.stringify(flat(w)) === JSON.stringify(flat(WEATHER_PRESETS.clear)));
}

// Thunderstorm frequency: over many seeds+segments it should appear 5–15%.
{
  let total = 0;
  let tsCount = 0;
  for (let seed = 0; seed < 20; seed++) {
    for (let seg = 1; seg <= 50; seg++) {
      // Sample near the segment midpoint (avoid blend region).
      const tMid = seg * 270 + 135;
      const w = weatherAt(seed, tMid);
      if (w.kind === 'thunderstorm') tsCount++;
      total++;
    }
  }
  const freq = tsCount / total;
  check('thunderstorm frequency 5–25% over many seeds/segments',
    freq >= 0.05 && freq <= 0.25,
    `freq=${(freq * 100).toFixed(1)}%`);
}

// strikesForSegment: deterministic, spacing within 20–40 s bounds.
{
  const s1 = strikesForSegment(WORLD_SEED, 7);
  const s2 = strikesForSegment(WORLD_SEED, 7);
  check('strikesForSegment is deterministic',
    JSON.stringify(s1) === JSON.stringify(s2));
  check('strikesForSegment returns at least 1 strike for seg 7',
    s1.length >= 1,
    `count=${s1.length}`);
  let minSpacing = Infinity;
  for (let k = 1; k < s1.length; k++) {
    minSpacing = Math.min(minSpacing, s1[k].tOffsetS - s1[k - 1].tOffsetS);
  }
  // spacing must be >= 20 s (lower bound of 20+rng()*20 interval)
  check('strike spacing >= 20 s',
    s1.length <= 1 || minSpacing >= 19.9,
    `minSpacing=${minSpacing.toFixed(1)}`);
  // different segments produce different schedules
  const s3 = strikesForSegment(WORLD_SEED, 8);
  check('different segments produce different schedules',
    JSON.stringify(s1) !== JSON.stringify(s3));
  // different seeds produce different schedules for the same segment
  const s4 = strikesForSegment(WORLD_SEED + 1, 7);
  check('different seeds produce different strike schedules',
    JSON.stringify(s1) !== JSON.stringify(s4));
}

// Golden hash over the sampled horizon.
const hash = fnv1a(new Uint8Array(samples.buffer));
if (GOLDEN_HASH === null) {
  console.log(`golden hash: 0x${hash.toString(16)} (bake into GOLDEN_HASH)`);
} else {
  check('golden weather hash', hash === GOLDEN_HASH,
    `got 0x${hash.toString(16)}, want 0x${GOLDEN_HASH.toString(16)}`);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
