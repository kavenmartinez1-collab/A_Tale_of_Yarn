/**
 * Procedurally generated building interior layout -- pure deterministic module
 * mirroring the dungeon-layout approach. A function of (spec, seed) only; no
 * DOM, no GPU imports.
 *
 * Interior lives in local coordinates centered at (width/2, 0, depth/2) so
 * the origin is floor-corner (0,0,0); integration places it at a far-away
 * world offset like dungeons do (y=-300, arena grid by building index).
 *
 * Design: single-room interiors for house/shop/tavern, multi-room for keep.
 * Floor rect, perimeter walls with one door opening, furniture appropriate to
 * kind, light sources, entry spawn point, exit trigger zone at the door.
 */

import { mulberry32 } from '../mesh-utils';

// ---- types ----------------------------------------------------------------

export type BuildingKind = 'house' | 'shop' | 'tavern' | 'keep';

export interface BuildingInteriorSpec {
  /** Name of the parent settlement (for identification). */
  settlementName: string;
  /** Index of the building in the settlement's pad array. */
  buildingIndex: number;
  /** What kind of interior to generate. */
  kind: BuildingKind;
  /** Interior width in meters (x-axis). Derived from building footprint. */
  width: number;
  /** Interior depth in meters (z-axis). Derived from building footprint. */
  depth: number;
}

