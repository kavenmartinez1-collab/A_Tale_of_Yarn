/**
 * humanoid-mesh.ts — the bipedal enemy body plans: goblin, goblin archer,
 * skeleton, and the Dread King.
 *
 * WHY THIS LIVES IN THE ANIMAL RIG AND NOT IN `character-mesh.ts`
 *
 * There is already a humanoid in this game — the player doll — and the obvious
 * move is to reuse it. It is the wrong one, for four reasons that are all
 * structural rather than aesthetic:
 *
 *  1. **Dungeon enemies are `EntityState`s.** `main.ts` already calls
 *     `entityRenderer.buildDraws(dungeonManager.dungeonEnemies(), …)`, and that
 *     path dispatches to `buildAnimalMesh` and nothing else. A species added
 *     here renders, animates, fights and streams with zero new plumbing.
 *  2. **`buildCharacterMesh` has no knees.** Its legs are one capsule pitched
 *     from the hip — the exact pendulum defect `anim/gait.ts` was written to
 *     remove. Bipeds that charge at you are the last thing that should skate.
 *  3. **It cannot be scaled.** `character.wgsl` is `position + object.offset`,
 *     a pure translate, and every joint height in that file is a module
 *     constant. A 2.4 m boss would require it to become parametric anyway.
 *  4. **It speaks a different pose language.** The clip system, the 27-move
 *     attack library and the contact-frame sync all produce an `AnimalPose`.
 *     The character rig takes six scalars and has no clip sampler at all.
 *
 * So the geometry advice in `docs/RECTIFICATION_PLAN.md` §5.6 is followed to
 * the letter — the proportions, part lists, materials and silhouette tests
 * below are its spec — while the *rig* is the wyvern's: `makeLegPlan` /
 * `solveLeg` two-bone IK with planted feet, driven by `AnimalPose`.
 *
 * ART DIRECTION
 *
 * These are wool dolls, like everything else that walks (see
 * memory/project_art_direction_yarn.md). A goblin is stitched felt over a knit
 * body with leather scraps; a skeleton is pale knitted bone with daylight
 * between its ribs; the Dread King is iron and gold over black wool with a
 * heavy cloth cape. Menace comes from silhouette and scale, not from grit.
 *
 * Conventions are the shared ones: local space with the feet at y = 0, facing
 * -Z at yaw 0, vertices interleaved position+normal per part.
 */

import { SPECIES_DEFS, type Species } from './entity-types';
import { MAT } from '../render/material-table';
import {
  footTarget, makeLegPlan, maxStride, solveLeg, type LegPlan,
} from '../anim/gait';
import {
  applyVariant, makeBevelPart, makeBoxSpherePart, makeEarPart, makeEyeParts,
  pitch, rollZ, twistY,
  ACCENT_COLORS, BASE_COLORS, BELLY_COLORS,
  type AnimalPose, type Color3, type Part, type Rot,
} from './creature-parts';
import { bonePart, ridgePart, spikePart, type Vec3 } from './draconic-parts';

// ---------------------------------------------------------------------------
// Species set
// ---------------------------------------------------------------------------

export type HumanoidSpecies =
  | 'goblin' | 'goblin_archer' | 'skeleton' | 'dread_king' | 'evil_king';

const HUMANOID_SET = new Set<string>(
  ['goblin', 'goblin_archer', 'skeleton', 'dread_king', 'evil_king']);

/**
 * True when a species uses the biped rig below.
 *
 * A predicate rather than a `switch` in three places: `animalStride` needs it,
 * `speciesAnim` needs it, and `buildAnimalMesh` needs it, and three copies of
 * the list is how the wyvern nearly ended up with quadruped clips.
 */
export function isHumanoid(species: Species): species is HumanoidSpecies {
  return HUMANOID_SET.has(species);
}

// ---------------------------------------------------------------------------
// Body plans
// ---------------------------------------------------------------------------

/**
 * A body plan, expressed in fractions of `SPECIES_DEFS[sp].size`.
 *
 * `size` keeps its documented meaning throughout the game — **shoulder
 * height** — so `chestY` is 1.0 by definition and every other number is
 * relative to it. Working in fractions rather than metres is what lets the
 * Dread King be a scaled-up plan rather than a third hand-tuned builder.
 */
export interface HumanoidPlan {
  /** Hip-joint height. */
  hipY: number;
  /** Head centre height. */
  headY: number;
  /** Skull radius. */
  headR: number;
  /** Chest half-width / half-depth. */
  chestW: number;
  chestD: number;
  /** Waist half-width, as a fraction of `chestW`. */
  waistMul: number;
  /** Upper-arm and thigh radius. */
  limbR: number;
  /** Lateral offset of a hip joint. */
  legGap: number;
  /** Constant forward pitch of everything above the hips (rad). */
  lean: number;
  /** Constant outward roll at the hips — bandy legs (rad). */
  splay: number;
  /** Arm segment lengths (upper, fore). */
  armUpper: number;
  armFore: number;
  /** Peak arm swing at full stride (rad). */
  armSwing: number;

  // --- gait -----------------------------------------------------------------
  /** Ankle height above ground. */
  ankleH: number;
  /** Ankle set-back as a fraction of ankle height. */
  ankleSet: number;
  /** Bone length over the standing root→ankle gap. > 1 keeps a live bend. */
  slack: number;
  /** Femur's share of the two-bone chain. */
  upperFrac: number;
  /** Fraction of the cycle each foot is planted. */
  duty: number;
  /** Peak swing-foot lift, as a fraction of hip height. */
  lift: number;
}

/**
 * The four plans.
 *
 * Read them as silhouettes, because that is what they are tuned for. The
 * goblin is a hunched 1.1 m with an oversized head and knuckles near its
 * knees; the skeleton is a gaunt 1.8 m that stands dead upright; the Dread
 * King is 2.4 m of shoulders. **Size contrast against the 1.62 m player is
 * the primary read on all three** — you should know which one is coming at you
 * from its outline alone.
 *
 * The gait numbers are not free parameters. `stride` is derived from
 * `maxStride(plan, duty)` below, so `duty` and `slack` between them decide how
 * long a step the species can take without the IK clamping — and a clamped
 * foot slides, which is the whole defect the planted-foot rig exists to
 * remove. Short-legged, crouched plans need more slack for the same step, which
 * is exactly how real legs work.
 */
