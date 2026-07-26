/**
 * clips-winged.ts — clip libraries for the flying body plans.
 *
 * TWO SETS, BECAUSE THERE ARE TWO WINGED RIGS AND THEY DISAGREE
 *
 * `WINGED_CLIPS` serves dragon and griffin, whose builders read `flapPhase` and
 * `flapAmp` — a real, independent wing channel that beats whether or not the
 * creature is moving.
 *
 * `BIRD_CLIPS` serves the bird, whose builder does NOT. `buildBird` hardwires
 * its wing raise to `sin(walkPhase) * walkAmp`; `flapPhase` and `flapAmp` are
 * silently ignored. So for a bird, `Ch.WalkAmp` IS the wing amplitude, and its
 * clips are authored on that channel instead. This is a rig limitation, not a
 * design choice — it is the first item in the handover's list of requested mesh
 * changes, and the day the bird reads `flapAmp` this set collapses into the
 * other one.
 *
 * The consequence worth knowing: a bird's `WalkAmp` must NOT be treated as a
 * planted-foot stride gate. Bird legs have an empty rotation chain — they never
 * animate at all — so there is no ground-contact contract to honour and the
 * driver classifies the bird as a free-phase plan.
 *
 * BIRD HEAD MOTION IS STEPPED ON PURPOSE
 *
 * Every bird head track uses `Ease.Step`. Birds do not pan their heads; they
 * hold a heading, then jump to a new one in well under a frame. Interpolating
 * that motion smoothly is the single most common tell of a programmer-authored
 * bird, and `Ease.Step` exists in the easing enum specifically for this.
 */

import { Ch, Ease, track, type Clip } from './clip';
import {
  hold, layerClip, loopClip, shotClip, sine, type ClipSet,
} from './clip-set';

// ===========================================================================
// DRAGON / GRIFFIN
// ===========================================================================

/**
 * Idle — grounded, wings loosely settling, slow breathing through the jaw.
 *
 * `FlapAmp 0.30` at `FlapRate 0.70` keeps a resting dragon's wings alive
 * without reading as an attempt to take off. A perfectly still dragon looks
 * dead; a fully beating one looks like it is about to leave.
 */
const w_idle = loopClip('w_idle', 8, [
  hold(Ch.WalkAmp, 0, 8),
  hold(Ch.FlapAmp, 0.30, 8),
  hold(Ch.FlapRate, 0.70, 8),
  track(Ch.HeadYaw, [[0, 0], [2.1, 0.40], [4.0, -0.12], [6.0, -0.36], [8, 0]]),
  track(Ch.JawOpen, [[0, 0.02], [2, 0.13], [4, 0.02], [6, 0.13], [8, 0.02]]),
  hold(Ch.BodySink, 0, 8),
]);

/** Alert — wings half-spread and held, head locked, jaw shut. */
const w_alert = loopClip('w_alert', 3, [
  hold(Ch.WalkAmp, 0, 3),
  hold(Ch.FlapAmp, 0.52, 3),
  hold(Ch.FlapRate, 0.95, 3),
  hold(Ch.HeadYaw, 0, 3),
  hold(Ch.HeadPitch, -0.30, 3),
  hold(Ch.JawOpen, 0, 3),
  hold(Ch.BodySink, -0.02, 3),
]);

/** Walking on the ground — wings folded low, slow. */
const w_walk = loopClip('w_walk', 2.4, [
  hold(Ch.WalkAmp, 1, 2.4),
  hold(Ch.FlapAmp, 0.13, 2.4),
  hold(Ch.FlapRate, 0.55, 2.4),
  sine(Ch.HeadYaw, 0.10, 1, 2.4),
  hold(Ch.BodySink, 0, 2.4),
]);

/** Charging on the ground — wings out for balance. */
const w_run = loopClip('w_run', 1.5, [
  hold(Ch.WalkAmp, 1, 1.5),
  hold(Ch.FlapAmp, 0.46, 1.5),
  hold(Ch.FlapRate, 1.20, 1.5),
  hold(Ch.HeadYaw, 0, 1.5),
  hold(Ch.HeadPitch, 0.14, 1.5),
  hold(Ch.BodySink, 0.02, 1.5),
]);

/** Powered flight — full beat, body riding the downstroke. */
const w_flap = loopClip('w_flap', 2, [
  hold(Ch.WalkAmp, 0, 2),
  hold(Ch.FlapAmp, 0.95, 2),
  hold(Ch.FlapRate, 1.35, 2),
  hold(Ch.HeadYaw, 0, 2),
  hold(Ch.HeadPitch, -0.08, 2),
  hold(Ch.BodySink, 0, 2),
]);

