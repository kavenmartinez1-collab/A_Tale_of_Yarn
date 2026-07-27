/**
 * Road network — stone paths that ALWAYS lead to a castle.
 *
 * ## The promise
 *
 * A road is a promise: stand on any stone path anywhere in the world, pick a
 * direction, and you arrive at a castle. Forks are the point — a fork is a
 * decision — but every branch of every fork must itself reach a castle, and no
 * branch may end in open ground.
 *
 * That is not verified after the fact; it is **true by construction**. Roads
 * are a **shortest-path tree rooted at a castle**:
 *
 *   - Each castle owns a *domain*: the non-castle settlements within
 *     DOMAIN_RADIUS whose nearest castle is that one (a Voronoi partition, so
 *     every settlement belongs to exactly one domain).
 *   - One Dijkstra sweep runs outward from the castle gate over a traversal-
 *     cost grid (slope, water, rivers, other settlements' footprints). It
 *     yields a parent pointer for every reachable cell — a spanning tree of the
 *     walkable landscape, rooted at the castle.
 *   - A settlement's road is simply its cell's parent chain. Every road cell
 *     therefore has a parent chain to the castle: **that is the promise**, and
 *     it is a property of the sweep, not of any check I could forget to run.
 *   - Because the chains are prefixes of one tree, roads to different
 *     settlements *merge* where their routes agree. That merge point is a
 *     genuine Y-fork in open wilderness, and it lands where the terrain makes
 *     two journeys share a valley — which is where real roads fork.
 *   - A settlement the sweep cannot reach (across open water, say) simply gets
 *     no road. Nothing is half-built, so nothing can dangle.
 *   - Where two castles are close enough to share one sweep they are linked
 *     directly, lower key first so the pair is only ever built once. Both ends
 *     of such a road are castles, so the promise holds in either direction.
 *
 * Consequences, asserted directly by `scripts/test-roads.mts`: every connected
 * component contains a castle; every degree-1 terminus is a settlement or a
 * castle, never a bare road end; and a rootward walk from any road point
 * reaches a castle in bounded steps.
 *
 * ## Determinism under streaming
 *
 * The world is infinite and streams in chunks, so "which road passes through
 * this cell" must be a pure function of (seed, position) that never depends on
 * what is loaded or on which direction the player approached from.
 *
 *   - A domain is a pure function of its castle alone. The castle comes from a
 *     bounded scan of `settlementSiteAt` cells; membership is decided by
 *     `ownerOf(settlement)`, itself a bounded scan centred on the *settlement*,
 *     so a settlement's owner is a property of the settlement rather than of
 *     whoever asked.
 *   - The Dijkstra grid is world-aligned and its box is derived from the castle
 *     position, so the same castle always produces the same tree.
 *   - Queries go through a coverage grid of RCELL-sized cells. Resolving a cell
 *     builds *every* domain whose geometry could reach it, so the answer at a
 *     point is the same however you got there. Cells and domains are caches of
 *     a pure function: evicting them changes nothing.
 *
 * Nothing here reads the *carved* height field (see `carveRoads`), only the
 * base one — otherwise settlement placement would depend on roads which depend
 * on settlement placement, and the recursion would never bottom out.
 *
 * ## Perf
 *
 * `sampleAt` runs ~8,700 times per terrain chunk plus once per collision probe,
 * so the reject path is one coverage-cell lookup (memoised to two integer
 * compares while a scan stays inside one 256 m cell) and one compare against a
 * segment count. Only cells that actually carry road — well under 1% of the
 * world — walk a short flat Float32Array. No allocation on any query path.
 * Building a domain is the expensive part and happens once per castle.
 */

import { mix32 } from '../dungeon/dungeon-layout';
import { mulberry32 } from '../mesh-utils';
import { SEA_LEVEL, type HeightField } from '../noise';
import {
  SCELL, SETTLEMENT_RADIUS, settlementSiteAt,
  type SettlementKind, type SettlementSite,
} from '../settlement/settlement-scatter';
import { castleGateLocal } from '../settlement/settlement-plans';

// --- tuning ----------------------------------------------------------------

const SALT = 0x20adbeef;

/** Half-width of the paved surface (m). Trunk roads are wider than spurs. */
export const HALF_LOCAL = 2.0;
export const HALF_TRUNK = 3.0;
/** Carried traffic (descendant settlements) at which a road counts as trunk. */
const TRUNK_TRAFFIC = 2;

/** Surface mask is full this far inside the paved edge… */
const MASK_CORE = 0.7;
/** …and fades to nothing this far outside it. */
const MASK_FEATHER = 1.5;

/** Cut/fill blends back into open ground over this distance (m). */
const CARVE_BLEND = 8.0;
/** Hard cap on how far the ground may be moved (m), up or down. */
const CARVE_MAX = 2.5;

/** How far one segment's influence can reach — the spatial index margin. */
const SEG_REACH = HALF_TRUNK + CARVE_BLEND + 0.5;

/** A castle claims settlements within this radius (m). */
const DOMAIN_RADIUS = 2000;
/** Grid box margin beyond DOMAIN_RADIUS, so routes may bow outwards. */
const GRID_PAD = 190;
/** Dijkstra cell size (m). Coarse: the path is smoothed and resampled after. */
const GRID = 36;

/**
 * Castles whose roads could touch a query point: the domain half-box diagonal.
 * Anything further away cannot have put geometry here.
 */
const CASTLE_REACH = (DOMAIN_RADIUS + GRID_PAD) * 1.45;

/**
 * Coverage/index cell edge (m). Smaller cells mean fewer segments to walk per
 * query, which is what the hot path pays for; the extra cells are cheap.
 */
const RCELL = 128;
const INV_RCELL = 1 / RCELL;

/** Polyline vertex spacing after resampling (m). */
const RESAMPLE = 5;
/**
 * Douglas–Peucker tolerance (m) applied after profiling. Straight runs collapse
 * to one long segment, so a road-bearing coverage cell holds a handful of
 * segments instead of RCELL/RESAMPLE of them — a ~4x cut in the hot loop, for a
 * deviation far below the width of the road itself.
 */
const SIMPLIFY_TOL = 0.3;
/** Chaikin passes that round the grid staircase into a road. */
const SMOOTH_PASSES = 4;

