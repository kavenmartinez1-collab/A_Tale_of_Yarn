/**
 * The lookahead scheduler.
 *
 * Two clocks, deliberately separated:
 *   - the GAME calls update(state, nowS) once per frame, at whatever rate;
 *   - MUSIC time is a bar grid built from accumulated bar durations, so a
 *     tempo change at a downbeat never shifts the grid retroactively.
 *
 * Nothing is spawned per frame. update() only (a) reacts to a state change,
 * (b) plans bars that are about to arrive, and (c) dispatches the few onsets
 * that fall inside the next ~0.28 s. Everything else is already sitting in
 * WebAudio's own scheduler with absolute start times.
 *
 * TRANSITIONS. A state change never takes effect where it happened. It is
 * committed to the first bar downbeat that is (a) at least MIN_FADE away and
 * (b) not yet planned. Layer gains ramp to their new targets and LAND ON THAT
 * DOWNBEAT — the crossfade completes exactly as the bar turns over. Notes
 * already scheduled play out in full; the engine never stops or disconnects a
 * sounding voice, so no envelope is ever cut.
 */

import { arrangeBar, type BarNotes } from './arranger';
import { MusicBus } from './bus';
import {
  SynthLayer,
  applyVoiceBudget,
  flattenBar,
  type ActiveVoice,
  type LayerSource,
  type Onset,
} from './layer';
import { DEFAULT_STATE, LAYERS, planBar, sameState, type BarPlan, type LayerId, type MusicState } from './state';
import { makeNoiseBuffer } from './voices';

/** Dispatch window: onsets starting within this are handed to WebAudio. */
export const LOOKAHEAD = 0.28;
/** Bars are arranged this far ahead of their downbeat. */
export const PLAN_AHEAD = 0.5;
/** A crossfade is never shorter than this. */
export const MIN_FADE = 0.25;
/** Preferred crossfade length; shortened only if the downbeat is nearer. */
export const DESIRED_FADE = 0.9;
/** First downbeat sits this far after the first update(). */
export const START_DELAY = 0.06;
/** If the clock has drifted further than this (tab was backgrounded), resync. */
export const RESYNC_AFTER = 1.5;

export interface Transition {
  /** Bar index the new state takes effect on. */
  bar: number;
  /** Absolute time of that downbeat — where every layer fade lands. */
  at: number;
  /** When update() first saw the change. */
  requestedAt: number;
  state: MusicState;
}

export interface SchedulerStats {
  /** Next bar to be planned. */
  bar: number;
  barsPlanned: number;
  notesDispatched: number;
  voicesDropped: number;
  /** Which layers lost onsets to the voice budget. */
  droppedByLayer: Partial<Record<LayerId, number>>;
  /** Highest simultaneous voice count the budget ever allowed. */
  peakVoices: number;
  resyncs: number;
  /** Every committed transition, newest last. */
  transitions: readonly Transition[];
  /** Bar downbeat times, indexed by bar number. */
  barTimes: readonly number[];
}

interface PlannedBar {
  plan: BarPlan;
  notes: BarNotes;
}

export class MusicScheduler {
  private readonly layers: Record<LayerId, LayerSource>;
  private readonly queue: Onset[] = [];
  /** Voices counted against the budget, carried across bar boundaries. */
  private readonly activeVoices: ActiveVoice[] = [];

  private started = false;
  private nextBar = 0;
  private nextBarTime = 0;
  private requested: MusicState = { ...DEFAULT_STATE };
  private commits: { bar: number; state: MusicState }[] = [];
  private readonly _transitions: Transition[] = [];
  private readonly _barTimes: number[] = [];

