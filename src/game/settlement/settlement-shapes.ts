/**
 * Shared building-shape helpers for settlement meshes.
 *
 * Everything here emits into the position+normal soup (`mesh-utils` layout)
 * in *pad-local* space: origin at the pad centre on the ground plane, local
 * -Z is the door / street side, +Y up. `buildSettlementMeshes` rotates the
 * result by the pad's quantized yaw and translates it to world space.
 *
 * Winding discipline: every quad/tri below was derived against
 * `mesh-utils.faceNormal` — the right-hand normal (b-a)x(c-a) must point
 * OUTWARD or the face is culled into an invisible hole. The roof helpers in
 * particular are easy to get inside-out because `gableRoof` takes its z span
 * "backwards" (max first); see `roof()`.
 */

import {
  bevelBox, box, gableRoof, POSN_FLOATS, quad, tri, type P3,
} from '../mesh-utils';

/**
 * `box()` with its corners normalised.
 *
 * Mirrored trim is written as `sx * hw + inset` for `sx` of -1 and +1, and on
 * the -X side that swaps which argument is the smaller one. `box()` takes
 * (min, max) on faith, so a flipped pair winds every face inward and the
 * detail silently disappears — it reads as a missing mesh, not a sign error,
 * and it cost real time to find on a church buttress. Every box in the
 * settlement builders goes through here so the mistake cannot be made.
 */
export function boxN(
  verts: number[],
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
): void {
  box(verts,
    Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1),
    Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1));
}

/** `bevelBox()` with its corners normalised — see `boxN`. */
export function bevelBoxN(
  verts: number[],
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  bevel = 0.06,
): void {
  bevelBox(verts,
    Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1),
    Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1), bevel);
}

/**
 * Gabled prism roof with the ridge along local X: slope faces go to `slopes`,
 * gable-end triangles to `gables` (different palettes per caller), so we build
 * the whole prism once via gableRoof into a scratch buffer and split its fixed
 * [slope, slope, gable, gable] output (12 verts then 6 verts).
 *
 * gableRoof's z0/z1 are passed swapped (max, then min) versus the "natural"
 * [z0,z1] span reading: with z0/z1 in that order the outward winding lands on
 * the slopes and gable ends exactly like the original hand-rolled version.
 */
export function roof(
  slopes: number[], gables: number[],
  w: number, d: number, y0: number, rise: number, o: number,
  cx = 0, cz = 0,
): void {
  const W = w / 2 + o;
  const D = d / 2 + o;
  const scratch: number[] = [];
  gableRoof(scratch, cx - W, cz + D, cx + W, cz - D, y0, rise);
  const slopeFloats = 12 * POSN_FLOATS;
  for (let i = 0; i < slopeFloats; i++) slopes.push(scratch[i]);
  for (let i = slopeFloats; i < scratch.length; i++) gables.push(scratch[i]);
}

/**
 * Gabled roof whose ridge runs along local **Z**, i.e. the gable end faces
 * the street. This is the medieval town-house silhouette — tall narrow
 * gables shoulder to shoulder down a street — and it is the single cheapest
 * way to make a town read as a town rather than a field of cottages.
 */
export function roofZ(
  slopes: number[], gables: number[],
  w: number, d: number, y0: number, rise: number, o: number,
  cx = 0, cz = 0,
): void {
  const xL = cx - w / 2 - o, xR = cx + w / 2 + o;
  const zN = cz - d / 2 - o, zP = cz + d / 2 + o;
  const yr = y0 + rise;
  // +X slope.
  quad(slopes, [xR, y0, zP], [xR, y0, zN], [cx, yr, zN], [cx, yr, zP]);
  // -X slope.
  quad(slopes, [xL, y0, zN], [xL, y0, zP], [cx, yr, zP], [cx, yr, zN]);
  // Gable ends.
  tri(gables, [xR, y0, zN], [xL, y0, zN], [cx, yr, zN]);
  tri(gables, [xL, y0, zP], [xR, y0, zP], [cx, yr, zP]);
}

/**
 * Gabled roof with a **sagging ridge** — the ridge line dips in the middle by
 * `sag` (as a fraction of `rise`) instead of running dead straight. Old
 * timber roofs settle; a perfectly straight ridge is the giveaway of a
 * CSG box. Also used for the longhouse, where a heavy sag reads as a
 * boat-shaped turf hall.
 *
 * `segs` ridge segments → 12·segs + 6 verts (a flat gableRoof is 18), so it
 * is only worth spending on buildings the player walks up to.
 */
