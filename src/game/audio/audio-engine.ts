/**
 * GameAudio — Procedural WebAudio engine for ArtifexWebGame.
 *
 * Fully synthesized (oscillators + filtered noise + envelopes). No audio files.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * DETERMINISM
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This file used to call `Math.random()` in five places: the pitch jitter on
 * every oscillator, all three noise-buffer fills, the noise read offset, and the
 * cricket scheduler. None of them do now, and none of them may again —
 * `scripts/test-audio.mts` greps this source and fails on the string.
 *
 * The scheme:
 *
 *   - The three shared noise buffers are generated from FIXED seeds, so they are
 *     byte-identical on every run and on every machine. They are 2 s of PCM that
 *     every noise layer reads a window out of; if they differ between runs then
 *     nothing downstream can be reproduced, including the audition renders.
 *   - Every shot gets a seed from `sfxSeed(name, eventIndex, variant)`. The
 *     event index is a monotonic per-name counter, so successive footsteps
 *     differ — but footstep #7 is always the same footstep #7.
 *   - Each LAYER within a shot re-seeds its own `mulberry32` from
 *     `layerSeed(shotSeed, i, isNoise)` and draws from it in a fixed order
 *     (`layerParams`). Re-seeding per layer rather than sharing one stream means
 *     the draw ORDER across layers cannot matter, which is what lets
 *     `scripts/audio-render.mts` reproduce a shot offline, sample for sample,
 *     without having to imitate the exact node-construction sequence.
 *   - Crickets run off one `mulberry32` seeded at ambience init.
 *
 * `mulberry32` is imported from mesh-utils (a leaf module with no imports of its
 * own, so the edge costs nothing). `mix32` and `idHash` are copied in below
 * rather than imported, because their homes — `dungeon/dungeon-layout.ts` and
 * `combat/attack-tokens.ts` — would drag dungeon generation and combat
 * arbitration into every bundle that wants a click sound. `attack-tokens.ts`
 * and `building-interior.ts` already duplicate on the same reasoning.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * INTEGRATION API — how the wiring agent hooks this into main.ts:
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 1. IMPORT & CONSTRUCT (top of main.ts, after other imports):
 *      import { GameAudio } from './game/audio/audio-engine';
 *      const audio = new GameAudio();
 *
 * 2. RESUME ON FIRST USER GESTURE (required by browser autoplay policy):
 *      document.addEventListener('pointerdown', () => audio.resume(), { once: true });
 *      document.addEventListener('keydown', () => audio.resume(), { once: true });
 *
 * 3. PER-FRAME AMBIENCE UPDATE (inside the main render loop, after weather/time calc):
 *      audio.setAmbience({
 *        wind: weather.cloudCover,          // 0..1
 *        rain: weather.rainLevel,           // 0..1
 *        night: isNight,                    // boolean (simTime-based)
 *        interior: inDungeon,               // boolean (player in dungeon/building)
 *        fireNear: nearFireIntensity,       // 0..1 (from fire proximity, e.g. fireWarmthAt)
 *        // --- all optional, default 0/false, safe to omit ---
 *        sheltered: shelterTier(...) > 0,   // under a roof/canopy: swaps the rain bed
 *        dungeon: inDungeon ? 1 : 0,        // 0..1 dungeon bed
 *        castle: inCastle ? 1 : 0,          // 0..1 great-hall bed
 *      });
 *
 * 4. ONE-SHOT SFX CALLS (at the event sites):
 *      - Walk cycle phase wrap:       audio.play('footstep_grass' | '_stone' | '_wood' | '_sand')
 *      - Player swing animation:      audio.play('swing')
 *      - Damage dealt to entity:      audio.play('hit')
 *      - Player takes damage:         audio.play('hurt')
 *      - Bow draw begins:             audio.play('bow_draw')
 *      - Ordinary arrow loosed:       audio.play('bow_loose')
 *      - Tintreach loosed:            audio.play('tintreach_bolt')     <- NOT 'thunder'
 *      - Lock acquired / released:    audio.play('lock_on') / audio.play('lock_off')
 *      - Item picked up:              audio.play('pickup')
 *      - Craft success:               audio.play('craft')
 *      - Any UI button click:         audio.play('ui_click')
 *      - Chest opened / closed:       audio.play('chest_open') / audio.play('chest_close')
 *      - Door opened / closed:        audio.play('door_open') / audio.play('door_close')
 *      - Torch lit / doused:          audio.play('torch_light') / audio.play('torch_douse')
 *      - Weather lightning:           audio.play('thunder', { dist: strikeDist })
 *      - Player enters water:         audio.play('splash')
 *      - Consume food/water:          audio.play('eat_drink')
 *      - Level-up detected:           audio.play('level_chime')        <- still unwired
 *      - Wolf enters aggro state:     audio.play('growl', { dist: wolfDist })
 *      - Dragon encounter:            audio.play('dragon_roar', { dist: dragonDist })
 *      - RESERVED, no feature yet:    'shield_block', 'shield_parry'
 *
 * 5. VOLUME / MUTE (settings panel):
 *      audio.setVolume(0.7);   // 0..1
 *      audio.muted = true;     // toggle mute
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
  SFX_RECIPES, SFX_NAMES, SFX_VARIANT, AMBIENCE_BEDS, AMBIENCE_BED_NAMES,
  type SfxName, type SfxRecipe, type OscLayer, type NoiseLayer,
  type NoiseColor, type AmbienceBedName, type AmbienceBedLayer,
} from './sfx';

import { mulberry32 } from '../mesh-utils';

// Re-export for convenience
export { SFX_NAMES, type SfxName } from './sfx';

// ---------------------------------------------------------------------------
// Seed derivation (pure — shared with the offline renderer)
// ---------------------------------------------------------------------------

/**
 * Mix three 32-bit ints into one.
 *
 * Mirrors `mix32` in `src/game/dungeon/dungeon-layout.ts`. Copied rather than
 * imported so a click sound does not pull dungeon generation into the bundle;
 * see the determinism note at the top of this file. If that one changes, this
 * one has to change with it, and `scripts/test-audio.mts` pins the values.
 */
