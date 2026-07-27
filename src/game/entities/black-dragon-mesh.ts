/**
 * black-dragon-mesh.ts — the Evil King's mount.
 *
 * A black dragon with red accents, half again the size of the wild dragon and
 * saddled. He rides it circling the castle at the opening and fights from it at
 * the end.
 *
 * WHY THIS IS THE DRAGON BUILDER AND NOT A NEW ONE
 *
 * `buildDragon` is already fully species-parameterised: it reads
 * `SPECIES_DEFS[species].size` and three colour tables and expresses every
 * other dimension as a coefficient. A second draconic rig would have meant a
 * second leg IK, a second wing fold, a second neck curve and a second set of
 * the bugs all three of those have already had fixed. What this module owns is
 * what is genuinely different: the palette, the tack, and the boss's crest.
 *
 * Those additions arrive through `DragonStyle.extras`, which is handed the
 * SOLVED body — the real hide surface, the sampled neck and tail, the head
 * chain — because every one of these parts is anchored to a curved surface and
 * `makeBoxSpherePart` inscribes an ellipsoid. A saddle placed on `bodyTop`
 * floats above the spine with daylight under it; that is not a hypothetical,
 * it is the bug this rig's own back ridge was written to avoid.
 *
 * ART DIRECTION
 *
 * Black yarn over a charcoal belly, with red where a dragon is thin: the wing
 * membranes, the dorsal ridge, the throat. Membranes are the largest surface
 * on the animal and the only one light passes through, so making them the red
 * is what gets "black dragon with red accents" to read from the ground while
 * he is a silhouette against the sky. The eye is emissive.
 *
 * TWO HARD CONTRACTS INHERITED FROM `buildDragon` — do not break either:
 *  - `main.ts:saddleY` seats a rider at exactly `size` above the mount's base,
 *    so the spine has to reach ~`size`. `bodyTop` is `0.98 * size`.
 *  - `main.ts:getBreathRay` fires from a hardcoded local
 *    `(forward 1.27 * size, up 1.61 * size)`, so the snout tip is pinned.
 * Both hold automatically as long as this stays a size-scaled `buildDragon`.
 */

import { SPECIES_DEFS } from './entity-types';
import { MAT } from '../render/material-table';
import {
  makeBevelPart, makeBoxSpherePart,
  ACCENT_COLORS, BASE_COLORS,
  type AnimalPose, type Color3, type Part,
} from './creature-parts';
import { bonePart, norm, ridgePart, type Vec3 } from './draconic-parts';
import {
  buildDragon, dragonLandmarks, type DragonFrame, type DragonStyle,
} from './dragon-mesh';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** `SPECIES_DEFS.black_dragon.size`. Every dimension below scales off it. */
export const BLACK_DRAGON_SIZE = SPECIES_DEFS.black_dragon.size;

/**
 * Height of the SEAT SURFACE — the top of the saddle pad — above the mount's
 * base (`EntityState.y`).
 *
 * NOT `size`. `main.ts:saddleY` seats the player at exactly `size` above the
 * base, and on this animal that is 9 cm above the spine and 19 cm above the
 * pad, which is fine for the 1.62 m player doll (whose hips are 0.78 up and
 * whose legs simply dangle) and wrong for a 3.24 m King: it puts his hips
 * 1.3 m clear of the saddle and his boots in mid-air over the shoulders. The
 * offline preview showed him sitting on nothing.
 *
 * So the King is seated by his HIPS, not by his feet — see
 * `kingRiderPlacement`. This constant is the surface those hips sit on, and
 * `scripts/test-boss-mesh.mts` asserts it against the actual felt pad in the
 * built mesh rather than trusting the arithmetic.
 */
export const BLACK_DRAGON_SEAT_Y = BLACK_DRAGON_SIZE * 1.02271;

/** What `main.ts:saddleY` uses for the PLAYER. Kept for that call path only. */
export const BLACK_DRAGON_SADDLE_Y = BLACK_DRAGON_SIZE;

/**
 * Where the saddle sits along the mount's own forward axis (-Z is forward).
 *
 * At the withers, not the middle of the back: a rider over the hips looks like
 * luggage. The pommel and cantle geometry below are built around this z.
 */
export const BLACK_DRAGON_SADDLE_Z = -0.14 * BLACK_DRAGON_SIZE;

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/**
 * Wing membrane — deep red, and the single most important colour on him.
 *
 * The default derives the membrane from the body (0.6x, desaturated), which on
 * a near-black body produces a near-black membrane; the wings then vanish into
 * the body and a 22 m wingspan reads as a lump. Red membranes are also the one
 * surface that is lit from behind when he passes across the sky, which is the
 * shot the opening is built around.
 */
const MEMBRANE_C: Color3 = [0.46, 0.055, 0.060];
/** Hot coal iris. Emissive, so it survives night and a dark throne room. */
const EYE_C: Color3 = [1.00, 0.26, 0.09];
/** Blackened iron for the tack. Slightly above the hide so the strap reads. */
const TACK_C: Color3 = [0.115, 0.110, 0.120];
/** Red felt on the saddle and the browband — the craft, up close. */
const FELT_C: Color3 = [0.52, 0.065, 0.070];

