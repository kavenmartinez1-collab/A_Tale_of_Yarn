/**
 * DungeonManager — scatters dungeon entrances across the world and owns the
 * enter/exit lifecycle of the single resident interior.
 *
 * Scattering: the world is tiled into 512 m dungeon cells. entranceAt() is a
 * pure function of (WORLD_SEED, dcx, dcz): 60 % of cells roll an entrance,
 * up to 6 jittered candidates each, accepted only above the sand line
 * (heightAt ≥ 3) on gentle slopes (Δh ≤ 2 m over ±2 m). A lazy 3×3-cell
 * registry around the player caches results.
 *
 * Lifecycle: entering builds the interior synchronously (layout → mesh →
 * buffers → collider), swaps controller.world, teleports the player to the
 * spawn cell, and points the orbit camera at the interior collider. Exiting
 * destroys every GPU buffer and restores terrain collision just outside the
 * entrance. Exactly ONE interior may be resident at a time — the slot-arena
 * origin below reuses positions and is only collision-safe under that rule.
 *
 * Interaction (v1): E at an entrance enters; E at the interior exit portal
 * leaves. main.ts polls `interactPrompt` for the HUD and forwards KeyE.
 */

import type { GroundQuery } from '../collision';
import type { Vec3 } from '../math';
import type { HeightField } from '../noise';
import type { OrbitCamera } from '../camera';
import type { PlayerController } from '../controller';
import { LIGHTS_BUFFER_SIZE, type DungeonDraw, type Renderer } from '../renderer';
import type { DungeonSpec, ItemId } from './dungeon-spec';
import { DUNGEON_FIXTURES } from './dungeon-fixtures';
import { layoutDungeon, mix32, type DungeonLayout } from './dungeon-layout';
import { buildInteriorMesh } from './dungeon-mesh';
import {
  buildChestMesh, buildEntranceGlowMesh, buildEntranceStoneMesh,
  buildPortalMesh, buildTorchProps,
} from './dungeon-props';
import { DungeonCollider } from './dungeon-collider';
import { DCELL, entranceSiteAt } from './entrance-site';

const INTERACT_DIST = 3;    // E-key reach (m, XZ)
const EXIT_OFFSET = 1.5;    // how far outside the entrance you reappear (m)
// Surface arches render within this range (m). MUST stay inside the terrain
// stream radius (LOAD_RADIUS 6 × 64 = 384 m guaranteed) or arches float in
// the sky over unloaded ground; 360 leaves margin for async chunk gen.
const ENTRANCE_DRAW_DIST = 360;
const NOTICE_MS = 4_000;    // "Found: …" HUD notice lifetime
const TORCH_COLOR: [number, number, number] = [1.0, 0.72, 0.4];
const TORCH_RADIUS = 7;     // point-light falloff radius (m)

/**
 * Sync seam through which the AI Director supplies specs. Everything here
 * must be synchronous — the manager builds interiors in one frame. The
 * Director resolves specs asynchronously behind it and persists results;
 * `isReady` gates entry (the "wait at the door" rule) and `generation`
 * bumps let cached entrance names refresh once a spec resolves.
 */
export interface SpecProvider {
  specFor(dcx: number, dcz: number): DungeonSpec;
  /** True when entry is final: persisted spec, or provider gave up. */
  isReady(dcx: number, dcz: number): boolean;
  /** Player is waiting at this door — bump its generation priority. */
  prioritize(dcx: number, dcz: number): void;
  /** Player is entering NOW — freeze whatever spec currently resolves. */
  onMaterialize(dcx: number, dcz: number): void;
  readonly generation: number;
}

export interface Entrance {
  dcx: number;
  dcz: number;
  x: number;
  y: number;
  z: number;
  name: string;
}

interface ResidentChest {
  cell: [number, number];
  items: ItemId[];
  /** Object uniform buffer — w rewritten wood → stone when looted. */
  objectBuffer: GPUBuffer;
  opened: boolean;
}

