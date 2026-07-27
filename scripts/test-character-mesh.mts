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
import { torchFlamePos } from '../src/game/torch';

/** Update ONLY on deliberate character-mesh changes (see header).
 * Regenerated 2026-07-24 for the pos3+normal3+color3+materialId (10-float)
 * vertex format migration (per-vertex MAT.* material IDs) — every prior
 * hash was over the 9-float pos3+normal3+color3 layout (no material
 * channel) and is unrecoverably stale. Set to null and re-run to print a
 * fresh value whenever buildCharacterMesh's geometry changes. */
// Rebaselined 2026-07-25 for the character model pass: the torso is a rounded
// stuffed body instead of a flat-faced bevel box (its single flat front plane
// shaded to one value and read as a black rectangle pasted on the chest),
// hair sits on the skull as a cap and is suppressed under a helmet, the helmet
// gained a brow band / nose guard / cheek plates, and body armour contributes
// a breastplate, pauldrons and belt rather than only a tint.
// Rebaselined for the torso-shape pass: the torso is no longer a single
// ellipsoid but three stacked masses (chest, waist, hips) with per-sex width
// and depth profiles, plus deltoid caps and, on the female profile, a bust.
// Before this the female variant was the male one scaled 12% narrower and 4%
// shorter — a size change, not a shape change — so both sexes read as
// barrels with no waist. Hair styles 2 and 3 also changed: they were flat
// bevel-box slabs standing off the skull (the female's read as a cardboard
// box on her head) and are now a squashed nape mass plus tapered locks.
// CHARACTER_MAX_VERTS 6200 -> 7400; the sweep caught the overrun as a failing
// assertion instead of the black screen the previous cap increase produced.
// Verified in-game via scripts/character-portraits.mjs before rebaselining —
// which also turned out to be shooting BACK views while claiming to shoot
// fronts (orbit yaw 0 is behind the player); that is fixed too.
const GOLDEN_HASH: number | null = 0xe01fd006;

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
function aabb(verts: Float32Array) {
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

// --- default customization, idle pose ---------------------------------------

const idle = buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE);

check('interleaved stride divides evenly (pos3+normal3+color3+materialId)', idle.length % 10 === 0);
const vertCount = idle.length / 10;
check('vertex count in budget (> 0, ≤ MAX)',
  vertCount > 0 && vertCount <= CHARACTER_MAX_VERTS,
  `count=${vertCount}`);
check('vertex count divides into triangles', vertCount % 3 === 0);

const { lo, hi } = aabb(idle);
// Feet must sit exactly on y = 0 (the contract in character-mesh.ts's header).
// This briefly regressed to -0.11 during the box->capsule conversion, because
// a capsule's hemispherical cap extends a full radius past its axis endpoint;
// limbPart now insets the axis by the radius so the capsule fills the AABB the
// old box did. Keep this strict — a sink here means the character clips into
// the terrain.
check('feet at y=0',
  Math.abs(lo[1]) < 1e-4, `minY=${lo[1]}`);
check('head top at CHARACTER_HEIGHT (+hair)',
  hi[1] >= CHARACTER_HEIGHT && hi[1] < CHARACTER_HEIGHT + 0.15,
  `maxY=${hi[1].toFixed(2)}`);
check('stays inside the capsule footprint',
  lo[0] > -0.5 && hi[0] < 0.5 && lo[2] > -0.5 && hi[2] < 0.5,
  `x=[${lo[0].toFixed(2)},${hi[0].toFixed(2)}] z=[${lo[2].toFixed(2)},${hi[2].toFixed(2)}]`);

