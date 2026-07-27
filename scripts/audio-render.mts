/**
 * Offline renderer for `SfxRecipe` — WebAudio's synthesis path, in Node.
 *
 * WHY THIS EXISTS
 *
 * Every sound in the game is synthesized at runtime by an AudioContext that
 * does not exist under Node, so nothing about the actual PCM could be tested
 * and nothing could be auditioned without launching the game and hitting the
 * event. This interprets the same declarative recipe the engine interprets and
 * produces the samples, which makes two things possible: WAV files the user can
 * open in Ableton, and mechanical assertions on real energy rather than on
 * whether an object literal has the right keys.
 *
 * WHAT IS EXACT AND WHAT IS APPROXIMATE
 *
 * Exact — shares code with the engine, cannot drift:
 *   - the recipe data itself (`SFX_RECIPES`, `AMBIENCE_BEDS`)
 *   - the noise buffers (`generateNoise`, fixed seeds)
 *   - the per-shot and per-layer seeds (`sfxSeed`, `layerSeed`)
 *   - the per-layer jitter / read offset / flicker steps (`layerParams`)
 *   - the ADH envelope (`envelopeAt`) and the bed LFO (`bedLayerAmp`)
 *
 * Approximate — reimplemented here, and the differences are audible if you go
 * looking for them:
 *   - BIQUADS. RBJ cookbook, using the Web Audio conventions: Q in DECIBELS for
 *     lowpass/highpass (`alpha = sin(w0)/(2*10^(Q/20))`) and linear Q for the
 *     constant-0dB-peak bandpass. Browser implementations agree with this to
 *     within rounding, but they also de-normalise differently and may run in
 *     doubles where this runs in doubles too — call it within a fraction of a
 *     dB, not bit-exact.
 *   - OSCILLATORS. WebAudio's square/sawtooth/triangle are band-limited
 *     PeriodicWaves. These are additive sums capped at `MAX_HARMONICS = 128` or
 *     Nyquist, whichever is lower. For a 55 Hz growl that stops at 7 kHz where
 *     a real sawtooth still has about -40 dB of content, so the very top end of
 *     the low oscillators is slightly duller here than in the browser.
 *   - SAMPLE RATE. Fixed at 48 kHz. The engine uses whatever the device gives
 *     it; the noise buffers are seeded by SAMPLE INDEX, so a 44.1 kHz device
 *     gets different noise. Same character, different grain.
 *   - The master volume is NOT applied. Renders are at the voice level, i.e.
 *     intensity 1 and distance 0, which is the loudest the sound can be.
 */

import {
  SFX_RECIPES, AMBIENCE_BEDS,
  type SfxName, type SfxRecipe, type NoiseColor,
  type AmbienceBedName, type OscType,
} from '../src/game/audio/sfx';

import {
  generateNoise, sfxSeed, layerSeed, layerParams, flickerAt,
  envelopeAt, envelopeDuration, bedLayerAmp, NOISE_BUFFER_S,
} from '../src/game/audio/audio-engine';

export const SAMPLE_RATE = 48000;

/** Harmonic cap for the additive band-limited oscillators. */
const MAX_HARMONICS = 128;

// ---------------------------------------------------------------------------
// Biquad — RBJ cookbook, Web Audio conventions
// ---------------------------------------------------------------------------

export type FilterType = 'lowpass' | 'highpass' | 'bandpass';

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

