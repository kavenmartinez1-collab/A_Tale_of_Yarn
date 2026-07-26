/**
 * Winding + normal audit for the mesh-utils primitives.
 *
 * Two independent checks per triangle:
 *   1. the stored per-vertex normal agrees with the right-hand geometric
 *      normal (b-a)x(c-a) — a mismatch means lighting fights the geometry;
 *   2. that geometric normal points AWAY from the shape's centre — a
 *      mismatch means the triangle is back-facing and gets culled, which is
 *      what "invisible gaps" look like.
 *
 * `box()` is the reference: it is unchanged from the shipped renderer, so
 * whatever convention it satisfies is the correct one.
 */
import {
  box, bevelBox, cylinder, cone, sphere, capsule, taperedCapsule, gableRoof, quad, tri,
} from '../src/game/mesh-utils';

type Tri = { a: number[]; b: number[]; c: number[]; n: number[] };

function triangles(v: number[]): Tri[] {
  const out: Tri[] = [];
  for (let i = 0; i < v.length; i += 18) {
    out.push({
      a: v.slice(i, i + 3),
      b: v.slice(i + 6, i + 9),
      c: v.slice(i + 12, i + 15),
      n: v.slice(i + 3, i + 6),
    });
  }
  return out;
}

function geoNormal(t: Tri): number[] {
  const u = [t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]];
  const w = [t.c[0] - t.a[0], t.c[1] - t.a[1], t.c[2] - t.a[2]];
  const n = [
    u[1] * w[2] - u[2] * w[1],
    u[2] * w[0] - u[0] * w[2],
    u[0] * w[1] - u[1] * w[0],
  ];
  const l = Math.hypot(...n);
  return l < 1e-12 ? [0, 0, 0] : n.map((x) => x / l);
}

function audit(name: string, verts: number[], centre: number[], convex = true) {
  const tris = triangles(verts);
  let normalMismatch = 0;
  let inward = 0;
  let degenerate = 0;

  for (const t of tris) {
    const g = geoNormal(t);
    if (Math.hypot(...g) < 0.5) { degenerate++; continue; }

    // 1. stored normal vs geometric winding
    const dotStored = g[0] * t.n[0] + g[1] * t.n[1] + g[2] * t.n[2];
    if (dotStored < 0) normalMismatch++;

    // 2. geometric normal vs outward direction from the centre
    if (convex) {
      const mid = [0, 1, 2].map((k) => (t.a[k] + t.b[k] + t.c[k]) / 3 - centre[k]);
      const ml = Math.hypot(...mid);
      if (ml > 1e-6) {
        const dotOut = (g[0] * mid[0] + g[1] * mid[1] + g[2] * mid[2]) / ml;
        if (dotOut < -0.08) inward++;
      }
    }
  }

  const bad = normalMismatch + inward;
  const tag = bad === 0 ? 'OK  ' : 'FAIL';
  console.log(
    `${tag} ${name.padEnd(22)} tris=${String(tris.length).padStart(4)}` +
    `  normal-mismatch=${normalMismatch}` +
    `  back-facing=${inward}` +
    `  degenerate=${degenerate}`);
  return bad;
}

let failures = 0;
const v = (fn: (a: number[]) => void): number[] => { const a: number[] = []; fn(a); return a; };

// Reference: unchanged from the shipped renderer.
failures += audit('box (reference)', v((a) => box(a, -1, -1, -1, 1, 1, 1)), [0, 0, 0]);
failures += audit('bevelBox', v((a) => bevelBox(a, -1, -1, -1, 1, 1, 1, 0.25)), [0, 0, 0]);
failures += audit('cylinder', v((a) => cylinder(a, 0, -1, 0, 0.8, 0.8, 2, 8)), [0, 0, 0]);
failures += audit('cylinder tapered', v((a) => cylinder(a, 0, -1, 0, 0.9, 0.4, 2, 8)), [0, 0, 0]);
failures += audit('cone', v((a) => cone(a, 0, -1, 0, 0.8, 2, 8)), [0, -0.5, 0]);
failures += audit('sphere', v((a) => sphere(a, 0, 0, 0, 1, 10, 6)), [0, 0, 0]);
failures += audit('sphere squashed', v((a) => sphere(a, 0, 0, 0, 1, 10, 6, 0.6, 1.3)), [0, 0, 0]);
failures += audit('capsule Y', v((a) => capsule(a, 0, -1, 0, 0, 1, 0, 0.5, 8)), [0, 0, 0]);
failures += audit('capsule diagonal', v((a) => capsule(a, -1, -0.5, -0.7, 1, 0.5, 0.7, 0.4, 8)), [0, 0, 0]);
failures += audit('taperedCapsule', v((a) => taperedCapsule(a, -1, -0.5, -0.7, 1, 0.5, 0.7, 0.6, 0.25, 8)), [0, 0, 0]);
failures += audit('taperedCapsule Y', v((a) => taperedCapsule(a, 0, -1, 0, 0, 1, 0, 0.8, 0.3, 8)), [0, 0, 0]);
// Roofs are open shells, so only the stored-normal check is meaningful.
failures += audit('gableRoof', v((a) => gableRoof(a, -1, -1, 1, 1, 0, 1)), [0, 0, 0], false);
failures += audit('quad', v((a) => quad(a, [0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1])), [0, 0, 0], false);
failures += audit('tri', v((a) => tri(a, [0, 0, 0], [1, 0, 0], [1, 0, 1])), [0, 0, 0], false);

console.log(failures === 0
  ? '\nall primitives wound correctly'
  : `\n${failures} bad triangle(s) — these render as holes under back-face culling`);
process.exit(failures === 0 ? 0 : 1);