export function saggedRoof(
  slopes: number[], gables: number[],
  w: number, d: number, y0: number, rise: number, o: number,
  sag = 0.14, segs = 3, cx = 0, cz = 0,
): void {
  const W = w / 2 + o;
  const D = d / 2 + o;
  const zN = cz - D, zP = cz + D;
  const drop = rise * sag;
  const ridgeY = (t: number): number =>
    y0 + rise - drop * Math.sin(t * Math.PI);
  for (let i = 0; i < segs; i++) {
    const ta = i / segs;
    const tb = (i + 1) / segs;
    const xa = cx - W + ta * 2 * W;
    const xb = cx - W + tb * 2 * W;
    const ya = ridgeY(ta);
    const yb = ridgeY(tb);
    // +Z slope.
    quad(slopes, [xa, y0, zP], [xb, y0, zP], [xb, yb, cz], [xa, ya, cz]);
    // -Z slope.
    quad(slopes, [xb, y0, zN], [xa, y0, zN], [xa, ya, cz], [xb, yb, cz]);
  }
  const y0r = ridgeY(0);
  const y1r = ridgeY(1);
  tri(gables, [cx - W, y0, zN], [cx - W, y0, zP], [cx - W, y0r, cz]);
  tri(gables, [cx + W, y0, zP], [cx + W, y0, zN], [cx + W, y1r, cz]);
}

/**
 * A hipped pyramid cap (four slopes meeting at a point) over a w x d
 * footprint. Church spires, windmill caps, turret roofs.
 */
export function pyramidRoof(
  verts: number[],
  cx: number, y0: number, cz: number,
  w: number, d: number, rise: number, o = 0,
): void {
  const W = w / 2 + o;
  const D = d / 2 + o;
  const apex: P3 = [cx, y0 + rise, cz];
  const a: P3 = [cx - W, y0, cz - D];
  const b: P3 = [cx + W, y0, cz - D];
  const c: P3 = [cx + W, y0, cz + D];
  const e: P3 = [cx - W, y0, cz + D];
  tri(verts, b, a, apex); // -Z
  tri(verts, c, b, apex); // +X
  tri(verts, e, c, apex); // +Z
  tri(verts, a, e, apex); // -X
}

/**
 * A rectangular prism between two arbitrary points — the "beam" primitive.
 * `mesh-utils` can only build axis-aligned boxes and Y-axis cylinders, and a
 * capsule's hemispherical caps balloon a thin strut into a sausage, so every
 * angled timber in a settlement (roof rafters, ladder rails, cart shafts,
 * crossed gable finials, pillory braces) needed this. 36 verts.
 */
export function beam(
  verts: number[],
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  halfW: number, halfT: number,
): void {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return;
  const ax = dx / len, ay = dy / len, az = dz / len;
  // Reference up-vector, swapped when the beam is near-vertical.
  const upX = Math.abs(ay) > 0.9 ? 1 : 0;
  const upY = Math.abs(ay) > 0.9 ? 0 : 1;
  // u = normalize(up x a);  v = a x u.  (u, v, a) is right-handed.
  let ux = upY * az - 0 * ay;
  let uy = 0 * ax - upX * az;
  let uz = upX * ay - upY * ax;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul; uy /= ul; uz /= ul;
  const vx = ay * uz - az * uy;
  const vy = az * ux - ax * uz;
  const vz = ax * uy - ay * ux;
  // Four corners in the (u, v) plane, counter-clockwise seen from +a.
  const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const at = (t: 0 | 1, k: number): P3 => {
    const [ci, cj] = corners[k];
    const bx = t === 0 ? x0 : x1;
    const by = t === 0 ? y0 : y1;
    const bz = t === 0 ? z0 : z1;
    return [
      bx + ux * ci * halfW + vx * cj * halfT,
      by + uy * ci * halfW + vy * cj * halfT,
      bz + uz * ci * halfW + vz * cj * halfT,
    ];
  };
  // End caps.
  quad(verts, at(1, 0), at(1, 1), at(1, 2), at(1, 3));
  quad(verts, at(0, 0), at(0, 3), at(0, 2), at(0, 1));
  // Sides.
  for (let k = 0; k < 4; k++) {
    const n = (k + 1) % 4;
    quad(verts, at(0, k), at(0, n), at(1, n), at(1, k));
  }
}

