/**
 * CastleCollider — a multi-level `GroundQuery` for Castle Vhaeron.
 *
 * ## Why this exists rather than reusing DungeonCollider
 *
 * Both existing interior colliders return a CONSTANT from `groundHeight()`
 * (`dungeon-collider.ts:44-47`, `building-manager.ts:232-234`). Their world is
 * a 2D cell grid with one ceiling per column, which cannot express a hall with
 * another hall above it. A four-storey keep needs the floor height to be a
 * function of where the player already is, so this collider is built from
 * volumes instead of cells, and every query is resolved against the player's
 * CURRENT height.
 *
 * ## The step-up limit lives here
 *
 * `PlayerController` has no step-up limit and no slope limit: line 131 is an
 * unconditional `this.pos[1] = ground`, however large the delta. If
 * `groundHeight()` simply returned the highest surface over (x, z), standing in
 * the courtyard would teleport the player onto the arena parapet 36 m up. So
 * the rule is "the highest surface at or below `probeY + STEP_UP`", and that
 * single clause is what makes the whole castle walkable rather than a trap.
 *
 * ## The anti-void rescue
 *
 * If the player ends up below every surface at their column — a glitch, a
 * console teleport, a fall through a seam — `groundHeight()` returns the LOWEST
 * surface instead of falling through to terrain (terrain inside the footprint
 * is up on the hillside, ~28 m above the undercroft floor, and snapping to it
 * would fire the player through the keep). Returning the lowest surface pushes
 * them back onto a real floor. There is no configuration of this collider that
 * leaves the player with nowhere to stand.
 *
 * ## Creatures query this differently from the player
 *
 * `groundHeight`/`moveXZ` read the probe height from `probeY()`, which is the
 * PLAYER's. That is correct for the controller and wrong for everything else:
 * a goblin on the arena 34 m up and a player in the courtyard resolve to
 * completely different floors, and running the goblin against the player's
 * probe drops it through the tower. So the creature entry points below take an
 * explicit probe, and `groundHeight`/`moveXZ` are now thin wrappers that pass
 * `probeY()` into the same code — one implementation, two callers.
 *
 * They also deliberately do NOT get the anti-void rescue. The rescue exists
 * because the player must never be stuck; for a creature "I am below every
 * floor in this column" means "there is no castle here for me", and rescuing
 * it teleports a deer at the foot of the motte 28 m up into the undercroft.
 * `creatureGround` returns null instead, and `creatureBlocked` treats the
 * motte face as a wall so the deer walks around the hill rather than into it.
 */

import type { GroundQuery } from '../collision';
import type { Vec3 } from '../math';
import type { CastleLayout, Ceiling, Solid, Support } from './castle-layout';
import { PLAYER_H, SLAB_T, STEP_UP } from './castle-layout';

/** Spatial hash cell size, metres. Castle is ~130 m across → ~17x17 buckets. */
const GRID = 8;

/** Head clearance used when picking which ceiling is "above" the player. */
const CEIL_EPS = 0.3;

/** Camera march step and minimum pull-in, mirroring DungeonCollider. */
const CAM_STEP = 0.3;
const CAM_MIN_DIST = 0.6;

interface Bucketed<T> {
  cells: T[][];
  gw: number;
  gh: number;
  ox: number;
  oz: number;
}

function makeBuckets<T extends { x0: number; z0: number; x1: number; z1: number }>(
  items: T[], x0: number, z0: number, x1: number, z1: number,
): Bucketed<T> {
  const ox = Math.floor(x0 / GRID);
  const oz = Math.floor(z0 / GRID);
  const gw = Math.max(1, Math.ceil(x1 / GRID) - ox + 1);
  const gh = Math.max(1, Math.ceil(z1 / GRID) - oz + 1);
  const cells: T[][] = new Array(gw * gh);
  for (let i = 0; i < cells.length; i++) cells[i] = [];
  for (const it of items) {
    const cx0 = Math.max(0, Math.floor(it.x0 / GRID) - ox);
    const cx1 = Math.min(gw - 1, Math.floor(it.x1 / GRID) - ox);
    const cz0 = Math.max(0, Math.floor(it.z0 / GRID) - oz);
    const cz1 = Math.min(gh - 1, Math.floor(it.z1 / GRID) - oz);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) cells[cz * gw + cx].push(it);
    }
  }
  return { cells, gw, gh, ox, oz };
}

