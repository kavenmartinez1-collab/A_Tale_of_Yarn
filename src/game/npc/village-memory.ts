/**
 * village-memory.ts — shared, per-settlement memory of things the player did.
 *
 * ## The problem this solves
 *
 * Every memory in this game was DYADIC: `NpcMemoryRecord` records what one NPC
 * thinks of the player, and nothing else. Two consequences, both of which read
 * to a player as the NPCs being hollow:
 *
 *  - **Nobody witnesses anything.** Attack a farmer in the square and the
 *    farmer standing next to them has no idea it happened. The crime system
 *    does notice — but it files an anonymous `{kind, t}` row against a REGION
 *    and raises a bounty. Nobody knows *who* did *what* to *whom*, so no NPC
 *    can ever mention it.
 *  - **Nothing is shared.** Two NPCs can never be consistent about an event,
 *    because there is no event — only two unrelated opinions of the player.
 *
 * ## The model
 *
 * A settlement keeps a short log of notable things the player did. Each entry
 * knows who saw it directly, and who has since heard about it. NPCs are told,
 * in their prompt, what they know — and crucially, whether they SAW it or were
 * TOLD, because "I watched you do that" and "they say you did that" are
 * completely different conversations.
 *
 * Knowledge spreads along the settlement's existing relationship graph
 * (`buildNpcRelations`): spouses and siblings tell each other quickly, guards
 * tell guards, everyone else picks things up more slowly. That graph already
 * existed and was used only for flavour.
 *
 * ## What this deliberately is NOT
 *
 * It is not a general world-state or quest system, and it does not attempt to
 * make NPCs consistent about arbitrary claims ("Nils knows where the well
 * is"). Those need a shared FACT store with provenance, which is a larger
 * piece; this is the substrate it would be built on. What this does give is
 * consistency about *events the player caused*, which is where the absence was
 * most glaring.
 *
 * Pure module: no DOM, no GPU, no I/O beyond localStorage helpers at the
 * bottom. Node-testable.
 */

/** What kind of thing happened. Drives severity and phrasing. */
export type VillageEventKind =
  | 'attacked_npc'
  | 'killed_npc'
  | 'stole'
  | 'threatened'
  | 'helped'
  | 'gave_gift'
  | 'traded'
  | 'married'
  | 'killed_livestock';

/** How much each kind moves a witness's opinion of the player. */
export const EVENT_DISPOSITION: Record<VillageEventKind, number> = {
  killed_npc: -70,
  attacked_npc: -35,
  threatened: -15,
  stole: -25,
  killed_livestock: -12,
  traded: 1,
  helped: 12,
  gave_gift: 6,
  married: 8,
};

/**
 * How readily each kind travels. 1 = spreads on the first opportunity,
 * higher = needs more retellings.
 *
 * A killing is the talk of the village by nightfall; a routine trade barely
 * leaves the stall it happened at.
 */
const SPREAD_COST: Record<VillageEventKind, number> = {
  killed_npc: 1,
  attacked_npc: 1,
  threatened: 2,
  stole: 2,
  killed_livestock: 2,
  married: 1,
  helped: 2,
  gave_gift: 3,
  traded: 4,
};

export interface VillageEvent {
  /** Stable id, so re-recording the same happening cannot duplicate it. */
  id: string;
  /** Game seconds when it happened. */
  t: number;
  kind: VillageEventKind;
  /** The NPC it was done to, if any. */
  subjectId?: string;
  /** That NPC's display name, so the prompt can say "Petra" not an id. */
  subjectName?: string;
  /** NPC ids who saw it happen with their own eyes. */
  witnessed: string[];
  /** NPC ids who have heard about it (always a superset of `witnessed`). */
  known: string[];
}

/** Per-settlement log. Keyed by settlement name. */
export type VillageMemory = Record<string, VillageEvent[]>;

/** Events kept per settlement. Old news stops being news. */
export const VILLAGE_LOG_MAX = 24;

export const VILLAGE_KEY = 'artifex-village:v1';

