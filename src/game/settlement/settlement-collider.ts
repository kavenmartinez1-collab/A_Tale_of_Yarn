/**
 * Settlement collision — pure AABB solids derived from resolved pads (yaws
 * are 90°-quantized, so every obstacle is axis-aligned), plus a GroundQuery
 * wrapper that layers them over open terrain: walls block via the
 * axis-separated slide idiom (DungeonCollider), platform skirts and low
 * rubble are standable ground.
 */

import type { GroundQuery } from '../collision';
import { padHalfExtents, type ResolvedSettlement } from './settlement-layout';
import { pathSolids } from './settlement-paths';

export interface SolidBox {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Standable top (platforms) or wall top (blockers) in world y. */
  top: number;
}

export interface SettlementSolids {
  /** XZ footprints the capsule cannot enter. */
  blockers: SolidBox[];
  /** Standable tops (platform skirts, low rubble). */
  platforms: SolidBox[];
}

const SKIRT_MARGIN = 0.3;   // platform skirt overhang (settlement-mesh.ts)
const MIN_BLOCK_H = 0.8;    // lower ruins are rubble you can step on
const PIER_W = 2.2;         // gatehouse pier half-width (matches mesh)

/** Pure: one settlement's collision boxes. Memoize at the call site. */
export function buildSettlementSolids(s: ResolvedSettlement): SettlementSolids {
  const blockers: SolidBox[] = [];
  const platforms: SolidBox[] = [];
  for (const pad of s.pads) {
    const { hx, hz } = padHalfExtents(pad);
    const foot: SolidBox = {
      x0: pad.wx - hx, z0: pad.wz - hz,
      x1: pad.wx + hx, z1: pad.wz + hz,
      top: pad.wy + pad.h,
    };
    /** Blocker + the platform skirt that hides the downhill slope gap. */
    const solidWithSkirt = (): void => {
      blockers.push(foot);
      platforms.push({
        x0: foot.x0 - SKIRT_MARGIN, z0: foot.z0 - SKIRT_MARGIN,
        x1: foot.x1 + SKIRT_MARGIN, z1: foot.z1 + SKIRT_MARGIN,
        top: pad.wy + 0.08,
      });
    };
    switch (pad.type) {
      // Roofed structures: solid, and their skirt is standable.
      case 'house':
      case 'townhouse':
      case 'barn':
      case 'keep':
      case 'church':
      case 'tavern':
      case 'longhouse':
      case 'smithy':
      case 'mill':
      case 'granary':
      case 'tower':
      case 'wall':
      case 'stable':
        solidWithSkirt();
        break;
      // Solid furniture and clutter: block, but no standable top — a player
      // perched on a hay bale or a hedge looks worse than one walking round it.
      case 'well':
      case 'fence':
      case 'stall':
      case 'trough':
      case 'pillory':
      case 'shrine':
      case 'barrels':
      case 'hedge':
      case 'cart':
      case 'woodpile':
      case 'haystack':
      case 'brazier':
        blockers.push(foot);
        break;
      case 'ruin':
        if (pad.h >= MIN_BLOCK_H) blockers.push(foot);
        else platforms.push(foot); // rubble: step onto it
        break;
      // Poles, cloth and worked ground — walk straight through.
      case 'signpost':
      case 'lamp':
      case 'banner':
      case 'washline':
      case 'crops':
      case 'graves':
        break;
      case 'gatehouse': {
        // Two flanking piers; leave a 4.4 m passage in the center.
        // Left pier.
        blockers.push({
          x0: foot.x0, z0: foot.z0, x1: foot.x0 + (hx - PIER_W), z1: foot.z1,
          top: foot.top,
        });
        // Right pier.
        blockers.push({
          x0: foot.x1 - (hx - PIER_W), z0: foot.z0, x1: foot.x1, z1: foot.z1,
          top: foot.top,
        });
        // Lintel arch (above passage, no block at floor level).
        platforms.push({
          x0: foot.x0 - SKIRT_MARGIN, z0: foot.z0 - SKIRT_MARGIN,
          x1: foot.x1 + SKIRT_MARGIN, z1: foot.z1 + SKIRT_MARGIN,
          top: pad.wy + 0.08,
        });
        // Interior floor so player can walk inside.
        platforms.push({
          x0: foot.x0 + (hx - PIER_W), z0: foot.z0,
          x1: foot.x1 - (hx - PIER_W), z1: foot.z1,
          top: pad.wy + 0.08,
        });
        break;
      }
      case 'jail':
        // Jail is solid with a door gap on the -z face.
        // The gap is 1.1 m wide (±0.55); block the rest of the front face via
        // left/right flanks + back wall. For simplicity block the whole footprint;
        // the door gap is navigable because the player can walk through at ground level
        // (the door opening is 2.0 m tall — no ceiling blocker here).
        blockers.push(foot);
        platforms.push({
          x0: foot.x0 - SKIRT_MARGIN, z0: foot.z0 - SKIRT_MARGIN,
          x1: foot.x1 + SKIRT_MARGIN, z1: foot.z1 + SKIRT_MARGIN,
          top: pad.wy + 0.08,
        });
        // Interior floor pad so player can stand inside.
        platforms.push({
          x0: foot.x0 + 0.2, z0: foot.z0 + 0.2,
          x1: foot.x1 - 0.2, z1: foot.z1 - 0.2,
          top: pad.wy + 0.08,
        });
        break;
      default: {
        // Exhaustiveness guard. A new PadType with no case here would be
        // silently non-solid — the player walks through a new building and
        // nothing anywhere reports a problem. Make it a compile error.
        const unhandled: never = pad.type;
        void unhandled;
        break;
      }
    }
  }
  // Streets and stairs, last so that a tread standing over a building's skirt
  // wins the Math.max in groundHeight rather than being buried by it. Step
  // treads are PLATFORMS, never blockers — slideXZ ignores SolidBox.top, so a
  // blocker is an infinite prism and a staircase built out of them is a wall
  // you can never mount. See the header of settlement-paths.ts.
  pathSolids(s.paths, platforms, blockers);
  return { blockers, platforms };
}

