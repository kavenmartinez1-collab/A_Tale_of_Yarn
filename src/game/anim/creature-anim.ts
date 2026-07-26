/**
 * creature-anim.ts — the per-entity animation driver.
 *
 * Owns one `Animator` per visible creature, picks which clip should be playing
 * from the AI's mode plus MEASURED motion, integrates gait phase, and maps the
 * resulting channel buffer onto the `AnimalPose` the mesh builders consume.
 *
 * ---------------------------------------------------------------------------
 * WHY GAIT PHASE MOVED HERE, AND WHY THAT IS NOT OPTIONAL
 * ---------------------------------------------------------------------------
 *
 * `animal-ai.ts` advances `e.walkPhase` by `distance / animalStride(species)`,
 * and the mesh builder scales its stride by `walkAmp`:
 *
 *     stride_metres = rig.stride * walkAmp
 *
 * Those two agree at `walkAmp === 1` and DISAGREE everywhere else. A planted
 * foot's local position must travel backward at exactly body speed, which
 * requires
 *
 *     dPhase/dDistance = 2*pi / stride_metres = 2*pi / (rig.stride * walkAmp)
 *
 * so a half-amplitude stride needs twice the phase per metre. Advancing at the
 * full-amplitude rate regardless leaves every planted foot creeping forward at
 * `(1 - walkAmp)` of body speed — which is precisely the skating `gait.ts` was
 * written to eliminate, quietly reintroduced by the amplitude term.
 *
 * That was survivable while `walkAmp` was a step function that sat at 1 or 0
 * and only briefly took the value 0.3. It is NOT survivable here: crossfading
 * makes `walkAmp` a continuous quantity that spends every transition somewhere
 * strictly between. Blending amplitude smoothly and integrating phase as though
 * it had not changed would have made the animation system's flagship feature
 * the direct cause of a locomotion regression.
 *
 * So the driver integrates the phase itself, from measured displacement, using
 * the same amplitude it hands the builder. `e.walkPhase` is left alone — the AI
 * keeps updating it and other systems keep reading it — but it is no longer
 * what the mesh sees.
 *
 * The payoff is larger than just fixing the fade: because the phase now comes
 * from measured displacement rather than from the AI's own bookkeeping, planted
 * feet also work for the two paths that never called `stepAnimal` at all — a
 * ridden mount (`main.ts` advanced its phase at a legacy flat 1.6 rad/m) and
 * any entity in `follow` mode (which the renderer previously drew with
 * `walkAmp = 0`, i.e. sliding along with dead legs).
 *
 * ---------------------------------------------------------------------------
 * STRIDE AMPLITUDE COMES FROM SPEED, NOT FROM MODE
 * ---------------------------------------------------------------------------
 *
 * `walkAmp` used to be a lookup on `e.mode`: 1 for wander/flee/aggro, 0.3 for
 * graze, 0 otherwise. That is wrong three ways — it pops at every transition,
 * it has no entry for `follow`, and it claims a full stride for a creature
 * moving at 30% of its speed.
 *
 * Real gait scales both stride length and cadence with speed, each roughly as
 * its square root. Taking `amp = sqrt(v / vRef)` reproduces that: at half speed
 * a creature takes steps 71% as long, 71% as often. And it composes exactly
 * with the phase rule above — substituting `stride_metres = rig.stride * amp`
 * into `dPhase/dD` gives a foot that is stationary in world space at EVERY
 * speed, including while the amplitude is still changing. No skating at any
 * point on the curve, by construction rather than by tuning.
 *
 * The clip's own `WalkAmp` channel then acts as a GATE on that: `walk` says
 * 1.0 ("use whatever the speed calls for"), `graze` says 0.30 ("mince"),
 * `attack` says 0 ("stop"). Gate times speed, and the product drives both the
 * builder and the phase integration.
 */

import {
  animalBodyDrop, animalGait, animalStride, type AnimalPose,
} from '../entities/animal-mesh';
import { SPECIES_DEFS, type Species } from '../entities/entity-types';
import type { EntityMode, EntityState } from '../entities/entity-manager';
import { attackReach, combatDistance, isFighting } from '../entities/animal-ai';
import { Ch, type PoseBuffer } from './clip';
import { Animator } from './animator';
import { FADE_IN, resolveState, type AnimState, type ClipSet } from './clip-set';
import { BIRD_CLIPS, WINGED_CLIPS } from './clips-winged';
import { QUADRUPED_CLIPS } from './clips-quadruped';
import { SERPENT_CLIPS } from './clips-serpent';
import {
  DREAD_KING_CLIPS, GOBLIN_CLIPS, SKELETON_CLIPS,
} from './clips-humanoid';
import {
  ATTACK_MOVES, pickAttack, type AttackKind, type AttackMove,
} from './clips-attack';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Below this ground speed a creature counts as standing still. */
const MOVE_EPS = 0.12; // m/s

