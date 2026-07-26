/**
 * Deterministic tests for the creature animation system
 * (src/game/anim/clip.ts, animator.ts, clip-set.ts, clips-*.ts,
 * creature-anim.ts). Pure CPU — no GPU, no server, no browser.
 *
 *   npx tsx scripts/test-anim.mts
 *
 * WHAT THIS FILE IS TRYING TO CATCH
 *
 * Written in the style of `test-gait.mts`, and for the same reason: every
 * failure mode of an animation system is silent. A clip that jumps once per
 * loop, an additive layer with a DC offset that slowly pushes a head off
 * centre, a crossfade that pops when interrupted, a phase rule that skates —
 * none of these throw, none fail a hash check, and none are visible in a still
 * frame. They cost an afternoon of screenshot hunting each.
 *
 * So the tests below try wherever possible to assert what must be TRUE rather
 * than what the code happens to do:
 *
 *   - a looping clip must join up with itself, or it twitches every cycle;
 *   - a blend must never leave the interval between its inputs, or bounded
 *     channels silently go out of range mid-transition;
 *   - an additive layer must average to zero, or the rest pose drifts;
 *   - a crossfade must emit exactly the previous frame on its first frame,
 *     from any state, including mid-fade — that is what "no pop" MEANS;
 *   - and the load-bearing one, section 9: a planted foot must be stationary
 *     in world space at EVERY stride amplitude, not just at full stride. That
 *     is a claim about physics, and it is the one the phase rule in
 *     `creature-anim.ts` exists to satisfy. Section 9 also demonstrates that
 *     the previous, amplitude-blind rule fails it — a test that cannot fail is
 *     not evidence of anything.
 */

import {
  Ch, CH_PLUMBED, CH_RANGE, Ease, NEUTRAL_POSE, addPose, blendPose, clampPose,
  copyPose, makePose, sampleClip, track, validateClip,
  type Clip, type PoseBuffer,
} from '../src/game/anim/clip';
import { Animator, hashUnit } from '../src/game/anim/animator';
import {
  ALL_STATES, FADE_IN, hold, layerClip, loopClip, resolveState, shotClip, sine,
  type AnimState, type ClipSet,
} from '../src/game/anim/clip-set';
import { QUADRUPED_CLIPS, QUADRUPED_ALL } from '../src/game/anim/clips-quadruped';
import { BIRD_CLIPS, BIRD_ALL, WINGED_CLIPS, WINGED_ALL } from '../src/game/anim/clips-winged';
import { SERPENT_CLIPS, SERPENT_ALL } from '../src/game/anim/clips-serpent';
import {
  DREAD_KING_CLIPS, GOBLIN_CLIPS, HUMANOID_ALL, SKELETON_CLIPS,
} from '../src/game/anim/clips-humanoid';
import {
  CreatureAnim, CreatureAnimRegistry, SWING_GAP, animConfig, animDebug, pickState,
} from '../src/game/anim/creature-anim';
import {
  ATTACK_ALL, ATTACK_MOVES, pickAttack,
} from '../src/game/anim/clips-attack';
import type { AnimalPose } from '../src/game/entities/animal-mesh';
import { footTarget, GAIT_AMBLE } from '../src/game/anim/gait';
import { animalGait, animalStride } from '../src/game/entities/animal-mesh';
import { wyvernStride } from '../src/game/entities/wyvern-mesh';
import { SPECIES_DEFS, type Species } from '../src/game/entities/entity-types';
import type { EntityMode, EntityState } from '../src/game/entities/entity-manager';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

const SETS: [string, ClipSet, readonly Clip[]][] = [
  ['quadruped', QUADRUPED_CLIPS, QUADRUPED_ALL],
  ['winged', WINGED_CLIPS, WINGED_ALL],
  ['bird', BIRD_CLIPS, BIRD_ALL],
  ['serpent', SERPENT_CLIPS, SERPENT_ALL],
  // The three enemy sets. `HUMANOID_ALL` holds every clip from all three and
  // is attached to the FIRST row only — the clip-list sweeps (loop continuity,
  // structural validity, additive zero-mean) iterate the third element, so
  // repeating it would count each humanoid clip three times and, in
  // particular, would triple the stepped-loop exemption tally below. The
  // per-set checks (state totality, distinctness) read the ClipSet in the
  // second element and are unaffected.
  ['goblin', GOBLIN_CLIPS, HUMANOID_ALL],
  ['skeleton', SKELETON_CLIPS, []],
  ['dread_king', DREAD_KING_CLIPS, []],
];

const CH_NAME = [
  'WalkAmp', 'HeadYaw', 'JawOpen', 'FlapAmp', 'FlapRate', 'BodySink',
  'HeadPitch', 'TailSway', 'ForeSwing',
];

// ---------------------------------------------------------------------------
// 1. Channel vocabulary is internally consistent.
// ---------------------------------------------------------------------------

{
  check('NEUTRAL_POSE has one entry per channel',
    NEUTRAL_POSE.length === Ch.COUNT);
  check('CH_RANGE has one entry per channel', CH_RANGE.length === Ch.COUNT);
  check('CH_PLUMBED has one entry per channel', CH_PLUMBED.length === Ch.COUNT);
  check('CH_NAME (test-side) has one entry per channel',
    CH_NAME.length === Ch.COUNT);

  // The neutral pose is what an unmentioned channel resolves to, so it had
  // better be legal — otherwise a sparse clip is out of range before it starts.
  let ok = true;
  for (let i = 0; i < Ch.COUNT; i++) {
    if (NEUTRAL_POSE[i] < CH_RANGE[i][0] || NEUTRAL_POSE[i] > CH_RANGE[i][1]) {
      ok = false;
    }
  }
  check('every neutral value is inside its own channel range', ok);

  // FlapRate is a multiplier: a neutral of 0 would stop every wing in the game
  // the moment a clip omitted the channel.
  check('neutral FlapRate is unity, not zero', NEUTRAL_POSE[Ch.FlapRate] === 1);
  check('every other neutral is zero',
    NEUTRAL_POSE.every((v, i) => i === Ch.FlapRate || v === 0));
}

// ---------------------------------------------------------------------------
// 2. Easing never overshoots, and every ease maps [0,1] onto [0,1].
//
//    This is what guarantees a sampled value stays between its two bracketing
//    keys. An ease that overshoots (a back- or elastic-style curve) would let
//    jawOpen go negative between two perfectly legal keys.
// ---------------------------------------------------------------------------

{
  const eases = [Ease.Linear, Ease.Smooth, Ease.In, Ease.Out, Ease.Step];
  let worstLo = 0, worstHi = 0, endpointsOk = true;
  for (const e of eases) {
    // One-shot, not looping: for a looping clip t == duration wraps to 0 by
    // definition, so it is the wrong probe for "does the last key read back".
    const c = shotClip('probe', 1, [track(Ch.HeadYaw, [[0, 0, e], [1, 1, e]])]);
    const p = makePose();
    for (let i = 0; i <= 200; i++) {
      sampleClip(c, i / 200, p);
      worstLo = Math.min(worstLo, p[Ch.HeadYaw]);
      worstHi = Math.max(worstHi, p[Ch.HeadYaw]);
    }
    sampleClip(c, 0, p);
    if (p[Ch.HeadYaw] !== 0) endpointsOk = false;
    sampleClip(c, 1, p);
    if (p[Ch.HeadYaw] !== 1) endpointsOk = false;
  }
  check('no easing undershoots below the start key', worstLo >= 0,
    `min ${worstLo}`);
  check('no easing overshoots past the end key', worstHi <= 1, `max ${worstHi}`);
  check('every easing hits both keys exactly at the key times', endpointsOk);

  // Step must actually hold — the whole point of it for bird head flicks.
  const stepped = shotClip('s', 1, [
    track(Ch.HeadYaw, [[0, 0, Ease.Step], [1, 1, Ease.Step]])]);
  const p = makePose();
  sampleClip(stepped, 0.99, p);
  check('Ease.Step holds its value right up to the next key',
    p[Ch.HeadYaw] === 0, `${p[Ch.HeadYaw]}`);
}

// ---------------------------------------------------------------------------
// 3. Sampling is bracketed by the keys and continuous in time.
// ---------------------------------------------------------------------------

{
  const c = loopClip('probe', 2, [track(Ch.HeadYaw, [
    [0, 0], [0.3, 0.9, Ease.In], [1.1, -0.4, Ease.Out], [1.6, 0.25], [2, 0],
  ])]);
  const p = makePose();
  let lo = Infinity, hi = -Infinity, maxJump = 0, prev = NaN;
  for (let i = 0; i <= 4000; i++) {
    sampleClip(c, (i / 4000) * 2, p);
    const v = p[Ch.HeadYaw];
    lo = Math.min(lo, v); hi = Math.max(hi, v);
    if (!Number.isNaN(prev)) maxJump = Math.max(maxJump, Math.abs(v - prev));
    prev = v;
  }
  check('sampled value never leaves the span of its keys',
    lo >= -0.4 - 1e-9 && hi <= 0.9 + 1e-9, `${lo.toFixed(4)}..${hi.toFixed(4)}`);
  // dt here is 1/2000 s; the steepest authored segment is 1.3 over 0.8 s, so a
  // continuous sampler cannot step more than ~0.002 per sample. Ten times that
  // is a generous bound that still catches a segment-lookup fencepost error.
  check('sampling is continuous in time (no lookup fencepost)', maxJump < 0.02,
    `largest step ${maxJump.toExponential(2)}`);
}

// ---------------------------------------------------------------------------
// 4. One-shot clips clamp at both ends; looping clips wrap.
// ---------------------------------------------------------------------------

{
  const one = shotClip('one', 1, [track(Ch.HeadYaw, [[0, 0.2], [1, 0.8]])]);
  const a = makePose(), b = makePose();
  sampleClip(one, -5, a); sampleClip(one, 0, b);
  check('one-shot clamps before the start', a[Ch.HeadYaw] === b[Ch.HeadYaw]);
  sampleClip(one, 99, a); sampleClip(one, 1, b);
  check('one-shot holds its final pose forever',
    a[Ch.HeadYaw] === b[Ch.HeadYaw] && near(a[Ch.HeadYaw], 0.8, 1e-7));

  const lp = loopClip('lp', 2, [track(Ch.HeadYaw, [[0, 0], [1, 0.5], [2, 0]])]);
  sampleClip(lp, 0.25, a); sampleClip(lp, 2.25, b);
  check('looping clip repeats exactly one duration later',
    near(a[Ch.HeadYaw], b[Ch.HeadYaw], 1e-9));
  sampleClip(lp, -0.25, a); sampleClip(lp, 1.75, b);
  check('looping clip wraps negative time correctly',
    near(a[Ch.HeadYaw], b[Ch.HeadYaw], 1e-9));
}

// ---------------------------------------------------------------------------
// 5. THE LOOP-CONTINUITY SWEEP.
//
//    Every looping clip in every library, on every channel, must join up with
//    itself. A clip whose last key disagrees with its first jumps once per
//    cycle — a twitch that is obvious in motion and completely invisible in
//    every still frame, so no screenshot harness will ever find it.
// ---------------------------------------------------------------------------

