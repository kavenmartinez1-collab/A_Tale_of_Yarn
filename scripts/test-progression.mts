/**
 * Relations and reachability for the crafting/building progression tree.
 *
 * Three questions, and they are not the same question:
 *
 *   1. IS THE TABLE CONSISTENT — keys unique, every stored `tier` equal to the
 *      tier its station implies, every `made(...)` naming a recipe that exists,
 *      and the unlock graph acyclic. A cycle here is invisible in play: the two
 *      recipes simply never appear, forever, and nothing errors.
 *
 *   2. IS EVERYTHING REACHABLE — flood the tree from what the world hands out
 *      for free and check nothing is left over. The world sources are read from
 *      the REAL tables (resource nodes, animal drops, dungeon loot, merchant
 *      catalogues), not from a list retyped here, so deleting the only node
 *      that drops flax fails this file rather than silently orphaning six
 *      recipes.
 *
 *   3. DOES THE FLOOD ACTUALLY FAIL — §5 orphans a recipe on purpose and
 *      asserts the flood reports it. A reachability proof that cannot fail is
 *      decoration, and this one is cheap to keep honest.
 *
 * Plus the two invariants the tree must not break: Tintreach stays uncraftable
 * from every direction, and the tent volume the player shelters in is the tent
 * volume the mesh builder draws.
 *
 * Run:  npx tsx scripts/test-progression.mts
 */

import {
  RECIPES, TIER_NAMES, tierOf, recipeByKey,
  canCraft, craft,
  type Recipe, type StationContext, type Tier,
} from '../src/game/crafting';
import { floodTree } from '../src/game/progression/reachability';
import {
  createProgress, noteItems, noteCraft, observeInventory,
  isUnlocked, unlockGate, requirementText,
  serializeProgress, deserializeProgress, unlockMet,
  PROGRESS_KEY,
} from '../src/game/progression/unlocks';
import { ITEM_DEFS, isGameItemId, TINTREACH_ID, type GameItemId } from '../src/game/items';
import { createInventory, createStarterInventory, addItem, countItem } from '../src/game/inventory';
import { GAME_STATE_KEYS } from '../src/game/save-game';
import { LOOMS_KEY, CRAFT_LOOM_RADIUS, createLoom, nearLoom, resetLoomIds,
  serializeLooms, deserializeLooms } from '../src/game/loom';
import { buildLoomMeshes } from '../src/game/loom-mesh';
import {
  TENT_BOX, TENTS_KEY, createTent, tentAt, tentRoofAt, tentBox, resetTentIds,
  deserializeTents, type PlacedTent,
} from '../src/game/shelter';
import { buildTentMeshes } from '../src/game/fire-mesh';
import { RESOURCE_DROPS } from '../src/game/resource-scatter';
import { DROP_TABLE } from '../src/game/entities/animal-drops';
import { KNOWN_ITEMS } from '../src/game/dungeon/dungeon-spec';
import { TRADE_CATALOG } from '../src/game/npc/npc-trade';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// World sources — everything obtainable WITHOUT a crafting bench.
//
// Assembled from the live tables. `logs` is the one hand-written entry: felling
// a tree is not in RESOURCE_DROPS, it is a fixed `[['logs', 2]]` in main.ts's
// gather handler, and there is no exported table to read it from.
// ---------------------------------------------------------------------------

const worldSources = new Set<GameItemId>();
worldSources.add('logs'); // main.ts gather handler: node.type === 'tree'
for (const rows of Object.values(RESOURCE_DROPS)) {
  for (const r of rows) worldSources.add(r.id);
}
for (const rows of Object.values(DROP_TABLE)) {
  for (const r of rows) worldSources.add(r.id);
}
for (const id of KNOWN_ITEMS) worldSources.add(id as GameItemId);
for (const list of Object.values(TRADE_CATALOG)) {
  for (const e of list) worldSources.add(e.id);
}

// ---------------------------------------------------------------------------
// 1. Table integrity
// ---------------------------------------------------------------------------

