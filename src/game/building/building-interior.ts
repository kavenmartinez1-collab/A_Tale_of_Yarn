/**
 * Procedurally generated building interior layout -- pure deterministic module
 * mirroring the dungeon-layout approach. A function of (spec, seed) only; no
 * DOM, no GPU imports.
 *
 * Interior lives in local coordinates whose origin is the floor corner
 * (0,0,0); integration places it at a far-away world offset (y=-300, arena
 * grid by building index) exactly like dungeons.
 *
 * ## Design
 *
 * Layout follows *function*, not a room-filling algorithm. The door is always
 * on the +Z (south) wall, so every kind can compose toward a focal point at
 * the -Z end: the altar in a church, the high seat in a longhouse, the forge
 * in a smithy, the throne in a keep. Walking in, you are always looking at the
 * thing the building is *for*.
 *
 * Three tiers of content:
 *  - **Furniture** — has an AABB and blocks the player. Anything the player
 *    could bump into. Never place furniture above head height: the collider
 *    treats an AABB as a full-height blocker, so an overhead beam expressed as
 *    furniture would wall off the floor beneath it.
 *  - **Decor** — position + yaw + scale, no collision. Clutter, wall fittings,
 *    hanging things, structural timbers. This is where "inhabited" comes from.
 *  - **Lights** — deliberately few (see LIGHT_BUDGET); the fragment shader
 *    loops every light for every pixel.
 *
 * Verticality comes from three places: per-cell `ceilY` (low aisles, high
 * naves, a loft that drops the ceiling under it), the optional `gable` roof,
 * and hanging/overhead decor.
 */

import { mulberry32 } from '../mesh-utils';

// ---- types ----------------------------------------------------------------

export type BuildingKind =
  | 'house' | 'shop' | 'tavern' | 'keep'
  | 'church' | 'longhouse' | 'smithy' | 'barn' | 'guardhouse';

export const BUILDING_KINDS: readonly BuildingKind[] = [
  'house', 'shop', 'tavern', 'keep',
  'church', 'longhouse', 'smithy', 'barn', 'guardhouse',
];

export interface BuildingInteriorSpec {
  /** Name of the parent settlement (for identification). */
  settlementName: string;
  /** Index of the building in the settlement's pad array. */
  buildingIndex: number;
  /** What kind of interior to generate. */
  kind: BuildingKind;
  /** Exterior width in meters (x-axis). Derived from building footprint. */
  width: number;
  /** Exterior depth in meters (z-axis). Derived from building footprint. */
  depth: number;
}

/** Axis-aligned bounding box in local space. */
export interface AABB {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

/**
 * Solid furnishings. Every one of these is a collider, so the list is limited
 * to things that stand on the floor and that a person would walk around.
 */
export type FurnitureType =
  // sleeping
  | 'bed' | 'bunk' | 'sleepbench'
  // sitting / eating
  | 'table' | 'chair' | 'stool' | 'bench' | 'pew'
  // fire
  | 'hearth' | 'firetrench' | 'forge' | 'brazier' | 'cauldron'
  // work
  | 'anvil' | 'quench' | 'workbench' | 'grindstone' | 'loom' | 'bellows'
  // storage / trade
  | 'counter' | 'shelf' | 'cupboard' | 'wardrobe' | 'barrel' | 'crate'
  | 'sacks' | 'strongbox' | 'coalbin' | 'haybale' | 'trough'
  // status / worship
  | 'throne' | 'altar' | 'font' | 'lectern' | 'dais' | 'banner' | 'column'
  // fittings
  | 'weaponrack' | 'toolrack' | 'ladder' | 'candle' | 'rug';

/**
 * Non-colliding detail. Stamped from cached templates at build time, so there
 * can be a lot of them without the mesh builder paying `number[].push` costs.
 */
export type DecorType =
  // tabletop
  | 'mug' | 'bowl' | 'plate' | 'bottle' | 'jug' | 'loaf' | 'cheese'
  | 'candlestick' | 'book' | 'scroll' | 'ledger'
  // floor
  | 'sack' | 'basket' | 'crock' | 'bucket' | 'firewood' | 'straw' | 'boots'
  | 'broom' | 'bedroll' | 'coalpile' | 'ingots' | 'horseshoes' | 'wheel'
  | 'pitchfork' | 'stump' | 'produce'
  // wall
  | 'cloak' | 'shield' | 'pelt' | 'window' | 'icon' | 'wallshelf' | 'antlers'
  // hanging
  | 'herbs' | 'sausages' | 'lantern' | 'chandelier' | 'censer' | 'hangpot'
  // structural
  | 'beam' | 'rafter' | 'post' | 'loft' | 'stair';

export interface Furniture {
  type: FurnitureType;
  /** AABB of the furniture piece (local coords) — also its collider. */
  aabb: AABB;
  /** Rotation about +Y for the mesh, radians. AABB already contains it. */
  yaw: number;
  /** Small deterministic integer the mesh builder uses for variation. */
  variant: number;
  /** Gameplay marker: 'rent' rentable bed, 'keeper' innkeeper's post. */
  tag?: 'rent' | 'keeper';
}

export interface Decor {
  type: DecorType;
  /** Anchor point (local coords). Meaning is per-type; see the mesh builder. */
  x: number; y: number; z: number;
  /** Rotation about +Y, radians. */
  yaw: number;
  /** Uniform scale on the template. */
  scale: number;
  /** Small deterministic integer for per-instance variation. */
  variant: number;
  /** Span, for the types that stretch (beam, rafter, window, loft, wallshelf). */
  len: number;
}

/** What kind of emitter a light is — drives its prop mesh (flame vs sconce). */
export type LightKind =
  | 'torch' | 'candle' | 'hearth' | 'brazier' | 'forge' | 'lantern' | 'daylight';

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

/** A stepped-or-sloped ceiling over a rectangle of cells. */
export interface GableSpec {
  /** Cell rect the gable covers (inclusive of x0/z0, exclusive of x1/z1). */
  x0: number; z0: number; x1: number; z1: number;
  /** Eaves height (matches ceilY inside the rect). */
  eaves: number;
  /** Ridge height above the floor. */
  ridge: number;
  /** The ridge line runs along this axis. */
  axis: 'x' | 'z';
}

export interface BuildingInterior {
  spec: BuildingInteriorSpec;
  /** Tallest ceiling in the interior (m) — the bound furniture must respect. */
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
  /** Placed furniture items (each one is a collider). */
  furniture: Furniture[];
  /** Non-colliding detail props. */
  decor: Decor[];
  /** Collider AABBs (walls + furniture). */
  colliders: AABB[];
  /** Light sources (hearth, candles, braziers). */
  lights: LightSource[];
  /** Rooms (label describes purpose; the mesh builder does not use these). */
  rooms: Room[];
  /** Optional sloped ceiling over part of the interior. */
  gable: GableSpec | null;
}

export interface Room {
  x: number; z: number; w: number; d: number; label: string;
}

// ---- constants ------------------------------------------------------------

const CELL_SOLID = 0;
const CELL_FLOOR = 1;
const CELL_DOOR = 2;

/**
 * Interiors are deliberately larger than their exterior footprint. Village
 * house pads are 4 x 3.4 m; a 4x4 interior cannot hold a hearth, a bed and a
 * table without becoming a junk drawer, let alone rooms with flow. The
 * interior is never visible from outside (it lives in its own arena), so the
 * expansion costs nothing but buys every layout below.
 */
const FOOTPRINT_SCALE = 1.55;

interface KindSize { minW: number; minD: number; maxW: number; maxD: number; ceil: number }

const KIND_SIZE: Record<BuildingKind, KindSize> = {
  house:      { minW: 8,  minD: 9,  maxW: 11, maxD: 12, ceil: 2.8 },
  shop:       { minW: 9,  minD: 9,  maxW: 12, maxD: 12, ceil: 3.0 },
  tavern:     { minW: 11, minD: 10, maxW: 15, maxD: 14, ceil: 3.6 },
  keep:       { minW: 13, minD: 11, maxW: 17, maxD: 15, ceil: 5.0 },
  church:     { minW: 9,  minD: 15, maxW: 13, maxD: 20, ceil: 4.4 },
  longhouse:  { minW: 8,  minD: 17, maxW: 10, maxD: 22, ceil: 3.0 },
  smithy:     { minW: 8,  minD: 8,  maxW: 11, maxD: 11, ceil: 2.9 },
  barn:       { minW: 9,  minD: 10, maxW: 12, maxD: 14, ceil: 3.4 },
  guardhouse: { minW: 7,  minD: 7,  maxW: 10, maxD: 10, ceil: 3.0 },
};

/**
 * Hard cap on point lights per interior. `torchLighting()` in dungeon.wgsl
 * loops every light for every fragment, and a recent regression showed 16 of
 * them tanking the frame. Emissive geometry (candle tips, ember beds, window
 * panes) is free by comparison, so most visible flames in an interior are
 * *not* lights — only the ones that shape the room are.
 */
export const MAX_INTERIOR_LIGHTS = 5;

/**
 * How far in FRONT of its wall plane a window's anchor sits, and how far the
 * splayed reveal cuts back from that anchor. Both are consumed by
 * `building-interior-mesh.ts`, which is the whole point of exporting them.
 *
 * The reveal must be shallower than the inset, or the window is behind its own
 * wall. It was: the anchor was 8 cm off the plane and the emissive pane 17 cm
 * behind the anchor, so the glass sat 9 cm INSIDE the solid cell and the shell
 * builder — which emits an unbroken quad for every wall face and has no notion
 * of an aperture — drew straight over it. Half the reveal was buried with it.
 * What the player saw was a pale ghost of a frame with no glass in it, on the
 * church's great east window as much as on a cottage.
 *
 * A window drawn wholly in front of its wall is a surround standing 16 cm into
 * the room, which is what a splayed reveal in a half-metre wall looks like from
 * inside anyway. The alternative — cutting a real aperture — needs the hole in
 * the interior shell AND in the settlement's exterior mesh, which is a
 * different module and a different pass.
 */
export const WINDOW_INSET = 0.16;
/** Depth of the splay, measured back from the anchor. Must be < WINDOW_INSET. */
export const WINDOW_DEPTH = 0.13;
/** Half-height of a window at scale 1. `win()` and the mesh must agree. */
export const WINDOW_HALF_H = 0.55;

const FIRE: [number, number, number] = [1.00, 0.56, 0.22];
const FORGE_C: [number, number, number] = [1.00, 0.40, 0.12];
const CANDLE: [number, number, number] = [1.00, 0.84, 0.52];
const TORCH: [number, number, number] = [1.00, 0.72, 0.40];
const DAYLIGHT: [number, number, number] = [0.60, 0.72, 0.98];

/** Player capsule radius — reachability uses the same value the controller does. */
const PLAYER_R = 0.35;

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

function aabbOverlaps(a: AABB, b: AABB): boolean {
  return a.minX < b.maxX && a.maxX > b.minX &&
         a.minY < b.maxY && a.maxY > b.minY &&
         a.minZ < b.maxZ && a.maxZ > b.minZ;
}

// ---- grid -----------------------------------------------------------------

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
      if (x < 0 || z < 0 || x >= g.w || z >= g.d) continue;
      const idx = z * g.w + x;
      g.cells[idx] = CELL_FLOOR;
      g.ceilY[idx] = ceil;
    }
  }
}

/** Raise/lower the ceiling over a rect of already-carved cells. */
function setCeil(g: Grid, x0: number, z0: number, w: number, d: number, ceil: number): void {
  for (let z = z0; z < z0 + d; z++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || z < 0 || x >= g.w || z >= g.d) continue;
      const idx = z * g.w + x;
      if (g.cells[idx] !== CELL_SOLID) g.ceilY[idx] = ceil;
    }
  }
}

/** Fill cells solid — interior partition walls. */
function fillSolid(g: Grid, x0: number, z0: number, w: number, d: number): void {
  for (let z = z0; z < z0 + d; z++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || z < 0 || x >= g.w || z >= g.d) continue;
      const idx = z * g.w + x;
      g.cells[idx] = CELL_SOLID;
      g.ceilY[idx] = 0;
    }
  }
}

// ---- reachability ---------------------------------------------------------

/**
 * Sub-cell walk map matching `BuildingCollider` exactly: a point is standable
 * when no solid cell lies within the player's radius box and no furniture AABB
 * inflated by that radius contains it. Used to (a) reject furniture that would
 * cut the interior in two and (b) find reachable spots for chests, so nothing
 * lands somewhere the player can only stare at.
 */
const SUB = 4; // sub-cells per metre

class WalkMap {
  readonly sw: number;
  readonly sd: number;
  /** Standable ignoring furniture — a function of the cell grid alone. */
  private readonly baseFree: Uint8Array;

  constructor(g: Grid) {
    this.sw = g.w * SUB;
    this.sd = g.d * SUB;
    this.baseFree = new Uint8Array(this.sw * this.sd);
    for (let j = 0; j < this.sd; j++) {
      const z = (j + 0.5) / SUB;
      const cz0 = Math.floor(z - PLAYER_R), cz1 = Math.floor(z + PLAYER_R);
      for (let i = 0; i < this.sw; i++) {
        const x = (i + 0.5) / SUB;
        const cx0 = Math.floor(x - PLAYER_R), cx1 = Math.floor(x + PLAYER_R);
        let ok = true;
        for (let cz = cz0; cz <= cz1 && ok; cz++) {
          for (let cx = cx0; cx <= cx1; cx++) {
            if (cx < 0 || cz < 0 || cx >= g.w || cz >= g.d ||
                g.cells[cz * g.w + cx] === CELL_SOLID) { ok = false; break; }
          }
        }
        this.baseFree[j * this.sw + i] = ok ? 1 : 0;
      }
    }
  }

  /**
   * Standable map with furniture stamped out. Rasterising each blocker's
   * inflated rect is O(area) rather than O(cells x blockers), which is what
   * makes the prune loop below affordable at interior-build time.
   */
  freeWith(blockers: readonly AABB[]): Uint8Array {
    const free = this.baseFree.slice();
    for (const b of blockers) {
      if (b.maxY <= 0.3) continue;
      const i0 = Math.max(0, Math.floor((b.minX - PLAYER_R) * SUB));
      const i1 = Math.min(this.sw - 1, Math.ceil((b.maxX + PLAYER_R) * SUB));
      const j0 = Math.max(0, Math.floor((b.minZ - PLAYER_R) * SUB));
      const j1 = Math.min(this.sd - 1, Math.ceil((b.maxZ + PLAYER_R) * SUB));
      for (let j = j0; j <= j1; j++) {
        const z = (j + 0.5) / SUB;
        if (z + PLAYER_R <= b.minZ || z - PLAYER_R >= b.maxZ) continue;
        const row = j * this.sw;
        for (let i = i0; i <= i1; i++) {
          const x = (i + 0.5) / SUB;
          if (x + PLAYER_R <= b.minX || x - PLAYER_R >= b.maxX) continue;
          free[row + i] = 0;
        }
      }
    }
    return free;
  }

