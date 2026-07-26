/**
 * Dungeon spec — the JSON contract between the AI Director (later) and the
 * deterministic dungeon generator. LLM-friendly on purpose: enums, short ids
 * and small arrays only, NO coordinates — the LLM decides what/why,
 * layoutDungeon() decides where every triangle goes.
 *
 * validateSpec() is hand-rolled (no deps, supply-chain policy). Bad Director
 * output must never crash the game: callers log errors and fall back to
 * FALLBACK_SPEC.
 */

import { screenText } from '../npc/content-safety';

export type DungeonTheme = 'crypt' | 'cave' | 'ruin';
export type RoomType = 'entrance' | 'combat' | 'treasure' | 'boss';
export type RoomSize = 'small' | 'medium' | 'large';

export const KNOWN_ITEMS = [
  'gold_small',
  'gold_large',
  'healing_herb',
  'iron_sword',
  'ancient_relic',
  'torch_oil',
  'old_bone',
  'rusty_key',
  'iron_axe',
  'hunter_bow',
  'oak_staff',
  'iron_helm',
  'iron_flask',
  'healing_potion',
  'feather',
  'bone_needle',
  'dragon_scale',
] as const;
export type ItemId = (typeof KNOWN_ITEMS)[number];

export interface RoomSpec {
  id: string;
  type: RoomType;
  size: RoomSize;
  /** Item ids stashed in this room's chest(s). Max 4. */
  loot?: ItemId[];
}

export interface DungeonSpec {
  version: 1;
  theme: DungeonTheme;
  name: string;
  rooms: RoomSpec[];
  /** Undirected connections between room ids. Must form a connected graph. */
  edges: [string, string][];
}

const THEMES = new Set<string>(['crypt', 'cave', 'ruin']);
const TYPES = new Set<string>(['entrance', 'combat', 'treasure', 'boss']);
const SIZES = new Set<string>(['small', 'medium', 'large']);
const ITEMS = new Set<string>(KNOWN_ITEMS);

const MAX_ROOMS = 12;
const MAX_LOOT = 4;

/**
 * Validate untrusted spec JSON. Returns the typed spec or a list of every
 * problem found (so the Director can be re-prompted with all errors at once).
 */
