/**
 * Castle Vhaeron — the grand keep the player escapes at the start of the game.
 *
 * This module is PURE: no GPU, no DOM, no `?raw` imports. It produces the
 * complete plan of the castle (collision volumes, walkable surfaces, ceilings,
 * props, spawn points) in CASTLE-LOCAL coordinates, plus the world transform.
 * Everything else — the mesh builder, the collider, the manager, the tests —
 * reads this one description. Keeping it pure is what lets `tsx` run the
 * reachability proof in `scripts/test-castle-layout.mts` with no browser.
 *
 * ## Coordinate frame
 *
 * Local space is centred on the keep: +X east, +Z south, +Y up, and **y = 0 is
 * the courtyard**. World space is `local + origin`, a pure translation (the
 * object uniform can only translate — see `shaders/dungeon.wgsl`), so the
 * castle is axis-aligned in the world and every rect below stays an AABB.
 *
 * ## Why the castle sits on a motte
 *
 * There is no flat ground on this landmass. Measured over the 120 x 108 m
 * footprint, the flattest site within 400 m of the origin still varies by
 * ~16 m (scripts/_probe-castle-site.mts, since deleted). So the castle stands
 * on a battered stone plinth whose top is 1 m above the highest terrain in the
 * footprint and whose skirt drops below the lowest. Terrain is never consulted
 * inside the footprint, so it cannot poke through a courtyard. This is also
 * why the breach faces the high side: the drop to open ground there is ~4 m,
 * which a rubble ramp covers comfortably.
 *
 * ## The three collision primitives
 *
 * A multi-level castle cannot be expressed as a 2D cell grid — the existing
 * `DungeonCollider`/`BuildingCollider` both return a CONSTANT from
 * `groundHeight()`, so a stairwell is not representable in either. Instead:
 *
 *   - `Solid`   — an AABB that blocks XZ movement where it overlaps the
 *                 player's body span. Walls, piers, merlons.
 *   - `Support` — a walkable plane over a rect. Flat when the gradients are
 *                 zero, a ramp otherwise. Floors, courtyards, stairs.
 *   - `Ceiling` — a rect with an underside height, for the head clamp.
 *
 * Floors are Supports and NOT Solids, deliberately: a floor slab modelled as a
 * Solid would block the player standing on the storey below it, because the
 * XZ test cannot know which side of it they are on.
 */

import { mulberry32 } from '../mesh-utils';

// --- palette indices (mirror settlement-palette.ts / dungeon.wgsl) ---------

/**
 * Rough rock. The MOTTE and the ruined causeway only — everything the castle
 * builders cut and coursed uses `PAL_ASHLAR` instead.
 *
 * The whole castle shipped on this one index, and on the surface path palette 0
 * resolves to `MAT.STONE`, whose baked layer is the crazy-paving boulder rock
 * the terrain uses. A 26 m keep faced in boulder rock reads as an extrusion of
 * the hillside, not as masonry, and that is most of why the first build looked
 * like grey boxes. Rough rock is still right for the thing the castle stands
 * ON, so the index stays — it just stopped being the default.
 */
export const PAL_STONE = 0;
export const PAL_TORCH = 2;
export const PAL_THATCH = 4;  // straw: the cell pallets, the feeding-yard litter
export const PAL_DARKWOOD = 8;
export const PAL_IRON = 12;   // portcullis, sconces, door bands, spikes
export const PAL_GOLD = 17;   // throne, crown mouldings
export const PAL_SOOT = 18;   // scorched rubble and the battered plinth face
// 23..31: appended for this castle. See `palette()` in shaders/dungeon.wgsl and
// `paletteMaterial()` in render/material-table.ts — all three must agree.
export const PAL_ASHLAR = 23;  // cut grey masonry: INTERIOR wall faces + floors
export const PAL_BASALT = 24;  // cut black masonry: interior bases, capitals
export const PAL_CRIMSON = 25; // crimson felt: banners, carpet, the throne
export const PAL_BLACKFELT = 26; // black felt: banner fields, hangings
export const PAL_GLASS = 27;   // the red lancets — emissive
export const PAL_SLATE = 28;   // spires and pitched roofs
export const PAL_BONE = 29;    // the dragon's feeding yard

/**
 * The exterior pair. Everything the world sees from outside is one of these
 * two and nothing else, which is the whole reason they exist.
 *
 * The castle used to face its outside in `PAL_ASHLAR` — a value chosen so a
 * torch-lit hall stays readable, then shown in daylight through 200 m of
 * aerial haze. That reads as a royal palace in light grey. Darkening ashlar
 * far enough to fix it takes every interior down with it, so the outside gets
 * its own pair: `PAL_VOID` for the mass, `PAL_GRAVE` for the dressings that
 * keep the mass from collapsing into a silhouette.
 *
 * The rule for which is which: if it is WALL, it is void; if it is a course, a
 * corbel, a cap, a sill, a jamb or a step, it is grave.
 */
export const PAL_VOID = 30;    // the exterior mass — near-black, outdoors only
export const PAL_GRAVE = 31;   // exterior dressings — courses, caps, surrounds

/**
 * Every palette the castle emits, in draw order.
 *
 * One draw call each, so this list is the castle's draw-call count. Sixteen
 * against the settlement's eleven, for a building an order of magnitude larger
 * and the only one the player is ever inside at the start and on top of at the
 * end. Sixteen is also the ceiling `test-castle-layout.mts` asserts, so a new
 * castle palette from here on has to replace one rather than join them.
 */
export const CASTLE_PALETTES = [
  PAL_STONE, PAL_ASHLAR, PAL_BASALT, PAL_SLATE,
  PAL_TORCH, PAL_GLASS, PAL_CRIMSON, PAL_BLACKFELT,
  PAL_THATCH, PAL_DARKWOOD, PAL_IRON, PAL_GOLD,
  PAL_SOOT, PAL_BONE, PAL_VOID, PAL_GRAVE,
] as const;

// --- dimensions -----------------------------------------------------------

/** Outer curtain wall: half-extents of the OUTER face, in metres. */
export const OUTER_HX = 60;
export const OUTER_HZ = 54;
/**
 * Curtain wall thickness, and the two heights that make it a wall-walk.
 *
 * `WALL_WALK` is the deck. `WALL_H` is the top of the merlons standing on it,
 * so the parapet is `WALL_H - WALL_WALK` = 1.4 m of tooth.
 *
 * THE CURTAIN MASS IS BUILT TO `WALL_WALK`, NOT TO `WALL_H`. It used to be one
 * `wall()` from 0 to `WALL_H` at full thickness with the deck declared as a
 * Support 1.4 m INSIDE it, which meant `blocked(feet + STEP_UP, feet + PLAYER_H)`
 * — 8.2 to 9.3 for a walker on the deck — hit solid rock everywhere, and all
 * 200 m of wall-walk was a plane you could stand on and not move off. Both
 * courtyard stairs dead-ended in it. The 40-odd merlons per run already occupy
 * 7.6..9.0 on the outer metre, so they ARE the parapet: build the mass to the
 * deck and let them be what they were modelled as.
 */
export const WALL_T = 3.0;
export const WALL_H = 9.0;
export const WALL_WALK = 7.6;

/**
 * Head height where the wall-walk tunnels through a mass.
 *
 * The deck has to cross four corner towers and both gatehouse piers, and those
 * are 11 m and 13 m of solid stone standing across it. `blocked()` tests
 * [feet + STEP_UP, feet + PLAYER_H] = 8.2..9.3, so a passage roof anywhere
 * below 9.3 stops the walker dead — 2.0 m of clear head is the smallest figure
 * that is not a knife edge. It lands 0.6 m above the merlon tops, which is
 * inside the tower, where nobody ever sees it.
 */
export const WALL_PASS_TOP = WALL_WALK + 2.0;

/**
 * How much stone the wall-walk passage leaves on a corner tower's OUTER faces.
 *
 * The deck ring runs in the outer 3 m of the curtain and the corner towers sit
 * flush with that outer face, so a passage straight through one would be a
 * 2 m slot cut in the tower's outside. Keeping 0.6 m of skin turns it into a
 * mural gallery — the passage bends round the inside of the tower's outer
 * corner and the silhouette never knows.
 */
export const TOWER_SKIN = 0.6;

/** Corner tower footprint half-extent and height. */
export const CORNER_TOWER_H = 11.0;
export const CORNER_TOWER_HEIGHT = 16.0;

/** Keep footprint (half-extents) and per-level geometry. */
export const KEEP_HX = 27;
export const KEEP_HZ = 24;
/** Floor y for each keep level, index 0 = undercroft. */
export const LEVEL_Y = [-8.5, 0, 8, 16] as const;
/**
 * Ceiling y for each keep level.
 *
 * Each is exactly SLAB_T below the floor above, because the floor slabs are
 * what draws them: `buildCastleMesh` emits a slab under every walkable surface,
 * so a ceiling that did not line up with `floor - SLAB_T` would be a plane the
 * player's head stops at with nothing visible there.
 */
export const LEVEL_CEIL = [-1.0, 7.0, 15.0, 23.0] as const;
/** Thickness of every floor slab. Mesh and ceiling heights both depend on it. */
export const SLAB_T = 1.0;
export const KEEP_ROOF_Y = 24.0;
export const KEEP_PARAPET_Y = 26.5;

/** The dragon tower rises out of the keep roof. */
export const TOWER_R = 19.0;
export const TOWER_BASE_Y = 24.0;
export const ARENA_Y = 34.0;
export const ARENA_R = 17.0;
export const ARENA_PARAPET_Y = 36.5;

/**
 * The heights of the castle's OPEN-AIR decks: wall-walk, keep roof, arena.
 *
 * `buildCastleMesh` derives every floor slab from the collision surfaces, so
 * they all shared one palette and all three of these came out in ashlar — an
 * interior value, in full sun, on the three largest horizontal planes anyone
 * ever sees from outside. The arena in particular read as a white disc.
 *
 * Matched by height rather than by rect because the rects move: `cutSupport`
 * splits them around stairwells, and `fitBreachRamp` splits the courtyard. Each
 * of these three heights belongs to exactly one deck and to nothing else, which
 * is why y = 0 is deliberately NOT here — the courtyard and the keep's level-1
 * floor share it, and they are an outdoor and an indoor surface.
 */
export const OPEN_DECK_Y = [7.6, 24.0, 34.0] as const;

/**
 * How thick a ramp slab is under its walking surface. The mesh and the
 * collider MUST agree on this: the Support plane is the top face, and
 * `rampSlab` reconstructs that face as `piece.y0 + RAMP_THICKNESS`. Change it
 * in one place only.
 */
export const RAMP_THICKNESS = 0.8;

/** Half-width of the breach in the east curtain wall. */
export const BREACH_HZ = 4.5;

/**
 * How far either side of centre the breach causeway tears the motte face open.
 *
 * The ramp itself is z -5..5 and `fitBreachRamp` puts a 0.9 m kerb outside each
 * edge, so the gap has to clear 5.9 or the causeway runs into its own kerb
 * stones. 6.2 leaves 30 cm of margin and no more: this is a hole in the biggest
 * dark surface the near-gate view has.
 */
export const BREACH_SPILL_HZ = 6.2;
/** How far out from the wall the rubble ramp runs. */
export const BREACH_RAMP_RUN = 16.0;

/**
 * Maximum instantaneous rise the player may walk up.
 *
 * The controller has NO step-up limit — `controller.ts:131` snaps `pos[1]` to
 * whatever `groundHeight()` returns, however large the delta. So the limit has
 * to live here, in the collider, or standing on the courtyard would teleport
 * the player onto the third floor. Every ramp in this file is checked against
 * it by `scripts/test-castle-layout.mts`.
 */
export const STEP_UP = 0.6;

/** Player capsule height, mirrored from controller.ts for the head clamp. */
export const PLAYER_H = 1.7;

// --- primitives -----------------------------------------------------------

/** An AABB that blocks horizontal movement over the span [y0, y1]. */
export interface Solid {
  x0: number; z0: number; x1: number; z1: number;
  y0: number; y1: number;
}

/**
 * A walkable plane over a rect. Height at (x, z) is
 * `y + (x - x0) * dydx + (z - z0) * dydz`. Flat floors leave both zero.
 */
export interface Support {
  x0: number; z0: number; x1: number; z1: number;
  y: number; dydx: number; dydz: number;
}

/** A rect with an underside height — the ceiling the player bonks. */
export interface Ceiling {
  x0: number; z0: number; x1: number; z1: number;
  y: number;
}

/** A lit torch/brazier: a world-space point light plus its billboard scale. */
export interface CastleLight {
  x: number; y: number; z: number;
  /** Billboard flame size; 0 means an invisible fill light. */
  flameScale: number;
  radius: number;
}

/** A named point of interest — used by tests, debug hooks and the manager. */
export interface CastleMarker {
  id: string;
  x: number; y: number; z: number;
}

/** The starter chest in the undercroft. */
export interface CastleChest {
  x: number; y: number; z: number;
  /** Facing, radians, for the mesh. */
  yaw: number;
}

/**
 * One box of geometry to emit, tagged with its palette bucket.
 *
 * Everything past 'ramp' is decoration only — no `Piece` has ever carried
 * collision (that is `Solid`/`Support`), so a spire or an arch can be dropped
 * anywhere the art wants one without the reachability proof having an opinion.
 */
export interface Piece {
  pal: number;
  x0: number; y0: number; z0: number;
  x1: number; y1: number; z1: number;
  /**
   * 'box'   — axis-aligned box, 36 verts
   * 'bevel' — chamfered vertical edges, 84
   * 'ramp'  — sloped-top slab, 36
   * 'pyr'   — four-sided pyramid, 18 (merlon caps, finials)
   * 'spire' — octagonal cone, 42 (tower roofs)
   * 'wedge' — gable prism, 24 (pitched roofs, hoods)
   * 'arch'  — pointed-arch prism, 96 (windows, arcading, doorheads)
   */
  kind: 'box' | 'bevel' | 'ramp' | 'pyr' | 'spire' | 'wedge' | 'arch';
  /**
   * Ramps: which end is high, 0 = +x, 1 = -x, 2 = +z, 3 = -z.
   * Wedges: <2 puts the ridge along x, >=2 along z.
   * Arches: <2 faces the arch into the XY plane, >=2 into the ZY plane.
   */
  rampDir?: number;
  /** Arches only: fraction of the box height at which the curve springs. */
  spring?: number;
}

/** Everything the rest of the system needs. */
export interface CastleLayout {
  solids: Solid[];
  supports: Support[];
  ceilings: Ceiling[];
  pieces: Piece[];
  lights: CastleLight[];
  markers: Map<string, CastleMarker>;
  chest: CastleChest;
  /** Where the player wakes up, local coords. */
  spawn: [number, number, number];
  /** Centre of the wall breach, local coords (the escape threshold). */
  breach: [number, number, number];
  /** Footprint of the whole castle in local XZ, for fast rejection. */
  bounds: { x0: number; z0: number; x1: number; z1: number };
  /** Lowest surface in the castle — the anti-void rescue floor. */
  floorOfLastResort: number;
  /**
   * Which entries in `supports` / `pieces` are the breach ramp, so
   * `fitBreachRamp` can pin its far end to the real hillside. Without this the
   * ramp ends in mid-air at sites where the ground falls away fast, and the
   * escape opens with an unannounced 12 m drop.
   */
  breachRamp: { supportIndex: number; pieceIndex: number };
}

// --- small builders -------------------------------------------------------

/** Push a solid AABB, normalising the corner pair. */
function solid(out: Solid[], x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number): void {
  out.push({
    x0: Math.min(x0, x1), x1: Math.max(x0, x1),
    z0: Math.min(z0, z1), z1: Math.max(z0, z1),
    y0: Math.min(y0, y1), y1: Math.max(y0, y1),
  });
}

/** Push a flat walkable rect at height y. */
function floorAt(out: Support[], x0: number, z0: number,
  x1: number, z1: number, y: number): void {
  out.push({
    x0: Math.min(x0, x1), x1: Math.max(x0, x1),
    z0: Math.min(z0, z1), z1: Math.max(z0, z1),
    y, dydx: 0, dydz: 0,
  });
}

/** Push a ceiling rect. */
function ceilAt(out: Ceiling[], x0: number, z0: number,
  x1: number, z1: number, y: number): void {
  out.push({
    x0: Math.min(x0, x1), x1: Math.max(x0, x1),
    z0: Math.min(z0, z1), z1: Math.max(z0, z1),
    y,
  });
}

/**
 * Push a ramp rising along one axis, plus the matching visual piece.
 *
 * `axis` is 'x' or 'z'; the surface is `yLow` at the min end and `yHigh` at the
 * max end. Reverse the two heights to run downhill. Gradient is asserted
 * against nothing here — `test-castle-layout.mts` proves every ramp is gentle
 * enough that a 6 m/s walk never exceeds STEP_UP in one 1/60 s step.
 */
function ramp(sup: Support[], pieces: Piece[], pal: number,
  x0: number, z0: number, x1: number, z1: number,
  axis: 'x' | 'z', yLow: number, yHigh: number): void {
  const ax0 = Math.min(x0, x1); const ax1 = Math.max(x0, x1);
  const az0 = Math.min(z0, z1); const az1 = Math.max(z0, z1);
  const run = axis === 'x' ? ax1 - ax0 : az1 - az0;
  const g = run > 1e-6 ? (yHigh - yLow) / run : 0;
  sup.push({
    x0: ax0, x1: ax1, z0: az0, z1: az1,
    y: yLow, dydx: axis === 'x' ? g : 0, dydz: axis === 'z' ? g : 0,
  });
  // Visual: a slab under the walking plane so the ramp reads as masonry.
  pieces.push({
    pal, kind: 'ramp',
    x0: ax0, y0: Math.min(yLow, yHigh) - RAMP_THICKNESS, z0: az0,
    x1: ax1, y1: Math.max(yLow, yHigh), z1: az1,
    rampDir: axis === 'x' ? (yHigh > yLow ? 0 : 1) : (yHigh > yLow ? 2 : 3),
  });
}