{
  const a = makePose(), b = makePose();
  let worst = 0, worstName = '', worstCh = -1;
  let count = 0, stepExempt = 0;
  for (const [, , clips] of SETS) {
    for (const c of clips) {
      if (!c.loop) continue;
      count++;
      sampleClip(c, c.duration - 1e-7, a);
      sampleClip(c, 0, b);
      // A track whose LAST segment is `Ease.Step` is a deliberate
      // discontinuity — that is what Step is for, and a bird's head flicking
      // at the loop point is one more flick, not a defect. Every other track
      // must join up.
      const stepped = new Set<number>();
      for (const tr of c.tracks) {
        const n = tr.keys.length / 3;
        if (n > 1 && tr.keys[(n - 2) * 3 + 2] === Ease.Step) stepped.add(tr.ch);
      }
      stepExempt += stepped.size;
      for (let i = 0; i < Ch.COUNT; i++) {
        if (stepped.has(i)) continue;
        const d = Math.abs(a[i] - b[i]);
        if (d > worst) { worst = d; worstName = c.name; worstCh = i; }
      }
    }
  }
  check(`all ${count} looping clips are continuous across the wrap`,
    worst < 1e-5,
    worstCh < 0 ? '' : `worst ${worstName}.${CH_NAME[worstCh]} gap ${worst.toExponential(2)}`);
  // The exemption must be narrow, or it silences the test it lives inside.
  check('only a handful of tracks claim the stepped-loop exemption',
    stepExempt > 0 && stepExempt <= 6, `${stepExempt} exempt tracks`);

  // Stepped or not, EVERY looping track must still close on VALUE — that rule
  // has no exemption, and validateClip enforces it (section 6).
  {
    let closed = true;
    for (const [, , clips] of SETS) {
      for (const c of clips) {
        if (!c.loop) continue;
        for (const tr of c.tracks) {
          const n = tr.keys.length / 3;
          if (n > 1 && Math.abs(tr.keys[1] - tr.keys[(n - 1) * 3 + 1]) > 1e-6) {
            closed = false;
          }
        }
      }
    }
    check('every looping track closes on value, with no exemptions', closed);
  }
}

// ---------------------------------------------------------------------------
// 6. Every clip in every library is structurally valid and in range.
// ---------------------------------------------------------------------------

{
  const errs: string[] = [];
  let clipCount = 0;
  for (const [set, , clips] of SETS) {
    for (const c of clips) {
      clipCount++;
      for (const e of validateClip(c)) errs.push(`${set}/${e}`);
    }
  }
  check(`all ${clipCount} clips pass structural validation`, errs.length === 0,
    errs.slice(0, 4).join('; '));

  // Values in range, sampled densely rather than only at keys — easing between
  // two legal keys is bracketed (test 2), but a track authored on the wrong
  // channel would only show up here.
  const p = makePose();
  const bad: string[] = [];
  for (const [, , clips] of SETS) {
    for (const c of clips) {
      if (c.additive) continue; // additive values are deltas, not poses
      for (let i = 0; i <= 120; i++) {
        sampleClip(c, (i / 120) * c.duration, p);
        for (let k = 0; k < Ch.COUNT; k++) {
          if (p[k] < CH_RANGE[k][0] - 1e-9 || p[k] > CH_RANGE[k][1] + 1e-9) {
            bad.push(`${c.name}.${CH_NAME[k]}=${p[k].toFixed(3)}`);
          }
        }
      }
    }
  }
  check('every absolute clip stays inside every channel range',
    bad.length === 0, [...new Set(bad)].slice(0, 4).join(', '));
}

// ---------------------------------------------------------------------------
// 7. Additive layers: zero mean, and they cannot push a clip out of range.
// ---------------------------------------------------------------------------

{
  // (a) Zero mean. An additive layer with a DC offset does not oscillate around
  //     the pose it is layered onto — it MOVES it, permanently. The head would
  //     sit slightly turned in every clip, the rest pose the author placed
  //     would never actually be seen, and the cause would be invisible.
  const p = makePose();
  let worstMean = 0, worstName = '', worstCh = -1;
  for (const [, set] of SETS) {
    const layer = set.idleLayer;
    const sum = new Float64Array(Ch.COUNT);
    const N = 2000;
    for (let i = 0; i < N; i++) {
      sampleClip(layer, (i / N) * layer.duration, p);
      for (let k = 0; k < Ch.COUNT; k++) sum[k] += p[k];
    }
    for (let k = 0; k < Ch.COUNT; k++) {
      const mean = Math.abs(sum[k] / N);
      if (mean > worstMean) { worstMean = mean; worstName = layer.name; worstCh = k; }
    }
  }
  check('every additive idle layer has zero mean on every channel',
    worstMean < 2e-3,
    worstCh < 0 ? '' : `worst ${worstName}.${CH_NAME[worstCh]} mean ${worstMean.toExponential(2)}`);

  // (b) Additive identity really is the identity.
  const base = makePose();
  base[Ch.HeadYaw] = 0.4; base[Ch.WalkAmp] = 0.7;
  const before = Float32Array.from(base);
  const zero = makePose();
  zero.fill(0);
  addPose(base, zero, 1);
  check('adding the additive identity changes nothing',
    base.every((v, i) => v === before[i]));

  // (c) THE COMPOSITION TEST. Layering must not push a bounded channel out of
  //     range. This is the failure the range table exists to catch: nothing
  //     crashes, jawOpen just quietly goes slightly negative and the jaw hinges
  //     back through the skull for two frames a second.
  //
  //     `dead` is exempt because the driver removes the layer for corpses —
  //     see `CreatureAnim.update`. Checked separately below.
  const layerBuf = makePose();
  const bad: string[] = [];
  for (const [, set, clips] of SETS) {
    for (const c of clips) {
      if (c.additive) continue;
      if (c.name.endsWith('_dead')) continue;
      for (let i = 0; i <= 60; i++) {
        sampleClip(c, (i / 60) * c.duration, p);
        for (let j = 0; j <= 60; j++) {
          sampleClip(set.idleLayer, (j / 60) * set.idleLayer.duration, layerBuf);
          for (let k = 0; k < Ch.COUNT; k++) {
            const v = p[k] + layerBuf[k];
            if (v < CH_RANGE[k][0] - 1e-6 || v > CH_RANGE[k][1] + 1e-6) {
              bad.push(`${c.name}.${CH_NAME[k]}=${v.toFixed(3)}`);
            }
          }
        }
      }
    }
  }
  check('no clip plus its idle layer ever leaves a channel range',
    bad.length === 0, [...new Set(bad)].slice(0, 5).join(', '));

  // (d) The generated sine helper closes its loop exactly and is mean-zero by
  //     construction — this is what makes (a) and (c) hold rather than luck.
  for (const cycles of [1, 2, 3, 5]) {
    const t = sine(Ch.HeadYaw, 0.5, cycles, 12, 0.31);
    const c = layerClip('gen', 12, [t]);
    sampleClip(c, 0, p);
    const first = p[Ch.HeadYaw];
    sampleClip(c, 12, p);
    check(`sine(${cycles} cycles) closes its loop exactly`,
      near(first, p[Ch.HeadYaw], 1e-7));
  }
}

// ---------------------------------------------------------------------------
// 8. Blending: convex, exact at the endpoints, and never overshoots.
// ---------------------------------------------------------------------------

{
  const a = makePose(), b = makePose(), out = makePose();
  for (let i = 0; i < Ch.COUNT; i++) {
    a[i] = Math.sin(i * 1.7) * 0.6;
    b[i] = Math.cos(i * 2.3) * 0.9;
  }

  blendPose(a, b, 0, out);
  check('blend at w=0 returns the first pose bit for bit',
    out.every((v, i) => v === a[i]));
  blendPose(a, b, 1, out);
  check('blend at w=1 returns the second pose bit for bit',
    out.every((v, i) => v === b[i]));

  // THE blend invariant. "Weights sum to one" is only interesting because of
  // what it guarantees: the result is a genuine interpolation and can never
  // leave the interval spanned by its inputs. If it could, a crossfade between
  // two in-range poses could produce an out-of-range one.
  let escapes = 0, worstEscape = 0;
  for (let s = 0; s <= 500; s++) {
    const w = s / 500;
    blendPose(a, b, w, out);
    for (let i = 0; i < Ch.COUNT; i++) {
      const lo = Math.min(a[i], b[i]), hi = Math.max(a[i], b[i]);
      if (out[i] < lo - 1e-9 || out[i] > hi + 1e-9) {
        escapes++;
        worstEscape = Math.max(worstEscape,
          Math.max(lo - out[i], out[i] - hi));
      }
    }
  }
  check('a blend NEVER leaves the interval between its two inputs',
    escapes === 0, `${escapes} escapes, worst ${worstEscape.toExponential(2)}`);

  // Monotone in w, per channel — so a crossfade cannot double back on itself.
  let mono = true;
  const prev = makePose();
  blendPose(a, b, 0, prev);
  for (let s = 1; s <= 200; s++) {
    blendPose(a, b, s / 200, out);
    for (let i = 0; i < Ch.COUNT; i++) {
      const dir = Math.sign(b[i] - a[i]);
      if (dir !== 0 && Math.sign(out[i] - prev[i]) === -dir) mono = false;
    }
    copyPose(prev, out);
  }
  check('a blend moves monotonically from a toward b', mono);

  // Symmetry: blending the other way with the complementary weight agrees.
  const rev = makePose();
  let worstSym = 0;
  for (let s = 0; s <= 100; s++) {
    const w = s / 100;
    blendPose(a, b, w, out);
    blendPose(b, a, 1 - w, rev);
    for (let i = 0; i < Ch.COUNT; i++) {
      worstSym = Math.max(worstSym, Math.abs(out[i] - rev[i]));
    }
  }
  check('blending is symmetric under (a,b,w) -> (b,a,1-w)', worstSym < 1e-7,
    `worst ${worstSym.toExponential(2)}`);

  // clampPose is idempotent, and leaves an in-range pose alone.
  const p = makePose();
  for (let i = 0; i < Ch.COUNT; i++) p[i] = CH_RANGE[i][1] * 5 - 3;
  clampPose(p);
  const once = Float32Array.from(p);
  clampPose(p);
  check('clampPose is idempotent', p.every((v, i) => v === once[i]));
}

// ---------------------------------------------------------------------------
// 9. *** THE PHYSICS TEST ***
//
//    A planted foot is stationary in WORLD space. The mesh builder scales its
//    stride by walkAmp:
//
//        stride_metres = animalStride(species) * walkAmp
//
//    so keeping the foot still requires the gait phase to advance by
//
//        dPhase = 2*pi * dDistance / (animalStride * walkAmp)
//
//    at EVERY amplitude. The old rule dropped the walkAmp term, which was
//    survivable only because walkAmp was a step function pinned at 1 or 0.
//    Crossfading makes it continuous, so this had to be fixed before blending
//    could ship — otherwise the flagship feature would have been the direct
//    cause of a locomotion regression.
//
//    9a asserts the new rule keeps the foot planted at every amplitude.
//    9b asserts the OLD rule does not, because a test that cannot fail proves
//    nothing.
// ---------------------------------------------------------------------------

