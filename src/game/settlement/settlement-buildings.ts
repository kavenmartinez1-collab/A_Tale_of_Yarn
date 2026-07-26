/**
 * Exterior meshes for the settlement's *buildings* — the structures that make
 * a place read as somewhere people live rather than a scatter of boxes.
 *
 * `church` / `tavern` / `longhouse` / `smithy` are the four names shared with
 * the building-interior workstream; `mill`, `townhouse` and `granary` are
 * additions from this pass. The older `house` / `barn` builders moved here
 * too and were reworked (sagging ridges, cladding variants, window boxes).
 *
 * Everything is pad-local: origin at the pad centre on the ground plane,
 * local -Z is the door / street side. A pad's `v` is a small deterministic
 * variant index — the cheapest way to stop a street of houses looking
 * stamped, since it costs no extra geometry at all.
 *
 * Vertex discipline: `bevelBox` costs 96 verts (8 walls + 16 cap triangles)
 * against `box`'s 36, so bevels are spent on the big masses a player walks up
 * to and plain boxes carry the trim.
 */

import { cone, cylinder } from '../mesh-utils';
import {
  PAL_BERRY, PAL_LEAF, PAL_PLASTER, PAL_STONE, PAL_THATCH, PAL_TIMBER,
  PAL_TORCH, PAL_WOOD, PAL_WOOL, SKIRT_DEPTH,
  type Buckets, type PaletteIndex, type SettlementFlame,
} from './settlement-palette';
import {
  beam, bevelBoxN, bladeXY, boxN, pyramidRoof, roof, roofZ, saggedRoof,
  windowBox, windowNZ,
} from './settlement-shapes';

/**
 * Stone platform skirt under a building, hiding the downhill slope gap.
 * Plain `box`, not `bevelBox`: all but the top 8 cm of it is below ground on
 * flat terrain, and 60 verts × every building in a castle town is real money.
 */
function skirt(b: Buckets, hw: number, hd: number, margin = 0.3): void {
  boxN(b[PAL_STONE],
    -hw - margin, -SKIRT_DEPTH, -hd - margin,
    hw + margin, 0.08, hd + margin);
}

/** Corner posts + waist/eaves rails: the timber frame over a plaster wall. */
function timberFrame(
  b: Buckets, hw: number, hd: number, y0: number, y1: number,
  wood: PaletteIndex, zc = 0, bands = 2,
): void {
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      boxN(b[wood],
        sx * hw - 0.13, y0, zc + sz * hd - 0.13,
        sx * hw + 0.13, y1, zc + sz * hd + 0.13);
    }
  }
  for (const sz of [-1, 1]) {
    const z0 = zc + sz * hd - (sz < 0 ? 0.07 : -0.02);
    const z1 = zc + sz * hd + (sz < 0 ? 0.02 : 0.07);
    boxN(b[wood], -hw - 0.04, y1 - 0.24, z0, hw + 0.04, y1 - 0.04, z1);
    if (bands > 1) {
      const waist = y0 + (y1 - y0) * 0.46;
      boxN(b[wood], -hw - 0.04, waist, z0, hw + 0.04, waist + 0.15, z1);
    }
  }
}

// ---------------------------------------------------------------------------
// Cottage + barn (reworked)
// ---------------------------------------------------------------------------

/**
 * A cottage. Variant `v` picks cladding and roof: 0 lime-washed plaster under
 * thatch, 1 plaster under dark shingle, 2 timber-boarded under thatch.
 */