/** Axis-separated capsule slide against blockers (2D XZ pushout). */
export function slideXZ(
  x: number, z: number, dx: number, dz: number, r: number,
  blockers: SolidBox[],
): [number, number] {
  let nx = x + dx;
  for (const b of blockers) {
    if (z > b.z0 - r && z < b.z1 + r && nx > b.x0 - r && nx < b.x1 + r) {
      nx = x >= (b.x0 + b.x1) / 2 ? b.x1 + r : b.x0 - r;
    }
  }
  let nz = z + dz;
  for (const b of blockers) {
    if (nx > b.x0 - r && nx < b.x1 + r && nz > b.z0 - r && nz < b.z1 + r) {
      nz = z >= (b.z0 + b.z1) / 2 ? b.z1 + r : b.z0 - r;
    }
  }
  return [nx, nz];
}

// ---------------------------------------------------------------------------
// Flier queries — the same boxes, read with a Y
// ---------------------------------------------------------------------------

/**
 * `slideXZ` never reads `SolidBox.top`, which makes every hut, wall and
 * haystack an INFINITELY TALL PRISM. That is why flight had to bypass
 * settlement collision entirely above 4 m: routing it through would have
 * stopped a dragon dead in the air over every village in the world.
 *
 * These three functions are the same boxes read with the flier's altitude in
 * hand, following the shape `CastleCollider.flierBlocked` / `flierMoveXZ`
 * already established for the keep.
 *
 * ## Only the flier's FEET matter, and there is no `y1`
 *
 * The castle takes a full [y0, y1] span because its solids are floors and
 * vaults with real undersides — you can fly beneath an arch. A settlement box
 * has no underside: it is a footprint with a top, rooted in the ground. So a
 * box can only ever be hit from above the ground, and `top <= y0` — the whole
 * thing is below the flier's feet — is the complete test. A rider sitting
 * above the mount cannot hit something the mount has already cleared.
 *
 * ## No spatial hash here, unlike the castle
 *
 * The castle buckets because it is one continuous structure of hundreds of
 * solids. A settlement's BLOCKER list is small — 11 for ruins, 26 for a
 * village, 65 for the biggest castle-town, measured — because the hundreds of
 * other boxes are platforms (path tiles), and the two moving queries only read
 * blockers. A linear scan of 65 rectangles two or three times a sim step is
 * not worth an index.
 *
 * `flierSupportAt` does read the platforms as well, because a stair tread is
 * somewhere you can land. That is the expensive one — up to ~730 boxes in a
 * terraced town — but it runs once per sim step and only for a mounted flier,
 * so it is ~44k rectangle tests a second in the single worst place in the
 * world. If that ever shows up in a profile, bucket THIS function; the other
 * two will still not need it.
 */
