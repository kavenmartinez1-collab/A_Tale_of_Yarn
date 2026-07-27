/**
 * Deterministic tests for Castle Vhaeron: the layout, the mesh budget, and —
 * the one that matters — a reachability PROOF over the real collider.
 *
 *   npx tsx scripts/test-castle-layout.mts
 *
 * ## Why the flood runs the real collider
 *
 * "Reachable" in a cell-grid dungeon means "the cells are adjacent". That is
 * not the question here. The question is whether a 0.35 m capsule driven by
 * `PlayerController` can actually walk from the prison cell to the wilderness,
 * given that the controller has NO step-up limit (it snaps to whatever
 * `groundHeight` returns) and the entire step limit lives inside
 * `CastleCollider`. So the flood below calls `collider.moveXZ` and
 * `collider.groundHeight` exactly as the controller does, with the same radius,
 * the same probe height and the same head clearance. If this passes, a player
 * can walk it. If it were a graph search over the layout rects, it would prove
 * nothing.
 */

import { createHeightField } from '../src/game/noise';
import { terrainGround } from '../src/game/collision';
import {
  buildCastleLayout, fitBreachRamp, LEVEL_Y, OUTER_HX, OUTER_HZ,
  STEP_UP, PLAYER_H, ARENA_Y, TOWER_BASE_Y, WALL_WALK,
} from '../src/game/castle/castle-layout';
import type { CastleLayout, CastleMarker } from '../src/game/castle/castle-layout';
import { CastleCollider } from '../src/game/castle/castle-collider';
import { buildCastleMesh, castleEmittedPieces, castleVertexCount } from '../src/game/castle/castle-mesh';
import {
  createCastleState, stepCastleState, castleHostile,
  patrolPose, LEAVE_RADIUS, RETURN_RADIUS, PATROL_R, PATROL_PERIOD,
} from '../src/game/castle/castle-state';
import { CASTLE_SEED, CASTLE_SITE, resolveCastleSite } from '../src/game/castle/castle-site';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- build ----------------------------------------------------------------

const hf = createHeightField(1337);
const terrain = terrainGround(hf);
const site = resolveCastleSite(hf);
const layout = buildCastleLayout(CASTLE_SEED);
const fitted = fitBreachRamp(layout,
  (lx, lz) => hf.heightAt(site.origin[0] + lx, site.origin[2] + lz) - site.origin[1]);
const collider = new CastleCollider(layout, site.origin, terrain);

console.log(`site (${CASTLE_SITE[0]}, ${CASTLE_SITE[1]})  baseY ${site.origin[1].toFixed(2)}  `
  + `terrain ${site.minTerrain.toFixed(1)}..${site.maxTerrain.toFixed(1)}  `
  + `breach ramp ${fitted.run.toFixed(0)} m run, ${(-fitted.drop).toFixed(1)} m drop`);

// --- 1. determinism -------------------------------------------------------

{
  const a = buildCastleLayout(CASTLE_SEED);
  const b = buildCastleLayout(CASTLE_SEED);
  check('determinism: same solids', JSON.stringify(a.solids) === JSON.stringify(b.solids));
  check('determinism: same supports', JSON.stringify(a.supports) === JSON.stringify(b.supports));
  check('determinism: same pieces', JSON.stringify(a.pieces) === JSON.stringify(b.pieces));
  check('determinism: same lights', JSON.stringify(a.lights) === JSON.stringify(b.lights));
  const c = buildCastleLayout(CASTLE_SEED + 1);
  check('seed changes decoration', JSON.stringify(a.pieces) !== JSON.stringify(c.pieces));
}

// --- 2. structural sanity -------------------------------------------------

check('has solids', layout.solids.length > 100, `${layout.solids.length}`);
check('has supports', layout.supports.length > 20, `${layout.supports.length}`);
check('has ceilings', layout.ceilings.length > 5, `${layout.ceilings.length}`);
check('has lights', layout.lights.length > 20, `${layout.lights.length}`);

{
  let bad = 0;
  for (const s of layout.solids) {
    if (s.x1 <= s.x0 || s.z1 <= s.z0 || s.y1 <= s.y0) bad++;
  }
  check('no degenerate solids', bad === 0, `${bad} degenerate`);
}
{
  let bad = 0;
  for (const s of layout.supports) if (s.x1 <= s.x0 || s.z1 <= s.z0) bad++;
  check('no degenerate supports', bad === 0, `${bad}`);
}

