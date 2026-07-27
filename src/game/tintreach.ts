/**
 * Tintreach — the lightning arrow. *Tintreach* is Irish for lightning.
 *
 * PURE. No DOM, no GPU, no globals beyond one documented singleton shot record,
 * so `scripts/test-tintreach.mts` can assert the whole thing in Node. The GPU
 * side is `render/bolt-fx.ts`; the only thing that file adds is billboards.
 *
 * ## What it is
 *
 * Rare, finite ammunition. You find it, mostly on dungeon bosses, and every
 * shot spends one.
 *
 * It was a unique artifact — one quiver per save, an `addItem` chokepoint that
 * refused to open a second slot, a `normalizeTintreach` pass on every load to
 * re-enforce that against hand-edited save files, and a `refillTintreach` that
 * put the loosed arrow back so it could never empty. All of that is gone, on
 * the user's instruction: *"let's make the lightning arrows rare and very hard
 * to find, but they spawn mostly boss loot in dungeons... they are too fun to
 * use to be uber rare"*. Uniqueness and scarcity were pulling in opposite
 * directions — an item that can never run out is not scarce, it is just
 * ceremonial — and scarcity won.
 *
 * What did NOT change is the set of faucets. Still not craftable, not sold by
 * merchants, not an ordinary animal drop. Rare means rare; the only new source
 * is boss loot. The one hole in the old rule, `__gameDebug.equipItem` writing a
 * slot directly, was always a debug hook and is harmless now.
 *
 * The player starts with twelve rather than a full stack of 99 — enough to
 * learn what the weapon does and to win one fight they had no business
 * winning, not enough to make it the default answer.
 *
 * ## Hitscan, and why that needed no new hit code at all
 *
 * The bolt reaches the aim point in the frame it is fired. It does that by
 * spawning the ordinary pooled projectile AT the resolved aim point with
 * essentially no velocity, so the existing `resolveHit` finds the target on the
 * first sim step and applies damage, crime and audio through exactly the path a
 * flown arrow uses. Nothing forks.
 *
 * That works because of a property `aim.ts` already guarantees: `resolveAim`
 * returns the point ON THE RAY at the creature's closest approach, and
 * `rayCreature` accepts a candidate at `0.8 * max(1, size)` — the same radius
 * `resolveProjectileHit` tests with. So "the reticle named it" and "a projectile
 * at the reticle point hits it" are the same statement. The bolt cannot land
 * anywhere but where the crosshair marked, which is the one thing a weapon like
 * this must not get wrong.
 *
 * Nothing here may refuse a shot, for the same reason `aim.ts` says it: the
 * reticle is a readout, never permission. Sky, ground, nothing — it fires.
 *
 * ## Determinism
 *
 * Lightning looks random and is not. Every kink, branch and flicker is a pure
 * function of the SHOT INDEX (persisted, so shot 7 looks identical after a
 * reload) mixed through `mix32`. `Math.random` and wall-clock never enter the
 * geometry. The only clock anywhere in this file is `simTime`, and it drives
 * animation phase only — which also means the bolt freezes when the game
 * pauses, so it can be photographed.
 */

import { mix32 } from './dungeon/dungeon-layout';

// ---------------------------------------------------------------------------
// The ammunition
// ---------------------------------------------------------------------------

/**
 * Maximum per slot. Matches `stack` on the item def.
 *
 * This used to be "one full quiver" and was the size the stack was pinned to
 * for the life of a save. It is now an ordinary stack cap: arrows accumulate
 * across slots like any other loot, and a boss drop of 5-9 tops up whatever
 * you happen to be carrying.
 */
export const TINTREACH_STACK = 99;

