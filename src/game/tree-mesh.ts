/**
 * Stylized tree mesh — trunk box + two stacked canopy boxes, position-only
 * triangle soup at scale 1 (per-instance scale/yaw ride the instance buffer,
 * applied in tree.wgsl). The shader colors by local height: below the canopy
 * line it's bark, above it's leaves — no per-vertex color needed.
 */

import { box } from './mesh-utils';

/** Local y below which tree.wgsl shades bark instead of leaves. */
export const TRUNK_TOP = 2.0;

export function buildTreeMesh(): Float32Array<ArrayBuffer> {
  const verts: number[] = [];
  box(verts, -0.18, 0, -0.18, 0.18, TRUNK_TOP + 0.4, 0.18);  // trunk (into canopy)
  box(verts, -1.1, TRUNK_TOP, -1.1, 1.1, TRUNK_TOP + 1.5, 1.1);   // lower canopy
  box(verts, -0.65, TRUNK_TOP + 1.5, -0.65, 0.65, TRUNK_TOP + 2.5, 0.65); // crown
  return Float32Array.from(verts) as Float32Array<ArrayBuffer>;
}