/**
 * Glide — wings held, barely moving.
 *
 * `FlapRate 0.30` rather than `FlapAmp 0` because the dragon's wing pose is
 * `0.46 + sin(flapPhase) * flapAmp * 0.50`: killing the amplitude outright
 * snaps the wings to a fixed mid-raise, whereas a small amplitude at a slow
 * rate gives the long, lazy trim adjustments a gliding animal actually makes.
 */
const w_glide = loopClip('w_glide', 4, [
  hold(Ch.WalkAmp, 0, 4),
  hold(Ch.FlapAmp, 0.12, 4),
  hold(Ch.FlapRate, 0.30, 4),
  track(Ch.HeadYaw, [[0, 0], [1.4, 0.24], [2.6, -0.20], [4, 0]]),
  hold(Ch.BodySink, -0.02, 4),
]);

/**
 * Landing — one-shot flare. Wings beat hard and slow to kill speed, the body
 * settles, then everything relaxes.
 */
const w_land = shotClip('w_land', 1.0, [
  track(Ch.WalkAmp, [[0, 0], [1.0, 0]]),
  track(Ch.FlapAmp, [
    [0, 0.9], [0.30, 0.95, Ease.Out], [0.70, 0.35, Ease.Smooth], [1.0, 0.22],
  ]),
  track(Ch.FlapRate, [
    [0, 1.5], [0.35, 0.85, Ease.Out], [1.0, 0.60, Ease.Smooth],
  ]),
  track(Ch.BodySink, [
    [0, -0.06], [0.42, 0.11, Ease.In], [0.72, -0.01, Ease.Out], [1.0, 0],
  ]),
  track(Ch.HeadPitch, [[0, -0.22], [0.45, 0.12, Ease.In], [1.0, 0, Ease.Out]]),
]);

/** Fleeing — hard beat, head checking back. */
const w_flee = loopClip('w_flee', 1.8, [
  hold(Ch.WalkAmp, 1, 1.8),
  hold(Ch.FlapAmp, 0.85, 1.8),
  hold(Ch.FlapRate, 1.35, 1.8),
  track(Ch.HeadYaw, [
    [0, 0], [0.5, 0.48, Ease.Out], [0.95, 0], [1.4, -0.42, Ease.Out], [1.8, 0],
  ]),
  hold(Ch.BodySink, 0.02, 1.8),
]);

/**
 * Attack — rear back, wings snap, head drives forward with the jaw.
 *
 * The dragon is the one species where the jaw actually moves, so unlike the
 * quadruped attack this clip can put its emphasis there. The wing beat spikes
 * at the windup, not at the strike: the wings are what lifts the creature into
 * the bite, so they lead it. Peaking them on contact would read as flapping
 * about after the fact.
 */
const w_attack = shotClip('w_attack', 0.62, [
  track(Ch.WalkAmp, [[0, 0], [0.62, 0]]),
  track(Ch.FlapAmp, [
    [0, 0.35], [0.18, 0.95, Ease.Smooth], [0.34, 0.55, Ease.In],
    [0.62, 0.30, Ease.Out],
  ]),
  track(Ch.FlapRate, [[0, 1.0], [0.18, 1.9, Ease.Smooth], [0.62, 0.9, Ease.Out]]),
  track(Ch.JawOpen, [
    [0, 0], [0.20, 0.70, Ease.Smooth], [0.34, 0.94, Ease.In],
    [0.46, 0.12, Ease.Out], [0.62, 0, Ease.Out],
  ]),
  track(Ch.HeadPitch, [
    [0, 0], [0.20, -0.34, Ease.Smooth], [0.34, 0.38, Ease.In],
    [0.62, 0, Ease.Out],
  ]),
  track(Ch.HeadYaw, [
    [0, 0], [0.20, 0.22, Ease.Smooth], [0.36, -0.14, Ease.In], [0.62, 0, Ease.Out],
  ]),
  track(Ch.BodySink, [
    [0, 0], [0.20, 0.07, Ease.Smooth], [0.34, -0.09, Ease.In],
    [0.62, 0, Ease.Out],
  ]),
]);

/** Feeding — head down, jaw working. */
const w_graze = loopClip('w_graze', 3.2, [
  hold(Ch.WalkAmp, 0, 3.2),
  hold(Ch.FlapAmp, 0.12, 3.2),
  hold(Ch.FlapRate, 0.5, 3.2),
  hold(Ch.HeadPitch, 0.62, 3.2),
  track(Ch.JawOpen, [
    [0, 0.05], [0.4, 0.42], [0.8, 0.05], [1.2, 0.42], [1.6, 0.05],
    [2.0, 0.42], [2.4, 0.05], [2.8, 0.34], [3.2, 0.05],
  ]),
  track(Ch.HeadYaw, [[0, 0], [1.6, 0.20], [3.2, 0]]),
  hold(Ch.BodySink, 0.04, 3.2),
]);