  /** Is this point standable at all, ignoring connectivity? */
  standable(x: number, z: number): boolean {
    const i = Math.floor(x * SUB), j = Math.floor(z * SUB);
    if (i < 0 || j < 0 || i >= this.sw || j >= this.sd) return false;
    return this.baseFree[j * this.sw + i] === 1;
  }

  /**
   * Nearest standable point to (x, z) on the grid alone. The spawn runs
   * through this: a door two cells from a partition corner puts the player
   * inside the collider's inflated wall, and then *every* move is rejected —
   * wedged solid on entry, which is the worst failure this system has.
   */
  nearestStandable(x: number, z: number): [number, number] | null {
    const si = Math.floor(x * SUB), sj = Math.floor(z * SUB);
    for (let r = 0; r <= 12; r++) {
      let best: [number, number] | null = null;
      let bestD = Infinity;
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const i = si + di, j = sj + dj;
          if (i < 0 || j < 0 || i >= this.sw || j >= this.sd) continue;
          if (!this.baseFree[j * this.sw + i]) continue;
          const px = (i + 0.5) / SUB, pz = (j + 0.5) / SUB;
          const d = (px - x) ** 2 + (pz - z) ** 2;
          if (d < bestD) { bestD = d; best = [px, pz]; }
        }
      }
      if (best !== null) return best;
    }
    return null;
  }

  /** Flood fill from a local point over a `freeWith` map. Returns cells reached. */
  flood(free: Uint8Array, sx: number, sz: number): number {
    return WalkMap.count(this.floodMask(free, sx, sz));
  }

  /**
   * Flood fill returning the reached mask. Seeds are nudged to the nearest
   * free sub-cell: without that, a spawn point that happens to sit inside a
   * wall's inflated footprint makes the whole interior read as unreachable,
   * and every consumer of this then "fixes" it by deleting furniture.
   */
  floodMask(free: Uint8Array, sx: number, sz: number): Uint8Array {
    const { sw, sd } = this;
    const seen = new Uint8Array(sw * sd);
    let start = Math.floor(sz * SUB) * sw + Math.floor(sx * SUB);
    if (start < 0 || start >= seen.length) return seen;
    if (!free[start]) {
      // Nudge: search a small ring for a standable seed.
      const si = start % sw, sj = (start / sw) | 0;
      let found = -1;
      for (let r = 1; r <= 8 && found < 0; r++) {
        for (let dj = -r; dj <= r && found < 0; dj++) {
          for (let di = -r; di <= r; di++) {
            const i = si + di, j = sj + dj;
            if (i < 0 || j < 0 || i >= sw || j >= sd) continue;
            if (free[j * sw + i]) { found = j * sw + i; break; }
          }
        }
      }
      if (found < 0) return seen;
      start = found;
    }
    const queue = new Int32Array(sw * sd);
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    // 4-connected: the controller resolves X and Z independently, so
    // diagonal-only gaps are not actually traversable.
    for (let head = 0; head < tail; head++) {
      const cur = queue[head];
      const i = cur % sw;
      const j = (cur / sw) | 0;
      if (i > 0 && !seen[cur - 1] && free[cur - 1]) { seen[cur - 1] = 1; queue[tail++] = cur - 1; }
      if (i < sw - 1 && !seen[cur + 1] && free[cur + 1]) { seen[cur + 1] = 1; queue[tail++] = cur + 1; }
      if (j > 0 && !seen[cur - sw] && free[cur - sw]) { seen[cur - sw] = 1; queue[tail++] = cur - sw; }
      if (j < sd - 1 && !seen[cur + sw] && free[cur + sw]) { seen[cur + sw] = 1; queue[tail++] = cur + sw; }
    }
    return seen;
  }

  static count(mask: Uint8Array): number {
    let n = 0;
    for (let i = 0; i < mask.length; i++) n += mask[i];
    return n;
  }
}

// ---- furnisher ------------------------------------------------------------

interface PlaceOpts {
  yaw?: number;
  variant?: number;
  tag?: 'rent' | 'keeper';
  /** Skip the door/spawn clearance test (walls fittings hugging the door). */
  allowNearDoor?: boolean;
}

/**
 * Placement + clutter helper shared by every furnishing routine. Keeping the
 * validity rules in one place is what stops "a barrel on the doorstep" and
 * "a chair inside the hearth" from being a per-kind bug.
 */
class Furnisher {
  readonly furniture: Furniture[] = [];
  readonly decor: Decor[] = [];
  readonly lights: LightSource[] = [];

  constructor(
    readonly g: Grid,
    readonly rng: () => number,
    readonly doorCells: readonly [number, number][],
    readonly spawn: readonly [number, number, number],
    /** The sloped roof, when this kind has one — see `soffitAt`. */
    readonly gable: GableSpec | null = null,
  ) {}

  /** Uniform in [a,b). */
  r(a: number, b: number): number { return a + this.rng() * (b - a); }
  /** Integer in [a,b]. */
  ri(a: number, b: number): number { return a + Math.floor(this.rng() * (b - a + 1)); }
  /** True with probability p. */
  chance(p: number): boolean { return this.rng() < p; }

  ceilAt(x: number, z: number): number {
    const cx = Math.floor(x), cz = Math.floor(z);
    if (cx < 0 || cz < 0 || cx >= this.g.w || cz >= this.g.d) return 0;
    return this.g.ceilY[cz * this.g.w + cx];
  }

  /** Lowest ceiling over the cells an AABB covers; 0 when any cell is solid. */
  private headroom(a: AABB): number {
    const x0 = Math.floor(a.minX + 0.001), x1 = Math.ceil(a.maxX - 0.001) - 1;
    const z0 = Math.floor(a.minZ + 0.001), z1 = Math.ceil(a.maxZ - 0.001) - 1;
    let lo = Infinity;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (x < 0 || z < 0 || x >= this.g.w || z >= this.g.d) return 0;
        if (this.g.cells[z * this.g.w + x] === CELL_SOLID) return 0;
        const c = this.g.ceilY[z * this.g.w + x];
        if (c < lo) lo = c;
      }
    }
    return lo === Infinity ? 0 : lo;
  }

  private cellsClear(a: AABB): boolean {
    return this.headroom(a) >= a.maxY;
  }

  private doorClear(a: AABB): boolean {
    for (const [dx, dz] of this.doorCells) {
      const zone: AABB = {
        minX: dx - 0.6, minY: 0, minZ: dz - 0.6,
        maxX: dx + 1.6, maxY: 3, maxZ: dz + 1.6,
      };
      if (aabbOverlaps(a, zone)) return false;
    }
    const [sx, , sz] = this.spawn;
    const spawnZone: AABB = {
      minX: sx - 0.7, minY: 0, minZ: sz - 0.7,
      maxX: sx + 0.7, maxY: 2.2, maxZ: sz + 0.7,
    };
    return !aabbOverlaps(a, spawnZone);
  }

  /** Would this AABB be a legal piece of furniture here? */
  fits(a: AABB, allowNearDoor = false): boolean {
    if (a.minY < 0) return false;
    if (!this.cellsClear(a)) return false;
    if (!allowNearDoor && !this.doorClear(a)) return false;
    for (const f of this.furniture) {
      if (f.type === 'rug' || f.type === 'dais') continue; // things sit on these
      if (aabbOverlaps(a, f.aabb)) return false;
    }
    return true;
  }

  /**
   * Place a piece centred on (cx, cz) with half-extents (hw, hd) and height h.
   * Returns null when it does not fit — callers are expected to have fallbacks
   * or to accept the omission.
   */
  put(
    type: FurnitureType, cx: number, cz: number,
    hw: number, hd: number, h: number, opts: PlaceOpts = {},
  ): Furniture | null {
    const aabb: AABB = {
      minX: cx - hw, minY: 0, minZ: cz - hd,
      maxX: cx + hw, maxY: h, maxZ: cz + hd,
    };
    // Duck under a low ceiling rather than vanishing under it: a banner in a
    // longhouse should be short, not absent.
    const head = this.headroom(aabb);
    if (head <= 0.1) return null;
    if (aabb.maxY > head - 0.04) aabb.maxY = head - 0.04;
    if (aabb.maxY <= 0.05) return null;
    const flat = type === 'rug' || type === 'dais';
    if (!this.fits(aabb, opts.allowNearDoor || flat)) return null;
    const f: Furniture = {
      type, aabb,
      yaw: opts.yaw ?? 0,
      variant: opts.variant ?? this.ri(0, 3),
      ...(opts.tag ? { tag: opts.tag } : {}),
    };
    this.furniture.push(f);
    return f;
  }

  /** Try a list of candidate centres, keeping the first that fits. */
  putAny(
    type: FurnitureType, spots: readonly [number, number][],
    hw: number, hd: number, h: number, opts: PlaceOpts = {},
  ): Furniture | null {
    for (const [cx, cz] of spots) {
      const f = this.put(type, cx, cz, hw, hd, h, opts);
      if (f) return f;
    }
    return null;
  }

  dec(
    type: DecorType, x: number, y: number, z: number,
    opts: { yaw?: number; scale?: number; variant?: number; len?: number } = {},
  ): Decor {
    const d: Decor = {
      type, x, y, z,
      yaw: opts.yaw ?? 0,
      scale: opts.scale ?? 1,
      variant: opts.variant ?? this.ri(0, 3),
      len: opts.len ?? 1,
    };
    this.decor.push(d);
    return d;
  }

  light(kind: LightKind, x: number, y: number, z: number,
        color: [number, number, number], radius: number): void {
    this.lights.push({ x, y, z, color, radius, kind });
  }

  /**
   * A candlestick standing on a surface at `y`, and the point light at its
   * wick. Placing both from one call is the only way the flame billboard and
   * the candle it is supposed to be sitting on stay in the same place — they
   * drifted apart twice when the two were written as separate statements.
   */
  candlelight(
    x: number, y: number, z: number,
    opts: { rich?: boolean; scale?: number; radius?: number; lit?: boolean } = {},
  ): void {
    const rich = opts.rich ?? false;
    const s = opts.scale ?? 1;
    this.dec('candlestick', x, y, z, { scale: s, variant: rich ? 1 : 0, yaw: this.r(0, 6) });
    if (opts.lit !== false) {
      this.light('candle', x, y + (rich ? 0.33 : 0.20) * s, z, CANDLE, opts.radius ?? 4);
    }
  }

  /**
   * The height of the surface actually DRAWN overhead at (x, z).
   *
   * `ceilAt` returns the per-cell `ceilY`, which is the flat plane the mesh
   * emits AND the conservative bound furniture is fitted under. Under a gable
   * that plane is not emitted at all — `emitGable` draws two slopes rising from
   * the eaves to the ridge instead — so anything nailed to the ceiling in a
   * longhouse or a barn has to follow the slope or it hangs in the air below
   * it. Everywhere else the two are the same number.
   */
  soffitAt(x: number, z: number): number {
    const gb = this.gable;
    const c = this.ceilAt(x, z);
    if (gb === null || x < gb.x0 || x >= gb.x1 || z < gb.z0 || z >= gb.z1) return c;
    const span = gb.axis === 'z' ? (gb.x1 - gb.x0) / 2 : (gb.z1 - gb.z0) / 2;
    if (span <= 1e-6) return c;
    const mid = gb.axis === 'z' ? (gb.x0 + gb.x1) / 2 : (gb.z0 + gb.z1) / 2;
    const u = Math.min(1, Math.abs((gb.axis === 'z' ? x : z) - mid) / span);
    return gb.eaves + (gb.ridge - gb.eaves) * (1 - u);
  }

  /**
   * True when the wall face at `plane` on `axis` has OUTDOORS on the far side.
   *
   * Cheap because of how the grid is built: the interior is carved at (1, 1)
   * inside a one-cell solid border, so the only two wall planes per axis with
   * nothing behind them are 1 and `size - 1`. Every other solid cell is a
   * partition with another room, a bed alcove or a guest room behind it.
   */
  exteriorWall(axis: 'x' | 'z', plane: number): boolean {
    const n = axis === 'x' ? this.g.w : this.g.d;
    return Math.abs(plane - 1) < 1e-6 || Math.abs(plane - (n - 1)) < 1e-6;
  }

  /**
   * A window on a wall of `room`, or nothing.
   *
   * `side` is -1 for the room's low wall on `axis` and +1 for its high wall;
   * `along` is the position on the OTHER axis. Every window in the game goes
   * through here, and it enforces the three things eighteen hand-written
   * `dec('window', ...)` calls could not:
   *
   * 1. THE WALL HAS AN OUTSIDE. A window is a hole to daylight, and half the
   *    taverns and half the keeps put one on the partition between the common
   *    room and the guest room — a lit pane looking into the next room, with
   *    the far side of it invisible inside a solid cell. If the requested side
   *    is a partition the OPPOSITE wall of the same room is tried (a room in a
   *    corner has one of each), and if neither is outside no window is placed.
   * 2. IT FITS UNDER ITS OWN CEILING. The head is pushed down to clear the
   *    ceiling of the cell it is in — not the tallest ceiling in the building.
   *    The barn's window sat at 2.9 m under a 2.15 m hayloft, i.e. inside the
   *    loft floor, and the church's great window went through the chancel
   *    vault on every small church.
   * 3. IT IS ALL IN FRONT OF THE WALL. See `WINDOW_INSET`.
   *
   * Returns the anchor when one was placed, so a caller can hang a daylight
   * light off it, or null.
   */
  win(
    room: Room, axis: 'x' | 'z', side: -1 | 1, along: number, y: number,
    opts: { len?: number; scale?: number; variant?: number } = {},
  ): [number, number, number] | null {
    const lo = axis === 'x' ? room.x : room.z;
    const hi = lo + (axis === 'x' ? room.w : room.d);
    let plane = side < 0 ? lo : hi;
    let s: -1 | 1 = side;
    if (!this.exteriorWall(axis, plane)) {
      plane = side < 0 ? hi : lo;
      s = side < 0 ? 1 : -1;
      if (!this.exteriorWall(axis, plane)) return null;
    }
    // Inward normal points away from the wall, into the room.
    const inward = s < 0 ? 1 : -1;
    const x = axis === 'x' ? plane + inward * WINDOW_INSET : along;
    const z = axis === 'x' ? along : plane + inward * WINDOW_INSET;
    const yaw = axis === 'x'
      ? (inward > 0 ? -Math.PI / 2 : Math.PI / 2)
      : (inward > 0 ? 0 : Math.PI);

    const ceil = this.ceilAt(x, z);
    if (ceil <= 0) return null;
    // 12 cm of wall above the head so the reveal does not run into the ceiling
    // joint, and a 0.5 m sill so it is a window and not a cat flap. Between
    // those two the window SHRINKS to fit rather than vanishing: the barn's
    // gable window is under a 2.15 m hay loft and asks for 1.65 m of glass, and
    // dropping it left the only daylight in the building with nothing to come
    // through. Below 0.55 scale there is no wall worth glazing.
    const SILL_MIN = 0.5;
    const HEAD_GAP = 0.12;
    const band = ceil - HEAD_GAP - SILL_MIN;
    let scale = opts.scale ?? 1;
    if (WINDOW_HALF_H * 2 * scale > band) scale = band / (WINDOW_HALF_H * 2);
    if (scale < 0.55) return null;
    const hh = WINDOW_HALF_H * scale;
    const yy = Math.min(y + hh, ceil - HEAD_GAP) - hh;
    // `variant` is left undefined when the caller does not care, so `dec` draws
    // it — windows have mullions in one variant and the RNG stream is shared
    // with every other prop in the building.
    this.dec('window', x, yy, z, { yaw, scale, len: opts.len ?? 1, variant: opts.variant });
    return [x, yy, z];
  }

  /**
   * Floor clutter, placed only if there is floor under it.
   *
   * `dec` takes the anchor on trust, which is right for wall and ceiling props
   * (they are inset from a surface that exists by construction) and wrong for
   * anything positioned RELATIVE TO A PIECE OF FURNITURE — "0.8 m to the left
   * of the bed" is off the end of the room whenever the bed is against the
   * wall. The boots beside every bed in a narrow house were inside the wall.
   */
  floorDec(type: DecorType, x: number, z: number,
           opts: { yaw?: number; scale?: number; variant?: number; len?: number } = {},
           y = 0): boolean {
    const cx = Math.floor(x); const cz = Math.floor(z);
    if (cx < 0 || cz < 0 || cx >= this.g.w || cz >= this.g.d) return false;
    if (this.g.cells[cz * this.g.w + cx] === CELL_SOLID) return false;
    this.dec(type, x, y, z, opts);
    return true;
  }

  /**
   * A prop that hangs, anchored to the surface it hangs FROM.
   *
   * Every hanging template — lantern, chandelier, censer, herbs, sausages,
   * hangpot — is modelled with its chain, cord or hook starting at local y = 0
   * and running downward, so the anchor IS the ceiling it is nailed to. They
   * were all written as `ceil - 0.15` or `ceil - 0.2`, which hangs the top of
   * the chain 15 to 20 cm below the plaster and leaves the prop floating with a
   * bare cord end pointing at nothing. Reported from play as floating torches.
   *
   * Beams count as a surface: a tie beam is what you actually hang a lamp off,
   * and the beams here are boxes of half-thickness `BEAM_HALF` centred on their
   * own anchor, so their soffit is `BEAM_HALF` below it.
   */
  hang(type: DecorType, x: number, z: number,
       opts: { scale?: number; yaw?: number; len?: number; variant?: number;
               from?: number } = {}): number {
    const y = opts.from ?? this.soffitAt(x, z);
    this.dec(type, x, y, z, opts);
    return y;
  }

  /** A lantern hanging from the ceiling at (x, z), with the light in its glass. */
  lanternlight(x: number, z: number, scale = 1, radius = 5.5, from?: number): void {
    const y = this.hang('lantern', x, z, { scale, from });
    this.light('lantern', x, y - 0.28 * scale, z, TORCH, radius);
  }

  /**
   * Scatter small props over the top surface of a piece of furniture. This is
   * most of what makes a table read as "somebody ate here" rather than "a
   * table asset". Positions are jittered, never centred.
   */
  clutter(on: Furniture, types: readonly DecorType[], count: number, inset = 0.16): void {
    const a = on.aabb;
    const w = a.maxX - a.minX - inset * 2;
    const d = a.maxZ - a.minZ - inset * 2;
    if (w <= 0 || d <= 0) return;
    for (let i = 0; i < count; i++) {
      const t = types[Math.floor(this.rng() * types.length)];
      const x = a.minX + inset + this.rng() * w;
      const z = a.minZ + inset + this.rng() * d;
      this.dec(t, x, a.maxY, z, { yaw: this.r(0, Math.PI * 2), scale: this.r(0.9, 1.1) });
    }
  }

  /** Scatter floor decor inside a rect, avoiding furniture footprints. */
  scatter(
    types: readonly DecorType[], x0: number, z0: number, x1: number, z1: number,
    count: number, opts: { scale?: [number, number]; clearance?: number } = {},
  ): void {
    const clearance = opts.clearance ?? 0.25;
    for (let i = 0; i < count; i++) {
      let placed = false;
      for (let tries = 0; tries < 8 && !placed; tries++) {
        const x = this.r(x0, x1);
        const z = this.r(z0, z1);
        const probe: AABB = {
          minX: x - clearance, minY: 0.05, minZ: z - clearance,
          maxX: x + clearance, maxY: 0.4, maxZ: z + clearance,
        };
        if (!this.cellsClear(probe)) continue;
        let hit = false;
        for (const f of this.furniture) {
          if (f.type === 'rug' || f.type === 'dais') continue;
          if (aabbOverlaps(probe, f.aabb)) { hit = true; break; }
        }
        if (hit) continue;
        const s = opts.scale ? this.r(opts.scale[0], opts.scale[1]) : this.r(0.85, 1.15);
        const t = types[Math.floor(this.rng() * types.length)];
        this.dec(t, x, 0, z, { yaw: this.r(0, Math.PI * 2), scale: s });
        placed = true;
      }
    }
  }

  /**
   * Ceiling timbers across a rect. Cheap, and the single biggest cue that an
   * interior has a roof over it rather than a lid.
   */
  beams(x0: number, z0: number, x1: number, z1: number, y: number, step = 2, axis: 'x' | 'z' = 'x'): void {
    if (axis === 'x') {
      for (let z = z0 + step * 0.5; z < z1; z += step) {
        this.dec('beam', (x0 + x1) / 2, y, z, { yaw: 0, len: x1 - x0, scale: 1 });
      }
    } else {
      for (let x = x0 + step * 0.5; x < x1; x += step) {
        this.dec('beam', x, y, (z0 + z1) / 2, { yaw: Math.PI / 2, len: z1 - z0, scale: 1 });
      }
    }
  }

  /**
   * Wall fittings along a wall line — hooks, shelves, shields, windows.
   *
   * Every wall prop is modelled facing +Z, and `PalBatch.stamp` sends local
   * +Z to (-sin yaw, cos yaw). So the yaw that turns a prop to face *into* the
   * room is: -Z wall 0, +Z wall pi, **-X wall -pi/2, +X wall +pi/2**. Getting
   * the two X walls the wrong way round buries the prop in the wall and hangs
   * its back face in the room, which reads as a floating slab.
   */
  wallRow(
    types: readonly DecorType[], x0: number, z0: number, x1: number, z1: number,
    y: number, count: number, yaw: number, scale = 1,
  ): void {
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const x = x0 + (x1 - x0) * t;
      const z = z0 + (z1 - z0) * t;
      const type = types[Math.floor(this.rng() * types.length)];
      this.dec(type, x, y, z, { yaw, scale: scale * this.r(0.92, 1.08) });
    }
  }
}

