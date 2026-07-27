/**
 * clips-attack.ts — the per-species attack vocabulary.
 *
 * WHY THIS IS PER SPECIES AND THE REST OF THE LIBRARY IS PER BODY PLAN
 *
 * `clips-quadruped.ts` is shared by seven animals because a rabbit and a bear
 * *walk* the same way — the difference between them is entirely in the rig's
 * proportions and stride, which the mesh builder already owns. Attacks are the
 * one place where that stops being true. A bear and a cow have the same
 * skeleton and the same gait and completely different fights: the bear rears
 * and rakes, the cow drops its head and shoves. There is no body-plan-level
 * clip that can be both.
 *
 * So this file is keyed by SPECIES, and it is the only file in the animation
 * system that is. Everything else stays keyed by body plan.
 *
 * ---------------------------------------------------------------------------
 * WHY `AnimState` DID NOT GROW A `bite` / `claw` / `charge` MEMBER
 * ---------------------------------------------------------------------------
 *
 * The obvious model is to extend the state enum. It was rejected for three
 * reasons, in increasing order of importance:
 *
 *   1. `AnimState` is the key of `FALLBACK` and `FADE_IN` and is exported to
 *      `entity-renderer.ts` and `main.ts` (`flightOverride`). Every new member
 *      is a row in two tables in another module's dependency, and a widened
 *      union in two other workstreams' files.
 *
 *   2. The fallback graph would degenerate. `bite`, `claw`, `gore`, `kick` and
 *      `breath` all fall back to `attack`, which falls back to `alert`. That is
 *      not a graph of postural neighbours — the thing `resolveState` exists to
 *      walk — it is a star with a single hub, i.e. a lookup wearing a graph's
 *      clothes.
 *
 *   3. The decisive one: attack variants are not selected the way states are.
 *      Every other `AnimState` is chosen from a MEASURABLE FACT — speed,
 *      altitude, sit amount, AI mode. Which attack a creature throws is chosen
 *      from identity, range and history, and it has to be deterministic per
 *      entity so a pack does not swing in unison. That is a different kind of
 *      decision with a different contract, and folding it into `pickState`
 *      would put a hash and a weighted draw inside a pure function of the
 *      world.
 *
 * So `attack` stays ONE state — "this creature is committing violence" — and
 * the choice of which attack is an orthogonal axis resolved by `pickAttack`.
 * `resolveState(set, 'attack')` still works and still returns the body plan's
 * generic swing, which is what a species with no table of its own gets.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ACTUALLY VISIBLE, AND WHY THESE CLIPS LOOK THE WAY THEY DO
 * ---------------------------------------------------------------------------
 *
 * This is the constraint that shaped every curve below, and it is worth stating
 * bluntly rather than discovering later from a screenshot.
 *
 * A stationary quadruped can express exactly TWO things today:
 *
 *   - `Ch.HeadYaw`  -> `AnimalPose.headYaw`, which twists the head and neck.
 *   - `Ch.BodySink` -> the renderer's object offset, which raises and lowers
 *     the WHOLE creature.
 *
 * Not the legs: for a planted body plan the driver computes
 * `walkAmp = gate * sqrt(speed / refSpeed)`, and a creature that has stopped to
 * bite has `speed = 0`, so the stride gate is multiplied by zero no matter what
 * the clip asks for. A clip physically cannot move a standing quadruped's legs.
 * That is correct — it is what keeps planted feet planted — but it means
 * "the bear swipes with a forepaw" is not expressible as a limb motion today.
 * `Ch.HeadPitch` and `Ch.TailSway` are authored throughout and still go
 * nowhere (`CH_PLUMBED` in `clip.ts`).
 *
 * So each quadruped attack is differentiated by the SHAPE and RHYTHM of those
 * two curves, which is a real and readable difference even though it is not the
 * one an animator would choose:
 *
 *   bite / snap   head whips THROUGH centre (windup one way, contact the
 *                 other), body dips then drives up. Fast, symmetric-ish.
 *   claw / swipe  head sweeps ONE WAY across the body, tracking a paw the rig
 *                 cannot draw; body rears on the windup and slams down THROUGH
 *                 the contact. Slow up, fast down.
 *   gore / butt   almost no yaw; the whole body dips and drives forward. Heavy
 *                 and slow, with a long recovery — mass, not speed.
 *   kick          no yaw at all, body pops sharply upward AT contact and drops
 *                 back. The shortest clip in the file, because a kick is over
 *                 before you see it start.
 *   rear          body rises slowly, holds, then drops hard. The only attack
 *                 whose windup is longer than its strike.
 *
 * Fliers get more: `Ch.FlapAmp` / `Ch.FlapRate` are real independent channels,
 * and `Ch.JawOpen` reaches the dragon and the wyvern (and only those two — the
 * griffin's builder has no jaw, so its "beak strike" is authored on the head).
 * The sea serpent gets one channel and one channel only; see `clips-serpent.ts`
 * for why that is a feature.
 *
 * ---------------------------------------------------------------------------
 * CONTACT TIME IS DATA, NOT A COMMENT
 * ---------------------------------------------------------------------------
 *
 * Every move declares `contactT`, the second at which the blow lands, and the
 * `swing()` authoring helper places every channel's extreme AT that time (plus
 * an optional per-channel `lag`, so a jaw can close just after the head arrives
 * without the contact frame becoming a matter of opinion).
 *
 * The driver uses it to start the windup EARLY, so the strike apex coincides
 * with the damage tick instead of trailing it by a third of a second — see
 * `creature-anim.ts`. A test asserts the two agree; without `contactT` as data
 * there would be nothing for it to assert against.
 *
 * Pure module: built once at import, no allocation at runtime.
 */

import { Ch, Ease, track, type Clip, type KeySpec, type Track } from './clip';
import { hold, shotClip } from './clip-set';
import type { Species } from '../entities/entity-types';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * What a blow IS, independent of which species throws it.
 *
 * Exposed on `CreatureFrame` so the sound and damage systems can key off the
 * kind of blow rather than the species — a bite is a bite whether a wolf or a
 * dragon delivers it, and a `claw` wants a different impact sound from a
 * `butt` even on the same animal.
 */
export type AttackKind =
  | 'bite'    // jaws close on the target
  | 'claw'    // a forelimb rakes across it
  | 'gore'    // horns or antlers driven forward
  | 'butt'    // the whole skull used as a battering ram
  | 'kick'    // hind legs
  | 'rear'    // up on the hind legs, then down through the target
  | 'peck'    // a beak strike
  | 'buffet'  // wings used as clubs
  | 'talon'   // a raptor's foot
  | 'breath'  // a ranged breath weapon
  | 'lash'    // a whole-body strike (serpent)
  // The humanoid enemies. Every one of these is a WEAPON rather than a body
  // part, which is the thing that separates them from the animal vocabulary:
  // a bite is delivered by the head channel, a cleave by the arm.
  | 'cleave'  // a blade swung through an arc
  | 'thrust'  // a point driven forward
  | 'shot';   // a loosed arrow

/** One attack a species can throw. */
export interface AttackMove {
  /** Stable identifier, unique within a species. Used by tests and harnesses. */
  readonly name: string;
  readonly kind: AttackKind;
  readonly clip: Clip;
  /**
   * Seconds from the start of the clip at which the blow lands.
   *
   * This is a promise about the animation that the damage timing is allowed to
   * rely on, and `swing()` makes it structurally true rather than approximately
   * true.
   */
  readonly contactT: number;
  /** Relative likelihood among the moves currently in range. */
  readonly weight: number;
  /** Metres. The move is only eligible while the target is within this band. */
  readonly minRange: number;
  readonly maxRange: number;
}

// ---------------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------------

interface SwingSpec {
  /** Clip length in seconds. */
  dur: number;
  /** Contact time in seconds; every channel peaks here unless it declares a lag. */
  contact: number;
  /** Value at t=0 and t=dur. Defaults to 0, i.e. the neutral pose. */
  rest?: number;
  /** Value at the top of the windup. */
  wind: number;
  /** Value at contact. */
  hit: number;
  /**
   * Value at the top of the counter-swing after contact. Defaults to a 22%
   * overshoot past rest in the opposite direction to the blow, which is what
   * stops the recovery reading as a rewind of the strike.
   */
  follow?: number;
  /** Fraction of the pre-contact time at which the windup tops out. */
  windAt?: number;
  /** Fraction of the post-contact time at which the counter-swing tops out. */
  followAt?: number;
  /** Seconds this channel trails (+) or leads (-) the contact frame. */
  lag?: number;
}

