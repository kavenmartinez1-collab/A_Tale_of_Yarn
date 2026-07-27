/**
 * Pure settlement layout + naming — a function of (kind, seed) only, so it is
 * node-testable. Produces building pads in settlement-local space (center at
 * origin); resolveSettlement() lifts them to world space against the
 * heightfield (per-pad ground height = max over footprint samples, so
 * buildings never sink; skirt meshes hide the downhill gap).
 *
 * All yaws are quantized to 90° steps: meshes stay axis-aligned after
 * rotation, so collision (C-M4) is plain AABB pushout.
 *
 * The *composition* — what stands where, which way it faces, what a village
 * has that a ranch does not — lives in settlement-plans.ts. This file owns
 * the vocabulary, the naming and the world-space resolve.
 */

import { mulberry32 } from '../mesh-utils';
import type { SettlementKind, SettlementSite } from './settlement-scatter';
import { padHalfExtents, planFor } from './settlement-plans';
import {
  buildSettlementPaths, EMPTY_PATHS, type ResolvedPaths,
} from './settlement-paths';

export {
  castleGateLocal, faceDir, faceCenter, quantYaw, padHalfExtents,
} from './settlement-plans';

/** Bump when layout logic changes materially (golden hash will change). */
export const LAYOUT_VERSION = 4;

/**
 * The built vocabulary of the world.
 *
 * Structures: `house` `townhouse` `barn` `church` `tavern` `longhouse`
 * `smithy` `mill` `granary` `stable` `jail` `keep` `tower` `wall`
 * `gatehouse` `ruin`.
 * Furniture and works: `well` `stall` `lamp` `fence` `signpost` `trough`
 * `brazier` `banner` `pillory` `shrine` `graves`.
 * Ground and clutter: `crops` `hedge` `haystack` `woodpile` `cart`
 * `washline` `barrels`.
 */
export type PadType =
  | 'house' | 'townhouse' | 'barn' | 'ruin' | 'well' | 'fence' | 'signpost'
  | 'tower' | 'wall' | 'stable' | 'gatehouse' | 'jail'
  | 'keep' | 'stall' | 'lamp'
  | 'church' | 'tavern' | 'longhouse' | 'smithy' | 'mill' | 'granary'
  | 'cart' | 'woodpile' | 'haystack' | 'crops' | 'graves' | 'washline'
  | 'trough' | 'brazier' | 'banner' | 'pillory' | 'shrine' | 'hedge'
  | 'barrels';

export interface BuildingPad {
  type: PadType;
  /** Center offset from the settlement center (m). */
  x: number;
  z: number;
  /** Quantized to k·π/2; local -Z (the door side) faces this way. */
  yaw: number;
  /** Footprint before rotation: w along local x, d along local z (m). */
  w: number;
  d: number;
  /** Wall/feature height (m). */
  h: number;
  /**
   * Small deterministic variant index (0..2). Picks cladding, roof material,
   * cart load, hedge flowering and so on — variety that costs no geometry
   * and no extra pad, which is the only kind a street of eight houses can
   * afford. Absent on pads built before the variant pass; treat as 0.
   */
  v?: number;
}

export interface SettlementLayout {
  name: string;
  pads: BuildingPad[];
}

const NAME_PREFIX = [
  'Oak', 'Stone', 'Ash', 'Fen', 'Wolf', 'Bright',
  'Mill', 'Raven', 'Elder', 'Thorn', 'Green', 'Harrow',
];
const NAME_SUFFIX = [
  'ford', 'brook', 'stead', 'holm', 'wick', 'field', 'gate', 'moor',
];

/**
 * Word-table naming. `provider` is the seam for the Director to supply names
 * later (return null to fall through to the tables) — NOT wired this phase.
 */
export function settlementName(
  kind: SettlementKind,
  rng: () => number,
  provider?: (kind: SettlementKind) => string | null,
): string {
  const fromProvider = provider?.(kind);
  if (fromProvider) return fromProvider;
  const base =
    NAME_PREFIX[Math.floor(rng() * NAME_PREFIX.length)] +
    NAME_SUFFIX[Math.floor(rng() * NAME_SUFFIX.length)];
  if (kind === 'ruins') return `Ruins of ${base}`;
  if (kind === 'ranch') return `${base} Ranch`;
  return base;
}

/** Deterministic layout for a settlement kind (seed from the scatter site). */
export function layoutSettlement(
  kind: SettlementKind, seed: number,
): SettlementLayout {
  const rng = mulberry32(seed);
  const name = settlementName(kind, rng);
  return { name, pads: planFor(kind, rng) };
}

// --- world-space resolution --------------------------------------------------

export interface ResolvedPad extends BuildingPad {
  /** World-space pad center + ground height (max over footprint samples). */
  wx: number;
  wy: number;
  wz: number;
}

export interface ResolvedSettlement {
  site: SettlementSite;
  name: string;
  pads: ResolvedPad[];
  /**
   * Streets, stairs and terraces joining the pads (settlement-paths.ts).
   *
   * Resolved here rather than by the caller because it needs exactly what this
   * function already has — the pads, their floor heights, and the heightfield —
   * and because both consumers (mesh and collider) must see the SAME network
   * or the player walks on a staircase that is not the one being drawn.
   */
  paths: ResolvedPaths;
}

/** Lift a layout to world space against the heightfield. */
export function resolveSettlement(
  site: SettlementSite,
  heightAt: (x: number, z: number) => number,
): ResolvedSettlement {
  // A forced site may pin its display name (the spawn town stays "Greenholm"
  // wherever the river fix moves its pin — the player's mental map and every
  // bug report use that name). Layout still derives pads from the seed.
  const { name: rolled, pads } = layoutSettlement(site.kind, site.seed);
  const name = site.name ?? rolled;
  const resolved: ResolvedPad[] = pads.map((pad) => {
    const wx = site.x + pad.x;
    const wz = site.z + pad.z;
    const { hx, hz } = padHalfExtents(pad);
    // Highest footprint corner keeps floors above ground on slopes.
    const wy = Math.max(
      heightAt(wx, wz),
      heightAt(wx - hx, wz - hz), heightAt(wx + hx, wz - hz),
      heightAt(wx - hx, wz + hz), heightAt(wx + hx, wz + hz),
    );
    return { ...pad, wx, wy, wz };
  });
  // Ruins get no circulation: a collapsed hall has no doors to join, and the
  // one or two spurs a shrine and a well would produce look like municipal
  // works in a place that has been empty for a century.
  const paths = site.kind === 'ruins'
    ? EMPTY_PATHS
    : buildSettlementPaths(site, resolved, resolved.map((p) => p.wy), heightAt);
  return { site, name, pads: resolved, paths };
}
