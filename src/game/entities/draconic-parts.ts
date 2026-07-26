/**
 * draconic-parts.ts — the shared anatomy kit for winged reptiles.
 *
 * The dragon and the wyvern are different ANIMALS (four legs plus wings versus
 * two legs where the wings *are* the forelimbs) but they are built from the
 * same tissue: bat-fingered wings with a scalloped, cambered membrane, a
 * tapering chain of a neck and tail, and a keratin spike ridge that runs from
 * the nose to the tail tip. This module holds that tissue so the two body
 * plans can differ where they should — in the skeleton — rather than by
 * copy-and-paste.
 *
 * WHY THE GEOMETRY IS COMPUTED IN EXPLICIT 3-SPACE HERE
 *
 * Every other body plan in the codebase authors a part inside an axis-aligned
 * box and then swings it into place with `Rot` chains, because that is the
 * cheapest way to express "a limb pitched about a hip". A wing is not that
 * shape of problem: a wing joint has TWO angular degrees of freedom (elevation
 * and sweep) and four of them stack, so expressing it as a rotation chain
 * needs eight nested `Rot`s per spar and puts every pivot in a rest space that
 * no longer means anything once the arm is half folded. Solving the joint
 * POSITIONS directly and drawing `taperedCapsule`s between them is both
 * shorter and exact, and it makes the fold pose a straight interpolation
 * between two sets of angles rather than eight coupled ones.
 *
 * Conventions match the rest of the creature pipeline exactly: local space
 * with the creature's base at y = 0, facing -Z at yaw 0, and every part's
 * `verts` an interleaved position+normal soup (6 floats/vertex) that
 * `assembleParts` later poses and colours.
 */

import { cone, taperedCapsule, type P3 } from '../mesh-utils';
import { MAT } from '../render/material-table';
import { quad2, type Color3, type Part, type Rot } from './creature-parts';

// ---------------------------------------------------------------------------
// Small vector helpers
// ---------------------------------------------------------------------------

export type Vec3 = [number, number, number];

