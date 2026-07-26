/**
 * Building interior geometry — shell, furniture and decor, emitted in the
 * interleaved non-indexed `position float32x3 + normal float32x3` format the
 * dungeon pipeline expects (24 B/vertex; see mesh-utils.ts).
 *
 * ## How this stays cheap
 *
 * The dungeon pipeline has **one material per draw** (`object.offset.w` is the
 * only knob) and no instancing, so everything is batched by palette index: a
 * furnished tavern is ~14 draws no matter how many mugs are on the tables.
 *
 * Two write paths, chosen by how many of a thing there are:
 *  - **Furniture** (30-45 pieces) is parametric — sized to its AABB — and
 *    built with the mesh-utils primitives into a scratch `number[]`, which is
 *    then bulk-copied into the palette batch.
 *  - **Decor** (100-250 instances) is stamped from module-level *templates*
 *    built once per process and copied with indexed writes into a growing
 *    Float32Array. `number[].push` is ~17x slower than indexed writes, and
 *    decor is where the counts are.
 *
 * ## Winding
 *
 * Props are outward-facing CCW; the shell winds *inward* (dungeon-mesh
 * convention). Back-face culling makes a mis-wound surface an invisible hole,
 * not a dark one — `scripts/check-winding.mts` guards the primitives.
 *
 * No DOM or GPU imports — node-testable like dungeon-mesh.ts.
 */

import type {
  BuildingInterior, AABB, Furniture, Decor, GableSpec,
} from './building-interior';
import {
  bevelBox, box, capsule, cone, cylinder, quad, sphere, taperedCapsule, tri,
  POSN_FLOATS, type P3,
} from '../mesh-utils';

// ---- vertex stride (floats per vertex) ------------------------------------

/** 6 floats (x,y,z,nx,ny,nz) per vertex — position+normal, same as dungeon mesh. */
export const VERTEX_STRIDE = POSN_FLOATS;

// ---- palette indices ------------------------------------------------------
//
// 0..11 are the original dungeon palette. 12..20 were appended for interiors;
// `palette()` / `paletteMaterialId()` in shaders/dungeon.wgsl and
// `paletteMaterial()` in render/material-table.ts must stay in step.

/** Grey masonry (columns, altars, hearth stone, throne base). */
export const PAL_STONE = 0;
/** Mid-brown structural timber (beams, rafters, posts, ladders, tool hafts). */
export const PAL_WOOD = 1;
/** Emissive warm — flickers. Wicks, ember beds, forge coals. */
export const PAL_EMBER = 2;
/** Emissive cool — steady. Window panes: daylight coming in. */
export const PAL_GLASS = 3;
/** Straw gold. Hay, thatch, bread crust, broom bristle. */
export const PAL_STRAW = 4;
/** Pale plaster. Walls and ceilings of every non-keep interior. */
export const PAL_PLASTER = 5;
/** Foliage green — translucent. Hanging herbs, glass bottles. */
export const PAL_GREEN = 6;
/** Deep berry red — translucent. Wine, apples, altar cloth trim. */
export const PAL_BERRY = 7;
/** Dark furniture wood. Tables, beds, chairs, shelves, floorboards. */
export const PAL_FURNITURE_WOOD = 8;
/** Warm red wool. Blankets, rugs, banners. */
export const PAL_FABRIC = 9;
/** Dark firebrick. Fireplaces, forge bodies, braziers. */
export const PAL_FIREBRICK = 10;
/** Off-white wool/linen. Mattresses, pillows, sacks, candles. */
export const PAL_LINEN = 11;
/** Dark iron. Anvils, tools, cauldrons, hinges, chandelier rings. */
export const PAL_IRON = 12;
/** Blue-dyed wool — the second fabric, so nothing reads as a matched set. */
export const PAL_WOOL_BLUE = 13;
/** Green-dyed wool — the third fabric. */
export const PAL_WOOL_GREEN = 14;
/** Terracotta. Crocks, jugs, pots, roof pantiles. */
export const PAL_CLAY = 15;
/** Tanned leather. Boots, bellows, sacks, straps, pelts. */
export const PAL_LEATHER = 16;
/** Brass/gold. Candlesticks, censers, altar fittings, keep plate. */
export const PAL_BRASS = 17;
/** Soot black. Coal, charcoal, the smithy floor. */
export const PAL_SOOT = 18;
/** Pale limewashed timber — reads distinctly against the dark furniture wood. */
export const PAL_PALE_WOOD = 19;
/** Beeswax pale gold. Candles, cheese, tallow. */
export const PAL_WAX = 20;
/** Limewashed felt — the inside face of a domestic wall. Soft, not tiled. */
export const PAL_FELT_WALL = 21;
/** Daylight through a window pane: emissive, but a fraction of PAL_GLASS. */
export const PAL_WINDOW = 22;

/** Every palette this module can emit — used by tests and the draw builder. */
export const INTERIOR_PALETTES: readonly number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
];

// ---- batching -------------------------------------------------------------

/**
 * A growing Float32Array of vertices for one palette. Doubling growth plus
 * indexed writes: no `number[].push` on the hot path.
 */
class PalBatch {
  private buf: Float32Array<ArrayBuffer>;
  private n = 0;

  constructor(initial = 2048) {
    this.buf = new Float32Array(initial) as Float32Array<ArrayBuffer>;
  }

  private ensure(extra: number): void {
    if (this.n + extra <= this.buf.length) return;
    let cap = this.buf.length || 1024;
    while (cap < this.n + extra) cap *= 2;
    const next = new Float32Array(cap) as Float32Array<ArrayBuffer>;
    next.set(this.buf.subarray(0, this.n));
    this.buf = next;
  }

  /** Bulk copy raw pos+normal floats (parametric furniture path). */
  append(src: ArrayLike<number>): void {
    const len = src.length;
    if (len === 0) return;
    this.ensure(len);
    this.buf.set(src as ArrayLike<number>, this.n);
    this.n += len;
  }

  /**
   * Copy a template, rotated by `yaw` about +Y, uniformly scaled, translated.
   * Uniform scale leaves normals unchanged apart from the rotation, which is
   * why templates are uniform-scale only.
   */
  stamp(src: Float32Array, tx: number, ty: number, tz: number, yaw: number, s: number): void {
    const len = src.length;
    if (len === 0) return;
    this.ensure(len);
    const d = this.buf;
    let o = this.n;
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    for (let i = 0; i < len; i += 6) {
      const x = src[i] * s, y = src[i + 1] * s, z = src[i + 2] * s;
      const nx = src[i + 3], ny = src[i + 4], nz = src[i + 5];
      d[o] = x * c - z * sn + tx;
      d[o + 1] = y + ty;
      d[o + 2] = x * sn + z * c + tz;
      d[o + 3] = nx * c - nz * sn;
      d[o + 4] = ny;
      d[o + 5] = nx * sn + nz * c;
      o += 6;
    }
    this.n = o;
  }

  get length(): number { return this.n; }

  finish(): Float32Array<ArrayBuffer> {
    return this.buf.slice(0, this.n) as Float32Array<ArrayBuffer>;
  }
}

/** Palette-indexed collection of batches plus one shared scratch array. */
class MeshOut {
  private readonly batches = new Map<number, PalBatch>();
  /** Shared scratch for the parametric (mesh-utils) path. */
  readonly s: number[] = [];

  pal(index: number): PalBatch {
    let b = this.batches.get(index);
    if (b === undefined) { b = new PalBatch(); this.batches.set(index, b); }
    return b;
  }

  /** Run a mesh-utils builder into the scratch array and flush it to `pal`. */
  emit(pal: number, build: (v: number[]) => void): void {
    this.s.length = 0;
    build(this.s);
    if (this.s.length > 0) this.pal(pal).append(this.s);
    this.s.length = 0;
  }

  finish(): Map<number, Float32Array<ArrayBuffer>> {
    this.foldSmallBatches();
    const out = new Map<number, Float32Array<ArrayBuffer>>();
    for (const k of [...this.batches.keys()].sort((a, b) => a - b)) {
      const b = this.batches.get(k)!;
      if (b.length > 0) out.set(k, b.finish());
    }
    return out;
  }

  /**
   * Every palette in use costs a draw call, and a palette carrying one book
   * clasp is a draw call for nothing. Fold batches under the threshold into a
   * visually adjacent palette *that is already being drawn* — a house loses
   * its four brass verts into the iron batch and nobody can tell, while a
   * church full of brass keeps it. Deterministic order, so the same interior
   * always folds the same way.
   */
  private foldSmallBatches(): void {
    const MIN_VERTS = 420;
    // [palette, fold-into]. Order matters: a chain like clay→leather→wood is
    // walked in this sequence, and folding only happens into a live batch.
    const FOLD: readonly [number, number][] = [
      [PAL_WAX, PAL_LINEN],
      [PAL_PALE_WOOD, PAL_WOOD],
      [PAL_SOOT, PAL_FIREBRICK],
      [PAL_BRASS, PAL_IRON],
      [PAL_CLAY, PAL_LEATHER],
      [PAL_LEATHER, PAL_FURNITURE_WOOD],
      [PAL_IRON, PAL_STONE],
      [PAL_BERRY, PAL_FABRIC],
      [PAL_WOOL_GREEN, PAL_WOOL_BLUE],
      [PAL_STRAW, PAL_LINEN],
      [PAL_PALE_WOOD, PAL_FURNITURE_WOOD],
      [PAL_SOOT, PAL_STONE],
      [PAL_WOOL_BLUE, PAL_FABRIC],
      [PAL_WOOL_GREEN, PAL_FABRIC],
      [PAL_PLASTER, PAL_STONE],
    ];
    for (const [from, into] of FOLD) {
      const src = this.batches.get(from);
      const dst = this.batches.get(into);
      if (src === undefined || dst === undefined) continue;
      if (src.length / POSN_FLOATS >= MIN_VERTS) continue;
      dst.append(src.finish());
      this.batches.delete(from);
    }
  }
}

// ---- decor templates ------------------------------------------------------

/** One template: geometry split by palette, built once, stamped many times. */
interface Tpl { parts: { pal: number; verts: Float32Array }[] }

const TPL_CACHE = new Map<string, Tpl>();

class TplBuilder {
  readonly parts = new Map<number, number[]>();
  p(pal: number): number[] {
    let a = this.parts.get(pal);
    if (a === undefined) { a = []; this.parts.set(pal, a); }
    return a;
  }
}

function tpl(key: string, build: (b: TplBuilder) => void): Tpl {
  let t = TPL_CACHE.get(key);
  if (t !== undefined) return t;
  const b = new TplBuilder();
  build(b);
  t = { parts: [] };
  for (const [pal, verts] of b.parts) {
    if (verts.length > 0) t.parts.push({ pal, verts: Float32Array.from(verts) });
  }
  TPL_CACHE.set(key, t);
  return t;
}

function stampTpl(out: MeshOut, t: Tpl, x: number, y: number, z: number, yaw: number, s: number): void {
  for (const part of t.parts) out.pal(part.pal).stamp(part.verts, x, y, z, yaw, s);
}

// =========================================================================
//  Interior shell
// =========================================================================

/**
 * Floor, ceiling and walls. Winding faces INTO the interior.
 *
 * `part` selects which surfaces to emit so the integration can render the
 * floor with a plank palette and the walls/ceiling with plaster.
 */
