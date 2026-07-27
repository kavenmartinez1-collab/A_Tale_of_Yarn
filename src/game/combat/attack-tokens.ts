/**
 * attack-tokens.ts — how many enemies may swing at you at once, and what the
 * rest of the pack does while it waits its turn.
 *
 * ## THE PROBLEM
 *
 * Every hostile in this game decided to attack on its own private cooldown.
 * That is correct for one wolf and indefensible for seven: a pack does not
 * take turns, it arrives, and the first frame you were in reach was very
 * nearly the last frame you were alive. `dungeon-combat.ts` had already grown
 * a 0.8 s floor between landed blows to survive its own skeleton crowds, and
 * its author flagged the same thing this module now fixes — that the floor was
 * a rate cap bolted onto the dungeon, when the actual defect was that nothing
 * anywhere coordinated the pack.
 *
 * The overworld had no cap at all. Six wolves were six independent 1.2 s
 * clocks, and the only reason that had not been reported as a bug is that six
 * wolves rarely aggro together outside a test.
 *
 * ## THE TWO LEVERS, WHICH ARE NOT THE SAME LEVER
 *
 * This module owns both, and keeping them distinct is the whole design:
 *
 *   - **CONCURRENCY** — how many enemies may be committed to a swing at the
 *     same moment. That is the token count `N`, and it is what makes a fight
 *     read as Zelda: you are fighting *one* thing while five others menace you.
 *   - **RATE** — how often a blow from the governed pack may actually land.
 *     That is `LANDING_FLOOR_S`, and it is the dungeon's old grace window,
 *     moved here and generalised to the overworld.
 *
 * They are independent, and it is worth being explicit about why both survive.
 * Two tokens against goblins (1.2 s cadence) is a landed blow every 0.6 s —
 * FASTER than the 0.8 s floor the dungeon already enforced. Concurrency alone
 * would therefore have made dungeons harder while making them look calmer,
 * which is the worst possible outcome: a difficulty regression disguised as a
 * feel improvement. Tokens do not make the floor redundant. They make it
 * general.
 *
 * ## FAIRNESS, AND WHY ROTATION IS NOT OPTIONAL
 *
 * A token scheme that always grants to the same enemy is not "one attacker at
 * a time", it is "one attacker, and five statues". The pool therefore grants
 * to whoever has waited LONGEST since its own last turn (`waitedS`), so the
 * pack rotates through the pit without anyone being able to starve. Ties break
 * on a hash of the entity id — deterministic, never a clock, never `rng`.
 *
 * ## WHAT THE OTHERS DO — CIRCLING, NOT QUEUEING
 *
 * A denied enemy that simply stands still is the swarm-against-the-wall look
 * the fix was meant to remove; a denied enemy that keeps walking at you is
 * worse, because it shoves. Denied enemies hold a ring at `reach + pad` and
 * strafe tangentially, direction chosen per-entity from the id hash so the
 * pack splits both ways instead of forming a conga line. `circleGoal` returns
 * the goal POINT rather than moving anything, so the caller keeps its own
 * collision and terrain clamping.
 *
 * ## EXEMPTIONS
 *
 * The Evil King and the black dragon never take a token and never respect the
 * landing floor. A boss that waits politely for a turn is not a boss. This is
 * keyed off species, inside this module, deliberately: `castle/castle-fight.ts`
 * is not ours to touch, and the alternative — a flag on the entity — would be a
 * third overload beside `owned` and `pinned`, which is exactly the trap the
 * house rules warn about.
 *
 * ## TIME
 *
 * Every timer here is a `dtS` countdown, matching `animal-ai.ts`. There is no
 * wall clock anywhere in this file and there must never be one: the sim clock
 * simply stops calling `advance` while the game is paused, so pause-safety is
 * a property of the shape rather than something anyone has to remember.
 *
 * Pure module: no DOM, no GPU, no allocation in the hot path. Node-testable.
 */

