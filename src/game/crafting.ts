/**
 * Crafting model — pure, UI-free. A recipe turns gathered materials into a
 * tool/weapon/food/armor via the inventory model; crafting is atomic (inputs
 * are restored if the output has nowhere to go).
 *
 * Phase E additions:
 * - `station`  — where the recipe can be executed.
 * - `needsPot` — additionally requires a cooking_pot in inventory.
 * - `category` — UI tab grouping.
 * - `canCraft` / `craft` both accept a `StationContext` so station gating is
 *   enforced in the pure model (UI is free to grey buttons separately).
 *
 * THE PROGRESSION TREE lives on this same table rather than beside it, and
 * that is the whole design decision. Three fields carry it:
 *
 * - `key`    — a stable recipe id. NOT the output: `thread`, `torch` and
 *              `bone_needle` each have two recipes, and an unlock graph keyed
 *              on the output could not tell "crafting thread from flax" from
 *              "crafting thread from fibre". The key is what persists in a
 *              save, so it must never be renamed once shipped.
 * - `tier`   — which rung of the tree this is, 0..4. A pure projection of the
 *              station (plus the boss material at the summit); see `tierOf`,
 *              which `scripts/test-progression.mts` asserts against every row.
 * - `unlock` — the discovery rule. EVERY trigger must hold (AND), so `[]`
 *              means "known from the start". No RNG anywhere: a trigger is
 *              either "you have held this item" or "you have crafted this
 *              recipe", both of which are facts about a save file.
 *
 * The state machine that evaluates `unlock` and persists the result is
 * `progression/unlocks.ts`; this file stays a table.
 */

import { addItem, countItem, removeItem, type Inventory } from './inventory';
import type { GameItemId } from './items';

export type Station = 'hand' | 'fire' | 'forge' | 'loom';

/**
 * The tree's rungs. 4 is the summit and is deliberately not a station of its
 * own — dragonscale gear is forged like everything else at tier 2, and what
 * makes it the top of the tree is that the material only drops off a dragon.
 */
export type Tier = 0 | 1 | 2 | 3 | 4;

/** Player-facing rung names, indexed by tier. */
export const TIER_NAMES: readonly string[] = [
  'Hand', 'Campfire', 'Forge', 'Loom', 'Dragonscale',
];

/**
 * One condition for revealing a recipe. Both kinds are deterministic facts
 * about the save — there is no chance-to-discover and there never will be,
 * because a player who cannot re-derive why something appeared reads it as a
 * bug rather than as progress.
 */
export type UnlockTrigger =
  /** The player has held this item at least once (gathered, looted or made). */
  | { kind: 'acquire'; item: GameItemId }
  /** The player has crafted this recipe at least once. */
  | { kind: 'craft'; recipe: string };

/**
 * Caller (main.ts / UI) supplies this each frame; fire/forge detection arrives
 * in Phase H — for now main.ts provides conservative defaults.
 */
export interface StationContext {
  nearCampfire: boolean;
  nearForge: boolean;
  /** cooking_pot anywhere in inventory (pack or hotbar). */
  hasCookingPot: boolean;
  /**
   * Within CRAFT_LOOM_RADIUS of a placed loom. Optional so every existing
   * caller and every existing test fixture keeps compiling and keeps meaning
   * exactly what it meant — an absent loom is no loom.
   */
  nearLoom?: boolean;
}

export interface Recipe {
  /** Stable id — persisted in saves. See the header. */
  key: string;
  output: GameItemId;
  count: number;
  inputs: [GameItemId, number][];
  /** Crafting station required. 'hand' = always available. */
  station: Station;
  /** In addition to the station, a cooking_pot must be in inventory. */
  needsPot?: boolean;
  /** UI tab category. */
  category: 'tools' | 'weapons' | 'armor' | 'food' | 'camp';
  /** Progression rung. Must agree with `tierOf(recipe)`. */
  tier: Tier;
  /** ALL of these must hold before the recipe is revealed. `[]` = from start. */
  unlock: readonly UnlockTrigger[];
}

