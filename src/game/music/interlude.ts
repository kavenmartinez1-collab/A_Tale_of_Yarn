/**
 * THE FLOW PROTOCOL — how a song arrives and leaves without a seam.
 *
 * The one hard requirement from the developer: "the transition into and out
 * doesn't awkwardly cut". Everything here exists to make the handoff a piece of
 * music rather than a crossfade.
 *
 * ===========================================================================
 * ENTERING (three stages, every boundary on a bar downbeat)
 * ===========================================================================
 *
 *   bar N-1 ......... bar N ......... bar N+1 ......... bar N+2 ...........
 *   [ thin fade ---> ][ bass fade --> ][ pad alone,      ][ SONG
 *                     melody, pluck,    pivoted into      pad rides on top
 *                     perc, tension     the song's key    2.5 s, then fades
 *                     are gone          as an open 5th
 *
 *   1. THIN   the activity layers (melody, pluck, perc, tension) fade out
 *             across one whole bar and land on bar N. Pad and bass hold.
 *   2. PIVOT  bass fades out across bar N; on bar N+1 the pad RE-VOICES to the
 *             song's own tonic as an open fifth. This is the modulation that
 *             makes the overlap consonant — see the KEYS block in songs.ts for
 *             why a shared global tonic was not available to us.
 *   3. SONG   the song starts exactly on downbeat N+2. The pivoted pad holds
 *             under its head for PAD_OVERLAP seconds, then fades under it.
 *
 * ===========================================================================
 * LEAVING (the same thing backwards)
 * ===========================================================================
 *
 *   EXIT_LEAD before the song ends (or immediately, if the region changed),
 *   the pad rises again IN THE SONG'S KEY — consonant with the tail it is
 *   rising under. The song finishes or fades. On the first downbeat after it is
 *   gone, the pad modulates home and the rest of the bed returns across one bar.
 *
 * Nothing is ever stopped mid-envelope. A song is never cut off by combat: high
 * intensity DUCKS it on the bus's dedicated song trim, because a fight should
 * take the foreground without silencing the developer's music. Only an actual
 * change of which song belongs here ends one early, and that goes through the
 * same exit protocol.
 *
 * ===========================================================================
 * DETERMINISM
 * ===========================================================================
 *
 * The cadence is a pure function of (seed, interlude index) and a pause-frozen
 * clock. No Math.random, no Date.now — the same rule as the rest of the engine.
 * The decoded PCM is obviously not re-rendered per run, so what the tests assert
 * is the EVENT LOG: which segment, on which bar, at which clock reading. Two
 * runs with the same seed and the same state script produce identical logs.
 */

import type { MusicBus } from './bus';
import type { SongLibrary } from './decode';
import { mix32, mulberry32, salt } from './rng';
import type { MusicScheduler } from './scheduler';
import { RESYNC_AFTER } from './scheduler';
import { SongPlayer } from './song-player';
import {
  INTERLUDE_REGIONS,
  OVERWORLD_ROTATION,
  REGION_SEGMENT,
  SEGMENTS,
  SONGS,
  nearestMidiForPc,
  type SegmentId,
  type SongSegment,
} from './songs';
import { REGION_CONFIG, type BedOverride, type Intensity, type LayerId, type MusicState } from './state';

/** Seconds of bed between one interlude ending and the next beginning. */
export const INTERLUDE_INTERVAL = 240;
/** Seeded jitter around that interval, so it never metronomes. */
export const INTERLUDE_JITTER = 40;
/** If a track is not decoded when its turn comes, try again this soon. */
export const INTERLUDE_RETRY = 20;
/** How long the pivoted pad holds under the song's head before fading. */
export const PAD_OVERLAP = 2.5;
/** How long that pad takes to fade under the song. */
export const PAD_FADE = 1.2;
/** How long the song takes to arrive. Short: the pad is covering the join. */
export const SONG_FADE_IN = 0.6;
/** The pad starts rising this long before the song ends. */
export const EXIT_LEAD = 3.0;
/** Fade applied to a song cut short by a region change. */
export const REGION_EXIT_FADE = 2.0;

/**
 * Stage 1: the "activity" of the arrangement steps aside — melody, plucked
 * arpeggio, percussion and tension drone. Pad and bass hold, so the bed thins
 * rather than dropping out, and the listener hears the texture open up rather
 * than the music stop.
 */
