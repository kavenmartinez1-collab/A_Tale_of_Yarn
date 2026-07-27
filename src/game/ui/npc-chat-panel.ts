/**
 * NPC chat panel — Phase L2.
 *
 * Opens when the player presses E near an NPC.  Shows NPC name + role,
 * scrollable message history, and a free-text input.  Enter sends, Esc closes.
 *
 * In stub mode (?director=off) a deterministic reply generator responds
 * immediately without any LLM call.  Live mode streams from the local
 * Qwen3-4B endpoint — same transport as the Director.
 *
 * After every completed assistant reply, extractTradeOffer is called.  If a
 * valid offer passes validateTradeAgainstCatalog, an offer card is rendered
 * with Confirm/Decline buttons.
 */

import type { NpcPersona } from '../npc/npc-prompt';
import { buildNpcMessages, buildNpcSystemPrompt, npcGenderFor, npcQuirkFor, UNIVERSAL_PREAMBLE } from '../npc/npc-prompt';
import {
  screenPlayerInput, screenNpcReply, safetyDeflection,
} from '../npc/content-safety';
import type { ForkedChatContext } from '../../engine/inference';
import {
  TRADE_CATALOG, SELL_PRICES, extractTradeOffer, extractNpcAction, stripNpcJson,
  threatActionFor, memoryFactForAction,
  validateTradeAgainstCatalog, validateSellOffer, applyStock,
  type TradeOffer, type CatalogEntry, type NpcRole, type NpcActionKind,
} from '../npc/npc-trade';
import type { ChatMessage } from '../director/director-prompt';
import type { Inventory } from '../inventory';
import { countItem, removeItem, addItem, saveInventory } from '../inventory';
import { itemDef, type GameItemId } from '../items';
import { itemIcon } from './item-icons';
import type { PanelManager } from './panel-manager';
import {
  getOrCreateMemory, addFact, adjustDisposition, saveMemoryMap,
  dispositionTone, detectThreat, REFUSE_CHAT_BELOW, type MemoryMap,
  detectFlirt, adjustRomance, marry, romanceTone,
  ROMANCE_ACCEPT_AT, FLIRT_ROMANCE_GAIN,
  detectFollowRequest, detectStayRequest, FOLLOW_TRUST_AT, isRepetitiveReply,
  detectHomeRequest,
} from '../npc/npc-memory';

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export const NPC_STOCK_KEY = 'artifex-npc-stock:v1';

/**
 * Per-NPC persisted record.
 *
 * v2 shape: { catalog, gold, lastRegenMs }
 * legacy (bare CatalogEntry[]) is migrated on first load.
 */
export interface NpcStockRecord {
  catalog: CatalogEntry[];
  gold: number;
  lastRegenMs: number;
}

/**
 * Persisted map: stockKey → NpcStockRecord.
 * (The public type stays as Record<string, NpcStockRecord> for callers;
 * legacy bare-array values are migrated transparently in loadStockMap.)
 */
export type StockMap = Record<string, NpcStockRecord>;

/** Starting gold pools per role. */
const GOLD_POOL_START: Record<NpcRole, number> = {
  merchant: 200,
  farmer:   60,
  villager: 0,
  guard:    0,
};

/** Regen rate: +25 gold per 2 real-time minutes, capped at start value. */
const REGEN_AMOUNT   = 25;
const REGEN_PERIOD_MS = 2 * 60 * 1000; // 2 min in ms

/**
 * Lazily compute how much gold has regenerated since lastRegenMs.
 * Returns the new gold value (capped at cap).
 */
function regenGold(current: number, lastRegenMs: number, cap: number, nowMs: number): number {
  if (cap <= 0) return 0;
  const elapsed = Math.max(0, nowMs - lastRegenMs);
  const periods = Math.floor(elapsed / REGEN_PERIOD_MS);
  return Math.min(cap, current + periods * REGEN_AMOUNT);
}

/**
 * Lazily regenerate stock for a catalog: +1 unit per item per elapsed regen
 * period, capped at the catalog baseline stock for that role.
 * Returns a new catalog array (pure); input list is not mutated.
 */
function regenStock(
  current: CatalogEntry[],
  baseline: CatalogEntry[],
  lastRegenMs: number,
  nowMs: number,
): CatalogEntry[] {
  const elapsed = Math.max(0, nowMs - lastRegenMs);
  const periods = Math.floor(elapsed / REGEN_PERIOD_MS);
  if (periods === 0) return current;
  return current.map((entry) => {
    const base = baseline.find((b) => b.id === entry.id);
    const cap = base !== undefined ? base.stock : entry.stock;
    return { ...entry, stock: Math.min(cap, entry.stock + periods) };
  });
}

/** Migrate a bare CatalogEntry[] to NpcStockRecord using the given role defaults. */
function migrateRecord(arr: CatalogEntry[], role: NpcRole): NpcStockRecord {
  return {
    catalog: arr,
    gold: GOLD_POOL_START[role],
    lastRegenMs: Date.now(),
  };
}

export function loadStockMap(): StockMap {
  try {
    const raw = localStorage.getItem(NPC_STOCK_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    // Migrate any legacy bare-array values.
    const result: StockMap = {};
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(val)) {
        // Legacy: bare CatalogEntry[].  We don't know the role here so default to merchant
        // pool — it's the least harmful default (farmer items would regen faster).
        result[key] = migrateRecord(val as CatalogEntry[], 'merchant');
      } else if (
        val !== null && typeof val === 'object' &&
        'catalog' in (val as object) &&
        'gold' in (val as object) &&
        'lastRegenMs' in (val as object)
      ) {
        result[key] = val as NpcStockRecord;
      }
      // Unrecognised shapes are dropped (will be re-initialised from catalog).
    }
    return result;
  } catch {
    return {};
  }
}

export function saveStockMap(map: StockMap): void {
  try {
    localStorage.setItem(NPC_STOCK_KEY, JSON.stringify(map));
  } catch { /* quota */ }
}

/** Key used to persist stock for a given NPC (by settlement + npc id). */
export function stockKey(settlementName: string, npcId: string): string {
  return `${settlementName}::${npcId}`;
}

/** Return the current gold for a persisted NPC record (with lazy regen applied). */
export function getNpcGold(map: StockMap, key: string): number {
  const rec = map[key];
  if (rec === undefined) return 0;
  return regenGold(rec.gold, rec.lastRegenMs, rec.gold /* cap at current max — use initial role value if available */, Date.now());
}