export function flierBlockedXZ(
  x: number, z: number, r: number, y0: number, blockers: SolidBox[],
): boolean {
  for (const b of blockers) {
    if (b.top <= y0) continue;                     // cleared it
    if (x + r <= b.x0 || x - r >= b.x1) continue;
    if (z + r <= b.z0 || z - r >= b.z1) continue;
    return true;
  }
  return false;
}

/**
 * Axis-separated horizontal slide for a flier: try X, then Z, then Z-first if
 * the X result poisoned it.
 *
 * Nothing here EJECTS, unlike `slideXZ`. Being flung out of a wall you touched
 * is worse than being stopped by it, and an ejection at altitude is how a
 * rider ends up on the wrong side of a keep on the next frame. Sliding rather
 * than refusing matters too: a dragon at 18 m/s that stops dead against a barn
 * reads as a crash, one that skates along it reads as flying.
 */
export function flierMoveXZ(
  x: number, z: number, dx: number, dz: number,
  r: number, y0: number, blockers: SolidBox[],
): [number, number] {
  let nx = x;
  let nz = z;
  if (dx !== 0 && !flierBlockedXZ(x + dx, z, r, y0, blockers)) nx = x + dx;
  if (dz !== 0 && !flierBlockedXZ(nx, z + dz, r, y0, blockers)) nz = z + dz;
  else if (dz !== 0 && !flierBlockedXZ(x, z + dz, r, y0, blockers)) {
    nz = z + dz;
    if (flierBlockedXZ(nx, nz, r, y0, blockers)) nx = x;
  }
  return [nx, nz];
}

/**
 * Highest surface at (x, z) a flier descending from `y` should settle onto,
 * or -Infinity for none. Roofs come from the BLOCKERS' tops — a building's
 * blocker top is its roofline — and stairs and skirts from the platforms.
 *
 * The `<= y + reach` gate is what keeps this from teleporting anything: a
 * dragon standing in the street next to a barn is BELOW the barn's roof, so
 * the roof is not a candidate and it stays in the street. Only something
 * already above the roofline can land on it.
 *
 * `reach` is slop, NOT a speed allowance — keep it small. The caller asks with
 * its PRE-move y and clamps its POST-move one, so any frame that crosses a
 * roofline started above it and is caught however fast the descent was. A
 * generous `reach` would instead let the roof of a building you are flying
 * PAST count as ground and fire you up onto it.
 */
