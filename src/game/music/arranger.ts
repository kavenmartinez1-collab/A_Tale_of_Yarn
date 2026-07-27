/**
 * The arranger — turns a BarPlan into note events, deterministically.
 *
 * PURE and audio-free: `arrangeBar(seed, plan)` is a function of its inputs
 * only. That is what makes every downstream claim testable — the motif
 * detector, the MIDI exporter and the synth all read the SAME note events.
 *
 * Determinism contract: every choice draws from mulberry32(mix32(seed, bar,
 * salt(...))). No Math.random, no Date.now, no module-level mutable state.
 */

import { mix32, mulberry32, pick, salt } from './rng';
import {
  MOTIF,
  MOTIF_HEAD_LEN,
  STEPS_PER_BAR,
  fragment,
  octaveShift,
  timeScale,
  transposeDeg,
  type MotifNote,
} from './motif';
import { chordDegrees, degreeToMidi } from './theory';
import type { BarPlan, LayerId } from './state';

export type DrumId = 'kick' | 'frame' | 'shaker' | 'rim';

export interface NoteEvent {
  bar: number;
  /** 16th-note offset within the bar, 0..15. May be fractional for flams. */
  step: number;
  /** Duration in 16th notes. */
  dur: number;
  /** MIDI note number (GM percussion numbers when `drum` is set). */
  midi: number;
  /** 0..1 */
  vel: number;
  /** Diatonic degree relative to the tonic. Absent on percussion. */
  deg?: number;
  /** Set on percussion only. */
  drum?: DrumId;
}

export type BarNotes = Record<LayerId, NoteEvent[]>;

/** GM percussion map — makes the exported MIDI drop straight onto a drum rack. */
export const DRUM_MIDI: Record<DrumId, number> = {
  kick: 36, // Bass Drum 1
  frame: 45, // Low Tom  (stands in for a frame drum)
  shaker: 70, // Maracas
  rim: 37, // Side Stick
};

const DENSE = (p: BarPlan): boolean => p.intensity === 'combat' || p.intensity === 'boss';

// --------------------------------------------------------------------------
// Melody — the motif and its development
// --------------------------------------------------------------------------

/**
 * The transform applied to this cycle's statement. Every option here is
 * INTERVAL-PRESERVING (diatonic transposition, octave displacement, time
 * scaling, prefix fragmentation), so the fingerprint survives intact. That is
 * the contract the motif-presence test depends on.
 */
function statementFor(seed: number, cycleIndex: number, plan: BarPlan): MotifNote[] {
  const rnd = mulberry32(mix32(seed, cycleIndex, salt(`statement:${plan.region}`)));

  let notes: MotifNote[] = MOTIF.map((n) => ({ ...n }));

  // Sparse regions quote the head cell more often than the whole theme.
  const sparse = plan.statementEvery >= 8;
  const quoteHead = sparse ? rnd() < 0.6 : rnd() < 0.22;
  if (quoteHead) notes = fragment(notes, MOTIF_HEAD_LEN);

  // Diatonic transposition — 0 most of the time so the theme stays "home".
  const by = pick([0, 0, 0, 2, 4, 0, -3], rnd());
  if (by !== 0) notes = transposeDeg(notes, by);

  // Occasional octave displacement.
  const oct = pick([0, 0, 0, 0, 1, -1], rnd());
  if (oct !== 0) notes = octaveShift(notes, oct);

  // Martial diminution under combat; grand augmentation for a boss statement.
  const scale = DENSE(plan) ? 0.5 : plan.region === 'castle' && rnd() < 0.35 ? 2 : 1;
  if (scale !== 1) notes = timeScale(notes, scale);

  return notes;
}

/** Bars spanned by a note list on the 16th grid. */
function spanBars(notes: readonly MotifNote[]): number {
  let end = 0;
  for (const n of notes) end = Math.max(end, n.step + n.dur);
  return Math.max(1, Math.ceil(end / STEPS_PER_BAR));
}

/**
 * Development material for the bars between statements.
 *
 * Deliberately constrained to steps of at most +/-3 degrees, which makes the
 * motif's rising FIFTH (+4) impossible here. So development can never forge
 * the fingerprint, and the detector's count is exact rather than approximate.
 * `test-music.mts` asserts this property directly.
 */
