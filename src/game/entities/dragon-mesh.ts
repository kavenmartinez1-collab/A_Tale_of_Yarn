/**
 * dragon-mesh.ts — the dragon body plan.
 *
 * Split out of animal-mesh.ts so it can be iterated on independently of the
 * other species; shares the part builders, colour tables and poser in
 * creature-parts.ts and the winged-reptile anatomy kit in draconic-parts.ts.
 * Conventions are identical to every other body plan: local space with the
 * base at y = 0, facing -Z at yaw 0.
 *
 * WHAT CHANGED IN THE REBUILD, AND WHY
 *
 * The previous rig was assembled but crude, in four specific ways. Each is
 * called out again at the code that fixes it:
 *
 *  1. **The head was three beveled boxes** (skull, snout, jaw) and read as a
 *     brick with a brick on it. It is now a rounded cranium, a tapered snout
 *     that actually narrows toward the nostrils, a hinged tapered jaw, brow
 *     ridges, teeth and — the single cheapest character cue available and
 *     previously absent entirely — EYES.
 *  2. **The wings were flat quads between straight spars**, held in one
 *     spread pose whether the animal was flying, walking or asleep. They now
 *     fold (see `spread`), the membrane is scalloped between spars and
 *     cambered between them, and an inner panel runs from the arm down to the
 *     flank so the wing belongs to the animal instead of floating beside it.
 *  3. **The neck and tail were capsule chains leaning by a per-segment
 *     angle**, which cannot describe an S-curve: each link only knows its own
 *     lean, so the neck rose to vertical and stopped, like a periscope. Both
 *     are now sampled off a cubic Bezier with a cubic radius falloff.
 *  4. **The legs pitched rigidly from the hip** by sin(walkPhase), with no
 *     knee and a foot that skated and sank. They are now three-segment
 *     folding limbs on the same planted-foot IK rig the quadrupeds use
 *     (`../anim/gait`), fore limbs breaking backward at the carpus and hind
 *     limbs forward at the stifle over a set-back hock.
 *
 * Two external contracts constrain the proportions and must not be broken by
 * future tuning, because both live in files this module cannot see:
 *
 *  - `main.ts:saddleY` seats the rider at exactly `size` (3.5 m) above the
 *    dragon's base, so the spine has to reach roughly that or the player
 *    floats above the animal. `bodyTop` is 0.98 * size.
 *  - `main.ts:getBreathRay` fires the fire cone from a hardcoded local
 *    (forward 1.27 * size, up 1.61 * size), derived from the OLD mesh. The
 *    snout tip is therefore pinned to z = -1.27 * size.
 */

import { SPECIES_DEFS, type Species } from './entity-types';
import { MAT } from '../render/material-table';
import {
  footTarget, makeLegPlan, maxStride, solveLeg, strideLength,
  type GaitPattern, type LegPlan,
} from '../anim/gait';
import {
  applyVariant, makeBoxSpherePart,
  pitch, twistY,
  ACCENT_COLORS, BASE_COLORS, BELLY_COLORS,
  type AnimalPose, type Color3, type Part, type Rot,
} from './creature-parts';
import {
  bonePart, buildWing, chainBones, chainRidge, mix, norm,
  ridgePart, sampleChain, spikePart, tailFinPart,
  type ChainSample, type Vec3, type WingSpec,
} from './draconic-parts';

// ---------------------------------------------------------------------------
// Locomotion
// ---------------------------------------------------------------------------