export function flierSupportAt(
  x: number, z: number, r: number, y: number, reach: number,
  solids: SettlementSolids,
): number {
  let best = -Infinity;
  const ceiling = y + reach;
  for (const list of [solids.blockers, solids.platforms]) {
    for (const b of list) {
      if (b.top > ceiling || b.top <= best) continue;
      if (x + r <= b.x0 || x - r >= b.x1) continue;
      if (z + r <= b.z0 || z - r >= b.z1) continue;
      best = b.top;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Creature queries — the same boxes again, read with a Y and a step budget
// ---------------------------------------------------------------------------

/**
 * How high a ground creature can step without climbing.
 *
 * Matches `STEP_UP` in castle-layout.ts. Not imported from there: a settlement
 * has no business depending on the castle, and the number is a property of
 * legs, not of either building. It has to clear the tallest riser the street
 * generator emits, which `test-settlement-paths` reports as 0.45 m.
 */
const CREATURE_STEP = 0.6;

/**
 * Spatial index over a settlement's boxes, built on first creature query.
 *
 * The flier queries do not need one and say so: they read only `blockers`,
 * which is 11 boxes for a ruin and 65 for the biggest castle town, and they run
 * once a sim step for a single mounted flier. Ground creatures are a different
 * load in both directions. `creatureGroundAt` has to read the PLATFORMS —
 * street tiles, stair treads, terraces, building skirts — which is up to ~730
 * boxes in a terraced town, and it runs for every animal in the settlement,
 * twice per sim step. Twenty deer in a castle town is ~1.8 M rectangle tests a
 * second unindexed, which is exactly the sort of quiet quadratic that shows up
 * later as "the game gets slow near villages".
 *
 * A uniform grid fixes it because settlement boxes are small and the cell is
 * bigger than nearly all of them: a query touches one cell and reads the
 * handful of boxes that overlap it.
 */
const GRID = 8;

interface BoxGrid {
  cells: SolidBox[][];
  gw: number;
  gh: number;
  ox: number;
  oz: number;
}

function buildGrid(boxes: SolidBox[]): BoxGrid {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const b of boxes) {
    if (b.x0 < x0) x0 = b.x0;
    if (b.z0 < z0) z0 = b.z0;
    if (b.x1 > x1) x1 = b.x1;
    if (b.z1 > z1) z1 = b.z1;
  }
  if (boxes.length === 0) { x0 = z0 = x1 = z1 = 0; }
  const ox = Math.floor(x0 / GRID);
  const oz = Math.floor(z0 / GRID);
  const gw = Math.max(1, Math.floor(x1 / GRID) - ox + 1);
  const gh = Math.max(1, Math.floor(z1 / GRID) - oz + 1);
  const cells: SolidBox[][] = new Array(gw * gh);
  for (let i = 0; i < cells.length; i++) cells[i] = [];
  for (const b of boxes) {
    const i0 = Math.max(0, Math.floor(b.x0 / GRID) - ox);
    const i1 = Math.min(gw - 1, Math.floor(b.x1 / GRID) - ox);
    const j0 = Math.max(0, Math.floor(b.z0 / GRID) - oz);
    const j1 = Math.min(gh - 1, Math.floor(b.z1 / GRID) - oz);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) cells[j * gw + i].push(b);
    }
  }
  return { cells, gw, gh, ox, oz };
}

/** Boxes whose cell contains (x, z), or an empty list off the grid. */
function cellAt(g: BoxGrid, x: number, z: number): SolidBox[] {
  const i = Math.floor(x / GRID) - g.ox;
  const j = Math.floor(z / GRID) - g.oz;
  if (i < 0 || j < 0 || i >= g.gw || j >= g.gh) return EMPTY;
  return g.cells[j * g.gw + i];
}
const EMPTY: SolidBox[] = [];

/** A settlement's boxes plus the lazily-built index over them. */
export interface IndexedSolids extends SettlementSolids {
  blockerGrid: BoxGrid;
  platformGrid: BoxGrid;
}

/** Add the creature index to a solid set. Pure; memoize at the call site. */
export function indexSolids(s: SettlementSolids): IndexedSolids {
  return {
    ...s,
    blockerGrid: buildGrid(s.blockers),
    platformGrid: buildGrid(s.platforms),
  };
}

/**
 * Standable height at (x, z) for a creature whose feet are at `feetY`, or
 * `terrainY` when the settlement has nothing to stand on there.
 *
 * This is the query wildlife was missing. Animals stood on the RAW heightfield,
 * so they walked through platform skirts and terraces and came out under the
 * town — "stacked on top of the existing land", as the report put it, running
 * on ground the player can no longer see.
 *
 * ## Why the step budget, rather than the player's plain `Math.max`
 *
 * `settlementGround.groundHeight` takes the highest platform top overlapping
 * the capsule, full stop. That is right for a player, who is a 0.4 m radius
 * capsule the camera follows and who is expected to mount a stoop by walking at
 * it. It is wrong for a deer standing in the street beside a 2.2 m terrace: the
 * plain maximum snaps it to the terrace top, and the animal pops up onto a
 * retaining wall it never climbed.
 *
 * So a top only counts if it is within `CREATURE_STEP` of where the feet
 * already are. That makes a street tile, a stoop and a stair tread standable
 * and a terrace face a thing to walk around — which is the same distinction
 * `CastleCollider.creatureBlocked` draws for the motte, and for the same
 * reason.
 *
 * Deliberately no anti-void rescue: below everything, this returns `terrainY`
 * rather than hunting for a surface. A creature at the foot of a terrace should
 * stand on the ground at the foot of the terrace.
 */
