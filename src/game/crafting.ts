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
 */

import { addItem, countItem, removeItem, type Inventory } from './inventory';
import type { GameItemId } from './items';

export type Station = 'hand' | 'fire' | 'forge';

/**
 * Caller (main.ts / UI) supplies this each frame; fire/forge detection arrives
 * in Phase H — for now main.ts provides conservative defaults.
 */
export interface StationContext {
  nearCampfire: boolean;
  nearForge: boolean;
  /** cooking_pot anywhere in inventory (pack or hotbar). */
  hasCookingPot: boolean;
}

export interface Recipe {
  output: GameItemId;
  count: number;
  inputs: [GameItemId, number][];
  /** Crafting station required. 'hand' = always available. */
  station: Station;
  /** In addition to the station, a cooking_pot must be in inventory. */
  needsPot?: boolean;
  /** UI tab category. */
  category: 'tools' | 'weapons' | 'armor' | 'food' | 'camp';
}

// ---------------------------------------------------------------------------
// Recipe table (~56 entries)
// ---------------------------------------------------------------------------

export const RECIPES: readonly Recipe[] = [
  // ---- existing recipes re-homed (station + category added) ---------------
  { output: 'oak_staff',    count: 1, inputs: [['logs', 3]],                                       station: 'hand',  category: 'tools'   },
  { output: 'iron_axe',     count: 1, inputs: [['iron_ingot', 2], ['sticks', 1]],                  station: 'forge', category: 'tools'   },
  { output: 'iron_pickaxe', count: 1, inputs: [['iron_ingot', 2], ['sticks', 1]],                  station: 'forge', category: 'tools'   },
  { output: 'iron_sword',   count: 1, inputs: [['iron_ingot', 3], ['sticks', 1]],                  station: 'forge', category: 'weapons' },
  { output: 'hunter_bow',   count: 1, inputs: [['logs', 2], ['healing_herb', 1]],                  station: 'hand',  category: 'weapons' },
  { output: 'meal',         count: 1, inputs: [['berries', 5]],                                    station: 'fire',  needsPot: true, category: 'food' },

  // ---- basic processed materials ------------------------------------------
  { output: 'sticks',      count: 4, inputs: [['logs', 1]],                                        station: 'hand',  category: 'camp'    },
  { output: 'planks',      count: 2, inputs: [['logs', 1]],                                        station: 'hand',  category: 'camp'    },
  { output: 'thread',      count: 1, inputs: [['plant_fiber', 2]],                                 station: 'hand',  category: 'camp'    },
  { output: 'thread',      count: 2, inputs: [['flax', 1]],                                        station: 'hand',  category: 'camp'    },
  { output: 'bow_string',  count: 1, inputs: [['thread', 2]],                                      station: 'hand',  category: 'weapons' },
  { output: 'rope',        count: 1, inputs: [['plant_fiber', 3]],                                 station: 'hand',  category: 'camp'    },
  { output: 'arrow_shaft', count: 4, inputs: [['sticks', 1]],                                      station: 'hand',  category: 'weapons' },
  { output: 'arrow',       count: 4, inputs: [['arrow_shaft', 1], ['feather', 1], ['stone', 1]],   station: 'hand',  category: 'weapons' },
  { output: 'wool_yarn',   count: 1, inputs: [['wool', 2]],                                        station: 'hand',  category: 'camp'    },
  { output: 'bone_needle', count: 1, inputs: [['bone', 1]],                                        station: 'hand',  category: 'tools'   },

  // ---- fire / shelter tools -----------------------------------------------
  { output: 'fire_starter', count: 1, inputs: [['sticks', 1], ['stone', 1]],                       station: 'hand', category: 'camp'    },
  { output: 'torch',        count: 4, inputs: [['sticks', 1], ['coal', 1]],                        station: 'hand', category: 'camp'    },
  { output: 'campfire_kit', count: 1, inputs: [['logs', 3], ['sticks', 2], ['coal', 1]],           station: 'hand', category: 'camp'    },

  // ---- smelting (forge) ---------------------------------------------------
  { output: 'copper_ingot', count: 1, inputs: [['copper_ore', 2]],                                 station: 'forge', category: 'camp'    },
  { output: 'tin_ingot',    count: 1, inputs: [['tin_ore', 2]],                                    station: 'forge', category: 'camp'    },
  { output: 'bronze_ingot', count: 1, inputs: [['copper_ingot', 1], ['tin_ingot', 1]],             station: 'forge', category: 'camp'    },
  { output: 'iron_ingot',   count: 1, inputs: [['ore', 2]],                                        station: 'forge', category: 'camp'    },

  // ---- tanning / leather --------------------------------------------------
  { output: 'leather',   count: 1, inputs: [['hide', 1]],                                          station: 'fire',  category: 'camp'    },
  { output: 'waterskin', count: 1, inputs: [['leather', 2], ['thread', 1], ['bone_needle', 1]],    station: 'hand',  category: 'camp'    },
  { output: 'iron_flask',  count: 1, inputs: [['iron_ingot', 2]],                                  station: 'forge', category: 'camp'    },
  { output: 'cooking_pot', count: 1, inputs: [['iron_ingot', 3]],                                  station: 'forge', category: 'camp'    },

  // ---- containers ---------------------------------------------------------
  { output: 'gourd_bottle', count: 1, inputs: [['gourd', 1]], station: 'hand', category: 'camp' },
  { output: 'gourd_bowl',   count: 1, inputs: [['gourd', 1]], station: 'hand', category: 'camp' },

  // ---- bronze weapons -----------------------------------------------------
  { output: 'bronze_sword',  count: 1, inputs: [['bronze_ingot', 2], ['sticks', 1]],               station: 'forge', category: 'weapons' },
  { output: 'spear',         count: 1, inputs: [['sticks', 2], ['stone', 1]],                      station: 'hand',  category: 'weapons' },
  { output: 'composite_bow', count: 1, inputs: [['logs', 2], ['bow_string', 1], ['rope', 1]],      station: 'hand',  category: 'weapons' },

  // ---- tents --------------------------------------------------------------
  { output: 'fiber_tent', count: 1, inputs: [['plant_fiber', 8], ['rope', 2], ['sticks', 2]],      station: 'hand', category: 'camp'    },
  { output: 'wool_tent',  count: 1, inputs: [['wool_yarn', 6], ['rope', 2], ['sticks', 2]],        station: 'hand', category: 'camp'    },
  { output: 'hide_tent',  count: 1, inputs: [['leather', 6], ['rope', 2], ['sticks', 2]],          station: 'hand', category: 'camp'    },

  // ---- fiber armor --------------------------------------------------------
  { output: 'fiber_hood',     count: 1, inputs: [['plant_fiber', 4], ['thread', 1]],               station: 'hand', category: 'armor'   },
  { output: 'fiber_tunic',    count: 1, inputs: [['plant_fiber', 6], ['thread', 2]],               station: 'hand', category: 'armor'   },
  { output: 'fiber_leggings', count: 1, inputs: [['plant_fiber', 5], ['thread', 1]],               station: 'hand', category: 'armor'   },

  // ---- leather armor ------------------------------------------------------
  { output: 'leather_cap',      count: 1, inputs: [['leather', 2], ['thread', 1], ['bone_needle', 1]], station: 'hand', category: 'armor' },
  { output: 'leather_tunic',    count: 1, inputs: [['leather', 4], ['thread', 2], ['bone_needle', 1]], station: 'hand', category: 'armor' },
  { output: 'leather_leggings', count: 1, inputs: [['leather', 3], ['thread', 1], ['bone_needle', 1]], station: 'hand', category: 'armor' },

  // ---- iron armor (forge) -------------------------------------------------
  { output: 'iron_helm',  count: 1, inputs: [['iron_ingot', 3]], station: 'forge', category: 'armor' },
  { output: 'iron_chest', count: 1, inputs: [['iron_ingot', 5]], station: 'forge', category: 'armor' },
  { output: 'iron_legs',  count: 1, inputs: [['iron_ingot', 4]], station: 'forge', category: 'armor' },

  // ---- food (fire + pot) --------------------------------------------------
  { output: 'meat_cooked',   count: 1, inputs: [['meat_raw', 1]],                                      station: 'fire',            category: 'food' },
  { output: 'hearty_stew',   count: 1, inputs: [['meat_raw', 2], ['mushroom', 1]],                     station: 'fire', needsPot: true, category: 'food' },
  { output: 'healing_potion',count: 1, inputs: [['healing_herb', 2], ['gourd_bottle', 1]],             station: 'fire', needsPot: true, category: 'food' },
  { output: 'warming_potion',count: 1, inputs: [['warming_herb', 2], ['gourd_bottle', 1]],             station: 'fire', needsPot: true, category: 'food' },
  { output: 'cooling_potion',count: 1, inputs: [['cooling_herb', 2], ['gourd_bottle', 1]],             station: 'fire', needsPot: true, category: 'food' },
  { output: 'stamina_potion',count: 1, inputs: [['healing_herb', 1], ['mushroom', 1], ['gourd_bottle', 1]], station: 'fire', needsPot: true, category: 'food' },
] as const satisfies readonly Recipe[];

// ---------------------------------------------------------------------------
// Station check helpers
// ---------------------------------------------------------------------------

/** True when the station requirement is met by the given context. */
function stationOk(recipe: Recipe, ctx: StationContext): boolean {
  switch (recipe.station) {
    case 'hand':  return true;
    case 'fire':  return ctx.nearCampfire || ctx.nearForge;
    case 'forge': return ctx.nearForge;
  }
}

/** True when the inventory holds every input AND the station is available. */
export function canCraft(inv: Inventory, recipe: Recipe, ctx: StationContext): boolean {
  if (!stationOk(recipe, ctx)) return false;
  if (recipe.needsPot && !ctx.hasCookingPot) return false;
  return recipe.inputs.every(([id, n]) => countItem(inv, id) >= n);
}

/**
 * Consume the inputs and add the output. Returns false (inventory
 * unchanged) when inputs are missing, station not available, or the output
 * does not fit.
 */
export function craft(inv: Inventory, recipe: Recipe, ctx: StationContext): boolean {
  if (!canCraft(inv, recipe, ctx)) return false;
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
