/**
 * Resource-node meshes — world-space triangle soup for rocks, berry bushes,
 * and Phase F2 biome-specific nodes. Palette-batched for the dungeon
 * pipeline's sun-lit surface path (mode 100+palette, zeroed lights),
 * exactly like settlement meshes.
 *
 * Palette assignments:
 *   0  stone (rock, ore_rock)
 *   1  sand/earth (barrel cactus body)
 *   2  dark green (reeds, flax stem)
 *   3  warm orange (warming_herb flower)
 *   4  cool cyan (cooling_herb flower)
 *   5  mushroom cap (brown-orange)
 *   6  bush leaf
 *   7  berry red
 *   8  ore fleck tint (copper-ish, for ore_rock accent)
 *   9  gourd body
 */

import { box, cylinder, sphere } from './mesh-utils';
import type { ResourceInstance } from './resource-scatter';

export const PAL_ROCK   = 0;
export const PAL_EARTH  = 1;
export const PAL_GREEN  = 2;
export const PAL_WARM   = 3;
export const PAL_COOL   = 4;
export const PAL_MUSH   = 5;
export const PAL_LEAF   = 6;
export const PAL_BERRY  = 7;
export const PAL_ORE    = 8;
export const PAL_GOURD  = 9;

/**
 * Lumpy boulder: 3 overlapping low-poly spheres with non-uniform Y/Z scale
 * so the cluster reads as a craggy rock rather than a smooth ball. Shared by
 * 'rock' and 'ore_rock' (which adds fleck accents on top).
 */
function addBoulder(rock: number[], x: number, y: number, z: number, s: number): void {
  sphere(rock, x, y + 0.42 * s, z, 0.50 * s, 6, 4, 0.85, 0.95);
  sphere(rock, x + 0.23 * s, y + 0.56 * s, z - 0.16 * s, 0.40 * s, 6, 4, 0.9, 0.8);
  sphere(rock, x - 0.20 * s, y + 0.30 * s, z + 0.22 * s, 0.34 * s, 6, 4, 0.75, 0.9);
}

