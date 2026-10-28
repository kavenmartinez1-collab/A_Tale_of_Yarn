/**
 * Shared triangle-soup mesh helpers.
 *
 * Vertex layout: non-indexed **position float32x3 + normal float32x3**
 * (stride 24 B) — the layout every "prop" pipeline consumes (dungeon,
 * settlements, resources, fires, trees, building interiors). Character and
 * animal meshes append a third float32x3 colour channel (stride 36 B) on top
 * of the same position+normal prefix.
 *
 * Real vertex normals (rather than the old fragment-shader dpdx/dpdy trick)
 * buy three things the flat-shaded build could not have: normal-offset shadow
 * biasing, smooth shading on curved primitives, and a stable tangent frame for
 * triplanar normal mapping.
 *
 * Winding: outward-facing CCW (right-hand normal from (b-a)x(c-a)).
 */

export type P3 = [number, number, number];

/** Floats per vertex in the position+normal layout. */
export const POSN_FLOATS = 6;
/** Byte stride of the position+normal layout. */
export const POSN_STRIDE = 24;

function faceNormal(a: P3, b: P3, c: P3): P3 {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len > 1e-12) { nx /= len; ny /= len; nz /= len; }
  else { nx = 0; ny = 1; nz = 0; } // degenerate triangle — point it up
  return [nx, ny, nz];
}

/** Two triangles a-b-c, a-c-d, sharing one flat face normal. */
export function quad(verts: number[], a: P3, b: P3, c: P3, d: P3): void {
  const [nx, ny, nz] = faceNormal(a, b, c);
  verts.push(
    a[0], a[1], a[2], nx, ny, nz,
    b[0], b[1], b[2], nx, ny, nz,
    c[0], c[1], c[2], nx, ny, nz,
    a[0], a[1], a[2], nx, ny, nz,
    c[0], c[1], c[2], nx, ny, nz,
    d[0], d[1], d[2], nx, ny, nz,
  );
}

/** Two triangles a-b-c, a-c-d with per-corner normals (smooth surfaces). */
export function quadN(
  verts: number[],
  a: P3, b: P3, c: P3, d: P3,
  na: P3, nb: P3, nc: P3, nd: P3,
): void {
  verts.push(
    a[0], a[1], a[2], na[0], na[1], na[2],
    b[0], b[1], b[2], nb[0], nb[1], nb[2],
    c[0], c[1], c[2], nc[0], nc[1], nc[2],
    a[0], a[1], a[2], na[0], na[1], na[2],
    c[0], c[1], c[2], nc[0], nc[1], nc[2],
    d[0], d[1], d[2], nd[0], nd[1], nd[2],
  );
}

/** One triangle with a flat face normal. */
export function tri(verts: number[], a: P3, b: P3, c: P3): void {
  const [nx, ny, nz] = faceNormal(a, b, c);
  verts.push(
    a[0], a[1], a[2], nx, ny, nz,
    b[0], b[1], b[2], nx, ny, nz,
    c[0], c[1], c[2], nx, ny, nz,
  );
}

/** Axis-aligned box [x0,x1]x[y0,y1]x[z0,z1], all 6 faces outward. 36 verts. */
export function box(
  verts: number[],
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
): void {
  quad(verts, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // -X
  quad(verts, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]); // +X
  quad(verts, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]); // -Z
  quad(verts, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +Z
  quad(verts, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]); // +Y
  quad(verts, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // -Y
}

/**
 * Box with chamfered vertical edges — reads as a softened, hand-hewn block
 * rather than a hard CSG cube, which is most of the difference between
 * "programmer box" and "carved timber". `bevel` is in world units and is
 * clamped to a third of the smallest horizontal extent.
 */