// ---------------------------------------------------------------------------
// Unlock-trigger shorthands
//
// `has` reads "you have held one of these", `made` reads "you have made one of
// these". Which to reach for is a rule, not a taste: use `has` whenever the
// trigger names a MATERIAL, because materials arrive from gathering, loot,
// trade and the starting pack as well as from a bench, and a tree that only
// counts the bench leaves a player holding 99 leather staring at a locked tent.
// Use `made` only for genuine ladder steps — the second piece of an armour set,
// the pickaxe after the axe — where the prerequisite is itself a bench output
// nobody can stumble into.
// ---------------------------------------------------------------------------

const has = (item: GameItemId): UnlockTrigger => ({ kind: 'acquire', item });
const made = (recipe: string): UnlockTrigger => ({ kind: 'craft', recipe });

// ---------------------------------------------------------------------------
// Recipe table — 68 entries, grouped by tier so the tree is legible in source
// ---------------------------------------------------------------------------

export const RECIPES: readonly Recipe[] = [
  // ═══ TIER 0 — the hands ═══════════════════════════════════════════════════
  // Two recipes are known from the first frame, and they are both a log turned
  // into something. Everything else in the game hangs off one of them or off a
  // material you have to go and find, which is what makes the tree a tree
  // rather than a list that happens to be sorted.
  { key: 'sticks',            output: 'sticks',       count: 4, inputs: [['logs', 1]],                                          station: 'hand', category: 'camp',    tier: 0, unlock: [] },
  { key: 'planks',            output: 'planks',       count: 2, inputs: [['logs', 1]],                                          station: 'hand', category: 'camp',    tier: 0, unlock: [] },
  { key: 'campfire_kit',      output: 'campfire_kit', count: 1, inputs: [['logs', 3], ['sticks', 2]],                           station: 'hand', category: 'camp',    tier: 0, unlock: [made('sticks')] },
  { key: 'fire_starter',      output: 'fire_starter', count: 1, inputs: [['sticks', 1], ['stone', 1]],                          station: 'hand', category: 'camp',    tier: 0, unlock: [has('stone')] },
  { key: 'thread_fiber',      output: 'thread',       count: 1, inputs: [['plant_fiber', 2]],                                   station: 'hand', category: 'camp',    tier: 0, unlock: [has('plant_fiber')] },
  { key: 'thread_flax',       output: 'thread',       count: 2, inputs: [['flax', 1]],                                          station: 'hand', category: 'camp',    tier: 0, unlock: [has('flax')] },
  { key: 'rope',              output: 'rope',         count: 1, inputs: [['plant_fiber', 3]],                                   station: 'hand', category: 'camp',    tier: 0, unlock: [has('plant_fiber')] },
  { key: 'wool_yarn',         output: 'wool_yarn',    count: 1, inputs: [['wool', 2]],                                          station: 'hand', category: 'camp',    tier: 0, unlock: [has('wool')] },
  { key: 'bone_needle_bone',  output: 'bone_needle',  count: 1, inputs: [['bone', 1]],                                          station: 'hand', category: 'tools',   tier: 0, unlock: [has('bone')] },
  { key: 'bone_needle_old',   output: 'bone_needle',  count: 1, inputs: [['old_bone', 1]],                                      station: 'hand', category: 'tools',   tier: 0, unlock: [has('old_bone')] },
  { key: 'torch_coal',        output: 'torch',        count: 4, inputs: [['sticks', 1], ['coal', 1]],                           station: 'hand', category: 'camp',    tier: 0, unlock: [has('coal')] },
  { key: 'torch_oil',         output: 'torch',        count: 2, inputs: [['sticks', 1], ['torch_oil', 1]],                      station: 'hand', category: 'camp',    tier: 0, unlock: [has('torch_oil')] },
  { key: 'gourd_bottle',      output: 'gourd_bottle', count: 1, inputs: [['gourd', 1]],                                         station: 'hand', category: 'camp',    tier: 0, unlock: [has('gourd')] },
  { key: 'gourd_bowl',        output: 'gourd_bowl',   count: 1, inputs: [['gourd', 1]],                                         station: 'hand', category: 'camp',    tier: 0, unlock: [has('gourd')] },
  { key: 'waterskin',         output: 'waterskin',    count: 1, inputs: [['leather', 2], ['thread', 1], ['bone_needle', 1]],    station: 'hand', category: 'camp',    tier: 0, unlock: [has('leather'), has('bone_needle')] },

  // Wood and string — the first weapons, and the only ladder a player can
  // climb on day one.
  { key: 'oak_staff',         output: 'oak_staff',    count: 1, inputs: [['logs', 3]],                                          station: 'hand', category: 'tools',   tier: 0, unlock: [made('planks')] },
  { key: 'spear',             output: 'spear',        count: 1, inputs: [['sticks', 2], ['stone', 1]],                          station: 'hand', category: 'weapons', tier: 0, unlock: [made('sticks'), has('stone')] },
  { key: 'bow_string',        output: 'bow_string',   count: 1, inputs: [['thread', 2]],                                        station: 'hand', category: 'weapons', tier: 0, unlock: [has('thread')] },
  { key: 'hunter_bow',        output: 'hunter_bow',   count: 1, inputs: [['logs', 2], ['bow_string', 1]],                       station: 'hand', category: 'weapons', tier: 0, unlock: [has('bow_string')] },
  { key: 'composite_bow',     output: 'composite_bow',count: 1, inputs: [['logs', 2], ['bow_string', 1], ['rope', 1]],          station: 'hand', category: 'weapons', tier: 0, unlock: [made('hunter_bow'), has('rope')] },
  { key: 'arrow_shaft',       output: 'arrow_shaft',  count: 4, inputs: [['sticks', 1]],                                        station: 'hand', category: 'weapons', tier: 0, unlock: [made('sticks')] },
  // The everyday quiver, and the one recipe that makes the bow a weapon rather
  // than an ornament. That is still true of Tintreach: it has NO recipe and
  // never will (see tintreach.ts). Flint does. `test-progression.mts` asserts
  // the tree cannot reach `arrow` from any direction, including a new one.
  { key: 'flint_arrow',       output: 'flint_arrow',  count: 4, inputs: [['arrow_shaft', 4], ['stone', 1], ['feather', 1]],     station: 'hand', category: 'weapons', tier: 0, unlock: [made('arrow_shaft'), has('feather')] },

  // Shelter. All three of these are the same shape in three materials, so they
  // unlock off the material rather than off each other.
  { key: 'fiber_tent',        output: 'fiber_tent',   count: 1, inputs: [['plant_fiber', 8], ['rope', 2], ['sticks', 2]],       station: 'hand', category: 'camp',    tier: 0, unlock: [has('rope'), has('plant_fiber')] },
  { key: 'wool_tent',         output: 'wool_tent',    count: 1, inputs: [['wool_yarn', 6], ['rope', 2], ['sticks', 2]],         station: 'hand', category: 'camp',    tier: 0, unlock: [has('wool_yarn')] },
  { key: 'hide_tent',         output: 'hide_tent',    count: 1, inputs: [['leather', 6], ['rope', 2], ['sticks', 2]],           station: 'hand', category: 'camp',    tier: 0, unlock: [has('leather'), has('rope')] },

  // Armour sets are the one place `made` earns its keep: the hood teaches the
  // stitch, and the tunic and leggings follow from it.
  { key: 'fiber_hood',        output: 'fiber_hood',     count: 1, inputs: [['plant_fiber', 4], ['thread', 1]],                  station: 'hand', category: 'armor',   tier: 0, unlock: [has('thread'), has('plant_fiber')] },
  { key: 'fiber_tunic',       output: 'fiber_tunic',    count: 1, inputs: [['plant_fiber', 6], ['thread', 2]],                  station: 'hand', category: 'armor',   tier: 0, unlock: [made('fiber_hood')] },
  { key: 'fiber_leggings',    output: 'fiber_leggings', count: 1, inputs: [['plant_fiber', 5], ['thread', 1]],                  station: 'hand', category: 'armor',   tier: 0, unlock: [made('fiber_tunic')] },
  { key: 'leather_cap',       output: 'leather_cap',    count: 1, inputs: [['leather', 2], ['thread', 1], ['bone_needle', 1]],  station: 'hand', category: 'armor',   tier: 0, unlock: [has('leather'), has('bone_needle')] },
  { key: 'leather_tunic',     output: 'leather_tunic',  count: 1, inputs: [['leather', 4], ['thread', 2], ['bone_needle', 1]],  station: 'hand', category: 'armor',   tier: 0, unlock: [made('leather_cap')] },
  { key: 'leather_leggings',  output: 'leather_leggings',count: 1,inputs: [['leather', 3], ['thread', 1], ['bone_needle', 1]],  station: 'hand', category: 'armor',   tier: 0, unlock: [made('leather_tunic')] },
  // The one ladder in this game whose bottom rung is reachable on day one: the
  // wooden shield is planks and thread, both hand-craftable from a log and some
  // flax, because a defence you cannot get until you find a forge is a defence
  // that arrives after the fights it was for. Filed under `armor` because that
  // is where a player looks for a shield; the stat ladder is combat/shields.ts.
  { key: 'wood_shield',       output: 'wood_shield',  count: 1, inputs: [['planks', 4], ['thread', 2]],                         station: 'hand', category: 'armor',   tier: 0, unlock: [made('planks'), has('thread')] },

  // ═══ TIER 1 — the campfire ════════════════════════════════════════════════
  // Heat, and what heat does to hide, meat and herbs. `needsPot` recipes gate
  // on HOLDING a pot rather than on having forged one, because the pot can
  // also be traded for or start in the pack.
  { key: 'leather',           output: 'leather',       count: 1, inputs: [['hide', 1]],                                         station: 'fire', category: 'camp',    tier: 1, unlock: [has('hide')] },
  { key: 'meat_cooked',       output: 'meat_cooked',   count: 1, inputs: [['meat_raw', 1]],                                     station: 'fire', category: 'food',    tier: 1, unlock: [has('meat_raw')] },
  { key: 'meal',              output: 'meal',          count: 1, inputs: [['berries', 5]],                                      station: 'fire', needsPot: true, category: 'food', tier: 1, unlock: [has('berries'), has('cooking_pot')] },
  { key: 'hearty_stew',       output: 'hearty_stew',   count: 1, inputs: [['meat_raw', 2], ['mushroom', 1]],                    station: 'fire', needsPot: true, category: 'food', tier: 1, unlock: [made('meat_cooked'), has('mushroom')] },
  { key: 'healing_potion',    output: 'healing_potion',count: 1, inputs: [['healing_herb', 2], ['gourd_bottle', 1]],            station: 'fire', needsPot: true, category: 'food', tier: 1, unlock: [has('healing_herb'), has('gourd_bottle')] },
  { key: 'warming_potion',    output: 'warming_potion',count: 1, inputs: [['warming_herb', 2], ['gourd_bottle', 1]],            station: 'fire', needsPot: true, category: 'food', tier: 1, unlock: [has('warming_herb'), has('gourd_bottle')] },
  { key: 'cooling_potion',    output: 'cooling_potion',count: 1, inputs: [['cooling_herb', 2], ['gourd_bottle', 1]],            station: 'fire', needsPot: true, category: 'food', tier: 1, unlock: [has('cooling_herb'), has('gourd_bottle')] },
  { key: 'stamina_potion',    output: 'stamina_potion',count: 1, inputs: [['healing_herb', 1], ['mushroom', 1], ['gourd_bottle', 1]], station: 'fire', needsPot: true, category: 'food', tier: 1, unlock: [made('healing_potion'), has('mushroom')] },

  // ═══ TIER 2 — the forge ═══════════════════════════════════════════════════
  // Reached by putting 8 stone into a lit campfire (main.ts, the E handler).
  // Smelting first, then everything smelting makes possible.
  { key: 'iron_ingot',        output: 'iron_ingot',   count: 1, inputs: [['ore', 2]],                                           station: 'forge', category: 'camp',   tier: 2, unlock: [has('ore')] },
  { key: 'copper_ingot',      output: 'copper_ingot', count: 1, inputs: [['copper_ore', 2]],                                    station: 'forge', category: 'camp',   tier: 2, unlock: [has('copper_ore')] },
  { key: 'tin_ingot',         output: 'tin_ingot',    count: 1, inputs: [['tin_ore', 2]],                                       station: 'forge', category: 'camp',   tier: 2, unlock: [has('tin_ore')] },
  { key: 'bronze_ingot',      output: 'bronze_ingot', count: 1, inputs: [['copper_ingot', 1], ['tin_ingot', 1]],                station: 'forge', category: 'camp',   tier: 2, unlock: [made('copper_ingot'), made('tin_ingot')] },
  { key: 'iron_flask',        output: 'iron_flask',   count: 1, inputs: [['iron_ingot', 2]],                                    station: 'forge', category: 'camp',   tier: 2, unlock: [has('iron_ingot')] },
  { key: 'cooking_pot',       output: 'cooking_pot',  count: 1, inputs: [['iron_ingot', 3]],                                    station: 'forge', category: 'camp',   tier: 2, unlock: [has('iron_ingot')] },
  { key: 'iron_axe',          output: 'iron_axe',     count: 1, inputs: [['iron_ingot', 2], ['sticks', 1]],                     station: 'forge', category: 'tools',  tier: 2, unlock: [has('iron_ingot')] },
  { key: 'iron_pickaxe',      output: 'iron_pickaxe', count: 1, inputs: [['iron_ingot', 2], ['sticks', 1]],                     station: 'forge', category: 'tools',  tier: 2, unlock: [made('iron_axe')] },
  { key: 'iron_sword',        output: 'iron_sword',   count: 1, inputs: [['iron_ingot', 3], ['sticks', 1]],                     station: 'forge', category: 'weapons',tier: 2, unlock: [has('iron_ingot')] },
  { key: 'bronze_axe',        output: 'bronze_axe',   count: 1, inputs: [['bronze_ingot', 2], ['sticks', 1]],                   station: 'forge', category: 'tools',  tier: 2, unlock: [has('bronze_ingot')] },
  { key: 'bronze_pickaxe',    output: 'bronze_pickaxe',count: 1,inputs: [['bronze_ingot', 2], ['sticks', 1]],                   station: 'forge', category: 'tools',  tier: 2, unlock: [made('bronze_axe')] },
  { key: 'bronze_sword',      output: 'bronze_sword', count: 1, inputs: [['bronze_ingot', 2], ['sticks', 1]],                   station: 'forge', category: 'weapons',tier: 2, unlock: [has('bronze_ingot')] },
  { key: 'iron_helm',         output: 'iron_helm',    count: 1, inputs: [['iron_ingot', 3]],                                    station: 'forge', category: 'armor',  tier: 2, unlock: [has('iron_ingot')] },
  { key: 'iron_chest',        output: 'iron_chest',   count: 1, inputs: [['iron_ingot', 5]],                                    station: 'forge', category: 'armor',  tier: 2, unlock: [made('iron_helm')] },
  { key: 'iron_legs',         output: 'iron_legs',    count: 1, inputs: [['iron_ingot', 4]],                                    station: 'forge', category: 'armor',  tier: 2, unlock: [made('iron_chest')] },
  // Every shield above wood keeps a wooden core (planks) — these are faced
  // boards, not solid plate, which is also why the wooden one still burns
  // (`fuel` on the item def) and the others do not.
  { key: 'bronze_shield',     output: 'bronze_shield',count: 1, inputs: [['bronze_ingot', 3], ['planks', 2], ['leather', 1]],   station: 'forge', category: 'armor',  tier: 2, unlock: [made('wood_shield'), has('bronze_ingot')] },
  { key: 'iron_shield',       output: 'iron_shield',  count: 1, inputs: [['iron_ingot', 4], ['planks', 2], ['leather', 1]],     station: 'forge', category: 'armor',  tier: 2, unlock: [made('wood_shield'), has('iron_ingot')] },
  // THE BRIDGE. The loom is a forge product and the loom is a station, which
  // is the only reason tier 3 sits above tier 2 at all: its reed and heddle rod
  // are iron. Placed like a campfire; see loom.ts.
  { key: 'loom_kit',          output: 'loom_kit',     count: 1, inputs: [['planks', 6], ['iron_ingot', 2], ['rope', 2]],        station: 'forge', category: 'camp',   tier: 2, unlock: [has('iron_ingot'), has('rope')] },

  // ═══ TIER 3 — the loom ════════════════════════════════════════════════════
  // The yarn game's own station. Spinning was already solved by hand
  // (`wool → wool_yarn` up at tier 0), so the verb the loom adds is WEAVING,
  // and the only thing it makes directly is cloth — from either fibre, because
  // a player who found flax and a player who found sheep both deserve a loom.
  { key: 'cloth_wool',        output: 'cloth',        count: 2, inputs: [['wool_yarn', 3]],                                     station: 'loom', category: 'camp',    tier: 3, unlock: [made('loom_kit')] },
  { key: 'cloth_thread',      output: 'cloth',        count: 2, inputs: [['thread', 4]],                                        station: 'loom', category: 'camp',    tier: 3, unlock: [made('loom_kit')] },
  // Quilted armour: worse than iron in a fight, better than iron on a mountain.
  { key: 'quilted_hood',      output: 'quilted_hood', count: 1, inputs: [['cloth', 3], ['thread', 1], ['bone_needle', 1]],      station: 'loom', category: 'armor',   tier: 3, unlock: [has('cloth')] },
  { key: 'quilted_tunic',     output: 'quilted_tunic',count: 1, inputs: [['cloth', 5], ['thread', 2], ['bone_needle', 1]],      station: 'loom', category: 'armor',   tier: 3, unlock: [made('quilted_hood')] },
  { key: 'quilted_leggings',  output: 'quilted_leggings',count: 1,inputs:[['cloth', 4], ['thread', 1], ['bone_needle', 1]],     station: 'loom', category: 'armor',   tier: 3, unlock: [made('quilted_tunic')] },
  // The walk-in tent — the loom's answer to "we can build tents but the
  // character can't go inside". Six cloth is a lot of weaving and it should be:
  // this is the one shelter with a floor you can put a forge on.
  { key: 'canvas_tent',       output: 'canvas_tent',  count: 1, inputs: [['cloth', 6], ['rope', 3], ['planks', 2]],             station: 'loom', category: 'camp',    tier: 3, unlock: [has('cloth'), has('rope')] },

  // ═══ TIER 4 — dragonscale, the summit ═════════════════════════════════════
  // Forged, like tier 2, and gated on a material no bench can make. Each piece
  // also wants the iron piece below it already made, so the summit is the top
  // of a climb rather than a thing 20 scales buys outright.
  { key: 'dragonscale_helm',  output: 'dragonscale_helm', count: 1, inputs: [['dragon_scale', 3], ['iron_ingot', 1], ['leather', 1]], station: 'forge', category: 'armor', tier: 4, unlock: [has('dragon_scale'), made('iron_helm')] },
  { key: 'dragonscale_chest', output: 'dragonscale_chest',count: 1, inputs: [['dragon_scale', 6], ['iron_ingot', 2], ['leather', 2]], station: 'forge', category: 'armor', tier: 4, unlock: [made('dragonscale_helm')] },
  { key: 'dragonscale_legs',  output: 'dragonscale_legs', count: 1, inputs: [['dragon_scale', 4], ['iron_ingot', 1], ['leather', 1]], station: 'forge', category: 'armor', tier: 4, unlock: [made('dragonscale_chest')] },
  // Five scales — one wyvern will not do it, and a dragon barely will. The
  // iron is the boss and the rim banding; the leather is the arm strap.
  { key: 'dragonscale_shield',output: 'dragonscale_shield',count: 1,inputs: [['dragon_scale', 5], ['iron_ingot', 2], ['leather', 2]], station: 'forge', category: 'armor', tier: 4, unlock: [has('dragon_scale'), made('iron_shield')] },
] as const satisfies readonly Recipe[];