export function buildHouse(b: Buckets, w: number, d: number, h: number, v: number): void {
  const hw = w / 2, hd = d / 2;
  const boarded = v === 2;
  const wall = boarded ? PAL_WOOD : PAL_PLASTER;
  const shingle = v === 1;
  const roofPal = shingle ? PAL_TIMBER : PAL_THATCH;

  skirt(b, hw, hd);
  bevelBoxN(b[wall], -hw, 0.08, -hd, hw, h, hd);
  timberFrame(b, hw, hd, 0.08, h, boarded ? PAL_TIMBER : PAL_WOOD);

  // Door with a plank-and-brace face and a stone step.
  boxN(b[PAL_TIMBER], -0.45, 0.08, -hd - 0.07, 0.45, 1.72, -hd + 0.02);
  boxN(b[PAL_WOOD], -0.45, 0.9, -hd - 0.09, 0.45, 1.02, -hd - 0.05);
  boxN(b[PAL_STONE], -0.6, 0.02, -hd - 0.42, 0.6, 0.14, -hd - 0.02);

  // Shuttered windows flanking the door, one with a flower box.
  for (const sx of [-1, 1]) {
    windowNZ(b[PAL_TIMBER], b[PAL_WOOD], sx * hw * 0.56, 1.06, -hd, 0.62, 0.6);
  }
  if (v !== 1) {
    windowBox(b[PAL_WOOD], b[PAL_LEAF], b[PAL_BERRY], -hw * 0.56, 1.0, -hd, 0.66);
  }

  // Stone chimney rising past the ridge on the back-right corner.
  const rise = d * 0.45;
  bevelBoxN(b[PAL_STONE],
    hw - 0.75, h - 0.2, hd - 0.95, hw - 0.15, h + rise + 0.4, hd - 0.35);
  boxN(b[PAL_STONE], hw - 0.85, h + rise + 0.36, hd - 1.05, hw - 0.05, h + rise + 0.5, hd - 0.25);

  saggedRoof(b[roofPal], b[wall], w, d, h, rise, 0.3, 0.16, 3);
  // Ridge cap — a rolled straw bolster, or a lead flashing on a shingle roof.
  boxN(b[shingle ? PAL_STONE : PAL_THATCH],
    -w / 2 - 0.32, h + rise - 0.1, -0.11, w / 2 + 0.32, h + rise + 0.06, 0.11);
}

/** A barn: plank walls, big braced cart doors, a hayloft opening. */
export function buildBarn(b: Buckets, w: number, d: number, h: number, v: number): void {
  const hw = w / 2, hd = d / 2;
  skirt(b, hw, hd);
  bevelBoxN(b[PAL_STONE], -hw, 0.08, -hd, hw, 0.55, hd);   // stone plinth
  bevelBoxN(b[PAL_WOOD], -hw, 0.5, -hd, hw, h, hd);
  // Vertical board battens down the long sides.
  const boards = Math.max(3, Math.round(w / 1.1));
  for (let i = 1; i < boards; i++) {
    const bx = -hw + (i / boards) * w;
    for (const sz of [-1, 1]) {
      boxN(b[PAL_TIMBER], bx - 0.05, 0.5, sz * hd - 0.05, bx + 0.05, h, sz * hd + 0.05);
    }
  }
  // Cart doors with a diagonal brace each.
  boxN(b[PAL_TIMBER], -1.0, 0.5, -hd - 0.08, 1.0, 2.3, -hd + 0.02);
  beam(b[PAL_WOOD], -0.95, 0.6, -hd - 0.1, -0.05, 2.2, -hd - 0.1, 0.07, 0.03);
  beam(b[PAL_WOOD], 0.95, 0.6, -hd - 0.1, 0.05, 2.2, -hd - 0.1, 0.07, 0.03);
  const rise = d * 0.42;
  // Hayloft opening in the gable, with a hoist beam sticking out.
  boxN(b[PAL_TIMBER], hw - 0.02, h + rise * 0.25, -0.45, hw + 0.06, h + rise * 0.72, 0.45);
  if (v === 1) {
    boxN(b[PAL_WOOD], hw - 0.1, h + rise * 0.78, -0.09, hw + 0.9, h + rise * 0.78 + 0.16, 0.09);
  }
  saggedRoof(b[PAL_THATCH], b[PAL_WOOD], w, d, h, rise, 0.38, 0.12, 3);
}

// ---------------------------------------------------------------------------
// Church — the landmark of any settlement that has one
// ---------------------------------------------------------------------------

/**
 * A church: lime-washed nave under a dark shingle roof, stepped buttresses,
 * lancet windows with coloured glass, and a west tower carrying a tall spire.
 * `h` is the nave wall height; the spire finial lands around `h + 11 m`, so
 * it is visible over the rooftops from the far side of a town.
 */