import { mix32 } from '../dungeon/dungeon-layout';
import type { Species } from '../entities/entity-types';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Tokens available when the pit holds at most `CROWD_AT - 1` contenders.
 *
 * One. Two wolves where both may swing is not a duel with a flanker, it is
 * simply two wolves biting you, which is the thing being fixed. At this size
 * the second enemy circling is legible as *choreography* — you can see it
 * waiting, and you can turn to meet it.
 */
export const SOLO_TOKENS = 1;

/** Tokens available once the pit is genuinely crowded. */
export const CROWD_TOKENS = 2;

/**
 * Contenders at which the pool opens the second token.
 *
 * Three. Below it, one attacker plus circling reads as deliberate; at three
 * and up, a single attacker starts to read as broken AI — the pack is visibly
 * large and visibly passive. Two attackers against a crowd keeps the pressure
 * honest while still leaving most of the pack circling.
 */
export const CROWD_AT = 3;

/**
 * Seconds a granted token is held if the holder never reports a swing.
 *
 * Purely a safety net for the cases the caller cannot report: the holder dies
 * mid-windup, is despawned by cell streaming, or the player simply runs and
 * the holder never gets its blow off. Without it a token leaks and the pack
 * quietly stops attacking, which is a far worse failure than a duplicated
 * swing. Comfortably longer than the slowest cadence in the roster (1.9 s).
 */
export const TOKEN_MAX_HOLD_S = 2.2;

/**
 * Seconds a holder keeps its token after its blow lands — "a beat after".
 *
 * This is the recovery frame made mechanical. Releasing on contact would let
 * the next enemy's windup begin while the first is still following through,
 * and the pair reads as a single blurred two-hit rather than as two enemies
 * taking turns. 0.45 s is long enough to see the first one recover.
 */
export const FOLLOW_THROUGH_S = 0.45;

/**
 * Seconds of silence after which a contender is presumed gone.
 *
 * Contenders re-assert themselves by calling `requestSwing` every tick they
 * are in the pit, so anything that stops asking — died, de-aggroed, walked
 * out, was streamed away — falls out on its own. This is what keeps the pool
 * from needing death or despawn notifications from four different callers.
 */
export const INTENT_TTL_S = 0.35;

/**
 * Minimum sim seconds between two GOVERNED blows landing on the player.
 *
 * This is `dungeon-combat.ts`'s old `PLAYER_HIT_GRACE_S`, moved here intact
 * and now applying in the overworld too. The reasoning that produced 0.8 is
 * unchanged and still good: the player has 20 max HP and a skeleton hits for
 * 5, so it bounds a crowd to roughly one blow per swing instead of one per
 * ENEMY per swing, and it sits below every cadence in the roster (goblin
 * 1.2 s, skeleton 1.45 s, boss 1.9 s) so no duel is altered by it.
 *
 * "Governed" excludes exempt species — see `EXEMPT_SPECIES`.
 */
export const LANDING_FLOOR_S = 0.8;

/**
 * How far past its reach an enemy will still contend for a token.
 *
 * Beyond this it is simply walking in and needs no permission for that. The
 * gap between this and the circling band is deliberate hysteresis: without it,
 * an enemy hovering exactly at the boundary would flicker between "closing"
 * and "circling" every other frame.
 */
export const CONTEND_PAD = 4.0;

/** Closest and furthest a denied enemy holds station, as padding past reach. */
export const RING_PAD_MIN = 1.5;
export const RING_PAD_MAX = 3.0;

/**
 * How fast a circling enemy moves, as a fraction of its charge speed.
 *
 * Below 1 because a body sprinting sideways at full pace reads as fleeing past
 * you rather than as stalking you, and because a slower orbit gives the player
 * time to actually register that the pack is repositioning — which is the
 * whole point of showing it to them.
 */
export const CIRCLE_SPEED_MUL = 0.75;

/**
 * How far ahead of itself a circling enemy aims, in multiples of one tick's
 * travel.
 *
 * `moveToward` gives up when the goal is within 5 cm, so the goal has to stay
 * comfortably ahead of a body that is already almost on the ring. Three ticks
 * of travel is far enough to always beat that floor and near enough that the
 * path stays visibly curved rather than becoming a chord.
 */
