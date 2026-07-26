/**
 * animator.ts — per-entity clip playback with crossfade and an additive idle
 * layer.
 *
 * WHY CROSSFADE FROM A FROZEN SNAPSHOT
 *
 * The obvious crossfade keeps the outgoing clip playing and blends two live
 * samples. It has a failure mode that shows up the moment a state machine
 * drives it: interrupt an A->B fade with C and the outgoing pose is no longer
 * A, it is the A/B blend — so fading "from A" pops by however far the fade had
 * already travelled. Animals change state constantly (graze -> alert -> flee in
 * under a second), so that interruption is the common case, not the edge case.
 *
 * Fading from a frozen snapshot of the pose ACTUALLY EMITTED last frame makes
 * continuity unconditional and exact: the first frame of any transition, from
 * any state, at any point in any other transition, emits bit-for-bit what the
 * previous frame emitted. There is no arrangement of `play()` calls that can
 * make this animator pop, and the test suite asserts precisely that.
 *
 * The cost is that the outgoing animation stops moving for the length of the
 * fade. Two things make that a non-issue here:
 *
 *   1. `walkPhase` is not a channel — it keeps integrating from distance
 *      travelled underneath the blend (see `clip.ts`). The legs never stop
 *      cycling during a transition; only the stride AMPLITUDE fades.
 *   2. The additive idle layer is applied AFTER the blend and is always live,
 *      so breathing and head drift continue through every transition.
 *
 * So nothing the eye tracks is ever actually frozen, and fades are 0.1–0.35 s.
 *
 * DETERMINISM
 *
 * Every time-driven idle is offset by a hash of the entity id. A herd breathing
 * and scanning in unison reads as MORE mechanical than a herd not breathing at
 * all — it is the single most important detail in the whole idle layer. Hashing
 * the id rather than seeding from a counter also means the same world produces
 * the same motion on every run, so a filmstrip is reproducible.
 *
 * Pure module: no DOM, no GPU, no allocation after construction. Node-testable.
 */

import {
  Ch, addPose, blendPose, copyPose, clampPose, makePose, sampleClip,
  type Clip, type PoseBuffer,
} from './clip';

// ---------------------------------------------------------------------------
// Deterministic per-entity phase
// ---------------------------------------------------------------------------

/**
 * Stable hash of an entity id to [0, 1).
 *
 * FNV-1a: cheap, no allocation, and well-spread on the short ascii ids the
 * entity manager produces (`deer_17`, `wolf_3`). The previous inline version
 * lived in `entity-renderer.ts`; it is here so the animator, the renderer and
 * the tests cannot drift apart on what "this creature's phase" means.
 */
