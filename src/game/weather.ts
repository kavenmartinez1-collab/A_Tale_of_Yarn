/**
 * Weather — pure segment function of (seed, simTime), so it is node-testable
 * and deterministic. Time is divided into ~3.5–6.5 min segments; each segment
 * rolls clear / overcast / rain from a seeded hash and crossfades into the
 * next over BLEND_S seconds. Segment 0 is always clear so every fresh session
 * starts in good weather (and e2e stays stable without pinning).
 *
 * The outputs modulate envAt() results in main.ts: cloudCover/rainLevel feed
 * the frame uniforms directly; fogMul scales fogDensity; sunDim scales
 * sunColor.
 */

import { mix32 } from './dungeon/dungeon-layout';
import { mulberry32 } from './mesh-utils';

export type WeatherKind = 'clear' | 'overcast' | 'rain' | 'thunderstorm';

export interface Weather {
  kind: WeatherKind;   // dominant kind at this instant (mid-blend: nearest)
  cloudCover: number;  // 0 clear → 1 overcast (sky.wgsl FBM threshold)
  rainLevel: number;   // 0 dry → 1 downpour (rain.wgsl overlay)
  fogMul: number;      // multiplies envAt fogDensity
  sunDim: number;      // multiplies envAt sunColor
}

/** Per-kind steady-state values (also used by the ?weather= pin). */
export const WEATHER_PRESETS: Record<WeatherKind, Weather> = {
  clear:       { kind: 'clear',       cloudCover: 0.35, rainLevel: 0,   fogMul: 1.0, sunDim: 1.0  },
  overcast:    { kind: 'overcast',    cloudCover: 0.85, rainLevel: 0,   fogMul: 1.6, sunDim: 0.55 },
  rain:        { kind: 'rain',        cloudCover: 0.95, rainLevel: 1.0, fogMul: 2.2, sunDim: 0.40 },
  thunderstorm:{ kind: 'thunderstorm',cloudCover: 1.0,  rainLevel: 1.0, fogMul: 2.5, sunDim: 0.22 },
};

const SALT = 0x5ea50a1d;
const SEG_BASE_S = 270;   // nominal segment length (s)
const SEG_JITTER_S = 60;  // boundary shift ± (s) → segments ~3.5–6.5 min
const BLEND_S = 30;       // crossfade after each boundary (s)

// Average interval between lightning strikes within a thunderstorm segment (s).
const STRIKE_INTERVAL_S = 30; // 1 strike per ~30 s on average (range 20–40 s)

/** Segment kind + boundary jitter, both from one seeded stream. */
function segRoll(seed: number, i: number): { jitter: number; kind: WeatherKind } {
  const rng = mulberry32(mix32(seed ^ SALT, i, 0));
  const jitter = (rng() * 2 - 1) * SEG_JITTER_S;
  const r = rng();
  // Probabilities: clear 40%, overcast 27%, rain 23%, thunderstorm 10%
  const kind: WeatherKind =
    i <= 0 ? 'clear'
    : r < 0.40 ? 'clear'
    : r < 0.67 ? 'overcast'
    : r < 0.90 ? 'rain'
    : 'thunderstorm';
  return { jitter, kind };
}

/**
 * Deterministic lightning strike schedule for a thunderstorm segment.
 * Returns tOffsetS values within [0, segLenS).
 * Pure + node-testable; seeded by (seed, segmentIndex).
 */
export function strikesForSegment(
  seed: number,
  segmentIndex: number,
): { tOffsetS: number }[] {
  const rng = mulberry32(mix32(seed ^ SALT ^ 0xdeadbeef, segmentIndex, 1));
  // Segment length: use SEG_BASE_S + jitter from segRoll for accuracy,
  // but strikesForSegment is pure so we approximate with SEG_BASE_S.
  const segLenS = SEG_BASE_S; // approximate; callers use absolute time
  const result: { tOffsetS: number }[] = [];
  let t = STRIKE_INTERVAL_S * (0.5 + rng() * 0.5); // first strike not at t=0
  while (t < segLenS) {
    result.push({ tOffsetS: t });
    // Next strike: 20–40 s later
    t += 20 + rng() * 20;
  }
  return result;
}

/** Start time of segment i. Monotone: jitter < SEG_BASE_S / 2. */
function segStart(seed: number, i: number): number {
  if (i <= 0) return i * SEG_BASE_S; // segment 0 starts exactly at t = 0
  return i * SEG_BASE_S + segRoll(seed, i).jitter;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function weatherAt(seed: number, timeS: number): Weather {
  // Locate the segment containing timeS.
  let i = Math.max(0, Math.floor(timeS / SEG_BASE_S));
  while (i > 0 && timeS < segStart(seed, i)) i--;
  while (timeS >= segStart(seed, i + 1)) i++;

  const cur = WEATHER_PRESETS[segRoll(seed, i).kind];
  const prev = WEATHER_PRESETS[segRoll(seed, i - 1).kind];

  // Crossfade from the previous segment over the first BLEND_S seconds.
  // (smoothstep for C1 continuity at both ends of the blend window.)
  const u = Math.min(Math.max((timeS - segStart(seed, i)) / BLEND_S, 0), 1);
  const f = u * u * (3 - 2 * u);
  return {
    kind: f < 0.5 ? prev.kind : cur.kind,
    cloudCover: lerp(prev.cloudCover, cur.cloudCover, f),
    rainLevel: lerp(prev.rainLevel, cur.rainLevel, f),
    fogMul: lerp(prev.fogMul, cur.fogMul, f),
    sunDim: lerp(prev.sunDim, cur.sunDim, f),
  };
}
