/**
 * Settlement meshes — world-space triangle soups batched by dungeon-pipeline
 * palette, so a whole settlement draws in one call per palette it uses with
 * the surface material mode (100 + palette) and zeroed lights, exactly like
 * dungeon entrance arches.
 *
 * Buildings sit on the resolved pad height (highest footprint corner) with a
 * stone platform skirt extending below to hide slope gaps — heightAt stays
 * pure, no terrain flattening.
 *
 * The big builders live next door: settlement-buildings.ts (church, tavern,
 * longhouse, smithy, mill, town house, granary, cottage, barn) and
 * settlement-props.ts (carts, crops, hedges, graves, washing, braziers…).
 * This file owns the castle/utility vocabulary and the dispatch + batching.
 */

import { appendYaw, cone, cylinder } from '../mesh-utils';
import type { ResolvedPad, ResolvedSettlement } from './settlement-layout';
import {
  ALL_PALETTES, emptyBuckets, PAL_BERRY, PAL_LEAF, PAL_PLASTER, PAL_STONE,
  PAL_THATCH, PAL_TIMBER, PAL_TORCH, PAL_WOOD, PAL_WOOL, SKIRT_DEPTH,
  type Buckets, type SettlementFlame,
} from './settlement-palette';
import {
  buildBarn, buildChurch, buildGranary, buildHouse, buildLonghouse, buildMill,
  buildSmithy, buildTavern, buildTownhouse,
} from './settlement-buildings';
import {
  buildBanner, buildBarrels, buildBrazier, buildCart, buildCrops, buildGraves,
  buildHaystack, buildHedge, buildPillory, buildShrine, buildTrough,
  buildWashline, buildWoodpile,
} from './settlement-props';
import { buildPathMeshes } from './settlement-paths';
import { beam, bevelBoxN, boxN, roof } from './settlement-shapes';

export {
  ALL_PALETTES, PAL_BERRY, PAL_LEAF, PAL_PLASTER, PAL_STONE, PAL_THATCH,
  PAL_TIMBER, PAL_TORCH, PAL_WOOD, PAL_WOOL,
} from './settlement-palette';
export type { SettlementFlame } from './settlement-palette';

/**
 * Append one pad's local-space geometry into the palette buckets.
 * `flames` (optional) collects PAL_TORCH fixture anchors in the same local
 * space, so they stay pinned to the geometry that emits them.
 */
