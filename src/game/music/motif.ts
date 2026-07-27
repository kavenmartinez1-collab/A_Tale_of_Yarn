/**
 * THE MOTIF — "A Tale of Yarn", the recurring theme.
 *
 * Authored as DATA (diatonic scale degrees on a 16th-note grid), never as
 * audio and never as semitones. Four bars, thirteen notes, 4/4.
 *
 * In C ionian it reads:
 *     C   G   F  G  |  E  D  C.....  |  C   G   A  B  |  C(8ve)... G.....
 *
 * Shape: an antecedent that leaps up a fifth, turns, and sinks back to the
 * tonic; then the SAME opening leap that this time keeps climbing to the
 * octave and falls open onto the fifth. Statement, then the same statement
 * refusing to close — which is what makes it want to repeat forever.
 *
 * WHY IT SURVIVES TRANSFORMATION
 *  - Its identity is the DEGREE-interval fingerprint [+4,-1,+1,-2], not any
 *    semitone pattern. Change the mode under it and every interval keeps its
 *    scale-step size while its *colour* changes.
 *  - The mode-defining tones land on structurally strong notes. Bar 2's
 *    descent 2-1-0 puts degree 1 on the penultimate note, so in phrygian
 *    (Castle Vhaeron / the Evil King) that single note drops a semitone and
 *    the same tune turns sinister. In dorian (the wilds) the raised 6th
 *    brightens bar 3's climb; in aeolian (dungeons) it darkens.
 *  - Notes 1-5 form a self-sufficient HEAD CELL, so sparse regions can quote
 *    a fragment and still be unmistakably the theme.
 *  - Rhythm is all quarters/eighths with one syncopated 6-step hold, so
 *    augmentation (x2, grand) and diminution (x0.5, martial) both stay legible.
 */

export const STEPS_PER_BAR = 16; // 16th-note grid, 4/4
export const MOTIF_BARS = 4;
export const MOTIF_STEPS = STEPS_PER_BAR * MOTIF_BARS; // 64

export interface MotifNote {
  /** 16th-note offset from the start of the motif. */
  step: number;
  /** Length in 16th notes. */
  dur: number;
  /** Diatonic degree relative to the tonic; 0 = tonic, 7 = octave. */
  deg: number;
  /** 0..1 */
  vel: number;
}

/** The theme. Do not reorder — index 0..4 is the head cell. */
export const MOTIF: readonly MotifNote[] = Object.freeze([
  // bar 1 — the call: tonic, leap of a fifth, neighbour turn
  { step: 0, dur: 4, deg: 0, vel: 0.78 },
  { step: 4, dur: 4, deg: 4, vel: 0.92 }, // the leap
  { step: 8, dur: 2, deg: 3, vel: 0.64 },
  { step: 10, dur: 6, deg: 4, vel: 0.8 },
  // bar 2 — the sinking answer, 2-1-0 (degree 1 is the modal colour note)
  { step: 16, dur: 4, deg: 2, vel: 0.7 },
  { step: 20, dur: 4, deg: 1, vel: 0.66 },
  { step: 24, dur: 8, deg: 0, vel: 0.74 },
  // bar 3 — the call again, but it keeps climbing
  { step: 32, dur: 4, deg: 0, vel: 0.76 },
  { step: 36, dur: 4, deg: 4, vel: 0.9 }, // the same leap
  { step: 40, dur: 2, deg: 5, vel: 0.7 },
  { step: 42, dur: 6, deg: 6, vel: 0.82 },
  // bar 4 — the octave, then an open fall to the fifth (invites the repeat)
  { step: 48, dur: 8, deg: 7, vel: 0.96 },
  { step: 56, dur: 8, deg: 4, vel: 0.7 },
].map(Object.freeze) as MotifNote[]);

/** Notes 0..4 — the smallest quotable fragment that is still unmistakable. */
export const MOTIF_HEAD_LEN = 5;

/** Degree-to-degree deltas of a note list. Length = notes.length - 1. */
export function degreeIntervals(notes: readonly { deg: number }[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < notes.length; i++) out.push(notes[i]!.deg - notes[i - 1]!.deg);
  return out;
}

/** Full fingerprint: [+4,-1,+1,-2,-1,-1,0,+4,+1,+1,+1,-3]. */
export const MOTIF_INTERVALS: readonly number[] = Object.freeze(degreeIntervals(MOTIF));

/**
 * The detector's needle: [+4,-1,+1,-2].
 * A rising fifth immediately followed by a step-down/step-up/step-down turn.
 * Deliberately chosen to be rare in free diatonic motion — see the control
 * cases in scripts/test-music.mts, which feed the detector a random walk, the
 * motif's retrograde and its inversion and require ZERO matches from each.
 */
export const MOTIF_HEAD_INTERVALS: readonly number[] = Object.freeze(
  MOTIF_INTERVALS.slice(0, MOTIF_HEAD_LEN - 1),
);

// --- interval-PRESERVING transforms (legal inside a "statement") ------------

/** Diatonic transposition. Degree intervals are unchanged by construction. */
export function transposeDeg(notes: readonly MotifNote[], by: number): MotifNote[] {
  return notes.map((n) => ({ ...n, deg: n.deg + by }));
}

/** Octave displacement (7 diatonic degrees). Also interval-preserving. */
export function octaveShift(notes: readonly MotifNote[], octaves: number): MotifNote[] {
  return transposeDeg(notes, octaves * 7);
}

/** Time-scale. factor 2 = augmentation (grand), 0.5 = diminution (martial). */
export function timeScale(notes: readonly MotifNote[], factor: number): MotifNote[] {
  return notes.map((n) => ({
    ...n,
    step: Math.round(n.step * factor),
    dur: Math.max(1, Math.round(n.dur * factor)),
  }));
}

/** First `count` notes — a legal quote of a prefix of the fingerprint. */
export function fragment(notes: readonly MotifNote[], count: number): MotifNote[] {
  return notes.slice(0, Math.max(1, Math.min(notes.length, count))).map((n) => ({ ...n }));
}

// --- interval-BREAKING transforms (development only, never a "statement") ---

/** Reverse in time. Used for development material — must NOT match. */
export function retrograde(notes: readonly MotifNote[]): MotifNote[] {
  const span = MOTIF_STEPS;
  return notes
    .map((n) => ({ ...n, step: span - n.step - n.dur }))
    .sort((a, b) => a.step - b.step);
}

/** Mirror degrees around the first note. Used for development — must NOT match. */
export function invert(notes: readonly MotifNote[]): MotifNote[] {
  const pivot = notes[0]?.deg ?? 0;
  return notes.map((n) => ({ ...n, deg: 2 * pivot - n.deg }));
}

/**
 * Count NON-OVERLAPPING occurrences of `needle` inside the degree-interval
 * sequence of `notes`. This is the motif-presence instrument: it reads the
 * arranger's own note events, never audio.
 */
export function countMotifStatements(
  notes: readonly { deg: number }[],
  needle: readonly number[] = MOTIF_HEAD_INTERVALS,
): number {
  if (needle.length === 0 || notes.length < needle.length + 1) return 0;
  const iv = degreeIntervals(notes);
  let count = 0;
  let i = 0;
  outer: while (i + needle.length <= iv.length) {
    for (let k = 0; k < needle.length; k++) {
      if (iv[i + k] !== needle[k]) {
        i++;
        continue outer;
      }
    }
    count++;
    i += needle.length; // non-overlapping
  }
  return count;
}