const HUMANOID_PLANS: Record<HumanoidSpecies, HumanoidPlan> = {
  // Hunched, bandy, big-headed. `headR` is 19% of shoulder height against the
  // player's ~9% — the oversized head is most of the read, and it is what keeps
  // a goblin from looking like a short person.
  goblin: {
    hipY: 0.56, headY: 1.15, headR: 0.185,
    chestW: 0.27, chestD: 0.20, waistMul: 0.84,
    limbR: 0.068, legGap: 0.17,
    lean: 0.26, splay: 0.15,
    armUpper: 0.34, armFore: 0.33, armSwing: 0.62,
    ankleH: 0.075, ankleSet: 0.42, slack: 1.20, upperFrac: 0.50,
    duty: 0.48, lift: 0.24,
  },
  // The archer stands straighter and lighter — it is the one goblin that keeps
  // its distance, and a hunched silhouette reads as "about to charge".
  goblin_archer: {
    hipY: 0.57, headY: 1.15, headR: 0.180,
    chestW: 0.25, chestD: 0.19, waistMul: 0.86,
    limbR: 0.062, legGap: 0.16,
    lean: 0.15, splay: 0.11,
    armUpper: 0.35, armFore: 0.34, armSwing: 0.50,
    ankleH: 0.075, ankleSet: 0.42, slack: 1.19, upperFrac: 0.50,
    duty: 0.50, lift: 0.22,
  },
  // Gaunt and upright. `limbR` is a third of the goblin's: the thinness IS the
  // species, and the ribcage below deliberately leaves daylight through the
  // torso. If you cannot see through it at 20 m, it has failed.
  skeleton: {
    hipY: 0.55, headY: 1.14, headR: 0.098,
    chestW: 0.21, chestD: 0.145, waistMul: 0.72,
    limbR: 0.026, legGap: 0.115,
    lean: 0.04, splay: 0.03,
    armUpper: 0.36, armFore: 0.35, armSwing: 0.72,
    ankleH: 0.062, ankleSet: 0.38, slack: 1.17, upperFrac: 0.51,
    duty: 0.56, lift: 0.15,
  },
  // Shoulders. `chestW` 0.22 of shoulder height puts them 0.42 m out either
  // side at full scale, and the pauldrons sit outboard of that again.
  dread_king: {
    hipY: 0.53, headY: 1.16, headR: 0.100,
    chestW: 0.29, chestD: 0.215, waistMul: 0.80,
    limbR: 0.072, legGap: 0.185,
    lean: 0.10, splay: 0.06,
    armUpper: 0.38, armFore: 0.36, armSwing: 0.44,
    ankleH: 0.080, ankleSet: 0.40, slack: 1.16, upperFrac: 0.51,
    duty: 0.60, lift: 0.13,
  },
  // The final boss. The same construction as the Dread King — deliberately, it
  // is the same order of being — but every proportion pushed toward "lord"
  // rather than "brute": longer legs (hipY 0.52 against 0.53 on a figure a
  // third taller again), a narrower waist under wider shoulders, and almost no
  // forward lean. A hunch is a monster; a straight back is a king.
  //
  // `headY` and `headR` are NOT free. `buildEvilKing` closes the helm dome at
  // `headY + headR * 1.14` — the same formula as the Dread King's — and the
  // brief is that he stands exactly twice the player's height. At
  // `SPECIES_DEFS.evil_king.size = 2.5` that fixes the pair:
  //
  //     (headY + headR * 1.14) * 2.5 === 2 * CHARACTER_HEIGHT === 3.24 m
  //     (1.17288 + 0.108 * 1.14) * 2.5 === 1.296 * 2.5 === 3.24 ✓
  //
  // `scripts/test-boss-mesh.mts` asserts that identity against the *measured*
  // mesh, not against these numbers, so changing either one without changing
  // `size` fails loudly instead of quietly making him 3.19 m.
  //
  // `headR` was raised and `chestW`/`chestD` cut after the first offline
  // previews: at 0.305/0.225 he was deeper than he was tall in the head and
  // the skull vanished between the pauldrons, which reads as a barrel with a
  // crown on it. The head is now 16.7% of standing height — a shade heroic
  // against a real 13% — because the head is what the eye finds first and
  // this one has to survive being 40 m up on a dragon.
  evil_king: {
    hipY: 0.52, headY: 1.17288, headR: 0.108,
    chestW: 0.272, chestD: 0.183, waistMul: 0.76,
    limbR: 0.074, legGap: 0.190,
    lean: 0.05, splay: 0.04,
    // Human proportion, NOT the Dread King's 0.38/0.36. Those put this rig's
    // wrist at 0.22 of standing height — knuckles below the knee, which is the
    // goblin's read and the opposite of regal. 0.255/0.235 lands the wrist at
    // the hip, where a person's is, and it is also what lets the greatsword
    // hang from a fist at hip height instead of dragging its pommel.
    armUpper: 0.255, armFore: 0.235, armSwing: 0.38,
    ankleH: 0.082, ankleSet: 0.40, slack: 1.15, upperFrac: 0.51,
    duty: 0.62, lift: 0.11,
  },
};

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

interface HumanoidRig {
  plan: HumanoidPlan;
  leg: LegPlan;
  /** Ground distance per gait cycle, bounded by limb reach. */
  stride: number;
}

/**
 * Memoized per species — these depend only on species constants, so
 * recomputing them for every enemy every frame would be pure waste. Same
 * reasoning (and same shape) as `quadrupedRig` and `wyvernLeg`.
 */
const RIG_CACHE = new Map<Species, HumanoidRig>();

export function humanoidRig(species: Species): HumanoidRig {
  const cached = RIG_CACHE.get(species);
  if (cached !== undefined) return cached;

  const s = SPECIES_DEFS[species].size;
  const plan = HUMANOID_PLANS[species as HumanoidSpecies];
  const rootY = s * plan.hipY;
  // A knee breaks FORWARD, so `bend` is +1 — the same sign as a quadruped's
  // hind stifle and the opposite of a foreleg's carpus. Getting this backwards
  // gives you a bird's leg, which is the single loudest tell of a
  // programmer-authored biped.
  const leg = makeLegPlan(
    rootY, 0, s * plan.ankleH, plan.ankleSet, +1, plan.upperFrac, plan.slack);

  // Derived from the anatomy, never picked independently: a stride past the
  // reachable annulus makes the solver clamp, and a clamped foot skates. 0.92
  // holds it just inside the boundary, matching `quadrupedRig`.
  const stride = maxStride(leg, plan.duty) * 0.92;

  const rig: HumanoidRig = { plan, leg, stride };
  RIG_CACHE.set(species, rig);
  return rig;
}

/**
 * Ground distance per gait cycle. **`animalStride` must return exactly this**
 * for a humanoid species, because the AI advances `walkPhase` by
 * `distance / animalStride` while the mesh sweeps its stance over
 * `humanoidStride * duty`. If the two disagree the feet skate by the ratio,
 * and no still frame reveals it. A test asserts the identity.
 */
export function humanoidStride(species: Species): number {
  return humanoidRig(species).stride;
}

/** Longest stride the leg covers without the IK clamping (test hook). */
export function humanoidMaxStride(species: Species): number {
  const rig = humanoidRig(species);
  return maxStride(rig.leg, rig.plan.duty);
}

/**
 * Vertical body displacement, in metres, at this phase.
 *
 * A biped's mass falls once per FOOTFALL, so twice per cycle. Kept internal
 * (never routed through `pose.bodyDrop`) for the same reason the wyvern keeps
 * it internal: the bob is folded into `plan.rootY` before the IK runs, so the
 * solver puts the feet back where they were and nothing has to be told twice.
 */
function bodyBobM(s: number, walkPhase: number, walkAmp: number): number {
  if (walkAmp <= 0) return 0;
  return (Math.cos(walkPhase * 2) * 0.5 - 0.5) * s * 0.042 * walkAmp;
}

// --- riding seat (pose.seat) -------------------------------------------------
//
// Three angles and nothing else, chosen so the leg wraps a barrel rather than
// dangling beside one. The character rig has the same idea in one number
// (`SEAT_THIGH_PITCH`) because it has no knee; this rig does, so the thigh and
// the shin get separate values and the difference between them is the whole
// silhouette. Thigh forward and a little above horizontal, knee folded back so
// the shin drops down the mount's flank, and a wide outward roll at the hip so
// the knees clear the ribs instead of intersecting them.

/** Thigh pitch at a full seat (rad). + swings the below-hip end FORWARD. */
const SEAT_THIGH_PITCH = 1.34;
/** Knee bend at a full seat (rad). Negative folds the shin back down. */
const SEAT_KNEE_BEND = -1.18;
/**
 * Extra outward hip roll at a full seat (rad) — the straddle.
 *
 * 0.72, which is a very wide abduction for a person and exactly right for the
 * only thing that uses it: the Evil King astride a dragon whose barrel is
 * 2.6 m across, nearly as wide as he is tall. At 0.30 his knees were inside
 * the animal's ribs.
 */
const SEAT_SPLAY = 0.72;
/** Forward torso settle at a full seat (rad). */
const SEAT_TORSO_LEAN = 0.10;

// ---------------------------------------------------------------------------
// Shared skeleton: the frame every species is skinned onto
// ---------------------------------------------------------------------------

/** One solved leg, ready to hang geometry off. */
interface LegFrame {
  /** Lateral offset of this leg's root. */
  lx: number;
  /** Rotation chains, child-first, for each segment. */
  thighRots: Rot[];
  shinRots: Rot[];
  footRots: Rot[];
  /** Rest-space joint heights. */
  hipY: number;
  kneeY: number;
  ankleY: number;
  toeY: number;
  planted: number;
}

