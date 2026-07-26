/**
 * Stylized RuneScape-ish character — pure CPU mesh builder, node-testable.
 * Head (squashed sphere) / beveled torso / capsule arms+legs (+ optional
 * hair) posed by per-part ROTATION CHAINS (elbow → shoulder → torso
 * lean/twist) plus a whole-body yaw, with per-part colors AND a per-part
 * material ID baked into interleaved pos3+normal3+color3+materialId
 * vertices (40 B stride).
 *
 * Geometry comes from the shared mesh-utils primitives (box, bevelBox,
 * sphere, capsule, cylinder), which already bake correct LOCAL-space
 * normals into their output. Posing then rotates those normals through the
 * exact same rotation chain as the position — translation/pivot offset
 * omitted, since normals are directions, not points — so lit limbs shade
 * correctly at every pose angle instead of using their bind-pose normal.
 * All chain rotations here are rigid (no scale), so rotating the normal by
 * the same rotation matrix as the position is exact; the result is
 * re-normalized at the very end purely to guard against float drift.
 *
 * Rebuilt on the CPU every frame into a persistent GPU buffer; drawn by the
 * character pipeline (character.wgsl), which adds the world offset from the
 * object uniform and shades with the real per-vertex normal.
 *
 * Local space: feet at y = 0, facing -Z at yaw 0 (controller convention).
 * Pitch convention: +pitch rotates the below-pivot end FORWARD (-Z) — the
 * legs kick forward with +legPitch; a hanging arm's hand moves forward/up.
 */

import { box, bevelBox, sphere, capsule, taperedCapsule, cylinder } from '../mesh-utils';
import type { HeldKind } from '../items';
import { MAT } from '../render/material-table';

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

/**
 * Material per armor tier (replaces the base KNIT material). Fiber reads as
 * padded/quilted cloth armor (no dedicated "fiber" material exists); leather
 * and iron map directly to their namesake materials; dragon — the top tier —
 * is gilded rather than reptilian, so both its plates and its bone trim
 * (DRAGON_BONE below) render as GOLD rather than introducing SCALE into the
 * character rig.
 */
const ARMOR_MATERIAL: Record<ArmorTier, number> = {
  fiber:   MAT.CLOTH,
  leather: MAT.LEATHER,
  iron:    MAT.IRON,
  dragon:  MAT.GOLD,
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
  /**
   * Bow draw, 0 = bow down, 1 = string at full draw.
   *
   * This is a SEPARATE channel from attackT because the two animations are
   * unrelated: attackT is a one-shot 0→1 chop the caller cannot hold, and a
   * draw has to be held for as long as the player holds the button. Firing a
   * bow used to play the axe chop, which is why a shot had no visible cause.
   * When aim > 0 it overrides the chop entirely (you cannot swing an axe and
   * draw a bow with the same arm) and adds a nocked arrow to the geometry.
   */
  aim?: number;
  /**
   * Astride a mount, 0 = standing, 1 = seated.
   *
   * Riders used to be the standing mesh teleported onto the animal's back,
   * legs together, feet in mid-air. `seat` swings both thighs forward together
   * (rather than in opposite phase, which is a walk) and settles the torso, so
   * the doll reads as sitting on something.
   */
  seat?: number;
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
  verts: number[]; // interleaved position+normal soup (6 floats/vertex) —
                    // local (unposed) space, straight from mesh-utils.
  color: Color3;
  /** MAT.* constant (material-table.ts) — constant across the part, written
   * to every vertex it emits. */
  material: number;
  rots: Rot[];
}

// ---------------------------------------------------------------------------
// Part builders — one per underlying primitive. All wrap a mesh-utils
// function that already emits position+normal pairs; posing (below) rotates
// both together.
// ---------------------------------------------------------------------------

/** Plain box — cheap, used for small/flat accents (eyes, stripes, spikes).
 * `material` defaults to KNIT — the doll's body/clothing is knit wool by
 * default; call sites that need something else (leather, iron, gold, ...)
 * pass it explicitly. */
function part(
  color: Color3, rots: Rot[],
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  material: number = MAT.KNIT,
): Part {
  const verts: number[] = [];
  box(verts, x0, y0, z0, x1, y1, z1);
  return { verts, color, material, rots };
}

/** Beveled box — softened block for prominent pieces (torso, hair, held-item
 * blades/heads). Degrades gracefully to a plain box for thin geometry. */
function bpart(
  color: Color3, rots: Rot[],
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  bevel = 0.03, material: number = MAT.KNIT,
): Part {
  const verts: number[] = [];
  bevelBox(verts, x0, y0, z0, x1, y1, z1, bevel);
  return { verts, color, material, rots };
}

/** Sphere part — heads and the rounded helmet. */
function spherePart(
  color: Color3, rots: Rot[],
  cx: number, cy: number, cz: number, r: number,
  scaleY = 1, scaleZ = 1, segments = 8, rings = 6, material: number = MAT.KNIT,
): Part {
  const verts: number[] = [];
  sphere(verts, cx, cy, cz, r, segments, rings, scaleY, scaleZ);
  return { verts, color, material, rots };
}

/** Capsule between two explicit local-space points (any axis) — the base
 * primitive for limbs and orthogonal held-item hafts. */
function capsulePart(
  color: Color3, rots: Rot[],
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  r: number, segments = 6, material: number = MAT.KNIT,
): Part {
  const verts: number[] = [];
  capsule(verts, x0, y0, z0, x1, y1, z1, r, segments);
  return { verts, color, material, rots };
}

/** Vertical capsule spanning a limb's y-range, centered on the box's x/z
 * midpoint — drop-in replacement for a vertical limb box (arms/legs). */
function limbPart(
  color: Color3, rots: Rot[],
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  r: number, segments = 6, material: number = MAT.KNIT,
): Part {
  const cx = (x0 + x1) * 0.5, cz = (z0 + z1) * 0.5;
  // The caller passes the AABB the old box occupied, so the capsule must fill
  // exactly that box — inset the axis endpoints by the radius, because the
  // hemispherical caps then extend back out to y0 and y1. Without this a leg
  // anchored at y = 0 hangs its cap a full radius below the feet and the
  // character sinks into the ground.
  const half = (y1 - y0) * 0.5;
  const inset = Math.min(r, half);
  const a = y0 + inset;
  const b = Math.max(y1 - inset, a);
  return capsulePart(color, rots, cx, a, cz, cx, b, cz, r, segments, material);
}