/**
 * The windup / strike / follow-through / recover shape, on one channel.
 *
 * Written as a generator rather than hand-typed keys for three reasons, all of
 * which are things that went wrong somewhere in this repo before:
 *
 *   - **It returns to rest by construction.** The first and last keys are the
 *     same value, always. A one-shot clip that ends 0.04 rad off neutral leaves
 *     every creature that ever attacked holding its head slightly crooked for
 *     the rest of the session, and nothing about a still frame reveals it.
 *   - **`contactT` cannot drift out of sync with the animation.** Every channel
 *     peaks at the declared contact time because it is the same number.
 *   - **The easing is the same everywhere.** Smooth into the windup, `In` to
 *     accelerate into contact, `Out` to decelerate away from it. Symmetric
 *     timing reads as a machine; this asymmetry is what makes it read as force.
 *     Hand-typing it 60 times would get it wrong somewhere.
 *
 * A channel that needs a different shape — a jaw that snaps open and HOLDS
 * open while fire streams out of it — is hand-authored below instead. The
 * helper exists to make the common case safe, not to forbid the uncommon one.
 */
function swing(ch: Ch, s: SwingSpec): Track {
  const rest = s.rest ?? 0;
  const windAt = s.windAt ?? 0.62;
  const followAt = s.followAt ?? 0.34;
  const follow = s.follow ?? rest - (s.hit - rest) * 0.22;

  // Clamp the shifted contact well inside the clip so the four segments stay
  // strictly ordered whatever lag an author asks for.
  const lo = s.dur * 0.08;
  const hi = s.dur * 0.88;
  const c = Math.min(hi, Math.max(lo, s.contact + (s.lag ?? 0)));

  const keys: KeySpec[] = [
    [0, rest, Ease.Smooth],
    [c * windAt, s.wind, Ease.In],
    [c, s.hit, Ease.Out],
    [c + (s.dur - c) * followAt, follow, Ease.Out],
    [s.dur, rest, Ease.Smooth],
  ];
  return track(ch, keys);
}

/** Build an attack move. The clip is always a one-shot that holds its rest pose. */
function move(
  name: string, kind: AttackKind, dur: number, contact: number,
  tracks: Track[],
  opts: { weight?: number; minRange?: number; maxRange?: number } = {},
): AttackMove {
  return {
    name, kind, contactT: contact,
    clip: shotClip(name, dur, [hold(Ch.WalkAmp, 0, dur), ...tracks]),
    weight: opts.weight ?? 1,
    minRange: opts.minRange ?? 0,
    maxRange: opts.maxRange ?? 99,
  };
}

/**
 * As `move`, but without the "legs stop" `WalkAmp` hold.
 *
 * For the bird, whose builder drives its WINGS from `walkAmp`, and the sea
 * serpent, whose entire body is `walkAmp`. Zeroing that channel on those two
 * body plans does not stop the legs — it deletes the animal.
 */
function moveFree(
  name: string, kind: AttackKind, dur: number, contact: number,
  tracks: Track[],
  opts: { weight?: number; minRange?: number; maxRange?: number } = {},
): AttackMove {
  return {
    name, kind, contactT: contact, clip: shotClip(name, dur, tracks),
    weight: opts.weight ?? 1,
    minRange: opts.minRange ?? 0,
    maxRange: opts.maxRange ?? 99,
  };
}

// ===========================================================================
// QUADRUPEDS
// ===========================================================================

// --- wolf ------------------------------------------------------------------
//
// The reference attack, and the one the original single `q_attack` was. A wolf
// closes, drops, and drives its whole body through the bite; the head whips
// through centre rather than to one side, because a wolf bites what is in
// front of it.

const wolfLunge = move('wolf_lunge', 'bite', 0.52, 0.27, [
  swing(Ch.HeadYaw, { dur: 0.52, contact: 0.27, wind: 0.30, hit: -0.10, follow: -0.22 }),
  swing(Ch.HeadPitch, { dur: 0.52, contact: 0.27, wind: -0.24, hit: 0.36 }),
  swing(Ch.JawOpen, {
    dur: 0.52, contact: 0.27, wind: 0.55, hit: 0.95, follow: 0.12, lag: 0.03,
  }),
  // Sinks 9% of shoulder height on the windup, then drives PAST rest height
  // into the bite. The negative excursion is the only part of a wolf attack a
  // player currently sees from more than a few metres away.
  swing(Ch.BodySink, { dur: 0.52, contact: 0.27, wind: 0.09, hit: -0.075, follow: 0.02 }),
  swing(Ch.TailSway, { dur: 0.52, contact: 0.27, wind: -0.30, hit: 0.40 }),
], { minRange: 1.5, maxRange: 3.4 });

/**
 * The in-close answer: no room to lunge, so it is all neck. Half the duration
 * of the lunge and the head goes ACROSS rather than forward, which is what
 * separates a wolf worrying at something from a wolf committing to it.
 */
const wolfSnap = move('wolf_snap', 'bite', 0.30, 0.14, [
  swing(Ch.HeadYaw, { dur: 0.30, contact: 0.14, wind: 0.18, hit: -0.36, follow: 0.08 }),
  swing(Ch.HeadPitch, { dur: 0.30, contact: 0.14, wind: -0.14, hit: 0.20 }),
  swing(Ch.JawOpen, { dur: 0.30, contact: 0.14, wind: 0.62, hit: 0.90, follow: 0.10, lag: 0.02 }),
  swing(Ch.BodySink, { dur: 0.30, contact: 0.14, wind: 0.035, hit: -0.03 }),
  swing(Ch.TailSway, { dur: 0.30, contact: 0.14, wind: 0.22, hit: -0.28 }),
], { weight: 0.85, minRange: 0, maxRange: 2.1 });

// --- bear ------------------------------------------------------------------
//
// The bear is the species that most wants a limb channel and least has one.
// A swipe is authored as REAR-THEN-SLAM: `BodySink` goes negative through the
// windup (up on the hind legs) and positive through contact (the whole mass
// coming down behind the paw), while `HeadYaw` sweeps one way across the body
// tracking a forelimb the rig cannot draw. That one-way sweep is the entire
// difference between a claw and a bite in the current channel set, so the
// backhand exists as a separate move rather than as a mirrored flag: mirroring
// at sample time would have to negate a channel AFTER the crossfade snapshot
// was taken, and the first frame of the next fade would then pop by twice the
// head angle.

const bearSwipe = move('bear_swipe', 'claw', 0.72, 0.34, [
  swing(Ch.HeadYaw, {
    dur: 0.72, contact: 0.34, wind: 0.52, hit: -0.44, follow: -0.12, windAt: 0.70,
  }),
  swing(Ch.HeadPitch, { dur: 0.72, contact: 0.34, wind: -0.42, hit: 0.30 }),
  // Roar, not a bite: open early, wide-ish, and stay open through the swing.
  swing(Ch.JawOpen, { dur: 0.72, contact: 0.34, wind: 0.30, hit: 0.48, follow: 0.10 }),
  swing(Ch.BodySink, {
    dur: 0.72, contact: 0.34, wind: -0.10, hit: 0.05, follow: -0.01, windAt: 0.72,
  }),
  swing(Ch.TailSway, { dur: 0.72, contact: 0.34, wind: 0.30, hit: -0.40 }),
  // The actual paw. Until ForeSwing existed this attack was a head sweep
  // standing in for a limb, because a planted quadruped's stride amplitude is
  // zero and nothing else in the pose could reach a foreleg. Cocks back on the
  // windup, drives through well past contact.
  swing(Ch.ForeSwing, {
    dur: 0.72, contact: 0.34, wind: -0.34, hit: 0.95, follow: 0.18, windAt: 0.66,
  }),
], { minRange: 1.3, maxRange: 3.6 });

/** The backhand. Shorter, because it comes off the end of the forehand. */
const bearBackhand = move('bear_backhand', 'claw', 0.64, 0.29, [
  swing(Ch.HeadYaw, {
    dur: 0.64, contact: 0.29, wind: -0.46, hit: 0.48, follow: 0.14, windAt: 0.68,
  }),
  swing(Ch.HeadPitch, { dur: 0.64, contact: 0.29, wind: -0.34, hit: 0.26 }),
  swing(Ch.JawOpen, { dur: 0.64, contact: 0.29, wind: 0.26, hit: 0.44, follow: 0.08 }),
  swing(Ch.BodySink, {
    dur: 0.64, contact: 0.29, wind: -0.075, hit: 0.045, follow: -0.01, windAt: 0.70,
  }),
  swing(Ch.TailSway, { dur: 0.64, contact: 0.29, wind: -0.26, hit: 0.34 }),
  // Coming off the forehand, so the paw starts already extended and sweeps
  // back across rather than winding up again.
  swing(Ch.ForeSwing, {
    dur: 0.64, contact: 0.29, wind: 0.70, hit: -0.28, follow: -0.05, windAt: 0.30,
  }),
], { weight: 0.9, minRange: 1.3, maxRange: 3.6 });

