/**
 * Shared triangle-soup mesh helpers — non-indexed position-only float32x3,
 * the vertex layout every game pipeline consumes. Used by dungeon props,
 * settlements, the character, and held weapon models.
 *
 * Winding: outward-facing CCW (right-hand normal from (b-a)x(c-a)).
 */

export type P3 = [number, number, number];

/** Two triangles a-b-c, a-c-d. */
export function quad(verts: number[], a: P3, b: P3, c: P3, d: P3): void {
  verts.push(...a, ...b, ...c, ...a, ...c, ...d);
}

/** Axis-aligned box [x0,x1]x[y0,y1]x[z0,z1], all 6 faces outward. */
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
