/**
 * clips-humanoid.ts — the clip library for the four bipedal enemies.
 *
 * WHAT THE HUMANOID RIG READS
 *
 * `humanoid-mesh.ts` consumes six of the nine channels, and two of them mean
 * something different from what they mean on a quadruped. Authoring against
 * the wrong reading is how you get clips that look fine in a state dump and
 * wrong on screen, so:
 *
 *   `WalkAmp`   — as everywhere else, a GATE on the speed-derived stride, not
 *                 the stride itself. It also drives the arm counter-swing.
 *   `HeadYaw`   — head turn.
 *   `HeadPitch` — head nod, positive = looking DOWN.
 *   `JawOpen`   — the jaw hinge. A snarling goblin and a skeleton's hanging
 *                 mandible are both this channel.
 *   `BodySink`  — whole-body height, folded into the renderer's object offset.
 *   `TailSway`  — **repurposed as a TORSO TWIST**, and on the Dread King it
 *                 also swings the cape. A humanoid has no tail, and the
 *                 shoulders answering a swing is exactly the piece of
 *                 animation this channel was written to provide. `ForeSwing`
 *                 is the weapon arm and is authored almost entirely in
 *                 `clips-attack.ts`, because a humanoid's arm only really
 *                 moves when it is hitting something.
 *
 * WHY THREE SETS AND NOT ONE
 *
 * A goblin, a skeleton and a warlord share a skeleton and share nothing else
 * about how they carry it, and posture is most of what a silhouette says at
 * 20 m. The goblin twitches at 2-3x human idle rate; the skeleton is stiff,
 * slow and never looks around because it has nothing to look with; the Dread
 * King breathes at half human rate and does not deign to hurry. Encoding that
 * as three sets costs a few hundred lines and buys the single clearest read
 * on the whole roster.
 */

import { Ch, Ease, track, type Clip } from './clip';
import {
  hold, layerClip, loopClip, shotClip, sine, type ClipSet,
} from './clip-set';

// ===========================================================================
// GOBLIN — twitchy, hunched, always about to do something
// ===========================================================================

/**
 * Idle — never still. The head flicks in steps rather than sweeping, which is
 * the cheapest possible "nervous animal" and the opposite of the quadruped
 * idle's slow scan. `Ease.Step` is doing the work: a smoothed version of the
 * same keys reads as a calm creature looking around.
 */
const g_idle = loopClip('h_gob_idle', 3.6, [
  hold(Ch.WalkAmp, 0, 3.6),
  track(Ch.HeadYaw, [
    [0, 0], [0.5, 0.34, Ease.Step], [1.1, 0.30, Ease.Step],
    [1.5, -0.26, Ease.Step], [2.3, -0.22, Ease.Step],
    // The final segment eases rather than steps, deliberately: a track whose
    // LAST segment is `Ease.Step` holds its value right up to the wrap and
    // then jumps, which is a genuine loop discontinuity. Here it happens to
    // close on 0 anyway, but `g_sit` below did not — it snapped the head from
    // -0.17 to centre once every cycle. Landing the flick back to centre
    // before the loop point keeps the twitch and removes the pop.
    [2.7, 0.14, Ease.Step], [3.2, 0, Ease.Smooth], [3.6, 0],
  ]),
  hold(Ch.HeadPitch, 0.12, 3.6),
  // Shoulder hunch pulse — the body rises and settles twice a cycle.
  sine(Ch.BodySink, 0.020, 2, 3.6),
  sine(Ch.TailSway, 0.10, 3, 3.6, 0.21),
]);

/** Alert — frozen mid-flick, weight forward, jaw part-open. */
const g_alert = loopClip('h_gob_alert', 2.0, [
  hold(Ch.WalkAmp, 0, 2.0),
  hold(Ch.HeadYaw, 0, 2.0),
  hold(Ch.HeadPitch, -0.16, 2.0),  // chin up, sizing you up
  hold(Ch.JawOpen, 0.18, 2.0),
  hold(Ch.BodySink, 0.030, 2.0),   // crouched, ready
  hold(Ch.TailSway, 0.14, 2.0),
]);

