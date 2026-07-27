/**
 * castle-fight.ts — the shape of the last fight.
 *
 * PURE: no GPU, no DOM, no timers, no `Math.random`. `stepCastleFight` takes
 * the clock, the player and the two bosses' health and returns where the
 * dragon should be and what it should be doing, so the whole arc can be proven
 * in Node and a harness can pin it by pinning `simTime`.
 *
 * ## Why a state machine and not a cooldown
 *
 * `huntPose` in `castle-state.ts` already orbits the player, and the first
 * version of this fight was that plus "breathe every N seconds". It was
 * unbeatable and boring at the same time: a dragon 22 m up cannot be reached
 * with a sword, and one that breathes on a metronome from out of reach is a
 * weather system, not an opponent. A fight needs a tell, an opening and a
 * reason for the player's health bar to move in both directions.
 *
 * So the fight has four phases, and the thing that advances them is the
 * DRAGON'S health — which the player can only lower during the openings the
 * phases give them. That loop is the fight.
 *
 *   circle     (dragon > 65% hp)  High orbit at CIRCLE_R / CIRCLE_ALT. Breathes
 *                                 on a long cadence, always with a tell. The
 *                                 player's answer is to break the cone: it aims
 *                                 where they were when the tell started. Every
 *                                 ~14 s it SWOOPS — a dive that comes down to
 *                                 head height AND in to arm's length, which is
 *                                 the only window a sword can reach it in.
 *
 *   strafe     (65% .. 30%)       Tighter, faster orbit, shorter breath
 *                                 cadence, and swoops roughly twice as often.
 *                                 More openings, and more punishment for
 *                                 missing them.
 *
 *   grounded   (< 30%)            It lands and stays landed. Now it bites and
 *                                 the King swings from the saddle, both through
 *                                 the ordinary `stepAnimal` path, and both can
 *                                 be hit back. This is where the dragon dies.
 *
 *   dismounted (dragon dead)      The King is on his feet. Nothing here drives
 *                                 him — `stepAnimal` does, like any other
 *                                 melee enemy — but the phase exists so the
 *                                 caller knows to stop pinning him to a saddle
 *                                 that is now a corpse.
 *
 * ## The tell is the mechanic
 *
 * `BREATH_TELL_S` of roar-and-rear before any damage, during which the aim
 * point is LATCHED. Without the latch the cone tracks the player and there is
 * nothing to dodge; with it, moving during the tell is the counter and
 * standing still is the punishment. `breathAim` is the latched point and the
 * caller must use it rather than the live player position — a test asserts the
 * latch actually holds.
 */

import type { CastleAlarm } from './castle-state';
import { BREATH_RANGE } from '../fire';

/**
 * `BREATH_SPEC.black_dragon.reach`, mirrored.
 *
 * The spec table itself lives inside `main.ts`'s closure and cannot be
 * imported, so this is the one number that has to be kept in step by hand —
 * and `test-castle-fight.mts` asserts the two agree rather than trusting it.
 */
export const BLACK_DRAGON_REACH = 1.4;

/** Phases, in the order health drives them through. */
export type FightPhase = 'circle' | 'strafe' | 'grounded' | 'dismounted';

/** What the breath is doing this frame. */
export type BreathStage = 'none' | 'tell' | 'burning';

// --- tuning ---------------------------------------------------------------
//
// Every number below is authored against a 20 hp player (`vitals.MAX_HP`) and
// a 4 dmg sword swing, which is what the starter kit actually gives them.

/**
 * The orbits, and the constraint that sets them.
 *
 * Both radii and both altitudes are bounded by `BREATH_REACH` below, and that
 * is not a nicety. The first version circled at R = 34, ALT = 20, which is a
 * SLANT range of 39.4 m against a breath that reaches 28 — so the dragon
 * telegraphed, roared, opened its jaws, emitted a full jet of flame, and the
 * cone test rejected the player on every single tick. Played, it looked
 * exactly like a working boss and did precisely nothing: the harness measured
 * player hp 20 -> 20 across ninety seconds of standing still inside it.
 *
 * That is the same failure this repo has hit before and the reason the rule
 * here is a derived assertion rather than a comment: `test-castle-fight.mts`
 * checks the orbit geometry against the real range constant, so moving either
 * one without the other fails rather than silently disarming the boss.
 */
