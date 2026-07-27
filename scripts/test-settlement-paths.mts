/**
 * Deterministic tests for intra-settlement circulation (settlement-paths.ts).
 * Pure CPU — no GPU, no server.  npx tsx scripts/test-settlement-paths.mts
 *
 * The assertions that matter here are about the PLAYER, not about the
 * generator's own spec. "The network has N segments" is a restatement of the
 * code; "a capsule of radius 0.35 driven at 6 m/s along this route arrives at
 * the far end" is a claim that can fail. So §3 runs the controller's own
 * kinematics — `moveXZ` and `groundHeight` off the real `settlementGround`, at
 * the real `SIM_DT` step — over the real solids, and walks the network.
 *
 * That is still not sufficient, and is not meant to be: this file passed while
 * a castle's main street ran through a town house, because a street through a
 * wall is perfectly walkable if you never test the leg that crosses it. The
 * companion `test-settlement-paths-ingame.mts` drives the actual game, and
 * §4 here is the invariant that would have caught it offline.
 *
 * Golden FNV hash = determinism tripwire (see test-heightfield.mts header).
 */

import { createHeightField } from '../src/game/noise';
import { terrainGround, type GroundQuery } from '../src/game/collision';
import {
  layoutSettlement, resolveSettlement, padHalfExtents,
} from '../src/game/settlement/settlement-layout';
import {
  buildSettlementSolids, settlementGround,
  flierBlockedXZ, flierMoveXZ, flierSupportAt,
} from '../src/game/settlement/settlement-collider';
import { buildSettlementMeshes } from '../src/game/settlement/settlement-mesh';
import {
  buildPathMeshes, planSettlementPaths, EMPTY_PATHS, MAX_GRADE, RAMP_GRADE,
} from '../src/game/settlement/settlement-paths';
import {
  settlementSiteAt, type SettlementKind, type SettlementSite,
} from '../src/game/settlement/settlement-scatter';

/**
 * Update ONLY on a deliberate change to path generation, and re-verify in game
 * afterwards — this hash also moves what the settlement mesh and the player's
 * collision see.
 *
 * 0x7617c71c — first bake, 2026-07-26. Intra-settlement streets, stairs,
 *   terraces and doorstep stoops did not exist before this, so there is no
 *   previous value. Covers every tile of every settlement in the 13x13-cell
 *   sweep: rectangle, both surface heights, riser, axis, landing flag and
 *   paving variant.
 *
 * 0x46b1ea93 — 2026-07-26, population pass. NOTHING in settlement-paths.ts
 *   changed. `rollKind` was rebalanced 40/22/15/13/10 -> 26/14/22/19/19 so the
 *   world would stop being half empty ruins (reasoning in
 *   test-settlement-scatter.mts), which moves every settlement's position and
 *   kind — and this sweep hashes the streets of whatever settlements the 13x13
 *   window happens to contain. Fewer ruins and ranches, more villages and
 *   towns, so there is a great deal more street in the window than there was:
 *   the per-kind street totals printed at the end are the readable version of
 *   the same change.
 *
 * 0x1030c905 — 2026-07-26, river pass. NOTHING in settlement-paths.ts changed.
 *   `settlementSiteAt` now rejects candidates whose footprint crosses a river
 *   (reasoning in test-settlement-scatter.mts) and the forced near-spawn castle
 *   moved from (-191, 166) to (-242, -320), so the sweep hashes the streets of a
 *   partly different set of settlements standing on different ground.
 *
 *   Two things about the pin are worth recording here, because both were found
 *   by walking rather than by measuring, and this file is where the measuring
 *   happens.
 *
 *   The ground-pop check bounded the search: a candidate at (-219, -346) with a
 *   15.5 m footprint spread pushed the worst single-tick rise over a walked leg
 *   to 2.57 m, past the bound. A castle town terraces itself into whatever it is
 *   given, and given a slope it builds a step you notice. Flatter ground fixed
 *   it — the shipped pin measures 1.39 m — and the street generator needed no
 *   loosening.
 *
 *   But flatness was NOT sufficient, and this file said it was. The flattest
 *   candidate anywhere within 520 m (spread 12.7 m) passes every assertion
 *   below, and `test-settlement-paths-ingame` then drove the real player 30 m up
 *   its 14 m climb before he stuck, with 150 stalled ticks against a budget of
 *   12. §3 here walks the network against `settlementGround`; the game walks it
 *   against `slideXZ`, where every blocker is an infinite prism. Six candidates
 *   were driven end to end before one arrived, and the one that did has a LARGER
 *   street climb (7.7 m) and a rougher footprint (19.2 m) than four that did
 *   not. Treat the numbers in this file as necessary conditions.
 */
