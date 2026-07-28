/**
 * A Tale of Yarn — procedural music engine.
 *
 * Composition in code. One motif (motif.ts), transformed everywhere. Vertical
 * layering driven by game state, crossfaded on bar boundaries. Fully
 * deterministic: same seed + same state history => the same music, sample for
 * sample. No AI service, no sample library, no licence surface — see
 * MUSIC_HOOK.md.
 *
 * Runs entirely on WebAudio (CPU). It never touches the WebGPU queue.
 *
 *   const music = createMusic(audioCtx, WORLD_SEED);
 *   music.update({ region, intensity, tod, weather, paused }, now / 1000);
 *
 * Node-safe: importing this module does not touch AudioContext. `createMusic`
 * is given a context, so headless renders pass an OfflineAudioContext (or the
 * shim in offline-context.ts) and get identical behaviour.
 */

import { MusicBus } from './bus';
import { SongLibrary, type LoadState, type SongLibraryOptions } from './decode';
import {
  InterludeController,
  type InterludeEvent,
  type InterludeOptions,
  type InterludeStage,
} from './interlude';
import { MusicScheduler, type SchedulerStats } from './scheduler';
import { arrangeBar, type BarNotes } from './arranger';
import { LAYERS, planBar, type BarPlan, type LayerId, type MusicState } from './state';
import type { SegmentId } from './songs';

export { MOTIF, MOTIF_HEAD_INTERVALS, MOTIF_INTERVALS, countMotifStatements } from './motif';
export { LAYER_MATRIX, LAYERS, REGION_CONFIG, REGIONS, INTENSITIES, planBar } from './state';
export type { BarPlan, BedOverride, Intensity, LayerId, MusicState, Region } from './state';
export type { NoteEvent, BarNotes } from './arranger';
export { arrangeBar } from './arranger';
export { MAX_VOICES } from './layer';
export { DUCK_FLOOR, PAUSE_LEVEL, SONG_DUCK_FLOOR } from './bus';
export { LOOKAHEAD, MIN_FADE, DESIRED_FADE, PLAN_AHEAD, RESYNC_AFTER } from './scheduler';
export {
  MUSIC_BASE,
  OVERWORLD_ROTATION,
  REGION_SEGMENT,
  SEGMENTS,
  SONGS,
  INTERLUDE_REGIONS,
  nearestMidiForPc,
} from './songs';
export type { SegmentId, SongId, SongSegment, SongTrack } from './songs';
export {
  INTERLUDE_INTERVAL,
  INTERLUDE_JITTER,
  PAD_OVERLAP,
  PAD_FADE,
  SONG_FADE_IN,
  EXIT_LEAD,
} from './interlude';
export type {
  InterludeEvent,
  InterludeEventKind,
  InterludeOptions,
  InterludeStage,
} from './interlude';
export { InterludeController } from './interlude';
export { SongLibrary } from './decode';
export type { LoadState, SongLibraryOptions } from './decode';
export { SongPlayer } from './song-player';

export interface MusicOptions {
  /** Where the bus lands. Defaults to ctx.destination. */
  destination?: AudioNode;
  /** Initial volume, 0..1. */
  volume?: number;
  /**
   * How the developer's recordings are fetched and decoded. Defaults to
   * `fetch` + `ctx.decodeAudioData`, which is what the game uses. The render
   * harness and the tests inject their own so they can run headless.
   */
  songs?: SongLibraryOptions;
  /** Skip the song system entirely (used by the pure-synth regression tests). */
  disableSongs?: boolean;
  /** Harness-only injection points for the interlude. The game sets none. */
  interlude?: InterludeOptions;
}

/** Snapshot for tests and for the debug overlay. */
export interface MusicSnapshot extends SchedulerStats {
  layerGain: Record<LayerId, number>;
  layerTarget: Record<LayerId, number>;
  fadeEnd: Record<LayerId, number>;
  volume: number;
  duck: number;
  paused: boolean;
  /** Song system. */
  songGain: number;
  songDuck: number;
  stage: InterludeStage;
  segment: SegmentId | null;
  interludeClock: number;
  nextInterludeAt: number;
  songLoads: Record<string, LoadState>;
  events: readonly InterludeEvent[];
  loopSeams: number;
}