export function mix32(a: number, b: number, c = 0): number {
  let h = a >>> 0;
  h = Math.imul(h ^ (b >>> 0), 0x9e3779b1);
  h = ((h << 13) | (h >>> 19)) >>> 0;
  h = Math.imul(h ^ (c >>> 0), 0x85ebca6b);
  h = ((h << 13) | (h >>> 19)) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * FNV-1a over a string id.
 *
 * Mirrors `idHash` in `src/game/combat/attack-tokens.ts`, which is itself the
 * third copy of this five-line function in the codebase for the same reason.
 */
export function idHash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The seed for one shot of one sound.
 *
 * `event` is the monotonic per-name play counter, so consecutive footsteps get
 * different grain; `variant` is `SFX_VARIANT[name]`, the canonical take chosen
 * from the audition pack. Event 0 of the chosen variant is exactly the WAV in
 * `scripts/shots/audition/`.
 */
export function sfxSeed(name: string, event: number, variant = 0): number {
  return mix32(idHash(name), event >>> 0, variant >>> 0);
}

/** The seed for one layer inside a shot. Noise and osc layers cannot collide. */
export function layerSeed(shot: number, index: number, isNoise: boolean): number {
  return mix32(shot, index >>> 0, isNoise ? 0x9e : 0x51);
}

// ---------------------------------------------------------------------------
// Pure helper functions (testable under Node without AudioContext)
// ---------------------------------------------------------------------------

/**
 * Compute distance-based gain attenuation.
 * dist 0 -> gain 1, dist >= maxDist -> gain 0. Linear rolloff.
 *
 * The 50 m default is the FOOTSTEP scale. Anything that should carry further
 * sets `maxDist` on its recipe; `play()` passes it through.
 */
export function distanceGain(dist: number, maxDist = 50): number {
  if (dist <= 0) return 1;
  if (dist >= maxDist) return 0;
  return 1 - dist / maxDist;
}

/**
 * Compute total envelope duration from [attack, hold, decay].
 */
export function envelopeDuration(env: readonly [number, number, number]): number {
  return env[0] + env[1] + env[2];
}

/**
 * Compute the envelope gain at a given time offset.
 * Returns 0..peakGain following attack/hold/decay shape.
 */
export function envelopeAt(
  env: readonly [number, number, number],
  t: number,
  peakGain = 1,
): number {
  const [a, h, d] = env;
  if (t < 0) return 0;
  if (t < a) return (t / a) * peakGain;
  if (t < a + h) return peakGain;
  if (t < a + h + d) return peakGain * (1 - (t - a - h) / d);
  return 0;
}

/**
 * Randomize a frequency with +-10% jitter.
 */
export function jitterFreq(freq: number, rng: () => number): number {
  return freq * (0.9 + rng() * 0.2);
}

// ---------------------------------------------------------------------------
// Shared noise buffers (pure generation — the engine and the offline renderer
// call this same function, so the PCM is identical in both)
// ---------------------------------------------------------------------------

/** Length of the shared noise loops, seconds. Every layer reads a window of it. */
export const NOISE_BUFFER_S = 2;

/**
 * Fixed seeds for the three noise colours.
 *
 * Fixed, not per-session: these buffers must be byte-identical every run, or the
 * audition WAVs stop describing what the game plays and nothing about a noise
 * layer is reproducible. Per-shot variety comes from the READ OFFSET into the
 * buffer, which is seeded per shot — same tape, different point on it.
 */
export const NOISE_SEEDS: Record<NoiseColor, number> = {
  white: 0x7e110a17,
  brown: 0xb201175e,
  pink: 0x914bc0de,
};

/**
 * Generate one noise buffer. Deterministic in (color, length).
 *
 * Brown is integrated white, clamped. Pink is Paul Kellet's economy
 * approximation — the same one the file has always used.
 */
export function generateNoise(color: NoiseColor, length: number): Float32Array {
  const out = new Float32Array(length);
  const rnd = mulberry32(NOISE_SEEDS[color]);

  if (color === 'white') {
    for (let i = 0; i < length; i++) out[i] = rnd() * 2 - 1;
    return out;
  }

  if (color === 'brown') {
    let b = 0;
    for (let i = 0; i < length; i++) {
      b += (rnd() * 2 - 1) * 0.05;
      b = Math.max(-1, Math.min(1, b));
      out[i] = b;
    }
    return out;
  }

  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < length; i++) {
    const white = rnd() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.96900 * b2 + white * 0.1538520;
    b3 = 0.86650 * b3 + white * 0.3104856;
    b4 = 0.55000 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.0168980;
    const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
    out[i] = Math.max(-1, Math.min(1, pink));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-layer randomised parameters
// ---------------------------------------------------------------------------

/**
 * Everything a single layer needs that is not in the recipe, derived from one
 * seed in ONE fixed draw order.
 *
 * This is the contract between the live engine and `scripts/audio-render.mts`.
 * Both call this function; neither derives anything itself. If they did, a
 * reordered draw would silently make the audition files describe a sound the
 * game does not play, which is the exact failure mode this deliverable exists
 * to prevent.
 */
export interface LayerParams {
  /** Multiplier applied to freq AND freqEnd, 0.9..1.1. */
  freqMul: number;
  /** Read offset into the shared noise buffer, seconds. */
  offset: number;
  /** Stepped amplitude multipliers. Empty when the layer does not flicker. */
  flicker: number[];
  /** Seconds per flicker step. 0 when not flickering. */
  flickerStep: number;
}

export function layerParams(
  env: readonly [number, number, number],
  seed: number,
  flickerHz = 0,
  flickerDepth = 0,
  bufferS = NOISE_BUFFER_S,
): LayerParams {
  const rng = mulberry32(seed);
  // Draw order is fixed and load-bearing. Do not reorder.
  const freqMul = jitterFreq(1, rng);
  const dur = envelopeDuration(env);
  const span = Math.max(0, bufferS - dur);
  const offset = rng() * span;

  const flicker: number[] = [];
  let flickerStep = 0;
  if (flickerHz > 0 && flickerDepth > 0) {
    flickerStep = 1 / flickerHz;
    const steps = Math.max(1, Math.ceil(dur * flickerHz));
    const floor = 1 - flickerDepth;
    for (let i = 0; i < steps; i++) flicker.push(floor + flickerDepth * rng());
  }

  return { freqMul, offset, flicker, flickerStep };
}

/** The flicker multiplier at time `t` into the layer. 1 when not flickering. */
export function flickerAt(p: LayerParams, t: number): number {
  if (p.flicker.length === 0) return 1;
  const i = Math.min(p.flicker.length - 1, Math.max(0, Math.floor(t / p.flickerStep)));
  return p.flicker[i];
}

/**
 * Instantaneous gain of an ambience bed layer at time `t`.
 *
 * The LFO is centred so the layer PEAKS at `layer.gain` and troughs at
 * `gain * (1 - depth)` — never above nominal, because a bed that occasionally
 * overshoots its own budget is a bed that occasionally ducks the whole mix.
 * The live graph reproduces this with a sine oscillator summed into a gain
 * node's AudioParam, which starts at phase 0 and therefore agrees with this at
 * t = 0.
 */
export function bedLayerAmp(layer: AmbienceBedLayer, t: number): number {
  const d = layer.lfoDepth ?? 0;
  const hz = layer.lfoHz ?? 0;
  if (d <= 0 || hz <= 0) return layer.gain;
  const base = layer.gain * (1 - 0.5 * d);
  const amp = layer.gain * 0.5 * d;
  return base + amp * Math.sin(2 * Math.PI * hz * t);
}

// ---------------------------------------------------------------------------
// Throttle tracker (pure logic, clock injectable for testing)
// ---------------------------------------------------------------------------

export class SfxThrottler {
  private lastPlay: Map<string, number> = new Map();

  /** Returns true if the sound is allowed (not throttled). */
  allow(name: string, throttleMs: number, now: number): boolean {
    const last = this.lastPlay.get(name);
    if (last !== undefined && now - last < throttleMs) {
      return false;
    }
    this.lastPlay.set(name, now);
    return true;
  }

  /** Reset all throttle state. */
  reset(): void {
    this.lastPlay.clear();
  }
}

// ---------------------------------------------------------------------------
// Ambience state
// ---------------------------------------------------------------------------

/**
 * Per-frame ambience description.
 *
 * The first five fields are the original contract and are REQUIRED. Everything
 * added since is optional with a zero/false default, because `main.ts` builds
 * one of these object literals per frame and a required field would have been a
 * compile break in a file this deliverable does not own. Omitting all of the
 * optional fields reproduces the old behaviour exactly.
 */
export interface AmbienceState {
  /** Wind intensity 0..1 (maps to weather.cloudCover). */
  wind: number;
  /** Rain intensity 0..1 (maps to weather.rainLevel). */
  rain: number;
  /** Night time — enables cricket chirps. */
  night: boolean;
  /** Player is indoors — heavily ducks outdoor sounds. */
  interior: boolean;
  /** Fire proximity 0..1 — crackle intensity. */
  fireNear: number;

  /**
   * Player is under a roof or canopy (`shelter.ts` `shelterTier(...) > 0`).
   * Crossfades the open-air rain hiss for the `rain_roof` drumming bed.
   * Default false.
   */
  sheltered?: boolean;
  /** Dungeon bed intensity 0..1 — the underground rumble. Default 0. */
  dungeon?: number;
  /** Castle bed intensity 0..1 — the stone-hall hollow. Default 0. */
  castle?: number;
}

// ---------------------------------------------------------------------------
// Play options
// ---------------------------------------------------------------------------

export interface PlayOptions {
  /** 0..1 intensity scalar (e.g. thunder closeness). Default 1. */
  intensity?: number;
  /**
   * Distance in metres for attenuation. Default 0 (full volume).
   * The rolloff length is the recipe's `maxDist`, not a global constant.
   */
  dist?: number;
}

// ---------------------------------------------------------------------------
// Voice slot tracking
// ---------------------------------------------------------------------------

const MAX_VOICES = 12;

/** Seed for the cricket scheduler. Fixed — see the determinism note. */
const CRICKET_SEED = 0xc21c_4e75;

// ---------------------------------------------------------------------------
// GameAudio class
// ---------------------------------------------------------------------------

/** The named output buses the Settings panel exposes as sliders. */
export type AudioBus = 'sfx' | 'music' | 'voice';

export class GameAudio {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  /**
   * Sub-buses between every source and `masterGain`.
   *
   * WHY: the pause screen's Settings panel has four faders, and until now the
   * engine had exactly one gain node. `sfx` carries every recipe voice and the
   * ambience beds; `voice` carries villager speech (fed by
   * `src/game/voice/voice-out.ts`, which needs a destination node it does not
   * own); `music` carries nothing yet and exists so the slider, the persisted
   * setting and the routing are all in place before the music engine lands —
   * agreeing the bus name now is cheaper than retrofitting it later.
   */
  private buses: Record<AudioBus, GainNode | null> = { sfx: null, music: null, voice: null };
  private busVolume: Record<AudioBus, number> = { sfx: 1, music: 1, voice: 1 };
  private _volume = 0.6;
  private _muted = false;
  private throttler = new SfxThrottler();
  private activeVoices = 0;
  private resumed = false;

  /** Monotonic per-name play counter — the second half of every shot seed. */
  private eventCount: Map<SfxName, number> = new Map();

  // Shared noise buffers (created once on resume)
  private whiteNoiseBuffer: AudioBuffer | null = null;
  private brownNoiseBuffer: AudioBuffer | null = null;
  private pinkNoiseBuffer: AudioBuffer | null = null;

  // Ambience nodes (persistent, gain-modulated per frame)
  private ambienceInitialized = false;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private windLfo: OscillatorNode | null = null;
  private windLfoGain: GainNode | null = null;
  private rainGain: GainNode | null = null;
  private rainFilter: BiquadFilterNode | null = null;
  private cricketInterval: number | null = null;
  private cricketGain: GainNode | null = null;
  private cricketRng: () => number = mulberry32(CRICKET_SEED);
  private fireGain: GainNode | null = null;
  private fireFilter: BiquadFilterNode | null = null;
  /** One master gain per ambience bed, keyed by bed name. */
  private bedGains: Map<AmbienceBedName, GainNode> = new Map();

  private currentAmbience: AmbienceState = {
    wind: 0, rain: 0, night: false, interior: false, fireNear: 0,
  };

  // ----------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------

  /**
   * Call on first user gesture (pointerdown / keydown).
   * Creates (or resumes) the AudioContext. Safe to call multiple times.
   */
  resume(): void {
    if (this.resumed) return;
    // Guard: only run in browser
    if (typeof AudioContext === 'undefined') return;

    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this._muted ? 0 : this._volume;
      this.masterGain.connect(this.ctx.destination);
      // Buses hang off master, so the master fader still scales everything and
      // mute still works by zeroing exactly one node.
      for (const name of ['sfx', 'music', 'voice'] as AudioBus[]) {
        const g = this.ctx.createGain();
        g.gain.value = this.busVolume[name];
        g.connect(this.sfxOut!);
        this.buses[name] = g;
      }
      this.generateNoiseBuffers();
    }

    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    this.resumed = true;
    this.initAmbience();
  }

  /** Master volume 0..1. */
  setVolume(v: number): void {
    this._volume = Math.max(0, Math.min(1, v));
    if (this.masterGain) {
      this.masterGain.gain.value = this._muted ? 0 : this._volume;
    }
  }

  get volume(): number { return this._volume; }

  get muted(): boolean { return this._muted; }
  set muted(m: boolean) {
    this._muted = m;
    if (this.masterGain) {
      this.masterGain.gain.value = m ? 0 : this._volume;
    }
  }

  /**
   * Set one bus's level, 0..1.
   *
   * Ramped rather than assigned: `setVolume`/`muted` write `gain.value`
   * directly and can click, and a slider the player is dragging writes on
   * every pointer move. 20 ms is below the threshold of hearing it as a fade
   * and above the threshold of hearing it as a step.
   */
  setBusVolume(bus: AudioBus, v: number): void {
    const level = Math.max(0, Math.min(1, v));
    this.busVolume[bus] = level;
    const g = this.buses[bus];
    if (g && this.ctx) {
      g.gain.setTargetAtTime(level, this.ctx.currentTime, 0.02);
    }
  }

  /** Current level of one bus, 0..1. */
  getBusVolume(bus: AudioBus): number { return this.busVolume[bus]; }

  /**
   * Destination for villager speech. Null until the context exists (no user
   * gesture yet) — callers treat that as "not audible yet", never as an error.
   */
  voiceBus(): { ctx: AudioContext; node: AudioNode } | null {
    return this.ctx && this.buses.voice ? { ctx: this.ctx, node: this.buses.voice } : null;
  }

  /** Destination for the music engine (src/game/music/**). Nothing routes here yet. */
  musicBus(): { ctx: AudioContext; node: AudioNode } | null {
    return this.ctx && this.buses.music ? { ctx: this.ctx, node: this.buses.music } : null;
  }

  /** Where sound effects and ambience go — master when the bus is not up yet. */
  private get sfxOut(): AudioNode | null { return this.buses.sfx ?? this.masterGain; }

  /** Whether the audio context is active. */
  get isActive(): boolean { return this.resumed && this.ctx !== null; }

  // ----------------------------------------------------------
  // Ambience
  // ----------------------------------------------------------

  /**
   * Update ambient sound layers. Call once per frame.
   * Smoothly crossfades between states.
   */
  setAmbience(state: AmbienceState): void {
    this.currentAmbience = state;
    if (!this.ctx || !this.ambienceInitialized) return;

    const now = this.ctx.currentTime;
    const ramp = 0.1; // 100ms smoothing

    // Interior duck factor
    const duck = state.interior ? 0.1 : 1.0;
    const sheltered = state.sheltered ?? false;

    // Wind: lowpass noise, intensity -> gain + filter cutoff
    if (this.windGain && this.windFilter) {
      const windVol = state.wind * 0.25 * duck;
      this.windGain.gain.linearRampToValueAtTime(windVol, now + ramp);
      // Higher wind = higher cutoff (more "whistling")
      const cutoff = 200 + state.wind * 600;
      this.windFilter.frequency.linearRampToValueAtTime(cutoff, now + ramp);
    }

    // Rain: highpass white noise, intensity -> gain.
    // Under a roof this ducks to 28% rather than to zero and the `rain_roof`
    // bed takes over — a roof changes the SPECTRUM of rain, it does not mute it.
    if (this.rainGain && this.rainFilter) {
      const rainVol = state.rain * 0.3 * duck * (sheltered ? 0.28 : 1);
      this.rainGain.gain.linearRampToValueAtTime(rainVol, now + ramp);
      // Heavier rain = lower cutoff (more full-spectrum)
      const cutoff = 4000 - state.rain * 2000;
      this.rainFilter.frequency.linearRampToValueAtTime(cutoff, now + ramp);
    }

    // Crickets: active at night, outdoors only
    if (this.cricketGain) {
      const cricketVol = (state.night && !state.interior) ? 0.12 : 0;
      this.cricketGain.gain.linearRampToValueAtTime(cricketVol, now + ramp);
    }

    // Fire crackle
    if (this.fireGain) {
      const fireVol = state.fireNear * 0.2;
      this.fireGain.gain.linearRampToValueAtTime(fireVol, now + ramp);
    }

    // Beds. All default to silent, so a caller that never sets them gets
    // exactly the pre-bed behaviour.
    this.setBedGain('rain_roof', sheltered ? state.rain : 0, now, ramp);
    this.setBedGain('dungeon', state.dungeon ?? 0, now, ramp);
    this.setBedGain('castle', state.castle ?? 0, now, ramp);
  }

  private setBedGain(
    bed: AmbienceBedName, intensity: number, now: number, ramp: number,
  ): void {
    const node = this.bedGains.get(bed);
    if (!node) return;
    const k = Math.max(0, Math.min(1, intensity));
    node.gain.linearRampToValueAtTime(k * AMBIENCE_BEDS[bed].gain, now + ramp);
  }

  // ----------------------------------------------------------
  // One-shot SFX
  // ----------------------------------------------------------

  /**
   * Play a named one-shot SFX. Applies throttling, distance attenuation,
   * and voice limiting automatically.
   */
  play(name: SfxName, opts?: PlayOptions): void {
    if (!this.ctx || !this.masterGain) return;

    const recipe = SFX_RECIPES[name];
    if (!recipe) return;

    // Throttle check
    const now = performance.now();
    if (!this.throttler.allow(name, recipe.throttleMs, now)) return;

    // Voice cap
    if (this.activeVoices >= MAX_VOICES) return;

    // Compute final gain. Rolloff length is per-recipe: a dragon is not a boot.
    const intensity = opts?.intensity ?? 1;
    const dist = opts?.dist ?? 0;
    const finalGain = intensity * distanceGain(dist, recipe.maxDist);
    if (finalGain <= 0.001) return; // inaudible

    // Advance the per-name counter ONLY for shots that actually sound, so
    // (name, n) numbers real events and a throttled call cannot shift the
    // sequence out from under a reproduction.
    const event = this.eventCount.get(name) ?? 0;
    this.eventCount.set(name, event + 1);

    this.synthesizeSfx(recipe, finalGain, sfxSeed(name, event, SFX_VARIANT[name] ?? 0));
  }

  // ----------------------------------------------------------
  // Internal: noise buffer generation
  // ----------------------------------------------------------

  private generateNoiseBuffers(): void {
    if (!this.ctx) return;
    const sr = this.ctx.sampleRate;
    const len = Math.round(sr * NOISE_BUFFER_S);

    const make = (color: NoiseColor): AudioBuffer => {
      const buf = this.ctx!.createBuffer(1, len, sr);
      buf.getChannelData(0).set(generateNoise(color, len));
      return buf;
    };

    this.whiteNoiseBuffer = make('white');
    this.brownNoiseBuffer = make('brown');
    this.pinkNoiseBuffer = make('pink');
  }

  private getNoiseBuffer(color: NoiseColor): AudioBuffer | null {
    switch (color) {
      case 'white': return this.whiteNoiseBuffer;
      case 'brown': return this.brownNoiseBuffer;
      case 'pink': return this.pinkNoiseBuffer;
    }
  }

  // ----------------------------------------------------------
  // Internal: ambience initialization
  // ----------------------------------------------------------

  private initAmbience(): void {
    if (!this.ctx || !this.masterGain || this.ambienceInitialized) return;
    this.ambienceInitialized = true;

    const ctx = this.ctx;

    // --- Wind layer: looping brown noise -> lowpass -> LFO-modulated gain ---
    if (this.brownNoiseBuffer) {
      const windSrc = ctx.createBufferSource();
      windSrc.buffer = this.brownNoiseBuffer;
      windSrc.loop = true;

      this.windFilter = ctx.createBiquadFilter();
      this.windFilter.type = 'lowpass';
      this.windFilter.frequency.value = 400;
      this.windFilter.Q.value = 0.7;

      this.windGain = ctx.createGain();
      this.windGain.gain.value = 0;

      // LFO for gusting effect
      this.windLfo = ctx.createOscillator();
      this.windLfo.type = 'sine';
      this.windLfo.frequency.value = 0.3; // slow gust
      this.windLfoGain = ctx.createGain();
      this.windLfoGain.gain.value = 0.05; // subtle variation

      windSrc.connect(this.windFilter);
      this.windFilter.connect(this.windGain);
      this.windLfo.connect(this.windLfoGain);
      this.windLfoGain.connect(this.windGain.gain);
      this.windGain.connect(this.sfxOut!);

      windSrc.start();
      this.windLfo.start();
    }

    // --- Rain layer: looping white noise -> highpass ---
    if (this.whiteNoiseBuffer) {
      const rainSrc = ctx.createBufferSource();
      rainSrc.buffer = this.whiteNoiseBuffer;
      rainSrc.loop = true;

      this.rainFilter = ctx.createBiquadFilter();
      this.rainFilter.type = 'highpass';
      this.rainFilter.frequency.value = 3000;
      this.rainFilter.Q.value = 0.5;

      this.rainGain = ctx.createGain();
      this.rainGain.gain.value = 0;

      rainSrc.connect(this.rainFilter);
      this.rainFilter.connect(this.rainGain);
      this.rainGain.connect(this.sfxOut!);

      rainSrc.start();
    }

    // --- Cricket layer: periodic chirps via scheduled oscillator blips ---
    this.cricketGain = ctx.createGain();
    this.cricketGain.gain.value = 0;
    this.cricketGain.connect(this.sfxOut!);
    this.cricketRng = mulberry32(CRICKET_SEED);
    this.startCricketLoop();

    // --- Fire crackle layer: looping brown noise -> bandpass (crackling) ---
    if (this.brownNoiseBuffer) {
      const fireSrc = ctx.createBufferSource();
      fireSrc.buffer = this.brownNoiseBuffer;
      fireSrc.loop = true;

      this.fireFilter = ctx.createBiquadFilter();
      this.fireFilter.type = 'bandpass';
      this.fireFilter.frequency.value = 1200;
      this.fireFilter.Q.value = 2.0;

      this.fireGain = ctx.createGain();
      this.fireGain.gain.value = 0;

      fireSrc.connect(this.fireFilter);
      this.fireFilter.connect(this.fireGain);
      this.fireGain.connect(this.sfxOut!);

      fireSrc.start();
    }

    // --- Data-driven beds: rain_roof, dungeon, castle ---
    for (const bed of AMBIENCE_BED_NAMES) this.buildBed(bed);

    // Apply current ambience state
    this.setAmbience(this.currentAmbience);
  }

  /**
   * Build one bed from `AMBIENCE_BEDS`. Each layer is a looping noise source
   * through one biquad into its own gain, with an optional sine LFO summed into
   * that gain's AudioParam; every layer feeds the bed's master gain, which is
   * the only node `setAmbience` touches.
   */
  private buildBed(name: AmbienceBedName): void {
    if (!this.ctx || !this.masterGain) return;
    const ctx = this.ctx;
    const bed = AMBIENCE_BEDS[name];

    const bedGain = ctx.createGain();
    bedGain.gain.value = 0;
    bedGain.connect(this.sfxOut!);

    let built = 0;
    for (const layer of bed.layers) {
      const buffer = this.getNoiseBuffer(layer.color);
      if (!buffer) continue;

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;

      const filter = ctx.createBiquadFilter();
      filter.type = layer.filter;
      filter.frequency.value = layer.freq;
      filter.Q.value = layer.Q;

      const gain = ctx.createGain();
      const depth = layer.lfoDepth ?? 0;
      const hz = layer.lfoHz ?? 0;
      // Matches `bedLayerAmp`: peak at nominal, trough at gain*(1-depth).
      gain.gain.value = (depth > 0 && hz > 0)
        ? layer.gain * (1 - 0.5 * depth)
        : layer.gain;

      src.connect(filter);
      filter.connect(gain);
      gain.connect(bedGain);

      if (depth > 0 && hz > 0) {
        const lfo = ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = hz;
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = layer.gain * 0.5 * depth;
        lfo.connect(lfoGain);
        lfoGain.connect(gain.gain);
        lfo.start();
      }

      src.start();
      built++;
    }

    if (built > 0) this.bedGains.set(name, bedGain);
  }

  private startCricketLoop(): void {
    if (!this.ctx || !this.cricketGain) return;
    const ctx = this.ctx;
    const gain = this.cricketGain;

    // Schedule chirps at irregular but SEEDED intervals. The cricket stream is
    // ambience timing, not gameplay, but it was one of the five Math.random()
    // sites and a deterministic build has no exemptions worth arguing about.
    const scheduleChirp = (): void => {
      if (!this.ctx || this.ctx.state === 'closed') return;

      const now = ctx.currentTime;
      // A chirp: short burst of high-freq sine
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 4000 + this.cricketRng() * 2000;

      const chirpGain = ctx.createGain();
      chirpGain.gain.setValueAtTime(0, now);
      chirpGain.gain.linearRampToValueAtTime(0.6, now + 0.005);
      chirpGain.gain.linearRampToValueAtTime(0, now + 0.03);

      osc.connect(chirpGain);
      chirpGain.connect(gain);

      osc.start(now);
      osc.stop(now + 0.04);

      // Schedule next chirp
      const interval = 200 + this.cricketRng() * 800; // 200-1000ms
      this.cricketInterval = window.setTimeout(scheduleChirp, interval);
    };

    // Start loop
    const initialDelay = 500 + this.cricketRng() * 1000;
    this.cricketInterval = window.setTimeout(scheduleChirp, initialDelay);
  }

  // ----------------------------------------------------------
  // Internal: SFX synthesis
  // ----------------------------------------------------------

  private synthesizeSfx(recipe: SfxRecipe, gain: number, shotSeed: number): void {
    if (!this.ctx || !this.masterGain) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Create a gain node for this voice
    const voiceGain = ctx.createGain();
    voiceGain.gain.value = gain;
    voiceGain.connect(this.sfxOut!);

    this.activeVoices++;

    let maxDur = 0;

    // Oscillator layers
    if (recipe.osc) {
      for (let i = 0; i < recipe.osc.length; i++) {
        const layer = recipe.osc[i];
        const p = layerParams(
          layer.envelope, layerSeed(shotSeed, i, false),
          layer.flickerHz ?? 0, layer.flickerDepth ?? 0,
        );
        maxDur = Math.max(maxDur, this.playOscLayer(ctx, voiceGain, layer, now, p));
      }
    }

    // Noise layers
    if (recipe.noise) {
      for (let i = 0; i < recipe.noise.length; i++) {
        const layer = recipe.noise[i];
        const p = layerParams(
          layer.envelope, layerSeed(shotSeed, i, true),
          layer.flickerHz ?? 0, layer.flickerDepth ?? 0,
        );
        maxDur = Math.max(maxDur, this.playNoiseLayer(ctx, voiceGain, layer, now, p));
      }
    }

    // Release voice slot after duration
    const releaseMs = (maxDur + 0.05) * 1000;
    setTimeout(() => {
      this.activeVoices = Math.max(0, this.activeVoices - 1);
      voiceGain.disconnect();
    }, releaseMs);
  }

  /**
   * Insert a stepped-gain node for a flickering layer, or return the
   * destination untouched. Steps, never ramps — see `OscLayer.flickerHz`.
   */
  private flickerNode(
    ctx: AudioContext, destination: AudioNode, p: LayerParams, startTime: number,
  ): AudioNode {
    if (p.flicker.length === 0) return destination;
    const node = ctx.createGain();
    node.gain.setValueAtTime(p.flicker[0], startTime);
    for (let i = 1; i < p.flicker.length; i++) {
      node.gain.setValueAtTime(p.flicker[i], startTime + i * p.flickerStep);
    }
    node.connect(destination);
    return node;
  }

  private playOscLayer(
    ctx: AudioContext,
    destination: AudioNode,
    layer: OscLayer,
    startTime: number,
    p: LayerParams,
  ): number {
    const osc = ctx.createOscillator();
    osc.type = layer.type;

    // Pitch jitter (+-10%), seeded — was `Math.random()`. `p.freqMul` is
    // `jitterFreq(1, rng)` from `layerParams`; applying it to both ends of the
    // sweep keeps the INTERVAL constant while the absolute pitch moves, which
    // is what makes a jittered sweep read as the same sound rather than as a
    // different one.
    const startFreq = layer.freq * p.freqMul;
    osc.frequency.setValueAtTime(startFreq, startTime);

    if (layer.freqEnd !== undefined) {
      const endFreq = layer.freqEnd * p.freqMul;
      const dur = envelopeDuration(layer.envelope);
      osc.frequency.linearRampToValueAtTime(endFreq, startTime + dur);
    }

    if (layer.detune !== undefined) {
      osc.detune.value = layer.detune;
    }

    // Envelope
    const envGain = ctx.createGain();
    const peak = layer.gain ?? 1;
    const [a, h, d] = layer.envelope;
    envGain.gain.setValueAtTime(0, startTime);
    envGain.gain.linearRampToValueAtTime(peak, startTime + a);
    envGain.gain.setValueAtTime(peak, startTime + a + h);
    envGain.gain.linearRampToValueAtTime(0, startTime + a + h + d);

    osc.connect(envGain);
    envGain.connect(this.flickerNode(ctx, destination, p, startTime));

    const totalDur = a + h + d;
    osc.start(startTime);
    osc.stop(startTime + totalDur + 0.01);

    return totalDur;
  }

  private playNoiseLayer(
    ctx: AudioContext,
    destination: AudioNode,
    layer: NoiseLayer,
    startTime: number,
    p: LayerParams,
  ): number {
    const buffer = this.getNoiseBuffer(layer.color);
    if (!buffer) return 0;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    // Read offset, seeded — was `Math.random()`. The buffer is the same 2 s of
    // PCM every run; the offset is what makes two footsteps different.
    const offset = p.offset;

    let lastNode: AudioNode = src;

    // Filters
    if (layer.bandpass) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = layer.bandpass.freq;
      bp.Q.value = layer.bandpass.Q;
      lastNode.connect(bp);
      lastNode = bp;
    } else {
      if (layer.highpass) {
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = layer.highpass;
        hp.Q.value = 0.7;
        lastNode.connect(hp);
        lastNode = hp;
      }
      if (layer.lowpass) {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = layer.lowpass;
        lp.Q.value = 0.7;
        lastNode.connect(lp);
        lastNode = lp;
      }
    }

    // Envelope
    const envGain = ctx.createGain();
    const peak = layer.gain ?? 1;
    const [a, h, d] = layer.envelope;
    envGain.gain.setValueAtTime(0, startTime);
    envGain.gain.linearRampToValueAtTime(peak, startTime + a);
    envGain.gain.setValueAtTime(peak, startTime + a + h);
    envGain.gain.linearRampToValueAtTime(0, startTime + a + h + d);

    lastNode.connect(envGain);
    envGain.connect(this.flickerNode(ctx, destination, p, startTime));

    const totalDur = a + h + d;
    src.start(startTime, Math.max(0, offset));
    src.stop(startTime + totalDur + 0.01);

    return totalDur;
  }

  // ----------------------------------------------------------
  // Cleanup (optional — for hot-reload scenarios)
  // ----------------------------------------------------------

  destroy(): void {
    if (this.cricketInterval !== null) {
      clearTimeout(this.cricketInterval);
      this.cricketInterval = null;
    }
    if (this.ctx && this.ctx.state !== 'closed') {
      void this.ctx.close();
    }
    this.ctx = null;
    this.masterGain = null;
    this.bedGains.clear();
    this.ambienceInitialized = false;
    this.resumed = false;
    this.throttler.reset();
    this.eventCount.clear();
  }
}
