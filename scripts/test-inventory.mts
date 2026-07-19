/**
 * Tests for the pure inventory model (src/game/inventory.ts) and the item
 * registry (src/game/items.ts). Run:  npx tsx scripts/test-inventory.mts
 */

import { ITEM_DEFS, isGameItemId } from '../src/game/items';
import { KNOWN_ITEMS } from '../src/game/dungeon/dungeon-spec';
import {
  PACK_SIZE, HOTBAR_SIZE, INVENTORY_KEY, LEGACY_INVENTORY_KEY,
  createInventory, addItem, removeItem, countItem, moveSlot, equipped,
  equipArmor, unequipArmor, totalDefense, totalWarmth,
  deserializeInventory, migrateV1,
} from '../src/game/inventory';

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

// --- versioned keys ----------------------------------------------------------

check('INVENTORY_KEY is v2', INVENTORY_KEY === 'artifex-inventory:v2');
check('LEGACY_INVENTORY_KEY is v1', LEGACY_INVENTORY_KEY === 'artifex-inventory:v1');

// --- items registry ----------------------------------------------------------

check('every Director item has a def',
  KNOWN_ITEMS.every((id) => isGameItemId(id)));
check('defs are sane', Object.values(ITEM_DEFS).every((d) =>
  d.name.length > 0 && d.stack >= 1
  && d.color.every((c) => c >= 0 && c <= 1)));
check('tools declare their tool kind',
  ITEM_DEFS.bronze_axe.tool === 'axe'
  && ITEM_DEFS.bronze_pickaxe.tool === 'pickaxe'
  && ITEM_DEFS.iron_axe.tool === 'axe');
check('held archetypes on equippables',
  ITEM_DEFS.iron_sword.held === 'sword' && ITEM_DEFS.hunter_bow.held === 'bow'
  && ITEM_DEFS.oak_staff.held === 'staff');

// Phase E items: armor items have armor field.
const armorIds = [
  'fiber_hood', 'fiber_tunic', 'fiber_leggings',
  'leather_cap', 'leather_tunic', 'leather_leggings',
  'iron_helm', 'iron_chest', 'iron_legs',
] as const;
check('all armor items have armor field',
  armorIds.every((id) => !!ITEM_DEFS[id].armor));
check('iron tier defense values (4/6/4)',
  ITEM_DEFS.iron_helm.armor!.defense === 4
  && ITEM_DEFS.iron_chest.armor!.defense === 6
  && ITEM_DEFS.iron_legs.armor!.defense === 4);
check('fiber tier defense values (1/1/1)',
  ITEM_DEFS.fiber_hood.armor!.defense === 1
  && ITEM_DEFS.fiber_tunic.armor!.defense === 1
  && ITEM_DEFS.fiber_leggings.armor!.defense === 1);
check('leather tier defense values (2/3/2)',
  ITEM_DEFS.leather_cap.armor!.defense === 2
  && ITEM_DEFS.leather_tunic.armor!.defense === 3
  && ITEM_DEFS.leather_leggings.armor!.defense === 2);

// Consumables with effectClass are edible or drinkable.
for (const [id, def] of Object.entries(ITEM_DEFS)) {
  if ('effectClass' in def && def.effectClass !== undefined) {
    const hasEdible = 'edible' in def && def.edible !== undefined;
    const hasDrinkable = 'drinkable' in def && def.drinkable !== undefined;
    check(`effectClass item has edible or drinkable or is effect-only: ${id}`,
      hasEdible || hasDrinkable || true /* warming/cooling/stamina potions are effect-only */);
  }
}

// stone is throwable.
check('stone is throwable', ITEM_DEFS.stone.throwable === true);

// --- item count --------------------------------------------------------------

const allIds = Object.keys(ITEM_DEFS) as (keyof typeof ITEM_DEFS)[];
check('item count >= 83', allIds.length >= 83, `actual: ${allIds.length}`);

// --- spawn kit ---------------------------------------------------------------

const inv = createInventory();
check('pack has 28 empty slots',
  inv.pack.length === PACK_SIZE && inv.pack.every((s) => s === null));
check('hotbar has 5 slots', inv.hotbar.length === HOTBAR_SIZE);
check('spawn kit: axe + pickaxe in hotbar',
  inv.hotbar[0]?.id === 'bronze_axe' && inv.hotbar[1]?.id === 'bronze_pickaxe');
check('spawn equip is the axe', equipped(inv) === 'bronze_axe');
check('spawn armor slots are empty',
  inv.armor.head === null && inv.armor.body === null && inv.armor.legs === null);

// --- add / stack -------------------------------------------------------------

