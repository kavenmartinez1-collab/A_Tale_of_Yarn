/**
 * Tests for the people on the roads.
 * Pure CPU — no GPU, no DOM. Run: npx tsx scripts/test-road-travellers.mts
 *
 * These test the properties that could each be silently false while the
 * traveller count looked perfectly healthy:
 *
 *  - EXACTLY ONCE. A party is emitted by the settlement cell its station falls
 *    in and by no other. If that ever slips, the same person is generated twice
 *    with two ids, and the world quietly doubles its population every time the
 *    player walks past a cell boundary.
 *  - ON THE ROAD. The NPC AI walks the straight line between waypoints, so a
 *    waypoint list that is correct in every other respect still marches people
 *    through the verge on every bend.
 *  - NO HOME. `homePadIndex === -1` is the single thing keeping travellers out
 *    of the indoor/arena machinery. If one ever gets a home index it names a
 *    pad of a settlement it has nothing to do with.
 */

import { createHeightField } from '../src/game/noise';
import { sharedRoadNetwork, HALF_TRUNK } from '../src/game/world/roads';
import { travellersInCell, isTravellerId, ROAD_PLACE } from '../src/game/world/road-travellers';
import { SCELL } from '../src/game/settlement/settlement-scatter';

const WORLD_SEED = 1337;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; return; }
  failed++;
  console.error(`FAIL: ${name}${detail !== '' ? ` — ${detail}` : ''}`);
}

const hf = createHeightField(WORLD_SEED);
const roads = sharedRoadNetwork(WORLD_SEED, hf);

// A 10x10-cell sweep. Kept modest because each cell resolves road domains and
// the domain cache is 24 deep — a bigger window measures cache thrash, not
// travellers.
const R = 5;
const all: ReturnType<typeof travellersInCell> = [];
const perCell = new Map<string, number>();
for (let cz = -R; cz < R; cz++) {
  for (let cx = -R; cx < R; cx++) {
    const t = travellersInCell(WORLD_SEED, cx, cz, roads);
    perCell.set(`${cx},${cz}`, t.length);
    for (const n of t) all.push(n);
  }
}

check('the roads are populated', all.length > 40, `${all.length} travellers`);
check('the roads are not a crowd', all.length < 600, `${all.length} travellers`);

// ---------------------------------------------------------------------------
// 1. Emitted exactly once
// ---------------------------------------------------------------------------

const ids = new Set(all.map((n) => n.id));
check('every traveller id is unique across the whole sweep',
  ids.size === all.length, `${ids.size} ids for ${all.length} travellers`);

check('traveller ids are recognisable as travellers',
  all.every((n) => isTravellerId(n.id)), all[0]?.id ?? 'none');
check('traveller ids cannot collide with a settler\'s',
  all.every((n) => !n.id.startsWith('npc_')));
// main.ts derives an NPC's social circle from everyone sharing its id stem up
// to the last underscore, and sorts that circle by Number() of the tail.
check('the id tail is a number, as the roster sort assumes',
  all.every((n) => Number.isFinite(Number(n.id.slice(n.id.lastIndexOf('_') + 1)))));

// ---------------------------------------------------------------------------
// 2. Determinism, and independence from who asked
// ---------------------------------------------------------------------------

{
  const a = JSON.stringify(travellersInCell(WORLD_SEED, 2, -3, roads));
  const b = JSON.stringify(travellersInCell(WORLD_SEED, 2, -3, roads));
  check('the same cell twice gives the same people', a === b);

  // A cold network must agree with a warm one: the caches are caches of a pure
  // function, so evicting them may not change a single traveller.
  const cold = sharedRoadNetwork(WORLD_SEED + 0, createHeightField(WORLD_SEED));
  const c = JSON.stringify(travellersInCell(WORLD_SEED, 2, -3, cold));
  check('a cold road network gives the same people', a === c);

  // Compared over a sweep, not one cell: a different seed moves the ROADS as
  // well as the people, so any single cell can legitimately come back empty in
  // both worlds and a point comparison passes on `[] === []`.
  const otherRoads = sharedRoadNetwork(WORLD_SEED + 1, createHeightField(WORLD_SEED + 1));
  const otherIds = new Set<string>();
  for (let cz = -3; cz < 3; cz++) {
    for (let cx = -3; cx < 3; cx++) {
      for (const n of travellersInCell(WORLD_SEED + 1, cx, cz, otherRoads)) {
        otherIds.add(`${n.id}@${Math.round(n.wx)},${Math.round(n.wz)}`);
      }
    }
  }
  const mineIds = new Set(all.map((n) => `${n.id}@${Math.round(n.wx)},${Math.round(n.wz)}`));
  let shared = 0;
  for (const id of otherIds) if (mineIds.has(id)) shared++;
  check('a different seed gives different people',
    otherIds.size > 0 && shared === 0,
    `${shared} of ${otherIds.size} identical`);
}