interface Resident {
  entrance: Entrance;
  layout: DungeonLayout;
  collider: DungeonCollider;
  origin: Vec3;
  draws: DungeonDraw[];
  chests: ResidentChest[];
  buffers: GPUBuffer[];
}

interface EntranceProps {
  stoneBuffer: GPUBuffer;
  stoneCount: number;
  glowBuffer: GPUBuffer;
  glowCount: number;
  lightsBindGroup: GPUBindGroup;
  /** Per-entrance draw pairs, keyed "dcx,dcz". */
  draws: Map<string, { entrance: Entrance; draws: DungeonDraw[] }>;
}

export class DungeonManager {
  private readonly cache = new Map<string, Entrance | null>();
  private resident: Resident | null = null;
  private prompt: { label: string; act: () => void } | null = null;
  private entranceProps: EntranceProps | null = null;
  /** Chests opened this session, keyed "dcx,dcz" → chest indices. */
  private readonly openedChests = new Map<string, Set<number>>();
  private notice: { text: string; until: number } | null = null;
  private lastProviderGeneration = 0;
  chestsOpened = 0;
  /** Chest-loot sink (main.ts deposits into the player inventory). */
  onLoot: ((items: ItemId[]) => void) | null = null;

  constructor(
    private readonly renderer: Renderer,
    private readonly heightField: HeightField,
    private readonly terrain: GroundQuery,
    private readonly controller: PlayerController,
    private readonly camera: OrbitCamera,
    private readonly seed: number,
    private readonly specProvider: SpecProvider | null = null,
  ) {}

  get isInside(): boolean {
    return this.resident !== null;
  }

  get interactPrompt(): string | null {
    return this.prompt?.label ?? null;
  }

  /** Number of discovered (cached, present) entrances so far. */
  get dungeonCount(): number {
    let n = 0;
    for (const e of this.cache.values()) if (e !== null) n++;
    return n;
  }

  /** Transient HUD notice ("Found: …"), or null once expired. */
  get noticeText(): string | null {
    if (this.notice !== null && performance.now() < this.notice.until) {
      return this.notice.text;
    }
    return null;
  }

  /** Inside: interior + props. Outside: nearby surface entrance arches. */
  draws(): DungeonDraw[] {
    if (this.resident !== null) return this.resident.draws;
    if (this.entranceProps === null) return [];
    const p = this.controller.pos;
    const out: DungeonDraw[] = [];
    for (const { entrance, draws } of this.entranceProps.draws.values()) {
      if (Math.hypot(p[0] - entrance.x, p[2] - entrance.z) <= ENTRANCE_DRAW_DIST) {
        out.push(...draws);
      }
    }
    return out;
  }