function development(seed: number, plan: BarPlan): NoteEvent[] {
  const rnd = mulberry32(mix32(seed, plan.bar, salt(`dev:${plan.region}`)));
  const out: NoteEvent[] = [];
  const chord = chordDegrees(plan.chordRoot, 3);
  const density = DENSE(plan) ? 4 : plan.statementEvery >= 8 ? 1 : 2;

  let deg = chord[Math.floor(rnd() * chord.length)]!;
  let step = pick([0, 4, 8], rnd());

  for (let i = 0; i < density && step < STEPS_PER_BAR; i++) {
    const dur = pick([2, 3, 4, 6], rnd());
    out.push({
      bar: plan.bar,
      step,
      dur: Math.min(dur, STEPS_PER_BAR - step),
      midi: degreeToMidi(deg, plan.tonicMidi, plan.mode) + plan.melodyOctave,
      vel: 0.42 + rnd() * 0.2,
      deg,
    });
    step += dur + (rnd() < 0.3 ? 2 : 0);
    // |delta| <= 3 — the +4 leap is reserved for statements.
    deg += pick([-3, -2, -1, 1, 2, 3, -1, 1], rnd());
  }
  return out;
}

/**
 * Whether a given bar carries a motif statement or free development material.
 * Exported so scripts/test-music.mts can assert the non-forgery property
 * against the arranger's ACTUAL decision instead of guessing it from the
 * output — guessing misclassifies the statement's middle bars, which contain
 * no complete fingerprint of their own.
 */
export function barRole(seed: number, plan: BarPlan): 'statement' | 'development' {
  const cycle = Math.max(1, plan.statementEvery);
  const cycleIndex = Math.floor(plan.bar / cycle);
  const posInCycle = plan.bar - cycleIndex * cycle;
  return posInCycle < spanBars(statementFor(seed, cycleIndex, plan)) ? 'statement' : 'development';
}

function melodyBar(seed: number, plan: BarPlan): NoteEvent[] {
  const cycle = Math.max(1, plan.statementEvery);
  const cycleIndex = Math.floor(plan.bar / cycle);
  const posInCycle = plan.bar - cycleIndex * cycle;

  const statement = statementFor(seed, cycleIndex, plan);
  const span = spanBars(statement);

  if (posInCycle >= span) return development(seed, plan);

  const lo = posInCycle * STEPS_PER_BAR;
  const hi = lo + STEPS_PER_BAR;
  const out: NoteEvent[] = [];
  for (const n of statement) {
    if (n.step < lo || n.step >= hi) continue;
    out.push({
      bar: plan.bar,
      step: n.step - lo,
      // Clamped to the bar. An augmented (x2) statement note would otherwise
      // hang over the bar line into the next chord AND overlap the next bar's
      // melody note, which costs a second melody voice and can cost a note.
      dur: Math.min(n.dur, STEPS_PER_BAR - (n.step - lo)),
      midi: degreeToMidi(n.deg, plan.tonicMidi, plan.mode) + plan.melodyOctave,
      vel: n.vel,
      deg: n.deg,
    });
  }
  return out;
}

// --------------------------------------------------------------------------
// Pad / bass / pluck / tension
// --------------------------------------------------------------------------

function padBar(seed: number, plan: BarPlan): NoteEvent[] {
  const rnd = mulberry32(mix32(seed, plan.bar, salt('pad')));
  // TWO voices, not a full triad. The pad is a colour, not a chord part: the
  // third and seventh are already in the pluck arpeggio and the melody, so
  // doubling them here only ate voice budget and muddied the low mids. Warm
  // regions take root+third (sweet), dark regions root+fifth (open, hollow).
  const warm = plan.mode === 'ionian' || plan.mode === 'mixolydian';
  const degs = [plan.chordRoot, plan.chordRoot + (warm ? 2 : 4)];
  const out: NoteEvent[] = [];
  for (let i = 0; i < degs.length; i++) {
    out.push({
      bar: plan.bar,
      step: 0,
      dur: STEPS_PER_BAR,
      midi: degreeToMidi(degs[i]!, plan.tonicMidi, plan.mode) - 12,
      vel: 0.36 + rnd() * 0.08,
      deg: degs[i]!,
    });
  }
  return out;
}

function bassBar(seed: number, plan: BarPlan): NoteEvent[] {
  const rnd = mulberry32(mix32(seed, plan.bar, salt('bass')));
  const root = plan.chordRoot;
  const out: NoteEvent[] = [];
  const emit = (step: number, deg: number, dur: number, vel: number) =>
    out.push({
      bar: plan.bar,
      step,
      dur,
      midi: degreeToMidi(deg, plan.tonicMidi, plan.mode) - 24 + plan.bassOctave,
      vel,
      deg,
    });

  if (DENSE(plan)) {
    // Driving eighths: root, root, fifth, root — martial, never busy.
    const pattern = [root, root, root + 4, root, root, root + 4, root, root + 7];
    for (let i = 0; i < 8; i++) {
      emit(i * 2, pattern[i]!, 2, i % 2 === 0 ? 0.8 : 0.55);
    }
  } else {
    emit(0, root, 8, 0.72);
    const answer = rnd() < 0.5 ? root + 4 : root + 2;
    emit(8, answer, 8, 0.56);
  }
  return out;
}

