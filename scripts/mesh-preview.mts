/**
 * Offline silhouette previewer for creature/character meshes.
 *
 * Why this exists: the in-game portrait harness (creature-portraits.mjs) is the
 * only way to judge *material* — the yarn texture is baked on the GPU. But it
 * needs a dev server, a Playwright Chrome with WebGPU, and a species that is
 * already registered and spawnable. During mesh iteration that loop is minutes
 * long and the failure modes (server down, entity never spawned, orbit yaw
 * pointing at the back of the head) all report success.
 *
 * This renders the raw vertex array a builder returns, in-process, in about
 * 30 ms. It cannot show you the knit texture, so it does not replace the game
 * harness — it catches the things that are actually wrong at this stage:
 * silhouette, proportion, parts floating off the body, and — with
 * `flagBackfaces` — inside-out winding, which back-face culling would
 * otherwise turn into an invisible hole.
 *
 * Vertex layout is STRIDE_CREATURE: pos3 + normal3 + colour3 + matId = 10
 * floats. Same array the GPU gets.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

export const FLOATS_PER_VERT = 10;

export interface PreviewCamera {
  /**
   * Orbit yaw in degrees. **0 looks at the subject's BACK** — this matches the
   * game's orbit camera, and it is the exact trap that had the portrait
   * harness shooting the back of the player's head for days. 180 is the front.
   */
  yaw: number;
  /** Pitch in degrees; positive looks down at the subject. */
  pitch: number;
  /** Camera distance from the target, in world metres. */
  distance: number;
  /** Look-at point. Defaults to the mesh's bounding-box centre. */
  target?: [number, number, number];
  /** Vertical field of view, degrees. */
  fov?: number;
}

export interface PreviewOptions {
  width?: number;
  height?: number;
  /** Background colour, linear 0..1. */
  bg?: [number, number, number];
  /**
   * Draw a 1 m ground grid and a reference stick figure of this height, so
   * "twice as tall as the player" is a thing you can see and not just assert.
   */
  groundGrid?: boolean;
  /** Extra horizontal reference lines at these Y heights (metres). */
  heightMarks?: number[];
  /**
   * Paint back-facing triangles magenta instead of shading them.
   *
   * Off by default, and that default is not laziness. Capes, wing membranes
   * and every other sheet in this codebase are deliberately double-sided —
   * they push both windings — so half their triangles are back faces by
   * design and a magenta flag buries the model in false positives. With this
   * off they shade correctly (normal flipped toward the eye).
   *
   * The returned `backface` fraction is roughly 0.5 for any closed mesh from
   * any angle — half a closed surface always faces away — so read it as a
   * sanity band and not as a defect count. `npx tsx scripts/check-winding.mts`
   * is the real audit; turn this on when a shape has a hole in it and you want
   * to know where.
   */
  flagBackfaces?: boolean;
}

