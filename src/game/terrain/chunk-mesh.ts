/**
 * Terrain chunk meshing — CPU vertex generation.
 *
 * A chunk is a 64x64-quad grid at 1 m spacing (65x65 vertices, 8,192 tris).
 * Vertices are 40 B: position float32x3 + normal float32x3 + tint float32x3
 * + road float32.
 *   x/z chunk-LOCAL [0..64], y = world height; normal = smooth (per-vertex)
 *   surface normal from the analytic height field; tint = biome ground color;
 *   road = paved-surface weight, 0 off-road and 1 on a road centreline.
 * The chunk's world XZ origin lives in a per-chunk uniform.
 *
 * Roads live IN the terrain rather than on top of it. The alternative — a
 * ribbon mesh laid slightly above the ground — needs its own draw call per
 * chunk, its own shadow pipeline, and a lift big enough to beat depth precision
 * yet small enough not to read as a kerb; and the engine has no depth bias or
 * decal path to lean on (the only `depthBias` in the tree is on the shadow
 * cascades). A per-vertex weight costs one float, no draw calls, cannot
 * z-fight, and picks up shadows, SSAO, fog and the two-scale de-tiling for
 * free. The cost is that road edges resolve at the 1 m vertex grid — which the
 * shader's existing transition jitter turns into an asset, because a worn stone
 * path *should* have a ragged edge.
 *
 * Topology is identical for every chunk, so ONE shared uint16 index buffer
 * serves all chunks. Quad diagonals alternate by (i+j) parity for the
 * low-poly triangle pattern. All triangles are wound so their geometric
 * normal points +Y (front-facing for the renderer's ccw + cull-back state).
 *
 * Crack-free borders: vertex world coords are computed with INTEGER math
 * (cx * CHUNK_SIZE + i) before calling the noise — adjacent chunks evaluate
 * shared edge vertices at bitwise-identical inputs. Vertex normals are built
 * from a per-chunk scratch height array sampled with that same integer-math
 * world coordinate (extended by a 1-cell border), so a vertex shared by two
 * chunks resolves to a bitwise-identical normal in both — see
 * buildChunkVertices for the seam argument.
 */

import type { HeightField } from '../noise';
import type { BiomeField } from '../biome';
import type { RoadNetwork } from '../world/roads';

export const CHUNK_SIZE = 64;                       // meters, and quads per side
export const VERTS_PER_SIDE = CHUNK_SIZE + 1;       // 65
export const VERTEX_COUNT = VERTS_PER_SIDE * VERTS_PER_SIDE; // 4,225
export const INDEX_COUNT = CHUNK_SIZE * CHUNK_SIZE * 6;      // 24,576
/**
 * Bytes per vertex: position (12) + normal (12) + tint (12) + road (4) = 40 B.
 * Matches `STRIDE_CREATURE` and its `creatureAttrs`, so the terrain pipeline
 * reuses that attribute layout and the existing `propPipeline40` shadow
 * pipeline — a new stride would otherwise need a matching shadow pipeline, and
 * getting that wrong is what once scrambled every creature's shadow.
 */
export const VERTEX_STRIDE = 40;

/** Shared topology for every chunk. Build once, upload once. */
export function buildChunkIndices(): Uint16Array<ArrayBuffer> {
  const indices = new Uint16Array(INDEX_COUNT);
  let k = 0;
  for (let j = 0; j < CHUNK_SIZE; j++) {
    for (let i = 0; i < CHUNK_SIZE; i++) {
      const a = j * VERTS_PER_SIDE + i;         // (i,   j)
      const b = a + 1;                          // (i+1, j)
      const c = a + VERTS_PER_SIDE;             // (i,   j+1)
      const d = c + 1;                          // (i+1, j+1)
      if (((i + j) & 1) === 0) {
        // diagonal b-c
        indices[k++] = a; indices[k++] = c; indices[k++] = b;
        indices[k++] = b; indices[k++] = c; indices[k++] = d;
      } else {
        // diagonal a-d
        indices[k++] = a; indices[k++] = c; indices[k++] = d;
        indices[k++] = a; indices[k++] = d; indices[k++] = b;
      }
    }
  }
  return indices;
}

