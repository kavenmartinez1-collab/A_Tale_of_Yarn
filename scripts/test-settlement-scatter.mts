/**
 * Deterministic tests for per-cell settlement scattering.
 * Pure CPU — no GPU, no server. Run:  npx tsx scripts/test-settlement-scatter.mts
 *
 * Golden FNV hash = determinism tripwire (see test-heightfield.mts header).
 */

import { createHeightField } from '../src/game/noise';
import {
  settlementSiteAt, SETTLEMENT_RADIUS, SCELL, type SettlementKind,
} from '../src/game/settlement/settlement-scatter';
import { entranceSiteAt, DCELL } from '../src/game/dungeon/entrance-site';

/** Update ONLY on deliberate scatter/heightfield changes. */
// Rebaked for Phase L1 (castle kind added, new distribution).
// Rebaked for forced near-spawn castle "Greenholm" at (-191, 166), cell (-1,0).
// Rebaked by the settlement community pass: SETTLEMENT_RADIUS.castle went
// 50 -> 68 (a castle town needs room outside its gate) and the castle
// flatness budget 7 -> 9, which moves every castle candidate in the world.
// Previous: 0x38b59f91
// Rebaselined 2026-07-26: settlement flatness now tests the WHOLE footprint.
// It used to sample one ring at 0.7*radius and compare each sample to the
// CENTRE, which let three things through: nothing outside 0.7*radius was
// checked at all (the outer 20 m of a 68 m castle), measuring against the
// centre halved the apparent tilt of a uniformly sloping site, and MIN_HEIGHT
// was centre-only so a footprint could have its rim in the sea. Now a disc
// (centre + rings at 0.45/0.75/1.0) judged on true spread, with the lowest
// sample required to clear the sand line. Candidates 8 -> 40 to hold density
// under the stricter test, with an outer-ring-first early exit so the common
// rejection costs 2-3 samples rather than 25. Net: 178 -> 192 settlements,
// castles 7 -> 8. Castles keep the loosest budget deliberately — a fortress
// belongs on commanding ground.
// Rebaked when castle/town placement was tightened after the user reported
// glitchy placements. Three deliberate changes moved every site:
//   - flatness sampled on 5 rings x 14 spokes (was 3 x 8) — the old sampling
//     was too coarse to enforce its own budget, accepting castles that
//     measured 31.4 m of spread under a 24 m budget;
//   - castle budget 24 -> 20, town 11 -> 9;
//   - CANDIDATES 40 -> 96 to hold density against the stricter test.
// Net: 192 -> 199 settlements, castles unchanged at 8, castle worst-case
// spread 31.4 -> 20.8 m and town 14.2 -> 9.8 m.
// Previous: 0x4ffaa184
// Rebaselined by the population pass: `rollKind` rebalanced 40/22/15/13/10 ->
// 26/14/22/19/19. The old roll produced an ACCEPTED mix of 54% ruins, 25%
// ranch, 14% village and 4% each of town and castle, because acceptance falls
// off sharply with footprint size (measured over 1600 cells: ruins 92%,
// ranch 75%, village 63%, castle 33%, town 24% — a 10 m ruin fits almost
// anywhere, a 40 m town needs ground flat to 9 m across its whole footprint
// and mostly cannot find it). So the two kinds that feel inhabited were 8% of
// the world and over half of everything the player found was rubble.
// Net over this window: 199 -> 166 settlements, ruins 108 -> 67 (54% -> 40%),
// village 27 -> 42, town 8 -> 15, castle 7 -> 12. Fewer sites overall is the
// price of moving roll mass onto kinds that are rejected more often; it buys a
// world with 307 -> 842 people in it. Castles rising matters in one direction
// only — the road network is a Dijkstra tree rooted at castle gates, so fewer
// castles would remove the roads, not just some buildings.
// Previous: 0x7e96f4f0
// Rebaselined 2026-07-26 by the river pass. Settlement siting was blind to
// rivers, because rivers are not in the layer it was testing. They are carved
// into `heightAt` (noise.ts: `h - riverFactor * 3.5`), but the band is
// |riverNoise| < 0.04 at an 1800 m wavelength — ~140 m across on the ground,
// wider than a castle town's whole 136 m footprint — so a 3.5 m carve spread
// over 70 m is a 5% grade that costs almost nothing against MAX_SITE_SPREAD and
// clears MIN_HEIGHT outright. Nothing in a height test could have caught it: 18
// of the 166 settlements in this window were standing in a river.
//
// It stayed invisible because the three layers that read a river disagree. The
// map paints water at riverFactor > 0.45; the world draws water from ONE flat
// quad at y = 0 (water.wgsl), so a river holds visible water only where the
// carve reaches sea level — 3.7% of all river area, and never under a
// settlement, because MIN_HEIGHT guarantees the footprint is above it; and
// `nearFreshWater()` drinks at riverFactor > 0. So a settlement on a river drew
// a blue thread through the town on the map, showed dry ground in-world, and
// let the player drink in the market square. `settlementSiteAt` now samples
// riverFactor at the same disc it samples flatness on and rejects on `> 0` —
// the drink predicate, deliberately the loosest of the three, so "inside a
// footprint" and "drinkable" are disjoint by construction.
//
// The forced near-spawn castle moved with it, from cell '-1,0' at (-191, 166)
// to cell '-1,-1' at (-242, -320). The old pin was the worst case of the bug —
// riverFactor 0.996 at its centre, 66% of its footprint in the band — and its
// cell has no dry, flat, Vhaeron-clear position anywhere in it. The vacated
// cell now rolls the ranch it always would have.
//
// CANDIDATES 96 -> 128 to absorb the new acceptance cut (the trade-off table is
// in settlement-scatter.ts). Net over this window: 166 -> 168 settlements,
// ruins 67 unchanged, ranch 30 -> 34, village 42, town 15 -> 14, castle 12 ->
// 11, and settlements standing in a river 18 -> 0. Castles falling by one is
// the direction that needs watching — the road network is a Dijkstra tree
// rooted at castle gates and `test-roads` guards `castles >= 8` — which is
// exactly what the candidate budget was raised to protect.
// Previous: 0xabae1e7d
const GOLDEN_HASH: number | null = 0x0f4ec6c1;

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

