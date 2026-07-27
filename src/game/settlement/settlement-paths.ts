/**
 * Settlement circulation — the streets, stairs and terraces that make a town
 * on a hillside walkable.
 *
 * Settlement sites are allowed real slope on purpose: `MAX_SITE_SPREAD` lets a
 * village footprint span 9 m of height and a castle 20 m, and the long comment
 * there explains why those cannot be tightened (below ~16 the world stops
 * having castles, and the road network is a Dijkstra tree rooted at castle
 * gates). It also names the intended remedy: "terracing and steps, not
 * rejecting the site". This file is that remedy.
 *
 * Three separate problems, all of them about the ground BETWEEN buildings:
 *
 *  1. **The doorstep cliff.** `resolveSettlement` grounds every pad at the
 *     HIGHEST of its five footprint samples so floors never sink. On a slope
 *     that puts the floor well above the dirt outside the door — for a 10 m
 *     deep keep on a 15 % site, over a metre. The collider papers over it with
 *     a skirt platform that reaches 0.65 m past the wall, so brushing a
 *     building teleports you up the whole delta in one tick. Paths land at the
 *     sill and walk you down to grade on steps.
 *  2. **No route.** Buildings were dropped on raw terrain with nothing joining
 *     them, so "walking through town" meant crossing whatever the noise did.
 *  3. **Nothing reads as built.** A settlement draped over a hill looks like
 *     scenery that landed there. Level runs with retaining kerbs between them
 *     read as ground somebody cut.
 *
 * ## What the engine actually permits
 *
 * The threshold below is derived, not guessed, but the derivation starts from
 * an awkward fact: **`controller.ts` enforces no slope limit and no step-up
 * limit at all.** It assigns `pos[1] = groundHeight(...)` unconditionally
 * (controller.ts:130-137), so a vertical cliff is "walkable" — you glide up it.
 * Asking "what can the controller climb" therefore has no useful answer.
 *
 * Two things in the engine DO bind, and both shape everything here:
 *
 *  - **`CLIMB_SLOPE_DEG = 42°` (vitals.ts).** Above this the game charges the
 *    player 20 stamina/s to move uphill. That is the engine's own statement of
 *    where walking stops and climbing starts, so it is the hard ceiling: no
 *    interval of any path may exceed `tan(42°) = 0.900`. It is imported rather
 *    than copied so that moving the stamina rule moves the paths with it.
 *  - **Blockers are infinitely tall.** `slideXZ` never reads `SolidBox.top`
 *    (settlement-collider.ts:156-173), so a solid is an infinite prism and you
 *    can never mount one at any height. **Steps must therefore be `platforms`,
 *    never `blockers`** — a stair built out of blockers is a wall. Platforms
 *    stack under `Math.max`, which is exactly stair behaviour and is why a
 *    flight here is just N overlapping platform boxes.
 *
 * The second threshold, `RAMP_GRADE`, is where a run stops being a slope and
 * becomes steps. It reuses the project's existing definition of ground flat
 * enough to build on — the 20° gate the player's own build placement applies
 * (main.ts:5748-5752). A path is a structure; if the game will not let you set
 * a crate down on that ground, the path gets stairs instead of a tilt.
 *
 * ## Shape of the system
 *
 * Planning is pure local-space geometry (`planSettlementPaths`) and resolution
 * is a separate pass against the heightfield (`resolveSettlementPaths`), the
 * same split settlement-layout already uses. Everything is axis-aligned,
 * because `SolidBox` is axis-aligned and because the plans themselves are laid
 * out on cardinal streets — a diagonal path could not be collided and would cut
 * across the grain of every settlement in the game.
 *
 * Determinism: no rng is consulted at all. The network is a function of the pad
 * list, which is already a pure function of (kind, seed); paving variation is
 * hashed from tile coordinates with `mix32`. Same seed, same town, same steps.
 */

import { mix32 } from '../dungeon/dungeon-layout';
import { CLIMB_SLOPE_DEG } from '../vitals';
import type { BuildingPad, PadType } from './settlement-layout';
import { padHalfExtents } from './settlement-plans';
import type { SettlementKind, SettlementSite } from './settlement-scatter';

// --- thresholds --------------------------------------------------------------

/**
 * Hard ceiling on the grade of any path interval — `tan(CLIMB_SLOPE_DEG)`.
 *
 * Above 42° the game itself stops calling this walking and starts draining
 * stamina at 20/s (vitals.ts:31, main.ts:6608-6620). Nothing this file emits
 * may exceed it, including the effective rise/run of a flight of steps: a
 * staircase steeper than the climb threshold is a ladder.
 */
export const MAX_GRADE = Math.tan((CLIMB_SLOPE_DEG * Math.PI) / 180);

/**
 * The project's own "flat enough to build on" line, in degrees — the gate the
 * player's structure placement applies at main.ts:5748-5752. Duplicated as a
 * number because it is inline in main.ts and main.ts cannot be imported here.
 */
const BUILD_SLOPE_DEG = 20;

/** Grade above which a run becomes steps rather than a tilt. `tan(20°)`. */
export const RAMP_GRADE = Math.tan((BUILD_SLOPE_DEG * Math.PI) / 180);

/** Riser height for a flight (m). */
const RISER = 0.24;
/**
 * Shallowest tread we will cut (m). Without this, a steep interval subdivides
 * into risers so shallow the treads are narrower than a foot and the flight
 * reads as a ramp with cracks in it. Capping tread depth instead raises the
 * riser, which is what a real stonemason does on a steep bank.
 */
const MIN_TREAD = 0.3;

/** Profile sample spacing along a run (m). */
const STATION = 1.4;
/** Paving sits this far above the ground it rests on (m). */
const PATH_TOP = 0.07;
/**
 * How deep the uphill shoulder of a path is allowed to be buried (m).
 *
 * A road cut into a hillside has its uphill side CUT AWAY and its downhill side
 * filled and revetted. Terrain here is a pure function and cannot be cut, so
 * the only way to express the uphill half of that is to let the bank bury the
 * kerb — which is what it looks like anyway.
 *
 * The first version instead lifted the surface to clear the HIGHEST sample
 * across the full width, exactly the rule the building pads use. On a street
 * 3.4 m wide over ground averaging 18 % that adds 0.3 m of lift, and on a
 * junction landing sampled to its diagonal corners it added nearly 0.9 m —
 * every one of which then had to be given back as a descent, so the profile
 * paid for it in steps. Measured: 11 % of the raw terrain intervals under a
 * castle are too steep to walk, but 36 % of the built path came out stepped.
 * The extra 25 % was this, and this alone.
 */
const BURY = 0.25;
/**
 * A tile whose surface is within this of the terrain under it gets NO collider.
 *
 * This is the single most important performance and feel decision in the file.
 * Terrain already carries the player smoothly at 0.1 m per tick; replacing that
 * with a row of flat-topped `SolidBox`es would make a gentle street CHUNKIER
 * than the bare hillside it replaced, and would add hundreds of boxes to a list
 * that `settlementGround.near()` scans linearly on every collision probe. So
 * collision is spent only where the path actually departs from the ground:
 * treads, and terraces standing proud of the dirt.
 */
const FOLLOW_TOL = 0.12;
/** Lift above terrain at which a tile grows a retaining face (m). */
const KERB_MIN = 0.13;
/**
 * Retaining face at or above this height becomes a blocker (m).
 *
 * Deliberately high, and the number is a risk trade rather than a measurement.
 * A blocker is an infinite prism that eats `RADIUS = 0.35` m of walkable width
 * on BOTH sides, because pushout has no notion of which side of it you are on.
 * The first pass at 1.0 m put 368 of them through a castle — a town threaded
 * with invisible walls is a far worse answer to "let me move through the town"
 * than being able to clip through a knee-high revetment. At 1.6 m the wall is
 * chest height on a 1.7 m character, which is the point where walking through
 * it is unmistakable and blocking is worth the width it costs.
 */
const RETAIN_BLOCK_H = 1.6;

/**
 * How far a step tread's collider is pulled in from the edges of the flight (m).
 * Slightly MORE than the capsule radius, so the capsule has to be genuinely on
 * the stair before it is carried. At 0.3 (just under the radius) brushing still
 * lifted; 0.45 measurably reduced the worst lateral pop from 1.76 m to 1.47 m,
 * and a 1.9 m spur still keeps a metre of standable tread.
 */
const TREAD_INSET = 0.45;

/** Player capsule radius (controller.ts:18) — what a corridor must clear. */
const RADIUS = 0.35;

/** Half-widths (m). A castle street, a lane, a doorway spur. */
const HALF_TRUNK = 1.7;
const HALF_SPUR = 0.95;

/**
 * How far outside a pad's door face its path node sits (m).
 *
 * Not cosmetic. The node is pinned to the building's floor level and the
 * terrain outside is lower, so this distance is the run available to absorb
 * that drop: at `MAX_GRADE` the stoop it leaves room for swallows about 2 m
 * of sill once the junction landing has taken its share, which
 * covers every doorstep cliff the spread budgets can produce. Shorter, and the
 * front step of a keep on a slope becomes un-walkable by the engine's own
 * definition. It also clears the pad's own blocker, which reaches 0.35 m past
 * the wall.
 */
const DOOR_MARGIN = 3.2;

/**
 * Closest a doorway node may sit to its own wall when pulled in to find clear
 * ground (m). Below this it is inside the building's own collider.
 */
const CLEAR_MIN = 1.3;
/** Clearance a doorway node needs around it before it counts as placeable (m). */
const CLEAR_R = 0.55;
/**
 * Overlap a doorway spur may have with buildings before it is abandoned (m2).
 * Small but not zero: clipping the corner of a hedge is not worth losing a
 * house's front path over.
 */
const SPUR_BLOCK_TOL = 0.6;

/**
 * Overlap at which the repair pass re-lays an edge as a lane (m2). Generous
 * enough that clipping a hedge corner is left alone.
 */
const REPAIR_TOL = 0.8;

/** Nodes closer than this collapse into one (m). */
const NODE_MERGE = 1.2;
/** Segments shorter than this are dropped as degenerate (m). */
const MIN_SEG = 0.35;

/**
 * Pads a path may cross. Poles, cloth and painted ground are not obstacles —
 * routing around a washing line would bend a street for nothing. Everything
 * else, including crops and graves, is something a street should go around.
 */
const PASSABLE: ReadonlySet<PadType> = new Set<PadType>([
  'signpost', 'lamp', 'banner', 'washline',
]);

/**
 * Pads that get their own doorway spur. These are the places a person is
 * going: somewhere to live, work, worship, buy or be locked up. `well` is
 * excluded because it is a hub (below) rather than a destination with a door,
 * and towers and curtain walls have no ground-level entrance at all.
 */
const SERVED: ReadonlySet<PadType> = new Set<PadType>([
  'house', 'townhouse', 'barn', 'keep', 'church', 'tavern', 'longhouse',
  'smithy', 'mill', 'granary', 'stable', 'jail', 'stall', 'shrine',
]);

/** Gatehouse passage half-width — matches PIER_W in settlement-collider. */
const GATE_PASSAGE = 2.2;

// --- plan (pure, local space) ------------------------------------------------

export type PathNodeKind = 'gate' | 'hub' | 'door' | 'bend';

export interface PathNode {
  x: number;
  z: number;
  kind: PathNodeKind;
  /** Index into the pad list for `door` nodes, -1 otherwise. */
  pad: number;
}

/** A single axis-aligned street segment between two nodes. */
export interface PathEdge {
  a: number;
  b: number;
  halfW: number;
}

export interface SettlementPathPlan {
  nodes: PathNode[];
  edges: PathEdge[];
}

