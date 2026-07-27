/**
 * Villager voices — piper VITS (en_US-joe-medium for men, en_US-ljspeech-medium
 * for women) on ORT wasm/SIMD, off-thread.
 *
 * WHY A WORKER, AND WHY NOT THE GPU. Identical reasoning to `stt-worker.ts`,
 * and it is structural rather than a preference: WebGPU v1 gives one queue per
 * device, the renderer and the NPC LLM already contend for it (the measured
 * Steam Deck problem), and a third client would make every spoken line cost
 * the frame it interrupted. So this imports `./ort-bootstrap`, which pulls
 * `onnxruntime-web/wasm` — the build with NO JSEP/WebGPU execution provider
 * compiled in. There is no flag to put speech on the GPU queue later; the code
 * is not in the binary. The same 11.1 MB wasm already ships for Whisper, so
 * voices cost the depot nothing but the voice itself.
 *
 * WHY NOT `src/audio/piper.ts`. That hand-written TypeScript VITS is the
 * companion app's, and it is parity-gated and correct — but measured at
 * **6.5× real time** on CPU (scripts/_probe-tts-cpu.mts: 40 s of compute for a
 * 6 s line). Its own answer to that is `piper-dec-gpu.ts`, which is the GPU
 * queue this must stay off. Under ORT the identical model runs at ~0.03-0.04×
 * real time — a 200× difference that decides the design on its own.
 *
 * WHY NOT eSpeak FOR G2P. eSpeak NG is GPL-3.0 and `scripts/pack-steam.mjs`
 * refuses to build a depot containing it. `src/audio/g2p-en.ts` replaces it
 * with a baked CMUdict lexicon (BSD-2-Clause) plus letter-to-sound rules.
 *
 * THE FIRST IMPORT MUST STAY FIRST — `./ort-bootstrap` sets ORT's wasm paths,
 * and they are read once at module-evaluation time. See that file.
 */
import { ort, ortInfo } from './ort-bootstrap';
import { parseLexicon, textToIds, type Lexicon, type PhonemeIdMap } from '../../audio/g2p-en';

/**
 * Repo ids, resolving to models/rhasspy--piper-en-us-*-medium in both servers.
 *
 * Both halves of these odd-looking strings are load-bearing, and both were
 * arrived at by testing rather than by reading:
 *
 *  - The `local/` prefix is what the DEV server (`server/dev-server.ts`)
 *    understands for a flat vendored directory. `rhasspy/piper-en-us-joe-medium`
 *    404s there; `local/<dirname>` is the form it enumerates, and it is the
 *    same form `src/audio/piper-loader.ts` already uses.
 *  - The `--` inside the directory name is what gets it into the depot at all:
 *    `pack-steam.mjs` ships a model directory only if its name contains `--`.
 *    Without it the voice is simply absent from the packaged game.
 *
 * The packaged loopback server (`app/steam/local-server.cjs`) accepts both
 * forms, so these ids work in dev, in a `vite preview`, and in the depot.
 *
 * TWO MODELS, BECAUSE ONE CANNOT DO BOTH GENDERS. Pitch-resampling a male
 * voice up does not make it female — the formants ride along and it becomes a
 * fast small man. `voice-out.ts` explains the full reasoning at `BANDS`.
 */
type ModelId = 'male' | 'female';

const VOICES: Record<ModelId, { repo: string; base: string }> = {
  male: { repo: 'local/rhasspy--piper-en-us-joe-medium', base: 'en_US-joe-medium' },
  female: { repo: 'local/rhasspy--piper-en-us-ljspeech-medium', base: 'en_US-ljspeech-medium' },
};

