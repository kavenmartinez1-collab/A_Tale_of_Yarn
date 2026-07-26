/**
 * creature-parts.ts — the shared vocabulary every creature body plan is built
 * from: the pose type, the rotation-chain primitives, the part builders that
 * wrap mesh-utils, the colour tables, and the poser that turns a Part[] into
 * interleaved vertices.
 *
 * Split out of animal-mesh.ts, which had grown past 2,100 lines and held five
 * body plans plus all of this. The immediate reason is ownership: the dragon
 * and the other species are being worked on independently, and a single file
 * cannot be edited by two workstreams at once without them clobbering each
 * other. The lasting reason is that this genuinely is a separate layer — none
 * of it knows anything about a particular animal.
 *
 * Vertex format and conventions are unchanged: interleaved
 * [x, y, z, nx, ny, nz, r, g, b, materialId] (stride 10 floats / 40 bytes),
 * local space with the creature's base at y = 0 facing -Z at yaw 0.
 */

import { box, bevelBox, sphere, capsule, cone, quad, type P3 } from '../mesh-utils';
import type { Species } from './entity-types';
import { MAT } from '../render/material-table';

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
   * Head pitch (radians, positive = nose DOWN).
   *
   * The single highest-value pose channel after yaw, because so many actions
   * are fundamentally a pitch: grazing puts the muzzle in the grass, alerting
   * lifts the head, and goring, butting, pecking and the counterweight of
   * every kick are all nose-down or nose-up. The attack clip library authors
   * this channel throughout and had nowhere to send it.
   */
  headPitch?: number;
  /**
   * Tail sway (radians, side to side), independent of the gait.
   *
   * A tail that only moves with the walk cycle is dead the moment the animal
   * stops. This is also the counter-swing that sells weight in an attack — a
   * bear's swipe reads as heavier when the tail answers it.
   */
  tailSway?: number;
  /**
   * Forelimb swing (radians, positive = reach FORWARD), independent of the
   * gait cycle.
   *
   * Needed because stride amplitude is derived from measured speed, so it is
   * zero exactly when a creature plants itself to strike — which is when a
   * bear's swipe or a horse's rear needs its forelegs most. Gait drives the
   * legs while moving; this adds on top and is the only thing that can move a
   * foreleg on a stationary animal.
   */
  foreSwing?: number;
  /**
   * Optional wing-flap phase (radians, time-driven by the renderer so winged
   * species beat even at rest). Falls back to walkPhase when absent.
   */
  flapPhase?: number;
  /** 0 = wings still, 1 = full beat (falls back to walkAmp). */
  flapAmp?: number;
  /** 0 = mouth closed, 1 = jaw fully dropped (dragon fire breath). */
  jawOpen?: number;
  /**
   * Metres the body has sunk below its rest height this frame (<= 0), applied
   * to the whole creature by the renderer's object offset.
   *
   * The builder needs to know because feet are solved in body-local space: if
   * the body drops without the foot targets rising to match, every planted
   * foot sinks into the terrain by the same amount, which is exactly the
   * ground-penetration the planted-foot rig exists to remove. The renderer and
   * the builder must be handed the SAME value — see `animalBodyDrop`.
   */
  bodyDrop?: number;
}

export const ANIMAL_IDLE_POSE: AnimalPose = {
  yaw: 0, walkPhase: 0, walkAmp: 0,
};

// ---------------------------------------------------------------------------
// Rotation helpers
// ---------------------------------------------------------------------------

/** Rotation descriptor: pitch (ax=0), yaw/twist (ax=1), or roll (ax=2). */
export interface Rot { ax: 0 | 1 | 2; a: number; p0: number; p1: number }

export const pitch  = (a: number, py: number, pz = 0): Rot => ({ ax: 0, a, p0: py, p1: pz });
export const twistY = (a: number, px = 0, pz = 0): Rot  => ({ ax: 1, a, p0: px, p1: pz });
/** Roll about Z through (px, py) — raises/lowers wings at the shoulder. */
export const rollZ  = (a: number, px = 0, py = 0): Rot  => ({ ax: 2, a, p0: px, p1: py });

// ---------------------------------------------------------------------------
// Part
// ---------------------------------------------------------------------------

