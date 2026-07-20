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
const GOLDEN_HASH: number | null = 0x38b59f91;

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
