/**
 * Inventory model — pure, UI-free. 28 pack slots + 5 hotbar slots (keys 1–5)
 * + 3 armor slots (head/body/legs), RuneScape-style. Stack-first add, slot
 * moves (click-to-swap), equip = the selected hotbar slot. Persisted to
 * localStorage under a versioned key; deserialize validates every field so
 * corrupt saves fall back to a fresh starter-kit inventory (full toolset,
 * iron armor, consumables, gold + tradable stock — createStarterInventory).
 *
 * v2 changes (Phase E):
 * - Adds `armor: { head, body, legs }` equip slots.
 * - `equipArmor` / `unequipArmor` move pieces between pack/hotbar and slots.
 * - `totalDefense` / `totalWarmth` aggregate equipped armor stats.
 * - v1→v2 migration: reads old key, injects empty armor object.
 */

import { ITEM_DEFS, isGameItemId, itemDef, type GameItemId } from './items';

export const PACK_SIZE   = 28;
export const HOTBAR_SIZE = 5;

/** Current persistence key. */
export const INVENTORY_KEY = 'artifex-inventory:v2';
/** Legacy key used before Phase E — read for migration. */
export const LEGACY_INVENTORY_KEY = 'artifex-inventory:v1';

export type Slot = { id: GameItemId; count: number } | null;
export type SlotArea = 'pack' | 'hotbar';
export interface SlotRef {
  area: SlotArea;
  index: number;
}

export interface ArmorSlots {
  head: Slot;
  body: Slot;
  legs: Slot;
}

export interface Inventory {
  pack: Slot[];
  hotbar: Slot[];
  /** Selected hotbar index 0..4. */
  selected: number;
  /** Equipped armor pieces (count is always 1 when occupied). */
  armor: ArmorSlots;
}

/** Fresh inventory with the spawn kit in hotbar slots 1–3. */
export function createInventory(): Inventory {
  const pack: Slot[] = new Array(PACK_SIZE).fill(null);
  const hotbar: Slot[] = new Array(HOTBAR_SIZE).fill(null);
  hotbar[0] = { id: 'bronze_axe', count: 1 };
  hotbar[1] = { id: 'bronze_pickaxe', count: 1 };
  hotbar[2] = { id: 'fire_starter', count: 1 };
  return { pack, hotbar, selected: 0, armor: { head: null, body: null, legs: null } };
}

/**
 * Rich new-game kit: full iron toolset + bow, iron armor equipped,
 * consumables, camp gear, and a deep stock of gold and tradable goods.
 * Used for fresh spawns (new game / first boot); createInventory() stays
 * minimal so unit tests keep a near-empty baseline.
 */