const field = createHeightField(WORLD_SEED);
const heightAt = (x: number, z: number) => field.heightAt(x, z);

// Scan a 24×24-cell area (≈12 km square around the origin).
const all: number[] = [];
const kindCounts: Record<SettlementKind, number> = {
  ruins: 0, ranch: 0, village: 0, town: 0, castle: 0,
};
let total = 0;
let inCell = true;
let onGround = true;
let radiusOk = true;
let clearanceOk = true;
for (let scz = -12; scz < 12; scz++) {
  for (let scx = -12; scx < 12; scx++) {
    const s = settlementSiteAt(WORLD_SEED, scx, scz, heightAt);
    if (s === null) continue;
    total++;
    kindCounts[s.kind]++;
    all.push(s.x, s.y, s.z, s.radius, s.seed);
    const inset = 64 + s.radius;
    if (s.x < scx * SCELL + inset || s.x > (scx + 1) * SCELL - inset
      || s.z < scz * SCELL + inset || s.z > (scz + 1) * SCELL - inset) {
      inCell = false;
    }
    if (s.y !== heightAt(s.x, s.z) || s.y < 3) onGround = false;
    if (s.radius !== SETTLEMENT_RADIUS[s.kind]) radiusOk = false;
    const e = entranceSiteAt(WORLD_SEED, scx, scz, heightAt);
    if (e !== null && Math.hypot(s.x - e.x, s.z - e.z) < s.radius + 24) {
      clearanceOk = false;
    }
  }
}

check('cells align with dungeon cells', SCELL === DCELL);
check('settlements exist', total > 30, `total=${total} of 576 cells`);
check('settlements are occasional, not everywhere', total < 300, `total=${total}`);
check('sites stay inside their cell (inset 64+radius)', inCell);
check('sites sit on the ground above the sand line', onGround);
check('radius matches the kind table', radiusOk);
check('dungeon-entrance clearance respected', clearanceOk);
check('all kinds occur in a 24x24 sweep',
  kindCounts.ruins > 0 && kindCounts.ranch > 0
  && kindCounts.village > 0 && kindCounts.town > 0 && kindCounts.castle > 0,
  JSON.stringify(kindCounts));
check('ruins are the most common kind',
  kindCounts.ruins >= kindCounts.ranch
  && kindCounts.ranch >= kindCounts.castle,
  JSON.stringify(kindCounts));
check('castle is the least common non-ruins kind',
  kindCounts.castle > 0 && kindCounts.castle <= kindCounts.town,
  JSON.stringify(kindCounts));

// Determinism: recompute one cell, must be identical.
const a = JSON.stringify(settlementSiteAt(WORLD_SEED, 3, -2, heightAt));
const b = JSON.stringify(settlementSiteAt(WORLD_SEED, 3, -2, heightAt));
check('scatter is deterministic', a === b);

const hash = fnv1a(new Uint8Array(new Float32Array(all).buffer));
if (GOLDEN_HASH === null) {
  console.log(`golden hash: 0x${hash.toString(16)} (bake into GOLDEN_HASH)`);
} else {
  check('golden settlement-scatter hash', hash === GOLDEN_HASH,
    `got 0x${hash.toString(16)}, want 0x${GOLDEN_HASH.toString(16)}`);
}

console.log(`${passed} passed, ${failed} failed  ` +
  `(${total} settlements in 576 cells: ${JSON.stringify(kindCounts)})`);
if (failed > 0) process.exit(1);
