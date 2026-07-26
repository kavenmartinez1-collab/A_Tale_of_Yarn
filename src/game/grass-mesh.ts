/**
 * Ground clutter — one grass tuft, instanced across the near terrain.
 *
 * A tuft is a handful of tapered two-segment blades fanned around the origin.
 * Two segments rather than one is what lets the vertex shader *bend* a blade
 * under wind instead of merely tilting it, which is the difference between
 * grass that sways and grass that wobbles.
 *
 * Vertex layout is the shared prop format (pos3 + normal3, 24 B stride), so
 * grass reuses the same instanced pipeline shape as foliage. Local Y runs
 * 0..1 in blade-height units; the shader scales it per instance and uses it
 * directly as the bend weight.
 */

const BLADES = 8;
/** Vertices per tuft: BLADES x 2 segments x 6 verts. */
export const GRASS_TUFT_VERTS = BLADES * 2 * 6;

/**
 * Build the shared tuft mesh. Blades are unit height; per-instance scale in
 * the shader turns that into 0.25–0.6 m.
 */
export function buildGrassTuftMesh(): Float32Array<ArrayBuffer> {
  const v: number[] = [];

  for (let b = 0; b < BLADES; b++) {
    // Deterministic per-blade variation — no RNG, so the mesh is stable.
    const yaw = (b / BLADES) * Math.PI * 2 + Math.sin(b * 12.9898) * 0.35;
    // Strong lean and a wide spread: a tuft should read as a clump splaying
    // outward, not as a bundle of vertical spikes. The spread is baked into
    // the mesh rather than applied as a per-instance XZ scale, so blades stay
    // thin while the clump's footprint gets large enough to knit together
    // with its neighbours at the scatter's spacing.
    const lean = 0.40 + 0.34 * Math.abs(Math.sin(b * 7.13));
    const height = 0.68 + 0.36 * Math.abs(Math.cos(b * 4.71));
    const halfW = 0.048 + 0.016 * Math.abs(Math.sin(b * 3.17));
    const radius = 0.30 + 0.95 * ((b * 37) % 5) / 5;

    const cx = Math.cos(yaw) * radius;
    const cz = Math.sin(yaw) * radius;
    // Blade width runs perpendicular to the lean direction.
    const wx = -Math.sin(yaw);
    const wz = Math.cos(yaw);
    const lx = Math.cos(yaw);
    const lz = Math.sin(yaw);

    // Three rows: base, mid, tip. Width tapers to a point.
    const rows = [
      { y: 0.0, w: halfW, off: 0.0 },
      { y: height * 0.55, w: halfW * 0.62, off: lean * 0.30 },
      { y: height, w: halfW * 0.06, off: lean },
    ];

    // Face normal: perpendicular to the blade plane, tilted with the lean so
    // a tuft catches light from a range of angles rather than one.
    const nx = lx * 0.35 + wx * 0.0;
    const nz = lz * 0.35 + wz * 0.0;
    const nlen = Math.hypot(nx, 1, nz);

    for (let s = 0; s < 2; s++) {
      const r0 = rows[s];
      const r1 = rows[s + 1];
      const p = (r: typeof rows[0], side: number): [number, number, number] => [
        cx + lx * r.off + wx * r.w * side,
        r.y,
        cz + lz * r.off + wz * r.w * side,
      ];
      const a = p(r0, -1), bb = p(r0, 1), c = p(r1, 1), d = p(r1, -1);
      const n: [number, number, number] = [nx / nlen, 1 / nlen, nz / nlen];
      // Two triangles; the pipeline draws grass double-sided so winding is
      // only a normal convention here.
      v.push(
        ...a, ...n, ...bb, ...n, ...c, ...n,
        ...a, ...n, ...c, ...n, ...d, ...n,
      );
    }
  }

  return new Float32Array(v);
}