interface Obstacle {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Which pad this footprint belongs to — a door may stand against its own. */
  pad: number;
}

/**
 * Solid footprints a street must not cross. A gatehouse contributes its two
 * piers rather than its whole footprint — it exists to be walked through, and
 * treating it as solid would send the castle's approach street around the
 * curtain wall instead of under the arch.
 */
function obstaclesOf(pads: readonly BuildingPad[]): Obstacle[] {
  const out: Obstacle[] = [];
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    if (PASSABLE.has(pad.type)) continue;
    const { hx, hz } = padHalfExtents(pad);
    if (pad.type === 'gatehouse') {
      // Piers flank a clear passage; which axis they flank follows the yaw.
      const alongX = Math.abs(Math.cos(pad.yaw)) > 0.5;
      if (alongX) {
        out.push({ x0: pad.x - hx, z0: pad.z - hz, x1: pad.x - GATE_PASSAGE, z1: pad.z + hz, pad: i });
        out.push({ x0: pad.x + GATE_PASSAGE, z0: pad.z - hz, x1: pad.x + hx, z1: pad.z + hz, pad: i });
      } else {
        out.push({ x0: pad.x - hx, z0: pad.z - hz, x1: pad.x + hx, z1: pad.z - GATE_PASSAGE, pad: i });
        out.push({ x0: pad.x - hx, z0: pad.z + GATE_PASSAGE, x1: pad.x + hx, z1: pad.z + hz, pad: i });
      }
      continue;
    }
    out.push({ x0: pad.x - hx, z0: pad.z - hz, x1: pad.x + hx, z1: pad.z + hz, pad: i });
  }
  return out;
}

/** Outward unit direction of a pad's door face — matches npc-spawn.doorSpot. */
function faceOut(pad: BuildingPad): [number, number] {
  return [Math.sin(pad.yaw), -Math.cos(pad.yaw)];
}

/**
 * Area of overlap between an axis-aligned corridor and the obstacle set.
 * Used as the routing cost, so "clips a hedge corner" loses to "drives through
 * the church" rather than both simply reading as blocked.
 */
function blockage(
  x0: number, z0: number, x1: number, z1: number, halfW: number,
  obstacles: readonly Obstacle[], skipPad: number,
): number {
  const ax0 = Math.min(x0, x1) - halfW;
  const ax1 = Math.max(x0, x1) + halfW;
  const az0 = Math.min(z0, z1) - halfW;
  const az1 = Math.max(z0, z1) + halfW;
  let area = 0;
  for (const o of obstacles) {
    if (o.pad === skipPad) continue;
    const ox = Math.min(ax1, o.x1) - Math.max(ax0, o.x0);
    const oz = Math.min(az1, o.z1) - Math.max(az0, o.z0);
    if (ox > 0 && oz > 0) area += ox * oz;
  }
  return area;
}

/** Squared distance from a point to an axis-aligned segment, plus the foot. */
function nearestOnSeg(
  px: number, pz: number, ax: number, az: number, bx: number, bz: number,
): { x: number; z: number; d2: number; t: number } {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
  const x = ax + dx * t;
  const z = az + dz * t;
  return { x, z, d2: (px - x) * (px - x) + (pz - z) * (pz - z), t };
}

/**
 * A coarse occupancy grid of the settlement, one per street width, for the
 * cases the dog-leg router cannot solve.
 *
 * L and Z routes handle open ground and single obstacles, which is nearly
 * everything — but not a castle. Its market sits east of an unbroken column of
 * town houses whose only gaps are 1.2 m wide, so no two- or three-segment route
 * from the market to the approach street exists at all, and "least bad" meant a
 * 3.4 m street laid straight through somebody's front room. Measured: 9 tiles
 * per castle more than half-swallowed by a building, and the in-game walk
 * pinned against a collider unable to advance.
 */
interface RouteGrid {
  x0: number;
  z0: number;
  cell: number;
  nx: number;
  nz: number;
  blocked: Uint8Array;
}

/**
 * Cell size (m). Not a free tuning knob — measured on the castle at seed 1337:
 *
 *     0.9  ->  0 buried tiles, 6.7 ms
 *     1.2  ->  0 buried tiles, 5.6 ms
 *     1.5  ->  9 buried tiles, 4.7 ms
 *
 * At 1.5 the grid can no longer resolve the gap the market lane goes through,
 * the router reports no route, and the fallback puts a street through a town
 * house again. Raise this and the failure is silent.
 */
const GRID_CELL = 1.2;
/**
 * Cost of changing direction, in cells. Without it Dijkstra returns a
 * minimal-length staircase of single-cell jogs, which is a legal route and a
 * ridiculous street. At 5 the router buys a straight run wherever one exists.
 */
const TURN_COST = 5;

function makeRouteGrid(
  obstacles: readonly Obstacle[], halfW: number,
  minX: number, minZ: number, maxX: number, maxZ: number,
): RouteGrid {
  const cell = GRID_CELL;
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 1);
  const blocked = new Uint8Array(nx * nz);
  for (const o of obstacles) {
    // Inflate by the street half-width: a cell is usable only if the whole
    // corridor centred on it clears the building.
    //
    // KNOWN DEFECT, deliberately left alone. `floor`/`ceil` block every cell
    // the inflated box grazes, so a cell whose CENTRE is a whole `GRID_CELL`
    // outside it — a corridor that provably misses the building — is marked
    // solid. Each obstacle therefore grows by up to 2.2 m per side at spur
    // width. Village and town cores are buildings ringing an open green at 4-6
    // m spacing, which is exactly the gap that erases: the core rasterises into
    // one blob, `gridRoute` reports "no route", and the repair pass below drops
    // the street at the ROOT of the network. Measured over a 13x13-cell sweep,
    // that strands 54% of a village's junctions and 62% of a town's.
    //
    // Blocking on the cell centre instead (ceil/floor, +-1e-6) is sound — both
    // street widths exceed `GRID_CELL / 2`, so adjacent free centres' corridors
    // overlap — and takes reachability from 61% to 96%. It is NOT applied here
    // because it only moves the failure: the routes it restores are ones the
    // router used to give up on, and walking them measured a 2.57 m single-tick
    // ground pop (bound 1.6) with one network still impassable. The controller
    // snaps to ground with no limit, so that is a teleport, not a step. Fixing
    // it properly means terracing the restored routes, which is a change to the
    // stair generator and not one to make blind.
    const i0 = Math.max(0, Math.floor((o.x0 - halfW - minX) / cell));
    const i1 = Math.min(nx - 1, Math.ceil((o.x1 + halfW - minX) / cell));
    const j0 = Math.max(0, Math.floor((o.z0 - halfW - minZ) / cell));
    const j1 = Math.min(nz - 1, Math.ceil((o.z1 + halfW - minZ) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) blocked[j * nx + i] = 1;
    }
  }
  return { x0: minX, z0: minZ, cell, nx, nz, blocked };
}

/** Nearest free cell to a point, searched outward in rings. Null if none near. */
function freeCell(g: RouteGrid, x: number, z: number): number {
  const ci = Math.round((x - g.x0) / g.cell);
  const cj = Math.round((z - g.z0) / g.cell);
  for (let r = 0; r <= 4; r++) {
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) continue;
        if (g.blocked[j * g.nx + i] === 0) return j * g.nx + i;
      }
    }
  }
  return -1;
}

/**
 * Dijkstra over (cell, heading) with a turn penalty, returning the route's
 * corner points in settlement-local coordinates, or null when no route exists.
 *
 * Deliberately not A*: the grid is a few tens of thousands of cells, this runs
 * only on the handful of edges the dog-leg router could not lay, and a plain
 * bucket queue is easier to keep deterministic than a heap with tie-breaks.
 */
function gridRoute(
  g: RouteGrid, ax: number, az: number, bx: number, bz: number,
): { x: number; z: number }[] | null {
  const start = freeCell(g, ax, az);
  const goal = freeCell(g, bx, bz);
  if (start < 0 || goal < 0) return null;
  const n = g.nx * g.nz;
  const S = n * 4;
  const dist = new Int32Array(S).fill(0x7fffffff);
  const from = new Int32Array(S).fill(-1);
  const DI = [1, -1, 0, 0];
  const DJ = [0, 0, 1, -1];
  // Bucket queue: every edge costs 1 or 1 + TURN_COST, so a monotone ring of
  // (TURN_COST + 2) buckets is enough and each pop is O(1).
  const NB = TURN_COST + 2;
  const buckets: number[][] = [];
  for (let i = 0; i < NB; i++) buckets.push([]);
  for (let d = 0; d < 4; d++) { dist[start * 4 + d] = 0; buckets[0].push(start * 4 + d); }
  let done = -1;
  for (let base = 0, empty = 0; empty <= NB * 2 && done < 0; base++) {
    const b = buckets[base % NB];
    if (b.length === 0) { empty++; continue; }
    empty = 0;
    const wave = b.splice(0, b.length);
    for (const st of wave) {
      if (dist[st] !== base) continue;   // stale entry
      const cellI = st >> 2;
      const dir = st & 3;
      if (cellI === goal) { done = st; break; }
      const i = cellI % g.nx;
      const j = (cellI - i) / g.nx;
      for (let nd = 0; nd < 4; nd++) {
        const ni = i + DI[nd];
        const nj = j + DJ[nd];
        if (ni < 0 || nj < 0 || ni >= g.nx || nj >= g.nz) continue;
        const nc = nj * g.nx + ni;
        if (g.blocked[nc] === 1) continue;
        const cost = base + 1 + (nd === dir ? 0 : TURN_COST);
        const ns = nc * 4 + nd;
        if (cost < dist[ns]) {
          dist[ns] = cost;
          from[ns] = st;
          buckets[cost % NB].push(ns);
        }
      }
    }
  }
  if (done < 0) {
    // The goal may have been reached on a heading we never popped.
    let best = -1;
    for (let d = 0; d < 4; d++) {
      const st = goal * 4 + d;
      if (from[st] !== -1 && (best < 0 || dist[st] < dist[best])) best = st;
    }
    if (best < 0) return null;
    done = best;
  }
  // Walk back, keeping only the corners.
  const cells: number[] = [];
  for (let st = done; st !== -1; st = from[st]) {
    const c = st >> 2;
    if (cells.length === 0 || cells[cells.length - 1] !== c) cells.push(c);
    if (c === start) break;
  }
  cells.reverse();
  if (cells.length < 2) return null;
  const pt = (c: number) => {
    const i = c % g.nx;
    return { x: g.x0 + i * g.cell, z: g.z0 + ((c - i) / g.nx) * g.cell };
  };
  const out: { x: number; z: number }[] = [];
  for (let k = 1; k < cells.length - 1; k++) {
    const p = pt(cells[k - 1]), q = pt(cells[k]), r = pt(cells[k + 1]);
    const turned = Math.sign(q.x - p.x) !== Math.sign(r.x - q.x) ||
      Math.sign(q.z - p.z) !== Math.sign(r.z - q.z);
    if (turned) out.push(q);
  }
  return out;
}

/**
 * Emit an axis-aligned chain of streets through a list of corner points.
 *
 * The grid router's corners are snapped to grid centres while the endpoints it
 * was asked to join are not, so its first and last hops are very slightly
 * diagonal. A diagonal segment cannot be expressed here at all: tiles are
 * axis-aligned rectangles because `SolidBox` is, and a diagonal one becomes its
 * own bounding box — a 20 m street turning into a 20 x 14 m plaza. So every hop
 * that is not already on an axis gets an elbow, chosen by the same blockage
 * test as everywhere else.
 */