/** Thin cylinder along +Y — vertical held-item hafts (bow grip, staff shaft). */
function cylinderPartY(
  color: Color3, rots: Rot[],
  cx: number, cy: number, cz: number, r: number, height: number, segments = 6,
  material: number = MAT.KNIT,
): Part {
  const verts: number[] = [];
  cylinder(verts, cx, cy, cz, r, r, height, segments);
  return { verts, color, material, rots };
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
  /** LEFT shoulder pitch. Only the bow draw uses it; the chop leaves it 0. */
  offShoulder: number;
  /** LEFT elbow bend — the string hand folding back to the cheek. */
  offElbow: number;
}

const CHOP_REST: ChopPose =
  { shoulder: 0, elbow: 0, lean: 0, twist: 0, offShoulder: 0, offElbow: 0 };
/** Axe cocked overhead-behind, body coiled back-right. */
const CHOP_WINDUP: ChopPose =
  { shoulder: 2.8, elbow: 1.2, lean: 0.10, twist: 0.30, offShoulder: 0, offElbow: 0 };
/** Impact: arm slammed down-forward, body leaning into the blow. */
const CHOP_STRIKE: ChopPose =
  { shoulder: 0.5, elbow: 0.15, lean: -0.28, twist: -0.25, offShoulder: 0, offElbow: 0 };

/**
 * Full draw.
 *
 * The bow lives in the RIGHT fist in this rig (see heldParts), so the right
 * arm is the BOW arm and pushes forward almost straight — shoulder ~π/2 puts
 * the hand out level with the chest — while the LEFT arm is the STRING hand,
 * raised to the same height and folded hard at the elbow to bring the fingers
 * back past the jaw. The torso twists so the right shoulder leads (negative
 * twist, since + swings the right shoulder BACK) and leans a touch away from
 * the target, which is what an archer actually does to get the draw length.
 */
const BOW_DRAW: ChopPose =
  { shoulder: 1.52, elbow: -0.12, lean: 0.06, twist: -0.30,
    offShoulder: 1.30, offElbow: -1.75 };

const WINDUP_END = 0.40; // attackT where the windup peaks
const STRIKE_END = 0.62; // attackT of impact; the rest is recovery

const smooth = (u: number): number => u * u * (3 - 2 * u);

