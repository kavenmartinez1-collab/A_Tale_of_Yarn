/**
 * SFX recipe definitions — pure data, no AudioContext dependency.
 *
 * Each recipe describes how to synthesize a one-shot sound effect using
 * oscillators, noise buffers, and gain envelopes. The GameAudio engine
 * interprets these recipes at play-time.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OscType = 'sine' | 'square' | 'sawtooth' | 'triangle';
export type NoiseColor = 'white' | 'brown' | 'pink';

/** A single oscillator layer in a recipe. */
export interface OscLayer {
  type: OscType;
  /** Base frequency in Hz. Runtime applies +-10% random variation. */
  freq: number;
  /** Optional end frequency for a sweep (portamento). */
  freqEnd?: number;
  /** Detune in cents (optional). */
  detune?: number;
  /** Gain envelope — [attack, hold, decay] in seconds. */
  envelope: [number, number, number];
  /** Peak gain during hold phase (0..1). Default 1. */
  gain?: number;
}

/** A noise layer in a recipe. */
export interface NoiseLayer {
  color: NoiseColor;
  /** Highpass filter frequency (Hz). 0 = no HP. */
  highpass?: number;
  /** Lowpass filter frequency (Hz). 0 = no LP. */
  lowpass?: number;
  /** Bandpass center + Q (alternative to HP/LP combo). */
  bandpass?: { freq: number; Q: number };
  /** Gain envelope — [attack, hold, decay] in seconds. */
  envelope: [number, number, number];
  /** Peak gain during hold phase (0..1). Default 1. */
  gain?: number;
}

/** Complete SFX recipe. */
export interface SfxRecipe {
  /** Descriptive tag for debugging. */
  name: string;
  /** Oscillator layers (played simultaneously). */
  osc?: OscLayer[];
  /** Noise layers (played simultaneously). */
  noise?: NoiseLayer[];
  /** Total duration hint (seconds) — used for voice slot accounting. */
  duration: number;
  /** Minimum interval between consecutive plays of this sound (ms). */
  throttleMs: number;
}

// ---------------------------------------------------------------------------
// SFX Name type (union of all valid names)
// ---------------------------------------------------------------------------

export const SFX_NAMES = [
  'footstep_grass',
  'footstep_stone',
  'swing',
  'hit',
  'hurt',
  'pickup',
  'craft',
  'ui_click',
  'chest_open',
  'thunder',
  'splash',
  'eat_drink',
  'level_chime',
  'growl',
  'dragon_roar',
] as const;

export type SfxName = typeof SFX_NAMES[number];

// ---------------------------------------------------------------------------
// Recipe Table
// ---------------------------------------------------------------------------