// ---- door -----------------------------------------------------------------

interface DoorInfo {
  cells: [number, number][];
  spawn: [number, number, number];
  exitZone: AABB;
}

/**
 * The door is always on the +Z wall. Every interior therefore composes toward
 * -Z, and the first thing the player sees on entering is the focal point of
 * the room rather than whichever wall the RNG happened to pick.
 */
function placeSouthDoor(g: Grid, roomX: number, roomW: number, roomZmax: number, ceil: number): DoorInfo {
  const doorWidth = Math.min(2, roomW);
  const midX = roomX + Math.floor(roomW / 2);
  const x0 = midX - (doorWidth >> 1);
  const cells: [number, number][] = [];
  for (let i = 0; i < doorWidth; i++) {
    const x = x0 + i;
    const idx = roomZmax * g.w + x;
    g.cells[idx] = CELL_DOOR;
    g.ceilY[idx] = Math.min(ceil, 2.4);
    cells.push([x, roomZmax]);
  }
  const cx = x0 + doorWidth / 2;
  return {
    cells,
    spawn: [cx, 0, roomZmax - 0.9],
    exitZone: {
      minX: cx - doorWidth / 2, minY: 0, minZ: roomZmax - 0.1,
      maxX: cx + doorWidth / 2, maxY: 2.4, maxZ: roomZmax + 0.95,
    },
  };
}

// =========================================================================
//  Per-kind furnishing
// =========================================================================
//
// Each routine receives the carved grid plus the room rects it created, and
// is responsible for its own composition. They are deliberately not sharing a
// "fill the room" pass — a longhouse and a church are different buildings, not
// the same building with different props.

/**
 * HOUSE — a hearth room you walk into and a bed alcove behind a partition.
 * The hearth is the far wall; the table sits between you and it so the room
 * has a middle. The alcove has a lower ceiling with a loft above it, which is
 * where the storage clutter lives.
 */
function furnishHouse(f: Furnisher, main: Room, alcove: Room | null): void {
  const { x: rx, z: rz, w: rw, d: rd } = main;
  const cx = rx + rw / 2;
  const ceil = f.ceilAt(cx, rz + 0.5);

  // --- hearth on the far (-Z) wall, off centre so the room is not symmetric
  const hx = rx + rw * (f.chance(0.5) ? 0.34 : 0.66);
  const hearth = f.put('hearth', hx, rz + 0.55, 0.72, 0.48, 1.35);
  if (hearth) {
    f.light('hearth', hx, 0.42, rz + 0.75, FIRE, 7.5);
    // Mantel clutter + a cauldron swung over the fire.
    // Anchored in the ceiling, `len` metres of chain down to the pot: the
    // cauldron reads as hung over the fire only if the chain reaches something.
    f.hang('hangpot', hx, rz + 0.85, { scale: 0.9, len: f.soffitAt(hx, rz + 0.85) - 1.05 });
    f.dec('candlestick', hx - 0.42, 1.35, rz + 0.5, { scale: 0.85 });
    f.dec('crock', hx + 0.45, 1.35, rz + 0.5, { scale: 0.55 });
    f.put('crate', hx + 1.35, rz + 0.6, 0.3, 0.3, 0.45, { variant: 2 });
    f.dec('firewood', hx - 1.3, 0, rz + 0.6, { scale: 1.05, yaw: 0.3 });
  }

  // --- table with mismatched seating, deliberately not centred
  const tx = cx + f.r(-0.6, 0.6);
  const tz = rz + rd * 0.45;
  const table = f.put('table', tx, tz, 0.62, 0.45, 0.76);
  if (table) {
    f.clutter(table, ['bowl', 'mug', 'loaf', 'plate', 'jug', 'cheese'], f.ri(3, 5));
    f.candlelight(tx + f.r(-0.3, 0.3), table.aabb.maxY, tz + f.r(-0.2, 0.2),
      { scale: 0.95, radius: 4.6 });
    // Someone got up mid-meal: one chair pushed back and turned.
    f.put('chair', tx - 0.95, tz + 0.1, 0.22, 0.22, 0.92, { yaw: -Math.PI / 2 + f.r(-0.3, 0.3) });
    f.put('chair', tx + 0.95, tz - 0.05, 0.22, 0.22, 0.92, { yaw: Math.PI / 2 });
    if (f.chance(0.6)) f.put('stool', tx + f.r(-0.4, 0.4), tz + 0.85, 0.19, 0.19, 0.48, { yaw: f.r(0, 3) });
  }

  // --- dresser / cupboard against a side wall, with crockery on it
  const cupSide = f.chance(0.5) ? rx + 0.42 : rx + rw - 0.42;
  const cup = f.put('cupboard', cupSide, rz + rd * 0.3, 0.38, 0.62, 1.55,
    { yaw: cupSide < cx ? -Math.PI / 2 : Math.PI / 2 });
  if (cup) f.clutter(cup, ['bowl', 'jug', 'crock', 'plate'], 3, 0.14);

  // --- bed: in the alcove when there is one, otherwise against a side wall
  const bedRoom = alcove ?? main;
  const alongX = bedRoom.w >= bedRoom.d;
  const bedX = alcove ? alcove.x + (alongX ? alcove.w / 2 : 0.62) : rx + rw - 0.62;
  const bedZ = alcove ? alcove.z + (alongX ? 1.05 : alcove.d / 2) : rz + rd - 1.4;
  const bed = f.putAny('bed', [
    [bedX, bedZ],
    [bedRoom.x + bedRoom.w - 0.62, bedRoom.z + bedRoom.d / 2],
    [bedRoom.x + 0.62, bedRoom.z + bedRoom.d / 2],
    [rx + rw - 0.62, rz + rd * 0.72],
  ], alongX && alcove ? 1.05 : 0.55, alongX && alcove ? 0.55 : 1.05, 0.62,
    { yaw: alongX && alcove ? -Math.PI / 2 : 0, variant: f.ri(0, 2) });
  if (bed) {
    const bcx = (bed.aabb.minX + bed.aabb.maxX) / 2;
    const bcz = (bed.aabb.minZ + bed.aabb.maxZ) / 2;
    // A rug you step onto when you get out of bed.
    f.put('rug', bcx + (bcx < cx ? 0.95 : -0.95), bcz, 0.48, 0.72, 0.03);
    f.floorDec('boots', bcx + (bcx < cx ? 0.8 : -0.8), bcz + 0.55, { yaw: f.r(0, 3), scale: 0.95 });
    const nightstand = f.put('crate', bcx, bcz + (bed.aabb.maxZ - bed.aabb.minZ) / 2 + 0.42,
      0.34, 0.28, 0.5, { variant: 1 });
    if (nightstand) {
      f.candlelight(bcx, nightstand.aabb.maxY,
        (nightstand.aabb.minZ + nightstand.aabb.maxZ) / 2,
        { radius: 3.6, lit: f.lights.length < 2 });
    }
  }

  // --- loom or a spinning corner: evidence of a trade practised at home
  if (f.chance(0.55)) {
    f.putAny('loom', [
      [rx + 0.55, rz + rd * 0.62], [rx + rw - 0.55, rz + rd * 0.62],
      [rx + 0.55, rz + 1.6],
    ], 0.42, 0.62, 1.5, { yaw: -Math.PI / 2 });
  }

  // --- entry: boots, a broom, a cloak on the wall by the door
  const [sx, , sz] = f.spawn;
  f.dec('cloak', sx + 1.15, 1.6, rz + rd - 0.12, { yaw: Math.PI, scale: 1 });
  f.floorDec('broom', sx - 1.1, rz + rd - 0.35, { yaw: 0.35, scale: 1 });
  f.floorDec('boots', sx + 0.75, rz + rd - 0.4, { yaw: 2.4, scale: 0.9 });

  // --- verticality: tie beams, hanging herbs, a loft over the alcove
  const beamZ1 = alcove ? Math.min(rz + rd - 0.05, alcove.z - 0.1) : rz + rd - 0.05;
  f.beams(rx + 0.05, rz + 0.05, rx + rw - 0.05, beamZ1, ceil - 0.16, 2.2);
  f.hang('herbs', rx + rw * 0.3, rz + rd * 0.35, { scale: 1 });
  f.hang('herbs', rx + rw * 0.62, rz + rd * 0.3, { scale: 0.85, yaw: 0.7 });
  if (alcove) {
    const ac = f.ceilAt(alcove.x + 0.5, alcove.z + 0.5);
    f.dec('loft', alcove.x + alcove.w / 2, ac, alcove.z + alcove.d / 2,
      { len: alcove.w, scale: alcove.d });
    f.dec('sack', alcove.x + alcove.w * 0.3, ac + 0.12, alcove.z + 0.7, { scale: 1.05 });
    f.dec('sack', alcove.x + alcove.w * 0.62, ac + 0.12, alcove.z + 1.1, { scale: 0.9 });
    f.dec('basket', alcove.x + alcove.w * 0.8, ac + 0.12, alcove.z + 0.6, { scale: 0.9 });
    f.put('ladder', alcove.x + 0.35, alcove.z + alcove.d - 0.5, 0.22, 0.2, ac + 0.55,
      { yaw: 0, allowNearDoor: true });
  }

  // --- floor life
  f.scatter(['straw', 'straw', 'straw', 'basket', 'crock', 'bucket', 'sack'],
    rx + 0.5, rz + 0.5, rx + rw - 0.5, rz + rd - 0.6, f.ri(7, 10));
  f.win(main, 'x', 1, rz + rd * 0.34, 1.55, { len: 1.1 });
  f.win(main, 'x', -1, rz + rd * 0.52, 1.55, { len: 1.1 });
}

