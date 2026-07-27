/**
 * Animal AI — per-entity state machine stepped each simulation tick.
 *
 * Pure module: no DOM, no GPU. Node-testable.
 *
 * LOD tiers (by playerDist):
 *   > 200 m  → skip (no update)
 *   80–200 m → slow wander: drift around home, walkAmp low
 *   < 80 m   → full state machine
 *
 * Modes:
 *   idle    — stand still for 2–6 s, then transition to graze or wander
 *   graze   — slow random micro-steps, stays near home
 *   wander  — pick a point within 24 m of home, walk to it
 *   flee    — non-aggro species when player < 12 m or after taking damage:
 *             run at speed×1.4 away from player for 4 s
 *   aggro   — aggro species when player < 16 m or after taking damage:
 *             walk toward player; attack every 1.2 s when within 2.5 m
 *   defend  — OWNED animals only: intercept and attack a hostile that is
 *             coming after the player. Falls back to follow when the threat
 *             is gone. Owned animals never enter 'aggro'.
 *   dead    — no AI
 */

import {
  SPECIES_DEFS, dispositionOf, type Species, type SpeciesDef,
} from './entity-types';
import { animalStride } from './animal-mesh';
import { meleeReachHeight } from '../attack-routing';
import type { EntityState } from './entity-manager';
import {
  CombatIndex, HUNT_SIGHT, RETARGET_S, courageOf, factionOf,
  type CombatTarget,
} from './combat-targeting';

export { CombatIndex, type CombatTarget, type NpcTarget } from './combat-targeting';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOD_SKIP_DIST   = 200; // m — no update beyond this
const LOD_SLOW_DIST   = 80;  // m — slow wander between 80–200 m

const FLEE_TRIGGER_DIST  = 12;  // m — non-aggro flees when closer
const AGGRO_TRIGGER_DIST = 16;  // m — aggro attacks when closer
const ATTACK_DIST        = 2.5; // m — melee contact distance
const FLEE_SPEED_MUL     = 1.4; // flee speed multiplier
const FLEE_DURATION_S    = 4;   // s

const ATTACK_COOLDOWN_S  = 1.2; // s between bite/swipe ticks

/**
 * Territorial rares (untamed dragons / griffins): entering this radius around
 * the animal's home provokes an attack, and it keeps pursuing until the player
 * leaves the territory (plus hysteresis) — then it walks back home.
 */
export const TERRITORY_RADIUS = 50;  // m around home
const TERRITORY_HYSTERESIS   = 8;    // m beyond the edge before it gives up
const TERRITORY_RETURN_S     = 30;   // s cap on the walk-home leg

const WANDER_RADIUS      = 24;  // m around home
const IDLE_MIN_S         = 2;
const IDLE_MAX_S         = 6;

const TERRAIN_STEP_DIST  = 0.5; // m — how far we probe terrain ahead

/** Phase K: owned babies follow the player within this radius. */
export const FOLLOW_RADIUS = 30; // m
/** Phase K: owned babies stop walking when this close to the player. */
const FOLLOW_STOP_DIST = 2.5;   // m

/**
 * Owned animals defend their owner.
 *
 * A tamed mount that watches a bear maul its owner is not a companion, it is
 * scenery — and the owner asked for the opposite: "mounts should attack all
 * hostile mobs coming after the players". An owned animal breaks off follow to
 * intercept anything the caller nominates as a threat.
 *
 * Reach scales with the defender because a dragon's jaws start 3.5 m from its
 * origin; a flat 2.5 m contact distance (the wild-animal number) would leave a
 * dragon standing on top of a wolf, unable to bite it.
 */
const DEFEND_BASE_REACH = 2.5;     // m — contact distance, plus the defender's size
/** Defenders give up and return to their owner past this range. */
export const DEFEND_GIVEUP_DIST = 45; // m from the defender to its target
/** Seconds between a defender's bites/swipes. Matches wild aggro cadence. */
const DEFEND_COOLDOWN_S = ATTACK_COOLDOWN_S;

// ---------------------------------------------------------------------------
// Mob-vs-mob combat
// ---------------------------------------------------------------------------

/**
 * A hunt gives up after this long no matter what.
 *
 * Every chase must be able to end. Without a hard cap, one badly-placed pair
 * — a wolf and a deer either side of a rock the pathless `moveToward` cannot
 * get round — pins two entities in a loop for the rest of the session, and it
 * is invisible until somebody walks past and sees them vibrating.
 */
const HUNT_MAX_S = 18;

/** A hunter that has not closed at all for this long drops its target. */
const HUNT_STALL_S = 4.5;

/** How much closer it must have got in `HUNT_STALL_S` to count as progress. */
const HUNT_PROGRESS_M = 1.5;

/** Beyond this, a hunter loses interest whatever the timer says. */
const HUNT_GIVEUP_DIST = 42; // m

/** After a failed or finished hunt, no new target for this long. */
const HUNT_COOLDOWN_S = 7;

/**
 * Prey that has been attacked by another creature runs for this long.
 *
 * Longer than the player-triggered `FLEE_DURATION_S`, because a predator
 * pursues and the player usually does not — 4 s of running from a wolf that is
 * still coming just resets the fight a metre further on.
 */
const PREY_FLEE_S = 7;