export function biquadCoeffs(
  type: FilterType, freq: number, Q: number, sr: number,
): Biquad {
  const w0 = 2 * Math.PI * Math.min(freq, sr * 0.499) / sr;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);

  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;

  if (type === 'bandpass') {
    // Linear Q for bandpass (Web Audio spec), constant 0 dB peak gain.
    const alpha = sw / (2 * Math.max(1e-4, Q));
    b0 = alpha; b1 = 0; b2 = -alpha;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else {
    // Q is in DECIBELS for lowpass/highpass in the Web Audio spec.
    const alpha = sw / (2 * Math.pow(10, Q / 20));
    if (type === 'lowpass') {
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
    } else {
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
    }
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  }

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Direct-form-I biquad over a buffer, in place. State starts at zero. */
export function applyBiquad(
  buf: Float32Array, type: FilterType, freq: number, Q: number, sr = SAMPLE_RATE,
): void {
  const c = biquadCoeffs(type, freq, Q, sr);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x0 = buf[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    buf[i] = y0;
  }
}

// ---------------------------------------------------------------------------
// Oscillators — band-limited additive
// ---------------------------------------------------------------------------

/**
 * One sample of a band-limited waveform at the given phase (radians) for a
 * fundamental of `f` Hz.
 *
 * Amplitudes match the browser's normalised PeriodicWaves: a sawtooth peaks at
 * ~1, a square at ~1, a triangle at ~1.
 */
function oscSample(type: OscType, phase: number, f: number, nyquist: number): number {
  if (type === 'sine') return Math.sin(phase);

  const nMax = Math.min(MAX_HARMONICS, Math.max(1, Math.floor(nyquist / Math.max(1, f))));
  let s = 0;

  if (type === 'sawtooth') {
    // -2/pi * sum sin(n x)/n  (WebAudio's sawtooth falls, matching this sign)
    for (let n = 1; n <= nMax; n++) s -= Math.sin(n * phase) / n;
    return s * (2 / Math.PI);
  }

  if (type === 'square') {
    for (let n = 1; n <= nMax; n += 2) s += Math.sin(n * phase) / n;
    return s * (4 / Math.PI);
  }

  // triangle
  let sign = 1;
  for (let n = 1; n <= nMax; n += 2) {
    s += sign * Math.sin(n * phase) / (n * n);
    sign = -sign;
  }
  return s * (8 / (Math.PI * Math.PI));
}

// ---------------------------------------------------------------------------
// Recipe render
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** Which seeded variant. Feeds `sfxSeed`. Default 0. */
  variant?: number;
  /** Which shot of this sound. Default 0 — the first the game will play. */
  event?: number;
  /** Voice gain (intensity * distanceGain). Default 1. */
  gain?: number;
  sampleRate?: number;
}

/**
 * Render one recipe to mono float PCM.
 *
 * Length is `ceil(duration * sr)`, from the recipe's declared duration — NOT
 * from the longest envelope. That is deliberate: `duration` is what the engine
 * budgets a voice slot for, so if a layer outlives it the render truncates and
 * the duration test catches it.
 */
export function renderRecipe(
  recipe: SfxRecipe, opts: RenderOptions = {},
): Float32Array {
  const sr = opts.sampleRate ?? SAMPLE_RATE;
  const variant = opts.variant ?? 0;
  const event = opts.event ?? 0;
  const gain = opts.gain ?? 1;
  const shot = sfxSeed(recipe.name, event, variant);

  const n = Math.ceil(recipe.duration * sr);
  const out = new Float32Array(n);
  const nyquist = sr / 2;

  // --- oscillator layers ---
  if (recipe.osc) {
    for (let li = 0; li < recipe.osc.length; li++) {
      const layer = recipe.osc[li];
      const p = layerParams(
        layer.envelope, layerSeed(shot, li, false),
        layer.flickerHz ?? 0, layer.flickerDepth ?? 0,
      );
      const dur = envelopeDuration(layer.envelope);
      const peak = layer.gain ?? 1;
      const f0 = layer.freq * p.freqMul;
      const f1 = (layer.freqEnd ?? layer.freq) * p.freqMul;
      // `detune` is cents on top of the swept frequency.
      const detuneMul = layer.detune ? Math.pow(2, layer.detune / 1200) : 1;

      const end = Math.min(n, Math.ceil(dur * sr));
      let phase = 0;
      for (let i = 0; i < end; i++) {
        const t = i / sr;
        // Linear frequency ramp, integrated — a naive sin(2*pi*f(t)*t) would
        // be wrong the moment f changes, and every sweep in the table changes.
        const k = dur > 0 ? Math.min(1, t / dur) : 1;
        const f = (f0 + (f1 - f0) * k) * detuneMul;
        const a = envelopeAt(layer.envelope, t, peak) * flickerAt(p, t);
        out[i] += oscSample(layer.type, phase, f, nyquist) * a * gain;
        phase += 2 * Math.PI * f / sr;
        if (phase > 2 * Math.PI * 1024) phase -= 2 * Math.PI * 1024;
      }
    }
  }

  // --- noise layers ---
  if (recipe.noise) {
    for (let li = 0; li < recipe.noise.length; li++) {
      const layer = recipe.noise[li];
      const p = layerParams(
        layer.envelope, layerSeed(shot, li, true),
        layer.flickerHz ?? 0, layer.flickerDepth ?? 0,
      );
      const dur = envelopeDuration(layer.envelope);
      const peak = layer.gain ?? 1;
      const end = Math.min(n, Math.ceil(dur * sr));

      // Same 2 s buffer the engine reads, same seeded offset into it.
      const src = noiseBuffer(layer.color, sr);
      const off = Math.floor(p.offset * sr);
      const seg = new Float32Array(end);
      for (let i = 0; i < end; i++) {
        const j = off + i;
        seg[i] = j < src.length ? src[j] : 0;
      }

      if (layer.bandpass) {
        applyBiquad(seg, 'bandpass', layer.bandpass.freq, layer.bandpass.Q, sr);
      } else {
        if (layer.highpass) applyBiquad(seg, 'highpass', layer.highpass, 0.7, sr);
        if (layer.lowpass) applyBiquad(seg, 'lowpass', layer.lowpass, 0.7, sr);
      }

      for (let i = 0; i < end; i++) {
        const t = i / sr;
        const a = envelopeAt(layer.envelope, t, peak) * flickerAt(p, t);
        out[i] += seg[i] * a * gain;
      }
    }
  }

  return out;
}

