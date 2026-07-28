/**
 * GGUF inference session — createInferenceSession's sibling for GGUF models.
 *
 * The safetensors path (inference.ts) can't load GGUF repos, and the chat
 * app's GGUF wiring lives inline in src/main.ts with MoE / PLE / MTP / vision
 * extras. This module is the lean DENSE-ONLY subset (full-attention trunk,
 * k-quant matrices via matmul_gguf, CPU row-gather embed) packaged behind the
 * same InferenceSession interface, for consumers like the DungeonDirector
 * that load a plain Qwen3-style GGUF. Unsupported archs throw at load.
 */

import { initWebGPU, type GPUContext } from './gpu-device';
import { createForwardPassEngine, MAX_ATTN_SEQ_LEN } from './forward-pass';
import {
  generate, createKVSession, type SamplingConfig, type OnTokenCallback,
  type GenerationHandle, type GenerationResult,
} from './generate';
import { loadGGUFModel, type LoadedGGUFModel } from '../model/gguf-loader';
import { unloadModel, type LoadedModel } from '../model/weight-loader';
import { createTokenizer, applyChatTemplate } from '../model/tokenizer';
import { descriptorFromGGUF, applyRopeFreqFactors } from '../model/model-descriptor';
import { ggufArchitecture } from '../model/gguf';
import { createGGUFLocator, type TensorRole } from '../model/tensor-locator';
import { estimateVRAM } from '../model/model-config';
import type { InferenceSession, ForkedChatContext } from './inference';

export interface GGUFSessionConfig {
  /** Repo id served by hf-hub (e.g. 'local/flux2-te-qwen3-4b-q4_k_m'). */
  repo: string;
  /** GGUF filename inside the repo. */
  ggufFile: string;
  /** Existing GPU context to share; a fresh device is requested if omitted. */
  gpu?: GPUContext;
  onStatus?: (message: string) => void;
  /** Fraction of the weight file loaded, 0..1 — for loading UI. */
  onLoadProgress?: (frac: number) => void;
  /** Cooperative pacing for the weight load — see gguf-loader.GGUFLoadPacer.
   *  Only honoured by whichever consumer CREATES the shared session first;
   *  later consumers join the same in-flight promise. */
  loadPacer?: import('../model/gguf-loader').GGUFLoadPacer;
}

/**
 * Shared-session cache: multiple consumers (DungeonDirector, EcologyDirector,
 * NPC chat) load the SAME GGUF repo on the SAME device. Without dedup each one
 * uploads its own ~3 GB copy of the weights plus a full KV cache — enough to
 * exhaust an 8 GB adapter and lose the device. Sessions created with a caller
 * -provided `gpu` are cached by repo+file and refcounted; the underlying model
 * is unloaded only when every handle has been destroyed. Sessions that request
 * their own fresh device stay uncached (standalone/CLI usage).
 */
interface SharedEntry {
  promise: Promise<InferenceSession>;
  device: GPUDevice;
  refs: number;
}
const _sharedSessions = new Map<string, SharedEntry>();

function shareHandle(base: InferenceSession, key: string): InferenceSession {
  let released = false;
  return {
    ...base,
    destroy: () => {
      if (released) return;
      released = true;
      const entry = _sharedSessions.get(key);
      if (entry && --entry.refs <= 0) {
        _sharedSessions.delete(key);
        base.destroy();
      }
    },
  };
}

export function createGGUFInferenceSession(
  cfg: GGUFSessionConfig,
): Promise<InferenceSession> {
  // No shared device → no dedup (fresh device per session, old behavior).
  if (!cfg.gpu) return buildGGUFSession(cfg);

  const key = `${cfg.repo}::${cfg.ggufFile}`;
  const existing = _sharedSessions.get(key);
  if (existing && existing.device === cfg.gpu.device) {
    existing.refs++;
    return existing.promise.then((s) => shareHandle(s, key));
  }

  const promise = buildGGUFSession(cfg);
  const entry: SharedEntry = { promise, device: cfg.gpu.device, refs: 1 };
  _sharedSessions.set(key, entry);
  // A failed load must not poison the cache — allow retry.
  promise.catch(() => {
    if (_sharedSessions.get(key) === entry) _sharedSessions.delete(key);
  });
  return promise.then((s) => shareHandle(s, key));
}

