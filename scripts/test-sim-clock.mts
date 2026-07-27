/**
 * test-sim-clock.mts — the pause must stop the clock, not bank it.
 *
 *   npx tsx scripts/test-sim-clock.mts
 *
 * The bug this exists to prevent: a pause that only skips the step loop while
 * wall-clock time keeps accruing into the accumulator. It looks fine for a
 * two-second pause and is catastrophic for a two-minute one — the resume frame
 * tries to catch up every step it banked, which at 60 Hz is 7,200 steps of
 * hunger, AI and projectile integration between two rendered frames.
 *
 * So the assertions here are about STEP COUNTS across a long pause, not about
 * a boolean flag being true.
 */

import { SimClock } from '../src/game/sim-clock';

const DT = 1 / 60;
const MAX_ACCUM = 0.25;
/**
 * One frame of wall clock. Deliberately 16.7 and not 1000/60: a nominal
 * 16.6667 ms delta lands a fraction of a ULP SHORT of a whole step about half
 * the time, so a test written on it reports 0 steps for a frame that should
 * plainly run one, and 2 for the next. Real RAF timestamps jitter well past a
 * ULP; 16.7 is both realistic and unambiguous.
 */
const FRAME_MS = 16.7;

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

function eq(name: string, got: unknown, want: unknown): void {
  ok(name, Object.is(got, want), `got ${String(got)}, want ${String(want)}`);
}

/** Run `frames` of 60 Hz RAF from `t`, returning the steps each frame took. */
function runFrames(c: SimClock, t: number, frames: number): { t: number; steps: number[] } {
  const steps: number[] = [];
  for (let i = 0; i < frames; i++) {
    t += FRAME_MS;
    steps.push(c.advance(t));
  }
  return { t, steps };
}

// --- 1. baseline: a free-running clock steps once per 60 Hz frame -----------
{
  const c = new SimClock(0, DT, MAX_ACCUM);
  const r = runFrames(c, 0, 120);
  const total = r.steps.reduce((a, b) => a + b, 0);
  ok('60 Hz for 120 frames runs ~120 steps', total >= 118 && total <= 121, `${total}`);
  ok('no frame ever runs more than 2 steps', Math.max(...r.steps) <= 2,
    `max ${Math.max(...r.steps)}`);
  eq('not paused', c.paused, false);
  eq('nothing lost', c.lostMs, 0);
}

// --- 2. THE ONE THAT MATTERS: ten minutes paused, then resume --------------
{
  const c = new SimClock(0, DT, MAX_ACCUM);
  let t = 0;
  ({ t } = runFrames(c, t, 60)); // a second of normal play

  const pauseBeganAt = t;
  c.setPaused(true, t);
  eq('paused flag set', c.paused, true);

  // Ten minutes of RAF frames while paused — the browser keeps calling us.
  const paused = runFrames(c, t, 60 * 600);
  t = paused.t;
  const pausedSteps = paused.steps.reduce((a, b) => a + b, 0);
  eq('zero steps across a ten-minute pause', pausedSteps, 0);
  const span = t - pauseBeganAt;
  ok('lostMs tracks the pause while it is open',
    Math.abs(c.lostMs - span) < 1, `${c.lostMs.toFixed(0)} of ${span.toFixed(0)} ms`);

  c.setPaused(false, t);
  eq('resumed', c.paused, false);

  // The frame the game resumes on.
  const after = runFrames(c, t, 1);
  eq('first resumed frame steps exactly once', after.steps[0], 1);
  t = after.t;

  // And it stays normal.
  const settle = runFrames(c, t, 60);
  ok('no burst in the following second', Math.max(...settle.steps) <= 1,
    `max ${Math.max(...settle.steps)}`);
  const settleTotal = settle.steps.reduce((a, b) => a + b, 0);
  ok('following second runs ~60 steps', settleTotal >= 59 && settleTotal <= 61,
    `${settleTotal}`);
}