function emitChain(
  plan: SettlementPathPlan, ai: number, pts: readonly { x: number; z: number }[],
  bi: number, halfW: number, obstacles: readonly Obstacle[], skipPad: number,
): void {
  const addBend = (x: number, z: number): number => {
    plan.nodes.push({ x, z, kind: 'bend', pad: -1 });
    return plan.nodes.length - 1;
  };
  let prev = ai;
  const hop = (toIdx: number): void => {
    const p = plan.nodes[prev];
    const q = plan.nodes[toIdx];
    const dx = Math.abs(q.x - p.x);
    const dz = Math.abs(q.z - p.z);
    if (dx < MIN_SEG || dz < MIN_SEG) {
      if (dx >= MIN_SEG || dz >= MIN_SEG) plan.edges.push({ a: prev, b: toIdx, halfW });
      prev = toIdx;
      return;
    }
    const c0 = blockage(p.x, p.z, p.x, q.z, halfW, obstacles, skipPad) +
      blockage(p.x, q.z, q.x, q.z, halfW, obstacles, skipPad);
    const c1 = blockage(p.x, p.z, q.x, p.z, halfW, obstacles, skipPad) +
      blockage(q.x, p.z, q.x, q.z, halfW, obstacles, skipPad);
    const e = c0 <= c1 ? addBend(p.x, q.z) : addBend(q.x, p.z);
    plan.edges.push({ a: prev, b: e, halfW });
    plan.edges.push({ a: e, b: toIdx, halfW });
    prev = toIdx;
  };
  for (const c of pts) hop(addBend(c.x, c.z));
  hop(bi);
}

/**
 * Lay one street between two nodes as an axis-aligned dog-leg, picking the
 * elbow that fouls the fewest buildings.
 *
 * `leadAxis` forces which leg comes first: a doorway spur must leave along the
 * door's own facing or the path starts by sliding sideways along the wall.
 * Returns the node indices actually joined so the caller can register them.
 */
function routeAxis(
  plan: SettlementPathPlan, ai: number, bi: number, halfW: number,
  obstacles: readonly Obstacle[], skipPad: number, leadAxis: 0 | 1 | -1,
  grid: RouteGrid | null = null,
  narrowGrid: RouteGrid | null = null,
  narrowHalfW = halfW,
  maxBlock = Infinity,
): boolean {
  const a = plan.nodes[ai];
  const b = plan.nodes[bi];
  const dx = Math.abs(b.x - a.x);
  const dz = Math.abs(b.z - a.z);

  // Already aligned on one axis: a single straight run, no elbow to choose.
  //
  // It still has to be CHECKED. The first version took this branch as a fast
  // path and pushed the edge unexamined, on the reasoning that there was no
  // choice to make — which is true, and irrelevant: a town's main street runs
  // dead straight south out of its market square, and the pillory stands in the
  // middle of that square. The street was laid through it, and because a
  // blocker is an infinite prism the walk test found the capsule pressed into
  // its face for 326 consecutive ticks with nowhere to slide.
  if (dx < MIN_SEG || dz < MIN_SEG) {
    if (dx < MIN_SEG && dz < MIN_SEG) return false;
    const straight = blockage(a.x, a.z, b.x, b.z, halfW, obstacles, skipPad);
    if (straight > 0.01 && grid !== null) {
      const corners = gridRoute(grid, a.x, a.z, b.x, b.z);
      if (corners !== null && corners.length > 0) {
        emitChain(plan, ai, corners, bi, halfW, obstacles, skipPad);
        return true;
      }
      if (narrowGrid !== null && narrowHalfW < halfW) {
        const narrow = gridRoute(narrowGrid, a.x, a.z, b.x, b.z);
        if (narrow !== null && narrow.length > 0) {
          emitChain(plan, ai, narrow, bi, narrowHalfW, obstacles, skipPad);
          return true;
        }
      }
    }
    if (straight > maxBlock) return false;
    plan.edges.push({ a: ai, b: bi, halfW });
    return true;
  }

  // Elbow 0 travels z first, elbow 1 travels x first.
  const e0x = a.x, e0z = b.z;
  const e1x = b.x, e1z = a.z;
  const c0 = blockage(a.x, a.z, e0x, e0z, halfW, obstacles, skipPad) +
    blockage(e0x, e0z, b.x, b.z, halfW, obstacles, skipPad);
  const c1 = blockage(a.x, a.z, e1x, e1z, halfW, obstacles, skipPad) +
    blockage(e1x, e1z, b.x, b.z, halfW, obstacles, skipPad);

  // Preference, then cost. `leadAxis` is a preference and not a command: a
  // door on the far side of its own building from the junction would otherwise
  // be told to leave along its facing and immediately drive back through the
  // house it belongs to, which is exactly the failure the preference exists to
  // avoid on every other door.
  let useFirst: boolean;
  const preferred = leadAxis === 1 ? true : leadAxis === 0 ? false : null;
  if (preferred !== null && (preferred ? c0 : c1) <= (preferred ? c1 : c0) + 1e-6) {
    useFirst = preferred;
  } else if (Math.abs(c0 - c1) > 1e-6) {
    useFirst = c0 < c1;
  } else {
    useFirst = dz >= dx;                       // deterministic tie-break
  }

  const bestL = Math.min(c0, c1);

  // Both elbows foul something: try a dog-leg with two bends instead — out,
  // across, and back in — which is how a real street gets round a block. Only
  // taken when it is strictly better, so a settlement on open ground still gets
  // plain corners.
  //
  // Without this the castle's trunk had nowhere to go: the route from its
  // market well to the gate is blocked by a row of town houses one way and by
  // the houses behind them the other, so "least bad" meant a 3.4 m street laid
  // straight through a town house, and the walk test pinned the player on its
  // collider for 170 consecutive ticks.
  let bestZ = Infinity;
  if (bestL > 0.01) {
    let bm = 0;
    let bAlongX = true;
    for (let k = 1; k <= 5; k++) {
      const f = k / 6;
      const mx = a.x + (b.x - a.x) * f;
      const cx = blockage(a.x, a.z, mx, a.z, halfW, obstacles, skipPad) +
        blockage(mx, a.z, mx, b.z, halfW, obstacles, skipPad) +
        blockage(mx, b.z, b.x, b.z, halfW, obstacles, skipPad);
      if (cx < bestZ - 1e-9) { bestZ = cx; bm = mx; bAlongX = true; }
      const mz = a.z + (b.z - a.z) * f;
      const cz = blockage(a.x, a.z, a.x, mz, halfW, obstacles, skipPad) +
        blockage(a.x, mz, b.x, mz, halfW, obstacles, skipPad) +
        blockage(b.x, mz, b.x, b.z, halfW, obstacles, skipPad);
      if (cz < bestZ - 1e-9) { bestZ = cz; bm = mz; bAlongX = false; }
    }
    // Still fouling something after three segments: hand it to the grid router,
    // which can go round a whole block. Tried last because it is the expensive
    // option and because its output, however well simplified, never reads quite
    // as much like a street as a plain corner does.
    if (Math.min(bestZ, bestL) > 0.01 && grid !== null) {
      const corners = gridRoute(grid, a.x, a.z, b.x, b.z);
      if (corners !== null && corners.length > 0) {
        emitChain(plan, ai, corners, bi, halfW, obstacles, skipPad);
        return true;
      }
      // No route at this width. Try again as a LANE: a castle's market sits
      // behind a row of town houses whose gaps are barely a metre, so nothing
      // 3.4 m wide reaches it from the approach street at all, and the choice is
      // between a narrow back lane and a full-width street through a front room.
      if (narrowGrid !== null && narrowHalfW < halfW) {
        const narrow = gridRoute(narrowGrid, a.x, a.z, b.x, b.z);
        if (narrow !== null && narrow.length > 0) {
          emitChain(plan, ai, narrow, bi, narrowHalfW, obstacles, skipPad);
          return true;
        }
      }
    }

    if (bestZ < bestL - 1e-6) {
      const p0 = bAlongX ? { x: bm, z: a.z } : { x: a.x, z: bm };
      const p1 = bAlongX ? { x: bm, z: b.z } : { x: b.x, z: bm };
      const n0 = plan.nodes.length;
      plan.nodes.push({ x: p0.x, z: p0.z, kind: 'bend', pad: -1 });
      const n1 = plan.nodes.length;
      plan.nodes.push({ x: p1.x, z: p1.z, kind: 'bend', pad: -1 });
      plan.edges.push({ a: ai, b: n0, halfW });
      plan.edges.push({ a: n0, b: n1, halfW });
      plan.edges.push({ a: n1, b: bi, halfW });
      return true;
    }
  }

  // Nothing clean was found. `maxBlock` is the caller's tolerance for laying it
  // anyway: a doorway spur passes a small number and simply goes unbuilt, a
  // trunk passes Infinity because dropping it would strand a whole quarter.
  if (Math.min(bestL, bestZ) > maxBlock) return false;

  const ex = useFirst ? e0x : e1x;
  const ez = useFirst ? e0z : e1z;
  const ci = plan.nodes.length;
  plan.nodes.push({ x: ex, z: ez, kind: 'bend', pad: -1 });
  plan.edges.push({ a: ai, b: ci, halfW });
  plan.edges.push({ a: ci, b: bi, halfW });
  return true;
}

/**
 * Nudge a point to the nearest spot clear of buildings, searching outward in
 * rings up to `maxR`. Returns the original point when nothing near is clear.
 *
 * Hub and gate nodes used to be placed by formula alone — a well's node 2.4 m
 * off its door face, a market's at the centroid of its stalls. In an open
 * village that is fine. In a town's market square it put the hub inside the
 * pillory's collider, and every street leaving the square then started inside a
 * solid, which no amount of careful routing downstream can recover from.
 */
function placeClear(
  x: number, z: number, obstacles: readonly Obstacle[], maxR = 4.5,
): { x: number; z: number } {
  if (!obstructed(x, z, obstacles, -1)) return { x, z };
  for (let r = 0.6; r <= maxR + 1e-6; r += 0.6) {
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const nx = x + Math.cos(a) * r;
      const nz = z + Math.sin(a) * r;
      if (!obstructed(nx, nz, obstacles, -1)) return { x: nx, z: nz };
    }
  }
  return { x, z };
}

/**
 * Is this point inside a building footprint, or within `CLEAR_R` of one?
 *
 * The margin matters: a node exactly on a wall passes a strict inside test and
 * still puts the landing centred on it half inside the building.
 */
function obstructed(
  x: number, z: number, obstacles: readonly Obstacle[], skipPad: number,
): boolean {
  for (const o of obstacles) {
    if (o.pad === skipPad) continue;
    if (x > o.x0 - CLEAR_R && x < o.x1 + CLEAR_R &&
        z > o.z0 - CLEAR_R && z < o.z1 + CLEAR_R) return true;
  }
  return false;
}

/** Blockage of the better of the two dog-leg elbows between two points. */
function routeBlockage(
  ax: number, az: number, bx: number, bz: number, halfW: number,
  obstacles: readonly Obstacle[], skipPad: number,
): number {
  const c0 = blockage(ax, az, ax, bz, halfW, obstacles, skipPad) +
    blockage(ax, bz, bx, bz, halfW, obstacles, skipPad);
  const c1 = blockage(ax, az, bx, az, halfW, obstacles, skipPad) +
    blockage(bx, az, bx, bz, halfW, obstacles, skipPad);
  return Math.min(c0, c1);
}

