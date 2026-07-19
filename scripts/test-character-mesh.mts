/**
 * Deterministic tests for the blocky character mesh builder
 * (src/game/character/character-mesh.ts). Pure CPU — no GPU, no server.
 * Run:  npx tsx scripts/test-character-mesh.mts
 *
 * The golden FNV hash is the determinism tripwire: if buildCharacterMesh
 * output changes for any reason, this fails and the change must be
 * deliberate (update the constant in the same commit + eyeball in-game).
 */

import {
  buildCharacterMesh, DEFAULT_CUSTOMIZATION, IDLE_POSE,
  CHARACTER_HEIGHT, CHARACTER_MAX_VERTS, type HeldItem,
  type ArmorTier,
} from '../src/game/character/character-mesh';

/** Update ONLY on deliberate character-mesh changes (see header). */
const GOLDEN_HASH: number | null = 0xac0ac8b5;

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

function aabb(verts: Float32Array) {
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

// --- default customization, idle pose ---------------------------------------

const idle = buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE);

check('interleaved stride divides evenly', idle.length % 6 === 0);
const vertCount = idle.length / 6;
check('vertex count in budget (250–400, ≤ MAX)',
  vertCount >= 250 && vertCount <= 400 && vertCount <= CHARACTER_MAX_VERTS,
  `count=${vertCount}`);
check('vertex count divides into triangles', vertCount % 3 === 0);

const { lo, hi } = aabb(idle);
check('feet at y=0', lo[1] === 0, `minY=${lo[1]}`);
check('head top at CHARACTER_HEIGHT (+hair)',
  hi[1] >= CHARACTER_HEIGHT && hi[1] < CHARACTER_HEIGHT + 0.15,
  `maxY=${hi[1].toFixed(2)}`);
check('stays inside the capsule footprint',
  lo[0] > -0.5 && hi[0] < 0.5 && lo[2] > -0.5 && hi[2] < 0.5,
  `x=[${lo[0].toFixed(2)},${hi[0].toFixed(2)}] z=[${lo[2].toFixed(2)},${hi[2].toFixed(2)}]`);

let colorsInRange = true;
for (let i = 0; i < idle.length; i += 6) {
  for (let k = 3; k < 6; k++) {
    if (idle[i + k] < 0 || idle[i + k] > 1) colorsInRange = false;
  }
}
check('vertex colors in [0,1]', colorsInRange);

// --- pose variations ---------------------------------------------------------

const idleHash = fnv1a(new Uint8Array(idle.buffer));
const walking = buildCharacterMesh(DEFAULT_CUSTOMIZATION,
  { yaw: 0, walkPhase: 1.2, walkAmp: 1, attackT: 0 });
check('walk pose changes the mesh',
  fnv1a(new Uint8Array(walking.buffer)) !== idleHash);

const attacking = buildCharacterMesh(DEFAULT_CUSTOMIZATION,
  { yaw: 0, walkPhase: 0, walkAmp: 0, attackT: 0.5 });
check('attack pose changes the mesh',
  fnv1a(new Uint8Array(attacking.buffer)) !== idleHash);

const turned = buildCharacterMesh(DEFAULT_CUSTOMIZATION,
  { yaw: Math.PI / 3, walkPhase: 0, walkAmp: 0, attackT: 0 });
const turnedBox = aabb(turned);
check('yaw preserves height', Math.abs(turnedBox.hi[1] - hi[1]) < 1e-6);
check('yaw changes the mesh', fnv1a(new Uint8Array(turned.buffer)) !== idleHash);

// --- customization variations ------------------------------------------------

const bald = buildCharacterMesh(
  { ...DEFAULT_CUSTOMIZATION, hairStyle: 0 }, IDLE_POSE);
const longHair = buildCharacterMesh(
  { ...DEFAULT_CUSTOMIZATION, hairStyle: 2 }, IDLE_POSE);
check('hair styles change vertex count',
  bald.length < idle.length && longHair.length > idle.length,
  `bald=${bald.length / 6} crop=${vertCount} long=${longHair.length / 6}`);
check('long hair stays within MAX_VERTS',
  longHair.length / 6 <= CHARACTER_MAX_VERTS);

const recolored = buildCharacterMesh(
  { ...DEFAULT_CUSTOMIZATION, shirtColor: [0.8, 0.1, 0.1] }, IDLE_POSE);
check('recolor changes the mesh',
  fnv1a(new Uint8Array(recolored.buffer)) !== idleHash);
check('recolor preserves geometry (same count)',
  recolored.length === idle.length);

// --- held items (D-M3) -------------------------------------------------------

const HELD_KINDS: HeldItem['kind'][] = ['sword', 'axe', 'pickaxe', 'bow', 'staff'];
for (const kind of HELD_KINDS) {
  const held = buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE,
    { kind, color: [0.7, 0.7, 0.7] });
  const extra = (held.length - idle.length) / 6;
  check(`held ${kind} adds boxes within budget`,
    extra > 0 && extra % 36 === 0 && held.length / 6 <= CHARACTER_MAX_VERTS,
    `extra=${extra}`);
  const hb = aabb(held);
  check(`held ${kind} sits on the right side`, hb.hi[0] > 0.35,
    `maxX=${hb.hi[0].toFixed(2)}`);
}

