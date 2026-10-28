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

import { STRIDE_PROP, type Renderer, type TerrainDraw, type TreeDraw } from '../renderer';
import type { HeightField } from '../noise';
import type { BiomeField } from '../biome';
import { buildTreeMesh } from '../tree-mesh';
import { buildCactusMesh, buildJungleMesh } from '../tree-mesh-variants';
import { treesForChunk, type TreeKind } from '../tree-scatter';
import { buildChunkIndices, buildChunkVertices, CHUNK_SIZE, INDEX_COUNT } from './chunk-mesh';
import { buildGrassTuftMesh, GRASS_TUFT_VERTS } from '../grass-mesh';
import { grassForChunk } from './grass-scatter';
import { carveRoads, sharedRoadNetwork, type RoadNetwork } from '../world/roads';
import { aabb } from '../render/frustum';

const LOAD_RADIUS = 6;                    // 13x13 = 169 chunks, 832 m square
const UNLOAD_RADIUS = LOAD_RADIUS + 1;    // hysteresis
/**
 * Mesh-generation budget, in main-thread milliseconds per frame.
 *
 * This was a fixed two chunks per frame. A chunk is ~2.5 ms of noise plus its
 * tree scatter, so two of them were 5-9 ms on top of whatever the frame
 * already cost — fine while standing in an empty field, a 33 ms frame at the
 * castle, where the frame starts at 12 ms. A time budget spends what the
 * machine has: a fast one still streams two or three chunks a frame, a slow
 * one streams one and keeps its frame. At least one chunk always loads, so a
 * teleport cannot stall the fill.
 */
const GEN_BUDGET_MS = 3.0;
/** Foliage instance scale range (tree-scatter.ts) — bounds must cover it. */
const TREE_MAX_SCALE = 1.5;
/**
 * Foliage sway (frame.wgsl windOffset) peaks at sway * gust = 0.13 * 1.5 *
 * 1.44 = 0.28 m; tree roots are sunk 0.15 m and the instance y is sampled
 * between the chunk's vertices. 2 m covers all of it with room to spare.
 */
const FOLIAGE_PAD = 2.0;

/**
 * Chebyshev radius of chunks that carry grass. 1 gives a 192 m square around
 * the player's own chunk, so even standing at a chunk corner there is 64 m of
 * turf ahead — comfortably past grass.wgsl's 58 m fade.
 */
const GRASS_RADIUS = 1;
/** Grass scatter is height-field heavy; build at most one chunk per frame. */
const GRASS_GENS_PER_FRAME = 1;

interface ChunkTreeDraws {
  draws: TreeDraw[];
  instanceBuffers: GPUBuffer[];
}

interface ChunkGrass {
  buffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  count: number;
  bounds: Float32Array;
}

interface LoadedChunk {
  draw: TerrainDraw;
  originBuffer: GPUBuffer;
  /** Per-kind instanced foliage for this chunk. */
  treeDraws: ChunkTreeDraws;
  /** Lowest and highest vertex of the chunk mesh (roads carved in). */
  minY: number;
  maxY: number;
  /** Ground clutter — only populated while the chunk is near the player. */
  grass: ChunkGrass | null;
  /**
   * Whether the scatter has already run for this chunk. Distinct from
   * `grass !== null`: plenty of chunks (ocean, desert, bare rock) legitimately
   * produce zero tufts, and without this flag one of them at the head of the
   * scan order would be retried forever and starve every chunk behind it.
   */
  grassTried: boolean;
  cx: number;
  cz: number;
}

export class ChunkManager {
  private readonly chunks = new Map<string, LoadedChunk>();
  private readonly indexBuffer: GPUBuffer;
  /** Shared mesh vertex buffers per kind. */
  private readonly treeVertexBuffers: Record<TreeKind, GPUBuffer>;
  private readonly treeVertexCounts: Record<TreeKind, number>;
  /** Largest horizontal reach and height of any tree mesh, at scale 1. */
  private readonly treeReach: number;
  private readonly treeHeight: number;
  private readonly grassVertexBuffer: GPUBuffer;
  private pending: Array<[cx: number, cz: number]> = [];
  private lastCx = Number.NaN;
  private lastCz = Number.NaN;
  /**
   * Optional per-tree visibility filter (chopped trees, E-M1); return false
   * to hide instance `index` of chunk (cx, cz). Call refreshTrees() after
   * the answer for a loaded chunk changes.
   */
  treeFilter: ((cx: number, cz: number, index: number) => boolean) | null = null;

  /** Roads, grown outward from castles. Pure, deterministic, chunk-local. */
  private readonly roadNetwork: RoadNetwork;
  /**
   * The base height field with the roads cut into it. Anything that touches the
   * GROUND — terrain mesh, collision, camera, foliage grounding — must use this
   * one, so the surface you see and the surface you stand on are the same
   * surface. Anything that DECIDES WHERE THINGS GO (settlement scatter, dungeon
   * entrances, resource nodes) must keep the base field, or the definition of a
   * road becomes circular. See `carveRoads`.
   */
  private readonly groundField: HeightField;