/** Scavenging — the humanoid reading of `graze`: crouched, picking at the floor. */
const g_graze = loopClip('h_gob_graze', 4.4, [
  hold(Ch.WalkAmp, 0.28, 4.4),
  track(Ch.HeadYaw, [[0, 0], [1.1, 0.26], [2.2, 0], [3.3, -0.26], [4.4, 0]]),
  hold(Ch.HeadPitch, 0.66, 4.4),
  hold(Ch.BodySink, 0.170, 4.4),
  sine(Ch.TailSway, 0.12, 2, 4.4),
]);

/** Squatting on its heels — sentries do this for hours. */
const g_sit = loopClip('h_gob_sit', 4.0, [
  hold(Ch.WalkAmp, 0, 4.0),
  track(Ch.HeadYaw, [[0, 0], [1.4, 0.20, Ease.Step], [2.6, -0.17, Ease.Smooth], [4.0, 0]]),
  hold(Ch.HeadPitch, 0.16, 4.0),
  hold(Ch.BodySink, 0.360, 4.0),
]);

/** Asleep at its post, head lolling. */
const g_sleep = loopClip('h_gob_sleep', 6.0, [
  hold(Ch.WalkAmp, 0, 6.0),
  hold(Ch.HeadYaw, 0.30, 6.0),
  hold(Ch.HeadPitch, 0.56, 6.0),
  hold(Ch.BodySink, 0.440, 6.0),
  sine(Ch.TailSway, 0.05, 1, 6.0),
]);

/** Walk — a scuttle. High cadence comes from the short stride, not from here. */
const g_walk = loopClip('h_gob_walk', 1.5, [
  hold(Ch.WalkAmp, 1, 1.5),
  sine(Ch.HeadYaw, 0.09, 1, 1.5),
  hold(Ch.HeadPitch, 0.14, 1.5),
  sine(Ch.TailSway, 0.16, 2, 1.5),
  hold(Ch.BodySink, 0.010, 1.5),
]);

/** Run — head down, shoulders into it. */
const g_run = loopClip('h_gob_run', 1.0, [
  hold(Ch.WalkAmp, 1, 1.0),
  hold(Ch.HeadYaw, 0, 1.0),
  hold(Ch.HeadPitch, 0.26, 1.0),
  hold(Ch.JawOpen, 0.16, 1.0),
  sine(Ch.TailSway, 0.24, 2, 1.0),
  hold(Ch.BodySink, 0.030, 1.0),
]);

/**
 * Fleeing — a run with a backward glance, alternating sides.
 *
 * This is the clip that pays for the whole morale system. A goblin breaking
 * and running is a thing the player is supposed to *notice* and feel, and the
 * only reason it reads as fear rather than as a change of direction is the
 * head twisting back to check.
 */
const g_flee = loopClip('h_gob_flee', 1.4, [
  hold(Ch.WalkAmp, 1, 1.4),
  track(Ch.HeadYaw, [
    [0, 0], [0.35, 0.66, Ease.Out], [0.7, 0], [1.05, -0.60, Ease.Out], [1.4, 0],
  ]),
  hold(Ch.HeadPitch, -0.06, 1.4),
  hold(Ch.JawOpen, 0.34, 1.4),
  sine(Ch.TailSway, 0.30, 2, 1.4),
  hold(Ch.BodySink, 0.020, 1.4),
]);

/** Generic fallback swing — the real attacks live in `clips-attack.ts`. */
const g_attack = shotClip('h_gob_attack', 0.42, [
  track(Ch.WalkAmp, [[0, 0], [0.42, 0]]),
  track(Ch.ForeSwing, [
    [0, 0], [0.14, -0.32, Ease.Smooth], [0.24, 0.98, Ease.In],
    [0.32, 0.20, Ease.Out], [0.42, 0, Ease.Out],
  ]),
  track(Ch.JawOpen, [[0, 0], [0.16, 0.72, Ease.In], [0.42, 0, Ease.Out]]),
  track(Ch.TailSway, [
    [0, 0], [0.14, 0.26, Ease.Smooth], [0.24, -0.34, Ease.In], [0.42, 0, Ease.Out],
  ]),
]);

