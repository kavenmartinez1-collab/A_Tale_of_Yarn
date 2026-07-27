/**
 * Deterministic tests for the road network.  Pure CPU — no GPU, no server.
 *   npx tsx scripts/test-roads.mts
 *
 * The feature's whole reason to exist is one property: **following a road
 * always leads to a castle.**  These tests attack that property directly.
 *
 * The suite is only meaningful because of §5, the NEGATIVE CONTROLS.  The same
 * assertions are re-run against two deliberately broken generators —
 * `rootless` (trees rooted at an arbitrary settlement instead of the castle,
 * i.e. outward growth removed) and `danglingEnds` (spurs that stop in open
 * ground) — and the suite FAILS on both.  A connectivity test that passes on a
 * generator with no connectivity guarantee is measuring nothing.
 */

import { createHeightField } from '../src/game/noise';
import { createBiomeField } from '../src/game/biome';
import { buildChunkVertices } from '../src/game/terrain/chunk-mesh';
import {
  createRoadNetwork, carveRoads, HALF_LOCAL,
  type RoadGraph, type RoadNetwork,
} from '../src/game/world/roads';
import {
  SCELL, SETTLEMENT_RADIUS, settlementSiteAt,
} from '../src/game/settlement/settlement-scatter';

/**
 * Determinism tripwire over the sampled mask + carve grid. Update ONLY on a
 * deliberate road-generation change, in the same commit, and re-verify roads
 * in-game afterwards — a change here also moves what the terrain mesh, player
 * collision and foliage grounding all see.
 *
 * 0x1a92b4eb — 2026-07-25. `settlement-plans` grew the castle footprint from
 *   50 m to 68 m and gave it a town outside the north gate, so the port moved
 *   out to radius + 6 and the gate stub now paves the approach street. Castle
 *   placement itself shifted with the larger inset and flatness budget.
 * 0x6dcedfe4 — 2026-07-25, first bake.
 */
// 0xb13b89fc — 2026-07-26. Settlement flatness became a whole-footprint spread
// test (see test-settlement-scatter.mts for the reasoning), which moves where
// settlements and castles sit. Roads are rooted at castles and routed between
// settlements, so the network necessarily changes with them. Density went UP:
// 178 -> 192 settlements, 7 -> 8 castles, so this is not a loss of coverage.
// Verified after re-bake: 0 castleless components, 0 dangling termini, 0 failed
// rootward walks — the connectivity promise still holds by construction.
// 2026-07-26 (later the same day). Castle/town placement tightened after the
// user reported glitchy placements: flatness now sampled on 5 rings x 14 spokes
// (was 3 x 8, too coarse to enforce its own budget), castle budget 24 -> 20,
// town 11 -> 9, CANDIDATES 40 -> 96 to hold density. Settlements moved, so
// everything keyed off their positions moves with them. Road network stays
// connected: 10 castles, 176 nodes, 72 junctions, 107.8 km.
// Previous: 0xb13b89fc
// 2026-07-26, population pass. `rollKind` rebalanced 40/22/15/13/10 ->
// 26/14/22/19/19 to stop over half the world being empty ruins (see
// test-settlement-scatter.mts for the full reasoning). Roads are rooted at
// castle gates and routed between settlements, so moving the settlements moves
// the whole network. The direction is the safe one: castles 7 -> 12 in the
// 576-cell scatter window, so the graph gains roots rather than losing them —
// which is what `castles >= 8` below exists to protect, since a Dijkstra tree
// with no root is not a shorter road, it is no road.
// Verified after re-bake: 0 castleless components, 0 dangling termini, 0 failed
// rootward walks, and the negative controls still fail as they must.
// Previous: 0x682d14d8
// 2026-07-26, river pass. `settlementSiteAt` now rejects any candidate whose
// footprint crosses a river (full reasoning in test-settlement-scatter.mts),
// and the forced near-spawn castle moved from cell '-1,0' to cell '-1,-1'
// because its pin was in one. Roads are rooted at castle gates and routed
// between settlements, so moving the settlements moves the whole network.
//
// This is the direction that needed watching: the river test is a new
// acceptance cut on top of the flatness one, and on its own it took the
// 576-cell scatter window from 166 settlements and 12 castles to 162 and 10.
// `castles >= 8` below is not a style guard — a Dijkstra tree with no root is
// no road at all — so CANDIDATES rose 96 -> 128 to buy the density back, which
// lands at 168 settlements and 11 castles. The road network stays connected
// after the re-bake: 0 castleless components, 0 dangling termini, 0 failed
// rootward walks, and the negative controls still fail as they must.
//
// Rivers themselves did not move, and neither did the road field's own reading
// of them (`RIVER_COST` on `base.riverFactor > 0`). A road may still cross a
// river; a settlement may no longer sit in one.
// Previous: 0x35a6deab
const GOLDEN_HASH: number | null = 0x8b23eac3;

