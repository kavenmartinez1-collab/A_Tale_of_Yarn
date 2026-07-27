/**
 * Tests for Z-targeting maths.
 * Run:  npx tsx scripts/test-lock-on.mts
 *
 * Section 1 is the reason this file exists. The camera-yaw and mesh-facing
 * conventions in this codebase are negatives of each other, every agent who
 * has touched them has got one of them backwards at least once, and the
 * symptom — a camera that frames the enemy while the doll faces away from it,
 * or vice versa — is invisible to a type checker.
 */

import {
  lockCameraYaw, lockFacingYaw, angleDelta, easeAngle,
  pickLockTarget, cycleLockTarget, lockBreakReason, indicatorFade,
  LOCK_ACQUIRE_RANGE, LOCK_BREAK_RANGE, LOCK_ACQUIRE_CONE, LOCK_EASE_PER_S,
  type LockCandidate,
} from '../src/game/combat/lock-on';

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
const near = (a: number, b: number, tol = 1e-9): boolean => Math.abs(a - b) <= tol;

const c = (id: string, x: number, z: number, hostile = true): LockCandidate =>
  ({ id, x, z, hostile });

// ---------------------------------------------------------------------------
// 1. The two conventions
// ---------------------------------------------------------------------------

{
  // Target due -Z of the player. Camera yaw 0 looks down -Z; a mesh at yaw 0
  // also faces -Z. This is the one bearing where the two agree.
  check('target at -Z: camera yaw 0', near(lockCameraYaw(0, 0, 0, -5), 0));
  check('target at -Z: facing yaw 0', near(lockFacingYaw(0, 0, 0, -5), 0));

  // Target due +X (to the player's right).
  check('target at +X: camera yaw -pi/2',
    near(lockCameraYaw(0, 0, 5, 0), -Math.PI / 2));
  check('target at +X: facing yaw +pi/2',
    near(lockFacingYaw(0, 0, 5, 0), Math.PI / 2));

  // The identity `main.ts` relies on when a swing snaps the body to the camera.
  for (const [tx, tz] of [[3, 4], [-7, 2], [0.5, -9], [-2, -2], [8, 0], [0, 6]]) {
    const cam = lockCameraYaw(1, 1, tx!, tz!);
    const face = lockFacingYaw(1, 1, tx!, tz!);
    check(`facing === -cameraYaw at (${tx},${tz})`,
      near(Math.sin(face), Math.sin(-cam)) && near(Math.cos(face), Math.cos(-cam)),
      `cam=${cam.toFixed(4)} face=${face.toFixed(4)}`);
  }

  // And the camera really does end up pointing AT the target: reconstruct
  // OrbitCamera.forward()'s XZ and check it lines up with the bearing.
  for (const [tx, tz] of [[6, 3], [-4, 9], [-5, -5]]) {
    const yaw = lockCameraYaw(0, 0, tx!, tz!);
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const d = Math.hypot(tx!, tz!);
    check(`camera forward points at (${tx},${tz})`,
      near(fx, tx! / d, 1e-9) && near(fz, tz! / d, 1e-9),
      `forward=(${fx.toFixed(3)},${fz.toFixed(3)})`);
  }
}

// ---------------------------------------------------------------------------
// 2. Angle helpers
// ---------------------------------------------------------------------------