const CIRCLE_LOOKAHEAD = 3;

/**
 * Species that never wait their turn and never respect the landing floor.
 *
 * Both bosses. See the module header — this lives here rather than as an
 * entity flag on purpose.
 */
export const EXEMPT_SPECIES: ReadonlySet<Species> = new Set<Species>([
  'evil_king',
  'black_dragon',
]);

/** True when this species fights outside the token economy entirely. */
export function isExempt(species: Species): boolean {
  return EXEMPT_SPECIES.has(species);
}

// ---------------------------------------------------------------------------
// Deterministic id hashing
// ---------------------------------------------------------------------------

/**
 * FNV-1a over an entity id.
 *
 * The same hash `animal-ai.ts` already uses to stagger its target re-scans and
 * `entity-manager.ts` uses for colour variants. Reproduced rather than shared
 * because both of those are private to their modules, and a third copy of five
 * lines is cheaper than a new cross-module dependency in a file this hot.
 */
export function idHash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Which way this entity orbits: +1 clockwise, -1 counter-clockwise.
 *
 * Run through `mix32` rather than reading a bit straight off the FNV hash so
 * that the direction is decorrelated from the tie-break ordering — otherwise
 * every enemy that tends to win tokens would also tend to circle the same way,
 * and the pack would visibly bias to one side.
 */
export function circleDir(id: string): 1 | -1 {
  return (mix32(idHash(id), 0x0c1c1e) & 1) === 0 ? 1 : -1;
}

/**
 * Standoff radius for a denied enemy: `reach + pad`, with the pad spread
 * deterministically across the band so a pack forms a loose ring rather than
 * a perfect circle of clones at identical radius.
 */
export function circleRing(id: string, reach: number): number {
  const t = (mix32(idHash(id), 0x5a1d) >>> 8) / 0xffffff;
  return reach + RING_PAD_MIN + t * (RING_PAD_MAX - RING_PAD_MIN);
}

/**
 * Where a circling enemy should walk to this tick.
 *
 * Returns a POINT on (or heading onto) the standoff ring, advanced tangentially
 * by roughly this tick's travel. Feeding a ring point to an ordinary
 * move-toward gives radial correction and tangential motion from one formula:
 * an enemy that is too close is pushed out, one that is too far is drawn in,
 * and one already on the ring simply slides along it.
 *
 * The caller still owns the actual move, so collision, terrain and the
 * dungeon's room clamp all keep working untouched.
 */