  constructor(
    private readonly renderer: Renderer,
    private readonly heightField: HeightField,
    private readonly biomeField: BiomeField,
  ) {
    // Shared per seed: the settlement manager's road travellers need the same
    // graph, and building a second copy would pay for every castle's Dijkstra
    // sweep twice for identical answers.
    this.roadNetwork = sharedRoadNetwork(heightField.seed, heightField);
    this.groundField = carveRoads(heightField, this.roadNetwork);
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
      oak:    oakVerts.length / (STRIDE_PROP / 4),
      cactus: cactusVerts.length / (STRIDE_PROP / 4),
      jungle: jungleVerts.length / (STRIDE_PROP / 4),
    };
    // Measured off the meshes rather than assumed, so a taller tree variant
    // cannot silently poke out of its chunk's culling box. Reach is the
    // RADIUS: foliageWorld yaws every instance by its own hash, so a canopy
    // vertex at (x, z) can land anywhere on the circle of radius hypot(x, z).
    let reach = 0;
    let height = 0;
    for (const data of [oakVerts, cactusVerts, jungleVerts]) {
      for (let i = 0; i < data.length; i += STRIDE_PROP / 4) {
        reach = Math.max(reach, Math.hypot(data[i], data[i + 2]));
        height = Math.max(height, data[i + 1]);
      }
    }
    this.treeReach = reach * TREE_MAX_SCALE + FOLIAGE_PAD;
    this.treeHeight = height * TREE_MAX_SCALE + FOLIAGE_PAD;

