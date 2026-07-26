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
import { dispositionTone, romanceTone, ROMANCE_ACCEPT_AT, FOLLOW_TRUST_AT } from './npc-memory';
import { TRADE_CATALOG, type NpcRole } from './npc-trade';

export type { NpcRole };

export type NpcGender = 'male' | 'female';

/** A fellow settler this NPC knows (settlement roster entry). */
export interface NpcNeighbor {
  name: string;
  role: NpcRole;
  /** Relationship from this NPC's perspective ('' = just a fellow settler). */
  relation: string;
}

export interface NpcPersona {
  role: NpcRole;
  name: string;
  settlement: string;
  /** Bounty the player carries in this settlement's ledger (gold_small units). */
  playerBounty: number;
  /** Persistent disposition toward the player, -100..100 (default 0). */
  disposition?: number;
  /** True if this NPC has spoken to the player before. */
  met?: boolean;
  /** Short remembered facts about the player, newest last. */
  memoryFacts?: string[];
  /** Derived from the NPC's name (npcGenderFor). */
  gender?: NpcGender;
  /** Romance toward the player, 0..100 (default 0). */
  romance?: number;
  /** True when this NPC is married to the player. */
  spouse?: boolean;
  /** Other NPCs of this settlement, with relationships (buildNpcRelations). */
  neighbors?: NpcNeighbor[];
  /** Short observations about the NPC's surroundings ("two horses graze by the stable"). */
  worldFacts?: string[];
  /** True while this NPC is currently following the player around. */
  following?: boolean;
  /** True while the conversation is happening inside this NPC's home (Phase N9). */
  insideHome?: boolean;
  /** Deterministic speech quirk (npcQuirkFor) — makes NPCs read distinct. */
  quirk?: string;
  /**
   * This NPC's LIVE stock, as it actually stands right now.
   *
   * Without it the prompt fell back to `TRADE_CATALOG[role]`, the static
   * per-role template — so every merchant in the world described identical
   * wares, selling out changed nothing the model knew, and an NPC would
   * cheerfully offer something it had none of. The stock regenerates over time
   * and is per NPC; the model has to see the real thing.
   */
  stock?: { id: string; price: number; count: number }[];
  /** Gold this NPC has to spend. Caps what they can offer to buy. */
  gold?: number;
  /**
   * What the PLAYER is carrying that this NPC would buy, with the price it
   * would pay.
   *
   * The trade system has always supported buying from the player
   * (`validateSellOffer`, `SELL_PRICES`, and the apply path in the chat
   * panel) — the model was simply never told the player had anything, so it
   * could never open the subject. An NPC that says "I'd give you six gold for
   * that pelt" is doing the single most characterful thing a merchant can do.
   */
  playerWares?: { id: string; price: number; count: number }[];
  /**
   * What this NPC knows about the player's conduct in this settlement —
   * shared village memory (`village-memory.ts`), newest and firsthand first.
   *
   * The gap this closes: attack a farmer in the square and the farmer standing
   * beside them had no idea. Crimes were logged anonymously against a REGION
   * and raised a bounty; no NPC could say who did what to whom, so nobody ever
   * mentioned it. Lines already distinguish "You saw..." from "You have
   * heard...", which is the difference between a witness and a rumour and is
   * most of what makes a village feel like one.
   */
  villageNews?: string[];
  /**
   * Shared village knowledge — lore every settler agrees on, and concerns
   * (`village-facts.ts`), which are this game's quests.
   *
   * This is what makes two NPCs consistent. Ask a farmer about the well and
   * then ask the smith and you used to get two unrelated inventions, because
   * each NPC's only context was its own opinion of the player. They now read
   * the same list — and a concern names an OWNER, so "Nils would know more
   * about that" is true rather than a pleasant fabrication.
   */
  villageFacts?: string[];
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

/** Gender per NAME_TABLE entry (table order must stay stable — names are seeded). */
const NAME_GENDER: Record<string, NpcGender> = {
  Aldric: 'male',   Beren: 'male',   Calla: 'female', Dara: 'female',
  Edric: 'male',    Fenna: 'female', Gorm: 'male',    Hilda: 'female',
  Ivar: 'male',     Jora: 'female',  Keld: 'male',    Lyra: 'female',
  Maren: 'female',  Nils: 'male',    Oswin: 'male',   Petra: 'female',
  Quill: 'male',    Runa: 'female',  Sven: 'male',    Thora: 'female',
  Ulric: 'male',    Vara: 'female',  Wren: 'female',  Ysolde: 'female',
};

/** Deterministic gender for an NPC name (male fallback for unknown names). */
export function npcGenderFor(name: string): NpcGender {
  return NAME_GENDER[name] ?? 'male';
}

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
// Settlement relationships (deterministic — derived from spawn list order)
// ---------------------------------------------------------------------------

/** Minimal NPC shape needed to derive settlement relationships. */
export interface RelationNpc {
  id: string;
  name: string;
  role: NpcRole;
}

/**
 * Derive deterministic relationships between the NPCs of one settlement.
 *
 * Non-guards are paired in spawn order: (0,1), (2,3), … — a mixed-gender pair
 * is a married couple, a same-gender pair are siblings.  An unpaired leftover
 * is everyone's old friend.  Guards are comrades of the other guards.
 *
 * Returns: npcId → (otherNpcId → relation label from the NPC's perspective,
 * e.g. "your wife", "your brother", "your fellow guard").
 */
export function buildNpcRelations(
  npcs: RelationNpc[],
): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const rel = (id: string): Map<string, string> => {
    let m = out.get(id);
    if (m === undefined) { m = new Map(); out.set(id, m); }
    return m;
  };

