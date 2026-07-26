/**
 * Projectile geometry — builds every visible arrow / stone into ONE
 * interleaved pos3+normal3 buffer (STRIDE_PROP, 24 B) per frame.
 *
 * Pure CPU, no GPU, node-testable. Vertices are emitted in WORLD space, so the
 * whole pool draws with a single object bind group parked at the origin and a
 * single draw call — the same trick the character mesh uses, and the reason
 * arrows cost one draw regardless of how many are in the air.
 *
 * Orientation comes from the projectile's unit forward vector rather than
 * Euler angles: an arrow fired straight up is a gimbal singularity in
 * yaw/pitch and would spin about its own shaft as it passed vertical.
 * Building an orthonormal basis around the direction has no such case.
 *
 * READABILITY over realism. A real arrow is ~0.7 m and 8 mm thick. At 28 m/s
 * and 60 fps a projectile moves 0.47 m between frames, so a realistic arrow
 * would strobe as a dashed line of disconnected slivers. ARROW_LEN is 0.92 m —
 * longer than the per-frame step — so successive frames overlap and the shot
 * reads as one continuous streak. The shaft is correspondingly chunky, which
 * also suits a world made of knitted dolls.
 */

import type { Projectile, ProjectilePool } from './projectiles';

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/** Total arrow length (m) — see the header for why this is oversized. */
export const ARROW_LEN = 0.92;
/** Shaft half-thickness (m). */
const SHAFT_R = 0.021;
/** Arrowhead base radius (m). */
const HEAD_R = 0.048;
/** Arrowhead length (m). */
const HEAD_LEN = 0.13;
/** Fletching vane length (m) and its width at the nock / at the front. */
const FLETCH_LEN = 0.15;
const FLETCH_W_BACK = 0.055;
const FLETCH_W_FRONT = 0.012;
/** Thrown-stone half-extent (m). */
const STONE_R = 0.055;

/** Floats per vertex: pos3 + normal3. Matches renderer.STRIDE_PROP / 4. */
export const PROJECTILE_FLOATS_PER_VERT = 6;

/**
 * Worst-case vertices for one projectile: 24 shaft + 12 head + 24 fletching
 * (both vanes emitted double-sided so they never vanish edge-on).
 * A stone is 36, comfortably under. Sizing the GPU buffer from this is what
 * keeps a full pool from ever overrunning its allocation — the failure mode of
 * an overrun here is a BLACK FRAME, not a missing arrow.
 */
export const PROJECTILE_MAX_VERTS = 60;

// ---------------------------------------------------------------------------
// Emit helpers
// ---------------------------------------------------------------------------

/** Append one triangle with a shared face normal. Returns the new offset. */
function tri(
  out: Float32Array, o: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  nx: number, ny: number, nz: number,
): number {
  out[o] = ax; out[o + 1] = ay; out[o + 2] = az;
  out[o + 3] = nx; out[o + 4] = ny; out[o + 5] = nz;
  out[o + 6] = bx; out[o + 7] = by; out[o + 8] = bz;
  out[o + 9] = nx; out[o + 10] = ny; out[o + 11] = nz;
  out[o + 12] = cx; out[o + 13] = cy; out[o + 14] = cz;
  out[o + 15] = nx; out[o + 16] = ny; out[o + 17] = nz;
  return o + 18;
}

/** Append a quad as two triangles (a→b→c, a→c→d) with one face normal. */
function quad(
  out: Float32Array, o: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
  nx: number, ny: number, nz: number,
): number {
  o = tri(out, o, ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz);
  return tri(out, o, ax, ay, az, cx, cy, cz, dx, dy, dz, nx, ny, nz);
}

// ---------------------------------------------------------------------------
// Arrow
// ---------------------------------------------------------------------------

/**
 * Build one arrow at (px,py,pz) pointing along the unit vector (fx,fy,fz).
 * Returns the new write offset. Writes exactly 60 vertices.
 */