/**
 * Damage multiplier against the ordinary arrow number.
 *
 * Tintreach hits harder than anything else in the game, and does NOT one-shot.
 *
 * This has moved twice on the user's instruction: first to a one-hit kill, then
 * back, once they decided the arrows should be rare loot rather than a unique
 * artifact — *"the highest hitting attack in the game, but not an instant kill"*.
 * A weapon that deletes any target makes every fight the same fight, and it made
 * the four-phase tower boss end with a single loose.
 *
 * The ceiling it has to beat, surveyed across every player-dealt hit:
 *
 *     bare hand 1 · axe / pickaxe 3 · sword 4 · staff (spear) 5
 *     mount bite 6 · hunter bow 6 · composite bow 9   <- the old best
 *
 * Ordinary arrow damage scales with draw — `round(base * (0.45 + 0.55 * power))`
 * — so a multiplier ALONE would leave a hastily-loosed bolt below an ordinary
 * aimed arrow, which is not "the highest hitting attack" in the sense meant.
 * Hence two knobs: a multiplier for the aimed shot, and a floor that keeps even
 * a snap shot above the old ceiling.
 *
 *     snap (power 0.45), hunter    -> max(10, 5)  = 10
 *     full draw, hunter            -> max(10, 12) = 12
 *     full draw, composite         -> max(10, 18) = 18
 *
 * For scale: the black dragon has 260 hp and the Evil King 300, so a full-draw
 * composite bolt is ~7% of the dragon. Roughly fifteen of them kill it — a real
 * fight that a quiver of rare arrows can meaningfully shorten, rather than skip.
 */
export const TINTREACH_DAMAGE_MUL = 2;

/**
 * Floor for any Tintreach bolt, however briefly drawn — one point above the
 * composite bow's full-draw 9, so the artifact is never worse than the ordinary
 * arrow it replaces even on a snap shot.
 */
export const TINTREACH_DAMAGE_FLOOR = 10;

/** localStorage key. Listed in `save-game.ts` GAME_STATE_KEYS so it travels. */
export const TINTREACH_KEY = 'artifex-tintreach:v1';

// ---------------------------------------------------------------------------
// Flash timeline (seconds of simTime since the shot)
// ---------------------------------------------------------------------------

/** The strike itself: full brightness, full dip, no flicker. */
export const STRIKE_S = 0.055;
/** The seam burns and flickers up to here. */
export const BURN_S = 0.34;
/** Total life. After this the bolt is gone and the frame is back to normal. */
export const LIFE_S = 1.10;
/**
 * Seconds the exposure takes to climb back after the strike ends.
 *
 * Deliberately about as long as the bolt itself lives. At 0.80 the dip had
 * closed by 0.85 s while the seam was still emitting at a fifth of peak, so the
 * frame ended up measurably BRIGHTER than baseline for most of a second —
 * which is the exact opposite of what the effect is for.
 */
export const DIP_RECOVER_S = 1.02;
/** How far down the scene is pulled at peak. 0.80 → exposure × 0.20. */
export const DIP_DEPTH = 0.80;
/**
 * Extra bloom while the flash burns.
 *
 * Small. At 2.2 the bloom chain took the bolt's HDR core, spread it over six
 * mip levels and washed the entire frame — the seam disappeared inside its own
 * glow. The bolt is already far over the bloom threshold on its own; this only
 * needs to lift the halo a little.
 */
export const BLOOM_BOOST = 0.7;
/** Re-jitters per second while the seam burns. */
const RESTRIKE_HZ = 10;

// ---------------------------------------------------------------------------
// The one live bolt
// ---------------------------------------------------------------------------

/**
 * A fired bolt. There is exactly one at a time, because there is exactly one
 * quiver and one player holding it; a pool would be five hundred bytes of
 * ceremony around a field that is never contended. `bolt-fx.ts` reads this and
 * so does the post-process dip, which is why it lives at module scope rather
 * than being threaded through main.ts as a fourth argument to something.
 */
export interface TintreachBolt {
  /** simTime the bolt struck. */
  firedS: number;
  /** Bow end, world space — the archer's chest. */
  from: [number, number, number];
  /** Impact, world space — exactly the point the reticle marked. */
  to: [number, number, number];
  /** Straight-line length, metres. */
  len: number;
  /** Monotonic shot index. The seed for every jitter in the bolt. */
  shot: number;
  /** True when the shot resolved onto a creature/NPC rather than dirt. */
  onTarget: boolean;
}