export function creatureGroundAt(
  x: number, z: number, r: number, feetY: number, terrainY: number,
  s: IndexedSolids,
): number {
  let best = terrainY;
  const ceiling = feetY + CREATURE_STEP;
  for (const p of cellAt(s.platformGrid, x, z)) {
    if (p.top > ceiling || p.top <= best) continue;
    if (x + r <= p.x0 || x - r >= p.x1) continue;
    if (z + r <= p.z0 || z - r >= p.z1) continue;
    best = p.top;
  }
  return best;
}

/**
 * True when a creature of radius `r` and height `h`, feet at `feetY`, cannot
 * occupy (x, z).
 *
 * Y-aware, unlike `slideXZ`: a blocker stops the creature only if its top rises
 * more than a step above the feet. Without that, `slideXZ`'s infinite prisms
 * make every hay bale and every stair tread a wall — which is why the flier
 * queries exist at all, and ground creatures need the same treatment for the
 * same reason. The upper bound `feetY + h` is unused for now and deliberately
 * absent: a settlement box is a footprint with a top and no underside, so
 * nothing can be passed UNDER, and taking a height would imply otherwise.
 */
export function creatureBlockedXZ(
  x: number, z: number, r: number, feetY: number, blockers: BoxGrid,
): boolean {
  const stepOver = feetY + CREATURE_STEP;
  for (const b of cellAt(blockers, x, z)) {
    if (b.top <= stepOver) continue;                // step onto or over it
    if (x + r <= b.x0 || x - r >= b.x1) continue;
    if (z + r <= b.z0 || z - r >= b.z1) continue;
    return true;
  }
  return false;
}

/**
 * Axis-separated slide for a ground creature. Follows `flierMoveXZ`, not
 * `slideXZ`: it stops and slides rather than ejecting, because an animal flung
 * out of the wall it brushed ends up inside the building on the other side.
 */
export function creatureMoveXZ(
  x: number, z: number, dx: number, dz: number,
  r: number, feetY: number, blockers: BoxGrid,
): [number, number] {
  let nx = x;
  let nz = z;
  if (dx !== 0 && !creatureBlockedXZ(x + dx, z, r, feetY, blockers)) nx = x + dx;
  if (dz !== 0 && !creatureBlockedXZ(nx, z + dz, r, feetY, blockers)) nz = z + dz;
  else if (dz !== 0 && !creatureBlockedXZ(x, z + dz, r, feetY, blockers)) {
    nz = z + dz;
    if (creatureBlockedXZ(nx, nz, r, feetY, blockers)) nx = x;
  }
  return [nx, nz];
}

/**
 * Layer settlement solids over the open-terrain GroundQuery. `source` yields
 * the currently meshed settlements (SettlementManager.nearby); solids are
 * cached per settlement object.
 */
export interface SettlementWorld extends GroundQuery {
  /** Standable height for a ground creature, or `terrainY` outside the town. */
  creatureGround(x: number, z: number, r: number, feetY: number, terrainY: number): number;
  /** True when a ground creature with its feet at `feetY` is inside a solid. */
  creatureBlocked(x: number, z: number, r: number, feetY: number): boolean;
  /** Axis-separated slide for a ground creature; never ejects. */
  creatureMoveXZ(
    x: number, z: number, dx: number, dz: number, r: number, feetY: number,
  ): [number, number];
  /** True when a flier of radius `r` with its feet at `y0` is inside a wall. */
  flierBlocked(x: number, z: number, r: number, y0: number): boolean;
  /** Axis-separated slide for a flier; never ejects. */
  flierMoveXZ(
    x: number, z: number, dx: number, dz: number, r: number, y0: number,
  ): [number, number];
  /** Highest roof or platform under (x, z) a flier at `y` can settle onto. */
  flierSupport(x: number, z: number, r: number, y: number, reach: number): number;
}

