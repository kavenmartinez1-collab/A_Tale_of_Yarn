/**
 * Deterministic per-chunk resource-node scattering (rocks + berry bushes +
 * Phase F2 biome-specific nodes) — same pure idiom as tree-scatter.ts:
 * a function of (seed, chunk, heightfield) only, node-testable, no GPU.
 *
 * Rocks tolerate higher/steeper ground than bushes; both avoid dungeon
 * entrance and settlement clearings. A node's identity is "cx,cz:r{index}"
 * (index into this array) — stable because the scatter is deterministic.
 *
 * Phase F2 additions (biome-gated, same determinism discipline: fixed RNG
 * draw order, gate on biome/river AFTER the position+scale draws):
 *   plains         → flax bush        drops flax ×1-2, plant_fiber ×1
 *   forest/dense   → mushroom         drops mushroom ×1-2
 *   jungle         → cooling_herb     drops cooling_herb ×1
 *   alpine         → warming_herb     drops warming_herb ×1
 *   desert         → barrel cactus    drops cactus_flesh ×1-2
 *   river banks    → reeds + gourd    drops reeds ×1-2 / gourd ×1
 *   mountain_forest/alpine rock → ore variant (coal/copper_ore/tin_ore)
 *
 * RNG draw order within each attempt batch is identical regardless of
 * biome: x, z, scale are drawn first, then biome is queried (mirrors the
 * slope-rejection pattern in tree-scatter.ts).
 */

import { mulberry32 } from './mesh-utils';
import { mix32 } from './dungeon/dungeon-layout';
import { DCELL, entranceSiteAt } from './dungeon/entrance-site';
import { settlementSiteAt } from './settlement/settlement-scatter';
import { CHUNK_SIZE } from './terrain/chunk-mesh';
import type { Biome } from './biome';
import type { HeightField } from './noise';
import type { GameItemId } from './items';

const ROCK_ATTEMPTS  = 7;
const BUSH_ATTEMPTS  = 6;
const BIOME_ATTEMPTS = 5;  // per-biome special nodes
const RIVER_ATTEMPTS = 4;  // river bank nodes

const ROCK_MIN_H = 2;
const ROCK_MAX_H = 70;       // rocks climb into the foothills
const BUSH_MIN_H = 2;
const BUSH_MAX_H = 35;       // bushes stick to the lowlands
const BIOME_MIN_H = 2;
const BIOME_MAX_H = 200;  // must cover alpine (h≥90)
const MAX_SLOPE_DH = 1.6;    // over ±1.5 m
const CLEARING_R = 6;        // dungeon-entrance keep-out (m)
const MIN_SCALE = 0.8;
const MAX_SCALE = 1.6;

/** River bank detection constants. */
const RIVER_NODE_FACTOR = 0.05; // riverFactor threshold to count as "bank"
const RIVER_MIN_H = 0.5;
const RIVER_MAX_H = 6.0;

/** Pond/lake shore detection constants. */
const SHORE_ATTEMPTS = 3;     // extra attempts per chunk for pond-shore nodes
const SHORE_MIN_H = 0;        // SEA_LEVEL (h >= 0, just above water)
const SHORE_MAX_H = 1.5;      // shore band height above sea level
/** Cardinal probe distance (m) to check for adjacent below-sea-level water. */
const SHORE_PROBE = 3.0;

export type ResourceType =
  | 'rock'
  | 'bush'
  // Phase F2 biome nodes
  | 'flax'
  | 'mushroom'
  | 'cooling_herb'
  | 'warming_herb'
  | 'barrel_cactus'
  | 'reeds'
  | 'gourd'
  | 'ore_rock';  // rock variant that drops ores

/** Drop table entry: item id + min..max count. */
export interface DropEntry {
  id: GameItemId;
  min: number;
  max: number;
}

