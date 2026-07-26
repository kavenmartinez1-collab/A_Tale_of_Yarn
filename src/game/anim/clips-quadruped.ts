/**
 * clips-quadruped.ts — the clip library for the seven four-legged species
 * (rabbit, deer, cow, wolf, bear, horse, donkey).
 *
 * WHAT IS ACTUALLY VISIBLE TODAY
 *
 * A quadruped builder reads exactly three of the channels this library
 * authors: `WalkAmp` (drives the whole planted-foot gait), `HeadYaw` (twists
 * everything downstream of the head pivot) and `BodySink` (which the renderer
 * folds into the object offset). `HeadPitch` and `TailSway` are authored
 * throughout and currently go nowhere — see `CH_PLUMBED` in `clip.ts` and the
 * two pose fields requested in the handover.
 *
 * That constraint shapes the authoring, and it is worth being explicit about
 * rather than pretending otherwise: every clip below has to make its point
 * using stride amplitude, head turn and body height alone. So `attack` is a
 * crouch-and-lunge in `BodySink` with a bite-shake in `HeadYaw`, not a jaw
 * animation, because a wolf has no jaw joint. `graze` is a low sweeping head
 * scan, because head PITCH — the part that would actually put the muzzle in the
 * grass — has nowhere to go yet. When those two fields land, the head-down and
 * tail channels already written here start working with no edit to this file.
 *
 * `WalkAmp` semantics for a planted body plan: this is a GATE on the
 * speed-derived stride amplitude, not the amplitude itself. `walk` authoring
 * 1.0 means "use however much stride the creature's actual ground speed calls
 * for"; `graze` authoring 0.3 means "even if it is moving, mince". The driver
 * multiplies the two and derives gait phase from the product, which is what
 * keeps planted feet planted at every amplitude (see `creature-anim.ts`).
 */

import { Ch, Ease, type Clip } from './clip';
import {
  hold, layerClip, loopClip, shotClip, sine, type ClipSet,
} from './clip-set';
import { track } from './clip';

// ---------------------------------------------------------------------------
// Standing / resting
// ---------------------------------------------------------------------------

/**
 * Idle — standing, scanning.
 *
 * The head sweep is deliberately slow (one pass every 7 s) and asymmetric: a
 * pure sine reads as a metronome. The extra key at 4.4 s holds the head off
 * to one side longer than the other, which is the cheapest possible
 * approximation of an animal actually looking at something.
 */
const idle = loopClip('q_idle', 7, [
  hold(Ch.WalkAmp, 0, 7),
  track(Ch.HeadYaw, [
    [0, 0], [1.6, 0.34], [3.1, 0.05], [4.4, -0.30], [5.6, -0.26], [7, 0],
  ]),
  hold(Ch.BodySink, 0, 7),
]);

/**
 * Alert — frozen, head up, locked on whatever it has noticed.
 *
 * The defining feature is what it does NOT do: no head sweep at all. A
 * scanning animal has not seen you; a still one has. Holding perfectly still
 * is the read, and it is the reason `alert` cannot simply be `idle` with a
 * shorter head amplitude.
 */
const alert = loopClip('q_alert', 2.4, [
  hold(Ch.WalkAmp, 0, 2.4),
  hold(Ch.HeadYaw, 0, 2.4),
  hold(Ch.HeadPitch, -0.28, 2.4),   // head up (pending headPitch)
  hold(Ch.TailSway, 0.22, 2.4),     // tail raised (pending tailSway)
  hold(Ch.BodySink, -0.012, 2.4),   // up on the toes
]);

/** Grazing — head down, cropping, shuffling forward a few centimetres a time. */
const graze = loopClip('q_graze', 5.2, [
  hold(Ch.WalkAmp, 0.30, 5.2),
  track(Ch.HeadYaw, [
    [0, 0], [1.3, 0.30], [2.6, 0], [3.9, -0.30], [5.2, 0],
  ]),
  hold(Ch.HeadPitch, 0.78, 5.2),    // muzzle to the ground (pending headPitch)
  hold(Ch.BodySink, 0.035, 5.2),
]);

