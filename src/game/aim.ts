/**
 * aim.ts — where a shot is pointed, and where it will actually land.
 *
 * PURE. No DOM, no GPU, no globals: every world lookup comes in as a callback,
 * so `scripts/test-aim.mts` can assert the geometry in Node. That matters here
 * more than usual, because aiming errors are invisible from inside the game —
 * the arrow leaves, the arrow lands somewhere, and nothing on screen tells you
 * which of the four possible mistakes you just made.
 *
 * ## The four errors, measured
 *
 * The bug report was "extremely hard to aim at anything higher than me, and
 * difficult to know what I am aiming at". Pulling that apart:
 *
 *  1. **The pitch clamp.** 5.7 degrees of upward range against 80 downward.
 *     By far the largest term, and fixed in `camera.ts`, not here.
 *
 *  2. **The camera's ground clamp bending the look direction.** The eye used
 *     to be pushed UP in Y to clear the terrain, after which `lookAt` no
 *     longer pointed along `forward()` — so the screen centre and the ray the
 *     shot used stopped agreeing, worst exactly when pitched up near a slope.
 *     Also fixed in `camera.ts` (the eye is pulled in along the ray instead).
 *
 *  3. **Muzzle parallax.** The arrow launched from the chest on a ray PARALLEL
 *     to the camera. Worth stating precisely, because the obvious intuition is
 *     wrong: the camera eye is displaced from the chest almost entirely ALONG
 *     the view axis (`eye = pivot - forward * distance`), so the perpendicular
 *     miss is only the pivot/chest height difference, ~0.25 m — and being a
 *     parallel offset it is CONSTANT with range, not growing. It is therefore
 *     worst up close (2.8 deg at 5 m, 0.28 deg at 50 m), the same shape as the
 *     breath weapon's dead zone. Real, but small.
 *
 *  4. **Gravity.** `PROJECTILE_GRAVITY` is 9.8 and nothing ever compensated
 *     for it. A full-draw arrow at 36 m/s drops **1.5 m at 20 m and 9.4 m at
 *     50 m**. That is six to thirty-eight times error 3, it grows with the
 *     square of the range, and the player had no indication of it whatsoever.
 *
 * So gravity dominates, and the fix has to be a ballistic solve rather than
 * only a convergence. `aimVelocity` does both at once: it takes the point the
 * player is looking at and returns the launch direction whose ARC passes
 * through it, which subsumes the parallax correction exactly.
 *
 * ## Why compensate rather than draw a drop reticle
 *
 * A ballistic reticle (mark the predicted impact, let the player hold over)
 * is the other honest answer, and it was the first plan. It loses on two
 * counts. It needs a trajectory march plus a world-to-screen projection every
 * frame, in a renderer that already spends 8.5-10.8 ms of an 16.7 ms budget;
 * and a 9.4 m hold-over at 50 m against a moving dragon is not a skill test,
 * it is a guess. Compensating leaves the skills that are actually legible —
 * picking the target, leading it (an arrow still takes 1.4 s to cross 50 m),
 * and drawing far enough that the shot is in range at all — and lets the
 * reticle be a static centred element that costs nothing.
 *
 * Draw power stays meaningful because `aimVelocity` returns null when the
 * target is beyond the ballistic reach of the current draw: a tap-draw at
 * 19 m/s cannot reach past 36.8 m however you point it, and the reticle says
 * so rather than silently lobbing an arrow into the dirt.
 *
 * ## Nothing in here may refuse a shot
 *
 * This module reports; it never decides. There is no target acquisition, no
 * lock-on, no snapping and no magnetism: `rayCreature` hands back a RANGE and
 * `resolveAim` converges on the point of the ray at that range, so a shot two
 * degrees off a deer stays two degrees off it and misses by two degrees. A
 * null from `aimVelocity` means "no arc reaches that", which the caller
 * answers by firing straight at it and letting it fall short — the player can
 * loose at the sky, at a wall, at nothing, or ten metres ahead of a running
 * animal, and it costs them an arrow, which is the correct price and theirs
 * to pay.
 */

