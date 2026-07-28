/**
 * SONG PLAYBACK — the decoded-buffer side of the layer seam.
 *
 * layer.ts promised that "a layer is synth-generated today and a decoded buffer
 * tomorrow". This is tomorrow. A SongPlayer owns the AudioBufferSourceNodes for
 * one segment and nothing else: it does not know about regions, rotations,
 * bars or game state. The interlude decides WHEN; this decides HOW.
 *
 * Two envelope levels, deliberately separate:
 *   - per-source gain, owned here: the segment's own head/tail fades and the
 *     LOOP CROSSFADE, which needs two sources overlapping with independent
 *     envelopes and so cannot live on a single shared node;
 *   - the bus's songGain, owned by the interlude: the handoff fade into and out
 *     of the procedural bed.
 * They multiply, which is what you want — a loop seam happening during a
 * handoff fade must not cancel either one.
 *
 * THE LOOP, concretely. For a segment with loop {startS, endS, crossfadeS}:
 *
 *   iteration 0   offset seg.startS, runs to endS + xf, fades out over the xf
 *   iteration i>0 offset loop.startS, runs to endS + xf,
 *                 fades IN over the first xf, out over the last
 *   iteration i+1 begins exactly at iteration i's `endS` point
 *
 * so the outgoing tail is REAL audio from past the loop end, crossfaded against
 * the real head. Nothing is pre-rendered and nothing is cut; the file simply has
 * to carry `crossfadeS` of material after `endS`, which songs.ts checks.
 *
 * The crossfade is LINEAR, not equal-power — see the measurement note on
 * UNTITLED_LOOP in songs.ts. Joining a piece to itself sums coherently, and
 * sin/cos overshoots by ~30% and clips.
 */

import type { SongSegment } from './songs';

/** How far ahead a loop iteration is scheduled. Well inside any frame budget. */
export const SONG_SCHEDULE_AHEAD = 2.0;

export interface SongPlayerOptions {
  /** Playback trim from the track's measured level, as a linear gain. */
  gain: number;
}

interface Iteration {
  /** Absolute start time of this iteration. */
  at: number;
  source: AudioBufferSourceNode;
  gain: GainNode;
  /** Absolute time this iteration's audio is fully silent. */
  until: number;
}