export function buildChurch(b: Buckets, w: number, d: number, h: number): void {
  const hw = w / 2, hd = d / 2;
  const ts = Math.min(w * 0.78, 4.6);          // tower footprint
  const towerH = h + 4.4;

  skirt(b, hw, hd, 0.4);
  bevelBoxN(b[PAL_PLASTER], -hw, 0.08, -hd, hw, h, hd);       // nave
  bevelBoxN(b[PAL_STONE], -hw - 0.1, 0.08, -hd, hw + 0.1, 0.7, hd); // plinth

  // Stepped buttresses down both long walls.
  const buts = Math.max(2, Math.round(d / 3.4));
  for (let i = 0; i < buts; i++) {
    const bz = -hd + ((i + 0.7) / buts) * d;
    for (const sx of [-1, 1]) {
      boxN(b[PAL_STONE],
        sx * hw - 0.05, 0.08, bz - 0.35, sx * (hw + 0.42), h * 0.72, bz + 0.35);
      boxN(b[PAL_STONE],
        sx * hw - 0.05, h * 0.72, bz - 0.28, sx * (hw + 0.24), h * 0.9, bz + 0.28);
    }
  }
  // Lancet windows: coloured glass in a pale stone surround.
  for (let i = 0; i < buts; i++) {
    const bz = -hd + ((i + 0.2) / buts) * d;
    for (const sx of [-1, 1]) {
      boxN(b[PAL_BERRY],
        sx * hw - 0.06, h * 0.34, bz - 0.26, sx * (hw + 0.03), h * 0.82, bz + 0.26);
      boxN(b[PAL_STONE],
        sx * hw - 0.02, h * 0.32, bz - 0.36, sx * (hw + 0.06), h * 0.86, bz - 0.24);
      boxN(b[PAL_STONE],
        sx * hw - 0.02, h * 0.32, bz + 0.24, sx * (hw + 0.06), h * 0.86, bz + 0.36);
    }
  }
  // Chancel: a lower apse block off the +Z end.
  bevelBoxN(b[PAL_PLASTER], -hw * 0.6, 0.08, hd - 0.1, hw * 0.6, h * 0.78, hd + 1.5);
  roof(b[PAL_TIMBER], b[PAL_PLASTER],
    w * 0.6, 1.6, h * 0.78, 1.0, 0.22, 0, hd + 0.7);

  // Nave roof — steep and dark against the village thatch.
  saggedRoof(b[PAL_TIMBER], b[PAL_PLASTER], w, d, h, d * 0.40, 0.36, 0.1, 3);

  // West tower, protruding 0.25 m past the nave so no faces are coplanar.
  const tz0 = -hd - 0.25, tz1 = -hd + ts * 0.72;
  bevelBoxN(b[PAL_STONE], -ts / 2, 0.08, tz0, ts / 2, towerH, tz1);
  // Corner pilasters.
  for (const sx of [-1, 1]) {
    boxN(b[PAL_STONE],
      sx * ts / 2 - 0.16, 0.08, tz0 - 0.06, sx * ts / 2 + 0.16, towerH - 0.5, tz0 + 0.3);
  }
  // Belfry openings on all four sides + the bell itself.
  const by = towerH - 1.9;
  boxN(b[PAL_TIMBER], -0.42, by, tz0 - 0.05, 0.42, by + 1.25, tz0 + 0.08);
  for (const sx of [-1, 1]) {
    boxN(b[PAL_TIMBER],
      sx * ts / 2 - 0.08, by, (tz0 + tz1) / 2 - 0.42,
      sx * ts / 2 + 0.05, by + 1.25, (tz0 + tz1) / 2 + 0.42);
  }
  cylinder(b[PAL_WOOL], 0, by + 0.35, (tz0 + tz1) / 2, 0.12, 0.3, 0.6, 6, false, true);
  // Cornice + spire.
  bevelBoxN(b[PAL_STONE],
    -ts / 2 - 0.22, towerH - 0.35, tz0 - 0.22, ts / 2 + 0.22, towerH, tz1 + 0.22);
  pyramidRoof(b[PAL_TIMBER], 0, towerH, (tz0 + tz1) / 2, ts + 0.34, (tz1 - tz0) + 0.34, 6.2);
  // Cross finial.
  const fy = towerH + 6.2;
  boxN(b[PAL_WOOL], -0.06, fy - 0.1, (tz0 + tz1) / 2 - 0.06, 0.06, fy + 1.0, (tz0 + tz1) / 2 + 0.06);
  boxN(b[PAL_WOOL], -0.34, fy + 0.5, (tz0 + tz1) / 2 - 0.05, 0.34, fy + 0.62, (tz0 + tz1) / 2 + 0.05);

  // West door: arched, dark oak, under a stone hood.
  boxN(b[PAL_TIMBER], -0.62, 0.08, tz0 - 0.08, 0.62, 2.25, tz0 + 0.02);
  boxN(b[PAL_STONE], -0.82, 2.2, tz0 - 0.16, 0.82, 2.55, tz0 + 0.02);
  boxN(b[PAL_STONE], -0.9, 0.02, tz0 - 0.62, 0.9, 0.16, tz0 - 0.02);
  // Rose window over the door.
  boxN(b[PAL_BERRY], -0.55, 2.9, tz0 - 0.05, 0.55, 4.0, tz0 + 0.02);
  boxN(b[PAL_STONE], -0.62, 3.38, tz0 - 0.08, 0.62, 3.52, tz0 + 0.01);
  boxN(b[PAL_STONE], -0.07, 2.85, tz0 - 0.08, 0.07, 4.05, tz0 + 0.01);
}