{
  check('tree has at least 60 recipes', RECIPES.length >= 60, `${RECIPES.length}`);
  check('five tier names', TIER_NAMES.length === 5, TIER_NAMES.join('/'));

  const keys = new Set<string>();
  for (const r of RECIPES) {
    check(`key is non-empty: ${r.output}`, typeof r.key === 'string' && r.key.length > 0);
    check(`key is unique: ${r.key}`, !keys.has(r.key));
    keys.add(r.key);
    check(`recipeByKey round-trips: ${r.key}`, recipeByKey(r.key) === r);
    check(`stored tier matches station: ${r.key}`, r.tier === tierOf(r),
      `stored ${r.tier}, station '${r.station}' implies ${tierOf(r)}`);
    check(`tier is 0..4: ${r.key}`, r.tier >= 0 && r.tier <= 4);
    check(`output is a real item: ${r.key}`, isGameItemId(r.output));
    check(`inputs are real items: ${r.key}`,
      r.inputs.every(([id]) => isGameItemId(id)));
    check(`output fits a stack: ${r.key}`,
      r.count >= 1 && r.count <= ITEM_DEFS[r.output].stack);
  }

  // Tier ↔ station, stated as the relation rather than as the function, so a
  // change to `tierOf` alone cannot make this vacuous.
  const stationForTier: Record<number, string> = {
    0: 'hand', 1: 'fire', 2: 'forge', 3: 'loom', 4: 'forge',
  };
  for (const r of RECIPES) {
    check(`tier ${r.tier} implies station '${stationForTier[r.tier]}': ${r.key}`,
      r.station === stationForTier[r.tier]);
  }
  // The summit is the summit BECAUSE of the material, not because of a label.
  for (const r of RECIPES) {
    const boss = r.inputs.some(([id]) => id === 'dragon_scale');
    check(`dragon scale iff tier 4: ${r.key}`, boss === (r.tier === 4));
  }
  const tier4 = RECIPES.filter((r) => r.tier === 4);
  check('the summit has four pieces', tier4.length === 4, `${tier4.length}`);
  const loomTier = RECIPES.filter((r) => r.tier === 3);
  check('the loom tier is populated', loomTier.length >= 5, `${loomTier.length}`);
}

// ---------------------------------------------------------------------------
// 2. The unlock graph — references resolve, and it is acyclic
// ---------------------------------------------------------------------------

{
  const keys = new Set(RECIPES.map((r) => r.key));
  for (const r of RECIPES) {
    for (const t of r.unlock) {
      if (t.kind === 'craft') {
        check(`craft trigger names a real recipe: ${r.key} ← ${t.recipe}`,
          keys.has(t.recipe));
        check(`no self-unlock: ${r.key}`, t.recipe !== r.key);
      } else {
        check(`acquire trigger names a real item: ${r.key} ← ${t.item}`,
          isGameItemId(t.item));
      }
    }
    check(`at most 2 conditions (a locked row shows one line): ${r.key}`,
      r.unlock.length <= 2, `${r.unlock.length}`);
  }

  // Acyclicity over the craft edges, by DFS with a colour marker.
  const colour = new Map<string, 0 | 1 | 2>();
  const cycles: string[] = [];
  const visit = (key: string, path: string[]): void => {
    const c = colour.get(key) ?? 0;
    if (c === 1) { cycles.push([...path, key].join(' → ')); return; }
    if (c === 2) return;
    colour.set(key, 1);
    const r = recipeByKey(key);
    if (r !== undefined) {
      for (const t of r.unlock) {
        if (t.kind === 'craft') visit(t.recipe, [...path, key]);
      }
    }
    colour.set(key, 2);
  };
  for (const r of RECIPES) visit(r.key, []);
  check('the unlock graph is acyclic', cycles.length === 0, cycles.join(' | '));

  // Seeds. With no seed nothing can ever open, however sound the graph is.
  const seeds = RECIPES.filter((r) => r.unlock.length === 0);
  check('the tree has at least one seed recipe', seeds.length >= 1,
    seeds.map((r) => r.key).join(', '));
  check('every seed is hand-crafted from a world material',
    seeds.every((r) => r.station === 'hand'
      && r.inputs.every(([id]) => worldSources.has(id))),
    seeds.map((r) => r.key).join(', '));
}

// ---------------------------------------------------------------------------
// 3. THE FLOOD — everything is reachable from a fresh start
// ---------------------------------------------------------------------------

