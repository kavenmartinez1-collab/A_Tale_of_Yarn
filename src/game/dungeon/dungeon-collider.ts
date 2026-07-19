/**
 * DungeonCollider — GroundQuery over a DungeonLayout cell grid, positioned at
 * a world-space origin (the slot arena the interior mesh is drawn at).
 *
 * Floors are flat at origin.y; ceilings come from the per-cell ceilY. XZ
 * movement is axis-separated slide against solid cells: the capsule's AABB
 * (radius 0.35 m, ≤0.17 m per fixed step, cells 1 m) can only overlap ≤4
 * cells, so a simple per-axis accept/reject never tunnels — no CCD needed.
 */

import type { GroundQuery } from '../collision';
import type { Vec3 } from '../math';
import type { DungeonLayout } from './dungeon-layout';
import { CELL_SOLID } from './dungeon-layout';

const CAM_STEP = 0.25;   // camera occlusion march step (m)
const CAM_MIN_DIST = 0.5; // never pull the eye closer than this to the target

export class DungeonCollider implements GroundQuery {
  constructor(
    private readonly layout: DungeonLayout,
    readonly origin: Vec3,
  ) {}

  private walkable(cx: number, cz: number): boolean {
    const { w, h, cells } = this.layout;
    return cx >= 0 && cz >= 0 && cx < w && cz < h && cells[cz * w + cx] !== CELL_SOLID;
  }

  /** True when a capsule of radius r at LOCAL (x, z) overlaps a solid cell. */
  private blocked(x: number, z: number, r: number): boolean {
    const x0 = Math.floor(x - r);
    const x1 = Math.floor(x + r);
    const z0 = Math.floor(z - r);
    const z1 = Math.floor(z + r);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (!this.walkable(cx, cz)) return true;
      }
    }
    return false;
  }

  groundHeight(): number {
    // Interior floors are flat; walls (moveXZ) keep the capsule over them.
    return this.origin[1];
  }

  ceilingHeight(x: number, z: number): number {
    const cx = Math.floor(x - this.origin[0]);
    const cz = Math.floor(z - this.origin[2]);
    if (!this.walkable(cx, cz)) return Infinity; // unreachable in practice
    return this.origin[1] + this.layout.ceilY[cz * this.layout.w + cx];
  }

  moveXZ(x: number, z: number, dx: number, dz: number, r: number): [number, number] {
    const lx = x - this.origin[0];
    const lz = z - this.origin[2];
    let nx = lx;
    if (!this.blocked(lx + dx, lz, r)) nx = lx + dx;
    let nz = lz;
    if (!this.blocked(nx, lz + dz, r)) nz = lz + dz;
    return [nx + this.origin[0], nz + this.origin[2]];
  }

  /**
   * Pull the orbit-camera eye toward the target until it stops occluding
   * through walls, then clamp its height inside the local floor/ceiling band.
   */
  clampCameraEye(target: Vec3, desired: Vec3): Vec3 {
    const dx = desired[0] - target[0];
    const dy = desired[1] - target[1];
    const dz = desired[2] - target[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-6) return [...desired] as Vec3;

    let t = dist;
    const steps = Math.ceil(dist / CAM_STEP);
    for (let i = 1; i <= steps; i++) {
      const s = Math.min(i * CAM_STEP, dist);
      const px = target[0] + (dx / dist) * s - this.origin[0];
      const pz = target[2] + (dz / dist) * s - this.origin[2];
      if (!this.walkable(Math.floor(px), Math.floor(pz))) {
        t = Math.max(CAM_MIN_DIST, s - CAM_STEP);
        break;
      }
    }

    const eye: Vec3 = [
      target[0] + (dx / dist) * t,
      target[1] + (dy / dist) * t,
      target[2] + (dz / dist) * t,
    ];
    const cx = Math.floor(eye[0] - this.origin[0]);
    const cz = Math.floor(eye[2] - this.origin[2]);
    const ceil = this.walkable(cx, cz)
      ? this.origin[1] + this.layout.ceilY[cz * this.layout.w + cx]
      : this.origin[1] + 3;
    eye[1] = Math.max(this.origin[1] + 0.3, Math.min(ceil - 0.2, eye[1]));
    return eye;
  }
}