// ---------------------------------------------------------------------------
// Tavern
// ---------------------------------------------------------------------------

/**
 * A tavern: jettied upper floor, deep thatch, a fat chimney, a swinging
 * painted sign on a bracket and a lantern burning over the door. The lantern
 * registers a flame anchor, so a tavern is a light source at night.
 */
export function buildTavern(
  b: Buckets, w: number, d: number, h: number, flames?: SettlementFlame[],
): void {
  const hw = w / 2, hd = d / 2;
  const g = h * 0.52;            // ground-floor height
  const jx = hw + 0.3, jz = hd + 0.34;

  skirt(b, hw, hd);
  boxN(b[PAL_STONE], -hw, 0.08, -hd, hw, 0.5, hd);
  bevelBoxN(b[PAL_PLASTER], -hw, 0.4, -hd, hw, g, hd);
  timberFrame(b, hw, hd, 0.4, g, PAL_WOOD);
  // Jettied upper storey, overhanging the street.
  bevelBoxN(b[PAL_PLASTER], -jx, g, -jz, jx, h, hd);
  timberFrame(b, jx, (jz + hd) / 2, g, h, PAL_TIMBER, (hd - jz) / 2, 1);
  // Brackets under the jetty.
  for (const sx of [-1, -0.35, 0.35, 1]) {
    beam(b[PAL_WOOD],
      sx * hw * 0.92, g - 0.55, -hd, sx * hw * 0.92, g + 0.02, -jz + 0.06, 0.07, 0.07);
  }

  // Wide double door with a heavy lintel.
  boxN(b[PAL_TIMBER], -0.72, 0.4, -hd - 0.08, 0.72, 2.1, -hd + 0.02);
  boxN(b[PAL_WOOD], -0.05, 0.4, -hd - 0.1, 0.05, 2.1, -hd - 0.06);
  boxN(b[PAL_WOOD], -0.85, 2.05, -hd - 0.12, 0.85, 2.25, -hd + 0.02);
  boxN(b[PAL_STONE], -0.95, 0.02, -hd - 0.55, 0.95, 0.16, -hd - 0.02);
  // Ground windows either side, upper windows shuttered.
  for (const sx of [-1, 1]) {
    windowNZ(b[PAL_TIMBER], b[PAL_WOOD], sx * hw * 0.62, 1.0, -hd, 0.7, 0.72);
  }
  for (const sx of [-1, 0, 1]) {
    windowNZ(b[PAL_TIMBER], b[PAL_WOOD], sx * jx * 0.58, g + 0.55, -jz, 0.62, 0.7);
  }
  windowBox(b[PAL_WOOD], b[PAL_LEAF], b[PAL_BERRY], 0, g + 0.5, -jz, 0.7);

  // Chimney through the roof.
  const rise = d * 0.46;
  bevelBoxN(b[PAL_STONE], hw - 0.2, h - 1.0, hd - 1.4, hw + 0.75, h + rise + 0.7, hd - 0.4);
  boxN(b[PAL_STONE], hw - 0.32, h + rise + 0.66, hd - 1.52, hw + 0.87, h + rise + 0.82, hd - 0.28);
  saggedRoof(b[PAL_THATCH], b[PAL_PLASTER], w + 0.6, d + 0.34, h, rise, 0.34, 0.18, 3);
  boxN(b[PAL_THATCH], -w / 2 - 0.5, h + rise - 0.12, -0.13, w / 2 + 0.5, h + rise + 0.08, 0.13);

  // Hanging sign on a wrought bracket.
  const sy = g + 0.35;
  boxN(b[PAL_TIMBER], hw * 0.5, sy, -jz - 0.06, hw * 0.5 + 0.09, sy + 0.12, -jz - 1.35);
  beam(b[PAL_TIMBER], hw * 0.5 + 0.04, sy, -jz - 0.06, hw * 0.5 + 0.04, sy - 0.7, -jz - 0.7, 0.04, 0.04);
  boxN(b[PAL_WOOD], hw * 0.5 - 0.03, sy - 0.92, -jz - 1.3, hw * 0.5 + 0.12, sy - 0.06, -jz - 0.52);
  boxN(b[PAL_BERRY], hw * 0.5 - 0.05, sy - 0.76, -jz - 1.16, hw * 0.5 + 0.14, sy - 0.24, -jz - 0.66);

  // Lantern over the door — a real light at night.
  boxN(b[PAL_WOOD], -0.06, 2.32, -hd - 0.62, 0.06, 2.5, -hd - 0.04);
  boxN(b[PAL_TORCH], -0.14, 2.05, -hd - 0.66, 0.14, 2.34, -hd - 0.38);
  flames?.push({ x: 0, y: 2.16, z: -hd - 0.52, scale: 0.7 });

  // Barrel and bench outside.
  cylinder(b[PAL_WOOD], -hw + 0.5, 0.02, -hd - 0.85, 0.32, 0.28, 0.75, 8, false, true);
  boxN(b[PAL_TIMBER], -hw + 0.16, 0.72, -hd - 1.2, -hw + 0.84, 0.79, -hd - 0.5);
  boxN(b[PAL_WOOD], hw - 1.9, 0.42, -hd - 1.05, hw - 0.3, 0.52, -hd - 0.55);
  for (const sx of [hw - 1.75, hw - 0.5]) {
    boxN(b[PAL_WOOD], sx - 0.07, 0.02, -hd - 1.0, sx + 0.07, 0.44, -hd - 0.6);
  }
}

