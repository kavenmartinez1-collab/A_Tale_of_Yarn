/**
 * Per-NPC persistent memory — pure, node-testable record helpers plus a thin
 * localStorage load/save layer (mirrors the NpcStockRecord idiom).
 *
 * Each NPC keyed by `settlementName::npcId` (same key as the stock map)
 * remembers whether they've met the player, a small set of facts, and a
 * disposition score that shifts with the player's behaviour.
 */

export const NPC_MEMORY_KEY = 'artifex-npc-memory:v1';

/** How many facts an NPC can hold — oldest is forgotten first. */
export const MAX_FACTS = 5;

export interface NpcMemoryRecord {
  /** -100 (hates the player) .. 100 (devoted friend). */
  disposition: number;
  /** True once the player has spoken to this NPC at least once. */
  met: boolean;
  /** Short remembered facts about the player, newest last. */
  facts: string[];
  /** Wall-clock ms of the last conversation. */
  lastTalkMs: number;
  /** 0 (stranger) .. 100 (deeply in love). Raised by flirting and gifts. */
  romance: number;
  /** True once married to the player (at most one spouse across the map). */
  spouse: boolean;
  /** Wall-clock ms of the last daily spouse gift (0 = never). */
  lastGiftMs: number;
}

/** Persisted map: `settlementName::npcId` → NpcMemoryRecord. */
export type MemoryMap = Record<string, NpcMemoryRecord>;

export function createMemoryRecord(): NpcMemoryRecord {
  return {
    disposition: 0, met: false, facts: [], lastTalkMs: 0,
    romance: 0, spouse: false, lastGiftMs: 0,
  };
}

/** Get the record for a key, creating (and inserting) a fresh one if absent. */
export function getOrCreateMemory(map: MemoryMap, key: string): NpcMemoryRecord {
  let rec = map[key];
  if (rec === undefined) {
    rec = createMemoryRecord();
    map[key] = rec;
  }
  return rec;
}

/**
 * Remember a fact. Dedupes (a repeated fact moves to newest) and caps at
 * MAX_FACTS by forgetting the oldest.
 */
export function addFact(rec: NpcMemoryRecord, fact: string): void {
  const trimmed = fact.trim();
  if (trimmed === '') return;
  const existing = rec.facts.indexOf(trimmed);
  if (existing !== -1) rec.facts.splice(existing, 1);
  rec.facts.push(trimmed);
  while (rec.facts.length > MAX_FACTS) rec.facts.shift();
}

/** Shift disposition by delta, clamped to [-100, 100]. */
export function adjustDisposition(rec: NpcMemoryRecord, delta: number): void {
  rec.disposition = Math.max(-100, Math.min(100, rec.disposition + delta));
}

// ---------------------------------------------------------------------------
// Romance (wooing → marriage)
// ---------------------------------------------------------------------------

/** Romance needed before an NPC will accept a marriage proposal. */
export const ROMANCE_ACCEPT_AT = 70;

/** Romance gained per successful flirt/compliment. */
export const FLIRT_ROMANCE_GAIN = 12;

/** Shift romance by delta, clamped to [0, 100]. */
export function adjustRomance(rec: NpcMemoryRecord, delta: number): void {
  rec.romance = Math.max(0, Math.min(100, rec.romance + delta));
}

/** Key of the player's spouse in the map, or null when unmarried. */
export function spouseKeyOf(map: MemoryMap): string | null {
  for (const [k, rec] of Object.entries(map)) {
    if (rec.spouse) return k;
  }
  return null;
}

/**
 * Marry the NPC at `key`, clearing any previous spouse (one spouse at a time).
 * Sets romance to 100 and gives a large disposition boost.
 */
export function marry(map: MemoryMap, key: string): void {
  for (const rec of Object.values(map)) rec.spouse = false;
  const rec = getOrCreateMemory(map, key);
  rec.spouse = true;
  rec.romance = 100;
  adjustDisposition(rec, 40);
}

export type RomanceTone = 'stranger' | 'warming' | 'smitten' | 'in_love';

/** Bucket a romance score into a tone for prompts and greetings. */
export function romanceTone(romance: number): RomanceTone {
  if (romance >= ROMANCE_ACCEPT_AT) return 'in_love';
  if (romance >= 40) return 'smitten';
  if (romance >= 15) return 'warming';
  return 'stranger';
}

