/**
 * Deterministic tests for settlement layout, naming, and mesh building.
 * Pure CPU — no GPU, no server. Run:  npx tsx scripts/test-settlement-layout.mts
 *
 * Golden FNV hash = determinism tripwire (see test-heightfield.mts header).
 */

import {
  layoutSettlement, resolveSettlement, padHalfExtents, settlementName,
  type BuildingPad, type PadType,
} from '../src/game/settlement/settlement-layout';
import { buildSettlementMeshes } from '../src/game/settlement/settlement-mesh';
import { ALL_PALETTES } from '../src/game/settlement/settlement-palette';
import {
  SETTLEMENT_RADIUS, type SettlementKind, type SettlementSite,
} from '../src/game/settlement/settlement-scatter';
import { mulberry32 } from '../src/game/mesh-utils';

/** Update ONLY on deliberate layout/mesh changes. */
// Rebaked for the community pass: 20 new pad types (church/tavern/longhouse/
// smithy/mill/townhouse/granary + carts, crops, hedges, graves, washing…),
// street-and-square composition per kind, a castle town outside the gate,
// and a per-pad variant index `v`.
// Previous hashes: 0x28e82e84 (visual pass v3), 0xc20a725b (phase L1).
const GOLDEN_HASH: number | null = 0x9421c8db;

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

/**
 * Pairs allowed to interpenetrate. Curtain walls are *built into* their
 * towers and gatehouse; a fence rectangle overlaps itself at the corners;
 * rubble is rubble. Everything else that overlaps is a building growing
 * through another building, which no amount of nice shading will hide.
 */
const OVERLAP_OK = new Set([
  'tower|wall', 'gatehouse|wall', 'fence|fence', 'ruin|ruin',
]);
function pairKey(a: PadType, b: PadType): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
function overlapAmount(a: BuildingPad, b: BuildingPad): [number, number] {
  const ha = padHalfExtents(a);
  const hb = padHalfExtents(b);
  return [
    (ha.hx + hb.hx) - Math.abs(a.x - b.x),
    (ha.hz + hb.hz) - Math.abs(a.z - b.z),
  ];
}

const all: number[] = [];
let inRadius = true;
let yawQuantized = true;
let signposts = true;
let wells = true;
let overlapping = 0;
let firstOverlap = '';
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
      all.push(pad.x, pad.z, pad.yaw, pad.w, pad.d, pad.h, pad.v ?? -1);
    }
    if (posts !== 1) signposts = false;
    if ((kind === 'village' || kind === 'town' || kind === 'castle') && wellCount < 1) wells = false;
    // No two pads may occupy the same ground (see OVERLAP_OK).
    for (let i = 0; i < pads.length; i++) {
      for (let j = i + 1; j < pads.length; j++) {
        if (OVERLAP_OK.has(pairKey(pads[i].type, pads[j].type))) continue;
        const [ox, oz] = overlapAmount(pads[i], pads[j]);
        if (ox > 0.15 && oz > 0.15) {
          overlapping++;
          if (firstOverlap === '') {
            firstOverlap = `${kind} seed ${seed}: ${pads[i].type}` +
              `(${pads[i].x.toFixed(1)},${pads[i].z.toFixed(1)}) x ${pads[j].type}` +
              `(${pads[j].x.toFixed(1)},${pads[j].z.toFixed(1)}) by ` +
              `${ox.toFixed(2)}x${oz.toFixed(2)}`;
          }
        }
      }
    }
  }
}
check('pads stay inside the settlement radius', inRadius);
check('yaws are quantized to 90° steps', yawQuantized);
check('every layout has exactly one signpost', signposts);
check('villages and towns have a well', wells);
check('no two pads interpenetrate', overlapping === 0,
  `${overlapping} overlaps, first: ${firstOverlap}`);

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
// One draw call per palette in use. Nine exist (six original + leaf green,
// dark timber and pale wool, added for the community pass); a castle town is
// the only settlement rich enough to use every one of them.
check('settlement draws once per palette, at most 9',
  meshes.length <= ALL_PALETTES.length, `batches=${meshes.length}`);
check('a castle town uses every palette',
  meshes.length === ALL_PALETTES.length, meshes.map((m) => m.palette).join(','));
