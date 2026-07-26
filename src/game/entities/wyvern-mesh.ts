/**
 * wyvern-mesh.ts — the wyvern body plan.
 *
 * A wyvern is NOT a small dragon, and building it as one would waste the
 * species. The whole point of the animal is a different skeleton:
 *
 *  - **Two limbs on the ground, not four.** The wings ARE the forelimbs, the
 *    way a bat's or a bird's are, so there is no front leg to draw. It walks
 *    bipedally with the wing knuckles carried high and folded over the back.
 *  - **Balanced about the hip.** With no forelimbs the animal is a lever: the
 *    body is held roughly horizontal, the head reaches forward, and a long
 *    tail streams back as the counterweight. That horizontal, tail-heavy line
 *    is the wyvern silhouette, and it is the opposite of the dragon's
 *    high-necked, four-square stance.
 *  - **Lighter wing loading.** Smaller body, proportionally longer spars,
 *    deeper scalloping — it reads as the flier that is actually good at
 *    flying, while the dragon reads as the one that is mostly a monster.
 *  - **Barbed tail.** The tip carries a keratin arrowhead rather than the
 *    dragon's vertical fin.
 *
 * Colour identity is deliberately cold: a steel/ice blue with a pale frosted
 * belly and near-white spines, against the dragon's dark crimson and
 * near-black horn.
 *
 * Conventions are the shared ones: local space with the base at y = 0, facing
 * -Z at yaw 0, vertices interleaved position+normal per part.
 */

import { SPECIES_DEFS, type Species } from './entity-types';
import { MAT } from '../render/material-table';
import {
  footTarget, makeLegPlan, maxStride, solveLeg, strideLength,
  type LegPlan,
} from '../anim/gait';
import {
  applyVariant, makeBoxSpherePart,
  pitch, twistY,
  ACCENT_COLORS, BASE_COLORS, BELLY_COLORS,
  type AnimalPose, type Color3, type Part, type Rot,
} from './creature-parts';
import {
  bonePart, buildWing, chainBones, chainRidge, mix, norm,
  ridgePart, sampleChain, spikePart,
  type Vec3, type WingSpec,
} from './draconic-parts';

// ---------------------------------------------------------------------------
// Locomotion
// ---------------------------------------------------------------------------

/**
 * Duty factor for the two-legged stride.
 *
 * Same arithmetic that constrains the dragon: the AI advances `walkPhase` by
 * `animalStride('wyvern')` = size * 1.25 = 3.0 m per cycle, a planted foot
 * must sweep `stride * duty` backward through stance, and the limb can only
 * reach so far. 0.42 sits just inside what the leg below can cover, and for a
 * 7 m/s biped a short suspension phase is correct anyway — this is an animal
 * built like a running bird.
 */
const WYVERN_DUTY = 0.42;
const WYVERN_LIFT = 0.19;

const HIP = 0.62;      // hip height as a fraction of size
const BODY_H = 0.40;   // torso depth
const BODY_W = 0.27;   // torso half-width — leaner than the dragon's 0.30
const BODY_L = 0.56;   // torso half-length

/** Memoized per size — see dragonRig for why the key matters. */
const RIG_CACHE = new Map<number, LegPlan>();
function wyvernLeg(s: number): LegPlan {
  const cached = RIG_CACHE.get(s);
  if (cached !== undefined) return cached;
  const rootY = s * HIP;
  // Digitigrade and bird-like: a long metatarsus (`cannon`) with the hock set
  // well back is the whole read of a two-legged runner's leg, and it is what
  // separates this from a dragon's hind limb at a glance.
  const plan = makeLegPlan(rootY, s * BODY_L * 0.10, rootY * 0.38, 0.55, +1, 0.48, 1.34);
  RIG_CACHE.set(s, plan);
  return plan;
}

/** Longest stride the leg covers without the IK clamping (test hook). */
export function wyvernMaxStride(species: Species = 'wyvern'): number {
  return maxStride(wyvernLeg(SPECIES_DEFS[species].size), WYVERN_DUTY);
}

/** The stride the mesh solves against — must match `animalStride`. */
export function wyvernStride(species: Species = 'wyvern'): number {
  return strideLength(SPECIES_DEFS[species].size);
}

// ---------------------------------------------------------------------------
// Body plan
// ---------------------------------------------------------------------------