function bucketAt<T>(b: Bucketed<T>, x: number, z: number): T[] | null {
  const cx = Math.floor(x / GRID) - b.ox;
  const cz = Math.floor(z / GRID) - b.oz;
  if (cx < 0 || cz < 0 || cx >= b.gw || cz >= b.gh) return null;
  return b.cells[cz * b.gw + cx];
}

export class CastleCollider implements GroundQuery {
  private readonly solids: Bucketed<Solid>;
  private readonly supports: Bucketed<Support>;
  private readonly ceilings: Bucketed<Ceiling>;
  /** World-space footprint, inflated a little for the rejection test. */
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;

  /**
   * Live player height. Must be a getter, not a latched value: the controller
   * calls `groundHeight` twice per step — once before gravity and once after —
   * and a stale probe lets a fast fall tunnel straight through a floor.
   */
  probeY: () => number = () => 0;

  constructor(
    layout: CastleLayout,
    readonly origin: Vec3,
    private readonly base: GroundQuery,
  ) {
    const [ox, oy, oz] = origin;
    const S = layout.solids.map((s) => ({
      x0: s.x0 + ox, x1: s.x1 + ox, z0: s.z0 + oz, z1: s.z1 + oz,
      y0: s.y0 + oy, y1: s.y1 + oy,
    }));
    const P = layout.supports.map((s) => ({
      x0: s.x0 + ox, x1: s.x1 + ox, z0: s.z0 + oz, z1: s.z1 + oz,
      y: s.y + oy, dydx: s.dydx, dydz: s.dydz,
    }));
    const C = layout.ceilings.map((c) => ({
      x0: c.x0 + ox, x1: c.x1 + ox, z0: c.z0 + oz, z1: c.z1 + oz, y: c.y + oy,
    }));

    // Every flat floor also gets a SOLID spanning its own thickness.
    //
    // Without this a floor is a plane you can walk under and, fatally, walk
    // THROUGH from the side. Climbing the undercroft stair and stepping west
    // off it a metre below the landing, the level-1 slab was too high to step
    // onto (correctly — the rise exceeded STEP_UP) so `groundHeight` fell back
    // to the next surface down and posted the player through the floor into
    // the cells. Nothing about that is visible in a flood test, because the
    // flood also found the legitimate route; it took walking it to see.
    //
    // Derived here rather than in the layout because `fitBreachRamp` cuts the
    // courtyard AFTER the layout is built, and a solid derived too early would
    // still be standing across the breach.
    for (const s of layout.supports) {
      if (s.dydx !== 0 || s.dydz !== 0) continue;
      S.push({
        x0: s.x0 + ox, x1: s.x1 + ox, z0: s.z0 + oz, z1: s.z1 + oz,
        y0: s.y + oy - SLAB_T, y1: s.y + oy,
      });
    }
    this.x0 = layout.bounds.x0 + ox;
    this.z0 = layout.bounds.z0 + oz;
    this.x1 = layout.bounds.x1 + ox;
    this.z1 = layout.bounds.z1 + oz;
    this.solids = makeBuckets(S, this.x0, this.z0, this.x1, this.z1);
    this.supports = makeBuckets(P, this.x0, this.z0, this.x1, this.z1);
    this.ceilings = makeBuckets(C, this.x0, this.z0, this.x1, this.z1);
  }

  /** True when (x, z) is anywhere over the castle footprint. */
  inFootprint(x: number, z: number): boolean {
    return x >= this.x0 && x <= this.x1 && z >= this.z0 && z <= this.z1;
  }

  /** Height of `s` at (x, z) — a plane evaluation. */
  private static planeY(s: Support, x: number, z: number): number {
    return s.y + (x - s.x0) * s.dydx + (z - s.z0) * s.dydz;
  }