/**
 * The dragon's gait.
 *
 * A duty below 0.5 means a suspension phase — all four feet off the ground at
 * once. That is deliberate and it is forced by arithmetic, not taste: the AI
 * advances `walkPhase` using `animalStride('dragon')`, which for a non-
 * quadruped body plan is `size * 1.25` = 4.38 m per cycle, and a planted foot
 * must sweep `stride * duty` of ground backward during its stance. A limb
 * rooted 2.03 m up can reach about 0.97 m either side of the hip, so
 * `duty <= 2 * 0.97 / 4.38 = 0.44` or the IK clamps — and a clamped foot
 * slides, which is the whole defect the planted rig exists to remove.
 *
 * The result is honest anyway: SPECIES_DEFS gives the dragon 6 m/s, which for
 * an animal this size is a run, and a running quadruped has a suspension
 * phase. `lift` is kept low so the airborne interval is a hand's breadth
 * rather than a hop.
 */
const DRAGON_GAIT: GaitPattern = {
  duty: 0.38,
  offsets: [0, 0.5, 0.5, 0], // diagonal pairs — a heavy trot
  lift: 0.15,
};

// ---------------------------------------------------------------------------
// Proportions, as coefficients of `size` (3.5 m for the dragon)
// ---------------------------------------------------------------------------

const HIP = 0.58;        // leg-root / belly-line height
const BODY_H = 0.40;     // torso depth
const BODY_W = 0.30;     // torso half-width
const BODY_L = 0.64;     // torso half-length

/**
 * Rest-pose limb plans. Memoized per size — bone lengths depend only on the
 * species constants, and recomputing them for every dragon every frame would
 * be pure waste. Keyed by size rather than cached in a bare variable so that
 * calling the builder for a differently-sized species can never silently
 * return another species' skeleton.
 */
const RIG_CACHE = new Map<number, { fore: LegPlan; hind: LegPlan; stride: number }>();
function dragonRig(s: number): { fore: LegPlan; hind: LegPlan; stride: number } {
  const cached = RIG_CACHE.get(s);
  if (cached !== undefined) return cached;
  const rootY = s * HIP;
  const bodyL = s * BODY_L;
  // Fore: carpus breaks BACKWARD, ankle nearly over the toes. Hind: stifle
  // forward over a hock set well back, and more slack — a dragon's hind limb
  // is the deeply-folded one, which is also what buys it the reach to cover
  // the stride above.
  const fore = makeLegPlan(rootY, -bodyL * 0.58, rootY * 0.30, 0.22, -1, 0.52, 1.28);
  const hind = makeLegPlan(rootY, bodyL * 0.60, rootY * 0.34, 0.48, +1, 0.50, 1.34);
  const rig = { fore, hind, stride: strideLength(s) };
  RIG_CACHE.set(s, rig);
  return rig;
}

/**
 * Longest stride the limbs can cover without the IK clamping. Exported so the
 * mesh test can assert the constraint above rather than trusting the comment.
 */
export function dragonMaxStride(species: Species = 'dragon'): number {
  const rig = dragonRig(SPECIES_DEFS[species].size);
  return Math.min(
    maxStride(rig.fore, DRAGON_GAIT.duty),
    maxStride(rig.hind, DRAGON_GAIT.duty));
}

/** The stride the mesh actually solves against (matches `animalStride`). */
export function dragonStride(species: Species = 'dragon'): number {
  return strideLength(SPECIES_DEFS[species].size);
}

// ---------------------------------------------------------------------------
// Body plan
// ---------------------------------------------------------------------------

/**
 * Per-species overrides for the two colours the builder derives rather than
 * reads from a table.
 *
 * Both defaults are relationships, not choices — the membrane is the body
 * desaturated and darkened, the eye is molten gold — and both of those
 * relationships break on a near-black dragon: a membrane at 0.6x of 0.08 is
 * indistinguishable from the body, and a gold eye on a black-and-red boss is
 * the wrong accent entirely. Rather than fork four hundred lines of dragon,
 * the two colours that need to move are a parameter.
 *
 * Omitted fields keep the derived defaults exactly, so `buildDragon(sp, pose,
 * v)` is unchanged for the existing dragon and the golden hashes hold.
 */