export function buildBuildingInteriorMesh(
  interior: BuildingInterior,
  part: 'all' | 'walls' | 'floor' = 'all',
): Float32Array<ArrayBuffer> {
  const { gridW, gridD, cells, ceilY, gable } = interior;
  const verts: number[] = [];

  const CELL_SOLID = 0;
  const emitFloor = part !== 'walls';
  const emitWalls = part !== 'floor';

  const walkable = (x: number, z: number): boolean =>
    x >= 0 && z >= 0 && x < gridW && z < gridD && cells[z * gridW + x] !== CELL_SOLID;
  const ceilAt = (x: number, z: number): number => ceilY[z * gridW + x];
  const underGable = (x: number, z: number): boolean =>
    gable !== null && x >= gable.x0 && x < gable.x1 && z >= gable.z0 && z < gable.z1;

  for (let z = 0; z < gridD; z++) {
    for (let x = 0; x < gridW; x++) {
      if (!walkable(x, z)) continue;
      const ch = ceilAt(x, z);

      // Floor (+Y normal, facing up into interior)
      if (emitFloor) {
        quad(verts, [x, 0, z], [x, 0, z + 1], [x + 1, 0, z + 1], [x + 1, 0, z]);
      }
      if (!emitWalls) continue;
      // Ceiling (-Y normal, facing down into interior). Cells under a gable
      // get the sloped roof instead, emitted once for the whole rect below.
      if (!underGable(x, z)) {
        quad(verts, [x, ch, z], [x + 1, ch, z], [x + 1, ch, z + 1], [x, ch, z + 1]);
      }

      // Walls toward solid neighbours (same approach as dungeon-mesh)
      // East (+x): wall at plane x+1, facing -X into this cell
      if (!walkable(x + 1, z)) {
        quad(verts, [x + 1, 0, z], [x + 1, 0, z + 1], [x + 1, ch, z + 1], [x + 1, ch, z]);
      } else if (ceilAt(x + 1, z) < ch) {
        const y0 = ceilAt(x + 1, z);
        quad(verts, [x + 1, y0, z], [x + 1, y0, z + 1], [x + 1, ch, z + 1], [x + 1, ch, z]);
      }
      // West (-x): wall at plane x, facing +X
      if (!walkable(x - 1, z)) {
        quad(verts, [x, 0, z + 1], [x, 0, z], [x, ch, z], [x, ch, z + 1]);
      } else if (ceilAt(x - 1, z) < ch) {
        const y0 = ceilAt(x - 1, z);
        quad(verts, [x, y0, z + 1], [x, y0, z], [x, ch, z], [x, ch, z + 1]);
      }
      // South (+z): wall at plane z+1, facing -Z
      if (!walkable(x, z + 1)) {
        quad(verts, [x + 1, 0, z + 1], [x, 0, z + 1], [x, ch, z + 1], [x + 1, ch, z + 1]);
      } else if (ceilAt(x, z + 1) < ch) {
        const y0 = ceilAt(x, z + 1);
        quad(verts, [x + 1, y0, z + 1], [x, y0, z + 1], [x, ch, z + 1], [x + 1, ch, z + 1]);
      }
      // North (-z): wall at plane z, facing +Z
      if (!walkable(x, z - 1)) {
        quad(verts, [x, 0, z], [x + 1, 0, z], [x + 1, ch, z], [x, ch, z]);
      } else if (ceilAt(x, z - 1) < ch) {
        const y0 = ceilAt(x, z - 1);
        quad(verts, [x, y0, z], [x + 1, y0, z], [x + 1, ch, z], [x, ch, z]);
      }
    }
  }

  if (emitWalls && gable !== null) emitGable(verts, gable);

  return Float32Array.from(verts) as Float32Array<ArrayBuffer>;
}

/**
 * Sloped ceiling over a rect, with the gable-end triangles that close it.
 * Normals face down-and-inward, so the underside is what the player sees.
 */
function emitGable(verts: number[], gb: GableSpec): void {
  const { x0, z0, x1, z1, eaves: e, ridge: r } = gb;
  if (gb.axis === 'z') {
    // Ridge runs along Z at the mid-X line.
    const xm = (x0 + x1) / 2;
    quad(verts, [x0, e, z1], [x0, e, z0], [xm, r, z0], [xm, r, z1]);   // -X slope
    quad(verts, [xm, r, z1], [xm, r, z0], [x1, e, z0], [x1, e, z1]);   // +X slope
    tri(verts, [x0, e, z0], [x1, e, z0], [xm, r, z0]);                 // -Z gable end
    tri(verts, [x1, e, z1], [x0, e, z1], [xm, r, z1]);                 // +Z gable end
  } else {
    // Ridge runs along X at the mid-Z line.
    const zm = (z0 + z1) / 2;
    quad(verts, [x0, e, z0], [x1, e, z0], [x1, r, zm], [x0, r, zm]);   // -Z slope
    quad(verts, [x1, e, z1], [x0, e, z1], [x0, r, zm], [x1, r, zm]);   // +Z slope
    tri(verts, [x0, e, z1], [x0, e, z0], [x0, r, zm]);                 // -X gable end
    tri(verts, [x1, e, z0], [x1, e, z1], [x1, r, zm]);                 // +X gable end
  }
}

// =========================================================================
//  Furniture
// =========================================================================

/** Rotate an AABB-local point into world space around the piece's centre. */
interface Frame {
  cx: number; cz: number; c: number; s: number;
  /** Half-extents along the piece's own axes (before yaw). */
  hw: number; hd: number;
  y0: number; y1: number;
}

function frameOf(f: Furniture): Frame {
  const a = f.aabb;
  const cx = (a.minX + a.maxX) / 2;
  const cz = (a.minZ + a.maxZ) / 2;
  const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
  // The AABB is axis-aligned; for the yaws we use (multiples of pi/2 plus a
  // small jitter) the local extents are the AABB extents swapped when the
  // rotation is closer to +-90 degrees.
  const swap = Math.abs(s) > Math.abs(c);
  const ex = (a.maxX - a.minX) / 2;
  const ez = (a.maxZ - a.minZ) / 2;
  return {
    cx, cz, c, s,
    hw: swap ? ez : ex,
    hd: swap ? ex : ez,
    y0: a.minY, y1: a.maxY,
  };
}

/**
 * Build a piece in its own local frame (x right, z forward, y up, centred on
 * the origin at floor level) and stamp it. Local building keeps every piece
 * readable and lets yaw actually mean something.
 */
function local(out: MeshOut, fr: Frame, pal: number, build: (v: number[]) => void): void {
  out.s.length = 0;
  build(out.s);
  if (out.s.length === 0) return;
  const b = out.pal(pal);
  // Reuse the stamp path (rotate + translate, scale 1).
  const tmp = Float32Array.from(out.s);
  b.stamp(tmp, fr.cx, 0, fr.cz, Math.atan2(fr.s, fr.c), 1);
  out.s.length = 0;
}

/**
 * Every furniture piece. Local frame: origin at the centre of the footprint on
 * the floor, +Z is the piece's "front" (the side a person uses).
 */