export type Color3 = [number, number, number];

export interface Part {
  verts: number[]; // interleaved position+normal soup (6 floats/vertex) —
                    // local (unposed) space, straight from mesh-utils.
  color: Color3;
  /** MAT.* constant (material-table.ts) — constant across the part, written
   * to every vertex it emits. */
  material: number;
  rots: Rot[];
}

// ---------------------------------------------------------------------------
// Part builders — one per underlying primitive, all taking box-style bounds
// so call sites barely change shape. Capsule/cone builders that need an axis
// other than mesh-utils' native Y either auto-detect the box's longest axis
// (limbs/necks/tails whose orientation follows their own proportions) or
// force a specific axis (chain segments authored pre-rotation, where the
// "long" dimension is a rotation-chain artifact, not the box's true shape —
// see buildDragon's neck/tail for why auto-detection would pick the wrong
// axis there).
// ---------------------------------------------------------------------------

/** Plain box — cheap, used for small/flat accents (ears, hooves, claws).
 * `material` defaults to FUR — the overwhelming majority of animal geometry
 * is furred body; call sites that need HORN/SKIN/SCALE/etc pass it
 * explicitly. */
export function makePart(
  color: Color3, rots: Rot[],
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  material: number = MAT.FUR,
): Part {
  const verts: number[] = [];
  box(verts, x0, y0, z0, x1, y1, z1);
  return { verts, color, material, rots };
}

/** Beveled box — softened block for secondary shapes (skull/snout/jaw,
 * ridge plates, mane crest, belly/tail-fin plates). Degrades gracefully to
 * a plain box for thin geometry. */
export function makeBevelPart(
  color: Color3, rots: Rot[],
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  bevel = 0.03, material: number = MAT.FUR,
): Part {
  const verts: number[] = [];
  bevelBox(verts, x0, y0, z0, x1, y1, z1, bevel);
  return { verts, color, material, rots };
}

/** Non-uniform-scale sphere exactly filling the given box bounds — the
 * generic "box → rounded blob" conversion used for torsos and heads.
 * `squashY` applies an extra deliberate flattening on top (heads only). */
export function makeBoxSpherePart(
  color: Color3, rots: Rot[],
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  squashY = 1, segments = 8, rings = 6, material: number = MAT.FUR,
): Part {
  const r = (x1 - x0) * 0.5;
  const cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5, cz = (z0 + z1) * 0.5;
  const scaleY = ((y1 - y0) / (2 * r)) * squashY;
  const scaleZ = (z1 - z0) / (2 * r);
  const verts: number[] = [];
  sphere(verts, cx, cy, cz, r, segments, rings, scaleY, scaleZ);
  return { verts, color, material, rots };
}

/** Capsule between two explicit local-space points (any axis) — the base
 * primitive the box-fit capsule helpers below build on. */
export function makeCapsulePart(
  color: Color3, rots: Rot[],
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  r: number, segments = 6, material: number = MAT.FUR,
): Part {
  const verts: number[] = [];
  capsule(verts, x0, y0, z0, x1, y1, z1, r, segments);
  return { verts, color, material, rots };
}

/**
 * Shrink an axis span by the capsule radius at both ends.
 *
 * A capsule's hemispherical caps stick out a full radius past each axis
 * endpoint, so passing a box's extremes straight through makes the capsule
 * overshoot the box by 2r overall. On a leg that means the foot hangs below
 * y = 0 and the animal sinks into the terrain; on a chain segment it means
 * neighbouring links overlap more than authored.
 */
export function insetAxis(a: number, b: number, r: number): [number, number] {
  const inset = Math.min(r, (b - a) * 0.5);
  const lo = a + inset;
  return [lo, Math.max(b - inset, lo)];
}

/**
 * Like `insetAxis` but for a tapered span where each end has its own
 * radius — `taperedCapsule`'s two hemispherical caps scale to r0/r1
 * independently, so a single shared inset would under-shoot one end and
 * over-shoot the other (on a leg, that's a hoof sinking into the ground).
 */
export function insetAxisTapered(a: number, b: number, rA: number, rB: number): [number, number] {
  const span = b - a;
  const insetA = Math.min(rA, span * 0.5);
  const insetB = Math.min(rB, span * 0.5);
  const lo = a + insetA;
  return [lo, Math.max(b - insetB, lo)];
}