{
  const duty = GAIT_AMBLE.duty;

  /** March a body forward at `v` m/s and report the worst world-space drift
   *  of a planted foot, integrating phase by the supplied rule. */
  function skate(
    stride: number, amp: number, v: number,
    rule: (dD: number, amp: number) => number,
  ): number {
    const dt = 1 / 120;
    let phase = 0;
    let travelled = 0;
    let worst = 0;
    let lastWorld = NaN;
    let lastPlanted = 0;
    for (let i = 0; i < 4000; i++) {
      const dD = v * dt;
      phase += rule(dD, amp);
      travelled += dD;
      const f = footTarget(phase, stride * amp, 0.2, duty);
      // Forward is -Z, so a body that has advanced `travelled` puts a
      // body-local z at world z - travelled.
      const world = f.z - travelled;
      if (f.planted === 1 && lastPlanted === 1 && !Number.isNaN(lastWorld)) {
        worst = Math.max(worst, Math.abs(world - lastWorld));
      }
      lastWorld = world;
      lastPlanted = f.planted;
    }
    return worst;
  }

  const newRule = (dD: number, amp: number): number =>
    (dD / (1.2 * amp)) * Math.PI * 2;
  const oldRule = (dD: number): number => (dD / 1.2) * Math.PI * 2;

  // 9a — the rule shipped in creature-anim.ts.
  let worstNew = 0;
  for (const amp of [1, 0.85, 0.6, 0.4, 0.25, 0.16]) {
    for (const v of [0.5, 2, 6]) {
      worstNew = Math.max(worstNew, skate(1.2, amp, v, newRule));
    }
  }
  check('PLANTED FOOT IS STATIONARY AT EVERY STRIDE AMPLITUDE (no skating)',
    worstNew < 1e-9,
    `worst per-frame world drift ${worstNew.toExponential(2)} m`);

  // 9b — the amplitude-blind rule this replaced. At full amplitude it is
  // correct (both rules coincide); below it, the foot creeps.
  const full = skate(1.2, 1, 2, oldRule);
  const half = skate(1.2, 0.5, 2, oldRule);
  check('the old amplitude-blind rule is correct at full stride', full < 1e-9,
    `${full.toExponential(2)} m`);
  check('the old amplitude-blind rule SKATES below full stride — this is the '
    + 'bug the walkAmp term fixes', half > 1e-4,
    `drift ${half.toExponential(2)} m/frame at amp 0.5`);

  // 9c — and the creep is proportional to (1 - amp) of body speed, which is
  // exactly the failure mode `gait.ts` documents. At amp 0.5 and 2 m/s over
  // 1/120 s the foot should slip about (1 - 0.5) * 2 / 120 = 8.3 mm a frame.
  check('the old rule creeps at (1-amp) of body speed, as gait.ts predicts',
    Math.abs(half - 0.5 * 2 / 120) < 5e-4,
    `measured ${(half * 1000).toFixed(2)} mm/frame, predicted 8.33 mm`);
}

// ---------------------------------------------------------------------------
// 10. Speed -> stride amplitude: the biomechanics must come out right.
//
//     Both stride LENGTH and CADENCE increase with speed in a real animal.
//     A law that got either backwards would look wrong in a way no unit test
//     of the code-as-written would notice.
// ---------------------------------------------------------------------------

{
  const vRef = 4.5;           // deer
  const stride = 1.2;         // metres per cycle at full amplitude
  const amp = (v: number): number => Math.min(1, Math.sqrt(Math.max(0, v) / vRef));
  const cadence = (v: number): number => v / (stride * Math.max(0.16, amp(v)));

  check('amplitude is zero at zero speed', amp(0) === 0);
  check('amplitude saturates at the reference speed', near(amp(vRef), 1, 1e-12));
  check('amplitude never exceeds one above the reference speed',
    amp(vRef * 4) === 1);

  let ampMono = true, cadMono = true;
  let prevA = -1, prevC = -1;
  for (let i = 1; i <= 400; i++) {
    const v = (i / 400) * vRef;
    const A = amp(v), C = cadence(v);
    if (A < prevA - 1e-12) ampMono = false;
    if (C < prevC - 1e-12) cadMono = false;
    prevA = A; prevC = C;
  }
  check('stride length increases with speed', ampMono);
  check('cadence also increases with speed (not just stride length)', cadMono);

  // The characteristic signature of sqrt scaling: doubling speed multiplies
  // both stride and cadence by sqrt(2), not one by 2 and the other by 1.
  check('doubling speed scales stride by ~sqrt(2)',
    near(amp(2) / amp(1), Math.SQRT2, 1e-9));
  check('doubling speed scales cadence by ~sqrt(2)',
    near(cadence(2) / cadence(1), Math.SQRT2, 1e-9));
}

// ---------------------------------------------------------------------------
// 11. Animator crossfade — the anti-pop invariants.
// ---------------------------------------------------------------------------

{
  const A = loopClip('A', 1, [hold(Ch.HeadYaw, 0.8, 1), hold(Ch.WalkAmp, 1, 1)]);
  const B = loopClip('B', 1, [hold(Ch.HeadYaw, -0.9, 1), hold(Ch.WalkAmp, 0, 1)]);
  const C = loopClip('C', 1, [hold(Ch.HeadYaw, 0.3, 1), hold(Ch.WalkAmp, 0.5, 1)]);

  // (a) THE invariant, exactly. Calling play() must not change the pose. With
  //     dt = 0 the fade has not advanced and neither has the layer clock, so
  //     the very next sample must be the previous frame bit for bit — from any
  //     state, including halfway through another fade.
  {
    const an = new Animator('e1', A);
    an.setIdleLayer(QUADRUPED_CLIPS.idleLayer, 1);
    const before = makePose();
    let worst = 0;
    const seq: Clip[] = [B, C, A, B, A, C, C, B];
    for (let step = 0; step < seq.length; step++) {
      // Advance a random-ish amount so interruptions land at every fade phase.
      for (let f = 0; f < 1 + (step % 5); f++) an.update(1 / 60);
      copyPose(before, an.update(1 / 60));
      an.play(seq[step], 0.22);
      const after = an.update(0);
      for (let i = 0; i < Ch.COUNT; i++) {
        worst = Math.max(worst, Math.abs(after[i] - before[i]));
      }
    }
    check('CROSSFADE IS EXACTLY CONTINUOUS AT ITS START, even when it '
      + 'interrupts another crossfade', worst === 0,
      `worst discontinuity ${worst.toExponential(2)}`);
  }

  // (b) Continuous at the END: once the fade completes the animator emits the
  //     new clip and nothing else, so there is no residue of the old pose.
  {
    const an = new Animator('e2', A);
    an.update(1 / 60);
    an.play(B, 0.2);
    for (let f = 0; f < 60; f++) an.update(1 / 60);
    const out = an.update(1 / 60);
    check('a completed crossfade emits the new clip exactly',
      near(out[Ch.HeadYaw], -0.9, 1e-6) && near(out[Ch.WalkAmp], 0, 1e-6),
      `headYaw ${out[Ch.HeadYaw].toFixed(6)}`);
    check('a completed crossfade reports full progress',
      an.fadeProgress === 1);
  }

  // (c) Crossfading actually removes the pop. Same transition, fade 0 vs 0.22.
  {
    const run = (fade: number): number => {
      const an = new Animator('e3', A);
      let worst = 0;
      let prev: PoseBuffer | null = null;
      for (let f = 0; f < 120; f++) {
        if (f === 30) an.play(B, fade);
        if (f === 60) an.play(C, fade);
        if (f === 90) an.play(A, fade);
        const out = an.update(1 / 60);
        if (prev !== null) {
          for (let i = 0; i < Ch.COUNT; i++) {
            worst = Math.max(worst, Math.abs(out[i] - prev[i]));
          }
        } else prev = makePose();
        copyPose(prev, out);
      }
      return worst;
    };
    const snapped = run(0);
    const faded = run(0.22);
    // The largest channel gap between any two of A/B/C is 1.7 (HeadYaw
    // 0.8 -> -0.9). Snapping crosses that in ONE frame; a smoothstep fade is
    // rate-limited to at most 1.5 * gap * dt / fadeDur per frame, and that
    // bound — not an arbitrary threshold — is the thing worth asserting,
    // because it says the transition can never move faster than its own
    // declared duration allows.
    const gap = 1.7;
    const bound = 1.5 * gap * (1 / 60) / 0.22;
    check('with no fade the transition IS a pop, crossing the gap in a frame',
      snapped > gap * 0.9, `largest per-frame jump ${snapped.toFixed(3)}`);
    check('a crossfade is rate-limited by its own duration',
      faded <= bound * 1.02,
      `largest per-frame jump ${faded.toFixed(4)}, smoothstep bound ${bound.toFixed(4)}`);
    check('crossfading is many times smoother than snapping',
      faded * 8 < snapped, `${faded.toFixed(4)} vs ${snapped.toFixed(4)}`);
  }

  // (d) Re-playing the clip already playing must NOT restart it. A state
  //     machine that calls play() unconditionally every frame would otherwise
  //     pin the clip at frame zero forever — and it would look like the
  //     animation system simply does not work.
  {
    const moving = loopClip('mv', 2, [
      track(Ch.HeadYaw, [[0, 0], [1, 1], [2, 0]])]);
    const an = new Animator('e4', moving);
    for (let f = 0; f < 30; f++) { an.play(moving, 0.2); an.update(1 / 60); }
    const out = an.update(1 / 60);
    check('replaying the current clip does not restart it',
      out[Ch.HeadYaw] > 0.3, `headYaw ${out[Ch.HeadYaw].toFixed(3)}`);
  }

  // (e) A one-shot reports finished exactly once its duration has elapsed, and
  //     a loop never does.
  {
    const one = shotClip('one', 0.5, [hold(Ch.HeadYaw, 0.5, 0.5)]);
    const an = new Animator('e5', one);
    check('a fresh one-shot is not finished', !an.finished);
    for (let f = 0; f < 31; f++) an.update(1 / 60);
    check('a one-shot reports finished after its duration', an.finished);
    const an2 = new Animator('e6', A);
    for (let f = 0; f < 600; f++) an2.update(1 / 60);
    check('a looping clip never reports finished', !an2.finished);
  }

  // (f) snap() jumps with no blend at all.
  {
    const an = new Animator('e7', A);
    an.update(1 / 60);
    an.snap(B);
    const out = an.update(0);
    check('snap() applies the new pose immediately',
      near(out[Ch.HeadYaw], -0.9, 1e-6));
  }

  // (g) Output is always in range, even mid-fade with the layer applied.
  {
    const an = new Animator('e8', QUADRUPED_CLIPS.clips.idle);
    an.setIdleLayer(QUADRUPED_CLIPS.idleLayer, 1);
    const states: AnimState[] = ['walk', 'run', 'attack', 'graze', 'flee', 'sit'];
    let bad = 0;
    for (let f = 0; f < 900; f++) {
      if (f % 37 === 0) {
        const s = states[(f / 37) % states.length];
        an.play(resolveState(QUADRUPED_CLIPS, s), FADE_IN[s]);
      }
      const out = an.update(1 / 60);
      for (let i = 0; i < Ch.COUNT; i++) {
        if (out[i] < CH_RANGE[i][0] - 1e-6 || out[i] > CH_RANGE[i][1] + 1e-6) bad++;
      }
    }
    check('animator output is always in range through a long state churn',
      bad === 0, `${bad} out-of-range samples`);
  }

  // (h) Wing phase integrates monotonically and responds to FlapRate smoothly.
  {
    const slow = loopClip('slow', 1, [hold(Ch.FlapRate, 0.4, 1)]);
    const fast = loopClip('fast', 1, [hold(Ch.FlapRate, 2.5, 1)]);
    const an = new Animator('e9', slow);
    let prevPhase = an.flapPhase;
    let mono = true, worstStep = 0, prevStep = -1;
    let jump = 0;
    for (let f = 0; f < 240; f++) {
      if (f === 60) an.play(fast, 0.3);
      an.update(1 / 60, 2.4);
      const step = an.flapPhase - prevPhase;
      if (step < -1e-12) mono = false;
      worstStep = Math.max(worstStep, step);
      if (prevStep >= 0) jump = Math.max(jump, Math.abs(step - prevStep));
      prevStep = step;
      prevPhase = an.flapPhase;
    }
    check('wing phase never runs backwards', mono);
    // Because the rate is taken from the BLENDED pose, the per-frame step must
    // ramp rather than step. A `sin(t * rate)` formulation would teleport the
    // wings the instant the rate changed; integrating cannot.
    check('a wing-rate change ramps the beat instead of teleporting it',
      jump < worstStep * 0.15,
      `largest step change ${jump.toExponential(2)} vs step ${worstStep.toExponential(2)}`);
  }
}

// ---------------------------------------------------------------------------
// 12. Clip sets are total: every state resolves, for every body plan.
// ---------------------------------------------------------------------------