// A swing moves the held item (same pitch as the right arm).
const heldIdle = buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE,
  { kind: 'axe', color: [0.7, 0.7, 0.7] });
const heldSwing = buildCharacterMesh(DEFAULT_CUSTOMIZATION,
  { yaw: 0, walkPhase: 0, walkAmp: 0, attackT: 0.5 },
  { kind: 'axe', color: [0.7, 0.7, 0.7] });
check('attack swings the held item',
  fnv1a(new Uint8Array(heldSwing.buffer)) !== fnv1a(new Uint8Array(heldIdle.buffer)));

// No held item → bit-identical to the pre-D-M3 output (golden safe).
check('null held leaves the base mesh untouched',
  fnv1a(new Uint8Array(buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE, null).buffer))
    === idleHash);

// --- determinism + golden ----------------------------------------------------

const again = buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE);
check('same inputs reproduce bit-identical mesh',
  fnv1a(new Uint8Array(again.buffer)) === idleHash);

if (GOLDEN_HASH === null) {
  console.log(`golden hash: 0x${idleHash.toString(16)} (bake into GOLDEN_HASH)`);
} else {
  check('golden character-mesh hash', idleHash === GOLDEN_HASH,
    `got 0x${idleHash.toString(16)}, want 0x${GOLDEN_HASH.toString(16)}`);
}

// =============================================================================
// NEW: female variant + armor (mesh-side only)
// =============================================================================

// ---- golden constants (baked: run once with null, printed, hard-coded) ------
const GOLDEN_FEMALE_NO_ARMOR: number  = 0x10049df5;
const GOLDEN_MALE_FULL_IRON: number   = 0x3517d151;
const GOLDEN_FEMALE_FULL_IRON: number = 0xf0abbe89;

// ---- helpers ----------------------------------------------------------------

/** Collect all vertex x-coords from a mesh interleaved as [x,y,z, r,g,b]×N. */
function xExtent(verts: Float32Array): { minX: number; maxX: number } {
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < verts.length; i += 6) {
    if (verts[i] < minX) minX = verts[i];
    if (verts[i] > maxX) maxX = verts[i];
  }
  return { minX, maxX };
}

/** Return true if any vertex in the mesh has color equal to the given RGB. */
function hasColor(verts: Float32Array, r: number, g: number, b: number,
  tol = 1e-5): boolean {
  for (let i = 3; i < verts.length; i += 6) {
    if (Math.abs(verts[i]   - r) < tol &&
        Math.abs(verts[i+1] - g) < tol &&
        Math.abs(verts[i+2] - b) < tol) return true;
  }
  return false;
}

// ---- builds -----------------------------------------------------------------

const femaleIdle    = buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE, null,
  { body: 'female' });
const maleFullIron  = buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE, null,
  { armor: { head: 'iron', body: 'iron', legs: 'iron' } });
const femaleFullIron = buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE, null,
  { body: 'female', armor: { head: 'iron', body: 'iron', legs: 'iron' } });
const maleHelmetOnly = buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE, null,
  { armor: { head: 'leather' } });
const femaleFiber   = buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE, null,
  { body: 'female', armor: { head: 'fiber', body: 'fiber', legs: 'fiber' } });
const maleLeather   = buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE, null,
  { armor: { body: 'leather', legs: 'leather' } });

// ---- golden checks ----------------------------------------------------------

check('golden female-no-armor hash',
  fnv1a(new Uint8Array(femaleIdle.buffer)) === GOLDEN_FEMALE_NO_ARMOR,
  `got 0x${fnv1a(new Uint8Array(femaleIdle.buffer)).toString(16)}`);
check('golden male-full-iron hash',
  fnv1a(new Uint8Array(maleFullIron.buffer)) === GOLDEN_MALE_FULL_IRON,
  `got 0x${fnv1a(new Uint8Array(maleFullIron.buffer)).toString(16)}`);
check('golden female-full-iron hash',
  fnv1a(new Uint8Array(femaleFullIron.buffer)) === GOLDEN_FEMALE_FULL_IRON,
  `got 0x${fnv1a(new Uint8Array(femaleFullIron.buffer)).toString(16)}`);

// ---- CHARACTER_MAX_VERTS budget checks --------------------------------------

check('CHARACTER_MAX_VERTS bumped to 612', CHARACTER_MAX_VERTS === 612);
check('female no-armor ≤ CHARACTER_MAX_VERTS',
  femaleIdle.length / 6 <= CHARACTER_MAX_VERTS,
  `verts=${femaleIdle.length / 6}`);
check('male full-iron ≤ CHARACTER_MAX_VERTS',
  maleFullIron.length / 6 <= CHARACTER_MAX_VERTS,
  `verts=${maleFullIron.length / 6}`);
check('female full-iron ≤ CHARACTER_MAX_VERTS',
  femaleFullIron.length / 6 <= CHARACTER_MAX_VERTS,
  `verts=${femaleFullIron.length / 6}`);

