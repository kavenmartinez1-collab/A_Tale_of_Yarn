/**
 * Settlement props — the small stuff.
 *
 * Buildings give a settlement its skyline; props are what make it look
 * *inhabited*. A cart parked by a barn, a woodpile against a wall, washing
 * strung between two poles, a crop plot with a scarecrow in it and a
 * churchyard of leaning headstones do more for the read of a place than
 * another building would, and they cost a few hundred vertices each instead
 * of a couple of thousand.
 *
 * All builders are pad-local (origin at the pad centre, ground plane at y=0,
 * local -Z is the "front"), take the pad's w/d/h as their extents, and use
 * the pad's deterministic variant `v` for the differences that stop a row of
 * six of anything looking like a copy-paste.
 */

import { cone, cylinder } from '../mesh-utils';
import {
  PAL_BERRY, PAL_LEAF, PAL_PLASTER, PAL_STONE, PAL_THATCH, PAL_TIMBER,
  PAL_TORCH, PAL_WOOD, PAL_WOOL,
  type Buckets, type PaletteIndex, type SettlementFlame,
} from './settlement-palette';
import { beam, boxN, wheelX } from './settlement-shapes';

/** A hand cart: two wheels, a plank bed, shafts, and a load by variant. */
export function buildCart(b: Buckets, w: number, d: number, h: number, v: number): void {
  const hw = w / 2, hd = d / 2;
  const wheelR = Math.min(0.58, h * 0.54);
  const bedY = wheelR + 0.2;
  for (const sx of [-1, 1]) {
    wheelX(b[PAL_TIMBER], sx * (hw - 0.08), wheelR, hd * 0.15, wheelR, 0.09, 9);
    boxN(b[PAL_WOOD], sx * (hw - 0.16) - 0.05, wheelR - 0.05, hd * 0.15 - 0.05,
      sx * (hw - 0.16) + 0.05, wheelR + 0.05, hd * 0.15 + 0.05);
  }
  // Axle + bed.
  boxN(b[PAL_WOOD], -hw + 0.05, wheelR - 0.06, hd * 0.15 - 0.06,
    hw - 0.05, wheelR + 0.06, hd * 0.15 + 0.06);
  boxN(b[PAL_WOOD], -hw + 0.14, bedY, -hd + 0.25, hw - 0.14, bedY + 0.12, hd - 0.05);
  // Side and tail boards.
  for (const sx of [-1, 1]) {
    boxN(b[PAL_TIMBER], sx * (hw - 0.2), bedY + 0.1, -hd + 0.25,
      sx * (hw - 0.06), bedY + 0.52, hd - 0.05);
  }
  boxN(b[PAL_TIMBER], -hw + 0.14, bedY + 0.1, hd - 0.18, hw - 0.14, bedY + 0.52, hd - 0.05);
  // Shafts reaching forward.
  for (const sx of [-1, 1]) {
    beam(b[PAL_WOOD], sx * (hw - 0.3), bedY + 0.02, -hd + 0.3,
      sx * (hw - 0.55), bedY - 0.28, -hd - 0.95, 0.055, 0.055);
  }
  // Load.
  if (v === 0) {
    cone(b[PAL_THATCH], 0, bedY + 0.1, hd * 0.2, Math.min(hw - 0.2, 0.75), 0.9, 8, false);
  } else if (v === 1) {
    for (const sx of [-0.32, 0.32]) {
      cylinder(b[PAL_WOOD], sx, bedY + 0.12, hd * 0.25, 0.26, 0.23, 0.62, 8, false, true);
    }
  } else {
    boxN(b[PAL_WOOL], -hw + 0.28, bedY + 0.12, -hd + 0.4, 0.05, bedY + 0.6, hd - 0.25);
    boxN(b[PAL_BERRY], 0.1, bedY + 0.12, -hd + 0.5, hw - 0.28, bedY + 0.52, hd - 0.3);
  }
}