export function bevelBox(
  verts: number[],
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  bevel = 0.06,
): void {
  const b = Math.min(bevel, (x1 - x0) / 3, (z1 - z0) / 3);
  if (b <= 1e-4) { box(verts, x0, y0, z0, x1, y1, z1); return; }
  const xa = x0 + b, xb = x1 - b;
  const za = z0 + b, zb = z1 - b;

  // Four main walls (inset at the corners).
  quad(verts, [x0, y0, za], [x0, y0, zb], [x0, y1, zb], [x0, y1, za]); // -X
  quad(verts, [x1, y0, zb], [x1, y0, za], [x1, y1, za], [x1, y1, zb]); // +X
  quad(verts, [xb, y0, z0], [xa, y0, z0], [xa, y1, z0], [xb, y1, z0]); // -Z
  quad(verts, [xa, y0, z1], [xb, y0, z1], [xb, y1, z1], [xa, y1, z1]); // +Z

  // Four corner chamfers. Each runs the opposite way around the perimeter
  // from the wall pair it bridges, so that its outward normal matches.
  quad(verts, [xa, y0, z0], [x0, y0, za], [x0, y1, za], [xa, y1, z0]);
  quad(verts, [x1, y0, za], [xb, y0, z0], [xb, y1, z0], [x1, y1, za]);
  quad(verts, [xb, y0, z1], [x1, y0, zb], [x1, y1, zb], [xb, y1, z1]);
  quad(verts, [x0, y0, zb], [xa, y0, z1], [xa, y1, z1], [x0, y1, zb]);

  // Octagonal caps.
  const ring: P3[] = [
    [x0, 0, za], [x0, 0, zb], [xa, 0, z1], [xb, 0, z1],
    [x1, 0, zb], [x1, 0, za], [xb, 0, z0], [xa, 0, z0],
  ];
  const cx = (x0 + x1) * 0.5, cz = (z0 + z1) * 0.5;
  for (let i = 0; i < 8; i++) {
    const p = ring[i], q = ring[(i + 1) % 8];
    tri(verts, [cx, y1, cz], [p[0], y1, p[2]], [q[0], y1, q[2]]);   // +Y
    tri(verts, [cx, y0, cz], [q[0], y0, q[2]], [p[0], y0, p[2]]);   // -Y
  }
}

/**
 * Scratch for the four curved primitives below: 4 vertices × (pos3 + normal3).
 * Every one of them used to allocate a handful of 3-tuples and a closure or
 * two PER QUAD (sphere: 12 arrays and 2 closures a quad; capsule caps: 3
 * closures and 11 arrays a quad) and then spread them into `push`. Creatures,
 * NPCs and the player rebuild through these every frame, and the allocation
 * was most of their cost — measured 1.5-3 ms per creature. The rewrites keep
 * every arithmetic expression in its original order so the floats, and the
 * golden mesh hashes in scripts/test-*-mesh.mts, are bit-identical.
 */
const V = new Float64Array(24);

/** Push vertices k0, k1, k2 of `V` (each 6 floats) in that order. */
function push3(verts: number[], k0: number, k1: number, k2: number): void {
  const a = k0 * 6, b = k1 * 6, c = k2 * 6;
  verts.push(
    V[a], V[a + 1], V[a + 2], V[a + 3], V[a + 4], V[a + 5],
    V[b], V[b + 1], V[b + 2], V[b + 3], V[b + 4], V[b + 5],
    V[c], V[c + 1], V[c + 2], V[c + 3], V[c + 4], V[c + 5],
  );
}

/** Push the quad a-b-c, a-c-d from slots 0..3 of `V` (same order as quadN). */
function pushQuad(verts: number[]): void {
  verts.push(
    V[0], V[1], V[2], V[3], V[4], V[5],
    V[6], V[7], V[8], V[9], V[10], V[11],
    V[12], V[13], V[14], V[15], V[16], V[17],
    V[0], V[1], V[2], V[3], V[4], V[5],
    V[12], V[13], V[14], V[15], V[16], V[17],
    V[18], V[19], V[20], V[21], V[22], V[23],
  );
}

/**
 * Cylinder / truncated cone along +Y with smooth side normals.
 * `(cx, cy, cz)` is the centre of the bottom cap.
 */