/** In close, a bear stops swiping and starts biting. Low, forward, jaw wide. */
const bearMaul = move('bear_maul', 'bite', 0.58, 0.28, [
  swing(Ch.HeadYaw, { dur: 0.58, contact: 0.28, wind: 0.22, hit: -0.14, follow: -0.18 }),
  swing(Ch.HeadPitch, { dur: 0.58, contact: 0.28, wind: -0.20, hit: 0.44 }),
  swing(Ch.JawOpen, { dur: 0.58, contact: 0.28, wind: 0.58, hit: 0.96, follow: 0.14, lag: 0.03 }),
  swing(Ch.BodySink, { dur: 0.58, contact: 0.28, wind: 0.11, hit: -0.06, follow: 0.03 }),
  swing(Ch.TailSway, { dur: 0.58, contact: 0.28, wind: -0.22, hit: 0.28 }),
], { weight: 0.75, minRange: 0, maxRange: 1.9 });

// --- deer ------------------------------------------------------------------
//
// Antlers. The whole animal is a delivery system for the head, so the yaw is
// small (a hook at the end of the thrust rather than a sweep) and the drive is
// in `BodySink` and `HeadPitch`.

const deerGore = move('deer_gore', 'gore', 0.56, 0.26, [
  swing(Ch.HeadYaw, { dur: 0.56, contact: 0.26, wind: -0.18, hit: 0.28, follow: 0.06 }),
  swing(Ch.HeadPitch, { dur: 0.56, contact: 0.26, wind: -0.58, hit: 0.62 }),
  swing(Ch.BodySink, { dur: 0.56, contact: 0.26, wind: 0.07, hit: -0.085, follow: 0.02 }),
  swing(Ch.TailSway, { dur: 0.56, contact: 0.26, wind: 0.18, hit: -0.24 }),
], { minRange: 1.1, maxRange: 3.2 });

/**
 * Rearing and striking down with the forehooves — what a hornless deer, or one
 * with something already inside its antlers, actually does. The only quadruped
 * attack whose windup is longer than its strike, which is exactly the read:
 * slow, deliberate rise, then the drop happens all at once.
 */
const deerRear = move('deer_rear', 'rear', 0.88, 0.46, [
  swing(Ch.HeadYaw, { dur: 0.88, contact: 0.46, wind: 0.12, hit: -0.10 }),
  swing(Ch.HeadPitch, { dur: 0.88, contact: 0.46, wind: -0.62, hit: 0.34, windAt: 0.80 }),
  swing(Ch.BodySink, {
    dur: 0.88, contact: 0.46, wind: -0.105, hit: 0.06, follow: -0.01, windAt: 0.80,
  }),
  swing(Ch.TailSway, { dur: 0.88, contact: 0.46, wind: 0.20, hit: -0.20 }),
], { weight: 0.5, minRange: 0, maxRange: 2.6 });

// --- cow -------------------------------------------------------------------
//
// Mass. Everything slow, everything heavy, the recovery longer than the strike
// because a cow that has committed its head cannot take it back.

const cowButt = move('cow_butt', 'butt', 0.72, 0.36, [
  swing(Ch.HeadYaw, { dur: 0.72, contact: 0.36, wind: 0.24, hit: -0.26 }),
  swing(Ch.HeadPitch, { dur: 0.72, contact: 0.36, wind: -0.30, hit: 0.52 }),
  swing(Ch.BodySink, {
    dur: 0.72, contact: 0.36, wind: 0.10, hit: -0.055, follow: 0.03, followAt: 0.40,
  }),
  swing(Ch.TailSway, { dur: 0.72, contact: 0.36, wind: -0.22, hit: 0.26 }),
], { minRange: 0.8, maxRange: 3.0 });

/**
 * Cows kick, and they kick sideways and without warning. No head yaw at all,
 * a very short windup, and the body pops UP at contact as the hindquarters
 * come off the ground.
 */
const cowKick = move('cow_kick', 'kick', 0.44, 0.19, [
  swing(Ch.HeadPitch, { dur: 0.44, contact: 0.19, wind: 0.10, hit: -0.38 }),
  swing(Ch.BodySink, {
    dur: 0.44, contact: 0.19, wind: 0.045, hit: -0.10, follow: 0.025, windAt: 0.55,
  }),
  swing(Ch.TailSway, { dur: 0.44, contact: 0.19, wind: 0.30, hit: -0.42 }),
], { weight: 0.45, minRange: 0, maxRange: 2.3 });

// --- horse -----------------------------------------------------------------

/** The classic. Nearly a second long, and most of it is the rise. */
const horseRear = move('horse_rear', 'rear', 0.96, 0.50, [
  swing(Ch.HeadYaw, { dur: 0.96, contact: 0.50, wind: 0.10, hit: -0.08 }),
  swing(Ch.HeadPitch, { dur: 0.96, contact: 0.50, wind: -0.66, hit: 0.28, windAt: 0.82 }),
  swing(Ch.BodySink, {
    dur: 0.96, contact: 0.50, wind: -0.115, hit: 0.055, follow: -0.012, windAt: 0.82,
  }),
  swing(Ch.TailSway, { dur: 0.96, contact: 0.50, wind: 0.24, hit: -0.26 }),
  // The forelegs leaving the ground is the whole point of a rear. BodySink
  // alone lifts the entire animal, feet included, which reads as levitation;
  // this is what actually raises the forehand.
  swing(Ch.ForeSwing, {
    dur: 0.96, contact: 0.50, wind: 0.30, hit: 1.15, follow: 0.35, windAt: 0.55,
  }),
], { minRange: 1.0, maxRange: 3.2 });

/** Both barrels. The fastest quadruped attack in the file. */
const horseKick = move('horse_kick', 'kick', 0.42, 0.18, [
  swing(Ch.HeadPitch, { dur: 0.42, contact: 0.18, wind: 0.14, hit: -0.52 }),
  swing(Ch.BodySink, {
    dur: 0.42, contact: 0.18, wind: 0.05, hit: -0.115, follow: 0.03, windAt: 0.55,
  }),
  swing(Ch.TailSway, { dur: 0.42, contact: 0.18, wind: -0.34, hit: 0.46 }),
], { weight: 0.75, minRange: 0, maxRange: 2.4 });

const horseBite = move('horse_bite', 'bite', 0.40, 0.19, [
  swing(Ch.HeadYaw, { dur: 0.40, contact: 0.19, wind: 0.26, hit: -0.20 }),
  swing(Ch.HeadPitch, { dur: 0.40, contact: 0.19, wind: -0.20, hit: 0.30 }),
  swing(Ch.JawOpen, { dur: 0.40, contact: 0.19, wind: 0.45, hit: 0.75, follow: 0.10, lag: 0.02 }),
  swing(Ch.BodySink, { dur: 0.40, contact: 0.19, wind: 0.05, hit: -0.04 }),
], { weight: 0.35, minRange: 0, maxRange: 2.0 });

// --- donkey ----------------------------------------------------------------
//
// Same two moves as the horse with the weights inverted, which is the whole
// characterisation: a horse rears, a donkey kicks.

const donkeyKick = move('donkey_kick', 'kick', 0.40, 0.17, [
  swing(Ch.HeadPitch, { dur: 0.40, contact: 0.17, wind: 0.16, hit: -0.50 }),
  swing(Ch.BodySink, {
    dur: 0.40, contact: 0.17, wind: 0.05, hit: -0.11, follow: 0.03, windAt: 0.52,
  }),
  swing(Ch.TailSway, { dur: 0.40, contact: 0.17, wind: 0.32, hit: -0.44 }),
], { minRange: 0, maxRange: 2.8 });

