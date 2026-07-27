/**
 * Settlement composition — what gets built where, per kind.
 *
 * The old layouts were rings: houses scattered on a circle around a well.
 * A ring of buildings all facing inward reads as a stockade, not a village,
 * because real settlements are organised by *lines* — a street with fronts on
 * both sides, a square with the important buildings around it, a boundary
 * that things are inside or outside of. Everything here is laid out on those
 * lines, then the whole plan is rotated by a whole quarter-turn so it is not
 * always oriented the same way. Yaws stay 90°-quantized (collision is plain
 * AABB), and the quarter-turn rotation preserves that exactly.
 *
 * Placement rules the layouts follow:
 *  - The church is the landmark: it terminates a street or fronts the square,
 *    and its spire is the tallest thing that is not a castle.
 *  - The well sits in the open with things facing it.
 *  - The smithy is at the edge — fire and noise.
 *  - Crops, hedges and graves are *outside* the built-up part, which is what
 *    gives a settlement an edge instead of just petering out.
 *  - Props go where the work is: a cart by a barn, a woodpile against a
 *    gable, washing behind a house, barrels outside a tavern.
 */

import type { BuildingPad, PadType } from './settlement-layout';
import type { SettlementKind } from './settlement-scatter';

const HALF_PI = Math.PI / 2;

/** Door faces -Z. */
export const FACE_N = 0;
/** Door faces +X. */
export const FACE_E = HALF_PI;
/** Door faces +Z. */
export const FACE_S = Math.PI;
/** Door faces -X. */
export const FACE_W = 3 * HALF_PI;

/** Quantize to the nearest quarter turn (normalized to 0..3·π/2). */
export function quantYaw(yaw: number): number {
  return ((Math.round(yaw / HALF_PI) % 4) + 4) % 4 * HALF_PI;
}

/** Yaw that points a pad's door (-Z side) at the settlement center. */
export function faceCenter(angle: number): number {
  return quantYaw(angle - HALF_PI);
}

/** Yaw whose door faces the direction (dx, dz). */
export function faceDir(dx: number, dz: number): number {
  return quantYaw(Math.atan2(dx, -dz));
}

/**
 * Rotated half-extents of a yaw-quantized pad (still axis-aligned).
 *
 * Lives here rather than in settlement-layout, which is where it used to be
 * and where it is still re-exported from, because settlement-paths needs it
 * and settlement-layout needs settlement-paths: leaving it there made the two
 * modules import each other. The cycle happened to work — `padHalfExtents` is
 * a hoisted function declaration, so the half-initialised namespace still had
 * it — but a cycle that survives only because of hoisting is one refactor away
 * from an undefined-is-not-a-function at settlement build time. This file is
 * already the home of the pad geometry vocabulary and imports nothing back.
 */
export function padHalfExtents(pad: BuildingPad): { hx: number; hz: number } {
  const c = Math.abs(Math.cos(pad.yaw));
  const s = Math.abs(Math.sin(pad.yaw));
  return {
    hx: (pad.w / 2) * c + (pad.d / 2) * s,
    hz: (pad.w / 2) * s + (pad.d / 2) * c,
  };
}

type Put = (
  type: PadType, x: number, z: number, yaw: number,
  w: number, d: number, h: number, v?: number,
) => void;

/**
 * Rotate a whole plan by `turns` quarter-turns using exact integer sin/cos,
 * so yaws stay bit-exact multiples of π/2 (a float rotation would leave
 * 6e-17 residue and quietly un-quantize every yaw in the settlement).
 */
function rotatePlan(pads: BuildingPad[], turns: number): void {
  const k = ((turns % 4) + 4) % 4;
  if (k === 0) return;
  const c = [1, 0, -1, 0][k];
  const s = [0, 1, 0, -1][k];
  for (const p of pads) {
    const x = p.x, z = p.z;
    p.x = x * c - z * s;
    p.z = x * s + z * c;
    p.yaw = ((Math.round(p.yaw / HALF_PI) + k) % 4) * HALF_PI;
  }
}

