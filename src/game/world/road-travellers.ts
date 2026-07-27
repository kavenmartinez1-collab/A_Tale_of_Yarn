/**
 * People on the roads.
 *
 * ## Why
 *
 * The road network joins every settlement to a castle over ~110 km of stone in
 * the 12 km test window, and until now not one person used it. That is where
 * the emptiness was actually felt: a player spends most of their time *between*
 * places, and raising any single settlement's population does nothing for the
 * hour spent walking to it. A pedlar met on a hill road does more for "the
 * world is inhabited" than ten more villagers behind a wall you have not
 * reached yet.
 *
 * ## What a traveller is
 *
 * Deliberately an ordinary `ResolvedNpc`, not a new entity kind. That decision
 * is the whole design:
 *
 *   - `SettlementManager.nearbyNpcs()` already feeds main.ts's NPC runtimes, so
 *     travellers inherit movement, conversation, trade, crime and combat with
 *     no wiring anywhere else.
 *   - The NPC path is capped at `NPC_MAX_DRAWN` characters drawn per frame, so
 *     adding travellers cannot raise the mesh cost above what a populated town
 *     already pays — it only changes *which* twelve people are on screen.
 *   - Wild-creature streaming would have been the other candidate, but that
 *     path is charged against `entity-renderer`'s 8-rebuilds-per-frame budget,
 *     which a populated castle already saturates. Travellers would have been
 *     competing with the wildlife for it.
 *
 * A traveller has `homePadIndex === -1`, which is what keeps them out of every
 * building system: `npcWantsIndoors` returns false without a home, so they never
 * withdraw indoors, are never teleported into an interior arena, and never
 * appear in a settlement's roster.
 *
 * ## Determinism under streaming
 *
 * A party is a pure function of (seed, road edge, station index) — never of the
 * player, the time, or which direction they arrived from:
 *
 *   - Each road edge is walked at fixed `STATION_SPACING` intervals of arc
 *     length from its first vertex. Station `j` of edge (a,b) is one identity,
 *     the same for anyone who asks.
 *   - A station is EMITTED by the settlement cell its anchor point falls in, and
 *     by no other. Because cells are generated once and cached, that makes each
 *     party appear exactly once globally, with no dedupe pass and no chance of a
 *     party being built twice with two different ids.
 *   - Road edges themselves come from `roads.graphIn`, which is already
 *     approach-independent (see the header of `roads.ts`).
 *
 * ## How they move
 *
 * Waypoints are sampled along the road polyline out to `PATROL_REACH` either
 * side of the anchor and then **mirrored into a palindrome** — A,B,C,D,C,B. The
 * NPC waypoint AI cycles its list, and a plain list would walk the last point
 * back to the first in a straight line, cutting whatever corner the road was
 * bending around and marching the traveller off the stones and through a river.
 * A palindrome makes the wrap retrace the road, so the cycle is a round trip
 * that never leaves the paving.
 *
 * Each traveller keeps a fixed lateral offset within the paved half-width, so a
 * pedlar and his guard walk side by side rather than in single file down the
 * centre line.
 */

import { mix32 } from '../dungeon/dungeon-layout';
import { mulberry32 } from '../mesh-utils';
import { npcNameFor } from '../npc/npc-prompt';
import type { NpcRole } from '../npc/npc-trade';
import type { NpcWaypoint, ResolvedNpc } from '../npc/npc-spawn';
import { SCELL } from '../settlement/settlement-scatter';
import { HALF_TRUNK, type RoadNetwork } from './roads';

const SALT = 0x2ea7e12b; // 'traveller'

/** Arc length between candidate parties on one road edge (m). */
const STATION_SPACING = 140;
/** Fraction of stations that actually hold somebody. */
const PARTY_CHANCE = 0.5;
/**
 * How far either side of its anchor a party walks (m of arc length).
 *
 * This is a churn budget, not a taste decision. main.ts rebuilds every NPC
 * runtime whenever the nearby-NPC COUNT changes, and a rebuild restores each
 * NPC to the position the manager last handed out — the anchor, for a
 * traveller. Membership here changes only when the player crosses a 512 m
 * settlement cell, so that is roughly a rebuild every couple of minutes on
 * foot; `PATROL_REACH` is the furthest a traveller can be displaced when one
 * lands. 60 m keeps the worst case at the edge of the 120 m render distance
 * while still being a walk rather than a shuffle.
 */
const PATROL_REACH = 60;
/**
 * Spacing of patrol waypoints along the road (m).
 *
 * A trade-off between two failures, and the first version got it wrong. The
 * NPC AI walks the STRAIGHT LINE between consecutive waypoints, so on a bend
 * the chord cuts the corner: for an arc of radius R the traveller strays
 * L²/(8R) from the paving, and at L = 30 m over the ~35 m curves a 36 m
 * Dijkstra grid produces after smoothing, that measured **6.8 m off the road**
 * — walking through the verge beside a road two to three metres wide.
 * At 15 m the same bend costs 0.8 m, which is inside the paving.
 *
 * Wider would be nicer for the other reason: the AI pauses 2-6 s at every
 * waypoint it reaches, so closer waypoints mean more standing about. 15 m at
 * 1.2 m/s is ~12 s of walking per pause, which still reads as travelling.
 */