/** The posed frame: joints, chains and torso surface solvers. */
export interface Frame {
  s: number;
  plan: HumanoidPlan;
  bob: number;
  legs: LegFrame[];
  /** Torso chain (lean + counter-rotation), applied to everything above the hip. */
  spineRots: Rot[];
  /** Head chain (yaw + pitch) on top of the spine. */
  headRots: Rot[];
  /** Jaw chain — head chain plus the jaw hinge. */
  jawRots: Rot[];
  /** Per-side arm chains, index 0 = left (-X), 1 = right (+X). */
  arms: { upperRots: Rot[]; foreRots: Rot[]; side: -1 | 1 }[];
  /** Absolute heights of the shoulder, chest centre, waist, and head centre. */
  shoulderY: number;
  chestY: number;
  waistY: number;
  headY: number;
  /** Rest-space elbow / wrist heights, for hanging hands and held items. */
  elbowY: number;
  wristY: number;
  /** Surface solver: top of the torso ellipsoid at (x, z). */
  torsoTopAt: (x: number, z: number) => number;
  /** Surface solver: torso half-width at height y. */
  torsoWidthAt: (y: number) => number;
}

/**
 * Solve the whole biped: legs by IK, torso/head/arms by rotation chain.
 *
 * The chains are authored child-first and every pivot is in UNPOSED rest
 * space, matching `assembleParts` and `gait.ts`'s convention exactly. Getting
 * that ordering wrong does not fail loudly — it produces a creature whose
 * joints rotate about slightly wrong points, which reads as "rubbery" and is
 * almost impossible to diagnose from a screenshot.
 */
export function solveFrame(species: HumanoidSpecies, pose: AnimalPose): Frame {
  const s = SPECIES_DEFS[species].size;
  const rig = humanoidRig(species);
  const plan = rig.plan;

  // Astride a mount there is no ground to walk on, so the gait is switched off
  // at the source rather than sixteen places downstream. A seated rider whose
  // legs still ran through the planted-foot IK would pedal in time with the
  // mount's own stride — the solver is chasing a ground plane five metres
  // below it and has no idea.
  const seat = Math.min(Math.max(pose.seat ?? 0, 0), 1);
  const walkAmp = pose.walkAmp * (1 - seat);
  const bob = bodyBobM(s, pose.walkPhase, walkAmp);

  const hipY = s * plan.hipY;
  const legGap = s * plan.legGap;
  const stride = rig.stride * walkAmp;
  const lift = hipY * plan.lift * walkAmp;
  const footRise = -(pose.bodyDrop ?? 0);

  // --- legs ---------------------------------------------------------------
  const legs: LegFrame[] = [];
  for (const [lx, phaseOff, splaySign] of
    [[-legGap, 0, -1], [legGap, 0.5, 1]] as const) {
    // The bob rides on the limb ROOT, so the IK re-solves the joints to keep
    // the foot exactly where the gait asked. Applying it to the whole body
    // instead would drag every planted foot down through the floor with it.
    const legPlan: LegPlan = { ...rig.leg, rootY: rig.leg.rootY + bob };
    const foot = footTarget(
      pose.walkPhase + phaseOff * Math.PI * 2, stride, lift, plan.duty);
    foot.y += footRise;
    const sol = solveLeg(legPlan, foot);

    const lz = legPlan.rootZ;
    // Bandy legs: a constant outward roll about the hip, OUTSIDE the pitch
    // chain so it tilts the whole solved limb rather than skewing the IK
    // plane the solver worked in. Sitting astride widens it a long way — the
    // straddle IS the read that says "on something" rather than "above it".
    const splayRot = rollZ(
      splaySign * (plan.splay + seat * SEAT_SPLAY), lx, legPlan.rootY);
    // Seated, the joint angles are authored, not solved: thigh forward and
    // level-ish, knee folded back so the shin hangs down the mount's flank.
    const hipRot = pitch(
      sol.upper * (1 - seat) + seat * SEAT_THIGH_PITCH, legPlan.rootY, lz);
    const kneeRot = pitch(
      sol.lower * (1 - seat) + seat * SEAT_KNEE_BEND, sol.kneeY, sol.kneeZ);
    const anklRot = pitch(sol.cannon * (1 - seat), sol.ankleY, sol.ankleZ);

    const kneeY = legPlan.rootY - legPlan.l1;
    const ankleY = kneeY - legPlan.l2;
    const toeY = ankleY - legPlan.cannon;

    // Cancel the chain's accumulated pitch at the ankle so the sole stays flat
    // on the floor instead of pointing wherever the shin happens to. Summed
    // from the angles actually applied above, not from `sol` — seated, those
    // are authored rather than solved, and reading `sol` here would flatten
    // the sole against a floor the rider is nowhere near.
    const absCan = hipRot.a + kneeRot.a + anklRot.a;
    const footFlat = pitch(-absCan, toeY, lz);

    legs.push({
      lx,
      thighRots: [hipRot, splayRot],
      shinRots: [kneeRot, hipRot, splayRot],
      footRots: [footFlat, anklRot, kneeRot, hipRot, splayRot],
      hipY: legPlan.rootY, kneeY, ankleY, toeY,
      planted: sol.planted,
    });
  }

  // --- torso --------------------------------------------------------------
  const chestY = s + bob;
  const shoulderY = s * 0.985 + bob;
  const waistY = (hipY + s * 0.82) * 0.5 + bob;
  const headY = s * plan.headY + bob;

  // Positive pitch tips a point ABOVE the pivot backward, so a forward lean is
  // negative. `tailSway` is repurposed here as a torso counter-rotation: on a
  // humanoid there is no tail, and the shoulders answering a swing is the same
  // piece of animation the channel was written to provide.
  const twist = (pose.tailSway ?? 0) * 0.55;
  const spineRots: Rot[] = [
    twistY(twist, 0, 0),
    pitch(-plan.lean - seat * SEAT_TORSO_LEAN, hipY + bob, 0),
  ];

  const headPitch = pose.headPitch ?? 0;
  const headYaw = pose.headYaw ?? 0;
  const neckY = s * 1.02 + bob;
  const headRots: Rot[] = [
    // Negated: `headPitch` is positive-nose-DOWN, `pitch` is positive-nose-UP
    // for anything hanging off a pivot below it. Same negation as
    // `animal-mesh.ts` applies at every head site.
    pitch(-headPitch, neckY, 0),
    twistY(headYaw, 0, 0),
    ...spineRots,
  ];
  const jawHingeY = headY - plan.headR * 0.30;
  const jawHingeZ = plan.headR * s * 0.45;
  const jawRots: Rot[] = [
    pitch(-(pose.jawOpen ?? 0) * 0.52, jawHingeY, jawHingeZ),
    ...headRots,
  ];

  // --- arms ---------------------------------------------------------------
  //
  // Arms counter-swing against the legs — the left arm goes forward with the
  // right leg. That contralateral pattern is not decoration: an ipsilateral
  // swing reads instantly as a broken puppet even to someone who could not say
  // why.
  //
  // `foreSwing` is added ON TOP for the weapon arm. It is the only channel
  // that can move a limb on a stationary creature (stride amplitude is derived
  // from measured speed and is therefore exactly zero when something plants
  // itself to strike), which makes it the humanoid attack channel.
  const swing = Math.sin(pose.walkPhase) * walkAmp * plan.armSwing;
  const fore = pose.foreSwing ?? 0;
  const elbowY = shoulderY - s * plan.armUpper;
  const wristY = elbowY - s * plan.armFore;
  const armX = 0; // pivot X is irrelevant for a pitch; kept for readability
  void armX;

  const arms: Frame['arms'] = [];
  for (const side of [-1, 1] as const) {
    // Right arm (+X) is the weapon arm and carries the attack swing.
    const isWeapon = side === 1;
    const base = side === 1 ? -swing : swing;
    const armFore = isWeapon ? fore : fore * 0.28;
    const shoulderPitch = base + armFore;
    // A WALKING arm is never straight: the elbow keeps a live bend that deepens
    // as the arm comes forward, which is what stops a stride reading as a swept
    // rod. A STRIKING arm does the opposite, and getting the two the same way
    // round is why no humanoid in this game had ever visibly swung anything.
    //
    // A weapon rides `foreRots`, so it inherits the elbow AND the shoulder. The
    // old rule deepened the elbow by 55% of the shoulder's own travel, and for
    // anything held in the hand those two very nearly cancelled: measured on
    // `evil_king_overhead`, the blade rotated from -0.30 rad at rest to +0.22
    // at contact — thirty degrees, for a two-handed overhead with a 3.1 m
    // greatsword. The offline strip shows it exactly: cocked over the shoulder
    // on the windup and then back to vertical on the contact frame, a boss
    // waving a sword above his head while the damage lands somewhere else.
    //
    // So the elbow now COCKS on the windup (`armFore` negative) and EXTENDS
    // through the blow, which is what an arm actually does and which puts the
    // whole of the shoulder's travel into the blade instead of half of it —
    // 120 degrees of arc on the same clip, same channel, same contact frame.
    // Capped at straight: an elbow that bends past 0 is hyperextended, and a
    // hyperextended elbow reads as a broken puppet from any distance.
    //
    // Keyed on `armFore` rather than on `shoulderPitch` so the walk term is
    // untouched — a humanoid with `foreSwing` 0 solves to exactly the pose it
    // did before, which is every humanoid in the game that is not mid-attack.
    const elbowBend = -0.30 - Math.max(0, base) * 0.55
      + Math.min(0.30, armFore * 0.45);
    const shoulderRot = pitch(shoulderPitch, shoulderY, 0);
    const elbowRot = pitch(elbowBend, elbowY, 0);
    arms.push({
      side,
      upperRots: [shoulderRot, ...spineRots],
      foreRots: [elbowRot, shoulderRot, ...spineRots],
    });
  }

  // --- torso surface solvers ----------------------------------------------
  //
  // `makeBoxSpherePart` inscribes an ELLIPSOID in the box it is given, so the
  // surface is well inside the box everywhere except the three axis poles.
  // Anything anchored to a box face therefore floats in mid-air — that gotcha
  // has cost this repo tails, ears, leg roots, a bear hump and a wolf saddle.
  // Pauldrons, jerkins and rib arcs all anchor to the torso, so they get the
  // real surface.
  const chestRX = s * plan.chestW;
  const chestRY = (s * 0.90 - hipY) * 0.62;
  const chestRZ = s * plan.chestD;
  const torsoTopAt = (x: number, z: number): number => {
    const u = x / chestRX, v = z / chestRZ;
    return chestY + chestRY * Math.sqrt(Math.max(0, 1 - Math.min(1, u * u + v * v)));
  };
  const torsoWidthAt = (y: number): number => {
    const t = (y - chestY) / chestRY;
    return chestRX * Math.sqrt(Math.max(0, 1 - Math.min(1, t * t)));
  };

  return {
    s, plan, bob, legs, spineRots, headRots, jawRots, arms,
    shoulderY, chestY, waistY, headY, elbowY, wristY,
    torsoTopAt, torsoWidthAt,
  };
}

