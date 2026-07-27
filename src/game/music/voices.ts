/**
 * Voice synthesis on WebAudio. CPU only — never touches the WebGPU queue.
 *
 * TIMBRE POLICY: every pitched voice is ADDITIVE SINE PARTIALS. No sawtooth,
 * no square. Three reasons, in order of importance:
 *   1. It suits the material. Wool, felt and stitched seams do not sound like
 *      a filter sweep; they sound like a music box, a dulcimer, a thumb piano.
 *      Sines with fast-decaying upper partials give exactly that.
 *   2. It cannot alias, at any pitch, on any device.
 *   3. Band-limited oscillators differ subtly between implementations. Pure
 *      sines let the offline shim in offline-context.ts agree numerically with
 *      real Chrome, which is what makes the shim a trustworthy instrument.
 *
 * Percussion is filtered noise plus a pitched thump — the noise buffer is
 * generated from mulberry32, never Math.random, so renders stay bit-stable.
 */

import { mulberry32 } from './rng';
import { midiToFreq } from './theory';
import type { DrumId, NoteEvent } from './arranger';
import type { BarPlan, LayerId } from './state';

export interface Partial {
  /** Frequency multiple of the fundamental. */
  ratio: number;
  /** Relative amplitude. */
  gain: number;
  /** Decay-time multiplier — <1 makes this partial die sooner (pluck-like). */
  decayMul: number;
}

export interface Patch {
  partials: readonly Partial[];
  attack: number;
  decay: number;
  /** 0..1 level held until note-off. 0 = purely percussive decay. */
  sustain: number;
  release: number;
  /** Overall output trim. */
  gain: number;
  filter?: { type: BiquadFilterType; freq: number; q: number };
  /** Cents of detune applied to a doubled voice; 0 disables the double. */
  detune?: number;
  /** Amplitude tremolo, used by the tension layer. */
  tremolo?: { rate: number; depth: number };
  pan?: number;
}

/**
 * The instrument set. Everything is soft-edged and short-tailed except the
 * pad and the tension drone, which are the only sustained colours.
 */
export const PATCHES: Record<Exclude<LayerId, 'perc'>, Patch> = {
  pad: {
    partials: [
      { ratio: 1, gain: 0.5, decayMul: 1 },
      { ratio: 2, gain: 0.15, decayMul: 0.9 },
      { ratio: 3, gain: 0.06, decayMul: 0.7 },
    ],
    attack: 0.85,
    decay: 0.8,
    sustain: 0.78,
    release: 1.7,
    gain: 0.5,
    filter: { type: 'lowpass', freq: 1500, q: 0.7 },
    detune: 7,
    pan: 0,
  },
  bass: {
    partials: [
      { ratio: 1, gain: 0.72, decayMul: 1 },
      { ratio: 2, gain: 0.12, decayMul: 0.6 },
    ],
    attack: 0.014,
    decay: 0.28,
    sustain: 0.5,
    release: 0.3,
    gain: 0.72,
    filter: { type: 'lowpass', freq: 520, q: 0.6 },
    pan: 0,
  },
  // The music box: an inharmonic 4th partial is what makes it read as struck
  // metal-on-wood rather than as a synth tone.
  melody: {
    partials: [
      { ratio: 1, gain: 0.6, decayMul: 1 },
      { ratio: 2, gain: 0.2, decayMul: 0.55 },
      { ratio: 3, gain: 0.09, decayMul: 0.35 },
      { ratio: 4.21, gain: 0.05, decayMul: 0.2 },
    ],
    attack: 0.006,
    decay: 0.75,
    sustain: 0.26,
    release: 0.55,
    gain: 0.62,
    filter: { type: 'lowpass', freq: 3600, q: 0.5 },
    pan: -0.12,
  },
  // "Knitting needles" — a nylon-string pluck, dry and close.
  pluck: {
    partials: [
      { ratio: 1, gain: 0.55, decayMul: 1 },
      { ratio: 2, gain: 0.17, decayMul: 0.5 },
      { ratio: 3, gain: 0.07, decayMul: 0.3 },
    ],
    attack: 0.004,
    decay: 0.4,
    sustain: 0.1,
    release: 0.32,
    gain: 0.42,
    filter: { type: 'lowpass', freq: 2700, q: 0.5 },
    pan: 0.18,
  },
  // A hollow fifth-drone. The tremolo is done here, in the gain LFO, so the
  // tension layer costs exactly one voice.
  tension: {
    partials: [
      { ratio: 1, gain: 0.55, decayMul: 1 },
      { ratio: 1.5, gain: 0.2, decayMul: 1 },
      { ratio: 2.02, gain: 0.08, decayMul: 1 },
    ],
    attack: 1.1,
    decay: 0.6,
    sustain: 0.85,
    release: 1.6,
    gain: 0.34,
    filter: { type: 'lowpass', freq: 950, q: 0.8 },
    tremolo: { rate: 5.5, depth: 0.35 },
    pan: 0,
  },
};