const donkeyBite = move('donkey_bite', 'bite', 0.42, 0.20, [
  swing(Ch.HeadYaw, { dur: 0.42, contact: 0.20, wind: 0.28, hit: -0.22 }),
  swing(Ch.HeadPitch, { dur: 0.42, contact: 0.20, wind: -0.18, hit: 0.32 }),
  swing(Ch.JawOpen, { dur: 0.42, contact: 0.20, wind: 0.48, hit: 0.78, follow: 0.10, lag: 0.02 }),
  swing(Ch.BodySink, { dur: 0.42, contact: 0.20, wind: 0.055, hit: -0.045 }),
], { weight: 0.5, minRange: 0, maxRange: 2.2 });

// --- rabbit ----------------------------------------------------------------
//
// A rabbit's fight is one move it does not want to make. Both clips are the
// shortest in the file and the kick's body excursion is the largest relative to
// the animal, because a cornered rabbit's kick throws its whole body.

const rabbitKick = move('rabbit_kick', 'kick', 0.34, 0.14, [
  swing(Ch.HeadPitch, { dur: 0.34, contact: 0.14, wind: 0.20, hit: -0.46 }),
  swing(Ch.BodySink, {
    dur: 0.34, contact: 0.14, wind: 0.06, hit: -0.125, follow: 0.035, windAt: 0.50,
  }),
  swing(Ch.TailSway, { dur: 0.34, contact: 0.14, wind: 0.28, hit: -0.36 }),
], { minRange: 0, maxRange: 2.6 });

const rabbitNip = move('rabbit_nip', 'bite', 0.26, 0.11, [
  swing(Ch.HeadYaw, { dur: 0.26, contact: 0.11, wind: 0.20, hit: -0.24 }),
  swing(Ch.HeadPitch, { dur: 0.26, contact: 0.11, wind: -0.16, hit: 0.30 }),
  swing(Ch.JawOpen, { dur: 0.26, contact: 0.11, wind: 0.50, hit: 0.82, follow: 0.08, lag: 0.015 }),
  swing(Ch.BodySink, { dur: 0.26, contact: 0.11, wind: 0.04, hit: -0.035 }),
], { weight: 0.55, minRange: 0, maxRange: 1.5 });

// ===========================================================================
// BIRD  —  `WalkAmp` is the WING channel on this rig (see clips-winged.ts)
// ===========================================================================

/**
 * A peck: wings snap out to brake and balance, then the head goes in.
 *
 * The head tracks are NOT stepped, unlike every other bird clip. Bird head
 * MOTION is stepped because a bird holds a heading and jumps to a new one — but
 * a strike is a continuous accelerating movement, and stepping it would
 * teleport the beak through the target rather than drive it in.
 */
const birdPeck = moveFree('bird_peck', 'peck', 0.34, 0.16, [
  swing(Ch.WalkAmp, {
    dur: 0.34, contact: 0.16, rest: 0.08, wind: 0.80, hit: 0.50, follow: 0.20,
  }),
  swing(Ch.HeadPitch, { dur: 0.34, contact: 0.16, wind: -0.28, hit: 0.58 }),
  swing(Ch.BodySink, { dur: 0.34, contact: 0.16, wind: 0.05, hit: -0.065 }),
], { minRange: 0, maxRange: 2.6 });

/** Wings as clubs. Full beat amplitude held through contact. */
const birdBuffet = moveFree('bird_buffet', 'buffet', 0.52, 0.26, [
  swing(Ch.WalkAmp, {
    dur: 0.52, contact: 0.26, rest: 0.08, wind: 0.34, hit: 0.95, follow: 0.45,
    windAt: 0.55,
  }),
  swing(Ch.HeadYaw, { dur: 0.52, contact: 0.26, wind: 0.40, hit: -0.34, follow: -0.10 }),
  swing(Ch.HeadPitch, { dur: 0.52, contact: 0.26, wind: -0.30, hit: 0.18 }),
  swing(Ch.BodySink, { dur: 0.52, contact: 0.26, wind: 0.04, hit: -0.10, follow: 0.02 }),
], { weight: 0.6, minRange: 0, maxRange: 3.0 });

// ===========================================================================
// DRAGON  —  jaws AND fire, because it has both
// ===========================================================================

/**
 * The bite. The wing beat SPIKES ON THE WINDUP, not on contact: the wings are
 * what lift the creature into the strike, so they lead it. Peaking them at
 * contact would read as flapping about after the fact.
 */
const dragonBite = move('dragon_bite', 'bite', 0.62, 0.34, [
  swing(Ch.FlapAmp, {
    dur: 0.62, contact: 0.34, rest: 0.30, wind: 0.94, hit: 0.55, follow: 0.34,
    windAt: 0.55,
  }),
  swing(Ch.FlapRate, {
    dur: 0.62, contact: 0.34, rest: 1.0, wind: 1.9, hit: 1.2, follow: 0.9, windAt: 0.55,
  }),
  swing(Ch.JawOpen, { dur: 0.62, contact: 0.34, wind: 0.70, hit: 0.94, follow: 0.10, lag: 0.02 }),
  swing(Ch.HeadPitch, { dur: 0.62, contact: 0.34, wind: -0.36, hit: 0.40 }),
  swing(Ch.HeadYaw, { dur: 0.62, contact: 0.34, wind: 0.24, hit: -0.16 }),
  swing(Ch.BodySink, { dur: 0.62, contact: 0.34, wind: 0.07, hit: -0.09 }),
  swing(Ch.TailSway, { dur: 0.62, contact: 0.34, wind: -0.34, hit: 0.44 }),
], { minRange: 0, maxRange: 4.5 });

/**
 * Fire. The one attack in the file whose signature channel is NOT a swing.
 *
 * A breath weapon is open-and-HOLD: the jaw cracks, clamps shut as the creature
 * inhales (the value goes DOWN before it goes up — that is the tell that says
 * "it is drawing breath" rather than "it is about to bite"), snaps wide at
 * contact and then stays wide for 0.4 s while the fire streams. `swing()`
 * cannot express a hold, so the jaw is hand-authored and only the postural
 * channels use the helper.
 *
 * `contactT` is the moment the jaw reaches full open, which is when a fire
 * effect should be spawned.
 */
const dragonBreath = move('dragon_breath', 'breath', 0.95, 0.44, [
  track(Ch.JawOpen, [
    [0, 0, Ease.Smooth],
    [0.17, 0.16, Ease.Smooth],   // cracks open
    [0.31, 0.04, Ease.In],       // clamps shut: the inhale
    [0.44, 0.92, Ease.Out],      // snaps wide — CONTACT
    [0.75, 0.86, Ease.Out],      // held wide while it burns
    [0.86, 0.26, Ease.Out],
    [0.95, 0, Ease.Smooth],
  ]),
  // Rears back and beats to hold station, then settles while breathing.
  track(Ch.FlapAmp, [
    [0, 0.30, Ease.Smooth], [0.30, 0.86, Ease.Out], [0.44, 0.52, Ease.Smooth],
    [0.75, 0.40, Ease.Smooth], [0.95, 0.30, Ease.Smooth],
  ]),
  track(Ch.FlapRate, [
    [0, 1.0, Ease.Smooth], [0.30, 1.7, Ease.Out], [0.50, 0.85, Ease.Smooth],
    [0.95, 1.0, Ease.Smooth],
  ]),
  track(Ch.HeadPitch, [
    [0, 0, Ease.Smooth], [0.34, -0.54, Ease.In], [0.44, 0.10, Ease.Out],
    [0.75, 0.16, Ease.Out], [0.95, 0, Ease.Smooth],
  ]),
  swing(Ch.BodySink, {
    dur: 0.95, contact: 0.44, wind: 0.06, hit: -0.05, follow: 0.02, windAt: 0.76,
  }),
  swing(Ch.TailSway, { dur: 0.95, contact: 0.44, wind: -0.30, hit: 0.30 }),
], { minRange: 1.6, maxRange: 30 });

// ===========================================================================
// WYVERN  —  jaws first, fire second, and it has feet
// ===========================================================================

const wyvernBite = move('wyvern_bite', 'bite', 0.56, 0.29, [
  swing(Ch.FlapAmp, {
    dur: 0.56, contact: 0.29, rest: 0.30, wind: 0.92, hit: 0.52, follow: 0.34,
    windAt: 0.55,
  }),
  swing(Ch.FlapRate, {
    dur: 0.56, contact: 0.29, rest: 1.0, wind: 2.0, hit: 1.2, follow: 0.9, windAt: 0.55,
  }),
  swing(Ch.JawOpen, { dur: 0.56, contact: 0.29, wind: 0.72, hit: 0.95, follow: 0.10, lag: 0.02 }),
  swing(Ch.HeadPitch, { dur: 0.56, contact: 0.29, wind: -0.38, hit: 0.44 }),
  swing(Ch.HeadYaw, { dur: 0.56, contact: 0.29, wind: 0.26, hit: -0.18 }),
  swing(Ch.BodySink, { dur: 0.56, contact: 0.29, wind: 0.075, hit: -0.095 }),
  swing(Ch.TailSway, { dur: 0.56, contact: 0.29, wind: -0.36, hit: 0.46 }),
], { weight: 1.3, minRange: 0, maxRange: 4.0 });