export function createVillageMemory(): VillageMemory {
  return {};
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Record something the player did in a settlement.
 *
 * `witnesses` are the NPCs who could actually see it — the caller decides
 * that, because only it knows where everyone is standing. An event with no
 * witnesses is still recorded: it happened, and it can surface later if
 * somebody finds the body.
 */
export function recordVillageEvent(
  mem: VillageMemory,
  settlement: string,
  ev: Omit<VillageEvent, 'known'>,
): VillageEvent {
  const log = mem[settlement] ?? (mem[settlement] = []);
  const existing = log.find((e) => e.id === ev.id);
  if (existing !== undefined) return existing;

  const full: VillageEvent = { ...ev, known: [...ev.witnessed] };
  log.push(full);
  if (log.length > VILLAGE_LOG_MAX) {
    log.splice(0, log.length - VILLAGE_LOG_MAX);
  }
  return full;
}

/**
 * Who could see something at (x, z), given where NPCs are standing.
 *
 * Deliberately a plain radius with no line-of-sight test. The crime system
 * already has `isWitnessed` with an LOS flag the caller supplies; this is the
 * social layer and a slightly generous radius is the right error — a villager
 * hearing a scream and coming to look is entirely believable, whereas one who
 * stood ten feet away and noticed nothing is not.
 */
export function witnessesNear(
  npcs: readonly { id: string; x: number; z: number }[],
  x: number,
  z: number,
  radius: number,
): string[] {
  const out: string[] = [];
  for (const n of npcs) {
    if (Math.hypot(n.x - x, n.z - z) <= radius) out.push(n.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Spread
// ---------------------------------------------------------------------------

/**
 * Spread news one step along the relationship graph.
 *
 * Called when the player opens a conversation — the village has had time to
 * talk while they were away. Each pass moves an event from anyone who knows it
 * to their relations, gated by the event's `SPREAD_COST` so gossip travels at
 * a rate that suits how shocking it is.
 *
 * `relations` is the map from `buildNpcRelations`: npcId → (otherId → label).
 * Using it means a killing reaches the victim's spouse before it reaches a
 * stranger across the village, without any special-casing.
 */
export function spreadVillageNews(
  mem: VillageMemory,
  settlement: string,
  relations: Map<string, Map<string, string>>,
  passes = 1,
): number {
  const log = mem[settlement];
  if (log === undefined) return 0;
  let told = 0;

  for (let p = 0; p < passes; p++) {
    for (const ev of log) {
      // Cheap gossip spreads every pass; dear gossip every Nth.
      if (p % SPREAD_COST[ev.kind] !== 0) continue;
      const knowers = [...ev.known];
      for (const who of knowers) {
        const rel = relations.get(who);
        if (rel === undefined) continue;
        for (const other of rel.keys()) {
          if (!ev.known.includes(other)) {
            ev.known.push(other);
            told++;
          }
        }
      }
    }
  }
  return told;
}

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

/** One line of news as an NPC would put it. */
export interface NewsLine {
  text: string;
  /** True when this NPC saw it themselves. */
  firsthand: boolean;
  t: number;
}

function phrase(ev: VillageEvent, firsthand: boolean, selfId: string): string {
  const who = ev.subjectId === selfId
    ? 'me'
    : ev.subjectName !== undefined ? ev.subjectName : 'one of us';
  const act: Record<VillageEventKind, string> = {
    killed_npc: `killed ${who}`,
    attacked_npc: `attacked ${who}`,
    threatened: `threatened ${who}`,
    stole: 'stole from us',
    killed_livestock: 'killed our livestock',
    helped: `helped ${who}`,
    gave_gift: `gave ${who} a gift`,
    traded: `traded with ${who}`,
    married: `married ${who}`,
  };
  // Firsthand is stated as memory, hearsay as report. The distinction is the
  // whole point: an NPC who watched you do something should not sound like one
  // repeating a rumour, and vice versa.
  return firsthand
    ? `You saw the traveller ${act[ev.kind]}.`
    : `You have heard the traveller ${act[ev.kind]}.`;
}

/**
 * What this NPC knows, newest first, ready for the prompt.
 *
 * Firsthand accounts are listed before hearsay regardless of age — what you
 * saw yourself outranks what you were told, in conversation as in life.
 */
export function newsFor(
  mem: VillageMemory,
  settlement: string,
  npcId: string,
  limit = 5,
): NewsLine[] {
  const log = mem[settlement];
  if (log === undefined) return [];
  const out: NewsLine[] = [];
  for (const ev of log) {
    if (!ev.known.includes(npcId)) continue;
    const firsthand = ev.witnessed.includes(npcId);
    out.push({ text: phrase(ev, firsthand, npcId), firsthand, t: ev.t });
  }
  out.sort((a, b) => (a.firsthand === b.firsthand ? b.t - a.t : a.firsthand ? -1 : 1));
  return out.slice(0, limit);
}

/**
 * Total disposition shift an NPC should carry from what it knows.
 *
 * Hearsay counts for less than seeing it — a third, rounded toward zero. That
 * ratio is what stops one killing from turning an entire village hateful the
 * moment the news travels, while still making it cost you something everywhere.
 */
export function dispositionFromNews(
  mem: VillageMemory,
  settlement: string,
  npcId: string,
): number {
  const log = mem[settlement];
  if (log === undefined) return 0;
  let total = 0;
  for (const ev of log) {
    if (!ev.known.includes(npcId)) continue;
    const base = EVENT_DISPOSITION[ev.kind];
    total += ev.witnessed.includes(npcId) ? base : Math.trunc(base / 3);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function loadVillageMemory(): VillageMemory {
  try {
    const raw = localStorage.getItem(VILLAGE_KEY);
    if (raw === null) return createVillageMemory();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return createVillageMemory();
    }
    // Shallow validation: a corrupt log must degrade to "the village forgot",
    // never to a crash on the first conversation after a bad write.
    const out: VillageMemory = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      out[k] = v.filter((e): e is VillageEvent =>
        typeof e === 'object' && e !== null
        && typeof (e as VillageEvent).id === 'string'
        && typeof (e as VillageEvent).kind === 'string'
        && Array.isArray((e as VillageEvent).witnessed)
        && Array.isArray((e as VillageEvent).known));
    }
    return out;
  } catch {
    return createVillageMemory();
  }
}

export function saveVillageMemory(mem: VillageMemory): void {
  try {
    localStorage.setItem(VILLAGE_KEY, JSON.stringify(mem));
  } catch {
    // Quota or private mode — the village forgetting is survivable.
  }
}