export const v3 = (x: number, y: number, z: number): Vec3 => [x, y, z];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const mad = (a: Vec3, b: Vec3, k: number): Vec3 =>
  [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len3 = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export function norm(a: Vec3): Vec3 {
  const l = len3(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** Smoothstep on [0,1] — the easing every fold/spread blend here uses. */
export const smooth01 = (t: number): number => {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return u * u * (3 - 2 * u);
};

export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * A limb direction from an elevation and a sweep, mirrored for the side.
 *
 * `el` is the angle above the horizontal plane and `sw` the angle forward of
 * straight-out (positive = toward -Z, the facing direction). Sweeps past
 * ±pi/2 point the limb back across the body, which is exactly what a folded
 * wing needs and is the reason this is spherical rather than a pitch/roll
 * pair — a roll chain cannot reach behind itself without gimbal weirdness.
 */
export function dirSpherical(side: number, el: number, sw: number): Vec3 {
  const ce = Math.cos(el);
  return [side * ce * Math.cos(sw), Math.sin(el), -ce * Math.sin(sw)];
}

// ---------------------------------------------------------------------------
// Bones
// ---------------------------------------------------------------------------

/**
 * One tapered bone between two explicit points.
 *
 * `taperedCapsule` already accepts an arbitrary axis, so no `Rot` is needed;
 * the caller passes `rots` only when the whole assembly still has to swing
 * (the jaw, the yawing head).
 */
export function bonePart(
  color: Color3, rots: Rot[],
  a: Vec3, b: Vec3, r0: number, r1: number,
  segments = 6, material: number = MAT.SCALE,
): Part {
  const verts: number[] = [];
  taperedCapsule(verts, a[0], a[1], a[2], b[0], b[1], b[2], r0, r1, segments);
  return { verts, color, material, rots };
}

/**
 * Rotation taking +Y onto `d`, applied to a locally-built cone.
 *
 * `cone()` only builds along +Y, and the spikes on a curved spine/tail point
 * along the local surface normal, which is a different direction at every
 * vertebra. Rodrigues' rotation for the "shortest arc from a to b" case gives
 * a proper (determinant +1) rotation, so the cone's winding and outward
 * normals survive untouched — the same guarantee `makeBoxConePartZ` relies on
 * for its fixed 90-degree case, generalized.
 */
export function coneAlong(
  verts: number[], base: Vec3, dir: Vec3, r: number, length: number, segments = 5,
): void {
  const d = norm(dir);
  const tmp: number[] = [];
  cone(tmp, 0, 0, 0, r, length, segments, true);

  // v = (0,1,0) x d, c = (0,1,0) . d. R = I + [v]x + [v]x^2 / (1 + c).
  const c = d[1];
  let m0: number, m1: number, m2: number;
  let m3: number, m4: number, m5: number;
  let m6: number, m7: number, m8: number;
  if (c < -0.999999) {
    // Antiparallel: a half turn about X. det = +1, so winding is preserved.
    m0 = 1; m1 = 0; m2 = 0;
    m3 = 0; m4 = -1; m5 = 0;
    m6 = 0; m7 = 0; m8 = -1;
  } else {
    const vx = d[2], vz = -d[0];        // v = (d.z, 0, -d.x)
    const k = 1 / (1 + c);
    // [v]x with v = (vx, 0, vz)
    // [  0   -vz    0 ]        [ -vz^2      0     vx*vz ]
    // [ vz     0  -vx ]  sq =  [   0   -vx^2-vz^2   0   ]
    // [  0    vx    0 ]        [ vx*vz     0    -vx^2   ]
    m0 = 1 + (-vz * vz) * k;   m1 = -vz;                        m2 = (vx * vz) * k;
    m3 = vz;                   m4 = 1 + (-vx * vx - vz * vz) * k; m5 = -vx;
    m6 = (vx * vz) * k;        m7 = vx;                         m8 = 1 + (-vx * vx) * k;
  }

  for (let i = 0; i < tmp.length; i += 6) {
    const x = tmp[i], y = tmp[i + 1], z = tmp[i + 2];
    const nx = tmp[i + 3], ny = tmp[i + 4], nz = tmp[i + 5];
    verts.push(
      base[0] + m0 * x + m1 * y + m2 * z,
      base[1] + m3 * x + m4 * y + m5 * z,
      base[2] + m6 * x + m7 * y + m8 * z,
      m0 * nx + m1 * ny + m2 * nz,
      m3 * nx + m4 * ny + m5 * nz,
      m6 * nx + m7 * ny + m8 * nz,
    );
  }
}

/** A single spike/horn/claw pointing along `dir` from `base`. */
export function spikePart(
  color: Color3, rots: Rot[],
  base: Vec3, dir: Vec3, r: number, length: number,
  segments = 5, material: number = MAT.HORN,
): Part {
  const verts: number[] = [];
  coneAlong(verts, base, dir, r, length, segments);
  return { verts, color, material, rots };
}

/**
 * A run of spikes along a sampled curve — the nose-to-tail-tip ridge.
 *
 * Emitted as ONE part rather than one part per spike: they share a colour and
 * a material, and a part costs a matrix compose per frame for every creature
 * on screen. The ridge is the single most repeated element on a draconic body
 * plan, so this is worth doing once here.
 */
export function ridgePart(
  color: Color3, rots: Rot[],
  spikes: { base: Vec3; dir: Vec3; r: number; len: number }[],
  segments = 5, material: number = MAT.HORN,
): Part {
  const verts: number[] = [];
  for (const s of spikes) coneAlong(verts, s.base, s.dir, s.r, s.len, segments);
  return { verts, color, material, rots };
}

// ---------------------------------------------------------------------------
// Membrane
// ---------------------------------------------------------------------------

/**
 * A double-sided membrane patch stretched between two boundary curves.
 *
 * `inner(u)` and `outer(u)` return the two edges; the sheet fills between
 * them. Every panel of a wing is expressible this way — the sector between
 * two finger spars (inner collapses to the wrist), the sheet from the arm
 * down to the flank, the notch ahead of the elbow — which is why there is one
 * function here rather than three.
 *
 * `camber` bulges the interior along `camberDir` by `sin(pi u) sin(pi v)`, so
 * the displacement vanishes on all four boundaries and peaks in the middle.
 * That is what stretched hide does between its spars, and it is most of the
 * difference between a wing and a piece of paper: a flat quad shades to one
 * flat value (the exact defect that made the character torso read as a
 * rectangle pasted on the chest), whereas a cambered one gets a gradient and
 * catches a rim of light along the fold.
 *
 * Double-sided via `quad2`, because the render pipeline culls back faces and
 * a single-winding sheet is an invisible hole from below — "a dragon flying
 * overhead has transparent wings".
 */
export function membranePart(
  color: Color3, rots: Rot[],
  inner: (u: number) => Vec3,
  outer: (u: number) => Vec3,
  nSpan: number, nChord: number,
  camber: number, camberDir: Vec3,
  material: number = MAT.LEATHER,
): Part {
  const verts: number[] = [];
  const cd = camber !== 0 ? norm(camberDir) : ([0, 0, 0] as Vec3);

  // Cache the boundary samples: inner()/outer() do real work (slerp-ish
  // direction blends) and each is otherwise evaluated nChord+1 times over.
  const inPts: Vec3[] = [];
  const outPts: Vec3[] = [];
  for (let i = 0; i <= nSpan; i++) {
    const u = i / nSpan;
    inPts.push(inner(u));
    outPts.push(outer(u));
  }

  const at = (i: number, j: number): P3 => {
    const u = i / nSpan, v = j / nChord;
    const p = lerp3(inPts[i], outPts[i], v);
    if (camber !== 0) {
      const w = Math.sin(Math.PI * u) * Math.sin(Math.PI * v) * camber;
      return [p[0] + cd[0] * w, p[1] + cd[1] * w, p[2] + cd[2] * w];
    }
    return p as P3;
  };

  for (let i = 0; i < nSpan; i++) {
    for (let j = 0; j < nChord; j++) {
      quad2(verts, at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
    }
  }
  return { verts, color, material, rots };
}

// ---------------------------------------------------------------------------
// The wing
// ---------------------------------------------------------------------------

/** One wing joint's two angles, in the folded and the extended pose. */
export interface WingAngles {
  /** Elevation above horizontal: [folded, extended]. */
  el: [number, number];
  /** Sweep forward of straight-out: [folded, extended]. */
  sw: [number, number];
}

export interface WingSpec {
  /** Shoulder socket, right-hand side (mirrored for the left). */
  shoulder: Vec3;
  /** Where the inner membrane meets the flank, right-hand side. */
  hipAnchor: Vec3;
  humerusLen: number;
  forearmLen: number;
  /** Finger spar lengths, leading edge first. */
  fingerLen: number[];
  /** Per-finger sweep, [folded, extended]. */
  fingerSweep: [number, number][];
  /** Per-finger elevation, [folded, extended]. */
  fingerEl: [number, number][];
  humerus: WingAngles;
  forearm: WingAngles;
  /** Bone radii: [shoulder, elbow, wrist, finger root, finger tip]. */
  radii: [number, number, number, number, number];
  /**
   * Fraction of a finger's length still drawn when fully folded.
   *
   * A real bat folds by CURLING its fingers, which a straight capsule cannot
   * do. Shortening the drawn spar instead furls the membrane into the same
   * silhouette for two verts of cost — without it a folded 5.6 m spar sticks
   * out past the tail tip, which looks far worse than the approximation.
   */
  foldSpar: number;
  /** Membrane bulge between spars, as a fraction of the local chord. */
  camber: number;
  /** How far the trailing edge bows back toward the wrist between spars. */
  scallop: number;
}

export interface WingColors {
  bone: Color3;
  membrane: Color3;
  claw: Color3;
}

/**
 * Build one wing.
 *
 * `spread` is 0 when the wing is furled against the body and 1 when it is
 * fully out; `beat` is the signed flap displacement already scaled by its own
 * amplitude, and is only applied once the wing is open (a folded wing that
 * still flaps looks like a twitch).
 */
export function buildWing(
  side: number, spec: WingSpec, colors: WingColors, spread: number, beat: number,
): Part[] {
  const t = smooth01(spread);
  const parts: Part[] = [];
  const [rSh, rElb, rWr, rF0, rF1] = spec.radii;

  const shoulder: Vec3 = [side * spec.shoulder[0], spec.shoulder[1], spec.shoulder[2]];
  const hip: Vec3 = [side * spec.hipAnchor[0], spec.hipAnchor[1], spec.hipAnchor[2]];

  // Arm. The beat drives the humerus hardest and the outer spars least, with
  // a lag down the limb: a wing that pivots rigidly about the shoulder reads
  // as a hinged board, whereas a tip that arrives late reads as a surface
  // being pushed against air.
  const hEl = mix(spec.humerus.el[0], spec.humerus.el[1], t) + beat * t * 0.55;
  const hSw = mix(spec.humerus.sw[0], spec.humerus.sw[1], t);
  const elbow = mad(shoulder, dirSpherical(side, hEl, hSw), spec.humerusLen);

  const fEl = mix(spec.forearm.el[0], spec.forearm.el[1], t) + beat * t * 0.40;
  const fSw = mix(spec.forearm.sw[0], spec.forearm.sw[1], t);
  const wrist = mad(elbow, dirSpherical(side, fEl, fSw), spec.forearmLen);

  parts.push(bonePart(colors.bone, [], shoulder, elbow, rSh, rElb, 6));
  parts.push(bonePart(colors.bone, [], elbow, wrist, rElb, rWr, 5));

  // Finger spars, fanned back from the wrist.
  const tips: Vec3[] = [];
  const dirs: Vec3[] = [];
  const lens: number[] = [];
  for (let i = 0; i < spec.fingerLen.length; i++) {
    const el = mix(spec.fingerEl[i][0], spec.fingerEl[i][1], t) + beat * t * 0.26;
    const sw = mix(spec.fingerSweep[i][0], spec.fingerSweep[i][1], t);
    const d = dirSpherical(side, el, sw);
    const l = spec.fingerLen[i] * mix(spec.foldSpar, 1, t);
    dirs.push(d);
    lens.push(l);
    tips.push(mad(wrist, d, l));
    parts.push(bonePart(colors.bone, [], wrist, tips[i], rF0, rF1, i < 2 ? 4 : 3));
  }

  // Wing claw on the leading knuckle — the hook a wyvern walks on and a
  // dragon grapples with. Tiny, and it is what stops the wrist reading as a
  // bare joint where three bones happen to meet.
  parts.push(spikePart(colors.claw, [], wrist,
    norm(add(dirs[0], [0, 0.45, 0])), rF0 * 1.15, spec.humerusLen * 0.20, 4));

  // Membrane normal, used for camber. Taken from the first two spars and
  // forced downward so the sheet always sags away from the sky.
  let mn = norm(cross(dirs[1], dirs[0]));
  if (mn[1] > 0) mn = mul(mn, -1);

  // Sectors between consecutive finger spars, rooted at the wrist.
  for (let i = 0; i < dirs.length - 1; i++) {
    const dA = dirs[i], dB = dirs[i + 1];
    const lA = lens[i], lB = lens[i + 1];
    const outer = (u: number): Vec3 => {
      // The trailing edge bows back toward the wrist between the two spars —
      // the scallop that reads as a wing rather than a kite even in
      // silhouette, and the one detail the reference sheets all share.
      const d = norm(lerp3(dA, dB, u));
      const l = mix(lA, lB, u) * (1 - spec.scallop * Math.sin(Math.PI * u));
      return mad(wrist, d, l);
    };
    parts.push(membranePart(colors.membrane, [],
      () => wrist, outer, 3, 2,
      spec.camber * Math.min(lA, lB), mn));
  }

  // Propatagium: the notch ahead of the arm, from the shoulder-to-wrist chord
  // forward to the elbow. Small, and it is what turns the leading edge from a
  // straight rod into an aerofoil.
  parts.push(membranePart(colors.membrane, [],
    (u) => lerp3(shoulder, wrist, u),
    (u) => {
      const chord = lerp3(shoulder, wrist, u);
      const bow = Math.sin(Math.PI * u);
      return lerp3(chord, elbow, bow * 0.85);
    },
    2, 1, 0, mn));

  // Plagiopatagium: arm and last finger on one edge, the flank on the other.
  // This is the panel that makes the wing read as part of the ANIMAL — the
  // old build had the membrane floating between the finger spars only, so
  // from above the dragon was a body with two detached fans beside it.
  const lastD = dirs[dirs.length - 1], lastL = lens[lens.length - 1];
  parts.push(membranePart(colors.membrane, [],
    (u) => lerp3(shoulder, hip, u),
    (u) => {
      if (u <= 0.35) return lerp3(shoulder, elbow, u / 0.35);
      if (u <= 0.62) return lerp3(elbow, wrist, (u - 0.35) / 0.27);
      return mad(wrist, lastD, lastL * ((u - 0.62) / 0.38));
    },
    4, 2, spec.camber * lastL * 0.8, mn));

  return parts;
}

// ---------------------------------------------------------------------------
// Chains (neck, tail)
// ---------------------------------------------------------------------------

export interface ChainSample {
  /** Joint centres, root first. */
  pts: Vec3[];
  /** Radius at each joint. */
  radii: number[];
  /** Unit tangent at each joint. */
  tangents: Vec3[];
  /** Unit "up" (dorsal) direction at each joint — where the ridge sits. */
  ups: Vec3[];
}

/**
 * Sample a swept chain — the neck and the tail are the same object twice.
 *
 * The path is a cubic Bezier so the curve is authored by where it STARTS and
 * ENDS and how it leaves each, which is how a neck is actually described
 * ("out of the chest, up, then forward and down into the skull"). The old
 * build chained capsules by accumulating a per-segment lean, which cannot
 * express an S because each link only knows its own angle; it produced a
 * neck that rose to vertical and stopped, i.e. a periscope.
 *
 * `sway` adds a travelling wave in X so a tail lashes and a neck drifts;
 * amplitude grows along the chain so the root stays put and the tip carries
 * the motion.
 */
export function sampleChain(
  p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3,
  segs: number,
  r0: number, r1: number,
  swayAmp: number, swayPhase: number, swayWaves: number,
): ChainSample {
  const pts: Vec3[] = [];
  const radii: number[] = [];
  const bez = (t: number): Vec3 => {
    const s = 1 - t;
    const a = s * s * s, b = 3 * s * s * t, c = 3 * s * t * t, d = t * t * t;
    return [
      a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
      a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
      a * p0[2] + b * p1[2] + c * p2[2] + d * p3[2],
    ];
  };
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const p = bez(t);
    if (swayAmp !== 0) {
      p[0] += Math.sin(swayPhase + t * Math.PI * 2 * swayWaves) * swayAmp * t * t;
    }
    pts.push(p);
    // Cubic falloff on the radius: a neck or tail that tapers linearly still
    // reads as a cone. Real ones hold their girth out of the body and then
    // give it up quickly.
    radii.push(mix(r0, r1, t * t * (3 - 2 * t)));
  }

  const tangents: Vec3[] = [];
  const ups: Vec3[] = [];
  for (let i = 0; i <= segs; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(segs, i + 1)];
    const tg = norm(sub(b, a));
    tangents.push(tg);
    // Dorsal direction: world up, made perpendicular to the tangent. Where
    // the chain is vertical (the base of a rearing neck) that degenerates, so
    // fall back to -Z, which is the direction the animal faces.
    let up = sub([0, 1, 0], mul(tg, tg[1]));
    if (len3(up) < 1e-3) up = norm(sub([0, 0, -1], mul(tg, -tg[2])));
    ups.push(norm(up));
  }
  return { pts, radii, tangents, ups };
}

/** Draw a sampled chain as tapered bones. */
export function chainBones(
  chain: ChainSample, color: Color3, rots: Rot[],
  segments: number[] | number, material: number = MAT.SCALE,
): Part[] {
  const parts: Part[] = [];
  for (let i = 0; i < chain.pts.length - 1; i++) {
    const seg = typeof segments === 'number' ? segments : segments[i];
    parts.push(bonePart(color, rots,
      chain.pts[i], chain.pts[i + 1], chain.radii[i], chain.radii[i + 1], seg, material));
  }
  return parts;
}

/**
 * Spikes seated on a chain's dorsal line.
 *
 * Seated on the SURFACE (centre + up * radius * 0.9), not on the joint
 * centre: a spike placed at the axis floats out of the middle of the limb
 * rather than growing from its back, which is the same bounding-box-versus-
 * inscribed-surface trap that has bitten tails, ears and leg roots here
 * before, one dimension down.
 */
export function chainRidge(
  chain: ChainSample, color: Color3, rots: Rot[],
  from: number, to: number, step: number,
  height: (t: number) => number, widthFrac: number,
  lean = 0.30, segments = 5,
): Part {
  const spikes: { base: Vec3; dir: Vec3; r: number; len: number }[] = [];
  const n = chain.pts.length - 1;
  for (let i = from; i <= to; i += step) {
    const t = i / n;
    const up = chain.ups[i];
    const tg = chain.tangents[i];
    const r = chain.radii[i];
    const h = height(t);
    if (h <= 1e-4) continue;
    spikes.push({
      base: mad(chain.pts[i], up, r * 0.85),
      // Raked back along the chain — a spike standing dead vertical on a
      // curved neck reads as a fencepost.
      dir: norm(mad(up, tg, -lean)),
      r: Math.max(1e-3, r * widthFrac),
      len: h,
    });
  }
  return ridgePart(color, rots, spikes, segments);
}

// ---------------------------------------------------------------------------
// Tail fin
// ---------------------------------------------------------------------------

/**
 * The vertical blade at the tail tip — a keratin fin, so it takes HORN rather
 * than the membrane's LEATHER.
 */
export function tailFinPart(
  color: Color3, rots: Rot[],
  chain: ChainSample, fromT: number, height: number, material: number = MAT.HORN,
): Part {
  const n = chain.pts.length - 1;
  const i0 = Math.round(fromT * n);
  const axis = (u: number): Vec3 => {
    const f = i0 + (n - i0) * u;
    const i = Math.min(n - 1, Math.floor(f));
    return lerp3(chain.pts[i], chain.pts[i + 1], f - i);
  };
  const upAt = (u: number): Vec3 => {
    const f = i0 + (n - i0) * u;
    return chain.ups[Math.min(n, Math.round(f))];
  };
  return membranePart(color, rots,
    axis,
    // Leaf profile: rises fast off the tail, peaks two-thirds along, and
    // comes to a point at the tip.
    (u) => mad(axis(u), upAt(u), height * Math.sin(Math.PI * Math.pow(u, 0.65))),
    4, 1, 0, [0, 1, 0], material);
}