export function buildWyvern(species: Species, pose: AnimalPose, variant: number): Part[] {
  const s = SPECIES_DEFS[species].size; // 2.4 for wyvern
  const bodyC = applyVariant(BASE_COLORS[species], variant);   // steel blue
  const bellyC = BELLY_COLORS[species];                        // pale frost
  const accentC = ACCENT_COLORS[species];                      // near-white ice horn

  // Membrane: the body colour thinned and cooled, the way stretched hide
  // reads against the sky.
  const membraneC: Color3 = [
    Math.min(1, bodyC[0] * 0.72 + 0.06),
    Math.min(1, bodyC[1] * 0.74 + 0.06),
    Math.min(1, bodyC[2] * 0.82 + 0.06),
  ];
  // Pale ice eye — light on a mid-blue body, so it still resolves at range.
  const eyeC: Color3 = [0.78, 0.95, 1.0];

  const hipY = s * HIP;
  const bodyH = s * BODY_H;
  const bodyW = s * BODY_W;
  const bodyL = s * BODY_L;
  const bodyTop = hipY + bodyH;

  const walkAmp = pose.walkAmp;
  const flapPhase = pose.flapPhase ?? pose.walkPhase;
  const flapAmp = pose.flapAmp ?? pose.walkAmp;
  // Wings furl at rest and open when the animal moves — see buildDragon's
  // note on why the flap amplitude is the only signal available here.
  const spread = Math.max(0, Math.min(1, (flapAmp - 0.36) / 0.58));
  const beat = Math.sin(flapPhase) * flapAmp;

  // A biped's mass rises and falls once per FOOTFALL, so twice per cycle,
  // like a quadruped's — but the amplitude is larger because there is no
  // second pair of limbs sharing the load. Non-positive so the limb root only
  // ever moves toward the foot and never eats into the reach margin.
  const bob = walkAmp > 0
    ? (Math.cos(pose.walkPhase * 2) * 0.5 - 0.5) * s * 0.040 * walkAmp
    : 0;

  const parts: Part[] = [];

  // ----- Torso: a horizontal theropod trunk --------------------------------
  // The pelvis rides higher than the chest and the whole trunk is pitched
  // slightly nose-down — that is the balance line of an animal carrying its
  // weight over one pair of legs.
  const chest = {
    cz: -bodyL * 0.34, rz: bodyL * 0.68,
    cy: bodyTop - bodyH * 0.56 + bob, ry: bodyH * 0.56,
    rx: bodyW * 1.06,
  };
  const pelvis = {
    cz: bodyL * 0.44, rz: bodyL * 0.60,
    cy: bodyTop - bodyH * 0.40 + bob, ry: bodyH * 0.48,
    rx: bodyW * 0.90,
  };
  type Mass = typeof chest;
  const topOf = (e: Mass, x: number, z: number): number => {
    const u = x / e.rx, v = (z - e.cz) / e.rz;
    return e.cy + e.ry * Math.sqrt(Math.max(0, 1 - Math.min(1, u * u + v * v)));
  };
  const torsoTopAt = (x: number, z: number): number =>
    Math.max(topOf(chest, x, z), topOf(pelvis, x, z));
  const rearZAt = (y: number): number => {
    const t = (y - pelvis.cy) / pelvis.ry;
    return pelvis.cz + pelvis.rz * Math.sqrt(Math.max(0, 1 - Math.min(1, t * t)));
  };

  parts.push(makeBoxSpherePart(bodyC, [],
    -chest.rx, chest.cy - chest.ry, chest.cz - chest.rz,
    chest.rx, chest.cy + chest.ry, chest.cz + chest.rz, 1, 8, 5, MAT.SCALE));
  parts.push(makeBoxSpherePart(bodyC, [],
    -pelvis.rx, pelvis.cy - pelvis.ry, pelvis.cz - pelvis.rz,
    pelvis.rx, pelvis.cy + pelvis.ry, pelvis.cz + pelvis.rz, 1, 7, 5, MAT.SCALE));
  // Keel: the flight-muscle anchor, and the pale scute underside.
  parts.push(makeBoxSpherePart(bellyC, [],
    -bodyW * 0.62, chest.cy - bodyH * 0.66 + bob, -bodyL * 0.86,
    bodyW * 0.62, chest.cy + bodyH * 0.18 + bob, bodyL * 0.30, 1, 6, 3, MAT.SCALE));

  // ----- Hind legs: the only limbs on the ground ---------------------------
  const legPlanRest = wyvernLeg(s);
  const stride = Math.min(strideLength(s), wyvernMaxStride(species) * 0.94) * walkAmp;
  const lift = legPlanRest.rootY * WYVERN_LIFT * walkAmp;
  const footRise = -(pose.bodyDrop ?? 0);
  const legGap = bodyW * 0.72;
  const legR = s * 0.055;
  const bury = bodyH * 0.50;

  for (const [lx, phaseOff] of [[-legGap, 0], [legGap, 0.5]] as const) {
    const plan: LegPlan = { ...legPlanRest, rootY: legPlanRest.rootY + bob };
    const foot = footTarget(
      pose.walkPhase + phaseOff * Math.PI * 2, stride, lift, WYVERN_DUTY);
    foot.y += footRise;
    const sol = solveLeg(plan, foot);

    const lz = plan.rootZ;
    const hipRot = pitch(sol.upper, plan.rootY, lz);
    const kneeRot = pitch(sol.lower, sol.kneeY, sol.kneeZ);
    const anklRot = pitch(sol.cannon, sol.ankleY, sol.ankleZ);
    const cannonRots: Rot[] = [anklRot, kneeRot, hipRot];

    const kneeY = plan.rootY - plan.l1;
    const ankleY = kneeY - plan.l2;
    const toeY = ankleY - plan.cannon;

    const bone = (y0: number, y1: number, r0: number, r1: number, rots: Rot[], seg: number) =>
      parts.push(bonePart(bodyC, rots, [lx, y0, lz], [lx, y1, lz], r0, r1, seg, MAT.SCALE));

    // Thigh is heavy (all the propulsion is here), shank and metatarsus fine.
    bone(kneeY, plan.rootY + bury, legR * 1.00, legR * 1.75, [hipRot], 5);
    bone(ankleY, kneeY, legR * 0.72, legR * 1.00, [kneeRot, hipRot], 5);
    const absCan = sol.upper + sol.lower + sol.cannon;
    bone(toeY + legR * 0.55 / Math.max(0.5, Math.cos(absCan)), ankleY,
      legR * 0.55, legR * 0.72, cannonRots, 4);

    // Foot: three forward talons and a small hallux, built UP from the solved
    // contact point and flattened against the ground by cancelling the
    // chain's accumulated rotation.
    const footFlat = pitch(-absCan, toeY, lz);
    const footRots: Rot[] = [footFlat, ...cannonRots];
    const pr = legR * 1.15;
    parts.push(makeBoxSpherePart(bodyC, footRots,
      lx - pr, toeY, lz - pr * 1.4,
      lx + pr, toeY + pr * 0.9, lz + pr * 1.0, 1, 5, 3, MAT.SCALE));
    const talons: { base: Vec3; dir: Vec3; r: number; len: number }[] = [];
    // Raised off the sole and angled shallow on purpose. A talon based at
    // 0.34 of the pad height and raked 0.28 down puts its tip 1.3 cm BELOW
    // the solved contact point — i.e. permanently under the turf — and that
    // reads as a mesh fault, not as a claw.
    for (const cx of [-0.8, 0, 0.8]) {
      talons.push({
        base: [lx + cx * pr, toeY + pr * 0.52, lz - pr * 1.25],
        dir: [cx * 0.5, -0.22, -1], r: legR * 0.26, len: s * 0.09,
      });
    }
    talons.push({
      base: [lx, toeY + pr * 0.34, lz + pr * 0.85],
      dir: [0, -0.30, 1], r: legR * 0.22, len: s * 0.065,
    });
    parts.push(ridgePart(accentC, footRots, talons, 3));
  }

  // Haunches — the drumstick mass over the hip. On a biped this is the
  // largest muscle on the animal and it has to look it.
  for (const side of [-1, 1] as const) {
    const hr = Math.min(bodyW * 0.86, bodyH * 0.62);
    parts.push(makeBoxSpherePart(bodyC, [],
      side * legGap * 0.58 - hr, hipY - s * 0.04 + bob, legPlanRest.rootZ - hr * 1.05,
      side * legGap * 0.58 + hr, hipY + hr * 1.50 + bob, legPlanRest.rootZ + hr * 1.25,
      0.9, 5, 4, MAT.SCALE));
  }

  // ----- Neck: a shallower, more forward-reaching S than the dragon's ------
  const headY = s * 1.22 + bob * 0.5;
  const headZ = -s * 0.86;
  const neckRootY = hipY + bodyH * 0.82 + bob;
  const neckRootZ = -bodyL * 0.86;
  const neckDrift = Math.sin(flapPhase * 0.8) * s * 0.018 * flapAmp;
  const neck = sampleChain(
    [0, neckRootY, neckRootZ],
    [0, neckRootY + s * 0.30, neckRootZ + s * 0.04],
    [0, headY + s * 0.24 + neckDrift, headZ + s * 0.26],
    [0, headY + neckDrift, headZ],
    4, s * 0.108, s * 0.062,
    s * 0.024 * walkAmp, pose.walkPhase * 0.5, 0.5);
  parts.push(...chainBones(neck, bodyC, [], [5, 5, 4, 4], MAT.SCALE));
  parts.push(chainRidge(neck, accentC, [], 1, 4, 1,
    (t) => s * (0.070 + 0.030 * Math.sin(Math.PI * t)), 0.40, 0.34, 4));

  // ----- Head: narrow and raptorial ---------------------------------------
  const headYaw = pose.headYaw ?? 0;
  const headBase = neck.pts[neck.pts.length - 1];
  const hy = headBase[1], hz = headBase[2];
  const headRots: Rot[] = headYaw !== 0 ? [twistY(headYaw, 0, hz)] : [];

  const crW = s * 0.092, crH = s * 0.086, crD = s * 0.126;
  const crY = hy + s * 0.008, crZ = hz - s * 0.040;
  parts.push(makeBoxSpherePart(bodyC, headRots,
    -crW, crY - crH, crZ - crD, crW, crY + crH, crZ + crD, 1, 6, 4, MAT.SCALE));

  const snoutTip: Vec3 = [0, crY - s * 0.052, -s * 1.16];
  parts.push(bonePart(bodyC, headRots,
    [0, crY + s * 0.004, crZ - crD * 0.55], snoutTip,
    s * 0.074, s * 0.032, 5, MAT.SCALE));

  const hingeY = crY - s * 0.044, hingeZ = crZ + crD * 0.28;
  const jawPitch = 0.08 + (pose.jawOpen ?? 0) * 0.50;
  const jawRots: Rot[] = [pitch(-jawPitch, hingeY, hingeZ), ...headRots];
  parts.push(bonePart(bellyC, jawRots,
    [0, hingeY, hingeZ], [0, snoutTip[1] - s * 0.016, snoutTip[2] + s * 0.044],
    s * 0.058, s * 0.024, 4, MAT.SCALE));

  for (const side of [-1, 1] as const) {
    const ex = side * crW * 0.76;
    const ez = crZ - crD * 0.40;
    parts.push(makeBoxSpherePart(accentC, headRots,
      ex - s * 0.028, crY + s * 0.024, ez - s * 0.046,
      ex + s * 0.028, crY + s * 0.054, ez + s * 0.046, 0.8, 5, 3, MAT.SCALE));
    parts.push(makeBoxSpherePart(eyeC, headRots,
      ex - s * 0.017, crY + s * 0.002, ez - s * 0.022,
      ex + s * 0.021, crY + s * 0.028, ez + s * 0.022, 1, 5, 3, MAT.HORN));
  }

  // Crest: one long backswept pair plus a short pair — a swept crown rather
  // than the dragon's twin bull horns, so the two silhouettes never confuse.
  const hornBaseY = crY + crH * 0.58, hornBaseZ = crZ + crD * 0.40;
  for (const side of [-1, 1] as const) {
    parts.push(spikePart(accentC, headRots,
      [side * crW * 0.62, hornBaseY, hornBaseZ],
      [side * 0.30, 0.44, 0.85], s * 0.030, s * 0.46, 5));
    parts.push(spikePart(accentC, headRots,
      [side * crW * 0.82, hornBaseY - s * 0.032, hornBaseZ - s * 0.014],
      [side * 0.72, 0.10, 0.68], s * 0.020, s * 0.20, 4));
  }

  const fangs: { base: Vec3; dir: Vec3; r: number; len: number }[] = [];
  for (const side of [-1, 1] as const) {
    for (const [f, sc] of [[0.28, 1.0], [0.60, 0.70]] as const) {
      const p = mix(crZ - crD * 0.55, snoutTip[2], f);
      const w = mix(s * 0.052, s * 0.024, f);
      fangs.push({
        base: [side * w * 0.8, mix(crY, snoutTip[1], f) - w * 0.55, p],
        dir: [side * 0.16, -1, -0.10], r: s * 0.012 * sc, len: s * 0.070 * sc,
      });
    }
  }
  parts.push(ridgePart(accentC, headRots, fangs, 3));

  // ----- Wings: these are the forelimbs ------------------------------------
  // Rooted at a true shoulder joint on the front of the chest rather than
  // high on the back, because that is where an ARM attaches; and given longer
  // spars against a smaller body than the dragon's, which is what a lighter,
  // higher-aspect flier looks like.
  const wing: WingSpec = {
    shoulder: [bodyW * 0.90, torsoTopAt(bodyW * 0.55, -bodyL * 0.46) - bodyH * 0.16,
      -bodyL * 0.46],
    hipAnchor: [bodyW * 0.60, hipY + bodyH * 0.22 + bob, bodyL * 0.46],
    humerusLen: s * 0.44,
    forearmLen: s * 0.52,
    fingerLen: [s * 1.42, s * 1.32, s * 1.10, s * 0.84],
    fingerSweep: [[-1.86, 0.16], [-1.94, -0.24], [-2.02, -0.66], [-2.10, -1.08]],
    fingerEl: [[0.22, 0.06], [0.16, 0.02], [0.10, -0.03], [0.04, -0.08]],
    // Folded, the elbow rides high and well back and the wrist tucks in over
    // the shoulder — a bird's carpal hump, which is exactly the shape a
    // grounded wyvern is drawn with.
    humerus: { el: [0.70, 0.26], sw: [-1.24, -0.20] },
    forearm: { el: [-0.42, 0.05], sw: [-2.10, 0.16] },
    radii: [s * 0.066, s * 0.048, s * 0.034, s * 0.022, s * 0.008],
    foldSpar: 0.38,
    camber: 0.11,
    scallop: 0.20,
  };
  for (const side of [-1, 1] as const) {
    parts.push(...buildWing(side, wing,
      { bone: bodyC, membrane: membraneC, claw: accentC }, spread, beat));
  }

  // ----- Tail: the counterweight -------------------------------------------
  // Longer relative to the body than the dragon's and carried out level
  // before it falls away, because on a biped the tail is not decoration —
  // it is the other half of the lever the animal balances on.
  const tailRootY = hipY + bodyH * 0.60 + bob;
  const tail = sampleChain(
    [0, tailRootY, rearZAt(tailRootY) * 0.95],
    [0, tailRootY + s * 0.06, bodyL + s * 0.52],
    [0, tailRootY - s * 0.14, bodyL + s * 1.14],
    [0, hipY * 0.62, bodyL + s * 1.78],
    5, s * 0.112, s * 0.026,
    s * 0.11 * walkAmp, pose.walkPhase, 0.75);
  parts.push(...chainBones(tail, bodyC, [], [5, 5, 4, 4, 4], MAT.SCALE));
  parts.push(chainRidge(tail, accentC, [], 1, 4, 1,
    (t) => s * 0.075 * (1 - t * 0.45), 0.44, 0.30, 4));

  // Barb: an arrowhead of three spikes at the very tip — the wyvern's sting,
  // and the fastest way to tell the two species apart from behind.
  {
    const tip = tail.pts[tail.pts.length - 1];
    const tg = tail.tangents[tail.tangents.length - 1];
    const up = tail.ups[tail.ups.length - 1];
    const side: Vec3 = norm([
      tg[1] * up[2] - tg[2] * up[1],
      tg[2] * up[0] - tg[0] * up[2],
      tg[0] * up[1] - tg[1] * up[0],
    ]);
    const barbs: { base: Vec3; dir: Vec3; r: number; len: number }[] = [
      { base: tip, dir: tg, r: s * 0.028, len: s * 0.26 },
      { base: tip, dir: norm([tg[0] + side[0] * 1.5, tg[1] + side[1] * 1.5 + 0.2, tg[2] + side[2] * 1.5]), r: s * 0.020, len: s * 0.17 },
      { base: tip, dir: norm([tg[0] - side[0] * 1.5, tg[1] - side[1] * 1.5 + 0.2, tg[2] - side[2] * 1.5]), r: s * 0.020, len: s * 0.17 },
    ];
    parts.push(ridgePart(accentC, [], barbs, 4));
  }

  // ----- Back ridge --------------------------------------------------------
  const backSpikes: { base: Vec3; dir: Vec3; r: number; len: number }[] = [];
  for (const f of [-0.56, -0.18, 0.22, 0.60]) {
    const bz = bodyL * f;
    backSpikes.push({
      base: [0, torsoTopAt(0, bz) - s * 0.010, bz],
      dir: norm([0, 1, 0.34]),
      r: s * 0.026,
      len: s * (0.130 - 0.040 * f),
    });
  }
  parts.push(ridgePart(accentC, [], backSpikes, 4));

  return parts;
}