const WAYPOINT_SPACING = 15;

/**
 * The place a traveller belongs to. Never a real settlement name: `main.ts`
 * joins an NPC to the interior it withdraws into on
 * (settlementName, homePadIndex), and this value existing in that namespace is
 * what would let a traveller be "found" inside a building they have no claim
 * to. A name no settlement can ever roll keeps them out of that join entirely.
 */
export const ROAD_PLACE = 'the road';

/** True when this NPC id belongs to a road traveller rather than a settler. */
export function isTravellerId(id: string): boolean {
  return id.startsWith('wf_');
}

// ---------------------------------------------------------------------------
// Party composition
// ---------------------------------------------------------------------------

/**
 * Who you meet, and how likely. Only the four established roles are used: a
 * fifth would fall through `NPC_PALETTE`'s villager default in main.ts and read
 * as a villager in a merchant's clothes, and would need a trade catalogue, a
 * persona voice and a witness rule to be worth the name. The variety here is
 * in the *company* people keep, which costs nothing and is what actually reads
 * on a road — a lone figure, a pair, a guarded cart.
 */
interface PartyKind {
  /** Weight on ordinary roads. */
  weight: number;
  /** Weight on trunk roads (traffic from two or more settlements). */
  trunkWeight: number;
  roles: NpcRole[];
  /** Extra member, appended when the party roll is above `extraAt`. */
  extra?: { role: NpcRole; extraAt: number };
}

const PARTIES: PartyKind[] = [
  // A lone figure on the road — the commonest thing to meet, and the one that
  // reads most strongly as "somebody lives out here".
  { weight: 30, trunkWeight: 20, roles: ['villager'] },
  // A pedlar working between the villages, sometimes with a hired sword.
  { weight: 24, trunkWeight: 26, roles: ['merchant'], extra: { role: 'guard', extraAt: 0.55 } },
  // Two on their way somewhere together.
  { weight: 18, trunkWeight: 16, roles: ['villager', 'villager'] },
  // A drover taking stock to market.
  { weight: 16, trunkWeight: 12, roles: ['farmer'], extra: { role: 'farmer', extraAt: 0.7 } },
  // The watch, walking their lord's road. Far commoner on the trunk routes,
  // which are the ones that carry two or more settlements' traffic to a gate.
  { weight: 12, trunkWeight: 26, roles: ['guard', 'guard'] },
];

function pickParty(r: number, trunk: boolean): PartyKind {
  let total = 0;
  for (const p of PARTIES) total += trunk ? p.trunkWeight : p.weight;
  let acc = r * total;
  for (const p of PARTIES) {
    acc -= trunk ? p.trunkWeight : p.weight;
    if (acc < 0) return p;
  }
  return PARTIES[PARTIES.length - 1];
}

// ---------------------------------------------------------------------------
// Polyline sampling
// ---------------------------------------------------------------------------

/** A point on a road polyline: position plus the unit direction of travel. */
interface RoadPoint { x: number; y: number; z: number; dx: number; dz: number }

/**
 * Sample a road polyline (x,z,y triples) at arc length `s`, clamped to the
 * ends. Returns the point and the direction of travel there, so a caller can
 * step sideways off the centre line by a fixed amount.
 */
function sampleArc(pts: Float32Array, s: number): RoadPoint {
  const n = pts.length / 3;
  let acc = 0;
  for (let i = 0; i + 1 < n; i++) {
    const ax = pts[i * 3];
    const az = pts[i * 3 + 1];
    const ay = pts[i * 3 + 2];
    const bx = pts[(i + 1) * 3];
    const bz = pts[(i + 1) * 3 + 1];
    const by = pts[(i + 1) * 3 + 2];
    const seg = Math.hypot(bx - ax, bz - az);
    if (seg < 1e-6) continue;
    if (acc + seg >= s || i + 2 === n) {
      const t = Math.min(1, Math.max(0, (s - acc) / seg));
      return {
        x: ax + (bx - ax) * t,
        y: ay + (by - ay) * t,
        z: az + (bz - az) * t,
        dx: (bx - ax) / seg,
        dz: (bz - az) / seg,
      };
    }
    acc += seg;
  }
  // Degenerate polyline (every segment shorter than a micrometre).
  return { x: pts[0], y: pts[2], z: pts[1], dx: 1, dz: 0 };
}

/** Total arc length of a polyline. */
function arcLength(pts: Float32Array): number {
  const n = pts.length / 3;
  let total = 0;
  for (let i = 0; i + 1 < n; i++) {
    total += Math.hypot(
      pts[(i + 1) * 3] - pts[i * 3], pts[(i + 1) * 3 + 1] - pts[i * 3 + 1]);
  }
  return total;
}