/**
 * A woodpile — alternating courses stacked log-cabin fashion, which is both
 * how it is actually done and cheaper than modelling round logs.
 */
export function buildWoodpile(b: Buckets, w: number, d: number, h: number, v: number): void {
  const hw = w / 2, hd = d / 2;
  const rows = Math.max(3, Math.min(4, Math.round(h / 0.34)));
  const logH = h / rows;
  for (let r = 0; r < rows; r++) {
    const y = r * logH;
    const pal = (r + v) % 2 === 0 ? PAL_WOOD : PAL_TIMBER;
    if (r % 2 === 0) {
      const n = Math.max(2, Math.round(d / 0.46));
      for (let i = 0; i < n; i++) {
        const z = -hd + ((i + 0.5) / n) * d;
        const jitter = ((i * 37 + r * 11) % 7) * 0.012;
        boxN(b[pal], -hw + jitter, y, z - d / (n * 2.4),
          hw - jitter, y + logH * 0.92, z + d / (n * 2.4));
      }
    } else {
      const n = Math.max(2, Math.round(w / 0.46));
      for (let i = 0; i < n; i++) {
        const x = -hw + ((i + 0.5) / n) * w;
        const jitter = ((i * 23 + r * 13) % 7) * 0.012;
        boxN(b[pal], x - w / (n * 2.4), y, -hd + jitter,
          x + w / (n * 2.4), y + logH * 0.92, hd - jitter);
      }
    }
  }
  // Chopping block and axe-bitten stump out front.
  if (v !== 2) {
    cylinder(b[PAL_WOOD], 0, 0, -hd - 0.55, 0.3, 0.28, 0.5, 8, false, true);
    beam(b[PAL_TIMBER], -0.05, 0.5, -hd - 0.6, -0.32, 0.95, -hd - 0.42, 0.035, 0.035);
    boxN(b[PAL_STONE], -0.4, 0.9, -hd - 0.52, -0.24, 1.02, -hd - 0.32);
  }
}

/** A haystack: a fat cone with a weather cap, plus a leaning pitchfork. */
export function buildHaystack(b: Buckets, w: number, d: number, h: number, v: number): void {
  const r = Math.min(w, d) * 0.46;
  cylinder(b[PAL_THATCH], 0, 0, 0, r, r * 0.92, h * 0.42, 8, false, false);
  cone(b[PAL_THATCH], 0, h * 0.42, 0, r * 0.94, h * 0.58, 8, false);
  if (v === 0) {
    boxN(b[PAL_WOOD], -0.05, h - 0.05, -0.05, 0.05, h + 0.35, 0.05);
  } else if (v === 1) {
    // A second, smaller cock beside the first.
    cone(b[PAL_THATCH], r * 1.15, 0, -r * 0.5, r * 0.55, h * 0.6, 6, false);
  } else {
    beam(b[PAL_WOOD], -r - 0.2, 0, -r * 0.3, -r * 0.55, h * 0.85, -r * 0.1, 0.045, 0.045);
    boxN(b[PAL_TIMBER], -r - 0.28, h * 0.82, -r * 0.16, -r - 0.42, h * 0.98, -r * 0.04);
  }
}

/**
 * A tilled crop plot: dark furrows of soil with green rows growing out of
 * them. The single largest injection of colour into a settlement — before
 * this pass there was not one green pixel anywhere in a village.
 */