export type DispositionTone = 'friendly' | 'neutral' | 'cold' | 'hateful';

/** Bucket a disposition score into a tone for prompts and greetings. */
export function dispositionTone(disposition: number): DispositionTone {
  if (disposition >= 25) return 'friendly';
  if (disposition > -25) return 'neutral';
  if (disposition > -60) return 'cold';
  return 'hateful';
}

/** Below this disposition the NPC refuses to trade (they still talk —
 *  conversation is never blocked; the right words may win them back). */
export const REFUSE_CHAT_BELOW = -40;

// ---------------------------------------------------------------------------
// Threat / insult detection (stub-mode fallback for conversation consequences)
// ---------------------------------------------------------------------------

const THREAT_WORDS = [
  'kill', 'steal', 'rob', 'attack', 'hurt', 'burn', 'die', 'stab', 'murder',
  'slit', 'gut', 'destroy', 'take your', 'your wife', 'your husband',
  'your family', 'your gold or', 'hand over', 'or else',
];

const INSULT_WORDS = [
  'idiot', 'fool', 'stupid', 'ugly', 'coward', 'worthless', 'pathetic',
  'scum', 'wretch', 'dog', 'pig', 'hate you', 'filthy',
];

export type ThreatKind = 'threat' | 'insult' | null;

/**
 * Detect whether player text is a threat (violence/robbery) or an insult.
 * Deterministic keyword scan — used by the stub reply path so conversations
 * have consequences even with the LLM off.
 */
