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

import { box } from './mesh-utils';
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
        const rock = get(PAL_ROCK);
        // Two offset boxes read as a craggy boulder under flat shading.
        box(rock,
          n.x - 0.55 * s, n.y, n.z - 0.45 * s,
          n.x + 0.55 * s, n.y + 0.75 * s, n.z + 0.45 * s);
        box(rock,
          n.x - 0.30 * s, n.y, n.z - 0.60 * s,
          n.x + 0.45 * s, n.y + 1.05 * s, n.z + 0.30 * s);
        break;
      }
      case 'ore_rock': {
        // Rock body (same shape as plain rock).
        const rock = get(PAL_ROCK);
        box(rock,
          n.x - 0.55 * s, n.y, n.z - 0.45 * s,
          n.x + 0.55 * s, n.y + 0.75 * s, n.z + 0.45 * s);
        box(rock,
          n.x - 0.30 * s, n.y, n.z - 0.60 * s,
          n.x + 0.45 * s, n.y + 1.05 * s, n.z + 0.30 * s);
        // Ore fleck accent boxes embedded in the face.
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
        box(leaf,
          n.x - 0.45 * s, n.y, n.z - 0.45 * s,
          n.x + 0.45 * s, n.y + 0.65 * s, n.z + 0.45 * s);
        // Three berry clusters straddling the canopy faces so they bulge out.
        const berry = get(PAL_BERRY);
        const spots: [number, number, number][] = [
          [0.28, 0.42, 0.44], [-0.44, 0.30, 0.14], [0.08, 0.55, -0.42],
        ];
        for (const [ox, oy, oz] of spots) {
          const r = 0.13 * s;
          box(berry,
            n.x + ox * s - r, n.y + oy * s - r, n.z + oz * s - r,
            n.x + ox * s + r, n.y + oy * s + r, n.z + oz * s + r);
        }
        break;
      }
      case 'flax': {
        // Slender tuft — a few thin vertical boxes with a small flower top.
        const stem = get(PAL_GREEN);
        for (const [ox, oz] of [[-0.06, 0], [0, 0.07], [0.07, -0.04]]) {
          box(stem,
            n.x + ox * s - 0.04 * s, n.y, n.z + oz * s - 0.04 * s,
            n.x + ox * s + 0.04 * s, n.y + 0.8 * s, n.z + oz * s + 0.04 * s);
        }
        // Flower tops (cool blue tint reusing PAL_COOL)
        const fl = get(PAL_COOL);
        const fr = 0.07 * s;
        for (const [ox, oz] of [[-0.06, 0], [0, 0.07], [0.07, -0.04]]) {
          box(fl,
            n.x + ox * s - fr, n.y + 0.78 * s, n.z + oz * s - fr,
            n.x + ox * s + fr, n.y + 0.98 * s, n.z + oz * s + fr);
        }
        break;
      }
      case 'mushroom': {
        // Stubby stem + domed cap.
        const stem = get(PAL_ROCK); // pale / stone palette for stem
        box(stem,
          n.x - 0.12 * s, n.y, n.z - 0.12 * s,
          n.x + 0.12 * s, n.y + 0.35 * s, n.z + 0.12 * s);
        const cap = get(PAL_MUSH);
        box(cap,
          n.x - 0.40 * s, n.y + 0.30 * s, n.z - 0.40 * s,
          n.x + 0.40 * s, n.y + 0.60 * s, n.z + 0.40 * s);
        break;
      }
      case 'cooling_herb': {
        // Low tufts with cool-tinted flower blobs.
        const stem = get(PAL_GREEN);
        box(stem,
          n.x - 0.18 * s, n.y, n.z - 0.18 * s,
          n.x + 0.18 * s, n.y + 0.45 * s, n.z + 0.18 * s);
        const fl = get(PAL_COOL);
        box(fl,
          n.x - 0.22 * s, n.y + 0.38 * s, n.z - 0.22 * s,
          n.x + 0.22 * s, n.y + 0.62 * s, n.z + 0.22 * s);
        break;
      }
      case 'warming_herb': {
        // Low tufts with warm-tinted flower blobs.
        const stem = get(PAL_GREEN);
        box(stem,
          n.x - 0.18 * s, n.y, n.z - 0.18 * s,
          n.x + 0.18 * s, n.y + 0.45 * s, n.z + 0.18 * s);
        const fl = get(PAL_WARM);
        box(fl,
          n.x - 0.22 * s, n.y + 0.38 * s, n.z - 0.22 * s,
          n.x + 0.22 * s, n.y + 0.62 * s, n.z + 0.22 * s);
        break;
      }
      case 'barrel_cactus': {
        // Short squat ribbed cylinder-ish box.
        const body = get(PAL_GREEN);
        box(body,
          n.x - 0.30 * s, n.y, n.z - 0.30 * s,
          n.x + 0.30 * s, n.y + 0.70 * s, n.z + 0.30 * s);
        // Top cap (slightly wider)
        box(body,
          n.x - 0.34 * s, n.y + 0.62 * s, n.z - 0.34 * s,
          n.x + 0.34 * s, n.y + 0.80 * s, n.z + 0.34 * s);
        break;
      }
      case 'reeds': {
        // Three thin vertical boxes slightly offset.
        const reed = get(PAL_GREEN);
        for (const [ox, oz] of [[-0.10, 0], [0.06, -0.08], [0.04, 0.10]]) {
          box(reed,
            n.x + ox * s - 0.05 * s, n.y, n.z + oz * s - 0.05 * s,
            n.x + ox * s + 0.05 * s, n.y + 1.2 * s, n.z + oz * s + 0.05 * s);
        }
        // Seed heads
        const head = get(PAL_EARTH);
        for (const [ox, oz] of [[-0.10, 0], [0.06, -0.08], [0.04, 0.10]]) {
          box(head,
            n.x + ox * s - 0.07 * s, n.y + 1.15 * s, n.z + oz * s - 0.07 * s,
            n.x + ox * s + 0.07 * s, n.y + 1.40 * s, n.z + oz * s + 0.07 * s);
        }
        break;
      }
      case 'gourd': {
        // Round squat body with a short stem.
        const body = get(PAL_GOURD);
        box(body,
          n.x - 0.38 * s, n.y, n.z - 0.38 * s,
          n.x + 0.38 * s, n.y + 0.55 * s, n.z + 0.38 * s);
        // Stem nub on top
        const stem = get(PAL_GREEN);
        box(stem,
          n.x - 0.06 * s, n.y + 0.52 * s, n.z - 0.06 * s,
          n.x + 0.06 * s, n.y + 0.72 * s, n.z + 0.06 * s);
        break;
      }
    }
  }

  return [...buckets.entries()]
    .filter(([, v]) => v.length > 0)
    .map(([palette, v]) => ({ palette, verts: new Float32Array(v) }));
}
