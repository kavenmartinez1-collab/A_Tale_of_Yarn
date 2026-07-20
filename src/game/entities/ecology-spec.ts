/**
 * Ecology spec — the contract between per-cell wildlife design and the
 * deterministic entity-scatter system: enums, small arrays, no coordinates —
 * the spec decides what/why, scatter() decides where every creature appears.
 *
 * Specs are authored by proceduralEcologySpec(): herd composition is
 * invisible background data the player never reads, so a seeded generator
 * gives the same variety as the old LLM Ecologist at zero GPU cost (the
 * model now serves NPC dialogue only — the one place its output is read).
 *
 * validateEcologySpec() is hand-rolled (no deps, supply-chain policy).
 */

import type { Biome } from '../biome';
import { type Species, SPECIES_DEFS } from './entity-types';
import { mix32 } from '../dungeon/dungeon-layout';

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
 * Picks up to 2 common (non-rare, non-aggro) species admissible for the given
 * biomes, in stable SPECIES_DEFS key order, plus at most 1 common predator
 * (aggro, non-rare — wolf/bear) so forests stay dangerous without the LLM.
 * Each chosen species gets count 2.
 */
export function ECOLOGY_FALLBACK(cellBiomes: Biome[]): EcologySpec {
  const herds: HerdSpec[] = [];
  for (const sp of Object.keys(SPECIES_DEFS) as Species[]) {
    if (herds.length >= 2) break;
    const def = SPECIES_DEFS[sp];
    if (def.rare || def.aggro) continue;
    const admissible = def.biomes.some((b) => cellBiomes.includes(b));
    if (admissible) {
      herds.push({ species: sp, count: 2 });
    }
  }
  // One predator herd (first admissible common aggro species — wolf, then bear).
  for (const sp of Object.keys(SPECIES_DEFS) as Species[]) {
    const def = SPECIES_DEFS[sp];
    if (def.rare || !def.aggro) continue;
    if (def.biomes.some((b) => cellBiomes.includes(b))) {
      herds.push({ species: sp, count: 2 });
      break;
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

// ── Procedural generator ─────────────────────────────────────────────────────

/**
 * Deterministic per-cell ecology authoring — replaces the LLM Ecologist.
 * Seeded xorshift32 keyed by (seed, ecx, ecz) gives stable, varied herd
 * compositions: mostly grazers, sometimes a predator pack, rarely a rare
 * beast, occasionally a barren cell. Output always satisfies
 * validateEcologySpec by construction (checked as belt-and-braces).
 */
export function proceduralEcologySpec(
  seed: number, ecx: number, ecz: number, biomes: Biome[],
): EcologySpec {
  let s = mix32(seed, ecx, ecz) >>> 0;
  if (s === 0) s = 1;
  const rnd = (): number => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];

  // Split admissible species by role.
  const grazers: Species[] = [];
  const predators: Species[] = [];
  const rares: Species[] = [];
  for (const sp of Object.keys(SPECIES_DEFS) as Species[]) {
    const def = SPECIES_DEFS[sp];
    if (!def.biomes.some((b) => biomes.includes(b))) continue;
    if (def.rare) rares.push(sp);
    else if (def.aggro) predators.push(sp);
    else grazers.push(sp);
  }

  const herds: HerdSpec[] = [];
  let total = 0;

  // ~7% of cells are barren — silence is part of the variety.
  const barren = rnd() < 0.07;
  if (!barren) {
    // 1–3 distinct grazer herds of 2–5 individuals (capped by the 14 total).
    const nGrazers = Math.min(grazers.length, 1 + Math.floor(rnd() * 3));
    const pool = grazers.slice();
    for (let i = 0; i < nGrazers; i++) {
      const sp = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
      const count = Math.min(2 + Math.floor(rnd() * 4), 14 - total);
      if (count < 1) break;
      herds.push({ species: sp, count });
      total += count;
    }
    // 45% chance of one predator pack (1–3) — keeps the wilds dangerous.
    if (predators.length > 0 && rnd() < 0.45 && total < 14) {
      const count = Math.min(1 + Math.floor(rnd() * 3), 14 - total);
      herds.push({ species: pick(predators), count });
      total += count;
    }
    // 10% chance of a rare beast — count exactly 1 per the validator.
    if (rares.length > 0 && rnd() < 0.1 && total < 14 && herds.length < 5) {
      herds.push({ species: pick(rares), count: 1 });
      total += 1;
    }
  }

  // Mood follows composition so HUD flavor matches what the player meets.
  const hasRare = herds.some((h) => SPECIES_DEFS[h.species].rare);
  const hasPredator = herds.some((h) => SPECIES_DEFS[h.species].aggro);
  const mood =
    herds.length === 0 ? pick(['barren', 'silent', 'empty winds']) :
    hasRare ? pick(['eerie stillness', 'ancient presence', 'ominous']) :
    hasPredator ? pick(['tense', 'watchful', 'wild']) :
    total >= 9 ? pick(['thriving', 'teeming', 'lively']) :
    pick(['peaceful', 'quiet', 'serene']);

  const spec: EcologySpec = { version: 1, mood, herds };
  const checked = validateEcologySpec(spec, biomes);
  return 'errors' in checked ? ECOLOGY_FALLBACK(biomes) : spec;
}
