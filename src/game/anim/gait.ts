/**
 * gait.ts — planted-foot locomotion for legged body plans.
 *
 * WHY THIS EXISTS
 *
 * Every legged creature in the game used to animate the same way: one rigid
 * capsule per leg, pitched about the hip by `sin(walkPhase)`. That produces two
 * defects the eye reads instantly as "fake", and they are the whole of the
 * "extremely derpy especially when they move" complaint:
 *
 *   1. **No knee.** A real leg is a folding linkage. A straight rod swinging
 *      from the hip is a pendulum, and a herd of pendulums reads as furniture
 *      being dragged around.
 *   2. **Skating.** The foot swept through a sine arc with no relationship to
 *      the ground, so it slid backward, forward and *through* the terrain while
 *      the body translated independently. Contact is what sells weight.
 *
 * The fix is to invert the problem. Instead of choosing joint angles and
 * letting the foot land wherever it lands, choose where the **foot** goes —
 * planted and still during stance, arcing forward during swing — and solve the
 * joints to match. That is two-bone IK, which for a planar limb has a closed
 * form (law of cosines) and costs a couple of `acos` calls per leg.
 *
 * ANATOMY (this is why front and rear legs differ)
 *
 * Seen from the side, a quadruped's fore and hind limbs bend in *opposite*
 * directions, and getting this backwards is the single most common tell of a
 * programmer-authored quadruped:
 *
 *   - **Foreleg:** shoulder → carpus ("knee") → cannon → foot. The carpus
 *     breaks BACKWARD. The limb is close to straight.
 *   - **Hind leg:** hip → stifle → hock → metatarsus → foot. The stifle sits
 *     FORWARD (up near the belly) and the hock sits BACK and high, giving the
 *     characteristic Z zig-zag.
 *
 * Both are modelled here as upper + lower + cannon, where the ankle (carpus /
 * hock) is placed above and *behind* the foot by `ankleSet`, and `bend` chooses
 * which way the middle joint breaks. A near-zero `ankleSet` with a backward
 * bend gives a foreleg; a large `ankleSet` with a forward bend gives the hind
 * leg's zig-zag out of the same four lines of code.
 *
 * COORDINATE CONVENTIONS (match animal-mesh.ts exactly)
 *
 *   - Local space: feet at y = 0, +Y up, **-Z is forward** (yaw 0 faces -Z).
 *   - `pitch(a, pivotY, pivotZ)` rotates about X such that a POSITIVE angle
 *     swings a downward-pointing limb's tip toward -Z, i.e. forward.
 *   - Rotation chains are authored **child first, then parent** (see
 *     `assembleParts`), so a cannon reads
 *     `[pitch(cannon, ankle…), pitch(lower, knee…), pitch(upper, hip…)]`
 *     and every pivot is expressed in UNPOSED rest space.
 *
 * Pure module: no DOM, no GPU, no allocation beyond the small result objects.
 * Node-testable.
 */

// ---------------------------------------------------------------------------
// Stride scaling
// ---------------------------------------------------------------------------

/**
 * Distance covered per complete gait cycle, expressed in shoulder heights.
 *
 * A walking horse (~1.5 m at the shoulder) covers roughly 1.7 m between
 * successive plants of the same hoof, so ~1.15 body heights; a brisk amble is
 * a little more. 1.25 sits in that range and holds up across the size range we
 * actually ship (0.3 m rabbit → 3.5 m dragon).
 */
export const STRIDE_PER_HEIGHT = 1.25;

/** Ground distance covered by one full gait cycle for a creature of `size`. */
export function strideLength(size: number): number {
  return Math.max(0.25, size * STRIDE_PER_HEIGHT);
}

/**
 * Radians of `walkPhase` per metre travelled, so exactly one cycle elapses per
 * stride and planted feet therefore do not skate.
 *
 * This replaces a hardcoded 1.6 rad/m that applied to every species alike —
 * which meant a rabbit and a dragon took the same length step. At 1.6 a rabbit
 * completed one cycle every 3.9 m, roughly ten strides' worth of ground per
 * step, so its legs barely twitched while it slid across the map.
 */