const WORLD_SEED = 1337;

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const base = createHeightField(WORLD_SEED);

// ---------------------------------------------------------------------------
// Graph analysis — shared by the real generator and the negative controls.
// ---------------------------------------------------------------------------

type Kind = 'castle' | 'settlement' | 'junction' | 'dangling';

/**
 * A node id encodes its kind, which is what lets us reason about an edge whose
 * far end belongs to a domain outside the sampled window: `C:` is a castle
 * wherever it lives.
 */
function kindOf(id: string): Kind {
  if (id.startsWith('C:')) return 'castle';
  if (id.startsWith('S:')) return 'settlement';
  if (id.startsWith('J:')) return 'junction';
  return 'dangling';
}

interface Analysis {
  nodes: number;
  edges: number;
  castles: number;
  junctions: number;
  /** Components (over non-self-loop edges) with no castle in them. */
  castlelessComponents: number;
  /** Degree-1 nodes that are neither a castle nor a settlement. */
  danglingTermini: number;
  /** In-window nodes whose rootward walk does not end at a castle. */
  walksNotReachingCastle: number;
  /** Edge midpoints that are not actually paved (mask below 0.5). */
  unpavedMidpoints: number;
  /** Longest rootward walk, in nodes. */
  maxWalk: number;
  /** Forks: nodes with three or more distinct road ends meeting. */
  forks: number;
  /** Forks that sit in open wilderness rather than at a settlement. */
  wildernessForks: number;
  totalRoadMetres: number;
}

