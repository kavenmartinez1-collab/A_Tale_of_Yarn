/**
 * Pure per-cell egg-nest scatter — deterministic, node-testable.
 *
 * Algorithm (one independent RNG stream per kind, salted separately):
 *
 *   SALT_BIRD    = 0xb17de99f
 *   SALT_DRAGON  = 0xd4a60c31
 *   SALT_GRIFFIN = 0x6f1c8a57
 *
 *   For each kind k:
 *     rng = mulberry32(mix32(seed ^ SALT_k, cx, cz))
 *
 *     presence roll: rng() < RATE_k  →  proceed; else no nests of this kind
 *     nestCount = kind-specific 1 or 2 (bird: 1 + floor(rng() * 2); others: 1)
 *
 *     For each nest i:
 *       up to 6 position candidates:
 *         x = cx*ECELL + rng()*ECELL
 *         z = cz*ECELL + rng()*ECELL
 *         accept if biomeAt(x,z) in allowed biomes AND heightAt(x,z) > 1
 *       if accepted: emit NestSite { id, kind, x, y=heightAt(x,z), z }
 *       if no candidate passes: skip this nest slot
 *
 * Presence rates:
 *   bird    ~35 % per cell, 1–2 nests
 *   dragon  ~ 6 % per cell, 1 nest
 *   griffin ~ 6 % per cell, 1 nest
 *
 * Biome gates:
 *   bird    → forest, dense_forest, jungle, mountain_forest
 *   dragon  → alpine, mountain_forest
 *   griffin → alpine
 *
 * Id format: nest_<kind>_<cx>_<cz>_<k>  (k = 0-based per-kind index)
 */

import { mulberry32 } from '../mesh-utils';
import { mix32 } from '../dungeon/dungeon-layout';
import { ECELL } from './entity-types';
import type { Biome } from '../biome';
import type { GameItemId } from '../items';

// ---------------------------------------------------------------------------
// Salts — distinct 32-bit constants, one per kind.
// ---------------------------------------------------------------------------

const SALT_BIRD    = 0xb17de99f;
const SALT_DRAGON  = 0xd4a60c31;
const SALT_GRIFFIN = 0x6f1c8a57;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type NestKind = 'bird' | 'dragon' | 'griffin';

export interface NestSite {
  /** Deterministic id: nest_<kind>_<cx>_<cz>_<k> */
  id: string;
  kind: NestKind;
  x: number;
  /** World-space terrain height at (x, z). */
  y: number;
  z: number;
}

// ---------------------------------------------------------------------------
// Internal per-kind config
// ---------------------------------------------------------------------------

interface KindConfig {
  salt: number;
  /** Presence probability per cell [0, 1]. */
  rate: number;
  /** Maximum number of nests to attempt when cell is present. */
  maxNests: number;
  /** Whether maxNests can vary (bird: 1–2; others: exactly 1). */
  varyCount: boolean;
  /** Allowed biomes for position candidates. */
  biomes: readonly Biome[];
}

const KIND_CONFIG: Record<NestKind, KindConfig> = {
  bird: {
    salt:      SALT_BIRD,
    rate:      0.35,
    maxNests:  2,
    varyCount: true,
    biomes:    ['forest', 'dense_forest', 'jungle', 'mountain_forest'],
  },
  dragon: {
    salt:      SALT_DRAGON,
    rate:      0.06,
    maxNests:  1,
    varyCount: false,
    biomes:    ['alpine', 'mountain_forest'],
  },
  griffin: {
    salt:      SALT_GRIFFIN,
    rate:      0.06,
    maxNests:  1,
    varyCount: false,
    biomes:    ['alpine'],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_POSITION_TRIES = 6;

function nestsForKind(
  kind: NestKind,
  seed: number,
  cx: number,
  cz: number,
  heightAt: (x: number, z: number) => number,
  biomeAt: (x: number, z: number) => Biome,
): NestSite[] {
  const cfg = KIND_CONFIG[kind];
  const rng = mulberry32(mix32(seed ^ cfg.salt, cx, cz));

  // Presence roll.
  if (rng() >= cfg.rate) return [];

  // Nest count (bird: 1–2; dragon/griffin: 1).
  const nestCount = cfg.varyCount ? 1 + Math.floor(rng() * cfg.maxNests) : cfg.maxNests;

  const sites: NestSite[] = [];
  const allowedBiomes = cfg.biomes as Biome[];

  for (let i = 0; i < nestCount; i++) {
    let placed = false;
    for (let t = 0; t < MAX_POSITION_TRIES; t++) {
      const x = cx * ECELL + rng() * ECELL;
      const z = cz * ECELL + rng() * ECELL;
      const biome = biomeAt(x, z);
      if (!allowedBiomes.includes(biome)) continue;
      const h = heightAt(x, z);
      if (h <= 1) continue;
      sites.push({
        id: `nest_${kind}_${cx}_${cz}_${i}`,
        kind,
        x,
        y: h,
        z,
      });
      placed = true;
      break;
    }
    // If no candidate passed in MAX_POSITION_TRIES, this nest slot is skipped.
    void placed;
  }

  return sites;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns all nest sites for the 512 m cell (cx, cz).
 * Pure function of its arguments — safe to call from any environment.
 *
 * @param seed     World seed.
 * @param cx       Cell x index (cell covers [cx*512, (cx+1)*512) m).
 * @param cz       Cell z index.
 * @param heightAt Terrain height query — must be the world HeightField's heightAt.
 * @param biomeAt  Biome query — must be the world BiomeField's biomeAt.
 */
export function nestsForCell(
  seed: number,
  cx: number,
  cz: number,
  heightAt: (x: number, z: number) => number,
  biomeAt: (x: number, z: number) => Biome,
): NestSite[] {
  const all: NestSite[] = [];
  for (const kind of ['bird', 'dragon', 'griffin'] as NestKind[]) {
    all.push(...nestsForKind(kind, seed, cx, cz, heightAt, biomeAt));
  }
  return all;
}

/**
 * Maps a nest kind to the corresponding egg item id.
 *
 * All three ids (egg_bird, egg_dragon, egg_griffin) exist in items.ts as of
 * the current codebase snapshot — no fallback needed.
 */
export function nestEggItem(kind: NestKind): GameItemId {
  const MAP: Record<NestKind, GameItemId> = {
    bird:    'egg_bird',
    dragon:  'egg_dragon',
    griffin: 'egg_griffin',
  };
  return MAP[kind];
}