export function phasePerMetre(size: number): number {
  return (Math.PI * 2) / strideLength(size);
}

// ---------------------------------------------------------------------------
// Gait patterns
// ---------------------------------------------------------------------------

export interface GaitPattern {
  /** Cycle fraction each foot spends planted. >0.5 guarantees no airborne phase. */
  duty: number;
  /** Phase offsets in cycles for [frontLeft, frontRight, backLeft, backRight]. */
  offsets: readonly [number, number, number, number];
  /** Peak foot lift during swing, as a fraction of limb length. */
  lift: number;
}

/**
 * Diagonal amble — the default. Diagonal pairs (FL+BR, FR+BL) move together,
 * which is what the old hardcoded `legPF`/`legPB` pairing already implied, and
 * a duty over 0.5 keeps at least one diagonal planted at all times so the body
 * never visibly falls between steps.
 */
export const GAIT_AMBLE: GaitPattern = {
  duty: 0.62,
  offsets: [0, 0.5, 0.5, 0],
  lift: 0.26,
};

/**
 * Bound — both forelegs together, both hind legs together, with a long
 * airborne phase. This IS the rabbit silhouette in motion; ambling a rabbit
 * looks like a cat with the wrong proportions.
 */
export const GAIT_BOUND: GaitPattern = {
  duty: 0.34,
  offsets: [0, 0, 0.34, 0.34],
  lift: 0.55,
};

/**
 * Lateral-sequence walk — same-side legs follow each other (LH, LF, RH, RF).
 * Heavy, deliberate; suits bears, cows and grounded dragons, where a diagonal
 * amble reads as too light for the mass.
 */
export const GAIT_WALK: GaitPattern = {
  duty: 0.72,
  offsets: [0.25, 0.75, 0, 0.5],
  lift: 0.18,
};

// ---------------------------------------------------------------------------
// Foot trajectory
// ---------------------------------------------------------------------------

export interface FootPlant {
  /** Longitudinal offset from the limb root; negative = forward. */
  z: number;
  /** Height above ground. */
  y: number;
  /** 1 while carrying load, 0 while swinging. */
  planted: number;
}

/**
 * Where a foot should be, given its own phase.
 *
 * The stance excursion is `stride * duty`, NOT `stride`, and that distinction
 * is the entire point of the module. "Planted" means stationary in WORLD
 * space; the mesh is authored in body space, so the foot's local position must
 * travel backward at exactly the body's speed. Over one cycle the body covers
 * `stride`, but the foot is only on the ground for `duty` of that cycle, so it
 * sweeps `stride * duty` of ground and the swing returns it over the rest.
 *
 * Sweeping a full `stride` instead — the obvious-looking choice — leaves the
 * foot creeping forward through every stance at `(1 - duty)` of body speed.
 * That is skating, wearing a planted foot's clothes, and it is invisible in
 * any still frame.
 *
 * Swing eases out and in (smoothstep) so the leg does not snap, and lifts on a
 * skewed sine so the foot breaks over quickly and sets down gently rather than
 * describing a symmetric hop.
 */
export function footTarget(
  phase: number,
  stride: number,
  lift: number,
  duty: number,
): FootPlant {
  let u = (phase / (Math.PI * 2)) % 1;
  if (u < 0) u += 1;
  const sweep = stride * duty; // ground covered while this foot is down
  const half = sweep * 0.5;

  if (u < duty) {
    // Stance: local position travels backward at exactly body speed, so the
    // foot holds still in the world.
    return { z: -half + u * stride, y: 0, planted: 1 };
  }

  // Swing: recover forward through the air.
  const t = duty < 1 ? (u - duty) / (1 - duty) : 0;
  const ease = t * t * (3 - 2 * t);
  return {
    z: half - ease * sweep,
    y: Math.sin(Math.PI * Math.pow(t, 0.85)) * lift,
    planted: 0,
  };
}

// ---------------------------------------------------------------------------
// Two-bone IK
// ---------------------------------------------------------------------------

