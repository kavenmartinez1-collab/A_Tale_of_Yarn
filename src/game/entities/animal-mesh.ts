/**
 * Blocky animal mesh builders — pure CPU, node-testable.
 *
 * One builder per body-plan (quadruped, bird, dragon, griffin, sea_serpent),
 * all sized relative to SPECIES_DEFS[species].size so larger species produce
 * proportionally taller/longer meshes.
 *
 * Vertex format: interleaved [x, y, z, r, g, b] × N  (stride = 6 floats,
 * 24 bytes) — identical to the character mesh pipeline convention.
 *
 * Local space: base of the creature at y = 0, facing -Z at yaw 0.
 *
 * Re-implements the box/rotation helpers locally so this file never has to
 * import from — or modify — character-mesh.ts.
 */

import type { Species } from './entity-types';
import { SPECIES_DEFS } from './entity-types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AnimalPose {
  /** Facing in radians; 0 = -Z. */
  yaw: number;
  /** Walk-cycle phase (radians, advances with distance travelled). */
  walkPhase: number;
  /** 0 = standing, 1 = full stride. */
  walkAmp: number;
  /** Optional independent head yaw (radians). */
  headYaw?: number;
}

export const ANIMAL_IDLE_POSE: AnimalPose = {
  yaw: 0, walkPhase: 0, walkAmp: 0,
};

// ---------------------------------------------------------------------------
// Geometry helpers  (mirrors mesh-utils without importing it)
// ---------------------------------------------------------------------------

type P3 = [number, number, number];

function quad(v: number[], a: P3, b: P3, c: P3, d: P3): void {
  v.push(...a, ...b, ...c, ...a, ...c, ...d);
}

/** Axis-aligned box, all 6 faces outward CCW — 36 vertices. */
function box(
  v: number[],
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
): void {
  quad(v, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // -X
  quad(v, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]); // +X
  quad(v, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]); // -Z
  quad(v, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +Z
  quad(v, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]); // +Y
  quad(v, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // -Y
}

// ---------------------------------------------------------------------------
// Rotation helpers
// ---------------------------------------------------------------------------

/** Rotation descriptor: pitch (ax=0) or yaw/twist (ax=1). */
interface Rot { ax: 0 | 1; a: number; p0: number; p1: number }

const pitch  = (a: number, py: number, pz = 0): Rot => ({ ax: 0, a, p0: py, p1: pz });
const twistY = (a: number, px = 0, pz = 0): Rot  => ({ ax: 1, a, p0: px, p1: pz });

// ---------------------------------------------------------------------------
// Part
// ---------------------------------------------------------------------------

type Color3 = [number, number, number];

interface Part {
  verts: number[];
  color: Color3;
  rots: Rot[];
}

function makePart(
  color: Color3, rots: Rot[],
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
): Part {
  const verts: number[] = [];
  box(verts, x0, y0, z0, x1, y1, z1);
  return { verts, color, rots };
}

// ---------------------------------------------------------------------------
// Color palettes
// ---------------------------------------------------------------------------

/** Shift a color component by a small amount for colorVariant tinting. */
function tint(base: Color3, dr: number, dg: number, db: number): Color3 {
  return [
    Math.min(1, Math.max(0, base[0] + dr)),
    Math.min(1, Math.max(0, base[1] + dg)),
    Math.min(1, Math.max(0, base[2] + db)),
  ];
}

/** Four variant offsets applied to base color (variant 0 = base). */
const VARIANT_SHIFTS: [number, number, number][] = [
  [0, 0, 0],          // 0: base
  [0.08, 0.06, 0.04], // 1: slightly lighter/warmer
  [-0.06, -0.05, -0.04], // 2: slightly darker
  [0.04, -0.04, 0.06], // 3: slight hue shift
];

function applyVariant(base: Color3, variant: number): Color3 {
  const [dr, dg, db] = VARIANT_SHIFTS[variant & 3];
  return tint(base, dr, dg, db);
}

// Base palette per species (main body color)
const BASE_COLORS: Record<Species, Color3> = {
  rabbit:     [0.80, 0.75, 0.68],
  deer:       [0.68, 0.50, 0.28],
  bird:       [0.30, 0.55, 0.82],
  horse:      [0.45, 0.32, 0.20],
  cow:        [0.88, 0.85, 0.80],
  donkey:     [0.58, 0.52, 0.44],
  dragon:     [0.65, 0.18, 0.18], // dark crimson body
  griffin:    [0.72, 0.60, 0.28],
  sea_serpent:[0.18, 0.52, 0.48],
};

// Secondary color (belly / lighter underside)
const BELLY_COLORS: Record<Species, Color3> = {
  rabbit:     [0.92, 0.90, 0.86],
  deer:       [0.85, 0.72, 0.50],
  bird:       [0.90, 0.90, 0.88],
  horse:      [0.55, 0.42, 0.30],
  cow:        [0.60, 0.35, 0.28], // brown patch
  donkey:     [0.72, 0.68, 0.58],
  dragon:     [0.45, 0.10, 0.10], // darker underbelly
  griffin:    [0.60, 0.48, 0.20],
  sea_serpent:[0.24, 0.68, 0.62],
};

// Accent color (eyes, antler, beak, horns, claws, wing membrane, ridge)
const ACCENT_COLORS: Record<Species, Color3> = {
  rabbit:     [0.12, 0.08, 0.08],
  deer:       [0.30, 0.20, 0.10],
  bird:       [0.90, 0.70, 0.10],
  horse:      [0.20, 0.15, 0.08],
  cow:        [0.20, 0.15, 0.08],
  donkey:     [0.22, 0.18, 0.12],
  dragon:     [0.20, 0.08, 0.06], // near-black horns / ridge / membrane
  griffin:    [0.88, 0.72, 0.18],
  sea_serpent:[0.10, 0.30, 0.28],
};

// ---------------------------------------------------------------------------
// Mesh assembly: transform parts to interleaved Float32Array
// ---------------------------------------------------------------------------

