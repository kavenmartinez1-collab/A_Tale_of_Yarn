/**
 * king-mesh.ts — the Evil King: the final boss, and the rider on the black
 * dragon.
 *
 * WHAT HE IS
 *
 * Black armour with red accents, exactly twice the player's height, on a black
 * dragon. He owns the castle the game opens by escaping from; you first see him
 * circling it, and you fight him last on a tower top.
 *
 * WHY HE IS BUILT ON THE DREAD KING'S RIG AND NOT ON A NEW ONE
 *
 * `humanoid-mesh.ts` already carries a crowned, caped, greatsword-carrying boss
 * with pauldrons and emissive eyes. Building a second one from scratch would
 * have produced a figure that reads as a different *kind of thing* from every
 * other humanoid in the game, and this art direction wants the opposite: the
 * King is a wool doll like the villagers, like the goblins, like the player.
 * The menace is scale, value and silhouette — not a different construction.
 *
 * So this module owns only what is actually his: the proportions in
 * `HUMANOID_PLANS.evil_king`, the kit below, and the mounted-rider API. The
 * skeleton, the two-bone leg IK, the gait, the torso surface solvers and the
 * pose language all come from `solveFrame`, unchanged.
 *
 * ART DIRECTION — read the wool, not the armour
 *
 * He is knitted. The body under the plate is black wool (`MAT.KNIT`), the trim
 * is red felt (`MAT.FELT`), the cape is heavy red cloth, and the plate is
 * `MAT.BLACKSTEEL` over the top — a material added for him, because `MAT.IRON`
 * is a full mirror and a black mirror outdoors is a navy-blue mirror. That layering is the whole point: an all-metal
 * boss in a game of yarn dolls looks like an asset from another project. Up
 * close you should see stitches on his arms and felt on his belt; at fifty
 * metres you should see a black wedge with a red crown and two hot eyes.
 *
 * The one deliberate exception is the eye and the crown finials, which are
 * emissive (`MAT.GEM` / `MAT.EMBER`). Emissive is the only thing that survives
 * a dark throne room, and it is the cheapest menace per vertex on the model.
 */

import { SPECIES_DEFS } from './entity-types';
import { MAT } from '../render/material-table';
import {
  applyVariant, makeBevelPart, makeBoxSpherePart, makeEyeParts, makePart,
  pitch, rollZ,
  ACCENT_COLORS, BASE_COLORS, BELLY_COLORS,
  type AnimalPose, type Color3, type Part,
} from './creature-parts';
import { bonePart, ridgePart, spikePart, type Vec3 } from './draconic-parts';
import { feet, fleshLimbs, solveFrame } from './humanoid-mesh';

// ---------------------------------------------------------------------------
// Public constants — the numbers other systems are allowed to depend on
// ---------------------------------------------------------------------------

/**
 * Shoulder-height scale, i.e. `SPECIES_DEFS.evil_king.size`.
 *
 * Re-exported rather than re-declared so there is exactly one source of truth;
 * every dimension below is a coefficient of it.
 */
export const EVIL_KING_SIZE = SPECIES_DEFS.evil_king.size;

/**
 * Fraction of `size` at which the helm dome closes — his actual head top.
 *
 * Same formula as the Dread King's helm (`headY + headR * 1.14`), kept in a
 * named constant because the "twice the player's height" requirement is
 * asserted against it. The crown rises ABOVE this, exactly as the player's own
 * iron helm rises above `CHARACTER_HEIGHT`; both numbers mean "top of the
 * head, before headgear", so they compare like for like.
 */
export const KING_HELM_TOP_FRAC = 1.17288 + 0.108 * 1.14; // === 1.296

/** Standing height to the top of the head, in metres. Exactly 2 x 1.62. */
export const EVIL_KING_HEIGHT = EVIL_KING_SIZE * KING_HELM_TOP_FRAC;

/** Shoulder height above his own feet, in metres. */
export const EVIL_KING_SHOULDER_Y = EVIL_KING_SIZE * 0.985;

/**
 * Hip-joint height above his own feet, in metres.
 *
 * Public because seating him on a mount is done by the HIPS — see
 * `kingRiderPlacement`. `HUMANOID_PLANS.evil_king.hipY` is the same number as
 * a fraction; this is the metres version so callers do not reach into the
 * plan table.
 */
export const EVIL_KING_HIP_Y = EVIL_KING_SIZE * 0.52;

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
//
// Three of these come from the shared species tables, so recolouring him is a
// data edit like every other creature. The rest are derived, because they are
// relationships rather than choices: the plate is the wool lifted a little so
// the layers separate, the cape lining is the cape darkened, and the hot core
// of the crown is the trim pushed past white-point into HDR.

/**
 * Ashen wool for the face — the one part of him that is not black or red.
 *
 * Raised well clear of the plate after the first previews: at 0.30 against a
 * 0.13 helm it was a value step the eye did not find, and the whole head read
 * as one dark dome with a crown on it. The face has to be the lightest thing
 * on the model or he has no face at all.
 */