export function buildArrow(
  out: Float32Array, o: number,
  px: number, py: number, pz: number,
  fx: number, fy: number, fz: number,
): number {
  // Orthonormal basis around the flight direction. The reference axis is
  // swapped near-vertical so the cross product never degenerates.
  const upRefY = Math.abs(fy) > 0.985 ? 0 : 1;
  const upRefX = upRefY === 0 ? 1 : 0;
  // r = normalize(f × upRef)
  let rx = fy * 0 - fz * upRefY;
  let ry = fz * upRefX - fx * 0;
  let rz = fx * upRefY - fy * upRefX;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  // u = r × f
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;

  const half = ARROW_LEN * 0.5;
  const tNock = -half;
  const tHead = half - HEAD_LEN;
  const tTip = half;

  // --- shaft: a square prism from the nock to the base of the head ---------
  // Four flat faces. The normal of each face is the bisector of the two corner
  // directions that bound it, which is exact for a square cross-section.
  for (let k = 0; k < 4; k++) {
    const a0 = (k * Math.PI) / 2;
    const a1 = ((k + 1) * Math.PI) / 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    const d0x = rx * c0 + ux * s0, d0y = ry * c0 + uy * s0, d0z = rz * c0 + uz * s0;
    const d1x = rx * c1 + ux * s1, d1y = ry * c1 + uy * s1, d1z = rz * c1 + uz * s1;
    let nx = d0x + d1x, ny = d0y + d1y, nz = d0z + d1z;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    o = quad(out, o,
      px + fx * tNock + d0x * SHAFT_R, py + fy * tNock + d0y * SHAFT_R, pz + fz * tNock + d0z * SHAFT_R,
      px + fx * tHead + d0x * SHAFT_R, py + fy * tHead + d0y * SHAFT_R, pz + fz * tHead + d0z * SHAFT_R,
      px + fx * tHead + d1x * SHAFT_R, py + fy * tHead + d1y * SHAFT_R, pz + fz * tHead + d1z * SHAFT_R,
      px + fx * tNock + d1x * SHAFT_R, py + fy * tNock + d1y * SHAFT_R, pz + fz * tNock + d1z * SHAFT_R,
      nx, ny, nz);
  }

  // --- head: a four-sided pyramid -----------------------------------------
  const apx = px + fx * tTip, apy = py + fy * tTip, apz = pz + fz * tTip;
  for (let k = 0; k < 4; k++) {
    const a0 = (k * Math.PI) / 2;
    const a1 = ((k + 1) * Math.PI) / 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    const d0x = rx * c0 + ux * s0, d0y = ry * c0 + uy * s0, d0z = rz * c0 + uz * s0;
    const d1x = rx * c1 + ux * s1, d1y = ry * c1 + uy * s1, d1z = rz * c1 + uz * s1;
    const b0x = px + fx * tHead + d0x * HEAD_R;
    const b0y = py + fy * tHead + d0y * HEAD_R;
    const b0z = pz + fz * tHead + d0z * HEAD_R;
    const b1x = px + fx * tHead + d1x * HEAD_R;
    const b1y = py + fy * tHead + d1y * HEAD_R;
    const b1z = pz + fz * tHead + d1z * HEAD_R;
    // Face normal from the actual triangle, so the head shades as a cone.
    const e1x = apx - b0x, e1y = apy - b0y, e1z = apz - b0z;
    const e2x = b1x - b0x, e2y = b1y - b0y, e2z = b1z - b0z;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    o = tri(out, o, b0x, b0y, b0z, apx, apy, apz, b1x, b1y, b1z, nx, ny, nz);
  }

  // --- fletching: two tapered vanes, each emitted from both sides ----------
  const tf0 = tNock + 0.015;
  const tf1 = tf0 + FLETCH_LEN;
  for (let k = 0; k < 2; k++) {
    const dxk = k === 0 ? rx : ux;
    const dyk = k === 0 ? ry : uy;
    const dzk = k === 0 ? rz : uz;
    // Plane normal = f × d (perpendicular to both the shaft and the vane).
    let nx = fy * dzk - fz * dyk;
    let ny = fz * dxk - fx * dzk;
    let nz = fx * dyk - fy * dxk;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const q0x = px + fx * tf0 - dxk * FLETCH_W_BACK;
    const q0y = py + fy * tf0 - dyk * FLETCH_W_BACK;
    const q0z = pz + fz * tf0 - dzk * FLETCH_W_BACK;
    const q1x = px + fx * tf1 - dxk * FLETCH_W_FRONT;
    const q1y = py + fy * tf1 - dyk * FLETCH_W_FRONT;
    const q1z = pz + fz * tf1 - dzk * FLETCH_W_FRONT;
    const q2x = px + fx * tf1 + dxk * FLETCH_W_FRONT;
    const q2y = py + fy * tf1 + dyk * FLETCH_W_FRONT;
    const q2z = pz + fz * tf1 + dzk * FLETCH_W_FRONT;
    const q3x = px + fx * tf0 + dxk * FLETCH_W_BACK;
    const q3y = py + fy * tf0 + dyk * FLETCH_W_BACK;
    const q3z = pz + fz * tf0 + dzk * FLETCH_W_BACK;
    o = quad(out, o, q0x, q0y, q0z, q1x, q1y, q1z, q2x, q2y, q2z, q3x, q3y, q3z, nx, ny, nz);
    // Reverse face: a single-sided vane disappears the moment the camera
    // crosses its plane, which is most of the time in a third-person orbit.
    o = quad(out, o, q0x, q0y, q0z, q3x, q3y, q3z, q2x, q2y, q2z, q1x, q1y, q1z, -nx, -ny, -nz);
  }

  return o;
}