/** Push a wall: a solid AABB plus the box that draws it. */
function wall(sol: Solid[], pieces: Piece[], pal: number,
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  kind: 'box' | 'bevel' = 'box'): void {
  solid(sol, x0, y0, z0, x1, y1, z1);
  pieces.push({
    pal, kind,
    x0: Math.min(x0, x1), y0: Math.min(y0, y1), z0: Math.min(z0, z1),
    x1: Math.max(x0, x1), y1: Math.max(y0, y1), z1: Math.max(z0, z1),
  });
}

/** Decoration with no collision (banners, trim, merlon caps read as solid). */
function deco(pieces: Piece[], pal: number,
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  kind: 'box' | 'bevel' = 'box'): void {
  pieces.push({
    pal, kind,
    x0: Math.min(x0, x1), y0: Math.min(y0, y1), z0: Math.min(z0, z1),
    x1: Math.max(x0, x1), y1: Math.max(y0, y1), z1: Math.max(z0, z1),
  });
}

/** Decoration in one of the non-box shapes. `dir`/`spring` per `Piece`. */
function shape(pieces: Piece[], pal: number, kind: Piece['kind'],
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  dir = 0, spring = 0.55): void {
  pieces.push({
    pal, kind,
    x0: Math.min(x0, x1), y0: Math.min(y0, y1), z0: Math.min(z0, z1),
    x1: Math.max(x0, x1), y1: Math.max(y0, y1), z1: Math.max(z0, z1),
    rampDir: dir, spring,
  });
}

/**
 * Which way a piece of wall dressing looks: 0 = -Z, 1 = +Z, 2 = -X, 3 = +X.
 *
 * Every façade helper below takes one of these plus the coordinate of the wall
 * SURFACE it dresses, and works out the rest. Writing them per-face by hand was
 * the first attempt and produced four near-copies of each helper, three of
 * which had a sign wrong somewhere and put the moulding inside the wall.
 */
type Face = 0 | 1 | 2 | 3;

/** True when the face looks along Z (so the dressing spans X). */
const facesZ = (f: Face): boolean => f < 2;
/** +1 when the face looks toward positive coordinates on its axis. */
const faceSign = (f: Face): number => (f === 1 || f === 3 ? 1 : -1);

/**
 * A moulded pointed arch standing on a wall face — the workhorse of the whole
 * rectification. Windows, blind arcading and doorheads are all this.
 *
 * `cu` is the centre along the wall, `hw` the opening half-width, `[y0, y1]`
 * its height, `surf` the coordinate of the wall's outer skin.
 *
 * NOTHING IS CUT. The frame is a shallow arch slab sitting ON the wall and the
 * fill is a smaller one sitting on the frame, so what the eye reads as a
 * recessed opening is actually two slabs of relief. That is deliberate: a real
 * hole would have to come out of `Solid`, and the castle's 79-assertion
 * reachability proof is built on the collision volumes being exactly what they
 * were. Relief costs 192 verts and risks nothing.
 */
function archPanel(pieces: Piece[], palFrame: number, palFill: number,
  face: Face, cu: number, hw: number, y0: number, y1: number, surf: number,
  spring = 0.58): void {
  const sgn = faceSign(face);
  const f0 = surf;
  const f1 = surf + sgn * 0.26;          // frame projection
  const g1 = surf + sgn * 0.42;          // fill sits proud of the frame
  const g0 = surf + sgn * 0.24;
  // The fill is inset from the frame on every side, which is what leaves a
  // moulded rim visible around it.
  const iw = Math.max(hw * 0.40, hw - 0.30);
  const dir = facesZ(face) ? 0 : 2;
  if (facesZ(face)) {
    shape(pieces, palFrame, 'arch', cu - hw, y0, f0, cu + hw, y1, f1, dir, spring);
    shape(pieces, palFill, 'arch', cu - iw, y0 + 0.16, g0, cu + iw, y1 - 0.30, g1,
      dir, spring);
  } else {
    shape(pieces, palFrame, 'arch', f0, y0, cu - hw, f1, y1, cu + hw, dir, spring);
    shape(pieces, palFill, 'arch', g0, y0 + 0.16, cu - iw, g1, y1 - 0.30, cu + iw,
      dir, spring);
  }
}

/**
 * Voussoir ring — the wedge blocks that turn a rectangular hole into an arch.
 *
 * The companion to `archPanel` and the only one of the two that can go over a
 * REAL opening, because it is a ring of blocks with nothing in the middle. The
 * gate passage and the keep's great door are genuine gaps in the collision
 * layer, so anything drawn across them would be a wall the player walks
 * through; this leaves the hole alone and just makes it read as arched.
 */
function archRing(pieces: Piece[], pal: number, face: Face, cu: number,
  hw: number, ySpring: number, surf: number, out: number, n = 5): void {
  const sgn = faceSign(face);
  const w0 = surf;
  const w1 = surf + sgn * out;
  // Same two-centred construction as `Sink.arch`, so a ringed opening and a
  // blind arch beside it describe the same curve.
  const rise = hw * 1.38;
  const c = (rise * rise - hw * hw) / (2 * hw);
  const R = hw + c;
  const aEnd = Math.atan2(rise, c);
  // k runs springing (|k| = n) to apex (k = 0) and out again, so the keystone
  // falls naturally at k = 0 where `Math.sign` puts it on the centreline.
  for (let k = -n; k <= n; k++) {
    const a = (aEnd * (n - Math.abs(k))) / n;
    const u = cu + Math.sign(k) * (R * Math.cos(a) - c);
    const v = ySpring + R * Math.sin(a);
    // The keystone is wider, because an arch without one reads as a row of
    // identical bricks bent into a curve.
    const key = k === 0 ? 0.46 : 0.32;
    if (facesZ(face)) {
      deco(pieces, pal, u - key, v - 0.34, w0, u + key, v + 0.36, w1);
    } else {
      deco(pieces, pal, w0, v - 0.34, u - key, w1, v + 0.36, u + key);
    }
  }
}

/**
 * A window: `archPanel` in red glass, on a sill, under a hood.
 *
 * Only ever used on an exterior face, so the whole surround is `PAL_GRAVE`:
 * a pewter aedicule with a red light in it, standing off near-black wall. The
 * frame used to be basalt, which against the old ashlar was a dark ring on a
 * pale wall and against voidstone would be nothing at all.
 */
function lancet(pieces: Piece[], face: Face, cu: number, hw: number,
  y0: number, y1: number, surf: number): void {
  const sgn = faceSign(face);
  archPanel(pieces, PAL_GRAVE, PAL_GLASS, face, cu, hw, y0, y1, surf, 0.60);
  // Sill below and a keystone block at the apex. Both are what stop a window
  // reading as a sticker: real openings interrupt the coursing above and below.
  const s0 = surf;
  const s1 = surf + sgn * 0.44;
  if (facesZ(face)) {
    deco(pieces, PAL_GRAVE, cu - hw - 0.30, y0 - 0.26, s0, cu + hw + 0.30, y0, s1);
    deco(pieces, PAL_GRAVE, cu - 0.26, y1 - 0.12, s0, cu + 0.26, y1 + 0.30, s1);
  } else {
    deco(pieces, PAL_GRAVE, s0, y0 - 0.26, cu - hw - 0.30, s1, y0, cu + hw + 0.30);
    deco(pieces, PAL_GRAVE, s0, y1 - 0.12, cu - 0.26, s1, y1 + 0.30, cu + 0.26);
  }
}

/**
 * An arrow slit: a black cross-slot in a shallow dressed surround.
 *
 * Exterior only, so surround and slot swapped tones with the rest of the
 * outside — the pale part is the dressing and the dark part is the hole.
 */
function arrowSlit(pieces: Piece[], face: Face, cu: number, y: number,
  h: number, surf: number): void {
  const sgn = faceSign(face);
  const a0 = surf; const a1 = surf + sgn * 0.16;
  const b1 = surf + sgn * 0.30;
  if (facesZ(face)) {
    deco(pieces, PAL_GRAVE, cu - 0.44, y - 0.30, a0, cu + 0.44, y + h + 0.30, b1);
    deco(pieces, PAL_VOID, cu - 0.10, y, a1, cu + 0.10, y + h, b1 + sgn * 0.02);
    deco(pieces, PAL_VOID, cu - 0.40, y + h * 0.62, a1,
      cu + 0.40, y + h * 0.62 + 0.20, b1 + sgn * 0.02);
  } else {
    deco(pieces, PAL_GRAVE, a0, y - 0.30, cu - 0.44, b1, y + h + 0.30, cu + 0.44);
    deco(pieces, PAL_VOID, a1, y, cu - 0.10, b1 + sgn * 0.02, y + h, cu + 0.10);
    deco(pieces, PAL_VOID, a1, y + h * 0.62, cu - 0.40,
      b1 + sgn * 0.02, y + h * 0.62 + 0.20, cu + 0.40);
  }
}

/**
 * Machicolation: a projecting band on corbels, so the parapet overhangs.
 *
 * This is the single biggest change to the castle's silhouette from outside.
 * A wall that stops in a flat plane reads as a fence however tall it is; a wall
 * whose top course steps OUT over a row of brackets reads as fortification,
 * because the shadow line under it draws the eye along the whole run.
 */
function machicolation(pieces: Piece[], face: Face, a0: number, a1: number,
  surf: number, y: number, step = 3.0): void {
  const sgn = faceSign(face);
  // Keyed 0.3 m INTO the wall: a corbel that merely touches the face shows a
  // hairline of sky between bracket and masonry at grazing angles.
  const b0 = surf - sgn * 0.30; const b1 = surf + sgn * 0.72;
  const n = Math.max(1, Math.round((a1 - a0) / step));
  for (let i = 0; i <= n; i++) {
    const u = a0 + ((a1 - a0) * i) / n;
    if (facesZ(face)) {
      deco(pieces, PAL_GRAVE, u - 0.34, y - 1.05, b0, u + 0.34, y, b1);
    } else {
      deco(pieces, PAL_GRAVE, b0, y - 1.05, u - 0.34, b1, y, u + 0.34);
    }
  }
  // The band the corbels carry.
  if (facesZ(face)) {
    deco(pieces, PAL_GRAVE, a0 - 0.4, y, b0, a1 + 0.4, y + 0.62, b1);
  } else {
    deco(pieces, PAL_GRAVE, b0, y, a0 - 0.4, b1, y + 0.62, a1 + 0.4);
  }
}

/**
 * A dark skin over one exterior wall face.
 *
 * The keep's shell walls are two metres thick and their INNER face is the great
 * hall's wall, so the palette that makes the outside black would make the
 * inside a cave — which is exactly why the last pass stopped at one step of
 * darkening. A skin solves it: 15 cm of `PAL_VOID` standing on the outer face,
 * keyed 5 cm into the masonry so no two coplanar faces ever fight for depth.
 *
 * It is a `deco`, so it carries no collision. Seven centimetres and not more:
 * it has to stay UNDER every piece of dressing already on that wall, and the
 * shallowest of those is a banner's felt at 16 cm. The first version stood 15 cm
 * proud and swallowed the banners whole, leaving their front faces one
 * centimetre off the skin — buried and flickering at the same time.
 *
 * The curtain wall, the corner towers and the gatehouse piers need none of
 * this: both their faces are outdoors, so those just take `PAL_VOID` outright.
 */
function clad(pieces: Piece[], face: Face, a0: number, a1: number,
  y0: number, y1: number, surf: number): void {
  const sgn = faceSign(face);
  const w0 = surf - sgn * 0.05;
  const w1 = surf + sgn * 0.07;
  if (facesZ(face)) deco(pieces, PAL_VOID, a0, y0, w0, a1, y1, w1);
  else deco(pieces, PAL_VOID, w0, y0, a0, w1, y1, a1);
}

/**
 * A run of saddle stitches across a band on a wall face.
 *
 * This is the castle admitting what it is made of. The baked QUILT layer
 * already stitches every joint at 6 cm, which reads from arm's length and mips
 * away past about fifteen metres; these are the BIG stitches, 30 cm of thread
 * whipped over a string course every few metres, and they are what says "sewn"
 * from across a courtyard. Alternate stitches lean the other way, because a row
 * of identical uprights is a railing and a row of leaning ones is handwork.
 *
 * Cheap on purpose: one box each. The same run drawn as chevrons doubled the
 * cost for a difference nobody could see past ten metres.
 */
function stitchRun(pieces: Piece[], face: Face, a0: number, a1: number,
  surf: number, y0: number, y1: number, pitch: number): void {
  const sgn = faceSign(face);
  const w0 = surf - sgn * 0.04;
  const w1 = surf + sgn * 0.20;
  const n = Math.max(1, Math.round((a1 - a0) / pitch));
  for (let i = 0; i <= n; i++) {
    const u = a0 + ((a1 - a0) * i) / n;
    const lean = (i & 1) === 0 ? 0.13 : -0.13;
    if (facesZ(face)) {
      deco(pieces, PAL_GRAVE, u - 0.15 - lean, y0, w0, u + 0.15 + lean, y1, w1);
    } else {
      deco(pieces, PAL_GRAVE, w0, y0, u - 0.15 - lean, w1, y1, u + 0.15 + lean);
    }
  }
}

/**
 * A hanging banner: black felt field, crimson bar, on an iron rail.
 *
 * Three pieces and it is the loudest thing on any wall it is put on, because
 * it is the only saturated colour in the castle's exterior palette and it hangs
 * vertically across the horizontal coursing.
 */
function banner(pieces: Piece[], face: Face, cu: number, hw: number,
  yTop: number, yBot: number, surf: number): void {
  const sgn = faceSign(face);
  const f0 = surf + sgn * 0.04;
  const f1 = surf + sgn * 0.16;
  const g1 = surf + sgn * 0.24;
  const railOut = surf + sgn * 0.34;
  const barTop = yTop - (yTop - yBot) * 0.34;
  const barBot = yTop - (yTop - yBot) * 0.72;
  if (facesZ(face)) {
    deco(pieces, PAL_BLACKFELT, cu - hw, yBot, f0, cu + hw, yTop, f1);
    deco(pieces, PAL_CRIMSON, cu - hw * 0.62, barBot, f1, cu + hw * 0.62, barTop, g1);
    deco(pieces, PAL_IRON, cu - hw - 0.22, yTop, surf, cu + hw + 0.22, yTop + 0.20, railOut);
    // Hem, stepped to a point. A banner cut off square reads as a painted
    // rectangle; two courses of taper read as cloth with a weight in it.
    deco(pieces, PAL_BLACKFELT, cu - hw * 0.66, yBot - 0.45, f0, cu + hw * 0.66, yBot, f1);
    deco(pieces, PAL_CRIMSON, cu - hw * 0.26, yBot - 0.80, f0, cu + hw * 0.26, yBot - 0.40, f1);
  } else {
    deco(pieces, PAL_BLACKFELT, f0, yBot, cu - hw, f1, yTop, cu + hw);
    deco(pieces, PAL_CRIMSON, f1, barBot, cu - hw * 0.62, g1, barTop, cu + hw * 0.62);
    deco(pieces, PAL_IRON, surf, yTop, cu - hw - 0.22, railOut, yTop + 0.20, cu + hw + 0.22);
    deco(pieces, PAL_BLACKFELT, f0, yBot - 0.45, cu - hw * 0.66, f1, yBot, cu + hw * 0.66);
    deco(pieces, PAL_CRIMSON, f0, yBot - 0.80, cu - hw * 0.26, f1, yBot - 0.40, cu + hw * 0.26);
  }
}

/**
 * A great hanging — a felt drop the height of a storey, on a ringed rail.
 *
 * `banner` is 3 m of cloth and it is dressing. This is 8 m of it and it is
 * ARCHITECTURE: on a black wall it is the only saturated thing in the view, and
 * it is what turns "a dark fortress" into "the dark fortress of a man whose
 * colour is red". Six times the area of a banner for four times the pieces.
 *
 * The parts that make it read as made rather than painted on: iron rings
 * clipped over the rail at intervals, so the top edge has fixings; a crimson
 * panel inset far enough that a black margin runs all the way round; a hem of
 * stitches along the bottom; and a pointed tail with a weight in it.
 */
function greatHanging(pieces: Piece[], face: Face, cu: number, hw: number,
  yTop: number, yBot: number, surf: number): void {
  const sgn = faceSign(face);
  const f0 = surf + sgn * 0.05;
  const f1 = surf + sgn * 0.22;      // the felt field
  const g1 = surf + sgn * 0.33;      // the crimson panel, proud of the field
  const railOut = surf + sgn * 0.46;
  const pw = hw * 0.66;
  const pTop = yTop - (yTop - yBot) * 0.16;
  const pBot = yTop - (yTop - yBot) * 0.80;
  const put = (pal: number, u0: number, v0: number, w0: number,
    u1: number, v1: number, w1: number): void => {
    if (facesZ(face)) deco(pieces, pal, u0, v0, w0, u1, v1, w1);
    else deco(pieces, pal, w0, v0, u0, w1, v1, u1);
  };
  put(PAL_BLACKFELT, cu - hw, yBot, f0, cu + hw, yTop, f1);
  put(PAL_CRIMSON, cu - pw, pBot, f1, cu + pw, pTop, g1);
  // Rail and the rings hung over it.
  put(PAL_IRON, cu - hw - 0.35, yTop, surf, cu + hw + 0.35, yTop + 0.26, railOut);
  for (let i = 0; i <= 5; i++) {
    const u = cu - hw * 0.86 + (hw * 1.72 * i) / 5;
    // From the wall face, not from the felt's back: a ring starting where the
    // felt starts puts two back faces in one plane 5 cm off the masonry.
    put(PAL_IRON, u - 0.09, yTop - 0.30, surf, u + 0.09, yTop + 0.34, railOut);
  }
  // Hem: a course of stitches along the bottom edge, then the weighted tail.
  for (let i = 0; i <= 6; i++) {
    const u = cu - hw * 0.88 + (hw * 1.76 * i) / 6;
    put(PAL_GRAVE, u - 0.11, yBot - 0.02, f1 - sgn * 0.01, u + 0.11, yBot + 0.30,
      f1 + sgn * 0.07);
  }
  put(PAL_BLACKFELT, cu - hw * 0.64, yBot - 0.95, f0, cu + hw * 0.64, yBot, f1);
  // The tail's crimson tip rides on the black the way the panel does, f1 -> g1.
  // Sharing f0 -> f1 with the tail put the two felts in one plane where their
  // heights overlap, which is the same fault as the floor and just smaller.
  put(PAL_CRIMSON, cu - hw * 0.28, yBot - 1.55, f1, cu + hw * 0.28, yBot - 0.80, g1);
  put(PAL_IRON, cu - 0.14, yBot - 1.85, f0, cu + 0.14, yBot - 1.45, f1);
}

