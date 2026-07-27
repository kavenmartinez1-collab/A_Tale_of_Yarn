/**
 * parry-fx.ts — the thread-spark: what a parry looks like.
 *
 * ## WHY THIS RIDES FireFX AND HAS NO PIPELINE OF ITS OWN
 *
 * The same reason `bolt-fx.ts` does, and it is worth restating rather than
 * pointing at, because "add a pipeline" is the default answer and it is the
 * wrong one here. `FireFX.strand` already draws a bright additive billboard
 * stretched along an arbitrary axis, into the HDR target, before post, so it
 * feeds bloom; depth-TESTED and never depth-writing. A spark is a short bright
 * line. There is nothing left to build. A second pipeline would have meant a
 * second bind-group set, a second pass in `renderer.ts`, and — the part that
 * actually bites — a decision about a shadow pipeline for geometry that must
 * never cast one.
 *
 * ## THE LOOK
 *
 * Not a shower of white sparks off steel. This world is knitted
 * (project_art_direction_yarn), the bolt is a couched seam and the reticle is a
 * running stitch, so a parry is a SEAM POPPING: a dozen short threads flung out
 * of the point of impact, thread-cream at the tips and woad-indigo in the wash,
 * each one stretched along its own direction of travel and thinning as it goes.
 * It reads as "something came apart at the stitching", which is the right
 * sentence for a blow turned aside by a shield made of boards and yarn.
 *
 * Three of the bolt's four layers, reused unchanged so the two effects are
 * visibly the same hand:
 *
 *   GLOW  a soft indigo wash, wide and short-lived. This is what bloom has area
 *         to work with — the lesson the wyvern's spark spray paid for is that a
 *         hairline has almost none and reads as dim no matter how bright it is.
 *   CORE  the threads themselves, thread-cream, tapering.
 *   KNOT  one French knot at the impact point, the same motif as the middle of
 *         the reticle and the kinks in the bolt.
 *
 * ## TIME
 *
 * `ageS` is SIM seconds since the parry, supplied by the caller. There is no
 * clock here: a paused game must freeze the burst mid-flight rather than
 * finding it finished on resume, and the only way to be certain of that is to
 * have no way to ask what time it is.
 *
 * DETERMINISM: `mix32` off the caller's seed, never `Math.random`.
 */

import { mix32 } from '../dungeon/dungeon-layout';
import type { FireFX } from './fire-fx';

/** Layer ids, shared with the bolt — see `flame.wgsl`'s bolt branch. */
const L_GLOW = 0;
const L_CORE = 2;
const L_KNOT = 3;

/** Seconds the burst lives. Short: a parry is an instant, not an explosion. */
export const PARRY_SPARK_S = 0.34;

/** How many threads fly. */
const THREADS = 12;

/** How far the furthest thread travels, metres. */
const REACH = 0.55;

/**
 * Queue one parry burst.
 *
 * `x/y/z` is the impact point — the shield boss, which the caller computes from
 * the player's own position and facing rather than from the attacker, because
 * the blow was stopped AT THE SHIELD and that is where the seam pops.
 *
 * Returns the number of billboards queued (0 once the burst is over), which is
 * what lets a harness prove the effect actually fired rather than trusting that
 * a call was made.
 */
export function emitParrySpark(
  fx: FireFX,
  x: number, y: number, z: number,
  ageS: number,
  seed: number,
): number {
  if (ageS < 0 || ageS >= PARRY_SPARK_S) return 0;
  const t = ageS / PARRY_SPARK_S;
  // Fast out, slow down — a spark decelerates against the air almost at once.
  const travel = 1 - (1 - t) * (1 - t);
  // Everything fades on the same curve, cubed so the tail is quick and the
  // burst does not linger as a smudge.
  const fade = (1 - t) * (1 - t) * (1 - t);
  let n = 0;

  // The knot at the point of contact: brightest at t=0, gone by a third of the
  // life. It is what makes the burst read as having a SOURCE rather than as a
  // dozen unrelated streaks.
  if (t < 0.34) {
    const k = 1 - t / 0.34;
    fx.strand(x, y, z, 0.055 + 0.05 * (1 - k), 0, 1, 0,
      0.055 + 0.05 * (1 - k), L_KNOT, 0, 26 * k, seed);
    n++;
  }

  for (let i = 0; i < THREADS; i++) {
    // A direction on the unit sphere, biased toward the player's front by the
    // caller's choice of `y` — this is deliberately isotropic here because the
    // shield is a flat board and a seam popping throws thread every way.
    const h = mix32(seed, i * 977);
    const a = (h & 0xffff) / 0xffff * Math.PI * 2;
    const c = ((h >>> 16) / 0xffff) * 2 - 1;      // cos(polar), uniform
    const s = Math.sqrt(Math.max(0, 1 - c * c));
    const dx = Math.cos(a) * s;
    const dy = c * 0.55 + 0.25;                    // lifted, then it falls
    const dz = Math.sin(a) * s;
    const dl = Math.hypot(dx, dy, dz) || 1;

    // Each thread has its own length so the burst is ragged rather than a
    // starburst of identical spokes.
    const len = REACH * (0.45 + ((mix32(seed, i * 31 + 7) >>> 8) / 0xffffff) * 0.55);
    const dist = travel * len;
    const px = x + (dx / dl) * dist;
    const py = y + (dy / dl) * dist - t * t * 0.18; // gravity on the tail
    const pz = z + (dz / dl) * dist;

    // Wash first so the core sits on top of it.
    fx.strand(px, py, pz, 0.075, dx / dl, dy / dl, dz / dl,
      0.055, L_GLOW, 0.5, 9 * fade, seed ^ (i * 13));
    // The thread. Half-length grows a little as it flies, which is what turns a
    // dot into a streak; half-width shrinks, which is what makes it a thread.
    fx.strand(px, py, pz, 0.05 + 0.055 * travel, dx / dl, dy / dl, dz / dl,
      0.013 * (1 - t * 0.6), L_CORE, 0.8, 34 * fade, seed ^ (i * 7919));
    n += 2;
  }
  return n;
}