/**
 * AI-private state, carried on the entity by cast rather than declared on
 * `EntityState`.
 *
 * This is the house pattern already used for `_wanderTX` / `_wanderTZ`: these
 * fields belong to this module, no other system reads them, and widening the
 * shared interface for them would invite exactly that. Every one is optional
 * and absent-means-neutral, so an entity created anywhere in the codebase is
 * valid input on its first tick.
 */
type CombatState = EntityState & {
  /** Current mob-vs-mob target id, or absent for none. */
  _targetId?: string;
  /** Seconds until this creature may scan for a target again. */
  _retargetIn?: number;
  /** Seconds of hunt remaining before it gives up. */
  _huntTimer?: number;
  /** Seconds before it may acquire a new target after a failed hunt. */
  _huntCooldown?: number;
  /** Distance to the target at the last stall check. */
  _stallDist?: number;
  /** Seconds since the last stall check. */
  _stallTimer?: number;
  /** Distance to the current combat target, for the animation driver. */
  _targetDist?: number;
  /** True while this creature would rather be airborne (fliers). */
  _wantsAir?: boolean;
  /** What it is running from, when that is not the player. */
  _fleeFromX?: number;
  _fleeFromZ?: number;
};

/** A ranged attack this creature is loosing right now. */
export interface RangedShot {
  /** What is being shot at. */
  kind: 'player' | 'entity' | 'npc';
  /** Target id for entity/npc; absent for the player. */
  id?: string;
  /** Aim point in world space. Y is already raised to chest height. */
  x: number;
  y: number;
  z: number;
  damage: number;
}

/** Melee reach for a species: the shared contact distance plus its weapon. */
export function attackReach(def: SpeciesDef): number {
  return ATTACK_DIST + (def.reachBonus ?? 0);
}

/** Seconds between blows for a species. */
export function attackCadence(def: SpeciesDef): number {
  return def.attackCooldown ?? ATTACK_COOLDOWN_S;
}

/**
 * True when this creature is currently in a fight with something.
 *
 * Exported because three separate systems need the same answer and were about
 * to grow three copies of the mode list: the animation driver decides whether
 * to play attack clips from it, the mount-defence scan in `main.ts` picks
 * threats from it, and the tests assert on it.
 */
export function isFighting(e: EntityState): boolean {
  return e.mode === 'aggro' || e.mode === 'hunt' || e.mode === 'defend';
}

/**
 * Distance to whatever this creature is currently fighting.
 *
 * The animation driver is handed the distance to the PLAYER, which is the
 * wrong number for a wolf mauling a deer twenty metres away — it would sit in
 * `alert` and never swing. This is the right number when it exists.
 */
export function combatDistance(e: EntityState): number | undefined {
  return (e as CombatState)._targetDist;
}

/**
 * True when this flier would rather be in the air than walking.
 *
 * Wild fliers currently walk everywhere; the altitude controller that fixes
 * that lives in `main.ts` and is not this module's business. What this module
 * knows and `main.ts` does not is whether the creature has decided to cross
 * open ground to reach something. Exposed as a predicate so the two can agree
 * without either owning the other's state.
 */
export function wantsAirborne(e: EntityState): boolean {
  return (e as CombatState)._wantsAir === true;
}

// ---------------------------------------------------------------------------
// Context passed in from main.ts
// ---------------------------------------------------------------------------

export interface AnimalAICtx {
  playerX: number;
  playerZ: number;
  playerDist: number;   // pre-computed Math.hypot distance
  /**
   * The player's feet, when the caller knows them.
   *
   * Optional, and absent means "no vertical gate" — exactly the behaviour every
   * caller had before this field existed, which is why adding it broke nothing.
   *
   * With it, melee stops being a purely horizontal question. `playerDist` is
   * measured in the XZ plane, so a creature standing under a keep floor or at
   * the foot of a parapet is "0 m away" and swings straight up through the
   * masonry. That is not a castle bug and not new — every aggro animal in the
   * game does it from the bottom of a cliff — but it only became visible when
   * the Evil King started fighting: he is the one enemy with 4.9 m of reach and
   * a tower to stand under, and `scripts/king-melee-check.mjs` measured him
   * taking 8.8 hp off a player two storeys above him through 16 m of keep.
   */
  playerY?: number;
  rng: () => number;
  heightAt: (x: number, z: number) => number;
  /**
   * Optional collision-aware XZ move (the player's layered GroundQuery).
   * When provided, animals slide along settlement walls instead of phasing
   * through buildings. Falls back to free movement when absent.
   */
  moveXZ?: (x: number, z: number, dx: number, dz: number, r: number) => [number, number];
  speciesDef: SpeciesDef;
  onAttackPlayer: (damage: number) => void;
  /**
   * OWNED animals only: the hostile this defender should intercept, or null /
   * absent for none. The caller picks the target (it is the only place that
   * can see every entity), this module only decides how to close and when to
   * bite. Ignored entirely for wild animals.
   */
  defendTarget?: DefendTarget | null;
  /**
   * Land a hit on another entity. Required for 'defend' to do any damage —
   * without it a defender will still posture and chase but never connect,
   * which is the safe degradation for callers that have not wired it up.
   */
  onAttackEntity?: (targetId: string, damage: number) => void;

  // -------------------------------------------------------------------------
  // Mob-vs-mob. All optional; omitting them reproduces the old
  // player-is-the-only-target behaviour exactly.
  // -------------------------------------------------------------------------