/** Capsule filling a box's bounds along whichever axis (X/Y/Z) is longest,
 * radius averaged from the other two half-extents — the generic "elongated
 * box → capsule" conversion for legs, muzzles/snouts, and most tails. */
export function makeBoxCapsulePart(
  color: Color3, rots: Rot[],
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  segments = 6, material: number = MAT.FUR,
): Part {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5, cz = (z0 + z1) * 0.5;
  if (dy >= dx && dy >= dz) {
    const r = (dx + dz) * 0.25;
    const [a, b] = insetAxis(y0, y1, r);
    return makeCapsulePart(color, rots, cx, a, cz, cx, b, cz, r, segments, material);
  } else if (dx >= dy && dx >= dz) {
    const r = (dy + dz) * 0.25;
    const [a, b] = insetAxis(x0, x1, r);
    return makeCapsulePart(color, rots, a, cy, cz, b, cy, cz, r, segments, material);
  } else {
    const r = (dx + dy) * 0.25;
    const [a, b] = insetAxis(z0, z1, r);
    return makeCapsulePart(color, rots, cx, cy, a, cx, cy, b, r, segments, material);
  }
}

/** Capsule FORCED along Y regardless of box proportions — for chain
 * segments (dragon neck) authored pre-rotation, where `seg.len` is the
 * intended pre-pitch length even if the box happens to be wider than it
 * is "tall" before that pitch is applied. */
export function makeVCapsulePart(
  color: Color3, rots: Rot[],
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  segments = 6, material: number = MAT.FUR,
): Part {
  const cx = (x0 + x1) * 0.5, cz = (z0 + z1) * 0.5;
  const r = ((x1 - x0) + (z1 - z0)) * 0.25;
  const [a, b] = insetAxis(y0, y1, r);
  return makeCapsulePart(color, rots, cx, a, cz, cx, b, cz, r, segments, material);
}

/** Capsule FORCED along Z regardless of box proportions — for chain
 * segments (dragon tail, sea-serpent body) that visibly chain backward via
 * an accumulating Z offset even when the box itself reads wider than deep. */
export function makeZCapsulePart(
  color: Color3, rots: Rot[],
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  segments = 6, material: number = MAT.FUR,
): Part {
  const cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5;
  const r = ((x1 - x0) + (y1 - y0)) * 0.25;
  const [a, b] = insetAxis(z0, z1, r);
  return makeCapsulePart(color, rots, cx, cy, a, cx, cy, b, r, segments, material);
}

/** Cone along Y filling a box's bounds — base (full box width) at y0,
 * tapering to a point at y1. The generic "box → horn/spike" conversion for
 * parts that are authored vertical pre-rotation (their sweep/lean comes
 * from the rotation chain, same pattern as the neck/horn pitches below). */
export function makeBoxConePart(
  color: Color3, rots: Rot[],
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  segments = 6, material: number = MAT.FUR,
): Part {
  const cx = (x0 + x1) * 0.5, cz = (z0 + z1) * 0.5;
  const r = ((x1 - x0) + (z1 - z0)) * 0.25;
  const verts: number[] = [];
  cone(verts, cx, y0, cz, r, y1 - y0, segments, true);
  return { verts, color, material, rots };
}

/**
 * Cone along Z filling a box's bounds — base at z1 (near the head), point
 * at z0 (forward tip) — for forward-pointing beaks. mesh-utils' cone() only
 * builds along +Y, so this builds one locally and re-projects it with the
 * same rotation formula pitch() uses at a = -90°: (x,y,z) → (x, z, -y),
 * which is a proper (determinant +1) rotation, so winding/outward-normal-
 * ness survives unchanged.
 */