// ---------------------------------------------------------------------------
// The tack and the crest
// ---------------------------------------------------------------------------

/**
 * Everything that makes this a war mount rather than a wild dragon: a saddle
 * on the withers, a chest strap, and a heavier crown of horns.
 *
 * Every anchor here goes through `f.torsoTopAt` or a chain joint. The one
 * place a raw coordinate appears is the throat glow, which is deliberately
 * inside the neck rather than on it.
 */
function blackDragonExtras(f: DragonFrame): Part[] {
  const { s } = f;
  const parts: Part[] = [];

  // ----- saddle ------------------------------------------------------------
  const sz = BLACK_DRAGON_SADDLE_Z;
  const seatY = f.torsoTopAt(0, sz);
  const seatW = s * 0.19;
  // Seat pad: a flattened ellipsoid lying ON the hide. `squashY` 0.42 keeps it
  // a pad rather than a boulder; the y-span starts BELOW the surface so the
  // pad's own curvature meets the back's instead of tangenting it at a point.
  parts.push(makeBoxSpherePart(FELT_C, [],
    -seatW, seatY - s * 0.045, sz - s * 0.24,
    seatW, seatY + s * 0.050, sz + s * 0.26, 0.42, 9, 5, MAT.FELT));
  // Pommel and cantle — the front and back of the seat. Without them a rider
  // reads as balanced on a cushion.
  for (const [dz, h] of [[-0.26, 0.105], [0.28, 0.085]] as const) {
    parts.push(makeBoxSpherePart(TACK_C, [],
      -seatW * 0.62, seatY - s * 0.02, sz + s * dz - s * 0.035,
      seatW * 0.62, seatY + s * h, sz + s * dz + s * 0.035,
      0.80, 7, 4, MAT.BLACKSTEEL));
  }
  // Girth strap over the shoulders, following the hide down both flanks.
  for (const side of [-1, 1] as const) {
    const x0 = side * f.bodyW * 0.30, x1 = side * f.bodyW * 1.02;
    parts.push(bonePart(TACK_C, [],
      [x0, f.torsoTopAt(x0, sz) + s * 0.004, sz],
      [x1, f.hipY + f.bodyH * 0.18, sz],
      s * 0.026, s * 0.030, 4, MAT.LEATHER));
  }
  // Stirrup irons, at the height the seated King's boot actually reaches.
  //
  // The first pass hung them off `hipY + bodyH * 0.10`, which is where a
  // stirrup goes on a horse — and 0.7 m below where this rider's foot is,
  // because he is seated by the hips on a barrel almost as wide as he is
  // tall. Measured off the seat instead: `kingRidingPose` drops his sole
  // roughly 0.24 of his own height below the seat surface.
  for (const side of [-1, 1] as const) {
    const x = side * f.bodyW * 0.98;
    const sy = seatY - s * 0.180;
    parts.push(makeBevelPart(TACK_C, [],
      x - s * 0.032, sy - s * 0.045, sz - s * 0.060,
      x + s * 0.032, sy + s * 0.075, sz + s * 0.060,
      s * 0.011, MAT.BLACKSTEEL));
  }

  // ----- crest -------------------------------------------------------------
  //
  // A heavier crown than the wild dragon's two horn pairs: five swept horns in
  // one batched part, seated on the CRANIUM ELLIPSOID rather than on its
  // bounding box. Seating them on the box put the outer pair a hand's width
  // off the skull on the first attempt — the ellipsoid's surface is inside its
  // box everywhere except the three axis poles.
  {
    const [cx, cy, cz] = f.craniumC;
    const [rx, ry, rz] = f.craniumR;
    void cx;
    const horns: { base: Vec3; dir: Vec3; r: number; len: number }[] = [];
    for (let i = -1; i <= 1; i++) {
      const u = i;                           // -1 .. 1 across the skull
      const t = Math.abs(u);
      // Point on the cranium ellipsoid at this lateral fraction, on the rear
      // upper quadrant. The sqrt is the ellipsoid, and it is the whole reason
      // these sit on the bone instead of over it.
      const w = Math.sqrt(Math.max(0, 1 - u * u * 0.72));
      horns.push({
        base: [u * rx * 0.80, cy + ry * 0.58 * w, cz + rz * 0.52 * w],
        // Swept BACK along the neck, not up and out. Five horns fanned
        // outward — the first attempt — landed on top of the two horn pairs
        // and the cheek spikes the wild dragon already has, and the head came
        // out as a red starburst rather than a crowned skull. Three, raked
        // hard aft, read as a crest and leave the existing horns their job.
        dir: norm([u * 0.30, 0.44 - t * 0.10, 0.94]),
        r: s * (0.032 - 0.006 * t),
        len: s * (0.30 - 0.075 * t),
      });
    }
    // `HORN_DARK`, not `HORN`. `MAT.HORN` carries `tint: 0.35` so that a stag's
    // antlers do not take the stag's coat colour, which on a crest authored in
    // oxblood means 65 % of the albedo is baked bone and the boss's crown came
    // out pale tan on a black skull. Same texture and roughness, the accent
    // colour wins. The wild dragon's own horn pairs still use `MAT.HORN`.
    parts.push(ridgePart(ACCENT_COLORS.black_dragon, f.headRots, horns, 5,
      MAT.HORN_DARK));
  }

  // ----- throat glow -------------------------------------------------------
  //
  // One emissive ellipsoid inside the base of the neck. It is not lit fire —
  // that is `fire-fx` — it is the coal that says the fire is coming, and it is
  // 90 verts. Placed at neck joint 1 so it sits where the throat swells, and
  // it inherits no rotation chain because the neck's own bones do not either.
  {
    const j = f.neck.pts[1];
    const r = f.neck.radii[1] * 0.66;
    parts.push(makeBoxSpherePart(EYE_C, [],
      j[0] - r, j[1] - r * 0.9, j[2] - r * 1.3,
      j[0] + r, j[1] + r * 0.9, j[2] + r * 1.3, 1, 6, 3, MAT.EMBER));
  }

  return parts;
}

