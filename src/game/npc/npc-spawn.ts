/**
 * Deterministic NPC spawning — pure CPU, node-testable, no DOM/GPU.
 *
 * Derives NPC list from (settlement seed, kind, pads) using the same
 * mulberry32/mix32 idiom used throughout the repo.  Roles, counts, spawn
 * positions, and patrol waypoints are all deterministic given the same inputs.
 *
 * Roles per kind:
 *   ranch   → farmer (1-2)
 *   village → villager (2-3) + merchant (1) + farmer (0-1)
 *   town    → villager (2-3) + merchant (1-2) + guard (2) + farmer (1)
 *   castle  → guard (4-6) + merchant (1) + villager (1-2)
 *   ruins   → none
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
}

// ---------------------------------------------------------------------------
// Count tables
// ---------------------------------------------------------------------------

type RolePlan = { role: NpcRole; count: number }[];

function rolePlanFor(kind: SettlementKind, rng: () => number): RolePlan {
  switch (kind) {
    case 'ranch':
      return [
        { role: 'farmer',   count: 1 + Math.floor(rng() * 2) }, // 1-2
      ];
    case 'village':
      return [
        { role: 'villager', count: 2 + Math.floor(rng() * 2) }, // 2-3
        { role: 'merchant', count: 1 },
        { role: 'farmer',   count: Math.floor(rng() * 2) },      // 0-1
      ];
    case 'town':
      return [
        { role: 'villager', count: 2 + Math.floor(rng() * 2) }, // 2-3
        { role: 'merchant', count: 1 + Math.floor(rng() * 2) }, // 1-2
        { role: 'guard',    count: 2 },
        { role: 'farmer',   count: 1 },
      ];
    case 'castle':
      return [
        { role: 'guard',    count: 4 + Math.floor(rng() * 3) }, // 4-6
        { role: 'merchant', count: 1 },
        { role: 'villager', count: 1 + Math.floor(rng() * 2) }, // 1-2
      ];
    case 'ruins':
    default:
      return [];
  }
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
  // Shuffle and pick up to 4 pad centers as waypoints.
  const shuffled = [...patrol].sort(() => rng() - 0.5);
  const count = Math.min(4, Math.max(3, shuffled.length));
  return shuffled.slice(0, count).map((p) => ({ x: p.x, z: p.z }));
}

/** Generate idle waypoints for a non-guard: 2 points near the assigned pad. */
function idleWaypoints(pad: BuildingPad, rng: () => number): NpcWaypoint[] {
  const jitter = () => (rng() - 0.5) * 4;
  return [
    { x: pad.x + jitter(), z: pad.z + jitter() },
    { x: pad.x + jitter(), z: pad.z + jitter() },
  ];
}

// ---------------------------------------------------------------------------
// Pad assignment per role
// ---------------------------------------------------------------------------

function assignPad(role: NpcRole, pads: BuildingPad[], rng: () => number): BuildingPad | null {
  let preferred: BuildingPad[];
  switch (role) {
    case 'farmer':
      preferred = pads.filter((p) => p.type === 'barn' || p.type === 'stable');
      break;
    case 'merchant':
      preferred = pads.filter((p) => p.type === 'house' || p.type === 'barn');
      break;
    case 'guard':
      preferred = pads.filter((p) =>
        p.type === 'gatehouse' || p.type === 'tower' || p.type === 'jail');
      break;
    case 'villager':
    default:
      preferred = pads.filter((p) => p.type === 'house');
      break;
  }
  if (preferred.length === 0) {
    preferred = pads.filter((p) => p.type !== 'signpost' && p.type !== 'fence');
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
  if (kind === 'ruins') return [];

  // Use a mix of seed and a spawn salt so NPCs are independent from layout rng.
  const SPAWN_SALT = 0x4e504330; // 'NPC0'
  const rng = mulberry32(mix32(seed ^ SPAWN_SALT, seed >>> 16, seed & 0xffff));

  const plan = rolePlanFor(kind, rng);
  const npcs: SpawnedNpc[] = [];
  let idx = 0;

  for (const { role, count } of plan) {
    for (let i = 0; i < count; i++) {
      const pad = assignPad(role, layout.pads, rng);
      const jitter = () => (rng() - 0.5) * 3;
      const x = pad !== null ? pad.x + jitter() : (rng() - 0.5) * 10;
      const z = pad !== null ? pad.z + jitter() : (rng() - 0.5) * 10;

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
}

/** Lift settlement-local NPC positions to world space. */
export function resolveNpcs(
  npcs: SpawnedNpc[],
  siteX: number,
  siteZ: number,
  heightAt: (x: number, z: number) => number,
): ResolvedNpc[] {
  return npcs.map((npc) => {
    const wx = siteX + npc.x;
    const wz = siteZ + npc.z;
    const wy = heightAt(wx, wz);
    const wwaypoints = npc.waypoints.map((wp) => ({
      x: siteX + wp.x,
      z: siteZ + wp.z,
    }));
    return { ...npc, wx, wy, wz, wwaypoints };
  });
}
