/**
 * SFX recipe definitions — pure data, no AudioContext dependency.
 *
 * Each recipe describes how to synthesize a one-shot sound effect using
 * oscillators, noise buffers, and gain envelopes. The GameAudio engine
 * interprets these recipes at play-time, and `scripts/audio-render.mts`
 * interprets the SAME data offline to render the audition WAVs — so what the
 * user auditions is what the game plays, and the two cannot drift.
 *
 * EVERYTHING IN THIS GAME IS SYNTHESIZED. There are no audio files. The credits
 * manifest at the bottom of this file exists anyway, because it is the guard for
 * the first imported file somebody adds — see `scripts/test-audio-credits.mjs`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OscType = 'sine' | 'square' | 'sawtooth' | 'triangle';
export type NoiseColor = 'white' | 'brown' | 'pink';

/** A single oscillator layer in a recipe. */
export interface OscLayer {
  type: OscType;
  /** Base frequency in Hz. Runtime applies +-10% SEEDED variation. */
  freq: number;
  /** Optional end frequency for a sweep (portamento). */
  freqEnd?: number;
  /** Detune in cents (optional). */
  detune?: number;
  /** Gain envelope — [attack, hold, decay] in seconds. */
  envelope: [number, number, number];
  /** Peak gain during hold phase (0..1). Default 1. */
  gain?: number;
  /**
   * Stepped amplitude flicker, in steps per second. 0/absent = steady.
   *
   * Modelled on `tintreach.ts` `boltIntensity`: the seam re-strikes at
   * RESTRIKE_HZ and its brightness jumps to a new seeded value each step
   * rather than sliding. A ramp reads as a tremolo; a step reads as arcing.
   */
  flickerHz?: number;
  /** How far the flicker drops below peak, 0..1. 0.45 == tintreach's 0.55..1.0. */
  flickerDepth?: number;
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
  /** Stepped amplitude flicker, steps per second. See OscLayer.flickerHz. */
  flickerHz?: number;
  /** How far the flicker drops below peak, 0..1. */
  flickerDepth?: number;
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
  /**
   * Distance at which this sound falls to silence, metres. Default 50.
   *
   * Per-recipe because ONE number cannot serve both a footstep and a dragon.
   * With the old fixed 50 m, `main.ts` playing `dragon_roar` at `{dist:40}`
   * got 0.2 gain — a dragon forty metres away was quieter than a boot on
   * grass — and any roar past 50 m was silent outright. A thunderclap that
   * cannot be heard from the far side of a field is not a thunderclap.
   */
  maxDist?: number;
}

// ---------------------------------------------------------------------------
// SFX Name type (union of all valid names)
// ---------------------------------------------------------------------------

export const SFX_NAMES = [
  // --- movement -----------------------------------------------------------
  'footstep_grass',
  'footstep_stone',
  'footstep_wood',
  'footstep_sand',
  // --- melee / damage -----------------------------------------------------
  'swing',
  'hit',
  'hurt',
  'shield_block',
  'shield_parry',
  // --- archery ------------------------------------------------------------
  'bow_draw',
  'bow_loose',
  'tintreach_bolt',
  // --- interaction --------------------------------------------------------
  'pickup',
  'craft',
  'ui_click',
  'lock_on',
  'lock_off',
  'chest_open',
  'chest_close',
  'door_open',
  'door_close',
  'torch_light',
  'torch_douse',
  'eat_drink',
  'level_chime',
  // --- world / creatures --------------------------------------------------
  'thunder',
  'splash',
  'growl',
  'dragon_roar',
] as const;

export type SfxName = typeof SFX_NAMES[number];

/**
 * Ids registered but with no call site yet. Kept out of the "dead content"
 * failure in `scripts/test-audio.mts` deliberately, so the roster can be
 * complete before the feature lands without the suite going permanently amber.
 *
 * `shield_block` / `shield_parry` — shields are not implemented. The recipes
 * exist so the wave that adds them adds one `audio.play` line and nothing else.
 * `level_chime` — the one genuinely orphaned id: it predates this file and has
 * never had a call site. Wiring it means one line at the level-up detection in
 * main.ts, which this deliverable does not own.
 */
