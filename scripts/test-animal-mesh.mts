/**
 * Deterministic tests for the blocky animal mesh builders
 * (src/game/entities/animal-mesh.ts). Pure CPU — no GPU, no server.
 * Run:  npx tsx scripts/test-animal-mesh.mts
 *
 * The golden FNV-1a-32 hash covers all 9 species at fixed poses and is the
 * determinism tripwire: update the constant here when the mesh deliberately
 * changes, then verify in-game.
 */

import {
  buildAnimalMesh,
  ANIMAL_MAX_VERTS,
  ANIMAL_IDLE_POSE,
  type AnimalPose,
} from '../src/game/entities/animal-mesh';
import type { Species } from '../src/game/entities/entity-types';
import { SPECIES_DEFS } from '../src/game/entities/entity-types';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

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

function aabb(verts: Float32Array): { lo: number[]; hi: number[] } {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < verts.length; i += 6) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], verts[i + k]);
      hi[k] = Math.max(hi[k], verts[i + k]);
    }
  }
  return { lo, hi };
}

const ALL_SPECIES: Species[] = [
  'rabbit', 'deer', 'bird', 'horse', 'cow', 'donkey',
  'dragon', 'griffin', 'sea_serpent',
];

// ---------------------------------------------------------------------------
// Per-species basic checks
// ---------------------------------------------------------------------------

const vertCounts: Record<Species, number> = {} as Record<Species, number>;

