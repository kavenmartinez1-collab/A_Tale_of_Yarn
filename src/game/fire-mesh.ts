/**
 * Fire-pit and tent mesh builders — palette-batched triangle soup for the
 * dungeon pipeline's surface path (same as resource-mesh.ts / settlement-mesh.ts).
 *
 * This file builds only the SOLID parts of a fire: the stone ring, the logs,
 * the forge chimney. Every actual flame, ember, coal glow and smoke column now
 * lives in `render/fire-fx.ts` as additive billboards — dragon breath and
 * burning vegetation moved there wholesale, and `buildFireMeshes` no longer
 * emits the three stacked emissive boxes it used to call a campfire flame.
 * See the art-direction note at the top of shaders/flame.wgsl.
 *
 * Palette assignments — dungeon shader palette indices (surface mode: mode = 100 + palIndex):
 *   0  stone (ring / chimney) — existing dungeon stone palette
 *   1  wood  (logs)           — existing dungeon wood palette
 *   4  thatch — used for tent cloth (fiber): warm straw tint
 *   5  plaster — used for tent cloth (wool): off-white
 *   6  bush-leaf — used for tent cloth (hide): green-ish; we'd prefer brown but
 *      the palette is fixed; hide tents render as leaf-green (acceptable in blocky style)
 */

import { box, capsule, cylinder, sphere } from './mesh-utils';
import type { PlacedFire } from './fire';
import { tentBox, type PlacedTent } from './shelter';

// Palette ids fed to buildFireMeshes / buildTentMeshes (dungeon shader palette indices).
export const PAL_FIRE_STONE = 0;  // stone grey (ring, chimney)
/**
 * Dark furniture wood (0.34, 0.22, 0.12) rather than the lighter wood palette
 * 1: these logs sit inside a point light at point-blank range, and the pale
 * wood tint blew straight out to bone-white. Charred logs are also just what
 * firewood looks like once it is alight.
 */
export const PAL_FIRE_LOG   = 8;
export const PAL_TENT_FIBER = 4;  // thatch (warm straw for fiber tent)
export const PAL_TENT_WOOL  = 5;  // plaster off-white (wool tent)
export const PAL_TENT_HIDE  = 6;  // leaf-green (closest available for hide tent)
export const PAL_TENT_POLE  = 1;  // wood brown (reuse wood palette for poles)

/**
 * Build batched meshes for all placed fires.
 *
 * Only the hearth furniture: a stone ring, crossed logs, and a forge chimney.
 * Flames are billboards emitted per frame by FireFX, so this no longer depends
 * on which fires are lit — a lit and an unlit campfire are the same object,
 * and the fire on top of it is a separate, per-frame thing. That also removes
 * the old 5-second lag between a fire burning out and its flame disappearing.
 */
export function buildFireMeshes(
  fires: PlacedFire[],
): { palette: number; verts: Float32Array<ArrayBuffer> }[] {
  const buckets = new Map<number, number[]>();
  const get = (pal: number): number[] => {
    let b = buckets.get(pal);
    if (b === undefined) { b = []; buckets.set(pal, b); }
    return b;
  };

  for (const f of fires) {
    const { x, y, z, kind } = f;

    // --- Stone ring (small squashed stones around the fire pit) ---
    const stone = get(PAL_FIRE_STONE);
    const sr = 0.38; // stone ring radius
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      sphere(stone, x + Math.cos(a) * sr, y + 0.07, z + Math.sin(a) * sr,
        0.12 + (i % 2) * 0.03, 6, 4, 0.55, 1.0);
    }

    // --- Crossed logs (capsules laid at a slight angle) ---
    // Three now rather than two: the coal-bed billboard glows up through the
    // gaps between them, and two sticks left the pit looking empty.
    const log = get(PAL_FIRE_LOG);
    capsule(log, x - 0.45, y + 0.03, z - 0.07, x + 0.45, y + 0.07, z + 0.04, 0.055, 6);
    capsule(log, x - 0.05, y + 0.10, z - 0.45, x + 0.06, y + 0.16, z + 0.45, 0.055, 6);
    capsule(log, x - 0.34, y + 0.06, z + 0.30, x + 0.32, y + 0.13, z - 0.28, 0.045, 6);

    // --- Forge chimney (tapered stone stack) ---
    if (kind === 'forge') {
      cylinder(stone, x, y + 0.18, z, 0.28, 0.20, 0.57, 6);
    }
  }

  return [...buckets.entries()]
    .filter(([, v]) => v.length > 0)
    .map(([palette, v]) => ({ palette, verts: new Float32Array(v) }));
}

/**
 * Build batched meshes for all placed tents.
 * Each tent is a triangular prism (cloth body) + two round pole cylinders.
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

    // Footprint comes from shelter.ts's TENT_BOX, NOT from literals here.
    // `tentRoofAt` tests the player against exactly these numbers to decide
    // whether the rain stops, so a tent drawn one size and sheltering another
    // is a bug the player experiences as rain falling through canvas. One
    // table, two readers.
    const b = tentBox(t);
    const hx = b.hx;          // half-width  (X)
    const hz = b.hz;          // half-depth  (Z)
    const ridge = b.h;        // ridge height (Y)
    // The canvas stops a hand's breadth inside the box on each axis so the
    // shelter test never fires on a point outside the visible cloth.
    const wallZ = hz - 0.1;
    const eave = ridge * 0.94;

    // Triangular prism tent body approximated with 3 boxes (flat canvas
    // panels — boxes are the right primitive here, no round shape fits):
    // - Left sloped panel
    box(cloth, x - hx, y,        z - wallZ, x - 0.05, y + eave, z + wallZ);
    // - Right sloped panel (slightly overlapping the left to fill the ridge)
    box(cloth, x + 0.05, y,      z - wallZ, x + hx,   y + eave, z + wallZ);
    // - Ridge cap
    box(cloth, x - 0.15, y + eave - 0.2, z - hz, x + 0.15, y + ridge, z + hz);

    // Front and back triangular end faces (approximated as tapered boxes)
    box(cloth, x - hx * 0.67, y, z - hz,          x + hx * 0.67, y + ridge * 0.47, z - wallZ);
    box(cloth, x - hx * 0.67, y, z + wallZ,       x + hx * 0.67, y + ridge * 0.47, z + hz);

    // Centre poles (front + back) — round cylinders instead of square posts.
    cylinder(pole, x, y, z - wallZ + 0.01, 0.06, 0.04, ridge - 0.05, 6, false, true);
    cylinder(pole, x, y, z + wallZ - 0.01, 0.06, 0.04, ridge - 0.05, 6, false, true);
  }

  return [...buckets.entries()]
    .filter(([, v]) => v.length > 0)
    .map(([palette, v]) => ({ palette, verts: new Float32Array(v) }));
}
