/**
 * Loom mesh builder — palette-batched triangle soup for the dungeon
 * pipeline's surface path, exactly like `fire-mesh.ts`.
 *
 * Same contract as every other placeable: 24-byte stride (pos3 + normal3),
 * geometry baked in WORLD space, one batch per palette index, drawn with
 * `mode = 100 + palette`. Nothing new was added to the renderer for this — a
 * new vertex layout would have needed its own shadow pipeline, and a loom is
 * not worth a pipeline.
 *
 * Palette indices (see shaders/dungeon.wgsl `palette()`):
 *   8   furniture wood — the frame. Dark, because a loom lives indoors and the
 *       lighter wood palette 1 blows out under a nearby campfire the same way
 *       the firewood did.
 *   11  wool/linen — the warp and the woven cloth on the beam. This is the one
 *       object in the game that is literally made of the material the whole art
 *       direction is named after, so it gets the wool value and not a tint of
 *       the wood.
 *   12  dark iron — the heddle rod. Small, and the reason the loom is a FORGE
 *       product: it is the one part you cannot whittle.
 *
 * A loom has a front, so unlike tents these meshes are yawed. `box` and
 * `cylinder` are axis-aligned only, so the shape is built in local space and
 * the finished vertices are rotated on the way into the bucket — positions and
 * normals both, or every lit face would face the wrong way.
 */

import { box } from './mesh-utils';
import type { PlacedLoom } from './loom';

export const PAL_LOOM_FRAME = 8;   // furniture wood
export const PAL_LOOM_WARP  = 11;  // wool / linen
export const PAL_LOOM_IRON  = 12;  // dark iron

/** Overall size, in metres. A floor loom you stand at, not a tabletop toy. */
export const LOOM_HEIGHT = 1.9;
export const LOOM_HALF_W = 0.72;
export const LOOM_HALF_D = 0.45;

/**
 * Append `local` (pos3+normal3, origin at the loom's base centre, facing +Z)
 * into `out`, rotated by `yaw` about Y and translated to (x, y, z).
 */
function emitRotated(
  out: number[],
  local: readonly number[],
  x: number, y: number, z: number,
  yaw: number,
): void {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  for (let i = 0; i < local.length; i += 6) {
    const px = local[i], py = local[i + 1], pz = local[i + 2];
    const nx = local[i + 3], ny = local[i + 4], nz = local[i + 5];
    out.push(
      x + px * c + pz * s,
      y + py,
      z - px * s + pz * c,
      nx * c + nz * s,
      ny,
      -nx * s + nz * c,
    );
  }
}

/**
 * Build batched meshes for all placed looms.
 *
 * Returns the same shape `buildFireMeshes` / `buildTentMeshes` return, so
 * main.ts's rebuild loop is a copy of `rebuildFireDraws` with the builder
 * swapped.
 */
export function buildLoomMeshes(
  looms: readonly PlacedLoom[],
): { palette: number; verts: Float32Array<ArrayBuffer> }[] {
  const buckets = new Map<number, number[]>();
  const get = (pal: number): number[] => {
    let b = buckets.get(pal);
    if (b === undefined) { b = []; buckets.set(pal, b); }
    return b;
  };

  for (const l of looms) {
    const frame: number[] = [];
    const warp: number[] = [];
    const iron: number[] = [];

    // --- Frame: two uprights on splayed feet, a top beam and a cloth beam ---
    box(frame, -0.72, 0, -0.07, -0.58, LOOM_HEIGHT, 0.07);
    box(frame,  0.58, 0, -0.07,  0.72, LOOM_HEIGHT, 0.07);
    // Feet, front-to-back, so the thing does not read as floating.
    box(frame, -0.78, 0, -LOOM_HALF_D, -0.52, 0.10, LOOM_HALF_D);
    box(frame,  0.52, 0, -LOOM_HALF_D,  0.78, 0.10, LOOM_HALF_D);
    // Warp beam at the top, cloth beam at waist height.
    box(frame, -0.74, LOOM_HEIGHT - 0.14, -0.08, 0.74, LOOM_HEIGHT, 0.08);
    box(frame, -0.74, 0.34, -0.09, 0.74, 0.48, 0.09);
    // The shuttle, parked on the cloth beam. One box, and it is what turns a
    // rectangle into a tool somebody uses.
    box(frame, 0.18, 0.48, -0.05, 0.46, 0.54, 0.05);

    // --- Warp: threads strung from the top beam down to the cloth beam ------
    for (let i = 0; i < 9; i++) {
      const wx = -0.48 + i * 0.12;
      box(warp, wx - 0.012, 0.46, -0.012, wx + 0.012, LOOM_HEIGHT - 0.13, 0.012);
    }
    // The finished cloth, rolled onto the beam — the thing you came for.
    box(warp, -0.56, 0.20, -0.11, 0.56, 0.36, 0.11);

    // --- Iron: the heddle rod, holding the shed open ------------------------
    box(iron, -0.66, 1.14, -0.06, 0.66, 1.21, 0.06);

    emitRotated(get(PAL_LOOM_FRAME), frame, l.x, l.y, l.z, l.yaw);
    emitRotated(get(PAL_LOOM_WARP),  warp,  l.x, l.y, l.z, l.yaw);
    emitRotated(get(PAL_LOOM_IRON),  iron,  l.x, l.y, l.z, l.yaw);
  }

  return [...buckets.entries()]
    .filter(([, v]) => v.length > 0)
    .map(([palette, v]) => ({ palette, verts: new Float32Array(v) }));
}