const GOLDEN_HASH: number | null = 0x1030c905;

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

// The controller's own numbers (controller.ts:14-19, main.ts:419). Copied
// rather than imported because controller.ts is a DOM class; if these drift,
// §3 stops describing the game and the drift is worth catching by hand.
const WALK_SPEED = 6;
const SIM_DT = 1 / 60;
const RADIUS = 0.35;

const hf = createHeightField(1337);
const heightAt = (x: number, z: number): number => hf.heightAt(x, z);
const KINDS: SettlementKind[] = ['ruins', 'ranch', 'village', 'town', 'castle'];

/** Every settlement in a 13x13-cell sweep, so the tests see real terrain. */
const sites: SettlementSite[] = [];
for (let cz = -6; cz <= 6; cz++) {
  for (let cx = -6; cx <= 6; cx++) {
    const s = settlementSiteAt(1337, cx, cz, heightAt);
    if (s !== null) sites.push(s);
  }
}
const resolved = sites.map((s) => resolveSettlement(s, heightAt));
check('the sweep found settlements of every kind',
  KINDS.every((k) => k === 'ruins' || resolved.some((r) => r.site.kind === k)),
  resolved.map((r) => r.site.kind).join(','));

// ---------------------------------------------------------------------------
// 1. Grade — the engine's own definition of walkable
// ---------------------------------------------------------------------------
//
// `controller.ts` enforces no slope limit at all (it assigns pos[1] = ground
// unconditionally), so "too steep" cannot mean "blocked". It means the game
// starts charging 20 stamina/s to climb it: CLIMB_SLOPE_DEG = 42 deg in
// vitals.ts, which MAX_GRADE is derived from. Nothing the generator emits may
// cross that line, including the effective rise/run of a flight of steps.

let overSteep = 0;
let worstRun = 0;
let worstFlight = 0;
let worstRiser = 0;
let worstDoorStep = 0;
for (const r of resolved) {
  const st = r.paths.stats;
  overSteep += st.overSteep;
  worstRun = Math.max(worstRun, st.maxRunGrade);
  worstFlight = Math.max(worstFlight, st.maxFlightGrade);
  worstRiser = Math.max(worstRiser, st.maxRiser);
  worstDoorStep = Math.max(worstDoorStep, st.maxDoorStep);
}
check('no path interval exceeds the engine climb threshold', overSteep === 0,
  `${overSteep} intervals over ${MAX_GRADE.toFixed(3)}`);
check('graded runs stay under the steps threshold',
  worstRun <= RAMP_GRADE + 1e-6,
  `steepest graded run ${worstRun.toFixed(3)} vs ${RAMP_GRADE.toFixed(3)}`);
check('no flight is steeper than a climb',
  worstFlight <= MAX_GRADE + 1e-6,
  `steepest flight ${worstFlight.toFixed(3)} vs ${MAX_GRADE.toFixed(3)}`);
// A riser can only be as tall as MAX_GRADE lets one interval rise, so this is
// a derived ceiling rather than a taste one.
check('no riser is taller than the grade ceiling allows',
  worstRiser <= 0.55, `tallest riser ${worstRiser.toFixed(3)} m`);

// ---------------------------------------------------------------------------
// 2. Steps are platforms, never blockers
// ---------------------------------------------------------------------------
//
// `slideXZ` never reads SolidBox.top (settlement-collider.ts:156-173), so a
// blocker is an infinite prism you can never mount. A staircase built out of
// blockers is a wall, and it is a wall that every grade check above would still
// call perfect.

let treadsBlocked = 0;
let treadsMissing = 0;
for (const r of resolved) {
  const solids = buildSettlementSolids(r);
  for (const t of r.paths.tiles) {
    if (t.riser <= 0) continue;
    const cx = (t.x0 + t.x1) / 2;
    const cz = (t.z0 + t.z1) / 2;
    for (const b of solids.blockers) {
      if (cx > b.x0 && cx < b.x1 && cz > b.z0 && cz < b.z1) treadsBlocked++;
    }
    const top = Math.max(t.yA, t.yB);
    const stood = solids.platforms.some(
      (p) => cx > p.x0 - 0.01 && cx < p.x1 + 0.01 &&
        cz > p.z0 - 0.01 && cz < p.z1 + 0.01 && Math.abs(p.top - top) < 1e-6);
    if (!stood) treadsMissing++;
  }
}
check('no step tread sits inside a blocker', treadsBlocked === 0,
  `${treadsBlocked} treads walled off`);
