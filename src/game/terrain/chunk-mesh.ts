/**
 * Terrain chunk meshing — CPU vertex generation.
 *
 * A chunk is a 64x64-quad grid at 1 m spacing (65x65 vertices, 8,192 tris).
 * Vertices are 24 B: position float32x3 + tint float32x3.
 *   x/z chunk-LOCAL [0..64], y = world height; tint = biome ground color.
 * The chunk's world XZ origin lives in a per-chunk uniform.
 *
 * Topology is identical for every chunk, so ONE shared uint16 index buffer
 * serves all chunks. Quad diagonals alternate by (i+j) parity for the
 * low-poly triangle pattern. All triangles are wound so their geometric
 * normal points +Y (front-facing for the renderer's ccw + cull-back state).
 *
 * Crack-free borders: vertex world coords are computed with INTEGER math
 * (cx * CHUNK_SIZE + i) before calling the noise — adjacent chunks evaluate
 * shared edge vertices at bitwise-identical inputs.
 */

import type { HeightField } from '../noise';
import type { BiomeField } from '../biome';

export const CHUNK_SIZE = 64;                       // meters, and quads per side
export const VERTS_PER_SIDE = CHUNK_SIZE + 1;       // 65
export const VERTEX_COUNT = VERTS_PER_SIDE * VERTS_PER_SIDE; // 4,225
export const INDEX_COUNT = CHUNK_SIZE * CHUNK_SIZE * 6;      // 24,576
/** Bytes per vertex: position (12 B) + tint (12 B) = 24 B. */
export const VERTEX_STRIDE = 24;

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
 * Vertex data for chunk (cx, cz): [x_local, y_world, z_local, r, g, b] × 4225.
 * Stride = 24 B (float32x3 pos + float32x3 tint).
 */
export function buildChunkVertices(
  hf: HeightField,
  biomes: BiomeField,
  cx: number,
  cz: number,
): Float32Array<ArrayBuffer> {
  const verts = new Float32Array(VERTEX_COUNT * 6); // 6 floats per vertex
  let k = 0;
  for (let j = 0; j < VERTS_PER_SIDE; j++) {
    const worldZ = cz * CHUNK_SIZE + j; // integer
    for (let i = 0; i < VERTS_PER_SIDE; i++) {
      const worldX = cx * CHUNK_SIZE + i; // integer
      const tint = biomes.tintAt(worldX, worldZ);
      verts[k++] = i;
      verts[k++] = hf.heightAt(worldX, worldZ);
      verts[k++] = j;
      verts[k++] = tint[0];
      verts[k++] = tint[1];
      verts[k++] = tint[2];
    }
  }
  return verts;
}