// Every ramp must be gentle enough that one 1/60 s sprint step (10 m/s →
// 0.167 m) never rises more than STEP_UP. A ramp steeper than that reads as a
// wall to the collider and the player sticks half way up.
{
  let steepest = 0;
  let bad = 0;
  for (const s of layout.supports) {
    const g = Math.max(Math.abs(s.dydx), Math.abs(s.dydz));
    if (g > steepest) steepest = g;
    if (g * (10 / 60) > STEP_UP) bad++;
  }
  check('every ramp is walkable at sprint speed', bad === 0,
    `${bad} too steep; steepest gradient ${steepest.toFixed(2)} `
    + `(rise/step ${(steepest * 10 / 60).toFixed(3)} m vs limit ${STEP_UP})`);
}

// Headroom: every ceiling must clear the floor it roofs by more than the
// player's height, or the head clamp pins them into the floor.
{
  let bad = 0;
  for (const c of layout.ceilings) {
    // Find the highest floor strictly below this ceiling in the same column.
    let floor = -Infinity;
    for (const s of layout.supports) {
      if (s.dydx !== 0 || s.dydz !== 0) continue;
      if (s.x1 <= c.x0 || s.x0 >= c.x1 || s.z1 <= c.z0 || s.z0 >= c.z1) continue;
      if (s.y < c.y - 0.05 && s.y > floor) floor = s.y;
    }
    if (floor > -Infinity && c.y - floor < PLAYER_H + 0.1) bad++;
  }
  check('every roofed area has player headroom', bad === 0, `${bad} too low`);
}

// --- 3. mesh budget -------------------------------------------------------

const parts = buildCastleMesh(layout);
const verts = castleVertexCount(parts);
const bytes = parts.reduce((n, p) => n + p.verts.byteLength, 0);
console.log(`mesh: ${parts.length} palettes, ${verts.toLocaleString()} verts, `
  + `${(bytes / 1024 / 1024).toFixed(2)} MB`);
check('mesh has geometry', verts > 20_000, `${verts}`);
// Rasterised 4x per frame (3 shadow cascades + opaque) with no per-cascade
// culling, so this ceiling is really "<= 60k triangles of real work".
check('mesh vertex budget (<= 180k)', verts <= 180_000, `${verts}`);
// One draw call per palette. Raised from 8 to 16 when the castle stopped being
// entirely palette 0: the whole building shaded as MAT.STONE, which on the
// surface path is the terrain's boulder texture, so a 26 m keep read as an
// extrusion of the hillside. Ashlar, basalt, slate, two felts, glass and bone
// are six more buckets and six more draws, against a settlement that already
// spends eleven on a village.
check('mesh palettes <= 16', parts.length <= 16, `${parts.length}`);
{
  let bad = 0;
  for (const p of parts) if (p.verts.length % (6 * 3) !== 0) bad++;
  check('every palette is a whole number of triangles', bad === 0, `${bad}`);
}

// --- 4. THE REACHABILITY PROOF -------------------------------------------

const R = 0.35;          // controller RADIUS
const STEP = 0.45;       // flood step, metres
const CELL = 0.45;       // XZ quantisation for the visited set
const YQ = 0.5;          // Y quantisation — distinct levels are distinct nodes
const MAX_FALL = 4.0;    // a bigger drop is one-way; don't treat it as an edge

const DIRS: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, 0.7071], [-0.7071, -0.7071],
];

interface Node { x: number; z: number; y: number }

function key(x: number, z: number, y: number): string {
  return `${Math.round(x / CELL)},${Math.round(z / CELL)},${Math.round(y / YQ)}`;
}

/**
 * The flood has to be bounded or it walks off into the open world forever —
 * outside the footprint `groundHeight` falls through to terrain, which has no
 * edges. Bound generously enough to include the whole breach ramp and a good
 * margin of the hillside past it, so "the breach leads to open ground" is
 * still a real claim about walkable terrain and not an artefact of the fence.
 */
const BOUND_X0 = site.origin[0] - 78;
const BOUND_X1 = site.origin[0] + OUTER_HX + fitted.run + 34;
const BOUND_Z0 = site.origin[2] - 78;
const BOUND_Z1 = site.origin[2] + 78;
function inBounds(x: number, z: number): boolean {
  return x >= BOUND_X0 && x <= BOUND_X1 && z >= BOUND_Z0 && z <= BOUND_Z1;
}

