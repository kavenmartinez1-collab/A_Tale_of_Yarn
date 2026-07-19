/**
 * Fire registry — placed campfires and forges.
 *
 * PlacedFire lifecycle:
 *   - campfire: burns while fuelS > 0, drains in real sim seconds.
 *     Adding logs refuels (+90 s each, cap 600 s).
 *   - forge: same fuel model as campfire (keeps same drain rate).
 *     Upgrade from lit campfire + 8 stone: kind flips to 'forge', stone consumed.
 *
 * Placing:
 *   - campfire_kit: consumes 1 kit, places an unlit campfire (fuelS = 0).
 *     Player must ignite it with fire_starter or torch.
 *   - fire_starter: a TOOL, NOT consumed on use; it is the ignition source
 *     when aimed at an unlit campfire (or placed campfire_kit).
 *   - Igniting a campfire costs 1 log from inventory (tinder) and lights it.
 *   - Relighting a burnt-out fire (fuelS = 0 but already placed) also costs
 *     1 log.
 *
 * BurningTree: exported type for Phase I (lightning). Burning trees count as
 * warmth sources in fireWarmthAt / nearFire checks.
 *
 * Persistence: 'artifex-fires:v1', localStorage-guarded, cap 64.
 */

export const FIRES_KEY = 'artifex-fires:v1';

/** Seconds added per log fuel top-up. */
export const FUEL_PER_LOG = 90;
/** Maximum fuel a fire can hold. */
export const FUEL_CAP = 600;
/** Campfire fuel drain rate (seconds per second — 1:1 real time). */
export const FUEL_DRAIN_PER_S = 1;
/** Warmth radius (metres) around a lit fire. */
export const WARMTH_RADIUS = 6;
/** Placement proximity radius for fire detection. */
export const CRAFT_FIRE_RADIUS = 4;
/** Max fires kept in persistence. */
export const MAX_FIRES = 64;

export type FireKind = 'campfire' | 'forge';

export interface PlacedFire {
  id: string;
  x: number;
  y: number;
  z: number;
  kind: FireKind;
  /** Remaining fuel in sim seconds. 0 = unlit / burned out. */
  fuelS: number;
  /**
   * Sim time (seconds) at which fuelS was last computed.
   * We drain lazily: actual fuel = max(0, fuelS - (now - litUntilNow)) when lit.
   */
  litUntilNow: number;
}

/** Burning tree record for Phase I (lightning). */
export interface BurningTree {
  x: number;
  y: number;
  z: number;
  /** Sim time (seconds) at which the tree stops burning. */
  untilS: number;
}

/** Module-level burning-tree registry. Phase I feeds this. */
const burningTrees: BurningTree[] = [];

/** Register a burning tree (called by Phase I lightning). */
export function addBurningTree(t: BurningTree): void {
  burningTrees.push(t);
}

/** Expire old burning trees (call each frame with current sim time). */
export function tickBurningTrees(nowS: number): void {
  for (let i = burningTrees.length - 1; i >= 0; i--) {
    if (burningTrees[i].untilS <= nowS) burningTrees.splice(i, 1);
  }
}

/** Read-only snapshot of the current burning-tree registry. */
export function getBurningTrees(): readonly BurningTree[] {
  return burningTrees;
}

// ---------------------------------------------------------------------------
// Fuel / lit helpers
// ---------------------------------------------------------------------------

/**
 * Returns the live remaining fuel at the given sim time, accounting for drain
 * since litUntilNow. Does NOT mutate the fire.
 */
export function liveFuelAt(fire: PlacedFire, nowS: number): number {
  if (fire.fuelS <= 0) return 0;
  const elapsed = nowS - fire.litUntilNow;
  return Math.max(0, fire.fuelS - elapsed * FUEL_DRAIN_PER_S);
}

/** True when the fire is burning (fuelS > 0 after lazy drain). */
export function isLit(fire: PlacedFire, nowS: number): boolean {
  return liveFuelAt(fire, nowS) > 0;
}

/**
 * Drain the fire in-place to the current sim time.
 * Call before any mutation (add fuel, upgrade, etc.).
 */
export function drainFire(fire: PlacedFire, nowS: number): void {
  fire.fuelS = liveFuelAt(fire, nowS);
  fire.litUntilNow = nowS;
}

/**
 * Add `logCount` logs of fuel to an already-lit fire.
 * If fuelS was 0 (unlit), this also lights it (tinder from the caller's log).
 * Returns the new fuelS.
 */
export function addFuel(fire: PlacedFire, logCount: number, nowS: number): number {
  drainFire(fire, nowS);
  fire.fuelS = Math.min(FUEL_CAP, fire.fuelS + logCount * FUEL_PER_LOG);
  fire.litUntilNow = nowS;
  return fire.fuelS;
}

/**
 * Upgrade a lit campfire to a forge (requires the campfire to be lit).
 * Does NOT check stone cost — caller must verify and remove 8 stone.
 * Returns false if the fire is not a lit campfire.
 */
