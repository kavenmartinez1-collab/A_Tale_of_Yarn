/**
 * Deterministic dungeon layout — embeds the spec's room graph on a 1 m cell
 * grid. Same (spec, seed) ⇒ byte-identical output; the future AI Director
 * must be able to rerun a spec and reproduce the exact dungeon.
 *
 * Algorithm: seeded BFS spanning-tree embedding. The entrance room sits at
 * grid center; each child room is placed beyond a parent wall at the end of
 * a straight 2-cell-wide corridor. Non-tree (loop) edges try two L-shaped
 * corridor variants and are dropped deterministically if blocked — the tree
 * already guarantees connectivity. If any room cannot be placed the whole
 * layout retries with a remixed seed (8 attempts), then falls back to a
 * deterministic straight-chain layout that always fits.
 *
 * Determinism rules: single mulberry32 stream per attempt, all draws in
 * fixed array order (spec order / BFS order), never object-key order.
 */

import type { DungeonSpec, RoomSpec, RoomType, RoomSize, ItemId } from './dungeon-spec';

export const CELL_SOLID = 0;
export const CELL_FLOOR = 1;
export const CELL_DOOR = 2;

export interface PlacedRoom {
  id: string;
  type: RoomType;
  /** Interior floor rect in cells; walls are the Solid boundary around it. */
  x: number;
  z: number;
  w: number;
  d: number;
  /** Interior center cell. */
  cx: number;
  cz: number;
  /** Ceiling height above the floor (m). */
  ceil: number;
}

export interface DungeonLayout {
  w: number;
  h: number;
  /** w*h cells, CELL_* values, row-major [z*w + x]. */
  cells: Uint8Array;
  /** Per-cell ceiling height (m); 0 for solid cells. Floor is y=0 local. */
  ceilY: Float32Array;
  /** rooms[0] is always the entrance room. */
  rooms: PlacedRoom[];
  spawnCell: [number, number];
  exitPortalCell: [number, number];
  /** Wall the exit portal leans against: 0 N(-z), 1 E(+x), 2 S(+z), 3 W(-x). */
  exitWallDir: number;
  chests: { cell: [number, number]; items: ItemId[] }[];
  torches: { cell: [number, number]; wallDir: number }[];
  /** True when the straight-chain fallback was used. */
  fallback: boolean;
}

// --- deterministic PRNG ----------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mix three 32-bit ints into one (seed derivation for layouts/attempts). */
export function mix32(a: number, b: number, c = 0): number {
  let h = a >>> 0;
  h = Math.imul(h ^ (b >>> 0), 0x9e3779b1);
  h = ((h << 13) | (h >>> 19)) >>> 0;
  h = Math.imul(h ^ (c >>> 0), 0x85ebca6b);
  h = ((h << 13) | (h >>> 19)) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- room footprints -------------------------------------------------------

const FOOTPRINTS: Record<RoomSize, readonly [number, number][]> = {
  small: [[5, 5], [5, 7], [7, 5]],
  medium: [[7, 7], [7, 9], [9, 7]],
  large: [[11, 11], [9, 13], [13, 9]],
};
const CEIL_H: Record<RoomSize, number> = { small: 4, medium: 5, large: 6 };
const CORRIDOR_CEIL = 3;
const CORRIDOR_LENGTHS = [3, 4, 5, 6, 7, 8] as const;
const GRID = 128;
const MAX_ATTEMPTS = 8;
const MAX_TORCHES = 32;

// --- grid helpers ----------------------------------------------------------

interface Grid {
  w: number;
  h: number;
  cells: Uint8Array;
  ceilY: Float32Array;
}

function makeGrid(w: number, h: number): Grid {
  return { w, h, cells: new Uint8Array(w * h), ceilY: new Float32Array(w * h) };
}

function inBounds(g: Grid, x: number, z: number): boolean {
  return x >= 0 && z >= 0 && x < g.w && z < g.h;
}

function isSolid(g: Grid, x: number, z: number): boolean {
  return inBounds(g, x, z) && g.cells[z * g.w + x] === CELL_SOLID;
}

function setCell(g: Grid, x: number, z: number, value: number, ceil: number): void {
  g.cells[z * g.w + x] = value;
  g.ceilY[z * g.w + x] = ceil;
}

/** Every cell of the rect must be in bounds and Solid. */
function rectAllSolid(g: Grid, x: number, z: number, w: number, d: number): boolean {
  for (let j = z; j < z + d; j++) {
    for (let i = x; i < x + w; i++) {
      if (!isSolid(g, i, j)) return false;
    }
  }
  return true;
}

function carveRect(g: Grid, x: number, z: number, w: number, d: number, ceil: number): void {
  for (let j = z; j < z + d; j++) {
    for (let i = x; i < x + w; i++) setCell(g, i, j, CELL_FLOOR, ceil);
  }
}

// --- graph embedding -------------------------------------------------------

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function buildAdjacency(spec: DungeonSpec): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const r of spec.rooms) adj.set(r.id, []);
  for (const [a, b] of spec.edges) {
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }
  return adj;
}