async function buildGGUFSession(
  cfg: GGUFSessionConfig,
): Promise<InferenceSession> {
  const status = cfg.onStatus ?? (() => {});
  const gpu = cfg.gpu ?? await initWebGPU();

  status(`Loading GGUF: ${cfg.repo}/${cfg.ggufFile}`);
  const model = await loadGGUFModel(gpu.device, cfg.repo, cfg.ggufFile,
    (p) => {
      status(p.message);
      if (p.overallProgress !== undefined) cfg.onLoadProgress?.(p.overallProgress);
    },
    cfg.loadPacer !== undefined ? { pacer: cfg.loadPacer } : undefined);

  const config = descriptorFromGGUF(model.file);
  const ropeFreqsT = model.cpuTensors.get('rope_freqs.weight');
  if (ropeFreqsT) {
    applyRopeFreqFactors(config, new Float32Array(
      ropeFreqsT.data.buffer, ropeFreqsT.data.byteOffset, ropeFreqsT.data.byteLength / 4));
  }

  // Dense-only guard: MoE / PLE / hybrid trunks need the chat app's full path.
  if (config.layers.some((d) => d.moe) || config.perLayerEmbed
      || config.layers.some((d) => d.kind === 'linear_attention')) {
    throw new Error(`GGUF session: ${cfg.repo} needs MoE/PLE/hybrid support — dense models only`);
  }

  const loc = createGGUFLocator(model.file.tensors, ggufArchitecture(model.file));
  const requireBuf = (role: TensorRole, l?: number): GPUBuffer => {
    const n = loc.locate(role, l);
    const t = n ? model.tensors.get(n) : undefined;
    if (!t) {
      throw new Error(`GGUF session: missing tensor for role "${role}"${l !== undefined ? ` (layer ${l})` : ''} (name: ${n ?? 'unmapped'})`);
    }
    return t.buffer;
  };
  const roleBuf = (role: TensorRole, l?: number): GPUBuffer | undefined => {
    const n = loc.locate(role, l);
    return n ? model.tensors.get(n)?.buffer : undefined;
  };
  /** Quantized tensor → `{slot}_gg` (matmul_gguf); F32/F16 → plain slot. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const assignProj = (lw: any, slot: string, role: TensorRole, l: number) => {
    const n = loc.locate(role, l);
    const t = n ? model.tensors.get(n) : undefined;
    if (!t) throw new Error(`GGUF session: missing tensor for role "${role}" (layer ${l})`);
    if (t.isQuantized) lw[`${slot}_gg`] = { data: t.buffer, ggmlType: t.ggmlType };
    else lw[slot] = t.buffer;
  };

  // Global weights: CPU row-gather embed; dummy f32 buffers where the real
  // weight rides the embedGG / lmHeadGG quantized path (main.ts pattern).
  const embedCpu = model.cpuTensors.get('token_embd.weight');
  if (!embedCpu) throw new Error('GGUF session: token_embd.weight missing from CPU store');
  const finalNorm = requireBuf('finalNorm');
  const lmHeadName = loc.locate('lmHead')!; // token_embd.weight when tied
  const lmHeadT = model.tensors.get(lmHeadName);
  if (!lmHeadT) throw new Error(`GGUF session: lm_head tensor "${lmHeadName}" not on GPU`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const global: any = {
    embedTokens: finalNorm, // dummy — embedGG path is used
    finalNorm,
    lmHead: lmHeadT.isQuantized ? finalNorm : lmHeadT.buffer,
    embedGG: { data: embedCpu.data, ggmlType: embedCpu.ggmlType, rowBytes: embedCpu.rowBytes },
  };
  if (lmHeadT.isQuantized) {
    global.lmHeadGG = { data: lmHeadT.buffer, ggmlType: lmHeadT.ggmlType };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layers: any[] = [];
  for (let l = 0; l < config.numLayers; l++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lw: any = {
      inputNorm: requireBuf('inputNorm', l),
      postAttnNorm: requireBuf('postAttnNorm', l),
      attnPostNorm: roleBuf('attnPostNorm', l),
      ffnPostNorm: roleBuf('ffnPostNorm', l),
    };
    assignProj(lw, 'qProj', 'qProj', l);
    if (config.layers[l].kvSourceLayer === undefined) {
      assignProj(lw, 'kProj', 'kProj', l);
      assignProj(lw, 'vProj', 'vProj', l);
    }
    assignProj(lw, 'oProj', 'oProj', l);
    lw.qNorm = roleBuf('qNorm', l);
    lw.kNorm = roleBuf('kNorm', l);
    if (config.attentionBias) {
      lw.qBias = roleBuf('qBias', l);
      lw.kBias = roleBuf('kBias', l);
      lw.vBias = roleBuf('vBias', l);
      lw.oBias = roleBuf('oBias', l);
    }
    assignProj(lw, 'gateProj', 'gateProj', l);
    assignProj(lw, 'upProj', 'upProj', l);
    assignProj(lw, 'downProj', 'downProj', l);
    layers.push(lw);
  }

  status('Building inference engine...');
  const engine = createForwardPassEngine(gpu.device, config, { global, layers });
  const tokenizer = await createTokenizer({ modelId: cfg.repo });
  // Wrong-family tokenizer fallback silently produces garbage — hard-fail.
  if (tokenizer.vocabSize && Math.abs(tokenizer.vocabSize - config.vocabSize) > 1024) {
    throw new Error(
      `Tokenizer/model vocab mismatch: tokenizer has ${tokenizer.vocabSize} tokens `
      + `but model expects ${config.vocabSize}`);
  }

  const kvSession = createKVSession(
    Math.min(config.maxPositionEmbeddings || 8192, 8192, MAX_ATTN_SEQ_LEN));
  const resetKV = () => {
    if (kvSession.kvCache) engine.destroyKVCache(kvSession.kvCache);
    kvSession.kvCache = null;
    kvSession.cachedTokenIds = [];
  };

  let m: LoadedGGUFModel | null = model;

  // ── Generation serialization ──────────────────────────────────────────
  // One generation at a time per engine: concurrent generate() calls share
  // the engine's intermediate/logit buffers, so interleaved forward passes
  // read each other's logits — token streams cross-contaminate (observed as
  // garbage/mixed replies when a director gen overlapped NPC chat). Every
  // consumer of this session (default KV and all forks) queues here.
  let genChain: Promise<unknown> = Promise.resolve();
  const chainGen = (start: () => GenerationHandle): GenerationHandle => {
    let inner: GenerationHandle | null = null;
    let abortEarly = false;
    const prior = genChain;
    const result: Promise<GenerationResult> = (async () => {
      await prior.catch(() => { /* a failed prior gen doesn't block us */ });
      if (abortEarly) {
        // Aborted while queued — never touched the GPU.
        return {
          text: '', tokenIds: [], numTokens: 0, promptTokens: 0,
          totalMs: 0, tokensPerSecond: 0, stopReason: 'aborted' as const,
        };
      }
      inner = start();
      return inner.result;
    })();
    genChain = result.catch(() => { /* keep the chain alive on failure */ });
    return {
      result,
      abort: () => { abortEarly = true; inner?.abort(); },
    };
  };

  // Fork: a private KV session over the SAME weights/engine. Dedup'd shared
  // sessions (Director + Ecology + NPC chat) otherwise fight over one KV
  // cache — every consumer switch is a full ~1000-token re-prefill. Forks
  // allocate their GPU cache lazily on first use.
  const forkKV = (): ForkedChatContext => {
    const kv = createKVSession(
      Math.min(config.maxPositionEmbeddings || 8192, 8192, MAX_ATTN_SEQ_LEN));
    return {
      chat: (messages, sampling, onToken, opts) => chainGen(() => {
        const tokenIds = applyChatTemplate(tokenizer, messages, opts);
        return generate(gpu.device, engine, tokenizer, tokenIds, sampling, onToken,
          { kvSession: kv, prefillChunk: opts?.prefillChunk });
      }),
      resetKV: () => {
        if (kv.kvCache) engine.destroyKVCache(kv.kvCache);
        kv.kvCache = null;
        kv.cachedTokenIds = [];
      },
    };
  };

  return {
    run: (prompt: string, sampling?: SamplingConfig, onToken?: OnTokenCallback) =>
      chainGen(() => generate(gpu.device, engine, tokenizer, prompt, sampling, onToken)),
    chat: (messages, sampling, onToken, opts) => chainGen(() => {
      const tokenIds = applyChatTemplate(tokenizer, messages, opts);
      return generate(gpu.device, engine, tokenizer, tokenIds, sampling, onToken,
        { kvSession, prefillChunk: opts?.prefillChunk });
    }),
    forkKV,
    kvSession,
    resetKV,
    config,
    tokenizer,
    gpu,
    vramEstimate: estimateVRAM(config),
    destroy: () => {
      resetKV();
      if (m) unloadModel(m as unknown as LoadedModel);
      m = null;
    },
  };
}
