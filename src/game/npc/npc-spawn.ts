/**
 * Deterministic NPC spawning — pure CPU, node-testable, no DOM/GPU.
 *
 * Derives NPC list from (settlement seed, kind, pads) using the same
 * mulberry32/mix32 idiom used throughout the repo.  Roles, counts, spawn
 * positions, and patrol waypoints are all deterministic given the same inputs.
 *
 * Roles per kind:
 *   ruins   → 0-2 squatters, in about a third of them
 *   ranch   → farmer (1-2) + villager (1-2)
 *   village → villager (3-5) + farmer (1-2) + merchant (1) + guard (0-1)
 *   town    → villager (5-7) + farmer (2-3) + merchant (2-3) + guard (2-3)
 *   castle  → guard (6-8) + villager (5-7) + merchant (2-3) + farmer (2-3)
 *
 * Patrol waypoints:
 *   guard  → walks between walls/gatehouse/tower pads
 *   others → idles near their assigned building pad (two nearby points)
 */

import { mulberry32 } from '../mesh-utils';
import { mix32 } from '../dungeon/dungeon-layout';
import { npcNameFor } from './npc-prompt';
import type { NpcRole } from './npc-trade';
import type { BuildingPad, SettlementLayout } from '../settlement/settlement-layout';
import type { SettlementKind } from '../settlement/settlement-scatter';

export type { NpcRole };

export interface NpcWaypoint {
  x: number;
  z: number;
}

export interface SpawnedNpc {
  /** Stable unique id: "npc_<settlementSeed>_<index>". */
  id: string;
  role: NpcRole;
  name: string;
  /** Spawn position (settlement-local offsets from the site center). */
  x: number;
  z: number;
  /** Patrol waypoints (settlement-local). Guards get 3-4, others get 2. */
  waypoints: NpcWaypoint[];
  /** Index into waypoints array for the current target. */
  waypointIndex: number;
  /**
   * Index into the settlement's pad list of the building this NPC belongs to,
   * or -1 if they were placed without one. This is the same index the building
   * manager enters by, which is what lets an NPC actually be *inside* their own
   * house: the door you open and the person behind it agree on which pad they
   * are talking about.
   */
  homePadIndex: number;
}

// ---------------------------------------------------------------------------
// Count tables
// ---------------------------------------------------------------------------

type RolePlan = { role: NpcRole; count: number }[];

/**
 * How many people live here, by kind.
 *
 * These were placeholders and read like it: measured over a 576-cell sweep the
 * whole world held 307 people, a castle averaged 8.1 and a ranch 1.5, and the
 * gap between the largest and smallest inhabited kind was a factor of five. A
 * castle with eight people in it is not a castle, and since world spawn is a
 * forced castle (`FORCED_SITES`), every direction the player travelled was
 * emptier than where they started.
 *
 * The numbers below are sized from the HOUSING STOCK the layouts already
 * build, which is the honest constraint — the buildings were always there and
 * nobody lived in them:
 *
 *     ranch    1 house,  1 barn,  1 stable                         →  2-4
 *     village  6 houses, tavern/church/longhouse/smithy            →  5-9
 *     town    10 townhouses + 5 houses, 6 stalls, jail             → 11-16
 *     castle   7 townhouses + 5 houses, 3 stalls, keep, 4 towers   → 15-21
 *
 * The upper end is also chosen against `NPC_MAX_DRAWN` (12) in main.ts, which
 * is a hard cap on how many characters are meshed per frame and has NO LOD
 * behind it. A castle's ~18 people, less the five or six minding public
 * buildings indoors, leaves about twelve on the street — so the cap is a
 * backstop rather than something the design leans on. Pushing counts much
 * higher would not cost frame time (the cap absorbs it) but WOULD start
 * dropping visible people at mid-range, which is worse than having fewer.
 */