const FACE_C: Color3 = [0.44, 0.41, 0.38];
/** Eye colour. Emissive; this is the read at distance. */
const EYE_C: Color3 = [1.00, 0.16, 0.07];
/** Emissive core for the crown finials and the blade's fuller. */
const EMBER_C: Color3 = [1.00, 0.24, 0.08];
/**
 * The mouth stitching — dried-blood red on an ashen face.
 *
 * Not black: against a 0.44 face a black seam reads as a hole, and a hole in
 * the middle of the only pale thing on the model is what the first pass looked
 * like. Red keeps it a thread.
 */
const STITCH_C: Color3 = [0.30, 0.075, 0.075];

const lift = (c: Color3, k: number): Color3 =>
  [Math.min(1, c[0] + k), Math.min(1, c[1] + k), Math.min(1, c[2] + k)];
const dim = (c: Color3, k: number): Color3 => [c[0] * k, c[1] * k, c[2] * k];

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

/**
 * Build the Evil King's parts at this pose.
 *
 * Dispatched from `buildAnimalMesh`, so the caller is normally
 * `EntityRenderer.buildDraws`. `pose.seat` (see `AnimalPose`) puts him astride
 * the dragon; everything else is the standard humanoid pose language.
 */
export function buildEvilKing(pose: AnimalPose, variant: number): Part[] {
  const f = solveFrame('evil_king', pose);
  const { s, plan } = f;

  // Wool, plate, trim, cloth. `applyVariant` is applied to the wool only, the
  // same rule every other species follows — a boss with four colour variants
  // is a boss the director can dress differently per playthrough, and the trim
  // staying fixed is what keeps him recognisable when it does.
  const woolC = applyVariant(BASE_COLORS.evil_king, variant);
  const plateC = lift(woolC, 0.055);
  const trimC = ACCENT_COLORS.evil_king;
  /**
   * The cape, brightened to the King's own accent red.
   *
   * The first sight of him in the whole game is at 150 m, circling the castle
   * on a black dragon whose belly is charcoal and whose wings are already red.
   * `BELLY_COLORS.evil_king` at 0.34 red was darker than the dragon's membrane
   * (0.46) and the rider dissolved into his own mount — the offline mounted
   * preview showed a red wing, a red cape and no visible boundary between them.
   * So the rule is now a value split: **the King's red is the bright one, the
   * dragon's is the deep one.** Scaling the red channel hardest keeps the hue —
   * a uniform lift would have desaturated it toward pink.
   */
  const capeC: Color3 = [
    Math.min(1, BELLY_COLORS.evil_king[0] * 1.76),
    BELLY_COLORS.evil_king[1] * 1.85,
    BELLY_COLORS.evil_king[2] * 1.70,
  ];
  const capeLineC = dim(capeC, 0.42);

  const parts: Part[] = [];
  const chestRX = s * plan.chestW;
  const chestRY = (s * 0.90 - s * plan.hipY) * 0.62;
  const chestRZ = s * plan.chestD;
  const hipY = s * plan.hipY;

  // ----- the chest, and why it is not `f.chestY ± chestRY` -----------------
  //
  // The shared frame puts the chest ellipsoid at `chestY = size` with a
  // half-height of `0.62 * (0.90 - hipY) * size`, which on this plan reaches
  // 1.236 * size — and the head only reaches 1.296 * size. The chest therefore
  // closes over the skull, and the first build of this King came out as a
  // barrel with a crown balanced on it: no neck, no jaw, no face, at any
  // distance. It is not a scaling error, it is what that formula does whenever
  // the head sits close over the shoulders.
  //
  // So the chest is capped at the shoulder line and given its OWN surface
  // solver. The width that pauldrons, gauntlets and the sword grip are placed
  // against comes from `widthAt` below, not `f.torsoWidthAt` — using the
  // frame's solver against a differently-shaped chest is how a pauldron ends
  // up floating 30 cm off a shoulder.
  const chestTop = f.shoulderY + s * 0.045;
  const chestBot = f.chestY - chestRY;
  const chestCy = (chestTop + chestBot) * 0.5;
  const chestRy = (chestTop - chestBot) * 0.5;
  /** Real chest half-width at height y — the ellipse, not the box. */
  const widthAt = (y: number): number => {
    const t = (y - chestCy) / chestRy;
    return chestRX * Math.sqrt(Math.max(0, 1 - Math.min(1, t * t)));
  };
  const shoulderW = widthAt(f.shoulderY);

  // ----- torso: wool under plate -------------------------------------------
  //
  // Three stacked masses, and the middle one is deliberately NOT armoured.
  // A continuous shell from collar to belt reads as a single moulded object;
  // leaving the waist in knit wool puts a seam where a person bends and is the
  // cheapest thing on the model that says "this is made of parts, sewn".
  parts.push(makeBoxSpherePart(plateC, f.spineRots,
    -chestRX, chestBot, -chestRZ,
    chestRX, chestTop, chestRZ, 1, 9, 6, MAT.BLACKSTEEL));
  // Deltoids. They are what actually carries the shoulder width now that the
  // chest stops at the shoulder line, and they bridge the gap between the
  // chest surface and the pauldrons sitting outboard of it.
  for (const arm of f.arms) {
    const dr = s * 0.086;
    const dx = arm.side * (shoulderW + dr * 0.62);
    parts.push(makeBoxSpherePart(woolC, f.spineRots,
      dx - dr, f.shoulderY - dr * 1.10, -chestRZ * 0.86,
      dx + dr, f.shoulderY + dr * 0.86, chestRZ * 0.86, 1, 7, 4, MAT.KNIT));
  }
  parts.push(makeBoxSpherePart(woolC, f.spineRots,
    -chestRX * plan.waistMul, f.waistY - chestRY * 0.60, -chestRZ * 0.84,
    chestRX * plan.waistMul, f.waistY + chestRY * 0.56, chestRZ * 0.84,
    1, 8, 5, MAT.KNIT));
  parts.push(makeBoxSpherePart(plateC, f.spineRots,
    -chestRX * 0.78, hipY - s * 0.06 + f.bob, -chestRZ * 0.88,
    chestRX * 0.78, hipY + s * 0.16 + f.bob, chestRZ * 0.88,
    1, 7, 4, MAT.BLACKSTEEL));

  // Breastplate — a hugging shell, sized off the real ellipsoid surface.
  //
  // A box cut to `chestRX` sticks out at the corners of an ellipsoid torso, so
  // the width comes from `widthAt` at the plate's own height. The plate also
  // stops well below the collar: the Dread King's first breastplate spanned
  // most of its `chestRY` and rendered as a slab across the King's jaw.
  {
    const by = chestCy + chestRy * 0.18;
    const bw = widthAt(by) * 1.04;
    parts.push(makeBoxSpherePart(plateC, f.spineRots,
      -bw, by - chestRy * 0.62, -chestRZ * 1.10,
      bw, by + chestRy * 0.44, chestRZ * 0.10, 1, 8, 5, MAT.BLACKSTEEL));
    // Red felt chevron down the sternum — the loudest accent on the front of
    // him. TWO wedges meeting at a point, not one panel: the first version was
    // a single rectangle and it read as a red postage stamp glued to his
    // chest, which is the difference between a heraldic device and a sticker.
    //
    // Rolled about Z so the two meet at a point over the navel. Un-rolled they
    // are two vertical lozenges either side of the sternum, which does not
    // read as a chevron — it reads as a bib.
    const cw = bw * 0.20;
    const apexY = by - chestRy * 0.80;
    for (const side of [-1, 1] as const) {
      parts.push({
        verts: makeBoxSpherePart(trimC, [],
          -cw, apexY, -chestRZ * 1.15,
          cw, by + chestRy * 0.46, -chestRZ * 0.68,
          1, 6, 4, MAT.FELT).verts,
        color: trimC,
        material: MAT.FELT,
        rots: [rollZ(-side * 0.46, 0, apexY), ...f.spineRots],
      });
    }
  }

  // Gorget — a narrow felt collar at the base of the neck, sitting ON the
  // chest's top surface. Narrow on purpose: the first pass was 0.52 of the
  // chest half-width and it sat under the jaw like a dinner plate, hiding the
  // one part of him that has a face on it.
  {
    const gy = chestTop - s * 0.026;
    const gw = s * 0.098;
    parts.push(makeBoxSpherePart(trimC, f.spineRots,
      -gw, gy - s * 0.028, -gw * 0.94,
      gw, gy + s * 0.048, gw * 0.94, 1, 8, 4, MAT.FELT));
  }
  // Neck. Without one the skull sits directly on the collar and the figure has
  // no articulation between shoulders and crown — which is most of why the
  // first build read as a barrel wearing a hat.
  parts.push(makeBoxSpherePart(woolC, f.headRots,
    -s * 0.060, chestTop - s * 0.030, -s * 0.056,
    s * 0.060, f.headY - s * plan.headR * 0.55, s * 0.056, 1, 7, 3, MAT.KNIT));

  // Belt: felt band, iron buckle.
  {
    const beltY = f.waistY - chestRY * 0.46;
    parts.push(makeBoxSpherePart(trimC, f.spineRots,
      -chestRX * 0.90, beltY - chestRY * 0.13, -chestRZ * 0.94,
      chestRX * 0.90, beltY + chestRY * 0.13, chestRZ * 0.94,
      1, 8, 3, MAT.FELT));
    parts.push(makeBevelPart(plateC, f.spineRots,
      -chestRX * 0.20, beltY - chestRY * 0.20, -chestRZ * 1.00,
      chestRX * 0.20, beltY + chestRY * 0.20, -chestRZ * 0.80,
      s * 0.012, MAT.BLACKSTEEL));
  }

  // Tassets — two plates hanging over the hips. They ride the SPINE, not the
  // legs: they are strapped to the belt and a thigh passes behind them. Long
  // enough to cover the hip-to-thigh junction, which otherwise shows as a gap
  // between two ellipsoids that never quite meet.
  for (const side of [-1, 1] as const) {
    const tx = side * chestRX * 0.60;
    parts.push(makeBevelPart(plateC, f.spineRots,
      tx - chestRX * 0.34, hipY - s * 0.20 + f.bob, -chestRZ * 0.98,
      tx + chestRX * 0.34, hipY + s * 0.07 + f.bob, -chestRZ * 0.34,
      s * 0.018, MAT.BLACKSTEEL));
  }
  // Surcoat: a red felt panel hanging from the belt to mid-shin, down the
  // front. The lower half of him was otherwise entirely black — two dark legs
  // under a dark torso — and a vertical red band there is what turns the
  // bottom of the silhouette into a column and finishes the regal read.
  {
    const topY = f.waistY - chestRY * 0.50;
    parts.push(makeBoxSpherePart(trimC, f.spineRots,
      -chestRX * 0.38, s * 0.20 + f.bob, -chestRZ * 1.02,
      chestRX * 0.38, topY, -chestRZ * 0.52, 1, 8, 5, MAT.FELT));
  }

  // ----- limbs: knit wool, plated over ------------------------------------
  //
  // The limbs themselves are WOOL, and the armour is separate shells on top.
  // Doing it the other way round — one iron capsule per limb — is a third of
  // the parts and looks like a robot; the exposed knit at the elbow and the
  // back of the knee is most of what makes him a doll rather than a suit.
  // `armX` is passed explicitly: `fleshLimbs` defaults to `f.torsoWidthAt`,
  // which describes the frame's chest and not this one, so the arms would hang
  // in the gap outboard of the body. Same reason the gauntlets are six lines
  // here instead of a `hands()` call.
  const limbR = s * plan.limbR;
  const armX = shoulderW + s * 0.052;
  fleshLimbs(parts, f, woolC, MAT.KNIT, 1.40, 0.88, armX);
  feet(parts, f, plateC, MAT.BLACKSTEEL, 1.7);

  for (const arm of f.arms) {
    const hr2 = limbR * 0.90;
    parts.push(makeBoxSpherePart(plateC, arm.foreRots,
      arm.side * armX - hr2, f.wristY - hr2 * 1.5, -hr2 * 0.9,
      arm.side * armX + hr2, f.wristY + hr2 * 0.5, hr2 * 0.9, 1, 6, 4, MAT.BLACKSTEEL));
  }
  for (const leg of f.legs) {
    // Greave: shin only, from just under the knee to the ankle.
    parts.push(bonePart(plateC, leg.shinRots,
      [leg.lx, leg.ankleY + limbR * 0.62, 0],
      [leg.lx, leg.kneeY - limbR * 0.30, 0],
      limbR * 1.06, limbR * 1.18, 5, MAT.BLACKSTEEL));
    // Felt band at the knee — the seam between plate and wool.
    parts.push(makeBoxSpherePart(trimC, leg.shinRots,
      leg.lx - limbR * 1.22, leg.kneeY - limbR * 0.46, -limbR * 1.22,
      leg.lx + limbR * 1.22, leg.kneeY - limbR * 0.02, limbR * 1.22,
      1, 7, 3, MAT.FELT));
  }
  for (const arm of f.arms) {
    const ax = arm.side * armX;
    // Vambrace on the forearm.
    parts.push(bonePart(plateC, arm.foreRots,
      [ax, f.wristY + limbR * 0.36, 0], [ax, f.elbowY - limbR * 0.30, 0],
      limbR * 0.94, limbR * 1.04, 5, MAT.BLACKSTEEL));
  }

  // ----- pauldrons ---------------------------------------------------------
  //
  // The wedge. They sit outboard of a chest that is already 1.5 m across, and
  // they ride `spineRots` because a pauldron is strapped to the cuirass and
  // does not swing with the elbow.
  for (const arm of f.arms) {
    const ax = arm.side * (shoulderW + s * 0.115);
    const pr = s * 0.132;
    // `squashY` 0.86, not 0.70. The flatter first version read as two ledges
    // either side of the head — a shelf, not a shoulder — and squashed the
    // skull between them. A pauldron should be a dome that turns light.
    parts.push(makeBoxSpherePart(plateC, f.spineRots,
      ax - pr, f.shoulderY - pr * 0.82, -pr * 1.02,
      ax + pr, f.shoulderY + pr * 0.96, pr * 1.02, 0.86, 8, 5, MAT.BLACKSTEEL));
    // Felt lip along the pauldron's lower edge.
    //
    // Twice now this has floated. It is an ellipsoid, so its own lower edge is
    // not at the bottom of the box that made it, and a lip placed at that box
    // bottom hangs in mid-air beside the shoulder as a red bar — which is
    // exactly what the previews showed. Solve the pauldron's surface at the
    // lip's height instead, the same discipline the back ridge and the crown
    // spikes already use.
    const pCy = (f.shoulderY - pr * 0.82 + f.shoulderY + pr * 0.96) * 0.5;
    const pRy = pr * ((pr * 1.78) / (2 * pr)) * 0.86;
    const lipY = pCy - pRy * 0.72;
    const lipW = pr * Math.sqrt(Math.max(0.04, 1 - 0.72 * 0.72)) * 1.05;
    parts.push(makeBoxSpherePart(trimC, f.spineRots,
      ax - lipW, lipY - pRy * 0.20, -lipW * 0.96,
      ax + lipW, lipY + pRy * 0.22, lipW * 0.96, 0.72, 8, 3, MAT.FELT));
    // Red felt over the CROWN of the pauldron as well as under its lip.
    //
    // Seen from the ground, a rider on a dragon is mostly the top of his own
    // shoulders, and the top of these was the same black as everything else.
    // Solved on the ellipsoid at 0.62 of its half-height, same discipline as
    // the lip — a cap placed at the box lid floats above the dome. Deliberately
    // NARROWER than the pauldron: the boss test asserts that the widest
    // non-cloth vertex on him is within 0.2 sizes of the shoulder line, and a
    // felt cap that overhung the plate would move that measurement onto itself.
    const capY = pCy + pRy * 0.50;
    const capW = pr * Math.sqrt(Math.max(0.04, 1 - 0.50 * 0.50)) * 0.98;
    parts.push(makeBoxSpherePart(trimC, f.spineRots,
      ax - capW, capY - pRy * 0.16, -capW * 0.94,
      ax + capW, capY + pRy * 0.30, capW * 0.94, 0.70, 8, 3, MAT.FELT));
    // Three spikes fanned outward and back, batched into ONE part: a part
    // costs a matrix compose per creature per rebuild, and this is the most
    // repeated element on him.
    parts.push(ridgePart(plateC, f.spineRots, [0, 1, 2].map((i) => ({
      base: [ax + arm.side * pr * (0.18 + i * 0.16),
        f.shoulderY + pr * (0.62 - i * 0.16), pr * (i * 0.34 - 0.28)] as Vec3,
      dir: [arm.side * (0.62 + i * 0.10), 0.74 - i * 0.14, 0.24 + i * 0.22] as Vec3,
      r: s * (0.028 - i * 0.004), len: s * (0.22 - i * 0.045),
    })), 5, MAT.HORN_DARK));
  }

  // ----- cape --------------------------------------------------------------
  //
  // Longer than the Dread King's — it reaches the ankles, which is what turns
  // the lower half of the silhouette from "two legs" into "a column". Built as
  // a curved shell of double-sided quads: a single-winding sheet is invisible
  // from behind, and behind is where a fleeing player sees him from.
  {
    const topY = f.shoulderY + s * 0.02;
    const hemY = s * 0.055 + f.bob;
    const sway = pose.tailSway ?? 0;
    // Seated, the cape has a dragon's back under it instead of two legs, so it
    // spills sideways rather than hanging. The extra flare is the largest red
    // area on the mounted silhouette and it is free — the same 6x6 sheet, wider
    // at the hem.
    const seat = Math.min(Math.max(pose.seat ?? 0, 0), 1);
    const flare = 0.52 + seat * 0.78;
    const dark: number[] = [];
    const band: number[] = [];
    const ROWS = 6, COLS = 6;
    const st = (t: number, u: number): Vec3 => {
      const half = chestRX * (1.02 + flare * t);
      const wrap = Math.cos(u * Math.PI * 0.5);      // 1 at centre, 0 at edge
      // Standing, the cape falls to the ankles. Seated, there is a dragon under
      // it: the same sheet hanging 2.3 m from his shoulders ends level with the
      // animal's BELLY, i.e. entirely inside it, which is exactly what the
      // offline mounted preview showed — a 3 m cape contributing nothing at all
      // because every triangle of it was buried in the mount. Seated it streams
      // back along the spine instead, as a caparison, and lands where it can
      // actually be seen from the ground.
      const y = (topY + (hemY - topY) * t) * (1 - seat)
        + (topY + (s * 0.30 - topY) * t) * seat;
      // +Z is behind (yaw 0 faces -Z). The edges wrap forward around the
      // shoulders while the centre falls away, so the cape is a shell.
      const zFall = chestRZ * 0.78 * t * t * (1 - seat) + s * 1.15 * t * seat;
      return [
        u * half + sway * s * 0.16 * t * t,
        y,
        chestRZ * (0.36 + 0.64 * wrap) + zFall + sway * s * 0.10 * t * t,
      ];
    };
    const push3 = (verts: number[], a: Vec3, b: Vec3, c: Vec3): void => {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      verts.push(a[0], a[1], a[2], nx, ny, nz,
        b[0], b[1], b[2], nx, ny, nz,
        c[0], c[1], c[2], nx, ny, nz);
    };
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const t0 = r / ROWS, t1 = (r + 1) / ROWS;
        const u0 = -1 + (2 * c) / COLS, u1 = -1 + (2 * (c + 1)) / COLS;
        const p0 = st(t0, u0), p1 = st(t0, u1);
        const p2 = st(t1, u1), p3 = st(t1, u0);
        // The middle two columns go to a second, brighter part. One `Part` can
        // only carry one colour, and a plain red sheet from behind is a red
        // sheet — a dark cape with a broad crimson pale down the spine reads as
        // a HERALDIC device even when it is thirty pixels tall, which is the
        // difference between "the dragon has a lump on it" and "someone is
        // riding that". Costs one extra part, not one extra vertex.
        const v = c === 2 || c === 3 ? band : dark;
        push3(v, p0, p1, p2); push3(v, p0, p2, p3);
        push3(v, p2, p1, p0); push3(v, p3, p2, p0);
      }
    }
    parts.push({ verts: dark, color: capeC, material: MAT.CLOTH, rots: f.spineRots });
    // The pale is BLACK on red, not a lighter red. A lighter red just reads as
    // a crease; black on red is the same two-colour device as the banners on
    // his own castle, and it is the only marking on him that survives being
    // forty pixels tall against a bright sky.
    parts.push({
      verts: band, color: dim(capeC, 0.26), material: MAT.CLOTH, rots: f.spineRots,
    });

    // The high collar.
    //
    // Two stiff panels rising from the shoulder blades and flaring outward
    // behind the head, framing it. This replaced a flat disc "mantle" that
    // spanned 1.7 m at shoulder height and read as a shelf the head was
    // balanced on. The collar does the same job — give the cape a visible
    // attachment — but it adds to the silhouette instead of cutting it, and
    // from any angle it puts two dark verticals either side of the crown.
    for (const side of [-1, 1] as const) {
      const cz = chestRZ * 0.86;
      parts.push({
        verts: makeBevelPart(capeLineC, [],
          side < 0 ? -chestRX * 0.86 : chestRX * 0.10, f.shoulderY - s * 0.02,
          cz - s * 0.020,
          side < 0 ? -chestRX * 0.10 : chestRX * 0.86, f.shoulderY + s * 0.30,
          cz + s * 0.020, s * 0.014, MAT.CLOTH).verts,
        color: capeLineC,
        material: MAT.CLOTH,
        // Rolled outward at the shoulder and raked back, so the panels open
        // like a fan rather than standing as two parallel slabs.
        rots: [
          rollZ(side * 0.34, side * chestRX * 0.30, f.shoulderY),
          pitch(-0.30, f.shoulderY, cz),
          ...f.spineRots,
        ],
      });
    }
  }

  // ----- head --------------------------------------------------------------
  const hr = s * plan.headR;
  // Helm: covers the skull and stops at the brow, so there is a face under it.
  // Its dome closes at `headY + hr * 1.14`; that number is the King's height
  // and `KING_HELM_TOP_FRAC` exists so the test can assert against it.
  parts.push(makeBoxSpherePart(plateC, f.headRots,
    -hr * 1.08, f.headY - hr * 0.12, -hr * 0.98,
    hr * 1.08, f.headY + hr * 1.14, hr * 1.12, 1, 9, 6, MAT.BLACKSTEEL));
  // Face and jaw — ashen KNIT, because under the helm he is still a doll.
  parts.push(makeBoxSpherePart(FACE_C, f.headRots,
    -hr * 0.82, f.headY - hr * 1.00, -hr * 1.02,
    hr * 0.82, f.headY + hr * 0.28, hr * 0.30, 1, 8, 5, MAT.KNIT));
  parts.push(makeBevelPart(FACE_C, f.jawRots,
    -hr * 0.64, f.headY - hr * 1.20, -hr * 0.94,
    hr * 0.64, f.headY - hr * 0.74, hr * 0.20,
    hr * 0.12, MAT.KNIT));
  // Brow. Without it the pale face is a bright oval and the eyes float in the
  // middle of it; a dark bar across the top puts them in a socket, which is
  // most of the difference between "a face" and "an egg with two dots".
  parts.push(makeBoxSpherePart(plateC, f.headRots,
    -hr * 0.86, f.headY + hr * 0.06, -hr * 1.06,
    hr * 0.86, f.headY + hr * 0.36, hr * 0.20, 1, 8, 3, MAT.BLACKSTEEL));
  // Emissive eyes, proud of the face rather than sunk into it.
  parts.push(...makeEyeParts(EYE_C, f.headRots,
    hr * 0.42, f.headY - hr * 0.10, -hr * 0.90, hr * 0.155, MAT.GEM));

  // A stitched mouth. Six boxes, 216 verts, and it is the cheapest thing on the
  // model that says "doll" rather than "helmet with a face painted on".
  //
  // Two bars rolled into a shallow V, not one straight line: a horizontal bar
  // on a round face reads as a slot, and a downturned one reads as a mouth with
  // an opinion. The cross-stitches over it are what make it SEWN — this is a
  // wool figure, and the seam is the point of the whole art direction.
  {
    const my = f.headY - hr * 0.66;
    const mz = -hr * 0.86;
    for (const side of [-1, 1] as const) {
      parts.push({
        verts: makePart(STITCH_C, [],
          side < 0 ? -hr * 0.40 : 0, my - hr * 0.035, mz - hr * 0.10,
          side < 0 ? 0 : hr * 0.40, my + hr * 0.035, mz + hr * 0.10,
          MAT.FELT).verts,
        color: STITCH_C,
        material: MAT.FELT,
        rots: [rollZ(side * 0.30, 0, my), ...f.jawRots],
      });
      for (const k of [0.16, 0.34] as const) {
        const sx2 = side * hr * k * 2.1;
        parts.push(makePart(STITCH_C, f.jawRots,
          sx2 - hr * 0.030, my - hr * 0.115, mz - hr * 0.11,
          sx2 + hr * 0.030, my + hr * 0.115, mz + hr * 0.11, MAT.FELT));
      }
    }
  }

  // Crown: seven spikes on a felt band, tallest at the centre, the three
  // tallest tipped with an emissive core. Seven rather than the Dread King's
  // five because at this scale five reads as a helm crest; seven reads as a
  // crown, and the difference is 60 verts.
  {
    const bandY = f.headY + hr * 0.66;
    parts.push(makeBoxSpherePart(trimC, f.headRots,
      -hr * 1.12, bandY - hr * 0.20, -hr * 1.02,
      hr * 1.12, bandY + hr * 0.20, hr * 1.16, 1, 10, 3, MAT.FELT));

    const spikes: { base: Vec3; dir: Vec3; r: number; len: number }[] = [];
    const tips: { base: Vec3; dir: Vec3; r: number; len: number }[] = [];
    for (let i = -3; i <= 3; i++) {
      const t = Math.abs(i) / 3;
      const ang = i * 0.42;
      // The band is an ellipsoid, so its surface at this angle is NOT at a
      // constant radius — seat the spike on the ellipse, or the outer spikes
      // float off the temples. Same trap as every other thing anchored to a
      // `makeBoxSpherePart`.
      const sx = Math.sin(ang) * hr * 1.02;
      const sz = -Math.cos(ang) * hr * 0.26;
      // Raised from 1.70 to 2.06 of the head radius, which puts the crown tip
      // at 3.71 m against the boss test's ceiling of 2.30 x the player's own
      // height (= 3.754). That band exists because the King's whole identity is
      // "exactly twice the player"; the crown may rise above it, but only so
      // far, and this spends nearly all of what was left. It buys 40 % more
      // crown above the helm, which is the part of him that clears the black
      // dragon's spine and is therefore the only part that reads at 150 m.
      const len = hr * (2.06 - 0.88 * t);
      const dir: Vec3 = [Math.sin(ang) * 0.40, 1, -0.12];
      const r = hr * (0.17 - 0.032 * t);
      spikes.push({ base: [sx, bandY + hr * 0.10, sz], dir, r, len });
      // Every spike is tipped now, not just the middle three. Emissive is the
      // only thing on the model that survives fog, dusk and 150 m of distance,
      // and seven hot points in a fan is a CROWN at any range; three was a
      // cluster that read as one blob.
      tips.push({
        base: [sx + dir[0] * len * 0.74, bandY + hr * 0.10 + len * 0.74,
          sz + dir[2] * len * 0.74],
        dir, r: r * 0.44, len: len * 0.32,
      });
    }
    parts.push(ridgePart(plateC, f.headRots, spikes, 5, MAT.BLACKSTEEL));
    parts.push(ridgePart(EMBER_C, f.headRots, tips, 4, MAT.EMBER));
  }
  // Brow horns sweeping back — the read that says this is not a man in armour.
  // `HORN_DARK`, not `HORN`: at tint 0.35 the baked bone colour won and a black
  // king had two pale tan tusks.
  parts.push(ridgePart(plateC, f.headRots, ([-1, 1] as const).map((side) => ({
    base: [side * hr * 0.94, f.headY + hr * 0.24, -hr * 0.18] as Vec3,
    dir: [side * 0.74, 0.40, 0.78] as Vec3,
    r: hr * 0.23, len: hr * 1.85,
  })), 6, MAT.HORN_DARK));

  // ----- greatsword --------------------------------------------------------
  //
  // 2.6 m of blade at full scale, longer than the player is tall, held in the
  // right hand. It rides `arms[1].foreRots`, so it swings with the elbow and
  // the shoulder and the attack clips move it for free.
  {
    const rArm = f.arms[1];
    const ax = armX;
    const gripY = f.wristY;
    // The grip stops at -0.14 size below the fist, not -0.20, and the pommel
    // with it: at the longer setting the pommel reached y = -0.03 with the arm
    // at rest, i.e. the butt of the sword was through the floor. A 2.6 m blade
    // held point-up puts its counterweight near the knee, and the knee is not
    // that far off the ground on anything.
    parts.push(bonePart(trimC, rArm.foreRots,
      [ax, gripY + s * 0.17, 0], [ax, gripY - s * 0.14, 0],
      s * 0.024, s * 0.026, 4, MAT.FELT));
    parts.push(makeBoxSpherePart(EMBER_C, rArm.foreRots,
      ax - s * 0.042, gripY - s * 0.21, -s * 0.042,
      ax + s * 0.042, gripY - s * 0.12, s * 0.042, 1, 6, 3, MAT.EMBER));
    parts.push(makeBevelPart(plateC, rArm.foreRots,
      ax - s * 0.135, gripY + s * 0.16, -s * 0.026,
      ax + s * 0.135, gripY + s * 0.215, s * 0.026,
      s * 0.011, MAT.BLACKSTEEL));
    parts.push(bonePart(plateC, rArm.foreRots,
      [ax, gripY + s * 0.20, 0], [ax, gripY + s * 1.24, 0],
      s * 0.055, s * 0.015, 4, MAT.BLACKSTEEL));
    // The fuller, lit. A black blade against a black king is a blade nobody
    // can see the arc of; one emissive stripe down it makes the swing legible.
    parts.push(makeBevelPart(EMBER_C, rArm.foreRots,
      ax - s * 0.011, gripY + s * 0.23, -s * 0.006,
      ax + s * 0.011, gripY + s * 1.12, s * 0.006,
      s * 0.004, MAT.EMBER));
  }

  return parts;
}

