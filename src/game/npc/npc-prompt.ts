/**
 * NPC prompt builder — pure functions, node-testable (no engine, no DOM).
 *
 * Builds the system prompt and message list for NPC chat.  The system prompt
 * encodes a compact character card, world knowledge, strict brevity rules, and
 * (for trading roles) the NPC's stock with prices so the model can propose a
 * deal in a structured JSON block.
 */

import { type ChatMessage } from '../director/director-prompt';
import { mix32 } from '../dungeon/dungeon-layout';
import { TRADE_CATALOG, type NpcRole } from './npc-trade';

export type { NpcRole };

export interface NpcPersona {
  role: NpcRole;
  name: string;
  settlement: string;
  /** Bounty the player carries in this settlement's ledger (gold_small units). */
  playerBounty: number;
}

// ---------------------------------------------------------------------------
// Name generation
// ---------------------------------------------------------------------------

const NAME_TABLE: string[] = [
  'Aldric', 'Beren', 'Calla', 'Dara', 'Edric', 'Fenna',
  'Gorm', 'Hilda', 'Ivar', 'Jora', 'Keld', 'Lyra',
  'Maren', 'Nils', 'Oswin', 'Petra', 'Quill', 'Runa',
  'Sven', 'Thora', 'Ulric', 'Vara', 'Wren', 'Ysolde',
];

/**
 * Deterministic NPC name derived from world coordinates and a per-spawn index.
 * Uses mix32 so the same inputs always return the same name.
 */
export function npcNameFor(
  seed: number,
  sx: number,
  sz: number,
  index: number,
): string {
  const h = mix32(seed ^ 0x4e504301, sx ^ (index * 0x1f3d), sz);
  return NAME_TABLE[h % NAME_TABLE.length];
}

// ---------------------------------------------------------------------------
// Personality hints per role
// ---------------------------------------------------------------------------

const ROLE_PERSONALITY: Record<NpcRole, string> = {
  farmer:   'weathered and practical; speaks of soil, seasons, and fair prices',
  villager: 'friendly but cautious; knows local gossip and useful tools',
  merchant: 'shrewd and charming; loves a deal, keeps one eye on profit',
  guard:    'stern and watchful; loyal to the settlement, brooks no nonsense',
};

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

/** Format a catalog line for the prompt: "  item_name (id): N in stock, N gold each" */
function catalogLine(id: string, price: number, stock: number): string {
  return `  - ${id}: ${stock} in stock, ${price} gold each`;
}

/**
 * Build a compact system prompt for the NPC character.
 *
 * Trading roles (farmer / villager / merchant) receive their full catalog and
 * the instruction to emit a trade JSON block when a deal is agreed.
 * Guards receive a bounty warning instead of a trade catalog.
 */
export function buildNpcSystemPrompt(persona: NpcPersona): string {
  const { role, name, settlement, playerBounty } = persona;
  const personality = ROLE_PERSONALITY[role];

  const characterCard = [
    `You are ${name}, a ${role} in the settlement of ${settlement}.`,
    `Personality: ${personality}.`,
  ].join('\n');

  const worldKnowledge = [
    'World: a hand-crafted open world of plains, forests, deserts, and cold highlands.',
    `Dungeons (crypts, caves, ruins) dot the wilderness around ${settlement}.`,
    `${settlement} is a small but lively settlement — the folk here know the land well.`,
  ].join('\n');

  const brevity = [
    'STRICT RULES:',
    '- Reply in 60 words or fewer. Stay in character at all times. No meta-talk.',
    '- Never break the fourth wall or mention you are an AI.',
  ].join('\n');

  let roleSection: string;

  if (role === 'guard') {
    if (playerBounty > 0) {
      roleSection = [
        `BOUNTY ALERT: This traveller has a bounty of ${playerBounty} gold in ${settlement}.`,
        'You must sternly warn them: they can pay the bounty, submit to arrest, or face consequences.',
        'Do not offer trade. Focus on the bounty.',
      ].join('\n');
    } else {
      roleSection = 'You are on duty. You may share brief knowledge of local threats but do not trade.';
    }
  } else {
    const catalog = TRADE_CATALOG[role];
    const catalogLines = catalog.map((e) => catalogLine(e.id, e.price, e.stock)).join('\n');
    roleSection = [
      `Your stock for sale (you give the item, player pays gold_small):`,
      catalogLines,
      '',
      'Trading rules:',
      '- When the player agrees to a deal, append EXACTLY one JSON object on its own line:',
      '{"trade":{"give":{"id":"<item_id>","count":<N>},"want":{"id":"gold_small","count":<M>}}}',
      '- Only emit this JSON when a deal is explicitly agreed. Do not emit it otherwise.',
      '- Prices may be haggled down by up to 20% (minimum 80% of listed price).',
    ].join('\n');
  }

  return [characterCard, worldKnowledge, brevity, roleSection].join('\n\n');
}

// ---------------------------------------------------------------------------
// Message list builder
// ---------------------------------------------------------------------------

/** Maximum number of prior turns (each turn = 1 user + 1 assistant message) to retain. */
const MAX_HISTORY_TURNS = 8;

/**
 * Build the full ChatMessage list for an NPC inference call.
 *
 * Layout: [system] + last N turns from history + new user message.
 * History is capped at the last MAX_HISTORY_TURNS turns (pairs of messages).
 * Odd-length history is trimmed from the front to maintain role alternation.
 */
export function buildNpcMessages(
  persona: NpcPersona,
  history: ChatMessage[],
  userText: string,
): ChatMessage[] {
  const system: ChatMessage = {
    role: 'system',
    content: buildNpcSystemPrompt(persona),
  };

  // Cap: keep at most MAX_HISTORY_TURNS * 2 messages (turn = user + assistant pair).
  const maxMsgs = MAX_HISTORY_TURNS * 2;
  let trimmed = history.length > maxMsgs ? history.slice(history.length - maxMsgs) : history;

  // Ensure history starts with a user message (maintain alternation).
  if (trimmed.length > 0 && trimmed[0].role !== 'user') {
    trimmed = trimmed.slice(1);
  }

  const user: ChatMessage = { role: 'user', content: userText };

  return [system, ...trimmed, user];
}