export interface DrumPatch {
  /** Noise band. */
  filter: { type: BiquadFilterType; freq: number; q: number };
  noiseGain: number;
  decay: number;
  /** Optional pitched thump. */
  tone?: { freq: number; endFreq: number; gain: number; decay: number };
  pan: number;
}

export const DRUM_PATCHES: Record<DrumId, DrumPatch> = {
  kick: {
    filter: { type: 'lowpass', freq: 220, q: 0.8 },
    noiseGain: 0.16,
    decay: 0.16,
    tone: { freq: 118, endFreq: 46, gain: 0.85, decay: 0.2 },
    pan: 0,
  },
  frame: {
    filter: { type: 'bandpass', freq: 330, q: 1.4 },
    noiseGain: 0.5,
    decay: 0.24,
    tone: { freq: 176, endFreq: 132, gain: 0.3, decay: 0.16 },
    pan: -0.22,
  },
  shaker: {
    filter: { type: 'bandpass', freq: 5200, q: 1.1 },
    noiseGain: 0.34,
    decay: 0.07,
    pan: 0.3,
  },
  rim: {
    filter: { type: 'bandpass', freq: 1750, q: 3.2 },
    noiseGain: 0.42,
    decay: 0.09,
    tone: { freq: 410, endFreq: 400, gain: 0.22, decay: 0.05 },
    pan: 0.34,
  },
};

/** Deterministic white-noise buffer. Built once per engine, shared by all hits. */
export function makeNoiseBuffer(ctx: BaseAudioContext, seed: number, seconds = 1.2): AudioBuffer {
  const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const ch = buf.getChannelData(0);
  const rnd = mulberry32(seed >>> 0);
  for (let i = 0; i < n; i++) ch[i] = rnd() * 2 - 1;
  return buf;
}

const EPS = 0.0001;

/**
 * Write one ADSR into a gain param.
 * Returns the absolute time at which the envelope has fully finished, so the
 * caller can schedule `stop()` strictly AFTER the release — a note is never
 * cut mid-envelope. `test-music.mts` asserts this by rendering and checking
 * for sample discontinuities.
 */
function envelope(
  param: AudioParam,
  when: number,
  holdS: number,
  peak: number,
  patch: Pick<Patch, 'attack' | 'decay' | 'sustain' | 'release'>,
  decayMul: number,
): number {
  const a = patch.attack;
  const d = Math.max(0.01, patch.decay * decayMul);
  const s = patch.sustain * peak;
  const r = patch.release;

  param.setValueAtTime(EPS, when);
  param.linearRampToValueAtTime(Math.max(EPS, peak), when + a);

  const off = when + Math.max(holdS, a + 0.02);
  if (s <= EPS) {
    // Percussive: decay straight to silence, ignore the hold.
    param.exponentialRampToValueAtTime(EPS, when + a + d);
    param.setValueAtTime(0, when + a + d + 0.001);
    return when + a + d + 0.01;
  }
  param.exponentialRampToValueAtTime(Math.max(EPS, s), Math.min(off, when + a + d));
  param.setValueAtTime(Math.max(EPS, s), off);
  param.exponentialRampToValueAtTime(EPS, off + r);
  param.setValueAtTime(0, off + r + 0.001);
  return off + r + 0.01;
}

export interface SpawnedVoice {
  /** Absolute context time at which every node of this voice has gone silent. */
  endTime: number;
  nodeCount: number;
}

/**
 * Build one pitched voice. All nodes are created, scheduled and left to expire
 * on their own — nothing is stopped early, ever.
 */