/** Batch visible (unharvested) nodes into palette draw calls. */
export function buildResourceMeshes(
  nodes: ResourceInstance[],
): { palette: number; verts: Float32Array<ArrayBuffer> }[] {
  const buckets = new Map<number, number[]>();
  const get = (pal: number): number[] => {
    let b = buckets.get(pal);
    if (b === undefined) {
      b = [];
      buckets.set(pal, b);
    }
    return b;
  };

  for (const n of nodes) {
    const s = n.scale;

    switch (n.type) {
      case 'rock': {
        addBoulder(get(PAL_ROCK), n.x, n.y, n.z, s);
        break;
      }
      case 'ore_rock': {
        // Rock body (same shape as plain rock).
        addBoulder(get(PAL_ROCK), n.x, n.y, n.z, s);
        // Ore fleck accent boxes embedded in the face — tiny and numerous
        // enough per-chunk that boxes stay cheaper than spheres here.
        const ore = get(PAL_ORE);
        const r = 0.10 * s;
        for (const [ox, oy, oz] of [[0.20, 0.45, 0.46], [-0.25, 0.65, 0.31], [0.10, 0.30, -0.61]]) {
          box(ore,
            n.x + ox * s - r, n.y + oy * s - r, n.z + oz * s - r,
            n.x + ox * s + r, n.y + oy * s + r, n.z + oz * s + r);
        }
        break;
      }
      case 'bush': {
        const leaf = get(PAL_LEAF);
        sphere(leaf, n.x, n.y + 0.34 * s, n.z, 0.46 * s, 6, 4, 0.9, 1.0);
        // Three berry clusters straddling the canopy faces so they bulge out.
        const berry = get(PAL_BERRY);
        const spots: [number, number, number][] = [
          [0.28, 0.42, 0.44], [-0.44, 0.30, 0.14], [0.08, 0.55, -0.42],
        ];
        for (const [ox, oy, oz] of spots) {
          sphere(berry, n.x + ox * s, n.y + oy * s, n.z + oz * s, 0.11 * s, 6, 4);
        }
        break;
      }
      case 'flax': {
        // Slender tuft — a few thin stem cylinders with a small flower top.
        const stem = get(PAL_GREEN);
        for (const [ox, oz] of [[-0.06, 0], [0, 0.07], [0.07, -0.04]]) {
          cylinder(stem, n.x + ox * s, n.y, n.z + oz * s, 0.045 * s, 0.03 * s, 0.8 * s, 6, false, false);
        }
        // Flower tops (cool blue tint reusing PAL_COOL)
        const fl = get(PAL_COOL);
        for (const [ox, oz] of [[-0.06, 0], [0, 0.07], [0.07, -0.04]]) {
          sphere(fl, n.x + ox * s, n.y + 0.86 * s, n.z + oz * s, 0.08 * s, 6, 4);
        }
        break;
      }
      case 'mushroom': {
        // Stubby stem cylinder + domed, squashed cap.
        const stem = get(PAL_ROCK); // pale / stone palette for stem
        cylinder(stem, n.x, n.y, n.z, 0.11 * s, 0.09 * s, 0.32 * s, 6, false, false);
        const cap = get(PAL_MUSH);
        sphere(cap, n.x, n.y + 0.38 * s, n.z, 0.40 * s, 6, 4, 0.55, 1.0);
        break;
      }
      case 'cooling_herb': {
        // Low tuft with a cool-tinted flower blob.
        const stem = get(PAL_GREEN);
        cylinder(stem, n.x, n.y, n.z, 0.17 * s, 0.14 * s, 0.45 * s, 6, false, false);
        const fl = get(PAL_COOL);
        sphere(fl, n.x, n.y + 0.48 * s, n.z, 0.20 * s, 6, 4);
        break;
      }
      case 'warming_herb': {
        // Low tuft with a warm-tinted flower blob.
        const stem = get(PAL_GREEN);
        cylinder(stem, n.x, n.y, n.z, 0.17 * s, 0.14 * s, 0.45 * s, 6, false, false);
        const fl = get(PAL_WARM);
        sphere(fl, n.x, n.y + 0.48 * s, n.z, 0.20 * s, 6, 4);
        break;
      }
      case 'barrel_cactus': {
        // Ribbed barrel body flaring slightly outward, topped by a rounded
        // crown cap (the seam between the two is capped, reading as a rib).
        const body = get(PAL_GREEN);
        cylinder(body, n.x, n.y, n.z, 0.30 * s, 0.32 * s, 0.60 * s, 7, true, false);
        cylinder(body, n.x, n.y + 0.60 * s, n.z, 0.34 * s, 0.20 * s, 0.20 * s, 7, true, true);
        break;
      }
      case 'reeds': {
        // Three thin stem cylinders slightly offset.
        const reed = get(PAL_GREEN);
        for (const [ox, oz] of [[-0.10, 0], [0.06, -0.08], [0.04, 0.10]]) {
          cylinder(reed, n.x + ox * s, n.y, n.z + oz * s, 0.05 * s, 0.035 * s, 1.2 * s, 6, false, false);
        }
        // Seed heads — small Y-stretched spheres.
        const head = get(PAL_EARTH);
        for (const [ox, oz] of [[-0.10, 0], [0.06, -0.08], [0.04, 0.10]]) {
          sphere(head, n.x + ox * s, n.y + 1.27 * s, n.z + oz * s, 0.09 * s, 6, 4, 1.3, 1.0);
        }
        break;
      }
      case 'gourd': {
        // Round squat body with a short stem cylinder.
        const body = get(PAL_GOURD);
        sphere(body, n.x, n.y + 0.30 * s, n.z, 0.38 * s, 6, 4, 0.75, 1.0);
        const stem = get(PAL_GREEN);
        cylinder(stem, n.x, n.y + 0.50 * s, n.z, 0.06 * s, 0.05 * s, 0.20 * s, 6, false, false);
        break;
      }
    }
  }

  return [...buckets.entries()]
    .filter(([, v]) => v.length > 0)
    .map(([palette, v]) => ({ palette, verts: new Float32Array(v) }));
}
