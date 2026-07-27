/**
 * shields.ts — the guard: what a raised shield stops, what it costs, and the
 * one-fifth of a second in which raising it is worth more than holding it.
 *
 * ## THE SHAPE OF THE FEATURE
 *
 * A shield is an ORDINARY HOTBAR ITEM that is never "equipped" in the way a
 * sword is. You keep a sword in the selected slot and a shield somewhere else
 * in the same five slots, and holding the block input raises whichever shield
 * you are carrying. That is deliberate and it is the whole economy of the
 * feature: the shield costs you a hotbar slot — a torch, a bow, a stack of
 * food — and buys you a defence that coexists with your weapon. An off-hand
 * equipment slot would have cost nothing and meant nothing.
 *
 * `bestShieldTier` therefore takes a bag of item ids rather than a slot index.
 *
 * ## THE LADDER IS A STAT VECTOR, NOT A NUMBER
 *
 * Every tier reduces blockable melee by 100%. A wooden shield stops a goblin's
 * club exactly as dead as a dragonscale one does, and that is correct: a shield
 * that only half-works is not a shield, it is a debuff. What the ladder buys is
 * two other things entirely:
 *
 *   - **Stamina per block** (wood 4 → dragonscale 1). Against 100 stamina that
 *     is 25 blocks versus 100, which is the difference between "I can turtle
 *     through this wolf" and "I can turtle through this pack".
 *   - **Fire and breath mitigation** (wood 25% → dragonscale 85%). This is the
 *     payoff and the reason the top tier is made of dragon scale: the thing a
 *     dragon's own hide is best at surviving is dragon fire. At 8 hp/s of boss
 *     breath against 20 max HP, wood turns a lethal jet into a nearly-lethal
 *     one and dragonscale turns it into a scratch.
 *
 * Because the ladder is a vector and not a scalar, a retune can invert it
 * SILENTLY — raise iron's stamina cost past bronze's and nothing type-checks
 * differently, nothing crashes, and the only symptom is that the forge upgrade
 * players ground for is worse than the one before it. `test-shields.mts`
 * therefore asserts the RELATIONS (`STAMINA_PER_BLOCK` non-increasing, fire
 * mitigation non-decreasing, both across the whole `LADDER` order) rather than
 * the numbers, which is the same guard `tintreach.ts` has and for the same
 * reason.
 *
 * ## PARRY: PRESS-EDGE ONLY, AND UNIFORM ACROSS TIERS
 *
 * A block that was FRESHLY RAISED within `PARRY_WINDOW_S` of the blow landing
 * costs nothing, takes nothing, and staggers the attacker. A block that was
 * already up does not, ever, at any tier.
 *
 * Two rules make that true and both matter:
 *
 *   1. The window is measured from the PRESS EDGE (`GuardState.raisedAtS`),
 *      which only ever moves when the input transitions from up to down. A
 *      player holding the button from the start of the fight has a `raisedAtS`
 *      that recedes forever, so `parryReady` is false forever. Turtling can
 *      never accidentally parry.
 *   2. `PARRY_REARM_S` stops the opposite exploit. Without it, mashing the
 *      button gives a fresh 0.18 s window on every press, and a masher at 5 Hz
 *      would parry essentially everything without reading a single tell — which
 *      is worse than turtling, because it looks like skill. A raise that comes
 *      less than `PARRY_REARM_S` after the last ARMED one still puts the shield
 *      up (you are never left defenceless for pressing block) but does not arm
 *      a window. Mashing therefore caps at 0.18/0.60 = 30% coverage while
 *      reading the tell gives 100%.
 *
 * The window is IDENTICAL at every tier. Parry is the skill axis and gear is
 * the attrition axis; letting dragonscale parry more easily would collapse the
 * two into one and make the wooden shield strictly worse at the only thing the
 * mechanic is actually about.
 *
 * Breath and arrows are NOT parryable. You cannot deflect a jet of fire with
 * timing, and an arrow's contact frame is not something the player can read.
 * Both are still BLOCKED by the cone (see `resolveBlock`).
 *
 * ## THE CONE
 *
 * Blocking covers `BLOCK_CONE_HALF` either side of the player's facing — a 120
 * degree frontal arc, the same arc Z-targeting acquires from. Anything from
 * behind or off the flank lands in full, which is what makes the token pool's
 * circling pack a threat rather than scenery, and what makes lock-on load
 * bearing: lock-on holds your facing on the thing you are fighting, so the
 * pair of features is one feature.
 *
 * The bearing is computed with `lockFacingYaw` from `lock-on.ts` rather than a
 * private `atan2`, because this codebase has TWO yaw conventions that are
 * negatives of each other and every agent who has written a third copy of one
 * of them has got it backwards. Re-using the named converter means the cone
 * cannot silently disagree with the camera about which way "in front" is.
 *
 * ## TIME
 *
 * Every timestamp here is SIM time, supplied by the caller. There is no clock
 * in this file and there must never be one: the parry window has to freeze when
 * the game is paused, and the only way to be sure of that is to not have access
 * to a wall clock in the first place.
 *
 * Pure module: no DOM, no GPU, no allocation in the hot path. Node-testable.
 */