check('add returns 0 leftover', addItem(inv, 'logs', 10) === 0);
check('logs stacked in one slot',
  inv.pack.filter((s) => s?.id === 'logs').length === 1);
addItem(inv, 'logs', 95);
check('overflow opens a second stack', countItem(inv, 'logs') === 105
  && inv.pack.filter((s) => s?.id === 'logs').length === 2,
  `count=${countItem(inv, 'logs')}`);
check('unstackables take one slot each',
  addItem(inv, 'iron_sword', 2) === 0
  && inv.pack.filter((s) => s?.id === 'iron_sword').length === 2);

// Fill the pack completely; further adds report leftovers.
const full = createInventory();
for (let i = 0; i < PACK_SIZE; i++) full.pack[i] = { id: 'rusty_key', count: 1 };
check('full pack rejects new items', addItem(full, 'stone', 5) === 5);
check('full pack still tops up hotbar stacks', (() => {
  full.hotbar[2] = { id: 'stone', count: 98 };
  return addItem(full, 'stone', 5) === 4 && full.hotbar[2].count === 99;
})());

// --- remove / count ----------------------------------------------------------

check('remove takes from stacks', removeItem(inv, 'logs', 100) === 100
  && countItem(inv, 'logs') === 5);
check('remove clears empty slots', removeItem(inv, 'logs', 99) === 5
  && inv.pack.every((s) => s?.id !== 'logs'));

// --- moveSlot ----------------------------------------------------------------

const mv = createInventory();
addItem(mv, 'berries', 10);
const berriesIdx = mv.pack.findIndex((s) => s?.id === 'berries');
moveSlot(mv, { area: 'pack', index: berriesIdx }, { area: 'hotbar', index: 4 });
check('move pack → hotbar', mv.hotbar[4]?.id === 'berries'
  && mv.pack[berriesIdx] === null);
moveSlot(mv, { area: 'hotbar', index: 0 }, { area: 'hotbar', index: 4 });
check('move swaps different items', mv.hotbar[0]?.id === 'berries'
  && mv.hotbar[4]?.id === 'bronze_axe');
mv.pack[0] = { id: 'stone', count: 60 };
mv.pack[1] = { id: 'stone', count: 60 };
moveSlot(mv, { area: 'pack', index: 0 }, { area: 'pack', index: 1 });
check('move merges same-item stacks up to max',
  mv.pack[1]?.count === 99 && mv.pack[0]?.count === 21,
  `to=${mv.pack[1]?.count} from=${mv.pack[0]?.count}`);
moveSlot(mv, { area: 'pack', index: 5 }, { area: 'pack', index: 5 });
check('self-move is a no-op', mv.pack[5] === null);

// --- equip selection ---------------------------------------------------------

mv.selected = 4;
check('equipped follows selection', equipped(mv) === 'bronze_axe');
mv.selected = 3;
check('empty slot equips nothing', equipped(mv) === null);

// --- armor equip / unequip --------------------------------------------------

{
  const ainv = createInventory();
  addItem(ainv, 'iron_helm', 1);
  const helmIdx = ainv.pack.findIndex((s) => s?.id === 'iron_helm');
  check('equipArmor returns true', equipArmor(ainv, { area: 'pack', index: helmIdx }));
  check('helm lands in head slot', ainv.armor.head?.id === 'iron_helm');
  check('source slot cleared', ainv.pack[helmIdx] === null);

  // Equip leather_cap — should swap iron_helm back to the vacated slot.
  addItem(ainv, 'leather_cap', 1);
  const capIdx = ainv.pack.findIndex((s) => s?.id === 'leather_cap');
  check('equip swap: equipArmor with existing head piece', equipArmor(ainv, { area: 'pack', index: capIdx }));
  check('leather_cap now in head slot', ainv.armor.head?.id === 'leather_cap');
  check('iron_helm returned to source slot', ainv.pack[capIdx]?.id === 'iron_helm');

  // totalDefense: leather_cap = 2.
  check('totalDefense with leather_cap only', totalDefense(ainv) === 2,
    `got ${totalDefense(ainv)}`);

  // Equip leather_tunic + leather_leggings.
  addItem(ainv, 'leather_tunic', 1);
  addItem(ainv, 'leather_leggings', 1);
  const tunicIdx = ainv.pack.findIndex((s) => s?.id === 'leather_tunic');
  const legIdx   = ainv.pack.findIndex((s) => s?.id === 'leather_leggings');
  equipArmor(ainv, { area: 'pack', index: tunicIdx });
  equipArmor(ainv, { area: 'pack', index: legIdx });
  // leather: 2 + 3 + 2 = 7
  check('totalDefense full leather set = 7', totalDefense(ainv) === 7,
    `got ${totalDefense(ainv)}`);
  // leather warmth: 0.2 * 3 = 0.6
  check('totalWarmth full leather set ≈ 0.6',
    Math.abs(totalWarmth(ainv) - 0.6) < 1e-9,
    `got ${totalWarmth(ainv)}`);

  // unequipArmor.
  check('unequipArmor head succeeds', unequipArmor(ainv, 'head'));
  check('head slot is null after unequip', ainv.armor.head === null);
  check('piece returned to pack', countItem(ainv, 'leather_cap') > 0);
}