export function renderSfx(name: SfxName, opts: RenderOptions = {}): Float32Array {
  return renderRecipe(SFX_RECIPES[name], opts);
}

// --- noise buffer cache (generation is the same call the engine makes) ------

const noiseCache = new Map<string, Float32Array>();
function noiseBuffer(color: NoiseColor, sr: number): Float32Array {
  const key = `${color}:${sr}`;
  let buf = noiseCache.get(key);
  if (!buf) {
    buf = generateNoise(color, Math.round(sr * NOISE_BUFFER_S));
    noiseCache.set(key, buf);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Ambience bed render
// ---------------------------------------------------------------------------

/**
 * Render `seconds` of one ambience bed at full intensity.
 *
 * Beds loop the 2 s noise buffer, so anything past 2 s wraps — which is exactly
 * what the live `AudioBufferSourceNode` with `loop = true` does, seam and all.
 */
export function renderBed(
  bed: AmbienceBedName, seconds = 6, sr = SAMPLE_RATE,
): Float32Array {
  const def = AMBIENCE_BEDS[bed];
  const n = Math.ceil(seconds * sr);
  const out = new Float32Array(n);

  for (const layer of def.layers) {
    const src = noiseBuffer(layer.color, sr);
    const seg = new Float32Array(n);
    for (let i = 0; i < n; i++) seg[i] = src[i % src.length];
    applyBiquad(seg, layer.filter, layer.freq, layer.Q, sr);
    for (let i = 0; i < n; i++) out[i] += seg[i] * bedLayerAmp(layer, i / sr);
  }

  for (let i = 0; i < n; i++) out[i] *= def.gain;
  return out;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export interface Stats {
  samples: number;
  seconds: number;
  peak: number;
  peakDb: number;
  rms: number;
  rmsDb: number;
  /** Last sample index with |x| above -80 dBFS, or -1 if the buffer is silent. */
  lastAudible: number;
  /** Number of samples that would clip a 16-bit render. */
  clipped: number;
}

export function analyse(buf: Float32Array, sr = SAMPLE_RATE): Stats {
  let peak = 0, sum = 0, lastAudible = -1, clipped = 0;
  const floor = Math.pow(10, -80 / 20);
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
    if (a >= 1) clipped++;
    if (a > floor) lastAudible = i;
    sum += buf[i] * buf[i];
  }
  const rms = buf.length > 0 ? Math.sqrt(sum / buf.length) : 0;
  return {
    samples: buf.length,
    seconds: buf.length / sr,
    peak,
    peakDb: db(peak),
    rms,
    rmsDb: db(rms),
    lastAudible,
    clipped,
  };
}

export function db(x: number): number {
  return x <= 0 ? -Infinity : 20 * Math.log10(x);
}

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

/** 16-bit PCM mono RIFF/WAVE. */
export function encodeWav(buf: Float32Array, sr = SAMPLE_RATE): Uint8Array {
  const n = buf.length;
  const out = new Uint8Array(44 + n * 2);
  const dv = new DataView(out.buffer);
  const ascii = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i);
  };

  ascii(0, 'RIFF');
  dv.setUint32(4, 36 + n * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  dv.setUint32(16, 16, true);        // PCM chunk size
  dv.setUint16(20, 1, true);         // format = PCM
  dv.setUint16(22, 1, true);         // channels = mono
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 2, true);    // byte rate
  dv.setUint16(32, 2, true);         // block align
  dv.setUint16(34, 16, true);        // bits per sample
  ascii(36, 'data');
  dv.setUint32(40, n * 2, true);

  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, buf[i]));
    dv.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return out;
}