// ---------------------------------------------------------------------------
// Mounted-rider API — what the boss/castle code calls
// ---------------------------------------------------------------------------

/** A rider's world placement on a mount, ready to hand to the renderer. */
export interface RiderPlacement {
  x: number;
  y: number;
  z: number;
  /** Facing, radians; matches the mount's. */
  yaw: number;
}

/**
 * Place the King in the saddle of a mount at `(mx, my, mz)` facing `myaw`.
 *
 * `my` is the mount's BASE (its feet), which is what `EntityState.y` holds.
 * The returned `y` is what the renderer's object offset wants — i.e. where the
 * King's own origin (the soles of his boots) goes.
 *
 * **He is seated by the hips, not by the feet.** `main.ts:saddleY` puts the
 * player's origin at exactly the mount's `size`, which works for a 1.62 m doll
 * whose legs dangle. Applied to a 3.24 m King on the black dragon it left his
 * hips 1.3 m above the saddle and his boots in the air over the shoulders —
 * visible immediately in `scripts/boss-portraits.mjs`, invisible to any
 * numeric check that only compared two `size` values. So the offset is
 * `seatSurfaceY - EVIL_KING_HIP_Y`, which lands his hips on the pad and his
 * boots against the flank where the stirrups are.
 *
 * `seatSurfaceY` and `seatZ` default to the black dragon's; for any other
 * mount pass its own (`blackDragonLandmarks().saddle` is the pattern).
 * `seatZ` is along the mount's forward axis, negative = forward, matching the
 * -Z facing convention, and is rotated by `myaw` here.
 */
