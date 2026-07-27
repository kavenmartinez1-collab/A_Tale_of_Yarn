/**
 * Entity / creature type definitions — species catalogue, spawn constants.
 *
 * Pure data module: no DOM, no GPU, no side-effects. Imported by both the
 * scatter logic (entity-scatter.ts) and the future entity manager.
 */

import type { GameItemId } from '../items';
import type { Biome } from '../biome';

export type Species =
  | 'rabbit'
  | 'deer'
  | 'bird'
  | 'horse'
  | 'cow'
  | 'donkey'
  | 'wolf'
  | 'bear'
  | 'dragon'
  | 'wyvern'
  | 'griffin'
  | 'sea_serpent'
  // --- dungeon enemies (biomes: [] — they never scatter into the overworld) ---
  | 'goblin'
  | 'goblin_archer'
  | 'skeleton'
  | 'dread_king'
  // --- the final boss and his mount (biomes: [] — placed by script, never
  //     scattered; see king-mesh.ts and black-dragon-mesh.ts) ---
  | 'evil_king'
  | 'black_dragon';

/**
 * What a species will pick a fight with, beyond the player.
 *
 * This is the axis that turns a bestiary into an ecosystem, and it is
 * deliberately four coarse values rather than a per-species matrix: N² entries
 * is N² entries nobody keeps correct. See `combat-targeting.ts` for the
 * scoring each one produces.
 *
 *  - `timid`    — never starts anything. Fights back or runs. Every herbivore.
 *  - `predator` — hunts things meaningfully smaller than itself, and would
 *                 rather have a deer than a person.
 *  - `raider`   — goblins. Wants people, livestock and loot, and sizes up
 *                 whether it can win before committing.
 *  - `undead`   — attacks anything living regardless of size or odds. Not
 *                 hunger; erasure.
 */
export type Disposition = 'timid' | 'predator' | 'raider' | 'undead';

export interface SpeciesDef {
  name: string;
  /** Approximate shoulder height (m). */
  size: number;
  /** Wander / flee speed (m/s). */
  speed: number;
  /** Riding speed (m/s) — only present when mountable === true. */
  mountSpeed?: number;
  /** Starting hit-points. */
  hp: number;
  /** True for dragon / griffin / sea_serpent. */
  rare: boolean;
  /** Player can ride this species. */
  mountable: boolean;
  /** Item the species will follow when held by the player. */
  favoriteFood?: GameItemId;
  /** Attacks the player on sight. */
  aggro: boolean;
  /** Melee damage per hit (aggro species). Defaults to max(1, round(size)). */
  attackDmg?: number;
  /** Biomes where this species may spawn. */
  biomes: Biome[];
  /** Spawns in ocean water (h < -8). */
  water?: boolean;
  /**
   * Relative weight when the rare-spawn pass picks between eligible rares.
   * Defaults to 1. The wyvern carries 4, which — together with its much wider
   * biome list — is what makes wyverns the flier you actually meet and the
   * dragon the one you remember meeting.
   */
  rareWeight?: number;

  /**
   * True when this species can take to the air while ridden (Space to ascend,
   * Q to descend).
   *
   * Flight used to be hardcoded as `species === 'dragon'` in main.ts, which
   * meant adding any second flier silently produced a mountable creature with
   * wings that could not leave the ground. It is a property of the animal, so
   * it belongs on the animal.
   */
  canFly?: boolean;


  // -------------------------------------------------------------------------
  // Mob-vs-mob combat. All optional: every field below has a default that
  // reproduces the pre-existing behaviour exactly, so no existing species
  // changed when these landed.
  // -------------------------------------------------------------------------

  /** What this species picks fights with. Defaults from `aggro` — see
   *  `dispositionOf`. */
  disposition?: Disposition;
  /**
   * Never flees, never breaks off, never weighs the odds.
   *
   * Not the same as `aggro`. A bear is aggressive and still runs from a
   * dragon; a skeleton walks into the dragon. This is the single field that
   * makes the undead read as undead rather than as angry.
   */
  fearless?: boolean;
  /**
   * Flees below this fraction of starting HP — unless it has pack support.
   *
   * This is the whole of "cowardly in isolation, brave in packs": the same
   * goblin breaks at 35% alone and fights to the end with three friends
   * beside it, and the player can feel the difference without being told.
   * Undefined means it never breaks on health alone.
   */
  morale?: number;
  /** Seconds between blows. Defaults to the shared 1.2 s cadence. */
  attackCooldown?: number;
  /** Extra melee reach in metres, for things with long weapons. */
  reachBonus?: number;
  /**
   * Preferred engagement range in metres for a ranged attacker. 0/absent =
   * melee only. A ranged attacker backs off when the target closes inside
   * half of this.
   */
  rangedRange?: number;
  /** Damage per ranged hit. Defaults to `attackDmg`. */
  rangedDmg?: number;
}