/**
 * Flood the walkable space using the real collider.
 *
 * `oneWayFalls` mirrors reality: you can drop off a ledge but not climb back,
 * so the forward flood allows falls and the backward flood (below) does not.
 * Comparing the two is how "can the player get somewhere they cannot leave"
 * gets answered.
 */
function flood(start: Node, allowFalls: boolean, budget = 400_000): Map<string, Node> {
  const seen = new Map<string, Node>();
  const queue: Node[] = [start];
  seen.set(key(start.x, start.z, start.y), start);
  let steps = 0;
  while (queue.length > 0 && steps < budget) {
    const cur = queue.pop()!;
    steps++;
    for (const [dx, dz] of DIRS) {
      collider.probeY = () => cur.y;
      const [nx, nz] = collider.moveXZ(cur.x, cur.z, dx * STEP, dz * STEP, R);
      if (!inBounds(nx, nz)) continue;
      const moved = Math.hypot(nx - cur.x, nz - cur.z);
      if (moved < STEP * 0.55) continue;             // blocked or barely slid
      collider.probeY = () => cur.y;
      const ny = collider.groundHeight(nx, nz, R);
      const rise = ny - cur.y;
      if (rise > STEP_UP) continue;                  // too tall to step up
      if (!allowFalls && rise < -STEP_UP) continue;  // cannot climb back up
      if (rise < -MAX_FALL) continue;                // a cliff, not a walkway
      collider.probeY = () => ny;
      const ceil = collider.ceilingHeight(nx, nz);
      if (ceil < ny + PLAYER_H) continue;            // cannot fit
      const k = key(nx, nz, ny);
      if (seen.has(k)) continue;
      const n = { x: nx, z: nz, y: ny };
      seen.set(k, n);
      queue.push(n);
    }
  }
  if (steps >= budget) console.error(`  (flood hit the ${budget} step budget)`);
  return seen;
}

/** Nearest flooded node to a world point, and its distance. */
function nearest(seen: Map<string, Node>, x: number, y: number, z: number):
{ d: number; n: Node | null } {
  let best = Infinity;
  let bn: Node | null = null;
  for (const n of seen.values()) {
    const d = Math.hypot(n.x - x, n.z - z) + Math.abs(n.y - y) * 1.5;
    if (d < best) { best = d; bn = n; }
  }
  return { d: best, n: bn };
}

function worldOf(l: CastleLayout, id: string): [number, number, number] {
  const m = l.markers.get(id);
  if (m === undefined) throw new Error(`no marker "${id}"`);
  return [m.x + site.origin[0], m.y + site.origin[1], m.z + site.origin[2]];
}

const spawnW: Node = (() => {
  const [x, , z] = worldOf(layout, 'spawn');
  const y = site.origin[1] + LEVEL_Y[0];
  return { x, z, y };
})();

console.log('flooding from the prison cell...');
const t0 = Date.now();
const reach = flood(spawnW, true);
console.log(`  ${reach.size.toLocaleString()} nodes in ${Date.now() - t0} ms`);

check('flood found the castle', reach.size > 5000, `${reach.size} nodes`);

/** Assert a named marker is reachable within `tol` metres. */
function reachable(label: string, id: string, tol = 2.2): void {
  const [x, y, z] = worldOf(layout, id);
  const { d, n } = nearest(reach, x, y, z);
  check(`reachable: ${label}`, d <= tol,
    `nearest walkable node is ${d.toFixed(2)} m away`
    + (n ? ` (at y ${(n.y - site.origin[1]).toFixed(1)}, want ${(y - site.origin[1]).toFixed(1)})` : ''));
}

reachable('the starter chest', 'chest');
reachable('foot of the undercroft stair', 'undercroftStairFoot');
reachable('head of the undercroft stair', 'undercroftStairHead');
reachable('keep level 1 hall', 'L1hall');
reachable('front courtyard', 'frontCourt');
reachable('back courtyard', 'backCourt');
reachable('THE BREACH', 'breach', 3.0);
reachable('foot of the breach ramp', 'breachFoot', 3.0);
reachable('open ground beyond the castle', 'outside', 4.0);
reachable('keep level 2 hall', 'L2hall');
reachable('keep level 3 / throne room', 'L3hall');
reachable('the throne', 'throne', 3.0);
reachable('keep roof', 'keepRoof', 3.0);
reachable('the tower arena', 'arena', 3.0);
reachable('the dragon perch', 'dragonPerch', 3.0);