/** Stride amplitude floor, to keep `distance / (stride * amp)` finite. */
const AMP_FLOOR = 0.16;

/** Below this the gait collapses to the rest pose, so phase is meaningless. */
const AMP_DEAD = 0.02;

/** Hard cap on gait phase advanced in one frame — absorbs teleports. */
const MAX_DPHASE = Math.PI;

/** Time constant for the measured-speed low-pass, in seconds. */
const SPEED_TAU = 0.15;

/** Time constant for the vertical-velocity low-pass used for flight detection. */
const CLIMB_TAU = 0.35;

/** Sustained vertical speed that means "airborne", not "running over a hill". */
const CLIMB_FLY = 1.2;  // m/s
const CLIMB_LAND = 0.5; // m/s

/**
 * Height above terrain that counts as flying, when the caller supplies ground
 * height. Hysteresis: enter well clear of the ground so a hop or a steep bank
 * does not trigger it, leave close to it so the landing clip plays near
 * touchdown rather than metres up.
 */
const FLY_ENTER_Y = 2.2; // m
const FLY_EXIT_Y = 1.2;  // m

/** Descent rate past which a flier is coasting rather than beating. */
const GLIDE_SINK = 1.6; // m/s

/** A sitting creature that has not moved for this long falls asleep. */
const SLEEP_AFTER_S = 26; // s

/** Range at which an aggro creature is biting rather than charging. */
const MELEE_DIST = 3.0; // m

/**
 * Range inside which the AI actually lands blows.
 *
 * Mirrors `ATTACK_DIST` in `animal-ai.ts`, which is the distance its cooldown
 * ticks at. Deliberately a SEPARATE, tighter number from `MELEE_DIST`: the
 * looser one decides whether a creature stands to attention, and getting that
 * slightly wrong costs nothing. This one gates the windup, and getting it wrong
 * makes a wolf flail at the air for the last half metre of its charge, because
 * outside `ATTACK_DIST` the AI never decrements `stateTimer` and the anticipated
 * trigger below would therefore be satisfied continuously.
 */
const STRIKE_DIST = 2.5; // m

/**
 * Ground speed below which a creature counts as having planted itself to swing.
 *
 * The AI stops moving inside `ATTACK_DIST`, so a settled creature is one that
 * has arrived. Without this a predator whose charge carries it through the
 * range boundary would start a windup while still running.
 */
const SETTLED_SPEED = MOVE_EPS * 4; // m/s

/**
 * Minimum pause between the end of one swing and the start of the next.
 *
 * Not a cadence — `animal-ai.ts`'s 1.2 s cooldown sets the cadence. This is a
 * guard against the one case that has no cooldown at all: `stateTimer` is only
 * decremented while the player is inside `ATTACK_DIST`, so a creature hovering
 * on that boundary reads a permanently-expired timer and would otherwise swing
 * again the instant each clip ended, forever.
 */
export const SWING_GAP = 0.14; // s

/** Longest gap before a re-appearing entity is treated as freshly spawned. */
const STALE_S = 0.5;

// ---------------------------------------------------------------------------
// Per-species configuration
// ---------------------------------------------------------------------------

export interface SpeciesAnim {
  set: ClipSet;
  /**
   * True when the builder solves planted feet against `animalStride(species)`.
   *
   * This is not a style choice — it selects the phase rule. A planted plan MUST
   * integrate `distance / (stride * amplitude)` or its feet skate; a free plan
   * has no ground contact and may free-run.
   */
  planted: boolean;
  /** Resting wing-beat rate in rad/s; 0 = the builder ignores flap channels. */
  flapBase: number;
  /** Free-running gait cycles per second when stationary. */
  freeHz: number;
  /** Multiplier on the additive idle layer's clock. */
  idleRate: number;
  /**
   * This species' attack vocabulary, most characteristic first.
   *
   * Keyed by species rather than by body plan because that is the one axis on
   * which seven animals sharing a skeleton genuinely disagree — see the header
   * of `clips-attack.ts`. Empty is legal and falls back to the body plan's
   * generic `attack` clip.
   */
  attacks: readonly AttackMove[];
}

