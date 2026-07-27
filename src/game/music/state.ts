/**
 * Music state -> concrete musical parameters.
 *
 * The runtime consumes a tiny struct and resolves it, ONCE PER BAR, into a
 * BarPlan: key, mode, tempo, chord, registers and a gain per layer. Nothing
 * here touches audio or randomness — it is a pure lookup, so the whole
 * state matrix is directly assertable in tests.
 */

import type { ModeName } from './theory';

export type Region = 'wilds' | 'village' | 'dungeon' | 'castle' | 'interior';
export type Intensity = 'calm' | 'alert' | 'combat' | 'boss';
export type LayerId = 'pad' | 'bass' | 'melody' | 'pluck' | 'perc' | 'tension';

export const REGIONS: readonly Region[] = ['wilds', 'village', 'dungeon', 'castle', 'interior'];
export const INTENSITIES: readonly Intensity[] = ['calm', 'alert', 'combat', 'boss'];
export const LAYERS: readonly LayerId[] = ['pad', 'bass', 'melody', 'pluck', 'perc', 'tension'];

/** What the game hands us every frame. */
export interface MusicState {
  region: Region;
  intensity: Intensity;
  /** 0..1, 0 = midnight, 0.5 = noon (main.ts's `tod`). */
  tod: number;
  /** 0..1 rain amount (main.ts's `wx.rainLevel`). */
  weather: number;
  /**
   * Pause MENU open. Music keeps playing — it is the pause screen's ambience —
   * but the bus drops to PAUSE_LEVEL. Never stops, never cuts a note.
   */
  paused?: boolean;
}

export const DEFAULT_STATE: MusicState = {
  region: 'wilds',
  intensity: 'calm',
  tod: 0.3,
  weather: 0,
  paused: false,
};

/** Everything a region fixes: key colour, tempo, harmony, register. */
export interface RegionConfig {
  mode: ModeName;
  /** MIDI note of the tonic used for pitch reference (D across the score). */
  tonicMidi: number;
  bpm: number;
  /** Chord roots as scale degrees, one per bar, looping. */
  progression: readonly number[];
  /** Semitone offset applied to the melody layer. */
  melodyOctave: number;
  /** Semitone offset applied to the bass layer. */
  bassOctave: number;
  /** Bars between motif statements at calm intensity. */
  statementEvery: number;
}

/**
 * D is the tonic everywhere, so a region change is a MODE change, not a key
 * change — the theme stays in the same pitch neighbourhood and only its
 * colour moves. That is what makes the crossfades work.
 *
 *  wilds    dorian     — open, wistful; the raised 6th keeps it from moping
 *  village  ionian     — plain major warmth
 *  dungeon  aeolian    — natural minor, dropped an octave
 *  castle   phrygian   — the b2 is the Evil King's colour
 *  interior ionian     — same major as the village, but small and close
 */
export const REGION_CONFIG: Record<Region, RegionConfig> = {
  wilds: {
    mode: 'dorian',
    tonicMidi: 62, // D4
    bpm: 76,
    progression: [0, 6, 3, 0], // i - bVII - IV - i
    melodyOctave: 12,
    bassOctave: 0,
    statementEvery: 8,
  },
  village: {
    mode: 'ionian',
    tonicMidi: 62,
    bpm: 88,
    progression: [0, 4, 5, 3], // I - V - vi - IV
    melodyOctave: 0,
    bassOctave: 0,
    statementEvery: 4,
  },
  dungeon: {
    mode: 'aeolian',
    tonicMidi: 62,
    bpm: 64,
    progression: [0, 5, 6, 0], // i - bVI - bVII - i
    melodyOctave: -12,
    bassOctave: -12,
    statementEvery: 8,
  },
  castle: {
    mode: 'phrygian',
    tonicMidi: 62,
    bpm: 72,
    progression: [0, 1, 6, 0], // i - bII - bVII - i
    melodyOctave: 0,
    bassOctave: -12,
    statementEvery: 4,
  },
  interior: {
    mode: 'ionian',
    tonicMidi: 62,
    bpm: 80,
    progression: [0, 3, 5, 4], // I - IV - vi - V
    melodyOctave: 0,
    bassOctave: 0,
    statementEvery: 4,
  },
};

/** Tempo multiplier per intensity — small, so bar-quantised changes stay smooth. */
export const INTENSITY_TEMPO: Record<Intensity, number> = {
  calm: 1.0,
  alert: 1.0,
  combat: 1.12,
  boss: 1.18,
};

/**
 * THE LAYER MATRIX. Region x intensity -> gain per layer, 0..1.
 *
 * Written out in full rather than derived, because this table IS the score's
 * orchestration and it should be readable and editable as one thing.
 *
 * Invariant asserted in tests: within every region, the total energy is
 * strictly increasing across calm < alert < combat < boss.
 */
