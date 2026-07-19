/**
 * EcologyDirector — LLM-driven EcologySpec generation for entity cells.
 *
 * Mirrors the DungeonDirector pattern:
 *  - specFor(ecx, ecz, biomes) returns an EcologySpec synchronously
 *    (cached or ECOLOGY_FALLBACK) and enqueues async generation when needed.
 *  - Persists accepted specs under 'artifex-ecology:v1' keyed by
 *    (seed, ecx, ecz).
 *  - One job at a time; chat errors disable the director for the session.
 *  - ?director=off → disabled entirely; ECOLOGY_FALLBACK used everywhere.
 *
 * E2E seam: window.__ECOLOGY_MOCK__ replaces the model call.
 */

import { type EcologySpec, ECOLOGY_FALLBACK, ECOLOGY_KEY, validateEcologySpec } from './ecology-spec';
import {
  buildEcologyBrief, buildEcologyMessages, buildEcologyRetryMessage,
  extractSpecJson,
} from './ecology-prompt';
import { mix32 } from '../dungeon/dungeon-layout';
import type { Biome } from '../biome';

export type EcologyChatFn = (messages: { role: string; content: string }[]) => Promise<string>;

const MAX_RETRIES = 1;

declare global {
  interface Window {
    __ECOLOGY_MOCK__?: (messages: { role: string; content: string }[]) => string | Promise<string>;
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface StoredEcology {
  spec: EcologySpec;
  source: 'llm' | 'fallback';
  savedAt: number;
}

function ecologyStoreKey(seed: number, ecx: number, ecz: number): string {
  return `${ECOLOGY_KEY}:${seed >>> 0}:${ecx},${ecz}`;
}

function loadEcologySpec(seed: number, ecx: number, ecz: number): EcologySpec | null {
  try {
    const raw = localStorage.getItem(ecologyStoreKey(seed, ecx, ecz));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<StoredEcology>;
    if (!parsed.spec) return null;
    const result = validateEcologySpec(parsed.spec, []); // biomes not re-checked on load
    if ('errors' in result) return null;
    return result.spec;
  } catch {
    return null;
  }
}

function saveEcologySpec(
  seed: number, ecx: number, ecz: number,
  spec: EcologySpec, source: 'llm' | 'fallback',
): void {
  try {
    const entry: StoredEcology = { spec, source, savedAt: Date.now() };
    localStorage.setItem(ecologyStoreKey(seed, ecx, ecz), JSON.stringify(entry));
  } catch { /* quota */ }
}

// ---------------------------------------------------------------------------
// EcologyDirector
// ---------------------------------------------------------------------------

export interface EcologyDirectorOptions {
  seed: number;
  disabled?: boolean;
  chatFn?: EcologyChatFn;
  gpu?: import('../../engine/gpu-device').GPUContext;
}

export class EcologyDirector {
  private readonly seed: number;
  private readonly disabled: boolean;
  private chatFn: EcologyChatFn | null;
  private readonly gpu: import('../../engine/gpu-device').GPUContext | undefined;

  private readonly queued = new Set<string>();
  private readonly queue: { ecx: number; ecz: number; biomes: Biome[] }[] = [];
  private busy = false;
  private failed = false;

  constructor(opts: EcologyDirectorOptions) {
    this.seed = opts.seed;
    this.disabled = opts.disabled ?? false;
    this.chatFn = opts.chatFn ?? null;
    this.gpu = opts.gpu;
  }

  /**
   * Return an EcologySpec for this cell synchronously.
   * If LLM is disabled or a cached spec exists, return it immediately.
   * Otherwise return ECOLOGY_FALLBACK and enqueue async generation.
   */
  specFor(ecx: number, ecz: number, biomes: Biome[]): EcologySpec {
    if (this.disabled) {
      return ECOLOGY_FALLBACK(biomes);
    }

    const cached = loadEcologySpec(this.seed, ecx, ecz);
    if (cached !== null) return cached;

    // Enqueue and return fallback for now.
    this.enqueue(ecx, ecz, biomes);
    return ECOLOGY_FALLBACK(biomes);
  }

  destroy(): void {
    this.queue.length = 0;
    this.queued.clear();
    this.chatFn = null;
  }

  // -------------------------------------------------------------------------
  // Internal pipeline
  // -------------------------------------------------------------------------

  private enqueue(ecx: number, ecz: number, biomes: Biome[]): void {
    if (this.failed) return;
    const key = `${ecx},${ecz}`;
    if (this.queued.has(key)) return;
    this.queued.add(key);
    this.queue.push({ ecx, ecz, biomes });
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.busy || this.failed) return;
    const cell = this.queue.shift();
    if (cell === undefined) return;
    this.busy = true;
    try {
      const chat = await this.ensureChat();
      const brief = buildEcologyBrief(this.seed, cell.ecx, cell.ecz, cell.biomes);
      const messages = buildEcologyMessages(brief);

      let spec: EcologySpec | null = null;
      let lastErrors: string[] = [];

      for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
        let text: string;
        try {
          text = await chat(messages);
        } catch (err) {
          lastErrors = [`chat failed: ${err}`];
          throw err; // surface to outer catch → failed=true
        }

        const extracted = extractSpecJson(text);
        if (!extracted.ok) {
          lastErrors = [extracted.error];
          if (attempt <= MAX_RETRIES) {
            messages.push({ role: 'assistant', content: text });
            messages.push({ role: 'user', content: buildEcologyRetryMessage(lastErrors) });
          }
          continue;
        }

        const result = validateEcologySpec(extracted.value, cell.biomes);
        if ('errors' in result) {
          lastErrors = result.errors;
          if (attempt <= MAX_RETRIES) {
            messages.push({ role: 'assistant', content: text });
            messages.push({ role: 'user', content: buildEcologyRetryMessage(lastErrors) });
          }
          continue;
        }

        spec = result.spec;
        break;
      }

      if (spec === null) {
        console.warn('[EcologyDirector] fell back:', lastErrors);
        spec = ECOLOGY_FALLBACK(cell.biomes);
        saveEcologySpec(this.seed, cell.ecx, cell.ecz, spec, 'fallback');
      } else {
        saveEcologySpec(this.seed, cell.ecx, cell.ecz, spec, 'llm');
      }
    } catch (err) {
      console.error('[EcologyDirector] disabled:', err);
      this.failed = true;
      this.queue.length = 0;
      this.queued.clear();
    } finally {
      this.queued.delete(`${cell.ecx},${cell.ecz}`);
      this.busy = false;
      if (!this.failed && this.queue.length > 0) void this.pump();
    }
  }

  private async ensureChat(): Promise<EcologyChatFn> {
    if (this.chatFn !== null) return this.chatFn;

    const mock = typeof window !== 'undefined' ? window.__ECOLOGY_MOCK__ : undefined;
    if (typeof mock === 'function') {
      this.chatFn = async (messages) => String(await mock(messages));
      return this.chatFn;
    }

    // Share the same model as the Director (Qwen3-4B).
    if (this.gpu === undefined) {
      throw new Error('no GPU context for ecology LLM');
    }
    const { createGGUFInferenceSession } = await import('../../engine/gguf-session');
    const { useLocalCache } = await import('../../model/hf-hub');
    useLocalCache();
    const session = await createGGUFInferenceSession({
      repo: 'local/flux2-te-qwen3-4b-q4_k_m',
      ggufFile: 'flux2-te-qwen3-4b-q4_k_m.gguf',
      gpu: this.gpu,
      onStatus: () => { /* silent */ },
    });
    this.chatFn = async (messages) => {
      const g = globalThis as Record<string, unknown>;
      const prev = g.__DEBUG_PREFILL_CHUNK__;
      g.__DEBUG_PREFILL_CHUNK__ = 128;
      try {
        const handle = session.chat(
          messages, { temperature: 0, maxNewTokens: 200 }, undefined,
          { enableThinking: false, emptyThink: true });
        const r = await handle.result;
        return r.text;
      } finally {
        g.__DEBUG_PREFILL_CHUNK__ = prev;
      }
    };
    return this.chatFn;
  }
}