/**
 * SHOP — the counter is the whole plan. Customer side by the door, trade side
 * behind it with the shelves and the strongbox, and a back store room the
 * player cannot reach past a stacked-crate barrier, which is what makes the
 * counter feel like a boundary instead of a table.
 */
function furnishShop(f: Furnisher, main: Room, store: Room | null): void {
  const { x: rx, z: rz, w: rw, d: rd } = main;
  const cx = rx + rw / 2;
  const ceil = f.ceilAt(cx, rz + 1.5);

  // --- counter across the room with a gap at one end for the shopkeeper
  const gapLeft = f.chance(0.5);
  const counterZ = rz + rd * 0.52;
  const counterLen = rw - 2.2;
  const counterCx = gapLeft ? rx + rw - counterLen / 2 - 0.35 : rx + counterLen / 2 + 0.35;
  const counter = f.put('counter', counterCx, counterZ, counterLen / 2, 0.34, 1.02,
    { tag: 'keeper' });
  if (counter) {
    f.clutter(counter, ['bowl', 'jug', 'ledger', 'crock', 'bottle', 'scroll'], f.ri(3, 5), 0.22);
    f.candlelight(counterCx + counterLen * 0.32, counter.aabb.maxY, counterZ, { radius: 4.2 });
    f.put('stool', counterCx - counterLen * 0.2, counterZ - 0.75, 0.19, 0.19, 0.5);
  }

  // --- trade wall: shelves of wares behind the counter
  const shelfCount = Math.max(2, Math.floor(rw / 3));
  for (let i = 0; i < shelfCount; i++) {
    const sx = rx + 0.9 + (i + 0.5) * (rw - 1.8) / shelfCount;
    const sh = f.put('shelf', sx, rz + 0.42, (rw - 1.8) / shelfCount / 2 - 0.12, 0.32, 1.9);
    if (sh) {
      // Wares on each open shelf board, not just the top.
      for (const y of [0.62, 1.12, 1.62]) {
        const n = f.ri(2, 4);
        for (let k = 0; k < n; k++) {
          const t: DecorType = (['bottle', 'crock', 'jug', 'bowl', 'book', 'scroll'] as const)[f.ri(0, 5)];
          f.dec(t, sh.aabb.minX + 0.18 + f.rng() * (sh.aabb.maxX - sh.aabb.minX - 0.36),
            y, rz + 0.42 + f.r(-0.08, 0.08), { yaw: f.r(0, 6), scale: f.r(0.8, 1.05) });
        }
      }
    }
  }
  f.put('strongbox', gapLeft ? rx + 0.55 : rx + rw - 0.55, rz + 1.35, 0.32, 0.28, 0.55,
    { yaw: gapLeft ? -Math.PI / 2 : Math.PI / 2 });

  // --- customer side: goods to browse, stacked so the eye travels upward
  const barrels: [number, number][] = [
    [rx + 0.62, rz + rd - 1.5], [rx + rw - 0.62, rz + rd - 1.5],
    [rx + 0.62, rz + rd * 0.72], [rx + rw - 0.62, rz + rd * 0.72],
  ];
  for (const [bx, bz] of barrels) {
    if (f.chance(0.75)) {
      const b = f.put('barrel', bx, bz, 0.3, 0.3, 0.92);
      if (b && f.chance(0.5)) f.dec('produce', bx, 0.92, bz, { scale: 0.9 });
    }
  }
  f.put('crate', rx + rw - 1.5, rz + rd - 1.1, 0.36, 0.36, 0.62, { yaw: f.r(-0.2, 0.2) });
  f.dec('sack', rx + 1.2, 0, rz + rd - 1.2, { scale: 1.15 });
  f.dec('sack', rx + 1.6, 0, rz + rd - 1.5, { scale: 0.95, yaw: 1.2 });
  f.dec('basket', rx + 1.0, 0, rz + rd - 1.8, { scale: 1.05 });

  // --- store room: crates to the ceiling, seen over the barrier
  if (store) {
    const s = store;
    for (let i = 0; i < 5; i++) {
      const bx = s.x + 0.55 + f.rng() * (s.w - 1.1);
      const bz = s.z + 0.55 + f.rng() * (s.d - 1.1);
      const stack = f.put('crate', bx, bz, 0.38, 0.38, f.chance(0.5) ? 0.65 : 1.25,
        { yaw: f.r(-0.25, 0.25) });
      if (stack && f.chance(0.4)) f.dec('sack', bx, stack.aabb.maxY, bz, { scale: 0.9 });
    }
    f.win(s, 'x', 1, s.z + s.d / 2, 1.7, { len: 0.9 });
  }

  // --- hanging trade goods: the ceiling is stock space in a real shop
  f.beams(rx + 0.05, rz + 0.05, rx + rw - 0.05, rz + rd - 0.05, ceil - 0.16, 2.4);
  f.hang('herbs', rx + rw * 0.25, counterZ - 0.5, { scale: 1.1 });
  f.hang('sausages', rx + rw * 0.55, counterZ - 0.4, { scale: 1, len: 1.4 });
  f.hang('herbs', rx + rw * 0.78, counterZ - 0.6, { scale: 0.9, yaw: 0.8 });
  f.lanternlight(cx, rz + rd * 0.75, 1, 6);
  f.win(main, 'x', -1, rz + rd * 0.78, 1.6, { len: 1.2 });
  f.wallRow(['wallshelf'], rx + rw - 0.12, rz + 1.2, rx + rw - 0.12, rz + rd * 0.42, 1.5, 1, Math.PI / 2, 1.2);
  f.scatter(['straw', 'crock', 'bucket'], rx + 0.6, rz + rd * 0.62, rx + rw - 0.6, rz + rd - 0.7, f.ri(3, 5));
}

/**
 * TAVERN — a common room organised around the bar, with a guest room off the
 * back that the player can rent a bed in. The hearth is on the far wall and
 * the tables are scattered between it and the door so there is somewhere to
 * walk. Everything on the tables is mid-use: emptied mugs, a played-out game.
 */
function furnishTavern(f: Furnisher, main: Room, guest: Room | null): void {
  const { x: rx, z: rz, w: rw, d: rd } = main;
  const cx = rx + rw / 2;
  const ceil = f.ceilAt(cx, rz + rd / 2);

  // --- bar along one long wall
  const left = f.chance(0.5);
  const barX = left ? rx + 0.55 : rx + rw - 0.55;
  const barZ0 = rz + 1.1;
  const barZ1 = rz + rd * 0.62;
  const barCz = (barZ0 + barZ1) / 2;
  const bar = f.put('counter', barX, barCz, 0.44, (barZ1 - barZ0) / 2, 1.06,
    { yaw: left ? -Math.PI / 2 : Math.PI / 2, tag: 'keeper' });
  if (bar) {
    f.clutter(bar, ['mug', 'mug', 'jug', 'bowl', 'bottle'], f.ri(4, 6), 0.2);
    f.candlelight(barX, bar.aabb.maxY, barZ0 + 0.45, { radius: 4.6 });
    // Barrels racked behind the bar, tapped and ready.
    for (let i = 0; i < 3; i++) {
      const bz = barZ0 + 0.35 + i * ((barZ1 - barZ0 - 0.7) / 2);
      f.put('barrel', left ? rx + 0.36 : rx + rw - 0.36, bz, 0.28, 0.3, 0.95,
        { variant: 1, allowNearDoor: true });
    }
    // Shelf of bottles and hanging tankards above the bar.
    f.dec('wallshelf', left ? rx + 0.1 : rx + rw - 0.1, 1.62, barCz,
      { yaw: left ? -Math.PI / 2 : Math.PI / 2, len: barZ1 - barZ0 - 0.4 });
    for (let i = 0; i < 6; i++) {
      const bz = barZ0 + 0.3 + i * ((barZ1 - barZ0 - 0.6) / 5);
      f.dec(f.chance(0.5) ? 'bottle' : 'crock', left ? rx + 0.3 : rx + rw - 0.3, 1.72, bz,
        { scale: f.r(0.85, 1.1), yaw: f.r(0, 6) });
    }
  }

  // --- hearth at the far end with settles pulled up to it
  const hx = left ? rx + rw * 0.62 : rx + rw * 0.38;
  const hearth = f.put('hearth', hx, rz + 0.55, 0.85, 0.5, 1.5);
  if (hearth) {
    f.light('hearth', hx, 0.45, rz + 0.78, FIRE, 8.5);
    f.hang('hangpot', hx, rz + 0.85, { scale: 1.05, len: f.soffitAt(hx, rz + 0.85) - 1.15 });
    f.dec('firewood', hx + 1.25, 0, rz + 0.55, { scale: 1.1 });
    f.put('bench', hx - 1.35, rz + 1.15, 0.24, 0.6, 0.46, { yaw: 0 });
    f.dec('antlers', hx, 2.1, rz + 0.1, { scale: 1.1 });
  }

  // --- tables, jittered off any grid, each with its own story on it
  const tableSpots: [number, number][] = [];
  const openX0 = left ? rx + 1.7 : rx + 0.9;
  const openX1 = left ? rx + rw - 0.9 : rx + rw - 1.7;
  for (let i = 0; i < 5; i++) {
    tableSpots.push([f.r(openX0 + 0.6, openX1 - 0.6), f.r(rz + 1.9, rz + rd - 1.7)]);
  }
  let tables = 0;
  for (const [tx, tz] of tableSpots) {
    if (tables >= 4) break;
    const t = f.put('table', tx, tz, f.r(0.5, 0.66), f.r(0.44, 0.56), 0.76,
      { yaw: f.r(-0.25, 0.25) });
    if (!t) continue;
    tables++;
    f.clutter(t, ['mug', 'mug', 'bowl', 'plate', 'jug', 'loaf', 'cheese'], f.ri(3, 6));
    if (f.chance(0.4)) f.dec('candlestick', tx + f.r(-0.2, 0.2), 0.76, tz + f.r(-0.2, 0.2), { scale: 0.9 });
    // Seating: never four matching stools.
    const n = f.ri(2, 4);
    const start = f.rng() * Math.PI * 2;
    for (let k = 0; k < n; k++) {
      const a = start + (k / n) * Math.PI * 2 + f.r(-0.3, 0.3);
      const rr = 0.82 + f.r(0, 0.16);
      const seat: FurnitureType = f.chance(0.65) ? 'stool' : 'chair';
      f.put(seat, tx + Math.cos(a) * rr, tz + Math.sin(a) * rr,
        seat === 'stool' ? 0.19 : 0.22, seat === 'stool' ? 0.19 : 0.22,
        // Face the table: local +Z goes to (-sin yaw, cos yaw), and the seat
        // must look along (-cos a, -sin a).
        seat === 'stool' ? 0.49 : 0.9, { yaw: a + Math.PI / 2 });
    }
  }

  // --- long trestle by the wall opposite the bar
  const trestleX = left ? rx + rw - 0.95 : rx + 0.95;
  const trestle = f.put('table', trestleX, rz + rd * 0.42, 0.42, 1.35, 0.76,
    { yaw: -Math.PI / 2, variant: 1 });
  if (trestle) {
    f.clutter(trestle, ['mug', 'bowl', 'plate', 'jug'], f.ri(3, 5));
    f.put('bench', trestleX + (left ? -0.78 : 0.78), rz + rd * 0.42, 0.22, 1.2, 0.46,
      { yaw: -Math.PI / 2 });
  }

  // --- guest room: the rentable beds
  if (guest) {
    const g = guest;
    const gc = f.ceilAt(g.x + 0.5, g.z + 0.5);
    const along = g.w >= g.d;
    const nBeds = Math.min(2, Math.max(1, Math.floor((along ? g.d : g.w) / 1.6)));
    for (let i = 0; i < nBeds; i++) {
      const t = (i + 0.5) / nBeds;
      const bx = along ? g.x + 0.62 : g.x + g.w * t;
      const bz = along ? g.z + g.d * t : g.z + 0.62;
      const bed = f.put('bed', bx, bz, along ? 0.55 : 0.5, along ? 0.98 : 0.55,
        0.62, { yaw: along ? 0 : -Math.PI / 2, tag: 'rent', variant: i });
      if (bed) {
        f.floorDec('boots', bx + (along ? 0.85 : 0), bz + (along ? 0.4 : 0.85),
          { yaw: f.r(0, 3), scale: 0.9 });
      }
    }
    f.put('cupboard', g.x + g.w - 0.42, g.z + g.d - 0.6, 0.32, 0.36, 0.9,
      { yaw: Math.PI / 2, variant: 2 });
    f.candlelight(g.x + g.w - 0.42, 0.9, g.z + g.d - 0.6, { scale: 0.95, radius: 3.8 });
    f.win(g, 'x', 1, g.z + g.d * 0.4, 1.6, { len: 1 });
    f.dec('rafter', g.x + g.w / 2, gc - 0.1, g.z + g.d / 2, { len: g.w, scale: g.d });
    f.scatter(['straw', 'bucket'], g.x + 0.6, g.z + 0.6, g.x + g.w - 0.6, g.z + g.d - 0.6, 2);
  }

  // --- overhead: beams, a wheel chandelier, drying stock
  f.beams(rx + 0.05, rz + 0.05, rx + rw - 0.05, rz + rd - 0.05, ceil - 0.18, 2.3);
  f.hang('chandelier', cx + (left ? 0.6 : -0.6), rz + rd * 0.5, { scale: 1.15 });
  f.hang('sausages', barX + (left ? 0.9 : -0.9), barZ0 + 0.4, { scale: 1, len: 1.5 });
  f.hang('herbs', cx, rz + 1.4, { scale: 1 });
  f.win(main, 'x', 1, rz + rd - 1.6, 1.75, { len: 1.2 });
  f.win(main, 'x', -1, rz + rd - 1.6, 1.75, { len: 1.2 });

  // --- floor: straw, a spilled bucket, a dog's bowl by the fire
  f.scatter(['straw', 'straw', 'straw', 'straw', 'straw', 'sack', 'basket', 'crock', 'mug'],
    rx + 0.7, rz + 1.2, rx + rw - 0.7, rz + rd - 0.8, f.ri(10, 14));
  f.dec('bowl', hx + 0.8, 0, rz + 1.5, { scale: 1.1 });
  f.dec('cloak', rx + rw * 0.3, 1.62, rz + rd - 0.12, { yaw: Math.PI, scale: 1.05 });
}