/** Shorter and hotter than the dragon's — less lung, same idea. */
const wyvernBreath = move('wyvern_breath', 'breath', 0.90, 0.42, [
  track(Ch.JawOpen, [
    [0, 0, Ease.Smooth], [0.16, 0.16, Ease.Smooth], [0.29, 0.04, Ease.In],
    [0.42, 0.90, Ease.Out], [0.70, 0.84, Ease.Out], [0.81, 0.24, Ease.Out],
    [0.90, 0, Ease.Smooth],
  ]),
  track(Ch.FlapAmp, [
    [0, 0.30, Ease.Smooth], [0.28, 0.88, Ease.Out], [0.42, 0.54, Ease.Smooth],
    [0.70, 0.40, Ease.Smooth], [0.90, 0.30, Ease.Smooth],
  ]),
  track(Ch.FlapRate, [
    [0, 1.0, Ease.Smooth], [0.28, 1.9, Ease.Out], [0.48, 0.9, Ease.Smooth],
    [0.90, 1.0, Ease.Smooth],
  ]),
  track(Ch.HeadPitch, [
    [0, 0, Ease.Smooth], [0.32, -0.50, Ease.In], [0.42, 0.10, Ease.Out],
    [0.70, 0.16, Ease.Out], [0.90, 0, Ease.Smooth],
  ]),
  swing(Ch.BodySink, {
    dur: 0.90, contact: 0.42, wind: 0.06, hit: -0.05, follow: 0.02, windAt: 0.76,
  }),
  swing(Ch.TailSway, { dur: 0.90, contact: 0.42, wind: -0.28, hit: 0.28 }),
], { weight: 0.7, minRange: 1.5, maxRange: 26 });

/**
 * The wyvern is a biped that stands on its hind feet, so a talon strike is a
 * real thing for it to do: it beats up onto the wings, holds, and drives a foot
 * down. Everything visible is in `FlapAmp` and `BodySink` — the leg itself is
 * speed-gated like any planted rig and cannot be posed from a clip.
 */
const wyvernTalon = move('wyvern_talon', 'talon', 0.66, 0.32, [
  swing(Ch.FlapAmp, {
    dur: 0.66, contact: 0.32, rest: 0.30, wind: 0.95, hit: 0.70, follow: 0.36,
    windAt: 0.72,
  }),
  swing(Ch.FlapRate, {
    dur: 0.66, contact: 0.32, rest: 1.0, wind: 1.6, hit: 1.1, follow: 0.9, windAt: 0.72,
  }),
  swing(Ch.HeadPitch, { dur: 0.66, contact: 0.32, wind: -0.30, hit: 0.50 }),
  swing(Ch.HeadYaw, { dur: 0.66, contact: 0.32, wind: 0.34, hit: -0.28, follow: -0.08 }),
  swing(Ch.JawOpen, { dur: 0.66, contact: 0.32, wind: 0.28, hit: 0.46, follow: 0.08 }),
  swing(Ch.BodySink, {
    dur: 0.66, contact: 0.32, wind: -0.105, hit: 0.05, follow: -0.015, windAt: 0.74,
  }),
  swing(Ch.TailSway, { dur: 0.66, contact: 0.32, wind: 0.30, hit: -0.36 }),
], { weight: 0.6, minRange: 0, maxRange: 3.4 });

// ===========================================================================
// GRIFFIN  —  talons, and a beak it has no jaw joint for
// ===========================================================================

/**
 * The mantle-and-rake. Rises on the wings through the windup (`BodySink`
 * negative, `FlapAmp` at full), then drives down through the target.
 *
 * `HeadYaw` sweeps one way, exactly as the bear's does and for the same reason:
 * a one-way head sweep is the only thing in the current channel set that reads
 * as a limb travelling across the body.
 */
const griffinTalon = move('griffin_talon', 'talon', 0.58, 0.27, [
  swing(Ch.FlapAmp, {
    dur: 0.58, contact: 0.27, rest: 0.35, wind: 0.95, hit: 0.62, follow: 0.40,
    windAt: 0.70,
  }),
  swing(Ch.FlapRate, {
    dur: 0.58, contact: 0.27, rest: 1.0, wind: 2.1, hit: 1.2, follow: 0.9, windAt: 0.70,
  }),
  swing(Ch.HeadYaw, {
    dur: 0.58, contact: 0.27, wind: 0.42, hit: -0.32, follow: -0.10, windAt: 0.68,
  }),
  swing(Ch.HeadPitch, { dur: 0.58, contact: 0.27, wind: -0.36, hit: 0.44 }),
  swing(Ch.BodySink, {
    dur: 0.58, contact: 0.27, wind: -0.095, hit: 0.05, follow: -0.015, windAt: 0.72,
  }),
  swing(Ch.TailSway, { dur: 0.58, contact: 0.27, wind: 0.32, hit: -0.38 }),
], { minRange: 0, maxRange: 3.8 });

/**
 * The beak. `buildGriffin` has no jaw joint — `jawOpen` is a silent no-op on
 * this species — so the strike is authored entirely on the head and the body,
 * and the clip deliberately does NOT waste a track on a channel that goes
 * nowhere for this rig.
 */
const griffinBeak = move('griffin_beak', 'peck', 0.38, 0.18, [
  swing(Ch.FlapAmp, {
    dur: 0.38, contact: 0.18, rest: 0.35, wind: 0.62, hit: 0.44, follow: 0.36,
  }),
  swing(Ch.FlapRate, { dur: 0.38, contact: 0.18, rest: 1.0, wind: 1.5, hit: 1.1, follow: 0.95 }),
  swing(Ch.HeadYaw, { dur: 0.38, contact: 0.18, wind: 0.22, hit: -0.18 }),
  swing(Ch.HeadPitch, { dur: 0.38, contact: 0.18, wind: -0.32, hit: 0.58 }),
  swing(Ch.BodySink, { dur: 0.38, contact: 0.18, wind: 0.05, hit: -0.06 }),
], { weight: 0.7, minRange: 0, maxRange: 2.6 });

// ===========================================================================
// SEA SERPENT  —  one channel, two completely different attacks
// ===========================================================================

/**
 * The coil-and-lash. Amplitude collapses almost to nothing (the coil), spikes
 * past full, and settles back through an overshoot.
 *
 * `rest` is 0.22, not 0: the serpent's idle amplitude. A serpent whose attack
 * ended at zero undulation would finish every strike as a length of rope.
 */
const serpentStrike = moveFree('serpent_strike', 'lash', 0.48, 0.26, [
  swing(Ch.WalkAmp, {
    dur: 0.48, contact: 0.26, rest: 0.22, wind: 0.04, hit: 0.96, follow: 0.44,
    windAt: 0.58,
  }),
  swing(Ch.BodySink, { dur: 0.48, contact: 0.26, wind: 0.05, hit: -0.07 }),
], { minRange: 1.2, maxRange: 5.0 });

/**
 * The thrash: no coil, no single contact point, just the whole body going over
 * at full amplitude and STAYING there for a third of a second.
 *
 * Hand-authored rather than a `swing()` because the defining feature is the
 * plateau — the difference between "it struck" and "it is thrashing" is that
 * the second one does not stop.
 */
const serpentThrash = moveFree('serpent_thrash', 'lash', 0.90, 0.38, [
  track(Ch.WalkAmp, [
    [0, 0.22, Ease.Smooth],
    [0.20, 0.44, Ease.In],
    [0.38, 0.96, Ease.Out],     // CONTACT
    [0.62, 0.92, Ease.Out],     // held over
    [0.76, 0.46, Ease.Out],
    [0.90, 0.22, Ease.Smooth],
  ]),
  track(Ch.BodySink, [
    [0, 0, Ease.Smooth], [0.20, 0.04, Ease.In], [0.38, -0.06, Ease.Out],
    [0.62, -0.04, Ease.Out], [0.90, 0, Ease.Smooth],
  ]),
], { weight: 0.6, minRange: 0, maxRange: 6.0 });