export function validateSpec(
  x: unknown,
): { spec: DungeonSpec } | { errors: string[] } {
  const errors: string[] = [];
  if (typeof x !== 'object' || x === null || Array.isArray(x)) {
    return { errors: ['spec must be a JSON object'] };
  }
  const o = x as Record<string, unknown>;

  if (o.version !== 1) errors.push('version must be 1');
  if (typeof o.theme !== 'string' || !THEMES.has(o.theme)) {
    errors.push(`theme must be one of ${[...THEMES].join('|')}`);
  }
  if (typeof o.name !== 'string' || o.name.length === 0 || o.name.length > 60) {
    errors.push('name must be a non-empty string (max 60 chars)');
  } else if (screenText(o.name).blocked) {
    // The dungeon name is the ONE free-text field in a director spec that is
    // shown to the player verbatim, so it goes through the same guardrail as
    // NPC dialogue (npc/content-safety.ts). Reported as a validation error
    // rather than silently rewritten, so the director's existing retry path
    // regenerates the spec — see buildRetryMessage.
    errors.push('name is not permitted; choose a different dungeon name');
  }

  // --- rooms -------------------------------------------------------------
  const ids = new Set<string>();
  let entranceCount = 0;
  let bossCount = 0;
  if (!Array.isArray(o.rooms) || o.rooms.length < 2 || o.rooms.length > MAX_ROOMS) {
    errors.push(`rooms must be an array of 2..${MAX_ROOMS}`);
  } else {
    o.rooms.forEach((r: unknown, i: number) => {
      if (typeof r !== 'object' || r === null) {
        errors.push(`rooms[${i}] must be an object`);
        return;
      }
      const room = r as Record<string, unknown>;
      if (typeof room.id !== 'string' || room.id.length === 0 || room.id.length > 24) {
        errors.push(`rooms[${i}].id must be a non-empty string (max 24 chars)`);
      } else if (ids.has(room.id)) {
        errors.push(`duplicate room id "${room.id}"`);
      } else {
        ids.add(room.id);
      }
      if (typeof room.type !== 'string' || !TYPES.has(room.type)) {
        errors.push(`rooms[${i}].type must be one of ${[...TYPES].join('|')}`);
      } else {
        if (room.type === 'entrance') entranceCount++;
        if (room.type === 'boss') bossCount++;
      }
      if (typeof room.size !== 'string' || !SIZES.has(room.size)) {
        errors.push(`rooms[${i}].size must be one of ${[...SIZES].join('|')}`);
      }
      if (room.loot !== undefined) {
        if (!Array.isArray(room.loot) || room.loot.length > MAX_LOOT) {
          errors.push(`rooms[${i}].loot must be an array of at most ${MAX_LOOT} items`);
        } else {
          for (const item of room.loot) {
            if (typeof item !== 'string' || !ITEMS.has(item)) {
              errors.push(`rooms[${i}].loot has unknown item "${String(item)}"`);
            }
          }
        }
      }
    });
    if (entranceCount !== 1) errors.push('exactly one room must have type "entrance"');
    if (bossCount > 1) errors.push('at most one room may have type "boss"');
  }

  // --- edges -------------------------------------------------------------
  const adj = new Map<string, string[]>();
  for (const id of ids) adj.set(id, []);
  if (!Array.isArray(o.edges)) {
    errors.push('edges must be an array of [idA, idB] pairs');
  } else {
    if (Array.isArray(o.rooms) && o.edges.length > 2 * o.rooms.length) {
      errors.push('too many edges (max 2x room count)');
    }
    const seen = new Set<string>();
    o.edges.forEach((e: unknown, i: number) => {
      if (!Array.isArray(e) || e.length !== 2 ||
          typeof e[0] !== 'string' || typeof e[1] !== 'string') {
        errors.push(`edges[${i}] must be a [idA, idB] string pair`);
        return;
      }
      const [a, b] = e as [string, string];
      if (a === b) { errors.push(`edges[${i}] is a self-loop on "${a}"`); return; }
      if (!ids.has(a) || !ids.has(b)) {
        errors.push(`edges[${i}] references unknown room id`);
        return;
      }
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) { errors.push(`duplicate edge ${a}-${b}`); return; }
      seen.add(key);
      adj.get(a)!.push(b);
      adj.get(b)!.push(a);
    });
  }

  // --- connectivity (BFS from entrance) ----------------------------------
  if (errors.length === 0) {
    const rooms = o.rooms as RoomSpec[];
    const start = rooms.find((r) => r.type === 'entrance')!.id;
    const visited = new Set<string>([start]);
    const queue = [start];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const nb of adj.get(cur)!) {
        if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
      }
    }
    if (visited.size !== ids.size) {
      errors.push('room graph is not connected (every room must be reachable from the entrance)');
    }
  }

  if (errors.length > 0) return { errors };
  return { spec: x as DungeonSpec };
}

/** Guaranteed-valid spec used when Director output fails validation. */
export const FALLBACK_SPEC: DungeonSpec = {
  version: 1,
  theme: 'crypt',
  name: 'Forgotten Cellar',
  rooms: [
    { id: 'entry', type: 'entrance', size: 'small' },
    { id: 'hall', type: 'combat', size: 'medium' },
    { id: 'store', type: 'treasure', size: 'small', loot: ['gold_small', 'healing_herb'] },
    { id: 'crypt', type: 'boss', size: 'large', loot: ['gold_large'] },
  ],
  edges: [
    ['entry', 'hall'],
    ['hall', 'store'],
    ['hall', 'crypt'],
  ],
};
