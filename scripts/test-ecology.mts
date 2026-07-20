/**
 * Deterministic unit tests for the ecology core (spec validator, procedural
 * generator, fallback). Pure CPU — no GPU, no DOM, no server. Run:
 *   npx tsx scripts/test-ecology.mts
 */

import {
  validateEcologySpec,
  ECOLOGY_FALLBACK,
  proceduralEcologySpec,
} from '../src/game/entities/ecology-spec';
import type { EcologySpec } from '../src/game/entities/ecology-spec';
import type { Biome } from '../src/game/biome';
import { SPECIES_DEFS } from '../src/game/entities/entity-types';

// ── Harness ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function ok(r: ReturnType<typeof validateEcologySpec>): r is { spec: EcologySpec } {
  return 'spec' in r;
}

function errors(r: ReturnType<typeof validateEcologySpec>): string[] {
  return 'errors' in r ? r.errors : [];
}

// ── validateEcologySpec: happy paths ─────────────────────────────────────────

{
  const biomes: Biome[] = ['plains'];
  // Minimal valid spec
  const r = validateEcologySpec({ version: 1, mood: 'quiet', herds: [] }, biomes);
  check('valid: empty herds (barren cell)', ok(r));

  // Single common species
  const r2 = validateEcologySpec(
    { version: 1, mood: 'peaceful', herds: [{ species: 'rabbit', count: 3 }] },
    biomes,
  );
  check('valid: single common species', ok(r2));

  // Max mood length (40)
  const r3 = validateEcologySpec(
    { version: 1, mood: 'a'.repeat(40), herds: [] },
    biomes,
  );
  check('valid: mood exactly 40 chars', ok(r3));

  // Max herds (5), each count 1, total=5
  const r4 = validateEcologySpec(
    {
      version: 1,
      mood: 'full',
      herds: [
        { species: 'rabbit', count: 1 },
        { species: 'deer', count: 1 },
        { species: 'bird', count: 1 },
        { species: 'horse', count: 1 },
        { species: 'cow', count: 1 },
      ],
    },
    ['plains', 'forest'],
  );
  check('valid: 5 herds all admissible', ok(r4));

  // Rare species exactly 1 count
  const r5 = validateEcologySpec(
    { version: 1, mood: 'eerie', herds: [{ species: 'dragon', count: 1 }] },
    ['alpine'],
  );
  check('valid: rare species count=1', ok(r5));

  // Sea serpent in ocean cell
  const r6 = validateEcologySpec(
    { version: 1, mood: 'deep', herds: [{ species: 'sea_serpent', count: 1 }] },
    ['ocean'],
  );
  check('valid: sea_serpent in ocean cell', ok(r6));

  // Total individuals exactly 14
  const r7 = validateEcologySpec(
    {
      version: 1,
      mood: 'crowded',
      herds: [
        { species: 'rabbit', count: 6 },
        { species: 'deer', count: 6 },
        { species: 'horse', count: 2 },
      ],
    },
    ['plains', 'forest'],
  );
  check('valid: total individuals exactly 14', ok(r7));
}

// ── validateEcologySpec: rejection cases ────────────────────────────────────