function pluckBar(seed: number, plan: BarPlan): NoteEvent[] {
  const rnd = mulberry32(mix32(seed, plan.bar, salt('pluck')));
  const chord = chordDegrees(plan.chordRoot, 4);
  const out: NoteEvent[] = [];
  // One stride for every intensity. A 16th-note arpeggio under combat looked
  // right on paper and in practice only fought the percussion for voices while
  // being inaudible under it — combat drive is the bass and the drums' job.
  const stride = 4;
  // The "knitting needles" figure: a rolling arpeggio, up or down per bar.
  const dir = rnd() < 0.5 ? 1 : -1;
  let idx = Math.floor(rnd() * chord.length);
  for (let step = 0; step < STEPS_PER_BAR; step += stride) {
    if (rnd() < 0.12) {
      idx += dir;
      continue; // a dropped stitch
    }
    const deg = chord[((idx % chord.length) + chord.length) % chord.length]! + 7;
    out.push({
      bar: plan.bar,
      step,
      dur: Math.min(stride, 3),
      midi: degreeToMidi(deg, plan.tonicMidi, plan.mode),
      vel: 0.3 + (step === 0 ? 0.14 : 0) + rnd() * 0.1,
      deg,
    });
    idx += dir;
  }
  return out;
}

function tensionBar(_seed: number, plan: BarPlan): NoteEvent[] {
  // One voice only. The tremolo lives in the synth's gain LFO, not in extra
  // notes, so tension costs exactly one slot of the voice budget.
  return [
    {
      bar: plan.bar,
      step: 0,
      dur: STEPS_PER_BAR,
      midi: degreeToMidi(0, plan.tonicMidi, plan.mode) - 24,
      vel: 0.5,
      deg: 0,
    },
  ];
}

// --------------------------------------------------------------------------
// Percussion
// --------------------------------------------------------------------------

interface PercHit {
  drum: DrumId;
  steps: readonly number[];
  vel: number;
}

/**
 * Pattern bank. Designed so that AT MOST TWO drums coincide on any 16th —
 * asserted in test-music.mts, because the voice budget depends on it.
 */
const PERC_PATTERNS: Record<string, readonly PercHit[]> = {
  calm: [{ drum: 'frame', steps: [0], vel: 0.36 }],
  alert: [
    { drum: 'frame', steps: [0, 8], vel: 0.46 },
    { drum: 'shaker', steps: [4, 12], vel: 0.3 },
  ],
  combat: [
    { drum: 'kick', steps: [0, 6, 8, 14], vel: 0.86 },
    { drum: 'frame', steps: [4, 12], vel: 0.6 },
    { drum: 'shaker', steps: [2, 10], vel: 0.34 },
  ],
  boss: [
    { drum: 'kick', steps: [0, 4, 8, 12], vel: 0.92 },
    { drum: 'frame', steps: [2, 6, 10, 14], vel: 0.62 },
    { drum: 'rim', steps: [7, 15], vel: 0.44 },
  ],
};

function percBar(seed: number, plan: BarPlan): NoteEvent[] {
  const bank = PERC_PATTERNS[plan.intensity] ?? PERC_PATTERNS.calm!;
  const rnd = mulberry32(mix32(seed, plan.bar, salt('perc')));
  const out: NoteEvent[] = [];
  for (const hit of bank) {
    for (const step of hit.steps) {
      // Seeded humanisation of dynamics only — never of timing, so the grid
      // stays exact and the bar-boundary assertions stay meaningful.
      const v = hit.vel * (0.86 + rnd() * 0.24);
      out.push({
        bar: plan.bar,
        step,
        dur: 1,
        midi: DRUM_MIDI[hit.drum],
        vel: Math.min(1, v),
        drum: hit.drum,
      });
    }
  }
  out.sort((a, b) => a.step - b.step);
  return out;
}

// --------------------------------------------------------------------------

/**
 * Generate every layer's notes for one bar.
 *
 * Layers are generated regardless of gain — the scheduler decides what to
 * sound. That keeps note content independent of the fade state, which is why
 * a layer fading in is already mid-phrase rather than starting from silence.
 */
export function arrangeBar(seed: number, plan: BarPlan): BarNotes {
  return {
    pad: padBar(seed, plan),
    bass: bassBar(seed, plan),
    melody: melodyBar(seed, plan),
    pluck: pluckBar(seed, plan),
    perc: percBar(seed, plan),
    tension: tensionBar(seed, plan),
  };
}