/**
 * The G2P lexicon is a property of the LANGUAGE, not of the voice: it maps
 * English words to IPA, and both models consume the same IPA through their own
 * `phoneme_id_map`. It is fetched once and shared.
 *
 * It lives in joe's directory because that is where `scripts/build-lexicon.mts`
 * writes it and where `scripts/test-g2p-en.mts` reads it; duplicating 2.8 MB
 * into the second voice's directory would cost depot bytes to say the same
 * thing twice. `steam-pack-check.mjs` asserts both directories ship, so the
 * dependency cannot rot silently.
 *
 * Verified before relying on it: ljspeech's `phoneme_id_map` is a strict
 * SUPERSET of joe's (157 vs 151 entries) and assigns the same id to all 151
 * shared phonemes, so identical lexicon output drives both models correctly.
 */
const LEXICON_URL = `/api/hf-cache/${VOICES.male.repo}/resolve/main/lexicon-en-us.txt`;

export interface TtsVoiceParams {
  /** VITS noise_scale — timbre variation. Model default 0.667. */
  noiseScale: number;
  /** VITS length_scale — duration multiplier. >1 slower. Model default 1. */
  lengthScale: number;
  /** VITS noise_scale_w — duration-predictor noise. Model default 0.8. */
  noiseW: number;
  /**
   * Resample ratio applied after synthesis: >1 raises pitch, <1 lowers it.
   * Each model is single-speaker (config has no `num_speakers`), so this is
   * the only pitch axis available WITHIN a model. `lengthScale` is
   * pre-compensated by the caller so the line keeps its intended duration.
   */
  pitch: number;
  /** Which vendored model to synthesize on. */
  model: ModelId;
}

type Req =
  | { type: 'load'; model?: ModelId }
  | { type: 'synth'; id: number; text: string; voice: TtsVoiceParams }
  | { type: 'cancel'; upTo: number };

type Res =
  | { type: 'ready'; model: ModelId; loadMs: number; threads: number;
      crossOriginIsolated: boolean; sampleRate: number; lexiconEntries: number }
  | { type: 'audio'; id: number; pcm: Float32Array; sampleRate: number; ms: number }
  | { type: 'error'; id?: number; message: string };

const post = (m: Res, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(m, transfer ?? []);

interface Loaded {
  sess: InstanceType<typeof ort.InferenceSession>;
  idMap: PhonemeIdMap;
  sampleRate: number;
}

/**
 * One entry per model, created on first use.
 *
 * LAZY PER MODEL, deliberately. Loading both at the first spoken line would
 * double the cold-start cost for a player who then only ever talks to one
 * villager. A conversation warms exactly the model that NPC needs; the other
 * is not fetched until somebody of the other gender speaks.
 */
const sessions = new Map<ModelId, Promise<Loaded>>();

/** The lexicon is shared by both models — fetched and parsed once. */
let lexicon: Promise<Lexicon> | null = null;

/**
 * Ids at or below this are abandoned. Synthesis is not interruptible mid-run
 * (one ORT call is atomic), but the queue in front of it is: when the player
 * sends the next line, everything already queued is dropped rather than played
 * over the top.
 */
let cancelledUpTo = -1;

function loadLexicon(): Promise<Lexicon> {
  return (lexicon ??= (async () => {
    const resp = await fetch(LEXICON_URL);
    if (!resp.ok) throw new Error(`[tts] lexicon: HTTP ${resp.status}`);
    return parseLexicon(await resp.text());
  })());
}

function load(model: ModelId): Promise<Loaded> {
  const existing = sessions.get(model);
  if (existing) return existing;

  const p = (async (): Promise<Loaded> => {
    const t0 = performance.now();
    const { repo, base } = VOICES[model];
    const BASE = `/api/hf-cache/${repo}`;

    const cfgResp = await fetch(`${BASE}/raw/main/${base}.onnx.json`);
    if (!cfgResp.ok) throw new Error(`[tts] ${model} voice config: HTTP ${cfgResp.status}`);
    const cfg = await cfgResp.json();
    const idMap = cfg.phoneme_id_map as PhonemeIdMap;
    if (!idMap) throw new Error(`[tts] ${model} voice config missing phoneme_id_map`);
    const sampleRate: number = cfg.audio?.sample_rate ?? 22050;

    const lex = await loadLexicon();

    const modelResp = await fetch(`${BASE}/resolve/main/${base}.onnx`);
    if (!modelResp.ok) throw new Error(`[tts] ${model} voice model: HTTP ${modelResp.status}`);
    const bytes = new Uint8Array(await modelResp.arrayBuffer());

    const sess = await ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });

    post({
      type: 'ready',
      model,
      loadMs: performance.now() - t0,
      threads: ortInfo.threads,
      crossOriginIsolated: ortInfo.crossOriginIsolated,
      sampleRate,
      lexiconEntries: lex.size,
    });
    return { sess, idMap, sampleRate };
  })();

  // A failed load must not be cached as a permanent failure: the next attempt
  // should be allowed to retry (a transient 5xx from the loopback server on a
  // cold depot is exactly the case this protects).
  p.catch(() => { if (sessions.get(model) === p) sessions.delete(model); });
  sessions.set(model, p);
  return p;
}

