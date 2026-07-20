/**
 * Blocky RuneScape-style character — pure CPU mesh builder, node-testable.
 * Head/torso/sleeved arms/legs (+ optional hair) as axis-aligned boxes, posed
 * by per-part ROTATION CHAINS (elbow → shoulder → torso lean/twist) plus a
 * whole-body yaw, with per-part colors baked into interleaved pos3+color3
 * vertices (24 B).
 *
 * Rebuilt on the CPU every frame (~400 verts — trivial) into a persistent
 * GPU buffer; drawn by the character pipeline (character.wgsl), which adds
 * the world offset from the object uniform and flat-shades like the rest of
 * the game.
 *
 * Local space: feet at y = 0, facing -Z at yaw 0 (controller convention).
 * Pitch convention: +pitch rotates the below-pivot end FORWARD (-Z) — the
 * legs kick forward with +legPitch; a hanging arm's hand moves forward/up.
 */

import { box } from '../mesh-utils';
import type { HeldKind } from '../items';

export type Color3 = [number, number, number];

// ---------------------------------------------------------------------------
// Armor types
// ---------------------------------------------------------------------------

export type ArmorTier = 'fiber' | 'leather' | 'iron' | 'dragon';

/** Per-slot armor worn by the character. All slots optional. */
export interface ArmorOptions {
  head?: ArmorTier;
  body?: ArmorTier;
  legs?: ArmorTier;
}

/** Tint colors per armor tier (replaces the base part color). */
const ARMOR_TINT: Record<ArmorTier, Color3> = {
  fiber:   [0.72, 0.62, 0.38],
  leather: [0.45, 0.30, 0.16],
  iron:    [0.62, 0.65, 0.70],
  dragon:  [0.14, 0.45, 0.26], // dark emerald dragonscale
};

/** Bone-pale accent for dragonscale horns/spikes. */
const DRAGON_BONE: Color3 = [0.85, 0.80, 0.68];

/** Extra options for buildCharacterMesh (all optional, additive). */
export interface CharacterOptions {
  /** Body shape variant. Default 'male' = identical to the pre-extension build. */
  body?: 'male' | 'female';
  /** Armor pieces to show. Absent = no armor (current geometry unchanged). */
  armor?: ArmorOptions;
}

/** Item shown in the right hand (D-M3); swings with the attack pose. */
export interface HeldItem {
  kind: HeldKind;
  color: Color3;
}

/** NPC accessory slots — purely additive geometry, ignored if absent. */
export interface NpcAccessories {
  /** Skirt/dress overlay (color); replaces pants visually for women. */
  skirt?: Color3;
  /** Wide-brim hat (straw, merchant beret, etc.). */
  hat?: Color3;
  /** Belt stripe across the waist. */
  belt?: Color3;
  /** Front apron panel (farmer look). */
  apron?: Color3;
  /** Boot color (short box at ankle level). */
  boots?: Color3;
}

export interface CharacterCustomization {
  skinTone: Color3;
  shirtColor: Color3;
  pantsColor: Color3;
  /** 0 = bald, 1 = crop, 2 = long, 3 = flowing (wider long + side panels). */
  hairStyle: number;
  hairColor: Color3;
  /** Body shape variant (persisted with customization). Default 'male'. */
  body?: 'male' | 'female';
  /** Optional NPC accessories (skirt, hat, belt, apron, boots). */
  accessories?: NpcAccessories;
}

/** Sensible RuneScape-ish default (B-M3 lets the player change it). */
export const DEFAULT_CUSTOMIZATION: CharacterCustomization = {
  skinTone: [0.85, 0.65, 0.48],
  shirtColor: [0.30, 0.42, 0.58],
  pantsColor: [0.35, 0.28, 0.22],
  hairStyle: 1,
  hairColor: [0.30, 0.20, 0.12],
  body: 'male',
};

