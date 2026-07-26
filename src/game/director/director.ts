/**
 * DungeonDirector — the browser-side orchestrator that lets the in-browser
 * LLM author dungeon specs, upholding two hard rules:
 *
 *  - Determinism: LLM output is nondeterministic, so every resolved spec
 *    (LLM or fallback) is persisted per (seed, dcx, dcz) before it is ever
 *    used. Re-entry and reloads reproduce the same dungeon.
 *  - The game never breaks without the model: any load/generation failure
 *    degrades to the deterministic fixtures and NEVER touches __gameError.
 *
 * One generation job runs at a time (single KV session, bounded GPU
 * contention). The inference engine is dynamically imported on the first
 * job so game.html pays nothing while the Director is idle, and the game's
 * GPUContext is injected — never a second device.
 *
 * E2E seam: window.__DIRECTOR_MOCK__ (messages → string | Promise<string>)
 * replaces the model entirely; no engine import, no session.
 */

import type { GPUContext } from '../../engine/gpu-device';
import type { InferenceSession } from '../../engine/inference';
import { DUNGEON_FIXTURES } from '../dungeon/dungeon-fixtures';
import { mix32 } from '../dungeon/dungeon-layout';
import type { DungeonSpec } from '../dungeon/dungeon-spec';
import type { SpecProvider } from '../dungeon/dungeon-manager';
import { buildBrief, type ChatMessage } from './director-prompt';
import {
  generateSpecWithRetries, DIRECTOR_SAMPLING, type DirectorChatFn,
} from './director-llm';
import { createSpecStore, type SpecStore } from './director-store';

/**
 * The Director runs the SAME stock Qwen3-1.7B as the NPCs (NPC_MODELS.fast).
 *
 * Was `local/flux2-te-qwen3-4b-q4_k_m` — an unlabelled 2.5 GB checkpoint whose
 * GGUF header carries 29 keys and not one licence or base-model field
 * (`general.name = "Te Gguf Staging"`). It was traced to FLUX.2-klein-4B's text
 * encoder, which is Apache-2.0, but its sibling repos are non-commercial and
 * gated, and nothing in the artefact says which one it came from. That is not a
 * provenance chain, and "probably Apache-2.0 based on matching hyperparameters"
 * is not a position to ship from. See docs/AI_MODEL_LICENSING.md §4.2.
 *
 * `unsloth/Qwen3-1.7B-GGUF` is checkable end to end: the repo declares
 * apache-2.0 with a license_link and `base_model: Qwen/Qwen3-1.7B`, it is
 * ungated, and the GGUF self-identifies (`general.name = Qwen3-1.7B`,
 * `general.quantized_by = Unsloth`). sha256 of the shipped artefact is pinned
 * in THIRD_PARTY_NOTICES.md.
 *
 * Sharing one model with NPC chat is not just a licensing tidy-up: the GGUF
 * session dedups on `repo::file`, so the Director and the chat panel now hold
 * ONE set of weights (~1.1 GB) instead of 1.1 + 2.5 GB, and a player who talks
 * to an NPC pays no second cold-start. Each consumer still gets its own KV
 * fork, so their caches never contend.
 *
 * The flux2 checkpoint stays on disk — src/diffusion/flux2-image.ts still uses
 * it as an image text encoder, which is what it actually is.
 */
export const DIRECTOR_MODEL_ID = 'unsloth/Qwen3-1.7B-GGUF';
export const DIRECTOR_GGUF_FILE = 'Qwen3-1.7B-Q4_K_M.gguf';

/** Thrown when a generation is cut short because the Director was paused. */
class PauseAbort extends Error {
  constructor() { super('director generation aborted by pause'); }
}

/** Smaller prefill submissions while the game renders (existing engine hook;
 *  default 512 stalls the frame for the whole prompt). 64 keeps each GPU
 *  submit short enough that frames stay interactive during background gen. */
const DIRECTOR_PREFILL_CHUNK = 64;

/** Breathing gap between background generation jobs — gives the renderer
 *  exclusive GPU time so the game stays smooth (fixtures cover the wait). */
const GEN_COOLDOWN_MS = 5000;

const DCELL = 512; // keep in sync with dungeon-manager.ts

export type DirectorStatus = 'idle' | 'loading-model' | 'dreaming' | 'error';

export interface DirectorOptions {
  seed: number;
  /** The game's GPU context — shared device, never request a second one. */
  gpu: GPUContext;
  heightAt: (x: number, z: number) => number;
  store?: SpecStore;
  modelId?: string;
  /** Test seam; overrides both the model and __DIRECTOR_MOCK__. */
  chatFn?: DirectorChatFn;
}

declare global {
  interface Window {
    __DIRECTOR_MOCK__?: (messages: ChatMessage[]) => string | Promise<string>;
  }
}

export class DungeonDirector implements SpecProvider {
  private readonly seed: number;
  private readonly gpu: GPUContext;
  private readonly heightAt: (x: number, z: number) => number;
  private readonly store: SpecStore;
  private readonly modelId: string;

