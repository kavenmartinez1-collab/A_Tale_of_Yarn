/**
 * Dungeon prop meshes — torches, chests, the exit portal, and the surface
 * entrance structure. All non-indexed position-only float32x3 (same vertex
 * layout as the interior mesh); the palette rides each draw's object uniform
 * w, so props are batched per palette, not per prop.
 *
 * Winding: outward-facing CCW (right-hand normal from (b-a)x(c-a)) — props
 * are seen from outside, unlike the inward-wound interior shell.
 *
 * Coordinates are dungeon-local (or entrance-local for the surface arch);
 * the world offset rides the per-draw object uniform.
 */

import type { DungeonLayout } from './dungeon-layout';
import { box, quad } from '../mesh-utils';

/** Flame-center XZ for a torch cell hugging wallDir (0 N,1 E,2 S,3 W). */
function torchXZ(cell: [number, number], wallDir: number): [number, number] {
  const [x, z] = cell;
  if (wallDir === 0) return [x + 0.5, z + 0.12];
  if (wallDir === 1) return [x + 0.88, z + 0.5];
  if (wallDir === 2) return [x + 0.5, z + 0.88];
  return [x + 0.12, z + 0.5];
}

/**
 * The point on the wall PLANE behind a torch, and the unit normal pointing
 * from that plane into the room.
 *
 * `torchXZ` returns a point 12 cm clear of the wall, which is where the flame
 * belongs and where the point light has always been. What was missing is
 * anything joining the two: the torch was a 8 x 8 cm stick from y 1.15 to 1.65
 * standing in mid-air with a 8 cm gap behind it and nothing under it. Cells are
 * 1 m, so the wall plane is the cell edge in the wall direction.
 */
function torchWall(cell: [number, number], wallDir: number):
{ wx: number; wz: number; nx: number; nz: number } {
  const [x, z] = cell;
  if (wallDir === 0) return { wx: x + 0.5, wz: z, nx: 0, nz: 1 };
  if (wallDir === 1) return { wx: x + 1, wz: z + 0.5, nx: -1, nz: 0 };
  if (wallDir === 2) return { wx: x + 0.5, wz: z + 1, nx: 0, nz: -1 };
  return { wx: x, wz: z + 0.5, nx: 1, nz: 0 };
}

export interface TorchProps {
  /** Handle geometry (palette 1, wood). */
  wood: Float32Array<ArrayBuffer>;
  /**
   * Emissive flame geometry (palette 2). Now only a small glowing wick nub:
   * the visible flame is an additive billboard emitted per frame by
   * render/fire-fx.ts at the point-light position below. The nub stays so a
   * torch still reads as lit from any angle even before the billboard pass.
   */
  flame: Float32Array<ArrayBuffer>;
  /** Point-light positions (local), one per torch, at the flame center. */
  lights: [number, number, number][];
}

export function buildTorchProps(layout: DungeonLayout): TorchProps {
  const wood: number[] = [];
  const flame: number[] = [];
  const lights: [number, number, number][] = [];
  for (const t of layout.torches) {
    const [x, z] = torchXZ(t.cell, t.wallDir);
    const { wx, wz, nx, nz } = torchWall(t.cell, t.wallDir);
    // Along-wall unit vector. Both this and the normal are axis-aligned, so a
    // wall-relative box is still an axis-aligned box.
    const ax = -nz;
    const az = nx;
    /**
     * A box in wall coordinates: `u` runs along the wall from the torch's
     * centre line, `v` out from the wall plane.
     */
    const wallBox = (u0: number, v0: number, y0: number,
      u1: number, v1: number, y1: number): void => {
      const px0 = wx + ax * u0 + nx * v0; const pz0 = wz + az * u0 + nz * v0;
      const px1 = wx + ax * u1 + nx * v1; const pz1 = wz + az * u1 + nz * v1;
      box(wood, Math.min(px0, px1), y0, Math.min(pz0, pz1),
        Math.max(px0, px1), y1, Math.max(pz0, pz1));
    };
    // Back plate, 2 cm proud of the wall rather than flush with it: the shell's
    // wall quad is in exactly that plane, and two coplanar faces in two
    // palettes is the depth-test tie this codebase keeps re-learning about.
    wallBox(-0.09, 0.02, 1.10, 0.09, 0.06, 1.44);
    // Bracket arm from the plate out under the socket.
    wallBox(-0.025, 0.05, 1.19, 0.025, 0.15, 1.25);
    // Socket collar the shaft stands in.
    wallBox(-0.06, 0.06, 1.15, 0.06, 0.18, 1.31);
    // Shaft.
    wallBox(-0.035, 0.085, 1.22, 0.035, 0.155, 1.66);
    box(flame, x - 0.035, 1.65, z - 0.035, x + 0.035, 1.71, z + 0.035);
    lights.push([x, 1.72, z]);
  }
  return {
    wood: Float32Array.from(wood) as Float32Array<ArrayBuffer>,
    flame: Float32Array.from(flame) as Float32Array<ArrayBuffer>,
    lights,
  };
}