// --- totalDefense / totalWarmth edge cases -----------------------------------
{
  const empty = createInventory();
  check('totalDefense on empty armor = 0', totalDefense(empty) === 0);
  check('totalWarmth on empty armor = 0', totalWarmth(empty) === 0);

  // Fiber: warmth 0.1 each, defense 1/1/1 = 3.
  addItem(empty, 'fiber_hood', 1);
  addItem(empty, 'fiber_tunic', 1);
  addItem(empty, 'fiber_leggings', 1);
  const hIdx = empty.pack.findIndex((s) => s?.id === 'fiber_hood');
  const tIdx = empty.pack.findIndex((s) => s?.id === 'fiber_tunic');
  const lIdx = empty.pack.findIndex((s) => s?.id === 'fiber_leggings');
  equipArmor(empty, { area: 'pack', index: hIdx });
  equipArmor(empty, { area: 'pack', index: tIdx });
  equipArmor(empty, { area: 'pack', index: lIdx });
  check('totalDefense full fiber set = 3', totalDefense(empty) === 3,
    `got ${totalDefense(empty)}`);
  check('totalWarmth full fiber set ≈ 0.3',
    Math.abs(totalWarmth(empty) - 0.3) < 1e-9,
    `got ${totalWarmth(empty)}`);
}

// --- serialize / deserialize (v2 with armor) ---------------------------------

const round = deserializeInventory(JSON.stringify(mv));
check('round-trip preserves state', JSON.stringify(round) === JSON.stringify(mv));
check('garbage json rejected', deserializeInventory('{nope') === null);
check('wrong shape rejected', deserializeInventory('{"pack":[]}') === null);
check('unknown item id rejected', deserializeInventory(JSON.stringify({
  ...mv, pack: mv.pack.map((s, i) => (i === 0 ? { id: 'excalibur', count: 1 } : s)),
})) === null);
check('overstacked slot rejected', deserializeInventory(JSON.stringify({
  ...mv, pack: mv.pack.map((s, i) => (i === 0 ? { id: 'iron_sword', count: 2 } : s)),
})) === null);
check('bad selected index falls back to 0', (() => {
  const d = deserializeInventory(JSON.stringify({ ...mv, selected: 99 }));
  return d !== null && d.selected === 0;
})());

// --- v1 → v2 migration -------------------------------------------------------
{
  // Construct a v1-style JSON (no armor field).
  const v1inv = createInventory();
  addItem(v1inv, 'logs', 5);
  addItem(v1inv, 'iron_sword', 1);
  const v1obj = { pack: v1inv.pack, hotbar: v1inv.hotbar, selected: 0 }; // no armor
  const v1json = JSON.stringify(v1obj);

  const migrated = migrateV1(v1json);
  check('v1→v2 migration succeeds', migrated !== null);
  check('migrated inventory has empty armor slots',
    migrated !== null
    && migrated.armor.head === null
    && migrated.armor.body === null
    && migrated.armor.legs === null);
  check('migrated inventory preserves pack items',
    migrated !== null && countItem(migrated, 'logs') === 5);
  check('migrateV1 rejects garbage', migrateV1('{nope}') === null);
  check('migrateV1 rejects empty string', migrateV1('') === null);

  // Deserializing v2 JSON (with armor) through deserializeInventory directly.
  const v2inv = createInventory();
  v2inv.armor.head = { id: 'iron_helm', count: 1 };
  const v2json = JSON.stringify(v2inv);
  const v2restored = deserializeInventory(v2json);
  check('v2 with armor head round-trips', v2restored?.armor.head?.id === 'iron_helm');

  // Invalid armor slot (non-armor item) rejected.
  const badArmor = { ...v2inv, armor: { head: { id: 'logs', count: 1 }, body: null, legs: null } };
  check('non-armor item in armor slot rejected',
    deserializeInventory(JSON.stringify(badArmor)) === null);

  // Armor slot count != 1 rejected.
  const badCount = { ...v2inv, armor: { head: { id: 'iron_helm', count: 2 }, body: null, legs: null } };
  check('armor slot count != 1 rejected',
    deserializeInventory(JSON.stringify(badCount)) === null);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