/**
 * Crown a square tower: corbel table, capped merlons, slate spire, finial.
 *
 * The spire is the whole reason this exists. Four towers that stop in flat
 * crenellated stumps make a compound; four towers with tall pitched roofs make
 * the shape a child draws when you say "castle", and the villain's version of
 * that shape is the same silhouette in black slate with red pennants on it.
 */
function towerCrown(pieces: Piece[], cx: number, cz: number, half: number,
  yTop: number, merlonH: number, spireTop: number, teeth: number): void {
  for (const f of [0, 1, 2, 3] as const) {
    const surf = (f === 0 ? cz - half : f === 1 ? cz + half
      : f === 2 ? cx - half : cx + half);
    const a = f < 2 ? cx : cz;
    machicolation(pieces, f, a - half, a + half, surf, yTop, 2.4);
  }
  const bandTop = yTop + 0.62;
  // Merlons stepped round the parapet, each with a pyramid cap. A square tooth
  // is a box; a capped tooth is a battlement, and the caps are 18 verts each.
  const r = half + 0.4;
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    const mx = cx + Math.cos(a) * r;
    const mz = cz + Math.sin(a) * r;
    deco(pieces, PAL_VOID, mx - 0.72, bandTop, mz - 0.72,
      mx + 0.72, bandTop + merlonH, mz + 0.72);
    shape(pieces, PAL_GRAVE, 'pyr', mx - 0.86, bandTop + merlonH, mz - 0.86,
      mx + 0.86, bandTop + merlonH + 0.62, mz + 0.86);
  }
  // The spire, seated inside the merlon ring so the teeth read against it.
  const sh = half * 0.94;
  const base = bandTop + merlonH * 0.35;
  shape(pieces, PAL_SLATE, 'spire', cx - sh, base, cz - sh, cx + sh, spireTop, cz + sh);
  // Finial: an iron spike with a crimson pennant, which is what puts the king's
  // colour on the very top of every tower he owns.
  deco(pieces, PAL_IRON, cx - 0.14, spireTop - 0.4, cz - 0.14,
    cx + 0.14, spireTop + 2.2, cz + 0.14);
  deco(pieces, PAL_CRIMSON, cx - 0.08, spireTop + 0.9, cz - 0.08,
    cx + 1.5, spireTop + 1.9, cz + 0.08);
}

/**
 * A wall pierced by a doorway: emits the two jambs and the lintel, leaving a
 * real hole the player walks through.
 *
 * `along` is the axis the wall runs along. This is the single most important
 * helper in the file — every door in the castle goes through it, so a door is
 * a genuine gap in the collision, not a decal on a solid wall.
 */
function wallWithDoor(sol: Solid[], pieces: Piece[], pal: number,
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  along: 'x' | 'z', doorCentre: number, doorHalf: number, doorTop: number,
): void {
  const ax0 = Math.min(x0, x1); const ax1 = Math.max(x0, x1);
  const az0 = Math.min(z0, z1); const az1 = Math.max(z0, z1);
  const d0 = doorCentre - doorHalf;
  const d1 = doorCentre + doorHalf;
  if (along === 'x') {
    if (d0 > ax0) wall(sol, pieces, pal, ax0, y0, az0, d0, y1, az1);
    if (d1 < ax1) wall(sol, pieces, pal, d1, y0, az0, ax1, y1, az1);
    if (doorTop < y1) wall(sol, pieces, pal, d0, doorTop, az0, d1, y1, az1);
  } else {
    if (d0 > az0) wall(sol, pieces, pal, ax0, y0, az0, ax1, y1, d0);
    if (d1 < az1) wall(sol, pieces, pal, ax0, y0, d1, ax1, y1, az1);
    if (doorTop < y1) wall(sol, pieces, pal, ax0, doorTop, d0, ax1, y1, d1);
  }
}

/**
 * A mass with a horizontal passage cut clean through it.
 *
 * `wallWithDoor`'s sibling, and needed for the same reason: the wall-walk has
 * to get through four corner towers and two gatehouse piers, and a passage is
 * only real if the COLLISION and the GEOMETRY are the same hole. Every serious
 * bug in this castle has been those two drifting — so this takes one rect,
 * subtracts the holes ONCE, and emits the survivors through `wall()`, which is
 * the only builder that writes a Solid and its Piece from the same numbers.
 *
 * The mass below `hy0` and above `hy1` is emitted whole; only the slice between
 * them is cut. `kind` applies to those two whole parts alone — the slice is
 * always boxes, because the fragments are what carry the outer faces and a
 * chamfer on a fragment edge that lands mid-face is an 18 cm groove running
 * down the tower.
 */
function pierce(sol: Solid[], pieces: Piece[], pal: number,
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  hy0: number, hy1: number, holes: Rect[], kind: 'box' | 'bevel' = 'box'): void {
  if (hy0 > y0) wall(sol, pieces, pal, x0, y0, z0, x1, hy0, z1, kind);
  if (hy1 < y1) wall(sol, pieces, pal, x0, hy1, z0, x1, y1, z1, kind);
  // `subtract` assumes the two rects overlap — it is written for `cutSupport`,
  // which checks first — so the guard is not optional here.
  let rects: Rect[] = [{ x0, z0, x1, z1 }];
  for (const h of holes) {
    rects = rects.flatMap((r) => (overlaps(r, h) ? subtract(r, h) : [r]));
  }
  for (const r of rects) wall(sol, pieces, pal, r.x0, hy0, r.z0, r.x1, hy1, r.z1);
}

// --- the plan -------------------------------------------------------------

/**
 * Build the complete castle plan. Deterministic: the only randomness is
 * `mulberry32(seed)`, drawn in a fixed order, and it only jitters decoration.
 */