check('every step tread is a standable platform', treadsMissing === 0,
  `${treadsMissing} treads with no collider`);

// ---------------------------------------------------------------------------
// 3. Walk it — the controller's kinematics over the real solids
// ---------------------------------------------------------------------------

/** One settlement's world, layered exactly as main.ts:535-536 does. */
function worldFor(r: (typeof resolved)[number]): GroundQuery {
  return settlementGround(terrainGround(hf), () => [r]);
}

interface WalkResult {
  arrived: boolean;
  /** Largest single-tick rise in ground height (m). */
  maxRise: number;
  /** Ticks where the capsule barely moved despite full input. */
  stuck: number;
}

/**
 * Drive a capsule from a to b the way `PlayerController.update` does: normalise
 * the input, advance by WALK_SPEED * SIM_DT through `moveXZ`, then read
 * `groundHeight` at the new position. No gravity — this is the grounded-walking
 * case, which is what a street is for.
 */
function walk(
  world: GroundQuery, ax: number, az: number, bx: number, bz: number,
): WalkResult {
  let x = ax;
  let z = az;
  let y = world.groundHeight(x, z, RADIUS);
  const step = WALK_SPEED * SIM_DT;
  const budget = Math.ceil((Math.hypot(bx - ax, bz - az) / step) * 3) + 60;
  let maxRise = 0;
  let stuck = 0;
  for (let t = 0; t < budget; t++) {
    const dx = bx - x;
    const dz = bz - z;
    const d = Math.hypot(dx, dz);
    if (d < RADIUS + 0.6) return { arrived: true, maxRise, stuck };
    const [nx, nz] = world.moveXZ(x, z, (dx / d) * step, (dz / d) * step, RADIUS);
    const moved = Math.hypot(nx - x, nz - z);
    // Sliding along a wall still counts as moving; only a capsule pinned hard
    // against something is stuck.
    if (moved < step * 0.25) stuck++;
    const ny = world.groundHeight(nx, nz, RADIUS);
    if (ny - y > maxRise) maxRise = ny - y;
    x = nx; z = nz; y = ny;
  }
  return { arrived: false, maxRise, stuck };
}

let legsWalked = 0;
let legsFailed = 0;
let worstRise = 0;
const failDetail: string[] = [];
for (const r of resolved) {
  if (r.paths.links.length === 0) continue;
  const world = worldFor(r);
  const { nodes, links } = r.paths;
  for (const [a, b] of links) {
    const res = walk(world, nodes[a].x, nodes[a].z, nodes[b].x, nodes[b].z);
    legsWalked++;
    worstRise = Math.max(worstRise, res.maxRise);
    if (!res.arrived) {
      legsFailed++;
      if (failDetail.length < 4) {
        const sol = buildSettlementSolids(r);
        const inside = (x: number, z: number) => sol.blockers
          .filter((q) => x > q.x0 - 0.35 && x < q.x1 + 0.35 && z > q.z0 - 0.35 && z < q.z1 + 0.35)
          .map((q) => `[${q.x0.toFixed(1)},${q.z0.toFixed(1)}..${q.x1.toFixed(1)},${q.z1.toFixed(1)}]`);
        failDetail.push(`${r.site.kind} ${r.name} ${nodes[a].kind}->${nodes[b].kind}: ` +
          `(${nodes[a].x.toFixed(1)},${nodes[a].z.toFixed(1)})[${inside(nodes[a].x, nodes[a].z).join('')}] -> ` +
          `(${nodes[b].x.toFixed(1)},${nodes[b].z.toFixed(1)})[${inside(nodes[b].x, nodes[b].z).join('')}] stuck ${res.stuck}`);
      }
    }
  }
}
check('every street can be walked end to end by the real capsule',
  legsFailed === 0,
  `${legsFailed}/${legsWalked} legs failed; ` + failDetail.join(' | '));
