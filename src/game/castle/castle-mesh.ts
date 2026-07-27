/**
 * Castle mesh builder — turns the layout's `Piece[]` into one Float32Array per
 * palette, in the 24-byte prop layout (pos3 + normal3) the dungeon pipeline
 * consumes.
 *
 * PURE: no GPU, no DOM, no `?raw` imports, so `tsx` can vertex-count and
 * winding-check the castle without a browser.
 *
 * ## Why this does not call mesh-utils
 *
 * Every primitive in `mesh-utils.ts` writes through `number[].push`, measured
 * at ~17x slower than indexed writes into a pre-sized array
 * (`entity-renderer.ts:224`). That is tolerable for a 300-vertex stool and not
 * for a castle: this emits ~24k vertices across ~700 pieces, and every one of
 * them would be a push. So the
 * geometry is duplicated here as indexed writes over a two-pass allocation —
 * count first, allocate exactly, then fill. The winding is copied verbatim from
 * `mesh-utils.box()` so `scripts/check-winding.mts` stays the authority.
 */

import type { CastleLayout, Piece, Rect } from './castle-layout';
import {
  CASTLE_PALETTES, KEEP_HX, KEEP_HZ, OPEN_DECK_Y, PAL_ASHLAR, PAL_GRAVE,
  PAL_SOOT, PAL_VOID, RAMP_THICKNESS, SLAB_T, WALL_WALK, subtract,
} from './castle-layout';

/** Floats per vertex: pos3 + normal3. Matches renderer.STRIDE_PROP / 4. */
export const CASTLE_VERTEX_FLOATS = 6;

/** One palette's worth of geometry. */
export interface CastleMeshPart {
  palette: number;
  verts: Float32Array<ArrayBuffer>;
}

/**
 * Segments per side of an arch's curve. Three is the fewest that still reads as
 * a curve rather than a chamfer at the 2-4 m openings this castle uses, and the
 * arch is the most repeated non-box piece in the file (every window, every
 * blind arcade bay, both great doors), so the count is worth being stingy with.
 */
const ARCH_SEG = 3;
/** Outline points of an arch: sill 2 + springings 2 + arc (2n - 1). */
const ARCH_PTS = 2 * ARCH_SEG + 3;

/** Vertices a piece contributes, so the buffer can be sized exactly. */
function vertsFor(p: Piece): number {
  switch (p.kind) {
    // bevelBox: 8 side quads + 3 top-cap quads + 3 bottom-cap quads = 14 x 6.
    case 'bevel': return 84;
    // spire: 8 octagon-to-apex triangles + a 3-quad octagonal base cap.
    case 'spire': return 8 * 3 + 3 * 6;
    // pyr: 4 triangles + a base quad.
    case 'pyr': return 4 * 3 + 6;
    // wedge: 2 slope quads + 2 gable triangles + a base quad.
    case 'wedge': return 2 * 6 + 2 * 3 + 6;
    // arch: front fan + back fan + one rim quad per outline edge.
    case 'arch': return 2 * (ARCH_PTS - 2) * 3 + ARCH_PTS * 6;
    default: return 36;
  }
}

/**
 * Indexed-write vertex sink. `n` is a float cursor, never a vertex count —
 * mixing the two is the classic way to write a buffer that renders as
 * confetti.
 */
class Sink {
  readonly buf: Float32Array<ArrayBuffer>;
  private n = 0;

  constructor(floats: number) {
    this.buf = new Float32Array(floats);
  }

  get floats(): number { return this.n; }

