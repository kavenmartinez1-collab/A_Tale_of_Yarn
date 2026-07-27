/**
 * Speech-to-text worker — Whisper base.en (int8 ONNX) on ORT wasm/SIMD.
 *
 * WHY A WORKER. Transcription is 0.4-2 s of straight-line CPU. On the main
 * thread that is 25-120 dropped frames and the world visibly stops while the
 * player is mid-conversation. Everything here runs off the render thread; the
 * only main-thread work left is posting a Float32Array in and taking a string
 * out (both transferable / structured-clone cheap).
 *
 * WHY NOT THE GPU — and why this is structural, not a setting. WebGPU v1 gives
 * one queue per device. The renderer and the NPC LLM already contend for it,
 * which is the Steam Deck's measured problem, and adding a third client would
 * make voice input pay for the frame it interrupted. So this imports
 * `onnxruntime-web/wasm`, which is the build with NO JSEP/WebGPU execution
 * provider compiled into it at all. There is no flag anyone can flip later to
 * put Whisper back on the GPU queue; the code to do it is not in the binary.
 * It is also half the size (11.1 MB vs the 21.6 MB jsep build).
 *
 * THE FIRST TWO IMPORTS BELOW MUST STAY IN THAT ORDER. `./ort-bootstrap` sets
 * ONNX Runtime's wasm paths, and transformers.js reads them exactly once at
 * module-evaluation time — if it gets there first it points itself at a
 * jsDelivr CDN and the offline build phones home. See that file; it exists only
 * to make this ordering explicit and enforceable.
 */
import { ortInfo } from './ort-bootstrap';
import * as transformers from '@huggingface/transformers';

/** Repo id as the loopback weight server resolves it → models/Xenova--whisper-base.en. */
const MODEL_ID = 'Xenova/whisper-base.en';

/** Whisper's fixed analysis window. Longer audio is truncated by the frontend. */
const MAX_SECONDS = 30;

export interface SttLoadProgress { file: string; loaded: number; total: number }

type Req =
  | { type: 'load' }
  | { type: 'transcribe'; id: number; audio: Float32Array; prompt: string };

type Res =
  | { type: 'ready'; loadMs: number; threads: number; crossOriginIsolated: boolean }
  | { type: 'progress'; file: string; loaded: number; total: number }
  | { type: 'result'; id: number; text: string; ms: number; encodeMs: number }
  | { type: 'error'; id?: number; message: string };

const post = (m: Res) => (self as unknown as Worker).postMessage(m);

let ready: Promise<Loaded> | null = null;

interface Loaded {
  tokenizer: any;
  processor: any;
  model: any;
  /** <|startofprev|>, <|startoftranscript|>, <|notimestamps|> */
  sop: number; sot: number; nots: number;
}

async function load(): Promise<Loaded> {
  const t0 = performance.now();
  const env = (transformers as unknown as { env: Record<string, unknown> }).env;

  // Every model byte comes from the loopback weight server, over the same
  // /api/hf-cache route the LLM tokenizer already uses. `remotePathTemplate` is
  // left at its default because that default — `{model}/resolve/{revision}/` —
  // is already exactly the shape app/steam/local-server.cjs routes (:195).
  env.allowLocalModels = false;   // there is no browser filesystem to fall back to
  env.allowRemoteModels = true;   // "remote" here means 127.0.0.1
  env.remoteHost = `${self.location.origin}/api/hf-cache/`;
  // The "remote" is a local file read. Copying 75 MB into the Cache API to
  // avoid re-reading local disk is pure duplication.
  env.useBrowserCache = false;

  const onProgress = (p: { status?: string; file?: string; loaded?: number; total?: number }) => {
    if (p.status === 'progress' && p.file) {
      post({ type: 'progress', file: p.file, loaded: p.loaded ?? 0, total: p.total ?? 0 });
    }
  };

  const T = transformers as unknown as Record<string, any>;
  const [tokenizer, processor, model] = await Promise.all([
    T.AutoTokenizer.from_pretrained(MODEL_ID, { progress_callback: onProgress }),
    T.AutoProcessor.from_pretrained(MODEL_ID, { progress_callback: onProgress }),
    T.WhisperForConditionalGeneration.from_pretrained(MODEL_ID, {
      // 'q8' → the `_quantized` files fetch-weights.mts vendors. Named rather
      // than defaulted so the vendored set and the requested set cannot drift.
      dtype: 'q8',
      // NO `device` — and that is not an oversight.
      //
      // transformers.js only fills its `supportedDevices` list inside the two
      // branches it takes when it picks the runtime ITSELF (backends/onnx.js:
      // 62-101). The `Symbol.for('onnxruntime')` branch we take leaves the list
      // empty, so naming any device — including the correct one — throws
      // `Unsupported device: "wasm". Should be one of: .` Passing nothing makes
      // it hand ORT no execution-provider preference, and ORT then uses the
      // only provider this build has.
      //
      // Which is the point: "wasm" is not being requested here, it is the only
      // thing that exists. See ort-bootstrap.ts and the vite alias.
      progress_callback: onProgress,
    }),
  ]);

  const id = (tok: string): number => tokenizer.model.convert_tokens_to_ids([tok])[0];
  const loaded: Loaded = {
    tokenizer, processor, model,
    sop: id('<|startofprev|>'), sot: id('<|startoftranscript|>'), nots: id('<|notimestamps|>'),
  };

  post({
    type: 'ready',
    loadMs: Math.round(performance.now() - t0),
    threads: ortInfo.threads,
    crossOriginIsolated: ortInfo.crossOriginIsolated,
  });
  return loaded;
}