export interface Pose {
  /** Facing (radians); 0 = -Z. */
  yaw: number;
  /** Walk-cycle phase (radians, advances with distance walked). */
  walkPhase: number;
  /** 0 = standing, 1 = full stride (smoothed by the caller). */
  walkAmp: number;
  /** 0 = idle, 0→1 = one swing of the right arm (attack/gather). */
  attackT: number;
}

export const IDLE_POSE: Pose = { yaw: 0, walkPhase: 0, walkAmp: 0, attackT: 0 };

/** Total character height (m) — head top, without hair. */
export const CHARACTER_HEIGHT = 1.62;

// Body plan (all in meters; feet at y = 0).
const HIP_Y = 0.78;       // legs 0..HIP_Y, torso above
const TORSO_TOP = 1.32;
const SHOULDER_Y = 1.24;  // arm swing pivot
const ELBOW_Y = 1.02;     // sleeve/forearm split + elbow bend pivot

/**
 * One rotation in a part's chain, applied innermost-joint first.
 * ax 0 = pitch about X through (y=p0, z=p1); ax 1 = twist about Y through
 * (x=p0, z=p1) — twist uses the same handedness as the whole-body yaw.
 */
interface Rot { ax: 0 | 1; a: number; p0: number; p1: number }

const pitch = (a: number, py: number, pz = 0): Rot =>
  ({ ax: 0, a, p0: py, p1: pz });
const twistY = (a: number, px = 0, pz = 0): Rot =>
  ({ ax: 1, a, p0: px, p1: pz });

interface Part {
  verts: number[]; // position-only box soup
  color: Color3;
  rots: Rot[];
}

function part(
  color: Color3, rots: Rot[],
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
): Part {
  const verts: number[] = [];
  box(verts, x0, y0, z0, x1, y1, z1);
  return { verts, color, rots };
}

// --- chop animation keyframes ------------------------------------------------

/** Joint angles the attack drives (radians). */
interface ChopPose {
  /** Extra right-shoulder pitch (+ = hand forward/up; ~π = overhead). */
  shoulder: number;
  /** Elbow bend added to the forearm + held item (+ = hand cocks onward). */
  elbow: number;
  /** Torso pitch about the hips (+ = lean BACK, − = lean into the strike). */
  lean: number;
  /** Torso twist about the spine (+ = right shoulder swings BACK). */
  twist: number;
}

const CHOP_REST: ChopPose = { shoulder: 0, elbow: 0, lean: 0, twist: 0 };
/** Axe cocked overhead-behind, body coiled back-right. */
const CHOP_WINDUP: ChopPose =
  { shoulder: 2.8, elbow: 1.2, lean: 0.10, twist: 0.30 };
/** Impact: arm slammed down-forward, body leaning into the blow. */
const CHOP_STRIKE: ChopPose =
  { shoulder: 0.5, elbow: 0.15, lean: -0.28, twist: -0.25 };

const WINDUP_END = 0.40; // attackT where the windup peaks
const STRIKE_END = 0.62; // attackT of impact; the rest is recovery

const smooth = (u: number): number => u * u * (3 - 2 * u);

function lerpChop(a: ChopPose, b: ChopPose, u: number): ChopPose {
  return {
    shoulder: a.shoulder + (b.shoulder - a.shoulder) * u,
    elbow: a.elbow + (b.elbow - a.elbow) * u,
    lean: a.lean + (b.lean - a.lean) * u,
    twist: a.twist + (b.twist - a.twist) * u,
  };
}

/** Windup (ease-out) → strike (accelerating) → recover (ease). */
function chopAt(t: number): ChopPose {
  if (t <= 0 || t >= 1) return CHOP_REST;
  if (t < WINDUP_END) {
    return lerpChop(CHOP_REST, CHOP_WINDUP, smooth(t / WINDUP_END));
  }
  if (t < STRIKE_END) {
    const s = (t - WINDUP_END) / (STRIKE_END - WINDUP_END);
    return lerpChop(CHOP_WINDUP, CHOP_STRIKE, s * s);
  }
  return lerpChop(CHOP_STRIKE, CHOP_REST,
    smooth((t - STRIKE_END) / (1 - STRIKE_END)));
}