interface Candidate {
  rx: number;
  rz: number;
  /** Corridor cells to carve as floor. */
  cells: [number, number][];
  /** Lateral cells that must stay solid so corridors don't graze rooms. */
  margins: [number, number][];
  /** Corridor endpoint cells marked as doors (subset of `cells`). */
  doors: [number, number][];
}

/** Compute child-room rect + corridor for placing beyond a parent wall. */
function candidate(
  parent: PlacedRoom, dir: number, len: number, w: number, d: number,
): Candidate {
  const cells: [number, number][] = [];
  const margins: [number, number][] = [];
  const doors: [number, number][] = [];
  let rx: number;
  let rz: number;

  if (dir === 1 || dir === 3) {
    // E (+x) or W (-x): corridor runs along x, lateral axis is z.
    const c0 = parent.cz;
    const x0 = dir === 1 ? parent.x + parent.w : parent.x - len;
    rx = dir === 1 ? x0 + len : x0 - w;
    rz = c0 - (d >> 1);
    for (let i = 0; i < len; i++) {
      const x = x0 + i;
      cells.push([x, c0], [x, c0 + 1]);
      margins.push([x, c0 - 1], [x, c0 + 2]);
    }
    const nearX = dir === 1 ? parent.x + parent.w : parent.x - 1;
    const farX = dir === 1 ? rx - 1 : rx + w;
    doors.push([nearX, c0], [nearX, c0 + 1], [farX, c0], [farX, c0 + 1]);
  } else {
    // S (+z) or N (-z): corridor runs along z, lateral axis is x.
    const c0 = parent.cx;
    const z0 = dir === 2 ? parent.z + parent.d : parent.z - len;
    rz = dir === 2 ? z0 + len : z0 - d;
    rx = c0 - (w >> 1);
    for (let i = 0; i < len; i++) {
      const z = z0 + i;
      cells.push([c0, z], [c0 + 1, z]);
      margins.push([c0 - 1, z], [c0 + 2, z]);
    }
    const nearZ = dir === 2 ? parent.z + parent.d : parent.z - 1;
    const farZ = dir === 2 ? rz - 1 : rz + d;
    doors.push([c0, nearZ], [c0 + 1, nearZ], [c0, farZ], [c0 + 1, farZ]);
  }
  return { rx, rz, cells, margins, doors };
}

function makeRoom(spec: RoomSpec, x: number, z: number, w: number, d: number): PlacedRoom {
  return {
    id: spec.id, type: spec.type, x, z, w, d,
    cx: x + (w >> 1), cz: z + (d >> 1), ceil: CEIL_H[spec.size],
  };
}

