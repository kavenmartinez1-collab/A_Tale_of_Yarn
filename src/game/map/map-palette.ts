/**
 * map-palette.ts — the dye lot. Pure: height + river + biome → a wool colour.
 *
 * The map is a cloth chart, not a satellite photo, so the palette is dyed
 * wool rather than the terrain's own linear-RGB tints: fewer colours, warmer,
 * and banded. Elevation is quantised into bands with a half-step shade
 * alternation, which is what makes a flat felt patch read as a hillside — the
 * same trick a contour map plays, done in thread.
 *
 * Everything here is a pure function of world position so a tile baked now and
 * the same tile baked after a reload are identical, and so the unit test can
 * assert the classification without a canvas.
 */

import { mix32 } from '../dungeon/dungeon-layout';
import type { Biome } from '../biome';

/** Packed 0xRRGGBB. Kept as ints so the baker can write bytes without parsing. */
export const CLOTH = {
  /**
   * Undiscovered: bare linen, undyed.
   *
   * Deliberately DARKER than every land dye, including the sand at 0xc9b184.
   * The first pass had it lighter, and the chart inverted: unexplored cloth
   * read as the bright figure and the ground the player had walked read as a
   * stain on it. Undyed wool is the ground, worked wool is the figure.
   */
  linen: 0x9a8862,
  /** Weft shading for the linen weave. */
  linenWeft: 0x8d7c58,
  /** Running-stitch thread, borders and labels — matches the bow reticle. */
  thread: 0xf0e6c8,
  /** Gold thread — the player, and anything the map is pointing at. */
  gold: 0xe8c35a,
  /** Ink for outlines and lettering shadows. */
  ink: 0x2a2118,
} as const;

/** Shallow → deep water dyes. Indexed by depth band. */
const WATER = [0x456b8b, 0x395a79, 0x2f4b69, 0x27405c] as const;
/** The wet shelf between the tide marks — neither dye nor felt. */
const SHOAL = 0x7d9086;

/** Upland land bands, dark → light with altitude (above the biome range). */
const UPLAND = [
  0x6d7a52, // 45-60 m  upland wood
  0x8a8163, // 60-75 m  bare upland
] as const;
const ROCK = 0x9a8f79;  // 75-90 m
const SNOW = 0xdfd9c6;  // 90 m+

/** Biome dyes for the lowland bands, so a desert does not read as a meadow. */
const BIOME_DYE: Record<Biome, number> = {
  ocean: 0x395a79,
  beach: 0xc9b184,
  desert: 0xc7a866,
  plains: 0x93a057,
  forest: 0x647c42,
  dense_forest: 0x4c6435,
  jungle: 0x487a3c,
  mountain_forest: 0x5f7053,
  alpine: 0xb6b3a4,
};

/** Elevation band edges (m); also the contour spacing the shading alternates on. */
const BANDS = [4, 10, 20, 32, 45, 60, 75, 90];

/** Above this river carve strength the ground is drawn as water. */
export const RIVER_WATER = 0.45;

function shade(rgb: number, f: number): number {
  const r = Math.min(255, Math.max(0, Math.round(((rgb >> 16) & 0xff) * f)));
  const g = Math.min(255, Math.max(0, Math.round(((rgb >> 8) & 0xff) * f)));
  const b = Math.min(255, Math.max(0, Math.round((rgb & 0xff) * f)));
  return (r << 16) | (g << 8) | b;
}

/**
 * Deterministic per-stitch mottle in [-1, 1]. Wool is never one flat colour,
 * and without this the felt patches read as plastic. Hashed from the stitch
 * coordinate rather than drawn from a PRNG so a re-bake is bit-identical.
 */
export function stitchNoise(sx: number, sz: number): number {
  return (mix32(0x7a1e5b, sx | 0, sz | 0) / 0xffffffff) * 2 - 1;
}

/**
 * The colour of one stitch of discovered ground.
 *
 * `h` is terrain height (m), `river` is `riverFactor` at the same point, and
 * `biome` may be null when the caller chose not to pay for the classification
 * — only the 4-45 m band actually consults it.
 */
export function terrainColour(
  h: number, river: number, biome: Biome | null, sx: number, sz: number,
): number {
  const n = stitchNoise(sx, sz);
  // Water first: a river carved along a hillside is still water, whatever the
  // altitude says. SEA_LEVEL is 0, and the terrain shader draws water at h<0.
  if (river > RIVER_WATER) return shade(WATER[1], 1 + n * 0.06);
  if (h < 0) {
    const depth = Math.min(3, Math.floor(-h / 6));
    return shade(WATER[depth], 1 + n * 0.06);
  }
  if (h < 1) return shade(SHOAL, 1 + n * 0.05); // between the tide marks

  let band = 0;
  while (band < BANDS.length && h >= BANDS[band]) band++;

  let base: number;
  if (h >= 90) base = SNOW;
  else if (h >= 75) base = ROCK;
  else if (h >= 45) base = UPLAND[h >= 60 ? 1 : 0];
  else if (biome !== null) base = BIOME_DYE[biome];
  else base = BIOME_DYE[h < 4 ? 'beach' : 'plains'];

  // Half-step contour shading: alternate bands sit a shade apart, so the eye
  // reads slope direction off a patch of otherwise identical felt.
  const contour = band % 2 === 0 ? 0.93 : 1.0;
  return shade(base, contour * (1 + n * 0.055));
}

/** The unworked cloth, with its weave. */
export function linenColour(sx: number, sz: number): number {
  const weave = ((sx & 1) ^ (sz & 1)) === 0;
  const n = stitchNoise(sx ^ 0x51, sz ^ 0x9d);
  return shade(weave ? CLOTH.linen : CLOTH.linenWeft, 1 + n * 0.035);
}

export function toCss(rgb: number): string {
  return `#${(rgb >>> 0).toString(16).padStart(6, '0')}`;
}