function rolePlanFor(kind: SettlementKind, rng: () => number): RolePlan {
  switch (kind) {
    case 'ranch':
      // A farmstead is a household, not a job: the farmer has a family.
      return [
        { role: 'farmer',   count: 1 + Math.floor(rng() * 2) }, // 1-2
        { role: 'villager', count: 1 + Math.floor(rng() * 2) }, // 1-2
      ];
    case 'village':
      // Six houses had two or three occupants between them. One guard at most
      // — a village that can afford a standing watch is a town.
      return [
        { role: 'villager', count: 3 + Math.floor(rng() * 3) }, // 3-5
        { role: 'farmer',   count: 1 + Math.floor(rng() * 2) }, // 1-2
        { role: 'merchant', count: 1 },
        { role: 'guard',    count: Math.floor(rng() * 2) },     // 0-1
      ];
    case 'town':
      // Six market stalls justify more than one trader, and fifteen dwellings
      // justify a great deal more than three residents.
      return [
        { role: 'villager', count: 5 + Math.floor(rng() * 3) }, // 5-7
        { role: 'farmer',   count: 2 + Math.floor(rng() * 2) }, // 2-3
        { role: 'merchant', count: 2 + Math.floor(rng() * 2) }, // 2-3
        { role: 'guard',    count: 2 + Math.floor(rng() * 2) }, // 2-3
      ];
    case 'castle':
      // Four towers, a gatehouse, a keep and a jail were held by four to six
      // guards, which left most of the wall unwatched. The garrison is now the
      // largest single group, and the town outside the gate has its own people.
      return [
        { role: 'guard',    count: 6 + Math.floor(rng() * 3) }, // 6-8
        { role: 'villager', count: 5 + Math.floor(rng() * 3) }, // 5-7
        { role: 'merchant', count: 2 + Math.floor(rng() * 2) }, // 2-3
        { role: 'farmer',   count: 2 + Math.floor(rng() * 2) }, // 2-3
      ];
    case 'ruins':
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Ruins
// ---------------------------------------------------------------------------

/**
 * Ruins are the commonest thing in the world and used to contain nothing at
 * all — over half of every settlement the player found was rubble with no
 * reason to stop. Emptiness is the right *character* for a ruin, but "empty"
 * and "nothing happens here" are not the same thing.
 *
 * About a third of them now hold squatters: someone picking over a collapsed
 * hall, or a pair camped in the walls. They are `villager`s because that is a
 * role the whole game already understands — palette, trade catalogue, persona
 * voice, crime and witness rules. A `bandit` or `hermit` role would need all
 * of those written before it was worth the name, and hostility in particular
 * is initialised in main.ts rather than here, so a genuinely dangerous ruin is
 * not something this file can express on its own.
 */
const RUINS_OCCUPIED = 0.34;

/**
 * Squatters, placed against the rubble rather than a pad.
 *
 * Every pad a ruin has — `ruin`, `graves`, `shrine`, `well`, `hedge`,
 * `signpost` — is on the uninhabitable list, so `assignPad` would return null
 * and drop them at a random point in a 10 m box with two waypoints two metres
 * apart. That reads as someone standing still in a field. Instead they circle
 * the fallen hall at the radius the graveyard and shrine sit at, which is where
 * anything worth scavenging would be.
 */
function ruinSquatters(seed: number, rng: () => number): SpawnedNpc[] {
  if (rng() >= RUINS_OCCUPIED) return [];
  const count = rng() < 0.68 ? 1 : 2;
  const npcs: SpawnedNpc[] = [];
  for (let i = 0; i < count; i++) {
    const a0 = rng() * Math.PI * 2;
    const r = 5.5 + rng() * 3;
    const x = Math.cos(a0) * r;
    const z = Math.sin(a0) * r;
    // Three points around the ruin, so they cross the rubble instead of
    // shuffling on the spot.
    const waypoints: NpcWaypoint[] = [];
    for (let k = 0; k < 3; k++) {
      const a = a0 + (k + 1) * (Math.PI * 2 / 3);
      const rk = 5.0 + rng() * 3.5;
      waypoints.push({ x: Math.cos(a) * rk, z: Math.sin(a) * rk });
    }
    npcs.push({
      id: `npc_${seed}_${i}`,
      role: 'villager',
      name: npcNameFor(seed, Math.floor(x), Math.floor(z), i),
      x,
      z,
      waypoints,
      waypointIndex: 0,
      // No home: nothing here has a roof, let alone a door that opens. -1 is
      // also what keeps them out of the indoor/arena machinery entirely.
      homePadIndex: -1,
    });
  }
  return npcs;
}

// ---------------------------------------------------------------------------
// Waypoint generation
// ---------------------------------------------------------------------------

/** Pads suitable for guards to patrol around. */
function guardPatrolPads(pads: BuildingPad[]): BuildingPad[] {
  const types = new Set<string>(['wall', 'tower', 'gatehouse', 'jail']);
  const result = pads.filter((p) => types.has(p.type));
  // Fallback: use any solid pads if there are no fort features.
  if (result.length === 0) {
    return pads.filter((p) => p.type !== 'signpost' && p.type !== 'fence');
  }
  return result;
}

/** Generate patrol waypoints for a guard: 3-4 points around fort perimeter. */
function guardWaypoints(pads: BuildingPad[], rng: () => number): NpcWaypoint[] {
  const patrol = guardPatrolPads(pads);
  if (patrol.length === 0) {
    // Fallback orbit around the center.
    const r = 12;
    return [
      { x:  r, z:  0 },
      { x:  0, z:  r },
      { x: -r, z:  0 },
      { x:  0, z: -r },
    ];
  }
  // Shuffle and pick up to 4 fort features, patrolling just outside each.
  const shuffled = [...patrol].sort(() => rng() - 0.5);
  const count = Math.min(4, Math.max(3, shuffled.length));
  return shuffled.slice(0, count).map((p) => doorSpot(p, rng, 2.0));
}

/**
 * A spot just outside the pad's door face (local -Z rotated by yaw), so NPCs
 * stand in front of their building instead of inside its mesh.
 */
function doorSpot(
  pad: BuildingPad, rng: () => number, margin = 1.6,
): NpcWaypoint {
  const dx = Math.sin(pad.yaw);
  const dz = -Math.cos(pad.yaw);
  const dist = pad.d / 2 + margin;
  const jitter = () => (rng() - 0.5) * 2.4;
  return { x: pad.x + dx * dist + jitter(), z: pad.z + dz * dist + jitter() };
}

/** Generate idle waypoints for a non-guard: 2 points by the pad's door. */
function idleWaypoints(pad: BuildingPad, rng: () => number): NpcWaypoint[] {
  return [doorSpot(pad, rng), doorSpot(pad, rng, 2.8)];
}

// ---------------------------------------------------------------------------
// Pad assignment per role
// ---------------------------------------------------------------------------

/**
 * Pads an NPC can never be stationed at — scenery, ground cover and props with
 * no doorway or standing room.
 */
const UNINHABITABLE_PADS: ReadonlySet<string> = new Set([
  'signpost', 'fence', 'lamp', 'hedge', 'crops', 'haystack', 'woodpile',
  'cart', 'washline', 'barrels', 'graves', 'shrine', 'trough', 'brazier',
  'banner', 'pillory', 'well', 'ruin',
]);

/**
 * Pick the pad an NPC belongs to, returning its INDEX rather than the pad
 * itself. The index is the durable identity — it is what the building manager
 * uses to name an interior, and what lets us later ask "is this the NPC who
 * lives in the building the player just walked into?".
 */
function assignPadIndex(role: NpcRole, pads: BuildingPad[], rng: () => number): number {
  const pad = assignPad(role, pads, rng);
  return pad === null ? -1 : pads.indexOf(pad);
}

function assignPad(role: NpcRole, pads: BuildingPad[], rng: () => number): BuildingPad | null {
  let preferred: BuildingPad[];
  switch (role) {
    case 'farmer':
      preferred = pads.filter((p) => p.type === 'barn' || p.type === 'stable');
      break;
    case 'merchant':
      // Market stalls first, then houses/barns.
      preferred = pads.filter((p) => p.type === 'stall');
      if (preferred.length === 0) {
        preferred = pads.filter((p) => p.type === 'house' || p.type === 'barn');
      }
      break;
    case 'guard':
      preferred = pads.filter((p) =>
        p.type === 'gatehouse' || p.type === 'tower' || p.type === 'jail' ||
        p.type === 'keep');
      break;
    case 'villager':
    default:
      // `townhouse` counts as a house. A town is built from ten townhouses and
      // five houses and a castle from seven and five, so matching only 'house'
      // crowded every resident of a town into a third of its dwellings and left
      // the terraced streets — the ones that read as a town at all — empty.
      preferred = pads.filter((p) => p.type === 'house' || p.type === 'townhouse');
      break;
  }
  if (preferred.length === 0) {
    // Deny-list of things nobody can stand at, rather than a three-name
    // special case.
    //
    // This excluded only signpost/fence/lamp, which was complete when those
    // were the only decorative pads. The settlement vocabulary has since grown
    // to twenty-odd types, so the fallback would happily station a villager
    // inside a hedge, on a haystack, or in the middle of a crop field. Listed
    // explicitly rather than inferred, so a new decorative pad is a deliberate
    // decision here and not a silent regression.
    preferred = pads.filter((p) => !UNINHABITABLE_PADS.has(p.type));
  }
  if (preferred.length === 0) return null;
  return preferred[Math.floor(rng() * preferred.length)];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generate deterministic NPC list for a settlement.
 * Positions are settlement-local (offset from site center).
 * Call resolveNpcs() to lift to world space.
 */
export function spawnSettlementNpcs(
  kind: SettlementKind,
  seed: number,
  layout: SettlementLayout,
): SpawnedNpc[] {
  // Use a mix of seed and a spawn salt so NPCs are independent from layout rng.
  const SPAWN_SALT = 0x4e504330; // 'NPC0'
  const rng = mulberry32(mix32(seed ^ SPAWN_SALT, seed >>> 16, seed & 0xffff));

  if (kind === 'ruins') return ruinSquatters(seed, rng);

  const plan = rolePlanFor(kind, rng);
  const npcs: SpawnedNpc[] = [];
  let idx = 0;

  // --- staff the public buildings ------------------------------------------
  //
  // Every village, town and castle is laid out with a tavern, a church, a
  // smithy and a longhouse, and before this NOTHING ever assigned an NPC to
  // one: measured across 120 settlements, exactly zero of those buildings had
  // an occupant. You could rent a bed from a tavern with nobody in it. Since
  // an NPC whose home is a public building keeps it through the day (see
  // WORKPLACE_PADS in main.ts), staffing them is what puts a person behind the
  // bar rather than implying one.
  //
  // Priority order is by how much the player has reason to go there. The
  // budget is deliberately small — a village of four adults cannot put all
  // four indoors or the street is dead — so most settlements staff one or two
  // buildings and the rest stay empty until the town is big enough.
  const KEEPER_ORDER = ['tavern', 'smithy', 'church', 'longhouse'];
  const unstaffed: number[] = [];
  for (const type of KEEPER_ORDER) {
    for (let i = 0; i < layout.pads.length; i++) {
      if (layout.pads[i].type === type) unstaffed.push(i);
    }
  }
  const planned = plan.reduce((n, p) => n + p.count, 0);
  let keeperBudget = Math.max(1, Math.floor(planned / 3));

  for (const { role, count } of plan) {
    for (let i = 0; i < count; i++) {
      // Guards hold posts on the street; they are not shopkeepers.
      const takesKeep = role !== 'guard' && keeperBudget > 0 && unstaffed.length > 0;
      if (takesKeep) keeperBudget--;
      const homePadIndex = takesKeep
        ? unstaffed.shift()!
        : assignPadIndex(role, layout.pads, rng);
      const pad = homePadIndex >= 0 ? layout.pads[homePadIndex] : null;
      const spot = pad !== null ? doorSpot(pad, rng) : null;
      const x = spot !== null ? spot.x : (rng() - 0.5) * 10;
      const z = spot !== null ? spot.z : (rng() - 0.5) * 10;

      const waypoints =
        role === 'guard'
          ? guardWaypoints(layout.pads, rng)
          : pad !== null
            ? idleWaypoints(pad, rng)
            : [{ x, z }, { x: x + 2, z: z + 2 }];

      npcs.push({
        id: `npc_${seed}_${idx}`,
        role,
        name: npcNameFor(seed, Math.floor(x), Math.floor(z), idx),
        x,
        z,
        waypoints,
        waypointIndex: 0,
        homePadIndex,
      });
      idx++;
    }
  }

  return npcs;
}

// ---------------------------------------------------------------------------
// World-space resolution
// ---------------------------------------------------------------------------

export interface ResolvedNpc extends SpawnedNpc {
  /** World-space position (lifted from site center + heightfield). */
  wx: number;
  wy: number;
  wz: number;
  /** World-space waypoints. */
  wwaypoints: NpcWaypoint[];
  /**
   * Name of the settlement this NPC belongs to. Together with `homePadIndex`
   * this is the full address of their home, and the building manager names
   * interiors by exactly the same pair.
   */
  settlementName: string;
}

/** Lift settlement-local NPC positions to world space. */
export function resolveNpcs(
  npcs: SpawnedNpc[],
  siteX: number,
  siteZ: number,
  heightAt: (x: number, z: number) => number,
  settlementName = '',
): ResolvedNpc[] {
  return npcs.map((npc) => {
    const wx = siteX + npc.x;
    const wz = siteZ + npc.z;
    const wy = heightAt(wx, wz);
    const wwaypoints = npc.waypoints.map((wp) => ({
      x: siteX + wp.x,
      z: siteZ + wp.z,
    }));
    return { ...npc, wx, wy, wz, wwaypoints, settlementName };
  });
}
