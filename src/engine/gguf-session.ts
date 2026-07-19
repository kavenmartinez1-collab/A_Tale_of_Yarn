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
import { generate, createKVSession, type SamplingConfig, type OnTokenCallback } from './generate';
import { loadGGUFModel, type LoadedGGUFModel } from '../model/gguf-loader';
import { unloadModel, type LoadedModel } from '../model/weight-loader';
import { createTokenizer, applyChatTemplate } from '../model/tokenizer';
import { descriptorFromGGUF, applyRopeFreqFactors } from '../model/model-descriptor';
import { ggufArchitecture } from '../model/gguf';
import { createGGUFLocator, type TensorRole } from '../model/tensor-locator';
import { estimateVRAM } from '../model/model-config';
import type { InferenceSession } from './inference';

export interface GGUFSessionConfig {
  /** Repo id served by hf-hub (e.g. 'local/flux2-te-qwen3-4b-q4_k_m'). */
  repo: string;
  /** GGUF filename inside the repo. */
  ggufFile: string;
  /** Existing GPU context to share; a fresh device is requested if omitted. */
  gpu?: GPUContext;
  onStatus?: (message: string) => void;
}

export async function createGGUFInferenceSession(
  cfg: GGUFSessionConfig,
): Promise<InferenceSession> {
  const status = cfg.onStatus ?? (() => {});
  const gpu = cfg.gpu ?? await initWebGPU();

  status(`Loading GGUF: ${cfg.repo}/${cfg.ggufFile}`);
  const model = await loadGGUFModel(gpu.device, cfg.repo, cfg.ggufFile,
    (p) => status(p.message));

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
  return {
    run: (prompt: string, sampling?: SamplingConfig, onToken?: OnTokenCallback) =>
      generate(gpu.device, engine, tokenizer, prompt, sampling, onToken),
    chat: (messages, sampling, onToken, opts) => {
      const tokenIds = applyChatTemplate(tokenizer, messages, opts);
      return generate(gpu.device, engine, tokenizer, tokenIds, sampling, onToken, { kvSession });
    },
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
