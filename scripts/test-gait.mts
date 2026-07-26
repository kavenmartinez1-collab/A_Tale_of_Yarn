/**
 * Deterministic tests for the gait / two-bone IK solver (src/game/anim/gait.ts).
 * Pure CPU — no GPU, no server.  Run: npx tsx scripts/test-gait.mts
 *
 * The load-bearing test here is the FORWARD-KINEMATICS ROUND TRIP: take the
 * angles the solver returns, push them back through the exact same rotation
 * maths `assembleParts` uses, and confirm the foot lands on the target.
 *
 * That matters because every failure mode of this module is a sign error, and
 * a sign error does not crash, does not fail a hash check and does not look
 * obviously wrong in a still frame — it produces a leg that bends the wrong way
 * or a foot that skates, which costs an afternoon of screenshot hunting to
 * find. Round-tripping the maths catches all of it in milliseconds.
 */

import {
  footTarget,
  makeLegPlan,
  solveLeg,
  solveTwoBone,
  strideLength,
  maxStride,
  phasePerMetre,
  bodyBob,
  GAIT_AMBLE,
  GAIT_BOUND,
  GAIT_WALK,
  type LegPlan,
} from '../src/game/anim/gait';

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

function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

// ---------------------------------------------------------------------------
// Forward kinematics — a faithful copy of assembleParts' pitch maths.
//
// pitch(a, p0=pivotY, p1=pivotZ):
//   y' = p0 + dy*cos - dz*sin
//   z' = p1 + dy*sin + dz*cos
// Rotations apply in array order, i.e. child first then parent.
// ---------------------------------------------------------------------------

interface Pitch { a: number; py: number; pz: number }

function applyChain(y: number, z: number, chain: Pitch[]): [number, number] {
  let cy = y, cz = z;
  for (const r of chain) {
    const s = Math.sin(r.a), c = Math.cos(r.a);
    const dy = cy - r.py;
    const dz = cz - r.pz;
    cy = r.py + dy * c - dz * s;
    cz = r.pz + dy * s + dz * c;
  }
  return [cy, cz];
}

// ---------------------------------------------------------------------------
// 1. Sign convention: positive pitch must swing a hanging limb FORWARD (-Z).
// ---------------------------------------------------------------------------