// ---------------------------------------------------------------------------
// Longhouse — the communal hall
// ---------------------------------------------------------------------------

/**
 * A longhouse: low stave walls under an enormous turf roof that sags in the
 * middle and comes down almost to the ground on outrigger posts, with crossed
 * finials at both gables. The long axis is local X, so it presents its whole
 * length to the street rather than a gable end.
 */
export function buildLonghouse(b: Buckets, w: number, d: number, h: number): void {
  const hw = w / 2, hd = d / 2;
  skirt(b, hw, hd, 0.5);
  bevelBoxN(b[PAL_STONE], -hw - 0.15, 0.08, -hd - 0.15, hw + 0.15, 0.6, hd + 0.15);
  bevelBoxN(b[PAL_WOOD], -hw, 0.5, -hd, hw, h, hd);
  // Stave planking: vertical splits down both long walls.
  const staves = Math.max(6, Math.round(w / 1.0));
  for (let i = 1; i < staves; i++) {
    const sx = -hw + (i / staves) * w;
    for (const sz of [-1, 1]) {
      boxN(b[PAL_TIMBER], sx - 0.055, 0.5, sz * hd - 0.055, sx + 0.055, h, sz * hd + 0.055);
    }
  }

  const rise = Math.min(d * 0.62, 3.6);
  const o = 0.95;
  // Outrigger posts holding the deep eaves.
  const posts = Math.max(3, Math.round(w / 3.2));
  for (let i = 0; i < posts; i++) {
    const px = -hw + ((i + 0.5) / posts) * w;
    for (const sz of [-1, 1]) {
      cylinder(b[PAL_WOOD], px, -0.5, sz * (hd + o - 0.15), 0.12, 0.1, h + 0.6, 6, false, true);
      beam(b[PAL_WOOD], px, h + 0.05, sz * (hd + o - 0.15), px, h - 0.5, sz * hd, 0.06, 0.06);
    }
  }

  // Turf roof, heavily sagged.
  saggedRoof(b[PAL_LEAF], b[PAL_WOOD], w, d, h, rise, o, 0.3, 4);
  boxN(b[PAL_TIMBER], -hw - o - 0.1, h + rise - 0.14, -0.14, hw + o + 0.1, h + rise + 0.05, 0.14);
  // Smoke louvre astride the ridge.
  boxN(b[PAL_WOOD], -0.7, h + rise - 0.3, -0.42, 0.7, h + rise + 0.55, 0.42);
  boxN(b[PAL_TIMBER], -0.85, h + rise + 0.5, -0.55, 0.85, h + rise + 0.66, 0.55);

  // Crossed gable finials — the silhouette that says "hall", not "shed".
  const D = hd + o;
  for (const sx of [-1, 1]) {
    const gx = sx * (hw + o - 0.12);
    beam(b[PAL_TIMBER], gx, h + rise * 0.45, -D, gx, h + rise + 1.1, D * 0.5, 0.09, 0.05);
    beam(b[PAL_TIMBER], gx, h + rise * 0.45, D, gx, h + rise + 1.1, -D * 0.5, 0.09, 0.05);
  }

  // Main door in the middle of the long -Z wall, with a carved lintel.
  boxN(b[PAL_TIMBER], -0.75, 0.5, -hd - 0.09, 0.75, 2.15, -hd + 0.02);
  boxN(b[PAL_WOOD], -0.92, 2.1, -hd - 0.14, 0.92, 2.34, -hd + 0.02);
  boxN(b[PAL_STONE], -1.05, 0.02, -hd - 0.72, 1.05, 0.16, -hd - 0.04);
  for (const sx of [-1, 1]) {
    boxN(b[PAL_WOOD], sx * 0.86 - 0.09, 0.5, -hd - 0.16, sx * 0.86 + 0.09, 2.2, -hd - 0.02);
  }
  // Two small high openings — the only light a smoky hall gets, and the
  // hearth inside shows through them after dark.
  for (const sx of [-1, 1]) {
    boxN(b[PAL_TORCH], sx * hw * 0.58 - 0.14, h - 0.62, -hd - 0.04,
      sx * hw * 0.58 + 0.14, h - 0.3, -hd + 0.02);
  }
}