/** Try to place `child` off one of `parent`'s walls. Carves on success. */
function placeChild(
  g: Grid, rng: () => number, parent: PlacedRoom, child: RoomSpec,
): PlacedRoom | null {
  const dirs = shuffle([0, 1, 2, 3], rng);
  const lens = shuffle(CORRIDOR_LENGTHS, rng);
  const fps = shuffle(FOOTPRINTS[child.size], rng);
  for (const dir of dirs) {
    for (const len of lens) {
      for (const [w, d] of fps) {
        const cand = candidate(parent, dir, len, w, d);
        // Room interior + a 1-cell solid ring must be free.
        if (!rectAllSolid(g, cand.rx - 1, cand.rz - 1, w + 2, d + 2)) continue;
        // Corridor path + lateral margins must be solid (no grazing rooms).
        if (!cand.cells.every(([x, z]) => isSolid(g, x, z))) continue;
        if (!cand.margins.every(([x, z]) => isSolid(g, x, z))) continue;

        carveRect(g, cand.rx, cand.rz, w, d, CEIL_H[child.size]);
        for (const [x, z] of cand.cells) setCell(g, x, z, CELL_FLOOR, CORRIDOR_CEIL);
        for (const [x, z] of cand.doors) setCell(g, x, z, CELL_DOOR, CORRIDOR_CEIL);
        return makeRoom(child, cand.rx, cand.rz, w, d);
      }
    }
  }
  return null;
}

function inRoom(r: PlacedRoom, x: number, z: number): boolean {
  return x >= r.x && x < r.x + r.w && z >= r.z && z < r.z + r.d;
}

/**
 * Best-effort loop corridor for a non-tree edge: two L-shaped variants
 * between room centers, 2 cells wide. Cells inside either room are skipped;
 * every other path cell must still be Solid or the variant is rejected.
 * Dropping the edge is fine — the spanning tree already connects the graph.
 */
function carveLoopCorridor(
  g: Grid, a: PlacedRoom, b: PlacedRoom, rng: () => number,
): boolean {
  const variants = rng() < 0.5 ? [0, 1] : [1, 0];
  for (const variant of variants) {
    const path: [number, number][] = [];
    const pushWide = (x: number, z: number, horizontal: boolean) => {
      path.push([x, z]);
      path.push(horizontal ? [x, z + 1] : [x + 1, z]);
    };
    const sx = Math.sign(b.cx - a.cx) || 1;
    const sz = Math.sign(b.cz - a.cz) || 1;
    if (variant === 0) {
      for (let x = a.cx; x !== b.cx; x += sx) pushWide(x, a.cz, true);
      for (let z = a.cz; z !== b.cz + sz; z += sz) pushWide(b.cx, z, false);
    } else {
      for (let z = a.cz; z !== b.cz; z += sz) pushWide(a.cx, z, false);
      for (let x = a.cx; x !== b.cx + sx; x += sx) pushWide(x, b.cz, true);
    }
    // De-dupe, drop cells inside either room.
    const seen = new Set<number>();
    const outside: [number, number][] = [];
    for (const [x, z] of path) {
      const key = z * g.w + x;
      if (seen.has(key)) continue;
      seen.add(key);
      if (inRoom(a, x, z) || inRoom(b, x, z)) continue;
      outside.push([x, z]);
    }
    if (outside.length === 0) return true; // rooms already adjacent
    if (!outside.every(([x, z]) => isSolid(g, x, z))) continue;

    for (const [x, z] of outside) setCell(g, x, z, CELL_FLOOR, CORRIDOR_CEIL);
    // Mark cells touching a room interior as doors.
    for (const [x, z] of outside) {
      const touchesRoom =
        inRoom(a, x + 1, z) || inRoom(a, x - 1, z) || inRoom(a, x, z + 1) || inRoom(a, x, z - 1) ||
        inRoom(b, x + 1, z) || inRoom(b, x - 1, z) || inRoom(b, x, z + 1) || inRoom(b, x, z - 1);
      if (touchesRoom) setCell(g, x, z, CELL_DOOR, CORRIDOR_CEIL);
    }
    return true;
  }
  return false;
}

