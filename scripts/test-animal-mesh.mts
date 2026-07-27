/**
 * Deterministic tests for the blocky animal mesh builders
 * (src/game/entities/animal-mesh.ts). Pure CPU — no GPU, no server.
 * Run:  npx tsx scripts/test-animal-mesh.mts
 *
 * The golden FNV-1a-32 hash covers all 11 species at fixed poses and is the
 * determinism tripwire: update the constant here when the mesh deliberately
 * changes, then verify in-game.
 */

import {
  buildAnimalMesh,
  ANIMAL_MAX_VERTS,
  ANIMAL_IDLE_POSE,
  type AnimalPose,
  animalBodyDrop,
  animalGait,
} from '../src/game/entities/animal-mesh';
import type { Species } from '../src/game/entities/entity-types';
import { SPECIES_DEFS } from '../src/game/entities/entity-types';
// Appended-block imports (dragon rebuild + wyvern coverage) — see the block
// at the end of this file.
import { animalStride } from '../src/game/entities/animal-mesh';
import { dragonMaxStride } from '../src/game/entities/dragon-mesh';
import { wyvernMaxStride } from '../src/game/entities/wyvern-mesh';
import { BASE_COLORS } from '../src/game/entities/creature-parts';
import {
  DEFAULT_TAME_PROFILE, feedsToTame, needsTaming, tameProfile,
} from '../src/game/entities/taming';
// Appended-block imports (humanoid dungeon enemies).
import {
  humanoidMaxStride, humanoidStride,
} from '../src/game/entities/humanoid-mesh';
import { MAT } from '../src/game/render/material-table';

/**
 * Golden hash for the four humanoid enemies. See the appended block at the
 * end of this file for the update protocol; `null` prints a candidate and
 * FAILS rather than passing vacuously.
 */
const ENEMY_GOLDEN: number | null = 0x34aa1454;

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

// Stride 10: pos3 (0..2) + normal3 (3..5) + color3 (6..8) + materialId (9).
function aabb(verts: Float32Array): { lo: number[]; hi: number[] } {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < verts.length; i += 10) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], verts[i + k]);
      hi[k] = Math.max(hi[k], verts[i + k]);
    }
  }
  return { lo, hi };
}