export interface DragonStyle {
  /** Wing membrane. Default: the body colour dimmed and desaturated. */
  membrane?: Color3;
  /** Iris. Default: molten gold. */
  eye?: Color3;
  /** Material for the eye. Default `MAT.HORN` (glossy, low tint). */
  eyeMaterial?: number;
  /**
   * Extra parts, appended last, given the solved body.
   *
   * This is how a species adds a saddle, barding or a crest without forking
   * the builder. It receives the surface solvers rather than the bounding box
   * on purpose: `makeBoxSpherePart` inscribes an ELLIPSOID, so anything
   * anchored to `bodyTop` hovers over the back with daylight under it, and
   * this rig has already lost a saddle to exactly that.
   */
  extras?: (frame: DragonFrame) => Part[];
}

/** The solved body, handed to `DragonStyle.extras`. All lengths in metres. */
export interface DragonFrame {
  /** `SPECIES_DEFS[species].size` — every other number is a multiple of it. */
  s: number;
  /** Gait bob already folded into the body masses this frame. */
  bob: number;
  hipY: number;
  bodyH: number;
  /** Torso HALF-width and HALF-length. */
  bodyW: number;
  bodyL: number;
  /** Bounding-box lid of the torso. Almost never what you want — see below. */
  bodyTop: number;
  /** Real hide height over (x, z). Anchor to this, not to `bodyTop`. */
  torsoTopAt: (x: number, z: number) => number;
  /** Real hide z at the rear, at height y. */
  rearZAt: (y: number) => number;
  /** Head chain (the head-yaw twist). Hang skull geometry off this. */
  headRots: Rot[];
  /** Cranium ellipsoid centre and half-extents. */
  craniumC: Vec3;
  craniumR: Vec3;
  /** The sampled neck and tail curves, joints and all. */
  neck: ChainSample;
  tail: ChainSample;
  /** Wing fold, 0 furled .. 1 fully out, and the current beat, -1..1. */
  spread: number;
  beat: number;
}

