/**
 * BuildingManager — enterable settlement buildings.
 *
 * Scans nearby resolved settlement pads for enterable building types
 * (house, barn, keep); provides door-proximity prompts ("Press E to enter"),
 * builds the interior on entry (mesh, collision, chests, lights), and teleports
 * the player to a slot arena at y=-300. Mirrors the DungeonManager lifecycle.
 *
 * Mutual exclusion: cannot enter a building while inside a dungeon, and vice
 * versa — both systems check each other's `isInside`.
 */

import type { GroundQuery } from '../collision';
import type { Vec3 } from '../math';
import type { HeightField } from '../noise';
import type { OrbitCamera } from '../camera';
import type { PlayerController } from '../controller';
import { LIGHTS_BUFFER_SIZE, type DungeonDraw, type Renderer } from '../renderer';
import type { ResolvedSettlement, ResolvedPad, PadType } from '../settlement/settlement-layout';
import {
  generateBuildingInterior,
  type BuildingInterior,
  type BuildingKind,
  type AABB,
} from './building-interior';
import {
  buildBuildingInteriorMesh,
  buildFurnitureMeshes,
  buildLightProps,
  PAL_FURNITURE_WOOD,
} from './building-interior-mesh';
import { buildChestMesh } from '../dungeon/dungeon-props';
import { mix32 } from '../dungeon/dungeon-layout';
import { mulberry32 } from '../mesh-utils';
import type { ItemId } from '../dungeon/dungeon-spec';
import type { Vitals } from '../vitals';

// ---- constants ------------------------------------------------------------

const INTERACT_DIST = 3;    // E-key reach to a building door (m, XZ)
const NOTICE_MS = 4_000;
const TORCH_COLOR: [number, number, number] = [1.0, 0.72, 0.4];
const TORCH_RADIUS = 6;
/** Slot arena y-level (shared with dungeons — only one interior at a time). */
const ARENA_Y = -300;

/** Pad types that can be entered and their mapping to BuildingKind. */
const ENTERABLE_PAD_TYPES: ReadonlyMap<PadType, BuildingKind | 'varied'> = new Map([
  ['house', 'house'],
  ['barn', 'varied'],   // barn → shop or tavern, picked by per-building seed
  ['keep', 'keep'],
  ['tower', 'keep'],     // castle towers — small keep-style stone interior
  ['gatehouse', 'keep'], // castle gatehouse — keep-style guard room
  // jail is explicitly excluded — entering would break the jail/crime flow
]);

/** Map a barn pad to shop or tavern based on seed determinism. */
function barnKind(seed: number): BuildingKind {
  return (seed & 1) === 0 ? 'shop' : 'tavern';
}

// ---- loot tables ----------------------------------------------------------

/** Loot pool per building kind. Modest for houses, better for keeps. */
const LOOT_TABLES: Record<BuildingKind, ItemId[][]> = {
  house: [
    ['gold_small'],
    ['healing_herb'],
    ['gold_small', 'healing_herb'],
  ],
  shop: [
    ['gold_small', 'gold_small'],
    ['iron_flask'],
    ['torch_oil', 'gold_small'],
  ],
  tavern: [
    ['gold_small', 'healing_herb'],
    ['healing_herb', 'healing_herb'],
    ['gold_small'],
  ],
  keep: [
    ['gold_large', 'iron_sword'],
    ['gold_large', 'healing_potion'],
    ['ancient_relic', 'gold_large'],
    ['iron_helm', 'gold_large'],
  ],
};

function rollChestLoot(kind: BuildingKind, seed: number, chestIndex: number): ItemId[] {
  const table = LOOT_TABLES[kind];
  const rng = mulberry32(mix32(seed, chestIndex, 0xc4e57));
  const idx = Math.floor(rng() * table.length);
  return table[idx];
}

/** How many chests per building kind (deterministic per seed). */
function chestCount(kind: BuildingKind, seed: number): number {
  if (kind === 'keep') return 2;
  const r = mulberry32(mix32(seed, 0x6c00f, 0))(  );
  return r < 0.4 ? 1 : 2;
}