const flood = floodTree(RECIPES, worldSources);

{
  check('world sources are non-trivial', worldSources.size >= 25, `${worldSources.size}`);
  check('the flood reaches every recipe', flood.orphans.length === 0,
    flood.orphans.map((r) => `${r.key} (needs ${r.inputs.map(([i]) => i).join('+')})`).join(', '));
  check('the flood reaches every station',
    flood.stations.has('hand') && flood.stations.has('fire')
    && flood.stations.has('forge') && flood.stations.has('loom'),
    [...flood.stations].join(','));

  // The order is a real claim about the shape of the tree: you cannot weave
  // before you forge, and you cannot forge before you light a fire.
  const at = (key: string) => flood.order.indexOf(key);
  check('the campfire kit precedes anything cooked',
    at('campfire_kit') < at('leather'), `${at('campfire_kit')} < ${at('leather')}`);
  check('smelting precedes the loom',
    at('iron_ingot') < at('loom_kit'), `${at('iron_ingot')} < ${at('loom_kit')}`);
  check('the loom precedes cloth',
    at('loom_kit') < at('cloth_wool'), `${at('loom_kit')} < ${at('cloth_wool')}`);
  check('cloth precedes the canvas tent',
    at('cloth_wool') < at('canvas_tent'), `${at('cloth_wool')} < ${at('canvas_tent')}`);
  check('iron armour precedes dragonscale',
    at('iron_helm') < at('dragonscale_helm'), `${at('iron_helm')} < ${at('dragonscale_helm')}`);
  check('the wooden shield precedes the dragonscale one',
    at('wood_shield') < at('dragonscale_shield'));

  // Both fibre routes to cloth survive, which is what stops the loom from
  // depending on a single merchant who sells wool.
  check('cloth is reachable by the wool route', flood.reached.has('cloth_wool'));
  check('cloth is reachable by the flax route', flood.reached.has('cloth_thread'));
}

// ---------------------------------------------------------------------------
// 4. Tintreach stays out of the tree — from every direction
// ---------------------------------------------------------------------------

{
  check('no recipe outputs the Tintreach quiver',
    RECIPES.every((r) => r.output !== TINTREACH_ID));
  check('no recipe key is the Tintreach id',
    RECIPES.every((r) => r.key !== TINTREACH_ID));
  check('no recipe CONSUMES it either (it is not an ingredient in a ladder)',
    RECIPES.every((r) => r.inputs.every(([id]) => id !== TINTREACH_ID)));
  check('no unlock trigger keys on holding it',
    RECIPES.every((r) => r.unlock.every(
      (t) => t.kind !== 'acquire' || t.item !== TINTREACH_ID)));

  // The strong form: flood a world that does NOT hand out Tintreach and check
  // the tree cannot mint any. This is the assertion that survives someone
  // adding a recipe later without reading the comment above it.
  const dry = new Set(worldSources);
  dry.delete(TINTREACH_ID);
  const dryFlood = floodTree(RECIPES, dry);
  check('the tree cannot mint Tintreach arrows', !dryFlood.items.has(TINTREACH_ID));
  check('and closing that faucet orphans nothing else', dryFlood.orphans.length === 0,
    dryFlood.orphans.map((r) => r.key).join(', '));
  // The everyday quiver is craftable, which is the other half of the rule:
  // Tintreach being closed must not leave the bow with nothing to shoot.
  check('flint arrows ARE craftable', flood.reached.has('flint_arrow'));
}

// ---------------------------------------------------------------------------
// 5. MUTATION — prove the flood can fail
// ---------------------------------------------------------------------------

