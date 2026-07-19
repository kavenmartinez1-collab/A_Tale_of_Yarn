/**
 * Chunk streaming — keeps a square of terrain chunks resident around the
 * player, generating a bounded number of meshes per frame and destroying
 * GPU buffers for far-away chunks.
 *
 * Load radius R (Chebyshev) with unload at R+1 for hysteresis, so walking
 * along a chunk border doesn't thrash load/unload.
 *
 * Phase F2: per-kind tree meshes (oak / cactus / jungle) each with their
 * own instance buffer per chunk; biomeAt is threaded into treesForChunk.
 */

import type { Renderer, TerrainDraw, TreeDraw } from '../renderer';
import type { HeightField } from '../noise';
import type { BiomeField } from '../biome';
import { buildTreeMesh } from '../tree-mesh';
import { buildCactusMesh, buildJungleMesh } from '../tree-mesh-variants';
import { treesForChunk, type TreeKind } from '../tree-scatter';
import { buildChunkIndices, buildChunkVertices, CHUNK_SIZE, INDEX_COUNT } from './chunk-mesh';

const LOAD_RADIUS = 6;                    // 13x13 = 169 chunks, 832 m square
const UNLOAD_RADIUS = LOAD_RADIUS + 1;    // hysteresis
const GENS_PER_FRAME = 2;                 // mesh-generation budget

interface ChunkTreeDraws {
  draws: TreeDraw[];
  instanceBuffers: GPUBuffer[];
}

interface LoadedChunk {
  draw: TerrainDraw;
  originBuffer: GPUBuffer;
  /** Per-kind instanced foliage for this chunk. */
  treeDraws: ChunkTreeDraws;
  cx: number;
  cz: number;
}

export class ChunkManager {
  private readonly chunks = new Map<string, LoadedChunk>();
  private readonly indexBuffer: GPUBuffer;
  /** Shared mesh vertex buffers per kind. */
  private readonly treeVertexBuffers: Record<TreeKind, GPUBuffer>;
  private readonly treeVertexCounts: Record<TreeKind, number>;
  private pending: Array<[cx: number, cz: number]> = [];
  private lastCx = Number.NaN;
  private lastCz = Number.NaN;
  /**
   * Optional per-tree visibility filter (chopped trees, E-M1); return false
   * to hide instance `index` of chunk (cx, cz). Call refreshTrees() after
   * the answer for a loaded chunk changes.
   */
  treeFilter: ((cx: number, cz: number, index: number) => boolean) | null = null;

