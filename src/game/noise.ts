/**
 * Deterministic terrain height field — seeded 2D Perlin gradient noise + FBM.
 *
 * heightAt(x, z) is PURE and CPU-callable: the single source of truth for
 * chunk meshing, player/camera collision, and (later) AI Director world
 * queries. Same seed + same coordinates ⇒ bitwise-identical heights, which is
 * what guarantees crack-free chunk borders (chunks evaluate edge vertices at
 * identical world coordinates).
 */

/** Sea level (m) — keep in sync with SEA_LEVEL in shaders/water.wgsl. */
export const SEA_LEVEL = 0;

export interface HeightField {
  readonly seed: number;
  /** World-space terrain height (meters) at (x, z). */
  heightAt(x: number, z: number): number;
  /**
   * River carve strength at (x, z): 0 = no river, 1 = fully carved.
   * Used by Phase G for fresh-water detection.
   */
  riverFactor(x: number, z: number): number;
}

/** Mulberry32 PRNG — same pattern as src/diffusion/rng.ts, kept local. */
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

// 8 unit gradient directions (classic Perlin 2D).
const GRAD_X = [1, -1, 1, -1, Math.SQRT2, -Math.SQRT2, 0, 0];
const GRAD_Z = [1, 1, -1, -1, 0, 0, Math.SQRT2, -Math.SQRT2];

class Perlin2D {
  private readonly perm = new Uint8Array(512);

  constructor(seed: number) {
    const rand = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    // Fisher-Yates shuffle
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
    }
    this.perm.set(p, 0);
    this.perm.set(p, 256);
  }

  /** 2D gradient noise, range approximately [-1, 1]. */
  noise(x: number, z: number): number {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    const xf = x - xi;
    const zf = z - zi;
    const xw = xi & 255;
    const zw = zi & 255;

    // Quintic fade
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = zf * zf * zf * (zf * (zf * 6 - 15) + 10);

    const p = this.perm;
    const g00 = p[p[xw] + zw] & 7;
    const g10 = p[p[xw + 1] + zw] & 7;
    const g01 = p[p[xw] + zw + 1] & 7;
    const g11 = p[p[xw + 1] + zw + 1] & 7;

    const d00 = GRAD_X[g00] * xf + GRAD_Z[g00] * zf;
    const d10 = GRAD_X[g10] * (xf - 1) + GRAD_Z[g10] * zf;
    const d01 = GRAD_X[g01] * xf + GRAD_Z[g01] * (zf - 1);
    const d11 = GRAD_X[g11] * (xf - 1) + GRAD_Z[g11] * (zf - 1);

    const nx0 = d00 + u * (d10 - d00);
    const nx1 = d01 + u * (d11 - d01);
    // ~[-sqrt(2)/2, sqrt(2)/2] for 2D — rescale toward [-1, 1]
    return (nx0 + v * (nx1 - nx0)) * 1.414;
  }
}

// FBM octave rotation hides axis-aligned lattice artifacts.
const ROT_COS = Math.cos(0.6);
const ROT_SIN = Math.sin(0.6);

/**
 * Public helper: FBM sum over `octaves` using the given Perlin instance,
 * starting frequency `freq`, each octave scaled by gain 0.5 and rotated.
 * Returns an unscaled sum in approximately [-1, 1].
 */
export function perlinFBM(
  p: { noise(x: number, z: number): number },
  x: number,
  z: number,
  octaves: number,
  freq: number,
): number {
  let fx = x * freq;
  let fz = z * freq;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += p.noise(fx, fz) * amp;
    norm += amp;
    const rx = (fx * ROT_COS - fz * ROT_SIN) * 2 + 31.41;
    const rz = (fx * ROT_SIN + fz * ROT_COS) * 2 + 27.18;
    fx = rx; fz = rz;
    amp *= 0.5;
  }
  return sum / norm;
}

/**
 * Public factory: build a Perlin2D instance for the given seed so callers
 * (e.g. biome.ts) can reuse the same noise infrastructure without
 * duplicating the permutation logic.
 */
