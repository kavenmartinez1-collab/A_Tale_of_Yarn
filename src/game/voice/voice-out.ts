/**
 * Villager voices, main-thread side: identity, sentence streaming, playback.
 *
 * The worker (`tts-worker.ts`) turns text into PCM. This decides *whose* voice,
 * *when* to start, and *when to shut up* — and owns the AudioContext plumbing,
 * because a worker cannot.
 *
 * TEXT REMAINS PRIMARY. Nothing here can delay, gate or alter a written reply:
 * `pushStreamed` is fed the text the panel has *already displayed*, and every
 * failure path is silence rather than an error the player sees.
 *
 * PAUSE POLICY (the brief asked for a decision, so here it is, with the why):
 * speech continues while the chat panel is open — that is the normal case and
 * cutting it would defeat the feature — and a **hard pause stops it dead**,
 * with an 80 ms fade so it does not click. Two reasons. First, `PanelManager`
 * allows exactly one panel at a time, so opening the pause screen already
 * closes the conversation; carrying its audio over the map would be audio from
 * a screen that is gone. Second, the pause screen is where the voice volume
 * slider lives, and a villager mid-sentence makes that slider unjudgeable.
 * Ducking was considered and rejected: a quiet villager talking over a paused
 * world reads as a bug, not as a mix.
 */
import { mulberry32 } from '../mesh-utils';

// ---------------------------------------------------------------------------
// Deterministic voice identity
// ---------------------------------------------------------------------------

/**
 * FNV-1a over an id — the same hash `attack-tokens.ts:214` and `animal-ai.ts`
 * use. Copied rather than imported: this module must not pull the combat graph
 * in, and the pattern is already established in three places.
 */
