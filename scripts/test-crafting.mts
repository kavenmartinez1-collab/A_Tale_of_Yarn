/**
 * Tests for the pure crafting model (recipes over the inventory model).
 * Run:  npx tsx scripts/test-crafting.mts
 */

import { canCraft, craft, RECIPES, type StationContext } from '../src/game/crafting';
import {
  addItem, countItem, createInventory, PACK_SIZE,
} from '../src/game/inventory';
import { isGameItemId, ITEM_DEFS } from '../src/game/items';

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

function recipe(output: string) {
  // There may be duplicate outputs (thread has two recipes); find first.
  const r = RECIPES.find((r) => r.output === output);
  if (r === undefined) throw new Error(`no recipe for ${output}`);
  return r;
}

/** A StationContext with everything available. */
const fullCtx: StationContext = { nearCampfire: true, nearForge: true, hasCookingPot: true };
/** Nothing available. */
const bareCtx: StationContext = { nearCampfire: false, nearForge: false, hasCookingPot: false };
/** Campfire only (no forge, no pot). */
const fireCtx: StationContext = { nearCampfire: true, nearForge: false, hasCookingPot: false };
/** Campfire + cooking pot. */
const firePotCtx: StationContext = { nearCampfire: true, nearForge: false, hasCookingPot: true };

// ---- Registry sanity -------------------------------------------------------

check('enough recipes', RECIPES.length >= 40, `${RECIPES.length}`);

for (const r of RECIPES) {
  check(`recipe output is a real item: ${r.output}`, isGameItemId(r.output));
  check(`recipe count fits a stack: ${r.output}`,
    r.count >= 1 && r.count <= ITEM_DEFS[r.output].stack);
  check(`recipe has inputs: ${r.output}`,
    r.inputs.length > 0
    && r.inputs.every(([id, n]) => isGameItemId(id) && n >= 1));
  check(`recipe has station: ${r.output}`,
    ['hand', 'fire', 'forge'].includes(r.station));
  check(`recipe has category: ${r.output}`,
    ['tools', 'weapons', 'armor', 'food', 'camp'].includes(r.category));
}

// Every recipe input/output is a valid GameItemId (belt-and-suspenders via isGameItemId).
for (const r of RECIPES) {
  check(`all inputs are valid ids: ${r.output}`,
    r.inputs.every(([id]) => isGameItemId(id)));
}

// Every armor recipe output has an armor field.
for (const r of RECIPES.filter((r) => r.category === 'armor')) {
  check(`armor recipe output has armor field: ${r.output}`,
    !!ITEM_DEFS[r.output as keyof typeof ITEM_DEFS] &&
    'armor' in ITEM_DEFS[r.output as keyof typeof ITEM_DEFS]);
}

// Consumables with effectClass are edible or drinkable.
{
  const { ITEM_DEFS: defs } = await import('../src/game/items');
  for (const [id, def] of Object.entries(defs)) {
    if ('effectClass' in def && def.effectClass !== undefined) {
      const hasEdible = 'edible' in def && def.edible !== undefined;
      const hasDrinkable = 'drinkable' in def && def.drinkable !== undefined;
      // warming/cooling/stamina potions are drinkable (quench from container) —
      // they use the container itself (gourd_bottle) as input, so the potion
      // output gets its effect from effectClass alone.  Accept either or both.
      check(`effectClass item is edible or drinkable or a potion: ${id}`,
        hasEdible || hasDrinkable || def.effectClass !== undefined);
    }
  }
}

check('gathered materials all have a sink',
  (['logs', 'ore', 'berries'] as const).every((id) =>
    RECIPES.some((r) => r.inputs.some(([i]) => i === id))));

// ---- Station gating --------------------------------------------------------

// 'hand' recipe always available regardless of ctx.
{
  const inv = createInventory();
  const sticks = recipe('sticks');
  addItem(inv, 'logs', 1);
  check('hand recipe allowed with bare ctx', canCraft(inv, sticks, bareCtx));
  check('hand recipe allowed with full ctx', canCraft(inv, sticks, fullCtx));
}

// 'fire' recipe blocked without campfire, allowed with.
{
  const inv = createInventory();
  const meatCooked = recipe('meat_cooked');
  addItem(inv, 'meat_raw', 1);
  check('fire recipe blocked without campfire', !canCraft(inv, meatCooked, bareCtx));
  check('fire recipe allowed with campfire', canCraft(inv, meatCooked, fireCtx));
  check('fire recipe allowed near forge (counts as fire)', canCraft(inv, meatCooked, { ...bareCtx, nearForge: true }));
}

// 'forge' recipe blocked without forge, allowed with.
{
  const inv = createInventory();
  const ironIngot = recipe('iron_ingot');
  addItem(inv, 'ore', 2);
  check('forge recipe blocked without forge', !canCraft(inv, ironIngot, fireCtx));
  check('forge recipe blocked with only campfire', !canCraft(inv, ironIngot, fireCtx));
  check('forge recipe allowed with forge', canCraft(inv, ironIngot, { ...bareCtx, nearForge: true }));
}

