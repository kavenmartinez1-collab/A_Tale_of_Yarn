/**
 * Entity / creature type definitions — species catalogue, spawn constants.
 *
 * Pure data module: no DOM, no GPU, no side-effects. Imported by both the
 * scatter logic (entity-scatter.ts) and the future entity manager.
 */

import type { GameItemId } from '../items';
import type { Biome } from '../biome';

export type Species =
  | 'rabbit'
  | 'deer'
  | 'bird'
  | 'horse'
  | 'cow'
  | 'donkey'
  | 'dragon'
  | 'griffin'
  | 'sea_serpent';

export interface SpeciesDef {
  name: string;
  /** Approximate shoulder height (m). */
  size: number;
  /** Wander / flee speed (m/s). */
  speed: number;
  /** Riding speed (m/s) — only present when mountable === true. */
  mountSpeed?: number;
  /** Starting hit-points. */
  hp: number;
  /** True for dragon / griffin / sea_serpent. */
  rare: boolean;
  /** Player can ride this species. */
  mountable: boolean;
  /** Item the species will follow when held by the player. */
  favoriteFood?: GameItemId;
  /** Attacks the player on sight. */
  aggro: boolean;
  /** Biomes where this species may spawn. */
  biomes: Biome[];
  /** Spawns in ocean water (h < -8). */
  water?: boolean;
}

export const SPECIES_DEFS: Record<Species, SpeciesDef> = {
  rabbit: {
    name: 'Rabbit',
    size: 0.4,
    speed: 3,
    hp: 3,
    rare: false,
    mountable: false,
    aggro: false,
    biomes: ['plains', 'forest', 'dense_forest'],
  },
  deer: {
    name: 'Deer',
    size: 1.2,
    speed: 4.5,
    hp: 8,
    rare: false,
    mountable: false,
    aggro: false,
    biomes: ['forest', 'dense_forest', 'mountain_forest', 'plains'],
  },
  bird: {
    name: 'Bird',
    size: 0.3,
    speed: 5,
    hp: 2,
    rare: false,
    mountable: false,
    aggro: false,
    // All land biomes except desert and alpine.
    biomes: ['beach', 'plains', 'forest', 'dense_forest', 'jungle', 'mountain_forest'],
  },
  horse: {
    name: 'Horse',
    size: 1.6,
    speed: 5,
    mountSpeed: 14,
    hp: 20,
    rare: false,
    mountable: true,
    favoriteFood: 'healing_herb',
    aggro: false,
    biomes: ['plains', 'forest'],
  },
  cow: {
    name: 'Cow',
    size: 1.4,
    speed: 1.5,
    mountSpeed: 10.5,
    hp: 16,
    rare: false,
    mountable: true,
    favoriteFood: 'flax',
    aggro: false,
    biomes: ['plains'],
  },
  donkey: {
    name: 'Donkey',
    size: 1.3,
    speed: 2.5,
    mountSpeed: 11,
    hp: 14,
    rare: false,
    mountable: true,
    favoriteFood: 'cactus_flesh',
    aggro: false,
    biomes: ['desert', 'plains', 'beach'],
  },
  dragon: {
    name: 'Dragon',
    size: 3.5,
    speed: 6,
    mountSpeed: 18,
    hp: 80,
    rare: true,
    mountable: true,
    favoriteFood: 'meat_cooked',
    aggro: true,
    biomes: ['alpine', 'mountain_forest'],
  },
  griffin: {
    name: 'Griffin',
    size: 2.2,
    speed: 7,
    mountSpeed: 16,
    hp: 50,
    rare: true,
    mountable: true,
    favoriteFood: 'meat_raw',
    aggro: true,
    // mountain_forest added so the demo seed has a reachable wild griffin
    // (alpine-only left the nearest one ~24 km from spawn).
    biomes: ['alpine', 'mountain_forest'],
  },
  sea_serpent: {
    name: 'Sea Serpent',
    size: 4.0,
    speed: 6,
    hp: 60,
    rare: true,
    mountable: false,
    aggro: true,
    biomes: ['ocean'],
    water: true,
  },
};

/** Dragon flight is enabled — demo flight pass active. */
export const DRAGON_FLIGHT_ENABLED = true;

/** Entity scatter cell size (m) — same grid as settlement/dungeon cells. */
export const ECELL = 512;