// ---------------------------------------------------------------------------
// Shared geometry
// ---------------------------------------------------------------------------

/** Solid tapered limbs — goblins and the Dread King. Legs then arms. */
export function fleshLimbs(
  parts: Part[], f: Frame, limbC: Color3, mat: number,
  thighMul = 1.35, calfMul = 0.80, armX?: number,
): void {
  const { s, plan } = f;
  const r = s * plan.limbR;

  for (const leg of f.legs) {
    // Thigh heavy, shank fine — a uniform sausage reads as a sausage, and a
    // wrist is not the thickness of a shoulder.
    parts.push(bonePart(limbC, leg.thighRots,
      [leg.lx, leg.kneeY, 0], [leg.lx, leg.hipY, 0],
      r * 1.00, r * thighMul, 5, mat));
    parts.push(bonePart(limbC, leg.shinRots,
      [leg.lx, leg.ankleY, 0], [leg.lx, leg.kneeY, 0],
      r * calfMul * 0.78, r * calfMul, 4, mat));
  }

  for (const arm of f.arms) {
    const ax = arm.side * (armX ?? f.torsoWidthAt(f.shoulderY) * 0.96);
    parts.push(bonePart(limbC, arm.upperRots,
      [ax, f.elbowY, 0], [ax, f.shoulderY, 0],
      r * 0.72, r * 0.92, 4, mat));
    parts.push(bonePart(limbC, arm.foreRots,
      [ax, f.wristY, 0], [ax, f.elbowY, 0],
      r * 0.56, r * 0.72, 4, mat));
  }
}

/**
 * Feet: a flattened pad built up from the solved contact point.
 *
 * `armX` on `fleshLimbs` above exists for the same reason this takes `toeLen`:
 * a plan whose chest is not `f.torsoWidthAt`'s chest — the Evil King caps his
 * at the shoulder line so his head is not inside it — needs to say where the
 * shoulder socket really is, or its arms hang in the gap beside the body.
 */
export function feet(parts: Part[], f: Frame, c: Color3, mat: number, toeLen = 1.55): void {
  const { s, plan } = f;
  const pr = s * plan.limbR * 1.05;
  for (const leg of f.legs) {
    parts.push(makeBoxSpherePart(c, leg.footRots,
      leg.lx - pr, leg.toeY, -pr * toeLen,
      leg.lx + pr, leg.toeY + pr * 1.0, pr * 0.85, 1, 5, 3, mat));
  }
}

/** Mitten hands at the wrist, riding the forearm chain. */
export function hands(parts: Part[], f: Frame, c: Color3, mat: number): void {
  const { s, plan } = f;
  const hr = s * plan.limbR * 0.86;
  for (const arm of f.arms) {
    const ax = arm.side * f.torsoWidthAt(f.shoulderY) * 0.96;
    parts.push(makeBoxSpherePart(c, arm.foreRots,
      ax - hr, f.wristY - hr * 1.5, -hr * 0.9,
      ax + hr, f.wristY + hr * 0.5, hr * 0.9, 1, 5, 3, mat));
  }
}

// ---------------------------------------------------------------------------
// Goblin
// ---------------------------------------------------------------------------

/**
 * Goblin — the numerous one.
 *
 * Every proportion here is doing silhouette work at 20 m: the head is
 * oversized, the arms dangle to the knees, the back is hunched and the ears
 * sweep back off the skull. Those four shapes read as a goblin in black
 * fill; get any of them wrong and you have a short person.
 *
 * `archer` swaps the cleaver for a bow held across the body and stands the
 * doll up straighter. It is the same 300 lines of geometry rather than a
 * second builder because the difference between the two really is a weapon
 * and a posture.
 */