{
  // (a) Orphan by ingredient: a recipe wanting something no source provides.
  const orphaned: Recipe[] = RECIPES.map((r) => r.key === 'quilted_hood'
    ? { ...r, inputs: [['ancient_relic', 3]] as [GameItemId, number][] }
    : r);
  const strippedSources = new Set(worldSources);
  strippedSources.delete('ancient_relic');
  const mutA = floodTree(orphaned, strippedSources);
  check('MUTATION a: an unobtainable ingredient orphans its recipe',
    mutA.orphans.some((r) => r.key === 'quilted_hood'),
    `orphans: ${mutA.orphans.map((r) => r.key).join(', ') || 'none'}`);
  check('MUTATION a: and cascades to what depended on it',
    mutA.orphans.some((r) => r.key === 'quilted_tunic'));

  // (b) Orphan by unlock: a craft trigger naming a recipe that cannot be made.
  const dangling: Recipe[] = RECIPES.map((r) => r.key === 'cloth_wool'
    ? { ...r, unlock: [{ kind: 'craft', recipe: 'no_such_recipe' } as const] }
    : r);
  const mutB = floodTree(dangling, worldSources);
  check('MUTATION b: a dangling craft trigger orphans its recipe',
    mutB.orphans.some((r) => r.key === 'cloth_wool'));

  // (c) Orphan by station: remove the loom kit and the whole tier goes dark.
  const noLoom = RECIPES.filter((r) => r.key !== 'loom_kit');
  const mutC = floodTree(noLoom, worldSources);
  check('MUTATION c: no loom kit means no loom tier',
    mutC.orphans.length >= 5 && mutC.orphans.every((r) => r.station === 'loom'),
    `${mutC.orphans.length} orphans: ${mutC.orphans.map((r) => r.key).join(', ')}`);
  check('MUTATION c: and the rest of the tree is unaffected',
    mutC.orphans.every((r) => r.tier === 3));

  // (d) A cycle really is unreachable, which is why §2 tests for one.
  const cyclic: Recipe[] = RECIPES.map((r) => {
    if (r.key === 'planks') return { ...r, unlock: [{ kind: 'craft', recipe: 'sticks' } as const] };
    if (r.key === 'sticks') return { ...r, unlock: [{ kind: 'craft', recipe: 'planks' } as const] };
    return r;
  });
  const mutD = floodTree(cyclic, worldSources);
  check('MUTATION d: a two-node cycle strands both ends',
    mutD.orphans.some((r) => r.key === 'sticks')
    && mutD.orphans.some((r) => r.key === 'planks'));
}

// ---------------------------------------------------------------------------
// 6. The discovery state machine
// ---------------------------------------------------------------------------

{
  const p = createProgress();
  const seeds = RECIPES.filter((r) => r.unlock.length === 0).map((r) => r.key);
  check('a virgin tree opens exactly the seed recipes',
    p.unlocked.size === seeds.length && seeds.every((k) => p.unlocked.has(k)),
    `${p.unlocked.size} open: ${[...p.unlocked].join(', ')}`);
  check('a virgin tree has made nothing', p.crafted.size === 0 && p.seen.size === 0);
  check('the loom tier starts locked',
    RECIPES.filter((r) => r.tier === 3).every((r) => !isUnlocked(p, r.key)));
  check('the summit starts locked',
    RECIPES.filter((r) => r.tier === 4).every((r) => !isUnlocked(p, r.key)));

  // Acquire reveals.
  const revealed = noteItems(p, ['flax']);
  check('picking up flax reveals the flax thread recipe', revealed.includes('thread_flax'));
  check('and does NOT reveal the fibre one', !isUnlocked(p, 'thread_fiber'));
  check('noteItems is idempotent', noteItems(p, ['flax']).length === 0);

  // Craft reveals, and cascades.
  noteItems(p, ['plant_fiber', 'thread']);
  check('thread in hand reveals the fibre hood', isUnlocked(p, 'fiber_hood'));
  check('the tunic is still locked', !isUnlocked(p, 'fiber_tunic'));
  const afterHood = noteCraft(p, 'fiber_hood');
  check('making the hood reveals the tunic', afterHood.includes('fiber_tunic'));
  check('but not the leggings — one rung at a time', !isUnlocked(p, 'fiber_leggings'));
  check('making the tunic reveals the leggings',
    noteCraft(p, 'fiber_tunic').includes('fiber_leggings'));
  check('noteCraft is idempotent', noteCraft(p, 'fiber_tunic').length === 0);

  // AND semantics: dragonscale needs BOTH the scale and the iron helm.
  const q = createProgress();
  noteItems(q, ['dragon_scale']);
  check('scales alone do not open the summit', !isUnlocked(q, 'dragonscale_helm'));
  noteCraft(q, 'iron_helm');
  check('scales AND a forged helm do', isUnlocked(q, 'dragonscale_helm'));

  // Order independence — the property that makes the tree explicable.
  const a = createProgress();
  noteItems(a, ['dragon_scale']);
  noteCraft(a, 'iron_helm');
  const b = createProgress();
  noteCraft(b, 'iron_helm');
  noteItems(b, ['dragon_scale']);
  check('two orders give the same tree',
    serializeProgress(a) === serializeProgress(b));

  // requirementText names the FIRST unmet condition and updates as you go.
  const r = createProgress();
  const dsHelm = recipeByKey('dragonscale_helm')!;
  check('requirement text names the missing material',
    requirementText(dsHelm, r) === 'Discover: Dragon Scale', requirementText(dsHelm, r));
  noteItems(r, ['dragon_scale']);
  check('and then names the missing prerequisite',
    requirementText(dsHelm, r) === 'Craft first: Iron Helm', requirementText(dsHelm, r));
  check('unlockMet agrees with isUnlocked',
    RECIPES.every((x) => unlockMet(x, r) === isUnlocked(r, x.key)));
}

