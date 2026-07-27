/**
 * The `music` bus.
 *
 *   layer outputs -> layerGain[id] -> mix -> duck -> pause -> volume -> dest
 *
 * Four independent trims, because four independent things want to change the
 * music's level and they must not fight:
 *   volume  the Settings slider (bus name agreed with the UI agent: "music")
 *   pause   the pause MENU. Music keeps playing as the pause screen's
 *           ambience, at PAUSE_LEVEL. It is never stopped and never cut.
 *   duck    NPC speech. The voice agent calls duck(amount) on this bus.
 *   layer   the vertical arrangement, driven by the scheduler.
 *
 * Layer gains are tracked ANALYTICALLY as well as scheduled onto the
 * AudioParam. WebAudio's `gain.value` reports the last *set* value, not the
 * current automated one, so the engine keeps its own model of every ramp —
 * which is also what lets test-music.mts assert "this fade lands exactly on
 * the bar boundary" without rendering a single sample.
 */

import { LAYERS, type LayerId } from './state';

/**
 * Fixed output trim, applied after the user's volume.
 *
 * Sized so that the LOUDEST state in the matrix (castle/boss) still peaks
 * below -3 dBFS with the Settings slider at maximum — the mix must not clip
 * because someone dragged the fader to 1.0. Asserted at volume = 1.0 in
 * scripts/test-music.mts, not at the default.
 */
export const MASTER_TRIM = 0.55;

/** Music level while the pause menu is open. */
export const PAUSE_LEVEL = 0.45;
/** Level at full duck (amount = 1). About -12 dB. */
export const DUCK_FLOOR = 0.25;

const DUCK_ATTACK = 0.12;
const DUCK_RELEASE = 0.4;
const PAUSE_FADE = 0.25;

interface Ramp {
  from: number;
  to: number;
  t0: number;
  t1: number;
}

function rampAt(r: Ramp, t: number): number {
  if (t <= r.t0) return r.from;
  if (t >= r.t1) return r.to;
  return r.from + (r.to - r.from) * ((t - r.t0) / (r.t1 - r.t0));
}

export class MusicBus {
  readonly layerGain: Record<LayerId, GainNode>;
  readonly mix: GainNode;
  readonly duckGain: GainNode;
  readonly pauseGain: GainNode;
  readonly volumeGain: GainNode;

  private readonly ramps: Record<LayerId, Ramp>;
  private _volume = 0.85;
  private _duck = 0;
  private _paused = false;
  /**
   * The engine's notion of "now", pushed by the scheduler on every update().
   *
   * duck() and setVolume() are called from game code with no time argument, so
   * they need a reference point. `ctx.currentTime` is the obvious one and is
   * correct on a live AudioContext — but on an OfflineAudioContext it stays at
   * 0 until rendering begins, which silently scheduled every duck at t=0 and
   * ducked the whole render uniformly. Tracking the update clock instead is
   * right in both worlds.
   */
  private _now = 0;
  private duckRamp: Ramp = { from: 1, to: 1, t0: 0, t1: 0 };
  private pauseRamp: Ramp = { from: 1, to: 1, t0: 0, t1: 0 };
  private volumeRamp: Ramp;