// --- held items --------------------------------------------------------------

const WOOD: Color3 = [0.40, 0.28, 0.16];
const METAL_DIM: Color3 = [0.35, 0.35, 0.38];

/**
 * Boxes for the held item, in body-local space against the right fist's
 * outer face (arm box: x 0.27..0.37, y 0.72..1.30, z ±0.09). All share the
 * forearm's rotation chain so the item swings with walk + attack and bends
 * with the elbow.
 *
 * Collision rule: every box sits at x >= 0.375 — fully OUTBOARD of the arm
 * so nothing interpenetrates the sleeve/forearm — unless it is entirely
 * above the arm (y > 1.30). Heads/blades still poke forward past z -0.09
 * so they read from the behind-the-back camera.
 */
function heldParts(held: HeldItem, rots: Rot[]): Part[] {
  const c = held.color;
  const p = (color: Color3,
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
    part(color, rots, x0, y0, z0, x1, y1, z1);
  switch (held.kind) {
    case 'sword':
      // ORTHOGONAL fist grip (fist center ≈ y 0.78, z 0): the handle runs
      // ACROSS the hand, so the blade points forward (-Z) out of the fist —
      // never inline with the forearm. The forearm chain swings it.
      return [
        p(WOOD, 0.375, 0.75, -0.10, 0.435, 0.81, 0.12),      // grip (through fist)
        p(METAL_DIM, 0.375, 0.68, -0.17, 0.475, 0.88, -0.10),// crossguard
        p(c, 0.38, 0.745, -0.80, 0.43, 0.815, -0.17),        // blade (forward)
        p(METAL_DIM, 0.385, 0.74, 0.12, 0.475, 0.82, 0.18),  // pommel
      ];
    case 'axe':
      // Orthogonal grip like the sword: shaft forward out of the fist,
      // broad blade hanging edge-down at the far end.
      return [
        p(WOOD, 0.375, 0.75, -0.85, 0.435, 0.81, 0.12),      // shaft (forward)
        p(c, 0.375, 0.52, -0.84, 0.495, 0.82, -0.60),        // blade (edge down)
        p(c, 0.385, 0.73, -0.58, 0.485, 0.83, -0.46),        // back poll
      ];
    case 'pickaxe':
      // Orthogonal grip: shaft forward, twin spikes crossing it vertically
      // at the far end.
      return [
        p(WOOD, 0.375, 0.75, -0.85, 0.435, 0.81, 0.12),      // shaft (forward)
        p(c, 0.375, 0.55, -0.80, 0.485, 1.00, -0.68),        // twin spikes
        p(c, 0.385, 0.70, -0.86, 0.475, 0.86, -0.62),        // head wedge
      ];
    case 'bow':
      // Deep D-shape held at mid-grip, bowing forward of the arm.
      return [
        p(c, 0.375, 0.62, -0.06, 0.435, 0.92, 0.02),         // grip riser
        p(c, 0.375, 0.92, -0.18, 0.435, 1.22, -0.06),        // upper limb
        p(c, 0.375, 0.32, -0.18, 0.435, 0.62, -0.06),        // lower limb
        p([0.85, 0.85, 0.80], 0.39, 0.34, -0.20, 0.42, 1.20, -0.18), // string
      ];
    case 'staff':
      // Taller than the character, held against the outside of the palm.
      return [
        p(c, 0.375, 0.06, -0.14, 0.435, 1.78, -0.06),        // shaft
        p([c[0] * 1.3, c[1] * 1.3, c[2] * 1.3],
          0.36, 1.78, -0.17, 0.45, 1.94, -0.03),             // knob (above arm)
      ];
  }
}

// ---------------------------------------------------------------------------
// Female body-plan constants (all derived from the male values above)
// ---------------------------------------------------------------------------

// Female proportions: ~4% shorter overall (y scale 0.96), ~12% narrower
// shoulders/torso, ~6% wider hip stance, marginally slimmer arms.
const F_HIP_Y      = 0.7488;   // HIP_Y    * 0.96
const F_TORSO_TOP  = 1.2672;   // TORSO_TOP* 0.96
const F_SHOULDER_Y = 1.1904;   // SHOULDER_Y*0.96
const F_ELBOW_Y    = 0.9792;   // ELBOW_Y  * 0.96
const F_HEAD_TOP   = 1.5552;   // CHARACTER_HEIGHT * 0.96

// Torso x-extents: ±0.26 → ±0.2288 (12% narrower)
const F_TX = 0.2288;
// Hip x-extents: male legs [-0.22, -0.02] / [0.02, 0.22]
// 6% wider outward: inner ±0.0212≈±0.02*1.06, outer ±0.2332≈±0.22*1.06
const F_LEG_INNER =  0.0212;
const F_LEG_OUTER =  0.2332;
// Arm x-extents follow the narrower torso edge, slightly slimmer arm width
const F_ARM_INNER =  F_TX;          // 0.2288
const F_ARM_OUTER =  0.3488;        // 0.2288 + 0.12  (male 0.12 width kept)
const F_FORE_INNER = 0.2488;        // slightly slimmer forearm
const F_FORE_OUTER = 0.3388;

/** Build the posed, colored triangle soup: interleaved [x,y,z, r,g,b] × N. */
export function buildCharacterMesh(
  custom: CharacterCustomization,
  pose: Pose,
  held: HeldItem | null = null,
  options?: CharacterOptions,
): Float32Array<ArrayBuffer> {
  const isFemale = options?.body === 'female';
  const armor    = options?.armor;

  // ----- body-plan scalars (male = current values, female = scaled) --------
  const hipY      = isFemale ? F_HIP_Y      : HIP_Y;
  const torsoTop  = isFemale ? F_TORSO_TOP  : TORSO_TOP;
  const shoulderY = isFemale ? F_SHOULDER_Y : SHOULDER_Y;
  const elbowY    = isFemale ? F_ELBOW_Y    : ELBOW_Y;
  const headTop   = isFemale ? F_HEAD_TOP   : CHARACTER_HEIGHT;

  // Torso x-half-width (male ±0.26, female ±0.2288)
  const tW  = isFemale ? F_TX        : 0.26;
  // Leg x-extents
  const legI = isFemale ? F_LEG_INNER : 0.02;
  const legO = isFemale ? F_LEG_OUTER : 0.22;
  // Arm extents
  const armI = isFemale ? F_ARM_INNER : 0.26;
  const armO = isFemale ? F_ARM_OUTER : 0.38;
  const forI = isFemale ? F_FORE_INNER : 0.27;
  const forO = isFemale ? F_FORE_OUTER : 0.37;

  // ----- pose / animation ---------------------------------------------------
  const swing = Math.sin(pose.walkPhase) * pose.walkAmp;
  const legPitch = swing * 0.7;
  const armPitch = -swing * 0.5;

  // Keyframed chop: overhead windup → downward strike → recovery, with the
  // torso coiling back then leaning into the blow. All joints return to rest
  // at attackT 0/1 so the idle mesh is bit-identical to the pre-chop output.
  const chop = chopAt(Math.min(Math.max(pose.attackT, 0), 1));

  // Torso chain shared by everything above the hips (not the legs).
  const torsoRots: Rot[] = [pitch(chop.lean, hipY), twistY(chop.twist)];
  const rShoulderPitch = -armPitch + chop.shoulder;
  // Right upper arm: shoulder joint, then ride the torso.
  const rArmRots: Rot[] = [pitch(rShoulderPitch, shoulderY), ...torsoRots];
  // Right forearm + held item: elbow joint first, then the same chain.
  const rForeRots: Rot[] = [pitch(chop.elbow, elbowY), ...rArmRots];
  const lArmRots: Rot[] = [pitch(armPitch, shoulderY), ...torsoRots];

  // sleeveTop: top of the upper-arm box.  For male this must be the literal
  // 1.30 to keep bit-identical output; for female it scales with elbowY.
  const sleeveTop = isFemale ? elbowY + 0.2688 : 1.30;
  // foreBot: bottom of the forearm box.  Male literal 0.72 preserved for hash.
  const foreBot = isFemale ? hipY * (0.72 / 0.78) : 0.72;
  // Eye y-positions. Male literals 1.47 / 1.53 preserved for golden-hash safety.
  const eyeBot = isFemale ? headTop * (1.47 / 1.62) : 1.47;
  const eyeTop = isFemale ? headTop * (1.53 / 1.62) : 1.53;

  const skin  = custom.skinTone;
  const shirt = custom.shirtColor;
  const pants = custom.pantsColor;

  // Armor tints (undefined when that slot has no armor).
  const bodyTint: Color3 | undefined = armor?.body  ? ARMOR_TINT[armor.body]  : undefined;
  const legTint:  Color3 | undefined = armor?.legs  ? ARMOR_TINT[armor.legs]  : undefined;

  // Effective part colors: armor tint overrides base color.
  const torsoColor = bodyTint ?? shirt;
  const legColor   = legTint  ?? pants;

  // ----- male geometry (shoulder arm pivots use male eye-height constants
  //       for the chain pivots so held-item chains stay correct regardless)
  const parts: Part[] = [
    // Legs (pants / leg armor), swinging in opposite phase about the hips.
    part(legColor,   [pitch(legPitch,   hipY)], -legO, 0, -0.11, -legI, hipY, 0.11),
    part(legColor,   [pitch(-legPitch,  hipY)],  legI, 0, -0.11,  legO, hipY, 0.11),
    // Torso (shirt / body armor).
    part(torsoColor, torsoRots, -tW, hipY, -0.13, tW, torsoTop, 0.13),
    // Left arm: sleeve (shirt / body armor) + forearm (skin).
    // sleeveTop and foreBot use literal values on the male path to preserve
    // bit-identical output with the pre-extension builder (golden-hash safe).
    part(torsoColor, lArmRots, -armO, elbowY, -0.09, -armI, sleeveTop, 0.09),
    part(skin,       lArmRots, -forO, foreBot, -0.08, -forI, elbowY, 0.08),
    // Right arm: opposite walk swing + the chop (elbow bends the forearm).
    part(torsoColor, rArmRots,  armI, elbowY, -0.09,  armO, sleeveTop, 0.09),
    part(skin,       rForeRots,  forI, foreBot, -0.08,  forO, elbowY, 0.08),
    // Head (skin) — rides the torso lean/twist.
    part(skin, torsoRots, -0.15, torsoTop, -0.15, 0.15, headTop, 0.15),
    // Eyes — slightly proud of the front face (-Z) so facing reads.
    // Male literals (1.47, 1.53) preserved verbatim for golden-hash safety;
    // female scales by the same head-height ratio.
    part([0.10, 0.10, 0.10], torsoRots,
      -0.09, eyeBot, -0.16, -0.03, eyeTop, -0.14),
    part([0.10, 0.10, 0.10], torsoRots,
       0.03, eyeBot, -0.16,  0.09, eyeTop, -0.14),
  ];

  // Hair: 1 = crop cap, 2 = cap + long back panel (back = +Z at yaw 0).
  // Female gets a taller long-panel as the signature style difference.
  // Male literals (1.60, 1.68, 1.34) preserved verbatim for golden-hash safety.
  if (custom.hairStyle >= 1) {
    const capBot = isFemale ? headTop * (1.60 / 1.62) : 1.60;
    const capTop = isFemale ? headTop * (1.68 / 1.62) : 1.68;
    parts.push(part(custom.hairColor, torsoRots,
      -0.17, capBot, -0.17, 0.17, capTop, 0.17));
  }
  if (custom.hairStyle >= 2) {
    // Female: longer panel extends lower (from torsoTop+small offset upward).
    const panelBot = isFemale ? torsoTop + 0.04 : 1.34;
    const capTop   = isFemale ? headTop * (1.68 / 1.62) : 1.68;
    parts.push(part(custom.hairColor, torsoRots,
      -0.17, panelBot, 0.13, 0.17, capTop, 0.19));
  }
  if (custom.hairStyle >= 3) {
    // "Flowing" hair: two side panels + front bangs that frame the face,
    // giving a wider, more feminine silhouette clearly distinct from the crop.
    const sideBot = isFemale ? shoulderY - 0.06 : torsoTop + 0.04;
    const sideTop = isFemale ? headTop * (1.66 / 1.62) : headTop * (1.66 / 1.62);
    // Left side panel — hangs from the cap down past the shoulders
    parts.push(part(custom.hairColor, torsoRots,
      -0.22, sideBot, -0.08, -0.14, sideTop, 0.12));
    // Right side panel
    parts.push(part(custom.hairColor, torsoRots,
       0.14, sideBot, -0.08,  0.22, sideTop, 0.12));
  }

  // ---- NPC Accessories (purely additive — no change when absent) ----
  const acc = custom.accessories;
  if (acc) {
    // Skirt: a flared trapezoid-like box covering the upper legs, creating
    // a dress silhouette. Wider than the torso to read as a skirt at a glance.
    if (acc.skirt) {
      const skirtTop = hipY + 0.04;
      const skirtBot = hipY * 0.28; // hangs below mid-thigh
      const skirtW = isFemale ? legO + 0.06 : legO + 0.03;
      parts.push(part(acc.skirt, [], -skirtW, skirtBot, -0.16, skirtW, skirtTop, 0.16));
    }
    // Belt: thin stripe across the waist (rides the torso).
    if (acc.belt) {
      const beltBot = hipY;
      const beltTop = hipY + 0.05;
      parts.push(part(acc.belt, torsoRots, -(tW + 0.01), beltBot, -0.14, tW + 0.01, beltTop, 0.14));
    }
    // Apron: front panel hanging from waist (farmer look).
    if (acc.apron) {
      const apronTop = hipY + 0.12;
      const apronBot = hipY * 0.35;
      const apronW = tW * 0.7;
      parts.push(part(acc.apron, [], -apronW, apronBot, -0.145, apronW, apronTop, -0.12));
    }
    // Hat: wide-brim disc + crown on top of the head.
    if (acc.hat) {
      // Brim: flat wide disc at the top of the head
      const brimY = headTop + 0.01;
      parts.push(part(acc.hat, torsoRots,
        -0.24, brimY, -0.24, 0.24, brimY + 0.04, 0.24));
      // Crown: raised center block
      parts.push(part(acc.hat, torsoRots,
        -0.12, brimY + 0.04, -0.12, 0.12, brimY + 0.14, 0.12));
    }
    // Boots: short boxes at the base of each leg.
    if (acc.boots) {
      parts.push(part(acc.boots, [pitch(legPitch, hipY)], -legO, 0, -0.12, -legI, 0.14, 0.12));
      parts.push(part(acc.boots, [pitch(-legPitch, hipY)],  legI, 0, -0.12,  legO, 0.14, 0.12));
    }
  }

  // Helmet: box slightly larger than the head, only when armor.head is set.
  // Adds exactly 36 verts (one box).
  if (armor?.head) {
    const helmTint = ARMOR_TINT[armor.head];
    // Head spans y [torsoTop .. headTop], x/z ±0.15.
    // Helmet is 0.025 larger on all sides.
    parts.push(part(helmTint, torsoRots,
      -0.175, torsoTop - 0.01, -0.175, 0.175, headTop + 0.03, 0.175));
  }

  // Dragonscale extras: bone horns on the helm, shoulder spikes and a dorsal
  // ridge on the chest. Only added for the dragon tier (golden-hash safe).
  if (armor?.head === 'dragon') {
    // Two swept-back horns on the helmet crown (back = +Z at yaw 0).
    parts.push(part(DRAGON_BONE, torsoRots,
      -0.15, headTop + 0.02, 0.00, -0.07, headTop + 0.18, 0.10));
    parts.push(part(DRAGON_BONE, torsoRots,
       0.07, headTop + 0.02, 0.00,  0.15, headTop + 0.18, 0.10));
  }
  if (armor?.body === 'dragon') {
    // Shoulder spikes just outside the torso top corners.
    parts.push(part(DRAGON_BONE, torsoRots,
      -tW - 0.03, torsoTop - 0.03, -0.06, -tW + 0.05, torsoTop + 0.12, 0.06));
    parts.push(part(DRAGON_BONE, torsoRots,
       tW - 0.05, torsoTop - 0.03, -0.06,  tW + 0.03, torsoTop + 0.12, 0.06));
    // Dorsal ridge: three shrinking spikes down the spine (back = +Z).
    parts.push(part(DRAGON_BONE, torsoRots,
      -0.04, torsoTop - 0.10, 0.13, 0.04, torsoTop + 0.02, 0.20));
    parts.push(part(DRAGON_BONE, torsoRots,
      -0.035, torsoTop - 0.24, 0.13, 0.035, torsoTop - 0.14, 0.19));
    parts.push(part(DRAGON_BONE, torsoRots,
      -0.03, torsoTop - 0.37, 0.13, 0.03, torsoTop - 0.28, 0.18));
  }

  // Held item rides the full right-forearm chain (elbow + shoulder + torso).
  if (held !== null) {
    parts.push(...heldParts(held, rForeRots));
  }

  const totalVerts = parts.reduce((n, p) => n + p.verts.length / 3, 0);
  const out = new Float32Array(totalVerts * 6);
  const ys = Math.sin(pose.yaw);
  const yc = Math.cos(pose.yaw);
  let o = 0;
  for (const p of parts) {
    // Precompute active rotations (skip identity so the idle path writes
    // bit-identical floats to the pre-chop builder — golden-hash safe).
    const rs = [];
    for (const r of p.rots) {
      if (r.a !== 0) {
        rs.push({ ax: r.ax, s: Math.sin(r.a), c: Math.cos(r.a),
          p0: r.p0, p1: r.p1 });
      }
    }
    for (let i = 0; i < p.verts.length; i += 3) {
      let x = p.verts[i];
      let y = p.verts[i + 1];
      let z = p.verts[i + 2];
      for (const r of rs) {
        if (r.ax === 0) {
          // Pitch about X through (p0, p1): +pitch kicks the below-pivot
          // end forward (-Z), matching the legs.
          const dy = y - r.p0;
          const dz = z - r.p1;
          y = r.p0 + dy * r.c - dz * r.s;
          z = r.p1 + dy * r.s + dz * r.c;
        } else {
          // Twist about Y through (p0, p1) — whole-body-yaw handedness.
          const dx = x - r.p0;
          const dz = z - r.p1;
          x = r.p0 + dx * r.c - dz * r.s;
          z = r.p1 + dx * r.s + dz * r.c;
        }
      }
      // Whole-body yaw about the origin (matches tree.wgsl's convention).
      out[o++] = x * yc - z * ys;
      out[o++] = y;
      out[o++] = x * ys + z * yc;
      out[o++] = p.color[0];
      out[o++] = p.color[1];
      out[o++] = p.color[2];
    }
  }
  return out;
}

/**
 * Largest vertex count possible.
 * 10 body boxes + 4 hair boxes (cap + back + 2 side) + 7 accessory boxes
 * (skirt + belt + apron + hat brim + hat crown + 2 boots) + 1 helmet box
 * + 7 dragonscale spike boxes + 4 held-item boxes = 33 boxes × 36 = 1188.
 * (Previous values: 864 pre-NPC-accessories.)
 */
export const CHARACTER_MAX_VERTS = 1188;