// ---------------------------------------------------------------------------
// 7. Persistence
// ---------------------------------------------------------------------------

{
  check('the progress key is registered for saves',
    GAME_STATE_KEYS.includes(PROGRESS_KEY), PROGRESS_KEY);
  check('the loom key is registered for saves',
    GAME_STATE_KEYS.includes(LOOMS_KEY), LOOMS_KEY);
  check('the tent key is still registered', GAME_STATE_KEYS.includes(TENTS_KEY));

  const p = createProgress();
  noteItems(p, ['flax', 'wool', 'iron_ingot']);
  noteCraft(p, 'sticks');
  const round = deserializeProgress(serializeProgress(p));
  check('progress round-trips', round !== null
    && serializeProgress(round) === serializeProgress(p));

  check('a malformed record is rejected', deserializeProgress('{nope') === null);
  check('a non-object record is rejected', deserializeProgress('[1,2]') === null);
  check('an empty object is a virgin tree',
    serializeProgress(deserializeProgress('{}')!) === serializeProgress(createProgress()));
  const withJunk = deserializeProgress(
    '{"u":["no_such_recipe","sticks"],"c":["also_gone"],"s":["not_an_item","flax"]}');
  check('unknown recipe keys are dropped, not fatal',
    withJunk !== null && !withJunk.unlocked.has('no_such_recipe')
    && withJunk.unlocked.has('sticks'));
  check('unknown item ids are dropped, not fatal',
    withJunk !== null && withJunk.seen.has('flax') && withJunk.seen.size === 1);
  check('a load re-derives unlocks rather than trusting them',
    withJunk !== null && withJunk.unlocked.has('thread_flax'));
  check('serialized form is stable regardless of insertion order', (() => {
    const x = createProgress(); noteItems(x, ['wool', 'flax']);
    const y = createProgress(); noteItems(y, ['flax', 'wool']);
    return serializeProgress(x) === serializeProgress(y);
  })());
}

// ---------------------------------------------------------------------------
// 8. The gate is real — a locked recipe cannot be crafted
// ---------------------------------------------------------------------------

{
  const loomCtx: StationContext = {
    nearCampfire: false, nearForge: false, hasCookingPot: false, nearLoom: true,
  };
  const noLoomCtx: StationContext = {
    nearCampfire: true, nearForge: true, hasCookingPot: true, nearLoom: false,
  };
  const clothRecipe = recipeByKey('cloth_wool')!;

  const inv = createInventory();
  addItem(inv, 'wool_yarn', 9);
  const p = createProgress();
  const gate = unlockGate(p);

  check('materials + loom is not enough while undiscovered',
    !canCraft(inv, clothRecipe, loomCtx, gate));
  check('and craft() refuses too', !craft(inv, clothRecipe, loomCtx, gate));
  check('the refusal consumed nothing', countItem(inv, 'wool_yarn') === 9);

  noteCraft(p, 'loom_kit');
  check('discovering it makes it craftable', canCraft(inv, clothRecipe, loomCtx, gate));
  check('a forge is still not a loom', !canCraft(inv, clothRecipe, noLoomCtx, gate));
  check('an absent nearLoom reads as no loom',
    !canCraft(inv, clothRecipe,
      { nearCampfire: true, nearForge: true, hasCookingPot: true }, gate));
  check('the craft succeeds at a loom', craft(inv, clothRecipe, loomCtx, gate));
  check('and consumed its inputs', countItem(inv, 'wool_yarn') === 6);
  check('and produced two cloth', countItem(inv, 'cloth') === 2);

  // No gate at all = every recipe open, which is what unit fixtures rely on.
  const bare = createInventory();
  addItem(bare, 'wool_yarn', 3);
  check('with no progress record the model is ungated',
    canCraft(bare, clothRecipe, loomCtx));
}

