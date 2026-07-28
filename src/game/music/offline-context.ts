/**
 * A deterministic, dependency-free subset of OfflineAudioContext for Node.
 *
 * TEST INFRASTRUCTURE ONLY. Nothing under src/game/music/ imports this except
 * the scripts, so it never reaches a bundle.
 *
 * WHY IT EXISTS: the engine must be provable headlessly — byte-identical
 * renders, peak/RMS levels, click detection. Node has no WebAudio.
 *
 * WHY IT IS TRUSTWORTHY: it is not the only instrument. The audition renderer
 * runs the SAME unmodified engine against real Chrome's OfflineAudioContext,
 * and scripts/test-music.mts cross-validates the two renders. If the shim
 * drifted from the browser, that comparison would fail. The synth deliberately
 * uses only pure sines (no band-limited saw/square, whose implementations
 * differ) and RBJ-cookbook biquads, which is exactly what Chrome uses — that
 * is what makes agreement achievable at all.
 *
 * Implemented: Gain, Oscillator (sine/other via phase fn), BiquadFilter
 * (lowpass/highpass/bandpass), AudioBufferSource, StereoPanner, AudioBuffer,
 * AudioParam (setValueAtTime / linearRamp / exponentialRamp / cancel), and
 * node->AudioParam connections. NOT implemented: Convolver, Delay, WaveShaper,
 * Analyser, Panner(3D). The engine uses none of them.
 */

const QUANTUM = 128;

type ParamEventType = 'set' | 'linear' | 'exp';

interface ParamEvent {
  type: ParamEventType;
  time: number;
  value: number;
}

class ShimAudioParam {
  private events: ParamEvent[] = [];
  private _default: number;
  /** Nodes connected into this param; their signal is ADDED. */
  readonly inputs: ShimNode[] = [];

  constructor(defaultValue: number) {
    this._default = defaultValue;
  }

  get value(): number {
    return this._default;
  }
  set value(v: number) {
    this._default = v;
  }

  setValueAtTime(v: number, t: number): ShimAudioParam {
    this.insert({ type: 'set', time: t, value: v });
    return this;
  }
  linearRampToValueAtTime(v: number, t: number): ShimAudioParam {
    this.insert({ type: 'linear', time: t, value: v });
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number): ShimAudioParam {
    this.insert({ type: 'exp', time: t, value: Math.abs(v) < 1e-7 ? 1e-7 : v });
    return this;
  }
  cancelScheduledValues(t: number): ShimAudioParam {
    this.events = this.events.filter((e) => e.time < t);
    return this;
  }

  private insert(e: ParamEvent): void {
    let i = this.events.length;
    while (i > 0 && this.events[i - 1]!.time > e.time) i--;
    this.events.splice(i, 0, e);
  }

  /** Value of the automation timeline at absolute time `t`. */
  valueAt(t: number): number {
    const ev = this.events;
    if (ev.length === 0) return this._default;
    if (t < ev[0]!.time) {
      // Before the first event: a ramp starts from the default value.
      return ev[0]!.type === 'set' ? this._default : this._default;
    }
    let i = 0;
    while (i + 1 < ev.length && ev[i + 1]!.time <= t) i++;
    const cur = ev[i]!;
    const next = ev[i + 1];
    if (!next || next.type === 'set') return cur.value;
    const span = next.time - cur.time;
    if (span <= 0) return next.value;
    const f = (t - cur.time) / span;
    if (next.type === 'linear') return cur.value + (next.value - cur.value) * f;
    const a = Math.abs(cur.value) < 1e-7 ? 1e-7 : cur.value;
    const b = next.value;
    if (a * b <= 0) return cur.value + (b - a) * f; // sign change: fall back to linear
    return a * Math.pow(b / a, f);
  }
}

abstract class ShimNode {
  readonly inputs: ShimNode[] = [];
  /** Nodes and params this one feeds — needed to revive a pruned chain. */
  private readonly outputs: ShimNode[] = [];
  channels = 1;
  protected out: Float32Array[] = [];
  private lastQuantum = -1;
  private visiting = false;

