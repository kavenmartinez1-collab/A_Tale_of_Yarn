/**
 * Deterministic per-chunk tree scattering — pure function of
 * (seed, chunk, heightfield, biomeAt), node-testable, no GPU.
 *
 * Trees grow on the grass band: above the beach, below the snow line, on
 * gentle slopes, and never inside a dungeon-entrance or settlement clearing.
 * Density and scale come from the chunk's own PRNG stream, so streaming
 * order never changes the forest.
 *
 * Biome gating (Phase F2):
 *   - Per-biome density multiplier applied to ATTEMPTS.
 *   - Species (kind) determined per instance by biome at the candidate site.
 *   - RNG draw order is fixed regardless of biome (same x/z/scale draws
 *     happen for every attempt); biome-dependent acceptance/kind happens
 *     after all draws — same determinism discipline as slope rejection.
 */

import { mulberry32 } from './mesh-utils';
import { mix32 } from './dungeon/dungeon-layout';
import { DCELL, entranceSiteAt } from './dungeon/entrance-site';
import { settlementSiteAt } from './settlement/settlement-scatter';
import { CHUNK_SIZE } from './terrain/chunk-mesh';
import type { Biome } from './biome';

const ATTEMPTS = 40;        // candidate sites per 64 m chunk (at density 1.0)
const MIN_H = 2;            // above the beach/wet sand
const MAX_H = 42;           // below the snow line
const MAX_SLOPE_DH = 1.4;   // max |Δh| over ±1.5 m — no cliff trees
const CLEARING_R = 6;       // keep-out radius around a dungeon entrance (m)
const MIN_SCALE = 0.75;
const MAX_SCALE = 1.5;

/** Per-biome density multiplier on ATTEMPTS (approximate). */
const BIOME_DENSITY: Record<Biome, number> = {
  dense_forest:    1.6,
  jungle:          1.8,
  forest:          1.0,
  mountain_forest: 0.8,
  plains:          0.25,
  beach:           0.1,
  desert:          0.15,  // cactus only
  alpine:          0.0,   // treeline: no trees above
  ocean:           0.0,
};

export type TreeKind = 'oak' | 'cactus' | 'jungle';

export interface TreeInstance {
  x: number;
  y: number;
  z: number;
  scale: number;
  kind: TreeKind;
}

/** Determine tree species for a biome. Returns null to reject placement. */
function kindForBiome(biome: Biome): TreeKind | null {
  switch (biome) {
    case 'alpine':
    case 'ocean':
      return null; // no trees
    case 'desert':
      return 'cactus';
    case 'jungle':
      return 'jungle';
    default:
      return 'oak';
  }
}

export function treesForChunk(
  seed: number,
  cx: number,
  cz: number,
  heightAt: (x: number, z: number) => number,
  biomeAt?: (x: number, z: number) => Biome,
): TreeInstance[] {
  const rng = mulberry32(mix32(seed ^ 0x7ee5c0de, cx, cz));
  // Per-chunk density roll: some chunks are meadows, some are woods.
  const density = rng();

  // Compute a chunk-representative biome density multiplier from the centre.
  let biomeMul = 1.0;
  if (biomeAt !== undefined) {
    const cxWorld = (cx + 0.5) * CHUNK_SIZE;
    const czWorld = (cz + 0.5) * CHUNK_SIZE;
    const chunkBiome = biomeAt(cxWorld, czWorld);
    biomeMul = BIOME_DENSITY[chunkBiome];
  }

  const attempts = Math.floor(ATTEMPTS * density * density * biomeMul);
  if (attempts === 0) return [];

  // Chunks nest exactly inside dungeon cells (512 = 8 × 64): one entrance
  // clearing can affect this chunk, from the cell that contains it.
  const dcx = Math.floor((cx * CHUNK_SIZE) / DCELL);
  const dcz = Math.floor((cz * CHUNK_SIZE) / DCELL);
  const entrance = entranceSiteAt(seed, dcx, dcz, heightAt);
  // Same-cell settlement clearing (settlement cells = dungeon cells = 512 m).
  const settlement = settlementSiteAt(seed, dcx, dcz, heightAt);

  const out: TreeInstance[] = [];
  for (let i = 0; i < attempts; i++) {
    // Fixed draw order regardless of biome — gate on biome AFTER draws.
    const x = cx * CHUNK_SIZE + rng() * CHUNK_SIZE;
    const z = cz * CHUNK_SIZE + rng() * CHUNK_SIZE;
    const scale = MIN_SCALE + rng() * (MAX_SCALE - MIN_SCALE);
    const h = heightAt(x, z);
    if (h < MIN_H || h > MAX_H) continue;
    const dh = Math.max(
      Math.abs(h - heightAt(x + 1.5, z)),
      Math.abs(h - heightAt(x, z + 1.5)),
    );
    if (dh > MAX_SLOPE_DH) continue;
    if (entrance !== null
        && Math.hypot(x - entrance.x, z - entrance.z) < CLEARING_R) continue;
    if (settlement !== null
        && Math.hypot(x - settlement.x, z - settlement.z)
           < settlement.radius + 3) continue;

    // Biome gating: determine kind at the exact candidate position.
    // Reject if biome forbids trees at the site (alpine/ocean edge cases
    // where chunk-centre biome allows trees but the site biome does not).
    let kind: TreeKind = 'oak';
    if (biomeAt !== undefined) {
      const siteKind = kindForBiome(biomeAt(x, z));
      if (siteKind === null) continue;
      kind = siteKind;
    }

    out.push({ x, y: h - 0.15, z, scale, kind }); // sink the trunk slightly
  }
  return out;
}
