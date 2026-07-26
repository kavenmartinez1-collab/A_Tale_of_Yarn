/**
 * village-facts.ts — shared knowledge a settlement holds in common.
 *
 * ## Why this and `village-memory.ts` are different things
 *
 * `village-memory.ts` records what the PLAYER DID and who saw it. This records
 * what the village KNOWS — things true of the world that existed before the
 * player walked in, and that several NPCs can talk about consistently.
 *
 * Two problems it solves, which turn out to be the same problem:
 *
 *  1. **Consistency.** Ask a farmer about the well and then ask the smith, and
 *     you used to get two unrelated inventions, because each NPC's only
 *     context was its own opinion of you. Every NPC in a settlement now reads
 *     the same fact list, so they agree — and a fact can name an OWNER, which
 *     is what lets one NPC say "Nils would know more about that" and have Nils
 *     actually know.
 *
 *  2. **Quests.** A quest is just a fact with something to do about it. Giving
 *     concerns a completable `task` means the same store that makes NPCs
 *     consistent also gives them something to ask for, without a separate
 *     quest system that would have to be kept in sync with it.
 *
 * ## Why concerns are generated deterministically, not by the LLM
 *
 * The Director could invent these, and eventually should. But a quest the
 * player can complete has to be checkable — a kill count, an item, a reward —
 * and a 1.7B model asked to invent one produces prose, not a contract. So the
 * *structure* is generated deterministically from the settlement seed and what
 * is actually around it, and the model's job is to talk about it in character.
 * That split is also what makes it testable.
 *
 * Pure module: no DOM, no GPU, no I/O beyond the localStorage helpers at the
 * bottom. Node-testable.
 */

import { mix32 } from '../dungeon/dungeon-layout';

export type FactKind = 'concern' | 'lore';

export type TaskVerb = 'kill' | 'bring';

export interface VillageTask {
  verb: TaskVerb;
  /** Species id for `kill`, item id for `bring`. */
  target: string;
  /** How it should be said out loud ("wolves", "hides"). */
  targetName: string;
  count: number;
  done: number;
  rewardGold: number;
  state: 'open' | 'complete' | 'rewarded';
}

export interface VillageFact {
  id: string;
  kind: FactKind;
  /** One short line, as any villager would put it. */
  text: string;
  /**
   * The NPC who is the authority on this.
   *
   * This is the mechanism that makes cross-NPC references work: everyone can
   * mention the fact, but only the owner is told they are the one who knows
   * the details and may ask for help with it. Without an owner, five NPCs all
   * offer the same errand and none of them can finish it.
   */
  ownerId?: string;
  ownerName?: string;
  task?: VillageTask;
}

/** Per-settlement facts, keyed by settlement name. */
export type VillageFacts = Record<string, VillageFact[]>;

export const FACTS_KEY = 'artifex-village-facts:v1';