// ---- helmet vertex-delta check (exactly +36) --------------------------------

check('helmet adds exactly 36 verts to male',
  maleFullIron.length / 6 - idle.length / 6 === 36,
  `delta=${maleFullIron.length / 6 - idle.length / 6}`);
check('helmet adds exactly 36 verts to female',
  femaleFullIron.length / 6 - femaleIdle.length / 6 === 36,
  `delta=${femaleFullIron.length / 6 - femaleIdle.length / 6}`);
check('no helmet → no delta (male no armor = idle)',
  idle.length === buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE, null, {}).length);
check('helmet-only build adds exactly 36 verts',
  maleHelmetOnly.length / 6 - idle.length / 6 === 36,
  `delta=${maleHelmetOnly.length / 6 - idle.length / 6}`);

// ---- female torso narrower than male (x-extent comparison, idle pose) -------

const { minX: maleMinX, maxX: maleMaxX } = xExtent(idle);
const { minX: femMinX,  maxX: femMaxX  } = xExtent(femaleIdle);
// Filter to torso verts: those with y > ~0.7 (above hips) and not arm-far
// Use overall x-extent as proxy: female should be strictly narrower overall.
check('female overall x-span narrower than male',
  (femMaxX - femMinX) < (maleMaxX - maleMinX),
  `female span=${(femMaxX - femMinX).toFixed(3)} male span=${(maleMaxX - maleMinX).toFixed(3)}`);

// ---- female shorter overall -------------------------------------------------

const { hi: femHi } = aabb(femaleIdle);
const { hi: maleHi } = aabb(idle);
check('female max-y shorter than male',
  femHi[1] < maleHi[1],
  `femMaxY=${femHi[1].toFixed(3)} maleMaxY=${maleHi[1].toFixed(3)}`);
check('female max-y ~4% shorter than male (within 1%)',
  Math.abs(femHi[1] / maleHi[1] - 0.96) < 0.01,
  `ratio=${(femHi[1] / maleHi[1]).toFixed(4)}`);
check('female feet still at y=0', aabb(femaleIdle).lo[1] === 0);

// ---- armor tint colors present in meshes ------------------------------------

// iron: [0.62, 0.65, 0.70]
check('male full-iron has steel-grey color',
  hasColor(maleFullIron, 0.62, 0.65, 0.70));
check('female full-iron has steel-grey color',
  hasColor(femaleFullIron, 0.62, 0.65, 0.70));
// fiber: [0.72, 0.62, 0.38]
check('female fiber armor has woven-tan color',
  hasColor(femaleFiber, 0.72, 0.62, 0.38));
// leather: [0.45, 0.30, 0.16]
check('male leather armor has brown color',
  hasColor(maleLeather, 0.45, 0.30, 0.16));
// no-armor female still has shirt color (not iron)
check('female no-armor does NOT have steel-grey color',
  !hasColor(femaleIdle, 0.62, 0.65, 0.70));

// ---- default build is unaffected by passing empty options -------------------

check('empty options object = identical to default build',
  fnv1a(new Uint8Array(
    buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE, null, {}).buffer
  )) === idleHash);
check('explicit male body = identical to default build',
  fnv1a(new Uint8Array(
    buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE, null, { body: 'male' }).buffer
  )) === idleHash);

// ---- female + held item stays in budget -------------------------------------

const femaleWithStaff = buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE,
  { kind: 'staff', color: [0.5, 0.3, 0.1] },
  { body: 'female', armor: { head: 'iron' } });
check('female + iron helmet + held staff ≤ CHARACTER_MAX_VERTS',
  femaleWithStaff.length / 6 <= CHARACTER_MAX_VERTS,
  `verts=${femaleWithStaff.length / 6}`);

// ---- female pose variations still produce different meshes ------------------

const femaleWalking = buildCharacterMesh(DEFAULT_CUSTOMIZATION,
  { yaw: 0, walkPhase: 1.2, walkAmp: 1, attackT: 0 }, null, { body: 'female' });
check('female walk pose changes the mesh',
  fnv1a(new Uint8Array(femaleWalking.buffer)) !==
  fnv1a(new Uint8Array(femaleIdle.buffer)));

const femaleAttacking = buildCharacterMesh(DEFAULT_CUSTOMIZATION,
  { yaw: 0, walkPhase: 0, walkAmp: 0, attackT: 0.5 }, null, { body: 'female' });
check('female attack pose changes the mesh',
  fnv1a(new Uint8Array(femaleAttacking.buffer)) !==
  fnv1a(new Uint8Array(femaleIdle.buffer)));

// ---- vertex counts summary --------------------------------------------------

const femaleFullIronVerts = femaleFullIron.length / 6;
const maleFullIronVerts   = maleFullIron.length / 6;
console.log(`vert counts — male idle: ${vertCount}, female idle: ${femaleIdle.length/6}, ` +
  `male+iron: ${maleFullIronVerts}, female+iron: ${femaleFullIronVerts}`);

console.log(`${passed} passed, ${failed} failed  (${vertCount} verts idle)`);
if (failed > 0) process.exit(1);
