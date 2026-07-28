/**
 * Loom registry — the tier-3 crafting station, placed in the world.
 *
 * Deliberately a near-copy of `fire.ts` rather than a generalisation of it. A
 * fire has fuel, drains, lights, burns out, sets bushes alight and upgrades
 * into a forge; a loom is a piece of furniture that is either there or not.
 * Folding the two into one "placeable" abstraction would have meant every loom
 * carrying a `fuelS` it can never spend, and every fire carrying a shape it
 * does not have. Two small tables beat one table with holes in it.
 *
 * Lifecycle:
 *   - Placing consumes 1 loom_kit (main.ts `tryPlaceLoom`).
 *   - A loom is always "on" — there is nothing to light.
 *   - Persist 'artifex-looms:v1'; cap MAX_LOOMS.
 *
 * DETERMINISM: ids are derived from the placement position and a per-session
 * sequence, never from `Date.now()`/`Math.random()`. Two runs that place looms
 * at the same coordinates in the same order produce the same ids, which is what
 * lets a harness assert on them.
 */

import type { GameItemId } from './items';

export const LOOMS_KEY = 'artifex-looms:v1';

/**
 * How close you must stand to weave. Matches `CRAFT_FIRE_RADIUS` exactly: two
 * stations with different reach is the kind of difference a player experiences
 * only as "sometimes the button works".
 */
export const CRAFT_LOOM_RADIUS = 4;

/** Max looms kept in persistence. */
export const MAX_LOOMS = 16;

/** The item that places one. */
export const LOOM_ITEM = 'loom_kit' satisfies GameItemId;

export interface PlacedLoom {
  id: string;
  x: number;
  y: number;
  z: number;
  /** Facing in radians — looms are rectangular and want to face the player. */
  yaw: number;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** True when (x, z) is within CRAFT_LOOM_RADIUS of any placed loom. */
export function nearLoom(looms: readonly PlacedLoom[], x: number, z: number): boolean {
  const r2 = CRAFT_LOOM_RADIUS * CRAFT_LOOM_RADIUS;
  for (const l of looms) {
    if ((l.x - x) ** 2 + (l.z - z) ** 2 <= r2) return true;
  }
  return false;
}

/** Nearest loom within maxDist (XZ), or null. */
export function nearestLoom(
  looms: readonly PlacedLoom[],
  x: number,
  z: number,
  maxDist: number,
): PlacedLoom | null {
  let best: PlacedLoom | null = null;
  let bestD2 = maxDist * maxDist;
  for (const l of looms) {
    const d2 = (l.x - x) ** 2 + (l.z - z) ** 2;
    if (d2 <= bestD2) { bestD2 = d2; best = l; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** Per-session placement counter — see the header's determinism note. */
let seq = 0;

/** Reset the id sequence. Tests only; the game never needs it. */
export function resetLoomIds(): void {
  seq = 0;
}

/** 32-bit integer mix, so an id is a function of where the loom went. */
function mixPos(x: number, z: number, n: number): number {
  let h = (Math.round(x * 100) | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (Math.round(z * 100) | 0), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13) ^ n, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function createLoom(x: number, y: number, z: number, yaw = 0): PlacedLoom {
  const id = `loom_${mixPos(x, z, seq).toString(36)}_${seq}`;
  seq++;
  return { id, x, y, z, yaw };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function serializeLooms(looms: readonly PlacedLoom[]): string {
  return JSON.stringify(looms);
}

export function deserializeLooms(json: string): PlacedLoom[] | null {
  let x: unknown;
  try { x = JSON.parse(json); } catch { return null; }
  if (!Array.isArray(x)) return null;
  const out: PlacedLoom[] = [];
  for (const item of x) {
    if (typeof item !== 'object' || item === null) return null;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== 'string') return null;
    if (typeof o.x !== 'number' || !Number.isFinite(o.x)) return null;
    if (typeof o.y !== 'number' || !Number.isFinite(o.y)) return null;
    if (typeof o.z !== 'number' || !Number.isFinite(o.z)) return null;
    // yaw is tolerated missing: a record written before looms could face you
    // is still a loom, and refusing it would delete the player's station.
    const yaw = typeof o.yaw === 'number' && Number.isFinite(o.yaw) ? o.yaw : 0;
    out.push({ id: o.id, x: o.x, y: o.y, z: o.z, yaw });
  }
  return out;
}

export function loadLooms(): PlacedLoom[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(LOOMS_KEY);
    if (raw !== null) {
      const looms = deserializeLooms(raw);
      if (looms !== null) return looms;
    }
  } catch { /* storage unavailable */ }
  return [];
}

export function saveLooms(looms: readonly PlacedLoom[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const capped = looms.length > MAX_LOOMS
      ? looms.slice(looms.length - MAX_LOOMS)
      : looms;
    localStorage.setItem(LOOMS_KEY, serializeLooms(capped));
  } catch { /* quota */ }
}