export const SFX_RESERVED: readonly SfxName[] = [
  'shield_block',
  'shield_parry',
  'level_chime',
];

// ---------------------------------------------------------------------------
// Canonical variant selection
// ---------------------------------------------------------------------------

/**
 * Which seeded variant of each sfx is canonical — a ONE-LINE swap per sound.
 *
 * A "variant" is not a different recipe. It is the same recipe with a different
 * seed, and the seed drives the +-10% pitch jitter, the read offset into the
 * shared noise buffer, and the flicker steps. For noise-heavy sounds (every
 * footstep, the whole tintreach bolt) the offset alone changes the grain
 * audibly; for the pure-tone ones (`ui_click`, `lock_on`) it is only pitch.
 *
 * `scripts/audition-sfx.mts` renders variants 0..3 of every sound as WAVs.
 * Changing the number here makes the game's FIRST shot of that sound identical
 * to the corresponding audition file — later shots walk on from there, because
 * a sound that is byte-identical every time is what makes footsteps read as a
 * machine.
 */
export const SFX_VARIANT: Record<SfxName, number> = {
  footstep_grass: 0,
  footstep_stone: 0,
  footstep_wood: 0,
  footstep_sand: 0,
  swing: 0,
  hit: 0,
  hurt: 0,
  shield_block: 0,
  shield_parry: 0,
  bow_draw: 0,
  bow_loose: 0,
  tintreach_bolt: 0,
  pickup: 0,
  craft: 0,
  ui_click: 0,
  lock_on: 0,
  lock_off: 0,
  chest_open: 0,
  chest_close: 0,
  door_open: 0,
  door_close: 0,
  torch_light: 0,
  torch_douse: 0,
  eat_drink: 0,
  level_chime: 0,
  thunder: 0,
  splash: 0,
  growl: 0,
  dragon_roar: 0,
};

/** How many seeded variants the audition pack renders per sound. */
export const SFX_VARIANT_COUNT = 4;

// ---------------------------------------------------------------------------
// Recipe Table
// ---------------------------------------------------------------------------