  /** Two triangles a-b-c, a-c-d sharing one flat normal — as mesh-utils.quad. */
  quad(
    ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number, dx: number, dy: number, dz: number,
  ): void {
    const ux = bx - ax; const uy = by - ay; const uz = bz - az;
    const vx = cx - ax; const vy = cy - ay; const vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-12) { nx /= len; ny /= len; nz /= len; } else { nx = 0; ny = 1; nz = 0; }
    const b = this.buf;
    let i = this.n;
    b[i] = ax; b[i + 1] = ay; b[i + 2] = az; b[i + 3] = nx; b[i + 4] = ny; b[i + 5] = nz;
    b[i + 6] = bx; b[i + 7] = by; b[i + 8] = bz; b[i + 9] = nx; b[i + 10] = ny; b[i + 11] = nz;
    b[i + 12] = cx; b[i + 13] = cy; b[i + 14] = cz; b[i + 15] = nx; b[i + 16] = ny; b[i + 17] = nz;
    b[i + 18] = ax; b[i + 19] = ay; b[i + 20] = az; b[i + 21] = nx; b[i + 22] = ny; b[i + 23] = nz;
    b[i + 24] = cx; b[i + 25] = cy; b[i + 26] = cz; b[i + 27] = nx; b[i + 28] = ny; b[i + 29] = nz;
    b[i + 30] = dx; b[i + 31] = dy; b[i + 32] = dz; b[i + 33] = nx; b[i + 34] = ny; b[i + 35] = nz;
    i += 36;
    this.n = i;
  }

  /** Axis-aligned box, 6 outward faces, 36 verts — winding as mesh-utils.box. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    this.quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0); // -X
    this.quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1); // +X
    this.quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0); // -Z
    this.quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1); // +Z
    this.quad(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0); // +Y
    this.quad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1); // -Y
  }

  /**
   * Box with chamfered vertical edges — 8 side quads plus an octagonal cap top
   * and bottom, fanned as 3 quads each. 84 verts.
   */
  bevelBox(
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, bevel: number,
  ): void {
    const b = Math.min(bevel, (x1 - x0) / 3, (z1 - z0) / 3);
    if (b <= 1e-4) {
      // Degenerate: 6 real quads + 8 zero-area ones, so the two-pass size holds.
      this.box(x0, y0, z0, x1, y1, z1);
      for (let i = 0; i < 8; i++) {
        this.quad(x0, y0, z0, x0, y0, z0, x0, y0, z0, x0, y0, z0);
      }
      return;
    }
    // Octagon ring. Indices run CLOCKWISE seen from +Y, which is why the top
    // cap below is fanned in reverse and the bottom one is not — the first
    // version fanned both the same way and ten of the sixteen cap triangles
    // faced inward, which under `cullMode: 'back'` is a hole, not a shading
    // artefact. `scripts/check-winding.mts` is what caught it.
    const px = [x0 + b, x1 - b, x1, x1, x1 - b, x0 + b, x0, x0];
    const pz = [z0, z0, z0 + b, z1 - b, z1, z1, z1 - b, z0 + b];
    for (let i = 0; i < 8; i++) {
      const j = (i + 1) % 8;
      this.quad(px[j], y0, pz[j], px[i], y0, pz[i], px[i], y1, pz[i], px[j], y1, pz[j]);
    }
    // Top cap (+Y): fan from vertex 0, reversed.
    for (const [a, c, d] of [[3, 2, 1], [5, 4, 3], [7, 6, 5]] as const) {
      this.quad(px[0], y1, pz[0], px[a], y1, pz[a], px[c], y1, pz[c], px[d], y1, pz[d]);
    }
    // Bottom cap (-Y): fan from vertex 0, ring order.
    for (const [a, c, d] of [[1, 2, 3], [3, 4, 5], [5, 6, 7]] as const) {
      this.quad(px[0], y0, pz[0], px[a], y0, pz[a], px[c], y0, pz[c], px[d], y0, pz[d]);
    }
  }

  /**
   * A ramp slab: a box whose top face slopes. `dir` picks the high edge —
   * 0 = +x, 1 = -x, 2 = +z, 3 = -z. The player walks on the sloped face, which
   * is why the collider's Support and this geometry must agree: the Support
   * plane runs from `y0Top` at the low edge to `y1` at the high edge.
   */
  rampSlab(
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, dir: number,
  ): void {
    // Top-face corner heights. The walking surface is the slab top; its low
    // edge sits RAMP_THICKNESS above the slab bottom, which is exactly how
    // castle-layout authored the piece. If these two drift the player walks on
    // a plane that is not where the stone is drawn.
    const lo = y0 + RAMP_THICKNESS;
    const hi = y1;
    const yA = dir === 0 || dir === 2 ? lo : hi;       // at x0 / z0
    const yB = dir === 0 || dir === 2 ? hi : lo;       // at x1 / z1
    // Heights at the four top corners (x0z0, x1z0, x1z1, x0z1).
    let h00: number; let h10: number; let h11: number; let h01: number;
    if (dir === 0 || dir === 1) {
      h00 = yA; h01 = yA; h10 = yB; h11 = yB;
    } else {
      h00 = yA; h10 = yA; h01 = yB; h11 = yB;
    }
    const base = y0;
    // Sloped top.
    this.quad(x0, h01, z1, x1, h11, z1, x1, h10, z0, x0, h00, z0);
    // Bottom.
    this.quad(x0, base, z0, x1, base, z0, x1, base, z1, x0, base, z1);
    // Sides.
    this.quad(x0, base, z0, x0, base, z1, x0, h01, z1, x0, h00, z0);            // -X
    this.quad(x1, base, z1, x1, base, z0, x1, h10, z0, x1, h11, z1);            // +X
    this.quad(x1, base, z0, x0, base, z0, x0, h00, z0, x1, h10, z0);            // -Z
    this.quad(x0, base, z1, x1, base, z1, x1, h11, z1, x0, h01, z1);            // +Z
  }

  /** One triangle a-b-c with a flat normal. Same convention as `quad`. */
  tri(
    ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ): void {
    const ux = bx - ax; const uy = by - ay; const uz = bz - az;
    const vx = cx - ax; const vy = cy - ay; const vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-12) { nx /= len; ny /= len; nz /= len; } else { nx = 0; ny = 1; nz = 0; }
    const b = this.buf;
    let i = this.n;
    b[i] = ax; b[i + 1] = ay; b[i + 2] = az; b[i + 3] = nx; b[i + 4] = ny; b[i + 5] = nz;
    b[i + 6] = bx; b[i + 7] = by; b[i + 8] = bz; b[i + 9] = nx; b[i + 10] = ny; b[i + 11] = nz;
    b[i + 12] = cx; b[i + 13] = cy; b[i + 14] = cz; b[i + 15] = nx; b[i + 16] = ny; b[i + 17] = nz;
    this.n = i + 18;
  }

  /**
   * Octagonal spire — the roof cone that turns a tower into a tower.
   *
   * The ring is the SAME octagon `bevelBox` uses, and it runs clockwise seen
   * from +Y for the same reason: a spire sits on a bevelled tower and the two
   * silhouettes have to agree, or the roof reads as a different object balanced
   * on the shaft. Side triangles reuse the bevel's side-quad winding with the
   * top edge collapsed to the apex; the base cap is copied outright.
   */
  spire(
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  ): void {
    // A regular octagon inscribed in the box: the chamfer that makes the eight
    // edges equal is (1 - 1/(1 + sqrt 2)) / 2 ~= 0.2071 of the full span.
    const bx = (x1 - x0) * 0.2071;
    const bz = (z1 - z0) * 0.2071;
    const px = [x0 + bx, x1 - bx, x1, x1, x1 - bx, x0 + bx, x0, x0];
    const pz = [z0, z0, z0 + bz, z1 - bz, z1, z1, z1 - bz, z0 + bz];
    const ax = (x0 + x1) * 0.5;
    const az = (z0 + z1) * 0.5;
    for (let i = 0; i < 8; i++) {
      const j = (i + 1) % 8;
      this.tri(px[j], y0, pz[j], px[i], y0, pz[i], ax, y1, az);
    }
    for (const [a, c, d] of [[1, 2, 3], [3, 4, 5], [5, 6, 7]] as const) {
      this.quad(px[0], y0, pz[0], px[a], y0, pz[a], px[c], y0, pz[c], px[d], y0, pz[d]);
    }
  }

  /** Four-sided pyramid — merlon caps, finials, small pinnacles. */
  pyr(
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  ): void {
    const ax = (x0 + x1) * 0.5;
    const az = (z0 + z1) * 0.5;
    // Each side is a `box` face with its top edge collapsed onto the apex, so
    // the winding is inherited rather than re-derived.
    this.tri(x0, y0, z0, x0, y0, z1, ax, y1, az);   // -X
    this.tri(x1, y0, z1, x1, y0, z0, ax, y1, az);   // +X
    this.tri(x1, y0, z0, x0, y0, z0, ax, y1, az);   // -Z
    this.tri(x0, y0, z1, x1, y0, z1, ax, y1, az);   // +Z
    this.quad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1);   // -Y
  }

  /**
   * Gable prism — a pitched roof. `dir` 0 or 1 puts the ridge along x, 2 or 3
   * along z, matching `rampSlab`'s axis encoding so one `rampDir` field serves
   * both kinds.
   */
  wedge(
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, dir: number,
  ): void {
    if (dir < 2) {
      const zm = (z0 + z1) * 0.5;
      this.quad(x1, y0, z0, x0, y0, z0, x0, y1, zm, x1, y1, zm);   // -Z slope
      this.quad(x0, y0, z1, x1, y0, z1, x1, y1, zm, x0, y1, zm);   // +Z slope
      this.tri(x0, y0, z0, x0, y0, z1, x0, y1, zm);                // -X gable
      this.tri(x1, y0, z1, x1, y0, z0, x1, y1, zm);                // +X gable
    } else {
      const xm = (x0 + x1) * 0.5;
      this.quad(x0, y0, z0, x0, y0, z1, xm, y1, z1, xm, y1, z0);   // -X slope
      this.quad(x1, y0, z1, x1, y0, z0, xm, y1, z0, xm, y1, z1);   // +X slope
      this.tri(x1, y0, z0, x0, y0, z0, xm, y1, z0);                // -Z gable
      this.tri(x0, y0, z1, x1, y0, z1, xm, y1, z1);                // +Z gable
    }
    this.quad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1);     // -Y
  }

  /**
   * A pointed-arch prism: a slab whose outline is a rectangle capped by a
   * two-centred Gothic arch.
   *
   * This is the piece the whole rectification hangs on. The castle had no
   * curves at all, and a keep with square holes in it reads as a warehouse; a
   * pointed arch is the single cheapest mark that says "cathedral, and
   * something is wrong with it". Openings are NOT cut — the arch is a slab
   * standing proud of a wall face, so the collision layer is untouched and the
   * reachability proof never sees it.
   *
   * `dir` 0/1 puts the arch face in the XY plane (thin in Z), 2/3 in the ZY
   * plane (thin in X). `spring` is the fraction of the box height at which the
   * curve starts.
   *
   * The arch is FITTED INSIDE the box rather than filling it: the two-centred
   * construction degenerates once the rise falls below the half-width (the arc
   * centres cross the springing line and the apex collapses onto it), so the
   * half-width is clamped against the rise and the outline is centred in what
   * is left. That keeps the vertex count a constant — `vertsFor` is a pure
   * function of `kind` and the two-pass allocation depends on it.
   */
  arch(
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
    dir: number, spring: number,
  ): void {
    const flat = dir < 2;
    // Work in (u, v, w). For the XY face that is (x, y, z); for the ZY face it
    // is (-z, y, x), which is the mapping that stays RIGHT-HANDED — (z, y, x)
    // is a reflection and would emit the whole prism inside-out.
    const u0 = flat ? x0 : -z1;
    const u1 = flat ? x1 : -z0;
    const w0 = flat ? z0 : x0;
    const w1 = flat ? z1 : x1;
    const um = (u0 + u1) * 0.5;

    const vs = y0 + (y1 - y0) * Math.min(Math.max(spring, 0.05), 0.85);
    const rise = y1 - vs;
    const hw = Math.min((u1 - u0) * 0.5, rise / 1.18);
    // Two-centred arch: each arc is struck from a centre offset `c` across the
    // springing line, so the two meet at a real point. `rise > hw` is what the
    // clamp above guarantees, which makes `c` strictly positive.
    const c = (rise * rise - hw * hw) / (2 * hw);
    const R = hw + c;
    const aEnd = Math.atan2(rise, c);

    // Outline, counter-clockwise in (u, v): sill, up the right jamb, over the
    // arch, down the left jamb.
    const pu = new Array<number>(ARCH_PTS);
    const pv = new Array<number>(ARCH_PTS);
    pu[0] = um - hw; pv[0] = y0;
    pu[1] = um + hw; pv[1] = y0;
    pu[2] = um + hw; pv[2] = vs;
    for (let k = 1; k <= ARCH_SEG; k++) {
      const a = (aEnd * k) / ARCH_SEG;
      pu[2 + k] = um - c + R * Math.cos(a);
      pv[2 + k] = vs + R * Math.sin(a);
    }
    for (let k = ARCH_SEG - 1; k >= 1; k--) {
      pu[2 + 2 * ARCH_SEG - k] = 2 * um - pu[2 + k];
      pv[2 + 2 * ARCH_SEG - k] = pv[2 + k];
    }
    pu[ARCH_PTS - 1] = um - hw; pv[ARCH_PTS - 1] = vs;

    // Map (u, v, w) back to world.
    const X = (u: number, w: number): number => (flat ? u : w);
    const Z = (u: number, w: number): number => (flat ? w : -u);

    // Front face (+w) fanned from point 0; back face (-w) fanned in reverse.
    for (let k = 1; k < ARCH_PTS - 1; k++) {
      this.tri(
        X(pu[0], w1), pv[0], Z(pu[0], w1),
        X(pu[k], w1), pv[k], Z(pu[k], w1),
        X(pu[k + 1], w1), pv[k + 1], Z(pu[k + 1], w1));
      this.tri(
        X(pu[0], w0), pv[0], Z(pu[0], w0),
        X(pu[k + 1], w0), pv[k + 1], Z(pu[k + 1], w0),
        X(pu[k], w0), pv[k], Z(pu[k], w0));
    }
    // Rim: one quad per outline edge, back edge first so the normal faces out.
    for (let i = 0; i < ARCH_PTS; i++) {
      const j = (i + 1) % ARCH_PTS;
      this.quad(
        X(pu[i], w0), pv[i], Z(pu[i], w0),
        X(pu[j], w0), pv[j], Z(pu[j], w0),
        X(pu[j], w1), pv[j], Z(pu[j], w1),
        X(pu[i], w1), pv[i], Z(pu[i], w1));
    }
  }
}