/** The full style: palette overrides plus the tack. */
export const BLACK_DRAGON_STYLE: DragonStyle = {
  membrane: MEMBRANE_C,
  eye: EYE_C,
  eyeMaterial: MAT.EMBER,
  extras: blackDragonExtras,
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build the black dragon's parts at this pose.
 *
 * Same pose language as every other creature (`AnimalPose`). Wing spread is
 * derived from `flapAmp` inside `buildDragon`: below 0.36 the wings are
 * furled, at 0.94 they are fully out, so a circling flight wants
 * `flapAmp >= 0.9` and a landed boss wants ~0.3.
 *
 * `variant` IS ACCEPTED BUT DELIBERATELY NOT FORWARDED TO THE HIDE COLOUR.
 *
 * Investigated after a report that this animal "reads olive-brown in warm
 * sun": it does, but not because of the sun, the mesh's albedo, or the post
 * pipeline. `scripts/_probe-dragon-color.mjs` shot it at colorVariant 0 and at
 * whatever the caller happened to pass, under matched warm-dawn, neutral-noon
 * and night lighting. Variant 0 reads black in every condition; every "warm"
 * `VARIANT_SHIFTS` entry reads brown in BOTH daylit conditions, not just the
 * warm one (night is inconclusive — there is not enough light on the hide
 * either way to tell). So the base colour and the pipeline are both fine.
 *
 * The actual defect is upstream: the King's mount is spawned in `main.ts` via
 * `EntityManager.spawnEntity()`, which is documented there as a debug/test
 * path that "cannot be used for anything that has to be reproducible" and
 * derives `colorVariant` from a hash of the spawn POSITION rather than from
 * an authored choice. At the game's fixed `dragonPerch` that hash happens to
 * land on variant 3 — `VARIANT_SHIFTS[3] = [+0.07, +0.02, -0.05]`, which turns
 * the near-black base `[0.085, 0.080, 0.092]` into `[0.155, 0.100, 0.042]`:
 * red is nearly 4x blue, and "black dragon" ships as a warm brown one.
 *
 * `main.ts` is owned by another workstream, so the spawn call is not this
 * file's to change, and every debug harness that spawns this species the same
 * way (`spawnEntity`, not `placeEntity`) hits the identical hash-derived
 * variant regardless of where it stands in the loop below. This is the ONE
 * animal in the game that must not vary: a unique, scripted boss, not
 * scattered wildlife with coat variety to show off. Pinning it here, at the
 * one place every caller funnels through, fixes the shipped boss and every
 * present and future harness in one line, instead of chasing each caller.
 */
export function buildBlackDragon(pose: AnimalPose, variant: number): Part[] {
  void variant; // see above — always the authored base, never a coat variant
  return buildDragon('black_dragon', pose, 0, BLACK_DRAGON_STYLE);
}

/**
 * Anchor points the castle/boss code can use without re-deriving proportions.
 *
 * `saddle` is in MOUNT-LOCAL space before yaw: x is lateral, y is above the
 * mount's base, z is along its facing with -Z forward. To place the King, use
 * `kingRiderPlacement` in `king-mesh.ts`, which applies the yaw for you.
 */
export function blackDragonLandmarks(): {
  hipY: number; bodyTop: number; snoutTip: Vec3;
  saddle: Vec3; wingspan: number; standingHeight: number;
} {
  const lm = dragonLandmarks('black_dragon');
  const s = BLACK_DRAGON_SIZE;
  return {
    hipY: lm.hipY,
    bodyTop: lm.bodyTop,
    snoutTip: lm.snoutTip,
    saddle: [0, BLACK_DRAGON_SEAT_Y, BLACK_DRAGON_SADDLE_Z],
    // Measured off the built mesh in `scripts/test-boss-mesh.mts`, which
    // asserts these against the real AABB rather than trusting the arithmetic.
    wingspan: s * 4.424,
    standingHeight: s * 1.914,
  };
}

/** Base colour, exported so UI/effects can tint to match without guessing. */
export const BLACK_DRAGON_BASE = BASE_COLORS.black_dragon;