export function makeBoxConePartZ(
  color: Color3, rots: Rot[],
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  segments = 6, material: number = MAT.FUR,
): Part {
  const cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5;
  const r = ((x1 - x0) + (y1 - y0)) * 0.25;
  const tmp: number[] = [];
  cone(tmp, 0, 0, 0, r, z1 - z0, segments, true);
  const verts: number[] = [];
  for (let i = 0; i < tmp.length; i += 6) {
    const lx = tmp[i], ly = tmp[i + 1], lz = tmp[i + 2];
    const lnx = tmp[i + 3], lny = tmp[i + 4], lnz = tmp[i + 5];
    verts.push(cx + lx, cy + lz, z1 - ly, lnx, lnz, -lny);
  }
  return { verts, color, material, rots };
}

/**
 * Double-sided quad: both windings, opposed normals. The character render
 * pipeline culls back faces, so a single-winding flat sheet is invisible
 * from one side — confirmed on dragon/griffin wing membranes, griffin
 * feather panels + tail fin, and bird wings (RECTIFICATION_PLAN §5.3: "a
 * dragon flying overhead has transparent wings"). Local to this file
 * rather than mesh-utils.ts — reuses the shared quad() twice rather than
 * duplicating it.
 */
export function quad2(verts: number[], a: P3, b: P3, c: P3, d: P3): void {
  quad(verts, a, b, c, d);
  quad(verts, d, c, b, a); // reverse winding, opposite normal
}

/** Flat quad filling a box's X/Z footprint at its mid-Y, facing +Y —
 * double-sided (quad2) — for panels thin along Y (dragon/griffin wing
 * membranes and feather panels, griffin tail fin). */
export function makeFlatQuadPart(
  color: Color3, rots: Rot[],
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  material: number = MAT.FUR,
): Part {
  const y = (y0 + y1) * 0.5;
  const verts: number[] = [];
  const a: P3 = [x0, y, z0], b: P3 = [x0, y, z1], c: P3 = [x1, y, z1], d: P3 = [x1, y, z0];
  quad2(verts, a, b, c, d);
  return { verts, color, material, rots };
}

/**
 * A continuous wing surface, built from a spanwise list of stations.
 *
 * Wings used to be a stack of independent `makeFlatQuadPart` rectangles, each
 * with its own roll and sweep in its own rotation chain. From above, the
 * griffin's wing was visibly a row of DISCONNECTED rectangles with daylight
 * between them and a staircase for an outline — because two neighbouring
 * panels rotated about the same pivot by different angles cannot share an
 * edge, however carefully their spans are overlapped.
 *
 * A station is `[x, y, zLead, zTrail]`. Consecutive stations are joined by a
 * double-sided quad, so the surface is continuous by construction and the
 * PLANFORM — taper, sweep, the raked tip — lives in the geometry where it
 * belongs, leaving the rotation chain to do nothing but flap. Splitting a wing
 * into several coloured parts is free: give them a shared station and the seam
 * is exact.
 *
 * 12 verts per panel, the same as the quads it replaces.
 */
export function makeWingPart(
  color: Color3, rots: Rot[],
  stations: readonly (readonly [number, number, number, number])[],
  material: number = MAT.FUR,
): Part {
  const verts: number[] = [];
  for (let i = 0; i + 1 < stations.length; i++) {
    const [x0, y0, l0, t0] = stations[i];
    const [x1, y1, l1, t1] = stations[i + 1];
    quad2(verts, [x0, y0, l0], [x0, y0, t0], [x1, y1, t1], [x1, y1, l1]);
  }
  return { verts, color, material, rots };
}

/**
 * An ear: a flattened blade of an ellipsoid, splayed outward and raked back.
 *
 * Ears were flat axis-aligned boxes on every species except the wolf, and they
 * were the loudest wrong note on the whole roster. A box has no silhouette from
 * the front (a cow's read as two dark rectangles pasted on the skull) and from
 * the side it collapses to a single black bar (the rabbit's). Worse, they all
 * pointed straight up: a cow's ears stick out SIDEWAYS, a bear's are round
 * buttons on top of the crown, a deer's are big outward-facing scoops. Ear
 * angle is a bigger species cue than ear size.
 *
 * Built upright from (`cx`, `cy`, `cz`) — `cx` already signed for the side —
 * with half-width `w`, height `h`, half-depth `d`; then rolled `splay` radians
 * outward about its own root and pitched `rake` radians back. The rotations go
 * on the front of `rots` so the head's own yaw still applies outside them.
 *
 * 108 verts at 6x4, against 36 for the box it replaces: the cheapest place on
 * the whole animal to buy species identity.
 */