/**
 * Which palette a derived floor slab takes.
 *
 * Three of the castle's walkable planes are open to the sky — the wall-walk,
 * the keep roof and the arena — and one more is: the courtyard. Those are the
 * exterior and they take the exterior's dressing value; everything else is a
 * hall or a wing and takes ashlar.
 *
 * The courtyard cannot be told apart by height, because the keep's level-1
 * floor is at y = 0 as well. It can be told apart by WHERE: the keep's floor is
 * inside the keep's footprint by construction and the courtyard is the plane
 * around it, so the centre of the rect decides.
 */
function floorPalette(y: number, r: Rect): number {
  // The wall-walk is the one deck whose slab fills the FULL thickness of the
  // wall under it, so its side faces land in the curtain's own planes on both
  // sides and cannot be pulled back without opening a slot at the corners. It
  // takes the curtain's palette instead: a tie between two faces of one colour
  // shades identically and cannot be seen.
  if (Math.abs(y - WALL_WALK) < 1e-6) return PAL_VOID;
  if (OPEN_DECK_Y.some((d) => Math.abs(y - d) < 1e-6)) return PAL_GRAVE;
  if (Math.abs(y) > 1e-6) return PAL_ASHLAR;
  const cx = (r.x0 + r.x1) * 0.5;
  const cz = (r.z0 + r.z1) * 0.5;
  return Math.abs(cx) > KEEP_HX || Math.abs(cz) > KEEP_HZ ? PAL_GRAVE : PAL_ASHLAR;
}