// ===========================================================================
// The table
// ===========================================================================

/**
 * Every species' attacks, most characteristic first.
 *
 * Ordering is not load-bearing for selection (that is `weight` and range) but
 * it is load-bearing for READING this file: the first entry is what the animal
 * is known for.
 */
// ===========================================================================
// HUMANOID ENEMIES
//
// These fight with their ARMS, which is a channel the animal roster barely
// touches: a quadruped's `ForeSwing` was added so a bear could swipe, and for
// these four it carries the entire attack. `HeadYaw`/`HeadPitch` are the
// counterweight rather than the delivery, and `TailSway` is a torso twist on
// this rig (see `clips-humanoid.ts`) — so a swing is authored as arm forward,
// shoulders round, head answering, which is what a person actually does.
//
// The cadence rule from `test-anim.mts` binds hard here and is worth stating,
// because it is the reason a boss cannot have a two-second wind-up:
//
//     a.recovery + b.windup <= attackCooldown(species) - SWING_GAP
//
// for every ordered pair within a species. It is why `dread_king` carries its
// own 1.9 s cooldown in `SPECIES_DEFS` — at the shared 1.2 s the overhead slam
// below is arithmetically impossible, and shortening it until it fits would
// have produced a boss that pecks at you.
// ===========================================================================

// --- goblin ----------------------------------------------------------------
//
// Fast and cheap. A goblin does not commit; it darts in, hacks, and is already
// leaning back out. Both moves are under half a second, which is what makes a
// group of them feel like being swarmed rather than duelled.

const goblinSlash = move('goblin_slash', 'cleave', 0.42, 0.21, [
  swing(Ch.ForeSwing, {
    dur: 0.42, contact: 0.21, wind: -0.34, hit: 1.02, follow: 0.16, windAt: 0.55,
  }),
  swing(Ch.TailSway, { dur: 0.42, contact: 0.21, wind: 0.30, hit: -0.40 }),
  swing(Ch.HeadYaw, { dur: 0.42, contact: 0.21, wind: 0.22, hit: -0.24 }),
  swing(Ch.HeadPitch, { dur: 0.42, contact: 0.21, wind: -0.14, hit: 0.24 }),
  swing(Ch.JawOpen, {
    dur: 0.42, contact: 0.21, wind: 0.44, hit: 0.80, follow: 0.10, lag: 0.02,
  }),
  // Drops onto the front foot through the blow. Small, because a goblin has
  // very little mass to put behind anything.
  swing(Ch.BodySink, { dur: 0.42, contact: 0.21, wind: 0.045, hit: -0.030, follow: 0.012 }),
], { minRange: 1.1, maxRange: 2.8 });

/** In close there is no room to swing, so it stabs. Faster still. */
const goblinStab = move('goblin_stab', 'thrust', 0.36, 0.18, [
  swing(Ch.ForeSwing, {
    dur: 0.36, contact: 0.18, wind: -0.20, hit: 0.86, follow: 0.10, windAt: 0.50,
  }),
  swing(Ch.TailSway, { dur: 0.36, contact: 0.18, wind: -0.20, hit: 0.26 }),
  swing(Ch.HeadPitch, { dur: 0.36, contact: 0.18, wind: -0.10, hit: 0.30 }),
  swing(Ch.JawOpen, {
    dur: 0.36, contact: 0.18, wind: 0.50, hit: 0.88, follow: 0.12, lag: 0.02,
  }),
  swing(Ch.BodySink, { dur: 0.36, contact: 0.18, wind: 0.030, hit: -0.045 }),
], { weight: 0.9, minRange: 0, maxRange: 1.9 });

// --- goblin archer ---------------------------------------------------------

/**
 * Draw and loose.
 *
 * The long windup here is not decoration — it is the telegraph. `contactT` is
 * 0.44 s, so `creature-anim` starts the clip 0.44 s before the arrow leaves,
 * and the player gets almost half a second of a visibly-drawn bow to react to.
 * That window is the entire counterplay against a ranged enemy, and it only
 * exists because the contact frame and the damage tick are the same number.
 */
const archerLoose = move('archer_loose', 'shot', 0.70, 0.44, [
  // The draw hand comes back (negative) and snaps forward as the string goes.
  swing(Ch.ForeSwing, {
    dur: 0.70, contact: 0.44, wind: -0.46, hit: 0.28, follow: -0.10, windAt: 0.80,
  }),
  swing(Ch.TailSway, { dur: 0.70, contact: 0.44, wind: 0.26, hit: -0.14 }),
  swing(Ch.HeadPitch, { dur: 0.70, contact: 0.44, wind: 0.06, hit: -0.06 }),
  swing(Ch.BodySink, { dur: 0.70, contact: 0.44, wind: 0.020, hit: -0.010 }),
], { minRange: 2.4, maxRange: 99 });

/** Something is on top of it. Panicked, weak, and it would rather be running. */
const archerJab = move('archer_jab', 'thrust', 0.34, 0.17, [
  swing(Ch.ForeSwing, {
    dur: 0.34, contact: 0.17, wind: -0.16, hit: 0.72, follow: 0.08, windAt: 0.48,
  }),
  swing(Ch.HeadYaw, { dur: 0.34, contact: 0.17, wind: 0.26, hit: -0.20 }),
  swing(Ch.JawOpen, {
    dur: 0.34, contact: 0.17, wind: 0.60, hit: 0.92, follow: 0.14,
  }),
  swing(Ch.BodySink, { dur: 0.34, contact: 0.17, wind: 0.020, hit: 0.030 }),
], { weight: 1, minRange: 0, maxRange: 2.6 });

// --- skeleton --------------------------------------------------------------
//
// Slower and heavier than a goblin, and with none of the flinch. The
// characteristic note is that nothing here recoils or protects itself: a
// skeleton's follow-through carries it forward into the next blow because
// there is no instinct telling it not to.

const skeletonChop = move('skeleton_chop', 'cleave', 0.72, 0.40, [
  swing(Ch.ForeSwing, {
    dur: 0.72, contact: 0.40, wind: -0.46, hit: 1.10, follow: 0.20, windAt: 0.66,
  }),
  swing(Ch.TailSway, { dur: 0.72, contact: 0.40, wind: 0.40, hit: -0.48 }),
  swing(Ch.HeadPitch, { dur: 0.72, contact: 0.40, wind: -0.22, hit: 0.38 }),
  swing(Ch.JawOpen, {
    dur: 0.72, contact: 0.40, rest: 0.22, wind: 0.52, hit: 0.82, follow: 0.32,
  }),
  swing(Ch.BodySink, { dur: 0.72, contact: 0.40, wind: 0.050, hit: -0.020, follow: 0.030 }),
], { minRange: 1.2, maxRange: 3.0 });

/** A straight thrust with the whole body behind it. No guard, no recovery. */
const skeletonThrust = move('skeleton_thrust', 'thrust', 0.60, 0.34, [
  swing(Ch.ForeSwing, {
    dur: 0.60, contact: 0.34, wind: -0.30, hit: 1.16, follow: 0.24, windAt: 0.55,
  }),
  swing(Ch.TailSway, { dur: 0.60, contact: 0.34, wind: -0.26, hit: 0.34 }),
  swing(Ch.HeadPitch, { dur: 0.60, contact: 0.34, wind: -0.12, hit: 0.26 }),
  swing(Ch.JawOpen, {
    dur: 0.60, contact: 0.34, rest: 0.22, wind: 0.44, hit: 0.76, follow: 0.30,
  }),
  // Lunges — the body drives PAST rest height into the point.
  swing(Ch.BodySink, { dur: 0.60, contact: 0.34, wind: 0.055, hit: -0.075, follow: 0.020 }),
], { weight: 0.95, minRange: 0.8, maxRange: 3.2 });

/** In close: a backhand off the end of the previous swing. */
const skeletonBackhand = move('skeleton_backhand', 'cleave', 0.66, 0.36, [
  swing(Ch.ForeSwing, {
    // Starts already extended and sweeps back across, so it reads as the
    // return half of a figure-of-eight rather than as a second wind-up.
    dur: 0.66, contact: 0.36, wind: 0.82, hit: -0.30, follow: -0.06, windAt: 0.28,
  }),
  swing(Ch.TailSway, { dur: 0.66, contact: 0.36, wind: -0.44, hit: 0.52 }),
  swing(Ch.HeadYaw, { dur: 0.66, contact: 0.36, wind: -0.36, hit: 0.40 }),
  swing(Ch.JawOpen, {
    dur: 0.66, contact: 0.36, rest: 0.22, wind: 0.42, hit: 0.72, follow: 0.30,
  }),
  swing(Ch.BodySink, { dur: 0.66, contact: 0.36, wind: 0.030, hit: -0.015 }),
], { weight: 0.8, minRange: 0, maxRange: 2.2 });

