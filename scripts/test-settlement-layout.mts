/**
 * Deterministic tests for settlement layout, naming, and mesh building.
 * Pure CPU — no GPU, no server. Run:  npx tsx scripts/test-settlement-layout.mts
 *
 * Golden FNV hash = determinism tripwire (see test-heightfield.mts header).
 */

import {
  layoutSettlement, resolveSettlement, padHalfExtents, settlementName,
} from '../src/game/settlement/settlement-layout';
import { buildSettlementMeshes } from '../src/game/settlement/settlement-mesh';
import {
  SETTLEMENT_RADIUS, type SettlementKind, type SettlementSite,
} from '../src/game/settlement/settlement-scatter';
import { mulberry32 } from '../src/game/mesh-utils';

/** Update ONLY on deliberate layout/mesh changes. */
// Rebaked for Phase L1 (castle kind + new pad types: tower/wall/stable/gatehouse/jail).
const GOLDEN_HASH: number | null = 0xc20a725b;

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

const KINDS: SettlementKind[] = ['ruins', 'ranch', 'village', 'town', 'castle'];
const HALF_PI = Math.PI / 2;

// --- layout invariants over a seed sweep ------------------------------------

const all: number[] = [];
let inRadius = true;
let yawQuantized = true;
let signposts = true;
let wells = true;
for (const kind of KINDS) {
  for (let s = 0; s < 20; s++) {
    const seed = s * 7919 + 17;
    const { name, pads } = layoutSettlement(kind, seed);
    all.push(kind.length, seed, pads.length, name.length);
    const radius = SETTLEMENT_RADIUS[kind];
    let posts = 0;
    let wellCount = 0;
    for (const pad of pads) {
      const { hx, hz } = padHalfExtents(pad);
      if (Math.abs(pad.x) + hx > radius || Math.abs(pad.z) + hz > radius) {
        inRadius = false;
      }
      const q = pad.yaw / HALF_PI;
      if (Math.abs(q - Math.round(q)) > 1e-9) yawQuantized = false;
      if (pad.type === 'signpost') posts++;
      if (pad.type === 'well') wellCount++;
      all.push(pad.x, pad.z, pad.yaw, pad.w, pad.d, pad.h);
    }
    if (posts !== 1) signposts = false;
    if ((kind === 'village' || kind === 'town' || kind === 'castle') && wellCount < 1) wells = false;
  }
}
check('pads stay inside the settlement radius', inRadius);
check('yaws are quantized to 90° steps', yawQuantized);
check('every layout has exactly one signpost', signposts);
check('villages and towns have a well', wells);

// --- naming ------------------------------------------------------------------

const rn = settlementName('ruins', mulberry32(42));
const ra = settlementName('ranch', mulberry32(42));
const vi = settlementName('village', mulberry32(42));
check('ruins name is prefixed', rn.startsWith('Ruins of '), rn);
check('ranch name is suffixed', ra.endsWith(' Ranch'), ra);
check('village name is a bare toponym', vi.length > 3 && !vi.includes(' '), vi);
check('naming provider seam wins when it answers',
  settlementName('town', mulberry32(1), () => 'Directorville') === 'Directorville');
check('naming provider seam falls through on null',
  settlementName('town', mulberry32(1), () => null) ===
  settlementName('town', mulberry32(1)));

// --- resolution + meshes -----------------------------------------------------

// Synthetic sloped terrain: buildings must sit at the highest corner.
const slope = (x: number, _z: number) => 10 + x * 0.05;
const site: SettlementSite = {
  kind: 'castle', x: 1000, z: -2000, y: slope(1000, -2000),
  radius: SETTLEMENT_RADIUS.castle, seed: 12345,
};
const resolved = resolveSettlement(site, slope);
let padsGrounded = true;
for (const pad of resolved.pads) {
  const { hx } = padHalfExtents(pad);
  const maxCorner = slope(pad.wx + hx, pad.wz);
  if (pad.wy < maxCorner - 1e-9) padsGrounded = false;
}
check('resolved pads sit at the highest footprint corner', padsGrounded);
check('resolved name matches the layout',
  resolved.name === layoutSettlement('castle', 12345).name);

const meshes = buildSettlementMeshes(resolved);
check('settlement draws in at most 4 batches', meshes.length <= 4,
  `batches=${meshes.length}`);
check('all four palettes used by a castle',
  meshes.length === 4, meshes.map((m) => m.palette).join(','));
let triangles = true;
let vertTotal = 0;
for (const m of meshes) {
  if (m.verts.length % 9 !== 0) triangles = false;
  vertTotal += m.verts.length / 3;
  all.push(m.palette, m.verts.length);
  const sub = fnv1a(new Uint8Array(m.verts.buffer));
  all.push(sub);
}
check('mesh soups are whole triangles', triangles);
check('castle mesh vertex budget sane (1k..100k)',
  vertTotal > 1000 && vertTotal < 100_000, `verts=${vertTotal}`);

// Determinism.
check('layout is deterministic (village)',
  JSON.stringify(layoutSettlement('village', 777)) ===
  JSON.stringify(layoutSettlement('village', 777)));
check('layout is deterministic (castle)',
  JSON.stringify(layoutSettlement('castle', 999)) ===
  JSON.stringify(layoutSettlement('castle', 999)));

// Castle-specific checks.
{
  const { pads: cPads } = layoutSettlement('castle', 9999);
  const hasTower = cPads.some((p) => p.type === 'tower');
  const hasGatehouse = cPads.some((p) => p.type === 'gatehouse');
  const hasJail = cPads.some((p) => p.type === 'jail');
  const hasWall = cPads.some((p) => p.type === 'wall');
  check('castle has towers', hasTower, `pads=${cPads.map(p=>p.type).join(',')}`);
  check('castle has a gatehouse', hasGatehouse);
  check('castle has a jail', hasJail);
  check('castle has walls', hasWall);
  // Tower count: 4 corners.
  const towerCount = cPads.filter((p) => p.type === 'tower').length;
  check('castle has 4 corner towers', towerCount === 4, `towerCount=${towerCount}`);
}

// Town checks (jail added).
{
  const { pads: tPads } = layoutSettlement('town', 7777);
  check('town has a jail', tPads.some((p) => p.type === 'jail'));
}

// Ranch/village stable checks.
{
  const { pads: rPads } = layoutSettlement('ranch', 1111);
  check('ranch has a stable', rPads.some((p) => p.type === 'stable'));
  const { pads: vPads } = layoutSettlement('village', 2222);
  check('village has a stable', vPads.some((p) => p.type === 'stable'));
}

const hash = fnv1a(new Uint8Array(new Float32Array(all).buffer));
if (GOLDEN_HASH === null) {
  console.log(`golden hash: 0x${hash.toString(16)} (bake into GOLDEN_HASH)`);
} else {
  check('golden settlement-layout hash', hash === GOLDEN_HASH,
    `got 0x${hash.toString(16)}, want 0x${GOLDEN_HASH.toString(16)}`);
}

console.log(`${passed} passed, ${failed} failed  (castle mesh ${vertTotal} verts)`);
if (failed > 0) process.exit(1);