function tryLayout(spec: DungeonSpec, rng: () => number): DungeonLayout | null {
  const g = makeGrid(GRID, GRID);
  const adj = buildAdjacency(spec);
  const byId = new Map(spec.rooms.map((r) => [r.id, r]));
  const entrance = spec.rooms.find((r) => r.type === 'entrance')!;

  const fps = shuffle(FOOTPRINTS[entrance.size], rng);
  const [w0, d0] = fps[0];
  const ex = (GRID >> 1) - (w0 >> 1);
  const ez = (GRID >> 1) - (d0 >> 1);
  carveRect(g, ex, ez, w0, d0, CEIL_H[entrance.size]);
  const placed = new Map<string, PlacedRoom>();
  const rooms: PlacedRoom[] = [makeRoom(entrance, ex, ez, w0, d0)];
  placed.set(entrance.id, rooms[0]);

  // BFS spanning tree (visits every room — spec is validated connected).
  const treeEdges = new Set<string>();
  const visited = new Set<string>([entrance.id]);
  const queue = [entrance.id];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const nb of adj.get(cur)!) {
      if (visited.has(nb)) continue;
      visited.add(nb);
      treeEdges.add(edgeKey(cur, nb));
      const child = placeChild(g, rng, placed.get(cur)!, byId.get(nb)!);
      if (child === null) return null;
      placed.set(nb, child);
      rooms.push(child);
      queue.push(nb);
    }
  }

  // Loop edges (best effort, deterministic drop when blocked).
  for (const [a, b] of spec.edges) {
    if (treeEdges.has(edgeKey(a, b))) continue;
    carveLoopCorridor(g, placed.get(a)!, placed.get(b)!, rng);
  }

  return {
    w: g.w, h: g.h, cells: g.cells, ceilY: g.ceilY, rooms,
    spawnCell: [0, 0], exitPortalCell: [0, 0], exitWallDir: 0,
    chests: [], torches: [], fallback: false,
  };
}

// --- fallback: straight chain (always fits) --------------------------------

/**
 * Deterministic fallback: rooms in a straight west→east chain, entrance
 * first, connected by fixed 4-cell corridors. Ignores the edge list (the
 * chain is trivially connected). Exported for direct testing.
 */
export function serpentineLayout(spec: DungeonSpec): DungeonLayout {
  const entrance = spec.rooms.find((r) => r.type === 'entrance')!;
  const ordered = [entrance, ...spec.rooms.filter((r) => r !== entrance)];
  const g = makeGrid(224, 40);
  const midZ = 20;
  const rooms: PlacedRoom[] = [];
  let x = 4;
  for (const rs of ordered) {
    const [w, d] = FOOTPRINTS[rs.size][0];
    if (rooms.length > 0) {
      for (let i = 0; i < 4; i++) {
        const isEnd = i === 0 || i === 3;
        const cellType = isEnd ? CELL_DOOR : CELL_FLOOR;
        setCell(g, x + i, midZ, cellType, CORRIDOR_CEIL);
        setCell(g, x + i, midZ + 1, cellType, CORRIDOR_CEIL);
      }
      x += 4;
    }
    const rz = midZ - (d >> 1);
    carveRect(g, x, rz, w, d, CEIL_H[rs.size]);
    rooms.push(makeRoom(rs, x, rz, w, d));
    x += w;
  }
  return {
    w: g.w, h: g.h, cells: g.cells, ceilY: g.ceilY, rooms,
    spawnCell: [0, 0], exitPortalCell: [0, 0], exitWallDir: 0,
    chests: [], torches: [], fallback: true,
  };
}

// --- decoration (spawn, exit portal, chests, torches) ----------------------

/** Interior perimeter cells of a room, clockwise from the NW corner. */
function perimeterCells(r: PlacedRoom): [number, number][] {
  const cells: [number, number][] = [];
  for (let x = r.x; x < r.x + r.w; x++) cells.push([x, r.z]);
  for (let z = r.z + 1; z < r.z + r.d; z++) cells.push([r.x + r.w - 1, z]);
  if (r.d > 1) for (let x = r.x + r.w - 2; x >= r.x; x--) cells.push([x, r.z + r.d - 1]);
  if (r.w > 1) for (let z = r.z + r.d - 2; z >= r.z + 1; z--) cells.push([r.x, z]);
  return cells;
}

/** First wall direction (0 N, 1 E, 2 S, 3 W) with a solid neighbor, or -1. */
function wallDirOf(g: Grid, x: number, z: number): number {
  if (isSolid(g, x, z - 1) || !inBounds(g, x, z - 1)) return 0;
  if (isSolid(g, x + 1, z) || !inBounds(g, x + 1, z)) return 1;
  if (isSolid(g, x, z + 1) || !inBounds(g, x, z + 1)) return 2;
  if (isSolid(g, x - 1, z) || !inBounds(g, x - 1, z)) return 3;
  return -1;
}