/**
 * Attach a node to the network already laid, splitting an edge at the foot of
 * the perpendicular when the join is mid-street. That split is what turns a
 * bare tree into a street plan: doorway spurs meet the road at a T instead of
 * all converging on one junction, and because each spur joins the network the
 * moment it is laid, a later door can branch off an earlier neighbour's spur
 * exactly the way a real lane grows.
 *
 * The candidate is chosen by BLOCKAGE first and distance second, which is not
 * a refinement — it is the whole correctness of the routing. Choosing purely by
 * distance, as the first version did, put a junction at the geometric centre of
 * the castle's church and drove its street straight through the nave; the
 * in-game walk then pinned the player against the church's collider at
 * x = -217.35 for 170 consecutive ticks. Nothing in the generator noticed,
 * because every number it checks was still perfectly consistent.
 *
 * Returns the node index joined to, or -1 when there is no network yet.
 */
function attach(
  plan: SettlementPathPlan, px: number, pz: number, halfW: number,
  obstacles: readonly Obstacle[], skipPad: number,
): number {
  let bestEdge = -1;
  let bestScore = Infinity;
  let bx = 0, bz = 0, bt = 0;
  const consider = (ei: number, x: number, z: number, t: number): void => {
    if (obstructed(x, z, obstacles, skipPad)) return;
    const score = routeBlockage(px, pz, x, z, halfW, obstacles, skipPad) * 1000 +
      Math.abs(x - px) + Math.abs(z - pz);
    if (score < bestScore - 1e-9) {
      bestScore = score;
      bestEdge = ei;
      bx = x; bz = z; bt = t;
    }
  };
  for (let i = 0; i < plan.edges.length; i++) {
    const e = plan.edges[i];
    const a = plan.nodes[e.a];
    const b = plan.nodes[e.b];
    const n = nearestOnSeg(px, pz, a.x, a.z, b.x, b.z);
    consider(i, n.x, n.z, n.t);
    // The endpoints too: the perpendicular foot of a street that runs behind a
    // building is inside that building, and its ends usually are not.
    consider(i, a.x, a.z, 0);
    consider(i, b.x, b.z, 1);
  }
  if (bestEdge < 0) return -1;

  const e = plan.edges[bestEdge];
  const a = plan.nodes[e.a];
  const b = plan.nodes[e.b];
  if (Math.hypot(bx - a.x, bz - a.z) < NODE_MERGE || bt <= 0) return e.a;
  if (Math.hypot(bx - b.x, bz - b.z) < NODE_MERGE || bt >= 1) return e.b;

  // Mid-street: split into a T.
  const ji = plan.nodes.length;
  plan.nodes.push({ x: bx, z: bz, kind: 'bend', pad: -1 });
  const tail = e.b;
  e.b = ji;
  plan.edges.push({ a: ji, b: tail, halfW: e.halfW });
  return ji;
}

/**
 * Deterministic circulation plan for a settlement, in settlement-local coords.
 *
 * Trunk first: the gate, the wells, the market and both mouths of a gatehouse,
 * joined by a minimum spanning tree measured in MANHATTAN distance. The metric
 * is not a detail — every street here is an axis-aligned dog-leg, so L1 is the
 * true length of the road that will be built, and using L2 instead sent a
 * castle's approach street diagonally to the market square rather than
 * straight up the avenue of town houses and through the arch.
 *
 * Then doorway spurs, nearest-first from the gate, each joining wherever the
 * existing network is closest.
 */
export function planSettlementPaths(
  kind: SettlementKind, pads: readonly BuildingPad[],
): SettlementPathPlan {
  const plan: SettlementPathPlan = { nodes: [], edges: [] };
  const obstacles = obstaclesOf(pads);

  // One occupancy grid per street width, built once and only when something
  // actually needs it. Bounds come from the pads themselves plus a margin wide
  // enough for a street to run outside the built edge.
  let minX = -8, minZ = -8, maxX = 8, maxZ = 8;
  for (const pad of pads) {
    const { hx, hz } = padHalfExtents(pad);
    minX = Math.min(minX, pad.x - hx - 8);
    maxX = Math.max(maxX, pad.x + hx + 8);
    minZ = Math.min(minZ, pad.z - hz - 8);
    maxZ = Math.max(maxZ, pad.z + hz + 8);
  }
  const grids = new Map<number, RouteGrid>();
  const gridFor = (halfW: number): RouteGrid => {
    let g = grids.get(halfW);
    if (g === undefined) {
      g = makeRouteGrid(obstacles, halfW, minX, minZ, maxX, maxZ);
      grids.set(halfW, g);
    }
    return g;
  };

  /** Add a node unless one is already effectively there. */
  const addNode = (x: number, z: number, k: PathNodeKind, pad: number): number => {
    for (let i = 0; i < plan.nodes.length; i++) {
      const n = plan.nodes[i];
      if (Math.hypot(n.x - x, n.z - z) < NODE_MERGE) return i;
    }
    plan.nodes.push({ x, z, kind: k, pad });
    return plan.nodes.length - 1;
  };

  // --- the outward connection ------------------------------------------------
  // The signpost is where the settlement declares its own entrance: it stands
  // at the built edge facing inward (`faceDir` in the plans), and it is what
  // `teleportToNearestSettlementSign` puts an arriving player next to. Step in
  // front of it and that is the mouth of the street.
  let gate = -1;
  for (let i = 0; i < pads.length; i++) {
    if (pads[i].type !== 'signpost') continue;
    const [fx, fz] = faceOut(pads[i]);
    const g = placeClear(pads[i].x + fx * 1.8, pads[i].z + fz * 1.8, obstacles);
    gate = addNode(g.x, g.z, 'gate', -1);
    break;
  }

  // --- hubs ------------------------------------------------------------------
  const hubs: number[] = [];
  const stalls: BuildingPad[] = [];
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    if (pad.type === 'well') {
      const [fx, fz] = faceOut(pad);
      const w = placeClear(pad.x + fx * 2.4, pad.z + fz * 2.4, obstacles);
      hubs.push(addNode(w.x, w.z, 'hub', -1));
    } else if (pad.type === 'gatehouse') {
      // Both mouths, so the trunk is forced through the arch rather than
      // routed around a curtain wall it can never cross.
      const [fx, fz] = faceOut(pad);
      const reach = pad.d / 2 + 2.0;
      hubs.push(addNode(pad.x + fx * reach, pad.z + fz * reach, 'hub', -1));
      hubs.push(addNode(pad.x - fx * reach, pad.z - fz * reach, 'hub', -1));
    } else if (pad.type === 'stall') {
      stalls.push(pad);
    }
  }
  if (stalls.length >= 3) {
    let sx = 0, sz = 0;
    for (const s of stalls) { sx += s.x; sz += s.z; }
    const m = placeClear(sx / stalls.length, sz / stalls.length, obstacles);
    hubs.push(addNode(m.x, m.z, 'hub', -1));
  }

  // --- doorway nodes ---------------------------------------------------------
  //
  // Placed at DOOR_MARGIN out from the face if that spot is clear, and pulled
  // in toward the wall a third of a metre at a time until it is. Blind
  // placement puts the node inside whatever stands opposite — measured on a
  // village whose stable faced a house 4.5 m away, which put the stable's node
  // inside the house and then ran its whole stoop through the front room. If
  // nothing out to CLEAR_MIN is clear, the door simply goes unserved: no path
  // is better than a flight of steps through somebody's wall.
  const doors: number[] = [];
  const doorPad: number[] = [];
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    if (!SERVED.has(pad.type)) continue;
    const [fx, fz] = faceOut(pad);
    let placed = -1;
    for (let m = DOOR_MARGIN; m >= CLEAR_MIN - 1e-6; m -= 0.3) {
      const reach = pad.d / 2 + m;
      const x = pad.x + fx * reach;
      const z = pad.z + fz * reach;
      if (obstructed(x, z, obstacles, i)) continue;
      placed = addNode(x, z, 'door', i);
      break;
    }
    if (placed >= 0 && plan.nodes[placed].pad === i) {
      doors.push(placed);
      doorPad.push(i);
    }
  }

  // A settlement with no signpost (or none of the above) still needs an
  // origin, or nothing can attach to anything.
  if (gate < 0) {
    if (hubs.length > 0) gate = hubs[0];
    else if (doors.length > 0) gate = doors[0];
    else return plan;
  }

  // --- trunk: grow outward from the gate, hub by hub --------------------------
  //
  // Each hub joins the nearest CLEAR point on the street already laid, using the
  // same `attach` the doorways use — so a hub can join mid-street at a T, and
  // the join is picked for being clear of buildings rather than merely near.
  // The first version built a minimum spanning tree over the hubs and routed
  // its edges independently afterwards, so nothing ever asked whether the edge
  // it had already committed to could actually be laid.
  //
  // Distance is MANHATTAN throughout. Every street here is an axis-aligned
  // dog-leg, so L1 is the true length of the road that will be built; measured
  // in L2 the castle's approach ran diagonally to the market square instead of
  // straight up the avenue of town houses and through the arch.
  const rest = hubs.filter((h) => h !== gate);
  const g0 = plan.nodes[gate];
  rest.sort((p, q) => {
    const a = plan.nodes[p], b = plan.nodes[q];
    const da = Math.abs(a.x - g0.x) + Math.abs(a.z - g0.z);
    const db = Math.abs(b.x - g0.x) + Math.abs(b.z - g0.z);
    return da !== db ? da - db : p - q;
  });
  for (const h of rest) {
    const n = plan.nodes[h];
    let join = attach(plan, n.x, n.z, HALF_TRUNK, obstacles, -1);
    if (join < 0) join = gate;
    if (join === h) continue;
    routeAxis(plan, h, join, HALF_TRUNK, obstacles, -1, -1,
      gridFor(HALF_TRUNK), gridFor(HALF_SPUR), HALF_SPUR);
  }

  // --- doorway spurs ---------------------------------------------------------
  // Nearest-first from the gate so the street grows outward from the arrival
  // point; the order decides which spur is a branch and which is a trunk, and
  // growing from the gate is what makes the main street the main street.
  const g = plan.nodes[gate];
  const order = doors
    .map((n, k) => ({ n, k, d: Math.abs(plan.nodes[n].x - g.x) + Math.abs(plan.nodes[n].z - g.z) }))
    .sort((p, q) => (p.d !== q.d ? p.d - q.d : p.k - q.k));

  for (const { n, k } of order) {
    const node = plan.nodes[n];
    let join = attach(plan, node.x, node.z, HALF_SPUR, obstacles, -1);
    if (join < 0) join = gate;
    if (join === n) continue;
    const pad = pads[doorPad[k]];
    const [fx] = faceOut(pad);
    // Leave along the door's own facing: a spur that starts sideways runs
    // along the wall it is meant to be leaving.
    //
    // Nothing is excluded from the blockage test, not even the door's own
    // building. The first version excluded it, on the reasoning that a doorway
    // spur starts against its own wall. It does not — it starts CLEAR_MIN clear
    // of it — and the exemption instead made driving through your own house
    // free, so the "leave along the facing" preference lost to a straight line
    // and a smithy whose door faced west got its path laid east through the
    // forge: 26 run tiles inside one building, every grade still perfect.
    //
    // A spur that cannot be laid any other way is not laid at all. Doors are
    // leaves, so dropping one cannot disconnect anything else, and an unserved
    // back door reads as a back door — a lane through a nave does not.
    // Door spurs get the narrow-lane fallback the trunk routes already have.
    // A back door reached by a footpath is a back door; a back door with no
    // path at all is the commonest reason a settlement's doors go unserved,
    // and the fallback existed in `routeAxis` all along without this caller
    // ever passing it. Doors unserved 15% -> 5%.
    const lead: 0 | 1 = Math.abs(fx) > 0.5 ? 0 : 1;
    routeAxis(plan, n, join, HALF_SPUR, obstacles, -1, lead,
      gridFor(HALF_SPUR), null, HALF_SPUR, SPUR_BLOCK_TOL);
  }

  // --- repair -----------------------------------------------------------------
  //
  // A last sweep over everything that was laid, whatever laid it.
  //
  // The routers each validate their own choice, but two of them then emit
  // several segments from it — the Z detour emits three, the grid chain emits
  // one per corner plus an elbow wherever the grid's snapping left a hop
  // slightly diagonal — and nothing re-checked the pieces. A town's market
  // square is packed tight enough (six stalls, a well and a pillory inside
  // 15 m) that a 3.4 m street genuinely cannot leave it, so those unchecked
  // pieces are exactly where a street ended up laid across the pillory, and the
  // capsule sat against its face for 326 ticks.
  //
  // Repair is uniform and cheap: any edge still fouling a building is dropped
  // and re-laid as a LANE through the grid, which fits where a street will not.
  // Two passes, because a replacement chain is itself made of new edges.
  for (let pass = 0; pass < 2; pass++) {
    const broken: { i: number; e: PathEdge }[] = [];
    for (let i = 0; i < plan.edges.length; i++) {
      const e = plan.edges[i];
      const a = plan.nodes[e.a];
      const b = plan.nodes[e.b];
      if (blockage(a.x, a.z, b.x, b.z, e.halfW, obstacles, -1) > REPAIR_TOL) {
        broken.push({ i, e });
      }
    }
    if (broken.length === 0) break;
    // Highest index first so the splices do not shift the ones still to come.
    for (let k = broken.length - 1; k >= 0; k--) {
      const { i, e } = broken[k];
      const a = plan.nodes[e.a];
      const b = plan.nodes[e.b];
      const corners = gridRoute(gridFor(HALF_SPUR), a.x, a.z, b.x, b.z);
      plan.edges.splice(i, 1);
      // Nowhere to put it: the edge is dropped rather than kept.
      //
      // A town's market square really can be sealed — six stalls, a well and a
      // pillory inside 15 m leave no gap a street or even a lane can use — and
      // when that happens the choice is between no path and a path that lies.
      // Paving the player can see and follow into a collider is the worse of
      // the two: it reads as the way through, and it is not one.
      if (corners !== null && corners.length > 0) {
        emitChain(plan, e.a, corners, e.b, HALF_SPUR, obstacles, -1);
      }
    }
  }

  // `kind` is deliberately unused: the network falls out of the pads, and the
  // pads already encode everything the kind decides. Kept in the signature
  // because callers have it and a per-kind rule (a ranch wanting cart tracks
  // rather than streets, say) would want it here rather than re-derived.
  void kind;
  return plan;
}

