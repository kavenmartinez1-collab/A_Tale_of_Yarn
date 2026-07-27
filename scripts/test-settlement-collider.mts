/**
 * Tests for settlement collision — pure AABB solids + the GroundQuery
 * wrapper. Pure CPU. Run:  npx tsx scripts/test-settlement-collider.mts
 */

import type { GroundQuery } from '../src/game/collision';
import {
  buildSettlementSolids, slideXZ, settlementGround, indexSolids,
  creatureGroundAt, creatureBlockedXZ,
} from '../src/game/settlement/settlement-collider';
import {
  resolveSettlement, padHalfExtents,
} from '../src/game/settlement/settlement-layout';
import {
  SETTLEMENT_RADIUS, type SettlementSite,
} from '../src/game/settlement/settlement-scatter';

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

// Flat world at y = 10.
const flat = (_x: number, _z: number) => 10;
const base: GroundQuery = {
  groundHeight: () => 10,
  ceilingHeight: () => Infinity,
  moveXZ: (x, z, dx, dz) => [x + dx, z + dz],
};

const site: SettlementSite = {
  kind: 'town', x: 0, z: 0, y: 10,
  radius: SETTLEMENT_RADIUS.town, seed: 4242,
};
const resolved = resolveSettlement(site, flat);
const solids = buildSettlementSolids(resolved);

check('town produces blockers', solids.blockers.length >= 10,
  `blockers=${solids.blockers.length}`);
check('town produces platforms (skirts)', solids.platforms.length >= 10,
  `platforms=${solids.platforms.length}`);

const house = resolved.pads.find((p) => p.type === 'house')!;
const { hx, hz } = padHalfExtents(house);
const R = 0.35; // player capsule radius

// --- slideXZ against one house ----------------------------------------------

const wall = solids.blockers.find((b) =>
  Math.abs((b.x0 + b.x1) / 2 - house.wx) < 1e-6
  && Math.abs((b.z0 + b.z1) / 2 - house.wz) < 1e-6)!;

// Approach from -x: start clear of the wall, step straight at it.
const sx = wall.x0 - R - 0.5;
const [nx1, nz1] = slideXZ(sx, house.wz, 2, 0, R, [wall]);
check('walking into a wall clamps at the face', Math.abs(nx1 - (wall.x0 - R)) < 1e-9,
  `nx=${nx1}, want ${wall.x0 - R}`);
check('blocked move keeps z', nz1 === house.wz);

// Slide along the wall: x clamps, z still advances.
const [nx2, nz2] = slideXZ(sx, house.wz, 2, 1.5, R, [wall]);
check('sliding along a wall works', Math.abs(nx2 - (wall.x0 - R)) < 1e-9 && nz2 === house.wz + 1.5,
  `nx=${nx2} nz=${nz2}`);

// Free movement away from anything.
const [nx3, nz3] = slideXZ(house.wx + 50, house.wz + 50, 1, 1, R, solids.blockers);
check('free movement is untouched', nx3 === house.wx + 51 && nz3 === house.wz + 51);

// --- GroundQuery wrapper -----------------------------------------------------

const world = settlementGround(base, () => [resolved]);

// Standing beside the house (inside the skirt): platform height wins.
const skirtH = world.groundHeight(house.wx - hx - 0.1, house.wz, R);
check('platform skirt is standable', Math.abs(skirtH - (house.wy + 0.08)) < 1e-9,
  `h=${skirtH}, want ${house.wy + 0.08}`);
check('open ground stays terrain height',
  world.groundHeight(house.wx + 200, house.wz, R) === 10);

// moveXZ through the wrapper: blocked into the house, free far away.
const [mx] = world.moveXZ(sx, house.wz, 2, 0, R);
check('wrapper blocks entering a building', Math.abs(mx - (wall.x0 - R)) < 1e-9,
  `mx=${mx}`);
const [fx, fz] = world.moveXZ(500, 500, 3, -2, R);
check('wrapper passes through far from settlements', fx === 503 && fz === 498);

// Well blocks too (low but solid).
const wellPad = resolved.pads.find((p) => p.type === 'well')!;
const [wx1] = world.moveXZ(wellPad.wx - 0.75 - R - 0.3, wellPad.wz, 1, 0, R);
check('well ring blocks movement', wx1 < wellPad.wx - 0.7,
  `wx=${wx1} well at ${wellPad.wx}`);

// Signposts never block.
const sign = resolved.pads.find((p) => p.type === 'signpost')!;
const [gx] = world.moveXZ(sign.wx - 1, sign.wz, 2, 0, R);
check('signpost pole does not block', gx === sign.wx + 1);

