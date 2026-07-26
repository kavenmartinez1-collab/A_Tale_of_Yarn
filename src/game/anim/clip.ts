/**
 * clip.ts — keyframe clips, sampling and pose blending for creature animation.
 *
 * WHY THIS EXISTS
 *
 * The game already had a skeleton and a keyframe and did not know it. A `Rot[]`
 * chain is a flattened bone hierarchy; `chopAt()` in `character-mesh.ts` is a
 * working 3-key, 4-channel clip with per-segment easing. There was exactly one
 * of them, hardcoded, and everything else was an inline `Math.sin` in the
 * renderer. That is why every animal did precisely one thing, why nothing could
 * be layered on anything else, and why every state change was a pop.
 *
 * This module is the missing runtime: clips as data, sampling, and blending.
 * It is deliberately NOT a skinning system — see `docs/RECTIFICATION_PLAN.md`
 * §2. A knitted yarn doll's limb is a separately knitted tube sewn at the
 * shoulder; it *should* deform rigidly and crease at the joint. Rigid binding
 * is the art direction, not a limitation to be engineered away.
 *
 * ---------------------------------------------------------------------------
 * THE CENTRAL DESIGN DECISION: phases are integrated, amplitudes are blended
 * ---------------------------------------------------------------------------
 *
 * A naive clip system animates `walkPhase` as a channel. Do that and every
 * transition snaps the legs, because crossfading a phase interpolates between
 * two unrelated points on a cycle — the legs teleport to the average of two
 * positions that have no geometric relationship.
 *
 * Worse, for the planted-foot rig in `gait.ts`, phase is not a free parameter
 * at all. `phasePerMetre` ties exactly one gait cycle to exactly one stride of
 * ground; break that tie and the planted foot skates, which is the entire
 * defect that module exists to remove. So a clip may NOT author a cadence
 * multiplier on a grounded gait, however tempting "run = faster legs" looks.
 * Running is a LONGER STRIDE, and stride lives in the mesh builder.
 *
 * Hence the split, which is the load-bearing idea in this file:
 *
 *   - **Phase** (`walkPhase`) stays owned by the simulation, advanced from
 *     distance travelled. Never a channel, never blended.
 *   - **Amplitude and angle** (`WalkAmp`, `HeadYaw`, `JawOpen`, …) are clip
 *     channels and blend freely.
 *
 * A walk→idle transition therefore fades the stride amplitude to zero while the
 * phase keeps integrating underneath. The legs wind down smoothly and the feet
 * stay welded to the ground the whole way. Nothing pops, and nothing skates.
 *
 * Wing flap is the exception and is allowed a rate channel (`FlapRate`):
 * wings do not touch the ground, so no contact contract binds their frequency.
 *
 * Pure module: no DOM, no GPU, no allocation during sampling or blending.
 * Node-testable.
 */

// ---------------------------------------------------------------------------
// Channel vocabulary
// ---------------------------------------------------------------------------

/**
 * The creature pose vocabulary.
 *
 * Channels are indices, not names, at runtime — a pose is a small
 * `Float32Array` and every operation on it is a straight-line loop.
 *
 * Every channel now reaches the mesh. `HeadPitch` and `TailSway` were authored
 * throughout the clip libraries before they had any destination, on the bet
 * that the clips are the expensive artefact and the plumbing is cheap — that
 * paid off exactly as intended: the pose fields landed and the animation
 * appeared without a single clip being touched. `ForeSwing` was added at the
 * same time.
 */
export const enum Ch {
  /** Stride amplitude, 0 = standing, 1 = full stride. -> AnimalPose.walkAmp */
  WalkAmp = 0,
  /** Head turn in radians, + = toward +X. -> AnimalPose.headYaw */
  HeadYaw = 1,
  /** 0 = mouth shut, 1 = jaw fully dropped. -> AnimalPose.jawOpen */
  JawOpen = 2,
  /** Wing-beat amplitude, 0 = still, 1 = full beat. -> AnimalPose.flapAmp */
  FlapAmp = 3,
  /** Multiplier on wing-beat frequency. Safe: wings have no ground contact. */
  FlapRate = 4,
  /** How far the body settles below rest, as a fraction of shoulder height. */
  BodySink = 5,
  /** Head nod in radians, + = nose down. -> AnimalPose.headPitch */
  HeadPitch = 6,
  /** Tail swing in radians. -> AnimalPose.tailSway */
  TailSway = 7,
  /**
   * Forelimb reach in radians, + = forward. -> AnimalPose.foreSwing
   *
   * Added because the attack library exposed a hole nothing else could fill: a
   * planted quadruped's stride amplitude is `gate * sqrt(speed/ref)`, which is
   * zero exactly when it stops to strike, so a bear's swipe and a horse's rear
   * had no channel that could move a foreleg at all.
   */
  ForeSwing = 8,
  COUNT = 9,
}