/** Fenced rectangle with a gate gap in the -Z side. */
function paddock(
  put: Put, cx: number, cz: number, hx: number, hz: number, gate = 1.6,
): void {
  put('fence', cx, cz + hz, FACE_N, hx * 2, 0.16, 1.05);
  put('fence', cx - hx, cz, FACE_E, hz * 2, 0.16, 1.05);
  put('fence', cx + hx, cz, FACE_E, hz * 2, 0.16, 1.05);
  const seg = hx - gate / 2;
  if (seg > 0.4) {
    put('fence', cx - hx + seg / 2, cz - hz, FACE_N, seg, 0.16, 1.05);
    put('fence', cx + hx - seg / 2, cz - hz, FACE_N, seg, 0.16, 1.05);
  }
}

// ---------------------------------------------------------------------------

function planRuins(put: Put, rng: () => number): void {
  // The footprint of one collapsed hall, so the rubble reads as a *building*
  // that fell down rather than blocks dropped at random.
  const hx = 3.0 + rng() * 1.4;
  const hz = 2.4 + rng() * 1.0;
  const stub = (x: number, z: number, yaw: number, w: number) => {
    const h = 0.5 + rng() * 1.7;
    put('ruin', x, z, yaw, w, 0.62, h, 0);
  };
  for (const sz of [-1, 1]) {
    const gap = 0.7 + rng() * 1.4;
    const seg = hx - gap / 2;
    if (seg > 0.5) {
      stub(-hx + seg / 2, sz * hz, FACE_N, seg);
      stub(hx - seg / 2, sz * hz, FACE_N, seg);
    }
  }
  for (const sx of [-1, 1]) {
    const gap = 0.6 + rng() * 1.2;
    const seg = hz - gap / 2;
    if (seg > 0.5) {
      stub(sx * hx, -hz + seg / 2, FACE_E, seg);
      stub(sx * hx, hz - seg / 2, FACE_E, seg);
    }
  }
  // The hearth still standing in the middle of the fallen hall.
  put('ruin', hx * 0.35, 0, FACE_N, 1.5, 1.3, 0.75, 0);
  const rubble = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < rubble; i++) {
    const a = rng() * Math.PI * 2;
    const dist = rng() * (hx - 0.6);
    put('ruin', Math.cos(a) * dist, Math.sin(a) * dist,
      quantYaw(rng() * Math.PI * 2), 0.9 + rng() * 0.9, 0.8 + rng() * 0.8, 0.42, 0);
  }
  // A churchyard outlives the village it served.
  const gy = rng() < 0.5 ? -1 : 1;
  put('graves', gy * 7.4, -5.6, FACE_N, 4.2, 3.0, 1.0, Math.floor(rng() * 3));
  put('shrine', -gy * 6.2, 4.4, faceDir(gy, -1), 1.3, 1.3, 2.1, rng() < 0.5 ? 0 : 1);
  if (rng() < 0.55) put('well', -gy * 3.4, -6.4, FACE_N, 1.5, 1.5, 0.8, 1);
  // Hedges gone wild along what used to be the boundary.
  put('hedge', 0, 8.2, FACE_N, 8.5, 0.85, 1.35, 1);
  put('hedge', -8.2, 1.5, FACE_E, 7.0, 0.85, 1.2, 0);
  put('signpost', gy * 2.2, 6.4, quantYaw(rng() * Math.PI * 2), 1.1, 0.15, 2.1);
}

// ---------------------------------------------------------------------------