export function settlementGround(
  base: GroundQuery,
  source: () => ResolvedSettlement[],
): SettlementWorld {
  // Indexed on build rather than lazily on first creature query: the grid is a
  // single pass over boxes that have just been built, and splitting it into a
  // second cache would mean two WeakMaps that can disagree about which
  // settlement they describe.
  const cache = new WeakMap<ResolvedSettlement, IndexedSolids>();
  const near = (x: number, z: number): IndexedSolids[] => {
    const out: IndexedSolids[] = [];
    for (const s of source()) {
      if (Math.hypot(x - s.site.x, z - s.site.z) > s.site.radius + 4) continue;
      let solids = cache.get(s);
      if (solids === undefined) {
        solids = indexSolids(buildSettlementSolids(s));
        cache.set(s, solids);
      }
      out.push(solids);
    }
    return out;
  };
  return {
    groundHeight(x, z, r) {
      let h = base.groundHeight(x, z, r);
      for (const { platforms } of near(x, z)) {
        for (const p of platforms) {
          if (x > p.x0 - r && x < p.x1 + r && z > p.z0 - r && z < p.z1 + r) {
            h = Math.max(h, p.top);
          }
        }
      }
      return h;
    },
    ceilingHeight(x, z) {
      return base.ceilingHeight(x, z);
    },
    moveXZ(x, z, dx, dz, r) {
      let [nx, nz] = base.moveXZ(x, z, dx, dz, r);
      for (const { blockers } of near(x, z)) {
        [nx, nz] = slideXZ(x, z, nx - x, nz - z, r, blockers);
      }
      return [nx, nz];
    },
    flierBlocked(x, z, r, y0) {
      for (const { blockers } of near(x, z)) {
        if (flierBlockedXZ(x, z, r, y0, blockers)) return true;
      }
      return false;
    },
    flierMoveXZ(x, z, dx, dz, r, y0) {
      let nx = x + dx;
      let nz = z + dz;
      // `near` is keyed on the START position, which is the same convention
      // `moveXZ` above uses: a single step is far shorter than the 4 m margin
      // on the settlement radius test, so a mover cannot cross a settlement
      // boundary within one step and miss its solids.
      for (const { blockers } of near(x, z)) {
        [nx, nz] = flierMoveXZ(x, z, nx - x, nz - z, r, y0, blockers);
      }
      return [nx, nz];
    },
    flierSupport(x, z, r, y, reach) {
      let best = -Infinity;
      for (const solids of near(x, z)) {
        best = Math.max(best, flierSupportAt(x, z, r, y, reach, solids));
      }
      return best;
    },
    creatureGround(x, z, r, feetY, terrainY) {
      let best = terrainY;
      for (const solids of near(x, z)) {
        best = Math.max(best, creatureGroundAt(x, z, r, feetY, terrainY, solids));
      }
      return best;
    },
    creatureBlocked(x, z, r, feetY) {
      for (const { blockerGrid } of near(x, z)) {
        if (creatureBlockedXZ(x, z, r, feetY, blockerGrid)) return true;
      }
      return false;
    },
    creatureMoveXZ(x, z, dx, dz, r, feetY) {
      let nx = x + dx;
      let nz = z + dz;
      // `near` is keyed on the START position, the same convention `moveXZ` and
      // `flierMoveXZ` use: one step is far shorter than the 4 m margin on the
      // settlement radius test, so a mover cannot cross a settlement boundary
      // within a step and miss its solids.
      for (const { blockerGrid } of near(x, z)) {
        [nx, nz] = creatureMoveXZ(x, z, nx - x, nz - z, r, feetY, blockerGrid);
      }
      return [nx, nz];
    },
  };
}
