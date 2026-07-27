/**
 * Tintreach bolt VFX — the lightning arrow, drawn as a stitched seam of light.
 *
 * WHY THERE IS NO NEW PIPELINE HERE
 * A bolt is a set of bright additive billboards stretched along their own axis,
 * which is exactly what `FireFX` already is: no vertex buffer (the quad comes
 * from `vertex_index`), one storage buffer, one `draw(6, n)`, additive into the
 * HDR target before post so it feeds bloom, depth-TESTED and never depth-writing.
 * Building a second copy of that would have meant a second pipeline, a second
 * bind group set, a second render pass in `renderer.ts` and — the part that
 * actually bites — a decision about a shadow pipeline. Riding FireFX means the
 * answer to "what shadow pipeline does this need" is the same as the flames':
 * NONE, and for the same reason, which is that there is no vertex layout to key
 * one off. An emissive bolt that cast a shadow would be a bug anyway.
 *
 * THE LOOK — the deliberate decision, stated once.
 * This world is knitted (project_art_direction_yarn); the bow's own reticle is
 * running-stitch dashes around a knot in thread-cream. So the bolt is not a
 * shooter's blue-white plasma arc. It is a SEAM: a couched thread of light
 * stitched from the bow to the mark in four layers —
 *
 *   0 GLOW  a wide, soft woad-indigo wash. Indigo is a dye; it also happens to
 *           be what electricity looks like. This layer is what gives the bloom
 *           chain area to work with — a hairline has almost none, which is the
 *           lesson the wyvern's spark spray already paid for.
 *   1 HALO  a narrower linen-white sheath with visible fibre striation, so the
 *           seam has loose wool round it rather than an aliased edge.
 *   2 CORE  the running stitch itself: short thread-cream DASHES with gaps,
 *           each one bulging and pinching along its length like plied yarn.
 *           The gaps are geometric, not shader tricks — two dashes per segment.
 *   3 KNOT  a French knot where the seam kinks, and a burst of them where it
 *           lands. Six loose fibres radiate from each, the same motif as the
 *           knot in the middle of the reticle.
 *
 * Colours are authored at ABSURD HDR values (the core sits near 48). That is
 * not a mistake: `applyTintreachPost` pulls the whole frame's exposure down to
 * ~0.32 while the bolt burns, and the core has to still clip to white after
 * that multiply and after ACES. Author it at 1.0 and the "blinding" flash goes
 * grey the moment the dip lands.
 *
 * WIDTHS ARE ANGULAR, NOT WORLD-SPACE. A 7 cm world-space core is four pixels
 * at the bow and less than one at 50 m, and a sub-pixel additive line scintillates
 * and reads as dim. Scaling the half-width by distance-to-eye keeps the seam a
 * constant thickness on screen, which is both what lightning looks like and
 * what a stitched line should look like.
 */

import {
  currentBolt, boltIntensity, strikePhase, boltPath, boltBranches,
  makeBranchBuffer, BOLT_POINTS, BRANCH_POINTS,
} from '../tintreach';
import type { FireFX } from './fire-fx';

/**
 * Hard cap on billboards one bolt may queue. The real figure is ~210; this is
 * the guard, and it exists because FireFX's own buffer overrun does not glitch,
 * it turns the whole frame black.
 */
export const BOLT_MAX_INSTANCES = 320;

/** Layer codes — must match the `lv` switch in flame.wgsl's bolt branch. */
export const BOLT_GLOW = 0;
export const BOLT_HALO = 1;
export const BOLT_CORE = 2;
export const BOLT_KNOT = 3;

/**
 * Half-width in radians of eye angle, per layer.
 *
 * THE RATIOS ARE THE WHOLE LOOK, and the first pass got them badly wrong: at
 * glow 0.045 / halo 0.014 / core 0.0042 the wash was ten times the width of the
 * stitch, thirty-two overlapping segments of it summed additively, and the
 * bloom chain smeared the result into a white column with no seam visible
 * anywhere inside it. It read as a beam of light, not as lightning, and
 * certainly not as thread. The core has to be the brightest thing per unit
 * area AND the glow has to carry less total energy than it does — which, since
 * additive energy goes with AREA, means the wide layers have to be very dim.
 */