export function hashUnit(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Avalanche (murmur3 fmix32). Raw FNV-1a is NOT good enough here and this is
  // not defensive polish: entity ids are near-identical short strings
  // (`deer_0`, `deer_1`, …), and on those the raw hash's high bits barely move
  // — a 400-id sample left two of ten deciles completely empty and piled 21% of
  // the herd into one. Phase offsets that clump are visually indistinguishable
  // from no decorrelation at all, which is the exact failure this hash exists
  // to prevent. The finalizer costs four instructions once per entity.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

/** Same hash, expressed as a phase offset in [0, 2pi). */
export function hashPhase(id: string): number {
  return hashUnit(id) * Math.PI * 2;
}

// ---------------------------------------------------------------------------
// Animator
// ---------------------------------------------------------------------------

/** Default crossfade, in seconds. Long enough to read, short enough to obey. */
export const FADE_DEFAULT = 0.22;

export class Animator {
  /** Deterministic offset in [0, 1) derived from the entity id. */
  readonly seed: number;

  /**
   * Wing-beat phase, in radians, integrated by the animator.
   *
   * Unlike `walkPhase` this IS ours to own: wings make no ground contact, so
   * no planted-foot contract binds their frequency and a clip may scale it
   * freely via `Ch.FlapRate`. Integrated rather than computed as
   * `simTime * rate` so that a rate change ramps the frequency instead of
   * teleporting the wings — `sin(t * r)` is discontinuous in `r`.
   */
  flapPhase: number;

  /** Seconds elapsed inside the current clip. */
  private clipT = 0;

  private cur: Clip;
  private fadeT = 0;
  private fadeDur = 0;

  /** Always-on additive layer (breathing / sway / drift). Null = none. */
  private idleLayer: Clip | null = null;
  private idleRate = 1;

  // Preallocated. Five pose buffers per entity is 160 bytes; 30 creatures is
  // under 5 KB, and it buys total freedom from aliasing bugs.
  //
  // `base` is the crossfade result BEFORE the additive layer; `out` is what the
  // caller sees. They have to be separate: a snapshot taken from `out` would
  // already contain one copy of the idle layer, and the layer is then applied
  // again on top of it every frame of the fade — so breathing would be
  // double-counted for the duration of every transition, and, worse, the fade
  // would no longer start exactly where the previous frame ended.
  private readonly base: PoseBuffer = makePose();
  private readonly out: PoseBuffer = makePose();
  private readonly sample: PoseBuffer = makePose();
  private readonly snapshot: PoseBuffer = makePose();
  private readonly layer: PoseBuffer = makePose();

  constructor(id: string, initial: Clip) {
    this.seed = hashUnit(id);
    this.flapPhase = this.seed * Math.PI * 2;
    this.cur = initial;
    sampleClip(initial, 0, this.base);
    copyPose(this.out, this.base);
    copyPose(this.snapshot, this.base);
  }

  /** The clip currently playing (or being faded in). */
  get clip(): Clip { return this.cur; }

  /**
   * Seconds elapsed inside the current clip.
   *
   * Read by the driver to answer "how far into this swing are we", which is
   * what lets an attack's declared contact time be checked against the damage
   * event instead of assumed to match it.
   */
  get clipTime(): number { return this.clipT; }

  /**
   * Move the playhead. FOR DIAGNOSTICS AND CAPTURE HARNESSES ONLY.
   *
   * A screenshot harness cannot film a 0.3 s strike by taking screenshots: the
   * round trip is longer than the clip. Every previous attempt in this repo to
   * work around that by sampling fast and hoping produced strips that were
   * mostly rest pose and were reported as successes. Being able to PIN the
   * playhead to a named time and shoot that exact frame is what makes an
   * attack filmstrip evidence rather than a claim — see `scripts/anim-attack.mjs`.
   *
   * Not used by the game. It bypasses the crossfade, so calling it mid-fade
   * moves the incoming clip only.
   */
  setClipTime(t: number): void { this.clipT = t; }

  /** True once a one-shot clip has run past its duration. Always false for loops. */
  get finished(): boolean {
    return !this.cur.loop && this.clipT >= this.cur.duration;
  }

  /** Fraction of the active crossfade completed; 1 when not fading. */
  get fadeProgress(): number {
    return this.fadeDur > 0 ? Math.min(1, this.fadeT / this.fadeDur) : 1;
  }

  /**
   * Install the always-on additive idle layer.
   *
   * `rate` scales how fast the layer's own clock runs, so one authored breathing
   * clip serves a rabbit and a dragon: big animals breathe slower.
   */
  setIdleLayer(layer: Clip | null, rate = 1): void {
    this.idleLayer = layer;
    this.idleRate = rate;
  }

  /**
   * Start `next`, crossfading over `fade` seconds.
   *
   * Re-playing the clip already playing is a no-op, NOT a restart. Without that
   * guard a state machine that calls `play(walk)` unconditionally every frame
   * would pin `clipT` at 0 and the clip would never advance — a bug that
   * presents as "the animation is stuck on frame one" and is maddening to find
   * because the animator looks like it is working.
   *
   * Re-playing a FINISHED one-shot does restart it, so a creature can attack
   * twice in a row.
   */
  play(next: Clip, fade = FADE_DEFAULT): void {
    if (next === this.cur && !(this.finished && !next.loop)) return;
    // Freeze the pre-layer pose we emitted last frame and fade away from
    // exactly that.
    copyPose(this.snapshot, this.base);
    this.cur = next;
    this.clipT = 0;
    this.fadeT = 0;
    this.fadeDur = Math.max(0, fade);
    if (this.fadeDur === 0) {
      sampleClip(next, 0, this.base);
      copyPose(this.out, this.base);
    }
  }

  /** Jump to `next` with no blend. Used when a creature teleports or respawns. */
  snap(next: Clip): void {
    this.cur = next;
    this.clipT = 0;
    this.fadeT = 0;
    this.fadeDur = 0;
    sampleClip(next, 0, this.base);
    copyPose(this.out, this.base);
    copyPose(this.snapshot, this.base);
  }

  /**
   * Advance by `dt` seconds and return the pose for this frame.
   *
   * The returned buffer is the animator's own and is overwritten by the next
   * call — read it, do not retain it.
   *
   * `flapBase` is the species' resting wing-beat rate in rad/s.
   */
  update(dt: number, flapBase = 0): Readonly<PoseBuffer> {
    // Both clocks advance HERE, before anything samples them. Advancing the
    // idle layer's clock at the end of the method instead — the obvious place,
    // since it is the last thing used — silently desynchronises it from the
    // clip clock by exactly one frame, and the symptom is subtle enough to be
    // worth spelling out: a zero-length frame would then still move the layer,
    // so the pose emitted immediately after `play()` was NOT the pose emitted
    // the frame before, and the crossfade's exact-continuity guarantee failed
    // by a few ten-thousandths. Small, invisible, and the difference between a
    // property that holds and one that nearly holds.
    this.clipT += dt;
    this.clock += dt;

    sampleClip(this.cur, this.clipT, this.sample);

    if (this.fadeDur > 0) {
      this.fadeT += dt;
      const u = this.fadeT / this.fadeDur;
      if (u >= 1) {
        this.fadeDur = 0;
        copyPose(this.base, this.sample);
      } else {
        // Smoothstep so the blend eases in and out; a linear crossfade has a
        // velocity discontinuity at both ends, which reads as a small tick.
        blendPose(this.snapshot, this.sample, u * u * (3 - 2 * u), this.base);
      }
    } else {
      copyPose(this.base, this.sample);
    }

    copyPose(this.out, this.base);

    // Additive idle, applied after the blend so it never freezes mid-fade.
    //
    // Damped by stride amplitude: a walking animal's body is already moving,
    // and layering a full-strength breathing bob on top of a gait reads as a
    // limp. The gait supplies the motion; the idle layer fills the gaps.
    //
    // The weight is taken from `base`, i.e. from the crossfade result before
    // this layer touched it, so the layer never feeds back into its own weight.
    if (this.idleLayer !== null) {
      const w = 1 - Math.min(1, Math.max(0, this.base[Ch.WalkAmp])) * 0.7;
      if (w > 0) {
        const d = this.idleLayer.duration;
        sampleClip(this.idleLayer, this.clock * this.idleRate + this.seed * d,
          this.layer);
        addPose(this.out, this.layer, w);
      }
    }

    // Wing phase. Integrated from the BLENDED rate so a fade into a glide slows
    // the beat smoothly instead of stepping it.
    if (flapBase > 0) {
      this.flapPhase += dt * flapBase * this.out[Ch.FlapRate];
      // Keep it bounded; float precision on a phase that grows all session
      // eventually coarsens the beat. 2pi-periodic, so wrapping is exact-ish
      // and invisible.
      if (this.flapPhase > 1e4) this.flapPhase -= 1e4;
    }

    clampPose(this.out);
    return this.out;
  }

  /**
   * The animator's own wall clock, used to drive the additive idle layer.
   *
   * Deliberately NOT the caller's `simTime`: an entity that spawns mid-session
   * would otherwise start its idle layer at an arbitrary point, and — worse —
   * `simTime` grows without bound, so `simTime % duration` loses resolution
   * over a long session until the breathing visibly quantises.
   */
  private clock = 0;
}