/**
 * A wheel: a disc whose axle runs along local **X**, so it rolls along Z.
 * `mesh-utils.cylinder` only builds along +Y, and a capsule's hemispherical
 * caps turn a thin disc into a ball, so carts needed their own primitive.
 * 12·segs verts.
 */
export function wheelX(
  verts: number[],
  cx: number, cy: number, cz: number,
  r: number, halfThick: number, segs = 8,
): void {
  const t = halfThick;
  const cIn: P3 = [cx - t, cy, cz];
  const cOut: P3 = [cx + t, cy, cz];
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const p = (a: number, x: number): P3 =>
      [x, cy + Math.cos(a) * r, cz + Math.sin(a) * r];
    const A0 = p(a0, cx - t), A1 = p(a1, cx - t);
    const B0 = p(a0, cx + t), B1 = p(a1, cx + t);
    quad(verts, A0, A1, B1, B0);  // rim
    tri(verts, cOut, B0, B1);     // +X face
    tri(verts, cIn, A1, A0);      // -X face
  }
}

/**
 * A thin flat blade rotated in the local XY plane about (cx, cy) — the
 * windmill sail arm. `angle` is measured from +Y, sweeping toward +X.
 * Emitted as a real slab (6 faces) so it catches the sun edge-on.
 */
export function bladeXY(
  verts: number[],
  cx: number, cy: number, cz: number,
  angle: number, rInner: number, rOuter: number,
  halfWidth: number, halfThick: number,
): void {
  const ux = Math.sin(angle), uy = Math.cos(angle);   // along the blade
  const vx = Math.cos(angle), vy = -Math.sin(angle);  // across it
  const pt = (r: number, s: number, z: number): P3 => [
    cx + ux * r + vx * s,
    cy + uy * r + vy * s,
    cz + z,
  ];
  const t = halfThick;
  const hw = halfWidth;
  // Corners: inner/outer x -w/+w at both z faces.
  const a0 = pt(rInner, -hw, -t), b0 = pt(rInner, hw, -t);
  const c0 = pt(rOuter, hw, -t), d0 = pt(rOuter, -hw, -t);
  const a1 = pt(rInner, -hw, t), b1 = pt(rInner, hw, t);
  const c1 = pt(rOuter, hw, t), d1 = pt(rOuter, -hw, t);
  quad(verts, a0, d0, c0, b0); // -Z face
  quad(verts, a1, b1, c1, d1); // +Z face
  quad(verts, d0, d1, c1, c0); // outer edge
  quad(verts, b0, c0, c1, b1); // +s edge
  quad(verts, a0, b0, b1, a1); // inner edge
  quad(verts, a1, d1, d0, a0); // -s edge
}

/**
 * Shuttered window on the local -Z wall face: a recessed dark pane with a
 * pair of shutters. Two calls of `box`, the cheapest detail per pixel in the
 * whole settlement build.
 */
export function windowNZ(
  pane: number[], frame: number[],
  x: number, y: number, zFace: number, w: number, h: number,
): void {
  const hw = w / 2;
  boxN(pane, x - hw, y, zFace - 0.04, x + hw, y + h, zFace + 0.01);
  boxN(frame, x - hw - 0.1, y - 0.06, zFace - 0.08, x - hw + 0.02, y + h + 0.06, zFace + 0.01);
  boxN(frame, x + hw - 0.02, y - 0.06, zFace - 0.08, x + hw + 0.1, y + h + 0.06, zFace + 0.01);
}

/**
 * A window box under a sill with a spill of flowers — three boxes, and the
 * single highest ratio of "somebody lives here" to vertices in the file.
 */
export function windowBox(
  wood: number[], leaf: number[], berry: number[],
  x: number, y: number, zFace: number, w: number,
): void {
  const hw = w / 2;
  boxN(wood, x - hw, y, zFace - 0.24, x + hw, y + 0.16, zFace + 0.01);
  boxN(leaf, x - hw + 0.02, y + 0.14, zFace - 0.22, x + hw - 0.02, y + 0.3, zFace - 0.01);
  boxN(berry, x - hw * 0.5, y + 0.26, zFace - 0.2, x + hw * 0.5, y + 0.36, zFace - 0.05);
}