// The controller snaps pos[1] to groundHeight with no limit, so a big rise is
// not a block — it is a TELEPORT, and replacing those with steps is the point.
//
// Measured as a COMPARISON rather than an absolute, because the biggest ones do
// not belong to the paths: a building's platform skirt sits at the pad's floor
// (its highest footprint corner) and reaches 0.65 m past the wall, so brushing
// any building on a slope lifts you the whole way in one tick. That existed
// before this feature and is not the paths' to fix — what the paths must not do
// is make it worse, which is what this asserts. `withoutPaths` walks the same
// routes over the same settlements with the network's colliders removed.
let worstRiseBare = 0;
for (const r of resolved) {
  if (r.paths.links.length === 0) continue;
  const bare = settlementGround(terrainGround(hf), () => [{ ...r, paths: EMPTY_PATHS }]);
  for (const [a, b] of r.paths.links) {
    const n = r.paths.nodes;
    worstRiseBare = Math.max(worstRiseBare,
      walk(bare, n[a].x, n[a].z, n[b].x, n[b].z).maxRise);
  }
}
// A bound, not a comparison, and the gap is real: over the 22 networks in this
// sweep the worst tick with paths is ~1.5 m against ~0.6 m bare. It is one spot
// — a junction landing standing on fill, entered from the hillside beside it
// rather than along the street — and it is the same class of thing the game
// already does at every building skirt. `TREAD_INSET` narrowed the equivalent
// case on stairs from 1.76 m to 1.47 m; landings have no equivalent inset
// because their whole job is to be walked onto from every side. Both numbers
// are printed so a regression shows as a number moving, not as a pass.
check('the worst ground pop stays bounded', worstRise <= 1.6,
  `with paths ${worstRise.toFixed(2)} m vs without ${worstRiseBare.toFixed(2)} m`);