/** Axis-aligned bounding box in local space. */
export interface AABB {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

export type FurnitureType =
  | 'bed' | 'table' | 'chair' | 'hearth' | 'counter'
  | 'shelf' | 'barrel' | 'throne' | 'banner' | 'brazier'
  | 'candle' | 'crate' | 'stool' | 'rug';

export interface Furniture {
  type: FurnitureType;
  /** AABB of the furniture piece (local coords). */
  aabb: AABB;
}

/** What kind of emitter a light is — drives its prop mesh (flame vs sconce). */
export type LightKind = 'torch' | 'candle' | 'hearth' | 'brazier';

export interface LightSource {
  /** Position of the light (local coords, center of emitter). */
  x: number; y: number; z: number;
  /** Color (linear RGB, 0..1). */
  color: [number, number, number];
  /** Falloff radius (m). */
  radius: number;
  /** Emitter kind (mesh selection: hearth fire, candle tip, wall sconce...). */
  kind: LightKind;
}

export interface BuildingInterior {
  spec: BuildingInteriorSpec;
  /** Ceiling height (m). */
  ceilHeight: number;
  /** Cell grid dimensions (1 m cells). */
  gridW: number;
  gridD: number;
  /** Row-major cell occupancy: 0=solid, 1=floor, 2=door. */
  cells: Uint8Array;
  /** Per-cell ceiling (like dungeon ceilY). 0 for solid cells. */
  ceilY: Float32Array;
  /** Door opening cells (subset where cells[i]==2). */
  doorCells: [number, number][];
  /** Spawn point just inside the door (local coords). */
  spawnPoint: [number, number, number];
  /** Exit trigger zone (AABB at the door; player overlap = leave). */
  exitZone: AABB;
  /** Placed furniture items. */
  furniture: Furniture[];
  /** Collider AABBs (walls + furniture). */
  colliders: AABB[];
  /** Light sources (hearth, candles, braziers). */
  lights: LightSource[];
  /** Rooms (keep can have multiple). */
  rooms: { x: number; z: number; w: number; d: number; label: string }[];
}

// ---- constants ------------------------------------------------------------

const CELL_SOLID = 0;
const CELL_FLOOR = 1;
const CELL_DOOR = 2;

const WALL_THICKNESS = 0.15;

// ---- deterministic PRNG (same as mesh-utils / dungeon-layout) -------------

function mix32(a: number, b: number, c = 0): number {
  let h = a >>> 0;
  h = Math.imul(h ^ (b >>> 0), 0x9e3779b1);
  h = ((h << 13) | (h >>> 19)) >>> 0;
  h = Math.imul(h ^ (c >>> 0), 0x85ebca6b);
  h = ((h << 13) | (h >>> 19)) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

// ---- helpers --------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Pick which wall side gets the door: 0=N(-z), 1=E(+x), 2=S(+z), 3=W(-x). */
function pickDoorWall(rng: () => number): number {
  // Prefer the south wall (z=depth-1 side, index 2) since settlement buildings
  // face their door side toward the center. Fall back to random.
  return rng() < 0.6 ? 2 : Math.floor(rng() * 4);
}

// ---- grid operations ------------------------------------------------------

interface Grid {
  w: number; d: number;
  cells: Uint8Array;
  ceilY: Float32Array;
}

function makeGrid(w: number, d: number): Grid {
  return { w, d, cells: new Uint8Array(w * d), ceilY: new Float32Array(w * d) };
}

function carveRect(g: Grid, x0: number, z0: number, w: number, d: number, ceil: number): void {
  for (let z = z0; z < z0 + d; z++) {
    for (let x = x0; x < x0 + w; x++) {
      const idx = z * g.w + x;
      g.cells[idx] = CELL_FLOOR;
      g.ceilY[idx] = ceil;
    }
  }
}

function setDoor(g: Grid, x: number, z: number, ceil: number): void {
  const idx = z * g.w + x;
  g.cells[idx] = CELL_DOOR;
  g.ceilY[idx] = ceil;
}

// ---- door placement -------------------------------------------------------

interface DoorInfo {
  cells: [number, number][];
  /** Inward normal direction (into the room). */
  inDir: number;
  /** Spawn point (local coords, just inside). */
  spawn: [number, number, number];
  /** Exit trigger zone AABB. */
  exitZone: AABB;
}

function placeDoor(
  g: Grid, roomX: number, roomZ: number, roomW: number, roomD: number,
  wall: number, ceil: number,
): DoorInfo {
  const cells: [number, number][] = [];
  let spawn: [number, number, number];
  let exitZone: AABB;

  // Door is 2 cells wide (or 1 if room is narrow) in the middle of the wall.
  const doorWidth = Math.min(2, Math.min(roomW, roomD));

  if (wall === 0) {
    // North wall: z = roomZ (exterior is z-1)
    const midX = roomX + Math.floor(roomW / 2);
    for (let dx = 0; dx < doorWidth; dx++) {
      const x = midX - Math.floor(doorWidth / 2) + dx;
      setDoor(g, x, roomZ, ceil);
      cells.push([x, roomZ]);
    }
    spawn = [midX + 0.5, 0, roomZ + 1.2];
    exitZone = { minX: midX - 0.5, minY: 0, minZ: roomZ - 0.1, maxX: midX + doorWidth - 0.5, maxY: 2.2, maxZ: roomZ + 0.9 };
  } else if (wall === 1) {
    // East wall: x = roomX + roomW - 1 (exterior is x+1)
    const midZ = roomZ + Math.floor(roomD / 2);
    for (let dz = 0; dz < doorWidth; dz++) {
      const z = midZ - Math.floor(doorWidth / 2) + dz;
      setDoor(g, roomX + roomW - 1, z, ceil);
      cells.push([roomX + roomW - 1, z]);
    }
    spawn = [roomX + roomW - 2.2, 0, midZ + 0.5];
    exitZone = { minX: roomX + roomW - 1.1, minY: 0, minZ: midZ - 0.5, maxX: roomX + roomW - 0.1, maxY: 2.2, maxZ: midZ + doorWidth - 0.5 };
  } else if (wall === 2) {
    // South wall: z = roomZ + roomD - 1 (exterior is z+1)
    const midX = roomX + Math.floor(roomW / 2);
    for (let dx = 0; dx < doorWidth; dx++) {
      const x = midX - Math.floor(doorWidth / 2) + dx;
      setDoor(g, x, roomZ + roomD - 1, ceil);
      cells.push([x, roomZ + roomD - 1]);
    }
    spawn = [midX + 0.5, 0, roomZ + roomD - 2.2];
    exitZone = { minX: midX - 0.5, minY: 0, minZ: roomZ + roomD - 1.1, maxX: midX + doorWidth - 0.5, maxY: 2.2, maxZ: roomZ + roomD - 0.1 };
  } else {
    // West wall: x = roomX (exterior is x-1)
    const midZ = roomZ + Math.floor(roomD / 2);
    for (let dz = 0; dz < doorWidth; dz++) {
      const z = midZ - Math.floor(doorWidth / 2) + dz;
      setDoor(g, roomX, z, ceil);
      cells.push([roomX, z]);
    }
    spawn = [roomX + 1.2, 0, midZ + 0.5];
    exitZone = { minX: roomX + 0.1, minY: 0, minZ: midZ - 0.5, maxX: roomX + 1.1, maxY: 2.2, maxZ: midZ + doorWidth - 0.5 };
  }
  return { cells, inDir: (wall + 2) % 4, spawn, exitZone };
}

// ---- furniture placement --------------------------------------------------

function aabbContainedInRoom(
  aabb: AABB, roomX: number, roomZ: number, roomW: number, roomD: number, _ceil: number,
): boolean {
  return aabb.minX >= roomX && aabb.maxX <= roomX + roomW &&
         aabb.minZ >= roomZ && aabb.maxZ <= roomZ + roomD &&
         aabb.minY >= 0 && aabb.maxY <= _ceil;
}

function aabbOverlaps(a: AABB, b: AABB): boolean {
  return a.minX < b.maxX && a.maxX > b.minX &&
         a.minY < b.maxY && a.maxY > b.minY &&
         a.minZ < b.maxZ && a.maxZ > b.minZ;
}

function tryPlaceFurniture(
  type: FurnitureType,
  x: number, z: number, hw: number, hd: number, height: number,
  roomX: number, roomZ: number, roomW: number, roomD: number, ceil: number,
  existing: Furniture[], doorCells: [number, number][],
  spawnPoint?: [number, number, number],
): Furniture | null {
  const aabb: AABB = {
    minX: x - hw, minY: 0, minZ: z - hd,
    maxX: x + hw, maxY: height, maxZ: z + hd,
  };
  // Must fit inside room
  if (!aabbContainedInRoom(aabb, roomX, roomZ, roomW, roomD, ceil)) return null;
  // Must not overlap existing furniture
  for (const f of existing) {
    if (aabbOverlaps(aabb, f.aabb)) return null;
  }
  // Must not block door cells (with a margin)
  for (const [dx, dz] of doorCells) {
    const doorAABB: AABB = {
      minX: dx - 0.3, minY: 0, minZ: dz - 0.3,
      maxX: dx + 1.3, maxY: 2.2, maxZ: dz + 1.3,
    };
    if (aabbOverlaps(aabb, doorAABB)) return null;
  }
  // Must not overlap player spawn area (capsule radius 0.35 + margin)
  if (spawnPoint) {
    const [sx, , sz] = spawnPoint;
    const margin = 0.5;
    const spawnAABB: AABB = {
      minX: sx - margin, minY: 0, minZ: sz - margin,
      maxX: sx + margin, maxY: 2.0, maxZ: sz + margin,
    };
    if (aabbOverlaps(aabb, spawnAABB)) return null;
  }
  return { type, aabb };
}

// ---- per-kind furnishing --------------------------------------------------

function furnishHouse(
  rng: () => number,
  roomX: number, roomZ: number, roomW: number, roomD: number, ceil: number,
  doorCells: [number, number][], spawnPoint: [number, number, number],
): { furniture: Furniture[]; lights: LightSource[] } {
  const furniture: Furniture[] = [];
  const lights: LightSource[] = [];

  // Hearth: against the wall opposite the door, centered
  const hearthX = roomX + roomW / 2;
  const hearthZ = roomZ + 0.6;
  const hearth = tryPlaceFurniture('hearth', hearthX, hearthZ, 0.6, 0.5, 0.8,
    roomX, roomZ, roomW, roomD, ceil, furniture, doorCells, spawnPoint);
  if (hearth) {
    furniture.push(hearth);
    lights.push({ x: hearthX, y: 0.6, z: hearthZ, color: [1.0, 0.6, 0.25], radius: 7, kind: 'hearth' });
  }

  // Bed: along a side wall. Try several deterministic fallback spots so even
  // the smallest houses keep their bed (a single attempt used to lose it to
  // the door-margin rejection in 4x4 rooms).
  const bedSide = rng() < 0.5 ? roomX + 0.6 : roomX + roomW - 0.6;
  const bedZ = roomZ + roomD / 2 + (rng() - 0.5) * (roomD * 0.3);
  const otherSide = bedSide < roomX + roomW / 2 ? roomX + roomW - 0.6 : roomX + 0.6;
  let bed: Furniture | null = null;
  const bedSpots: [number, number][] = [
    [bedSide, bedZ],
    [otherSide, bedZ],
    [bedSide, roomZ + 1.05],
    [otherSide, roomZ + 1.05],
    [bedSide, roomZ + roomD - 1.05],
    [otherSide, roomZ + roomD - 1.05],
  ];
  for (const [bx, bz] of bedSpots) {
    bed = tryPlaceFurniture('bed', bx, bz, 0.5, 1.0, 0.55,
      roomX, roomZ, roomW, roomD, ceil, furniture, doorCells, spawnPoint);
    if (bed) break;
  }
  if (bed) furniture.push(bed);

  // Bedside rug: a warm patch of fabric next to the bed (toward room center)
  if (bed) {
    const bedCx = (bed.aabb.minX + bed.aabb.maxX) / 2;
    const rugX = bedCx < roomX + roomW / 2
      ? bed.aabb.maxX + 0.55 : bed.aabb.minX - 0.55;
    const rug = tryPlaceFurniture('rug',
      rugX, (bed.aabb.minZ + bed.aabb.maxZ) / 2, 0.45, 0.7, 0.03,
      roomX, roomZ, roomW, roomD, ceil, furniture, doorCells, spawnPoint);
    if (rug) furniture.push(rug);
  }

  // Table: center-ish
  const tableX = roomX + roomW / 2 + (rng() - 0.5) * 1.0;
  const tableZ = roomZ + roomD / 2 + (rng() - 0.5) * 1.0;
  const table = tryPlaceFurniture('table', tableX, tableZ, 0.5, 0.4, 0.75,
    roomX, roomZ, roomW, roomD, ceil, furniture, doorCells, spawnPoint);
  if (table) furniture.push(table);

  // Chairs around table
  if (table) {
    const chairOffsets: [number, number][] = [[0.7, 0], [-0.7, 0], [0, 0.6], [0, -0.6]];
    const count = 1 + Math.floor(rng() * 3);
    const offsets = shuffle(chairOffsets, rng).slice(0, count);
    for (const [ox, oz] of offsets) {
      const chair = tryPlaceFurniture('chair', tableX + ox, tableZ + oz, 0.22, 0.22, 0.9,
        roomX, roomZ, roomW, roomD, ceil, furniture, doorCells, spawnPoint);
      if (chair) furniture.push(chair);
    }
  }

  // Candle on table
  if (table) {
    lights.push({
      x: table.aabb.minX + (table.aabb.maxX - table.aabb.minX) / 2,
      y: 0.85,
      z: table.aabb.minZ + (table.aabb.maxZ - table.aabb.minZ) / 2,
      color: [1.0, 0.85, 0.5], radius: 4, kind: 'candle',
    });
  }

  return { furniture, lights };
}

function furnishShop(
  rng: () => number,
  roomX: number, roomZ: number, roomW: number, roomD: number, ceil: number,
  doorCells: [number, number][], spawnPoint: [number, number, number],
): { furniture: Furniture[]; lights: LightSource[] } {
  const furniture: Furniture[] = [];
  const lights: LightSource[] = [];

  // Counter across the middle
  const counterZ = roomZ + roomD * 0.45;
  const counterW = roomW * 0.6;
  const counter = tryPlaceFurniture('counter', roomX + roomW / 2, counterZ, counterW / 2, 0.35, 1.0,
    roomX, roomZ, roomW, roomD, ceil, furniture, doorCells, spawnPoint);
  if (counter) furniture.push(counter);

  // Shelves along back wall
  const shelfCount = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < shelfCount; i++) {
    const sx = roomX + 1.0 + i * (roomW - 2) / Math.max(1, shelfCount);
    const shelf = tryPlaceFurniture('shelf', sx, roomZ + 0.5, 0.4, 0.35, 1.8,
      roomX, roomZ, roomW, roomD, ceil, furniture, doorCells, spawnPoint);
    if (shelf) furniture.push(shelf);
  }

  // Barrels in corners
  const barrelCorners: [number, number][] = [
    [roomX + 0.5, roomZ + 0.5],
    [roomX + roomW - 0.5, roomZ + 0.5],
    [roomX + 0.5, roomZ + roomD - 0.5],
    [roomX + roomW - 0.5, roomZ + roomD - 0.5],
  ];
  const barrelCount = 1 + Math.floor(rng() * 3);
  const barrelPositions = shuffle(barrelCorners, rng).slice(0, barrelCount);
  for (const [bx, bz] of barrelPositions) {
    const barrel = tryPlaceFurniture('barrel', bx, bz, 0.3, 0.3, 0.9,
      roomX, roomZ, roomW, roomD, ceil, furniture, doorCells, spawnPoint);
    if (barrel) furniture.push(barrel);
  }

  // Candle on counter
  if (counter) {
    lights.push({
      x: counter.aabb.minX + (counter.aabb.maxX - counter.aabb.minX) / 2,
      y: 1.1,
      z: counterZ,
      color: [1.0, 0.85, 0.5], radius: 4, kind: 'candle',
    });
  }

  // Wall torch
  lights.push({
    x: roomX + roomW / 2,
    y: 1.7,
    z: roomZ + 0.2,
    color: [1.0, 0.72, 0.4], radius: 6, kind: 'torch',
  });

  return { furniture, lights };
}

function furnishTavern(
  rng: () => number,
  roomX: number, roomZ: number, roomW: number, roomD: number, ceil: number,
  doorCells: [number, number][], spawnPoint: [number, number, number],
): { furniture: Furniture[]; lights: LightSource[] } {
  const furniture: Furniture[] = [];
  const lights: LightSource[] = [];

  // Bar counter along one side
  const barSide = rng() < 0.5;
  const barX = barSide ? roomX + 0.6 : roomX + roomW - 0.6;
  const barZ = roomZ + roomD * 0.4;
  const bar = tryPlaceFurniture('counter', barX, barZ, 0.4, roomD * 0.3, 1.0,
    roomX, roomZ, roomW, roomD, ceil, furniture, doorCells, spawnPoint);
  if (bar) furniture.push(bar);

  // Tables scattered in the open area
  const tableCount = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < tableCount; i++) {
    const tx = roomX + 1.5 + rng() * (roomW - 3);
    const tz = roomZ + 1.5 + rng() * (roomD - 3);
    const table = tryPlaceFurniture('table', tx, tz, 0.45, 0.45, 0.75,
      roomX, roomZ, roomW, roomD, ceil, furniture, doorCells, spawnPoint);
    if (table) {
      furniture.push(table);
      // Stools around each table
      const stoolCount = 2 + Math.floor(rng() * 2);
      const angles = shuffle([0, 1, 2, 3], rng).slice(0, stoolCount);
      for (const a of angles) {
        const ox = Math.cos(a * Math.PI / 2) * 0.7;
        const oz = Math.sin(a * Math.PI / 2) * 0.7;
        const stool = tryPlaceFurniture('stool', tx + ox, tz + oz, 0.18, 0.18, 0.5,
          roomX, roomZ, roomW, roomD, ceil, furniture, doorCells, spawnPoint);
        if (stool) furniture.push(stool);
      }
    }
  }