function assembleParts(parts: Part[], pose: AnimalPose): Float32Array {
  const totalVerts = parts.reduce((n, p) => n + p.verts.length / 3, 0);
  const out = new Float32Array(totalVerts * 6);
  const ys = Math.sin(pose.yaw);
  const yc = Math.cos(pose.yaw);
  let o = 0;
  for (const p of parts) {
    const rs: { ax: 0|1; s: number; c: number; p0: number; p1: number }[] = [];
    for (const r of p.rots) {
      if (r.a !== 0) {
        rs.push({ ax: r.ax, s: Math.sin(r.a), c: Math.cos(r.a), p0: r.p0, p1: r.p1 });
      }
    }
    for (let i = 0; i < p.verts.length; i += 3) {
      let x = p.verts[i];
      let y = p.verts[i + 1];
      let z = p.verts[i + 2];
      for (const r of rs) {
        if (r.ax === 0) {
          // Pitch about X through (p0=pivotY, p1=pivotZ)
          const dy = y - r.p0;
          const dz = z - r.p1;
          y = r.p0 + dy * r.c - dz * r.s;
          z = r.p1 + dy * r.s + dz * r.c;
        } else {
          // Twist about Y through (p0=pivotX, p1=pivotZ)
          const dx = x - r.p0;
          const dz = z - r.p1;
          x = r.p0 + dx * r.c - dz * r.s;
          z = r.p1 + dx * r.s + dz * r.c;
        }
      }
      // Whole-body yaw about the world origin
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

// ---------------------------------------------------------------------------
// Body plan: QUADRUPED
// Covers: rabbit, deer, horse, cow, donkey
//
// Proportions driven by `s` (shoulder height = SPECIES_DEFS[species].size).
// Local space: bottom of legs at y=0; body spans legH..legH+bodyH.
//
// Boxes (all species): body, head, ear_L, ear_R, leg_FL, leg_FR, leg_BL,
//   leg_BR, tail  = 9 boxes = 324 verts
// Rabbit variant: squat body — same 9 boxes
// Deer adds: antler_L_main, antler_L_branch, antler_R_main, antler_R_branch
//   = 13 boxes = 468 verts
// Horse/Donkey add: neck  = 10 boxes = 360 verts
// Cow adds: horn_L, horn_R  = 11 boxes = 396 verts
// ---------------------------------------------------------------------------

function buildQuadruped(species: Species, pose: AnimalPose, variant: number): Part[] {
  const s = SPECIES_DEFS[species].size; // shoulder height in metres
  const bodyC  = applyVariant(BASE_COLORS[species], variant);
  const bellyC = BELLY_COLORS[species];
  const accentC = ACCENT_COLORS[species];

  // Body proportions relative to shoulder height.
  // legH  = leg length (to hip)
  // bodyH = torso height
  // bodyW = half-width of body (full width = 2*bodyW)
  // bodyL = half-length of body (front/back from centre)
  const isRabbit = species === 'rabbit';
  const isHorse  = species === 'horse' || species === 'donkey';
  const isDeer   = species === 'deer';
  const isCow    = species === 'cow';

  const legH  = isRabbit ? s * 0.40 : isHorse ? s * 0.58 : s * 0.50;
  const bodyH = isRabbit ? s * 0.50 : isHorse ? s * 0.38 : s * 0.40;
  const bodyW = isRabbit ? s * 0.30 : s * 0.28;
  const bodyL = isRabbit ? s * 0.32 : isHorse ? s * 0.55 : s * 0.44;
  const legR  = s * 0.10; // leg half-width
  const legGap = bodyW * 0.5; // lateral offset of legs from centre

  const hipY   = legH;          // bottom of torso
  const bodyTop = legH + bodyH; // top of torso

  // Head size
  const headW = isRabbit ? s * 0.28 : isHorse ? s * 0.22 : s * 0.24;
  const headH = isRabbit ? s * 0.34 : isHorse ? s * 0.28 : s * 0.30;
  const headD = isRabbit ? s * 0.26 : isHorse ? s * 0.36 : s * 0.28;

  // Head placement: forward of body, on top of neck (or body for small animals)
  const neckH  = isHorse ? s * 0.32 : s * 0.10; // extra neck lift
  const headY  = bodyTop + neckH;                // bottom of head box
  const headFwd = isRabbit ? bodyL * 0.6 : bodyL + headD * 0.4; // front z (faces -Z)

  // Walk animation: front/back leg pairs swing in opposite phase
  const swing = Math.sin(pose.walkPhase) * pose.walkAmp;
  const legPF =  swing * 0.55; // front-leg pitch: +pitch = kick forward (-Z)
  const legPB = -swing * 0.55; // back-leg pitch: opposite diagonal

  // Head yaw (optional)
  const headTwist = pose.headYaw ?? 0;

  // Rotation pivots
  const legPivotY = hipY; // legs rotate about the hip

  const noRots: Rot[] = [];

  // Head rots: twist about Y through head centre X, body midpoint Z
  const headRots: Rot[] = headTwist !== 0
    ? [twistY(headTwist, 0, -(headFwd - headD * 0.5))]
    : noRots;

  const parts: Part[] = [];

  // --- Body (torso) ---
  parts.push(makePart(bodyC, noRots,
    -bodyW, hipY, -bodyL,
     bodyW, bodyTop, bodyL));

  // --- Belly stripe (slightly inset, lighter color) ---
  // (rendered as a thin slab on the underside, visible from below)
  // Skipped for simplicity — the belly is just the base color

  // --- Neck (horse / donkey only) ---
  if (isHorse) {
    const neckW = s * 0.14;
    const neckD = s * 0.16;
    // Neck: runs from bodyTop up to headY, centred at front of body
    parts.push(makePart(bodyC, noRots,
      -neckW, bodyTop, -(bodyL * 0.6) - neckD,
       neckW, headY,   -(bodyL * 0.6)));
  }

  // --- Head ---
  parts.push(makePart(bodyC, headRots,
    -headW, headY, -headFwd,
     headW, headY + headH, -(headFwd - headD)));

  // --- Ears ---
  const earW = isRabbit ? s * 0.08 : s * 0.06;
  const earH = isRabbit ? s * 0.38 : isDeer ? s * 0.18 : isHorse ? s * 0.14 : s * 0.12;
  const earD = isRabbit ? s * 0.06 : s * 0.06;
  const earX = headW * 0.55;
  const earTopY = headY + headH;
  const earFrontZ = -(headFwd - headD * 0.2);
  parts.push(makePart(accentC, headRots,
    -earX - earW, earTopY, earFrontZ - earD,
    -earX,        earTopY + earH, earFrontZ));
  parts.push(makePart(accentC, headRots,
     earX,        earTopY, earFrontZ - earD,
     earX + earW, earTopY + earH, earFrontZ));

  // --- Deer antlers (2 sticks each side: main tine + branch) ---
  if (isDeer) {
    const antW = s * 0.04;
    const antH = s * 0.32;
    const antBranchH = s * 0.16;
    const antX = headW * 0.6;
    const antY0 = earTopY + earH * 0.2;
    const antZ  = earFrontZ - earD * 0.5;
    // Left
    parts.push(makePart(accentC, headRots,
      -antX - antW, antY0, antZ - antW,
      -antX,        antY0 + antH, antZ + antW));
    parts.push(makePart(accentC, headRots,
      -antX - antW * 3, antY0 + antH * 0.5, antZ - antW,
      -antX,             antY0 + antH * 0.5 + antBranchH, antZ + antW));
    // Right
    parts.push(makePart(accentC, headRots,
       antX,        antY0, antZ - antW,
       antX + antW, antY0 + antH, antZ + antW));
    parts.push(makePart(accentC, headRots,
       antX,        antY0 + antH * 0.5, antZ - antW,
       antX + antW * 3, antY0 + antH * 0.5 + antBranchH, antZ + antW));
  }

  // --- Cow horn nubs ---
  if (isCow) {
    const hornW = s * 0.05;
    const hornH = s * 0.12;
    const hornX = headW * 0.70;
    const hornY0 = headY + headH * 0.85;
    const hornZ  = -(headFwd - headD * 0.5);
    parts.push(makePart(accentC, headRots,
      -hornX - hornW, hornY0, hornZ - hornW,
      -hornX,         hornY0 + hornH, hornZ + hornW));
    parts.push(makePart(accentC, headRots,
       hornX,         hornY0, hornZ - hornW,
       hornX + hornW, hornY0 + hornH, hornZ + hornW));
  }

  // --- Legs (4): FL=front-left, FR=front-right, BL=back-left, BR=back-right ---
  // Front pair: -Z half of body (z < 0 from centre = forward in local space)
  // "Front" in local space is -Z direction (facing).
  const legFZ = -(bodyL * 0.65); // front leg longitudinal centre
  const legBZ =  (bodyL * 0.65); // back leg longitudinal centre

  // Front-left (FL): pitches with legPF
  parts.push(makePart(bodyC,
    [pitch(legPF, legPivotY)],
    -legGap - legR, 0, legFZ - legR,
    -legGap + legR, legH, legFZ + legR));
  // Front-right (FR): opposite diagonal to FL (back-right same)
  parts.push(makePart(bodyC,
    [pitch(-legPF, legPivotY)],
     legGap - legR, 0, legFZ - legR,
     legGap + legR, legH, legFZ + legR));
  // Back-left (BL): in phase with FR
  parts.push(makePart(bodyC,
    [pitch(-legPB, legPivotY)],
    -legGap - legR, 0, legBZ - legR,
    -legGap + legR, legH, legBZ + legR));
  // Back-right (BR): in phase with FL
  parts.push(makePart(bodyC,
    [pitch(legPB, legPivotY)],
     legGap - legR, 0, legBZ - legR,
     legGap + legR, legH, legBZ + legR));

  // --- Tail nub ---
  const tailW = isRabbit ? s * 0.12 : s * 0.06;
  const tailH = isRabbit ? s * 0.12 : s * 0.16;
  const tailD = isRabbit ? s * 0.08 : s * 0.12;
  const tailY = isRabbit ? hipY + bodyH * 0.25 : hipY + bodyH * 0.70;
  parts.push(makePart(bellyC, noRots,
    -tailW, tailY, bodyL,
     tailW, tailY + tailH, bodyL + tailD));

  return parts;
}

// ---------------------------------------------------------------------------
// Body plan: BIRD
// body(1) + head(1) + beak(1) + wing_L(1) + wing_R(1) + tail(1)
//   + leg_L(1) + leg_R(1) = 8 boxes = 288 verts
// ---------------------------------------------------------------------------

function buildBird(species: Species, pose: AnimalPose, variant: number): Part[] {
  const s = SPECIES_DEFS[species].size;
  const bodyC   = applyVariant(BASE_COLORS[species], variant);
  const bellyC  = BELLY_COLORS[species];
  const accentC = ACCENT_COLORS[species];

  const bodyW = s * 0.32;
  const bodyH = s * 0.40;
  const bodyL = s * 0.50;

  const legH = s * 0.55;
  const legR = s * 0.07;

  // Bird stands on legs: bottom of legs at y=0
  const hipY    = legH;
  const bodyTop = hipY + bodyH;

  const headR = s * 0.30;
  const headY = bodyTop + s * 0.04;

  // Wing flap: wings fold flat at rest; walkPhase drives flap
  const flapAngle = Math.sin(pose.walkPhase) * pose.walkAmp * 0.7;
  const wingW = s * 0.12;
  const wingH = s * 0.28;
  const wingL = s * 0.50;

  // Wing pivot is at the shoulder (body side, mid-height of body)
  const wingPivotY = hipY + bodyH * 0.65;
  const wingPivotX_L = -bodyW;
  const wingPivotX_R =  bodyW;

  // Flap: wings rotate about the shoulder axis (pitch about X-ish but at body side).
  // We use twistY (about Y) for flap so left wing goes up on +flapAngle.
  // Actually: bird wings flap up/down = rotation about local Z (roll) per side.
  // We approximate with pitch (ax=0) about the shoulder height pivot.
  const wingRots_L: Rot[] = [pitch(-flapAngle, wingPivotY)];
  const wingRots_R: Rot[] = [pitch( flapAngle, wingPivotY)];

  // Tail fan at back (+Z)
  const tailW = s * 0.28;
  const tailH = s * 0.10;
  const tailD = s * 0.22;

  const headYaw = pose.headYaw ?? 0;
  const headRots: Rot[] = headYaw !== 0
    ? [twistY(headYaw, 0, -(headR * 0.5))]
    : [];

  const parts: Part[] = [];

  // Legs
  const legGap = bodyW * 0.35;
  parts.push(makePart(accentC, [],
    -legGap - legR, 0, -legR,
    -legGap + legR, legH, legR));
  parts.push(makePart(accentC, [],
     legGap - legR, 0, -legR,
     legGap + legR, legH, legR));

  // Body
  parts.push(makePart(bodyC, [],
    -bodyW, hipY, -bodyL * 0.55,
     bodyW, bodyTop, bodyL * 0.45));

  // Head
  parts.push(makePart(bodyC, headRots,
    -headR, headY, -headR,
     headR, headY + headR * 2, headR));

  // Beak (wedge approximated as thin box pointing forward = -Z)
  const beakW = s * 0.10;
  const beakH = s * 0.10;
  const beakD = s * 0.22;
  parts.push(makePart(accentC, headRots,
    -beakW, headY + headR * 0.5, -headR - beakD,
     beakW, headY + headR * 0.5 + beakH, -headR));

  // Wings (fold flat by default, flap with walkPhase)
  // Left wing extends in -X direction from body side
  parts.push(makePart(bodyC, wingRots_L,
    -bodyW - wingL, wingPivotY, -wingW,
    -bodyW,         wingPivotY + wingH, wingW));
  // Right wing
  parts.push(makePart(bodyC, wingRots_R,
     bodyW,         wingPivotY, -wingW,
     bodyW + wingL, wingPivotY + wingH, wingW));

  // Tail fan
  parts.push(makePart(bellyC, [],
    -tailW, hipY + bodyH * 0.50, bodyL * 0.45,
     tailW, hipY + bodyH * 0.50 + tailH, bodyL * 0.45 + tailD));

  return parts;
}

// ---------------------------------------------------------------------------
// Body plan: DRAGON — Minecraft-dragon / Ice-and-Fire inspired blocky rig
//
// Part list (25 boxes = 900 verts):
//   Head group  (4): main head, snout, horn_L, horn_R
//   Neck        (2): neck_lower, neck_upper   (S-curve stepping up to head)
//   Body        (1): bulky chest/torso
//   Back ridge  (4): spine plates along body top
//   Wings       (6): upper_arm_L, panel_L1, panel_L2,
//                    upper_arm_R, panel_R1, panel_R2
//   Legs        (4): leg_FL, leg_FR, leg_BL, leg_BR   (thick, dragon-clawed)
//   Tail        (4): tail_seg1, tail_seg2, tail_seg3, tail_spade
//
// Colors: dark-crimson body, darker belly/membrane, near-black horns/ridge.
// Walk animation: leg swing (existing style) + wing membrane fold/unfold
//   driven by walkPhase×walkAmp, tail lateral sway on walkPhase.
// ---------------------------------------------------------------------------

function buildDragon(species: Species, pose: AnimalPose, variant: number): Part[] {
  const s = SPECIES_DEFS[species].size; // 3.5 for dragon
  const bodyC   = applyVariant(BASE_COLORS[species], variant);   // dark crimson
  const bellyC  = BELLY_COLORS[species];                          // darker underbelly
  const accentC = ACCENT_COLORS[species];                         // near-black

  // Wing membrane — slightly desaturated dark red
  const membraneC: Color3 = [
    Math.min(1, bodyC[0] * 0.65),
    Math.min(1, bodyC[1] * 0.55),
    Math.min(1, bodyC[2] * 0.55),
  ];

  // ----- Proportions -----
  const legH  = s * 0.42;   // hip height (shorter, hunkered dragon stance)
  const bodyH = s * 0.34;   // torso height
  const bodyW = s * 0.36;   // half-width (visibly wide)
  const bodyL = s * 0.58;   // half-length

  const hipY    = legH;
  const bodyTop = legH + bodyH;

  // ----- Neck (2 segments, S-curve) -----
  // Lower neck: rises from front of body, slightly forward lean
  const neckLoW = s * 0.20;   // half-width
  const neckLoH = s * 0.26;   // height of lower neck segment
  const neckLoD = s * 0.22;   // depth
  const neckLoZ = -(bodyL * 0.62); // attaches to front of body
  const neckLoY0 = bodyTop;
  // Upper neck: continues upward and slightly more forward, tapering
  const neckHiW = s * 0.16;
  const neckHiH = s * 0.28;
  const neckHiD = s * 0.18;
  const neckHiZ = neckLoZ - neckLoD * 0.4; // overlap slightly forward
  const neckHiY0 = neckLoY0 + neckLoH * 0.75;

  // ----- Head (angular, 2 sub-boxes: main skull + snout) -----
  const headW = s * 0.26;   // half-width (angular / boxy)
  const headH = s * 0.24;   // height of skull box
  const headD = s * 0.28;   // depth of skull box
  const headY = neckHiY0 + neckHiH * 0.80; // sits on top of upper neck
  const skullFwdZ = neckHiZ - headD * 0.30; // front face of skull

  // Snout: narrower, lower box projecting forward from skull
  const snoutW = s * 0.18;
  const snoutH = s * 0.14;
  const snoutD = s * 0.24;
  const snoutY = headY + headH * 0.08; // slightly below top of skull
  const snoutFwdZ = skullFwdZ - snoutD; // extends further forward

  // ----- Horns — two swept-back boxes on top of skull -----
  const hornW = s * 0.06;
  const hornH = s * 0.28;   // tall horns
  const hornX = headW * 0.60;
  const hornY0 = headY + headH * 0.70;
  const hornZ  = skullFwdZ + headD * 0.70; // toward back of skull

  // ----- Head yaw -----
  const headYaw = pose.headYaw ?? 0;
  // Pivot at the base-centre of the skull
  const headPivotZ = skullFwdZ + headD * 0.5;
  const headRots: Rot[] = headYaw !== 0
    ? [twistY(headYaw, 0, headPivotZ)]
    : [];

  // ----- Walk animation -----
  const swing    = Math.sin(pose.walkPhase) * pose.walkAmp;
  const legPF    =  swing * 0.48;
  const legPB    = -swing * 0.48;
  const legPivotY = hipY;
  const legR     = s * 0.15;  // thick legs
  const legGap   = bodyW * 0.58;
  const legFZ    = -(bodyL * 0.58);
  const legBZ    =  (bodyL * 0.58);

  // ----- Tail (3 tapering segments + spade) -----
  // Lateral sway with walkPhase; phase offsets increase down the tail.
  const tailRoot = bodyL; // tail begins at back of body

  const tail1W = s * 0.24;
  const tail1H = s * 0.26;
  const tail1D = s * 0.42;
  const tail1Y = hipY + bodyH * 0.26;
  const sway1  = Math.sin(pose.walkPhase)         * pose.walkAmp * 0.25;
  const tail1Rots: Rot[] = [twistY(sway1, 0, tailRoot)];

  const tail2W = s * 0.16;
  const tail2H = s * 0.18;
  const tail2D = s * 0.36;
  const tail2Y = hipY + bodyH * 0.16;
  const sway2  = Math.sin(pose.walkPhase + 0.55)  * pose.walkAmp * 0.35;
  const tail2Rots: Rot[] = [twistY(sway2, 0, tailRoot + tail1D)];

  const tail3W = s * 0.10;
  const tail3H = s * 0.12;
  const tail3D = s * 0.28;
  const tail3Y = hipY + bodyH * 0.08;
  const sway3  = Math.sin(pose.walkPhase + 1.10)  * pose.walkAmp * 0.45;
  const tail3Rots: Rot[] = [twistY(sway3, 0, tailRoot + tail1D + tail2D)];

  // Spade/fin tip box (flat wide box)
  const spadeW = s * 0.18;
  const spadeH = s * 0.06;
  const spadeD = s * 0.16;
  const spadeY = tail3Y + tail3H * 0.5 - spadeH * 0.5;
  const spadeZ = tailRoot + tail1D + tail2D + tail3D;
  const sway4  = Math.sin(pose.walkPhase + 1.60)  * pose.walkAmp * 0.50;
  const spadeRots: Rot[] = [twistY(sway4, 0, spadeZ)];

  // ----- Wings — hinge at shoulder, fold/unfold with walkPhase -----
  // Resting position: wings folded along body (flat panel angled slightly up).
  // When walking, the panels sway outward/up on the beat.
  const wingShoulderY = bodyTop - bodyH * 0.12; // just below top of body

  // Upper arm box (short, muscular — connects body to membrane)
  const uarmW = s * 0.12;
  const uarmH = s * 0.14;
  const uarmL = s * 0.28; // extends outward from body

  // Membrane panels: two flat wide panels hinged at the upper arm tip.
  // Panel 1: inner/proximal membrane
  // Panel 2: outer/distal membrane
  const mem1W = s * 0.38;  // lateral spread of inner panel
  const mem1H = s * 0.06;  // thin flat panel
  const mem1D = s * 0.50;  // fore-aft span

  const mem2W = s * 0.32;
  const mem2H = s * 0.05;
  const mem2D = s * 0.44;

  // Fold angle: at rest, panels tuck along body at ~15° from vertical.
  // At walkAmp=1, the flap drives the panels 20° up and back.
  const foldBase = 0.26; // radians from horizontal (folded-in default)
  const flapDelta = Math.sin(pose.walkPhase) * pose.walkAmp * 0.22;
  const wingAngle_L = -(foldBase + flapDelta); // left: pitch up (negative = up)
  const wingAngle_R =  (foldBase + flapDelta); // right: pitch up (positive = up)

  // Upper-arm pivot: at shoulder (body side, wingShoulderY)
  const uarmPivotY_L = wingShoulderY;
  const uarmPivotY_R = wingShoulderY;

  // Upper arm rests horizontal then pitches with fold
  const uarmRots_L: Rot[] = [pitch(wingAngle_L, uarmPivotY_L)];
  const uarmRots_R: Rot[] = [pitch(wingAngle_R, uarmPivotY_R)];

  // Membrane panels rotate further from body side — they follow the upper arm
  // plus an additional droop angle simulating membrane hang.
  const droopExtra = 0.18;
  const mem1Rots_L: Rot[] = [pitch(wingAngle_L - droopExtra, wingShoulderY)];
  const mem1Rots_R: Rot[] = [pitch(wingAngle_R + droopExtra, wingShoulderY)];
  const mem2Rots_L: Rot[] = [pitch(wingAngle_L - droopExtra * 1.6, wingShoulderY)];
  const mem2Rots_R: Rot[] = [pitch(wingAngle_R + droopExtra * 1.6, wingShoulderY)];

  // ----- Back ridge plates (4 along spine) -----
  const ridgeW = s * 0.05;
  const ridgeH = s * 0.18;
  const ridgeD = s * 0.07;
  // Evenly spaced across body Z
  const ridgeZs = [
    -bodyL * 0.55,
    -bodyL * 0.18,
     bodyL * 0.18,
     bodyL * 0.55,
  ];

  // ==========================================================================
  // Assemble parts
  // ==========================================================================

  const parts: Part[] = [];

  // --- Body (bulky chest) ---
  parts.push(makePart(bodyC, [],
    -bodyW, hipY,    -bodyL,
     bodyW, bodyTop,  bodyL));

  // --- Neck lower ---
  parts.push(makePart(bodyC, [],
    -neckLoW, neckLoY0, neckLoZ - neckLoD,
     neckLoW, neckLoY0 + neckLoH, neckLoZ));

  // --- Neck upper ---
  parts.push(makePart(bodyC, [],
    -neckHiW, neckHiY0, neckHiZ - neckHiD,
     neckHiW, neckHiY0 + neckHiH, neckHiZ));

  // --- Skull ---
  parts.push(makePart(bodyC, headRots,
    -headW, headY, skullFwdZ,
     headW, headY + headH, skullFwdZ + headD));

  // --- Snout (distinct narrower box, slightly open jaw implied by placement) ---
  parts.push(makePart(bellyC, headRots,
    -snoutW, snoutY, snoutFwdZ,
     snoutW, snoutY + snoutH, snoutFwdZ + snoutD));

  // --- Horns (swept back — both tilt via slight pitch baked into position) ---
  parts.push(makePart(accentC, headRots,
    -hornX - hornW, hornY0, hornZ - hornW,
    -hornX,          hornY0 + hornH, hornZ + hornW * 1.5));
  parts.push(makePart(accentC, headRots,
     hornX,          hornY0, hornZ - hornW,
     hornX + hornW,  hornY0 + hornH, hornZ + hornW * 1.5));

  // --- Back ridge plates ---
  for (const rz of ridgeZs) {
    parts.push(makePart(accentC, [],
      -ridgeW, bodyTop, rz - ridgeD,
       ridgeW, bodyTop + ridgeH, rz + ridgeD));
  }

  // --- Legs (4 — thick, dragon-clawed) ---
  parts.push(makePart(bodyC, [pitch( legPF, legPivotY)],
    -legGap - legR, 0, legFZ - legR,
    -legGap + legR, legH, legFZ + legR));
  parts.push(makePart(bodyC, [pitch(-legPF, legPivotY)],
     legGap - legR, 0, legFZ - legR,
     legGap + legR, legH, legFZ + legR));
  parts.push(makePart(bodyC, [pitch(-legPB, legPivotY)],
    -legGap - legR, 0, legBZ - legR,
    -legGap + legR, legH, legBZ + legR));
  parts.push(makePart(bodyC, [pitch( legPB, legPivotY)],
     legGap - legR, 0, legBZ - legR,
     legGap + legR, legH, legBZ + legR));

  // --- Wings (left side) ---
  // Upper arm (shoulder → wing-root, extends left / -X)
  parts.push(makePart(bodyC, uarmRots_L,
    -bodyW - uarmL, wingShoulderY,          -uarmW,
    -bodyW,          wingShoulderY + uarmH,  uarmW));
  // Inner membrane panel 1
  parts.push(makePart(membraneC, mem1Rots_L,
    -bodyW - uarmL - mem1W, wingShoulderY,         -mem1D * 0.5,
    -bodyW - uarmL,          wingShoulderY + mem1H,  mem1D * 0.5));
  // Outer membrane panel 2
  parts.push(makePart(membraneC, mem2Rots_L,
    -bodyW - uarmL - mem1W - mem2W, wingShoulderY,         -mem2D * 0.4,
    -bodyW - uarmL - mem1W,          wingShoulderY + mem2H,  mem2D * 0.4));

  // --- Wings (right side) ---
  parts.push(makePart(bodyC, uarmRots_R,
     bodyW,          wingShoulderY,         -uarmW,
     bodyW + uarmL,  wingShoulderY + uarmH,  uarmW));
  parts.push(makePart(membraneC, mem1Rots_R,
     bodyW + uarmL,          wingShoulderY,         -mem1D * 0.5,
     bodyW + uarmL + mem1W,  wingShoulderY + mem1H,  mem1D * 0.5));
  parts.push(makePart(membraneC, mem2Rots_R,
     bodyW + uarmL + mem1W,          wingShoulderY,         -mem2D * 0.4,
     bodyW + uarmL + mem1W + mem2W,  wingShoulderY + mem2H,  mem2D * 0.4));

  // --- Tail ---
  parts.push(makePart(bodyC, tail1Rots,
    -tail1W, tail1Y, tailRoot,
     tail1W, tail1Y + tail1H, tailRoot + tail1D));
  parts.push(makePart(bellyC, tail2Rots,
    -tail2W, tail2Y, tailRoot + tail1D,
     tail2W, tail2Y + tail2H, tailRoot + tail1D + tail2D));
  parts.push(makePart(bellyC, tail3Rots,
    -tail3W, tail3Y, tailRoot + tail1D + tail2D,
     tail3W, tail3Y + tail3H, tailRoot + tail1D + tail2D + tail3D));
  parts.push(makePart(accentC, spadeRots,
    -spadeW, spadeY, spadeZ,
     spadeW, spadeY + spadeH, spadeZ + spadeD));

  return parts;
}

// ---------------------------------------------------------------------------
// Body plan: GRIFFIN
// quadruped body + bird head/beak + folded wings + feather tail + eagle ears
// body(1) + head(1) + beak(1) + ear_L(1) + ear_R(1)
// + leg_FL(1) + leg_FR(1) + leg_BL(1) + leg_BR(1)
// + wing_uarm_L(1) + wing_panel_L1(1) + wing_panel_L2(1)
// + wing_uarm_R(1) + wing_panel_R1(1) + wing_panel_R2(1)
// + tail(1) + neck(1)
// = 17 boxes = 612 verts
// ---------------------------------------------------------------------------

function buildGriffin(species: Species, pose: AnimalPose, variant: number): Part[] {
  const s = SPECIES_DEFS[species].size;
  const bodyC   = applyVariant(BASE_COLORS[species], variant);
  const bellyC  = BELLY_COLORS[species];
  const accentC = ACCENT_COLORS[species];

  const legH  = s * 0.50;
  const bodyH = s * 0.36;
  const bodyW = s * 0.28;
  const bodyL = s * 0.50;

  const hipY    = legH;
  const bodyTop = legH + bodyH;

  const neckW = s * 0.14;
  const neckH = s * 0.30;
  const neckZ = -(bodyL * 0.55);

  // Bird-like head
  const headR = s * 0.22;
  const headY = bodyTop + neckH;
  const headFwdZ = neckZ - headR * 2;

  const swing  = Math.sin(pose.walkPhase) * pose.walkAmp;
  const legPF  =  swing * 0.50;
  const legPB  = -swing * 0.50;
  const legPivotY = hipY;
  const legR   = s * 0.10;
  const legGap = bodyW * 0.50;
  const legFZ  = -(bodyL * 0.60);
  const legBZ  =  (bodyL * 0.60);

  // Wing flap (membrane upgrade matching dragon technique)
  const flapAngle = Math.sin(pose.walkPhase) * pose.walkAmp * 0.55;
  const foldBase  = 0.20; // resting fold angle
  const wingPivotY = bodyTop - bodyH * 0.10;

  // Upper arm
  const uarmW = s * 0.10;
  const uarmH = s * 0.12;
  const uarmL = s * 0.24;

  // Two membrane panels per side
  const mem1W = s * 0.30;
  const mem1H = s * 0.05;
  const mem1D = s * 0.42;
  const mem2W = s * 0.24;
  const mem2H = s * 0.04;
  const mem2D = s * 0.36;

  const droopExtra = 0.14;
  const wingAngle_L = -(foldBase + flapAngle);
  const wingAngle_R =  (foldBase + flapAngle);

  const uarmRots_L:  Rot[] = [pitch(wingAngle_L, wingPivotY)];
  const uarmRots_R:  Rot[] = [pitch(wingAngle_R, wingPivotY)];
  const mem1Rots_L:  Rot[] = [pitch(wingAngle_L - droopExtra, wingPivotY)];
  const mem1Rots_R:  Rot[] = [pitch(wingAngle_R + droopExtra, wingPivotY)];
  const mem2Rots_L:  Rot[] = [pitch(wingAngle_L - droopExtra * 1.5, wingPivotY)];
  const mem2Rots_R:  Rot[] = [pitch(wingAngle_R + droopExtra * 1.5, wingPivotY)];

  const headYaw = pose.headYaw ?? 0;
  const headRots: Rot[] = headYaw !== 0
    ? [twistY(headYaw, 0, headFwdZ + headR)]
    : [];

  const parts: Part[] = [];

  // Body
  parts.push(makePart(bodyC, [],
    -bodyW, hipY, -bodyL,
     bodyW, bodyTop, bodyL));

  // Neck
  parts.push(makePart(bodyC, [],
    -neckW, bodyTop, neckZ - neckW,
     neckW, bodyTop + neckH, neckZ + neckW));

  // Head (eagle-like round)
  parts.push(makePart(accentC, headRots,
    -headR, headY, headFwdZ,
     headR, headY + headR * 2, headFwdZ + headR * 2));

  // Beak
  const beakW = s * 0.10;
  const beakH = s * 0.12;
  const beakD = s * 0.24;
  parts.push(makePart(accentC, headRots,
    -beakW, headY + headR * 0.4, headFwdZ - beakD,
     beakW, headY + headR * 0.4 + beakH, headFwdZ));

  // Tufted ears (small)
  const earW = s * 0.05;
  const earH = s * 0.10;
  const earX = headR * 0.65;
  const earY0 = headY + headR * 2;
  const earZ  = headFwdZ + headR * 0.6;
  parts.push(makePart(bodyC, headRots,
    -earX - earW, earY0, earZ - earW,
    -earX,        earY0 + earH, earZ + earW));
  parts.push(makePart(bodyC, headRots,
     earX,        earY0, earZ - earW,
     earX + earW, earY0 + earH, earZ + earW));

  // Legs (lion-like hindquarters)
  parts.push(makePart(bodyC, [pitch( legPF, legPivotY)],
    -legGap - legR, 0, legFZ - legR,
    -legGap + legR, legH, legFZ + legR));
  parts.push(makePart(bodyC, [pitch(-legPF, legPivotY)],
     legGap - legR, 0, legFZ - legR,
     legGap + legR, legH, legFZ + legR));
  parts.push(makePart(bodyC, [pitch(-legPB, legPivotY)],
    -legGap - legR, 0, legBZ - legR,
    -legGap + legR, legH, legBZ + legR));
  parts.push(makePart(bodyC, [pitch( legPB, legPivotY)],
     legGap - legR, 0, legBZ - legR,
     legGap + legR, legH, legBZ + legR));

  // Wings (left side) — upper arm + 2 membrane panels
  parts.push(makePart(bellyC, uarmRots_L,
    -bodyW - uarmL, wingPivotY,         -uarmW,
    -bodyW,          wingPivotY + uarmH,  uarmW));
  parts.push(makePart(bellyC, mem1Rots_L,
    -bodyW - uarmL - mem1W, wingPivotY,         -mem1D * 0.5,
    -bodyW - uarmL,          wingPivotY + mem1H,  mem1D * 0.5));
  parts.push(makePart(bellyC, mem2Rots_L,
    -bodyW - uarmL - mem1W - mem2W, wingPivotY,         -mem2D * 0.4,
    -bodyW - uarmL - mem1W,          wingPivotY + mem2H,  mem2D * 0.4));

  // Wings (right side)
  parts.push(makePart(bellyC, uarmRots_R,
     bodyW,          wingPivotY,         -uarmW,
     bodyW + uarmL,  wingPivotY + uarmH,  uarmW));
  parts.push(makePart(bellyC, mem1Rots_R,
     bodyW + uarmL,          wingPivotY,         -mem1D * 0.5,
     bodyW + uarmL + mem1W,  wingPivotY + mem1H,  mem1D * 0.5));
  parts.push(makePart(bellyC, mem2Rots_R,
     bodyW + uarmL + mem1W,          wingPivotY,         -mem2D * 0.4,
     bodyW + uarmL + mem1W + mem2W,  wingPivotY + mem2H,  mem2D * 0.4));

  // Feather tail
  const tailW = s * 0.26;
  const tailH = s * 0.22;
  const tailD = s * 0.28;
  const tailY = hipY + bodyH * 0.55;
  parts.push(makePart(bellyC, [],
    -tailW, tailY, bodyL,
     tailW, tailY + tailH, bodyL + tailD));

  return parts;
}

// ---------------------------------------------------------------------------
// Body plan: SEA SERPENT
// head(1) + body_seg1(1) + body_seg2(1) + body_seg3(1) + body_seg4(1)
// + fin_spike1(1) + fin_spike2(1) + fin_spike3(1)
// = 8 boxes = 288 verts
//
// Segments undulate sinusoidally with walkPhase (swim motion).
// No legs. Base sits at y=0 (water surface).
// ---------------------------------------------------------------------------

function buildSeaSerpent(species: Species, pose: AnimalPose, variant: number): Part[] {
  const s = SPECIES_DEFS[species].size;
  const bodyC   = applyVariant(BASE_COLORS[species], variant);
  const bellyC  = BELLY_COLORS[species];
  const accentC = ACCENT_COLORS[species];

  // Serpent lies partly along Z axis; head at -Z (forward).
  // Each segment connects behind the previous.

  const headW = s * 0.28;
  const headH = s * 0.32;
  const headD = s * 0.40;
  const headY = s * 0.20; // lifted off the sea floor a bit

  // Body rises slightly above water plane
  const baseY = s * 0.10;

  // Segment dimensions (tapering toward the tail)
  const segDims = [
    { w: s * 0.28, h: s * 0.30, d: s * 0.50 }, // seg 1 (widest)
    { w: s * 0.24, h: s * 0.26, d: s * 0.50 },
    { w: s * 0.18, h: s * 0.20, d: s * 0.45 },
    { w: s * 0.12, h: s * 0.14, d: s * 0.40 }, // seg 4 (tail tip)
  ];

  // Sinusoidal undulation: each segment sways side-to-side.
  // Phase offset increases along the chain so the wave travels backward.
  const waveAmp = pose.walkAmp * 0.40;
  // Segment root Z positions (connecting forward to back)
  let segZ = headD; // first segment starts right behind the head

  const parts: Part[] = [];

  // Head
  parts.push(makePart(bodyC, [],
    -headW, headY, -headD,
     headW, headY + headH, 0));

  // 4 body segments
  for (let i = 0; i < 4; i++) {
    const d = segDims[i];
    const phaseOffset = i * 0.55;
    const sway = Math.sin(pose.walkPhase + phaseOffset) * waveAmp;
    // Sway: rotate about Y at the segment root
    const segRots: Rot[] = sway !== 0
      ? [twistY(sway, 0, segZ)]
      : [];
    parts.push(makePart(i < 2 ? bodyC : bellyC, segRots,
      -d.w, baseY, segZ,
       d.w, baseY + d.h, segZ + d.d));
    segZ += d.d;
  }

  // Dorsal fin spikes (3 along the back, matching segment positions)
  const finW = s * 0.05;
  const finH = s * 0.24;
  const finD = s * 0.07;
  const finZPositions = [headD + segDims[0].d * 0.3, headD + segDims[0].d * 0.9, headD + segDims[0].d + segDims[1].d * 0.5];
  for (const fz of finZPositions) {
    parts.push(makePart(accentC, [],
      -finW, baseY + segDims[0].h, fz - finD,
       finW, baseY + segDims[0].h + finH, fz + finD));
  }

  return parts;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Build the posed, colored triangle soup for `species` into `out` (if
 * provided) or a freshly allocated Float32Array.
 *
 * Returns vertex count (not float count).  Callers must ensure
 * `out.length >= ANIMAL_MAX_VERTS * 6`.
 */
export function buildAnimalMesh(
  species: Species,
  pose: AnimalPose,
  out?: Float32Array,
  colorVariant = 0,
): { verts: Float32Array; count: number } {
  let parts: Part[];
  switch (species) {
    case 'rabbit':
    case 'deer':
    case 'horse':
    case 'cow':
    case 'donkey':
      parts = buildQuadruped(species, pose, colorVariant);
      break;
    case 'bird':
      parts = buildBird(species, pose, colorVariant);
      break;
    case 'dragon':
      parts = buildDragon(species, pose, colorVariant);
      break;
    case 'griffin':
      parts = buildGriffin(species, pose, colorVariant);
      break;
    case 'sea_serpent':
      parts = buildSeaSerpent(species, pose, colorVariant);
      break;
  }

  const assembled = assembleParts(parts, pose);
  const count = assembled.length / 6;

  if (out !== undefined) {
    out.set(assembled);
    return { verts: out, count };
  }
  return { verts: assembled, count };
}

// ---------------------------------------------------------------------------
// Budget constant
// ---------------------------------------------------------------------------

// Per-species max box counts:
//   rabbit:      9 boxes  =  324 verts
//   deer:       13 boxes  =  468 verts
//   bird:        8 boxes  =  288 verts
//   horse:      10 boxes  =  360 verts
//   cow:        11 boxes  =  396 verts
//   donkey:     10 boxes  =  360 verts
//   dragon:     25 boxes  =  900 verts  (new rig — largest)
//   griffin:    17 boxes  =  612 verts  (upgraded wing membranes)
//   sea_serpent: 8 boxes  =  288 verts
//
// Dragon is the max: 25 × 36 = 900 verts.
export const ANIMAL_MAX_VERTS = 900;