  /** Per-tick: refresh the entrance registry + the current interact prompt. */
  update(pos: Vec3): void {
    // Director specs resolve async: refresh cached entrance names on bump.
    if (this.specProvider !== null
        && this.specProvider.generation !== this.lastProviderGeneration) {
      this.lastProviderGeneration = this.specProvider.generation;
      for (const e of this.cache.values()) {
        if (e !== null) e.name = this.specFor(e.dcx, e.dcz).name;
      }
    }
    if (this.resident === null) {
      const dcx = Math.floor(pos[0] / DCELL);
      const dcz = Math.floor(pos[2] / DCELL);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const e = this.entrance(dcx + dx, dcz + dz);
          if (e !== null) this.ensureEntranceDraws(e);
        }
      }
    }
    this.prompt = this.findInteraction(pos);
  }

  /** Fire the current prompt's action (bound to KeyE in main.ts). */
  tryInteract(): void {
    this.prompt?.act();
  }

  // --- scattering ----------------------------------------------------------

  /** Pure per-cell entrance roll (entrance-site.ts); memoized in `cache`. */
  private entrance(dcx: number, dcz: number): Entrance | null {
    const key = `${dcx},${dcz}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;

    const site = entranceSiteAt(this.seed, dcx, dcz,
      (x, z) => this.heightField.heightAt(x, z));
    const found: Entrance | null = site === null ? null
      : { dcx, dcz, ...site, name: this.specFor(dcx, dcz).name };
    this.cache.set(key, found);
    return found;
  }

  private specFor(dcx: number, dcz: number): DungeonSpec {
    return this.specProvider?.specFor(dcx, dcz)
      ?? DUNGEON_FIXTURES[mix32(this.seed, dcx, dcz) % DUNGEON_FIXTURES.length];
  }

  /** Lazily create the shared arch meshes + this entrance's draw pair. */
  private ensureEntranceDraws(e: Entrance): void {
    if (this.entranceProps === null) {
      const stone = buildEntranceStoneMesh();
      const glow = buildEntranceGlowMesh();
      const make = (label: string, data: Float32Array<ArrayBuffer>) => {
        const buffer = this.renderer.device.createBuffer({
          label,
          size: data.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.renderer.device.queue.writeBuffer(buffer, 0, data);
        return buffer;
      };
      // Zeroed lights: the surface shader path never reads them, but the
      // dungeon pipeline still requires a group-2 binding.
      const zeroLights = this.renderer.device.createBuffer({
        label: 'entrance-zero-lights',
        size: LIGHTS_BUFFER_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.entranceProps = {
        stoneBuffer: make('entrance-stone', stone),
        stoneCount: stone.length / 3,
        glowBuffer: make('entrance-glow', glow),
        glowCount: glow.length / 3,
        lightsBindGroup: this.renderer.createLightsBindGroup(zeroLights),
        draws: new Map(),
      };
    }
    const key = `${e.dcx},${e.dcz}`;
    const p = this.entranceProps;
    if (p.draws.has(key)) return;
    const stoneBg = this.renderer.createObjectBindGroup(e.x, e.y, e.z, 100).bindGroup;
    const glowBg = this.renderer.createObjectBindGroup(e.x, e.y, e.z, 103).bindGroup;
    p.draws.set(key, {
      entrance: e,
      draws: [
        {
          draw: { vertexBuffer: p.stoneBuffer, indexBuffer: null, count: p.stoneCount, bindGroup: stoneBg },
          lightsBindGroup: p.lightsBindGroup,
        },
        {
          draw: { vertexBuffer: p.glowBuffer, indexBuffer: null, count: p.glowCount, bindGroup: glowBg },
          lightsBindGroup: p.lightsBindGroup,
        },
      ],
    });
  }

  // --- interaction ---------------------------------------------------------

  private findInteraction(pos: Vec3): { label: string; act: () => void } | null {
    if (this.resident !== null) {
      const { layout, origin, chests } = this.resident;
      // Nearest of: exit portal + unopened chests, within reach.
      let best: { label: string; act: () => void } | null = null;
      let bestD = INTERACT_DIST;
      const wx = origin[0] + layout.exitPortalCell[0] + 0.5;
      const wz = origin[2] + layout.exitPortalCell[1] + 0.5;
      const portalD = Math.hypot(pos[0] - wx, pos[2] - wz);
      if (portalD <= bestD) {
        bestD = portalD;
        best = { label: 'Press E to leave the dungeon', act: () => this.exit() };
      }
      for (const chest of chests) {
        if (chest.opened) continue;
        const cx = origin[0] + chest.cell[0] + 0.5;
        const cz = origin[2] + chest.cell[1] + 0.5;
        const d = Math.hypot(pos[0] - cx, pos[2] - cz);
        if (d <= bestD) {
          bestD = d;
          best = { label: 'Press E to open the chest', act: () => this.openChest(chest) };
        }
      }
      return best;
    }
    for (const e of this.cache.values()) {
      if (e === null) continue;
      if (Math.hypot(pos[0] - e.x, pos[2] - e.z) <= INTERACT_DIST) {
        return {
          label: `Press E to enter ${e.name}`,
          act: () => {
            // Wait at the door until the Director's spec is final.
            if (this.specProvider !== null
                && !this.specProvider.isReady(e.dcx, e.dcz)) {
              this.specProvider.prioritize(e.dcx, e.dcz);
              this.notice = {
                text: 'The Director dreams… (the door will open soon)',
                until: performance.now() + NOTICE_MS,
              };
              return;
            }
            this.enter(e);
          },
        };
      }
    }
    return null;
  }

  private openChest(chest: ResidentChest): void {
    if (this.resident === null || chest.opened) return;
    chest.opened = true;
    this.chestsOpened++;
    const e = this.resident.entrance;
    const key = `${e.dcx},${e.dcz}`;
    let opened = this.openedChests.get(key);
    if (opened === undefined) {
      opened = new Set();
      this.openedChests.set(key, opened);
    }
    opened.add(this.resident.chests.indexOf(chest));
    // Palette swap wood → stone: the looted chest turns dull.
    const [x, z] = chest.cell;
    const o = this.resident.origin;
    this.renderer.device.queue.writeBuffer(chest.objectBuffer, 0,
      new Float32Array([o[0] + x + 0.5, o[1], o[2] + z + 0.5, 0]));
    const found = chest.items.map((id) => id.replace(/_/g, ' ')).join(', ');
    this.notice = { text: `Found: ${found}`, until: performance.now() + NOTICE_MS };
    this.onLoot?.(chest.items);
  }

  // --- lifecycle -----------------------------------------------------------

  private enter(e: Entrance): void {
    if (this.resident !== null) return;
    // Freeze the spec for this cell so re-entry reproduces this dungeon.
    this.specProvider?.onMaterialize(e.dcx, e.dcz);
    const spec = this.specFor(e.dcx, e.dcz);
    const layout = layoutDungeon(spec, mix32(this.seed, e.dcx, e.dcz));

    // Slot arena: float32-safe origins that never meet streamed terrain.
    // Reuse across (dcx, dcz) is safe ONLY because one interior is resident.
    const origin: Vec3 = [
      (((e.dcx % 8) + 8) % 8) * DCELL,
      -300,
      (((e.dcz % 8) + 8) % 8) * DCELL,
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

    // Torch point lights: count + pos/colorRadius per torch (shader group 2).
    const torches = buildTorchProps(layout);
    const lightsData = new Float32Array(LIGHTS_BUFFER_SIZE / 4);
    lightsData[0] = torches.lights.length;
    torches.lights.forEach(([lx, ly, lz], i) => {
      const base = 4 + i * 8;
      lightsData[base + 0] = origin[0] + lx;
      lightsData[base + 1] = origin[1] + ly;
      lightsData[base + 2] = origin[2] + lz;
      lightsData.set(TORCH_COLOR, base + 4);
      lightsData[base + 7] = TORCH_RADIUS;
    });
    const lightsBuffer = this.renderer.device.createBuffer({
      label: 'dungeon-lights',
      size: LIGHTS_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.renderer.device.queue.writeBuffer(lightsBuffer, 0, lightsData);
    buffers.push(lightsBuffer);
    const lightsBindGroup = this.renderer.createLightsBindGroup(lightsBuffer);

    // Interior shell + per-palette prop batches, all sharing the lights BG.
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
    addDraw(buildInteriorMesh(layout), `dungeon-mesh(${e.dcx},${e.dcz})`,
      makeObject(0).bindGroup);
    addDraw(torches.wood, 'dungeon-torch-wood', makeObject(1).bindGroup);
    addDraw(torches.flame, 'dungeon-torch-flame', makeObject(2).bindGroup);
    addDraw(buildPortalMesh(layout), 'dungeon-exit-portal', makeObject(3).bindGroup);

    // Chests: shared mesh, per-chest object uniform (position + palette).
    const dkey = `${e.dcx},${e.dcz}`;
    const chestVerts = buildChestMesh();
    const chestBuffer = layout.chests.length > 0
      ? makeVerts('dungeon-chest', chestVerts) : null;
    const chests: ResidentChest[] = layout.chests.map((c, i) => {
      const opened = this.openedChests.get(dkey)?.has(i) ?? false;
      const { bindGroup, buffer } = makeObject(
        opened ? 0 : 1,
        origin[0] + c.cell[0] + 0.5, origin[1], origin[2] + c.cell[1] + 0.5);
      draws.push({
        draw: {
          vertexBuffer: chestBuffer!,
          indexBuffer: null,
          count: chestVerts.length / 3,
          bindGroup,
        },
        lightsBindGroup,
      });
      return { cell: c.cell, items: c.items, objectBuffer: buffer, opened };
    });

    const collider = new DungeonCollider(layout, origin);
    this.resident = { entrance: e, layout, collider, origin, draws, chests, buffers };

    this.controller.world = collider;
    this.controller.pos = [
      origin[0] + layout.spawnCell[0] + 0.5,
      origin[1],
      origin[2] + layout.spawnCell[1] + 0.5,
    ];
    this.controller.velY = 0;
    this.camera.interior = collider;
  }

  private exit(): void {
    if (this.resident === null) return;
    const e = this.resident.entrance;
    for (const b of this.resident.buffers) b.destroy();
    this.resident = null;

    this.controller.world = this.terrain;
    const ex = e.x;
    const ez = e.z + EXIT_OFFSET;
    this.controller.pos = [ex, this.heightField.heightAt(ex, ez) + 0.1, ez];
    this.controller.velY = 0;
    this.camera.interior = null;
  }

  // --- debug hooks (e2e) ---------------------------------------------------

  /** Nearest discovered/discoverable entrance within ±5 dungeon cells. */
  debugNearestEntrance(): Entrance | null {
    const p = this.controller.pos;
    const dcx0 = Math.floor(p[0] / DCELL);
    const dcz0 = Math.floor(p[2] / DCELL);
    let best: Entrance | null = null;
    let bestD = Infinity;
    for (let dz = -5; dz <= 5; dz++) {
      for (let dx = -5; dx <= 5; dx++) {
        const e = this.entrance(dcx0 + dx, dcz0 + dz);
        if (e === null) continue;
        const d = Math.hypot(p[0] - e.x, p[2] - e.z);
        if (d < bestD) {
          bestD = d;
          best = e;
        }
      }
    }
    return best;
  }

  /** Enter the nearest entrance within ±5 dungeon cells. Returns success. */
  debugEnterNearest(): boolean {
    if (this.resident !== null) return true;
    const best = this.debugNearestEntrance();
    if (best === null) return false;
    this.enter(best);
    return true;
  }

  /** Teleport the player to the nearest surface entrance (E-key reach). */
  debugTeleportToNearestEntrance(): boolean {
    if (this.resident !== null) return false;
    const best = this.debugNearestEntrance();
    if (best === null) return false;
    this.controller.pos = [best.x, best.y + 0.1, best.z];
    this.controller.velY = 0;
    return true;
  }

  /** Teleport next to the nearest unopened chest. Returns success. */
  debugTeleportToNearestChest(): boolean {
    if (this.resident === null) return false;
    const { chests, origin } = this.resident;
    const p = this.controller.pos;
    let best: ResidentChest | null = null;
    let bestD = Infinity;
    for (const chest of chests) {
      if (chest.opened) continue;
      const d = Math.hypot(
        p[0] - (origin[0] + chest.cell[0] + 0.5),
        p[2] - (origin[2] + chest.cell[1] + 0.5));
      if (d < bestD) {
        bestD = d;
        best = chest;
      }
    }
    if (best === null) return false;
    this.controller.pos = [
      origin[0] + best.cell[0] + 0.5,
      origin[1],
      origin[2] + best.cell[1] + 0.5,
    ];
    this.controller.velY = 0;
    return true;
  }

  /** Teleport the player onto the resident interior's exit portal cell. */
  debugTeleportToExit(): void {
    if (this.resident === null) return;
    const { layout, origin } = this.resident;
    this.controller.pos = [
      origin[0] + layout.exitPortalCell[0] + 0.5,
      origin[1],
      origin[2] + layout.exitPortalCell[1] + 0.5,
    ];
    this.controller.velY = 0;
  }
}
