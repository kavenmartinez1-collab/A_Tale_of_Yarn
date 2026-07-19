/**
 * GroundQuery — the walkable-world abstraction the player controller moves
 * against. Two implementations: terrainGround (open-world heightfield) and
 * DungeonCollider (interior cell grid). Swapping controller.world is how the
 * game switches between surface and dungeon collision modes.
 */

import type { HeightField } from './noise';

export interface GroundQuery {
  /** Ground height under a capsule of radius r centered at (x, z). */
  groundHeight(x: number, z: number, r: number): number;
  /** Ceiling height above (x, z); Infinity when unroofed. */
  ceilingHeight(x: number, z: number): number;
  /**
   * Move a capsule of radius r from (x, z) by (dx, dz), sliding along any
   * obstacles. Returns the resulting position.
   */
  moveXZ(x: number, z: number, dx: number, dz: number, r: number): [number, number];
}

/** Open terrain: heightfield ground, no ceiling, unrestricted XZ movement. */
export function terrainGround(hf: HeightField): GroundQuery {
  return {
    // Max of center + 4 ring samples so the capsule edge never clips slopes.
    groundHeight(x, z, r) {
      return Math.max(
        hf.heightAt(x, z),
        hf.heightAt(x + r, z),
        hf.heightAt(x - r, z),
        hf.heightAt(x, z + r),
        hf.heightAt(x, z - r),
      );
    },
    ceilingHeight() {
      return Infinity;
    },
    moveXZ(x, z, dx, dz) {
      return [x + dx, z + dz];
    },
  };
}