let triangles = true;
let vertTotal = 0;
for (const m of meshes) {
  if (m.verts.length % 9 !== 0) triangles = false;
  vertTotal += m.verts.length / 6;   // 6 floats per vertex (pos3 + normal3)
  all.push(m.palette, m.verts.length);
  const sub = fnv1a(new Uint8Array(m.verts.buffer));
  all.push(sub);
}
check('mesh soups are whole triangles', triangles);
// Settlement geometry is rasterized 4x per frame (3 shadow cascades + the
// opaque pass, renderer.ts:630 — no per-cascade culling), so this ceiling is
// really "≤ 40k triangles of real work for the biggest thing in the world".
check('castle mesh vertex budget sane (1k..110k)',
  vertTotal > 1000 && vertTotal < 110_000, `verts=${vertTotal}`);

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
  const types = new Set(cPads.map((p) => p.type));
  check('castle has towers', types.has('tower'));
  check('castle has a gatehouse', types.has('gatehouse'));
  check('castle has a jail', types.has('jail'));
  check('castle has walls', types.has('wall'));
  const towerCount = cPads.filter((p) => p.type === 'tower').length;
  check('castle has 4 corner towers', towerCount === 4, `towerCount=${towerCount}`);
  // The castle town: the point of a "castle town" is that a settlement grew
  // outside the walls, so there must be dwellings beyond the curtain.
  const outside = cPads.filter(
    (p) => (p.type === 'townhouse' || p.type === 'house') && p.z < -30);
  check('castle has a town outside its gate', outside.length >= 8,
    `dwellings beyond the wall=${outside.length}`);
  check('castle town has its own church + market',
    cPads.filter((p) => p.type === 'church').length === 2 &&
    cPads.some((p) => p.type === 'stall' && p.z < -30));
  // npc-spawn's villager role prefers `house` pads specifically; without one
  // it falls through to "any pad that is not a signpost/fence/lamp" and
  // villagers end up standing in a hedge.
  check('castle has plain house pads for villagers to live in',
    cPads.some((p) => p.type === 'house'));
}

// Town checks.
{
  const { pads: tPads } = layoutSettlement('town', 7777);
  const types = new Set(tPads.map((p) => p.type));
  check('town has a jail', types.has('jail'));
  check('town has a market square', tPads.filter((p) => p.type === 'stall').length >= 4);
  check('town has gable-fronted town houses',
    tPads.filter((p) => p.type === 'townhouse').length >= 6);
  check('town has a mill on its skyline', types.has('mill'));
}

// Ranch/village stable checks + the shared community vocabulary.
{
  const { pads: rPads } = layoutSettlement('ranch', 1111);
  check('ranch has a stable', rPads.some((p) => p.type === 'stable'));
  const { pads: vPads } = layoutSettlement('village', 2222);
  check('village has a stable', vPads.some((p) => p.type === 'stable'));
  // The four names shared with the building-interior workstream.
  for (const t of ['church', 'tavern', 'longhouse', 'smithy'] as PadType[]) {
    check(`village has a ${t}`, vPads.some((p) => p.type === t));
  }
  check('village grows food', vPads.some((p) => p.type === 'crops'));
  check('village buries its dead', vPads.some((p) => p.type === 'graves'));
  const { pads: ruPads } = layoutSettlement('ruins', 3333);
  check('ruins are only rubble and remembrance',
    !ruPads.some((p) => p.type === 'house' || p.type === 'lamp' || p.type === 'crops'));
}

const hash = fnv1a(new Uint8Array(new Float32Array(all).buffer));
if (GOLDEN_HASH === null) {
  console.log(`golden hash: 0x${hash.toString(16)} (bake into GOLDEN_HASH)`);
} else {
  check('golden settlement-layout hash', hash === GOLDEN_HASH,
    `got 0x${hash.toString(16)}, want 0x${GOLDEN_HASH.toString(16)}`);
}

// Per-kind size report — the numbers the perf budget is argued from.
for (const kind of KINDS) {
  const s: SettlementSite = {
    kind, x: 0, z: 0, y: 0, radius: SETTLEMENT_RADIUS[kind], seed: 4242,
  };
  const r = resolveSettlement(s, () => 0);
  const t0 = performance.now();
  const m = buildSettlementMeshes(r);
  const ms = performance.now() - t0;
  let v = 0;
  for (const b of m) v += b.verts.length / 6;
  console.log(`  ${kind.padEnd(8)} ${String(r.pads.length).padStart(3)} pads  ` +
    `${String(v).padStart(6)} verts  ${m.length} draws  build ${ms.toFixed(1)} ms`);
}

console.log(`${passed} passed, ${failed} failed  (castle mesh ${vertTotal} verts)`);
if (failed > 0) process.exit(1);