export function buildCrops(b: Buckets, w: number, d: number, h: number, v: number): void {
  const hw = w / 2, hd = d / 2;
  // A low board round the tilled plot. The field itself is *only* crop rows:
  // a slab of soil under them reads as decking, because the one brown
  // material available (MAT_ID_WOOD) is literally wood grain, and a full-plot
  // slab of it turns a field into a pallet when seen from any height.
  for (const sz of [-1, 1]) {
    boxN(b[PAL_TIMBER], -hw, -0.25, sz * hd - 0.07, hw, 0.13, sz * hd + 0.07);
  }
  for (const sx of [-1, 1]) {
    boxN(b[PAL_TIMBER], sx * hw - 0.07, -0.25, -hd, sx * hw + 0.07, 0.13, hd);
  }
  const rows = Math.max(3, Math.min(6, Math.round(d / 1.5)));
  for (let i = 0; i < rows; i++) {
    const z = -hd + ((i + 0.5) / rows) * d;
    const half = (d / rows) * 0.3;
    const rowH = h * (0.78 + ((i * 29) % 5) * 0.07);
    boxN(b[PAL_LEAF], -hw + 0.22, -0.3, z - half, hw - 0.22, rowH, z + half);
    // A ridge of turned earth along the near edge of each row.
    boxN(b[PAL_TIMBER], -hw + 0.22, -0.25, z - half * 1.55, hw - 0.22, 0.1, z - half * 1.05);
  }
  if (v === 1) {
    // Scarecrow.
    const sx = hw * 0.45;
    boxN(b[PAL_WOOD], sx - 0.06, 0, -0.06, sx + 0.06, 1.95, 0.06);
    boxN(b[PAL_WOOD], sx - 0.62, 1.42, -0.05, sx + 0.62, 1.54, 0.05);
    boxN(b[PAL_BERRY], sx - 0.34, 1.05, -0.12, sx + 0.34, 1.62, 0.12);
    boxN(b[PAL_WOOL], sx - 0.17, 1.64, -0.17, sx + 0.17, 2.0, 0.17);
    boxN(b[PAL_THATCH], sx - 0.3, 1.96, -0.3, sx + 0.3, 2.08, 0.3);
  } else if (v === 2) {
    // A row of bean poles at the far end.
    for (let i = 0; i < 4; i++) {
      const x = -hw + ((i + 0.5) / 4) * w;
      beam(b[PAL_WOOD], x - 0.18, 0, hd - 0.7, x + 0.18, 1.7, hd - 1.0, 0.035, 0.035);
      beam(b[PAL_WOOD], x + 0.18, 0, hd - 1.0, x - 0.18, 1.7, hd - 0.7, 0.035, 0.035);
    }
  }
}

/** A churchyard: leaning headstones and stone crosses in cropped grass. */
export function buildGraves(b: Buckets, w: number, d: number, h: number, v: number): void {
  const hw = w / 2, hd = d / 2;
  boxN(b[PAL_LEAF], -hw, -0.25, -hd, hw, 0.04, hd);
  // Low kerb along the front and back.
  for (const sz of [-1, 1]) {
    boxN(b[PAL_STONE], -hw, -0.3, sz * hd - 0.09, hw, 0.22, sz * hd + 0.09);
  }
  const cols = Math.max(2, Math.min(4, Math.round(w / 1.5)));
  const rows = Math.max(2, Math.min(3, Math.round(d / 1.6)));
  for (let cx = 0; cx < cols; cx++) {
    for (let cz = 0; cz < rows; cz++) {
      const x = -hw + ((cx + 0.5) / cols) * w;
      const z = -hd + ((cz + 0.55) / rows) * d;
      const k = (cx * 5 + cz * 3 + v * 7) % 6;
      if (k === 5) continue;                 // a gap: not every plot is full
      const lean = ((k % 3) - 1) * 0.07;
      const gh = h * (0.62 + (k % 4) * 0.12);
      if (k % 3 === 0) {
        // Cross.
        beam(b[PAL_STONE], x, 0, z, x + lean, gh, z + lean * 0.6, 0.075, 0.06);
        boxN(b[PAL_STONE], x - 0.26, gh * 0.72, z - 0.06, x + 0.26, gh * 0.72 + 0.13, z + 0.06);
      } else {
        // Round-headed slab.
        beam(b[PAL_STONE], x, 0, z, x + lean, gh, z + lean * 0.6, 0.19, 0.07);
        boxN(b[PAL_STONE], x - 0.13, gh - 0.02, z - 0.06, x + 0.13, gh + 0.11, z + 0.06);
      }
    }
  }
  // A yew and a bunch of flowers.
  cylinder(b[PAL_WOOD], hw - 0.5, 0, hd - 0.5, 0.13, 0.1, 0.7, 6, false, false);
  cone(b[PAL_LEAF], hw - 0.5, 0.55, hd - 0.5, 0.62, 1.7, 7, false);
  boxN(b[PAL_BERRY], -hw + 0.3, 0.04, -hd + 0.35, -hw + 0.55, 0.2, -hd + 0.6);
}

