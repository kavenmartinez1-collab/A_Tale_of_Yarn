/**
 * Pure dungeon-entrance site selection — a function of (seed, dcx, dcz) and
 * the heightfield only, so it is node-testable and reusable by other scatter
 * systems (settlements exclude sites near dungeon entrances).
 *
 * The world is tiled into 512 m dungeon cells; 60 % of cells roll an
 * entrance, up to 6 jittered candidates each, accepted only above the sand
 * line (heightAt ≥ 3) on gentle slopes (Δh ≤ 2 m over ±2 m).
 */

import { mix32 } from './dungeon-layout';
import { mulberry32 } from '../mesh-utils';

export const DCELL = 512;      // dungeon-cell edge (m)
const PRESENCE = 0.6;          // fraction of cells that attempt an entrance
const CANDIDATES = 6;          // jittered site attempts per cell
const MIN_HEIGHT = 3;          // entrances stay above the sand line (m)
const MAX_SLOPE_DH = 2;        // max |Δh| over ±2 m at the site (m)

export interface EntranceSite {
  x: number;
  y: number;
  z: number;
}

/** Per-cell entrance roll. Deterministic; memoize at the call site. */
export function entranceSiteAt(
  seed: number,
  dcx: number,
  dcz: number,
  heightAt: (x: number, z: number) => number,
): EntranceSite | null {
  const rng = mulberry32(mix32(seed ^ 0x5ca77e12, dcx, dcz));
  if (rng() >= PRESENCE) return null;
  for (let i = 0; i < CANDIDATES; i++) {
    const x = dcx * DCELL + 64 + rng() * (DCELL - 128);
    const z = dcz * DCELL + 64 + rng() * (DCELL - 128);
    const h = heightAt(x, z);
    if (h < MIN_HEIGHT) continue;
    const dh = Math.max(
      Math.abs(h - heightAt(x + 2, z)),
      Math.abs(h - heightAt(x - 2, z)),
      Math.abs(h - heightAt(x, z + 2)),
      Math.abs(h - heightAt(x, z - 2)),
    );
    if (dh > MAX_SLOPE_DH) continue;
    return { x, y: h, z };
  }
  return null;
}