/** Ground below this cannot carry a road at all. */
const IMPASSABLE_DEPTH = SEA_LEVEL - 1.4;
/** Between here and IMPASSABLE_DEPTH a road is a costly ford/causeway. */
const FORD_LEVEL = SEA_LEVEL + 0.6;
const FORD_COST = 14;
/** Slope cost weight: cost = 1 + slope·this (slope in metres per metre). */
const SLOPE_COST = 26;
/** Rivers are crossable but they cost a bridge. */
const RIVER_COST = 5;

/**
 * How far outside a castle's footprint its roads converge. The castle's own
 * approach street carries the last stretch in to the gate, so the network hands
 * over at the town's outer edge rather than driving through the market.
 */
const PORT_STANDOFF = 6;

/** Cache ceilings. All are caches of a pure function; eviction is harmless. */
const MAX_SITE_CACHE = 40000;
const MAX_DOMAIN_CACHE = 24;
const MAX_RCELL_CACHE = 3000;

// --- small helpers ---------------------------------------------------------

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Pack cell coords into one exact-double key. |c| < 2^20 ⇒ ±1,048,576 cells,
 * which at SCELL = 512 m is ±536,000 km — past any world anyone will walk.
 */
function cellKey(cx: number, cz: number): number {
  return (cx + 0x100000) * 0x200000 + (cz + 0x100000);
}

/**
 * How far short of a settlement's centre a road stops. Never closer than the
 * flatness ring `settlementSiteAt` samples at 0.7·radius, plus the carve reach
 * — so a road can never move the ground under the test that placed the
 * settlement it leads to. See `carveRoads` for why that matters.
 */
function endGap(kind: SettlementKind): number {
  const r = SETTLEMENT_RADIUS[kind];
  return Math.max(r + 2, r * 0.7 + SEG_REACH + 2);
}

// --- public shapes ---------------------------------------------------------

export type RoadNodeKind = 'castle' | 'settlement' | 'junction';

/** One node of the road graph. `parentId` is the step toward the castle. */
export interface RoadNode {
  id: string;
  kind: RoadNodeKind;
  settlementKind: SettlementKind | null;
  x: number;
  z: number;
  y: number;
  /**
   * The next node castle-ward, or null at the root (which IS a castle).
   * Following this chain is what "walking a road home" means, and it is
   * guaranteed to terminate at a castle — see the header.
   */
  parentId: string | null;
  halfWidth: number;
}

/** A drawable, walkable stretch of road between two graph nodes. */
export interface RoadEdge {
  a: string;
  b: string;
  /** x,z,y triples, ordered a → b. */
  pts: Float32Array;
  halfWidth: number;
  /**
   * Whether this stretch reshapes the ground. False only for the gate stub,
   * which runs inside the castle's own footprint: it must be *paved* right up
   * to the arch but must not move the ground there, because that is where
   * `settlementSiteAt` takes the flatness sample that placed the castle. Paint
   * without cut-and-fill is exactly the right tool for that 20 m.
   */
  carve: boolean;
}

export interface RoadGraph {
  nodes: RoadNode[];
  edges: RoadEdge[];
}

export interface RoadOptions {
  /**
   * NEGATIVE CONTROL ONLY. Roots the sweep at an arbitrary settlement instead
   * of the castle, i.e. removes the outward-growth property.
   * `scripts/test-roads.mts` asserts the connectivity suite FAILS under this
   * flag — a test that cannot fail proves nothing.
   */
  rootless?: boolean;
  /** NEGATIVE CONTROL ONLY. Adds spurs that stop in open ground. */
  danglingEnds?: boolean;
}

export interface RoadNetwork {
  readonly seed: number;
  /**
   * Combined query, one segment walk for both answers. Returns the height delta
   * to ADD to `baseH`, and writes the paved-surface mask (0..1) to `out[o]`.
   */
  sampleAt(x: number, z: number, baseH: number, out: Float32Array, o: number): number;
  /** Paved-surface weight at (x, z): 1 = road centre, 0 = open ground. */
  maskAt(x: number, z: number): number;
  /** Height delta to add to the base terrain height at (x, z). */
  carveAt(x: number, z: number, baseH: number): number;
  /** Pre-resolve coverage for a world-space AABB (chunk streaming warm-up). */
  ensureArea(x0: number, z0: number, x1: number, z1: number): void;
  /** The graph over an AABB — for tests, debug draws and `nearestRoad`. */
  graphIn(x0: number, z0: number, x1: number, z1: number): RoadGraph;
  /** Nearest paved point within `maxR`, or null. */
  nearestRoad(x: number, z: number, maxR?: number): { x: number; z: number; d: number } | null;
  /** Cache occupancy, for the perf harness. */
  stats(): { domains: number; cells: number; sites: number; segments: number };
}

// --- internals -------------------------------------------------------------

interface WorkNode {
  id: string;
  kind: RoadNodeKind;
  settlementKind: SettlementKind | null;
  x: number;
  z: number;
  y: number;
  parent: number;
  halfWidth: number;
}

/** A tree edge, still in grid-cell form while the tree is being assembled. */
interface WorkEdge {
  child: number;
  parent: number;
  /** Grid cell indices, ordered child → parent. */
  cells: number[];
  /** Settlements served through this edge — decides trunk vs spur width. */
  traffic: number;
}

