/**
 * Baked texture-array layer indices.
 *
 * This module is deliberately **pure** — no imports, no GPU types, no `?raw`
 * WGSL. The CPU mesh builders (character-mesh, animal-mesh) reference material
 * IDs, which reference these layers, and those builders are node-testable by
 * contract. Putting the constants in `materials.ts` next to the GPU atlas made
 * `npx tsx scripts/test-character-mesh.mts` try to load a .wgsl file through
 * Node's module loader and fail.
 *
 * Keep in sync with the `MAT_*` constants in shaders/common.wgsl and the
 * `evalMaterial` switch in shaders/materials.wgsl.
 */

export const MATERIAL_LAYERS = {
  GRASS: 0, DIRT: 1, ROCK: 2, SAND: 3, SNOW: 4, BARK: 5, LEAF: 6, PLANK: 7,
  BRICK: 8, THATCH: 9, CLOTH: 10, HIDE: 11, SKIN: 12, FUR: 13, METAL: 14,
  GEM: 15, KNIT: 16, FELT: 17, BONE: 18, HORN: 19,
} as const;

export const MATERIAL_COUNT = 20;