export function detectThreat(text: string): ThreatKind {
  const t = text.toLowerCase();
  for (const w of THREAT_WORDS) {
    if (t.includes(w)) return 'threat';
  }
  for (const w of INSULT_WORDS) {
    if (t.includes(w)) return 'insult';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Flirt / proposal detection (stub-mode fallback for romance)
// ---------------------------------------------------------------------------

const PROPOSAL_WORDS = [
  'marry me', 'will you marry', 'be my wife', 'be my husband',
  'be my spouse', 'wed me', 'will you wed',
];

const FLIRT_WORDS = [
  'beautiful', 'handsome', 'gorgeous', 'lovely', 'pretty',
  'i love you', 'love you', 'adore you', 'my darling', 'my dear',
  'sweetheart', 'my love', 'charming', 'cute', 'stunning',
  'your eyes', 'your smile', 'fancy you', 'kiss',
];

export type FlirtKind = 'proposal' | 'flirt' | null;

/**
 * Detect a marriage proposal or a compliment/flirt in player text.
 * Proposal wins over flirt. Deterministic keyword scan (stub-mode path).
 */
export function detectFlirt(text: string): FlirtKind {
  const t = text.toLowerCase();
  for (const w of PROPOSAL_WORDS) {
    if (t.includes(w)) return 'proposal';
  }
  for (const w of FLIRT_WORDS) {
    if (t.includes(w)) return 'flirt';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Follow / stay detection (stub-mode fallback for companion requests)
// ---------------------------------------------------------------------------

/** Minimum disposition for an NPC to agree to follow the player (spouses always agree). */
export const FOLLOW_TRUST_AT = 10;

const FOLLOW_WORDS = [
  'follow me', 'come with me', 'come along', 'walk with me', 'join me',
  'want to show you', 'let me show you', 'i want to show', 'accompany me',
  'travel with me', 'come see', 'come and see', 'come, i', 'lead you',
];

const STAY_WORDS = [
  'stay here', 'wait here', 'stay put', 'stop following', 'go home',
  'remain here', 'wait for me', 'stay behind', 'go back home', 'head home',
  'that is all', "that's all", 'you can go', 'leave me',
];

/** Detect a "come with me / follow me" request in player text. */
export function detectFollowRequest(text: string): boolean {
  const t = text.toLowerCase();
  return FOLLOW_WORDS.some((w) => t.includes(w));
}

/** Detect a "stay here / stop following" request in player text. */
export function detectStayRequest(text: string): boolean {
  const t = text.toLowerCase();
  return STAY_WORDS.some((w) => t.includes(w));
}

// ---------------------------------------------------------------------------
// Invite-home detection (Phase N9 — hospitality, stub-mode fallback)
// ---------------------------------------------------------------------------

const HOME_WORDS = [
  'your home', 'your house', 'your place', 'go inside', 'come in',
  'can we go in', 'invite me', 'out of the rain', 'out of the storm',
  'out of this storm', 'somewhere warm', 'somewhere dry', 'by the fire',
  'by your hearth', 'shelter', 'warm up inside', 'talk inside',
  'talk in private', 'somewhere private',
];

/** Detect a "can I come in / shelter me" request in player text. */
export function detectHomeRequest(text: string): boolean {
  const t = text.toLowerCase();
  return HOME_WORDS.some((w) => t.includes(w));
}

// ---------------------------------------------------------------------------
// Reply repetition detection (anti-parrot for the live LLM path)
// ---------------------------------------------------------------------------

/** Lowercase, strip punctuation, collapse whitespace, split into words. */
function replyWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '');
}

/** Word-trigram set of a reply ('' entries impossible — words are non-empty). */
function trigramSet(words: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) {
    out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  return out;
}

/**
 * True when `reply` substantially repeats one of `priorReplies`.
 *
 * The sampler's repetition penalty only sees tokens generated within a single
 * call, so an NPC can happily parrot its previous turn verbatim. This catches
 * that at the app level: exact match after normalization, or >= 60% of the new
 * reply's word-trigrams already appeared in a single prior reply. Short
 * replies (< 5 words) are exempt — "Aye." twice is fine.
 */
export function isRepetitiveReply(reply: string, priorReplies: string[]): boolean {
  const words = replyWords(reply);
  if (words.length < 5) return false;
  const joined = words.join(' ');
  const tris = trigramSet(words);
  for (const prior of priorReplies) {
    const pWords = replyWords(prior);
    if (pWords.join(' ') === joined) return true;
    if (tris.size === 0) continue;
    const pTris = trigramSet(pWords);
    let shared = 0;
    for (const t of tris) if (pTris.has(t)) shared++;
    if (shared / tris.size >= 0.6) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Persistence (browser only — returns {} where localStorage is unavailable)
// ---------------------------------------------------------------------------

/** One stored record is valid if it has the four original fields. */
function isValidRecord(v: unknown): v is NpcMemoryRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.disposition === 'number' && typeof r.met === 'boolean' &&
    Array.isArray(r.facts) && typeof r.lastTalkMs === 'number';
}

/** Fill romance-era fields absent from records saved before the feature. */
function normalizeRecord(r: NpcMemoryRecord): NpcMemoryRecord {
  if (typeof r.romance !== 'number') r.romance = 0;
  if (typeof r.spouse !== 'boolean') r.spouse = false;
  if (typeof r.lastGiftMs !== 'number') r.lastGiftMs = 0;
  return r;
}

export function loadMemoryMap(): MemoryMap {
  try {
    const raw = localStorage.getItem(NPC_MEMORY_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const result: MemoryMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (isValidRecord(v)) result[k] = normalizeRecord(v);
    }
    return result;
  } catch {
    return {};
  }
}

export function saveMemoryMap(map: MemoryMap): void {
  try {
    localStorage.setItem(NPC_MEMORY_KEY, JSON.stringify(map));
  } catch { /* quota / unavailable */ }
}

// ---------------------------------------------------------------------------
// Visited settlements (Phase N4 — first-visit greetings/questioning)
// ---------------------------------------------------------------------------

export const VISITED_KEY = 'artifex-visited:v1';

export function loadVisitedSet(): Set<string> {
  try {
    const raw = localStorage.getItem(VISITED_KEY);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

export function saveVisitedSet(set: Set<string>): void {
  try {
    localStorage.setItem(VISITED_KEY, JSON.stringify([...set]));
  } catch { /* quota / unavailable */ }
}

// ---------------------------------------------------------------------------
// Dead NPCs (killable NPCs — permanent death, persisted across reloads)
// ---------------------------------------------------------------------------

export const DEAD_NPCS_KEY = 'artifex-npc-dead:v1';

/** Set of npc ids ("npc_<settlementSeed>_<index>", globally unique). */
export function loadDeadNpcSet(): Set<string> {
  try {
    const raw = localStorage.getItem(DEAD_NPCS_KEY);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

export function saveDeadNpcSet(set: Set<string>): void {
  try {
    localStorage.setItem(DEAD_NPCS_KEY, JSON.stringify([...set]));
  } catch { /* quota / unavailable */ }
}
