/**
 * The `music` bus.
 *
 *   layer outputs -> layerGain[id] --\
 *                                     >-- mix -> duck -> pause -> volume -> dest
 *   song source   -> songGain -------/
 *                     ^ songDuck
 *
 * Four independent trims, because four independent things want to change the
 * music's level and they must not fight:
 *   volume  the Settings slider (bus name agreed with the UI agent: "music")
 *   pause   the pause MENU. Music keeps playing as the pause screen's
 *           ambience, at PAUSE_LEVEL. It is never stopped and never cut.
 *   duck    NPC speech. The voice agent calls duck(amount) on this bus.
 *   layer   the vertical arrangement, driven by the scheduler.
 *
 * SONGS land on `mix` alongside the layers, which is the whole point: the
 * Settings slider, the speech duck and the pause level govern a decoded song
 * exactly as they govern a synth layer, with no second code path.
 *
 * `songDuck` is a FIFTH trim, and it is deliberately separate from `duck`.
 * Combat and boss intensity duck the song rather than stopping it; speech ducks
 * it too. If both wrote to one node they would clobber each other's ramps —
 * an NPC finishing a sentence would un-duck the song in the middle of a fight.
 * Two nodes in series multiply, which is the behaviour you actually want.
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

/**
 * Level a song sits at under combat/boss intensity. About -6 dB.
 *
 * Shallower than the speech duck on purpose: speech has to be intelligible over
 * the music, whereas a fight only has to feel like it takes the foreground. The
 * song is still clearly playing at this level, which is the requirement — a
 * fight must never be the reason the developer's music stops.
 */
export const SONG_DUCK_FLOOR = 0.5;