function buildPad(
  pad: ResolvedPad, b: Buckets, flames?: SettlementFlame[],
): void {
  const hw = pad.w / 2;
  const hd = pad.d / 2;
  const h = pad.h;
  const v = pad.v ?? 0;
  switch (pad.type) {
    // --- delegated builders ------------------------------------------------
    case 'house': buildHouse(b, pad.w, pad.d, h, v); break;
    case 'townhouse': buildTownhouse(b, pad.w, pad.d, h, v); break;
    case 'barn': buildBarn(b, pad.w, pad.d, h, v); break;
    case 'church': buildChurch(b, pad.w, pad.d, h); break;
    case 'tavern': buildTavern(b, pad.w, pad.d, h, flames); break;
    case 'longhouse': buildLonghouse(b, pad.w, pad.d, h); break;
    case 'smithy': buildSmithy(b, pad.w, pad.d, h, flames); break;
    case 'mill': buildMill(b, pad.w, pad.d, h); break;
    case 'granary': buildGranary(b, pad.w, pad.d, h); break;
    case 'cart': buildCart(b, pad.w, pad.d, h, v); break;
    case 'woodpile': buildWoodpile(b, pad.w, pad.d, h, v); break;
    case 'haystack': buildHaystack(b, pad.w, pad.d, h, v); break;
    case 'crops': buildCrops(b, pad.w, pad.d, h, v); break;
    case 'graves': buildGraves(b, pad.w, pad.d, h, v); break;
    case 'washline': buildWashline(b, pad.w, pad.d, h, v); break;
    case 'trough': buildTrough(b, pad.w, pad.d, h, v); break;
    case 'brazier': buildBrazier(b, pad.w, pad.d, h, v, flames); break;
    case 'banner': buildBanner(b, pad.w, pad.d, h, v); break;
    case 'pillory': buildPillory(b, pad.w, pad.d, h, v); break;
    case 'shrine': buildShrine(b, pad.w, pad.d, h, v); break;
    case 'hedge': buildHedge(b, pad.w, pad.d, h, v); break;
    case 'barrels': buildBarrels(b, pad.w, pad.d, h, v); break;

    // --- utility + castle vocabulary --------------------------------------
    case 'well': {
      const dry = v === 1;
      boxN(b[PAL_STONE], -0.9, -1.5, -0.9, 0.9, 0.05, 0.9); // skirt
      // Round wall ring (hollow tube — no caps — reads as a stone well shaft).
      cylinder(b[PAL_STONE], 0, 0, 0, 0.75, 0.72, h, 8, false, false);
      cylinder(b[PAL_STONE], 0, h - 0.1, 0, 0.8, 0.78, 0.12, 8, false, false);
      if (dry) {
        // Abandoned: the roof is gone and the coping has fallen in.
        boxN(b[PAL_STONE], -0.72, h - 0.05, -0.3, -0.1, h + 0.24, 0.36);
        boxN(b[PAL_LEAF], -0.86, 0.05, -0.86, 0.86, 0.34, -0.5);
        boxN(b[PAL_LEAF], 0.42, 0.05, -0.3, 0.9, 0.42, 0.5);
        break;
      }
      // Posts + mini thatch roof.
      cylinder(b[PAL_WOOD], -0.66, h, 0, 0.07, 0.055, 1.95 - h, 6, false, true);
      cylinder(b[PAL_WOOD], 0.66, h, 0, 0.07, 0.055, 1.95 - h, 6, false, true);
      // Winch drum, crank handle, rope and bucket.
      cylinder(b[PAL_WOOD], -0.6, 1.42, 0, 0.11, 0.11, 1.2, 6, false, false);
      beam(b[PAL_TIMBER], 0.68, 1.42, 0, 0.68, 1.42, 0.34, 0.045, 0.045);
      beam(b[PAL_TIMBER], 0.68, 1.42, 0.34, 0.9, 1.16, 0.34, 0.045, 0.045);
      boxN(b[PAL_WOOD], -0.03, h + 0.15, -0.03, 0.03, 1.42, 0.03);
      cylinder(b[PAL_TIMBER], 0, h - 0.08, 0, 0.17, 0.2, 0.26, 7, true, false);
      boxN(b[PAL_LEAF], -0.82, 0.02, 0.34, -0.3, 0.28, 0.86);
      roof(b[PAL_THATCH], b[PAL_WOOD], 1.6, 1.3, 1.95, 0.55, 0.12);
      break;
    }
    case 'fence': {
      // Rails + posts every ~2 m; sunk 1 m so slopes don't leave gaps.
      bevelBoxN(b[PAL_WOOD], -hw, 0.42, -0.05, hw, 0.54, 0.05);
      bevelBoxN(b[PAL_WOOD], -hw, 0.78, -0.05, hw, 0.9, 0.05);
      const posts = Math.max(2, Math.round(pad.w / 2) + 1);
      for (let i = 0; i < posts; i++) {
        const x = -hw + (i / (posts - 1)) * pad.w;
        cylinder(b[PAL_WOOD], x, -1, 0, 0.07, 0.055, pad.h + 1, 6, false, true);
      }
      break;
    }
    case 'ruin': {
      // Broken wall block, sunk into the ground (no skirt needed).
      bevelBoxN(b[PAL_STONE], -hw, -1.5, -hd, hw, h, hd);
      if (h > 0.8) {
        // A broken-off tooth on top, and moss creeping up the shaded face.
        boxN(b[PAL_STONE], -hw * 0.45, h, -hd, hw * 0.15, h + 0.26 + hw * 0.1, hd);
        // Weeds at the foot of the wall. This used to be a tall panel of
        // PAL_LEAF up the wall face, which read as a bright green decal
        // pasted on the stone rather than as moss.
        boxN(b[PAL_LEAF], -hw + 0.05, 0.0, hd - 0.04, -hw + 0.6, 0.3, hd + 0.16);
        boxN(b[PAL_LEAF], hw - 0.66, 0.0, -hd - 0.16, hw - 0.2, 0.24, -hd + 0.02);
      }
      break;
    }
    case 'signpost': {
      boxN(b[PAL_STONE], -0.36, -0.4, -0.36, 0.36, 0.16, 0.36);
      cylinder(b[PAL_WOOD], 0, -1, 0, 0.075, 0.06, h + 1, 6, false, true);
      cone(b[PAL_WOOD], 0, h, 0, 0.1, 0.22, 6, false);
      bevelBoxN(b[PAL_TIMBER], -0.58, h - 0.68, -0.05, 0.58, h - 0.16, 0.05);
      bevelBoxN(b[PAL_TIMBER], -0.42, h - 1.24, -0.05, 0.42, h - 0.82, 0.05);
      break;
    }
    case 'tower': {
      // Solid stone tower with overhanging crenellated cap + torch brazier.
      bevelBoxN(b[PAL_STONE], -hw - 0.3, -SKIRT_DEPTH, -hd - 0.3, hw + 0.3, 0.08, hd + 0.3);
      bevelBoxN(b[PAL_STONE], -hw, 0.08, -hd, hw, h, hd); // shaft
      // Battered base: a thicker skirt of masonry, which is both how a real
      // tower is built and what stops it reading as an extruded rectangle.
      bevelBoxN(b[PAL_STONE], -hw - 0.3, 0.08, -hd - 0.3, hw + 0.3, 1.3, hd + 0.3);
      // Arrow slits on two faces at two heights (dark insets).
      for (const sy of [0.35, 0.6]) {
        boxN(b[PAL_TIMBER], -0.12, h * sy, -hd - 0.03, 0.12, h * (sy + 0.14), -hd + 0.02);
        boxN(b[PAL_TIMBER], hw - 0.02, h * sy, -0.12, hw + 0.03, h * (sy + 0.14), 0.12);
      }
      // Corbels under the overhanging cap.
      for (let i = 0; i < 4; i++) {
        const t = -hw + ((i + 0.5) / 4) * pad.w;
        for (const sz of [-1, 1]) {
          boxN(b[PAL_STONE], t - 0.14, h - 0.55, sz * hd - 0.02, t + 0.14, h - 0.15, sz * (hd + 0.26));
        }
        for (const sx of [-1, 1]) {
          boxN(b[PAL_STONE], sx * hd - 0.02, h - 0.55, t - 0.14, sx * (hd + 0.26), h - 0.15, t + 0.14);
        }
      }
      // Overhanging cap slab (machicolation suggestion).
      bevelBoxN(b[PAL_STONE], -hw - 0.25, h - 0.15, -hd - 0.25, hw + 0.25, h + 0.05, hd + 0.25);
      // Merlons around the cap rim: corners + mid-edges.
      const mHalf = 0.32;
      const cx = hw - 0.1;
      const cz = hd - 0.1;
      const merlonPts: [number, number][] = [
        [-cx, -cz], [cx, -cz], [-cx, cz], [cx, cz],  // corners
        [0, -cz], [0, cz], [-cx, 0], [cx, 0],        // mid-edges
      ];
      for (const [mx, mz] of merlonPts) {
        boxN(b[PAL_STONE],
          mx - mHalf, h + 0.05, mz - mHalf,
          mx + mHalf, h + 0.9, mz + mHalf);
      }
      // Torch brazier at the centre of the platform, and a pennant.
      cylinder(b[PAL_TIMBER], 0, h + 0.05, 0, 0.1, 0.08, 0.95, 6, false, true);
      boxN(b[PAL_TORCH], -0.19, h + 1.0, -0.19, 0.19, h + 1.38, 0.19);
      flames?.push({ x: 0, y: h + 1.08, z: 0, scale: 1.55 });
      cylinder(b[PAL_WOOD], cx - 0.1, h + 0.9, cz - 0.1, 0.055, 0.045, 2.1, 5, false, true);
      boxN(b[PAL_BERRY], cx - 0.12, h + 2.2, cz - 0.1, cx + 0.85, h + 2.72, cz - 0.06);
      break;
    }
    case 'wall': {
      // Curtain-wall segment, stone with walkway.
      bevelBoxN(b[PAL_STONE], -hw - 0.2, -SKIRT_DEPTH, -hd - 0.2, hw + 0.2, 0.08, hd + 0.2);
      bevelBoxN(b[PAL_STONE], -hw, 0.08, -hd, hw, h, hd); // main body
      // Battered plinth on the outer (-z) face.
      boxN(b[PAL_STONE], -hw, 0.08, -hd - 0.28, hw, 1.15, -hd + 0.02);
      // Walkway floor on top.
      bevelBoxN(b[PAL_STONE], -hw, h, -hd, hw, h + 0.1, hd);
      // Low parapet on outer face topped with crenellated merlons.
      bevelBoxN(b[PAL_STONE], -hw, h + 0.1, -hd, hw, h + 0.5, -hd + 0.32);
      const merlons = Math.max(2, Math.round(pad.w / 2.6));
      for (let mi = 0; mi < merlons; mi++) {
        const mx = -hw + ((mi + 0.5) / merlons) * pad.w;
        boxN(b[PAL_STONE], mx - 0.35, h + 0.5, -hd, mx + 0.35, h + 1.15, -hd + 0.32);
        // Corbel every other merlon — at 50 m of curtain wall, one under each
        // is a thousand vertices for a shadow you cannot resolve.
        if (mi % 2 === 0) {
          boxN(b[PAL_STONE], mx - 0.2, h - 0.4, -hd - 0.22, mx + 0.2, h - 0.05, -hd + 0.02);
        }
      }
      // Inner-face buttresses carrying the walkway.
      const buts = Math.max(2, Math.round(pad.w / 5));
      for (let i = 0; i < buts; i++) {
        const bx = -hw + ((i + 0.5) / buts) * pad.w;
        boxN(b[PAL_STONE], bx - 0.35, 0.08, hd - 0.02, bx + 0.35, h * 0.72, hd + 0.45);
      }
      break;
    }
    case 'stable': {
      // Open-sided horse stable: stone base, wood frame, thatch roof.
      bevelBoxN(b[PAL_STONE], -hw - 0.3, -SKIRT_DEPTH, -hd - 0.3, hw + 0.3, 0.08, hd + 0.3);
      bevelBoxN(b[PAL_STONE], -hw, 0.08, -hd, hw, 0.3, hd); // low stone base
      bevelBoxN(b[PAL_WOOD], -hw, 0.3, hd - 0.2, hw, h, hd);   // back wall
      bevelBoxN(b[PAL_WOOD], -hw, 0.3, -hd, -hw + 0.2, h, hd); // left wall
      bevelBoxN(b[PAL_WOOD], hw - 0.2, 0.3, -hd, hw, h, hd);   // right wall
      // Stall dividers, a half-door on each, and hay on the floor.
      const stalls = Math.max(2, Math.round(pad.w / 2));
      for (let si = 1; si < stalls; si++) {
        const sx2 = -hw + (si / stalls) * pad.w;
        boxN(b[PAL_WOOD], sx2 - 0.07, 0.3, -hd + 0.2, sx2 + 0.07, h * 0.72, hd);
      }
      for (let si = 0; si < stalls; si++) {
        const cx2 = -hw + ((si + 0.5) / stalls) * pad.w;
        const sw = (pad.w / stalls) * 0.42;
        boxN(b[PAL_TIMBER], cx2 - sw, 0.3, -hd + 0.16, cx2 + sw, 1.25, -hd + 0.3);
        boxN(b[PAL_THATCH], cx2 - sw, 0.3, hd - 1.0, cx2 + sw, 0.52, hd - 0.28);
      }
      // Head beam and a hanging bridle.
      boxN(b[PAL_TIMBER], -hw, h - 0.28, -hd + 0.1, hw, h - 0.04, -hd + 0.32);
      boxN(b[PAL_TIMBER], hw - 0.62, h - 1.35, -hd + 0.28, hw - 0.42, h - 0.3, -hd + 0.4);
      roof(b[PAL_THATCH], b[PAL_WOOD], pad.w, pad.d, h, pad.d * 0.42, 0.34);
      break;
    }
    case 'gatehouse': {
      // Heavy stone gatehouse: two flanking piers with an arched passage.
      bevelBoxN(b[PAL_STONE], -hw - 0.3, -SKIRT_DEPTH, -hd - 0.3, hw + 0.3, 0.08, hd + 0.3);
      bevelBoxN(b[PAL_STONE], -hw, 0.08, -hd, -2.2, h, hd); // left pier
      bevelBoxN(b[PAL_STONE], 2.2, 0.08, -hd, hw, h, hd);   // right pier
      bevelBoxN(b[PAL_STONE], -2.2, 2.6, -hd, 2.2, h, hd);  // lintel over passage
      // Half-round flanking turrets, which is what makes a gate read as a gate.
      for (const sxg of [-1, 1]) {
        cylinder(b[PAL_STONE], sxg * (hw - 0.3), 0.08, -hd - 0.1, 1.15, 1.0, h + 0.5, 8, false, false);
        cylinder(b[PAL_STONE], sxg * (hw - 0.3), h + 0.5, -hd - 0.1, 1.3, 1.25, 0.32, 8, false, true);
        for (let m = 0; m < 5; m++) {
          const a = Math.PI * (0.15 + (m / 4) * 0.7) + Math.PI;
          boxN(b[PAL_STONE],
            sxg * (hw - 0.3) + Math.cos(a) * 1.05 - 0.22, h + 0.8, -hd - 0.1 + Math.sin(a) * 1.05 - 0.22,
            sxg * (hw - 0.3) + Math.cos(a) * 1.05 + 0.22, h + 1.5, -hd - 0.1 + Math.sin(a) * 1.05 + 0.22);
        }
      }
      // Raised portcullis: round iron bars hanging in the arch mouth.
      for (let pi = 0; pi < 5; pi++) {
        const px2 = -1.7 + pi * 0.85;
        cylinder(b[PAL_TIMBER], px2, 1.75, -hd - 0.02, 0.075, 0.07, 0.9, 6, false, true);
      }
      boxN(b[PAL_TIMBER], -2.0, 2.52, -hd - 0.06, 2.0, 2.72, -hd + 0.03);
      // Drawbridge chains running up to the winch housing.
      for (const sxc of [-1, 1]) {
        beam(b[PAL_TIMBER], sxc * 1.7, 2.75, -hd - 0.08, sxc * 1.9, h - 0.6, -hd - 0.06, 0.045, 0.045);
      }
      // Crimson banners hung on the outer face of each pier.
      for (const sxb of [-1, 1]) {
        boxN(b[PAL_BERRY],
          sxb * (hw - 1.6) - 0.5, h - 3.6, -hd - 0.1,
          sxb * (hw - 1.6) + 0.5, h - 0.7, -hd - 0.03);
        boxN(b[PAL_WOOL],
          sxb * (hw - 1.6) - 0.22, h - 2.6, -hd - 0.13,
          sxb * (hw - 1.6) + 0.22, h - 1.7, -hd - 0.06);
      }
      // Torches flanking the gate.
      for (const sxt of [-1, 1]) {
        boxN(b[PAL_TORCH], sxt * 2.7 - 0.12, 2.7, -hd - 0.17, sxt * 2.7 + 0.12, 3.05, -hd - 0.02);
        flames?.push({ x: sxt * 2.7, y: 2.82, z: -hd - 0.1, scale: 1 });
      }
      // Battlements over the passage.
      for (let bi = -2; bi <= 2; bi++) {
        const bx2 = bi * 1.35;
        if (Math.abs(bx2) < hw - 1.4) {
          boxN(b[PAL_STONE], bx2 - 0.5, h, -hd, bx2 + 0.5, h + 1.05, hd);
        }
      }
      break;
    }
    case 'jail': {
      // Stone jail: heavy, small openings, real bars.
      bevelBoxN(b[PAL_STONE], -hw - 0.3, -SKIRT_DEPTH, -hd - 0.3, hw + 0.3, 0.08, hd + 0.3);
      bevelBoxN(b[PAL_STONE], -hw, 0.08, -hd, hw, h, hd); // walls
      boxN(b[PAL_TIMBER], -0.55, 0.08, -hd - 0.07, 0.55, 2.0, -hd + 0.06); // door
      boxN(b[PAL_STONE], -0.68, 1.96, -hd - 0.12, 0.68, 2.2, -hd + 0.02);
      // Barred window on the +X face.
      boxN(b[PAL_TIMBER], hw - 0.14, 0.95, -0.48, hw + 0.02, 1.7, 0.48);
      for (let i = 0; i < 4; i++) {
        const bz = -0.44 + i * 0.29;
        cylinder(b[PAL_TIMBER], hw + 0.01, 0.95, bz, 0.045, 0.04, 0.75, 5, false, false);
      }
      // Heavy flat roof (no gable — fortified look).
      bevelBoxN(b[PAL_STONE], -hw - 0.15, h, -hd - 0.15, hw + 0.15, h + 0.32, hd + 0.15);
      for (let i = 0; i < 4; i++) {
        const mx = -hw + ((i + 0.5) / 4) * pad.w;
        boxN(b[PAL_STONE], mx - 0.28, h + 0.3, -hd - 0.15, mx + 0.28, h + 0.75, -hd + 0.15);
      }
      break;
    }
    case 'keep': {
      // Fortified great hall: crenellated block with corner turrets + banner.
      bevelBoxN(b[PAL_STONE], -hw - 0.3, -SKIRT_DEPTH, -hd - 0.3, hw + 0.3, 0.08, hd + 0.3);
      bevelBoxN(b[PAL_STONE], -hw, 0.08, -hd, hw, h, hd); // main block
      bevelBoxN(b[PAL_STONE], -hw - 0.35, 0.08, -hd - 0.35, hw + 0.35, 1.5, hd + 0.35); // batter
      bevelBoxN(b[PAL_STONE], -hw - 0.3, h - 0.15, -hd - 0.3, hw + 0.3, h + 0.1, hd + 0.3);
      // Merlons around the roof rim.
      const kx = Math.max(2, Math.round(pad.w / 1.8));
      const kz = Math.max(2, Math.round(pad.d / 1.8));
      for (let i = 0; i < kx; i++) {
        const mx = -hw + ((i + 0.5) / kx) * pad.w;
        boxN(b[PAL_STONE], mx - 0.35, h + 0.1, -hd - 0.3, mx + 0.35, h + 0.9, -hd + 0.25);
        boxN(b[PAL_STONE], mx - 0.35, h + 0.1, hd - 0.25, mx + 0.35, h + 0.9, hd + 0.3);
      }
      for (let i = 0; i < kz; i++) {
        const mz = -hd + ((i + 0.5) / kz) * pad.d;
        boxN(b[PAL_STONE], -hw - 0.3, h + 0.1, mz - 0.35, -hw + 0.25, h + 0.9, mz + 0.35);
        boxN(b[PAL_STONE], hw - 0.25, h + 0.1, mz - 0.35, hw + 0.3, h + 0.9, mz + 0.35);
      }
      // Corner turrets rising above the roofline, each with a conical cap.
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          cylinder(b[PAL_STONE], sx * hw, 0.08, sz * hd, 0.95, 0.85, h + 1.8, 8, false, false);
          cylinder(b[PAL_STONE], sx * hw, h + 1.8, sz * hd, 1.05, 1.0, 0.3, 8, false, false);
          cone(b[PAL_TIMBER], sx * hw, h + 2.1, sz * hd, 1.05, 1.9, 8, true);
        }
      }
      // Tall double door on the -z face, under a stone hood.
      boxN(b[PAL_TIMBER], -0.95, 0.08, -hd - 0.09, 0.95, 2.7, -hd + 0.02);
      boxN(b[PAL_WOOD], -0.05, 0.08, -hd - 0.12, 0.05, 2.7, -hd - 0.06);
      boxN(b[PAL_STONE], -1.2, 2.62, -hd - 0.2, 1.2, 2.95, -hd + 0.02);
      boxN(b[PAL_STONE], -1.4, 0.02, -hd - 0.9, 1.4, 0.18, -hd - 0.02);
      // Window insets: two rows on the front face.
      for (const wy of [h * 0.44, h * 0.68]) {
        for (const sx of [-1, 1]) {
          boxN(b[PAL_TIMBER],
            sx * hw * 0.52 - 0.28, wy, -hd - 0.05,
            sx * hw * 0.52 + 0.28, wy + 0.8, -hd + 0.02);
          boxN(b[PAL_STONE],
            sx * hw * 0.52 - 0.4, wy - 0.1, -hd - 0.09,
            sx * hw * 0.52 + 0.4, wy + 0.02, -hd + 0.02);
        }
      }
      // Great crimson banner over the door, and a flagpole on the roof.
      boxN(b[PAL_BERRY], -0.75, h - 2.6, -hd - 0.12, 0.75, h - 0.3, -hd - 0.04);
      boxN(b[PAL_WOOL], -0.3, h - 1.9, -hd - 0.15, 0.3, h - 1.1, -hd - 0.09);
      cylinder(b[PAL_WOOD], 0, h + 0.1, 0, 0.075, 0.06, 3.4, 6, false, true);
      boxN(b[PAL_BERRY], 0.04, h + 2.5, -0.03, 1.5, h + 3.3, 0.03);
      // Torches flanking the entrance.
      for (const sxt of [-1, 1]) {
        boxN(b[PAL_TORCH], sxt * 1.55 - 0.12, 2.3, -hd - 0.17, sxt * 1.55 + 0.12, 2.66, -hd - 0.02);
        flames?.push({ x: sxt * 1.55, y: 2.42, z: -hd - 0.1, scale: 1 });
      }
      break;
    }
    case 'stall': {
      // Market stall: round posts, striped awning, counter, goods by variant.
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          cylinder(b[PAL_WOOD],
            sx * (hw - 0.1), -0.5, sz * (hd - 0.1),
            0.075, 0.06, h + 0.5, 6, false, true);
        }
      }
      // Awning: alternating cloth panels sloping to the front.
      const panels = 4;
      for (let i = 0; i < panels; i++) {
        const x0 = -hw - 0.25 + (i / panels) * (pad.w + 0.5);
        const x1 = -hw - 0.25 + ((i + 1) / panels) * (pad.w + 0.5);
        const pal = i % 2 === 0 ? PAL_WOOL : PAL_BERRY;
        boxN(b[pal], x0, h, -hd - 0.15, x1, h + 0.11, hd + 0.15);
        boxN(b[pal], x0, h - 0.26, -hd - 0.62, x1, h + 0.02, -hd - 0.08);
      }
      // Counter across the front, with a trestle.
      bevelBoxN(b[PAL_WOOD], -hw + 0.1, 0.78, -hd - 0.08, hw - 0.1, 0.96, -hd + 0.48);
      for (const sx of [-1, 1]) {
        boxN(b[PAL_TIMBER], sx * (hw - 0.35) - 0.06, 0, -hd + 0.05, sx * (hw - 0.35) + 0.06, 0.78, -hd + 0.35);
      }
      // Goods: produce, cloth bolts or grain sacks.
      if (v === 0) {
        boxN(b[PAL_LEAF], -0.6, 0.96, -hd + 0.02, 0.0, 1.24, -hd + 0.4);
        boxN(b[PAL_BERRY], 0.08, 0.96, -hd + 0.05, 0.6, 1.18, -hd + 0.38);
        boxN(b[PAL_LEAF], -hw + 0.2, 0.0, hd - 0.55, -hw + 0.85, 0.42, hd - 0.05);
      } else if (v === 1) {
        for (let i = 0; i < 3; i++) {
          boxN(b[i % 2 === 0 ? PAL_BERRY : PAL_WOOL],
            -0.7 + i * 0.5, 0.96, -hd + 0.04, -0.32 + i * 0.5, 1.36, -hd + 0.42);
        }
      } else {
        boxN(b[PAL_WOOL], -0.62, 0.96, -hd + 0.04, -0.05, 1.34, -hd + 0.44);
        boxN(b[PAL_WOOL], 0.02, 0.0, hd - 0.7, 0.62, 0.55, hd - 0.1);
        boxN(b[PAL_THATCH], -0.02, 0.96, -hd + 0.06, 0.52, 1.2, -hd + 0.4);
      }
      break;
    }
    case 'lamp': {
      // Torch lamp post: round pole + arm + glowing lantern.
      boxN(b[PAL_STONE], -0.24, -0.4, -0.24, 0.24, 0.14, 0.24);
      cylinder(b[PAL_WOOD], 0, -1, 0, 0.075, 0.06, h + 1, 6, false, true);
      beam(b[PAL_TIMBER], 0, h - 0.05, 0, 0, h - 0.05, -0.4, 0.035, 0.035);
      beam(b[PAL_TIMBER], 0, h - 0.42, 0, 0, h - 0.08, -0.3, 0.03, 0.03);
      boxN(b[PAL_TORCH], -0.11, h - 0.44, -0.45, 0.11, h - 0.1, -0.23);
      boxN(b[PAL_TIMBER], -0.13, h - 0.12, -0.47, 0.13, h - 0.04, -0.21);
      flames?.push({ x: 0, y: h - 0.4, z: -0.34, scale: 0.7 });
      break;
    }
    default: {
      // Exhaustiveness guard: a PadType with no builder renders as nothing
      // at all, which looks like a missing building rather than a bug.
      const unhandled: never = pad.type;
      void unhandled;
      break;
    }
  }
}