function buildFurniturePiece(out: MeshOut, f: Furniture): void {
  const fr = frameOf(f);
  const { hw, hd, y1: h } = fr;
  const v = f.variant;
  const woodPal = (v & 1) === 0 ? PAL_FURNITURE_WOOD : PAL_PALE_WOOD;

  switch (f.type) {
    // ---- seating and tables ---------------------------------------------
    case 'table': {
      const topT = Math.min(0.09, h * 0.22);
      local(out, fr, PAL_FURNITURE_WOOD, (a) => {
        bevelBox(a, -hw, h - topT, -hd, hw, h, hd, 0.03);
        // Plank seams across the top read as boards, not a slab.
        const planks = Math.max(2, Math.round(hd * 4));
        for (let i = 1; i < planks; i++) {
          const z = -hd + (i / planks) * hd * 2;
          box(a, -hw + 0.02, h - 0.004, z - 0.008, hw - 0.02, h + 0.004, z + 0.008);
        }
        const li = 0.13;
        for (const [lx, lz] of [
          [-hw + li, -hd + li], [hw - li, -hd + li],
          [-hw + li, hd - li], [hw - li, hd - li],
        ]) {
          cylinder(a, lx, 0, lz, 0.05, 0.042, h - topT, 6, false, false);
        }
        // Stretcher between the legs.
        box(a, -hw + li, h * 0.28, -0.03, hw - li, h * 0.28 + 0.055, 0.03);
      });
      break;
    }
    case 'stool': {
      local(out, fr, woodPal, (a) => {
        cylinder(a, 0, h - 0.06, 0, Math.min(hw, hd) * 0.95, Math.min(hw, hd), 0.06, 8);
        for (let i = 0; i < 3; i++) {
          const ang = (i / 3) * Math.PI * 2 + 0.4;
          const rr = Math.min(hw, hd) * 0.62;
          capsule(a, Math.cos(ang) * rr * 0.35, h - 0.06, Math.sin(ang) * rr * 0.35,
            Math.cos(ang) * rr, 0.02, Math.sin(ang) * rr, 0.028, 5);
        }
      });
      break;
    }
    case 'chair': {
      local(out, fr, woodPal, (a) => {
        const seatY = h * 0.5;
        bevelBox(a, -hw, seatY - 0.05, -hd, hw, seatY, hd, 0.02);
        for (const [lx, lz] of [
          [-hw + 0.05, -hd + 0.05], [hw - 0.05, -hd + 0.05],
          [-hw + 0.05, hd - 0.05], [hw - 0.05, hd - 0.05],
        ]) cylinder(a, lx, 0, lz, 0.032, 0.028, seatY - 0.05, 5, false, false);
        // Back: two uprights and two rails, at the -Z side.
        for (const lx of [-hw + 0.05, hw - 0.05]) {
          cylinder(a, lx, seatY, -hd + 0.05, 0.03, 0.024, h - seatY, 5, false, true);
        }
        for (const yy of [h - 0.12, h - 0.30]) {
          if (yy > seatY + 0.03) box(a, -hw + 0.03, yy, -hd + 0.02, hw - 0.03, yy + 0.055, -hd + 0.08);
        }
      });
      break;
    }
    case 'bench': {
      local(out, fr, PAL_FURNITURE_WOOD, (a) => {
        bevelBox(a, -hw, h - 0.07, -hd, hw, h, hd, 0.025);
        for (const lx of [-hw + 0.18, hw - 0.18]) {
          bevelBox(a, lx - 0.05, 0, -hd + 0.04, lx + 0.05, h - 0.07, hd - 0.04, 0.02);
        }
        box(a, -hw + 0.18, h * 0.35, -0.035, hw - 0.18, h * 0.35 + 0.05, 0.035);
      });
      break;
    }
    case 'pew': {
      local(out, fr, PAL_FURNITURE_WOOD, (a) => {
        const seatY = 0.46;
        bevelBox(a, -hw, seatY - 0.06, -hd, hw, seatY, hd, 0.02);
        // Solid end cheeks and a back board — the church silhouette.
        for (const lx of [-hw, hw - 0.07]) bevelBox(a, lx, 0, -hd, lx + 0.07, h, hd, 0.02);
        bevelBox(a, -hw, seatY + 0.12, -hd, hw, h, -hd + 0.07, 0.02);
        // Kneeler rail along the front.
        box(a, -hw + 0.08, 0.12, hd - 0.09, hw - 0.08, 0.19, hd - 0.02);
      });
      break;
    }

    // ---- sleeping ---------------------------------------------------------
    case 'bed': {
      const frameTop = 0.26;
      const matTop = 0.44;
      local(out, fr, PAL_FURNITURE_WOOD, (a) => {
        bevelBox(a, -hw, 0.12, -hd, hw, frameTop, hd, 0.03);
        // Headboard at -Z, with turned posts at every corner.
        bevelBox(a, -hw, 0.12, -hd, hw, h + 0.28, -hd + 0.08, 0.03);
        for (const [px, pz] of [
          [-hw + 0.05, -hd + 0.05], [hw - 0.05, -hd + 0.05],
          [-hw + 0.05, hd - 0.05], [hw - 0.05, hd - 0.05],
        ]) {
          const tall = pz < 0 ? h + 0.34 : h * 0.62;
          cylinder(a, px, 0, pz, 0.05, 0.042, tall, 6, false, true);
          sphere(a, px, tall, pz, 0.05, 6, 4);
        }
      });
      local(out, fr, PAL_LINEN, (a) => {
        // Mattress: a stuffed sack, not a slab.
        bevelBox(a, -hw + 0.06, frameTop, -hd + 0.09, hw - 0.06, matTop, hd - 0.05, 0.05);
        // Pillow, plumped and slightly off-centre.
        sphere(a, -0.02, matTop + 0.06, -hd + 0.32, 0.19, 8, 4, 0.5, 0.62);
      });
      const blanketPal = v === 0 ? PAL_FABRIC : v === 1 ? PAL_WOOL_BLUE : PAL_WOOL_GREEN;
      local(out, fr, blanketPal, (a) => {
        // Blanket over the lower two-thirds, hanging over the near side.
        bevelBox(a, -hw + 0.01, matTop - 0.03, -hd + 0.55, hw - 0.01, matTop + 0.07, hd - 0.02, 0.04);
        bevelBox(a, hw - 0.05, frameTop, -hd + 0.6, hw + 0.03, matTop + 0.05, hd - 0.08, 0.02);
      });
      break;
    }
    case 'bunk': {
      const lowY = 0.42, highY = Math.max(1.05, h - 0.55);
      local(out, fr, PAL_FURNITURE_WOOD, (a) => {
        for (const [px, pz] of [
          [-hw + 0.06, -hd + 0.06], [hw - 0.06, -hd + 0.06],
          [-hw + 0.06, hd - 0.06], [hw - 0.06, hd - 0.06],
        ]) cylinder(a, px, 0, pz, 0.055, 0.05, h, 6, false, true);
        for (const yy of [lowY, highY]) {
          bevelBox(a, -hw + 0.03, yy - 0.06, -hd + 0.03, hw - 0.03, yy, hd - 0.03, 0.02);
          box(a, -hw + 0.02, yy, -hd + 0.02, hw - 0.02, yy + 0.07, -hd + 0.07);
        }
      });
      local(out, fr, PAL_LINEN, (a) => {
        for (const yy of [lowY, highY]) {
          bevelBox(a, -hw + 0.07, yy, -hd + 0.07, hw - 0.07, yy + 0.11, hd - 0.07, 0.04);
        }
      });
      local(out, fr, v === 0 ? PAL_WOOL_BLUE : PAL_FABRIC, (a) => {
        bevelBox(a, -hw + 0.05, lowY + 0.08, -hd + 0.4, hw - 0.05, lowY + 0.16, hd - 0.05, 0.03);
        bevelBox(a, -hw + 0.05, highY + 0.08, -hd + 0.5, hw - 0.05, highY + 0.15, hd - 0.05, 0.03);
      });
      break;
    }
    case 'sleepbench': {
      // A raised timber platform down a longhouse wall, with a fur on it.
      local(out, fr, PAL_FURNITURE_WOOD, (a) => {
        bevelBox(a, -hw, h - 0.1, -hd, hw, h, hd, 0.03);
        for (const lz of [-hd + 0.2, 0, hd - 0.2]) {
          bevelBox(a, -hw + 0.04, 0, lz - 0.06, -hw + 0.16, h - 0.1, lz + 0.06, 0.02);
          bevelBox(a, hw - 0.16, 0, lz - 0.06, hw - 0.04, h - 0.1, lz + 0.06, 0.02);
        }
        // Front board, so the platform reads as a box bed.
        bevelBox(a, -hw, 0.05, hd - 0.08, hw, h - 0.1, hd, 0.02);
      });
      local(out, fr, PAL_STRAW, (a) => {
        bevelBox(a, -hw + 0.08, h, -hd + 0.1, hw - 0.08, h + 0.09, hd - 0.1, 0.04);
      });
      break;
    }

    // ---- fire -------------------------------------------------------------
    case 'hearth': {
      const t = 0.16;
      local(out, fr, PAL_FIREBRICK, (a) => {
        bevelBox(a, -hw, 0, -hd, hw, 0.13, hd, 0.03);                    // hearthstone
        bevelBox(a, -hw, 0, -hd, hw, h, -hd + t, 0.04);                  // back
        bevelBox(a, -hw, 0, -hd, -hw + t, h, hd, 0.04);                  // left cheek
        bevelBox(a, hw - t, 0, -hd, hw, h, hd, 0.04);                    // right cheek
        bevelBox(a, -hw, h - 0.16, -hd, hw, h, hd, 0.04);                // lintel
        // Chimney breast tapering up out of the lintel.
        bevelBox(a, -hw + 0.1, h, -hd, hw - 0.1, h + 0.5, hd - 0.12, 0.05);
      });
      local(out, fr, PAL_STONE, (a) => {
        // Mantel shelf — where the candlestick and the crock live.
        bevelBox(a, -hw - 0.06, h - 0.16, -hd, hw + 0.06, h - 0.05, hd + 0.09, 0.02);
      });
      break;
    }
    case 'firetrench': {
      local(out, fr, PAL_STONE, (a) => {
        // Kerb stones down both long sides, gapped like laid rubble.
        const n = Math.max(4, Math.round(hd * 2.2));
        for (let i = 0; i < n; i++) {
          const z = -hd + (i + 0.5) * (hd * 2 / n);
          const l = (hd * 2 / n) * 0.42;
          bevelBox(a, -hw, 0, z - l, -hw + 0.24, h * (0.7 + 0.3 * ((i * 7) % 3) / 2), z + l, 0.03);
          bevelBox(a, hw - 0.24, 0, z - l, hw, h * (0.7 + 0.3 * ((i * 5) % 3) / 2), z + l, 0.03);
        }
        bevelBox(a, -hw, 0, -hd, hw, 0.05, hd, 0.02);
      });
      local(out, fr, PAL_SOOT, (a) => {
        bevelBox(a, -hw + 0.22, 0.05, -hd + 0.05, hw - 0.22, 0.13, hd - 0.05, 0.03);
      });
      break;
    }
    case 'forge': {
      local(out, fr, PAL_FIREBRICK, (a) => {
        bevelBox(a, -hw, 0, -hd, hw, h * 0.72, hd, 0.05);                // masonry block
        // Firebox lip around a recessed bed.
        bevelBox(a, -hw + 0.1, h * 0.72, -hd + 0.08, hw - 0.1, h * 0.72 + 0.13, hd - 0.08, 0.03);
      });
      local(out, fr, PAL_SOOT, (a) => {
        bevelBox(a, -hw + 0.2, h * 0.7, -hd + 0.18, hw - 0.2, h * 0.72 + 0.05, hd - 0.18, 0.03);
      });
      local(out, fr, PAL_STONE, (a) => {
        // Chimney hood: a tapered canopy over the fire, the smithy's silhouette.
        const y0 = h + 0.1;
        cylinder(a, 0, y0, 0, Math.max(hw, hd) * 1.05, 0.32, 0.85, 4, false, false);
        cylinder(a, 0, y0 + 0.85, 0, 0.3, 0.26, 1.1, 6, false, false);
        box(a, -hw, h * 0.72 + 0.1, -hd, hw, y0, -hd + 0.14);
      });
      break;
    }
    case 'brazier': {
      local(out, fr, PAL_IRON, (a) => {
        const outerR = Math.min(hw, hd);
        const bowlY = h - 0.26;
        // Three splayed legs into a ring, then the bowl.
        for (let i = 0; i < 3; i++) {
          const ang = (i / 3) * Math.PI * 2;
          capsule(a, Math.cos(ang) * outerR * 0.62, 0, Math.sin(ang) * outerR * 0.62,
            Math.cos(ang) * outerR * 0.2, bowlY, Math.sin(ang) * outerR * 0.2, 0.032, 5);
        }
        cylinder(a, 0, bowlY, 0, outerR * 0.72, outerR, 0.24, 8, true, false);
        cylinder(a, 0, bowlY + 0.2, 0, outerR, outerR, 0.05, 8, false, true);
      });
      local(out, fr, PAL_SOOT, (a) => {
        cylinder(a, 0, h - 0.09, 0, Math.min(hw, hd) * 0.88, Math.min(hw, hd) * 0.9, 0.05, 8);
      });
      break;
    }
    case 'cauldron': {
      local(out, fr, PAL_IRON, (a) => {
        const r = Math.min(hw, hd);
        sphere(a, 0, r * 0.9, 0, r, 10, 5, 0.85, 1);
        cylinder(a, 0, r * 1.5, 0, r * 0.72, r * 0.78, 0.08, 10, false, false);
        for (let i = 0; i < 3; i++) {
          const ang = (i / 3) * Math.PI * 2;
          capsule(a, Math.cos(ang) * r * 0.6, r * 0.35, Math.sin(ang) * r * 0.6,
            Math.cos(ang) * r * 0.8, 0, Math.sin(ang) * r * 0.8, 0.03, 5);
        }
      });
      break;
    }

    // ---- work -------------------------------------------------------------
    case 'anvil': {
      local(out, fr, PAL_WOOD, (a) => {
        // Elm stump the anvil is bedded on.
        cylinder(a, 0, 0, 0, hw * 0.95, hw * 0.88, h * 0.52, 9);
      });
      local(out, fr, PAL_IRON, (a) => {
        const y = h * 0.52;
        bevelBox(a, -hw * 0.72, y, -hd * 0.8, hw * 0.72, y + 0.09, hd * 0.8, 0.02);   // foot
        bevelBox(a, -hw * 0.42, y + 0.09, -hd * 0.5, hw * 0.42, y + 0.24, hd * 0.5, 0.02); // waist
        bevelBox(a, -hw * 0.85, y + 0.24, -hd * 0.85, hw * 0.85, h, hd * 0.85, 0.02);  // face
        // Horn out the +X end, heel out the other.
        cylinder(a, hw * 0.85, y + 0.3, 0, hd * 0.6, 0.02, 0.34, 6, false, false);
      });
      break;
    }
    case 'quench': {
      local(out, fr, PAL_FURNITURE_WOOD, (a) => {
        cylinder(a, 0, 0, 0, Math.min(hw, hd) * 0.9, Math.min(hw, hd), h, 9, true, false);
      });
      local(out, fr, PAL_IRON, (a) => {
        for (const yy of [h * 0.25, h * 0.85]) {
          cylinder(a, 0, yy, 0, Math.min(hw, hd) * 1.02, Math.min(hw, hd) * 1.02, 0.04, 9, false, false);
        }
      });
      local(out, fr, PAL_WOOL_BLUE, (a) => {
        // Water surface. Not emissive: a quench trough that glows brighter than
        // the forge is the first thing anyone notices, and it is wrong.
        cylinder(a, 0, h - 0.08, 0, Math.min(hw, hd) * 0.93, Math.min(hw, hd) * 0.93, 0.012, 9);
      });
      break;
    }
    case 'workbench': {
      local(out, fr, PAL_FURNITURE_WOOD, (a) => {
        bevelBox(a, -hw, h - 0.1, -hd, hw, h, hd, 0.03);
        for (const lz of [-hd + 0.16, hd - 0.16]) {
          bevelBox(a, -hw + 0.05, 0, lz - 0.06, -hw + 0.17, h - 0.1, lz + 0.06, 0.02);
          bevelBox(a, hw - 0.17, 0, lz - 0.06, hw - 0.05, h - 0.1, lz + 0.06, 0.02);
        }
        box(a, -hw + 0.06, 0.16, -hd + 0.1, hw - 0.06, 0.24, hd - 0.1);   // lower shelf
      });
      local(out, fr, PAL_IRON, (a) => {
        // A vice bolted to the near corner.
        bevelBox(a, hw - 0.28, h, hd - 0.2, hw - 0.06, h + 0.17, hd - 0.02, 0.02);
      });
      break;
    }
    case 'grindstone': {
      local(out, fr, PAL_WOOD, (a) => {
        for (const lx of [-hw + 0.06, hw - 0.06]) {
          bevelBox(a, lx - 0.05, 0, -hd + 0.03, lx + 0.05, h, hd - 0.03, 0.02);
        }
        box(a, -hw, 0.12, -hd + 0.06, hw, 0.2, hd - 0.06);
      });
      local(out, fr, PAL_STONE, (a) => {
        cylinder(a, 0, h * 0.62, -0.035, hd * 0.85, hd * 0.85, 0.07, 12);
      });
      local(out, fr, PAL_IRON, (a) => {
        cylinder(a, 0, h * 0.62 - 0.02, -0.12, 0.022, 0.022, 0.2, 5);
      });
      break;
    }
    case 'bellows': {
      local(out, fr, PAL_LEATHER, (a) => {
        // Two boards pinched to a nozzle: a wedge, widest at -Z.
        const yy = h * 0.55;
        quad(a, [-hw, yy, -hd], [hw, yy, -hd], [0.03, yy + 0.02, hd], [-0.03, yy + 0.02, hd]);
        taperedCapsule(a, 0, yy, -hd * 0.6, 0, yy, hd * 0.4, hw * 0.85, 0.07, 8);
      });
      local(out, fr, PAL_FURNITURE_WOOD, (a) => {
        const yy = h * 0.55;
        bevelBox(a, -hw, yy + 0.05, -hd, hw, yy + 0.11, hd * 0.2, 0.03);
        bevelBox(a, -hw, yy - 0.13, -hd, hw, yy - 0.07, hd * 0.2, 0.03);
        cylinder(a, 0, 0, hd * 0.4, 0.05, 0.05, yy - 0.1, 6, false, false);
        capsule(a, 0, yy + 0.11, -hd * 0.5, 0, yy + 0.52, -hd * 0.9, 0.035, 5);
      });
      local(out, fr, PAL_IRON, (a) => {
        cylinder(a, 0, h * 0.55, hd * 0.35, 0.045, 0.03, 0.3, 6, false, true);
      });
      break;
    }
    case 'loom': {
      local(out, fr, PAL_FURNITURE_WOOD, (a) => {
        for (const lx of [-hw + 0.06, hw - 0.06]) {
          bevelBox(a, lx - 0.05, 0, -hd + 0.06, lx + 0.05, h, hd - 0.06, 0.02);
        }
        for (const yy of [h - 0.06, h * 0.55, 0.22]) {
          cylinder(a, -hw, yy, 0, 0.04, 0.04, hw * 2, 6, false, false);
        }
      });
      // Warp threads: the point of a loom, and cheap.
      local(out, fr, PAL_LINEN, (a) => {
        const n = 9;
        for (let i = 0; i < n; i++) {
          const x = -hw + 0.12 + (i / (n - 1)) * (hw * 2 - 0.24);
          box(a, x - 0.008, 0.22, -0.008, x + 0.008, h - 0.06, 0.008);
        }
      });
      local(out, fr, PAL_WOOL_BLUE, (a) => {
        bevelBox(a, -hw + 0.1, 0.22, -0.035, hw - 0.1, h * 0.42, 0.035, 0.02);
      });
      break;
    }

    // ---- storage and trade -------------------------------------------------
    case 'counter': {
      local(out, fr, PAL_FURNITURE_WOOD, (a) => {
        bevelBox(a, -hw, h - 0.09, -hd - 0.06, hw, h, hd + 0.06, 0.03);   // top, overhanging
        bevelBox(a, -hw + 0.03, 0, -hd, hw - 0.03, h - 0.09, hd, 0.03);   // body
        // Panel lines down the customer side.
        const n = Math.max(2, Math.round(hw * 1.6));
        for (let i = 1; i < n; i++) {
          const x = -hw + (i / n) * hw * 2;
          box(a, x - 0.015, 0.12, hd - 0.005, x + 0.015, h - 0.16, hd + 0.02);
        }
        box(a, -hw + 0.06, 0.2, -hd + 0.04, hw - 0.06, 0.28, hd - 0.04);  // inside shelf
      });
      break;
    }
    case 'shelf': {
      local(out, fr, PAL_FURNITURE_WOOD, (a) => {
        for (const lx of [-hw, hw - 0.07]) bevelBox(a, lx, 0, -hd, lx + 0.07, h, hd, 0.02);
        bevelBox(a, -hw, 0, -hd, hw, h, -hd + 0.05, 0.02);
        const boards = Math.max(2, Math.floor(h / 0.5));
        for (let i = 0; i <= boards; i++) {
          const y = 0.1 + (i / boards) * (h - 0.18);
          bevelBox(a, -hw + 0.05, y, -hd + 0.02, hw - 0.05, y + 0.045, hd, 0.015);
        }
      });
      break;
    }
    case 'cupboard':
    case 'wardrobe': {
      const tall = f.type === 'wardrobe';
      local(out, fr, woodPal, (a) => {
        bevelBox(a, -hw, 0.08, -hd, hw, h, hd, 0.03);
        for (const lx of [-hw + 0.05, hw - 0.16]) {
          box(a, lx, 0.16, hd - 0.01, lx + 0.11, h - 0.08, hd + 0.02);      // door panel
        }
        box(a, -hw + 0.02, 0, -hd + 0.02, -hw + 0.1, 0.08, hd - 0.02);      // feet
        box(a, hw - 0.1, 0, -hd + 0.02, hw - 0.02, 0.08, hd - 0.02);
        if (!tall) bevelBox(a, -hw - 0.03, h, -hd - 0.02, hw + 0.03, h + 0.04, hd + 0.03, 0.02);
      });
      local(out, fr, PAL_IRON, (a) => {
        for (const lx of [-hw + 0.14, hw - 0.14]) {
          sphere(a, lx, h * 0.55, hd + 0.03, 0.028, 6, 4);
        }
      });
      break;
    }
    case 'barrel': {
      const r = Math.min(hw, hd);
      local(out, fr, PAL_FURNITURE_WOOD, (a) => {
        // Staves bulge at the belly — a plain cylinder reads as a bin.
        cylinder(a, 0, 0, 0, r * 0.86, r, h * 0.42, 10, true, false);
        cylinder(a, 0, h * 0.42, 0, r, r * 0.86, h * 0.58, 10, false, true);
      });
      local(out, fr, PAL_IRON, (a) => {
        for (const yy of [h * 0.12, h * 0.42, h * 0.82]) {
          const rr = yy < h * 0.42 ? r * (0.86 + 0.14 * (yy / (h * 0.42)))
            : r * (1 - 0.14 * ((yy - h * 0.42) / (h * 0.58)));
          cylinder(a, 0, yy - 0.02, 0, rr + 0.012, rr + 0.012, 0.045, 10, false, false);
        }
      });
      if (v === 1) {
        local(out, fr, PAL_IRON, (a) => {
          cylinder(a, 0, h * 0.5, r * 0.9, 0.028, 0.02, 0.16, 5, false, true);   // tap
        });
      }
      break;
    }
    case 'crate': {
      local(out, fr, PAL_PALE_WOOD, (a) => {
        bevelBox(a, -hw, 0, -hd, hw, h, hd, 0.02);
        // Corner battens.
        for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as [number, number][]) {
          box(a, sx > 0 ? hw - 0.06 : -hw, 0, sz > 0 ? hd - 0.005 : -hd - 0.005,
            sx > 0 ? hw + 0.005 : -hw + 0.06, h, sz > 0 ? hd + 0.005 : -hd + 0.005);
        }
        for (const yy of [h * 0.25, h * 0.75]) {
          box(a, -hw - 0.005, yy, -hd - 0.005, hw + 0.005, yy + 0.05, -hd + 0.005);
          box(a, -hw - 0.005, yy, hd - 0.005, hw + 0.005, yy + 0.05, hd + 0.005);
        }
      });
      break;
    }
    case 'sacks': {
      local(out, fr, PAL_LINEN, (a) => {
        // Three grain sacks slumped against each other.
        const spots: [number, number, number][] = [
          [-hw * 0.45, 0, hd * 0.2], [hw * 0.4, 0, -hd * 0.25], [0, 0, hd * 0.55],
        ];
        for (let i = 0; i < spots.length; i++) {
          const [sx, , sz] = spots[i];
          const hh = h * (0.78 + 0.22 * ((i * 5) % 3) / 2);
          taperedCapsule(a, sx, 0.02, sz, sx * 0.6, hh, sz * 0.6, hw * 0.44, hw * 0.22, 8);
          sphere(a, sx * 0.6, hh + 0.03, sz * 0.6, hw * 0.15, 6, 4);
        }
      });
      break;
    }
    case 'strongbox': {
      local(out, fr, PAL_FURNITURE_WOOD, (a) => bevelBox(a, -hw, 0, -hd, hw, h, hd, 0.03));
      local(out, fr, PAL_IRON, (a) => {
        for (const lx of [-hw + 0.06, 0, hw - 0.06]) {
          box(a, lx - 0.02, -0.002, -hd - 0.006, lx + 0.02, h + 0.006, hd + 0.006);
        }
        box(a, -hw - 0.006, h * 0.55, -hd - 0.006, hw + 0.006, h * 0.55 + 0.04, hd + 0.006);
        box(a, -0.05, h * 0.42, hd, 0.05, h * 0.62, hd + 0.035);
      });
      break;
    }
    case 'coalbin': {
      local(out, fr, PAL_PALE_WOOD, (a) => {
        for (const [x0, z0, x1, z1] of [
          [-hw, -hd, hw, -hd + 0.06], [-hw, hd - 0.06, hw, hd],
          [-hw, -hd, -hw + 0.06, hd], [hw - 0.06, -hd, hw, hd],
        ] as [number, number, number, number][]) bevelBox(a, x0, 0, z0, x1, h, z1, 0.02);
      });
      local(out, fr, PAL_SOOT, (a) => {
        for (let i = 0; i < 7; i++) {
          const ang = i * 2.399;
          const rr = (i / 7) * Math.min(hw, hd) * 0.72;
          sphere(a, Math.cos(ang) * rr, h * 0.6 + ((i % 3) * 0.05), Math.sin(ang) * rr,
            0.09 + (i % 3) * 0.02, 6, 4);
        }
      });
      break;
    }
    case 'haybale': {
      local(out, fr, PAL_STRAW, (a) => {
        bevelBox(a, -hw, 0, -hd, hw, h, hd, 0.1);
        // Loose ends sticking out — hay is never a neat box.
        for (let i = 0; i < 6; i++) {
          const ang = i * 1.7 + v;
          const px = Math.cos(ang) * hw * 0.9, pz = Math.sin(ang) * hd * 0.9;
          capsule(a, px, h * 0.3 + (i % 3) * 0.2, pz,
            px * 1.35, h * 0.3 + (i % 3) * 0.2 + 0.06, pz * 1.35, 0.02, 4);
        }
      });
      local(out, fr, PAL_LEATHER, (a) => {
        for (const lx of [-hw * 0.45, hw * 0.45]) {
          box(a, lx - 0.02, -0.002, -hd - 0.008, lx + 0.02, h + 0.008, hd + 0.008);
        }
      });
      break;
    }
    case 'trough': {
      // Also used as a stall divider (variant 3): a rail fence, not a box.
      if (v === 3) {
        local(out, fr, PAL_WOOD, (a) => {
          for (const lx of [-hw + 0.07, hw - 0.07]) {
            cylinder(a, lx, 0, 0, 0.06, 0.05, h, 6, false, true);
          }
          for (const yy of [h * 0.45, h * 0.85]) {
            box(a, -hw, yy, -0.045, hw, yy + 0.075, 0.045);
          }
        });
      } else {
        local(out, fr, PAL_WOOD, (a) => {
          bevelBox(a, -hw, 0, -hd, hw, h, hd, 0.03);
          box(a, -hw + 0.07, h - 0.12, -hd + 0.07, hw - 0.07, h + 0.01, hd - 0.07);
        });
        local(out, fr, PAL_STRAW, (a) => {
          bevelBox(a, -hw + 0.09, h - 0.14, -hd + 0.09, hw - 0.09, h - 0.02, hd - 0.09, 0.03);
        });
      }
      break;
    }

    // ---- status and worship -----------------------------------------------
    case 'throne': {
      const seatY = h * 0.34;
      local(out, fr, v === 1 ? PAL_FURNITURE_WOOD : PAL_STONE, (a) => {
        bevelBox(a, -hw, 0, -hd, hw, seatY, hd, 0.05);
        bevelBox(a, -hw, seatY, -hd, hw, h, -hd + 0.16, 0.05);
        for (const lx of [-hw, hw - 0.13]) {
          bevelBox(a, lx, seatY, -hd, lx + 0.13, seatY + 0.34, hd - 0.05, 0.03);
        }
      });
      local(out, fr, PAL_WOOD, (a) => {
        // Carved finials on the back uprights.
        for (const lx of [-hw + 0.09, hw - 0.09]) {
          cylinder(a, lx, h, -hd + 0.08, 0.055, 0.03, 0.14, 6, false, true);
          sphere(a, lx, h + 0.17, -hd + 0.08, 0.055, 6, 4);
        }
      });
      local(out, fr, v === 1 ? PAL_LEATHER : PAL_FABRIC, (a) => {
        bevelBox(a, -hw + 0.08, seatY, -hd + 0.14, hw - 0.08, seatY + 0.1, hd - 0.06, 0.04);
        bevelBox(a, -hw + 0.1, seatY + 0.12, -hd + 0.14, hw - 0.1, h - 0.12, -hd + 0.2, 0.03);
      });
      break;
    }
    case 'altar': {
      local(out, fr, PAL_STONE, (a) => {
        bevelBox(a, -hw, 0, -hd, hw, 0.1, hd, 0.03);
        bevelBox(a, -hw + 0.1, 0.1, -hd + 0.08, hw - 0.1, h - 0.1, hd - 0.08, 0.04);
        bevelBox(a, -hw, h - 0.1, -hd, hw, h, hd, 0.03);
      });
      local(out, fr, PAL_LINEN, (a) => {
        // Altar cloth hanging over both long sides.
        bevelBox(a, -hw - 0.02, h, -hd - 0.02, hw + 0.02, h + 0.02, hd + 0.02, 0.02);
        box(a, -hw - 0.02, h - 0.32, hd, hw + 0.02, h + 0.01, hd + 0.022);
        box(a, -hw - 0.02, h - 0.32, -hd - 0.022, hw + 0.02, h + 0.01, -hd);
      });
      local(out, fr, PAL_FABRIC, (a) => {
        box(a, -hw - 0.025, h - 0.36, hd - 0.001, hw + 0.025, h - 0.3, hd + 0.026);
      });
      break;
    }
    case 'font': {
      local(out, fr, PAL_STONE, (a) => {
        const r = Math.min(hw, hd);
        cylinder(a, 0, 0, 0, r, r * 0.72, 0.12, 8);
        cylinder(a, 0, 0.12, 0, r * 0.34, r * 0.4, h - 0.42, 8, false, false);
        cylinder(a, 0, h - 0.3, 0, r * 0.55, r, 0.3, 10, false, false);
        cylinder(a, 0, h, 0, r, r * 0.9, 0.04, 10, false, true);
      });
      local(out, fr, PAL_WOOL_BLUE, (a) => {
        cylinder(a, 0, h - 0.06, 0, Math.min(hw, hd) * 0.82, Math.min(hw, hd) * 0.82, 0.012, 10);
      });
      break;
    }
    case 'lectern': {
      local(out, fr, PAL_FURNITURE_WOOD, (a) => {
        const r = Math.min(hw, hd);
        cylinder(a, 0, 0, 0, r, r * 0.7, 0.08, 8);
        cylinder(a, 0, 0.08, 0, 0.05, 0.045, h - 0.34, 8, false, false);
        // Sloped desk.
        quad(a, [-r, h - 0.26, -r * 0.7], [r, h - 0.26, -r * 0.7], [r, h, r * 0.75], [-r, h, r * 0.75]);
        quad(a, [-r, h - 0.3, -r * 0.7], [-r, h - 0.04, r * 0.75], [r, h - 0.04, r * 0.75], [r, h - 0.3, -r * 0.7]);
        box(a, -r, h - 0.06, r * 0.6, r, h + 0.02, r * 0.78);
      });
      local(out, fr, PAL_LINEN, (a) => {
        const r = Math.min(hw, hd);
        box(a, -r * 0.75, h - 0.14, -r * 0.2, r * 0.75, h - 0.11, r * 0.55);
      });
      break;
    }
    case 'dais': {
      local(out, fr, PAL_STONE, (a) => {
        // Two steps, so the throne/altar end reads as raised, not floated.
        bevelBox(a, -hw, 0, -hd, hw, h * 0.5, hd + 0.35, 0.03);
        bevelBox(a, -hw, 0, -hd, hw, h, hd, 0.03);
      });
      break;
    }
    case 'banner': {
      local(out, fr, PAL_WOOD, (a) => {
        cylinder(a, -hw - 0.06, h - 0.06, 0, 0.028, 0.028, 0.12, 5);
        box(a, -hw - 0.05, h - 0.05, -0.025, hw + 0.05, h + 0.005, 0.025);
      });
      local(out, fr, (v & 1) === 0 ? PAL_FABRIC : PAL_WOOL_BLUE, (a) => {
        const top = h - 0.06, bot = h * 0.28;
        const w = Math.max(hw, 0.26);
        // A hanging cloth with a swallow-tail hem.
        quad(a, [-w, bot + 0.22, 0.012], [w, bot + 0.22, 0.012], [w, top, 0.012], [-w, top, 0.012]);
        quad(a, [w, bot + 0.22, -0.012], [-w, bot + 0.22, -0.012], [-w, top, -0.012], [w, top, -0.012]);
        tri(a, [-w, bot + 0.22, 0.012], [0, bot, 0.012], [w, bot + 0.22, 0.012]);
        tri(a, [w, bot + 0.22, -0.012], [0, bot, -0.012], [-w, bot + 0.22, -0.012]);
        quad(a, [-w, bot + 0.22, -0.012], [-w, bot + 0.22, 0.012], [-w, top, 0.012], [-w, top, -0.012]);
        quad(a, [w, bot + 0.22, 0.012], [w, bot + 0.22, -0.012], [w, top, -0.012], [w, top, 0.012]);
      });
      local(out, fr, PAL_BRASS, (a) => {
        const w = Math.max(hw, 0.26);
        box(a, -w * 0.4, h * 0.62, -0.016, w * 0.4, h * 0.62 + 0.09, 0.016);
      });
      break;
    }
    case 'column': {
      local(out, fr, PAL_STONE, (a) => {
        const r = Math.min(hw, hd);
        bevelBox(a, -r, 0, -r, r, 0.16, r, 0.03);                       // base
        cylinder(a, 0, 0.16, 0, r * 0.82, r * 0.72, h - 0.42, 10, false, false);
        cylinder(a, 0, h - 0.26, 0, r * 0.72, r * 0.98, 0.16, 10, false, false);
        bevelBox(a, -r * 1.05, h - 0.1, -r * 1.05, r * 1.05, h, r * 1.05, 0.03); // capital
      });
      break;
    }

    // ---- fittings -----------------------------------------------------------
    case 'weaponrack': {
      local(out, fr, PAL_WOOD, (a) => {
        for (const lz of [-hd + 0.08, hd - 0.08]) {
          cylinder(a, 0, 0, lz, 0.055, 0.045, h, 6, false, true);
        }
        for (const yy of [h - 0.1, h * 0.34]) box(a, -0.04, yy, -hd, 0.04, yy + 0.07, hd);
      });
      local(out, fr, PAL_IRON, (a) => {
        const n = Math.max(2, Math.round(hd * 3));
        for (let i = 0; i < n; i++) {
          const z = -hd + 0.16 + (i / Math.max(1, n - 1)) * (hd * 2 - 0.32);
          if ((i & 1) === 0) {
            capsule(a, 0.02, h * 0.3, z, -0.02, h + 0.32, z, 0.022, 5);          // spear shaft
            cone(a, -0.02, h + 0.32, z, 0.035, 0.2, 5);
          } else {
            box(a, -0.02, h * 0.3, z - 0.045, 0.02, h + 0.05, z + 0.045);        // sword blade
            box(a, -0.03, h * 0.3 - 0.09, z - 0.1, 0.03, h * 0.3 - 0.03, z + 0.1);
          }
        }
      });
      break;
    }
    case 'toolrack': {
      local(out, fr, PAL_WOOD, (a) => {
        bevelBox(a, -hw, h * 0.2, -hd, hw, h, hd, 0.02);
        for (const yy of [h * 0.45, h * 0.78]) box(a, -hw, yy, hd, hw, yy + 0.05, hd + 0.07);
      });
      local(out, fr, PAL_IRON, (a) => {
        const n = Math.max(3, Math.round(hd * 5));
        for (let i = 0; i < n; i++) {
          const z = -hd + 0.14 + (i / Math.max(1, n - 1)) * (hd * 2 - 0.28);
          const yy = h * (0.52 + 0.28 * ((i * 3) % 2));
          // Hammer head or tong jaws on a haft hanging from the rail.
          if ((i & 1) === 0) {
            box(a, -0.05, yy, z - 0.035, 0.05, yy + 0.09, z + 0.035);
          } else {
            capsule(a, 0, yy, z - 0.03, 0, yy - 0.22, z - 0.06, 0.018, 4);
            capsule(a, 0, yy, z + 0.03, 0, yy - 0.22, z + 0.06, 0.018, 4);
          }
        }
      });
      local(out, fr, PAL_WOOD, (a) => {
        const n = Math.max(3, Math.round(hd * 5));
        for (let i = 0; i < n; i += 2) {
          const z = -hd + 0.14 + (i / Math.max(1, n - 1)) * (hd * 2 - 0.28);
          const yy = h * (0.52 + 0.28 * ((i * 3) % 2));
          cylinder(a, 0, yy - 0.3, z, 0.02, 0.018, 0.3, 5, false, false);
        }
      });
      break;
    }
    case 'ladder': {
      local(out, fr, PAL_WOOD, (a) => {
        for (const lx of [-hw + 0.04, hw - 0.04]) {
          cylinder(a, lx, 0, 0, 0.038, 0.032, h, 6, false, true);
        }
        const rungs = Math.max(3, Math.floor(h / 0.34));
        for (let i = 1; i <= rungs; i++) {
          const y = (i / (rungs + 1)) * h;
          capsule(a, -hw + 0.04, y, 0, hw - 0.04, y, 0, 0.023, 5);
        }
      });
      break;
    }
    case 'candle': {
      local(out, fr, PAL_WAX, (a) => {
        cylinder(a, 0, 0, 0, Math.min(hw, hd), Math.min(hw, hd) * 0.85, h, 6, true, true);
      });
      break;
    }
    case 'rug': {
      const pal = v === 0 ? PAL_FABRIC : v === 1 ? PAL_WOOL_BLUE : PAL_WOOL_GREEN;
      local(out, fr, pal, (a) => {
        bevelBox(a, -hw, 0, -hd, hw, h, hd, 0.05);
      });
      // A woven border in a second colour: the whole point of a rug.
      local(out, fr, v === 0 ? PAL_LINEN : PAL_FABRIC, (a) => {
        const b = Math.min(0.13, hw * 0.3, hd * 0.3);
        box(a, -hw + b, h - 0.001, -hd + b * 0.6, hw - b, h + 0.004, -hd + b);
        box(a, -hw + b, h - 0.001, hd - b, hw - b, h + 0.004, hd - b * 0.6);
      });
      break;
    }
    default:
      break;
  }
}