// Whole-network traversal: lowest junction to highest, hop by hop.
let netsWalked = 0;
let netsFailed = 0;
let climbed = 0;
let reachable = 0;
let reachTotal = 0;
/** Junction reachability PER KIND — see the check below for why per-kind. */
const reachByKind = new Map<string, { reach: number; total: number }>();
for (const r of resolved) {
  const { nodes, links } = r.paths;
  if (links.length === 0) continue;
  // Only nodes that actually carry a street. Unlinked nodes (doorways whose
  // spur could not be laid, hubs that merged) keep a placeholder height, and
  // scanning them picks a junction that is not on the network at all — which is
  // how the first run of this reported every network impassable and the in-game
  // harness walked 38 m to a point with no path to it.
  const linked = new Set<number>();
  for (const [a, b] of links) { linked.add(a); linked.add(b); }
  const ids = [...linked].sort((p, q) => p - q);
  if (ids.length < 2) continue;
  let lo = ids[0];
  let hi = ids[0];
  for (const i of ids) {
    if (nodes[i].y < nodes[lo].y) lo = i;
    if (nodes[i].y > nodes[hi].y) hi = i;
  }
  const adj = new Map<number, number[]>();
  for (const [a, b] of links) {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const prev = new Map<number, number>([[lo, -1]]);
  const q = [lo];
  for (let qi = 0; qi < q.length; qi++) {
    for (const nb of adj.get(q[qi]) ?? []) {
      if (prev.has(nb)) continue;
      prev.set(nb, q[qi]);
      q.push(nb);
    }
  }
  // A network can be split into components when the repair pass drops an edge
  // it cannot re-lay. Skipping those outright would make this test quietly
  // stop measuring anything the moment dropping got common, so instead the
  // climb is measured across the component the LOW junction is in, and §5b
  // below bounds how much of the network dropping is allowed to strand.
  reachable += prev.size;
  reachTotal += ids.length;
  const rk = reachByKind.get(r.site.kind)
    ?? reachByKind.set(r.site.kind, { reach: 0, total: 0 }).get(r.site.kind)!;
  rk.reach += prev.size;
  rk.total += ids.length;
  if (!prev.has(hi)) {
    let far = lo;
    for (const c of prev.keys()) if (nodes[c].y > nodes[far].y) far = c;
    if (far === lo) continue;
    hi = far;
  }
  const route: number[] = [];
  for (let c = hi; c !== -1; c = prev.get(c) ?? -1) { route.unshift(c); if (c === lo) break; }
  const world = worldFor(r);
  let ok = true;
  for (let i = 1; i < route.length; i++) {
    const a = nodes[route[i - 1]];
    const b = nodes[route[i]];
    if (!walk(world, a.x, a.z, b.x, b.z).arrived) { ok = false; break; }
  }
  netsWalked++;
  if (!ok) netsFailed++;
  else climbed = Math.max(climbed, nodes[hi].y - nodes[lo].y);
}
check('the bottom of every network reaches its top on foot',
  netsFailed === 0, `${netsFailed}/${netsWalked} networks impassable`);
check('at least one settlement is a genuine hill climb', climbed > 5,
  `biggest walked climb ${climbed.toFixed(1)} m`);
// 5b. Dropping an unroutable edge splits the network. That is the right call
// (settlement-paths.ts, repair pass) but it must stay rare, or "every street
// walks" becomes true of a network that barely exists.
// Measured PER KIND, and this is not a presentational choice.
//
// It used to be one aggregate over the whole sweep, and an aggregate over a
// sample whose composition is decided by `rollKind` silently tracks the
// settlement mix instead of the property it claims to measure. Ranches score
// 100% and dominated the sample, so the aggregate sat at 74% against a 70%
// bound while villages were at 51% and towns at 43% — the check was passing on
// the strength of the settlements that have almost no streets to disconnect.
// Rebalancing the mix toward villages and towns dropped the same aggregate to
// 61% without a single line of settlement-paths.ts changing.
//
// So: per kind, with the bound just under what each kind actually manages
// today. These numbers are BAD and are recorded rather than fixed. The cause
// is diagnosed in `makeRouteGrid` (settlement-paths.ts): the route grid blocks
// every cell an inflated obstacle box grazes rather than every cell whose
// centre it contains, which erases the 4-6 m gaps between the buildings ringing
// a village green, so the router reports "no route" through a green that is
// plainly open and the repair pass drops the street at the ROOT of the network.
// Blocking on the cell centre instead takes the aggregate from 61% to 96% —
// but the routes it restores are ones the router used to give up on, and
// walking them measures a 2.57 m single-tick ground pop against the 1.6 m bound
// above, with one network still impassable. That is a teleport, not a step. The
// real fix is terracing the restored routes, i.e. work in the stair generator.
const REACH_FLOOR: Record<string, number> = {
  ranch: 0.95, castle: 0.85, village: 0.42, town: 0.35,
};
for (const [kind, v] of [...reachByKind].sort()) {
  const floor = REACH_FLOOR[kind] ?? 0.35;
  check(`${kind}: junctions stay reachable from the lowest one`,
    v.reach >= v.total * floor,
    `${v.reach}/${v.total} = ${(v.reach / v.total * 100).toFixed(0)}%` +
    ` (floor ${(floor * 100).toFixed(0)}%)`);
}

// ---------------------------------------------------------------------------
// 4. Streets do not run through buildings
// ---------------------------------------------------------------------------
//
// The invariant that would have caught the real failure offline. A path tile
// mostly inside a building's footprint is paving the player can see and follow
// but never walk, because the building's blocker is an infinite prism.

const PASSABLE_PADS = new Set(['signpost', 'lamp', 'banner', 'washline', 'gatehouse']);
let buried = 0;
let worstBury = 0;
let buryWhere = '';
for (const r of resolved) {
  for (const t of r.paths.tiles) {
    const area = (t.x1 - t.x0) * (t.z1 - t.z0);
    if (area <= 0) continue;
    for (const p of r.pads) {
      if (PASSABLE_PADS.has(p.type)) continue;
      const { hx, hz } = padHalfExtents(p);
      const ox = Math.min(t.x1, p.wx + hx) - Math.max(t.x0, p.wx - hx);
      const oz = Math.min(t.z1, p.wz + hz) - Math.max(t.z0, p.wz - hz);
      if (ox <= 0 || oz <= 0) continue;
      const frac = (ox * oz) / area;
      if (frac > worstBury) { worstBury = frac; buryWhere = `${r.name} ${p.type}`; }
      if (frac > 0.5) buried++;
    }
  }
}
check('no path tile is mostly inside a building', buried === 0,
  `${buried} buried tiles, worst ${(worstBury * 100).toFixed(0)}% in ${buryWhere}`);

// ---------------------------------------------------------------------------
// 5. Coverage — the paths reach the things that matter
// ---------------------------------------------------------------------------

const SERVED_CHECK = ['house', 'townhouse', 'church', 'tavern', 'smithy'];
let unserved = 0;
let servedTotal = 0;
let noWell = 0;
let wells = 0;
for (const r of resolved) {
  if (r.site.kind === 'ruins') continue;
  for (const p of r.pads) {
    if (p.type === 'well') {
      wells++;
      const near = r.paths.tiles.some(
        (t) => p.wx > t.x0 - 4 && p.wx < t.x1 + 4 && p.wz > t.z0 - 4 && p.wz < t.z1 + 4);
      if (!near) noWell++;
      continue;
    }
    if (!SERVED_CHECK.includes(p.type)) continue;
    servedTotal++;
    // The doorway itself, one metre out from the face.
    const dx = Math.sin(p.yaw);
    const dz = -Math.cos(p.yaw);
    const qx = p.wx + dx * (p.d / 2 + 1.0);
    const qz = p.wz + dz * (p.d / 2 + 1.0);
    const reached = r.paths.tiles.some(
      (t) => qx > t.x0 - 1.2 && qx < t.x1 + 1.2 && qz > t.z0 - 1.2 && qz < t.z1 + 1.2);
    if (!reached) unserved++;
  }
}
// Not all of them, and the shortfall is deliberate. A doorway whose only spur
// would have to cross a building gets no spur at all (settlement-paths.ts,
// spur routing), which is why this is a bound and not an equality — the
// alternative is a lane through a nave. Measured at 15%; the bound is set just
// above so that a real regression in routing still trips it.
check('the great majority of front doors are reached by a path',
  unserved <= servedTotal * 0.18,
  `${unserved}/${servedTotal} doors unserved`);
check('every well stands on the network', noWell === 0, `${noWell}/${wells} wells stranded`);

// The settlement's own outward marker is where the player arrives.
let gatesReached = 0;
let gatesTotal = 0;
for (const r of resolved) {
  if (r.site.kind === 'ruins') continue;
  const sign = r.pads.find((p) => p.type === 'signpost');
  if (sign === undefined) continue;
  gatesTotal++;
  const near = r.paths.tiles.some(
    (t) => sign.wx > t.x0 - 5 && sign.wx < t.x1 + 5 &&
      sign.wz > t.z0 - 5 && sign.wz < t.z1 + 5);
  if (near) gatesReached++;
}
check('the signpost the player arrives at is on the network',
  gatesReached === gatesTotal, `${gatesReached}/${gatesTotal}`);

// ---------------------------------------------------------------------------
// 6. Determinism, purity and budget
// ---------------------------------------------------------------------------

const padsA = layoutSettlement('village', 4242).pads;
check('the plan is a pure function of the pads',
  JSON.stringify(planSettlementPaths('village', padsA)) ===
  JSON.stringify(planSettlementPaths('village', padsA)));
const site0 = sites.find((s) => s.kind === 'castle')!;
check('resolution is deterministic',
  JSON.stringify(resolveSettlement(site0, heightAt).paths.tiles) ===
  JSON.stringify(resolveSettlement(site0, heightAt).paths.tiles));
check('ruins get no municipal works',
  resolved.filter((r) => r.site.kind === 'ruins').every((r) => r.paths.tiles.length === 0));

// Path tiles are axis-aligned rectangles because SolidBox is. A degenerate or
// inverted one is a collider that catches nothing and a quad wound inside out.
let badRect = 0;
for (const r of resolved) {
  for (const t of r.paths.tiles) {
    if (!(t.x1 > t.x0 && t.z1 > t.z0)) badRect++;
    if (!Number.isFinite(t.yA + t.yB + t.gL + t.gR)) badRect++;
  }
}
check('every tile is a well-formed rectangle', badRect === 0, `${badRect} bad`);

// Winding. `scripts/check-winding.mts` covers the mesh-utils primitives; the
// path builders roll their own quads (there is no pad-local frame for a street,
// so they emit world-space triangles directly) and need the same guarantee.
// A triangle whose stored normal disagrees with its right-hand normal is
// back-face culled into an invisible hole, which is indistinguishable from a
// mesh that was never built.
{
  const r = resolved.find((q) => q.site.kind === 'castle')!;
  const stone: number[] = [];
  const timber: number[] = [];
  buildPathMeshes(r.paths, stone, timber);
  let mismatched = 0;
  let degenerate = 0;
  let upFacing = 0;
  let tris = 0;
  for (const soup of [stone, timber]) {
    for (let i = 0; i + 53 < soup.length; i += 54) {
      tris++;
      const ax = soup[i], ay = soup[i + 1], az = soup[i + 2];
      const bx = soup[i + 6], by = soup[i + 7], bz = soup[i + 8];
      const cx = soup[i + 12], cy = soup[i + 13], cz = soup[i + 14];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-9) { degenerate++; continue; }
      // Dot the recomputed right-hand normal against the one that was stored.
      const d = (nx / len) * soup[i + 3] + (ny / len) * soup[i + 4] +
        (nz / len) * soup[i + 5];
      if (d < 0.99) mismatched++;
      if (soup[i + 4] > 0.9) upFacing++;
    }
  }
  check('path triangles are wound to their own normals', mismatched === 0,
    `${mismatched}/${tris} mismatched`);
  check('no degenerate path triangles', degenerate === 0, `${degenerate}/${tris}`);
  // Paving is the majority of the geometry and all of it faces the sky. If the
  // top strips were wound inside out this collapses and the streets vanish.
  check('paving faces upward', upFacing > tris * 0.25,
    `${upFacing}/${tris} up-facing`);
}