export function makeEarPart(
  color: Color3, rots: Rot[], side: -1 | 1,
  cx: number, cy: number, cz: number,
  w: number, h: number, d: number,
  splay: number, rake: number,
  material: number = MAT.SKIN,
): Part {
  const p = makeBoxSpherePart(color,
    [rollZ(-side * splay, cx, cy), pitch(rake, cy, cz), ...rots],
    cx - w, cy, cz - d, cx + w, cy + h, cz + d, 1, 6, 4, material);
  return p;
}

/**
 * A pair of eyes — small dark spheres set into the sides of a muzzle-forward
 * skull, `set` metres apart, at (`y`, `z`).
 *
 * Cheap (60 verts each at 5x3) and worth more than any other 120 verts on the
 * model: these are wool dolls, and a doll without eyes reads as a sack. Every
 * quadruped, the bird, the griffin and the serpent had none.
 */
export function makeEyeParts(
  color: Color3, rots: Rot[],
  set: number, y: number, z: number, r: number,
  material: number = MAT.LEATHER,
): Part[] {
  const out: Part[] = [];
  for (const side of [-1, 1] as const) {
    const cx = side * set;
    out.push(makeBoxSpherePart(color, rots,
      cx - r, y - r, z - r, cx + r, y + r, z + r, 1, 5, 3, material));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Color palettes
// ---------------------------------------------------------------------------

/** Shift a color component by a small amount for colorVariant tinting. */
export function tint(base: Color3, dr: number, dg: number, db: number): Color3 {
  return [
    Math.min(1, Math.max(0, base[0] + dr)),
    Math.min(1, Math.max(0, base[1] + dg)),
    Math.min(1, Math.max(0, base[2] + db)),
  ];
}

/**
 * Four variant offsets applied to base color (variant 0 = base).
 *
 * Every shift must keep the coat inside the natural range, which means
 * preserving the R >= G >= B ordering that all mammal browns and greys share.
 * Variant 3 used to be [+0.04, -0.04, +0.06] — red and blue UP while green
 * came DOWN — which is the recipe for magenta: it rendered the grey wolf
 * lilac and the bay horse salmon pink. A quarter of every species was
 * spawning in a colour no animal has ever been.
 *
 * The replacement varies along the axis real coats actually vary on: ruddy
 * versus ashen, at constant lightness.
 */
export const VARIANT_SHIFTS: [number, number, number][] = [
  [0, 0, 0],             // 0: base
  [0.08, 0.06, 0.04],    // 1: lighter, slightly warmer
  [-0.06, -0.05, -0.04], // 2: darker
  [0.07, 0.02, -0.05],   // 3: ruddier — redder without leaving the browns
];

export function applyVariant(base: Color3, variant: number): Color3 {
  const [dr, dg, db] = VARIANT_SHIFTS[variant & 3];
  return tint(base, dr, dg, db);
}

// Base palette per species (main body color)
export const BASE_COLORS: Record<Species, Color3> = {
  // Warmed from [0.80 0.75 0.68]. That near-neutral cream put the rabbit in the
  // same value/hue bracket as the cow's white hide, so at distance the two
  // smallest and largest herbivores read as the same pale blob. A buff-brown
  // back against the unchanged white belly and tail puff is the cottontail
  // pattern and separates them instantly.
  rabbit:     [0.70, 0.60, 0.48],
  deer:       [0.68, 0.50, 0.28],
  bird:       [0.30, 0.55, 0.82],
  horse:      [0.45, 0.32, 0.20],
  cow:        [0.88, 0.85, 0.80],
  donkey:     [0.58, 0.52, 0.44],
  wolf:       [0.42, 0.40, 0.38], // warmed off pure steel-grey — §5.1: near-achromatic read as a "grey blob"
  bear:       [0.38, 0.26, 0.16], // dark brown
  dragon:     [0.65, 0.18, 0.18], // dark crimson body
  // Cold steel blue. Deliberately NOT a hue-shift of the dragon: the two are
  // the same silhouette family at a glance, so colour is doing most of the
  // species identification and it has to be unambiguous at 100 m.
  wyvern:     [0.24, 0.42, 0.68],
  griffin:    [0.72, 0.60, 0.28],
  sea_serpent:[0.18, 0.52, 0.48],
  // --- dungeon enemies ---
  // Sallow olive rather than comic-book lime: it has to hold up under a torch,
  // which is warm and low, and a saturated green goes fluorescent there.
  goblin:      [0.36, 0.44, 0.24],
  // The archer is a shade greyer and cooler so a mixed room reads as two
  // kinds of goblin at a glance rather than as one kind with a bow.
  goblin_archer: [0.33, 0.42, 0.29],
  // Pale knitted bone. MAT.BONE has tint weight 0.25, so the baked bone
  // texture does most of the work and these numbers only nudge it — which is
  // why the variant shifts read as subtle here and obvious on a furred animal.
  skeleton:    [0.84, 0.80, 0.70],
  // Blackened iron. Almost value alone: the gold and the emissive eyes are
  // the only chroma on him, and they need somewhere dark to sit.
  dread_king:  [0.20, 0.20, 0.24],
};

// Secondary color (belly / lighter underside)
export const BELLY_COLORS: Record<Species, Color3> = {
  rabbit:     [0.92, 0.90, 0.86],
  deer:       [0.85, 0.72, 0.50],
  bird:       [0.90, 0.90, 0.88],
  horse:      [0.55, 0.42, 0.30],
  // Piebald patch. Deepened once to [0.42 0.24 0.16] and the cow still read
  // white and sheep-ish at any distance: mid-brown against a 0.85-value hide is
  // barely a value step once the sun is on it, and the markings are most of a
  // cow's identity. Taken to a dark chocolate that holds its contrast in shade.
  cow:        [0.19, 0.13, 0.11],
  donkey:     [0.72, 0.68, 0.58],
  wolf:       [0.72, 0.73, 0.75], // light grey muzzle/underside
  bear:       [0.48, 0.35, 0.22],
  dragon:     [0.45, 0.10, 0.10], // darker underbelly
  wyvern:     [0.62, 0.76, 0.86], // pale frost belly — countershaded, not darker
  griffin:    [0.60, 0.48, 0.20],
  sea_serpent:[0.24, 0.68, 0.62],
  // --- dungeon enemies ---
  goblin:       [0.47, 0.52, 0.30], // paler gut and jaw
  goblin_archer:[0.44, 0.50, 0.34],
  skeleton:     [0.10, 0.09, 0.09], // eye sockets — a hole, not a bead
  dread_king:   [0.30, 0.06, 0.10], // deep blood-red cape
};

// Accent color (eyes, antler, beak, horns, claws, wing membrane, ridge)
export const ACCENT_COLORS: Record<Species, Color3> = {
  rabbit:     [0.12, 0.08, 0.08],
  deer:       [0.30, 0.20, 0.10],
  bird:       [0.90, 0.70, 0.10],
  horse:      [0.20, 0.15, 0.08],
  cow:        [0.20, 0.15, 0.08],
  donkey:     [0.22, 0.18, 0.12],
  wolf:       [0.16, 0.16, 0.18], // near-black ears / tail tip
  bear:       [0.16, 0.11, 0.07],
  dragon:     [0.20, 0.08, 0.06], // near-black horns / ridge / membrane
  wyvern:     [0.86, 0.93, 0.99], // near-white ice horn, spines and talons
  griffin:    [0.88, 0.72, 0.18],
  sea_serpent:[0.10, 0.30, 0.28],
  // --- dungeon enemies ---
  goblin:       [0.14, 0.09, 0.07], // eyes, nose
  goblin_archer:[0.14, 0.09, 0.07],
  skeleton:     [0.42, 0.34, 0.26], // rusted iron
  dread_king:   [0.92, 0.74, 0.26], // crown, trim, crossguard
};

// ---------------------------------------------------------------------------
// Mesh assembly: transform parts to interleaved Float32Array
// ---------------------------------------------------------------------------

/**
 * Scratch for the composed per-part transform: a 3x3 rotation `m` plus a
 * translation `t`, so a posed vertex is `m * v + t`.
 *
 * Module-level and reused: assembleParts runs for every visible creature every
 * frame, and allocating even two small arrays per part would hand the GC a few
 * thousand objects a second for nothing.
 */
export const _m = new Float64Array(9);
export const _t = new Float64Array(3);

/**
 * Collapse a part's rotation chain into one matrix.
 *
 * A rotation of angle `a` about an axis through pivot `c` is
 * `p' = R(p - c) + c = R p + (c - R c)`, so composing chain element `k` onto
 * an accumulated `(M, t)` gives `M <- R_k M` and `t <- R_k t + (c_k - R_k c_k)`.
 *
 * Why bother: the previous version re-applied every rotation to every vertex
 * individually, so a part's cost scaled with chain depth. That was tolerable
 * when limbs were a single capsule on a one-deep chain, but three-segment legs
 * put the cannon on a three-deep chain AND tripled the leg vertex count — a
 * roughly ninefold increase in transform work per leg, which dropped the
 * creature-heavy scene from 60 fps to 15. Composing once per part makes the
 * inner loop a fixed two 3x3 multiplies regardless of depth.
 */
export function composeChain(rots: Rot[], ys: number, yc: number): void {
  // Identity. The whole-body yaw is applied at the END, because it is the
  // OUTERMOST transform — the chain poses the creature in its own space and
  // the yaw then turns the finished creature. Seeding the accumulator with the
  // yaw instead would make it innermost, which silently rotates every joint
  // pivot along with the body and skews the whole pose.
  _m[0] = 1; _m[1] = 0; _m[2] = 0;
  _m[3] = 0; _m[4] = 1; _m[5] = 0;
  _m[6] = 0; _m[7] = 0; _m[8] = 1;
  _t[0] = 0; _t[1] = 0; _t[2] = 0;

  // Chain is authored child-first, so apply it outward: each successive
  // rotation is a PARENT and therefore pre-multiplies.
  for (let k = 0; k < rots.length; k++) {
    const r = rots[k];
    if (r.a === 0) continue;
    const s = Math.sin(r.a), c = Math.cos(r.a);

    // R as three rows, and the pivot. For a rotation about an axis, offsetting
    // the pivot along that axis has no effect, so the free component is 0.
    let r00: number, r01: number, r02: number;
    let r10: number, r11: number, r12: number;
    let r20: number, r21: number, r22: number;
    let cx: number, cy: number, cz: number;
    if (r.ax === 0) {        // pitch about X through (y=p0, z=p1)
      r00 = 1; r01 = 0; r02 = 0;
      r10 = 0; r11 = c; r12 = -s;
      r20 = 0; r21 = s; r22 = c;
      cx = 0; cy = r.p0; cz = r.p1;
    } else if (r.ax === 1) { // twist about Y through (x=p0, z=p1)
      r00 = c; r01 = 0; r02 = -s;
      r10 = 0; r11 = 1; r12 = 0;
      r20 = s; r21 = 0; r22 = c;
      cx = r.p0; cy = 0; cz = r.p1;
    } else {                 // roll about Z through (x=p0, y=p1)
      r00 = c; r01 = -s; r02 = 0;
      r10 = s; r11 = c;  r12 = 0;
      r20 = 0; r21 = 0;  r22 = 1;
      cx = r.p0; cy = r.p1; cz = 0;
    }

    // M <- R M
    const m0 = _m[0], m1 = _m[1], m2 = _m[2];
    const m3 = _m[3], m4 = _m[4], m5 = _m[5];
    const m6 = _m[6], m7 = _m[7], m8 = _m[8];
    _m[0] = r00 * m0 + r01 * m3 + r02 * m6;
    _m[1] = r00 * m1 + r01 * m4 + r02 * m7;
    _m[2] = r00 * m2 + r01 * m5 + r02 * m8;
    _m[3] = r10 * m0 + r11 * m3 + r12 * m6;
    _m[4] = r10 * m1 + r11 * m4 + r12 * m7;
    _m[5] = r10 * m2 + r11 * m5 + r12 * m8;
    _m[6] = r20 * m0 + r21 * m3 + r22 * m6;
    _m[7] = r20 * m1 + r21 * m4 + r22 * m7;
    _m[8] = r20 * m2 + r21 * m5 + r22 * m8;

    // t <- R t + (c - R c)
    const t0 = _t[0], t1 = _t[1], t2 = _t[2];
    _t[0] = r00 * t0 + r01 * t1 + r02 * t2 + cx - (r00 * cx + r01 * cy + r02 * cz);
    _t[1] = r10 * t0 + r11 * t1 + r12 * t2 + cy - (r10 * cx + r11 * cy + r12 * cz);
    _t[2] = r20 * t0 + r21 * t1 + r22 * t2 + cz - (r20 * cx + r21 * cy + r22 * cz);
  }

  // Finally the whole-body yaw about Y through the origin — pivot-less, so it
  // is a plain pre-multiplication of both the matrix and the translation.
  const y0 = _m[0], y1 = _m[1], y2 = _m[2];
  const y6 = _m[6], y7 = _m[7], y8 = _m[8];
  _m[0] = yc * y0 - ys * y6;
  _m[1] = yc * y1 - ys * y7;
  _m[2] = yc * y2 - ys * y8;
  _m[6] = ys * y0 + yc * y6;
  _m[7] = ys * y1 + yc * y7;
  _m[8] = ys * y2 + yc * y8;
  const tx0 = _t[0], tz0 = _t[2];
  _t[0] = yc * tx0 - ys * tz0;
  _t[2] = ys * tx0 + yc * tz0;
}

export function assembleParts(
  parts: Part[], pose: AnimalPose, dst?: Float32Array,
): { verts: Float32Array; count: number } {
  const totalVerts = parts.reduce((n, p) => n + p.verts.length / 6, 0);
  // Write straight into the caller's buffer when it supplied one.
  //
  // This used to allocate unconditionally and the caller then COPIED the
  // result into its scratch buffer — so `buildAnimalMesh`'s `out` parameter,
  // which exists precisely to avoid per-frame allocation, avoided nothing and
  // added a memcpy on top. At ~5k vertices x 10 floats that is ~200 KB of
  // garbage per creature per rebuild, and with up to 30 creatures it was the
  // single largest allocator in the frame.
  const out = dst !== undefined && dst.length >= totalVerts * 10
    ? dst
    : new Float32Array(totalVerts * 10);
  const ys = Math.sin(pose.yaw);
  const yc = Math.cos(pose.yaw);
  let o = 0;
  for (const p of parts) {
    // The chain (child-first) then the whole-body yaw, collapsed to one
    // rotation + translation. Applying the yaw inside composeChain rather than
    // per-vertex afterwards keeps the inner loop free of special cases.
    composeChain(p.rots, ys, yc);
    const m0 = _m[0], m1 = _m[1], m2 = _m[2];
    const m3 = _m[3], m4 = _m[4], m5 = _m[5];
    const m6 = _m[6], m7 = _m[7], m8 = _m[8];
    const tx = _t[0], ty = _t[1], tz = _t[2];
    const cr = p.color[0], cg = p.color[1], cb = p.color[2];
    const mat = p.material;
    const src = p.verts;

    for (let i = 0; i < src.length; i += 6) {
      const x = src[i], y = src[i + 1], z = src[i + 2];
      const nx = src[i + 3], ny = src[i + 4], nz = src[i + 5];

      // Normals take the same rotation with the translation OMITTED — they are
      // directions, not points. The chain is pure rotation (no scale), so this
      // is exact; the re-normalize below only guards float drift.
      const rnx = m0 * nx + m1 * ny + m2 * nz;
      const rny = m3 * nx + m4 * ny + m5 * nz;
      const rnz = m6 * nx + m7 * ny + m8 * nz;
      const nlen = Math.hypot(rnx, rny, rnz) || 1;

      out[o]     = m0 * x + m1 * y + m2 * z + tx;
      out[o + 1] = m3 * x + m4 * y + m5 * z + ty;
      out[o + 2] = m6 * x + m7 * y + m8 * z + tz;
      out[o + 3] = rnx / nlen;
      out[o + 4] = rny / nlen;
      out[o + 5] = rnz / nlen;
      out[o + 6] = cr;
      out[o + 7] = cg;
      out[o + 8] = cb;
      out[o + 9] = mat;
      o += 10;
    }
  }
  return { verts: out, count: totalVerts };
}

