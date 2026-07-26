/**
 * Pure settlement site selection — deterministic per 512 m cell, a function
 * of (seed, scx, scz) and the heightfield only (node-testable, memoize at
 * call sites like dungeon entrances).
 *
 * Roll order per cell: presence (45 %) → kind (ruins 40 / ranch 22 /
 * village 15 / town 13 / castle 10 %) → up to 8 jittered candidates, accepted above the
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

/**
 * Footprint radius per kind. This is not decoration: tree and resource
 * scatter carve a clearing of `radius + 3`, so it has to cover the furthest
 * pad or a mill ends up inside an oak. The castle grew from 50 to 68 when it
 * gained a *town* outside its north gate — the approach street, market and
 * churchyard now reach ~66 m from the centre.
 */
export const SETTLEMENT_RADIUS: Record<SettlementKind, number> = {
  ruins: 10, ranch: 20, village: 28, town: 40, castle: 68,
};

/** Max |Δh| across the footprint ring. Generous — buildings sit on platform
 * skirts (C-M3), so big kinds get a bigger budget for their bigger ring.
 * The castle's ring is sampled at 0.7·68 = 47.6 m, over ground that is
 * naturally less flat than a 35 m ring, so its budget rose with its radius:
 * every pad is grounded independently, so undulation costs nothing but the
 * skirt depth. */
const MAX_RING_DH: Record<SettlementKind, number> = {
  ruins: 4, ranch: 4, village: 5, town: 6, castle: 9,
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

/**
 * Forced sites: cells whose settlement is pinned to an exact kind + position,
 * replacing whatever the cell would roll. Used to guarantee a castle town
 * within walking distance of world spawn so every feature (guards, crime,
 * trade, first-visit questioning...) is testable right at the start.
 *
 * Position was validated offline against seed 1337: h=10.7 m (above sand),
 * ring Δh=4.3 m (castle budget 9), 143 m clear of the cell's dungeon
 * entrance, ~260 m from spawn (32, 32).
 */
const FORCED_SITES = new Map<string, { kind: SettlementKind; x: number; z: number }>([
  ['-1,0', { kind: 'castle', x: -191, z: 166 }],
]);

/** Per-cell settlement roll. Deterministic; memoize at the call site. */
export function settlementSiteAt(
  seed: number,
  scx: number,
  scz: number,
  heightAt: (x: number, z: number) => number,
): SettlementSite | null {
  const forced = FORCED_SITES.get(`${scx},${scz}`);
  if (forced !== undefined) {
    return {
      kind: forced.kind,
      x: forced.x,
      y: heightAt(forced.x, forced.z),
      z: forced.z,
      radius: SETTLEMENT_RADIUS[forced.kind],
      seed: mix32(seed ^ SALT, scz, scx),
    };
  }
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
