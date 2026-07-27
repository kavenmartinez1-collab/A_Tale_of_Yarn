/**
 * combat-targeting.ts — who fights whom, and how the answer is found cheaply.
 *
 * WHY THIS EXISTS
 *
 * Every hostile in the game used to target exactly one thing: the player. A
 * wolf and a deer could stand touching each other indefinitely, a bear could
 * wander through a village unremarked, and a goblin would politely ignore the
 * bear beside it. That is the loudest possible tell that the world is a
 * backdrop rather than an ecosystem — the player is not IN the world, the
 * world is pointed AT the player.
 *
 * This module answers "what should this creature attack" and nothing else. It
 * does not move anything, damage anything, or own any state that outlives a
 * tick; `animal-ai.ts` consumes its answers. Splitting it out buys two things:
 * the scoring rules can be unit-tested without simulating a fight, and the
 * O(n²) hazard is confined to one function that is easy to keep honest about
 * its cost.
 *
 * THE COST PROBLEM, AND HOW IT IS BOUNDED
 *
 * `stepAnimal` runs for every entity every tick. A naive "scan all entities
 * for the nearest enemy" inside it is O(n²) per tick, and this game already
 * spends most of its frame on creature mesh rebuilds (capped at 8/frame in
 * `entity-renderer.ts` because one costs ~1.8 ms). Three things keep it cheap:
 *
 *  1. **The candidate list is built ONCE per tick**, not once per entity, and
 *     only from entities inside `COMBAT_RADIUS` of the player. A wolf hunting
 *     a deer 300 m away is a fight nobody can see or hear; simulating it is
 *     pure cost. The AI's existing LOD tiers already stop updating past 200 m.
 *  2. **Re-targeting is staggered and rate-limited.** A creature picks a
 *     target at most every `RETARGET_S`, offset by a hash of its id so they do
 *     not all scan on the same tick. Targets do not need to change at 60 Hz.
 *  3. **Scoring is one pass over an array of primitives.** No allocation, no
 *     sorting, no map lookups in the inner loop.
 *
 * Worst case with the entity manager's `LIVE_CAP` of 40 and a full scan due
 * for every one of them on the same tick: 1600 distance comparisons. That is
 * roughly a tenth of what one creature mesh rebuild costs.
 *
 * Pure module: no DOM, no GPU, no per-call allocation in the hot path.
 * Node-testable.
 */

import { SPECIES_DEFS, dispositionOf, type Disposition, type Species } from './entity-types';
import type { EntityState } from './entity-manager';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Entities further than this from the player never pick a fight.
 *
 * Slightly beyond the renderer's 120 m draw distance, so a brawl that starts
 * just out of sight is already running when you turn round — but well inside
 * the AI's 200 m skip tier, so nothing is being simulated that could not
 * plausibly be witnessed.
 */
export const COMBAT_RADIUS = 130; // m

/** Furthest a creature will look for something to attack. */
export const HUNT_SIGHT = 34; // m

/** Seconds between target re-scans for one creature. */
export const RETARGET_S = 0.55;

/** Radius within which same-faction allies embolden a creature. */
export const PACK_RADIUS = 9; // m

/**
 * Largest target a lone creature will start on, as a multiple of its own size.
 *
 * 1.6 is chosen from the roster rather than from theory: it is exactly what
 * lets a 0.9 m wolf commit to a 1.2 m deer and a 1.4 m cow, while refusing a
 * 1.6 m horse and an 1.8 m bear. A wolf pack that will not touch a bear but
 * will pull down a cow is the behaviour people expect without being able to
 * say why.
 */
const LONE_SIZE_RATIO = 1.6;

/** Each nearby ally adds this much to the size ratio a creature will accept. */
const PACK_COURAGE = 0.55;

// ---------------------------------------------------------------------------
// Factions
// ---------------------------------------------------------------------------

/**
 * Who counts as "one of us".
 *
 * Deliberately only two values. A richer faction graph is tempting and would
 * be entirely unused: the only thing the game needs is that dungeon enemies
 * spawned as one warband do not murder each other in the boss room, and that
 * wildlife is not a monolith (wolves eat deer).
 */
export type Faction = 'wild' | 'warband';

// The Evil King and his mount are warband too. Without this `factionOf`
// silently returns 'wild' for both and the boss's own dragon is a legitimate
// target for him — a mount that fights its rider is the sort of thing that
// only shows up in the fight, at the end, once.
const WARBAND = new Set<string>(
  ['goblin', 'goblin_archer', 'skeleton', 'dread_king',
    'evil_king', 'black_dragon']);