/**
 * One slab under every flat walkable surface, with the overlaps taken out.
 *
 * Floors are DERIVED from the collision surfaces rather than authored
 * separately, and that is the point: it makes it impossible to stand on an
 * invisible floor or to see a floor you cannot stand on. It also means the
 * stairwell openings punched into `supports` are punched into the geometry for
 * free — the first version authored neither, and the castle rendered with no
 * floors at all while the player stood on thin air.
 *
 * What it also means is that supports which OVERLAP produce slabs which
 * overlap, and two coplanar upward faces are a depth-test tie: the courtyard
 * plane runs across the whole plinth, the keep's level-1 floor sits inside it
 * at the same height, `cutSupport` has split both into fragments, and the whole
 * of the keep's footprint was two polygons at y = 0 arguing about which one is
 * in front. Reported from play as the floor "clipping between colours" — and it
 * got worse the moment the two carried different palettes, because then the tie
 * alternates between two VALUES rather than two identical greys.
 *
 * Resolved smallest-first: a support contained in another is the more specific
 * statement about that patch of ground (the hall floor beats the courtyard
 * plane), and a contained rect always has the smaller area. Collision is not
 * touched — `layout.supports` is read, never written, so the reachability flood
 * sees exactly the same walkable set it always did.
 */
function derivedFloors(layout: CastleLayout): Piece[] {
  const flat = layout.supports.filter((s) => s.dydx === 0 && s.dydz === 0);
  // Group by height. Only same-height slabs can tie for depth.
  const byY = new Map<string, typeof flat>();
  for (const s of flat) {
    const k = s.y.toFixed(4);
    const g = byY.get(k);
    if (g === undefined) byY.set(k, [s]);
    else g.push(s);
  }
  const out: Piece[] = [];
  const rects: { r: Rect; y: number }[] = [];
  for (const group of byY.values()) {
    const order = [...group].sort(
      (a, b) => (a.x1 - a.x0) * (a.z1 - a.z0) - (b.x1 - b.x0) * (b.z1 - b.z0));
    const claimed: Rect[] = [];
    for (const s of order) {
      let frags: Rect[] = [{ x0: s.x0, z0: s.z0, x1: s.x1, z1: s.z1 }];
      for (const c of claimed) {
        const next: Rect[] = [];
        for (const f of frags) {
          if (f.x0 < c.x1 && f.x1 > c.x0 && f.z0 < c.z1 && f.z1 > c.z0) {
            next.push(...subtract(f, c));
          } else {
            next.push(f);
          }
        }
        frags = next;
      }
      claimed.push({ x0: s.x0, z0: s.z0, x1: s.x1, z1: s.z1 });
      for (const f of frags) rects.push({ r: f, y: s.y });
    }
  }
  // Pull every EXPOSED slab edge 2 cm back off the wall it runs into.
  //
  // A walkable rect runs to the face of whatever bounds it, so the slab derived
  // from it has a side face in exactly the plane of that wall, pointing the same
  // way — the wall-walk against the curtain's outer skin is 114 m² of it. That
  // used to be invisible because floor and wall were both ashlar; the moment the
  // exterior took its own palette it became two values arguing per pixel.
  //
  // Only edges that meet nothing are pulled: an edge shared with the next slab
  // at the same height is a JOINT, and insetting both halves of a joint opens a
  // slot you can see the storey below through. The arena is twelve bands wide
  // and the drum under it is hollow, so that mistake would put eleven stripes of
  // sky across the boss floor.
  const INSET = 0.02;
  for (const { r, y } of rects) {
    const touches = (side: 'x0' | 'x1' | 'z0' | 'z1'): boolean => {
      const alongX = side === 'x0' || side === 'x1';
      const opp = side === 'x0' ? 'x1' : side === 'x1' ? 'x0' : side === 'z0' ? 'z1' : 'z0';
      for (const o of rects) {
        if (o.r === r || o.y !== y) continue;
        if (Math.abs(o.r[opp] - r[side]) > 1e-6) continue;
        const lo = alongX ? Math.max(o.r.z0, r.z0) : Math.max(o.r.x0, r.x0);
        const hi = alongX ? Math.min(o.r.z1, r.z1) : Math.min(o.r.x1, r.x1);
        if (hi - lo > 1e-6) return true;
      }
      return false;
    };
    const x0 = touches('x0') ? r.x0 : r.x0 + INSET;
    const x1 = touches('x1') ? r.x1 : r.x1 - INSET;
    const z0 = touches('z0') ? r.z0 : r.z0 + INSET;
    const z1 = touches('z1') ? r.z1 : r.z1 - INSET;
    if (x1 - x0 < 1e-3 || z1 - z0 < 1e-3) continue;
    out.push({
      // Ashlar, not rough rock: on the surface path palette 0 resolves to
      // MAT.STONE, the terrain's crazy-paving boulder texture, and a great hall
      // floored in boulder reads as a cave. Every floor in the castle is a laid
      // one, so they all take a coursed palette — which one is `floorPalette`'s
      // business.
      // Exactly SLAB_T thick. Deepening it to clear the things whose undersides
      // also sit at `floor - SLAB_T` was tried and traded one fault for another:
      // the extra few centimetres put the slab's SIDES back into the planes of
      // the walls below it. Those undersides are offset at the author site
      // instead, which moves one box rather than every floor in the castle.
      pal: floorPalette(y, r), kind: 'box',
      x0, y0: y - SLAB_T, z0,
      x1, y1: y, z1,
    });
  }
  return out;
}

