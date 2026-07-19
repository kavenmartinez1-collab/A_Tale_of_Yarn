/**
 * Pure settlement site selection — deterministic per 512 m cell, a function
 * of (seed, scx, scz) and the heightfield only (node-testable, memoize at
 * call sites like dungeon entrances).
 *
 * Roll order per cell: presence (45 %) → kind (ruins 40 / ranch 22 /
 * village 15 / town 13 / castle 10 %) → up to 6 jittered candidates, accepted above the
 * sand line on ground flat enough for the kind (ring of heightAt samples).
 * A candidate near the same cell's dungeon entrance is rejected so arches
 * never poke through buildings (cells are 512 m in both systems).
 */

import { mix32 } from '../dungeon/dungeon-layout';
import { mulberry32 } from '../mesh-utils';
import { entranceSiteAt } from '../dungeon/entrance-site';

export const SCELL = 512;      // settlement-cell edge (m) — matches DCELL
const SALT = 0x5e77c0de;
const PRESENCE = 0.45;         // fraction of cells that attempt a settlement
const CANDIDATES = 8;
const MIN_HEIGHT = 3;          // stay above the sand line (m)
const ENTRANCE_CLEARANCE = 24; // extra gap beyond the settlement radius (m)
const RING_SAMPLES = 8;

export type SettlementKind = 'ruins' | 'ranch' | 'village' | 'town' | 'castle';

export const SETTLEMENT_RADIUS: Record<SettlementKind, number> = {
  ruins: 10, ranch: 20, village: 28, town: 40, castle: 50,
};

/** Max |Δh| across the footprint ring. Generous — buildings sit on platform
 * skirts (C-M3), so big kinds get a bigger budget for their bigger ring. */
const MAX_RING_DH: Record<SettlementKind, number> = {
  ruins: 4, ranch: 4, village: 5, town: 6, castle: 7,
};

export interface SettlementSite {
  kind: SettlementKind;
  x: number;
  y: number;
  z: number;
  radius: number;
  /** Stable per-settlement seed for layout + naming (C-M2). */
  seed: number;
}

function rollKind(r: number): SettlementKind {
  if (r < 0.40) return 'ruins';
  if (r < 0.62) return 'ranch';
  if (r < 0.77) return 'village';
  if (r < 0.90) return 'town';
  return 'castle';
}

/** Per-cell settlement roll. Deterministic; memoize at the call site. */
export function settlementSiteAt(
  seed: number,
  scx: number,
  scz: number,
  heightAt: (x: number, z: number) => number,
): SettlementSite | null {
  const rng = mulberry32(mix32(seed ^ SALT, scx, scz));
  if (rng() >= PRESENCE) return null;
  const kind = rollKind(rng());
  const radius = SETTLEMENT_RADIUS[kind];
  const inset = 64 + radius;
  const entrance = entranceSiteAt(seed, scx, scz, heightAt);

  for (let i = 0; i < CANDIDATES; i++) {
    const x = scx * SCELL + inset + rng() * (SCELL - 2 * inset);
    const z = scz * SCELL + inset + rng() * (SCELL - 2 * inset);
    const h = heightAt(x, z);
    if (h < MIN_HEIGHT) continue;
    // Flatness: ring at 0.7·radius must stay within the kind's Δh budget.
    let maxDh = 0;
    for (let k = 0; k < RING_SAMPLES; k++) {
      const a = (k / RING_SAMPLES) * Math.PI * 2;
      const hr = heightAt(
        x + Math.cos(a) * radius * 0.7, z + Math.sin(a) * radius * 0.7);
      maxDh = Math.max(maxDh, Math.abs(hr - h));
    }
    if (maxDh > MAX_RING_DH[kind]) continue;
    // Keep clear of this cell's dungeon entrance arch.
    if (entrance !== null &&
        Math.hypot(x - entrance.x, z - entrance.z) < radius + ENTRANCE_CLEARANCE) {
      continue;
    }
    return { kind, x, y: h, z, radius, seed: mix32(seed ^ SALT, scz, scx) };
  }
  return null;
}