const THIN_OVERRIDE: BedOverride = {
  layerScale: { melody: 0, pluck: 0, perc: 0, tension: 0 },
};

export type InterludeStage = 'bed' | 'thinning' | 'pivot' | 'song' | 'exiting';

export type InterludeEventKind =
  | 'schedule'
  | 'skip'
  | 'thin'
  | 'pivot'
  | 'song-start'
  | 'pad-out'
  | 'exit'
  | 'bed-return'
  | 'resync';

/**
 * Injection points for the render harness. THE GAME NEVER SETS THESE.
 *
 * They exist so that a demonstration clip can exercise the real code path
 * instead of a reimplementation of it. Without `firstAt` a clip that shows the
 * handoff has to open with four minutes of bed; without `segments` it has to
 * play all 220 seconds of a song to reach the exit. Both would make the
 * evidence worse, not better — and faking the handoff in the harness would make
 * the evidence worthless.
 */
export interface InterludeOptions {
  /** Clock time of the first interlude. Default: the jittered cadence. */
  firstAt?: number;
  /** Replace segment definitions — used to render a 60 s excerpt of a song. */
  segments?: Partial<Record<SegmentId, SongSegment>>;
  /** Replace the rotation order. */
  rotation?: readonly SegmentId[];
}

export interface InterludeEvent {
  kind: InterludeEventKind;
  /** Pause-frozen interlude clock, ms-rounded so logs compare exactly. */
  clock: number;
  /** Absolute context time this event's audio effect lands. */
  at: number;
  segment?: SegmentId;
  /** Bar index the stage lands on, where the stage is bar-quantised. */
  bar?: number;
  detail?: string;
}

interface Handoff {
  segment: SongSegment;
  /** Pad tonic for the pivot, in the bed's own register. */
  tonicMidi: number;
  barThin: number;
  barPivot: number;
  barSong: number;
  thinIssued: boolean;
  pivotIssued: boolean;
  songIssued: boolean;
  padOutIssued: boolean;
  exitIssued: boolean;
  /** Set when the exit begins: the downbeat the bed comes back on. */
  barReturn: number;
  returnIssued: boolean;
  /** Why we are leaving, for the log. */
  exitReason: string;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export class InterludeController {
  private readonly _events: InterludeEvent[] = [];
  private _stage: InterludeStage = 'bed';
  private handoff: Handoff | null = null;
  private player: SongPlayer | null = null;

  /** Pause-frozen clock. The cadence is measured on this, never on nowS. */
  private clock = 0;
  private lastNow = -1;
  private nextInterludeAt = INTERLUDE_INTERVAL;
  private readonly rotation: readonly SegmentId[];
  private rotationIndex = 0;
  private interludeIndex = 0;
  private _resyncs = 0;
  private scheduledLogged = false;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly seed: number,
    private readonly sched: MusicScheduler,
    private readonly bus: MusicBus,
    private readonly library: SongLibrary,
    private readonly opts: InterludeOptions = {},
  ) {
    // The first interlude is jittered like every other one, so two worlds with
    // different seeds do not hear their first song at the same moment.
    this.nextInterludeAt = opts.firstAt ?? INTERLUDE_INTERVAL + this.jitter(0);
    this.rotation = opts.rotation ?? OVERWORLD_ROTATION;
  }

  /** The segment table, with any harness overrides applied. */
  private segment(id: SegmentId): SongSegment {
    return this.opts.segments?.[id] ?? SEGMENTS[id];
  }

  get stage(): InterludeStage {
    return this._stage;
  }

  get events(): readonly InterludeEvent[] {
    return this._events;
  }

  get currentSegment(): SegmentId | null {
    return this.handoff?.segment.id ?? null;
  }

  get clockS(): number {
    return this.clock;
  }

  get nextAt(): number {
    return this.nextInterludeAt;
  }

  get resyncs(): number {
    return this._resyncs;
  }

  /** Loop seams crossed by the current song — the dungeon-loop evidence. */
  get seams(): number {
    return this.player?.seams ?? 0;
  }

  // ------------------------------------------------------------------ update