  /**
   * Every fightable thing near the player, rebuilt ONCE per tick by the
   * caller and shared by every entity stepped that tick.
   *
   * Absent means "no mob-vs-mob combat here" — which is the correct
   * degradation, not a bug: a caller that has not built an index gets exactly
   * the behaviour it had before this feature existed.
   */
  combat?: CombatIndex | null;

  /**
   * Land a hit on an NPC.
   *
   * Separate from `onAttackEntity` because the two have completely different
   * consequences on the caller's side: an NPC struck by wildlife must NOT
   * raise a crime bounty or record a player deed, and routing it through the
   * existing player-assault path would do both.
   */
  onAttackNpc?: (npcId: string, damage: number) => void;

  /**
   * A ranged attack is being loosed. The caller spawns the projectile (or
   * breath cone) and applies the damage.
   *
   * One seam for two features: the goblin archer's arrows and the breath
   * weapon that wild dragons/wyverns have never used. Without it a ranged
   * attacker still closes and fights in melee, so the species is playable
   * before the caller wires anything up.
   */
  onRangedAttack?: (e: EntityState, shot: RangedShot) => void;
}

/** A hostile an owned animal has been asked to deal with. */
export interface DefendTarget {
  id: string;
  x: number;
  z: number;
}

type MoveXZ = NonNullable<AnimalAICtx['moveXZ']>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Attack damage for a species: attackDmg, else max(1, round(size)). */
export function aggroDamage(species: Species): number {
  const def = SPECIES_DEFS[species];
  return def.attackDmg ?? Math.max(1, Math.round(def.size));
}

/** Move entity toward (tx, tz) at given speed, clamped to terrain. */
function moveToward(
  e: EntityState,
  tx: number,
  tz: number,
  speed: number,
  dtS: number,
  heightAt: (x: number, z: number) => number,
  isWater: boolean,
  moveXZ?: MoveXZ,
  radius = 0.4,
): void {
  const dx = tx - e.x;
  const dz = tz - e.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.05) return;

  const nx = dx / dist;
  const nz = dz / dist;
  const step = speed * dtS;

  if (moveXZ !== undefined) {
    [e.x, e.z] = moveXZ(e.x, e.z, nx * step, nz * step, radius);
  } else {
    e.x += nx * step;
    e.z += nz * step;
  }
  e.yaw = Math.atan2(nx, -nz); // facing direction: yaw 0 = -Z
  // Advance the gait by exactly one cycle per stride of ground covered.
  //
  // This was a flat 1.6 rad/m for every species, which meant a rabbit and a
  // dragon took the same length step: one cycle per 3.9 m. A rabbit covers
  // that in roughly ten strides, so its legs barely twitched while it slid
  // across the map. It also guarantees skating now that feet are planted —
  // `animalStride` is the single shared definition the mesh solves against.
  e.walkPhase += (step / animalStride(e.species)) * Math.PI * 2;

  // Clamp y to terrain.
  if (isWater) {
    e.y = -0.5;
  } else {
    e.y = heightAt(e.x, e.z);
  }
}

/** Move entity away from (fx, fz) at given speed. */
function moveAway(
  e: EntityState,
  fx: number,
  fz: number,
  speed: number,
  dtS: number,
  heightAt: (x: number, z: number) => number,
  isWater: boolean,
  moveXZ?: MoveXZ,
  radius = 0.4,
): void {
  const dx = e.x - fx;
  const dz = e.z - fz;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.01) {
    // Exactly on top: flee in +X direction.
    moveToward(e, e.x + 10, e.z, speed, dtS, heightAt, isWater, moveXZ, radius);
    return;
  }
  const nx = dx / dist;
  const nz = dz / dist;
  moveToward(e, e.x + nx * 100, e.z + nz * 100, speed, dtS, heightAt, isWater, moveXZ, radius);
}

/** Pick a random wander target within WANDER_RADIUS of home. */
function randomWanderTarget(
  homeX: number,
  homeZ: number,
  rng: () => number,
): [number, number] {
  const angle = rng() * Math.PI * 2;
  const r = rng() * WANDER_RADIUS;
  return [homeX + Math.cos(angle) * r, homeZ + Math.sin(angle) * r];
}

// ---------------------------------------------------------------------------
// Mob-vs-mob helpers
// ---------------------------------------------------------------------------

/** Drop the current target and start the re-acquire cooldown. */
function abandonHunt(c: CombatState, cooldown = HUNT_COOLDOWN_S): void {
  c._targetId = undefined;
  c._targetDist = undefined;
  c._huntTimer = undefined;
  c._stallDist = undefined;
  c._stallTimer = undefined;
  c._huntCooldown = cooldown;
  c._wantsAir = false;
}

/**
 * Pick something to fight, if this creature is minded to and is due a scan.
 *
 * Rate-limited and staggered: a creature scans at most every `RETARGET_S`, and
 * its first scan is offset by a hash of its id so a herd that spawned on the
 * same frame does not scan on the same frame forever after. Scanning is the
 * only part of mob combat whose cost scales with crowd size, so it is the only
 * part that is rationed.
 */