function lerpChop(a: ChopPose, b: ChopPose, u: number): ChopPose {
  return {
    shoulder: a.shoulder + (b.shoulder - a.shoulder) * u,
    elbow: a.elbow + (b.elbow - a.elbow) * u,
    lean: a.lean + (b.lean - a.lean) * u,
    twist: a.twist + (b.twist - a.twist) * u,
    offShoulder: a.offShoulder + (b.offShoulder - a.offShoulder) * u,
    offElbow: a.offElbow + (b.offElbow - a.offElbow) * u,
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

/** Rest → full draw, eased so the last few percent of pull reads as effort. */
function drawAt(a: number): ChopPose {
  if (a <= 0) return CHOP_REST;
  return lerpChop(CHOP_REST, BOW_DRAW, smooth(Math.min(1, a)));
}

// --- riding seat -------------------------------------------------------------

/**
 * Thigh pitch at a full seat (radians). +pitch swings the below-hip end
 * FORWARD, so ~1.15 rad puts the thighs a little above horizontal — astride a
 * barrel-shaped animal the legs straddle rather than dangle straight down.
 * The rig has no knee, so this is the whole of the seat in the legs.
 */
const SEAT_THIGH_PITCH = 1.15;
/** Forward torso settle at a full seat (radians). */
const SEAT_TORSO_LEAN = 0.14;

/** Nocked-arrow shaft/head colours (wood + iron point). */
const NOCK_SHAFT: Color3 = [0.55, 0.40, 0.24];
const NOCK_HEAD: Color3 = [0.55, 0.57, 0.62];

/**
 * The arrow on the string, in the same body-local space as heldParts and on
 * the same right-forearm chain, so it travels with the bow.
 *
 * The bow's grip riser sits at x ≈ 0.405, z ≈ -0.02, centred on y 0.77 (see
 * heldParts' 'bow' case). The shaft lies along -Z through that point: at full
 * draw the nock is pulled back to z +0.30 and the head sits just forward of
 * the riser; at rest the whole thing slides forward so nothing pokes through
 * the archer's chest.
 */
function nockedArrowParts(aim: number, rots: Rot[]): Part[] {
  const gx = 0.405;
  const gy = 0.77;
  // Nock end travels back as the string is pulled; the head stays put.
  const back = -0.06 + 0.34 * aim;
  const tip = -0.62;
  const r = 0.017;
  return [
    capsulePart(NOCK_SHAFT, rots, gx, gy, tip + 0.10, gx, gy, back, r, 5, MAT.WOOD),
    bpart(NOCK_HEAD, rots,
      gx - 0.028, gy - 0.028, tip, gx + 0.028, gy + 0.028, tip + 0.11, 0.012, MAT.IRON),
    // Two fletches at the nock, crossed, so the tail reads from any angle.
    part(NOCK_HEAD, rots,
      gx - 0.045, gy - 0.006, back - 0.11, gx + 0.045, gy + 0.006, back - 0.01, MAT.LEATHER),
    part(NOCK_HEAD, rots,
      gx - 0.006, gy - 0.045, back - 0.11, gx + 0.006, gy + 0.045, back - 0.01, MAT.LEATHER),
  ];
}

// --- held items --------------------------------------------------------------

const WOOD: Color3 = [0.40, 0.28, 0.16];
const METAL_DIM: Color3 = [0.35, 0.35, 0.38];

/**
 * Parts for the held item, in body-local space against the right fist's
 * outer face (arm box: x 0.27..0.37, y 0.72..1.30, z ±0.09). All share the
 * forearm's rotation chain so the item swings with walk + attack and bends
 * with the elbow. Hafts/handles/shafts/staves are thin capsules or +Y
 * cylinders (mesh-utils' cylinder primitive only runs along +Y, so
 * orthogonal grips/shafts use a capsule instead — visually the same thing,
 * a cylinder with rounded ends); blades and heads are thin beveled boxes.
 *
 * Collision rule: every box sits at x >= 0.375 — fully OUTBOARD of the arm
 * so nothing interpenetrates the sleeve/forearm — unless it is entirely
 * above the arm (y > 1.30). Heads/blades still poke forward past z -0.09
 * so they read from the behind-the-back camera.
 */
function heldParts(held: HeldItem, rots: Rot[]): Part[] {
  const c = held.color;
  // Blade/head/guard/etc: thin beveled box (bevel self-clamps for thin axes).
  const p = (color: Color3,
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
    material: number) =>
    bpart(color, rots, x0, y0, z0, x1, y1, z1, 0.03, material);
  // Orthogonal haft (sword grip, axe/pick shaft): thin capsule along Z.
  const haft = (color: Color3,
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number,
    material: number) =>
    capsulePart(color, rots, x0, y0, z0, x1, y1, z1, r, 6, material);
  // Vertical haft (bow grip riser, staff shaft): native +Y cylinder.
  const haftY = (color: Color3, cx: number, cy: number, cz: number, r: number, height: number,
    material: number) =>
    cylinderPartY(color, rots, cx, cy, cz, r, height, 6, material);

  switch (held.kind) {
    case 'sword': {
      // ORTHOGONAL fist grip (fist center ≈ y 0.78, z 0): the handle runs
      // ACROSS the hand, so the blade points forward (-Z) out of the fist —
      // never inline with the forearm. The forearm chain swings it.
      const gx = (0.375 + 0.435) / 2, gy = (0.75 + 0.81) / 2;
      return [
        haft(WOOD, gx, gy, -0.10, gx, gy, 0.12, 0.03, MAT.WOOD),        // grip (through fist)
        p(METAL_DIM, 0.375, 0.68, -0.17, 0.475, 0.88, -0.10, MAT.IRON), // crossguard
        p(c, 0.38, 0.745, -0.80, 0.43, 0.815, -0.17, MAT.IRON),         // blade (forward)
        p(METAL_DIM, 0.385, 0.74, 0.12, 0.475, 0.82, 0.18, MAT.IRON),   // pommel
      ];
    }
    case 'axe': {
      // Orthogonal grip like the sword: shaft forward out of the fist,
      // broad blade hanging edge-down at the far end.
      const sx = (0.375 + 0.435) / 2, sy = (0.75 + 0.81) / 2;
      return [
        haft(WOOD, sx, sy, -0.85, sx, sy, 0.12, 0.03, MAT.WOOD),        // shaft (forward)
        p(c, 0.375, 0.52, -0.84, 0.495, 0.82, -0.60, MAT.IRON),         // blade (edge down)
        p(c, 0.385, 0.73, -0.58, 0.485, 0.83, -0.46, MAT.IRON),         // back poll
      ];
    }
    case 'pickaxe': {
      // Orthogonal grip: shaft forward, twin spikes crossing it vertically
      // at the far end.
      const sx = (0.375 + 0.435) / 2, sy = (0.75 + 0.81) / 2;
      return [
        haft(WOOD, sx, sy, -0.85, sx, sy, 0.12, 0.03, MAT.WOOD),        // shaft (forward)
        p(c, 0.375, 0.55, -0.80, 0.485, 1.00, -0.68, MAT.IRON),         // twin spikes
        p(c, 0.385, 0.70, -0.86, 0.475, 0.86, -0.62, MAT.IRON),         // head wedge
      ];
    }
    case 'bow': {
      // Deep D-shape held at mid-grip, bowing forward of the arm. The string
      // is a taut cord (gut/sinew, not woven fabric) — closest available
      // material is LEATHER, which also keeps its pale [0.85,0.85,0.80]
      // color legible (LEATHER's tint weight is 1.0, so vertex color wins).
      const gx = (0.375 + 0.435) / 2, gz = (-0.06 + 0.02) / 2;
      return [
        haftY(c, gx, 0.62, gz, 0.035, 0.30, MAT.WOOD),                  // grip riser
        p(c, 0.375, 0.92, -0.18, 0.435, 1.22, -0.06, MAT.WOOD),         // upper limb
        p(c, 0.375, 0.32, -0.18, 0.435, 0.62, -0.06, MAT.WOOD),         // lower limb
        p([0.85, 0.85, 0.80], 0.39, 0.34, -0.20, 0.42, 1.20, -0.18, MAT.LEATHER), // string
      ];
    }
    case 'staff': {
      // Taller than the character, held against the outside of the palm.
      const sx = (0.375 + 0.435) / 2, sz = (-0.14 + -0.06) / 2;
      return [
        haftY(c, sx, 0.06, sz, 0.035, 1.72, MAT.WOOD),                  // shaft
        p([c[0] * 1.3, c[1] * 1.3, c[2] * 1.3],
          0.36, 1.78, -0.17, 0.45, 1.94, -0.03, MAT.GEM),               // knob (above arm)
      ];
    }
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

// ---------------------------------------------------------------------------
// Torso profiles — where the body narrows, which is what carries silhouette
// ---------------------------------------------------------------------------

/**
 * Widths and depths at the three stacked torso masses. Widths multiply `tW`
 * (the sex's base torso half-width); depths are absolute z half-extents.
 *
 * The single number that matters most is `waistW`. A figure reads as male or
 * female from its shoulder-to-waist-to-hip ratio long before any detail is
 * resolvable, and the old build had that ratio at exactly 1:1:1 for both.
 */
interface TorsoProfile {
  chestW: number; waistW: number; hipW: number;
  chestD: number; waistD: number; hipD: number;
  /** Waist height as a fraction of hip→shoulder. Women carry it higher. */
  waistT: number;
  /** Deltoid mass radius as a multiple of tW — the top of the V. */
  deltoid: number;
  /** Bust radius as a multiple of tW; 0 = none. */
  bust: number;
}

/** Broad chest and shoulders tapering to narrow hips — a V. */
const M_TORSO: TorsoProfile = {
  chestW: 1.14, waistW: 0.88, hipW: 0.94,
  chestD: 0.150, waistD: 0.126, hipD: 0.134,
  waistT: 0.40, deltoid: 0.40, bust: 0,
};

/**
 * Hourglass: a moderate chest, a markedly narrower and higher waist, and hips
 * that come back out at least as wide as the chest. Note `hipW` exceeds
 * `chestW` — with the female `tW` already 12% under the male's, that lands the
 * hips near male width in absolute terms while the waist stays much smaller,
 * which is the whole shape.
 */
const F_TORSO: TorsoProfile = {
  chestW: 1.00, waistW: 0.68, hipW: 1.12,
  chestD: 0.142, waistD: 0.112, hipD: 0.150,
  waistT: 0.48, deltoid: 0.26, bust: 0.34,
};

/** Build the posed, colored triangle soup: interleaved
 * [x,y,z, nx,ny,nz, r,g,b, materialId] × N. */
export function buildCharacterMesh(
  custom: CharacterCustomization,
  pose: Pose,
  held: HeldItem | null = null,
  options?: CharacterOptions,
  out?: Float32Array<ArrayBuffer>,
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
  const aim = Math.min(Math.max(pose.aim ?? 0, 0), 1);
  const seat = Math.min(Math.max(pose.seat ?? 0, 0), 1);
  const swing = Math.sin(pose.walkPhase) * pose.walkAmp;
  // Seated, both thighs swing forward TOGETHER — opposite-phase legs are a
  // walk, and a walking rider looks like they are pedalling the animal.
  const legPitch = seat > 0
    ? swing * 0.7 * (1 - seat) + seat * SEAT_THIGH_PITCH
    : swing * 0.7;
  const legPitchL = seat > 0
    ? -swing * 0.7 * (1 - seat) + seat * SEAT_THIGH_PITCH
    : -swing * 0.7;
  const armPitch = -swing * 0.5;

  // Keyframed chop: overhead windup → downward strike → recovery, with the
  // torso coiling back then leaning into the blow. All joints return to rest
  // at attackT 0/1 so the idle mesh is bit-identical to the pre-chop output.
  //
  // A live bow draw wins outright: the same right arm cannot be mid-chop and
  // at full draw, and blending the two produces a limb doing neither.
  const chop = aim > 0
    ? drawAt(aim)
    : chopAt(Math.min(Math.max(pose.attackT, 0), 1));

  // Torso chain shared by everything above the hips (not the legs).
  // Seated adds a small forward settle so the rider is over the withers
  // rather than bolt upright like a fence post.
  const torsoRots: Rot[] =
    [pitch(chop.lean - seat * SEAT_TORSO_LEAN, hipY), twistY(chop.twist)];

  // ----- torso masses (see TorsoProfile) -----------------------------------
  // Generous vertical overlap between neighbours: gaps would read as three
  // stacked beads, and the point is one continuous stuffed body that happens
  // to narrow at the waist.
  const prof    = isFemale ? F_TORSO : M_TORSO;
  const tH      = torsoTop - hipY;
  const hipCy   = hipY + tH * 0.17;
  const hipRy   = tH * 0.30;
  const waistCy = hipY + tH * prof.waistT;
  const waistRy = tH * 0.24;
  const chestCy = hipY + tH * 0.76;
  const chestRy = tH * 0.32;
  const rShoulderPitch = -armPitch + chop.shoulder;
  // Right upper arm: shoulder joint, then ride the torso.
  const rArmRots: Rot[] = [pitch(rShoulderPitch, shoulderY), ...torsoRots];
  // Right forearm + held item: elbow joint first, then the same chain.
  const rForeRots: Rot[] = [pitch(chop.elbow, elbowY), ...rArmRots];
  //
  // WRIST. Pushing the bow arm forward pitches the whole forearm chain by ~87
  // degrees, and everything hanging off it goes with the arm — including the
  // bow, which ended up lying FLAT across the archer's chest like a plank.
  // (It rendered exactly that way the first time and looked like a scaffolding
  // beam.) A real archer's wrist holds the riser upright while the arm
  // extends, so add a wrist joint at the fist that cancels the arm's pitch,
  // keeping a drawn bow vertical. Scaled by `aim`, so at rest the chain is
  // untouched and the idle mesh stays bit-identical.
  const wristY = isFemale ? 0.77 * 0.96 : 0.77;
  const bowWrist = (held !== null && held.kind === 'bow' && aim > 0)
    ? -(chop.elbow + rShoulderPitch) * aim
    : 0;
  const rHeldRots: Rot[] = bowWrist !== 0
    ? [pitch(bowWrist, wristY, -0.02), ...rForeRots]
    : rForeRots;
  const lArmRots: Rot[] = [pitch(armPitch + chop.offShoulder, shoulderY), ...torsoRots];
  // Left forearm: identical to lArmRots at rest (offElbow 0 makes pitch() a
  // no-op rotation), so the idle mesh is unchanged; only a draw bends it.
  const lForeRots: Rot[] = chop.offElbow !== 0
    ? [pitch(chop.offElbow, elbowY), ...lArmRots]
    : lArmRots;

  // sleeveTop: top of the upper-arm capsule.  For male this must be the
  // literal 1.30 to keep bit-identical output; for female it scales with
  // elbowY.
  const sleeveTop = isFemale ? elbowY + 0.2688 : 1.30;
  // foreBot: bottom of the forearm capsule.  Male literal 0.72 preserved for hash.
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

  // Effective part materials: armor tier overrides the base knit wool.
  const bodyMaterial: number = armor?.body ? ARMOR_MATERIAL[armor.body] : MAT.KNIT;
  const legMaterial:  number = armor?.legs ? ARMOR_MATERIAL[armor.legs] : MAT.KNIT;

  // Head: squashed sphere (rounder, more "sculpted" than a bevel-box reads
  // at head scale — a bevel-box was tried and looked like a helmet even
  // without one, so the sphere is the pick; see also the report). Envelope
  // matches the old head box exactly (x/z half-width 0.15, y-center at the
  // box's vertical middle) before a deliberate 10% vertical squash.
  const headHalfY = (headTop - torsoTop) * 0.5;
  const headCy = torsoTop + headHalfY;
  const headScaleY = (headHalfY / 0.15) * 0.90;

  // ----- male geometry (shoulder arm pivots use male eye-height constants
  //       for the chain pivots so held-item chains stay correct regardless)
  const parts: Part[] = [
    // Legs (pants / leg armor), swinging in opposite phase about the hips.
    limbPart(legColor, [pitch(legPitch,   hipY)], -legO, 0, -0.11, -legI, hipY, 0.11, 0.11, 6, legMaterial),
    limbPart(legColor, [pitch(legPitchL,  hipY)],  legI, 0, -0.11,  legO, hipY, 0.11, 0.11, 6, legMaterial),
    // Torso (shirt / body armor) — three stacked masses: chest, waist, hips.
    //
    // It was a single ellipsoid, which is a barrel: the same width from armpit
    // to hip. That gives a figure with no waist, so men read as cylinders and
    // women read as slightly smaller cylinders — the female variant was
    // literally the male one scaled 12% narrower and 4% shorter, which changes
    // size but not SHAPE.
    //
    // Silhouette is carried by where the body narrows, so the torso is now
    // three overlapping masses and the profile tables set the width of each:
    //   male   — wide chest, narrower waist, narrow hips  = a V/triangle
    //   female — moderate chest, very narrow waist, wide hips = an hourglass
    // The masses overlap generously so they read as one stuffed, sewn body
    // rather than three beads on a string, which also keeps the reason the
    // ellipsoid replaced a bevelled box in the first place: no large flat
    // plane, so every face catches a gradient instead of shading to one value.
    spherePart(torsoColor, torsoRots, 0, chestCy, 0,
      tW * prof.chestW, chestRy / (tW * prof.chestW), prof.chestD / (tW * prof.chestW),
      10, 7, bodyMaterial),
    spherePart(torsoColor, torsoRots, 0, waistCy, 0,
      tW * prof.waistW, waistRy / (tW * prof.waistW), prof.waistD / (tW * prof.waistW),
      9, 6, bodyMaterial),
    spherePart(torsoColor, torsoRots, 0, hipCy, 0,
      tW * prof.hipW, hipRy / (tW * prof.hipW), prof.hipD / (tW * prof.hipW),
      9, 6, bodyMaterial),
    // Left arm: sleeve (shirt / body armor) + forearm (skin — custom.skinTone
    // is a distinct customizable color from shirt/pants, so the model DOES
    // distinguish exposed skin here), each a capsule between its joint
    // endpoints — the single biggest visual win over the old rectangular-
    // stick limbs.
    // sleeveTop and foreBot use literal values on the male path to preserve
    // bit-identical output with the pre-extension builder (golden-hash safe).
    limbPart(torsoColor, lArmRots, -armO, elbowY, -0.09, -armI, sleeveTop, 0.09, 0.09, 6, bodyMaterial),
    limbPart(skin,       lForeRots, -forO, foreBot, -0.08, -forI, elbowY, 0.08, 0.09, 6, MAT.KNIT),
    // Right arm: opposite walk swing + the chop (elbow bends the forearm).
    limbPart(torsoColor, rArmRots,  armI, elbowY, -0.09,  armO, sleeveTop, 0.09, 0.09, 6, bodyMaterial),
    limbPart(skin,       rForeRots,  forI, foreBot, -0.08,  forO, elbowY, 0.08, 0.09, 6, MAT.KNIT),
    // Head (skin) — rides the torso lean/twist.
    spherePart(skin, torsoRots, 0, headCy, 0, 0.15, headScaleY, 1, 8, 6, MAT.KNIT),
    // Eyes — slightly proud of the front face (-Z) so facing reads. Left as
    // default KNIT: small embroidered-button accents on a yarn doll's face,
    // not a distinguished material.
    // Male literals (1.47, 1.53) preserved verbatim for golden-hash safety;
    // female scales by the same head-height ratio.
    part([0.10, 0.10, 0.10], torsoRots,
      -0.09, eyeBot, -0.16, -0.03, eyeTop, -0.14),
    part([0.10, 0.10, 0.10], torsoRots,
       0.03, eyeBot, -0.16,  0.09, eyeTop, -0.14),
  ];

  // Deltoids — the shoulder caps that square off the top of the torso.
  //
  // Without them a wide chest ellipsoid just tapers away at the top and the
  // figure keeps rounded, sloping shoulders no matter how wide the chest is.
  // The male V needs a hard shoulder line to read; the female profile keeps a
  // much smaller cap so the shoulders stay soft and the hips carry the width.
  {
    const dR = tW * prof.deltoid;
    const dY = shoulderY - dR * 0.32;
    const dX = tW * prof.chestW * 0.94;
    for (const side of [-1, 1] as const) {
      parts.push(spherePart(torsoColor, torsoRots,
        side * dX, dY, 0, dR, 0.82, (prof.chestD * 0.92) / dR, 7, 5, bodyMaterial));
    }
  }

  // Bust. Two masses on the front of the chest rather than one, so the form
  // reads from the front and in three-quarter view; sunk into the chest so
  // they sit on the body instead of floating off it, in the same way the
  // shoulder caps bridge to the arms.
  if (prof.bust > 0) {
    const bR = tW * prof.bust;
    const bY = chestCy + chestRy * 0.10;
    const bZ = -(prof.chestD - bR * 0.52);
    for (const side of [-1, 1] as const) {
      parts.push(spherePart(torsoColor, torsoRots,
        side * tW * prof.chestW * 0.44, bY, bZ,
        bR, 0.90, 0.86, 7, 5, bodyMaterial));
    }
  }

  // Body armour as actual kit. Until now every tier was nothing but a tint and
  // a material swapped onto the shirt, so "wearing iron" only ever recoloured
  // the wool — no plate, no pauldron, no silhouette change at all. These sit
  // proud of the torso so the chest reads as armoured from any angle, and the
  // pauldrons break the shoulder line, which is what carries the read at
  // distance. Fibre is deliberately excluded: it is padded cloth, not plate.
  if (armor?.body !== undefined && armor.body !== 'fiber') {
    const plateTint = ARMOR_TINT[armor.body];
    const plateMat = ARMOR_MATERIAL[armor.body];
    const chestTop = torsoTop - 0.05;
    const chestBot = hipY + (torsoTop - hipY) * 0.20;
    // Breastplate — a shell over the front of the chest.
    parts.push(spherePart(plateTint, torsoRots,
      0, (chestBot + chestTop) * 0.5, -0.012,
      tW * 0.94, ((chestTop - chestBot) * 0.5) / (tW * 0.94), 0.155 / (tW * 0.94),
      10, 7, plateMat));
    // Pauldrons — squashed caps riding the outside of each shoulder.
    const pR = tW * 0.50;
    const pY = sleeveTop - pR * 0.34;
    for (const [side, rots] of [[-1, lArmRots], [1, rArmRots]] as const) {
      parts.push(spherePart(plateTint, rots,
        side * tW * 0.98, pY, 0, pR, 0.70, 0.155 / pR, 8, 6, plateMat));
    }
    // Belt at the waist — closes the plate off instead of letting it float.
    // Elliptical (a squashed cylinder would need scaling, so use a sphere
    // shell flattened in Y) so it wraps the rounded torso without corners.
    parts.push(spherePart(plateTint, torsoRots,
      0, chestBot - 0.015, 0, tW * 0.95, 0.062 / (tW * 0.95), 0.15 / (tW * 0.95),
      12, 4, ARMOR_MATERIAL[armor.body === 'dragon' ? 'dragon' : 'leather']));
  }

  // Shoulder caps. The rounded torso narrows toward its top, so without these
  // the sleeves would start out past its surface and hang unattached — the
  // same bounding-box-vs-ellipsoid gap that left the quadrupeds' legs in mid
  // air. They also give the doll rounded shoulders, which is what a sewn
  // shoulder seam actually looks like.
  {
    const capR = tW * 0.44;
    const capY = sleeveTop - capR * 0.5;
    const capX = tW * 0.90;
    parts.push(spherePart(torsoColor, lArmRots, -capX, capY, 0, capR,
      0.92, 0.13 / capR, 8, 6, bodyMaterial));
    parts.push(spherePart(torsoColor, rArmRots, capX, capY, 0, capR,
      0.92, 0.13 / capR, 8, 6, bodyMaterial));
  }

  // Hair: 1 = crop cap, 2 = cap + long back panel (back = +Z at yaw 0).
  // Female gets a taller long-panel as the signature style difference.
  // Male literals (1.60, 1.68, 1.34) preserved verbatim for golden-hash safety.
  // A helmet covers the scalp, so the cap and the long panels are suppressed
  // when one is worn — they used to be drawn regardless, and since the cap
  // sits at 1.60–1.68 against a helm that stops at headTop + 0.03, the hair
  // punched straight out through the crown. Style 3's side panels are wider
  // than the helm radius and swallowed it whole. A short fringe still shows
  // below the brow, which is what actually reads as "there is a person in
  // there" rather than a bare metal egg.
  const helmed = armor?.head !== undefined;

  if (custom.hairStyle >= 1 && !helmed) {
    // A skull cap, not a plank. This was a flat bevel box floating clear of
    // the head with daylight visible between the two; a squashed sphere a
    // hair's breadth larger than the skull sits on it the way hair does.
    parts.push(spherePart(custom.hairColor, torsoRots,
      0, headCy + headHalfY * 0.16, 0, 0.158,
      headScaleY * 0.97, 1, 10, 6, MAT.KNIT));
  }
  if (helmed) {
    // Fringe peeking out under the helmet brow.
    parts.push(bpart(custom.hairColor, torsoRots,
      -0.135, eyeTop + 0.015, -0.155, 0.135, eyeTop + 0.065, -0.085, 0.02));
  }
  if (custom.hairStyle >= 2 && !helmed) {
    // A rounded fall of hair down the back of the head and neck.
    //
    // This was a flat bevel box standing off the back of the skull, and it
    // read exactly like what it was: a rectangular slab clipped to the head,
    // the single most obvious defect on the female doll. Hair is a soft mass
    // that wraps the skull, so it gets a squashed ellipsoid — flattened in z
    // so it hugs the back rather than ballooning out behind.
    const napeTop = headCy + headHalfY * 0.12;
    const napeBot = isFemale ? torsoTop - 0.04 : torsoTop + 0.07;
    const napeCy  = (napeTop + napeBot) * 0.5;
    const napeR   = 0.152;
    parts.push(spherePart(custom.hairColor, torsoRots,
      0, napeCy, 0.048, napeR,
      ((napeTop - napeBot) * 0.5) / napeR, 0.66, 9, 6, MAT.KNIT));
  }
  if (custom.hairStyle >= 3 && !helmed) {
    // "Flowing": two locks framing the face, as tapered capsules rather than
    // the previous pair of side slabs. Thicker at the temple and tapering to
    // the tip, which is what makes hair read as hanging rather than as panels
    // bolted to the head — and they sit slightly forward of the nape mass so
    // the two overlap into one shape instead of intersecting as flat planes.
    const lockTop = headCy + headHalfY * 0.30;
    const lockBot = isFemale ? shoulderY - 0.12 : torsoTop - 0.02;
    for (const lx of [-0.140, 0.140]) {
      const v: number[] = [];
      // Tapered: wide at the temple, narrowing to the tip. `limbPart` only
      // offers one radius, and an untapered lock reads as a sausage.
      taperedCapsule(v, lx, lockBot + 0.048, 0.0, lx, lockTop - 0.070, 0.0,
        0.048, 0.070, 6);
      parts.push({ verts: v, color: custom.hairColor, rots: torsoRots,
        material: MAT.KNIT });
    }
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
      parts.push(part(acc.skirt, [], -skirtW, skirtBot, -0.16, skirtW, skirtTop, 0.16, MAT.CLOTH));
    }
    // Belt: thin stripe across the waist (rides the torso).
    if (acc.belt) {
      const beltBot = hipY;
      const beltTop = hipY + 0.05;
      parts.push(part(acc.belt, torsoRots, -(tW + 0.01), beltBot, -0.14, tW + 0.01, beltTop, 0.14, MAT.LEATHER));
    }
    // Apron: front panel hanging from waist (farmer look).
    if (acc.apron) {
      const apronTop = hipY + 0.12;
      const apronBot = hipY * 0.35;
      const apronW = tW * 0.7;
      parts.push(part(acc.apron, [], -apronW, apronBot, -0.145, apronW, apronTop, -0.12, MAT.CLOTH));
    }
    // Hat: wide-brim disc + crown on top of the head. Not explicitly listed
    // in the material guidance; treated as a fabric accessory (CLOTH) like
    // the other NpcAccessories garments.
    if (acc.hat) {
      // Brim: flat wide disc at the top of the head
      const brimY = headTop + 0.01;
      parts.push(part(acc.hat, torsoRots,
        -0.24, brimY, -0.24, 0.24, brimY + 0.04, 0.24, MAT.CLOTH));
      // Crown: raised center block
      parts.push(part(acc.hat, torsoRots,
        -0.12, brimY + 0.04, -0.12, 0.12, brimY + 0.14, 0.12, MAT.CLOTH));
    }
    // Boots: short boxes at the base of each leg.
    if (acc.boots) {
      parts.push(part(acc.boots, [pitch(legPitch, hipY)], -legO, 0, -0.12, -legI, 0.14, 0.12, MAT.LEATHER));
      parts.push(part(acc.boots, [pitch(-legPitch, hipY)],  legI, 0, -0.12,  legO, 0.14, 0.12, MAT.LEATHER));
    }
  }

  // Helmet: squashed sphere slightly larger than the head, only when
  // armor.head is set. Envelope matches the old helmet box exactly (x/z
  // half-width 0.175, spanning the same y-range) before the squash.
  if (armor?.head) {
    const helmTint = ARMOR_TINT[armor.head];
    const helmMaterial = ARMOR_MATERIAL[armor.head];
    const hY0 = torsoTop - 0.01, hY1 = headTop + 0.03;
    const hR = 0.175;
    const hCy = (hY0 + hY1) * 0.5;
    const hScaleY = (hY1 - hY0) / (2 * hR);
    // Dome.
    parts.push(spherePart(helmTint, torsoRots, 0, hCy, 0, hR, hScaleY, 1, 10, 7, helmMaterial));
    // The dome alone was the whole helmet, which is why it read as nothing
    // more than the head painted a different colour: a smooth ball the same
    // tint and material as the chest, with no feature to catch light. These
    // three pieces are what say "helmet" at a glance — a brow band breaking
    // the dome's silhouette, a nose guard down the face, and cheek plates.
    // A cylinder, not a box: a box wrapping a round dome leaves its four
    // corners sticking out, which reads as a plank driven through the skull
    // rather than as a band around it.
    // Sit the band just above the eyes and give it the dome's own radius at
    // that height. A constant radius looks like a brim rather than a band:
    // the dome is an ellipsoid, so anywhere off its equator a fixed-radius
    // ring stands proud of the surface by an amount that grows toward the
    // crown — which is the same bounding-box-vs-ellipsoid mistake as before.
    const browY = eyeTop + 0.005;
    const domeSemiY = hR * hScaleY;
    const bt = (browY - hCy) / domeSemiY;
    const browR = hR * Math.sqrt(Math.max(0.05, 1 - bt * bt)) * 1.05;
    {
      const v: number[] = [];
      cylinder(v, 0, browY - 0.024, 0, browR, browR, 0.048, 12, false, false);
      parts.push({ verts: v, color: helmTint, material: helmMaterial, rots: torsoRots });
    }
    // Nose guard, proud of the face (-Z).
    parts.push(bpart(helmTint, torsoRots,
      -0.028, eyeBot - 0.055, -0.175, 0.028, browY + 0.02, -0.138, 0.012, helmMaterial));
    // Cheek plates framing the face.
    for (const side of [-1, 1] as const) {
      parts.push(bpart(helmTint, torsoRots,
        side < 0 ? -0.148 : 0.086, eyeBot - 0.085, -0.152,
        side < 0 ? -0.086 : 0.148, browY, -0.055, 0.015, helmMaterial));
    }
  }

  // Dragonscale extras: bone horns on the helm, shoulder spikes and a dorsal
  // ridge on the chest. Only added for the dragon tier (golden-hash safe).
  // These DRAGON_BONE accents are the "trim" on the top (dragon) armor tier,
  // so — like the tier's main plates — they render as MAT.GOLD (gilded bone
  // trim) rather than MAT.BONE/MAT.HORN; see ARMOR_MATERIAL's doc comment.
  // Cones, not cubes. Every one of these accents used to be a plain box, so
  // the top armour tier — the one the player works toward — was studded with
  // untextured grey blocks. A cone costs the same handful of verts and
  // actually reads as a horn or a spike.
  const spike = (
    cx: number, cy: number, cz: number, r: number, len: number,
    sweep: number, rots: Rot[],
  ): void => {
    const v: number[] = [];
    cylinder(v, cx, cy, cz, r, r * 0.06, len, 7, true, false);
    parts.push({
      verts: v, color: DRAGON_BONE, material: MAT.GOLD,
      rots: sweep === 0 ? rots : [pitch(sweep, cy, cz), ...rots],
    });
  };

  if (armor?.head === 'dragon') {
    // Two swept-back horns on the helmet crown (back = +Z at yaw 0).
    spike(-0.11, headTop - 0.01, 0.02, 0.048, 0.22, -0.60, torsoRots);
    spike(0.11, headTop - 0.01, 0.02, 0.048, 0.22, -0.60, torsoRots);
  }
  if (armor?.body === 'dragon') {
    // Shoulder spikes just outside the torso top corners.
    spike(-tW * 0.98, torsoTop - 0.05, 0, 0.055, 0.17, -0.35, lArmRots);
    spike(tW * 0.98, torsoTop - 0.05, 0, 0.055, 0.17, -0.35, rArmRots);
    // Dorsal ridge: three shrinking spikes down the spine (back = +Z).
    spike(0, torsoTop - 0.10, 0.12, 0.040, 0.13, 1.35, torsoRots);
    spike(0, torsoTop - 0.24, 0.12, 0.034, 0.11, 1.35, torsoRots);
    spike(0, torsoTop - 0.37, 0.12, 0.028, 0.09, 1.35, torsoRots);
  }

  // Held item rides the full right-forearm chain (elbow + shoulder + torso).
  if (held !== null) {
    parts.push(...heldParts(held, rHeldRots));
    // An arrow on the string while the bow is being drawn. Gated on aim so it
    // costs nothing (geometry or budget) in every other pose, and on the item
    // actually being a bow so no one nocks an arrow onto a pickaxe.
    if (held.kind === 'bow' && aim > 0.02) {
      parts.push(...nockedArrowParts(aim, rHeldRots));
    }
  }

  const totalVerts = parts.reduce((n, p) => n + p.verts.length / 6, 0);
  const floats = totalVerts * 10;
  // Callers that rebuild every frame (the player, every visible NPC) pass a
  // persistent scratch buffer: allocating a fresh ~2 MB array per character
  // per frame was roughly 118 MB/s of GC garbage on its own. Callers that
  // build occasionally — tests, one-off previews — omit it and get an
  // exact-size array whose .buffer is safe to hash.
  const dst = out !== undefined && out.length >= floats
    ? out
    : new Float32Array(floats);
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
    for (let i = 0; i < p.verts.length; i += 6) {
      let x = p.verts[i];
      let y = p.verts[i + 1];
      let z = p.verts[i + 2];
      let nx = p.verts[i + 3];
      let ny = p.verts[i + 4];
      let nz = p.verts[i + 5];
      for (const r of rs) {
        if (r.ax === 0) {
          // Pitch about X through (p0, p1): +pitch kicks the below-pivot
          // end forward (-Z), matching the legs. The normal rotates by the
          // same angle with the pivot offset OMITTED (it's a direction, not
          // a point) — x/nx are untouched since this rotation only mixes y/z.
          const dy = y - r.p0;
          const dz = z - r.p1;
          y = r.p0 + dy * r.c - dz * r.s;
          z = r.p1 + dy * r.s + dz * r.c;
          const ny2 = ny * r.c - nz * r.s;
          const nz2 = ny * r.s + nz * r.c;
          ny = ny2; nz = nz2;
        } else {
          // Twist about Y through (p0, p1) — whole-body-yaw handedness.
          // Same pivot-less rotation applied to the normal; y/ny untouched.
          const dx = x - r.p0;
          const dz = z - r.p1;
          x = r.p0 + dx * r.c - dz * r.s;
          z = r.p1 + dx * r.s + dz * r.c;
          const nx2 = nx * r.c - nz * r.s;
          const nz2 = nx * r.s + nz * r.c;
          nx = nx2; nz = nz2;
        }
      }
      // Whole-body yaw about the origin (matches tree.wgsl's convention).
      // Already pivot-less, so position and normal share the same formula.
      const rx = x * yc - z * ys;
      const rz = x * ys + z * yc;
      const rnx = nx * yc - nz * ys;
      const rnz = nx * ys + nz * yc;
      // Re-normalize for safety against accumulated float error — the chain
      // above is all rigid rotation, so length should already be ~1.
      const nlen = Math.hypot(rnx, ny, rnz) || 1;
      dst[o++] = rx;
      dst[o++] = y;
      dst[o++] = rz;
      dst[o++] = rnx / nlen;
      dst[o++] = ny / nlen;
      dst[o++] = rnz / nlen;
      dst[o++] = p.color[0];
      dst[o++] = p.color[1];
      dst[o++] = p.color[2];
      dst[o++] = p.material;
    }
  }
  return dst === out ? dst.subarray(0, floats) : dst;
}

/**
 * Largest vertex count possible. Capsule/sphere primitives cost far more
 * verts per part than the old 36-vert box (a 6-segment capsule alone is
 * 252 verts), so this was measured directly with an exhaustive sweep over
 * buildCharacterMesh's option space (body × hairStyle 0-3 × every armor
 * tier on every slot × NPC accessories on/off × every held item) rather
 * than hand-summed. Worst case was 3588 verts (male, hairStyle 3, dragon
 * armor on head+body, all NPC accessories, held sword) against a 4200 cap.
 *
 * Raised to 6200 when body armour became real geometry (breastplate, two
 * pauldrons, belt), the helmet gained a brow band / nose guard / cheek plates,
 * and the dragonscale accents became cones — armour used to add nothing but a
 * tint, so the whole armoured silhouette was free.
 *
 * The first attempt at this set 5200 from the mesh test's "full dragonscale"
 * case, which does NOT stack NPC accessories and a held item on top. The real
 * worst case is 5517 (dragon on all three slots + skirt/belt/apron/hat/boots +
 * held sword) and the game rendered a BLACK SCREEN because the per-frame
 * writeBuffer overran its allocation. test-character-mesh.mts now sweeps the
 * whole option space rather than trusting one hand-picked combination.
 *
 * Raised again to 7400 when the torso became three stacked masses (chest,
 * waist, hips) plus deltoids and, on the female profile, a bust — the change
 * that gave the figures an actual shoulder-waist-hip ratio instead of one
 * barrel ellipsoid for both sexes. New worst case 6729 (female, dragonscale on
 * all three slots, NPC accessories, held sword). The sweep caught this as a
 * failing assertion rather than as a black screen, which is the entire reason
 * it replaced the old single hand-picked case.
 *
 * At 40 B/vertex this is 296 KB per character buffer, ~3.8 MB across the ~13
 * humanoids on screen — nothing against the render budget.
 */
export const CHARACTER_MAX_VERTS = 7400;