let live: TintreachBolt | null = null;
let shotCount = 0;

/** The bolt currently burning, or null. Read-only for callers. */
export function currentBolt(): TintreachBolt | null { return live; }

/** Total bolts loosed this save. Persisted — it is the animation seed. */
export function tintreachShots(): number { return shotCount; }

/** True while a bolt is on screen. Cheap enough for a per-frame guard. */
export function tintreachActive(nowS: number): boolean {
  return live !== null && nowS - live.firedS < LIFE_S;
}

/** Wipe the live bolt and the counter — new game, or a slot load. */
export function resetTintreach(shots = 0): void {
  live = null;
  shotCount = shots;
}

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------

/** Everything `spawnProjectile` needs, so the caller passes it straight on. */
export interface TintreachSpawn {
  kind: 'arrow';
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  damage: number;
  nowS: number;
  /**
   * The BOW, not the impact point.
   *
   * The spawn sits on the mark, so asking 'is there a wall between this
   * projectile and that enemy' from its own position answers about the last
   * few centimetres of a shot rather than about the shot. Underground that let
   * a bolt aimed at a wall face take 18 hp off a boss standing behind it.
   */
  ox: number; oz: number;
}

export interface TintreachShotInput {
  /** `bowMuzzle()` — the archer's chest, or the saddle when riding. */
  muzzle: readonly [number, number, number];
  /** `resolveAimTarget().point` — the point the reticle is marking. */
  aimPoint: readonly [number, number, number];
  /** True when the aim resolved onto a creature (AimTarget.isTarget). */
  onTarget: boolean;
  /** The damage the ordinary arrow would have done at this draw. */
  damage: number;
  /** simTime. */
  nowS: number;
}

/**
 * How far out of the archer's chest the VISIBLE seam starts, metres.
 *
 * The physics origin is `bowMuzzle()` — the middle of the chest — and the first
 * capture down the camera axis showed exactly what that costs: the player is
 * six metres in front of the camera, the bolt recedes from there, and the
 * player's own torso occluded the entire near half of it. Shooting at what you
 * are looking at is the NORMAL case and the bolt was invisible in it.
 *
 * So the seam starts at the bow instead: pushed sideways onto the bow hand and
 * forward past the chest. This changes nothing that can be wrong — the far end
 * is still exactly the reticle point, and the projectile that does the damage
 * never used this at all — and "a bolt of lightning flashing from the bow" is
 * what was asked for anyway.
 */
const BOW_SIDE = 0.52;
const BOW_AHEAD = 0.40;
const BOW_LIFT = 0.05;

/**
 * Loose the arrow. Records the bolt for the renderer and returns the projectile
 * spawn that makes the hit happen.
 *
 * The spawn sits ON the aim point with a velocity of 1 cm/s. Not zero: a
 * stationary projectile leaves `orientToVelocity` nothing to work with and the
 * spent shaft would point along -Z whatever direction it was fired. 1 cm/s
 * moves it 0.17 mm before the hit test runs, which is four orders of magnitude
 * inside the 0.8 m hit radius and therefore not a thing that can go wrong.
 */