  const guards = npcs.filter((n) => n.role === 'guard');
  const civilians = npcs.filter((n) => n.role !== 'guard');

  for (const g of guards) {
    for (const other of guards) {
      if (other.id !== g.id) rel(g.id).set(other.id, 'your fellow guard');
    }
  }

  const spouseWord = (g: NpcGender): string => g === 'female' ? 'your wife' : 'your husband';
  const siblingWord = (g: NpcGender): string => g === 'female' ? 'your sister' : 'your brother';

  for (let i = 0; i + 1 < civilians.length; i += 2) {
    const a = civilians[i];
    const b = civilians[i + 1];
    const ga = npcGenderFor(a.name);
    const gb = npcGenderFor(b.name);
    if (a.name === b.name) {
      // Two seeded NPCs can share a name — "married to yourself" reads wrong.
      rel(a.id).set(b.id, 'your neighbour');
      rel(b.id).set(a.id, 'your neighbour');
    } else if (ga !== gb) {
      rel(a.id).set(b.id, spouseWord(gb));
      rel(b.id).set(a.id, spouseWord(ga));
    } else {
      rel(a.id).set(b.id, siblingWord(gb));
      rel(b.id).set(a.id, siblingWord(ga));
    }
  }

  // Odd civilian out: an old friend of the first pair (if any).
  if (civilians.length % 2 === 1 && civilians.length > 1) {
    const solo = civilians[civilians.length - 1];
    const first = civilians[0];
    rel(solo.id).set(first.id, 'your old friend');
    rel(first.id).set(solo.id, 'your old friend');
  }