{
  check('angleDelta takes the short way round',
    near(angleDelta(3.0, -3.0), (Math.PI * 2) - 6.0, 1e-9),
    `${angleDelta(3.0, -3.0)}`);
  check('angleDelta of equal angles is 0', near(angleDelta(1.2, 1.2), 0));
  check('angleDelta is signed', angleDelta(0, 1) > 0 && angleDelta(0, -1) < 0);

  // Easing converges, never overshoots, and crosses the wrap seam cleanly.
  let a = 3.10;
  const goal = -3.10;
  for (let i = 0; i < 240; i++) a = easeAngle(a, goal, LOCK_EASE_PER_S, 1 / 60);
  check('easing converges across the +/-pi seam',
    Math.abs(angleDelta(a, goal)) < 1e-3, `off by ${angleDelta(a, goal)}`);

  // Frame-rate independence: 1 s of easing at 30 Hz and at 144 Hz must land in
  // the same place, or the camera behaves differently on different machines.
  let slow = 0, fast = 0;
  for (let i = 0; i < 30; i++) slow = easeAngle(slow, 1, LOCK_EASE_PER_S, 1 / 30);
  for (let i = 0; i < 144; i++) fast = easeAngle(fast, 1, LOCK_EASE_PER_S, 1 / 144);
  check('easing is frame-rate independent', Math.abs(slow - fast) < 5e-3,
    `30Hz=${slow.toFixed(5)} 144Hz=${fast.toFixed(5)}`);

  let over = 0;
  for (let i = 0; i < 600; i++) over = easeAngle(over, 1, LOCK_EASE_PER_S, 1 / 60);
  check('easing never overshoots', over <= 1 + 1e-9, `${over}`);
}

// ---------------------------------------------------------------------------
// 3. Acquisition
// ---------------------------------------------------------------------------

{
  // Camera looking down -Z (yaw 0).
  const ahead = c('ahead', 0, -10);
  const behind = c('behind', 0, 10);
  check('locks onto something ahead',
    pickLockTarget([ahead], 0, 0, 0) === 'ahead');
  check('never locks onto something behind you',
    pickLockTarget([behind], 0, 0, 0) === null);
  check('nothing to lock onto returns null',
    pickLockTarget([], 0, 0, 0) === null);

  // The whole point of the off-centre penalty: what you are LOOKING at beats
  // what is merely nearest.
  const nearSide = c('near-side', -9, -1);   // 9 m, ~84 deg off centre
  const farAhead = c('far-ahead', 0, -14);   // 14 m, dead ahead
  check('a target dead ahead beats a nearer one off to the side',
    pickLockTarget([nearSide, farAhead], 0, 0, 0) === 'far-ahead');

  // ...but not at any cost: something much nearer and only slightly off centre
  // must still win, or the lock feels like it ignores the thing biting you.
  const slightly = c('slightly-off', 2, -4);
  const straight = c('straight-far', 0, -20);
  check('a much nearer, slightly-off target still wins',
    pickLockTarget([slightly, straight], 0, 0, 0) === 'slightly-off');

  check('out of acquire range is not acquired',
    pickLockTarget([c('far', 0, -(LOCK_ACQUIRE_RANGE + 1))], 0, 0, 0) === null);
  check('just inside acquire range is acquired',
    pickLockTarget([c('in', 0, -(LOCK_ACQUIRE_RANGE - 0.5))], 0, 0, 0) === 'in');
  check('non-hostiles (pets, corpses) are never targets',
    pickLockTarget([c('pet', 0, -5, false)], 0, 0, 0) === null);

  // The cone edge, both sides of it.
  const justIn = LOCK_ACQUIRE_CONE - 0.05;
  const justOut = LOCK_ACQUIRE_CONE + 0.05;
  const at = (ang: number): LockCandidate =>
    c('edge', Math.sin(ang) * 8, -Math.cos(ang) * 8);
  check('just inside the acquisition cone', pickLockTarget([at(justIn)], 0, 0, 0) === 'edge');
  check('just outside the acquisition cone', pickLockTarget([at(justOut)], 0, 0, 0) === null);

  // Acquisition must follow the camera, not the world axes.
  const east = c('east', 10, 0);
  check('acquisition respects where the camera is pointed',
    pickLockTarget([east], 0, 0, 0) === null
    && pickLockTarget([east], 0, 0, -Math.PI / 2) === 'east');
}

// ---------------------------------------------------------------------------
// 4. Cycling
// ---------------------------------------------------------------------------

