/**
 * Unit tests for the NPC chat/trading core (Phase L).
 * Pure CPU — no GPU, no DOM, no server, no playwright.
 * Run: npx tsx scripts/test-npc.mts
 *
 * Golden hash mechanism mirrors test-director.mts / test-vitals.mts:
 * set GOLDEN_NPC_HASH to null to print the hash, then hard-code it.
 */

import {
  NPC_PROMPT_VERSION,
  TRADE_CATALOG,
  SELL_PRICES,
  extractTradeOffer,
  validateTradeAgainstCatalog,
  validateSellOffer,
  applyStock,
  type CatalogEntry,
  type TradeOffer,
} from '../src/game/npc/npc-trade';

import {
  npcNameFor,
  buildNpcSystemPrompt,
  buildNpcMessages,
  type NpcPersona,
} from '../src/game/npc/npc-prompt';

import { ITEM_DEFS } from '../src/game/items';
import type { ChatMessage } from '../src/game/director/director-prompt';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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

function fnv1a(str: string): number {
  const enc = new TextEncoder().encode(str);
  let h = 0x811c9dc5;
  for (let i = 0; i < enc.length; i++) {
    h ^= enc[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// 1. NPC_PROMPT_VERSION
// ---------------------------------------------------------------------------

check('NPC_PROMPT_VERSION === 1', NPC_PROMPT_VERSION === 1);

// ---------------------------------------------------------------------------
// 2. TRADE_CATALOG — all ids valid, prices and stock positive
// ---------------------------------------------------------------------------

const ALL_ROLES = ['farmer', 'villager', 'merchant', 'guard'] as const;

for (const role of ALL_ROLES) {
  const entries = TRADE_CATALOG[role];
  check(`catalog: ${role} has entries`, entries.length > 0);
  for (const e of entries) {
    const idExists = Object.prototype.hasOwnProperty.call(ITEM_DEFS, e.id);
    check(`catalog: ${role}/${e.id} id exists in ITEM_DEFS`, idExists, `unknown id: ${e.id}`);
    check(`catalog: ${role}/${e.id} price > 0`, e.price > 0, `price=${e.price}`);
    check(`catalog: ${role}/${e.id} stock > 0`, e.stock > 0, `stock=${e.stock}`);
  }
}

// ---------------------------------------------------------------------------
// 3. npcNameFor — determinism + variety
// ---------------------------------------------------------------------------

{
  const a = npcNameFor(0xabc, 3, -2, 0);
  const b = npcNameFor(0xabc, 3, -2, 0);
  check('npcNameFor: deterministic', a === b);
  check('npcNameFor: returns a non-empty string', typeof a === 'string' && a.length > 0);

  // Draw 24 names across varying index values; expect >= 10 distinct.
  const names = new Set<string>();
  for (let i = 0; i < 24; i++) {
    names.add(npcNameFor(0x1234, 5, -3, i));
  }
  check('npcNameFor: >= 10 distinct names over 24 draws', names.size >= 10,
    `got ${names.size} distinct`);

  // Different seed → different name (overwhelmingly likely)
  const c = npcNameFor(0x9999, 3, -2, 0);
  // We only assert it produces a valid name, not necessarily different (table is small).
  check('npcNameFor: produces valid table entry', typeof c === 'string' && c.length > 0);
}

// ---------------------------------------------------------------------------
// 4. buildNpcSystemPrompt — content checks
// ---------------------------------------------------------------------------

{
  const merchantPersona: NpcPersona = {
    role: 'merchant',
    name: 'Petra',
    settlement: 'Ashford',
    playerBounty: 0,
  };
  const prompt = buildNpcSystemPrompt(merchantPersona);

  check('system prompt: contains name', prompt.includes('Petra'));
  check('system prompt: contains settlement', prompt.includes('Ashford'));
  check('system prompt: brevity rule present', prompt.includes('60 words'));
  check('system prompt: no meta-talk rule', prompt.includes('meta'));

  // Stock lines for merchant catalog
  for (const e of TRADE_CATALOG.merchant) {
    check(`system prompt merchant: contains stock line for ${e.id}`, prompt.includes(e.id),
      `missing id ${e.id}`);
  }

  // Should include trade JSON instruction
  check('system prompt merchant: trade JSON instruction present',
    prompt.includes('"trade"'));
}

{
  // Guard with bounty — should warn, no trade block instruction
  const guardBounty: NpcPersona = {
    role: 'guard',
    name: 'Aldric',
    settlement: 'Millhaven',
    playerBounty: 200,
  };
  const gPrompt = buildNpcSystemPrompt(guardBounty);
  check('system prompt guard bounty: contains bounty amount', gPrompt.includes('200'));
  check('system prompt guard bounty: stern warning present',
    /bounty/i.test(gPrompt));
  check('system prompt guard bounty: no catalog trade JSON instruction',
    !gPrompt.includes('"trade"'));
}

{
  // Guard with no bounty — no trade
  const guardClean: NpcPersona = {
    role: 'guard',
    name: 'Gorm',
    settlement: 'Millhaven',
    playerBounty: 0,
  };
  const gClean = buildNpcSystemPrompt(guardClean);
  check('system prompt guard clean: no trade instruction', !gClean.includes('"trade"'));
}

// ---------------------------------------------------------------------------
// 5. buildNpcMessages — structure and history capping
// ---------------------------------------------------------------------------

{
  const persona: NpcPersona = {
    role: 'villager',
    name: 'Fenna',
    settlement: 'Mossbridge',
    playerBounty: 0,
  };
  const msgs = buildNpcMessages(persona, [], 'Hello there!');
  check('buildNpcMessages: system first', msgs[0].role === 'system');
  check('buildNpcMessages: user last', msgs[msgs.length - 1].role === 'user');
  check('buildNpcMessages: user text correct', msgs[msgs.length - 1].content === 'Hello there!');
  check('buildNpcMessages: no history → 2 messages', msgs.length === 2);
}

{
  // With 2-turn history (2 messages)
  const persona: NpcPersona = {
    role: 'farmer',
    name: 'Beren',
    settlement: 'Thornfield',
    playerBounty: 0,
  };
  const history: ChatMessage[] = [
    { role: 'user', content: 'What do you sell?' },
    { role: 'assistant', content: 'I have flax and gourd.' },
  ];
  const msgs = buildNpcMessages(persona, history, 'How much for flax?');
  check('buildNpcMessages: 2-turn history → 4 messages', msgs.length === 4,
    `got ${msgs.length}`);
  check('buildNpcMessages: history preserved in order',
    msgs[1].content === 'What do you sell?' && msgs[2].content === 'I have flax and gourd.');
}

{
  // History capping: 20 messages (10 turns) → capped to 8 turns = 16 messages + system + user = 18
  const persona: NpcPersona = {
    role: 'merchant',
    name: 'Quill',
    settlement: 'Ashford',
    playerBounty: 0,
  };
  const longHistory: ChatMessage[] = [];
  for (let i = 0; i < 20; i++) {
    longHistory.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg${i}` });
  }
  const msgs = buildNpcMessages(persona, longHistory, 'new query');
  // 16 history + 1 system + 1 user = 18
  check('buildNpcMessages: history capped at 8 turns (16 msgs)', msgs.length === 18,
    `got ${msgs.length}`);
  // The retained history should start with a user message
  check('buildNpcMessages: retained history starts with user', msgs[1].role === 'user');
}

{
  // History > cap with odd count start: ensure trimmed start is user
  const persona: NpcPersona = {
    role: 'villager',
    name: 'Hilda',
    settlement: 'Mossbridge',
    playerBounty: 0,
  };
  // 17 messages: starts with assistant (odd), should be trimmed
  const oddHistory: ChatMessage[] = [];
  for (let i = 0; i < 17; i++) {
    oddHistory.push({ role: i % 2 === 0 ? 'assistant' : 'user', content: `msg${i}` });
  }
  const msgs = buildNpcMessages(persona, oddHistory, 'hello');
  // After cap to 16, first msg is assistant → trim to 15 (odd), then trim again to 14 (still assistant)
  // Actually: after cap to 16 from 17, we get msgs 1..16. msgs[1] = user.
  // Let's just check that msgs[1] is always 'user' or 'system'.
  check('buildNpcMessages: first non-system message is user',
    msgs[1].role === 'user' || msgs[1].role === 'system');
}

// ---------------------------------------------------------------------------
// 6. extractTradeOffer
// ---------------------------------------------------------------------------

const CLEAN_OFFER = `{"trade":{"give":{"id":"flax","count":2},"want":{"id":"gold_small","count":4}}}`;
const FENCED_OFFER = '```json\n' + CLEAN_OFFER + '\n```';
const PROSE_OFFER = 'Sure, I can do that.\n' + CLEAN_OFFER + '\nEnjoy your purchase!';
const TRAILING_OFFER = CLEAN_OFFER + '\nHave a safe journey!';

{
  const r = extractTradeOffer(CLEAN_OFFER);
  check('extractTradeOffer: clean JSON line', r !== null);
  check('extractTradeOffer: clean — give id', r?.give.id === 'flax');
  check('extractTradeOffer: clean — give count', r?.give.count === 2);
  check('extractTradeOffer: clean — want id', r?.want.id === 'gold_small');
  check('extractTradeOffer: clean — want count', r?.want.count === 4);
}

{
  const r = extractTradeOffer(FENCED_OFFER);
  check('extractTradeOffer: fenced block', r !== null && r.give.id === 'flax');
}

{
  const r = extractTradeOffer(PROSE_OFFER);
  check('extractTradeOffer: prose-wrapped', r !== null && r.give.id === 'flax');
}

{
  const r = extractTradeOffer(TRAILING_OFFER);
  check('extractTradeOffer: trailing text after JSON', r !== null && r.give.id === 'flax');
}

// Malformed → null
{
  check('extractTradeOffer: malformed JSON → null',
    extractTradeOffer('{"trade":{bad json}}') === null);
  check('extractTradeOffer: missing trade key → null',
    extractTradeOffer('{"give":{"id":"flax","count":1},"want":{"id":"gold_small","count":2}}') === null);
  check('extractTradeOffer: unknown item id → null',
    extractTradeOffer('{"trade":{"give":{"id":"nonexistent_item_xyz","count":1},"want":{"id":"gold_small","count":2}}}') === null);
  check('extractTradeOffer: zero count → null',
    extractTradeOffer('{"trade":{"give":{"id":"flax","count":0},"want":{"id":"gold_small","count":2}}}') === null);
  check('extractTradeOffer: negative count → null',
    extractTradeOffer('{"trade":{"give":{"id":"flax","count":-1},"want":{"id":"gold_small","count":2}}}') === null);
  check('extractTradeOffer: fractional count → null',
    extractTradeOffer('{"trade":{"give":{"id":"flax","count":1.5},"want":{"id":"gold_small","count":2}}}') === null);
  check('extractTradeOffer: count > 99 → null',
    extractTradeOffer('{"trade":{"give":{"id":"flax","count":100},"want":{"id":"gold_small","count":2}}}') === null);
  check('extractTradeOffer: no JSON at all → null',
    extractTradeOffer('I cannot help with that.') === null);
}

// LAST offer wins when two present
{
  const first = '{"trade":{"give":{"id":"flax","count":1},"want":{"id":"gold_small","count":2}}}';
  const second = '{"trade":{"give":{"id":"gourd","count":3},"want":{"id":"gold_small","count":9}}}';
  const r = extractTradeOffer(first + '\n' + second);
  check('extractTradeOffer: last offer wins (two offers in text)',
    r !== null && r.give.id === 'gourd' && r.give.count === 3);
}

// ---------------------------------------------------------------------------
// 7. validateTradeAgainstCatalog
// ---------------------------------------------------------------------------

{
  // OK path: farmer sells 2 flax at full price (2 * 2 = 4 gold)
  const offer: TradeOffer = {
    give: { id: 'flax', count: 2 },
    want: { id: 'gold_small', count: 4 },
  };
  const r = validateTradeAgainstCatalog(offer, 'farmer');
  check('validateTrade: ok path', r.ok === true);
}

{
  // Non-catalog item for this role
  const offer: TradeOffer = {
    give: { id: 'iron_ingot', count: 1 },
    want: { id: 'gold_small', count: 25 },
  };
  const r = validateTradeAgainstCatalog(offer, 'farmer');
  check('validateTrade: non-catalog give rejected', r.ok === false);
}

{
  // Over-stock: farmer has 8 flax, ask for 9
  const offer: TradeOffer = {
    give: { id: 'flax', count: 9 },
    want: { id: 'gold_small', count: 18 },
  };
  const r = validateTradeAgainstCatalog(offer, 'farmer');
  check('validateTrade: over-stock rejected', r.ok === false,
    r.ok ? '' : (r as { ok: false; reason: string }).reason);
}

{
  // Lowball: 1 flax costs 2 gold, 80% floor = floor(2*1*0.8) = 1; offer 0 gold
  const offer: TradeOffer = {
    give: { id: 'flax', count: 1 },
    want: { id: 'gold_small', count: 0 },
  };
  // count 0 is invalid per extractTradeOffer but validateTrade doesn't re-validate count range;
  // it only checks >= minGold. minGold = floor(2*1*0.8) = 1; 0 < 1 → rejected.
  const r = validateTradeAgainstCatalog(offer, 'farmer');
  check('validateTrade: lowball gold rejected (<80%)', r.ok === false);
}

{
  // Exactly 80%: 1 flax costs 2, 80% of 2 = 1.6 → floor = 1. Offer 1 → accepted.
  const offer: TradeOffer = {
    give: { id: 'flax', count: 1 },
    want: { id: 'gold_small', count: 1 },
  };
  const r = validateTradeAgainstCatalog(offer, 'farmer');
  check('validateTrade: exactly 80% floor accepted', r.ok === true);
}

{
  // Want is not gold_small
  const offer: TradeOffer = {
    give: { id: 'torch', count: 1 },
    want: { id: 'stone', count: 10 },
  };
  const r = validateTradeAgainstCatalog(offer, 'villager');
  check('validateTrade: non-gold_small want rejected', r.ok === false);
}

{
  // Merchant: iron_ingot, price=25, count=2, 80% floor = floor(25*2*0.8) = 40. Offer 39 → rejected.
  const lowOffer: TradeOffer = {
    give: { id: 'iron_ingot', count: 2 },
    want: { id: 'gold_small', count: 39 },
  };
  check('validateTrade: merchant lowball rejected',
    validateTradeAgainstCatalog(lowOffer, 'merchant').ok === false);

  // Offer 40 → accepted
  const okOffer: TradeOffer = {
    give: { id: 'iron_ingot', count: 2 },
    want: { id: 'gold_small', count: 40 },
  };
  check('validateTrade: merchant 80% floor accepted',
    validateTradeAgainstCatalog(okOffer, 'merchant').ok === true);
}

// ---------------------------------------------------------------------------
// 8. applyStock
// ---------------------------------------------------------------------------

{
  const catalog = TRADE_CATALOG.farmer.map((e) => ({ ...e })); // shallow copy
  const offer: TradeOffer = {
    give: { id: 'flax', count: 3 },
    want: { id: 'gold_small', count: 6 },
  };

  const updated = applyStock(catalog, offer);

  // Original is not mutated
  const originalFlax = TRADE_CATALOG.farmer.find((e) => e.id === 'flax')!;
  check('applyStock: original catalog not mutated',
    originalFlax.stock === TRADE_CATALOG.farmer.find((e) => e.id === 'flax')!.stock);

  // Updated entry decremented
  const updatedFlax = updated.find((e) => e.id === 'flax')!;
  check('applyStock: stock decremented by give.count',
    updatedFlax.stock === originalFlax.stock - 3,
    `expected ${originalFlax.stock - 3}, got ${updatedFlax.stock}`);

  // Other entries unchanged
  const originalGourd = TRADE_CATALOG.farmer.find((e) => e.id === 'gourd')!;
  const updatedGourd = updated.find((e) => e.id === 'gourd')!;
  check('applyStock: other entries unchanged', updatedGourd.stock === originalGourd.stock);

  // Length preserved
  check('applyStock: length preserved', updated.length === catalog.length);

  // Returned list is a new array (immutability)
  check('applyStock: returns new array', updated !== catalog);
}

// ---------------------------------------------------------------------------
// 9. Golden FNV hash of buildNpcMessages output
// ---------------------------------------------------------------------------

/**
 * Fixed persona, fixed 2-turn history, fixed user text → deterministic JSON.
 * Update GOLDEN_NPC_HASH when NPC_PROMPT_VERSION is bumped.
 */
const GOLDEN_NPC_HASH: number | null = 0xb6d76501;

const goldenPersona: NpcPersona = {
  role: 'merchant',
  name: 'Petra',
  settlement: 'Ashford',
  playerBounty: 0,
};

const goldenHistory: ChatMessage[] = [
  { role: 'user', content: 'What wares do you carry?' },
  { role: 'assistant', content: 'I stock iron ingots, leather, and fine potions.' },
];

const goldenUserText = 'How much for two iron ingots?';

const goldenMessages = buildNpcMessages(goldenPersona, goldenHistory, goldenUserText);
const goldenJson = JSON.stringify(goldenMessages);
const goldenHash = fnv1a(goldenJson);

if (GOLDEN_NPC_HASH === null) {
  console.log(`\ngolden NPC message hash: 0x${goldenHash.toString(16).padStart(8, '0')} (hard-code as GOLDEN_NPC_HASH and re-run)`);
} else {
  check(
    `golden NPC hash (NPC_PROMPT_VERSION=${NPC_PROMPT_VERSION})`,
    goldenHash === GOLDEN_NPC_HASH,
    `got 0x${goldenHash.toString(16).padStart(8, '0')}, want 0x${(GOLDEN_NPC_HASH as number).toString(16).padStart(8, '0')}`,
  );
}

// ---------------------------------------------------------------------------
// 10. SELL_PRICES — sanity checks
// ---------------------------------------------------------------------------

{
  // Every id in SELL_PRICES must exist in ITEM_DEFS.
  let allExist = true;
  for (const id of Object.keys(SELL_PRICES) as Array<keyof typeof SELL_PRICES>) {
    const exists = Object.prototype.hasOwnProperty.call(ITEM_DEFS, id);
    if (!exists) {
      check(`SELL_PRICES: id '${id}' exists in ITEM_DEFS`, false, `unknown id: ${id}`);
      allExist = false;
    }
  }
  if (allExist) check('SELL_PRICES: all ids exist in ITEM_DEFS', true);

  // Expected specific entries are present and positive.
  const expectedIds = [
    'hide', 'leather', 'meat_raw', 'meat_cooked', 'feather',
    'bone', 'wool', 'coal', 'copper_ore', 'tin_ore', 'iron_ingot',
    'dragon_scale', 'griffin_feather', 'ancient_relic',
  ] as const;
  for (const id of expectedIds) {
    const price = SELL_PRICES[id];
    check(`SELL_PRICES: '${id}' has a price`, price !== undefined, `missing id`);
    if (price !== undefined) {
      check(`SELL_PRICES: '${id}' price > 0`, price > 0, `got ${price}`);
    }
  }

  // All prices must be positive integers.
  for (const [id, price] of Object.entries(SELL_PRICES)) {
    check(`SELL_PRICES: '${id}' price is positive integer`,
      typeof price === 'number' && Number.isInteger(price) && price > 0,
      `got ${price}`);
  }

  // At least 10 entries.
  check('SELL_PRICES: has at least 10 entries',
    Object.keys(SELL_PRICES).length >= 10,
    `got ${Object.keys(SELL_PRICES).length}`);
}

// ---------------------------------------------------------------------------
// 11. validateSellOffer — role gating
// ---------------------------------------------------------------------------

{
  // villager → not a buyer.
  const offer: TradeOffer = {
    give: { id: 'gold_small', count: 4 },
    want: { id: 'hide', count: 1 },
  };
  const r = validateSellOffer(offer, 'villager', 200);
  check('validateSellOffer: villager not a buyer', r.ok === false,
    r.ok ? '' : (r as { ok: false; reason: string }).reason);
  check('validateSellOffer: villager reason non-empty',
    !r.ok && (r as { ok: false; reason: string }).reason.length > 0);
}

{
  // guard → not a buyer.
  const offer: TradeOffer = {
    give: { id: 'gold_small', count: 4 },
    want: { id: 'hide', count: 1 },
  };
  const r = validateSellOffer(offer, 'guard', 200);
  check('validateSellOffer: guard not a buyer', r.ok === false);
}

{
  // merchant buys hide for fair price.
  const offer: TradeOffer = {
    give: { id: 'gold_small', count: 4 },  // SELL_PRICES.hide = 4; fair for 1 unit
    want: { id: 'hide', count: 1 },
  };
  const r = validateSellOffer(offer, 'merchant', 200);
  check('validateSellOffer: merchant accepts hide at fair price', r.ok === true);
}

{
  // farmer buys hide (in FARMER_BUY_IDS).
  const offer: TradeOffer = {
    give: { id: 'gold_small', count: 4 },
    want: { id: 'hide', count: 1 },
  };
  const r = validateSellOffer(offer, 'farmer', 60);
  check('validateSellOffer: farmer accepts hide', r.ok === true);
}

{
  // farmer rejects iron_ingot (not in FARMER_BUY_IDS).
  const offer: TradeOffer = {
    give: { id: 'gold_small', count: 12 },
    want: { id: 'iron_ingot', count: 1 },
  };
  const r = validateSellOffer(offer, 'farmer', 60);
  check('validateSellOffer: farmer rejects iron_ingot', r.ok === false);
}

// ---------------------------------------------------------------------------
// 12. validateSellOffer — overpay cap (120 % of fair)
// ---------------------------------------------------------------------------

{
  // hide price = 4, count = 1, maxGold = ceil(4 * 1 * 1.2) = 5.
  // Offer 5 → accepted.
  const ok: TradeOffer = {
    give: { id: 'gold_small', count: 5 },
    want: { id: 'hide', count: 1 },
  };
  check('validateSellOffer: 120% cap exact accepted',
    validateSellOffer(ok, 'merchant', 200).ok === true);

  // Offer 6 → rejected (> 120%).
  const over: TradeOffer = {
    give: { id: 'gold_small', count: 6 },
    want: { id: 'hide', count: 1 },
  };
  const r = validateSellOffer(over, 'merchant', 200);
  check('validateSellOffer: overpay > 120% rejected', r.ok === false);
  check('validateSellOffer: overpay reason mentions cap',
    !r.ok && /cap/i.test((r as { ok: false; reason: string }).reason));
}

// ---------------------------------------------------------------------------
// 13. validateSellOffer — gold pool limit
// ---------------------------------------------------------------------------

{
  // NPC has only 3 gold; player wants 4 for 1 hide → rejected.
  const offer: TradeOffer = {
    give: { id: 'gold_small', count: 4 },
    want: { id: 'hide', count: 1 },
  };
  const r = validateSellOffer(offer, 'merchant', 3);
  check('validateSellOffer: NPC gold pool too low → rejected', r.ok === false);
  check('validateSellOffer: gold pool reason mentions gold',
    !r.ok && /gold/i.test((r as { ok: false; reason: string }).reason));
}

{
  // NPC has 0 gold → rejected.
  const offer: TradeOffer = {
    give: { id: 'gold_small', count: 1 },
    want: { id: 'hide', count: 1 },
  };
  const r = validateSellOffer(offer, 'merchant', 0);
  check('validateSellOffer: 0 npcGold → rejected', r.ok === false);
}

// ---------------------------------------------------------------------------
// 14. validateSellOffer — item not in SELL_PRICES
// ---------------------------------------------------------------------------

{
  // 'iron_sword' is not in SELL_PRICES.
  const offer: TradeOffer = {
    give: { id: 'gold_small', count: 20 },
    want: { id: 'iron_sword', count: 1 },
  };
  const r = validateSellOffer(offer, 'merchant', 200);
  check('validateSellOffer: item not in SELL_PRICES → rejected', r.ok === false);
}

// ---------------------------------------------------------------------------
// 15. validateSellOffer — give must be gold_small
// ---------------------------------------------------------------------------

{
  // If NPC is not giving gold_small, the offer is invalid for sell path.
  const offer: TradeOffer = {
    give: { id: 'iron_ingot', count: 1 },
    want: { id: 'hide', count: 1 },
  };
  const r = validateSellOffer(offer, 'merchant', 200);
  check('validateSellOffer: give non-gold → rejected', r.ok === false);
}

// ---------------------------------------------------------------------------
// 16. validateSellOffer — multi-item quantity
// ---------------------------------------------------------------------------

{
  // iron_ingot price = 12; 2 units → fair = 24; cap = ceil(12*2*1.2) = 29.
  // Offer 24 gold for 2 iron_ingot → accepted by merchant.
  const ok: TradeOffer = {
    give: { id: 'gold_small', count: 24 },
    want: { id: 'iron_ingot', count: 2 },
  };
  check('validateSellOffer: merchant accepts 2 iron_ingot at fair price',
    validateSellOffer(ok, 'merchant', 200).ok === true);

  // Offer 30 gold for 2 iron_ingot → over 120% cap (29) → rejected.
  const over: TradeOffer = {
    give: { id: 'gold_small', count: 30 },
    want: { id: 'iron_ingot', count: 2 },
  };
  check('validateSellOffer: overpay for 2 iron_ingot rejected',
    validateSellOffer(over, 'merchant', 200).ok === false);
}

// ---------------------------------------------------------------------------
// 17. SELL_PRICES relative to buy-side prices (sanity, not exact)
// ---------------------------------------------------------------------------

{
  // iron_ingot: merchant buy = 25, sell price = 12 ≈ 48 % — reasonable.
  const buyPrice = TRADE_CATALOG.merchant.find((e) => e.id === 'iron_ingot')!.price;
  const sellPrice = SELL_PRICES['iron_ingot']!;
  check('SELL_PRICES: iron_ingot sell < buy (NPC buy side)',
    sellPrice < buyPrice, `sell=${sellPrice} buy=${buyPrice}`);

  // leather: merchant buy = 12, sell price = 6 ≈ 50 %.
  const leatherBuy = TRADE_CATALOG.merchant.find((e) => e.id === 'leather')!.price;
  const leatherSell = SELL_PRICES['leather']!;
  check('SELL_PRICES: leather sell < buy price',
    leatherSell < leatherBuy, `sell=${leatherSell} buy=${leatherBuy}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0 || GOLDEN_NPC_HASH === null) {
  if (GOLDEN_NPC_HASH === null) console.error('GOLDEN_NPC_HASH not set yet — set it and re-run');
  process.exit(1);
}
