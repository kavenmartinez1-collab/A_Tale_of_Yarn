/**
 * BuildingManager — enterable settlement buildings.
 *
 * Scans nearby resolved settlement pads for enterable building types; provides
 * door-proximity prompts ("Press E to enter"), builds the interior on entry
 * (mesh, collision, chests, lights), and teleports the player to a slot arena
 * at y=-300. Mirrors the DungeonManager lifecycle.
 *
 * Mutual exclusion: cannot enter a building while inside a dungeon, and vice
 * versa — both systems check each other's `isInside`.
 */

import type { GroundQuery } from '../collision';
import type { Vec3 } from '../math';
import type { HeightField } from '../noise';
import type { OrbitCamera } from '../camera';
import type { PlayerController } from '../controller';
import { LIGHTS_BUFFER_SIZE, STRIDE_PROP, type DungeonDraw, type Renderer } from '../renderer';
import type { WorldLight } from '../dungeon/dungeon-manager';
import type { ResolvedSettlement, ResolvedPad } from '../settlement/settlement-layout';
import {
  generateBuildingInterior,
  reachableFloorCells,
  BUILDING_KINDS,
  type BuildingInterior,
  type BuildingKind,
  type AABB,
} from './building-interior';
import {
  buildBuildingInteriorMesh,
  buildFurnitureMeshes,
  buildLightProps,
  PAL_STONE,
  PAL_WOOD,
  PAL_PLASTER,
  PAL_FIREBRICK,
  PAL_FELT_WALL,
  PAL_PALE_WOOD,
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

/** What a night in a tavern bed costs, in `gold_small`. */
export const ROOM_PRICE = 12;

/**
 * Pad types that can be entered and their mapping to BuildingKind.
 *
 * Keyed by plain string rather than `PadType` on purpose: the settlement
 * layout is gaining `church` / `tavern` / `longhouse` / `smithy` pads in a
 * parallel workstream, and this table should not need to land in the same
 * commit as the union that names them.
 */
const ENTERABLE_PAD_TYPES: ReadonlyMap<string, BuildingKind | 'varied'> = new Map([
  ['house', 'house'],
  ['barn', 'varied'],       // barn → shop / tavern / barn, by per-building seed
  ['stable', 'barn'],
  ['keep', 'keep'],
  ['tower', 'guardhouse'],
  ['gatehouse', 'guardhouse'],
  ['church', 'church'],
  ['tavern', 'tavern'],
  ['longhouse', 'longhouse'],
  ['smithy', 'smithy'],
  // jail is explicitly excluded — entering would break the jail/crime flow
]);

/** Map a 'varied' pad to a concrete kind based on seed determinism. */
function variedKind(seed: number): BuildingKind {
  const pick = (seed >>> 3) % 3;
  return pick === 0 ? 'shop' : pick === 1 ? 'tavern' : 'barn';
}

/**
 * The shader's "cozy interior" ambient floor (lights.count.y). At 1 the
 * ambient alone lights every surface and the hearth stops being the reason
 * you can see, which throws away the whole point of placing the fires where
 * they are. Each kind gets the floor its light plan can afford.
 */
const COZY: Record<BuildingKind, number> = {
  house: 0.72, shop: 0.78, tavern: 0.72, barn: 0.7, longhouse: 0.62,
  guardhouse: 0.62, church: 0.62, keep: 0.5, smithy: 0.2,
};

/**
 * Shell palettes per kind. The shell is two draws (walls+ceiling, floor), so
 * this is the cheapest characterisation available: a limewashed church, a
 * sooty smithy and a timber longhouse read as different buildings before a
 * single prop is placed.
 */
const SHELL_PALETTE: Record<BuildingKind, { walls: number; floor: number }> = {
  house:      { walls: PAL_FELT_WALL, floor: PAL_PALE_WOOD },
  shop:       { walls: PAL_FELT_WALL, floor: PAL_PALE_WOOD },
  tavern:     { walls: PAL_FELT_WALL, floor: PAL_PALE_WOOD },
  keep:       { walls: PAL_STONE,     floor: PAL_STONE },
  church:     { walls: PAL_PLASTER,   floor: PAL_STONE },
  longhouse:  { walls: PAL_WOOD,      floor: PAL_PALE_WOOD },
  smithy:     { walls: PAL_FIREBRICK, floor: PAL_STONE },
  barn:       { walls: PAL_WOOD,      floor: PAL_PALE_WOOD },
  guardhouse: { walls: PAL_FELT_WALL, floor: PAL_STONE },
};

// ---- debug: force a kind from the URL -------------------------------------
//
// `?interior=church` makes every building the player enters generate that
// kind. Used by scripts/interior-shots.mjs to photograph every layout without
// hunting a settlement that happens to contain one of each. Absent in normal
// play, so it costs one `URLSearchParams` parse per session.

let overrideCache: BuildingKind | null | undefined;

function interiorKindOverride(): BuildingKind | null {
  if (overrideCache !== undefined) return overrideCache;
  overrideCache = null;
  const loc = (globalThis as { location?: { search?: string } }).location;
  if (loc?.search) {
    const v = new URLSearchParams(loc.search).get('interior');
    if (v !== null && (BUILDING_KINDS as readonly string[]).includes(v)) {
      overrideCache = v as BuildingKind;
    }
  }
  return overrideCache;
}

// ---- loot tables ----------------------------------------------------------

/** Loot pool per building kind. Modest for homes, better for keeps. */
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
  church: [
    ['gold_small', 'healing_potion'],
    ['ancient_relic'],
    ['healing_herb', 'gold_small'],
  ],
  longhouse: [
    ['gold_small', 'gold_small'],
    ['iron_axe'],
    ['healing_herb', 'gold_small'],
  ],
  smithy: [
    ['iron_sword'],
    ['iron_helm'],
    ['torch_oil', 'gold_small'],
  ],
  barn: [
    ['healing_herb'],
    ['gold_small'],
    ['healing_herb', 'healing_herb'],
  ],
  guardhouse: [
    ['gold_small', 'torch_oil'],
    ['iron_flask'],
    ['gold_small'],
  ],
};