// --- dread king ------------------------------------------------------------
//
// Three moves that mean three different things, which is the whole reason a
// boss is a boss rather than a big skeleton:
//
//   `king_cleave`   — the long horizontal. It is the reason his reach is 4.1 m
//                     and the reason backing off one step does not save you.
//   `king_overhead` — the punisher. Slowest, biggest telegraph, biggest
//                     commitment on both sides.
//   `king_thrust`   — the answer to standing inside his guard, and the only
//                     one of the three that is fast.
//
// A player who learns which of the three is coming can fight him. That is what
// "more than one attack" is for; three attacks the player cannot tell apart
// would be one attack with a random duration.

const kingCleave = move('king_cleave', 'cleave', 1.05, 0.58, [
  swing(Ch.ForeSwing, {
    dur: 1.05, contact: 0.58, wind: -0.48, hit: 1.14, follow: 0.22, windAt: 0.70,
  }),
  // The torso is the engine on this one — the arm barely moves relative to the
  // shoulders, which is how a two-handed sweep actually generates its speed.
  swing(Ch.TailSway, { dur: 1.05, contact: 0.58, wind: 0.62, hit: -0.72, windAt: 0.72 }),
  swing(Ch.HeadYaw, { dur: 1.05, contact: 0.58, wind: 0.44, hit: -0.52 }),
  swing(Ch.HeadPitch, { dur: 1.05, contact: 0.58, wind: -0.18, hit: 0.20 }),
  swing(Ch.BodySink, { dur: 1.05, contact: 0.58, wind: 0.060, hit: 0.020, follow: -0.010 }),
], { minRange: 1.6, maxRange: 4.2 });

/**
 * The overhead. Rises onto the back foot, then brings the whole mass down.
 *
 * `BodySink` goes NEGATIVE through the windup (up and back) and firmly
 * positive at contact (everything coming down behind the blade). That
 * inversion is what sells weight, and it is the same trick the bear's rear-
 * then-slam uses — the difference is that the bear has 0.72 s to do it in and
 * he has 1.2.
 */
const kingOverhead = move('king_overhead', 'cleave', 1.20, 0.68, [
  swing(Ch.ForeSwing, {
    dur: 1.20, contact: 0.68, wind: -0.50, hit: 1.20, follow: 0.30, windAt: 0.74,
  }),
  swing(Ch.HeadPitch, {
    dur: 1.20, contact: 0.68, wind: -0.42, hit: 0.56, windAt: 0.72,
  }),
  swing(Ch.BodySink, {
    dur: 1.20, contact: 0.68, wind: -0.095, hit: 0.115, follow: 0.020, windAt: 0.74,
  }),
  swing(Ch.TailSway, { dur: 1.20, contact: 0.68, wind: 0.24, hit: -0.20 }),
  swing(Ch.JawOpen, { dur: 1.20, contact: 0.68, wind: 0.28, hit: 0.62, follow: 0.12 }),
], { weight: 0.85, minRange: 0, maxRange: 3.0 });

/** Guard break: short, straight, and the only fast thing he does. */
const kingThrust = move('king_thrust', 'thrust', 0.66, 0.34, [
  swing(Ch.ForeSwing, {
    dur: 0.66, contact: 0.34, wind: -0.24, hit: 1.08, follow: 0.16, windAt: 0.48,
  }),
  swing(Ch.TailSway, { dur: 0.66, contact: 0.34, wind: -0.30, hit: 0.36 }),
  swing(Ch.HeadPitch, { dur: 0.66, contact: 0.34, wind: -0.10, hit: 0.28 }),
  swing(Ch.BodySink, { dur: 0.66, contact: 0.34, wind: 0.040, hit: -0.060, follow: 0.020 }),
], { weight: 0.7, minRange: 0, maxRange: 99 });

// ===========================================================================
// THE FINAL BOSS AND HIS MOUNT
//
// Distinct move objects, not aliases of the Dread King's and the dragon's.
// `test-anim.mts` asserts that move names are globally unique and that no two
// attacks share a `Clip` object, and it is right to: a shared clip means a
// shared identity in `animDebug`, in the contact-frame sync and in any future
// per-move tuning, so two species pointing at one object is a bug waiting for
// the day someone changes it for one of them.
//
// The cadence rule binds here as it does on the Dread King:
//
//     max(recovery) + max(windup) <= attackCooldown - SWING_GAP
//
// At `evil_king`'s 1.9 s that is 0.56 + 0.74 = 1.30 <= 1.76. Everything below
// is authored against it, and `SPECIES_DEFS.evil_king.attackCooldown` is not
// free to move without re-checking it.
// ===========================================================================

/**
 * The King's sweep. The Dread King's cleave, slower and with more reach.
 *
 * `maxRange` is 5.6 against the Dread King's 4.2 because the blade really is
 * longer — 3.1 m of it on a 3.24 m man — and `reachBonus: 2.4` on the species
 * def is authored against this number. Weapon and hitbox agree or the player
 * learns a spacing that the animation contradicts.
 */
const evilKingCleave = move('evil_king_cleave', 'cleave', 1.15, 0.62, [
  swing(Ch.ForeSwing, {
    dur: 1.15, contact: 0.62, wind: -0.42, hit: 1.16, follow: 0.24, windAt: 0.70,
  }),
  swing(Ch.TailSway, { dur: 1.15, contact: 0.62, wind: 0.66, hit: -0.76, windAt: 0.72 }),
  swing(Ch.HeadYaw, { dur: 1.15, contact: 0.62, wind: 0.46, hit: -0.54 }),
  swing(Ch.HeadPitch, { dur: 1.15, contact: 0.62, wind: -0.20, hit: 0.22 }),
  swing(Ch.BodySink, { dur: 1.15, contact: 0.62, wind: 0.065, hit: 0.022, follow: -0.012 }),
], { minRange: 1.8, maxRange: 5.6 });

/** The overhead. Everything he has, brought down through the blade. */
const evilKingOverhead = move('evil_king_overhead', 'cleave', 1.30, 0.74, [
  swing(Ch.ForeSwing, {
    // `Ch.ForeSwing`'s range is [-0.5, 1.3] and the additive idle layer stacks
    // on TOP of the clip, so both ends need headroom. The windup is the one
    // that bites here: -0.54 put the arm 0.04 past the floor at full cock and
    // the pose clamped, which shortens the wind-up without shortening the
    // clip — a boss who telegraphs for a beat and then does not go as far back
    // as he looked like he would.
    dur: 1.30, contact: 0.74, wind: -0.44, hit: 1.16, follow: 0.32, windAt: 0.74,
  }),
  swing(Ch.HeadPitch, { dur: 1.30, contact: 0.74, wind: -0.46, hit: 0.60, windAt: 0.72 }),
  swing(Ch.BodySink, {
    dur: 1.30, contact: 0.74, wind: -0.105, hit: 0.125, follow: 0.022, windAt: 0.74,
  }),
  swing(Ch.TailSway, { dur: 1.30, contact: 0.74, wind: 0.26, hit: -0.22 }),
  swing(Ch.JawOpen, { dur: 1.30, contact: 0.74, wind: 0.30, hit: 0.66, follow: 0.14 }),
], { weight: 0.85, minRange: 0, maxRange: 4.2 });

/** Guard break — the one fast thing he does, and the punish for standing off. */
const evilKingThrust = move('evil_king_thrust', 'thrust', 0.72, 0.36, [
  swing(Ch.ForeSwing, {
    dur: 0.72, contact: 0.36, wind: -0.26, hit: 1.12, follow: 0.18, windAt: 0.48,
  }),
  swing(Ch.TailSway, { dur: 0.72, contact: 0.36, wind: -0.32, hit: 0.38 }),
  swing(Ch.HeadPitch, { dur: 0.72, contact: 0.36, wind: -0.12, hit: 0.30 }),
  swing(Ch.BodySink, { dur: 0.72, contact: 0.36, wind: 0.042, hit: -0.065, follow: 0.022 }),
], { weight: 0.7, minRange: 0, maxRange: 99 });

/**
 * The mount's bite. Slower than the wild dragon's — this animal is 26% longer
 * and a head that size does not snap.
 */