export function kingRiderPlacement(
  mx: number, my: number, mz: number, myaw: number,
  seatSurfaceY: number, seatZ: number,
): RiderPlacement {
  const sn = Math.sin(myaw), cs = Math.cos(myaw);
  return {
    // Rotate the local seat offset (0, ·, seatZ) into world space. The mesh
    // yaw convention is `x' = x cos - z sin`, `z' = x sin + z cos`; with x = 0
    // that collapses to these two terms.
    x: mx - seatZ * sn,
    // A couple of centimetres of sink, so he sits IN the pad rather than
    // tangent to it — two ellipsoids that merely touch show a seam.
    y: my + seatSurfaceY - EVIL_KING_HIP_Y - EVIL_KING_SIZE * 0.012,
    z: mz + seatZ * cs,
    yaw: myaw,
  };
}

/**
 * The pose to build him with while he is riding.
 *
 * Mutates and returns `out` so the caller can keep one pose object per frame
 * rather than allocating; pass a fresh object the first time. `seat: 1` is the
 * whole of it — the frame solver takes the legs off the ground IK and folds
 * them around the mount's ribs, and forces `walkAmp` to zero so he does not
 * stride in mid-air.
 *
 * `flap` should be the mount's own flap phase if you want him to rock with the
 * wingbeat; leave it 0 for a still rider.
 */
export function kingRidingPose(
  out: AnimalPose, yaw: number, flapPhase = 0, flapAmp = 0,
): AnimalPose {
  out.yaw = yaw;
  out.walkPhase = 0;
  out.walkAmp = 0;
  out.seat = 1;
  // A rider is a passenger: the only motion he has of his own is the counter-
  // roll against the mount's beat, routed through the torso-twist channel the
  // humanoid rig repurposes `tailSway` for. It also sways the cape, which is
  // most of what sells "airborne" from the ground.
  out.tailSway = Math.sin(flapPhase) * flapAmp * 0.22;
  out.headPitch = 0;
  out.headYaw = 0;
  out.foreSwing = 0;
  out.jawOpen = 0;
  out.bodyDrop = 0;
  return out;
}
