/**
 * Variant tree meshes for cactus and jungle kinds (Phase F2).
 *
 * Each returns a position+normal Float32Array triangle soup (see
 * mesh-utils.ts) at scale 1, matching the layout of tree-mesh.ts. The
 * tree.wgsl shader uses local Y to decide bark vs. leaf colour; variants
 * extend the same convention:
 *   - Cactus:  everything is "bark" (low TRUNK_TOP) — green cactus material.
 *   - Jungle:  taller trunk, wider dark canopy — TRUNK_TOP raised.
 *
 * The shader's TRUNK_TOP constant (2.0) still governs the colour split for
 * oak and cactus.  Jungle trees pass JUNGLE_TRUNK_TOP so the shader receives
 * a higher leaf-start threshold via the instance w.z channel — but since
 * the shader only reads x/y/z/scale plus the vertex normal, we encode the
 * extra info in a slightly taller/wider mesh rather than a shader change,
 * keeping zero shader edits.
 */

import { capsule, cylinder, sphere } from './mesh-utils';

/** Cactus mesh: narrow tall column with two short arms. Scale 1. */
export function buildCactusMesh(): Float32Array<ArrayBuffer> {
  const verts: number[] = [];
  // Main column — a plain taper reads "ribbed" enough once lit at 8 segments.
  cylinder(verts, 0, 0, 0, 0.22, 0.20, 3.5, 8);
  // Each arm is an elbow (horizontal stub + vertical riser) built from two
  // capsules sharing a joint point, so the bend stays smoothly rounded
  // instead of a hard box corner.
  // Left arm (lower).
  capsule(verts, -0.22, 1.35, 0, -0.80, 1.35, 0, 0.16, 8);
  capsule(verts, -0.80, 1.35, 0, -0.70, 2.10, 0, 0.15, 8);
  // Right arm (slightly higher).
  capsule(verts, 0.22, 1.75, 0, 0.80, 1.75, 0, 0.16, 8);
  capsule(verts, 0.80, 1.75, 0, 0.70, 2.50, 0, 0.15, 8);
  return Float32Array.from(verts) as Float32Array<ArrayBuffer>;
}

/** Jungle tree mesh: taller trunk + wider, lower, darker canopy. Scale 1. */
export function buildJungleMesh(): Float32Array<ArrayBuffer> {
  const verts: number[] = [];
  // Trunk (taller than oak), slight taper.
  cylinder(verts, 0, 0, 0, 0.20, 0.16, 3.2, 7, true, false);
  // Buttress roots: 4 flared tapered cylinders radiating from the base,
  // wide at the ground and narrowing as they rise to meet the trunk.
  for (const [bx, bz] of [[-0.30, 0], [0.30, 0], [0, -0.30], [0, 0.30]]) {
    cylinder(verts, bx, 0, bz, 0.17, 0.07, 0.75, 6, true, false);
  }
  // Canopy: 3 overlapping blobs — a wide squashed lower mass plus an offset
  // companion for irregularity, and a narrower upper crown.
  sphere(verts, 0, 3.5, 0, 1.4, 7, 4, 0.5, 1.0);
  sphere(verts, -0.45, 3.35, 0.35, 1.05, 7, 4, 0.55, 1.0);
  sphere(verts, 0.05, 4.8, -0.1, 0.85, 7, 4, 0.7, 0.9);
  return Float32Array.from(verts) as Float32Array<ArrayBuffer>;
}