export function buildCastleLayout(seed: number): CastleLayout {
  const solids: Solid[] = [];
  const supports: Support[] = [];
  const ceilings: Ceiling[] = [];
  const pieces: Piece[] = [];
  const lights: CastleLight[] = [];
  const markers = new Map<string, CastleMarker>();
  const rng = mulberry32(seed >>> 0);

  const mark = (id: string, x: number, y: number, z: number): void => {
    markers.set(id, { id, x, y, z });
  };
  const torch = (x: number, y: number, z: number, r = 9): void => {
    lights.push({ x, y, z, flameScale: 1, radius: r });
    deco(pieces, PAL_IRON, x - 0.14, y - 0.9, z - 0.14, x + 0.14, y - 0.1, z + 0.14);
    deco(pieces, PAL_TORCH, x - 0.2, y - 0.12, z - 0.2, x + 0.2, y + 0.28, z + 0.2);
  };
  /** A flameless fill light — big rooms need one or they read as black pits. */
  const fill = (x: number, y: number, z: number, r: number): void => {
    lights.push({ x, y, z, flameScale: 0, radius: r });
  };

  // =========================================================================
  // 1. The motte: a solid plinth. Everything inside the curtain wall stands
  //    on it, and its outer face is what you see rising out of the hillside.
  // =========================================================================

  const PLINTH_HX = OUTER_HX + 6;
  const PLINTH_HZ = OUTER_HZ + 6;
  const PLINTH_BOTTOM = -34;   // buried; the manager clips this to terrain

  // Courtyard surface: one flat plane over the whole plinth top. The keep's
  // interior floors sit on top of it, and the undercroft is carved out below.
  floorAt(supports, -PLINTH_HX, -PLINTH_HZ, PLINTH_HX, PLINTH_HZ, 0);

  // Battered plinth face, drawn as three receding courses so the motte reads
  // as built rather than extruded.
  for (let i = 0; i < 3; i++) {
    const inset = i * 1.6;
    const yTop = -0.4 - i * 3.2;
    const yBot = i === 2 ? PLINTH_BOTTOM : -0.4 - (i + 1) * 3.2;
    const hx = PLINTH_HX - inset;
    const hz = PLINTH_HZ - inset;
    // All three courses in soot, where the top one used to be raw rock. The top
    // course is the biggest single surface in the near-gate view and rock's
    // palette 0 is 0.42 — a mid-grey apron under a black castle, which read as
    // the castle sitting on somebody else's building.
    const pal = PAL_SOOT;
    deco(pieces, pal, -hx, yBot, -hz, hx, yTop, -hz + 2.4);
    deco(pieces, pal, -hx, yBot, hz - 2.4, hx, yTop, hz);
    deco(pieces, pal, -hx, yBot, -hz, -hx + 2.4, yTop, hz);
    // The +X course is SPLIT, because the breach causeway runs out through it.
    // The ramp leaves the courtyard at x = OUTER_HX - 1 and is already 3 m down
    // by the time it reaches this course, so an unbroken band put 2.4 m of the
    // escape inside drawn masonry — the player walks into the motte's skin and
    // out the far side of it. A wall does not collapse without taking the face
    // it stands on with it, so the gap is also the right picture.
    deco(pieces, pal, hx - 2.4, yBot, -hz, hx, yTop, -BREACH_SPILL_HZ);
    deco(pieces, pal, hx - 2.4, yBot, BREACH_SPILL_HZ, hx, yTop, hz);
  }
  // Plinth lip — a low kerb so the courtyard edge reads and the player has a
  // visible cue that stepping off means a long drop. Black, because the line
  // where cut stone meets the raw motte is the castle's ground line and it
  // wants to be the darkest thing in the view.
  //
  // A RING, and standing 9 cm proud. It used to be one slab across the entire
  // plinth with its top at exactly y = 0 — the same height and the same 6 500 m²
  // as the courtyard floor slab derived from the courtyard Support. Two coplanar
  // upward faces is a depth-test tie, and the tie is what the floor "clipping
  // between colours" in play actually was. A kerb is a kerb: two metres wide,
  // round the edge, and clear of the plane it borders.
  {
    const kw = 2.0;
    const kt = 0.09;
    // Set back 4 cm from the drop, so its outer skin is not in the same plane as
    // the plinth's own top course. Sitting flush was 40 m² of soot and voidstone
    // taking turns along the whole rim.
    const ex = PLINTH_HX - 0.04;
    const ez = PLINTH_HZ - 0.04;
    for (const [x0, z0, x1, z1] of [
      [-ex, -ez, ex, -ez + kw],
      [-ex, ez - kw, ex, ez],
      [-ex, -ez + kw, -ex + kw, ez - kw],
      [ex - kw, -ez + kw, ex, ez - kw],
    ]) {
      deco(pieces, PAL_VOID, x0, -0.55, z0, x1, kt, z1);
    }
  }
  // There used to be a 131 x 119 m slab here at y -1.5..-0.5, giving the
  // courtyard visible mass from below. It is gone, and nothing replaces it.
  //
  // It was an AUTHORED piece standing in for a DERIVED one, which is the fault
  // `derivedFloors` exists to make impossible: the courtyard Support at y = 0
  // already draws a SLAB_T slab over the whole plinth, so the mass was there
  // twice — and only one of the two copies knew about the holes. `cutSupport`
  // punches the undercroft stairwell out of the Support; the authored slab was
  // a single box and kept none of it. Every one of its faces is buried behind
  // the plinth's battered courses (2.4 m wide, this was inset 0.5 m) and under
  // the courtyard slab, so the ONLY place in the castle it was ever visible was
  // from inside the undercroft — where it hung 0.5 m below LEVEL_CEIL[0] and
  // sealed the stair shaft into a flat black ceiling. Reported from play as
  // "the floor above looks closed until you walk through it", which is exactly
  // what it was: you climbed the ramp and passed through a drawn surface the
  // collider had never heard of.

  // =========================================================================
  // 2. Outer curtain wall, corner towers, gatehouse, and THE BREACH.
  // =========================================================================

  const inX = OUTER_HX - WALL_T;
  const inZ = OUTER_HZ - WALL_T;
  const GATE_HALF = 3.0;

  // The curtain takes `PAL_VOID` outright rather than a skin: BOTH its faces
  // are outdoors — one looks at the wilderness and the other at the courtyard —
  // so there is no interior on the far side to keep readable.
  //
  // Every one of these stops at WALL_WALK, not at WALL_H: see the constants.
  // The mass IS the deck's own foundation, and the merlons below are the only
  // thing that goes higher.
  //
  // North face (-Z): the gatehouse passage splits it.
  wallWithDoor(solids, pieces, PAL_VOID,
    -OUTER_HX, 0, -OUTER_HZ, OUTER_HX, WALL_WALK, -inZ, 'x', 0, GATE_HALF, 5.4);
  // South face (+Z): unbroken.
  wall(solids, pieces, PAL_VOID, -OUTER_HX, 0, inZ, OUTER_HX, WALL_WALK, OUTER_HZ);
  // West face (-X): unbroken.
  wall(solids, pieces, PAL_VOID, -OUTER_HX, 0, -OUTER_HZ, -inX, WALL_WALK, OUTER_HZ);
  // East face (+X): THE BREACH. Two stubs with a ragged hole between them.
  wall(solids, pieces, PAL_VOID, inX, 0, -OUTER_HZ, OUTER_HX, WALL_WALK, -BREACH_HZ);
  wall(solids, pieces, PAL_VOID, inX, 0, BREACH_HZ, OUTER_HX, WALL_WALK, OUTER_HZ);
  // Ragged remains of the breached span: broken teeth left and right, so the
  // gap reads as collapsed rather than doored. They are `wall()`, not `deco()`:
  // the comment here used to say "low enough to walk over" and they are 2.6 m
  // and 1.9 m of drawn masonry standing in the escape route, which a player
  // walked straight through. Solid, the breach is a 6.4 m gap between two
  // stumps — still twice the gate's width, and now the stumps are stone.
  wall(solids, pieces, PAL_SOOT, inX, 0, -BREACH_HZ, OUTER_HX, 2.6, -BREACH_HZ + 1.3);
  wall(solids, pieces, PAL_SOOT, inX, 0, BREACH_HZ - 1.3, OUTER_HX, 1.9, BREACH_HZ);
  mark('breach', OUTER_HX, 0, 0);

  // --- curtain-wall dressing ----------------------------------------------
  //
  // Everything from here to the corner towers is relief on faces that already
  // exist: a battered base course, a string course at mid-height, a corbelled
  // parapet, arrow slits and banners. None of it touches `solids`. The wall was
  // four grey slabs 120 m long, and a 120 m slab has no scale in it at all —
  // these give the eye something to measure the wall against.
  const CURTAIN_FACES: { f: Face; surf: number; a0: number; a1: number }[] = [
    { f: 0, surf: -OUTER_HZ, a0: -OUTER_HX, a1: OUTER_HX },
    { f: 1, surf: OUTER_HZ, a0: -OUTER_HX, a1: OUTER_HX },
    { f: 2, surf: -OUTER_HX, a0: -OUTER_HZ, a1: OUTER_HZ },
    { f: 3, surf: OUTER_HX, a0: -OUTER_HZ, a1: OUTER_HZ },
  ];
  /**
   * Where the great hangings go, declared before the slits so the slits can
   * make room. An arrow loop behind eight metres of felt is a loop that does not
   * work, and it is also a black slot and a crimson panel a centimetre apart in
   * depth — a flicker on the most looked-at wall the castle has.
   */
  const HANGINGS: { f: Face; cu: number }[] = [];
  for (const sx of [-1, 1] as const) {
    HANGINGS.push({ f: 1, cu: sx * 26 }, { f: 2, cu: sx * 24 });
  }
  for (const { f, surf, a0, a1 } of CURTAIN_FACES) {
    const sgn = faceSign(f);
    const bandLo = surf; const bandHi = surf + sgn * 0.45;
    // Battered base and a string course, as two long bands. The base course is
    // kept to 45 cm of projection because the plinth top is walkable right up
    // against the outside of this wall, and anything bolder is something the
    // player's shoulder passes through.
    if (facesZ(f)) {
      deco(pieces, PAL_GRAVE, a0, 0, bandLo, a1, 2.1, bandHi, 'bevel');
      deco(pieces, PAL_GRAVE, a0, 4.9, bandLo, a1, 5.35, bandHi);
    } else {
      deco(pieces, PAL_GRAVE, bandLo, 0, a0, bandHi, 2.1, a1, 'bevel');
      deco(pieces, PAL_GRAVE, bandLo, 4.9, a0, bandHi, 5.35, a1);
    }
    // Big saddle stitches over the string course, the length of the run. At
    // 3.6 m they are one per two merlons, which is the pitch at which a curtain
    // wall reads as panels that were sewn together rather than one long slab.
    stitchRun(pieces, f, a0 + 4, a1 - 4, surf, 4.62, 5.62, 3.6);
    // The corbelled parapet, in runs that stop clear of the breach: the hole
    // has to keep reading as a hole, and a bracket course marching across it
    // would put an intact cornice over collapsed masonry.
    //
    // `machicolation` draws its band from y to y + 0.62 and its brackets under
    // that, so passing WALL_WALK put 62 cm of PAL_GRAVE ON the deck, projecting
    // 72 cm past the outer face — which was invisible while the deck was
    // unreachable and is a kerb through the player's shins now that it is not.
    // The band belongs UNDER the walking surface: that is what a corbelled
    // parapet is, brackets carrying the merlon course out past the wall face.
    // The extra 6 cm keeps its top face off the deck slab's top face, which is
    // PAL_VOID against this PAL_GRAVE — a two-palette coplanar tie is exactly
    // what `test-castle-zfight.mts` fails on.
    const corbelY = WALL_WALK - 0.62 - 0.06;
    if (f === 3) {
      machicolation(pieces, f, a0 + 6, -BREACH_HZ - 1.5, surf, corbelY, 3.4);
      machicolation(pieces, f, BREACH_HZ + 1.5, a1 - 6, surf, corbelY, 3.4);
    } else {
      machicolation(pieces, f, a0 + 6, a1 - 6, surf, corbelY, 3.4);
    }
    // Arrow slits between the corner towers, skipping the gate and the breach.
    for (let u = a0 + 13; u <= a1 - 13; u += 8.2) {
      if (f === 0 && Math.abs(u) < GATE_HALF + 5) continue;
      if (f === 3 && Math.abs(u) < BREACH_HZ + 5) continue;
      if (HANGINGS.some((h) => h.f === f && Math.abs(u - h.cu) < 4.4)) continue;
      arrowSlit(pieces, f, u, 3.1, 1.9, surf);
    }
  }
  // Banners either side of the gate and flanking the breach: the two places the
  // player actually looks at this wall from outside.
  for (const sx of [-1, 1] as const) {
    banner(pieces, 0, sx * 11, 1.5, 6.9, 2.4, -OUTER_HZ);
    banner(pieces, 3, sx * (BREACH_HZ + 6.5), 1.5, 6.9, 2.4, OUTER_HX);
  }
  // Great hangings on the two long flanks, which are otherwise 120 m of black
  // with nothing on them at all. On the seaward (south) face they are the only
  // thing visible from the water; on the west they face the road in.
  for (const { f, cu } of HANGINGS) {
    greatHanging(pieces, f, cu, 3.4, 6.6, 1.6, f === 1 ? OUTER_HZ : -OUTER_HX);
  }

  // Wall-walk on top of the curtain. The deck fills the full wall thickness on
  // all four runs, so it also passes straight through the corner towers and the
  // gatehouse piers — which is why both of those are `pierce`d below.
  floorAt(supports, -inX, -inZ, inX, -OUTER_HZ, WALL_WALK);
  floorAt(supports, -inX, inZ, inX, OUTER_HZ, WALL_WALK);
  floorAt(supports, -OUTER_HX, -OUTER_HZ, -inX, OUTER_HZ, WALL_WALK);
  floorAt(supports, inX, -OUTER_HZ, OUTER_HX, -BREACH_HZ, WALL_WALK);
  floorAt(supports, inX, BREACH_HZ, OUTER_HX, OUTER_HZ, WALL_WALK);
  // Where the deck runs out at the breach, a heap of collapsed masonry rather
  // than a 7.6 m step into nothing. It is a `wall()` so it stops the walker: at
  // 1.2 m it covers 8.2..8.8 of the blocked span and the walk dead-ends against
  // something that plainly says the wall ended here.
  for (const sz of [-1, 1] as const) {
    wall(solids, pieces, PAL_SOOT,
      inX, WALL_WALK, sz * BREACH_HZ, OUTER_HX, WALL_WALK + 1.2, sz * (BREACH_HZ + 1.6));
    mark(`wallBreach${sz < 0 ? 'N' : 'S'}`,
      OUTER_HX - 2.1, WALL_WALK, sz * (BREACH_HZ + 3));
  }

  // Corner towers.
  const CT = CORNER_TOWER_H;
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      const cx = sx * (OUTER_HX - CT / 2);
      const cz = sz * (OUTER_HZ - CT / 2);
      // A mural gallery at deck height, bending round the inside of the tower's
      // outer corner: one leg per curtain run that meets this tower, each the
      // width of that run's deck less `TOWER_SKIN` off the outer face. The two
      // legs overlap at the corner, which is what makes the walk turn.
      const legAlongX: Rect = {
        x0: Math.min(cx - sx * CT / 2, cx + sx * (CT / 2 - TOWER_SKIN)),
        x1: Math.max(cx - sx * CT / 2, cx + sx * (CT / 2 - TOWER_SKIN)),
        z0: Math.min(sz * inZ, sz * (OUTER_HZ - TOWER_SKIN)),
        z1: Math.max(sz * inZ, sz * (OUTER_HZ - TOWER_SKIN)),
      };
      const legAlongZ: Rect = {
        x0: Math.min(sx * inX, sx * (OUTER_HX - TOWER_SKIN)),
        x1: Math.max(sx * inX, sx * (OUTER_HX - TOWER_SKIN)),
        z0: Math.min(cz - sz * CT / 2, cz + sz * (CT / 2 - TOWER_SKIN)),
        z1: Math.max(cz - sz * CT / 2, cz + sz * (CT / 2 - TOWER_SKIN)),
      };
      // Solid everywhere else. Both faces of what is left are outdoors or in
      // the gallery, so it takes the exterior mass palette outright, no skin.
      pierce(solids, pieces, PAL_VOID,
        cx - CT / 2, 0, cz - CT / 2, cx + CT / 2, CORNER_TOWER_HEIGHT, cz + CT / 2,
        WALL_WALK, WALL_PASS_TOP, [legAlongX, legAlongZ], 'bevel');
      // The gallery is roofed by 6.4 m of tower, so the head clamp has to know:
      // without this a jump on the deck puts the player's head inside the mass.
      ceilAt(ceilings, cx - CT / 2, cz - CT / 2, cx + CT / 2, cz + CT / 2, WALL_PASS_TOP);
      // ...and it is windowless. One torch per leg, on the inner jamb: a single
      // one at the junction leaves the far end of the other leg black, and the
      // walk goes dark for eleven metres four times round.
      torch(cx - sx * 0.5, WALL_WALK + 1.3, sz * (inZ + 0.35), 8);
      torch(sx * (inX + 0.35), WALL_WALK + 1.3, cz - sz * 0.5, 8);
      // Reported dark BETWEEN those two: each sits near its own leg's jamb —
      // the end where that leg meets the straight run — so both are close
      // together on the COURTYARD side of the bend and the outer turn, where
      // `legAlongX` and `legAlongZ` overlap, sits roughly 5.3 m from each of
      // them (measured, not eyeballed: `cx - sx*0.5` / `sz*(inZ+0.35)` and its
      // mirror land on the near jamb of each leg, not on the corner they
      // share). A third torch there, mounted on the OUTER skin — the same
      // 0.35 m standoff the other two use, just off `OUTER_HX/HZ - TOWER_SKIN`
      // instead of off `inX/inZ` — closes the gap without adding a light in
      // the middle of the floor for a player to walk through.
      torch(sx * (OUTER_HX - TOWER_SKIN - 0.35), WALL_WALK + 1.3,
        sz * (OUTER_HZ - TOWER_SKIN - 0.35), 8);
      // The junction of the two legs, which is where the walk turns. Marked so
      // route harnesses read the circuit out of the layout instead of holding
      // copied coordinates that go stale the moment a tower moves.
      mark(`wall${sz < 0 ? 'N' : 'S'}${sx < 0 ? 'W' : 'E'}`,
        sx * (inX + 0.9), WALL_WALK, sz * (inZ + 0.9));
      // Battered base course. Solid: it stands 0.7 m proud of the tower on
      // every side and 2.2 m tall, so the courtyard face of it was stone the
      // player's shoulder passed through all the way round the bailey.
      wall(solids, pieces, PAL_GRAVE,
        cx - CT / 2 - 0.7, -0.4, cz - CT / 2 - 0.7,
        cx + CT / 2 + 0.7, 2.2, cz + CT / 2 + 0.7, 'bevel');
      // Two string courses up the shaft. A 16 m tower with nothing on it has no
      // storeys, and a tower with no storeys has no size.
      for (const sy of [6.0, 11.2]) {
        deco(pieces, PAL_GRAVE, cx - CT / 2 - 0.28, sy, cz - CT / 2 - 0.28,
          cx + CT / 2 + 0.28, sy + 0.46, cz + CT / 2 + 0.28, 'bevel');
        // Stitched over on the two outward faces, where they can be seen.
        stitchRun(pieces, sz < 0 ? 0 : 1, cx - CT / 2 + 1.2, cx + CT / 2 - 1.2,
          cz + sz * (CT / 2 + 0.28), sy - 0.22, sy + 0.68, 2.6);
        stitchRun(pieces, sx < 0 ? 2 : 3, cz - CT / 2 + 1.2, cz + CT / 2 - 1.2,
          cx + sx * (CT / 2 + 0.28), sy - 0.22, sy + 0.68, 2.6);
      }
      // Slits on the two OUTWARD faces only — the inward ones look into the
      // courtyard, where the wall-walk already reads, and 32 slits nobody can
      // see is 4 000 verts of nothing.
      arrowSlit(pieces, sz < 0 ? 0 : 1, cx, 3.4, 2.0, cz + sz * (CT / 2));
      arrowSlit(pieces, sz < 0 ? 0 : 1, cx, 8.2, 2.0, cz + sz * (CT / 2));
      arrowSlit(pieces, sx < 0 ? 2 : 3, cz, 3.4, 2.0, cx + sx * (CT / 2));
      arrowSlit(pieces, sx < 0 ? 2 : 3, cz, 8.2, 2.0, cx + sx * (CT / 2));
      towerCrown(pieces, cx, cz, CT / 2, CORNER_TOWER_HEIGHT, 1.7, 31.0, 8);
      torch(cx + sx * -1.6, 4.4, cz + sz * (-CT / 2 - 0.35), 10);
    }
  }

  // Gatehouse: two piers with a 6 m passage, portcullis bars across it.
  //
  // The piers stand 7 m deep across the north deck, so each is pierced by the
  // wall-walk exactly as the corner towers are — but here the hole is the full
  // 3 m of the deck, because the pier already keeps 2.5 m of stone in front of
  // the curtain's outer face and 1.5 m behind its inner one. Nothing of the
  // gatehouse's outside changes; the walk simply passes through it and over the
  // gate, which is what a gatehouse is for.
  const GATE_FRONT = -OUTER_HZ - 2.5;
  const gatePass: Rect = { x0: -8, z0: -OUTER_HZ, x1: 8, z1: -inZ };
  pierce(solids, pieces, PAL_VOID,
    -7.5, 0, GATE_FRONT, -GATE_HALF, 13.0, -inZ + 1.5,
    WALL_WALK, WALL_PASS_TOP, [gatePass], 'bevel');
  pierce(solids, pieces, PAL_VOID,
    GATE_HALF, 0, GATE_FRONT, 7.5, 13.0, -inZ + 1.5,
    WALL_WALK, WALL_PASS_TOP, [gatePass], 'bevel');
  // Head clamp inside each pier only. Over the gate itself the walk is open to
  // the sky, and a ceiling rect spanning the gap would be a roof the player
  // bonks on with nothing drawn there.
  for (const sx of [-1, 1] as const) {
    ceilAt(ceilings, sx * GATE_HALF, GATE_FRONT, sx * 7.5, -inZ + 1.5, WALL_PASS_TOP);
    torch(sx * 6.4, WALL_WALK + 1.3, -inZ - 0.4, 8);
  }
  deco(pieces, PAL_GRAVE, -7.5, 13.0, GATE_FRONT, 7.5, 14.6, -inZ + 1.5);
  ceilAt(ceilings, -GATE_HALF, GATE_FRONT, GATE_HALF, -inZ + 1.5, 5.4);
  // Portcullis: dropped, so the gate is NOT the way out. The breach is.
  for (let i = 0; i < 7; i++) {
    const bx = -GATE_HALF + 0.45 + i * ((GATE_HALF * 2 - 0.9) / 6);
    wall(solids, pieces, PAL_IRON, bx - 0.11, 0, -inZ + 0.5, bx + 0.11, 5.2, -inZ + 0.72);
  }
  // --- what makes it read as a gatehouse ----------------------------------
  //
  // The arch over the passage is a VOUSSOIR RING, not a panel: the passage is a
  // genuine hole in `solids` and an arch slab across it would be a wall the
  // player walks through. Everything else here is relief on the piers.
  archRing(pieces, PAL_GRAVE, 0, 0, GATE_HALF + 0.5, 5.4, GATE_FRONT, 0.55, 5);
  // Machicolation over the passage — the murder-hole gallery, and the thing
  // that says this gate expects to be attacked.
  machicolation(pieces, 0, -7.2, 7.2, GATE_FRONT, 11.4, 2.0);
  for (const sx of [-1, 1] as const) {
    // Half-round flanking turrets, corbelled out at the string course and
    // capped. They break the gatehouse block into three masses, which is the
    // difference between a gate and a hole in a wall.
    // The shaft stops 6 cm short of the curtain's outer face. It used to run
    // 0.8 m PAST it, which put drawn stone across the outer 80 cm of the north
    // deck with no `Solid` behind it — invisible while nobody could stand there,
    // and a turret through the player's shoulder now that they can. Flush would
    // do for that, but the string course's own back face is in the -54.00 plane
    // and is not fully occluded (it runs across the open gate), so flush is a
    // two-palette coplanar pair. 6 cm, the smallest offset this file uses.
    const tx = sx * 8.1;
    deco(pieces, PAL_VOID, tx - 2.1, 3.0, GATE_FRONT - 0.9,
      tx + 2.1, 13.4, -OUTER_HZ - 0.06, 'bevel');
    deco(pieces, PAL_GRAVE, tx - 2.5, 2.2, GATE_FRONT - 1.3,
      tx + 2.5, 3.4, GATE_FRONT + 3.7, 'bevel');
    towerCrown(pieces, tx, GATE_FRONT + 1.2, 2.3, 13.4, 1.3, 21.5, 6);
    arrowSlit(pieces, 0, tx, 6.6, 1.8, GATE_FRONT - 0.9);
    banner(pieces, 0, sx * 4.7, 1.05, 12.6, 6.2, GATE_FRONT);
    // Iron cressets on brackets either side of the arch.
    deco(pieces, PAL_IRON, sx * 4.2 - 0.16, 4.6, GATE_FRONT - 0.7,
      sx * 4.2 + 0.16, 6.2, GATE_FRONT);
  }
  // The king's device over the arch: a black felt field with a crimson bar and
  // a glowing eye, small, but it is at eye level on the way in.
  // Backed off 2 cm: the voussoir ring's own back face is in the GATE_FRONT
  // plane and there is no pier between them — that is the open passage.
  deco(pieces, PAL_BLACKFELT, -2.4, 8.0, GATE_FRONT - 0.2, 2.4, 11.0,
    GATE_FRONT - 0.02);
  // 10.64, clear of the voussoir keystone's own top face at 10.59.
  deco(pieces, PAL_CRIMSON, -1.9, 8.4, GATE_FRONT - 0.34, 1.9, 10.64,
    GATE_FRONT - 0.16);
  deco(pieces, PAL_GLASS, -0.7, 9.1, GATE_FRONT - 0.46, 0.7, 9.9, GATE_FRONT - 0.30);
  torch(-GATE_HALF - 0.5, 3.6, -OUTER_HZ - 1.2, 9);
  torch(GATE_HALF + 0.5, 3.6, -OUTER_HZ - 1.2, 9);
  mark('gatehouse', 0, 0, -OUTER_HZ - 4);
  mark('wallGate', 0, WALL_WALK, -inZ - 0.9);

  // --- merlons -------------------------------------------------------------
  //
  // A tooth every 2.6 m along each run: 1.7 m of block, 0.9 m of crenel, and a
  // pyramid cap on each. The block is a `Solid`, so this row IS the wall-walk's
  // outer parapet now that the curtain stops at the deck.
  //
  // Declared AFTER the towers and the gatehouse so it can ask whether a tooth
  // has anywhere to stand. A third of the run is inside a corner tower or a
  // gatehouse pier — those merlons were always buried, invisible and free, and
  // now that the wall-walk tunnels through both they would be teeth growing
  // across the passage. `buried` is the derived test rather than four hand-typed
  // exclusion zones, so it cannot drift when a tower moves.
  const buried = (x0: number, z0: number, x1: number, z1: number): boolean =>
    solids.some((s) => s.x0 < x1 && s.x1 > x0 && s.z0 < z1 && s.z1 > z0
      && s.y0 < WALL_H && s.y1 > WALL_WALK);
  const merlon = (cx: number, cz: number, ax: 'x' | 'z'): void => {
    const hw = ax === 'x' ? 0.85 : 0.5;
    const hd = ax === 'x' ? 0.5 : 0.85;
    if (buried(cx - hw, cz - hd, cx + hw, cz + hd)) return;
    wall(solids, pieces, PAL_VOID,
      cx - hw, WALL_WALK, cz - hd, cx + hw, WALL_H, cz + hd);
    shape(pieces, PAL_GRAVE, 'pyr', cx - hw - 0.12, WALL_H, cz - hd - 0.12,
      cx + hw + 0.12, WALL_H + 0.55, cz + hd + 0.12);
  };
  for (let x = -OUTER_HX + 2; x <= OUTER_HX - 2; x += 2.6) {
    // The gate is no longer an exception: the walk crosses over it, so it needs
    // the same parapet as the rest of the run.
    merlon(x, -OUTER_HZ + 0.7, 'x');
    merlon(x, OUTER_HZ - 0.7, 'x');
  }
  for (let z = -OUTER_HZ + 2; z <= OUTER_HZ - 2; z += 2.6) {
    merlon(-OUTER_HX + 0.7, z, 'z');
    if (Math.abs(z) > BREACH_HZ + 0.6) merlon(OUTER_HX - 0.7, z, 'z');
  }

  // --- the two flights up to the wall-walk ---------------------------------
  //
  // These used to be authored at `-inX - 5.5 .. -inX` and `inX .. inX + 5.5`,
  // which is not the courtyard: it is the curtain's own 3 m of footprint plus
  // 2.5 m of open air outside the castle. Both flights climbed inside the wall
  // they were meant to climb ONTO. The courtyard is |x| < inX, so a flight
  // against the inner face runs inward from it.
  //
  // Each ends in a landing level with the deck, carried on its own block of
  // masonry. Without one the flight meets the deck at a single line — the ramp
  // surface is only at WALL_WALK on its topmost edge — and one step short of
  // that edge the sidestep onto the deck is a 0.63 m rise against STEP_UP 0.6.
  const RAIL_T = 0.5;
  const RAIL_H = 1.0;
  for (const sx of [-1, 1] as const) {
    // West flight climbs north out of the front courtyard, east flight south
    // out of the back one, so the two heads sit diagonally opposite and the
    // walk between them is the long way round either way.
    const u0 = sx * inX;                 // flush with the curtain's inner face
    const u1 = sx * (inX - 5.5);
    const foot = sx * 18;
    const head = sx * 32;
    const land = sx * 36;
    const lo = Math.min(u0, u1); const hi = Math.max(u0, u1);
    ramp(supports, pieces, PAL_VOID,
      lo, Math.min(foot, head), hi, Math.max(foot, head),
      'z', sx < 0 ? WALL_WALK : 0, sx < 0 ? 0 : WALL_WALK);
    floorAt(supports, lo, Math.min(head, land), hi, Math.max(head, land), WALL_WALK);
    wall(solids, pieces, PAL_VOID,
      lo, 0, Math.min(head, land), hi, WALL_WALK, Math.max(head, land));
    // A stepped parapet down the OPEN side of the flight and round the landing.
    // The curtain guards the other side; this one guards a 7.6 m drop into the
    // courtyard, and `blocked` only sees [feet + STEP_UP, feet + PLAYER_H], so
    // each step has to run from its tread's low end to 1 m above its high end
    // to bracket that span everywhere a foot can be on it.
    const STEPS = 7;
    for (let i = 0; i < STEPS; i++) {
      const za = head + (foot - head) * (i / STEPS);
      const zb = head + (foot - head) * ((i + 1) / STEPS);
      const ya = (WALL_WALK * (za - foot)) / (head - foot);
      const yb = (WALL_WALK * (zb - foot)) / (head - foot);
      wall(solids, pieces, PAL_VOID,
        u1, Math.min(ya, yb), Math.min(za, zb),
        u1 + sx * RAIL_T, Math.max(ya, yb) + RAIL_H, Math.max(za, zb));
    }
    wall(solids, pieces, PAL_VOID, u1, WALL_WALK, Math.min(head, land),
      u1 + sx * RAIL_T, WALL_WALK + RAIL_H, Math.max(head, land));
    wall(solids, pieces, PAL_VOID, lo, WALL_WALK, land,
      hi, WALL_WALK + RAIL_H, land - sx * RAIL_T);
    // Foot, landing, and the deck square beside the landing. Three and not two
    // because the landing's far end is railed: leaving it for the deck is a
    // step SIDEWAYS through the curtain's line, and a route that aims straight
    // from the landing at the far corner walks into the rail instead.
    const side = sx < 0 ? 'W' : 'E';
    // 3 m OFF the bottom step, on the flight's open side. Marking the foot
    // itself points a route straight along the wall into the end of the stair
    // parapet — which is where a route harness stopped, 3 m short, and filmed
    // the courtyard for the rest of the circuit.
    mark(`wallStair${side}`, sx * (inX - 2.7), 0, foot - sx * 3);
    mark(`wallHead${side}`, sx * (inX - 2.7), WALL_WALK, sx * 34);
    mark(`wallDeck${side}`, sx * (OUTER_HX - 2.1), WALL_WALK, sx * 34);
  }

  // =========================================================================
  // 3. Courtyards.
  // =========================================================================

  // Front courtyard (north): braziers flanking the approach to the keep.
  //
  // Raised onto three-legged iron stands. A fire bowl sitting flat on the
  // ground reads as a rubbish heap that happens to be alight; the legs are what
  // make it a brazier, and they are 108 verts each.
  for (const sx of [-1, 1] as const) {
    const bx = sx * 12;
    for (const lx of [-0.8, 0.8]) {
      for (const lz of [-0.8, 0.8]) {
        deco(pieces, PAL_IRON, bx + lx - 0.12, 0, -36 + lz - 0.12,
          bx + lx + 0.12, 1.15, -36 + lz + 0.12);
      }
    }
    // The bowl blocks. A 1.2 m fire basin you walk through is the plainest
    // possible instance of drawn mass without collision, and it is four metres
    // off the route from the keep door to the gate.
    wall(solids, pieces, PAL_BASALT,
      bx - 1.1, 1.05, -36 - 1.1, bx + 1.1, 2.25, -36 + 1.1, 'bevel');
    lights.push({ x: bx, y: 2.9, z: -36, flameScale: 1.8, radius: 13 });
    deco(pieces, PAL_TORCH, bx - 0.75, 2.25, -36 - 0.75, bx + 0.75, 2.9, -36 + 0.75);
  }
  // Banners on the keep's north face — black field, crimson bar, on rails.
  for (const sx of [-1, 1] as const) {
    banner(pieces, 0, sx * 8, 1.35, 10.6, 3.4, -KEEP_HZ);
  }
  mark('frontCourt', 0, 0, -36);
  mark('backCourt', 0, 0, 36);
  fill(0, 6, -36, 34);
  fill(0, 6, 36, 34);

  // Back courtyard (south): the dragon's feeding yard — bones and a pen.
  //
  // The bones were `PAL_WOOD` and read as scattered planks. On the bone palette
  // they read as what they are, and they are the only thing in the castle that
  // tells the player what the dragon eats.
  for (let i = 0; i < 9; i++) {
    const a = rng() * Math.PI * 2;
    const d = 6 + rng() * 16;
    const bx = Math.cos(a) * d;
    const bz = 36 + Math.sin(a) * d * 0.6;
    const l = 1.2 + rng() * 2.4;
    deco(pieces, PAL_BONE, bx - l / 2, 0, bz - 0.16, bx + l / 2, 0.32, bz + 0.16);
    deco(pieces, PAL_BONE, bx - l * 0.5, 0, bz - 0.34, bx - l * 0.34, 0.42, bz + 0.34);
  }
  // A ribcage: nine staves off a spine, and a skull with sockets. It is the one
  // silhouette in the yard that is unmistakably an animal that used to be
  // bigger than the player.
  {
    // The carcass lies FLAT. A standing ribcage was tried and it read as
    // scaffolding from every angle a player actually stands at: at eye level
    // you see six near ribs edge-on overlapping six far ones, and a row of
    // pale uprights is a fence. Splayed on the ground the same bones read
    // instantly as something dead, and they stop obstructing the keep behind.
    const rz = 40.0;
    deco(pieces, PAL_BONE, -6.0, 0, rz - 0.34, 6.0, 0.42, rz + 0.34);
    for (let i = 0; i < 7; i++) {
      const bx = -5.0 + i * 1.7;
      const t = 1 - Math.abs(i - 3) / 4.2;           // longest amidships
      for (const sz of [-1, 1] as const) {
        const far = rz + sz * (1.5 + t * 1.7);
        deco(pieces, PAL_BONE, bx - 0.12, 0, rz + sz * 0.3, bx + 0.12, 0.30, far);
        // The tip curls forward, which is what makes it a rib and not a stick.
        deco(pieces, PAL_BONE, bx - 0.12, 0, far - sz * 0.12,
          bx + 0.9, 0.26, far + sz * 0.12);
      }
    }
    // The skull, jaw down, with two soot-black eye sockets.
    // Cranium and jaw are solid: at 1.4 m and 0.75 m they are both taller than
    // STEP_UP, so walking through them was walking through a skull.
    wall(solids, pieces, PAL_BONE, -9.0, 0, rz - 1.1, -6.2, 1.4, rz + 1.1, 'bevel');
    wall(solids, pieces, PAL_BONE, -10.9, 0, rz - 0.55, -8.6, 0.75, rz + 0.55, 'bevel');
    for (const sz of [-1, 1] as const) {
      deco(pieces, PAL_SOOT, -9.05, 0.72, rz + sz * 0.60 - 0.24,
        -7.9, 1.12, rz + sz * 0.60 + 0.24);
      // A horn off each side of the skull, so it reads as something that used
      // to be dangerous rather than a boulder.
      wall(solids, pieces, PAL_BONE, -7.6, 0.9, rz + sz * 0.95, -6.4, 1.25,
        rz + sz * 1.9);
    }
    // Straw litter, and the chain that used to hold something down.
    deco(pieces, PAL_THATCH, -3.0, 0, 44.0, 6.0, 0.22, 48.5);
    for (let i = 0; i < 7; i++) {
      deco(pieces, PAL_IRON, 9.0 + i * 1.05, 0, 42.4 + i * 0.22,
        9.7 + i * 1.05, 0.20, 42.7 + i * 0.22);
    }
    wall(solids, pieces, PAL_BASALT, 8.2, 0, 41.6, 9.4, 1.9, 42.8, 'bevel');
  }

  // =========================================================================
  // 4. The keep. Four storeys; each of levels 1-3 is a great hall with four
  //    doors leading to a wing on each side.
  // =========================================================================

  const HALL_HX = 13;
  const HALL_HZ = 11;
  const WING_T = 2.0;            // wall thickness between hall and wings

  /**
   * The stair to the keep roof, declared here because the throne room is built
   * before the stair is and has to know where the hole in its ceiling goes.
   *
   * Punched in section 5/6 (`stairwell`), not here — `cutSupport` can only edit
   * a floor that already exists, and the roof deck is authored last.
   */
  const ROOF_STAIRWELL: Rect = { x0: -13.0, z0: 6.0, x1: 9.9, z1: 11.0 };
  const DOOR_HALF = 1.6;
  const DOOR_TOP = 3.4;

  /** Wing rects for a level, in the order N, E, S, W. */
  const WINGS: { x0: number; z0: number; x1: number; z1: number }[] = [
    { x0: -HALL_HX, z0: -KEEP_HZ + 2, x1: HALL_HX, z1: -HALL_HZ - WING_T },
    { x0: HALL_HX + WING_T, z0: -HALL_HZ, x1: KEEP_HX - 2, z1: HALL_HZ },
    { x0: -HALL_HX, z0: HALL_HZ + WING_T, x1: HALL_HX, z1: KEEP_HZ - 2 },
    { x0: -KEEP_HX + 2, z0: -HALL_HZ, x1: -HALL_HX - WING_T, z1: HALL_HZ },
  ];

  for (let lv = 0; lv < 4; lv++) {
    const fy = LEVEL_Y[lv];
    const cy = LEVEL_CEIL[lv];
    const isUnder = lv === 0;
    const pal = isUnder ? PAL_BASALT : PAL_ASHLAR;

    // Undercroft is a smaller carved void; levels 1-3 fill the keep footprint.
    const kx = isUnder ? 17 : KEEP_HX;
    const kz = isUnder ? 15 : KEEP_HZ;

    // --- floor + ceiling -------------------------------------------------
    floorAt(supports, -kx + 2, -kz + 2, kx - 2, kz - 2, fy);
    ceilAt(ceilings, -kx + 2, -kz + 2, kx - 2, kz - 2, cy);
    fill(0, fy + 3, 0, isUnder ? 26 : 34);

    // --- keep shell ------------------------------------------------------
    // Only levels 1..3 carry the outer shell; the undercroft is inside it.
    if (!isUnder) {
      const top = lv === 3 ? KEEP_PARAPET_Y : LEVEL_CEIL[lv] + 1.0;
      const bot = fy - 1.0;
      // North shell: level 1 has the keep's great door.
      if (lv === 1) {
        wallWithDoor(solids, pieces, pal,
          -KEEP_HX, bot, -KEEP_HZ, KEEP_HX, top, -KEEP_HZ + 2, 'x', 0, 2.2, 4.4);
      } else {
        wall(solids, pieces, pal, -KEEP_HX, bot, -KEEP_HZ, KEEP_HX, top, -KEEP_HZ + 2);
      }
      wall(solids, pieces, pal, -KEEP_HX, bot, KEEP_HZ - 2, KEEP_HX, top, KEEP_HZ);
      wall(solids, pieces, pal, -KEEP_HX, bot, -KEEP_HZ, -KEEP_HX + 2, top, KEEP_HZ);
      wall(solids, pieces, pal, KEEP_HX - 2, bot, -KEEP_HZ, KEEP_HX, top, KEEP_HZ);

      // --- windows ---------------------------------------------------------
      //
      // These were two 20 cm slits per level buried in the 2 m wall thickness,
      // which from outside is invisible and from inside is a dark smear. They
      // are lancets now: a pointed arch in black basalt with RED GLASS in it,
      // on a sill, under a keystone. The glass is emissive, so at dusk the keep
      // has thirty red eyes in it and the player can see from the wilderness
      // which building the villain lives in.
      const wy0 = fy + 1.9;
      const wy1 = fy + 5.1;
      for (const s of [-1, 1] as const) {
        for (const wz of [-14.5, -5.0, 5.0, 14.5]) {
          lancet(pieces, s < 0 ? 2 : 3, wz, 1.15, wy0, wy1, s * KEEP_HX);
        }
        for (const wx of [-18.0, -8.5, 8.5, 18.0]) {
          lancet(pieces, s < 0 ? 0 : 1, wx, 1.15, wy0, wy1, s * KEEP_HZ);
        }
      }
    }

    // --- hall walls with their four doors --------------------------------
    if (!isUnder) {
      // North hall wall (door to the N wing).
      wallWithDoor(solids, pieces, pal,
        -HALL_HX, fy, -HALL_HZ - WING_T, HALL_HX, cy, -HALL_HZ,
        'x', 0, DOOR_HALF, fy + DOOR_TOP);
      // South hall wall (door to the S wing).
      wallWithDoor(solids, pieces, pal,
        -HALL_HX, fy, HALL_HZ, HALL_HX, cy, HALL_HZ + WING_T,
        'x', 0, DOOR_HALF, fy + DOOR_TOP);
      // West hall wall (door to the W wing).
      wallWithDoor(solids, pieces, pal,
        -HALL_HX - WING_T, fy, -HALL_HZ, -HALL_HX, cy, HALL_HZ,
        'z', 0, DOOR_HALF, fy + DOOR_TOP);
      // East hall wall (door to the E wing).
      wallWithDoor(solids, pieces, pal,
        HALL_HX, fy, -HALL_HZ, HALL_HX + WING_T, cy, HALL_HZ,
        'z', 0, DOOR_HALF, fy + DOOR_TOP);

      for (let w = 0; w < 4; w++) {
        const r = WINGS[w];
        // Stand toward the outer wall in the east and west wings: their
        // middles are taken by the stairs between levels, and a marker in a
        // stairwell would make the reachability proof fail for a room that is
        // perfectly fine to be in.
        const mx = w === 1 ? r.x1 - 2.3 : w === 3 ? r.x0 + 2.3 : (r.x0 + r.x1) / 2;
        mark(`L${lv}wing${w}`, mx, fy, (r.z0 + r.z1) / 2);
        fill((r.x0 + r.x1) / 2, fy + 2.5, (r.z0 + r.z1) / 2, 16);
      }
      mark(`L${lv}hall`, 0, fy, 0);

      // Hall colonnade + wall torches.
      for (const sx of [-1, 1] as const) {
        for (const sz of [-1, 1] as const) {
          wall(solids, pieces, pal,
            sx * 7 - 0.6, fy, sz * 6 - 0.6, sx * 7 + 0.6, cy, sz * 6 + 0.6, 'bevel');
          // Base and capital. A pillar that runs floor to ceiling at one width
          // is a post; the two 36-vert collars are what make it a column, and
          // the capital is where a hall's ceiling visibly lands on something.
          deco(pieces, PAL_BASALT, sx * 7 - 0.92, fy, sz * 6 - 0.92,
            sx * 7 + 0.92, fy + 0.55, sz * 6 + 0.92, 'bevel');
          deco(pieces, PAL_BASALT, sx * 7 - 0.95, cy - 0.75, sz * 6 - 0.95,
            sx * 7 + 0.95, cy - 0.20, sz * 6 + 0.95, 'bevel');
          deco(pieces, PAL_ASHLAR, sx * 7 - 1.05, cy - 0.20, sz * 6 - 1.05,
            sx * 7 + 1.05, cy, sz * 6 + 1.05);
        }
        torch(sx * (HALL_HX - 0.5), fy + 2.6, -4, 10);
        torch(sx * (HALL_HX - 0.5), fy + 2.6, 4, 10);
      }

      // --- what turns a room into a hall -----------------------------------
      //
      // Blind arcading down the two long walls. A great hall whose walls are
      // 26 m of unbroken flat plane has no rhythm in it and no way to judge how
      // far away the far end is; a row of arches gives it both, and the same
      // helper draws the windows outside so the inside and the outside of the
      // keep are describing one building.
      for (const sx of [-1, 1] as const) {
        for (const az of [-8.4, -2.8, 2.8, 8.4]) {
          archPanel(pieces, PAL_ASHLAR, PAL_BASALT, sx < 0 ? 3 : 2, az, 1.5,
            fy + 0.25, fy + 4.6, sx * (HALL_HX - 0.02), 0.62);
        }
      }
      // Ceiling ribs in dark timber, spanning the hall between the capitals.
      //
      // Carpentered, not extruded. A beam that runs wall to wall at one section
      // is a girder and reads as milled steel painted brown; what makes timber
      // read as WORKED is the joinery — a stepped corbel taking each end, a peg
      // driven through near the bearing, and a collar where two lengths were
      // scarfed together amidships. Eleven small boxes a beam, and they are the
      // only thing in a hall of stone that a person obviously made by hand.
      for (const rz of [-8.5, -4.0, 4.0, 8.5]) {
        // Not across an opening. On level 3 the hall's ceiling is punched for
        // the stair to the roof, and the rib at rz 8.5 lay right over it: the
        // last 6 m of the climb went through 53 cm of drawn oak at eye height,
        // in a place the collider has correctly opened. A carpenter does not
        // tie-beam a stairwell either.
        if (lv === 3 && rz + 0.52 > ROOF_STAIRWELL.z0 && rz - 0.52 < ROOF_STAIRWELL.z1) continue;
        deco(pieces, PAL_DARKWOOD, -HALL_HX, cy - 0.55, rz - 0.36,
          HALL_HX, cy - 0.02, rz + 0.36);
        for (const sx of [-1, 1] as const) {
          const ex = sx * HALL_HX;
          // Two-step corbel under the bearing end.
          deco(pieces, PAL_DARKWOOD, ex - sx * 0.9, cy - 1.02, rz - 0.44,
            ex, cy - 0.55, rz + 0.44);
          deco(pieces, PAL_DARKWOOD, ex - sx * 0.45, cy - 1.42, rz - 0.30,
            ex, cy - 1.02, rz + 0.30);
          // The peg through the joint, standing proud of the beam's soffit.
          deco(pieces, PAL_IRON, ex - sx * 1.55, cy - 0.44, rz - 0.44,
            ex - sx * 1.25, cy - 0.14, rz + 0.44);
        }
        // Scarf collar amidships, with its own pair of pegs.
        deco(pieces, PAL_DARKWOOD, -0.62, cy - 0.66, rz - 0.46,
          0.62, cy - 0.01, rz + 0.46);
        for (const sx of [-1, 1] as const) {
          deco(pieces, PAL_IRON, sx * 0.34 - 0.09, cy - 0.58, rz - 0.52,
            sx * 0.34 + 0.09, cy - 0.10, rz + 0.52);
        }
      }
      deco(pieces, PAL_DARKWOOD, -0.42, cy - 0.62, -HALL_HZ, 0.42, cy - 0.02, HALL_HZ);
      // A crimson runner down the middle of the floor, 6 cm proud. It is one
      // box, and it is the only warm colour in a room of grey stone.
      deco(pieces, PAL_CRIMSON, -2.6, fy, -HALL_HZ + 0.4, 2.6, fy + 0.06, HALL_HZ - 0.4);
      deco(pieces, PAL_BLACKFELT, -3.1, fy, -HALL_HZ + 0.4, -2.6, fy + 0.05, HALL_HZ - 0.4);
      deco(pieces, PAL_BLACKFELT, 2.6, fy, -HALL_HZ + 0.4, 3.1, fy + 0.05, HALL_HZ - 0.4);
      // Banners on the end walls, flanking each doorway and hung above head
      // height so nothing the player can touch is a thing they walk through.
      for (const sz of [-1, 1] as const) {
        for (const bx of [-5.6, 5.6]) {
          banner(pieces, sz < 0 ? 1 : 0, bx, 1.25, cy - 0.35, fy + 3.7,
            sz * (HALL_HZ - 0.02));
        }
      }
    }
  }

  // =========================================================================
  // 4b. The keep from OUTSIDE — the shape the player sees from the hillside,
  //     and the only view of the castle that most of a playthrough contains.
  //
  //     All relief: string courses, pilaster buttresses, a corbelled turret on
  //     each corner and a machicolated parapet. Not one line here touches
  //     `solids`, `supports` or `ceilings`.
  // =========================================================================
  {
    // --- the dark skin ------------------------------------------------------
    //
    // The keep's shell is the one wall in the castle that is exterior on one
    // side and a great hall on the other, so it cannot simply change palette.
    // Four `clad` faces put voidstone on the outside and leave the inside as
    // the ashlar the torches were lit for. The north face is split around the
    // great door, which is a genuine hole in `solids` — skinning across it
    // would draw a wall over the way in.
    // Stops 3 cm below the shell's own top: the skin overlaps the outer 5 cm of
    // the wall it covers, so carrying it to the same height would put a sliver
    // of voidstone coplanar with the parapet's ashlar cap all the way round.
    const KTOP = KEEP_PARAPET_Y - 0.03;
    const KBOT = LEVEL_Y[1] - 1.0;
    clad(pieces, 1, -KEEP_HX, KEEP_HX, KBOT, KTOP, KEEP_HZ);
    clad(pieces, 2, -KEEP_HZ, KEEP_HZ, KBOT, KTOP, -KEEP_HX);
    clad(pieces, 3, -KEEP_HZ, KEEP_HZ, KBOT, KTOP, KEEP_HX);
    // 2.22, not 2.2: the shell's own jambs end at 2.2 and the skin would meet
    // them face to face down both sides of the door.
    clad(pieces, 0, -KEEP_HX, -2.22, KBOT, KTOP, -KEEP_HZ);
    clad(pieces, 0, 2.22, KEEP_HX, KBOT, KTOP, -KEEP_HZ);
    clad(pieces, 0, -2.22, 2.22, 4.43, KTOP, -KEEP_HZ);

    const kBands = [7.4, 15.4, 23.2];
    for (const y of kBands) {
      const ox = KEEP_HX + 0.34; const oz = KEEP_HZ + 0.34;
      deco(pieces, PAL_GRAVE, -ox, y, -oz, ox, y + 0.5, -KEEP_HZ + 0.3);
      deco(pieces, PAL_GRAVE, -ox, y, KEEP_HZ - 0.3, ox, y + 0.5, oz);
      deco(pieces, PAL_GRAVE, -ox, y, -oz, -KEEP_HX + 0.3, y + 0.5, oz);
      deco(pieces, PAL_GRAVE, KEEP_HX - 0.3, y, -oz, ox, y + 0.5, oz);
      // Stitched over, on all four faces: the keep is the mass the player
      // circles, and these are what say the storeys were sewn on one at a time.
      stitchRun(pieces, 0, -24, 24, -oz, y - 0.24, y + 0.74, 3.4);
      stitchRun(pieces, 1, -24, 24, oz, y - 0.24, y + 0.74, 3.4);
      stitchRun(pieces, 2, -21, 21, -ox, y - 0.24, y + 0.74, 3.4);
      stitchRun(pieces, 3, -21, 21, ox, y - 0.24, y + 0.74, 3.4);
    }

    // Pilaster buttresses. Two courses each: 0.34 m of projection below head
    // height and 0.62 above, because the courtyard is walkable right up to this
    // wall and a bold plinth at ground level is something the player's shoulder
    // passes through. Above 2.6 m nobody can reach it, so it steps out.
    const pil = (face: Face, cu: number, surf: number): void => {
      const sg = faceSign(face);
      const lo = surf; const midOut = surf + sg * 0.34; const hiOut = surf + sg * 0.62;
      // Shaft in the mass palette, capital and base dressed: a buttress is the
      // wall standing forward, not a thing applied to it, so it wants to be the
      // wall's own colour and read by its own shadow.
      if (facesZ(face)) {
        deco(pieces, PAL_VOID, cu - 1.1, 0, lo, cu + 1.1, 2.6, midOut);
        deco(pieces, PAL_VOID, cu - 1.1, 2.6, lo, cu + 1.1, 23.2, hiOut);
        deco(pieces, PAL_GRAVE, cu - 1.3, 22.9, lo, cu + 1.3, 23.7, hiOut + sg * 0.16);
        deco(pieces, PAL_GRAVE, cu - 1.3, -0.3, lo, cu + 1.3, 0.5, hiOut + sg * 0.16);
      } else {
        deco(pieces, PAL_VOID, lo, 0, cu - 1.1, midOut, 2.6, cu + 1.1);
        deco(pieces, PAL_VOID, lo, 2.6, cu - 1.1, hiOut, 23.2, cu + 1.1);
        deco(pieces, PAL_GRAVE, lo, 22.9, cu - 1.3, hiOut + sg * 0.16, 23.7, cu + 1.3);
        deco(pieces, PAL_GRAVE, lo, -0.3, cu - 1.3, hiOut + sg * 0.16, 0.5, cu + 1.3);
      }
    };
    for (const cu of [-22.5, -13.5, 13.5, 22.5]) {
      pil(0, cu, -KEEP_HZ); pil(1, cu, KEEP_HZ);
    }
    for (const cu of [-19.5, -10.0, 10.0, 19.5]) {
      pil(2, cu, -KEEP_HX); pil(3, cu, KEEP_HX);
    }

    // One long banner on each flank, hung in the clear storey between the top
    // two string courses. The keep is 54 m of grey from the hillside and the
    // only thing that says whose it is was two banners on the door face, which
    // the player only sees from inside the walls.
    // Great hangings, not banners: this storey is 8 m tall and 54 m long, and a
    // 4 m banner on it is a postage stamp. These are the red the whole silhouette
    // is read against from the hillside.
    greatHanging(pieces, 1, 0, 4.0, 22.2, 16.0, KEEP_HZ);
    greatHanging(pieces, 2, 0, 4.0, 22.2, 16.0, -KEEP_HX);
    greatHanging(pieces, 3, 0, 4.0, 22.2, 16.0, KEEP_HX);
    // ...and a matching pair one storey down on the flanks, so the red runs the
    // height of the keep rather than sitting in one band near the top.
    for (const sx of [-1, 1] as const) {
      greatHanging(pieces, 2, sx * 15, 3.0, 14.2, 8.6, -KEEP_HX);
      greatHanging(pieces, 3, sx * 15, 3.0, 14.2, 8.6, KEEP_HX);
    }

    // Machicolated parapet under the roof deck.
    machicolation(pieces, 0, -24, 24, -KEEP_HZ, TOWER_BASE_Y, 3.0);
    machicolation(pieces, 1, -24, 24, KEEP_HZ, TOWER_BASE_Y, 3.0);
    machicolation(pieces, 2, -21, 21, -KEEP_HX, TOWER_BASE_Y, 3.0);
    machicolation(pieces, 3, -21, 21, KEEP_HX, TOWER_BASE_Y, 3.0);

    // --- corner turrets ----------------------------------------------------
    //
    // CORBELLED, starting at the second string course, and that is not a
    // stylistic choice: the courtyard plane runs right up to the keep, so a
    // turret carried down to the ground would be a solid the player walks
    // straight through — a change to walkability by the back door. Hung off a
    // bracket at 7.4 m it is out of reach, which is also the authentic form.
    for (const sx of [-1, 1] as const) {
      for (const sz of [-1, 1] as const) {
        const cx = sx * (KEEP_HX + 1.6);
        const cz = sz * (KEEP_HZ + 1.6);
        const hh = 2.6;
        for (let i = 0; i < 3; i++) {
          const g = hh - 0.75 + i * 0.30;
          deco(pieces, PAL_GRAVE, cx - g, 5.9 + i * 0.55, cz - g,
            cx + g, 6.45 + i * 0.55, cz + g, 'bevel');
        }
        deco(pieces, PAL_VOID, cx - hh, 7.4, cz - hh, cx + hh, 26.0, cz + hh, 'bevel');
        for (const y of [15.4, 23.2]) {
          deco(pieces, PAL_GRAVE, cx - hh - 0.26, y, cz - hh - 0.26,
            cx + hh + 0.26, y + 0.46, cz + hh + 0.26, 'bevel');
        }
        arrowSlit(pieces, sz < 0 ? 0 : 1, cx, 11.0, 2.0, cz + sz * hh);
        arrowSlit(pieces, sx < 0 ? 2 : 3, cz, 19.0, 2.0, cx + sx * hh);
        towerCrown(pieces, cx, cz, hh, 26.0, 1.2, 35.0, 6);
      }
    }

    // --- the great door ----------------------------------------------------
    //
    // The way in, and until now a 4.4 m square hole. A voussoir ring (real
    // opening, so nothing may be drawn across it), a tympanum above the lintel
    // carrying the king's device, and two engaged shafts either side.
    {
      const zf = -KEEP_HZ;
      archRing(pieces, PAL_GRAVE, 0, 0, 2.6, 3.3, zf, 0.62, 5);
      shape(pieces, PAL_GRAVE, 'arch', -2.3, 4.3, zf, 2.3, 6.5, zf + 0.30, 0, 0.08);
      deco(pieces, PAL_CRIMSON, -1.5, 4.6, zf - 0.34, 1.5, 5.9, zf - 0.24);
      deco(pieces, PAL_GLASS, -0.55, 5.0, zf - 0.46, 0.55, 5.6, zf - 0.32);
      for (const sx of [-1, 1] as const) {
        const cx = sx * 3.6;
        // The engaged shafts and the statue plinths are `wall()`: 4.9 m and
        // 1.5 m of drawn masonry either side of the keep's front door, on the
        // one approach every playthrough uses.
        wall(solids, pieces, PAL_GRAVE, cx - 0.62, 0, zf - 0.72, cx + 0.62, 4.9, zf, 'bevel');
        deco(pieces, PAL_VOID, cx - 0.82, 4.9, zf - 0.86, cx + 0.82, 5.5, zf, 'bevel');
        deco(pieces, PAL_VOID, cx - 0.82, -0.2, zf - 0.86, cx + 0.82, 0.5, zf, 'bevel');
        // Statue plinths flanking the approach, each with an iron cresset.
        wall(solids, pieces, PAL_GRAVE, sx * 6.6 - 1.0, 0, zf - 3.4,
          sx * 6.6 + 1.0, 1.5, zf - 1.4, 'bevel');
        deco(pieces, PAL_IRON, sx * 6.6 - 0.5, 1.5, zf - 2.9,
          sx * 6.6 + 0.5, 2.1, zf - 1.9);
        lights.push({ x: sx * 6.6, y: 2.5, z: zf - 2.4, flameScale: 1.2, radius: 11 });
        deco(pieces, PAL_TORCH, sx * 6.6 - 0.38, 2.1, zf - 2.8,
          sx * 6.6 + 0.38, 2.6, zf - 2.0);
      }
    }
  }

  // --- the undercroft: where the player wakes up ---------------------------
  {
    const fy = LEVEL_Y[0];
    const cy = LEVEL_CEIL[0];

    // The undercroft is a void carved INSIDE the motte, so unlike levels 1-3
    // it gets no keep shell from the loop above and needs its own. Without
    // these four walls the room has a floor and a ceiling and nothing else:
    // the first build looked straight out of the prison at the sky, because
    // the plinth is only a 2.4 m perimeter band and its middle is hollow.
    const ux = 17;
    const uz = 15;
    // Solid to y = 0 — the collision has to reach the courtyard or the player
    // walks into the shaft from above — but DRAWN 6 cm short of it. Their tops
    // are buried under the courtyard floor slab, which also ends at y = 0, and
    // two coplanar upward faces tie for depth: 512 m² of the courtyard was
    // flickering between soot and paving because of these four boxes. Stopping
    // the geometry short changes nothing anybody can see and settles the tie.
    for (const [x0, z0, x1, z1] of [
      [-ux, -uz, ux, -uz + 2], [-ux, uz - 2, ux, uz],
      [-ux, -uz, -ux + 2, uz], [ux - 2, -uz, ux, uz],
    ]) {
      solid(solids, x0, fy - SLAB_T, z0, x1, 0, z1);
      deco(pieces, PAL_SOOT, x0, fy - SLAB_T, z0, x1, -0.06, z1);
    }
    // Cell block: a corridor of barred cells down the west side. The player
    // starts in the far one; the door has already been forced.
    //
    // The cell block is CUT stone where the shell around it is rough: the
    // undercroft is a void hacked out of the motte and the prison is a thing
    // built inside it, and the whole room was one boulder texture until these
    // two lines separated them. This is the first thing the player ever sees.
    wall(solids, pieces, PAL_BASALT, -15, fy, -13, -15 + 1.4, cy, 13);
    for (let i = 0; i < 4; i++) {
      const cz = -10.5 + i * 7;
      // Cell divider walls.
      wall(solids, pieces, PAL_BASALT, -15, fy, cz - 0.6, -7, cy, cz + 0.6);
      // Bars along the corridor face, with a gap for the forced door in cell 0.
      if (i > 0) {
        for (let b = 0; b < 5; b++) {
          const bz = cz + 1.4 + b * 1.05;
          wall(solids, pieces, PAL_IRON, -7.2, fy, bz - 0.09, -6.9, cy - 1.0, bz + 0.09);
        }
      }
    }
    // --- dressing the prison -----------------------------------------------
    //
    // This is the FIRST THING THE PLAYER EVER SEES, and it was a black box with
    // bars in it. Arched cell mouths, a rib across the vault between each pair,
    // straw on every floor and a hanging chain: eight kinds of thing instead of
    // one, all of it above waist height or against a wall the player already
    // cannot walk into.
    for (let i = 0; i < 4; i++) {
      const cz = -10.5 + i * 7;
      archRing(pieces, PAL_BASALT, 3, cz + 3.5, 2.7, fy + 3.4, -6.9, 0.5, 4);
      // Transverse rib on the vault over the corridor, landing on a corbel.
      deco(pieces, PAL_BASALT, -6.9, cy - 0.55, cz - 0.34, 8.4, cy, cz + 0.34);
      deco(pieces, PAL_BASALT, -7.3, cy - 1.5, cz - 0.5, -6.5, cy - 0.4, cz + 0.5);
      // Straw in the occupied cells, and a chain on the divider wall.
      deco(pieces, PAL_THATCH, -13.2, fy, cz + 1.9, -9.6, fy + 0.18, cz + 4.6);
      for (let k = 0; k < 5; k++) {
        deco(pieces, PAL_IRON, -13.4, fy + 2.6 - k * 0.34, cz + 0.9,
          -13.2, fy + 2.9 - k * 0.34, cz + 1.1);
      }
    }
    // Player wakes in the northernmost cell, its bars ripped out.
    const spawnX = -11;
    const spawnZ = -12.0;
    mark('spawn', spawnX, fy, spawnZ);
    deco(pieces, PAL_THATCH, spawnX - 1.1, fy, spawnZ - 0.5,
      spawnX + 1.1, fy + 0.35, spawnZ + 1.4);   // the straw pallet
    // The bars that were torn out of this cell, lying where they fell. Two
    // boxes, and they are the only thing in the room that tells the player
    // something violent happened before they woke up.
    deco(pieces, PAL_IRON, -8.6, fy, -12.9, -7.1, fy + 0.16, -12.7);
    deco(pieces, PAL_IRON, -8.9, fy, -11.4, -7.4, fy + 0.20, -11.1);
    deco(pieces, PAL_IRON, -7.2, fy, -13.0, -6.9, fy + 2.4, -12.8);
    archRing(pieces, PAL_BASALT, 3, -12.0, 2.3, fy + 3.4, -6.9, 0.5, 4);
    torch(-6.2, fy + 2.6, -6, 9);
    torch(-6.2, fy + 2.6, 6, 9);
    torch(6.2, fy + 2.6, 0, 9);
    torch(-6.4, fy + 2.6, -12.4, 8);
    fill(spawnX, fy + 2, spawnZ, 14);

    // Guard room: the chest with the confiscated kit sits between the cell
    // block and the stair, in plain view from the corridor so the player walks
    // past it on the only route out. Deliberately NOT at x 8.5 — that is where
    // the stair shaft is, and the first placement put the chest in the hole.
    const chestX = 2.0;
    const chestZ = -8.0;
    mark('chest', chestX, fy, chestZ);
    wall(solids, pieces, PAL_DARKWOOD, -1.5, fy, -11.5, 5.5, fy + 0.9, -10.6); // rack
    // The chest itself. Body plus lid, black iron banding.
    deco(pieces, PAL_DARKWOOD, chestX - 0.62, fy, chestZ - 0.42,
      chestX + 0.62, fy + 0.62, chestZ + 0.42, 'bevel');
    deco(pieces, PAL_IRON, chestX - 0.66, fy + 0.62, chestZ - 0.46,
      chestX + 0.66, fy + 0.86, chestZ + 0.46, 'bevel');
    torch(chestX, fy + 2.8, chestZ - 2.2, 10);
    fill(chestX, fy + 2, chestZ, 16);

    // Stair out of the undercroft, hugging the east wall so it does not punch
    // a hole through the middle of the great hall above. 8.5 m of rise over
    // 14 m of run.
    // 8.5 m of rise over 22 m — a 21-degree climb. It was 14 m at first, and
    // the resulting 0.61 gradient made the player float: `groundHeight` takes
    // the max over the capsule ring, which on a steep ramp sits ~0.2 m above
    // the surface under your feet, so you climb in a series of small hops
    // instead of a walk.
    ramp(supports, pieces, PAL_SOOT, 8.5, -11.0, 12.5, 11.0, 'z', fy, LEVEL_Y[1]);
    torch(7.9, fy + 3.4, 0, 9);
    mark('undercroftStairFoot', 10.5, fy, -10.0);
    mark('undercroftStairHead', 10.5, LEVEL_Y[1], 10.5);

    // Open the shaft. The hole starts exactly where the ramp starts, not
    // before it: an opening that overruns its ramp by even a metre leaves a
    // gap with no support in it, and the player drops straight back into the
    // cells at the top of the climb.
    // z1 is the ramp's own z1, NOT a metre past it. The first version cut to
    // 8.2 against a ramp ending at 7.0, so the top 1.2 m of the climb had no
    // surface at all and the player dropped straight back into the cells. The
    // flood test still passed because you can also step sideways off the flight
    // onto the hall floor at x < 8 — which is exactly the kind of "green while
    // broken" only playing it catches.
    stairwell(supports, ceilings, LEVEL_Y[1], { x0: 8.5, z0: -11.0, x1: 12.5, z1: 10.9 });
  }

  // =========================================================================
  // 5. Stairs between keep levels. Each is in a different wing, so climbing
  //    the keep walks you through every part of it.
  // =========================================================================

  // Every opening below is cut to the ramp's OWN footprint, deliberately: the
  // first version cut a metre past each ramp and left an unsupported strip at
  // the head of every flight, which the reachability proof caught as "level 2
  // hall 18 m from the nearest walkable node".

  // Level 1 -> 2, in the EAST wing (wing 1), climbing north. Only 4.5 m of the
  // wing's 10 m width, so the wing stays a room with a stair in it rather than
  // becoming a stairwell with no floor.
  ramp(supports, pieces, PAL_ASHLAR, 16.0, -10.0, 20.5, 12.0, 'z', LEVEL_Y[2], LEVEL_Y[1]);
  stairwell(supports, ceilings, LEVEL_Y[2], { x0: 16.0, z0: -9.9, x1: 20.5, z1: 12.0 });
  mark('stair12', 18.2, LEVEL_Y[1], 11);
  // The HEAD as well as the foot. A route that walks from the foot straight at
  // the hall above it walks back down the flight — or, where the stairwell is
  // open beside it, off the edge of one. Every flight in the keep needs both
  // ends named for a walked route to exist at all.
  mark('stair12Head', 18.2, LEVEL_Y[2], -9.4);

  // Level 2 -> 3, in the WEST wing (wing 3), climbing south.
  ramp(supports, pieces, PAL_ASHLAR, -20.5, -10.0, -16.0, 12.0, 'z', LEVEL_Y[2], LEVEL_Y[3]);
  stairwell(supports, ceilings, LEVEL_Y[3], { x0: -20.5, z0: -10.0, x1: -16.0, z1: 11.9 });
  mark('stair23', -18.2, LEVEL_Y[2], -9);
  mark('stair23Head', -18.2, LEVEL_Y[3], 11.4);

  // Level 3 -> the keep roof (level 4), inside the tower's footprint so the
  // player emerges at the foot of the tower stair rather than outside a
  // doorless shaft.
  // Its stairwell is punched in section 6, where the roof deck it goes through
  // is authored — `cutSupport` can only edit a floor that already exists.
  // x0 is -13.0, the FACE of the hall's west wall, not -14.0. The wall is a
  // Solid from x -15 to -13, so a flight starting at -14 spends its first metre
  // inside masonry the player cannot enter: the drawn slab runs into the wall
  // and the climb really begins 33 cm up. Matching the ramp to the wall face
  // costs 1 m of run (gradient 0.33 -> 0.35, still a third of the STEP_UP
  // limit) and makes the drawn flight and the walkable flight the same object.
  ramp(supports, pieces, PAL_ASHLAR, ROOF_STAIRWELL.x0, 6.0, 10.0, 11.0, 'x',
    LEVEL_Y[3], TOWER_BASE_Y);
  mark('stair3T', -12, LEVEL_Y[3], 8.5);
  mark('stair3THead', 9.4, TOWER_BASE_Y, 8.5);

  // Throne room dressing (level 3 is the throne room). The dais sits on the
  // NORTH side because the stair to the roof takes the south half of the hall.
  {
    const fy = LEVEL_Y[3];
    // Dais. Drawn 2 cm ABOVE its own Support, because the Support derives a
    // floor slab whose top is also at fy + 0.35 over exactly this rect — the
    // one place in the castle where an authored block and a derived floor are
    // the same surface. Two cm settles which one the depth test sees, and the
    // king's dais should be the black one, not the hall's paving.
    deco(pieces, PAL_BASALT, -5.0, fy, -10.0, 5.0, fy + 0.37, -5.0, 'bevel');
    floorAt(supports, -5.0, -10.0, 5.0, -5.0, fy + 0.35);
    // Two low steps up to it, or the dais lip is a 0.35 m wall to nothing.
    ramp(supports, pieces, PAL_BASALT, -5.0, -5.0, 5.0, -3.6, 'z', fy + 0.35, fy);
    // Crimson felt over the dais top, running down the steps.
    deco(pieces, PAL_CRIMSON, -3.4, fy + 0.35, -9.8, 3.4, fy + 0.41, -3.7);

    // --- the throne --------------------------------------------------------
    //
    // It was a black box with a mustard slab on top and a red rectangle stuck
    // to the front, which from the doorway read as a filing cabinet. What makes
    // a throne is HEIGHT and a crest: a back that rises most of the way to the
    // ceiling, felt where a person sits, gold on the edges only, and a pointed
    // arch over the head of whoever is in it.
    const ty = fy + 0.35;
    // Seat and back are solid. The throne is the one piece of furniture in the
    // castle the player is guaranteed to walk up to, and they walked through it.
    wall(solids, pieces, PAL_BASALT, -1.55, ty, -9.3, 1.55, ty + 0.92, -7.5, 'bevel');
    deco(pieces, PAL_CRIMSON, -1.38, ty + 0.92, -9.1, 1.38, ty + 1.06, -7.6);  // cushion
    wall(solids, pieces, PAL_BASALT, -1.62, ty + 0.4, -9.45, 1.62, ty + 4.6, -8.85, 'bevel');
    deco(pieces, PAL_CRIMSON, -1.24, ty + 1.06, -8.85, 1.24, ty + 3.9, -8.74);
    deco(pieces, PAL_GOLD, -1.7, ty + 4.6, -9.5, 1.7, ty + 4.9, -8.8);
    // Crest: a pointed arch over the head, gold on black. This is the piece
    // that reads from the far end of the hall.
    shape(pieces, PAL_GOLD, 'arch', -1.5, ty + 4.5, -9.34, 1.5, ty + 6.5, -9.16,
      0, 0.10);
    shape(pieces, PAL_GLASS, 'arch', -0.9, ty + 4.9, -9.42, 0.9, ty + 6.1, -9.30,
      0, 0.10);
    for (const sx of [-1, 1] as const) {
      // Armrests and the posts under them.
      deco(pieces, PAL_BASALT, sx * 1.44 - 0.22, ty + 0.92, -9.0,
        sx * 1.44 + 0.22, ty + 1.46, -7.5, 'bevel');
      deco(pieces, PAL_GOLD, sx * 1.44 - 0.26, ty + 1.46, -9.0,
        sx * 1.44 + 0.26, ty + 1.60, -7.5);
      // Finials on the corners of the back.
      deco(pieces, PAL_BASALT, sx * 1.62 - 0.24, ty + 4.9, -9.44,
        sx * 1.62 + 0.24, ty + 5.9, -8.96);
      shape(pieces, PAL_GOLD, 'pyr', sx * 1.62 - 0.34, ty + 5.9, -9.54,
        sx * 1.62 + 0.34, ty + 6.7, -8.86);
      // Braziers on the dais, which is what lights the king's face from below.
      const bx = sx * 3.9;
      deco(pieces, PAL_IRON, bx - 0.16, ty, -8.9, bx + 0.16, ty + 1.15, -8.6);
      wall(solids, pieces, PAL_BASALT, bx - 0.72, ty + 1.05, -9.35, bx + 0.72,
        ty + 1.75, -8.15, 'bevel');
      lights.push({ x: bx, y: ty + 2.3, z: -8.75, flameScale: 1.5, radius: 14 });
      deco(pieces, PAL_TORCH, bx - 0.48, ty + 1.75, -9.15, bx + 0.48, ty + 2.3, -8.35);
      // The pair of tall banners either side of the dais.
      banner(pieces, 1, sx * 8.6, 1.5, fy + 6.4, fy + 1.4, -HALL_HZ + 0.02);
    }
    // The king's device on the wall behind the throne: black felt, crimson bar,
    // and a glowing red eye at the centre. Deliberately the largest single mark
    // of his colour anywhere inside the castle.
    deco(pieces, PAL_BLACKFELT, -4.6, fy + 1.2, -HALL_HZ + 0.02, 4.6, fy + 6.6,
      -HALL_HZ + 0.14);
    deco(pieces, PAL_CRIMSON, -3.6, fy + 2.0, -HALL_HZ + 0.14, 3.6, fy + 5.8,
      -HALL_HZ + 0.26);
    deco(pieces, PAL_GLASS, -1.1, fy + 3.4, -HALL_HZ + 0.26, 1.1, fy + 4.4,
      -HALL_HZ + 0.38);
    mark('throne', 0, fy + 0.35, -8.4);
    fill(0, fy + 4, -8, 22);
  }

  // =========================================================================
  // 6. The tower and the arena on top — the dragon's dock.
  // =========================================================================

  // Keep roof deck (level 4 floor), with the tower rising out of it.
  floorAt(supports, -KEEP_HX + 2, -KEEP_HZ + 2, KEEP_HX - 2, KEEP_HZ - 2, TOWER_BASE_Y);
  stairwell(supports, ceilings, TOWER_BASE_Y, ROOF_STAIRWELL);
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2;
    const mx = Math.cos(a) * (KEEP_HX - 1.0);
    const mz = Math.sin(a) * (KEEP_HZ - 1.0);
    if (Math.abs(mx) < KEEP_HX - 2.5 && Math.abs(mz) < KEEP_HZ - 2.5) continue;
    // 4 cm over KEEP_PARAPET_Y: the shell walls stop at exactly that height and
    // these teeth stand on the walls, so a flush top is two palettes in one
    // plane along the whole roof line.
    // `wall()`, because these ARE the roof's parapet. They ride an ellipse and
    // the shell walls under them are a rectangle, so roughly half of each tooth
    // overhangs the roof deck rather than the wall — 2.5 m of drawn stone the
    // player walked through, on the deck they fight the king on, with a 24 m
    // drop the other side of it.
    wall(solids, pieces, PAL_VOID, mx - 0.8, TOWER_BASE_Y, mz - 0.8,
      mx + 0.8, KEEP_PARAPET_Y + 0.04, mz + 0.8);
    shape(pieces, PAL_GRAVE, 'pyr', mx - 0.94, KEEP_PARAPET_Y + 0.04, mz - 0.94,
      mx + 0.94, KEEP_PARAPET_Y + 0.70, mz + 0.94);
  }
  mark('keepRoof', 0, TOWER_BASE_Y, 21.5);
  fill(0, TOWER_BASE_Y + 4, 0, 40);

  // Tower shaft: a 24-sided ring of wall segments from the keep roof to the
  // arena, with a switchback stair climbing the inside.
  const towerSeg = 24;
  for (let i = 0; i < towerSeg; i++) {
    const a0 = (i / towerSeg) * Math.PI * 2;
    const cx = Math.cos(a0) * (TOWER_R - 1.0);
    const cz = Math.sin(a0) * (TOWER_R - 1.0);
    // Voidstone all through. The drum is a stairwell, not a room — five torches
    // climb it and the arena disc caps it, so it was never a sunlit space to
    // protect, and a black shaft with a line of fires up it is the right last
    // climb before the dragon.
    //
    // Solid to ARENA_Y, drawn 3 cm short of it. The arena's floor slabs land on
    // exactly ARENA_Y and the drum is wider than the disc, so the ring where
    // they overlap was segment-top against arena-top in two palettes.
    // Its underside is clear of TOWER_BASE_Y - SLAB_T for the same reason: that
    // is where the keep-roof slab's underside lands, and the drum stands in it.
    solid(solids, cx - 1.5, TOWER_BASE_Y - 1.0, cz - 1.5, cx + 1.5, ARENA_Y, cz + 1.5);
    deco(pieces, PAL_VOID, cx - 1.5, TOWER_BASE_Y - 0.95, cz - 1.5,
      cx + 1.5, ARENA_Y - 0.03, cz + 1.5, 'bevel');
    // A dressed rib up every other segment, and a red lancet in every sixth.
    // The shaft is the tallest thing on the castle and it was a smooth drum;
    // the ribs give it verticality and the windows say something lives in it.
    const rx = Math.cos(a0) * (TOWER_R + 0.55);
    const rz = Math.sin(a0) * (TOWER_R + 0.55);
    if (i % 2 === 0) {
      // Starts 5 cm above the segment it is applied to, whose underside is at
      // TOWER_BASE_Y - 1 as well. Both are tucked under the roof deck, but a
      // shared plane is a shared plane.
      wall(solids, pieces, PAL_GRAVE, rx - 0.62, TOWER_BASE_Y - 0.95, rz - 0.62,
        rx + 0.62, ARENA_Y - 0.6, rz + 0.62);
    } else if (i % 6 === 3) {
      const face: Face = Math.abs(Math.cos(a0)) > Math.abs(Math.sin(a0))
        ? (Math.cos(a0) > 0 ? 3 : 2) : (Math.sin(a0) > 0 ? 1 : 0);
      const surf = facesZ(face) ? rz - 0.3 : rx - 0.3;
      const cu = facesZ(face) ? rx : rz;
      lancet(pieces, face, cu, 0.95, TOWER_BASE_Y + 2.4, ARENA_Y - 3.6, surf);
    }
  }
  // Four banners down the shaft, on the compass points. This is the highest
  // and most distant thing the player ever looks at, and a 10 m drum in one
  // grey has no scale in it at all.
  for (const [f, surf] of [[0, -19.5], [1, 19.5], [2, -19.5], [3, 19.5]] as const) {
    banner(pieces, f, 0, 1.8, ARENA_Y - 2.6, TOWER_BASE_Y + 2.2, surf);
  }
  // Corbel table under the arena floor, all the way round: the arena is a disc
  // 34 m up and without an overhang it reads as a plate balanced on a pipe.
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    const mx = Math.cos(a) * (TOWER_R + 0.6);
    const mz = Math.sin(a) * (TOWER_R + 0.6);
    deco(pieces, PAL_GRAVE, mx - 0.52, ARENA_Y - 2.0, mz - 0.52,
      mx + 0.52, ARENA_Y - 0.9, mz + 0.52);
    const ox = Math.cos(a) * (TOWER_R + 1.15);
    const oz = Math.sin(a) * (TOWER_R + 1.15);
    // 3 cm proud of ARENA_Y, so the ring reads as a kerb round the arena rather
    // than tying for depth with the tower segments below it, whose tops stop at
    // exactly ARENA_Y in the other palette. 1.44 rather than 1.5 for the same
    // reason on the vertical faces: at the compass points a 1.5 block sits in
    // the same four planes as the drum segment it is corbelled off.
    deco(pieces, PAL_GRAVE, ox - 1.44, ARENA_Y - 1.0, oz - 1.44,
      ox + 1.44, ARENA_Y + 0.03, oz + 1.44);
  }
  // One long straight flight up the inside of the shaft: 10 m of rise over
  // 27 m, a 20-degree climb. A four-flight switchback was tried first; its
  // flights overlapped the ramp arriving from the throne room, and the
  // max-height rule resolved the overlap into a step nobody could take.
  {
    ramp(supports, pieces, PAL_ASHLAR, -13.5, -5.0, 13.5, 1.0, 'x',
      TOWER_BASE_Y, ARENA_Y);
    for (let i = 0; i < 5; i++) {
      torch(-11 + i * 5.5, TOWER_BASE_Y + 3.6 + i * 2.0, -6.4, 11);
    }
    fill(0, TOWER_BASE_Y + 5, 0, 30);
  }
  // Inside the drum at the FOOT of the tower stair, and — the point — over a
  // piece of the keep roof that actually exists. It used to be (-8, 8.5), which
  // is inside the roof stairwell: the marker floated 6.3 m over the L3 flight
  // below it, so `castleTeleport('towerBase')` was a fall with damage and a
  // walked route from it started on the wrong storey.
  mark('towerBase', -15.5, TOWER_BASE_Y, -2);

  // The arena floor: a disc at ARENA_Y with a hole where the stair emerges.
  {
    // Approximate the disc with concentric axis-aligned bands so it stays
    // expressible as AABB supports. 12 bands reads as round at this scale.
    const bands = 12;
    for (let i = 0; i < bands; i++) {
      const z0 = -ARENA_R + (i / bands) * ARENA_R * 2;
      const z1 = -ARENA_R + ((i + 1) / bands) * ARENA_R * 2;
      const zm = Math.max(Math.abs(z0), Math.abs(z1));
      const hx = Math.sqrt(Math.max(0, ARENA_R * ARENA_R - zm * zm));
      if (hx < 0.5) continue;
      floorAt(supports, -hx, z0, hx, z1, ARENA_Y);
      ceilAt(ceilings, -hx, z0, hx, z1, ARENA_Y - SLAB_T);
    }
    // Stair mouth: exactly over the head of the tower flight, no further, or
    // the player steps off the top step into a hole.
    stairwell(supports, ceilings, ARENA_Y, { x0: -13.5, z0: -5.0, x1: 13.4, z1: 1.0 });
    // Where the tower flight surfaces on the disc. Both ends of this climb have
    // to be named or a route from `towerBase` aims diagonally at `arena` and
    // walks into the ROOF stairwell on the way — a 3.5 m drop back onto the
    // level-3 flight, which is what the first walked run of it did.
    mark('towerStairHead', 14.5, ARENA_Y, -2);

    // Parapet ring — 28 merlons so the arena reads as an arena, not a roof.
    //
    // They alternated black and pale grey, which at this scale is not two
    // materials, it is a chequerboard: the ring read as a novelty pattern and
    // the eye counted the squares instead of seeing a wall. One value, with a
    // pale cap on every tooth and an iron spike in every gap.
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      const mx = Math.cos(a) * (ARENA_R - 0.8);
      const mz = Math.sin(a) * (ARENA_R - 0.8);
      wall(solids, pieces, PAL_VOID,
        mx - 1.0, ARENA_Y, mz - 1.0, mx + 1.0, ARENA_PARAPET_Y, mz + 1.0);
      shape(pieces, PAL_GRAVE, 'pyr', mx - 1.16, ARENA_PARAPET_Y, mz - 1.16,
        mx + 1.16, ARENA_PARAPET_Y + 0.78, mz + 1.16);
      const g = a + Math.PI / 28;
      const gx = Math.cos(g) * (ARENA_R - 0.8);
      const gz = Math.sin(g) * (ARENA_R - 0.8);
      deco(pieces, PAL_IRON, gx - 0.12, ARENA_Y + 0.4, gz - 0.12,
        gx + 0.12, ARENA_Y + 2.3, gz + 0.12);
      shape(pieces, PAL_IRON, 'pyr', gx - 0.22, ARENA_Y + 2.3, gz - 0.22,
        gx + 0.22, ARENA_Y + 3.1, gz + 0.22);
    }
    // Braziers marking the dragon's dock — raised on iron legs and twice the
    // height, so from the courtyard 34 m below the arena is a ring of fires.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const bx = Math.cos(a) * (ARENA_R - 4.5);
      const bz = Math.sin(a) * (ARENA_R - 4.5);
      for (const lx of [-0.72, 0.72]) {
        for (const lz of [-0.72, 0.72]) {
          deco(pieces, PAL_IRON, bx + lx - 0.13, ARENA_Y, bz + lz - 0.13,
            bx + lx + 0.13, ARENA_Y + 1.35, bz + lz + 0.13);
        }
      }
      wall(solids, pieces, PAL_BASALT, bx - 1.05, ARENA_Y + 1.25, bz - 1.05,
        bx + 1.05, ARENA_Y + 2.5, bz + 1.05, 'bevel');
      deco(pieces, PAL_TORCH, bx - 0.72, ARENA_Y + 2.5, bz - 0.72,
        bx + 0.72, ARENA_Y + 3.1, bz + 0.72);
      lights.push({ x: bx, y: ARENA_Y + 3.3, z: bz, flameScale: 2.0, radius: 15 });
    }
    // The dragon's perch: a basalt block with iron rings set into it, at the
    // marker the boss code already docks him on.
    // Solid AND walkable: 0.55 rather than 0.7 so its top is inside STEP_UP and
    // the player steps up onto it instead of wading through it. A block with
    // neither a Solid nor a Support under its top face is the biggest single
    // piece of phantom mass in the castle — 5.2 m square, in the arena.
    wall(solids, pieces, PAL_BASALT, 3.4, ARENA_Y, 6.4, 8.6, ARENA_Y + 0.58, 11.6, 'bevel');
    // The Support is 3 cm UNDER the block's top face, so the ashlar floor slab
    // `derivedFloors` hangs off it lands inside the basalt and is occluded. Flush
    // would put PAL_ASHLAR and PAL_BASALT in one plane over 27 m² of arena.
    floorAt(supports, 3.4, 6.4, 8.6, 11.6, ARENA_Y + 0.55);
    for (const px of [4.2, 7.8]) {
      deco(pieces, PAL_IRON, px - 0.5, ARENA_Y + 0.58, 8.5, px + 0.5,
        ARENA_Y + 0.73, 9.5);
      deco(pieces, PAL_IRON, px - 0.12, ARENA_Y + 0.58, 8.9, px + 0.12,
        ARENA_Y + 1.18, 9.1);
    }
    mark('arena', 0, ARENA_Y, 8);
    mark('dragonPerch', 6, ARENA_Y, 9);
    fill(0, ARENA_Y + 4, 0, 34);
  }

  // =========================================================================
  // 7. The breach ramp — the escape route down the motte to open ground.
  //    The manager rewrites its far end to the real terrain height.
  // =========================================================================

  const breachSupportIndex = supports.length;
  const breachPieceIndex = pieces.length;
  ramp(supports, pieces, PAL_SOOT,
    OUTER_HX - 1.0, -5.0, OUTER_HX + BREACH_RAMP_RUN, 5.0, 'x', 0, -6.0);
  // Rubble spilling out of the hole so the ramp reads as collapsed masonry.
  for (let i = 0; i < 14; i++) {
    const rx = OUTER_HX + 1 + rng() * (BREACH_RAMP_RUN - 2);
    const rz = -6.5 + rng() * 13;
    const s = 0.5 + rng() * 1.1;
    const ry = -((rx - OUTER_HX) / BREACH_RAMP_RUN) * 6.0;
    deco(pieces, rng() < 0.5 ? PAL_STONE : PAL_SOOT,
      rx - s, ry - 0.3, rz - s, rx + s, ry + s * 0.7, rz + s);
  }
  mark('breachFoot', OUTER_HX + BREACH_RAMP_RUN, -6.0, 0);
  mark('outside', OUTER_HX + BREACH_RAMP_RUN + 14, -6.0, 0);

  // --- assemble ------------------------------------------------------------

  const chest: CastleChest = {
    x: markers.get('chest')!.x, y: LEVEL_Y[0], z: markers.get('chest')!.z, yaw: Math.PI,
  };
  const sp = markers.get('spawn')!;

  return {
    solids, supports, ceilings, pieces, lights, markers, chest,
    spawn: [sp.x, sp.y, sp.z],
    breach: [OUTER_HX, 0, 0],
    bounds: {
      x0: -PLINTH_HX, z0: -PLINTH_HZ,
      x1: PLINTH_HX + BREACH_RAMP_RUN + 4, z1: PLINTH_HZ,
    },
    floorOfLastResort: LEVEL_Y[0],
    breachRamp: { supportIndex: breachSupportIndex, pieceIndex: breachPieceIndex },
  };
}