export const SFX_RECIPES: Record<SfxName, SfxRecipe> = {
  footstep_grass: {
    name: 'footstep_grass',
    noise: [{
      color: 'brown',
      lowpass: 800,
      envelope: [0.005, 0.02, 0.06],
      gain: 0.35,
    }],
    duration: 0.09,
    throttleMs: 250,
  },

  footstep_stone: {
    name: 'footstep_stone',
    noise: [{
      color: 'white',
      highpass: 1200,
      lowpass: 4000,
      envelope: [0.002, 0.01, 0.04],
      gain: 0.3,
    }],
    osc: [{
      type: 'sine',
      freq: 220,
      envelope: [0.001, 0.005, 0.03],
      gain: 0.15,
    }],
    duration: 0.06,
    throttleMs: 250,
  },

  swing: {
    name: 'swing',
    noise: [{
      color: 'white',
      highpass: 2000,
      lowpass: 6000,
      envelope: [0.01, 0.04, 0.08],
      gain: 0.25,
    }],
    osc: [{
      type: 'sine',
      freq: 300,
      freqEnd: 150,
      envelope: [0.005, 0.03, 0.06],
      gain: 0.1,
    }],
    duration: 0.13,
    throttleMs: 200,
  },

  hit: {
    name: 'hit',
    noise: [{
      color: 'white',
      lowpass: 3000,
      envelope: [0.001, 0.01, 0.1],
      gain: 0.5,
    }],
    osc: [{
      type: 'square',
      freq: 150,
      freqEnd: 60,
      envelope: [0.001, 0.01, 0.08],
      gain: 0.3,
    }],
    duration: 0.12,
    throttleMs: 100,
  },

  hurt: {
    name: 'hurt',
    osc: [{
      type: 'sawtooth',
      freq: 400,
      freqEnd: 200,
      envelope: [0.005, 0.05, 0.15],
      gain: 0.25,
    }, {
      type: 'sine',
      freq: 180,
      freqEnd: 100,
      envelope: [0.01, 0.06, 0.12],
      gain: 0.2,
    }],
    noise: [{
      color: 'white',
      lowpass: 2500,
      envelope: [0.005, 0.03, 0.1],
      gain: 0.2,
    }],
    duration: 0.21,
    throttleMs: 300,
  },

  pickup: {
    name: 'pickup',
    osc: [{
      type: 'sine',
      freq: 600,
      freqEnd: 900,
      envelope: [0.005, 0.04, 0.08],
      gain: 0.25,
    }],
    duration: 0.13,
    throttleMs: 100,
  },

  craft: {
    name: 'craft',
    osc: [{
      type: 'triangle',
      freq: 440,
      freqEnd: 660,
      envelope: [0.01, 0.08, 0.15],
      gain: 0.2,
    }, {
      type: 'sine',
      freq: 880,
      envelope: [0.05, 0.04, 0.1],
      gain: 0.12,
    }],
    noise: [{
      color: 'white',
      highpass: 3000,
      envelope: [0.01, 0.02, 0.05],
      gain: 0.1,
    }],
    duration: 0.25,
    throttleMs: 400,
  },

  ui_click: {
    name: 'ui_click',
    osc: [{
      type: 'sine',
      freq: 1000,
      envelope: [0.001, 0.01, 0.03],
      gain: 0.15,
    }],
    duration: 0.04,
    throttleMs: 50,
  },

  chest_open: {
    name: 'chest_open',
    osc: [{
      type: 'triangle',
      freq: 300,
      freqEnd: 500,
      envelope: [0.01, 0.1, 0.2],
      gain: 0.2,
    }],
    noise: [{
      color: 'brown',
      lowpass: 600,
      envelope: [0.01, 0.05, 0.1],
      gain: 0.15,
    }],
    duration: 0.31,
    throttleMs: 500,
  },

  thunder: {
    name: 'thunder',
    noise: [{
      color: 'brown',
      lowpass: 400,
      envelope: [0.05, 0.3, 1.5],
      gain: 0.7,
    }, {
      color: 'white',
      lowpass: 1200,
      envelope: [0.01, 0.1, 0.4],
      gain: 0.3,
    }],
    osc: [{
      type: 'sine',
      freq: 50,
      freqEnd: 30,
      envelope: [0.1, 0.4, 1.0],
      gain: 0.4,
    }],
    duration: 2.0,
    throttleMs: 2000,
  },

  splash: {
    name: 'splash',
    noise: [{
      color: 'white',
      highpass: 500,
      lowpass: 5000,
      envelope: [0.005, 0.05, 0.2],
      gain: 0.35,
    }, {
      color: 'brown',
      lowpass: 800,
      envelope: [0.01, 0.03, 0.15],
      gain: 0.2,
    }],
    duration: 0.26,
    throttleMs: 200,
  },

  eat_drink: {
    name: 'eat_drink',
    osc: [{
      type: 'sine',
      freq: 250,
      freqEnd: 350,
      envelope: [0.01, 0.06, 0.1],
      gain: 0.15,
    }],
    noise: [{
      color: 'brown',
      lowpass: 1500,
      envelope: [0.01, 0.04, 0.08],
      gain: 0.15,
    }],
    duration: 0.17,
    throttleMs: 300,
  },

  level_chime: {
    name: 'level_chime',
    osc: [{
      type: 'sine',
      freq: 523,   // C5
      envelope: [0.01, 0.15, 0.3],
      gain: 0.3,
    }, {
      type: 'sine',
      freq: 659,   // E5 (a third above)
      envelope: [0.1, 0.15, 0.3],
      gain: 0.3,
    }],
    duration: 0.55,
    throttleMs: 2000,
  },

  growl: {
    name: 'growl',
    osc: [{
      type: 'sawtooth',
      freq: 80,
      freqEnd: 60,
      envelope: [0.02, 0.2, 0.3],
      gain: 0.3,
    }, {
      type: 'square',
      freq: 55,
      freqEnd: 45,
      detune: 10,
      envelope: [0.03, 0.15, 0.25],
      gain: 0.15,
    }],
    noise: [{
      color: 'brown',
      lowpass: 500,
      envelope: [0.02, 0.15, 0.2],
      gain: 0.2,
    }],
    duration: 0.52,
    throttleMs: 1000,
  },

  dragon_roar: {
    name: 'dragon_roar',
    osc: [{
      type: 'sawtooth',
      freq: 120,
      freqEnd: 60,
      envelope: [0.05, 0.4, 0.6],
      gain: 0.4,
    }, {
      type: 'square',
      freq: 90,
      freqEnd: 40,
      detune: -15,
      envelope: [0.08, 0.35, 0.5],
      gain: 0.25,
    }, {
      type: 'sine',
      freq: 200,
      freqEnd: 100,
      envelope: [0.03, 0.3, 0.4],
      gain: 0.2,
    }],
    noise: [{
      color: 'brown',
      lowpass: 800,
      envelope: [0.05, 0.3, 0.5],
      gain: 0.35,
    }, {
      color: 'white',
      highpass: 1000,
      lowpass: 4000,
      envelope: [0.1, 0.2, 0.3],
      gain: 0.15,
    }],
    duration: 1.1,
    throttleMs: 2000,
  },
};