/**
 * LONGHOUSE — one hall. A fire trench runs down the middle, raised sleeping
 * platforms line both long walls, and the high seat closes the far end. The
 * ceiling is a gable with the rafters exposed and food hung to smoke over the
 * fire. Nothing here is a room; the whole building is one space shared by
 * everybody in it, which is the point.
 */
function furnishLonghouse(f: Furnisher, main: Room): void {
  const { x: rx, z: rz, w: rw, d: rd } = main;
  const cx = rx + rw / 2;

  // --- the fire trench: a long stone-kerbed hearth, two fires along it
  const trenchZ0 = rz + 3.0;
  const trenchZ1 = rz + rd - 2.6;
  const trench = f.put('firetrench', cx, (trenchZ0 + trenchZ1) / 2,
    0.62, (trenchZ1 - trenchZ0) / 2, 0.3);
  if (trench) {
    f.light('hearth', cx, 0.32, trenchZ0 + (trenchZ1 - trenchZ0) * 0.28, FIRE, 8.5);
    f.light('hearth', cx, 0.32, trenchZ0 + (trenchZ1 - trenchZ0) * 0.74, FIRE, 8.5);
    {
      const pz = trenchZ0 + (trenchZ1 - trenchZ0) * 0.5;
      f.hang('hangpot', cx, pz, { scale: 1.2, len: f.soffitAt(cx, pz) - 1.9 });
    }
    f.dec('firewood', cx + 1.0, 0, trenchZ1 + 0.6, { scale: 1.15, yaw: 0.4 });
  }

  // --- sleeping platforms down both walls, split into bays by posts
  // The platforms stop well short of both ends: a bench that runs to the -Z
  // wall meets the head table and seals the high seat off completely.
  const benchZ0 = rz + 3.4;
  const benchSpan = rd - 4.6;
  const bays = Math.max(3, Math.floor(benchSpan / 2.2));
  for (const side of [0, 1]) {
    const px = side === 0 ? rx + 0.72 : rx + rw - 0.72;
    for (let i = 0; i < bays; i++) {
      const t0 = benchZ0 + i * (benchSpan / bays);
      const len = benchSpan / bays - 0.35;
      const bench = f.put('sleepbench', px, t0 + len / 2, 0.7, len / 2, 0.55,
        { yaw: side === 0 ? -Math.PI / 2 : Math.PI / 2, variant: i & 3 });
      if (bench && f.chance(0.7)) {
        f.dec('bedroll', px, 0.55, t0 + len / 2 + f.r(-0.2, 0.2),
          { yaw: side === 0 ? 0 : Math.PI, scale: f.r(0.95, 1.1) });
      }
      // Chests and gear tucked under and beside the platforms.
      if (f.chance(0.45)) {
        f.dec('sack', px + (side === 0 ? 0.55 : -0.55), 0, t0 + f.r(0.2, len - 0.2),
          { scale: 0.95 });
      }
    }
    // Roof posts stand at the platform edge, holding the tie beams.
    for (let i = 0; i <= bays; i++) {
      const pz = benchZ0 + i * (benchSpan / bays);
      f.dec('post', px + (side === 0 ? 0.75 : -0.75), 0, pz, { scale: 1, len: 2.35 });
    }
    // Shields and pelts hung on the wall above the platforms.
    f.wallRow(['shield', 'pelt', 'shield', 'antlers'],
      side === 0 ? rx + 0.1 : rx + rw - 0.1, benchZ0 + 0.4,
      side === 0 ? rx + 0.1 : rx + rw - 0.1, benchZ0 + benchSpan - 0.4,
      1.62, Math.max(2, bays - 1), side === 0 ? -Math.PI / 2 : Math.PI / 2, 1.05);
  }

  // --- high seat closing the -Z end, on a low dais, flanked by banners
  // 0.72 deep, not 0.85: the head table stands at rz + 2.3 and a dais reaching
  // rz + 2.00 put the table's back legs 22 cm inside the step instead of in
  // front of it. The throne and the pelt both still land on it.
  f.put('dais', cx, rz + 1.02, rw * 0.32, 0.72, 0.22);
  const seat = f.put('throne', cx, rz + 0.9, 0.62, 0.5, 1.7, { variant: 1 });
  if (seat) {
    // Hard against the -Z wall, NOT at rz + 0.35: the dais in front of them
    // runs from rz + 0.30, so a banner centred at 0.35 stood with its foot 10 cm
    // inside the dais slab and its collider crossing the step.
    f.put('banner', cx - 1.5, rz + 0.12, 0.16, 0.1, 2.6, { allowNearDoor: true });
    f.put('banner', cx + 1.5, rz + 0.12, 0.16, 0.1, 2.6, { allowNearDoor: true });
    f.dec('pelt', cx, 0.22, rz + 1.6, { scale: 1.3, variant: 1 });
  }
  // The lord's table sits across the hall in front of the seat.
  const head = f.put('table', cx, rz + 2.3, rw * 0.26, 0.44, 0.78, { variant: 1 });
  if (head) f.clutter(head, ['mug', 'bowl', 'jug', 'plate', 'loaf'], f.ri(4, 6));
  f.put('bench', cx, rz + 3.0, rw * 0.24, 0.22, 0.46);

  // --- stores at the door end
  for (const [bx, bz] of [
    [rx + 0.7, rz + rd - 1.3], [rx + rw - 0.7, rz + rd - 1.3],
    [rx + 1.5, rz + rd - 1.2],
  ] as [number, number][]) {
    if (f.chance(0.8)) f.put('barrel', bx, bz, 0.3, 0.3, 0.95, { variant: f.ri(0, 2) });
  }
  f.put('sacks', rx + rw - 1.6, rz + rd - 1.25, 0.42, 0.36, 0.55);

  // --- overhead: rafters up to the ridge, smoke-drying food over the fire
  const eaves = f.ceilAt(cx, rz + rd / 2);
  for (let z = rz + 1.4; z < rz + rd - 0.8; z += 1.9) {
    f.dec('rafter', cx, eaves, z, { len: rw - 0.1, scale: 1 });
  }
  f.hang('sausages', cx - 0.55, trenchZ0 + 1.0, { scale: 1.1, len: 1.6 });
  f.hang('sausages', cx + 0.55, trenchZ1 - 1.2, { scale: 1.0, len: 1.4 });
  f.hang('herbs', cx - 0.8, (trenchZ0 + trenchZ1) / 2, { scale: 1.05 });

  // --- floor: rushes everywhere, the hall is not swept
  f.scatter(['straw', 'straw', 'straw', 'straw', 'straw', 'straw', 'basket', 'crock', 'bowl', 'sack'],
    rx + 0.6, rz + 1.6, rx + rw - 0.6, rz + rd - 0.8, f.ri(16, 22));
}

/**
 * CHURCH — a nave you walk the length of. Pews either side of a central
 * aisle, columns marking the aisles off, the altar raised at the far end
 * under the only tall window in the building. The light plan is the whole
 * design: cool daylight falling on the altar, warm candles on it, and nothing
 * else bright.
 */
function furnishChurch(f: Furnisher, nave: Room, chancel: Room): void {
  const { x: rx, z: rz, w: rw, d: rd } = nave;
  const cx = rx + rw / 2;

  // --- chancel: dais, altar, candles, the great window above
  const altarZ = chancel.z + 0.95;
  f.put('dais', cx, chancel.z + chancel.d / 2, rw * 0.34, chancel.d / 2 - 0.15, 0.24);
  const altar = f.put('altar', cx, altarZ, 0.85, 0.4, 1.05);
  if (altar) {
    f.dec('candlestick', cx - 0.6, altar.aabb.maxY, altarZ, { scale: 1.35, variant: 1 });
    f.candlelight(cx + 0.6, altar.aabb.maxY, altarZ, { rich: true, scale: 1.35, radius: 6 });
    f.dec('book', cx, altar.aabb.maxY, altarZ + 0.06, { scale: 1.2, yaw: 0.1 });
  }
  // The icon sits above the altar; the great window is higher still, so the
  // two do not occupy the same patch of wall.
  f.dec('icon', cx, 1.95, chancel.z + 0.09, { scale: 1.15 });
  const great = f.win(chancel, 'z', -1, cx, 3.55, { len: 1.4, scale: 1.9, variant: 1 });
  // The shaft of light comes off the window that was actually placed, not off
  // the coordinates it was asked for: `win` pushes the head down to clear a low
  // chancel vault, and a hand-written light stayed at 3.2 m shining out of a
  // wall 60 cm below the glass. No window, no daylight.
  if (great) f.light('daylight', great[0], great[1] - 0.35, great[2] + 0.62, DAYLIGHT, 9);
  f.put('lectern', cx + (f.chance(0.5) ? -1.7 : 1.7), chancel.z + chancel.d - 0.7,
    0.28, 0.28, 1.25);
  f.put('banner', chancel.x + 0.5, chancel.z + 0.4, 0.15, 0.1, 2.8, { allowNearDoor: true });
  f.put('banner', chancel.x + chancel.w - 0.5, chancel.z + 0.4, 0.15, 0.1, 2.8, { allowNearDoor: true });

  // --- arcade piers first: they define where the pew banks can end
  const pewZ0 = chancel.z + chancel.d + 1.0;
  const pewZ1 = nave.z + rd - 2.3;
  const colRows = Math.max(2, Math.floor((pewZ1 - pewZ0) / 3.0));
  for (let i = 0; i < colRows; i++) {
    const pz = pewZ0 + 0.5 + i * ((pewZ1 - pewZ0 - 1.0) / Math.max(1, colRows - 1));
    for (const s of [-1, 1]) {
      const px = cx + s * (rw / 2 - 0.35);
      f.put('column', px, pz, 0.2, 0.2, f.ceilAt(px, pz) - 0.05, { allowNearDoor: true });
    }
  }

  // --- nave: pews in two banks between a centre aisle and two side aisles
  //
  // The outer edge is set from the piers, not from the wall: the player has to
  // be able to walk *past* an arcade pier, and 0.35 m of capsule either side
  // of it is what decides whether the side aisle is architecture or scenery.
  const aisleHalf = 0.95;
  const rows = Math.max(3, Math.floor((pewZ1 - pewZ0) / 1.15));
  const pewOuter = nave.x + 2.0;
  const pewInner = cx - aisleHalf - 0.1;
  const pewHw = (pewInner - pewOuter) / 2;
  if (pewHw > 0.45) {
    for (let i = 0; i < rows; i++) {
      const pz = pewZ0 + (i + 0.5) * ((pewZ1 - pewZ0) / rows);
      for (const s of [-1, 1]) {
        const px = cx + s * (pewHw + aisleHalf + 0.1);
        f.put('pew', px, pz, pewHw, 0.26, 0.92, { yaw: 0, variant: i & 1 });
      }
    }
  }
  f.put('rug', cx, (pewZ0 + nave.z + rd) / 2 - 0.5, aisleHalf - 0.15,
    (nave.z + rd - pewZ0) / 2, 0.03, { variant: 2 });

  // --- font by the door: the first thing you pass coming in
  const fontSide = f.chance(0.5) ? -1 : 1;
  f.put('font', cx + fontSide * (rw / 2 - 1.0), nave.z + rd - 1.5, 0.36, 0.36, 0.95);

  // --- side windows, high and narrow, alternating down the nave
  const winCount = Math.max(2, Math.floor(rd / 4));
  for (let i = 0; i < winCount; i++) {
    const wz = pewZ0 + (i + 0.5) * ((pewZ1 - pewZ0) / winCount);
    f.win(nave, 'x', -1, wz, 2.5, { len: 0.75, scale: 1.6 });
    f.win(nave, 'x', 1, wz, 2.5, { len: 0.75, scale: 1.6 });
  }

  // --- hanging censer over the aisle, a rack of votives by the door
  const ceil = f.ceilAt(cx, nave.z + rd / 2);
  f.hang('censer', cx, chancel.z + chancel.d + 1.6, { scale: 1.1 });
  f.hang('chandelier', cx, nave.z + rd * 0.55, { scale: 1.05, variant: 1 });
  f.dec('beam', cx, ceil - 0.14, nave.z + rd * 0.3, { len: rw - 0.1 });
  f.dec('beam', cx, ceil - 0.14, nave.z + rd * 0.75, { len: rw - 0.1 });

  // --- quiet evidence of use: a dropped candle, worn kneelers, swept rushes
  f.scatter(['basket', 'straw', 'straw'],
    rx + 0.8, pewZ1 + 0.3, rx + rw - 0.8, nave.z + rd - 0.9, f.ri(2, 4),
    { scale: [0.8, 1.0] });
}

/**
 * SMITHY — everything faces the forge. The forge is on the far wall with its
 * hood and bellows, the anvil stands in front of it in clear space (you need
 * to be able to swing), the quench trough is a step from the anvil, and the
 * tool wall is within arm's reach. It is the darkest interior in the game:
 * the forge is effectively the only light.
 */
