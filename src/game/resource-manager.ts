/**
 * ResourceManager — streams gatherable nodes (rocks, berry bushes, and the
 * forest's own trees) around the player. Rocks/bushes render as palette-
 * batched world-space meshes through the dungeon pipeline's surface path
 * (like settlements); trees stay in the instanced tree pipeline, hidden via
 * ChunkManager.treeFilter when chopped.
 *
 * Harvest state lives in NodeRegistry (persisted, respawn after 3 min);
 * this class watches it and rebuilds a chunk's mesh / refreshes its tree
 * instances whenever a node there is gathered or respawns.
 *
 * Phase F2: biomeField threaded in for biome-gated tree scatter.
 */

import type { Vec3 } from './math';
import type { HeightField } from './noise';
import type { BiomeField } from './biome';
import { LIGHTS_BUFFER_SIZE, STRIDE_PROP, type DungeonDraw, type Renderer } from './renderer';
import { CHUNK_SIZE } from './terrain/chunk-mesh';
import { resourcesForChunk, type ResourceInstance } from './resource-scatter';
import { treesForChunk, type TreeInstance } from './tree-scatter';
import { buildResourceMeshes } from './resource-mesh';
import type { NodeRegistry } from './resource-nodes';

const RES_CHUNK_RADIUS = 3; // meshed rocks/bushes: 7×7 chunks (~450 m)

export type NodeType = 'rock' | 'bush' | 'tree'
  | 'flax' | 'mushroom' | 'cooling_herb' | 'warming_herb'
  | 'barrel_cactus' | 'reeds' | 'gourd' | 'ore_rock';

/** A gatherable node in the world (deterministic identity). */
export interface WorldNode {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  z: number;
  cx: number;
  cz: number;
}

interface ActiveChunk {
  draws: DungeonDraw[];
  buffers: GPUBuffer[];
  /** Harvest signature the meshes were built with. */
  sig: string;
}

export class ResourceManager {
  private readonly resCache = new Map<string, ResourceInstance[]>();
  private readonly treeCache = new Map<string, TreeInstance[]>();
  private readonly active = new Map<string, ActiveChunk>();
  /** Tree-harvest signature per chunk, to know when to refresh instances. */
  private readonly treeSig = new Map<string, string>();
  private readonly palBindGroups =
    new Map<number, { bindGroup: GPUBindGroup; shadowBindGroup: GPUBindGroup }>();
  private lightsBindGroup: GPUBindGroup | null = null;

  /** Wired by main.ts to ChunkManager.refreshTrees. */
  onTreesChanged: ((cx: number, cz: number) => void) | null = null;

  constructor(
    private readonly renderer: Renderer,
    private readonly heightField: HeightField,
    private readonly seed: number,
    readonly registry: NodeRegistry,
    private readonly biomeField?: BiomeField,
  ) {}

  private resources(cx: number, cz: number): ResourceInstance[] {
    const key = `${cx},${cz}`;
    let r = this.resCache.get(key);
    if (r === undefined) {
      r = resourcesForChunk(this.seed, cx, cz,
        (x, z) => this.heightField.heightAt(x, z),
        this.biomeField !== undefined
          ? (x, z) => this.biomeField!.biomeAt(x, z)
          : undefined,
        this.heightField,
      );
      this.resCache.set(key, r);
    }
    return r;
  }

  private trees(cx: number, cz: number): TreeInstance[] {
    const key = `${cx},${cz}`;
    let t = this.treeCache.get(key);
    if (t === undefined) {
      t = treesForChunk(this.seed, cx, cz,
        (x, z) => this.heightField.heightAt(x, z),
        this.biomeField !== undefined
          ? (x, z) => this.biomeField!.biomeAt(x, z)
          : undefined,
      );
      this.treeCache.set(key, t);
    }
    return t;
  }