function buildGoblin(species: HumanoidSpecies, pose: AnimalPose, variant: number): Part[] {
  const archer = species === 'goblin_archer';
  const f = solveFrame(species, pose);
  const { s, plan } = f;

  const skinC = applyVariant(BASE_COLORS[species], variant);
  const bellyC = BELLY_COLORS[species];
  const accentC = ACCENT_COLORS[species];
  // Jerkin: the skin colour driven dark and desaturated, which is what dirty
  // hide over green felt actually looks like — a separately-picked brown would
  // read as a costume rather than as something scavenged.
  const jerkinC: Color3 = [
    skinC[0] * 0.42 + 0.16, skinC[1] * 0.34 + 0.12, skinC[2] * 0.30 + 0.09,
  ];

  const parts: Part[] = [];

  // ----- torso -------------------------------------------------------------
  const chestRX = s * plan.chestW;
  const chestRY = (s * 0.90 - s * plan.hipY) * 0.62;
  const chestRZ = s * plan.chestD;
  parts.push(makeBoxSpherePart(skinC, f.spineRots,
    -chestRX, f.chestY - chestRY, -chestRZ,
    chestRX, f.chestY + chestRY, chestRZ, 1, 8, 5, MAT.SKIN));
  // Pot belly. A goblin is not lean — the gut is what makes the hunch read as
  // a posture rather than as a slouch. Kept BELOW the jerkin band above, or it
  // pokes through the front of it as a pale lump.
  const bellyY = f.waistY - chestRY * 0.16;
  const bx = chestRX * 0.90, by = chestRY * 0.56, bz = chestRZ * 1.06;
  parts.push(makeBoxSpherePart(bellyC, f.spineRots,
    -bx, bellyY - by, -bz, bx, bellyY + by, bz, 1, 7, 4, MAT.SKIN));
  // Pelvis
  const px = chestRX * 0.74;
  parts.push(makeBoxSpherePart(skinC, f.spineRots,
    -px, s * plan.hipY - s * 0.05 + f.bob, -chestRZ * 0.78,
    px, s * plan.hipY + s * 0.14 + f.bob, chestRZ * 0.78, 1, 6, 4, MAT.SKIN));

  // ----- limbs -------------------------------------------------------------
  fleshLimbs(parts, f, skinC, MAT.SKIN, 1.30, 0.82);
  feet(parts, f, skinC, MAT.SKIN, 1.7);
  hands(parts, f, skinC, MAT.SKIN);

  // ----- head --------------------------------------------------------------
  const hr = s * plan.headR;
  parts.push(makeBoxSpherePart(skinC, f.headRots,
    -hr, f.headY - hr * 1.02, -hr * 0.94,
    hr, f.headY + hr * 0.96, hr * 1.02, 1, 8, 5, MAT.SKIN));

  // Snout + jaw. The jaw is a separate part on the hinge chain so `jawOpen`
  // can actually drop it — a snarling goblin is most of the menace at 5 m.
  const snoutZ = -hr * 0.86;
  parts.push(makeBoxSpherePart(skinC, f.headRots,
    -hr * 0.42, f.headY - hr * 0.52, snoutZ - hr * 0.42,
    hr * 0.42, f.headY - hr * 0.06, snoutZ + hr * 0.50, 1, 6, 4, MAT.SKIN));
  parts.push(makeBoxSpherePart(bellyC, f.jawRots,
    -hr * 0.36, f.headY - hr * 0.80, snoutZ - hr * 0.32,
    hr * 0.36, f.headY - hr * 0.42, snoutZ + hr * 0.62, 1, 5, 3, MAT.SKIN));

  // Nose — a single forward cone. Cheap and enormously species-defining.
  parts.push(spikePart(accentC, f.headRots,
    [0, f.headY - hr * 0.22, snoutZ - hr * 0.18],
    [0, -0.34, -1], hr * 0.20, hr * 0.72, 5, MAT.SKIN));

  // Ears: long, swept back and splayed wide. `makeEarPart` builds them as
  // flattened ellipsoid blades rather than boxes, because a box has no
  // silhouette from the front and collapses to a black bar from the side.
  for (const side of [-1, 1] as const) {
    parts.push(makeEarPart(skinC, f.headRots, side,
      side * hr * 0.86, f.headY - hr * 0.06, hr * 0.10,
      hr * 0.10, hr * 1.15, hr * 0.22,
      0.95, 0.55, MAT.SKIN));
  }

  // Eyes.
  //
  // ON the brow, above and outboard of the snout — and the Z here is the whole
  // point. The first version put them at `snoutZ + hr*0.24`, which is 0.62 of
  // a head-radius forward of centre when the skull's own surface at that
  // width is 0.86 — so both eyes sat entirely INSIDE the head and the goblin
  // rendered as a smooth green blob with ears. It looked like a modelling
  // choice rather than a bug, which is exactly why it survived the first
  // portrait pass: nothing was missing, the face was simply absent.
  //
  // A doll without eyes reads as a sack. These are the cheapest 120 vertices
  // on the model and the ones that do the most.
  parts.push(...makeEyeParts(accentC, f.headRots,
    hr * 0.50, f.headY + hr * 0.14, -hr * 0.82, hr * 0.19, MAT.LEATHER));

  // Tusks — two up from the lower jaw, so they move with it.
  {
    const tusks: { base: Vec3; dir: Vec3; r: number; len: number }[] = [];
    for (const side of [-1, 1] as const) {
      tusks.push({
        base: [side * hr * 0.26, f.headY - hr * 0.62, snoutZ + hr * 0.10],
        dir: [side * 0.22, 1, -0.30], r: hr * 0.085, len: hr * 0.44,
      });
    }
    parts.push(ridgePart([0.90, 0.88, 0.78], f.jawRots, tusks, 4, MAT.HORN));
  }

  // ----- kit ---------------------------------------------------------------
  //
  // Both pieces are HUGGING SHELLS (`makeBoxSpherePart`), not boxes.
  //
  // They were `makeBevelPart` boxes spanning most of `chestRY`, and the result
  // was a cardboard carton over the goblin's chest with its chin inside it —
  // a box circumscribes the ellipsoid it is meant to clothe, so it protrudes
  // everywhere except the three axis poles, and `chestRY` is tall enough to
  // reach the jaw. Same mistake, same fix, as the Dread King's breastplate.
  {
    const jy = f.chestY - chestRY * 0.22;
    const jw = f.torsoWidthAt(jy) * 1.05;
    parts.push(makeBoxSpherePart(jerkinC, f.spineRots,
      -jw, jy - chestRY * 0.50, -chestRZ * 1.06,
      jw, jy + chestRY * 0.30, chestRZ * 1.06, 1, 7, 4, MAT.FELT));
  }
  // Loincloth — a short skirt at the hips.
  {
    const ly = s * plan.hipY + f.bob;
    parts.push(makeBoxSpherePart(jerkinC, f.spineRots,
      -px * 1.02, ly - s * 0.16, -chestRZ * 0.92,
      px * 1.02, ly + s * 0.04, chestRZ * 0.92, 1, 7, 3, MAT.CLOTH));
  }
  // Shoulder caps bridge the arm root into the torso. Without them the
  // shoulder joint is a visible seam where two ellipsoids intersect.
  for (const arm of f.arms) {
    const ax = arm.side * f.torsoWidthAt(f.shoulderY) * 0.92;
    const sr = s * plan.limbR * 1.30;
    parts.push(makeBoxSpherePart(skinC, f.spineRots,
      ax - sr, f.shoulderY - sr * 0.85, -sr * 0.95,
      ax + sr, f.shoulderY + sr * 0.75, sr * 0.95, 1, 6, 4, MAT.SKIN));
  }

  // ----- weapon ------------------------------------------------------------
  const rArm = f.arms[1];
  const rx = f.torsoWidthAt(f.shoulderY) * 0.96;
  if (archer) {
    // A short recurve held ACROSS the body in the left hand, with the right
    // hand at the string. The draw rides `foreSwing` through the arm chain, so
    // the bow bends and the string comes back as one motion.
    const lArm = f.arms[0];
    const lx = -rx;
    const bowC: Color3 = [0.32, 0.22, 0.13];
    // Held ACROSS the chest, not hanging from the fist.
    //
    // A goblin's arms reach almost to its knees — that is the species read —
    // so `wristY` sits about 25 cm off the floor on a 1.1 m doll. A
    // proportionate bow centred there puts 20+ cm of its lower limb THROUGH
    // the ground, at rest and worse mid-stride. It was invisible from every
    // camera angle a portrait harness would choose and the vertex-AABB check
    // in test-animal-mesh.mts found it immediately, which is exactly the
    // division of labour those two are supposed to have.
    //
    // Anchoring at the elbow and shortening the limbs to a 0.62 m recurve
    // fixes it with margin: the whole bow now hangs from a pivot it can only
    // rotate UPWARD about.
    const bowY = f.elbowY + s * 0.10;
    const limbLen = s * 0.34;
    parts.push(bonePart(bowC, lArm.foreRots,
      [lx, bowY - limbLen, -s * 0.10], [lx, bowY + limbLen, -s * 0.10],
      s * 0.016, s * 0.016, 4, MAT.WOOD));
    // Two swept tips, so the bow is a recurve rather than a stick.
    for (const dy of [-1, 1] as const) {
      parts.push(bonePart(bowC, lArm.foreRots,
        [lx, bowY + dy * limbLen, -s * 0.10],
        [lx, bowY + dy * limbLen * 1.26, -s * 0.02],
        s * 0.014, s * 0.008, 4, MAT.WOOD));
    }
    // Nocked arrow, on the DRAW hand's chain so it tracks the string.
    parts.push(bonePart([0.70, 0.62, 0.48], rArm.foreRots,
      [rx * 0.30, bowY, -s * 0.06], [rx * 0.30, bowY, -s * 0.62],
      s * 0.010, s * 0.010, 4, MAT.WOOD));
  } else {
    // A crude cleaver: a wide, badly-forged blade on a bound haft. Held down
    // and back at rest, swinging up and through on `foreSwing`.
    const haftC: Color3 = [0.34, 0.24, 0.15];
    const bladeC: Color3 = [0.46, 0.47, 0.50];
    const gripY = f.wristY;
    parts.push(bonePart(haftC, rArm.foreRots,
      [rx, gripY + s * 0.10, 0], [rx, gripY - s * 0.16, -s * 0.06],
      s * 0.022, s * 0.026, 4, MAT.WOOD));
    parts.push(makeBevelPart(bladeC, rArm.foreRots,
      rx - s * 0.020, gripY + s * 0.08, -s * 0.10,
      rx + s * 0.020, gripY + s * 0.58, s * 0.05,
      s * 0.012, MAT.IRON));
  }

  return parts;
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

/**
 * Skeleton — the one that needed genuinely new geometry.
 *
 * **The gaps between the bones are the entire point. The torso is not
 * filled.** A skeleton built from the goblin's solid masses in a bone colour
 * is a pale goblin; what makes it read is that you can see the room through
 * its ribs. That is why this is a separate builder rather than a palette swap,
 * and why it is the most expensive of the three.
 *
 * Everything is `MAT.BONE`, whose table row has `tint: 0.25` — the baked bone
 * texture wins and the vertex colour only nudges it. That is correct here and
 * is why the variant tints below are deliberately small.
 */
function buildSkeleton(species: HumanoidSpecies, pose: AnimalPose, variant: number): Part[] {
  const f = solveFrame(species, pose);
  const { s, plan } = f;

  const boneC = applyVariant(BASE_COLORS[species], variant);
  const darkC = BELLY_COLORS[species];   // shadowed bone, sockets
  const accentC = ACCENT_COLORS[species]; // rusted iron

  const parts: Part[] = [];
  const r = s * plan.limbR;

  // ----- spine -------------------------------------------------------------
  //
  // Five vertebrae from the pelvis to the base of the skull. Drawn as separate
  // beads rather than one column so the column reads as segmented at range,
  // which is most of what says "skeleton" from behind.
  const hipTop = s * plan.hipY + s * 0.10 + f.bob;
  const neckY = s * 1.02 + f.bob;
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    const y = hipTop + (neckY - hipTop) * t;
    const vr = r * (2.05 - 0.45 * t);
    parts.push(makeBoxSpherePart(boneC, f.spineRots,
      -vr, y - vr * 0.62, -vr * 0.72, vr, y + vr * 0.62, vr * 0.86, 1, 5, 3, MAT.BONE));
  }

  // ----- ribcage -----------------------------------------------------------
  //
  // Six pairs of tapered arcs, each a two-segment bone from the spine round to
  // where a sternum would be. Radius grows then shrinks down the cage, which
  // is the barrel shape a real ribcage has and the reason a stack of equal
  // hoops looks like a spring instead.
  const cageTop = neckY - s * 0.10;
  const cageBot = hipTop + s * 0.10;
  for (let i = 0; i < 6; i++) {
    const t = i / 5;
    const y = cageTop + (cageBot - cageTop) * t;
    // Widest at the third rib.
    const bulge = Math.sin((0.18 + t * 0.74) * Math.PI);
    const rx = s * plan.chestW * (0.62 + 0.46 * bulge);
    const rz = s * plan.chestD * (0.70 + 0.40 * bulge);
    const drop = s * 0.045 * t;
    for (const side of [-1, 1] as const) {
      // Spine → flank
      parts.push(bonePart(boneC, f.spineRots,
        [0, y, rz * 0.52], [side * rx, y - drop * 0.4, 0],
        r * 0.86, r * 0.70, 3, MAT.BONE));
      // Flank → sternum, angled down and in
      parts.push(bonePart(boneC, f.spineRots,
        [side * rx, y - drop * 0.4, 0], [side * rx * 0.30, y - drop, -rz * 0.92],
        r * 0.70, r * 0.56, 3, MAT.BONE));
    }
  }
  // Sternum — a thin plate closing the front of the cage.
  parts.push(makeBevelPart(boneC, f.spineRots,
    -s * plan.chestW * 0.20, cageBot + s * 0.06, -s * plan.chestD * 1.00,
    s * plan.chestW * 0.20, cageTop - s * 0.02, -s * plan.chestD * 0.86,
    s * 0.012, MAT.BONE));

  // ----- pelvis ------------------------------------------------------------
  const px = s * plan.chestW * 0.86;
  parts.push(makeBevelPart(boneC, f.spineRots,
    -px, s * plan.hipY - s * 0.09 + f.bob, -s * plan.chestD * 0.72,
    px, s * plan.hipY + s * 0.11 + f.bob, s * plan.chestD * 0.72,
    s * 0.022, MAT.BONE));

  // ----- clavicles + shoulder blades ---------------------------------------
  for (const arm of f.arms) {
    const ax = arm.side * s * plan.chestW * 1.02;
    parts.push(bonePart(boneC, f.spineRots,
      [0, neckY - s * 0.03, -s * plan.chestD * 0.42],
      [ax, f.shoulderY, -s * plan.chestD * 0.10],
      r * 0.72, r * 0.60, 3, MAT.BONE));
  }

  // ----- limbs -------------------------------------------------------------
  //
  // Bare bone: no muscle mass, and the taper runs the anatomical way (thick at
  // the joints, narrow at the shaft) which is the opposite of a fleshed limb.
  for (const leg of f.legs) {
    parts.push(bonePart(boneC, leg.thighRots,
      [leg.lx, leg.kneeY, 0], [leg.lx, leg.hipY, 0], r * 1.10, r * 1.28, 4, MAT.BONE));
    parts.push(bonePart(boneC, leg.shinRots,
      [leg.lx, leg.ankleY, 0], [leg.lx, leg.kneeY, 0], r * 0.92, r * 1.06, 4, MAT.BONE));
    // Foot: a flat plate rather than a pad — there is no flesh on it.
    parts.push(makeBevelPart(boneC, leg.footRots,
      leg.lx - r * 1.5, leg.toeY, -r * 4.2,
      leg.lx + r * 1.5, leg.toeY + r * 1.2, r * 1.6,
      r * 0.4, MAT.BONE));
  }
  for (const arm of f.arms) {
    const ax = arm.side * s * plan.chestW * 1.02;
    parts.push(bonePart(boneC, arm.upperRots,
      [ax, f.elbowY, 0], [ax, f.shoulderY, 0], r * 0.92, r * 1.10, 4, MAT.BONE));
    parts.push(bonePart(boneC, arm.foreRots,
      [ax, f.wristY, 0], [ax, f.elbowY, 0], r * 0.78, r * 0.92, 4, MAT.BONE));
    parts.push(makeBevelPart(boneC, arm.foreRots,
      ax - r * 1.4, f.wristY - r * 2.4, -r * 1.0,
      ax + r * 1.4, f.wristY + r * 0.4, r * 1.0,
      r * 0.35, MAT.BONE));
  }

  // ----- skull -------------------------------------------------------------
  const hr = s * plan.headR;
  parts.push(makeBoxSpherePart(boneC, f.headRots,
    -hr, f.headY - hr * 0.92, -hr * 0.96,
    hr, f.headY + hr * 1.00, hr * 1.04, 1, 8, 5, MAT.BONE));
  // Brow ridge and cheek line, as one plate across the face.
  parts.push(makeBevelPart(boneC, f.headRots,
    -hr * 0.92, f.headY + hr * 0.06, -hr * 1.06,
    hr * 0.92, f.headY + hr * 0.42, -hr * 0.60,
    hr * 0.10, MAT.BONE));
  // Jaw, on the hinge chain — a skeleton's jaw hanging open is the read.
  parts.push(makeBevelPart(boneC, f.jawRots,
    -hr * 0.68, f.headY - hr * 1.02, -hr * 0.94,
    hr * 0.68, f.headY - hr * 0.56, hr * 0.36,
    hr * 0.12, MAT.BONE));
  // Teeth, upper only — a fringe under the cheek plate.
  {
    const teeth: { base: Vec3; dir: Vec3; r: number; len: number }[] = [];
    for (let i = -2; i <= 2; i++) {
      teeth.push({
        base: [i * hr * 0.28, f.headY - hr * 0.44, -hr * 0.78],
        dir: [0, -1, -0.16], r: hr * 0.075, len: hr * 0.26,
      });
    }
    parts.push(ridgePart(boneC, f.headRots, teeth, 3, MAT.BONE));
  }
  // Eye sockets: recessed and near-black. Sunk INTO the skull rather than
  // sitting on it, which is the difference between sockets and beads.
  // Sockets, not beads: large, near-black, and sunk just far enough into the
  // skull's surface to read as holes. Pushed forward from -0.62 to -0.80 of a
  // head radius, which is where the skull actually is at this width — the
  // original value put both sockets inside the bone.
  parts.push(...makeEyeParts(darkC, f.headRots,
    hr * 0.46, f.headY + hr * 0.14, -hr * 0.80, hr * 0.30, MAT.LEATHER));

  // ----- weapon ------------------------------------------------------------
  // A pitted iron shortsword, held point-down at rest.
  {
    const rArm = f.arms[1];
    const ax = s * plan.chestW * 1.02;
    const gripY = f.wristY;
    parts.push(bonePart([0.24, 0.20, 0.16], rArm.foreRots,
      [ax, gripY + s * 0.09, 0], [ax, gripY - s * 0.10, 0],
      s * 0.017, s * 0.019, 4, MAT.LEATHER));
    parts.push(makeBevelPart(accentC, rArm.foreRots,
      ax - s * 0.035, gripY + s * 0.08, -s * 0.012,
      ax + s * 0.035, gripY + s * 0.11, s * 0.012,
      s * 0.008, MAT.IRON));
    parts.push(makeBevelPart(accentC, rArm.foreRots,
      ax - s * 0.016, gripY + s * 0.10, -s * 0.030,
      ax + s * 0.016, gripY + s * 0.66, s * 0.030,
      s * 0.010, MAT.IRON));
  }

  return parts;
}

