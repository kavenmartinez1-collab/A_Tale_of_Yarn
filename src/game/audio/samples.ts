/**
 * Recorded one-shot samples — the developer's own recordings, played back
 * where synthesis is the wrong tool.
 *
 * The SFX system proper (`sfx.ts`) is pure synthesis with per-event seeded
 * reproduction, and that is the right default. But some sounds ARE recordings:
 * the wingbeats are cut from the opening whoosh of the developer's own
 * "Project 1 Logic" (their college composition — the same self-made provenance
 * as the soundtrack, recorded in the audio-credits manifest). A recipe
 * imitating that whoosh would be a worse copy of a thing we already own.
 *
 * Playback inherits the recipe system's discipline: throttling, distance
 * rolloff with a per-sample reach, a shared voice budget, and DETERMINISTIC
 * pitch jitter seeded from (name, event index) — the same
 * (name, n)-numbers-real-events rule `GameAudio.play` uses, so a shot
 * sequence reproduces exactly.
 *
 * Files live in `models/sfx/` and are served through the SAME
 * `/api/hf-cache/local/<name>` alias as the soundtrack (`songs.ts` documents
 * why neither server needs a change). Decoded lazily on first use, cached
 * forever — three mono files totalling ~310 KB.
 */

export const SAMPLE_BASE = '/api/hf-cache/local/sfx/resolve/main/';

export type SampleName = 'wingbeat_dragon' | 'wingbeat_wyvern' | 'wingbeat_griffin';

export interface SampleDef {
  /** File under models/sfx/. */
  file: string;
  /** Distance (m) at which the sample fades to silence. */
  maxDist: number;
  /** Minimum ms between plays. A BACKSTOP, not the cadence: the beat is
   *  driven by the animator's wing clock (flapBase 2.4-3.4 rad/s, one
   *  downstroke every ~1.9-2.6 s at rest), so this only exists to stop a
   *  future trigger bug from machine-gunning. ~40% of the resting period. */
  throttleMs: number;
  /** ± playbackRate jitter so repeated beats do not machine-gun. */
  jitter: number;
  /** Base gain trim. */
  gain: number;
}

export const SAMPLE_DEFS: Record<SampleName, SampleDef> = {
  // A dragon's wing is a sail: slow, heavy, carries a long way.
  wingbeat_dragon:  { file: 'wingbeat-dragon.wav',  maxDist: 90, throttleMs: 1000, jitter: 0.05, gain: 0.9 },
  wingbeat_wyvern:  { file: 'wingbeat-wyvern.wav',  maxDist: 70, throttleMs: 800, jitter: 0.06, gain: 0.8 },
  wingbeat_griffin: { file: 'wingbeat-griffin.wav', maxDist: 55, throttleMs: 700, jitter: 0.07, gain: 0.7 },
};

/** Species → wingbeat sample. Birds are deliberately absent: a chirp-rate
 *  flap loop on every passing bird is noise, not atmosphere. */
export const WINGBEAT_FOR: Record<string, SampleName> = {
  dragon: 'wingbeat_dragon',
  black_dragon: 'wingbeat_dragon',
  wyvern: 'wingbeat_wyvern',
  griffin: 'wingbeat_griffin',
};