let colorsInRange = true;
for (let i = 0; i < idle.length; i += 10) {
  for (let k = 6; k < 9; k++) {
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
  `bald=${bald.length / 10} crop=${vertCount} long=${longHair.length / 10}`);
check('long hair stays within MAX_VERTS',
  longHair.length / 10 <= CHARACTER_MAX_VERTS);

const recolored = buildCharacterMesh(
  { ...DEFAULT_CUSTOMIZATION, shirtColor: [0.8, 0.1, 0.1] }, IDLE_POSE);
check('recolor changes the mesh',
  fnv1a(new Uint8Array(recolored.buffer)) !== idleHash);
check('recolor preserves geometry (same count)',
  recolored.length === idle.length);

// --- held items (D-M3) -------------------------------------------------------

// NOTE: held-item geometry is now a mix of bevelBoxes (blades/heads) and
// capsules/cylinders (hafts/grips/shafts) — no longer "N boxes of 36
// verts" — so we assert invariants (adds geometry, stays in budget,
// deterministic) instead of an exact `extra % 36 === 0` vertex count.
const HELD_KINDS: HeldItem['kind'][] = ['sword', 'axe', 'pickaxe', 'bow', 'staff', 'torch'];
for (const kind of HELD_KINDS) {
  const held = buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE,
    { kind, color: [0.7, 0.7, 0.7] });
  const held2 = buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE,
    { kind, color: [0.7, 0.7, 0.7] });
  const extra = (held.length - idle.length) / 10;
  check(`held ${kind} adds geometry within budget`,
    extra > 0 && held.length / 10 <= CHARACTER_MAX_VERTS,
    `extra=${extra}`);
  check(`held ${kind} is deterministic`,
    fnv1a(new Uint8Array(held.buffer)) === fnv1a(new Uint8Array(held2.buffer)));
  const hb = aabb(held);
  check(`held ${kind} sits on the right side`, hb.hi[0] > 0.35,
    `maxX=${hb.hi[0].toFixed(2)}`);
}

// The torch's flame anchor and its burning head must agree.
//
// torch.ts pins the point light and the billboard flame to TORCH_HEAD, a
// body-local constant that DUPLICATES numbers written in `heldParts`. Nothing
// in the type system links the two, and a torch whose flame floats 20 cm off
// the end of its own stick is the sort of thing that ships. Held geometry is
// appended last, so the tail of the buffer past the unarmed mesh IS the torch.
{
  const withTorch = buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE,
    { kind: 'torch', color: [0.75, 0.55, 0.20] });
  const tail = withTorch.subarray(idle.length);
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tail.length; i += 10) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], tail[i + a]);
      hi[a] = Math.max(hi[a], tail[i + a]);
    }
  }
  // Rest pose, no yaw, no swing: the anchor is the raw body-local constant.
  const flame = torchFlamePos(0, 0, 0, 0, 0);
  check('the torch flame sits on top of the torch head',
    flame[1] >= hi[1] - 0.12 && flame[1] <= hi[1] + 0.10,
    `flame y ${flame[1].toFixed(3)}, torch top y ${hi[1].toFixed(3)}`);
  check('and on the shaft, not beside it',
    Math.abs(flame[0] - (lo[0] + hi[0]) / 2) < 0.06
    && flame[2] >= lo[2] - 0.06 && flame[2] <= hi[2] + 0.06,
    `flame xz [${flame[0].toFixed(3)}, ${flame[2].toFixed(3)}] vs torch x `
    + `${lo[0].toFixed(3)}..${hi[0].toFixed(3)} z ${lo[2].toFixed(3)}..${hi[2].toFixed(3)}`);
  // And the walk swing has to move it the same way the arm does.
  const swung = torchFlamePos(0, 0, 0, 0, 1);
  check('a walk swing carries the flame with the arm',
    Math.hypot(swung[1] - flame[1], swung[2] - flame[2]) > 0.05,
    `moved ${Math.hypot(swung[1] - flame[1], swung[2] - flame[2]).toFixed(3)} m at full swing`);
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
// Regenerated 2026-07-24 for the pos3+normal3+color3 (9-float) vertex format.
// Rebaked 2026-07-24 again for the pos3+normal3+color3+materialId (10-float)
// migration (per-vertex MAT.* material IDs). Previously rebaked after the
// capsule winding/inset fix (degenerate pole triangles removed, limb
// capsules inset to fill their AABB). Regenerate again whenever the
// underlying mesh geometry changes deliberately.
const GOLDEN_FEMALE_NO_ARMOR: number  = 0x4b90a9e4;
const GOLDEN_MALE_FULL_IRON: number   = 0x8df3c795;
const GOLDEN_FEMALE_FULL_IRON: number = 0xd272e2b3;

// ---- helpers ----------------------------------------------------------------

/** Collect all vertex x-coords from a mesh interleaved as
 * [x,y,z, nx,ny,nz, r,g,b, materialId]×N. */
function xExtent(verts: Float32Array): { minX: number; maxX: number } {
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < verts.length; i += 10) {
    if (verts[i] < minX) minX = verts[i];
    if (verts[i] > maxX) maxX = verts[i];
  }
  return { minX, maxX };
}

/** Return true if any vertex in the mesh has color equal to the given RGB.
 * Color is at offset 6..8 of each 10-float [x,y,z, nx,ny,nz, r,g,b,
 * materialId] vertex. */
