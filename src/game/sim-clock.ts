/**
 * sim-clock.ts — the fixed-timestep accumulator, and the only place pause is
 * decided. Pure: no DOM, no GPU, node-testable.
 *
 * ## Why pause lives here and not as an `if` around the step loop
 *
 * The obvious pause is `if (!paused) while (accum >= dt) step()`. It is wrong,
 * and wrong in a way that only shows up after a long pause: the accumulator is
 * still being fed wall-clock time every frame, so the pause banks it. Thirty
 * seconds of menu becomes 1,800 steps queued for the frame you resume on —
 * a hitch, a physics tunnel, and 30 seconds of hunger and thirst drained
 * between one frame and the next. `MAX_ACCUM` caps that at 15 steps rather
 * than 1,800, which turns a catastrophe into a lurch; it does not fix it.
 *
 * So the clock stops instead of the stepping. `advance()` consumes the wall
 * time either way — it always moves `lastMs` — but while paused it drops the
 * delta on the floor rather than banking it. The accumulator keeps only the
 * sub-step remainder it had when the pause began, so the first resumed frame
 * sees exactly one frame of new time and takes at most one step.
 * `scripts/test-sim-clock.mts` pauses for ten minutes and asserts precisely
 * that.
 *
 * ## Two clocks, one pause
 *
 * Most of the game runs on `simTime`, which only advances inside the step loop
 * and therefore freezes for free. But a handful of systems are on wall clock —
 * resource-node respawn and jail sentences use `Date.now()` — and those would
 * keep running through a pause: come back after ten minutes and every ore vein
 * has respawned and your sentence is served. `lostMs` is the correction. It is
 * the total wall time spent paused, so `Date.now() - clock.lostMs` is a
 * monotonic epoch-ms clock that stops when the game does. Both clocks tick at
 * the same rate, so a `performance.now()`-derived offset is valid to subtract
 * from `Date.now()`.
 */

export class SimClock {
  /** Fixed simulation timestep (s). Steps are always exactly this long. */
  readonly dt: number;

  /** Sub-step remainder carried between frames (s). */
  private accum = 0;
  /** Clamp on a single frame's contribution — tab-switch stall protection. */
  private readonly maxAccum: number;
  /** Wall ms of the last `advance()` (or of the last pause toggle). */
  private lastMs: number;

  private pausedFlag = false;
  /** Wall ms at which the current pause began; meaningless while running. */
  private pausedAtMs = 0;
  /** Wall ms spent in *completed* pauses. */
  private lostClosedMs = 0;

  constructor(nowMs: number, dt: number, maxAccum: number) {
    this.dt = dt;
    this.maxAccum = maxAccum;
    this.lastMs = nowMs;
  }

  get paused(): boolean {
    return this.pausedFlag;
  }

  /**
   * Total wall ms the game has spent paused, including a pause in progress.
   * Subtract from `Date.now()` for any timer that must stop with the game.
   *
   * During a pause this grows as `advance()` is called each frame. If the tab
   * is hidden and RAF stops firing it goes stale, but nothing reads it in that
   * state and `setPaused(false)` closes the span against the true `nowMs`.
   */
  get lostMs(): number {
    return this.lostClosedMs + (this.pausedFlag ? this.lastMs - this.pausedAtMs : 0);
  }

  /**
   * Advance to `nowMs` and return how many fixed steps to run this frame.
   * Zero while paused, and zero-or-one on the frame a pause ends.
   */
  advance(nowMs: number): number {
    // performance.now() is monotonic, but a caller passing Date.now() across an
    // NTP correction is not: a negative delta would run the accumulator
    // backwards and desync the step count from `lastMs`.
    const wallDt = Math.max(0, nowMs - this.lastMs) / 1000;
    this.lastMs = nowMs;
    if (this.pausedFlag) return 0; // time passes; the game does not
    this.accum = Math.min(this.accum + wallDt, this.maxAccum);
    const steps = Math.floor(this.accum / this.dt);
    this.accum -= steps * this.dt;
    return steps;
  }

  /**
   * Pause or resume at `nowMs` (same time base as `advance`). Idempotent.
   *
   * Resuming ZEROES the accumulator rather than clamping it, which is what
   * makes the guarantee exact: the first resumed frame sees one frame of wall
   * time and nothing else, so it steps at most once. Clamping to one step is
   * not enough — a pause entered just under a step-boundary leaves a residue
   * of 0.99 dt, and 0.99 dt plus a fresh 16.7 ms frame is two steps. Two is
   * not a catastrophe, but "a pause can never make the next frame do extra
   * work" is a property worth being able to state without an asterisk.
   *
   * The cost is at most one discarded step — 16.7 ms of simulation per pause,
   * which no player and no test can see.
   */
  setPaused(on: boolean, nowMs: number): void {
    if (on === this.pausedFlag) return;
    if (on) {
      this.pausedAtMs = nowMs;
      this.pausedFlag = true;
    } else {
      this.lostClosedMs += Math.max(0, nowMs - this.pausedAtMs);
      this.pausedFlag = false;
      this.accum = 0;
    }
    this.lastMs = nowMs;
  }
}