// ---------------------------------------------------------------------------
// Smithy
// ---------------------------------------------------------------------------

/**
 * A smithy: three walls and an open working front, a stone forge stack
 * breathing smoke, an anvil on its stump and a quench barrel. The forge bed
 * is emissive and registers a flame anchor, so the edge of a village glows
 * orange at night — which is exactly why the smithy is placed out there.
 */
export function buildSmithy(
  b: Buckets, w: number, d: number, h: number, flames?: SettlementFlame[],
): void {
  const hw = w / 2, hd = d / 2;
  skirt(b, hw, hd);
  bevelBoxN(b[PAL_STONE], -hw, 0.08, -hd, hw, 0.45, hd);
  // Back and side walls only; the -Z front is open to the street.
  bevelBoxN(b[PAL_WOOD], -hw, 0.4, hd - 0.25, hw, h, hd);
  bevelBoxN(b[PAL_WOOD], -hw, 0.4, -hd, -hw + 0.25, h, hd);
  bevelBoxN(b[PAL_WOOD], hw - 0.25, 0.4, -hd, hw, h, hd);
  // Front posts and a head beam over the opening.
  for (const sx of [-1, 1]) {
    cylinder(b[PAL_WOOD], sx * (hw - 0.3), 0.4, -hd + 0.2, 0.13, 0.11, h - 0.4, 6, false, true);
  }
  boxN(b[PAL_TIMBER], -hw, h - 0.3, -hd + 0.08, hw, h - 0.05, -hd + 0.32);
  // Half-height counter across the front, left of the opening.
  boxN(b[PAL_STONE], -hw + 0.2, 0.4, -hd + 0.1, -hw + 1.5, 1.0, -hd + 0.45);

  // Forge stack against the +X wall, through the roof.
  const rise = d * 0.42;
  bevelBoxN(b[PAL_STONE], hw - 1.5, 0.08, hd - 2.0, hw + 0.35, h + rise + 1.5, hd - 0.3);
  boxN(b[PAL_STONE], hw - 1.62, h + rise + 1.44, hd - 2.12, hw + 0.47, h + rise + 1.62, hd - 0.18);
  // Hearth mouth + ember bed.
  boxN(b[PAL_TIMBER], hw - 1.42, 0.75, hd - 2.05, hw - 0.55, 1.55, hd - 1.55);
  boxN(b[PAL_TORCH], hw - 1.32, 0.78, hd - 1.95, hw - 0.65, 1.05, hd - 1.62);
  flames?.push({ x: hw - 1.0, y: 0.95, z: hd - 1.8, scale: 1.2 });
  // Bellows nozzle.
  beam(b[PAL_WOOD], hw - 0.2, 1.2, hd - 2.4, hw - 1.0, 1.05, hd - 1.9, 0.09, 0.09);

  // Anvil on a stump, dead centre of the working floor.
  cylinder(b[PAL_TIMBER], -0.2, 0.4, -0.1, 0.28, 0.26, 0.5, 8, false, true);
  boxN(b[PAL_STONE], -0.46, 0.9, -0.28, 0.06, 1.06, 0.08);
  boxN(b[PAL_STONE], -0.34, 1.02, -0.2, -0.06, 1.16, 0.0);
  // Quench barrel and a rack of stock iron.
  cylinder(b[PAL_WOOD], -hw + 0.75, 0.4, -0.6, 0.34, 0.3, 0.8, 8, false, true);
  for (let i = 0; i < 4; i++) {
    const rx = -hw + 0.55 + i * 0.22;
    boxN(b[PAL_TIMBER], rx - 0.04, 0.45, hd - 0.35, rx + 0.04, 1.9, hd - 0.27);
  }
  // Charcoal heap in the corner.
  boxN(b[PAL_TIMBER], hw - 2.6, 0.4, hd - 0.95, hw - 1.7, 0.95, hd - 0.35);

  roof(b[PAL_THATCH], b[PAL_WOOD], w, d, h, rise, 0.42);
}