function furnishSmithy(f: Furnisher, main: Room): void {
  const { x: rx, z: rz, w: rw, d: rd } = main;
  const cx = rx + rw / 2;
  const ceil = f.ceilAt(cx, rz + rd / 2);

  // --- forge against the far wall, offset so the anvil has room
  const fx = rx + rw * 0.36;
  const forge = f.put('forge', fx, rz + 0.72, 0.85, 0.62, 1.15);
  if (forge) {
    f.light('forge', fx, 0.95, rz + 0.95, FORGE_C, 8);
    f.dec('coalpile', fx + 0.95, 0, rz + 0.5, { scale: 1.1 });
    f.dec('ingots', fx - 0.95, 0, rz + 0.55, { scale: 1 });
  }
  f.put('bellows', fx - 1.35, rz + 0.85, 0.34, 0.55, 0.95, { yaw: 0 });
  f.put('coalbin', fx + 1.5, rz + 0.75, 0.42, 0.45, 0.7);

  // --- anvil on its stump, in clear floor in front of the forge
  const ax = fx + f.r(-0.2, 0.3);
  const az = rz + 2.35;
  f.put('anvil', ax, az, 0.36, 0.24, 0.82, { yaw: f.r(-0.2, 0.2) });
  f.put('quench', ax + 1.25, az + 0.35, 0.34, 0.34, 0.62, { variant: 1 });
  f.dec('horseshoes', ax - 1.15, 0, az + 0.25, { scale: 1 });

  // --- workbench and grindstone down one side
  const right = f.chance(0.5);
  const wx = right ? rx + rw - 0.55 : rx + 0.55;
  const bench = f.put('workbench', wx, rz + rd * 0.45, 0.44, 1.15, 0.92,
    { yaw: right ? Math.PI / 2 : -Math.PI / 2 });
  if (bench) {
    f.clutter(bench, ['ingots', 'horseshoes', 'bowl', 'crock', 'book'], f.ri(3, 5), 0.2);
    f.candlelight(wx, bench.aabb.maxY, rz + rd * 0.45 - 0.8, { scale: 0.95, radius: 3.4 });
    f.dec('wallshelf', right ? rx + rw - 0.1 : rx + 0.1, 1.55, rz + rd * 0.45,
      { yaw: right ? Math.PI / 2 : -Math.PI / 2, len: 1.6 });
  }
  f.put('grindstone', right ? rx + 0.7 : rx + rw - 0.7, rz + rd * 0.55, 0.42, 0.32, 0.85,
    { yaw: right ? -Math.PI / 2 : Math.PI / 2 });

  // --- tool wall and finished work racked by the door
  f.put('toolrack', right ? rx + 0.5 : rx + rw - 0.5, rz + 1.6, 0.16, 0.6, 1.9,
    { yaw: right ? -Math.PI / 2 : Math.PI / 2 });
  f.put('weaponrack', right ? rx + rw - 0.5 : rx + 0.5, rz + rd - 1.5, 0.2, 0.62, 1.5,
    { yaw: right ? Math.PI / 2 : -Math.PI / 2 });
  f.put('barrel', rx + rw - 0.62, rz + rd - 0.85, 0.3, 0.3, 0.9, { allowNearDoor: true });
  f.put('crate', rx + 0.62, rz + rd - 0.85, 0.34, 0.34, 0.58, { allowNearDoor: true });

  // --- overhead: the chimney hood is part of the forge mesh; hang stock
  f.beams(rx + 0.05, rz + 1.4, rx + rw - 0.05, rz + rd - 0.05, ceil - 0.16, 2.2);
  f.hang('lantern', cx, rz + rd * 0.62, { scale: 0.95 }); // unlit: the forge owns the room
  f.win(main, 'x', -1, rz + rd * 0.72, 1.9, { len: 0.9 });
  f.win(main, 'x', 1, rz + rd * 0.72, 1.9, { len: 0.9 });

  // --- the floor of a working smithy: soot, offcuts, water
  f.scatter(['coalpile', 'ingots', 'horseshoes', 'bucket', 'firewood'],
    rx + 0.7, rz + 1.3, rx + rw - 0.7, rz + rd - 1.0, f.ri(5, 8), { scale: [0.75, 1.05] });
  f.dec('bucket', ax + 0.4, 0, az - 0.9, { scale: 1 });
}

/**
 * BARN — two rows of stalls off a central threshing floor, a hay loft over
 * one end that you look up into, and the tools of the year hung on the walls.
 * The only light is a lantern and what comes through the gable window, which
 * is what a barn actually feels like.
 */
function furnishBarn(f: Furnisher, main: Room, loft: Room | null): void {
  const { x: rx, z: rz, w: rw, d: rd } = main;
  const cx = rx + rw / 2;
  const ceil = f.ceilAt(cx, rz + rd / 2);

  // --- stalls down both sides, divided by half-height partitions
  const stalls = Math.max(2, Math.floor((rd - 3.5) / 2.3));
  for (const side of [0, 1]) {
    const px = side === 0 ? rx + 0.85 : rx + rw - 0.85;
    for (let i = 0; i < stalls; i++) {
      const z0 = rz + 1.2 + i * ((rd - 3.2) / stalls);
      const len = (rd - 3.2) / stalls;
      // Divider between stalls (a real collider: you walk down the middle).
      f.put('trough', px, z0 + 0.12, 0.62, 0.14, 1.15,
        { yaw: side === 0 ? -Math.PI / 2 : Math.PI / 2, variant: 3 });
      // Feed trough against the wall.
      f.put('trough', side === 0 ? rx + 0.42 : rx + rw - 0.42, z0 + len / 2,
        0.3, len / 2 - 0.3, 0.55, { yaw: side === 0 ? -Math.PI / 2 : Math.PI / 2 });
      f.dec('straw', px + f.r(-0.3, 0.3), 0, z0 + len / 2 + f.r(-0.4, 0.4),
        { scale: f.r(1.1, 1.5), yaw: f.r(0, 6) });
    }
  }

  // --- hay stacked at the far end, bales that read as a climbable mass
  for (let i = 0; i < 5; i++) {
    const hx = rx + 0.9 + f.rng() * (rw - 1.8);
    const hz = rz + 0.6 + f.rng() * 1.0;
    f.put('haybale', hx, hz, 0.46, 0.34, f.chance(0.4) ? 1.15 : 0.58,
      { yaw: f.r(-0.3, 0.3), variant: f.ri(0, 3) });
  }

  // --- working floor: cart wheel, pitchfork, sacks of grain
  f.dec('wheel', rx + rw - 1.1, 0, rz + rd * 0.62, { yaw: 0.2, scale: 1.1 });
  f.dec('pitchfork', rx + 1.0, 0, rz + rd * 0.5, { yaw: 0.25, scale: 1 });
  f.put('sacks', cx + f.r(-0.8, 0.8), rz + rd - 1.6, 0.5, 0.4, 0.6);
  f.put('barrel', rx + 0.7, rz + rd - 1.0, 0.3, 0.3, 0.9, { allowNearDoor: true });
  f.put('crate', rx + rw - 0.75, rz + rd - 1.0, 0.36, 0.36, 0.6, { allowNearDoor: true });

  // --- loft: a platform you look up into, stacked with the harvest
  if (loft) {
    const lc = f.ceilAt(loft.x + 0.5, loft.z + 0.5);
    f.dec('loft', loft.x + loft.w / 2, lc, loft.z + loft.d / 2,
      { len: loft.w, scale: loft.d });
    f.put('ladder', loft.x + 0.5, loft.z + loft.d - 0.45, 0.24, 0.22, lc + 0.25);
    for (let i = 0; i < 5; i++) {
      f.dec('sack', loft.x + 0.5 + f.rng() * (loft.w - 1), lc + 0.13,
        loft.z + 0.5 + f.rng() * (loft.d - 1), { scale: f.r(0.9, 1.15), yaw: f.r(0, 6) });
    }
    f.dec('straw', loft.x + loft.w * 0.6, lc + 0.13, loft.z + loft.d * 0.4, { scale: 1.6 });
  }

  // --- overhead and walls
  for (let z = rz + 1.2; z < rz + rd - 0.6; z += 2.0) {
    f.dec('rafter', cx, ceil, z, { len: rw - 0.1, scale: 1 });
  }
  f.lanternlight(cx, rz + rd * 0.55, 1.05, 7);
  // Under the hay loft the ceiling is 2.15 m, so this asks for 2.9 and takes
  // whatever fits — and if the loft leaves no wall at all, the barn gets no
  // gable window and no daylight rather than one inside the loft floor.
  const gable = f.win(main, 'z', -1, cx, 2.9, { len: 1.1, scale: 1.5 });
  if (gable) f.light('daylight', gable[0], gable[1] - 0.3, gable[2] + 0.92, DAYLIGHT, 8);
  f.wallRow(['pelt', 'wallshelf'], rx + 0.12, rz + rd * 0.3, rx + 0.12, rz + rd * 0.8,
    1.6, 2, -Math.PI / 2);

  // --- straw everywhere, because it is a barn
  f.scatter(['straw', 'straw', 'straw', 'straw', 'basket', 'bucket', 'sack'],
    rx + 0.7, rz + 1.0, rx + rw - 0.7, rz + rd - 0.8, f.ri(12, 16));
}

/**
 * GUARDHOUSE — a duty room. Bunks against one wall, a table where the watch
 * plays away a shift, weapons racked by the door, and a brazier for warmth.
 * Small, cramped and functional; nothing decorative except the shields.
 */
function furnishGuardhouse(f: Furnisher, main: Room): void {
  const { x: rx, z: rz, w: rw, d: rd } = main;
  const cx = rx + rw / 2;
  const ceil = f.ceilAt(cx, rz + rd / 2);

  // --- bunks stacked against one long wall
  const left = f.chance(0.5);
  const bx = left ? rx + 0.72 : rx + rw - 0.72;
  const bunkCount = Math.max(2, Math.floor((rd - 2.4) / 2.1));
  for (let i = 0; i < bunkCount; i++) {
    const bz = rz + 1.3 + (i + 0.5) * ((rd - 2.8) / bunkCount);
    const bunk = f.put('bunk', bx, bz, 0.65, 0.95, 1.75,
      { yaw: left ? 0 : Math.PI, variant: i & 1 });
    if (bunk) {
      f.dec('bedroll', bx, 0.52, bz + f.r(-0.2, 0.2), { yaw: left ? 0 : Math.PI, scale: 1 });
      if (f.chance(0.6)) f.floorDec('boots', bx + (left ? 0.85 : -0.85), bz + 0.5, { yaw: f.r(0, 3), scale: 0.9 });
    }
  }

  // --- table with a game abandoned mid-shift
  const tx = left ? rx + rw - 1.25 : rx + 1.25;
  const table = f.put('table', tx, rz + rd * 0.42, 0.55, 0.48, 0.76, { yaw: f.r(-0.15, 0.15) });
  if (table) {
    f.clutter(table, ['mug', 'mug', 'bowl', 'bottle', 'ledger'], f.ri(3, 5));
    f.candlelight(tx + 0.2, table.aabb.maxY, rz + rd * 0.42 - 0.15, { scale: 0.95, radius: 4.2 });
    for (const [ox, oz] of [[-0.85, 0.1], [0.85, -0.15], [0, 0.85]] as [number, number][]) {
      if (f.chance(0.75)) f.put('stool', tx + ox, rz + rd * 0.42 + oz, 0.19, 0.19, 0.5, { yaw: f.r(0, 6) });
    }
  }

  // --- brazier for warmth, weapons by the door
  const brz = f.put('brazier', left ? rx + rw - 0.7 : rx + 0.7, rz + 0.85, 0.32, 0.32, 1.0);
  if (brz) f.light('brazier', brz.aabb.minX + 0.32, 1.12, rz + 0.85, FIRE, 6);
  f.put('weaponrack', cx, rz + 0.45, rw * 0.26, 0.2, 1.55);
  f.put('crate', left ? rx + rw - 0.72 : rx + 0.72, rz + rd - 1.0, 0.34, 0.34, 0.6,
    { allowNearDoor: true });
  f.put('barrel', left ? rx + 0.7 : rx + rw - 0.7, rz + rd - 1.0, 0.3, 0.3, 0.9,
    { allowNearDoor: true });

  // --- fittings
  f.wallRow(['shield', 'cloak', 'shield'], rx + 0.12, rz + 1.4, rx + 0.12, rz + rd - 1.4,
    1.65, 2, -Math.PI / 2);
  f.wallRow(['shield', 'cloak'], rx + rw - 0.12, rz + 1.4, rx + rw - 0.12, rz + rd - 1.4,
    1.65, 2, Math.PI / 2);
  f.beams(rx + 0.05, rz + 0.05, rx + rw - 0.05, rz + rd - 0.05, ceil - 0.16, 2.0);
  f.win(main, 'x', -1, rz + rd * 0.28, 1.85, { len: 0.55, scale: 1.2 });
  f.win(main, 'x', 1, rz + rd * 0.28, 1.85, { len: 0.55, scale: 1.2 });
  f.scatter(['straw', 'bucket', 'sack', 'firewood'],
    rx + 0.7, rz + 1.2, rx + rw - 0.7, rz + rd - 0.9, f.ri(4, 6));
}

/**
 * KEEP — a great hall you cross to reach the throne, plus a guard room off
 * the side. The braziers are placed to light the approach rather than the
 * room, so the walk up the carpet is the composition.
 */