// ---------------------------------------------------------------------------
// 9. The starting pack does not hand over the whole tree
// ---------------------------------------------------------------------------

{
  const fresh = createProgress();
  const startInv = createStarterInventory();
  observeInventory(fresh, startInv);
  const open = fresh.unlocked.size;
  // The generous starting pack is the hardest case for a discovery tree: it
  // hands over iron, leather, wool, flax, coal and a cooking pot on frame one.
  // It still opens well under a third of the tree, because most of the tree is
  // gated on things the pack does not contain — stone, ore, plant fibre, bone,
  // gourds — or on having actually made the rung below.
  check('the starting pack opens a real slice of the tree', open >= 10, `${open}`);
  check('but well under a third of it', open < RECIPES.length / 3,
    `${open}/${RECIPES.length}`);
  // These are the rungs the pack must NOT hand over, and they are the ones the
  // save-delete proof watches: nothing in the kit is cloth, a loom, or a piece
  // of dragonscale armour, so all of tier 3 and all of the summit stay shut.
  check('the loom tier stays shut on a fresh pack',
    RECIPES.filter((r) => r.tier === 3).every((r) => !isUnlocked(fresh, r.key)),
    RECIPES.filter((r) => r.tier === 3 && isUnlocked(fresh, r.key))
      .map((r) => r.key).join(', '));
  check('the loom kit itself is discovered (iron + rope are in the pack)',
    isUnlocked(fresh, 'loom_kit'));
  check('dragonscale stays shut until an iron piece is forged',
    RECIPES.filter((r) => r.tier === 4).every((r) => !isUnlocked(fresh, r.key)));
  check('nothing in the pack has been CRAFTED', fresh.crafted.size === 0);
}

// ---------------------------------------------------------------------------
// 10. The loom placeable
// ---------------------------------------------------------------------------