function analyse(g: RoadGraph, net: RoadNetwork): Analysis {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));

  // Dedupe: a highway is emitted by both of its castles.
  const seen = new Set<string>();
  const edges: { a: string; b: string; pts: Float32Array }[] = [];
  let totalRoadMetres = 0;
  for (const e of g.edges) {
    const k = e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`;
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push(e);
    for (let i = 3; i < e.pts.length; i += 3) {
      totalRoadMetres += Math.hypot(e.pts[i] - e.pts[i - 3], e.pts[i + 1] - e.pts[i - 2]);
    }
  }

  // --- union-find over real (non-self-loop) edges ---------------------------
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(a, r);
    return r;
  };
  const union = (a: string, b: string): void => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const degree = new Map<string, number>();
  const bump = (id: string): void => degree.set(id, (degree.get(id) ?? 0) + 1);

  for (const e of edges) {
    if (e.a === e.b) continue; // gate stub: geometry, not a graph edge
    union(e.a, e.b);
    bump(e.a);
    bump(e.b);
  }

  const compHasCastle = new Set<string>();
  const comps = new Set<string>();
  for (const id of parent.keys()) {
    const r = find(id);
    comps.add(r);
    if (kindOf(id) === 'castle') compHasCastle.add(r);
  }
  let castlelessComponents = 0;
  for (const r of comps) if (!compHasCastle.has(r)) castlelessComponents++;

  // --- termini -------------------------------------------------------------
  let danglingTermini = 0;
  for (const [id, d] of degree) {
    if (d !== 1) continue;
    const k = kindOf(id);
    if (k !== 'castle' && k !== 'settlement') danglingTermini++;
  }

  // --- rootward walk -------------------------------------------------------
  let walksNotReachingCastle = 0;
  let maxWalk = 0;
  for (const n of g.nodes) {
    let cur: string | null = n.id;
    let steps = 0;
    let reached = false;
    while (cur !== null && steps < 4096) {
      if (kindOf(cur) === 'castle') { reached = true; break; }
      const nd = byId.get(cur);
      if (nd === undefined) break;
      cur = nd.parentId;
      steps++;
    }
    if (steps > maxWalk) maxWalk = steps;
    if (!reached) walksNotReachingCastle++;
  }

  // --- is the road actually paved where the graph says it is? --------------
  let unpavedMidpoints = 0;
  for (const e of edges) {
    const m = Math.floor(e.pts.length / 6) * 3;
    if (m + 1 >= e.pts.length) continue;
    if (net.maskAt(e.pts[m], e.pts[m + 1]) < 0.5) unpavedMidpoints++;
  }

  // --- forks ---------------------------------------------------------------
  let forks = 0;
  let wildernessForks = 0;
  for (const [id, d] of degree) {
    if (d < 3) continue;
    forks++;
    if (kindOf(id) === 'junction') wildernessForks++;
  }

  return {
    // Distinct, not raw: a castle reached by a neighbour's sweep appears as a
    // node in both domains, and counting it twice would overstate the world.
    nodes: byId.size,
    edges: edges.length,
    castles: new Set(g.nodes.filter((n) => n.kind === 'castle').map((n) => n.id)).size,
    junctions: new Set(g.nodes.filter((n) => n.kind === 'junction').map((n) => n.id)).size,
    castlelessComponents,
    danglingTermini,
    walksNotReachingCastle,
    unpavedMidpoints,
    maxWalk,
    forks,
    wildernessForks,
    totalRoadMetres,
  };
}

// ---------------------------------------------------------------------------
// 1. The connectivity promise, over a large world window
// ---------------------------------------------------------------------------

// 12 km x 12 km — dozens of castles, hundreds of settlements.
const WIN = 6000;
const t0 = Date.now();
const roads = createRoadNetwork(WORLD_SEED, base);
const graph = roads.graphIn(-WIN, -WIN, WIN, WIN);
const a = analyse(graph, roads);
const buildMs = Date.now() - t0;

console.log(`--- world window ${(WIN * 2) / 1000} km square -----------------`);
console.log(`  ${a.castles} castles, ${a.nodes} nodes, ${a.edges} edges, `
  + `${a.junctions} junctions, ${(a.totalRoadMetres / 1000).toFixed(1)} km of road`);
console.log(`  ${a.forks} forks (${a.wildernessForks} in open wilderness), `
  + `deepest rootward walk ${a.maxWalk} nodes, built in ${buildMs} ms`);

check('the window actually contains castles', a.castles >= 8, `${a.castles}`);
check('the window actually contains roads', a.edges >= 100, `${a.edges}`);

// THE PROMISE, in three independent forms.
check('every connected component contains a castle',
  a.castlelessComponents === 0,
  `${a.castlelessComponents} castleless component(s)`);
check('every road terminus is a settlement or a castle — no road to nowhere',
  a.danglingTermini === 0, `${a.danglingTermini} dangling end(s)`);
check('a rootward walk from every node reaches a castle',
  a.walksNotReachingCastle === 0,
  `${a.walksNotReachingCastle} of ${a.nodes} nodes did not`);

check('forks exist (a fork is the point)', a.forks >= 10, `${a.forks}`);
check('forks happen in open wilderness, not only at settlements',
  a.wildernessForks >= 5, `${a.wildernessForks}`);
check('every graph edge is paved where it claims to be',
  a.unpavedMidpoints === 0, `${a.unpavedMidpoints} unpaved midpoint(s)`);

// ---------------------------------------------------------------------------
// 2. Walk it like a player: pick a point ON a road, follow the network
// ---------------------------------------------------------------------------
{
  // Sample points spread across every edge, not just midpoints, and verify the
  // paved surface really is continuous along the whole polyline.
  let offRoad = 0;
  let samples = 0;
  for (const e of graph.edges) {
    const n = e.pts.length / 3;
    for (let i = 0; i < n; i++) {
      // Halfway between consecutive vertices is the worst case for a
      // segment-distance mask: furthest from any stored vertex.
      const j = Math.min(i + 1, n - 1);
      const x = (e.pts[i * 3] + e.pts[j * 3]) * 0.5;
      const z = (e.pts[i * 3 + 1] + e.pts[j * 3 + 1]) * 0.5;
      samples++;
      if (roads.maskAt(x, z) < 0.5) offRoad++;
    }
  }
  check('the paved surface is continuous along every polyline',
    offRoad === 0, `${offRoad} of ${samples} sampled points were not paved`);

  // From an arbitrary paved point, does *stepping onto the network and
  // following it* end somewhere real? Walk both directions of the edge.
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const walk = (id: string): Kind => {
    let cur: string | null = id;
    for (let s = 0; s < 4096 && cur !== null; s++) {
      if (kindOf(cur) === 'castle') return 'castle';
      const nd = byId.get(cur);
      if (nd === undefined) return kindOf(cur);
      if (nd.parentId === null) return nd.kind;
      cur = nd.parentId;
    }
    return 'dangling';
  };
  let badDirections = 0;
  let castleward = 0;
  for (const e of graph.edges) {
    const ka = walk(e.a);
    const kb = walk(e.b);
    // At least one direction must reach a castle…
    if (ka === 'castle' || kb === 'castle') castleward++;
    else badDirections++;
    // …and neither direction may end nowhere.
    if (ka === 'dangling' || kb === 'dangling') badDirections++;
  }
  check('from every road, one direction reaches a castle and neither ends nowhere',
    badDirections === 0, `${badDirections} bad direction(s) of ${graph.edges.length} edges`);
  check('castleward direction found on every edge',
    castleward === graph.edges.length, `${castleward}/${graph.edges.length}`);
}

// ---------------------------------------------------------------------------
// 3. Determinism, and stability under streaming order
// ---------------------------------------------------------------------------
{
  const probeXZ: number[] = [];
  for (const e of graph.edges.slice(0, 200)) {
    for (let i = 0; i < e.pts.length; i += 3) probeXZ.push(e.pts[i], e.pts[i + 1]);
  }
  // Add off-road probes so "all zeroes" cannot pass by accident.
  for (let i = 0; i < 2000; i++) probeXZ.push(i * 37 - 3000, i * -53 + 1500);

  const sampleAll = (net: RoadNetwork): Float64Array => {
    const out = new Float64Array(probeXZ.length);
    const scratch = new Float32Array(1);
    for (let i = 0; i < probeXZ.length; i += 2) {
      const x = probeXZ[i];
      const z = probeXZ[i + 1];
      const h = base.heightAt(x, z);
      out[i] = net.sampleAt(x, z, h, scratch, 0);
      out[i + 1] = scratch[0];
    }
    return out;
  };

  const a1 = sampleAll(roads);

  // Same seed, a brand-new network with a cold cache: identical.
  const fresh = createRoadNetwork(WORLD_SEED, base);
  const a2 = sampleAll(fresh);
  check('same seed, cold cache ⇒ bit-identical samples',
    a1.every((v, i) => v === a2[i]));

  // "Approached from the north" vs "from the south": warm the coverage grid in
  // opposite orders before sampling. A cell's answer must not depend on which
  // neighbours were resolved first, or a road would change shape behind you.
  const north = createRoadNetwork(WORLD_SEED, base);
  for (let z = -WIN; z <= WIN; z += 256) north.ensureArea(-WIN, z, WIN, z);
  const south = createRoadNetwork(WORLD_SEED, base);
  for (let z = WIN; z >= -WIN; z -= 256) south.ensureArea(-WIN, z, WIN, z);
  const an = sampleAll(north);
  const as = sampleAll(south);
  check('approach direction does not change the road (north vs south warm-up)',
    an.every((v, i) => v === as[i] && v === a1[i]));

  // Cache eviction must be invisible: it is a cache of a pure function. The
  // domain and coverage caches are both small and the player streams through
  // far more than they hold, so this is the everyday case, not an edge case.
  const evicted = createRoadNetwork(WORLD_SEED, base);
  evicted.ensureArea(-WIN * 2, -WIN * 2, WIN * 2, WIN * 2); // blows every cap
  const ae = sampleAll(evicted);
  check('cache eviction does not change any sample',
    ae.every((v, i) => v === a1[i]));

  // …and not just the samples: the graph itself must come back identical after
  // every domain has been evicted and rebuilt.
  const eg = evicted.graphIn(-WIN, -WIN, WIN, WIN);
  const idsA = graph.nodes.map((n) => `${n.id}@${n.x.toFixed(3)},${n.z.toFixed(3)}`)
    .sort().join('|');
  const idsB = eg.nodes.map((n) => `${n.id}@${n.x.toFixed(3)},${n.z.toFixed(3)}`)
    .sort().join('|');
  check('the graph is identical after full cache eviction',
    idsA === idsB && graph.edges.length === eg.edges.length,
    `${graph.nodes.length}/${graph.edges.length} vs ${eg.nodes.length}/${eg.edges.length}`);

  // A different seed must actually move the roads.
  const other = createRoadNetwork(WORLD_SEED + 1, base);
  const ao = sampleAll(other);
  check('a different seed produces a different network',
    ao.some((v, i) => v !== a1[i]));

  const bytes = new Uint8Array(new Float32Array(a1).buffer);
  const hash = fnv1a(bytes);
  if (GOLDEN_HASH === null) {
    console.log(`  golden road hash: 0x${hash.toString(16).padStart(8, '0')} `
      + '(bake into GOLDEN_HASH)');
    check('golden road hash is baked', false, 'set GOLDEN_HASH above');
  } else {
    check('golden road hash matches', hash === GOLDEN_HASH,
      `got 0x${hash.toString(16)} want 0x${GOLDEN_HASH.toString(16)}`);
  }
}

// ---------------------------------------------------------------------------
// 4. The carve: bounded, seam-safe, and it must not move settlements
// ---------------------------------------------------------------------------
const carved = carveRoads(base, roads);
{
  let maxDelta = 0;
  let onRoadCarves = 0;
  for (const e of graph.edges.slice(0, 400)) {
    for (let i = 0; i < e.pts.length; i += 3) {
      const x = e.pts[i];
      const z = e.pts[i + 1];
      for (const [ox, oz] of [[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4], [9, 9]]) {
        const d = Math.abs(carved.heightAt(x + ox, z + oz) - base.heightAt(x + ox, z + oz));
        if (d > maxDelta) maxDelta = d;
      }
      if (Math.abs(carved.heightAt(x, z) - base.heightAt(x, z)) > 0.02) onRoadCarves++;
    }
  }
  check('the carve never moves the ground more than its cap', maxDelta <= 2.5 + 1e-6,
    `max |Δh| = ${maxDelta.toFixed(3)} m`);
  check('the carve actually does something', onRoadCarves > 200, `${onRoadCarves}`);

  // Seam safety: the chunk mesher evaluates a shared border vertex from both
  // sides using integer world coords. Same input ⇒ same output is what keeps
  // chunk edges crack-free, so assert it on the carved field explicitly.
  let seamMismatch = 0;
  for (let c = -40; c < 40; c++) {
    const wx = c * 64 + 64; // chunk c's i=64 border == chunk c+1's i=0
    for (let k = 0; k < 64; k++) {
      const wz = k * 97 - 3000;
      const fromLeft = carved.heightAt(c * 64 + 64, wz);
      const fromRight = carved.heightAt((c + 1) * 64 + 0, wz);
      if (fromLeft !== fromRight) seamMismatch++;
      if (wx !== (c + 1) * 64) seamMismatch++;
    }
  }
  check('carved height is bit-identical across chunk borders', seamMismatch === 0,
    `${seamMismatch} mismatch(es)`);

  // Non-circularity. Roads are derived from settlement positions, so if a road
  // could move the ground under the flatness test that placed a settlement, the
  // definition would eat its own tail — and a road could end at a settlement
  // that no longer exists. `endGap` is what prevents it; this is the assertion.
  let ringTouched = 0;
  let siteMoved = 0;
  let sitesChecked = 0;
  let cellsChecked = 0;
  let appeared = 0;
  for (let cz = -14; cz <= 14; cz++) {
    for (let cx = -14; cx <= 14; cx++) {
      cellsChecked++;
      const s = settlementSiteAt(WORLD_SEED, cx, cz, base.heightAt);
      if (s === null) {
        // The other direction matters just as much: a cell that gains a
        // settlement under the carved field would leave the game placing one
        // the road network never knew about.
        if (settlementSiteAt(WORLD_SEED, cx, cz, carved.heightAt) !== null) appeared++;
        continue;
      }
      sitesChecked++;
      if (Math.abs(carved.heightAt(s.x, s.z) - base.heightAt(s.x, s.z)) > 1e-9) ringTouched++;
      const r = SETTLEMENT_RADIUS[s.kind] * 0.7;
      for (let k = 0; k < 8; k++) {
        const ang = (k / 8) * Math.PI * 2;
        const rx = s.x + Math.cos(ang) * r;
        const rz = s.z + Math.sin(ang) * r;
        if (Math.abs(carved.heightAt(rx, rz) - base.heightAt(rx, rz)) > 1e-9) ringTouched++;
      }
      const viaCarved = settlementSiteAt(WORLD_SEED, cx, cz, carved.heightAt);
      if (viaCarved === null || viaCarved.x !== s.x || viaCarved.z !== s.z
          || viaCarved.kind !== s.kind) siteMoved++;
    }
  }
  console.log(`--- non-circularity: ${sitesChecked} settlements in `
    + `${cellsChecked} cells ---`);
  check('the carve never touches a settlement centre or its flatness ring',
    ringTouched === 0, `${ringTouched} touched sample(s)`);
  // …and here is the residual, which is WHY the two fields must stay separate.
  //
  // `settlementSiteAt` tries up to 8 jittered candidates per cell and takes the
  // first that clears `h >= 3` and a flatness budget. A road can run straight
  // over a candidate that was REJECTED — nothing protects a position that is
  // not a settlement — and 2.5 m of cut or fill there can flip that candidate's
  // verdict, changing which candidate the cell settles on. Measured below at
  // roughly 1 cell in 800.
  //
  // The consequence would be a road built toward a settlement the game then
  // places somewhere else: a road to nowhere, the exact thing this system
  // exists to rule out. It cannot be designed away — the decision has no margin
  // to hide 2.5 m in — so the guarantee comes from the wiring instead:
  // placement systems (settlement scatter, dungeon entrances, resource nodes)
  // keep the BASE field, and only ground-contact consumers get the carved one.
  // This bound exists to keep the blast radius visible if that ever gets crossed.
  const flips = siteMoved + appeared;
  console.log(`  candidate flips under the carved field: ${flips} of `
    + `${cellsChecked} cells (${((flips / cellsChecked) * 100).toFixed(2)}%)`);
  check('carved-field placement drift stays negligible (see comment)',
    flips <= cellsChecked * 0.01, `${flips}/${cellsChecked} cells differ`);

  // How far the two fields actually diverge on a road. This is what a consumer
  // still holding the base field (an entity's ground snap, say) would be off
  // by, so it is worth stating rather than assuming.
  const deltas: number[] = [];
  for (const e of graph.edges.slice(0, 400)) {
    for (let i = 0; i < e.pts.length; i += 3) {
      deltas.push(Math.abs(
        carved.heightAt(e.pts[i], e.pts[i + 1]) - base.heightAt(e.pts[i], e.pts[i + 1])));
    }
  }
  deltas.sort((p, q) => p - q);
  const med = deltas[deltas.length >> 1];
  const p95 = deltas[Math.floor(deltas.length * 0.95)];
  console.log(`  carve depth on the centreline: median ${med.toFixed(2)} m, `
    + `p95 ${p95.toFixed(2)} m, max ${deltas[deltas.length - 1].toFixed(2)} m`);
}

// ---------------------------------------------------------------------------
// 5. NEGATIVE CONTROLS — the suite must be able to fail
// ---------------------------------------------------------------------------
console.log('--- negative controls ------------------------------------------');
{
  // (a) Outward growth removed: trees rooted at an arbitrary settlement.
  const bad = createRoadNetwork(WORLD_SEED, base, { rootless: true });
  const bg = analyse(bad.graphIn(-WIN, -WIN, WIN, WIN), bad);
  console.log(`  rootless:     ${bg.edges} edges, `
    + `${bg.castlelessComponents} castleless component(s), `
    + `${bg.walksNotReachingCastle}/${bg.nodes} walks failed`);
  check('NEGATIVE: a generator without outward growth FAILS the component test',
    bg.edges > 50 && bg.castlelessComponents > 0,
    'the component test cannot fail, so it proves nothing');
  check('NEGATIVE: a generator without outward growth FAILS the walk test',
    bg.walksNotReachingCastle > 0,
    'the walk test cannot fail, so it proves nothing');

  // (b) Termini in open ground.
  const stubby = createRoadNetwork(WORLD_SEED, base, { danglingEnds: true });
  const sg = analyse(stubby.graphIn(-WIN, -WIN, WIN, WIN), stubby);
  console.log(`  danglingEnds: ${sg.edges} edges, `
    + `${sg.danglingTermini} dangling terminus(es)`);
  check('NEGATIVE: roads that stop in open ground FAIL the terminus test',
    sg.danglingTermini > 0,
    'the terminus test cannot fail, so it proves nothing');
}

// ---------------------------------------------------------------------------
// 6. Performance — the frame budget is already tight
// ---------------------------------------------------------------------------
console.log('--- performance ------------------------------------------------');
{
  // Find a chunk the road actually crosses; the off-road path is the easy case.
  const onRoad = graph.edges.find((e) => e.pts.length > 60)!;
  const rcx = Math.floor(onRoad.pts[0] / 64);
  const rcz = Math.floor(onRoad.pts[1] / 64);

  const biomes = createBiomeField(WORLD_SEED, base);
  const warm = createRoadNetwork(WORLD_SEED, base);
  const warmCarved = carveRoads(base, warm);
  // Warm the coverage grid FIRST. Timing a cold cache would measure domain
  // construction, not the steady-state streaming cost this is meant to bound —
  // an earlier version of this benchmark did exactly that and reported a 700%
  // regression that did not exist.
  warm.ensureArea(rcx * 64 - 256, rcz * 64 - 256, rcx * 64 + 320, rcz * 64 + 320);

  // The same 4x4 block of chunks for both fields, so the terrain work is
  // identical and only the road query differs. This block straddles a road, so
  // it is the WORST case, not the average: roads touch a few per cent of chunks
  // and the rest pay one coverage-cell lookup and stop.
  const timeChunks = (hf: typeof base): number => {
    for (let i = 0; i < 4; i++) buildChunkVertices(hf, biomes, rcx, rcz); // JIT
    const t = process.hrtime.bigint();
    let n = 0;
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) { buildChunkVertices(hf, biomes, rcx + i, rcz + j); n++; }
    }
    return Number(process.hrtime.bigint() - t) / 1e6 / n;
  };
  const plainMs = timeChunks(base);
  const roadMs = timeChunks(warmCarved);
  const pct = ((roadMs / plainMs - 1) * 100);
  console.log(`  chunk build (worst case, on a road): ${plainMs.toFixed(2)} ms plain vs `
    + `${roadMs.toFixed(2)} ms carved  (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`);
  check('carved chunk build stays within 35% of plain even on a road', pct < 35,
    `${pct.toFixed(1)}% slower`);

  // And the case that actually dominates: chunks with no road anywhere near.
  const emptyCx = Math.floor(24000 / 64);
  const emptyCz = Math.floor(-31000 / 64);
  const timeEmpty = (hf: typeof base): number => {
    for (let i = 0; i < 4; i++) buildChunkVertices(hf, biomes, emptyCx, emptyCz);
    const t = process.hrtime.bigint();
    for (let i = 0; i < 8; i++) buildChunkVertices(hf, biomes, emptyCx + i, emptyCz);
    return Number(process.hrtime.bigint() - t) / 1e6 / 8;
  };
  warm.ensureArea(emptyCx * 64 - 128, emptyCz * 64 - 128,
                  emptyCx * 64 + 640, emptyCz * 64 + 128);
  const ePlain = timeEmpty(base);
  const eRoad = timeEmpty(warmCarved);
  const ePct = ((eRoad / ePlain - 1) * 100);
  console.log(`  chunk build (typical, no road): ${ePlain.toFixed(2)} ms plain vs `
    + `${eRoad.toFixed(2)} ms carved  (${ePct >= 0 ? '+' : ''}${ePct.toFixed(1)}%)`);
  check('a road-free chunk build is within 15% of plain', ePct < 15,
    `${ePct.toFixed(1)}% slower`);

  // Raw query throughput on a road-bearing cell.
  const px = onRoad.pts[0];
  const pz = onRoad.pts[1];
  const scratch = new Float32Array(1);
  let sink = 0;
  const t2 = process.hrtime.bigint();
  const N = 400000;
  for (let i = 0; i < N; i++) {
    sink += warm.sampleAt(px + (i & 63), pz + ((i >> 6) & 63), 10, scratch, 0);
  }
  const nsPer = Number(process.hrtime.bigint() - t2) / N;
  console.log(`  sampleAt: ${nsPer.toFixed(0)} ns/call on a road-bearing cell `
    + `(sink ${sink.toFixed(1)})`);
  check('sampleAt is under 200 ns on a road-bearing cell', nsPer < 200,
    `${nsPer.toFixed(0)} ns`);

  // Cold domain build — the one-off hitch when the player enters new territory.
  const cold = createRoadNetwork(WORLD_SEED, base);
  const t3 = process.hrtime.bigint();
  cold.ensureArea(rcx * 64, rcz * 64, rcx * 64 + 64, rcz * 64 + 64);
  const coldMs = Number(process.hrtime.bigint() - t3) / 1e6;
  const st = cold.stats();
  console.log(`  cold coverage for one chunk: ${coldMs.toFixed(1)} ms `
    + `(${st.domains} domain(s), ${st.sites} settlement cells, ${st.segments} segments)`);
  check('a cold chunk coverage build stays under 120 ms', coldMs < 120,
    `${coldMs.toFixed(1)} ms`);
}

// ---------------------------------------------------------------------------
// 7. Shape sanity — widths, spacing, and that roads reach castle gates
// ---------------------------------------------------------------------------
{
  // A castle node sits on its gate axis just outside the town; the gate stub
  // paves the approach street from there to the gatehouse mouth. Assert the
  // road really is continuous over that stretch. Deduped by id, because a
  // castle reached by a neighbour's sweep is a node in both domains.
  const gateSeen = new Set<string>();
  let gates = 0;
  for (const n of graph.nodes) {
    if (n.kind !== 'castle' || gateSeen.has(n.id)) continue;
    gateSeen.add(n.id);
    if (roads.maskAt(n.x, n.z) > 0.5 && roads.maskAt(n.x, n.z + 20) > 0.5) gates++;
  }
  check('every castle in the graph has paved road running to its gate',
    gates === a.castles, `${gates}/${a.castles}`);

  // The mask must fall to zero off the verge, or the whole world is "road".
  // Ask `nearestRoad` where the road actually is rather than assuming an
  // offset is clear — with 128 km of road in the window, "60 m away" is often
  // simply on a different road, which is what an earlier version of this check
  // mistook for a leak.
  let leaked = 0;
  let probes = 0;
  for (let i = 0; i < 4000; i++) {
    const x = ((i * 2654435761) % 9000) - 4500;
    const z = ((i * 1597334677) % 9000) - 4500;
    const near = roads.nearestRoad(x, z, 80);
    if (near !== null && near.d < 12) continue; // genuinely near a road
    probes++;
    if (roads.maskAt(x, z) > 0) leaked++;
  }
  check('the mask is zero everywhere off the verge', leaked === 0,
    `${leaked} leak(s) of ${probes} clear probes`);

  // Road area as a fraction of the world: sparse enough to be a landmark,
  // common enough to find.
  let hits = 0;
  const TOT = 160000;
  for (let i = 0; i < TOT; i++) {
    const x = ((i * 2654435761) % 8000) - 4000;
    const z = ((i * 1597334677) % 8000) - 4000;
    if (roads.maskAt(x, z) > 0.5) hits++;
  }
  const pctArea = (hits / TOT) * 100;
  console.log(`--- coverage: ${pctArea.toFixed(3)}% of the world is paved `
    + `(half-width ${HALF_LOCAL} m local) --`);
  check('paved area is a sensible fraction of the world',
    pctArea > 0.02 && pctArea < 3, `${pctArea.toFixed(3)}%`);
  check('settlement cell size is what the road lattice assumes', SCELL === 512);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
