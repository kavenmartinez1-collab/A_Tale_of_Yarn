/**
 * Settlement meshes — world-space triangle soups batched by dungeon-pipeline
 * palette (stone 0, wood 1, torch 2, thatch 4, plaster 5, berry 7), so a whole
 * settlement draws in ≤ 6 calls with the surface material mode (100 + palette)
 * and zeroed lights, exactly like dungeon entrance arches.
 *
 * Buildings sit on the resolved pad height (highest footprint corner) with a
 * stone platform skirt extending below to hide slope gaps — heightAt stays
 * pure, no terrain flattening.
 */

import { box, quad, type P3 } from '../mesh-utils';
import type { ResolvedPad, ResolvedSettlement } from './settlement-layout';

/** Palette indices (dungeon.wgsl): keep in sync with the shader table. */
export const PAL_STONE = 0;
export const PAL_WOOD = 1;
export const PAL_TORCH = 2;   // emissive — lamps/braziers glow at night
export const PAL_THATCH = 4;
export const PAL_PLASTER = 5;
export const PAL_BERRY = 7;   // dark crimson — banners/market goods

const ALL_PALETTES = [
  PAL_STONE, PAL_WOOD, PAL_TORCH, PAL_THATCH, PAL_PLASTER, PAL_BERRY,
] as const;

const SKIRT_DEPTH = 2.5; // platform skirt below the pad (m)

type Buckets = Record<(typeof ALL_PALETTES)[number], number[]>;

function emptyBuckets(): Buckets {
  return {
    [PAL_STONE]: [], [PAL_WOOD]: [], [PAL_TORCH]: [],
    [PAL_THATCH]: [], [PAL_PLASTER]: [], [PAL_BERRY]: [],
  };
}

function tri(verts: number[], a: P3, b: P3, c: P3): void {
  verts.push(...a, ...b, ...c);
}

/** Gabled prism roof: ridge along local x at y0+rise, overhang o. */
function roof(
  thatch: number[], gable: number[],
  w: number, d: number, y0: number, rise: number, o: number,
): void {
  const W = w / 2 + o;
  const D = d / 2 + o;
  const y2 = y0 + rise;
  // Slopes (outward normals verified against mesh-utils winding).
  quad(thatch, [-W, y2, 0], [W, y2, 0], [W, y0, -D], [-W, y0, -D]); // front -z
  quad(thatch, [W, y2, 0], [-W, y2, 0], [-W, y0, D], [W, y0, D]);   // back +z
  // Gable end triangles.
  tri(gable, [-W, y0, -D], [-W, y0, D], [-W, y2, 0]); // -x
  tri(gable, [W, y0, D], [W, y0, -D], [W, y2, 0]);    // +x
}