// ---------------------------------------------------------------------------
// Windmill
// ---------------------------------------------------------------------------

/**
 * A tower windmill: tapering lime-washed tower, dark boat-shaped cap, and
 * four sails of timber lattice and pale sailcloth. Placed at the edge of a
 * town it is the first thing visible over the horizon, which is the whole
 * job — it puts a silhouette on the skyline that reads as civilisation.
 */
export function buildMill(b: Buckets, w: number, d: number, h: number): void {
  const rBase = Math.min(w, d) * 0.46;
  const rTop = rBase * 0.72;
  boxN(b[PAL_STONE], -rBase - 0.35, -SKIRT_DEPTH, -rBase - 0.35, rBase + 0.35, 0.1, rBase + 0.35);
  cylinder(b[PAL_STONE], 0, 0.05, 0, rBase + 0.2, rBase + 0.12, 0.7, 10, false, false);
  cylinder(b[PAL_PLASTER], 0, 0.6, 0, rBase, rTop, h - 0.6, 10, false, false);
  // Timber bands round the tower.
  for (const by of [h * 0.34, h * 0.66]) {
    const r = rBase + (rTop - rBase) * (by / h);
    cylinder(b[PAL_TIMBER], 0, by, 0, r + 0.05, r + 0.05, 0.16, 10, false, false);
  }
  // Cap.
  cylinder(b[PAL_TIMBER], 0, h, 0, rTop + 0.18, rTop + 0.05, 0.35, 10, false, true);
  cone(b[PAL_TIMBER], 0, h + 0.35, 0, rTop + 0.02, 1.7, 10, false);
  // Tail pole steering the cap, out the back.
  beam(b[PAL_WOOD], 0, h + 0.5, rTop * 0.4, 0, h - 1.6, rTop + 2.6, 0.09, 0.09);

  // Door and two windows on the tower's street side.
  boxN(b[PAL_TIMBER], -0.5, 0.1, -rBase - 0.14, 0.5, 2.0, -rBase + 0.35);
  boxN(b[PAL_STONE], -0.66, 1.94, -rBase - 0.2, 0.66, 2.14, -rBase + 0.3);
  for (const sy of [h * 0.42, h * 0.68]) {
    boxN(b[PAL_TIMBER], -0.26, sy, -rTop - 0.5, 0.26, sy + 0.5, -rTop + 0.2);
  }

  // Sails: four arms of frame + cloth, on a hub at the front of the cap.
  const hubY = h * 0.9;
  const hubZ = -(rTop + 0.55);
  const span = Math.min(h * 0.72, 5.4);
  cylinder(b[PAL_TIMBER], 0, hubY - 0.28, hubZ, 0.24, 0.2, 0.56, 8, true, true);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    bladeXY(b[PAL_TIMBER], 0, hubY, hubZ - 0.1, a, 0.3, span, 0.09, 0.07);
    bladeXY(b[PAL_WOOL], 0, hubY, hubZ - 0.18, a, 0.9, span * 0.95, 0.44, 0.04);
    // Lattice ribs across the sail, spaced along the arm.
    for (let k = 1; k <= 3; k++) {
      const r = 0.9 + (span * 0.92 - 0.9) * (k / 3.4);
      bladeXY(b[PAL_TIMBER],
        Math.sin(a) * r, hubY + Math.cos(a) * r, hubZ - 0.12,
        a + Math.PI / 2, -0.46, 0.46, 0.05, 0.05);
    }
  }
}

// ---------------------------------------------------------------------------
// Town house
// ---------------------------------------------------------------------------

/**
 * A town house: narrow, two storeys, jettied, and — critically — its **gable
 * faces the street**. A row of these shoulder to shoulder is what makes a
 * town street a street instead of a field of detached cottages.
 */