/** Dead — everything limp. The driver also drops the additive layer. */
const g_dead = loopClip('h_gob_dead', 1, [
  hold(Ch.WalkAmp, 0, 1), hold(Ch.HeadYaw, 0, 1), hold(Ch.HeadPitch, 0, 1),
  hold(Ch.BodySink, 0, 1), hold(Ch.TailSway, 0, 1), hold(Ch.ForeSwing, 0, 1),
]);

/**
 * The always-on layer: fast, shallow breathing and a constant micro-fidget.
 *
 * The frequencies are 2-3x the quadruped layer's, which is the entire
 * difference in how the two species read when standing still. Every component
 * is `sine()`-generated, so the mean is exactly zero and the layer cannot
 * slowly push the pose it rides on off-centre.
 */
const g_layer = layerClip('h_gob_layer', 9, [
  sine(Ch.BodySink, 0.012, 8, 9),        // ~0.9 Hz — panting
  sine(Ch.HeadYaw, 0.075, 5, 9, 0.33),
  sine(Ch.HeadPitch, 0.045, 7, 9, 0.17),
  sine(Ch.TailSway, 0.070, 4, 9, 0.61),
]);

export const GOBLIN_CLIPS: ClipSet = {
  name: 'goblin',
  clips: {
    idle: g_idle, walk: g_walk, run: g_run, graze: g_graze, sit: g_sit,
    sleep: g_sleep, alert: g_alert, attack: g_attack, flee: g_flee, dead: g_dead,
  },
  idleLayer: g_layer,
};

// ===========================================================================
// SKELETON — stiff, slow, and utterly incurious
// ===========================================================================

/**
 * Idle — the head does NOT scan.
 *
 * That absence is the whole characterisation. A creature that looks around is
 * a creature that is deciding; a skeleton has already decided. All it does is
 * tilt, very slowly, and rattle.
 */
const s_idle = loopClip('h_skel_idle', 8, [
  hold(Ch.WalkAmp, 0, 8),
  track(Ch.HeadYaw, [[0, 0], [3.4, 0.16], [8, 0]]),
  hold(Ch.HeadPitch, -0.10, 8),
  hold(Ch.JawOpen, 0.20, 8),      // the mandible just hangs
  hold(Ch.BodySink, 0, 8),
]);

/** Alert — head levels, jaw drops. No other tell. */
const s_alert = loopClip('h_skel_alert', 2.6, [
  hold(Ch.WalkAmp, 0, 2.6),
  hold(Ch.HeadYaw, 0, 2.6),
  hold(Ch.HeadPitch, -0.20, 2.6),
  hold(Ch.JawOpen, 0.34, 2.6),
  hold(Ch.BodySink, -0.010, 2.6),
]);

/** Standing over something. The skeleton reading of `graze`. */
const s_graze = loopClip('h_skel_graze', 6, [
  hold(Ch.WalkAmp, 0.20, 6),
  hold(Ch.HeadYaw, 0.10, 6),
  hold(Ch.HeadPitch, 0.58, 6),
  hold(Ch.JawOpen, 0.16, 6),
  hold(Ch.BodySink, 0.120, 6),
]);

/** Collapsed against a wall, waiting. */
const s_sit = loopClip('h_skel_sit', 5, [
  hold(Ch.WalkAmp, 0, 5),
  hold(Ch.HeadYaw, -0.22, 5),
  hold(Ch.HeadPitch, 0.34, 5),
  hold(Ch.JawOpen, 0.14, 5),
  hold(Ch.BodySink, 0.400, 5),
]);