{
  const [, z] = applyChain(0, 0, [{ a: 0.5, py: 1, pz: 0 }]);
  check('positive pitch swings a hanging tip toward -Z (forward)', z < -0.1,
    `tip z = ${z.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// 2. solveTwoBone reaches its target (round trip through forward kinematics).
// ---------------------------------------------------------------------------

{
  const cases: [number, number, number, number, number, number, number][] = [
    // rootY, rootZ, l1, l2, targetY, targetZ, bend
    [1.0, 0.0, 0.55, 0.55, 0.10, 0.00,  1],
    [1.0, 0.0, 0.55, 0.55, 0.10, 0.00, -1],
    [1.0, 0.0, 0.55, 0.55, 0.05, 0.30,  1],
    [1.0, 0.0, 0.55, 0.55, 0.05, -0.30, -1],
    [1.0, 0.2, 0.60, 0.45, 0.20, -0.25,  1],
    [0.5, -0.3, 0.30, 0.22, 0.08, -0.18, -1],
    [3.0, 0.0, 1.60, 1.30, 0.30, 0.80,  1],
  ];
  let worst = 0;
  for (const [rootY, rootZ, l1, l2, ty, tz, bend] of cases) {
    const r = solveTwoBone(rootY, rootZ, l1, l2, ty, tz, bend);
    // Tip of the lower bone in rest space, pushed through the chain.
    const [fy, fz] = applyChain(
      rootY - l1 - l2, rootZ,
      [{ a: r.lower, py: r.jointY, pz: r.jointZ },
       { a: r.upper, py: rootY,    pz: rootZ }]);
    worst = Math.max(worst, Math.hypot(fy - ty, fz - tz));
  }
  check('solveTwoBone: solved angles place the tip on the target', worst < 1e-9,
    `worst error ${worst.toExponential(2)} m`);
}

// ---------------------------------------------------------------------------
// 3. bendSign actually controls which way the joint breaks.
// ---------------------------------------------------------------------------

{
  const fwd = solveTwoBone(1.0, 0, 0.55, 0.55, 0.10, 0, +1);
  const back = solveTwoBone(1.0, 0, 0.55, 0.55, 0.10, 0, -1);
  const kneeZ = (r: { upper: number; jointY: number; jointZ: number }): number => {
    const [, z] = applyChain(r.jointY, r.jointZ,
      [{ a: r.upper, py: 1.0, pz: 0 }]);
    return z;
  };
  check('bend +1 puts the mid joint forward of the limb line', kneeZ(fwd) < -0.01,
    `knee z = ${kneeZ(fwd).toFixed(4)}`);
  check('bend -1 puts the mid joint behind the limb line', kneeZ(back) > 0.01,
    `knee z = ${kneeZ(back).toFixed(4)}`);
  check('the two solutions mirror about the limb line',
    near(kneeZ(fwd), -kneeZ(back), 1e-9));
}

// ---------------------------------------------------------------------------
// 4. Over-reach clamps to a straight limb instead of producing NaN.
// ---------------------------------------------------------------------------

{
  const r = solveTwoBone(1.0, 0, 0.4, 0.4, 0.0, 5.0, 1);
  check('unreachable target does not produce NaN',
    Number.isFinite(r.upper) && Number.isFinite(r.lower));
  // Not exactly zero: the reach clamp insets by a small epsilon, and acos has
  // infinite slope at ±1 so that inset shows up square-rooted. The relative
  // epsilon keeps the residual under a tenth of a degree at every scale.
  check('unreachable target straightens the limb', Math.abs(r.lower) < 0.002,
    `lower = ${r.lower.toFixed(6)}`);
  const inner = solveTwoBone(1.0, 0, 0.7, 0.2, 1.0, 0.0, 1);
  check('target inside the inner reach limit does not produce NaN',
    Number.isFinite(inner.upper) && Number.isFinite(inner.lower));
}

// ---------------------------------------------------------------------------
// 5. footTarget: stance is planted and moves strictly backward at constant
//    speed; swing recovers forward and lifts.
// ---------------------------------------------------------------------------

{
  const stride = 1.0, lift = 0.2, duty = 0.62;
  const at = (u: number): ReturnType<typeof footTarget> =>
    footTarget(u * Math.PI * 2, stride, lift, duty);
  const half = stride * duty * 0.5;

  // ---------------------------------------------------------------------
  // THE test. Everything else in this file checks the module against its own
  // spec; this one checks it against physics. A planted foot is stationary in
  // WORLD space, so its local position must travel backward at exactly body
  // speed. The first version of this module swept a full stride during stance
  // instead of stride*duty, which left the foot creeping forward at 38% of
  // body speed — invisible in a still frame, and exactly the skating the whole
  // rig exists to remove. Nothing above caught it, because it was written
  // against the same wrong assumption as the code.
  // ---------------------------------------------------------------------
  {
    let drift = 0;
    const ref = at(0).z + 0; // world position at touchdown, body at origin
    for (let i = 0; i <= 100; i++) {
      const u = (i / 100) * duty * 0.99999;
      const f = at(u);
      // Body has advanced u*stride forward (-Z), so world = local - u*stride.
      drift = Math.max(drift, Math.abs((f.z - u * stride) - ref));
    }
    check('PLANTED FOOT IS STATIONARY IN WORLD SPACE (no skating)',
      drift < 1e-9, `world drift ${drift.toExponential(2)} m over one stance`);
  }

  check('stance starts half a stance-sweep forward', near(at(0).z, -half, 1e-9));
  check('stance ends half a stance-sweep behind',
    near(at(duty - 1e-9).z, half, 1e-6));
  check('stance sweep is stride*duty, not stride',
    near(at(duty - 1e-9).z - at(0).z, stride * duty, 1e-6));
  check('stance keeps the foot on the ground', at(0.3).y === 0);
  check('stance reports planted', at(0.3).planted === 1);
  check('swing reports not planted', at(0.8).planted === 0);

  // Constant stance velocity is what makes a planted foot look planted.
  const v1 = at(0.20).z - at(0.10).z;
  const v2 = at(0.50).z - at(0.40).z;
  check('stance slides at constant velocity', near(v1, v2, 1e-9),
    `${v1.toFixed(6)} vs ${v2.toFixed(6)}`);

  // Monotonic backward through stance.
  let mono = true;
  for (let i = 1; i <= 40; i++) {
    const a = at((i - 1) / 40 * duty * 0.999);
    const b = at(i / 40 * duty * 0.999);
    if (b.z < a.z) mono = false;
  }
  check('stance never moves the foot forward', mono);

  // Swing lifts, and comes back down.
  let peak = 0;
  for (let i = 0; i <= 40; i++) {
    peak = Math.max(peak, at(duty + (i / 40) * (1 - duty) * 0.999).y);
  }
  check('swing lifts the foot off the ground', peak > lift * 0.9,
    `peak ${peak.toFixed(3)} of ${lift}`);
  check('swing returns the foot to the ground at touchdown',
    near(at(0.99999).y, 0, 1e-3) && near(at(0.99999).z, -half, 1e-3));
}

// ---------------------------------------------------------------------------
// 6. Cycle continuity — touchdown must meet lift-off, or the foot teleports.
// ---------------------------------------------------------------------------

for (const g of [GAIT_AMBLE, GAIT_BOUND, GAIT_WALK]) {
  const a = footTarget(2 * Math.PI * 0.999999, 1.2, 0.3, g.duty);
  const b = footTarget(0, 1.2, 0.3, g.duty);
  check(`gait duty ${g.duty}: foot position is continuous across the cycle wrap`,
    Math.hypot(a.z - b.z, a.y - b.y) < 1e-4,
    `gap ${Math.hypot(a.z - b.z, a.y - b.y).toExponential(2)}`);
}

// ---------------------------------------------------------------------------
// 7. solveLeg round trip: the foot lands exactly on the requested target.
// ---------------------------------------------------------------------------

{
  const plans: [string, LegPlan][] = [
    ['foreleg', makeLegPlan(0.90, -0.55, 0.24, 0.05, -1)],
    ['hindleg', makeLegPlan(0.90,  0.55, 0.26, 0.55, +1)],
    ['bear fore', makeLegPlan(0.40, -0.30, 0.10, 0.05, -1)],
    ['dragon hind', makeLegPlan(1.40, 1.10, 0.40, 0.50, +1)],
  ];
  let worst = 0;
  for (const [, plan] of plans) {
    // Stride must come from the limb's own reach; anything longer clamps, and
    // a clamped foot is a skating foot (see maxStride).
    const stride = maxStride(plan, 0.62) * 0.95;
    for (let i = 0; i < 64; i++) {
      const f = footTarget((i / 64) * Math.PI * 2, stride, plan.rootY * 0.25, 0.62);
      const r = solveLeg(plan, f);
      const [fy, fz] = applyChain(
        plan.rootY - plan.l1 - plan.l2 - plan.cannon, plan.rootZ,
        [{ a: r.cannon, py: r.ankleY, pz: r.ankleZ },
         { a: r.lower,  py: r.kneeY,  pz: r.kneeZ },
         { a: r.upper,  py: plan.rootY, pz: plan.rootZ }]);
      worst = Math.max(worst,
        Math.hypot(fy - f.y, fz - (plan.rootZ + f.z)));
    }
  }
  check('solveLeg: foot lands on the gait target through the full chain',
    worst < 1e-9, `worst error ${worst.toExponential(2)} m`);
}

// ---------------------------------------------------------------------------
// 8. Bone lengths are FIXED — the limb must not telescope to reach.
// ---------------------------------------------------------------------------

{
  const plan = makeLegPlan(0.90, -0.55, 0.24, 0.05, -1);
  let minLen = Infinity, maxLen = -Infinity;
  for (let i = 0; i < 64; i++) {
    const f = footTarget((i / 64) * Math.PI * 2, maxStride(plan, 0.62) * 0.95, 0.25, 0.62);
    const r = solveLeg(plan, f);
    // Hip → knee in posed space.
    const [ky, kz] = applyChain(r.kneeY, r.kneeZ,
      [{ a: r.upper, py: plan.rootY, pz: plan.rootZ }]);
    const len = Math.hypot(plan.rootY - ky, plan.rootZ - kz);
    minLen = Math.min(minLen, len);
    maxLen = Math.max(maxLen, len);
  }
  check('upper bone length is constant across the whole cycle',
    near(minLen, maxLen, 1e-9) && near(minLen, plan.l1, 1e-9),
    `${minLen.toFixed(9)}..${maxLen.toFixed(9)} vs l1 ${plan.l1.toFixed(9)}`);
}

// ---------------------------------------------------------------------------
// 9. A standing limb keeps a live bend rather than locking straight.
// ---------------------------------------------------------------------------

{
  const plan = makeLegPlan(0.90, -0.55, 0.24, 0.05, -1);
  const r = solveLeg(plan, { z: 0, y: 0, planted: 1 });
  check('standing limb is bent, not locked', Math.abs(r.lower) > 0.15,
    `knee angle ${r.lower.toFixed(3)} rad`);
  check('standing limb is not over-crouched', Math.abs(r.lower) < 1.0,
    `knee angle ${r.lower.toFixed(3)} rad`);
}

// ---------------------------------------------------------------------------
// 9b. maxStride really is the clamp boundary — a stride at the limit reaches
//     exactly, and anything past it clamps (which is what skating looks like).
// ---------------------------------------------------------------------------

{
  const plans: [string, LegPlan][] = [
    ['foreleg',     makeLegPlan(0.90, -0.55, 0.24, 0.05, -1)],
    ['hindleg',     makeLegPlan(0.90,  0.55, 0.26, 0.55, +1)],
    ['bear fore',   makeLegPlan(0.40, -0.30, 0.10, 0.05, -1)],
    ['dragon hind', makeLegPlan(1.40,  1.10, 0.40, 0.50, +1)],
    ['crouched',    makeLegPlan(0.50, 0.0, 0.12, 0.30, +1, 0.5, 1.20)],
  ];
  for (const [name, plan] of plans) {
    check(`${name}: maxStride is positive`, maxStride(plan, 0.62) > 0,
      `${maxStride(plan, 0.62)}`);

    // At 95% of the limit every foot target is reachable, so the round trip
    // is exact (verified in test 7). At 130% it must clamp somewhere.
    let clamped = false;
    const over = maxStride(plan, 0.62) * 1.3;
    for (let i = 0; i < 64; i++) {
      const f = footTarget((i / 64) * Math.PI * 2, over, 0.1, 0.62);
      const r = solveLeg(plan, f);
      const [fy, fz] = applyChain(
        plan.rootY - plan.l1 - plan.l2 - plan.cannon, plan.rootZ,
        [{ a: r.cannon, py: r.ankleY, pz: r.ankleZ },
         { a: r.lower,  py: r.kneeY,  pz: r.kneeZ },
         { a: r.upper,  py: plan.rootY, pz: plan.rootZ }]);
      if (Math.hypot(fy - f.y, fz - (plan.rootZ + f.z)) > 1e-6) clamped = true;
    }
    check(`${name}: over-long stride is detected as unreachable`, clamped);
  }
}

// ---------------------------------------------------------------------------
// 10. Stride scaling: phase rate must make planted feet stop skating.
//     One cycle of phase == exactly one stride of ground.
// ---------------------------------------------------------------------------

{
  for (const size of [0.3, 1.0, 1.6, 3.5]) {
    const stride = strideLength(size);
    const metres = (Math.PI * 2) / phasePerMetre(size);
    check(`size ${size}: one phase cycle covers exactly one stride`,
      near(metres, stride, 1e-9), `${metres.toFixed(6)} vs ${stride.toFixed(6)}`);
  }
  check('a rabbit takes a much shorter stride than a horse',
    strideLength(0.3) < strideLength(1.6) * 0.3);
  check('stride never collapses to zero for tiny species',
    strideLength(0.01) > 0.2);
}

// ---------------------------------------------------------------------------
// 11. Gait patterns are internally consistent.
// ---------------------------------------------------------------------------

{
  for (const [name, g] of [['amble', GAIT_AMBLE], ['bound', GAIT_BOUND],
                           ['walk', GAIT_WALK]] as const) {
    check(`${name}: duty is a proper fraction`, g.duty > 0 && g.duty < 1);
    check(`${name}: four phase offsets in [0,1)`,
      g.offsets.length === 4 && g.offsets.every(o => o >= 0 && o < 1));
    check(`${name}: lift is positive`, g.lift > 0);
  }
  // Amble and walk must never leave the body unsupported.
  for (const [name, g] of [['amble', GAIT_AMBLE], ['walk', GAIT_WALK]] as const) {
    let minSupport = 4;
    for (let i = 0; i < 200; i++) {
      const u = i / 200;
      let n = 0;
      for (const off of g.offsets) {
        let p = (u + off) % 1;
        if (p < 0) p += 1;
        if (p < g.duty) n++;
      }
      minSupport = Math.min(minSupport, n);
    }
    check(`${name}: at least one foot is always planted`, minSupport >= 1,
      `min support ${minSupport}`);
  }
  // Bound is defined by having an airborne phase.
  {
    let minSupport = 4;
    for (let i = 0; i < 200; i++) {
      const u = i / 200;
      let n = 0;
      for (const off of GAIT_BOUND.offsets) {
        let p = (u + off) % 1;
        if (p < 0) p += 1;
        if (p < GAIT_BOUND.duty) n++;
      }
      minSupport = Math.min(minSupport, n);
    }
    check('bound: has a genuine airborne phase', minSupport === 0);
  }
  // Diagonal pairing: FL matches BR, FR matches BL.
  check('amble pairs legs diagonally',
    GAIT_AMBLE.offsets[0] === GAIT_AMBLE.offsets[3] &&
    GAIT_AMBLE.offsets[1] === GAIT_AMBLE.offsets[2]);
  // Lateral sequence: same-side legs are NOT simultaneous.
  check('walk is a lateral sequence, not a trot',
    GAIT_WALK.offsets[0] !== GAIT_WALK.offsets[3]);
}

// ---------------------------------------------------------------------------
// 12. Body bob stays in the expected range and is phase-locked to the feet.
// ---------------------------------------------------------------------------

{
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 200; i++) {
    const v = bodyBob((i / 200) * Math.PI * 2, GAIT_AMBLE);
    lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  check('body bob never lifts the body above its rest height', hi <= 1e-9,
    `max ${hi.toFixed(6)}`);
  check('body bob dips by a full unit at most', lo >= -1 - 1e-9,
    `min ${lo.toFixed(6)}`);
  check('body bob is continuous across the cycle wrap',
    near(bodyBob(0, GAIT_AMBLE), bodyBob(Math.PI * 2, GAIT_AMBLE), 1e-9));
}

// ---------------------------------------------------------------------------

console.log(`\ngait: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 1 & 0 : 1);