// --- resolution (against the heightfield) ------------------------------------

/**
 * One paved rectangle. Either a graded run (`riser === 0`, top tilts from `yA`
 * to `yB`) or a level step tread (`yA === yB`, with a riser face of `riser`
 * metres at its leading edge).
 */
export interface PathTile {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Surface height at the low-s and high-s ends of the run. */
  yA: number;
  yB: number;
  /** Terrain height at the tile's two long edges — kerbs and skirts. */
  gL: number;
  gR: number;
  /**
   * Lowest terrain under the tile's CENTRELINE.
   *
   * Separate from the shoulders because the collider decision has to use it. A
   * path crossing a small gully has high ground on both shoulders and nothing
   * under the middle: judged on shoulders it looks flush with the ground and is
   * given no collider, so the player walks the gully floor and is then lifted
   * onto the first step of the flight beyond it — 1.76 m in one tick on a
   * village stair, against 0.57 m for the same walk over bare terrain.
   */
  gC: number;
  /** 0 = the run travels along x, 1 = along z. */
  axis: 0 | 1;
  /** True when the run travels toward +x / +z — which end is the leading edge. */
  fwd: boolean;
  /** A level junction landing rather than a piece of run. */
  land: boolean;
  /** Riser at the leading (low-s) edge; 0 for a graded run. */
  riser: number;
  /** Deterministic paving variant, 0..3. */
  v: number;
}

export interface PathStats {
  /** Total centreline length (m). */
  lengthM: number;
  /** Number of step treads cut. */
  treads: number;
  /** Steepest graded (non-step) interval, as a grade. */
  maxRunGrade: number;
  /** Steepest flight, rise over run. */
  maxFlightGrade: number;
  /** Intervals exceeding MAX_GRADE — must be 0. */
  overSteep: number;
  /** Greatest height the surface stands above the terrain (m). */
  maxLift: number;
  /** Largest single riser cut (m). */
  maxRiser: number;
  /**
   * Largest gap left at a threshold after its stoop has climbed as far as
   * MAX_GRADE allows (m) — the residual doorstep cliff.
   */
  maxDoorStep: number;
}

/** A junction of the finished network, in world space. */
export interface ResolvedPathNode {
  x: number;
  z: number;
  /** Surface height of this node's landing. */
  y: number;
  kind: PathNodeKind;
  /** Pad index for `door` nodes, -1 otherwise. */
  pad: number;
}

export interface ResolvedPaths {
  tiles: PathTile[];
  /**
   * The network as a walkable graph, kept alongside the tiles.
   *
   * Tests route on this — "hold W from the lowest junction to the highest and
   * check the player arrives" is the only assertion that measures the thing
   * this feature is for, and it needs somewhere to walk from and to. It is also
   * the obvious hook for NPCs to follow streets later, which is why it is a
   * real part of the result rather than a debug side channel.
   */
  nodes: ResolvedPathNode[];
  /** Index pairs into `nodes`. */
  links: [number, number][];
  stats: PathStats;
}

export const EMPTY_PATHS: ResolvedPaths = {
  tiles: [],
  nodes: [],
  links: [],
  stats: {
    lengthM: 0, treads: 0, maxRunGrade: 0, maxFlightGrade: 0,
    overSteep: 0, maxLift: 0, maxRiser: 0, maxDoorStep: 0,
  },
};

/** Per-edge sampling scratch, shared between the node pass and the profile pass. */
interface EdgeSamples {
  /** World-space start/end of the run. */
  ax: number; az: number; bx: number; bz: number;
  halfW: number;
  n: number;
  ds: number;
  /** Required surface height at each station (terrain across the width + top). */
  g: Float64Array;
  /** Terrain at the left and right edges, per station. */
  gl: Float64Array;
  gr: Float64Array;
  /** Terrain on the centreline, per station. */
  gc: Float64Array;
  a: number;
  b: number;
  axis: 0 | 1;
  /** Length of the graded run, landings already trimmed off both ends. */
  free: number;
}

/**
 * Lift a plan to world space and cut it into walkable tiles.
 *
 * Four stages, in order, because each depends on the last:
 *
 *  A. Sample the ground under every run — centre and both edges, so the paving
 *     is never buried by its own uphill shoulder.
 *  B. Fix a height for every node. A node starts at its nominal height (a door
 *     sits at its building's floor, everything else at grade) and is then
 *     RAISED to satisfy the cone constraint `y >= g_i - MAX_GRADE * s_i` from
 *     every station on every street that meets it. Raising is always safe —
 *     every constraint in this system is a lower bound — so one pass over the
 *     edges settles the whole graph with no iteration.
 *  C. Per run, dilate the profile: the classic two-sweep upper envelope of
 *     cones, which yields the LOWEST surface that stays above ground and never
 *     exceeds MAX_GRADE. Endpoints are pinned by stage B and never move, so
 *     adjoining streets agree at every junction by construction.
 *  D. Cut each interval into either a graded tile or a flight of treads.
 */