  private chat: DirectorChatFn | null;
  private session: InferenceSession | null = null;
  private readonly queue: { dcx: number; dcz: number }[] = [];
  private readonly queued = new Set<string>();
  private busy = false;
  private failed = false;
  private paused = false;
  private cooldownUntil = 0;
  private loading = false;
  /** Handle for the generation currently on the GPU, so a pause can abort it. */
  private inflight: { abort(): void } | null = null;
  /** Set when setPaused(true) aborted a job — that job is re-queued, not failed. */
  private abortedByPause = false;
  private loadNote = '';
  private dreamingName: string | null = null;
  private _generation = 0;

  constructor(opts: DirectorOptions) {
    this.seed = opts.seed;
    this.gpu = opts.gpu;
    this.heightAt = opts.heightAt;
    this.store = opts.store ?? createSpecStore();
    this.modelId = opts.modelId ?? DIRECTOR_MODEL_ID;
    this.chat = opts.chatFn ?? null;
  }

  // --- SpecProvider (sync seam consumed by DungeonManager) -----------------

  specFor(dcx: number, dcz: number): DungeonSpec {
    const stored = this.store.load(this.seed, dcx, dcz);
    if (stored !== null) return stored.spec;
    this.enqueue(dcx, dcz);
    return this.fixtureFor(dcx, dcz);
  }

  /** True when entering is final: persisted spec, or the Director is out. */
  isReady(dcx: number, dcz: number): boolean {
    if (this.failed) return true;
    return this.store.load(this.seed, dcx, dcz) !== null;
  }