{
  const plains: Biome[] = ['plains'];

  // Non-object input
  check('reject: null input', !ok(validateEcologySpec(null, plains)));
  check('reject: array input', !ok(validateEcologySpec([], plains)));
  check('reject: string input', !ok(validateEcologySpec('hello', plains)));

  // Wrong version
  const rVer = validateEcologySpec({ version: 2, mood: 'x', herds: [] }, plains);
  check('reject: version !== 1', !ok(rVer));
  check('reject: version error message', errors(rVer).some((e) => e.includes('version')));

  // Mood too short (empty)
  const rMoodEmpty = validateEcologySpec({ version: 1, mood: '', herds: [] }, plains);
  check('reject: empty mood', !ok(rMoodEmpty));

  // Mood too long (41 chars)
  const rMoodLong = validateEcologySpec(
    { version: 1, mood: 'a'.repeat(41), herds: [] },
    plains,
  );
  check('reject: mood 41 chars', !ok(rMoodLong));

  // Missing mood
  const rNoMood = validateEcologySpec({ version: 1, herds: [] }, plains);
  check('reject: missing mood', !ok(rNoMood));

  // herds > 5
  const rHerdsLen = validateEcologySpec(
    {
      version: 1,
      mood: 'x',
      herds: [
        { species: 'rabbit', count: 1 },
        { species: 'deer', count: 1 },
        { species: 'bird', count: 1 },
        { species: 'horse', count: 1 },
        { species: 'cow', count: 1 },
        { species: 'donkey', count: 1 },
      ],
    },
    ['plains', 'forest', 'desert', 'beach'],
  );
  check('reject: 6 herds', !ok(rHerdsLen));

  // Unknown species
  const rUnknown = validateEcologySpec(
    { version: 1, mood: 'x', herds: [{ species: 'unicorn', count: 2 }] },
    plains,
  );
  check('reject: unknown species', !ok(rUnknown));
  check('reject: unknown species error mentions it',
    errors(rUnknown).some((e) => e.includes('unicorn')));

  // count = 0
  const rCount0 = validateEcologySpec(
    { version: 1, mood: 'x', herds: [{ species: 'rabbit', count: 0 }] },
    plains,
  );
  check('reject: count=0', !ok(rCount0));

  // count = 7
  const rCount7 = validateEcologySpec(
    { version: 1, mood: 'x', herds: [{ species: 'rabbit', count: 7 }] },
    plains,
  );
  check('reject: count=7', !ok(rCount7));

  // Non-integer count
  const rCountFloat = validateEcologySpec(
    { version: 1, mood: 'x', herds: [{ species: 'rabbit', count: 1.5 }] },
    plains,
  );
  check('reject: non-integer count', !ok(rCountFloat));

  // Total > 14
  const rTotal = validateEcologySpec(
    {
      version: 1,
      mood: 'x',
      herds: [
        { species: 'rabbit', count: 6 },
        { species: 'deer', count: 6 },
        { species: 'horse', count: 3 },
      ],
    },
    ['plains', 'forest'],
  );
  check('reject: total > 14', !ok(rTotal));
  check('reject: total > 14 error mentions total',
    errors(rTotal).some((e) => e.includes('14')));

  // Two rare herds
  const rTwoRare = validateEcologySpec(
    {
      version: 1,
      mood: 'x',
      herds: [
        { species: 'dragon', count: 1 },
        { species: 'griffin', count: 1 },
      ],
    },
    ['alpine', 'mountain_forest'],
  );
  check('reject: two rare herds', !ok(rTwoRare));
  check('reject: two rare herds error mentions rare',
    errors(rTwoRare).some((e) => e.toLowerCase().includes('rare')));

  // Rare count = 2
  const rRareCount = validateEcologySpec(
    { version: 1, mood: 'x', herds: [{ species: 'dragon', count: 2 }] },
    ['alpine'],
  );
  check('reject: rare count=2', !ok(rRareCount));

  // Biome-inadmissible: sea_serpent in plains-only cell
  const rBiome = validateEcologySpec(
    { version: 1, mood: 'x', herds: [{ species: 'sea_serpent', count: 1 }] },
    plains,
  );
  check('reject: sea_serpent in plains-only cell', !ok(rBiome));
  check('reject: inadmissible species error mentions biomes',
    errors(rBiome).some((e) => e.includes('admissible') || e.includes('biome')));

  // Biome-inadmissible: dragon in plains
  const rDragonPlains = validateEcologySpec(
    { version: 1, mood: 'x', herds: [{ species: 'dragon', count: 1 }] },
    plains,
  );
  check('reject: dragon in plains-only cell', !ok(rDragonPlains));

  // Duplicate species
  const rDup = validateEcologySpec(
    {
      version: 1,
      mood: 'x',
      herds: [
        { species: 'rabbit', count: 2 },
        { species: 'rabbit', count: 1 },
      ],
    },
    plains,
  );
  check('reject: duplicate species', !ok(rDup));
  check('reject: duplicate species error mentions duplicate',
    errors(rDup).some((e) => e.toLowerCase().includes('duplicate')));
}

// ── Error accumulation: multiple problems all reported ───────────────────────