type Vec3 = [number, number, number];

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** sRGB encode — without this every render looks like it was shot in a cave. */
function encodeSrgb(c: number): number {
  const v = clamp01(c);
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

export function meshBounds(verts: ArrayLike<number>): {
  min: Vec3; max: Vec3; centre: Vec3; height: number; count: number;
} {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const n = Math.floor(verts.length / FLOATS_PER_VERT);
  for (let i = 0; i < n; i++) {
    const o = i * FLOATS_PER_VERT;
    for (let k = 0; k < 3; k++) {
      const v = verts[o + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return {
    min, max,
    centre: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    height: max[1] - min[1],
    count: n,
  };
}

/**
 * Rasterise `verts` (triangle soup, 10 floats/vertex) into an RGBA byte array.
 * Depth-buffered, no clipping beyond a near-plane reject, which is fine for an
 * orbit camera that always sits outside the subject.
 */
export function rasterize(
  verts: ArrayLike<number>, cam: PreviewCamera, opt: PreviewOptions = {},
): {
  rgba: Uint8Array; width: number; height: number;
  drawn: number; coverage: number; backface: number;
} {
  const flagBackfaces = opt.flagBackfaces ?? false;
  const W = opt.width ?? 640;
  const H = opt.height ?? 800;
  const bg = opt.bg ?? [0.055, 0.06, 0.075];

  const bounds = meshBounds(verts);
  const target = cam.target ?? bounds.centre;
  const fov = ((cam.fov ?? 38) * Math.PI) / 180;

  // Orbit basis. Yaw 0 places the camera at +Z relative to the target, which
  // is behind a mesh whose facing is atan2(dx, -dz) — i.e. -Z forward.
  const ry = (cam.yaw * Math.PI) / 180;
  const rp = (cam.pitch * Math.PI) / 180;
  const eye: Vec3 = [
    target[0] + cam.distance * Math.cos(rp) * Math.sin(ry),
    target[1] + cam.distance * Math.sin(rp),
    target[2] + cam.distance * Math.cos(rp) * Math.cos(ry),
  ];

  // Right-handed view basis looking from eye to target.
  const f: Vec3 = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const fl = Math.hypot(f[0], f[1], f[2]) || 1;
  f[0] /= fl; f[1] /= fl; f[2] /= fl;
  const up: Vec3 = [0, 1, 0];
  const s: Vec3 = [
    f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0],
  ];
  const sl = Math.hypot(s[0], s[1], s[2]) || 1;
  s[0] /= sl; s[1] /= sl; s[2] /= sl;
  const u: Vec3 = [
    s[1] * f[2] - s[2] * f[1], s[2] * f[0] - s[0] * f[2], s[0] * f[1] - s[1] * f[0],
  ];

  const tanH = Math.tan(fov / 2);
  const aspect = W / H;
  const near = 0.05;

  const colour = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    colour[i * 3] = bg[0]; colour[i * 3 + 1] = bg[1]; colour[i * 3 + 2] = bg[2];
  }
  const depth = new Float32Array(W * H).fill(Infinity);

  // Key light comes from the upper front-left of the *camera*, so the subject
  // is lit the same way from every orbit angle and silhouettes stay readable.
  const keyDir: Vec3 = [
    -0.45 * s[0] + 0.75 * u[0] - 0.5 * f[0],
    -0.45 * s[1] + 0.75 * u[1] - 0.5 * f[1],
    -0.45 * s[2] + 0.75 * u[2] - 0.5 * f[2],
  ];
  const kl = Math.hypot(keyDir[0], keyDir[1], keyDir[2]);
  keyDir[0] /= kl; keyDir[1] /= kl; keyDir[2] /= kl;

  const px = new Float32Array(3), py = new Float32Array(3), pz = new Float32Array(3);
  const vx = new Float32Array(3), vy = new Float32Array(3);
  let drawn = 0;
  let backfaces = 0;

  const project = (wx: number, wy: number, wz: number, k: number): boolean => {
    const dx = wx - eye[0], dy = wy - eye[1], dz = wz - eye[2];
    const cz = dx * f[0] + dy * f[1] + dz * f[2];
    if (cz < near) return false;
    const cx = dx * s[0] + dy * s[1] + dz * s[2];
    const cy = dx * u[0] + dy * u[1] + dz * u[2];
    px[k] = (cx / (cz * tanH * aspect)) * 0.5 * W + W / 2;
    py[k] = H / 2 - (cy / (cz * tanH)) * 0.5 * H;
    pz[k] = cz;
    return true;
  };

  const shadeTri = (
    a: number, b: number, c: number, r: number, g: number, bl: number,
    nx0: number, ny0: number, nz0: number, backface: boolean,
  ) => {
    let nx = nx0, ny = ny0, nz = nz0;
    void a; void b; void c;
    if (backface) {
      if (flagBackfaces) return [0.9, 0.0, 0.9];
      // Double-sided sheet seen from its far side: light it with the normal
      // turned toward the eye, exactly as the GPU would if culling were off.
      nx = -nx; ny = -ny; nz = -nz;
    }
    const nd = Math.max(0, nx * keyDir[0] + ny * keyDir[1] + nz * keyDir[2]);
    // Hemisphere fill keeps the shadow side legible instead of crushing to
    // black — which matters when the subject is, in fact, black wool.
    const fill = 0.30 + 0.24 * (ny * 0.5 + 0.5);
    let lr = r * (fill + 0.95 * nd);
    let lg = g * (fill + 0.95 * nd);
    let lb = bl * (fill + 0.95 * nd);
    return [lr, lg, lb];
  };

  const drawTriangle = (
    r: number, g: number, bl: number, nx: number, ny: number, nz: number, backface: boolean,
  ) => {
    const minX = Math.max(0, Math.floor(Math.min(px[0], px[1], px[2])));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(px[0], px[1], px[2])));
    const minY = Math.max(0, Math.floor(Math.min(py[0], py[1], py[2])));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(py[0], py[1], py[2])));
    if (minX > maxX || minY > maxY) return;
    vx[0] = px[1] - px[0]; vy[0] = py[1] - py[0];
    vx[1] = px[2] - px[0]; vy[1] = py[2] - py[0];
    const den = vx[0] * vy[1] - vx[1] * vy[0];
    if (Math.abs(den) < 1e-9) return;
    const inv = 1 / den;
    const [lr, lg, lb] = shadeTri(0, 0, 0, r, g, bl, nx, ny, nz, backface);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const qx = x + 0.5 - px[0], qy = y + 0.5 - py[0];
        const w1 = (qx * vy[1] - vx[1] * qy) * inv;
        const w2 = (vx[0] * qy - qx * vy[0]) * inv;
        const w0 = 1 - w1 - w2;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * pz[0] + w1 * pz[1] + w2 * pz[2];
        const idx = y * W + x;
        if (z >= depth[idx]) continue;
        depth[idx] = z;
        colour[idx * 3] = lr; colour[idx * 3 + 1] = lg; colour[idx * 3 + 2] = lb;
      }
    }
    drawn++;
  };

  // Ground grid first — depth-tested against the mesh like anything else.
  if (opt.groundGrid) {
    const half = 6;
    for (let gx = -half; gx <= half; gx++) {
      for (let seg = -half; seg < half; seg++) {
        for (const [ax, az, bx, bz] of [
          [gx, seg, gx, seg + 1] as const, [seg, gx, seg + 1, gx] as const,
        ]) {
          const t = 0.012;
          const ok = project(ax - t, 0, az - t, 0) && project(bx + t, 0, bz + t, 1) &&
            project(bx - t, 0, bz - t, 2);
          if (ok) drawTriangle(0.14, 0.15, 0.17, 0, 1, 0, false);
        }
      }
    }
  }

  for (const my of opt.heightMarks ?? []) {
    for (let seg = -4; seg < 4; seg++) {
      const ok = project(-4, my, seg, 0) && project(4, my, seg + 0.02, 1) &&
        project(-4, my, seg + 0.02, 2);
      if (ok) drawTriangle(0.35, 0.30, 0.10, 0, 1, 0, false);
    }
  }

  const nTri = Math.floor(verts.length / (FLOATS_PER_VERT * 3));
  for (let t = 0; t < nTri; t++) {
    const o = t * FLOATS_PER_VERT * 3;
    let visible = true;
    for (let k = 0; k < 3; k++) {
      const vo = o + k * FLOATS_PER_VERT;
      if (!project(verts[vo], verts[vo + 1], verts[vo + 2], k)) { visible = false; break; }
    }
    if (!visible) continue;
    // Screen-space signed area. The projection above flips Y (screen Y grows
    // down), so a front face — CCW in world space with the right-hand normal
    // toward the eye — comes out with negative area here.
    const area = (px[1] - px[0]) * (py[2] - py[0]) - (px[2] - px[0]) * (py[1] - py[0]);
    const backface = area > 0;
    if (backface) backfaces++;
    const vo = o;
    drawTriangle(
      verts[vo + 6], verts[vo + 7], verts[vo + 8],
      verts[vo + 3], verts[vo + 4], verts[vo + 5], backface,
    );
  }

  const rgba = new Uint8Array(W * H * 4);
  let covered = 0;
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = encodeSrgb(colour[i * 3]);
    rgba[i * 4 + 1] = encodeSrgb(colour[i * 3 + 1]);
    rgba[i * 4 + 2] = encodeSrgb(colour[i * 3 + 2]);
    rgba[i * 4 + 3] = 255;
    if (depth[i] < Infinity) covered++;
  }
  return {
    rgba, width: W, height: H, drawn, coverage: covered / (W * H),
    backface: nTri === 0 ? 0 : backfaces / nTri,
  };
}

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Minimal PNG encoder — no dependency, and the repo has no image library. */
export function writePng(path: string, rgba: Uint8Array, W: number, H: number): void {
  const raw = new Uint8Array(H * (W * 4 + 1));
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * W * 4, (y + 1) * W * 4), y * (W * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, W); dv.setUint32(4, H);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 6 }))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  writeFileSync(path, out);
}