/** Sitting — haunches down, still, head level. */
const sit = loopClip('q_sit', 4, [
  hold(Ch.WalkAmp, 0, 4),
  track(Ch.HeadYaw, [[0, 0], [1.7, 0.16], [3.0, -0.13], [4, 0]]),
  hold(Ch.BodySink, 0.44, 4),
  hold(Ch.TailSway, 0.06, 4),
]);

/** Asleep — lower than sitting, head tucked, nothing moving. */
const sleep = loopClip('q_sleep', 6, [
  hold(Ch.WalkAmp, 0, 6),
  hold(Ch.HeadYaw, 0.42, 6),        // head turned back onto the flank
  hold(Ch.HeadPitch, 0.55, 6),
  hold(Ch.BodySink, 0.54, 6),
  hold(Ch.TailSway, 0, 6),
]);

// ---------------------------------------------------------------------------
// Locomotion
// ---------------------------------------------------------------------------

/** Walking — full stride gate, head steady and forward. */
const walk = loopClip('q_walk', 2, [
  hold(Ch.WalkAmp, 1, 2),
  sine(Ch.HeadYaw, 0.06, 1, 2),     // slight lead-in to each step
  hold(Ch.HeadPitch, 0.06, 2),
  sine(Ch.TailSway, 0.10, 2, 2),
  hold(Ch.BodySink, 0, 2),
]);

/** Running — head lower and forward, tail streaming, no head turn at all. */
const run = loopClip('q_run', 1.4, [
  hold(Ch.WalkAmp, 1, 1.4),
  hold(Ch.HeadYaw, 0, 1.4),
  hold(Ch.HeadPitch, 0.16, 1.4),
  sine(Ch.TailSway, 0.18, 2, 1.4),
  hold(Ch.BodySink, 0.02, 1.4),
]);

/**
 * Fleeing — a run with the head twisted back to check the threat.
 *
 * That backward glance is the single cue that separates fleeing from running,
 * and it is one of the few things a quadruped CAN express today, since
 * `headYaw` is plumbed. It alternates sides so it does not read as a stuck
 * neck.
 */
const flee = loopClip('q_flee', 1.8, [
  hold(Ch.WalkAmp, 1, 1.8),
  track(Ch.HeadYaw, [
    [0, 0], [0.5, 0.52, Ease.Out], [0.9, 0], [1.35, -0.46, Ease.Out], [1.8, 0],
  ]),
  hold(Ch.HeadPitch, 0.10, 1.8),
  sine(Ch.TailSway, 0.24, 3, 1.8),
  hold(Ch.BodySink, 0.03, 1.8),
]);

// ---------------------------------------------------------------------------
// Attack
// ---------------------------------------------------------------------------

/**
 * Attack — crouch, lunge, bite, recover. One-shot, 0.52 s.
 *
 * This is the clip the whole system exists for, and it is worth reading the
 * key timings as a piece of animation rather than as data:
 *
 *   0.00 -> 0.16  WINDUP.  Body sinks 9% of shoulder height and the head cocks
 *                 to one side. Eased SMOOTH, so it settles rather than snaps —
 *                 the pause before a strike is what makes the strike readable.
 *   0.16 -> 0.27  STRIKE.  Body drives up and forward past its rest height
 *                 (negative sink) while the head whips through centre. Eased
 *                 IN — accelerating into the contact, which is the only easing
 *                 that reads as force rather than as travel.
 *   0.27 -> 0.38  FOLLOW THROUGH. Head over-rotates the other way; jaw peaks
 *                 slightly AFTER the body does, so the bite lags the lunge.
 *   0.38 -> 0.52  RECOVER. Eased OUT back to neutral, slower than the strike.
 *
 * Windup slow, strike fast, recovery medium is the shape `chopAt` already used
 * for the player's axe, and it is here for the same reason: symmetric timing
 * reads as a machine, not an animal.
 *
 * `WalkAmp` drops to zero throughout because the AI genuinely stops moving to
 * bite (`animal-ai.ts` skips `moveToward` inside attack range), and legs still
 * scissoring under a stationary body is the exact defect the amplitude gate
 * exists to prevent.
 */