  /**
   * The surface the player stands on at one sample point.
   *
   * Returns `null` when there is no castle surface here at all, so the caller
   * can fall through to terrain.
   *
   * `rescue` is what separates the player from everything else. See the class
   * comment: the player must never be stuck, so being below every floor snaps
   * them up onto the lowest one; a creature below every floor is simply not on
   * the castle, and hauling it up teleports a deer at the foot of the motte
   * into the undercroft.
   */
  private surfaceAt(
    x: number, z: number, probe: number, rescue = true,
  ): number | null {
    const list = bucketAt(this.supports, x, z);
    if (list === null || list.length === 0) return null;
    const limit = probe + STEP_UP;
    let best = -Infinity;
    let lowest = Infinity;
    for (const s of list) {
      if (x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue;
      const h = CastleCollider.planeY(s, x, z);
      if (h < lowest) lowest = h;
      if (h <= limit && h > best) best = h;
    }
    if (best > -Infinity) return best;
    // Below every floor in this column: rescue upward to the lowest one rather
    // than let terrain (up on the hillside) yank the player through the keep.
    if (rescue && lowest < Infinity) return lowest;
    return null;
  }

  /**
   * Shared body of `groundHeight`, with the probe passed in.
   *
   * `rescue: false` makes the return meaningful for a creature: null means
   * "no castle surface I can stand on here", which the caller answers with
   * terrain rather than with a 28 m snap upward.
   */
  private groundAt(
    x: number, z: number, r: number, probe: number, rescue: boolean,
  ): number | null {
    // Max over centre + 4 ring samples, exactly as terrainGround does, so the
    // capsule edge never clips a step or a wall base.
    let best = -Infinity;
    let any = false;
    const px = [x, x + r, x - r, x, x];
    const pz = [z, z, z, z + r, z - r];
    for (let i = 0; i < 5; i++) {
      const h = this.surfaceAt(px[i], pz[i], probe, rescue);
      if (h === null) continue;
      any = true;
      if (h > best) best = h;
    }
    return any ? best : null;
  }

  groundHeight(x: number, z: number, r: number): number {
    const best = this.groundAt(x, z, r, this.probeY(), true);
    if (best === null) return this.base.groundHeight(x, z, r);
    // Outside the walls the motte meets real terrain; take whichever is higher
    // so the breach ramp blends into the hillside without a lip.
    if (!this.inFootprint(x, z)) return Math.max(best, this.base.groundHeight(x, z, r));
    return best;
  }

  // --- creature queries ----------------------------------------------------
  //
  // Same geometry, explicit probe, no rescue. `stepAnimal` runs one creature at
  // a time and each is on its own storey, so nothing here may read `probeY()`.

  /**
   * The castle surface a creature whose feet are at `probe` stands on at
   * (x, z), or null when the castle offers it nothing here.
   */
  creatureGround(x: number, z: number, r: number, probe: number): number | null {
    return this.groundAt(x, z, r, probe, false);
  }

  /**
   * True when a creature of radius `r` and height `h`, feet at `probe`, cannot
   * occupy (x, z).
   *
   * Two things block it, and the second is the one that matters for wildlife:
   *
   *   - a solid overlapping its body span — walls, piers, merlons, as for the
   *     player;
   *   - the MOTTE ITSELF. The plinth face is decoration, not a `Solid`
   *     (`castle-layout.ts` draws it with `deco`), so nothing stops a deer at
   *     the bottom of the hill from walking straight into the hillside — and
   *     once inside the footprint it is below every floor. Treating "there is
   *     a castle floor here but it is more than a step above me" as blocked
   *     turns the motte into the cliff it visually is, and the animal walks
   *     around it instead of being buried in it.
   */
  creatureBlocked(
    x: number, z: number, r: number, probe: number, h: number,
  ): boolean {
    if (this.blocked(x, z, r, probe + STEP_UP, probe + h)) return true;
    // Unreachable floor overhead = the motte face, or the outside of a wall.
    // Only inside the footprint: past it there is no castle to climb.
    if (!this.inFootprint(x, z)) return false;
    if (this.groundAt(x, z, r, probe, false) !== null) return false;
    return this.groundAt(x, z, r, probe, true) !== null;
  }

  /**
   * `moveXZ` for a creature: the same axis-separated slide the player gets,
   * against the creature's own probe height and body.
   *
   * Does NOT delegate to `this.base` — the caller has already applied whatever
   * terrain/settlement move it wants and hands the accepted delta in, so
   * running the base again would compose two slides and steer animals
   * sideways along walls they were never touching.
   */
  creatureMoveXZ(
    x: number, z: number, dx: number, dz: number,
    r: number, probe: number, h: number,
  ): [number, number] {
    let nx = x;
    let nz = z;
    if (dx !== 0 && !this.creatureBlocked(x + dx, z, r, probe, h)) nx = x + dx;
    if (dz !== 0 && !this.creatureBlocked(nx, z + dz, r, probe, h)) nz = z + dz;
    else if (dz !== 0 && !this.creatureBlocked(x, z + dz, r, probe, h)) {
      nz = z + dz;
      if (this.creatureBlocked(nx, nz, r, probe, h)) nx = x;
    }
    return [nx, nz];
  }

  // --- flier queries -------------------------------------------------------
  //
  // A flying mount is neither the player nor a walking animal. It has no
  // storey, no step-up and no floor to resolve against: it is a box in the
  // air, and the only question worth asking is whether that box is inside
  // masonry. So these are pure `Solid` span tests with no ground reasoning at
  // all — deliberately NOT `creatureBlocked`, whose motte clause ("there is a
  // castle floor here but it is above me, so this is the hillside") is exactly
  // right for a deer at the foot of the hill and exactly wrong for a dragon
  // flying past the keep at courtyard level.

  /**
   * True when any castle solid overlaps the box (x±r, z±r, [y0, y1]).
   *
   * Unlike `blocked`, this reads EVERY bucket the box touches instead of only
   * the one containing its centre. That distinction does not matter for a
   * 0.35 m player — their whole capsule sits inside one 8 m cell almost
   * always — but a flying dragon is over 3 m of radius, and the tower whose
   * bucket its centre has not yet entered is precisely the tower it would
   * otherwise put a wing through.
   */
  flierBlocked(x: number, z: number, r: number, y0: number, y1: number): boolean {
    const b = this.solids;
    const cx0 = Math.max(0, Math.floor((x - r) / GRID) - b.ox);
    const cx1 = Math.min(b.gw - 1, Math.floor((x + r) / GRID) - b.ox);
    const cz0 = Math.max(0, Math.floor((z - r) / GRID) - b.oz);
    const cz1 = Math.min(b.gh - 1, Math.floor((z + r) / GRID) - b.oz);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (const s of b.cells[cz * b.gw + cx]) {
          if (s.y1 <= y0 || s.y0 >= y1) continue;
          if (x + r <= s.x0 || x - r >= s.x1) continue;
          if (z + r <= s.z0 || z - r >= s.z1) continue;
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Axis-separated horizontal slide for a flier, same shape as
   * `creatureMoveXZ`: try X, then Z, then Z-first if the X result poisoned it.
   *
   * Sliding rather than refusing matters more here than on the ground. A
   * dragon at 18 m/s that simply stops dead against the curtain wall reads as
   * a crash; one that skates along it reads as flying. Nothing here ever
   * EJECTS — being flung out of a wall you touched is worse than being
   * stopped by it, and an ejection at altitude is how a rider ends up inside
   * the keep on the next frame.
   */
  flierMoveXZ(
    x: number, z: number, dx: number, dz: number,
    r: number, y0: number, y1: number,
  ): [number, number] {
    let nx = x;
    let nz = z;
    if (dx !== 0 && !this.flierBlocked(x + dx, z, r, y0, y1)) nx = x + dx;
    if (dz !== 0 && !this.flierBlocked(nx, z + dz, r, y0, y1)) nz = z + dz;
    else if (dz !== 0 && !this.flierBlocked(x, z + dz, r, y0, y1)) {
      nz = z + dz;
      if (this.flierBlocked(nx, nz, r, y0, y1)) nx = x;
    }
    return [nx, nz];
  }

  ceilingHeight(x: number, z: number): number {
    const list = bucketAt(this.ceilings, x, z);
    if (list === null || list.length === 0) return this.base.ceilingHeight(x, z);
    const probe = this.probeY() + CEIL_EPS;
    let best = Infinity;
    for (const c of list) {
      if (x < c.x0 || x > c.x1 || z < c.z0 || z > c.z1) continue;
      if (c.y <= probe) continue;      // a slab below us is a floor, not a roof
      if (c.y < best) best = c.y;
    }
    return best;
  }

  /**
   * True when a capsule standing at (x, z) with its feet at `probe` is inside a
   * wall. Exposed for `test-castle-layout.mts`'s stair-edge invariant.
   */
  isBlockedAt(x: number, z: number, r: number, probe: number): boolean {
    return this.blocked(x, z, r, probe + STEP_UP, probe + PLAYER_H);
  }

  /** True when a capsule at (x, z) with the given body span hits a solid. */
  private blocked(x: number, z: number, r: number, lo: number, hi: number): boolean {
    const list = bucketAt(this.solids, x, z);
    if (list === null) return false;
    for (const s of list) {
      if (s.y1 <= lo || s.y0 >= hi) continue;
      if (x + r <= s.x0 || x - r >= s.x1) continue;
      if (z + r <= s.z0 || z - r >= s.z1) continue;
      return true;
    }
    return false;
  }

  moveXZ(x: number, z: number, dx: number, dz: number, r: number): [number, number] {
    const [bx, bz] = this.base.moveXZ(x, z, dx, dz, r);
    // Base may itself have slid us (settlement blockers); keep its result as
    // the proposed delta so both colliders compose instead of fighting.
    const px = bx - x;
    const pz = bz - z;
    const probe = this.probeY();
    // Anything shorter than a step is furniture to walk over, not a wall.
    const lo = probe + STEP_UP;
    const hi = probe + PLAYER_H;
    let nx = x;
    let nz = z;
    if (px !== 0 && !this.blocked(x + px, z, r, lo, hi)) nx = x + px;
    if (pz !== 0 && !this.blocked(nx, z + pz, r, lo, hi)) nz = z + pz;
    else if (pz !== 0 && !this.blocked(x, z + pz, r, lo, hi)) {
      // Sliding along X put us inside a wall the pure-Z move clears; prefer Z.
      nz = z + pz;
      if (this.blocked(nx, nz, r, lo, hi)) nx = x;
    }
    return [nx, nz];
  }

  /**
   * Camera collision. Marches from the player toward the desired eye and stops
   * short of the first solid, then clamps under the ceiling. Without this the
   * third-person camera sits outside the keep and films the wall.
   */
  clampCameraEye(target: Vec3, desired: Vec3): Vec3 {
    const dx = desired[0] - target[0];
    const dy = desired[1] - target[1];
    const dz = desired[2] - target[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-4) return [...desired] as Vec3;
    const ux = dx / dist;
    const uy = dy / dist;
    const uz = dz / dist;
    let travelled = dist;
    for (let t = CAM_STEP; t <= dist; t += CAM_STEP) {
      const sx = target[0] + ux * t;
      const sy = target[1] + uy * t;
      const sz = target[2] + uz * t;
      if (this.blocked(sx, sz, 0.25, sy - 0.2, sy + 0.2)) {
        travelled = Math.max(CAM_MIN_DIST, t - CAM_STEP);
        break;
      }
    }
    const ex = target[0] + ux * travelled;
    const ey = target[1] + uy * travelled;
    const ez = target[2] + uz * travelled;
    // Keep the eye out of the floor and under the ceiling of the room we are
    // actually in — probeY is the player's, which is what we want here.
    const probe = this.probeY();
    const floor = this.surfaceAt(ex, ez, probe);
    let y = ey;
    if (floor !== null && y < floor + 0.35) y = floor + 0.35;
    const ceil = this.ceilingHeight(ex, ez);
    if (ceil < Infinity && y > ceil - 0.25) y = ceil - 0.25;
    return [ex, y, ez];
  }

  /** True when the player at (x, y, z) is under a roof — drives camera mode. */
  isRoofed(x: number, y: number, z: number): boolean {
    const list = bucketAt(this.ceilings, x, z);
    if (list === null) return false;
    for (const c of list) {
      if (x < c.x0 || x > c.x1 || z < c.z0 || z > c.z1) continue;
      if (c.y > y + CEIL_EPS && c.y < y + 14) return true;
    }
    return false;
  }
}