  /**
   * RETIREMENT. Real WebAudio disposes of a source once it has stopped, and
   * of the chain behind it once nothing feeds it. The shim has to do the same
   * explicitly: without it, every note ever played is still processed on every
   * 128-sample quantum, which makes render cost quadratic in clip length — a
   * 24 s render took 40 s before this existed, and grew from there.
   */
  dead = false;
  private everHadInput = false;

  constructor(readonly ctx: ShimOfflineAudioContext) {}

  connect(dest: ShimNode | ShimAudioParam): ShimNode | ShimAudioParam {
    dest.inputs.push(this);
    if (dest instanceof ShimAudioParam) return dest;
    this.outputs.push(dest);
    dest.everHadInput = true;
    dest.revive();
    return dest;
  }

  /**
   * A retired node that receives a new connection comes back. The bus's layer
   * gains go input-less between notes, and must not be permanently pruned out
   * of the mix when the next note arrives.
   */
  private revive(): void {
    if (!this.dead) return;
    this.dead = false;
    for (const o of this.outputs) {
      if (!o.inputs.includes(this)) o.inputs.push(this);
      o.revive();
    }
  }

  disconnect(): void {
    /* the engine never disconnects; retirement is automatic */
  }

  protected ensureOut(n: number): void {
    if (this.out.length !== n) {
      this.out = [];
      for (let i = 0; i < n; i++) this.out.push(new Float32Array(QUANTUM));
    }
  }

  /** Channel count this node emits. */
  protected computeChannels(): number {
    let c = 1;
    for (const i of this.inputs) c = Math.max(c, i.pullChannels());
    return c;
  }

  pullChannels(): number {
    return this.computeChannels();
  }

  /** Sum all inputs into `dst`, pruning any that have retired. */
  protected sumInputs(dst: Float32Array[], q: number): void {
    for (const ch of dst) ch.fill(0);
    for (let k = this.inputs.length - 1; k >= 0; k--) {
      const input = this.inputs[k]!;
      const src = input.pull(q);
      for (let c = 0; c < dst.length; c++) {
        const s = src[Math.min(c, src.length - 1)]!;
        const d = dst[c]!;
        for (let i = 0; i < QUANTUM; i++) d[i]! += s[i]!;
      }
      if (input.dead) this.inputs.splice(k, 1);
    }
    // A processing node whose sources have all retired retires too, which
    // propagates the collapse up through each voice's private chain.
    if (this.everHadInput && this.inputs.length === 0) this.dead = true;
  }

  pull(q: number): Float32Array[] {
    if (this.lastQuantum === q) return this.out;
    if (this.visiting) {
      this.ensureOut(Math.max(1, this.channels));
      for (const ch of this.out) ch.fill(0);
      return this.out;
    }
    this.visiting = true;
    this.lastQuantum = q;
    this.process(q);
    this.visiting = false;
    return this.out;
  }

  protected abstract process(q: number): void;

  protected quantumStart(q: number): number {
    return (q * QUANTUM) / this.ctx.sampleRate;
  }
}

/** True once the quantum starting at `q` lies entirely past `stop`. */
function t0Check(stop: number, q: number, sampleRate: number): boolean {
  return (q * QUANTUM) / sampleRate >= stop;
}

/** Evaluate a param (automation + connected signal) across one quantum. */
function fillParam(
  param: ShimAudioParam,
  scratch: Float32Array,
  q: number,
  ctx: ShimOfflineAudioContext,
): Float32Array {
  const t0 = (q * QUANTUM) / ctx.sampleRate;
  const dt = 1 / ctx.sampleRate;
  for (let i = 0; i < QUANTUM; i++) scratch[i] = param.valueAt(t0 + i * dt);
  for (let k = param.inputs.length - 1; k >= 0; k--) {
    const node = param.inputs[k]!;
    const src = node.pull(q);
    const s = src[0]!;
    for (let i = 0; i < QUANTUM; i++) scratch[i]! += s[i]!;
    if (node.dead) param.inputs.splice(k, 1); // retire e.g. a finished LFO
  }
  return scratch;
}