export function upgradeToForge(fire: PlacedFire, nowS: number): boolean {
  if (fire.kind !== 'campfire') return false;
  if (!isLit(fire, nowS)) return false;
  fire.kind = 'forge';
  return true;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** Returns the nearest PlacedFire within maxDist (XZ plane), or null. */
export function nearestFire(
  fires: PlacedFire[],
  x: number,
  z: number,
  maxDist: number,
): PlacedFire | null {
  let best: PlacedFire | null = null;
  let bestDist2 = maxDist * maxDist;
  for (const f of fires) {
    const d2 = (f.x - x) ** 2 + (f.z - z) ** 2;
    if (d2 <= bestDist2) {
      bestDist2 = d2;
      best = f;
    }
  }
  return best;
}

/**
 * True when the player position (x, z) is within WARMTH_RADIUS of any LIT
 * fire (campfire, forge, or burning tree).
 */
export function fireWarmthAt(
  fires: PlacedFire[],
  x: number,
  z: number,
  nowS: number,
): boolean {
  const r2 = WARMTH_RADIUS * WARMTH_RADIUS;
  for (const f of fires) {
    if (!isLit(f, nowS)) continue;
    if ((f.x - x) ** 2 + (f.z - z) ** 2 <= r2) return true;
  }
  // Burning trees also count as warmth.
  for (const t of burningTrees) {
    if (t.untilS > nowS) {
      if ((t.x - x) ** 2 + (t.z - z) ** 2 <= r2) return true;
    }
  }
  return false;
}

/**
 * True when the player is within CRAFT_FIRE_RADIUS of a lit campfire or forge.
 * Used for crafting station check (nearCampfire).
 */
export function nearCampfireOrForge(
  fires: PlacedFire[],
  x: number,
  z: number,
  nowS: number,
): boolean {
  const r2 = CRAFT_FIRE_RADIUS * CRAFT_FIRE_RADIUS;
  for (const f of fires) {
    if (!isLit(f, nowS)) continue;
    if ((f.x - x) ** 2 + (f.z - z) ** 2 <= r2) return true;
  }
  return false;
}

/**
 * True when the player is within CRAFT_FIRE_RADIUS of a lit forge.
 * Used for crafting station check (nearForge).
 */
export function nearForge(
  fires: PlacedFire[],
  x: number,
  z: number,
  nowS: number,
): boolean {
  const r2 = CRAFT_FIRE_RADIUS * CRAFT_FIRE_RADIUS;
  for (const f of fires) {
    if (f.kind !== 'forge') continue;
    if (!isLit(f, nowS)) continue;
    if ((f.x - x) ** 2 + (f.z - z) ** 2 <= r2) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function genId(): string {
  return `fire_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

export function createFire(
  x: number,
  y: number,
  z: number,
  kind: FireKind = 'campfire',
  fuelS = 0,
  nowS = 0,
): PlacedFire {
  return { id: genId(), x, y, z, kind, fuelS, litUntilNow: nowS };
}

export function serializeFires(fires: PlacedFire[]): string {
  return JSON.stringify(fires);
}

function isFireKind(v: unknown): v is FireKind {
  return v === 'campfire' || v === 'forge';
}

export function deserializeFires(json: string): PlacedFire[] | null {
  let x: unknown;
  try { x = JSON.parse(json); } catch { return null; }
  if (!Array.isArray(x)) return null;
  const out: PlacedFire[] = [];
  for (const item of x) {
    if (typeof item !== 'object' || item === null) return null;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== 'string') return null;
    if (typeof o.x !== 'number' || !Number.isFinite(o.x)) return null;
    if (typeof o.y !== 'number' || !Number.isFinite(o.y)) return null;
    if (typeof o.z !== 'number' || !Number.isFinite(o.z)) return null;
    if (!isFireKind(o.kind)) return null;
    if (typeof o.fuelS !== 'number' || !Number.isFinite(o.fuelS) || o.fuelS < 0) return null;
    const litUntilNow = typeof o.litUntilNow === 'number' && Number.isFinite(o.litUntilNow)
      ? o.litUntilNow : 0;
    out.push({
      id: o.id as string,
      x: o.x as number,
      y: o.y as number,
      z: o.z as number,
      kind: o.kind as FireKind,
      fuelS: o.fuelS as number,
      litUntilNow,
    });
  }
  return out;
}

export function loadFires(): PlacedFire[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(FIRES_KEY);
    if (raw !== null) {
      const fires = deserializeFires(raw);
      if (fires !== null) return fires;
    }
  } catch { /* storage unavailable */ }
  return [];
}

export function saveFires(fires: PlacedFire[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    // Cap at MAX_FIRES — drop oldest (front of array).
    const capped = fires.length > MAX_FIRES
      ? fires.slice(fires.length - MAX_FIRES)
      : fires;
    localStorage.setItem(FIRES_KEY, serializeFires(capped));
  } catch { /* storage unavailable */ }
}