/**
 * Linear resample. Pitch-shifts by playing the waveform faster or slower; the
 * caller compensates duration through `lengthScale`, so the net effect is a
 * different voice at the same speaking rate. Linear interpolation is adequate
 * for the ±12% range the voice table uses — the artefacts it introduces sit
 * above 8 kHz where this 22.05 kHz voice has almost no energy.
 */
function resample(src: Float32Array, ratio: number): Float32Array {
  if (Math.abs(ratio - 1) < 1e-3) return src;
  const outLen = Math.max(1, Math.floor(src.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = src[i0] ?? 0;
    const b = src[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

async function synth(id: number, text: string, voice: TtsVoiceParams): Promise<void> {
  const model: ModelId = voice.model === 'female' ? 'female' : 'male';
  const [{ sess, idMap, sampleRate }, lex] = await Promise.all([load(model), loadLexicon()]);
  if (id <= cancelledUpTo) return; // abandoned while the model was loading

  const ids = textToIds(text, lex, idMap);
  // [BOS,PAD] + [EOS] alone is 3 ids — anything that short has no words in it.
  if (ids.length <= 4) return;

  const t0 = performance.now();
  const out = await sess.run({
    input: new ort.Tensor('int64', BigInt64Array.from(ids.map((v) => BigInt(v))), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32',
      Float32Array.from([voice.noiseScale, voice.lengthScale, voice.noiseW]), [3]),
  });
  if (id <= cancelledUpTo) return; // player moved on while this was running

  const raw = out[sess.outputNames[0]].data as Float32Array;
  const pcm = resample(raw, voice.pitch);
  post({ type: 'audio', id, pcm, sampleRate, ms: performance.now() - t0 }, [pcm.buffer]);
}

/**
 * One request at a time, in order.
 *
 * ORT sessions are not re-entrant and sentences must be spoken in the order
 * they were written, so requests chain onto a single promise — the same
 * `chainGen` discipline `gguf-session.ts` uses for the shared LLM session.
 */
let chain: Promise<void> = Promise.resolve();

self.onmessage = (ev: MessageEvent<Req>) => {
  const msg = ev.data;
  if (msg.type === 'load') {
    const model: ModelId = msg.model === 'female' ? 'female' : 'male';
    chain = chain.then(async () => {
      try { await load(model); }
      catch (err) { post({ type: 'error', message: String((err as Error)?.message ?? err) }); }
    });
    return;
  }
  if (msg.type === 'cancel') {
    cancelledUpTo = Math.max(cancelledUpTo, msg.upTo);
    return;
  }
  const { id, text, voice } = msg;
  chain = chain.then(async () => {
    try { await synth(id, text, voice); }
    catch (err) { post({ type: 'error', id, message: String((err as Error)?.message ?? err) }); }
  });
};