// ---------------------------------------------------------------------------
// Creature queries — the Y-aware pair wildlife uses (settlement-collider.ts)
// ---------------------------------------------------------------------------
//
// Animals stood on the raw heightfield, so they walked through skirts and
// terraces and came out running under the town. These are the queries that fix
// it, and what is checked here is the distinction that makes them different
// from the player's: a step up is standable, a terrace face is not.
{
  const idx = indexSolids(buildSettlementSolids(resolved));
  const CR = 0.45;              // a deer-sized radius (animal-ai.ts: size*0.45)
  const skirtTop = house.wy + 0.08;

  // Beside the house, feet on the terrain: the skirt is a step up, so it is
  // where the animal stands.
  const onSkirt = creatureGroundAt(house.wx - hx - 0.1, house.wz, CR, 10, 10, idx);
  check('creature stands on a platform skirt', Math.abs(onSkirt - skirtTop) < 1e-9,
    `got ${onSkirt}, want ${skirtTop}`);

  // Open ground far away falls through to the terrain it was handed.
  check('creature ground falls through to terrain outside the town',
    creatureGroundAt(house.wx + 200, house.wz, CR, 10, 10, idx) === 10);
  check('creature ground respects the terrain it is given',
    creatureGroundAt(house.wx + 200, house.wz, CR, 41, 41, idx) === 41);

  // A platform more than a step above the feet is scenery, not ground — this is
  // the whole difference from the player's plain Math.max, which would snap the
  // animal onto a retaining wall it never climbed.
  const high = indexSolids({
    blockers: [],
    platforms: [{ x0: -2, z0: -2, x1: 2, z1: 2, top: 13 }],
  });
  check('a terrace out of step range is not standable',
    creatureGroundAt(0, 0, CR, 10, 10, high) === 10);
  check('the same terrace IS standable from on top of it',
    creatureGroundAt(0, 0, CR, 12.8, 10, high) === 13);

  // Blocking is Y-aware: a wall stops the animal, low rubble does not.
  check('a building blocks a creature',
    creatureBlockedXZ(house.wx, house.wz, CR, 10, idx.blockerGrid));
  check('open ground does not block a creature',
    !creatureBlockedXZ(house.wx + 200, house.wz, CR, 10, idx.blockerGrid));
  const lowRubble = indexSolids({
    blockers: [{ x0: -2, z0: -2, x1: 2, z1: 2, top: 10.4 }],
    platforms: [],
  });
  check('rubble inside the step budget does not block',
    !creatureBlockedXZ(0, 0, CR, 10, lowRubble.blockerGrid));
  check('the same box a metre taller does block',
    creatureBlockedXZ(0, 0, CR, 9.2, lowRubble.blockerGrid));

  // Cost. This runs per animal per sim step, so the number matters more than
  // the fact that it passes.
  const P = idx.platforms.length, B = idx.blockers.length;
  const N = 200_000;
  let sink = 0;
  let t = performance.now();
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    sink += creatureGroundAt(Math.cos(a) * 30, Math.sin(a) * 30, CR, 10, 10, idx);
  }
  const groundNs = ((performance.now() - t) * 1e6) / N;
  t = performance.now();
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    if (creatureBlockedXZ(Math.cos(a) * 30, Math.sin(a) * 30, CR, 10, idx.blockerGrid)) sink++;
  }
  const blockNs = ((performance.now() - t) * 1e6) / N;
  void sink;
  console.log(`  creature queries on a ${site.kind}: ${P} platforms, ${B} blockers`);
  console.log(`    creatureGroundAt   ${groundNs.toFixed(0)} ns/call`);
  console.log(`    creatureBlockedXZ  ${blockNs.toFixed(0)} ns/call`);
  check('creatureGroundAt is cheap enough for per-entity per-tick use',
    groundNs < 2000, `${groundNs.toFixed(0)} ns`);
  check('creatureBlockedXZ is cheap enough for per-entity per-tick use',
    blockNs < 2000, `${blockNs.toFixed(0)} ns`);

  // The number above is a flat town. The load that actually matters is a castle
  // town on a slope, where every street tile is a terrace step and the platform
  // list is an order of magnitude longer — this is the case the grid exists for.
  const slope = (x: number, z: number) => 10 + x * 0.09 + z * 0.05;
  const castleSite: SettlementSite = {
    kind: 'castle', x: 0, z: 0, y: 10,
    radius: SETTLEMENT_RADIUS.castle, seed: 90210,
  };
  const castle = indexSolids(
    buildSettlementSolids(resolveSettlement(castleSite, slope)));
  let cSink = 0;
  let ct = performance.now();
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const rr = 10 + (i % 55);
    cSink += creatureGroundAt(Math.cos(a) * rr, Math.sin(a) * rr, CR,
      slope(Math.cos(a) * rr, Math.sin(a) * rr), 0, castle);
  }
  const castleNs = ((performance.now() - ct) * 1e6) / N;
  void cSink;
  console.log(`  creature queries on a terraced castle town: `
    + `${castle.platforms.length} platforms, ${castle.blockers.length} blockers`);
  console.log(`    creatureGroundAt   ${castleNs.toFixed(0)} ns/call`);
  console.log(`    (unindexed this would scan all ${castle.platforms.length} boxes; `
    + `the 8 m grid cell holds a handful)`);
  check('creatureGroundAt stays cheap in the worst settlement in the world',
    castleNs < 2000, `${castleNs.toFixed(0)} ns over ${castle.platforms.length} platforms`);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
