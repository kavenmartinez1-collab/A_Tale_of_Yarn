/**
 * Variant tree meshes for cactus and jungle kinds (Phase F2).
 *
 * Each returns a position-only Float32Array triangle soup at scale 1,
 * matching the layout of tree-mesh.ts. The tree.wgsl shader uses local Y to
 * decide bark vs. leaf colour; variants extend the same convention:
 *   - Cactus:  everything is "bark" (low TRUNK_TOP) — green cactus material.
 *   - Jungle:  taller trunk, wider dark canopy — TRUNK_TOP raised.
 *
 * The shader's TRUNK_TOP constant (2.0) still governs the colour split for
 * oak and cactus.  Jungle trees pass JUNGLE_TRUNK_TOP so the shader receives
 * a higher leaf-start threshold via the instance w.z channel — but since
 * the shader only reads x/y/z/scale we encode the extra info in a slightly
 * taller/wider mesh rather than a shader change, keeping zero shader edits.
 */

import { box } from './mesh-utils';

/** Cactus mesh: narrow tall column with two short arms. Scale 1. */
export function buildCactusMesh(): Float32Array<ArrayBuffer> {
  const verts: number[] = [];
  // Main column
  box(verts, -0.22, 0,    -0.22, 0.22, 3.5,  0.22);
  // Left arm (lower)
  box(verts, -0.85, 1.2,  -0.15, -0.22, 1.55, 0.15);
  box(verts, -0.85, 1.55, -0.15, -0.55, 2.1,  0.15);
  // Right arm (slightly higher)
  box(verts,  0.22, 1.6,  -0.15,  0.85, 1.95, 0.15);
  box(verts,  0.55, 1.95, -0.15,  0.85, 2.5,  0.15);
  return Float32Array.from(verts) as Float32Array<ArrayBuffer>;
}

/** Jungle tree mesh: taller trunk + wider, lower, darker canopy. Scale 1. */
export function buildJungleMesh(): Float32Array<ArrayBuffer> {
  const verts: number[] = [];
  // Trunk (taller than oak)
  box(verts, -0.20, 0,    -0.20, 0.20, 3.2,   0.20);
  // Buttress roots (aesthetic base flanges)
  box(verts, -0.40, 0,    -0.12, -0.20, 0.70, 0.12);
  box(verts,  0.20, 0,    -0.12,  0.40, 0.70, 0.12);
  box(verts, -0.12, 0,    -0.40,  0.12, 0.70, -0.20);
  box(verts, -0.12, 0,     0.20,  0.12, 0.70,  0.40);
  // Wide lower canopy
  box(verts, -1.4, 2.8,  -1.4, 1.4, 4.2,  1.4);
  // Slightly narrower upper crown
  box(verts, -0.85, 4.2, -0.85, 0.85, 5.4, 0.85);
  return Float32Array.from(verts) as Float32Array<ArrayBuffer>;
}