/** Return the gold pool for a given npcKey (settlementName::npcId), or 0. */
export function npcGoldFromMap(map: StockMap, key: string): number {
  const rec = map[key];
  if (rec === undefined) return 0;
  return rec.gold;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const CHAT_CSS = `
#npc-chat-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
#npc-chat-panel .npc-columns {
  display: flex;
  flex-direction: row;
  gap: 12px;
  align-items: stretch;
}
#npc-chat-panel .npc-chat-col {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 320px;
  max-width: 400px;
  flex: 1;
}
#npc-chat-panel #npc-trade-column {
  width: 240px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-left: 1px solid rgba(205,214,228,0.12);
  padding-left: 12px;
  max-height: 360px;
  overflow-y: auto;
}
#npc-chat-panel .trade-gold {
  font-size: 11px;
  color: #e8c97a;
  margin-bottom: 2px;
}
#npc-chat-panel .trade-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  opacity: 0.55;
  margin-top: 4px;
}
#npc-chat-panel .trade-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #cdd6e4;
  padding: 2px 0;
}
#npc-chat-panel .trade-row img {
  width: 20px;
  height: 20px;
  image-rendering: pixelated;
  flex: none;
}
#npc-chat-panel .trade-row .trade-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#npc-chat-panel .trade-row .trade-price {
  color: #e8c97a;
  flex: none;
}
#npc-chat-panel .trade-row button {
  background: rgba(205,214,228,0.12);
  color: inherit;
  border: 1px solid rgba(205,214,228,0.25);
  border-radius: 4px;
  padding: 1px 7px;
  cursor: pointer;
  font: inherit;
  font-size: 10px;
  flex: none;
}
#npc-chat-panel .trade-row button:hover { opacity: 0.8; }
#npc-chat-panel .trade-row button:disabled { opacity: 0.35; cursor: default; }
#npc-chat-panel .trade-empty {
  font-size: 11px;
  opacity: 0.45;
  font-style: italic;
}
#npc-chat-panel .npc-header {
  font-size: 14px;
  font-weight: 700;
  color: #e8c97a;
  margin-bottom: 2px;
}
#npc-chat-panel .npc-role {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  opacity: 0.55;
  margin-bottom: 6px;
}
#npc-chat-panel .npc-history {
  min-height: 120px;
  max-height: 260px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 4px;
  background: rgba(0,0,0,0.20);
  border-radius: 6px;
  border: 1px solid rgba(205,214,228,0.10);
}
#npc-chat-panel .msg {
  max-width: 96%;
  font-size: 12px;
  line-height: 1.5;
  padding: 5px 8px;
  border-radius: 5px;
  word-break: break-word;
}
#npc-chat-panel .msg.user {
  background: rgba(90,110,180,0.22);
  align-self: flex-end;
  color: #b8c8f0;
}
#npc-chat-panel .msg.assistant {
  background: rgba(205,214,228,0.10);
  align-self: flex-start;
  color: #cdd6e4;
}
#npc-chat-panel .msg.system {
  background: transparent;
  align-self: center;
  color: rgba(205,214,228,0.40);
  font-style: italic;
  font-size: 11px;
}
#npc-chat-panel .msg.thinking {
  background: transparent;
  align-self: flex-start;
  color: rgba(205,214,228,0.35);
  font-style: italic;
  font-size: 11px;
}
#npc-chat-panel .offer-card {
  background: rgba(80,180,100,0.15);
  border: 1px solid rgba(80,180,100,0.35);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  color: #a8e0b0;
}
#npc-chat-panel .offer-card .offer-title {
  font-weight: 700;
  margin-bottom: 4px;
  color: #c8f0c8;
}
#npc-chat-panel .offer-card .offer-buttons {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
#npc-chat-panel .offer-card button {
  background: rgba(205,214,228,0.12);
  color: inherit;
  border: 1px solid rgba(205,214,228,0.25);
  border-radius: 5px;
  padding: 3px 12px;
  cursor: pointer;
  font: inherit;
  font-size: 11px;
}
#npc-chat-panel .offer-card button.confirm {
  background: rgba(80,180,100,0.25);
  border-color: rgba(80,180,100,0.5);
  color: #c8f0c8;
}
#npc-chat-panel .offer-card button:hover { opacity: 0.8; }
#npc-chat-panel .offer-card.declined {
  opacity: 0.45;
  pointer-events: none;
}
#npc-chat-panel .npc-input-row {
  display: flex;
  gap: 6px;
}
#npc-chat-panel .npc-input {
  flex: 1;
  background: rgba(10,14,20,0.60);
  color: #cdd6e4;
  border: 1px solid rgba(205,214,228,0.25);
  border-radius: 5px;
  padding: 5px 8px;
  font: 12px system-ui, sans-serif;
  outline: none;
}
#npc-chat-panel .npc-input:focus {
  border-color: rgba(205,214,228,0.50);
}
#npc-chat-panel .npc-send {
  background: rgba(205,214,228,0.12);
  color: inherit;
  border: 1px solid rgba(205,214,228,0.25);
  border-radius: 5px;
  padding: 5px 12px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
#npc-chat-panel .npc-send:disabled { opacity: 0.35; cursor: default; }
#npc-chat-panel .hint {
  font-size: 11px;
  opacity: 0.45;
  margin-top: 2px;
}
`;

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = CHAT_CSS;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Stub reply generator (?director=off deterministic path)
// ---------------------------------------------------------------------------

const ROLE_GREETINGS: Record<NpcRole, string> = {
  farmer:   "Mornin'. Got fresh produce straight from the field.",
  villager: "Oh! A traveller. Haven't seen many folk around here lately.",
  merchant: "Welcome, welcome! Finest wares in the region, and I mean it.",
  guard:    "Halt. State your business in this settlement.",
};

const ROLE_GENERIC: Record<NpcRole, string[]> = {
  farmer: [
    "The soil's been dry this season. Makes a farmer worry.",
    "Harvest's coming up — can't complain about that.",
    "Hard work feeds a settlement, that's what I say.",
  ],
  villager: [
    "Heard there's strange lights in the old dungeon to the north.",
    "Life here's quiet. Too quiet some nights, if you know what I mean.",
    "These tools you're carrying — good quality. Where'd you find 'em?",
  ],
  merchant: [
    "A good deal benefits everyone involved — that's my philosophy.",
    "I've traveled far with these goods. Fair price for fair quality.",
    "Supply and demand, friend. The world runs on it.",
  ],
  guard: [
    "Keep your weapons sheathed inside the walls.",
    "We've had reports of wolves near the outer farms. Stay alert.",
    "Move along, traveller. Unless you need something.",
  ],
};

/** Greetings for a traveller the NPC has met before. */
const ROLE_MET_GREETINGS: Record<NpcRole, string> = {
  farmer:   "Back again, traveller? Fields don't tend themselves, so make it quick.",
  villager: 'Oh, you again! Good to see a familiar face around here.',
  merchant: 'Ah, my favourite customer returns! What will it be today?',
  guard:    'You again. Keep out of trouble and we will have no problems.',
};

/** Generate a guard-specific stub reply when the player has a bounty. */
function guardBountyReply(bounty: number): string {
  return `Halt! You have a bounty of ${bounty} gold in this settlement. Pay up, submit to arrest, or face the consequences.`;
}

/** Parse "buy <item>" from player text and return the item substring. */
function parseBuyRequest(text: string): string | null {
  const m = text.toLowerCase().match(/\bbuy\s+(\w+(?:[_\s]\w+)?)/);
  return m ? m[1].replace(/\s+/g, '_') : null;
}

/** Parse "sell [N] <item>" from player text. Returns { item, count } or null. */
function parseSellRequest(text: string): { item: string; count: number } | null {
  // "sell 3 hide" or "sell hide"
  const m = text.toLowerCase().match(/\bsell\s+(?:(\d+)\s+)?(\w+(?:[_\s]\w+)?)/);
  if (m === null) return null;
  const count = m[1] !== undefined ? Math.max(1, parseInt(m[1], 10)) : 1;
  const item = m[2].replace(/\s+/g, '_');
  return { item, count };
}

const NON_BUYER_DECLINE: Record<NpcRole, string> = {
  villager: "I'm not in the market for goods, friend. Try the merchant.",
  guard:    "I don't buy things — keep moving.",
  merchant: '', // handled separately
  farmer:   '', // handled separately
};

/**
 * Generate a deterministic stub reply for ?director=off mode.
 * Handles "buy <item>", "sell [N] <item>", and generic fallback lines.
 */
export function stubReply(
  persona: NpcPersona,
  userText: string,
  stock: CatalogEntry[],
  npcGold = 0,
): string {
  // First message → greeting; guards with bounty issue a warning.
  if (userText.trim() === '__greeting__') {
    if (persona.role === 'guard' && persona.playerBounty > 0) {
      return guardBountyReply(persona.playerBounty);
    }
    return ROLE_GREETINGS[persona.role];
  }

  // Guard with active bounty → always remind of bounty obligation.
  if (persona.role === 'guard' && persona.playerBounty > 0) {
    return guardBountyReply(persona.playerBounty);
  }

  // Threats and insults have consequences — retort + action JSON.
  const threat = detectThreat(userText);
  if (threat !== null) {
    if (persona.role === 'guard') {
      return `You dare threaten a guard of ${persona.settlement}? You will regret that.\n` +
        `{"action":"hostile","reason":"threatened a guard"}`;
    }
    if (persona.role === 'merchant') {
      return `G-guards! Stay back — I want no trouble!\n` +
        `{"action":"afraid","reason":"player threatened me"}`;
    }
    // Farmers and villagers stand their ground.
    return threat === 'threat'
      ? `You will not lay a hand on me or mine! Get out!\n` +
        `{"action":"hostile","reason":"player threatened me"}`
      : `Say that again and you will regret it!\n` +
        `{"action":"hostile","reason":"player insulted me"}`;
  }

  // Romance: proposals and flirting (Phase N6).
  const flirt = detectFlirt(userText);
  if (flirt !== null) {
    const romance = persona.romance ?? 0;
    if (persona.spouse === true) {
      return flirt === 'proposal'
        ? `We are already wed, my love — and I would say yes all over again.`
        : `Flattery, from my own spouse? Come here, you.`;
    }
    if (flirt === 'proposal') {
      return romance >= ROMANCE_ACCEPT_AT
        ? `Yes... yes! I have hoped you would ask. I am yours.\n` +
          `{"action":"accept_proposal"}`
        : `Oh! You flatter me, but... I hardly know you yet. Court me a while longer.\n` +
          `{"action":"reject_proposal"}`;
    }
    // Flirt: receptive unless the NPC dislikes the player.
    if ((persona.disposition ?? 0) < 0) {
      return `Hmph. Sweet words won't mend what you've done.`;
    }
    const FLIRT_LINES = [
      `Oh — you have a silver tongue, traveller.`,
      `*blushes* Go on with you... though I don't mind hearing it.`,
      `You say that to all the ${persona.gender === 'female' ? 'women' : 'men'} in ${persona.settlement}, I'm sure.`,
      `Careful, or you'll turn my head clean around.`,
    ];
    let fh = 0x811c9dc5 >>> 0;
    for (let i = 0; i < userText.length; i++) {
      fh ^= userText.charCodeAt(i);
      fh = Math.imul(fh, 0x01000193) >>> 0;
    }
    return `${FLIRT_LINES[fh % FLIRT_LINES.length]}\n{"action":"charmed"}`;
  }

  // Companion: follow / stay requests (Phase N8).
  if (persona.following === true && detectStayRequest(userText)) {
    return `As you wish. I'll be here if you need me.\n{"action":"stay"}`;
  }
  if (persona.following !== true && detectFollowRequest(userText)) {
    if (persona.role === 'guard') {
      return `My post is here, traveller. I cannot wander off while on duty.`;
    }
    const trusts = persona.spouse === true ||
      (persona.disposition ?? 0) >= FOLLOW_TRUST_AT;
    return trusts
      ? `Aye, lead the way — I could do with stretching my legs.\n{"action":"follow"}`
      : `Hm. I hardly know you, traveller. Earn my trust first.`;
  }

  // Hospitality: "can I come in / shelter" requests (Phase N9).
  if (persona.insideHome !== true && detectHomeRequest(userText)) {
    if (persona.role === 'guard') {
      return `The guardhouse is no inn, traveller. Try a villager's hearth.`;
    }
    const welcomes = persona.spouse === true ||
      (persona.disposition ?? 0) >= FOLLOW_TRUST_AT;
    return welcomes
      ? `Of course — come in, warm yourself by the hearth.\n{"action":"invite_home"}`
      : `I don't let strangers under my roof. No offense meant.`;
  }

  // "buy <item>" → trade offer at list price.
  const wantItem = parseBuyRequest(userText);
  if (wantItem !== null) {
    const entry = stock.find(
      (e) => e.id === wantItem || e.id.includes(wantItem) || wantItem.includes(e.id),
    );
    if (entry !== null && entry !== undefined && entry.stock > 0) {
      return (
        `Sure, I can sell you 1 ${entry.id} for ${entry.price} gold.\n` +
        `{"trade":{"give":{"id":"${entry.id}","count":1},"want":{"id":"gold_small","count":${entry.price}}}}`
      );
    }
    return `Sorry, I don't carry that. My stock is limited right now.`;
  }

  // "sell [N] <item>" → sell offer (NPC buys from player).
  const sellReq = parseSellRequest(userText);
  if (sellReq !== null) {
    const { item, count } = sellReq;

    // Non-buyers decline in character.
    if (persona.role === 'villager' || persona.role === 'guard') {
      return NON_BUYER_DECLINE[persona.role];
    }

    // Find matching SELL_PRICES entry by id or fuzzy substring.
    const matchedId = (Object.keys(SELL_PRICES) as Array<keyof typeof SELL_PRICES>).find(
      (id) => id === item || id.includes(item) || item.includes(id),
    );

    if (matchedId === undefined) {
      return `I'm not interested in buying that.`;
    }

    const fairPrice = SELL_PRICES[matchedId]!;
    const offerGold = Math.max(1, fairPrice * count);

    // Check NPC gold pool.
    if (offerGold > npcGold) {
      return `I'd love to buy your ${matchedId}, but I don't have enough coin right now.`;
    }

    // Farmer role filter.
    const FARMER_BUY_IDS: ReadonlySet<string> = new Set([
      'hide', 'leather', 'meat_raw', 'meat_cooked',
      'feather', 'bone', 'wool', 'egg_bird', 'flax', 'gourd',
    ]);
    if (persona.role === 'farmer' && !FARMER_BUY_IDS.has(matchedId)) {
      return `I'm a farmer — I don't have much use for ${matchedId}.`;
    }

    return (
      `I'll take ${count} ${matchedId} off your hands for ${offerGold} gold.\n` +
      `{"trade":{"give":{"id":"gold_small","count":${offerGold}},"want":{"id":"${matchedId}","count":${count}}}}`
    );
  }

  // Generic lines — pick by hash of user text.
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < userText.length; i++) {
    h ^= userText.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const lines = ROLE_GENERIC[persona.role];
  return lines[h % lines.length];
}

// ---------------------------------------------------------------------------
// Chat panel state (one active panel)
// ---------------------------------------------------------------------------

export interface NpcChatState {
  open: boolean;
  npcId: string | null;
  /** The stockKey (settlementName::npcId) for the active NPC, or null. */
  activeStockKey: string | null;
  lastReply: string | null;
  pendingOffer: TradeOffer | null;
}

// Module-level state so __gameDebug can read it.
const _state: NpcChatState = {
  open: false,
  npcId: null,
  activeStockKey: null,
  lastReply: null,
  pendingOffer: null,
};

export function chatState(): Readonly<NpcChatState> { return _state; }

// ---------------------------------------------------------------------------
// LLM transport — reuses same createGGUFInferenceSession as Director
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __NPC_CHAT_MOCK__?: (messages: ChatMessage[]) => string | Promise<string>;
  }
}