export function createStarterInventory(): Inventory {
  const inv = createInventory();
  inv.hotbar[0] = { id: 'iron_sword',    count: 1 };
  inv.hotbar[1] = { id: 'iron_axe',      count: 1 };
  inv.hotbar[2] = { id: 'iron_pickaxe',  count: 1 };
  inv.hotbar[3] = { id: 'composite_bow', count: 1 };
  inv.hotbar[4] = { id: 'torch',         count: 20 };
  inv.armor = {
    head: { id: 'iron_helm',  count: 1 },
    body: { id: 'iron_chest', count: 1 },
    legs: { id: 'iron_legs',  count: 1 },
  };
  const kit: { id: GameItemId; count: number }[] = [
    // Currency — enough to buy out any trader.
    { id: 'gold_small',     count: 99 },
    { id: 'gold_small',     count: 99 },
    // Combat / survival.
    // Two quivers, and the ratio is the design. `flint_arrow` is the bow's
    // ammunition — craftable, cheap, and there is enough of it here to hunt
    // and skirmish without thinking about it. Tintreach is rare boss loot, and
    // a dozen is enough to learn what the weapon does and to win a fight you
    // had no business winning; it is not enough to make it your default. It
    // does not come back — see tintreach.ts.
    { id: 'flint_arrow',    count: 48 },
    { id: 'arrow',          count: 12 },
    { id: 'healing_potion', count: 20 },
    { id: 'stamina_potion', count: 20 },
    { id: 'warming_potion', count: 10 },
    { id: 'cooling_potion', count: 10 },
    { id: 'meat_cooked',    count: 20 },
    { id: 'berries',        count: 99 },
    { id: 'healing_herb',   count: 20 },
    { id: 'waterskin_full', count: 1 },
    // Camp gear.
    { id: 'fire_starter',   count: 20 },
    { id: 'campfire_kit',   count: 5 },
    { id: 'logs',           count: 99 },
    { id: 'sticks',         count: 99 },
    { id: 'rope',           count: 20 },
    { id: 'hide_tent',      count: 1 },
    { id: 'cooking_pot',    count: 1 },
    // Tradable stock (everything sellable at good prices, incl. top-value
    // dragon scales) plus crafting metals.
    { id: 'dragon_scale',   count: 20 },
    { id: 'iron_ingot',     count: 99 },
    // No bronze ingots. The pack is 28 slots and this kit had filled all but
    // one of them, so adding the flint quiver above took the last spare — and
    // a pack with no free slot is a dead end, because crafting needs somewhere
    // to put its output (see `dropSlot`). Bronze was the entry worth losing:
    // the player starts in full iron armour with iron tools, so its only use
    // is forging a tier they have already outgrown, and 99 iron ingots and 99
    // coal are still here for anything that matters.
    { id: 'leather',        count: 99 },
    { id: 'hide',           count: 99 },
    { id: 'coal',           count: 99 },
    { id: 'flax',           count: 50 },
    { id: 'wool',           count: 50 },
  ];
  // Direct slot fill (one stack per slot; addItem would merge gold stacks).
  for (let i = 0; i < kit.length && i < PACK_SIZE; i++) {
    inv.pack[i] = { id: kit[i].id, count: kit[i].count };
  }
  return inv;
}

function slots(inv: Inventory, area: SlotArea): Slot[] {
  return area === 'pack' ? inv.pack : inv.hotbar;
}

/**
 * Add `count` of an item: tops up existing stacks first (pack then hotbar),
 * then fills empty pack slots. Returns the leftover that did not fit.
 *
 * Tintreach arrows used to be special-cased here, and are no longer. There was
 * a chokepoint that collapsed every grant of them into a single slot, because
 * the design was one unique quiver per save. They are now rare, finite,
 * consumable boss loot, so they have to be able to accumulate across stacks
 * like anything else — see the header of tintreach.ts.
 */
export function addItem(inv: Inventory, id: GameItemId, count = 1): number {
  const max = itemDef(id).stack;
  let left = count;
  for (const area of ['pack', 'hotbar'] as const) {
    const arr = slots(inv, area);
    for (let i = 0; i < arr.length && left > 0; i++) {
      const s = arr[i];
      if (s !== null && s.id === id && s.count < max) {
        const take = Math.min(max - s.count, left);
        s.count += take;
        left -= take;
      }
    }
  }
  for (let i = 0; i < inv.pack.length && left > 0; i++) {
    if (inv.pack[i] === null) {
      const take = Math.min(max, left);
      inv.pack[i] = { id, count: take };
      left -= take;
    }
  }
  return left;
}

/** Remove up to `count` of an item (hotbar last). Returns how many were removed. */
export function removeItem(inv: Inventory, id: GameItemId, count = 1): number {
  let need = count;
  for (const area of ['pack', 'hotbar'] as const) {
    const arr = slots(inv, area);
    for (let i = 0; i < arr.length && need > 0; i++) {
      const s = arr[i];
      if (s !== null && s.id === id) {
        const take = Math.min(s.count, need);
        s.count -= take;
        need -= take;
        if (s.count === 0) arr[i] = null;
      }
    }
  }
  return count - need;
}

/**
 * Discard items from one pack/hotbar slot. Returns what was dropped, or null
 * if the slot was already empty.
 *
 * `whole` drops the entire stack; otherwise a single item goes. Items are
 * destroyed rather than left on the ground — there is no world-item entity in
 * this game, and adding one to solve "my pack is full" would be a much larger
 * feature than the problem calls for.
 *
 * This exists because a full pack is a dead end: crafting needs somewhere to
 * put its output, so once all 28 pack slots and 5 hotbar slots are occupied
 * the player cannot craft, and without a discard there is no way back out.
 */