export interface MusicEngine {
  /** Call once per frame. `nowS` is AudioContext-domain seconds. */
  update(state: MusicState, nowS: number): void;
  /** The Settings panel's "music" bus, 0..1. Governs songs and synth alike. */
  setVolume(v: number): void;
  /** NPC speech ducking. 0 = unducked, 1 = fully ducked. Songs duck too. */
  duck(amount: number): void;
  /** Exportable state for tests / debug HUD. */
  snapshot(nowS: number): MusicSnapshot;
  readonly bus: MusicBus;
  readonly seed: number;
  /** The decoded-song cache, so a harness can pre-seed or inspect it. */
  readonly songs: SongLibrary;
  readonly interlude: InterludeController | null;
}

export function createMusic(
  ctx: BaseAudioContext,
  seed: number,
  opts: MusicOptions = {},
): MusicEngine {
  const bus = new MusicBus(ctx, opts.destination ?? ctx.destination);
  if (opts.volume !== undefined) bus.setVolume(opts.volume);
  const sched = new MusicScheduler(ctx, seed >>> 0, bus);
  const library = new SongLibrary(ctx, opts.songs);
  const interlude = opts.disableSongs
    ? null
    : new InterludeController(ctx, seed >>> 0, sched, bus, library, opts.interlude);

  return {
    update(state, nowS) {
      // The bar grid first: the interlude places its stages on bar indices and
      // needs this frame's grid, not last frame's.
      sched.update(state, nowS);
      interlude?.update(state, nowS);
    },
    setVolume(v) {
      bus.setVolume(v);
    },
    duck(amount) {
      bus.duck(amount);
    },
    snapshot(nowS) {
      const layerGain = {} as Record<LayerId, number>;
      const layerTarget = {} as Record<LayerId, number>;
      const fadeEnd = {} as Record<LayerId, number>;
      for (const id of LAYERS) {
        layerGain[id] = bus.gainAt(id, nowS);
        layerTarget[id] = bus.fadeTarget(id);
        fadeEnd[id] = bus.fadeEnd(id);
      }
      return {
        ...sched.stats,
        layerGain,
        layerTarget,
        fadeEnd,
        volume: bus.volume,
        duck: bus.duckAmount,
        paused: bus.paused,
        songGain: bus.songGainAt(nowS),
        songDuck: bus.songDuckAmount,
        stage: interlude?.stage ?? 'bed',
        segment: interlude?.currentSegment ?? null,
        interludeClock: interlude?.clockS ?? 0,
        nextInterludeAt: interlude?.nextAt ?? Infinity,
        songLoads: library.snapshot(),
        events: interlude?.events ?? [],
        loopSeams: interlude?.seams ?? 0,
      };
    },
    bus,
    seed: seed >>> 0,
    songs: library,
    interlude,
  };
}

// ---------------------------------------------------------------------------
// Offline arrangement — no audio. Shared by the MIDI exporter and the tests,
// so both analyse exactly the notes the synth would have played.
// ---------------------------------------------------------------------------

export interface ArrangedBar {
  plan: BarPlan;
  notes: BarNotes;
}

/** Arrange `bars` consecutive bars of a fixed state. Pure. */
export function arrangeSequence(seed: number, state: MusicState, bars: number): ArrangedBar[] {
  const out: ArrangedBar[] = [];
  for (let b = 0; b < bars; b++) {
    const plan = planBar(b, state);
    out.push({ plan, notes: arrangeBar(seed >>> 0, plan) });
  }
  return out;
}

/** Flatten one layer of an arrangement into a single note stream. */
export function layerStream(seq: readonly ArrangedBar[], layer: LayerId) {
  return seq.flatMap((b) => b.notes[layer]);
}

/** How many bars fit in `seconds` at this state's tempo. */
export function barsForSeconds(state: MusicState, seconds: number): number {
  return Math.max(1, Math.ceil(seconds / planBar(0, state).secPerBar));
}