export function createVillageFacts(): VillageFacts {
  return {};
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

interface ConcernTemplate {
  id: string;
  text: (s: string) => string;
  verb: TaskVerb;
  target: string;
  targetName: string;
  count: [number, number];
  reward: [number, number];
  /** Species that must be plausible nearby for this concern to be generated. */
  needsSpecies?: string;
}

/**
 * The concern pool.
 *
 * Deliberately small and mundane. A village's problems should be livestock and
 * weather, not prophecy — the epic scale belongs to dungeons and dragons, and
 * a farmer asking you to deal with wolves is both more believable and more
 * completable than one asking you to save the world.
 */
const CONCERNS: ConcernTemplate[] = [
  {
    id: 'wolves',
    text: (s) => `Wolves have been taking livestock on the edge of ${s}.`,
    verb: 'kill', target: 'wolf', targetName: 'wolves',
    count: [3, 5], reward: [25, 45], needsSpecies: 'wolf',
  },
  {
    id: 'bear',
    text: (s) => `A bear has been seen too close to ${s}, and nobody will walk the north path.`,
    verb: 'kill', target: 'bear', targetName: 'the bear',
    count: [1, 1], reward: [40, 70], needsSpecies: 'bear',
  },
  {
    id: 'hides',
    text: () => 'The tanner is short of hides before the cold comes.',
    verb: 'bring', target: 'hide', targetName: 'hides',
    count: [4, 8], reward: [18, 32],
  },
  {
    id: 'meat',
    text: (s) => `${s} is short of salted meat for the winter stores.`,
    verb: 'bring', target: 'meat_raw', targetName: 'raw meat',
    count: [5, 10], reward: [15, 28],
  },
  {
    id: 'ore',
    text: () => 'The smith has run down his iron and the forge stands cold.',
    verb: 'bring', target: 'iron_ore', targetName: 'iron ore',
    count: [3, 6], reward: [30, 50],
  },
];

/** Lore has no task — it exists so NPCs agree about the world. */
const LORE: ((s: string) => string)[] = [
  (s) => `${s} draws its water from a single well in the square; it has never run dry.`,
  (s) => `The road out of ${s} is not safe after dark, and everyone here knows it.`,
  (s) => `${s} pays no lord. What is decided here is decided by those who live here.`,
  (s) => `There are older ruins under the hills near ${s}. Nobody sensible goes in.`,
];

const rand = (h: number, lo: number, hi: number): number =>
  lo + (h % Math.max(1, hi - lo + 1));

/**
 * Generate a settlement's shared knowledge, deterministically.
 *
 * Same settlement and seed always produce the same facts, so an NPC cannot
 * contradict itself between two conversations, and a reload does not rewrite
 * the village's history. `nearbySpecies` gates concerns on what actually lives
 * around here — asking the player to cull wolves in a place with no wolves is
 * the kind of detail that destroys the illusion in one line.
 */
export function generateVillageFacts(
  settlement: string,
  seed: number,
  npcs: readonly { id: string; name: string; role: string }[],
  nearbySpecies: readonly string[],
): VillageFact[] {
  const out: VillageFact[] = [];
  const base = mix32(seed ^ 0x5641, settlement.length * 977, npcs.length * 31);

  // One or two concerns, owned by whoever fits. Guards are excluded as owners:
  // a guard asking you to fetch hides reads wrong, and they already have the
  // bounty conversation.
  const civilians = npcs.filter((n) => n.role !== 'guard');
  const eligible = CONCERNS.filter((c) =>
    c.needsSpecies === undefined || nearbySpecies.includes(c.needsSpecies));

  const wanted = civilians.length === 0 ? 0 : 1 + (base % 2);
  for (let i = 0; i < wanted && eligible.length > 0; i++) {
    const h = mix32(base, i * 7919, 0);
    const tpl = eligible[h % eligible.length];
    if (out.some((f) => f.id === `${settlement}:${tpl.id}`)) continue;
    const owner = civilians[mix32(base, i * 131, 5) % civilians.length];
    out.push({
      id: `${settlement}:${tpl.id}`,
      kind: 'concern',
      text: tpl.text(settlement),
      ownerId: owner.id,
      ownerName: owner.name,
      task: {
        verb: tpl.verb,
        target: tpl.target,
        targetName: tpl.targetName,
        count: rand(mix32(base, i, 11), tpl.count[0], tpl.count[1]),
        done: 0,
        rewardGold: rand(mix32(base, i, 23), tpl.reward[0], tpl.reward[1]),
        state: 'open',
      },
    });
  }

  // One piece of lore everybody shares. This is what makes two NPCs agree
  // about the world rather than each inventing their own.
  const lore = LORE[mix32(base, 4441, 0) % LORE.length];
  out.push({ id: `${settlement}:lore`, kind: 'lore', text: lore(settlement) });

  return out;
}

/** Facts for a settlement, generating them on first visit. */
export function factsFor(
  store: VillageFacts,
  settlement: string,
  seed: number,
  npcs: readonly { id: string; name: string; role: string }[],
  nearbySpecies: readonly string[],
): VillageFact[] {
  const existing = store[settlement];
  if (existing !== undefined) return existing;
  const made = generateVillageFacts(settlement, seed, npcs, nearbySpecies);
  store[settlement] = made;
  return made;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/**
 * Advance any open task matching `verb`/`target`, across every settlement.
 *
 * Global on purpose: killing a wolf twenty metres outside the village still
 * counts, and the player should never have to guess at an invisible boundary.
 * Returns the facts that changed, so the caller can tell the player.
 */
export function advanceTasks(
  store: VillageFacts,
  verb: TaskVerb,
  target: string,
  amount = 1,
): VillageFact[] {
  const changed: VillageFact[] = [];
  for (const list of Object.values(store)) {
    for (const f of list) {
      const t = f.task;
      if (t === undefined || t.state !== 'open') continue;
      if (t.verb !== verb || t.target !== target) continue;
      t.done = Math.min(t.count, t.done + amount);
      if (t.done >= t.count) t.state = 'complete';
      changed.push(f);
    }
  }
  return changed;
}

/** Mark a completed task as paid out. Returns the reward, or 0. */
export function claimReward(fact: VillageFact): number {
  const t = fact.task;
  if (t === undefined || t.state !== 'complete') return 0;
  t.state = 'rewarded';
  return t.rewardGold;
}

// ---------------------------------------------------------------------------
// Reading it back for the prompt
// ---------------------------------------------------------------------------

/**
 * What this NPC should be told, as prompt lines.
 *
 * The owner of a concern is told it is theirs and what they are asking for;
 * everyone else is told it exists and **who to ask**. That asymmetry is the
 * whole consistency mechanism — it is what makes "you should speak to Nils"
 * true rather than a pleasant invention.
 */
export function factLinesFor(
  facts: readonly VillageFact[],
  npcId: string,
): string[] {
  const out: string[] = [];
  for (const f of facts) {
    if (f.kind === 'lore') { out.push(f.text); continue; }
    const t = f.task;
    if (t === undefined) { out.push(f.text); continue; }

    if (f.ownerId === npcId) {
      if (t.state === 'rewarded') {
        out.push(`${f.text} The traveller dealt with it, and you have paid them.`);
      } else if (t.state === 'complete') {
        out.push(`${f.text} THIS IS YOUR CONCERN. The traveller has done what you `
          + `asked (${t.count} ${t.targetName}). Thank them and pay the `
          + `${t.rewardGold} gold you promised.`);
      } else {
        out.push(`${f.text} THIS IS YOUR CONCERN — you are the one asking. You want `
          + `${t.count} ${t.targetName}${t.done > 0 ? ` (${t.done} so far)` : ''}, `
          + `and you will pay ${t.rewardGold} gold. Raise it if the talk allows.`);
      }
    } else {
      const who = f.ownerName ?? 'someone here';
      out.push(t.state === 'rewarded'
        ? `${f.text} It has been dealt with.`
        : `${f.text} ${who} is the one troubled by it — send the traveller to them.`);
    }
  }
  return out;
}

/** Open concerns owned by this NPC, for reward payout. */
export function completedTasksOwnedBy(
  facts: readonly VillageFact[],
  npcId: string,
): VillageFact[] {
  return facts.filter((f) =>
    f.ownerId === npcId && f.task?.state === 'complete');
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function loadVillageFacts(): VillageFacts {
  try {
    const raw = localStorage.getItem(FACTS_KEY);
    if (raw === null) return createVillageFacts();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return createVillageFacts();
    }
    const out: VillageFacts = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      out[k] = v.filter((f): f is VillageFact =>
        typeof f === 'object' && f !== null
        && typeof (f as VillageFact).id === 'string'
        && typeof (f as VillageFact).text === 'string');
    }
    return out;
  } catch {
    return createVillageFacts();
  }
}

export function saveVillageFacts(store: VillageFacts): void {
  try {
    localStorage.setItem(FACTS_KEY, JSON.stringify(store));
  } catch {
    // Quota or private mode; regenerating is deterministic and harmless.
  }
}