export function circleGoal(
  id: string,
  ex: number, ez: number,
  px: number, pz: number,
  reach: number,
  speed: number,
  dtS: number,
): { x: number; z: number } {
  const ring = circleRing(id, reach);
  const dx = ex - px, dz = ez - pz;
  const d = Math.hypot(dx, dz);
  // Degenerate: standing exactly on the player. Pick a stable bearing from the
  // id so the enemy steps off in a repeatable direction instead of NaN.
  const ang = d < 1e-4
    ? (idHash(id) % 6283) / 1000
    : Math.atan2(dx, dz);
  const step = Math.max(speed * dtS * CIRCLE_LOOKAHEAD, 0.35);
  // Arc length -> angle. Clamped so a fast body on a tight ring cannot swing
  // more than ~34 deg in one tick and cut the corner into the player.
  const dAng = Math.min(step / Math.max(ring, 0.5), 0.6) * circleDir(id);
  const a = ang + dAng;
  return { x: px + Math.sin(a) * ring, z: pz + Math.cos(a) * ring };
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

/**
 * What `animal-ai.ts` needs from the pool. Declared as an interface so the AI
 * depends on the contract rather than on the class, which keeps the AI's own
 * tests free to pass a stub.
 */
export interface MeleeArbiter {
  /**
   * "I am in reach and my swing clock is running — may I commit?"
   *
   * Must be called EVERY tick an enemy is contending, not just on the tick it
   * would swing: the call is what keeps its intent alive (`INTENT_TTL_S`) and
   * what accumulates its wait.
   */
  requestSwing(id: string, species: Species): boolean;
  /** "My blow just went out." Starts the follow-through, then frees the token. */
  noteSwing(id: string): void;
  /** "My blow is about to land." False when the landing floor says not yet. */
  mayLand(species: Species): boolean;
}

interface Contender {
  /** Seconds since this entity last asked. Past `INTENT_TTL_S` it is dropped. */
  sinceAskS: number;
  /** Seconds since this entity last held a token. Drives fairness. */
  waitedS: number;
  /** Seconds of hold remaining; > 0 means it holds a token right now. */
  holdS: number;
}

/**
 * One pit's worth of turn-taking.
 *
 * Two instances exist and they never both matter: the overworld tick owns one,
 * `DungeonCombat` owns the other, and `tickEntities` returns early underground
 * so only one is ever advancing. Two instances rather than one shared singleton
 * because the enemy sets are disjoint anyway, it keeps the plumbing to zero,
 * and a pool with no cross-test lifetime is a pool that unit-tests honestly.
 */
export class MeleeTokenPool {
  private readonly contenders = new Map<string, Contender>();
  /** Ids granted a token this tick, longest-waiting first. Recomputed in `advance`. */
  private readonly nextUp: string[] = [];
  private held = 0;
  private capacity = SOLO_TOKENS;
  private sinceLandS = LANDING_FLOOR_S;

  /** Swings refused because every token was taken. Diagnostics and tests. */
  deniedByToken = 0;
  /** Blows refused because they arrived inside the landing floor. */
  deniedByRate = 0;
  /**
   * Most tokens ever held at once since the last `reset`.
   *
   * The only DIRECT evidence of the concurrency cap. Damage totals cannot
   * prove it, because the landing floor bounds them on its own — break the
   * concurrency cap and the damage barely moves, which is exactly why a test
   * asserting only on damage passed happily with the cap opened to eight.
   */
  peakHeld = 0;

  /** Live contenders this tick — the number the capacity rule reads. */
  get contenderCount(): number { return this.contenders.size; }
  /** Tokens currently held. Never exceeds `tokenCapacity`. */
  get heldCount(): number { return this.held; }
  /** Tokens available this tick, 1 or 2. */
  get tokenCapacity(): number { return this.capacity; }

  /**
   * Advance every timer and decide who is next up. Call ONCE per sim tick,
   * before stepping any entity.
   */
  advance(dtS: number): void {
    this.sinceLandS += dtS;

    for (const [id, c] of this.contenders) {
      c.sinceAskS += dtS;
      c.waitedS += dtS;
      if (c.holdS > 0) {
        c.holdS -= dtS;
        if (c.holdS <= 0) { c.holdS = 0; this.held--; }
      }
      // Stopped asking: died, de-aggroed, walked out, was streamed away.
      if (c.sinceAskS > INTENT_TTL_S) {
        if (c.holdS > 0) this.held--;
        this.contenders.delete(id);
      }
    }
    if (this.held < 0) this.held = 0;

    this.capacity = this.contenders.size >= CROWD_AT ? CROWD_TOKENS : SOLO_TOKENS;

    // Offer exactly as many places as there are FREE tokens, in priority
    // order — not `capacity` places regardless of how many are actually free.
    //
    // Offering two places while only one token was free starved the back of
    // the pack outright. `requestSwing` is called in the caller's iteration
    // order, so the one free slot went to whichever offered contender happened
    // to be stepped first, and the genuinely-longest-waiting enemy — offered a
    // place every single tick, and first in the list every single tick — was
    // beaten to the token every single time. Its `waitedS` climbed without
    // bound while it never once swung. Six wolves, and the sixth never
    // attacked in thirty seconds.
    const free = Math.max(0, this.capacity - this.held);
    this.nextUp.length = 0;
    if (free === 0) return;

    // Pick the longest-waiting non-holders, at most `free` of them. A two-slot
    // linear scan rather than a sort: the pool is O(contenders) per tick and
    // stays that way.
    let bestId = '', bestWait = -1, bestRank = 0;
    let secondId = '', secondWait = -1, secondRank = 0;
    for (const [id, c] of this.contenders) {
      if (c.holdS > 0) continue;
      const rank = idHash(id);
      // Longest wait wins; equal waits break on the id hash so the outcome is
      // identical on every machine and every replay.
      const beatsBest = c.waitedS > bestWait
        || (c.waitedS === bestWait && rank < bestRank);
      if (beatsBest) {
        secondId = bestId; secondWait = bestWait; secondRank = bestRank;
        bestId = id; bestWait = c.waitedS; bestRank = rank;
        continue;
      }
      const beatsSecond = c.waitedS > secondWait
        || (c.waitedS === secondWait && rank < secondRank);
      if (beatsSecond) {
        secondId = id; secondWait = c.waitedS; secondRank = rank;
      }
    }
    if (bestId !== '') this.nextUp.push(bestId);
    if (secondId !== '' && free > 1) this.nextUp.push(secondId);
  }

  requestSwing(id: string, species: Species): boolean {
    // Bosses do not queue.
    if (isExempt(species)) return true;

    let c = this.contenders.get(id);
    if (c === undefined) {
      // First sight of this enemy. `waitedS` starts high so a fresh arrival
      // outranks anyone who has already had a turn — otherwise the first two
      // enemies to reach you would hold the tokens for the whole fight and the
      // late arrivals would circle forever.
      c = { sinceAskS: 0, waitedS: TOKEN_MAX_HOLD_S, holdS: 0 };
      this.contenders.set(id, c);
    }
    c.sinceAskS = 0;

    if (c.holdS > 0) return true;
    if (this.held >= this.capacity) { this.deniedByToken++; return false; }

    const slot = this.nextUp.indexOf(id);
    if (slot < 0) {
      // Not picked by this tick's arbitration. ONE exception: a body that
      // arrived after `advance` ran, when nobody else is waiting at all.
      //
      // `nextUp` empty with capacity to spare can only mean every known
      // contender already holds a token, so this cannot jump a queue — there
      // is no queue. Without the exception a lone enemy forfeits its opening
      // swing to a one-tick scheduling gap and then has to sit out a whole
      // fresh cadence, which is a visible hesitation on every first contact.
      if (this.nextUp.length > 0) { this.deniedByToken++; return false; }
    } else {
      this.nextUp.splice(slot, 1);
    }
    c.holdS = TOKEN_MAX_HOLD_S;
    c.waitedS = 0;
    this.held++;
    if (this.held > this.peakHeld) this.peakHeld = this.held;
    return true;
  }

  noteSwing(id: string): void {
    const c = this.contenders.get(id);
    if (c === undefined || c.holdS <= 0) return;
    // Keep the token just long enough to recover, then it frees itself.
    if (c.holdS > FOLLOW_THROUGH_S) c.holdS = FOLLOW_THROUGH_S;
  }

  mayLand(species: Species): boolean {
    if (isExempt(species)) return true;
    if (this.sinceLandS < LANDING_FLOOR_S) { this.deniedByRate++; return false; }
    this.sinceLandS = 0;
    return true;
  }

  /** Does this entity hold a token right now? Diagnostics and tests. */
  holds(id: string): boolean {
    const c = this.contenders.get(id);
    return c !== undefined && c.holdS > 0;
  }

  /**
   * Drop everything. Called when a dungeon is left, so token state cannot
   * outlive the enemies it described — the lifetime bug the old grace window
   * quietly had.
   */
  reset(): void {
    this.contenders.clear();
    this.nextUp.length = 0;
    this.held = 0;
    this.capacity = SOLO_TOKENS;
    this.sinceLandS = LANDING_FLOOR_S;
    this.deniedByToken = 0;
    this.deniedByRate = 0;
    this.peakHeld = 0;
  }
}