/**
 * The disposition a species actually uses.
 *
 * Derived rather than declared for the twelve species that predate the field,
 * so nothing had to be touched to add it: anything already `aggro` hunts, and
 * everything else is prey. The four dungeon enemies declare theirs.
 */
export function dispositionOf(def: SpeciesDef): Disposition {
  return def.disposition ?? (def.aggro ? 'predator' : 'timid');
}

export const SPECIES_DEFS: Record<Species, SpeciesDef> = {
  rabbit: {
    name: 'Rabbit',
    size: 0.4,
    speed: 3,
    hp: 3,
    rare: false,
    mountable: false,
    aggro: false,
    biomes: ['plains', 'forest', 'dense_forest'],
  },
  deer: {
    name: 'Deer',
    size: 1.2,
    speed: 4.5,
    hp: 8,
    rare: false,
    mountable: false,
    aggro: false,
    biomes: ['forest', 'dense_forest', 'mountain_forest', 'plains'],
  },
  bird: {
    name: 'Bird',
    size: 0.3,
    speed: 5,
    hp: 2,
    rare: false,
    mountable: false,
    aggro: false,
    // All land biomes except desert and alpine.
    biomes: ['beach', 'plains', 'forest', 'dense_forest', 'jungle', 'mountain_forest'],
  },
  horse: {
    name: 'Horse',
    size: 1.6,
    speed: 5,
    mountSpeed: 14,
    hp: 20,
    rare: false,
    mountable: true,
    favoriteFood: 'healing_herb',
    aggro: false,
    biomes: ['plains', 'forest'],
  },
  cow: {
    name: 'Cow',
    size: 1.4,
    speed: 1.5,
    mountSpeed: 10.5,
    hp: 16,
    rare: false,
    mountable: true,
    favoriteFood: 'flax',
    aggro: false,
    biomes: ['plains'],
  },
  donkey: {
    name: 'Donkey',
    size: 1.3,
    speed: 2.5,
    mountSpeed: 11,
    hp: 14,
    rare: false,
    mountable: true,
    favoriteFood: 'cactus_flesh',
    aggro: false,
    biomes: ['desert', 'plains', 'beach'],
  },
  wolf: {
    name: 'Wolf',
    size: 0.9,
    speed: 6.5, // faster than player walk (6), slower than sprint (10)
    hp: 12,
    rare: false,
    mountable: false,
    aggro: true,
    attackDmg: 2,
    // Added desert/beach so hostile pressure exists outside forest biomes.
    biomes: ['forest', 'dense_forest', 'mountain_forest', 'plains', 'desert', 'beach'],
  },
  bear: {
    name: 'Bear',
    size: 1.8,
    speed: 5.5,
    hp: 35,
    rare: false,
    mountable: false,
    aggro: true,
    attackDmg: 4,
    // Added jungle so dense tropical zones also have a strong predator.
    biomes: ['forest', 'dense_forest', 'mountain_forest', 'jungle'],
  },
  dragon: {
    name: 'Dragon',
    canFly: true,
    size: 3.5,
    speed: 6,
    mountSpeed: 18,
    hp: 80,
    rare: true,
    mountable: true,
    favoriteFood: 'meat_cooked',
    aggro: true,
    attackDmg: 5,
    biomes: ['alpine', 'mountain_forest'],
  },
  wyvern: {
    // Smaller, leaner and weaker than the dragon: the flier you actually run
    // into, against the one that ends a run. Two hind legs, wings for arms —
    // see wyvern-mesh.ts.
    name: 'Wyvern',
    canFly: true,
    size: 2.4,
    speed: 7,          // lighter build, faster on the ground than a dragon
    mountSpeed: 15,    // dragon 18
    hp: 45,            // dragon 80
    rare: true,
    mountable: true,
    favoriteFood: 'meat_raw',
    aggro: true,
    attackDmg: 3,      // dragon 5
    // Four biomes to the dragon's two, including the desert and the jungle
    // where no rare beast lived before. Habitat is most of what "far more
    // common than dragons" actually means.
    // Six biomes, including the LOWLANDS. Every earlier rare lived only where
    // the player rarely goes — alpine and mountain forest — which made "far
    // more common than dragons" true of the spawn table and false of the
    // experience. A flier you never meet is not the common one. Plains and
    // forest are where the settlements and the roads are, so this is what
    // actually turns the wyvern into the flier you run into.
    //
    // Density is still governed by the rare pass and `rareWeight`, so this
    // widens WHERE they can appear without changing how many exist.
    biomes: ['plains', 'forest', 'alpine', 'mountain_forest', 'desert', 'jungle'],
    rareWeight: 4,
  },
  griffin: {
    name: 'Griffin',
    // A rare, tameable, 16 m/s mount with a two-metre wingspan that could not
    // leave the ground. Missed when `canFly` replaced the hardcoded
    // `species === 'dragon'` check, which is exactly the failure mode a
    // per-species flag was introduced to prevent.
    canFly: true,
    size: 2.2,
    speed: 7,
    mountSpeed: 16,
    hp: 50,
    rare: true,
    mountable: true,
    favoriteFood: 'meat_raw',
    aggro: true,
    attackDmg: 3,
    // mountain_forest added so the demo seed has a reachable wild griffin
    // (alpine-only left the nearest one ~24 km from spawn).
    biomes: ['alpine', 'mountain_forest'],
  },
  sea_serpent: {
    name: 'Sea Serpent',
    size: 4.0,
    speed: 6,
    hp: 60,
    rare: true,
    mountable: false,
    aggro: true,
    attackDmg: 4,
    biomes: ['ocean'],
    water: true,
  },

  // ==========================================================================
  // Dungeon enemies
  //
  // `biomes: []` is load-bearing, not laziness. `entity-scatter.ts` derives
  // COMMON_SPECIES as every non-rare key of this table and then filters by
  // `def.biomes.includes(biome)` — so a dungeon species with any biome at all
  // would start scattering across the overworld the moment it was added.
  // An empty list is the only thing that keeps them underground, and the same
  // list keeps them out of `ecology-spec.ts`'s admissibility checks.
  //
  // `rare: false` is also deliberate: `animal-ai.ts` treats
  // `rare && aggro && !water` as TERRITORIAL, which would give every goblin a
  // 50 m home leash and an "escaped, walk home" branch — nonsense inside a
  // 13 m room, and it would fight the room clamp.
  // ==========================================================================

  goblin: {
    // Shoulder height 0.86 m -> about 1.1 m standing, against the player's
    // 1.62. That size contrast is the primary read and everything else on the
    // model is tuned around it.
    name: 'Goblin',
    size: 0.86,
    speed: 4.8,          // quicker than a player walk (6) only in bursts
    hp: 12,
    rare: false,
    mountable: false,
    aggro: true,
    attackDmg: 3,
    disposition: 'raider',
    // Breaks at a third health when alone. With allies inside PACK_RADIUS its
    // courage rises instead and it holds — see `combat-targeting.courageOf`.
    morale: 0.34,
    biomes: [],
  },
  goblin_archer: {
    name: 'Goblin Archer',
    size: 0.86,
    speed: 4.2,
    hp: 9,
    rare: false,
    mountable: false,
    aggro: true,
    attackDmg: 2,        // it is very bad in melee, and knows it
    rangedRange: 16,
    rangedDmg: 4,
    disposition: 'raider',
    morale: 0.50,        // breaks earlier: it never wanted to be in the room
    biomes: [],
  },
  skeleton: {
    // Taller than the player and much slower. You cannot outfight a group of
    // these in the open — you have to use doorways, which is the whole point
    // of putting them in a dungeon.
    name: 'Skeleton',
    size: 1.45,
    speed: 3.1,
    hp: 26,
    rare: false,
    mountable: false,
    aggro: true,
    attackDmg: 5,
    disposition: 'undead',
    fearless: true,
    attackCooldown: 1.45, // slower than the 1.2 s norm — heavy, telegraphed
    biomes: [],
  },
  dread_king: {
    // The set piece. 1.92 m at the shoulder is roughly 2.4 m standing, half
    // again the player's height, and the greatsword adds 1.6 m of reach on top
    // of the shared 2.5 m contact distance — disengaging is the fight.
    name: 'Dread King',
    size: 1.92,
    speed: 4.2,
    hp: 170,
    rare: false,
    mountable: false,
    aggro: true,
    attackDmg: 8,        // three blows kill an unarmoured player
    attackCooldown: 1.9, // slow enough to read, punishing enough to respect
    reachBonus: 1.6,
    disposition: 'undead',
    fearless: true,
    biomes: [],
  },
  evil_king: {
    // The final boss. `size` is not a taste decision: the brief is that he
    // stands exactly twice the player's 1.62 m, and `HUMANOID_PLANS.evil_king`
    // closes his helm at 1.296 x size, so 3.24 / 1.296 = 2.5 and nothing else
    // will do. `scripts/test-boss-mesh.mts` asserts it against the measured
    // mesh; change one of the three numbers and it fails.
    //
    // Stats below are TUNED, not placeholders any more — see the block at the
    // end of this def. `reachBonus` was always real: his greatsword is 2.6 m
    // of blade and the hitbox has to agree with what the player sees.
    name: 'The Evil King',
    size: 2.5,
    speed: 4.6,
    // 300, not 420. The player's best starter weapon is a sword at 4 damage a
    // swing, so 420 is 105 connected hits and 300 is 75 — and he is the SECOND
    // half of the fight, after 260 hp of dragon. The pair is ~140 swings, which
    // at the openings this fight actually gives is two to three minutes. 420
    // made it five-plus, which is not difficulty, it is arithmetic.
    hp: 300,
    rare: false,
    mountable: false,
    aggro: true,
    // 5, not 14. `MAX_HP` is 20: at 14 he two-shots a full-health player and
    // one-shots a hurt one, so the fight had no recoverable mistakes at all.
    // At 5 it is four blows, ~7.6 s at his cadence — long enough to read a
    // losing exchange and disengage, short enough that standing in front of
    // him is still fatal.
    attackDmg: 5,
    // 1.9 s, not the shared 1.2: the cadence rule in `clips-attack.ts` is
    // `max(recovery) + max(windup) <= attackCooldown - SWING_GAP`, and his
    // overhead alone is 1.30 s. Also the fastest cadence at which
    // `test-anim.mts` still sees six blows in twelve seconds.
    attackCooldown: 1.9,
    reachBonus: 2.4,
    disposition: 'undead',
    fearless: true,
    // The handoff shed in `animal-ai.stepAnimal` keys off this. Without it the
    // unseated King arrived at the ordinary AI still wearing the borrowed
    // `owned` flag, followed the player around like a pet, and every blow he
    // did throw was swallowed by the caller's owned-guard — the fight's final
    // phase dealt zero damage.
    biomes: [],
  },
  black_dragon: {
    // His mount. 4.4 against the wild dragon's 3.5 — a 19 m wingspan, a saddle
    // 4.4 m up, and a head at 7.1 m. Everything scales off `size` inside
    // `buildDragon`, so this one number is the whole of "make him bigger".
    //
    // It was 5.0 first, and the offline mounted preview is why it is not: at
    // that scale the King's crown reached 7.5 m against a dragon head at 8.4 m
    // and a 22 m span, and he read as luggage. The rider has to be a peer of
    // the head he sits behind or the boss of the fight is the animal.
    name: 'Black Dragon',
    size: 4.4,
    speed: 7.5,
    // 260, not 600. The dragon is only reachable during its swoops and once it
    // has landed, so its health is not "how long the fight is" but "how many
    // openings the player has to convert". 600 was 150 sword hits against
    // roughly one connected hit per swoop — a fight measured in tens of
    // minutes. 260 is 65 hits, which is about six converted swoops to force it
    // down and a short brawl on the ground after that.
    //
    // `castle-fight.ts` reads this through `e.hp / SPECIES_DEFS.black_dragon.hp`
    // to pick its phase, so the 65%/30% thresholds move with it automatically.
    hp: 260,
    // `rare: false` and `mountable: false` even though he is neither common nor
    // unrideable, because both flags mean something narrower than they read.
    // `rare` is eligibility for the overworld rare-scatter pass, and this
    // animal is placed by the castle script and nothing else — a `rare: true`
    // species with `biomes: []` is a species the scatter chain silently
    // rejects anyway. `mountable` is the PLAYER's mount list, which drives
    // taming, save serialisation and the mount UI; the King rides him through
    // `kingRiderPlacement`, not through `main.ts:tickMount`.
    rare: false,
    mountable: false,
    canFly: true,
    aggro: true,
    // 6, not 20. Twenty is the player's ENTIRE health bar: the bite was a
    // guaranteed one-shot kill from full, which turns the grounded phase — the
    // phase the whole fight is built to reach — into a coin flip decided
    // before the player can react. At 6 the bite is the heaviest single blow
    // in the game and still leaves three of them to kill.
    attackDmg: 6,
    attackCooldown: 1.8,
    reachBonus: 2.0,
    disposition: 'predator',
    fearless: true,
    // Same shed as the King's (see `animal-ai.stepAnimal`): once the fight
    // grounds him and hands him to the ordinary AI, `owned` would make him a
    // follower who never bites.
    biomes: [],
  },
};

/** Dragon flight is enabled — demo flight pass active. */
export const DRAGON_FLIGHT_ENABLED = true;

/** Entity scatter cell size (m) — same grid as settlement/dungeon cells. */
export const ECELL = 512;