export function resolveSettlementPaths(
  site: SettlementSite,
  pads: readonly BuildingPad[],
  padY: readonly number[],
  plan: SettlementPathPlan,
  heightAt: (x: number, z: number) => number,
): ResolvedPaths {
  if (plan.edges.length === 0) return EMPTY_PATHS;

  /**
   * Half-size of the level landing at each node — the widest street meeting it.
   *
   * Runs stop this far short of their end nodes and a level square is laid in
   * the gap instead. Two reasons, and the second is the one that matters:
   *
   *  - Tiles are rectangles centred on their own centreline, so two streets
   *    meeting at a right angle leave one quadrant of the corner unpaved. On
   *    flat ground that is a wedge of grass; on a terrace standing two metres
   *    proud of the hill it is a hole you can see down.
   *  - A junction that is LEVEL is what makes a terraced town read as terraced.
   *    Real hill towns are a sequence of flat landings joined by graded runs
   *    and flights, not one continuous warp.
   *
   * Making the landing a first-class piece also means the run's pinned end sits
   * exactly on the landing edge, so the two abut instead of overlapping — no
   * coplanar z-fighting anywhere in the network.
   */
  const nodeHW = new Float64Array(plan.nodes.length);
  for (const e of plan.edges) {
    if (e.halfW > nodeHW[e.a]) nodeHW[e.a] = e.halfW;
    if (e.halfW > nodeHW[e.b]) nodeHW[e.b] = e.halfW;
  }
  /**
   * The landing size actually used, which is `nodeHW` shrunk by whichever
   * incident street is too short to give it away. Emitting the nominal size
   * instead would let a landing overrun a two-metre elbow leg and float over
   * the next landing along at a different height.
   */
  const nodeLand = nodeHW.slice();

  // --- A: sample ------------------------------------------------------------
  const samples: EdgeSamples[] = [];
  for (const e of plan.edges) {
    const na = plan.nodes[e.a];
    const nb = plan.nodes[e.b];
    const ax0 = site.x + na.x, az0 = site.z + na.z;
    const bx0 = site.x + nb.x, bz0 = site.z + nb.z;
    const full = Math.hypot(bx0 - ax0, bz0 - az0);
    if (full < MIN_SEG) continue;
    // Trim the landings off both ends. When they would meet or overlap, the
    // whole edge is junction: shrink both to touch and emit no run at all.
    let landA = Math.min(nodeHW[e.a], full * 0.5);
    let landB = Math.min(nodeHW[e.b], full * 0.5);
    if (landA + landB > full - MIN_SEG) {
      const k = (full - MIN_SEG * 0.5) / (landA + landB);
      landA *= k;
      landB *= k;
    }
    if (landA < nodeLand[e.a]) nodeLand[e.a] = landA;
    if (landB < nodeLand[e.b]) nodeLand[e.b] = landB;
    const free = full - landA - landB;
    const ux0 = (bx0 - ax0) / full;
    const uz0 = (bz0 - az0) / full;
    const ax = ax0 + ux0 * landA, az = az0 + uz0 * landA;
    const bx = bx0 + ux0 * -landB, bz = bz0 + uz0 * -landB;
    const axis: 0 | 1 = Math.abs(bx0 - ax0) >= Math.abs(bz0 - az0) ? 0 : 1;
    // Perpendicular offset for the shoulder samples.
    const px = axis === 0 ? 0 : e.halfW;
    const pz = axis === 0 ? e.halfW : 0;
    const n = Math.max(1, Math.round(free / STATION));
    const g = new Float64Array(n + 1);
    const gl = new Float64Array(n + 1);
    const gr = new Float64Array(n + 1);
    const gc = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      const l = heightAt(x - px, z - pz);
      const c = heightAt(x, z);
      const r = heightAt(x + px, z + pz);
      gl[i] = l;
      gr[i] = r;
      gc[i] = c;
      // Clear the centreline outright and the shoulders all but BURY metres:
      // the uphill kerb is allowed to disappear into the bank it is cut from.
      g[i] = Math.max(c, l - BURY, r - BURY) + PATH_TOP;
    }
    samples.push({
      ax, az, bx, bz, halfW: e.halfW, n, ds: Math.max(free, MIN_SEG) / n,
      g, gl, gr, gc, a: e.a, b: e.b, axis, free: Math.max(free, MIN_SEG),
    });
  }
  if (samples.length === 0) return EMPTY_PATHS;

  // --- B: node heights ------------------------------------------------------
  // Ground under each landing square, sampled at its centre and four corners:
  // the max is what the landing must clear, the min is how far it stands proud
  // of the hill and therefore how tall its retaining wall is.
  const nodeGHi = new Float64Array(plan.nodes.length);
  const nodeGLo = new Float64Array(plan.nodes.length);
  for (let i = 0; i < plan.nodes.length; i++) {
    if (nodeHW[i] <= 0) continue;
    const x = site.x + plan.nodes[i].x;
    const z = site.z + plan.nodes[i].z;
    const h = nodeHW[i];
    const c = heightAt(x, z);
    // Edge midpoints, not corners. A landing is cut square into the bank, and
    // sampling its diagonal reaches 1.41x further uphill than any edge of it
    // does — which on a slope lifted the whole junction by most of a metre.
    let hi = c;
    let lo = c;
    for (const [dx, dz] of [[-h, 0], [h, 0], [0, -h], [0, h]] as const) {
      const sm = heightAt(x + dx, z + dz);
      if (sm > hi) hi = sm;
      if (sm < lo) lo = sm;
    }
    nodeGHi[i] = Math.max(c, hi - BURY) + PATH_TOP;
    nodeGLo[i] = lo;
  }

  const nodeY = new Float64Array(plan.nodes.length);
  for (let i = 0; i < plan.nodes.length; i++) {
    nodeY[i] = nodeHW[i] > 0 ? nodeGHi[i] : -Infinity;
  }
  // Door nodes sit at GRADE, like every other node. The step up to the sill is
  // a stoop, emitted at the very end of this function, and it is deliberately
  // NOT part of the network.
  //
  // The first version pinned each door node to its building's floor instead,
  // which is the intuitive thing and is wrong by a wide margin. `pad.wy` is the
  // max over five footprint samples, so a church or a keep on a slope has a
  // floor metres above the dirt at its own downhill door — measured on the
  // castle at seed 1337, up to 4.62 m on one door and 26.4 m of lift summed
  // over the network's doors. The relaxation then did its job faithfully and
  // propagated all of it, another 44.9 m, until every street in town was being
  // held up to meet the tallest doorstep in it. The result: 9 % of the raw
  // ground under the network is too steep to walk, and 44 % of the built
  // profile came out stepped, 61 of those intervals introduced purely by the
  // pins. A doorstep is a local problem and gets a local answer.
  void padY;   // used by the stoop pass at the end of this function
  for (const s of samples) {
    let capA = -Infinity;
    let capB = -Infinity;
    for (let i = 0; i <= s.n; i++) {
      const sa = i * s.ds;
      const sb = (s.n - i) * s.ds;
      const ca = s.g[i] - MAX_GRADE * sa;
      const cb = s.g[i] - MAX_GRADE * sb;
      if (ca > capA) capA = ca;
      if (cb > capB) capB = cb;
    }
    if (capA > nodeY[s.a]) nodeY[s.a] = capA;
    if (capB > nodeY[s.b]) nodeY[s.b] = capB;
  }
  for (let i = 0; i < nodeY.length; i++) {
    if (!Number.isFinite(nodeY[i])) nodeY[i] = 0;
  }

  // Nodes must also be consistent with EACH OTHER, not only with the ground
  // under their own street.
  //
  // Without this the pass above is per-edge and blind: a doorway pinned to a
  // high sill and its elbow two metres away pinned to the dirt are each
  // individually fine, and the profile between them then has to make up the
  // whole difference over one short run. The first measurement of this found
  // flights at grade 5.4 — a 79° ladder — and single risers of 2.2 m, on
  // exactly those short elbow and T-junction segments that splitting produces.
  //
  // The fix is a Bellman-Ford relaxation: every node is raised until it is
  // within MAX_GRADE * length of each of its neighbours. Only raising happens,
  // and every constraint in this system is a lower bound, so it is monotone and
  // settles in at most |V| passes — usually two. What it means physically is
  // that a doorstep too high for its own approach lifts the ground in front of
  // it instead, which is what a mason does: you do not cut a ladder, you bring
  // the terrace up to meet the door.
  const edgeLen = samples.map((s) => s.n * s.ds);
  for (let pass = 0; pass <= plan.nodes.length; pass++) {
    let moved = false;
    for (let k = 0; k < samples.length; k++) {
      const cap = MAX_GRADE * edgeLen[k];
      const { a, b } = samples[k];
      if (nodeY[a] < nodeY[b] - cap) { nodeY[a] = nodeY[b] - cap; moved = true; }
      if (nodeY[b] < nodeY[a] - cap) { nodeY[b] = nodeY[a] - cap; moved = true; }
    }
    if (!moved) break;
  }

  // --- C + D: profile and cut ----------------------------------------------
  const tiles: PathTile[] = [];
  const stats: PathStats = {
    lengthM: 0, treads: 0, maxRunGrade: 0, maxFlightGrade: 0,
    overSteep: 0, maxLift: 0, maxRiser: 0, maxDoorStep: 0,
  };

  for (const s of samples) {
    const { n, ds } = s;
    const y = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) y[i] = s.g[i];
    y[0] = nodeY[s.a];
    y[n] = nodeY[s.b];
    const cap = MAX_GRADE * ds;
    // Two sweeps: forward bounds the descent, backward bounds the ascent.
    // Both only ever raise, so the result is the lowest feasible surface.
    for (let i = 1; i < n; i++) if (y[i] < y[i - 1] - cap) y[i] = y[i - 1] - cap;
    for (let i = n - 1; i >= 1; i--) if (y[i] < y[i + 1] - cap) y[i] = y[i + 1] - cap;

    stats.lengthM += n * ds;
    const ux = (s.bx - s.ax) / (n * ds);
    const uz = (s.bz - s.az) / (n * ds);
    const hw = s.halfW;

    // Which intervals need steps, and where the resulting flights start and
    // stop. Classified up front so consecutive steep intervals become ONE
    // flight: cut interval by interval instead, and a bank three stations deep
    // came out as three separate flights with three different risers, because
    // each one divided its own drop in isolation. Nobody builds stairs like
    // that, and a merged flight also lands closer to the nominal riser because
    // it has the whole bank's run to divide.
    const steep = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const grade = Math.abs(y[i + 1] - y[i]) / ds;
      if (grade > MAX_GRADE + 1e-6) stats.overSteep++;
      steep[i] = grade > RAMP_GRADE ? 1 : 0;
    }

    for (let i = 0; i < n; i++) {
      const dy = y[i + 1] - y[i];
      const grade = Math.abs(dy) / ds;
      const x0 = s.ax + ux * (i * ds);
      const z0 = s.az + uz * (i * ds);

      // Whether the run travels toward +x/+z. Tiles are stored as normalised
      // rectangles, so on a run heading the other way the entry height belongs
      // to the rectangle's HIGH corner. Getting this backwards tilts every
      // westbound and northbound street the wrong way, which reads as paving
      // that dips into the hill on one half of the town only.
      const forward = (s.axis === 0 ? ux : uz) >= 0;

      /**
       * Emit one rectangle spanning [t0, t1] in interval units from station i.
       *
       * The shoulder heights are re-derived from the stations the tile actually
       * covers rather than from interval i's pair. A merged flight can span
       * several stations, and using the first pair for all of its treads put
       * the ground under the last tread metres out — which showed up as a
       * 4.7 m reported lift and, worse, as tread boxes skirted to the wrong
       * depth at the bottom of every long stair.
       */
      const emit = (t0: number, t1: number, yEnter: number, yExit: number, riser: number): void => {
        const sx = x0 + ux * (t0 * ds);
        const sz = z0 + uz * (t0 * ds);
        const ex = x0 + ux * (t1 * ds);
        const ez = z0 + uz * (t1 * ds);
        const px = s.axis === 0 ? 0 : hw;
        const pz = s.axis === 0 ? hw : 0;
        const k0 = Math.max(0, Math.floor(i + t0));
        const k1 = Math.min(n, Math.ceil(i + t1));
        let gL = s.gl[k0];
        let gR = s.gr[k0];
        let gC = s.gc[k0];
        for (let k = k0 + 1; k <= k1; k++) {
          if (s.gl[k] > gL) gL = s.gl[k];
          if (s.gr[k] > gR) gR = s.gr[k];
          if (s.gc[k] < gC) gC = s.gc[k];   // lowest, not highest
        }
        tiles.push({
          x0: Math.min(sx, ex) - px, z0: Math.min(sz, ez) - pz,
          x1: Math.max(sx, ex) + px, z1: Math.max(sz, ez) + pz,
          yA: forward ? yEnter : yExit,
          yB: forward ? yExit : yEnter,
          gL, gR, gC, axis: s.axis, fwd: forward, land: false, riser,
          // Hashed from the tile's own world position so the sett pattern is
          // stable under rebuild and identical on every machine.
          v: mix32(Math.round(sx * 4), Math.round(sz * 4), i) & 3,
        });
        const lift = Math.max(yEnter, yExit) - Math.min(gL, gR, gC);
        if (lift > stats.maxLift) stats.maxLift = lift;
      };

      if (steep[i] === 0) {
        if (grade > stats.maxRunGrade) stats.maxRunGrade = grade;
        emit(0, 1, y[i], y[i + 1], 0);
        continue;
      }
      // Start of a flight: take the whole consecutive steep stretch at once.
      let j = i;
      while (j + 1 < n && steep[j + 1] === 1) j++;
      const runLen = (j + 1 - i) * ds;
      const total = y[j + 1] - y[i];
      const flightGrade = Math.abs(total) / runLen;
      // Tread count capped by MIN_TREAD, which raises the riser rather than
      // shaving the tread into something narrower than a foot.
      const steps = Math.max(1, Math.min(
        Math.ceil(Math.abs(total) / RISER),
        Math.max(1, Math.floor(runLen / MIN_TREAD))));
      const d = total / steps;
      if (flightGrade > stats.maxFlightGrade) stats.maxFlightGrade = flightGrade;
      if (Math.abs(d) > stats.maxRiser) stats.maxRiser = Math.abs(d);
      // `emit` works in fractions of ONE interval, so the flight's treads are
      // expressed as fractions of the stretch scaled back into interval units.
      const span = j + 1 - i;
      for (let k = 0; k < steps; k++) {
        const lvl = y[i] + d * (k + 1);
        emit((k / steps) * span, ((k + 1) / steps) * span, lvl, lvl, Math.abs(d));
        stats.treads++;
      }
      i = j;
    }
  }

  // Landings. One level square per junction, corner, doorstep and dead end,
  // abutting the runs that stop short of it. This is the piece that fills the
  // unpaved quadrant at every right-angle corner, and the piece that gives the
  // network its terraced reading — a hill town is landings joined by runs.
  for (let i = 0; i < plan.nodes.length; i++) {
    const h = nodeLand[i];
    if (h <= 0.05) continue;
    const x = site.x + plan.nodes[i].x;
    const z = site.z + plan.nodes[i].z;
    tiles.push({
      x0: x - h, z0: z - h, x1: x + h, z1: z + h,
      yA: nodeY[i], yB: nodeY[i],
      gL: nodeGLo[i], gR: nodeGLo[i], gC: nodeGLo[i],
      axis: 0, fwd: true, land: true, riser: 0,
      v: mix32(Math.round(x * 4), Math.round(z * 4), 7) & 3,
    });
    const lift = nodeY[i] - nodeGLo[i];
    if (lift > stats.maxLift) stats.maxLift = lift;
  }

  // Stoops. A short flight from the landing outside each door up to the sill,
  // running straight at the wall along the door's own facing.
  //
  // This is the piece that answers the doorstep cliff without letting it out
  // into the street. It is bounded by MAX_GRADE like everything else, so a
  // building whose floor is further above its doorway than the stoop can climb
  // keeps a residual step at the threshold — reported as `maxDoorStep`, and
  // still traversable because the pad's own skirt platform reaches 0.65 m past
  // the wall. Silent before, visible and mostly walked now.
  for (let i = 0; i < plan.nodes.length; i++) {
    const nd = plan.nodes[i];
    if (nd.kind !== 'door' || nd.pad < 0 || nd.pad >= padY.length) continue;
    if (nodeLand[i] <= 0.05) continue;
    const pad = pads[nd.pad];
    const [fx, fz] = faceOut(pad);
    // How far out the node ACTUALLY ended up. It is not always DOOR_MARGIN:
    // planning pulls a doorway node in toward its wall until it finds clear
    // ground, and using the nominal margin here ran the stoop past the wall and
    // out through the far side of the building.
    const out = (site.x + nd.x - (site.x + pad.x)) * fx +
      (site.z + nd.z - (site.z + pad.z)) * fz - pad.d / 2;
    // Toward the wall is the reverse of the outward facing.
    const run = out - nodeLand[i];
    if (run < MIN_TREAD) continue;
    const sill = padY[nd.pad] + PATH_TOP;
    const y0 = nodeY[i];
    const reach = MAX_GRADE * run;
    const y1 = Math.max(y0 - reach, Math.min(sill, y0 + reach));
    const residual = Math.abs(sill - y1);
    if (residual > stats.maxDoorStep) stats.maxDoorStep = residual;
    const dy = y1 - y0;
    if (Math.abs(dy) < 0.04) continue;
    const steps = Math.max(1, Math.min(
      Math.ceil(Math.abs(dy) / RISER), Math.max(1, Math.floor(run / MIN_TREAD))));
    const d = dy / steps;
    const tread = run / steps;
    // Start at the landing's edge; walk in toward the wall.
    const sx = site.x + nd.x - fx * nodeLand[i];
    const sz = site.z + nd.z - fz * nodeLand[i];
    const alongX = Math.abs(fx) > 0.5;
    const hw = HALF_SPUR;
    for (let k = 0; k < steps; k++) {
      const a0 = k * tread;
      const a1 = (k + 1) * tread;
      const cx0 = sx - fx * a0, cz0 = sz - fz * a0;
      const cx1 = sx - fx * a1, cz1 = sz - fz * a1;
      const gx = heightAt((cx0 + cx1) / 2, (cz0 + cz1) / 2);
      const lvl = y0 + d * (k + 1);
      // A tread inside somebody else's collider is a step you can see and never
      // stand on, because a blocker is an infinite prism. Rare — it takes a prop
      // pushed right up against a neighbour's doorway — but it is exactly the
      // kind of thing that looks fine and walks wrong.
      let fouled = false;
      for (let pi = 0; pi < pads.length && !fouled; pi++) {
        if (pi === nd.pad || PASSABLE.has(pads[pi].type)) continue;
        const o = padHalfExtents(pads[pi]);
        const ox = site.x + pads[pi].x;
        const oz = site.z + pads[pi].z;
        fouled = Math.min(cx0, cx1) - RADIUS < ox + o.hx &&
          Math.max(cx0, cx1) + RADIUS > ox - o.hx &&
          Math.min(cz0, cz1) - RADIUS < oz + o.hz &&
          Math.max(cz0, cz1) + RADIUS > oz - o.hz;
      }
      if (fouled) continue;
      tiles.push({
        x0: Math.min(cx0, cx1) - (alongX ? 0 : hw),
        z0: Math.min(cz0, cz1) - (alongX ? hw : 0),
        x1: Math.max(cx0, cx1) + (alongX ? 0 : hw),
        z1: Math.max(cz0, cz1) + (alongX ? hw : 0),
        yA: lvl, yB: lvl, gL: gx, gR: gx, gC: gx,
        axis: alongX ? 0 : 1,
        // The leading edge is the one the climb arrives from, which is the far
        // side of the tile when the door faces -x/-z.
        fwd: alongX ? fx < 0 : fz < 0,
        land: false, riser: Math.abs(d),
        v: mix32(Math.round(cx0 * 4), Math.round(cz0 * 4), 11) & 3,
      });
      stats.treads++;
      if (Math.abs(d) > stats.maxRiser) stats.maxRiser = Math.abs(d);
    }
  }

  const nodes: ResolvedPathNode[] = plan.nodes.map((nd, i) => ({
    x: site.x + nd.x, z: site.z + nd.z, y: nodeY[i], kind: nd.kind, pad: nd.pad,
  }));
  const links: [number, number][] = samples.map((s) => [s.a, s.b]);
  return { tiles, nodes, links, stats };
}

