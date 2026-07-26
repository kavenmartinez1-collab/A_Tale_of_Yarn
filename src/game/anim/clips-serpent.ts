/**
 * clips-serpent.ts — clip library for the sea serpent.
 *
 * THE SERPENT HAS ONE CHANNEL
 *
 * `buildSeaSerpent` reads `walkPhase` and `walkAmp` and nothing else. Its head
 * is built with an empty rotation chain, so `headYaw` is a silent no-op; it has
 * no wings, no jaw and no legs, so `flapAmp`, `jawOpen` and `bodyDrop` are all
 * ignored too. Every clip below therefore says what it has to say through
 * undulation amplitude alone, plus `BodySink` which the renderer applies as an
 * object offset and so works for any body plan.
 *
 * That is a harsh constraint, and it is also why the serpent is the clearest
 * demonstration of why the amplitude/phase split in `clip.ts` matters. With one
 * usable channel, the ONLY way to make a serpent read as calm rather than
 * frantic is to change the amplitude smoothly — and the only way to change
 * amplitude smoothly without the body snapping to a new waveform is to leave
 * the phase integrating underneath. A system that animated phase directly could
 * not make this creature move convincingly at all.
 *
 * A SERPENT AT REST STILL MOVES
 *
 * `idle` is authored at 0.22 rather than 0, and the driver gives the serpent a
 * non-zero free-running cycle rate so the phase advances even when the creature
 * is stationary. A serpent holding perfectly still reads as a length of rope. A
 * real one at rest still rides the swell.
 */

import { Ch, Ease, track, type Clip } from './clip';
import {
  hold, layerClip, loopClip, shotClip, sine, type ClipSet,
} from './clip-set';

/** At rest — riding the swell. */
const s_idle = loopClip('s_idle', 6, [
  hold(Ch.WalkAmp, 0.22, 6),
  hold(Ch.BodySink, 0, 6),
]);

/**
 * Alert — coiled and nearly still.
 *
 * Lower amplitude than idle, which is counter-intuitive until you watch a
 * snake: the moment it commits to a target it stops the idle sway, because the
 * sway is what would give away its position. Stillness is the tell.
 */
const s_alert = loopClip('s_alert', 3, [
  hold(Ch.WalkAmp, 0.10, 3),
  hold(Ch.BodySink, -0.02, 3),
]);

/** Cruising. */
const s_walk = loopClip('s_walk', 3, [
  hold(Ch.WalkAmp, 0.58, 3),
  hold(Ch.BodySink, 0, 3),
]);

/** Driving hard. */
const s_run = loopClip('s_run', 2, [
  hold(Ch.WalkAmp, 0.96, 2),
  hold(Ch.BodySink, 0.01, 2),
]);

const s_flee = loopClip('s_flee', 1.6, [
  hold(Ch.WalkAmp, 0.96, 1.6),
  hold(Ch.BodySink, 0.02, 1.6),
]);

/**
 * Strike — the coil-and-lash. One-shot, 0.48 s.
 *
 * Amplitude collapses almost to nothing for the windup (the coil), then spikes
 * past full and overshoots on the way back. Eased `In` on the strike so it
 * accelerates into the lunge and `Out` on the settle. This is a whole attack
 * animation written on one channel, which is the point.
 */
const s_attack = shotClip('s_attack', 0.48, [
  track(Ch.WalkAmp, [
    [0, 0.20], [0.15, 0.04, Ease.Smooth], [0.26, 0.96, Ease.In],
    [0.36, 0.45, Ease.Out], [0.48, 0.22, Ease.Out],
  ]),
  track(Ch.BodySink, [
    [0, 0], [0.15, 0.05, Ease.Smooth], [0.26, -0.07, Ease.In], [0.48, 0, Ease.Out],
  ]),
]);

/** Feeding — slow, low, working at something. */
const s_graze = loopClip('s_graze', 4, [
  hold(Ch.WalkAmp, 0.16, 4),
  hold(Ch.BodySink, 0.04, 4),
]);

const s_sit = loopClip('s_sit', 5, [
  hold(Ch.WalkAmp, 0.09, 5),
  hold(Ch.BodySink, 0.20, 5),
]);

const s_sleep = loopClip('s_sleep', 9, [
  hold(Ch.WalkAmp, 0.06, 9),
  hold(Ch.BodySink, 0.26, 9),
]);

const s_dead = loopClip('s_dead', 1, [
  hold(Ch.WalkAmp, 0, 1),
  hold(Ch.BodySink, 0, 1),
]);

/**
 * Additive layer.
 *
 * Small and slow. The serpent's absolute clips already keep it moving, so the
 * layer's job is only to stop two serpents at the same amplitude from looking
 * like copies of each other — which the per-entity hash phase offset does, and
 * which is most of the value here.
 */
const s_layer = layerClip('s_idle_layer', 10, [
  sine(Ch.WalkAmp, 0.035, 1, 10),
  sine(Ch.BodySink, 0.010, 2, 10, 0.33),
]);

export const SERPENT_CLIPS: ClipSet = {
  name: 'serpent',
  clips: {
    idle: s_idle, walk: s_walk, run: s_run, graze: s_graze, sit: s_sit,
    sleep: s_sleep, alert: s_alert, attack: s_attack, flee: s_flee,
    dead: s_dead,
  },
  idleLayer: s_layer,
};

export const SERPENT_ALL: readonly Clip[] = [
  s_idle, s_walk, s_run, s_graze, s_sit, s_sleep, s_alert, s_attack, s_flee,
  s_dead, s_layer,
];