/** Render one view straight to a PNG. Returns the raster stats. */
export function preview(
  path: string, verts: ArrayLike<number>, cam: PreviewCamera, opt: PreviewOptions = {},
): { drawn: number; coverage: number; backface: number } {
  const r = rasterize(verts, cam, opt);
  writePng(path, r.rgba, r.width, r.height);
  return { drawn: r.drawn, coverage: r.coverage, backface: r.backface };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
//
//   npx tsx scripts/mesh-preview.mts <species> [outDir] [flapAmp]
//
// Renders front / three-quarter / side / rear plus a close-up, with a 1 m
// ground grid and height marks at the player's 1.62 m and the Evil King's
// 3.24 m so scale is a thing you can see rather than only assert.

if (process.argv[1]?.endsWith('mesh-preview.mts') === true) {
  const { buildAnimalMesh } = await import('../src/game/entities/animal-mesh');
  const { SPECIES_DEFS } = await import('../src/game/entities/entity-types');
  const { mkdirSync } = await import('node:fs');

  const species = process.argv[2] ?? 'evil_king';
  const dir = process.argv[3] ?? 'scripts/shots/preview';
  const flapAmp = Number(process.argv[4] ?? '0.95');
  if (!(species in SPECIES_DEFS)) {
    console.error(`unknown species '${species}'. One of: ${Object.keys(SPECIES_DEFS).join(', ')}`);
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });

  const size = SPECIES_DEFS[species as keyof typeof SPECIES_DEFS].size;
  const m = buildAnimalMesh(species as never,
    { yaw: 0, walkPhase: 0, walkAmp: 0, flapPhase: 0.6, flapAmp });
  const v = m.verts.subarray(0, m.count * FLOATS_PER_VERT);
  const b = meshBounds(v);
  console.log(`${species}: ${m.count} verts, ` +
    `${(b.max[0] - b.min[0]).toFixed(2)} x ${b.height.toFixed(2)} x ` +
    `${(b.max[2] - b.min[2]).toFixed(2)} m`);

  // Frame off the real bounds, not off `size` — a spread wingspan is five
  // times the shoulder height and framing on `size` puts the wings off-screen.
  const span = Math.max(b.max[0] - b.min[0], b.height, b.max[2] - b.min[2]);
  const dist = span * 1.5 + size;
  const target: [number, number, number] = [0, b.height * 0.55, b.centre[2] * 0.5];
  for (const [name, yaw, dm] of [
    ['front', 180, 1.0], ['tq', 215, 1.0], ['side', 270, 1.0],
    ['rear', 0, 1.0], ['close', 200, 0.42],
  ] as const) {
    const r = preview(`${dir}/${species}-${name}.png`, v,
      { yaw, pitch: 8, distance: dist * dm, target },
      {
        width: 760, height: 620, groundGrid: true,
        heightMarks: [1.62, 3.24],
      });
    console.log(`  ${name.padEnd(6)} tris ${r.drawn}  cover ${(r.coverage * 100).toFixed(1)}%` +
      `  back ${(r.backface * 100).toFixed(0)}%`);
  }
}
