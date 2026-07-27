/**
 * Tests for NPCs having an inside to their buildings.
 * Pure CPU — no GPU, no DOM, no server.
 * Run: npx tsx scripts/test-npc-indoors.mts
 *
 * These test the JOIN and the GEOMETRY, which is where this feature can
 * silently fail:
 *
 *  - The join: an NPC's (settlementName, homePadIndex) has to name the same
 *    building the door does. If it drifts, nobody is ever home and the feature
 *    just quietly does nothing — no crash, no failing assertion elsewhere.
 *  - The geometry: a standing spot has to be somewhere a person could really
 *    stand. Inside a bed, inside a wall, or blocking the only door all look
 *    fine in a unit test that only counts spots.
 */

import {
  spawnSettlementNpcs,
  resolveNpcs,
} from '../src/game/npc/npc-spawn';
import { layoutSettlement } from '../src/game/settlement/settlement-layout';
import {
  generateBuildingInterior,
  standingSpots,
  reachableFloorCells,
} from '../src/game/building/building-interior';
import { isEnterablePad } from '../src/game/building/building-pads';
import type { SettlementKind } from '../src/game/settlement/settlement-scatter';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; return; }
  failed++;
  console.log(`FAIL: ${name}${detail !== '' ? ` — ${detail}` : ''}`);
}

const KINDS: SettlementKind[] = ['ranch', 'village', 'town', 'castle'];
const SEEDS = [1337, 22, 90210, 5, 777, 41234];

// ---------------------------------------------------------------------------
// 1. The join: every home index names a real, inhabitable pad
// ---------------------------------------------------------------------------

let withHome = 0;
let withEnterableHome = 0;
let total = 0;

for (const kind of KINDS) {
  for (const seed of SEEDS) {
    const layout = layoutSettlement(kind, seed);
    const npcs = spawnSettlementNpcs(kind, seed, layout);
    for (const npc of npcs) {
      total++;
      if (npc.homePadIndex < 0) continue;
      withHome++;
      check('home index in range',
        npc.homePadIndex < layout.pads.length,
        `${kind}/${seed} ${npc.id} → pad ${npc.homePadIndex} of ${layout.pads.length}`);
      const pad = layout.pads[npc.homePadIndex];

      // The home must be the pad they were actually placed at the door of.
      // If these drift apart, an NPC withdraws into a building they were never
      // standing outside — which reads as teleporting across the village.
      const dx = Math.sin(pad.yaw), dz = -Math.cos(pad.yaw);
      const doorX = pad.x + dx * (pad.d / 2 + 1.6);
      const doorZ = pad.z + dz * (pad.d / 2 + 1.6);
      const guards = npc.role === 'guard';
      if (!guards) {
        check('spawn stands at their own door',
          Math.hypot(npc.x - doorX, npc.z - doorZ) < 3.0,
          `${kind}/${seed} ${npc.id} ${Math.hypot(npc.x - doorX, npc.z - doorZ).toFixed(2)} m off`);
      }
      if (isEnterablePad(pad.type)) withEnterableHome++;
    }
  }
}

check('most NPCs have a home', withHome / total > 0.9,
  `${withHome}/${total}`);

// ---------------------------------------------------------------------------
// 1b. Public buildings are staffed
// ---------------------------------------------------------------------------
//
// This is a tripwire for a failure that was completely silent: every village,
// town and castle is laid out with a tavern, church, smithy and longhouse, and
// for a long time NOT ONE of them was ever assigned an NPC. Nothing crashed,
// no test failed, and you could rent a bed from a tavern with nobody in it.

{
  const WORK = ['tavern', 'smithy', 'church', 'longhouse'];
  for (const kind of ['village', 'town', 'castle'] as SettlementKind[]) {
    let sites = 0, withTavernPad = 0, withKeeper = 0, tavernKept = 0;
    for (let s = 0; s < 24; s++) {
      const seed = s * 7919 + 13;
      const layout = layoutSettlement(kind, seed);
      const npcs = spawnSettlementNpcs(kind, seed, layout);
      sites++;
      const hasTavern = layout.pads.some((p) => p.type === 'tavern');
      if (hasTavern) withTavernPad++;
      const staffed = npcs.filter((n) => n.homePadIndex >= 0 &&
        WORK.includes(layout.pads[n.homePadIndex].type));
      if (staffed.length > 0) withKeeper++;
      if (hasTavern && staffed.some((n) =>
        layout.pads[n.homePadIndex].type === 'tavern')) tavernKept++;

      // ...but not so many keepers that the street empties.
      const outside = npcs.length - staffed.length;
      check('the street is not emptied by keepers', outside >= npcs.length / 2,
        `${kind}/${seed}: ${staffed.length} of ${npcs.length} indoors`);
    }
    check(`every ${kind} staffs a public building`, withKeeper === sites,
      `${withKeeper}/${sites}`);
    check(`every ${kind} tavern has a keeper`, tavernKept === withTavernPad,
      `${tavernKept}/${withTavernPad}`);
  }
}
// If this ever collapses the feature is dead on arrival: nobody would be
// indoors because nobody's home has a door the player can open.
check('a real share of homes are enterable', withEnterableHome / total > 0.5,
  `${withEnterableHome}/${total} enterable`);

// ---------------------------------------------------------------------------
// 2. resolveNpcs carries the settlement name (the other half of the join)
// ---------------------------------------------------------------------------

