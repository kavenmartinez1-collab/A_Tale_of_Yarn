/**
 * Pure per-cell entity spawn-point generator — deterministic, node-testable.
 *
 * Algorithm summary (all draws from a single mulberry32 stream):
 *
 *   SALT = 0xec0517a7
 *   rng  = mulberry32(mix32(seed ^ SALT, cx, cz))
 *
 *   COMMON PASS — 2–5 groups per cell:
 *     groupCount = 2 + floor(rng() * 4)           // 2, 3, 4, or 5
 *     For each group:
 *       anchor x = cx*ECELL + rng()*ECELL          // uniformly in [0, ECELL)
 *       anchor z = cz*ECELL + rng()*ECELL
 *       biome    = biomeAt(anchor.x, anchor.z)
 *       eligible = common species whose .biomes includes this biome
 *       if none → skip group (no draws consumed beyond anchor + biome)
 *       species  = eligible[floor(rng() * eligible.length)]
 *       indivCount = 1 + floor(rng() * 3)          // 1, 2, or 3
 *       For each individual:
 *         jx = anchor.x + (rng()*2 - 1)*12         // ±12 m
 *         jz = anchor.z + (rng()*2 - 1)*12
 *         h  = heightAt(jx, jz)
 *         if species.water: skip if h >= -8
 *         else:             skip if h < 1
 *         else: emit EntitySpawn, id = "cx,cz:e{i}"
 *
 *   RARE PASS — single attempt per cell, probability 0.04:
 *     if rng() >= 0.04 → done
 *     anchor x = cx*ECELL + rng()*ECELL
 *     anchor z = cz*ECELL + rng()*ECELL
 *     biome    = biomeAt(anchor.x, anchor.z)
 *     eligible rare species:
 *       dragon   → biome in ['alpine', 'mountain_forest']
 *       griffin  → biome === 'alpine'
 *       sea_serpent → biome === 'ocean' AND heightAt(anchor.x, anchor.z) < -8
 *     if eligible list is non-empty:
 *       pick eligible[floor(rng() * eligible.length)]
 *       emit one EntitySpawn at anchor (no jitter for rares)
 *
 *   Id sequence: "cx,cz:e0", "cx,cz:e1", … in the order spawns are emitted.
 *   This is stable because the algorithm is fully deterministic.
 */

import { mulberry32 } from '../mesh-utils';
import { mix32 } from '../dungeon/dungeon-layout';
import { SPECIES_DEFS, ECELL, type Species } from './entity-types';
import type { Biome } from '../biome';

const SALT = 0xec0517a7;

/** A single entity spawn point produced by entitiesForCell. */
export interface EntitySpawn {
  /** Stable id in the form "cx,cz:e{i}" (i = 0-based emit order). */
  id: string;
  species: Species;
  x: number;
  z: number;
}

/** The common (non-rare) species list, derived once at module load. */
const COMMON_SPECIES = (Object.keys(SPECIES_DEFS) as Species[]).filter(
  (s) => !SPECIES_DEFS[s].rare,
);

/** The rare species list. */
const RARE_SPECIES = (Object.keys(SPECIES_DEFS) as Species[]).filter(
  (s) => SPECIES_DEFS[s].rare,
);

/**
 * Returns all entity spawn points for the 512 m cell (cx, cz).
 * Pure function of its arguments — safe to call from any environment.
 *
 * @param seed    World seed.
 * @param cx      Cell x index (cell covers [cx*512, (cx+1)*512) m).
 * @param cz      Cell z index.
 * @param heightAt Terrain height query.
 * @param biomeAt  Biome query.
 */
export function entitiesForCell(
  seed: number,
  cx: number,
  cz: number,
  heightAt: (x: number, z: number) => number,
  biomeAt: (x: number, z: number) => Biome,
): EntitySpawn[] {
  const rng = mulberry32(mix32(seed ^ SALT, cx, cz));
  const spawns: EntitySpawn[] = [];
  const prefix = `${cx},${cz}:e`;

  // ---- COMMON PASS --------------------------------------------------------
  const groupCount = 2 + Math.floor(rng() * 4); // 2–5
  for (let g = 0; g < groupCount; g++) {
    const ax = cx * ECELL + rng() * ECELL;
    const az = cz * ECELL + rng() * ECELL;
    const biome = biomeAt(ax, az);

    const eligible = COMMON_SPECIES.filter((s) =>
      SPECIES_DEFS[s].biomes.includes(biome),
    );
    if (eligible.length === 0) continue;

    const species = eligible[Math.floor(rng() * eligible.length)];
    const indivCount = 1 + Math.floor(rng() * 3); // 1–3

    for (let k = 0; k < indivCount; k++) {
      const jx = ax + (rng() * 2 - 1) * 12;
      const jz = az + (rng() * 2 - 1) * 12;
      const h = heightAt(jx, jz);
      const def = SPECIES_DEFS[species];
      if (def.water) {
        if (h >= -8) continue; // water species need deep water
      } else {
        if (h < 1) continue;   // land species need dry land
      }
      spawns.push({ id: `${prefix}${spawns.length}`, species, x: jx, z: jz });
    }
  }

  // ---- RARE PASS ----------------------------------------------------------
  if (rng() < 0.04) {
    const rx = cx * ECELL + rng() * ECELL;
    const rz = cz * ECELL + rng() * ECELL;
    const biome = biomeAt(rx, rz);
    const rh = heightAt(rx, rz);

    const eligibleRare = RARE_SPECIES.filter((s) => {
      if (s === 'dragon') return biome === 'alpine' || biome === 'mountain_forest';
      if (s === 'griffin') return biome === 'alpine' || biome === 'mountain_forest';
      if (s === 'sea_serpent') return biome === 'ocean' && rh < -8;
      return false;
    });

    if (eligibleRare.length > 0) {
      const species = eligibleRare[Math.floor(rng() * eligibleRare.length)];
      spawns.push({ id: `${prefix}${spawns.length}`, species, x: rx, z: rz });
    }
  }

  return spawns;
}