function rollChestLoot(kind: BuildingKind, seed: number, chestIndex: number): ItemId[] {
  const table = LOOT_TABLES[kind] ?? LOOT_TABLES.house;
  const rng = mulberry32(mix32(seed, chestIndex, 0xc4e57));
  const idx = Math.floor(rng() * table.length);
  return table[idx];
}

/** How many chests per building kind (deterministic per seed). */
function chestCount(kind: BuildingKind, seed: number): number {
  if (kind === 'keep') return 2;
  const r = mulberry32(mix32(seed, 0x6c00f, 0))();
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

  /** Check AABB overlap with furniture (capsule at x,z with radius r). */
  private furnitureBlocked(x: number, z: number, r: number): boolean {
    for (const aabb of this.furnitureAABBs) {
      if (x + r > aabb.minX && x - r < aabb.maxX &&
          z + r > aabb.minZ && z - r < aabb.maxZ &&
          aabb.maxY > 0.3) { // skip rugs and dais steps (very low height)
        return true;
      }
    }
    return false;
  }

  /** Would the camera eye be inside a piece of furniture at this local point? */
  private eyeInside(x: number, y: number, z: number): boolean {
    const pad = 0.2;
    for (const a of this.furnitureAABBs) {
      if (a.maxY <= 0.5) continue;  // rugs, dais steps, low benches
      if (x > a.minX - pad && x < a.maxX + pad &&
          z > a.minZ - pad && z < a.maxZ + pad &&
          y > a.minY - pad && y < a.maxY + pad) return true;
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
      const py = target[1] + (dy / dist) * s - this.origin[1];
      const pz = target[2] + (dz / dist) * s - this.origin[2];
      // Walls, and — since interiors are now full of tall furniture — the
      // furniture too. Without this the third-person eye ends up inside a
      // workbench or a bunk and the shot is the inside of a plank.
      if (!this.walkable(Math.floor(px), Math.floor(pz)) || this.eyeInside(px, py, pz)) {
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
  /** Hearth/candle/torch lights in CPU form, for the world-light set. */
  torchLights: WorldLight[];
  /** Build cost, for the perf harness. */
  stats: { buildMs: number; propVerts: number; draws: number };
}

// ---- public interface -----------------------------------------------------

export type OnRestCallback = (vitals: Vitals) => void;

// ---- door world position formula ------------------------------------------

/**
 * Door world position: the door is on the local -Z face of the building pad.
 * Local -Z in pad space → rotated by pad.yaw → translated by (wx, wy, wz).
 */
export function doorWorldPosition(pad: ResolvedPad): [number, number, number] {
  const doorDist = pad.d / 2;
  const dx = -Math.sin(pad.yaw) * doorDist;
  const dz = -Math.cos(pad.yaw) * doorDist;
  return [pad.wx + dx, pad.wy, pad.wz + dz];
}

/**
 * XZ distance from a point to the pad's footprint rectangle (0 when inside).
 * The enter prompt keys off this rather than the door point alone — doors can
 * face away from the player's natural approach.
 */
export function padPerimeterDistXZ(pad: ResolvedPad, x: number, z: number): number {
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
  /** `settlement:pad` keys the player has paid for a bed in, until they sleep. */
  private readonly rentedRooms = new Set<string>();
  chestsOpened = 0;

  /** Chest-loot sink (main.ts deposits into the player inventory). */
  onLoot: ((items: ItemId[]) => void) | null = null;
  /** Bed-rest callback (main.ts heals player vitals). */
  onRest: OnRestCallback | null = null;

  // --- bed rental seams (wired by main.ts; all optional) -------------------

  /**
   * Player's spendable gold. Unwired means "no economy yet" and renting is
   * free — a missing callback must never make an interaction unusable.
   */
  getGold: (() => number) | null = null;
  /** Deduct `amount` gold; return false when the player cannot afford it. */
  spendGold: ((amount: number) => boolean) | null = null;
  /**
   * Sleep through to morning: advance world time and restore the player.
   * Falls back to `onRest` when unwired, so sleeping still heals.
   */
  onSleep: (() => void) | null = null;

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

  /** Interior lights for the renderer's world-light set — what keeps
   *  characters and animals visible indoors. */
  activeLights(): readonly WorldLight[] {
    return this.resident?.torchLights ?? [];
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

  /** Interior cost of the resident build — read by the perf harness. */
  get buildStats(): { buildMs: number; propVerts: number; draws: number } | null {
    return this.resident?.stats ?? null;
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
    if (this.resident !== null) return this.findInsideInteraction(pos);
    if (dungeonInside) return null;
    return this.findDoorInteraction(pos, nearbySettlements);
  }

  private roomKey(): string {
    const r = this.resident!;
    return `${r.settlementName}:${r.padIndex}`;
  }

  private findInsideInteraction(pos: Vec3): { label: string; act: () => void } | null {
    const res = this.resident!;
    const { interior, origin, chests } = res;
    let best: { label: string; act: () => void } | null = null;
    let bestD = INTERACT_DIST;

    // Exit zone: overlap with the exitZone AABB (in world space).
    const ez = interior.exitZone;
    const px = pos[0] - origin[0];
    const pz = pos[2] - origin[2];
    if (px >= ez.minX && px <= ez.maxX && pz >= ez.minZ && pz <= ez.maxZ) {
      bestD = 0;
      best = { label: 'Press E to leave', act: () => this.exit() };
    } else {
      const ezCenterX = origin[0] + (ez.minX + ez.maxX) / 2;
      const ezCenterZ = origin[2] + (ez.minZ + ez.maxZ) / 2;
      const exitD = Math.hypot(pos[0] - ezCenterX, pos[2] - ezCenterZ);
      if (exitD <= bestD) {
        bestD = exitD;
        best = { label: 'Press E to leave', act: () => this.exit() };
      }
    }

    // Chests.
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

    const rented = this.rentedRooms.has(this.roomKey());

    // The tavern keeper's post: the bar counter. Paying here is paying them.
    for (const f of interior.furniture) {
      if (f.tag !== 'keeper' || res.kind !== 'tavern') continue;
      const bx = origin[0] + (f.aabb.minX + f.aabb.maxX) / 2;
      const bz = origin[2] + (f.aabb.minZ + f.aabb.maxZ) / 2;
      const d = Math.hypot(pos[0] - bx, pos[2] - bz);
      if (d > bestD) continue;
      bestD = d;
      best = rented
        ? {
          label: 'Press E to speak to the tavern keeper',
          act: () => this.notify('"Your room is made up. Sleep well."'),
        }
        : {
          label: `Press E to rent a room for the night (${ROOM_PRICE} gold)`,
          act: () => this.rentRoom(),
        };
    }

    // Beds. A rentable bed needs paying for; every other bed is free rest.
    for (const f of interior.furniture) {
      if (f.type !== 'bed' && f.type !== 'bunk' && f.type !== 'sleepbench') continue;
      const bx = origin[0] + (f.aabb.minX + f.aabb.maxX) / 2;
      const bz = origin[2] + (f.aabb.minZ + f.aabb.maxZ) / 2;
      const d = Math.hypot(pos[0] - bx, pos[2] - bz);
      if (d > bestD) continue;
      bestD = d;
      if (f.tag === 'rent') {
        best = rented
          ? { label: 'Press E to sleep until morning', act: () => this.sleep() }
          : {
            label: `Press E to rent this bed (${ROOM_PRICE} gold)`,
            act: () => this.rentRoom(),
          };
      } else {
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

        const d = padPerimeterDistXZ(pad, pos[0], pos[2]);
        if (d <= bestD) {
          bestD = d;
          const buildingSeed = mix32(settlement.site.seed, padIdx);
          const kind = this.resolveKind(kindEntry, buildingSeed);
          best = {
            label: `Press E to enter (${kind})`,
            act: () => this.enter(settlement, padIdx, pad, kind, buildingSeed),
          };
        }
      }
    }
    return best;
  }

  private resolveKind(entry: BuildingKind | 'varied', buildingSeed: number): BuildingKind {
    return interiorKindOverride()
      ?? (entry === 'varied' ? variedKind(buildingSeed) : entry);
  }

  /**
   * Enter an NPC's home (invite-home chat action). Picks a deterministic
   * house pad for this NPC in its settlement, so the same NPC always lives
   * in the same building.
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
    let h = 0x811c9dc5;
    for (let i = 0; i < npcId.length; i++) {
      h ^= npcId.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    const padIdx = pool[(h >>> 0) % pool.length];
    const pad = settlement.pads[padIdx];
    const buildingSeed = mix32(settlement.site.seed, padIdx);
    const kind = this.resolveKind(ENTERABLE_PAD_TYPES.get(pad.type)!, buildingSeed);
    this.enter(settlement, padIdx, pad, kind, buildingSeed);
    return true;
  }

  // --- chest ---------------------------------------------------------------

  private notify(text: string): void {
    this.notice = { text, until: performance.now() + NOTICE_MS };
  }

  private openChest(chest: ResidentChest): void {
    if (this.resident === null || chest.opened) return;
    chest.opened = true;
    this.chestsOpened++;
    const key = this.roomKey();
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
    this.notify(`Found: ${found}`);
    this.onLoot?.(chest.items);
  }

  // --- rest / rent / sleep --------------------------------------------------

  private rest(): void {
    if (this.resident === null) return;
    this.notify('You rest and feel refreshed.');
    this.onRest?.(null!); // main.ts handles healing
  }

  /**
   * Pay the tavern keeper for a bed. Falls back to free when no economy
   * callbacks are wired, so the interaction is never a dead end.
   */
  private rentRoom(): void {
    if (this.resident === null) return;
    const key = this.roomKey();
    if (this.rentedRooms.has(key)) return;
    const gold = this.getGold?.();
    if (gold !== undefined && gold < ROOM_PRICE) {
      this.notify(`Not enough gold — a room is ${ROOM_PRICE} gold (you have ${gold}).`);
      return;
    }
    if (this.spendGold !== null && !this.spendGold(ROOM_PRICE)) {
      this.notify(`Not enough gold — a room is ${ROOM_PRICE} gold.`);
      return;
    }
    this.rentedRooms.add(key);
    this.notify('You pay the tavern keeper. The bed in the back room is yours for the night.');
  }

  /** Consume the rented room: sleep through to morning. */
  private sleep(): void {
    if (this.resident === null) return;
    const key = this.roomKey();
    if (!this.rentedRooms.has(key)) {
      this.notify('You have not paid for this bed.');
      return;
    }
    this.rentedRooms.delete(key);
    this.notify('You sleep soundly until morning.');
    if (this.onSleep !== null) this.onSleep();
    else this.onRest?.(null!);
  }

  /** True when the player has paid for a bed in the building they are in. */
  get roomRented(): boolean {
    return this.resident !== null && this.rentedRooms.has(this.roomKey());
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
    const t0 = performance.now();

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
      (((padIndex >> 3) % 8) + 8) % 8 * 64 + 4096,
    ];

    const buffers: GPUBuffer[] = [];
    let propVerts = 0;
    const makeVerts = (label: string, data: Float32Array<ArrayBuffer>): GPUBuffer => {
      const buffer = this.renderer.device.createBuffer({
        label,
        size: data.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.renderer.device.queue.writeBuffer(buffer, 0, data);
      buffers.push(buffer);
      propVerts += data.length / (STRIDE_PROP / 4);
      return buffer;
    };
    const makeObject = (w: number, x = origin[0], y = origin[1], z = origin[2]) => {
      const { bindGroup, buffer, shadowBindGroup } = this.renderer.createObjectBindGroup(x, y, z, w);
      buffers.push(buffer);
      return { bindGroup, buffer, shadowBindGroup };
    };

    // Light props. buildLightProps emits one light per interior.lights entry
    // (in order), so per-light colour/radius comes straight from the interior
    // generator. Deterministic truncation to the uniform cap.
    const MAX_LIGHTS = (LIGHTS_BUFFER_SIZE - 16) / 32;
    const lightProps = buildLightProps(interior);
    const activeLights = lightProps.lights.slice(0, MAX_LIGHTS);
    const lightsData = new Float32Array(LIGHTS_BUFFER_SIZE / 4);
    lightsData[0] = activeLights.length;
    // count.y = "cozy interior" flag: lifts the shader's ambient floor and
    // lightens/warms fog for homes (dungeons keep this at 0). A smithy wants
    // the dungeon treatment — dark, with the forge doing all the work.
    lightsData[1] = COZY[kind] ?? 0.75;
    // Also kept in CPU form: characters and animals render on pipelines that
    // cannot see this group-2 uniform, so without a copy for the renderer's
    // world-light set anyone indoors is an unlit black silhouette.
    const torchLights: WorldLight[] = [];
    activeLights.forEach(([lx, ly, lz], i) => {
      const src = interior.lights[i];
      const base = 4 + i * 8;
      const wx = origin[0] + lx, wy = origin[1] + ly, wz = origin[2] + lz;
      lightsData[base + 0] = wx;
      lightsData[base + 1] = wy;
      lightsData[base + 2] = wz;
      const color = src?.color ?? TORCH_COLOR;
      const radius = src?.radius ?? TORCH_RADIUS;
      lightsData.set(color, base + 4);
      lightsData[base + 7] = radius;
      // Billboard flame size per fixture kind (render/fire-fx.ts). A candle is
      // not a hearth, and radius alone does not distinguish them. `daylight`
      // is a window: it lights the room but there is nothing burning.
      const kindOf = src?.kind;
      const flameScale = kindOf === 'daylight' ? 0
        : kindOf === 'candle' ? 0.34
        : kindOf === 'lantern' ? 0.5
        : kindOf === 'hearth' ? 1.8
        : kindOf === 'forge' ? 0.95
        : kindOf === 'brazier' ? 1.25
        : 1;
      torchLights.push({
        pos: [wx, wy, wz],
        color: [color[0] * 2.2, color[1] * 2.2, color[2] * 2.2],
        radius,
        flameScale,
      });
    });
    // A soft fill for the *character* pipeline only. Interior surfaces get
    // the shader's cozy ambient floor, but characters and animals shade off
    // the world-light set alone, so anyone standing more than a few metres
    // from a fixture renders as a pure black silhouette. One wide, dim,
    // flameless light at the middle of the room fixes that for the cost of a
    // single extra iteration in a loop that is only running indoors.
    const fillY = Math.min(1.7, interior.ceilHeight - 0.4);
    torchLights.push({
      pos: [origin[0] + interior.gridW / 2, origin[1] + fillY, origin[2] + interior.gridD / 2],
      color: [0.62, 0.55, 0.46],
      radius: Math.max(interior.gridW, interior.gridD) * 0.85,
      flameScale: 0,
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
    const addDraw = (
      data: Float32Array<ArrayBuffer>, label: string,
      obj: { bindGroup: GPUBindGroup; shadowBindGroup: GPUBindGroup },
    ) => {
      if (data.length === 0) return;
      draws.push({
        draw: {
          vertexBuffer: makeVerts(label, data),
          indexBuffer: null,
          count: data.length / (STRIDE_PROP / 4),
          bindGroup: obj.bindGroup,
          shadowBindGroup: obj.shadowBindGroup,
        },
        lightsBindGroup,
      });
    };

    // Shell: two draws, palettes per kind.
    const shell = SHELL_PALETTE[kind] ?? SHELL_PALETTE.house;
    addDraw(buildBuildingInteriorMesh(interior, 'walls'), 'building-shell-walls',
      makeObject(shell.walls));
    addDraw(buildBuildingInteriorMesh(interior, 'floor'), 'building-shell-floor',
      makeObject(shell.floor));

    // Light fixtures (palette 1 = wood, 2 = emissive)
    if (lightProps.wood.length > 0) addDraw(lightProps.wood, 'building-torch-wood', makeObject(1));
    if (lightProps.flame.length > 0) addDraw(lightProps.flame, 'building-torch-flame', makeObject(2));

    // Furniture + decor, one draw per palette used.
    const propMeshes = buildFurnitureMeshes(interior);
    for (const [palette, verts] of propMeshes) {
      addDraw(verts, `building-props-p${palette}`, makeObject(palette));
    }

    // Chests
    const buildingKey = `${settlement.name}:${padIndex}`;
    const numChests = chestCount(kind, buildingSeed);
    const chestVerts = buildChestMesh();
    const chestBuffer = numChests > 0 ? makeVerts('building-chest', chestVerts) : null;

    const chestCells = this.pickChestCells(interior, buildingSeed, numChests);
    const chests: ResidentChest[] = chestCells.map((cell, i) => {
      const opened = this.openedChests.get(buildingKey)?.has(i) ?? false;
      const items = rollChestLoot(kind, buildingSeed, i);
      const { bindGroup, buffer, shadowBindGroup } = makeObject(
        opened ? 0 : 1,
        origin[0] + cell[0] + 0.5, origin[1], origin[2] + cell[1] + 0.5);
      draws.push({
        draw: {
          vertexBuffer: chestBuffer!,
          indexBuffer: null,
          count: chestVerts.length / (STRIDE_PROP / 4),
          bindGroup,
          shadowBindGroup,
        },
        lightsBindGroup,
      });
      return { localCell: cell, items, objectBuffer: buffer, opened };
    });

    // Collider (furniture AABBs minus flat pieces)
    const furnitureAABBs = interior.furniture
      .filter((f) => f.type !== 'rug' && f.type !== 'dais')
      .map((f) => f.aabb);
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
      torchLights,
      stats: { buildMs: performance.now() - t0, propVerts, draws: draws.length },
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
    this.publishDebug();
  }

  private exit(): void {
    if (this.resident === null) return;
    const doorPos = this.resident.doorWorldPos;
    const outDir = this.resident.doorOutDir;
    for (const b of this.resident.buffers) b.destroy();
    this.resident = null;

    this.controller.world = this.terrain;
    // Place the player just outside the door, along the door's outward normal.
    const ex = doorPos[0] + outDir[0] * 1.5;
    const ez = doorPos[2] + outDir[1] * 1.5;
    this.controller.pos = [ex, this.heightField.heightAt(ex, ez) + 0.1, ez];
    this.controller.velY = 0;
    this.camera.interior = null;
    this.publishDebug();
  }

  // --- chest cell placement ------------------------------------------------

  private pickChestCells(
    interior: BuildingInterior,
    seed: number,
    count: number,
  ): [number, number][] {
    const rng = mulberry32(mix32(seed, 0xc4e57, interior.gridW));
    const { doorCells, spawnPoint } = interior;

    // Only cells the player can actually walk to — loot behind a counter that
    // cannot be reached is loot the player will report as a bug.
    const candidates = reachableFloorCells(interior).filter(([x, z]) => {
      for (const [dx, dz] of doorCells) {
        if (Math.abs(x - dx) <= 1 && Math.abs(z - dz) <= 1) return false;
      }
      if (Math.abs(x + 0.5 - spawnPoint[0]) < 1.5 &&
          Math.abs(z + 0.5 - spawnPoint[2]) < 1.5) return false;
      return true;
    });

    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    // Keep the chests apart so they do not read as a pair of boxes.
    const picked: [number, number][] = [];
    for (const c of candidates) {
      if (picked.length >= count) break;
      if (picked.some(([px, pz]) => Math.hypot(px - c[0], pz - c[1]) < 3)) continue;
      picked.push(c);
    }
    if (picked.length < count) {
      for (const c of candidates) {
        if (picked.length >= count) break;
        if (!picked.includes(c)) picked.push(c);
      }
    }
    return picked;
  }

  // --- debug hooks (e2e / capture harness) ---------------------------------

  /**
   * Interior inspection surface for scripts/interior-shots.mjs. Attached on
   * entry and cleared on exit; one object literal per transition, so it is
   * free in normal play and saves main.ts from carrying interior-specific
   * debug hooks it does not otherwise need.
   */
  private publishDebug(): void {
    const g = globalThis as { __buildingDebug?: unknown };
    if (this.resident === null) { g.__buildingDebug = null; return; }
    const res = this.resident;
    g.__buildingDebug = {
      kind: res.kind,
      grid: [res.interior.gridW, res.interior.gridD],
      rooms: res.interior.rooms.map((r) => r.label),
      furniture: res.interior.furniture.length,
      decor: res.interior.decor.length,
      lights: res.interior.lights.length,
      draws: res.stats.draws,
      propVerts: res.stats.propVerts,
      buildMs: res.stats.buildMs,
      origin: [...res.origin],
      spawn: [...res.interior.spawnPoint],
      /** Teleport to interior-local (x, z). */
      teleport: (x: number, z: number) => {
        this.controller.pos = [res.origin[0] + x, res.origin[1], res.origin[2] + z];
        this.controller.velY = 0;
      },
      /** Stand in the doorway looking in. */
      atDoor: () => {
        this.controller.pos = [
          res.origin[0] + res.interior.spawnPoint[0],
          res.origin[1],
          res.origin[2] + res.interior.spawnPoint[2],
        ];
        this.controller.velY = 0;
      },
      /** Stand at the focal end (the -Z end every layout composes toward). */
      atFocus: () => this.standNear(res.interior.gridW / 2, res.interior.gridD * 0.42),
      /** Stand in the middle of the interior. */
      atCenter: () => this.standNear(res.interior.gridW / 2, res.interior.gridD / 2),
      rentedRooms: () => [...this.rentedRooms],
    };
  }

  /**
   * Put the player on the reachable floor cell nearest an interior-local
   * point. Capture harnesses ask for "the middle of the room", and the middle
   * of the grid is regularly inside a partition or a table.
   */
  private standNear(lx: number, lz: number): void {
    if (this.resident === null) return;
    const { interior, origin } = this.resident;
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (const [x, z] of reachableFloorCells(interior)) {
      const d = Math.hypot(x + 0.5 - lx, z + 0.5 - lz);
      if (d < bestD) { bestD = d; best = [x, z]; }
    }
    const p: [number, number] = best ?? [lx - 0.5, lz - 0.5];
    this.controller.pos = [origin[0] + p[0] + 0.5, origin[1], origin[2] + p[1] + 0.5];
    this.controller.velY = 0;
  }

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

  /** Teleport the player next to a bed (for testing rest / rental). */
  debugTeleportToBed(): boolean {
    if (this.resident === null) return false;
    const { interior, origin } = this.resident;
    const bed = interior.furniture.find((f) => f.tag === 'rent')
      ?? interior.furniture.find((f) => f.type === 'bed' || f.type === 'bunk'
        || f.type === 'sleepbench');
    if (!bed) return false;
    // Stand on the nearest cell the player could actually walk to. Dropping
    // the player next to the bed geometrically lands them inside a wall about
    // a third of the time, and the collider then refuses every move.
    const cx = (bed.aabb.minX + bed.aabb.maxX) / 2;
    const cz = (bed.aabb.minZ + bed.aabb.maxZ) / 2;
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (const [x, z] of reachableFloorCells(interior)) {
      const d = Math.hypot(x + 0.5 - cx, z + 0.5 - cz);
      if (d < bestD) { bestD = d; best = [x, z]; }
    }
    if (best === null) return false;
    this.controller.pos = [origin[0] + best[0] + 0.5, origin[1], origin[2] + best[1] + 0.5];
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
          bestKind = this.resolveKind(kindEntry, buildingSeed);
          bestSeed = buildingSeed;
        }
      }
    }
    if (bestSettlement === null || bestPad === null || bestKind === null) return false;
    this.enter(bestSettlement, bestPadIdx, bestPad, bestKind, bestSeed);
    return true;
  }
}
