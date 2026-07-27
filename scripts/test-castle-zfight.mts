/**
 * Castle Vhaeron: no two visible faces may share a plane.
 *
 *   npx tsx scripts/test-castle-zfight.mts
 *
 * ## Why this is a test and not a code review
 *
 * The castle is built almost entirely out of relief: arches, string courses,
 * banners, corbels and floor slabs are boxes laid ON other boxes, deliberately,
 * so that nothing decorative ever touches the collision layer. The failure mode
 * of that technique is a depth-test TIE — two coplanar faces pointing the same
 * way, both drawn, neither in front. The GPU picks per pixel and the choice
 * flips as the camera moves, so the surface stipples and crawls between two
 * colours. Reported from play as the castle floor "clipping between colours".
 *
 * It is invisible in a screenshot, invisible in a vertex count, and invisible
 * to every other check in this repo. It also comes back the moment somebody
 * hangs a new banner, which is exactly the shape of thing that should be a
 * build failure rather than a play-testing report.
 *
 * ## Visible, not merely present
 *
 * The naive version of this reports 800 pairs and is useless, because most of
 * them are buried: the keep's shell walls stand on the courtyard, so their
 * undersides are coplanar with it over 100 m², and nobody will ever be under a
 * courtyard. So each face is first tested for whether anything is standing in
 * front of it — nine samples over its area, offset 3 cm along its normal, each
 * looked up in a uniform grid of the solid boxes. A face every one of whose
 * samples lands inside another box cannot be seen and cannot flicker.
 *
 * Only `box` and `bevel` are trusted as OCCLUDERS. A pyramid, spire, wedge or
 * arch fills much less than its AABB, so counting one as an occluder would hide
 * a real fault. Being stingy here over-reports, which is the safe direction.
 *
 * ## The rule
 *
 * Two faces fail if all four hold:
 *   - same axis and same OUTWARD DIRECTION. Opposite-facing coplanar faces are
 *     fine: whichever side you stand on, back-face culling drops one of them.
 *     A box resting exactly on a floor is the normal case, not a bug.
 *   - within EPS of each other along that axis.
 *   - their footprints overlap by more than MIN_AREA.
 *   - they carry DIFFERENT palettes. Two ties in one palette shade to bit-
 *     identical fragments — same colour, same material row, same triplanar
 *     sample off the same world position — so whichever wins the pixel is the
 *     same pixel. The 172 merlon-on-curtain-top ties are all of this kind, and
 *     they cannot be offset anyway: a merlon is a Solid and moving it moves
 *     collision.
 *
 * EPS is 1.5 cm. The castle's own deliberate offsets are 2 cm (blind arcading
 * off the hall wall), 3 cm (the keep's skin under its parapet, the arena kerb),
 * 4 cm (banners), 6 cm (the hall runner) and 9 cm (the plinth kerb), so 1.5 cm
 * clears every intentional one with margin while catching anything that shares
 * a plane outright.
 *
 * ## What it does not cover
 *
 * Only the kinds whose faces are axis-aligned rectangles — `box`, `bevel`, and
 * the sides and underside of `ramp`. Pyramids, spires, wedges and arches are
 * relief plates and cones standing proud of a wall by construction; their large
 * faces are sloped or outlined, so they cannot tie over an area. If one ever
 * does, it will show up as its neighbours' faces instead.
 */
import { buildCastleLayout, fitBreachRamp } from '../src/game/castle/castle-layout';
import type { Piece } from '../src/game/castle/castle-layout';
import { castleEmittedPieces } from '../src/game/castle/castle-mesh';

/** Coplanar within this many metres is a tie at any realistic depth precision. */
const EPS = 0.015;
/** Ignore hairline slivers: two faces meeting along an edge share zero area. */
const MIN_AREA = 0.05;

const CASTLE_SEED = 1337;
const layout = buildCastleLayout(CASTLE_SEED);
// Fit the ramp, because `fitBreachRamp` appends kerbs and rewrites the
// courtyard — auditing the unfitted castle audits a castle nobody plays. The
// gradient is chosen to reproduce the real site's fit (46 m of run, ~30 m of
// drop), because the kerb segments are spaced `run / 8` apart and a harness
// that fits an 8 m ramp audits kerbs at positions the game never builds.
fitBreachRamp(layout, (x) => -0.66 * (x - 60));

