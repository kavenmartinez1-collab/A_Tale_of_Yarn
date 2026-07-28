/**
 * THE SONG CATALOGUE — the developer's own recordings, as data.
 *
 * These are Kaven Martinez's compositions (written in college, all rights held
 * by the developer). They are NOT synthesized: each one is a decoded buffer
 * played back through the same MusicBus as every synth layer, which is the
 * seam layer.ts always promised ("a layer is synth-generated today and a
 * decoded buffer tomorrow").
 *
 * Everything in this file is MEASURED, not assumed. The numbers come from
 * scripts/prepare-music.mts, which decodes each master and reports duration,
 * tempo, key and level; the values below were cross-checked against an
 * independent chroma/Krumhansl analysis and a beat-grid search. Where a number
 * disagreed with the brief it was re-derived from the audio and the audio won —
 * see KEYS, below, which is the most important comment in this file.
 *
 * ============================================================================
 * KEYS — why there is no single "tonic E"
 * ============================================================================
 *
 * The integration brief asserted that all four tracks measure tonic E, and
 * asked for the procedural engine to be retuned D -> E so that the pad and the
 * song would share a tonic and overlap consonantly.
 *
 * They do not share a tonic. Measured (chroma restricted to in-tune partials,
 * bass register weighted separately, Krumhansl-Schmuckler key correlation, and
 * the final cadence chord — the method was validated against synthesized
 * ground-truth drones and triads first):
 *
 *     500nanometers   F  minor   KS 0.781   bass A#/F, final chord F C Eb Ab
 *     Ryan's song     Eb minor   KS 0.870   bass Eb 24.2% of all bass energy
 *     Untitled Song   C  major   KS 0.773   bass C  18.5%
 *     Project 1       A          KS 0.661   bass A 17.6%, E 15.3% (the fifth)
 *
 * E ranked #14, #16, #9 and #3 of 24 candidate keys respectively. Retuning the
 * bed to E would have put the pad a SEMITONE from 500nanometers and a semitone
 * the other way from Ryan's song — the two overworld interludes, which are
 * exactly the handoffs the brief wanted to sound flowing. That is the single
 * most dissonant interval available, and it would have made the overlap worse
 * than a plain crossfade rather than better.
 *
 * So the engine keeps its D tonic, and the CONSONANCE IS BOUGHT A DIFFERENT
 * WAY: the pad modulates to the song's own key for the handoff. One bar before
 * the song enters, the pad re-voices to the song's tonic as an OPEN FIFTH
 * (root + fifth, no third). An open fifth is mode-neutral, so it sits correctly
 * under a major song and a minor one alike, and it is consonant with the
 * incoming head by construction rather than by luck. On the way out the pad
 * rises again in the song's key and modulates home on the next downbeat.
 *
 * This is a pivot modulation — the ordinary way music moves between keys — and
 * it generalises: a fifth song in a fifth key needs no engine change at all,
 * only a row in this table. A global retune would have needed a new global
 * compromise every time.
 *
 * `tonicPc` below is therefore per-song, and the bed's tonic is untouched.
 */

import type { ModeName } from './theory';
import type { Region } from './state';

/** Where the vendored, processed copies are served from.
 *
 * `models/music/` resolves through the SAME `local/<name>` alias that both
 * servers already implement — `server/dev-server.ts` (repo-local models/) and
 * `app/steam/local-server.cjs:62` (depot resources/models/). Neither server
 * needed a change: the path below is a plain HF-style `resolve/main` fetch,
 * answered with Range support and `application/octet-stream`, which is all
 * `decodeAudioData` needs (it sniffs the container, it does not read the MIME).
 */
export const MUSIC_BASE = '/api/hf-cache/local/music/resolve/main/';

export type SongId = '500nm' | 'ryan' | 'untitled' | 'castle';
/** A playable unit: a whole song, or one segment of one. */
export type SegmentId = '500nm' | 'ryan-a' | 'ryan-b' | 'untitled' | 'castle';

export interface SongLoop {
  /** Seconds into the file where the loop returns to. */
  startS: number;
  /** Seconds into the file where the loop jumps from. */
  endS: number;
  /**
   * Crossfade length. The outgoing tail is REAL audio from past `endS`, faded
   * against the head at `startS` — so the file must have at least this much
   * material after `endS`.
   */
  crossfadeS: number;
}

