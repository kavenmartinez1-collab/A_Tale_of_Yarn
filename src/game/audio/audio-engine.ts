/**
 * GameAudio — Procedural WebAudio engine for ArtifexWebGame.
 *
 * Fully synthesized (oscillators + filtered noise + envelopes). No audio files.
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
 *      });
 *
 * 4. ONE-SHOT SFX CALLS (at the event sites):
 *      - Walk cycle phase wrap:       audio.play('footstep_grass') or 'footstep_stone'
 *      - Player swing animation:      audio.play('swing')
 *      - Damage dealt to entity:      audio.play('hit')
 *      - Player takes damage:         audio.play('hurt')
 *      - Item picked up:              audio.play('pickup')
 *      - Craft success:               audio.play('craft')
 *      - Any UI button click:         audio.play('ui_click')
 *      - Chest/container opened:      audio.play('chest_open')
 *      - Lightning strike fired:      audio.play('thunder', { intensity: 1 - dist/100 })
 *      - Player enters water:         audio.play('splash')
 *      - Consume food/water:          audio.play('eat_drink')
 *      - Level-up detected:           audio.play('level_chime')
 *      - Wolf enters aggro state:     audio.play('growl', { dist: wolfDist })
 *      - Dragon encounter:            audio.play('dragon_roar', { dist: dragonDist })
 *
 * 5. VOLUME / MUTE (settings panel):
 *      audio.setVolume(0.7);   // 0..1
 *      audio.muted = true;     // toggle mute
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
  SFX_RECIPES, SFX_NAMES,
  type SfxName, type SfxRecipe, type OscLayer, type NoiseLayer,
} from './sfx';

// Re-export for convenience
export { SFX_NAMES, type SfxName } from './sfx';

// ---------------------------------------------------------------------------
// Pure helper functions (testable under Node without AudioContext)
// ---------------------------------------------------------------------------

/**
 * Compute distance-based gain attenuation.
 * dist 0 -> gain 1, dist >= maxDist -> gain 0. Linear rolloff.
 */
export function distanceGain(dist: number, maxDist = 50): number {
  if (dist <= 0) return 1;
  if (dist >= maxDist) return 0;
  return 1 - dist / maxDist;
}

/**
 * Compute total envelope duration from [attack, hold, decay].
 */
export function envelopeDuration(env: [number, number, number]): number {
  return env[0] + env[1] + env[2];
}

/**
 * Compute the envelope gain at a given time offset.
 * Returns 0..peakGain following attack/hold/decay shape.
 */
export function envelopeAt(
  env: [number, number, number],
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
}

// ---------------------------------------------------------------------------
// Play options
// ---------------------------------------------------------------------------

export interface PlayOptions {
  /** 0..1 intensity scalar (e.g. thunder closeness). Default 1. */
  intensity?: number;
  /** Distance in metres for attenuation (0..50). Default 0 (full volume). */
  dist?: number;
}

// ---------------------------------------------------------------------------
// Voice slot tracking
// ---------------------------------------------------------------------------

const MAX_VOICES = 12;

// ---------------------------------------------------------------------------
// GameAudio class
// ---------------------------------------------------------------------------

export class GameAudio {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private _volume = 0.6;
  private _muted = false;
  private throttler = new SfxThrottler();
  private activeVoices = 0;
  private resumed = false;

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
  private fireGain: GainNode | null = null;
  private fireFilter: BiquadFilterNode | null = null;

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

    // Wind: lowpass noise, intensity -> gain + filter cutoff
    if (this.windGain && this.windFilter) {
      const windVol = state.wind * 0.25 * duck;
      this.windGain.gain.linearRampToValueAtTime(windVol, now + ramp);
      // Higher wind = higher cutoff (more "whistling")
      const cutoff = 200 + state.wind * 600;
      this.windFilter.frequency.linearRampToValueAtTime(cutoff, now + ramp);
    }

    // Rain: highpass white noise, intensity -> gain
    if (this.rainGain && this.rainFilter) {
      const rainVol = state.rain * 0.3 * duck;
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

    // Compute final gain
    const intensity = opts?.intensity ?? 1;
    const dist = opts?.dist ?? 0;
    const finalGain = intensity * distanceGain(dist);
    if (finalGain <= 0.001) return; // inaudible

    this.synthesizeSfx(recipe, finalGain);
  }

  // ----------------------------------------------------------
  // Internal: noise buffer generation
  // ----------------------------------------------------------

  private generateNoiseBuffers(): void {
    if (!this.ctx) return;
    const sr = this.ctx.sampleRate;
    const len = sr * 2; // 2 seconds of noise

    // White noise
    const whiteBuf = this.ctx.createBuffer(1, len, sr);
    const whiteData = whiteBuf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      whiteData[i] = Math.random() * 2 - 1;
    }
    this.whiteNoiseBuffer = whiteBuf;