/**
 * Vertex data for chunk (cx, cz):
 *   [x_local, y_world, z_local, nx, ny, nz, r, g, b, road] × 4,225.
 * Stride = 40 B (float32x3 pos + float32x3 normal + float32x3 tint + f32 road).
 *
 * The road carve rides inside the same purity contract as the height: it is a
 * function of the exact integer world coordinate, so a border vertex resolves
 * identically from both chunks and the scratch border gives matching normals —
 * a carved road crosses a chunk seam with no crack and no pop.
 *
 * Normals are smooth (per-vertex, analytic), not per-face: at each vertex we
 * take the height field's central-difference gradient and convert it to a
 * unit normal —
 *   nx = (hL - hR) / (2e); ny = 1; nz = (hD - hU) / (2e);  normalize
 * — which points +Y on flat ground and tilts opposite the rising direction
 * of a slope. That sign convention is verified against buildChunkIndices'
 * winding: triangle (a, c, b) [(i,j), (i,j+1), (i+1,j)] has edges
 * c-a = (0, dh/dz, 1) and b-a = (1, dh/dx, 0), and the winding is documented
 * to face +Y, i.e. normal = (c-a)×(b-a) = (-dh/dx, 1, -dh/dz) — matching the
 * formula above term-for-term (nx = -dh/dx, nz = -dh/dz). Intuition: on a
 * slope rising toward +X, hR > hL, so nx = (hL-hR)/2e < 0 — the normal tilts
 * toward -X, away from the rise, as expected.
 *
 * Perf: heightAt() is a multi-octave FBM (baseHeightAt: 1 continent + 7
 * detail + up to 4 gated mountain octaves, PLUS riverFactor() calls
 * baseHeightAt() a second time), so naively sampling it 4x per vertex for
 * gradients (on top of the 1x already needed for position) would mean 5x
 * the height-field cost per chunk. Instead we sample it exactly once per
 * grid cell into a scratch height array covering the chunk plus a 1-cell
 * border, and take differences from that array — ~1.06x the calls instead
 * of 5x, with a memory cost of one extra Float32Array of ~18 KB.
 *
 * Seam safety of the scratch border: each sample uses the SAME
 * `cx * CHUNK_SIZE + i` integer formula as interior vertices, just with i
 * (and j) allowed to range over [-1, VERTS_PER_SIDE] instead of
 * [0, VERTS_PER_SIDE - 1]. Chunk coordinates and grid offsets are small
 * integers, so every worldX/worldZ here is an exact float64 integer with no
 * rounding — e.g. this chunk's border sample at i = VERTS_PER_SIDE
 * (worldX = cx*64 + 65) is bit-for-bit the same number the (cx+1) chunk
 * computes for its own interior sample at i' = 1 (worldX = (cx+1)*64 + 1).
 * Same heightAt(), same input float ⇒ same output float, so a vertex shared
 * by two chunks always sees identical hL/hR/hD/hU on both sides, and
 * therefore an identical normal. This is the same guarantee the file
 * already relies on for vertex positions, just extended one cell further
 * out on each side.
 */
export function buildChunkVertices(
  hf: HeightField,
  biomes: BiomeField,
  cx: number,
  cz: number,
  roads: RoadNetwork | null = null,
): Float32Array<ArrayBuffer> {
  const FLOATS_PER_VERTEX = VERTEX_STRIDE / 4; // 10: pos3 + normal3 + tint3 + road
  const verts = new Float32Array(VERTEX_COUNT * FLOATS_PER_VERTEX);

  // Scratch height field: one heightAt() sample per cell, covering the
  // chunk's VERTS_PER_SIDE × VERTS_PER_SIDE vertices plus a 1-cell border
  // (indices -1..VERTS_PER_SIDE in world space) so every vertex's 4
  // axis-neighbour samples are available without re-calling heightAt().
  //
  // `hf` here is the BASE field; the road carve is added in this same loop so
  // one road probe serves both the height and the surface mask. Sampling the
  // carved field and then probing again for the mask would double the query
  // count for no benefit.
  const SCRATCH_SIDE = VERTS_PER_SIDE + 2; // 67
  const heights = new Float32Array(SCRATCH_SIDE * SCRATCH_SIDE);
  const roadMask = new Float32Array(SCRATCH_SIDE * SCRATCH_SIDE);
  for (let sj = 0; sj < SCRATCH_SIDE; sj++) {
    const worldZ = cz * CHUNK_SIZE + (sj - 1); // integer, same formula as below
    const row = sj * SCRATCH_SIDE;
    for (let si = 0; si < SCRATCH_SIDE; si++) {
      const worldX = cx * CHUNK_SIZE + (si - 1); // integer, same formula as below
      const h = hf.heightAt(worldX, worldZ);
      heights[row + si] = roads === null
        ? h
        : h + roads.sampleAt(worldX, worldZ, h, roadMask, row + si);
    }
  }

  const e = 1.0; // sample step in world units == vertex grid spacing
  let k = 0;
  for (let j = 0; j < VERTS_PER_SIDE; j++) {
    const worldZ = cz * CHUNK_SIZE + j; // integer
    const sj = j + 1; // this vertex's row in the scratch grid
    for (let i = 0; i < VERTS_PER_SIDE; i++) {
      const worldX = cx * CHUNK_SIZE + i; // integer
      const si = i + 1; // this vertex's column in the scratch grid

      const height = heights[sj * SCRATCH_SIDE + si];
      const hL = heights[sj * SCRATCH_SIDE + (si - 1)]; // height(worldX - e)
      const hR = heights[sj * SCRATCH_SIDE + (si + 1)]; // height(worldX + e)
      const hD = heights[(sj - 1) * SCRATCH_SIDE + si]; // height(worldZ - e)
      const hU = heights[(sj + 1) * SCRATCH_SIDE + si]; // height(worldZ + e)

      let nx = (hL - hR) / (2 * e);
      let ny = 1;
      let nz = (hD - hU) / (2 * e);
      const invLen = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= invLen; ny *= invLen; nz *= invLen;

      const tint = biomes.tintAt(worldX, worldZ);

      verts[k++] = i;
      verts[k++] = height;
      verts[k++] = j;
      verts[k++] = nx;
      verts[k++] = ny;
      verts[k++] = nz;
      verts[k++] = tint[0];
      verts[k++] = tint[1];
      verts[k++] = tint[2];
      verts[k++] = roadMask[sj * SCRATCH_SIDE + si];
    }
  }
  return verts;
}