/** Dormant — a heap of bones until something walks in. */
const s_sleep = loopClip('h_skel_sleep', 7, [
  hold(Ch.WalkAmp, 0, 7),
  hold(Ch.HeadYaw, 0.36, 7),
  hold(Ch.HeadPitch, 0.62, 7),
  hold(Ch.JawOpen, 0.06, 7),
  hold(Ch.BodySink, 0.520, 7),
]);

/** Walk — minimal knee bend, arms swinging wide. A march, not a stroll. */
const s_walk = loopClip('h_skel_walk', 2.2, [
  hold(Ch.WalkAmp, 1, 2.2),
  hold(Ch.HeadYaw, 0, 2.2),
  hold(Ch.HeadPitch, 0.04, 2.2),
  hold(Ch.JawOpen, 0.22, 2.2),
  sine(Ch.TailSway, 0.20, 2, 2.2),   // shoulders rolling against the stride
  hold(Ch.BodySink, 0, 2.2),
]);

/** Run — it does not really run. It leans forward and keeps coming. */
const s_run = loopClip('h_skel_run', 1.6, [
  hold(Ch.WalkAmp, 1, 1.6),
  hold(Ch.HeadYaw, 0, 1.6),
  hold(Ch.HeadPitch, 0.14, 1.6),
  hold(Ch.JawOpen, 0.32, 1.6),
  sine(Ch.TailSway, 0.26, 2, 1.6),
  hold(Ch.BodySink, 0.020, 1.6),
]);

/**
 * `flee` exists only because the state machine has a slot for it.
 *
 * A skeleton is `fearless`, so `animal-ai.ts` can never put it in flee mode —
 * this clip is unreachable in normal play and is authored as a stiff advance
 * rather than a retreat, so that if it ever DOES appear (a debug spawn, a
 * future status effect) it still reads as undead rather than as a goblin.
 */
const s_flee = loopClip('h_skel_flee', 1.8, [
  hold(Ch.WalkAmp, 1, 1.8),
  hold(Ch.HeadYaw, 0.12, 1.8),
  hold(Ch.HeadPitch, 0.08, 1.8),
  hold(Ch.JawOpen, 0.28, 1.8),
  sine(Ch.TailSway, 0.22, 2, 1.8),
  hold(Ch.BodySink, 0.010, 1.8),
]);

const s_attack = shotClip('h_skel_attack', 0.62, [
  track(Ch.WalkAmp, [[0, 0], [0.62, 0]]),
  track(Ch.ForeSwing, [
    [0, 0], [0.22, -0.44, Ease.Smooth], [0.34, 1.02, Ease.In],
    [0.46, 0.14, Ease.Out], [0.62, 0, Ease.Out],
  ]),
  track(Ch.JawOpen, [[0, 0.22], [0.30, 0.82, Ease.In], [0.62, 0.22, Ease.Out]]),
  track(Ch.TailSway, [
    [0, 0], [0.22, 0.34, Ease.Smooth], [0.34, -0.42, Ease.In], [0.62, 0, Ease.Out],
  ]),
]);

const s_dead = loopClip('h_skel_dead', 1, [
  hold(Ch.WalkAmp, 0, 1), hold(Ch.HeadYaw, 0, 1), hold(Ch.HeadPitch, 0, 1),
  hold(Ch.JawOpen, 0.06, 1), hold(Ch.BodySink, 0, 1), hold(Ch.TailSway, 0, 1),
]);

/**
 * The rattle.
 *
 * No breathing component at all — that is the point, and it is the one thing
 * that separates this layer from every other in the game. What is here instead
 * is a fast, tiny, deliberately non-harmonic jitter on three channels at 7 / 11
 * / 13 cycles over 10 s. Those counts are coprime, so the pattern does not
 * repeat inside the loop and the creature reads as held together by nothing
 * rather than as oscillating.
 *
 * `JawOpen` is deliberately NOT in here, however much a rattling mandible
 * wants to be. An additive sine is zero-mean, so it goes negative half the
 * time, and the resting jaw sits near the channel's legal floor of 0 — the sum
 * would push it under. The three channels below are all signed, so they have
 * no such floor.
 *
 * Relatedly, and less obviously: every skeleton clip above holds `JawOpen`
 * inside a NARROW band (0.06 rest, 0.34 alert). A wide postural spread on a
 * bounded channel is a pop waiting to happen — `FADE_IN.attack` is 0.07 s,
 * about four frames, so a 0.3 swing between two clips moves the jaw by a
 * tenth of its whole range in a single frame. `test-anim.mts`'s interrupt
 * check measures exactly that and caught it at 0.44.
 */