// ---------------------------------------------------------------------------
// Tree shape
// ---------------------------------------------------------------------------

/** Recipe lookup by stable key. Built once; the table never changes at runtime. */
const BY_KEY = new Map<string, Recipe>(RECIPES.map((r) => [r.key, r]));

/** The recipe with this key, or undefined. */
export function recipeByKey(key: string): Recipe | undefined {
  return BY_KEY.get(key);
}

/**
 * The tier a recipe BELONGS to, derived rather than trusted.
 *
 * `tier` is stored on the row so the table reads as a tree, but a stored field
 * drifts; this is the definition, and `test-progression.mts` asserts the two
 * agree for all 68 rows. The rule: your tier is your station, except that a
 * forge recipe wanting a material that only a dragon carries is the summit.
 */
export function tierOf(recipe: Recipe): Tier {
  const bossMaterial = recipe.inputs.some(([id]) => id === 'dragon_scale');
  switch (recipe.station) {
    case 'hand':  return 0;
    case 'fire':  return 1;
    case 'forge': return bossMaterial ? 4 : 2;
    case 'loom':  return 3;
  }
}

// ---------------------------------------------------------------------------
// Station check helpers
// ---------------------------------------------------------------------------

/** True when the station requirement is met by the given context. */
function stationOk(recipe: Recipe, ctx: StationContext): boolean {
  switch (recipe.station) {
    case 'hand':  return true;
    case 'fire':  return ctx.nearCampfire || ctx.nearForge;
    case 'forge': return ctx.nearForge;
    // A loom is a loom. It is deliberately NOT satisfied by a forge the way
    // fire is: the forge is a hotter campfire, but nothing about a hearth
    // weaves cloth.
    case 'loom':  return ctx.nearLoom === true;
  }
}

