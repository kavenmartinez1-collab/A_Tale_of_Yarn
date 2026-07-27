/**
 * dungeon-enemies.ts — who lives in a dungeon, and where they stand.
 *
 * WHY THIS IS ITS OWN FILE
 *
 * Two reasons, and the second one is the important one.
 *
 * The first is ownership: `dungeon-manager.ts` is 750 lines of GPU lifecycle —
 * buffers, bind groups, colliders — and the roster has nothing to do with any
 * of it.
 *
 * The second is that the manager is UNTESTABLE IN NODE. It imports the
 * renderer, which imports `.wgsl?raw`, which `tsx` cannot load. The previous
 * version of `scripts/test-dungeon-enemies.mts` worked around that by holding
 * an INLINE REPLICA of the spawner and asserting against the copy — so the
 * suite could not have caught a change to the real function, and in fact the
 * whole roster could have been rewritten under it without a single failure.
 * Everything here is pure: no DOM, no GPU, no renderer import, so the tests
 * assert on shipping code.
 *
 * WHAT MAKES A DUNGEON A PLACE
 *
 * Three axes, and they compose:
 *
 *   THEME decides WHO. A crypt is undead, a cave is goblins, a ruin is a
 *   goblin band squatting in someone else's tomb — and so has both.
 *
 *   DEPTH decides HOW BAD. Depth is BFS distance through the spec's own room
 *   graph, so it is the number of doors you have chosen to open. Shallow rooms
 *   are grunts; deeper ones add archers, then elites. This is what makes "one
 *   more room" a decision instead of a formality.
 *
 *   ROOM SIZE decides HOW MANY. A large hall is a battle; a 5x5 side room is
 *   an ambush.
 *
 * Before this existed, `DUNGEON_ENEMY_SPECIES` was the literal string 'wolf':
 * every threat underground was the same animal you meet in a field, and
 * `'boss'` was a room type with no creature behind it.
 */

import { SPECIES_DEFS, type Species } from '../entities/entity-types';
import type { EntityState } from '../entities/entity-manager';
import type { Vec3 } from '../math';
import { mulberry32 } from '../mesh-utils';
import { mix32, type DungeonLayout, type PlacedRoom } from './dungeon-layout';
import type { DungeonSpec, DungeonTheme, RoomSize } from './dungeon-spec';

/** Room types that receive rank-and-file enemies. */
const DUNGEON_COMBAT_ROOM_TYPES = new Set(['combat', 'boss']);

/** Base head-count per room, before depth and size scaling. */
const ROOM_BASE_COUNT: Record<RoomSize, number> = {
  small: 2, medium: 3, large: 4,
};

/** Hard ceiling per dungeon. `MAX_DRAWN` is 30 and the budget is 8 rebuilds. */
const DUNGEON_ENEMY_CAP = 22;

/**
 * Ceiling on ONE room, whatever its size and depth.
 *
 * The depth term below is unbounded: a large room five doors in asks for 4 + 6
 * bodies. Ten enemies clamped into one rect with no pathfinding is not a hard
 * fight, it is a wall — they cannot flank, cannot path and cannot spread, so
 * they simply stack on the nearest edge and swing together. The shipped
 * fixtures never exceed 4 and are completely unaffected by this; it exists to
 * bound what an AI Director can author, which is the only thing that reaches
 * those depths.
 *
 * 5 keeps the escalation legible — a capped room still contains more, and
 * WORSE, than a shallow one, because the roster tier keeps climbing after the
 * head-count stops.
 */
const ROOM_MAX_COUNT = 5;

/**
 * The warband that lives in each theme, as a list of tiers.
 *
 * Index 0 is what you meet at the door; later entries are unlocked by depth.
 * A `null` slot means "keep using the previous tier" — the cave line has no
 * separate tier-1 because goblins with bows ARE its escalation.
 */
type EnemyTier = readonly Species[];
const THEME_ROSTER: Record<DungeonTheme, readonly EnemyTier[]> = {
  // Undead throughout. A crypt should never contain anything that breathes.
  crypt: [
    ['skeleton'],
    ['skeleton'],
    ['skeleton'],
  ],
  // Goblins. Archers appear one room in, which is where a player first has to
  // think about cover rather than just walking forward swinging.
  cave: [
    ['goblin', 'goblin', 'goblin'],
    ['goblin', 'goblin', 'goblin_archer'],
    // Deep caves have something older in them than goblins.
    ['goblin', 'goblin_archer', 'skeleton'],
  ],
  // A goblin band camped in a tomb they should not have opened. The deeper you
  // go the more it stops being their dungeon.
  ruin: [
    ['goblin', 'goblin', 'goblin_archer'],
    ['goblin', 'goblin_archer', 'skeleton'],
    ['skeleton', 'skeleton', 'goblin_archer'],
  ],
};

/** The boss. One per dungeon, in the boss room, and there is only one of him. */
const DUNGEON_BOSS: Species = 'dread_king';

/** Elite guards flanking the boss. */
const BOSS_GUARDS = 2;

/**
 * BFS depth of every room from the entrance, over the spec's own edge graph.
 *
 * Uses the SPEC rather than the placed geometry on purpose: the spec's edges
 * are what the author (or the Director) actually meant by "deeper in", whereas
 * the placed rooms can end up physically adjacent through pure packing luck.
 *
 * Exported because `dungeon-loot.ts` needs the same answer to decide which
 * treasure rooms are deep enough to be worth stocking. A second BFS over the
 * same graph would be free to drift from this one, and "deep enough to be
 * dangerous" and "deep enough to be rewarding" have to be the same statement.
 */
