/**
 * LAZY SONG DECODING.
 *
 * Decoding a 220-second 320 kbps mp3 is tens of milliseconds of main-thread
 * work and ~38 MB of resident float samples. Doing that for four tracks at boot
 * would be a stall the player feels and memory nobody is using yet, so nothing
 * is fetched until the engine knows it is about to want it:
 *
 *   - the overworld rotation requests its next segment's file when the
 *     interlude is first SCHEDULED, which is minutes before it plays;
 *   - the dungeon and castle tracks are requested on first entry to the region.
 *
 * THE HARD RULE, inherited from the LLM work: this never blocks. `request()`
 * returns immediately, `get()` returns null until the buffer is ready, and the
 * interlude simply does not start a song it does not have — the procedural bed
 * keeps playing and the next cadence tick tries again. A failed decode is
 * recorded, reported through the snapshot, and never retried in a loop. There
 * is no code path in which music stops because a file was slow or missing.
 *
 * Decoding itself is `BaseAudioContext.decodeAudioData`, which Chrome
 * implements natively for mp3 and wav. It is CPU-side and asynchronous; it
 * never touches the WebGPU queue.
 */

import { MUSIC_BASE, SONGS, type SongId } from './songs';

export type LoadState = 'idle' | 'loading' | 'ready' | 'failed';

export interface SongLibraryOptions {
  /**
   * Fetch raw bytes for a URL. Injectable so headless renders and tests can
   * read from disk — the engine never learns which it got.
   */
  fetchBytes?: (url: string) => Promise<ArrayBuffer>;
  /**
   * Turn bytes into an AudioBuffer. Defaults to ctx.decodeAudioData. The Node
   * shim has no mp3 decoder, so the render harness injects one.
   */
  decode?: (bytes: ArrayBuffer) => Promise<AudioBuffer>;
  /** Called on failure. Defaults to a console warning. */
  onError?: (songId: SongId, err: unknown) => void;
}

const defaultFetch = async (url: string): Promise<ArrayBuffer> => {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText} for ${url}`);
  return resp.arrayBuffer();
};

export class SongLibrary {
  private readonly buffers = new Map<SongId, AudioBuffer>();
  private readonly states = new Map<SongId, LoadState>();
  private readonly errors = new Map<SongId, string>();

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly opts: SongLibraryOptions = {},
  ) {}

  state(id: SongId): LoadState {
    return this.states.get(id) ?? 'idle';
  }

  /** The decoded buffer, or null if it is not ready (for any reason). */
  get(id: SongId): AudioBuffer | null {
    return this.buffers.get(id) ?? null;
  }

  error(id: SongId): string | undefined {
    return this.errors.get(id);
  }

  /** Every track's state, for the debug HUD and the tests. */
  snapshot(): Record<string, LoadState> {
    const out: Record<string, LoadState> = {};
    for (const id of Object.keys(SONGS) as SongId[]) out[id] = this.state(id);
    return out;
  }

  /**
   * Ask for a track. Idempotent, non-blocking, and safe to call every frame.
   * A track that has already failed is not retried — the bed covers for it.
   */
  request(id: SongId): void {
    const st = this.state(id);
    if (st !== 'idle') return;
    this.states.set(id, 'loading');
    void this.load(id);
  }

  /** Pre-seed a buffer directly. Used by the render harness and the tests. */
  provide(id: SongId, buffer: AudioBuffer): void {
    this.buffers.set(id, buffer);
    this.states.set(id, 'ready');
  }

  private async load(id: SongId): Promise<void> {
    const track = SONGS[id];
    const url = `${MUSIC_BASE}${track.file}`;
    try {
      const bytes = await (this.opts.fetchBytes ?? defaultFetch)(url);
      const buf = this.opts.decode
        ? await this.opts.decode(bytes)
        : await this.ctx.decodeAudioData(bytes);
      this.buffers.set(id, buf);
      this.states.set(id, 'ready');
    } catch (err) {
      this.states.set(id, 'failed');
      this.errors.set(id, err instanceof Error ? err.message : String(err));
      if (this.opts.onError) this.opts.onError(id, err);
      else console.warn(`[music] could not load ${track.file}: ${String(err)}`);
    }
  }
}
