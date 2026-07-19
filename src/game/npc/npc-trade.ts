/**
 * NPC trade catalog, offer extraction, and stock management.
 * Pure functions — no DOM, no engine, node-testable.
 */

import { ITEM_DEFS, type GameItemId } from '../items';

/** Bump when the NPC prompt/trade logic changes materially. */
export const NPC_PROMPT_VERSION = 1;

export type NpcRole = 'farmer' | 'villager' | 'merchant' | 'guard';

export interface CatalogEntry {
  id: GameItemId;
  price: number;  // gold_small units per 1 of this item
  stock: number;
}

/**
 * Trade catalog per role.
 * NPC gives `id` in exchange for gold_small.
 * All ids verified against ITEM_DEFS.
 */
export const TRADE_CATALOG: Record<NpcRole, CatalogEntry[]> = {
  farmer: [
    { id: 'flax',         price: 2, stock: 8 },
    { id: 'gourd',        price: 3, stock: 6 },
    { id: 'meat_raw',     price: 4, stock: 6 },
    { id: 'egg_bird',     price: 5, stock: 4 },
    { id: 'healing_herb', price: 3, stock: 5 },
  ],
  villager: [
    { id: 'torch',       price: 6,  stock: 4 },
    { id: 'rope',        price: 8,  stock: 3 },
    { id: 'gourd_bottle',price: 10, stock: 2 },
    { id: 'bone_needle', price: 4,  stock: 3 },
  ],
  merchant: [
    { id: 'iron_ingot',     price: 25, stock: 4 },
    { id: 'leather',        price: 12, stock: 6 },
    { id: 'healing_potion', price: 30, stock: 2 },
    { id: 'waterskin',      price: 25, stock: 1 },
    { id: 'cooking_pot',    price: 40, stock: 1 },
    { id: 'bow_string',     price: 15, stock: 2 },
  ],
  guard: [
    { id: 'arrow',    price: 2,  stock: 20 },
    { id: 'spear',    price: 35, stock: 1  },
    { id: 'iron_helm',price: 60, stock: 1  },
  ],
};

/** What the NPC offers: gives `give`, wants `want` from the player. */
export interface TradeOffer {
  give: { id: GameItemId; count: number };
  want: { id: GameItemId; count: number };
}

/** Shape of the JSON block the model is asked to emit. */
interface RawTrade {
  trade: {
    give: { id: string; count: number };
    want: { id: string; count: number };
  };
}

function isValidCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 99;
}

function isKnownItem(id: unknown): id is GameItemId {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(ITEM_DEFS, id);
}

function parseRawTrade(obj: unknown): TradeOffer | null {
  if (obj === null || typeof obj !== 'object') return null;
  const raw = obj as Record<string, unknown>;
  if (!('trade' in raw) || raw['trade'] === null || typeof raw['trade'] !== 'object') return null;
  const t = raw['trade'] as Record<string, unknown>;
  if (!t['give'] || typeof t['give'] !== 'object') return null;
  if (!t['want'] || typeof t['want'] !== 'object') return null;
  const g = t['give'] as Record<string, unknown>;
  const w = t['want'] as Record<string, unknown>;
  if (!isKnownItem(g['id']) || !isValidCount(g['count'])) return null;
  if (!isKnownItem(w['id']) || !isValidCount(w['count'])) return null;
  return {
    give: { id: g['id'], count: g['count'] as number },
    want: { id: w['id'], count: w['count'] as number },
  };
}

/**
 * Find the LAST JSON object in `text` that contains a top-level "trade" key.
 * Uses extractSpecJson for fence / balanced-object extraction, then validates
 * shape and item ids. Returns null when absent or malformed.
 */
export function extractTradeOffer(text: string): TradeOffer | null {
  // Collect all candidate balanced JSON objects from the text, last wins.
  // We re-implement the scan ourselves (same algorithm as extractSpecJson's
  // no-fence fallback) so we can iterate ALL objects and pick the last valid
  // trade offer — extractSpecJson would only return the last parseable object
  // regardless of whether it has a "trade" key.

  // First try: fenced blocks (last fence with a trade key).
  const fences = [...text.matchAll(/```[a-zA-Z_]*[ \t]*\r?\n([\s\S]*?)(?:```|$)/g)];
  let lastOffer: TradeOffer | null = null;

  for (const fence of fences) {
    const body = fence[1].trim();
    try {
      const parsed = JSON.parse(body);
      const offer = parseRawTrade(parsed);
      if (offer !== null) lastOffer = offer;
    } catch { /* not JSON */ }
  }

  // Also scan all balanced {...} objects in the whole text (covers prose-wrapped
  // and no-fence cases, and lets us find offers even outside fences).
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end === -1) continue;
    try {
      const parsed = JSON.parse(text.slice(i, end + 1));
      const offer = parseRawTrade(parsed);
      if (offer !== null) lastOffer = offer;
    } catch { /* skip */ }
    i = end;
  }

  return lastOffer;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate a trade offer against the NPC's role catalog.
 *
 * Rules:
 * - The NPC may only GIVE items present in its catalog.
 * - The give count must not exceed the catalog stock.
 * - When the give item is a catalog item, the player's want must be gold_small
 *   with count >= price * give.count * 0.8 (20 % haggle floor).
 */