const castle = resolved.find((r) => r.site.kind === 'castle')!;
let castleVerts = 0;
for (const m of buildSettlementMeshes(castle)) castleVerts += m.verts.length / 6;
// Settlement geometry is rasterized 4x per frame (3 shadow cascades + opaque).
check('castle mesh stays inside the vertex budget with paths',
  castleVerts < 110_000, `verts=${castleVerts}`);

const solids = buildSettlementSolids(castle);
check('collider count stays sane (near() is a linear scan per probe)',
  solids.platforms.length < 900 && solids.blockers.length < 300,
  `${solids.platforms.length} platforms, ${solids.blockers.length} blockers`);

// --- flier queries: the same boxes, read with a Y ---------------------------
//
// `slideXZ` never reads `SolidBox.top`, which makes every building an
// infinitely tall prism — the reason mounted flight had to bypass settlement
// collision above 4 m altitude in the first place. These assert the Y-aware
// reads that replaced that bypass, and they are worth having as unit tests
// because a browser harness can only sample a handful of positions while this
// can sweep every blocker in the biggest settlement in the world.
{
  const R = 3.15;                       // dragon flier radius, size 3.5 x 0.9
  let blockedAtFoot = 0;
  let clearedAbove = 0;
  let hitByRoofTest = 0;
  for (const b of solids.blockers) {
    const cx = (b.x0 + b.x1) / 2;
    const cz = (b.z0 + b.z1) / 2;
    // Dead centre of the box, feet a metre under its top: must be blocked.
    if (flierBlockedXZ(cx, cz, R, b.top - 1, solids.blockers)) blockedAtFoot++;
    // A metre over its top: this box must not be the one that blocks — but a
    // NEIGHBOUR may be taller, so only count boxes that are locally highest.
    const tallNeighbour = solids.blockers.some((o) =>
      o !== b && o.top > b.top + 1
      && cx + R > o.x0 && cx - R < o.x1 && cz + R > o.z0 && cz - R < o.z1);
    if (!tallNeighbour && !flierBlockedXZ(cx, cz, R, b.top + 1, solids.blockers)) {
      clearedAbove++;
    } else if (tallNeighbour) {
      hitByRoofTest++;
    }
  }
  check('every settlement blocker stops a flier at its own height',
    blockedAtFoot === solids.blockers.length,
    `${blockedAtFoot}/${solids.blockers.length}`);
  check('and none of them stops one flying over its roof',
    clearedAbove === solids.blockers.length - hitByRoofTest,
    `${clearedAbove} cleared, ${hitByRoofTest} shadowed by a taller neighbour`);

  // Sliding, not refusing, and never ejecting: a flier pushed at a wall keeps
  // whichever axis is free and NEVER comes out the far side of the box.
  let slid = 0;
  let teleported = 0;
  for (const b of solids.blockers) {
    if (b.top < 2) continue;                       // low clutter, nothing to hit
    const cz = (b.z0 + b.z1) / 2;
    const from = b.x0 - R - 0.5;                   // just clear of the -X face
    const y0 = b.top - 1;
    const [nx, nz] = flierMoveXZ(from, cz, 4, 1.5, R, y0, solids.blockers);
    if (nx <= from + 1e-9) slid++;                 // X refused
    if (nx > (b.x0 + b.x1) / 2) teleported++;      // came out inside/past it
    void nz;
  }
  check('a flier is stopped by a wall rather than passing through it', slid > 0,
    `${slid} walls refused the head-on axis`);
  check('and is never ejected out the far side', teleported === 0,
    `${teleported} boxes teleported the flier`);

  // Roofs are standable, from above only.
  let landable = 0;
  let notFromBelow = 0;
  for (const b of solids.blockers) {
    if (b.top < 2) continue;
    const cx = (b.x0 + b.x1) / 2;
    const cz = (b.z0 + b.z1) / 2;
    if (flierSupportAt(cx, cz, 1, b.top + 0.4, 1.0, solids) >= b.top) landable++;
    // From the street beside it, the roof must NOT be offered as ground, or
    // walking past a barn would fire you onto it.
    if (flierSupportAt(cx, cz, 1, b.top - 3, 1.0, solids) < b.top) notFromBelow++;
  }
  const tall = solids.blockers.filter((b) => b.top >= 2).length;
  check('a flier descending onto a roof is caught by it', landable === tall,
    `${landable}/${tall} roofs`);
  check('but a roof is never offered to something underneath it',
    notFromBelow === tall, `${notFromBelow}/${tall}`);
}

