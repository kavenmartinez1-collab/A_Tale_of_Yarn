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
import { MusicScheduler, type SchedulerStats } from './scheduler';
import { arrangeBar, type BarNotes } from './arranger';
import { LAYERS, planBar, type BarPlan, type LayerId, type MusicState } from './state';

export { MOTIF, MOTIF_HEAD_INTERVALS, MOTIF_INTERVALS, countMotifStatements } from './motif';
export { LAYER_MATRIX, LAYERS, REGION_CONFIG, REGIONS, INTENSITIES, planBar } from './state';
export type { BarPlan, Intensity, LayerId, MusicState, Region } from './state';
export type { NoteEvent, BarNotes } from './arranger';
export { arrangeBar } from './arranger';
export { MAX_VOICES } from './layer';
export { DUCK_FLOOR, PAUSE_LEVEL } from './bus';
export { LOOKAHEAD, MIN_FADE, DESIRED_FADE, PLAN_AHEAD } from './scheduler';

export interface MusicOptions {
  /** Where the bus lands. Defaults to ctx.destination. */
  destination?: AudioNode;
  /** Initial volume, 0..1. */
  volume?: number;
}

/** Snapshot for tests and for the debug overlay. */
export interface MusicSnapshot extends SchedulerStats {
  layerGain: Record<LayerId, number>;
  layerTarget: Record<LayerId, number>;
  fadeEnd: Record<LayerId, number>;
  volume: number;
  duck: number;
  paused: boolean;
}

export interface MusicEngine {
  /** Call once per frame. `nowS` is AudioContext-domain seconds. */
  update(state: MusicState, nowS: number): void;
  /** The Settings panel's "music" bus, 0..1. */
  setVolume(v: number): void;
  /** NPC speech ducking. 0 = unducked, 1 = fully ducked. */
  duck(amount: number): void;
  /** Exportable state for tests / debug HUD. */
  snapshot(nowS: number): MusicSnapshot;
  readonly bus: MusicBus;
  readonly seed: number;
}

export function createMusic(
  ctx: BaseAudioContext,
  seed: number,
  opts: MusicOptions = {},
): MusicEngine {
  const bus = new MusicBus(ctx, opts.destination ?? ctx.destination);
  if (opts.volume !== undefined) bus.setVolume(opts.volume);
  const sched = new MusicScheduler(ctx, seed >>> 0, bus);

  return {
    update(state, nowS) {
      sched.update(state, nowS);
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
      };
    },
    bus,
    seed: seed >>> 0,
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