/** One outward-facing rectangle: `axis` 0=x 1=y 2=z, `dir` -1 or +1. */
interface Face {
  axis: number; dir: number; c: number;
  u0: number; u1: number; v0: number; v1: number;
  pal: number; piece: Piece;
}

/** Bevelled boxes chamfer their vertical edges, so their side faces are inset. */
const BEVEL = 0.18;

function facesOf(p: Piece): Face[] {
  if (p.kind !== 'box' && p.kind !== 'bevel' && p.kind !== 'ramp') return [];
  const b = p.kind === 'bevel'
    ? Math.min(BEVEL, (p.x1 - p.x0) / 3, (p.z1 - p.z0) / 3) : 0;
  const out: Face[] = [];
  const add = (axis: number, dir: number, c: number,
    u0: number, u1: number, v0: number, v1: number): void => {
    if (u1 - u0 > 1e-6 && v1 - v0 > 1e-6) {
      out.push({ axis, dir, c, u0, u1, v0, v1, pal: p.pal, piece: p });
    }
  };
  // Sides: (y, z) for the x faces, (x, z) for y, (x, y) for z.
  add(0, -1, p.x0, p.y0, p.y1, p.z0 + b, p.z1 - b);
  add(0, +1, p.x1, p.y0, p.y1, p.z0 + b, p.z1 - b);
  add(2, -1, p.z0, p.x0 + b, p.x1 - b, p.y0, p.y1);
  add(2, +1, p.z1, p.x0 + b, p.x1 - b, p.y0, p.y1);
  add(1, -1, p.y0, p.x0, p.x1, p.z0, p.z1);
  // A ramp's top is sloped, so it has no plane to tie with.
  if (p.kind !== 'ramp') add(1, +1, p.y1, p.x0, p.x1, p.z0, p.z1);
  return out;
}

const pieces = castleEmittedPieces(layout);

// --- occlusion --------------------------------------------------------------

