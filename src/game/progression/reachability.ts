/**
 * The flood — can a player who starts with nothing reach every recipe?
 *
 * The castle floods rooms to prove no room is walled off; this floods the
 * crafting tree to prove no recipe is. Same shape of argument: start from what
 * the world gives you for free, repeatedly take every step you can now take,
 * and see what you never arrive at. Anything left over is an orphan — a recipe
 * whose ingredients, station or unlock conditions form a loop, a dead end, or a
 * dependency on something no longer in the game.
 *
 * QUANTITIES ARE IGNORED ON PURPOSE. This asks "is this obtainable at all",
 * not "is it obtainable this afternoon". A recipe wanting six cloth and one
 * wanting one cloth are the same question to a reachability proof, and
 * modelling counts would turn a crisp yes/no into a balance opinion.
 *
 * Pure and table-driven: it takes the recipe list as an argument rather than
 * importing `RECIPES` directly, which is what lets the test hand it a DOCTORED
 * table and prove the flood actually fails when a recipe really is orphaned.
 * A reachability test that cannot fail is decoration.
 */

import type { Recipe, Station } from '../crafting';
import type { GameItemId } from '../items';

export interface FloodResult {
  /** Recipe keys the player can reach, in the order they became reachable. */
  order: string[];
  /** Recipe keys reached. */
  reached: Set<string>;
  /** Every item id obtainable — world sources plus everything craftable. */
  items: Set<GameItemId>;
  /** Stations that can be built and stood at. */
  stations: Set<Station>;
  /** Recipes never reached. Empty is the passing condition. */
  orphans: Recipe[];
}

/**
 * What each station costs to have, expressed in items.
 *
 * These mirror what main.ts actually requires, and each one is a claim that
 * can be checked against the game rather than a convenience:
 *   fire  — a placed campfire_kit. (Lighting it also wants a fire_starter or a
 *           torch and one log for tinder, all of which are strictly easier to
 *           get than the kit itself, so the kit is the binding constraint.)
 *   forge — a lit campfire plus 8 stone, the E-key upgrade.
 *   loom  — a placed loom_kit.
 *   hand  — you have hands.
 */
function stationReady(station: Station, items: ReadonlySet<GameItemId>): boolean {
  switch (station) {
    case 'hand':  return true;
    case 'fire':  return items.has('campfire_kit');
    case 'forge': return items.has('campfire_kit') && items.has('stone');
    case 'loom':  return items.has('loom_kit');
  }
}

/** True when every unlock trigger can be satisfied at this point in the flood. */
function unlockReachable(
  recipe: Recipe,
  items: ReadonlySet<GameItemId>,
  made: ReadonlySet<string>,
): boolean {
  for (const t of recipe.unlock) {
    if (t.kind === 'acquire') {
      if (!items.has(t.item)) return false;
    } else if (!made.has(t.recipe)) {
      return false;
    }
  }
  return true;
}

/**
 * Flood the tree from `worldSources` (everything obtainable without a bench:
 * gathered nodes, animal drops, dungeon loot, merchant stock).
 */
export function floodTree(
  recipes: readonly Recipe[],
  worldSources: Iterable<GameItemId>,
): FloodResult {
  const items = new Set<GameItemId>(worldSources);
  const reached = new Set<string>();
  const order: string[] = [];

  for (;;) {
    let progressed = false;
    for (const r of recipes) {
      if (reached.has(r.key)) continue;
      if (!stationReady(r.station, items)) continue;
      // A pot is a second station in all but name — it is carried rather than
      // placed, but a recipe that needs one is as blocked without it.
      if (r.needsPot === true && !items.has('cooking_pot')) continue;
      if (!unlockReachable(r, items, reached)) continue;
      let haveInputs = true;
      for (const [id] of r.inputs) {
        if (!items.has(id)) { haveInputs = false; break; }
      }
      if (!haveInputs) continue;
      reached.add(r.key);
      order.push(r.key);
      items.add(r.output);
      progressed = true;
    }
    if (!progressed) break;
  }

  const stations = new Set<Station>();
  for (const s of ['hand', 'fire', 'forge', 'loom'] as const) {
    if (stationReady(s, items)) stations.add(s);
  }

  return {
    order,
    reached,
    items,
    stations,
    orphans: recipes.filter((r) => !reached.has(r.key)),
  };
}
