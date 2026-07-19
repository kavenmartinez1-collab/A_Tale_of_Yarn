/**
 * Settlement meshes — world-space triangle soups batched by dungeon-pipeline
 * palette (stone 0, wood 1, thatch 4, plaster 5), so a whole settlement draws
 * in ≤ 4 calls with the surface material mode (100 + palette) and zeroed
 * lights, exactly like dungeon entrance arches.
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
export const PAL_THATCH = 4;
export const PAL_PLASTER = 5;

const SKIRT_DEPTH = 2.5; // platform skirt below the pad (m)

interface Buckets {
  [PAL_STONE]: number[];
  [PAL_WOOD]: number[];
  [PAL_THATCH]: number[];
  [PAL_PLASTER]: number[];
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
      box(b[PAL_WOOD], -0.45, 0.08, -hd - 0.06, 0.45, 1.7, -hd + 0.02); // door
      roof(b[PAL_THATCH], b[PAL_PLASTER], pad.w, pad.d, h, pad.d * 0.45, 0.3);
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
      // Solid stone tower with crenellated parapet.
      box(b[PAL_STONE], -hw - 0.3, -SKIRT_DEPTH, -hd - 0.3, hw + 0.3, 0.08, hd + 0.3); // skirt
      box(b[PAL_STONE], -hw, 0.08, -hd, hw, h, hd); // shaft
      // Arrow-slit window (negative space suggestion — just a dark plaster panel).
      box(b[PAL_PLASTER], -0.12, h * 0.45, -hd - 0.02, 0.12, h * 0.65, -hd + 0.02);
      // Crenels: 4 merlons across the top.
      const mW = hw * 0.35;
      const mGap = hw * 0.25;
      for (let mi = -1; mi <= 1; mi += 2) {
        box(b[PAL_STONE], mi * (mGap + mW / 2) - mW / 2, h, -hd, mi * (mGap + mW / 2) + mW / 2, h + 0.9, hd);
      }
      box(b[PAL_STONE], -hw, h, -hd, -hw + 0.6, h + 0.9, hd);
      box(b[PAL_STONE],  hw - 0.6, h, -hd,  hw, h + 0.9, hd);
      break;
    }
    case 'wall': {
      // Curtain-wall segment, stone with walkway.
      box(b[PAL_STONE], -hw - 0.2, -SKIRT_DEPTH, -hd - 0.2, hw + 0.2, 0.08, hd + 0.2); // skirt
      box(b[PAL_STONE], -hw, 0.08, -hd, hw, h, hd); // main body
      // Walkway floor on top.
      box(b[PAL_STONE], -hw, h, -hd, hw, h + 0.1, hd);
      // Low parapet on outer face (-z side).
      box(b[PAL_STONE], -hw, h + 0.1, -hd, hw, h + 0.7, -hd + 0.3);
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
      // Portcullis / door suggestion (wood plank across bottom of passage).
      box(b[PAL_WOOD], -2.0, 0.08, -hd - 0.06, 2.0, 2.2, -hd + 0.06);
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
  }
}

/** One settlement → up to 4 world-space soups, keyed by palette index. */
export function buildSettlementMeshes(
  s: ResolvedSettlement,
): { palette: number; verts: Float32Array<ArrayBuffer> }[] {
  const buckets: Buckets = {
    [PAL_STONE]: [], [PAL_WOOD]: [], [PAL_THATCH]: [], [PAL_PLASTER]: [],
  };
  for (const pad of s.pads) {
    const local: Buckets = {
      [PAL_STONE]: [], [PAL_WOOD]: [], [PAL_THATCH]: [], [PAL_PLASTER]: [],
    };
    buildPad(pad, local);
    // Rotate by yaw (quantized 90° steps) then translate to world.
    const ys = Math.sin(pad.yaw);
    const yc = Math.cos(pad.yaw);
    for (const key of [PAL_STONE, PAL_WOOD, PAL_THATCH, PAL_PLASTER] as const) {
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
  for (const key of [PAL_STONE, PAL_WOOD, PAL_THATCH, PAL_PLASTER] as const) {
    if (buckets[key].length > 0) {
      out.push({ palette: key, verts: new Float32Array(buckets[key]) });
    }
  }
  return out;
}