/** A pose is `Ch.COUNT` floats. Always preallocated; never built per frame. */
export type PoseBuffer = Float32Array;

/**
 * Which channels currently reach the mesh.
 *
 * Kept as data so a test can assert the mapping in `pose-map.ts` is total, and
 * so the two outstanding requests to the mesh owners are stated in code rather
 * than in a comment somebody has to remember to read.
 */
export const CH_PLUMBED: readonly boolean[] = [
  true,  // WalkAmp
  true,  // HeadYaw
  true,  // JawOpen
  true,  // FlapAmp
  true,  // FlapRate   (consumed by the animator, not the pose struct)
  true,  // BodySink   (consumed by the renderer's object offset)
  true,  // HeadPitch
  true,  // TailSway
  true,  // ForeSwing
];

/**
 * Legal range per channel, as a semantic assertion rather than a clamp.
 *
 * These are not defensive limits; they are statements about what the numbers
 * MEAN. `jawOpen` below zero is a jaw hinging backwards through the skull;
 * `walkAmp` above one is a stride longer than the limb can reach, which makes
 * `gait.ts` clamp the IK and reintroduces skating. Tests assert every authored
 * clip — and every clip plus its additive idle layer at every phase — stays
 * inside these. That catches the class of bug where a layer silently pushes a
 * bounded channel out of range and the result is a subtly broken creature that
 * no still frame reveals.
 */
export const CH_RANGE: readonly (readonly [number, number])[] = [
  [0, 1],            // WalkAmp
  [-1.6, 1.6],       // HeadYaw   (~92 deg; past this the neck reads as broken)
  [0, 1],            // JawOpen
  [0, 1],            // FlapAmp
  [0.15, 4],         // FlapRate
  // Mostly positive — but a small negative is legal and load-bearing: a lunge,
  // a rear and a pounce all LIFT the body, and without headroom below zero the
  // only visible part of a quadruped attack (nothing else in the pose struct
  // reaches a wolf) would be clipped away to nothing.
  [-0.15, 0.7],      // BodySink  (0.7 of shoulder height = belly on the floor)
  [-1.2, 1.2],       // HeadPitch
  [-1.0, 1.0],       // TailSway
  // A foreleg can reach well forward to strike but has very little travel
  // backward before it is behind the shoulder and reads as dislocated.
  [-0.5, 1.3],       // ForeSwing
];

/**
 * The pose a clip means when it does not mention a channel.
 *
 * Clips are sparse on purpose: a `graze` clip should say "head down, not
 * walking" and stay silent about wings. Silence has to resolve to something
 * definite or blending is undefined, so unmentioned channels read this.
 *
 * Note `FlapRate` is 1, not 0 — it is a multiplier, and a neutral multiplier is
 * unity. Getting that wrong stops every wing in the game the moment a clip
 * omits the channel.
 */
export const NEUTRAL_POSE: readonly number[] = [0, 0, 0, 0, 1, 0, 0, 0, 0];

/** The identity for an additive layer: add nothing to anything. */
export const ADDITIVE_IDENTITY: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0];

/** Allocate a pose buffer initialised to the neutral pose. */
export function makePose(): PoseBuffer {
  return Float32Array.from(NEUTRAL_POSE);
}

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

/**
 * Per-segment easing, exactly as the hand-authored `chopAt` clip used it:
 * smooth on the windup, quadratic on the strike, smooth on the recovery. Easing
 * belongs to the segment LEAVING a key, which is what lets one clip be lazy in
 * one place and snappy in the next — the difference between an animation and a
 * lerp.
 */