export interface SongTrack {
  id: SongId;
  /** File name under models/music/. */
  file: string;
  /** Measured decoded duration, seconds. */
  durationS: number;
  /** Measured tempo. */
  bpm: number;
  /** Measured bar-grid origin (seconds of the first downbeat). */
  gridOriginS: number;
  /** Tonic pitch class, 0 = C. See the KEYS block above. */
  tonicPc: number;
  /** Closest diatonic mode, used only for labelling — the pivot pad is an open fifth. */
  mode: ModeName;
  /** Human-readable key, for the credits panel and the audition index. */
  keyName: string;
  /**
   * Playback trim in dB, applied at runtime by a GainNode.
   *
   * Measured by scripts/prepare-music.mts. It is the SMALLER of (a) the gain
   * that brings the track to the target integrated loudness and (b) the gain
   * that puts its true peak at -3 dBFS — so the ceiling the brief asked for is
   * a hard guarantee and loudness matching happens underneath it.
   *
   * Applied at runtime rather than baked in on purpose: the masters are copied
   * BIT-EXACT into models/music/, so vendoring costs no generation of mp3 loss
   * and the shipped file is provably the developer's own render.
   */
  gainDb: number;
}

export interface SongSegment {
  id: SegmentId;
  song: SongId;
  /** Offset into the file. */
  startS: number;
  /** End offset; playback stops (or loops) here. */
  endS: number;
  /** Fade-in at the head. 0 for a segment that starts at the file's own start. */
  fadeInS: number;
  /** Fade-out at the tail. 0 for a segment that ends at the file's own end. */
  fadeOutS: number;
  /**
   * How long the pivoted pad holds under this song's head before fading, if the
   * default PAD_OVERLAP is not long enough.
   *
   * This exists because a song may OPEN with rests. The castle track does — its
   * first fourteen seconds are a sparse figure with eleven measured silences in
   * it, the longest about a second. The pad leaving after the usual two and a
   * half seconds dropped straight into one of them and left a 420 ms hole at
   * the handoff, which the render harness caught. Holding the pad until the
   * material is continuous turns those rests back into what the composer wrote
   * — space inside a texture — instead of a gap that reads as a fault.
   *
   * prepare-music.mts verifies this per track against the actual file, so a
   * re-edited song with a different opening cannot silently reintroduce it.
   */
  padOverlapS?: number;
  loop?: SongLoop;
  label: string;
}

/**
 * The four masters.
 *
 * Tempo/grid measured by onset-envelope comb search; all four locked onto an
 * exact integer BPM, which is what a DAW export looks like and is a good sign
 * the measurement is right. (The brief's figures — 69/62/115/65 — were close
 * for two and wrong for two; 115 matched exactly.)
 */
export const SONGS: Record<SongId, SongTrack> = {
  '500nm': {
    id: '500nm',
    file: '500nanometers.mp3',
    durationS: 220.402,
    bpm: 70,
    gridOriginS: 1.251,
    tonicPc: 5, // F
    mode: 'aeolian',
    keyName: 'F minor',
    gainDb: -5.58,
  },
  ryan: {
    id: 'ryan',
    file: 'ryans-song.mp3',
    durationS: 225.937,
    bpm: 64,
    gridOriginS: 0.903,
    tonicPc: 3, // Eb
    mode: 'aeolian',
    keyName: 'E-flat minor',
    gainDb: -6.08,
  },
  untitled: {
    id: 'untitled',
    file: 'untitled-song.mp3',
    durationS: 66.782,
    bpm: 115,
    gridOriginS: 1.55,
    tonicPc: 0, // C
    mode: 'ionian',
    keyName: 'C major',
    gainDb: -7.38,
  },
  castle: {
    id: 'castle',
    file: 'castle-vhaeron.mp3',
    // First half only, by the composer's own verdict (2026-07-28): the back
    // half of Project 1 carries a found-voice sample they never liked, so the
    // master is trimmed at 37.95 s — just before the 38.0 s section re-entry
    // that opens that half — with a 3 s musical fade across the breakdown.
    durationS: 37.95,
    bpm: 117.5,
    gridOriginS: 0.62,
    // A, with E almost as strong — they are a fifth apart, and the chroma does
    // not settle the question of which is the tonic (KS says A major, but D#
    // is strong, which fits E major's leading tone better than A's #4). The
    // pivot pad is an open fifth A-E, which is the correct pair of pitches
    // under EITHER reading, so the ambiguity costs nothing.
    tonicPc: 9,
    mode: 'ionian',
    keyName: 'A / E (fifth-ambiguous)',
    // peak-ceiling, not loudness-match: the surviving half is quieter overall
    // (rms -22.2) and matching it upward would spend the -3 dBFS headroom.
    gainDb: 0,
  },
};

