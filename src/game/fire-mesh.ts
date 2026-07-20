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
import { MAX_BURNING, type BurningTree, type PlacedFire } from './fire';
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

/** Deterministic 0..1 hash for breath-cone jitter. */
function jitter01(a: number, b: number): number {
  let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

/** Breath cone geometry: matches the damage cone in main.ts. */
export const BREATH_RANGE = 20;       // m
export const BREATH_HALF_ANGLE = 0.32; // rad (~18°)
/** Max floats buildBreathMesh can emit (boxes × 36 verts × 3 floats). */
export const BREATH_MAX_FLOATS = 34 * 36 * 3;

/**
 * Dragon fire-breath cone — jittered emissive boxes (palette PAL_FIRE_FLAME)
 * from the mouth outward along a 3D aim direction. Rebuilt every frame while
 * breathing; `t` drives the flicker/jitter animation.
 */
export function buildBreathMesh(
  mouth: [number, number, number],
  dir: [number, number, number],
  t: number,
): Float32Array<ArrayBuffer> {
  const [mx, my, mz] = mouth;
  const [dx, dy, dz] = dir;
  // Two perpendicular axes spanning the cone cross-section.
  const hl = Math.hypot(dx, dz) || 1;
  const rx = -dz / hl;                 // horizontal right vector
  const rz = dx / hl;
  const ux = -dy * (dx / hl);          // approximate up vector (dir × right)
  const uy = hl;
  const uz = -dy * (dz / hl);
  const frame = Math.floor(t * 20);    // re-jitter at 20 Hz
  const verts: number[] = [];
  const N = 32; // keeps flame density over the 20 m cone
  for (let i = 0; i < N; i++) {
    const f = (i + 0.5) / N;                       // 0 near mouth → 1 at range
    const dist = 0.35 + f * (BREATH_RANGE - 0.35); // starts right at the jaws
    const spread = Math.tan(BREATH_HALF_ANGLE) * dist * 0.85;
    const ja = jitter01(i, frame) * 2 - 1;
    const jb = jitter01(i + 101, frame) * 2 - 1;
    const cx = mx + dx * dist + rx * ja * spread + ux * jb * spread;
    const cy = my + dy * dist + uy * jb * spread * 0.6;
    const cz = mz + dz * dist + rz * ja * spread + uz * jb * spread;
    const size = 0.14 + f * 0.55 + jitter01(i + 202, frame) * 0.12;
    box(verts, cx - size, cy - size, cz - size, cx + size, cy + size, cz + size);
  }
  return new Float32Array(verts);
}

/** Max floats buildBurningVegMesh can emit (items × boxes × 36 verts × 3). */
export const BURNING_VEG_MAX_FLOATS = MAX_BURNING * 5 * 36 * 3;

/**
 * Flames for burning vegetation — jittered emissive boxes (PAL_FIRE_FLAME)
 * up a tree's trunk/canopy or over a bush. Rebuilt every frame while anything
 * burns; `t` drives the 20 Hz flicker.
 */
export function buildBurningVegMesh(
  burning: readonly BurningTree[],
  t: number,
): Float32Array<ArrayBuffer> {
  const frame = Math.floor(t * 20);
  const verts: number[] = [];
  const n = Math.min(burning.length, MAX_BURNING);
  for (let i = 0; i < n; i++) {
    const b = burning[i];
    // Per-item hash seed from world position so flames don't move in lockstep.
    const ph = (Math.floor(b.x * 7) ^ Math.floor(b.z * 13)) | 0;
    if (b.kind === 'bush') {
      for (let k = 0; k < 2; k++) {
        const jx = (jitter01(ph + k, frame) * 2 - 1) * 0.25;
        const jz = (jitter01(ph + k + 51, frame) * 2 - 1) * 0.25;
        const size = 0.30 + jitter01(ph + k + 102, frame) * 0.15;
        const cy = b.y + 0.35 + k * 0.55;
        box(verts, b.x + jx - size, cy - size, b.z + jz - size,
          b.x + jx + size, cy + size, b.z + jz + size);
      }
    } else {
      // Tree: flame column up the trunk into the canopy.
      for (let k = 0; k < 4; k++) {
        const jx = (jitter01(ph + k, frame) * 2 - 1) * 0.55;
        const jz = (jitter01(ph + k + 51, frame) * 2 - 1) * 0.55;
        const size = 0.45 + k * 0.12 + jitter01(ph + k + 102, frame) * 0.20;
        const cy = b.y + 1.2 + k * 1.15;
        box(verts, b.x + jx - size, cy - size, b.z + jz - size,
          b.x + jx + size, cy + size, b.z + jz + size);
      }
    }
  }
  return new Float32Array(verts);
}

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
