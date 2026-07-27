/**
 * lock-on.ts — Z-targeting: the camera frames a chosen enemy, and everything
 * you do becomes relative to it.
 *
 * ## THE TWO YAW CONVENTIONS, WHICH ARE NOT THE SAME CONVENTION
 *
 * This has burned people here repeatedly, so it is written down once, in the
 * module that needs both:
 *
 *   - **Camera yaw.** `OrbitCamera.forward()` is
 *     `(-sin yaw, -sin pitch, -cos yaw)`. For the camera to look from behind
 *     the player THROUGH the target, that forward must point along
 *     `(tx-px, tz-pz)`, which gives `yaw = atan2(-(tx-px), -(tz-pz))`.
 *   - **Mesh facing.** A character mesh faces `atan2(dx, -dz)`.
 *
 * They are negatives of each other — `atan2(-a, b) === -atan2(a, b)` — which
 * is exactly why `main.ts` writes `controller.yaw = -orbitCam.yaw` when a
 * swing snaps the body to the camera. `lockCameraYaw` and `lockFacingYaw`
 * below are the two halves of that identity, named, so no call site has to
 * re-derive which one it wants. `test-lock-on.mts` asserts the identity holds.
 *
 * ## TARGET-RELATIVE MOVEMENT IS NOT IMPLEMENTED HERE, ON PURPOSE
 *
 * `PlayerController` already rotates WASD by the camera yaw. Once the camera
 * is framed on the target, W is already "toward the target" and A/D are
 * already "strafe around it" — and because the camera keeps re-easing onto the
 * target as you move, the strafe direction keeps rotating and the path is a
 * circle rather than a tangent line. Target-relative movement falls out of the
 * camera framing for free.
 *
 * The one thing that does NOT fall out is which way the doll faces: normally
 * the body turns to face its own direction of travel, which while strafing
 * means showing the enemy your shoulder. `lockFacingYaw` is what `main.ts`
 * feeds to the controller to override that. Writing a second movement
 * transform here would have been a duplicate of the controller's, free to
 * drift out of agreement with it — the exact class of bug the reticle was
 * invented to stop.
 *
 * ## THE BOW IS NEVER GATED BY THIS
 *
 * Lock-on drives the camera and the body, and nothing else. Aiming stays free:
 * the reticle is the `forward()` ray from the eye and an arrow goes exactly
 * where it points, locked or not. A reticle that lies — or that snaps — is
 * worse than no reticle, and this module is not allowed to introduce one.
 *
 * Pure module: no DOM, no GPU. Node-testable.
 */

/** Furthest a lock may be held before it breaks. */
export const LOCK_BREAK_RANGE = 30;

/**
 * Furthest a lock may be ACQUIRED.
 *
 * Deliberately shorter than the break range. Acquiring and breaking at one
 * distance makes a target at exactly that range flicker on and off as you
 * drift; the gap is hysteresis, and it also means a lock you already have
 * survives a moment of chasing something that is running away.
 */
export const LOCK_ACQUIRE_RANGE = 22;

/**
 * Half-angle, in radians, of the cone in front of the camera that a FRESH lock
 * may be acquired from. 1.05 rad = 60 deg, so a 120 deg cone.
 *
 * Not the full screen: locking onto something behind you because it happened
 * to be two metres nearer is the single most common way this feature feels
 * broken. Cycling is not restricted by this — once you are in a fight, the
 * thing you want next is often off-screen, and you asked for it explicitly.
 */
export const LOCK_ACQUIRE_CONE = 1.05;

/** How fast the camera eases onto the target, as a fraction per second. */
export const LOCK_EASE_PER_S = 7.5;

/** A thing that can be locked onto. */
export interface LockCandidate {
  id: string;
  x: number;
  z: number;
  /** False for corpses, pets, and anything else that must never be a target. */
  hostile: boolean;
}

/** Camera yaw that frames `t` from behind the player. See the header. */
export function lockCameraYaw(px: number, pz: number, tx: number, tz: number): number {
  return Math.atan2(-(tx - px), -(tz - pz));
}

/** Mesh facing that points the player's body at `t`. See the header. */
export function lockFacingYaw(px: number, pz: number, tx: number, tz: number): number {
  return Math.atan2(tx - px, -(tz - pz));
}