  // Barrels behind the bar
  const barrelCount = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < barrelCount; i++) {
    const bx = barSide ? roomX + 0.5 : roomX + roomW - 0.5;
    const bz = roomZ + 0.6 + i * 0.8;
    const barrel = tryPlaceFurniture('barrel', bx, bz, 0.28, 0.28, 0.9,
      roomX, roomZ, roomW, roomD, ceil, furniture, doorCells, spawnPoint);
    if (barrel) furniture.push(barrel);
  }

  // Hearth/fireplace
  const hearthX = roomX + roomW / 2;
  const hearthZ = roomZ + 0.6;
  const hearth = tryPlaceFurniture('hearth', hearthX, hearthZ, 0.55, 0.45, 0.8,
    roomX, roomZ, roomW, roomD, ceil, furniture, doorCells, spawnPoint);
  if (hearth) {
    furniture.push(hearth);
    lights.push({ x: hearthX, y: 0.6, z: hearthZ, color: [1.0, 0.6, 0.25], radius: 7, kind: 'hearth' });
  }

  // Candles on bar
  if (bar) {
    lights.push({
      x: barX, y: 1.1, z: barZ,
      color: [1.0, 0.85, 0.5], radius: 4, kind: 'candle',
    });
  }

  // Wall torch
  lights.push({
    x: roomX + roomW / 2,
    y: 1.7,
    z: roomZ + roomD - 0.2,
    color: [1.0, 0.72, 0.4], radius: 6, kind: 'torch',
  });

  return { furniture, lights };
}