/** Washing strung between two poles — the cheapest "somebody lives here". */
export function buildWashline(b: Buckets, w: number, _d: number, h: number, v: number): void {
  const hw = w / 2;
  for (const sx of [-1, 1]) {
    cylinder(b[PAL_WOOD], sx * hw, -0.5, 0, 0.065, 0.05, h + 0.5, 5, false, true);
    beam(b[PAL_WOOD], sx * hw, h - 0.35, 0, sx * (hw - 0.45), h, 0, 0.035, 0.035);
  }
  boxN(b[PAL_WOOD], -hw, h - 0.03, -0.025, hw, h + 0.03, 0.025);
  const cloths = Math.max(2, Math.min(5, Math.round(w / 1.1)));
  const pals: PaletteIndex[] = [PAL_WOOL, PAL_BERRY, PAL_PLASTER, PAL_WOOL, PAL_LEAF];
  for (let i = 0; i < cloths; i++) {
    const x = -hw + ((i + 0.5) / cloths) * w;
    const cw = (w / cloths) * 0.34;
    const drop = 0.55 + ((i + v) % 3) * 0.22;
    boxN(b[pals[(i + v) % pals.length]],
      x - cw, h - drop, -0.06, x + cw, h - 0.02, 0.06);
  }
}

/** A stone water trough, usually beside a stable or a well. */
export function buildTrough(b: Buckets, w: number, d: number, h: number, v: number): void {
  const hw = w / 2, hd = d / 2;
  const t = 0.13;
  boxN(b[PAL_STONE], -hw, 0, -hd, hw, h * 0.35, hd);              // base
  boxN(b[PAL_STONE], -hw, h * 0.3, -hd, -hw + t, h, hd);
  boxN(b[PAL_STONE], hw - t, h * 0.3, -hd, hw, h, hd);
  boxN(b[PAL_STONE], -hw, h * 0.3, -hd, hw, h, -hd + t);
  boxN(b[PAL_STONE], -hw, h * 0.3, hd - t, hw, h, hd);
  // Standing water, and a bucket if this one is in use.
  boxN(b[PAL_PLASTER], -hw + t, h - 0.11, -hd + t, hw - t, h - 0.04, hd - t);
  if (v === 1) {
    cylinder(b[PAL_WOOD], hw + 0.42, 0, 0, 0.2, 0.18, 0.34, 7, false, true);
  }
}

/** A standing brazier — the courtyard light of a castle at night. */
export function buildBrazier(
  b: Buckets, w: number, _d: number, h: number, _v: number,
  flames?: SettlementFlame[],
): void {
  const r = Math.max(0.34, w * 0.42);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    beam(b[PAL_TIMBER],
      Math.cos(a) * r * 0.82, 0, Math.sin(a) * r * 0.82,
      Math.cos(a) * r * 0.24, h - 0.2, Math.sin(a) * r * 0.24, 0.05, 0.05);
  }
  cylinder(b[PAL_TIMBER], 0, h - 0.24, 0, r * 0.62, r, 0.36, 8, true, false);
  boxN(b[PAL_TORCH], -r * 0.5, h - 0.02, -r * 0.5, r * 0.5, h + 0.12, r * 0.5);
  flames?.push({ x: 0, y: h + 0.1, z: 0, scale: 1.5 });
}

/**
 * A heraldic banner on a pole. Placed in pairs along a castle approach they
 * do most of the work of making an arrival feel like an arrival.
 */
