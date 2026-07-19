/**
 * Pure settlement layout + naming — a function of (kind, seed) only, so it is
 * node-testable. Produces building pads in settlement-local space (center at
 * origin); resolveSettlement() lifts them to world space against the
 * heightfield (per-pad ground height = max over footprint samples, so
 * buildings never sink; skirt meshes hide the downhill gap).
 *
 * All yaws are quantized to 90° steps: meshes stay axis-aligned after
 * rotation, so collision (C-M4) is plain AABB pushout.
 */

import { mulberry32 } from '../mesh-utils';
import type { SettlementKind, SettlementSite } from './settlement-scatter';

/** Bump when layout logic changes materially (golden hash will change). */
export const LAYOUT_VERSION = 2;

export type PadType =
  | 'house' | 'barn' | 'ruin' | 'well' | 'fence' | 'signpost'
  | 'tower' | 'wall' | 'stable' | 'gatehouse' | 'jail';

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
}

export interface SettlementLayout {
  name: string;
  pads: BuildingPad[];
}

const HALF_PI = Math.PI / 2;

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

/** Quantize to the nearest quarter turn (normalized to 0..3·π/2). */
function quantYaw(yaw: number): number {
  return ((Math.round(yaw / HALF_PI) % 4) + 4) % 4 * HALF_PI;
}

/** Yaw that points a pad's door (-Z side) at the settlement center. */
function faceCenter(angle: number): number {
  return quantYaw(angle - HALF_PI);
}

function ringHouses(
  pads: BuildingPad[], rng: () => number,
  count: number, radius: number, size: number,
): void {
  const base = rng() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const a = base + (i / count) * Math.PI * 2 + (rng() - 0.5) * 0.5;
    pads.push({
      type: 'house',
      x: Math.cos(a) * radius,
      z: Math.sin(a) * radius,
      yaw: faceCenter(a),
      w: size + rng() * 1.0,
      d: size * 0.85 + rng() * 0.8,
      h: 2.4 + rng() * 0.3,
    });
  }
}