export interface TwoBone {
  /** Pitch of the upper bone about the root joint. */
  upper: number;
  /** Pitch of the lower bone about the mid joint, RELATIVE to the upper. */
  lower: number;
  /** Mid-joint position in unposed rest space (root, straight down by l1). */
  jointY: number;
  jointZ: number;
}

const clamp1 = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);

/**
 * Closed-form planar two-bone IK.
 *
 * Solves the triangle root–joint–target with the law of cosines. `bendSign`
 * picks which of the two mirror solutions to take: +1 puts the mid joint
 * forward of the root→target line, -1 puts it behind.
 *
 * The target is clamped into the reachable annulus, so an over-reaching target
 * produces a straight (not broken) limb rather than NaN.
 */
export function solveTwoBone(
  rootY: number, rootZ: number,
  l1: number, l2: number,
  targetY: number, targetZ: number,
  bendSign: number,
): TwoBone {
  const dz = targetZ - rootZ;
  const dy = rootY - targetY; // positive when the target is below the root
  // Scale-relative epsilon. `acos` has infinite slope at ±1, so the inset used
  // to keep the triangle non-degenerate reappears square-rooted in the output:
  // an absolute 1e-4 inset leaves ~2° of residual bend in a limb that should be
  // straight, and the amount would drift with creature size. Proportional keeps
  // the straightened pose identical at every scale; `clamp1` below is the
  // actual NaN guard, so this can be small.
  const eps = (l1 + l2) * 1e-9;
  const reachMin = Math.abs(l1 - l2) + eps;
  const reachMax = l1 + l2 - eps;
  const d = Math.min(reachMax, Math.max(reachMin, Math.hypot(dy, dz)));

  // Whole-limb direction. Positive pitch swings the tip toward -Z, hence -dz.
  const theta = Math.atan2(-dz, dy);
  const A = Math.acos(clamp1((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)));
  const B = Math.acos(clamp1((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2)));

  return {
    upper: theta + bendSign * A,
    // Interior angles sum to pi, so the relative bend is -(A + A2) = -(pi - B).
    lower: -bendSign * (Math.PI - B),
    jointY: rootY - l1,
    jointZ: rootZ,
  };
}

// ---------------------------------------------------------------------------
// Full limb
// ---------------------------------------------------------------------------

export interface LegPlan {
  /** Hip / shoulder height above ground. */
  rootY: number;
  /** Longitudinal position of the limb root. */
  rootZ: number;
  /** Upper bone length (shoulder→carpus, or hip→stifle). */
  l1: number;
  /** Lower bone length (carpus→ankle, or stifle→hock). */
  l2: number;
  /** Cannon / metatarsus length (ankle→foot). */
  cannon: number;
  /** How far the ankle sits behind the foot, as a fraction of `cannon`. */
  ankleSet: number;
  /** +1 = mid joint breaks forward (hind stifle); -1 = backward (fore carpus). */
  bend: number;
}

/**
 * Build a limb's fixed bone lengths from its stance.
 *
 * Bone lengths must be computed ONCE, here, and never re-derived from the
 * current target — otherwise the limb telescopes to reach and the creature
 * appears to be made of elastic.
 *
 * `slack` is the ratio of total bone length to the root→ankle gap when
 * standing. Above 1 the limb cannot straighten fully, so a standing animal
 * keeps a slight, live bend; at exactly 1 every joint locks and the creature
 * stands like a table. 1.06 is enough to read without looking crouched.
 */
export function makeLegPlan(
  rootY: number,
  rootZ: number,
  cannon: number,
  ankleSet: number,
  bend: number,
  upperFrac = 0.52,
  slack = 1.06,
): LegPlan {
  const back = cannon * ankleSet;
  const up = Math.sqrt(Math.max(1e-4, cannon * cannon - back * back));
  const restSpan = Math.hypot(rootY - up, back);
  const total = restSpan * slack;
  return {
    rootY, rootZ,
    l1: total * upperFrac,
    l2: total * (1 - upperFrac),
    cannon, ankleSet, bend,
  };
}