import { angleDelta, lockFacingYaw } from './lock-on';
import type { GameItemId } from '../items';

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

export type ShieldTier = 'wood' | 'bronze' | 'iron' | 'dragonscale';

/**
 * Weakest to strongest. The order the relation tests walk, and the order
 * `bestShieldTier` ranks by — declared once so the two can never disagree.
 */
export const LADDER: readonly ShieldTier[] = ['wood', 'bronze', 'iron', 'dragonscale'];

export interface ShieldStats {
  tier: ShieldTier;
  /** Index into `LADDER`. Higher is better, at everything. */
  rank: number;
  /** The inventory item that grants this tier. */
  itemId: GameItemId;
  /** Stamina spent per blow stopped. Lower is better. */
  staminaPerBlock: number;
  /**
   * Fraction of fire/breath damage removed, 0..1. Higher is better.
   *
   * Never 1: standing in a dragon's mouth has to cost something even at the
   * top of the ladder, or the last fight in the game has a switch that turns
   * it off.
   */
  fireMitigation: number;
}

/**
 * The table. Tuned against 20 max HP and 100 max stamina.
 *
 * Blocks available on a full bar: wood 25, bronze 33, iron 50, dragonscale 100.
 * Boss breath is 2 hp per 0.25 s tick (8 hp/s); a full 1.6 s jet is ~13 of 20
 * unblocked, ~9.6 behind wood and ~1.9 behind dragonscale.
 */
export const SHIELD_STATS: Readonly<Record<ShieldTier, ShieldStats>> = {
  wood: {
    tier: 'wood', rank: 0, itemId: 'wood_shield',
    staminaPerBlock: 4, fireMitigation: 0.25,
  },
  bronze: {
    tier: 'bronze', rank: 1, itemId: 'bronze_shield',
    staminaPerBlock: 3, fireMitigation: 0.35,
  },
  iron: {
    tier: 'iron', rank: 2, itemId: 'iron_shield',
    staminaPerBlock: 2, fireMitigation: 0.50,
  },
  dragonscale: {
    tier: 'dragonscale', rank: 3, itemId: 'dragonscale_shield',
    staminaPerBlock: 1, fireMitigation: 0.85,
  },
};

/** Item id → tier, or null when the item is not a shield. */
export function shieldTierOf(id: string | null | undefined): ShieldTier | null {
  if (id === null || id === undefined) return null;
  for (const t of LADDER) if (SHIELD_STATS[t].itemId === id) return t;
  return null;
}

/** True when this item is a shield of any tier. */
export function isShield(id: string | null | undefined): boolean {
  return shieldTierOf(id) !== null;
}

/**
 * The best shield in a bag of item ids, or null when there is none.
 *
 * Carrying two shields raises the better one. The alternative — raising
 * whichever happened to sit in the lower slot — would be a silent downgrade
 * with no UI anywhere that could explain it.
 */
