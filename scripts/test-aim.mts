/**
 * Aim geometry tests.
 *
 *   npx tsx scripts/test-aim.mts
 *
 * The point of these is that they fly the arrow with the GAME'S OWN
 * integrator — `stepProjectiles`, at the game's own `SIM_DT` — rather than
 * against a tidy analytic trajectory written for the test. The two are not the
 * same: `stepProjectiles` is symplectic Euler, whose drop after time t is
 * `g*t*(t+dt)/2` rather than `g*t^2/2`, so it lands a predictable few
 * centimetres LOW of anything the continuous solution promises. A test that
 * re-derives the maths agrees with itself and tells you nothing about whether
 * the player can hit a deer. So: solve with `aimVelocity`, fire with
 * `spawnProjectile`, step with `stepProjectiles`, and measure how close the
 * shaft actually passes to the thing that was aimed at.
 */
import {
  ballisticElevation, aimVelocity, resolveAim, rayGround, rayCreature,
  type AimCandidate,
} from '../src/game/aim.ts';
import {
  createProjectilePool, spawnProjectile, stepProjectiles, PROJECTILE_GRAVITY,
} from '../src/game/projectiles.ts';
import { OrbitCamera } from '../src/game/camera.ts';
import { createHeightField, type HeightField } from '../src/game/noise.ts';

const SIM_DT = 1 / 60;              // matches main.ts
const ARROW_SPEED_MIN = 19;
const ARROW_SPEED_MAX = 36;
/** Arrow-vs-deer hit radius in game: 0.8 * max(1, species size). */
const DEER_HIT_RADIUS = 0.8 * 1.2;

