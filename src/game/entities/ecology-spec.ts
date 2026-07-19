/**
 * Ecology spec — the JSON contract between the AI Ecologist and the
 * deterministic entity-scatter system. LLM-friendly on purpose: enums,
 * small arrays, no coordinates — the LLM decides what/why, scatter()
 * decides where every creature appears.
 *
 * validateEcologySpec() is hand-rolled (no deps, supply-chain policy).
 * Bad Ecologist output must never crash the game: callers log errors and
 * fall back to ECOLOGY_FALLBACK().
 */

import type { Biome } from '../biome';
import { type Species, SPECIES_DEFS } from './entity-types';

/** Bump when the spec schema changes materially — invalidates persisted specs. */
export const ECOLOGY_PROMPT_VERSION = 1;

/** localStorage key prefix for persisted ecology specs. */
export const ECOLOGY_KEY = 'artifex-ecology:v1';

export interface HerdSpec {
  species: Species;
  /** Number of individuals in this herd. 1–6. */
  count: number;
}

export interface EcologySpec {
  version: 1;
  /** Short flavor string describing the cell's wildlife mood. 1–40 chars. */
  mood: string;
  /**
   * List of herds present in this cell. 0–5 entries.
   * Empty (barren cell) is valid.
   */
  herds: HerdSpec[];
}

// ── Validator ────────────────────────────────────────────────────────────────

const KNOWN_SPECIES = new Set<string>(Object.keys(SPECIES_DEFS));

/**
 * Validate untrusted ecology spec JSON. Returns the typed spec or a list of
 * every problem found (so the Ecologist can be re-prompted with all errors at
 * once).
 *
 * @param x           Untrusted value (parsed JSON).
 * @param cellBiomes  Deduplicated biomes present in the cell — used to check
 *                    species admissibility.
 */
export function validateEcologySpec(
  x: unknown,
  cellBiomes: Biome[],
): { spec: EcologySpec } | { errors: string[] } {
  const errors: string[] = [];

  if (typeof x !== 'object' || x === null || Array.isArray(x)) {
    return { errors: ['spec must be a JSON object'] };
  }
  const o = x as Record<string, unknown>;

  // version
  if (o.version !== 1) errors.push('version must be 1');

  // mood
  if (
    typeof o.mood !== 'string' ||
    o.mood.length < 1 ||
    o.mood.length > 40
  ) {
    errors.push('mood must be a string of 1–40 characters');
  }

  // herds
  if (!Array.isArray(o.herds) || o.herds.length > 5) {
    errors.push('herds must be an array of 0–5 entries');
  } else {
    const seenSpecies = new Set<string>();
    let rareHerdCount = 0;
    let totalIndividuals = 0;

    o.herds.forEach((h: unknown, i: number) => {
      if (typeof h !== 'object' || h === null || Array.isArray(h)) {
        errors.push(`herds[${i}] must be an object`);
        return;
      }
      const herd = h as Record<string, unknown>;

      // species
      if (typeof herd.species !== 'string' || !KNOWN_SPECIES.has(herd.species)) {
        errors.push(
          `herds[${i}].species "${String(herd.species)}" is not a known species`,
        );
      } else {
        const sp = herd.species as Species;
        const def = SPECIES_DEFS[sp];

        // duplicate species
        if (seenSpecies.has(sp)) {
          errors.push(`duplicate species "${sp}" in herds`);
        }
        seenSpecies.add(sp);

        // biome admissibility
        const admissible = def.biomes.some((b) => cellBiomes.includes(b));
        if (!admissible) {
          errors.push(
            `species "${sp}" is not admissible for cell biomes [${cellBiomes.join(', ')}]` +
            ` (allowed biomes: ${def.biomes.join(', ')})`,
          );
        }

        // rare rules
        if (def.rare) {
          rareHerdCount++;
          if (rareHerdCount > 1) {
            errors.push('at most one herd may contain a rare species');
          }
        }

        // count
        if (
          typeof herd.count !== 'number' ||
          !Number.isInteger(herd.count) ||
          herd.count < 1 ||
          herd.count > 6
        ) {
          errors.push(`herds[${i}].count must be an integer 1–6`);
        } else {
          totalIndividuals += herd.count;
          if (def.rare && herd.count !== 1) {
            errors.push(
              `herds[${i}]: rare species "${sp}" must have count exactly 1`,
            );
          }
        }
      }

      // count check when species was unknown (still validate the field shape)
      if (typeof herd.species === 'string' && !KNOWN_SPECIES.has(herd.species)) {
        if (
          typeof herd.count !== 'number' ||
          !Number.isInteger(herd.count) ||
          herd.count < 1 ||
          herd.count > 6
        ) {
          errors.push(`herds[${i}].count must be an integer 1–6`);
        }
      }
    });

    // total individuals cap
    if (totalIndividuals > 14) {
      errors.push(
        `total individuals across all herds must be ≤ 14 (got ${totalIndividuals})`,
      );
    }
  }

  if (errors.length > 0) return { errors };
  return { spec: x as EcologySpec };
}

// ── Fallback ─────────────────────────────────────────────────────────────────

/**
 * Deterministic fallback spec used when Ecologist output fails validation.
 * Picks up to 2 common (non-rare) species admissible for the given biomes,
 * in stable SPECIES_DEFS key order. Each chosen species gets count 2.
 */
export function ECOLOGY_FALLBACK(cellBiomes: Biome[]): EcologySpec {
  const herds: HerdSpec[] = [];
  for (const sp of Object.keys(SPECIES_DEFS) as Species[]) {
    if (herds.length >= 2) break;
    const def = SPECIES_DEFS[sp];
    if (def.rare) continue;
    const admissible = def.biomes.some((b) => cellBiomes.includes(b));
    if (admissible) {
      herds.push({ species: sp, count: 2 });
    }
  }
  // If no admissible common species exist, include the sea_serpent (ocean
  // only), or leave herds empty — both are valid per the 0-5 rule.
  if (herds.length === 0) {
    const serpentDef = SPECIES_DEFS.sea_serpent;
    if (serpentDef.biomes.some((b) => cellBiomes.includes(b))) {
      herds.push({ species: 'sea_serpent', count: 1 });
    }
  }
  return { version: 1, mood: 'quiet', herds };
}

// ── Fixtures (few-shot examples, must be valid) ──────────────────────────────

/**
 * Known-valid ecology specs used as few-shot examples in the prompt.
 * Both must pass validateEcologySpec() against representative biome lists
 * (enforced in scripts/test-ecology.mts).
 */
export const ECOLOGY_FIXTURES: EcologySpec[] = [
  // Plains / forest cell — common grazers and small game.
  {
    version: 1,
    mood: 'peaceful',
    herds: [
      { species: 'rabbit', count: 4 },
      { species: 'deer', count: 3 },
      { species: 'horse', count: 2 },
    ],
  },
  // Alpine cell with a solitary dragon.
  {
    version: 1,
    mood: 'dangerous',
    herds: [
      { species: 'bird', count: 3 },
      { species: 'dragon', count: 1 },
    ],
  },
];