export type NpcChatFn = (
  messages: ChatMessage[],
  onToken?: (chunk: string) => void,
) => Promise<string>;

/**
 * Selectable NPC dialogue models. Pick with `?npcllm=<key>`.
 *
 * `fast` (the shipped default) and `default` are the SAME stock Qwen3-1.7B
 * Q4_K_M, ~1.11 GB, Apache-2.0 — which is also what the Dungeon Director runs
 * (director.ts). One model serves both, the session dedups on `repo::file`, so
 * the pair costs one download and one set of resident weights.
 *
 * `large`: stock Qwen3-4B-Instruct-2507 Q4_K_M, ~2.50 GB, same licence, same
 * ChatML template — a size/quality dial on an identical integration. Measured
 * far better at the control-JSON contract; see scripts/test-npc-live.mts.
 *
 * `abliterated`: mlabonne's abliterated Qwen3-4B — comparison only, never a
 * default. See the note on that key.
 *
 * All dense qwen3 arch — supported by the GGUF session (no hybrid layers).
 * Local hf-cache first, HF CDN fallback.
 */
export const NPC_MODELS = {
  /**
   * Shipping default: STOCK Qwen3-1.7B, Apache-2.0, ~1.11 GB.
   *
   * Replaced `mradermacher/Qwen3-1.7B-abliterated-GGUF` for two independent
   * reasons that happen to point the same way (docs/AI_MODEL_LICENSING.md):
   *
   * - **Licence.** Apache-2.0 with no cap, no MAU threshold, no acceptable-use
   *   policy and no gating, declared on the checkpoint itself rather than
   *   inherited through a chain of community re-uploads. Note that the licence
   *   that matters is the one on the artefact actually shipped: several
   *   derivative GGUF repos in this space ship no licence file at all.
   * - **Safety.** An abliterated model has had its refusal direction removed
   *   from the weights, which made the content filter in npc/content-safety.ts
   *   the *only* thing between a crafted prompt and its output. A stock
   *   instruction-tuned model restores a layer of trained refusal underneath
   *   it. See docs/AI_GUARDRAILS.md.
   *
   * The game's mature tone does NOT depend on abliteration — it comes from the
   * system prompt, which tells the model adult subjects are open and that it
   * must not moralise. Stock Qwen3 follows that instruction perfectly well.
   */
  fast: {
    repo: 'unsloth/Qwen3-1.7B-GGUF',
    file: 'Qwen3-1.7B-Q4_K_M.gguf',
    emptyThink: true,
  },
  /**
   * Smarter/slower stock 4B, same licence and ChatML template. `?npcllm=large`.
   *
   * `emptyThink: false` is load-bearing, not a preference. Qwen3-4B-Instruct-2507
   * is a NON-thinking checkpoint: its template has no `enable_thinking` branch
   * and it was never trained to see `<think>\n\n</think>\n\n` after the
   * assistant header. Feeding it one makes it emit `<|im_end|>` immediately —
   * measured, an empty string with stopReason 'eos' on a prompt the same model
   * answers correctly with the block removed (scripts/test-npc-live.mts).
   */
  large: {
    repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF',
    file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    emptyThink: false,
  },
  /**
   * Alias of `fast` — the model the Director already has resident, so talking
   * to an NPC costs no second download and no second cold start.
   *
   * This key is also the code-level fallback (`npcModel ?? 'default'`, and
   * preloadNpcChat's parameter default), which is exactly why it must not point
   * anywhere else: it used to resolve to `local/flux2-te-qwen3-4b-q4_k_m`, an
   * unlabelled checkpoint with no licence field, meaning any call site that
   * forgot to pass a model key silently loaded an unlicensed artefact. Keep
   * this pointed at the same GGUF as `fast`.
   */
  default: {
    repo: 'unsloth/Qwen3-1.7B-GGUF',
    file: 'Qwen3-1.7B-Q4_K_M.gguf',
    emptyThink: true,
  },
  /**
   * Abliterated 4B, kept behind `?npcllm=abliterated` for comparison only.
   * NOT shippable as a default: the upstream GGUF declares no licence, and
   * removing refusal behaviour is the opposite of what the Steam Content
   * Survey asks about. Do not make this the default without reading
   * docs/AI_GUARDRAILS.md.
   */
  abliterated: {
    repo: 'bartowski/mlabonne_Qwen3-4B-abliterated-GGUF',
    file: 'mlabonne_Qwen3-4B-abliterated-Q4_K_M.gguf',
    emptyThink: true,
  },
} as const;

export type NpcModelKey = keyof typeof NPC_MODELS;

// ---------------------------------------------------------------------------
// AI disclosure (EU AI Act Art. 50)
// ---------------------------------------------------------------------------

/** Storage key for "the player has seen the first-run AI notice". */
export const AI_DISCLOSURE_KEY = 'artifex-ai-disclosure:v1';

/**
 * The first-run notice. Written to be read by a player rather than a lawyer —
 * a policy paragraph in a speech-bubble UI gets dismissed unread, which would
 * defeat the point of showing it.
 *
 * It states the three things that actually matter: the dialogue is generated,
 * it is generated on this machine (so the player knows nothing is being sent
 * anywhere), and it can be wrong or offensive because nothing is scripted.
 */
export const AI_DISCLOSURE_TEXT =
  'These villagers are not scripted. Everything they say is written on the fly '
  + 'by an AI model running on your own machine — nothing you type is sent '
  + 'anywhere. It can be strange, wrong, or say things no one wrote or intended. '
  + 'You are talking to software, not a person.';

/** True once the first-run notice has been shown on this browser profile. */
export function aiDisclosureSeen(): boolean {
  try {
    return localStorage.getItem(AI_DISCLOSURE_KEY) !== null;
  } catch {
    // Private mode / storage disabled: show it every session rather than never.
    return false;
  }
}

/** Record that the notice has been shown. Failure is non-fatal by design. */
export function markAiDisclosureSeen(): void {
  try {
    localStorage.setItem(AI_DISCLOSURE_KEY, String(Date.now()));
  } catch { /* storage unavailable — the notice simply shows again */ }
}

export function isNpcModelKey(x: string): x is NpcModelKey {
  return Object.prototype.hasOwnProperty.call(NPC_MODELS, x);
}