export function factionOf(species: Species): Faction {
  return WARBAND.has(species) ? 'warband' : 'wild';
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export type TargetKind = 'entity' | 'npc';

/** Anything that can be fought by a creature. */
export interface CombatTarget {
  id: string;
  kind: TargetKind;
  x: number;
  z: number;
  /** Present for entity targets; absent for NPCs. */
  species?: Species;
  /** Effective body size for the size-ratio rule. NPCs are human-sized. */
  size: number;
  /** Player-owned (tamed mount, hatched baby). Still fair game for wildlife. */
  owned: boolean;
  /** Faction, for the never-fight-your-own rule. */
  faction: Faction;
}

/** An NPC, as seen by the combat system. `main.ts` owns the real runtime. */
export interface NpcTarget {
  id: string;
  x: number;
  z: number;
}

/** NPCs are treated as this many metres tall for the size-ratio rule. */
const NPC_SIZE = 1.45;

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * How much `hunter` wants to attack `target`, before distance is considered.
 * 0 means "never".
 *
 * The rules read as dispositions rather than as a matrix, because a matrix
 * over N species is N² entries nobody will keep correct. `courage` is the
 * largest size ratio this hunter will take on right now — it rises with pack
 * support, which is the entire mechanical expression of "cowardly alone,
 * dangerous in numbers".
 */
export function appetite(
  hunterSpecies: Species,
  disposition: Disposition,
  hunterSize: number,
  target: CombatTarget,
  courage: number,
): number {
  // Never your own warband. A boss that kills its own guards on the way to you
  // is a comedy, not a set piece.
  if (target.kind === 'entity'
      && target.faction === factionOf(hunterSpecies)
      && target.faction === 'warband') return 0;

  if (target.species === hunterSpecies) {
    // Your own kind, with ONE exception: a tamed rival standing on your
    // ground. A wild wyvern will drive off another wyvern that has been
    // brought into its territory — "that is the risk of exploring".
    //
    // Note what this deliberately is NOT. The weight is modest, and the
    // caller gates territorial species to their own 50 m home radius
    // (`animal-ai.maybeAcquire`), so this only ever fires when the player has
    // flown a mount into a wild one's nesting ground. A wild flier drifting
    // past a stabled mount picks no fight: losing a mount has to be something
    // the player can point at and say what they did wrong, not an attrition
    // tax on ordinary business.
    return target.owned ? 0.55 : 0;
  }

  const ratio = target.size / Math.max(0.1, hunterSize);

  switch (disposition) {
    case 'timid':
      // Prey never starts anything. It only ever fights back, and `animal-ai`
      // handles retaliation separately.
      return 0;

    case 'predator': {
      if (target.kind === 'npc') {
        if (ratio > courage) return 0;
        // How readily a predator takes a PERSON scales with how much bigger
        // than one it is. A wolf would much rather have a deer and only
        // bothers a villager opportunistically (0.40, below every prey score);
        // a dragon standing over a settlement has no reason to prefer the
        // livestock (0.95, above almost everything).
        //
        // This is what makes the three fliers read as an emergency over a
        // village rather than as large wildlife, and it falls out of one
        // number instead of a per-species hostility flag.
        const over = Math.min(1, Math.max(0, hunterSize / NPC_SIZE - 1));
        return 0.40 + over * 0.55;
      }
      if (ratio > courage) return 0;
      // Peaks on prey a bit over half the hunter's size — big enough to be
      // worth the chase, small enough to be safe. Falls off toward both ends
      // rather than simply preferring the smallest thing in sight, which would
      // make every wolf in the world converge on rabbits.
      return 1 - Math.min(1, Math.abs(ratio - 0.62) / 1.05);
    }

    case 'raider':
      // Goblins raid. People and their livestock first, wildlife second, and
      // only what they think they can beat.
      if (target.kind === 'npc') return 1.30;
      if (ratio > courage) return 0;
      return target.owned ? 1.05 : 0.75;

    case 'undead':
      // No self-preservation and no appetite — it is not hunting, it is
      // erasing. Size is irrelevant, which is exactly what makes a skeleton
      // read as something that is already dead.
      return target.kind === 'npc' ? 1.25 : 1.0;
  }
}

// ---------------------------------------------------------------------------
// The per-tick candidate index
// ---------------------------------------------------------------------------

/**
 * Every fightable thing near the player, rebuilt once per tick.
 *
 * Reused across ticks rather than reallocated: `rebuild` overwrites in place
 * and tracks a length, so a steady-state world allocates nothing at all here.
 * That matters because this runs at the sim rate for the whole session.
 */
export class CombatIndex {
  /** Candidates, valid for indices `[0, count)`. */
  private readonly items: CombatTarget[] = [];
  private count = 0;
  private readonly byId = new Map<string, number>();

  /** Number of live candidates this tick. Diagnostics and tests. */
  get size(): number { return this.count; }

  /**
   * Rebuild from the current world. Call ONCE per sim tick, before stepping
   * any entity.
   *
   * `entities` may be the whole live set — the radius filter is applied here
   * so callers do not each need their own.
   */
  rebuild(
    entities: Iterable<EntityState>,
    npcs: readonly NpcTarget[] | null,
    playerX: number,
    playerZ: number,
  ): void {
    this.count = 0;
    this.byId.clear();
    const r2 = COMBAT_RADIUS * COMBAT_RADIUS;

    for (const e of entities) {
      if (e.mode === 'dead') continue;
      const dx = e.x - playerX, dz = e.z - playerZ;
      if (dx * dx + dz * dz > r2) continue;
      this._push({
        id: e.id, kind: 'entity', x: e.x, z: e.z,
        species: e.species, size: SPECIES_DEFS[e.species].size,
        owned: e.owned === true || e.npcOwned === true,
        faction: factionOf(e.species),
      });
    }

    if (npcs !== null) {
      for (const n of npcs) {
        const dx = n.x - playerX, dz = n.z - playerZ;
        if (dx * dx + dz * dz > r2) continue;
        this._push({
          id: n.id, kind: 'npc', x: n.x, z: n.z,
          size: NPC_SIZE, owned: false, faction: 'wild',
        });
      }
    }
  }

  private _push(t: CombatTarget): void {
    const i = this.count++;
    // Overwrite the pooled record rather than pushing a new object.
    if (i < this.items.length) {
      const dst = this.items[i];
      dst.id = t.id; dst.kind = t.kind; dst.x = t.x; dst.z = t.z;
      dst.species = t.species; dst.size = t.size; dst.owned = t.owned;
      dst.faction = t.faction;
    } else {
      this.items.push(t);
    }
    this.byId.set(t.id, i);
  }

  /** Current position/liveness of a target, or null if it is gone. */
  get(id: string): CombatTarget | null {
    const i = this.byId.get(id);
    return i === undefined ? null : this.items[i];
  }

  /** Number of same-faction allies within `PACK_RADIUS` of (x, z). */
  alliesNear(x: number, z: number, faction: Faction, selfId: string): number {
    const r2 = PACK_RADIUS * PACK_RADIUS;
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const c = this.items[i];
      if (c.kind !== 'entity' || c.id === selfId || c.faction !== faction) continue;
      const dx = c.x - x, dz = c.z - z;
      if (dx * dx + dz * dz <= r2) n++;
    }
    return n;
  }

  /**
   * The best thing for this creature to attack, or null.
   *
   * One linear pass, no allocation. Score is appetite divided by distance, so
   * a creature prefers a slightly worse target that is much closer — which is
   * both cheaper than a proper utility system and better behaviour, because a
   * predator that walks past a rabbit to reach a distant deer looks broken.
   */
  pick(
    self: EntityState,
    disposition: Disposition,
    courage: number,
    sight: number,
  ): CombatTarget | null {
    const hunterSize = SPECIES_DEFS[self.species].size;
    const sight2 = sight * sight;
    let best: CombatTarget | null = null;
    let bestScore = 0;

    for (let i = 0; i < this.count; i++) {
      const c = this.items[i];
      if (c.id === self.id) continue;
      const dx = c.x - self.x, dz = c.z - self.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > sight2) continue;
      const want = appetite(self.species, disposition, hunterSize, c, courage);
      if (want <= 0) continue;
      // +1 keeps a target underfoot from scoring infinitely and lets appetite
      // still matter at contact range.
      const score = want / (1 + Math.sqrt(d2));
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }
}

/**
 * How big a target this creature dares take on right now.
 *
 * Fearless things do not do arithmetic about their chances. Everything else
 * scales with the friends it can see, which is the whole of the pack rule.
 */
export function courageOf(
  species: Species, allies: number, fearless: boolean,
): number {
  if (fearless) return Number.POSITIVE_INFINITY;
  void species;
  return LONE_SIZE_RATIO + allies * PACK_COURAGE;
}

/** Convenience for callers that only have a species. */
export function dispositionFor(species: Species): Disposition {
  return dispositionOf(SPECIES_DEFS[species]);
}