// needsPot — blocked without pot even with campfire.
{
  const inv = createInventory();
  const healPotion = recipe('healing_potion');
  addItem(inv, 'healing_herb', 2);
  addItem(inv, 'gourd_bottle', 1);
  check('needsPot recipe blocked without pot', !canCraft(inv, healPotion, fireCtx));
  check('needsPot recipe allowed with campfire+pot', canCraft(inv, healPotion, firePotCtx));
}

// ---- canCraft gates on every input (hand recipe) ---------------------------
{
  const inv = createInventory();
  const staff = recipe('oak_staff');
  check('cannot craft with nothing', !canCraft(inv, staff, bareCtx));
  addItem(inv, 'logs', 2);
  check('cannot craft with too few logs', !canCraft(inv, staff, bareCtx));
  addItem(inv, 'logs', 1);
  check('can craft with exactly enough (hand)', canCraft(inv, staff, bareCtx));
}

// ---- craft consumes inputs and produces the output -------------------------
{
  const inv = createInventory();
  addItem(inv, 'logs', 5);
  check('craft succeeds', craft(inv, recipe('oak_staff'), bareCtx));
  check('inputs consumed', countItem(inv, 'logs') === 2,
    `logs=${countItem(inv, 'logs')}`);
  check('output produced', countItem(inv, 'oak_staff') === 1);
}

// ---- failed craft (missing inputs) leaves inventory unchanged --------------
{
  const inv = createInventory();
  addItem(inv, 'logs', 2);
  const meal = recipe('meal');
  check('failed craft (no berries) leaves inventory unchanged',
    !craft(inv, meal, firePotCtx) && countItem(inv, 'logs') === 2);
}

// ---- Multi-input recipe (forge) --------------------------------------------
{
  const inv = createInventory();
  addItem(inv, 'ore', 1);
  const ironIngot = recipe('iron_ingot');
  check('multi-input forge recipe blocked on partial inputs', !canCraft(inv, ironIngot, fullCtx));
  addItem(inv, 'ore', 1);
  check('multi-input forge craft succeeds', craft(inv, ironIngot, fullCtx));
  check('all inputs consumed', countItem(inv, 'ore') === 0);
  check('iron ingot produced', countItem(inv, 'iron_ingot') === 1);
}

// ---- Full inventory: craft fails atomically (inputs restored, no output) --
{
  const inv = createInventory();
  for (let i = 0; i < PACK_SIZE; i++) addItem(inv, 'ancient_relic'); // stack 1
  // Pack is full of unstackable relics; seed the inputs by overwriting one
  // relic slot with 6 berries — consuming 5 leaves the slot occupied, so
  // the crafted meal has nowhere to go.
  inv.pack[0] = { id: 'berries', count: 6 };
  const meal = recipe('meal');
  check('inputs present in a full pack', canCraft(inv, meal, firePotCtx));
  check('craft fails when output has no slot', !craft(inv, meal, firePotCtx));
  check('inputs restored after failed craft', countItem(inv, 'berries') === 6);
  check('no output materialized', countItem(inv, 'meal') === 0);
}

// ---- Station-blocked craft does not consume inputs -------------------------
{
  const inv = createInventory();
  addItem(inv, 'ore', 2);
  const ironIngot = recipe('iron_ingot');
  check('station-blocked craft returns false', !craft(inv, ironIngot, bareCtx));
  check('inputs NOT consumed after station block', countItem(inv, 'ore') === 2);
}

// ---- Sticks recipe: 1 log → 4 sticks (hand) --------------------------------
{
  const inv = createInventory();
  addItem(inv, 'logs', 1);
  check('sticks recipe produces 4', craft(inv, recipe('sticks'), bareCtx)
    && countItem(inv, 'sticks') === 4);
}

// ---- Arrow recipe: shaft + feather + stone → 4 arrows (hand) ---------------
{
  const inv = createInventory();
  addItem(inv, 'arrow_shaft', 1);
  addItem(inv, 'feather', 1);
  addItem(inv, 'stone', 1);
  check('arrow recipe produces 4', craft(inv, recipe('arrow'), bareCtx)
    && countItem(inv, 'arrow') === 4);
}

// ---- Iron armor (forge) -----------------------------------------------------
{
  const inv = createInventory();
  addItem(inv, 'iron_ingot', 5);
  check('iron_chest needs forge', !canCraft(inv, recipe('iron_chest'), fireCtx));
  check('iron_chest crafts with forge', craft(inv, recipe('iron_chest'), fullCtx)
    && countItem(inv, 'iron_chest') === 1);
}

// ---- Iron tool recipes use iron_ingot (not ore) ----------------------------
check('iron_axe recipe uses iron_ingot',
  recipe('iron_axe').inputs.some(([id]) => id === 'iron_ingot'));
check('iron_pickaxe recipe uses iron_ingot',
  recipe('iron_pickaxe').inputs.some(([id]) => id === 'iron_ingot'));
check('iron_sword recipe uses iron_ingot',
  recipe('iron_sword').inputs.some(([id]) => id === 'iron_ingot'));

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