// ---- building collider (adapts building interior grid to GroundQuery) ------

class BuildingCollider implements GroundQuery {
  constructor(
    private readonly gridW: number,
    private readonly gridD: number,
    private readonly cells: Uint8Array,
    private readonly ceilY: Float32Array,
    private readonly furnitureAABBs: AABB[],
    readonly origin: Vec3,
  ) {}

  private walkable(cx: number, cz: number): boolean {
    return cx >= 0 && cz >= 0 && cx < this.gridW && cz < this.gridD
      && this.cells[cz * this.gridW + cx] !== 0;
  }

  private blocked(x: number, z: number, r: number): boolean {
    const x0 = Math.floor(x - r);
    const x1 = Math.floor(x + r);
    const z0 = Math.floor(z - r);
    const z1 = Math.floor(z + r);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (!this.walkable(cx, cz)) return true;
      }
    }
    return false;
  }

  /** Check AABB overlap with furniture (capsule at x,z with radius r, height 0..1.8). */
  private furnitureBlocked(x: number, z: number, r: number): boolean {
    for (const aabb of this.furnitureAABBs) {
      if (x + r > aabb.minX && x - r < aabb.maxX &&
          z + r > aabb.minZ && z - r < aabb.maxZ &&
          aabb.maxY > 0.3) { // skip rugs (very low height)
        return true;
      }
    }
    return false;
  }

  groundHeight(): number {
    return this.origin[1];
  }

  ceilingHeight(x: number, z: number): number {
    const cx = Math.floor(x - this.origin[0]);
    const cz = Math.floor(z - this.origin[2]);
    if (!this.walkable(cx, cz)) return Infinity;
    return this.origin[1] + this.ceilY[cz * this.gridW + cx];
  }

  moveXZ(x: number, z: number, dx: number, dz: number, r: number): [number, number] {
    const lx = x - this.origin[0];
    const lz = z - this.origin[2];
    let nx = lx;
    if (!this.blocked(lx + dx, lz, r) && !this.furnitureBlocked(lx + dx, lz, r)) {
      nx = lx + dx;
    }
    let nz = lz;
    if (!this.blocked(nx, lz + dz, r) && !this.furnitureBlocked(nx, lz + dz, r)) {
      nz = lz + dz;
    }
    return [nx + this.origin[0], nz + this.origin[2]];
  }

  clampCameraEye(target: Vec3, desired: Vec3): Vec3 {
    const dx = desired[0] - target[0];
    const dy = desired[1] - target[1];
    const dz = desired[2] - target[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-6) return [...desired] as Vec3;

    const CAM_STEP = 0.25;
    const CAM_MIN_DIST = 0.5;
    let t = dist;
    const steps = Math.ceil(dist / CAM_STEP);
    for (let i = 1; i <= steps; i++) {
      const s = Math.min(i * CAM_STEP, dist);
      const px = target[0] + (dx / dist) * s - this.origin[0];
      const pz = target[2] + (dz / dist) * s - this.origin[2];
      if (!this.walkable(Math.floor(px), Math.floor(pz))) {
        t = Math.max(CAM_MIN_DIST, s - CAM_STEP);
        break;
      }
    }
    const eye: Vec3 = [
      target[0] + (dx / dist) * t,
      target[1] + (dy / dist) * t,
      target[2] + (dz / dist) * t,
    ];
    const cx = Math.floor(eye[0] - this.origin[0]);
    const cz = Math.floor(eye[2] - this.origin[2]);
    const ceil = this.walkable(cx, cz)
      ? this.origin[1] + this.ceilY[cz * this.gridW + cx]
      : this.origin[1] + 3;
    eye[1] = Math.max(this.origin[1] + 0.3, Math.min(ceil - 0.2, eye[1]));
    return eye;
  }
}

// ---- resident state -------------------------------------------------------

