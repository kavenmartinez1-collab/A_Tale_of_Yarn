/**
 * Settlement palette buckets — the batching key for every settlement mesh.
 *
 * A settlement's whole triangle soup is split by dungeon-pipeline palette
 * index (see shaders/dungeon.wgsl) and drawn with the *surface* material mode
 * (100 + palette), so an entire village — every house, hedge, cart and
 * gravestone — costs one draw call per palette it actually uses.
 *
 * Nine palettes are in play. The six original ones plus three that the
 * "living community" pass needed and that the shader already had sitting
 * unused for outdoor geometry:
 *
 *   LEAF   (6)  green — hedges, crop rows, market greens, ivy on ruins.
 *                Settlements had literally no green in them before.
 *   TIMBER (8)  dark brown — soil, shingle roofs, doors, cart wheels, beams.
 *                Two-tone timber is most of what separates a built-up town
 *                silhouette from a row of identical light-wood boxes.
 *   WOOL  (11)  pale linen — washing lines, awnings, sacks, sail cloth.
 *                Maps to MAT_ID_CLOTH, i.e. the knit/weave normal map, which
 *                is the whole point in a wool-craft world.
 */

/** Palette indices (dungeon.wgsl): keep in sync with the shader table. */
export const PAL_STONE = 0;
export const PAL_WOOD = 1;
export const PAL_TORCH = 2;   // emissive — lamps/braziers/forges glow at night
export const PAL_THATCH = 4;
export const PAL_PLASTER = 5;
export const PAL_LEAF = 6;    // foliage green — hedges, crops, wreaths
export const PAL_BERRY = 7;   // dark crimson — banners, market goods
export const PAL_TIMBER = 8;  // dark wood — soil, shingles, doors, ironwork
export const PAL_WOOL = 11;   // pale linen/wool cloth — laundry, awnings

export const ALL_PALETTES = [
  PAL_STONE, PAL_WOOD, PAL_TORCH, PAL_THATCH, PAL_PLASTER,
  PAL_LEAF, PAL_BERRY, PAL_TIMBER, PAL_WOOL,
] as const;

export type PaletteIndex = (typeof ALL_PALETTES)[number];

export type Buckets = Record<PaletteIndex, number[]>;

export function emptyBuckets(): Buckets {
  return {
    [PAL_STONE]: [], [PAL_WOOD]: [], [PAL_TORCH]: [],
    [PAL_THATCH]: [], [PAL_PLASTER]: [], [PAL_LEAF]: [],
    [PAL_BERRY]: [], [PAL_TIMBER]: [], [PAL_WOOL]: [],
  };
}

/** Platform-skirt depth below a pad (m) — hides the downhill slope gap. */
export const SKIRT_DEPTH = 2.5;

/**
 * A settlement flame: the world position of a brazier / gate torch / forge /
 * lantern and the size of billboard flame render/fire-fx.ts should draw on it.
 * These used to be flat emissive boxes that lit nothing at all — a lamp post
 * at midnight cast no light on the road it stands over.
 */
export interface SettlementFlame {
  x: number; y: number; z: number;
  /** 1 = a torch head, ~1.5 a brazier, ~0.7 a shuttered lantern. */
  scale: number;
}
