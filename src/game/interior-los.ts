/**
 * Line of sight over a 1 m interior cell grid.
 *
 * Dungeons and building interiors both key their E-key prompt off nothing but
 * XZ distance, with a 3 m reach and 1 m cells. A wall is one cell. So a chest
 * in the keep's guard room, a bed behind a house's alcove partition and the
 * tavern's rentable bed all offer "Press E to open the chest" from the far side
 * of the wall — and pressing it works, because the action never looks at the
 * geometry either. Every partitioned interior in the game had at least one of
 * these; it is the same fault as the sealed stair shaft, drawn geometry and
 * gameplay disagreeing about where the walls are.
 *
 * Both grids use the same encoding (0 = solid, non-zero = floor or door) and
 * the same 1 m cell size, so this is one function rather than two that drift.
 */

/** Cell value that blocks sight, shared by DungeonLayout and BuildingInterior. */
const SOLID = 0;

/**
 * How close to either endpoint a solid cell is ignored.
 *
 * A chest in a corner is 0.5 m from two walls, and the straight line to it from
 * a legitimate standing spot diagonally opposite grazes the corner cell. Losing
 * the prompt there would make the chest unopenable, which is far worse than a
 * prompt through a wall — so the two end cells and anything within this radius
 * of an endpoint do not block. 0.75 m still catches a full 1 m wall between two
 * points 2 m apart, which is the case that actually happens.
 */
const ENDPOINT_SLACK = 0.75;

/** Marching step. Cells are 1 m, so this cannot step over one. */
const STEP = 0.2;

/**
 * True when nothing solid stands between (x0, z0) and (x1, z1).
 *
 * Coordinates are grid-local metres — cell (i, j) spans [i, i+1] x [j, j+1],
 * the same convention `dungeon-mesh` and `building-interior-mesh` draw with.
 */
export function cellLineOfSight(
  cells: Uint8Array, gridW: number, gridD: number,
  x0: number, z0: number, x1: number, z1: number,
): boolean {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-6) return true;
  // Nothing between two points closer together than the slack at each end.
  if (dist <= ENDPOINT_SLACK * 2) return true;

  const n = Math.ceil(dist / STEP);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const s = t * dist;
    if (s < ENDPOINT_SLACK || dist - s < ENDPOINT_SLACK) continue;
    const cx = Math.floor(x0 + dx * t);
    const cz = Math.floor(z0 + dz * t);
    if (cx < 0 || cz < 0 || cx >= gridW || cz >= gridD) return false;
    if (cells[cz * gridW + cx] === SOLID) return false;
  }
  return true;
}