export const CIRCLE_R = 20;
export const CIRCLE_ALT = 12;
/** Seconds for one high circuit. */
const CIRCLE_PERIOD = 20;

/** Strafing orbit: closer, lower, quicker. */
const STRAFE_R = 15;
const STRAFE_ALT = 9;
const STRAFE_PERIOD = 13;

/** Phase thresholds as a fraction of the dragon's max hp. */
export const STRAFE_AT = 0.65;
export const GROUND_AT = 0.30;

/** Roar-and-rear before the jet. The dodge window. */
export const BREATH_TELL_S = 1.1;
/** How long the jet burns. */
export const BREATH_S = 1.6;
/** Gap between breaths, per phase. Grounded is slowest: it is also biting. */
const BREATH_GAP: Record<FightPhase, number> = {
  circle: 5.0, strafe: 3.4, grounded: 6.0, dismounted: Infinity,
};
/**
 * How far the black dragon's jet actually reaches, metres.
 *
 * `BREATH_RANGE` (fire.ts) is 20 and `BREATH_SPEC.black_dragon.reach` is 1.4,
 * so 28. Imported rather than written down: this number is the ceiling on
 * every orbit distance in this file, and the version that had it as a comment
 * said 42 — because it read `BREATH_RANGE` as 30 — which is how the dragon
 * ended up circling 11 m outside its own weapon.
 */
export const BREATH_REACH = BREATH_RANGE * BLACK_DRAGON_REACH;

/**
 * The dragon only starts a breath inside this range, measured in 3D.
 *
 * Inside `BREATH_REACH` with margin, so a cycle that begins can actually
 * connect — a boss that telegraphs and then misses by construction teaches the
 * player that the tell means nothing.
 */
const BREATH_MAX_DIST = BREATH_REACH - 3;

/**
 * The swoop is the whole reason this fight is winnable.
 *
 * A dragon orbiting 20 m up and 34 m out cannot be reached by anything in the
 * starter kit — no bow, and `ENTITY_HIT_DIST` is 3.2 m of XZ with a vertical
 * gate of `2.5 + size`. So without a pass that comes down AND comes in, phase
 * one never ends: the player takes breath damage forever and deals none, and
 * the only counterplay is to go and fetch the tamed wyvern parked outside the
 * breach. That is a fine option, not an acceptable requirement.
 *
 * So both airborne phases swoop. The dive drops to `SWOOP_ALT` above the
 * player AND pulls the orbit radius in to `SWOOP_PASS_R`, which puts the
 * dragon inside melee reach at the bottom of the arc for `SWOOP_LOW_S`. That
 * window is the opening; hitting it is how the fight advances.
 */
const SWOOP_GAP: Record<'circle' | 'strafe', number> = { circle: 11, strafe: 6.5 };
const SWOOP_S = 3.4;
/** How long inside a swoop the dragon is at strike height. */
const SWOOP_LOW_S = 1.6;
/** Height above the player at the bottom of a swoop — sword reach. */
const SWOOP_ALT = 2.6;
/**
 * Orbit radius at the bottom of a swoop.
 *
 * 2.6 m, not 0: it has to be inside `ENTITY_HIT_DIST` (3.2 m) for the player's
 * swing to connect, and outside 0 so a 19 m animal does not pass through the
 * player's own capsule.
 */
const SWOOP_PASS_R = 2.6;

/**
 * How close the dragon must already be to begin a swoop, metres.
 *
 * Just over the high orbit radius, so a dragon actually on station always
 * qualifies and one that is not, never does. Two separate things depend on
 * the margin being tight rather than generous, and both were measured:
 *
 *   - the dive carries `BOSS_DIVE_SPEED`, so a dragon that could start a
 *     swoop from anywhere used it as a travel speed and crossed 200 m in five
 *     seconds — at which point the cruise cap is not a cap at all;
 *   - a player fleeing on a wyvern is only 3.5 m/s faster than the dragon, so
 *     if it can keep starting dives while trailing them it claws the distance
 *     back on every one. At `CIRCLE_R * 2` a fleeing player gained 16 m in
 *     12 s, which is not an escape. At 1.35x the swoops stop as soon as they
 *     have pulled clear and the chase becomes the speed difference, which is
 *     the number that was chosen deliberately.
 */
