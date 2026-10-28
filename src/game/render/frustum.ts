/**
 * Frustum culling for the per-draw lists the renderer is handed.
 *
 * The world streams a 13 x 13 square of terrain chunks around the player, and
 * every one of them — 169 chunks of 24,576 indices, plus every tree instance
 * on them — was drawn into all three shadow cascades and the opaque pass,
 * whatever the camera was looking at. The near cascade covers 22 m; it was
 * being fed 832 m of terrain. These helpers let each pass skip the draws whose
 * bounding box lies entirely outside its own view-projection, which is the
 * difference between "what exists" and "what this pass can possibly touch".
 *
 * The test is the usual Gribb/Hartmann plane extraction from a column-major
 * view-projection (perspective or orthographic — the shadow cascades are
 * orthographic and use the same code), followed by a p-vertex AABB test. It
 * is conservative by construction: a box touching the frustum is always
 * drawn, so culling can only ever remove draws that could not have produced a
 * fragment. The caller pads bounds for anything the vertex shader displaces
 * (wind sway on foliage).
 */

import type { Mat4 } from '../math';

/** Six planes as (a, b, c, d) rows: inside where a*x + b*y + c*z + d >= 0. */
export type FrustumPlanes = Float32Array;

export function extractPlanes(m: Mat4, out: FrustumPlanes = new Float32Array(24)): FrustumPlanes {
  // Rows of the column-major matrix: r_i = (m[i], m[i+4], m[i+8], m[i+12]).
  const r0x = m[0], r0y = m[4], r0z = m[8], r0w = m[12];
  const r1x = m[1], r1y = m[5], r1z = m[9], r1w = m[13];
  const r2x = m[2], r2y = m[6], r2z = m[10], r2w = m[14];
  const r3x = m[3], r3y = m[7], r3z = m[11], r3w = m[15];
  // left: w + x >= 0
  out[0] = r3x + r0x; out[1] = r3y + r0y; out[2] = r3z + r0z; out[3] = r3w + r0w;
  // right: w - x >= 0
  out[4] = r3x - r0x; out[5] = r3y - r0y; out[6] = r3z - r0z; out[7] = r3w - r0w;
  // bottom: w + y >= 0
  out[8] = r3x + r1x; out[9] = r3y + r1y; out[10] = r3z + r1z; out[11] = r3w + r1w;
  // top: w - y >= 0
  out[12] = r3x - r1x; out[13] = r3y - r1y; out[14] = r3z - r1z; out[15] = r3w - r1w;
  // near (zero-to-one clip): z >= 0
  out[16] = r2x; out[17] = r2y; out[18] = r2z; out[19] = r2w;
  // far: w - z >= 0
  out[20] = r3x - r2x; out[21] = r3y - r2y; out[22] = r3z - r2z; out[23] = r3w - r2w;
  return out;
}

/**
 * True unless the box [b[0..2], b[3..5]] is wholly outside some plane. The
 * p-vertex (the corner furthest along each plane normal) is the only corner
 * that needs testing for a conservative answer.
 */
export function aabbInFrustum(planes: FrustumPlanes, b: Float32Array): boolean {
  for (let i = 0; i < 24; i += 4) {
    const a = planes[i], bb = planes[i + 1], c = planes[i + 2], d = planes[i + 3];
    const px = a >= 0 ? b[3] : b[0];
    const py = bb >= 0 ? b[4] : b[1];
    const pz = c >= 0 ? b[5] : b[2];
    if (a * px + bb * py + c * pz + d < 0) return false;
  }
  return true;
}

/** Pack an AABB the way the draw lists carry it. */
export function aabb(
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): Float32Array {
  const b = new Float32Array(6);
  b[0] = minX; b[1] = minY; b[2] = minZ;
  b[3] = maxX; b[4] = maxY; b[5] = maxZ;
  return b;
}