/**
 * Pin the breach ramp's far end to the hillside.
 *
 * `terrainLocalY(localX, localZ)` returns the real terrain height expressed in
 * castle-local Y (i.e. `heightAt(world) - originY`). We march out from the wall
 * and stop at the first sample the ramp can land on without either ending in
 * mid-air or burying itself. Sites vary by ~16 m across this footprint, so
 * hard-coding the ramp would make the escape site-specific; this makes it
 * site-independent, which is what lets the castle be moved without re-testing
 * the one thing the player does in the first sixty seconds.
 */
export function fitBreachRamp(
  layout: CastleLayout,
  terrainLocalY: (x: number, z: number) => number,
): { run: number; drop: number } {
  const sup = layout.supports[layout.breachRamp.supportIndex];
  const piece = layout.pieces[layout.breachRamp.pieceIndex];
  const x0 = OUTER_HX - 1.0;
  // The ramp MUST land on the ground: `groundHeight` takes the max of ramp and
  // terrain outside the footprint, so a ramp that stops short leaves a sheer
  // drop at its end, and one that overshoots is buried. So the only free
  // variable is how far out it lands, and that is chosen to keep the slope
  // walkable rather than to keep the ramp short.
  //
  // At the chosen site the east face is a 13 m bluff before the ground even
  // starts falling, so a short ramp is a 47-degree slide. Marching out until
  // the average gradient drops under MAX_GRADE turns it into a long ruined
  // causeway spilling down the motte — which is both walkable and a much
  // clearer "this is the way out" than a hole with a cliff behind it.
  const MAX_RUN = 46;
  const MAX_GRADE = 0.56;             // ~29 degrees
  let run = MAX_RUN;
  for (let d = 8; d <= MAX_RUN; d += 1) {
    const t = terrainLocalY(x0 + d, 0);
    if (t >= -d * MAX_GRADE) { run = d; break; }
  }
  run = Math.max(8, run);
  const drop = Math.min(0, terrainLocalY(x0 + run, 0));
  sup.x1 = x0 + run;
  sup.y = 0;
  sup.dydx = (drop - 0) / run;
  sup.dydz = 0;
  piece.x1 = x0 + run;
  piece.y0 = Math.min(0, drop) - RAMP_THICKNESS;
  piece.y1 = 0;
  piece.rampDir = 1;                  // high edge at -x (against the wall)

  // Grow the footprint to cover the fitted ramp.
  //
  // `bounds` was sized for the NOMINAL run, and the collider buckets its
  // geometry over exactly that rect — so with a 46 m causeway fitted onto a
  // 16 m budget, the last 30 m fell outside the spatial grid, every query there
  // missed and returned bare terrain, and the player walked the back half of
  // the escape on the hillside inside the stonework.
  layout.bounds.x1 = Math.max(layout.bounds.x1, x0 + run + 8);

  // Kerbs down both sides. A causeway spilling down a 35 m crag with nothing
  // at its edges is a 5 m fall two steps to either side; this is also what
  // makes the route read as a route rather than a slope.
  const KERB = 1.4;
  const segs = 8;
  for (let i = 0; i < segs; i++) {
    const ax = x0 + (run * i) / segs;
    const bx = x0 + (run * (i + 1)) / segs;
    const ay = (drop * i) / segs;
    for (const z of [sup.z0 - 0.9, sup.z1]) {
      solid(layout.solids, ax, ay - RAMP_THICKNESS, z, bx, ay + KERB, z + 0.9);
      layout.pieces.push({
        // Drawn 2 cm inside its own Solid at each end: the courtyard plane was
        // cut to exactly the ramp's z span, so a kerb flush with that cut put
        // soot and paving in one plane down the length of the breach.
        pal: PAL_SOOT, kind: 'box',
        x0: ax, y0: ay - RAMP_THICKNESS - 1.0, z0: z + 0.02,
        x1: bx, y1: ay + KERB, z1: z + 0.88,
      });
    }
  }

  // The courtyard plane runs out to the plinth edge, six metres past where the
  // ramp begins. Left in place it wins the max-height rule all the way to the
  // lip and the player walks off a 4 m step onto the ramp; cut it, and the
  // ramp is the only surface in the breach corridor.
  cutSupport(layout.supports, 0, { x0, z0: sup.z0, x1: x0 + run, z1: sup.z1 });

  const m = layout.markers.get('breachFoot');
  if (m !== undefined) { m.x = x0 + run; m.y = drop; }
  const o = layout.markers.get('outside');
  if (o !== undefined) {
    o.x = x0 + run + 18;
    o.y = terrainLocalY(o.x, 0);      // out on the hillside, not at ramp height
  }
  return { run, drop };
}