let failures = 0;
let checks = 0;
function check(ok: boolean, name: string, detail = ''): void {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Fly a real arrow and report how close it passes to `target`.
 *
 * No ground and no hit resolution, so nothing stops it early and the closest
 * approach is a clean measurement rather than an artefact of where it stuck.
 */
function closestApproach(
  from: readonly [number, number, number],
  vel: readonly [number, number, number],
  speed: number,
  target: readonly [number, number, number],
): { miss: number; timeS: number } {
  const pool = createProjectilePool(4);
  spawnProjectile(pool, {
    kind: 'arrow',
    x: from[0], y: from[1], z: from[2],
    vx: vel[0] * speed, vy: vel[1] * speed, vz: vel[2] * speed,
    damage: 1, nowS: 0,
  });
  const hooks = { heightAt: () => -1e9, resolveHit: () => null };
  let best = Infinity;
  let bestT = 0;
  const p = pool.slots[0];
  for (let i = 1; i <= 300; i++) {          // 5 s at 60 Hz
    stepProjectiles(pool, SIM_DT, i * SIM_DT, hooks);
    if (!p.active) break;
    const d = Math.hypot(p.x - target[0], p.y - target[1], p.z - target[2]);
    if (d < best) { best = d; bestT = i * SIM_DT; }
  }
  return { miss: best, timeS: bestT };
}

console.log('\n=== 1. ballisticElevation ===');
{
  // Derivation check, independent of the implementation: substitute the
  // returned angle back into y = x tan0 - g x^2 / (2 v^2 cos^2 0) and confirm
  // the continuous trajectory really does pass through (range, rise).
  for (const [range, rise] of [[10, 0], [30, 0], [50, 0], [30, 12], [20, -6]]) {
    const th = ballisticElevation(ARROW_SPEED_MAX, range, rise, PROJECTILE_GRAVITY);
    if (th === null) { check(false, `elevation solves at R=${range} H=${rise}`); continue; }
    const c = Math.cos(th);
    const y = range * Math.tan(th)
      - PROJECTILE_GRAVITY * range * range / (2 * ARROW_SPEED_MAX ** 2 * c * c);
    check(Math.abs(y - rise) < 1e-6,
      `elevation solves at R=${range} H=${rise}`,
      `theta=${(th * 180 / Math.PI).toFixed(2)} deg, y=${y.toFixed(6)} vs ${rise}`);
  }
  // Low arc, not the mortar lob: never past 45 deg while the target is
  // reachable and level.
  const th = ballisticElevation(ARROW_SPEED_MAX, 30, 0, PROJECTILE_GRAVITY)!;
  check(th > 0 && th < Math.PI / 4, 'takes the low arc',
    `${(th * 180 / Math.PI).toFixed(2)} deg`);

  // Out of ballistic reach is a real answer, not a clamp.
  check(ballisticElevation(ARROW_SPEED_MIN, 50, 0, PROJECTILE_GRAVITY) === null,
    'min draw cannot reach 50 m', 'max range at 19 m/s is 36.8 m');
  check(ballisticElevation(ARROW_SPEED_MIN, 30, 0, PROJECTILE_GRAVITY) !== null,
    'min draw can reach 30 m');
  check(ballisticElevation(ARROW_SPEED_MAX, 200, 0, PROJECTILE_GRAVITY) === null,
    'full draw cannot reach 200 m', 'max range at 36 m/s is 132 m');
}

console.log('\n=== 2. the shot arrives (real integrator) ===');
{
  // The headline claim: aim at a thing, hit the thing. Muzzle at chest height,
  // targets at deer chest height, at the three ranges the brief names.
  const muzzle: [number, number, number] = [0, 1.2, 0];
  for (const range of [5, 20, 50]) {
    const target: [number, number, number] = [0, 0.6, -range];
    const dir = aimVelocity(muzzle, target, ARROW_SPEED_MAX, PROJECTILE_GRAVITY);
    if (dir === null) { check(false, `reaches ${range} m`); continue; }
    const { miss, timeS } = closestApproach(muzzle, dir, ARROW_SPEED_MAX, target);
    check(miss < DEER_HIT_RADIUS, `hits a deer at ${range} m`,
      `miss ${miss.toFixed(3)} m vs hit radius ${DEER_HIT_RADIUS.toFixed(2)} m, t=${timeS.toFixed(2)} s`);
  }

  // What the OLD code did, for the record: same muzzle, direction straight at
  // the target with no gravity solve. This is the measurement of the bug.
  for (const range of [5, 20, 50]) {
    const target: [number, number, number] = [0, 0.6, -range];
    const dx = target[0] - muzzle[0], dy = target[1] - muzzle[1], dz = target[2] - muzzle[2];
    const l = Math.hypot(dx, dy, dz);
    const { miss } = closestApproach(muzzle, [dx / l, dy / l, dz / l], ARROW_SPEED_MAX, target);
    console.log(`      (uncompensated at ${range} m would miss by ${miss.toFixed(2)} m)`);
  }
}

console.log('\n=== 3. shooting upward ===');
{
  // The case the game could not do at all: a dragon overhead. 20 m up and
  // 25 m out is 38.7 degrees of elevation — six times the old pitch clamp.
  const muzzle: [number, number, number] = [0, 1.2, 0];
  const target: [number, number, number] = [0, 21.2, -25];
  const dir = aimVelocity(muzzle, target, ARROW_SPEED_MAX, PROJECTILE_GRAVITY);
  check(dir !== null, 'a target 20 m up at 25 m is reachable');
  if (dir !== null) {
    const { miss } = closestApproach(muzzle, dir, ARROW_SPEED_MAX, target);
    // Black dragon size 4.4 -> hit radius 3.52 m; a wild dragon 3.5 -> 2.8 m.
    check(miss < 2.8, 'the arrow reaches a dragon 20 m overhead',
      `miss ${miss.toFixed(3)} m`);
    const up = Math.asin(dir[1]) * 180 / Math.PI;
    check(up > 30, 'requires real upward elevation', `${up.toFixed(1)} deg`);
  }
  // Straight up, the degenerate case that would otherwise divide by zero.
  const straight = aimVelocity([0, 0, 0], [0, 30, 0], ARROW_SPEED_MAX, PROJECTILE_GRAVITY);
  check(straight !== null && straight[1] === 1, 'straight up is a vertical shot');
  check(aimVelocity([0, 0, 0], [0, 80, 0], ARROW_SPEED_MAX, PROJECTILE_GRAVITY) === null,
    'straight up beyond apex is out of reach', '36 m/s tops out at 66 m');
}

console.log('\n=== 4. muzzle parallax is removed exactly ===');
{
  // The camera eye sits behind and above the chest. Converging on the LOOK
  // POINT rather than firing parallel to the camera is what removes the
  // offset; check the solved arc passes through the point regardless of how
  // far the muzzle is displaced from the eye.
  const eye: [number, number, number] = [0, 3.0, 6];
  const dir: [number, number, number] = [0, -0.15, -1];
  const l = Math.hypot(dir[0], dir[1], dir[2]);
  const unit: [number, number, number] = [dir[0] / l, dir[1] / l, dir[2] / l];
  const aimPt: [number, number, number] = [
    eye[0] + unit[0] * 30, eye[1] + unit[1] * 30, eye[2] + unit[2] * 30];
  const muzzle: [number, number, number] = [0, 1.2, 0];
  const v = aimVelocity(muzzle, aimPt, ARROW_SPEED_MAX, PROJECTILE_GRAVITY)!;
  const { miss } = closestApproach(muzzle, v, ARROW_SPEED_MAX, aimPt);
  check(miss < 0.35, 'converges on the look point from an offset muzzle',
    `miss ${miss.toFixed(3)} m`);
}

console.log('\n=== 5. resolveAim picks the right thing ===');
{
  const flat = () => 0;
  const eye: [number, number, number] = [0, 2, 0];
  const fwd: [number, number, number] = [0, 0, -1];
  const deer: AimCandidate = { id: 'd1', name: 'Deer', x: 0, y: 2, z: -20, radius: 0.96 };
  const far: AimCandidate = { id: 'd2', name: 'Boar', x: 0, y: 2, z: -40, radius: 0.96 };

  const a = resolveAim(eye, fwd, [far, deer], flat);
  check(a.id === 'd1', 'nearest creature on the ray wins', `${a.id}`);
  check(a.isTarget && Math.abs(a.dist - 20) < 1e-6, 'reports its distance',
    `${a.dist.toFixed(2)} m`);

  const b = resolveAim(eye, fwd, [], flat);
  check(!b.isTarget && b.id === null, 'empty ray is not a target');

  // Ground in front of a creature must win — you cannot shoot through a hill.
  const hill = (_x: number, z: number) => (z < -10 ? 50 : 0);
  const c = resolveAim(eye, fwd, [deer], hill);
  check(!c.isTarget && c.dist < 20, 'terrain in the way beats the creature behind it',
    `dist ${c.dist.toFixed(2)} m`);

  // Looking at the sky: converge far out rather than returning nothing.
  const d = resolveAim(eye, [0, 0.6, -0.8], [], flat, 160);
  check(d.dist === 160 && !d.isTarget, 'open sky converges at max distance');
}

console.log('\n=== 5b. no magnetism ===');
{
  // The aim must never be pulled toward a creature. A ray that passes 0.8 m
  // wide of a deer's centre has to stay 0.8 m wide of it: the creature
  // supplies the RANGE for the drop solve and nothing else. (An earlier
  // version converged on the creature's centre, which silently corrected
  // every near miss and would have made leading a moving animal unlearnable.)
  const flat = () => 0;
  const eye: [number, number, number] = [0, 2, 0];
  const deer: AimCandidate = { id: 'd', name: 'Deer', x: 0.8, y: 2, z: -20, radius: 0.96 };
  const straight: [number, number, number] = [0, 0, -1];
  const a = resolveAim(eye, straight, [deer], flat);
  check(a.isTarget, 'the deer is reported as what is under the crosshair');
  check(Math.abs(a.point[0] - 0) < 1e-9,
    'the aim point stays on the ray, not on the deer',
    `point.x=${a.point[0].toFixed(4)} (deer at x=0.8)`);

  // And the shot that follows keeps the same offset all the way to the target.
  const muzzle: [number, number, number] = [0, 1.2, 0];
  const v = aimVelocity(muzzle, a.point, ARROW_SPEED_MAX, PROJECTILE_GRAVITY)!;
  const { miss } = closestApproach(muzzle, v, ARROW_SPEED_MAX, [deer.x, deer.y, deer.z]);
  check(miss > 0.6, 'a shot aimed 0.8 m wide still passes wide',
    `closest approach to the deer ${miss.toFixed(2)} m — inside the 0.96 m hit`
    + ' radius, so it connects, but by the hit box and not by aim assist');

  // Aimed 4 m wide, it must miss outright.
  const far: AimCandidate = { id: 'f', name: 'Deer', x: 4, y: 2, z: -20, radius: 0.96 };
  const b = resolveAim(eye, straight, [far], flat);
  check(!b.isTarget, 'a deer 4 m off the ray is not under the crosshair');
  check(b.kind === 'none', 'a level look at open horizon finds nothing at all',
    `kind=${b.kind} — must NOT read as "out of range"`);
  // Straight-line fallback, exactly as main.ts does when there is no arc.
  const d2 = [b.point[0] - muzzle[0], b.point[1] - muzzle[1], b.point[2] - muzzle[2]];
  const l2 = Math.hypot(d2[0], d2[1], d2[2]);
  const v2: [number, number, number] = [d2[0] / l2, d2[1] / l2, d2[2] / l2];
  const m2 = closestApproach(muzzle, v2, ARROW_SPEED_MAX, [far.x, far.y, far.z]).miss;
  check(m2 > 3.5, 'and the arrow misses it by the amount the player was off',
    `${m2.toFixed(2)} m`);
}

console.log('\n=== 5c. a shot at nothing is still a shot ===');
{
  // Out of ballistic reach must not be a refusal. `aimVelocity` returns null,
  // and main.ts falls back to the straight line — the arrow leaves along where
  // the player pointed and falls short. Assert the fallback is well-formed.
  const muzzle: [number, number, number] = [0, 1.2, 0];
  const target: [number, number, number] = [0, 1.2, -120];
  check(aimVelocity(muzzle, target, ARROW_SPEED_MIN, PROJECTILE_GRAVITY) === null,
    '120 m at a tap draw has no solution');
  // The fallback main.ts uses.
  const l = 120;
  const { miss } = closestApproach(muzzle, [0, 0, -1], ARROW_SPEED_MIN, target);
  check(miss > 1 && Number.isFinite(miss),
    'the straight-line fallback flies and falls short rather than refusing',
    `falls ${miss.toFixed(1)} m short of a point ${l} m away`);
}

console.log('\n=== 6. rayGround accuracy ===');
{
  // A 30-degree slope; the intersection is analytically known.
  const slope = (x: number) => x * 0.5;
  const hit = rayGround([0, 10, 0], [1, 0, 0], 160, (x) => slope(x));
  check(hit !== null, 'finds the slope');
  if (hit !== null) {
    check(Math.abs(hit.point[0] - 20) < 0.05, 'lands within 5 cm of the true crossing',
      `x=${hit.point[0].toFixed(3)} vs 20`);
  }
  check(rayGround([0, 10, 0], [0, 1, 0], 160, () => 0) === null,
    'straight up never meets the ground');
  // Close range must not be stepped over — the coarse march starts small.
  const near = rayGround([0, 2, 0], [0.7071, -0.7071, 0], 160, () => 0);
  check(near !== null && Math.abs(near.dist - 2.828) < 0.05,
    'a 2 m drop right in front is not skipped',
    near === null ? 'missed' : `${near.dist.toFixed(3)} m`);
}

console.log('\n=== 7. rayCreature rejects what is behind you ===');
{
  const behind: AimCandidate = { id: 'b', name: 'Deer', x: 0, y: 0, z: 5, radius: 1 };
  check(rayCreature([0, 0, 0], [0, 0, -1], 100, [behind]) === null,
    'a creature behind the archer is not a target');
  const wide: AimCandidate = { id: 'w', name: 'Deer', x: 6, y: 0, z: -20, radius: 1 };
  check(rayCreature([0, 0, 0], [0, 0, -1], 100, [wide]) === null,
    'a creature well off the ray is not a target');
}

console.log('\n=== 8. camera aim range ===');
{
  // The single largest term in "extremely hard to aim at anything higher than
  // me": the pitch clamp was `max(-0.1, min(1.4, ...))` and pitch is POSITIVE
  // DOWN, so that is 80.2 degrees of down against 5.7 degrees of up.
  const hf = createHeightField(1234);
  const flat: HeightField = { ...hf, heightAt: () => 0 };
  const cam = new OrbitCamera(flat);

  cam.pitch = 0;
  for (let i = 0; i < 4000; i++) cam.onMouseMove(0, -1);   // drag up, hard
  const upDeg = -cam.pitch * 180 / Math.PI;
  check(upDeg > 60, 'the camera can aim well above the horizon',
    `${upDeg.toFixed(1)} deg up (was 5.7)`);
  check(upDeg < 85, 'but not so far that lookAt degenerates',
    `${upDeg.toFixed(1)} deg — the up vector is [0,1,0]`);

  cam.pitch = 0;
  for (let i = 0; i < 4000; i++) cam.onMouseMove(0, 1);    // drag down
  const downDeg = cam.pitch * 180 / Math.PI;
  check(Math.abs(downDeg - 80.2) < 0.5, 'downward range is unchanged',
    `${downDeg.toFixed(1)} deg`);

  // The eye must stay above the ground AND stay on the view ray across the
  // whole range. Staying on the ray is what keeps `forward()` the true screen
  // centre — the old code lifted the eye in Y instead, which silently bent the
  // look direction away from the ray the shot used.
  const anchor: [number, number, number] = [0, 1.445, 0];   // feet at 0
  let minClear = Infinity;
  let maxOffRay = 0;
  for (let p = -1.25; p <= 1.4; p += 0.02) {
    cam.pitch = p;
    const eye = cam.eye(anchor);
    minClear = Math.min(minClear, eye[1] - 0);
    // Distance from the eye to the line through the pivot along -forward.
    const pivot = cam.pivot(anchor);
    const f = cam.forward();
    const vx = eye[0] - pivot[0], vy = eye[1] - pivot[1], vz = eye[2] - pivot[2];
    const along = vx * f[0] + vy * f[1] + vz * f[2];
    const perp = Math.hypot(vx - f[0] * along, vy - f[1] * along, vz - f[2] * along);
    maxOffRay = Math.max(maxOffRay, perp);
  }
  check(minClear > 0.3, 'the eye never goes under the ground at any pitch',
    `closest approach to the ground ${minClear.toFixed(2)} m`);
  check(maxOffRay < 1e-9, 'and never leaves the view ray, at any pitch',
    `max perpendicular deviation ${maxOffRay.toExponential(1)} m`);

  // Framing: pitched hard up the eye should not be jammed inside the player.
  cam.pitch = -1.25;
  cam.distance = 6;
  const eyeUp = cam.eye(anchor);
  const sep = Math.hypot(eyeUp[0] - anchor[0], eyeUp[1] - anchor[1], eyeUp[2] - anchor[2]);
  check(sep > 1.0, 'the camera keeps clear of the player at full up-pitch',
    `${sep.toFixed(2)} m from the head`);
}

console.log('\n=== 9. first person keeps the reticle honest ===');
{
  // The whole reticle contract is that screen centre is the `forward()` ray
  // FROM THE EYE. First person moves the eye 6 m along that ray onto the
  // player's head, so if the contract holds the aim must be untouched — and
  // the one thing that genuinely breaks at zero boom is `lookAt(eye, pivot)`,
  // because the two points become one and `normalize` returns [0,0,0] rather
  // than NaN. A degenerate basis is a black screen, not a warning.
  const hf = createHeightField(1234);
  const flat: HeightField = { ...hf, heightAt: () => 0 };
  const cam = new OrbitCamera(flat);
  const anchor: [number, number, number] = [0, 1.445, 0];

  cam.pitch = 0.2;
  cam.yaw = 0.7;
  cam.distance = 6;
  cam.firstPerson = 1;
  const eyeFP = cam.eye(anchor);
  check(Math.hypot(eyeFP[0] - anchor[0], eyeFP[1] - anchor[1], eyeFP[2] - anchor[2]) < 1e-9,
    'at full first person the eye is exactly the anchor',
    `${Math.hypot(eyeFP[0], eyeFP[1] - 1.445, eyeFP[2]).toExponential(1)} m off`);

  // Sweep the blend AND the pitch together: the eye must stay on the ray the
  // whole way, or the crosshair means something different mid-transition than
  // it does at either end.
  let maxOffRay = 0;
  let minBasis = Infinity;
  for (let b = 0; b <= 1.0001; b += 0.05) {
    cam.firstPerson = b;
    for (let p = -1.25; p <= 1.4; p += 0.1) {
      cam.pitch = p;
      const eye = cam.eye(anchor);
      const pivot = cam.pivot(anchor);
      const f = cam.forward();
      const vx = eye[0] - pivot[0], vy = eye[1] - pivot[1], vz = eye[2] - pivot[2];
      const along = vx * f[0] + vy * f[1] + vz * f[2];
      maxOffRay = Math.max(maxOffRay,
        Math.hypot(vx - f[0] * along, vy - f[1] * along, vz - f[2] * along));
      // The view matrix must stay a real rotation. A collapsed basis shows up
      // as a zero row; check the magnitude of the first three columns.
      const { view } = cam.viewMatrix(anchor);
      for (let c = 0; c < 3; c++) {
        minBasis = Math.min(minBasis,
          Math.hypot(view[c], view[4 + c], view[8 + c]));
      }
    }
  }
  check(maxOffRay < 1e-9, 'the eye never leaves the view ray at any blend',
    `max perpendicular deviation ${maxOffRay.toExponential(1)} m`);
  check(minBasis > 0.999, 'and the view basis never collapses',
    `weakest axis length ${minBasis.toFixed(6)} (zero = black screen)`);

  // The aim ray itself is identical in both views: same origin line, same
  // direction, so a target on the crosshair in one is on it in the other.
  cam.pitch = -0.3;
  cam.firstPerson = 0;
  const fTP = cam.forward();
  const eTP = cam.eye(anchor);
  cam.firstPerson = 1;
  const fFP = cam.forward();
  const eFP = cam.eye(anchor);
  const dot = fTP[0] * fFP[0] + fTP[1] * fFP[1] + fTP[2] * fFP[2];
  check(Math.abs(dot - 1) < 1e-12, 'both views look in exactly the same direction',
    `dot ${dot.toFixed(15)}`);
  // Level or looking down, the eye slides purely ALONG the ray, so the two
  // views mark exactly the same world point — entering first person does not
  // move the crosshair off what it was on.
  cam.pitch = 0.2;
  cam.firstPerson = 0;
  const lvlTP = cam.eye(anchor);
  const fLvl = cam.forward();
  cam.firstPerson = 1;
  const lvlFP = cam.eye(anchor);
  {
    const dx = lvlFP[0] - lvlTP[0], dy = lvlFP[1] - lvlTP[1], dz = lvlFP[2] - lvlTP[2];
    const len = Math.hypot(dx, dy, dz);
    const par = Math.abs((dx * fLvl[0] + dy * fLvl[1] + dz * fLvl[2]) / len);
    check(Math.abs(par - 1) < 1e-9,
      'below the horizon the eye slides purely along the ray, so the aim point holds',
      `${len.toFixed(2)} m apart, parallelism ${par.toFixed(12)}`);
  }

  // Looking UP is the exception, and it is a known one rather than a leak.
  // AIM_LIFT raises the pivot in proportion to the BOOM so a rear orbit does
  // not bury itself; at zero boom there is no swing to compensate and the lift
  // correctly goes to zero. The ray therefore TRANSLATES down as the camera
  // comes in — parallel, never rotated — by exactly the lift it is giving up.
  // Worst case is full up-pitch, and the number matters because it is how far
  // the crosshair walks during the transition.
  cam.pitch = -1.25;
  cam.distance = 6;
  cam.firstPerson = 0;
  const upTP = cam.eye(anchor);
  const upPivot = cam.pivot(anchor);
  const fUp = cam.forward();
  cam.firstPerson = 1;
  const upFP = cam.eye(anchor);
  {
    const dx = upFP[0] - upTP[0], dy = upFP[1] - upTP[1], dz = upFP[2] - upTP[2];
    const along = dx * fUp[0] + dy * fUp[1] + dz * fUp[2];
    const perp = Math.hypot(dx - fUp[0] * along, dy - fUp[1] * along, dz - fUp[2] * along);
    check(perp < 3.4 && Math.abs(upPivot[1] - anchor[1]) > 3,
      'and at full up-pitch it translates by exactly the lift it gives up',
      `pivot lift ${(upPivot[1] - anchor[1]).toFixed(2)} m,`
      + ` ray offset ${perp.toFixed(2)} m (crosshair walk during the switch)`);
  }

  // Third person must be untouched by any of this.
  cam.firstPerson = 0;
  cam.pitch = 0.35;
  cam.distance = 6;
  const eyeTP = cam.eye(anchor);
  check(Math.abs(Math.hypot(
    eyeTP[0] - anchor[0], eyeTP[1] - anchor[1], eyeTP[2] - anchor[2]) - 6) < 1e-9,
  'and a zero blend is the plain six-metre boom it always was',
  `${Math.hypot(eyeTP[0] - anchor[0], eyeTP[1] - anchor[1],
    eyeTP[2] - anchor[2]).toFixed(6)} m`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} — ${checks} checks`);
process.exit(failures === 0 ? 0 : 1);