// =========================================================================
//  Decor templates
// =========================================================================
//
// Every template is built at the origin, sitting on y=0 (or hanging from y=0
// downward for ceiling props), facing +Z, at scale 1. Small segment counts:
// there are a lot of these and none of them is ever more than a metre away
// from something more interesting.

function tplMug(): Tpl {
  return tpl('mug', (b) => {
    const w = b.p(PAL_CLAY);
    cylinder(w, 0, 0, 0, 0.043, 0.048, 0.115, 7, true, false);
    cylinder(w, 0, 0.105, 0, 0.048, 0.048, 0.012, 7, false, true);
    // Handle: two short bars out the +X side.
    box(w, 0.046, 0.03, -0.012, 0.078, 0.045, 0.012);
    box(w, 0.046, 0.08, -0.012, 0.078, 0.095, 0.012);
    box(w, 0.066, 0.03, -0.012, 0.078, 0.095, 0.012);
    const f = b.p(PAL_STRAW);
    cylinder(f, 0, 0.1, 0, 0.041, 0.041, 0.008, 7);
  });
}

function tplBowl(): Tpl {
  return tpl('bowl', (b) => {
    const w = b.p(PAL_CLAY);
    cylinder(w, 0, 0, 0, 0.035, 0.075, 0.055, 9, true, false);
    cylinder(w, 0, 0.055, 0, 0.075, 0.072, 0.012, 9, false, false);
    const s = b.p(PAL_STRAW);
    cylinder(s, 0, 0.042, 0, 0.062, 0.062, 0.012, 9);
  });
}