/**
 * The motte under the courtyard: a half-metre band beneath every y = 0 slab,
 * minus the undercroft void.
 *
 * The courtyard is a floor slab over a plinth whose middle is hollow — the
 * battered face is four 2.4 m perimeter bands — so the underside of that slab
 * is exposed to a void nobody can stand in, and it is coplanar with the bottom
 * of every keep shell wall and every cladding plate standing on it. That is a
 * hundred square metres of two-palette depth tie which `test-castle-zfight`
 * correctly reports and which no player can ever see, because a castle is not
 * hollow: the thing that resolves it is filling the void, not offsetting the
 * walls.
 *
 * Derived rather than authored, and that distinction is the whole point. It
 * used to be one authored box across the entire plinth, which meant the mass
 * existed twice — once as this fill and once as the y = 0 Supports — and only
 * the Supports knew where the holes were. `cutSupport` punches the undercroft
 * stairwell out of the floor; the authored box kept none of it and sealed the
 * shaft into a flat black ceiling you walked through on the way up. Taking the
 * fill from the slabs THEMSELVES means every hole the collider has, the fill
 * has, permanently.
 *
 * The undercroft is subtracted because it is the one place under the courtyard
 * the player stands: leaving the fill over it puts a drawn ceiling at -1.5 m
 * while `LEVEL_CEIL[0]` clamps the head at -1.0, and `LEVEL_CEIL`'s contract is
 * that the floor slab above IS the ceiling you see. The OUTER rect is
 * subtracted, not the walkable void, so the fill stops in the plane of the
 * prison shell's outer face where the shell's own boxes hide it, rather than in
 * the plane of its inner face where it would hang into the room.
 */