export function buildDragon(
  species: Species, pose: AnimalPose, variant: number, style?: DragonStyle,
): Part[] {
  const s = SPECIES_DEFS[species].size; // 3.5 for dragon
  const bodyC = applyVariant(BASE_COLORS[species], variant);   // dark crimson
  const bellyC = BELLY_COLORS[species];                        // darker underbelly
  const accentC = ACCENT_COLORS[species];                      // near-black horn

  // Wing membrane — desaturated, darker hide stretched thin.
  const membraneC: Color3 = style?.membrane ?? [
    Math.min(1, bodyC[0] * 0.62),
    Math.min(1, bodyC[1] * 0.50 + 0.03),
    Math.min(1, bodyC[2] * 0.50 + 0.03),
  ];
  // Molten gold eye. The old head had no eye at all, which is most of why it
  // read as a lump with a mouth: an eye is where a face resolves.
  const eyeC: Color3 = style?.eye ?? [0.96, 0.74, 0.16];
  const eyeMat = style?.eyeMaterial ?? MAT.HORN;

  const hipY = s * HIP;
  const bodyH = s * BODY_H;
  const bodyW = s * BODY_W;
  const bodyL = s * BODY_L;
  const bodyTop = hipY + bodyH;

  // ----- Animation drivers -------------------------------------------------
  const walkAmp = pose.walkAmp;
  const flapPhase = pose.flapPhase ?? pose.walkPhase;
  const flapAmp = pose.flapAmp ?? pose.walkAmp;

  /**
   * Wing spread: 0 = furled against the flank, 1 = fully out.
   *
   * Driven off the wing-beat amplitude because that is the only signal
   * available. The renderer sets `flapAmp` to 1 when the dragon is moving,
   * 0.35 when it is standing and 0 when it is dead, so a resting or dead
   * dragon folds and a moving one opens. That is the right call for three of
   * the four states; a dragon WALKING with its wings out is the one it gets
   * wrong, and it is the least wrong of the four (grounded dragons do carry
   * their wings half-open for balance).
   *
   * The clean fix is a `flying` flag on AnimalPose set by the renderer, which
   * is out of scope here — entity-renderer.ts and the pose type are owned
   * elsewhere. Reported rather than worked around.
   */
  const spread = Math.max(0, Math.min(1, (flapAmp - 0.36) / 0.58));
  const beat = Math.sin(flapPhase) * flapAmp;

  // Body bob: the mass rises and falls twice per stride as each diagonal pair
  // takes the load. Applied to the TORSO and everything hanging off it, and
  // to the limb ROOTS, but never to the foot targets — the feet stay welded
  // to the ground and the limbs absorb the difference, which is the entire
  // point of solving joints from foot positions.
  //
  // Strictly non-positive, so the limb roots only ever come DOWN toward the
  // feet. A bob that lifted them would eat into the reach margin the stride
  // depends on, and the failure would show up as a hitch at one phase only.
  const bob = walkAmp > 0
    ? (Math.cos(pose.walkPhase * 2) * 0.5 - 0.5) * s * 0.030 * walkAmp
    : 0;

  const parts: Part[] = [];

  // ----- Torso: deep pectoral chest, tucked abdomen, keel -------------------
  // Two masses, not one barrel. The chest carries the wing roots and has to
  // look like it holds flight muscle; the abdomen is narrower with its
  // underside HIGHER, which is the belly tuck every predator has and the
  // reason a dragon does not read as a cow with wings.
  const chest = {
    cz: -bodyL * 0.34, rz: bodyL * 0.66,
    cy: bodyTop - bodyH * 0.49 + bob, ry: bodyH * 0.55,
    rx: bodyW * 1.02,
  };
  const abd = {
    cz: bodyL * 0.36, rz: bodyL * 0.64,
    cy: bodyTop - bodyH * 0.45 + bob, ry: bodyH * 0.39,
    rx: bodyW * 0.84,
  };
  type Mass = typeof chest;
  const topOf = (e: Mass, x: number, z: number): number => {
    const u = x / e.rx, v = (z - e.cz) / e.rz;
    return e.cy + e.ry * Math.sqrt(Math.max(0, 1 - Math.min(1, u * u + v * v)));
  };
  /** Real hide height over (x, z) — NOT the bounding-box lid. */
  const torsoTopAt = (x: number, z: number): number =>
    Math.max(topOf(chest, x, z), topOf(abd, x, z));
  const rearZAt = (y: number): number => {
    const t = (y - abd.cy) / abd.ry;
    return abd.cz + abd.rz * Math.sqrt(Math.max(0, 1 - Math.min(1, t * t)));
  };

  parts.push(makeBoxSpherePart(bodyC, [],
    -chest.rx, chest.cy - chest.ry, chest.cz - chest.rz,
    chest.rx, chest.cy + chest.ry, chest.cz + chest.rz, 1, 8, 5, MAT.SCALE));
  parts.push(makeBoxSpherePart(bodyC, [],
    -abd.rx, abd.cy - abd.ry, abd.cz - abd.rz,
    abd.rx, abd.cy + abd.ry, abd.cz + abd.rz, 1, 8, 5, MAT.SCALE));
  // Keel / sternum: the flight-muscle anchor, slung under the chest in the
  // paler belly colour so the underside reads as scutes rather than hide.
  parts.push(makeBoxSpherePart(bellyC, [],
    -bodyW * 0.60, hipY - bodyH * 0.26 + bob, -bodyL * 0.84,
    bodyW * 0.60, hipY + bodyH * 0.44 + bob, bodyL * 0.24, 1, 6, 3, MAT.SCALE));

  // ----- Legs: three-segment folding limbs on the planted-foot rig ---------
  const rig = dragonRig(s);
  const stride = Math.min(rig.stride, dragonMaxStride(species) * 0.94) * walkAmp;
  const lift = rig.fore.rootY * DRAGON_GAIT.lift * walkAmp;
  const footRise = -(pose.bodyDrop ?? 0);
  const legGap = bodyW * 0.76;
  const legR = s * 0.062;
  // Bury the top of the limb inside the torso and cover the join with a
  // shoulder / haunch mass. Rule A puts the leg roots outside the torso
  // ellipsoid on purpose (so the legs break the silhouette), which means a
  // limb that starts at hipY meets nothing at all.
  const bury = bodyH * 0.46;

  const legDefs: [x: number, plan: LegPlan, phaseOff: number, fore: boolean][] = [
    [-legGap, rig.fore, DRAGON_GAIT.offsets[0], true],
    [legGap, rig.fore, DRAGON_GAIT.offsets[1], true],
    [-legGap, rig.hind, DRAGON_GAIT.offsets[2], false],
    [legGap, rig.hind, DRAGON_GAIT.offsets[3], false],
  ];

  for (const [lx, basePlan, phaseOff, isFore] of legDefs) {
    // The bob moves the limb root; bone lengths stay fixed, or the creature
    // is made of elastic.
    const plan: LegPlan = { ...basePlan, rootY: basePlan.rootY + bob };
    const foot = footTarget(
      pose.walkPhase + phaseOff * Math.PI * 2, stride, lift, DRAGON_GAIT.duty);
    foot.y += footRise;
    const sol = solveLeg(plan, foot);

    const lz = plan.rootZ;
    const hipRot = pitch(sol.upper, plan.rootY, lz);
    const kneeRot = pitch(sol.lower, sol.kneeY, sol.kneeZ);
    const anklRot = pitch(sol.cannon, sol.ankleY, sol.ankleZ);
    const upperRots: Rot[] = [hipRot];
    const lowerRots: Rot[] = [kneeRot, hipRot];
    const cannonRots: Rot[] = [anklRot, kneeRot, hipRot];

    const kneeY = plan.rootY - plan.l1;
    const ankleY = kneeY - plan.l2;
    const toeY = ankleY - plan.cannon;

    const rUp = legR * (isFore ? 1.30 : 1.50);
    const rKnee = legR * 0.94;
    const rAnk = legR * 0.72, rToe = legR * 0.60;

    const bone = (y0: number, y1: number, r0: number, r1: number, rots: Rot[], seg: number) =>
      parts.push(bonePart(bodyC, rots, [lx, y0, lz], [lx, y1, lz], r0, r1, seg, MAT.SCALE));

    bone(kneeY, plan.rootY + bury, rKnee, rUp, upperRots, 5);
    bone(ankleY, kneeY, rAnk, rKnee, lowerRots, 5);
    // Inset the cannon's axis so its hemispherical end cap lands ON the
    // contact point rather than a radius below it. The inset has to be
    // divided by the cosine of the cannon's ABSOLUTE angle: a raked cannon
    // (and a hind cannon is raked, that is what a hock is) swings the cap
    // centre sideways, so a plain radius inset still buries the cap by
    // r(1 - cos) — 1.6 cm on the hind foot, i.e. a claw permanently under the
    // turf, which reads as a modelling error rather than an animation one.
    const absCan = sol.upper + sol.lower + sol.cannon;
    bone(toeY + rToe / Math.max(0.5, Math.cos(absCan)), ankleY, rToe, rAnk, cannonRots, 4);

    // Foot. The sole sits AT the solved contact point and is built upward
    // from it (anything below the toe is underground), and the chain's
    // accumulated rotation is cancelled so the sole stays flat instead of
    // tilting with the pastern.
    const footFlat = pitch(-(sol.upper + sol.lower + sol.cannon), toeY, lz);
    const footRots: Rot[] = [footFlat, ...cannonRots];
    const pr = legR * 1.25;
    parts.push(makeBoxSpherePart(bodyC, footRots,
      lx - pr, toeY, lz - pr * 1.5,
      lx + pr, toeY + pr * 0.95, lz + pr * 0.9, 1, 5, 3, MAT.SCALE));
    // Talons — splayed forward, the reference's chunky raptorial foot.
    const claws: { base: Vec3; dir: Vec3; r: number; len: number }[] = [];
    for (const cx of [-0.75, 0, 0.75]) {
      claws.push({
        base: [lx + cx * pr, toeY + pr * 0.34, lz - pr * 1.35],
        dir: [cx * 0.45, -0.30, -1],
        r: legR * 0.28,
        len: s * 0.085,
      });
    }
    parts.push(ridgePart(accentC, footRots, claws, 3));
  }

  // Shoulder and haunch masses — the muscle that bridges torso to limb.
  for (const side of [-1, 1] as const) {
    const hr = Math.min(bodyW * 0.66, bodyH * 0.58);
    parts.push(makeBoxSpherePart(bodyC, [],
      side * legGap * 0.60 - hr, hipY - s * 0.02 + bob, rig.hind.rootZ - hr * 0.95,
      side * legGap * 0.60 + hr, hipY + hr * 1.45 + bob, rig.hind.rootZ + hr * 1.05,
      0.85, 5, 3, MAT.SCALE));
    const sr = hr * 0.86;
    parts.push(makeBoxSpherePart(bodyC, [],
      side * legGap * 0.60 - sr, hipY - s * 0.01 + bob, rig.fore.rootZ - sr * 1.05,
      side * legGap * 0.60 + sr, hipY + sr * 1.60 + bob, rig.fore.rootZ + sr * 0.90,
      0.85, 5, 3, MAT.SCALE));
  }

  // ----- Neck: an S-curve sampled off a cubic Bezier ------------------------
  // Control points are authored the way a neck is described: out of the
  // chest, up over the withers, then forward and DOWN into the skull. A
  // per-segment lean cannot express that reversal, which is why the old neck
  // stood up like a periscope.
  const headY = s * 1.605 + bob * 0.5;
  const headZ = -s * 0.86;
  const neckDrift = Math.sin(flapPhase * 0.7) * s * 0.02 * flapAmp;
  const neckRootY = hipY + bodyH * 0.86 + bob;
  const neckRootZ = -bodyL * 0.86;
  const neck = sampleChain(
    [0, neckRootY, neckRootZ],
    [0, neckRootY + s * 0.30, neckRootZ + s * 0.05],
    [0, headY + s * 0.065 + neckDrift, headZ + s * 0.16],
    [0, headY + neckDrift, headZ],
    4, s * 0.118, s * 0.058,
    s * 0.022 * walkAmp, pose.walkPhase * 0.5, 0.5);
  parts.push(...chainBones(neck, bodyC, [], [5, 5, 5, 4], MAT.SCALE));
  parts.push(chainRidge(neck, accentC, [], 1, 4, 1,
    (t) => s * (0.075 + 0.035 * Math.sin(Math.PI * t)), 0.42, 0.34, 4));

  // ----- Head --------------------------------------------------------------
  const headYaw = pose.headYaw ?? 0;
  const headBase = neck.pts[neck.pts.length - 1];
  const hy = headBase[1], hz = headBase[2];
  const headRots: Rot[] = headYaw !== 0 ? [twistY(headYaw, 0, hz)] : [];

  // Cranium: broad at the back, tapering into the snout. A rounded form gets
  // a shading gradient across it; the flat faces of the old beveled box each
  // shaded to a single value and went black facing away from the sun.
  const crW = s * 0.086, crH = s * 0.082, crD = s * 0.125;
  const crY = hy + s * 0.010, crZ = hz - s * 0.045;
  parts.push(makeBoxSpherePart(bodyC, headRots,
    -crW, crY - crH, crZ - crD, crW, crY + crH, crZ + crD, 1, 7, 5, MAT.SCALE));

  // Snout: tapered, and set at the pinned breath-ray tip (see the header).
  const snoutTip: Vec3 = [0, crY - s * 0.052, -s * 1.27];
  parts.push(bonePart(bodyC, headRots,
    [0, crY + s * 0.004, crZ - crD * 0.55], snoutTip,
    s * 0.070, s * 0.034, 6, MAT.SCALE));

  // Lower jaw, hinged at the back of the skull. Negative pitch drops the tip.
  const hingeY = crY - s * 0.048, hingeZ = crZ + crD * 0.30;
  const jawPitch = 0.09 + (pose.jawOpen ?? 0) * 0.52;
  const jawRots: Rot[] = [pitch(-jawPitch, hingeY, hingeZ), ...headRots];
  parts.push(bonePart(bellyC, jawRots,
    [0, hingeY, hingeZ], [0, snoutTip[1] - s * 0.016, snoutTip[2] + s * 0.045],
    s * 0.056, s * 0.026, 5, MAT.SCALE));

  // Brow ridges + eyes. The brow is what makes a reptile look like it means
  // it; the eye is what makes it a face at all.
  for (const side of [-1, 1] as const) {
    const ex = side * crW * 0.74;
    const ez = crZ - crD * 0.42;
    parts.push(makeBoxSpherePart(accentC, headRots,
      ex - s * 0.032, crY + s * 0.026, ez - s * 0.052,
      ex + s * 0.032, crY + s * 0.060, ez + s * 0.052, 0.8, 5, 3, MAT.SCALE));
    parts.push(makeBoxSpherePart(eyeC, headRots,
      ex - s * 0.019, crY + s * 0.004, ez - s * 0.024,
      ex + s * 0.023, crY + s * 0.030, ez + s * 0.024, 1, 5, 3, eyeMat));
  }

  // Two horn pairs off the skull rear, swept back and out — and a pair of
  // cheek spikes low on the jaw line.
  const hornBaseY = crY + crH * 0.62, hornBaseZ = crZ + crD * 0.42;
  for (const side of [-1, 1] as const) {
    parts.push(spikePart(accentC, headRots,
      [side * crW * 0.68, hornBaseY, hornBaseZ],
      [side * 0.42, 0.62, 0.66], s * 0.036, s * 0.40, 6));
    parts.push(spikePart(accentC, headRots,
      [side * crW * 0.86, hornBaseY - s * 0.034, hornBaseZ - s * 0.010],
      [side * 0.78, 0.20, 0.59], s * 0.026, s * 0.23, 5));
    parts.push(spikePart(accentC, headRots,
      [side * crW * 0.70, crY - s * 0.048, crZ + crD * 0.10],
      [side * 0.70, -0.35, 0.62], s * 0.020, s * 0.13, 4));
  }

  // Teeth: two fangs a side on the upper jaw, angled down and slightly out.
  const fangs: { base: Vec3; dir: Vec3; r: number; len: number }[] = [];
  for (const side of [-1, 1] as const) {
    for (const [f, sc] of [[0.30, 1.0], [0.62, 0.72]] as const) {
      const p = mix(crZ - crD * 0.55, snoutTip[2], f);
      const w = mix(s * 0.062, s * 0.030, f);
      fangs.push({
        base: [side * w * 0.8, mix(crY, snoutTip[1], f) - w * 0.55, p],
        dir: [side * 0.16, -1, -0.10], r: s * 0.013 * sc, len: s * 0.075 * sc,
      });
    }
  }
  parts.push(ridgePart(accentC, headRots, fangs, 3));

  // ----- Wings -------------------------------------------------------------
  // Seen from above a dragon reads almost entirely by its wing planform: the
  // wings are the silhouette and the body is a thin line down the middle. The
  // spars therefore carry the length and the membrane carries the area, with
  // the leading spar longest and each successive one raked further back.
  const wing: WingSpec = {
    shoulder: [bodyW * 0.86, torsoTopAt(bodyW * 0.55, -bodyL * 0.40) - bodyH * 0.12,
      -bodyL * 0.40],
    hipAnchor: [bodyW * 0.62, hipY + bodyH * 0.24 + bob, bodyL * 0.52],
    humerusLen: s * 0.40,
    forearmLen: s * 0.46,
    fingerLen: [s * 1.20, s * 1.13, s * 0.97, s * 0.76],
    fingerSweep: [[-1.90, 0.14], [-1.98, -0.26], [-2.06, -0.66], [-2.14, -1.06]],
    fingerEl: [[0.16, 0.05], [0.10, 0.01], [0.04, -0.04], [-0.02, -0.09]],
    humerus: { el: [0.62, 0.24], sw: [-1.30, -0.18] },
    forearm: { el: [-0.50, 0.06], sw: [-2.15, 0.14] },
    radii: [s * 0.072, s * 0.052, s * 0.038, s * 0.025, s * 0.009],
    foldSpar: 0.40,
    camber: 0.10,
    scallop: 0.17,
  };
  for (const side of [-1, 1] as const) {
    parts.push(...buildWing(side, wing,
      { bone: bodyC, membrane: membraneC, claw: accentC }, spread, beat));
  }

  // ----- Tail: Bezier arc with a travelling lateral wave --------------------
  const tailRootY = hipY + bodyH * 0.52 + bob;
  const tail = sampleChain(
    [0, tailRootY, rearZAt(tailRootY) * 0.94],
    [0, tailRootY - s * 0.05, bodyL + s * 0.38],
    [0, hipY * 0.55, bodyL + s * 0.78],
    [0, hipY * 0.26, bodyL + s * 1.28],
    5, s * 0.104, s * 0.020,
    s * 0.10 * walkAmp, pose.walkPhase, 0.75);
  parts.push(...chainBones(tail, bodyC, [], [5, 5, 4, 4, 4], MAT.SCALE));
  parts.push(chainRidge(tail, accentC, [], 1, 4, 1,
    (t) => s * 0.085 * (1 - t * 0.5), 0.46, 0.30, 4));
  parts.push(tailFinPart(accentC, [], tail, 0.62, s * 0.19));

  // ----- Back ridge: the spine line continues nose to tail-tip -------------
  // Seated on the real hide surface at each z, not on the bounding-box lid —
  // a plate anchored to `bodyTop` hovers over the back with daylight under it.
  const backSpikes: { base: Vec3; dir: Vec3; r: number; len: number }[] = [];
  for (const f of [-0.62, -0.30, 0.04, 0.38, 0.70]) {
    const bz = bodyL * f;
    backSpikes.push({
      base: [0, torsoTopAt(0, bz) - s * 0.010, bz],
      dir: norm([0, 1, 0.32]),
      r: s * 0.030,
      len: s * (0.150 - 0.045 * f),
    });
  }
  parts.push(ridgePart(accentC, [], backSpikes, 4));

  // Per-species additions — barding, a saddle, a crest. Called last so it can
  // see everything: the solved neck and tail chains, the real hide surface,
  // and the head chain to hang horns off. See `DragonStyle.extras`.
  if (style?.extras !== undefined) {
    parts.push(...style.extras({
      s, bob, hipY, bodyH, bodyW, bodyL, bodyTop,
      torsoTopAt, rearZAt, headRots,
      craniumC: [0, crY, crZ], craniumR: [crW, crH, crD],
      neck, tail, spread, beat,
    }));
  }

  return parts;
}

/**
 * Anchor points a test (or a future saddle/effect) can check without
 * re-deriving the proportions. Kept beside the builder so the two cannot
 * drift apart.
 */
export function dragonLandmarks(species: Species = 'dragon'): {
  hipY: number; bodyTop: number; snoutTip: Vec3; saddleTarget: number;
} {
  const s = SPECIES_DEFS[species].size;
  return {
    hipY: s * HIP,
    bodyTop: s * (HIP + BODY_H),
    snoutTip: [0, s * 1.615 - s * 0.052, -s * 1.27],
    saddleTarget: s,
  };
}