/**
 * Whisper's prompt window is half of n_text_ctx — 224 tokens for base.en.
 * Overrunning it does not error, it silently pushes the audio's own context
 * out, so cap here and keep the head (vocabulary.ts orders by importance).
 */
const MAX_PROMPT_TOKENS = 200;

async function transcribe(L: Loaded, audio: Float32Array, prompt: string) {
  const t0 = performance.now();
  const feats = await L.processor(audio);
  const encodeMs = performance.now() - t0;

  // Vocabulary biasing uses Whisper's OWN prompt mechanism rather than anything
  // bolted on: a `<|startofprev|>`-led prefix is what OpenAI's `initial_prompt`
  // compiles down to. transformers.js comments out its `prompt_ids` argument
  // (models.js:3471) but still honours `decoder_input_ids` (:3479), which is
  // the same lever one layer down. The suppress-at-begin processor keys off
  // `init_tokens.length`, so a longer prefix stays correct.
  const opts: Record<string, unknown> = { max_new_tokens: 128 };
  let skip = 0;
  const promptIds: number[] = prompt.trim()
    ? L.tokenizer.encode(prompt, { add_special_tokens: false }).slice(0, MAX_PROMPT_TOKENS)
    : [];
  if (promptIds.length > 0) {
    const prefix = [L.sop, ...promptIds, L.sot, L.nots];
    skip = prefix.length;
    opts.decoder_input_ids = new (transformers as unknown as Record<string, any>).Tensor(
      'int64', BigInt64Array.from(prefix.map((n) => BigInt(n))), [1, prefix.length]);
  }

  const out = await L.model.generate({ ...feats, ...opts });
  const seq: number[] = Array.from(
    (out.tolist ? out.tolist()[0] : out[0]) as Iterable<bigint | number>,
    (v) => Number(v),
  );
  // The prompt prefix is echoed back at the head of the sequence. Decoding it
  // would put the vocabulary list itself into the player's mouth.
  const text: string = L.tokenizer.decode(seq.slice(skip), { skip_special_tokens: true });

  return { text: text.trim(), ms: Math.round(performance.now() - t0), encodeMs: Math.round(encodeMs) };
}

self.onmessage = async (ev: MessageEvent<Req>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'load') {
      ready ??= load();
      await ready;
      return;
    }
    if (msg.type === 'transcribe') {
      ready ??= load();
      const L = await ready;
      const clip = msg.audio.length > MAX_SECONDS * 16000
        ? msg.audio.subarray(0, MAX_SECONDS * 16000)
        : msg.audio;
      const r = await transcribe(L, clip, msg.prompt);
      post({ type: 'result', id: msg.id, text: r.text, ms: r.ms, encodeMs: r.encodeMs });
    }
  } catch (err) {
    // A failed load must not poison the worker forever — the next request
    // retries. (A missing depot file is the realistic cause, and the player
    // pressing the key again is the natural retry.)
    ready = null;
    post({
      type: 'error',
      id: msg.type === 'transcribe' ? msg.id : undefined,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
