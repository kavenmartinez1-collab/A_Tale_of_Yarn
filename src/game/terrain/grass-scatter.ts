/**
 * Deterministic grass-tuft scatter for one terrain chunk.
 *
 * Placement is a jittered grid hashed from world cell coordinates, so it is
 * stable across sessions and identical either side of a chunk border.
 *
 * Tufts are suppressed where grass would not grow — below and near the
 * waterline, above the snow line, and on steep faces — which keeps beaches
 * and cliffs clean without any extra authoring.
 */

import { mulberry32 } from '../mesh-utils';
import type { HeightField } from '../noise';
import type { BiomeField } from '../biome';
import type { RoadNetwork } from '../world/roads';
import { CHUNK_SIZE } from './chunk-mesh';

/** Metres between grid cells before jitter. */
const SPACING = 0.95;
const CELLS = Math.floor(CHUNK_SIZE / SPACING);

/** Two vec4s per instance: (x, y, z, scale) and (r, g, b, phase). */
export const GRASS_FLOATS_PER_INSTANCE = 8;

export interface GrassScatter {
  /** Interleaved instance data, ready for a storage buffer. */
  data: Float32Array<ArrayBuffer>;
  count: number;
}

export function grassForChunk(
  seed: number, cx: number, cz: number,
  heightField: HeightField, biomeField: BiomeField,
  roads: RoadNetwork | null = null,
): GrassScatter {
  const rng = mulberry32(
    (Math.imul(cx, 0x9e3779b1) ^ Math.imul(cz, 0x85ebca77) ^ seed) >>> 0);
  const out: number[] = [];

  for (let j = 0; j < CELLS; j++) {
    for (let i = 0; i < CELLS; i++) {
      // Jitter inside the cell so the grid never reads as rows.
      const x = cx * CHUNK_SIZE + (i + 0.15 + rng() * 0.7) * SPACING;
      const z = cz * CHUNK_SIZE + (j + 0.15 + rng() * 0.7) * SPACING;
      const r = rng();

      // Nothing grows through paving. Thin out across the verge rather than
      // cutting hard, so turf creeps up to the stones instead of stopping on a
      // ruled line. Cheap enough to test first: off-road it is one coverage-cell
      // lookup, which is far less than the height sample it skips.
      if (roads !== null) {
        const paved = roads.maskAt(x, z);
        if (paved > 0.05 && r < paved * 1.35) continue;
      }

      const y = heightField.heightAt(x, z);
      // Waterline, snow line, and bare rock.
      if (y < 1.2 || y > 72) continue;

      // Slope from a forward difference. A central difference would be more
      // accurate, but this runs thousands of times per chunk on a multi-octave
      // height field — two extra samples instead of four halves the cost of
      // the whole scatter, and placement does not need the precision.
      const e = 1.0;
      const hx = heightField.heightAt(x + e, z) - y;
      const hz = heightField.heightAt(x, z + e) - y;
      const slope = 1 / Math.sqrt(1 + (hx * hx + hz * hz) / (e * e));
      if (slope < 0.62) continue;

      // Thin the coverage out as conditions worsen rather than cutting hard.
      const nearWater = Math.min(1, (y - 1.2) / 2.5);
      const nearSnow = Math.min(1, (72 - y) / 12);
      const slopeFade = Math.min(1, (slope - 0.62) / 0.18);
      if (r > nearWater * nearSnow * slopeFade * 0.96) continue;

      // Desert and beach get no turf at all — only the vegetated biomes.
      const biome = biomeField.biomeAt(x, z);
      if (biome === 'desert' || biome === 'beach' || biome === 'alpine'
        || biome === 'ocean') continue;

      const tint = biomeField.tintAt(x, z);
      // Dry, yellowed tufts mixed through the green.
      const dry = rng();
      const warm = 0.85 + dry * 0.50;
      // Short: tall blades at this density read as a reed bed, not turf.
      const scale = 0.20 + rng() * 0.22;

      out.push(
        x, y, z, scale,
        tint[0] * warm * 1.55, tint[1] * (0.94 + dry * 0.26) * 1.55,
        tint[2] * (1.05 - dry * 0.30) * 1.55, rng() * 6.2831853,
      );
    }
  }

  const data = new Float32Array(out);
  return { data, count: out.length / GRASS_FLOATS_PER_INSTANCE };
}
