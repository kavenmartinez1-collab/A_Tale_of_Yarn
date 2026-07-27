/**
 * Deterministic RNG for the music engine.
 *
 * House style (see dungeon-layout.ts / noise.ts / building-interior.ts): a module
 * that needs both re-declares `mulberry32` locally and exports `mix32`. These
 * bodies are byte-identical to `src/game/mesh-utils.ts:504` (mulberry32) and
 * `src/game/dungeon/dungeon-layout.ts:72` (mix32) — copied rather than imported
 * so the music engine stays free of mesh/WebGPU imports and runs bare in Node.
 *
 * HARD RULE: `Math.random()` and `Date.now()` are forbidden everywhere under
 * src/game/music/. Every musical choice derives from mix32(seed, bar, salt).
 */

/** Mulberry32 PRNG — the deterministic-scatter workhorse (same as noise.ts). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mix three 32-bit ints into one (seed derivation for layouts/attempts). */
export function mix32(a: number, b: number, c = 0): number {
  let h = a >>> 0;
  h = Math.imul(h ^ (b >>> 0), 0x9e3779b1);
  h = ((h << 13) | (h >>> 19)) >>> 0;
  h = Math.imul(h ^ (c >>> 0), 0x85ebca6b);
  h = ((h << 13) | (h >>> 19)) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Stable string -> 32-bit salt (FNV-1a). Lets call sites read
 * `mix32(seed, bar, salt('melody'))` instead of magic numbers.
 */
export function salt(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Pick an element deterministically. `r` is a 0..1 draw. */
export function pick<T>(arr: readonly T[], r: number): T {
  const i = Math.min(arr.length - 1, Math.floor(r * arr.length));
  return arr[i]!;
}