const SWOOP_START_DIST = CIRCLE_R * 1.35;

/** Where the dragon puts down, relative to the player. */
const LAND_DIST = 7.0;
/** Seconds to descend to the ground once `grounded` is entered. */
const LAND_S = 2.6;

// --- the dragon's body -----------------------------------------------------
//
// ## Why any of this exists
//
// The pose used to be a PURE FUNCTION of the player's position and a clock:
// `x = playerX + cos(ang) * radius`. There was no dragon — no stored position,
// no velocity — only a point rigidly offset from the player, recomputed every
// frame. Two things the player felt directly:
//
//   - **It teleported on respawn.** Die, reappear a kilometre away, and the
//     computed point moves with you: the dragon is simply THERE on the next
//     frame. It never travelled, so you never saw it coming.
//   - **Its speed was your speed.** Rigidly offset from a sprinting player, it
//     sprints; from a still player, it hovers. No top speed, no momentum, no
//     turn radius. You could not outrun it, and you could not gain ground on a
//     flying mount, because it was not moving under its own power at all.
//
// (`huntPose` in castle-state.ts has the same shape and gets the blame in most
// descriptions of this bug, but it is unreachable from the game: main.ts only
// calls `flightPose` when the castle is NOT hostile, and `flightPose` only
// returns `huntPose` when it IS. The live offender was the orbit below.)
//
// So the orbit is now a GOAL, and the dragon steers toward it with a body that
// has mass. Everything else follows: it has to fly to you, you can watch it
// come, and whether you can escape is a number someone chose.

/**
 * Cruise top speed, m/s.
 *
 * Bracketed by the two speeds that matter. A sprinting player does 10
 * (`SPRINT_SPEED`), so 16 means running is not an escape — it closes 6 m/s and
 * the chase stays a chase. A sprinting wyvern does 15 * 1.3 = 19.5 and a
 * dragon 18 * 1.3 = 23.4, so a mounted player gains 3.5 or 7.4 m/s and fleeing
 * by air genuinely works. Fleeing being possible is the point: it is what
 * makes going to fetch the tamed wyvern a real option rather than a hope.
 */
export const BOSS_SPEED = 16;

/**
 * Top speed through a swoop, m/s.
 *
 * A dive trades altitude for speed and a stooping animal is far faster than a
 * cruising one, so this is not a cheat — but it is also load-bearing, because
 * the swoop crosses ~35 m of radius and ~18 m of altitude inside `SWOOP_S`.
 * Held to `BOSS_SPEED` the dive simply cannot arrive, the dragon lags its own
 * goal, and the melee window that makes phase one beatable never opens.
 */
export const BOSS_DIVE_SPEED = 42;

/**
 * Acceleration, m/s^2. Turn radius falls out of this as `v^2 / a`: 21 m at
 * cruise, which is a big animal leaning into a turn rather than a cursor
 * snapping to a new offset.
 */
const BOSS_ACCEL = 12;
const BOSS_DIVE_ACCEL = 80;

/** Yaw slew, rad/s — about 92 deg per second. */
const BOSS_TURN = 1.6;

/**
 * Break-off range from the keep, metres, with hysteresis at 0.55x.
 *
 * Without a leash the boss follows the player across the whole overworld and
 * ends up parked over a village 3 km from the castle it is supposed to be
 * defending. Beyond this it goes home and resumes the patrol; the player can
 * disengage, and the fight stays at the castle where its geometry is.
 */
export const BOSS_LEASH_R = 260;

/** Radius/altitude/period of the circuit it flies home to. Mirrors `PATROL_R`. */
const HOME_R = 86;
const HOME_ALT = 26;
const HOME_PERIOD = 44;