export const enum Ease {
  /** Constant velocity. */
  Linear = 0,
  /** Smoothstep — eases out of the key and into the next. */
  Smooth = 1,
  /** Quadratic accelerate: slow start, fast arrival. Impacts, strikes. */
  In = 2,
  /** Quadratic decelerate: fast start, soft arrival. Recoils, settles. */
  Out = 3,
  /** Hold, then jump at the next key. Bird head flicks, blinks. */
  Step = 4,
}

function applyEase(e: number, t: number): number {
  switch (e) {
    case Ease.Smooth: return t * t * (3 - 2 * t);
    case Ease.In: return t * t;
    case Ease.Out: return t * (2 - t);
    case Ease.Step: return 0;
    default: return t;
  }
}

// ---------------------------------------------------------------------------
// Clip data
// ---------------------------------------------------------------------------

/**
 * One channel's keyframes, flattened to `[t, v, ease]` triples.
 *
 * Flat rather than an array of objects because sampling runs 30 creatures ×
 * ~2 clips × ~6 tracks every frame and an array of small objects is a pointer
 * chase per key.
 */
export interface Track {
  ch: Ch;
  /** `[t0, v0, e0, t1, v1, e1, …]`, times strictly increasing. */
  keys: Float32Array;
}

export interface Clip {
  name: string;
  /** Seconds. Looping clips must have keys spanning exactly [0, duration]. */
  duration: number;
  loop: boolean;
  /**
   * When true the sampled values are DELTAS to be added onto a base pose
   * rather than an absolute pose. Additive clips read `ADDITIVE_IDENTITY` for
   * unmentioned channels, so an additive layer that only mentions the head
   * cannot disturb the legs.
   */
  additive: boolean;
  tracks: Track[];
}

/** Key spec for `track()`: `[time, value]` or `[time, value, ease]`. */
export type KeySpec = readonly [number, number] | readonly [number, number, Ease];

/** Build a track from readable key specs. Called at module load, never per frame. */
export function track(ch: Ch, keys: readonly KeySpec[]): Track {
  const flat = new Float32Array(keys.length * 3);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    flat[i * 3] = k[0];
    flat[i * 3 + 1] = k[1];
    flat[i * 3 + 2] = k.length > 2 ? (k[2] as number) : Ease.Smooth;
  }
  return { ch, keys: flat };
}