/** Build a streaming chat function backed by the game's GPU session. */
async function buildLiveChatFn(
  gpu: import('../../engine/gpu-device').GPUContext,
  modelKey: NpcModelKey,
): Promise<NpcChatFn> {
  // Dynamic import keeps the cost zero when NPC chat is never used.
  const { createGGUFInferenceSession } = await import('../../engine/gguf-session');
  const { useLocalCache } = await import('../../model/hf-hub');
  useLocalCache();

  const model = NPC_MODELS[modelKey];
  console.log(`[NPC chat] model '${modelKey}': ${model.repo}/${model.file}`);

  const session = await createGGUFInferenceSession({
    repo: model.repo,
    ggufFile: model.file,
    gpu,
    onStatus: () => { /* no UI hook needed here */ },
  });

  // Private KV fork: the dedup'd shared session's default KV is also used by
  // the Dungeon/Ecology directors, so any background generation between chat
  // turns evicted the conversation prefix → a full ~1000-token re-prefill
  // (30-45 s measured) on EVERY turn. A fork keeps the chat prefix resident;
  // turns prefill only the new tokens.
  const ctx: ForkedChatContext = session.forkKV !== undefined ? session.forkKV() : session;
  _chatCtx = ctx;
  _chatEmptyThink = model.emptyThink;
  // Start on the shared part of every villager's prompt straight away. The
  // model is resident and the player is, by construction, still walking — this
  // is the cheapest GPU time in the session.
  warmNpcPreamble(ctx);

  return async (messages: ChatMessage[], onToken?: (chunk: string) => void) => {
    // Marathon-conversation guard: the attention kernel rejects prompts at or
    // above 2048 tokens (generate.ts throws → this chat would silently fall
    // back to stub forever). Estimate ~3.5 chars/token and drop whole
    // user+assistant pairs, keeping the system prompt.
    //
    // Trimming to exactly the budget is the obvious implementation and it is a
    // performance trap. Any dropped pair shifts every token after the system
    // prompt, so the KV cache stops being a prefix of the new prompt and the
    // turn pays a FULL re-prefill. Trim-to-the-line means the conversation sits
    // permanently at the budget and re-prefills on every single turn from then
    // on. Measured: turns 1-6 took 240-714 ms TTFT, and from turn 7 — the first
    // trimmed turn — every turn cost 16.5-19.3 s, against a 20 s watchdog that
    // then serves the player a canned line for the rest of the conversation.
    //
    // So trim down to a LOW-WATER mark instead. The next few turns fit under
    // the budget without trimming and extend the cache normally, which turns a
    // per-turn stall into one stall every few turns.
    const PROMPT_CHAR_BUDGET = 1600 * 3.5;
    const PROMPT_CHAR_LOW_WATER = PROMPT_CHAR_BUDGET * 0.6;
    let msgs = messages;
    const chars = (m: ChatMessage[]) => m.reduce((n, x) => n + x.content.length, 0);
    if (chars(msgs) > PROMPT_CHAR_BUDGET) {
      while (msgs.length > 3 && chars(msgs) > PROMPT_CHAR_LOW_WATER) {
        msgs = [msgs[0], ...msgs.slice(3)];
      }
    }
    // Serialize against any in-flight warm prefill on the same fork — but cut
    // it short first. The player has spoken; finishing a speculative prefill
    // ahead of them is exactly backwards, and the partial cache it leaves is
    // still a valid prefix for this turn to extend.
    cancelNpcWarm();
    const prior = _genChain;
    let release!: () => void;
    _genChain = new Promise<void>((r) => { release = r; });
    try {
      await prior.catch(() => { /* prior failures don't block this turn */ });
      let sawToken = false;
      const handle = ctx.chat(
        msgs,
        // Livelier roleplay sampling. Mild in-call repetition penalty only —
        // DRY/minP are deliberately off (documented word-chain collapse, see
        // generate.ts sampler-default notes).
        // 320 tokens: room for a real, human-length reply — conversations may
        // go anywhere, so answers must not be clipped mid-thought.
        { temperature: 0.9, topP: 0.95, repetitionPenalty: 1.1, maxNewTokens: 320 },
        (chunk: string) => {
          sawToken = true;
          onToken?.(chunk);
        },
        { enableThinking: false, emptyThink: model.emptyThink, prefillChunk: NPC_PREFILL_CHUNK },
      );
      // TTFT watchdog: if no token arrives within the deadline (GPU
      // contention, pathological prefill), abort and throw — the caller's
      // stub fallback answers instead. The game never waits on the LLM.
      const timer = setTimeout(() => { if (!sawToken) handle.abort(); }, NPC_TTFT_DEADLINE_MS);
      try {
        const r = await handle.result;
        // An aborted turn is never a usable reply, even when it is not empty.
        // abort() is not instantaneous: the decode step already on the GPU
        // still lands, so a watchdog firing at the exact moment the first
        // token arrives returns ONE token. Testing against the real game
        // produced NPCs whose entire answer was `*` — the opening character of
        // a `*wipes hands on apron*` gesture — shown to the player as dialogue,
        // because the old check only rejected the empty string.
        //
        // Anything this short is a fragment, not an answer; throwing hands the
        // turn to the canned reply, which is at least a whole sentence.
        if (r.stopReason === 'aborted' && stripNpcJson(r.text).trim().length < 20) {
          throw new Error('NPC chat: aborted with no usable text (TTFT watchdog)');
        }
        return r.text;
      } finally {
        clearTimeout(timer);
      }
    } finally {
      release();
    }
  };
}

/** Abort a chat turn that has produced no token after this long — the stub
 *  reply takes over so the conversation never stalls. Streaming replies are
 *  unaffected once the first token lands. */
const NPC_TTFT_DEADLINE_MS = 20_000;

/**
 * Prefill chunk for every NPC generation, warm or real.
 *
 * Two independent reasons, both measured, and they agree for once:
 *
 * - **Smoothness.** A prefill chunk is one GPU submission that the renderer
 *   waits behind. At the engine default of 512 a chunk is ~4 s of GPU on a
 *   ~1,500-token prompt; at 64 it is well under a second, so a warm prefill
 *   running while the player walks costs frame rate instead of a stall. This is
 *   the same call the Dungeon Director already made (DIRECTOR_PREFILL_CHUNK).
 * - **Speed.** Smaller chunks are also *faster* here: sweeping the chunk over a
 *   fixed 934-token prompt gave 123 tok/s at 64 against 100 tok/s at 512.
 *
 * Do NOT raise this above the engine's activation-buffer width (512). Larger
 * chunks do not error — they silently produce wrong output. generate.ts clamps
 * it now, but the clamp is a backstop, not a licence.
 */
const NPC_PREFILL_CHUNK = 64;

// Cached chat function (lazily initialized, stays resident for the whole
// session — the model is never unloaded between conversations).
let _liveChatFn: NpcChatFn | null = null;
let _chatFnBuilding = false;
/** NPC chat's private KV fork (set by buildLiveChatFn; null until loaded). */
let _chatCtx: ForkedChatContext | null = null;
/**
 * Whether the loaded model needs the empty `<think></think>` preamble. Mirrors
 * NPC_MODELS[key].emptyThink and is set by buildLiveChatFn, because
 * warmNpcChat() is module-level and has no model key of its own — and the warm
 * prefill MUST render the same preamble as the real turns or the cached tokens
 * stop being a strict prefix and every turn pays a full re-prefill.
 */
let _chatEmptyThink = true;
/** Serializes generate() calls on the fork (warm prefill vs. chat turns). */
let _genChain: Promise<unknown> = Promise.resolve();
/** In-flight warm prefill, so a real turn can cut in front of it. */
let _warmHandle: { abort(): void } | null = null;

/**
 * Warm-prefill the NPC's system prompt into the chat KV fork while the player
 * reads the canned greeting and types their first message. Rendered WITHOUT
 * the assistant generation preamble (addGenerationPrompt: false) so the
 * cached tokens are a strict prefix of the real turn-1 prompt — turn 1 then
 * prefills only the player's message instead of ~1000 system-prompt tokens.
 * No-op until the live model is loaded; errors are swallowed (best-effort).
 *
 * Safe to call speculatively (e.g. when the player walks up to an NPC): the
 * only cost of warming the wrong villager is GPU time the player was not
 * waiting on, and a real turn aborts it (see cancelNpcWarm).
 */
export function warmNpcChat(persona: NpcPersona): void {
  const ctx = _chatCtx;
  if (ctx === null) return;
  const prior = _genChain;
  let release!: () => void;
  _genChain = new Promise<void>((r) => { release = r; });
  void (async () => {
    try {
      await prior.catch(() => { /* prior failures don't block the warm */ });
      const handle = ctx.chat(
        [{ role: 'system', content: buildNpcSystemPrompt(persona) }],
        // Greedy 1-token: rides the cheap GPU-argmax path, and the sampled
        // token never enters the KV cache — the cache ends exactly at the
        // prompt, keeping the strict-prefix invariant.
        { temperature: 0, topP: 1, repetitionPenalty: 1.0, maxNewTokens: 1 },
        undefined,
        { enableThinking: false, emptyThink: _chatEmptyThink, addGenerationPrompt: false,
          prefillChunk: NPC_PREFILL_CHUNK },
      );
      _warmHandle = handle;
      await handle.result;
    } catch { /* warm is best-effort */ } finally {
      _warmHandle = null;
      release();
    }
  })();
}

/**
 * Cut a warm prefill short because the player has actually said something.
 *
 * The warm is a ~9 s prefill of the whole system prompt, and turns queue behind
 * it — so a player who read the greeting quickly used to wait out the tail of a
 * prefill that existed to save them time. Aborting is now strictly a win: the
 * engine keeps the chunks it already forwarded (generate.ts, prefill-abort
 * path), so the real turn extends that partial cache rather than restarting.
 * Nothing to undo if no warm is running.
 */
export function cancelNpcWarm(): void {
  _warmHandle?.abort();
  _warmHandle = null;
}

/** Last NPC warmed on approach — so walking past one does not re-warm it. */
let _warmedNpcId: string | null = null;

/**
 * Warm the prompt for an NPC the player is walking TOWARD, before they press E.
 *
 * The panel already warms on open, but a player who reads the greeting quickly
 * still overtakes a ~1,500-token prefill; approaching starts it several seconds
 * earlier, which is exactly the window that was missing. Call it from the game
 * loop with whatever is cheaply to hand — it deliberately takes loose facts
 * rather than a built NpcPersona, because assembling the real one has side
 * effects (it advances the village gossip) that must not fire just because
 * somebody walked past.
 *
 * A partial persona prefills a genuine PREFIX of the real prompt: the sections
 * are ordered so the universal rules, the character card and the role contract
 * all come before anything this cannot know, and the engine keeps the common
 * prefix. Passing `disposition` and `following` when they are known pushes the
 * match further down, through the follow/hospitality/romance rules.
 *
 * Idempotent per NPC, and cheap to be wrong about: an unused warm costs GPU
 * time the player was not waiting on, and the next real turn aborts it.
 */