{
  let total = true;
  const missing: string[] = [];
  for (const [name, set] of SETS) {
    for (const s of ALL_STATES) {
      const c = resolveState(set, s);
      if (c === undefined || c === null) { total = false; missing.push(`${name}/${s}`); }
    }
  }
  check('every animation state resolves to a clip in every body plan', total,
    missing.join(', '));

  // Fallbacks must be POSTURAL neighbours, not just "anything". A gliding
  // griffin that falls back to `idle` snaps upright in mid-air.
  check('glide falls back to a flying pose, never to standing',
    resolveState(BIRD_CLIPS, 'glide') !== BIRD_CLIPS.clips.idle);

  // Every state has a declared fade-in time.
  check('every state has a crossfade duration',
    ALL_STATES.every(s => typeof FADE_IN[s] === 'number' && FADE_IN[s] > 0));
  // Attacks must not spend a large fraction of the clip fading in.
  for (const [name, set] of SETS) {
    const atk = set.clips.attack;
    if (atk === undefined) continue;
    check(`${name}: the attack fade is short next to the attack itself`,
      FADE_IN.attack < atk.duration * 0.25,
      `${FADE_IN.attack}s fade into a ${atk.duration}s clip`);
  }
}

// ---------------------------------------------------------------------------
// 13. State selection is total and sane.
// ---------------------------------------------------------------------------

{
  const modes: EntityMode[] = ['idle', 'graze', 'wander', 'flee', 'aggro', 'dead', 'follow'];
  const speciesList = Object.keys(SPECIES_DEFS) as Species[];
  let deadAlways = true, movingNeverIdle = true, allResolve = true;
  for (const sp of speciesList) {
    for (const m of modes) {
      for (const v of [0, 0.05, 0.5, 3, 20]) {
        for (const sit of [0, 1]) {
          for (const melee of [false, true]) {
            const s = pickState(m, sp, v, sit, 0, melee, null);
            if (!ALL_STATES.includes(s)) allResolve = false;
            if (m === 'dead' && s !== 'dead') deadAlways = false;
            if (m !== 'dead' && sit === 0 && v > 1 && s === 'idle') {
              movingNeverIdle = false;
            }
          }
        }
      }
    }
  }
  check('pickState always returns a known state', allResolve);
  check('a dead creature is always dead, whatever else is true', deadAlways);
  check('a moving creature is never given a standing clip', movingNeverIdle);

  check('a fast creature runs and a slow one walks',
    pickState('wander', 'deer', 4.4, 0, 0, false, null) === 'run' &&
    pickState('wander', 'deer', 1.0, 0, 0, false, null) === 'walk');
  check('fleeing has its own clip even at running speed',
    pickState('flee', 'deer', 6, 0, 0, false, null) === 'flee');
  check('a stationary grazer grazes',
    pickState('graze', 'cow', 0, 0, 0, false, null) === 'graze');
  check('a predator in melee range holds still and watches',
    pickState('aggro', 'wolf', 0, 0, 0, true, null) === 'alert');
  check('a long sit becomes sleep',
    pickState('idle', 'horse', 0, 1, 30, false, null) === 'sleep' &&
    pickState('idle', 'horse', 0, 1, 2, false, null) === 'sit');
  check('an explicit flight state overrides everything but death',
    pickState('wander', 'dragon', 5, 0, 0, false, 'glide') === 'glide' &&
    pickState('dead', 'dragon', 5, 0, 0, false, 'glide') === 'dead');

  // The regression this fixes: `follow` had no entry in the old mode lookup,
  // so owned animals and ridden mounts rendered with walkAmp 0 — sliding along
  // with dead legs. Speed-driven selection cannot have that hole.
  check('follow mode animates (the old mode lookup had no entry for it)',
    pickState('follow', 'horse', 3, 0, 0, false, null) === 'walk');
}

// ---------------------------------------------------------------------------
// 14. Deterministic per-entity decorrelation.
// ---------------------------------------------------------------------------

{
  check('hashUnit is in [0,1)', ['a', 'deer_17', '', 'x'.repeat(64)]
    .every(id => hashUnit(id) >= 0 && hashUnit(id) < 1));
  check('hashUnit is deterministic', hashUnit('deer_17') === hashUnit('deer_17'));
  check('different ids hash differently', hashUnit('deer_17') !== hashUnit('deer_18'));

  // Well-spread, not merely different. A hash that clumped would put a whole
  // herd within a few degrees of the same phase, which is visually identical
  // to no decorrelation at all.
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 400; i++) {
    buckets[Math.min(9, Math.floor(hashUnit(`deer_${i}`) * 10))]++;
  }
  check('entity phases fill every decile (no clumping)',
    buckets.every(b => b > 10), buckets.join(','));

  // And the practical consequence: a herd must not move in lockstep.
  //
  // Measured as SPREAD ACROSS THE HERD over time, not as pairwise difference.
  // Two individuals can share one channel's phase by chance — with eight
  // animals and a four-second breathing period that is not just possible, it
  // is expected, and real herds do it too. What must never happen is the whole
  // group moving as one, and the signature of that is a spread of zero.
  const N_HERD = 8;
  const anims: Animator[] = [];
  for (let i = 0; i < N_HERD; i++) {
    const an = new Animator(`deer_${i}`, QUADRUPED_CLIPS.clips.idle);
    an.setIdleLayer(QUADRUPED_CLIPS.idleLayer, 1);
    anims.push(an);
  }
  const AMP = 0.009;            // the layer's breathing amplitude
  let spreadSum = 0;
  const frames = 600;           // 10 s, well over two breathing periods
  const traces: number[][] = anims.map(() => []);
  for (let f = 0; f < frames; f++) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < N_HERD; i++) {
      const v = anims[i].update(1 / 60)[Ch.BodySink];
      traces[i].push(v);
      lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
    spreadSum += hi - lo;
  }
  const meanSpread = spreadSum / frames;
  check('a herd does not breathe in unison',
    meanSpread > AMP * 0.8,
    `mean spread ${meanSpread.toExponential(2)} of amplitude ${AMP}`);

  // And no two individuals are literally the same animation: over ten seconds
  // every pair must differ somewhere, on some channel.
  let twins = 0;
  for (let i = 0; i < N_HERD; i++) {
    for (let j = i + 1; j < N_HERD; j++) {
      let worst = 0;
      for (let f = 0; f < frames; f++) {
        worst = Math.max(worst, Math.abs(traces[i][f] - traces[j][f]));
      }
      if (worst < 1e-6) twins++;
    }
  }
  check('no two individuals run the identical idle animation', twins === 0,
    `${twins} identical pairs`);
}

// ---------------------------------------------------------------------------
// 15. The per-entity driver.
// ---------------------------------------------------------------------------

function ent(over: Partial<EntityState> = {}): EntityState {
  return {
    id: 'test_1', species: 'deer', x: 0, y: 0, z: 0, yaw: 0, hp: 8,
    mode: 'idle', walkPhase: 0, colorVariant: 0, homeX: 0, homeZ: 0,
    stateTimer: 0, fleeTimer: 0, ...over,
  } as EntityState;
}

/**
 * `animal-ai.ts`'s melee cooldown, replicated so the tests can drive it.
 *
 * CHANGELOG 2026-07-25: this used to be a bare 1.2 for every species, and that
 * assumption stopped being true when `SpeciesDef.attackCooldown` landed for the
 * dungeon enemies. A boss whose overhead slam takes 1.2 s to reach contact
 * CANNOT exist inside a 1.2 s cadence — the arithmetic in 18d says so — so the
 * Dread King carries 1.9 s and the skeleton 1.45 s. Reading the real per-species
 * value here is what keeps 18d and 18e testing the shipping behaviour rather
 * than a number that happens to be right for wolves.
 */
const ATTACK_COOLDOWN_S = 1.2;

/** The cadence a given species actually fights at. */
function cooldownFor(sp: Species): number {
  return SPECIES_DEFS[sp].attackCooldown ?? ATTACK_COOLDOWN_S;
}

/**
 * One tick of the melee branch of `animal-ai.ts`, verbatim:
 *
 *     e.stateTimer -= dtS;
 *     if (e.stateTimer <= 0) { onAttackPlayer(dmg); e.stateTimer = COOLDOWN; }
 *
 * Returns true on the tick the player takes damage. Every attack test below is
 * driven through this rather than by assigning `stateTimer` directly, because
 * the whole point of the contact-time work is that the animation and the damage
 * agree — and they cannot be shown to agree against a hand-poked timer that
 * never actually counts down.
 */
function aiMeleeTick(e: EntityState, dtS: number): boolean {
  e.stateTimer -= dtS;
  if (e.stateTimer > 0) return false;
  e.stateTimer = cooldownFor(e.species);
  return true;
}