{
  const r = validateEcologySpec(
    {
      version: 2,
      mood: '',
      herds: [
        { species: 'unicorn', count: 0 },
        { species: 'sea_serpent', count: 1 },
      ],
    },
    ['plains'],
  );
  check('accumulation: not ok', !ok(r));
  const errs = errors(r);
  check('accumulation: version error present', errs.some((e) => e.includes('version')));
  check('accumulation: mood error present', errs.some((e) => e.includes('mood')));
  check('accumulation: unknown species error present', errs.some((e) => e.includes('unicorn')));
  check('accumulation: inadmissible sea_serpent error present',
    errs.some((e) => e.includes('sea_serpent') || e.includes('admissible') || e.includes('biome')));
  check('accumulation: >= 3 distinct errors', errs.length >= 3,
    `got ${errs.length}: ${JSON.stringify(errs)}`);
}

// ── ECOLOGY_FALLBACK ──────────────────────────────────────────────────────────

{
  // Plains fallback
  const fb1 = ECOLOGY_FALLBACK(['plains']);
  check('fallback plains: version=1', fb1.version === 1);
  check('fallback plains: mood="quiet"', fb1.mood === 'quiet');
  // 2 grazers + up to 1 predator (wolf is plains-admissible)
  check('fallback plains: 1-3 herds', fb1.herds.length >= 1 && fb1.herds.length <= 3);
  check('fallback plains: includes a predator',
    fb1.herds.some((h) => SPECIES_DEFS[h.species].aggro));
  check('fallback plains: no rare species',
    fb1.herds.every((h) => !SPECIES_DEFS[h.species].rare));
  const fb1r = validateEcologySpec(fb1, ['plains']);
  check('fallback plains: validates clean', ok(fb1r), JSON.stringify(errors(fb1r)));

  // Determinism
  const fb1b = ECOLOGY_FALLBACK(['plains']);
  check('fallback: deterministic (plains)', JSON.stringify(fb1) === JSON.stringify(fb1b));

  // Alpine fallback
  const fbAlp = ECOLOGY_FALLBACK(['alpine']);
  const fbAlpR = validateEcologySpec(fbAlp, ['alpine']);
  check('fallback alpine: validates clean', ok(fbAlpR), JSON.stringify(errors(fbAlpR)));
  check('fallback alpine: deterministic',
    JSON.stringify(fbAlp) === JSON.stringify(ECOLOGY_FALLBACK(['alpine'])));

  // Ocean-only fallback (only sea_serpent admissible)
  const fbOcean = ECOLOGY_FALLBACK(['ocean']);
  check('fallback ocean: version=1', fbOcean.version === 1);
  const fbOceanR = validateEcologySpec(fbOcean, ['ocean']);
  check('fallback ocean: validates clean', ok(fbOceanR), JSON.stringify(errors(fbOceanR)));
  check('fallback ocean: deterministic',
    JSON.stringify(fbOcean) === JSON.stringify(ECOLOGY_FALLBACK(['ocean'])));

  // Mixed biomes fallback
  const fbMix = ECOLOGY_FALLBACK(['plains', 'forest', 'alpine']);
  const fbMixR = validateEcologySpec(fbMix, ['plains', 'forest', 'alpine']);
  check('fallback mixed: validates clean', ok(fbMixR), JSON.stringify(errors(fbMixR)));
  check('fallback mixed: deterministic',
    JSON.stringify(fbMix) === JSON.stringify(ECOLOGY_FALLBACK(['plains', 'forest', 'alpine'])));

  // All fallback herds use admissible species
  for (const [biomeLabel, biomes] of [
    ['plains', ['plains'] as Biome[]],
    ['alpine', ['alpine'] as Biome[]],
    ['ocean', ['ocean'] as Biome[]],
    ['mixed', ['plains', 'forest'] as Biome[]],
  ] as [string, Biome[]][]) {
    const fb = ECOLOGY_FALLBACK(biomes);
    for (const h of fb.herds) {
      const def = SPECIES_DEFS[h.species];
      check(
        `fallback ${biomeLabel}: herd ${h.species} admissible for biomes`,
        def.biomes.some((b) => biomes.includes(b)),
      );
    }
  }
}

// ── proceduralEcologySpec ─────────────────────────────────────────────────────