    this.grassVertexBuffer = makeVB('grass-tuft-mesh', buildGrassTuftMesh());
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
          chunk.grass?.buffer.destroy();
          this.chunks.delete(key);
        } else if (dist > GRASS_RADIUS && chunk.grassTried) {
          // Walked away: drop the clutter but keep the chunk resident.
          chunk.grass?.buffer.destroy();
          chunk.grass = null;
          chunk.grassTried = false;
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

    // At least one chunk, then as many more as the budget allows.
    if (this.pending.length > 0) {
      const t0 = performance.now();
      do {
        const [cx, cz] = this.pending.shift()!;
        this.loadChunk(cx, cz);
      } while (this.pending.length > 0 && performance.now() - t0 < GEN_BUDGET_MS);
    }

    // Grass for whatever is in range and does not have it yet, nearest first
    // and strictly budgeted — the scatter is height-field heavy.
    let built = 0;
    for (let cz = pcz - GRASS_RADIUS; cz <= pcz + GRASS_RADIUS; cz++) {
      for (let cx = pcx - GRASS_RADIUS; cx <= pcx + GRASS_RADIUS; cx++) {
        if (built >= GRASS_GENS_PER_FRAME) return;
        const chunk = this.chunks.get(`${cx},${cz}`);
        if (chunk === undefined || chunk.grassTried) continue;
        chunk.grass = this.buildGrass(cx, cz, chunk.minY, chunk.maxY);
        chunk.grassTried = true;
        built++;
      }
    }
  }

  /** Instanced grass tufts for one chunk, or null where nothing grows. */
  private buildGrass(cx: number, cz: number, minY: number, maxY: number): ChunkGrass | null {
    const { data, count } = grassForChunk(
      this.heightField.seed, cx, cz, this.groundField, this.biomeField,
      this.roadNetwork);
    if (count === 0) return null;

    const buffer = this.renderer.device.createBuffer({
      label: `grass-instances(${cx},${cz})`,
      size: data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.renderer.device.queue.writeBuffer(buffer, 0, data);
    return {
      buffer,
      bindGroup: this.renderer.createTreeInstanceBindGroup(buffer),
      count,
      // Blades are under half a metre at their largest scale and sway less
      // than that; the pad is the same one the trees use.
      bounds: aabb(
        cx * CHUNK_SIZE - FOLIAGE_PAD, minY - FOLIAGE_PAD, cz * CHUNK_SIZE - FOLIAGE_PAD,
        (cx + 1) * CHUNK_SIZE + FOLIAGE_PAD, maxY + FOLIAGE_PAD, (cz + 1) * CHUNK_SIZE + FOLIAGE_PAD),
    };
  }

  private loadChunk(cx: number, cz: number): void {
    const device = this.renderer.device;
    // The road network resolves its coverage lazily, so warm the chunk's own
    // footprint (plus the scratch border the mesher samples) up front. Doing it
    // here rather than inside the per-vertex query keeps the hot path a single
    // grid lookup.
    this.roadNetwork.ensureArea(
      cx * CHUNK_SIZE - 2, cz * CHUNK_SIZE - 2,
      (cx + 1) * CHUNK_SIZE + 2, (cz + 1) * CHUNK_SIZE + 2);
    const verts = buildChunkVertices(
      this.heightField, this.biomeField, cx, cz, this.roadNetwork);
    // Vertical extent for the culling box: y is the second float of each
    // 10-float vertex (chunk-mesh.ts VERTEX_STRIDE).
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 1; i < verts.length; i += 10) {
      const y = verts[i];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const vertexBuffer = device.createBuffer({
      label: `chunk(${cx},${cz})`,
      size: verts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertexBuffer, 0, verts);
    const { bindGroup, buffer, shadowBindGroup } =
      this.renderer.createObjectBindGroup(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);

    // Per-chunk instanced foliage (deterministic scatter, may be empty).
    const treeDraws = this.buildTreeDraws(cx, cz, minY, maxY);

    this.chunks.set(`${cx},${cz}`, {
      draw: {
        vertexBuffer, indexBuffer: this.indexBuffer, count: INDEX_COUNT,
        bindGroup, shadowBindGroup,
        // The mesh is exactly the chunk's footprint: vertex x/z run 0..64
        // from the origin and nothing in the vertex shader moves them.
        bounds: aabb(
          cx * CHUNK_SIZE, minY, cz * CHUNK_SIZE,
          (cx + 1) * CHUNK_SIZE, maxY, (cz + 1) * CHUNK_SIZE),
      },
      originBuffer: buffer,
      treeDraws,
      minY,
      maxY,
      grass: null,
      grassTried: false,
      cx,
      cz,
    });
  }

  /** Foliage instances for a chunk, split per kind, minus filtered (chopped) trees. */
  private buildTreeDraws(cx: number, cz: number, minY: number, maxY: number): ChunkTreeDraws {
    const device = this.renderer.device;
    // One box for every kind: the chunk footprint grown by the widest tree
    // at its largest scale, from the lowest root to the tallest crown.
    const bounds = aabb(
      cx * CHUNK_SIZE - this.treeReach, minY - FOLIAGE_PAD, cz * CHUNK_SIZE - this.treeReach,
      (cx + 1) * CHUNK_SIZE + this.treeReach, maxY + this.treeHeight,
      (cz + 1) * CHUNK_SIZE + this.treeReach);
    // Grounded on the carved field so trunks sit on the road-graded surface
    // rather than hovering over or sinking into it, then anything standing in
    // the road is dropped — a tree through the paving reads as a bug even
    // though the scatter was working exactly as written.
    const trees = treesForChunk(
      this.heightField.seed, cx, cz,
      (x, z) => this.groundField.heightAt(x, z),
      (x, z) => this.biomeField.biomeAt(x, z),
    // treeFilter is keyed by the instance's index in the RAW scatter (that is
    // how chopped trees are remembered), so it has to run before any other
    // filter shifts those indices.
    ).filter((_, i) => this.treeFilter?.(cx, cz, i) ?? true)
      .filter((t) => this.roadNetwork.maskAt(t.x, t.z) < 0.12);

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
        shadowBindGroup: this.renderer.createTreeShadowBindGroup(buf),
        bounds,
      });
    }

    return { draws, instanceBuffers };
  }

  /** Rebuild a loaded chunk's foliage after its treeFilter answers change. */
  refreshTrees(cx: number, cz: number): void {
    const chunk = this.chunks.get(`${cx},${cz}`);
    if (chunk === undefined) return;
    for (const b of chunk.treeDraws.instanceBuffers) b.destroy();
    chunk.treeDraws = this.buildTreeDraws(cx, cz, chunk.minY, chunk.maxY);
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

  /** Ground clutter draws. Grass casts no shadow — too fine to resolve, and
   *  the noise it adds to the shadow map costs more than it buys. */
  grassDraws(): TreeDraw[] {
    const out: TreeDraw[] = [];
    for (const c of this.chunks.values()) {
      if (c.grass === null) continue;
      out.push({
        vertexBuffer: this.grassVertexBuffer,
        vertexCount: GRASS_TUFT_VERTS,
        instanceBindGroup: c.grass.bindGroup,
        instanceCount: c.grass.count,
        bounds: c.grass.bounds,
      });
    }
    return out;
  }

  get count(): number {
    return this.chunks.size;
  }

  /**
   * The height field with roads cut into it — the ground as it is actually
   * rendered. Player and camera collision must use this, or the player walks
   * through a graded road cutting or floats above a causeway.
   *
   * It is deliberately NOT the field settlement/dungeon/resource placement
   * should see: those decide where things go, roads are derived from where they
   * went, and feeding this back would make the definition circular.
   */
  get ground(): HeightField {
    return this.groundField;
  }

  /** The road network, for road queries elsewhere (debug hooks, AI, UI). */
  get roads(): RoadNetwork {
    return this.roadNetwork;
  }
}
