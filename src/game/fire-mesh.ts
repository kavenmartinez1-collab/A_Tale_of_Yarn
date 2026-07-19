/**
 * Fire and tent mesh builders — palette-batched triangle soup for the dungeon
 * pipeline's surface path (same as resource-mesh.ts / settlement-mesh.ts).
 *
 * Palette assignments — dungeon shader palette indices (surface mode: mode = 100 + palIndex):
 *   0  stone (ring / chimney) — existing dungeon stone palette
 *   1  wood  (logs)           — existing dungeon wood palette
 *   2  torch-glow (emissive orange) — FLAME for lit fires; emissive, no lighting
 *   3  portal-glow (emissive blue)  — not used here but can be forge ember glow
 *   4  thatch — used for tent cloth (fiber): warm straw tint
 *   5  plaster — used for tent cloth (wool): off-white
 *   6  bush-leaf — used for tent cloth (hide): green-ish; we'd prefer brown but
 *      the palette is fixed; hide tents render as leaf-green (acceptable in blocky style)
 *   7  berry-red — tent poles: reuse existing wood palette (1) instead
 *
 * Rationale for flame = palette 2 (torch-glow):
 *   The dungeon shader recognises palIndex 2 as emissive orange (1.0, 0.75, 0.35)
 *   with a flicker effect — exactly what a campfire flame needs.
 *
 * Forge chimneys use stone (0) plus ember (2 = same emissive glow, dimmed).
 */

import { box } from './mesh-utils';
import type { PlacedFire } from './fire';
import type { PlacedTent } from './shelter';

// Palette ids fed to buildFireMeshes / buildTentMeshes (dungeon shader palette indices).
export const PAL_FIRE_STONE = 0;  // stone grey (ring, chimney)
export const PAL_FIRE_LOG   = 1;  // wood brown (logs)
export const PAL_FIRE_FLAME = 2;  // torch-glow emissive orange — lit fires only
export const PAL_FIRE_EMBER = 3;  // portal-glow emissive — forge ember hint
export const PAL_TENT_FIBER = 4;  // thatch (warm straw for fiber tent)
export const PAL_TENT_WOOL  = 5;  // plaster off-white (wool tent)
export const PAL_TENT_HIDE  = 6;  // leaf-green (closest available for hide tent)
export const PAL_TENT_POLE  = 1;  // wood brown (reuse wood palette for poles)

/**
 * Build batched meshes for all placed fires (lit and unlit).
 * Returns per-palette arrays so the caller can create one DungeonDraw per palette.
 * `litSet` is the set of fire ids that are currently lit (for flame emission).
 */
export function buildFireMeshes(
  fires: PlacedFire[],
  litSet: Set<string>,
): { palette: number; verts: Float32Array<ArrayBuffer> }[] {
  const buckets = new Map<number, number[]>();
  const get = (pal: number): number[] => {
    let b = buckets.get(pal);
    if (b === undefined) { b = []; buckets.set(pal, b); }
    return b;
  };

  for (const f of fires) {
    const { x, y, z, kind } = f;
    const lit = litSet.has(f.id);

    // --- Stone ring (4 stones around the fire pit) ---
    const stone = get(PAL_FIRE_STONE);
    const sr = 0.35; // stone ring radius
    for (const [ox, oz] of [[sr, 0], [-sr, 0], [0, sr], [0, -sr]]) {
      box(stone,
        x + ox - 0.12, y, z + oz - 0.12,
        x + ox + 0.12, y + 0.12, z + oz + 0.12);
    }

    // --- Crossed logs ---
    const log = get(PAL_FIRE_LOG);
    // Log 1: along X axis
    box(log, x - 0.45, y, z - 0.06, x + 0.45, y + 0.09, z + 0.06);
    // Log 2: along Z axis (rotated 90°, approximated as second box)
    box(log, x - 0.06, y + 0.09, z - 0.45, x + 0.06, y + 0.18, z + 0.45);

    // --- Forge chimney (stone block above, slightly offset) ---
    if (kind === 'forge') {
      // Stone chimney stack
      box(stone, x - 0.25, y + 0.18, z - 0.25, x + 0.25, y + 0.55, z + 0.25);
      box(stone, x - 0.20, y + 0.55, z - 0.20, x + 0.20, y + 0.75, z + 0.20);
      // Ember/coal layer
      const ember = get(PAL_FIRE_EMBER);
      box(ember, x - 0.18, y + 0.18, z - 0.18, x + 0.18, y + 0.22, z + 0.18);
    }

    // --- Flame (only for lit fires) ---
    if (lit) {
      const flame = get(PAL_FIRE_FLAME);
      // Central flame cone (3 stacked shrinking boxes)
      box(flame, x - 0.14, y + 0.18, z - 0.14, x + 0.14, y + 0.38, z + 0.14);
      box(flame, x - 0.09, y + 0.38, z - 0.09, x + 0.09, y + 0.55, z + 0.09);
      box(flame, x - 0.05, y + 0.55, z - 0.05, x + 0.05, y + 0.68, z + 0.05);
    }
  }

  return [...buckets.entries()]
    .filter(([, v]) => v.length > 0)
    .map(([palette, v]) => ({ palette, verts: new Float32Array(v) }));
}

/**
 * Build batched meshes for all placed tents.
 * Each tent is a triangular prism (cloth body) + two pole boxes.
 */
export function buildTentMeshes(
  tents: PlacedTent[],
): { palette: number; verts: Float32Array<ArrayBuffer> }[] {
  const buckets = new Map<number, number[]>();
  const get = (pal: number): number[] => {
    let b = buckets.get(pal);
    if (b === undefined) { b = []; buckets.set(pal, b); }
    return b;
  };

  for (const t of tents) {
    const { x, y, z, tier } = t;
    const clothPal = tier === 1 ? PAL_TENT_FIBER : tier === 2 ? PAL_TENT_WOOL : PAL_TENT_HIDE;
    const cloth = get(clothPal);
    const pole  = get(PAL_TENT_POLE);

    // Triangular prism tent body approximated with 3 boxes:
    // - Left sloped panel
    box(cloth, x - 1.2, y,       z - 0.8, x - 0.05, y + 1.6, z + 0.8);
    // - Right sloped panel (slightly overlapping the left to fill the ridge)
    box(cloth, x + 0.05, y,      z - 0.8, x + 1.2,  y + 1.6, z + 0.8);
    // - Ridge cap
    box(cloth, x - 0.15, y + 1.4, z - 0.85, x + 0.15, y + 1.7, z + 0.85);

    // Front and back triangular end faces (approximated as tapered boxes)
    box(cloth, x - 0.8, y, z - 0.9, x + 0.8, y + 0.8, z - 0.80);
    box(cloth, x - 0.8, y, z + 0.80, x + 0.8, y + 0.8, z + 0.9);

    // Centre poles (front + back)
    box(pole, x - 0.06, y, z - 0.82, x + 0.06, y + 1.65, z - 0.76);
    box(pole, x - 0.06, y, z + 0.76, x + 0.06, y + 1.65, z + 0.82);
  }

  return [...buckets.entries()]
    .filter(([, v]) => v.length > 0)
    .map(([palette, v]) => ({ palette, verts: new Float32Array(v) }));
}