/** Build a thrown stone as a small cube. Writes exactly 36 vertices. */
export function buildStone(
  out: Float32Array, o: number,
  px: number, py: number, pz: number,
): number {
  const r = STONE_R;
  const x0 = px - r, x1 = px + r;
  const y0 = py - r, y1 = py + r;
  const z0 = pz - r, z1 = pz + r;
  o = quad(out, o, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1);
  o = quad(out, o, x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1);
  o = quad(out, o, x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, 1, 0, 0);
  o = quad(out, o, x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0);
  o = quad(out, o, x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, 0, 1, 0);
  o = quad(out, o, x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, 0, -1, 0);
  return o;
}

/**
 * Fill `out` with every active projectile within `viewDist` of (camX, camZ).
 * Returns the VERTEX count written (not floats). `out` must have room for
 * PROJECTILE_MAX_VERTS * PROJECTILE_FLOATS_PER_VERT floats per pool slot.
 */
export function buildProjectileMesh(
  pool: ProjectilePool,
  out: Float32Array,
  camX = 0,
  camZ = 0,
  viewDist = Infinity,
): number {
  let o = 0;
  const maxFloats = out.length - PROJECTILE_MAX_VERTS * PROJECTILE_FLOATS_PER_VERT;
  const d2 = viewDist * viewDist;
  for (const p of pool.slots) {
    if (!p.active) continue;
    if (o > maxFloats) break; // hard backstop — never overrun the allocation
    const dx = p.x - camX, dz = p.z - camZ;
    if (dx * dx + dz * dz > d2) continue;
    o = p.kind === 'arrow'
      ? buildArrow(out, o, p.x, p.y, p.z, p.dx, p.dy, p.dz)
      : buildStone(out, o, p.x, p.y, p.z);
  }
  return o / PROJECTILE_FLOATS_PER_VERT;
}

/** Convenience for callers sizing a GPU buffer. */
export function projectileMeshFloats(capacity: number): number {
  return capacity * PROJECTILE_MAX_VERTS * PROJECTILE_FLOATS_PER_VERT;
}

/** Re-export the slot type so consumers need only import from here. */
export type { Projectile };
