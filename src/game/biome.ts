/**
 * Biome field — pure, deterministic, node-testable (no DOM / GPU).
 *
 * Combines altitude (from the heightfield) with moisture and heat Perlin FBM
 * fields to assign each world point a biome, and provides a per-vertex ground
 * tint used by the terrain mesh builder.
 *
 * Classification priority:
 *   altitude overrides: ocean (h<1), beach (h<4), alpine (h≥90)
 *   sub-treeline:       mountain_forest (45≤h<90)
 *   lowland by fields:  desert / jungle / dense_forest / forest / plains
 */

import type { HeightField } from './noise';
import { createPerlin, perlinFBM } from './noise';

export type Biome =
  | 'ocean'
  | 'beach'
  | 'desert'
  | 'plains'
  | 'forest'
  | 'dense_forest'
  | 'jungle'
  | 'mountain_forest'
  | 'alpine';

export interface BiomeField {
  readonly seed: number;
  biomeAt(x: number, z: number): Biome;
  /**
   * Linear-RGB ground tint for the biome at this world position.
   * Includes a small deterministic per-position variation so the
   * terrain doesn't look flat/uniform.
   */
  tintAt(x: number, z: number): [number, number, number];
}

// ---- base tints per biome (linear RGB) ------------------------------------
// These are the pure biome hues; the terrain shader blends them against
// slope-rock, snow, and the existing detail (mottle + grain).
const BIOME_TINT: Record<Biome, [number, number, number]> = {
  ocean:          [0.10, 0.20, 0.45],  // unused at runtime (below sea)
  beach:          [0.76, 0.70, 0.50],  // warm sand
  desert:         [0.82, 0.72, 0.42],  // hot sand / dune
  plains:         [0.42, 0.60, 0.22],  // yellow-green meadow
  forest:         [0.28, 0.50, 0.18],  // mid green
  dense_forest:   [0.18, 0.42, 0.14],  // dark green
  jungle:         [0.14, 0.45, 0.16],  // rich tropical green
  mountain_forest:[0.24, 0.40, 0.28],  // cool green-grey
  alpine:         [0.58, 0.57, 0.54],  // pale rock / snow
};

export function createBiomeField(seed: number, hf: HeightField): BiomeField {
  // Moisture: FBM 3-octave, freq 1/600, seed^0xb3c5a7d1.
  const moisturePerlin = createPerlin(seed ^ 0xb3c5a7d1);
  // Heat: FBM 2-octave, freq 1/900, seed^0x2f8e4c19.
  const heatPerlin = createPerlin(seed ^ 0x2f8e4c19);
  // Small per-vertex variation noise (fast, same seed family).
  const varPerlin = createPerlin(seed ^ 0x4a3b2c1d);

  const MOISTURE_FREQ = 1 / 600;
  const HEAT_FREQ = 1 / 900;
  const VAR_FREQ = 1 / 40; // fine-scale variation

  /** Moisture in ~[0,1]; uses 3-octave FBM, remapped. */
  function moistureAt(x: number, z: number): number {
    const raw = perlinFBM(moisturePerlin, x, z, 3, MOISTURE_FREQ);
    // raw is roughly in [-1, 1]; remap to [0, 1].
    return Math.min(1, Math.max(0, raw * 0.5 + 0.5));
  }

  /** Heat in ~[0,1]; uses 2-octave FBM, remapped. */
  function heatAt(x: number, z: number): number {
    const raw = perlinFBM(heatPerlin, x, z, 2, HEAT_FREQ);
    return Math.min(1, Math.max(0, raw * 0.5 + 0.5));
  }

  function biomeAt(x: number, z: number): Biome {
    const h = hf.heightAt(x, z);
    if (h < 1)  return 'ocean';
    if (h < 4)  return 'beach';
    if (h >= 90) return 'alpine';
    if (h >= 45) return 'mountain_forest';

    const m = moistureAt(x, z);
    const t = heatAt(x, z);

    if (t > 0.6 && m < 0.35) return 'desert';
    if (m > 0.7 && t > 0.55) return 'jungle';
    if (m > 0.6)              return 'dense_forest';
    if (m > 0.4)              return 'forest';
    return 'plains';
  }

  function tintAt(x: number, z: number): [number, number, number] {
    const biome = biomeAt(x, z);
    const base = BIOME_TINT[biome];
    // Small deterministic per-position variation (±4 % per channel).
    const v = perlinFBM(varPerlin, x, z, 1, VAR_FREQ) * 0.04;
    return [
      Math.min(1, Math.max(0, base[0] + v)),
      Math.min(1, Math.max(0, base[1] + v)),
      Math.min(1, Math.max(0, base[2] + v)),
    ];
  }

  return { seed, biomeAt, tintAt };
}