// --- rect surgery ---------------------------------------------------------

/** An axis-aligned XZ rect. Exported so `castle-mesh` can reuse `subtract`. */
export interface Rect { x0: number; z0: number; x1: number; z1: number }

/**
 * Replace every support at height `y` that overlaps `hole` with up to four
 * rects around the hole. This is how stairwells get punched: a floor with a
 * hole in it is not expressible as one AABB, and forgetting to punch it means
 * the player walks up a stair and bonks into the slab above.
 */
function cutSupport(list: Support[], y: number, hole: Rect): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (Math.abs(s.y - y) > 1e-6 || s.dydx !== 0 || s.dydz !== 0) continue;
    if (!overlaps(s, hole)) continue;
    list.splice(i, 1);
    for (const r of subtract(s, hole)) {
      list.push({ ...r, y, dydx: 0, dydz: 0 });
    }
  }
}

/** Same surgery for ceilings. */
function cutCeil(list: Ceiling[], y: number, hole: Rect): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (Math.abs(c.y - y) > 1e-6) continue;
    if (!overlaps(c, hole)) continue;
    list.splice(i, 1);
    for (const r of subtract(c, hole)) list.push({ ...r, y });
  }
}

/**
 * Punch a stairwell: ONE rect, both cuts.
 *
 * A stairwell is two holes that must be the same hole — the floor of the storey
 * above (`floorY`) and the ceiling of the storey below (`floorY - SLAB_T`,
 * which is what `LEVEL_CEIL` is defined as). Written as two calls with two
 * hand-typed rect literals they drift, and they did: the level-3-to-roof pair
 * lived 78 lines and one section heading apart, and ended up 10 cm different in
 * x1, leaving a 0.1 x 5 m strip of drawn floor slab with no `Ceiling` under it —
 * a head clamp missing exactly where the player's head arrives.
 *
 * Call this AFTER the floor above exists: `cutSupport` only edits supports that
 * have already been pushed.
 */