function derivedUndercroftFill(floors: Piece[]): Piece[] {
  const VOID: Rect = { x0: -17, z0: -15, x1: 17, z1: 15 };
  const out: Piece[] = [];
  for (const f of floors) {
    if (Math.abs(f.y1) > 1e-6) continue;   // y = 0 decks only
    const frags = f.x0 < VOID.x1 && f.x1 > VOID.x0 && f.z0 < VOID.z1 && f.z1 > VOID.z0
      ? subtract({ x0: f.x0, z0: f.z0, x1: f.x1, z1: f.z1 }, VOID)
      : [{ x0: f.x0, z0: f.z0, x1: f.x1, z1: f.z1 }];
    for (const r of frags) {
      // Directly UNDER the slab, never overlapping it: the slab's own sides are
      // pulled 2 cm off the walls they meet and deepening it would put them back
      // into those planes (see `derivedFloors`). A separate box below keeps that
      // inset intact, and its top face points up where the slab's points down,
      // so the shared plane at y = -SLAB_T is two faces back to back, not a tie.
      out.push({
        pal: PAL_SOOT, kind: 'box',
        x0: r.x0, y0: -SLAB_T - 0.5, z0: r.z0,
        x1: r.x1, y1: -SLAB_T, z1: r.z1,
      });
    }
  }
  return out;
}