/**
 * The longest stride this limb can cover without the IK clamping.
 *
 * This is the constraint that makes planted feet actually work, and it is not
 * optional. Pick a stride independently of the anatomy and the far end of the
 * step falls outside the limb's reachable annulus; the solver clamps, the foot
 * stops where the leg runs out instead of where the gait asked, and the skating
 * this whole module exists to remove comes straight back — now with a hitch in
 * it where the clamp engages.
 *
 * Reachability: with the ankle a vertical drop `R` below the root, a foot
 * offset `h` needs `hypot(R, h + back) <= l1 + l2`, so
 * `h <= sqrt((l1+l2)^2 - R^2) - back`. The foot's furthest excursion is half
 * the stance sweep, and the sweep is `stride * duty` (see `footTarget`) — so
 * the stride the limb can support is `2h / duty`, and a longer duty means a
 * shorter maximum stride for the same anatomy.
 *
 * Note the consequence for proportions: a limb with little slack can barely
 * step at all, because a nearly-straight leg has almost no spare reach. Short,
 * crouched limbs (bear, wolf) need more slack than tall straight ones (deer,
 * horse) to take a stride that looks right — which is exactly how the real
 * animals are built.
 */
export function maxStride(plan: LegPlan, duty: number): number {
  const back = plan.cannon * plan.ankleSet;
  const up = Math.sqrt(Math.max(1e-4, plan.cannon * plan.cannon - back * back));
  const R = plan.rootY - up;
  const total = plan.l1 + plan.l2;
  const span = Math.sqrt(Math.max(0, total * total - R * R));
  const half = Math.max(0, span - Math.abs(back));
  return duty > 0 ? (half * 2) / duty : 0;
}

export interface LegSolve {
  /** Pitch about the hip. */
  upper: number;
  /** Pitch about the knee, relative to the upper bone. */
  lower: number;
  /** Pitch about the ankle, relative to the lower bone. */
  cannon: number;
  /** Knee pivot in rest space. */
  kneeY: number; kneeZ: number;
  /** Ankle pivot in rest space. */
  ankleY: number; ankleZ: number;
  /** 1 while planted, 0 while swinging — drives body support / weight shift. */
  planted: number;
}

/**
 * Solve one limb so its foot lands on `foot` (given relative to the root).
 *
 * The ankle is derived from the foot rather than the other way round: it sits
 * one cannon-length away, set back by `ankleSet`. That single offset is what
 * turns the shared solver into either a foreleg or a hind leg.
 */
export function solveLeg(plan: LegPlan, foot: FootPlant): LegSolve {
  const footZ = plan.rootZ + foot.z;
  const footY = foot.y;

  const back = plan.cannon * plan.ankleSet;
  const up = Math.sqrt(Math.max(1e-4, plan.cannon * plan.cannon - back * back));
  const ankleY = footY + up;
  const ankleZ = footZ + back;

  const ik = solveTwoBone(
    plan.rootY, plan.rootZ, plan.l1, plan.l2, ankleY, ankleZ, plan.bend);

  // Cannon runs ankle→foot. Its chain angle is absolute, so subtract the
  // parents to get the value the rotation chain expects.
  const cannonTotal = Math.atan2(-(footZ - ankleZ), ankleY - footY);

  return {
    upper: ik.upper,
    lower: ik.lower,
    cannon: cannonTotal - ik.upper - ik.lower,
    kneeY: ik.jointY,
    kneeZ: ik.jointZ,
    ankleY: plan.rootY - plan.l1 - plan.l2,
    ankleZ: plan.rootZ,
    planted: foot.planted,
  };
}

/**
 * Vertical body displacement for a gait, in limb-length fractions.
 *
 * A quadruped's centre of mass rises and falls twice per stride as each
 * support pair takes the load; that vertical beat is most of what the eye
 * reads as weight. Derived from the same phase as the feet so it can never
 * drift out of sync with them.
 */
export function bodyBob(phase: number, pattern: GaitPattern): number {
  // Two beats per cycle for paired gaits; bound lands once, so it gets one.
  const beats = pattern === GAIT_BOUND ? 1 : 2;
  return Math.sin(phase * beats + Math.PI * 0.5) * 0.5 - 0.5;
}