  constructor(
    private readonly renderer: Renderer,
    private readonly heightField: HeightField,
    private readonly biomeField: BiomeField,
  ) {
    const indexData = buildChunkIndices();
    this.indexBuffer = renderer.device.createBuffer({
      label: 'chunk-indices-shared',
      size: indexData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    renderer.device.queue.writeBuffer(this.indexBuffer, 0, indexData);

    // Build per-kind shared tree mesh vertex buffers.
    const oakVerts    = buildTreeMesh();
    const cactusVerts = buildCactusMesh();
    const jungleVerts = buildJungleMesh();

    const makeVB = (label: string, data: Float32Array<ArrayBuffer>): GPUBuffer => {
      const buf = renderer.device.createBuffer({
        label,
        size: data.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      renderer.device.queue.writeBuffer(buf, 0, data);
      return buf;
    };

    this.treeVertexBuffers = {
      oak:    makeVB('tree-mesh-oak',    oakVerts),
      cactus: makeVB('tree-mesh-cactus', cactusVerts),
      jungle: makeVB('tree-mesh-jungle', jungleVerts),
    };
    this.treeVertexCounts = {
      oak:    oakVerts.length / 3,
      cactus: cactusVerts.length / 3,
      jungle: jungleVerts.length / 3,
    };
  }

  /** Call once per frame with the player/camera world position. */
  update(x: number, z: number): void {
    const pcx = Math.floor(x / CHUNK_SIZE);
    const pcz = Math.floor(z / CHUNK_SIZE);

    // Recompute want/unload sets only when crossing a chunk border.
    if (pcx !== this.lastCx || pcz !== this.lastCz) {
      this.lastCx = pcx;
      this.lastCz = pcz;

      for (const [key, chunk] of this.chunks) {
        const dist = Math.max(Math.abs(chunk.cx - pcx), Math.abs(chunk.cz - pcz));
        if (dist > UNLOAD_RADIUS) {
          chunk.draw.vertexBuffer.destroy();
          chunk.originBuffer.destroy();
          for (const b of chunk.treeDraws.instanceBuffers) b.destroy();
          this.chunks.delete(key);
        }
      }

      this.pending = [];
      for (let cz = pcz - LOAD_RADIUS; cz <= pcz + LOAD_RADIUS; cz++) {
        for (let cx = pcx - LOAD_RADIUS; cx <= pcx + LOAD_RADIUS; cx++) {
          if (!this.chunks.has(`${cx},${cz}`)) this.pending.push([cx, cz]);
        }
      }
      // Nearest first.
      this.pending.sort((a, b) =>
        Math.max(Math.abs(a[0] - pcx), Math.abs(a[1] - pcz)) -
        Math.max(Math.abs(b[0] - pcx), Math.abs(b[1] - pcz)));
    }

    for (let n = 0; n < GENS_PER_FRAME && this.pending.length > 0; n++) {
      const [cx, cz] = this.pending.shift()!;
      this.loadChunk(cx, cz);
    }
  }

  private loadChunk(cx: number, cz: number): void {
    const device = this.renderer.device;
    const verts = buildChunkVertices(this.heightField, this.biomeField, cx, cz);
    const vertexBuffer = device.createBuffer({
      label: `chunk(${cx},${cz})`,
      size: verts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertexBuffer, 0, verts);
    const { bindGroup, buffer } = this.renderer.createObjectBindGroup(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);

    // Per-chunk instanced foliage (deterministic scatter, may be empty).
    const treeDraws = this.buildTreeDraws(cx, cz);

    this.chunks.set(`${cx},${cz}`, {
      draw: { vertexBuffer, indexBuffer: this.indexBuffer, count: INDEX_COUNT, bindGroup },
      originBuffer: buffer,
      treeDraws,
      cx,
      cz,
    });
  }

  /** Foliage instances for a chunk, split per kind, minus filtered (chopped) trees. */
  private buildTreeDraws(cx: number, cz: number): ChunkTreeDraws {
    const device = this.renderer.device;
    const trees = treesForChunk(
      this.heightField.seed, cx, cz,
      (x, z) => this.heightField.heightAt(x, z),
      (x, z) => this.biomeField.biomeAt(x, z),
    ).filter((_, i) => this.treeFilter?.(cx, cz, i) ?? true);

    // Bucket instances by kind.
    const buckets: Record<TreeKind, number[]> = { oak: [], cactus: [], jungle: [] };
    for (const t of trees) {
      buckets[t.kind].push(t.x, t.y, t.z, t.scale);
    }

    const draws: TreeDraw[] = [];
    const instanceBuffers: GPUBuffer[] = [];

    for (const kind of ['oak', 'cactus', 'jungle'] as TreeKind[]) {
      const data = buckets[kind];
      if (data.length === 0) continue;
      const fa = new Float32Array(data);
      const buf = device.createBuffer({
        label: `tree-instances(${cx},${cz})-${kind}`,
        size: fa.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(buf, 0, fa);
      instanceBuffers.push(buf);
      draws.push({
        vertexBuffer: this.treeVertexBuffers[kind],
        vertexCount: this.treeVertexCounts[kind],
        instanceBindGroup: this.renderer.createTreeInstanceBindGroup(buf),
        instanceCount: data.length / 4,
      });
    }

    return { draws, instanceBuffers };
  }

  /** Rebuild a loaded chunk's foliage after its treeFilter answers change. */
  refreshTrees(cx: number, cz: number): void {
    const chunk = this.chunks.get(`${cx},${cz}`);
    if (chunk === undefined) return;
    for (const b of chunk.treeDraws.instanceBuffers) b.destroy();
    chunk.treeDraws = this.buildTreeDraws(cx, cz);
  }

  draws(): TerrainDraw[] {
    return [...this.chunks.values()].map((c) => c.draw);
  }

  treeDraws(): TreeDraw[] {
    const out: TreeDraw[] = [];
    for (const c of this.chunks.values()) {
      out.push(...c.treeDraws.draws);
    }
    return out;
  }

  get count(): number {
    return this.chunks.size;
  }
}
