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
  /**
   * Optional wing-flap phase (radians, time-driven by the renderer so winged
   * species beat even at rest). Falls back to walkPhase when absent.
   */
  flapPhase?: number;
  /** 0 = wings still, 1 = full beat (falls back to walkAmp). */
  flapAmp?: number;
  /** 0 = mouth closed, 1 = jaw fully dropped (dragon fire breath). */
  jawOpen?: number;
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

/** Rotation descriptor: pitch (ax=0), yaw/twist (ax=1), or roll (ax=2). */
interface Rot { ax: 0 | 1 | 2; a: number; p0: number; p1: number }

const pitch  = (a: number, py: number, pz = 0): Rot => ({ ax: 0, a, p0: py, p1: pz });
const twistY = (a: number, px = 0, pz = 0): Rot  => ({ ax: 1, a, p0: px, p1: pz });
/** Roll about Z through (px, py) — raises/lowers wings at the shoulder. */
const rollZ  = (a: number, px = 0, py = 0): Rot  => ({ ax: 2, a, p0: px, p1: py });

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
  wolf:       [0.45, 0.46, 0.50], // steel grey
  bear:       [0.38, 0.26, 0.16], // dark brown
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
  wolf:       [0.72, 0.73, 0.75], // light grey muzzle/underside
  bear:       [0.48, 0.35, 0.22],
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
  wolf:       [0.16, 0.16, 0.18], // near-black ears / tail tip
  bear:       [0.16, 0.11, 0.07],
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
    const rs: { ax: 0|1|2; s: number; c: number; p0: number; p1: number }[] = [];
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
        } else if (r.ax === 1) {
          // Twist about Y through (p0=pivotX, p1=pivotZ)
          const dx = x - r.p0;
          const dz = z - r.p1;
          x = r.p0 + dx * r.c - dz * r.s;
          z = r.p1 + dx * r.s + dz * r.c;
        } else {
          // Roll about Z through (p0=pivotX, p1=pivotY)
          const dx = x - r.p0;
          const dy = y - r.p1;
          x = r.p0 + dx * r.c - dy * r.s;
          y = r.p1 + dx * r.s + dy * r.c;
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
// Horse/Donkey use a dedicated head assembly: body, leaning neck, mane
//   crest, skull, muzzle, ear×2, leg×4, hoof×4, hanging tail
//   = 16 boxes = 576 verts
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
  const isWolf   = species === 'wolf';
  const isBear   = species === 'bear';

  const legH  = isRabbit ? s * 0.40 : isHorse ? s * 0.58 : isWolf ? s * 0.55 : isBear ? s * 0.40 : s * 0.50;
  const bodyH = isRabbit ? s * 0.50 : isHorse ? s * 0.38 : isBear ? s * 0.55 : s * 0.40;
  const bodyW = isRabbit ? s * 0.30 : isWolf ? s * 0.24 : isBear ? s * 0.36 : s * 0.28;
  const bodyL = isRabbit ? s * 0.32 : isHorse ? s * 0.55 : isWolf ? s * 0.52 : isBear ? s * 0.50 : s * 0.44;
  const legR  = s * 0.10; // leg half-width
  const legGap = bodyW * 0.5; // lateral offset of legs from centre

  const hipY   = legH;          // bottom of torso
  const bodyTop = legH + bodyH; // top of torso

  // Head size (generic quadrupeds; horse/donkey build their own assembly)
  const headW = isRabbit ? s * 0.28 : s * 0.24;
  const headH = isRabbit ? s * 0.34 : s * 0.30;
  const headD = isRabbit ? s * 0.26 : s * 0.28;

  // Head placement: forward of body, on top of neck (or body for small animals)
  const neckH  = s * 0.10; // extra neck lift
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

  // --- Bear shoulder hump: the signature grizzly silhouette ---
  if (isBear) {
    parts.push(makePart(bodyC, noRots,
      -bodyW * 0.75, bodyTop, -bodyL * 0.55,
       bodyW * 0.75, bodyTop + s * 0.14, bodyL * 0.05));
  }

  // --- Belly stripe (slightly inset, lighter color) ---
  // (rendered as a thin slab on the underside, visible from below)
  // Skipped for simplicity — the belly is just the base color

  // --- Neck + head assembly ---
  // Horse/donkey get a dedicated build: forward-leaning neck with a mane
  // crest, a compact skull with a long lowered muzzle, and tall ears for
  // the donkey. This is what visually separates them from deer/cow.
  const isDonkey = species === 'donkey';
  if (isHorse) {
    const lean  = isDonkey ? 0.26 : 0.38;         // forward lean (radians)
    const neckW = s * 0.13;
    const neckD = s * 0.20;
    const nH    = isDonkey ? s * 0.34 : s * 0.42; // neck length along its axis
    const zc    = -(bodyL * 0.62);                // neck base centre
    const neckRot: Rot[] = [pitch(-lean, bodyTop, zc)];
    // Neck: rooted just below the torso top so the joint never shows
    parts.push(makePart(bodyC, neckRot,
      -neckW, bodyTop - s * 0.08, zc - neckD * 0.5,
       neckW, bodyTop + nH,       zc + neckD * 0.5));
    // Mane crest along the back edge of the neck
    parts.push(makePart(accentC, neckRot,
      -s * 0.035, bodyTop, zc + neckD * 0.5,
       s * 0.035, bodyTop + nH + s * 0.05, zc + neckD * 0.5 + s * 0.06));
    // Neck top after the lean — head hangs off this point
    const nTopY = bodyTop + nH * Math.cos(lean);
    const nTopZ = zc - nH * Math.sin(lean);
    const hRots: Rot[] = headTwist !== 0 ? [twistY(headTwist, 0, nTopZ)] : noRots;
    // Skull
    parts.push(makePart(bodyC, hRots,
      -s * 0.11, nTopY - s * 0.10, nTopZ - s * 0.16,
       s * 0.11, nTopY + s * 0.14, nTopZ + s * 0.10));
    // Muzzle: long, lower, forward — the defining horse profile
    parts.push(makePart(bellyC, hRots,
      -s * 0.075, nTopY - s * 0.08, nTopZ - s * 0.40,
       s * 0.075, nTopY + s * 0.05, nTopZ - s * 0.14));
    // Ears (donkey: tall; horse: small and alert)
    const eH = isDonkey ? s * 0.26 : s * 0.14;
    const eW = s * 0.05;
    const eX = s * 0.07;
    parts.push(makePart(accentC, hRots,
      -eX - eW, nTopY + s * 0.14, nTopZ - eW,
      -eX,      nTopY + s * 0.14 + eH, nTopZ + eW));
    parts.push(makePart(accentC, hRots,
       eX,      nTopY + s * 0.14, nTopZ - eW,
       eX + eW, nTopY + s * 0.14 + eH, nTopZ + eW));
  } else {
    // --- Head (generic) ---
    parts.push(makePart(bodyC, headRots,
      -headW, headY, -headFwd,
       headW, headY + headH, -(headFwd - headD)));

    // --- Ears ---
    const earW = isRabbit ? s * 0.08 : isBear ? s * 0.09 : s * 0.06;
    const earH = isRabbit ? s * 0.38 : isDeer ? s * 0.18
      : isWolf ? s * 0.16 : isBear ? s * 0.09 : s * 0.12;
    const earD = s * 0.06;
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

    // --- Wolf / bear snout: muzzle box protruding from the head front ---
    if (isWolf || isBear) {
      const snW = headW * 0.55;
      const snH = headH * 0.45;
      const snD = isWolf ? s * 0.26 : s * 0.20; // wolf: longer, pointier
      const snY = headY + headH * 0.15;
      parts.push(makePart(bellyC, headRots,
        -snW, snY, -(headFwd + snD),
         snW, snY + snH, -(headFwd - headD * 0.15)));
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
  }

  // --- Legs (4): FL=front-left, FR=front-right, BL=back-left, BR=back-right ---
  // Front pair: -Z half of body (z < 0 from centre = forward in local space)
  // "Front" in local space is -Z direction (facing).
  const legFZ = -(bodyL * 0.65); // front leg longitudinal centre
  const legBZ =  (bodyL * 0.65); // back leg longitudinal centre

  // Horse/donkey legs end in dark hooves; other species' legs reach y=0.
  const hoofH = isHorse ? s * 0.07 : 0;
  const legDefs: [x: number, z: number, pitchA: number][] = [
    [-legGap, legFZ,  legPF], // FL: pitches with legPF
    [ legGap, legFZ, -legPF], // FR: opposite diagonal to FL
    [-legGap, legBZ, -legPB], // BL: in phase with FR
    [ legGap, legBZ,  legPB], // BR: in phase with FL
  ];
  for (const [lx, lz, la] of legDefs) {
    const legRot: Rot[] = [pitch(la, legPivotY)];
    parts.push(makePart(bodyC, legRot,
      lx - legR, hoofH, lz - legR,
      lx + legR, legH,  lz + legR));
    if (isHorse) {
      const hr = legR * 1.25;
      parts.push(makePart(accentC, legRot,
        lx - hr, 0, lz - hr,
        lx + hr, hoofH, lz + hr));
    }
  }

  // --- Tail ---
  if (isHorse) {
    // Hanging tail: drops well below the hip line
    parts.push(makePart(accentC, noRots,
      -s * 0.05, hipY - s * 0.18, bodyL - s * 0.02,
       s * 0.05, hipY + bodyH * 0.80, bodyL + s * 0.09));
  } else if (isWolf) {
    // Bushy tail angled up-and-back
    const tRot: Rot[] = [pitch(-0.45, hipY + bodyH * 0.5, bodyL)];
    parts.push(makePart(accentC, tRot,
      -s * 0.07, hipY + bodyH * 0.30, bodyL,
       s * 0.07, hipY + bodyH * 0.55, bodyL + s * 0.42));
  } else if (isBear) {
    // Stub tail
    parts.push(makePart(accentC, noRots,
      -s * 0.05, hipY + bodyH * 0.55, bodyL,
       s * 0.05, hipY + bodyH * 0.55 + s * 0.08, bodyL + s * 0.06));
  } else {
    const tailW = isRabbit ? s * 0.12 : s * 0.06;
    const tailH = isRabbit ? s * 0.12 : s * 0.16;
    const tailD = isRabbit ? s * 0.08 : s * 0.12;
    const tailY = isRabbit ? hipY + bodyH * 0.25 : hipY + bodyH * 0.70;
    parts.push(makePart(bellyC, noRots,
      -tailW, tailY, bodyL,
       tailW, tailY + tailH, bodyL + tailD));
  }

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
// Body plan: DRAGON — Ice-and-Fire-style rig: long segmented neck & tail,
// fan-finger bat wings, twin horn pairs, spike rows down the spine.
//
// Part list (54 boxes = 1944 verts):
//   Torso       (3): chest, hindquarters (tapered), belly plate
//   Neck        (4): tapering segments pitched along an arc up to the head
//   Neck spikes (2): small spikes on the neck ridge
//   Head group  (7): skull, long snout, open lower jaw, horn pair ×2
//   Back ridge  (4): spine plates along the torso
//   Legs        (8): 4 legs + 4 clawed feet
//   Wings      (16): humerus + 4 bony fingers + 3 membrane panels — per side,
//                    rolled up at the shoulder (rollZ) and fanned back (twistY)
//   Tail       (10): 6 tapering segments + vertical fin + 3 tail spikes
//
// Colors: dark-crimson body, darker belly/membrane, near-black horns/ridge/
//   claws/fingers. Wings beat on flapPhase (time-driven) even at rest.
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
  const legH  = s * 0.40;   // hip height (hunkered stance)
  const bodyH = s * 0.32;   // torso height
  const bodyW = s * 0.28;   // chest half-width
  const bodyL = s * 0.55;   // half-length

  const hipY    = legH;
  const bodyTop = legH + bodyH;

  // ----- Animation drivers -----
  const swing = Math.sin(pose.walkPhase) * pose.walkAmp;
  const legPF =  swing * 0.48;
  const legPB = -swing * 0.48;
  // Wings beat on their own time-driven phase so they move even at rest.
  const flapPhase = pose.flapPhase ?? pose.walkPhase;
  const flapAmp = pose.flapAmp ?? pose.walkAmp;

  const parts: Part[] = [];

  // ----- Torso: deep chest + tapered hindquarters + belly plate -----
  parts.push(makePart(bodyC, [],
    -bodyW, hipY, -bodyL,
     bodyW, bodyTop, bodyL * 0.30));
  parts.push(makePart(bodyC, [],
    -bodyW * 0.78, hipY + s * 0.02, bodyL * 0.10,
     bodyW * 0.78, bodyTop - s * 0.04, bodyL));
  parts.push(makePart(bellyC, [],
    -bodyW * 0.68, hipY - s * 0.06, -bodyL * 0.85,
     bodyW * 0.68, hipY + s * 0.06, bodyL * 0.25));

  // ----- Neck: 4 tapering segments swept up an arc toward the head -----
  // Each is built vertical then pitched forward about its own base; the next
  // segment's base continues from the rotated tip.
  let nBaseY = bodyTop - s * 0.05;
  let nBaseZ = -bodyL * 0.85;
  const neckSegs = [
    { hw: s * 0.160, hd: s * 0.180, len: s * 0.26, lean: 0.70 },
    { hw: s * 0.140, hd: s * 0.155, len: s * 0.26, lean: 0.45 },
    { hw: s * 0.120, hd: s * 0.135, len: s * 0.26, lean: 0.22 },
    { hw: s * 0.100, hd: s * 0.115, len: s * 0.24, lean: 0.05 },
  ];
  // Subtle flap-driven bob so the neck never looks frozen.
  // Scaled purely by flapAmp: amp 0 must stay phase-independent (test contract).
  const neckBob = Math.sin(flapPhase * 0.8) * 0.08 * flapAmp;
  const neckTops: [number, number][] = [];
  for (const seg of neckSegs) {
    const lean = seg.lean + neckBob;
    parts.push(makePart(bodyC, [pitch(-lean, nBaseY, nBaseZ)],
      -seg.hw, nBaseY - s * 0.03, nBaseZ - seg.hd,
       seg.hw, nBaseY + seg.len, nBaseZ + seg.hd));
    nBaseY += seg.len * Math.cos(lean);
    nBaseZ -= seg.len * Math.sin(lean);
    neckTops.push([nBaseY, nBaseZ]);
  }
  // Neck spikes: small blades along the back of the neck arc.
  for (const i of [0, 2]) {
    const [ny, nz] = neckTops[i];
    parts.push(makePart(accentC, [],
      -s * 0.03, ny - s * 0.02, nz + s * 0.10,
       s * 0.03, ny + s * 0.10, nz + s * 0.17));
  }

  // ----- Head: skull + long snout + open jaw + two horn pairs -----
  const headW = s * 0.17;
  const headH = s * 0.19;
  const headD = s * 0.26;
  const headY = nBaseY - s * 0.02;   // skull base
  const headZ = nBaseZ;              // skull centre (also head-yaw pivot)
  const headYaw = pose.headYaw ?? 0;
  const headRots: Rot[] = headYaw !== 0 ? [twistY(headYaw, 0, headZ)] : [];
  const skullFront = headZ - headD * 0.60;

  parts.push(makePart(bodyC, headRots,
    -headW, headY, skullFront,
     headW, headY + headH, headZ + headD * 0.35));
  // Long snout projecting well forward of the skull.
  parts.push(makePart(bodyC, headRots,
    -s * 0.115, headY + s * 0.055, skullFront - s * 0.30,
     s * 0.115, headY + s * 0.145, skullFront + s * 0.02));
  // Lower jaw: darker, hinged at the skull — drops wide open for fire breath.
  const jawHingeY = headY + s * 0.045;
  const jawPitch = 0.10 + (pose.jawOpen ?? 0) * 0.45;
  parts.push(makePart(bellyC,
    [pitch(-jawPitch, jawHingeY, headZ), ...headRots],
    -s * 0.095, headY - s * 0.045, skullFront - s * 0.26,
     s * 0.095, headY + s * 0.02, headZ + s * 0.02));
  // Two horn pairs on the skull rear, swept back.
  const hornY0 = headY + headH * 0.85;
  const hornZ = headZ + headD * 0.15;
  const hornDefs: [number, number, number, number][] = [
    // [xOffset, halfWidth, length, sweep]
    [headW * 0.68, s * 0.040, s * 0.34, 0.85],
    [headW * 0.30, s * 0.030, s * 0.20, 0.70],
  ];
  for (const [hx, hwid, hlen, sweep] of hornDefs) {
    for (const side of [-1, 1]) {
      parts.push(makePart(accentC,
        [pitch(sweep, hornY0, hornZ), ...headRots],
        side * hx - hwid, hornY0, hornZ - hwid,
        side * hx + hwid, hornY0 + hlen, hornZ + hwid));
    }
  }

  // ----- Legs + clawed feet (feet share the leg's swing) -----
  const legDefs: [number, number, number, number][] = [
    // [x, z, pitchAngle, legHalfWidth]
    [-bodyW * 0.70, -bodyL * 0.60,  legPF, s * 0.12],
    [ bodyW * 0.70, -bodyL * 0.60, -legPF, s * 0.12],
    [-bodyW * 0.60,  bodyL * 0.62, -legPB, s * 0.13],
    [ bodyW * 0.60,  bodyL * 0.62,  legPB, s * 0.13],
  ];
  for (const [lx, lz, la, lr] of legDefs) {
    const rots: Rot[] = [pitch(la, hipY)];
    parts.push(makePart(bodyC, rots,
      lx - lr, s * 0.06, lz - lr,
      lx + lr, hipY + s * 0.06, lz + lr));
    // Claw foot: darker, flat, projecting forward.
    parts.push(makePart(accentC, rots,
      lx - lr * 1.1, 0, lz - lr - s * 0.10,
      lx + lr * 1.1, s * 0.09, lz + lr));
  }

  // ----- Wings: bat-wing fan — humerus + 4 bony fingers + 3 membranes -----
  // Each finger is a thin dark spar radiating from the wrist, swept back by an
  // increasing twistY; membranes fill the gaps between fingers. The whole wing
  // is rolled up at the shoulder (rollZ) and beats on flapPhase.
  const shoulderY = bodyTop - s * 0.04;
  const shoulderZ = -bodyL * 0.35;
  const wristOff = s * 0.34;
  const raise = 0.46 + Math.sin(flapPhase) * flapAmp * 0.50;
  const fingers: [number, number][] = [
    // [length, sweep-back angle] — spans sized so the wings read as able to
    // actually lift the body (roughly wingspan ≈ 2× body length).
    [s * 1.12, -0.10],
    [s * 1.02,  0.28],
    [s * 0.88,  0.66],
    [s * 0.70,  1.05],
  ];
  const membranes: [number, number][] = [
    [s * 0.95, 0.09],
    [s * 0.82, 0.47],
    [s * 0.62, 0.85],
  ];
  for (const side of [-1, 1] as const) {
    const wristX = side * (bodyW + wristOff);
    const lift = rollZ(side * (raise + 0.18), side * bodyW, shoulderY);
    /** Box x-range between lateral offsets a..b from the body side. */
    const spanX = (a: number, b: number): [number, number] =>
      side < 0 ? [-bodyW - b, -bodyW - a] : [bodyW + a, bodyW + b];
    // Humerus: muscular root from shoulder out to the wrist.
    const [h0, h1] = spanX(-s * 0.05, wristOff + s * 0.02);
    parts.push(makePart(bodyC,
      [rollZ(side * raise, side * bodyW, shoulderY)],
      h0, shoulderY - s * 0.055, shoulderZ - s * 0.09,
      h1, shoulderY + s * 0.055, shoulderZ + s * 0.11));
    // Bony fingers fanning back from the wrist.
    for (const [len, sweep] of fingers) {
      const [f0, f1] = spanX(wristOff, wristOff + len);
      parts.push(makePart(accentC,
        [twistY(side * sweep, wristX, shoulderZ), lift],
        f0, shoulderY - s * 0.022, shoulderZ - s * 0.035,
        f1, shoulderY + s * 0.022, shoulderZ + s * 0.035));
    }
    // Membrane panels between the fingers.
    for (const [len, sweep] of membranes) {
      const [m0, m1] = spanX(wristOff + s * 0.02, wristOff + len);
      parts.push(makePart(membraneC,
        [twistY(side * sweep, wristX, shoulderZ), lift],
        m0, shoulderY - s * 0.010, shoulderZ - s * 0.110,
        m1, shoulderY + s * 0.010, shoulderZ + s * 0.110));
    }
  }

  // ----- Tail: 6 tapering segments + vertical fin + spikes, lateral sway ---
  const tailSegs = [
    { hw: s * 0.160, h: s * 0.200, d: s * 0.30 },
    { hw: s * 0.138, h: s * 0.175, d: s * 0.30 },
    { hw: s * 0.116, h: s * 0.150, d: s * 0.30 },
    { hw: s * 0.095, h: s * 0.125, d: s * 0.30 },
    { hw: s * 0.075, h: s * 0.100, d: s * 0.28 },
    { hw: s * 0.055, h: s * 0.070, d: s * 0.26 },
  ];
  let ty = hipY + bodyH * 0.30;
  let tz = bodyL;
  const tailSpikes: [number, number, Rot[]][] = [];
  for (let i = 0; i < tailSegs.length; i++) {
    const seg = tailSegs[i];
    const rots: Rot[] = [twistY(
      Math.sin(pose.walkPhase + i * 0.35) * pose.walkAmp * (0.20 + i * 0.06),
      0, tz)];
    parts.push(makePart(i < 3 ? bodyC : bellyC, rots,
      -seg.hw, ty, tz, seg.hw, ty + seg.h, tz + seg.d));
    if (i === 0 || i === 2 || i === 4) {
      tailSpikes.push([ty + seg.h, tz + seg.d * 0.5, rots]);
    }
    tz += seg.d;
    ty -= s * 0.030;
  }
  // Vertical tail fin (blade) at the tip.
  parts.push(makePart(accentC,
    [twistY(Math.sin(pose.walkPhase + 6 * 0.35) * pose.walkAmp * 0.55, 0, tz)],
    -s * 0.030, ty - s * 0.01, tz - s * 0.04,
     s * 0.030, ty + s * 0.20, tz + s * 0.14));
  // Tail spikes riding on their segment's sway.
  for (const [sy, sz, rots] of tailSpikes) {
    parts.push(makePart(accentC, rots,
      -s * 0.028, sy - s * 0.01, sz - s * 0.05,
       s * 0.028, sy + s * 0.09, sz + s * 0.05));
  }

  // ----- Back ridge: 4 plates along the torso spine ----
  const ridgeDefs: [number, number, number][] = [
    // [z, baseY, height]
    [-bodyL * 0.60, bodyTop,            s * 0.16],
    [-bodyL * 0.20, bodyTop,            s * 0.19],
    [ bodyL * 0.25, bodyTop - s * 0.04, s * 0.16],
    [ bodyL * 0.65, bodyTop - s * 0.04, s * 0.12],
  ];
  for (const [rz, ry, rh] of ridgeDefs) {
    parts.push(makePart(accentC, [],
      -s * 0.045, ry, rz - s * 0.07,
       s * 0.045, ry + rh, rz + s * 0.07));
  }

  return parts;
}

// ---------------------------------------------------------------------------
// Body plan: GRIFFIN — eagle front / lion rear with raised feathered wings
//
// Part list (22 boxes = 792 verts):
//   Torso  (3): feathered chest, lion hindquarters, pale belly
//   Neck   (1): leaning eagle neck
//   Head   (4): eagle head, hooked beak, ear tuft ×2
//   Legs   (4)
//   Wings  (8): humerus + feather panel ×2 + dark tip — per side, rolled up
//               at the shoulder (rollZ) like the dragon
//   Tail   (2): thin lion tail + feather fan tip
// ---------------------------------------------------------------------------

function buildGriffin(species: Species, pose: AnimalPose, variant: number): Part[] {
  const s = SPECIES_DEFS[species].size;
  const bodyC   = applyVariant(BASE_COLORS[species], variant); // tawny gold
  const bellyC  = BELLY_COLORS[species];
  const accentC = ACCENT_COLORS[species];                      // bright gold

  const legH  = s * 0.48;
  const bodyH = s * 0.34;
  const bodyW = s * 0.26;
  const bodyL = s * 0.52;
  const hipY    = legH;
  const bodyTop = legH + bodyH;

  const swing = Math.sin(pose.walkPhase) * pose.walkAmp;
  const legPF =  swing * 0.50;
  const legPB = -swing * 0.50;

  const parts: Part[] = [];

  // ----- Torso: feathered chest + lion hindquarters + pale belly -----
  parts.push(makePart(bodyC, [],
    -bodyW, hipY, -bodyL,
     bodyW, bodyTop, bodyL * 0.30));
  parts.push(makePart(bodyC, [],
    -bodyW * 0.85, hipY, bodyL * 0.10,
     bodyW * 0.85, bodyTop - s * 0.03, bodyL));
  parts.push(makePart(bellyC, [],
    -bodyW * 0.70, hipY - s * 0.05, -bodyL * 0.80,
     bodyW * 0.70, hipY + s * 0.05, bodyL * 0.20));

  // ----- Leaning eagle neck up to the head -----
  const lean = 0.35;
  const neckLen = s * 0.32;
  const neckZ = -bodyL * 0.72;
  const neckY = bodyTop - s * 0.04;
  parts.push(makePart(bodyC, [pitch(-lean, neckY, neckZ)],
    -s * 0.13, neckY - s * 0.03, neckZ - s * 0.15,
     s * 0.13, neckY + neckLen, neckZ + s * 0.15));
  const headY = neckY + neckLen * Math.cos(lean) - s * 0.02;
  const headZ = neckZ - neckLen * Math.sin(lean);
  const headYaw = pose.headYaw ?? 0;
  const headRots: Rot[] = headYaw !== 0 ? [twistY(headYaw, 0, headZ)] : [];

  // ----- Eagle head + hooked beak + ear tufts -----
  const headR = s * 0.16;
  parts.push(makePart(bodyC, headRots,
    -headR, headY, headZ - headR * 1.4,
     headR, headY + headR * 2.0, headZ + headR));
  parts.push(makePart(accentC, headRots,
    -s * 0.06, headY + headR * 0.7, headZ - headR * 1.4 - s * 0.16,
     s * 0.06, headY + headR * 1.2, headZ - headR * 1.4 + s * 0.02));
  for (const side of [-1, 1]) {
    parts.push(makePart(bodyC, headRots,
      side * headR * 0.6 - s * 0.04, headY + headR * 2.0, headZ - s * 0.04,
      side * headR * 0.6 + s * 0.04, headY + headR * 2.0 + s * 0.11, headZ + s * 0.04));
  }

  // ----- Legs -----
  const legR = s * 0.10;
  const legDefs: [number, number, number][] = [
    [-bodyW * 0.60, -bodyL * 0.60,  legPF],
    [ bodyW * 0.60, -bodyL * 0.60, -legPF],
    [-bodyW * 0.60,  bodyL * 0.62, -legPB],
    [ bodyW * 0.60,  bodyL * 0.62,  legPB],
  ];
  for (const [lx, lz, la] of legDefs) {
    parts.push(makePart(bodyC, [pitch(la, hipY)],
      lx - legR, 0, lz - legR,
      lx + legR, hipY + s * 0.05, lz + legR));
  }

  // ----- Wings: humerus + 2 feather panels + dark tip, rolled up ----------
  const shoulderY = bodyTop - s * 0.03;
  const shoulderZ = -bodyL * 0.25;
  const flapPhase = pose.flapPhase ?? pose.walkPhase;
  const flapAmp = pose.flapAmp ?? pose.walkAmp;
  const raise = 0.42 + Math.sin(flapPhase) * flapAmp * 0.45;
  for (const side of [-1, 1] as const) {
    const roll = (a: number): Rot[] => [rollZ(side * a, side * bodyW, shoulderY)];
    const spanX = (a: number, b: number): [number, number] =>
      side < 0 ? [-bodyW - b, -bodyW - a] : [bodyW + a, bodyW + b];
    const [h0, h1] = spanX(-s * 0.04, s * 0.24);
    parts.push(makePart(bodyC, roll(raise),
      h0, shoulderY - s * 0.05, shoulderZ - s * 0.10,
      h1, shoulderY + s * 0.05, shoulderZ + s * 0.14));
    const [p10, p11] = spanX(s * 0.20, s * 0.56);
    parts.push(makePart(bodyC, roll(raise + 0.20),
      p10, shoulderY - s * 0.02, shoulderZ - s * 0.14,
      p11, shoulderY + s * 0.02, shoulderZ + s * 0.42));
    const [p20, p21] = spanX(s * 0.52, s * 0.84);
    parts.push(makePart(bellyC, roll(raise + 0.40),
      p20, shoulderY - s * 0.016, shoulderZ - s * 0.14,
      p21, shoulderY + s * 0.016, shoulderZ + s * 0.30));
    const [t0, t1] = spanX(s * 0.80, s * 1.02);
    parts.push(makePart(accentC, roll(raise + 0.58),
      t0, shoulderY - s * 0.012, shoulderZ - s * 0.12,
      t1, shoulderY + s * 0.012, shoulderZ + s * 0.18));
  }

  // ----- Lion tail + feather fan tip -----
  const tailSway = Math.sin(pose.walkPhase + 0.8) * pose.walkAmp * 0.35;
  parts.push(makePart(bodyC, [twistY(tailSway, 0, bodyL)],
    -s * 0.05, hipY + bodyH * 0.45, bodyL,
     s * 0.05, hipY + bodyH * 0.45 + s * 0.09, bodyL + s * 0.34));
  parts.push(makePart(bellyC, [twistY(tailSway, 0, bodyL)],
    -s * 0.14, hipY + bodyH * 0.40, bodyL + s * 0.32,
     s * 0.14, hipY + bodyH * 0.40 + s * 0.16, bodyL + s * 0.50));

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
    case 'wolf':
    case 'bear':
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
//   wolf:       10 boxes  =  360 verts  (snout + bushy tail)
//   bear:       11 boxes  =  396 verts  (snout + hump + stub tail)
//   dragon:     54 boxes  = 1944 verts  (Ice-and-Fire rig — largest)
//   griffin:    22 boxes  =  792 verts  (raised feathered wings)
//   sea_serpent: 8 boxes  =  288 verts
//
// Dragon is the max: 54 × 36 = 1944 verts.
export const ANIMAL_MAX_VERTS = 1944;
