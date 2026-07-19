/**
 * Taming / egg / growth model — pure, deterministic, engine/DOM-free.
 *
 * Implements:
 *  - Minecraft-inspired temper model for rare mountables (dragon, griffin).
 *  - Common mountables (horse, cow, donkey) are ridable without taming.
 *  - BOTW-ish care: egg incubation near a lit campfire, baby growth with
 *    food-acceleration shortcuts.
 *
 * Design authority: docs/MECHANICS.md § "Taming (Phase K)" and
 * § "Eggs & babies (Phase K)".
 *
 * Persistence key: TAMING_KEY = 'artifex-taming:v1'
 *
 * Phase K — no HUD, no main.ts wiring.
 */

import { SPECIES_DEFS, type Species } from './entity-types';

// ---------------------------------------------------------------------------
// Constants (all exported)
// ---------------------------------------------------------------------------

/** Temper value at which taming is considered complete. */
export const TAME_THRESHOLD        = 80;
/** Temper gained each time the creature bucks the player. */
export const TEMPER_PER_BUCK       = 5;
/** Temper gained when fed the creature's favorite food. */
export const TEMPER_PER_FEED       = 8;
/** Probability of being bucked on each untamed mount attempt. */
export const BUCK_CHANCE           = 0.5;

/** Heat-seconds near a lit campfire required to hatch an egg. */
export const EGG_HATCH_S           = 120;
/** Maximum distance (metres) from a lit campfire that counts as "near". */
export const EGG_HEAT_RADIUS       = 6;

/** Seconds of age for a baby to become an adult. */
export const GROWTH_S              = 1200;
/** Age-seconds added when a baby is fed its favorite food. */
export const FEED_GROWTH_BONUS_S   = 60;

/** localStorage key for the combined taming registry. */
export const TAMING_KEY            = 'artifex-taming:v1';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TamedState {
  /** Current temper value in [0, 100]. */
  temper: number;
  /** True once temper >= TAME_THRESHOLD. */
  tamed:  boolean;
}

export type EggSpecies = 'bird' | 'dragon' | 'griffin';

export interface EggState {
  species: EggSpecies;
  /** Accumulated heat-seconds while near a lit campfire. */
  heatS:   number;
  /** True once heatS >= EGG_HATCH_S. Idempotent after set. */
  hatched: boolean;
}

export interface GrowthState {
  species: Species;
  /** Accumulated age in seconds. */
  ageS:    number;
  /** True once ageS >= GROWTH_S. */
  adult:   boolean;
}

// ---------------------------------------------------------------------------
// Discriminated-union result for attemptMount
// ---------------------------------------------------------------------------

export type MountResult =
  | { result: 'bucked';        state: TamedState }
  | { result: 'accepted-ride'; state: TamedState }
  | { result: 'mounted';       state: TamedState }
  | { result: 'refused';       state: TamedState };

// ---------------------------------------------------------------------------
// Registry (combined persistence payload)
// ---------------------------------------------------------------------------

export interface TamingRegistry {
  tamed:  Record<string, TamedState>;
  eggs:   Record<string, EggState   & { x: number; z: number }>;
  babies: Record<string, GrowthState & { x: number; z: number }>;
}

// ---------------------------------------------------------------------------
// Helpers — derived from SPECIES_DEFS
// ---------------------------------------------------------------------------

/**
 * Returns true when a species must be tamed before riding.
 * Rule: mountable && rare (dragon, griffin).
 * Common mountables (horse/cow/donkey) are mountable but not rare → false.
 */
export function needsTaming(species: Species): boolean {
  const def = SPECIES_DEFS[species];
  return def.mountable && def.rare;
}

// ---------------------------------------------------------------------------
// TamedState factory
// ---------------------------------------------------------------------------

/** Create a fresh, untamed state at temper 0. */
export function createTamedState(): TamedState {
  return { temper: 0, tamed: false };
}

// ---------------------------------------------------------------------------
// Mount attempt
// ---------------------------------------------------------------------------

/**
 * Attempt to mount a creature.
 *
 * - Non-mountable species → 'refused' (no state change).
 * - Mountable, non-taming species (horse/cow/donkey) → 'mounted' immediately.
 * - Mountable, taming-required, already tamed → 'mounted'.
 * - Mountable, taming-required, untamed:
 *     rng() < BUCK_CHANCE → 'bucked'  (temper += TEMPER_PER_BUCK, clamp 100)
 *                         → 'accepted-ride' (temper unchanged — MC allows a
 *                                            temporary sit before the buck
 *                                            threshold is crossed)
 *   In both cases, if temper reaches TAME_THRESHOLD afterwards, tamed is set.
 *
 * The returned `state` is always a new object (immutable-style).
 *
 * @param state   Current TamedState for this individual creature.
 * @param species The species being mounted.
 * @param rng     0-arg function returning a uniform float in [0, 1).
 */