/** Shortest signed angular difference `to - from`, in (-pi, pi]. */
export function angleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Ease `current` toward `target` the short way round.
 *
 * Frame-rate independent: `1 - exp(-k*dt)` rather than `k*dt`, so the camera
 * behaves the same at 30 and 144 fps. The naive form overshoots and rings at
 * low frame rates, which reads as the camera fighting the player.
 */
export function easeAngle(current: number, target: number, perS: number, dtS: number): number {
  const k = 1 - Math.exp(-perS * dtS);
  return current + angleDelta(current, target) * k;
}

/** Where a candidate sits relative to the camera's facing, in radians off centre. */
function offCentre(camYaw: number, px: number, pz: number, c: LockCandidate): number {
  return Math.abs(angleDelta(camYaw, lockCameraYaw(px, pz, c.x, c.z)));
}

/**
 * Pick a target to lock onto, or null when nothing qualifies.
 *
 * Scored on distance with an off-centre penalty rather than on distance alone,
 * because "nearest" and "the one I am looking at" disagree constantly in a
 * melee and the player only ever means the second one.
 */
export function pickLockTarget(
  candidates: readonly LockCandidate[],
  px: number, pz: number, camYaw: number,
): string | null {
  let bestId: string | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    if (!c.hostile) continue;
    const dx = c.x - px, dz = c.z - pz;
    const d = Math.hypot(dx, dz);
    if (d > LOCK_ACQUIRE_RANGE || d < 1e-4) continue;
    const off = offCentre(camYaw, px, pz, c);
    if (off > LOCK_ACQUIRE_CONE) continue;
    // Distance in metres, plus up to ~12 m of penalty for being at the edge of
    // the cone. Tuned so a target dead ahead beats one 10 m nearer but 55 deg
    // off to the side — which is what a player pointing the camera means.
    const score = d + (off / LOCK_ACQUIRE_CONE) * 12;
    if (score < bestScore) { bestScore = score; bestId = c.id; }
  }
  return bestId;
}

/**
 * Next target when the player flicks the stick or taps cycle.
 *
 * Ordered by SIGNED bearing relative to the camera, so "next" means the next
 * one round to the left or right — the order the player sees on screen —
 * rather than the next one in whatever order the entity map happens to be in.
 * Wraps. Returns the current target when there is nothing else to go to,
 * because dropping the lock on a failed cycle is never what was meant.
 */
export function cycleLockTarget(
  candidates: readonly LockCandidate[],
  currentId: string | null,
  px: number, pz: number, camYaw: number,
  dir: number,
): string | null {
  const live: { id: string; bearing: number }[] = [];
  for (const c of candidates) {
    if (!c.hostile) continue;
    const d = Math.hypot(c.x - px, c.z - pz);
    if (d > LOCK_BREAK_RANGE || d < 1e-4) continue;
    live.push({ id: c.id, bearing: angleDelta(camYaw, lockCameraYaw(px, pz, c.x, c.z)) });
  }
  if (live.length === 0) return null;
  live.sort((a, b) => a.bearing - b.bearing || (a.id < b.id ? -1 : 1));
  if (currentId === null) return live[0]!.id;
  const i = live.findIndex((c) => c.id === currentId);
  if (i < 0) return live[0]!.id;
  const step = dir >= 0 ? 1 : -1;
  const n = live.length;
  return live[((i + step) % n + n) % n]!.id;
}

/** Why a lock ended. `null` means it is still good. */
export type LockBreak = 'gone' | 'dead' | 'range' | null;

/**
 * Should the current lock be dropped?
 *
 * `target` is the candidate matching the locked id, or undefined when it is no
 * longer in the world at all (killed and cleaned up, or streamed away).
 */
export function lockBreakReason(
  target: LockCandidate | undefined,
  px: number, pz: number,
): LockBreak {
  if (target === undefined) return 'gone';
  if (!target.hostile) return 'dead';
  const d = Math.hypot(target.x - px, target.z - pz);
  if (d > LOCK_BREAK_RANGE) return 'range';
  return null;
}

/**
 * 0..1 fade for the on-screen indicator: solid up close, thinning out toward
 * the break range so the player can see a lock is about to be lost rather than
 * having it vanish without warning.
 */
export function indicatorFade(distance: number): number {
  const t = (LOCK_BREAK_RANGE - distance) / (LOCK_BREAK_RANGE - LOCK_ACQUIRE_RANGE);
  return Math.max(0, Math.min(1, t));
}