function hasColor(verts: Float32Array, r: number, g: number, b: number,
  tol = 1e-5): boolean {
  for (let i = 6; i < verts.length; i += 10) {
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

// Raised to 6200 when armour became real geometry. The sweep below, not this
// constant, is what actually secures the budget — see CHARACTER_MAX_VERTS's
// doc comment in character-mesh.ts for the black-screen this caused.
check('CHARACTER_MAX_VERTS is 7400 (three-mass torso + deltoids + bust)',
  CHARACTER_MAX_VERTS === 7400);

// ---- dragonscale tier: bone horn/spike boxes --------------------------------
const maleFullDragon = buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE, null,
  { armor: { head: 'dragon', body: 'dragon', legs: 'dragon' } });
const maleFullDragon2 = buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE, null,
  { armor: { head: 'dragon', body: 'dragon', legs: 'dragon' } });
// Dragon adds 2 helm horns + 2 shoulder spikes + 3 dorsal spikes (still
// plain boxes) over the full-iron silhouette, but the shared parts (helmet,
// torso, legs) are now sphere/bevelBox/capsule primitives whose vertex
// counts are implementation details, not "boxes × 36" — so we don't pin an
// exact vertex delta. Instead assert what actually matters: the tier adds
// geometry, deterministically, within budget.
check('full dragonscale adds bone accent geometry over full iron',
  maleFullDragon.length > maleFullIron.length,
  `dragonVerts=${maleFullDragon.length / 10} ironVerts=${maleFullIron.length / 10}`);
check('full dragonscale is deterministic',
  fnv1a(new Uint8Array(maleFullDragon.buffer)) === fnv1a(new Uint8Array(maleFullDragon2.buffer)));
check('full dragonscale ≤ CHARACTER_MAX_VERTS',
  maleFullDragon.length / 10 <= CHARACTER_MAX_VERTS,
  `verts=${maleFullDragon.length / 10}`);

// ---- exhaustive vertex-budget sweep -----------------------------------------
// CHARACTER_MAX_VERTS sizes a GPU buffer that is rewritten every frame, so
// exceeding it is not a cosmetic problem: the write overruns its allocation and
// the whole frame renders BLACK. That happened — the cap had been set from the
// "full dragonscale" case above, which does not also carry NPC accessories and
// a held item, and the true worst case was 6% higher. One hand-picked
// combination cannot secure a budget over a combinatorial option space, so
// sweep it: every armour tier on every slot, both bodies, every hair style,
// accessories on/off, every held item.
//
// The sweep must include POSES, not only equipment. It did not, and that was a
// latent hole the moment any pose started contributing geometry: the bow draw
// adds a nocked arrow (shaft + head + two fletches) that exists at no other
// attackT and in no other hand. A sweep over IDLE_POSE alone would have
// reported the budget green while the real worst case sat four parts higher.
{
  const TIERS = [undefined, 'fiber', 'leather', 'iron', 'dragon'] as const;
  const HELD_KINDS = [null, 'sword', 'axe', 'pickaxe', 'bow', 'staff'] as const;
  const POSES: { name: string; pose: typeof IDLE_POSE }[] = [
    { name: 'idle',     pose: IDLE_POSE },
    { name: 'walk',     pose: { yaw: 0.7, walkPhase: 1.2, walkAmp: 1, attackT: 0 } },
    { name: 'chop',     pose: { yaw: 0, walkPhase: 0, walkAmp: 0, attackT: 0.5 } },
    // Bow draw at part-draw and full draw — the nocked arrow only exists here.
    { name: 'draw-half', pose: { yaw: 0, walkPhase: 0, walkAmp: 0, attackT: 1, aim: 0.5 } },
    { name: 'draw-full', pose: { yaw: 0, walkPhase: 0, walkAmp: 0, attackT: 1, aim: 1 } },
    { name: 'seated',   pose: { yaw: 0, walkPhase: 0, walkAmp: 0, attackT: 1, seat: 1 } },
    // The genuine worst case for a mounted archer: seated AND at full draw.
    { name: 'seated-draw',
      pose: { yaw: 0, walkPhase: 0.6, walkAmp: 1, attackT: 1, aim: 1, seat: 1 } },
  ];
  const ACC = {
    skirt: [0.4, 0.3, 0.5], belt: [0.3, 0.2, 0.1], apron: [0.6, 0.6, 0.6],
    hat: [0.4, 0.3, 0.2], boots: [0.3, 0.2, 0.1],
  } as never;
  let worst = 0;
  let worstDesc = '';
  for (const body of ['male', 'female'] as const) {
    for (const hairStyle of [0, 1, 2, 3]) {
      for (const accessories of [undefined, ACC]) {
        for (const tier of TIERS) {
          for (const heldKind of HELD_KINDS) {
            for (const { name: poseName, pose } of POSES) {
              const custom = { ...DEFAULT_CUSTOMIZATION, hairStyle, accessories } as never;
              const held: HeldItem | null = heldKind === null
                ? null : { kind: heldKind, color: [0.7, 0.7, 0.7] };
              const mesh = buildCharacterMesh(custom, pose, held, {
                body,
                armor: tier === undefined
                  ? undefined : { head: tier, body: tier, legs: tier },
              });
              const n = mesh.length / 10;
              if (n > worst) {
                worst = n;
                worstDesc = `${body} hair${hairStyle} ${tier ?? 'none'} ` +
                  `${accessories ? 'acc' : 'no-acc'} ${heldKind ?? 'empty'} ${poseName}`;
              }
            }
          }
        }
      }
    }
  }
  check('every buildCharacterMesh combination fits CHARACTER_MAX_VERTS',
    worst <= CHARACTER_MAX_VERTS,
    `worst=${worst} (${worstDesc}) cap=${CHARACTER_MAX_VERTS}`);
  // Keep the cap honest in the other direction too — a cap far above the real
  // maximum is wasted per-character GPU memory across every humanoid.
  check('CHARACTER_MAX_VERTS is not wildly oversized (≤ 1.6x the true worst)',
    CHARACTER_MAX_VERTS <= Math.ceil(worst * 1.6),
    `worst=${worst} cap=${CHARACTER_MAX_VERTS}`);
  console.log(`  vertex-budget sweep: worst = ${worst} verts (${worstDesc})`);
}
check('dragonscale mesh has emerald scale tint',
  hasColor(maleFullDragon, 0.14, 0.45, 0.26));
