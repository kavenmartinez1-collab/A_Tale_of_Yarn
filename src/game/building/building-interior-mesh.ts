/**
 * Building interior mesh + collider output — produces the same interleaved
 * non-indexed position-only float32x3 vertex format the dungeon mesh uses
 * (12 B/vertex, same pipeline/shader/palette conventions).
 *
 * Also exports collider AABBs in the same {min,max} format as dungeon-collider
 * for drop-in integration with the existing collision path.
 *
 * No DOM or GPU imports — this is node-testable like dungeon-mesh.ts.
 */

import type { BuildingInterior, AABB, FurnitureType } from './building-interior';
import { box, quad } from '../mesh-utils';

// ---- vertex stride (floats per vertex) ------------------------------------

/** 3 floats (x,y,z) per vertex — position-only, same as dungeon mesh. */
export const VERTEX_STRIDE = 3;

// ---- palette indices (must match palette() in shaders/dungeon.wgsl) -------

/** Rich dark furniture wood (bed frames, tables, chairs, shelves). */
export const PAL_FURNITURE_WOOD = 8;
/** Warm fabric/blanket red (blankets, rugs, banners). */
export const PAL_FABRIC = 9;
/** Hearth firebrick dark stone (fireplaces, braziers). */
export const PAL_FIREBRICK = 10;
/** Wool/linen off-white (pillows, mattresses). */
export const PAL_LINEN = 11;
/** Plain stone (throne bases — same palette the dungeon shell uses). */
export const PAL_STONE = 0;

// ---- interior shell mesh --------------------------------------------------

/**
 * Build the interior shell (floor, ceiling, walls with door opening).
 * Winding: right-hand normals face INTO the interior (same convention as
 * dungeon-mesh.ts).
 *
 * `part` selects which shell surfaces to emit so the integration can render
 * the floor with a different palette (wood planks) than the walls/ceiling
 * (plaster). Default 'all' keeps the original single-mesh behavior.
 */