{
  // (a) No per-frame allocation: the driver hands back the same objects.
  {
    const d = new CreatureAnim('a1', 'deer');
    const e = ent();
    const f1 = d.update(e, 0, 50);
    const p1 = f1.pose;
    e.z -= 0.05;
    const f2 = d.update(e, 1 / 60, 50);
    check('the driver reuses one frame object (no per-frame allocation)',
      f1 === f2 && p1 === f2.pose);
  }

  // (b) A stationary creature has zero stride amplitude and its phase holds.
  {
    const d = new CreatureAnim('a2', 'deer');
    const e = ent();
    let t = 0;
    for (let f = 0; f < 120; f++) { t += 1 / 60; d.update(e, t, 50); }
    const startPhase = d.walkPhase;
    for (let f = 0; f < 120; f++) { t += 1 / 60; d.update(e, t, 50); }
    check('a standing quadruped does not advance its gait phase',
      near(d.walkPhase, startPhase, 1e-12));
    const fr = d.update(e, t + 1 / 60, 50);
    check('a standing quadruped has zero stride amplitude',
      fr.pose.walkAmp === 0, `${fr.pose.walkAmp}`);
  }

  // (c) A walking creature's gait phase tracks the ground it covers.
  //     This is the end-to-end version of section 9: the driver, the species
  //     stride table and the amplitude law all have to agree, or feet skate.
  {
    const d = new CreatureAnim('a3', 'deer');
    const e = ent({ mode: 'wander' });
    const v = SPECIES_DEFS.deer.speed * 0.6;
    let t = 0;
    // Settle the speed low-pass first.
    for (let f = 0; f < 240; f++) {
      t += 1 / 60; e.z -= v / 60; d.update(e, t, 50);
    }
    const p0 = d.walkPhase, z0 = e.z;
    let ampSum = 0, n = 0;
    for (let f = 0; f < 600; f++) {
      t += 1 / 60; e.z -= v / 60;
      ampSum += d.update(e, t, 50).pose.walkAmp; n++;
    }
    const amp = ampSum / n;
    const cycles = (d.walkPhase - p0) / (Math.PI * 2);
    const expected = (z0 - e.z) / (animalStride('deer') * amp);
    check('gait phase advances one cycle per (stride x amplitude) of ground',
      Math.abs(cycles - expected) / expected < 0.01,
      `${cycles.toFixed(3)} cycles vs ${expected.toFixed(3)} expected`);
    check('a wandering deer walks at a partial stride, not a full one',
      amp > 0.5 && amp < 0.95, `amp ${amp.toFixed(3)}`);
  }

  // (d) The bodyDrop contract: the value handed to the builder must be the
  //     same one folded into the object offset, or every planted foot sinks
  //     into the terrain by the gait bob.
  {
    const d = new CreatureAnim('a4', 'horse');
    const e = ent({ species: 'horse', mode: 'wander' });
    let t = 0, worst = 0;
    for (let f = 0; f < 400; f++) {
      t += 1 / 60; e.z -= 3 / 60;
      const fr = d.update(e, t, 50);
      // yOffset = bodyDrop - bodySink*size, and for a walking horse the sink
      // is only the additive breathing, which is bounded well under a cm.
      worst = Math.max(worst, Math.abs(fr.yOffset - (fr.pose.bodyDrop ?? 0)));
    }
    check('yOffset carries the same bodyDrop the builder was handed',
      worst < 0.05, `divergence ${worst.toFixed(4)} m (breathing only)`);
  }

  // (e) Winged species get an integrated flap phase; others do not.
  {
    const dr = new CreatureAnim('a5', 'dragon');
    const e = ent({ species: 'dragon' });
    let t = 0, prev = -Infinity, mono = true;
    for (let f = 0; f < 300; f++) {
      t += 1 / 60;
      const p = dr.update(e, t, 50).pose;
      if ((p.flapPhase ?? 0) < prev - 1e-12) mono = false;
      prev = p.flapPhase ?? 0;
    }
    check('a dragon beats its wings while standing still', prev > 1);
    check('wing phase is monotonic', mono);

    const q = new CreatureAnim('a6', 'deer');
    const fr = q.update(ent(), 0, 50);
    check('a quadruped is not given flap channels it cannot use',
      fr.pose.flapPhase === undefined || fr.pose.flapAmp === 0);
  }

  // (f) A serpent undulates at rest — it has no other channel to live with.
  {
    const d = new CreatureAnim('a7', 'sea_serpent');
    const e = ent({ species: 'sea_serpent' });
    let t = 0;
    for (let f = 0; f < 60; f++) { t += 1 / 60; d.update(e, t, 50); }
    const p0 = d.walkPhase;
    for (let f = 0; f < 60; f++) { t += 1 / 60; d.update(e, t, 50); }
    const fr = d.update(e, t, 50);
    check('a stationary sea serpent still rides the swell',
      d.walkPhase - p0 > 1 && fr.pose.walkAmp > 0.1,
      `dPhase ${(d.walkPhase - p0).toFixed(2)}, amp ${fr.pose.walkAmp.toFixed(3)}`);
  }

  // (g) The attack trigger, driven by a faithful replica of the AI's own loop.
  //
  //     The previous version of this test poked `stateTimer` by hand and
  //     asserted that the swing STARTS on the hit event. That passed, and it
  //     was asserting a bug: `animal-ai.ts` deals the damage and resets the
  //     timer in the same statement, so a swing that starts there puts the
  //     player's injury a third of a second before the jaws arrive. Modelling
  //     the AI loop instead (`aiMeleeTick`) is what makes the real property —
  //     contact lands WITH the damage, section 18e — expressible at all.
  {
    const d = new CreatureAnim('a8', 'wolf');
    const e = ent({ species: 'wolf', mode: 'aggro', stateTimer: 0 });
    let t = 0;
    let sawAttack = false;
    let enteredAt = -1;
    for (let f = 0; f < 90; f++) {
      t += 1 / 60;
      aiMeleeTick(e, 1 / 60);
      const fr = d.update(e, t, 2);
      if (fr.state === 'attack') {
        if (!sawAttack) enteredAt = f;
        sawAttack = true;
      }
    }
    check('an aggro creature inside melee range attacks', sawAttack);
    check('the attack reports which kind of blow it is',
      d.update(e, t, 2).attack === null || d.update(e, t, 2).attack === 'bite');

    // And a one-shot owns the creature until it completes.
    //
    // Measured on the SECOND swing, not the first. The opening blow of a fight
    // has no countdown to anticipate, so the driver deliberately starts its
    // clip at the contact frame — a partial clip, correctly shorter than its
    // own duration. Asserting the full length against it would be asserting
    // against a behaviour the design chose on purpose.
    const d2 = new CreatureAnim('a8b', 'wolf');
    const e2 = ent({ species: 'wolf', mode: 'aggro', stateTimer: 0 });
    let t2 = 0, blows = 0, started = -1, broke = false, dur = 0;
    for (let f = 0; f < 300; f++) {
      t2 += 1 / 60;
      if (aiMeleeTick(e2, 1 / 60)) blows++;
      const fr = d2.update(e2, t2, 2);
      if (blows < 1) continue;
      if (started < 0) {
        if (fr.state === 'attack' && d2.animator.clipTime < 2 / 60) {
          started = f;
          dur = d2.animator.clip.duration;
        }
      } else if (f - started < (dur * 60) * 0.8 && fr.state !== 'attack') {
        broke = true;
      }
    }
    check('the attack clip is not interrupted halfway through',
      started >= 0 && !broke,
      `first attack at frame ${enteredAt}, second at ${started}`);
  }

  // (h) Teleports must not spin the gait.
  {
    const d = new CreatureAnim('a9', 'deer');
    const e = ent({ mode: 'wander' });
    let t = 0;
    for (let f = 0; f < 120; f++) { t += 1 / 60; e.z -= 0.04; d.update(e, t, 50); }
    const p0 = d.walkPhase;
    e.x += 900; e.z -= 900;          // chunk stream / teleport
    d.update(e, t += 1 / 60, 50);
    check('a teleport advances the gait by at most half a cycle',
      d.walkPhase - p0 <= Math.PI + 1e-9,
      `advanced ${(d.walkPhase - p0).toFixed(3)} rad`);
  }

  // (i) A corpse is completely still.
  {
    const d = new CreatureAnim('a10', 'deer');
    const e = ent({ mode: 'dead' });
    let t = 0;
    for (let f = 0; f < 120; f++) { t += 1 / 60; d.update(e, t, 50); }
    const a = d.update(e, t += 1 / 60, 50);
    const y1 = a.yOffset, amp1 = a.pose.walkAmp, head1 = a.pose.headYaw;
    for (let f = 0; f < 60; f++) { t += 1 / 60; d.update(e, t, 50); }
    const b = d.update(e, t += 1 / 60, 50);
    check('a corpse does not breathe, sway or step',
      near(y1, b.yOffset, 1e-9) && amp1 === 0 && b.pose.walkAmp === 0 &&
      near(head1 ?? 0, b.pose.headYaw ?? 0, 1e-9),
      `y ${y1} -> ${b.yOffset}, head ${head1} -> ${b.pose.headYaw}`);
  }

  // (j) Sitting sinks the body, and it does so smoothly rather than snapping.
  {
    const d = new CreatureAnim('a11', 'horse');
    const size = SPECIES_DEFS.horse.size;
    let t = 0;
    const e = ent({ species: 'horse' });
    for (let f = 0; f < 60; f++) { t += 1 / 60; d.update(e, t, 50); }
    const standing = d.update(e, t, 50).yOffset;
    e.sit = 1;
    let worstStep = 0, prev = standing;
    for (let f = 0; f < 120; f++) {
      const y = d.update(e, t += 1 / 60, 50).yOffset;
      worstStep = Math.max(worstStep, Math.abs(y - prev));
      prev = y;
    }
    check('sitting sinks the body toward the ground',
      prev < standing - size * 0.3, `${standing.toFixed(3)} -> ${prev.toFixed(3)}`);
    check('sitting eases in rather than snapping',
      worstStep < size * 0.05,
      `largest single-frame drop ${worstStep.toFixed(4)} m`);
  }

  // (k) Every species produces a finite, in-range pose across a long churn.
  {
    const speciesList = Object.keys(SPECIES_DEFS) as Species[];
    const modes: EntityMode[] = ['idle', 'graze', 'wander', 'flee', 'aggro', 'follow'];
    let bad = 0, nan = 0;
    for (const sp of speciesList) {
      const d = new CreatureAnim(`k_${sp}`, sp);
      const e = ent({ species: sp });
      let t = 0;
      for (let f = 0; f < 700; f++) {
        t += 1 / 60;
        e.mode = modes[Math.floor(f / 60) % modes.length];
        if (f % 3 === 0) e.z -= SPECIES_DEFS[sp].speed / 60 * 3;
        const p = d.update(e, t, f % 240 < 60 ? 2 : 40).pose;
        for (const v of [p.walkPhase, p.walkAmp, p.headYaw ?? 0,
                         p.jawOpen ?? 0, p.flapAmp ?? 0, p.bodyDrop ?? 0]) {
          if (!Number.isFinite(v)) nan++;
        }
        if (p.walkAmp < 0 || p.walkAmp > 1) bad++;
        if ((p.jawOpen ?? 0) < 0 || (p.jawOpen ?? 0) > 1) bad++;
        if ((p.flapAmp ?? 0) < 0 || (p.flapAmp ?? 0) > 1) bad++;
        if ((p.bodyDrop ?? 0) > 1e-9) bad++;   // bodyDrop must never be positive
      }
    }
    check('no species ever produces a non-finite pose value', nan === 0,
      `${nan} bad values`);
    check('no species ever produces an out-of-range pose value', bad === 0,
      `${bad} violations`);
  }
}

// ---------------------------------------------------------------------------
// 16. Registry lifecycle.
// ---------------------------------------------------------------------------

{
  const reg = new CreatureAnimRegistry();
  reg.beginFrame();
  const a = reg.get('x', 'deer');
  reg.endFrame();
  reg.beginFrame();
  const b = reg.get('x', 'deer');
  reg.endFrame();
  check('the registry returns the same animator for the same entity', a === b);
  check('the registry tracks one animator per entity', reg.size === 1);

  reg.beginFrame();
  const c = reg.get('x', 'wolf');
  reg.endFrame();
  check('a species change replaces the animator', c !== a);

  // Eviction. Sweeps are periodic, so run well past one sweep interval.
  for (let f = 0; f < 400; f++) { reg.beginFrame(); reg.get('y', 'cow'); reg.endFrame(); }
  check('animators for entities that stop being drawn are evicted',
    reg.size === 1, `${reg.size} live`);

  // Gait phase survives a brief absence — an entity pushed past MAX_DRAWN by a
  // passing herd must not restart mid-stride.
  const reg2 = new CreatureAnimRegistry();
  reg2.beginFrame(); const keep = reg2.get('z', 'deer'); reg2.endFrame();
  keep.walkPhase = 4.2;
  for (let f = 0; f < 30; f++) { reg2.beginFrame(); reg2.endFrame(); }
  reg2.beginFrame();
  check('a briefly undrawn entity keeps its gait phase',
    reg2.get('z', 'deer').walkPhase === 4.2);
  reg2.endFrame();
}

// ---------------------------------------------------------------------------
// 16b. Species routing — every species must get a config that matches its rig.
//
//      This is the test that protects the phase rule against new species. The
//      wyvern landed from another workstream mid-build: a two-legged flier with
//      real two-bone IK, which the original `default:` branch would have given
//      quadruped clips and, worse, would still have got right only by accident.
//      A species whose builder plants its feet MUST be configured planted, or
//      it skates — and nothing else in the codebase would notice.
// ---------------------------------------------------------------------------

