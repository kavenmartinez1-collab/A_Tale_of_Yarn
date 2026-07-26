/**
 * Dungeon interior mesh — turns a DungeonLayout cell grid into one
 * non-indexed position+normal vertex array (24 B/vertex, the shared "prop"
 * layout from mesh-utils.ts). Non-indexed on purpose: interiors exceed the
 * uint16 index range and TerrainDraw already supports indexBuffer: null.
 *
 * Winding: right-hand-rule vertex order points normals INTO the interior
 * (floors up, ceilings down, walls inward) so cull-back keeps every surface
 * visible from inside — and the computed vertex normals correctly point
 * inward too, which is what the shader wants for normal-offset shadow
 * biasing (this replaces the old fragment-shader dpdx/dpdy flat-normal
 * trick; see mesh-utils.ts).
 *
 * Coordinates are dungeon-local: cell (x,z) spans [x,x+1]x[z,z+1] m, floor
 * at y=0, ceiling at ceilY[cell]. The interior's world origin rides the
 * per-object uniform (group 1).
 */

import type { DungeonLayout } from './dungeon-layout';
import { CELL_SOLID } from './dungeon-layout';
import { quad } from '../mesh-utils';

export function buildInteriorMesh(layout: DungeonLayout): Float32Array<ArrayBuffer> {
  const { w, h, cells, ceilY } = layout;
  const verts: number[] = [];

  const walkable = (x: number, z: number): boolean =>
    x >= 0 && z >= 0 && x < w && z < h && cells[z * w + x] !== CELL_SOLID;
  const ceilAt = (x: number, z: number): number => ceilY[z * w + x];

  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      if (!walkable(x, z)) continue;
      const ch = ceilAt(x, z);

      // Floor (+Y) and ceiling (-Y).
      quad(verts, [x, 0, z], [x, 0, z + 1], [x + 1, 0, z + 1], [x + 1, 0, z]);
      quad(verts, [x, ch, z], [x + 1, ch, z], [x + 1, ch, z + 1], [x, ch, z + 1]);

      // Walls toward solid neighbors; lintel bands toward lower ceilings.
      // East neighbor -> wall at plane x+1, facing -X into this cell.
      if (!walkable(x + 1, z)) {
        quad(verts, [x + 1, 0, z], [x + 1, 0, z + 1], [x + 1, ch, z + 1], [x + 1, ch, z]);
      } else if (ceilAt(x + 1, z) < ch) {
        const y0 = ceilAt(x + 1, z);
        quad(verts, [x + 1, y0, z], [x + 1, y0, z + 1], [x + 1, ch, z + 1], [x + 1, ch, z]);
      }
      // West neighbor -> wall at plane x, facing +X.
      if (!walkable(x - 1, z)) {
        quad(verts, [x, 0, z + 1], [x, 0, z], [x, ch, z], [x, ch, z + 1]);
      } else if (ceilAt(x - 1, z) < ch) {
        const y0 = ceilAt(x - 1, z);
        quad(verts, [x, y0, z + 1], [x, y0, z], [x, ch, z], [x, ch, z + 1]);
      }
      // South neighbor (+z) -> wall at plane z+1, facing -Z.
      if (!walkable(x, z + 1)) {
        quad(verts, [x + 1, 0, z + 1], [x, 0, z + 1], [x, ch, z + 1], [x + 1, ch, z + 1]);
      } else if (ceilAt(x, z + 1) < ch) {
        const y0 = ceilAt(x, z + 1);
        quad(verts, [x + 1, y0, z + 1], [x, y0, z + 1], [x, ch, z + 1], [x + 1, ch, z + 1]);
      }
      // North neighbor (-z) -> wall at plane z, facing +Z.
      if (!walkable(x, z - 1)) {
        quad(verts, [x, 0, z], [x + 1, 0, z], [x + 1, ch, z], [x, ch, z]);
      } else if (ceilAt(x, z - 1) < ch) {
        const y0 = ceilAt(x, z - 1);
        quad(verts, [x, y0, z], [x + 1, y0, z], [x + 1, ch, z], [x, ch, z]);
      }
    }
  }

  return Float32Array.from(verts) as Float32Array<ArrayBuffer>;
}
