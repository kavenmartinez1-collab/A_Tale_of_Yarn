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

    const b0: P3 = [cx + c0 * rBottom, cy, cz + s0 * rBottom];
    const b1: P3 = [cx + c1 * rBottom, cy, cz + s1 * rBottom];
    const t1: P3 = [cx + c1 * rTop, yTop, cz + s1 * rTop];
    const t0: P3 = [cx + c0 * rTop, yTop, cz + s0 * rTop];
    const n0: P3 = [c0 * nr, ny, s0 * nr];
    const n1: P3 = [c1 * nr, ny, s1 * nr];

    // Winding note: `box()` above establishes the convention — the right-hand
    // normal (b-a)x(c-a) must point OUTWARD, or the triangle is back-facing
    // and gets culled into an invisible hole. Verify any change here with
    // scripts/check-winding.mts rather than by eye.
    if (rTop <= 1e-5) {
      // Degenerate top — emit a triangle so the apex has no zero-area quad.
      const apex: P3 = [cx, yTop, cz];
      const nm: P3 = [(n0[0] + n1[0]) * 0.5, (n0[1] + n1[1]) * 0.5, (n0[2] + n1[2]) * 0.5];
      verts.push(
        b1[0], b1[1], b1[2], n1[0], n1[1], n1[2],
        b0[0], b0[1], b0[2], n0[0], n0[1], n0[2],
        apex[0], apex[1], apex[2], nm[0], nm[1], nm[2],
      );
    } else {
      quadN(verts, b0, t0, t1, b1, n0, n0, n1, n1);
    }

    if (capTop && rTop > 1e-5) {
      verts.push(
        cx, yTop, cz, 0, 1, 0,
        t1[0], t1[1], t1[2], 0, 1, 0,
        t0[0], t0[1], t0[2], 0, 1, 0,
      );
    }
    if (capBottom && rBottom > 1e-5) {
      verts.push(
        cx, cy, cz, 0, -1, 0,
        b0[0], b0[1], b0[2], 0, -1, 0,
        b1[0], b1[1], b1[2], 0, -1, 0,
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

      const na: P3 = [c0 * r0, y0, s0 * r0];
      const nb: P3 = [c1 * r0, y0, s1 * r0];
      const nc: P3 = [c1 * r1, y1, s1 * r1];
      const nd: P3 = [c0 * r1, y1, s0 * r1];
      const pt = (n: P3): P3 =>
        [cx + n[0] * r, cy + n[1] * r * scaleY, cz + n[2] * r * scaleZ];
      // Non-uniform scale needs the inverse-transpose for correct normals.
      const nn = (n: P3): P3 => {
        const x = n[0], y = n[1] / scaleY, z = n[2] / scaleZ;
        const l = Math.hypot(x, y, z) || 1;
        return [x / l, y / l, z / l];
      };

      if (j === 0) {
        verts.push(
          ...pt(na), ...nn(na), ...pt(nc), ...nn(nc), ...pt(nd), ...nn(nd));
      } else if (j === rings - 1) {
        verts.push(
          ...pt(na), ...nn(na), ...pt(nb), ...nn(nb), ...pt(nc), ...nn(nc));
      } else {
        quadN(verts, pt(na), pt(nb), pt(nc), pt(nd), nn(na), nn(nb), nn(nc), nn(nd));
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

  const ringPt = (t: number, ang: number, rad: number): P3 => {
    const c = Math.cos(ang), s = Math.sin(ang);
    return [
      x0 + dx * t + (bx * c + cx2 * s) * rad,
      y0 + dy * t + (by * c + cy2 * s) * rad,
      z0 + dz * t + (bz * c + cz2 * s) * rad,
    ];
  };
  const ringN = (ang: number, axial: number): P3 => {
    const c = Math.cos(ang), s = Math.sin(ang);
    const nx = bx * c + cx2 * s + ax * axial;
    const ny = by * c + cy2 * s + ay * axial;
    const nz = bz * c + cz2 * s + az * axial;
    const l = Math.hypot(nx, ny, nz) || 1;
    return [nx / l, ny / l, nz / l];
  };

  // Barrel.
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    quadN(
      verts,
      ringPt(0, a0, r), ringPt(0, a1, r), ringPt(1, a1, r), ringPt(1, a0, r),
      ringN(a0, 0), ringN(a1, 0), ringN(a1, 0), ringN(a0, 0),
    );
  }

  // Hemispherical caps: 3 latitude bands each.
  const bands = 3;
  for (let cap = 0; cap < 2; cap++) {
    const t = cap === 0 ? 0 : 1;
    const sign = cap === 0 ? -1 : 1;
    for (let j = 0; j < bands; j++) {
      const e0 = (j / bands) * (Math.PI / 2);
      const e1 = ((j + 1) / bands) * (Math.PI / 2);
      const r0 = Math.cos(e0) * r, r1 = Math.cos(e1) * r;
      const o0 = Math.sin(e0) * r * sign, o1 = Math.sin(e1) * r * sign;
      // The final band closes on the pole, where r1 is zero — emitting a quad
      // there would be two zero-area triangles per segment. Characters rebuild
      // every frame, so that waste is worth avoiding.
      const atPole = j === bands - 1;
      for (let i = 0; i < segments; i++) {
        const a0 = (i / segments) * Math.PI * 2;
        const a1 = ((i + 1) / segments) * Math.PI * 2;
        const off = (o: number): P3 => [ax * o, ay * o, az * o];
        const p = (ang: number, rad: number, o: number): P3 => {
          const q = ringPt(t, ang, rad);
          const d = off(o);
          return [q[0] + d[0], q[1] + d[1], q[2] + d[2]];
        };
        const n = (ang: number, e: number): P3 => ringN(ang, Math.tan(e) * sign);
        const poleN: P3 = [ax * sign, ay * sign, az * sign];
        if (cap === 0) {
          if (atPole) {
            const q0 = p(a1, r0, o0), q1 = p(a0, r0, o0), q2 = p(a0, r1, o1);
            verts.push(
              ...q0, ...n(a1, e0), ...q1, ...n(a0, e0), ...q2, ...poleN);
          } else {
            quadN(verts,
              p(a1, r0, o0), p(a0, r0, o0), p(a0, r1, o1), p(a1, r1, o1),
              n(a1, e0), n(a0, e0), n(a0, e1), n(a1, e1));
          }
        } else if (atPole) {
          const q0 = p(a0, r0, o0), q1 = p(a1, r0, o0), q2 = p(a1, r1, o1);
          verts.push(
            ...q0, ...n(a0, e0), ...q1, ...n(a1, e0), ...q2, ...poleN);
        } else {
          quadN(verts,
            p(a0, r0, o0), p(a1, r0, o0), p(a1, r1, o1), p(a0, r1, o1),
            n(a0, e0), n(a1, e0), n(a1, e1), n(a0, e1));
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

  const ringPt = (t: number, ang: number, rad: number): P3 => {
    const c = Math.cos(ang), s = Math.sin(ang);
    return [
      x0 + dx * t + (bx * c + cx2 * s) * rad,
      y0 + dy * t + (by * c + cy2 * s) * rad,
      z0 + dz * t + (bz * c + cz2 * s) * rad,
    ];
  };
  const ringN = (ang: number, axial: number): P3 => {
    const c = Math.cos(ang), s = Math.sin(ang);
    const nx = bx * c + cx2 * s + ax * axial;
    const ny = by * c + cy2 * s + ay * axial;
    const nz = bz * c + cz2 * s + az * axial;
    const l = Math.hypot(nx, ny, nz) || 1;
    return [nx / l, ny / l, nz / l];
  };

  // Barrel: slanted side normals so the taper shades correctly — same
  // slant/radial split as cylinder(), generalized to an arbitrary axis via
  // ringN's `axial` blend term.
  const slant = Math.atan2(r0 - r1, len);
  const axial = Math.tan(slant);
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    quadN(
      verts,
      ringPt(0, a0, r0), ringPt(0, a1, r0), ringPt(1, a1, r1), ringPt(1, a0, r1),
      ringN(a0, axial), ringN(a1, axial), ringN(a1, axial), ringN(a0, axial),
    );
  }

  // Hemispherical caps: 3 latitude bands each (same layout as capsule()),
  // each cap independently scaled to r0 (cap 0) or r1 (cap 1).
  const bands = 3;
  for (let cap = 0; cap < 2; cap++) {
    const t = cap === 0 ? 0 : 1;
    const sign = cap === 0 ? -1 : 1;
    const r = cap === 0 ? r0 : r1;
    if (r <= 1e-6) continue; // degenerate end — no cap geometry needed
    for (let j = 0; j < bands; j++) {
      const e0 = (j / bands) * (Math.PI / 2);
      const e1 = ((j + 1) / bands) * (Math.PI / 2);
      const rr0 = Math.cos(e0) * r, rr1 = Math.cos(e1) * r;
      const o0 = Math.sin(e0) * r * sign, o1 = Math.sin(e1) * r * sign;
      const atPole = j === bands - 1;
      for (let i = 0; i < segments; i++) {
        const a0 = (i / segments) * Math.PI * 2;
        const a1 = ((i + 1) / segments) * Math.PI * 2;
        const off = (o: number): P3 => [ax * o, ay * o, az * o];
        const p = (ang: number, rad: number, o: number): P3 => {
          const q = ringPt(t, ang, rad);
          const d = off(o);
          return [q[0] + d[0], q[1] + d[1], q[2] + d[2]];
        };
        const n = (ang: number, e: number): P3 => ringN(ang, Math.tan(e) * sign);
        const poleN: P3 = [ax * sign, ay * sign, az * sign];
        if (cap === 0) {
          if (atPole) {
            const q0 = p(a1, rr0, o0), q1 = p(a0, rr0, o0), q2 = p(a0, rr1, o1);
            verts.push(
              ...q0, ...n(a1, e0), ...q1, ...n(a0, e0), ...q2, ...poleN);
          } else {
            quadN(verts,
              p(a1, rr0, o0), p(a0, rr0, o0), p(a0, rr1, o1), p(a1, rr1, o1),
              n(a1, e0), n(a0, e0), n(a0, e1), n(a1, e1));
          }
        } else if (atPole) {
          const q0 = p(a0, rr0, o0), q1 = p(a1, rr0, o0), q2 = p(a1, rr1, o1);
          verts.push(
            ...q0, ...n(a0, e0), ...q1, ...n(a1, e0), ...q2, ...poleN);
        } else {
          quadN(verts,
            p(a0, rr0, o0), p(a1, rr0, o0), p(a1, rr1, o1), p(a0, rr1, o1),
            n(a0, e0), n(a1, e0), n(a1, e1), n(a0, e1));
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