console.log('\n-- per-species vertex counts --');
for (const sp of ALL_SPECIES) {
  const { verts, count } = buildAnimalMesh(sp, ANIMAL_IDLE_POSE);

  vertCounts[sp] = count;
  console.log(`  ${sp.padEnd(12)} ${count} verts`);

  check(`${sp}: vert count > 0`, count > 0, `count=${count}`);
  check(`${sp}: vert count <= ANIMAL_MAX_VERTS`,
    count <= ANIMAL_MAX_VERTS,
    `count=${count} max=${ANIMAL_MAX_VERTS}`);
  check(`${sp}: vert count divisible by 3 (triangles)`,
    count % 3 === 0, `count=${count}`);
  check(`${sp}: float array length = count * 6`,
    verts.length === count * 6, `floats=${verts.length} count=${count}`);

  // Interleaved stride: every 6th float is start of a vertex
  check(`${sp}: float array length divisible by 6`, verts.length % 6 === 0);

  // Colors all in [0,1]
  let colorsInRange = true;
  for (let i = 3; i < verts.length; i += 6) {
    if (verts[i] < 0 || verts[i] > 1) colorsInRange = false;
    if (verts[i + 1] < 0 || verts[i + 1] > 1) colorsInRange = false;
    if (verts[i + 2] < 0 || verts[i + 2] > 1) colorsInRange = false;
  }
  check(`${sp}: vertex colors in [0,1]`, colorsInRange);

  // Geometry sanity: bounding box is not degenerate
  const { lo, hi } = aabb(verts);
  check(`${sp}: bounding box non-degenerate in Y`,
    hi[1] > lo[1], `minY=${lo[1].toFixed(3)} maxY=${hi[1].toFixed(3)}`);
  check(`${sp}: bounding box non-degenerate in Z`,
    hi[2] > lo[2] || hi[0] > lo[0],
    `xSpan=${(hi[0] - lo[0]).toFixed(3)} zSpan=${(hi[2] - lo[2]).toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// ANIMAL_MAX_VERTS budget assertion
// ---------------------------------------------------------------------------

const actualMax = Math.max(...ALL_SPECIES.map(sp => vertCounts[sp]));
check('ANIMAL_MAX_VERTS >= actual max across all species',
  ANIMAL_MAX_VERTS >= actualMax,
  `constant=${ANIMAL_MAX_VERTS} actual=${actualMax}`);

// ANIMAL_MAX_VERTS raised to 900 to accommodate the new dragon rig (25 boxes).
check('ANIMAL_MAX_VERTS is 900 (new dragon budget)',
  ANIMAL_MAX_VERTS === 900,
  `got ${ANIMAL_MAX_VERTS}`);

// ---------------------------------------------------------------------------
// Dragon vert-count band check (new rig: 25 boxes = 900 verts)
// ---------------------------------------------------------------------------

check('dragon vert count is exactly 900 (25 boxes × 36)',
  vertCounts['dragon'] === 900,
  `got ${vertCounts['dragon']}`);

check('dragon vert count > old rig (576)',
  vertCounts['dragon'] > 576,
  `got ${vertCounts['dragon']}`);

// ---------------------------------------------------------------------------
// Griffin vert-count check (upgraded: 17 boxes = 612 verts)
// ---------------------------------------------------------------------------

check('griffin vert count is exactly 612 (17 boxes × 36)',
  vertCounts['griffin'] === 612,
  `got ${vertCounts['griffin']}`);

check('griffin vert count > old rig (468)',
  vertCounts['griffin'] > 468,
  `got ${vertCounts['griffin']}`);

// ---------------------------------------------------------------------------
// Dragon structural checks (horns, tail, wings present = vert count reflects them)
// ---------------------------------------------------------------------------

// Dragon should be larger than all other species (it has the most boxes).
check('dragon is the species with most verts',
  vertCounts['dragon'] === actualMax,
  `dragon=${vertCounts['dragon']} max=${actualMax}`);

// Dragon bounding box should be wider than horse (wings extend laterally).
{
  const dragonBB = aabb(buildAnimalMesh('dragon', ANIMAL_IDLE_POSE).verts);
  const horseBB  = aabb(buildAnimalMesh('horse',  ANIMAL_IDLE_POSE).verts);
  const dragonXSpan = dragonBB.hi[0] - dragonBB.lo[0];
  const horseXSpan  = horseBB.hi[0]  - horseBB.lo[0];
  check('dragon is wider than horse (wings extend X)',
    dragonXSpan > horseXSpan,
    `dragonXSpan=${dragonXSpan.toFixed(3)} horseXSpan=${horseXSpan.toFixed(3)}`);
}

// Dragon bounding box should extend behind the body (tail segments push +Z).
{
  const dragonBB  = aabb(buildAnimalMesh('dragon', ANIMAL_IDLE_POSE).verts);
  const dragonZSpan = dragonBB.hi[2] - dragonBB.lo[2];
  check('dragon tail gives significant Z extent (>= 3.5m)',
    dragonZSpan >= 3.5,
    `dragonZSpan=${dragonZSpan.toFixed(3)}`);
}

// Dragon height should be meaningful (head + neck above body).
{
  const dragonBB = aabb(buildAnimalMesh('dragon', ANIMAL_IDLE_POSE).verts);
  check('dragon height >= 4m (head+horns reach above body)',
    dragonBB.hi[1] >= 4.0,
    `dragonMaxY=${dragonBB.hi[1].toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// Wing flap animation: walkPhase 0 vs π/2 must differ for dragon and griffin
// ---------------------------------------------------------------------------

for (const sp of ['dragon', 'griffin'] as Species[]) {
  const pA: AnimalPose = { yaw: 0, walkPhase: 0,            walkAmp: 1.0 };
  const pB: AnimalPose = { yaw: 0, walkPhase: Math.PI / 2,  walkAmp: 1.0 };
  const { verts: a } = buildAnimalMesh(sp, pA);
  const { verts: b } = buildAnimalMesh(sp, pB);
  check(`${sp}: wing flap animates between walkPhase 0 and π/2`,
    fnv1a(new Uint8Array(a.buffer)) !== fnv1a(new Uint8Array(b.buffer)),
    `mesh identical — wing fold not responding to walkPhase`);
}

// ---------------------------------------------------------------------------
// Tail sway animation: dragon tail must sway with walkPhase
// ---------------------------------------------------------------------------

{
  const pA: AnimalPose = { yaw: 0, walkPhase: 0,   walkAmp: 1.0 };
  const pB: AnimalPose = { yaw: 0, walkPhase: 1.0, walkAmp: 1.0 };
  const { verts: a } = buildAnimalMesh('dragon', pA);
  const { verts: b } = buildAnimalMesh('dragon', pB);
  check('dragon: tail sway animates between walkPhase 0 and 1.0',
    fnv1a(new Uint8Array(a.buffer)) !== fnv1a(new Uint8Array(b.buffer)));
}

// ---------------------------------------------------------------------------
// Determinism: same inputs, same bits
// ---------------------------------------------------------------------------

for (const sp of ALL_SPECIES) {
  const { verts: a } = buildAnimalMesh(sp, ANIMAL_IDLE_POSE);
  const { verts: b } = buildAnimalMesh(sp, ANIMAL_IDLE_POSE);
  check(`${sp}: deterministic output`,
    fnv1a(new Uint8Array(a.buffer)) === fnv1a(new Uint8Array(b.buffer)));
}

// ---------------------------------------------------------------------------
// walkPhase actually moves animated vertices
// ---------------------------------------------------------------------------

const WALK_POSE_A: AnimalPose = { yaw: 0, walkPhase: 0.0, walkAmp: 1.0 };
const WALK_POSE_B: AnimalPose = { yaw: 0, walkPhase: 1.2, walkAmp: 1.0 };

for (const sp of ALL_SPECIES) {
  const { verts: a } = buildAnimalMesh(sp, WALK_POSE_A);
  const { verts: b } = buildAnimalMesh(sp, WALK_POSE_B);
  check(`${sp}: walkPhase changes mesh`,
    fnv1a(new Uint8Array(a.buffer)) !== fnv1a(new Uint8Array(b.buffer)),
    `mesh unchanged between walkPhase 0 and 1.2`);
}

// ---------------------------------------------------------------------------
// walkAmp=0 is identical to IDLE_POSE regardless of walkPhase
// ---------------------------------------------------------------------------

for (const sp of ALL_SPECIES) {
  const pA: AnimalPose = { yaw: 0, walkPhase: 0, walkAmp: 0 };
  const pB: AnimalPose = { yaw: 0, walkPhase: 2.5, walkAmp: 0 };
  const { verts: a } = buildAnimalMesh(sp, pA);
  const { verts: b } = buildAnimalMesh(sp, pB);
  check(`${sp}: walkAmp=0 is phase-independent`,
    fnv1a(new Uint8Array(a.buffer)) === fnv1a(new Uint8Array(b.buffer)));
}

// ---------------------------------------------------------------------------
// Yaw rotates the mesh (bounding-box X/Z extents change for non-symmetric yaws)
// ---------------------------------------------------------------------------

for (const sp of ALL_SPECIES) {
  const idle    = buildAnimalMesh(sp, { yaw: 0,              walkPhase: 0, walkAmp: 0 });
  const turned  = buildAnimalMesh(sp, { yaw: Math.PI / 3,   walkPhase: 0, walkAmp: 0 });

  // Height (Y) must be preserved under rotation
  const bbIdle   = aabb(idle.verts);
  const bbTurned = aabb(turned.verts);
  check(`${sp}: yaw preserves height`,
    Math.abs(bbTurned.hi[1] - bbIdle.hi[1]) < 1e-4,
    `idleMaxY=${bbIdle.hi[1].toFixed(4)} turnedMaxY=${bbTurned.hi[1].toFixed(4)}`);

  // Hash must differ (the mesh was actually rotated)
  check(`${sp}: yaw changes the mesh`,
    fnv1a(new Uint8Array(idle.verts.buffer)) !==
    fnv1a(new Uint8Array(turned.verts.buffer)));
}

// ---------------------------------------------------------------------------
// Size scaling: horse mesh should be taller than rabbit mesh
// ---------------------------------------------------------------------------

const horseMesh  = buildAnimalMesh('horse',  ANIMAL_IDLE_POSE);
const rabbitMesh = buildAnimalMesh('rabbit', ANIMAL_IDLE_POSE);
const horseBB    = aabb(horseMesh.verts);
const rabbitBB   = aabb(rabbitMesh.verts);
check('horse mesh taller than rabbit mesh',
  horseBB.hi[1] > rabbitBB.hi[1],
  `horse maxY=${horseBB.hi[1].toFixed(3)} rabbit maxY=${rabbitBB.hi[1].toFixed(3)}`);

check('dragon mesh taller than deer mesh',
  aabb(buildAnimalMesh('dragon', ANIMAL_IDLE_POSE).verts).hi[1] >
  aabb(buildAnimalMesh('deer',   ANIMAL_IDLE_POSE).verts).hi[1]);

// Verify size proportionality: horse (1.6m) should be strictly taller than donkey (1.3m)
check('horse mesh taller than donkey mesh',
  horseBB.hi[1] >
  aabb(buildAnimalMesh('donkey', ANIMAL_IDLE_POSE).verts).hi[1]);

// ---------------------------------------------------------------------------
// colorVariant changes colors but NOT geometry
// ---------------------------------------------------------------------------

for (const sp of ALL_SPECIES) {
  const { verts: v0 } = buildAnimalMesh(sp, ANIMAL_IDLE_POSE, undefined, 0);
  const { verts: v1 } = buildAnimalMesh(sp, ANIMAL_IDLE_POSE, undefined, 1);
  const { verts: v2 } = buildAnimalMesh(sp, ANIMAL_IDLE_POSE, undefined, 2);

  check(`${sp}: colorVariant 1 differs from variant 0`,
    fnv1a(new Uint8Array(v0.buffer)) !== fnv1a(new Uint8Array(v1.buffer)));
  check(`${sp}: colorVariant 2 differs from variant 1`,
    fnv1a(new Uint8Array(v1.buffer)) !== fnv1a(new Uint8Array(v2.buffer)));

  // Geometry must match: position floats at offsets 0,1,2 of each vertex
  let geoMatches = true;
  for (let i = 0; i < v0.length; i += 6) {
    if (v0[i] !== v1[i] || v0[i+1] !== v1[i+1] || v0[i+2] !== v1[i+2]) {
      geoMatches = false;
      break;
    }
  }
  check(`${sp}: colorVariant changes only color, not geometry`, geoMatches);
}

// ---------------------------------------------------------------------------
// out-buffer write path
// ---------------------------------------------------------------------------

{
  const sp: Species = 'horse';
  const outBuf = new Float32Array(ANIMAL_MAX_VERTS * 6);
  const { count } = buildAnimalMesh(sp, ANIMAL_IDLE_POSE, outBuf, 0);
  const freshResult = buildAnimalMesh(sp, ANIMAL_IDLE_POSE, undefined, 0);

  check('out-buffer write path returns correct count',
    count === freshResult.count, `outCount=${count} freshCount=${freshResult.count}`);

  let outMatch = true;
  for (let i = 0; i < count * 6; i++) {
    if (outBuf[i] !== freshResult.verts[i]) { outMatch = false; break; }
  }
  check('out-buffer write path produces identical verts to fresh allocation', outMatch);
}

// ---------------------------------------------------------------------------
// Golden FNV-1a-32 hash over all 9 species at fixed poses
// ---------------------------------------------------------------------------

/**
 * Update this constant ONLY when animal-mesh.ts changes deliberately.
 * Set to null to print the new hash for baking in.
 * Old hash (16-box dragon rig): 0x00a40ea3
 */
const GOLDEN_HASH: number | null = 0x9fd62fc8;

// Concatenate all species meshes at a fixed canonical pose in ALL_SPECIES order.
const CANONICAL_POSE: AnimalPose = { yaw: 0.5, walkPhase: 1.0, walkAmp: 0.8 };
const hashParts: number[] = [];
for (const sp of ALL_SPECIES) {
  const { verts } = buildAnimalMesh(sp, CANONICAL_POSE, undefined, 0);
  const bytes = new Uint8Array(verts.buffer);
  for (let i = 0; i < bytes.length; i++) hashParts.push(bytes[i]);
}
const allBytes = new Uint8Array(hashParts);
const computedHash = fnv1a(allBytes);

if (GOLDEN_HASH === null) {
  console.log(`\ngolden hash (all 9 species): 0x${computedHash.toString(16).padStart(8, '0')}`);
  console.log('(bake this into GOLDEN_HASH once you are satisfied with the meshes)');
} else {
  check('golden hash matches all 9 species',
    computedHash === GOLDEN_HASH,
    `got 0x${computedHash.toString(16)} want 0x${GOLDEN_HASH.toString(16)}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\nANIMAL_MAX_VERTS = ${ANIMAL_MAX_VERTS}  (actual max across species = ${actualMax})`);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