check('dragonscale mesh has bone spike color',
  hasColor(maleFullDragon, 0.85, 0.80, 0.68));
check('female no-armor ≤ CHARACTER_MAX_VERTS',
  femaleIdle.length / 10 <= CHARACTER_MAX_VERTS,
  `verts=${femaleIdle.length / 10}`);
check('male full-iron ≤ CHARACTER_MAX_VERTS',
  maleFullIron.length / 10 <= CHARACTER_MAX_VERTS,
  `verts=${maleFullIron.length / 10}`);
check('female full-iron ≤ CHARACTER_MAX_VERTS',
  femaleFullIron.length / 10 <= CHARACTER_MAX_VERTS,
  `verts=${femaleFullIron.length / 10}`);

// ---- helmet vertex-delta check -----------------------------------------
// The helmet is now a spherePart (see character-mesh.ts), not a 36-vert
// box, so we don't pin an exact per-armor vertex count (that would just
// re-create the same brittleness with a different magic number). Instead:
// it must add geometry, and the same primitive/segment-count is used
// regardless of body variant (so male/female deltas must match).
//
// This block used to also assert that a helmet-only build had exactly the
// same vertex delta as full iron, "since body/legs armor retints and adds no
// verts". That was true, and it was the defect: wearing plate only recoloured
// the wool. Body armour now contributes a breastplate, two pauldrons and a
// belt, so full iron must add STRICTLY MORE geometry than a helmet alone.
const maleHelmetDelta = maleFullIron.length / 10 - idle.length / 10;
const femaleHelmetDelta = femaleFullIron.length / 10 - femaleIdle.length / 10;
const maleHelmetOnlyDelta = maleHelmetOnly.length / 10 - idle.length / 10;
check('helmet adds geometry (male)', maleHelmetDelta > 0, `delta=${maleHelmetDelta}`);
check('helmet adds geometry (female)', femaleHelmetDelta > 0, `delta=${femaleHelmetDelta}`);
check('helmet vertex delta identical between male and female (same sphere primitive)',
  maleHelmetDelta === femaleHelmetDelta,
  `male=${maleHelmetDelta} female=${femaleHelmetDelta}`);
check('no helmet → no delta (male no armor = idle)',
  idle.length === buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE, null, {}).length);