export function roomDepths(spec: DungeonSpec): Map<string, number> {
  const adj = new Map<string, string[]>();
  for (const r of spec.rooms) adj.set(r.id, []);
  for (const [a, b] of spec.edges) {
    adj.get(a)?.push(b);
    adj.get(b)?.push(a);
  }
  const depth = new Map<string, number>();
  const start = spec.rooms.find((r) => r.type === 'entrance')?.id
    ?? spec.rooms[0]?.id;
  if (start === undefined) return depth;
  depth.set(start, 0);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    const d = depth.get(cur) ?? 0;
    for (const nb of adj.get(cur) ?? []) {
      if (depth.has(nb)) continue;
      depth.set(nb, d + 1);
      queue.push(nb);
    }
  }
  return depth;
}

/**
 * A dungeon enemy: an EntityState placed in a combat/boss room.
 * Uses the same fields and AI path as overworld entities, but lives
 * inside the dungeon origin-space.
 */
export type DungeonEnemy = EntityState & {
  /** Room rect (in layout cell coords) used to clamp movement. */
  roomX: number;
  roomZ: number;
  roomW: number;
  roomD: number;
  /** True for the boss — drives the clear notice and the HUD name. */
  boss?: boolean;
};

/**
 * Populate a dungeon deterministically from its spec and layout.
 *
 * Deterministic from `(WORLD_SEED, dcx, dcz)` exactly as before, so the same
 * door always leads to the same fight and `exit()` can throw the state away.
 * The rng draw order is fixed per room in `layout.rooms` order so that adding
 * a room type later cannot reshuffle the rooms before it.
 */
export function spawnDungeonEnemies(
  layout: DungeonLayout,
  spec: DungeonSpec,
  origin: Vec3,
  seed: number,
  dcx: number,
  dcz: number,
): DungeonEnemy[] {
  const rng = mulberry32(mix32(seed ^ 0xd00f, dcx, dcz));
  const enemies: DungeonEnemy[] = [];
  const depths = roomDepths(spec);
  const sizeById = new Map(spec.rooms.map((r) => [r.id, r.size]));
  const roster = THEME_ROSTER[spec.theme] ?? THEME_ROSTER.ruin;

  let n = 0;
  const place = (
    room: PlacedRoom, species: Species, boss: boolean,
  ): void => {
    if (enemies.length >= DUNGEON_ENEMY_CAP) return;
    // Inside the room, off the walls. The boss goes near the centre so the
    // room reads as his rather than as somewhere he happens to be standing.
    const margin = 1;
    const fx = boss
      ? room.x + room.w * 0.5
      : room.x + margin + rng() * Math.max(0, room.w - 2 * margin);
    const fz = boss
      ? room.z + room.d * 0.5
      : room.z + margin + rng() * Math.max(0, room.d - 2 * margin);
    const wx = origin[0] + fx;
    const wz = origin[2] + fz;
    enemies.push({
      id: `dungeon:${dcx},${dcz}:e${n++}`,
      species,
      x: wx, y: origin[1], z: wz,
      // The boss faces the door. Everything else is milling about.
      yaw: boss ? 0 : rng() * Math.PI * 2,
      hp: SPECIES_DEFS[species].hp,
      mode: 'idle',
      walkPhase: 0,
      colorVariant: (rng() * 4) | 0,
      homeX: wx,
      homeZ: wz,
      stateTimer: rng() * 3,
      fleeTimer: 0,
      roomX: origin[0] + room.x,
      roomZ: origin[2] + room.z,
      roomW: room.w,
      roomD: room.d,
      boss: boss ? true : undefined,
    });
  };

  // The boss goes FIRST, before any budget can be spent.
  //
  // `place` refuses once `DUNGEON_ENEMY_CAP` is reached, and the deepest
  // fixture asks for slightly more bodies than the cap allows. Filling rooms
  // in layout order would therefore silently drop whichever rooms came last —
  // and on a dungeon whose boss room happens to be placed late, that is the
  // BOSS. A boss room with no boss in it is not a bug that announces itself:
  // the room still looks like a throne room and the player simply walks
  // through it.
  for (const room of layout.rooms) {
    if (room.type !== 'boss') continue;
    place(room, DUNGEON_BOSS, true);
    // A pair of elites, so the room is a fight and not a duel. Guards come
    // from the deepest tier of the theme's roster, so a crypt boss is flanked
    // by skeletons and a cave boss by whatever has crawled deepest into it.
    const elite = roster[roster.length - 1];
    for (let i = 0; i < BOSS_GUARDS; i++) {
      place(room, elite[(i + 1) % elite.length], false);
    }
  }

  for (const room of layout.rooms) {
    if (room.type !== 'combat') continue;
    const depth = depths.get(room.id) ?? 1;
    const size = sizeById.get(room.id) ?? 'medium';

    // Tier by depth: the entrance room's neighbours are tier 0, and every
    // further door you choose to open moves you along the roster.
    const tier = roster[Math.min(roster.length - 1, Math.max(0, depth - 1))];

    // Size sets the base, depth adds to it — and the depth term has to be
    // strong enough to BEAT the size term, or the escalation is a lie.
    //
    // The failure that produced this coefficient: at `+floor((depth-1)/2)` a
    // large room one door in held 4 bodies and a small room three doors in
    // held 3, so the deepest room in the dungeon was the easiest fight in it.
    // Room size varies by 2 across the whole range, so the depth term needs
    // roughly 1.5/room to dominate — which it now does, and a test asserts
    // per-room threat actually rises with depth rather than trusting this
    // comment.
    const want = Math.min(ROOM_MAX_COUNT,
      ROOM_BASE_COUNT[size] + Math.floor((depth - 1) * 1.5));
    for (let i = 0; i < want; i++) {
      place(room, tier[Math.floor(rng() * tier.length)], false);
    }
  }

  return enemies;
}