/**
 * Which library and phase rule a species gets.
 *
 * Three things here are worth knowing rather than inferring:
 *
 * **Bird gets its own set and `flapBase: 0`** because `buildBird` ignores
 * `flapPhase`/`flapAmp` entirely and drives its wings from
 * `walkPhase`/`walkAmp` instead. Its `freeHz: 1.7` is therefore a WING beat,
 * not a step rate — and it is `free` because bird legs have an empty rotation
 * chain and never animate, so there is no foot to plant.
 *
 * **Dragon and griffin are `free` even though they have four legs**, because
 * their legs are a hardcoded `sin(walkPhase) * walkAmp` swing with no IK and no
 * duty cycle. There is no planted-foot contract to honour, so binding their
 * phase to distance and amplitude would buy nothing.
 *
 * **The wyvern is `planted`.** It is a biped with real two-bone IK, its own
 * duty cycle and its own `wyvernStride()` — which is defined to equal
 * `animalStride()`, and a test asserts that it still does. So it takes the same
 * phase rule as a quadruped despite being a flier.
 *
 * The fallback derives from the rig rather than from a list: anything with a
 * gait pattern is a planted quadruped, and anything else is assumed winged.
 * A new species therefore animates sensibly the day it lands rather than
 * silently taking whichever branch happened to be the default.
 */