/** FNV-1a over a string — turns the edge's node ids into a station salt. */
function hashStr(s: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Every traveller whose home station lies in settlement cell (scx, scz).
 *
 * Cheap enough to call once per cell on first approach — the same cadence the
 * settlement manager meshes a settlement at — and pure, so the cell may be
 * cached forever without the answer drifting.
 */
export function travellersInCell(
  seed: number,
  scx: number,
  scz: number,
  roads: RoadNetwork,
): ResolvedNpc[] {
  const x0 = scx * SCELL;
  const z0 = scz * SCELL;
  const graph = roads.graphIn(x0, z0, x0 + SCELL, z0 + SCELL);
  const out: ResolvedNpc[] = [];

  for (const edge of graph.edges) {
    // The gate stub is a paved approach street inside the castle's own
    // footprint, with both ends on the castle itself. It is not a journey, and
    // the castle's own guards already stand on it.
    if (edge.a === edge.b) continue;
    const total = arcLength(edge.pts);
    if (total < STATION_SPACING * 0.5) continue;
    const trunk = edge.halfWidth >= HALF_TRUNK;
    const edgeHash = hashStr(`${edge.a}|${edge.b}`);
    const stations = Math.max(1, Math.floor(total / STATION_SPACING));

    for (let j = 0; j < stations; j++) {
      // Half a spacing in, so a station never lands exactly on a junction where
      // two edges meet and two parties would stand on top of each other.
      const s = (j + 0.5) * STATION_SPACING;
      const anchor = sampleArc(edge.pts, s);
      // Emitted by the cell that owns the anchor, and by nobody else. This is
      // what makes "generate the 3x3 cells around the player" produce each
      // party exactly once however the player approached.
      if (Math.floor(anchor.x / SCELL) !== scx) continue;
      if (Math.floor(anchor.z / SCELL) !== scz) continue;

      const rng = mulberry32(mix32(seed ^ SALT, edgeHash, j));
      if (rng() >= PARTY_CHANCE) continue;

      const kind = pickParty(rng(), trunk);
      const roles = [...kind.roles];
      if (kind.extra !== undefined && rng() > kind.extra.extraAt) {
        roles.push(kind.extra.role);
      }

      // One id prefix per party. main.ts derives an NPC's social circle from
      // everyone sharing its "<prefix>_" id stem, so a party's members know
      // each other and nobody else — which is exactly right for two people who
      // met on the road, and is why the prefix must not be a settlement's.
      const partyId = `wf_${(edgeHash ^ (j * 0x9e3779b1)) >>> 0}`;
      // The party walks together: one shared stretch of road, one direction of
      // travel, and each member holding a lane within the paved width.
      const lead = (rng() - 0.5) * 30; // stagger parties off their exact station
      const halfW = edge.halfWidth;

      for (let m = 0; m < roles.length; m++) {
        // Spread along the road (a few metres apart) and across it, so a pair
        // reads as walking together rather than standing on one spot.
        const along = lead + (m - (roles.length - 1) / 2) * 2.4;
        const side = (rng() - 0.5) * halfW * 1.1;
        const at = sampleArc(edge.pts, Math.min(total, Math.max(0, s + along)));
        // Left-normal of the direction of travel.
        const nx = -at.dz;
        const nz = at.dx;

        const waypoints: NpcWaypoint[] = [];
        const legs = Math.max(1, Math.round(PATROL_REACH / WAYPOINT_SPACING));
        for (let k = -legs; k <= legs; k++) {
          const ws = Math.min(total, Math.max(0, s + along + k * WAYPOINT_SPACING));
          const w = sampleArc(edge.pts, ws);
          waypoints.push({ x: w.x + -w.dz * side, z: w.z + w.dx * side });
        }
        // Mirror into a palindrome so the cycle's wrap retraces the road
        // instead of cutting straight back across whatever it curved around.
        for (let k = waypoints.length - 2; k >= 1; k--) {
          waypoints.push(waypoints[k]);
        }

        const wx = at.x + nx * side;
        const wz = at.z + nz * side;
        out.push({
          id: `${partyId}_${m}`,
          role: roles[m],
          // Named off the station rather than the position, so a traveller
          // keeps their name wherever along their road they happen to be.
          name: npcNameFor(edgeHash, Math.floor(anchor.x), Math.floor(anchor.z), m),
          // `x`/`z` are documented as offsets from a settlement centre. A
          // traveller has no settlement, so they are offsets from the party's
          // station — the nearest thing they have to a home address.
          x: wx - anchor.x,
          z: wz - anchor.z,
          waypoints,
          waypointIndex: 0,
          homePadIndex: -1,
          wx,
          // The polyline already carries the ROAD's height, which is the carved
          // surface the player walks on — up to `CARVE_MAX` from the raw
          // heightfield in a cutting. Sampling the base field here instead would
          // spawn them sunk into the road or floating over it for the one frame
          // before movement re-grounds them.
          wy: at.y,
          wz,
          wwaypoints: waypoints,
          settlementName: ROAD_PLACE,
        });
      }
    }
  }
  return out;
}
