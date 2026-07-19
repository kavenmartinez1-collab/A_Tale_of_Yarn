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
import { buildNpcMessages } from '../npc/npc-prompt';
import {
  TRADE_CATALOG, SELL_PRICES, extractTradeOffer,
  validateTradeAgainstCatalog, validateSellOffer, applyStock,
  type TradeOffer, type CatalogEntry, type NpcRole,
} from '../npc/npc-trade';
import type { ChatMessage } from '../director/director-prompt';
import type { Inventory } from '../inventory';
import { countItem, removeItem, addItem, saveInventory } from '../inventory';
import type { PanelManager } from './panel-manager';

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

/** Regen rate: +25 gold per 5 real-time minutes, capped at start value. */
const REGEN_AMOUNT   = 25;
const REGEN_PERIOD_MS = 5 * 60 * 1000; // 5 min in ms

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
  min-width: 320px;
  max-width: 400px;
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

/** Build a streaming chat function backed by the game's GPU session. */
async function buildLiveChatFn(gpu: import('../../engine/gpu-device').GPUContext): Promise<NpcChatFn> {
  // Dynamic import keeps the cost zero when NPC chat is never used.
  const { createGGUFInferenceSession } = await import('../../engine/gguf-session');
  const { useLocalCache } = await import('../../model/hf-hub');
  useLocalCache();

  const DIRECTOR_MODEL_ID = 'local/flux2-te-qwen3-4b-q4_k_m';
  const DIRECTOR_GGUF_FILE = 'flux2-te-qwen3-4b-q4_k_m.gguf';

  const session = await createGGUFInferenceSession({
    repo: DIRECTOR_MODEL_ID,
    ggufFile: DIRECTOR_GGUF_FILE,
    gpu,
    onStatus: () => { /* no UI hook needed here */ },
  });

  return async (messages: ChatMessage[], onToken?: (chunk: string) => void) => {
    const handle = session.chat(
      messages,
      { temperature: 0.7, maxNewTokens: 120 },
      onToken,
      { enableThinking: false, emptyThink: true },
    );
    const r = await handle.result;
    return r.text;
  };
}

// Cached chat function (lazily initialized).
let _liveChatFn: NpcChatFn | null = null;
let _chatFnBuilding = false;

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
  /** Per-run stock map (mutated in-place and persisted). */
  stockMap: StockMap;
}

export function buildNpcChatPanel(opts: NpcChatPanelOptions): HTMLElement {
  injectCss();

  const {
    persona, npcId, settlementName, inventory, onInvChanged,
    panels, stubMode, gpu, stockMap,
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
    if (regenned !== rec.gold) {
      rec.gold = regenned;
      rec.lastRegenMs = nowMs;
    }
  }
  const currentRecord = stockMap[sk];
  const currentStock: CatalogEntry[] = currentRecord.catalog;

  // Persist the (potentially freshly-initialised or regen'd) record immediately.
  saveStockMap(stockMap);

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
  roleEl.textContent = `${persona.role} · ${settlementName}`;
  el.appendChild(roleEl);

  const historyEl = document.createElement('div');
  historyEl.className = 'npc-history';
  historyEl.id = 'npc-chat-history';
  el.appendChild(historyEl);

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
  el.appendChild(inputRow);

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'Enter to send  ·  Esc to close';
  el.appendChild(hint);

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
      const goldHave = countItem(inventory, 'gold_small');
      if (goldHave < offer.want.count) {
        appendMsg('system',
          `Not enough gold. You have ${goldHave} gold, need ${offer.want.count}.`);
        return;
      }
      // Execute the swap.
      removeItem(inventory, 'gold_small', offer.want.count);
      addItem(inventory, offer.give.id, offer.give.count);
      onInvChanged();

      // Decrement persistent stock.
      const updatedCatalog = applyStock(currentStock, offer);
      // Sync currentStock in place (lengths equal, update each entry).
      for (let i = 0; i < currentStock.length; i++) {
        currentStock[i] = updatedCatalog[i];
      }
      currentRecord.catalog = currentStock;
      saveStockMap(stockMap);

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
      const itemHave = countItem(inventory, offer.want.id);
      if (itemHave < offer.want.count) {
        appendMsg('system',
          `You don't have enough ${offer.want.id}. Need ${offer.want.count}, have ${itemHave}.`);
        return;
      }
      // Execute the swap: remove item, add gold.
      removeItem(inventory, offer.want.id, offer.want.count);
      addItem(inventory, 'gold_small', offer.give.count);
      onInvChanged();

      // Decrement NPC gold pool.
      currentRecord.gold = Math.max(0, currentRecord.gold - offer.give.count);
      currentRecord.lastRegenMs = Date.now();
      saveStockMap(stockMap);

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

  /** Process a completed NPC reply: update history, check for trade offer. */
  function onReplyComplete(replyText: string): void {
    _state.lastReply = replyText;
    history.push({ role: 'assistant', content: replyText });

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
    history.push({ role: 'user', content: text });

    const messages = buildNpcMessages(persona, history.slice(0, -1), text);

    if (stubMode) {
      // Use __NPC_CHAT_MOCK__ if set (for e2e injection).
      if (typeof window.__NPC_CHAT_MOCK__ === 'function') {
        const reply = String(await window.__NPC_CHAT_MOCK__(messages));
        appendMsg('assistant', reply);
        onReplyComplete(reply);
      } else {
        // Simulate a tiny async delay so the UI renders before the reply.
        await new Promise<void>((r) => setTimeout(r, 40));
        const reply = stubReply(persona, text, currentStock, currentRecord.gold);
        appendMsg('assistant', reply);
        onReplyComplete(reply);
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
              chatFn = await buildLiveChatFn(gpu);
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

        const fullReply = await chatFn(messages, (chunk: string) => {
          buffer += chunk;
          replyEl.textContent = buffer;
          scrollBottom();
        });

        thinkingEl.remove();
        // If streaming populated replyEl already, use it; else set final text.
        if (buffer === '') {
          replyEl.textContent = fullReply;
        }
        scrollBottom();
        onReplyComplete(fullReply || buffer);
      } catch {
        thinkingEl.remove();
        // Fall back to stub on any LLM error.
        const reply = stubReply(persona, text, currentStock, currentRecord.gold);
        appendMsg('assistant', reply);
        onReplyComplete(reply);
      }
    }

    sendBtn.disabled = false;
    input.disabled = false;
    input.focus();
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

  // Prevent pointer-lock keys from firing while input is focused.
  input.addEventListener('keyup', (e) => e.stopPropagation());

  // ---- Opening greeting ---------------------------------------------------

  // Show a canned opening line immediately (no LLM call).
  const greetingText = stubMode
    ? stubReply(persona, '__greeting__', currentStock, currentRecord.gold)
    : ROLE_GREETINGS[persona.role];
  appendMsg('assistant', greetingText);
  history.push({ role: 'assistant', content: greetingText });
  _state.lastReply = greetingText;

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