export function bestShieldTier(
  ids: Iterable<string | null | undefined>,
): ShieldTier | null {
  let best: ShieldTier | null = null;
  for (const id of ids) {
    const t = shieldTierOf(id);
    if (t === null) continue;
    if (best === null || SHIELD_STATS[t].rank > SHIELD_STATS[best].rank) best = t;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Half-angle of the blocked arc, radians. 1.0472 = 60 deg, a 120 deg cone.
 *
 * Matches `LOCK_ACQUIRE_CONE` (1.05) to within a rounding error on purpose:
 * the arc you can lock onto from and the arc you can block from being the same
 * arc is what makes "lock on, then block" one motion rather than two rules the
 * player has to hold separately.
 */
export const BLOCK_CONE_HALF = Math.PI / 3;

/**
 * Seconds after a fresh raise in which a blow is parried instead of blocked.
 *
 * 0.18 s is roughly eleven frames at 60 fps. Long enough to be hit-able off a
 * visible windup, short enough that it cannot be reached by reacting to the
 * blow itself (human visual reaction is ~0.25 s), which is what forces the
 * player to read the TELL rather than the contact.
 */
export const PARRY_WINDOW_S = 0.18;

/** Seconds an ordinary attacker is staggered by a parry. */
export const PARRY_STAGGER_S = 1.2;

/**
 * Seconds a BOSS is staggered by a parry.
 *
 * Deliberately less than half. The Evil King is parryable — a boss you cannot
 * answer is a boss you can only out-heal — but 1.2 s of him standing still is
 * two free hits and a repositioning, which turns the last fight in the game
 * into a metronome. 0.5 s is one hit and a step back.
 */
export const PARRY_STAGGER_BOSS_S = 0.5;

/** Movement speed multiplier while the shield is up. */
export const BLOCK_MOVE_MUL = 0.5;

/**
 * Minimum seconds between two PARRY-ARMED raises. See the header.
 *
 * Only the arming is gated; the shield itself always goes up. 0.60 against a
 * 0.18 s window caps a masher at 30% coverage.
 */
export const PARRY_REARM_S = 0.6;

// ---------------------------------------------------------------------------
// The cone
// ---------------------------------------------------------------------------

/**
 * |angle| between where the player is facing and where the attacker is,
 * radians, in [0, pi]. 0 is dead ahead, pi is directly behind.
 */
export function blockBearing(
  facingYaw: number,
  px: number, pz: number,
  ax: number, az: number,
): number {
  // Degenerate: the attacker is standing exactly on the player. Treat it as
  // dead ahead — a body inside your own is not a flank, and returning NaN here
  // would silently make every comparison below false and drop the guard.
  if (Math.abs(ax - px) < 1e-6 && Math.abs(az - pz) < 1e-6) return 0;
  return Math.abs(angleDelta(facingYaw, lockFacingYaw(px, pz, ax, az)));
}

/** True when the attacker is inside the blocked frontal arc. */
export function inBlockCone(
  facingYaw: number,
  px: number, pz: number,
  ax: number, az: number,
): boolean {
  return blockBearing(facingYaw, px, pz, ax, az) <= BLOCK_CONE_HALF;
}

// ---------------------------------------------------------------------------
// Guard state — the press edge, and what it arms
// ---------------------------------------------------------------------------

export interface GuardState {
  /** True while the block input is held down. */
  down: boolean;
  /** Sim time of the press edge that raised the current guard; -1 when down is false. */
  raisedAtS: number;
  /** True when the CURRENT raise is allowed to parry. See `PARRY_REARM_S`. */
  armed: boolean;
  /**
   * Sim time of the last raise that was allowed to arm.
   *
   * Starts at -Infinity so the very first raise of a session always arms, with
   * no special case and no dependence on what `simTime` happens to be after a
   * load.
   */
  lastArmedAtS: number;
}

export function createGuard(): GuardState {
  return { down: false, raisedAtS: -1, armed: false, lastArmedAtS: -Infinity };
}

/**
 * Feed the raw input state in. Call every tick, or on every input edge — both
 * work, because this only acts on TRANSITIONS.
 *
 * Returns true when this call was the press edge that raised the guard, so the
 * caller can fire a "shield up" cue without tracking the previous state itself.
 */
export function setGuardInput(g: GuardState, down: boolean, nowS: number): boolean {
  if (down === g.down) return false;
  if (down) {
    g.down = true;
    g.raisedAtS = nowS;
    g.armed = nowS - g.lastArmedAtS >= PARRY_REARM_S;
    if (g.armed) g.lastArmedAtS = nowS;
    return true;
  }
  g.down = false;
  g.raisedAtS = -1;
  g.armed = false;
  return false;
}

/**
 * Drop the guard unconditionally — death, a panel opening, pointer lock lost,
 * the pad being yanked out. Does NOT touch `lastArmedAtS`: releasing the button
 * must never be a way to buy a fresh parry window sooner than holding it.
 */
export function dropGuard(g: GuardState): void {
  g.down = false;
  g.raisedAtS = -1;
  g.armed = false;
}

/** True when a blow landing at `nowS` would be parried rather than blocked. */
export function parryReady(g: GuardState, nowS: number): boolean {
  if (!g.down || !g.armed) return false;
  const held = nowS - g.raisedAtS;
  return held >= 0 && held <= PARRY_WINDOW_S;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * What is arriving.
 *
 * `melee` is the only parryable class. `projectile` covers arrows and anything
 * else with a discrete impact; `breath` is a per-tick cone and is the only
 * class the shield does not stop outright.
 */
export type IncomingKind = 'melee' | 'projectile' | 'breath';

export type BlockKind = 'parry' | 'block' | 'through';

export type BlockReason =
  /** No shield in the pack at all. */
  | 'no-shield'
  /** Carrying one, not holding the button. */
  | 'not-raised'
  /** Raised, but the blow came from outside the frontal arc. */
  | 'flank'
  /** Raised and facing it, and not enough stamina left to brace. */
  | 'guard-break'
  /** Freshly raised inside the window. */
  | 'parried'
  /** Stopped dead. */
  | 'blocked'
  /** Fire, reduced but not stopped. */
  | 'mitigated';

export interface BlockOutcome {
  kind: BlockKind;
  reason: BlockReason;
  /** Multiply the incoming damage by this. 0 means nothing lands. */
  damageMul: number;
  /** Stamina the caller must drain. Always 0 for parries and for `through`. */
  staminaCost: number;
  /** Seconds of stagger to inflict on the attacker. Non-zero only on a parry. */
  staggerS: number;
  /** |bearing| to the attacker, radians. Diagnostics, harnesses, and the HUD. */
  bearing: number;
}

/** Everything about the defender at the moment of impact. */
export interface GuardContext {
  /** Best shield carried, or null. */
  tier: ShieldTier | null;
  guard: GuardState;
  /** Sim time of the impact. */
  nowS: number;
  stamina: number;
  /** Player facing, MESH convention (`atan2(dx, -dz)`) — `controller.yaw`. */
  facingYaw: number;
  px: number;
  pz: number;
}

/** Everything about the blow. */
export interface IncomingAttack {
  kind: IncomingKind;
  /** Attacker world XZ. For a projectile, the impact point works as well. */
  x: number;
  z: number;
  /** True for the Evil King and the black dragon — halves the parry stagger. */
  boss: boolean;
}

const THROUGH = (reason: BlockReason, bearing: number): BlockOutcome =>
  ({ kind: 'through', reason, damageMul: 1, staminaCost: 0, staggerS: 0, bearing });

/**
 * The single decision. Pure: it changes nothing, it only says what should
 * happen, and the caller owns every mutation that follows.
 *
 * ORDER MATTERS. The cone is tested before the parry, so a mistimed-but-lucky
 * press cannot parry something hitting you in the back; and the stamina check
 * comes AFTER the parry, because a parry costs nothing and an exhausted player
 * who reads the tell perfectly has earned it. That last one is the difference
 * between a stamina system that punishes bad defence and one that punishes
 * being in a long fight.
 */
export function resolveBlock(g: GuardContext, a: IncomingAttack): BlockOutcome {
  const bearing = blockBearing(g.facingYaw, g.px, g.pz, a.x, a.z);
  if (g.tier === null) return THROUGH('no-shield', bearing);
  if (!g.guard.down) return THROUGH('not-raised', bearing);
  if (bearing > BLOCK_CONE_HALF) return THROUGH('flank', bearing);

  const s = SHIELD_STATS[g.tier];

  if (a.kind === 'melee' && parryReady(g.guard, g.nowS)) {
    return {
      kind: 'parry', reason: 'parried',
      damageMul: 0, staminaCost: 0,
      staggerS: a.boss ? PARRY_STAGGER_BOSS_S : PARRY_STAGGER_S,
      bearing,
    };
  }

  // Bracing costs stamina, and you must have it BEFORE the blow, not after.
  // Charging the cost and then flooring at zero would let a player block one
  // free hit at 0.1 stamina, which is the exact moment the fiction says the
  // guard should break.
  if (g.stamina < s.staminaPerBlock) return THROUGH('guard-break', bearing);

  if (a.kind === 'breath') {
    return {
      kind: 'block', reason: 'mitigated',
      damageMul: 1 - s.fireMitigation,
      staminaCost: s.staminaPerBlock,
      staggerS: 0, bearing,
    };
  }

  return {
    kind: 'block', reason: 'blocked',
    damageMul: 0, staminaCost: s.staminaPerBlock,
    staggerS: 0, bearing,
  };
}

/**
 * The SFX id a resolved outcome should play, or null for silence.
 *
 * Here rather than at the call site because there are two damage paths in
 * `main.ts` (melee and projectiles) and they must not be free to disagree
 * about what a block sounds like.
 */
export function blockSfx(o: BlockOutcome): 'shield_block' | 'shield_parry' | null {
  if (o.kind === 'parry') return 'shield_parry';
  if (o.kind === 'block') return 'shield_block';
  return null;
}