export function attemptMount(
  state:   TamedState,
  species: Species,
  rng:     () => number,
): MountResult {
  const def = SPECIES_DEFS[species];

  // Non-mountable → always refused.
  if (!def.mountable) {
    return { result: 'refused', state: { ...state } };
  }

  // Common mountable (not rare) — ride freely.
  if (!needsTaming(species)) {
    return { result: 'mounted', state: { ...state } };
  }

  // Rare mountable — already tamed.
  if (state.tamed) {
    return { result: 'mounted', state: { ...state } };
  }

  // Rare mountable — untamed: temper-based interaction.
  let temper = state.temper;
  let bucked: boolean;

  if (rng() < BUCK_CHANCE) {
    temper  = Math.min(100, temper + TEMPER_PER_BUCK);
    bucked  = true;
  } else {
    bucked  = false;
  }

  const tamed = temper >= TAME_THRESHOLD;
  const next: TamedState = { temper, tamed };
  return bucked
    ? { result: 'bucked',        state: next }
    : { result: 'accepted-ride', state: next };
}

// ---------------------------------------------------------------------------
// Feeding (taming)
// ---------------------------------------------------------------------------

/**
 * Feed a creature its favorite food to increase temper.
 *
 * Returns true and a mutated-copy state when `itemId` matches the species'
 * favoriteFood; returns false and the original state otherwise.
 *
 * Temper is clamped to 100; tamed is set when temper >= TAME_THRESHOLD.
 */
export function feed(
  state:   TamedState,
  species: Species,
  itemId:  string,
): { accepted: boolean; state: TamedState } {
  const fav = SPECIES_DEFS[species].favoriteFood;
  if (!fav || itemId !== fav) {
    return { accepted: false, state: { ...state } };
  }
  const temper = Math.min(100, state.temper + TEMPER_PER_FEED);
  const tamed  = temper >= TAME_THRESHOLD;
  return { accepted: true, state: { temper, tamed } };
}

// ---------------------------------------------------------------------------
// Egg incubation
// ---------------------------------------------------------------------------

/**
 * Advance an egg's incubation by `dtS` seconds.
 * Heat only accumulates while `nearLitFire` is true.
 * Once hatched the state is frozen (idempotent).
 *
 * Returns a new EggState object.
 */
export function heatEgg(egg: EggState, dtS: number, nearLitFire: boolean): EggState {
  if (egg.hatched) return { ...egg };
  const heatS  = nearLitFire
    ? Math.min(EGG_HATCH_S, egg.heatS + dtS)
    : egg.heatS;
  const hatched = heatS >= EGG_HATCH_S;
  return { ...egg, heatS, hatched };
}

// ---------------------------------------------------------------------------
// Baby growth
// ---------------------------------------------------------------------------

/**
 * Advance a baby's age by `dtS` seconds.
 * Returns a new GrowthState; adult is set when ageS >= GROWTH_S.
 */
export function growBaby(g: GrowthState, dtS: number): GrowthState {
  if (g.adult) return { ...g };
  const ageS  = Math.min(GROWTH_S, g.ageS + dtS);
  const adult = ageS >= GROWTH_S;
  return { ...g, ageS, adult };
}

/**
 * Feed a baby its species' favorite food to accelerate growth.
 * Returns `{ accepted: true, state }` when the food matches and the baby is
 * not yet adult; false and unchanged state otherwise.
 *
 * ageS is clamped to GROWTH_S; adult is set at threshold.
 */
export function feedBaby(
  g:      GrowthState,
  species: Species,
  itemId:  string,
): { accepted: boolean; state: GrowthState } {
  if (g.adult) return { accepted: false, state: { ...g } };
  const fav = SPECIES_DEFS[species].favoriteFood;
  if (!fav || itemId !== fav) {
    return { accepted: false, state: { ...g } };
  }
  const ageS  = Math.min(GROWTH_S, g.ageS + FEED_GROWTH_BONUS_S);
  const adult = ageS >= GROWTH_S;
  return { accepted: true, state: { ...g, ageS, adult } };
}