// wolf/bear were missing here (pre-existing gap) — they got zero coverage
// from every check below despite being full quadruped body plans. Added
// while touching this file for the RECTIFICATION_PLAN §5.1 quadruped pass,
// which changed both of them as much as any other quadruped.
const ALL_SPECIES: Species[] = [
  'rabbit', 'deer', 'bird', 'horse', 'cow', 'donkey', 'wolf', 'bear',
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
  check(`${sp}: float array length = count * 10`,
    verts.length === count * 10, `floats=${verts.length} count=${count}`);

  // Interleaved stride: pos3 + normal3 + color3 + materialId = 10 floats/vertex.
  check(`${sp}: float array length divisible by 10`, verts.length % 10 === 0);

  // Colors all in [0,1] — color is offset 6..8 of each 10-float vertex.
  let colorsInRange = true;
  for (let i = 6; i < verts.length; i += 10) {
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

// ANIMAL_MAX_VERTS raised to 9200 for the capsule/sphere/cone rig (the dragon
// alone now carries ~24 capsule bones), then to 11400 when the final boss's
// mount landed — `black_dragon` is `buildDragon` at size 4.4 plus a saddle,
// girth, stirrups and crest, and measures 9690. See ANIMAL_MAX_VERTS's doc
// comment in animal-mesh.ts, and `scripts/test-boss-mesh.mts` for the sweep
// that establishes the new worst case.
check('ANIMAL_MAX_VERTS is 11400 (boss-mount budget)',
  ANIMAL_MAX_VERTS === 11400,
  `got ${ANIMAL_MAX_VERTS}`);

// ---------------------------------------------------------------------------
// Dragon vert-count sanity. The rig is no longer "N boxes × 36" — bodies
// are now sphere/capsule/cone/bevelBox/flat-quad primitives with wildly
// different per-part vertex costs (a 6-segment capsule alone is 252
// verts), so an exact box-derived count can't be rescaled by a constant.
// Assert structural invariants instead.
// ---------------------------------------------------------------------------

check('dragon vert count > 0 and within ANIMAL_MAX_VERTS',
  vertCounts['dragon'] > 0 && vertCounts['dragon'] <= ANIMAL_MAX_VERTS,
  `got ${vertCounts['dragon']}`);

check('dragon has more verts than griffin (richer wing+tail+neck rig)',
  vertCounts['dragon'] > vertCounts['griffin'],
  `dragon=${vertCounts['dragon']} griffin=${vertCounts['griffin']}`);

// ---------------------------------------------------------------------------
// Griffin vert-count sanity (same reasoning as the dragon section above).
// ---------------------------------------------------------------------------

// This assertion has now been wrong twice, both times for the same reason: it
// was written as a vertex-count comparison (first griffin > horse, then
// griffin > bear), and a vertex count is not evidence of a wing. It broke when
// quadrupeds gained shoulder/haunch masses, and broke again when they gained
// three-segment legs — each time flagging a genuine improvement as a failure
// while never once being capable of catching a missing wing.
//
// Assert the structural claim instead: a winged creature is WIDER THAN IT IS
// LONG, because the wingspan dominates its planform. No wingless quadruped
// comes anywhere near that, however many verts it grows.
//
// MEASURED WITH THE WINGS OUT, not at the idle pose. The dragon (and the
// wyvern) now FURL their wings when they are not flying — a resting animal
// with its wings held permanently spread was one of the specific defects the
// rebuild set out to fix — so at ANIMAL_IDLE_POSE the dragon's planform is
// 0.24 and its span is 2.77 m, both correct and both of which would fail the
// claim below. The claim itself is unchanged and still worth making: it is
// about whether the wings could carry the animal, which is a question about
// the wing EXTENDED. The griffin is unaffected either way (its builder holds
// one wing pose), so this does not weaken its coverage.
{
  const WINGS_OUT: AnimalPose = {
    yaw: 0, walkPhase: 0, walkAmp: 1, flapPhase: 0, flapAmp: 1,
  };
  const planform = (sp: Species, pose: AnimalPose): number => {
    const { lo, hi } = aabb(buildAnimalMesh(sp, pose).verts);
    return (hi[0] - lo[0]) / (hi[2] - lo[2]); // width / length
  };
  const winged = ['dragon', 'griffin'] as Species[];
  const wingless = ['horse', 'bear', 'cow', 'deer', 'wolf'] as Species[];
  const widestWingless = Math.max(
    ...wingless.map((sp) => planform(sp, ANIMAL_IDLE_POSE)));
  for (const sp of winged) {
    check(`${sp} planform is unmistakably winged vs any quadruped`,
      planform(sp, WINGS_OUT) > widestWingless * 1.8,
      `${planform(sp, WINGS_OUT).toFixed(2)} vs widest wingless ${widestWingless.toFixed(2)}`);

    // Absolute floor as well as a relative one: the wings must look capable of
    // carrying the animal, not just wider than a cow. Measured against
    // shoulder height rather than total length deliberately — the dragon's
    // tail is a trailing streamer, not a lifting surface, and including it
    // would let a longer tail "fail" a perfectly good wing.
    const { lo, hi } = aabb(buildAnimalMesh(sp, WINGS_OUT).verts);
    const span = hi[0] - lo[0];
    const size = SPECIES_DEFS[sp].size;
    check(`${sp} wingspan is at least 2.5x shoulder height`,
      span >= size * 2.5,
      `span ${span.toFixed(2)} m vs size ${size} m (ratio ${(span / size).toFixed(2)})`);
  }
}

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
// Pose-chain composition: whole-body yaw must be the OUTERMOST transform.
//
// assembleParts collapses each part's rotation chain into a single matrix
// rather than re-applying every rotation per vertex. That is a pure speed
// change, so it must not move a single vertex — but it reassociates float
// operations, so the golden hash cannot prove it (and did change).
//
// This proves it geometrically instead: posing a creature at yaw Y must equal
// posing it at yaw 0 and then rotating the finished mesh by Y. If the yaw were
// composed innermost — the easy mistake, and one I made — it would rotate
// every joint pivot along with the body and skew the pose, which this catches
// immediately while the AABB and vertex-count checks would not.
// ---------------------------------------------------------------------------

{
  const YAWS = [0.5, 1.7, -2.3, Math.PI];
  for (const sp of ALL_SPECIES) {
    let worst = 0;
    for (const yaw of YAWS) {
      const flat = buildAnimalMesh(sp,
        { yaw: 0, walkPhase: 1.0, walkAmp: 0.8 }, undefined, 0).verts;
      const posed = buildAnimalMesh(sp,
        { yaw, walkPhase: 1.0, walkAmp: 0.8 }, undefined, 0).verts;
      const s2 = Math.sin(yaw), c2 = Math.cos(yaw);
      for (let i = 0; i < flat.length; i += 10) {
        // Rotate the yaw-0 vertex by hand and compare.
        const x = flat[i], y = flat[i + 1], z = flat[i + 2];
        const rx = x * c2 - z * s2;
        const rz = x * s2 + z * c2;
        worst = Math.max(worst, Math.abs(rx - posed[i]),
          Math.abs(y - posed[i + 1]), Math.abs(rz - posed[i + 2]));
      }
    }
    // Measured worst across all species: 6.7e-7 m (0.67 microns, on the 4 m
    // dragon) — that is float32 ULP at these magnitudes, i.e. the composed
    // transform is exact to storage precision. 5e-6 leaves an order of
    // magnitude of headroom while still catching anything structural, which
    // lands in centimetres, not microns.
    check(`${sp}: yaw is applied outermost (pose is yaw-invariant)`,
      worst < 5e-6, `worst vertex mismatch ${worst.toExponential(2)} m`);
  }
}

// ---------------------------------------------------------------------------
// Planted-foot rig — the integration test.
//
// test-gait.mts proves the solver is exact, but it proves it about numbers the
// test itself supplies. This checks the property that actually matters after
// the real species constants, the real leg plans and the real foot geometry
// have all had their say: across a full walk cycle, does the creature stand ON
// the ground?
//
// Both failure directions are silent in a still frame and both look like bad
// modelling rather than bad animation, which is exactly why they cost so much
// to find by eye:
//   - lowest vertex BELOW 0 → feet sink through the terrain each step
//   - lowest vertex ABOVE 0 → the creature hovers, legs pawing at nothing
// ---------------------------------------------------------------------------

{
  const QUADRUPEDS: Species[] = ['rabbit', 'deer', 'cow', 'wolf', 'bear',
    'horse', 'donkey'];
  const SAMPLES = 48;

  for (const sp of QUADRUPEDS) {
    const size = SPECIES_DEFS[sp].size;
    // Tolerance scales with the creature: 1.5% of shoulder height. Tight
    // enough that a sunk hoof or a hovering paw fails, loose enough to allow
    // the deliberate rounding of a capsule cap.
    const tol = size * 0.015;

    let worstSink = 0, worstFloat = Infinity, liftSeen = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const phase = (i / SAMPLES) * Math.PI * 2;
      const drop = animalBodyDrop(sp, phase, 1);
      const { verts } = buildAnimalMesh(sp,
        { yaw: 0, walkPhase: phase, walkAmp: 1, bodyDrop: drop });
      let minY = Infinity;
      for (let v = 0; v < verts.length; v += 10) {
        if (verts[v + 1] < minY) minY = verts[v + 1];
      }
      // The body offset the renderer will apply moves the whole creature.
      const groundY = minY + drop;
      worstSink = Math.min(worstSink, groundY);
      worstFloat = Math.min(worstFloat, groundY);
      liftSeen = Math.max(liftSeen, groundY);
    }

    check(`${sp}: feet never sink through the ground while walking`,
      worstSink > -tol,
      `lowest point ${worstSink.toFixed(4)} m (tolerance ${(-tol).toFixed(4)})`);

    // Whether the creature may leave the ground at all is a property of its
    // gait, not a universal rule: a bound HAS an airborne phase by definition
    // (that is what distinguishes it from a walk), so demanding permanent
    // ground contact would assert the rabbit's defining feature away.
    const gait = animalGait(sp);
    const airborne = gait !== null && gait.duty <= 0.5;
    if (airborne) {
      // Bounding: it may leave the ground, but only about as far as the gait's
      // own foot lift — anything more and it is flying, not hopping.
      const budget = size * gait.lift * 1.2;
      check(`${sp}: bounds without launching into the air`,
        liftSeen < budget,
        `hovers ${liftSeen.toFixed(4)} m, budget ${budget.toFixed(4)} m`);
    } else {
      check(`${sp}: at least one foot is on the ground at every phase`,
        liftSeen < tol,
        `creature hovers by up to ${liftSeen.toFixed(4)} m`);
    }
  }

  // And the swing must actually lift a foot — a rig where every foot stays
  // planted would pass both checks above while animating nothing.
  for (const sp of QUADRUPEDS) {
    const flat = buildAnimalMesh(sp, { yaw: 0, walkPhase: 0, walkAmp: 0 });
    const mid = buildAnimalMesh(sp, { yaw: 0, walkPhase: 1.1, walkAmp: 1 });
    check(`${sp}: walking pose differs from standing pose`,
      fnv1a(new Uint8Array(flat.verts.buffer)) !==
      fnv1a(new Uint8Array(mid.verts.buffer)));
  }

  // Standing still, every foot must be down — a creature at rest that holds a
  // leg in the air reads as broken, not as resting.
  for (const sp of QUADRUPEDS) {
    const { verts } = buildAnimalMesh(sp, { yaw: 0, walkPhase: 0, walkAmp: 0 });
    let minY = Infinity;
    for (let v = 0; v < verts.length; v += 10) {
      if (verts[v + 1] < minY) minY = verts[v + 1];
    }
    check(`${sp}: stands on the ground at rest`,
      Math.abs(minY) < SPECIES_DEFS[sp].size * 0.015,
      `lowest point ${minY.toFixed(4)} m`);
  }
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
  for (let i = 0; i < v0.length; i += 10) {
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
  const outBuf = new Float32Array(ANIMAL_MAX_VERTS * 10);
  const { count } = buildAnimalMesh(sp, ANIMAL_IDLE_POSE, outBuf, 0);
  const freshResult = buildAnimalMesh(sp, ANIMAL_IDLE_POSE, undefined, 0);

  check('out-buffer write path returns correct count',
    count === freshResult.count, `outCount=${count} freshCount=${freshResult.count}`);

  let outMatch = true;
  for (let i = 0; i < count * 10; i++) {
    if (outBuf[i] !== freshResult.verts[i]) { outMatch = false; break; }
  }
  check('out-buffer write path produces identical verts to fresh allocation', outMatch);
}

// ---------------------------------------------------------------------------
// Golden FNV-1a-32 hash over all 11 species at fixed poses
// ---------------------------------------------------------------------------

/**
 * Update this constant ONLY when animal-mesh.ts changes deliberately.
 * Set to null to print the new hash for baking in.
 * Old hash (16-box dragon rig): 0x00a40ea3
 * Old hash (pre horse/donkey head-assembly rework): 0x9fd62fc8
 * Old hash (pre wyvern dragon / raised-wing griffin rework): 0x53599487
 * Old hash (pre Ice-and-Fire dragon rig / flap-phase wings): 0xa054c2b4
 * Old hash (pre jawOpen / neck-bob fire-breath rig): 0xd06500ae
 * Old hash (pre bigger flight-capable dragon wings): 0xc41146e9
 * Old hash (pre pos3+normal3+color3 vertex-format migration): 0x876223aa
 * Old hash (pre pos3+normal3+color3+materialId / per-vertex MAT.* IDs): 0x7069dd79
 * Old hash (pre RECTIFICATION_PLAN §5.1/§5.3/§7 quadruped-neck/leg-taper/
 *   double-sided-wing pass, over the old 9-species ALL_SPECIES): 0xa4ed955d
 * Old hash (same pass, still 9-species, after the wolf base-colour warm-up
 *   fix landed): 0x15c6fa6c
 * ALL_SPECIES widened to all 11 species (wolf/bear were uncovered by every
 * check in this file) 2026-07-24 — hash below is over the new 11-species set.
 * Old hash (pre tail-root fix): 0xf149c95a. Tails anchored at z = bodyL, the
 * torso ellipsoid's rear *pole*, while sitting at hip height where that
 * surface has already curved forward — so every quadruped's tail floated
 * visibly detached. Roots now solve the ellipsoid at the tail's own height.
 * Old hash (pre limb-attachment pass): 0xe69b09ac. Same bounding-box-vs-
 * ellipsoid trap, applied to the rest of the quadruped: leg roots sat outside
 * the torso surface entirely (Rule A puts them there by design), ears sat above
 * the skull's true crown, and the cow's piebald patches were buried inside the
 * hide. Legs now run up to mid-body under shoulder/haunch masses, ears seat on
 * the skull surface, patches mount on the torso surface. Also: deer chest
 * depth 0.30 -> 0.42 s, deer neck shortened and thickened, antlers splayed to
 * full skull width, deer/cow moved to FUR_SHORT per §3.
 * Old hash (pre planted-foot rig): 0x66bfdf05. Legs were a single rigid capsule
 * pitched from the hip by sin(walkPhase) — no knee, and a foot that skated and
 * sank through the terrain. They are now three-segment folding limbs (upper +
 * lower + cannon) whose feet are driven along a gait trajectory and whose
 * joints are solved by two-bone IK (src/game/anim/gait.ts), with fore limbs
 * breaking backward at the carpus and hind limbs forward at the stifle over a
 * set-back hock. Also in this pass: colorVariant 3 was [+0.04,-0.04,+0.06],
 * raising red and blue while cutting green, which rendered a quarter of every
 * species magenta (a lilac wolf, a salmon horse) — replaced with a ruddy shift
 * that preserves the R>=G>=B ordering every mammal coat has; horse/donkey neck
 * lean 0.38 -> 0.74/0.86 rad (it was near-vertical, reading as a llama); and
 * dragon/griffin wings enlarged so the wingspan dominates the planform the way
 * it does in the reference art (dragon fingers ~1.4x longer plus a fifth spar,
 * griffin primaries split and the dihedral flattened so span is not eaten by
 * roll). Verified in-game via scripts/creature-walk.mjs before rebaselining.
 * Old hash (pre rotation-chain matrix composition): 0xf50fef89. assembleParts
 * now collapses each part's chain into a single matrix instead of re-applying
 * every rotation per vertex — a pure speed change (three-segment legs put the
 * cannon on a three-deep chain and tripled its vertex count, which took the
 * creature-heavy scene from 60 fps to 15). It moves NO geometry, but it
 * reassociates float operations, so the hash necessarily shifts. The new
 * yaw-invariance test above is what actually proves correctness here: measured
 * worst deviation is 6.7e-7 m, i.e. float32 ULP.
 * Old hash (pre two-mass torso / chest-rooted necks): 0x3a6163e1. The torso was
 * a single ellipsoid — one barrel, the same depth and width from shoulder to
 * hip — so a cow and a horse differed mainly in colour. It is now a chest plus
 * an abdomen with per-species widths and depths (TORSO_SHAPE), which is what
 * lets a deer tuck its belly, a cow drop hers below the brisket, and a wolf
 * carry a deep chest over a hard waist; horse and deer also gained withers.
 * The surface helpers rearZAt/torsoTopAt now take the MAX over both masses, or
 * tails and necks would detach on exactly the species whose second mass is the
 * relevant one. Necks moved from a fixed root on top of the shoulder blades to
 * a per-species root on the front of the chest (NECK_SHAPE rootZ/rootY) — the
 * wolf previously had no visible neck at all because its head sat straight on
 * its shoulders. The bear hump and wolf dorsal saddle were anchored to the old
 * bounding-box lid and floated clear of the new surface, so both are reseated
 * via torsoTopAt (the saddle as a run of short plates that follow the topline).
 * Cow and rabbit gained muzzles and nose pads; the cow's muzzle is derived from
 * its coat rather than reusing bellyC, which is its dark piebald-patch brown
 * and put a chocolate sausage on the front of its face.
 * Verified in-game via scripts/creature-walk.mjs before rebaselining.
 * Old hash (pre dragon rebuild): 0xd9df3e6b. The dragon's head went from three
 * beveled boxes to a rounded cranium + tapered snout + hinged jaw + brows,
 * teeth and eyes; the wings gained a real arm (humerus/forearm/wrist), a
 * scalloped and cambered membrane, an inner panel down to the flank, and the
 * ability to FOLD when the animal is not flying; neck and tail moved from
 * per-segment lean chains (which cannot describe an S-curve) to cubic Bezier
 * arcs; and the legs moved from rigid hip pitch to three-segment planted-foot
 * IK on ../anim/gait. NOTE: this hash is over ALL_SPECIES, so concurrent
 * quadruped work shifts it too — recompute rather than assuming a conflict.
 * Old hash (pre species-identity pass): 0xd68286a7. The brief was "the bear
 * looks wild but I would like this looked at for all models" — go species by
 * species and make each one unmistakably itself. What moved, and why:
 *
 * EARS, everywhere. They were axis-aligned boxes standing straight up on every
 * species but the wolf. `makeEarPart` replaces them with splayed, raked blades
 * (EAR_SHAPE), and the ANGLE is the point: a cow's ears stick out sideways
 * (1.32 rad — the specific thing the user named), a bear's are round buttons
 * set wide on the crown, a deer's are outward scoops, a donkey's are held
 * wide. Ear carriage reads from much further away than ear outline.
 *
 * EYES, everywhere. Every quadruped, the bird, the griffin and the serpent
 * were blind; on a wool doll a face without eyes is a sack with a nose on it,
 * and it was most of why the herbivores were interchangeable close up.
 *
 * BEAR. Reported as reading wild, and it was reading as a CAMEL: a ball of a
 * body with an isolated dome on top and a small head out on the end of a
 * horizontal stalk. Fixed on four axes, all of which mattered. The torso went
 * long and low (bodyL 0.56 -> 0.64, bodyH 0.56 -> 0.50) with a topline that
 * slopes from shoulder to rump; the hump moved forward over the shoulder
 * blades, lengthened, and sank into the chest so it finishes the back line
 * instead of perching on it; the neck went short, thick and rooted high and
 * back so skull, neck and hump are one mass; and the head gained a downward
 * TILT (-0.34 rad) over a brow ridge and a short square muzzle. The head was
 * also, briefly, 0.42 s wide and 0.24 s deep — HEAD_SHAPE's `w` column is a
 * HALF-width while `d` is a full extent, so it had become a pancake rotated 90
 * degrees, which is the exact bug that table's own comment warns about.
 *
 * COW. Shape-correct but reading white and sheep-ish, because mid-brown
 * markings on a 0.85-value hide are barely a value step once the sun is on
 * them. Patch colour taken to a dark chocolate, patch radii roughly doubled,
 * five of them wrapping the barrel, sunk 8% instead of 15% so each reads as a
 * broad flat cap rather than a dome; plus a dark poll-and-cheek patch on the
 * head and horns swept from 0.85 to 1.24 rad off vertical.
 *
 * BIRD. Was a sphere with an equally large sphere on top and two flat panels
 * held out sideways whatever it was doing. Rebuilt: plump egg body with a pale
 * breast, small head, beak, eye, a real FOLDED wing lying back along the flank,
 * and a swept tail. Folding a wing is TWO rotations, a drop AND a sweep; doing
 * only the drop is why the first attempt still stuck out like a dart.
 *
 * SEA SERPENT. Was four capsules laid end to end with the axis inset by the
 * radius at both ends, so consecutive links did not touch: a row of loose beads
 * with a fifth in front of them for a head. Rebuilt as a six-link articulated
 * chain where each link carries the rotations of every link ahead of it,
 * overlapping 20%, bending in two planes, with a reared head (jaw, eyes, brow
 * horns), a dorsal spike run and a tail fluke.
 *
 * GRIFFIN. The eagle/lion split was carried only by MATERIAL over one tawny
 * body colour, and at distance two fur variants of the same gold are one gold
 * animal — it read as a lion with panels bolted on. The eagle half now differs
 * in VALUE: a cream hood over head, neck and breast meeting the lion coat at a
 * ruff, gold talons in front and lion paws behind. Its wings were a stack of
 * independently rolled rectangles which from above were visibly disconnected
 * with a staircase for an outline; `makeWingPart` replaces them with one
 * continuous station-based surface whose sweep and taper live in the geometry.
 * Resting dihedral came down from 0.34 + 0.38 rad of progressive roll (which
 * put the outer primary 67 degrees above horizontal — side-on, a totem pole of
 * billboards) to a near-flat 0.10.
 *
 * WOLF. Tail was a straight horizontal rod; it is now a two-link brush carried
 * low. Muzzle was a pale needle a quarter of a metre long — a stork's bill —
 * and is now a wedge in a colour one step off the mask. Body deepened and
 * lengthened off what were whippet proportions, the dorsal saddle widened from
 * a spine stripe invisible from every angle but overhead, and a pale throat bib
 * added so the head separates from the body.
 *
 * Also: horse/donkey mane crest from a beveled plank standing on the neck's
 * trailing edge to a rounded crest that lies on it, horse muzzle from white to
 * a shade darker than the coat with a dark nose, both tails thickened and both
 * bodies deepened; deer antlers recoloured from coat-brown to bone and given a
 * pale rump patch behind the flag tail; rabbit ears recoloured from near-black
 * to coat with pink inners, and its base coat warmed off a cream that read the
 * same as the cow's hide at distance; bear front claws added.
 *
 * PERFORMANCE. Creature meshes are rebuilt on the CPU every frame for every
 * visible entity, so new geometry has to be paid for rather than added. The
 * new parts were funded by dropping tessellation where it cannot be seen: the
 * twelve leg capsules went from 6 sides to 5 (they are 46% of a quadruped's
 * vertices and are thin tubes), paws 6x4 -> 5x3, cow patches 8x5 -> 7x4, and
 * the bird — small on screen and usually several at once — lost a ring off its
 * body and head. Heads and torsos kept their ring counts on purpose: they are
 * large, curved and the thing you actually look at. Net result is that every
 * quadruped is at or BELOW its pre-pass vertex count (rabbit 4962 -> 4818,
 * deer 5202 -> 5010, cow 5898 -> 5760, wolf 5634 -> 5418, bear 5022 -> 5010,
 * horse/donkey within 12) and the bird within 36, with only the two rare
 * species — griffin and sea serpent, one on screen at a time — up materially.
 *
 * Verified species by species in-game via scripts/creature-portraits.mjs (four
 * views each, each differenced against a subject-collapsed plate to prove the
 * animal is actually in frame) and scripts/creature-walk.mjs, before
 * rebaselining.
 */
const GOLDEN_HASH: number | null = 0xfb29eece;

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
  console.log(`\ngolden hash (all 11 species): 0x${computedHash.toString(16).padStart(8, '0')}`);
  console.log('(bake this into GOLDEN_HASH once you are satisfied with the meshes)');
} else {
  check('golden hash matches all 11 species',
    computedHash === GOLDEN_HASH,
    `got 0x${computedHash.toString(16)} want 0x${GOLDEN_HASH.toString(16)}`);
}

// ===========================================================================
// APPENDED BLOCK — dragon rebuild + wyvern coverage.
//
// Added by the dragon/wyvern workstream. Kept as one self-contained block at
// the end of the file, and the wyvern is deliberately NOT added to
// ALL_SPECIES: that array feeds the golden hash and several "the dragon is
// the biggest" assertions above, and widening it would tangle this work with
// whoever else is editing this file. Everything the wyvern needs is asserted
// here instead.
// ===========================================================================

{
  const WYVERN: Species = 'wyvern';
  const FOLDED: AnimalPose = { yaw: 0, walkPhase: 0, walkAmp: 0 };
  const OPEN: AnimalPose = {
    yaw: 0, walkPhase: 0, walkAmp: 1, flapPhase: 0, flapAmp: 1,
  };

  // --- The wyvern exists and is well-formed -------------------------------
  const w = buildAnimalMesh(WYVERN, ANIMAL_IDLE_POSE);
  console.log(`\n-- appended: wyvern --\n  wyvern       ${w.count} verts`);
  check('wyvern: vert count > 0', w.count > 0);
  check('wyvern: vert count <= ANIMAL_MAX_VERTS',
    w.count <= ANIMAL_MAX_VERTS, `count=${w.count} max=${ANIMAL_MAX_VERTS}`);
  check('wyvern: vert count divisible by 3 (triangles)', w.count % 3 === 0);
  check('wyvern: float array length = count * 10', w.verts.length === w.count * 10);
  {
    let ok = true;
    for (let i = 6; i < w.verts.length; i += 10) {
      for (let k = 0; k < 3; k++) {
        if (w.verts[i + k] < 0 || w.verts[i + k] > 1) ok = false;
      }
    }
    check('wyvern: vertex colors in [0,1]', ok);
  }
  check('wyvern: deterministic output',
    fnv1a(new Uint8Array(buildAnimalMesh(WYVERN, ANIMAL_IDLE_POSE).verts.buffer)) ===
    fnv1a(new Uint8Array(buildAnimalMesh(WYVERN, ANIMAL_IDLE_POSE).verts.buffer)));
  check('wyvern: walkPhase changes mesh',
    fnv1a(new Uint8Array(buildAnimalMesh(WYVERN, WALK_POSE_A).verts.buffer)) !==
    fnv1a(new Uint8Array(buildAnimalMesh(WYVERN, WALK_POSE_B).verts.buffer)));
  {
    const v0 = buildAnimalMesh(WYVERN, ANIMAL_IDLE_POSE, undefined, 0).verts;
    const v1 = buildAnimalMesh(WYVERN, ANIMAL_IDLE_POSE, undefined, 1).verts;
    check('wyvern: colorVariant 1 differs from variant 0',
      fnv1a(new Uint8Array(v0.buffer)) !== fnv1a(new Uint8Array(v1.buffer)));
    let geo = true;
    for (let i = 0; i < v0.length; i += 10) {
      if (v0[i] !== v1[i] || v0[i + 1] !== v1[i + 1] || v0[i + 2] !== v1[i + 2]) {
        geo = false; break;
      }
    }
    check('wyvern: colorVariant changes only color, not geometry', geo);
  }
  // Yaw invariance — the property that catches a pose chain composed in the
  // wrong order, which no bounding box or vertex count can see.
  {
    let worst = 0;
    for (const yaw of [0.5, 1.7, -2.3, Math.PI]) {
      const flat = buildAnimalMesh(WYVERN,
        { yaw: 0, walkPhase: 1.0, walkAmp: 0.8 }).verts;
      const posed = buildAnimalMesh(WYVERN,
        { yaw, walkPhase: 1.0, walkAmp: 0.8 }).verts;
      const s2 = Math.sin(yaw), c2 = Math.cos(yaw);
      for (let i = 0; i < flat.length; i += 10) {
        const x = flat[i], y = flat[i + 1], z = flat[i + 2];
        worst = Math.max(worst,
          Math.abs(x * c2 - z * s2 - posed[i]),
          Math.abs(y - posed[i + 1]),
          Math.abs(x * s2 + z * c2 - posed[i + 2]));
      }
    }
    check('wyvern: yaw is applied outermost (pose is yaw-invariant)',
      worst < 5e-6, `worst vertex mismatch ${worst.toExponential(2)} m`);
  }

  // --- Smaller and weaker than the dragon ---------------------------------
  const wDef = SPECIES_DEFS.wyvern, dDef = SPECIES_DEFS.dragon;
  check('wyvern is smaller than the dragon', wDef.size < dDef.size,
    `${wDef.size} vs ${dDef.size}`);
  check('wyvern has less hp than the dragon', wDef.hp < dDef.hp);
  check('wyvern hits softer than the dragon',
    (wDef.attackDmg ?? 0) < (dDef.attackDmg ?? 0));
  check('wyvern mesh is shorter than the dragon mesh',
    aabb(buildAnimalMesh(WYVERN, ANIMAL_IDLE_POSE).verts).hi[1] <
    aabb(buildAnimalMesh('dragon', ANIMAL_IDLE_POSE).verts).hi[1]);

  // --- Wings: they exist, they fold, and they are the silhouette ----------
  // The fold is the headline behavioural change, and it is invisible in any
  // single still: what proves it is the same mesh measured at two flap
  // amplitudes.
  for (const sp of [WYVERN, 'dragon'] as Species[]) {
    const size = SPECIES_DEFS[sp].size;
    const foldBB = aabb(buildAnimalMesh(sp, FOLDED).verts);
    const openBB = aabb(buildAnimalMesh(sp, OPEN).verts);
    const foldSpan = foldBB.hi[0] - foldBB.lo[0];
    const openSpan = openBB.hi[0] - openBB.lo[0];
    check(`${sp}: wings open to at least 2.5x shoulder height`,
      openSpan >= size * 2.5,
      `open span ${openSpan.toFixed(2)} m vs size ${size} m`);
    check(`${sp}: wings FOLD at rest (furled span < 45% of open span)`,
      foldSpan < openSpan * 0.45,
      `folded ${foldSpan.toFixed(2)} m vs open ${openSpan.toFixed(2)} m`);
    // Furled, the wing must actually tuck against the animal rather than just
    // shrinking: it may overhang the body by a little (a folded knuckle does)
    // but not by a wingspan.
    check(`${sp}: furled wings tuck close to the body`,
      foldSpan < size * 1.4,
      `folded span ${foldSpan.toFixed(2)} m vs size ${size} m`);
    check(`${sp}: open planform is wider than long`,
      openSpan > (openBB.hi[2] - openBB.lo[2]),
      `span ${openSpan.toFixed(2)} m vs length ${(openBB.hi[2] - openBB.lo[2]).toFixed(2)} m`);
  }

  // --- Planted feet: the constraint that makes the IK legs worth having ---
  //
  // Both species solve their feet against `animalStride`, which the AI also
  // uses to advance walkPhase. If the limb cannot REACH that stride the
  // solver clamps, the foot stops where the leg runs out instead of where the
  // gait asked, and the skating comes back with a hitch in it. Asserting the
  // reach directly is the only way to catch that — it is completely invisible
  // in a still frame and nearly invisible in motion.
  check('dragon: limbs can cover the stride the AI advances by',
    dragonMaxStride() >= animalStride('dragon'),
    `reach ${dragonMaxStride().toFixed(2)} m vs stride ${animalStride('dragon').toFixed(2)} m`);
  check('wyvern: limbs can cover the stride the AI advances by',
    wyvernMaxStride() >= animalStride('wyvern'),
    `reach ${wyvernMaxStride().toFixed(2)} m vs stride ${animalStride('wyvern').toFixed(2)} m`);

  for (const sp of [WYVERN, 'dragon'] as Species[]) {
    const size = SPECIES_DEFS[sp].size;
    const tol = size * 0.015;
    let worstSink = 0, liftSeen = 0;
    for (let i = 0; i < 64; i++) {
      const phase = (i / 64) * Math.PI * 2;
      const { verts } = buildAnimalMesh(sp,
        { yaw: 0, walkPhase: phase, walkAmp: 1, flapPhase: phase, flapAmp: 1 });
      let minY = Infinity;
      for (let v = 0; v < verts.length; v += 10) {
        if (verts[v + 1] < minY) minY = verts[v + 1];
      }
      worstSink = Math.min(worstSink, minY);
      liftSeen = Math.max(liftSeen, minY);
    }
    check(`${sp}: feet never sink through the ground while walking`,
      worstSink > -tol,
      `lowest point ${worstSink.toFixed(4)} m (tolerance ${(-tol).toFixed(4)})`);
    // Both gaits run below duty 0.5 and therefore HAVE a suspension phase, so
    // a brief clearance is correct — but only a brief one, or the animal is
    // flying rather than running.
    check(`${sp}: suspension clears the ground by no more than a hand`,
      liftSeen < size * 0.05,
      `clears ${liftSeen.toFixed(4)} m, budget ${(size * 0.05).toFixed(4)} m`);
    const rest = buildAnimalMesh(sp, FOLDED).verts;
    let restMin = Infinity;
    for (let v = 0; v < rest.length; v += 10) {
      if (rest[v + 1] < restMin) restMin = rest[v + 1];
    }
    check(`${sp}: stands on the ground at rest`,
      Math.abs(restMin) < tol, `lowest point ${restMin.toFixed(4)} m`);
    // A rig where every foot stayed planted would pass everything above while
    // animating nothing.
    check(`${sp}: walking pose differs from standing pose`,
      fnv1a(new Uint8Array(buildAnimalMesh(sp, FOLDED).verts.buffer)) !==
      fnv1a(new Uint8Array(buildAnimalMesh(sp,
        { yaw: 0, walkPhase: 1.1, walkAmp: 1 }).verts.buffer)));
  }

  // --- Species wiring: common, but hard to tame ---------------------------
  check('wyvern is a rare-class (taming-required) mountable',
    needsTaming('wyvern'), 'needsTaming(wyvern) must be true');
  check('wyvern takes more feeds to tame than a dragon',
    feedsToTame('wyvern') > feedsToTame('dragon'),
    `wyvern ${feedsToTame('wyvern')} vs dragon ${feedsToTame('dragon')}`);
  check('wyvern bucks more often than a dragon',
    tameProfile('wyvern').buckChance > tameProfile('dragon').buckChance);
  check('dragon/griffin taming is unchanged by the new profile tier',
    tameProfile('dragon') === DEFAULT_TAME_PROFILE &&
    tameProfile('griffin') === DEFAULT_TAME_PROFILE);
  check('wyvern outweighs the dragon in the rare-spawn draw',
    (SPECIES_DEFS.wyvern.rareWeight ?? 1) > (SPECIES_DEFS.dragon.rareWeight ?? 1));
  check('wyvern lives in strictly more biomes than the dragon',
    SPECIES_DEFS.wyvern.biomes.length > SPECIES_DEFS.dragon.biomes.length,
    `${SPECIES_DEFS.wyvern.biomes.join('/')} vs ${SPECIES_DEFS.dragon.biomes.join('/')}`);
  check('wyvern is visually distinct from the dragon (blue, not red)',
    BASE_COLORS.wyvern[2] > BASE_COLORS.wyvern[0] &&
    BASE_COLORS.dragon[0] > BASE_COLORS.dragon[2],
    `wyvern ${BASE_COLORS.wyvern.join(',')} dragon ${BASE_COLORS.dragon.join(',')}`);
}

// ===========================================================================
// APPENDED BLOCK — the four humanoid dungeon enemies.
//
// Same containment rule the wyvern block above uses, and for the same reason:
// `ALL_SPECIES` feeds the golden hash and several "the dragon is the biggest"
// assertions, so widening it would move `GOLDEN_HASH` and tangle this
// workstream with whoever else is editing this file. The enemies get their own
// self-contained assertions and their own hash instead.
// ===========================================================================

{
  const ENEMIES: Species[] = ['goblin', 'goblin_archer', 'skeleton', 'dread_king'];
  const REST: AnimalPose = { yaw: 0, walkPhase: 0, walkAmp: 0 };
  const STRIDING: AnimalPose = { yaw: 0, walkPhase: 1.7, walkAmp: 1 };

  console.log('\n-- appended: humanoid enemies --');
  let enemyMax = 0;
  for (const sp of ENEMIES) {
    const m = buildAnimalMesh(sp, ANIMAL_IDLE_POSE);
    enemyMax = Math.max(enemyMax, m.count);
    console.log(`  ${sp.padEnd(14)} ${m.count} verts`);

    check(`${sp}: vert count > 0`, m.count > 0);
    check(`${sp}: vert count <= ANIMAL_MAX_VERTS`,
      m.count <= ANIMAL_MAX_VERTS, `count=${m.count} max=${ANIMAL_MAX_VERTS}`);
    check(`${sp}: vert count divisible by 3 (triangles)`, m.count % 3 === 0);
    check(`${sp}: float array length = count * 10`, m.verts.length === m.count * 10);

    let colOk = true;
    for (let i = 6; i < m.verts.length; i += 10) {
      for (let k = 0; k < 3; k++) {
        if (m.verts[i + k] < 0 || m.verts[i + k] > 1) colOk = false;
      }
    }
    check(`${sp}: vertex colors in [0,1]`, colOk);

    check(`${sp}: deterministic output`,
      fnv1a(new Uint8Array(buildAnimalMesh(sp, ANIMAL_IDLE_POSE).verts.buffer)) ===
      fnv1a(new Uint8Array(buildAnimalMesh(sp, ANIMAL_IDLE_POSE).verts.buffer)));
    check(`${sp}: walkPhase changes the mesh`,
      fnv1a(new Uint8Array(buildAnimalMesh(sp, WALK_POSE_A).verts.buffer)) !==
      fnv1a(new Uint8Array(buildAnimalMesh(sp, WALK_POSE_B).verts.buffer)));
    check(`${sp}: colorVariant 1 differs from variant 0`,
      fnv1a(new Uint8Array(buildAnimalMesh(sp, ANIMAL_IDLE_POSE, undefined, 0).verts.buffer)) !==
      fnv1a(new Uint8Array(buildAnimalMesh(sp, ANIMAL_IDLE_POSE, undefined, 1).verts.buffer)));

    // --- it stands on the floor -------------------------------------------
    //
    // The single most valuable geometric assertion for a biped. A humanoid
    // whose feet hang 4 cm in the air or sink 4 cm into it reads as broken
    // instantly and is invisible in any framed screenshot taken from eye
    // level. Checked at rest AND mid-stride, because the IK re-solves every
    // frame and only the rest pose is hand-authored.
    for (const [label, pose] of [['rest', REST], ['striding', STRIDING]] as const) {
      const { lo } = aabb(buildAnimalMesh(sp, pose).verts);
      check(`${sp}: feet on the floor (${label})`,
        Math.abs(lo[1]) < 0.05, `lowest point ${lo[1].toFixed(4)} m`);
    }

    // --- the rig and the AI agree on stride --------------------------------
    //
    // The planted-foot contract in one line. The AI advances `walkPhase` by
    // `distance / animalStride`, and the mesh sweeps its stance over
    // `humanoidStride * duty`. If the two numbers ever differ the feet skate
    // by exactly that ratio, and nothing about a still frame reveals it. Same
    // assertion the wyvern carries.
    check(`${sp}: humanoidStride === animalStride`,
      Math.abs(humanoidStride(sp) - animalStride(sp)) < 1e-9,
      `${humanoidStride(sp)} vs ${animalStride(sp)}`);
    check(`${sp}: stride is inside what the leg can reach`,
      humanoidStride(sp) <= humanoidMaxStride(sp) + 1e-9,
      `stride ${humanoidStride(sp).toFixed(3)} max ${humanoidMaxStride(sp).toFixed(3)}`);
    check(`${sp}: stride is a sane fraction of standing height`,
      humanoidStride(sp) > SPECIES_DEFS[sp].size * 0.35
      && humanoidStride(sp) < SPECIES_DEFS[sp].size * 1.6,
      `${humanoidStride(sp).toFixed(3)} m for size ${SPECIES_DEFS[sp].size}`);
  }

  // --- silhouette: size contrast is the primary read ------------------------
  //
  // Asserted as GEOMETRY rather than as the `size` field, because `size` is
  // shoulder height and what the player actually compares is total standing
  // height. CHARACTER_HEIGHT is 1.62.
  const heightOf = (sp: Species): number => aabb(buildAnimalMesh(sp, REST).verts).hi[1];
  const gob = heightOf('goblin');
  const skel = heightOf('skeleton');
  const king = heightOf('dread_king');
  console.log(`  standing heights: goblin ${gob.toFixed(2)} m, skeleton ${skel.toFixed(2)} m, king ${king.toFixed(2)} m (player 1.62 m)`);
  check('goblin is clearly SHORTER than the player', gob < 1.62 * 0.85, `${gob.toFixed(2)} m`);
  check('skeleton is TALLER than the player', skel > 1.62, `${skel.toFixed(2)} m`);
  check('the boss dwarfs everything', king > 1.62 * 1.35 && king > skel * 1.25,
    `king ${king.toFixed(2)} vs skeleton ${skel.toFixed(2)}`);
  check('the boss is the widest of the three (shoulders)',
    aabb(buildAnimalMesh('dread_king', REST).verts).hi[0]
      > aabb(buildAnimalMesh('skeleton', REST).verts).hi[0],
    'pauldrons must put him outside a skeleton in silhouette');

  // --- the skeleton is see-through -----------------------------------------
  //
  // "If you cannot see through the torso, it has failed." Measured as the
  // fraction of chest-height vertices that sit near the body's centre axis:
  // a solid torso fills it, a ribcage leaves it almost empty. This is the one
  // property that separates a skeleton from a pale goblin, and it is exactly
  // the kind of thing that silently regresses when someone tidies up the rib
  // loop.
  {
    const m = buildAnimalMesh('skeleton', REST);
    const { lo, hi } = aabb(m.verts);
    const chestY0 = lo[1] + (hi[1] - lo[1]) * 0.58;
    const chestY1 = lo[1] + (hi[1] - lo[1]) * 0.78;
    let inBand = 0, nearCore = 0;
    for (let i = 0; i < m.count; i++) {
      const y = m.verts[i * 10 + 1];
      if (y < chestY0 || y > chestY1) continue;
      inBand++;
      const x = m.verts[i * 10], z = m.verts[i * 10 + 2];
      if (Math.hypot(x, z) < 0.05) nearCore++;
    }
    check('skeleton chest band has vertices at all', inBand > 200, `${inBand}`);
    check('skeleton torso is hollow (ribs, not a solid mass)',
      nearCore / Math.max(1, inBand) < 0.20,
      `${((nearCore / inBand) * 100).toFixed(1)}% of chest verts sit on the core axis`);
  }

  // --- materials ------------------------------------------------------------
  {
    const matsOf = (sp: Species): Set<number> => {
      const m = buildAnimalMesh(sp, REST);
      const out = new Set<number>();
      for (let i = 0; i < m.count; i++) out.add(m.verts[i * 10 + 9]);
      return out;
    };
    const skelMats = matsOf('skeleton');
    check('skeleton is built from BONE', skelMats.has(MAT.BONE));
    check('skeleton is NOT knitted wool (it would read as a pale doll)',
      !skelMats.has(MAT.KNIT));
    const kingMats = matsOf('dread_king');
    check('the boss wears iron and gold',
      kingMats.has(MAT.IRON) && kingMats.has(MAT.GOLD));
    check('the boss has emissive eyes (GEM) — menace at 50 m for two spheres',
      kingMats.has(MAT.GEM));
    check('goblins are skin and felt, not scale',
      matsOf('goblin').has(MAT.SKIN) && !matsOf('goblin').has(MAT.SCALE));
  }

  // --- they never leak into the overworld -----------------------------------
  //
  // `entity-scatter.ts` derives COMMON_SPECIES from every non-rare key of
  // SPECIES_DEFS and filters on `biomes.includes(biome)`. An empty biome list
  // is the ONLY thing keeping these underground, so it is worth a test rather
  // than a comment.
  for (const sp of ENEMIES) {
    check(`${sp}: has no overworld biome (dungeon-only)`,
      SPECIES_DEFS[sp].biomes.length === 0);
    check(`${sp}: is not 'rare' (rare+aggro would make it territorial)`,
      SPECIES_DEFS[sp].rare === false);
    check(`${sp}: is not mountable`, SPECIES_DEFS[sp].mountable === false);
  }

  /**
   * Golden hash over the four enemies at the shared canonical pose.
   *
   * Separate from the 11-species `GOLDEN_HASH` above on purpose (see the block
   * header). Update ONLY on a deliberate change to the humanoid rig, and say
   * what moved and why, newest first.
   *
   * Baselined 2026-07-25 (0x34aa1454) on the first landing of
   * `humanoid-mesh.ts`.
   *
   * Verified before baking, and it took four passes — recorded because each
   * defect was invisible to a different check:
   *
   *   - The archer's bow hung 23 cm THROUGH the floor. Caught by the
   *     feet-on-the-floor AABB assertion above, not by any screenshot: a
   *     goblin's arms reach its knees, so a bow centred on its fist is
   *     underground, and no camera angle a portrait harness picks shows it.
   *   - The goblin's eyes and the King's emissive eyes were placed INSIDE
   *     their heads (0.62 of a head-radius forward, when the surface at that
   *     width is 0.86). Both faces rendered as smooth blobs. Only a framed
   *     close-up showed it; nothing numeric was wrong.
   *   - The King's breastplate and the goblin's jerkin were `bevelBox` plates
   *     scaled off `chestRY`, so they reached from navel to jaw and rendered
   *     as slabs over both faces. A box circumscribes the ellipsoid it clothes;
   *     both are hugging `makeBoxSpherePart` shells now.
   *   - The cape was a single flat quad strip 1.75 m wide — a red door with a
   *     King behind it. It is a 5x5 curved shell that wraps the shoulders.
   *
   * Verified via scripts/creature-portraits.mjs (four framed views per species,
   * each differenced against a subject-collapsed plate so the model is proven
   * to be in frame), scripts/creature-walk.mjs, scripts/anim-attack.mjs (all
   * three boss moves, scrubbed to their declared contact frames), and
   * scripts/dungeon-enemies-shot.mjs, which photographs the roster underground
   * where it is actually met.
   */
  const GOLDEN_ENEMY_HASH: number | null = ENEMY_GOLDEN;
  const bytes: number[] = [];
  for (const sp of ENEMIES) {
    const { verts } = buildAnimalMesh(sp, CANONICAL_POSE, undefined, 0);
    const b = new Uint8Array(verts.buffer);
    for (let i = 0; i < b.length; i++) bytes.push(b[i]);
  }
  const enemyHash = fnv1a(new Uint8Array(bytes));
  if (GOLDEN_ENEMY_HASH === null) {
    console.log(`  golden hash (4 enemies): 0x${enemyHash.toString(16).padStart(8, '0')}`);
    check('humanoid golden hash is baked', false, 'set ENEMY_GOLDEN above');
  } else {
    check('golden hash matches the four humanoid enemies',
      enemyHash === GOLDEN_ENEMY_HASH,
      `got 0x${enemyHash.toString(16)} want 0x${GOLDEN_ENEMY_HASH.toString(16)}`);
  }

  console.log(`  humanoid max = ${enemyMax} verts (ANIMAL_MAX_VERTS ${ANIMAL_MAX_VERTS})`);
  check('humanoid enemies stay well inside the vertex budget',
    enemyMax < ANIMAL_MAX_VERTS * 0.75,
    `max ${enemyMax} vs 75% of ${ANIMAL_MAX_VERTS}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\nANIMAL_MAX_VERTS = ${ANIMAL_MAX_VERTS}  (actual max across species = ${actualMax})`);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
