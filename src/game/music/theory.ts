/**
 * Music theory primitives — pure, engine-free, no audio, no RNG.
 *
 * Everything in the arranger speaks *diatonic scale degrees*, never semitones.
 * That is the whole trick behind the recurring motif: a degree sequence keeps
 * its identity when the mode changes underneath it, so the same tune reads as
 * warm (ionian, village), wistful (dorian, wilds), grim (aeolian, dungeon) or
 * sinister (phrygian, castle) without a single edited note.
 */

export type ModeName = 'ionian' | 'dorian' | 'mixolydian' | 'aeolian' | 'phrygian';

/** Semitone offsets of each diatonic degree, per mode. */
export const MODES: Record<ModeName, readonly number[]> = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
};

export const MODE_NAMES: readonly ModeName[] = [
  'ionian',
  'dorian',
  'mixolydian',
  'aeolian',
  'phrygian',
];

/**
 * Diatonic degree -> semitone offset from the tonic.
 * `deg` may be negative or >6; it wraps by octaves (degree 7 == tonic + 1 oct).
 */
export function degreeToSemitone(deg: number, mode: ModeName): number {
  const scale = MODES[mode];
  const oct = Math.floor(deg / 7);
  const idx = deg - oct * 7;
  return oct * 12 + scale[idx]!;
}

/** Diatonic degree -> MIDI note number, given the tonic's MIDI note. */
export function degreeToMidi(deg: number, tonicMidi: number, mode: ModeName): number {
  return tonicMidi + degreeToSemitone(deg, mode);
}

/** Equal-temperament MIDI -> Hz (A4 = 69 = 440 Hz). */
export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

/** MIDI -> scientific pitch name, e.g. 62 -> 'D4'. */
export function midiToName(midi: number, flats = false): string {
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  return `${(flats ? FLAT_NAMES : SHARP_NAMES)[pc]}${oct}`;
}

/** Pitch-class name only, e.g. 62 -> 'D'. */
export function midiToPitchClass(midi: number, flats = false): string {
  const pc = ((midi % 12) + 12) % 12;
  return (flats ? FLAT_NAMES : SHARP_NAMES)[pc]!;
}

/**
 * Diatonic chord built by stacking thirds off a scale-degree root.
 * size 3 -> triad, 4 -> seventh. Returned as degrees, not semitones.
 */
export function chordDegrees(root: number, size = 3): number[] {
  const out: number[] = [];
  for (let i = 0; i < size; i++) out.push(root + i * 2);
  return out;
}

/**
 * Roman-numeral label for a degree root in a mode — used by the MIDI export
 * README so the Ableton session shows real harmony, not just note numbers.
 */
export function romanNumeral(root: number, mode: ModeName): string {
  const scale = MODES[mode];
  const r = ((root % 7) + 7) % 7;
  const third = (degreeToSemitone(r + 2, mode) - degreeToSemitone(r, mode) + 12) % 12;
  const minor = third === 3;
  const base = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][r]!;
  // Flat-prefix any degree that sits a semitone below its ionian position.
  const ionianSemi = MODES.ionian[r]!;
  const flat = scale[r]! < ionianSemi ? 'b' : '';
  return flat + (minor ? base.toLowerCase() : base);
}