{
  const ring = [c('a', 0, -8), c('b', 6, -6), c('c', -6, -6)];
  const first = cycleLockTarget(ring, null, 0, 0, 0, 1);
  check('cycling with no lock picks one', first !== null, `${first}`);

  // Order is by on-screen bearing, and it wraps.
  const seen: string[] = [];
  let cur = first;
  for (let i = 0; i < 3; i++) {
    seen.push(cur!);
    cur = cycleLockTarget(ring, cur, 0, 0, 0, 1);
  }
  check('cycling visits every target', new Set(seen).size === 3, seen.join(','));
  check('cycling wraps back to the start', cur === first, `${cur} vs ${first}`);

  // Left and right are genuinely opposite.
  const right = cycleLockTarget(ring, 'a', 0, 0, 0, 1);
  const left = cycleLockTarget(ring, 'a', 0, 0, 0, -1);
  check('cycling left and right differ', right !== left, `${right} / ${left}`);

  check('cycling with one target keeps it',
    cycleLockTarget([c('only', 0, -5)], 'only', 0, 0, 0, 1) === 'only');
  check('cycling with nothing alive returns null',
    cycleLockTarget([], 'gone', 0, 0, 0, 1) === null);

  // Cycling deliberately is NOT limited to the acquisition cone — once you are
  // in a fight the thing you want next is often off screen.
  const bhd = [c('front', 0, -5), c('back', 0, 8)];
  const ids = new Set<string>();
  let k: string | null = 'front';
  for (let i = 0; i < 4; i++) { ids.add(k!); k = cycleLockTarget(bhd, k, 0, 0, 0, 1); }
  check('cycling can reach a target behind you', ids.has('back'), [...ids].join(','));
}

// ---------------------------------------------------------------------------
// 5. Breaking
// ---------------------------------------------------------------------------

{
  check('a live target in range holds the lock',
    lockBreakReason(c('t', 0, -5), 0, 0) === null);
  check('a target that left the world breaks the lock',
    lockBreakReason(undefined, 0, 0) === 'gone');
  check('a dead target breaks the lock',
    lockBreakReason(c('t', 0, -5, false), 0, 0) === 'dead');
  check('a target past the break range breaks the lock',
    lockBreakReason(c('t', 0, -(LOCK_BREAK_RANGE + 1)), 0, 0) === 'range');
  check('a target just inside the break range holds',
    lockBreakReason(c('t', 0, -(LOCK_BREAK_RANGE - 0.5)), 0, 0) === null);

  // Hysteresis: the band between acquire and break range must be non-empty, or
  // a target sitting at the boundary flickers on and off as the player drifts.
  check('acquire range is inside break range', LOCK_ACQUIRE_RANGE < LOCK_BREAK_RANGE,
    `${LOCK_ACQUIRE_RANGE} vs ${LOCK_BREAK_RANGE}`);
  const mid = (LOCK_ACQUIRE_RANGE + LOCK_BREAK_RANGE) / 2;
  check('...and a lock held into that band is not dropped',
    lockBreakReason(c('t', 0, -mid), 0, 0) === null);
  check('...while a fresh lock could not be taken there',
    pickLockTarget([c('t', 0, -mid)], 0, 0, 0) === null);
}

// ---------------------------------------------------------------------------
// 6. Indicator fade
// ---------------------------------------------------------------------------

{
  check('indicator is solid up close', indicatorFade(3) === 1);
  check('indicator is solid at the acquire range', indicatorFade(LOCK_ACQUIRE_RANGE) === 1);
  check('indicator is gone at the break range', indicatorFade(LOCK_BREAK_RANGE) === 0);
  const midFade = indicatorFade((LOCK_ACQUIRE_RANGE + LOCK_BREAK_RANGE) / 2);
  check('indicator fades in between', midFade > 0 && midFade < 1, `${midFade}`);
  check('indicator never goes negative', indicatorFade(1000) === 0);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