function planRanch(put: Put, rng: () => number): void {
  // A farmyard: house and barn facing each other across the working yard,
  // paddock beyond the barn, crop strips on the far side of the house.
  put('house', -8.5, 0.5, FACE_E, 5.2, 4.2, 2.6, Math.floor(rng() * 3));
  put('barn', 8.5, -1.0, FACE_W, 7.0, 5.0, 3.2, Math.floor(rng() * 2));
  put('stable', 8.5, 6.0, FACE_W, 5.5, 3.5, 2.6);
  put('granary', -7.0, -8.5, FACE_S, 3.2, 2.8, 2.0);
  put('well', 0.5, 1.5, FACE_N, 1.5, 1.5, 0.8, 0);
  put('trough', 4.6, 7.2, FACE_N, 1.9, 0.85, 0.62, 1);
  put('lamp', -4.6, -1.2, FACE_N, 0.3, 0.3, 2.5);

  paddock(put, 8.0, 14.6, 5.4, 4.3);
  put('haystack', 6.0, 13.5, FACE_N, 2.6, 2.6, 2.3, 1);
  put('haystack', 5.4, 16.8, FACE_N, 2.0, 2.0, 1.8, 0);

  put('crops', -12.5, 9.0, FACE_N, 9.0, 7.0, 0.95, 1);
  put('crops', -13.5, -6.5, FACE_N, 8.0, 6.0, 0.95, 2);
  put('hedge', -18.6, 1.0, FACE_E, 10.0, 0.7, 1.2, 0);
  put('hedge', -12.5, -11.5, FACE_N, 10.0, 0.7, 1.1, 1);

  put('woodpile', -4.6, -5.0, FACE_N, 2.8, 1.15, 1.25, 0);
  put('cart', 2.2, 4.6, FACE_E, 1.8, 2.5, 1.15, 0);
  put('washline', -5.0, 6.0, FACE_N, 4.4, 0.35, 2.1, 0);
  put('barrels', -4.6, 3.4, FACE_N, 1.8, 1.5, 0.95, 2);
  put('signpost', -1.5, -12.5, faceDir(0, 1), 1.1, 0.15, 2.1);
}

// ---------------------------------------------------------------------------

function planVillage(put: Put, rng: () => number): void {
  const hv = () => Math.floor(rng() * 3);
  // The street runs E-W at z = 0; the church closes its west end and the
  // well sits in the middle where the street widens into a green.
  put('church', -19.0, -1.0, FACE_E, 7.0, 11.0, 4.0);
  put('graves', -18.5, 8.5, FACE_E, 6.0, 5.0, 1.05, 1);
  put('well', 0, 0, FACE_N, 1.5, 1.5, 0.8, 0);
  put('trough', 2.8, 1.8, FACE_N, 1.8, 0.8, 0.6, 0);
  put('lamp', -2.4, -2.2, FACE_N, 0.3, 0.3, 2.6);
  put('lamp', 2.4, 2.4, FACE_N, 0.3, 0.3, 2.6);
  put('lamp', -9.5, 2.4, FACE_N, 0.3, 0.3, 2.6);
  put('lamp', 12.0, -2.4, FACE_N, 0.3, 0.3, 2.6);
  put('lamp', 12.5, 5.0, FACE_N, 0.3, 0.3, 2.6);
  put('shrine', -9.0, -2.6, FACE_E, 1.3, 1.3, 2.1, 0);

  // The two buildings everyone in a village shares.
  put('tavern', 7.5, -8.5, FACE_S, 7.0, 6.0, 4.6);
  put('longhouse', -3.0, 9.5, FACE_N, 12.0, 6.0, 2.2);

  // Street frontage: north side faces south, south side faces north.
  put('house', -12.5, -8.5, FACE_S, 5.0, 4.2, 2.6, hv());
  put('house', 0.5, -9.0, FACE_S, 5.4, 4.4, 2.7, hv());
  put('house', 15.5, -8.5, FACE_S, 5.0, 4.2, 2.6, hv());
  put('house', -13.0, 9.0, FACE_N, 5.0, 4.2, 2.6, hv());
  put('house', 7.5, 9.0, FACE_N, 5.2, 4.4, 2.7, hv());
  put('house', 15.5, 9.5, FACE_N, 5.0, 4.2, 2.6, hv());

  // Edge of the village: the noisy trades and the animals.
  put('smithy', 21.0, 14.0, FACE_W, 6.0, 5.0, 2.8);
  put('stable', 20.0, -8.0, FACE_W, 5.5, 3.5, 2.6);
  put('barn', 13.0, 16.5, FACE_N, 7.0, 5.0, 3.2, 1);
  put('granary', 5.0, 17.0, FACE_N, 3.2, 2.8, 2.0);

  // Outskirts: worked ground, then a hedge line, then the world.
  put('crops', -14.0, 18.0, FACE_N, 12.0, 7.0, 0.95, 1);
  put('crops', 9.0, -18.5, FACE_N, 12.0, 7.0, 0.95, 2);
  put('crops', -6.0, -18.5, FACE_N, 8.0, 6.0, 0.95, 0);
  put('hedge', 2.0, -23.0, FACE_N, 20.0, 0.7, 1.2, 1);
  put('hedge', -22.0, 12.0, FACE_E, 12.0, 0.7, 1.15, 0);
  put('hedge', -14.0, 22.5, FACE_N, 12.0, 0.7, 1.1, 0);

  // Signs of work and of people.
  put('cart', -5.0, -4.5, FACE_S, 1.8, 2.5, 1.15, 1);
  put('cart', 6.5, 13.2, FACE_W, 1.8, 2.5, 1.15, 0);
  put('woodpile', -8.0, -5.4, FACE_S, 2.8, 1.15, 1.3, 0);
  put('woodpile', 18.0, 5.5, FACE_W, 2.4, 1.1, 1.2, 1);
  put('haystack', 6.8, 20.2, FACE_N, 2.6, 2.6, 2.3, 0);
  put('haystack', 18.5, 20.5, FACE_N, 2.2, 2.2, 2.0, 1);
  put('washline', -13.5, 13.6, FACE_N, 4.6, 0.35, 2.1, 1);
  put('barrels', 5.0, -4.0, FACE_S, 1.9, 1.6, 1.0, 0);
  put('signpost', 23.5, 1.0, faceDir(-1, 0), 1.1, 0.15, 2.1);
}

