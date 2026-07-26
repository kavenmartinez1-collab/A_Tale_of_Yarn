/**
 * The material table — one row per *semantic* surface in the game.
 *
 * This is the indirection that separates "what is this thing made of" from
 * "how does it shade". Before this existed, that question was answered four
 * incompatible ways: terrain picked texture layers inline from height/slope,
 * props ran a palette-index switch inside dungeon.wgsl, characters smuggled a
 * layer index through an unused uniform float, and trees hardcoded
 * bark-below-Y. Adding a new kind of surface meant editing shader code.
 *
 * Now a material is a row of data. Adding a goblin's leather jerkin or a
 * skeleton's ribs is a table entry, not a shader change.
 *
 * Several materials deliberately share one baked texture layer and differ only
 * in their parameters — LEATHER and HIDE_ROUGH are the same hide texture at
 * different scales and roughness, which is much cheaper than baking two.
 */

// Pure import on purpose: this module is reached from the node-testable CPU
// mesh builders, so it must not transitively pull in a WGSL `?raw` import.
import { MATERIAL_LAYERS as LAYER } from './material-layers';

/** Row layout on the GPU: two vec4s = 32 bytes. Keep in sync with common.wgsl. */
export const MATERIAL_ROW_FLOATS = 8;
/** Hard cap; the table is a uniform buffer sized for this many rows. */
export const MAX_MATERIALS = 32;

export interface MaterialDesc {
  /** Baked texture-array layer this material samples. */
  layer: number;
  /** Texture repeats per world metre. */
  texScale: number;
  /** Multiplier on the baked roughness. >1 duller, <1 glossier. */
  roughness: number;
  /** 0 dielectric, 1 metal. */
  metallic: number;
  /** Light transmitted through thin geometry (leaves, cloth, ears, wool). */
  translucency: number;
  /** Self-illumination, in HDR units above 1 so bloom catches it. */
  emissive: number;
  /**
   * How strongly the per-vertex / palette colour drives the final albedo.
   * 1 = colour is the authority and the texture only modulates brightness
   * (characters, painted props); 0 = the baked texture's own colour wins
   * (stone, bone, metal).
   */
  tint: number;
  /**
   * How strongly the texture's own luminance modulates the tint. Wool needs a
   * wide swing or individual stitches wash out; skin and metal need a narrow
   * one or they look mottled.
   */
  detail: number;
}

/**
 * Material IDs. These are what mesh builders write per vertex, so the numeric
 * values are part of the vertex data — **append only, never reorder**.
 */
export const MAT = {
  DEFAULT:    0,
  // --- character / creature ---
  KNIT:       1,   // the yarn people
  FELT:       2,   // patches, soles, satchels
  SKIN:       3,
  FUR:        4,
  FUR_SHORT:  5,   // sleek coats — wolf, horse
  LEATHER:    6,
  BONE:       7,
  HORN:       8,   // antlers, hooves, beaks, claws
  SCALE:      9,   // dragon / serpent hide
  // --- equipment ---
  IRON:      10,
  GOLD:      11,
  CLOTH:     12,
  // --- world ---
  WOOD:      13,
  BARK:      14,
  LEAF:      15,
  STONE:     16,
  MASONRY:   17,
  THATCH:    18,
  SAND:      19,
  SNOW:      20,
  GRASS:     21,
  DIRT:      22,
  GEM:       23,
  EMBER:     24,  // emissive: torch flame, forge glow
  PORTAL:    25,  // emissive: portal glow
} as const;

export type MaterialId = (typeof MAT)[keyof typeof MAT];

const M = (
  layer: number, texScale: number, roughness: number, metallic: number,
  translucency: number, emissive: number, tint: number, detail = 0.30,
): MaterialDesc => ({
  layer, texScale, roughness, metallic, translucency, emissive, tint, detail,
});