const s_layer = layerClip('h_skel_layer', 10, [
  sine(Ch.HeadYaw, 0.020, 7, 10, 0.13),
  sine(Ch.HeadPitch, 0.016, 11, 10, 0.47),
  sine(Ch.TailSway, 0.030, 13, 10, 0.71),
]);

export const SKELETON_CLIPS: ClipSet = {
  name: 'skeleton',
  clips: {
    idle: s_idle, walk: s_walk, run: s_run, graze: s_graze, sit: s_sit,
    sleep: s_sleep, alert: s_alert, attack: s_attack, flee: s_flee, dead: s_dead,
  },
  idleLayer: s_layer,
};

// ===========================================================================
// DREAD KING — slow, heavy, and in no hurry whatsoever
// ===========================================================================

/**
 * Idle — a single slow sweep across the room in eleven seconds.
 *
 * Everything about this clip is about half the rate of its goblin equivalent.
 * Speed is how a game says "this thing is heavy", and it is the only channel
 * available at the distance you first see him.
 */
const k_idle = loopClip('h_king_idle', 11, [
  hold(Ch.WalkAmp, 0, 11),
  track(Ch.HeadYaw, [[0, 0], [3.0, 0.30], [5.5, 0.10], [8.0, -0.28], [11, 0]]),
  hold(Ch.HeadPitch, -0.08, 11),
  sine(Ch.TailSway, 0.10, 1, 11, 0.4),   // the cape, barely moving
  hold(Ch.BodySink, 0, 11),
]);

/** Alert — chin down, shoulders squared. He has seen you and is not worried. */
const k_alert = loopClip('h_king_alert', 3.2, [
  hold(Ch.WalkAmp, 0, 3.2),
  hold(Ch.HeadYaw, 0, 3.2),
  hold(Ch.HeadPitch, 0.14, 3.2),   // looking DOWN at you
  hold(Ch.BodySink, 0.020, 3.2),
  hold(Ch.TailSway, -0.08, 3.2),
]);

/** Standing over the fallen. */
const k_graze = loopClip('h_king_graze', 7, [
  hold(Ch.WalkAmp, 0.16, 7),
  hold(Ch.HeadYaw, 0.08, 7),
  hold(Ch.HeadPitch, 0.50, 7),
  hold(Ch.BodySink, 0.130, 7),
]);

/** Enthroned. */
const k_sit = loopClip('h_king_sit', 6, [
  hold(Ch.WalkAmp, 0, 6),
  track(Ch.HeadYaw, [[0, 0], [2.4, 0.14], [4.4, -0.12], [6, 0]]),
  hold(Ch.HeadPitch, 0.10, 6),
  hold(Ch.BodySink, 0.380, 6),
]);

/** Dormant on the throne until the door opens. */
const k_sleep = loopClip('h_king_sleep', 9, [
  hold(Ch.WalkAmp, 0, 9),
  hold(Ch.HeadYaw, 0.18, 9),
  hold(Ch.HeadPitch, 0.48, 9),
  hold(Ch.BodySink, 0.460, 9),
]);

/** Walk — a slow advance. The cape swings a full beat behind the stride. */
const k_walk = loopClip('h_king_walk', 2.6, [
  hold(Ch.WalkAmp, 1, 2.6),
  hold(Ch.HeadYaw, 0, 2.6),
  hold(Ch.HeadPitch, 0.06, 2.6),
  sine(Ch.TailSway, 0.22, 2, 2.6, 0.25),
  hold(Ch.BodySink, 0.010, 2.6),
]);