function furnishKeep(f: Furnisher, hall: Room, dais: Room, guard: Room | null): void {
  const cx = hall.x + hall.w / 2;
  const ceil = f.ceilAt(cx, hall.z + hall.d / 2);

  // --- throne on a stepped dais at the far end
  f.put('dais', cx, dais.z + dais.d / 2, dais.w * 0.42, dais.d / 2 - 0.2, 0.3);
  const throne = f.put('throne', cx, dais.z + 0.95, 0.62, 0.55, 2.0);
  if (throne) {
    f.put('banner', cx - 1.9, dais.z + 0.35, 0.17, 0.11, 3.0, { allowNearDoor: true });
    f.put('banner', cx + 1.9, dais.z + 0.35, 0.17, 0.11, 3.0, { allowNearDoor: true });
    f.dec('pelt', cx, 0.31, dais.z + 1.85, { scale: 1.4, variant: 1 });
  }
  // Braziers flank the approach, not the throne — they light the walk.
  for (const s of [-1, 1]) {
    const bx = cx + s * (hall.w * 0.26);
    const bz = dais.z + dais.d + 1.4;
    const b = f.put('brazier', bx, bz, 0.34, 0.34, 1.05);
    if (b) f.light('brazier', bx, 1.18, bz, FIRE, 6.5);
  }
  f.put('rug', cx, hall.z + hall.d * 0.55, 1.15, hall.d * 0.3, 0.03, { variant: 2 });

  // --- feast table down the hall with the remains of a meal
  const t = f.put('table', cx, hall.z + hall.d * 0.45, hall.w * 0.3, 0.5, 0.78, { variant: 1 });
  if (t) {
    f.clutter(t, ['mug', 'bowl', 'plate', 'jug', 'loaf', 'cheese', 'bottle'], f.ri(6, 9));
    f.dec('candlestick', cx - hall.w * 0.16, t.aabb.maxY, hall.z + hall.d * 0.45, { scale: 1.2, variant: 1 });
    f.dec('candlestick', cx + hall.w * 0.16, t.aabb.maxY, hall.z + hall.d * 0.45, { scale: 1.2, variant: 1 });
    for (const s of [-1, 1]) {
      f.put('bench', cx, hall.z + hall.d * 0.45 + s * 0.82, hall.w * 0.28, 0.22, 0.46);
    }
  }

  // --- hearth on a side wall
  const hSide = f.chance(0.5) ? -1 : 1;
  const hx = cx + hSide * (hall.w / 2 - 0.55);
  const hearth = f.put('hearth', hx, hall.z + hall.d * 0.72, 0.5, 0.85, 1.6,
    { yaw: hSide < 0 ? -Math.PI / 2 : Math.PI / 2 });
  if (hearth) f.light('hearth', hx - hSide * 0.4, 0.48, hall.z + hall.d * 0.72, FIRE, 8);

  // --- guard room off the hall
  if (guard) {
    const g = guard;
    for (let i = 0; i < 2; i++) {
      f.put('bunk', g.x + 0.72, g.z + 1.2 + i * 2.0, 0.6, 0.9, 1.7, { variant: i & 1 });
      f.dec('bedroll', g.x + 0.72, 0.52, g.z + 1.2 + i * 2.0, { scale: 1 });
    }
    f.put('weaponrack', g.x + g.w - 0.5, g.z + g.d * 0.5, 0.18, 0.6, 1.55, { yaw: Math.PI / 2 });
    f.put('crate', g.x + g.w - 0.8, g.z + 0.7, 0.34, 0.34, 0.6);
    f.put('barrel', g.x + g.w - 0.75, g.z + g.d - 0.8, 0.3, 0.3, 0.9);
    f.win(g, 'x', 1, g.z + g.d * 0.35, 1.8, { len: 0.7 });
    f.scatter(['straw', 'bucket', 'sack'], g.x + 0.6, g.z + 0.6, g.x + g.w - 0.6, g.z + g.d - 0.6, 3);
  }

  // --- height: banners high on the walls, a chandelier over the table
  f.hang('chandelier', cx, hall.z + hall.d * 0.45, { scale: 1.4, variant: 1 });
  f.beams(hall.x + 0.05, hall.z + 0.05, hall.x + hall.w - 0.05, hall.z + hall.d - 0.05,
    ceil - 0.2, 2.6);
  f.wallRow(['shield', 'pelt', 'antlers'], hall.x + 0.12, hall.z + 1.6,
    hall.x + 0.12, hall.z + hall.d - 1.6, 2.3, 3, -Math.PI / 2, 1.15);
  f.wallRow(['shield', 'antlers', 'pelt'], hall.x + hall.w - 0.12, hall.z + 1.6,
    hall.x + hall.w - 0.12, hall.z + hall.d - 1.6, 2.3, 3, Math.PI / 2, 1.15);
  for (let i = 0; i < 3; i++) {
    const wz = hall.z + hall.d * (0.28 + i * 0.24);
    f.win(hall, 'x', -1, wz, 3.4, { len: 0.8, scale: 1.8 });
    f.win(hall, 'x', 1, wz, 3.4, { len: 0.8, scale: 1.8 });
  }
  f.scatter(['straw', 'firewood', 'basket'],
    hall.x + 0.8, hall.z + hall.d * 0.6, hall.x + hall.w - 0.8, hall.z + hall.d - 0.9, f.ri(3, 6));
}

// =========================================================================
//  Main entry point
// =========================================================================

export function generateBuildingInterior(
  spec: BuildingInteriorSpec,
  seed: number,
): BuildingInterior {
  const rng = mulberry32(mix32(seed, spec.buildingIndex, 0xb17d1a9));
  const size = KIND_SIZE[spec.kind] ?? KIND_SIZE.house;

  const intW = clamp(Math.round(spec.width * FOOTPRINT_SCALE), size.minW, size.maxW);
  const intD = clamp(Math.round(spec.depth * FOOTPRINT_SCALE), size.minD, size.maxD);
  const ceil = size.ceil;

  // Grid: interior starts at (1,1) inside a 1-cell solid border.
  const gridW = intW + 2;
  const gridD = intD + 2;
  const g = makeGrid(gridW, gridD);
  carveRect(g, 1, 1, intW, intD, ceil);

  const rooms: Room[] = [];
  let gable: GableSpec | null = null;
  const full: Room = { x: 1, z: 1, w: intW, d: intD, label: spec.kind };

  // --- per-kind carving: partitions, ceiling shape, room rects -------------
  let furnish: (f: Furnisher) => void;

  switch (spec.kind) {
    case 'house': {
      // Bed alcove across the back third of one side, behind a stub wall
      // with a doorway. Lower ceiling under it; the loft lives above.
      let alcove: Room | null = null;
      if (intW >= 7 && intD >= 8) {
        const aw = Math.max(3, Math.floor(intW * 0.42));
        const ad = Math.max(3, Math.floor(intD * 0.38));
        const ax = rng() < 0.5 ? 1 : 1 + intW - aw;
        const az = 1 + intD - ad;
        // Partition: a wall along the alcove's inner long edge with a gap.
        const wallX = ax === 1 ? 1 + aw : ax - 1;
        for (let z = az; z < az + ad; z++) {
          if (z >= az + ad - 1) continue; // doorway nearest the entrance
          g.cells[z * gridW + wallX] = CELL_SOLID;
          g.ceilY[z * gridW + wallX] = 0;
        }
        alcove = {
          x: ax === 1 ? 1 : wallX + 1, z: az,
          w: ax === 1 ? aw : intW + 1 - (wallX + 1), d: ad, label: 'alcove',
        };
        setCeil(g, alcove.x, alcove.z, alcove.w, alcove.d, 2.05);
        rooms.push({ x: 1, z: 1, w: intW, d: intD, label: 'hearth room' });
        rooms.push(alcove);
      } else {
        rooms.push(full);
      }
      const a = alcove;
      furnish = (f) => furnishHouse(f, { ...full, label: 'main' }, a);
      break;
    }

    case 'shop': {
      // Store room walled off across the back, reachable only by the eye.
      let store: Room | null = null;
      if (intD >= 8) {
        const sd = 2;
        store = { x: 1, z: 1, w: intW, d: sd, label: 'store' };
        const wallZ = 1 + sd;
        for (let x = 1; x <= intW; x++) {
          g.cells[wallZ * gridW + x] = CELL_SOLID;
          g.ceilY[wallZ * gridW + x] = 0;
        }
        // A serving hatch: one open cell so the store room is visible.
        const hatchX = 1 + Math.floor(intW / 2);
        g.cells[wallZ * gridW + hatchX] = CELL_FLOOR;
        g.ceilY[wallZ * gridW + hatchX] = ceil;
        setCeil(g, 1, 1, intW, sd, 2.4);
        rooms.push(store);
        rooms.push({ x: 1, z: wallZ + 1, w: intW, d: intD - sd - 1, label: 'shop floor' });
      } else {
        rooms.push(full);
      }
      const mainRoom: Room = store
        ? { x: 1, z: 1 + store.d + 1, w: intW, d: intD - store.d - 1, label: 'main' }
        : { ...full, label: 'main' };
      const s = store;
      furnish = (f) => furnishShop(f, mainRoom, s);
      break;
    }

    case 'tavern': {
      // Guest room walled into a back corner with its own doorway.
      let guest: Room | null = null;
      if (intW >= 10 && intD >= 9) {
        const gw = Math.max(3, Math.floor(intW * 0.34));
        const gd = Math.max(3, Math.floor(intD * 0.32));
        const gx = rng() < 0.5 ? 1 : 1 + intW - gw;
        const gz = 1;
        const wallX = gx === 1 ? 1 + gw : gx - 1;
        for (let z = gz; z < gz + gd; z++) {
          g.cells[z * gridW + wallX] = CELL_SOLID;
          g.ceilY[z * gridW + wallX] = 0;
        }
        const wallZ = gz + gd;
        for (let x = (gx === 1 ? 1 : wallX); x <= (gx === 1 ? wallX : intW); x++) {
          g.cells[wallZ * gridW + x] = CELL_SOLID;
          g.ceilY[wallZ * gridW + x] = 0;
        }
        // Doorway into the guest room from the common room.
        const doorX = gx === 1 ? 1 + Math.floor(gw / 2) : intW - Math.floor(gw / 2);
        g.cells[wallZ * gridW + doorX] = CELL_FLOOR;
        g.ceilY[wallZ * gridW + doorX] = 2.3;
        guest = { x: gx === 1 ? 1 : wallX + 1, z: gz, w: gw, d: gd, label: 'guest room' };
        setCeil(g, guest.x, guest.z, guest.w, guest.d, 2.5);
        rooms.push(guest);
      }
      const common: Room = guest
        ? (guest.x === 1
          ? { x: 1 + guest.w + 1, z: 1, w: intW - guest.w - 1, d: intD, label: 'common room' }
          : { x: 1, z: 1, w: intW - guest.w - 1, d: intD, label: 'common room' })
        : { ...full, label: 'common room' };
      rooms.push(common);
      const gr = guest;
      furnish = (f) => furnishTavern(f, common, gr);
      break;
    }

    case 'longhouse': {
      // One hall, gabled along its length, eaves low and ridge high.
      setCeil(g, 1, 1, intW, intD, 2.55);
      gable = { x0: 1, z0: 1, x1: 1 + intW, z1: 1 + intD, eaves: 2.55, ridge: 4.6, axis: 'z' };
      rooms.push({ ...full, label: 'hall' });
      furnish = (f) => furnishLonghouse(f, { ...full, label: 'hall' });
      break;
    }

    case 'church': {
      // Chancel (raised, tall) at -Z; nave the length of the building with
      // lower side aisles giving the nave its clerestory step.
      const chancelD = Math.max(3, Math.floor(intD * 0.24));
      const chancel: Room = { x: 1, z: 1, w: intW, d: chancelD, label: 'chancel' };
      const nave: Room = { x: 1, z: 1, w: intW, d: intD, label: 'nave' };
      setCeil(g, 1, 1, intW, intD, ceil);
      setCeil(g, 1, 1, 1, intD, ceil - 1.3);          // west aisle
      setCeil(g, intW, 1, 1, intD, ceil - 1.3);       // east aisle
      setCeil(g, 1, 1, intW, chancelD, ceil + 0.5);   // chancel is tallest
      rooms.push(chancel, { x: 1, z: 1 + chancelD, w: intW, d: intD - chancelD, label: 'nave' });
      furnish = (f) => furnishChurch(f, nave, chancel);
      break;
    }

    case 'smithy': {
      setCeil(g, 1, 1, intW, intD, 2.75);
      rooms.push({ ...full, label: 'forge floor' });
      furnish = (f) => furnishSmithy(f, { ...full, label: 'forge floor' });
      break;
    }

    case 'barn': {
      // Hay loft over the far third: ceiling drops under it.
      let loft: Room | null = null;
      if (intD >= 9) {
        const ld = Math.max(3, Math.floor(intD * 0.3));
        loft = { x: 1, z: 1, w: intW, d: ld, label: 'hay loft' };
        setCeil(g, 1, 1, intW, ld, 2.15);
        rooms.push(loft);
      }
      setCeil(g, 1, 1 + (loft?.d ?? 0), intW, intD - (loft?.d ?? 0), 3.3);
      gable = {
        x0: 1, z0: 1 + (loft?.d ?? 0), x1: 1 + intW, z1: 1 + intD,
        eaves: 3.3, ridge: 4.8, axis: 'z',
      };
      rooms.push({ x: 1, z: 1 + (loft?.d ?? 0), w: intW, d: intD - (loft?.d ?? 0), label: 'threshing floor' });
      const l = loft;
      furnish = (f) => furnishBarn(f, { ...full, label: 'barn' }, l);
      break;
    }

    case 'guardhouse': {
      setCeil(g, 1, 1, intW, intD, 2.85);
      rooms.push({ ...full, label: 'duty room' });
      furnish = (f) => furnishGuardhouse(f, { ...full, label: 'duty room' });
      break;
    }

    case 'keep':
    default: {
      const daisD = Math.max(3, Math.floor(intD * 0.28));
      const dais: Room = { x: 1, z: 1, w: intW, d: daisD, label: 'throne' };
      let guard: Room | null = null;
      if (intW >= 12) {
        // Four cells wide minimum: a three-cell room with a bunk down one side
        // and a rack down the other leaves 0.3 m of floor, which is a room the
        // player can see into and never enter.
        const gw = Math.max(4, Math.floor(intW * 0.28));
        const gd = Math.max(4, Math.floor(intD * 0.34));
        const gx = rng() < 0.5 ? 1 : 1 + intW - gw;
        const gz = 1 + intD - gd;
        const wallX = gx === 1 ? 1 + gw : gx - 1;
        for (let z = gz + 1; z < gz + gd; z++) {
          g.cells[z * gridW + wallX] = CELL_SOLID;
          g.ceilY[z * gridW + wallX] = 0;
        }
        guard = { x: gx === 1 ? 1 : wallX + 1, z: gz, w: gx === 1 ? gw : intW + 1 - (wallX + 1), d: gd, label: 'guard' };
        setCeil(g, guard.x, guard.z, guard.w, guard.d, 3.0);
        rooms.push(guard);
      }
      const hall: Room = guard && guard.x === 1
        ? { x: 1 + guard.w + 1, z: 1, w: intW - guard.w - 1, d: intD, label: 'hall' }
        : guard
          ? { x: 1, z: 1, w: intW - guard.w - 1, d: intD, label: 'hall' }
          : { ...full, label: 'hall' };
      rooms.push(dais, hall);
      const gr = guard;
      furnish = (f) => furnishKeep(f, hall, { ...dais, x: hall.x, w: hall.w }, gr);
      break;
    }
  }

  // --- door: always the +Z wall of the room the player walks into ----------
  const doorRoom = rooms.find((r) => r.label === 'common room' || r.label === 'hall'
    || r.label === 'main' || r.label === 'shop floor' || r.label === 'threshing floor')
    ?? full;
  const doorX = spec.kind === 'shop' || spec.kind === 'tavern' || spec.kind === 'keep'
    ? doorRoom.x : full.x;
  const doorW = spec.kind === 'shop' || spec.kind === 'tavern' || spec.kind === 'keep'
    ? doorRoom.w : full.w;
  const door = placeSouthDoor(g, doorX, doorW, intD + 1, ceil);

  // --- the player must be able to move the instant they arrive -------------
  // The door sits at the middle of a wall and a partition can land within the
  // player's radius of it. The collider rejects a move when *any* cell inside
  // the radius box is solid, so a spawn half a metre from a partition corner
  // is wedged solid: every direction is refused. Snap to the nearest point the
  // collider would actually accept before anything is placed.
  const walk = new WalkMap(g);
  if (!walk.standable(door.spawn[0], door.spawn[2])) {
    const snapped = walk.nearestStandable(door.spawn[0], door.spawn[2]);
    if (snapped !== null) {
      door.spawn = [snapped[0], 0, snapped[1]];
    }
  }

  // --- furnish -------------------------------------------------------------
  const f = new Furnisher(g, rng, door.cells, door.spawn, gable);
  furnish(f);

  // --- keep the interior walkable ------------------------------------------
  // Anything that isolates part of the floor gets removed. Getting wedged is
  // worse than a missing barrel, and this is the only guarantee that a random
  // combination of props has not walled the player into the doorway.
  pruneUnreachable(walk, f, door.spawn);
  ensureRoomsReachable(walk, f, door.spawn, rooms);

  // --- lights: hard budget, most important first ---------------------------
  const lights = trimLights(f.lights, door.spawn);

  // --- colliders: perimeter + partitions + furniture ------------------------
  const colliders: AABB[] = [];
  for (let z = 0; z < gridD; z++) {
    for (let x = 0; x < gridW; x++) {
      if (g.cells[z * gridW + x] !== CELL_SOLID) continue;
      // Only emit wall colliders that border floor — interior fill is unseen.
      const borders =
        (x > 0 && g.cells[z * gridW + x - 1] !== CELL_SOLID) ||
        (x < gridW - 1 && g.cells[z * gridW + x + 1] !== CELL_SOLID) ||
        (z > 0 && g.cells[(z - 1) * gridW + x] !== CELL_SOLID) ||
        (z < gridD - 1 && g.cells[(z + 1) * gridW + x] !== CELL_SOLID);
      if (!borders) continue;
      colliders.push({ minX: x, minY: 0, minZ: z, maxX: x + 1, maxY: ceil, maxZ: z + 1 });
    }
  }
  for (const fu of f.furniture) {
    if (fu.type === 'rug' || fu.type === 'dais') continue;
    colliders.push({ ...fu.aabb });
  }

  let maxCeil = 0;
  for (let i = 0; i < g.ceilY.length; i++) if (g.ceilY[i] > maxCeil) maxCeil = g.ceilY[i];
  if (gable) maxCeil = Math.max(maxCeil, gable.ridge);

  return {
    spec,
    ceilHeight: maxCeil,
    gridW,
    gridD,
    cells: g.cells,
    ceilY: g.ceilY,
    doorCells: door.cells,
    spawnPoint: door.spawn,
    exitZone: door.exitZone,
    furniture: f.furniture,
    decor: f.decor,
    colliders,
    lights,
    rooms,
    gable,
  };
}