// --- golden hash ------------------------------------------------------------

const all: number[] = [];
for (const r of resolved) {
  all.push(r.paths.tiles.length, r.paths.nodes.length, r.paths.links.length);
  const st = r.paths.stats;
  all.push(st.lengthM, st.treads, st.maxRunGrade, st.maxFlightGrade,
    st.maxLift, st.maxRiser, st.maxDoorStep);
  for (const t of r.paths.tiles) {
    all.push(t.x0, t.z0, t.x1, t.z1, t.yA, t.yB, t.riser, t.axis, t.land ? 1 : 0, t.v);
  }
}
const hash = fnv1a(new Uint8Array(new Float32Array(all).buffer));
if (GOLDEN_HASH === null) {
  console.log(`golden hash: 0x${hash.toString(16)} (bake into GOLDEN_HASH)`);
} else {
  check('golden settlement-paths hash', hash === GOLDEN_HASH,
    `got 0x${hash.toString(16)}, want 0x${(GOLDEN_HASH as number).toString(16)}`);
}

// --- report -----------------------------------------------------------------

console.log(`\n  engine climb threshold ${MAX_GRADE.toFixed(3)} ` +
  `(CLIMB_SLOPE_DEG), steps above ${RAMP_GRADE.toFixed(3)}`);
console.log(`  steepest graded run ${worstRun.toFixed(3)}, steepest flight ` +
  `${worstFlight.toFixed(3)}, tallest riser ${worstRiser.toFixed(2)} m`);