{
  const biomeSets: [string, Biome[]][] = [
    ['plains', ['plains']],
    ['plains+forest', ['plains', 'forest']],
    ['alpine', ['alpine', 'mountain_forest']],
    ['ocean', ['ocean']],
    ['desert+beach', ['desert', 'beach']],
    ['mixed', ['plains', 'forest', 'alpine']],
  ];

  // Determinism: same inputs → identical spec.
  for (const [label, biomes] of biomeSets) {
    const a = proceduralEcologySpec(1337, 4, -7, biomes);
    const b = proceduralEcologySpec(1337, 4, -7, biomes);
    check(`procedural ${label}: deterministic`,
      JSON.stringify(a) === JSON.stringify(b));
  }

  // Different seed / cell → different spec somewhere in a small neighborhood.
  {
    const base = JSON.stringify(proceduralEcologySpec(1337, 0, 0, ['plains', 'forest']));
    const seedDiff = JSON.stringify(proceduralEcologySpec(9999, 0, 0, ['plains', 'forest']));
    let cellDiff = false;
    for (let x = -2; x <= 2 && !cellDiff; x++) {
      for (let z = -2; z <= 2 && !cellDiff; z++) {
        if (x === 0 && z === 0) continue;
        if (JSON.stringify(proceduralEcologySpec(1337, x, z, ['plains', 'forest'])) !== base) {
          cellDiff = true;
        }
      }
    }
    check('procedural: seed changes output', seedDiff !== base);
    check('procedural: cell changes output', cellDiff);
  }

  // Every generated spec validates clean across many cells and biome sets.
  let allValid = true;
  let firstBad = '';
  for (const [label, biomes] of biomeSets) {
    for (let x = -8; x <= 8; x++) {
      for (let z = -8; z <= 8; z++) {
        const spec = proceduralEcologySpec(42, x, z, biomes);
        const r = validateEcologySpec(spec, biomes);
        if (!ok(r)) {
          allValid = false;
          if (firstBad === '') {
            firstBad = `${label} (${x},${z}): ${JSON.stringify(errors(r))}`;
          }
        }
      }
    }
  }
  check('procedural: all specs validate clean (289 cells × 6 biome sets)',
    allValid, firstBad);

  // Variety over a large sample of plains+forest cells.
  {
    const moods = new Set<string>();
    const species = new Set<string>();
    let barren = 0;
    let rare = 0;
    let predator = 0;
    const N = 21; // 441 cells
    for (let x = -10; x <= 10; x++) {
      for (let z = -10; z <= 10; z++) {
        const spec = proceduralEcologySpec(7, x, z, ['plains', 'forest', 'alpine']);
        moods.add(spec.mood);
        if (spec.herds.length === 0) barren++;
        for (const h of spec.herds) {
          species.add(h.species);
          if (SPECIES_DEFS[h.species].rare) rare++;
          if (SPECIES_DEFS[h.species].aggro && !SPECIES_DEFS[h.species].rare) predator++;
        }
      }
    }
    const total = N * N;
    check('procedural variety: >= 6 distinct moods', moods.size >= 6, `got ${moods.size}`);
    check('procedural variety: >= 5 distinct species', species.size >= 5, `got ${species.size}`);
    check('procedural variety: some barren cells', barren > 0, `got ${barren}`);
    check('procedural variety: barren cells uncommon (< 20%)',
      barren < total * 0.2, `got ${barren}/${total}`);
    check('procedural variety: some rare herds', rare > 0, `got ${rare}`);
    check('procedural variety: rare herds uncommon (< 25%)',
      rare < total * 0.25, `got ${rare}/${total}`);
    check('procedural variety: some predator herds', predator > 0, `got ${predator}`);
  }

  // Ocean-only cells: only sea_serpent is admissible — spec must still be valid.
  {
    let allOceanValid = true;
    for (let x = 0; x < 20; x++) {
      const spec = proceduralEcologySpec(11, x, 100, ['ocean']);
      if (!ok(validateEcologySpec(spec, ['ocean']))) allOceanValid = false;
      for (const h of spec.herds) {
        if (h.species !== 'sea_serpent') allOceanValid = false;
      }
    }
    check('procedural ocean: valid, sea_serpent only', allOceanValid);
  }
}

// ── Result ────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