/** Glowing exit-portal panel on the entrance-room wall, facing into the room. */
export function buildPortalMesh(layout: DungeonLayout): Float32Array<ArrayBuffer> {
  const verts: number[] = [];
  const [x, z] = layout.exitPortalCell;
  const dir = layout.exitWallDir;
  const y0 = 0.1;
  const y1 = 2.3;
  if (dir === 0) {
    // Wall at z, panel faces +Z (south, into the room).
    const zp = z + 0.05;
    quad(verts, [x + 0.1, y0, zp], [x + 0.9, y0, zp], [x + 0.9, y1, zp], [x + 0.1, y1, zp]);
  } else if (dir === 1) {
    // Wall at x+1, faces -X.
    const xp = x + 0.95;
    quad(verts, [xp, y0, z + 0.1], [xp, y1, z + 0.1], [xp, y1, z + 0.9], [xp, y0, z + 0.9]);
  } else if (dir === 2) {
    // Wall at z+1, faces -Z.
    const zp = z + 0.95;
    quad(verts, [x + 0.9, y0, zp], [x + 0.1, y0, zp], [x + 0.1, y1, zp], [x + 0.9, y1, zp]);
  } else {
    // Wall at x, faces +X.
    const xp = x + 0.05;
    quad(verts, [xp, y0, z + 0.1], [xp, y0, z + 0.9], [xp, y1, z + 0.9], [xp, y1, z + 0.1]);
  }
  return Float32Array.from(verts) as Float32Array<ArrayBuffer>;
}

/**
 * Closed chest, centered on the local origin, sitting on y=0. World position
 * (cell center) rides the object uniform; palette wood → stone when looted.
 */
export function buildChestMesh(): Float32Array<ArrayBuffer> {
  const verts: number[] = [];
  box(verts, -0.32, 0, -0.22, 0.32, 0.35, 0.22);       // body
  box(verts, -0.34, 0.35, -0.24, 0.34, 0.5, 0.24);     // lid
  return Float32Array.from(verts) as Float32Array<ArrayBuffer>;
}

/**
 * Surface entrance arch (palette 100, sun-lit stone), centered on the local
 * origin with feet at y=0: two pillars + lintel. Sized so the player can
 * stand at the glowing doorway within interact reach.
 */
export function buildEntranceStoneMesh(): Float32Array<ArrayBuffer> {
  const verts: number[] = [];
  box(verts, -1.4, -0.6, -0.45, -0.8, 3.0, 0.45);      // west pillar
  box(verts, 0.8, -0.6, -0.45, 1.4, 3.0, 0.45);        // east pillar
  box(verts, -1.6, 3.0, -0.55, 1.6, 3.6, 0.55);        // lintel
  return Float32Array.from(verts) as Float32Array<ArrayBuffer>;
}

/** Portal glow between the pillars (palette 103) — visible from both sides. */
export function buildEntranceGlowMesh(): Float32Array<ArrayBuffer> {
  const verts: number[] = [];
  const y0 = 0;
  const y1 = 2.9;
  // Two back-to-back quads so the doorway glows front and back.
  quad(verts, [-0.8, y0, 0.02], [0.8, y0, 0.02], [0.8, y1, 0.02], [-0.8, y1, 0.02]);
  quad(verts, [0.8, y0, -0.02], [-0.8, y0, -0.02], [-0.8, y1, -0.02], [0.8, y1, -0.02]);
  return Float32Array.from(verts) as Float32Array<ArrayBuffer>;
}