export function spawnPitched(
  ctx: BaseAudioContext,
  dest: AudioNode,
  patch: Patch,
  freq: number,
  when: number,
  holdS: number,
  vel: number,
): SpawnedVoice {
  let nodes = 0;

  const out = ctx.createGain();
  nodes++;
  out.gain.value = patch.gain * vel;

  let tail: AudioNode = out;
  if (patch.pan !== undefined && patch.pan !== 0 && ctx.createStereoPanner) {
    const pan = ctx.createStereoPanner();
    nodes++;
    pan.pan.value = patch.pan;
    out.connect(pan);
    tail = pan;
  }
  tail.connect(dest);

  let sink: AudioNode = out;
  if (patch.filter) {
    const f = ctx.createBiquadFilter();
    nodes++;
    f.type = patch.filter.type;
    f.frequency.value = patch.filter.freq;
    f.Q.value = patch.filter.q;
    f.connect(out);
    sink = f;
  }

  // Longest envelope this voice will run — needed up front so the tremolo LFO
  // can be given a stop time. Without one the LFO runs forever: every tension
  // note would leave a live oscillator behind for the lifetime of the page.
  let maxDecay = 0;
  for (const p of patch.partials) maxDecay = Math.max(maxDecay, patch.decay * p.decayMul);
  const voiceEnd =
    when +
    (patch.sustain <= 0.0001
      ? patch.attack + maxDecay
      : Math.max(holdS, patch.attack + 0.02) + patch.release) +
    0.05;

  // Tremolo: one LFO into a gain stage the whole voice passes through.
  if (patch.tremolo) {
    const trem = ctx.createGain();
    nodes++;
    trem.gain.value = 1 - patch.tremolo.depth;
    const lfo = ctx.createOscillator();
    nodes++;
    lfo.type = 'sine';
    lfo.frequency.value = patch.tremolo.rate;
    const lfoGain = ctx.createGain();
    nodes++;
    lfoGain.gain.value = patch.tremolo.depth;
    lfo.connect(lfoGain);
    lfoGain.connect(trem.gain);
    trem.connect(sink);
    lfo.start(when);
    lfo.stop(voiceEnd);
    sink = trem;
  }

  let end = when;
  const detunes = patch.detune ? [-patch.detune, patch.detune] : [0];
  const dScale = 1 / detunes.length;

  for (const p of patch.partials) {
    for (const cents of detunes) {
      const osc = ctx.createOscillator();
      nodes++;
      osc.type = 'sine';
      osc.frequency.value = freq * p.ratio;
      if (cents !== 0) osc.detune.value = cents;

      const g = ctx.createGain();
      nodes++;
      const e = envelope(g.gain, when, holdS, p.gain * dScale, patch, p.decayMul);
      end = Math.max(end, e);

      osc.connect(g);
      g.connect(sink);
      osc.start(when);
      osc.stop(e + 0.02); // strictly after the release has finished
    }
  }
  return { endTime: end, nodeCount: nodes };
}

/** Build one percussion hit from the shared noise buffer. */
export function spawnDrum(
  ctx: BaseAudioContext,
  dest: AudioNode,
  patch: DrumPatch,
  noise: AudioBuffer,
  when: number,
  vel: number,
  offsetS: number,
): SpawnedVoice {
  let nodes = 0;
  const out = ctx.createGain();
  nodes++;
  out.gain.value = vel;

  let tail: AudioNode = out;
  if (patch.pan !== 0 && ctx.createStereoPanner) {
    const pan = ctx.createStereoPanner();
    nodes++;
    pan.pan.value = patch.pan;
    out.connect(pan);
    tail = pan;
  }
  tail.connect(dest);

  let end = when;

  const src = ctx.createBufferSource();
  nodes++;
  src.buffer = noise;
  const nf = ctx.createBiquadFilter();
  nodes++;
  nf.type = patch.filter.type;
  nf.frequency.value = patch.filter.freq;
  nf.Q.value = patch.filter.q;
  const ng = ctx.createGain();
  nodes++;
  ng.gain.setValueAtTime(patch.noiseGain, when);
  ng.gain.exponentialRampToValueAtTime(EPS, when + patch.decay);
  ng.gain.setValueAtTime(0, when + patch.decay + 0.001);
  src.connect(nf);
  nf.connect(ng);
  ng.connect(out);
  // Offset into the shared buffer keeps consecutive hits from being identical.
  src.start(when, offsetS % Math.max(0.001, noise.duration - patch.decay - 0.02));
  src.stop(when + patch.decay + 0.03);
  end = Math.max(end, when + patch.decay + 0.03);

  if (patch.tone) {
    const osc = ctx.createOscillator();
    nodes++;
    osc.type = 'sine';
    osc.frequency.setValueAtTime(patch.tone.freq, when);
    osc.frequency.exponentialRampToValueAtTime(patch.tone.endFreq, when + patch.tone.decay);
    const tg = ctx.createGain();
    nodes++;
    tg.gain.setValueAtTime(patch.tone.gain, when);
    tg.gain.exponentialRampToValueAtTime(EPS, when + patch.tone.decay);
    tg.gain.setValueAtTime(0, when + patch.tone.decay + 0.001);
    osc.connect(tg);
    tg.connect(out);
    osc.start(when);
    osc.stop(when + patch.tone.decay + 0.03);
    end = Math.max(end, when + patch.tone.decay + 0.03);
  }
  return { endTime: end, nodeCount: nodes };
}

/** Note event -> Hz. */
export function noteFreq(n: NoteEvent): number {
  return midiToFreq(n.midi);
}

/** Hold time in seconds for a note event on this bar's grid. */
export function noteHold(n: NoteEvent, plan: BarPlan): number {
  return (n.dur * plan.secPerBar) / 16;
}