export function buildTownhouse(b: Buckets, w: number, d: number, h: number, v: number): void {
  const hw = w / 2, hd = d / 2;
  const g = h * 0.52;
  const jz = hd + 0.32;
  const boarded = v === 2;
  const wall = boarded ? PAL_WOOD : PAL_PLASTER;
  const roofPal = v === 1 ? PAL_TIMBER : PAL_THATCH;

  skirt(b, hw, hd, 0.24);
  boxN(b[PAL_STONE], -hw, 0.08, -hd, hw, 0.55, hd);
  bevelBoxN(b[wall], -hw, 0.45, -hd, hw, g, hd);
  timberFrame(b, hw, hd, 0.45, g, PAL_WOOD);
  bevelBoxN(b[wall], -hw, g, -jz, hw, h, hd);
  timberFrame(b, hw, (jz + hd) / 2, g, h, PAL_TIMBER, (hd - jz) / 2, 1);
  for (const sx of [-1, 1]) {
    beam(b[PAL_WOOD],
      sx * hw * 0.8, g - 0.5, -hd, sx * hw * 0.8, g + 0.02, -jz + 0.05, 0.06, 0.06);
  }

  // Street door offset to one side, shop shutter beside it on some variants.
  const dx = v === 0 ? -w * 0.2 : w * 0.2;
  boxN(b[PAL_TIMBER], dx - 0.42, 0.45, -hd - 0.08, dx + 0.42, 2.0, -hd + 0.02);
  boxN(b[PAL_STONE], dx - 0.55, 0.02, -hd - 0.42, dx + 0.55, 0.15, -hd - 0.02);
  windowNZ(b[PAL_TIMBER], b[PAL_WOOD], -dx, 1.05, -hd, 0.75, 0.72);
  for (const sx of [-1, 1]) {
    windowNZ(b[PAL_TIMBER], b[PAL_WOOD], sx * hw * 0.44, g + 0.5, -jz, 0.58, 0.72);
  }
  windowBox(b[PAL_WOOD], b[PAL_LEAF], b[PAL_BERRY], -hw * 0.44, g + 0.45, -jz, 0.62);

  // Gable-to-street roof.
  const rise = w * 0.72;
  roofZ(b[roofPal], b[wall], w, d + 0.32, h, rise, 0.26);
  // Chimney riding the ridge at the back.
  bevelBoxN(b[PAL_STONE], -0.34, h + rise * 0.35, hd - 0.85, 0.34, h + rise + 0.55, hd - 0.15);
  boxN(b[PAL_STONE], -0.44, h + rise + 0.5, hd - 0.95, 0.44, h + rise + 0.66, hd - 0.05);
}

// ---------------------------------------------------------------------------
// Granary
// ---------------------------------------------------------------------------

/**
 * A granary raised on staddle stones — mushroom-capped legs that stop rats
 * climbing in. Small, instantly legible, and it says "this settlement has a
 * harvest worth protecting".
 */
export function buildGranary(b: Buckets, w: number, d: number, h: number): void {
  const hw = w / 2, hd = d / 2;
  const floor = 0.85;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const px = sx * (hw - 0.45), pz = sz * (hd - 0.45);
      cylinder(b[PAL_STONE], px, -0.4, pz, 0.2, 0.16, 0.85, 6, false, false);
      cylinder(b[PAL_STONE], px, 0.42, pz, 0.34, 0.18, 0.26, 6, false, true);
    }
  }
  boxN(b[PAL_TIMBER], -hw, floor - 0.16, -hd, hw, floor, hd);
  bevelBoxN(b[PAL_WOOD], -hw, floor, -hd, hw, floor + h, hd);
  const staves = Math.max(3, Math.round(w / 0.9));
  for (let i = 1; i < staves; i++) {
    const sx = -hw + (i / staves) * w;
    for (const sz of [-1, 1]) {
      boxN(b[PAL_TIMBER], sx - 0.05, floor, sz * hd - 0.05, sx + 0.05, floor + h, sz * hd + 0.05);
    }
  }
  boxN(b[PAL_TIMBER], -0.4, floor, -hd - 0.07, 0.4, floor + 1.5, -hd + 0.02);
  // Ladder up to the door.
  for (const sx of [-0.32, 0.32]) {
    beam(b[PAL_WOOD], sx, 0, -hd - 0.85, sx, floor + 0.15, -hd - 0.12, 0.05, 0.05);
  }
  for (let i = 1; i <= 3; i++) {
    const t = i / 4;
    boxN(b[PAL_WOOD], -0.34, t * (floor + 0.15) - 0.04, -hd - 0.85 + t * 0.73,
      0.34, t * (floor + 0.15) + 0.04, -hd - 0.75 + t * 0.73);
  }
  roof(b[PAL_THATCH], b[PAL_WOOD], w, d, floor + h, d * 0.48, 0.34);
}