  update(state: MusicState, nowS: number): void {
    this.advanceClock(state, nowS);
    this.duckForIntensity(state.intensity);

    const wanted = this.wantedSegment(state);

    if (this.handoff) {
      this.driveHandoff(state, nowS, wanted);
      this.player?.pump(nowS);
      return;
    }

    // No song in flight. Should one start?
    if (!wanted) return;

    const isRegionSong = REGION_SEGMENT[state.region] === wanted;
    const track = this.segment(wanted).song;

    // Requesting is idempotent and non-blocking. A region song is requested the
    // moment the region is entered; a rotation segment the moment its interlude
    // is first scheduled — which is what "lazily per region" means.
    this.library.request(track);

    if (!isRegionSong) {
      if (!this.scheduledLogged) {
        this.scheduledLogged = true;
        this.log('schedule', nowS, {
          segment: wanted,
          detail: `in ${round3(this.nextInterludeAt - this.clock)} s`,
        });
      }
      if (this.clock < this.nextInterludeAt) return;
    }

    const buffer = this.library.get(track);
    if (!buffer) {
      // Never block, never stall: the bed simply keeps playing.
      if (!isRegionSong) {
        this.nextInterludeAt = this.clock + INTERLUDE_RETRY;
        this.scheduledLogged = false;
        this.log('skip', nowS, { segment: wanted, detail: this.library.state(track) });
      }
      return;
    }

    this.begin(state, nowS, wanted, buffer);
  }

  // --------------------------------------------------------------- decisions

  /** Which segment belongs to this state, if any. */
  private wantedSegment(state: MusicState): SegmentId | null {
    const region = REGION_SEGMENT[state.region];
    if (region) return region;
    if (INTERLUDE_REGIONS.includes(state.region)) {
      return this.rotation[this.rotationIndex % this.rotation.length]!;
    }
    return null;
  }

  /**
   * Seeded jitter, +/- INTERLUDE_JITTER seconds. Deterministic in the seed and
   * the interlude index — no clock, no Math.random.
   */
  private jitter(index: number): number {
    const r = mulberry32(mix32(this.seed, index, salt('interlude-jitter')))();
    return (r * 2 - 1) * INTERLUDE_JITTER;
  }

  private advanceClock(state: MusicState, nowS: number): void {
    if (this.lastNow < 0) {
      this.lastNow = nowS;
      return;
    }
    const dt = nowS - this.lastNow;
    this.lastNow = nowS;
    // Same rule the bar grid uses: a jump this large means the tab was
    // backgrounded, and the missing seconds are not credited to the cadence.
    if (dt < 0 || dt > RESYNC_AFTER) {
      this._resyncs++;
      this.log('resync', nowS, { detail: `dt ${round3(dt)} s` });
      this.player?.resync(nowS);
      return;
    }
    if (!state.paused) this.clock += dt;
  }

  /** Combat takes the foreground; it never takes the music away. */
  private duckForIntensity(intensity: Intensity): void {
    const amount =
      intensity === 'boss' || intensity === 'combat' ? 1 : intensity === 'alert' ? 0.35 : 0;
    this.bus.duckSong(amount);
  }

  // ------------------------------------------------------------------ stages

  private begin(state: MusicState, nowS: number, id: SegmentId, buffer: AudioBuffer): void {
    const segment = this.segment(id);
    const track = SONGS[segment.song];
    const secPerBar = this.sched.secPerBarNow;

    // The thin fade needs a whole bar, and the scheduler cannot retune a bar it
    // has already planned, so the first stage lands a bar-and-a-bit out.
    const barThin = this.sched.barIndexAtOrAfter(nowS + secPerBar + 0.3);
    const handoff: Handoff = {
      segment,
      tonicMidi: nearestMidiForPc(track.tonicPc, REGION_CONFIG[state.region].tonicMidi),
      barThin,
      barPivot: barThin + 1,
      barSong: barThin + 2,
      thinIssued: false,
      pivotIssued: false,
      songIssued: false,
      padOutIssued: false,
      exitIssued: false,
      barReturn: -1,
      returnIssued: false,
      exitReason: '',
    };
    this.handoff = handoff;
    this._stage = 'thinning';
    this.scheduledLogged = false;

    this.player = new SongPlayer(this.ctx, this.bus.songInput(), buffer, segment, {
      gain: Math.pow(10, track.gainDb / 20),
    });
  }

