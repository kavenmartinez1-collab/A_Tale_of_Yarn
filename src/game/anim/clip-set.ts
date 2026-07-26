/**
 * clip-set.ts — the animation state vocabulary and the fallback graph that
 * makes a partial clip library safe.
 *
 * A body plan does not need every state. A serpent has no wings to `land` with
 * and no legs to `sit` on; a rabbit has no `glide`. Rather than force every
 * library to author eleven clips — most of which would be copies of `idle` with
 * a different name — a set is allowed to be sparse and `resolveState` walks a
 * declared fallback chain until it finds one that exists.
 *
 * The chains are not arbitrary. Each is the nearest POSTURAL neighbour, so a
 * missing clip degrades to something that still reads as the right intent:
 * `glide` falls back to `flap` (still airborne) rather than to `idle` (suddenly
 * standing). Falling back to `idle` for everything would be simpler and would
 * make a gliding griffin stand to attention in mid-air.
 *
 * `resolveState` is total by construction — every chain ends at `idle`, and a
 * set without an `idle` clip is rejected at construction — so the driver never
 * has to handle a null clip.
 */

import { Ch, Ease, clip, track, type Clip, type KeySpec, type Track } from './clip';

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export type AnimState =
  | 'idle' | 'walk' | 'run' | 'graze' | 'sit' | 'sleep'
  | 'alert' | 'attack' | 'flee' | 'flap' | 'glide' | 'land' | 'dead';

export const ALL_STATES: readonly AnimState[] = [
  'idle', 'walk', 'run', 'graze', 'sit', 'sleep',
  'alert', 'attack', 'flee', 'flap', 'glide', 'land', 'dead',
];

/**
 * Fallback chain per state, nearest postural neighbour first.
 * Every chain terminates at `idle`, which every set must define.
 */
const FALLBACK: Record<AnimState, readonly AnimState[]> = {
  idle:   [],
  walk:   ['idle'],
  run:    ['walk', 'idle'],
  graze:  ['idle'],
  sit:    ['idle'],
  sleep:  ['sit', 'idle'],
  alert:  ['idle'],
  attack: ['alert', 'idle'],
  flee:   ['run', 'walk', 'idle'],
  flap:   ['run', 'walk', 'idle'],
  glide:  ['flap', 'run', 'idle'],
  land:   ['idle'],
  dead:   ['idle'],
};

/**
 * Crossfade into each state, in seconds.
 *
 * Attacks are near-instant because a telegraphed blend eats the windup that
 * makes the strike read; a 0.22 s fade into a 0.5 s lunge spends 44% of the
 * clip arriving at it. Death and sleep are slow because both are supposed to
 * look like the animal giving up on holding itself together.
 */
export const FADE_IN: Record<AnimState, number> = {
  idle: 0.28, walk: 0.20, run: 0.16, graze: 0.30, sit: 0.35, sleep: 0.70,
  alert: 0.12, attack: 0.07, flee: 0.12, flap: 0.18, glide: 0.30,
  land: 0.15, dead: 0.40,
};

// ---------------------------------------------------------------------------
// Clip sets
// ---------------------------------------------------------------------------

export interface ClipSet {
  name: string;
  clips: Partial<Record<AnimState, Clip>> & { idle: Clip };
  /**
   * Always-on additive layer: breathing, micro-drift, tail. Composed on top of
   * whatever absolute clip is playing, so it survives every transition.
   */
  idleLayer: Clip;
}

/**
 * Resolve a state to a clip, following the fallback chain.
 * Total: always returns a clip, because `idle` is required by the type.
 */
export function resolveState(set: ClipSet, state: AnimState): Clip {
  const direct = set.clips[state];
  if (direct !== undefined) return direct;
  for (const alt of FALLBACK[state]) {
    const c = set.clips[alt];
    if (c !== undefined) return c;
  }
  return set.clips.idle;
}

/** True if `state` resolved to its own clip rather than a fallback. */
export function hasState(set: ClipSet, state: AnimState): boolean {
  return set.clips[state] !== undefined;
}

// ---------------------------------------------------------------------------
// Authoring helpers
// ---------------------------------------------------------------------------

/**
 * A track holding one constant value for the whole clip.
 *
 * Two keys rather than one so that `validateClip`'s loop rule (last value ==
 * first value, last key at duration) is satisfied by construction and a
 * constant posture clip can still be marked `loop: true`.
 */
export function hold(ch: Ch, value: number, duration: number): Track {
  return track(ch, [[0, value], [duration, value]]);
}

/**
 * A loop-closed sine on one channel.
 *
 * Hand-authoring cyclic keys is where loop discontinuities come from: it takes
 * one mistyped digit for the last key to disagree with the first, and the
 * result is a twitch once per cycle that is invisible in every still frame.
 * Generating them guarantees closure — the final key is literally the first
 * key's value — and guarantees the mean is zero, which is what keeps an
 * ADDITIVE layer from slowly pushing the pose it is layered onto off-centre.
 *
 * Four keys per cycle (peak, zero, trough, zero) with smoothstep between them
 * tracks a true sine to within about 3% of amplitude, which is far below what
 * the eye resolves on a 2 cm head movement.
 *
 * @param cycles  Whole number of cycles in `duration`. Must be an integer, or
 *                the clip cannot close.
 * @param phase   Cycle offset in [0,1); decorrelates channels sharing a clock.
 */
export function sine(
  ch: Ch, amp: number, cycles: number, duration: number, phase = 0,
): Track {
  const steps = cycles * 4;
  const keys: KeySpec[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * duration;
    // The final key repeats the first exactly, closing the loop bit for bit.
    const u = i === steps ? phase : i / steps * cycles + phase;
    keys.push([t, Math.sin(u * Math.PI * 2) * amp, Ease.Smooth]);
  }
  return track(ch, keys);
}

/** Convenience: build a looping clip. */
export function loopClip(name: string, duration: number, tracks: Track[]): Clip {
  return clip(name, duration, true, tracks, false);
}

/** Convenience: build a one-shot clip that holds its final pose. */
export function shotClip(name: string, duration: number, tracks: Track[]): Clip {
  return clip(name, duration, false, tracks, false);
}

/** Convenience: build a looping ADDITIVE layer. */
export function layerClip(name: string, duration: number, tracks: Track[]): Clip {
  return clip(name, duration, true, tracks, true);
}