export function warmNpcApproach(npc: {
  id: string;
  name: string;
  role: NpcRole;
  settlement: string;
  playerBounty?: number;
  disposition?: number;
  following?: boolean;
}): void {
  if (_chatCtx === null || _warmedNpcId === npc.id) return;
  _warmedNpcId = npc.id;
  cancelNpcWarm();
  warmNpcChat({
    role: npc.role,
    name: npc.name,
    settlement: npc.settlement,
    playerBounty: npc.playerBounty ?? 0,
    gender: npcGenderFor(npc.name),
    quirk: npcQuirkFor(npc.id),
    disposition: npc.disposition,
    following: npc.following,
  });
}


/**
 * Prefill the block of the system prompt that every NPC in the game shares
 * (npc-prompt.ts UNIVERSAL_PREAMBLE — world, conversation rules, consequences),
 * as soon as the model is resident.
 *
 * It is ~450 of the ~1,500 tokens of a loaded villager's prompt and it is the
 * same tokens for all of them, so paying for it once at load turns the first
 * conversation of a session — the only one with nothing at all in the cache —
 * from a cold prefill into a warm one. Measured: that first turn was the last
 * remaining multi-second wait after everything else here landed.
 *
 * The cached run ends in `<|im_end|>` where the real prompt continues into the
 * character card, so this is not a strict prefix; it relies on the engine
 * keeping the common prefix and re-prefilling from the divergence (generate.ts
 * KV rewind) rather than on an exact match.
 */
function warmNpcPreamble(ctx: ForkedChatContext): void {
  const prior = _genChain;
  let release!: () => void;
  _genChain = new Promise<void>((r) => { release = r; });
  void (async () => {
    try {
      await prior.catch(() => { /* prior failures don't block the warm */ });
      const handle = ctx.chat(
        [{ role: 'system', content: UNIVERSAL_PREAMBLE }],
        { temperature: 0, topP: 1, repetitionPenalty: 1.0, maxNewTokens: 1 },
        undefined,
        { enableThinking: false, emptyThink: _chatEmptyThink, addGenerationPrompt: false,
          prefillChunk: NPC_PREFILL_CHUNK },
      );
      _warmHandle = handle;
      await handle.result;
    } catch { /* best-effort */ } finally {
      _warmHandle = null;
      release();
    }
  })();
}

/**
 * Warm-load the NPC chat model in the background so the first conversation
 * doesn't pay the multi-second weight upload mid-chat. Safe to call
 * repeatedly; errors are swallowed (first talk falls back to lazy load /
 * stub exactly as before).
 */
export async function preloadNpcChat(
  gpu: import('../../engine/gpu-device').GPUContext,
  npcModel: NpcModelKey = 'default',
): Promise<boolean> {
  if (_liveChatFn !== null) return true;
  if (_chatFnBuilding) return false;
  if (typeof window.__NPC_CHAT_MOCK__ === 'function') return true;
  _chatFnBuilding = true;
  try {
    _liveChatFn = await buildLiveChatFn(gpu, npcModel);
    return true;
  } catch (err) {
    console.warn('[NPC chat] preload failed (will retry on first talk):', err);
    return false;
  } finally {
    _chatFnBuilding = false;
  }
}

// ---------------------------------------------------------------------------
// Panel builder
// ---------------------------------------------------------------------------

export interface NpcChatPanelOptions {
  persona: NpcPersona;
  npcId: string;
  settlementName: string;
  /** Current player inventory for gold checks. */
  inventory: Inventory;
  /** Save inventory callback. */
  onInvChanged: () => void;
  /** Panel manager — to close on Esc. */
  panels: PanelManager;
  /** Stub mode: no LLM calls. */
  stubMode: boolean;
  /** GPU context for live LLM (ignored in stub mode). */
  gpu?: import('../../engine/gpu-device').GPUContext;
  /** NPC dialogue model choice (default: shared Director model). */
  npcModel?: NpcModelKey;
  /** Per-run stock map (mutated in-place and persisted). */
  stockMap: StockMap;
  /** Per-run NPC memory map (mutated in-place and persisted). */
  memoryMap: MemoryMap;
  /** Fired when the NPC turns hostile / afraid / ends the conversation. */
  onNpcAction?: (npcId: string, action: NpcActionKind) => void;
  /**
   * Override for the opening greeting (Phase N4 — NPC-initiated dialogue,
   * e.g. a guard questioning a newcomer). Ignored for bounty guards.
   */
  openingLine?: string;
}