// ---------------------------------------------------------------------------

function planTown(put: Put, rng: () => number): void {
  const hv = () => Math.floor(rng() * 3);
  // Market square at the centre, the church on its north side, and a
  // proper street of gable-fronted town houses running south out of it.
  put('well', 0, 0, FACE_N, 1.5, 1.5, 0.8, 0);
  put('stall', -7.0, -3.0, FACE_E, 2.7, 2.3, 2.25, 0);
  put('stall', -7.0, 3.2, FACE_E, 2.7, 2.3, 2.25, 1);
  put('stall', 7.0, -3.0, FACE_W, 2.7, 2.3, 2.25, 2);
  put('stall', 7.0, 3.2, FACE_W, 2.7, 2.3, 2.25, 0);
  put('stall', -3.2, 7.4, FACE_S, 2.7, 2.3, 2.25, 1);
  put('stall', 3.2, 7.4, FACE_S, 2.7, 2.3, 2.25, 2);
  put('pillory', 0, 4.6, FACE_N, 2.4, 1.3, 2.4, 1);
  for (const [lx, lz] of [[-4.6, -4.6], [4.6, -4.6], [-4.6, 4.6], [4.6, 4.6]]) {
    put('lamp', lx, lz, FACE_N, 0.3, 0.3, 2.6);
  }
  put('barrels', -5.4, -6.6, FACE_N, 1.9, 1.6, 1.0, 1);
  put('cart', 5.6, -6.6, FACE_N, 1.8, 2.5, 1.15, 2);

  put('church', 0, -18.5, FACE_S, 9.0, 15.0, 5.4);
  put('graves', -10.5, -19.0, FACE_S, 8.0, 6.5, 1.1, 0);
  put('tavern', 14.5, -3.0, FACE_W, 8.0, 7.0, 5.0);
  put('longhouse', -14.5, 2.0, FACE_E, 13.0, 6.5, 2.6);

  // South street: two facing rows of town houses, gables to the street.
  for (let i = 0; i < 4; i++) {
    const z = 13.5 + i * 6.2;
    put('townhouse', -7.2, z, FACE_E, 5.0, 6.0, 5.2, hv());
    put('townhouse', 7.2, z, FACE_W, 5.0, 6.0, 5.2, hv());
  }
  put('lamp', 0, 16.5, FACE_N, 0.3, 0.3, 2.6);
  put('lamp', 0, 25.5, FACE_N, 0.3, 0.3, 2.6);
  put('lamp', 0, 34.0, FACE_N, 0.3, 0.3, 2.6);
  put('signpost', 2.2, 36.5, faceDir(0, -1), 1.1, 0.15, 2.1);
  put('shrine', -2.6, 36.0, faceDir(0, -1), 1.3, 1.3, 2.1, 1);

  // West and east lanes.
  put('house', -22.5, -9.0, FACE_E, 5.2, 4.4, 2.7, hv());
  put('house', -22.5, -2.5, FACE_E, 5.2, 4.4, 2.7, hv());
  put('townhouse', -22.5, 9.0, FACE_E, 5.0, 6.0, 5.0, hv());
  put('house', -22.5, 16.0, FACE_E, 5.2, 4.4, 2.7, hv());
  put('house', 22.5, -12.0, FACE_W, 5.2, 4.4, 2.7, hv());
  put('townhouse', 22.5, 4.0, FACE_W, 5.0, 6.0, 5.0, hv());
  put('house', 22.5, 12.0, FACE_W, 5.2, 4.4, 2.7, hv());

  put('jail', -22.0, -18.5, FACE_S, 5.5, 4.5, 3.2);
  put('smithy', 28.0, 19.5, FACE_W, 6.5, 5.0, 2.9);
  put('stable', -27.5, -3.5, FACE_E, 6.0, 4.0, 2.8);
  put('trough', -27.5, 2.5, FACE_E, 1.9, 0.85, 0.62, 0);
  put('mill', -31.0, 21.0, FACE_S, 7.0, 7.0, 6.5);
  put('barn', 25.0, 26.5, FACE_N, 7.5, 5.5, 3.4, 0);
  put('granary', 16.5, 27.0, FACE_N, 3.4, 3.0, 2.1);

  // Outskirts.
  put('crops', -30.0, -27.0, FACE_N, 12.0, 8.0, 0.95, 1);
  put('crops', 12.0, -31.0, FACE_N, 16.0, 8.0, 0.95, 2);
  put('crops', 33.0, 0.0, FACE_N, 8.0, 14.0, 0.95, 0);
  put('hedge', -12.0, -34.0, FACE_N, 22.0, 0.7, 1.2, 1);
  put('hedge', 34.6, 15.0, FACE_E, 12.0, 0.7, 1.15, 0);
  put('hedge', -33.0, 6.0, FACE_E, 14.0, 0.7, 1.15, 0);
  put('hedge', 22.0, -22.0, FACE_N, 14.0, 0.7, 1.1, 1);

  put('woodpile', 19.5, 24.0, FACE_N, 3.0, 1.2, 1.35, 1);
  put('woodpile', -19.0, 14.2, FACE_E, 2.6, 1.1, 1.25, 0);
  put('woodpile', 26.5, 12.0, FACE_W, 2.4, 1.1, 1.2, 2);
  put('haystack', 19.2, 31.8, FACE_N, 2.8, 2.8, 2.4, 0);
  put('haystack', 30.5, 26.0, FACE_N, 2.3, 2.3, 2.0, 1);
  put('cart', -18.0, 20.5, FACE_S, 1.8, 2.5, 1.15, 0);
  put('cart', 17.5, -17.0, FACE_W, 1.8, 2.5, 1.15, 1);
  put('washline', -16.0, 11.2, FACE_N, 4.6, 0.35, 2.1, 0);
  put('washline', 16.5, 8.5, FACE_N, 4.2, 0.35, 2.0, 2);
  put('barrels', 19.0, -6.0, FACE_W, 1.9, 1.6, 1.0, 0);
}