{
  const speciesList = Object.keys(SPECIES_DEFS) as Species[];

  // (a) Every species resolves to a real config with a usable idle clip.
  let ok = true;
  for (const sp of speciesList) {
    const c = animConfig(sp);
    if (c.set === undefined || c.set.clips.idle === undefined) ok = false;
    if (!(c.idleRate > 0) || c.flapBase < 0 || c.freeHz < 0) ok = false;
  }
  check('every species has a complete animation config', ok);

  // (b) THE routing invariant. Anything with a gait pattern solves planted
  //     feet against `animalStride`, so it must take the planted phase rule.
  const wrong = speciesList.filter(
    sp => animalGait(sp) !== null && !animConfig(sp).planted);
  check('every species with a gait pattern is configured planted',
    wrong.length === 0, wrong.join(', '));

  // (c) The wyvern is the exception the rule cannot see: planted feet, but no
  //     entry in the quadruped gait table. It is configured planted by hand,
  //     which is only correct while its builder solves against the same stride
  //     the driver integrates. Assert that identity rather than trusting it.
  check('the wyvern is configured planted', animConfig('wyvern').planted);
  check('the wyvern builder and the driver agree on stride',
    near(wyvernStride('wyvern'), animalStride('wyvern'), 1e-9),
    `builder ${wyvernStride('wyvern')} vs driver ${animalStride('wyvern')}`);

  // (d) A species whose builder ignores the flap channels must not be given a
  //     wing-beat rate — it would integrate a phase nothing reads.
  check('the bird is not given a wing rate it cannot use',
    animConfig('bird').flapBase === 0);
  check('quadrupeds are not given wing rates',
    speciesList.filter(sp => animalGait(sp) !== null)
      .every(sp => animConfig(sp).flapBase === 0));
  check('every winged species has a non-zero beat rate',
    (['dragon', 'griffin', 'wyvern'] as Species[])
      .every(sp => animConfig(sp).flapBase > 0));

  // (e) Big animals must breathe slower than small ones.
  const sorted = [...speciesList].sort(
    (a, b) => SPECIES_DEFS[a].size - SPECIES_DEFS[b].size);
  let monotone = true;
  for (let i = 1; i < sorted.length; i++) {
    if (animConfig(sorted[i]).idleRate > animConfig(sorted[i - 1]).idleRate + 1e-9) {
      monotone = false;
    }
  }
  check('bigger animals breathe slower', monotone);

  // (f) Free-phase plans that would otherwise be motionless at rest must have
  //     a free-running cycle rate; planted ones must NOT, or their feet would
  //     cycle while standing still.
  check('planted species never free-run their gait',
    speciesList.filter(sp => animConfig(sp).planted)
      .every(sp => animConfig(sp).freeHz === 0));
  check('the sea serpent and the bird free-run (they have nothing else)',
    animConfig('sea_serpent').freeHz > 0 && animConfig('bird').freeHz > 0);
}

// ---------------------------------------------------------------------------
// 17. Clip inventory — the library must actually cover what was asked for.
// ---------------------------------------------------------------------------

{
  const core: AnimState[] = ['idle', 'walk', 'run', 'graze', 'sit', 'sleep',
    'alert', 'attack', 'flee', 'dead'];
  for (const [name, set] of SETS) {
    const missing = core.filter(s => set.clips[s] === undefined);
    check(`${name}: has its own clip for every core state`, missing.length === 0,
      missing.join(', '));
  }
  const winged: AnimState[] = ['flap', 'glide', 'land'];
  const missingW = winged.filter(s => WINGED_CLIPS.clips[s] === undefined);
  check('winged: has flap, glide and land', missingW.length === 0,
    missingW.join(', '));

  // Distinctness: a library where two states resolve to the same clip has not
  // actually authored them, whatever the count says.
  for (const [name, set] of SETS) {
    const seen = new Map<Clip, AnimState>();
    let dupes = 0;
    for (const s of core) {
      const c = set.clips[s];
      if (c === undefined) continue;
      if (seen.has(c)) dupes++;
      seen.set(c, s);
    }
    check(`${name}: no two core states share a clip`, dupes === 0);
  }
}

// ===========================================================================
// 18. ATTACKS
//
//     Five things must be true of an attack, and each of them fails silently:
//
//       a) it is structurally a swing — one-shot, contact inside the clip;
//       b) it ENDS where it started, or every creature that ever attacked
//          holds a permanently crooked head for the rest of the session;
//       c) it stays in range once the always-on additive layer is added on
//          top, which is the case the clip author never sees;
//       d) it can be interrupted on ANY frame without popping;
//       e) it reaches its contact frame when the damage system says it does.
//
//     (b), (c) and (d) are each paired with a demonstration that the check
//     REJECTS a deliberately broken clip, because a test that cannot fail is
//     not evidence of anything.
// ===========================================================================

const SPECIES_LIST = Object.keys(SPECIES_DEFS) as Species[];

/** The additive layer a species' attack will actually be composed with. */
function layerFor(sp: Species): Clip {
  return animConfig(sp).set.idleLayer;
}

// ---------------------------------------------------------------------------
// 18a. Every attack is structurally a swing.
// ---------------------------------------------------------------------------

{
  const names = new Set<string>();
  let dupes = 0, structural = 0, badContact = 0, looped = 0, silly = 0;
  const errs: string[] = [];

  for (const sp of SPECIES_LIST) {
    const moves = ATTACK_MOVES[sp];
    for (const m of moves) {
      if (names.has(m.name)) dupes++;
      names.add(m.name);
      const e = validateClip(m.clip);
      if (e.length > 0) { structural++; errs.push(...e); }
      if (m.clip.loop) looped++;
      // A contact at t=0 is a blow with no windup; a contact at the duration is
      // a blow with no follow-through. Both are authoring mistakes that read as
      // "the animation is broken" without ever being out of range.
      if (!(m.contactT > 0.02 && m.contactT < m.clip.duration - 0.02)) badContact++;
      if (!(m.clip.duration >= 0.2 && m.clip.duration <= 1.6)) silly++;
      if (!(m.weight > 0) || m.minRange < 0 || m.maxRange <= m.minRange) silly++;
    }
  }

  check('every species has an attack vocabulary',
    SPECIES_LIST.every(sp => ATTACK_MOVES[sp].length >= 2),
    SPECIES_LIST.filter(sp => ATTACK_MOVES[sp].length < 2).join(', '));
  check('every attack clip is structurally valid', structural === 0,
    errs.slice(0, 4).join(' | '));
  check('attack move names are globally unique', dupes === 0);
  check('every attack is a one-shot, not a loop', looped === 0);
  check('every contact time is strictly inside its clip', badContact === 0);
  check('every attack has a sane duration, weight and range band', silly === 0);

  // Distinctness: two species sharing a clip object have not been given two
  // attacks, whatever the table says.
  const clips = new Set<Clip>();
  let shared = 0;
  for (const sp of SPECIES_LIST) {
    for (const m of ATTACK_MOVES[sp]) {
      if (clips.has(m.clip)) shared++;
      clips.add(m.clip);
    }
  }
  check('no two attacks share a clip object', shared === 0);
  check('ATTACK_ALL covers every authored clip', ATTACK_ALL.length === clips.size);

  // At every distance the AI can actually strike from, SOMETHING must be in
  // range. `pickAttack` falls back to the whole list if nothing is, so this is
  // not a crash risk — it is a coverage claim: a wolf at 2.4 m should be
  // choosing a lunge because it fits, not because everything else was skipped.
  let gaps = 0;
  for (const sp of SPECIES_LIST) {
    for (let r = 0; r <= 2.5; r += 0.1) {
      if (!ATTACK_MOVES[sp].some(m => r >= m.minRange && r <= m.maxRange)) gaps++;
    }
  }
  check('every species has a move in range at every melee distance', gaps === 0,
    `${gaps} uncovered distances`);

  // A swing has to FIT inside the rhythm the AI dictates, and this is the
  // arithmetic that says whether it does.
  //
  // A blow lands `contactT` into its clip and the AI's next blow lands
  // `ATTACK_COOLDOWN_S` later, so the recovery of move `a` plus the mandatory
  // gap plus the windup of move `b` must all fit in one cooldown. Fail it and
  // nothing errors — the next swing simply starts late and every contact after
  // it trails its damage, which is precisely the defect all this exists to
  // remove. A 1.25 s dragon breath failed this and had to be shortened; the
  // check is here so the next long clip fails in CI instead of in play.
  const tight: string[] = [];
  for (const sp of SPECIES_LIST) {
    for (const a of ATTACK_MOVES[sp]) {
      for (const b of ATTACK_MOVES[sp]) {
        const slack = (cooldownFor(sp) - b.contactT)
          - (a.clip.duration - a.contactT) - SWING_GAP;
        if (slack < 0) tight.push(`${a.name}->${b.name} over by ${(-slack).toFixed(2)}s`);
      }
    }
  }
  check('every attack fits inside the AI attack cooldown, in every order',
    tight.length === 0, tight.slice(0, 3).join(' | '));
}

// ---------------------------------------------------------------------------
// 18b. An attack returns EXACTLY to the pose it started from.
//
//      One-shot clips clamp and hold their last value forever (see
//      `sampleClip`), so a clip whose final key differs from its first leaves a
//      permanent offset on any creature that has ever attacked. It is invisible
//      in a still frame, invisible in motion, and cumulative across species.
// ---------------------------------------------------------------------------

{
  const a = makePose();
  const b = makePose();
  const c = makePose();

  function driftOf(clip: Clip): number {
    sampleClip(clip, 0, a);
    sampleClip(clip, clip.duration, b);
    sampleClip(clip, clip.duration * 10, c);   // long after it finished
    let worst = 0;
    for (let i = 0; i < Ch.COUNT; i++) {
      worst = Math.max(worst, Math.abs(a[i] - b[i]), Math.abs(a[i] - c[i]));
    }
    return worst;
  }

  let worst = 0, culprit = '';
  for (const sp of SPECIES_LIST) {
    for (const m of ATTACK_MOVES[sp]) {
      const d = driftOf(m.clip);
      if (d > worst) { worst = d; culprit = m.name; }
    }
  }
  check('every attack ends exactly on the pose it began from',
    worst < 1e-6, `${culprit} drifts ${worst.toExponential(2)}`);

  // The check has teeth: a clip that ends 0.04 rad off must be rejected.
  const sloppy = shotClip('sloppy', 0.4, [
    track(Ch.HeadYaw, [[0, 0], [0.2, 0.5], [0.4, 0.04]]),
  ]);
  check('...and the same check rejects a clip that does not return to rest',
    driftOf(sloppy) > 1e-6, `drift ${driftOf(sloppy)}`);
}

// ---------------------------------------------------------------------------
// 18c. In range WITH the additive idle layer on top.
//
//      `clampPose` in the animator would hide this at runtime; the point of
//      testing without it is that a clamped channel is a silently flattened
//      animation, not a safe one. The layer is always on and is sampled from a
//      clock the clip knows nothing about, so every clip time has to be legal
//      against every layer phase.
// ---------------------------------------------------------------------------

{
  const base = makePose();
  const lay = makePose();
  const sum = makePose();

  /** Worst channel excursion outside CH_RANGE, over the whole clip x layer grid. */
  function worstExcursion(clip: Clip, layer: Clip): { over: number; ch: number } {
    let over = 0, ch = -1;
    for (let i = 0; i <= 120; i++) {
      sampleClip(clip, (i / 120) * clip.duration, base);
      // The layer's weight is damped by stride amplitude, exactly as the
      // animator does it — an attacking creature is stationary, so the weight
      // is usually 1 and this is the worst case anyway.
      const w = 1 - Math.min(1, Math.max(0, base[Ch.WalkAmp])) * 0.7;
      for (let j = 0; j < 48; j++) {
        sampleClip(layer, (j / 48) * layer.duration, lay);
        copyPose(sum, base);
        addPose(sum, lay, w);
        for (let k = 0; k < Ch.COUNT; k++) {
          const r = CH_RANGE[k];
          const d = Math.max(r[0] - sum[k], sum[k] - r[1]);
          if (d > over) { over = d; ch = k; }
        }
      }
    }
    return { over, ch };
  }

  let worst = 0, culprit = '', chName = '';
  for (const sp of SPECIES_LIST) {
    const layer = layerFor(sp);
    for (const m of ATTACK_MOVES[sp]) {
      const r = worstExcursion(m.clip, layer);
      if (r.over > worst) { worst = r.over; culprit = m.name; chName = CH_NAME[r.ch]; }
    }
  }
  check('no attack leaves a channel out of range once the idle layer is added',
    worst <= 0, `${culprit} exceeds ${chName} by ${worst.toFixed(4)}`);

  // Teeth: a clip that sits exactly ON the BodySink floor is legal alone and
  // illegal the moment the layer breathes downward on top of it. That is the
  // entire class of bug this check exists for, so it must be detected.
  const onTheLimit = shotClip('on_the_limit', 0.4, [
    track(Ch.BodySink, [[0, 0], [0.2, CH_RANGE[Ch.BodySink][0]], [0.4, 0]]),
  ]);
  check('...and the same check rejects a clip sitting on the channel limit',
    worstExcursion(onTheLimit, QUADRUPED_CLIPS.idleLayer).over > 0);
}