export function buildBuildingInteriorMesh(
  interior: BuildingInterior,
  part: 'all' | 'walls' | 'floor' = 'all',
): Float32Array<ArrayBuffer> {
  const { gridW, gridD, cells, ceilY } = interior;
  const verts: number[] = [];

  const CELL_SOLID = 0;
  const emitFloor = part !== 'walls';
  const emitWalls = part !== 'floor';

  const walkable = (x: number, z: number): boolean =>
    x >= 0 && z >= 0 && x < gridW && z < gridD && cells[z * gridW + x] !== CELL_SOLID;
  const ceilAt = (x: number, z: number): number => ceilY[z * gridW + x];

  for (let z = 0; z < gridD; z++) {
    for (let x = 0; x < gridW; x++) {
      if (!walkable(x, z)) continue;
      const ch = ceilAt(x, z);

      // Floor (+Y normal, facing up into interior)
      if (emitFloor) {
        quad(verts, [x, 0, z], [x, 0, z + 1], [x + 1, 0, z + 1], [x + 1, 0, z]);
      }
      if (!emitWalls) continue;
      // Ceiling (-Y normal, facing down into interior)
      quad(verts, [x, ch, z], [x + 1, ch, z], [x + 1, ch, z + 1], [x, ch, z + 1]);

      // Walls toward solid neighbors (same approach as dungeon-mesh)
      // East (+x direction): wall at plane x+1, facing -X into this cell
      if (!walkable(x + 1, z)) {
        quad(verts, [x + 1, 0, z], [x + 1, 0, z + 1], [x + 1, ch, z + 1], [x + 1, ch, z]);
      } else if (ceilAt(x + 1, z) < ch) {
        const y0 = ceilAt(x + 1, z);
        quad(verts, [x + 1, y0, z], [x + 1, y0, z + 1], [x + 1, ch, z + 1], [x + 1, ch, z]);
      }
      // West (-x direction): wall at plane x, facing +X
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

  return Float32Array.from(verts) as Float32Array<ArrayBuffer>;
}

// ---- furniture prop meshes ------------------------------------------------

/**
 * Build furniture prop geometry. All props use outward-facing CCW winding
 * (visible from outside, like dungeon-props). Coordinates are local to the
 * interior (same space as the shell mesh).
 *
 * Returns a map of palette index to vertex array (indices match
 * palette() in shaders/dungeon.wgsl):
 * - PAL_FURNITURE_WOOD (8): rich wood (bed frame, table, chairs, shelves...)
 * - PAL_FABRIC (9): warm red fabric (blankets, rugs, banners)
 * - PAL_FIREBRICK (10): hearth/brazier firebrick
 * - PAL_LINEN (11): off-white wool/linen (mattress, pillow)
 * - PAL_STONE (0): plain stone (throne base)
 */
export function buildFurnitureMeshes(interior: BuildingInterior): Map<number, Float32Array<ArrayBuffer>> {
  const wood: number[] = [];
  const stone: number[] = [];
  const fabric: number[] = [];
  const brick: number[] = [];
  const linen: number[] = [];

  for (const f of interior.furniture) {
    const { minX, minY, minZ, maxX, maxY, maxZ } = f.aabb;
    switch (f.type) {
      case 'table':
      case 'chair':
      case 'stool':
      case 'shelf':
      case 'counter':
      case 'crate':
      case 'barrel':
        box(wood, minX, minY, minZ, maxX, maxY, maxZ);
        break;
      case 'bed': {
        // Dark wood frame with corner posts, linen mattress + pillow,
        // warm red blanket over the lower two-thirds.
        const frameTop = minY + (maxY - minY) * 0.45;   // ~0.25
        const matTop = minY + (maxY - minY) * 0.75;     // ~0.41
        // Frame slab + headboard (at minZ end) + 4 posts
        box(wood, minX, minY, minZ, maxX, frameTop, maxZ);
        box(wood, minX, minY, minZ, maxX, maxY + 0.25, minZ + 0.08);
        const post = 0.07;
        for (const [px, pz] of [
          [minX, minZ], [maxX - post, minZ],
          [minX, maxZ - post], [maxX - post, maxZ - post],
        ]) {
          box(wood, px, minY, pz, px + post, maxY + 0.05, pz + post);
        }
        // Mattress (linen) inset on the frame
        box(linen, minX + 0.06, frameTop, minZ + 0.10, maxX - 0.06, matTop, maxZ - 0.06);
        // Pillow (linen) at the headboard end, slightly proud
        box(linen, minX + 0.12, matTop, minZ + 0.14,
          maxX - 0.12, matTop + 0.12, minZ + 0.52);
        // Blanket (warm red) covering the foot two-thirds, draped over sides
        box(fabric, minX + 0.02, matTop - 0.02, minZ + 0.62,
          maxX - 0.02, matTop + 0.08, maxZ - 0.04);
        break;
      }
      case 'hearth': {
        // Open fireplace: firebrick hearth slab, back wall, side cheeks and
        // lintel — leaves a firebox opening facing +Z (into the room) where
        // buildLightProps places logs + flames.
        const t = 0.15;
        box(brick, minX, minY, minZ, maxX, minY + 0.12, maxZ);          // slab
        box(brick, minX, minY, minZ, maxX, maxY, minZ + t);             // back
        box(brick, minX, minY, minZ, minX + t, maxY, maxZ);             // left cheek
        box(brick, maxX - t, minY, minZ, maxX, maxY, maxZ);             // right cheek
        box(brick, minX, maxY - 0.12, minZ, maxX, maxY, maxZ);          // lintel
        break;
      }
      case 'brazier':
        // Firebrick bowl on a narrower pedestal
        box(brick, minX + 0.08, minY, minZ + 0.08, maxX - 0.08, maxY - 0.25, maxZ - 0.08);
        box(brick, minX, maxY - 0.25, minZ, maxX, maxY, maxZ);
        break;
      case 'throne':
        // Base stone, back rich wood
        {
          const midY = minY + (maxY - minY) * 0.4;
          box(stone, minX, minY, minZ, maxX, midY, maxZ);
          box(wood, minX + 0.1, midY, minZ, maxX - 0.1, maxY, minZ + 0.2);
        }
        break;
      case 'banner':
        // Pole is wood, fabric hangs
        {
          const cx = (minX + maxX) / 2;
          const cz = (minZ + maxZ) / 2;
          box(wood, cx - 0.03, minY, cz - 0.03, cx + 0.03, maxY, cz + 0.03);
          box(fabric, minX, minY + (maxY - minY) * 0.3, minZ, maxX, maxY - 0.1, maxZ);
        }
        break;
      case 'rug':
        box(fabric, minX, minY, minZ, maxX, maxY, maxZ);
        break;
      case 'candle':
        box(linen, minX, minY, minZ, maxX, maxY, maxZ);
        break;
    }
  }

  const result = new Map<number, Float32Array<ArrayBuffer>>();
  const setIf = (pal: number, verts: number[]) => {
    if (verts.length > 0) {
      result.set(pal, Float32Array.from(verts) as Float32Array<ArrayBuffer>);
    }
  };
  setIf(PAL_FURNITURE_WOOD, wood);
  setIf(PAL_STONE, stone);
  setIf(PAL_FABRIC, fabric);
  setIf(PAL_FIREBRICK, brick);
  setIf(PAL_LINEN, linen);
  return result;
}

// ---- torch/light prop meshes (reusing dungeon torch palette conventions) --

export interface BuildingLightProps {
  /** Handle geometry (palette 1, wood — same as dungeon torches). */
  wood: Float32Array<ArrayBuffer>;
  /** Flame/glow geometry (palette 2, emissive — same as dungeon). */
  flame: Float32Array<ArrayBuffer>;
  /** Point-light positions (local), for the lights uniform buffer. */
  lights: [number, number, number][];
}

/**
 * Build light-source prop meshes (torch sconces, hearth fires, brazier
 * flames, candles). Uses the same palettes as dungeon torches (1=wood,
 * 2=emissive flame — the shader flickers palette 2) for shader reuse.
 *
 * One entry is pushed to `lights` per interior.lights element, in order, so
 * the integration can look up color/radius by index.
 */
export function buildLightProps(interior: BuildingInterior): BuildingLightProps {
  const wood: number[] = [];
  const flame: number[] = [];
  const lights: [number, number, number][] = [];

  const findFurnitureAt = (x: number, z: number, types: FurnitureType[]) =>
    interior.furniture.find((f) => types.includes(f.type) &&
      x >= f.aabb.minX - 0.1 && x <= f.aabb.maxX + 0.1 &&
      z >= f.aabb.minZ - 0.1 && z <= f.aabb.maxZ + 0.1);

  for (const light of interior.lights) {
    const { x, y, z } = light;
    switch (light.kind) {
      case 'hearth': {
        // Fire inside the firebox opening (hearth mesh leaves it open on +Z):
        // crossed logs + a jittered flame cluster + a glowing ember bed.
        const hearth = findFurnitureAt(x, z, ['hearth']);
        const floorY = hearth ? hearth.aabb.minY + 0.12 : y - 0.4;
        // Logs (rich wood look comes from lighting; palette 1 wood is fine)
        box(wood, x - 0.30, floorY, z - 0.10, x + 0.30, floorY + 0.11, z + 0.02);
        box(wood, x - 0.11, floorY, z - 0.20, x + 0.01, floorY + 0.11, z + 0.16);
        // Ember bed (emissive, low and wide)
        box(flame, x - 0.32, floorY - 0.01, z - 0.16, x + 0.32, floorY + 0.05, z + 0.12);
        // Flame cluster (emissive palette 2 — shader flickers it)
        box(flame, x - 0.17, floorY + 0.06, z - 0.12, x + 0.09, floorY + 0.42, z + 0.08);
        box(flame, x - 0.03, floorY + 0.10, z - 0.08, x + 0.20, floorY + 0.52, z + 0.10);
        box(flame, x - 0.24, floorY + 0.08, z - 0.05, x - 0.05, floorY + 0.34, z + 0.12);
        box(flame, x - 0.06, floorY + 0.28, z - 0.04, x + 0.06, floorY + 0.55, z + 0.06);
        lights.push([x, floorY + 0.40, z]);
        break;
      }
      case 'brazier': {
        // Flame licking out of the brazier bowl (body is furniture).
        const brazier = findFurnitureAt(x, z, ['brazier']);
        const topY = brazier ? brazier.aabb.maxY : y;
        box(flame, x - 0.14, topY - 0.06, z - 0.14, x + 0.14, topY + 0.26, z + 0.14);
        box(flame, x - 0.06, topY + 0.14, z - 0.06, x + 0.08, topY + 0.52, z + 0.06);
        lights.push([x, topY + 0.25, z]);
        break;
      }
      case 'candle': {
        // Small wax stick with a tiny emissive tip.
        box(wood, x - 0.03, y - 0.12, z - 0.03, x + 0.03, y, z + 0.03);
        box(flame, x - 0.045, y, z - 0.045, x + 0.045, y + 0.09, z + 0.045);
        lights.push([x, y + 0.05, z]);
        break;
      }
      default: {
        // Wall torch sconce: wood stick + flame box (same dims as dungeon)
        box(wood, x - 0.04, y - 0.5, z - 0.04, x + 0.04, y, z + 0.04);
        box(flame, x - 0.09, y, z - 0.09, x + 0.09, y + 0.18, z + 0.09);
        lights.push([x, y + 0.09, z]);
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
 * Get all collider AABBs in the same format used by dungeon-collider (min/max
 * triples). Integration can feed these directly to the existing AABB pushout.
 */
export function getColliderAABBs(interior: BuildingInterior): AABB[] {
  return interior.colliders;
}