function nearDoor(g: Grid, x: number, z: number, radius: number): boolean {
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx;
      const zz = z + dz;
      if (inBounds(g, xx, zz) && g.cells[zz * g.w + xx] === CELL_DOOR) return true;
    }
  }
  return false;
}

function decorate(layout: DungeonLayout, spec: DungeonSpec, rng: () => number): void {
  const g: Grid = layout;
  const entrance = layout.rooms[0];
  layout.spawnCell = [entrance.cx, entrance.cz];

  // Exit portal: a wall-hugging entrance-room cell away from doors.
  const perim = perimeterCells(entrance);
  const walled = perim.filter(([x, z]) => wallDirOf(g, x, z) >= 0);
  const quiet = walled.filter(([x, z]) => !nearDoor(g, x, z, 2));
  const pool = quiet.length > 0 ? quiet : walled;
  const portal = pool[Math.floor(rng() * pool.length)];
  layout.exitPortalCell = [portal[0], portal[1]];
  layout.exitWallDir = wallDirOf(g, portal[0], portal[1]);

  // Chests: room corners away from doors; loot split across a room's chests.
  const byId = new Map(spec.rooms.map((r) => [r.id, r]));
  for (const room of layout.rooms) {
    const rs = byId.get(room.id)!;
    const loot = rs.loot ?? [];
    let count = 0;
    if (room.type === 'treasure') count = loot.length > 2 ? 2 : 1;
    else if (room.type === 'boss') count = 1;
    else if (room.type === 'combat') count = rng() < 0.4 ? 1 : 0;
    if (count === 0) continue;

    const corners: [number, number][] = [
      [room.x, room.z],
      [room.x + room.w - 1, room.z],
      [room.x + room.w - 1, room.z + room.d - 1],
      [room.x, room.z + room.d - 1],
    ];
    const free = corners.filter(([x, z]) =>
      !nearDoor(g, x, z, 2) &&
      !(x === layout.exitPortalCell[0] && z === layout.exitPortalCell[1]));
    const chosen = shuffle(free, rng).slice(0, count);
    chosen.forEach((cell, i) => {
      const items = loot.filter((_, j) => j % chosen.length === i);
      layout.chests.push({
        cell: [cell[0], cell[1]],
        items: items.length > 0 ? items : ['gold_small' as ItemId],
      });
    });
  }

  // Torches: every ~4th perimeter cell that hugs a wall, capped globally.
  for (const room of layout.rooms) {
    if (layout.torches.length >= MAX_TORCHES) break;
    const cells = perimeterCells(room);
    const start = Math.floor(rng() * 4);
    for (let i = start; i < cells.length; i += 4) {
      if (layout.torches.length >= MAX_TORCHES) break;
      const [x, z] = cells[i];
      const wd = wallDirOf(g, x, z);
      if (wd < 0) continue;
      if (x === layout.exitPortalCell[0] && z === layout.exitPortalCell[1]) continue;
      if (layout.chests.some((c) => c.cell[0] === x && c.cell[1] === z)) continue;
      layout.torches.push({ cell: [x, z], wallDir: wd });
    }
  }
}

// --- entry point -----------------------------------------------------------

/**
 * Lay out a validated spec. Deterministic: same (spec, seed) ⇒ identical
 * layout, including all decoration. Precondition: spec passed validateSpec().
 */
export function layoutDungeon(spec: DungeonSpec, seed: number): DungeonLayout {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const rng = mulberry32(mix32(seed, attempt, 0x9e3779b9));
    const layout = tryLayout(spec, rng);
    if (layout !== null) {
      decorate(layout, spec, rng);
      return layout;
    }
  }
  console.warn(`[dungeon] graph embedding failed for "${spec.name}" — using chain fallback`);
  const layout = serpentineLayout(spec);
  decorate(layout, spec, mulberry32(mix32(seed, 0xfa11bacc)));
  return layout;
}