function tplPlate(): Tpl {
  return tpl('plate', (b) => {
    const w = b.p(PAL_LINEN);
    cylinder(w, 0, 0, 0, 0.06, 0.088, 0.022, 10);
    const f = b.p(PAL_FABRIC);
    sphere(f, 0.015, 0.026, 0.01, 0.028, 6, 4, 0.55, 1);
    sphere(f, -0.02, 0.026, -0.012, 0.022, 6, 4, 0.55, 1);
  });
}

function tplBottle(): Tpl {
  return tpl('bottle', (b) => {
    const g = b.p(PAL_GREEN);
    cylinder(g, 0, 0, 0, 0.037, 0.04, 0.11, 7, true, false);
    cylinder(g, 0, 0.11, 0, 0.04, 0.018, 0.05, 7, false, false);
    cylinder(g, 0, 0.16, 0, 0.018, 0.02, 0.07, 7, false, false);
    const c = b.p(PAL_WAX);
    cylinder(c, 0, 0.228, 0, 0.022, 0.021, 0.022, 7);
  });
}

function tplJug(): Tpl {
  return tpl('jug', (b) => {
    const c = b.p(PAL_CLAY);
    sphere(c, 0, 0.075, 0, 0.075, 9, 5, 1.05, 1);
    cylinder(c, 0, 0.13, 0, 0.042, 0.036, 0.075, 7, false, false);
    cylinder(c, 0, 0.205, 0, 0.036, 0.044, 0.016, 7, false, true);
    capsule(c, 0.058, 0.185, 0, 0.098, 0.1, 0, 0.013, 5);
    capsule(c, 0.098, 0.1, 0, 0.06, 0.048, 0, 0.013, 5);
  });
}

function tplLoaf(): Tpl {
  return tpl('loaf', (b) => {
    const s = b.p(PAL_STRAW);
    sphere(s, 0, 0.055, 0, 0.1, 9, 5, 0.55, 0.72);
    // Slashes across the crust.
    for (const z of [-0.03, 0.01, 0.05]) {
      box(s, -0.05, 0.092, z - 0.005, 0.05, 0.104, z + 0.005);
    }
  });
}

function tplCheese(): Tpl {
  return tpl('cheese', (b) => {
    const w = b.p(PAL_WAX);
    // A cut wheel: a wedge missing.
    cylinder(w, 0, 0, 0, 0.085, 0.085, 0.07, 8);
    const l = b.p(PAL_LINEN);
    tri(l, [0, 0.071, 0], [0.075, 0.071, -0.04], [0.075, 0.071, 0.04]);
  });
}

function tplCandlestick(rich: boolean): Tpl {
  return tpl(rich ? 'candlestick1' : 'candlestick0', (b) => {
    const m = b.p(rich ? PAL_BRASS : PAL_IRON);
    cylinder(m, 0, 0, 0, 0.055, 0.038, 0.022, 8);
    cylinder(m, 0, 0.022, 0, 0.014, 0.012, rich ? 0.16 : 0.05, 7, false, false);
    if (rich) {
      sphere(m, 0, 0.1, 0, 0.028, 7, 4);
      cylinder(m, 0, 0.182, 0, 0.03, 0.024, 0.018, 8);
    }
    const base = rich ? 0.2 : 0.072;
    const w = b.p(PAL_WAX);
    cylinder(w, 0, base, 0, 0.019, 0.017, 0.12, 7, false, true);
    // Wax run down one side.
    capsule(w, 0.016, base + 0.11, 0, 0.018, base + 0.05, 0, 0.006, 4);
    const f = b.p(PAL_EMBER);
    cylinder(f, 0, base + 0.12, 0, 0.008, 0.002, 0.03, 5, false, false);
  });
}

function tplBook(): Tpl {
  return tpl('book', (b) => {
    const c = b.p(PAL_LEATHER);
    bevelBox(c, -0.085, 0, -0.06, 0.085, 0.045, 0.06, 0.012);
    const p = b.p(PAL_LINEN);
    bevelBox(p, -0.078, 0.006, -0.053, 0.078, 0.04, 0.053, 0.008);
    const m = b.p(PAL_BRASS);
    box(m, -0.09, 0.012, -0.012, -0.072, 0.034, 0.012);
  });
}

function tplScroll(): Tpl {
  return tpl('scroll', (b) => {
    const l = b.p(PAL_LINEN);
    capsule(l, -0.09, 0.025, 0, 0.09, 0.025, 0, 0.024, 7);
    const r = b.p(PAL_FABRIC);
    box(r, -0.008, 0.005, -0.028, 0.008, 0.048, 0.028);
  });
}

