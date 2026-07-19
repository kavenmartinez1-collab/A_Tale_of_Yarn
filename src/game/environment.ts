/**
 * Day/night environment — pure keyframed function of time-of-day, so it is
 * node-testable and deterministic. tod 0 = midnight, 0.25 = dawn, 0.5 = noon,
 * 0.75 = dusk. envAt() drives the frame uniforms (sun, sky, fog, stars); the
 * shaders never hardcode daylight constants anymore.
 */

import { normalize, type Vec3 } from './math';

export interface Environment {
  sunDir: Vec3;      // normalized, points TOWARD the sun (below horizon at night)
  sunColor: Vec3;    // direct sunlight tint × intensity
  ambient: number;   // flat ambient floor
  skyZenith: Vec3;   // sky color straight up
  fogColor: Vec3;    // horizon/fog color (also the clear color)
  fogDensity: number;
  starVis: number;   // 0 day → 1 night
}

/** One full day-night cycle (s of simTime). */
export const DAY_LENGTH_S = 900; // 15 min

interface Key {
  t: number;
  sunColor: Vec3;
  ambient: number;
  skyZenith: Vec3;
  fogColor: Vec3;
  fogDensity: number;
  starVis: number;
}

const NIGHT: Omit<Key, 't'> = {
  sunColor: [0.02, 0.03, 0.06],
  ambient: 0.16,
  skyZenith: [0.015, 0.025, 0.06],
  fogColor: [0.05, 0.06, 0.10],
  fogDensity: 0.0018,
  starVis: 1,
};
const DAWN: Omit<Key, 't'> = {
  sunColor: [0.95, 0.62, 0.38],
  ambient: 0.20,
  skyZenith: [0.22, 0.28, 0.50],
  fogColor: [0.85, 0.58, 0.40],
  fogDensity: 0.0024,
  starVis: 0,
};
const DAY: Omit<Key, 't'> = {
  sunColor: [1.0, 0.97, 0.90],
  ambient: 0.25,
  skyZenith: [0.28, 0.48, 0.78],
  fogColor: [0.62, 0.76, 0.90],
  fogDensity: 0.0015,
  starVis: 0,
};
const DUSK: Omit<Key, 't'> = {
  sunColor: [0.95, 0.50, 0.30],
  ambient: 0.20,
  skyZenith: [0.20, 0.22, 0.45],
  fogColor: [0.88, 0.52, 0.35],
  fogDensity: 0.0024,
  starVis: 0,
};

// First and last key share values so the wrap at tod 0/1 is continuous.
const KEYS: Key[] = [
  { t: 0.00, ...NIGHT },
  { t: 0.21, ...NIGHT },
  { t: 0.26, ...DAWN },
  { t: 0.33, ...DAY },
  { t: 0.67, ...DAY },
  { t: 0.74, ...DUSK },
  { t: 0.79, ...NIGHT },
  { t: 1.00, ...NIGHT },
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export function envAt(tod: number): Environment {
  const t = ((tod % 1) + 1) % 1;

  // Sun arc: rises east at 0.25, culminates at 0.5, sets west at 0.75.
  const theta = (t - 0.25) * 2 * Math.PI;
  const sunDir = normalize([Math.cos(theta) * 0.9, Math.sin(theta), 0.35]);

  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].t < t) i++;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const f = (t - a.t) / (b.t - a.t);

  return {
    sunDir,
    sunColor: lerp3(a.sunColor, b.sunColor, f),
    ambient: lerp(a.ambient, b.ambient, f),
    skyZenith: lerp3(a.skyZenith, b.skyZenith, f),
    fogColor: lerp3(a.fogColor, b.fogColor, f),
    fogDensity: lerp(a.fogDensity, b.fogDensity, f),
    starVis: lerp(a.starVis, b.starVis, f),
  };
}