/**
 * Every piece the castle actually draws, in emit order.
 *
 * The authored `layout.pieces` are only half of it — the floors are derived
 * here — so anything auditing the castle's geometry has to ask for the union or
 * it is auditing something the player never sees. `scripts/test-castle-zfight`
 * is the reason this is exported.
 */
export function castleEmittedPieces(layout: CastleLayout): Piece[] {
  // Ramps carry their own slab (`Piece.kind === 'ramp'`), so `derivedFloors`
  // only has the flat supports to answer for.
  const floors = derivedFloors(layout);
  return [...floors, ...derivedUndercroftFill(floors), ...layout.pieces];
}

/**
 * Build the castle's geometry, bucketed by palette.
 *
 * Vertices stay in CASTLE-LOCAL space; the world translation rides the object
 * uniform (`createObjectBindGroup(originX, originY, originZ, 100 + palette)`),
 * which is all `shaders/dungeon.wgsl` can apply anyway — it adds `object.offset`
 * and has no rotation or scale.
 */
export function buildCastleMesh(layout: CastleLayout): CastleMeshPart[] {
  const all = castleEmittedPieces(layout);

  // Pass 1: how many floats does each palette need?
  const need = new Map<number, number>();
  for (const p of all) {
    need.set(p.pal, (need.get(p.pal) ?? 0) + vertsFor(p) * CASTLE_VERTEX_FLOATS);
  }
  const sinks = new Map<number, Sink>();
  for (const [pal, floats] of need) sinks.set(pal, new Sink(floats));

  // Pass 2: fill.
  // Every branch here must agree with `vertsFor`, and the failure mode when it
  // does not is quiet: the first version of this switch had no cases for the
  // shapes added with them, so 'spire' and 'arch' fell through to `box` — the
  // castle allocated 42 and 96 floats a piece, wrote 36, and rendered every
  // tower roof and every window as a cube. Nothing failed. It just looked wrong.
  for (const p of all) {
    const s = sinks.get(p.pal)!;
    switch (p.kind) {
      case 'bevel': s.bevelBox(p.x0, p.y0, p.z0, p.x1, p.y1, p.z1, 0.18); break;
      case 'ramp': s.rampSlab(p.x0, p.y0, p.z0, p.x1, p.y1, p.z1, p.rampDir ?? 0); break;
      case 'spire': s.spire(p.x0, p.y0, p.z0, p.x1, p.y1, p.z1); break;
      case 'pyr': s.pyr(p.x0, p.y0, p.z0, p.x1, p.y1, p.z1); break;
      case 'wedge': s.wedge(p.x0, p.y0, p.z0, p.x1, p.y1, p.z1, p.rampDir ?? 0); break;
      case 'arch':
        s.arch(p.x0, p.y0, p.z0, p.x1, p.y1, p.z1, p.rampDir ?? 0, p.spring ?? 0.55);
        break;
      default: s.box(p.x0, p.y0, p.z0, p.x1, p.y1, p.z1); break;
    }
  }

  // The two passes must land on exactly the same number, and a mismatch is how
  // the last one of these bugs stayed invisible: an under-filled sink leaves
  // zeroed floats that rasterise as degenerate triangles at the local origin,
  // which is a shape nobody ever sees. Cheap, once per rebuild.
  for (const [pal, s] of sinks) {
    const want = need.get(pal)!;
    if (s.floats !== want) {
      throw new Error(
        `castle palette ${pal}: sized ${want} floats, wrote ${s.floats} — `
        + 'vertsFor and the emit switch disagree');
    }
  }

  const out: CastleMeshPart[] = [];
  // Emit in a stable palette order so draw order (and any golden hash) is
  // deterministic across runs.
  for (const pal of CASTLE_PALETTES) {
    const s = sinks.get(pal);
    if (s === undefined || s.floats === 0) continue;
    out.push({ palette: pal, verts: s.buf.subarray(0, s.floats) as Float32Array<ArrayBuffer> });
  }
  return out;
}