export function dropSlot(
  inv: Inventory,
  ref: SlotRef,
  whole = false,
): { id: GameItemId; count: number } | null {
  const arr = slots(inv, ref.area);
  if (ref.index < 0 || ref.index >= arr.length) return null;
  const s = arr[ref.index];
  if (s === null) return null;

  const n = whole ? s.count : 1;
  const id = s.id;
  s.count -= n;
  if (s.count <= 0) arr[ref.index] = null;
  return { id, count: n };
}

/** True when there is nowhere left to put a new item — the crafting dead end. */
export function isFull(inv: Inventory): boolean {
  return inv.pack.every(s => s !== null) && inv.hotbar.every(s => s !== null);
}

/** Total count of an item across pack + hotbar. */
export function countItem(inv: Inventory, id: GameItemId): number {
  let n = 0;
  for (const s of inv.pack)   if (s !== null && s.id === id) n += s.count;
  for (const s of inv.hotbar) if (s !== null && s.id === id) n += s.count;
  return n;
}

/** Swap (or merge same-item stacks) between two slots. */
export function moveSlot(inv: Inventory, from: SlotRef, to: SlotRef): void {
  const fa = slots(inv, from.area);
  const ta = slots(inv, to.area);
  const a = fa[from.index];
  const b = ta[to.index];
  if (from.area === to.area && from.index === to.index) return;
  if (a !== null && b !== null && a.id === b.id) {
    const max = itemDef(a.id).stack;
    const take = Math.min(max - b.count, a.count);
    b.count += take;
    a.count -= take;
    if (a.count === 0) fa[from.index] = null;
    return;
  }
  fa[from.index] = b;
  ta[to.index] = a;
}

/** The item in the selected hotbar slot, or null. */
export function equipped(inv: Inventory): GameItemId | null {
  return inv.hotbar[inv.selected]?.id ?? null;
}

// --- armor equip / unequip --------------------------------------------------

/**
 * Move an armor-kind item from pack/hotbar into its slot. If a piece is
 * already in that slot, it is swapped back into the source slot. Returns
 * false if the source ref is empty, the item is not armor-kind, or the swap
 * target slot is occupied and there is nowhere to put the displaced piece.
 */
export function equipArmor(inv: Inventory, ref: SlotRef): boolean {
  const arr = slots(inv, ref.area);
  const src = arr[ref.index];
  if (src === null) return false;
  const def = itemDef(src.id);
  if (!def.armor) return false;

  const slotKey = def.armor.slot as 'head' | 'body' | 'legs';
  const current = inv.armor[slotKey];

  // Put the current piece back into the source slot.
  arr[ref.index] = current; // may be null
  inv.armor[slotKey] = { id: src.id, count: 1 };
  return true;
}

/**
 * Move the piece in the given armor slot back into the pack (first empty slot).
 * Returns false when the slot is already empty or there is no room in the pack.
 */
export function unequipArmor(inv: Inventory, slotKey: 'head' | 'body' | 'legs'): boolean {
  const piece = inv.armor[slotKey];
  if (piece === null) return false;
  const leftover = addItem(inv, piece.id, 1);
  if (leftover > 0) return false; // no room
  inv.armor[slotKey] = null;
  return true;
}

/** Sum of defense values of all equipped armor pieces. */
export function totalDefense(inv: Inventory): number {
  let d = 0;
  for (const key of ['head', 'body', 'legs'] as const) {
    const s = inv.armor[key];
    if (s !== null) d += itemDef(s.id).armor?.defense ?? 0;
  }
  return d;
}

/**
 * Sum of warmth values of all equipped armor pieces.
 * (Held-torch warmth and biome/fire contributions are handled separately
 * in Phase G vitals — this covers armor-slot warmth only.)
 */
export function totalWarmth(inv: Inventory): number {
  let w = 0;
  for (const key of ['head', 'body', 'legs'] as const) {
    const s = inv.armor[key];
    if (s !== null) w += itemDef(s.id).warmth ?? 0;
  }
  return w;
}