export function buildBanner(b: Buckets, w: number, _d: number, h: number, v: number): void {
  boxN(b[PAL_STONE], -0.3, -0.4, -0.3, 0.3, 0.22, 0.3);
  cylinder(b[PAL_WOOD], 0, 0.15, 0, 0.085, 0.06, h - 0.15, 6, false, false);
  cone(b[PAL_WOOL], 0, h - 0.05, 0, 0.11, 0.34, 6, true);
  const bw = Math.max(0.45, w * 0.5);
  boxN(b[PAL_WOOD], -bw - 0.05, h - 0.75, -0.05, bw + 0.05, h - 0.62, 0.05);
  const cloth = v === 1 ? PAL_WOOL : PAL_BERRY;
  const top = h - 0.7;
  const bot = top - h * 0.52;
  boxN(b[cloth], -bw, bot, -0.035, bw, top, 0.035);
  boxN(b[v === 1 ? PAL_BERRY : PAL_WOOL],
    -bw * 0.42, top - h * 0.34, -0.05, bw * 0.42, top - h * 0.14, 0.05);
  // Swallow-tail: two points hanging below the field.
  for (const sx of [-1, 1]) {
    boxN(b[cloth], sx * bw * 0.55 - bw * 0.28, bot - h * 0.14, -0.035,
      sx * bw * 0.55 + bw * 0.28, bot, 0.035);
  }
}

/** The pillory in a market square — where the town's crime system ends up. */
export function buildPillory(b: Buckets, w: number, d: number, h: number, v: number): void {
  const hw = w / 2, hd = d / 2;
  boxN(b[PAL_STONE], -hw, -0.3, -hd, hw, 0.22, hd);
  for (const sx of [-1, 1]) {
    boxN(b[PAL_WOOD], sx * (hw - 0.3) - 0.1, 0.2, -0.1, sx * (hw - 0.3) + 0.1, h, 0.1);
  }
  // Head-and-hands board, split so the gaps read as holes.
  const y = h - 0.42;
  const gapA = -w * 0.16, gapB = w * 0.16;
  for (const [x0, x1] of [
    [-(hw - 0.3), gapA - 0.14], [gapA + 0.14, gapB - 0.14], [gapB + 0.14, hw - 0.3],
  ] as const) {
    if (x1 <= x0) continue;
    boxN(b[PAL_TIMBER], x0, y, -0.11, x1, y + 0.34, 0.11);
  }
  boxN(b[PAL_TIMBER], -(hw - 0.3), y - 0.2, -0.11, hw - 0.3, y - 0.02, 0.11);
  if (v === 1) {
    // Stocks bench alongside.
    boxN(b[PAL_WOOD], -hw + 0.2, 0.2, hd - 0.42, hw - 0.2, 0.5, hd - 0.12);
  }
}

/** A wayside shrine — a marker stone under a little roof, with an offering. */
export function buildShrine(b: Buckets, w: number, d: number, h: number, v: number): void {
  const hw = w / 2, hd = d / 2;
  boxN(b[PAL_STONE], -hw, -0.4, -hd, hw, 0.24, hd);
  boxN(b[PAL_STONE], -hw + 0.14, 0.2, -hd + 0.14, hw - 0.14, 0.44, hd - 0.14);
  const px = hw * 0.34, pz = hd * 0.34;
  boxN(b[PAL_STONE], -px, 0.4, -pz, px, h - 0.35, pz);
  // Carved niche with a small offering.
  boxN(b[PAL_TIMBER], -px * 0.6, h * 0.42, -pz - 0.03, px * 0.6, h - 0.55, -pz + 0.06);
  boxN(b[PAL_BERRY], -px * 0.3, h * 0.46, -pz - 0.06, px * 0.3, h * 0.46 + 0.16, -pz + 0.02);
  // Capstone + cross or a carved wheel-head.
  boxN(b[PAL_STONE], -px - 0.16, h - 0.35, -pz - 0.16, px + 0.16, h - 0.14, pz + 0.16);
  if (v === 1) {
    cylinder(b[PAL_STONE], 0, h - 0.14, 0, 0.32, 0.3, 0.14, 7, false, true);
    boxN(b[PAL_STONE], -0.07, h - 0.14, -0.07, 0.07, h + 0.62, 0.07);
    boxN(b[PAL_STONE], -0.26, h + 0.28, -0.06, 0.26, h + 0.4, 0.06);
  } else {
    boxN(b[PAL_STONE], -0.09, h - 0.16, -0.09, 0.09, h + 0.5, 0.09);
    boxN(b[PAL_LEAF], -0.22, h + 0.16, -0.08, 0.22, h + 0.3, 0.08);
  }
  boxN(b[PAL_LEAF], -hw + 0.1, 0.2, hd - 0.35, -hw + 0.5, 0.5, hd - 0.05);
}