function tplLedger(): Tpl {
  return tpl('ledger', (b) => {
    const p = b.p(PAL_LINEN);
    bevelBox(p, -0.1, 0, -0.075, 0.1, 0.018, 0.075, 0.01);
    const q = b.p(PAL_WOOD);
    capsule(q, 0.04, 0.02, -0.03, 0.12, 0.11, -0.09, 0.007, 5);
    const i = b.p(PAL_IRON);
    cylinder(i, -0.12, 0, 0.02, 0.026, 0.022, 0.05, 7);
  });
}

function tplSack(): Tpl {
  return tpl('sack', (b) => {
    const l = b.p(PAL_LINEN);
    // A full sack slumps: a fat belly, a pinched neck and a tied ear. The old
    // straight taper read as a traffic cone.
    sphere(l, 0, 0.19, 0, 0.185, 9, 5, 1.05, 0.92);
    taperedCapsule(l, 0, 0.28, 0, 0.01, 0.42, 0.01, 0.115, 0.05, 8);
    sphere(l, 0.02, 0.46, 0.02, 0.05, 7, 4);
    const c = b.p(PAL_LEATHER);
    cylinder(c, 0, 0.35, 0, 0.075, 0.07, 0.03, 9);
  });
}

function tplBasket(): Tpl {
  return tpl('basket', (b) => {
    const s = b.p(PAL_STRAW);
    cylinder(s, 0, 0, 0, 0.1, 0.145, 0.2, 10, true, false);
    cylinder(s, 0, 0.2, 0, 0.148, 0.145, 0.025, 10, false, false);
    // Woven bands.
    for (const y of [0.05, 0.115, 0.175]) {
      const r = 0.1 + (0.045 * y / 0.2);
      cylinder(s, 0, y, 0, r + 0.008, r + 0.008, 0.016, 10, false, false);
    }
    capsule(s, -0.13, 0.21, 0, 0.13, 0.21, 0, 0.011, 5);
  });
}

function tplCrock(): Tpl {
  return tpl('crock', (b) => {
    const c = b.p(PAL_CLAY);
    sphere(c, 0, 0.13, 0, 0.13, 10, 5, 1.0, 1);
    cylinder(c, 0, 0.2, 0, 0.075, 0.088, 0.055, 9, false, true);
    const l = b.p(PAL_LINEN);
    cylinder(l, 0, 0.252, 0, 0.094, 0.088, 0.012, 9);
  });
}

function tplBucket(): Tpl {
  return tpl('bucket', (b) => {
    const w = b.p(PAL_PALE_WOOD);
    cylinder(w, 0, 0, 0, 0.085, 0.11, 0.21, 10, true, false);
    const i = b.p(PAL_IRON);
    for (const y of [0.03, 0.175]) {
      const r = 0.085 + 0.025 * (y / 0.21);
      cylinder(i, 0, y, 0, r + 0.007, r + 0.007, 0.02, 10, false, false);
    }
    capsule(i, -0.11, 0.2, 0, 0, 0.3, 0, 0.009, 5);
    capsule(i, 0, 0.3, 0, 0.11, 0.2, 0, 0.009, 5);
  });
}

function tplFirewood(): Tpl {
  return tpl('firewood', (b) => {
    const w = b.p(PAL_WOOD);
    const rows: [number, number, number][] = [
      [-0.16, 0.06, 0], [0, 0.06, 0.02], [0.16, 0.06, -0.02],
      [-0.08, 0.17, 0.01], [0.08, 0.17, -0.01], [0, 0.28, 0],
    ];
    for (let i = 0; i < rows.length; i++) {
      const [x, y, z] = rows[i];
      const len = 0.2 + (i % 3) * 0.03;
      capsule(w, x, y, z - len, x, y, z + len, 0.058, 6);
    }
  });
}

function tplStraw(): Tpl {
  return tpl('straw', (b) => {
    const s = b.p(PAL_STRAW);
    // A trodden scatter of rushes: flat, wide and cheap. Each blade is three
    // segments so the tuft has a footprint rather than a single spike.
    for (let i = 0; i < 14; i++) {
      const a = i * 1.77;
      const l = 0.16 + (i % 4) * 0.07;
      const x = Math.cos(a) * 0.05, z = Math.sin(a) * 0.05;
      const bend = a + 0.5 + (i % 3) * 0.4;
      capsule(s, x, 0.006, z, x + Math.cos(bend) * l, 0.016 + (i % 3) * 0.01,
        z + Math.sin(bend) * l, 0.014, 3);
    }
  });
}

function tplBoots(): Tpl {
  return tpl('boots', (b) => {
    const l = b.p(PAL_LEATHER);
    for (const x of [-0.06, 0.06]) {
      taperedCapsule(l, x, 0.05, -0.03, x + 0.012, 0.05, 0.1, 0.05, 0.042, 7);
      taperedCapsule(l, x, 0.05, -0.03, x - 0.01, 0.24, -0.05, 0.052, 0.045, 7);
    }
    const s = b.p(PAL_SOOT);
    for (const x of [-0.06, 0.06]) {
      box(s, x - 0.05, 0, -0.09, x + 0.05, 0.018, 0.14);
    }
  });
}

function tplBroom(): Tpl {
  return tpl('broom', (b) => {
    const w = b.p(PAL_WOOD);
    capsule(w, 0, 0.06, 0, -0.14, 1.25, -0.06, 0.019, 6);
    const s = b.p(PAL_STRAW);
    taperedCapsule(s, 0, 0.3, 0.02, 0, 0.0, 0.05, 0.045, 0.1, 8);
    const c = b.p(PAL_LEATHER);
    capsule(c, 0, 0.27, 0.02, 0, 0.23, 0.025, 0.05, 6);
  });
}

function tplBedroll(): Tpl {
  return tpl('bedroll', (b) => {
    const f = b.p(PAL_WOOL_GREEN);
    taperedCapsule(f, -0.42, 0.09, 0, 0.42, 0.09, 0, 0.1, 0.1, 8);
    const l = b.p(PAL_LEATHER);
    for (const x of [-0.2, 0.2]) box(l, x - 0.018, 0.0, -0.105, x + 0.018, 0.2, 0.105);
  });
}

function tplCoalpile(): Tpl {
  return tpl('coalpile', (b) => {
    const s = b.p(PAL_SOOT);
    for (let i = 0; i < 9; i++) {
      const a = i * 2.399;
      const r = 0.05 + (i / 9) * 0.16;
      sphere(s, Math.cos(a) * r, 0.05 + (i % 3) * 0.035, Math.sin(a) * r,
        0.055 + (i % 4) * 0.014, 6, 4, 0.72, 1);
    }
  });
}

function tplIngots(): Tpl {
  return tpl('ingots', (b) => {
    const i = b.p(PAL_IRON);
    for (let k = 0; k < 5; k++) {
      const row = k < 3 ? 0 : 1;
      const idx = k < 3 ? k : k - 3;
      const y = row * 0.055;
      const x = (idx - (row === 0 ? 1 : 0.5)) * 0.1;
      bevelBox(i, x - 0.045, y, -0.12 + row * 0.02, x + 0.045, y + 0.05, 0.12 - row * 0.02, 0.012);
    }
  });
}

function tplHorseshoes(): Tpl {
  return tpl('horseshoes', (b) => {
    const i = b.p(PAL_IRON);
    for (let k = 0; k < 3; k++) {
      const y = 0.012 + k * 0.026;
      const tilt = k * 0.35;
      for (let s = 0; s < 7; s++) {
        const a = -1.9 + (s / 6) * 3.8 + tilt;
        const a2 = -1.9 + ((s + 1) / 6) * 3.8 + tilt;
        capsule(i, Math.cos(a) * 0.075, y, Math.sin(a) * 0.075,
          Math.cos(a2) * 0.075, y, Math.sin(a2) * 0.075, 0.015, 4);
      }
    }
  });
}

function tplWheel(): Tpl {
  return tpl('wheel', (b) => {
    const w = b.p(PAL_WOOD);
    const R = 0.42;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const a2 = ((i + 1) / 12) * Math.PI * 2;
      capsule(w, Math.cos(a) * R, R + Math.sin(a) * R, 0,
        Math.cos(a2) * R, R + Math.sin(a2) * R, 0, 0.042, 5);
    }
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      capsule(w, 0, R, 0, Math.cos(a) * R * 0.92, R + Math.sin(a) * R * 0.92, 0, 0.024, 5);
    }
    cylinder(w, 0, R, -0.07, 0.075, 0.075, 0.14, 8);
    const i = b.p(PAL_IRON);
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      box(i, Math.cos(a) * R - 0.02, R + Math.sin(a) * R - 0.02, -0.055,
        Math.cos(a) * R + 0.02, R + Math.sin(a) * R + 0.02, 0.055);
    }
  });
}

function tplPitchfork(): Tpl {
  return tpl('pitchfork', (b) => {
    const w = b.p(PAL_WOOD);
    capsule(w, 0, 0.05, 0, -0.2, 1.5, -0.1, 0.021, 6);
    const i = b.p(PAL_IRON);
    for (const dx of [-0.055, 0, 0.055]) {
      capsule(i, -0.19 + dx * 0.3, 1.45, -0.1, -0.22 + dx, 1.78, -0.11, 0.013, 4);
    }
  });
}

function tplStump(): Tpl {
  return tpl('stump', (b) => {
    const w = b.p(PAL_WOOD);
    cylinder(w, 0, 0, 0, 0.24, 0.22, 0.36, 10);
    const i = b.p(PAL_IRON);
    // An axe left buried in the top.
    box(i, -0.02, 0.36, -0.09, 0.02, 0.4, 0.09);
    box(i, -0.06, 0.4, -0.11, 0.06, 0.54, 0.11);
    const h = b.p(PAL_PALE_WOOD);
    capsule(h, 0, 0.4, 0, 0.28, 0.72, 0.02, 0.018, 5);
  });
}

function tplProduce(): Tpl {
  return tpl('produce', (b) => {
    const g = b.p(PAL_GREEN);
    const r = b.p(PAL_FABRIC);
    for (let i = 0; i < 8; i++) {
      const a = i * 2.399;
      const rr = (i / 8) * 0.13;
      const arr = (i & 1) === 0 ? g : r;
      sphere(arr, Math.cos(a) * rr, 0.045 + (i % 3) * 0.035, Math.sin(a) * rr, 0.05, 7, 4);
    }
  });
}

function tplCloak(): Tpl {
  // Hanging on a wall peg at y=0, draping downward.
  return tpl('cloak', (b) => {
    const w = b.p(PAL_WOOD);
    capsule(w, 0, 0, -0.02, 0, 0, 0.09, 0.022, 5);
    const f = b.p(PAL_WOOL_GREEN);
    taperedCapsule(f, 0, -0.05, 0.06, 0.02, -0.78, 0.11, 0.09, 0.2, 8);
    sphere(f, 0, -0.05, 0.07, 0.11, 8, 4, 0.7, 0.6);
    const l = b.p(PAL_LEATHER);
    capsule(l, -0.11, -0.09, 0.07, 0.11, -0.09, 0.07, 0.016, 5);
  });
}

function tplShield(): Tpl {
  // Wall-mounted; the wall plane is z=0 and the boss faces +Z.
  return tpl('shield', (b) => {
    const w = b.p(PAL_PALE_WOOD);
    cylinder(w, 0, 0, 0.02, 0.28, 0.28, 0.05, 12, true, true);
    const p = b.p(PAL_FABRIC);
    cylinder(p, 0, 0, 0.07, 0.23, 0.2, 0.02, 12);
    const i = b.p(PAL_IRON);
    sphere(i, 0, 0, 0.08, 0.07, 8, 5, 1, 0.6);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      sphere(i, Math.cos(a) * 0.26, Math.sin(a) * 0.26, 0.07, 0.022, 5, 3);
    }
  });
}

function tplPelt(): Tpl {
  return tpl('pelt', (b) => {
    const l = b.p(PAL_LEATHER);
    // A stretched hide: a rounded quadrilateral with four leg stubs.
    sphere(l, 0, -0.34, 0.03, 0.34, 10, 5, 1.15, 0.1);
    for (const [x, y] of [[-0.3, -0.14], [0.3, -0.14], [-0.26, -0.56], [0.26, -0.56]] as [number, number][]) {
      taperedCapsule(l, x * 0.7, y, 0.03, x * 1.25, y - 0.1, 0.03, 0.07, 0.03, 6);
    }
    const s = b.p(PAL_SOOT);
    sphere(s, 0, -0.06, 0.04, 0.11, 8, 4, 0.9, 0.12);
  });
}

function tplIcon(): Tpl {
  return tpl('icon', (b) => {
    const g = b.p(PAL_BRASS);
    box(g, -0.06, -0.52, 0, 0.06, 0.32, 0.05);
    box(g, -0.3, 0.02, 0, 0.3, 0.14, 0.05);
    sphere(g, 0, 0.36, 0.025, 0.075, 8, 5, 1, 0.6);
    const w = b.p(PAL_FURNITURE_WOOD);
    box(w, -0.34, -0.6, -0.03, 0.34, 0.44, 0.0);
  });
}