/** Matches `PROJECTILE_GRAVITY` in projectiles.ts. Passed in, never imported. */
export interface AimTarget {
  /** Point to converge the shot on, world space. */
  point: readonly [number, number, number];
  /** Straight-line distance from the aim origin. */
  dist: number;
  /** Entity/NPC id when the ray is on a creature, else null. */
  id: string | null;
  /** Display name when known — the reticle labels what it is over. */
  name: string | null;
  /** True when the point came from a creature rather than from terrain. */
  isTarget: boolean;
  /**
   * What the ray actually found. `none` means it ran to `maxDist` without
   * meeting anything — open sky, or the horizon on a level look — and the
   * point is a convergence fallback rather than a place. Callers must not
   * report "out of range" for `none`: there is nothing there to be out of
   * range of, and saying so every time the player looks at the skyline is
   * noise that teaches them to ignore the reticle.
   */
  kind: 'creature' | 'ground' | 'none';
}

/** One candidate the aim ray can land on. */
export interface AimCandidate {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  /** Sphere radius to accept the ray at — use the projectile's own hit radius. */
  radius: number;
}

/**
 * Launch elevation, in radians above horizontal, that lands a projectile of
 * speed `speed` at horizontal range `range` and height difference `rise`.
 *
 * Returns the LOW arc — the flat, fast shot an archer takes. The high arc is a
 * mortar lob: it reaches the same place, takes three times as long, and would
 * make every shot look like a mistake.
 *
 * Returns `null` when the target is out of ballistic reach, which is a real
 * and useful answer: max range is `speed^2 / g`, so a minimum draw (19 m/s)
 * tops out at 36.8 m and a full draw (36 m/s) at 132 m.
 */
export function ballisticElevation(
  speed: number, range: number, rise: number, gravity: number,
): number | null {
  if (speed <= 0) return null;
  // Straight up or straight down: no horizontal component to solve for. The
  // shot is possible iff the arrow carries far enough to climb `rise`.
  if (range < 1e-4) {
    if (rise > 0 && speed * speed < 2 * gravity * rise) return null;
    return rise >= 0 ? Math.PI / 2 : -Math.PI / 2;
  }
  const s2 = speed * speed;
  // disc = s^4 - 2*g*rise*s^2 - g^2*range^2  (see the derivation in the test).
  const disc = s2 * s2 - 2 * gravity * rise * s2 - gravity * gravity * range * range;
  if (disc < 0) return null;
  return Math.atan((s2 - Math.sqrt(disc)) / (gravity * range));
}

/**
 * Unit launch direction that carries a projectile from `from` through `to`.
 *
 * This is the whole aim fix in one function: the direction is derived from the
 * REAL launch point, so muzzle parallax cannot exist, and the elevation is the
 * ballistic solve, so the arc — not the initial ray — passes through the
 * target. Null means "cannot reach", and the caller should say so rather than
 * fire something that was never going to arrive.
 */
export function aimVelocity(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  speed: number,
  gravity: number,
): [number, number, number] | null {
  const hx = to[0] - from[0];
  const hz = to[2] - from[2];
  const rise = to[1] - from[1];
  const range = Math.hypot(hx, hz);
  const theta = ballisticElevation(speed, range, rise, gravity);
  if (theta === null) return null;
  if (range < 1e-4) return [0, rise >= 0 ? 1 : -1, 0];
  const c = Math.cos(theta);
  return [(hx / range) * c, Math.sin(theta), (hz / range) * c];
}

/**
 * First creature the aim ray passes through, and how far along the ray it is.
 *
 * Returns a DISTANCE, never a point to steer toward. That distinction is the
 * whole difference between a readout and an aim assist: the caller converges
 * on the point of the ray at this distance, so a shot two degrees off a deer
 * stays two degrees off it. Converging on the creature's centre instead —
 * which an earlier version did, on the reasoning that the hit test is
 * centre-based — quietly pulled every near-miss inside a metre onto the
 * target. That is magnetism, the player did not ask for it, and it makes
 * leading a moving animal unlearnable because the game keeps correcting you.
 *
 * Closest-approach rather than a true ray/sphere entry point, because the
 * projectile's own hit test is a point-in-sphere check against the centre, so
 * the range that matters is the range at closest approach.
 */