/** Run — he does not sprint, he strides. */
const k_run = loopClip('h_king_run', 1.9, [
  hold(Ch.WalkAmp, 1, 1.9),
  hold(Ch.HeadYaw, 0, 1.9),
  hold(Ch.HeadPitch, 0.16, 1.9),
  hold(Ch.JawOpen, 0.18, 1.9),
  sine(Ch.TailSway, 0.32, 2, 1.9, 0.25),
  hold(Ch.BodySink, 0.030, 1.9),
]);

/** Unreachable in play (he is `fearless`); authored as an advance regardless. */
const k_flee = loopClip('h_king_flee', 2.0, [
  hold(Ch.WalkAmp, 1, 2.0),
  hold(Ch.HeadYaw, 0.10, 2.0),
  hold(Ch.HeadPitch, 0.10, 2.0),
  sine(Ch.TailSway, 0.28, 2, 2.0),
  hold(Ch.BodySink, 0.020, 2.0),
]);

const k_attack = shotClip('h_king_attack', 0.80, [
  track(Ch.WalkAmp, [[0, 0], [0.80, 0]]),
  track(Ch.ForeSwing, [
    [0, 0], [0.30, -0.46, Ease.Smooth], [0.46, 1.06, Ease.In],
    [0.60, 0.16, Ease.Out], [0.80, 0, Ease.Out],
  ]),
  track(Ch.HeadPitch, [
    [0, 0], [0.30, -0.20, Ease.Smooth], [0.46, 0.32, Ease.In], [0.80, 0, Ease.Out],
  ]),
  track(Ch.TailSway, [
    [0, 0], [0.30, 0.40, Ease.Smooth], [0.46, -0.52, Ease.In], [0.80, 0, Ease.Out],
  ]),
]);

const k_dead = loopClip('h_king_dead', 1, [
  hold(Ch.WalkAmp, 0, 1), hold(Ch.HeadYaw, 0, 1), hold(Ch.HeadPitch, 0, 1),
  hold(Ch.BodySink, 0, 1), hold(Ch.TailSway, 0, 1), hold(Ch.ForeSwing, 0, 1),
]);

/**
 * Slow breathing plus a standing cape wave.
 *
 * 3 cycles over 16 s is 0.19 Hz — about half a resting human's, and a quarter
 * of the goblin's. The cape term is the largest amplitude in any idle layer in
 * the game (0.13 rad) because it is cloth, not a body part, and it is the only
 * thing on him that should still be moving when he is not.
 */
const k_layer = layerClip('h_king_layer', 16, [
  sine(Ch.BodySink, 0.014, 3, 16),
  sine(Ch.TailSway, 0.130, 2, 16, 0.37),
  sine(Ch.HeadYaw, 0.055, 1, 16, 0.11),
  sine(Ch.HeadPitch, 0.030, 2, 16, 0.53),
]);

export const DREAD_KING_CLIPS: ClipSet = {
  name: 'dread_king',
  clips: {
    idle: k_idle, walk: k_walk, run: k_run, graze: k_graze, sit: k_sit,
    sleep: k_sleep, alert: k_alert, attack: k_attack, flee: k_flee, dead: k_dead,
  },
  idleLayer: k_layer,
};

// ---------------------------------------------------------------------------

/** Every humanoid clip, for the validation sweeps in `test-anim.mts`. */
export const HUMANOID_ALL: readonly Clip[] = [
  g_idle, g_walk, g_run, g_graze, g_sit, g_sleep, g_alert, g_attack, g_flee,
  g_dead, g_layer,
  s_idle, s_walk, s_run, s_graze, s_sit, s_sleep, s_alert, s_attack, s_flee,
  s_dead, s_layer,
  k_idle, k_walk, k_run, k_graze, k_sit, k_sleep, k_alert, k_attack, k_flee,
  k_dead, k_layer,
];
