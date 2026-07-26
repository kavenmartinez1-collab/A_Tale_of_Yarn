/**
 * Stylized tree mesh — tapered trunk cylinder + overlapping canopy sphere
 * blobs, position+normal triangle soup (see mesh-utils.ts) at scale 1
 * (per-instance scale/yaw ride the instance buffer, applied in tree.wgsl).
 * The shader colors by local height: below the canopy line it's bark, above
 * it's leaves — no per-vertex color needed.
 */

import { cylinder, sphere } from './mesh-utils';

/** Local y below which tree.wgsl shades bark instead of leaves. */
export const TRUNK_TOP = 2.0;

export function buildTreeMesh(): Float32Array<ArrayBuffer> {
  const verts: number[] = [];
  // Tapered trunk, base radius 0.22 -> 0.12 near the top, rising into the
  // canopy (no top cap needed — it's buried inside the lowest canopy blob).
  cylinder(verts, 0, 0, 0, 0.22, 0.12, TRUNK_TOP + 0.4, 7, true, false);
  // Canopy: 4 overlapping blobs (segments 7, rings 4) for a round, irregular
  // silhouette spanning y~2.0..4.6, half-width ~1.1 — matches tree.wgsl's
  // TRUNK_TOP/CROWN_TOP wind-sway and self-shading range.
  sphere(verts, 0, 3.2, 0, 1.15, 7, 4, 1.0, 1.0);
  sphere(verts, -0.55, 2.95, 0.4, 0.85, 7, 4, 0.9, 1.0);
  sphere(verts, 0.6, 3.05, -0.45, 0.8, 7, 4, 0.85, 0.95);
  sphere(verts, 0.1, 3.95, 0.3, 0.7, 7, 4, 0.8, 0.85);
  return Float32Array.from(verts) as Float32Array<ArrayBuffer>;
}