{
  const layout = layoutSettlement('village', 1337);
  const spawned = spawnSettlementNpcs('village', 1337, layout);
  const resolved = resolveNpcs(spawned, 100, 200, () => 12, layout.name);
  check('resolved NPCs know their settlement',
    resolved.length > 0 && resolved.every((n) => n.settlementName === layout.name),
    layout.name);
  check('resolved NPCs keep their home index',
    resolved.every((n, i) => n.homePadIndex === spawned[i].homePadIndex));
}

// ---------------------------------------------------------------------------
// 3. Standing spots are places a person could really stand
// ---------------------------------------------------------------------------

const KINDS_I = ['house', 'tavern', 'church', 'smithy', 'longhouse', 'shop', 'barn'] as const;
let spotsChecked = 0;
let emptyInteriors = 0;

for (const bk of KINDS_I) {
  for (const seed of SEEDS) {
    const interior = generateBuildingInterior({
      settlementName: 'Testholm', buildingIndex: seed % 17, kind: bk,
      width: 9, depth: 7,
    }, seed);
    const spots = standingSpots(interior, 4, seed % 17);
    if (spots.length === 0) { emptyInteriors++; continue; }

    const reachable = reachableFloorCells(interior);

    for (const [lx, lz] of spots) {
      spotsChecked++;
      const cx = Math.floor(lx), cz = Math.floor(lz);

      check('spot is on a floor cell',
        interior.cells[cz * interior.gridW + cx] === 1,
        `${bk}/${seed} cell (${cx},${cz}) = ${interior.cells[cz * interior.gridW + cx]}`);

      // The test that matters is not "can the player walk onto this cell" —
      // a shopkeeper stands behind a counter and the counter is a collider, so
      // their cell is correctly unwalkable. It is "can the player get close
      // enough to speak". That rules out someone sealed in a pocket of floor,
      // visible across the room and impossible to talk to, while still allowing
      // the person behind the bar.
      const talkable = reachable.some(([rx, rz]) =>
        Math.hypot(lx - (rx + 0.5), lz - (rz + 0.5)) <= 3 /* NPC_INTERACT_DIST */);
      check('player can get within talking distance',
        talkable, `${bk}/${seed} cell (${cx},${cz}) unreachable to speak`);

      for (const f of interior.furniture) {
        const b = f.aabb;
        check('spot is not inside furniture',
          !(lx > b.minX && lx < b.maxX && lz > b.minZ && lz < b.maxZ),
          `${bk}/${seed} standing in ${f.type} at (${lx},${lz})`);
      }

      for (const [dx, dz] of interior.doorCells) {
        check('spot does not block the doorway',
          Math.hypot(lx - (dx + 0.5), lz - (dz + 0.5)) >= 2.5,
          `${bk}/${seed} ${Math.hypot(lx - (dx + 0.5), lz - (dz + 0.5)).toFixed(2)} m from door`);
      }
    }

    // Two people in a room stand apart.
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        check('occupants are not stacked',
          Math.hypot(spots[i][0] - spots[j][0], spots[i][1] - spots[j][1]) >= 1.8,
          `${bk}/${seed}`);
      }
    }
  }
}

check('interiors generally have standing room', emptyInteriors === 0,
  `${emptyInteriors} of ${KINDS_I.length * SEEDS.length} had none`);
check('a useful number of spots were checked', spotsChecked > 60, `${spotsChecked}`);

// ---------------------------------------------------------------------------
// 4. Determinism — the keeper is behind the same bar every visit
// ---------------------------------------------------------------------------

{
  const interior = generateBuildingInterior({
    settlementName: 'Testholm', buildingIndex: 3, kind: 'tavern',
    width: 9, depth: 7,
  }, 4242);
  const a = standingSpots(interior, 3, 3);
  const b = standingSpots(interior, 3, 3);
  check('standing spots are deterministic', JSON.stringify(a) === JSON.stringify(b));

  // Different buildings vary the occupied spot — but only mildly, because
  // ranking by distance from the door deliberately dominates the seed.
  const varied = new Set<string>();
  for (let pad = 0; pad < 12; pad++) {
    const s = standingSpots(interior, 1, pad);
    if (s.length > 0) varied.add(`${s[0][0]},${s[0][1]}`);
  }
  check('buildings vary the occupied spot at least a little',
    varied.size >= 2, `${varied.size} distinct`);
}

// The property that actually matters: you walk in and the occupant is THERE.
// Measured in game before this was ranked by door distance, the householder
// stood 8.67 m away in the far corner of his own house — inside the room, past
// every geometric check, and still the wrong answer.
{
  const KINDS_D = ['house', 'tavern', 'church', 'smithy', 'longhouse', 'shop', 'barn'] as const;
  let worst = 0;
  let worstWhere = '';
  let measured = 0;
  for (const bk of KINDS_D) {
    for (const seed of SEEDS) {
      const it = generateBuildingInterior({
        settlementName: 'Testholm', buildingIndex: seed % 17, kind: bk,
        width: 9, depth: 7,
      }, seed);
      const s = standingSpots(it, 1, seed % 17);
      if (s.length === 0) continue;
      measured++;
      const d = Math.hypot(s[0][0] - it.spawnPoint[0], s[0][1] - it.spawnPoint[2]);
      if (d > worst) { worst = d; worstWhere = `${bk}/${seed}`; }
    }
  }
  check('measured the occupant distance in every interior kind', measured > 30, `${measured}`);
  // 3 m is the E-key reach: the first occupant should be talkable from where
  // the player materialises, without hunting round the room for them.
  check('the occupant is within talking distance of the entrance',
    worst <= 3.0, `worst ${worst.toFixed(2)} m in ${worstWhere}`);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