/** Build a clip. `additive` defaults to false (absolute pose). */
export function clip(
  name: string,
  duration: number,
  loop: boolean,
  tracks: Track[],
  additive = false,
): Clip {
  return { name, duration, loop, additive, tracks };
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/**
 * Value of one track at time `t` (already reduced into [0, duration]).
 *
 * Linear scan: tracks carry 2–6 keys, so a scan beats a binary search and
 * beats caching a cursor (a cursor would have to be per-entity-per-track
 * state, which is exactly the allocation this system exists to avoid).
 */
function sampleTrack(tr: Track, t: number): number {
  const k = tr.keys;
  const n = k.length / 3;
  if (n === 0) return 0;
  if (t <= k[0]) return k[1];
  const lastT = k[(n - 1) * 3];
  if (t >= lastT) return k[(n - 1) * 3 + 1];

  for (let i = 0; i < n - 1; i++) {
    const t0 = k[i * 3];
    const t1 = k[(i + 1) * 3];
    if (t < t0 || t > t1) continue;
    const span = t1 - t0;
    const u = span > 0 ? (t - t0) / span : 0;
    const v0 = k[i * 3 + 1];
    const v1 = k[(i + 1) * 3 + 1];
    return v0 + (v1 - v0) * applyEase(k[i * 3 + 2], u);
  }
  return k[(n - 1) * 3 + 1];
}

/**
 * Sample a clip into `out`.
 *
 * Looping clips wrap; one-shot clips clamp at both ends, so a finished one-shot
 * holds its last pose indefinitely rather than snapping back to frame zero.
 * Holding is what lets the animator crossfade OUT of a finished attack instead
 * of racing it.
 */
export function sampleClip(c: Clip, time: number, out: PoseBuffer): void {
  let t = time;
  if (c.loop) {
    const d = c.duration;
    t = t % d;
    if (t < 0) t += d;
  } else {
    t = t < 0 ? 0 : t > c.duration ? c.duration : t;
  }
  out.set(c.additive ? ADDITIVE_IDENTITY : NEUTRAL_POSE);
  const tracks = c.tracks;
  for (let i = 0; i < tracks.length; i++) {
    const tr = tracks[i];
    out[tr.ch] = sampleTrack(tr, t);
  }
}

// ---------------------------------------------------------------------------
// Blending
// ---------------------------------------------------------------------------

/**
 * Convex blend: `out = a + (b - a) * w`.
 *
 * Written as `a + (b - a) * w` rather than `a*(1-w) + b*w` because the former
 * is exact at both endpoints in floating point — `w = 1` returns `b` bit for
 * bit. That exactness is what makes a finished crossfade provably a no-op
 * rather than a source of drift.
 */
export function blendPose(
  a: Readonly<PoseBuffer>, b: Readonly<PoseBuffer>, w: number, out: PoseBuffer,
): void {
  for (let i = 0; i < Ch.COUNT; i++) out[i] = a[i] + (b[i] - a[i]) * w;
}

/** Layer an additive pose on top of a base, in place. */
export function addPose(
  base: PoseBuffer, additive: Readonly<PoseBuffer>, w: number,
): void {
  for (let i = 0; i < Ch.COUNT; i++) base[i] += additive[i] * w;
}

/** Copy `src` into `dst`. */
export function copyPose(dst: PoseBuffer, src: Readonly<PoseBuffer>): void {
  for (let i = 0; i < Ch.COUNT; i++) dst[i] = src[i];
}

/**
 * Clamp every channel into its declared legal range, in place.
 *
 * Applied once at the very end of the animator, after additive layers. This is
 * the only clamp in the system and it is deliberately last: clamping earlier
 * would silently absorb an authoring error into a plausible-looking pose, and
 * the tests assert clips stay in range WITHOUT this net so that authoring
 * errors are caught in CI rather than hidden at runtime.
 */
export function clampPose(p: PoseBuffer): void {
  for (let i = 0; i < Ch.COUNT; i++) {
    const r = CH_RANGE[i];
    const v = p[i];
    p[i] = v < r[0] ? r[0] : v > r[1] ? r[1] : v;
  }
}

// ---------------------------------------------------------------------------
// Validation (used by tests and by the clip-library authoring pass)
// ---------------------------------------------------------------------------

/**
 * Structural problems with a clip, as human-readable strings. Empty = valid.
 *
 * The loop-continuity rule is the important one: a looping clip whose last key
 * value differs from its first produces a jump every cycle. That reads as a
 * twitch once per second — obviously wrong in motion, completely invisible in
 * every still frame, and therefore exactly the kind of defect a screenshot
 * harness will never find.
 */
export function validateClip(c: Clip): string[] {
  const errs: string[] = [];
  if (!(c.duration > 0)) errs.push(`${c.name}: duration must be > 0`);
  const seen = new Set<number>();
  for (const tr of c.tracks) {
    if (tr.ch < 0 || tr.ch >= Ch.COUNT) {
      errs.push(`${c.name}: channel ${tr.ch} out of range`);
      continue;
    }
    if (seen.has(tr.ch)) errs.push(`${c.name}: channel ${tr.ch} authored twice`);
    seen.add(tr.ch);

    const k = tr.keys;
    const n = k.length / 3;
    if (n < 1) { errs.push(`${c.name}: ch ${tr.ch} has no keys`); continue; }
    // Keys are stored as float32 while `duration` is a float64 literal, so a
    // key authored exactly at the duration lands ~1e-7 past it. Tolerance has
    // to clear that; 1e-5 still catches a genuinely misplaced key.
    const tol = 1e-5 * Math.max(1, c.duration);
    for (let i = 0; i < n; i++) {
      const t = k[i * 3];
      if (t < -tol || t > c.duration + tol) {
        errs.push(`${c.name}: ch ${tr.ch} key t=${t} outside [0, ${c.duration}]`);
      }
      if (i > 0 && t <= k[(i - 1) * 3]) {
        errs.push(`${c.name}: ch ${tr.ch} key times not strictly increasing`);
      }
    }
    if (c.loop && n > 1) {
      const first = k[1];
      const last = k[(n - 1) * 3 + 1];
      if (Math.abs(first - last) > 1e-6) {
        errs.push(
          `${c.name}: ch ${tr.ch} loops but ${first} !== ${last} at the wrap`);
      }
      if (Math.abs(k[(n - 1) * 3] - c.duration) > tol) {
        errs.push(`${c.name}: ch ${tr.ch} loops but last key is not at duration`);
      }
    }
  }
  return errs;
}