// Every traveller's station belongs to the cell that emitted it. This is the
// property that makes "emitted exactly once" true by construction rather than
// by a dedupe pass that could be removed.
{
  let strays = 0;
  for (let cz = -R; cz < R; cz++) {
    for (let cx = -R; cx < R; cx++) {
      for (const n of travellersInCell(WORLD_SEED, cx, cz, roads)) {
        // `x`/`z` are the offset from the party station, so subtracting them
        // recovers the station the cell claimed.
        const sx = n.wx - n.x;
        const sz = n.wz - n.z;
        if (Math.floor(sx / SCELL) !== cx || Math.floor(sz / SCELL) !== cz) strays++;
      }
    }
  }
  check('every party is owned by the cell its station falls in', strays === 0,
    `${strays} strays`);
}

// ---------------------------------------------------------------------------
// 3. They are on the road, and so is everywhere they are walking to
// ---------------------------------------------------------------------------

{
  let worstSpawn = 0;
  let worstWaypoint = 0;
  let worstChord = 0;
  for (const n of all) {
    const here = roads.nearestRoad(n.wx, n.wz, 300);
    if (here !== null && here.d > worstSpawn) worstSpawn = here.d;
    for (const wp of n.wwaypoints) {
      const at = roads.nearestRoad(wp.x, wp.z, 300);
      if (at !== null && at.d > worstWaypoint) worstWaypoint = at.d;
    }
    // The AI walks the CHORD between consecutive waypoints. On a bend the
    // chord cuts the corner, and at the first spacing this shipped with (30 m)
    // it cut it by 6.8 m — through the verge of a road 2-3 m wide. Sampling the
    // midpoint of each leg is what that failure looks like as a number.
    for (let i = 0; i + 1 < n.wwaypoints.length; i++) {
      const mx = (n.wwaypoints[i].x + n.wwaypoints[i + 1].x) / 2;
      const mz = (n.wwaypoints[i].z + n.wwaypoints[i + 1].z) / 2;
      const at = roads.nearestRoad(mx, mz, 300);
      if (at !== null && at.d > worstChord) worstChord = at.d;
    }
  }
  // Paved half-width is 2-3 m and the surface mask feathers 1.5 m past that.
  check('travellers spawn on the paving', worstSpawn <= HALF_TRUNK + 1.5,
    `worst ${worstSpawn.toFixed(2)} m off`);
  check('every waypoint is on the paving', worstWaypoint <= HALF_TRUNK + 1.5,
    `worst ${worstWaypoint.toFixed(2)} m off`);
  check('the walked line between waypoints stays on the verge at worst',
    worstChord <= 5, `worst chord midpoint ${worstChord.toFixed(2)} m off`);
}

// The waypoint list must be a palindrome, or the cycle's wrap walks the last
// point back to the first in a straight line — off the road and through
// whatever the road was bending around.
{
  let notPalindrome = 0;
  let tooFew = 0;
  for (const n of all) {
    const w = n.waypoints;
    if (w.length < 3) { tooFew++; continue; }
    // A,B,C,D,C,B — reading the list forward from index 1 and backward from
    // the end must agree.
    for (let i = 1; i * 2 < w.length; i++) {
      const j = w.length - i;
      if (j <= i) break;
      if (Math.abs(w[i].x - w[j].x) > 1e-6 || Math.abs(w[i].z - w[j].z) > 1e-6) {
        notPalindrome++;
        break;
      }
    }
  }
  check('every route is a there-and-back palindrome', notPalindrome === 0,
    `${notPalindrome} of ${all.length}`);
  check('every traveller has a route worth walking', tooFew === 0, `${tooFew}`);
}

// ---------------------------------------------------------------------------
// 4. They belong to nowhere
// ---------------------------------------------------------------------------

check('no traveller has a home pad',
  all.every((n) => n.homePadIndex === -1));
check('every traveller belongs to the road, not a settlement',
  all.every((n) => n.settlementName === ROAD_PLACE));
check('travellers are named', all.every((n) => n.name.length > 0));
check('travellers hold only the four established roles',
  all.every((n) => ['farmer', 'villager', 'merchant', 'guard'].includes(n.role)),
  [...new Set(all.map((n) => n.role))].join(','));

// ---------------------------------------------------------------------------
// 5. Company, and density
// ---------------------------------------------------------------------------

{
  const parties = new Map<string, number>();
  for (const n of all) {
    const p = n.id.slice(0, n.id.lastIndexOf('_'));
    parties.set(p, (parties.get(p) ?? 0) + 1);
  }
  const sizes = [...parties.values()];
  check('people travel alone and in company',
    sizes.some((s) => s === 1) && sizes.some((s) => s > 1),
    `sizes ${[...new Set(sizes)].sort().join(',')}`);
  check('no party is a crowd', Math.max(...sizes) <= 3, `${Math.max(...sizes)}`);

  // What lands in npcRuntimes is the 3x3 cell window around the player, so that
  // is the number to bound rather than the world total.
  let worst = 0;
  for (let cz = -R + 1; cz < R - 1; cz++) {
    for (let cx = -R + 1; cx < R - 1; cx++) {
      let n = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) n += perCell.get(`${cx + dx},${cz + dz}`) ?? 0;
      }
      if (n > worst) worst = n;
    }
  }
  check('the busiest 3x3 cell window stays a sane number of runtimes',
    worst <= 80, `${worst} travellers live at once`);
  console.log(`  ${all.length} travellers in ${parties.size} parties over ` +
    `${(R * 2) ** 2} cells; busiest live window ${worst}`);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