export function cylinder(
  verts: number[],
  cx: number, cy: number, cz: number,
  rBottom: number, rTop: number, height: number,
  segments = 8, capBottom = true, capTop = true,
): void {
  const yTop = cy + height;
  // Side normals tilt with the slant so cones shade correctly.
  const slant = Math.atan2(rBottom - rTop, height);
  const ny = Math.sin(slant);
  const nr = Math.cos(slant);

  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);

    const b0x = cx + c0 * rBottom, b0z = cz + s0 * rBottom;
    const b1x = cx + c1 * rBottom, b1z = cz + s1 * rBottom;
    const t1x = cx + c1 * rTop, t1z = cz + s1 * rTop;
    const t0x = cx + c0 * rTop, t0z = cz + s0 * rTop;
    const n0x = c0 * nr, n0z = s0 * nr;
    const n1x = c1 * nr, n1z = s1 * nr;

    // Winding note: `box()` above establishes the convention — the right-hand
    // normal (b-a)x(c-a) must point OUTWARD, or the triangle is back-facing
    // and gets culled into an invisible hole. Verify any change here with
    // scripts/check-winding.mts rather than by eye.
    if (rTop <= 1e-5) {
      // Degenerate top — emit a triangle so the apex has no zero-area quad.
      verts.push(
        b1x, cy, b1z, n1x, ny, n1z,
        b0x, cy, b0z, n0x, ny, n0z,
        cx, yTop, cz, (n0x + n1x) * 0.5, (ny + ny) * 0.5, (n0z + n1z) * 0.5,
      );
    } else {
      // quadN(b0, t0, t1, b1, n0, n0, n1, n1)
      verts.push(
        b0x, cy, b0z, n0x, ny, n0z,
        t0x, yTop, t0z, n0x, ny, n0z,
        t1x, yTop, t1z, n1x, ny, n1z,
        b0x, cy, b0z, n0x, ny, n0z,
        t1x, yTop, t1z, n1x, ny, n1z,
        b1x, cy, b1z, n1x, ny, n1z,
      );
    }

    if (capTop && rTop > 1e-5) {
      verts.push(
        cx, yTop, cz, 0, 1, 0,
        t1x, yTop, t1z, 0, 1, 0,
        t0x, yTop, t0z, 0, 1, 0,
      );
    }
    if (capBottom && rBottom > 1e-5) {
      verts.push(
        cx, cy, cz, 0, -1, 0,
        b0x, cy, b0z, 0, -1, 0,
        b1x, cy, b1z, 0, -1, 0,
      );
    }
  }
}

/** Cone along +Y — cylinder with a zero-radius top. */
export function cone(
  verts: number[],
  cx: number, cy: number, cz: number,
  radius: number, height: number, segments = 8, capBottom = true,
): void {
  cylinder(verts, cx, cy, cz, radius, 0, height, segments, capBottom, false);
}

/** UV sphere centred at (cx, cy, cz), smooth normals. */
export function sphere(
  verts: number[],
  cx: number, cy: number, cz: number, r: number,
  segments = 10, rings = 6,
  scaleY = 1, scaleZ = 1,
): void {
  // Unit-sphere normal (nx, ny, nz) -> scratch slot k: scaled position, then
  // the inverse-transpose normal for the non-uniform scale.
  const put = (k: number, nx: number, ny: number, nz: number): void => {
    const o = k * 6;
    V[o] = cx + nx * r;
    V[o + 1] = cy + ny * r * scaleY;
    V[o + 2] = cz + nz * r * scaleZ;
    const y = ny / scaleY, z = nz / scaleZ;
    const l = Math.hypot(nx, y, z) || 1;
    V[o + 3] = nx / l;
    V[o + 4] = y / l;
    V[o + 5] = z / l;
  };
  for (let j = 0; j < rings; j++) {
    const p0 = (j / rings) * Math.PI;
    const p1 = ((j + 1) / rings) * Math.PI;
    const y0 = Math.cos(p0), y1 = Math.cos(p1);
    const r0 = Math.sin(p0), r1 = Math.sin(p1);
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0);
      const c1 = Math.cos(a1), s1 = Math.sin(a1);

      put(0, c0 * r0, y0, s0 * r0); // a
      put(1, c1 * r0, y0, s1 * r0); // b
      put(2, c1 * r1, y1, s1 * r1); // c
      put(3, c0 * r1, y1, s0 * r1); // d

      if (j === 0) {
        push3(verts, 0, 2, 3);
      } else if (j === rings - 1) {
        push3(verts, 0, 1, 2);
      } else {
        pushQuad(verts);
      }
    }
  }
}