/** Indexed by MAT.*; order must match the constants above exactly. */
export const MATERIAL_TABLE: MaterialDesc[] = [
  /* DEFAULT   */ M(LAYER.CLOTH,  4.0, 1.00, 0.0, 0.05, 0, 1.0),
  /* KNIT      */ M(LAYER.KNIT,   3.0, 1.10, 0.0, 0.42, 0, 1.0, 0.62),
  /* FELT      */ M(LAYER.FELT,   5.0, 1.10, 0.0, 0.20, 0, 1.0, 0.42),
  /* SKIN      */ M(LAYER.SKIN,   6.0, 0.85, 0.0, 0.22, 0, 1.0, 0.16),
  /* FUR       */ M(LAYER.FUR,    5.0, 1.00, 0.0, 0.18, 0, 1.0, 0.48),
  /* FUR_SHORT */ M(LAYER.FUR,   11.0, 0.92, 0.0, 0.12, 0, 1.0, 0.34),
  /* LEATHER   */ M(LAYER.HIDE,   6.0, 0.90, 0.0, 0.05, 0, 1.0),
  // Bone and horn keep their own baked colour — a skull should not take the
  // creature's fur tint, so their tint weight is low.
  /* BONE      */ M(LAYER.BONE,   4.5, 0.95, 0.0, 0.10, 0, 0.25),
  /* HORN      */ M(LAYER.HORN,   5.5, 0.70, 0.0, 0.08, 0, 0.35),
  /* SCALE     */ M(LAYER.HIDE,  14.0, 0.55, 0.1, 0.04, 0, 1.0),
  /* IRON      */ M(LAYER.METAL,  7.0, 0.60, 1.0, 0.00, 0, 0.55, 0.22),
  /* GOLD      */ M(LAYER.METAL,  7.0, 0.35, 1.0, 0.00, 0, 0.85),
  /* CLOTH     */ M(LAYER.CLOTH,  4.5, 1.00, 0.0, 0.30, 0, 1.0, 0.45),
  /* WOOD      */ M(LAYER.PLANK,  1.2, 1.00, 0.0, 0.00, 0, 0.9),
  /* BARK      */ M(LAYER.BARK,   1.2, 1.00, 0.0, 0.00, 0, 0.90),
  /* LEAF      */ M(LAYER.LEAF,   1.8, 0.95, 0.0, 0.85, 0, 0.90),
  /* STONE     */ M(LAYER.ROCK,   0.55, 1.00, 0.0, 0.00, 0, 0.8),
  /* MASONRY   */ M(LAYER.BRICK,  0.42, 1.00, 0.0, 0.00, 0, 0.8),
  /* THATCH    */ M(LAYER.THATCH, 0.80, 1.00, 0.0, 0.25, 0, 0.9),
  /* SAND      */ M(LAYER.SAND,   0.30, 1.00, 0.0, 0.00, 0, 0.8),
  /* SNOW      */ M(LAYER.SNOW,   0.30, 0.80, 0.0, 0.20, 0, 0.7),
  /* GRASS     */ M(LAYER.GRASS,  0.26, 1.00, 0.0, 0.40, 0, 1.0),
  /* DIRT      */ M(LAYER.DIRT,   0.35, 1.00, 0.0, 0.00, 0, 0.9),
  /* GEM       */ M(LAYER.GEM,    3.0, 0.35, 0.2, 0.55, 0.6, 0.9),
  /* EMBER     */ M(LAYER.METAL,  3.0, 1.00, 0.0, 0.00, 4.5, 1.0),
  /* PORTAL    */ M(LAYER.GEM,    2.0, 0.60, 0.0, 0.40, 4.0, 1.0),
];

/**
 * Palette index (the `mode - 100` value props batch by) → material ID.
 * `surface` distinguishes outdoor props from dungeon interiors, which is the
 * only case where one palette index means two different things: rough boulders
 * outdoors, cut masonry underground.
 */
export function paletteMaterial(palette: number, surface: boolean): MaterialId {
  switch (palette) {
    case 0:  return surface ? MAT.STONE : MAT.MASONRY;
    case 1:  return MAT.WOOD;
    case 2:  return MAT.EMBER;
    case 3:  return MAT.PORTAL;
    case 4:  return MAT.THATCH;
    case 5:  return MAT.MASONRY;
    case 6:  return MAT.LEAF;
    case 7:  return MAT.LEAF;
    case 8:  return MAT.WOOD;
    case 9:  return MAT.CLOTH;
    case 10: return MAT.MASONRY;
    case 11: return MAT.CLOTH;
    // 12..20 were appended for building interiors. Mirrors
    // `paletteMaterialId()` in shaders/dungeon.wgsl — keep the two in step.
    case 12: return MAT.IRON;      // dark iron
    case 13: return MAT.CLOTH;     // blue-dyed wool
    case 14: return MAT.CLOTH;     // green-dyed wool
    case 15: return MAT.MASONRY;   // fired clay
    case 16: return MAT.LEATHER;   // tanned leather
    case 17: return MAT.GOLD;      // brass fittings
    case 18: return MAT.STONE;     // soot / charcoal
    case 19: return MAT.WOOD;      // pale limewashed timber
    case 20: return MAT.CLOTH;     // beeswax reads as matte tallow
    case 21: return MAT.FELT;      // limewashed felt: interior walls
    default: return MAT.PORTAL;    // 22: daylight window pane
  }
}

/** Pack the table for upload. */
export function packMaterialTable(): Float32Array<ArrayBuffer> {
  const data = new Float32Array(MAX_MATERIALS * MATERIAL_ROW_FLOATS);
  MATERIAL_TABLE.forEach((m, i) => {
    const o = i * MATERIAL_ROW_FLOATS;
    data[o + 0] = m.layer;
    data[o + 1] = m.texScale;
    data[o + 2] = m.roughness;
    data[o + 3] = m.metallic;
    data[o + 4] = m.translucency;
    data[o + 5] = m.emissive;
    data[o + 6] = m.tint;
    data[o + 7] = m.detail;
  });
  return data;
}

if (MATERIAL_TABLE.length > MAX_MATERIALS) {
  throw new Error(
    `MATERIAL_TABLE has ${MATERIAL_TABLE.length} rows, cap is ${MAX_MATERIALS}`);
}