const DUCK_ATTACK = 0.12;
const DUCK_RELEASE = 0.4;
const PAUSE_FADE = 0.25;
/** Song intensity duck. Slower than speech — a fight is not a syllable. */
const SONG_DUCK_ATTACK = 0.5;
const SONG_DUCK_RELEASE = 1.2;

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
  /** Where decoded song sources land. Fades are driven by the interlude. */
  readonly songGain: GainNode;
  /** Combat/boss trim on the song path only. */
  readonly songDuckGain: GainNode;

  private readonly ramps: Record<LayerId, Ramp>;
  private songRamp: Ramp = { from: 0, to: 0, t0: 0, t1: 0 };
  private songDuckRamp: Ramp = { from: 1, to: 1, t0: 0, t1: 0 };
  private _songDuck = 0;
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

    this.songGain = ctx.createGain();
    this.songGain.gain.value = 0;
    this.songDuckGain = ctx.createGain();
    this.songDuckGain.gain.value = 1;

    this.mix.connect(this.duckGain);
    this.duckGain.connect(this.pauseGain);
    this.pauseGain.connect(this.volumeGain);
    this.volumeGain.connect(destination);
    // song -> songGain (interlude fades) -> songDuck (combat) -> mix
    this.songGain.connect(this.songDuckGain);
    this.songDuckGain.connect(this.mix);

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
   * `cancelScheduledValues(t)` removes events AT `t`, not merely after it — and
   * an in-flight ramp's ENDPOINT very often sits exactly at the moment the next
   * fade begins, because every fade here is bar-aligned and bars abut.
   *
   * Losing that endpoint does not just change the future. It rewrites the PAST:
   * the ramp that was climbing towards it loses its destination, so the
   * automation between the previous event and `t0` collapses from a ramp into a
   * HOLD at the ramp's start value. When that start value is zero — which it is
   * for the very first bar, and after any fade-out — everything back to the
   * previous event goes silent, retroactively.
   *
   * This was not theoretical. It silenced the entire first bar of the castle
   * bed (3.33 s, back to t = 0.06) when the interlude's thin fade was issued
   * three seconds later, and the render was digital zero, not merely quiet.
   * Real WebAudio has the same cancellation semantics, so this was a bug in the
   * browser and not an artefact of the Node shim.
   *
   * The fix is to re-assert the ramp that was in flight, so the past survives
   * the cancellation.
   */
  private reassertPast(p: AudioParam, prev: Ramp, t0: number): void {
    if (prev.t1 <= prev.t0 || prev.t0 >= t0) return;
    // Tolerance, not equality. A bar downbeat and (next downbeat - secPerBar)
    // are the same instant musically and differ in the last bit of a double:
    // measured, the castle's bar 1 was 3.3933333333333335 by one route and
    // 3.393333333333333 by the other. An exact test misses that by a hair and
    // the whole repair silently does not happen.
    if (prev.t1 > t0 + 1e-6) return;
    p.setValueAtTime(prev.from, prev.t0);
    // CLAMPED to t0. If the previous endpoint lands even one ulp AFTER t0, a
    // ramp scheduled at prev.t1 sorts after the setValueAtTime below and is
    // shadowed by it — reinstating the endpoint but leaving the hold in place,
    // which is the exact bug this is undoing.
    p.linearRampToValueAtTime(prev.to, Math.min(prev.t1, t0));
  }

  /**
   * Ramp a layer from its current modelled value at `t0` to `target` at `t1`.
   * `t1` is always a bar downbeat — see scheduler.ts.
   */
  fadeTo(id: LayerId, target: number, t0: number, t1: number): void {
    const prev = this.ramps[id];
    const from = this.gainAt(id, t0);
    this.ramps[id] = { from, to: target, t0, t1 };
    const p = this.layerGain[id].gain;
    p.cancelScheduledValues(t0);
    this.reassertPast(p, prev, t0);
    p.setValueAtTime(from, t0);
    if (t1 > t0 + 1e-4) p.linearRampToValueAtTime(target, t1);
    else p.setValueAtTime(target, t1);
  }

  /** Where a decoded song source connects. */
  songInput(): AudioNode {
    return this.songGain;
  }

  /**
   * Ramp the song level from its modelled value at `t0` to `target` at `t1`.
   *
   * Modelled analytically for exactly the same reason the layer gains are: the
   * transition tests assert that the song's fade-in ENDS on a bar downbeat, and
   * `gain.value` cannot answer where an in-flight ramp has reached.
   */
  fadeSong(target: number, t0: number, t1: number): void {
    const prev = this.songRamp;
    const from = rampAt(this.songRamp, t0);
    this.songRamp = { from, to: target, t0, t1 };
    const p = this.songGain.gain;
    p.cancelScheduledValues(t0);
    this.reassertPast(p, prev, t0);
    p.setValueAtTime(from, t0);
    if (t1 > t0 + 1e-4) p.linearRampToValueAtTime(target, t1);
    else p.setValueAtTime(target, t1);
  }

  /** The engine's model of the song gain at absolute time `t`. */
  songGainAt(t: number): number {
    return rampAt(this.songRamp, t);
  }

  songFadeEnd(): number {
    return this.songRamp.t1;
  }

  songFadeTarget(): number {
    return this.songRamp.to;
  }

  /**
   * Combat/boss duck on the song path. 0 = unducked, 1 = fully ducked
   * (SONG_DUCK_FLOOR). Idempotent, so the scheduler may call it every frame.
   */
  duckSong(amount: number): void {
    const a = Math.max(0, Math.min(1, amount));
    if (Math.abs(a - this._songDuck) < 1e-4) return;
    const rising = a > this._songDuck;
    this._songDuck = a;
    this.songDuckRamp = this.rampTrim(
      this.songDuckGain,
      this.songDuckRamp,
      1 - (1 - SONG_DUCK_FLOOR) * a,
      this.now,
      rising ? SONG_DUCK_ATTACK : SONG_DUCK_RELEASE,
    );
  }

  get songDuckAmount(): number {
    return this._songDuck;
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
    this.reassertPast(p, ramp, t);
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