class ShimGainNode extends ShimNode {
  readonly gain = new ShimAudioParam(1);
  private scratch = new Float32Array(QUANTUM);

  protected process(q: number): void {
    const n = this.computeChannels();
    this.channels = n;
    this.ensureOut(n);
    this.sumInputs(this.out, q);
    const g = fillParam(this.gain, this.scratch, q, this.ctx);
    for (const ch of this.out) {
      for (let i = 0; i < QUANTUM; i++) ch[i]! *= g[i]!;
    }
  }
}

class ShimOscillatorNode extends ShimNode {
  type: OscillatorType = 'sine';
  readonly frequency = new ShimAudioParam(440);
  readonly detune = new ShimAudioParam(0);
  private startTime = Infinity;
  private stopTime = Infinity;
  private phase = 0;
  private fScratch = new Float32Array(QUANTUM);
  private dScratch = new Float32Array(QUANTUM);

  start(when = 0): void {
    this.startTime = when;
  }
  stop(when = 0): void {
    this.stopTime = when;
  }

  override pullChannels(): number {
    return 1;
  }

  protected process(q: number): void {
    this.channels = 1;
    this.ensureOut(1);
    const out = this.out[0]!;
    const sr = this.ctx.sampleRate;
    const t0 = this.quantumStart(q);
    const dt = 1 / sr;

    if (t0 >= this.stopTime) {
      out.fill(0);
      this.dead = true; // retired: real WebAudio disposes a stopped source
      return;
    }
    if (t0 + QUANTUM * dt <= this.startTime) {
      out.fill(0);
      // Keep phase coherent for the un-started case.
      return;
    }
    const f = fillParam(this.frequency, this.fScratch, q, this.ctx);
    const d = fillParam(this.detune, this.dScratch, q, this.ctx);
    for (let i = 0; i < QUANTUM; i++) {
      const t = t0 + i * dt;
      if (t < this.startTime || t >= this.stopTime) {
        out[i] = 0;
        continue;
      }
      const hz = f[i]! * Math.pow(2, d[i]! / 1200);
      out[i] = wave(this.type, this.phase);
      this.phase += hz * dt;
      if (this.phase >= 1) this.phase -= Math.floor(this.phase);
    }
  }
}

function wave(type: OscillatorType, phase: number): number {
  switch (type) {
    case 'sine':
      return Math.sin(2 * Math.PI * phase);
    case 'triangle':
      return 4 * Math.abs(phase - Math.floor(phase + 0.75) + 0.25) - 1;
    case 'square':
      return phase < 0.5 ? 1 : -1;
    case 'sawtooth':
      return 2 * (phase - Math.floor(phase + 0.5));
    default:
      return Math.sin(2 * Math.PI * phase);
  }
}

class ShimBiquadFilterNode extends ShimNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new ShimAudioParam(350);
  readonly Q = new ShimAudioParam(1);
  readonly detune = new ShimAudioParam(0);
  readonly gain = new ShimAudioParam(0);
  private state: { x1: number; x2: number; y1: number; y2: number }[] = [];

  protected process(q: number): void {
    const n = this.computeChannels();
    this.channels = n;
    this.ensureOut(n);
    this.sumInputs(this.out, q);
    while (this.state.length < n) this.state.push({ x1: 0, x2: 0, y1: 0, y2: 0 });

    // Coefficients from the param value at the quantum start. The engine only
    // automates OSCILLATOR frequency, never filter frequency, so this is exact
    // for every patch in voices.ts.
    const t0 = this.quantumStart(q);
    const f0 = Math.max(10, Math.min(this.ctx.sampleRate / 2 - 100, this.frequency.valueAt(t0)));
    const qv = Math.max(0.0001, this.Q.valueAt(t0));
    const w0 = (2 * Math.PI * f0) / this.ctx.sampleRate;
    const cw = Math.cos(w0);
    const sw = Math.sin(w0);
    const alpha = sw / (2 * qv);

    let b0 = 1;
    let b1 = 0;
    let b2 = 0;
    let a0 = 1;
    let a1 = 0;
    let a2 = 0;
    if (this.type === 'lowpass') {
      b0 = (1 - cw) / 2;
      b1 = 1 - cw;
      b2 = (1 - cw) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
    } else if (this.type === 'highpass') {
      b0 = (1 + cw) / 2;
      b1 = -(1 + cw);
      b2 = (1 + cw) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
    } else {
      // bandpass (constant 0 dB peak gain) — Chrome's BANDPASS
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
    }
    const nb0 = b0 / a0;
    const nb1 = b1 / a0;
    const nb2 = b2 / a0;
    const na1 = a1 / a0;
    const na2 = a2 / a0;

    for (let c = 0; c < n; c++) {
      const ch = this.out[c]!;
      const s = this.state[c]!;
      for (let i = 0; i < QUANTUM; i++) {
        const x = ch[i]!;
        const y = nb0 * x + nb1 * s.x1 + nb2 * s.x2 - na1 * s.y1 - na2 * s.y2;
        s.x2 = s.x1;
        s.x1 = x;
        s.y2 = s.y1;
        s.y1 = y;
        ch[i] = y;
      }
    }
  }
}