{
  resetLoomIds();
  const l = createLoom(10, 2, 20, 0.5);
  check('createLoom keeps its position', l.x === 10 && l.y === 2 && l.z === 20);
  check('createLoom keeps its yaw', l.yaw === 0.5);
  check('loom ids are non-empty', typeof l.id === 'string' && l.id.length > 0);

  // Determinism: the same placements in the same order give the same ids.
  resetLoomIds();
  const runA = [createLoom(1, 0, 2), createLoom(3, 0, 4)].map((x) => x.id);
  resetLoomIds();
  const runB = [createLoom(1, 0, 2), createLoom(3, 0, 4)].map((x) => x.id);
  check('loom ids replay identically', runA.join() === runB.join(), runA.join());
  check('two looms in different places get different ids', runA[0] !== runA[1]);
  check('no Date.now/Math.random in the id',
    !/\d{13}/.test(runA[0]), runA[0]);

  const looms = [createLoom(0, 0, 0)];
  check('nearLoom: at the loom', nearLoom(looms, 0, 0));
  check('nearLoom: just inside the radius', nearLoom(looms, CRAFT_LOOM_RADIUS - 0.1, 0));
  check('nearLoom: just outside', !nearLoom(looms, CRAFT_LOOM_RADIUS + 0.1, 0));
  check('nearLoom: empty registry', !nearLoom([], 0, 0));

  const round = deserializeLooms(serializeLooms(looms));
  check('looms round-trip', round !== null && round.length === 1 && round[0].id === looms[0].id);
  check('a loom record with no yaw is tolerated', (() => {
    const r = deserializeLooms('[{"id":"a","x":1,"y":2,"z":3}]');
    return r !== null && r.length === 1 && r[0].yaw === 0;
  })());
  check('a malformed loom record is rejected', deserializeLooms('{nope') === null);
  check('a loom missing a coordinate is rejected',
    deserializeLooms('[{"id":"a","x":1,"y":2}]') === null);

  // The mesh: batched by palette, 24 B stride, and it stands on the ground.
  const batches = buildLoomMeshes(looms);
  check('the loom builds at least three palette batches', batches.length >= 3,
    batches.map((b) => b.palette).join(','));
  const floats = batches.reduce((n, b) => n + b.verts.length, 0);
  check('every batch is a whole number of 6-float vertices',
    batches.every((b) => b.verts.length % 6 === 0));
  check('every batch is a whole number of triangles',
    batches.every((b) => (b.verts.length / 6) % 3 === 0));
  check('the loom mesh is not empty', floats > 0, `${floats} floats`);
  let minY = Infinity, maxY = -Infinity, maxR = 0;
  for (const b of batches) {
    for (let i = 0; i < b.verts.length; i += 6) {
      minY = Math.min(minY, b.verts[i + 1]);
      maxY = Math.max(maxY, b.verts[i + 1]);
      maxR = Math.max(maxR, Math.hypot(b.verts[i], b.verts[i + 2]));
    }
  }
  check('the loom sits on its ground plane', Math.abs(minY) < 1e-6, `${minY}`);
  check('the loom is roughly person-height', maxY > 1.5 && maxY < 2.2, `${maxY}`);
  check('the loom is a metre-ish across', maxR < 1.2, `${maxR}`);
}

// ---------------------------------------------------------------------------
// 11. Tent volumes — and the mesh agrees with the shelter test
// ---------------------------------------------------------------------------