/** Append one pad's local-space geometry into the palette buckets. */
function buildPad(pad: ResolvedPad, b: Buckets): void {
  const hw = pad.w / 2;
  const hd = pad.d / 2;
  const h = pad.h;
  switch (pad.type) {
    case 'house': {
      box(b[PAL_STONE], -hw - 0.3, -SKIRT_DEPTH, -hd - 0.3, hw + 0.3, 0.08, hd + 0.3);
      box(b[PAL_PLASTER], -hw, 0.08, -hd, hw, h, hd);
      // Timber frame: corner posts proud of the plaster.
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          box(b[PAL_WOOD],
            sx * hw - 0.12, 0.08, sz * hd - 0.12,
            sx * hw + 0.12, h, sz * hd + 0.12);
        }
      }
      // Horizontal beams across the front and back faces (top + waist).
      for (const sz of [-1, 1]) {
        const z0 = sz * hd - (sz < 0 ? 0.06 : -0.02);
        const z1 = sz * hd + (sz < 0 ? 0.02 : 0.06);
        box(b[PAL_WOOD], -hw - 0.04, h - 0.26, z0, hw + 0.04, h - 0.06, z1);
        box(b[PAL_WOOD], -hw - 0.04, h * 0.45, z0, hw + 0.04, h * 0.45 + 0.16, z1);
      }
      box(b[PAL_WOOD], -0.45, 0.08, -hd - 0.06, 0.45, 1.7, -hd + 0.02); // door
      // Shuttered windows flanking the door.
      for (const sx of [-1, 1]) {
        box(b[PAL_WOOD],
          sx * hw * 0.55 - 0.3, 1.05, -hd - 0.04,
          sx * hw * 0.55 + 0.3, 1.65, -hd + 0.02);
      }
      // Stone chimney rising past the roof ridge on the back-right corner.
      const rise = pad.d * 0.45;
      box(b[PAL_STONE], hw - 0.75, h - 0.2, hd - 0.95, hw - 0.15, h + rise + 0.35, hd - 0.35);
      roof(b[PAL_THATCH], b[PAL_PLASTER], pad.w, pad.d, h, rise, 0.3);
      break;
    }
    case 'barn': {
      box(b[PAL_STONE], -hw - 0.3, -SKIRT_DEPTH, -hd - 0.3, hw + 0.3, 0.08, hd + 0.3);
      box(b[PAL_WOOD], -hw, 0.08, -hd, hw, h, hd);
      box(b[PAL_STONE], -0.9, 0.08, -hd - 0.06, 0.9, 2.2, -hd + 0.02); // door
      roof(b[PAL_THATCH], b[PAL_WOOD], pad.w, pad.d, h, pad.d * 0.4, 0.35);
      break;
    }
    case 'well': {
      box(b[PAL_STONE], -0.9, -1.5, -0.9, 0.9, 0.05, 0.9); // skirt
      // Low wall ring.
      box(b[PAL_STONE], -0.75, 0, -0.75, 0.75, h, -0.45);
      box(b[PAL_STONE], -0.75, 0, 0.45, 0.75, h, 0.75);
      box(b[PAL_STONE], -0.75, 0, -0.45, -0.45, h, 0.45);
      box(b[PAL_STONE], 0.45, 0, -0.45, 0.75, h, 0.45);
      // Posts + mini thatch roof.
      box(b[PAL_WOOD], -0.72, h, -0.06, -0.6, 1.9, 0.06);
      box(b[PAL_WOOD], 0.6, h, -0.06, 0.72, 1.9, 0.06);
      roof(b[PAL_THATCH], b[PAL_WOOD], 1.5, 1.2, 1.9, 0.5, 0.1);
      break;
    }
    case 'fence': {
      // Rails + posts every ~2 m; sunk 1 m so slopes don't leave gaps.
      box(b[PAL_WOOD], -hw, 0.42, -0.05, hw, 0.54, 0.05);
      box(b[PAL_WOOD], -hw, 0.78, -0.05, hw, 0.9, 0.05);
      const posts = Math.max(2, Math.round(pad.w / 2) + 1);
      for (let i = 0; i < posts; i++) {
        const x = -hw + (i / (posts - 1)) * pad.w;
        box(b[PAL_WOOD], x - 0.06, -1, -0.06, x + 0.06, pad.h, 0.06);
      }
      break;
    }
    case 'ruin': {
      // Broken wall block, sunk into the ground (no skirt needed).
      box(b[PAL_STONE], -hw, -1.5, -hd, hw, h, hd);
      break;
    }
    case 'signpost': {
      box(b[PAL_WOOD], -0.07, -1, -0.07, 0.07, h, 0.07);
      box(b[PAL_WOOD], -0.55, h - 0.65, -0.05, 0.55, h - 0.15, 0.05); // board
      break;
    }
    case 'tower': {
      // Solid stone tower with overhanging crenellated cap + torch brazier.
      box(b[PAL_STONE], -hw - 0.3, -SKIRT_DEPTH, -hd - 0.3, hw + 0.3, 0.08, hd + 0.3); // skirt
      box(b[PAL_STONE], -hw, 0.08, -hd, hw, h, hd); // shaft
      // Arrow slits on two faces at two heights (dark plaster insets).
      for (const sy of [0.35, 0.6]) {
        box(b[PAL_PLASTER], -0.12, h * sy, -hd - 0.03, 0.12, h * (sy + 0.14), -hd + 0.02);
        box(b[PAL_PLASTER], hw - 0.02, h * sy, -0.12, hw + 0.03, h * (sy + 0.14), 0.12);
      }
      // Overhanging cap slab (machicolation suggestion).
      box(b[PAL_STONE], -hw - 0.25, h - 0.15, -hd - 0.25, hw + 0.25, h + 0.05, hd + 0.25);
      // Merlons around the cap rim: corners + mid-edges.
      const mHalf = 0.32;
      const cx = hw - 0.1;
      const cz = hd - 0.1;
      const merlonPts: [number, number][] = [
        [-cx, -cz], [cx, -cz], [-cx, cz], [cx, cz],  // corners
        [0, -cz], [0, cz], [-cx, 0], [cx, 0],        // mid-edges
      ];
      for (const [mx, mz] of merlonPts) {
        box(b[PAL_STONE],
          mx - mHalf, h + 0.05, mz - mHalf,
          mx + mHalf, h + 0.9, mz + mHalf);
      }
      // Torch brazier at the center of the platform.
      box(b[PAL_WOOD], -0.09, h + 0.05, -0.09, 0.09, h + 1.0, 0.09);
      box(b[PAL_TORCH], -0.18, h + 1.0, -0.18, 0.18, h + 1.35, 0.18);
      break;
    }
    case 'wall': {
      // Curtain-wall segment, stone with walkway.
      box(b[PAL_STONE], -hw - 0.2, -SKIRT_DEPTH, -hd - 0.2, hw + 0.2, 0.08, hd + 0.2); // skirt
      box(b[PAL_STONE], -hw, 0.08, -hd, hw, h, hd); // main body
      // Walkway floor on top.
      box(b[PAL_STONE], -hw, h, -hd, hw, h + 0.1, hd);
      // Low parapet on outer face (-z side) topped with crenellated merlons.
      box(b[PAL_STONE], -hw, h + 0.1, -hd, hw, h + 0.5, -hd + 0.3);
      const merlons = Math.max(2, Math.round(pad.w / 2.2));
      for (let mi = 0; mi < merlons; mi++) {
        const mx = -hw + ((mi + 0.5) / merlons) * pad.w;
        box(b[PAL_STONE], mx - 0.35, h + 0.5, -hd, mx + 0.35, h + 1.1, -hd + 0.3);
      }
      break;
    }
    case 'stable': {
      // Open-sided horse stable: stone base, wood frame, thatch roof.
      box(b[PAL_STONE], -hw - 0.3, -SKIRT_DEPTH, -hd - 0.3, hw + 0.3, 0.08, hd + 0.3); // skirt
      box(b[PAL_STONE], -hw, 0.08, -hd, hw, 0.3, hd); // low stone base
      // Wood frame walls (left/right/back — front -z side open).
      box(b[PAL_WOOD], -hw, 0.3, hd - 0.2, hw, h, hd); // back wall
      box(b[PAL_WOOD], -hw, 0.3, -hd, -hw + 0.2, h, hd); // left wall
      box(b[PAL_WOOD],  hw - 0.2, 0.3, -hd,  hw, h, hd); // right wall
      // Stall dividers.
      const stalls = Math.max(2, Math.round(pad.w / 2));
      for (let si = 1; si < stalls; si++) {
        const sx2 = -hw + (si / stalls) * pad.w;
        box(b[PAL_WOOD], sx2 - 0.06, 0.3, -hd + 0.2, sx2 + 0.06, h * 0.7, hd);
      }
      // Thatch roof.
      roof(b[PAL_THATCH], b[PAL_WOOD], pad.w, pad.d, h, pad.d * 0.4, 0.3);
      break;
    }
    case 'gatehouse': {
      // Heavy stone gatehouse: two flanking piers with arched passthrough.
      box(b[PAL_STONE], -hw - 0.3, -SKIRT_DEPTH, -hd - 0.3, hw + 0.3, 0.08, hd + 0.3); // skirt
      // Left pier.
      box(b[PAL_STONE], -hw, 0.08, -hd, -2.2, h, hd);
      // Right pier.
      box(b[PAL_STONE],  2.2, 0.08, -hd,  hw, h, hd);
      // Arch lintel (over the passage).
      box(b[PAL_STONE], -2.2, 2.4, -hd, 2.2, h, hd);
      // Raised portcullis: vertical wood bars hanging in the arch mouth.
      for (let pi = 0; pi < 4; pi++) {
        const px2 = -1.5 + pi;
        box(b[PAL_WOOD], px2 - 0.09, 1.6, -hd - 0.05, px2 + 0.09, 2.55, -hd + 0.03);
      }
      box(b[PAL_WOOD], -2.0, 2.35, -hd - 0.05, 2.0, 2.6, -hd + 0.03); // header bar
      // Crimson banners hung on the outer face of each pier.
      for (const sxb of [-1, 1]) {
        box(b[PAL_BERRY],
          sxb * (hw - 0.9) - 0.45, h - 3.4, -hd - 0.08,
          sxb * (hw - 0.9) + 0.45, h - 0.6, -hd - 0.02);
      }
      // Torches flanking the gate.
      for (const sxt of [-1, 1]) {
        box(b[PAL_TORCH], sxt * 2.6 - 0.12, 2.6, -hd - 0.16, sxt * 2.6 + 0.12, 2.95, -hd - 0.02);
      }
      // Battlements.
      const bw2 = 1.0;
      const bgap2 = 1.4;
      for (let bi = -1; bi <= 1; bi++) {
        const bx2 = bi * bgap2 * 2;
        if (Math.abs(bx2) < hw) {
          box(b[PAL_STONE], bx2 - bw2 / 2, h, -hd, bx2 + bw2 / 2, h + 1.0, hd);
        }
      }
      break;
    }
    case 'jail': {
      // Stone jail building with barred window suggestion.
      box(b[PAL_STONE], -hw - 0.3, -SKIRT_DEPTH, -hd - 0.3, hw + 0.3, 0.08, hd + 0.3); // skirt
      box(b[PAL_STONE], -hw, 0.08, -hd, hw, h, hd); // walls
      // Door opening on -z face.
      box(b[PAL_WOOD], -0.55, 0.08, -hd - 0.06, 0.55, 2.0, -hd + 0.06);
      // Barred window suggestion (iron-grey plaster inset).
      box(b[PAL_PLASTER], hw - 0.15, 0.9, -0.45, hw + 0.02, 1.7, 0.45);
      // Heavy flat roof (no gable — fortified look).
      box(b[PAL_STONE], -hw - 0.15, h, -hd - 0.15, hw + 0.15, h + 0.3, hd + 0.15);
      break;
    }
    case 'keep': {
      // Fortified great hall: crenellated block with corner turrets + banner.
      box(b[PAL_STONE], -hw - 0.3, -SKIRT_DEPTH, -hd - 0.3, hw + 0.3, 0.08, hd + 0.3); // skirt
      box(b[PAL_STONE], -hw, 0.08, -hd, hw, h, hd); // main block
      // Overhanging cap slab.
      box(b[PAL_STONE], -hw - 0.3, h - 0.15, -hd - 0.3, hw + 0.3, h + 0.1, hd + 0.3);
      // Merlons around the roof rim.
      const kx = Math.max(2, Math.round(pad.w / 1.8));
      const kz = Math.max(2, Math.round(pad.d / 1.8));
      for (let i = 0; i < kx; i++) {
        const mx = -hw + ((i + 0.5) / kx) * pad.w;
        box(b[PAL_STONE], mx - 0.35, h + 0.1, -hd - 0.3, mx + 0.35, h + 0.85, -hd + 0.25);
        box(b[PAL_STONE], mx - 0.35, h + 0.1, hd - 0.25, mx + 0.35, h + 0.85, hd + 0.3);
      }
      for (let i = 0; i < kz; i++) {
        const mz = -hd + ((i + 0.5) / kz) * pad.d;
        box(b[PAL_STONE], -hw - 0.3, h + 0.1, mz - 0.35, -hw + 0.25, h + 0.85, mz + 0.35);
        box(b[PAL_STONE], hw - 0.25, h + 0.1, mz - 0.35, hw + 0.3, h + 0.85, mz + 0.35);
      }
      // Corner turrets rising above the roofline.
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          box(b[PAL_STONE],
            sx * hw - 0.7, 0.08, sz * hd - 0.7,
            sx * hw + 0.7, h + 1.7, sz * hd + 0.7);
          box(b[PAL_STONE],
            sx * hw - 0.85, h + 1.7, sz * hd - 0.85,
            sx * hw + 0.85, h + 2.0, sz * hd + 0.85); // turret cap
        }
      }
      // Tall double door on the -z face.
      box(b[PAL_WOOD], -0.9, 0.08, -hd - 0.08, 0.9, 2.6, -hd + 0.02);
      // Window insets: two rows on the front face.
      for (const wy of [h * 0.42, h * 0.68]) {
        for (const sx of [-1, 1]) {
          box(b[PAL_PLASTER],
            sx * hw * 0.5 - 0.28, wy, -hd - 0.04,
            sx * hw * 0.5 + 0.28, wy + 0.7, -hd + 0.02);
        }
      }
      // Crimson banner above the door.
      box(b[PAL_BERRY], -0.6, h - 2.2, -hd - 0.1, 0.6, h - 0.3, -hd - 0.03);
      // Torches flanking the entrance.
      for (const sxt of [-1, 1]) {
        box(b[PAL_TORCH], sxt * 1.4 - 0.12, 2.2, -hd - 0.16, sxt * 1.4 + 0.12, 2.55, -hd - 0.02);
      }
      break;
    }
    case 'stall': {
      // Market stall: wood posts, thatch canopy, counter, crimson goods.
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          box(b[PAL_WOOD],
            sx * (hw - 0.1) - 0.07, -0.5, sz * (hd - 0.1) - 0.07,
            sx * (hw - 0.1) + 0.07, h, sz * (hd - 0.1) + 0.07);
        }
      }
      // Canopy: main slab + lower front lip for a sloped look.
      box(b[PAL_THATCH], -hw - 0.25, h, -hd - 0.15, hw + 0.25, h + 0.12, hd + 0.15);
      box(b[PAL_THATCH], -hw - 0.25, h - 0.25, -hd - 0.55, hw + 0.25, h - 0.13, -hd - 0.1);
      // Counter across the front.
      box(b[PAL_WOOD], -hw + 0.1, 0.75, -hd - 0.05, hw - 0.1, 0.95, -hd + 0.45);
      // Goods crate on the counter.
      box(b[PAL_BERRY], -0.5, 0.95, -hd + 0.02, 0.1, 1.25, -hd + 0.38);
      break;
    }
    case 'lamp': {
      // Torch lamp post: pole + arm + glowing lantern.
      box(b[PAL_WOOD], -0.07, -1, -0.07, 0.07, h, 0.07);
      box(b[PAL_WOOD], -0.05, h - 0.1, -0.38, 0.05, h, 0.05);
      box(b[PAL_TORCH], -0.1, h - 0.42, -0.44, 0.1, h - 0.1, -0.24);
      break;
    }
  }
}

/** One settlement → up to 6 world-space soups, keyed by palette index. */
export function buildSettlementMeshes(
  s: ResolvedSettlement,
): { palette: number; verts: Float32Array<ArrayBuffer> }[] {
  const buckets: Buckets = emptyBuckets();
  for (const pad of s.pads) {
    const local: Buckets = emptyBuckets();
    buildPad(pad, local);
    // Rotate by yaw (quantized 90° steps) then translate to world.
    const ys = Math.sin(pad.yaw);
    const yc = Math.cos(pad.yaw);
    for (const key of ALL_PALETTES) {
      const src = local[key];
      const dst = buckets[key];
      for (let i = 0; i < src.length; i += 3) {
        const x = src[i];
        const y = src[i + 1];
        const z = src[i + 2];
        dst.push(
          pad.wx + x * yc - z * ys,
          pad.wy + y,
          pad.wz + x * ys + z * yc,
        );
      }
    }
  }
  const out: { palette: number; verts: Float32Array<ArrayBuffer> }[] = [];
  for (const key of ALL_PALETTES) {
    if (buckets[key].length > 0) {
      out.push({ palette: key, verts: new Float32Array(buckets[key]) });
    }
  }
  return out;
}
