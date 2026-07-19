/**
 * Tests for settlement collision — pure AABB solids + the GroundQuery
 * wrapper. Pure CPU. Run:  npx tsx scripts/test-settlement-collider.mts
 */

import type { GroundQuery } from '../src/game/collision';
import {
  buildSettlementSolids, slideXZ, settlementGround,
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

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