{
  resetTentIds();
  const small = createTent(0, 10, 0, 3, 'small');
  const walkin = createTent(50, 10, 0, 3, 'walkin');
  const tents: PlacedTent[] = [small, walkin];

  check('a small tent keeps its shape', small.shape === 'small');
  check('a canvas tent keeps its shape', walkin.shape === 'walkin');
  check('the walk-in is genuinely bigger',
    TENT_BOX.walkin.hx > TENT_BOX.small.hx
    && TENT_BOX.walkin.hz > TENT_BOX.small.hz
    && TENT_BOX.walkin.h > TENT_BOX.small.h);
  check('the walk-in is tall enough to stand up in', TENT_BOX.walkin.h >= 2.2,
    `${TENT_BOX.walkin.h}`);

  check('standing in the small tent is roofed', tentRoofAt(tents, 0, 10, 0));
  check('standing in the canvas tent is roofed', tentRoofAt(tents, 50, 10, 0));
  check('the tent you are in is the one reported',
    tentAt(tents, 50, 10, 0)?.id === walkin.id);
  check('open ground between them is not roofed', tentRoofAt(tents, 25, 10, 0) === false);

  // Boundary pairs on each axis, for both shapes.
  for (const [name, t] of [['small', small], ['walkin', walkin]] as const) {
    const b = tentBox(t);
    check(`${name}: just inside the X wall`, tentRoofAt(tents, t.x + b.hx - 0.05, t.y, t.z));
    check(`${name}: just outside the X wall`, !tentRoofAt(tents, t.x + b.hx + 0.05, t.y, t.z));
    check(`${name}: just inside the Z wall`, tentRoofAt(tents, t.x, t.y, t.z + b.hz - 0.05));
    check(`${name}: just outside the Z wall`, !tentRoofAt(tents, t.x, t.y, t.z + b.hz + 0.05));
    check(`${name}: just under the ridge`, tentRoofAt(tents, t.x, t.y + b.h - 0.05, t.z));
    check(`${name}: above the ridge is sky`, !tentRoofAt(tents, t.x, t.y + b.h + 0.05, t.z));
    check(`${name}: a metre below still counts (slope slack)`,
      tentRoofAt(tents, t.x, t.y - 0.9, t.z));
    check(`${name}: two metres below does not`, !tentRoofAt(tents, t.x, t.y - 2, t.z));
  }

  // The load-bearing agreement: every vertex of the drawn canvas lies inside
  // the box the shelter test uses. If the mesh grew past its box, a player
  // would stand under visible canvas in the rain.
  for (const [name, t] of [['small', small], ['walkin', walkin]] as const) {
    const b = tentBox(t);
    const batches = buildTentMeshes([t]);
    let worstX = 0, worstZ = 0, worstY = 0;
    let n = 0;
    for (const batch of batches) {
      for (let i = 0; i < batch.verts.length; i += 6) {
        n++;
        worstX = Math.max(worstX, Math.abs(batch.verts[i] - t.x) - b.hx);
        worstY = Math.max(worstY, batch.verts[i + 1] - t.y - b.h);
        worstZ = Math.max(worstZ, Math.abs(batch.verts[i + 2] - t.z) - b.hz);
      }
    }
    check(`${name}: the mesh has vertices at all`, n > 0, `${n}`);
    check(`${name}: no canvas outside the shelter box in X`, worstX <= 1e-6, `${worstX}`);
    check(`${name}: no canvas above the shelter box`, worstY <= 1e-6, `${worstY}`);
    check(`${name}: no canvas outside the shelter box in Z`, worstZ <= 1e-6, `${worstZ}`);
  }
  // ...and that the box is not merely generous: the canvas must fill most of it,
  // or "inside the tent" would include a metre of open air beside it.
  {
    const b = tentBox(walkin);
    const batches = buildTentMeshes([walkin]);
    let spanX = 0, spanY = 0, spanZ = 0;
    for (const batch of batches) {
      for (let i = 0; i < batch.verts.length; i += 6) {
        spanX = Math.max(spanX, Math.abs(batch.verts[i] - walkin.x));
        spanY = Math.max(spanY, batch.verts[i + 1] - walkin.y);
        spanZ = Math.max(spanZ, Math.abs(batch.verts[i + 2] - walkin.z));
      }
    }
    check('walkin: the canvas fills its box in X', spanX >= b.hx - 0.02, `${spanX}/${b.hx}`);
    check('walkin: the canvas fills its box in Y', spanY >= b.h - 0.02, `${spanY}/${b.h}`);
    check('walkin: the canvas fills its box in Z', spanZ >= b.hz - 0.02, `${spanZ}/${b.hz}`);
  }

  // Legacy records — a tent stored before the field existed is a small tent.
  const legacy = deserializeTents('[{"id":"t","x":0,"y":0,"z":0,"tier":2}]');
  check('a shapeless stored tent loads', legacy !== null && legacy.length === 1);
  check('and is treated as a small one',
    legacy !== null && tentBox(legacy[0]).hx === TENT_BOX.small.hx);

  // Deterministic ids, same rule as looms.
  resetTentIds();
  const t1 = [createTent(1, 0, 2, 1), createTent(3, 0, 4, 1)].map((x) => x.id);
  resetTentIds();
  const t2 = [createTent(1, 0, 2, 1), createTent(3, 0, 4, 1)].map((x) => x.id);
  check('tent ids replay identically', t1.join() === t2.join(), t1.join());
  check('tent ids carry no wall clock', !/\d{13}/.test(t1[0]), t1[0]);
}

// ---------------------------------------------------------------------------
// 12. The tree covers the panel — every tier appears in some category
// ---------------------------------------------------------------------------

{
  const cats = ['tools', 'weapons', 'armor', 'food', 'camp'] as const;
  for (const c of cats) {
    check(`category '${c}' has recipes`, RECIPES.some((r) => r.category === c));
  }
  for (let tier = 0 as Tier; tier <= 4; tier = (tier + 1) as Tier) {
    check(`tier ${tier} (${TIER_NAMES[tier]}) has recipes`,
      RECIPES.some((r) => r.tier === tier));
  }
  // Every new item the loom tier introduced has an icon and a home.
  for (const id of ['cloth', 'loom_kit', 'canvas_tent',
    'quilted_hood', 'quilted_tunic', 'quilted_leggings'] as const) {
    check(`new item is registered: ${id}`, isGameItemId(id));
    check(`new item is craftable: ${id}`, RECIPES.some((r) => r.output === id));
  }
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