// ---------------------------------------------------------------------------
// 18d. The strike is the fastest part of the clip, and it happens at contact.
//
//      `contactT` is a promise the damage system is allowed to rely on. What
//      makes it true rather than decorative is that the pose is moving fastest
//      as it ARRIVES at that time — windup slow, strike fast, recovery medium.
//      A clip whose fastest motion is in the recovery is a rewind, not a blow.
// ---------------------------------------------------------------------------

{
  const p0 = makePose();
  const p1 = makePose();

  /** Time at which the pose is changing fastest, in seconds. */
  function peakSpeedT(clip: Clip): number {
    const N = 400;
    const h = clip.duration / N;
    let best = 0, bestT = 0;
    for (let i = 0; i < N; i++) {
      sampleClip(clip, i * h, p0);
      sampleClip(clip, (i + 1) * h, p1);
      let v = 0;
      for (let k = 0; k < Ch.COUNT; k++) {
        // FlapRate is a multiplier on a frequency, not a pose angle; its
        // numeric range is 10x the others and it would dominate the norm
        // without saying anything about where the blow lands.
        if (k === Ch.FlapRate) continue;
        v += Math.abs(p1[k] - p0[k]);
      }
      if (v > best) { best = v; bestT = (i + 0.5) * h; }
    }
    return bestT;
  }

  let bad: string[] = [];
  for (const sp of SPECIES_LIST) {
    for (const m of ATTACK_MOVES[sp]) {
      const t = peakSpeedT(m.clip);
      // The strike window: from halfway through the windup to a little way
      // into the follow-through.
      const lo = m.contactT * 0.45;
      const hi = m.contactT + (m.clip.duration - m.contactT) * 0.32;
      if (t < lo || t > hi) {
        bad.push(`${m.name} peaks at ${t.toFixed(3)} not [${lo.toFixed(2)}, ${hi.toFixed(2)}]`);
      }
    }
  }
  check('every attack moves fastest as it arrives at its contact frame',
    bad.length === 0, bad.slice(0, 3).join(' | '));

  // Teeth: a clip whose big movement is in the RECOVERY must be rejected.
  const backwards = shotClip('backwards', 0.6, [
    track(Ch.HeadYaw, [
      [0, 0, Ease.Smooth], [0.25, 0.08, Ease.Smooth], [0.30, 0.10, Ease.Smooth],
      [0.55, 0.9, Ease.In], [0.6, 0, Ease.Linear],
    ]),
  ]);
  check('...and the same check rejects a clip that peaks during its recovery',
    peakSpeedT(backwards) > 0.30 + (0.6 - 0.30) * 0.32);
}

// ---------------------------------------------------------------------------
// 18e. THE contact test: the blow lands when the damage lands.
//
//      `animal-ai.ts` deals damage the instant its 1.2 s cooldown expires and
//      resets the cooldown in the same statement. So the animation has to START
//      EARLY — `contactT` seconds before the timer runs out — for the strike to
//      coincide with the injury. Nothing else in the codebase would notice if
//      it did not; the player would just feel bitten by an animal that had not
//      moved yet.
// ---------------------------------------------------------------------------

{
  const misses: string[] = [];
  const lates: number[] = [];

  for (const sp of SPECIES_LIST) {
    const d = new CreatureAnim(`hit_${sp}`, sp);
    // `aggro` mode plus a fixed 2.0 m range: inside animal-ai's ATTACK_DIST,
    // so its cooldown ticks, and inside a band every species has a move for.
    const e = ent({ species: sp, mode: 'aggro', stateTimer: 0 });
    let t = 0, blows = 0;
    let worst = 0;
    for (let f = 0; f < 60 * 12; f++) {
      t += 1 / 60;
      const damaged = aiMeleeTick(e, 1 / 60);
      const fr = d.update(e, t, 2.0);
      // Skip the first blow: animal-ai enters `aggro` with the timer already at
      // zero, so there is no countdown to anticipate and the first swing is
      // unavoidably reactive. Every blow after it has a full 1.2 s of warning.
      if (!damaged) continue;
      blows++;
      if (blows <= 1) continue;
      if (fr.attack === null) { misses.push(`${sp}: not swinging on the hit`); continue; }
      worst = Math.max(worst, Math.abs(fr.contactIn));
    }
    lates.push(worst);
    // Two frames. One for the AI tick and the animation tick being different
    // events on the same frame, one for the trigger threshold being crossed
    // between samples.
    if (worst > 2.5 / 60) {
      misses.push(`${sp}: contact off by ${(worst * 1000).toFixed(0)} ms`);
    }
    if (blows < 6) misses.push(`${sp}: only ${blows} blows in 12 s`);
  }

  check('every species reaches its contact frame on the damage tick',
    misses.length === 0, misses.slice(0, 4).join(' | '));
  check('...to within a couple of frames for all twelve species',
    Math.max(...lates) < 2.5 / 60,
    `worst ${(Math.max(...lates) * 1000).toFixed(1)} ms`);

  // Teeth: the OLD behaviour — start the swing on the hit event — would put the
  // contact a whole `contactT` late. Show that this test would have caught it.
  const naiveLate = ATTACK_MOVES.wolf[0].contactT;
  check('...and the naive "swing when the damage lands" rule would fail it',
    naiveLate > 2.5 / 60,
    `it would be ${(naiveLate * 1000).toFixed(0)} ms late`);
}

// ---------------------------------------------------------------------------
// 18f. Interruptible on any frame, without a pop.
//
//      An animal that decides to run does not finish its bite. The animator's
//      crossfade-from-a-frozen-snapshot makes that exact, but only if the
//      driver actually lets go of the one-shot — and the driver's default is to
//      hold on to it, which is correct for every other case.
// ---------------------------------------------------------------------------

//
//      MEASURING "POP" WITHOUT A MAGIC THRESHOLD
//
//      An absolute bound on the single-frame jump is the wrong tool: a legal
//      crossfade into a clip that differs a lot on some channel moves further
//      in its first frame than an illegal one into a clip that barely differs,
//      so any constant is simultaneously too strict somewhere and too loose
//      somewhere else. (Written that way first; a dragon's perfectly correct
//      0.053 step on `walkAmp` failed it.)
//
//      What actually distinguishes a pop from a transition is the SHAPE: a cut
//      does the whole movement in one frame, a crossfade spreads it over many.
//      So measure the first frame as a FRACTION of the total movement of the
//      same transition. Scale-free, threshold-free in spirit, and a hard cut
//      scores exactly 1.0 against a smoothstep fade's ~0.05.
{
  function poseVec(fr: { pose: AnimalPose; yOffset: number }): number[] {
    return [fr.pose.walkAmp, fr.pose.headYaw ?? 0, fr.pose.jawOpen ?? 0,
            fr.pose.flapAmp ?? 0, fr.yOffset];
  }

  let worstRatio = 0, culprit = '';
  for (const sp of SPECIES_LIST) {
    const swingLen = Math.max(...ATTACK_MOVES[sp].map(m => m.clip.duration));
    for (let cut = 1; cut < Math.ceil(swingLen * 60); cut++) {
      const d = new CreatureAnim(`cut_${sp}_${cut}`, sp);
      const e = ent({ species: sp, mode: 'aggro', stateTimer: 0 });
      let t = 0, started = -1, prev: number[] | null = null;
      for (let f = 0; f < 600 && started < 0; f++) {
        t += 1 / 60;
        aiMeleeTick(e, 1 / 60);
        const fr = d.update(e, t, 2.0);
        if (fr.attack !== null) started = f;
        prev = poseVec(fr);
      }
      if (started < 0) continue;
      // Run `cut` frames into the swing, then bolt.
      for (let f = 0; f < cut; f++) {
        t += 1 / 60;
        prev = poseVec(d.update(e, t, 2.0));
      }
      const atCut = prev!;
      e.mode = 'flee';
      t += 1 / 60;
      const first = poseVec(d.update(e, t, 2.0));
      // How far the transition travels from the interrupt point, over the whole
      // fade. Taken as the largest excursion rather than the endpoint: a
      // transition may overshoot and come back (a fade into `flee` that
      // `pickState` then re-resolves to `alert` does exactly that), and
      // measuring against the endpoint would divide by nearly nothing.
      const span = first.map((v, i) => Math.abs(v - atCut[i]));
      for (let f = 0; f < 30; f++) {
        t += 1 / 60;
        const p = poseVec(d.update(e, t, 2.0));
        for (let i = 0; i < p.length; i++) {
          span[i] = Math.max(span[i], Math.abs(p[i] - atCut[i]));
        }
      }
      for (let i = 0; i < first.length; i++) {
        const step = Math.abs(first[i] - atCut[i]);
        // A single frame that moves a bounded channel by less than 0.05 is not
        // a pop whatever fraction of the transition it represents — it is a
        // transition that had almost nowhere to go. Without this floor the
        // measurement is dominated by the additive layer's own wobble on
        // channels the fade barely touches, which is noise, not evidence.
        if (step < 0.05 || span[i] < 0.02) continue;
        const ratio = step / span[i];
        if (ratio > worstRatio) { worstRatio = ratio; culprit = `${sp} ch${i} cut@${cut}`; }
      }
    }
  }
  // The shortest fade in the system is 0.07 s = 4.2 frames, whose first
  // smoothstep step is 0.16. Anything at or near 1.0 is a cut.
  check('interrupting a swing on any frame spreads the change over a fade',
    worstRatio < 0.35,
    `worst first-frame share ${worstRatio.toFixed(3)} (${culprit})`);

  // Teeth: the same measurement on a hard cut, which is the implementation this
  // animator exists to avoid, must score ~1.
  {
    const an = new Animator('pop', QUADRUPED_CLIPS.clips.idle);
    an.setIdleLayer(QUADRUPED_CLIPS.idleLayer, 1);
    an.play(ATTACK_MOVES.wolf[0].clip, 0.07);
    const before = makePose();
    for (let f = 0; f < 12; f++) copyPose(before, an.update(1 / 60));
    an.snap(QUADRUPED_CLIPS.clips.flee!);     // no crossfade: the naive version
    const firstP = makePose();
    copyPose(firstP, an.update(1 / 60));
    const span = new Float64Array(Ch.COUNT);
    for (let c = 0; c < Ch.COUNT; c++) span[c] = Math.abs(firstP[c] - before[c]);
    for (let f = 0; f < 30; f++) {
      const p = an.update(1 / 60);
      for (let c = 0; c < Ch.COUNT; c++) {
        span[c] = Math.max(span[c], Math.abs(p[c] - before[c]));
      }
    }
    let ratio = 0;
    for (const c of [Ch.WalkAmp, Ch.HeadYaw, Ch.JawOpen, Ch.BodySink]) {
      if (span[c] < 0.02) continue;
      ratio = Math.max(ratio, Math.abs(firstP[c] - before[c]) / span[c]);
    }
    check('...and the same measurement scores a hard cut at ~1.0', ratio > 0.9,
      `hard-cut share ${ratio.toFixed(3)}`);
  }

  // The interruption must also actually happen: a fleeing animal that keeps
  // playing its bite has not been interrupted, it has been ignored.
  {
    const d = new CreatureAnim('bolt', 'wolf');
    const e = ent({ species: 'wolf', mode: 'aggro', stateTimer: 0 });
    let t = 0, started = false;
    for (let f = 0; f < 300 && !started; f++) {
      t += 1 / 60; aiMeleeTick(e, 1 / 60);
      started = d.update(e, t, 2.0).attack !== null;
    }
    e.mode = 'flee';
    const after = d.update(e, t += 1 / 60, 2.0);
    check('an animal that decides to run abandons the swing it had started',
      started && after.attack === null && after.state !== 'attack',
      `${after.state}/${after.attack}`);
  }
}