/**
 * THE UNTITLED LOOP POINT.
 *
 * Chosen by searching every bar-aligned (start, end) pair on the measured grid
 * (115.000 BPM, bar = 2.08696 s, origin 1.55 s), rendering each candidate seam
 * with the exact two-source crossfade the runtime uses, and measuring RMS
 * continuity and sample-delta discontinuity across the join.
 *
 * Winner: bars 3 -> 29. The intro (0 -> 7.811 s), whose two rests at 3.2 s and
 * 7.4 s are punctuation rather than structure, plays once on entry; the loop
 * then covers 26 bars / 54.26 s — everything but the intro and a 4.7 s tail,
 * which the crossfade consumes rather than discards.
 *
 * Measured at the seam, after the -4.0 dB trim:
 *     RMS  pre 0.1430  seam 0.1419  post 0.1339   deviation +2.5%  (gate: 10%)
 *     peak 0.689 (no clipping)
 *     max sample-to-sample delta at the seam: 0.86x the in-piece baseline —
 *     i.e. the join is SMOOTHER than ordinary music inside the track. No click.
 *
 * The crossfade is LINEAR (equal-gain), not equal-power. Equal-power is right
 * for uncorrelated material; a loop seam joins a piece to ITSELF in the same
 * key and texture, so the two sides add coherently and sin/cos overshoots. The
 * measured difference is not subtle: equal-power put the seam +30.9% hot and
 * peaked at 1.016 (clipping); linear puts it at +2.5% and 0.689.
 */
const UNTITLED_LOOP: SongLoop = {
  startS: 7.811,
  endS: 62.072,
  crossfadeS: 1.043, // 2 beats at 115 BPM
};

/**
 * Ryan's song splits at its strongest structural boundary.
 *
 * The novelty curve peaks at 74.93 s with strength 1.619 — more than three
 * times the median peak and the largest in the piece by a wide margin (the
 * runner-up is 1.000). The brief's "natural break at 75.0 s" is confirmed to
 * within 70 ms, so the split is taken there.
 */
const RYAN_SPLIT_S = 74.93;

export const SEGMENTS: Record<SegmentId, SongSegment> = {
  '500nm': {
    id: '500nm',
    song: '500nm',
    startS: 0,
    endS: SONGS['500nm'].durationS,
    fadeInS: 0,
    fadeOutS: 0,
    label: '500 nanometers',
  },
  'ryan-a': {
    id: 'ryan-a',
    song: 'ryan',
    startS: 0,
    endS: RYAN_SPLIT_S,
    fadeInS: 0,
    // The split is a structural boundary, not a silence: fade the tail so the
    // segment ends as a decision rather than as an interruption.
    fadeOutS: 2.0,
    label: "Ryan's song, part one",
  },
  'ryan-b': {
    id: 'ryan-b',
    song: 'ryan',
    startS: RYAN_SPLIT_S,
    endS: SONGS.ryan.durationS,
    fadeInS: 1.2,
    fadeOutS: 0,
    label: "Ryan's song, part two",
  },
  untitled: {
    id: 'untitled',
    song: 'untitled',
    startS: 0,
    endS: SONGS.untitled.durationS,
    fadeInS: 0,
    fadeOutS: 0,
    loop: UNTITLED_LOOP,
    label: 'Untitled Song',
  },
  castle: {
    id: 'castle',
    song: 'castle',
    startS: 0,
    // The trim's own fade drops below the silence threshold at 37.71 s
    // (prepare-music measures [37.71, 37.95] as near-silence). The segment
    // ends there so the exit protocol rises the pad under real music, never
    // under the last breath of a fade — same rule as the old 72 s boundary
    // on the full-length master.
    endS: 37.71,
    fadeInS: 0,
    fadeOutS: 2.0,
    // The opening figure is punctuated by eleven measured rests, the last
    // ending at 14.02 s; after that the track is continuous until its tail.
    // The pad holds through all of them and clears at 13.5 + 1.2 = 14.7 s.
    padOverlapS: 13.5,
    label: 'Castle Vhaeron',
  },
};

/**
 * The overworld rotation, in the developer's own words: 500nanometers, then
 * Ryan's song "between those" — split so each half gets its own outing.
 * Cycling a 3-list guarantees the "never twice the same segment consecutively"
 * property structurally rather than by rejection sampling.
 */
export const OVERWORLD_ROTATION: readonly SegmentId[] = ['500nm', 'ryan-a', 'ryan-b'];

/** Regions whose music IS a song rather than an occasional interlude. */
export const REGION_SEGMENT: Partial<Record<Region, SegmentId>> = {
  dungeon: 'untitled',
  castle: 'castle',
};

/** Regions where the ~4-minute interlude rotation runs. */
export const INTERLUDE_REGIONS: readonly Region[] = ['wilds', 'village'];

/** MIDI note of `pc` in the octave nearest `near` — keeps the pivot in register. */
export function nearestMidiForPc(pc: number, near: number): number {
  const base = ((pc % 12) + 12) % 12;
  let best = base;
  let bestD = Infinity;
  for (let m = base; m < 128; m += 12) {
    const d = Math.abs(m - near);
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  return best;
}