export function validateTradeAgainstCatalog(
  offer: TradeOffer,
  role: NpcRole,
): ValidationResult {
  const catalog = TRADE_CATALOG[role];
  const entry = catalog.find((e) => e.id === offer.give.id);

  if (entry === undefined) {
    return { ok: false, reason: `NPC role '${role}' does not sell '${offer.give.id}'` };
  }

  if (offer.give.count > entry.stock) {
    return {
      ok: false,
      reason: `Requested ${offer.give.count} of '${offer.give.id}' but stock is only ${entry.stock}`,
    };
  }

  // Price fairness check: player must pay gold_small >= price * count * 0.8
  const minGold = Math.floor(entry.price * offer.give.count * 0.8);
  if (offer.want.id !== 'gold_small') {
    return {
      ok: false,
      reason: `NPC wants gold_small for '${offer.give.id}', not '${offer.want.id}'`,
    };
  }
  if (offer.want.count < minGold) {
    return {
      ok: false,
      reason: `Offer of ${offer.want.count} gold_small is below the 80% floor of ${minGold}`,
    };
  }

  return { ok: true };
}

/**
 * Return a new catalog list with the give item's stock decremented by offer.give.count.
 * Pure — does not mutate the input list.
 */
export function applyStock(catalog: CatalogEntry[], offer: TradeOffer): CatalogEntry[] {
  return catalog.map((entry) => {
    if (entry.id === offer.give.id) {
      return { ...entry, stock: entry.stock - offer.give.count };
    }
    return entry;
  });
}

// ---------------------------------------------------------------------------
// Sell-side: player sells items TO the NPC for gold_small
// ---------------------------------------------------------------------------

/**
 * NPC buy prices for player-owned loot and materials.
 *
 * Values are set at ~40-60% of the NPC sell-side price where one exists,
 * and at sensible loot/drop rates for items with no sell-side equivalent.
 *
 * Role coverage (enforced in validateSellOffer):
 *   merchant — buys everything listed here
 *   farmer   — buys farm/animal goods: hide, leather, meat_raw, meat_cooked,
 *               feather, bone, wool, egg_bird, flax, gourd
 *   villager — not a buyer
 *   guard    — not a buyer
 */
export const SELL_PRICES: Partial<Record<GameItemId, number>> = {
  // Animal drops
  hide:            4,
  leather:         6,   // ~50 % of merchant buy price 12
  meat_raw:        2,
  meat_cooked:     4,
  feather:         1,
  bone:            1,
  wool:            2,
  egg_bird:        3,

  // Ore / minerals
  coal:            2,
  copper_ore:      3,
  tin_ore:         3,
  copper_ingot:    6,
  tin_ingot:       6,
  bronze_ingot:    8,
  iron_ingot:     12,   // ~48 % of merchant buy price 25

  // Plants / gathered
  flax:            1,
  gourd:           1,

  // Rare loot / dungeon drops
  dragon_scale:   40,
  griffin_feather:30,
  ancient_relic:  50,
  old_bone:        1,
  torch_oil:       2,
};

/** Items the farmer role will buy (subset of SELL_PRICES). */
const FARMER_BUY_IDS: ReadonlySet<GameItemId> = new Set<GameItemId>([
  'hide', 'leather', 'meat_raw', 'meat_cooked',
  'feather', 'bone', 'wool', 'egg_bird',
  'flax', 'gourd',
]);

/**
 * Validate a player→NPC sell offer.
 *
 * In a sell offer the NPC is GIVING gold and WANTING the player's item, so:
 *   offer.give = { id: 'gold_small', count: M }
 *   offer.want = { id: <item>, count: N }
 *
 * Rules:
 *   - offer.give.id must be 'gold_small'
 *   - offer.want.id must appear in SELL_PRICES
 *   - Role gate: merchant accepts all SELL_PRICES items; farmer accepts only
 *     FARMER_BUY_IDS; villager and guard never buy (return not-a-buyer reason)
 *   - offer.give.count >= 1
 *   - offer.give.count <= npcGold (NPC must have the coins)
 *   - offer.give.count <= ceil(SELL_PRICES[item] * N * 1.2)
 *     (NPC will not overpay more than 120 % of fair price)
 */
export function validateSellOffer(
  offer: TradeOffer,
  role: NpcRole,
  npcGold: number,
): ValidationResult {
  // Role gate: only merchant and farmer buy anything.
  if (role === 'villager') {
    return { ok: false, reason: 'Villagers do not buy goods from travellers.' };
  }
  if (role === 'guard') {
    return { ok: false, reason: 'Guards do not purchase goods.' };
  }

  // Structure: give must be gold_small, want is the player's item.
  if (offer.give.id !== 'gold_small') {
    return { ok: false, reason: `Sell offer must give gold_small, not '${offer.give.id}'` };
  }

  const itemId = offer.want.id;
  const fairPrice = SELL_PRICES[itemId];
  if (fairPrice === undefined) {
    return { ok: false, reason: `'${itemId}' is not something we purchase.` };
  }

  // Role-specific item gate.
  if (role === 'farmer' && !FARMER_BUY_IDS.has(itemId)) {
    return { ok: false, reason: `A farmer has no use for '${itemId}'.` };
  }

  // NPC must have the gold.
  if (offer.give.count > npcGold) {
    return {
      ok: false,
      reason: `The NPC only has ${npcGold} gold — cannot pay ${offer.give.count}.`,
    };
  }

  // Must offer at least 1 gold.
  if (offer.give.count < 1) {
    return { ok: false, reason: 'Offer must include at least 1 gold.' };
  }

  // Overpay cap: NPC won't pay more than 120 % of fair price.
  const maxGold = Math.ceil(fairPrice * offer.want.count * 1.2);
  if (offer.give.count > maxGold) {
    return {
      ok: false,
      reason: `Offer of ${offer.give.count} gold exceeds the 120% fair-price cap of ${maxGold}.`,
    };
  }

  return { ok: true };
}