/** Settled — wings folded, body down. */
const w_sit = loopClip('w_sit', 5, [
  hold(Ch.WalkAmp, 0, 5),
  hold(Ch.FlapAmp, 0.05, 5),
  hold(Ch.FlapRate, 0.4, 5),
  track(Ch.HeadYaw, [[0, 0], [2.1, 0.18], [3.6, -0.15], [5, 0]]),
  hold(Ch.BodySink, 0.40, 5),
]);

const w_sleep = loopClip('w_sleep', 7, [
  hold(Ch.WalkAmp, 0, 7),
  hold(Ch.FlapAmp, 0.05, 7),
  hold(Ch.FlapRate, 0.25, 7),
  hold(Ch.HeadYaw, 0.44, 7),
  hold(Ch.HeadPitch, 0.50, 7),
  hold(Ch.JawOpen, 0, 7),
  hold(Ch.BodySink, 0.50, 7),
]);

const w_dead = loopClip('w_dead', 1, [
  hold(Ch.WalkAmp, 0, 1),
  hold(Ch.FlapAmp, 0, 1),
  hold(Ch.FlapRate, 0.20, 1),
  hold(Ch.HeadYaw, 0, 1),
  hold(Ch.JawOpen, 0, 1),
  hold(Ch.BodySink, 0, 1),
]);

/**
 * Winged additive layer.
 *
 * Note what is NOT here: a jaw component. Breath through the jaw sounds like an
 * obvious thing to layer, but `jawOpen` is bounded at zero and half the winged
 * clips author it AT zero — so a mean-zero additive sine would spend half its
 * cycle hinging the jaw backwards through the skull. Jaw breathing is authored
 * into the individual clips that want it (`w_idle`, `w_graze`) instead, where
 * it can be one-sided without breaking the layer's zero-mean property.
 *
 * This is the general rule for additive layers on a channel with a hard floor
 * at its resting value: they cannot be both mean-zero and in range, so the
 * motion belongs in the absolute clip.
 */
const w_layer = layerClip('w_idle_layer', 12, [
  sine(Ch.BodySink, 0.011, 2, 12),        // big lungs, slow: 0.17 Hz
  sine(Ch.HeadYaw, 0.11, 1, 12, 0.29),
  sine(Ch.HeadPitch, 0.06, 2, 12, 0.53),
  sine(Ch.FlapAmp, 0.045, 3, 12, 0.17),   // wings never perfectly still
  sine(Ch.TailSway, 0.20, 3, 12, 0.71),
]);

export const WINGED_CLIPS: ClipSet = {
  name: 'winged',
  clips: {
    idle: w_idle, walk: w_walk, run: w_run, graze: w_graze, sit: w_sit,
    sleep: w_sleep, alert: w_alert, attack: w_attack, flee: w_flee,
    flap: w_flap, glide: w_glide, land: w_land, dead: w_dead,
  },
  idleLayer: w_layer,
};

export const WINGED_ALL: readonly Clip[] = [
  w_idle, w_walk, w_run, w_graze, w_sit, w_sleep, w_alert, w_attack, w_flee,
  w_flap, w_glide, w_land, w_dead, w_layer,
];

// ===========================================================================
// BIRD  —  WalkAmp is the wing channel; head motion is stepped
// ===========================================================================

/**
 * Perched — wings almost still, head snapping between headings.
 *
 * The head track holds each heading for 0.9–1.6 s and then jumps. Note the
 * uneven hold lengths: equal spacing turns the flicks into a tick-tock, which
 * is as mechanical as smooth panning, just differently mechanical.
 */
const b_idle = loopClip('b_idle', 6.4, [
  hold(Ch.WalkAmp, 0.07, 6.4),
  track(Ch.HeadYaw, [
    [0, 0, Ease.Step], [0.9, 0.5, Ease.Step], [2.2, 0.25, Ease.Step],
    [3.1, -0.5, Ease.Step], [4.7, -0.25, Ease.Step], [5.6, 0.75, Ease.Step],
    [6.4, 0],
  ]),
  hold(Ch.BodySink, 0, 6.4),
]);

const b_alert = loopClip('b_alert', 2.2, [
  hold(Ch.WalkAmp, 0.05, 2.2),
  track(Ch.HeadYaw, [
    [0, 0, Ease.Step], [0.35, 0.75, Ease.Step], [0.9, -0.75, Ease.Step],
    [1.5, 0.25, Ease.Step], [2.2, 0],
  ]),
  hold(Ch.HeadPitch, -0.3, 2.2),
  hold(Ch.BodySink, -0.02, 2.2),
]);