function furnishKeep(
  rng: () => number,
  rooms: { x: number; z: number; w: number; d: number; label: string }[],
  ceil: number,
  doorCells: [number, number][], spawnPoint: [number, number, number],
): { furniture: Furniture[]; lights: LightSource[] } {
  const furniture: Furniture[] = [];
  const lights: LightSource[] = [];

  for (const room of rooms) {
    const { x: rx, z: rz, w: rw, d: rd, label } = room;

    if (label === 'throne') {
      // Throne centered at the back
      const throneX = rx + rw / 2;
      const throneZ = rz + 1.0;
      const throne = tryPlaceFurniture('throne', throneX, throneZ, 0.5, 0.5, 1.8,
        rx, rz, rw, rd, ceil, furniture, doorCells, spawnPoint);
      if (throne) furniture.push(throne);

      // Banners flanking the throne
      const bannerOffsets = [-1.5, 1.5];
      for (const ox of bannerOffsets) {
        const banner = tryPlaceFurniture('banner', throneX + ox, rz + 0.3, 0.15, 0.1, 2.5,
          rx, rz, rw, rd, ceil, furniture, doorCells, spawnPoint);
        if (banner) furniture.push(banner);
      }

      // Braziers flanking the approach
      const brazierZ = rz + rd * 0.6;
      for (const ox of [-1.8, 1.8]) {
        const brazier = tryPlaceFurniture('brazier', throneX + ox, brazierZ, 0.3, 0.3, 1.0,
          rx, rz, rw, rd, ceil, furniture, doorCells, spawnPoint);
        if (brazier) {
          furniture.push(brazier);
          lights.push({
            x: throneX + ox, y: 1.1, z: brazierZ,
            color: [1.0, 0.6, 0.25], radius: 5, kind: 'brazier',
          });
        }
      }

      // Rug down the center
      const rug = tryPlaceFurniture('rug', throneX, rz + rd / 2, 1.0, rd * 0.35, 0.02,
        rx, rz, rw, rd, ceil, furniture, doorCells, spawnPoint);
      if (rug) furniture.push(rug);
    } else if (label === 'hall') {
      // Long table
      const tableX = rx + rw / 2;
      const tableZ = rz + rd / 2;
      const table = tryPlaceFurniture('table', tableX, tableZ, rw * 0.3, 0.5, 0.75,
        rx, rz, rw, rd, ceil, furniture, doorCells, spawnPoint);
      if (table) furniture.push(table);

      // Chairs along the table
      for (let i = 0; i < 3; i++) {
        const cx = rx + 1.0 + i * (rw - 2) / 3;
        for (const oz of [-0.7, 0.7]) {
          const chair = tryPlaceFurniture('chair', cx, tableZ + oz, 0.2, 0.2, 0.9,
            rx, rz, rw, rd, ceil, furniture, doorCells, spawnPoint);
          if (chair) furniture.push(chair);
        }
      }

      // Braziers at corners
      const corners: [number, number][] = [
        [rx + 0.7, rz + 0.7], [rx + rw - 0.7, rz + 0.7],
      ];
      for (const [bx, bz] of corners) {
        const brazier = tryPlaceFurniture('brazier', bx, bz, 0.3, 0.3, 1.0,
          rx, rz, rw, rd, ceil, furniture, doorCells, spawnPoint);
        if (brazier) {
          furniture.push(brazier);
          lights.push({ x: bx, y: 1.1, z: bz, color: [1.0, 0.6, 0.25], radius: 5, kind: 'brazier' });
        }
      }
    } else {
      // Antechamber / guard room: crates, barrels
      const crateCount = 1 + Math.floor(rng() * 2);
      for (let i = 0; i < crateCount; i++) {
        const cx = rx + 0.6 + rng() * (rw - 1.2);
        const cz = rz + 0.6 + rng() * (rd - 1.2);
        const crate = tryPlaceFurniture('crate', cx, cz, 0.35, 0.35, 0.6,
          rx, rz, rw, rd, ceil, furniture, doorCells, spawnPoint);
        if (crate) furniture.push(crate);
      }
      // Wall torch
      lights.push({
        x: rx + rw / 2, y: 1.7, z: rz + 0.2,
        color: [1.0, 0.72, 0.4], radius: 5, kind: 'torch',
      });
    }
  }

  return { furniture, lights };
}