/**
 * Whole 1 m floor cells the player can actually stand in and walk to from the
 * spawn. Chest placement uses this so loot never ends up behind a counter the
 * player can only look over.
 */
export function reachableFloorCells(interior: BuildingInterior): [number, number][] {
  const g: Grid = {
    w: interior.gridW, d: interior.gridD,
    cells: interior.cells, ceilY: interior.ceilY,
  };
  const walk = new WalkMap(g);
  const blockers = interior.furniture
    .filter((f) => f.type !== 'rug' && f.type !== 'dais')
    .map((f) => f.aabb);
  const free = walk.freeWith(blockers);
  const sw = walk.sw;
  const reach = walk.floodMask(free, interior.spawnPoint[0], interior.spawnPoint[2]);
  const out: [number, number][] = [];
  for (let z = 0; z < interior.gridD; z++) {
    for (let x = 0; x < interior.gridW; x++) {
      if (interior.cells[z * interior.gridW + x] !== CELL_FLOOR) continue;
      // The cell centre must be standable and connected.
      const i = Math.floor((x + 0.5) * SUB), j = Math.floor((z + 0.5) * SUB);
      if (reach[j * sw + i]) out.push([x, z]);
    }
  }
  return out;
}

// ---- post-passes ----------------------------------------------------------

/**
 * Drop furniture that makes floor unreachable from the spawn. Runs the full
 * flood fill once for the baseline, then re-tests with each *candidate*
 * removed only when the baseline lost ground — the common case costs one fill.
 */
function pruneUnreachable(walk: WalkMap, f: Furnisher, spawn: readonly [number, number, number]): void {
  // A piece the player spawns inside would wedge them solid — clear those first.
  for (let i = f.furniture.length - 1; i >= 0; i--) {
    const a = f.furniture[i].aabb;
    if (a.maxY <= 0.3) continue;
    if (spawn[0] + PLAYER_R > a.minX && spawn[0] - PLAYER_R < a.maxX &&
        spawn[2] + PLAYER_R > a.minZ && spawn[2] - PLAYER_R < a.maxZ) {
      f.furniture.splice(i, 1);
    }
  }

  const blockers = (skip = -1): AABB[] => {
    const out: AABB[] = [];
    for (let i = 0; i < f.furniture.length; i++) {
      if (i === skip) continue;
      const t = f.furniture[i].type;
      if (t === 'rug' || t === 'dais') continue;
      out.push(f.furniture[i].aabb);
    }
    return out;
  };

  /**
   * Structure the layout is *about* never gets pruned — losing the forge to
   * save a corner of floor would be the wrong trade. Everything else is
   * expendable, newest first (later placements are the incidental clutter).
   */
  const STRUCTURAL = new Set<FurnitureType>([
    'hearth', 'firetrench', 'forge', 'altar', 'throne', 'counter', 'bed',
    'bunk', 'sleepbench', 'anvil', 'font', 'column', 'ladder', 'banner',
  ]);

  let free = walk.freeWith(blockers());
  let freeCount = WalkMap.count(free);
  let reach = walk.flood(free, spawn[0], spawn[2]);

  // A little stranding is fine (the nook behind a shop counter is deliberate);
  // more than a fifth of the standable floor cut off is a real blockage.
  let guard = 0;
  while (reach < freeCount * 0.8 && guard++ < 10) {
    let bestIdx = -1;
    let bestGain = 0;
    for (let i = f.furniture.length - 1; i >= 0; i--) {
      const fu = f.furniture[i];
      if (fu.type === 'rug' || fu.type === 'dais' || STRUCTURAL.has(fu.type)) continue;
      const gain = walk.flood(walk.freeWith(blockers(i)), spawn[0], spawn[2]) - reach;
      if (gain > bestGain) { bestGain = gain; bestIdx = i; }
    }
    if (bestIdx < 0) break;
    f.furniture.splice(bestIdx, 1);
    free = walk.freeWith(blockers());
    freeCount = WalkMap.count(free);
    reach = walk.flood(free, spawn[0], spawn[2]);
  }
}

/**
 * A whole-room check on top of the area ratio. A side room is only a few
 * percent of the floor, so it can be sealed off completely without the ratio
 * pass noticing — and a room the player can see into but never enter is the
 * single most obvious way an interior reads as broken.
 */
function ensureRoomsReachable(
  walk: WalkMap, f: Furnisher,
  spawn: readonly [number, number, number],
  rooms: readonly Room[],
): void {
  const solid = (skip = -1): AABB[] => {
    const out: AABB[] = [];
    for (let i = 0; i < f.furniture.length; i++) {
      if (i === skip) continue;
      const t = f.furniture[i].type;
      if (t === 'rug' || t === 'dais') continue;
      out.push(f.furniture[i].aabb);
    }
    return out;
  };
  const reachedIn = (free: Uint8Array, r: Room): boolean => {
    // Flood once, then look for any reached sub-cell inside the room rect.
    const mask = walk.floodMask(free, spawn[0], spawn[2]);
    for (let j = Math.floor(r.z * SUB); j < (r.z + r.d) * SUB; j++) {
      for (let i = Math.floor(r.x * SUB); i < (r.x + r.w) * SUB; i++) {
        if (mask[j * walk.sw + i]) return true;
      }
    }
    return false;
  };

  for (const room of rooms) {
    if (room.w < 2 || room.d < 2) continue;
    let tries = 0;
    while (!reachedIn(walk.freeWith(solid()), room) && tries++ < 5) {
      // Remove whichever piece inside the room opens it up the most.
      let bestIdx = -1;
      let bestGain = 0;
      for (let i = f.furniture.length - 1; i >= 0; i--) {
        const a = f.furniture[i].aabb;
        const t = f.furniture[i].type;
        if (t === 'rug' || t === 'dais') continue;
        const cx = (a.minX + a.maxX) / 2, cz = (a.minZ + a.maxZ) / 2;
        if (cx < room.x || cx > room.x + room.w || cz < room.z || cz > room.z + room.d) continue;
        const gain = walk.flood(walk.freeWith(solid(i)), spawn[0], spawn[2]);
        if (gain > bestGain) { bestGain = gain; bestIdx = i; }
      }
      if (bestIdx < 0) break;
      f.furniture.splice(bestIdx, 1);
    }
  }
}

/**
 * Enforce the point-light budget. Hearths and forges shape a room and always
 * survive; candles are the first thing cut, because their fixture still
 * renders as emissive geometry with no per-fragment cost.
 */
function trimLights(lights: LightSource[], spawn: readonly [number, number, number]): LightSource[] {
  if (lights.length <= MAX_INTERIOR_LIGHTS) return lights;
  const weight = (l: LightSource): number => {
    switch (l.kind) {
      case 'forge': return 100;
      case 'hearth': return 90;
      case 'daylight': return 70;
      case 'brazier': return 60;
      case 'torch': return 40;
      default: return 20;
    }
  };
  // Stable sort: importance first, then distance from the spawn so the lights
  // nearest the door survive when weights tie.
  const sorted = lights
    .map((l, i) => ({ l, i, w: weight(l), d: Math.hypot(l.x - spawn[0], l.z - spawn[2]) }))
    .sort((a, b) => (b.w - a.w) || (a.d - b.d) || (a.i - b.i))
    .slice(0, MAX_INTERIOR_LIGHTS)
    .sort((a, b) => a.i - b.i);
  return sorted.map((s) => s.l);
}

// ---------------------------------------------------------------------------
// Standing room
// ---------------------------------------------------------------------------

/** Half a body's width — how far a person keeps off the furniture. */
const BODY_RADIUS = 0.45;
/** Keep the doorway walkable: nobody stands within this of a door cell (m). */
const MIN_DOOR_GAP = 2.5;
/** People do not stand inside one another (m). */
const MIN_SPACING = 1.8;
/**
 * How close the player must be able to get for the spot to be usable (m).
 * Slightly under the E-key reach of 3 m, for margin.
 *
 * Note this is deliberately NOT "must be walk-reachable". A shopkeeper stands
 * BEHIND the counter, and the counter is a collider, so their cell is not one
 * the player can walk onto — and it is exactly where they belong. What matters
 * is that the player can get within talking distance of them, which also rules
 * out the failure this replaced: an occupant sealed in a pocket of floor with
 * furniture across the only way in, visible through the room and impossible to
 * speak to.
 */
const MAX_TALK_REACH = 2.5;

/**
 * Up to `count` places inside an interior where a person can plausibly stand:
 * floor cells clear of furniture, away from the doorway, and spread apart.
 * Returns LOCAL (x, z) at cell centres; callers add the arena origin.
 *
 * Deterministic. Cells are visited in a fixed order and `seed` only chooses
 * where in that order to start, so the keeper is behind the same bar on every
 * visit, while different buildings do not all put their occupant in the same
 * corner.
 */
export function standingSpots(
  interior: BuildingInterior, count: number, seed: number,
): [number, number][] {
  if (count <= 0) return [];

  const cells: [number, number][] = [];
  for (let cz = 0; cz < interior.gridD; cz++) {
    for (let cx = 0; cx < interior.gridW; cx++) {
      if (interior.cells[cz * interior.gridW + cx] !== CELL_FLOOR) continue;
      cells.push([cx, cz]);
    }
  }
  if (cells.length === 0) return [];

  // Where the player can actually get to, so we never seat somebody in a
  // pocket of floor they can be seen in but never spoken to.
  const reachable = reachableFloorCells(interior);

  // Visit cells NEAREST the entrance first.
  //
  // The first version scanned in row-major order from a seeded offset and took
  // the first cell that fitted, which put the occupant wherever the scan
  // happened to land — measured in game, the householder stood 8.7 m away in
  // the far corner of his own house, so walking in felt like finding an empty
  // room with someone loitering at the back. Ranking by distance from the door
  // puts them in the part of the room you actually arrive in. The seed still
  // varies the choice, but only among cells at a similar distance (banded to
  // 1 m), so buildings differ without anyone ending up in a back corner.
  const doorX = interior.spawnPoint[0], doorZ = interior.spawnPoint[2];
  const jitter = (cx: number, cz: number): number => {
    const h = Math.imul(cx * 73856093 ^ cz * 19349663 ^ seed * 83492791, 0x2545f491);
    return ((h >>> 8) & 0xffff) / 0xffff;
  };
  const ranked = cells
    .map(([cx, cz]) => {
      const d = Math.hypot(cx + 0.5 - doorX, cz + 0.5 - doorZ);
      return { cx, cz, band: Math.floor(d), j: jitter(cx, cz) };
    })
    .sort((a, b) => (a.band - b.band) || (a.j - b.j) ||
      (a.cz - b.cz) || (a.cx - b.cx));

  const spots: [number, number][] = [];
  for (let n = 0; n < ranked.length && spots.length < count; n++) {
    const { cx, cz } = ranked[n];
    const lx = cx + 0.5, lz = cz + 0.5;

    let bad = false;
    for (const [dx, dz] of interior.doorCells) {
      if (Math.hypot(lx - (dx + 0.5), lz - (dz + 0.5)) < MIN_DOOR_GAP) { bad = true; break; }
    }
    if (bad) continue;

    for (const f of interior.furniture) {
      const b = f.aabb;
      if (lx > b.minX - BODY_RADIUS && lx < b.maxX + BODY_RADIUS &&
          lz > b.minZ - BODY_RADIUS && lz < b.maxZ + BODY_RADIUS) { bad = true; break; }
    }
    if (bad) continue;

    for (const s of spots) {
      if (Math.hypot(lx - s[0], lz - s[1]) < MIN_SPACING) { bad = true; break; }
    }
    if (bad) continue;

    let speakable = false;
    for (const [rx, rz] of reachable) {
      if (Math.hypot(lx - (rx + 0.5), lz - (rz + 0.5)) <= MAX_TALK_REACH) {
        speakable = true;
        break;
      }
    }
    if (!speakable) continue;

    spots.push([lx, lz]);
  }
  return spots;
}
