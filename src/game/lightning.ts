/**
 * Lightning — pure helpers for Phase I thunderstorm strike resolution.
 *
 * All exports in this file are pure (no GPU, no DOM, no localStorage) so they
 * are node-testable. The wiring into the live game loop lives in main.ts.
 *
 * Strike flow:
 *  1. strikesForSegment() (weather.ts) gives offsets within a segment.
 *  2. absoluteStrikeTimes() maps those to wall-clock simTime values.
 *  3. Each frame the sim loop checks whether any scheduled time has passed.
 *  4. strikeTargetPoint() picks a deterministic XZ target near the player.
 *  5. isExposed() decides whether the player can be struck.
 *  6. resolvePlayerStrike() returns the HP outcome (kill or survivor clamp).
 */

import { mix32 } from './dungeon/dungeon-layout';
import { mulberry32 } from './mesh-utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum horizontal distance (m) from player a strike can land. */
export const STRIKE_MIN_DIST = 20;
/** Maximum horizontal distance (m) from player a strike can land. */
export const STRIKE_MAX_DIST = 120;
/** Radius (m) within which a player is struck (no iron armor). */
export const PLAYER_STRIKE_RADIUS = 6;
/** Radius (m) within which a player is struck while wearing iron armor (BOTW nod). */
export const PLAYER_STRIKE_RADIUS_IRON = 12;
/** Radius (m) within which a nearby tree is ignited by the strike. */
export const TREE_IGNITE_RADIUS = 8;
/** Seconds a lightning-ignited tree burns. */
export const TREE_BURN_S = 45;

// ---------------------------------------------------------------------------
// Segment → absolute time mapping
// ---------------------------------------------------------------------------

/**
 * Convert the per-segment strike offsets into absolute simTime values.
 *
 * @param segStartS   Absolute sim time (s) at which the segment begins.
 * @param offsets     From strikesForSegment().
 */
export function absoluteStrikeTimes(
  segStartS: number,
  offsets: { tOffsetS: number }[],
): number[] {
  return offsets.map(o => segStartS + o.tOffsetS);
}

// ---------------------------------------------------------------------------
// Strike target point
// ---------------------------------------------------------------------------

/**
 * Deterministic XZ target point for a strike, seeded by the strike's absolute
 * time (truncated to integer ms for stability across floating-point arithmetic).
 *
 * The point is placed uniformly at random within an annulus
 * [STRIKE_MIN_DIST, STRIKE_MAX_DIST] around (playerX, playerZ).
 */
export function strikeTargetPoint(
  strikeTimeS: number,
  playerX: number,
  playerZ: number,
): { x: number; z: number } {
  const timeSeed = Math.round(strikeTimeS * 1000) >>> 0;
  const rng = mulberry32(mix32(timeSeed, 0xc0ffee, 2));
  // Uniform angle
  const angle = rng() * Math.PI * 2;
  // Uniform area in annulus: r = sqrt(lerp(min², max², u))
  const u = rng();
  const rMin2 = STRIKE_MIN_DIST * STRIKE_MIN_DIST;
  const rMax2 = STRIKE_MAX_DIST * STRIKE_MAX_DIST;
  const r = Math.sqrt(rMin2 + u * (rMax2 - rMin2));
  return {
    x: playerX + Math.cos(angle) * r,
    z: playerZ + Math.sin(angle) * r,
  };
}

// ---------------------------------------------------------------------------
// Exposure predicate
// ---------------------------------------------------------------------------

export interface ExposureState {
  /** Player is currently inside a dungeon. */
  inDungeon: boolean;
  /** Canopy cover (from canopyAt()). */
  canopy: boolean;
  /** Tent tier (0 = no tent). */
  tentTier: 0 | 1 | 2 | 3;
  /** Player is swimming/submerged. */
  swimming: boolean;
}

/**
 * Returns true when the player is exposed to a lightning strike.
 * Any shelter (dungeon, canopy, tent, swimming-underwater) provides immunity.
 */
export function isExposed(state: ExposureState): boolean {
  if (state.inDungeon) return false;
  if (state.canopy) return false;
  if (state.tentTier > 0) return false;
  if (state.swimming) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Player strike outcome
// ---------------------------------------------------------------------------

export type PlayerStrikeOutcome = 'death' | 'survivor';

/**
 * Determine the outcome of a direct player lightning strike.
 * 50/50 roll seeded by strikeTimeS.
 *   'death'    → caller must damagePlayer(vitals, vitals.hp, 'lightning')
 *   'survivor' → caller must damagePlayer(vitals, vitals.hp - 4, 'lightning')
 *                (clamps hp to exactly 4 = 2 hearts)
 */
export function resolvePlayerStrike(strikeTimeS: number): PlayerStrikeOutcome {
  const timeSeed = Math.round(strikeTimeS * 1000) >>> 0;
  const rng = mulberry32(mix32(timeSeed, 0xb017, 3));
  return rng() < 0.5 ? 'death' : 'survivor';
}

// ---------------------------------------------------------------------------
// Iron armor detection
// ---------------------------------------------------------------------------

/**
 * Returns true if any equipped armor slot contains an item whose id starts
 * with 'iron_'. Used to double the player-strike radius.
 */
export function hasIronArmor(armor: {
  head: { id: string } | null;
  body: { id: string } | null;
  legs: { id: string } | null;
}): boolean {
  return (
    (armor.head !== null && armor.head.id.startsWith('iron_')) ||
    (armor.body !== null && armor.body.id.startsWith('iron_')) ||
    (armor.legs !== null && armor.legs.id.startsWith('iron_'))
  );
}

// ---------------------------------------------------------------------------
// Active strike registry (shared mutable state, consumed in main.ts)
// ---------------------------------------------------------------------------

/**
 * A scheduled strike that has not yet fired.
 * Stored as absolute simTime so the main loop can check cheaply.
 */
export interface ScheduledStrike {
  /** Absolute simTime (s) at which this strike fires. */
  fireAtS: number;
  /** Segment index (for debug). */
  segmentIndex: number;
}