/** Hopping along the ground. */
const b_walk = loopClip('b_walk', 2.4, [
  hold(Ch.WalkAmp, 0.26, 2.4),
  track(Ch.HeadYaw, [
    [0, 0, Ease.Step], [0.7, 0.3, Ease.Step], [1.5, -0.3, Ease.Step], [2.4, 0],
  ]),
  hold(Ch.BodySink, 0, 2.4),
]);

/** Short flight — the full beat. */
const b_run = loopClip('b_run', 1.2, [
  hold(Ch.WalkAmp, 0.92, 1.2),
  hold(Ch.HeadYaw, 0, 1.2),
  hold(Ch.HeadPitch, -0.10, 1.2),
  hold(Ch.BodySink, -0.05, 1.2),
]);

const b_flee = loopClip('b_flee', 1.0, [
  hold(Ch.WalkAmp, 1, 1.0),
  hold(Ch.HeadYaw, 0, 1.0),
  hold(Ch.BodySink, -0.09, 1.0),
]);

/** Pecking — stepped head, down and up. */
const b_graze = loopClip('b_graze', 2.6, [
  hold(Ch.WalkAmp, 0.06, 2.6),
  track(Ch.HeadYaw, [
    [0, 0, Ease.Step], [0.9, 0.35, Ease.Step], [1.8, -0.3, Ease.Step], [2.6, 0],
  ]),
  track(Ch.HeadPitch, [
    [0, 0.15, Ease.Step], [0.35, 0.85, Ease.Step], [0.6, 0.15, Ease.Step],
    [1.2, 0.85, Ease.Step], [1.5, 0.15, Ease.Step], [2.1, 0.85, Ease.Step],
    [2.35, 0.15, Ease.Step], [2.6, 0.15],
  ]),
  hold(Ch.BodySink, 0.03, 2.6),
]);

const b_attack = shotClip('b_attack', 0.34, [
  track(Ch.WalkAmp, [[0, 0.1], [0.12, 0.75, Ease.Smooth], [0.34, 0.1, Ease.Out]]),
  track(Ch.HeadPitch, [
    [0, 0], [0.12, -0.25, Ease.Smooth], [0.20, 0.55, Ease.In], [0.34, 0, Ease.Out],
  ]),
  track(Ch.BodySink, [
    [0, 0], [0.12, 0.05, Ease.Smooth], [0.20, -0.06, Ease.In], [0.34, 0, Ease.Out],
  ]),
]);

const b_sit = loopClip('b_sit', 4, [
  hold(Ch.WalkAmp, 0, 4),
  track(Ch.HeadYaw, [[0, 0, Ease.Step], [1.9, 0.25, Ease.Step], [4, 0]]),
  hold(Ch.BodySink, 0.22, 4),
]);

const b_sleep = loopClip('b_sleep', 6, [
  hold(Ch.WalkAmp, 0, 6),
  hold(Ch.HeadYaw, 0.55, 6),
  hold(Ch.HeadPitch, 0.45, 6),
  hold(Ch.BodySink, 0.30, 6),
]);

const b_dead = loopClip('b_dead', 1, [
  hold(Ch.WalkAmp, 0, 1),
  hold(Ch.HeadYaw, 0, 1),
  hold(Ch.BodySink, 0, 1),
]);

/**
 * Bird additive layer.
 *
 * `WalkAmp` deliberately gets NO additive component here: on a bird that
 * channel is the wing amplitude, and a perched bird whose wings breathe in and
 * out looks broken rather than alive. The breathing goes entirely into
 * `BodySink`, and it is fast — a small bird's resting respiration is several
 * times a human's.
 */
const b_layer = layerClip('b_idle_layer', 8, [
  sine(Ch.BodySink, 0.014, 8, 8),      // 1 Hz
  sine(Ch.HeadPitch, 0.05, 3, 8, 0.4),
  sine(Ch.TailSway, 0.12, 5, 8, 0.2),
]);

export const BIRD_CLIPS: ClipSet = {
  name: 'bird',
  clips: {
    idle: b_idle, walk: b_walk, run: b_run, graze: b_graze, sit: b_sit,
    sleep: b_sleep, alert: b_alert, attack: b_attack, flee: b_flee,
    flap: b_run, glide: b_walk, dead: b_dead,
  },
  idleLayer: b_layer,
};

export const BIRD_ALL: readonly Clip[] = [
  b_idle, b_walk, b_run, b_graze, b_sit, b_sleep, b_alert, b_attack, b_flee,
  b_dead, b_layer,
];