/**
 * Capsule between two world points with hemispherical caps — the workhorse
 * for limbs, necks, and tails.
 */
export function capsule(
  verts: number[],
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  r: number, segments = 8,
): void {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) { sphere(verts, x0, y0, z0, r, segments, Math.max(4, segments >> 1)); return; }
  const ax = dx / len, ay = dy / len, az = dz / len;

  // Orthonormal frame around the axis.
  let ux = 0, uy = 0, uz = 1;
  if (Math.abs(az) > 0.9) { ux = 1; uy = 0; uz = 0; }
  let bx = ay * uz - az * uy, by = az * ux - ax * uz, bz = ax * uy - ay * ux;
  const bl = Math.hypot(bx, by, bz) || 1;
  bx /= bl; by /= bl; bz /= bl;
  const cx2 = ay * bz - az * by, cy2 = az * bx - ax * bz, cz2 = ax * by - ay * bx;

  // Scratch slot k <- point on the ring at `t` along the axis, angle `ang`,
  // radius `rad`, pushed `o` along the axis (the cap offset; the barrel uses
  // `ringPt`, which adds nothing, so a -0 stays a -0 there).
  const ringPt = (k: number, t: number, ang: number, rad: number): void => {
    const c = Math.cos(ang), s = Math.sin(ang);
    const o = k * 6;
    V[o] = x0 + dx * t + (bx * c + cx2 * s) * rad;
    V[o + 1] = y0 + dy * t + (by * c + cy2 * s) * rad;
    V[o + 2] = z0 + dz * t + (bz * c + cz2 * s) * rad;
  };
  const capPt = (k: number, t: number, ang: number, rad: number, off: number): void => {
    const c = Math.cos(ang), s = Math.sin(ang);
    const o = k * 6;
    V[o] = (x0 + dx * t + (bx * c + cx2 * s) * rad) + ax * off;
    V[o + 1] = (y0 + dy * t + (by * c + cy2 * s) * rad) + ay * off;
    V[o + 2] = (z0 + dz * t + (bz * c + cz2 * s) * rad) + az * off;
  };
  const ringN = (k: number, ang: number, axial: number): void => {
    const c = Math.cos(ang), s = Math.sin(ang);
    const nx = bx * c + cx2 * s + ax * axial;
    const ny = by * c + cy2 * s + ay * axial;
    const nz = bz * c + cz2 * s + az * axial;
    const l = Math.hypot(nx, ny, nz) || 1;
    const o = k * 6;
    V[o + 3] = nx / l;
    V[o + 4] = ny / l;
    V[o + 5] = nz / l;
  };

  // Barrel: quadN(ringPt(0,a0), ringPt(0,a1), ringPt(1,a1), ringPt(1,a0),
  //               ringN(a0), ringN(a1), ringN(a1), ringN(a0)).
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    ringPt(0, 0, a0, r); ringN(0, a0, 0);
    ringPt(1, 0, a1, r); ringN(1, a1, 0);
    ringPt(2, 1, a1, r); ringN(2, a1, 0);
    ringPt(3, 1, a0, r); ringN(3, a0, 0);
    pushQuad(verts);
  }

  // Hemispherical caps: 3 latitude bands each.
  const bands = 3;
  for (let cap = 0; cap < 2; cap++) {
    const t = cap === 0 ? 0 : 1;
    const sign = cap === 0 ? -1 : 1;
    const pnx = ax * sign, pny = ay * sign, pnz = az * sign; // pole normal
    for (let j = 0; j < bands; j++) {
      const e0 = (j / bands) * (Math.PI / 2);
      const e1 = ((j + 1) / bands) * (Math.PI / 2);
      const r0 = Math.cos(e0) * r, r1 = Math.cos(e1) * r;
      const o0 = Math.sin(e0) * r * sign, o1 = Math.sin(e1) * r * sign;
      const ax0 = Math.tan(e0) * sign, ax1 = Math.tan(e1) * sign;
      // The final band closes on the pole, where r1 is zero — emitting a quad
      // there would be two zero-area triangles per segment. Characters rebuild
      // every frame, so that waste is worth avoiding.
      const atPole = j === bands - 1;
      for (let i = 0; i < segments; i++) {
        const a0 = (i / segments) * Math.PI * 2;
        const a1 = ((i + 1) / segments) * Math.PI * 2;
        if (cap === 0) {
          if (atPole) {
            capPt(0, t, a1, r0, o0); ringN(0, a1, ax0);
            capPt(1, t, a0, r0, o0); ringN(1, a0, ax0);
            capPt(2, t, a0, r1, o1); V[15] = pnx; V[16] = pny; V[17] = pnz;
            push3(verts, 0, 1, 2);
          } else {
            capPt(0, t, a1, r0, o0); ringN(0, a1, ax0);
            capPt(1, t, a0, r0, o0); ringN(1, a0, ax0);
            capPt(2, t, a0, r1, o1); ringN(2, a0, ax1);
            capPt(3, t, a1, r1, o1); ringN(3, a1, ax1);
            pushQuad(verts);
          }
        } else if (atPole) {
          capPt(0, t, a0, r0, o0); ringN(0, a0, ax0);
          capPt(1, t, a1, r0, o0); ringN(1, a1, ax0);
          capPt(2, t, a1, r1, o1); V[15] = pnx; V[16] = pny; V[17] = pnz;
          push3(verts, 0, 1, 2);
        } else {
          capPt(0, t, a0, r0, o0); ringN(0, a0, ax0);
          capPt(1, t, a1, r0, o0); ringN(1, a1, ax0);
          capPt(2, t, a1, r1, o1); ringN(2, a1, ax1);
          capPt(3, t, a0, r1, o1); ringN(3, a0, ax1);
          pushQuad(verts);
        }
      }
    }
  }
}