/** Deterministic layout for a settlement kind (seed from the scatter site). */
export function layoutSettlement(
  kind: SettlementKind, seed: number,
): SettlementLayout {
  const rng = mulberry32(seed);
  const name = settlementName(kind, rng);
  const pads: BuildingPad[] = [];

  if (kind === 'ruins') {
    const walls = 3 + Math.floor(rng() * 3);
    for (let i = 0; i < walls; i++) {
      const a = rng() * Math.PI * 2;
      const dist = 2 + rng() * 5;
      pads.push({
        type: 'ruin',
        x: Math.cos(a) * dist, z: Math.sin(a) * dist,
        yaw: quantYaw(rng() * Math.PI * 2),
        w: 2 + rng() * 2.5, d: 0.6, h: 0.8 + rng() * 1.4,
      });
    }
    // Rubble: low broken blocks near the middle.
    const rubble = 1 + Math.floor(rng() * 2);
    for (let i = 0; i < rubble; i++) {
      const a = rng() * Math.PI * 2;
      const dist = rng() * 3;
      pads.push({
        type: 'ruin',
        x: Math.cos(a) * dist, z: Math.sin(a) * dist,
        yaw: quantYaw(rng() * Math.PI * 2),
        w: 1 + rng() * 0.8, d: 1 + rng() * 0.8, h: 0.4,
      });
    }
  } else if (kind === 'ranch') {
    const a = rng() * Math.PI * 2;
    pads.push({
      type: 'house',
      x: Math.cos(a) * 8, z: Math.sin(a) * 8,
      yaw: faceCenter(a), w: 4, d: 3.4, h: 2.5,
    });
    const ab = a + Math.PI + (rng() - 0.5);
    pads.push({
      type: 'barn',
      x: Math.cos(ab) * 9, z: Math.sin(ab) * 9,
      yaw: faceCenter(ab), w: 6, d: 4.5, h: 3,
    });
    if (rng() < 0.4) {
      pads.push({
        type: 'well',
        x: (rng() - 0.5) * 4, z: (rng() - 0.5) * 4,
        yaw: 0, w: 1.5, d: 1.5, h: 0.8,
      });
    }
    // Paddock: fenced square beside the barn, with a gap in the south side.
    const px = Math.cos(ab) * 3;
    const pz = Math.sin(ab) * 3;
    const half = 6;
    pads.push(
      { type: 'fence', x: px, z: pz - half, yaw: 0, w: 2 * half, d: 0.15, h: 1 },
      { type: 'fence', x: px - half, z: pz, yaw: HALF_PI, w: 2 * half, d: 0.15, h: 1 },
      { type: 'fence', x: px + half, z: pz, yaw: HALF_PI, w: 2 * half, d: 0.15, h: 1 },
      { type: 'fence', x: px - half / 2 - 0.75, z: pz + half, yaw: 0, w: half - 1.5, d: 0.15, h: 1 },
      { type: 'fence', x: px + half / 2 + 0.75, z: pz + half, yaw: 0, w: half - 1.5, d: 0.15, h: 1 },
    );
    // Stable beside the barn.
    const as2 = ab + HALF_PI;
    pads.push({
      type: 'stable',
      x: Math.cos(ab) * 9 + Math.cos(as2) * 7,
      z: Math.sin(ab) * 9 + Math.sin(as2) * 7,
      yaw: faceCenter(ab), w: 5, d: 3.5, h: 2.6,
    });
  } else if (kind === 'village') {
    pads.push({ type: 'well', x: 0, z: 0, yaw: 0, w: 1.5, d: 1.5, h: 0.8 });
    ringHouses(pads, rng, 5, 13, 3.6);
    // Stable at the edge of the village.
    const as3 = rng() * Math.PI * 2;
    pads.push({
      type: 'stable',
      x: Math.cos(as3) * 20, z: Math.sin(as3) * 20,
      yaw: faceCenter(as3), w: 5, d: 3.5, h: 2.6,
    });
  } else if (kind === 'town') {
    pads.push({ type: 'well', x: 0, z: 0, yaw: 0, w: 1.5, d: 1.5, h: 0.8 });
    ringHouses(pads, rng, 4, 12, 4.0);
    ringHouses(pads, rng, 6, 24, 4.4);
    const ab = rng() * Math.PI * 2;
    pads.push({
      type: 'barn',
      x: Math.cos(ab) * 30, z: Math.sin(ab) * 30,
      yaw: faceCenter(ab), w: 6, d: 4.5, h: 3,
    });
    // Jail on the opposite side from the barn.
    const aj = ab + Math.PI;
    pads.push({
      type: 'jail',
      x: Math.cos(aj) * 28, z: Math.sin(aj) * 28,
      yaw: faceCenter(aj), w: 5, d: 4, h: 3,
    });
  } else {
    // castle
    // Corner towers at ~±32 m on both axes.
    const towerDist = 32;
    const corners = [
      [1, 1], [1, -1], [-1, 1], [-1, -1],
    ] as const;
    for (const [sx, sz] of corners) {
      pads.push({
        type: 'tower',
        x: sx * towerDist, z: sz * towerDist,
        yaw: 0, w: 5, d: 5, h: 8,
      });
    }
    // Curtain walls connecting towers (N/S/E/W segments, leaving gatehouse gap).
    // North wall (z = -towerDist, x runs between towers with a 6 m gatehouse gap).
    const wallLen = towerDist * 2 - 5; // full span minus tower overlap
    pads.push(
      // North half-walls (gap in the middle for gatehouse).
      { type: 'wall', x: -towerDist / 2 - 2, z: -towerDist, yaw: 0, w: wallLen / 2 - 6, d: 1.2, h: 5 },
      { type: 'wall', x:  towerDist / 2 + 2, z: -towerDist, yaw: 0, w: wallLen / 2 - 6, d: 1.2, h: 5 },
      // South wall (solid).
      { type: 'wall', x: 0, z: towerDist, yaw: 0, w: wallLen, d: 1.2, h: 5 },
      // East wall.
      { type: 'wall', x: towerDist, z: 0, yaw: HALF_PI, w: wallLen, d: 1.2, h: 5 },
      // West wall.
      { type: 'wall', x: -towerDist, z: 0, yaw: HALF_PI, w: wallLen, d: 1.2, h: 5 },
    );
    // Gatehouse at the north entrance.
    pads.push({
      type: 'gatehouse',
      x: 0, z: -towerDist,
      yaw: 0, w: 8, d: 6, h: 7,
    });
    // Keep (main hall) in the center.
    pads.push({
      type: 'house',
      x: 0, z: 4,
      yaw: 0, w: 10, d: 8, h: 5,
    });
    // Jail in the south-east corner of the courtyard.
    pads.push({
      type: 'jail',
      x: 16, z: 18,
      yaw: 0, w: 5, d: 4, h: 3,
    });
    // Stable in the north-west of the courtyard.
    pads.push({
      type: 'stable',
      x: -18, z: -12,
      yaw: HALF_PI, w: 6, d: 3.5, h: 2.8,
    });
    // Well in the courtyard.
    pads.push({ type: 'well', x: -6, z: 10, yaw: 0, w: 1.5, d: 1.5, h: 0.8 });
  }

  // Every settlement gets a signpost for the C-M5 welcome interact.
  const sa = rng() * Math.PI * 2;
  const sd = kind === 'ruins' ? 6 : kind === 'castle' ? 8 : 5;
  pads.push({
    type: 'signpost',
    x: Math.cos(sa) * sd, z: Math.sin(sa) * sd,
    yaw: quantYaw(rng() * Math.PI * 2),
    w: 1.1, d: 0.15, h: 2.1,
  });

  return { name, pads };
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
}

/** Rotated half-extents of a yaw-quantized pad (still axis-aligned). */
export function padHalfExtents(pad: BuildingPad): { hx: number; hz: number } {
  const c = Math.abs(Math.cos(pad.yaw));
  const s = Math.abs(Math.sin(pad.yaw));
  return {
    hx: (pad.w / 2) * c + (pad.d / 2) * s,
    hz: (pad.w / 2) * s + (pad.d / 2) * c,
  };
}

/** Lift a layout to world space against the heightfield. */
export function resolveSettlement(
  site: SettlementSite,
  heightAt: (x: number, z: number) => number,
): ResolvedSettlement {
  const { name, pads } = layoutSettlement(site.kind, site.seed);
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
  return { site, name, pads: resolved };
}