  /**
   * Pause/resume background generation. While paused, doors still get
   * deterministic fixtures instantly and jobs stay queued; generation resumes
   * on unpause. Used to give NPC chat exclusive GPU time.
   *
   * Pausing ABORTS the generation already in flight — it does not merely stop
   * the next one from starting. That distinction became load-bearing when the
   * Director moved onto the same GGUF session as NPC chat: one session means
   * one engine and one `chainGen`, so a Director job that is mid-generation
   * blocks the player's chat turn completely rather than just competing with it
   * for the GPU. Measured before this abort existed: the first chat turn sat
   * behind a 38 s Director prefill, blew the 20 s TTFT watchdog, and the player
   * got a canned line while the model sat there working on a dungeon.
   *
   * Cheap to do: an aborted cell is re-queued and regenerated on unpause, and
   * every door has a deterministic fixture in the meantime.
   */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      this.abortedByPause = this.inflight !== null;
      this.inflight?.abort();
    } else if (this.queue.length > 0) void this.pump();
  }

  /** Player is waiting at this door — move its job to the queue front. */
  prioritize(dcx: number, dcz: number): void {
    const key = `${dcx},${dcz}`;
    const i = this.queue.findIndex((c) => `${c.dcx},${c.dcz}` === key);
    if (i > 0) this.queue.unshift(...this.queue.splice(i, 1));
    this.enqueue(dcx, dcz);
  }

  /** The player is entering this cell NOW — freeze whatever spec resolves.
   *  (Reached without a store hit only via debug enter or Director error.) */
  onMaterialize(dcx: number, dcz: number): void {
    const key = `${dcx},${dcz}`;
    const i = this.queue.findIndex((c) => `${c.dcx},${c.dcz}` === key);
    if (i >= 0) {
      this.queue.splice(i, 1);
      this.queued.delete(key);
    }
    if (this.store.load(this.seed, dcx, dcz) === null) {
      this.store.save(this.seed, dcx, dcz, {
        spec: this.fixtureFor(dcx, dcz),
        source: 'fallback',
        savedAt: Date.now(),
      });
    }
  }

  /** Bumps whenever a spec resolves — DungeonManager refreshes names. */
  get generation(): number {
    return this._generation;
  }

  // --- status --------------------------------------------------------------

  get status(): DirectorStatus {
    if (this.failed) return 'error';
    if (this.loading) return 'loading-model';
    if (this.busy || this.queue.length > 0) return 'dreaming';
    return 'idle';
  }

  get statusText(): string {
    switch (this.status) {
      case 'loading-model': return `waking up… ${this.loadNote}`;
      case 'dreaming': return `dreaming${this.dreamingName ? ` of ${this.dreamingName}` : ''}…`;
      case 'error': return 'silent (fixtures only)';
      default: return 'idle';
    }
  }

  destroy(): void {
    this.queue.length = 0;
    this.queued.clear();
    this.session?.destroy();
    this.session = null;
    this.chat = null;
  }

  // --- generation pipeline -------------------------------------------------

  private fixtureFor(dcx: number, dcz: number): DungeonSpec {
    return DUNGEON_FIXTURES[mix32(this.seed, dcx, dcz) % DUNGEON_FIXTURES.length];
  }

  private enqueue(dcx: number, dcz: number): void {
    if (this.failed) return;
    const key = `${dcx},${dcz}`;
    if (this.queued.has(key)) return;
    this.queued.add(key);
    this.queue.push({ dcx, dcz });
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.busy || this.failed || this.paused) return;
    // Cooldown between jobs: give the renderer exclusive GPU time.
    const wait = this.cooldownUntil - Date.now();
    if (wait > 0) {
      setTimeout(() => void this.pump(), wait + 50);
      return;
    }
    const cell = this.queue.shift();
    if (cell === undefined) return;
    this.busy = true;
    try {
      const chat = await this.ensureChat();
      const brief = buildBrief(
        this.seed, cell.dcx, cell.dcz,
        this.heightAt((cell.dcx + 0.5) * DCELL, (cell.dcz + 0.5) * DCELL));
      this.dreamingName = this.fixtureFor(cell.dcx, cell.dcz).name;
      const result = await generateSpecWithRetries(chat, brief);
      if (result.chatError) {
        // Model unavailable — do NOT persist fallback for unvisited cells;
        // route to the disable path below.
        throw new Error(result.errors?.[0] ?? 'chat failed');
      }
      // The cell may have been materialized (frozen) while we generated.
      if (this.store.load(this.seed, cell.dcx, cell.dcz) === null) {
        this.store.save(this.seed, cell.dcx, cell.dcz, {
          spec: result.spec,
          source: result.source,
          savedAt: Date.now(),
        });
        this._generation++;
      }
      if (result.source === 'fallback') {
        console.warn(`[Director] cell ${cell.dcx},${cell.dcz} fell back:`, result.errors);
      }
    } catch (err) {
      if (err instanceof PauseAbort) {
        // Yielded the GPU to NPC chat mid-job. Put the cell back and pick it up
        // on unpause; the door is showing a deterministic fixture meanwhile.
        this.queue.unshift(cell);
        this.abortedByPause = false;
        return;
      }
      // Model load/GPU failure — degrade to fixtures for the whole session.
      console.error('[Director] disabled:', err);
      this.failed = true;
      this.queue.length = 0;
      this.queued.clear();
    } finally {
      // A re-queued cell must stay in `queued` or enqueue() would re-add it.
      const stillQueued = this.queue.some(
        (c) => c.dcx === cell.dcx && c.dcz === cell.dcz);
      if (!stillQueued) this.queued.delete(`${cell.dcx},${cell.dcz}`);
      this.dreamingName = null;
      this.busy = false;
      this.cooldownUntil = Date.now() + GEN_COOLDOWN_MS;
      if (!this.failed && !this.paused && this.queue.length > 0) void this.pump();
    }
  }

  private async ensureChat(): Promise<DirectorChatFn> {
    if (this.chat !== null) return this.chat;

    const mock = typeof window !== 'undefined' ? window.__DIRECTOR_MOCK__ : undefined;
    if (typeof mock === 'function') {
      this.chat = async (messages) => ({
        text: String(await mock(messages)),
        stopReason: 'eos',
      });
      return this.chat;
    }

    this.loading = true;
    try {
      // Dynamic import: game.html pays for the engine only on first use.
      const { createGGUFInferenceSession } = await import('../../engine/gguf-session');
      // Route hf-hub through the dev server unconditionally. It is local-first
      // with a CDN fallback on 404, so this is strictly better for every repo
      // shape: local/ and ollama/ aliases exist ONLY here, and a cached HF repo
      // loads from disk instead of re-downloading a gigabyte. Previously this
      // was gated on the local/ prefix, which meant the winner depended on load
      // order — NPC chat calls useLocalCache() unconditionally, so whichever
      // consumer loaded first decided whether the other hit the network.
      (await import('../../model/hf-hub')).useLocalCache();
      const session = await createGGUFInferenceSession({
        repo: this.modelId,
        ggufFile: DIRECTOR_GGUF_FILE,
        gpu: this.gpu,
        onStatus: (msg) => { this.loadNote = msg; },
      });
      this.session = session;
      // Private KV fork: the shared session's default KV is contended by the
      // EcologyDirector — concurrent gens reset each other's cache and destroy
      // buffers the other's in-flight submits still reference (GPU errors,
      // garbage output). A fork isolates this consumer completely.
      const ctx = session.forkKV !== undefined ? session.forkKV() : session;
      this.chat = async (messages) => {
        const handle = ctx.chat(
          messages, DIRECTOR_SAMPLING, undefined,
          // emptyThink: Qwen3 opens <think> on its own and burns the whole
          // token budget unless the empty think block is pre-filled.
          // prefillChunk: small chunks keep frame hitches short for this
          // background consumer WITHOUT leaking into concurrent NPC chat
          // prefill (the old global override was racy across awaits).
          { enableThinking: false, emptyThink: true, prefillChunk: DIRECTOR_PREFILL_CHUNK });
        this.inflight = handle;
        try {
          const r = await handle.result;
          // A pause-abort is not a model failure. Surfacing it as one would
          // send pump() down the disable path and leave the whole session on
          // fixtures — i.e. opening a chat panel once would kill the Director.
          if (r.stopReason === 'aborted' && this.abortedByPause) throw new PauseAbort();
          return { text: r.text, stopReason: r.stopReason };
        } finally {
          this.inflight = null;
        }
      };
      return this.chat;
    } finally {
      this.loading = false;
    }
  }
}