/**
 * Capsule between two points with a linearly-tapered barrel and
 * independently-radiused hemispherical caps — the general "sausage"
 * primitive; `capsule()` above is its r0 === r1 special case. Every limb,
 * neck, tail, horn and antler in the game was built from constant-radius
 * capsules/cones, which is why they read as uniform sausages regardless of
 * what they depict (a wrist is not the same thickness as a shoulder). This
 * is a merge of `cylinder()`'s slant-normal barrel with `capsule()`'s
 * arbitrary-axis frame, per RECTIFICATION_PLAN.md §7.
 *
 * The one approximation: each hemispherical cap is scaled to its own end's
 * radius (r0 at t=0, r1 at t=1), so the cap-to-barrel seam has a normal
 * discontinuity when r0 !== r1 (a mathematically smooth taper would need a
 * swept ellipse, not a sphere). At this game's low-poly stylized scale it
 * reads as a tapered sausage, not a visible seam — verified with
 * scripts/check-winding.mts same as every other primitive here.
 */
export function taperedCapsule(
  verts: number[],
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  r0: number, r1: number, segments = 8,
): void {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) {
    sphere(verts, x0, y0, z0, Math.max(r0, r1), segments, Math.max(4, segments >> 1));
    return;
  }
  const ax = dx / len, ay = dy / len, az = dz / len;

  // Orthonormal frame around the axis (identical construction to capsule()).
  let ux = 0, uy = 0, uz = 1;
  if (Math.abs(az) > 0.9) { ux = 1; uy = 0; uz = 0; }
  let bx = ay * uz - az * uy, by = az * ux - ax * uz, bz = ax * uy - ay * ux;
  const bl = Math.hypot(bx, by, bz) || 1;
  bx /= bl; by /= bl; bz /= bl;
  const cx2 = ay * bz - az * by, cy2 = az * bx - ax * bz, cz2 = ax * by - ay * bx;

  const ringPt = (k: number, t: number, ang: number, rad: number): void => {
    const c = Math.cos(ang), s = Math.sin(ang);
    const o = k * 6;
    V[o] = x0 + dx * t + (bx * c + cx2 * s) * rad;
    V[o + 1] = y0 + dy * t + (by * c + cy2 * s) * rad;
    V[o + 2] = z0 + dz * t + (bz * c + cz2 * s) * rad;
  };
  const capPt = (k: number, t: number, ang: number, rad: number, off: number): void => {
    const c = Math.cos(ang), s = Math.sin(ang);
    const o = k * 6;
    V[o] = (x0 + dx * t + (bx * c + cx2 * s) * rad) + ax * off;
    V[o + 1] = (y0 + dy * t + (by * c + cy2 * s) * rad) + ay * off;
    V[o + 2] = (z0 + dz * t + (bz * c + cz2 * s) * rad) + az * off;
  };
  const ringN = (k: number, ang: number, axial: number): void => {
    const c = Math.cos(ang), s = Math.sin(ang);
    const nx = bx * c + cx2 * s + ax * axial;
    const ny = by * c + cy2 * s + ay * axial;
    const nz = bz * c + cz2 * s + az * axial;
    const l = Math.hypot(nx, ny, nz) || 1;
    const o = k * 6;
    V[o + 3] = nx / l;
    V[o + 4] = ny / l;
    V[o + 5] = nz / l;
  };

  // Barrel: slanted side normals so the taper shades correctly — same
  // slant/radial split as cylinder(), generalized to an arbitrary axis via
  // ringN's `axial` blend term.
  const slant = Math.atan2(r0 - r1, len);
  const axial = Math.tan(slant);
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    ringPt(0, 0, a0, r0); ringN(0, a0, axial);
    ringPt(1, 0, a1, r0); ringN(1, a1, axial);
    ringPt(2, 1, a1, r1); ringN(2, a1, axial);
    ringPt(3, 1, a0, r1); ringN(3, a0, axial);
    pushQuad(verts);
  }

  // Hemispherical caps: 3 latitude bands each (same layout as capsule()),
  // each cap independently scaled to r0 (cap 0) or r1 (cap 1).
  const bands = 3;
  for (let cap = 0; cap < 2; cap++) {
    const t = cap === 0 ? 0 : 1;
    const sign = cap === 0 ? -1 : 1;
    const r = cap === 0 ? r0 : r1;
    if (r <= 1e-6) continue; // degenerate end — no cap geometry needed
    const pnx = ax * sign, pny = ay * sign, pnz = az * sign;
    for (let j = 0; j < bands; j++) {
      const e0 = (j / bands) * (Math.PI / 2);
      const e1 = ((j + 1) / bands) * (Math.PI / 2);
      const rr0 = Math.cos(e0) * r, rr1 = Math.cos(e1) * r;
      const o0 = Math.sin(e0) * r * sign, o1 = Math.sin(e1) * r * sign;
      const ax0 = Math.tan(e0) * sign, ax1 = Math.tan(e1) * sign;
      const atPole = j === bands - 1;
      for (let i = 0; i < segments; i++) {
        const a0 = (i / segments) * Math.PI * 2;
        const a1 = ((i + 1) / segments) * Math.PI * 2;
        if (cap === 0) {
          if (atPole) {
            capPt(0, t, a1, rr0, o0); ringN(0, a1, ax0);
            capPt(1, t, a0, rr0, o0); ringN(1, a0, ax0);
            capPt(2, t, a0, rr1, o1); V[15] = pnx; V[16] = pny; V[17] = pnz;
            push3(verts, 0, 1, 2);
          } else {
            capPt(0, t, a1, rr0, o0); ringN(0, a1, ax0);
            capPt(1, t, a0, rr0, o0); ringN(1, a0, ax0);
            capPt(2, t, a0, rr1, o1); ringN(2, a0, ax1);
            capPt(3, t, a1, rr1, o1); ringN(3, a1, ax1);
            pushQuad(verts);
          }
        } else if (atPole) {
          capPt(0, t, a0, rr0, o0); ringN(0, a0, ax0);
          capPt(1, t, a1, rr0, o0); ringN(1, a1, ax0);
          capPt(2, t, a1, rr1, o1); V[15] = pnx; V[16] = pny; V[17] = pnz;
          push3(verts, 0, 1, 2);
        } else {
          capPt(0, t, a0, rr0, o0); ringN(0, a0, ax0);
          capPt(1, t, a1, rr0, o0); ringN(1, a1, ax0);
          capPt(2, t, a1, rr1, o1); ringN(2, a1, ax1);
          capPt(3, t, a0, rr1, o1); ringN(3, a0, ax1);
          pushQuad(verts);
        }
      }
    }
  }
}