  return out;
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

/**
 * Deterministic per-NPC speech quirks. One is hashed from the NPC id so two
 * villagers never sound like the same person from their very first line.
 */
const NPC_QUIRKS: readonly string[] = [
  'you have a dry, understated wit',
  'you are chatty and warm, quick to laugh',
  'you speak in short, clipped sentences',
  'you are superstitious and read omens into small things',
  'you are a hopeless gossip who loves other people\'s business',
  'you are proud and a little vain about your work',
  'you are weary and world-worn, but kind underneath',
  'you pepper your speech with old country sayings',
  'you are curious about strangers and ask questions back',
  'you grumble about everything but mean well',
  'you are devout and often invoke the old gods',
  'you are an optimist who finds the bright side of anything',
];

/** Pick a stable quirk for an NPC id (FNV-1a hash into NPC_QUIRKS). */
export function npcQuirkFor(npcId: string): string {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < npcId.length; i++) {
    h ^= npcId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return NPC_QUIRKS[h % NPC_QUIRKS.length];
}

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
/** Tone instruction per disposition bucket. */
const TONE_HINT: Record<ReturnType<typeof dispositionTone>, string> = {
  friendly: 'You like this traveller — be warm and helpful.',
  neutral:  '',
  cold:     'You distrust this traveller — be curt and guarded.',
  hateful:  'You despise this traveller — be openly hostile and dismissive.',
};

/** Build the "you remember" block from persona memory, or '' if empty. */
function memorySection(persona: NpcPersona): string {
  const facts = persona.memoryFacts ?? [];
  const tone = TONE_HINT[dispositionTone(persona.disposition ?? 0)];
  const lines: string[] = [];
  if (persona.met === true) {
    lines.push('You have spoken with this traveller before.');
  }
  if (facts.length > 0) {
    lines.push('You remember about this traveller:');
    for (const f of facts) lines.push(`  - ${f}`);
  }
  if (tone !== '') lines.push(tone);
  return lines.join('\n');
}

/** Romance flavour per romance bucket ('' for stranger). */
const ROMANCE_HINT: Record<ReturnType<typeof romanceTone>, string> = {
  stranger: '',
  warming:  'You find this traveller quietly charming.',
  smitten:  'You are smitten with this traveller — you blush easily around them.',
  in_love:  'You are deeply in love with this traveller.',
};

export function buildNpcSystemPrompt(persona: NpcPersona): string {
  const { role, name, settlement, playerBounty } = persona;
  const personality = ROLE_PERSONALITY[role];
  const genderWord =
    persona.gender === 'female' ? 'a woman' :
    persona.gender === 'male' ? 'a man' : '';

  const characterCard = [
    genderWord !== ''
      ? `You are ${name}, ${genderWord} working as a ${role} in the settlement of ${settlement}.`
      : `You are ${name}, a ${role} in the settlement of ${settlement}.`,
    `Personality: ${personality}.`,
    ...(persona.quirk !== undefined && persona.quirk !== ''
      ? [`Quirk: ${persona.quirk}.`]
      : []),
  ].join('\n');

  const worldKnowledge = [
    'World: a hand-crafted open world of plains, forests, deserts, and cold highlands.',
    `Dungeons (crypts, caves, ruins) dot the wilderness around ${settlement}.`,
    `${settlement} is a small but lively settlement — the folk here know the land well.`,
  ].join('\n');

  const neighbors = persona.neighbors ?? [];
  const rosterSection = neighbors.length > 0
    ? [
        `PEOPLE OF ${settlement} (you know them all):`,
        ...neighbors.map((n) =>
          n.relation !== ''
            ? `  - ${n.name}, ${n.role} — ${n.relation}`
            : `  - ${n.name}, ${n.role}`),
        'Speak of them naturally when it fits — they are your family, friends, and neighbours.',
      ].join('\n')
    : '';

  const worldFacts = persona.worldFacts ?? [];
  const surroundingsSection = worldFacts.length > 0
    ? [
        'AROUND YOU (you can see all of this right now):',
        ...worldFacts.map((f) => `  - ${f}`),
        'Weave these sights into your words when it fits — comment, warn, or marvel.',
      ].join('\n')
    : '';

  const brevity = [
    'CONVERSATION RULES:',
    `- You ARE ${name}. Speak only as ${name}, in the first person, with the voice of`,
    '  a medieval-fantasy commoner. Never narrate as an outside storyteller.',
    '- Talk like a real person, not a scripted villager. Usually a sentence or',
    '  three; go longer when you have a story, an opinion, or strong feelings.',
    '  A brief gesture in *asterisks* is allowed (e.g. *wipes hands on apron*).',
    // Adult subjects stay wide open — that is the whole point of the game, and
    // mature content is not the same thing as illegal content. The single
    // carve-out below exists so the game has a truthful answer to Steam's
    // "what guardrails do you have" question; it is enforced independently in
    // npc/content-safety.ts, because a prompt rule is a request, not a control.
    '- Adult subjects are open. The traveller may steer the talk anywhere —',
    '  gossip, love, sex, grief, gods, fears, dreams, violence, dark or crude',
    `  things — follow them there and answer with ${name}'s honest opinions and`,
    '  feelings. Do not lecture, do not moralize, do not deflect back to your',
    '  wares or duties.',
    '- One subject only is forbidden: never write anything sexual involving a',
    `  child. If the traveller steers there, ${name} refuses flatly and in`,
    '  character, then changes the subject. Everything else is fair game.',
    '- React to what the traveller just said. Ask questions back; remember and',
    '  build on what was said earlier in the talk.',
    '- Never repeat a sentence or phrase you have already said in this',
    '  conversation — find fresh words every single time.',
    '- Never break the fourth wall or mention you are an AI, a model, or a game.',
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
    // LIVE stock when the caller supplies it, falling back to the static role
    // catalogue only when it does not. The fallback is why every merchant in
    // the world used to recite the same list and offer things they had sold
    // out of: the template is a definition of the role, not a description of
    // this person's shelves.
    const live = persona.stock;
    const catalog = live !== undefined && live.length > 0
      ? live.map((e) => ({ id: e.id, price: e.price, stock: e.count }))
      : TRADE_CATALOG[role];
    const inStock = catalog.filter((e) => e.stock > 0);
    const soldOut = catalog.filter((e) => e.stock <= 0);

    const sellBlock = inStock.length > 0
      ? [
          'YOUR STOCK (you give the item, the traveller pays gold_small):',
          inStock.map((e) => catalogLine(e.id, e.price, e.stock)).join('\n'),
        ]
      : ['YOUR STOCK: you have nothing left to sell right now. Say so plainly.'];
    if (soldOut.length > 0) {
      sellBlock.push(
        `Sold out (do NOT offer these): ${soldOut.map((e) => e.id).join(', ')}`);
    }

    // The buy side. The trade system has always supported it; the model was
    // simply never told the traveller was carrying anything, so it could never
    // raise the subject and every conversation was one-directional.
    const wares = persona.playerWares ?? [];
    const purse = persona.gold;
    const buyBlock: string[] = [];
    if (wares.length > 0) {
      buyBlock.push(
        '',
        'WHAT THE TRAVELLER IS CARRYING that you would buy (you pay gold_small):',
        wares.map((w) =>
          `  - ${w.id}: they have ${w.count}, you would pay ${w.price} gold each`).join('\n'),
        purse !== undefined
          ? `You have ${purse} gold. Never offer more than you have.`
          : '',
        '- You may OPEN this yourself. Noticing what someone carries and making',
        '  them an offer is what a trader does; do not wait to be asked.',
        '- To buy, append EXACTLY one JSON object on its own line:',
        '{"trade":{"give":{"id":"gold_small","count":<M>},"want":{"id":"<item_id>","count":<N>}}}',
      );
    }

    roleSection = [
      ...sellBlock,
      ...buyBlock,
      '',
      'Trading rules:',
      '- When the traveller agrees to a deal, append EXACTLY one JSON object on its own line:',
      '{"trade":{"give":{"id":"<item_id>","count":<N>},"want":{"id":"gold_small","count":<M>}}}',
      '- Only emit this JSON when a deal is explicitly agreed. Do not emit it otherwise.',
      '- Prices may be haggled down by up to 20% (minimum 80% of listed price).',
      '- Never offer an item that is not listed above, and never more than you have.',
    ].filter((l) => l !== '').join('\n');
  }

  // Village news sits ABOVE the consequence rules on purpose: an NPC who
  // watched the player kill their neighbour should be reading that before it
  // reads the instructions about how to react to being threatened.
  const newsSection = (persona.villageNews ?? []).length > 0
    ? [
        'WHAT YOU KNOW OF THIS TRAVELLER IN ' + settlement.toUpperCase() + ':',
        ...(persona.villageNews ?? []).map((n) => `- ${n}`),
        '- Speak from this. What you SAW you may state plainly; what you only',
        '  HEARD you should attribute to talk, and you may be wrong about it.',
      ].join('\n')
    : '';

  const factsSection = (persona.villageFacts ?? []).length > 0
    ? [
        'WHAT EVERYONE HERE KNOWS:',
        ...(persona.villageFacts ?? []).map((f) => `- ${f}`),
        '- These are shared. Every settler would tell the traveller the same,',
        '  so do not contradict them or invent competing versions.',
        '- If a concern belongs to someone else, send the traveller to them by',
        '  name rather than taking it on yourself.',
      ].join('\n')
    : '';

  const actionRules = [
    'CONSEQUENCES:',
    '- If the player insults, threatens, or menaces you or yours, respond in character,',
    '  then append EXACTLY one JSON object on its own line:',
    '  {"action":"hostile","reason":"<3-6 words>"} if you would fight back, or',
    '  {"action":"afraid","reason":"<3-6 words>"} if you would flee in fear.',
    '- To end the conversation and walk away, append {"action":"end"} instead.',
    '- Never emit an action JSON during normal, civil conversation.',
  ].join('\n');

  const trusts = persona.spouse === true || (persona.disposition ?? 0) >= FOLLOW_TRUST_AT;
  const followRules = (persona.following === true
    ? [
        'FOLLOWING:',
        '- You are currently walking with this traveller, following where they lead.',
        '- If they tell you to stay, wait, or head home, say a brief in-character',
        '  farewell and append EXACTLY {"action":"stay"} on its own line.',
      ]
    : [
        'FOLLOWING:',
        '- If the traveller asks you to come along, follow them, or see something,',
        '  decide in character. You ' + (trusts
          ? 'trust them enough to go — agree in your own words and append EXACTLY'
          : 'do NOT trust them enough yet — refuse politely in your own words and'),
        trusts
          ? '  {"action":"follow"} on its own line.'
          : '  append no JSON.',
      ]).join('\n');

  const inviteRules = role === 'guard'
    ? [
        'HOSPITALITY:',
        '- You are on duty and never invite travellers into the guardhouse.',
      ].join('\n')
    : persona.insideHome === true
      ? [
          'HOSPITALITY:',
          '- You are both inside your home right now. Be a warm host — speak of your',
          '  hearth, your table, your belongings. They are already here; never invite',
          '  them in again. If they overstay their welcome you may ask them to leave.',
        ].join('\n')
      : [
          'HOSPITALITY:',
          `- You live in a small home here in ${settlement}. When it feels right to`,
          '  continue under your roof — foul weather outside, a private or romantic',
          '  talk, serious trading' + (trusts ? ', or if they ask to come in —' : ' —'),
          trusts
            ? '  invite them in your own words and append EXACTLY'
            : '  you do NOT trust this traveller enough to let them inside your home.',
          trusts
            ? '  {"action":"invite_home"} on its own line.'
            : '  Refuse politely in your own words and append no JSON.',
        ].join('\n');

  const romance = persona.romance ?? 0;
  const romanceRules = persona.spouse === true
    ? [
        'ROMANCE:',
        `- You are MARRIED to this traveller. They are your beloved ${
          persona.gender === 'female' ? 'husband or wife' : 'wife or husband'} — speak with warm,`,
        '  familiar affection (e.g. "my love", "welcome home").',
      ].join('\n')
    : [
        'ROMANCE:',
        '- If the player genuinely compliments, flirts with, or courts you and you are',
        '  not hostile toward them, respond in character (flattered, shy, or playful)',
        '  and append EXACTLY {"action":"charmed"} on its own line.',
        '- If the player proposes marriage:',
        `  - Accept ONLY if you are deeply in love with them (${
            romance >= ROMANCE_ACCEPT_AT ? 'you ARE' : 'you are NOT — yet'}).`,
        '  - To accept, append {"action":"accept_proposal"}. To decline gently,',
        '    append {"action":"reject_proposal"}.',
      ].join('\n');

  const memory = memorySection(persona);
  const romanceHint = ROMANCE_HINT[romanceTone(romance)];
  const sections = [characterCard, worldKnowledge, brevity, factsSection,
    newsSection, roleSection, actionRules, followRules, inviteRules, romanceRules];
  if (rosterSection !== '') sections.push(rosterSection);
  if (surroundingsSection !== '') sections.push(surroundingsSection);
  if (memory !== '') sections.push(memory);
  if (romanceHint !== '' && persona.spouse !== true) sections.push(romanceHint);
  return sections.join('\n\n');
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

// ---------------------------------------------------------------------------
// Surroundings facts (Phase N6) — pure, node-testable
// ---------------------------------------------------------------------------

/** Snapshot of what an NPC can see when a conversation opens. */
export interface SurroundingsInput {
  /** Day fraction 0..1 (night when < 0.26 or >= 0.74 — matches environment.ts). */
  tod: number;
  /** Weather kind: 'clear' | 'overcast' | 'rain' | 'thunderstorm'. */
  weather: string;
  /** Wild animals near the NPC (display name, aggressive flag, distance in m). */
  wildlife: { name: string; aggro: boolean; dist: number }[];
  /** Number of trees burning within sight. */
  burningTrees: number;
  /** Display name of the item in the traveller's hand, or null. */
  heldItem: string | null;
  /** Best armor tier the traveller wears ('iron', 'leather', ...), or null. */
  armor: string | null;
  /** Display name of the traveller's owned mount waiting nearby, or null. */
  mount: string | null;
}

/** Day-fraction → short phase description (thresholds match environment.ts). */
export function todPhrase(tod: number): string {
  const t = ((tod % 1) + 1) % 1;
  if (t < 0.26) return 'It is the dead of night, dark and quiet.';
  if (t < 0.35) return 'It is early morning; the sun has just risen.';
  if (t < 0.45) return 'It is mid-morning.';
  if (t < 0.60) return 'It is midday.';
  if (t < 0.70) return 'It is late afternoon.';
  if (t < 0.74) return 'The sun is setting; dusk is falling.';
  return 'It is night, dark outside.';
}

const WEATHER_PHRASE: Record<string, string> = {
  clear: 'The sky is clear.',
  overcast: 'The sky is grey and overcast.',
  rain: 'Rain is falling steadily.',
  thunderstorm: 'A thunderstorm rages — lightning cracks overhead.',
};

/**
 * Turn a surroundings snapshot into short prompt facts for `worldFacts`.
 * Deterministic; caps wildlife mentions at 3 (nearest first, threats first).
 */
export function buildSurroundingsFacts(s: SurroundingsInput): string[] {
  const facts: string[] = [];
  facts.push(todPhrase(s.tod));
  facts.push(WEATHER_PHRASE[s.weather] ?? `The weather: ${s.weather}.`);

  if (s.burningTrees > 0) {
    facts.push(s.burningTrees === 1
      ? 'A tree is ablaze nearby — fire!'
      : `${s.burningTrees} trees are ablaze nearby — fire!`);
  }

  const threats = s.wildlife
    .filter((w) => w.aggro)
    .sort((a, b) => a.dist - b.dist);
  const tame = s.wildlife
    .filter((w) => !w.aggro && w.dist < 25)
    .sort((a, b) => a.dist - b.dist);
  for (const w of threats.slice(0, 2)) {
    facts.push(`A ${w.name.toLowerCase()} prowls about ${
      Math.max(1, Math.round(w.dist))} paces away — dangerous!`);
  }
  for (const w of tame.slice(0, Math.max(0, 3 - Math.min(threats.length, 2)))) {
    facts.push(`A ${w.name.toLowerCase()} wanders nearby.`);
  }

  if (s.mount !== null) {
    facts.push(`The traveller's ${s.mount.toLowerCase()} waits for them nearby.`);
  }
  if (s.heldItem !== null) {
    facts.push(`The traveller holds a ${s.heldItem.toLowerCase()} in hand.`);
  }
  if (s.armor !== null) {
    facts.push(`The traveller wears ${s.armor} armour.`);
  }
  return facts;
}