/** Convenience wrapper: plan and resolve in one call. */
export function buildSettlementPaths(
  site: SettlementSite,
  pads: readonly BuildingPad[],
  padY: readonly number[],
  heightAt: (x: number, z: number) => number,
): ResolvedPaths {
  return resolveSettlementPaths(
    site, pads, padY, planSettlementPaths(site.kind, pads), heightAt);
}

// --- mesh --------------------------------------------------------------------

/** Crown height at the middle of a run (m) — a street that sheds water. */
const CAMBER = 0.035;
/** Fraction of the half-width taken by each verge strip. */
const VERGE = 0.3;
/**
 * Spur surfaces are drawn this far below their true height (m).
 *
 * A spur meets a street at a T, and because both rectangles are centred on
 * their own centrelines the spur's last tile lies UNDER the street for its
 * final ~1.7 m. Two coplanar surfaces at identical depth flicker. Sinking the
 * narrower one by a centimetre hides it cleanly and costs nothing — and it is
 * applied to the drawn geometry only, never to the profile or the colliders,
 * so the surface the player stands on is still the one the street agreed on.
 */
const SPUR_SINK = 0.012;
/** Below this width a tile is a spur rather than a street. */
const SPUR_WIDTH = 2.2;

/**
 * Paving, kerbs and steps for a resolved network, into the palette buckets.
 *
 * World space already, so this appends straight into `buckets` rather than
 * going through `appendYaw` the way pads do — there is no pad-local frame for
 * a street. Everything lands in palettes the settlement already draws, so a
 * whole network of stairs costs zero new draw calls, no new vertex layout and
 * no new shadow pipeline.
 *
 * Materials are the craft vocabulary rather than asphalt: STONE setts with
 * TIMBER (dark, earthy) verges alternating by tile, TIMBER risers holding back
 * STONE treads — the plank-and-earth stair every hill village actually has.
 */
export function buildPathMeshes(
  paths: ResolvedPaths,
  stone: number[],
  timber: number[],
): void {
  for (const t of paths.tiles) {
    const alongX = t.axis === 0;
    const halfW = (alongX ? t.z1 - t.z0 : t.x1 - t.x0) / 2;
    const sink = halfW * 2 < SPUR_WIDTH ? SPUR_SINK : 0;
    // Two-tone setts: the crown and the verges swap material every other tile.
    const crown = (t.v & 1) === 0 ? stone : timber;
    const verge = (t.v & 1) === 0 ? timber : stone;

    if (t.riser > 0) {
      // A tread. One box carries the tread top, all four side faces and the
      // skirt down to the dirt in a single primitive with guaranteed winding —
      // on a hillside the box's own depth is what stops a flight floating.
      const lvl = t.yA - sink;
      const bottom = Math.min(t.gL, t.gR, lvl - t.riser) - 0.15;
      boxSolid(stone, t.x0, bottom, t.z0, t.x1, lvl, t.z1);
      // A timber nosing board proud of the riser face — the plank holding the
      // step in, and what makes a flight legible from across a valley. Stood
      // 2 cm off the face rather than flush so it cannot z-fight the box.
      const off = 0.02;
      const yb = lvl - Math.max(t.riser, 0.12);
      if (alongX) {
        const fx = t.fwd ? t.x0 - off : t.x1 + off;
        quadFace(timber, fx, yb, t.z0, fx, lvl, t.z1, t.fwd ? -1 : 1, 0);
      } else {
        const fz = t.fwd ? t.z0 - off : t.z1 + off;
        quadFace(timber, t.x0, yb, fz, t.x1, lvl, fz, 0, t.fwd ? -1 : 1);
      }
      continue;
    }

    if (t.land) {
      // A junction landing: flat, uncrowned (a camber across a square reads as
      // a dent), and walled on every side that stands proud of the hill. The
      // walls on sides where a street joins end up hidden below its paving,
      // which is right — the revetment carries on under the road.
      const y = t.yA - sink;
      topStrip(crown, t.x0, t.x1, t.z0, t.z1, 0, y, y, 0);
      if (y - t.gL > KERB_MIN) {
        const b = t.gL - 0.3;
        quadFace(stone, t.x0, b, t.z0, t.x1, y, t.z0, 0, -1);
        quadFace(stone, t.x0, b, t.z1, t.x1, y, t.z1, 0, 1);
        quadFace(stone, t.x0, b, t.z0, t.x0, y, t.z1, -1, 0);
        quadFace(stone, t.x1, b, t.z0, t.x1, y, t.z1, 1, 0);
      }
      continue;
    }

    // A graded run: three strips across the width, crowned down the middle.
    const yA = t.yA - sink;
    const yB = t.yB - sink;
    const inset = halfW * 2 * VERGE;
    if (alongX) {
      const zi0 = t.z0 + inset;
      const zi1 = t.z1 - inset;
      topStrip(verge, t.x0, t.x1, t.z0, zi0, 0, yA, yB, 0);
      topStrip(crown, t.x0, t.x1, zi0, zi1, 0, yA, yB, CAMBER);
      topStrip(verge, t.x0, t.x1, zi1, t.z1, 0, yA, yB, 0);
      // Retaining faces, only on the side actually cut into.
      if (Math.min(yA, yB) - t.gL > KERB_MIN) {
        quadFace(stone, t.x0, t.gL - 0.3, t.z0, t.x1, yA, t.z0, 0, -1, yB);
      }
      if (Math.min(yA, yB) - t.gR > KERB_MIN) {
        quadFace(stone, t.x0, t.gR - 0.3, t.z1, t.x1, yA, t.z1, 0, 1, yB);
      }
    } else {
      const xi0 = t.x0 + inset;
      const xi1 = t.x1 - inset;
      topStrip(verge, t.x0, xi0, t.z0, t.z1, 1, yA, yB, 0);
      topStrip(crown, xi0, xi1, t.z0, t.z1, 1, yA, yB, CAMBER);
      topStrip(verge, xi1, t.x1, t.z0, t.z1, 1, yA, yB, 0);
      if (Math.min(yA, yB) - t.gL > KERB_MIN) {
        quadFace(stone, t.x0, t.gL - 0.3, t.z0, t.x0, yA, t.z1, -1, 0, yB);
      }
      if (Math.min(yA, yB) - t.gR > KERB_MIN) {
        quadFace(stone, t.x1, t.gR - 0.3, t.z0, t.x1, yA, t.z1, 1, 0, yB);
      }
    }
  }
}