export function fireTintreach(input: TintreachShotInput): TintreachSpawn {
  const [mx, my, mz] = input.muzzle;
  const [tx, ty, tz] = input.aimPoint;
  const dx = tx - mx, dy = ty - my, dz = tz - mz;
  const len = Math.hypot(dx, dy, dz) || 1;
  const ux = dx / len, uy = dy / len, uz = dz / len;

  // "Right" of the shot. Degenerate on a straight-up shot, where any axis will
  // do — and where the player's body is not in the way in the first place.
  let rx = uz, rz = -ux;
  const rl = Math.hypot(rx, rz);
  if (rl < 1e-4) { rx = 1; rz = 0; } else { rx /= rl; rz /= rl; }

  shotCount++;
  live = {
    firedS: input.nowS,
    from: [
      mx + rx * BOW_SIDE + ux * BOW_AHEAD,
      my + uy * BOW_AHEAD + BOW_LIFT,
      mz + rz * BOW_SIDE + uz * BOW_AHEAD,
    ],
    to: [tx, ty, tz],
    len,
    shot: shotCount,
    onTarget: input.onTarget,
  };

  return {
    kind: 'arrow',
    x: tx, y: ty, z: tz,
    ox: mx, oz: mz,
    vx: (dx / len) * 0.01, vy: (dy / len) * 0.01, vz: (dz / len) * 0.01,
    // Draw still matters — a fully-drawn bolt hits harder — but never drops
    // below the floor, so even a panicked snap shot beats every other weapon.
    damage: Math.max(TINTREACH_DAMAGE_FLOOR,
      Math.round(input.damage * TINTREACH_DAMAGE_MUL)),
    nowS: input.nowS,
  };
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/** Deterministic 0..1 from two integers. Same mixer the rest of the game uses. */
function hash01(a: number, b: number): number {
  return mix32(a, b, 0x71c7) / 0xffffffff;
}

/**
 * Brightness of the seam, 0..1, at `nowS`.
 *
 * Three acts. The STRIKE is 55 ms of flat maximum — no flicker, because a
 * flickering first frame reads as a rendering fault rather than as lightning.
 * The BURN flickers at 10 Hz between 0.55 and 1.0 while the channel re-strikes.
 * The GHOST is a long soft decay to nothing at LIFE_S: this is the part that
 * answers "let the visual stay long enough so it looks sweet", and it is much
 * longer than real lightning on purpose.
 */
export function boltIntensity(nowS: number): number {
  if (live === null) return 0;
  const u = nowS - live.firedS;
  if (u < 0 || u >= LIFE_S) return 0;
  if (u < STRIKE_S) return 1;
  if (u < BURN_S) {
    const k = hash01(live.shot, Math.floor(u * RESTRIKE_HZ) | 0);
    return 0.55 + 0.45 * k;
  }
  const tail = 1 - (u - BURN_S) / (LIFE_S - BURN_S);
  return 0.62 * Math.pow(Math.max(0, tail), 1.7);
}

/**
 * The blinding envelope, 0..1 — a SMOOTH curve, not `boltIntensity`.
 *
 * Deliberately decoupled from the seam's flicker. Driving exposure from the
 * flickering value makes the whole frame strobe at 10 Hz, which is unpleasant
 * to look at and is also the kind of thing that ends up in an accessibility bug
 * report. The eye's response is slow; this models that instead.
 */
export function dipEnvelope(nowS: number): number {
  if (live === null) return 0;
  const u = nowS - live.firedS;
  if (u < 0) return 0;
  if (u < STRIKE_S) return 1;
  const k = 1 - (u - STRIKE_S) / DIP_RECOVER_S;
  return k <= 0 ? 0 : Math.pow(k, 1.35);
}

/**
 * Which re-strike the seam is on. The path is re-jittered every time this
 * changes, and FROZEN once the burn ends so the ghost is a still image of the
 * last strike rather than a corpse that keeps twitching.
 */
export function strikePhase(nowS: number): number {
  if (live === null) return 0;
  const u = Math.max(0, nowS - live.firedS);
  return Math.floor(Math.min(u, BURN_S) * RESTRIKE_HZ) | 0;
}

/**
 * Fold the flash into the post-process settings. ONE call site in the frame
 * loop, and it owns the whole policy: dip the exposure so the bolt reads as
 * blinding, and lift the bloom so the seam floods instead of drawing a line.
 *
 * Dipping EXPOSURE rather than compositing a black overlay is the whole trick.
 * Exposure is applied before ACES (`acesFilm(hdr * exposure)`), so the scene at
 * ~1.0 goes to 0.32 and visibly darkens while the bolt's core at ~48 goes to
 * ~15 and is still hard clipped to white. That is exactly what a real camera
 * does when something 50 stops brighter walks into frame, and it is why the
 * bolt has to be authored at absurd HDR values rather than at 1.0.
 */
export function applyTintreachPost(
  post: { exposure: number; bloomIntensity: number },
  nowS: number,
): void {
  const d = dipEnvelope(nowS);
  if (d <= 0) return;
  post.exposure *= 1 - DIP_DEPTH * d;
  post.bloomIntensity *= 1 + BLOOM_BOOST * d;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Vertices in the main channel. Must be 2^k + 1 for midpoint displacement. */
export const BOLT_POINTS = 33;
/** Vertices in a fork. */
export const BRANCH_POINTS = 9;
/** Forks per bolt. */
export const BRANCH_COUNT = 4;

/** Signed jitter in [-1, 1], pure in (seed, index, level). */
function jitter(seed: number, i: number, level: number): number {
  return (mix32(seed, i, level) / 0xffffffff) * 2 - 1;
}

/**
 * Write a lightning polyline from `from` to `to` into `out` as xyz triples.
 *
 * Recursive midpoint displacement — the classic, and still the only method that
 * produces the right mix of one long kink and a hundred small ones. Endpoints
 * are written exactly and never displaced, which is what keeps the bolt honest:
 * it starts at the bow and it ends at the point the reticle marked, whatever
 * the middle does.
 *
 * `out` must hold `n * 3` floats and `n` must be 2^k + 1. Written by index,
 * never pushed — a `number[].push()` loop here is the single most expensive
 * pattern in this codebase.
 */
export function boltPath(
  out: Float32Array,
  n: number,
  seed: number,
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  spreadFrac: number,
): void {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  const fx = dx / len, fy = dy / len, fz = dz / len;

  // Two axes across the bolt. The reference vector swaps when the shot is
  // near-vertical, or the cross product collapses and the bolt goes flat.
  let ux = 0, uy = 1, uz = 0;
  if (Math.abs(fy) > 0.9) { ux = 1; uy = 0; }
  let ax = fy * uz - fz * uy, ay = fz * ux - fx * uz, az = fx * uy - fy * ux;
  const al = Math.hypot(ax, ay, az) || 1;
  ax /= al; ay /= al; az /= al;
  const bx = fy * az - fz * ay, by = fz * ax - fx * az, bz = fx * ay - fy * ax;

  out[0] = from[0]; out[1] = from[1]; out[2] = from[2];
  const last = (n - 1) * 3;
  out[last] = to[0]; out[last + 1] = to[1]; out[last + 2] = to[2];

  /**
   * Where vertex `i` sits along the shot, 0..1. NOT uniform.
   *
   * Screen space per metre falls off with distance, so a uniformly subdivided
   * bolt puts nearly all of its kinks where the player cannot see them. A 160 m
   * shot at the sky has 5 m segments; the nearest 20 m is 12% of the length and
   * most of the screen, and it got four kinks — which photographed as a laser
   * beam leaving the bow that only became lightning further out. u^1.45 packs
   * the vertices toward the bow: the first segment is 1 m instead of 5, the
   * last is 7 m at 150 m away where it is a few pixels either way.
   *
   * S(0) = 0 and S(1) = 1 exactly, so the endpoints are untouched.
   */
  const S = (i: number): number => Math.pow(i / (n - 1), 1.45);
  const baseAt = (i: number, k: number): number =>
    from[k] + (to[k] - from[k]) * S(i);

  // Total lateral wander, capped: a 160 m sky shot at this spread would
  // otherwise wander 14 m off the line and stop reading as one bolt.
  const spread = Math.min(len * spreadFrac, 3.6);

  let step = n - 1;
  let level = 0;
  let amp = spread;
  while (step > 1) {
    const half = step >> 1;
    for (let i = half; i < n; i += step) {
      const lo = (i - half) * 3;
      const hi = (i + half) * 3;
      const o = i * 3;
      // Taper only the COARSEST level, so the one big bow in the channel bulges
      // in the middle while the small kinks stay sharp all the way to both
      // ends. Tapering every level (the first version) smoothed the whole thing
      // into an arc: the seam went straight where it was most visible, right in
      // front of the camera, and the bolt read as a beam rather than a bolt.
      // The FLOOR is the important term. A pure `sin` taper drives the coarse
      // displacement to zero at both ends, and the bow end is the part closest
      // to the camera and therefore the part with the most screen space — so
      // the bolt left the hand as a dead-straight bright line for its first
      // fifteen metres and read as a laser. 0.38 keeps it kinking out of the
      // bow while the middle still carries the big bow of the channel. The
      // endpoints themselves are written directly and never displaced, so this
      // cannot move where the bolt starts or where it lands.
      const f = S(i);
      const taper = level === 0
        ? 0.38 + 0.62 * Math.pow(Math.sin(f * Math.PI), 0.5) : 1;
      const ja = jitter(seed, i, level) * amp * taper;
      const jb = jitter(seed, i, level + 64) * amp * taper;
      // Displace about the WARPED base point, inheriting the neighbours'
      // displacement rather than their absolute positions. Averaging the
      // positions directly (the textbook form) would drag every vertex back
      // onto the uniform parameterisation and undo the warp above.
      for (let k = 0; k < 3; k++) {
        const inherit = ((out[lo + k] - baseAt(i - half, k))
          + (out[hi + k] - baseAt(i + half, k))) * 0.5;
        out[o + k] = baseAt(i, k) + inherit;
      }
      out[o] += ax * ja + bx * jb;
      out[o + 1] += ay * ja + by * jb;
      out[o + 2] += az * ja + bz * jb;
    }
    step = half;
    level++;
    // 0.68, not the textbook 0.5. The coarse level is the bolt's overall bow
    // and the fine levels are the KINKS, and the kinks are what make it read as
    // lightning rather than as a laser. At 0.5 the finest displacement over a
    // 44 m shot is 22 cm — three pixels at that range, i.e. invisible — and the
    // seam photographed as a gently waving line.
    amp *= 0.68;
  }
}

/** Where a fork leaves the channel and where it ends. */
export interface BoltBranch {
  /** Index into the main channel this fork grows out of. */
  root: number;
  fromX: number; fromY: number; fromZ: number;
  toX: number; toY: number; toZ: number;
}

/**
 * Pick this bolt's forks. Deterministic in (seed, path).
 *
 * Forks are what stop a bolt reading as a drawn line. They leave the channel at
 * a kink, run 12-30% of the remaining distance at a shallow angle, and die in
 * the air — a fork that reached the target would read as a second shot.
 */
export function boltBranches(
  out: BoltBranch[],
  path: Float32Array,
  n: number,
  seed: number,
): number {
  let count = 0;
  for (let b = 0; b < BRANCH_COUNT; b++) {
    // Spread the roots over the middle of the channel: a fork at the bow looks
    // like a misfire and one at the mark looks like a ricochet.
    const span = n - 1;
    const root = Math.max(2, Math.min(n - 3, Math.round(
      span * (0.18 + 0.62 * ((b + hash01(seed, 900 + b)) / BRANCH_COUNT)))));
    const o = root * 3;
    const p = (root + 1) * 3;
    let tx = path[p] - path[o], ty = path[p + 1] - path[o + 1], tz = path[p + 2] - path[o + 2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;

    // Deflect the fork off the channel tangent by a random perpendicular.
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(ty) > 0.9) { ux = 1; uy = 0; }
    let ax = ty * uz - tz * uy, ay = tz * ux - tx * uz, az = tx * uy - ty * ux;
    const al = Math.hypot(ax, ay, az) || 1;
    ax /= al; ay /= al; az /= al;
    const bx = ty * az - tz * ay, by = tz * ax - tx * az, bz = tx * ay - ty * ax;
    const ang = hash01(seed, 910 + b) * Math.PI * 2;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    // 0.55..0.95 rad off the channel — wide enough to read as a fork, narrow
    // enough that it still looks like it came from the same strike.
    const lean = 0.55 + 0.40 * hash01(seed, 920 + b);
    const cl = Math.cos(lean), sl = Math.sin(lean);
    const dx = tx * cl + (ax * ca + bx * sa) * sl;
    const dy = ty * cl + (ay * ca + by * sa) * sl;
    const dz = tz * cl + (az * ca + bz * sa) * sl;

    // Length scales with what is left of the channel, so forks near the mark
    // are short stubs and forks near the bow are long.
    const remain = (n - 1 - root) / (n - 1);
    const total = Math.hypot(
      path[(n - 1) * 3] - path[0],
      path[(n - 1) * 3 + 1] - path[1],
      path[(n - 1) * 3 + 2] - path[2]);
    const blen = Math.max(0.8, total * remain * (0.12 + 0.18 * hash01(seed, 930 + b)));

    const e = out[count];
    e.root = root;
    e.fromX = path[o]; e.fromY = path[o + 1]; e.fromZ = path[o + 2];
    e.toX = path[o] + dx * blen;
    e.toY = path[o + 1] + dy * blen;
    e.toZ = path[o + 2] + dz * blen;
    count++;
  }
  return count;
}

/** Allocate the fork records once; `boltBranches` fills them in place. */
export function makeBranchBuffer(): BoltBranch[] {
  const out: BoltBranch[] = new Array(BRANCH_COUNT);
  for (let i = 0; i < BRANCH_COUNT; i++) {
    out[i] = { root: 0, fromX: 0, fromY: 0, fromZ: 0, toX: 0, toY: 0, toZ: 0 };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------

/** Shaped for `Renderer.setWorldLights` / the array `emitWorldFire` returns. */
export interface BoltLight {
  pos: [number, number, number];
  color: [number, number, number];
  radius: number;
  d2: number;
}

/**
 * The two point lights the bolt casts, or an empty count.
 *
 * Two, not one: a single light at the midpoint leaves the archer's own feet
 * dark during the brightest event in the game, and a single light at the bow
 * leaves the thing that was just struck unlit. One at each end covers both, and
 * `d2` is forced negative so the sort in `emitWorldFire` cannot drop them for a
 * campfire.
 *
 * Colour is cold — a woad-blue white. Warm lightning reads as fire.
 */
export function boltLights(out: BoltLight[], nowS: number): number {
  const b = live;
  if (b === null) return 0;
  const e = boltIntensity(nowS);
  if (e <= 0.02) return 0;
  const k = e * 9.0;
  const near = out[0];
  near.pos[0] = b.from[0]; near.pos[1] = b.from[1] + 0.4; near.pos[2] = b.from[2];
  near.color[0] = 3.1 * k; near.color[1] = 3.9 * k; near.color[2] = 6.2 * k;
  near.radius = 22;
  near.d2 = -3;
  const far = out[1];
  far.pos[0] = b.to[0]; far.pos[1] = b.to[1] + 0.6; far.pos[2] = b.to[2];
  far.color[0] = 3.6 * k; far.color[1] = 4.4 * k; far.color[2] = 6.8 * k;
  far.radius = 26;
  far.d2 = -2;
  return 2;
}

/** Allocate the light records once. */
export function makeLightBuffer(): BoltLight[] {
  return [
    { pos: [0, 0, 0], color: [0, 0, 0], radius: 0, d2: 0 },
    { pos: [0, 0, 0], color: [0, 0, 0], radius: 0, d2: 0 },
  ];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Save the shot counter. It is the animation seed, so persisting it is what
 * makes bolt #7 look the same after a reload as it did before one — and it
 * doubles as the record that this save owns the artifact.
 */
export function saveTintreach(): void {
  try {
    localStorage.setItem(TINTREACH_KEY, JSON.stringify({ shots: shotCount }));
  } catch { /* quota — the counter is cosmetic, never block a shot for it */ }
}

/** Restore the shot counter. Missing or malformed reads as a fresh quiver. */
export function loadTintreach(): void {
  live = null;
  shotCount = 0;
  try {
    const raw = localStorage.getItem(TINTREACH_KEY);
    if (raw === null) return;
    const v = JSON.parse(raw) as { shots?: unknown };
    if (typeof v?.shots === 'number' && Number.isFinite(v.shots) && v.shots >= 0) {
      shotCount = Math.floor(v.shots);
    }
  } catch { /* corrupt — a fresh counter is a correct answer */ }
}