// ---------------------------------------------------------------------------
// 18g. Selection: deterministic, range-aware, decorrelated, non-repetitive.
// ---------------------------------------------------------------------------

{
  const wolf = ATTACK_MOVES.wolf;

  // (i) Deterministic.
  check('the same entity and counter always pick the same move',
    pickAttack(wolf, 0.37, 5, 2.0, null) === pickAttack(wolf, 0.37, 5, 2.0, null));

  // (ii) Range filters first. This is the rule that makes the choice read as an
  //      animal deciding rather than a die roll, so assert it exactly.
  let closeLunges = 0, farSnaps = 0;
  for (let n = 0; n < 200; n++) {
    if (pickAttack(wolf, hashUnit(`w${n}`), n, 1.0, null).name === 'wolf_lunge') closeLunges++;
    if (pickAttack(wolf, hashUnit(`w${n}`), n, 3.0, null).name === 'wolf_snap') farSnaps++;
  }
  check('a wolf with no room to lunge never lunges', closeLunges === 0);
  check('a wolf out of snapping range never snaps', farSnaps === 0);

  // (iii) Nothing in range still returns something.
  check('an out-of-range target still gets an attack',
    pickAttack(wolf, 0.5, 0, 40, null) !== null);

  // (iv) No move is starved. A variant that is never chosen has not been
  //      authored, it has been wasted.
  let starved: string[] = [];
  for (const sp of SPECIES_LIST) {
    const moves = ATTACK_MOVES[sp];
    // Sample across the whole melee band so range-limited moves get their turn.
    const seen = new Set<string>();
    for (let n = 0; n < 240; n++) {
      const r = (n % 25) * 0.1;
      seen.add(pickAttack(moves, hashUnit(`${sp}_${n}`), n, r, null).name);
    }
    for (const m of moves) if (!seen.has(m.name)) starved.push(m.name);
  }
  check('every authored attack is reachable', starved.length === 0,
    starved.join(', '));

  // (v) The redraw actually reduces runs. Compare the real picker against the
  //     single-draw version it replaced, over the same sequence.
  function repeatRate(redraw: boolean): number {
    let repeats = 0, total = 0;
    for (let id = 0; id < 40; id++) {
      const seed = hashUnit(`bear_${id}`);
      let prev: typeof ATTACK_MOVES.bear[number] | null = null;
      for (let n = 0; n < 60; n++) {
        const m = pickAttack(ATTACK_MOVES.bear, seed, n, 2.4,
          redraw ? prev : null);
        if (prev !== null) { total++; if (m === prev) repeats++; }
        prev = m;
      }
    }
    return repeats / total;
  }
  const withRedraw = repeatRate(true);
  const without = repeatRate(false);
  check('redrawing a repeated move materially reduces runs',
    withRedraw < without * 0.6,
    `${(withRedraw * 100).toFixed(1)}% vs ${(without * 100).toFixed(1)}%`);
  check('...but repeats are not forbidden outright (that reads as a metronome)',
    withRedraw > 0, `${(withRedraw * 100).toFixed(1)}%`);

  // (vi) A pack does not swing in unison. Different ids, same counter, must
  //      produce different sequences.
  let identical = 0, pairs = 0;
  const ids = Array.from({ length: 8 }, (_, i) => hashUnit(`wolf_${i}`));
  const seqs = ids.map(seed => {
    const out: string[] = [];
    let prev: typeof wolf[number] | null = null;
    for (let n = 0; n < 40; n++) {
      const m = pickAttack(wolf, seed, n, 2.0, prev);
      out.push(m.name); prev = m;
    }
    return out.join('');
  });
  for (let i = 0; i < seqs.length; i++) {
    for (let j = i + 1; j < seqs.length; j++) {
      pairs++;
      if (seqs[i] === seqs[j]) identical++;
    }
  }
  check('a pack of wolves does not throw the same sequence of attacks',
    identical === 0, `${identical}/${pairs} identical`);

  // (vii) No Math.random anywhere in the attack path: the same world must
  //       animate identically on every run.
  const runA = new CreatureAnim('det_1', 'bear');
  const runB = new CreatureAnim('det_1', 'bear');
  const eA = ent({ species: 'bear', mode: 'aggro', stateTimer: 0 });
  const eB = ent({ species: 'bear', mode: 'aggro', stateTimer: 0 });
  let diverged = false, tA = 0;
  for (let f = 0; f < 60 * 10; f++) {
    tA += 1 / 60;
    aiMeleeTick(eA, 1 / 60); aiMeleeTick(eB, 1 / 60);
    const a = runA.update(eA, tA, 2.2);
    const sa = { st: a.state, at: a.attack, y: a.yOffset, h: a.pose.headYaw };
    const b = runB.update(eB, tA, 2.2);
    if (sa.st !== b.state || sa.at !== b.attack || sa.y !== b.yOffset
        || sa.h !== b.pose.headYaw) diverged = true;
  }
  check('two runs of the same entity produce identical attack animation',
    !diverged);
}

// ---------------------------------------------------------------------------
// 18h. The clips respect what each rig can actually do.
// ---------------------------------------------------------------------------

{
  const p = makePose();

  // A planted rig's stride comes from measured speed; a clip that authors a
  // non-zero WalkAmp on one is writing a cheque the driver will not cash, and
  // worse, it would gate a phase advance on an animal that is standing still.
  let plantedBad: string[] = [];
  let freeSilent: string[] = [];
  for (const sp of SPECIES_LIST) {
    const planted = animConfig(sp).planted;
    for (const m of ATTACK_MOVES[sp]) {
      let maxAmp = 0;
      for (let i = 0; i <= 60; i++) {
        sampleClip(m.clip, (i / 60) * m.clip.duration, p);
        maxAmp = Math.max(maxAmp, p[Ch.WalkAmp]);
      }
      if (planted && maxAmp > 1e-6) plantedBad.push(m.name);
      // The bird and the serpent drive their WINGS / their whole body from
      // WalkAmp. A clip that leaves it at zero on those two rigs does not stop
      // the legs, it deletes the animal.
      if ((sp === 'bird' || sp === 'sea_serpent') && maxAmp < 0.2) {
        freeSilent.push(m.name);
      }
    }
  }
  check('no attack asks a planted rig to move its legs while standing still',
    plantedBad.length === 0, plantedBad.join(', '));
  check('the bird and the serpent drive their one body channel in every attack',
    freeSilent.length === 0, freeSilent.join(', '));

  // The griffin strikes with a BEAK, and a beak is rigid — it does not hinge
  // open to hit something. So its peck is authored entirely on the head and the
  // body, and it authors no jaw track at all.
  //
  // This is a claim about the animal, not about the rig, and the distinction
  // matters: quadrupeds also have no jaw joint today, and their bites DO author
  // `JawOpen` — a wolf closing its mouth on something is a jaw motion that will
  // appear the day `buildQuadruped` reads the channel, in the same way the
  // `HeadPitch` tracks throughout this library will. A griffin's would not,
  // because there is nothing there to open.
  const griffinJaw = ATTACK_MOVES.griffin.some(
    m => m.clip.tracks.some(t => t.ch === Ch.JawOpen));
  check('the griffin strikes with a rigid beak, not a jaw', !griffinJaw);
  for (const sp of ['dragon', 'wyvern'] as Species[]) {
    const bite = ATTACK_MOVES[sp].find(m => m.kind === 'bite');
    check(`the ${sp} bites with its jaws`,
      bite !== undefined && bite.clip.tracks.some(t => t.ch === Ch.JawOpen));
  }
  // The user was explicit that both fliers bite AND use their breath weapon.
  for (const sp of ['dragon', 'wyvern'] as Species[]) {
    const kinds = new Set(ATTACK_MOVES[sp].map(m => m.kind));
    check(`the ${sp} has both a bite and a breath attack`,
      kinds.has('bite') && kinds.has('breath'), [...kinds].join(','));
  }

  // A breath weapon is open-and-HOLD, not a swing. If the jaw is only wide for
  // an instant there is nothing for the fire to come out of.
  for (const sp of ['dragon', 'wyvern'] as Species[]) {
    const br = ATTACK_MOVES[sp].find(m => m.kind === 'breath')!;
    let held = 0;
    const N = 400;
    for (let i = 0; i <= N; i++) {
      sampleClip(br.clip, (i / N) * br.clip.duration, p);
      if (p[Ch.JawOpen] > 0.7) held += br.clip.duration / N;
    }
    check(`the ${sp} holds its jaws open while it breathes`, held > 0.3,
      `${held.toFixed(2)} s above 0.7`);
  }

  // The bear and the griffin are the two species whose signature attack is a
  // limb sweeping across the body. With no limb channel, the ONLY thing that
  // reads as that is a one-way head sweep — windup and contact on opposite
  // sides, and not returning through centre the way a bite does.
  for (const [sp, name] of [['bear', 'bear_swipe'], ['griffin', 'griffin_talon']] as const) {
    const m = ATTACK_MOVES[sp as Species].find(x => x.name === name)!;
    sampleClip(m.clip, m.contactT * 0.62, p);
    const wind = p[Ch.HeadYaw];
    sampleClip(m.clip, m.contactT, p);
    const hit = p[Ch.HeadYaw];
    check(`${name} sweeps one way across the body`,
      wind * hit < 0 && Math.abs(wind - hit) > 0.5,
      `${wind.toFixed(2)} -> ${hit.toFixed(2)}`);
  }
}

// ---------------------------------------------------------------------------
// 18i. Cost. 30 creatures animate every frame; attacks must not change that.
// ---------------------------------------------------------------------------

{
  const N = 30;

  /** ns per creature per frame for a 30-creature world in `mode`. */
  function measure(mode: EntityMode, range: number, melee: boolean): number {
    const drivers: CreatureAnim[] = [];
    const ents: EntityState[] = [];
    for (let i = 0; i < N; i++) {
      const sp = SPECIES_LIST[i % SPECIES_LIST.length];
      drivers.push(new CreatureAnim(`perf_${mode}_${i}`, sp));
      ents.push(ent({ id: `perf_${mode}_${i}`, species: sp, mode, stateTimer: 0 }));
    }
    const FRAMES = 4000;
    let t = 0;
    const run = (n: number) => {
      for (let f = 0; f < n; f++) {
        t += 1 / 60;
        for (let i = 0; i < N; i++) {
          if (melee) aiMeleeTick(ents[i], 1 / 60);
          drivers[i].update(ents[i], t, range);
        }
      }
    };
    run(600);                                   // warm up: measure steady state
    const t0 = process.hrtime.bigint();
    run(FRAMES);
    return Number(process.hrtime.bigint() - t0) / (FRAMES * N);
  }

  // Both numbers matter. The attacking one is the new path; the idle one is the
  // path the whole world spends its time on, and the comparison against the
  // system's pre-attack figure of ~520 ns only means anything if the case that
  // figure described is still measured.
  const idleNs = measure('idle', 40, false);
  const ns = measure('aggro', 2.0, true);
  console.log(`  [perf] ${idleNs.toFixed(0)} ns per creature per frame, idle`);
  console.log(`  [perf] ${ns.toFixed(0)} ns per creature per frame, all attacking`);
  // Generous by 4x: these are regression tripwires for something going
  // quadratic or allocating, not benchmarks.
  check('idle creatures animate in well under 2 us each', idleNs < 2000,
    `${idleNs.toFixed(0)} ns`);
  check('attacking creatures animate in well under 2 us each',
    ns < 2000, `${ns.toFixed(0)} ns`);

  // And the debug hook must cost nothing when it is off.
  check('the debug log is not written while disabled',
    animDebug.enabled === false && animDebug.log.size === 0,
    `${animDebug.log.size} entries`);
}

// ---------------------------------------------------------------------------

console.log(`\nanim: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