export function rayCreature(
  origin: readonly [number, number, number],
  dir: readonly [number, number, number],
  maxDist: number,
  candidates: readonly AimCandidate[],
): { c: AimCandidate; dist: number } | null {
  let best: AimCandidate | null = null;
  let bestT = maxDist;
  for (const c of candidates) {
    const vx = c.x - origin[0];
    const vy = c.y - origin[1];
    const vz = c.z - origin[2];
    const along = vx * dir[0] + vy * dir[1] + vz * dir[2];
    if (along <= 0 || along >= bestT) continue;
    const d2 = vx * vx + vy * vy + vz * vz;
    // Squared perpendicular leg; `max(0, ...)` guards the on-axis rounding
    // case that would otherwise produce NaN and silently read as a miss.
    const perp2 = Math.max(0, d2 - along * along);
    if (perp2 > c.radius * c.radius) continue;
    best = c;
    bestT = along;
  }
  return best === null ? null : { c: best, dist: bestT };
}

/**
 * Where the aim ray meets the ground, or null if it never does inside
 * `maxDist` (looking at the sky).
 *
 * Coarse march then a bisection refine. The coarse step can step OVER a thin
 * ridge, which for an aim point is a cosmetic error of a metre or two at
 * range and not worth the samples to chase — but it must not step over the
 * ground right in front of the player, so the step starts small and grows.
 */
export function rayGround(
  origin: readonly [number, number, number],
  dir: readonly [number, number, number],
  maxDist: number,
  heightAt: (x: number, z: number) => number,
): { point: [number, number, number]; dist: number } | null {
  // Already underground (camera clipped into a hill): no useful answer.
  if (origin[1] < heightAt(origin[0], origin[2])) return null;
  let prevT = 0;
  let t = 0;
  let step = 1;
  while (t < maxDist) {
    prevT = t;
    t = Math.min(maxDist, t + step);
    step = Math.min(8, step * 1.35);
    const y = origin[1] + dir[1] * t;
    if (y > heightAt(origin[0] + dir[0] * t, origin[2] + dir[2] * t)) continue;
    // Crossed between prevT and t — bisect to a few centimetres.
    let lo = prevT;
    let hi = t;
    for (let i = 0; i < 12; i++) {
      const m = (lo + hi) * 0.5;
      const my = origin[1] + dir[1] * m;
      if (my > heightAt(origin[0] + dir[0] * m, origin[2] + dir[2] * m)) lo = m;
      else hi = m;
    }
    return {
      point: [origin[0] + dir[0] * hi, origin[1] + dir[1] * hi, origin[2] + dir[2] * hi],
      dist: hi,
    };
  }
  return null;
}

/**
 * What the crosshair is over: a creature if the ray touches one, else the
 * ground, else a point far down the ray so a shot at the open sky still has
 * somewhere to converge.
 *
 * `origin` is the CAMERA EYE and `dir` is the camera forward, because the
 * crosshair is screen centre and screen centre is that ray — not the player's
 * chest. The chest only ever appears as the launch point in `aimVelocity`.
 */
export function resolveAim(
  origin: readonly [number, number, number],
  dir: readonly [number, number, number],
  candidates: readonly AimCandidate[],
  heightAt: (x: number, z: number) => number,
  maxDist = 160,
): AimTarget {
  const hit = rayCreature(origin, dir, maxDist, candidates);
  const ground = rayGround(origin, dir, hit === null ? maxDist : hit.dist, heightAt);
  if (hit !== null && (ground === null || ground.dist > hit.dist)) {
    // ON THE RAY at the creature's range — deliberately not the creature's
    // own centre. The creature supplies the RANGE (so the drop is solved for
    // where the target actually is) and nothing else; the lateral aim stays
    // exactly where the player pointed it. See `rayCreature`.
    return {
      point: [
        origin[0] + dir[0] * hit.dist,
        origin[1] + dir[1] * hit.dist,
        origin[2] + dir[2] * hit.dist,
      ],
      dist: hit.dist,
      id: hit.c.id,
      name: hit.c.name,
      isTarget: true,
      kind: 'creature',
    };
  }
  if (ground !== null) {
    return {
      point: ground.point, dist: ground.dist,
      id: null, name: null, isTarget: false, kind: 'ground',
    };
  }
  // Open sky. Converge far enough out that the residual parallax is
  // negligible; there is nothing at that point to be wrong about anyway.
  return {
    point: [
      origin[0] + dir[0] * maxDist,
      origin[1] + dir[1] * maxDist,
      origin[2] + dir[2] * maxDist,
    ],
    dist: maxDist,
    id: null,
    name: null,
    isTarget: false,
    kind: 'none',
  };
}