interface Domain {
  key: number;
  nodes: WorkNode[];
  edges: RoadEdge[];
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** Coverage-cell segment: x0,z0,y0,dx,dz,dy,invLen2,halfWidth,carve. */
const SEG_STRIDE = 9;

interface RCell {
  segs: Float32Array;
  count: number;
}

const EMPTY_CELL: RCell = { segs: new Float32Array(0), count: 0 };

/**
 * One road network per seed, shared by everybody who asks.
 *
 * A `RoadNetwork` is a pure function of (seed, base field) wrapped around three
 * caches, and the expensive part — a Dijkstra sweep per castle over a
 * ~120x120 grid of `heightAt` samples — is paid on first touch. Two instances
 * of the same seed therefore produce identical answers and pay for them twice,
 * which is exactly what happened when road travellers needed the graph: the
 * chunk manager already had a network built and warm, and the only reason to
 * build a second one was that nothing exposed the first.
 *
 * Keyed on the seed alone. The base field is only consulted when there is
 * nothing cached, so whichever caller arrives first supplies it; any two base
 * fields for the same seed are equivalent by construction (`createHeightField`
 * is pure), so the answer does not depend on who won that race.
 *
 * Never hand this a *carved* field. See `carveRoads` for why the definition
 * would become circular.
 */
const sharedNetworks = new Map<number, RoadNetwork>();

export function sharedRoadNetwork(seed: number, base: HeightField): RoadNetwork {
  let net = sharedNetworks.get(seed);
  if (net === undefined) {
    net = createRoadNetwork(seed, base);
    sharedNetworks.set(seed, net);
  }
  return net;
}

export function createRoadNetwork(
  seed: number,
  base: HeightField,
  opts: RoadOptions = {},
): RoadNetwork {
  const rootless = opts.rootless === true;
  const danglingEnds = opts.danglingEnds === true;

  const siteCache = new Map<number, SettlementSite | null>();
  const domainCache = new Map<number, Domain>();
  const cellCache = new Map<number, RCell>();

  // Single-entry memo for coverage lookup. A chunk scan walks whole rows inside
  // one 256 m cell, collapsing ~256 consecutive Map lookups to two compares.
  let memoIcx = Number.NaN;
  let memoIcz = Number.NaN;
  let memoCell: RCell = EMPTY_CELL;

  // Probe scratch. Module-level rather than a returned object, because these
  // are the hottest calls in terrain generation.
  let probeD2 = Infinity;
  let probeY = 0;
  let probeHw = 0;
  let probeCarve = 0;

  // --- settlement queries (bounded, memoised, BASE height only) ------------

  function siteAt(scx: number, scz: number): SettlementSite | null {
    const k = cellKey(scx, scz);
    const hit = siteCache.get(k);
    if (hit !== undefined) return hit;
    const s = settlementSiteAt(seed, scx, scz, base.heightAt);
    if (siteCache.size >= MAX_SITE_CACHE) siteCache.clear();
    siteCache.set(k, s);
    return s;
  }

  /** Cell key of the settlement cell a site sits in — its global identity. */
  function siteKey(s: SettlementSite): number {
    return cellKey(Math.floor(s.x / SCELL), Math.floor(s.z / SCELL));
  }

  /** Every settlement whose centre lies within `r` of (x, z). */
  function sitesNear(x: number, z: number, r: number): SettlementSite[] {
    const out: SettlementSite[] = [];
    const c0x = Math.floor((x - r) / SCELL);
    const c1x = Math.floor((x + r) / SCELL);
    const c0z = Math.floor((z - r) / SCELL);
    const c1z = Math.floor((z + r) / SCELL);
    const r2 = r * r;
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const s = siteAt(cx, cz);
        if (s === null) continue;
        const dx = s.x - x;
        const dz = s.z - z;
        if (dx * dx + dz * dz <= r2) out.push(s);
      }
    }
    out.sort((p, q) => siteKey(p) - siteKey(q));
    return out;
  }

  function castlesNear(x: number, z: number, r: number): SettlementSite[] {
    return sitesNear(x, z, r).filter((s) => s.kind === 'castle');
  }

  /**
   * The castle that owns `s`, or null. A property of `s` alone: any castle
   * nearer than a DOMAIN_RADIUS-distant one is itself within DOMAIN_RADIUS, so
   * a scan of that radius centred on `s` can never miss the true winner.
   */
  function ownerOf(s: SettlementSite): SettlementSite | null {
    let best: SettlementSite | null = null;
    let bestD2 = Infinity;
    for (const c of castlesNear(s.x, s.z, DOMAIN_RADIUS)) {
      const d2 = (c.x - s.x) ** 2 + (c.z - s.z) ** 2;
      // sitesNear returns key order, so `<` alone breaks ties deterministically.
      if (d2 < bestD2) { bestD2 = d2; best = c; }
    }
    return best;
  }

  // --- domain construction -------------------------------------------------

  /**
   * Where a castle's roads converge: on its gate axis, just outside the whole
   * settlement footprint. Derived from `castleGateLocal()` and the site radius
   * rather than a constant of my own, because `settlement-plans` owns the gate
   * and its town — it fixed the castle's gate to -Z specifically so a road
   * network could aim at it, and the footprint has already grown once
   * (50 m → 68 m, when the castle gained a town outside its gate).
   */
  function portOf(c: SettlementSite): { x: number; z: number } {
    const gate = castleGateLocal();
    const stand = c.radius + PORT_STANDOFF;
    return { x: c.x + gate.dirX * stand, z: c.z + gate.dirZ * stand };
  }

  const IMPASSABLE = Infinity;

  function buildDomain(castle: SettlementSite): Domain {
    const key = siteKey(castle);
    const reach = DOMAIN_RADIUS + GRID_PAD;

    // World-aligned grid box, derived from the castle alone.
    const g0x = Math.floor((castle.x - reach) / GRID);
    const g1x = Math.floor((castle.x + reach) / GRID);
    const g0z = Math.floor((castle.z - reach) / GRID);
    const g1z = Math.floor((castle.z + reach) / GRID);
    const W = g1x - g0x + 1;
    const H = g1z - g0z + 1;
    const N = W * H;

    const wx = (i: number): number => (g0x + (i % W)) * GRID + GRID * 0.5;
    const wz = (i: number): number => (g0z + Math.floor(i / W)) * GRID + GRID * 0.5;

    // --- traversal cost field --------------------------------------------
    //
    // Only the disc matters: the corners of the box are further from the castle
    // than any road it may build, and `heightAt` is the dominant cost here.
    const height = new Float32Array(N);
    const inDisc = new Uint8Array(N);
    const reach2 = reach * reach;
    for (let i = 0; i < N; i++) {
      const px = wx(i) - castle.x;
      const pz = wz(i) - castle.z;
      if (px * px + pz * pz > reach2) continue;
      inDisc[i] = 1;
      height[i] = base.heightAt(wx(i), wz(i));
    }

    const cost = new Float32Array(N);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        if (inDisc[k] === 0) { cost[k] = IMPASSABLE; continue; }
        const h = height[k];
        if (h < IMPASSABLE_DEPTH) { cost[k] = IMPASSABLE; continue; }
        const hl = height[j * W + Math.max(0, i - 1)];
        const hr = height[j * W + Math.min(W - 1, i + 1)];
        const hd = height[Math.max(0, j - 1) * W + i];
        const hu = height[Math.min(H - 1, j + 1) * W + i];
        const slope = Math.hypot(hr - hl, hu - hd) / (2 * GRID);
        let c = 1 + slope * SLOPE_COST;
        if (h < FORD_LEVEL) c += FORD_COST;
        if (base.riverFactor(wx(k), wz(k)) > 0) c += RIVER_COST;
        // Hashed jitter: breaks ties so paths never run dead-straight along the
        // grid axes, which is the tell that gives a lattice away.
        c += (mix32(seed ^ SALT, g0x + i, g0z + j) / 4294967296) * 0.45;
        cost[k] = c;
      }
    }

    // Settlement footprints are walls, not roads — except the sweep's own root.
    const local = sitesNear(castle.x, castle.z, reach + 120);
    for (const s of local) {
      if (siteKey(s) === key) continue;
      // Blocked out to `endGap`, not to the footprint: that is what keeps the
      // carve off this settlement's flatness ring even for a road merely
      // passing by, which is what makes the base and carved fields agree on
      // where settlements are. GRID slack covers corner-cutting in smoothing.
      const block = endGap(s.kind) + GRID * 0.75;
      const i0 = Math.max(0, Math.floor((s.x - block) / GRID) - g0x);
      const i1 = Math.min(W - 1, Math.floor((s.x + block) / GRID) - g0x);
      const j0 = Math.max(0, Math.floor((s.z - block) / GRID) - g0z);
      const j1 = Math.min(H - 1, Math.floor((s.z + block) / GRID) - g0z);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * W + i;
          if (Math.hypot(wx(k) - s.x, wz(k) - s.z) < block) cost[k] = IMPASSABLE;
        }
      }
    }
    // The castle's own walls too — the sweep starts outside them, at the port.
    {
      const block = castle.radius + 5;
      const i0 = Math.max(0, Math.floor((castle.x - block) / GRID) - g0x);
      const i1 = Math.min(W - 1, Math.floor((castle.x + block) / GRID) - g0x);
      const j0 = Math.max(0, Math.floor((castle.z - block) / GRID) - g0z);
      const j1 = Math.min(H - 1, Math.floor((castle.z + block) / GRID) - g0z);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * W + i;
          if (Math.hypot(wx(k) - castle.x, wz(k) - castle.z) < block) cost[k] = IMPASSABLE;
        }
      }
    }

    // --- members ----------------------------------------------------------
    const members = local.filter((s) =>
      s.kind !== 'castle'
      && Math.hypot(s.x - castle.x, s.z - castle.z) <= DOMAIN_RADIUS
      && (() => { const o = ownerOf(s); return o !== null && siteKey(o) === key; })());

    // Neighbouring castles this sweep can also reach. Only the lower-keyed
    // castle emits the pair, so exactly one road is ever built between them.
    const peers = local.filter((s) =>
      s.kind === 'castle' && siteKey(s) > key
      && Math.hypot(s.x - castle.x, s.z - castle.z) <= DOMAIN_RADIUS);

    // The root. `rootless` swaps it for an arbitrary settlement, which is
    // precisely the property the negative control must expose.
    const port = portOf(castle);
    let rootX = port.x;
    let rootZ = port.z;
    let rootId = `C:${key}`;
    let rootKind: RoadNodeKind = 'castle';
    let rootSettlement: SettlementKind | null = castle.kind;
    let targets = [...members, ...peers];
    if (rootless && members.length > 0) {
      const r = members[0];
      rootX = r.x;
      rootZ = r.z + endGap(r.kind);
      rootId = `S:${siteKey(r)}`;
      rootKind = 'settlement';
      rootSettlement = r.kind;
      targets = [...members.slice(1), ...peers];
    }

    const srcI = Math.min(W - 1, Math.max(0, Math.floor(rootX / GRID) - g0x));
    const srcJ = Math.min(H - 1, Math.max(0, Math.floor(rootZ / GRID) - g0z));
    const src = srcJ * W + srcI;

    // --- Dijkstra outward from the root ----------------------------------
    //
    // This single sweep IS the connectivity guarantee: every cell it settles
    // gets a parent pointer that provably descends to `src`, so any road built
    // by following parents reaches the castle. There is no code path that adds
    // road without following a parent chain.
    const dist = new Float64Array(N).fill(Infinity);
    const parent = new Int32Array(N).fill(-1);
    // Lazy-deletion binary heap: no decrease-key, so it can hold more entries
    // than there are cells and must be able to grow.
    let heapIdx = new Int32Array(N + 1);
    let heapKey = new Float64Array(N + 1);
    let heapN = 0;
    let popped = 0;
    const push = (node: number, d: number): void => {
      if (heapN + 2 >= heapIdx.length) {
        const bigI = new Int32Array(heapIdx.length * 2);
        bigI.set(heapIdx);
        heapIdx = bigI;
        const bigK = new Float64Array(heapKey.length * 2);
        bigK.set(heapKey);
        heapKey = bigK;
      }
      let i = ++heapN;
      heapIdx[i] = node;
      heapKey[i] = d;
      while (i > 1) {
        const p = i >> 1;
        if (heapKey[p] <= heapKey[i]) break;
        const ti = heapIdx[p]; heapIdx[p] = heapIdx[i]; heapIdx[i] = ti;
        const tk = heapKey[p]; heapKey[p] = heapKey[i]; heapKey[i] = tk;
        i = p;
      }
    };
    const pop = (): number => {
      const top = heapIdx[1];
      popped = heapKey[1];
      heapIdx[1] = heapIdx[heapN];
      heapKey[1] = heapKey[heapN];
      heapN--;
      let i = 1;
      for (;;) {
        const l = i << 1;
        const r = l + 1;
        let m = i;
        if (l <= heapN && heapKey[l] < heapKey[m]) m = l;
        if (r <= heapN && heapKey[r] < heapKey[m]) m = r;
        if (m === i) break;
        const ti = heapIdx[m]; heapIdx[m] = heapIdx[i]; heapIdx[i] = ti;
        const tk = heapKey[m]; heapKey[m] = heapKey[i]; heapKey[i] = tk;
        i = m;
      }
      return top;
    };

    dist[src] = 0;
    push(src, 0);
    const SQRT2 = Math.SQRT2;
    while (heapN > 0) {
      const u = pop();
      const dU = dist[u];
      if (popped > dU) continue; // stale entry left behind by a better relaxation
      const ui = u % W;
      const uj = (u - ui) / W;
      for (let dj = -1; dj <= 1; dj++) {
        const vj = uj + dj;
        if (vj < 0 || vj >= H) continue;
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          const vi = ui + di;
          if (vi < 0 || vi >= W) continue;
          const v = vj * W + vi;
          const cv = cost[v];
          if (cv === IMPASSABLE) continue;
          const step = (di !== 0 && dj !== 0) ? SQRT2 : 1;
          const nd = dU + cv * step * GRID;
          if (nd < dist[v]) {
            dist[v] = nd;
            parent[v] = u;
            push(v, nd);
          }
        }
      }
    }

    // --- trace each target back along the parent chain --------------------
    const nodes: WorkNode[] = [{
      id: rootId,
      kind: rootKind,
      settlementKind: rootSettlement,
      x: rootX,
      z: rootZ,
      y: base.heightAt(rootX, rootZ),
      parent: -1,
      halfWidth: HALF_TRUNK,
    }];
    const workEdges: WorkEdge[] = [];
    /** cell → { edge index, position within that edge's cell list }. */
    const claimed = new Map<number, { e: number; at: number }>();

    /**
     * The cheapest reachable cell in the annulus [inner, outer] around (tx, tz)
     * where a road is allowed to terminate. Choosing by Dijkstra distance (not
     * by proximity) means the road arrives from the side the journey actually
     * came from, which is why approaches look deliberate rather than snapped.
     */
    function approachCell(tx: number, tz: number, inner: number, outer: number): number {
      const i0 = Math.max(0, Math.floor((tx - outer) / GRID) - g0x);
      const i1 = Math.min(W - 1, Math.floor((tx + outer) / GRID) - g0x);
      const j0 = Math.max(0, Math.floor((tz - outer) / GRID) - g0z);
      const j1 = Math.min(H - 1, Math.floor((tz + outer) / GRID) - g0z);
      let best = -1;
      let bestD = Infinity;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * W + i;
          if (dist[k] === Infinity) continue;
          const d = Math.hypot(wx(k) - tx, wz(k) - tz);
          if (d < inner || d > outer) continue;
          if (dist[k] < bestD) { bestD = dist[k]; best = k; }
        }
      }
      return best;
    }

    /**
     * Turn a claimed cell into an attachment node, splitting the edge that owns
     * it if it lands mid-way. Both halves keep their parent chain, so the
     * connectivity invariant survives the split.
     */
    function attachAt(cell: number): number {
      const own = claimed.get(cell);
      if (own === undefined) return 0; // the root's own cell
      const e = workEdges[own.e];
      if (own.at === 0) return e.child;
      if (own.at >= e.cells.length - 1) return e.parent;

      const jIdx = nodes.length;
      nodes.push({
        id: `J:${key}:${cell}`, // the cell index makes the id stable, not ordinal
        kind: 'junction',
        settlementKind: null,
        x: wx(cell),
        z: wz(cell),
        y: base.heightAt(wx(cell), wz(cell)),
        parent: e.parent,
        halfWidth: HALF_LOCAL,
      });
      const upper = e.cells.slice(own.at);        // junction → parent
      const lower = e.cells.slice(0, own.at + 1); // child → junction
      const upIdx = workEdges.length;
      workEdges.push({ child: jIdx, parent: e.parent, cells: upper, traffic: e.traffic });
      e.cells = lower;
      e.parent = jIdx;
      nodes[e.child].parent = jIdx;
      // Re-key ownership: the upper half's cells now belong to the new edge.
      for (let t = 0; t < upper.length; t++) {
        const c = upper[t];
        const o = claimed.get(c);
        if (o !== undefined && o.e === own.e) claimed.set(c, { e: upIdx, at: t });
      }
      for (let t = 0; t < lower.length; t++) {
        const o = claimed.get(lower[t]);
        if (o !== undefined && o.e === own.e) claimed.set(lower[t], { e: own.e, at: t });
      }
      return jIdx;
    }

    /** Peer castles that this sweep actually reached — they need gate stubs. */
    const linkedPeers: SettlementSite[] = [];

    for (const s of targets) {
      const isCastle = s.kind === 'castle';
      // A castle is entered through its gate, so aim at its port; anything else
      // is met on the ring where a road may stop without disturbing its ground.
      const peerPort = isCastle ? portOf(s) : null;
      const gap = endGap(s.kind);
      const start = peerPort !== null
        ? approachCell(peerPort.x, peerPort.z, 0, GRID * 1.6)
        : approachCell(s.x, s.z, gap, gap + GRID * 2.5);
      if (start < 0) continue; // unreachable: no road, and nothing dangling

      const path: number[] = [];
      let c = start;
      let hit = -1;
      for (let guard = 0; guard < N; guard++) {
        if (c === src || claimed.has(c)) { hit = c; break; }
        path.push(c);
        const p = parent[c];
        if (p < 0) break;
        c = p;
      }
      if (hit < 0) continue;       // should not happen: the chain ends at src
      if (path.length === 0) continue; // already on the network

      const parentIdx = attachAt(hit);
      path.push(hit);

      const nodeIdx = nodes.length;
      const ax = wx(start) - s.x;
      const az = wz(start) - s.z;
      const al = Math.hypot(ax, az) || 1;
      nodes.push({
        id: isCastle ? `C:${siteKey(s)}` : `S:${siteKey(s)}`,
        kind: isCastle ? 'castle' : 'settlement',
        settlementKind: s.kind,
        // A castle terminates at its port; anything else on the ring where a
        // road may stop, on the side the route actually arrives from.
        x: peerPort !== null ? peerPort.x : s.x + (ax / al) * gap,
        z: peerPort !== null ? peerPort.z : s.z + (az / al) * gap,
        y: 0,
        parent: parentIdx,
        halfWidth: HALF_LOCAL,
      });
      if (peerPort !== null) linkedPeers.push(s);
      nodes[nodeIdx].y = base.heightAt(nodes[nodeIdx].x, nodes[nodeIdx].z);

      const eIdx = workEdges.length;
      workEdges.push({ child: nodeIdx, parent: parentIdx, cells: path, traffic: 1 });
      for (let t = 0; t < path.length - 1; t++) claimed.set(path[t], { e: eIdx, at: t });
    }

    // Traffic: how many settlements each edge carries, so trunks read wider
    // than spurs. Walk each leaf's chain rootward and tally.
    for (const e of workEdges) e.traffic = 0;
    const edgeOfChild = new Map<number, number>();
    workEdges.forEach((e, i) => edgeOfChild.set(e.child, i));
    for (const e of workEdges) {
      if (nodes[e.child].kind === 'junction') continue;
      let n = e.child;
      for (let guard = 0; guard < nodes.length + 2 && n > 0; guard++) {
        const ei = edgeOfChild.get(n);
        if (ei === undefined) break;
        workEdges[ei].traffic++;
        n = workEdges[ei].parent;
      }
    }

    // --- geometry ---------------------------------------------------------
    const edges: RoadEdge[] = [];
    for (const e of workEdges) {
      const childNode = nodes[e.child];
      const parentNode = nodes[e.parent];
      // Grid centres, child → parent, with the true node positions pinned on
      // each end so junctions shared by two edges stay exactly coincident.
      const raw: number[] = [childNode.x, childNode.z];
      for (const c of e.cells) raw.push(wx(c), wz(c));
      raw.push(parentNode.x, parentNode.z);
      const xz = resample(smoothXZ(dedupe(raw)));
      if (xz.length < 6) continue;
      // Re-pin after smoothing; Chaikin holds endpoints but resampling can
      // drop the last vertex to within RESAMPLE of it.
      xz[0] = childNode.x; xz[1] = childNode.z;
      xz[xz.length - 2] = parentNode.x; xz[xz.length - 1] = parentNode.z;
      const pts = simplify(profile(xz, childNode.y, parentNode.y));
      const hw = e.traffic >= TRUNK_TRAFFIC ? HALF_TRUNK : HALF_LOCAL;
      nodes[e.child].halfWidth = hw;
      edges.push({ a: childNode.id, b: parentNode.id, pts, halfWidth: hw, carve: true });
    }

    // A castle that reaches nothing has no road, so it has no place in the road
    // graph either — otherwise it would look like a terminus with no road.
    if (edges.length === 0) {
      return { key, nodes: [], edges: [], minX: 0, minZ: 0, maxX: 0, maxZ: 0 };
    }

    if (!rootless) {
      // The gate stub: every road out of a castle converges on its port, then
      // one straight run paves the town's approach street all the way to the
      // gatehouse mouth. Both ends are the castle itself — geometry, not a
      // graph edge, and it cannot dangle.
      //
      // It carries `carve: false` because it runs inside the castle footprint,
      // where `settlementSiteAt` takes the flatness samples that placed the
      // castle and where every building sits on its own pad. Paint without
      // cut-and-fill is exactly right for that stretch.
      const gate = castleGateLocal();
      for (const c of [castle, ...linkedPeers]) {
        const p = portOf(c);
        const gx = c.x + gate.x;
        const gz = c.z + gate.z;
        edges.push({
          a: `C:${siteKey(c)}`,
          b: `C:${siteKey(c)}`,
          pts: new Float32Array([
            p.x, p.z, base.heightAt(p.x, p.z),
            gx, gz, base.heightAt(gx, gz),
          ]),
          halfWidth: HALF_TRUNK,
          carve: false,
        });
      }
    }

    if (danglingEnds && nodes.length > 1) {
      // NEGATIVE CONTROL: a spur that stops in open ground.
      const from = nodes[nodes.length - 1];
      const rng = mulberry32(mix32(seed ^ 0x1234, key, 77));
      const ang = rng() * Math.PI * 2;
      const raw: number[] = [];
      for (let t = 0; t <= 12; t++) {
        raw.push(from.x + Math.cos(ang) * t * 12, from.z + Math.sin(ang) * t * 12);
      }
      edges.push({
        a: from.id,
        b: `D:${key}`,
        pts: profile(resample(raw), from.y, null),
        halfWidth: HALF_LOCAL,
        carve: true,
      });
    }

    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const e of edges) {
      for (let i = 0; i < e.pts.length; i += 3) {
        if (e.pts[i] < minX) minX = e.pts[i];
        if (e.pts[i] > maxX) maxX = e.pts[i];
        if (e.pts[i + 1] < minZ) minZ = e.pts[i + 1];
        if (e.pts[i + 1] > maxZ) maxZ = e.pts[i + 1];
      }
    }
    return { key, nodes, edges, minX, minZ, maxX, maxZ };
  }

  // --- polyline shaping ----------------------------------------------------

  function dedupe(xz: number[]): number[] {
    const out: number[] = [xz[0], xz[1]];
    for (let i = 2; i + 1 < xz.length; i += 2) {
      const n = out.length;
      if (Math.abs(xz[i] - out[n - 2]) < 1e-6 && Math.abs(xz[i + 1] - out[n - 1]) < 1e-6) {
        continue;
      }
      out.push(xz[i], xz[i + 1]);
    }
    return out;
  }

  /** Chaikin corner cutting, endpoints pinned — turns a grid path into a road. */
  function smoothXZ(xz: number[]): number[] {
    let pts = xz;
    for (let pass = 0; pass < SMOOTH_PASSES && pts.length >= 6; pass++) {
      const next: number[] = [pts[0], pts[1]];
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const x0 = pts[i];
        const z0 = pts[i + 1];
        const x1 = pts[i + 2];
        const z1 = pts[i + 3];
        next.push(x0 * 0.75 + x1 * 0.25, z0 * 0.75 + z1 * 0.25);
        next.push(x0 * 0.25 + x1 * 0.75, z0 * 0.25 + z1 * 0.75);
      }
      next.push(pts[pts.length - 2], pts[pts.length - 1]);
      pts = next;
    }
    return pts;
  }

  /** Uniform resampling, so segment length (and therefore index cost) is bounded. */
  function resample(pts: number[]): number[] {
    if (pts.length < 4) return pts;
    const out: number[] = [pts[0], pts[1]];
    let carry = 0;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const x0 = pts[i];
      const z0 = pts[i + 1];
      const x1 = pts[i + 2];
      const z1 = pts[i + 3];
      const segLen = Math.hypot(x1 - x0, z1 - z0);
      if (segLen < 1e-6) continue;
      let t = (RESAMPLE - carry) / segLen;
      while (t <= 1) {
        out.push(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
        t += RESAMPLE / segLen;
      }
      carry = (carry + segLen) % RESAMPLE;
    }
    out.push(pts[pts.length - 2], pts[pts.length - 1]);
    return out;
  }

  /**
   * Give a routed XZ polyline its height profile: sample the base ground, then
   * relax toward a smooth grade while never straying more than CARVE_MAX from
   * the real terrain. The cap is what keeps a road a *graded path* rather than
   * a canyon, and it bounds how far the carved field can ever disagree with the
   * base one — which is what makes the carve safe for everything downstream.
   */
  function profile(xz: number[], startY: number | null, endY: number | null): Float32Array {
    const n = xz.length / 2;
    const ground = new Float64Array(n);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      ground[i] = base.heightAt(xz[i * 2], xz[i * 2 + 1]);
      y[i] = ground[i];
    }
    if (startY !== null) y[0] = startY;
    if (endY !== null) y[n - 1] = endY;

    for (let pass = 0; pass < 12; pass++) {
      let prev = y[0];
      for (let i = 1; i < n - 1; i++) {
        const cur = y[i];
        const s = (prev + 2 * cur + y[i + 1]) * 0.25;
        prev = cur;
        const lo = ground[i] - CARVE_MAX;
        const hi = ground[i] + CARVE_MAX;
        y[i] = s < lo ? lo : s > hi ? hi : s;
      }
    }

    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      out[i * 3] = xz[i * 2];
      out[i * 3 + 1] = xz[i * 2 + 1];
      out[i * 3 + 2] = y[i];
    }
    return out;
  }

  /**
   * Douglas–Peucker over the 3D polyline. Straight runs collapse to a single
   * segment, which is what keeps the per-query segment walk short. Endpoints
   * are always kept, so junctions shared between two edges stay coincident.
   */
  function simplify(pts: Float32Array): Float32Array {
    const n = pts.length / 3;
    if (n < 3) return pts;
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    // Explicit stack: these polylines can be hundreds of points long.
    const stack: number[] = [0, n - 1];
    while (stack.length > 0) {
      const hi = stack.pop()!;
      const lo = stack.pop()!;
      if (hi - lo < 2) continue;
      const ax = pts[lo * 3];
      const az = pts[lo * 3 + 1];
      const ay = pts[lo * 3 + 2];
      const bx = pts[hi * 3] - ax;
      const bz = pts[hi * 3 + 1] - az;
      const by = pts[hi * 3 + 2] - ay;
      const bl2 = bx * bx + bz * bz + by * by;
      let worst = -1;
      let worstD = SIMPLIFY_TOL;
      for (let i = lo + 1; i < hi; i++) {
        const px = pts[i * 3] - ax;
        const pz = pts[i * 3 + 1] - az;
        const py = pts[i * 3 + 2] - ay;
        let t = bl2 > 0 ? (px * bx + pz * bz + py * by) / bl2 : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const qx = px - bx * t;
        const qz = pz - bz * t;
        const qy = py - by * t;
        const d = Math.sqrt(qx * qx + qz * qz + qy * qy);
        if (d > worstD) { worstD = d; worst = i; }
      }
      if (worst < 0) continue;
      keep[worst] = 1;
      stack.push(lo, worst, worst, hi);
    }
    let m = 0;
    for (let i = 0; i < n; i++) m += keep[i];
    const out = new Float32Array(m * 3);
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (keep[i] === 0) continue;
      out[k++] = pts[i * 3];
      out[k++] = pts[i * 3 + 1];
      out[k++] = pts[i * 3 + 2];
    }
    return out;
  }

  function domainFor(castle: SettlementSite): Domain {
    const k = siteKey(castle);
    const hit = domainCache.get(k);
    if (hit !== undefined) return hit;
    const d = buildDomain(castle);
    if (domainCache.size >= MAX_DOMAIN_CACHE) {
      const oldest = domainCache.keys().next();
      if (!oldest.done) domainCache.delete(oldest.value);
    }
    domainCache.set(k, d);
    return d;
  }

  // --- coverage grid -------------------------------------------------------

  function buildCell(icx: number, icz: number): RCell {
    const x0 = icx * RCELL;
    const z0 = icz * RCELL;
    const cxm = x0 + RCELL * 0.5;
    const czm = z0 + RCELL * 0.5;
    const castles = castlesNear(cxm, czm, CASTLE_REACH + RCELL);
    if (castles.length === 0) return EMPTY_CELL;

    const ax0 = x0 - SEG_REACH;
    const az0 = z0 - SEG_REACH;
    const ax1 = x0 + RCELL + SEG_REACH;
    const az1 = z0 + RCELL + SEG_REACH;

    const acc: number[] = [];
    for (const c of castles) {
      const d = domainFor(c);
      if (d.maxX < ax0 || d.minX > ax1 || d.maxZ < az0 || d.minZ > az1) continue;
      for (const e of d.edges) {
        const pts = e.pts;
        for (let i = 0; i + 5 < pts.length; i += 3) {
          const sx = pts[i];
          const sz = pts[i + 1];
          const ex = pts[i + 3];
          const ez = pts[i + 4];
          if (Math.max(sx, ex) < ax0 || Math.min(sx, ex) > ax1) continue;
          if (Math.max(sz, ez) < az0 || Math.min(sz, ez) > az1) continue;
          const dx = ex - sx;
          const dz = ez - sz;
          const len2 = dx * dx + dz * dz;
          if (len2 < 1e-9) continue;
          acc.push(sx, sz, pts[i + 2], dx, dz, pts[i + 5] - pts[i + 2],
                   1 / len2, e.halfWidth, e.carve ? 1 : 0);
        }
      }
    }
    if (acc.length === 0) return EMPTY_CELL;
    return { segs: new Float32Array(acc), count: acc.length / SEG_STRIDE };
  }

  function cellAt(icx: number, icz: number): RCell {
    if (icx === memoIcx && icz === memoIcz) return memoCell;
    const k = cellKey(icx, icz);
    let cell = cellCache.get(k);
    if (cell === undefined) {
      cell = buildCell(icx, icz);
      if (cellCache.size >= MAX_RCELL_CACHE) {
        const oldest = cellCache.keys().next();
        if (!oldest.done) cellCache.delete(oldest.value);
      }
      cellCache.set(k, cell);
    }
    memoIcx = icx;
    memoIcz = icz;
    memoCell = cell;
    return cell;
  }

  /** Nearest-segment probe. Writes probeD2 / probeY / probeHw. */
  function probe(x: number, z: number): boolean {
    const cell = cellAt(Math.floor(x * INV_RCELL), Math.floor(z * INV_RCELL));
    const n = cell.count;
    if (n === 0) return false;
    const s = cell.segs;
    let bestD2 = Infinity;
    let bestY = 0;
    let bestHw = 0;
    let bestCarve = 0;
    for (let i = 0; i < n; i++) {
      const o = i * SEG_STRIDE;
      const px = x - s[o];
      const pz = z - s[o + 1];
      const dx = s[o + 3];
      const dz = s[o + 4];
      let t = (px * dx + pz * dz) * s[o + 6];
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const qx = px - dx * t;
      const qz = pz - dz * t;
      const d2 = qx * qx + qz * qz;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestY = s[o + 2] + s[o + 5] * t;
        bestHw = s[o + 7];
        bestCarve = s[o + 8];
      }
    }
    probeD2 = bestD2;
    probeY = bestY;
    probeHw = bestHw;
    probeCarve = bestCarve;
    return true;
  }

  function sampleAt(
    x: number, z: number, baseH: number, out: Float32Array, o: number,
  ): number {
    if (!probe(x, z)) { out[o] = 0; return 0; }
    const d = Math.sqrt(probeD2);
    const hw = probeHw;
    out[o] = 1 - smoothstep(hw - MASK_CORE, hw + MASK_FEATHER, d);
    if (probeCarve === 0) return 0;
    const w = 1 - smoothstep(hw, hw + CARVE_BLEND, d);
    if (w <= 0) return 0;
    let delta = probeY - baseH;
    if (delta > CARVE_MAX) delta = CARVE_MAX;
    else if (delta < -CARVE_MAX) delta = -CARVE_MAX;
    return delta * w;
  }

  const scratch1 = new Float32Array(1);

  return {
    seed,
    sampleAt,
    maskAt(x, z) {
      if (!probe(x, z)) return 0;
      return 1 - smoothstep(probeHw - MASK_CORE, probeHw + MASK_FEATHER,
                            Math.sqrt(probeD2));
    },
    carveAt(x, z, baseH) {
      return sampleAt(x, z, baseH, scratch1, 0);
    },
    ensureArea(x0, z0, x1, z1) {
      const i0 = Math.floor(x0 * INV_RCELL);
      const i1 = Math.floor(x1 * INV_RCELL);
      const j0 = Math.floor(z0 * INV_RCELL);
      const j1 = Math.floor(z1 * INV_RCELL);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) cellAt(i, j);
      }
    },
    graphIn(x0, z0, x1, z1) {
      const nodes: RoadNode[] = [];
      const edges: RoadEdge[] = [];
      const cxm = (x0 + x1) * 0.5;
      const czm = (z0 + z1) * 0.5;
      const r = Math.hypot(x1 - x0, z1 - z0) * 0.5 + CASTLE_REACH;
      for (const c of castlesNear(cxm, czm, r)) {
        const d = domainFor(c);
        if (d.maxX < x0 || d.minX > x1 || d.maxZ < z0 || d.minZ > z1) continue;
        for (const nd of d.nodes) {
          nodes.push({
            id: nd.id,
            kind: nd.kind,
            settlementKind: nd.settlementKind,
            x: nd.x, z: nd.z, y: nd.y,
            parentId: nd.parent < 0 ? null : d.nodes[nd.parent].id,
            halfWidth: nd.halfWidth,
          });
        }
        for (const e of d.edges) edges.push(e);
      }
      return { nodes, edges };
    },
    nearestRoad(x, z, maxR = 400) {
      let best: { x: number; z: number; d: number } | null = null;
      const i0 = Math.floor((x - maxR) * INV_RCELL);
      const i1 = Math.floor((x + maxR) * INV_RCELL);
      const j0 = Math.floor((z - maxR) * INV_RCELL);
      const j1 = Math.floor((z + maxR) * INV_RCELL);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const cell = cellAt(i, j);
          const s = cell.segs;
          for (let k = 0; k < cell.count; k++) {
            const o = k * SEG_STRIDE;
            const px = x - s[o];
            const pz = z - s[o + 1];
            const dx = s[o + 3];
            const dz = s[o + 4];
            let t = (px * dx + pz * dz) * s[o + 6];
            if (t < 0) t = 0; else if (t > 1) t = 1;
            const qx = s[o] + dx * t;
            const qz = s[o + 1] + dz * t;
            const d = Math.hypot(x - qx, z - qz);
            if (d <= maxR && (best === null || d < best.d)) best = { x: qx, z: qz, d };
          }
        }
      }
      return best;
    },
    stats() {
      let segments = 0;
      for (const c of cellCache.values()) segments += c.count;
      return {
        domains: domainCache.size,
        cells: cellCache.size,
        sites: siteCache.size,
        segments,
      };
    },
  };
}

/**
 * A `HeightField` with the roads cut into it.
 *
 * Everything that touches the GROUND must use this — terrain mesh, player and
 * camera collision, foliage grounding — so the surface you see, the surface you
 * stand on and the surface things are planted on are the same surface.
 *
 * Everything that DECIDES WHERE THINGS GO must keep the base field: settlement
 * scatter, dungeon entrances, resource nodes. Roads are derived from settlement
 * positions, so if settlement placement read the carved field the definition
 * would be circular — and worse, a road could nudge the ground enough to
 * invalidate the very settlement it was built to reach, which is exactly the
 * "road to nowhere" this system exists to rule out. `endGap` keeps the carve
 * off every settlement's flatness ring as a second line of defence, so the two
 * fields agree on settlement placement even if they are crossed by accident.
 *
 * `seed` and `riverFactor` pass through unchanged.
 */
export function carveRoads(base: HeightField, roads: RoadNetwork): HeightField {
  return {
    seed: base.seed,
    heightAt(x: number, z: number): number {
      const h = base.heightAt(x, z);
      return h + roads.carveAt(x, z, h);
    },
    riverFactor(x: number, z: number): number {
      return base.riverFactor(x, z);
    },
  };
}