function stairwell(sup: Support[], cei: Ceiling[], floorY: number, hole: Rect): void {
  cutSupport(sup, floorY, hole);
  cutCeil(cei, floorY - SLAB_T, hole);
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
}

/**
 * a minus b, as up to four axis-aligned rects.
 *
 * Exported because `castle-mesh` needs exactly this to stop two floor slabs at
 * the same height drawing over each other — see `derivedFloors` there. One
 * implementation, because the tricky part (the middle band's x-extents are
 * clipped to the overlap, not to `a`) is easy to get subtly wrong twice.
 */
export function subtract(a: Rect, b: Rect): Rect[] {
  const out: Rect[] = [];
  const mz0 = Math.max(a.z0, b.z0);
  const mz1 = Math.min(a.z1, b.z1);
  if (a.z0 < mz0) out.push({ x0: a.x0, z0: a.z0, x1: a.x1, z1: mz0 });
  if (a.z1 > mz1) out.push({ x0: a.x0, z0: mz1, x1: a.x1, z1: a.z1 });
  if (a.x0 < b.x0) out.push({ x0: a.x0, z0: mz0, x1: Math.min(a.x1, b.x0), z1: mz1 });
  if (a.x1 > b.x1) out.push({ x0: Math.max(a.x0, b.x1), z0: mz0, x1: a.x1, z1: mz1 });
  return out.filter((r) => r.x1 - r.x0 > 1e-6 && r.z1 - r.z0 > 1e-6);
}