/** Shortest signed angle from `a` to `b`. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export interface CastleFight {
  phase: FightPhase;
  /** simTime the current phase began — drives the landing blend and notices. */
  phaseAt: number;
  /** simTime the current breath cycle started (its tell, not its jet). */
  breathAt: number;
  /** Latched aim point, world space, captured when the tell begins. */
  aimX: number;
  aimY: number;
  aimZ: number;
  /** simTime the current swoop began, or -1 when not swooping. */
  swoopAt: number;
  /** simTime the last swoop finished — the gap is measured from this. */
  swoopEnd: number;
  /** Set once, so the caller can fire a one-shot notice per phase. */
  announced: FightPhase | null;

  // --- body: real position, velocity and facing, integrated each step ------
  bx: number; by: number; bz: number;
  vx: number; vy: number; vz: number;
  byaw: number;
  /** False until the body has been seeded from the animal's actual position. */
  seeded: boolean;
  /** True while breaking off for the castle. Hysteretic — see `BOSS_LEASH_R`. */
  returning: boolean;
}

export function createCastleFight(): CastleFight {
  return {
    phase: 'circle', phaseAt: 0, breathAt: -Infinity,
    aimX: 0, aimY: 0, aimZ: 0, swoopAt: -1, swoopEnd: -Infinity,
    announced: null,
    bx: 0, by: 0, bz: 0, vx: 0, vy: 0, vz: 0, byaw: 0,
    seeded: false, returning: false,
  };
}

/**
 * Everything the body integration needs, and nothing the phase logic does.
 *
 * Optional on `stepCastleFight`: omitted, the function returns the raw GOAL
 * pose exactly as it did before there was a body, which is what the phase,
 * breath-latch and swoop-cadence tests want to assert against. The game always
 * passes it.
 */
export interface BossMotion {
  dtS: number;
  /** The animal's real position, used to seed the body on the first step. */
  curX: number; curY: number; curZ: number;
  /** Castle centre, for the leash and the flight home. */
  keepX: number; keepY: number; keepZ: number;
}

/** What the caller should do with the dragon this frame. */
export interface FightCommand {
  phase: FightPhase;
  /** True on the frame the phase changed — fire the roar and the notice here. */
  entered: boolean;
  /** Where to put the dragon. Ignored once `handOff` is true. */
  x: number;
  y: number;
  z: number;
  /** Mesh facing, `atan2(dx, -dz)`. */
  yaw: number;
  /**
   * True once the dragon should be driven by `stepAnimal` instead of by this
   * pose — it is on the ground and fighting like any other creature. The
   * caller stops writing x/y/z and stops forcing `flightOverride`.
   */
  handOff: boolean;
  breath: BreathStage;
  /** Latched aim point for the cone. Only meaningful while breath !== 'none'. */
  aim: [number, number, number];
  /** 0..1 through the current swoop; 0 when not swooping. Drives the wing state. */
  swoopT: number;
  /**
   * Where the dragon is TRYING to be. The orbit point used to be the answer;
   * now it is the question, and the gap between `goal` and (x, y, z) is the
   * dragon flying. Exposed so a probe can tell "lagging its goal because it
   * has a top speed" apart from "not tracking at all".
   */
  goal: [number, number, number];
  /** True while broken off and heading back to the keep — see `BOSS_LEASH_R`. */
  returning: boolean;
}

/**
 * Advance the fight.
 *
 * `groundY` is the height the dragon would land at under its own position —
 * the caller resolves it, because only the caller knows whether that is the
 * tower arena, a courtyard slab or the hillside. Passing the player's height
 * instead was the first version and it planted the dragon inside the parapet
 * whenever the player was standing on it.
 *
 * `dragonDist` is last frame's dragon-to-player distance. It gates whether a
 * breath cycle may START, and it has to come from the caller because this
 * function is what decides where the dragon is — measuring it from the pose
 * computed below would gate this frame's breath on this frame's position and
 * make the cadence depend on the phase's orbit radius.
 */