// ---------------------------------------------------------------------------
// Dread King
// ---------------------------------------------------------------------------

/**
 * The Dread King — the set piece.
 *
 * The brief was "basically Ganondorf": not a bigger goblin, a *lord*. Four
 * things carry that, all of them silhouette:
 *
 *  - **Scale.** 2.4 m against the player's 1.62. He is a head and shoulders
 *    taller than anything else that walks upright in the game.
 *  - **Shoulders.** Pauldrons outboard of an already-wide chest, so the
 *    outline is a wedge.
 *  - **A crown.** Five spikes, gold on iron, above a horned brow.
 *  - **A cape**, hanging from the pauldrons and swaying with the torso.
 *
 * Plus two emissive eyes: `MAT.GEM` carries `emissive: 0.6`, so they read as
 * two hot points from across a dark room, which is worth more menace per
 * vertex than anything else on the model.
 */
function buildDreadKing(species: HumanoidSpecies, pose: AnimalPose, variant: number): Part[] {
  const f = solveFrame(species, pose);
  const { s, plan } = f;

  const ironC = applyVariant(BASE_COLORS[species], variant);
  const clothC = BELLY_COLORS[species];
  const goldC = ACCENT_COLORS[species];
  const skinC: Color3 = [0.42, 0.44, 0.36];
  const eyeC: Color3 = [1.0, 0.62, 0.18];

  const parts: Part[] = [];
  const chestRX = s * plan.chestW;
  const chestRY = (s * 0.90 - s * plan.hipY) * 0.62;
  const chestRZ = s * plan.chestD;

  // ----- torso -------------------------------------------------------------
  parts.push(makeBoxSpherePart(ironC, f.spineRots,
    -chestRX, f.chestY - chestRY, -chestRZ,
    chestRX, f.chestY + chestRY, chestRZ, 1, 9, 6, MAT.IRON));
  parts.push(makeBoxSpherePart(ironC, f.spineRots,
    -chestRX * plan.waistMul, f.waistY - chestRY * 0.62, -chestRZ * 0.86,
    chestRX * plan.waistMul, f.waistY + chestRY * 0.58, chestRZ * 0.86,
    1, 8, 5, MAT.IRON));
  parts.push(makeBoxSpherePart(ironC, f.spineRots,
    -chestRX * 0.80, s * plan.hipY - s * 0.05 + f.bob, -chestRZ * 0.82,
    chestRX * 0.80, s * plan.hipY + s * 0.15 + f.bob, chestRZ * 0.82,
    1, 7, 4, MAT.IRON));

  // Breastplate.
  //
  // A CURVED shell, not a plate, and it stops well below the chin.
  //
  // The first version was a `makeBevelPart` box spanning most of `chestRY` —
  // and `chestRY` on a 2.4 m figure is 0.44 m, so the box reached from the
  // navel to above the jaw and rendered as a flat gold slab with the King's
  // face behind it. Two lessons, both of which apply to every plate below:
  // a BOX on an ELLIPSOID always protrudes at the corners, and `chestRY` is
  // the wrong unit for anything that has to respect a neckline.
  {
    const by = f.chestY - chestRY * 0.18;
    const bw = f.torsoWidthAt(by) * 1.02;
    parts.push(makeBoxSpherePart(goldC, f.spineRots,
      -bw, by - chestRY * 0.42, -chestRZ * 1.08,
      bw, by + chestRY * 0.34, chestRZ * 0.10, 1, 7, 4, MAT.GOLD));
  }
  // Belt — a thin band, hugging.
  parts.push(makeBoxSpherePart(goldC, f.spineRots,
    -chestRX * 0.92, f.waistY - chestRY * 0.58, -chestRZ * 0.96,
    chestRX * 0.92, f.waistY - chestRY * 0.34, chestRZ * 0.96,
    1, 7, 3, MAT.GOLD));
  // Gorget — the collar, between the breastplate and the chin.
  parts.push(makeBoxSpherePart(goldC, f.spineRots,
    -chestRX * 0.50, s * 0.985 + f.bob, -chestRZ * 0.60,
    chestRX * 0.50, s * 1.045 + f.bob, chestRZ * 0.60, 1, 7, 3, MAT.GOLD));

  // ----- limbs -------------------------------------------------------------
  fleshLimbs(parts, f, ironC, MAT.IRON, 1.42, 0.86);
  feet(parts, f, ironC, MAT.IRON, 1.6);
  hands(parts, f, ironC, MAT.IRON);

  // Pauldrons — outboard of the shoulder, which is what makes the outline a
  // wedge rather than a column. They ride the SPINE chain, not the arm: real
  // pauldrons are strapped to the cuirass and do not swing with the elbow.
  for (const arm of f.arms) {
    const ax = arm.side * (f.torsoWidthAt(f.shoulderY) + s * 0.05);
    const pr = s * 0.145;
    parts.push(makeBoxSpherePart(ironC, f.spineRots,
      ax - pr, f.shoulderY - pr * 0.70, -pr * 1.05,
      ax + pr, f.shoulderY + pr * 0.90, pr * 1.05, 0.72, 7, 5, MAT.IRON));
    // A single spike off each, angled outward and back.
    parts.push(spikePart(goldC, f.spineRots,
      [ax + arm.side * pr * 0.30, f.shoulderY + pr * 0.55, 0],
      [arm.side * 0.72, 0.62, 0.30], s * 0.028, s * 0.20, 5, MAT.GOLD));
  }

  // ----- cape --------------------------------------------------------------
  //
  // Six stacked panels hanging off the pauldrons, each wider and further back
  // than the last, so the hem trails. Built as one part with double-sided
  // quads — a single-winding sheet is invisible from behind, which is exactly
  // the angle you see a fleeing player's pursuer from.
  {
    const topY = f.shoulderY - s * 0.02;
    const hemY = s * plan.hipY * 0.34 + f.bob;
    const sway = (pose.tailSway ?? 0);
    const verts: number[] = [];
    // Rows down the cape, columns ACROSS it.
    //
    // Columns are what the first version lacked: it was one quad per row, so
    // the cape was a single flat plane 1.75 m wide, and from the front it read
    // as a red door with a King behind it. Curving it around the back over
    // five columns costs 4x the triangles of a flat sheet (still only ~360
    // verts) and is the entire difference between "cloak" and "billboard".
    const ROWS = 5, COLS = 5;
    const st = (t: number, u: number): Vec3 => {
      // u in [-1, 1] across the cape.
      const y = topY + (hemY - topY) * t;
      const half = chestRX * (0.98 + 0.42 * t);
      const wrap = Math.cos(u * Math.PI * 0.5);       // 1 at centre, 0 at edge
      return [
        u * half + sway * s * 0.14 * t * t,
        y,
        // Wraps forward at the edges (following the shoulders) and falls away
        // behind at the centre, so the silhouette is a shell rather than a
        // plane. `+Z` is behind: yaw 0 faces -Z.
        chestRZ * (0.34 + 0.62 * wrap + 0.70 * t * t) + sway * s * 0.09 * t * t,
      ];
    };
    const push3 = (a: Vec3, b: Vec3, c: Vec3): void => {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      verts.push(a[0], a[1], a[2], nx, ny, nz,
        b[0], b[1], b[2], nx, ny, nz,
        c[0], c[1], c[2], nx, ny, nz);
    };
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const t0 = r / ROWS, t1 = (r + 1) / ROWS;
        const u0 = -1 + (2 * c) / COLS, u1 = -1 + (2 * (c + 1)) / COLS;
        const p0 = st(t0, u0), p1 = st(t0, u1);
        const p2 = st(t1, u1), p3 = st(t1, u0);
        // Double-sided: a single-winding sheet is invisible from one side, and
        // for a cape that side is the one a pursued player is looking at.
        push3(p0, p1, p2); push3(p0, p2, p3);
        push3(p2, p1, p0); push3(p3, p2, p0);
      }
    }
    parts.push({ verts, color: clothC, material: MAT.CLOTH, rots: f.spineRots });
  }

  // ----- head --------------------------------------------------------------
  const hr = s * plan.headR;
  // Helm: covers the skull, leaves the face open.
  // The helm covers the CROWN of the skull and stops at the brow. Its lower
  // edge used to sit at -0.60 hr, below the eye line, so the face was inside
  // it and the King read as a featureless dome above a gold collar.
  parts.push(makeBoxSpherePart(ironC, f.headRots,
    -hr * 1.06, f.headY - hr * 0.10, -hr * 0.96,
    hr * 1.06, f.headY + hr * 1.14, hr * 1.10, 1, 8, 5, MAT.IRON));
  // Face — grey-green, in shadow under the brow.
  parts.push(makeBoxSpherePart(skinC, f.headRots,
    -hr * 0.80, f.headY - hr * 0.98, -hr * 1.00,
    hr * 0.80, f.headY + hr * 0.30, hr * 0.30, 1, 7, 4, MAT.SKIN));
  parts.push(makeBevelPart(skinC, f.jawRots,
    -hr * 0.62, f.headY - hr * 1.16, -hr * 0.92,
    hr * 0.62, f.headY - hr * 0.72, hr * 0.20,
    hr * 0.12, MAT.SKIN));

  // Emissive eyes. Two spheres, and the single best menace-per-vertex on the
  // whole roster: `MAT.GEM` is emissive, so they hold at 50 m in a dark room.
  // Proud of the face, not inside it — see the goblin's eyes for the failure
  // this avoids. `MAT.GEM` carries emissive 0.6, so two spheres buy more
  // menace at range than anything else on the model, but only if they are
  // actually on the outside of the head.
  parts.push(...makeEyeParts(eyeC, f.headRots,
    hr * 0.44, f.headY - hr * 0.16, -hr * 0.88, hr * 0.17, MAT.GEM));

  // Crown: five spikes on a band, tallest at the centre.
  {
    const spikes: { base: Vec3; dir: Vec3; r: number; len: number }[] = [];
    for (let i = -2; i <= 2; i++) {
      const t = Math.abs(i) / 2;
      const ang = i * 0.52;
      spikes.push({
        base: [Math.sin(ang) * hr * 0.94, f.headY + hr * 0.72,
          -Math.cos(ang) * hr * 0.30],
        dir: [Math.sin(ang) * 0.45, 1, -0.10],
        r: hr * (0.16 - 0.03 * t), len: hr * (1.35 - 0.48 * t),
      });
    }
    parts.push(ridgePart(goldC, f.headRots, spikes, 5, MAT.GOLD));
  }
  // Brow horns, sweeping back — the read that says this is not a man in armour.
  for (const side of [-1, 1] as const) {
    parts.push(spikePart(goldC, f.headRots,
      [side * hr * 0.90, f.headY + hr * 0.28, -hr * 0.20],
      [side * 0.80, 0.42, 0.72], hr * 0.20, hr * 1.55, 5, MAT.HORN));
  }

  // ----- greatsword --------------------------------------------------------
  //
  // 1.9 m of it at full scale, which is longer than the player is tall. The
  // reach is real — `dread_king`'s attack ranges are authored against this
  // blade, so the weapon and the hitbox agree.
  {
    const rArm = f.arms[1];
    const ax = f.torsoWidthAt(f.shoulderY) * 0.96;
    const gripY = f.wristY;
    // Grip
    parts.push(bonePart([0.16, 0.14, 0.16], rArm.foreRots,
      [ax, gripY + s * 0.14, 0], [ax, gripY - s * 0.16, 0],
      s * 0.022, s * 0.024, 4, MAT.LEATHER));
    // Pommel
    parts.push(makeBoxSpherePart(goldC, rArm.foreRots,
      ax - s * 0.038, gripY - s * 0.22, -s * 0.038,
      ax + s * 0.038, gripY - s * 0.14, s * 0.038, 1, 5, 3, MAT.GEM));
    // Crossguard
    parts.push(makeBevelPart(goldC, rArm.foreRots,
      ax - s * 0.115, gripY + s * 0.13, -s * 0.022,
      ax + s * 0.115, gripY + s * 0.18, s * 0.022,
      s * 0.010, MAT.GOLD));
    // Blade — wide at the guard, tapering to a point.
    parts.push(bonePart([0.60, 0.62, 0.66], rArm.foreRots,
      [ax, gripY + s * 0.17, 0], [ax, gripY + s * 1.16, 0],
      s * 0.048, s * 0.014, 4, MAT.IRON));
  }

  return parts;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build the parts for one humanoid enemy.
 *
 * `evil_king` is deliberately excluded: he is a humanoid in every other sense
 * — same plan table, same `solveFrame`, same gait — but his geometry lives in
 * `king-mesh.ts`, and that module imports `solveFrame` from here. Routing him
 * through this switch would make the two files import each other. `buildAnimalMesh`
 * dispatches him directly instead, and the `Exclude` keeps the switch exhaustive
 * so a sixth humanoid still fails to compile until it is handled.
 */
export function buildHumanoid(
  species: Exclude<HumanoidSpecies, 'evil_king'>, pose: AnimalPose,
  variant: number,
): Part[] {
  switch (species) {
    case 'goblin':
    case 'goblin_archer':
      return buildGoblin(species, pose, variant);
    case 'skeleton':
      return buildSkeleton(species, pose, variant);
    case 'dread_king':
      return buildDreadKing(species, pose, variant);
  }
}