/**
 * Gabled prism (roof shape) with the ridge running along local X.
 * Spans [x0,x1] x [z0,z1], eaves at `y0`, ridge `rise` above them.
 */
export function gableRoof(
  verts: number[],
  x0: number, z0: number, x1: number, z1: number,
  y0: number, rise: number,
): void {
  const zm = (z0 + z1) * 0.5;
  const yr = y0 + rise;
  quad(verts, [x0, y0, z0], [x1, y0, z0], [x1, yr, zm], [x0, yr, zm]); // -Z slope
  quad(verts, [x1, y0, z1], [x0, y0, z1], [x0, yr, zm], [x1, yr, zm]); // +Z slope
  tri(verts, [x0, y0, z1], [x0, y0, z0], [x0, yr, zm]);                 // -X gable
  tri(verts, [x1, y0, z0], [x1, y0, z1], [x1, yr, zm]);                 // +X gable
}

/**
 * Append `src` (position+normal pairs) into `dst`, translated by (tx,ty,tz)
 * and rotated by `yaw` about +Y. Normals rotate with the geometry.
 */
export function appendYaw(
  dst: number[], src: readonly number[],
  tx: number, ty: number, tz: number, yaw: number,
): void {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (let i = 0; i < src.length; i += 6) {
    const x = src[i], y = src[i + 1], z = src[i + 2];
    const nx = src[i + 3], ny = src[i + 4], nz = src[i + 5];
    dst.push(
      x * c - z * s + tx, y + ty, x * s + z * c + tz,
      nx * c - nz * s, ny, nx * s + nz * c,
    );
  }
}