class ShimAudioBuffer {
  private data: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.data = [];
    for (let i = 0; i < numberOfChannels; i++) this.data.push(new Float32Array(length));
  }
  get duration(): number {
    return this.length / this.sampleRate;
  }
  getChannelData(i: number): Float32Array {
    return this.data[i]!;
  }
}

/**
 * AudioBufferSource.
 *
 * Extended beyond the synth's needs so the SONG side of the engine renders
 * headlessly too: real stereo (the recordings are stereo, and folding them to
 * mono would make every level measurement in the render harness a lie), the
 * three-argument `start(when, offset, duration)` the song player uses to play a
 * SEGMENT of a file, and linear interpolation between samples so a start offset
 * that is not an exact sample boundary does not quantise.
 */
class ShimAudioBufferSourceNode extends ShimNode {
  buffer: ShimAudioBuffer | null = null;
  readonly playbackRate = new ShimAudioParam(1);
  loop = false;
  private startTime = Infinity;
  private stopTime = Infinity;
  private offset = 0;
  /** Seconds of the buffer to play from `offset`, or Infinity for all of it. */
  private duration = Infinity;

  start(when = 0, offset = 0, duration?: number): void {
    this.startTime = when;
    this.offset = offset;
    if (duration !== undefined) this.duration = duration;
  }
  stop(when = 0): void {
    this.stopTime = Math.min(this.stopTime, when);
  }

  override pullChannels(): number {
    return this.buffer?.numberOfChannels ?? 1;
  }

  protected process(q: number): void {
    const buf = this.buffer;
    const nch = buf?.numberOfChannels ?? 1;
    this.channels = nch;
    this.ensureOut(nch);
    for (const ch of this.out) ch.fill(0);
    if (!buf) return;
    if (t0Check(this.stopTime, q, this.ctx.sampleRate)) {
      this.dead = true;
      return;
    }
    const sr = this.ctx.sampleRate;
    const t0 = this.quantumStart(q);
    const dt = 1 / sr;
    // A source that has run past its own duration is finished, exactly as a
    // real one is — without this the graph never collapses and the render cost
    // stays quadratic in clip length (see the RETIREMENT note above).
    if (this.duration !== Infinity && t0 >= this.startTime + this.duration) {
      this.dead = true;
      return;
    }
    const rate = this.playbackRate.valueAt(t0);
    for (let i = 0; i < QUANTUM; i++) {
      const t = t0 + i * dt;
      if (t < this.startTime || t >= this.stopTime) continue;
      const played = (t - this.startTime) * rate;
      if (played >= this.duration) continue;
      let pos = (this.offset + played) * buf.sampleRate;
      if (this.loop) pos %= buf.length;
      else if (pos >= buf.length) continue;
      if (pos < 0) continue;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      for (let c = 0; c < nch; c++) {
        const src = buf.getChannelData(c);
        const a = src[i0] ?? 0;
        const b = src[i0 + 1] ?? a;
        this.out[c]![i] = a + (b - a) * frac;
      }
    }
  }
}