// Every wing on every level must be enterable — that is the "4 doors per
// level" requirement, and a door that fails to punch through its wall is
// exactly the kind of silent error this catches.
for (let lv = 1; lv <= 3; lv++) {
  for (let w = 0; w < 4; w++) reachable(`L${lv} wing ${w}`, `L${lv}wing${w}`, 2.6);
}

// The breach must lead to genuinely open terrain, not a shelf.
{
  const [ox, , oz] = worldOf(layout, 'outside');
  const far = 60;
  let openDirs = 0;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const px = ox + Math.cos(a) * far;
    const pz = oz + Math.sin(a) * far;
    if (hf.heightAt(px, pz) > 0.5) openDirs++;
  }
  check('breach leads to open land', openDirs >= 5, `${openDirs}/8 directions above water`);
  check('breach exit is outside the curtain wall',
    ox - site.origin[0] > OUTER_HX + 4,
    `${(ox - site.origin[0]).toFixed(1)} vs wall at ${OUTER_HX}`);
}

// --- 5. no one-way traps --------------------------------------------------

// Flood backward from open ground with falls disallowed. Anything in the
// forward set that is NOT in the backward set is somewhere you can get into
// and cannot walk out of. A few nodes are legitimate (the bottom of the
// breach ramp reached by jumping off the wall), so this is reported as a
// fraction rather than demanded to be zero — but the escape route itself must
// be fully two-way.
{
  const outNode = (() => {
    const [x, , z] = worldOf(layout, 'breachFoot');
    const c2 = collider;
    c2.probeY = () => site.origin[1];
    const y = c2.groundHeight(x, z, R);
    return { x, z, y };
  })();
  const back = flood(outNode, false);
  console.log(`  backward flood: ${back.size.toLocaleString()} nodes`);
  // The escape route in reverse: can you walk from outside back to the chest?
  for (const id of ['breach', 'L1hall', 'undercroftStairHead', 'chest']) {
    const [x, y, z] = worldOf(layout, id);
    const { d } = nearest(back, x, y, z);
    check(`escape route is two-way at: ${id}`, d <= 3.0, `${d.toFixed(2)} m`);
  }
}

// --- 5b. no stair spills you into a pit ----------------------------------

// The generic form of a bug that cost two playthroughs: a stairwell opening cut
// WIDER than the ramp it serves. The strip between the ramp edge and the
// opening edge has no surface, no wall, and a long drop, so walking off the
// side of a flight posts you through the floor below. A flood test does not
// see it, because the flood also finds the legitimate route off the stair.
//
// The invariant: standing anywhere on a ramp, every direction you can actually
// move in must lead somewhere you can stand — not a hole.
{
  let checked = 0;
  const bad: string[] = [];
  for (const s of layout.supports) {
    if (s.dydx === 0 && s.dydz === 0) continue;
    for (let t = 0.15; t <= 0.85; t += 0.1) {
      for (let u = 0.15; u <= 0.85; u += 0.2) {
        const lx = s.x0 + (s.x1 - s.x0) * (s.dydx !== 0 ? t : u);
        const lz = s.z0 + (s.z1 - s.z0) * (s.dydz !== 0 ? t : u);
        const y = s.y + (lx - s.x0) * s.dydx + (lz - s.z0) * s.dydz;
        const wx = lx + site.origin[0];
        const wz = lz + site.origin[2];
        const wy = y + site.origin[1];
        for (const [dx, dz] of DIRS) {
          collider.probeY = () => wy;
          const [nx, nz] = collider.moveXZ(wx, wz, dx * 0.45, dz * 0.45, R);
          if (Math.hypot(nx - wx, nz - wz) < 0.2) continue;    // wall stopped us
          collider.probeY = () => wy;
          const g = collider.groundHeight(nx, nz, R);
          checked++;
          if (wy - g > MAX_FALL) {
            bad.push(`ramp y=${(y).toFixed(1)} at (${lx.toFixed(1)},${lz.toFixed(1)}) `
              + `-> drop ${(wy - g).toFixed(1)} m`);
          }
        }
      }
    }
  }
  check('no ramp edge opens onto a fall', bad.length === 0,
    `${bad.length}/${checked} samples: ${bad.slice(0, 3).join('; ')}`);
}

// --- 5c. no ramp climbs through a drawn surface ---------------------------