  private _barsPlanned = 0;
  private _notesDispatched = 0;
  private _voicesDropped = 0;
  private readonly _droppedByLayer: Partial<Record<LayerId, number>> = {};
  private _peakVoices = 0;
  private _resyncs = 0;
  /** Cache so planBar/arrangeBar are not recomputed by the fade path. */
  private lastPlanned: PlannedBar | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly seed: number,
    readonly bus: MusicBus,
  ) {
    const noise = makeNoiseBuffer(ctx, seed ^ 0x5eed1e);
    const layers = {} as Record<LayerId, LayerSource>;
    for (const id of LAYERS) layers[id] = new SynthLayer(id, ctx, bus.input(id), noise);
    this.layers = layers;
  }

  get stats(): SchedulerStats {
    return {
      bar: this.nextBar,
      barsPlanned: this._barsPlanned,
      notesDispatched: this._notesDispatched,
      voicesDropped: this._voicesDropped,
      droppedByLayer: this._droppedByLayer,
      peakVoices: this._peakVoices,
      resyncs: this._resyncs,
      transitions: this._transitions,
      barTimes: this._barTimes,
    };
  }

  /** State in force on a given bar. */
  stateForBar(bar: number): MusicState {
    let s = this.commits[0]?.state ?? this.requested;
    for (const c of this.commits) {
      if (c.bar <= bar) s = c.state;
      else break;
    }
    return s;
  }

  /** Downbeat time of a bar, for bars already planned. */
  barTime(bar: number): number | undefined {
    return this._barTimes[bar];
  }

  // ------------------------------------------------------------------ update

  update(state: MusicState, nowS: number): void {
    if (!this.started) this.start(state, nowS);

    this.bus.setNow(nowS);
    this.bus.setPaused(state.paused === true, nowS);

    if (!sameState(state, this.requested)) {
      this.requested = { ...state };
      this.commitTransition(nowS);
    } else {
      // Keep the non-structural fields fresh without forcing a transition.
      this.requested = { ...this.requested, tod: state.tod, weather: state.weather };
    }

    // Resync if the page was backgrounded and our grid fell far behind.
    if (this.nextBarTime < nowS - RESYNC_AFTER) {
      this.nextBarTime = nowS + START_DELAY;
      this.queue.length = 0;
      this.activeVoices.length = 0;
      this._resyncs++;
    }

    while (this.nextBarTime < nowS + PLAN_AHEAD) this.planNextBar();
    this.dispatch(nowS);
  }

  private start(state: MusicState, nowS: number): void {
    this.started = true;
    this.requested = { ...state };
    this.commits = [{ bar: 0, state: { ...state } }];
    this.nextBar = 0;
    this.nextBarTime = nowS + START_DELAY;

    // Fade the whole arrangement up across the first bar rather than
    // slamming in at full level.
    const plan = planBar(0, state);
    for (const id of LAYERS) {
      this.bus.fadeTo(id, plan.gains[id], this.nextBarTime, this.nextBarTime + plan.secPerBar);
    }
  }

  /**
   * Choose the downbeat this change lands on, ramp every layer to its new
   * target so the ramp ENDS there, and record the commit so the arranger uses
   * the new state from that bar onward.
   */
  private commitTransition(nowS: number): void {
    // Walk forward from the first unplanned bar, accumulating real bar
    // durations, until we clear MIN_FADE. Bars already planned cannot change.
    let bar = this.nextBar;
    let t = this.nextBarTime;
    let guard = 0;
    while (t < nowS + MIN_FADE && guard++ < 64) {
      t += planBar(bar, this.stateForBar(bar)).secPerBar;
      bar++;
    }

    this.commits.push({ bar, state: { ...this.requested } });
    if (this.commits.length > 8) this.commits.splice(0, this.commits.length - 8);

    const plan = planBar(bar, this.requested);
    const fadeStart = Math.max(nowS, t - DESIRED_FADE);
    for (const id of LAYERS) this.bus.fadeTo(id, plan.gains[id], fadeStart, t);

    this._transitions.push({ bar, at: t, requestedAt: nowS, state: { ...this.requested } });
    if (this._transitions.length > 64) this._transitions.shift();
  }

  private planNextBar(): void {
    const bar = this.nextBar;
    const barTime = this.nextBarTime;
    const plan = planBar(bar, this.stateForBar(bar));
    const notes = arrangeBar(this.seed, plan);

    // A layer contributes notes whenever it is audible anywhere in this bar —
    // so a layer fading IN arrives mid-phrase rather than starting from
    // nothing, and a layer fading OUT is not truncated.
    const barEnd = barTime + plan.secPerBar;
    const audible = (id: LayerId): boolean =>
      this.bus.gainAt(id, barTime) > 0.004 ||
      this.bus.gainAt(id, barEnd) > 0.004 ||
      this.bus.fadeTarget(id) > 0.004;

    const audibleLayers = LAYERS.filter(audible);
    const onsets = flattenBar(notes, barTime, plan, audible);
    const { kept, dropped, droppedBy, peak } = applyVoiceBudget(
      onsets,
      this.activeVoices,
      audibleLayers,
    );
    this._voicesDropped += dropped;
    this._peakVoices = Math.max(this._peakVoices, peak);
    for (const k of Object.keys(droppedBy) as LayerId[]) {
      this._droppedByLayer[k] = (this._droppedByLayer[k] ?? 0) + droppedBy[k]!;
    }

    for (const o of kept) this.queue.push(o);
    this.queue.sort((a, b) => a.when - b.when);

    this._barTimes[bar] = barTime;
    this.lastPlanned = { plan, notes };
    this._barsPlanned++;
    this.nextBar = bar + 1;
    this.nextBarTime = barTime + plan.secPerBar;
  }

  private dispatch(nowS: number): void {
    const horizon = nowS + LOOKAHEAD;
    let i = 0;
    while (i < this.queue.length && this.queue[i]!.when < horizon) {
      const o = this.queue[i]!;
      const plan = this.planFor(o.note.bar);
      this.layers[o.layer].scheduleBar([o.note], this._barTimes[o.note.bar]!, plan);
      this._notesDispatched++;
      i++;
    }
    if (i > 0) this.queue.splice(0, i);
  }

  private planFor(bar: number): BarPlan {
    if (this.lastPlanned && this.lastPlanned.plan.bar === bar) return this.lastPlanned.plan;
    return planBar(bar, this.stateForBar(bar));
  }

  /** Latest time any scheduled voice is still sounding — used by renders. */
  get tailTime(): number {
    let t = 0;
    for (const id of LAYERS) t = Math.max(t, this.layers[id].tailTime);
    return t;
  }
}