/** How far in front of a face to look for something covering it. */
const PROBE = 0.03;
const CELL = 8;
const occluders = pieces.filter((p) => p.kind === 'box' || p.kind === 'bevel');
const grid = new Map<string, Piece[]>();
const cellKey = (x: number, z: number): string =>
  `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
for (const p of occluders) {
  for (let cx = Math.floor(p.x0 / CELL); cx <= Math.floor(p.x1 / CELL); cx++) {
    for (let cz = Math.floor(p.z0 / CELL); cz <= Math.floor(p.z1 / CELL); cz++) {
      const k = `${cx},${cz}`;
      const g = grid.get(k);
      if (g === undefined) grid.set(k, [p]);
      else g.push(p);
    }
  }
}

function inside(p: Piece, x: number, y: number, z: number): boolean {
  // A margin, so a point sitting exactly on another box's surface does not
  // count as covered — that is the very tie being looked for.
  const m = 0.004;
  return x > p.x0 + m && x < p.x1 - m && y > p.y0 + m && y < p.y1 - m
    && z > p.z0 + m && z < p.z1 - m;
}

function covered(f: Face, x: number, y: number, z: number): boolean {
  for (const p of grid.get(cellKey(x, z)) ?? []) {
    if (p === f.piece) continue;
    if (inside(p, x, y, z)) return true;
  }
  return false;
}

/** True when every sample just in front of the face lands inside something. */
function hidden(f: Face): boolean {
  const d = f.dir * PROBE;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const u = f.u0 + (f.u1 - f.u0) * (0.1 + 0.4 * i);
      const v = f.v0 + (f.v1 - f.v0) * (0.1 + 0.4 * j);
      const p: [number, number, number] = f.axis === 0
        ? [f.c + d, u, v] : f.axis === 1 ? [u, f.c + d, v] : [u, v, f.c + d];
      if (!covered(f, p[0], p[1], p[2])) return false;
    }
  }
  return true;
}

const allFaces: Face[] = [];
for (const p of pieces) allFaces.push(...facesOf(p));
const faces = allFaces.filter((f) => !hidden(f));

// Bucket by plane so this stays linear-ish: 20k faces compared pairwise is a
// hundred million tests, and the answer is the same.
const buckets = new Map<string, Face[]>();
const keyOf = (f: Face, slot: number): string => `${f.axis}|${f.dir}|${slot}`;
for (const f of faces) {
  const slot = Math.round(f.c / EPS);
  const g = buckets.get(keyOf(f, slot));
  if (g === undefined) buckets.set(keyOf(f, slot), [f]);
  else g.push(f);
}

interface Hit { a: Face; b: Face; area: number }
const hits: Hit[] = [];
const sameOk = new Map<string, number>();
const seen = new Set<string>();
for (const [k, group] of buckets) {
  // A face at 0.999 * EPS from another can land in the next slot along, so each
  // bucket is compared against itself and its right-hand neighbour.
  const [axis, dir, slot] = k.split('|');
  const nb = buckets.get(`${axis}|${dir}|${Number(slot) + 1}`) ?? [];
  const pool = [...group, ...nb];
  for (let i = 0; i < group.length; i++) {
    for (let j = 0; j < pool.length; j++) {
      const a = group[i]; const b = pool[j];
      if (a === b) continue;
      if (Math.abs(a.c - b.c) > EPS) continue;
      const ou = Math.min(a.u1, b.u1) - Math.max(a.u0, b.u0);
      const ov = Math.min(a.v1, b.v1) - Math.max(a.v0, b.v0);
      if (ou <= 0 || ov <= 0) continue;
      const area = ou * ov;
      if (area < MIN_AREA) continue;
      const id = faces.indexOf(a) < faces.indexOf(b)
        ? `${faces.indexOf(a)}:${faces.indexOf(b)}` : `${faces.indexOf(b)}:${faces.indexOf(a)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (a.pal === b.pal) {
        const t = `pal${a.pal} axis${a.axis}${a.dir > 0 ? '+' : '-'}`;
        sameOk.set(t, (sameOk.get(t) ?? 0) + 1);
        continue;
      }
      hits.push({ a, b, area });
    }
  }
}

console.log(`${pieces.length} pieces -> ${allFaces.length} axis-aligned faces, `
  + `${faces.length} of them visible`);
const okTotal = [...sameOk.values()].reduce((n, v) => n + v, 0);
console.log(`${okTotal} same-palette coplanar pairs (harmless, see header)`);
for (const [t, n] of [...sameOk.entries()].sort((p, q) => q[1] - p[1]).slice(0, 6)) {
  console.log(`    ${t.padEnd(22)} x${n}`);
}

hits.sort((p, q) => q.area - p.area);
if (hits.length === 0) {
  console.log('\nno two-palette coplanar faces — nothing can flicker');
} else {
  console.error(`\n${hits.length} TWO-PALETTE COPLANAR FACE PAIRS:`);
  const AX = 'xyz';
  const box = (p: Piece): string =>
    `pal${p.pal} ${p.kind} ${p.x0.toFixed(2)},${p.y0.toFixed(2)},${p.z0.toFixed(2)}`
    + `..${p.x1.toFixed(2)},${p.y1.toFixed(2)},${p.z1.toFixed(2)}`;
  for (const h of hits.slice(0, 25)) {
    console.error(`  ${AX[h.a.axis]}${h.a.dir > 0 ? '+' : '-'}=${h.a.c.toFixed(3)}`
      + `/${h.b.c.toFixed(3)}  ${h.area.toFixed(1)} m²`);
    console.error(`      A ${box(h.a.piece)}`);
    console.error(`      B ${box(h.b.piece)}`);
  }
  if (hits.length > 25) console.error(`  ... and ${hits.length - 25} more`);
}
console.log(`\n${hits.length === 0 ? 'PASS' : 'FAIL'}`);
process.exitCode = hits.length === 0 ? 0 : 1;