// The other half of 5b, and the one that shipped: an opening cut into the
// COLLISION but not into the GEOMETRY. There was a 131 x 119 m authored slab
// across the whole plinth at y -1.5..-0.5 duplicating the derived courtyard
// floor, and it kept none of the courtyard's holes. Climbing out of the
// undercroft you looked up at a sealed black ceiling for the whole flight and
// then walked through it — "the floors above look like a closed ceiling until
// you can walk through", straight from play. Section 5b passed the entire time,
// because collision was right; only the picture was wrong.
//
// So: sweep the walking surface of every ramp and assert that the player's own
// capsule never ends up inside a drawn box. Ramp slabs are the climb itself and
// arches/pyramids/spires/wedges fill far less than their AABB, so only `box`
// and `bevel` are trusted to mean "solid here".
{
  const drawn = castleEmittedPieces(layout)
    .filter((p) => p.kind === 'box' || p.kind === 'bevel');
  const bad: string[] = [];
  let samples = 0;
  // The two wall-walk ramps used to be excluded here, with the diagnosis in the
  // comment: the curtain was one `wall()` from 0 to WALL_H at full thickness
  // while the deck it carried was a Support at WALL_WALK, so the walkway was
  // 1.4 m inside its own wall and both flights climbed into rock. The curtain
  // now stops at WALL_WALK and the flights run up the COURTYARD side of the
  // inner face rather than through the wall's own footprint, so the sweep
  // covers every ramp in the castle again. Nothing is excluded.
  for (const s of layout.supports) {
    if (s.dydx === 0 && s.dydz === 0) continue;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      for (let u = 0.2; u <= 0.8; u += 0.3) {
        const lx = s.x0 + (s.x1 - s.x0) * (s.dydx !== 0 ? t : u);
        const lz = s.z0 + (s.z1 - s.z0) * (s.dydz !== 0 ? t : u);
        const y = s.y + (lx - s.x0) * s.dydx + (lz - s.z0) * s.dydz;
        // Knee, chest and eye height. A margin off each face so a box merely
        // TOUCHING the walking plane (every ramp rests on its own landing) is
        // not read as a box the player is inside.
        for (const dy of [0.4, 1.0, PLAYER_H - 0.1]) {
          samples++;
          for (const p of drawn) {
            const m = 0.02;
            if (lx > p.x0 + m && lx < p.x1 - m && lz > p.z0 + m && lz < p.z1 - m
              && y + dy > p.y0 + m && y + dy < p.y1 - m) {
              bad.push(`(${lx.toFixed(1)},${(y + dy).toFixed(1)},${lz.toFixed(1)}) `
                + `inside pal${p.pal} ${p.kind} y[${p.y0.toFixed(2)},${p.y1.toFixed(2)}]`);
              break;
            }
          }
        }
      }
    }
  }
  check('no ramp climbs through drawn geometry', bad.length === 0,
    `${bad.length}/${samples} samples: ${[...new Set(bad)].slice(0, 3).join('; ')}`);
}

// --- 5c-bis. no drawn mass stands in walkable space without collision ------