// ---------------------------------------------------------------------------

/**
 * The castle and the town that grew in its shadow.
 *
 * The bailey is a walled square with the gate always on the -Z (north) side,
 * and the town spreads north of that gate along a single approach street, so
 * an arriving player walks up a street of houses, past the market, through
 * the gatehouse and finds the keep straight ahead. The gate direction is
 * fixed rather than rotated precisely so a road network can aim at it —
 * `castleGateLocal()` below exposes it.
 */
const CASTLE_TOWER_DIST = 28;
const CASTLE_GATE_W = 8;

/** Local-space mouth of a castle's gate and the direction you arrive from. */
export function castleGateLocal(): {
  x: number; z: number; dirX: number; dirZ: number;
} {
  return { x: 0, z: -CASTLE_TOWER_DIST - 4, dirX: 0, dirZ: -1 };
}

function planCastle(put: Put, rng: () => number): void {
  const hv = () => Math.floor(rng() * 3);
  const T = CASTLE_TOWER_DIST;
  const wallH = 5.6;

  // --- the fortress -------------------------------------------------------
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      put('tower', sx * T, sz * T, FACE_N, 5.6, 5.6, 9.0);
    }
  }
  const wallEnd = T - 2.6;             // walls die into the tower shafts
  const gateHalf = CASTLE_GATE_W / 2;
  const seg = wallEnd - gateHalf;
  put('wall', -(gateHalf + seg / 2), -T, FACE_N, seg, 1.5, wallH);
  put('wall', gateHalf + seg / 2, -T, FACE_N, seg, 1.5, wallH);
  put('wall', 0, T, FACE_N, wallEnd * 2, 1.5, wallH);
  put('wall', -T, 0, FACE_E, wallEnd * 2, 1.5, wallH);
  put('wall', T, 0, FACE_E, wallEnd * 2, 1.5, wallH);
  put('gatehouse', 0, -T, FACE_N, CASTLE_GATE_W, 7.0, 8.4);

  put('keep', 0, 5.0, FACE_N, 13.0, 10.0, 7.5);
  put('church', -16.0, 8.0, FACE_E, 6.0, 9.5, 4.0);      // castle chapel
  put('longhouse', 16.5, 6.0, FACE_W, 12.0, 6.0, 2.6);   // great hall
  put('smithy', -17.0, -13.0, FACE_S, 6.0, 5.0, 2.8);    // armoury forge
  put('stable', 17.0, -14.0, FACE_W, 6.5, 4.0, 2.8);
  put('jail', 18.0, 19.0, FACE_W, 5.5, 4.5, 3.2);
  put('well', -7.0, -6.0, FACE_N, 1.5, 1.5, 0.8, 0);
  put('trough', 17.5, -19.5, FACE_W, 1.9, 0.85, 0.62, 1);
  for (const sx of [-1, 1]) {
    put('brazier', sx * 6.5, -15.0, FACE_N, 1.1, 1.1, 1.15, 0);
    put('brazier', sx * 6.5, 16.5, FACE_N, 1.1, 1.1, 1.15, 0);
    put('banner', sx * 5.5, -22.0, FACE_N, 1.1, 0.3, 5.6, 0);
  }
  put('barrels', 12.0, -20.0, FACE_N, 1.9, 1.6, 1.0, 1);
  put('woodpile', -21.0, -3.0, FACE_E, 2.8, 1.2, 1.3, 0);
  put('haystack', 22.0, -19.5, FACE_N, 2.4, 2.4, 2.1, 1);
  put('cart', -12.0, 18.0, FACE_S, 1.8, 2.5, 1.15, 2);
  put('washline', -21.0, 14.0, FACE_N, 4.2, 0.35, 2.0, 1);

  // --- the castle town, north of the gate ---------------------------------
  // The approach street runs on x = 0 with dwellings shoulder to shoulder on
  // both sides, so arriving means walking a street of houses, past the
  // market, and through the gatehouse with the keep straight ahead.
  for (let i = 0; i < 4; i++) {
    const z = -38.0 - i * 6.2;
    put('townhouse', -8.0, z, FACE_E, 5.0, 6.0, 5.2, hv());
    if (i < 3) put('townhouse', 8.0, z, FACE_W, 5.0, 6.0, 5.2, hv());
  }
  put('house', 8.0, -56.5, FACE_W, 5.2, 4.4, 2.7, hv());
  put('house', -7.5, -62.5, FACE_N, 5.2, 4.4, 2.7, hv());
  put('house', 7.5, -62.5, FACE_N, 5.2, 4.4, 2.7, hv());

  // West side of the street: the tavern by the gate, then the town church,
  // then the churchyard and the mill out on the edge.
  put('tavern', -17.0, -37.0, FACE_E, 8.0, 7.0, 5.0);
  put('stable', -25.5, -35.0, FACE_E, 6.0, 4.0, 2.8);
  put('house', -26.5, -42.0, FACE_E, 5.2, 4.4, 2.7, hv());
  put('church', -19.5, -50.5, FACE_E, 8.0, 13.0, 4.8);
  put('graves', -17.0, -60.0, FACE_E, 8.0, 6.0, 1.1, 2);
  put('mill', -30.0, -60.0, FACE_S, 7.0, 7.0, 6.8);

  // East side: the armourers' row by the gate, the moot hall, and the market.
  put('smithy', 16.5, -34.5, FACE_W, 6.5, 5.0, 2.9);
  put('longhouse', 27.0, -38.0, FACE_W, 11.0, 5.5, 2.4);
  put('well', 17.0, -47.0, FACE_N, 1.5, 1.5, 0.8, 0);
  put('stall', 13.0, -47.0, FACE_E, 2.7, 2.3, 2.25, 0);
  put('stall', 21.0, -47.0, FACE_W, 2.7, 2.3, 2.25, 1);
  put('stall', 17.0, -43.0, FACE_S, 2.7, 2.3, 2.25, 2);
  put('pillory', 21.5, -43.0, FACE_N, 2.4, 1.3, 2.4, 0);
  put('granary', 26.5, -49.5, FACE_W, 3.4, 3.0, 2.1);
  put('barn', 28.0, -57.0, FACE_N, 7.5, 5.5, 3.4, 1);
  put('house', 17.0, -57.0, FACE_W, 5.2, 4.4, 2.7, hv());

  // Lit approach, banners at the town's mouth, and the sign that names it.
  for (let i = 0; i < 3; i++) {
    const z = -37.0 - i * 9.0;
    put('lamp', -4.6, z, FACE_N, 0.3, 0.3, 2.6);
    put('lamp', 4.6, z, FACE_N, 0.3, 0.3, 2.6);
  }
  for (const sx of [-1, 1]) {
    put('banner', sx * 3.0, -65.0, FACE_N, 1.1, 0.3, 5.0, 1);
  }
  put('signpost', 1.2, -66.5, faceDir(0, 1), 1.1, 0.15, 2.1);
  put('shrine', -1.6, -66.5, faceDir(0, 1), 1.3, 1.3, 2.1, 1);

  // Worked ground and boundaries beyond the built-up edge.
  put('crops', 42.0, -32.0, FACE_N, 10.0, 12.0, 0.95, 2);
  put('crops', 42.0, -55.0, FACE_N, 10.0, 10.0, 0.95, 0);
  put('hedge', -31.0, -44.0, FACE_E, 16.0, 0.7, 1.2, 0);
  put('hedge', 13.5, -55.0, FACE_E, 12.0, 0.7, 1.2, 1);
  put('hedge', -26.0, -67.0, FACE_N, 14.0, 0.7, 1.15, 0);
  put('hedge', 22.0, -66.0, FACE_N, 14.0, 0.7, 1.15, 1);
  put('woodpile', 12.5, -37.0, FACE_W, 2.8, 1.2, 1.3, 1);
  put('woodpile', -23.0, -44.5, FACE_E, 2.6, 1.1, 1.25, 0);
  put('haystack', 34.5, -60.0, FACE_N, 2.8, 2.8, 2.4, 0);
  put('haystack', 34.0, -55.5, FACE_N, 2.3, 2.3, 2.0, 1);
  put('cart', -12.0, -33.0, FACE_E, 1.8, 2.5, 1.15, 0);
  put('cart', -12.5, -61.0, FACE_E, 1.8, 2.5, 1.15, 1);
  put('washline', -13.5, -43.5, FACE_N, 4.4, 0.35, 2.1, 2);
  put('barrels', -12.5, -35.5, FACE_N, 1.9, 1.6, 1.0, 2);
  put('trough', 12.5, -42.5, FACE_W, 1.9, 0.85, 0.62, 0);
}

// ---------------------------------------------------------------------------

/**
 * Build the pad list for a settlement kind. Ranch / village / town are
 * rotated by a whole quarter-turn so the same plan does not always face the
 * same way; the castle keeps its gate on -Z (see `castleGateLocal`).
 */
export function planFor(kind: SettlementKind, rng: () => number): BuildingPad[] {
  const pads: BuildingPad[] = [];
  const put: Put = (type, x, z, yaw, w, d, h, v = 0) => {
    pads.push({ type, x, z, yaw, w, d, h, v });
  };
  switch (kind) {
    case 'ruins': planRuins(put, rng); break;
    case 'ranch': planRanch(put, rng); break;
    case 'village': planVillage(put, rng); break;
    case 'town': planTown(put, rng); break;
    default: planCastle(put, rng); break;
  }
  if (kind !== 'castle') rotatePlan(pads, Math.floor(rng() * 4));
  return pads;
}