class ShimStereoPannerNode extends ShimNode {
  readonly pan = new ShimAudioParam(0);
  private mono = [new Float32Array(QUANTUM)];
  private scratch = new Float32Array(QUANTUM);

  override pullChannels(): number {
    return 2;
  }

  protected process(q: number): void {
    this.channels = 2;
    this.ensureOut(2);
    this.sumInputs(this.mono, q);
    const p = fillParam(this.pan, this.scratch, q, this.ctx);
    const l = this.out[0]!;
    const r = this.out[1]!;
    const src = this.mono[0]!;
    for (let i = 0; i < QUANTUM; i++) {
      const x = ((Math.max(-1, Math.min(1, p[i]!)) + 1) * Math.PI) / 4;
      l[i] = src[i]! * Math.cos(x);
      r[i] = src[i]! * Math.sin(x);
    }
  }
}

class ShimDestinationNode extends ShimNode {
  override pullChannels(): number {
    return 2;
  }
  protected process(q: number): void {
    this.channels = 2;
    this.ensureOut(2);
    this.sumInputs(this.out, q);
  }
}

export interface RenderedAudio {
  sampleRate: number;
  length: number;
  /** Interleaved-free: one Float32Array per channel. */
  channels: Float32Array[];
}

export class ShimOfflineAudioContext {
  readonly destination: ShimDestinationNode;
  readonly length: number;
  currentTime = 0;

  constructor(
    readonly numberOfChannels: number,
    length: number,
    readonly sampleRate: number,
  ) {
    this.length = Math.max(1, Math.floor(length));
    this.destination = new ShimDestinationNode(this);
  }

  createGain(): ShimGainNode {
    return new ShimGainNode(this);
  }
  createOscillator(): ShimOscillatorNode {
    return new ShimOscillatorNode(this);
  }
  createBiquadFilter(): ShimBiquadFilterNode {
    return new ShimBiquadFilterNode(this);
  }
  createBufferSource(): ShimAudioBufferSourceNode {
    return new ShimAudioBufferSourceNode(this);
  }
  createStereoPanner(): ShimStereoPannerNode {
    return new ShimStereoPannerNode(this);
  }
  createBuffer(channels: number, length: number, sampleRate: number): ShimAudioBuffer {
    return new ShimAudioBuffer(channels, length, sampleRate);
  }

  /** Render the whole graph. Deterministic: no time source, no randomness. */
  render(): RenderedAudio {
    const quanta = Math.ceil(this.length / QUANTUM);
    const chans: Float32Array[] = [];
    for (let c = 0; c < 2; c++) chans.push(new Float32Array(this.length));
    for (let q = 0; q < quanta; q++) {
      this.currentTime = (q * QUANTUM) / this.sampleRate;
      const out = this.destination.pull(q);
      const base = q * QUANTUM;
      const n = Math.min(QUANTUM, this.length - base);
      for (let c = 0; c < 2; c++) {
        const dst = chans[c]!;
        const src = out[Math.min(c, out.length - 1)]!;
        for (let i = 0; i < n; i++) dst[base + i] = src[i]!;
      }
    }
    return { sampleRate: this.sampleRate, length: this.length, channels: chans };
  }
}

/**
 * Hand back a context typed as BaseAudioContext.
 *
 * The cast is deliberate and load-bearing: implementing the full DOM
 * BaseAudioContext surface would be hundreds of lines of members the engine
 * never calls. What matters is that the engine compiles against the REAL DOM
 * types (it does — voices.ts and bus.ts are checked by `tsc --noEmit` against
 * lib.dom), and that the shim implements every member the engine actually
 * touches. If the engine ever reaches for something unimplemented, the render
 * throws immediately rather than silently producing silence.
 */
export function createOfflineContext(
  channels: number,
  length: number,
  sampleRate: number,
): { ctx: BaseAudioContext; render: () => RenderedAudio } {
  const shim = new ShimOfflineAudioContext(channels, length, sampleRate);
  return {
    ctx: shim as unknown as BaseAudioContext,
    render: () => shim.render(),
  };
}