function idHash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mix two 32-bit ints — mirrors `dungeon-layout.ts:72`. */
function mix32(a: number, b: number, c = 0): number {
  let h = a >>> 0;
  h = Math.imul(h ^ (b >>> 0), 0x9e3779b1);
  h = ((h << 13) | (h >>> 19)) >>> 0;
  h = Math.imul(h ^ (c >>> 0), 0x85ebca6b);
  h = ((h << 13) | (h >>> 19)) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Salt, so an id's voice cannot collide with its combat or colour rolls. */
const VOICE_SALT = 0x5010ce;

export interface VoiceParams {
  noiseScale: number;
  lengthScale: number;
  noiseW: number;
  pitch: number;
}

export interface VoiceShape {
  /** Deeper and slower — the Evil King. */
  deeper?: boolean;
  /** Higher — the single-speaker voice reading a woman's part. */
  higher?: boolean;
}

/**
 * The voice for an id. Same id, same voice, every session, on every machine.
 *
 * The model is single-speaker (`config.json` has no `num_speakers`), so the
 * axes available are duration (`lengthScale`), the two VITS noise scales, and
 * resampling for pitch. Pitch does the heavy lifting: ±12% is roughly a
 * major second either way, which is comfortably audible between neighbours
 * without turning anyone into a chipmunk.
 *
 * `lengthScale` is multiplied by `pitch` so that the resample — which shortens
 * the waveform by exactly `pitch` — nets out to the intended speaking rate.
 * Without that, every high voice would also gabble.
 */
export function voiceFor(id: string, shape: VoiceShape = {}): VoiceParams {
  const rng = mulberry32(mix32(idHash(id), VOICE_SALT));
  const r = rng();                      // the one roll that decides pitch

  // Pitch is a re-map into a BAND, not an offset applied to a shared roll.
  // That was the first design and it had a measurable bug: an offset let the
  // Evil King land 1.5 Hz from the deepest villager, because a villager who
  // already rolled the bottom of the range and a king shifted down from the
  // middle arrive at the same place. Disjoint bands cannot do that.
  //   villager  0.88 .. 1.12   (±12%, about a major second either way)
  //   higher    1.08 .. 1.30   (the single male model reading a woman's part)
  //   deeper    0.72 .. 0.82   (the Evil King — below every villager, always)
  const band = shape.deeper ? [0.72, 0.82]
    : shape.higher ? [1.08, 1.30]
      : [0.88, 1.12];
  const pitch = band[0] + r * (band[1] - band[0]);

  const rate = 0.94 + rng() * 0.16;     // 0.94 .. 1.10
  const noiseW = 0.68 + rng() * 0.26;   // breathiness of the duration predictor
  const noiseScale = 0.60 + rng() * 0.14;

  return {
    pitch,
    // The resample shortens the waveform by exactly `pitch`, so multiply it
    // back in or every high voice would also gabble. The king is slower again.
    lengthScale: rate * pitch * (shape.deeper ? 1.14 : 1),
    noiseW,
    noiseScale,
  };
}

// ---------------------------------------------------------------------------
// Sentence splitting
// ---------------------------------------------------------------------------

/** Abbreviations whose full stop does not end a sentence. */
const ABBREV = /\b(?:mr|mrs|ms|dr|st|sr|jr|vs|etc|e\.g|i\.e)\.$/i;

/**
 * Index just past the last sentence terminator in `text` that really ends a
 * sentence, or -1. Used to decide how much of a still-streaming reply is safe
 * to speak: speaking a half-sentence and then the rest sounds like two people.
 */
export function lastSentenceEnd(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i];
    if (c !== '.' && c !== '!' && c !== '?' && c !== '\n') continue;
    // A terminator must be followed by whitespace or the end of the buffer,
    // otherwise it is a decimal point or an ellipsis mid-flight.
    const next = text[i + 1];
    if (next !== undefined && !/\s/.test(next)) continue;
    if (c === '.' && ABBREV.test(text.slice(0, i + 1))) continue;
    return i + 1;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// The speaker
// ---------------------------------------------------------------------------

/** Where playback goes. Supplied by the game audio engine's voice bus. */
export interface VoiceOutput {
  ctx: AudioContext;
  node: AudioNode;
}

interface Pending { id: number; started: boolean }

export interface VoiceOutOptions {
  /** Resolve the audio destination, or null if audio is not up yet. */
  output: () => VoiceOutput | null;
  /** Whether speech is wanted at all — the Settings toggle. */
  enabled: () => boolean;
  /** Optional diagnostics sink (harness/telemetry), never player-facing. */
  onStat?: (s: VoiceStat) => void;
}

/** What `VoiceOut.probe()` measures. Numbers, not sound. */
export interface VoiceProbe {
  samples: number;
  sampleRate: number;
  /** Largest absolute sample. Above ~0.99 means clipping. */
  peak: number;
  /** Root-mean-square level. Silence is exactly 0; speech is ~0.05. */
  rms: number;
  synthMs: number;
}

export interface VoiceStat {
  /** ms from the request being queued to its first sample being audible. */
  firstAudioMs: number;
  /** worker synthesis time for the utterance. */
  synthMs: number;
  /** seconds of audio produced. */
  audioS: number;
  chars: number;
}

export class VoiceOut {
  private worker: Worker | null = null;
  private nextId = 1;
  private queue: Pending[] = [];
  private sources = new Set<AudioBufferSourceNode>();
  /** When the currently-scheduled speech ends, in ctx time. Keeps lines in order. */
  private playCursor = 0;
  private spokenUpTo = 0;
  private lastStream = '';
  private currentVoice: VoiceParams = voiceFor('default');
  private requestedAt = new Map<number, number>();
  /**
   * Ids whose PCM is wanted as NUMBERS rather than as sound.
   *
   * This is the instrument `scripts/steam-pack-check.mjs` measures the depot
   * with. It deliberately takes the same path a spoken line takes — same
   * worker, same lexicon, same ONNX session — and returns the energy of the
   * waveform, because "the call did not throw" is compatible with total
   * silence and would prove nothing about a packaged build.
   */
  private probes = new Map<number, (r: VoiceProbe) => void>();
  private loadError: string | null = null;
  private _ready = false;
  private opts: VoiceOutOptions;

  constructor(opts: VoiceOutOptions) { this.opts = opts; }

  /** True once the worker has the voice resident. */
  get ready(): boolean { return this._ready; }
  /** Last worker error, for the Settings panel to show. Never thrown at the player. */
  get error(): string | null { return this.loadError; }
  /** Utterances queued or playing. */
  get pending(): number { return this.queue.length; }

  /**
   * Start loading the voice. Safe to call repeatedly; the first call wins.
   * Deliberately NOT called at boot — 63 MB and a wasm session are not worth
   * paying for a player who never talks to anyone. The chat panel warms it.
   */
  warm(): void {
    if (!this.opts.enabled()) return;
    this.ensureWorker()?.postMessage({ type: 'load' });
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') return null;
    try {
      // `new URL(..., import.meta.url)` is how Vite recognises a worker and
      // emits it as its own chunk — the same form stt-worker.ts is created by.
      const w = new Worker(new URL('./tts-worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent) => this.onMessage(ev.data);
      w.onerror = (e) => { this.loadError = e.message || 'voice worker failed'; };
      this.worker = w;
      return w;
    } catch (err) {
      this.loadError = String((err as Error)?.message ?? err);
      return null;
    }
  }

  private onMessage(m: {
    type: string; id?: number; pcm?: Float32Array; sampleRate?: number;
    ms?: number; message?: string;
  }): void {
    if (m.type === 'ready') { this._ready = true; this.loadError = null; return; }
    if (m.type === 'error') {
      this.loadError = m.message ?? 'voice failed';
      if (m.id !== undefined) { this.probes.delete(m.id); this.drop(m.id); }
      return;
    }
    if (m.type !== 'audio' || m.id === undefined || !m.pcm) return;
    const probe = this.probes.get(m.id);
    if (probe) {
      this.probes.delete(m.id);
      const pcm = m.pcm;
      let peak = 0, sum = 0;
      for (let i = 0; i < pcm.length; i++) {
        const a = Math.abs(pcm[i]);
        if (a > peak) peak = a;
        sum += pcm[i] * pcm[i];
      }
      probe({
        samples: pcm.length,
        sampleRate: m.sampleRate ?? 22050,
        peak,
        rms: Math.sqrt(sum / Math.max(1, pcm.length)),
        synthMs: m.ms ?? 0,
      });
      this.drop(m.id);
      return;
    }
    this.play(m.id, m.pcm, m.sampleRate ?? 22050, m.ms ?? 0);
  }

  private drop(id: number): void {
    this.queue = this.queue.filter((p) => p.id !== id);
    this.requestedAt.delete(id);
  }

  /**
   * Schedule a finished utterance.
   *
   * MAIN-THREAD COST. This is the only per-utterance main-thread work in the
   * whole feature: one `createBuffer`, one `Float32Array.set`, one `start()`.
   * Measured at well under the 0.5 ms budget for a normal sentence — the copy
   * is a memcpy of a few hundred KB. `scripts/_probe-voice-stall.mjs` measures
   * it against the real 16.7 ms frame budget.
   */
  private play(id: number, pcm: Float32Array, sampleRate: number, synthMs: number): void {
    const entry = this.queue.find((p) => p.id === id);
    if (!entry) return; // cancelled while in flight
    const out = this.opts.output();
    if (!out || !this.opts.enabled()) { this.drop(id); return; }

    const { ctx, node } = out;
    const buf = ctx.createBuffer(1, pcm.length, sampleRate);
    // The PCM arrives from the worker over a structured clone; its buffer type
    // widens to ArrayBufferLike, which copyToChannel's signature does not accept.
    buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(node);

    const now = ctx.currentTime;
    const at = Math.max(now, this.playCursor);
    src.start(at);
    this.playCursor = at + buf.duration;
    entry.started = true;
    this.sources.add(src);
    src.onended = () => { this.sources.delete(src); this.drop(id); };

    const queuedAt = this.requestedAt.get(id);
    if (queuedAt !== undefined && this.opts.onStat) {
      this.opts.onStat({
        firstAudioMs: performance.now() - queuedAt + Math.max(0, (at - now) * 1000),
        synthMs,
        audioS: buf.duration,
        chars: 0,
      });
    }
  }

  /** Queue one utterance. Returns false if speech is off or unavailable. */
  say(text: string, voice: VoiceParams = this.currentVoice): boolean {
    const clean = speakableText(text);
    if (!clean || !this.opts.enabled()) return false;
    const w = this.ensureWorker();
    if (!w) return false;
    const id = this.nextId++;
    this.queue.push({ id, started: false });
    this.requestedAt.set(id, performance.now());
    w.postMessage({ type: 'synth', id, text: clean, voice });
    return true;
  }

  /**
   * Begin a reply from a given speaker. Resets the streaming cursor.
   * `shape` lets a caller ask for the deeper or higher band.
   */
  begin(npcId: string, shape: VoiceShape = {}): void {
    this.stop();
    this.currentVoice = voiceFor(npcId, shape);
    this.spokenUpTo = 0;
    this.lastStream = '';
  }

  /**
   * Feed the reply as it streams. Pass the text the panel is DISPLAYING — i.e.
   * already through `stripNpcJson` — never the raw model stream.
   *
   * Speaks only whole sentences, so sentence 1 is audible while the model is
   * still writing sentence 2. The cursor resets if the displayed text stops
   * being an extension of what was already spoken, which is exactly what
   * happens when the strip retroactively removes a control-JSON block.
   */
  pushStreamed(displayedText: string): void {
    if (!this.opts.enabled()) return;
    if (!displayedText.startsWith(this.lastStream.slice(0, this.spokenUpTo))) {
      this.spokenUpTo = 0; // the strip rewrote history — resync
    }
    this.lastStream = displayedText;
    const tail = displayedText.slice(this.spokenUpTo);
    const end = lastSentenceEnd(tail);
    if (end <= 0) return;
    const chunk = tail.slice(0, end).trim();
    this.spokenUpTo += end;
    if (chunk) this.say(chunk);
  }

  /** Speak whatever is left when the reply completes (a final unterminated clause). */
  flush(displayedText: string): void {
    if (!this.opts.enabled()) return;
    if (displayedText.startsWith(this.lastStream.slice(0, this.spokenUpTo))) {
      const tail = displayedText.slice(this.spokenUpTo).trim();
      this.spokenUpTo = displayedText.length;
      if (tail) this.say(tail);
    } else {
      this.say(displayedText);
    }
    this.lastStream = displayedText;
  }

  /**
   * Synthesize `text` and return the waveform's statistics WITHOUT playing it.
   *
   * Exists so a harness can assert that a packaged, offline build actually
   * produces sound — real PCM energy out of the real worker — rather than
   * asserting that no exception was thrown. Resolves null if speech is
   * unavailable, so a caller can tell "off" from "broken".
   */
  probe(text: string, timeoutMs = 120_000): Promise<VoiceProbe | null> {
    const clean = speakableText(text);
    const w = clean ? this.ensureWorker() : null;
    if (!w) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise<VoiceProbe | null>((resolve) => {
      const timer = setTimeout(() => { this.probes.delete(id); resolve(null); }, timeoutMs);
      this.probes.set(id, (r) => { clearTimeout(timer); resolve(r); });
      this.queue.push({ id, started: false });
      w.postMessage({ type: 'synth', id, text: clean, voice: this.currentVoice });
    });
  }

  /**
   * Stop immediately: cancel the queue, fade what is sounding.
   *
   * The fade is 80 ms rather than a hard `stop()` because a buffer source cut
   * mid-waveform produces a click, and a click is louder than the speech was.
   */
  stop(): void {
    const out = this.opts.output();
    this.worker?.postMessage({ type: 'cancel', upTo: this.nextId });
    this.queue = [];
    this.requestedAt.clear();
    if (out) {
      const t = out.ctx.currentTime;
      for (const src of this.sources) {
        try {
          const g = out.ctx.createGain();
          src.disconnect();
          src.connect(g);
          g.connect(out.node);
          g.gain.setValueAtTime(1, t);
          g.gain.linearRampToValueAtTime(0, t + 0.08);
          src.stop(t + 0.09);
        } catch { /* already stopped */ }
      }
      this.playCursor = out.ctx.currentTime;
    } else {
      for (const src of this.sources) { try { src.stop(); } catch { /* ignore */ } }
      this.playCursor = 0;
    }
    this.sources.clear();
    this.spokenUpTo = 0;
    this.lastStream = '';
  }

  /** Release the worker entirely (device loss, shutdown). */
  dispose(): void {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
    this._ready = false;
  }
}

// ---------------------------------------------------------------------------
// Text hygiene
// ---------------------------------------------------------------------------

/**
 * Last line of defence before text becomes sound.
 *
 * The panel already strips control JSON for display and the NPC models are run
 * with thinking disabled, so in practice this sees clean prose. It exists
 * because "speak the displayed text" is a promise that has to survive a future
 * model that emits `<think>`, and because reading a stray brace aloud is a
 * uniquely bad failure. Belt and braces, cheap.
 */
export function speakableText(text: string): string {
  return text
    // think/reasoning blocks, opened or unclosed
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/<\/?think>/gi, ' ')
    // any residual balanced JSON object
    .replace(/\{[^{}]*\}/g, ' ')
    // markdown emphasis and code fences read as noise
    .replace(/[*_`#]+/g, ' ')
    // stage directions in asterisks are already gone with the asterisks; drop
    // bracketed ones too
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