interface ResidentChest {
  localCell: [number, number];
  items: ItemId[];
  objectBuffer: GPUBuffer;
  opened: boolean;
}

interface Resident {
  settlementName: string;
  padIndex: number;
  kind: BuildingKind;
  interior: BuildingInterior;
  collider: BuildingCollider;
  origin: Vec3;
  draws: DungeonDraw[];
  chests: ResidentChest[];
  buffers: GPUBuffer[];
  /** World position of the door we entered (for exit placement). */
  doorWorldPos: [number, number, number];
  /** Outward XZ direction of the door face (for exit placement). */
  doorOutDir: [number, number];
}

// ---- public interface (bed rest callback) ---------------------------------

export type OnRestCallback = (vitals: Vitals) => void;

// ---- door world position formula ------------------------------------------

/**
 * Door world position: the door is on the local -Z face of the building pad.
 * Local -Z in pad space → rotated by pad.yaw → translated by (wx, wy, wz).
 */
export function doorWorldPosition(pad: ResolvedPad): [number, number, number] {
  // The pad's local -Z direction (door face) in world space is:
  //   dir = (-sin(yaw), 0, -cos(yaw)) for the standard quantized rotation
  // The door center sits at pad center + dir * (depth/2)
  const doorDist = pad.d / 2;
  const dx = -Math.sin(pad.yaw) * doorDist;
  const dz = -Math.cos(pad.yaw) * doorDist;
  return [pad.wx + dx, pad.wy, pad.wz + dz];
}

/**
 * XZ distance from a point to the pad's footprint rectangle (0 when inside).
 * The enter prompt keys off this rather than the door point alone — doors can
 * face away from the player's natural approach (e.g. the ranch house door
 * points away from the settlement center), which used to make those buildings
 * look unenterable from every other side.
 */
export function padPerimeterDistXZ(pad: ResolvedPad, x: number, z: number): number {
  // World → pad-local (inverse of the quantized yaw rotation).
  const rx = x - pad.wx;
  const rz = z - pad.wz;
  const c = Math.cos(pad.yaw);
  const s = Math.sin(pad.yaw);
  const lx = c * rx - s * rz;
  const lz = s * rx + c * rz;
  const dx = Math.max(Math.abs(lx) - pad.w / 2, 0);
  const dz = Math.max(Math.abs(lz) - pad.d / 2, 0);
  return Math.hypot(dx, dz);
}

// ---- BuildingManager class ------------------------------------------------

export class BuildingManager {
  private resident: Resident | null = null;
  private prompt: { label: string; act: () => void } | null = null;
  private notice: { text: string; until: number } | null = null;
  private readonly openedChests = new Map<string, Set<number>>();
  chestsOpened = 0;

  /** Chest-loot sink (main.ts deposits into the player inventory). */
  onLoot: ((items: ItemId[]) => void) | null = null;
  /** Bed-rest callback (main.ts heals player vitals). */
  onRest: OnRestCallback | null = null;

  constructor(
    private readonly renderer: Renderer,
    private readonly heightField: HeightField,
    private readonly terrain: GroundQuery,
    private readonly controller: PlayerController,
    private readonly camera: OrbitCamera,
    private readonly seed: number,
  ) {}

  get isInside(): boolean {
    return this.resident !== null;
  }

  get interactPrompt(): string | null {
    return this.prompt?.label ?? null;
  }

  get noticeText(): string | null {
    if (this.notice !== null && performance.now() < this.notice.until) {
      return this.notice.text;
    }
    return null;
  }

  /** Current building kind (for HUD display). */
  get currentKind(): BuildingKind | null {
    return this.resident?.kind ?? null;
  }

  draws(): DungeonDraw[] {
    return this.resident?.draws ?? [];
  }