/**
 * One settlement → one world-space soup per palette used.
 * Pass `flamesOut` to also collect world-space brazier/torch/lantern anchors
 * for the billboard fire system (render/fire-fx.ts).
 */
export function buildSettlementMeshes(
  s: ResolvedSettlement,
  flamesOut?: SettlementFlame[],
): { palette: number; verts: Float32Array<ArrayBuffer> }[] {
  const buckets: Buckets = emptyBuckets();
  const local: Buckets = emptyBuckets();
  const localFlames: SettlementFlame[] = [];
  // Streets and stairs first, so paving is written before the buildings that
  // stand on it — irrelevant to the depth buffer, but it keeps a settlement's
  // vertex buffer laid out ground-up, which is how it reads in a capture.
  // Already world-space, so unlike pads it does not go through appendYaw.
  buildPathMeshes(s.paths, buckets[PAL_STONE], buckets[PAL_TIMBER]);
  for (const pad of s.pads) {
    for (const key of ALL_PALETTES) local[key].length = 0;
    localFlames.length = 0;
    buildPad(pad, local, flamesOut !== undefined ? localFlames : undefined);
    // Rotate by yaw (quantized 90° steps) then translate to world; appendYaw
    // carries the per-vertex normal along with the position.
    for (const key of ALL_PALETTES) {
      if (local[key].length > 0) {
        appendYaw(buckets[key], local[key], pad.wx, pad.wy, pad.wz, pad.yaw);
      }
    }
    if (flamesOut !== undefined && localFlames.length > 0) {
      // Same transform appendYaw applies to vertices — kept literal here so
      // the two cannot drift apart silently.
      const c = Math.cos(pad.yaw), sn = Math.sin(pad.yaw);
      for (const f of localFlames) {
        flamesOut.push({
          x: f.x * c - f.z * sn + pad.wx,
          y: f.y + pad.wy,
          z: f.x * sn + f.z * c + pad.wz,
          scale: f.scale,
        });
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