function tplAntlers(): Tpl {
  return tpl('antlers', (b) => {
    const h = b.p(PAL_LINEN);
    for (const s of [-1, 1]) {
      capsule(h, s * 0.05, 0, 0.06, s * 0.26, 0.3, 0.02, 0.028, 5);
      capsule(h, s * 0.26, 0.3, 0.02, s * 0.34, 0.56, 0.02, 0.02, 5);
      capsule(h, s * 0.19, 0.2, 0.03, s * 0.42, 0.3, 0.0, 0.016, 4);
      capsule(h, s * 0.29, 0.4, 0.02, s * 0.52, 0.46, 0.0, 0.014, 4);
    }
    const w = b.p(PAL_FURNITURE_WOOD);
    box(w, -0.11, -0.14, 0.02, 0.11, 0.06, 0.07);
  });
}

function tplHerbs(): Tpl {
  // Hangs from y=0 downward.
  return tpl('herbs', (b) => {
    const c = b.p(PAL_LEATHER);
    box(c, -0.014, -0.13, -0.014, 0.014, 0, 0.014);
    const g = b.p(PAL_GREEN);
    for (let i = 0; i < 11; i++) {
      const a = i * 1.9;
      const r = 0.02 + (i % 4) * 0.014;
      taperedCapsule(g, Math.cos(a) * 0.012, -0.13, Math.sin(a) * 0.012,
        Math.cos(a) * r, -0.36 - (i % 5) * 0.055, Math.sin(a) * r, 0.021, 0.006, 4);
    }
  });
}

function tplSausages(): Tpl {
  return tpl('sausages', (b) => {
    const l = b.p(PAL_FABRIC);
    for (let i = 0; i < 6; i++) {
      const x = -0.3 + (i / 5) * 0.6;
      const droop = 0.06 * Math.sin((i / 5) * Math.PI);
      taperedCapsule(l, x, -0.1 - droop, -0.03, x + 0.03, -0.34 - droop, 0.03, 0.035, 0.032, 6);
    }
    const c = b.p(PAL_LEATHER);
    for (let i = 0; i < 5; i++) {
      const x0 = -0.3 + (i / 5) * 0.6, x1 = -0.3 + ((i + 1) / 5) * 0.6;
      const d0 = 0.06 * Math.sin((i / 5) * Math.PI), d1 = 0.06 * Math.sin(((i + 1) / 5) * Math.PI);
      capsule(c, x0, -0.09 - d0, 0, x1, -0.09 - d1, 0, 0.008, 4);
    }
  });
}

function tplLantern(): Tpl {
  return tpl('lantern', (b) => {
    const i = b.p(PAL_IRON);
    capsule(i, 0, 0, 0, 0, -0.28, 0, 0.008, 4);
    cylinder(i, 0, -0.36, 0, 0.075, 0.085, 0.04, 6, true, false);
    cylinder(i, 0, -0.12, 0, 0.085, 0.055, 0.05, 6, false, true);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.78;
      box(i, Math.cos(a) * 0.07 - 0.012, -0.36, Math.sin(a) * 0.07 - 0.012,
        Math.cos(a) * 0.07 + 0.012, -0.12, Math.sin(a) * 0.07 + 0.012);
    }
    const f = b.p(PAL_EMBER);
    cylinder(f, 0, -0.31, 0, 0.045, 0.03, 0.13, 6);
  });
}

function tplChandelier(rich: boolean): Tpl {
  return tpl(rich ? 'chandelier1' : 'chandelier0', (b) => {
    const i = b.p(rich ? PAL_BRASS : PAL_IRON);
    capsule(i, 0, 0, 0, 0, -0.42, 0, 0.009, 4);
    const R = rich ? 0.46 : 0.36;
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      const a2 = ((k + 1) / 10) * Math.PI * 2;
      capsule(i, Math.cos(a) * R, -0.5, Math.sin(a) * R,
        Math.cos(a2) * R, -0.5, Math.sin(a2) * R, 0.022, 4);
    }
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      capsule(i, 0, -0.42, 0, Math.cos(a) * R, -0.5, Math.sin(a) * R, 0.008, 4);
    }
    const w = b.p(PAL_WAX);
    const f = b.p(PAL_EMBER);
    const n = rich ? 8 : 6;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + 0.2;
      const x = Math.cos(a) * R, z = Math.sin(a) * R;
      cylinder(w, x, -0.48, z, 0.021, 0.018, 0.16 + (k % 3) * 0.03, 6, false, true);
      cylinder(f, x, -0.32 + (k % 3) * 0.03, z, 0.008, 0.002, 0.028, 5, false, false);
    }
  });
}

function tplCenser(): Tpl {
  return tpl('censer', (b) => {
    const g = b.p(PAL_BRASS);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      capsule(g, 0, 0, 0, Math.cos(a) * 0.09, -0.5, Math.sin(a) * 0.09, 0.006, 4);
    }
    sphere(g, 0, -0.58, 0, 0.1, 9, 5, 0.9, 1);
    cylinder(g, 0, -0.52, 0, 0.075, 0.055, 0.06, 8, false, true);
    sphere(g, 0, -0.44, 0, 0.026, 6, 4);
    const f = b.p(PAL_EMBER);
    sphere(f, 0, -0.56, 0, 0.045, 6, 4);
  });
}

function tplHangpot(): Tpl {
  return tpl('hangpot', (b) => {
    const i = b.p(PAL_IRON);
    capsule(i, 0, 0, 0, 0, -0.34, 0, 0.009, 4);
    capsule(i, -0.11, -0.34, 0, 0.11, -0.34, 0, 0.008, 4);
    sphere(i, 0, -0.52, 0, 0.16, 10, 5, 0.85, 1);
    cylinder(i, 0, -0.41, 0, 0.115, 0.125, 0.05, 10, false, false);
    capsule(i, -0.12, -0.42, 0, 0, -0.33, 0, 0.008, 4);
    capsule(i, 0, -0.33, 0, 0.12, -0.42, 0, 0.008, 4);
  });
}

function tplWindowGlow(): Tpl {
  // Only the pane; the recess and frame are parametric (they need the span).
  return tpl('windowglow', (b) => {
    const g = b.p(PAL_WINDOW);
    box(g, -0.5, -0.5, -0.01, 0.5, 0.5, 0.01);
  });
}

const DECOR_TPL: Record<string, () => Tpl> = {
  mug: tplMug, bowl: tplBowl, plate: tplPlate, bottle: tplBottle, jug: tplJug,
  loaf: tplLoaf, cheese: tplCheese, book: tplBook, scroll: tplScroll,
  ledger: tplLedger, sack: tplSack, basket: tplBasket, crock: tplCrock,
  bucket: tplBucket, firewood: tplFirewood, straw: tplStraw, boots: tplBoots,
  broom: tplBroom, bedroll: tplBedroll, coalpile: tplCoalpile, ingots: tplIngots,
  horseshoes: tplHorseshoes, wheel: tplWheel, pitchfork: tplPitchfork,
  stump: tplStump, produce: tplProduce, cloak: tplCloak, shield: tplShield,
  pelt: tplPelt, icon: tplIcon, antlers: tplAntlers, herbs: tplHerbs,
  sausages: tplSausages, lantern: tplLantern, censer: tplCenser,
  hangpot: tplHangpot,
};

// ---- parametric decor (needs a span, so no template) -----------------------

function buildSpanDecor(out: MeshOut, d: Decor): void {
  const { x, y, z, yaw, scale: s, len, variant: v } = d;
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  // Local -> world helper for spans laid out along local X.
  const P = (lx: number, ly: number, lz: number): P3 =>
    [x + lx * c - lz * sn, y + ly, z + lx * sn + lz * c];

  switch (d.type) {
    case 'beam': {
      const h = len / 2;
      out.emit(PAL_WOOD, (a) => {
        // Hand-hewn: a squared timber, pegged where it lands on the wall.
        const t = 0.09;
        boxBetween(a, P(-h, 0, 0), P(h, 0, 0), t, t);
        for (const e of [-h + 0.12, h - 0.12]) {
          const q = P(e, t * 0.2, 0);
          sphere(a, q[0], q[1], q[2], 0.028, 6, 4);
        }
      });
      break;
    }
    case 'rafter': {
      // A pair of principal rafters meeting above, with a collar tie.
      const h = len / 2;
      const rise = 0.9 * s;
      out.emit(PAL_WOOD, (a) => {
        boxBetween(a, P(-h, 0, 0), P(0, rise, 0), 0.07, 0.07);
        boxBetween(a, P(h, 0, 0), P(0, rise, 0), 0.07, 0.07);
        boxBetween(a, P(-h * 0.42, rise * 0.55, 0), P(h * 0.42, rise * 0.55, 0), 0.05, 0.05);
      });
      break;
    }
    case 'post': {
      out.emit(PAL_WOOD, (a) => {
        cylinder(a, x, y, z, 0.11, 0.095, len, 8, false, false);
        // Bracket knees to the beam above.
        const top = y + len;
        boxBetween(a, [x, top - 0.45, z], [x + 0.34 * c, top, z + 0.34 * sn], 0.05, 0.05);
        boxBetween(a, [x, top - 0.45, z], [x - 0.34 * c, top, z - 0.34 * sn], 0.05, 0.05);
      });
      break;
    }
    case 'loft': {
      // Platform: `len` along local X, `scale` along local Z, top at y.
      const hx = len / 2, hz = s / 2;
      out.emit(PAL_PALE_WOOD, (a) => {
        const planks = Math.max(3, Math.round(s * 1.6));
        for (let i = 0; i < planks; i++) {
          const z0 = -hz + (i / planks) * s + 0.012;
          const z1 = -hz + ((i + 1) / planks) * s - 0.012;
          quadPrism(a, P(-hx, 0, z0), P(hx, 0, z0), P(hx, 0, z1), P(-hx, 0, z1), 0.07);
        }
      });
      out.emit(PAL_WOOD, (a) => {
        boxBetween(a, P(-hx, -0.11, -hz + 0.15), P(hx, -0.11, -hz + 0.15), 0.08, 0.08);
        boxBetween(a, P(-hx, -0.11, hz - 0.15), P(hx, -0.11, hz - 0.15), 0.08, 0.08);
        // A rail along the open edge so the loft reads as a place, not a shelf.
        for (let i = 0; i <= 4; i++) {
          const px = -hx + (i / 4) * len;
          boxBetween(a, P(px, 0, hz - 0.1), P(px, 0.75, hz - 0.1), 0.04, 0.04);
        }
        boxBetween(a, P(-hx, 0.75, hz - 0.1), P(hx, 0.75, hz - 0.1), 0.045, 0.045);
      });
      break;
    }
    case 'window': {
      // A splayed reveal in the wall with a bright pane at the back of it.
      const hw = len / 2, hh = 0.55 * s;
      out.emit(PAL_PLASTER, (a) => {
        // Reveal: four splayed faces from the room side back to the pane.
        const inner = 0.16;
        const A = P(-hw, -hh, 0), B = P(hw, -hh, 0), C = P(hw, hh, 0), D = P(-hw, hh, 0);
        const A2 = P(-hw * 0.72, -hh * 0.78, -inner), B2 = P(hw * 0.72, -hh * 0.78, -inner);
        const C2 = P(hw * 0.72, hh * 0.78, -inner), D2 = P(-hw * 0.72, hh * 0.78, -inner);
        quad(a, A, B, B2, A2);
        quad(a, B, C, C2, B2);
        quad(a, C, D, D2, C2);
        quad(a, D, A, A2, D2);
      });
      out.emit(PAL_WINDOW, (a) => {
        const inner = 0.17;
        const A2 = P(-hw * 0.72, -hh * 0.78, -inner), B2 = P(hw * 0.72, -hh * 0.78, -inner);
        const C2 = P(hw * 0.72, hh * 0.78, -inner), D2 = P(-hw * 0.72, hh * 0.78, -inner);
        quad(a, A2, B2, C2, D2);
      });
      out.emit(PAL_WOOD, (a) => {
        // Mullion + transom, and a sill.
        boxBetween(a, P(0, -hh * 0.78, -0.16), P(0, hh * 0.78, -0.16), 0.022, 0.022);
        if (v === 1) {
          boxBetween(a, P(-hw * 0.72, hh * 0.1, -0.16), P(hw * 0.72, hh * 0.1, -0.16), 0.022, 0.022);
          boxBetween(a, P(-hw * 0.72, -hh * 0.34, -0.16), P(hw * 0.72, -hh * 0.34, -0.16), 0.022, 0.022);
        }
        boxBetween(a, P(-hw - 0.05, -hh - 0.02, 0.02), P(hw + 0.05, -hh - 0.02, 0.02), 0.05, 0.08);
      });
      break;
    }
    case 'wallshelf': {
      const hx = len / 2;
      out.emit(PAL_FURNITURE_WOOD, (a) => {
        quadPrism(a, P(-hx, 0, 0), P(hx, 0, 0), P(hx, 0, 0.2), P(-hx, 0, 0.2), 0.045);
        for (const px of [-hx + 0.12, 0, hx - 0.12]) {
          boxBetween(a, P(px, -0.24, 0.02), P(px, 0, 0.17), 0.03, 0.03);
        }
      });
      break;
    }
    case 'stair': {
      const steps = Math.max(3, Math.round(len / 0.28));
      out.emit(PAL_WOOD, (a) => {
        for (let i = 0; i < steps; i++) {
          const t0 = (i / steps) * len;
          const yy = (i / steps) * (s || 2);
          quadPrism(a, P(t0, yy, -0.5), P(t0 + len / steps, yy, -0.5),
            P(t0 + len / steps, yy, 0.5), P(t0, yy, 0.5), 0.07);
        }
      });
      break;
    }
    default: break;
  }
}