/**
 * Local-space geometry memo for the per-frame mesh builders.
 *
 * A creature, an NPC or the player is re-posed every frame by rebuilding its
 * parts from scratch and then rotating them into place (`assembleParts`).
 * Most of a part's geometry does not depend on the pose at all — a leg is the
 * same capsule every frame, only its `rots` change — so the primitive work is
 * repeated for nothing. Measured before this: ~1.5 ms per creature rebuild,
 * eight rebuilds a frame near a herd, and the castle dragon alone at 12 ms.
 *
 * `key` is the primitive name plus EVERY argument it was given, so a hit is
 * by construction the same floats the builder would have produced (the
 * builders are pure). A part whose arguments move with the pose (a wing spar,
 * a chain vertebra) misses every frame and costs one key string more than it
 * did — a few microseconds against the ~20 us it took to build. The returned
 * array is shared between frames and between creatures and must never be
 * mutated; `Part.verts` is typed readonly for that reason.
 *
 * Bounded by clearing: a steady stream of pose-dependent misses would
 * otherwise grow it without limit. 2048 parts at a few KB each is a few MB.
 */
const GEOM_MEMO_MAX = 2048;
const geomMemo = new Map<string, readonly number[]>();
/** Hit/miss counters — the instrument for "is this part pose-independent?" */
export const geomMemoStats = { hits: 0, misses: 0, size: () => geomMemo.size };

export function memoGeom(key: string, build: () => number[]): readonly number[] {
  const hit = geomMemo.get(key);
  if (hit !== undefined) { geomMemoStats.hits++; return hit; }
  geomMemoStats.misses++;
  const verts = build();
  if (geomMemo.size >= GEOM_MEMO_MAX) geomMemo.clear();
  geomMemo.set(key, verts);
  return verts;
}

/** Mulberry32 PRNG — the deterministic-scatter workhorse (same as noise.ts). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