export function createPerlin(seed: number): { noise(x: number, z: number): number } {
  return new Perlin2D(seed);
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function createHeightField(seed: number): HeightField {
  const detail = new Perlin2D(seed);
  const continent = new Perlin2D(seed ^ 0x9e3779b9);
  const mountain = new Perlin2D(seed ^ 0x517cc1b7);
  const rangeMask = new Perlin2D(seed ^ 0x27220a95);
  const riverNoise = new Perlin2D(seed ^ 0xe1f73a2b);

  // River constants
  const RIVER_FREQ = 1 / 1800;
  const RIVER_HALF_WIDTH = 0.04; // |n| < this → river channel
  const RIVER_DEPTH = 3.5;       // max carve depth at |n|=0
  const RIVER_MIN_H = 1;         // only carve lowland terrain
  const RIVER_MAX_H = 40;
  const RIVER_SPAWN_SUPPRESS = 120; // keep origin dry (spawn safety)

  const OCTAVES = 7; // down to ~3.4 m wavelength — makes the 1 m facets visible
  const BASE_FREQ = 1 / 220;   // dominant hill wavelength ~220 m
  const BASE_AMP = 18;         // per-octave amplitude, ~35 m total relief
  const CONT_FREQ = 1 / 1500;  // continentalness: hills-vs-valleys at ~1.5 km
  const CONT_AMP = 25;

  // Mountain ranges: ridged FBM gated by a low-freq mask so most of the
  // world keeps the original gentle relief. Where the mask is 0 the added
  // term is exactly 0 — plains are bit-identical to the pre-mountain field.
  const MASK_FREQ = 1 / 2600;  // range placement scale (~2.6 km blobs)
  const MASK_LO = 0.18;        // mask band: below → untouched plains
  const MASK_HI = 0.55;        // above → full mountain amplitude
  const MTN_FREQ = 1 / 700;    // dominant ridge wavelength
  const MTN_OCTAVES = 4;
  const MTN_AMP = 160;         // added height at full mask, peaks ~120-170 m
  const SPAWN_R0 = 400;        // mountains fade in from this radius…
  const SPAWN_R1 = 1000;       // …fully present past it (spawn stays gentle)

  /** Ridged mountain contribution, ≥ 0; exactly 0 outside masked ranges. */
  function mountainAt(x: number, z: number): number {
    const m = smoothstep(MASK_LO, MASK_HI,
      rangeMask.noise(x * MASK_FREQ, z * MASK_FREQ));
    if (m === 0) return 0;
    const spawnFade = smoothstep(SPAWN_R0, SPAWN_R1, Math.hypot(x, z));
    if (spawnFade === 0) return 0;
    let fx = x * MTN_FREQ;
    let fz = z * MTN_FREQ;
    let amp = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < MTN_OCTAVES; o++) {
      const r = 1 - Math.abs(mountain.noise(fx, fz)); // ridge: peaks at n=0
      sum += r * r * amp;
      norm += amp;
      const rx = (fx * ROT_COS - fz * ROT_SIN) * 2 + 31.41;
      const rz = (fx * ROT_SIN + fz * ROT_COS) * 2 + 27.18;
      fx = rx;
      fz = rz;
      amp *= 0.5;
    }
    return m * spawnFade * (sum / norm) * MTN_AMP;
  }

  /** Pre-carve base height (continent + FBM + mountains). */
  function baseHeightAt(x: number, z: number): number {
    let h = continent.noise(x * CONT_FREQ, z * CONT_FREQ) * CONT_AMP;

    let fx = x * BASE_FREQ;
    let fz = z * BASE_FREQ;
    let amp = BASE_AMP;
    for (let o = 0; o < OCTAVES; o++) {
      h += detail.noise(fx, fz) * amp;
      // Rotate + scale for the next octave (lacunarity 2, gain 0.5).
      const rx = (fx * ROT_COS - fz * ROT_SIN) * 2 + 31.41;
      const rz = (fx * ROT_SIN + fz * ROT_COS) * 2 + 27.18;
      fx = rx;
      fz = rz;
      amp *= 0.5;
    }
    return h + mountainAt(x, z);
  }

  /**
   * River carve factor: 0 = no river, 1 = full depth at channel centre.
   * Suppressed near the origin (spawn safety) and above/below height band.
   */
  function riverFactor(x: number, z: number): number {
    if (Math.hypot(x, z) < RIVER_SPAWN_SUPPRESS) return 0;
    const n = riverNoise.noise(x * RIVER_FREQ, z * RIVER_FREQ);
    const absN = Math.abs(n);
    if (absN >= RIVER_HALF_WIDTH) return 0;
    const h = baseHeightAt(x, z);
    if (h < RIVER_MIN_H || h > RIVER_MAX_H) return 0;
    // Smooth falloff: 1 at centre, 0 at the edge of the river band.
    return 1 - absN / RIVER_HALF_WIDTH;
  }

  function heightAt(x: number, z: number): number {
    const h = baseHeightAt(x, z);
    const rf = riverFactor(x, z);
    if (rf === 0) return h;
    return h - rf * RIVER_DEPTH;
  }

  return { seed, heightAt, riverFactor };
}