export class SongPlayer {
  private readonly iterations: Iteration[] = [];
  private _startedAt = 0;
  private _endsAt = Infinity;
  private _stopped = false;
  /** Absolute time the NEXT loop iteration begins, or Infinity if not looping. */
  private nextIterationAt = Infinity;
  private iterationCount = 0;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly dest: AudioNode,
    private readonly buffer: AudioBuffer,
    readonly segment: SongSegment,
    private readonly opts: SongPlayerOptions,
  ) {}

  get startedAt(): number {
    return this._startedAt;
  }

  /** Absolute time the segment finishes. Infinity while looping. */
  get endsAt(): number {
    return this._endsAt;
  }

  get looping(): boolean {
    return this.segment.loop !== undefined;
  }

  get stopped(): boolean {
    return this._stopped;
  }

  /** Iterations scheduled so far — the loop-seam count, for tests. */
  get seams(): number {
    return Math.max(0, this.iterationCount - 1);
  }

  /**
   * Begin at absolute time `at` (always a bar downbeat, chosen by the
   * interlude). Schedules the first iteration only; `pump` does the rest.
   */
  start(at: number): void {
    this._startedAt = at;
    const seg = this.segment;
    const loop = seg.loop;
    if (loop) {
      // Iteration 0 carries the intro: it starts at the segment's own start and
      // runs all the way to the loop end plus the crossfade tail.
      this.scheduleIteration(at, seg.startS, loop.endS, false);
      this.nextIterationAt = at + (loop.endS - seg.startS);
      this._endsAt = Infinity;
    } else {
      this.scheduleIteration(at, seg.startS, seg.endS, false);
      this._endsAt = at + (seg.endS - seg.startS);
    }
  }

  /**
   * Schedule whatever the next couple of seconds need. Cheap and idempotent:
   * in the common frame it compares two numbers and returns.
   */
  pump(nowS: number): void {
    if (this._stopped) return;
    const loop = this.segment.loop;
    if (!loop) return;
    while (this.nextIterationAt < nowS + SONG_SCHEDULE_AHEAD) {
      const at = this.nextIterationAt;
      this.scheduleIteration(at, loop.startS, loop.endS, true);
      this.nextIterationAt = at + (loop.endS - loop.startS);
    }
    this.retire(nowS);
  }

  /**
   * The tab was backgrounded and `pump` stopped being called.
   *
   * A NON-looping segment needs nothing: its whole span is one source that was
   * scheduled up front with absolute times, so it played correctly the entire
   * time nobody was watching. Only a loop can fall behind, because its next
   * iteration is scheduled a couple of seconds ahead by design. Re-anchor it to
   * now rather than scheduling a burst of iterations whose start times are
   * already in the past.
   */
  resync(nowS: number): void {
    if (this._stopped) return;
    if (!this.segment.loop) return;
    if (this.nextIterationAt >= nowS - 0.25) return;
    this.nextIterationAt = nowS + 0.05;
    this.retire(nowS);
  }

  /**
   * Fade out over `fadeS` starting at `at`, then stop. Never a hard cut: the
   * sources are told to stop only AFTER their envelope has reached zero.
   */
  stop(at: number, fadeS: number): void {
    if (this._stopped) return;
    this._stopped = true;
    const end = at + fadeS;
    for (const it of this.iterations) {
      const p = it.gain.gain;
      const cur = this.envelopeAt(it, at);
      p.cancelScheduledValues(at);
      p.setValueAtTime(cur, at);
      p.linearRampToValueAtTime(0, end);
      try {
        it.source.stop(end + 0.02);
      } catch {
        /* already stopped */
      }
      it.until = Math.min(it.until, end + 0.02);
    }
    this._endsAt = Math.min(this._endsAt, end);
    this.nextIterationAt = Infinity;
  }

  /** Latest time any scheduled source is still sounding. */
  get tailTime(): number {
    let t = 0;
    for (const it of this.iterations) t = Math.max(t, it.until);
    return t;
  }

  // -------------------------------------------------------------- internals

  /**
   * One playback of [fromS, toS) of the file, with the segment's fades and, when
   * looping, the crossfade envelope.
   */
  private scheduleIteration(at: number, fromS: number, toS: number, isLoopHead: boolean): void {
    const seg = this.segment;
    const loop = seg.loop;
    const xf = loop?.crossfadeS ?? 0;
    const body = toS - fromS;
    // Play past `toS` by the crossfade so the outgoing tail is real audio.
    const tail = loop ? Math.min(xf, Math.max(0, this.buffer.duration - toS)) : 0;
    const dur = body + tail;

    const g = this.ctx.createGain();
    g.connect(this.dest);
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(g);

    const p = g.gain;
    const base = this.opts.gain;

    // Head: the loop crossfade's fade-in, or the segment's own fade-in, or full.
    if (isLoopHead && tail > 0) {
      p.setValueAtTime(0, at);
      p.linearRampToValueAtTime(base, at + xf);
    } else if (seg.fadeInS > 0) {
      p.setValueAtTime(0, at);
      p.linearRampToValueAtTime(base, at + seg.fadeInS);
    } else {
      p.setValueAtTime(base, at);
    }

    // Tail: the loop crossfade's fade-out, or the segment's own fade-out.
    if (tail > 0) {
      p.setValueAtTime(base, at + body);
      p.linearRampToValueAtTime(0, at + body + tail);
    } else if (seg.fadeOutS > 0) {
      p.setValueAtTime(base, at + body - seg.fadeOutS);
      p.linearRampToValueAtTime(0, at + body);
    }

    src.start(at, fromS, dur);
    this.iterations.push({ at, source: src, gain: g, until: at + dur + 0.02 });
    this.iterationCount++;
  }

  /** Modelled envelope value, so `stop` can ramp from where the fade actually is. */
  private envelopeAt(it: Iteration, t: number): number {
    const seg = this.segment;
    const loop = seg.loop;
    const xf = loop?.crossfadeS ?? 0;
    const base = this.opts.gain;
    const dt = t - it.at;
    if (dt <= 0) return 0;
    const isFirst = it.at === this._startedAt;
    if (loop && !isFirst && dt < xf) return base * (dt / xf);
    if (!loop && seg.fadeInS > 0 && dt < seg.fadeInS) return base * (dt / seg.fadeInS);
    return base;
  }

  /** Drop iterations that have finished, so the array cannot grow forever. */
  private retire(nowS: number): void {
    for (let i = this.iterations.length - 1; i >= 0; i--) {
      if (this.iterations[i]!.until < nowS - 0.5) this.iterations.splice(i, 1);
    }
  }
}