const blackDragonBite = move('black_dragon_bite', 'bite', 0.70, 0.38, [
  swing(Ch.FlapAmp, {
    dur: 0.70, contact: 0.38, rest: 0.30, wind: 0.94, hit: 0.55, follow: 0.34,
    windAt: 0.55,
  }),
  swing(Ch.FlapRate, {
    dur: 0.70, contact: 0.38, rest: 1.0, wind: 1.8, hit: 1.15, follow: 0.9, windAt: 0.55,
  }),
  swing(Ch.JawOpen, { dur: 0.70, contact: 0.38, wind: 0.70, hit: 0.96, follow: 0.10, lag: 0.02 }),
  swing(Ch.HeadPitch, { dur: 0.70, contact: 0.38, wind: -0.38, hit: 0.42 }),
  swing(Ch.HeadYaw, { dur: 0.70, contact: 0.38, wind: 0.26, hit: -0.18 }),
  swing(Ch.BodySink, { dur: 0.70, contact: 0.38, wind: 0.07, hit: -0.09 }),
  swing(Ch.TailSway, { dur: 0.70, contact: 0.38, wind: -0.36, hit: 0.46 }),
], { minRange: 0, maxRange: 6.0 });

/**
 * Fire, on the same open-and-HOLD shape as the wild dragon's: the jaw cracks,
 * clamps shut on the inhale, then snaps wide at contact and stays wide while
 * it burns. Shortened to 1.05 s from 0.95 s wall-to-wall so it still fits the
 * boss's cadence with the longer bite.
 */
const blackDragonBreath = move('black_dragon_breath', 'breath', 1.05, 0.48, [
  track(Ch.JawOpen, [
    [0, 0, Ease.Smooth],
    [0.19, 0.16, Ease.Smooth],   // cracks open
    [0.34, 0.04, Ease.In],       // clamps shut: the inhale
    [0.48, 0.94, Ease.Out],      // snaps wide — CONTACT
    [0.84, 0.88, Ease.Out],      // held wide while it burns
    [0.95, 0.26, Ease.Out],
    [1.05, 0, Ease.Smooth],
  ]),
  track(Ch.FlapAmp, [
    [0, 0.30, Ease.Smooth], [0.33, 0.88, Ease.Out], [0.48, 0.54, Ease.Smooth],
    [0.84, 0.40, Ease.Smooth], [1.05, 0.30, Ease.Smooth],
  ]),
  track(Ch.FlapRate, [
    [0, 1.0, Ease.Smooth], [0.33, 1.6, Ease.Out], [0.55, 0.85, Ease.Smooth],
    [1.05, 1.0, Ease.Smooth],
  ]),
  track(Ch.HeadPitch, [
    [0, 0, Ease.Smooth], [0.34, -0.42, Ease.Out], [0.48, 0.16, Ease.Out],
    [0.84, 0.24, Ease.Smooth], [1.05, 0, Ease.Smooth],
  ]),
  track(Ch.BodySink, [
    [0, 0, Ease.Smooth], [0.34, -0.070, Ease.Out], [0.48, 0.030, Ease.Out],
    [1.05, 0, Ease.Smooth],
  ]),
// `minRange` 1.6, not 4.0: the selector never offers a move whose window the
// bite already covers end to end, and the bite reaches 6 m on this animal. At
// 4.0 the breath was unreachable — `test-anim.mts` catches exactly that, which
// is the only reason anyone would ever find out.
], { minRange: 1.6, maxRange: 30 });

export const ATTACK_MOVES: Record<Species, readonly AttackMove[]> = {
  wolf:        [wolfLunge, wolfSnap],
  bear:        [bearSwipe, bearBackhand, bearMaul],
  deer:        [deerGore, deerRear],
  cow:         [cowButt, cowKick],
  horse:       [horseRear, horseKick, horseBite],
  donkey:      [donkeyKick, donkeyBite],
  rabbit:      [rabbitKick, rabbitNip],
  bird:        [birdPeck, birdBuffet],
  dragon:      [dragonBite, dragonBreath],
  wyvern:      [wyvernBite, wyvernBreath, wyvernTalon],
  griffin:     [griffinTalon, griffinBeak],
  sea_serpent: [serpentStrike, serpentThrash],
  goblin:        [goblinSlash, goblinStab],
  goblin_archer: [archerLoose, archerJab],
  skeleton:      [skeletonChop, skeletonThrust, skeletonBackhand],
  dread_king:    [kingCleave, kingOverhead, kingThrust],
  evil_king:     [evilKingCleave, evilKingOverhead, evilKingThrust],
  black_dragon:  [blackDragonBite, blackDragonBreath],
};

/** Every attack clip, for validation sweeps. */
export const ATTACK_ALL: readonly Clip[] =
  Object.values(ATTACK_MOVES).flat().map(m => m.clip);

/** Look up a move by name. Linear, and only ever called by tests and harnesses. */
export function findMove(species: Species, name: string): AttackMove | null {
  for (const m of ATTACK_MOVES[species]) if (m.name === name) return m;
  return null;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Deterministic [0,1) from a per-entity seed and a counter.
 *
 * The murmur3 finalizer, same as `hashUnit`'s. It is here rather than reusing
 * `hashUnit(id + n)` because that would allocate a string per attack, and
 * because concatenating a counter onto an id makes `wolf_1` + `2` collide with
 * `wolf_12` + nothing.
 */
function hash2(seed01: number, n: number): number {
  let h = ((seed01 * 0x100000000) ^ Math.imul(n | 0, 0x9e3779b1)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

/** Weighted draw over `pool[0..n)` using `u` in [0,1). */
function draw(pool: readonly AttackMove[], n: number, total: number, u: number): AttackMove {
  let acc = u * total;
  for (let i = 0; i < n; i++) {
    acc -= pool[i].weight;
    if (acc <= 0) return pool[i];
  }
  return pool[n - 1];
}

/**
 * Scratch for the in-range filter.
 *
 * Module-level and reused: `pickAttack` runs at most once per creature per
 * attack (a few times a second across the whole world), but allocating an array
 * inside the animation system at all is the habit this codebase is trying not
 * to have, and the function is not reentrant in a single-threaded frame anyway.
 */
const POOL: AttackMove[] = [];

/**
 * Choose which attack to throw.
 *
 * THREE RULES, IN THIS ORDER, AND THE ORDER IS THE DESIGN:
 *
 * 1. **Range filters first.** A wolf at 2.8 m lunges; at 1.2 m there is no room
 *    to lunge and it snaps. A dragon at 8 m breathes fire; at 2 m it bites.
 *    This is the part that makes the choice read as an animal deciding rather
 *    than as a die roll, and it is the reason range lives on the move rather
 *    than the selection being pure chance.
 *
 * 2. **Weighted draw among the survivors,** keyed on a hash of the entity seed
 *    and an attack COUNTER — not on the entity alone. Hashing the entity alone
 *    gives every wolf one attack for life; hashing the counter alone puts a
 *    whole pack in lockstep. Both together give each animal its own sequence,
 *    reproducible across runs, decorrelated from its neighbours.
 *
 * 3. **A repeated move is redrawn once.** Strict alternation was the obvious
 *    alternative and is worse: with two moves it is a metronome, and three
 *    swings in it becomes predictable. Redrawing once turns a repeat
 *    probability p into p^2 — repeats still happen, which is what real animals
 *    do, but runs of them do not. One extra hash, no branch in the common path.
 *
 * Never returns null: if nothing is in range the whole list is eligible, so a
 * creature at an unexpected distance still swings at something rather than
 * standing there.
 */
export function pickAttack(
  moves: readonly AttackMove[],
  seed01: number,
  attackNo: number,
  range: number,
  previous: AttackMove | null,
): AttackMove {
  const n0 = moves.length;
  if (n0 === 1) return moves[0];

  let n = 0;
  let total = 0;
  for (let i = 0; i < n0; i++) {
    const m = moves[i];
    if (range < m.minRange || range > m.maxRange) continue;
    POOL[n++] = m;
    total += m.weight;
  }
  if (n === 0) {
    for (let i = 0; i < n0; i++) { POOL[n++] = moves[i]; total += moves[i].weight; }
  }
  if (n === 1) return POOL[0];

  const first = draw(POOL, n, total, hash2(seed01, attackNo));
  if (first !== previous) return first;
  return draw(POOL, n, total, hash2(seed01, attackNo ^ 0x5bf03635));
}