  /**
   * Per-tick update: find the interaction prompt for the player's position.
   * `nearbySettlements` should come from settlementManager.nearby().
   * `dungeonInside` prevents entry while in a dungeon.
   */
  update(pos: Vec3, nearbySettlements: ResolvedSettlement[], dungeonInside: boolean): void {
    this.prompt = this.findInteraction(pos, nearbySettlements, dungeonInside);
  }

  /** Fire the current prompt's action (bound to KeyE in main.ts). */
  tryInteract(): void {
    this.prompt?.act();
  }

  // --- interaction ---------------------------------------------------------

  private findInteraction(
    pos: Vec3,
    nearbySettlements: ResolvedSettlement[],
    dungeonInside: boolean,
  ): { label: string; act: () => void } | null {
    if (this.resident !== null) {
      // Inside: check exit zone, chests, bed
      return this.findInsideInteraction(pos);
    }
    // Outside: scan nearby settlement pads for enterable building doors
    if (dungeonInside) return null;
    return this.findDoorInteraction(pos, nearbySettlements);
  }

  private findInsideInteraction(pos: Vec3): { label: string; act: () => void } | null {
    const res = this.resident!;
    const { interior, origin, chests } = res;
    let best: { label: string; act: () => void } | null = null;
    let bestD = INTERACT_DIST;

    // Exit zone: check overlap with the exitZone AABB (in world space)
    const ez = interior.exitZone;
    const px = pos[0] - origin[0];
    const pz = pos[2] - origin[2];
    if (px >= ez.minX && px <= ez.maxX && pz >= ez.minZ && pz <= ez.maxZ) {
      const exitDist = 0; // already inside the zone
      if (exitDist <= bestD) {
        bestD = exitDist;
        best = { label: 'Press E to leave', act: () => this.exit() };
      }
    } else {
      // Also allow E-key within 3 m of exit zone center
      const ezCenterX = origin[0] + (ez.minX + ez.maxX) / 2;
      const ezCenterZ = origin[2] + (ez.minZ + ez.maxZ) / 2;
      const exitD = Math.hypot(pos[0] - ezCenterX, pos[2] - ezCenterZ);
      if (exitD <= bestD) {
        bestD = exitD;
        best = { label: 'Press E to leave', act: () => this.exit() };
      }
    }

    // Chests
    for (const chest of chests) {
      if (chest.opened) continue;
      const cx = origin[0] + chest.localCell[0] + 0.5;
      const cz = origin[2] + chest.localCell[1] + 0.5;
      const d = Math.hypot(pos[0] - cx, pos[2] - cz);
      if (d <= bestD) {
        bestD = d;
        best = { label: 'Press E to open the chest', act: () => this.openChest(chest) };
      }
    }

    // Bed (rest interaction) — find a bed furniture item within reach
    for (const f of interior.furniture) {
      if (f.type !== 'bed') continue;
      const bx = origin[0] + (f.aabb.minX + f.aabb.maxX) / 2;
      const bz = origin[2] + (f.aabb.minZ + f.aabb.maxZ) / 2;
      const d = Math.hypot(pos[0] - bx, pos[2] - bz);
      if (d <= bestD) {
        bestD = d;
        best = { label: 'Press E to rest', act: () => this.rest() };
      }
    }

    return best;
  }

  private findDoorInteraction(
    pos: Vec3,
    nearbySettlements: ResolvedSettlement[],
  ): { label: string; act: () => void } | null {
    let best: { label: string; act: () => void } | null = null;
    let bestD = INTERACT_DIST;

    for (const settlement of nearbySettlements) {
      for (let padIdx = 0; padIdx < settlement.pads.length; padIdx++) {
        const pad = settlement.pads[padIdx];
        const kindEntry = ENTERABLE_PAD_TYPES.get(pad.type);
        if (kindEntry === undefined) continue;

        // Reachable from any side of the building, not just the door point.
        const d = padPerimeterDistXZ(pad, pos[0], pos[2]);
        if (d <= bestD) {
          bestD = d;
          const buildingSeed = mix32(settlement.site.seed, padIdx);
          const kind: BuildingKind = kindEntry === 'varied'
            ? barnKind(buildingSeed) : kindEntry;
          const label = pad.type === 'tower' || pad.type === 'gatehouse'
            ? pad.type : kind;
          best = {
            label: `Press E to enter (${label})`,
            act: () => this.enter(settlement, padIdx, pad, kind, buildingSeed),
          };
        }
      }
    }
    return best;
  }