// --- persistence ------------------------------------------------------------

function validSlot(x: unknown): Slot | undefined {
  if (x === null) return null;
  if (typeof x !== 'object') return undefined;
  const s = x as { id?: unknown; count?: unknown };
  if (typeof s.id !== 'string' || !isGameItemId(s.id)) return undefined;
  if (typeof s.count !== 'number' || !Number.isInteger(s.count)
      || s.count < 1 || s.count > itemDef(s.id).stack) return undefined;
  return { id: s.id, count: s.count };
}

function validArmorSlot(x: unknown): Slot | undefined {
  if (x === null) return null;
  if (typeof x !== 'object') return undefined;
  const s = x as { id?: unknown; count?: unknown };
  if (typeof s.id !== 'string' || !isGameItemId(s.id)) return undefined;
  if (!itemDef(s.id).armor) return undefined; // must be armor kind
  if (typeof s.count !== 'number' || s.count !== 1) return undefined;
  return { id: s.id, count: 1 };
}

export function deserializeInventory(json: string): Inventory | null {
  let x: unknown;
  try {
    x = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof x !== 'object' || x === null) return null;
  const o = x as { pack?: unknown; hotbar?: unknown; selected?: unknown; armor?: unknown };
  if (!Array.isArray(o.pack)   || o.pack.length !== PACK_SIZE)   return null;
  if (!Array.isArray(o.hotbar) || o.hotbar.length !== HOTBAR_SIZE) return null;
  const pack: Slot[] = [];
  for (const s of o.pack) {
    const v = validSlot(s);
    if (v === undefined) return null;
    pack.push(v);
  }
  const hotbar: Slot[] = [];
  for (const s of o.hotbar) {
    const v = validSlot(s);
    if (v === undefined) return null;
    hotbar.push(v);
  }
  const selected = typeof o.selected === 'number'
    && Number.isInteger(o.selected)
    && o.selected >= 0 && o.selected < HOTBAR_SIZE ? o.selected : 0;

  // Armor — present in v2, missing in migrated-v1 (handled by migrateV1).
  let armor: ArmorSlots = { head: null, body: null, legs: null };
  if (o.armor !== null && typeof o.armor === 'object') {
    const a = o.armor as { head?: unknown; body?: unknown; legs?: unknown };
    const head = validArmorSlot(a.head ?? null);
    const body = validArmorSlot(a.body ?? null);
    const legs = validArmorSlot(a.legs ?? null);
    if (head === undefined || body === undefined || legs === undefined) return null;
    armor = { head, body, legs };
  }
  return { pack, hotbar, selected, armor };
}

/**
 * Migrate a v1 JSON string to a v2 Inventory (injects empty armor slots).
 * Returns null on any parse/validation failure.
 *
 * Exported so node tests can exercise migration without touching localStorage.
 */
export function migrateV1(v1Json: string): Inventory | null {
  let x: unknown;
  try {
    x = JSON.parse(v1Json);
  } catch {
    return null;
  }
  if (typeof x !== 'object' || x === null) return null;
  // Inject empty armor and re-parse through full validation.
  const patched = { ...(x as object), armor: { head: null, body: null, legs: null } };
  return deserializeInventory(JSON.stringify(patched));
}

export function loadInventory(): Inventory {
  try {
    // 1. Try v2 key.
    const raw = localStorage.getItem(INVENTORY_KEY);
    if (raw !== null) {
      const inv = deserializeInventory(raw);
      if (inv !== null) return inv;
    }
    // 2. Try v1 key and migrate.
    const v1Raw = localStorage.getItem(LEGACY_INVENTORY_KEY);
    if (v1Raw !== null) {
      const inv = migrateV1(v1Raw);
      if (inv !== null) return inv;
    }
  } catch { /* storage unavailable */ }
  // 3. Fresh spawn — full starter kit (new game or first boot).
  return createStarterInventory();
}

export function saveInventory(inv: Inventory): void {
  try {
    localStorage.setItem(INVENTORY_KEY, JSON.stringify(inv));
  } catch { /* storage unavailable */ }
}