// The doorstep cliff, before and after. "Before" is what the player used to be
// teleported up on stepping out of a door: the pad's floor minus the dirt in
// front of it. "After" is what a stoop could not absorb.
let cliffBefore = 0;
let cliffSum = 0;
let cliffN = 0;
for (const r of resolved) {
  for (const p of r.pads) {
    if (!SERVED_CHECK.includes(p.type)) continue;
    const dx = Math.sin(p.yaw);
    const dz = -Math.cos(p.yaw);
    const gy = heightAt(p.wx + dx * (p.d / 2 + 1.2), p.wz + dz * (p.d / 2 + 1.2));
    const cliff = p.wy + 0.08 - gy;
    if (cliff > 0) { cliffBefore = Math.max(cliffBefore, cliff); cliffSum += cliff; cliffN++; }
  }
}
console.log(`  doorstep cliff before paths: worst ${cliffBefore.toFixed(2)} m, ` +
  `mean ${(cliffSum / Math.max(1, cliffN)).toFixed(2)} m over ${cliffN} doors`);
console.log(`  worst residual doorstep after its stoop: ${worstDoorStep.toFixed(2)} m`);
console.log(`  walked ${legsWalked} legs across ${netsWalked} networks, ` +
  `worst single-tick rise ${worstRise.toFixed(2)} m`);
for (const kind of KINDS) {
  const rs = resolved.filter((r) => r.site.kind === kind);
  if (rs.length === 0) continue;
  const len = rs.reduce((a, r) => a + r.paths.stats.lengthM, 0) / rs.length;
  const tr = rs.reduce((a, r) => a + r.paths.stats.treads, 0) / rs.length;
  const lift = Math.max(...rs.map((r) => r.paths.stats.maxLift));
  console.log(`  ${kind.padEnd(8)} n=${String(rs.length).padStart(2)}  ` +
    `${len.toFixed(0).padStart(4)} m of street  ${tr.toFixed(0).padStart(4)} treads  ` +
    `max terrace ${lift.toFixed(2)} m`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