export const LAYER_MATRIX: Record<Region, Record<Intensity, Record<LayerId, number>>> = {
  wilds: {
    calm: { pad: 0.55, bass: 0.3, melody: 0.38, pluck: 0.22, perc: 0.0, tension: 0.0 },
    alert: { pad: 0.55, bass: 0.4, melody: 0.34, pluck: 0.3, perc: 0.18, tension: 0.16 },
    combat: { pad: 0.45, bass: 0.7, melody: 0.55, pluck: 0.35, perc: 0.75, tension: 0.45 },
    boss: { pad: 0.5, bass: 0.8, melody: 0.62, pluck: 0.3, perc: 0.85, tension: 0.6 },
  },
  village: {
    calm: { pad: 0.6, bass: 0.45, melody: 0.62, pluck: 0.55, perc: 0.18, tension: 0.0 },
    alert: { pad: 0.58, bass: 0.5, melody: 0.54, pluck: 0.48, perc: 0.35, tension: 0.2 },
    combat: { pad: 0.48, bass: 0.72, melody: 0.58, pluck: 0.4, perc: 0.78, tension: 0.45 },
    boss: { pad: 0.52, bass: 0.82, melody: 0.65, pluck: 0.35, perc: 0.88, tension: 0.6 },
  },
  dungeon: {
    calm: { pad: 0.62, bass: 0.4, melody: 0.26, pluck: 0.14, perc: 0.0, tension: 0.22 },
    alert: { pad: 0.6, bass: 0.48, melody: 0.3, pluck: 0.18, perc: 0.2, tension: 0.38 },
    combat: { pad: 0.5, bass: 0.75, melody: 0.48, pluck: 0.25, perc: 0.8, tension: 0.58 },
    boss: { pad: 0.55, bass: 0.85, melody: 0.55, pluck: 0.22, perc: 0.9, tension: 0.7 },
  },
  castle: {
    calm: { pad: 0.68, bass: 0.5, melody: 0.4, pluck: 0.2, perc: 0.12, tension: 0.25 },
    alert: { pad: 0.66, bass: 0.58, melody: 0.45, pluck: 0.24, perc: 0.32, tension: 0.42 },
    combat: { pad: 0.58, bass: 0.8, melody: 0.58, pluck: 0.28, perc: 0.85, tension: 0.62 },
    boss: { pad: 0.7, bass: 0.92, melody: 0.72, pluck: 0.26, perc: 0.95, tension: 0.78 },
  },
  interior: {
    calm: { pad: 0.5, bass: 0.28, melody: 0.45, pluck: 0.6, perc: 0.0, tension: 0.0 },
    alert: { pad: 0.5, bass: 0.34, melody: 0.4, pluck: 0.52, perc: 0.14, tension: 0.14 },
    combat: { pad: 0.44, bass: 0.62, melody: 0.5, pluck: 0.44, perc: 0.62, tension: 0.38 },
    boss: { pad: 0.5, bass: 0.74, melody: 0.58, pluck: 0.36, perc: 0.78, tension: 0.55 },
  },
};

/** Night = the same window main.ts uses for audio/visuals. */
export function isNight(tod: number): boolean {
  return tod < 0.26 || tod >= 0.74;
}

/** Fully resolved, immutable plan for one bar. */
export interface BarPlan {
  bar: number;
  region: Region;
  intensity: Intensity;
  mode: ModeName;
  tonicMidi: number;
  bpm: number;
  secPerBar: number;
  chordRoot: number;
  progression: readonly number[];
  gains: Record<LayerId, number>;
  melodyOctave: number;
  bassOctave: number;
  statementEvery: number;
  night: boolean;
  rain: number;
  paused: boolean;
}

const MIN_LAYER_GAIN = 0;
const MAX_LAYER_GAIN = 1;

function clamp01(v: number): number {
  return v < MIN_LAYER_GAIN ? MIN_LAYER_GAIN : v > MAX_LAYER_GAIN ? MAX_LAYER_GAIN : v;
}

/**
 * Resolve a state into a bar plan. PURE — same inputs, same plan, always.
 *
 * Time of day and weather are deliberately gentle modifiers on top of the
 * matrix: they recolour, they never reorchestrate. Night hushes the melody
 * and lifts the pad; rain pulls back the bright plucks (they would fight the
 * rain-noise bed in audio-engine.ts anyway) and thickens the pad.
 */
export function planBar(bar: number, state: MusicState): BarPlan {
  const cfg = REGION_CONFIG[state.region];
  const night = isNight(state.tod);
  const rain = Math.max(0, Math.min(1, state.weather));
  const base = LAYER_MATRIX[state.region][state.intensity];

  const gains: Record<LayerId, number> = {
    pad: clamp01(base.pad + (night ? 0.05 : 0) + rain * 0.06),
    bass: clamp01(base.bass + (night ? 0.02 : 0)),
    melody: clamp01(base.melody - (night ? 0.08 : 0)),
    pluck: clamp01(base.pluck - (night ? 0.06 : 0) - rain * 0.2),
    perc: clamp01(base.perc - rain * 0.08),
    tension: clamp01(base.tension + (night ? 0.04 : 0)),
  };

  // Night drops the melody an octave in the lit, domestic regions — the tune
  // goes from sung to hummed. The wilds are already high; the dungeon is
  // already low; neither moves.
  const nightDrop =
    night && (state.region === 'village' || state.region === 'interior') ? -12 : 0;

  const bpm = cfg.bpm * INTENSITY_TEMPO[state.intensity];
  const secPerBar = (60 / bpm) * 4;

  return {
    bar,
    region: state.region,
    intensity: state.intensity,
    mode: cfg.mode,
    tonicMidi: cfg.tonicMidi,
    bpm,
    secPerBar,
    chordRoot: cfg.progression[bar % cfg.progression.length]!,
    progression: cfg.progression,
    gains,
    melodyOctave: cfg.melodyOctave + nightDrop,
    bassOctave: cfg.bassOctave,
    statementEvery:
      state.intensity === 'combat' || state.intensity === 'boss' ? 4 : cfg.statementEvery,
    night,
    rain,
    paused: state.paused === true,
  };
}

/** Cheap structural equality for change detection (no JSON, no allocation). */
export function sameState(a: MusicState, b: MusicState): boolean {
  return (
    a.region === b.region &&
    a.intensity === b.intensity &&
    isNight(a.tod) === isNight(b.tod) &&
    Math.abs(a.weather - b.weather) < 0.08 &&
    (a.paused === true) === (b.paused === true)
  );
}