// Section 5c generalised off the ramps and onto every surface in the castle,
// because the fault it catches is not a ramp fault: it is the standing fault of
// this file, DRAWN and COLLIDED coming from two sources and drifting. The
// wall-walk was one instance. So were the forty-odd others this found on its
// first run — the courtyard braziers, the dragon's skull, the throne, the
// dragon's perch (5.2 m square, in the arena), the keep roof's own parapet
// teeth, which ride an ellipse over rectangular shell walls and so overhang the
// roof deck by half a tooth each with a 24 m drop behind them. Every one of
// them was a piece of the castle the player walked straight through.
//
// The rule, and it is the collider's own rule, not a new one:
//
//   if the player can STAND at (x, z) — no Solid across [feet + STEP_UP,
//   feet + PLAYER_H] — then no drawn box may occupy that span either.
//
// Two qualifications keep it honest rather than merely strict. Relief is
// exempt by construction: the test point is inset by the player's own radius,
// so a string course or a banner the capsule brushes is not a hit, and only
// masses the player's CENTRE ends up inside are. And the standing height at a
// column is the HIGHEST support there, since that is the one surface the player
// is actually on — testing all of them reports a plinth against the floor it
// stands on.
{
  const drawn = castleEmittedPieces(layout)
    .filter((p) => p.kind === 'box' || p.kind === 'bevel');
  const flat = layout.supports.filter((s) => s.dydx === 0 && s.dydz === 0);
  const bad = new Map<string, string>();
  let samples = 0;
  for (const p of drawn) {
    const x0 = p.x0 + R; const x1 = p.x1 - R;
    const z0 = p.z0 + R; const z1 = p.z1 - R;
    if (x1 <= x0 || z1 <= z0) continue;
    const sx = Math.max(0.4, (x1 - x0) / 12);
    const sz = Math.max(0.4, (z1 - z0) / 12);
    for (let x = x0; x <= x1 + 1e-9; x += sx) {
      for (let z = z0; z <= z1 + 1e-9; z += sz) {
        let sy = -Infinity;
        for (const s of flat) {
          if (x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue;
          if (s.y > sy) sy = s.y;
        }
        if (sy === -Infinity) continue;
        const lo = sy + STEP_UP + 1e-6;
        const hi = sy + PLAYER_H;
        samples++;
        if (p.y1 <= lo || p.y0 >= hi) continue;
        let solid = false;
        for (const q of layout.solids) {
          if (x < q.x0 || x > q.x1 || z < q.z0 || z > q.z1) continue;
          if (q.y1 <= lo || q.y0 >= hi) continue;
          solid = true; break;
        }
        if (solid) continue;
        bad.set(`pal${p.pal} ${p.kind} y[${p.y0.toFixed(1)},${p.y1.toFixed(1)}]`,
          `standing at (${x.toFixed(1)},${sy.toFixed(1)},${z.toFixed(1)})`);
      }
    }
  }
  check('no drawn mass stands where the player can stand', bad.size === 0,
    `${bad.size} pieces over ${samples} samples: `
    + [...bad].slice(0, 4).map(([k, v]) => `${k} ${v}`).join('; '));
}

// --- 5d. the wall-walk is a walk ------------------------------------------

// The reachability flood already says every square of the deck is reachable.
// That is not the claim. The claim is that a player can WALK the circuit: get
// on it from a courtyard flight, keep going round, and never stop or drop.
//
// The flood cannot make that claim because it expands in every direction from
// every node — it is happy with a route that threads a 40 cm gap once and never
// notices that the walker has to be inside a merlon to use it. This drives the
// collider the way `PlayerController` does, one 0.1 m step at a time along a
// ring of markers read out of the layout, and fails on the two things a player
// would report: STUCK (the step went nowhere) and FELL (the ground under the
// next step was not the deck).
//
// The breach is the deliberate hole in that ring, so it is asserted as a hole:
// the walk must stop at the rubble on both sides and must NOT cross.
{
  const m = (id: string): CastleMarker => {
    const k = layout.markers.get(id);
    if (k === undefined) throw new Error(`marker "${id}" is missing`);
    return k;
  };
  /**
   * Walk from one marker to another. Returns [reached, endX, endZ, endY, why].
   *
   * Feet start at the FROM marker's own height, not at the deck: the flights
   * begin on the courtyard, and seeding y at WALL_WALK makes the first step of
   * every climb read as a 7.6 m fall.
   */
  const walk = (a: CastleMarker, b: CastleMarker):
  [boolean, number, number, number, string] => {
    const from: [number, number] = [a.x, a.z];
    const to: [number, number] = [b.x, b.z];
    let x = from[0]; let z = from[1];
    let y = site.origin[1] + a.y;
    let stuck = 0;
    for (let step = 0; step < 3000; step++) {
      const dx = to[0] - x; const dz = to[1] - z;
      const d = Math.hypot(dx, dz);
      if (d < 0.5) return [true, x, z, y, ''];
      collider.probeY = () => y;
      const [nx, nz] = collider.moveXZ(site.origin[0] + x, site.origin[2] + z,
        (dx / d) * 0.1, (dz / d) * 0.1, R);
      const moved = Math.hypot(nx - site.origin[0] - x, nz - site.origin[2] - z);
      x = nx - site.origin[0]; z = nz - site.origin[2];
      collider.probeY = () => y;
      const g = collider.groundHeight(site.origin[0] + x, site.origin[2] + z, R);
      if (g < y - 0.5) return [false, x, z, g, `fell ${(y - g).toFixed(1)} m`];
      y = g;
      if (moved < 0.02) {
        if (++stuck > 3) return [false, x, z, y, `stuck ${d.toFixed(1)} m short`];
      } else stuck = 0;
    }
    return [false, x, z, y, 'never arrived'];
  };

  // The full ring, anticlockwise from the west stair head. Every leg is a
  // straight run down one lane or one gallery leg — the corner markers sit at
  // the junction, which is what makes turning the corner two legs and not a
  // diagonal through eleven metres of tower.
  const ring: [string, string][] = [
    ['wallHeadW', 'wallDeckW'], ['wallDeckW', 'wallNW'],
    ['wallNW', 'wallGate'], ['wallGate', 'wallNE'],
    ['wallNE', 'wallBreachN'],
    ['wallDeckW', 'wallSW'], ['wallSW', 'wallSE'],
    ['wallSE', 'wallBreachS'],
    ['wallSE', 'wallDeckE'], ['wallDeckE', 'wallHeadE'],
  ];
  const brokeAt: string[] = [];
  for (const [a, b] of ring) {
    const [ok, ex, ez, ey, why] = walk(m(a), m(b));
    if (!ok) {
      brokeAt.push(`${a}->${b}: ${why} at (${ex.toFixed(1)},${ez.toFixed(1)}) y ${(ey - site.origin[1]).toFixed(1)}`);
    }
  }
  check('the wall-walk circuit is walkable end to end', brokeAt.length === 0,
    brokeAt.slice(0, 3).join('; '));

  // Both flights, climbed from the courtyard with the step limit enforced —
  // the same rule the controller cannot enforce for itself.
  for (const side of ['W', 'E']) {
    const [ok, , ez, ey, why] = walk(m(`wallStair${side}`), m(`wallHead${side}`));
    check(`the ${side} flight climbs from the courtyard to the deck`,
      ok && Math.abs(ey - site.origin[1] - WALL_WALK) < 0.2,
      `${why} ending z ${ez.toFixed(1)} y ${(ey - site.origin[1]).toFixed(2)}`);
  }

  // ...and the breach is still a hole. If this ever passes, someone has healed
  // the east wall and the escape route with it.
  const [crossed, , cz] = walk(m('wallNE'), m('wallSE'));
  check('the wall-walk does NOT cross the breach', !crossed,
    `crossed to z ${cz.toFixed(1)}`);
}

// --- 6. anti-void: nowhere in the footprint drops the player out of the world

{
  let worst = Infinity;
  let bad = 0;
  // Only inside the plinth: outside it, terrain is the floor and being below
  // the undercroft is simply "standing at the bottom of the hill".
  for (let z = -56; z <= 56; z += 3.5) {
    for (let x = -62; x <= 62; x += 3.5) {
      const wx = site.origin[0] + x;
      const wz = site.origin[2] + z;
      // Probe from deep below every floor — the rescue case.
      collider.probeY = () => site.origin[1] - 60;
      const g = collider.groundHeight(wx, wz, R);
      if (g < worst) worst = g;
      if (g < site.origin[1] + LEVEL_Y[0] - 1) bad++;
    }
  }
  check('no column drops below the undercroft floor', bad === 0,
    `${bad} columns; lowest rescue ${(worst - site.origin[1]).toFixed(1)} local`);
}

// The keep's storeys must actually be distinct: probing at the hall centre
// from each level's height must return that level's floor, not another's.
{
  const cx = site.origin[0];
  const cz = site.origin[2];
  let ok = 0;
  for (let lv = 0; lv < 4; lv++) {
    const want = site.origin[1] + LEVEL_Y[lv];
    collider.probeY = () => want;
    const g = collider.groundHeight(cx, cz, R);
    if (Math.abs(g - want) < 0.05) ok++;
    else console.error(`  level ${lv}: probe at ${LEVEL_Y[lv]} got ${(g - site.origin[1]).toFixed(2)}`);
  }
  check('all four keep storeys resolve independently', ok === 4, `${ok}/4`);
  // ...and the tower arena on top of them.
  collider.probeY = () => site.origin[1] + ARENA_Y;
  const ga = collider.groundHeight(cx, cz + 3, R);
  check('arena floor resolves', Math.abs(ga - (site.origin[1] + ARENA_Y)) < 0.05,
    `${(ga - site.origin[1]).toFixed(2)} vs ${ARENA_Y}`);
  collider.probeY = () => site.origin[1] + TOWER_BASE_Y;
  const gr = collider.groundHeight(cx + 12, cz, R);
  check('keep roof resolves', Math.abs(gr - (site.origin[1] + TOWER_BASE_Y)) < 0.05,
    `${(gr - site.origin[1]).toFixed(2)} vs ${TOWER_BASE_Y}`);
}

// --- 7. the alarm state machine ------------------------------------------

{
  const st = createCastleState();
  const kx = site.origin[0];
  const kz = site.origin[2];
  check('starts dormant', st.alarm === 'dormant');
  check('starts non-hostile', !castleHostile(st));

  // Wandering the castle does not trip it.
  for (let i = 0; i < 50; i++) {
    stepCastleState(st, kx + (i % 40) - 20, kz + (i % 30) - 15, kx, kz, false, i * 0.1);
  }
  check('walking around inside stays dormant', st.alarm === 'dormant');

  // Stepping just outside the wall is "escaped" but not "departed".
  stepCastleState(st, kx + OUTER_HX + 20, kz, kx, kz, true, 10);
  check('outside the wall sets escaped', st.escaped);
  check('outside the wall alone does NOT trip the alarm', st.alarm === 'dormant',
    `alarm=${st.alarm}`);

  // Going properly away.
  const t1 = stepCastleState(st, kx + LEAVE_RADIUS + 20, kz, kx, kz, true, 30);
  check('leaving trips departed', t1 === 'departed' && st.alarm === 'departed');
  check('departed is still non-hostile', !castleHostile(st));

  // Wandering out there does not escalate.
  for (let i = 0; i < 30; i++) {
    stepCastleState(st, kx + LEAVE_RADIUS + 40 + i, kz + i, kx, kz, true, 40 + i);
  }
  check('staying away stays departed', st.alarm === 'departed');

  // Coming back.
  const t2 = stepCastleState(st, kx + RETURN_RADIUS - 10, kz, kx, kz, true, 90);
  check('returning trips hunting', t2 === 'hunting' && st.alarm === 'hunting');
  check('hunting is hostile', castleHostile(st));
  check('transition timestamp recorded', st.changedAt === 90);

  // Terminal: leaving again does not calm it down.
  stepCastleState(st, kx + LEAVE_RADIUS + 200, kz, kx, kz, true, 120);
  check('hunting is terminal', st.alarm === 'hunting');

  // Hysteresis: the two radii must not overlap or the alarm can chatter.
  check('leave/return radii are hysteretic', LEAVE_RADIUS > RETURN_RADIUS + 30);
}

// --- 8. the dragon's circuit ---------------------------------------------

{
  const kx = site.origin[0];
  const ky = site.origin[1] + ARENA_Y;
  const kz = site.origin[2];
  let minR = Infinity;
  let maxR = 0;
  let minClear = Infinity;
  for (let i = 0; i <= 120; i++) {
    const t = (i / 120) * PATROL_PERIOD;
    const p = patrolPose(t, kx, ky, kz);
    const r = Math.hypot(p.x - kx, p.z - kz);
    minR = Math.min(minR, r);
    maxR = Math.max(maxR, r);
    minClear = Math.min(minClear, p.y - (site.origin[1] + ARENA_Y));
  }
  check('patrol is a circle', Math.abs(maxR - minR) < 0.01, `${minR.toFixed(1)}..${maxR.toFixed(1)}`);
  check('patrol radius clears the walls', minR > OUTER_HX + 10,
    `${minR.toFixed(1)} vs ${OUTER_HX}`);
  check('patrol flies above the arena', minClear > 8, `${minClear.toFixed(1)} m over the arena`);
  const a = patrolPose(0, kx, ky, kz);
  const b = patrolPose(PATROL_PERIOD, kx, ky, kz);
  check('patrol closes the loop',
    Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 0.01);
  check('patrol is deterministic in t',
    JSON.stringify(patrolPose(7.5, kx, ky, kz)) === JSON.stringify(patrolPose(7.5, kx, ky, kz)));
  check('patrol radius constant matches', Math.abs(minR - PATROL_R) < 0.01);
}

// --- 9. site sanity -------------------------------------------------------

{
  check('castle stands above the highest terrain in its footprint',
    site.origin[1] > site.maxTerrain, `baseY ${site.origin[1]} vs max ${site.maxTerrain}`);
  check('castle is above sea level', site.origin[1] - 8.5 > 0,
    `undercroft floor at ${(site.origin[1] + LEVEL_Y[0]).toFixed(1)}`);
  check('breach ramp lands within 46 m', fitted.run <= 46, `${fitted.run}`);
  check('breach ramp is not a cliff', Math.abs(fitted.drop) / fitted.run < 0.7,
    `${(Math.abs(fitted.drop) / fitted.run).toFixed(2)} gradient`);
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