    // Brown noise (integrated white, normalized)
    const brownBuf = this.ctx.createBuffer(1, len, sr);
    const brownData = brownBuf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) {
      b += (Math.random() * 2 - 1) * 0.05;
      b = Math.max(-1, Math.min(1, b));
      brownData[i] = b;
    }
    this.brownNoiseBuffer = brownBuf;

    // Pink noise (Paul Kellet's approximation)
    const pinkBuf = this.ctx.createBuffer(1, len, sr);
    const pinkData = pinkBuf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
      pinkData[i] = Math.max(-1, Math.min(1, pink));
    }
    this.pinkNoiseBuffer = pinkBuf;
  }

  private getNoiseBuffer(color: 'white' | 'brown' | 'pink'): AudioBuffer | null {
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
      this.windGain.connect(this.masterGain);

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
      this.rainGain.connect(this.masterGain);

      rainSrc.start();
    }

    // --- Cricket layer: periodic chirps via scheduled oscillator blips ---
    this.cricketGain = ctx.createGain();
    this.cricketGain.gain.value = 0;
    this.cricketGain.connect(this.masterGain);
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
      this.fireGain.connect(this.masterGain);

      fireSrc.start();
    }

    // Apply current ambience state
    this.setAmbience(this.currentAmbience);
  }

  private startCricketLoop(): void {
    if (!this.ctx || !this.cricketGain) return;
    const ctx = this.ctx;
    const gain = this.cricketGain;

    // Schedule random chirps at irregular intervals
    const scheduleChirp = (): void => {
      if (!this.ctx || this.ctx.state === 'closed') return;

      const now = ctx.currentTime;
      // A chirp: short burst of high-freq sine
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 4000 + Math.random() * 2000;

      const chirpGain = ctx.createGain();
      chirpGain.gain.setValueAtTime(0, now);
      chirpGain.gain.linearRampToValueAtTime(0.6, now + 0.005);
      chirpGain.gain.linearRampToValueAtTime(0, now + 0.03);

      osc.connect(chirpGain);
      chirpGain.connect(gain);

      osc.start(now);
      osc.stop(now + 0.04);

      // Schedule next chirp
      const interval = 200 + Math.random() * 800; // 200-1000ms
      this.cricketInterval = window.setTimeout(scheduleChirp, interval);
    };

    // Start loop
    const initialDelay = 500 + Math.random() * 1000;
    this.cricketInterval = window.setTimeout(scheduleChirp, initialDelay);
  }

  // ----------------------------------------------------------
  // Internal: SFX synthesis
  // ----------------------------------------------------------

  private synthesizeSfx(recipe: SfxRecipe, gain: number): void {
    if (!this.ctx || !this.masterGain) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Create a gain node for this voice
    const voiceGain = ctx.createGain();
    voiceGain.gain.value = gain;
    voiceGain.connect(this.masterGain);

    this.activeVoices++;

    let maxDur = 0;

    // Oscillator layers
    if (recipe.osc) {
      for (const layer of recipe.osc) {
        maxDur = Math.max(maxDur, this.playOscLayer(ctx, voiceGain, layer, now));
      }
    }

    // Noise layers
    if (recipe.noise) {
      for (const layer of recipe.noise) {
        maxDur = Math.max(maxDur, this.playNoiseLayer(ctx, voiceGain, layer, now));
      }
    }

    // Release voice slot after duration
    const releaseMs = (maxDur + 0.05) * 1000;
    setTimeout(() => {
      this.activeVoices = Math.max(0, this.activeVoices - 1);
      voiceGain.disconnect();
    }, releaseMs);
  }

  private playOscLayer(
    ctx: AudioContext,
    destination: AudioNode,
    layer: OscLayer,
    startTime: number,
  ): number {
    const osc = ctx.createOscillator();
    osc.type = layer.type;

    // Apply pitch jitter (+-10%)
    const jitter = 0.9 + Math.random() * 0.2;
    const startFreq = layer.freq * jitter;
    osc.frequency.setValueAtTime(startFreq, startTime);

    if (layer.freqEnd !== undefined) {
      const endFreq = layer.freqEnd * jitter;
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
    envGain.connect(destination);

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
  ): number {
    const buffer = this.getNoiseBuffer(layer.color);
    if (!buffer) return 0;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    // Start at random offset for variety
    const bufDur = buffer.duration;
    const offset = Math.random() * (bufDur - envelopeDuration(layer.envelope));

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
    envGain.connect(destination);

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
    this.ambienceInitialized = false;
    this.resumed = false;
    this.throttler.reset();
  }
}