  /** ChunkManager.treeFilter hook: false = chopped (hidden). */
  treeVisible(cx: number, cz: number, index: number, now: number): boolean {
    return !this.registry.isHarvested(`${cx},${cz}:t${index}`, now);
  }

  /** Per-tick: (re)build resource meshes and refresh respawned trees. */
  update(pos: Vec3, now: number): void {
    const pcx = Math.floor(pos[0] / CHUNK_SIZE);
    const pcz = Math.floor(pos[2] / CHUNK_SIZE);

    // Drop far chunks (hysteresis +1).
    for (const [key, a] of this.active) {
      const [cx, cz] = key.split(',').map(Number);
      if (Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz)) > RES_CHUNK_RADIUS + 1) {
        for (const b of a.buffers) b.destroy();
        this.active.delete(key);
      }
    }

    for (let dz = -RES_CHUNK_RADIUS; dz <= RES_CHUNK_RADIUS; dz++) {
      for (let dx = -RES_CHUNK_RADIUS; dx <= RES_CHUNK_RADIUS; dx++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        this.ensureChunk(cx, cz, now);
        this.checkTrees(cx, cz, now);
      }
    }
  }

  /** Harvest signature: which of this chunk's rocks/bushes are gone. */
  private resSig(cx: number, cz: number, now: number): string {
    const n = this.resources(cx, cz).length;
    let sig = '';
    for (let i = 0; i < n; i++) {
      if (this.registry.isHarvested(`${cx},${cz}:r${i}`, now)) sig += `${i},`;
    }
    return sig;
  }

  private ensureChunk(cx: number, cz: number, now: number): void {
    const key = `${cx},${cz}`;
    const sig = this.resSig(cx, cz, now);
    const existing = this.active.get(key);
    if (existing !== undefined && existing.sig === sig) return;
    if (existing !== undefined) for (const b of existing.buffers) b.destroy();

    const visible = this.resources(cx, cz).filter((_, i) =>
      !this.registry.isHarvested(`${key}:r${i}`, now));
    const buffers: GPUBuffer[] = [];
    const draws: DungeonDraw[] = buildResourceMeshes(visible).map(
      ({ palette, verts }) => {
        const vertexBuffer = this.renderer.device.createBuffer({
          label: `resources-${key}-pal${palette}`,
          size: verts.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.renderer.device.queue.writeBuffer(vertexBuffer, 0, verts);
        buffers.push(vertexBuffer);
        const { bindGroup, shadowBindGroup } = this.paletteBindGroup(palette);
        return {
          draw: {
            vertexBuffer, indexBuffer: null, count: verts.length / (STRIDE_PROP / 4),
            bindGroup, shadowBindGroup,
          },
          lightsBindGroup: this.zeroLights(),
        };
      });
    this.active.set(key, { draws, buffers, sig });
  }

  /** Refresh a chunk's tree instances when chops/respawns change them. */
  private checkTrees(cx: number, cz: number, now: number): void {
    const key = `${cx},${cz}`;
    const n = this.trees(cx, cz).length;
    let sig = '';
    for (let i = 0; i < n; i++) {
      if (this.registry.isHarvested(`${key}:t${i}`, now)) sig += `${i},`;
    }
    if (this.treeSig.get(key) === sig) return;
    const known = this.treeSig.has(key);
    this.treeSig.set(key, sig);
    // First sight of a chunk only refreshes if something is already chopped.
    if (known || sig !== '') this.onTreesChanged?.(cx, cz);
  }

  draws(): DungeonDraw[] {
    const out: DungeonDraw[] = [];
    for (const a of this.active.values()) out.push(...a.draws);
    return out;
  }

  /**
   * Returns standing-tree positions within `radius` m of (x, z) as TreeRef
   * objects for canopy detection (shelter.ts canopyAt). Only returns unharvested
   * trees; rings=1 checks the 3×3 chunks around the player.
   */
  nearbyTreeRefs(x: number, z: number, radius: number, now: number): import('./shelter').TreeRef[] {
    const pcx = Math.floor(x / CHUNK_SIZE);
    const pcz = Math.floor(z / CHUNK_SIZE);
    const r2 = radius * radius;
    const out: import('./shelter').TreeRef[] = [];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        const ts = this.trees(cx, cz);
        ts.forEach((t, i) => {
          if (this.registry.isHarvested(`${cx},${cz}:t${i}`, now)) return;
          const d2 = (t.x - x) ** 2 + (t.z - z) ** 2;
          if (d2 <= r2) out.push({ x: t.x, y: t.y, z: t.z, scale: t.scale });
        });
      }
    }
    return out;
  }

  /**
   * Returns unharvested berry-bush positions within `radius` m of (x, z).
   * Mirrors nearbyTreeRefs (3×3 chunk scan) — used by fire spread.
   */
  nearbyBushRefs(
    x: number, z: number, radius: number, now: number,
  ): { x: number; y: number; z: number; scale: number }[] {
    const pcx = Math.floor(x / CHUNK_SIZE);
    const pcz = Math.floor(z / CHUNK_SIZE);
    const r2 = radius * radius;
    const out: { x: number; y: number; z: number; scale: number }[] = [];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        this.resources(cx, cz).forEach((r, i) => {
          if (r.type !== 'bush') return;
          if (this.registry.isHarvested(`${cx},${cz}:r${i}`, now)) return;
          const d2 = (r.x - x) ** 2 + (r.z - z) ** 2;
          if (d2 <= r2) out.push({ x: r.x, y: r.y, z: r.z, scale: r.scale });
        });
      }
    }
    return out;
  }

  /**
   * Nearest standing node within `reach` m (XZ) of pos, or null. `rings`
   * widens the chunk scan (debug/e2e); `type` filters the node kind.
   */
  nearestNode(
    pos: Vec3, reach: number, now: number, rings = 1, type: NodeType | null = null,
  ): WorldNode | null {
    const pcx = Math.floor(pos[0] / CHUNK_SIZE);
    const pcz = Math.floor(pos[2] / CHUNK_SIZE);
    let best: WorldNode | null = null;
    let bestD = reach;
    const consider = (node: WorldNode): void => {
      if (type !== null && node.type !== type) return;
      const d = Math.hypot(pos[0] - node.x, pos[2] - node.z);
      if (d <= bestD && !this.registry.isHarvested(node.id, now)) {
        bestD = d;
        best = node;
      }
    };
    for (let dz = -rings; dz <= rings; dz++) {
      for (let dx = -rings; dx <= rings; dx++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        this.resources(cx, cz).forEach((r, i) => consider({
          id: `${cx},${cz}:r${i}`, type: r.type as NodeType,
          x: r.x, y: r.y, z: r.z, cx, cz,
        }));
        this.trees(cx, cz).forEach((t, i) => consider({
          id: `${cx},${cz}:t${i}`, type: 'tree',
          x: t.x, y: t.y, z: t.z, cx, cz,
        }));
      }
    }
    return best;
  }

  private paletteBindGroup(palette: number): { bindGroup: GPUBindGroup; shadowBindGroup: GPUBindGroup } {
    let bg = this.palBindGroups.get(palette);
    if (bg === undefined) {
      // World-space verts: zero offset, sun-lit surface material.
      const { bindGroup, shadowBindGroup } = this.renderer.createObjectBindGroup(0, 0, 0, 100 + palette);
      bg = { bindGroup, shadowBindGroup };
      this.palBindGroups.set(palette, bg);
    }
    return bg;
  }

  private zeroLights(): GPUBindGroup {
    if (this.lightsBindGroup === null) {
      const zero = this.renderer.device.createBuffer({
        label: 'resource-zero-lights',
        size: LIGHTS_BUFFER_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.lightsBindGroup = this.renderer.createLightsBindGroup(zero);
    }
    return this.lightsBindGroup;
  }
}