/**
 * Discovery gate, supplied by the caller when there is one.
 *
 * Kept as a structural parameter rather than an import of
 * `progression/unlocks.ts` so this module stays dependency-free and every
 * existing call site — which passes nothing — keeps its old meaning: no
 * progress record means no gate, which is what unit fixtures want.
 */
export interface UnlockGate {
  has(key: string): boolean;
}

/** True when the inventory holds every input AND the station is available. */
export function canCraft(
  inv: Inventory,
  recipe: Recipe,
  ctx: StationContext,
  unlocked?: UnlockGate,
): boolean {
  if (unlocked !== undefined && !unlocked.has(recipe.key)) return false;
  if (!stationOk(recipe, ctx)) return false;
  if (recipe.needsPot && !ctx.hasCookingPot) return false;
  return recipe.inputs.every(([id, n]) => countItem(inv, id) >= n);
}

/**
 * Consume the inputs and add the output. Returns false (inventory
 * unchanged) when inputs are missing, station not available, the recipe is
 * still undiscovered, or the output does not fit.
 */
export function craft(
  inv: Inventory,
  recipe: Recipe,
  ctx: StationContext,
  unlocked?: UnlockGate,
): boolean {
  if (!canCraft(inv, recipe, ctx, unlocked)) return false;
  for (const [id, n] of recipe.inputs) removeItem(inv, id, n);
  const leftover = addItem(inv, recipe.output, recipe.count);
  if (leftover > 0) {
    // No room for the output: undo the partial add, then restore the
    // inputs (the space they were removed from still exists).
    removeItem(inv, recipe.output, recipe.count - leftover);
    for (const [id, n] of recipe.inputs) addItem(inv, id, n);
    return false;
  }
  return true;
}