/** Drop table for each resource type (3-hit gather). */
export const RESOURCE_DROPS: Record<ResourceType, DropEntry[]> = {
  rock:         [{ id: 'stone', min: 2, max: 2 }, { id: 'ore', min: 1, max: 1 }],
  bush:         [{ id: 'berries', min: 3, max: 3 }],
  flax:         [{ id: 'flax', min: 1, max: 2 }, { id: 'plant_fiber', min: 1, max: 1 }],
  mushroom:     [{ id: 'mushroom', min: 1, max: 2 }],
  cooling_herb: [{ id: 'cooling_herb', min: 1, max: 1 }],
  warming_herb: [{ id: 'warming_herb', min: 1, max: 1 }],
  barrel_cactus:[{ id: 'cactus_flesh', min: 1, max: 2 }],
  reeds:        [{ id: 'reeds', min: 1, max: 2 }],
  gourd:        [{ id: 'gourd', min: 1, max: 1 }],
  ore_rock:     [{ id: 'stone', min: 1, max: 1 },
                 { id: 'coal', min: 0, max: 1 },
                 { id: 'copper_ore', min: 0, max: 1 },
                 { id: 'tin_ore', min: 0, max: 1 }],
};

/** Whether gathering this node type requires a pickaxe. */
export const REQUIRES_PICKAXE: Partial<Record<ResourceType, true>> = {
  rock:     true,
  ore_rock: true,
};

export interface ResourceInstance {
  type: ResourceType;
  x: number;
  y: number;
  z: number;
  scale: number;
}