const ANG_GLOW = 0.020;
const ANG_HALO = 0.0082;
const ANG_CORE = 0.0042;
const ANG_KNOT = 0.0068;
/** Floors, so a bolt fired into a wall two metres away is still a bolt. */
const MIN_GLOW = 0.12;
const MIN_HALO = 0.05;
const MIN_CORE = 0.035;
const MIN_KNOT = 0.075;

/**
 * HDR brightness per layer, before the intensity envelope.
 *
 * Still absurd by scene standards (the world sits near 1.0) because the flash
 * pulls exposure to ~0.2 and the core has to clip to white after that AND after
 * ACES: 26 × 0.23 = 6.0, and ACES(6.0) is 0.94. Any lower and the "blinding"
 * bolt goes grey exactly when the screen goes dark.
 */
const PWR_GLOW = 0.55;
const PWR_HALO = 4.0;
const PWR_CORE = 32.0;
const PWR_KNOT = 30.0;

/** Reused across frames — this emitter must never allocate. */
const mainPath = new Float32Array(BOLT_POINTS * 3);
/** The PREVIOUS re-strike's channel, kept as a dimmer ghost. */
const ghostPath = new Float32Array(BOLT_POINTS * 3);
const branchPath = new Float32Array(BRANCH_POINTS * 3);
const branches = makeBranchBuffer();
/** Which (shot, re-strike) the cached path belongs to. -1 = nothing cached. */
let cachedShot = -1;
let cachedPhase = -1;