  constructor(
    private readonly ctx: BaseAudioContext,
    destination: AudioNode,
  ) {
    this.mix = ctx.createGain();
    this.mix.gain.value = 1;
    this.duckGain = ctx.createGain();
    this.duckGain.gain.value = 1;
    this.pauseGain = ctx.createGain();
    this.pauseGain.gain.value = 1;
    this.volumeGain = ctx.createGain();
    this.volumeGain.gain.value = this._volume * MASTER_TRIM;
    const v0 = this._volume * MASTER_TRIM;
    this.volumeRamp = { from: v0, to: v0, t0: 0, t1: 0 };

    this.mix.connect(this.duckGain);
    this.duckGain.connect(this.pauseGain);
    this.pauseGain.connect(this.volumeGain);
    this.volumeGain.connect(destination);

    const gains = {} as Record<LayerId, GainNode>;
    const ramps = {} as Record<LayerId, Ramp>;
    for (const id of LAYERS) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.mix);
      gains[id] = g;
      ramps[id] = { from: 0, to: 0, t0: 0, t1: 0 };
    }
    this.layerGain = gains;
    this.ramps = ramps;
  }

  /** Where a layer's voices connect. */
  input(id: LayerId): AudioNode {
    return this.layerGain[id];
  }

  /** Called by the scheduler each update(); see `_now`. */
  setNow(t: number): void {
    if (t > this._now) this._now = t;
  }

  private get now(): number {
    return Math.max(this._now, this.ctx.currentTime);
  }

  /** The engine's own model of a layer's gain at absolute context time `t`. */
  gainAt(id: LayerId, t: number): number {
    return rampAt(this.ramps[id], t);
  }

  /** Scheduled fade end time for a layer — the assertion target for transitions. */
  fadeEnd(id: LayerId): number {
    return this.ramps[id].t1;
  }

  fadeTarget(id: LayerId): number {
    return this.ramps[id].to;
  }

  /**
   * Ramp a layer from its current modelled value at `t0` to `target` at `t1`.
   * `t1` is always a bar downbeat — see scheduler.ts.
   */
  fadeTo(id: LayerId, target: number, t0: number, t1: number): void {
    const from = this.gainAt(id, t0);
    this.ramps[id] = { from, to: target, t0, t1 };
    const p = this.layerGain[id].gain;
    p.cancelScheduledValues(t0);
    p.setValueAtTime(from, t0);
    if (t1 > t0 + 1e-4) p.linearRampToValueAtTime(target, t1);
    else p.setValueAtTime(target, t1);
  }

  /**
   * Ramp one of the three master trims. Every one of them has to read its own
   * CURRENT value to ramp smoothly from it, and `AudioParam.value` cannot
   * supply that — it reports the last explicitly *set* value, not where an
   * in-flight automation has reached. So each trim keeps a modelled Ramp, the
   * same way the layer gains do.
   */
  private rampTrim(node: GainNode, ramp: Ramp, target: number, t: number, dur: number): Ramp {
    const from = rampAt(ramp, t);
    const next: Ramp = { from, to: target, t0: t, t1: t + dur };
    const p = node.gain;
    p.cancelScheduledValues(t);
    p.setValueAtTime(from, t);
    p.linearRampToValueAtTime(target, t + dur);
    return next;
  }

  /** 0..1. The Settings panel's "music" slider writes here. */
  setVolume(v: number): void {
    this._volume = Math.max(0, Math.min(1, v));
    this.volumeRamp = this.rampTrim(
      this.volumeGain,
      this.volumeRamp,
      this._volume * MASTER_TRIM,
      this.now,
      0.05,
    );
  }

  get volume(): number {
    return this._volume;
  }

  /**
   * Duck under speech. `amount` 0 = unducked, 1 = fully ducked (DUCK_FLOOR).
   * Ducking down is fast, coming back is slow — the usual broadcast shape.
   */
  duck(amount: number): void {
    const a = Math.max(0, Math.min(1, amount));
    const rising = a > this._duck;
    this._duck = a;
    this.duckRamp = this.rampTrim(
      this.duckGain,
      this.duckRamp,
      1 - (1 - DUCK_FLOOR) * a,
      this.now,
      rising ? DUCK_ATTACK : DUCK_RELEASE,
    );
  }

  get duckAmount(): number {
    return this._duck;
  }

  /** Pause menu open/closed. Fades, never stops. */
  setPaused(on: boolean, now: number): void {
    if (on === this._paused) return;
    this._paused = on;
    this.pauseRamp = this.rampTrim(
      this.pauseGain,
      this.pauseRamp,
      on ? PAUSE_LEVEL : 1,
      now,
      PAUSE_FADE,
    );
  }

  get paused(): boolean {
    return this._paused;
  }
}
