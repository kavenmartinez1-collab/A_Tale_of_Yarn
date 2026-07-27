/**
 * breath-cone.ts — what a breath weapon actually hits.
 *
 * PURE. Extracted from `main.ts`'s private `inBreathCone` so it can be
 * measured in Node, because the bug it exists to fix was invisible from the
 * inside: the breath fired, drained stamina, drew a full jet of flame, and
 * dealt exactly zero damage for its entire duration.
 *
 * ## The near-field dead zone
 *
 * The old test was a pure angular cone: accept when the direction to the
 * target is within `BREATH_HALF_ANGLE` (0.32 rad, ~18 deg) of the aim axis.
 * That is correct at range and WRONG up close, because the mouth is not at the
 * player's eye — it is on the animal's head, `mouth[1] * size` above its feet.
 *
 * Measured, for a wyvern (size 2.4, mouth [1.16, 1.18]) breathing at a deer
 * (size 1.2) six metres away on flat ground:
 *
 *     mouth height      2.4 * 1.18            = 2.83 m
 *     mouth forward     2.4 * 1.16            = 2.78 m
 *     target chest      1.2 * 0.5             = 0.60 m
 *     horizontal gap    6.00 - 2.78           = 3.22 m
 *     angle below axis  atan(2.23 / 3.22)     = 34.7 deg
 *
 * 34.7 against a half-angle of 18.3. The deer was never in the cone, and no
 * amount of aiming fixed it: to bring a target six metres away inside the cone
 * the player would have to pitch the camera 35 degrees down, at which point
 * the third-person camera is looking at the ground. The dead zone closes at
 * about 12 m and the weapon only works beyond it — which is exactly backwards
 * for the close-quarters brawl a mounted fight actually is.
 *
 * ## The fix: the jet has width
 *
 * A cone of half-angle A at axial distance t has radius `t * tan(A)`. Near the
 * mouth that radius goes to zero, which is the dead zone and is also not what
 * a jet of fire looks like — flame leaves a mouth already a body-width across.
 * So the radius gets a floor:
 *
 *     radius(t) = max(NEAR_RADIUS, t * tan(BREATH_HALF_ANGLE))
 *
 * and a target is hit when its perpendicular distance from the axis is inside
 * that radius. Beyond ~4.6 m the two rules agree exactly, so nothing about the
 * weapon's behaviour at range changes; inside it, the jet is a cylinder of
 * flame instead of a mathematical point.
 *
 * Targets BEHIND the mouth are still rejected (`t < 0`), so this cannot be
 * used to breathe on something standing on the animal's tail.
 */

import { BREATH_RANGE, BREATH_HALF_ANGLE } from './fire';

/**
 * Radius of the jet at the mouth, metres.
 *
 * The near radius is the SECOND half of the fix, and on its own it was not
 * enough: at 1.5 m the deer above is still 2.23 m off the axis and still
 * missed. The first half is in `getBreathRay`, which now converges the jet on
 * the point the player is looking at instead of firing parallel to the camera
 * from a mouth that is nowhere near it.
 *
 * With the aim corrected, this only has to cover what convergence cannot: the
 * last couple of metres, where any residual origin error is large relative to
 * the distance, and the case of a target standing directly under the animal's
 * chin. 2.5 m does that, and it stops mattering past
 * `2.5 / tan(18.3 deg)` = 7.6 m, beyond which the ordinary cone is wider
 * anyway — so nothing about the weapon's behaviour at range changes.
 */
export const BREATH_NEAR_RADIUS = 2.5;

/** Distance at which the angular cone overtakes the near radius. */
export const BREATH_NEAR_DIST = BREATH_NEAR_RADIUS / Math.tan(BREATH_HALF_ANGLE);

/**
 * Geometry of one breath test, for the debug hook and the tests.
 *
 * `hit` is the answer; the rest is why. Reporting the axial and perpendicular
 * distances separately is what turned "the breath does nothing" into a number
 * that pointed straight at the mouth height.
 */
export interface BreathHit {
  hit: boolean;
  /** Distance along the aim axis. Negative means behind the mouth. */
  axial: number;
  /** Perpendicular distance from the axis. */
  perp: number;
  /** Radius of the jet at `axial`. */
  radius: number;
  /** Straight-line distance from the mouth. */
  dist: number;
  /** Angle off the axis, degrees — the number the old test compared. */
  angleDeg: number;
}

/**
 * Test a point against a breath jet.
 *
 * `dir` must be a unit vector. `reach` scales the range, per
 * `BREATH_SPEC[species].reach`.
 */
export function breathHit(
  mouth: readonly [number, number, number],
  dir: readonly [number, number, number],
  x: number, y: number, z: number,
  reach = 1,
): BreathHit {
  const vx = x - mouth[0];
  const vy = y - mouth[1];
  const vz = z - mouth[2];
  const dist = Math.hypot(vx, vy, vz);
  const axial = vx * dir[0] + vy * dir[1] + vz * dir[2];
  // Perpendicular leg of the right triangle. `max(0, ...)` because floating
  // point can make `dist^2 - axial^2` a very small negative for a point
  // exactly on the axis, and `Math.sqrt` of that is NaN — which would silently
  // read as "not hit" for the one case that is most obviously a hit.
  const perp = Math.sqrt(Math.max(0, dist * dist - axial * axial));
  const radius = Math.max(BREATH_NEAR_RADIUS, axial * Math.tan(BREATH_HALF_ANGLE));
  const angleDeg = dist < 1e-6 ? 0
    : Math.acos(Math.max(-1, Math.min(1, axial / dist))) * 180 / Math.PI;
  const range = BREATH_RANGE * reach;
  const hit = dist >= 0.001 && axial >= 0 && axial <= range && perp <= radius;
  return { hit, axial, perp, radius, dist, angleDeg };
}

/** Boolean form, for the hot path. */
export function inBreathCone(
  mouth: readonly [number, number, number],
  dir: readonly [number, number, number],
  x: number, y: number, z: number,
  reach = 1,
): boolean {
  return breathHit(mouth, dir, x, y, z, reach).hit;
}