export function buildNpcChatPanel(opts: NpcChatPanelOptions): HTMLElement {
  injectCss();

  const {
    persona, npcId, settlementName, inventory, onInvChanged,
    panels, stubMode, gpu, npcModel, stockMap, memoryMap, onNpcAction,
    openingLine,
  } = opts;

  // Get or initialize mutable record for this NPC.
  const sk = stockKey(settlementName, npcId);
  if (stockMap[sk] === undefined) {
    // Deep-clone catalog so mutations don't corrupt the source; assign starting gold.
    stockMap[sk] = {
      catalog: TRADE_CATALOG[persona.role].map((e) => ({ ...e })),
      gold: GOLD_POOL_START[persona.role],
      lastRegenMs: Date.now(),
    };
  } else {
    // Apply lazy regen on open.
    const rec = stockMap[sk];
    const cap = GOLD_POOL_START[persona.role];
    const nowMs = Date.now();
    const regenned = regenGold(rec.gold, rec.lastRegenMs, cap, nowMs);
    const regennedStock = regenStock(rec.catalog, TRADE_CATALOG[persona.role], rec.lastRegenMs, nowMs);
    const changed = regenned !== rec.gold || regennedStock !== rec.catalog;
    if (changed) {
      rec.gold = regenned;
      rec.catalog = regennedStock;
      rec.lastRegenMs = nowMs;
    }
  }
  const currentRecord = stockMap[sk];
  const currentStock: CatalogEntry[] = currentRecord.catalog;

  /** Disposition a single conversation can add, however long it runs. */
  const WARMTH_PER_CONVERSATION = 6;
  /** How much this conversation has already granted. */
  let sessionWarmth = 0;

  // Persist the (potentially freshly-initialised or regen'd) record immediately.
  saveStockMap(stockMap);

  // ---- Persistent memory (Phase N1) ---------------------------------------
  const memRec = getOrCreateMemory(memoryMap, sk);
  const wasMet = memRec.met;
  const tone = dispositionTone(memRec.disposition);
  const refusesChat = memRec.disposition < REFUSE_CHAT_BELOW;
  memRec.met = true;
  memRec.lastTalkMs = Date.now();
  saveMemoryMap(memoryMap);

  // Inject memory into the persona so prompt building sees it.
  persona.disposition = memRec.disposition;
  persona.met = wasMet;
  persona.memoryFacts = [...memRec.facts];
  // Romance (Phase N6): gender is name-derived; romance/spouse persist.
  persona.gender = npcGenderFor(persona.name);
  persona.romance = memRec.romance;

  // Live trade context. All three of these existed in the game and none of
  // them reached the model, which is why NPC conversation felt thin: every
  // merchant recited the same static role catalogue, none of them knew what
  // they had actually sold, and none could see that the traveller was carrying
  // forty pelts and a sack of ore.
  persona.stock = currentStock
    .map((e) => ({ id: e.id, price: e.price, count: e.stock }));
  persona.gold = currentRecord.gold;
  // What this NPC would buy, priced from SELL_PRICES, capped at what they can
  // actually pay. Sorted by value so a short list leads with the good stuff.
  {
    const seen = new Map<string, number>();
    for (const slot of [...inventory.pack, ...inventory.hotbar]) {
      if (slot === null) continue;
      if (slot.id === 'gold_small') continue; // nobody buys your money
      const price = SELL_PRICES[slot.id];
      if (price === undefined) continue;
      seen.set(slot.id, (seen.get(slot.id) ?? 0) + slot.count);
    }
    persona.playerWares = [...seen.entries()]
      .map(([id, count]) => ({ id, price: SELL_PRICES[id as GameItemId] ?? 0, count }))
      .filter((w) => w.price > 0)
      .sort((a, b) => b.price * b.count - a.price * a.count)
      .slice(0, 8); // keep the prompt short; the model only needs the highlights
  }
  persona.spouse = memRec.spouse;

  /** Persist a remembered fact (with optional disposition shift). */
  function remember(fact: string, dispositionDelta = 0): void {
    addFact(memRec, fact);
    if (dispositionDelta !== 0) adjustDisposition(memRec, dispositionDelta);
    saveMemoryMap(memoryMap);
  }

  // Update state.
  _state.open = true;
  _state.npcId = npcId;
  _state.activeStockKey = sk;
  _state.lastReply = null;
  _state.pendingOffer = null;

  // Conversation history (excludes system; includes user+assistant pairs).
  const history: ChatMessage[] = [];

  // ---- DOM scaffold -------------------------------------------------------
  const el = document.createElement('div');
  el.id = 'npc-chat-panel';

  const header = document.createElement('div');
  header.className = 'npc-header';
  header.textContent = persona.name;
  header.dataset.npcName = persona.name;
  el.appendChild(header);

  const roleEl = document.createElement('div');
  roleEl.className = 'npc-role';
  const genderWord = persona.gender.charAt(0).toUpperCase() + persona.gender.slice(1);
  roleEl.textContent = `${genderWord} ${persona.role} · ${settlementName}`;
  el.appendChild(roleEl);

  // Two-column body: chat on the left, trade menu on the right (Phase N3).
  const cols = document.createElement('div');
  cols.className = 'npc-columns';
  el.appendChild(cols);

  const chatCol = document.createElement('div');
  chatCol.className = 'npc-chat-col';
  cols.appendChild(chatCol);

  const historyEl = document.createElement('div');
  historyEl.className = 'npc-history';
  historyEl.id = 'npc-chat-history';
  chatCol.appendChild(historyEl);

  const inputRow = document.createElement('div');
  inputRow.className = 'npc-input-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'npc-input';
  input.placeholder = 'Say something…';
  input.id = 'npc-chat-input';
  const sendBtn = document.createElement('button');
  sendBtn.className = 'npc-send';
  sendBtn.textContent = 'Send';
  sendBtn.id = 'npc-chat-send';
  inputRow.appendChild(input);
  inputRow.appendChild(sendBtn);
  chatCol.appendChild(inputRow);

  const hint = document.createElement('div');
  hint.className = 'hint';
  // AI disclosure. EU AI Act Article 50(1) (applicable 2 August 2026) requires
  // people be informed they are interacting with an AI system unless it is
  // obvious from context. A talking villager in a fantasy game is arguably
  // obvious, but "arguably" is not a compliance position, and the line costs
  // nothing. See docs/AI_MODEL_LICENSING.md.
  hint.textContent = 'Enter to send  ·  Esc to close  ·  replies are AI-generated';
  chatCol.appendChild(hint);

  const tradeCol = document.createElement('div');
  tradeCol.id = 'npc-trade-column';
  cols.appendChild(tradeCol);

  // ---- Helpers ------------------------------------------------------------

  function scrollBottom(): void {
    historyEl.scrollTop = historyEl.scrollHeight;
  }

  function appendMsg(role: 'user' | 'assistant' | 'system' | 'thinking', text: string): HTMLElement {
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    div.textContent = text;
    historyEl.appendChild(div);
    scrollBottom();
    return div;
  }

  /** Append an NPC reply bubble with control JSON stripped (skip if empty). */
  function appendReply(rawReply: string): void {
    const shown = stripNpcJson(rawReply);
    if (shown !== '') appendMsg('assistant', shown);
  }

  // ---- Trade execution (shared by offer cards and trade-column buttons) ----

  /** Execute a buy (player pays gold, receives item). Returns error text or null. */
  function executeBuy(offer: TradeOffer): string | null {
    const goldHave = countItem(inventory, 'gold_small');
    if (goldHave < offer.want.count) {
      return `Not enough gold. You have ${goldHave} gold, need ${offer.want.count}.`;
    }
    removeItem(inventory, 'gold_small', offer.want.count);
    addItem(inventory, offer.give.id, offer.give.count);
    onInvChanged();

    // Decrement persistent stock (sync currentStock in place).
    const updatedCatalog = applyStock(currentStock, offer);
    for (let i = 0; i < currentStock.length; i++) {
      currentStock[i] = updatedCatalog[i];
    }
    currentRecord.catalog = currentStock;
    saveStockMap(stockMap);

    remember(`bought ${offer.give.count}x ${offer.give.id} from me`, 2);
    renderTradeColumn();
    return null;
  }

  /** Execute a sell (player gives item, receives NPC gold). Returns error text or null. */
  function executeSell(offer: TradeOffer): string | null {
    const itemHave = countItem(inventory, offer.want.id);
    if (itemHave < offer.want.count) {
      return `You don't have enough ${offer.want.id}. Need ${offer.want.count}, have ${itemHave}.`;
    }
    removeItem(inventory, offer.want.id, offer.want.count);
    addItem(inventory, 'gold_small', offer.give.count);
    onInvChanged();

    currentRecord.gold = Math.max(0, currentRecord.gold - offer.give.count);
    currentRecord.lastRegenMs = Date.now();
    saveStockMap(stockMap);

    remember(`sold me ${offer.want.count}x ${offer.want.id}`, 2);
    renderTradeColumn();
    return null;
  }

  // ---- Trade column (Phase N3) --------------------------------------------

  const isBuyerRole = persona.role === 'merchant' || persona.role === 'farmer';

  function tradeRow(
    id: GameItemId, label: string, priceText: string,
    buttons: Array<{ text: string; testId: string; onClick: () => void }>,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'trade-row';
    const img = document.createElement('img');
    img.src = itemIcon(id);
    img.alt = '';
    row.appendChild(img);
    const name = document.createElement('span');
    name.className = 'trade-name';
    name.textContent = label;
    name.title = label;
    row.appendChild(name);
    const price = document.createElement('span');
    price.className = 'trade-price';
    price.textContent = priceText;
    row.appendChild(price);
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.textContent = b.text;
      btn.dataset.tradeBtn = b.testId;
      btn.disabled = conversationOver;
      btn.addEventListener('click', b.onClick);
      row.appendChild(btn);
    }
    return row;
  }

  function tradeTitle(text: string): HTMLElement {
    const t = document.createElement('div');
    t.className = 'trade-title';
    t.textContent = text;
    return t;
  }

  /** Rebuild the whole trade column from current stock / inventory / gold. */
  function renderTradeColumn(): void {
    tradeCol.textContent = '';

    const gold = document.createElement('div');
    gold.className = 'trade-gold';
    gold.id = 'npc-trade-gold';
    gold.textContent =
      `Your gold: ${countItem(inventory, 'gold_small')}  ·  ${persona.name}: ${currentRecord.gold}`;
    tradeCol.appendChild(gold);

    // --- Buy list (NPC sells to player) ---
    tradeCol.appendChild(tradeTitle('Buy'));
    const inStock = currentStock.filter((e) => e.stock > 0);
    if (inStock.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'trade-empty';
      empty.textContent = 'Sold out.';
      tradeCol.appendChild(empty);
    }
    for (const entry of inStock) {
      const label = itemDef(entry.id).name;
      tradeCol.appendChild(tradeRow(
        entry.id, `${label} ×${entry.stock}`, `${entry.price}g`,
        [{
          text: 'Buy',
          testId: `buy-${entry.id}`,
          onClick: () => {
            const offer: TradeOffer = {
              give: { id: entry.id, count: 1 },
              want: { id: 'gold_small', count: entry.price },
            };
            const v = validateTradeAgainstCatalog(offer, persona.role);
            if (!v.ok) { appendMsg('system', v.reason); return; }
            const err = executeBuy(offer);
            appendMsg('system', err ?? `Bought 1× ${label} for ${entry.price} gold.`);
          },
        }],
      ));
    }

    // --- Sell list (player sells to NPC) — merchant/farmer only ---
    if (isBuyerRole) {
      tradeCol.appendChild(tradeTitle('Sell'));
      const sellable = (Object.keys(SELL_PRICES) as GameItemId[]).filter((id) => {
        if (countItem(inventory, id) <= 0) return false;
        // Role/item gate only (real gold is checked at click time).
        const probe: TradeOffer = {
          give: { id: 'gold_small', count: SELL_PRICES[id]! },
          want: { id, count: 1 },
        };
        return validateSellOffer(probe, persona.role, 1e9).ok;
      });
      if (sellable.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'trade-empty';
        empty.textContent = 'Nothing they want to buy.';
        tradeCol.appendChild(empty);
      }
      for (const id of sellable) {
        const owned = countItem(inventory, id);
        const unit = SELL_PRICES[id]!;
        const label = itemDef(id).name;
        const sell = (count: number): void => {
          const offer: TradeOffer = {
            give: { id: 'gold_small', count: unit * count },
            want: { id, count },
          };
          const v = validateSellOffer(offer, persona.role, currentRecord.gold);
          if (!v.ok) { appendMsg('system', v.reason); return; }
          const err = executeSell(offer);
          appendMsg('system', err ?? `Sold ${count}× ${label} for ${unit * count} gold.`);
        };
        tradeCol.appendChild(tradeRow(
          id, `${label} ×${owned}`, `${unit}g`,
          [
            { text: 'Sell', testId: `sell-${id}`, onClick: () => sell(1) },
            {
              text: 'All', testId: `sell-all-${id}`,
              onClick: () => sell(countItem(inventory, id)),
            },
          ],
        ));
      }
    }
  }

  /**
   * Render a BUY offer card (NPC sells to player).
   * offer.give = item, offer.want = gold_small.
   */
  function renderBuyCard(offer: TradeOffer): void {
    _state.pendingOffer = offer;
    const card = document.createElement('div');
    card.className = 'offer-card';
    card.id = 'npc-offer-card';

    const title = document.createElement('div');
    title.className = 'offer-title';
    title.textContent = 'Trade Offer';
    card.appendChild(title);

    const desc = document.createElement('div');
    desc.textContent = `Give: ${offer.want.count} gold  →  Receive: ${offer.give.count}× ${offer.give.id}`;
    card.appendChild(desc);

    const btns = document.createElement('div');
    btns.className = 'offer-buttons';

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'confirm';
    confirmBtn.textContent = 'Confirm';
    confirmBtn.id = 'npc-offer-confirm';
    confirmBtn.addEventListener('click', () => {
      const err = executeBuy(offer);
      if (err !== null) {
        appendMsg('system', err);
        return;
      }
      appendMsg('system',
        `Trade complete! Received ${offer.give.count}× ${offer.give.id}, paid ${offer.want.count} gold.`);
      card.classList.add('declined');
      _state.pendingOffer = null;
    });
    btns.appendChild(confirmBtn);

    const declineBtn = document.createElement('button');
    declineBtn.textContent = 'Decline';
    declineBtn.id = 'npc-offer-decline';
    declineBtn.addEventListener('click', () => {
      appendMsg('system', 'Trade declined.');
      card.classList.add('declined');
      _state.pendingOffer = null;
    });
    btns.appendChild(declineBtn);
    card.appendChild(btns);

    historyEl.appendChild(card);
    scrollBottom();
  }

  /**
   * Render a SELL card (player sells item to NPC for gold).
   * offer.give = gold_small (NPC gives), offer.want = player's item.
   */
  function renderSellCard(offer: TradeOffer): void {
    _state.pendingOffer = offer;
    const card = document.createElement('div');
    card.className = 'offer-card';
    card.id = 'npc-offer-card';

    const title = document.createElement('div');
    title.className = 'offer-title';
    title.textContent = `Sell ${offer.want.count}× ${offer.want.id} for ${offer.give.count} gold`;
    card.appendChild(title);

    const desc = document.createElement('div');
    desc.textContent = `Give: ${offer.want.count}× ${offer.want.id}  →  Receive: ${offer.give.count} gold`;
    card.appendChild(desc);

    const btns = document.createElement('div');
    btns.className = 'offer-buttons';

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'confirm';
    confirmBtn.textContent = 'Confirm';
    confirmBtn.id = 'npc-offer-confirm';
    confirmBtn.addEventListener('click', () => {
      const err = executeSell(offer);
      if (err !== null) {
        appendMsg('system', err);
        return;
      }
      appendMsg('system',
        `Sold ${offer.want.count}× ${offer.want.id} for ${offer.give.count} gold.`);
      card.classList.add('declined');
      _state.pendingOffer = null;
    });
    btns.appendChild(confirmBtn);

    const declineBtn = document.createElement('button');
    declineBtn.textContent = 'Decline';
    declineBtn.id = 'npc-offer-decline';
    declineBtn.addEventListener('click', () => {
      appendMsg('system', 'Trade declined.');
      card.classList.add('declined');
      _state.pendingOffer = null;
    });
    btns.appendChild(declineBtn);
    card.appendChild(btns);

    historyEl.appendChild(card);
    scrollBottom();
  }

  /** True once the NPC has ended the conversation (hostile/afraid/end). */
  let conversationOver = false;

  /** Handle an NPC action: system line, memory hit, close panel, notify game. */
  function handleNpcAction(action: { action: NpcActionKind; reason?: string }): void {
    // Romance actions keep the conversation going.
    if (action.action === 'charmed') {
      adjustRomance(memRec, FLIRT_ROMANCE_GAIN);
      adjustDisposition(memRec, 3);
      persona.romance = memRec.romance;

  // Live trade context. All three of these existed in the game and none of
  // them reached the model, which is why NPC conversation felt thin: every
  // merchant recited the same static role catalogue, none of them knew what
  // they had actually sold, and none could see that the traveller was carrying
  // forty pelts and a sack of ore.
  persona.stock = currentStock
    .map((e) => ({ id: e.id, price: e.price, count: e.stock }));
  persona.gold = currentRecord.gold;
  // What this NPC would buy, priced from SELL_PRICES, capped at what they can
  // actually pay. Sorted by value so a short list leads with the good stuff.
  {
    const seen = new Map<string, number>();
    for (const slot of [...inventory.pack, ...inventory.hotbar]) {
      if (slot === null) continue;
      if (slot.id === 'gold_small') continue; // nobody buys your money
      const price = SELL_PRICES[slot.id];
      if (price === undefined) continue;
      seen.set(slot.id, (seen.get(slot.id) ?? 0) + slot.count);
    }
    persona.playerWares = [...seen.entries()]
      .map(([id, count]) => ({ id, price: SELL_PRICES[id as GameItemId] ?? 0, count }))
      .filter((w) => w.price > 0)
      .sort((a, b) => b.price * b.count - a.price * a.count)
      .slice(0, 8); // keep the prompt short; the model only needs the highlights
  }
      persona.disposition = memRec.disposition;
      saveMemoryMap(memoryMap);
      const t = romanceTone(memRec.romance);
      appendMsg('system', t === 'in_love'
        ? `${persona.name} gazes at you, deeply in love.`
        : t === 'smitten'
          ? `${persona.name} is smitten with you.`
          : `${persona.name} seems charmed.`);
      onNpcAction?.(npcId, action.action);
      return;
    }
    if (action.action === 'accept_proposal') {
      marry(memoryMap, sk);
      persona.spouse = true;
      persona.romance = memRec.romance;

  // Live trade context. All three of these existed in the game and none of
  // them reached the model, which is why NPC conversation felt thin: every
  // merchant recited the same static role catalogue, none of them knew what
  // they had actually sold, and none could see that the traveller was carrying
  // forty pelts and a sack of ore.
  persona.stock = currentStock
    .map((e) => ({ id: e.id, price: e.price, count: e.stock }));
  persona.gold = currentRecord.gold;
  // What this NPC would buy, priced from SELL_PRICES, capped at what they can
  // actually pay. Sorted by value so a short list leads with the good stuff.
  {
    const seen = new Map<string, number>();
    for (const slot of [...inventory.pack, ...inventory.hotbar]) {
      if (slot === null) continue;
      if (slot.id === 'gold_small') continue; // nobody buys your money
      const price = SELL_PRICES[slot.id];
      if (price === undefined) continue;
      seen.set(slot.id, (seen.get(slot.id) ?? 0) + slot.count);
    }
    persona.playerWares = [...seen.entries()]
      .map(([id, count]) => ({ id, price: SELL_PRICES[id as GameItemId] ?? 0, count }))
      .filter((w) => w.price > 0)
      .sort((a, b) => b.price * b.count - a.price * a.count)
      .slice(0, 8); // keep the prompt short; the model only needs the highlights
  }
      persona.disposition = memRec.disposition;
      addFact(memRec, 'we are married');
      saveMemoryMap(memoryMap);
      const title = persona.gender === 'female' ? 'wife' : 'husband';
      appendMsg('system',
        `${persona.name} accepts! ${persona.name} is now your ${title}.`);
      onNpcAction?.(npcId, action.action);
      return;
    }
    if (action.action === 'reject_proposal') {
      appendMsg('system', `${persona.name} gently declines your proposal.`);
      onNpcAction?.(npcId, action.action);
      return;
    }
    // Companion actions keep the conversation going.
    if (action.action === 'follow') {
      persona.following = true;
      adjustDisposition(memRec, 4);
      persona.disposition = memRec.disposition;
      addFact(memRec, 'I agreed to walk with them');
      saveMemoryMap(memoryMap);
      appendMsg('system', `${persona.name} will follow you.`);
      onNpcAction?.(npcId, action.action);
      return;
    }
    if (action.action === 'stay') {
      persona.following = false;
      appendMsg('system', `${persona.name} stays behind.`);
      onNpcAction?.(npcId, action.action);
      return;
    }
    // Hospitality: NPC invites the player into their home (Phase N9).
    if (action.action === 'invite_home') {
      persona.insideHome = true;
      adjustDisposition(memRec, 2);
      persona.disposition = memRec.disposition;
      addFact(memRec, 'I welcomed them into my home');
      saveMemoryMap(memoryMap);
      appendMsg('system', `${persona.name} invites you into their home.`);
      onNpcAction?.(npcId, action.action);
      return;
    }
    conversationOver = true;
    // NOTE: `action.reason` is the model's own free text. It is NOT persisted —
    // memoryFactForAction() supplies a first-party line instead. See that
    // function for why (it is a transparency-law condition, not just taste).
    if (action.action === 'hostile') {
      appendMsg('system', `${persona.name} turns hostile!`);
      remember(memoryFactForAction('hostile'), -45);
    } else if (action.action === 'afraid') {
      appendMsg('system', `${persona.name} flees in fear!`);
      remember(memoryFactForAction('afraid'), -25);
    } else {
      appendMsg('system', `${persona.name} ends the conversation.`);
      if (action.reason !== undefined) remember(memoryFactForAction('end'), -5);
    }
    input.disabled = true;
    sendBtn.disabled = true;
    renderTradeColumn(); // re-render with buttons disabled
    onNpcAction?.(npcId, action.action);
    if (action.action === 'hostile') {
      // Close immediately — the player must be free to run or fight back
      // the moment the NPC turns on them (panels freeze player input).
      if (_state.open && _state.npcId === npcId) panels.close();
    } else {
      window.setTimeout(() => {
        if (_state.open && _state.npcId === npcId) panels.close();
      }, 1200);
    }
  }

  /**
   * Process a completed NPC reply: update history, check for trade offer.
   *
   * `playerSaid` is the message that produced this reply, used only for the
   * deterministic threat floor below. Omitted for the canned opening line.
   */
  function onReplyComplete(replyText: string, playerSaid?: string): void {
    _state.lastReply = replyText;
    history.push({ role: 'assistant', content: replyText });

    // Conversation consequences take precedence over trade offers.
    let npcAction = extractNpcAction(replyText);
    // Deterministic floor: a 1.7B reliably fails to emit the action verb when
    // threatened (0/4 measured, both the current and previous default — see
    // threatActionFor). Without this, threatening an NPC has consequences in
    // stub mode and none with the live model loaded. The model's own verb
    // still wins; this only fills the gap when it emitted nothing at all.
    if (npcAction === null && playerSaid !== undefined) {
      const kind = detectThreat(playerSaid);
      if (kind !== null) npcAction = threatActionFor(persona.role, kind);
    }
    if (npcAction !== null) {
      handleNpcAction(npcAction);
      return;
    }

    // Conversation itself warms the relationship.
    //
    // Nothing did, before. Disposition moved only on trades (+2), gifts (+4)
    // and flirts (+3), against a 'friendly' threshold of 25 — so reaching it
    // took roughly a dozen transactions, and a twenty-turn heart-to-heart left
    // you exactly as much a stranger as when you walked up. In a game whose
    // headline feature is talking to people, talking was the one thing that
    // did not count.
    //
    // Capped per conversation so it cannot be farmed by spamming "hello", and
    // small enough that four or five real conversations is what carries a
    // stranger to friendly — which is about right for a villager.
    if (sessionWarmth < WARMTH_PER_CONVERSATION) {
      sessionWarmth++;
      adjustDisposition(memRec, 1);
      saveMemoryMap(memoryMap);
    }

    // Try to extract a trade offer.
    const offer = extractTradeOffer(replyText);
    if (offer !== null) {
      // --- Buy path: NPC gives item, player pays gold ---
      const buyValidation = validateTradeAgainstCatalog(offer, persona.role);
      if (buyValidation.ok) {
        // Also check that stock covers the requested count.
        const stockEntry = currentStock.find((e) => e.id === offer.give.id);
        const stockOk = stockEntry !== undefined && stockEntry.stock >= offer.give.count;
        if (stockOk) {
          renderBuyCard(offer);
          return;
        }
      }

      // --- Sell path: NPC gives gold, player gives item ---
      const sellValidation = validateSellOffer(offer, persona.role, currentRecord.gold);
      if (sellValidation.ok) {
        renderSellCard(offer);
      }
    }
  }

  /** Send a message: update UI, call LLM or stub, handle response. */
  async function sendMessage(text: string): Promise<void> {
    if (text.trim() === '') return;
    input.value = '';
    sendBtn.disabled = true;
    input.disabled = true;

    appendMsg('user', text);

    // --- guardrail, input side ------------------------------------------
    // Screened BEFORE the model sees it, so prohibited content is never
    // generated in the first place rather than caught afterwards. The turn is
    // kept out of `history` entirely: leaving it in would feed it back as
    // context on every subsequent turn and steer the whole conversation.
    const inVerdict = screenPlayerInput(text);
    if (inVerdict.blocked) {
      const deflection = safetyDeflection(persona.name + text.length);
      appendReply(deflection);
      // eslint-disable-next-line no-console
      console.warn(`[safety] blocked player input (${inVerdict.category}/${inVerdict.detail})`);
      sendBtn.disabled = false;
      input.disabled = false;
      input.focus();
      return;
    }

    history.push({ role: 'user', content: text });

    const messages = buildNpcMessages(persona, history.slice(0, -1), text);

    if (stubMode) {
      // Use __NPC_CHAT_MOCK__ if set (for e2e injection).
      if (typeof window.__NPC_CHAT_MOCK__ === 'function') {
        const reply = String(await window.__NPC_CHAT_MOCK__(messages));
        appendReply(reply);
        onReplyComplete(reply, text);
      } else {
        // Simulate a tiny async delay so the UI renders before the reply.
        await new Promise<void>((r) => setTimeout(r, 40));
        const reply = stubReply(persona, text, currentStock, currentRecord.gold);
        appendReply(reply);
        onReplyComplete(reply, text);
      }
    } else {
      // Live mode: attempt LLM call, fall back to stub on any error.
      const thinkingEl = appendMsg('thinking', 'thinking…');
      try {
        let chatFn = _liveChatFn;
        if (chatFn === null) {
          // Check for mock first.
          if (typeof window.__NPC_CHAT_MOCK__ === 'function') {
            chatFn = async (msgs: ChatMessage[]) =>
              String(await window.__NPC_CHAT_MOCK__!(msgs));
            _liveChatFn = chatFn;
          } else if (gpu !== undefined && !_chatFnBuilding) {
            _chatFnBuilding = true;
            try {
              chatFn = await buildLiveChatFn(gpu, npcModel ?? 'default');
              _liveChatFn = chatFn;
            } finally {
              _chatFnBuilding = false;
            }
          }
        }

        if (chatFn === null) {
          // Model not yet available — fall back to stub.
          throw new Error('model not loaded');
        }

        let buffer = '';
        const replyEl = document.createElement('div');
        replyEl.className = 'msg assistant';
        historyEl.appendChild(replyEl);

        // Streaming means partial text is on screen before the reply is
        // finished, so the guardrail has to run on the buffer as it grows —
        // screening only the completed reply would let a prohibited sentence
        // be visible for the second or two it takes to finish generating.
        let streamBlocked = false;
        const fullReply = await chatFn(messages, (chunk: string) => {
          buffer += chunk;
          if (!streamBlocked && screenNpcReply(buffer).blocked) {
            streamBlocked = true;
            replyEl.textContent = '';
          }
          if (streamBlocked) return;
          // Strip control JSON live so the player never sees it mid-stream.
          replyEl.textContent = stripNpcJson(buffer);
          scrollBottom();
        });

        thinkingEl.remove();

        // Anti-parrot: the sampler's repetition penalty only sees tokens of
        // the current call, so the model can repeat an earlier turn verbatim.
        // If it did, re-roll once with an explicit "say it differently" nudge.
        let finalReply = fullReply || buffer;
        const priorReplies = history
          .filter((m) => m.role === 'assistant')
          .map((m) => stripNpcJson(m.content));
        if (isRepetitiveReply(stripNpcJson(finalReply), priorReplies)) {
          const retryMsgs: ChatMessage[] = [
            ...messages,
            { role: 'assistant', content: finalReply },
            {
              role: 'user',
              content: `(You have said that before, word for word. Answer again as ${persona.name}, with completely different words.)`,
            },
          ];
          buffer = '';
          const retry = await chatFn(retryMsgs, (chunk: string) => {
            buffer += chunk;
            replyEl.textContent = stripNpcJson(buffer);
            scrollBottom();
          });
          if (stripNpcJson(retry || buffer).trim() !== '') {
            finalReply = retry || buffer;
          }
        }

        // --- guardrail, output side ---------------------------------------
        // Final screen on the assembled reply. Discarded rather than edited:
        // a partially-redacted line reads as broken, and the redacted text
        // would still enter `history` as context for the next turn.
        const outVerdict = screenNpcReply(finalReply);
        if (streamBlocked || outVerdict.blocked) {
          replyEl.textContent = safetyDeflection(persona.name + finalReply.length);
          scrollBottom();
          // eslint-disable-next-line no-console
          console.warn(`[safety] blocked model output (${outVerdict.category ?? 'stream'}/${outVerdict.detail ?? 'partial'})`);
          // Deliberately NOT passed to onReplyComplete: that is what commits
          // the turn to history, memory and disposition.
          return;
        }

        const shown = stripNpcJson(finalReply);
        if (shown === '') replyEl.remove();
        else replyEl.textContent = shown;
        scrollBottom();
        onReplyComplete(finalReply, text);
      } catch {
        thinkingEl.remove();
        // Fall back to stub on any LLM error.
        const reply = stubReply(persona, text, currentStock, currentRecord.gold);
        appendReply(reply);
        onReplyComplete(reply, text);
        // Repair the KV fork in the background: a watchdog-aborted turn
        // leaves the cache ending in generation-preamble tokens the next
        // turn can't extend (full re-prefill → another abort). Re-warming
        // restores a strict-prefix cache so the next turn is fast.
        warmNpcChat(persona);
      }
    }

    if (!conversationOver) {
      sendBtn.disabled = false;
      input.disabled = false;
      input.focus();
    }
  }

  // ---- Event wiring -------------------------------------------------------

  sendBtn.addEventListener('click', () => {
    void sendMessage(input.value);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void sendMessage(input.value);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      panels.close();
    }
  });


  // ---- Opening greeting ---------------------------------------------------

  // Disposition too low → no trading, but they will still talk. Any
  // conversation can go anywhere; the right words may win them back.
  if (refusesChat) tradeCol.remove();
  else renderTradeColumn();

  // Show a canned opening line immediately (no LLM call).
  const bountyGuard = persona.role === 'guard' && persona.playerBounty > 0;
  let greetingText = stubMode
    ? stubReply(persona, '__greeting__', currentStock, currentRecord.gold)
    : ROLE_GREETINGS[persona.role];
  if (wasMet && !bountyGuard) {
    greetingText =
      tone === 'hateful' ? 'You. I have half a mind not to speak to you at all. Say your piece.' :
      tone === 'cold' ? 'You again. What do you want? Make it quick.' :
      ROLE_MET_GREETINGS[persona.role];
  }
  // Spouse greeting overrides the met/cold lines (but not a bounty warning).
  if (memRec.spouse && !bountyGuard) {
    greetingText = 'Welcome home, my love. I missed you.';
  }
  // NPC-initiated dialogue (e.g. guard questioning a newcomer) overrides.
  if (openingLine !== undefined && !bountyGuard) {
    greetingText = openingLine;
  }
  // First-run AI disclosure, shown once per browser profile, ahead of the very
  // first line any NPC speaks. The persistent hint under the input box covers
  // the steady state; this covers the moment the player first meets the
  // feature, which is what "in-context disclosure" actually means.
  //
  // Two separate obligations land on this, and one line satisfies both:
  //   - EU AI Act Art. 50(1) — inform people they are interacting with an AI.
  //     Single-player game NPCs are a listed example of the "obvious from
  //     context" carve-out, but the Commission's guidelines (C(2026) 5054
  //     final, 20 July 2026, ¶38) say out-of-band disclosure "may complement,
  //     though not replace, in-context disclosure". Cheaper to show it than to
  //     argue obviousness.
  //   - The same guidelines' ¶88, the route by which real-time game dialogue
  //     may be exempted from Art. 50(2) machine-readable marking, requires as
  //     one of its conjunctive conditions that "the persons exposed to the
  //     content are made aware that the content is AI-generated". This IS that
  //     condition. Do not remove it without reading
  //     docs/AI_TRANSPARENCY_GAP_ANALYSIS.md.
  if (!aiDisclosureSeen()) {
    appendMsg('system', AI_DISCLOSURE_TEXT);
    markAiDisclosureSeen();
  }

  appendMsg('assistant', greetingText);
  history.push({ role: 'assistant', content: greetingText });
  _state.lastReply = greetingText;

  // Warm the KV cache with this NPC's system prompt while the player reads
  // the greeting/types — turn 1 then prefills only the player's message.
  if (!stubMode) warmNpcChat(persona);

  // Spouse perk: a small gift on the first visit of each (real) day.
  if (memRec.spouse) {
    const DAY_MS = 24 * 60 * 60 * 1000;
    if (Date.now() - memRec.lastGiftMs >= DAY_MS) {
      memRec.lastGiftMs = Date.now();
      saveMemoryMap(memoryMap);
      addItem(inventory, 'meat_cooked', 2);
      addItem(inventory, 'gold_small', 3);
      onInvChanged();
      appendMsg('system',
        `${persona.name} gives you a warm meal and a little coin (2× cooked meat, 3× gold).`);
    }
  }

  // Auto-focus the input after DOM insertion (next microtask).
  Promise.resolve().then(() => input.focus());

  return el;
}

/** Call when the panel is closed to reset module state. */
export function onNpcChatClosed(): void {
  _state.open = false;
  _state.npcId = null;
  _state.activeStockKey = null;
  _state.pendingOffer = null;
}