/**
 * One paving strip: an up-facing quad over [x0,x1] x [z0,z1] whose height runs
 * from `yA` to `yB` along `axis` (0 = x, 1 = z) and is raised by `lift`.
 *
 * The axis is passed in rather than inferred from which span is longer: a tile
 * on a wide street is often wider than it is long, and inferring would tilt
 * those sideways.
 *
 * Wound to the same convention as `mesh-utils.box`'s +Y face — (x0,z1) →
 * (x1,z1) → (x1,z0) → (x0,z0) — so the right-hand normal points up.
 */
function topStrip(
  verts: number[], x0: number, x1: number, z0: number, z1: number,
  axis: 0 | 1, yA: number, yB: number, lift: number,
): void {
  const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
  const az = Math.min(z0, z1), bz = Math.max(z0, z1);
  const lo = yA + lift;
  const hi = yB + lift;
  // Height depends only on the run axis, so the two corners on the low side of
  // that axis share `lo` and the two on the high side share `hi`.
  const c00 = lo;                    // (ax, az)
  const c10 = axis === 0 ? hi : lo;  // (bx, az)
  const c11 = hi;                    // (bx, bz)
  const c01 = axis === 0 ? lo : hi;  // (ax, bz)
  quadRaw(verts, ax, c01, bz, bx, c11, bz, bx, c10, az, ax, c00, az);
}

/**
 * A vertical face on one side of a tile, from `yBot` up to the surface.
 * `(nx, nz)` is the outward direction; `yEnd` lets the top edge follow a graded
 * run rather than sitting level. Windings match the corresponding faces of
 * `mesh-utils.box`.
 */
function quadFace(
  verts: number[], x0: number, yBot: number, z0: number,
  x1: number, yTop: number, z1: number,
  nx: number, nz: number, yEnd = yTop,
): void {
  const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
  const az = Math.min(z0, z1), bz = Math.max(z0, z1);
  if (nz < 0) {
    quadRaw(verts, bx, yBot, az, ax, yBot, az, ax, yTop, az, bx, yEnd, az);
  } else if (nz > 0) {
    quadRaw(verts, ax, yBot, bz, bx, yBot, bz, bx, yEnd, bz, ax, yTop, bz);
  } else if (nx < 0) {
    quadRaw(verts, ax, yBot, az, ax, yBot, bz, ax, yEnd, bz, ax, yTop, az);
  } else {
    quadRaw(verts, bx, yBot, bz, bx, yBot, az, bx, yTop, az, bx, yEnd, bz);
  }
}

/** A solid box with all six faces outward — the tread primitive. */
function boxSolid(
  verts: number[], x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
): void {
  const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
  const ay = Math.min(y0, y1), by = Math.max(y0, y1);
  const az = Math.min(z0, z1), bz = Math.max(z0, z1);
  quadRaw(verts, ax, ay, az, ax, ay, bz, ax, by, bz, ax, by, az);   // -X
  quadRaw(verts, bx, ay, bz, bx, ay, az, bx, by, az, bx, by, bz);   // +X
  quadRaw(verts, bx, ay, az, ax, ay, az, ax, by, az, bx, by, az);   // -Z
  quadRaw(verts, ax, ay, bz, bx, ay, bz, bx, by, bz, ax, by, bz);   // +Z
  quadRaw(verts, ax, by, bz, bx, by, bz, bx, by, az, ax, by, az);   // +Y
  quadRaw(verts, ax, ay, az, bx, ay, az, bx, ay, bz, ax, ay, bz);   // -Y
}

/**
 * `mesh-utils.quad` without the P3 tuple allocations.
 *
 * A castle's path network is several thousand quads, and the tuple form
 * allocates four arrays per quad purely to be read once. Same winding rule and
 * same flat face normal — the right-hand normal (b-a)x(c-a) must point OUTWARD
 * or back-face culling turns the face into an invisible hole.
 */
function quadRaw(
  verts: number[],
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
): void {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len > 1e-12) { nx /= len; ny /= len; nz /= len; } else { nx = 0; ny = 1; nz = 0; }
  verts.push(
    ax, ay, az, nx, ny, nz,
    bx, by, bz, nx, ny, nz,
    cx, cy, cz, nx, ny, nz,
    ax, ay, az, nx, ny, nz,
    cx, cy, cz, nx, ny, nz,
    dx, dy, dz, nx, ny, nz,
  );
}

// --- collision ---------------------------------------------------------------

/**
 * Collision boxes for a path network, appended to the settlement's own.
 *
 * Treads and raised terraces become `platforms`, never `blockers` — see the
 * header: a blocker is an infinite prism and a staircase built from them is a
 * wall. Retaining faces tall enough to be walls get a blocker in the sliver
 * OUTSIDE the walkable rectangle, so the pushout radius eats the hillside
 * rather than the street.
 */
export function pathSolids(
  paths: ResolvedPaths,
  platforms: { x0: number; z0: number; x1: number; z1: number; top: number }[],
  blockers: { x0: number; z0: number; x1: number; z1: number; top: number }[],
): void {
  const walls: { x0: number; z0: number; x1: number; z1: number; top: number }[] = [];
  for (const t of paths.tiles) {
    const top = Math.max(t.yA, t.yB);
    const ground = Math.min(t.gL, t.gR, t.gC);
    const lift = top - ground;
    if (t.riser > 0 || lift > FOLLOW_TOL) {
      if (t.riser > 0) {
        // A tread's collider is narrowed across the run.
        //
        // Platforms have no sides — `groundHeight` is a plain Math.max over
        // every box whose rect (inflated by the 0.35 m capsule radius) contains
        // you. So the side of a staircase is a lift: brush the top tread of a
        // flight from the hillside beside it and you are placed on top of the
        // whole flight in one tick. Measured at 1.76 m on a village stair,
        // against 0.57 m for the same walk over bare terrain. Insetting means
        // you have to be genuinely ON the stair, not merely alongside it.
        const in0 = t.axis === 0 ? 0 : TREAD_INSET;
        const in1 = t.axis === 0 ? TREAD_INSET : 0;
        platforms.push({
          x0: t.x0 + in0, z0: t.z0 + in1,
          x1: t.x1 - in0, z1: t.z1 - in1, top,
        });
      } else if (Math.abs(t.yA - t.yB) < 0.02) {
        platforms.push({ x0: t.x0, z0: t.z0, x1: t.x1, z1: t.z1, top });
      } else {
        // A lifted graded tile: subdivide so the flat-topped boxes do not
        // stair-case a slope the player should walk smoothly.
        const parts = Math.max(1, Math.min(4, Math.ceil(Math.abs(t.yA - t.yB) / 0.15)));
        const along = t.axis === 0 ? t.x1 - t.x0 : t.z1 - t.z0;
        for (let k = 0; k < parts; k++) {
          const f0 = k / parts;
          const f1 = (k + 1) / parts;
          const yk = t.yA + (t.yB - t.yA) * ((f0 + f1) / 2);
          platforms.push(t.axis === 0
            ? { x0: t.x0 + along * f0, z0: t.z0, x1: t.x0 + along * f1, z1: t.z1, top: yk }
            : { x0: t.x0, z0: t.z0 + along * f0, x1: t.x1, z1: t.z0 + along * f1, top: yk });
        }
      }
    }
    // Retaining walls, on whichever shoulder is actually cut into.
    //
    // Runs only, never landings. A run's two long sides are open hillside by
    // construction — the streets that continue attach at its ENDS. A landing is
    // the opposite: every one of its four sides may be where a street joins, so
    // walling it walls the junction shut, and the castle's approach street was
    // the first thing it sealed off.
    if (t.land) continue;
    if (t.axis === 0) {
      if (top - t.gL >= RETAIN_BLOCK_H) {
        walls.push({ x0: t.x0, z0: t.z0 - 0.18, x1: t.x1, z1: t.z0, top });
      }
      if (top - t.gR >= RETAIN_BLOCK_H) {
        walls.push({ x0: t.x0, z0: t.z1, x1: t.x1, z1: t.z1 + 0.18, top });
      }
    } else {
      if (top - t.gL >= RETAIN_BLOCK_H) {
        walls.push({ x0: t.x0 - 0.18, z0: t.z0, x1: t.x0, z1: t.z1, top });
      }
      if (top - t.gR >= RETAIN_BLOCK_H) {
        walls.push({ x0: t.x1, z0: t.z0, x1: t.x1 + 0.18, z1: t.z1, top });
      }
    }
  }
  // Drop any wall standing where the network itself is walkable.
  //
  // A retaining wall is emitted 0.18 m off a run's shoulder, and a street
  // crossing that run perpendicular puts its own treads in exactly that strip.
  // Because a blocker is an infinite prism, the result is a staircase you can
  // see, stand on, and never enter — the walk test found 8 of them. The wall is
  // the thing that gives way: it is scenery, the stair is circulation.
  const kept: typeof walls = [];
  for (const w of walls) {
    let onPath = false;
    for (const t of paths.tiles) {
      // Rect against rect, inflated by the capsule radius. Testing the tile's
      // CENTRE instead misses a wall clipping the end of a long tread, which
      // still walls the stair off — the capsule is 0.7 m wide and is ejected
      // from anything it touches, not from things it is centred on.
      if (t.x1 + RADIUS > w.x0 && t.x0 - RADIUS < w.x1 &&
          t.z1 + RADIUS > w.z0 && t.z0 - RADIUS < w.z1) { onPath = true; break; }
    }
    if (!onPath) kept.push(w);
  }
  mergeWalls(kept, blockers);
}

/**
 * Fuse the per-tile retaining walls into runs before handing them to collision.
 *
 * Every tile along a terraced street emits its own 1.4 m sliver, so a 30 m
 * revetment arrives as twenty-odd separate boxes. That is not only twenty times
 * the work in the linear scan `settlementGround.near()` does per probe — it is
 * twenty INDEPENDENT pushouts in `slideXZ`, each snapping the player to its own
 * near face with no knowledge of the others, which is how you get a capsule
 * bounced along a wall instead of sliding down it. One long box slides cleanly.
 *
 * `top` is merged as the max purely for tidiness: `slideXZ` never reads it.
 */
function mergeWalls(
  walls: { x0: number; z0: number; x1: number; z1: number; top: number }[],
  out: { x0: number; z0: number; x1: number; z1: number; top: number }[],
): void {
  const used = new Array<boolean>(walls.length).fill(false);
  for (let i = 0; i < walls.length; i++) {
    if (used[i]) continue;
    const w = { ...walls[i] };
    used[i] = true;
    // Repeat until a pass adds nothing: a wall can grow at either end, and a
    // neighbour that did not touch it before may touch it after it grows.
    for (let grew = true; grew;) {
      grew = false;
      for (let j = i + 1; j < walls.length; j++) {
        if (used[j]) continue;
        const o = walls[j];
        // Same band, and the spans meet or overlap (0.05 m of slack for the
        // float error in stepping along a run).
        const sameZ = Math.abs(o.z0 - w.z0) < 0.02 && Math.abs(o.z1 - w.z1) < 0.02;
        const sameX = Math.abs(o.x0 - w.x0) < 0.02 && Math.abs(o.x1 - w.x1) < 0.02;
        if (sameZ && o.x0 <= w.x1 + 0.05 && o.x1 >= w.x0 - 0.05) {
          w.x0 = Math.min(w.x0, o.x0);
          w.x1 = Math.max(w.x1, o.x1);
        } else if (sameX && o.z0 <= w.z1 + 0.05 && o.z1 >= w.z0 - 0.05) {
          w.z0 = Math.min(w.z0, o.z0);
          w.z1 = Math.max(w.z1, o.z1);
        } else {
          continue;
        }
        w.top = Math.max(w.top, o.top);
        used[j] = true;
        grew = true;
      }
    }
    out.push(w);
  }
}