/**
 * Sample geometry for `scripts/check-winding.mts`.
 *
 * That script audits a hardcoded list of `mesh-utils` primitives and scans
 * nothing else — no glob, no directory walk. Since this module reimplements
 * box/bevelBox/ramp with indexed writes instead of calling mesh-utils, it gets
 * zero coverage unless it hands the auditor something to look at. A castle
 * wound inside-out is an invisible castle, so it hands it these.
 */
export function castleWindingSamples(): {
  name: string; verts: number[]; centre: [number, number, number]; convex: boolean;
}[] {
  const grab = (fn: (s: Sink) => void): number[] => {
    const s = new Sink(4096);
    fn(s);
    return Array.from(s.buf.subarray(0, s.floats));
  };
  return [
    {
      name: 'castle box', convex: true, centre: [0, 0, 0],
      verts: grab((s) => s.box(-1, -1, -1, 1, 1, 1)),
    },
    {
      name: 'castle bevelBox', convex: true, centre: [0, 0, 0],
      verts: grab((s) => s.bevelBox(-1, -1, -1, 1, 1, 1, 0.25)),
    },
    // Every one of these is a closed convex solid, so both halves of the audit
    // apply: the stored normal must match the winding, AND the winding must
    // face away from the centre. The arch outline is convex too — the jambs
    // rise vertically and the two arcs turn inward from a vertical tangent, so
    // a fan from vertex 0 is valid and every rim quad faces out.
    {
      name: 'castle spire', convex: true, centre: [0, -0.5, 0],
      verts: grab((s) => s.spire(-1, -1, -1, 1, 1, 1)),
    },
    {
      name: 'castle pyr', convex: true, centre: [0, -0.5, 0],
      verts: grab((s) => s.pyr(-1, -1, -1, 1, 1, 1)),
    },
    {
      name: 'castle wedge x', convex: true, centre: [0, -0.5, 0],
      verts: grab((s) => s.wedge(-1, -1, -1, 1, 1, 1, 0)),
    },
    {
      name: 'castle wedge z', convex: true, centre: [0, -0.5, 0],
      verts: grab((s) => s.wedge(-1, -1, -1, 1, 1, 1, 2)),
    },
    {
      name: 'castle arch xy', convex: true, centre: [0, -0.4, 0],
      verts: grab((s) => s.arch(-1, -1.6, -0.2, 1, 1.6, 0.2, 0, 0.55)),
    },
    {
      name: 'castle arch zy', convex: true, centre: [0, -0.4, 0],
      verts: grab((s) => s.arch(-0.2, -1.6, -1, 0.2, 1.6, 1, 2, 0.55)),
    },
    {
      // Squat box: the half-width clamp fires, so the arch is narrower than
      // its box. Included because that path is the one that would degenerate.
      name: 'castle arch squat', convex: true, centre: [0, -0.3, 0],
      verts: grab((s) => s.arch(-2, -1, -0.2, 2, 1, 0.2, 0, 0.70)),
    },
    // Ramps are closed wedges, so the outward test applies to them too.
    {
      name: 'castle ramp +x', convex: true, centre: [0, -0.4, 0],
      verts: grab((s) => s.rampSlab(-1, -1, -1, 1, 1, 1, 0)),
    },
    {
      name: 'castle ramp -x', convex: true, centre: [0, -0.4, 0],
      verts: grab((s) => s.rampSlab(-1, -1, -1, 1, 1, 1, 1)),
    },
    {
      name: 'castle ramp +z', convex: true, centre: [0, -0.4, 0],
      verts: grab((s) => s.rampSlab(-1, -1, -1, 1, 1, 1, 2)),
    },
    {
      name: 'castle ramp -z', convex: true, centre: [0, -0.4, 0],
      verts: grab((s) => s.rampSlab(-1, -1, -1, 1, 1, 1, 3)),
    },
  ];
}

/** Total vertices across all palettes — used by tests and the budget check. */
export function castleVertexCount(parts: readonly CastleMeshPart[]): number {
  let n = 0;
  for (const p of parts) n += p.verts.length / CASTLE_VERTEX_FLOATS;
  return n;
}