check('body armour adds geometry beyond the helmet (plate, not a recolour)',
  maleHelmetDelta > maleHelmetOnlyDelta,
  `helmetOnly=${maleHelmetOnlyDelta} fullIron=${maleHelmetDelta}`);

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
// Same known capsule-leg sink as the male check above (see its comment).
check('female feet still at y=0 (or within the known capsule-leg-radius sink)',
  Math.abs(aabb(femaleIdle).lo[1]) < 1e-4,
  `minY=${aabb(femaleIdle).lo[1]}`);

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
  femaleWithStaff.length / 10 <= CHARACTER_MAX_VERTS,
  `verts=${femaleWithStaff.length / 10}`);

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

// =============================================================================
// Bow draw + riding seat (Pose.aim / Pose.seat)
// =============================================================================

{
  const bow: HeldItem = { kind: 'bow', color: [0.48, 0.34, 0.20] };
  const axe: HeldItem = { kind: 'axe', color: [0.66, 0.68, 0.72] };
  const restBow = buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE, bow);
  const halfDraw = buildCharacterMesh(DEFAULT_CUSTOMIZATION,
    { yaw: 0, walkPhase: 0, walkAmp: 0, attackT: 1, aim: 0.5 }, bow);
  const fullDraw = buildCharacterMesh(DEFAULT_CUSTOMIZATION,
    { yaw: 0, walkPhase: 0, walkAmp: 0, attackT: 1, aim: 1 }, bow);

  // The nocked arrow must EXIST — the whole complaint was an invisible shot.
  check('bow draw adds nocked-arrow geometry',
    fullDraw.length > restBow.length,
    `rest=${restBow.length / 10} draw=${fullDraw.length / 10}`);
  check('half draw carries the arrow too',
    halfDraw.length === fullDraw.length,
    `half=${halfDraw.length / 10} full=${fullDraw.length / 10}`);
  check('the draw actually moves the body (not just added parts)',
    fnv1a(new Uint8Array(halfDraw.buffer)) !== fnv1a(new Uint8Array(fullDraw.buffer)));

  // aim must be OFF by default and must not touch a non-bow item.
  check('aim: 0 is bit-identical to omitting aim',
    fnv1a(new Uint8Array(buildCharacterMesh(DEFAULT_CUSTOMIZATION,
      { yaw: 0, walkPhase: 0, walkAmp: 0, attackT: 0, aim: 0 }, bow).buffer))
      === fnv1a(new Uint8Array(restBow.buffer)));
  const axeAiming = buildCharacterMesh(DEFAULT_CUSTOMIZATION,
    { yaw: 0, walkPhase: 0, walkAmp: 0, attackT: 1, aim: 1 }, axe);
  const axeRest = buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE, axe);
  check('no arrow is nocked onto a non-bow',
    axeAiming.length === axeRest.length,
    `aiming=${axeAiming.length / 10} rest=${axeRest.length / 10}`);

  // The draw must beat the chop for the same right arm — asserting it changed
  // is not enough, since both change the mesh. Compare against a pure chop.
  const chopping = buildCharacterMesh(DEFAULT_CUSTOMIZATION,
    { yaw: 0, walkPhase: 0, walkAmp: 0, attackT: 0.5 }, bow);
  const chopWhileAiming = buildCharacterMesh(DEFAULT_CUSTOMIZATION,
    { yaw: 0, walkPhase: 0, walkAmp: 0, attackT: 0.5, aim: 1 }, bow);
  check('a live draw overrides the chop entirely',
    fnv1a(new Uint8Array(chopWhileAiming.buffer))
      === fnv1a(new Uint8Array(fullDraw.buffer)),
    'attackT must not leak into the draw pose');
  check('the chop and the draw are different poses',
    fnv1a(new Uint8Array(chopping.buffer)) !== fnv1a(new Uint8Array(fullDraw.buffer)));

  // A drawn bow puts the string hand back past the body: the LEFT arm has to
  // have moved. Without lForeRots the forearm stayed pinned at the shoulder.
  const leftmostRest = xExtent(restBow).minX;
  const drawAabb = aabb(fullDraw);
  check('drawing raises the string hand (mesh grows forward of the body)',
    drawAabb.lo[2] < aabb(restBow).lo[2] - 0.05,
    `restMinZ=${aabb(restBow).lo[2].toFixed(2)} drawMinZ=${drawAabb.lo[2].toFixed(2)}`);
  check('drawing keeps the character inside a sane footprint',
    drawAabb.lo[0] > -1.2 && drawAabb.hi[0] < 1.6
      && drawAabb.lo[2] > -1.6 && drawAabb.hi[2] < 1.2,
    `x=[${drawAabb.lo[0].toFixed(2)},${drawAabb.hi[0].toFixed(2)}] ` +
    `z=[${drawAabb.lo[2].toFixed(2)},${drawAabb.hi[2].toFixed(2)}]`);
  check('left arm still exists on the left', leftmostRest < -0.3);

  // ---- riding seat --------------------------------------------------------
  const standing = buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE);
  const seated = buildCharacterMesh(DEFAULT_CUSTOMIZATION,
    { yaw: 0, walkPhase: 0, walkAmp: 0, attackT: 0, seat: 1 });
  check('seat: 0 is bit-identical to omitting seat',
    fnv1a(new Uint8Array(buildCharacterMesh(DEFAULT_CUSTOMIZATION,
      { yaw: 0, walkPhase: 0, walkAmp: 0, attackT: 0, seat: 0 }).buffer))
      === fnv1a(new Uint8Array(standing.buffer)));
  check('seat: 1 changes the pose', seated.length === standing.length
    && fnv1a(new Uint8Array(seated.buffer)) !== fnv1a(new Uint8Array(standing.buffer)));
  const seatBox = aabb(seated);
  const standBox = aabb(standing);
  // Thighs swing forward, so the mesh must reach further forward (-Z) and the
  // feet must come UP off the ground — a rider whose feet stay at y=0 is a
  // standing figure glued to a horse.
  check('seated legs swing forward', seatBox.lo[2] < standBox.lo[2] - 0.2,
    `standMinZ=${standBox.lo[2].toFixed(2)} seatMinZ=${seatBox.lo[2].toFixed(2)}`);
  check('seated feet lift off the ground', seatBox.lo[1] > standBox.lo[1] + 0.15,
    `standMinY=${standBox.lo[1].toFixed(2)} seatMinY=${seatBox.lo[1].toFixed(2)}`);
  // Both thighs must move TOGETHER (a seat, not a stride): the two legs should
  // occupy the same z-range. Compare the leg verts' forward extent per side.
  {
    let minZLeft = Infinity, minZRight = Infinity;
    for (let i = 0; i < seated.length; i += 10) {
      if (seated[i + 1] > 0.75) continue; // legs only (below the hip)
      if (seated[i] < -0.02) minZLeft = Math.min(minZLeft, seated[i + 2]);
      if (seated[i] > 0.02) minZRight = Math.min(minZRight, seated[i + 2]);
    }
    check('both thighs swing forward together (a seat, not a stride)',
      Math.abs(minZLeft - minZRight) < 0.05,
      `left=${minZLeft.toFixed(3)} right=${minZRight.toFixed(3)}`);
  }

  // A mounted archer is seat AND aim at once — the combination must build.
  const mountedArcher = buildCharacterMesh(DEFAULT_CUSTOMIZATION,
    { yaw: 0.4, walkPhase: 0, walkAmp: 0, attackT: 1, aim: 1, seat: 1 }, bow,
    { armor: { head: 'iron', body: 'iron', legs: 'iron' } });
  check('mounted archer (seat + draw + full armour) fits the budget',
    mountedArcher.length / 10 <= CHARACTER_MAX_VERTS,
    `verts=${mountedArcher.length / 10}`);
  check('mounted archer is deterministic',
    fnv1a(new Uint8Array(mountedArcher.buffer)) === fnv1a(new Uint8Array(
      buildCharacterMesh(DEFAULT_CUSTOMIZATION,
        { yaw: 0.4, walkPhase: 0, walkAmp: 0, attackT: 1, aim: 1, seat: 1 }, bow,
        { armor: { head: 'iron', body: 'iron', legs: 'iron' } }).buffer)));

  // Out-of-range values must clamp, not explode the mesh.
  const overdrawn = buildCharacterMesh(DEFAULT_CUSTOMIZATION,
    { yaw: 0, walkPhase: 0, walkAmp: 0, attackT: 0, aim: 4, seat: -3 }, bow);
  check('aim/seat clamp to [0,1]',
    fnv1a(new Uint8Array(overdrawn.buffer)) === fnv1a(new Uint8Array(fullDraw.buffer)));
}

// ---- vertex counts summary --------------------------------------------------

const femaleFullIronVerts = femaleFullIron.length / 10;
const maleFullIronVerts   = maleFullIron.length / 10;
console.log(`vert counts — male idle: ${vertCount}, female idle: ${femaleIdle.length/10}, ` +
  `male+iron: ${maleFullIronVerts}, female+iron: ${femaleFullIronVerts}`);

console.log(`${passed} passed, ${failed} failed  (${vertCount} verts idle)`);
if (failed > 0) process.exit(1);