function speciesAnim(species: Species): SpeciesAnim {
  const size = SPECIES_DEFS[species].size;
  // Big animals breathe and drift slower. Rabbit (0.4) -> 1.11, dragon
  // (3.5) -> 0.84, which brackets the 0.25 Hz base into roughly 0.21-0.28 Hz.
  const idleRate = Math.max(0.55, Math.min(1.4, 1.15 - size * 0.09));
  // Always keyed by the real species, so a body plan shared by seven animals
  // still gives each of them its own fight.
  const attacks = ATTACK_MOVES[species] ?? [];
  switch (species) {
    case 'dragon':
      return { set: WINGED_CLIPS, planted: false, flapBase: 2.4, freeHz: 0, idleRate, attacks };
    case 'griffin':
      return { set: WINGED_CLIPS, planted: false, flapBase: 3.4, freeHz: 0, idleRate, attacks };
    case 'wyvern':
      // Lighter than a dragon, so a quicker beat; and its feet really do plant.
      return { set: WINGED_CLIPS, planted: true, flapBase: 3.0, freeHz: 0, idleRate, attacks };
    case 'bird':
      return { set: BIRD_CLIPS, planted: false, flapBase: 0, freeHz: 1.7, idleRate, attacks };
    case 'sea_serpent':
      return { set: SERPENT_CLIPS, planted: false, flapBase: 0, freeHz: 0.35, idleRate, attacks };

    // The four bipedal enemies. These MUST be listed explicitly: the fallback
    // below asks `animalGait(species) !== null`, which is false for anything
    // outside `BODY_SHAPE`, so a humanoid dropping through would be handed
    // WINGED clips and a 2.6 rad/s wing beat. That is exactly the trap the
    // wyvern nearly fell into and the reason `test-anim.mts` has a species
    // routing section.
    //
    // `planted: true` because `humanoid-mesh.ts` solves real two-bone IK
    // against `animalStride`, and `freeHz: 0` because a planted plan must
    // integrate phase from distance or its feet skate (the config test
    // asserts the implication both ways).
    case 'goblin':
    case 'goblin_archer':
      return { set: GOBLIN_CLIPS, planted: true, flapBase: 0, freeHz: 0, idleRate, attacks };
    case 'skeleton':
      return { set: SKELETON_CLIPS, planted: true, flapBase: 0, freeHz: 0, idleRate, attacks };
    case 'dread_king':
      return { set: DREAD_KING_CLIPS, planted: true, flapBase: 0, freeHz: 0, idleRate, attacks };

    default:
      return animalGait(species) !== null
        ? { set: QUADRUPED_CLIPS, planted: true, flapBase: 0, freeHz: 0, idleRate, attacks }
        : { set: WINGED_CLIPS, planted: false, flapBase: 2.6, freeHz: 0, idleRate, attacks };
  }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** What one creature was playing on the frame it was last updated. */
export interface AnimDebugEntry {
  state: AnimState;
  clip: string;
  clipT: number;
  attack: string | null;
  /** Seconds until the contact frame; negative once the blow has landed. */
  contactIn: number;
}

/**
 * Dev-only introspection and playhead scrubbing. Off by default.
 *
 * WHY THIS IS IN THE SHIPPING MODULE AND NOT IN THE HARNESS
 *
 * A capture harness that samples screenshots and infers what it caught is a
 * harness that lies. This repo has a documented history of exactly that — a
 * portrait run that photographed the back of a head for a session, a walk strip
 * of six standing animals, front views that were rear views. An attack is the
 * worst case for it: the clip is shorter than a screenshot round trip, so a
 * naive strip is mostly rest pose and every frame of it looks plausible.
 *
 * With `hold` set, the harness names the species, the move and the exact second
 * of the clip it wants, and gets THAT frame. With `log` enabled it can then
 * read back what the driver actually played and assert it matches — the frame
 * is evidence, not a hope.
 *
 * Cost when disabled: one boolean read per creature per frame.
 */
export const animDebug: {
  enabled: boolean;
  log: Map<string, AnimDebugEntry>;
  hold: { id: string; move: string; t: number } | null;
  /** The attack table, so a harness can enumerate moves without a second copy. */
  attacks: typeof ATTACK_MOVES;
} = { enabled: false, log: new Map(), hold: null, attacks: ATTACK_MOVES };

// Reachable from a page harness without any other module having to export it.
// Guarded so the Node test runner, which has no `window`, is unaffected.
if (typeof globalThis !== 'undefined') {
  (globalThis as unknown as { __animDebug?: typeof animDebug }).__animDebug =
    animDebug;
}

/** The animation configuration for a species. Exposed for tests. */
export function animConfig(species: Species): SpeciesAnim {
  return speciesAnim(species);
}

// ---------------------------------------------------------------------------
// State selection
// ---------------------------------------------------------------------------

/**
 * Which clip a creature should be playing.
 *
 * Locomotion is chosen from MEASURED speed rather than from `e.mode`, which is
 * what makes `follow` and ridden mounts animate at all — neither has a mode the
 * old lookup recognised, but both plainly move. Mode is then consulted only for
 * things speed cannot tell you: whether a stationary creature is grazing,
 * watching you, or just standing.
 */
export function pickState(
  mode: EntityMode, species: Species, speed: number, sit: number,
  sitTime: number, melee: boolean, flight: AnimState | null,
): AnimState {
  if (mode === 'dead') return 'dead';
  if (flight !== null) return flight;
  if (sit > 0.5) return sitTime >= SLEEP_AFTER_S ? 'sleep' : 'sit';

  if (speed > MOVE_EPS) {
    if (mode === 'flee') return 'flee';
    // Threshold at 78% of the species' nominal speed: wander runs at 0.6x and
    // must read as a walk, flee at 1.4x and must read as a run, aggro charges
    // at 1.0x and should read as a run.
    return speed > SPECIES_DEFS[species].speed * 0.78 ? 'run' : 'walk';
  }

  if (melee) return 'alert';
  if (mode === 'graze') return 'graze';
  // Anything squared up to anything is `alert`, not `idle`. 'hunt' and
  // 'defend' were missing, so a wolf standing over the deer it had just run
  // down relaxed into its idle head-scan on the frame it stopped moving.
  if (mode === 'aggro' || mode === 'flee' || mode === 'hunt' || mode === 'defend') {
    return 'alert';
  }
  return 'idle';
}

// ---------------------------------------------------------------------------
// Per-entity driver
// ---------------------------------------------------------------------------

/** One frame of animation output. Fields are reused; read them, do not retain. */
export interface CreatureFrame {
  /** Pose for `buildAnimalMesh`. Mutated in place every frame. */
  pose: AnimalPose;
  /**
   * Metres to add to the entity's world Y, combining the gait bob (which the
   * builder has already compensated its foot targets for) with the clip's body
   * sink and the additive layer's breathing.
   */
  yOffset: number;
  /** The clip currently playing, for diagnostics and tests. */
  state: AnimState;
  /** Low-passed ground speed in m/s, for diagnostics and tests. */
  speed: number;
  /**
   * The kind of blow being thrown this frame, or null when not attacking.
   *
   * Exposed so impact sounds and hit effects can key off what the animal is
   * DOING rather than what it is — a bite and a claw want different audio on
   * the same bear — without any other system having to know the clip library
   * exists.
   */
  attack: AttackKind | null;
  /**
   * Seconds until the current swing's contact frame; negative once the blow
   * has landed, `NaN` when not attacking.
   *
   * This is the number that lets a damage or effect system be frame-accurate
   * against the animation instead of guessing, and it is what the contact-time
   * test asserts against the AI's own damage tick.
   */
  contactIn: number;
}

export class CreatureAnim {
  readonly species: Species;
  readonly cfg: SpeciesAnim;
  readonly animator: Animator;

  /** Gait phase in radians. Owned here, NOT read from `e.walkPhase`. */
  walkPhase = 0;

  /** Frame index this driver was last used, for pool eviction. */
  seenAt = 0;

  private state: AnimState = 'idle';
  private speed = 0;
  private climb = 0;
  private airborne = false;
  private flightOverride: AnimState | null = null;
  private sitTime = 0;
  private prevX = NaN;
  private prevY = 0;
  private prevZ = NaN;
  private prevTime = -1;
  private prevTimer = 0;

  /** The move being played right now, or null when not mid-swing. */
  private swingMove: AttackMove | null = null;
  /** The move chosen for the NEXT blow, held so its `contactT` can lead it. */
  private nextMove: AttackMove | null = null;
  /** The last move actually thrown, so the picker can avoid repeating it. */
  private lastMove: AttackMove | null = null;
  /** How many blows this creature has thrown; the picker's variation counter. */
  private attackNo = 0;
  /** Seconds of enforced pause remaining after the last swing. See `SWING_GAP`. */
  private swingGap = 0;

  /** Preallocated output. One `AnimalPose` per creature, forever. */
  private readonly pose: AnimalPose = {
    yaw: 0, walkPhase: 0, walkAmp: 0,
    headYaw: 0, flapPhase: 0, flapAmp: 0, jawOpen: 0, bodyDrop: 0,
  };

  private readonly frame: CreatureFrame = {
    pose: this.pose, yOffset: 0, state: 'idle', speed: 0,
    attack: null, contactIn: NaN,
  };

  constructor(id: string, species: Species) {
    this.species = species;
    this.cfg = speciesAnim(species);
    this.animator = new Animator(id, this.cfg.set.clips.idle);
    this.animator.setIdleLayer(this.cfg.set.idleLayer, this.cfg.idleRate);
    // Decorrelate the gait itself as well as the idle layer. Two deer spawned
    // at the same instant and walking side by side would otherwise step in
    // perfect unison, which reads as a single four-legged animal with a
    // rendering artefact rather than as two.
    this.walkPhase = this.animator.seed * Math.PI * 2;
  }

  /**
   * Force a flight state (`flap`, `glide`, `land`) or release it with `null`.
   *
   * Automatic detection below is deliberately conservative, because the one
   * signal available here — vertical velocity — is also produced by running
   * over a hill. A caller that actually knows the creature is airborne (the
   * mounted-dragon flight controller in `main.ts` does) should say so through
   * this rather than hope the heuristic agrees.
   */
  setFlight(state: AnimState | null): void {
    this.flightOverride = state;
  }

  /**
   * True when this creature has wings, and therefore benefits from being told
   * its height above the ground (see the flight detection in `update`).
   *
   * Exposed so the caller does not have to keep its own list of which species
   * fly — that list already exists here as the clip set, and a second copy
   * elsewhere would silently miss the next winged species added. It costs a
   * terrain lookup per entity per frame, so the caller should only pay it for
   * creatures that can use the answer.
   */
  get wantsGroundHeight(): boolean {
    return this.cfg.flapBase > 0;
  }

  /**
   * Advance one frame and produce the pose.
   *
   * @param e             The entity, read-only. Nothing here mutates it.
   * @param simTime       Game seconds.
   * @param distToPlayer  Metres, used to tell a charging predator from a
   *                      biting one.
   */
  update(
    e: EntityState,
    simTime: number,
    distToPlayer: number,
    groundY?: number,
  ): CreatureFrame {
    // --- timing and measured motion -------------------------------------
    const raw = this.prevTime < 0 ? 0 : simTime - this.prevTime;
    const fresh = raw <= 0 || raw > STALE_S;
    const dt = fresh ? 1 / 60 : raw;
    this.prevTime = simTime;

    let dist = 0;
    let dy = 0;
    if (fresh || Number.isNaN(this.prevX)) {
      this.speed = 0;
      this.climb = 0;
    } else {
      dist = Math.hypot(e.x - this.prevX, e.z - this.prevZ);
      dy = e.y - this.prevY;
      // Low-pass both. The sim steps at a fixed rate that is not the frame
      // rate, so raw per-frame displacement alternates between zero and double
      // — unsmoothed it would flicker the creature between `idle` and `run`
      // several times a second.
      const k = 1 - Math.exp(-dt / SPEED_TAU);
      this.speed += (dist / dt - this.speed) * k;
      const kc = 1 - Math.exp(-dt / CLIMB_TAU);
      this.climb += (dy / dt - this.climb) * kc;
    }
    this.prevX = e.x;
    this.prevY = e.y;
    this.prevZ = e.z;

    // --- flight detection ------------------------------------------------
    //
    // ALTITUDE is the authoritative signal when the caller can supply ground
    // height; vertical velocity is only the fallback.
    //
    // Velocity alone gets level flight wrong, and wrong in the way players
    // actually notice: a dragon cruising at constant height has climb ~= 0, so
    // the velocity heuristic decided it had landed and folded its wings
    // mid-air. The wings then beat only while the ascend key was held, which
    // is precisely backwards — a creature 20 m up is flying whether or not it
    // is currently gaining height. Altitude says so unambiguously, and it
    // cannot be confused with running over a hill, which is the reason the
    // velocity heuristic had to be so conservative in the first place.
    let flight: AnimState | null = this.flightOverride;
    if (flight === null && this.cfg.flapBase > 0) {
      if (groundY !== undefined) {
        const altitude = e.y - groundY;
        if (altitude > FLY_ENTER_Y) {
          this.airborne = true;
        } else if (this.airborne && altitude < FLY_EXIT_Y) {
          this.airborne = false;
          flight = 'land';
        }
        if (this.airborne) {
          // Beating to climb or hold height, gliding on the way down. The
          // threshold is deliberately below zero so level flight beats rather
          // than glides — a dragon holding altitude is working, not coasting.
          flight = this.climb > -GLIDE_SINK ? 'flap' : 'glide';
        }
      } else if (Math.abs(this.climb) > CLIMB_FLY) {
        this.airborne = true;
        flight = this.climb > 0 ? 'flap' : 'glide';
      } else if (this.airborne && Math.abs(this.climb) < CLIMB_LAND) {
        this.airborne = false;
        flight = 'land';
      } else if (this.airborne) {
        flight = this.climb > 0 ? 'flap' : 'glide';
      }
    }

    // --- sit / sleep bookkeeping ----------------------------------------
    const sit = e.sit ?? 0;
    this.sitTime = sit > 0.5 ? this.sitTime + dt : 0;

    // --- attack trigger --------------------------------------------------
    //
    // THE HIT EVENT
    //
    // There is no attack signal on the entity. But `animal-ai.ts` resets
    // `stateTimer` to the 1.2 s cooldown at the exact instant a blow lands, and
    // in `aggro` mode that counter has no other job — so a jump upward IS the
    // hit event, readable with no change to any file this workstream does not
    // own.
    //
    // ANTICIPATION, AND WHY THE OBVIOUS VERSION IS WRONG
    //
    // Playing the swing ON that jump is what the first version did, and it is
    // backwards. `animal-ai` deals the damage and resets the timer in the same
    // statement, so the player takes the hit on the frame the WINDUP starts and
    // the creature's jaws arrive a third of a second later, chewing on
    // somebody who has already been bitten. Every attack in the game landed
    // before it was thrown.
    //
    // The fix is to start early instead. `stateTimer` counts DOWN to the blow,
    // so it is a countdown the animation can read: begin the swing when the
    // remaining time equals the move's declared `contactT`, and the strike apex
    // arrives on the same frame as the damage. That is what `contactT` is for,
    // and a test asserts the two agree to within a frame.
    //
    // The jump is still watched, as the fallback for the one case anticipation
    // cannot cover: `animal-ai` enters `aggro` with `stateTimer` already at
    // zero, so the FIRST blow of a fight has no countdown to read.
    // Which distance matters, and to what.
    //
    // The driver is handed the distance to the PLAYER, which is the wrong
    // number the moment a creature is fighting something else: a wolf mauling
    // a deer twenty metres away would sit in `alert` and never swing. The AI
    // writes the distance to the actual combat target on the entity while it
    // has one, so use that when it exists and fall back to the player.
    //
    // `strike` is the species' own reach rather than the shared 2.5 m, because
    // the Dread King's greatsword lands at 4.1 m — gating his windup on 2.5
    // would leave him flailing at air for the last metre and a half of every
    // approach, which is exactly the bug the tight `STRIKE_DIST` was
    // introduced to prevent for wolves.
    const fighting = isFighting(e);
    const range = combatDistance(e) ?? distToPlayer;
    const strike = Math.max(STRIKE_DIST, attackReach(SPECIES_DEFS[this.species]));
    const melee = fighting && range <= Math.max(MELEE_DIST, strike + 0.5);
    const landed = fighting && e.stateTimer > this.prevTimer + 1e-3;
    this.prevTimer = e.stateTimer;

    // A swing owns the creature until its clip runs out; after that a short
    // pause. Re-triggering the clip that is already playing would be a silent
    // no-op in `Animator.play` — the swing would not restart, but the driver
    // would believe it had, and the NEXT blow would find the creature already
    // committed. That is not hypothetical: it is what made a dragon's second
    // fire breath land a quarter of a second after the burn.
    const busy = this.swingMove !== null && !this.animator.finished;
    if (busy) this.swingGap = SWING_GAP;
    else if (this.swingGap > 0) this.swingGap -= dt;

    let trigger: AttackMove | null = null;
    if (fighting && range <= strike && this.cfg.attacks.length > 0) {
      if (this.nextMove === null) {
        this.nextMove = pickAttack(this.cfg.attacks, this.animator.seed,
          this.attackNo, range, this.lastMove);
      }
      if (!busy && this.swingGap <= 0
          && (landed || (this.speed < SETTLED_SPEED
                         && e.stateTimer <= this.nextMove.contactT))) {
        trigger = this.nextMove;
      }
    } else {
      this.nextMove = null;
    }
    if (landed) { this.attackNo++; this.nextMove = null; }

    // --- clip selection --------------------------------------------------
    const set = this.cfg.set;
    const next = pickState(
      e.mode, this.species, this.speed, sit, this.sitTime, melee, flight);

    if (e.mode === 'dead') {
      // Death interrupts everything, including a swing already in flight.
      this.animator.play(resolveState(set, 'dead'), FADE_IN.dead);
      this.state = 'dead';
      this.swingMove = null;
    } else if (trigger !== null) {
      this.animator.play(trigger.clip, FADE_IN.attack);
      // A blow with no countdown to anticipate — the first of a fight, since
      // `animal-ai` enters `aggro` with the timer already at zero — is shown
      // FROM its contact frame rather than from the top. Two reasons, and the
      // second is the one that matters: playing a windup for damage the player
      // has already taken animates the past, and it also occupies the creature
      // for the length of that windup, which pushes the NEXT swing late by
      // exactly as much. Starting at contact costs one abrupt frame on the
      // opening blow and keeps every blow after it exactly on the beat.
      if (e.stateTimer > trigger.contactT) {
        this.animator.setClipTime(trigger.contactT);
      }
      this.state = 'attack';
      this.swingMove = trigger;
      this.lastMove = trigger;
      this.swingGap = SWING_GAP;
    } else if (this.swingMove !== null && !this.animator.finished
               && e.mode === 'flee') {
      // Fear beats commitment. An animal that has decided to run does not
      // finish the bite it had started, and the crossfade out of a half-played
      // swing is exact by construction — the animator fades from the pose it
      // emitted last frame, not from the clip it was playing.
      //
      // Goes through `next` rather than straight to `flee` so a creature that
      // has decided to run but has not started moving yet gets `alert`, which
      // is what `pickState` says a stationary fleeing animal is doing. Forcing
      // the run clip here instead spent one fade arriving at a gallop the
      // creature was not performing and the next fade leaving it again.
      this.animator.play(resolveState(set, next), FADE_IN[next]);
      this.state = next;
      this.swingMove = null;
    } else if (!this.animator.clip.loop && !this.animator.finished) {
      // A one-shot (attack, land) owns the creature until it completes.
      // Re-deciding every frame would cut the strike off at the windup, which
      // is exactly the frame the state machine is most likely to change its
      // mind on: `pickState` sees a stationary creature the instant it stops
      // to bite.
    } else {
      this.animator.play(resolveState(set, next), FADE_IN[next]);
      this.state = next;
      this.swingMove = null;
    }

    // --- debug scrub -----------------------------------------------------
    //
    // Overrides everything above and pins the playhead, so a harness can film a
    // named second of a named move. See `animDebug`.
    const hold = animDebug.enabled && animDebug.hold !== null
      && animDebug.hold.id === e.id ? animDebug.hold : null;
    if (hold !== null) {
      const want = this.cfg.attacks.find(m => m.name === hold.move);
      if (want !== undefined) {
        if (this.animator.clip !== want.clip) this.animator.snap(want.clip);
        this.swingMove = want;
        this.state = 'attack';
        // `update` adds `dt` first, so aim one step short of the target.
        this.animator.setClipTime(hold.t - dt);
      }
    }

    // Corpses do not breathe. Removing the layer rather than zeroing its weight
    // means a dead creature costs one clip sample per frame instead of two.
    this.animator.setIdleLayer(
      e.mode === 'dead' ? null : set.idleLayer, this.cfg.idleRate);

    const buf: Readonly<PoseBuffer> =
      this.animator.update(dt, this.cfg.flapBase);

    // --- amplitude and phase ---------------------------------------------
    const def = SPECIES_DEFS[this.species];
    const gate = buf[Ch.WalkAmp];
    let amp: number;
    if (this.cfg.planted) {
      // sqrt(v / vRef): stride length and cadence each scale as the square root
      // of speed, which is how real gait works and, more importantly, is what
      // makes the phase rule below exact at every speed.
      const speedAmp = Math.min(1, Math.sqrt(Math.max(0, this.speed) / def.speed));
      amp = gate * speedAmp;
    } else {
      // No ground contact, so amplitude is whatever the clip asked for.
      amp = gate;
    }

    const stride = animalStride(this.species);
    if (this.cfg.planted) {
      if (amp > AMP_DEAD) {
        const eff = Math.max(AMP_FLOOR, amp);
        const d = (dist / (stride * eff)) * Math.PI * 2;
        this.walkPhase += d > MAX_DPHASE ? MAX_DPHASE : d;
      }
      // Below AMP_DEAD the builder's stride is zero, every foot target
      // collapses to the rest pose and phase has no observable effect — so
      // holding it is free and avoids dividing by nothing.
    } else {
      const byDist = dist / stride;
      const byTime = this.cfg.freeHz * dt;
      const d = Math.max(byDist, byTime) * Math.PI * 2;
      this.walkPhase += d > MAX_DPHASE ? MAX_DPHASE : d;
    }
    // Keep the accumulator bounded; `sin` loses resolution long before a
    // session ends otherwise.
    if (this.walkPhase > 1e5) this.walkPhase -= 1e5;

    // --- map channels onto the pose --------------------------------------
    const pose = this.pose;
    pose.yaw = e.yaw;
    pose.walkPhase = this.walkPhase;
    pose.walkAmp = amp;
    pose.headYaw = buf[Ch.HeadYaw];
    pose.jawOpen = buf[Ch.JawOpen];
    // Plumbed 2026-07-25: these three were authored throughout the clip
    // libraries with nowhere to go. `headPitch` is what puts a grazing muzzle
    // in the grass and drives gore/butt/peck; `tailSway` is the counter-swing
    // that sells an attack's weight; `foreSwing` is the only channel that can
    // move a foreleg on a STATIONARY animal, because stride amplitude is
    // derived from speed and is therefore zero exactly when a creature plants
    // itself to strike.
    pose.headPitch = buf[Ch.HeadPitch];
    pose.tailSway = buf[Ch.TailSway];
    pose.foreSwing = buf[Ch.ForeSwing];
    if (this.cfg.flapBase > 0) {
      // While scrubbing, freeze the wing BEAT as well as the playhead.
      //
      // The beat is an independent always-on cycle: `flapPhase` integrates
      // every frame regardless of what clip is playing, so two screenshots
      // 200 ms apart show a griffin's wings in visibly different places even
      // when the attack pose is byte-identical. That is a real animation and it
      // completely swamped the attack signal — a capture run measured a noise
      // floor of 54 against a signal of zero and correctly reported that it had
      // filmed nothing. Pinning the phase at pi/2 puts the wings at the top of
      // the stroke, where wing height is `base + flapAmp * k` — so the clip's
      // FlapAmp channel, which is what the attack actually animates, still
      // shows at full sensitivity while the cycle underneath holds still.
      pose.flapPhase = hold !== null ? Math.PI * 0.5 : this.animator.flapPhase;
      pose.flapAmp = buf[Ch.FlapAmp];
    }
    // Same value to the builder and to the object offset — that is the whole
    // `bodyDrop` contract, and breaking it drags every planted foot through
    // the terrain.
    const drop = animalBodyDrop(this.species, this.walkPhase, amp);
    pose.bodyDrop = drop;

    const frame = this.frame;
    frame.yOffset = drop - buf[Ch.BodySink] * def.size;
    frame.state = this.state;
    frame.speed = this.speed;
    const swing = this.swingMove;
    frame.attack = swing === null ? null : swing.kind;
    frame.contactIn = swing === null
      ? NaN : swing.contactT - this.animator.clipTime;

    if (animDebug.enabled) {
      animDebug.log.set(e.id, {
        state: this.state, clip: this.animator.clip.name,
        clipT: this.animator.clipTime,
        attack: swing === null ? null : swing.name,
        contactIn: frame.contactIn,
      });
    }
    return frame;
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Keeps one `CreatureAnim` per entity id and evicts the ones that stop being
 * drawn.
 *
 * Eviction matters more than it looks: entities stream in and out constantly as
 * the player moves, so a map that only ever grew would accumulate one animator
 * per creature ever seen for the whole session. Sweeping on a frame counter
 * rather than on every lookup keeps the common path a single `Map.get`.
 */
export class CreatureAnimRegistry {
  private readonly map = new Map<string, CreatureAnim>();
  private frameNo = 0;
  private sweepIn = 0;

  /** Number of live animators; exposed for tests and diagnostics. */
  get size(): number { return this.map.size; }

  /** Call once per frame, before any `get`. */
  beginFrame(): void {
    this.frameNo++;
  }

  get(id: string, species: Species): CreatureAnim {
    let a = this.map.get(id);
    if (a === undefined || a.species !== species) {
      a = new CreatureAnim(id, species);
      this.map.set(id, a);
    }
    a.seenAt = this.frameNo;
    return a;
  }

  /** Call once per frame, after all `get`s. Sweeps periodically. */
  endFrame(): void {
    if (--this.sweepIn > 0) return;
    this.sweepIn = 120;
    // Two seconds of not being drawn. Generous on purpose: an entity that is
    // briefly displaced past `MAX_DRAWN` by a passing herd should keep its gait
    // phase rather than restart mid-stride.
    const cutoff = this.frameNo - 120;
    for (const [id, a] of this.map) {
      if (a.seenAt < cutoff) this.map.delete(id);
    }
  }

  clear(): void { this.map.clear(); }
}