  private driveHandoff(state: MusicState, nowS: number, wanted: SegmentId | null): void {
    const h = this.handoff!;
    const secPerBar = this.sched.secPerBarNow;

    // --- stage 1: thin -----------------------------------------------------
    if (!h.thinIssued) {
      const tThin = this.sched.predictBarTime(h.barThin);
      // The fade starts on the PREVIOUS downbeat, read from the grid rather
      // than computed as (tThin - secPerBar): bar lengths differ if the tempo
      // changed, and the subtraction is not bit-identical to the bar time,
      // which matters because the bus cancels automation at exactly this
      // instant (see MusicBus.reassertPast).
      const thinStart = this.sched.predictBarTime(h.barThin - 1);
      if (nowS + 0.05 >= thinStart) {
        const t0 = Math.max(nowS, thinStart);
        this.sched.setBedOverride(THIN_OVERRIDE, h.barThin, t0, tThin);
        h.thinIssued = true;
        this.log('thin', tThin, { segment: h.segment.id, bar: h.barThin });
      }
    }

    // --- stage 2: pivot ----------------------------------------------------
    if (h.thinIssued && !h.pivotIssued) {
      const tPivot = this.sched.predictBarTime(h.barPivot);
      const pivotStart = this.sched.predictBarTime(h.barPivot - 1);
      if (nowS + 0.05 >= pivotStart) {
        const t0 = Math.max(nowS, pivotStart);
        this.sched.setBedOverride(this.pivotOverride(h), h.barPivot, t0, tPivot);
        h.pivotIssued = true;
        this._stage = 'pivot';
        this.log('pivot', tPivot, {
          segment: h.segment.id,
          bar: h.barPivot,
          detail: `tonic ${h.tonicMidi}`,
        });
      }
    }

    // --- stage 3: the song -------------------------------------------------
    if (h.pivotIssued && !h.songIssued) {
      const tSong = this.sched.predictBarTime(h.barSong);
      if (nowS + 0.3 >= tSong) {
        // By now the bar is inside the planning horizon, so this is the exact
        // downbeat rather than a prediction.
        const at = this.sched.barTime(h.barSong) ?? tSong;
        this.player!.start(at);
        this.bus.fadeSong(1, at, at + SONG_FADE_IN);
        h.songIssued = true;
        this._stage = 'song';
        this.log('song-start', at, { segment: h.segment.id, bar: h.barSong });
      }
    }

    if (!h.songIssued) return;

    const songStart = this.player!.startedAt;

    // --- the pad steps out from under the head ----------------------------
    const padOverlap = h.segment.padOverlapS ?? PAD_OVERLAP;
    if (!h.padOutIssued && nowS + 0.05 >= songStart + padOverlap) {
      const t0 = Math.max(nowS, songStart + padOverlap);
      const barOut = this.sched.barIndexAtOrAfter(t0 + PAD_FADE);
      // Keep the pivoted tonic while the pad is still audible: `barOut` can
      // fall inside the fade, and reverting the key there would jump the pad's
      // pitch mid-fade — exactly the kind of small ugly seam this file exists
      // to avoid.
      this.sched.setBedOverride(
        { ...this.pivotOverride(h), layerScale: ZERO_BED },
        barOut,
        t0,
        t0 + PAD_FADE,
      );
      h.padOutIssued = true;
      this.log('pad-out', t0 + PAD_FADE, { segment: h.segment.id });
    }

    // --- exit --------------------------------------------------------------
    //
    // THE PAD MUST BE SOUNDING BEFORE THE SONG STOPS, and "sounding" means two
    // separate things that have to be arranged separately: its GAIN has to be
    // up, and it has to have NOTES. The gain is a continuous ramp and can start
    // anywhere; the notes only appear on a downbeat, because that is when the
    // arranger generates them and the scheduler will not revise a bar it has
    // already planned.
    //
    // Anchoring the rise to `now` got the first part right and the second
    // wrong: the gain came up on time, but if the song happened to end between
    // downbeats there were no pad notes yet to be heard through it, and the
    // render had a 170 ms hole exactly at the join. So the rise is anchored to
    // a BAR, and the lead is at least two bars, which guarantees the pad is at
    // full level with notes under it well before the song is gone.
    const regionChanged = wanted !== h.segment.id;
    const naturalEnd = this.player!.endsAt;
    const lead = Math.max(EXIT_LEAD, secPerBar * 2);
    const wantExit = regionChanged || nowS + 0.05 >= naturalEnd - lead - secPerBar;

    if (!h.exitIssued && wantExit) {
      h.exitReason = regionChanged ? `region wants ${wanted ?? 'bed'}` : 'song ended';

      // The pad rises IN THE SONG'S KEY, so it is consonant with the tail it is
      // rising under. It modulates home later, on the bed-return bar.
      const barRise = regionChanged
        ? this.sched.barIndexAtOrAfter(nowS + 0.3)
        : this.sched.barIndexAtOrAfter(naturalEnd - lead);
      const tRise = this.sched.predictBarTime(barRise);
      const t0 = Math.max(nowS, this.sched.predictBarTime(barRise - 1));
      this.sched.setBedOverride(this.pivotOverride(h), barRise, t0, tRise);

      // A song cut short by a region change is given a full bar of pad
      // underneath it before it goes, for the same reason.
      const songGone = regionChanged
        ? Math.max(this.sched.predictBarTime(barRise + 1), nowS + REGION_EXIT_FADE)
        : naturalEnd;
      if (regionChanged) this.player!.stop(nowS, songGone - nowS);

      this.bus.fadeSong(0, Math.max(t0, songGone - 0.4), songGone);
      h.barReturn = this.sched.barIndexAtOrAfter(songGone);
      h.exitIssued = true;
      this._stage = 'exiting';
      this.log('exit', songGone, {
        segment: h.segment.id,
        bar: h.barReturn,
        detail: h.exitReason,
      });
    }

    // --- the bed comes back on the next downbeat ---------------------------
    if (h.exitIssued && !h.returnIssued) {
      const tReturn = this.sched.predictBarTime(h.barReturn);
      const returnStart = this.sched.predictBarTime(h.barReturn - 1);
      if (nowS + 0.05 >= returnStart) {
        const t0 = Math.max(nowS, returnStart);
        this.sched.setBedOverride(null, h.barReturn, t0, tReturn);
        h.returnIssued = true;
        this.log('bed-return', tReturn, { segment: h.segment.id, bar: h.barReturn });
      }
    }

    // --- finished ----------------------------------------------------------
    if (h.returnIssued && nowS >= this.sched.predictBarTime(h.barReturn)) {
      this.finish();
    }
  }