/** A clipped hedge run — a green boundary that follows a plot edge. */
export function buildHedge(b: Buckets, w: number, d: number, h: number, v: number): void {
  const hw = w / 2, hd = d / 2;
  const n = Math.max(2, Math.min(12, Math.round(w / 1.1)));
  for (let i = 0; i < n; i++) {
    const x0 = -hw + (i / n) * w;
    const x1 = -hw + ((i + 1) / n) * w;
    const k = (i * 31 + v * 17) % 5;
    const hh = h * (0.82 + k * 0.05);
    const bulge = 0.04 + (k % 3) * 0.03;
    boxN(b[PAL_LEAF], x0 - 0.03, 0, -hd - bulge, x1 + 0.03, hh, hd + bulge);
  }
  if (v === 1) {
    // Flowering: a few berry dots along the top.
    for (let i = 0; i < n; i += 2) {
      const x = -hw + ((i + 0.5) / n) * w;
      boxN(b[PAL_BERRY], x - 0.1, h * 0.85, -0.07, x + 0.1, h * 0.85 + 0.12, 0.07);
    }
  }
}

/** Barrels, a crate and a grain sack — the yard clutter of a working town. */
export function buildBarrels(b: Buckets, w: number, d: number, h: number, v: number): void {
  const hw = w / 2, hd = d / 2;
  const r = Math.min(0.32, hw * 0.45);
  cylinder(b[PAL_WOOD], -hw + r + 0.05, 0, -hd + r + 0.05, r * 0.86, r, h * 0.42, 8, false, false);
  cylinder(b[PAL_WOOD], -hw + r + 0.05, h * 0.42, -hd + r + 0.05, r, r * 0.86, h * 0.42, 8, false, true);
  boxN(b[PAL_TIMBER], -hw + 0.05, h * 0.38, -hd + 0.05, -hw + 2 * r + 0.05, h * 0.46, -hd + 2 * r + 0.05);
  if (v !== 2) {
    cylinder(b[PAL_WOOD], hw - r - 0.1, 0, hd - r - 0.2, r * 0.86, r, h * 0.38, 8, false, false);
    cylinder(b[PAL_WOOD], hw - r - 0.1, h * 0.38, hd - r - 0.2, r, r * 0.86, h * 0.38, 8, false, true);
  }
  // Crate.
  boxN(b[PAL_TIMBER], hw - 0.7, 0, -hd + 0.1, hw - 0.05, h * 0.5, -hd + 0.72);
  boxN(b[PAL_WOOD], hw - 0.72, h * 0.46, -hd + 0.08, hw - 0.03, h * 0.54, -hd + 0.74);
  // Grain sack slumped against it.
  boxN(b[PAL_WOOL], hw - 1.3, 0, hd - 0.85, hw - 0.78, h * 0.44, hd - 0.3);
  boxN(b[PAL_WOOL], hw - 1.2, h * 0.4, hd - 0.75, hw - 0.88, h * 0.56, hd - 0.42);
  if (v === 1) {
    boxN(b[PAL_LEAF], hw - 0.66, h * 0.52, -hd + 0.16, hw - 0.1, h * 0.68, -hd + 0.66);
  }
}