// ---- main entry point -----------------------------------------------------

/**
 * Generate a deterministic building interior layout.
 * Same (spec, seed) always produces an identical result.
 */
export function generateBuildingInterior(
  spec: BuildingInteriorSpec,
  seed: number,
): BuildingInterior {
  const rng = mulberry32(mix32(seed, spec.buildingIndex, 0xb17d1a9));

  // Clamp interior to reasonable bounds (min 4x4, max 16x16).
  const intW = clamp(Math.floor(spec.width), 4, 16);
  const intD = clamp(Math.floor(spec.depth), 4, 16);

  // Ceiling height depends on kind.
  const ceil = spec.kind === 'keep' ? 5 : spec.kind === 'tavern' ? 4 : 3;

  // Grid: room interior starts at (1,1), surrounded by 1-cell solid border.
  const gridW = intW + 2;
  const gridD = intD + 2;
  const g = makeGrid(gridW, gridD);

  // Multi-room for keep; single room for others.
  const rooms: { x: number; z: number; w: number; d: number; label: string }[] = [];

  if (spec.kind === 'keep' && intW >= 8 && intD >= 8) {
    // Keep: split into throne room (back) + hall (front), with optional side room.
    const throneD = Math.max(3, Math.floor(intD * 0.45));
    const hallD = intD - throneD;

    // Throne room (back = low z in grid, cells at row 1)
    carveRect(g, 1, 1, intW, throneD, ceil);
    rooms.push({ x: 1, z: 1, w: intW, d: throneD, label: 'throne' });

    // Hall (front)
    carveRect(g, 1, 1 + throneD, intW, hallD, ceil);
    rooms.push({ x: 1, z: 1 + throneD, w: intW, d: hallD, label: 'hall' });

    // If wide enough, carve a side room off the hall
    if (intW >= 10) {
      const sideW = Math.floor(intW * 0.3);
      const sideD = Math.max(2, hallD - 2);
      const sideX = rng() < 0.5 ? 1 : 1 + intW - sideW;
      const sideZ = 1 + throneD + 1;
      // Only carve if it fits (it always will for reasonable sizes)
      if (sideX + sideW <= gridW - 1 && sideZ + sideD <= gridD - 1) {
        rooms.push({ x: sideX, z: sideZ, w: sideW, d: sideD, label: 'guard' });
        // Room already part of the carved hall area, just label it differently
      }
    }
  } else {
    // Single room interior
    carveRect(g, 1, 1, intW, intD, ceil);
    rooms.push({ x: 1, z: 1, w: intW, d: intD, label: spec.kind });
  }

  // Place door on the chosen wall of the main (last for keep = hall) room.
  const mainRoom = rooms[rooms.length - 1];
  const doorWall = pickDoorWall(rng);
  const door = placeDoor(g, mainRoom.x, mainRoom.z, mainRoom.w, mainRoom.d, doorWall, ceil);

  // Furnish based on kind.
  let furnitureResult: { furniture: Furniture[]; lights: LightSource[] };
  if (spec.kind === 'house') {
    furnitureResult = furnishHouse(rng, mainRoom.x, mainRoom.z, mainRoom.w, mainRoom.d, ceil, door.cells, door.spawn);
  } else if (spec.kind === 'shop') {
    furnitureResult = furnishShop(rng, mainRoom.x, mainRoom.z, mainRoom.w, mainRoom.d, ceil, door.cells, door.spawn);
  } else if (spec.kind === 'tavern') {
    furnitureResult = furnishTavern(rng, mainRoom.x, mainRoom.z, mainRoom.w, mainRoom.d, ceil, door.cells, door.spawn);
  } else {
    furnitureResult = furnishKeep(rng, rooms, ceil, door.cells, door.spawn);
  }

  // Build collider AABBs: perimeter walls (excluding door) + furniture.
  const colliders: AABB[] = [];

  // North wall (z=0 row)
  for (let x = 0; x < gridW; x++) {
    if (g.cells[0 * gridW + x] === CELL_SOLID) {
      colliders.push({ minX: x, minY: 0, minZ: 0, maxX: x + 1, maxY: ceil, maxZ: 1 });
    }
  }
  // South wall (z=gridD-1 row)
  for (let x = 0; x < gridW; x++) {
    if (g.cells[(gridD - 1) * gridW + x] === CELL_SOLID) {
      colliders.push({ minX: x, minY: 0, minZ: gridD - 1, maxX: x + 1, maxY: ceil, maxZ: gridD });
    }
  }
  // West wall (x=0 col)
  for (let z = 1; z < gridD - 1; z++) {
    if (g.cells[z * gridW + 0] === CELL_SOLID) {
      colliders.push({ minX: 0, minY: 0, minZ: z, maxX: 1, maxY: ceil, maxZ: z + 1 });
    }
  }
  // East wall (x=gridW-1 col)
  for (let z = 1; z < gridD - 1; z++) {
    if (g.cells[z * gridW + (gridW - 1)] === CELL_SOLID) {
      colliders.push({ minX: gridW - 1, minY: 0, minZ: z, maxX: gridW, maxY: ceil, maxZ: z + 1 });
    }
  }

  // Furniture colliders (skip rugs — they're flat)
  for (const f of furnitureResult.furniture) {
    if (f.type !== 'rug') {
      colliders.push({ ...f.aabb });
    }
  }

  return {
    spec,
    ceilHeight: ceil,
    gridW,
    gridD,
    cells: g.cells,
    ceilY: g.ceilY,
    doorCells: door.cells,
    spawnPoint: door.spawn,
    exitZone: door.exitZone,
    furniture: furnitureResult.furniture,
    colliders,
    lights: furnitureResult.lights,
    rooms,
  };
}