export function resourcesForChunk(
  seed: number,
  cx: number,
  cz: number,
  heightAt: (x: number, z: number) => number,
  biomeAt?: (x: number, z: number) => Biome,
  heightField?: HeightField,
): ResourceInstance[] {
  const rng = mulberry32(mix32(seed ^ 0x0c5e11ed, cx, cz));

  // Same-cell dungeon/settlement clearings (cells = 512 m = 8 chunks).
  const dcx = Math.floor((cx * CHUNK_SIZE) / DCELL);
  const dcz = Math.floor((cz * CHUNK_SIZE) / DCELL);
  const entrance = entranceSiteAt(seed, dcx, dcz, heightAt);
  const settlement = settlementSiteAt(seed, dcx, dcz, heightAt);

  const out: ResourceInstance[] = [];

  /** Draw x, z, scale from RNG; check height + slope + clearings; return
   *  position or null. Always consumes the same 3 RNG values regardless of
   *  outcome so later attempts see the same sequence. */
  const tryPosition = (
    minH: number, maxH: number,
  ): { x: number; z: number; scale: number; h: number } | null => {
    const x = cx * CHUNK_SIZE + rng() * CHUNK_SIZE;
    const z = cz * CHUNK_SIZE + rng() * CHUNK_SIZE;
    const scale = MIN_SCALE + rng() * (MAX_SCALE - MIN_SCALE);
    const h = heightAt(x, z);
    if (h < minH || h > maxH) return null;
    const dh = Math.max(
      Math.abs(h - heightAt(x + 1.5, z)),
      Math.abs(h - heightAt(x, z + 1.5)),
    );
    if (dh > MAX_SLOPE_DH) return null;
    if (entrance !== null
        && Math.hypot(x - entrance.x, z - entrance.z) < CLEARING_R) return null;
    if (settlement !== null
        && Math.hypot(x - settlement.x, z - settlement.z)
           < settlement.radius + 2) return null;
    return { x, z, scale, h };
  };

  // --- Original rock attempts (always run for stable rock node indices) ---
  for (let i = 0; i < ROCK_ATTEMPTS; i++) {
    const pos = tryPosition(ROCK_MIN_H, ROCK_MAX_H);
    if (pos === null) continue;

    // Phase F2: mountain_forest/alpine rocks may be ore veins.
    let type: ResourceType = 'rock';
    if (biomeAt !== undefined) {
      const b = biomeAt(pos.x, pos.z);
      if (b === 'mountain_forest' || b === 'alpine') {
        type = 'ore_rock';
      }
    }

    out.push({ type, x: pos.x, y: pos.h - 0.1, z: pos.z, scale: pos.scale });
  }

  // --- Original bush attempts (always run for stable bush node indices) ---
  for (let i = 0; i < BUSH_ATTEMPTS; i++) {
    const pos = tryPosition(BUSH_MIN_H, BUSH_MAX_H);
    if (pos === null) continue;
    out.push({ type: 'bush', x: pos.x, y: pos.h - 0.1, z: pos.z, scale: pos.scale });
  }

  // --- Phase F2 biome-specific nodes (appended after rocks/bushes) --------
  if (biomeAt !== undefined) {
    // Determine chunk centre biome for a quick pre-filter (avoid per-attempt
    // biome queries on chunks that clearly won't match).
    const cxWorld = (cx + 0.5) * CHUNK_SIZE;
    const czWorld = (cz + 0.5) * CHUNK_SIZE;
    const centreBiome = biomeAt(cxWorld, czWorld);

    // Only bother with biome-specific passes when the centre biome is
    // relevant — edge chunks with a different biome at the candidate site
    // are handled by the per-site biome check below.
    const mayCareAboutBiome =
      centreBiome === 'plains'
      || centreBiome === 'forest'
      || centreBiome === 'dense_forest'
      || centreBiome === 'jungle'
      || centreBiome === 'alpine'
      || centreBiome === 'mountain_forest'
      || centreBiome === 'desert';

    if (mayCareAboutBiome) {
      for (let i = 0; i < BIOME_ATTEMPTS; i++) {
        const pos = tryPosition(BIOME_MIN_H, BIOME_MAX_H);
        if (pos === null) continue;
        const b = biomeAt(pos.x, pos.z);
        let type: ResourceType | null = null;
        switch (b) {
          case 'plains':
            type = 'flax';
            break;
          case 'forest':
          case 'dense_forest':
            type = 'mushroom';
            break;
          case 'jungle':
            type = 'cooling_herb';
            break;
          case 'alpine':
            type = 'warming_herb';
            break;
          case 'desert':
            type = 'barrel_cactus';
            break;
          default:
            break;
        }
        if (type === null) continue;
        out.push({ type, x: pos.x, y: pos.h - 0.1, z: pos.z, scale: pos.scale });
      }
    }
  }

  // --- Phase F2 river bank nodes (reeds + gourd) --------------------------
  if (heightField !== undefined) {
    for (let i = 0; i < RIVER_ATTEMPTS; i++) {
      const x = cx * CHUNK_SIZE + rng() * CHUNK_SIZE;
      const z = cz * CHUNK_SIZE + rng() * CHUNK_SIZE;
      const scale = MIN_SCALE + rng() * (MAX_SCALE - MIN_SCALE);
      const h = heightAt(x, z);
      if (h < RIVER_MIN_H || h > RIVER_MAX_H) continue;
      if (heightField.riverFactor(x, z) < RIVER_NODE_FACTOR) continue;
      if (entrance !== null
          && Math.hypot(x - entrance.x, z - entrance.z) < CLEARING_R) continue;
      if (settlement !== null
          && Math.hypot(x - settlement.x, z - settlement.z)
             < settlement.radius + 2) continue;
      // Alternate reeds / gourd by attempt index for variety.
      const type: ResourceType = (i % 2 === 0) ? 'reeds' : 'gourd';
      out.push({ type, x, y: h - 0.1, z, scale });
    }
  }

  // --- Pond/lake shore nodes (reeds + gourd near inland standing water) ----
  // Must consume RNG after the river block so earlier attempts are unchanged.
  if (biomeAt !== undefined && heightField !== undefined) {
    for (let i = 0; i < SHORE_ATTEMPTS; i++) {
      const x = cx * CHUNK_SIZE + rng() * CHUNK_SIZE;
      const z = cz * CHUNK_SIZE + rng() * CHUNK_SIZE;
      const scale = MIN_SCALE + rng() * (MAX_SCALE - MIN_SCALE);
      const h = heightAt(x, z);
      // Must be in the shore band just above sea level.
      if (h < SHORE_MIN_H || h > SHORE_MAX_H) continue;
      // Biome must not be ocean or beach (those are salt water).
      const b = biomeAt(x, z);
      if (b === 'ocean' || b === 'beach') continue;
      // At least one cardinal probe must be below sea level (the pond itself).
      const hasWaterAdjacent =
        heightAt(x + SHORE_PROBE, z) < 0 ||
        heightAt(x - SHORE_PROBE, z) < 0 ||
        heightAt(x, z + SHORE_PROBE) < 0 ||
        heightAt(x, z - SHORE_PROBE) < 0;
      if (!hasWaterAdjacent) continue;
      if (entrance !== null
          && Math.hypot(x - entrance.x, z - entrance.z) < CLEARING_R) continue;
      if (settlement !== null
          && Math.hypot(x - settlement.x, z - settlement.z)
             < settlement.radius + 2) continue;
      // Alternate reeds / gourd by attempt index.
      const type: ResourceType = (i % 2 === 0) ? 'reeds' : 'gourd';
      out.push({ type, x, y: h - 0.1, z, scale });
    }
  }

  return out;
}