// --- 3. the failure mode, stated as arithmetic -----------------------------
{
  // If pause banked wall time, a 10 minute pause under MAX_ACCUM would still
  // dump the clamp's worth of steps — 0.25 s / (1/60) = 15 — into one frame.
  // Assert we are nowhere near that.
  const c = new SimClock(0, DT, MAX_ACCUM);
  c.setPaused(true, 0);
  c.advance(600_000);
  c.setPaused(false, 600_000);
  const steps = c.advance(600_000 + FRAME_MS);
  ok('resume after a pause with no frames still steps <= 1', steps <= 1, `${steps}`);
}

// --- 4. pause with the tab hidden (no advance() calls at all) --------------
{
  const c = new SimClock(0, DT, MAX_ACCUM);
  let t = 0;
  ({ t } = runFrames(c, t, 60));
  c.setPaused(true, t);
  // RAF stops entirely; the next thing that happens is the resume.
  t += 300_000;
  c.setPaused(false, t);
  ok('hidden-tab pause is still accounted', Math.abs(c.lostMs - 300_000) < 20,
    `${c.lostMs.toFixed(0)}`);
  const steps = c.advance(t + FRAME_MS);
  ok('and still cannot burst', steps <= 1, `${steps}`);
}

// --- 5. the clamp still protects an UNPAUSED stall -------------------------
{
  const c = new SimClock(0, DT, MAX_ACCUM);
  const steps = c.advance(30_000); // 30 s hidden tab, never paused
  eq('an unpaused stall is clamped to MAX_ACCUM', steps, Math.floor(MAX_ACCUM / DT));
}

// --- 6. idempotence and bookkeeping ---------------------------------------
{
  const c = new SimClock(1000, DT, MAX_ACCUM);
  c.setPaused(true, 1000);
  c.setPaused(true, 5000); // second pause must not restart the span
  c.setPaused(false, 6000);
  ok('double-pause does not double-count', Math.abs(c.lostMs - 5000) < 1, `${c.lostMs}`);
  c.setPaused(false, 9000); // redundant resume is a no-op
  ok('redundant resume changes nothing', Math.abs(c.lostMs - 5000) < 1, `${c.lostMs}`);
  c.setPaused(true, 10_000);
  c.setPaused(false, 11_000);
  ok('two pauses accumulate', Math.abs(c.lostMs - 6000) < 1, `${c.lostMs}`);
}

// --- 7. what a pause costs the simulation ---------------------------------
{
  // Resuming zeroes the accumulator, so a pause can discard at most the
  // sub-step remainder — under one step, i.e. under 17 ms of sim time.
  // Measured as: sim steps run over 10 s of wall clock, with and without a
  // pause in the middle.
  const free = new SimClock(0, DT, MAX_ACCUM);
  const a = runFrames(free, 0, 600);
  const freeSteps = a.steps.reduce((s, n) => s + n, 0);

  const paused = new SimClock(0, DT, MAX_ACCUM);
  let t = 0;
  let steps = 0;
  const r1 = runFrames(paused, t, 300);
  t = r1.t;
  steps += r1.steps.reduce((s, n) => s + n, 0);
  paused.setPaused(true, t);
  const r2 = runFrames(paused, t, 60 * 60); // a minute on the pause screen
  t = r2.t;
  steps += r2.steps.reduce((s, n) => s + n, 0);
  paused.setPaused(false, t);
  const r3 = runFrames(paused, t, 300);
  steps += r3.steps.reduce((s, n) => s + n, 0);

  ok('a pause costs at most one step of simulation',
    freeSteps - steps >= 0 && freeSteps - steps <= 1,
    `free ${freeSteps}, paused-then-resumed ${steps}`);
}

// --- 8. a clock going backwards cannot rewind the accumulator -------------
{
  const c = new SimClock(1000, DT, MAX_ACCUM);
  eq('backwards time yields no steps', c.advance(500), 0);
  // Not asserted as "exactly 1 on the next frame": a nominal 16.667 ms frame
  // lands a fraction of a ULP short of a whole step about half the time, so
  // one frame can legitimately produce 0 and the next 2. What must hold is
  // that no time is OWED — a second of frames is a second of steps.
  const r = runFrames(c, 500, 60);
  const total = r.steps.reduce((s, n) => s + n, 0);
  ok('and owes no time afterwards', total >= 59 && total <= 61, `${total}`);
}

process.stdout.write(`\nsim-clock: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