/** Deterministic 0..1 — same shape as the one in fire-fx.ts. */
function hash01(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

/**
 * Queue the live bolt's billboards. No-op when nothing is burning, which is
 * >99% of frames, so the early return is the whole cost most of the time.
 *
 * `eye` is the camera position: widths are angular (see the header), so every
 * segment needs its own distance.
 */
export function emitTintreachBolt(
  fx: FireFX, nowS: number, eye: readonly number[],
): void {
  const bolt = currentBolt();
  if (bolt === null) return;
  const e = boltIntensity(nowS);
  if (e <= 0.012) return;

  const phase = strikePhase(nowS);
  if (bolt.shot !== cachedShot || phase !== cachedPhase) {
    cachedShot = bolt.shot;
    cachedPhase = phase;
    // 5.5% lateral spread. Seeded from (shot, re-strike) so the seam moves
    // between strikes but the same shot always draws the same set of seams.
    boltPath(mainPath, BOLT_POINTS, (bolt.shot * 977 + phase) | 0,
      bolt.from, bolt.to, 0.085);
    boltBranches(branches, mainPath, BOLT_POINTS, (bolt.shot * 61 + phase) | 0);
    // The channel the previous re-strike took, kept as a dim second seam. Real
    // lightning is several channels at once and a single crisp line is the one
    // thing that always reads as computer graphics; this is the cheapest way to
    // buy the "many threads, one strike" look — one extra halo pass, no extra
    // state, and it comes free from the deterministic path function.
    boltPath(ghostPath, BOLT_POINTS,
      (bolt.shot * 977 + Math.max(0, phase - 1)) | 0, bolt.from, bolt.to, 0.085);
  }

  const ex = eye[0], ey = eye[1], ez = eye[2];
  const dist = (x: number, y: number, z: number): number =>
    Math.hypot(x - ex, y - ey, z - ez);

  // Budget guard. `remaining` is decremented by every emitter below and the
  // whole thing stops dead when it runs out — bounded, and swept by the
  // 160 m sky shot in scripts/tintreach-check.mjs rather than reasoned about.
  let remaining = BOLT_MAX_INSTANCES;

  /**
   * One straight piece of seam, centred on its own midpoint.
   *
   * The `endOn` term is not a nicety. An axis-stretched billboard seen down its
   * own axis collapses to a square the size of its WIDTH (`halfUp = max(halfH *
   * |rl|, halfH * aspect)` in flame.wgsl), which is geometrically right — a line
   * pointed at your eye is a dot — but this bolt is thirty-two of them plus
   * their halos and glows, and additively they pile into one fat smooth wedge
   * with every kink swamped inside it. Shooting up at the sky produced exactly
   * that: a crisp forked bolt at the far end and a laser beam at the near end.
   *
   * So the WIDE layers fade out as a segment turns end-on and the thin core
   * carries it alone. The core is the part that reads as lightning anyway.
   */
  const seam = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    layer: number, taper: number, power: number, seed: number,
    angular: number, minW: number,
  ): void => {
    if (remaining <= 0) return;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-4) return;
    const cx = (ax + bx) * 0.5, cy = (ay + by) * 0.5, cz = (az + bz) * 0.5;
    const d = dist(cx, cy, cz);

    let p = power;
    if (layer === BOLT_GLOW || layer === BOLT_HALO) {
      const vx = cx - ex, vy = cy - ey, vz = cz - ez;
      const vl = Math.hypot(vx, vy, vz) || 1;
      const align = Math.abs((dx * vx + dy * vy + dz * vz) / (l * vl));
      const endOn = Math.max(0, Math.min(1, (align - 0.80) / 0.18));
      p *= layer === BOLT_GLOW ? 1 - endOn : 1 - 0.85 * endOn;
      if (p <= 1e-3) return;
    }

    const halfW = Math.max(minW, d * angular);
    const halfL = l * 0.5;
    fx.strand(cx, cy, cz, halfL, dx / l, dy / l, dz / l,
      halfW, layer, taper, p * e, seed);
    remaining--;
  };

  /** A French knot: round, so the axis is irrelevant and the aspect is 1. */
  const knot = (
    x: number, y: number, z: number, scale: number, power: number, seed: number,
  ): void => {
    if (remaining <= 0) return;
    const r = Math.max(MIN_KNOT, dist(x, y, z) * ANG_KNOT) * scale;
    fx.strand(x, y, z, r, 0, 1, 0, r, BOLT_KNOT, 1, power * e, seed);
    remaining--;
  };

  // --- the main channel ----------------------------------------------------
  const N = BOLT_POINTS;
  for (let i = 0; i < N - 1; i++) {
    const o = i * 3, p = (i + 1) * 3;
    const ax = mainPath[o], ay = mainPath[o + 1], az = mainPath[o + 2];
    const bx = mainPath[p], by = mainPath[p + 1], bz = mainPath[p + 2];
    const sd = hash01(bolt.shot, i);

    seam(ax, ay, az, bx, by, bz, BOLT_GLOW, 1, PWR_GLOW, sd, ANG_GLOW, MIN_GLOW);
    seam(ax, ay, az, bx, by, bz, BOLT_HALO, 1, PWR_HALO, sd, ANG_HALO, MIN_HALO);

    // The running stitch: ONE dash per segment, leaving a gap over each kink,
    // so the seam reads as sewn rather than drawn. It was two dashes; at 50 m
    // a segment is 1.6 m long and the core is 0.3 m wide, so half a segment was
    // a 2:1 blob rather than a stitch. One long dash per segment is a 4:1 mark
    // at the far end and a very long thin one near the bow, which is exactly
    // how a receding line of stitching foreshortens.
    const t0 = 0.06 + sd * 0.16;
    const t1 = t0 + 0.66;
    seam(
      ax + (bx - ax) * t0, ay + (by - ay) * t0, az + (bz - az) * t0,
      ax + (bx - ax) * t1, ay + (by - ay) * t1, az + (bz - az) * t1,
      BOLT_CORE, 1, PWR_CORE, sd, ANG_CORE, MIN_CORE);

    // A knot every fourth kink. Any denser and the seam turns into a string of
    // beads; any sparser and the kinks stop reading as deliberate.
    if (i > 0 && i % 4 === 0) knot(ax, ay, az, 1, PWR_KNOT * 0.55, sd);

    // The ghost channel, halo only — it must never compete with the stitch.
    if (i % 2 === 0) {
      const q = (i + 2) * 3;
      if (i + 2 < N) {
        seam(ghostPath[o], ghostPath[o + 1], ghostPath[o + 2],
          ghostPath[q], ghostPath[q + 1], ghostPath[q + 2],
          BOLT_HALO, 0.42, PWR_HALO * 0.8, sd + 0.5, ANG_HALO * 0.8, MIN_HALO * 0.8);
      }
    }
  }

  // --- forks ---------------------------------------------------------------
  for (let b = 0; b < branches.length; b++) {
    const br = branches[b];
    boltPath(branchPath, BRANCH_POINTS, (bolt.shot * 313 + phase * 17 + b) | 0,
      [br.fromX, br.fromY, br.fromZ], [br.toX, br.toY, br.toZ], 0.09);
    for (let i = 0; i < BRANCH_POINTS - 1; i++) {
      const o = i * 3, p = (i + 1) * 3;
      // Forks die on the way out — full at the root, gone at the tip.
      const taper = 1 - i / (BRANCH_POINTS - 1);
      const sd = hash01(bolt.shot, 500 + b * 16 + i);
      seam(branchPath[o], branchPath[o + 1], branchPath[o + 2],
        branchPath[p], branchPath[p + 1], branchPath[p + 2],
        BOLT_HALO, taper, PWR_HALO * 0.75, sd, ANG_HALO * 0.7, MIN_HALO * 0.7);
      seam(branchPath[o], branchPath[o + 1], branchPath[o + 2],
        branchPath[p], branchPath[p + 1], branchPath[p + 2],
        BOLT_CORE, taper, PWR_CORE * 0.55, sd, ANG_CORE * 0.8, MIN_CORE * 0.8);
    }
  }

  // --- the ends ------------------------------------------------------------
  // At the bow: a SMALL knot. It is six metres from the camera in third person
  // and everything else in the bolt is twenty to fifty, so a knot sized like
  // the ones down the channel becomes a dinner plate of white light parked on
  // the player's chest — which is precisely what the first pass looked like.
  knot(bolt.from[0], bolt.from[1], bolt.from[2], 0.55, PWR_KNOT * 0.45, 7);
  // At the mark: a burst of knots plus frayed thread-ends. This is what sells
  // the bolt as having HIT something rather than stopped — and, when the player
  // shoots at what they are looking at, it is very nearly the ONLY thing on
  // screen, because a 26 m line pointing away from the eye is a few dozen
  // pixels long however good it looks from the side.
  //
  // Pulled 0.45 m BACK along the ray. `resolveAim` returns the point at closest
  // approach to a creature's centre, which is inside its body, and a ground
  // shot lands exactly on the terrain — so a burst placed at the mark itself
  // was depth-tested away entirely and the down-axis shot had no impact at all.
  // Sparks come off the front of a thing that was struck anyway.
  const bdx = bolt.to[0] - bolt.from[0];
  const bdy = bolt.to[1] - bolt.from[1];
  const bdz = bolt.to[2] - bolt.from[2];
  const bl = Math.hypot(bdx, bdy, bdz) || 1;
  // 1.1 m clears a deer (hit radius 0.96) and most of a dragon; capped at a
  // quarter of the shot so a point-blank bolt does not burst at the bow.
  const pull = Math.min(1.1, bl * 0.25);
  const ix = bolt.to[0] - (bdx / bl) * pull;
  const iy = bolt.to[1] - (bdy / bl) * pull;
  const iz = bolt.to[2] - (bdz / bl) * pull;

  // Sized generously. When the player shoots at what they are looking at, the
  // seam is foreshortened to almost nothing and this burst is the entire read;
  // it is angular, so making it big here does not make it a dinner plate at
  // point-blank range.
  const burst = 1 + 0.9 * e;
  knot(ix, iy, iz, 5.0 * burst, PWR_KNOT * 1.05, 11);
  knot(ix, iy, iz, 2.2 * burst, PWR_KNOT * 1.4, 13);
  for (let i = 0; i < 9; i++) {
    const a = hash01(bolt.shot, 700 + i) * Math.PI * 2;
    const b2 = hash01(bolt.shot, 720 + i) * 2 - 1;
    const r = Math.max(MIN_KNOT, dist(ix, iy, iz) * ANG_KNOT);
    const s = Math.sqrt(Math.max(0, 1 - b2 * b2));
    const fx2 = Math.cos(a) * s, fy2 = b2, fz2 = Math.sin(a) * s;
    const len = r * (5.0 + 6.0 * hash01(bolt.shot, 740 + i)) * burst;
    seam(ix, iy, iz, ix + fx2 * len, iy + fy2 * len, iz + fz2 * len,
      BOLT_CORE, 1, PWR_CORE * 0.8, hash01(bolt.shot, 760 + i),
      ANG_CORE * 1.3, MIN_CORE * 1.3);
    knot(ix + fx2 * len, iy + fy2 * len, iz + fz2 * len,
      0.7, PWR_KNOT * 0.5, 780 + i);
  }
}