export function stepCastleFight(
  f: CastleFight,
  t: number,
  alarm: CastleAlarm,
  playerX: number, playerY: number, playerZ: number,
  dragonDist: number,
  dragonHpFrac: number,
  dragonAlive: boolean,
  groundY: number,
  motion?: BossMotion,
): FightCommand {
  // --- phase ---------------------------------------------------------------
  const want: FightPhase = !dragonAlive ? 'dismounted'
    : dragonHpFrac <= GROUND_AT ? 'grounded'
      : dragonHpFrac <= STRAFE_AT ? 'strafe'
        : 'circle';
  // Forward only. Healing the dragon is not a mechanic, but floating-point
  // noise around a threshold absolutely is, and a boss that oscillates between
  // landing and taking off is worse than one that does neither.
  const order: FightPhase[] = ['circle', 'strafe', 'grounded', 'dismounted'];
  let entered = false;
  if (order.indexOf(want) > order.indexOf(f.phase)) {
    f.phase = want;
    f.phaseAt = t;
    f.swoopAt = -1;
    entered = true;
  }

  const phase = f.phase;

  // Seed the body from where the animal ACTUALLY is, once. Seeding it from the
  // goal instead would put the dragon on its orbit on frame one, which is the
  // teleport this whole mechanism exists to remove.
  if (motion !== undefined && !f.seeded) {
    f.bx = motion.curX; f.by = motion.curY; f.bz = motion.curZ;
    f.vx = 0; f.vy = 0; f.vz = 0;
    f.seeded = true;
  }

  if (phase === 'dismounted') {
    return {
      phase, entered, x: playerX, y: groundY, z: playerZ, yaw: 0,
      handOff: true, breath: 'none', aim: [f.aimX, f.aimY, f.aimZ], swoopT: 0,
      goal: [playerX, groundY, playerZ], returning: f.returning,
    };
  }

  // --- leash ---------------------------------------------------------------
  //
  // Breaking off is measured from the DRAGON — "how far have I strayed from
  // the castle" is a question about the dragon. RE-ENGAGING is measured from
  // the PLAYER, and that asymmetry is the whole design: a symmetric test on
  // the dragon's own distance makes it yo-yo forever against a player parked
  // out of reach, flying out to the leash, turning for home, re-engaging on
  // the way in and turning round again. Measured, that oscillated between 143
  // and 260 m from the keep indefinitely.
  //
  // So once it has broken off it goes all the way home and patrols, and only
  // takes an interest again when the player comes back to the castle. Which
  // is also the fight the castle is for.
  if (motion !== undefined) {
    const dDragon = Math.hypot(f.bx - motion.keepX, f.bz - motion.keepZ);
    const dPlayer = Math.hypot(playerX - motion.keepX, playerZ - motion.keepZ);
    if (!f.returning) {
      if (dDragon > BOSS_LEASH_R) f.returning = true;
    } else if (dPlayer < BOSS_LEASH_R * 0.9 && dDragon < BOSS_LEASH_R * 0.75) {
      f.returning = false;
    }
  }
  const goingHome = f.returning;

  // --- breath cycle --------------------------------------------------------
  //
  // Runs before the pose, because the tell steers the dragon: it turns to face
  // its aim point and holds, which is what makes the wind-up readable from the
  // ground rather than something the player only learns from taking damage.
  let breath: BreathStage = 'none';
  const gap = BREATH_GAP[phase];
  const ready = t - f.breathAt >= BREATH_TELL_S + BREATH_S + gap;
  if (ready && alarm === 'hunting' && !goingHome && breathInRange(dragonDist)) {
    f.breathAt = t;
    // Latch the aim NOW, at the start of the tell. Everything the tell is for
    // depends on this point not moving afterwards.
    f.aimX = playerX;
    f.aimY = playerY;
    f.aimZ = playerZ;
  }
  const since = t - f.breathAt;
  if (since >= 0 && since < BREATH_TELL_S) breath = 'tell';
  else if (since >= BREATH_TELL_S && since < BREATH_TELL_S + BREATH_S) breath = 'burning';

  // --- swoop ---------------------------------------------------------------
  //
  // Never during a breath. Two set pieces at once is unreadable, and the
  // breath's whole job is to be readable.
  let swoopT = 0;
  if ((phase === 'circle' || phase === 'strafe') && !goingHome) {
    const gapS = SWOOP_GAP[phase];
    // Only from ON STATION. A swoop is a dive AT the player, and it carries
    // `BOSS_DIVE_SPEED` — so a dragon that could start one from anywhere used
    // the dive as a cross-country boost and covered 200 m in 5 seconds, at
    // which point the top speed the whole body model exists to impose is not
    // the top speed any more.
    if (f.swoopAt < 0 && breath === 'none' && t - f.phaseAt > 2
      && dragonDist <= SWOOP_START_DIST
      && t - f.swoopEnd >= gapS) {
      f.swoopAt = t;
    }
    if (f.swoopAt >= 0) {
      const s = t - f.swoopAt;
      if (s > SWOOP_S) { f.swoopAt = -1; f.swoopEnd = t; }
      else swoopT = s / SWOOP_S;
    }
  }

  // --- goal ----------------------------------------------------------------
  //
  // From here down the numbers describe where the dragon WANTS to be. Given a
  // `motion` the body then flies toward it under its own power; without one
  // the goal is returned directly, which is exactly what this file did before
  // it grew a body, and is what the phase and cadence tests assert against.
  let gx: number;
  let gy: number;
  let gz: number;
  let gyaw: number;
  let handOff = false;

  if (goingHome && motion !== undefined) {
    // Break off: rejoin the circuit over the keep and ignore the player
    // entirely. This is what stops the boss following someone across the
    // overworld and parking itself over a village 3 km from the castle.
    const a = (t / HOME_PERIOD) * Math.PI * 2;
    gx = motion.keepX + Math.cos(a) * HOME_R;
    gz = motion.keepZ + Math.sin(a) * HOME_R;
    gy = motion.keepY + HOME_ALT;
    gyaw = Math.atan2(-Math.sin(a), -Math.cos(a));
  } else if (phase === 'grounded') {
    // Put down at a fixed offset from where the player was when it committed,
    // then hand off. Blending the descent rather than snapping matters: a
    // 19 m dragon teleporting to the floor reads as a bug even though the
    // fight that follows is correct.
    const k = Math.min(1, (t - f.phaseAt) / LAND_S);
    const a = Math.atan2(playerZ - f.aimZ, playerX - f.aimX);
    const lx = playerX - Math.cos(a) * LAND_DIST;
    const lz = playerZ - Math.sin(a) * LAND_DIST;
    const airY = playerY + STRAFE_ALT;
    gx = lx;
    gz = lz;
    gy = airY * (1 - k) + groundY * k;
    gyaw = Math.atan2(playerX - lx, -(playerZ - lz));
    // Hand off only once it is actually down. Handing off mid-descent gives
    // `stepAnimal` a creature 14 m in the air and it pins it to the ground on
    // the next tick — the same one-frame teleport the blend exists to avoid.
    // With a body, "down" becomes a fact about the body rather than about the
    // clock, plus a timeout so a dragon that cannot reach its landing spot
    // eventually becomes a walking animal instead of hovering forever.
    handOff = motion === undefined
      ? k >= 1
      : (f.by - groundY <= 1.0 || t - f.phaseAt > LAND_S * 4);
  } else {
    const period = phase === 'circle' ? CIRCLE_PERIOD : STRAFE_PERIOD;
    const alt = phase === 'circle' ? CIRCLE_ALT : STRAFE_ALT;
    const ang = (t / period) * Math.PI * 2;

    // A swoop pulls BOTH the altitude and the radius in, on one smoothstep, so
    // the dive bottoms out beside the player rather than merely below where it
    // was already flying. `e` is 0 at the edges of the window and 1 across the
    // SWOOP_LOW_S plateau in the middle.
    let e = 0;
    if (swoopT > 0) {
      const edge = (1 - SWOOP_LOW_S / SWOOP_S) * 0.5;
      const k = swoopT < edge ? swoopT / edge
        : swoopT > 1 - edge ? (1 - swoopT) / edge
          : 1;
      e = k * k * (3 - 2 * k);                  // smoothstep
    }
    const baseR = phase === 'circle' ? CIRCLE_R : STRAFE_R;
    const radius = baseR * (1 - e) + SWOOP_PASS_R * e;
    gy = playerY + alt * (1 - e) + SWOOP_ALT * e;
    gx = playerX + Math.cos(ang) * radius;
    gz = playerZ + Math.sin(ang) * radius;

    // Facing: at the aim point during the tell and the jet (so the jet leaves
    // the mouth pointing where it is going to land), and at the PLAYER through
    // a swoop, so the pass reads as a run at them rather than a drive-by.
    // Along the circuit otherwise.
    gyaw = breath !== 'none'
      ? Math.atan2(f.aimX - gx, -(f.aimZ - gz))
      : e > 0.02
        ? Math.atan2(playerX - gx, -(playerZ - gz))
        : Math.atan2(-Math.sin(ang), -Math.cos(ang));
  }

  if (motion === undefined) {
    return {
      phase, entered, x: gx, y: gy, z: gz, yaw: gyaw, handOff,
      breath, aim: [f.aimX, f.aimY, f.aimZ], swoopT,
      goal: [gx, gy, gz], returning: f.returning,
    };
  }

  // --- fly there -----------------------------------------------------------
  //
  // Steer-toward with a speed cap and an acceleration cap. The turn radius is
  // `v^2 / a` and is deliberately not configured directly: capping the change
  // in VELOCITY rather than in heading is what makes the dragon lean into a
  // turn instead of pivoting on the spot, and it is why a swoop now reads as a
  // dive rather than as an offset being recomputed.
  const dtS = Math.min(0.1, Math.max(0, motion.dtS));
  const diving = swoopT > 0;
  const topSpeed = diving ? BOSS_DIVE_SPEED : BOSS_SPEED;
  const accel = diving ? BOSS_DIVE_ACCEL : BOSS_ACCEL;

  const dx = gx - f.bx;
  const dy = gy - f.by;
  const dz = gz - f.bz;
  const dist = Math.hypot(dx, dy, dz);
  // Ease the DESIRED speed down over the last few metres so the dragon settles
  // onto its orbit instead of buzzing back and forth across it.
  const cruise = Math.min(topSpeed, dist * 2.2);
  const wx = dist > 1e-4 ? (dx / dist) * cruise : 0;
  const wy = dist > 1e-4 ? (dy / dist) * cruise : 0;
  const wz = dist > 1e-4 ? (dz / dist) * cruise : 0;

  let ax = wx - f.vx;
  let ay = wy - f.vy;
  let az = wz - f.vz;
  const alen = Math.hypot(ax, ay, az);
  const maxDv = accel * dtS;
  if (alen > maxDv && alen > 1e-9) {
    const k = maxDv / alen;
    ax *= k; ay *= k; az *= k;
  }
  f.vx += ax; f.vy += ay; f.vz += az;
  const sp = Math.hypot(f.vx, f.vy, f.vz);
  if (sp > topSpeed && sp > 1e-9) {
    const k = topSpeed / sp;
    f.vx *= k; f.vy *= k; f.vz *= k;
  }
  f.bx += f.vx * dtS;
  f.by += f.vy * dtS;
  f.bz += f.vz * dtS;

  // Facing slews rather than snapping. During a breath it must still reach the
  // latched aim point or the tell stops being readable; 92 deg/s is generous
  // enough that it does, over a 1.1 s tell.
  f.byaw += Math.max(-BOSS_TURN * dtS,
    Math.min(BOSS_TURN * dtS, angleDelta(f.byaw, gyaw)));

  return {
    phase, entered, x: f.bx, y: f.by, z: f.bz, yaw: f.byaw, handOff,
    breath, aim: [f.aimX, f.aimY, f.aimZ], swoopT,
    goal: [gx, gy, gz], returning: f.returning,
  };
}

/**
 * True when the caller should start a breath cycle at all.
 *
 * Split out of the step so the distance test lives with the constant it uses
 * and so a test can assert the dragon does not telegraph at a player 200 m
 * away, which looks like a bug from the ground and wastes the cadence.
 */
export function breathInRange(dist: number): boolean {
  return dist <= BREATH_MAX_DIST && dist > 3;
}