// ---------------------------------------------------------------------------
// Egg-item → species mapping
// ---------------------------------------------------------------------------

/**
 * Map a carried egg item ID to the species it contains.
 * Returns null for unknown item IDs.
 */
export function eggSpeciesFor(eggItemId: string): EggSpecies | null {
  switch (eggItemId) {
    case 'egg_bird':    return 'bird';
    case 'egg_dragon':  return 'dragon';
    case 'egg_griffin': return 'griffin';
    default:            return null;
  }
}

// ---------------------------------------------------------------------------
// Persistence — serialize / deserialize
// ---------------------------------------------------------------------------

export function serializeTamingRegistry(r: TamingRegistry): string {
  return JSON.stringify(r);
}

const VALID_SPECIES = new Set<string>([
  'rabbit', 'deer', 'bird', 'horse', 'cow', 'donkey', 'dragon', 'griffin', 'sea_serpent',
]);
const VALID_EGG_SPECIES = new Set<string>(['bird', 'dragon', 'griffin']);

/** Returns null on any validation failure. */
export function deserializeTamingRegistry(json: string): TamingRegistry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  // Validate top-level shape.
  if (typeof o.tamed  !== 'object' || o.tamed  === null || Array.isArray(o.tamed))  return null;
  if (typeof o.eggs   !== 'object' || o.eggs   === null || Array.isArray(o.eggs))   return null;
  if (typeof o.babies !== 'object' || o.babies === null || Array.isArray(o.babies)) return null;

  // Validate each tamed entry.
  const tamed: TamingRegistry['tamed'] = {};
  for (const [k, v] of Object.entries(o.tamed as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) return null;
    const t = v as Record<string, unknown>;
    if (typeof t.temper !== 'number' || isNaN(t.temper) || t.temper < 0 || t.temper > 100) return null;
    if (typeof t.tamed  !== 'boolean') return null;
    tamed[k] = { temper: t.temper as number, tamed: t.tamed as boolean };
  }

  // Validate each egg entry.
  const eggs: TamingRegistry['eggs'] = {};
  for (const [k, v] of Object.entries(o.eggs as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) return null;
    const e = v as Record<string, unknown>;
    if (typeof e.species !== 'string' || !VALID_EGG_SPECIES.has(e.species)) return null;
    if (typeof e.heatS   !== 'number' || isNaN(e.heatS)   || e.heatS < 0)  return null;
    if (typeof e.hatched !== 'boolean') return null;
    if (typeof e.x       !== 'number' || isNaN(e.x)) return null;
    if (typeof e.z       !== 'number' || isNaN(e.z)) return null;
    eggs[k] = {
      species: e.species as EggSpecies,
      heatS:   e.heatS   as number,
      hatched: e.hatched as boolean,
      x:       e.x       as number,
      z:       e.z       as number,
    };
  }

  // Validate each baby entry.
  const babies: TamingRegistry['babies'] = {};
  for (const [k, v] of Object.entries(o.babies as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) return null;
    const b = v as Record<string, unknown>;
    if (typeof b.species !== 'string' || !VALID_SPECIES.has(b.species)) return null;
    if (typeof b.ageS    !== 'number' || isNaN(b.ageS)   || b.ageS < 0)  return null;
    if (typeof b.adult   !== 'boolean') return null;
    if (typeof b.x       !== 'number' || isNaN(b.x)) return null;
    if (typeof b.z       !== 'number' || isNaN(b.z)) return null;
    babies[k] = {
      species: b.species as Species,
      ageS:    b.ageS    as number,
      adult:   b.adult   as boolean,
      x:       b.x       as number,
      z:       b.z       as number,
    };
  }

  return { tamed, eggs, babies };
}

// ---------------------------------------------------------------------------
// localStorage-guarded load / save
// ---------------------------------------------------------------------------

function emptyRegistry(): TamingRegistry {
  return { tamed: {}, eggs: {}, babies: {} };
}

export function loadTamingRegistry(): TamingRegistry {
  try {
    if (typeof localStorage === 'undefined') return emptyRegistry();
    const raw = localStorage.getItem(TAMING_KEY);
    if (raw !== null) {
      const r = deserializeTamingRegistry(raw);
      if (r !== null) return r;
    }
  } catch { /* storage unavailable */ }
  return emptyRegistry();
}

export function saveTamingRegistry(r: TamingRegistry): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(TAMING_KEY, serializeTamingRegistry(r));
  } catch { /* storage unavailable */ }
}