  /**
   * Enter an NPC's home (invite-home chat action). Picks a deterministic
   * house pad for this NPC in its settlement, so the same NPC always lives
   * in the same building. Returns false when already inside or when the
   * settlement has no enterable building.
   */
  enterNpcHome(settlement: ResolvedSettlement, npcId: string): boolean {
    if (this.resident !== null) return false;
    const housePads: number[] = [];
    const fallbackPads: number[] = [];
    for (let i = 0; i < settlement.pads.length; i++) {
      const t = settlement.pads[i].type;
      if (t === 'house') housePads.push(i);
      else if (ENTERABLE_PAD_TYPES.has(t)) fallbackPads.push(i);
    }
    const pool = housePads.length > 0 ? housePads : fallbackPads;
    if (pool.length === 0) return false;
    // FNV-1a of the npc id → stable pad choice
    let h = 0x811c9dc5;
    for (let i = 0; i < npcId.length; i++) {
      h ^= npcId.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    const padIdx = pool[(h >>> 0) % pool.length];
    const pad = settlement.pads[padIdx];
    const buildingSeed = mix32(settlement.site.seed, padIdx);
    const kindEntry = ENTERABLE_PAD_TYPES.get(pad.type)!;
    const kind: BuildingKind = kindEntry === 'varied'
      ? barnKind(buildingSeed) : kindEntry;
    this.enter(settlement, padIdx, pad, kind, buildingSeed);
    return true;
  }

  // --- chest ---------------------------------------------------------------

  private openChest(chest: ResidentChest): void {
    if (this.resident === null || chest.opened) return;
    chest.opened = true;
    this.chestsOpened++;
    const key = `${this.resident.settlementName}:${this.resident.padIndex}`;
    let opened = this.openedChests.get(key);
    if (opened === undefined) {
      opened = new Set();
      this.openedChests.set(key, opened);
    }
    opened.add(this.resident.chests.indexOf(chest));
    // Palette swap: wood → stone (looted chest turns dull)
    const [x, z] = chest.localCell;
    const o = this.resident.origin;
    this.renderer.device.queue.writeBuffer(chest.objectBuffer, 0,
      new Float32Array([o[0] + x + 0.5, o[1], o[2] + z + 0.5, 0]));
    const found = chest.items.map((id) => id.replace(/_/g, ' ')).join(', ');
    this.notice = { text: `Found: ${found}`, until: performance.now() + NOTICE_MS };
    this.onLoot?.(chest.items);
  }

  // --- bed rest -------------------------------------------------------------

  private rest(): void {
    if (this.resident === null) return;
    this.notice = { text: 'You rest and feel refreshed.', until: performance.now() + NOTICE_MS };
    this.onRest?.(null!); // main.ts handles healing
  }

  // --- lifecycle -----------------------------------------------------------

  private enter(
    settlement: ResolvedSettlement,
    padIndex: number,
    pad: ResolvedPad,
    kind: BuildingKind,
    buildingSeed: number,
  ): void {
    if (this.resident !== null) return;

    // Interior spec from pad dimensions
    const interior = generateBuildingInterior({
      settlementName: settlement.name,
      buildingIndex: padIndex,
      kind,
      width: pad.w - 0.5, // slightly smaller than pad footprint (walls)
      depth: pad.d - 0.5,
    }, buildingSeed);

    // Slot arena origin (deterministic per padIndex, avoids dungeon's arena)
    const origin: Vec3 = [
      ((padIndex % 8) + 8) % 8 * 64,
      ARENA_Y,
      (((padIndex >> 3) % 8) + 8) % 8 * 64 + 4096, // offset from dungeon arenas
    ];

    const buffers: GPUBuffer[] = [];
    const makeVerts = (label: string, data: Float32Array<ArrayBuffer>): GPUBuffer => {
      const buffer = this.renderer.device.createBuffer({
        label,
        size: data.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.renderer.device.queue.writeBuffer(buffer, 0, data);
      buffers.push(buffer);
      return buffer;
    };
    const makeObject = (w: number, x = origin[0], y = origin[1], z = origin[2]) => {
      const { bindGroup, buffer } = this.renderer.createObjectBindGroup(x, y, z, w);
      buffers.push(buffer);
      return { bindGroup, buffer };
    };

    // Light props. buildLightProps emits one light per interior.lights entry
    // (in order), so per-light color/radius comes straight from the interior
    // generator (warm hearth glow, soft candle light, torch orange).
    // Deterministic truncation to the 32-light uniform cap.
    const MAX_LIGHTS = (LIGHTS_BUFFER_SIZE - 16) / 32;
    const lightProps = buildLightProps(interior);
    const activeLights = lightProps.lights.slice(0, MAX_LIGHTS);
    const lightsData = new Float32Array(LIGHTS_BUFFER_SIZE / 4);
    lightsData[0] = activeLights.length;
    // count.y = "cozy interior" flag: lifts the shader's ambient floor and
    // lightens/warms fog for homes (dungeons keep this at 0).
    lightsData[1] = 1;
    activeLights.forEach(([lx, ly, lz], i) => {
      const src = interior.lights[i];
      const base = 4 + i * 8;
      lightsData[base + 0] = origin[0] + lx;
      lightsData[base + 1] = origin[1] + ly;
      lightsData[base + 2] = origin[2] + lz;
      lightsData.set(src?.color ?? TORCH_COLOR, base + 4);
      lightsData[base + 7] = src?.radius ?? TORCH_RADIUS;
    });
    const lightsBuffer = this.renderer.device.createBuffer({
      label: 'building-lights',
      size: LIGHTS_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.renderer.device.queue.writeBuffer(lightsBuffer, 0, lightsData);
    buffers.push(lightsBuffer);
    const lightsBindGroup = this.renderer.createLightsBindGroup(lightsBuffer);

    // Draws
    const draws: DungeonDraw[] = [];
    const addDraw = (data: Float32Array<ArrayBuffer>, label: string, bindGroup: GPUBindGroup) => {
      if (data.length === 0) return;
      draws.push({
        draw: {
          vertexBuffer: makeVerts(label, data),
          indexBuffer: null,
          count: data.length / 3,
          bindGroup,
        },
        lightsBindGroup,
      });
    };

    // Shell: keeps stay bare stone; homes get plaster walls/ceiling (palette
    // 5) over a wood-plank floor (palette 8) for a warm, lived-in read.
    if (kind === 'keep') {
      addDraw(buildBuildingInteriorMesh(interior), 'building-shell', makeObject(0).bindGroup);
    } else {
      addDraw(buildBuildingInteriorMesh(interior, 'walls'),
        'building-shell-walls', makeObject(5).bindGroup);
      addDraw(buildBuildingInteriorMesh(interior, 'floor'),
        'building-shell-floor', makeObject(PAL_FURNITURE_WOOD).bindGroup);
    }

    // Light fixtures (palette 1 = wood, 2 = torch glow)
    if (lightProps.wood.length > 0) {
      addDraw(lightProps.wood, 'building-torch-wood', makeObject(1).bindGroup);
    }
    if (lightProps.flame.length > 0) {
      addDraw(lightProps.flame, 'building-torch-flame', makeObject(2).bindGroup);
    }

    // Furniture meshes (palettes 4, 5, 6)
    const furnitureMeshes = buildFurnitureMeshes(interior);
    for (const [palette, verts] of furnitureMeshes) {
      addDraw(verts, `building-furniture-p${palette}`, makeObject(palette).bindGroup);
    }

    // Chests
    const buildingKey = `${settlement.name}:${padIndex}`;
    const numChests = chestCount(kind, buildingSeed);
    const chestVerts = buildChestMesh();
    const chestBuffer = numChests > 0 ? makeVerts('building-chest', chestVerts) : null;

    // Place chests deterministically in the interior
    const chestCells = this.pickChestCells(interior, buildingSeed, numChests);
    const chests: ResidentChest[] = chestCells.map((cell, i) => {
      const opened = this.openedChests.get(buildingKey)?.has(i) ?? false;
      const items = rollChestLoot(kind, buildingSeed, i);
      const { bindGroup, buffer } = makeObject(
        opened ? 0 : 1,
        origin[0] + cell[0] + 0.5, origin[1], origin[2] + cell[1] + 0.5);
      draws.push({
        draw: {
          vertexBuffer: chestBuffer!,
          indexBuffer: null,
          count: chestVerts.length / 3,
          bindGroup,
        },
        lightsBindGroup,
      });
      return { localCell: cell, items, objectBuffer: buffer, opened };
    });

    // Collider (furniture AABBs minus rugs)
    const furnitureAABBs = interior.furniture
      .filter(f => f.type !== 'rug')
      .map(f => f.aabb);
    const collider = new BuildingCollider(
      interior.gridW, interior.gridD, interior.cells, interior.ceilY,
      furnitureAABBs, origin);

    const doorPos = doorWorldPosition(pad);
    this.resident = {
      settlementName: settlement.name,
      padIndex,
      kind,
      interior,
      collider,
      origin,
      draws,
      chests,
      buffers,
      doorWorldPos: doorPos,
      doorOutDir: [-Math.sin(pad.yaw), -Math.cos(pad.yaw)],
    };

    // Swap collision world + teleport player
    this.controller.world = collider;
    this.controller.pos = [
      origin[0] + interior.spawnPoint[0],
      origin[1],
      origin[2] + interior.spawnPoint[2],
    ];
    this.controller.velY = 0;
    this.camera.interior = collider;
  }

  private exit(): void {
    if (this.resident === null) return;
    const doorPos = this.resident.doorWorldPos;
    const outDir = this.resident.doorOutDir;
    for (const b of this.resident.buffers) b.destroy();
    this.resident = null;

    this.controller.world = this.terrain;
    // Place the player just outside the door, along the door's outward normal
    // (a fixed +Z offset used to strand exits inside the wall footprint for
    // buildings whose door faces ±X).
    const ex = doorPos[0] + outDir[0] * 1.5;
    const ez = doorPos[2] + outDir[1] * 1.5;
    this.controller.pos = [ex, this.heightField.heightAt(ex, ez) + 0.1, ez];
    this.controller.velY = 0;
    this.camera.interior = null;
  }

  // --- chest cell placement ------------------------------------------------

  private pickChestCells(
    interior: BuildingInterior,
    seed: number,
    count: number,
  ): [number, number][] {
    const rng = mulberry32(mix32(seed, 0xc4e57, interior.gridW));
    const { gridW, gridD, cells, doorCells, spawnPoint } = interior;
    const CELL_FLOOR = 1;

    // Collect floor cells that are not near the door or spawn
    const candidates: [number, number][] = [];
    for (let z = 0; z < gridD; z++) {
      for (let x = 0; x < gridW; x++) {
        if (cells[z * gridW + x] !== CELL_FLOOR) continue;
        // Skip cells near door
        let nearDoor = false;
        for (const [dx, dz] of doorCells) {
          if (Math.abs(x - dx) <= 1 && Math.abs(z - dz) <= 1) {
            nearDoor = true;
            break;
          }
        }
        if (nearDoor) continue;
        // Skip cells near spawn
        if (Math.abs(x + 0.5 - spawnPoint[0]) < 1.5 &&
            Math.abs(z + 0.5 - spawnPoint[2]) < 1.5) continue;
        // Skip cells occupied by furniture
        let blocked = false;
        for (const f of interior.furniture) {
          if (x + 0.5 >= f.aabb.minX && x + 0.5 <= f.aabb.maxX &&
              z + 0.5 >= f.aabb.minZ && z + 0.5 <= f.aabb.maxZ) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        candidates.push([x, z]);
      }
    }

    // Shuffle and pick
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    return candidates.slice(0, Math.min(count, candidates.length));
  }

  // --- debug hooks (e2e) ---------------------------------------------------

  /** Teleport the player onto the exit zone (for testing). */
  debugTeleportToExit(): void {
    if (this.resident === null) return;
    const { interior, origin } = this.resident;
    const ez = interior.exitZone;
    this.controller.pos = [
      origin[0] + (ez.minX + ez.maxX) / 2,
      origin[1],
      origin[2] + (ez.minZ + ez.maxZ) / 2,
    ];
    this.controller.velY = 0;
  }

  /** Teleport the player next to the nearest unopened chest. */
  debugTeleportToChest(): boolean {
    if (this.resident === null) return false;
    const { chests, origin } = this.resident;
    const p = this.controller.pos;
    let best: ResidentChest | null = null;
    let bestD = Infinity;
    for (const chest of chests) {
      if (chest.opened) continue;
      const d = Math.hypot(
        p[0] - (origin[0] + chest.localCell[0] + 0.5),
        p[2] - (origin[2] + chest.localCell[1] + 0.5));
      if (d < bestD) {
        bestD = d;
        best = chest;
      }
    }
    if (best === null) return false;
    this.controller.pos = [
      origin[0] + best.localCell[0] + 0.5,
      origin[1],
      origin[2] + best.localCell[1] + 0.5,
    ];
    this.controller.velY = 0;
    return true;
  }

  /** Teleport the player next to a bed (for testing rest). */
  debugTeleportToBed(): boolean {
    if (this.resident === null) return false;
    const { interior, origin } = this.resident;
    const bed = interior.furniture.find(f => f.type === 'bed');
    if (!bed) return false;
    this.controller.pos = [
      origin[0] + (bed.aabb.minX + bed.aabb.maxX) / 2,
      origin[1],
      origin[2] + (bed.aabb.minZ + bed.aabb.maxZ) / 2 + 0.6,
    ];
    this.controller.velY = 0;
    return true;
  }

  /**
   * Enter the nearest enterable building door from the given settlements.
   * Returns true if entry succeeded.
   */
  debugEnterNearest(nearbySettlements: ResolvedSettlement[]): boolean {
    if (this.resident !== null) return true; // already inside
    const pos = this.controller.pos;
    let bestD = Infinity;
    let bestSettlement: ResolvedSettlement | null = null;
    let bestPadIdx = -1;
    let bestPad: ResolvedPad | null = null;
    let bestKind: BuildingKind | null = null;
    let bestSeed = 0;

    for (const settlement of nearbySettlements) {
      for (let padIdx = 0; padIdx < settlement.pads.length; padIdx++) {
        const pad = settlement.pads[padIdx];
        const kindEntry = ENTERABLE_PAD_TYPES.get(pad.type);
        if (kindEntry === undefined) continue;
        const [doorX, , doorZ] = doorWorldPosition(pad);
        const d = Math.hypot(pos[0] - doorX, pos[2] - doorZ);
        if (d < bestD) {
          bestD = d;
          bestSettlement = settlement;
          bestPadIdx = padIdx;
          bestPad = pad;
          const buildingSeed = mix32(settlement.site.seed, padIdx);
          bestKind = kindEntry === 'varied' ? barnKind(buildingSeed) : kindEntry;
          bestSeed = buildingSeed;
        }
      }
    }
    if (bestSettlement === null || bestPad === null || bestKind === null) return false;
    this.enter(bestSettlement, bestPadIdx, bestPad, bestKind, bestSeed);
    return true;
  }
}