export const SFX_RECIPES: Record<SfxName, SfxRecipe> = {
  // =========================================================================
  // Movement
  // =========================================================================

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

  /**
   * Board over a void. The bandpassed brown noise is the impact; the 165 Hz
   * sine under it is the hollow the boards are nailed over, which is the only
   * thing that tells wood apart from stone at a glance.
   */
  footstep_wood: {
    name: 'footstep_wood',
    noise: [{
      color: 'brown',
      bandpass: { freq: 420, Q: 3 },
      envelope: [0.002, 0.012, 0.055],
      gain: 0.32,
    }, {
      color: 'white',
      highpass: 2200,
      envelope: [0.001, 0.004, 0.02],
      gain: 0.08,
    }],
    osc: [{
      type: 'sine',
      freq: 165,
      freqEnd: 140,
      envelope: [0.001, 0.006, 0.045],
      gain: 0.13,
    }],
    duration: 0.08,
    throttleMs: 250,
  },

  /**
   * Dry sand. No impact transient at all — the slowest attack of any footstep
   * (8 ms) because sand absorbs the strike and gives back only the shuffle.
   */
  footstep_sand: {
    name: 'footstep_sand',
    noise: [{
      color: 'white',
      bandpass: { freq: 1500, Q: 0.7 },
      envelope: [0.008, 0.03, 0.09],
      gain: 0.24,
    }, {
      color: 'brown',
      lowpass: 500,
      envelope: [0.004, 0.015, 0.05],
      gain: 0.12,
    }],
    duration: 0.14,
    throttleMs: 250,
  },

  // =========================================================================
  // Melee / damage
  // =========================================================================

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

  /**
   * RESERVED — shields are not implemented. See SFX_RESERVED.
   *
   * A hide-over-board shield eating a blow: all body, no ring. The square at
   * 130 -> 70 Hz is the board flexing, the lowpassed brown is the hide.
   */
  shield_block: {
    name: 'shield_block',
    noise: [{
      color: 'brown',
      lowpass: 700,
      envelope: [0.001, 0.012, 0.11],
      gain: 0.4,
    }, {
      color: 'white',
      bandpass: { freq: 1800, Q: 1.0 },
      envelope: [0.001, 0.006, 0.05],
      gain: 0.15,
    }],
    osc: [{
      type: 'square',
      freq: 130,
      freqEnd: 70,
      envelope: [0.001, 0.01, 0.09],
      gain: 0.22,
    }],
    duration: 0.13,
    throttleMs: 120,
  },

  /**
   * RESERVED — shields are not implemented. See SFX_RESERVED.
   *
   * The deliberate deflect, and the deliberate opposite of `shield_block`:
   * bright, rising, and four times as long, because a parry is a reward and
   * has to ring for long enough to register as one.
   */
  shield_parry: {
    name: 'shield_parry',
    osc: [{
      type: 'triangle',
      freq: 1250,
      freqEnd: 1650,
      envelope: [0.001, 0.02, 0.16],
      gain: 0.16,
    }, {
      type: 'sine',
      freq: 2480,
      detune: 7,
      envelope: [0.002, 0.02, 0.14],
      gain: 0.09,
    }],
    noise: [{
      color: 'white',
      highpass: 3500,
      envelope: [0.001, 0.008, 0.07],
      gain: 0.2,
    }],
    duration: 0.19,
    throttleMs: 150,
  },

  // =========================================================================
  // Archery
  // =========================================================================

  /**
   * The draw. A creak, not a whoosh.
   *
   * The 14 Hz flicker on a narrow 320 Hz band is the whole sound: limb wood
   * under load does not groan smoothly, it slips in steps. The sawtooth
   * climbing 140 -> 190 Hz underneath is the string tension, and it rises for
   * the full 0.4 s so the ear can hear the draw filling.
   */
  bow_draw: {
    name: 'bow_draw',
    noise: [{
      color: 'brown',
      bandpass: { freq: 320, Q: 4 },
      // 0.75, not the 0.24 it was written with. A Q=4 band 80 Hz wide throws
      // away almost all of brown noise's energy, and the offline render put the
      // whole sound at -20.6 dBFS peak — under the rain bed it would have been
      // inaudible. The gain field is pre-filter, so it has to compensate.
      envelope: [0.06, 0.16, 0.18],
      gain: 0.75,
      flickerHz: 14,
      flickerDepth: 0.5,
    }],
    osc: [{
      type: 'sawtooth',
      freq: 140,
      freqEnd: 190,
      envelope: [0.08, 0.14, 0.16],
      gain: 0.14,
    }],
    duration: 0.42,
    throttleMs: 200,
  },

  /** String release: the snap, the limb thump, and nothing else. */
  bow_loose: {
    name: 'bow_loose',
    noise: [{
      color: 'white',
      bandpass: { freq: 2600, Q: 1.2 },
      envelope: [0.001, 0.008, 0.06],
      gain: 0.28,
    }, {
      color: 'brown',
      lowpass: 900,
      envelope: [0.002, 0.01, 0.09],
      gain: 0.12,
    }],
    osc: [{
      type: 'triangle',
      freq: 210,
      freqEnd: 90,
      envelope: [0.001, 0.006, 0.07],
      gain: 0.2,
    }],
    duration: 0.11,
    throttleMs: 120,
  },

  /**
   * TINTREACH — the artifact lightning bow. The game's signature effect.
   *
   * Second redesign, from a playtest verdict: the first version sustained
   * narrow 5.2/8 kHz bands with a PERIODIC 10 Hz flicker through the burn
   * window, and a steady pitched sizzle is the sound of a laser beam, not of
   * lightning. What lightning sounds like is THUNDER — so this is the weather
   * `thunder` recipe's anatomy (brown rumble, mid tear, sub swell) detonated
   * at arm's length: instant crack, no roll-in, and a tail that RUMBLES
   * instead of sizzling. Nothing in it is periodic.
   *
   * The visual sync points survive from `tintreach.ts`, to the millisecond:
   *
   *   STRIKE_S = 0.055  the crack: layers 1-2 and the snap osc all end here.
   *   BURN_S   = 0.34   the close-range tearing rip ends with the seam's burn.
   *   LIFE_S   = 1.10   the rolling decay dies on the frame the seam does.
   *
   * The rumble and the sub tail run past LIFE_S to 1.8 s, deliberately: the
   * flash is over before the air is. Thunder outlasting the light is the one
   * cue every human already knows, and cutting the reverberation dead at the
   * seam's last frame is what made the old tail feel synthetic.
   *
   * `maxDist` is 220 m: this is lightning, and the whole valley hears it.
   */
  tintreach_bolt: {
    name: 'tintreach_bolt',
    noise: [
      // 1. The crack. Hard, bright, 55 ms, 0.8 ms attack — as close to an
      //    instantaneous edge as a linear ramp gets without a click.
      {
        color: 'white',
        highpass: 1800,
        envelope: [0.0008, 0.006, 0.048],
        gain: 0.29,
      },
      // 2. Body under the crack, so it lands as a blow rather than a hiss.
      {
        color: 'white',
        bandpass: { freq: 900, Q: 0.8 },
        envelope: [0.001, 0.01, 0.044],
        gain: 0.16,
      },
      // 4. The tear. Wideband mid noise falling away through the burn window
      //    — close thunder's ripping-canvas edge. Aperiodic on purpose; the
      //    10 Hz flicker this replaces is what read as a beam.
      {
        color: 'white',
        lowpass: 1400,
        envelope: [0.008, 0.092, 0.24],
        gain: 0.12,
      },
      // 5. The rumble: the weather thunder's main brown layer, faster attack
      //    because the strike is overhead, running past the seam to 1.8 s.
      {
        color: 'brown',
        lowpass: 320,
        envelope: [0.05, 0.26, 1.49],
        gain: 0.26,
      },
      // 6. The rolling decay. Ends at LIFE_S exactly.
      {
        color: 'brown',
        lowpass: 220,
        envelope: [0.05, 0.2, 0.85],
        gain: 0.20,
      },
    ],
    osc: [
      // 3. The snap transient inside the crack window. Crack layers 1-3 are
      // gain-budgeted together — the loudest thing in the game and still
      // under -1 dBFS at volume 1.0 (measured by test-audio's peak scan).
      {
        type: 'square',
        freq: 1800,
        freqEnd: 520,
        envelope: [0.0005, 0.004, 0.05],
        gain: 0.06,
      },
      // 7. The low body of the discharge, falling away with the tail.
      {
        type: 'sine',
        freq: 88,
        freqEnd: 34,
        envelope: [0.03, 0.18, 0.84],
        gain: 0.16,
      },
      // 8. The sub swell under the rumble — thunder's 50 Hz floor an octave
      // of menace below anything else in the mix, out to the full tail.
      {
        type: 'sine',
        freq: 48,
        freqEnd: 28,
        envelope: [0.05, 0.35, 1.4],
        gain: 0.16,
      },
    ],
    duration: 1.8,
    throttleMs: 220,
    maxDist: 220,
  },

  // =========================================================================
  // Interaction
  // =========================================================================

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

  /**
   * Lock acquired. Rises a fourth (880 -> 1180) with its octave stacked on top.
   *
   * Diegetic-adjacent rather than a UI beep: it fires in combat, under a fight
   * mix, and has to cut through without being a menu sound. The pair
   * `lock_on`/`lock_off` are deliberately built to differ in TWO dimensions at
   * once — direction of glide and harmonic content (on has an octave partial,
   * off has a noise tick) — because at low volume a glide alone is not enough
   * to tell them apart, and getting them the wrong way round tells the player
   * they still have a lock when they do not.
   */
  lock_on: {
    name: 'lock_on',
    osc: [{
      type: 'sine',
      freq: 880,
      freqEnd: 1180,
      envelope: [0.002, 0.012, 0.05],
      gain: 0.16,
    }, {
      type: 'sine',
      freq: 1760,
      freqEnd: 2360,
      envelope: [0.004, 0.008, 0.04],
      gain: 0.07,
    }],
    duration: 0.07,
    throttleMs: 120,
  },

  /** Lock released. Falls (780 -> 560), no octave, with a dry tick on the front. */
  lock_off: {
    name: 'lock_off',
    osc: [{
      type: 'sine',
      freq: 780,
      freqEnd: 560,
      envelope: [0.002, 0.01, 0.055],
      gain: 0.14,
    }],
    noise: [{
      color: 'white',
      highpass: 4000,
      envelope: [0.001, 0.004, 0.02],
      gain: 0.05,
    }],
    duration: 0.07,
    throttleMs: 120,
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

  /** The lid coming down. `chest_open` rises 300->500; this falls 260->150. */
  chest_close: {
    name: 'chest_close',
    noise: [{
      color: 'brown',
      lowpass: 900,
      envelope: [0.002, 0.018, 0.12],
      gain: 0.3,
    }, {
      color: 'white',
      highpass: 2600,
      envelope: [0.001, 0.006, 0.03],
      gain: 0.12,
    }],
    osc: [{
      type: 'triangle',
      freq: 260,
      freqEnd: 150,
      envelope: [0.002, 0.015, 0.1],
      gain: 0.16,
    }],
    duration: 0.16,
    throttleMs: 500,
  },

  /**
   * A hinge that has never been oiled. The 11 Hz flicker on a Q=5 band at
   * 260 Hz is the stick-slip of the creak; the highpassed tick on the front is
   * the latch letting go before the door has moved at all.
   */
  door_open: {
    name: 'door_open',
    noise: [{
      color: 'brown',
      bandpass: { freq: 260, Q: 5 },
      envelope: [0.03, 0.22, 0.24],
      gain: 0.22,
      flickerHz: 11,
      flickerDepth: 0.55,
    }, {
      color: 'white',
      highpass: 1800,
      envelope: [0.001, 0.006, 0.04],
      gain: 0.12,
    }],
    osc: [{
      type: 'sawtooth',
      freq: 120,
      freqEnd: 165,
      envelope: [0.04, 0.2, 0.22],
      gain: 0.05,
    }],
    duration: 0.52,
    throttleMs: 300,
  },

  /** Thud then latch. No creak: a door being closed is pushed, not eased. */
  door_close: {
    name: 'door_close',
    noise: [{
      color: 'brown',
      lowpass: 600,
      envelope: [0.002, 0.02, 0.16],
      gain: 0.38,
    }, {
      color: 'white',
      bandpass: { freq: 2400, Q: 1.4 },
      envelope: [0.001, 0.005, 0.035],
      gain: 0.14,
    }],
    osc: [{
      type: 'square',
      freq: 96,
      freqEnd: 52,
      envelope: [0.001, 0.012, 0.12],
      gain: 0.2,
    }],
    duration: 0.2,
    throttleMs: 300,
  },

  /**
   * Strike, catch, burn. The 18 Hz flicker on the lowpassed brown is the flame
   * finding the pitch — it has to be irregular for the half-second after the
   * strike or the torch reads as switching on rather than catching.
   */
  torch_light: {
    name: 'torch_light',
    noise: [{
      color: 'white',
      highpass: 2500,
      lowpass: 9000,
      envelope: [0.001, 0.01, 0.05],
      gain: 0.26,
    }, {
      color: 'brown',
      lowpass: 1100,
      envelope: [0.03, 0.10, 0.34],
      gain: 0.3,
      flickerHz: 18,
      flickerDepth: 0.35,
    }],
    osc: [{
      type: 'sine',
      freq: 180,
      freqEnd: 120,
      envelope: [0.02, 0.08, 0.24],
      gain: 0.1,
    }],
    duration: 0.48,
    throttleMs: 400,
  },

  /** Quench. A fast 24 Hz flicker on a steam band, dying into a wet thud. */
  torch_douse: {
    name: 'torch_douse',
    noise: [{
      color: 'white',
      bandpass: { freq: 3200, Q: 0.9 },
      envelope: [0.004, 0.05, 0.34],
      gain: 0.26,
      flickerHz: 24,
      flickerDepth: 0.3,
    }, {
      color: 'brown',
      lowpass: 500,
      envelope: [0.002, 0.02, 0.14],
      gain: 0.16,
    }],
    osc: [{
      type: 'sine',
      freq: 320,
      freqEnd: 110,
      envelope: [0.003, 0.03, 0.16],
      gain: 0.07,
    }],
    duration: 0.40,
    throttleMs: 400,
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

  /** RESERVED — no call site. See SFX_RESERVED. */
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

  // =========================================================================
  // World / creatures
  // =========================================================================

  thunder: {
    name: 'thunder',
    // Gains scaled 0.75x from the originals (0.7 / 0.3 / 0.4). The offline
    // render measured +1.17 dBFS peak with 354 hard-clipped samples: three
    // layers whose envelopes all overlap between 0.1 s and 0.4 s, summed
    // without a budget. Nobody heard it because the master gain defaults to
    // 0.6 — set the volume slider to 1.0 and every storm was distorting.
    noise: [{
      color: 'brown',
      lowpass: 400,
      envelope: [0.05, 0.3, 1.5],
      gain: 0.47,
    }, {
      color: 'white',
      lowpass: 1200,
      envelope: [0.01, 0.1, 0.4],
      gain: 0.20,
    }],
    osc: [{
      type: 'sine',
      freq: 50,
      freqEnd: 30,
      envelope: [0.1, 0.4, 1.0],
      gain: 0.27,
    }],
    duration: 2.0,
    throttleMs: 2000,
    // Weather lightning strikes anywhere in the loaded world. `main.ts` passes
    // the true strike distance, and at the old 50 m default every strike but a
    // near miss was silent — a storm you could see and not hear.
    maxDist: 400,
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
    maxDist: 60,
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
    // A wolf going aggro is a warning, and a warning you cannot hear from the
    // far side of a clearing is not one. LOCK_ACQUIRE_RANGE is 22 m; 60 gives
    // the growl a real presence at the range the fight actually starts.
    maxDist: 60,
  },

  dragon_roar: {
    name: 'dragon_roar',
    // Gains scaled 0.8x from the originals. Same defect as `thunder`: five
    // overlapping layers, +0.77 dBFS peak, 57 clipped samples in the offline
    // render. It stays the second-loudest thing in the game behind the bolt.
    osc: [{
      type: 'sawtooth',
      freq: 120,
      freqEnd: 60,
      envelope: [0.05, 0.4, 0.6],
      gain: 0.25,
    }, {
      type: 'square',
      freq: 90,
      freqEnd: 40,
      detune: -15,
      envelope: [0.08, 0.35, 0.5],
      gain: 0.16,
    }, {
      type: 'sine',
      freq: 200,
      freqEnd: 100,
      envelope: [0.03, 0.3, 0.4],
      gain: 0.12,
    }],
    noise: [{
      color: 'brown',
      lowpass: 800,
      envelope: [0.05, 0.3, 0.5],
      gain: 0.22,
    }, {
      color: 'white',
      highpass: 1000,
      lowpass: 4000,
      envelope: [0.1, 0.2, 0.3],
      gain: 0.09,
    }],
    duration: 1.1,
    throttleMs: 2000,
    // `main.ts:2305` plays this at a hardcoded 40 m. Under the old 50 m default
    // that was 0.2 gain — the loudest creature in the game arriving quieter
    // than a footstep — and every roar at 50 m or beyond was dropped outright.
    maxDist: 160,
  },
};

// ---------------------------------------------------------------------------
// Ambience beds
// ---------------------------------------------------------------------------

/**
 * One filtered noise loop inside an ambience bed.
 *
 * Beds are NOT recipes. A recipe is a one-shot with an envelope that ends; a
 * bed is a permanent looping node whose gain is ramped by `setAmbience` every
 * frame. They are described here anyway, as data, for the same reason the
 * recipes are: `audio-engine.ts` builds the graph from this and
 * `scripts/audio-render.mts` renders the audition WAVs from it, so the bed the
 * user auditions is the bed the game plays.
 */
export interface AmbienceBedLayer {
  color: NoiseColor;
  filter: 'lowpass' | 'highpass' | 'bandpass';
  freq: number;
  Q: number;
  /** Relative gain within the bed, 0..1. */
  gain: number;
  /** Slow amplitude wobble, Hz. Absent = steady. */
  lfoHz?: number;
  /** Wobble depth, 0..1. */
  lfoDepth?: number;
}

export interface AmbienceBed {
  name: string;
  /** Peak gain of the whole bed at intensity 1. */
  gain: number;
  layers: AmbienceBedLayer[];
}

export const AMBIENCE_BED_NAMES = ['rain_roof', 'dungeon', 'castle'] as const;
export type AmbienceBedName = typeof AMBIENCE_BED_NAMES[number];

export const AMBIENCE_BEDS: Record<AmbienceBedName, AmbienceBed> = {
  /**
   * Rain heard from under a roof. The open-air rain bed is HIGHPASSED at 3 kHz
   * — that hiss is what rain sounds like falling past you. Under a roof you
   * hear the opposite: the high end is gone and what is left is the drumming,
   * so this is lowpassed at 1.2 kHz with a 340 Hz band under it for the patter
   * on the boards. `setAmbience` ducks the open bed to 28% when sheltered
   * rather than to zero, because a roof is not a seal.
   */
  rain_roof: {
    name: 'rain_roof',
    gain: 0.26,
    layers: [
      { color: 'white', filter: 'lowpass', freq: 1200, Q: 0.6, gain: 1.0, lfoHz: 0.11, lfoDepth: 0.22 },
      { color: 'brown', filter: 'bandpass', freq: 340, Q: 1.2, gain: 0.55, lfoHz: 0.07, lfoDepth: 0.3 },
    ],
  },

  /**
   * Underground. A 120 Hz rumble that is really the absence of everything
   * else, plus one thin Q=3 resonance at 900 Hz for the air moving through
   * stone. Quiet on purpose — a dungeon bed you notice is a dungeon bed that
   * will be unbearable twenty minutes in.
   */
  dungeon: {
    name: 'dungeon',
    gain: 0.18,
    layers: [
      { color: 'brown', filter: 'lowpass', freq: 120, Q: 0.7, gain: 1.0, lfoHz: 0.05, lfoDepth: 0.35 },
      { color: 'pink', filter: 'bandpass', freq: 900, Q: 3.0, gain: 0.22, lfoHz: 0.13, lfoDepth: 0.5 },
    ],
  },

  /**
   * A stone hall. Same idea as the dungeon bed pitched up and opened out — a
   * 200 Hz Q=1.6 hollow instead of a 120 Hz rumble, plus a highpassed draught
   * at a tenth the gain for the windows.
   */
  castle: {
    name: 'castle',
    gain: 0.14,
    layers: [
      { color: 'brown', filter: 'bandpass', freq: 200, Q: 1.6, gain: 1.0, lfoHz: 0.09, lfoDepth: 0.4 },
      { color: 'white', filter: 'highpass', freq: 2600, Q: 0.6, gain: 0.1, lfoHz: 0.06, lfoDepth: 0.5 },
    ],
  },
};

// ---------------------------------------------------------------------------
// Sourcing policy + credits manifest
// ---------------------------------------------------------------------------

/**
 * One IMPORTED audio file and where it came from.
 *
 * The game currently imports zero audio files — every sound above is
 * synthesized at runtime from oscillators and seeded noise — so `AUDIO_CREDITS`
 * is empty and is SUPPOSED to be empty. The machinery exists because the first
 * time somebody drags a freesound.org .wav into `public/` is exactly the moment
 * nobody will remember to write the licence down, and shipping an NC- or
 * SA-licensed sample in a commercial Steam build is a takedown, not a bug.
 *
 * `scripts/test-audio-credits.mjs` walks the shipped asset directories and
 * fails if it finds an audio file with no entry here, or an entry with a
 * licence outside `ALLOWED_AUDIO_LICENCES`.
 */
export interface AudioCredit {
  /** Path relative to the repo root, forward slashes. */
  file: string;
  /** Where it was obtained. */
  url: string;
  /** Who made it. */
  author: string;
  /** Must be one of ALLOWED_AUDIO_LICENCES, verbatim. */
  licence: string;
  /** Optional note — edits made, attribution string required, etc. */
  note?: string;
}

/**
 * Licences an imported audio file may carry. Exclusive: anything not on this
 * list fails the guard, so a new licence is a deliberate decision by a human
 * rather than something that slips in with an asset.
 *
 * CC0-1.0    — public domain dedication. No attribution obligation, but we
 *              still record the source so provenance is auditable.
 * CC-BY-4.0  — attribution required. The manifest entry IS the attribution,
 *              and the credits panel renders it.
 *
 * Everything else is refused. See FORBIDDEN_AUDIO_LICENCES for the ones that
 * are refused loudly because they are the ones people actually reach for.
 */
export const ALLOWED_AUDIO_LICENCES: readonly string[] = [
  'CC0-1.0',
  'CC-BY-4.0',
];

/**
 * Patterns that get a named refusal rather than a generic "not on the allow
 * list". Modelled on the FORBIDDEN_ASSETS block in `scripts/pack-steam.mjs`.
 */
export const FORBIDDEN_AUDIO_LICENCES: readonly { pattern: RegExp; why: string }[] = [
  {
    pattern: /\bNC\b|non-?commercial/i,
    why: 'NonCommercial. This is a commercial Steam release; NC forbids it outright.',
  },
  {
    pattern: /\bSA\b|share-?alike/i,
    why: 'ShareAlike. Copyleft on a derivative work in a closed-source game build.',
  },
  {
    pattern: /\bBBC\b/i,
    why: 'BBC Sound Effects are licensed for personal, educational and research '
      + 'use only — explicitly not for commercial products.',
  },
  {
    pattern: /\bGPL\b|AGPL/i,
    why: 'GPL-family. Incompatible with the Steamworks SDK — same reason '
      + 'pack-steam.mjs refuses eSpeak NG.',
  },
  {
    pattern: /\bND\b|no-?derivat/i,
    why: 'NoDerivatives. Any pitch-shift, trim or mix is a derivative.',
  },
];

/**
 * The in-bundle credits list, in the shape a credits panel renders from.
 *
 * MIRRORS `scripts/audio-credits.json`, which is the file a human edits when
 * adding an imported asset. Two copies, because the panel must not import from
 * `scripts/` and the guard must not import from a bundle — and
 * `scripts/test-audio-credits.mjs` asserts they are deep-equal, so the
 * duplication cannot drift silently. Adding an asset means editing both, and
 * the test tells you when you forgot.
 */
export const AUDIO_CREDITS: readonly AudioCredit[] = [];