/** A squared timber between two world points, half-thickness (t, u). */
function boxBetween(v: number[], a: P3, b: P3, t: number, u: number): void {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-5) return;
  const ax = dx / len, ay = dy / len, az = dz / len;
  // Perpendicular frame.
  let ux = 0, uy = 1, uz = 0;
  if (Math.abs(ay) > 0.92) { ux = 1; uy = 0; uz = 0; }
  let sx = uy * az - uz * ay, sy = uz * ax - ux * az, sz = ux * ay - uy * ax;
  const sl = Math.hypot(sx, sy, sz) || 1;
  sx /= sl; sy /= sl; sz /= sl;
  const tx = ay * sz - az * sy, ty = az * sx - ax * sz, tz = ax * sy - ay * sx;
  const c = (e: 0 | 1, i: number, j: number): P3 => {
    const p = e === 0 ? a : b;
    return [p[0] + sx * t * i + tx * u * j, p[1] + sy * t * i + ty * u * j, p[2] + sz * t * i + tz * u * j];
  };
  quad(v, c(0, -1, -1), c(1, -1, -1), c(1, 1, -1), c(0, 1, -1));
  quad(v, c(1, -1, 1), c(0, -1, 1), c(0, 1, 1), c(1, 1, 1));
  quad(v, c(0, -1, 1), c(1, -1, 1), c(1, -1, -1), c(0, -1, -1));
  quad(v, c(0, 1, -1), c(1, 1, -1), c(1, 1, 1), c(0, 1, 1));
  quad(v, c(0, -1, -1), c(0, 1, -1), c(0, 1, 1), c(0, -1, 1));
  quad(v, c(1, -1, 1), c(1, 1, 1), c(1, 1, -1), c(1, -1, -1));
}

/** A flat quad given thickness downward — planks, treads, shelf boards. */
function quadPrism(v: number[], a: P3, b: P3, c: P3, d: P3, thick: number): void {
  const lower = (p: P3): P3 => [p[0], p[1] - thick, p[2]];
  quad(v, a, b, c, d);
  quad(v, lower(d), lower(c), lower(b), lower(a));
  quad(v, lower(a), lower(b), b, a);
  quad(v, lower(b), lower(c), c, b);
  quad(v, lower(c), lower(d), d, c);
  quad(v, lower(d), lower(a), a, d);
}

// =========================================================================
//  Wall framing
// =========================================================================

/** Which walls get exposed timber, and which get a stone plinth instead. */
const FRAMING: Record<string, 'timber' | 'plinth' | 'none'> = {
  house: 'timber', shop: 'timber', tavern: 'timber', guardhouse: 'timber',
  longhouse: 'timber', barn: 'timber',
  keep: 'plinth', church: 'plinth', smithy: 'plinth',
};

/**
 * Exposed structure on the inside face of every wall.
 *
 * A room whose walls are one flat material reads as a box no matter what is
 * standing in it: the eye has nothing to measure the space against. Studs, a
 * mid rail and a wall plate cost a few thousand vertices in the palette batch
 * that is already being drawn, and they do more for "this is a building" than
 * any single prop.
 *
 * Emitted per wall *face* found in the cell grid, so partitions get framed too
 * and the timbers line up across cell boundaries by construction.
 */
function buildWallFraming(out: MeshOut, interior: BuildingInterior): void {
  const style = FRAMING[interior.spec.kind] ?? 'none';
  if (style === 'none') return;
  const { gridW, gridD, cells, ceilY } = interior;
  const solid = (x: number, z: number): boolean =>
    x < 0 || z < 0 || x >= gridW || z >= gridD || cells[z * gridW + x] === 0;

  const pal = style === 'timber' ? PAL_WOOD : PAL_STONE;
  out.emit(pal, (a) => {
    for (let z = 0; z < gridD; z++) {
      for (let x = 0; x < gridW; x++) {
        if (solid(x, z)) continue;
        const ch = ceilY[z * gridW + x];
        if (ch < 1.6) continue;
        // dir: 0 = -Z wall at z, 1 = +Z at z+1, 2 = -X at x, 3 = +X at x+1.
        for (let dir = 0; dir < 4; dir++) {
          const nx = x + (dir === 2 ? -1 : dir === 3 ? 1 : 0);
          const nz = z + (dir === 0 ? -1 : dir === 1 ? 1 : 0);
          if (!solid(nx, nz)) continue;
          const alongX = dir < 2;
          const wallPos = dir === 0 ? z : dir === 1 ? z + 1 : dir === 2 ? x : x + 1;
          const t = 0.048;          // how far the timber stands proud
          const w = 0.07;           // half-width of a stud
          const inward = (dir === 0 || dir === 2) ? 1 : -1;
          const p0 = wallPos + (inward > 0 ? 0 : 0);
          const face = p0;
          const near = face + inward * t;
          // Span of this wall face along its own axis.
          const s0 = alongX ? x : z;
          const s1 = s0 + 1;

          if (style === 'plinth') {
            // A moulded base course: the stone equivalent, and it grounds a
            // tall room the way a skirting board grounds a wall.
            if (alongX) {
              bevelBox(a, s0, 0, Math.min(face, near), s1, 0.34, Math.max(face, near), 0.02);
              bevelBox(a, s0, 0.34, Math.min(face, near + inward * 0.02),
                s1, 0.42, Math.max(face, near + inward * 0.02), 0.02);
            } else {
              bevelBox(a, Math.min(face, near), 0, s0, Math.max(face, near), 0.34, s1, 0.02);
              bevelBox(a, Math.min(face, near + inward * 0.02), 0.34,
                s0, Math.max(face, near + inward * 0.02), 0.42, s1, 0.02);
            }
            continue;
          }

          // Timber: wall plate under the ceiling, mid rail, and a stud on the
          // cell boundary so the studs land on a regular 1 m pitch.
          const plateY = ch - 0.18;
          const railY = Math.min(1.02, ch * 0.42);
          const bar = (y0: number, y1: number, a0: number, a1: number) => {
            if (alongX) {
              bevelBox(a, a0, y0, Math.min(face, near), a1, y1, Math.max(face, near), 0.02);
            } else {
              bevelBox(a, Math.min(face, near), y0, a0, Math.max(face, near), y1, a1, 0.02);
            }
          };
          bar(plateY, plateY + 0.16, s0, s1);
          bar(railY, railY + 0.1, s0, s1);
          // Stud at the low end of the cell, plus a brace on alternate cells.
          bar(0, plateY, s0, s0 + w * 2);
          if (((x + z) & 1) === 0) bar(0, railY + 0.1, s0 + 0.5 - w, s0 + 0.5 + w);
        }
      }
    }
  });
}

// =========================================================================
//  Public builders
// =========================================================================

/**
 * All interior prop geometry — furniture *and* decor — batched by palette.
 * One draw per palette used, which is why an interior can hold two hundred
 * props for the price of a dozen draws.
 */
export function buildFurnitureMeshes(interior: BuildingInterior): Map<number, Float32Array<ArrayBuffer>> {
  const out = new MeshOut();
  buildWallFraming(out, interior);
  for (const f of interior.furniture) buildFurniturePiece(out, f);
  for (const d of interior.decor ?? []) {
    const make = DECOR_TPL[d.type];
    if (make !== undefined) {
      stampTpl(out, make(), d.x, d.y, d.z, d.yaw, d.scale);
    } else if (d.type === 'candlestick') {
      stampTpl(out, tplCandlestick(d.variant === 1), d.x, d.y, d.z, d.yaw, d.scale);
    } else if (d.type === 'chandelier') {
      stampTpl(out, tplChandelier(d.variant === 1), d.x, d.y, d.z, d.yaw, d.scale);
    } else {
      buildSpanDecor(out, d);
    }
  }
  return out.finish();
}

/** Backwards-compatible alias: decor is included in the furniture batches. */
export const buildInteriorProps = buildFurnitureMeshes;

// ---- light fixture props --------------------------------------------------

export interface BuildingLightProps {
  /** Handle geometry (palette 1, wood — same as dungeon torches). */
  wood: Float32Array<ArrayBuffer>;
  /** Flame/glow geometry (palette 2, emissive — same as dungeon). */
  flame: Float32Array<ArrayBuffer>;
  /** Point-light positions (local), for the lights uniform buffer. */
  lights: [number, number, number][];
}

/**
 * Light-fixture geometry. The visible flame is an additive billboard emitted
 * per frame by render/fire-fx.ts at the position pushed into `lights`; what is
 * emitted here is only the wick, ember bed or coal that anchors it.
 *
 * Exactly one entry is pushed to `lights` per `interior.lights` element, in
 * order — the integration relies on that index alignment for colour/radius.
 */
export function buildLightProps(interior: BuildingInterior): BuildingLightProps {
  const wood: number[] = [];
  const flame: number[] = [];
  const lights: [number, number, number][] = [];

  const findAt = (x: number, z: number, types: readonly string[]): Furniture | undefined =>
    interior.furniture.find((f) => types.includes(f.type) &&
      x >= f.aabb.minX - 0.35 && x <= f.aabb.maxX + 0.35 &&
      z >= f.aabb.minZ - 0.35 && z <= f.aabb.maxZ + 0.35);

  for (const light of interior.lights) {
    const { x, y, z } = light;
    switch (light.kind) {
      case 'hearth': {
        // Crossed logs on an ember bed inside the firebox.
        const h = findAt(x, z, ['hearth', 'firetrench']);
        const floorY = h ? h.aabb.minY + 0.1 : y - 0.35;
        capsule(wood, x - 0.32, floorY + 0.06, z - 0.05, x + 0.32, floorY + 0.06, z - 0.05, 0.058, 6);
        capsule(wood, x - 0.06, floorY + 0.15, z - 0.22, x - 0.06, floorY + 0.15, z + 0.18, 0.058, 6);
        capsule(wood, x + 0.18, floorY + 0.2, z - 0.16, x - 0.2, floorY + 0.2, z + 0.14, 0.05, 6);
        box(flame, x - 0.22, floorY - 0.01, z - 0.12, x + 0.22, floorY + 0.04, z + 0.1);
        lights.push([x, floorY + 0.12, z]);
        break;
      }
      case 'forge': {
        // A bed of coals in the firebox: the brightest thing in the game.
        const f = findAt(x, z, ['forge']);
        const topY = f ? f.aabb.maxY * 0.72 + 0.05 : y - 0.2;
        for (let i = 0; i < 5; i++) {
          const a = i * 2.399;
          const r = (i / 5) * 0.26;
          sphere(flame, x + Math.cos(a) * r, topY + 0.02, z + Math.sin(a) * r, 0.075, 6, 4, 0.6, 1);
        }
        lights.push([x, topY + 0.16, z]);
        break;
      }
      case 'brazier': {
        const b = findAt(x, z, ['brazier']);
        const topY = b ? b.aabb.maxY : y;
        for (let i = 0; i < 4; i++) {
          const a = i * 1.9;
          sphere(flame, x + Math.cos(a) * 0.08, topY - 0.03, z + Math.sin(a) * 0.08, 0.06, 6, 4, 0.6, 1);
        }
        lights.push([x, topY + 0.03, z]);
        break;
      }
      case 'candle':
      case 'lantern': {
        // The fixture is decor — a candlestick on a table, a lantern on a
        // hook — and already carries its own emissive wick. All this light
        // contributes is the billboard flame and the point light.
        lights.push([x, y, z]);
        break;
      }
      case 'daylight': {
        // A window is not a fixture: no geometry, no billboard, just fill.
        lights.push([x, y, z]);
        break;
      }
      default: {
        // Wall torch: an iron bracket, a wrapped head, an emissive tip.
        cylinder(wood, x, y - 0.46, z, 0.045, 0.032, 0.46, 6, false, true);
        box(flame, x - 0.035, y, z - 0.035, x + 0.035, y + 0.055, z + 0.035);
        lights.push([x, y + 0.02, z]);
        break;
      }
    }
  }

  return {
    wood: Float32Array.from(wood) as Float32Array<ArrayBuffer>,
    flame: Float32Array.from(flame) as Float32Array<ArrayBuffer>,
    lights,
  };
}

// ---- collider AABBs -------------------------------------------------------

/**
 * Collider AABBs in the same format used by dungeon-collider (min/max
 * triples), for the existing AABB pushout path.
 */
export function getColliderAABBs(interior: BuildingInterior): AABB[] {
  return interior.colliders;
}