const attack = shotClip('q_attack', 0.52, [
  track(Ch.WalkAmp, [[0, 0], [0.52, 0]]),
  track(Ch.HeadYaw, [
    [0, 0], [0.16, 0.30, Ease.Smooth], [0.27, -0.10, Ease.In],
    [0.38, -0.22, Ease.Out], [0.52, 0, Ease.Out],
  ]),
  track(Ch.HeadPitch, [
    [0, 0], [0.16, -0.22, Ease.Smooth], [0.27, 0.34, Ease.In],
    [0.52, 0, Ease.Out],
  ]),
  track(Ch.JawOpen, [
    [0, 0], [0.16, 0.55, Ease.Smooth], [0.30, 0.95, Ease.In],
    [0.40, 0.15, Ease.Out], [0.52, 0, Ease.Out],
  ]),
  track(Ch.BodySink, [
    [0, 0], [0.16, 0.09, Ease.Smooth], [0.27, -0.075, Ease.In],
    [0.38, 0.02, Ease.Out], [0.52, 0, Ease.Out],
  ]),
  track(Ch.TailSway, [
    [0, 0], [0.16, -0.30, Ease.Smooth], [0.30, 0.40, Ease.In], [0.52, 0, Ease.Out],
  ]),
]);

// ---------------------------------------------------------------------------
// Dead
// ---------------------------------------------------------------------------

/**
 * Dead — everything at rest. Not merely `idle`: a corpse must be flat, and the
 * driver additionally removes the additive layer, because a breathing corpse is
 * worse than a rigid one.
 */
const dead = loopClip('q_dead', 1, [
  hold(Ch.WalkAmp, 0, 1),
  hold(Ch.HeadYaw, 0, 1),
  hold(Ch.HeadPitch, 0, 1),
  hold(Ch.BodySink, 0, 1),
  hold(Ch.TailSway, 0, 1),
]);

// ---------------------------------------------------------------------------
// Additive idle layer
// ---------------------------------------------------------------------------

/**
 * The always-on layer: breathing, micro-drift of the head, idle tail.
 *
 * Additive rather than absolute so it composes with everything — a grazing
 * animal breathes, a fleeing one breathes harder, an attacking one keeps its
 * tail alive through the lunge. Absolute clips would each have to re-author it,
 * and any clip that forgot would produce a creature that stops breathing when
 * it changes its mind.
 *
 * The cycle counts (3 / 1 / 2 / 5 over a 12 s loop) are deliberately different
 * primes-ish so the channels never line up into a single obvious pulse, while
 * all still closing exactly at 12 s. Every component is generated by `sine()`,
 * which guarantees the mean is zero — an additive layer with a DC offset would
 * slowly push the head permanently off-centre, and the resting pose would drift
 * away from the one the clip author actually placed.
 */
const layer = layerClip('q_idle_layer', 12, [
  sine(Ch.BodySink, 0.009, 3, 12),        // breathing: 0.25 Hz
  sine(Ch.HeadYaw, 0.13, 1, 12, 0.37),    // slow drift
  sine(Ch.HeadPitch, 0.05, 2, 12, 0.11),
  sine(Ch.TailSway, 0.15, 5, 12, 0.63),
]);

// ---------------------------------------------------------------------------

export const QUADRUPED_CLIPS: ClipSet = {
  name: 'quadruped',
  clips: { idle, walk, run, graze, sit, sleep, alert, attack, flee, dead },
  idleLayer: layer,
};

/** Every clip in the set, for validation sweeps. */
export const QUADRUPED_ALL: readonly Clip[] = [
  idle, walk, run, graze, sit, sleep, alert, attack, flee, dead, layer,
];