  private finish(): void {
    const h = this.handoff;
    // A region song is chosen by where the player is standing: it consumes no
    // rotation slot and does not re-arm the cadence. Only a rotation segment
    // advances the wheel, which is what makes "never the same segment twice in
    // a row" structural rather than a rejection test.
    if (h && !REGION_SEGMENT_VALUES.includes(h.segment.id)) {
      this.rotationIndex++;
      this.interludeIndex++;
      this.nextInterludeAt = this.clock + INTERLUDE_INTERVAL + this.jitter(this.interludeIndex);
    }
    this.handoff = null;
    this.player = null;
    this._stage = 'bed';
    this.scheduledLogged = false;
  }

  private pivotOverride(h: Handoff): BedOverride {
    return {
      layerScale: PAD_ONLY,
      tonicMidi: h.tonicMidi,
      // 0 pins the pad to the song's tonic rather than to whatever degree the
      // region's progression is on.
      chordRoot: 0,
      // 'aeolian' is not a claim about the song's mode — it is how padBar is
      // told to voice root + FIFTH instead of root + third. An open fifth has
      // no third to clash with, so it is correct under a major song and a
      // minor one alike. See padBar in arranger.ts.
      mode: 'aeolian',
    };
  }

  private log(
    kind: InterludeEventKind,
    at: number,
    extra: { segment?: SegmentId; bar?: number; detail?: string } = {},
  ): void {
    this._events.push({
      kind,
      clock: round3(this.clock),
      at: round3(at),
      ...extra,
    });
    if (this._events.length > 256) this._events.shift();
  }
}

const PAD_ONLY: Partial<Record<LayerId, number>> = {
  bass: 0,
  melody: 0,
  pluck: 0,
  perc: 0,
  tension: 0,
};

const ZERO_BED: Partial<Record<LayerId, number>> = {
  pad: 0,
  bass: 0,
  melody: 0,
  pluck: 0,
  perc: 0,
  tension: 0,
};

const REGION_SEGMENT_VALUES: readonly SegmentId[] = Object.values(REGION_SEGMENT).filter(
  (v): v is SegmentId => v !== undefined,
);
