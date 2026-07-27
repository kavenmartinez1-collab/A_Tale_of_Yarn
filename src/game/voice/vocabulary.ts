/**
 * The words a generic Whisper has never heard.
 *
 * Off-the-shelf speech models transcribe ordinary English very well and proper
 * nouns very badly, and proper nouns are almost the entire point of talking to
 * an NPC: the player asks about a PLACE, a PERSON, or a THING. Untouched,
 * base.en hears "Greenholm" as "green home", "Vhaeron" as "Veron"/"Byron", and
 * "Tintreach" as almost anything.
 *
 * The fix is Whisper's own prompt conditioning — a `<|startofprev|>` prefix
 * listing the vocabulary, which is what OpenAI's `initial_prompt` compiles down
 * to. It is applied in stt-worker.ts; this module only decides what goes in it.
 *
 * TWO RULES SHAPE WHAT BELONGS HERE.
 *
 * 1. Prefer LIVE context to the full world. The prompt costs decode tokens and
 *    every irrelevant name is a distractor that can pull a correct transcript
 *    wrong. The player is standing in front of one named person, in one named
 *    town, next to a known handful of neighbours — that is a far better prompt
 *    than all 96 town names the generator can produce, and it is also shorter.
 *
 * 2. Only include what the model actually gets wrong. "Farmer", "sword" and
 *    "guard" are ordinary English; listing them wastes budget and adds
 *    distractors. Everything in CORE_TERMS earned its place by failing in
 *    `scripts/test-voice-accuracy.mts`.
 *
 * DETERMINISM: no `Math.random`, no `Date.now`. Same context in, same prompt
 * out — the accuracy harness depends on that.
 */

/**
 * World proper nouns that are not derived from live context.
 *
 * Mirrors of generated tables are deliberately NOT copied here in full — see
 * `settlementWordHints()`. These are the fixed, hand-authored names.
 */
export const CORE_TERMS: readonly string[] = [
  // Places — the named, hand-authored ones. Generated town names are handled
  // separately (settlementWordHints) and the live one comes from context.
  'Greenholm',              // pinned spawn town — settlement/settlement-scatter.ts:301
  'Castle Vhaeron',         // map/map-landmarks.ts:46 — the only spelling in the repo
  'The Sunken Crypt',       // dungeon/dungeon-fixtures.ts:16
  'Howling Hollow',         // dungeon/dungeon-fixtures.ts:32
  'Fallen Watchtower',      // dungeon/dungeon-fixtures.ts:53
  'Halls of the Pale King', // dungeon/dungeon-fixtures.ts:67
  // Things
  'Tintreach',              // the lightning arrows — items.ts:168, tintreach.ts:2
  'dragonscale',            // items.ts:201
  // Creatures
  'wyvern',                 // entities/entity-types.ts:253
  'griffin',                // entities/entity-types.ts:283
  'Dread King',             // entities/entity-types.ts:386
];

/**
 * The word-halves settlement names are built from.
 *
 * `settlementName()` (settlement/settlement-layout.ts:76) composes a prefix and
 * a suffix — 12 × 8 = 96 possible towns, before "Ruins of …" and "… Ranch".
 * Listing all 96 would swamp the prompt, so the HALVES go in instead: Whisper's
 * conditioning works on tokens, and "Harrow" + "moor" in the prompt biases
 * "Harrowmoor" without spending 96 names' worth of budget.
 *
 * These are copies, because settlement-layout.ts does not export them.
 * `scripts/test-voice-accuracy.mts` re-reads that file and fails if they drift.
 */
export const SETTLEMENT_PREFIX: readonly string[] = [
  'Oak', 'Stone', 'Ash', 'Fen', 'Wolf', 'Bright',
  'Mill', 'Raven', 'Elder', 'Thorn', 'Green', 'Harrow',
];
export const SETTLEMENT_SUFFIX: readonly string[] = [
  'ford', 'brook', 'stead', 'holm', 'wick', 'field', 'gate', 'moor',
];

/**
 * Every NPC given name. Copy of NAME_TABLE (npc/npc-prompt.ts:107), which is
 * not exported; the accuracy harness asserts the two stay identical.
 *
 * All 24 fit comfortably, and unlike towns the player may name any of them
 * ("have you seen Ysolde?") regardless of who they are talking to.
 */
export const NPC_NAMES: readonly string[] = [
  'Aldric', 'Beren', 'Calla', 'Dara', 'Edric', 'Fenna',
  'Gorm', 'Hilda', 'Ivar', 'Jora', 'Keld', 'Lyra',
  'Maren', 'Nils', 'Oswin', 'Petra', 'Quill', 'Runa',
  'Sven', 'Thora', 'Ulric', 'Vara', 'Wren', 'Ysolde',
];

export interface VoiceContext {
  /** Who the player is talking to right now. */
  npcName?: string;
  /** The settlement this conversation is happening in. */
  settlement?: string;
  /** Other named NPCs of this settlement (persona.neighbors). */
  neighbors?: readonly string[];
}

/** Prefix/suffix halves as a single hint clause. */
function settlementWordHints(): string {
  return [...SETTLEMENT_PREFIX, ...SETTLEMENT_SUFFIX].join(' ');
}

/**
 * Build the biasing prompt, most-important-first.
 *
 * Order matters under truncation: the worker keeps the HEAD of the token list
 * (Whisper's prompt window is 224 tokens for base.en — half of n_text_ctx), so
 * whatever the player is most likely to say has to come first. Live context
 * leads, the fixed world names follow, and the generated-town word halves —
 * the most speculative entry — go last, where they are dropped first.
 */
export function buildVoicePrompt(ctx: VoiceContext = {}): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (s: string | undefined) => {
    const v = s?.trim();
    if (!v || seen.has(v.toLowerCase())) return;
    seen.add(v.toLowerCase());
    parts.push(v);
  };

  push(ctx.npcName);
  push(ctx.settlement);
  for (const n of ctx.neighbors ?? []) push(n);
  for (const t of CORE_TERMS) push(t);
  for (const n of NPC_NAMES) push(n);

  // A comma list reads to Whisper as the kind of text it was trained on
  // (prompts are prior *transcript*, not a word bag), and the leading space is
  // Whisper's convention for a continuation.
  return ` ${parts.join(', ')}. ${settlementWordHints()}.`;
}
