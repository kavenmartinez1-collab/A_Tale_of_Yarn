/**
 * Attack routing — who actually takes a hit aimed at the player.
 *
 * Pure module: no DOM, no GPU, node-testable.
 *
 * THE PROBLEM THIS SOLVES. Every attack in the game used to call
 * `damagePlayer` directly. That is correct on foot and wrong the moment the
 * player is thirty metres up on a dragon: a bear on the ground was still
 * swiping the rider out of the saddle. Two things were conflated — "an attack
 * happened near the player" and "the player was hit".
 *
 * THE RULES (in the owner's words, then as implemented):
 *
 *   "people will attack me when I'm mounted on a dragon and should only be
 *    able to hit me if they use arrows, bears will hit me on my dragon but
 *    they should only be hurting the dragon."
 *
 *   1. MELEE NEVER REACHES A MOUNTED RIDER. Claws and teeth land on the mount.
 *   2. RANGED ALWAYS REACHES THE RIDER. An archer can put an arrow in the
 *      saddle at any altitude the bow can carry to; flight is a trade-off, not
 *      an off-switch.
 *   3. HEIGHT GATES WHETHER MELEE CONNECTS AT ALL. A bear cannot claw a dragon
 *      that is 30 m up either. When the mount's body is beyond the attacker's
 *      reach, nothing happens.
 *
 * WHY MELEE ROUTES TO THE MOUNT EVEN WHEN THE MOUNT IS GROUNDED. A bear
 * rearing at a rider on a horse is not absurd, so this was a real choice. It
 * goes to the mount for three reasons. It is the only version of the rule a
 * player can see: a threshold that silently flips somewhere between 2 m and
 * 5 m of altitude reads as a bug, not as a mechanic. It is the rule the owner
 * stated, unconditionally. And it is what makes mounts matter — a mount is no
 * longer a movement upgrade with no downside but a body with its own hit
 * points that bleeds for you and can die under you. The height rule still
 * bites, in the place where it is legible: get high enough and the attack
 * misses everything.
 */

import { SPECIES_DEFS, type Species } from './entities/entity-types';

/** How an attack reaches its target. */
export type AttackReach = 'melee' | 'ranged';

/** Who ends up taking the damage. */
export type DamageTarget = 'player' | 'mount' | 'none';

/**
 * Floor on melee reach height (m) — roughly a person's overhead swing. Applies
 * even to small attackers so a wolf can still bite a rider's leg off a donkey.
 */
export const MIN_MELEE_REACH_HEIGHT = 2.0;

/**
 * How far above its own footing an attacker can land a melee blow, as a
 * multiple of its size (shoulder height). 2x approximates a rearing animal or
 * a raised weapon: a bear (size 1.8) reaches 3.6 m, a wolf (0.9) reaches the
 * 2.0 m floor.
 */
export const MELEE_REACH_SIZE_MUL = 2.0;

/** Melee reach height for an attacker of the given shoulder height. */
export function meleeReachHeight(size: number): number {
  return Math.max(MIN_MELEE_REACH_HEIGHT, size * MELEE_REACH_SIZE_MUL);
}

/** Melee reach height for a species. */
export function speciesMeleeReach(species: Species): number {
  return meleeReachHeight(SPECIES_DEFS[species].size);
}

/** The player's mount, as far as routing is concerned. */
export interface RiderState {
  /** Entity id of the mount being ridden, or null when on foot. */
  mountId: string | null;
  /** World Y of the mount's base (feet on the ground, belly in flight). */
  mountBaseY: number;
  /** Shoulder height of the mount (m) — SPECIES_DEFS[...].size. */
  mountSize: number;
}

/** The thing swinging or shooting. */
export interface AttackerState {
  /** Shoulder height (m). Drives melee reach. Ignored for ranged. */
  size: number;
  /** World Y the attacker is standing at. */
  y: number;
}

export interface Routing {
  target: DamageTarget;
  /** Short machine-readable cause, for tests and debugging. */
  reason: 'unmounted' | 'ranged-reaches-rider' | 'melee-hits-mount' | 'out-of-reach';
}

const ON_FOOT: Routing = { target: 'player', reason: 'unmounted' };
const RANGED_HIT: Routing = { target: 'player', reason: 'ranged-reaches-rider' };
const MOUNT_HIT: Routing = { target: 'mount', reason: 'melee-hits-mount' };
const NO_HIT: Routing = { target: 'none', reason: 'out-of-reach' };

/**
 * Decide who takes a hit aimed at the player.
 *
 * `rider.mountId === null` short-circuits to the player, so an unmounted
 * player takes melee exactly as before this module existed.
 */
export function routePlayerDamage(
  reach: AttackReach,
  attacker: AttackerState,
  rider: RiderState,
): Routing {
  if (rider.mountId === null) return ON_FOOT;
  if (reach === 'ranged') return RANGED_HIT;

  // Melee. The attacker has to be able to reach the mount's body at all: the
  // bar is the mount's base (its legs / underside), not the saddle, because
  // that is the part a ground attacker is actually swinging at.
  const rise = rider.mountBaseY - attacker.y;
  if (rise > meleeReachHeight(attacker.size)) return NO_HIT;
  return MOUNT_HIT;
}

/**
 * Convenience wrapper for the common case: an animal attacking the player.
 * Ranged attackers pass reach 'ranged' and their size is irrelevant.
 */
export function routeSpeciesAttack(
  species: Species,
  attackerY: number,
  rider: RiderState,
  reach: AttackReach = 'melee',
): Routing {
  return routePlayerDamage(reach, { size: SPECIES_DEFS[species].size, y: attackerY }, rider);
}

/**
 * Saddle height above the mount's base — where the rider actually sits.
 * Kept here so the routing tests and main.ts agree on one definition.
 */
export function saddleHeight(mountSize: number): number {
  return mountSize;
}