function maybeAcquire(
  e: EntityState, dtS: number, ctx: AnimalAICtx, def: SpeciesDef,
): CombatTarget | null {
  const combat = ctx.combat;
  if (combat === undefined || combat === null) return null;
  const c = e as CombatState;

  if (c._huntCooldown !== undefined && c._huntCooldown > 0) {
    c._huntCooldown -= dtS;
    return null;
  }
  if (c._retargetIn === undefined) {
    // Stagger the first scan across the interval, deterministically.
    let h = 0x811c9dc5;
    for (let i = 0; i < e.id.length; i++) {
      h ^= e.id.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    c._retargetIn = ((h >>> 0) % 1000) / 1000 * RETARGET_S;
  }
  c._retargetIn -= dtS;
  if (c._retargetIn > 0) return null;
  c._retargetIn = RETARGET_S;

  const disposition = dispositionOf(def);
  if (disposition === 'timid') return null;

  const allies = def.fearless === true
    ? 0
    : combat.alliesNear(e.x, e.z, factionOf(e.species), e.id);
  const courage = courageOf(e.species, allies, def.fearless === true);

  // Territorial species (the three fliers) hunt only inside their own ground.
  // One rule, two payoffs: a nesting dragon does not chase a deer half a
  // kilometre across the map, AND the only way to get a wild flier to fight a
  // tamed one is to fly the tamed one into its territory — which is a thing
  // the player did, can see coming, and can turn around from.
  const sight = isTerritorialDef(def)
    ? Math.min(HUNT_SIGHT, TERRITORY_RADIUS)
    : HUNT_SIGHT;
  const pick = combat.pick(e, disposition, courage, sight);
  if (pick === null) return null;
  if (isTerritorialDef(def)
      && Math.hypot(pick.x - e.homeX, pick.z - e.homeZ) > TERRITORY_RADIUS) {
    return null;
  }
  return pick;
}

/** Rare, aggressive land species defend ground rather than merely themselves. */
function isTerritorialDef(def: SpeciesDef): boolean {
  return def.rare && def.aggro && def.water !== true;
}

/**
 * Has this creature lost its nerve?
 *
 * Health alone is not enough — a goblin with two friends beside it does not
 * break, and that difference is the most legible thing about the species. A
 * `fearless` creature never asks the question at all.
 */
function brokenMorale(
  e: EntityState, def: SpeciesDef, ctx: AnimalAICtx,
): boolean {
  if (def.fearless === true || def.morale === undefined) return false;
  if (e.hp > def.hp * def.morale) return false;
  const combat = ctx.combat;
  if (combat === undefined || combat === null) return true;
  return combat.alliesNear(e.x, e.z, factionOf(e.species), e.id) < 1;
}

/**
 * Close on a target and hit it. Shared by `hunt` and the ranged path.
 *
 * Returns true while the creature is engaged; false when the fight is over
 * and the caller should fall back to wandering.
 */
function engage(
  e: EntityState,
  dtS: number,
  ctx: AnimalAICtx,
  def: SpeciesDef,
  tx: number,
  tz: number,
  onHit: () => void,
  isWater: boolean,
  collide: MoveXZ | undefined,
  radius: number,
  /**
   * How far above (or below) this creature's own footing the target stands, or
   * null when the caller cannot say. Null reproduces the old horizontal-only
   * behaviour exactly, which is what every mob-vs-mob call still passes: a
   * `CombatTarget` carries x and z and no y, and inventing one for it would be
   * a guess dressed as a measurement.
   */
  rise: number | null,
): void {
  const c = e as CombatState;
  const reach = attackReach(def);
  const dx = tx - e.x, dz = tz - e.z;
  const dist = Math.hypot(dx, dz);
  c._targetDist = dist;

  const ranged = def.rangedRange ?? 0;
  if (ranged > 0) {
    // Ranged attackers want a band, not contact. Too close and they give up
    // their whole advantage; too far and they cannot hit. `hold` is where they
    // try to stand.
    const hold = ranged * 0.62;
    if (dist > 0.001) e.yaw = Math.atan2(dx / dist, -(dz / dist));
    if (dist > ranged) {
      moveToward(e, tx, tz, def.speed, dtS, ctx.heightAt, isWater, collide, radius);
      return;
    }
    if (dist < hold * 0.72) {
      // Back off, still facing the target — a kiting archer that turns its
      // back reads as fleeing, which is a completely different animation and a
      // completely different threat.
      const nx = dx / Math.max(dist, 0.001), nz = dz / Math.max(dist, 0.001);
      const step = def.speed * 0.85 * dtS;
      if (collide !== undefined) {
        [e.x, e.z] = collide(e.x, e.z, -nx * step, -nz * step, radius);
      } else {
        e.x -= nx * step; e.z -= nz * step;
      }
      e.walkPhase += (step / animalStride(e.species)) * Math.PI * 2;
      e.y = isWater ? -0.5 : ctx.heightAt(e.x, e.z);
    }
    // In the band (or backing off): shoot on cadence.
    //
    // Deliberately the SAME `stateTimer` the melee path uses, not a private
    // ranged timer. `creature-anim.ts` infers the contact frame from that
    // field — it starts the draw when `stateTimer <= contactT` and detects the
    // release from the timer jumping back up. A separate countdown would leave
    // it permanently satisfied, and the archer would loop its draw animation
    // continuously while arrows left on some other schedule.
    e.stateTimer -= dtS;
    if (e.stateTimer <= 0) {
      onHit();
      e.stateTimer = attackCadence(def);
    }
    return;
  }

  // A blow has to cross the gap in Y as well as in XZ. `meleeReachHeight` is
  // the same vertical reach `attack-routing.ts` already applies to a MOUNTED
  // player — "how far from its own footing can this thing put a weapon" — and
  // applying it on foot too is the rule that was always meant, minus the
  // assumption that a player standing on their own feet is level with whatever
  // is swinging at them.
  const grounded = rise === null || Math.abs(rise) <= meleeReachHeight(def.size);

  if (dist <= reach && grounded) {
    e.stateTimer -= dtS;
    if (e.stateTimer <= 0) {
      onHit();
      e.stateTimer = attackCadence(def);
    }
    if (dist > 0.001) e.yaw = Math.atan2(dx / dist, -(dz / dist));
    e.y = isWater ? -0.5 : ctx.heightAt(e.x, e.z);
  } else if (dist <= reach) {
    // Underneath them, or above them, and no way to close it: face them and
    // wait. Walking is pointless here — `moveToward` would only push at the
    // wall it is already against.
    //
    // Holding the swing clock at a full cadence is NOT cosmetic. `creature-
    // anim.ts` starts the windup when `stateTimer` counts down to the move's
    // `contactT`, and `stepAnimal` enters 'aggro' with that timer at zero — so
    // a blocked creature whose clock never moved would satisfy that test on
    // every single frame and stand under the parapet swinging at the ceiling
    // for as long as the player cared to watch.
    e.stateTimer = attackCadence(def);
    if (dist > 0.001) e.yaw = Math.atan2(dx / dist, -(dz / dist));
    e.y = isWater ? -0.5 : ctx.heightAt(e.x, e.z);
  } else {
    moveToward(e, tx, tz, def.speed, dtS, ctx.heightAt, isWater, collide, radius);
  }
}

// ---------------------------------------------------------------------------
// stepAnimal
// ---------------------------------------------------------------------------

/**
 * Advance one entity's AI by dtS seconds.
 * Returns true if the entity performed a player-attack this tick.
 */
export function stepAnimal(
  e: EntityState,
  dtS: number,
  ctx: AnimalAICtx,
): void {
  if (e.mode === 'dead') return;

  const { playerX, playerZ, playerDist, rng, heightAt, moveXZ, speciesDef, onAttackPlayer } = ctx;
  const isWater = speciesDef.water === true;
  const speed   = speciesDef.speed;
  // Collision radius scales with the animal; water species skip solids entirely.
  const radius  = Math.max(0.3, speciesDef.size * 0.45);
  const collide = isWater ? undefined : moveXZ;


  // ---- Owned stay/sit (right-click toggle) ---------------------------------
  // sit eases 0<->1 over ~0.4 s; while staying the entity holds position and
  // skips all follow/wander logic regardless of LOD distance.
  if (e.owned === true) {
    const sitTarget = e.staying === true ? 1 : 0;
    const cur = e.sit ?? 0;
    if (cur !== sitTarget) {
      const step = dtS / 0.4;
      e.sit = cur < sitTarget ? Math.min(sitTarget, cur + step) : Math.max(sitTarget, cur - step);
    }
    if (e.staying === true) {
      e.y = isWater ? -0.5 : heightAt(e.x, e.z);
      e.homeX = e.x;
      e.homeZ = e.z;
      return;
    }
  }

  // ---- LOD: skip if too far ------------------------------------------------
  if (playerDist > LOD_SKIP_DIST) return;

  // ---- LOD: slow wander if moderately far ----------------------------------
  if (playerDist > LOD_SLOW_DIST) {
    // Drift slowly back toward home, low walk amplitude.
    const distHome = Math.hypot(e.x - e.homeX, e.z - e.homeZ);
    if (distHome > 8) {
      moveToward(e, e.homeX, e.homeZ, speed * 0.3, dtS, heightAt, isWater, collide, radius);
    }
    // Keep y synced.
    e.y = isWater ? -0.5 : heightAt(e.x, e.z);
    return;
  }

  // ---- Full state machine (playerDist <= LOD_SLOW_DIST) --------------------

  // Phase K: owned entities (babies) only follow the player — never flee or aggro.
  const isOwned = (e as EntityState & { owned?: boolean }).owned === true;

  // Territorial rares defend the ground around their home, not just their
  // person. Water rares (sea serpent) keep the plain proximity trigger.
  const isTerritorial = speciesDef.rare && speciesDef.aggro && !isWater;
  const playerDistHome = Math.hypot(playerX - e.homeX, playerZ - e.homeZ);
  const cs = e as CombatState;

  // ---- Mob-vs-mob acquisition ---------------------------------------------
  //
  // Deliberately OUTSIDE the owned branch. A tamed mount must never pick its
  // own fights, and above all must never pick one with its rider: the player
  // is not in the combat index at all, and `isOwned` short-circuits the whole
  // aggro path below, so there are two independent reasons a mount cannot turn
  // on the person riding it. A test asserts both.
  if (!isOwned) {
    if (e.mode === 'idle' || e.mode === 'graze' || e.mode === 'wander') {
      // The player does NOT interrupt a fight already in progress — see the
      // 'hunt' case. Acquisition only happens from a peaceful mode, which is
      // the same rule the aggro promotion below has always used.
      const provokedByPlayer = speciesDef.aggro && (isTerritorial
        ? playerDistHome <= TERRITORY_RADIUS
        : playerDist <= AGGRO_TRIGGER_DIST);
      if (!provokedByPlayer) {
        const target = maybeAcquire(e, dtS, ctx, speciesDef);
        if (target !== null) {
          cs._targetId = target.id;
          cs._huntTimer = HUNT_MAX_S;
          cs._stallDist = Math.hypot(target.x - e.x, target.z - e.z);
          cs._stallTimer = 0;
          e.mode = 'hunt';
          e.stateTimer = 0; // swing as soon as it arrives
        }
      }
    }
    // Lost your nerve mid-fight? Break off. Checked for both 'hunt' and
    // 'aggro', so a wounded lone goblin runs from the player too — which is
    // the whole point of the trait and would look arbitrary if it only
    // applied to one of them.
    if ((e.mode === 'hunt' || e.mode === 'aggro') && brokenMorale(e, speciesDef, ctx)) {
      abandonHunt(cs);
      e.mode = 'flee';
      e.fleeTimer = PREY_FLEE_S;
    }
  }

  if (isOwned) {
    // Owned animals never flee and never aggro the player. They either guard
    // them or trail them. A nominated threat wins; anything else is follow.
    const threat = ctx.defendTarget ?? null;
    const threatFar = threat !== null
      && Math.hypot(threat.x - e.x, threat.z - e.z) > DEFEND_GIVEUP_DIST;
    if (threat !== null && !threatFar) {
      if (e.mode !== 'defend') {
        e.mode = 'defend';
        e.stateTimer = 0; // swing as soon as it is in reach
      }
    } else {
      e.mode = 'follow';
    }
  } else {
    // --- Check flee/aggro triggers (transition override) ----------------------
    // (mode !== 'dead' already guaranteed by the early return above)
    if (speciesDef.aggro) {
      // Aggro species: enter aggro when player close enough (territorial:
      // when the player sets foot anywhere inside the territory).
      const provoked = isTerritorial
        ? playerDistHome <= TERRITORY_RADIUS
        : playerDist <= AGGRO_TRIGGER_DIST;
      if ((e.mode === 'idle' || e.mode === 'graze' || e.mode === 'wander')
          && provoked) {
        e.mode = 'aggro';
        e.stateTimer = 0;
      }
    } else {
      // Non-aggro species: flee when player close.
      if ((e.mode === 'idle' || e.mode === 'graze' || e.mode === 'wander')
          && playerDist <= FLEE_TRIGGER_DIST) {
        e.mode = 'flee';
        e.fleeTimer = FLEE_DURATION_S;
      }
    }
  }

  // --- Per-mode behaviour ---------------------------------------------------
  switch (e.mode) {
    case 'idle': {
      // Stand still; count down stateTimer.
      e.stateTimer -= dtS;
      if (e.stateTimer <= 0) {
        // Transition to graze or wander.
        if (rng() < 0.4) {
          e.mode = 'graze';
          e.stateTimer = IDLE_MIN_S + rng() * (IDLE_MAX_S - IDLE_MIN_S);
        } else {
          e.mode = 'wander';
          const [wx, wz] = randomWanderTarget(e.homeX, e.homeZ, rng);
          // Store wander target in stateTimer-adjacent fields by repurposing them.
          // We encode target as offset to avoid extra fields: store as property extension.
          (e as EntityState & { _wanderTX?: number; _wanderTZ?: number })._wanderTX = wx;
          (e as EntityState & { _wanderTX?: number; _wanderTZ?: number })._wanderTZ = wz;
          e.stateTimer = 8; // max wander time (safety timeout)
        }
      }
      e.y = isWater ? -0.5 : heightAt(e.x, e.z);
      break;
    }

    case 'graze': {
      // Slow micro-steps.
      e.stateTimer -= dtS;
      if (e.stateTimer <= 0) {
        e.mode = 'idle';
        e.stateTimer = IDLE_MIN_S + rng() * (IDLE_MAX_S - IDLE_MIN_S);
        break;
      }
      // Occasional tiny step.
      if (rng() < 0.015) {
        const angle = rng() * Math.PI * 2;
        const dist = 0.5 + rng() * 1.5;
        const tx = e.x + Math.cos(angle) * dist;
        const tz = e.z + Math.sin(angle) * dist;
        // Don't stray too far from home.
        if (Math.hypot(tx - e.homeX, tz - e.homeZ) < WANDER_RADIUS * 0.5) {
          moveToward(e, tx, tz, speed * 0.3, dtS * 8, heightAt, isWater, collide, radius);
        }
      }
      e.y = isWater ? -0.5 : heightAt(e.x, e.z);
      break;
    }

    case 'wander': {
      const ext = e as EntityState & { _wanderTX?: number; _wanderTZ?: number };
      const tx = ext._wanderTX ?? e.homeX;
      const tz = ext._wanderTZ ?? e.homeZ;
      const distToTarget = Math.hypot(e.x - tx, e.z - tz);

      e.stateTimer -= dtS;
      if (distToTarget < 1.0 || e.stateTimer <= 0) {
        e.mode = 'idle';
        e.stateTimer = IDLE_MIN_S + rng() * (IDLE_MAX_S - IDLE_MIN_S);
        break;
      }

      moveToward(e, tx, tz, speed * 0.6, dtS, heightAt, isWater, collide, radius);
      break;
    }

    case 'flee': {
      e.fleeTimer -= dtS;
      if (e.fleeTimer <= 0) {
        e.mode = 'idle';
        e.stateTimer = IDLE_MIN_S + rng() * (IDLE_MAX_S - IDLE_MIN_S);
        cs._fleeFromX = undefined;
        cs._fleeFromZ = undefined;
        break;
      }
      // Run from whatever actually frightened it. Fleeing the player while a
      // wolf eats you is the sort of thing that is obviously wrong on screen
      // and completely invisible in a state dump. The flee origin TRACKS the
      // attacker while it is still nearby, so prey does not sprint back past
      // a predator that has circled round.
      let fx = playerX, fz = playerZ;
      if (cs._fleeFromX !== undefined && cs._fleeFromZ !== undefined) {
        const src = ctx.combat?.get(cs._targetId ?? '') ?? null;
        if (src !== null) { cs._fleeFromX = src.x; cs._fleeFromZ = src.z; }
        fx = cs._fleeFromX; fz = cs._fleeFromZ;
      }
      moveAway(e, fx, fz, speed * FLEE_SPEED_MUL, dtS, heightAt, isWater, collide, radius);
      break;
    }

    case 'aggro': {
      // Walk toward player.
      const escaped = isTerritorial
        ? playerDistHome > TERRITORY_RADIUS + TERRITORY_HYSTERESIS
        : playerDist > AGGRO_TRIGGER_DIST * 2;
      if (escaped) {
        if (isTerritorial) {
          // Player left the territory — walk back home.
          const ext = e as EntityState & { _wanderTX?: number; _wanderTZ?: number };
          ext._wanderTX = e.homeX;
          ext._wanderTZ = e.homeZ;
          e.mode = 'wander';
          e.stateTimer = TERRITORY_RETURN_S;
        } else {
          e.mode = 'idle';
          e.stateTimer = IDLE_MIN_S + rng() * (IDLE_MAX_S - IDLE_MIN_S);
        }
        break;
      }

      cs._targetDist = playerDist;
      cs._wantsAir = speciesDef.canFly === true && playerDist > 18;
      engage(e, dtS, ctx, speciesDef, playerX, playerZ, () => {
        const ranged = speciesDef.rangedRange ?? 0;
        if (ranged > 0 && ctx.onRangedAttack !== undefined) {
          ctx.onRangedAttack(e, {
            kind: 'player',
            x: playerX, y: heightAt(playerX, playerZ) + 1.0, z: playerZ,
            damage: speciesDef.rangedDmg ?? aggroDamage(e.species),
          });
          return;
        }
        onAttackPlayer(ranged > 0
          ? (speciesDef.rangedDmg ?? aggroDamage(e.species))
          : aggroDamage(e.species));
      }, isWater, collide, radius,
      ctx.playerY === undefined ? null : ctx.playerY - e.y);
      break;
    }

    case 'hunt': {
      // Fighting something that is not the player.
      //
      // Note what is NOT here: no check for the player's proximity. A wolf
      // that has committed to a deer does not drop it because somebody walked
      // past, and a world where every fight stops to look at you is a world
      // that revolves around you. The player still interrupts a hunt the
      // honest way — by hitting the wolf, which routes through
      // `onEntityDamaged` below.
      const combat = ctx.combat ?? null;
      const target = combat === null || cs._targetId === undefined
        ? null : combat.get(cs._targetId);

      // Every exit from a hunt, in one place. A chase that cannot end is the
      // failure mode this whole feature risks, and it is invisible until
      // somebody walks past two entities vibrating against each other.
      cs._huntTimer = (cs._huntTimer ?? HUNT_MAX_S) - dtS;
      if (target === null || cs._huntTimer <= 0) {
        abandonHunt(cs);
        e.mode = 'idle';
        e.stateTimer = IDLE_MIN_S + rng() * (IDLE_MAX_S - IDLE_MIN_S);
        break;
      }

      const tdist = Math.hypot(target.x - e.x, target.z - e.z);
      if (tdist > HUNT_GIVEUP_DIST) {
        abandonHunt(cs);
        e.mode = 'idle';
        e.stateTimer = IDLE_MIN_S + rng() * (IDLE_MAX_S - IDLE_MIN_S);
        break;
      }

      // Stall detection: a hunter that has not closed at all in
      // HUNT_STALL_S has hit something `moveToward` cannot path around — a
      // rock, a wall, a room clamp. Give up rather than push at it forever.
      cs._stallTimer = (cs._stallTimer ?? 0) + dtS;
      if (cs._stallTimer >= HUNT_STALL_S) {
        const before = cs._stallDist ?? tdist;
        if (before - tdist < HUNT_PROGRESS_M && tdist > attackReach(speciesDef)) {
          abandonHunt(cs);
          e.mode = 'idle';
          e.stateTimer = IDLE_MIN_S + rng() * (IDLE_MAX_S - IDLE_MIN_S);
          break;
        }
        cs._stallTimer = 0;
        cs._stallDist = tdist;
      }

      cs._wantsAir = speciesDef.canFly === true && tdist > 18;

      engage(e, dtS, ctx, speciesDef, target.x, target.z, () => {
        const ranged = speciesDef.rangedRange ?? 0;
        const dmg = ranged > 0
          ? (speciesDef.rangedDmg ?? aggroDamage(e.species))
          : aggroDamage(e.species);
        if (ranged > 0 && ctx.onRangedAttack !== undefined) {
          ctx.onRangedAttack(e, {
            kind: target.kind, id: target.id,
            x: target.x, y: heightAt(target.x, target.z) + target.size * 0.55,
            z: target.z, damage: dmg,
          });
          return;
        }
        if (target.kind === 'npc') ctx.onAttackNpc?.(target.id, dmg);
        else ctx.onAttackEntity?.(target.id, dmg);
        // `null`: a CombatTarget has no y. Mob-vs-mob keeps the horizontal-only
        // test it has always had rather than getting a fabricated one.
      }, isWater, collide, radius, null);
      break;
    }

    case 'defend': {
      // Owned bodyguard: close on the nominated hostile and hit it.
      const threat = ctx.defendTarget ?? null;
      if (threat === null) {
        e.mode = 'follow';
        break;
      }
      const reach = DEFEND_BASE_REACH + speciesDef.size;
      const tdx = threat.x - e.x;
      const tdz = threat.z - e.z;
      const tdist = Math.hypot(tdx, tdz);
      if (tdist <= reach) {
        e.stateTimer -= dtS;
        if (e.stateTimer <= 0) {
          ctx.onAttackEntity?.(threat.id, aggroDamage(e.species));
          e.stateTimer = DEFEND_COOLDOWN_S;
        }
        // Face the threat even when not swinging.
        if (tdist > 0.001) e.yaw = Math.atan2(tdx / tdist, -tdz / tdist);
        e.y = isWater ? -0.5 : heightAt(e.x, e.z);
      } else {
        moveToward(e, threat.x, threat.z, speed, dtS, heightAt, isWater, collide, radius);
      }
      // Home tracks the defender so it does not try to walk back to its
      // original spawn once the fight is over.
      e.homeX = e.x;
      e.homeZ = e.z;
      break;
    }

    case 'follow': {
      // Phase K: owned babies follow the player within FOLLOW_RADIUS.
      // Stop when already close enough; home tracks player to prevent drift.
      if (playerDist > FOLLOW_RADIUS) {
        // Teleport to near the player so they don't get left behind.
        e.x = playerX + (e.x - playerX) * (FOLLOW_RADIUS / Math.max(playerDist, 0.001));
        e.z = playerZ + (e.z - playerZ) * (FOLLOW_RADIUS / Math.max(playerDist, 0.001));
        e.y = isWater ? -0.5 : heightAt(e.x, e.z);
      } else if (playerDist > FOLLOW_STOP_DIST) {
        moveToward(e, playerX, playerZ, speed * 0.7, dtS, heightAt, isWater, collide, radius);
      } else {
        // Close enough: stand still, keep y synced.
        e.y = isWater ? -0.5 : heightAt(e.x, e.z);
      }
      // Update home so it doesn't try to return to original spawn.
      e.homeX = e.x;
      e.homeZ = e.z;
      break;
    }

    default:
      break;
  }

  // Water species must not leave deep water.
  if (isWater) {
    e.y = -0.5;
    // Prevent wandering onto land (h >= -2).
    const h = heightAt(e.x, e.z);
    if (h > -2) {
      // Push back toward home.
      e.x = e.homeX;
      e.z = e.homeZ;
      e.y = -0.5;
    }
  }
}

/** Whoever landed the blow, when it was not the player. */
export interface DamageSource {
  id: string;
  kind: 'entity' | 'npc';
  x: number;
  z: number;
}

/**
 * React to taking damage.
 *
 * With no `from`, this is the original player-hit behaviour, unchanged:
 * hostile species turn on the player, everything else runs from them. That
 * default is why every existing call site kept working when mob-vs-mob landed.
 *
 * With a `from`, the reaction points at whoever actually hit it. This is what
 * closes the loop on mob combat and it matters more than target ACQUISITION
 * does: acquisition is limited to things near the player and to creatures with
 * an appetite, but retaliation applies to everything, so a deer cornered by a
 * wolf fights the wolf and a bear that a goblin was foolish enough to shoot
 * turns round and deals with the goblin.
 */
export function onEntityDamaged(e: EntityState, from?: DamageSource): void {
  if (e.mode === 'dead') return;
  const def = SPECIES_DEFS[e.species];
  const cs = e as CombatState;

  if (from === undefined) {
    // The player. Owned animals never turn on their owner — a tamed mount that
    // fights back when its rider clips it would be the worst bug in the game.
    if (def.aggro && e.owned !== true) {
      abandonHunt(cs, 0);
      e.mode = 'aggro';
      e.stateTimer = 0;
    } else if (e.owned !== true) {
      e.mode = 'flee';
      e.fleeTimer = FLEE_DURATION_S;
      cs._fleeFromX = undefined;
      cs._fleeFromZ = undefined;
    }
    return;
  }

  // Struck by another creature or an NPC.
  if (dispositionOf(def) === 'timid' || e.owned === true) {
    // Prey runs, and runs from the thing that bit it rather than from the
    // player — without that it sprints TOWARD its attacker half the time.
    // Owned animals also run rather than brawl: their fighting is the
    // caller-nominated `defend` path, not free-for-all retaliation.
    e.mode = 'flee';
    e.fleeTimer = PREY_FLEE_S;
    cs._fleeFromX = from.x;
    cs._fleeFromZ = from.z;
    return;
  }

  // Anything with fight in it answers, dropping whatever it was doing.
  cs._targetId = from.id;
  cs._huntTimer = HUNT_MAX_S;
  cs._huntCooldown = 0;
  cs._stallDist = Math.hypot(from.x - e.x, from.z - e.z);
  cs._stallTimer = 0;
  e.mode = 'hunt';
  e.stateTimer = 0;
}
