/**
 * Deterministic unit tests for the Ecology Director core (spec validator,
 * prompt builder, fallback). Pure CPU — no GPU, no DOM, no server. Run:
 *   npx tsx scripts/test-ecology.mts
 *
 * The golden prompt hash is the prompt-drift tripwire: any change to the
 * prompt text fails this test and must be deliberate (bump
 * ECOLOGY_PROMPT_VERSION in ecology-spec.ts and update the constant below).
 */

import {
  validateEcologySpec,
  ECOLOGY_FALLBACK,
  ECOLOGY_FIXTURES,
  ECOLOGY_PROMPT_VERSION,
} from '../src/game/entities/ecology-spec';
import type { EcologySpec } from '../src/game/entities/ecology-spec';
import {
  buildEcologyBrief,
  buildEcologyMessages,
  buildEcologyRetryMessage,
} from '../src/game/entities/ecology-prompt';
import type { Biome } from '../src/game/biome';
import { SPECIES_DEFS } from '../src/game/entities/entity-types';

// ── Update ONLY on deliberate prompt changes (see header). ───────────────────
const GOLDEN_PROMPT_HASH: number | null = 0x8fe39066;

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

function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function ok(r: ReturnType<typeof validateEcologySpec>): r is { spec: EcologySpec } {
  return 'spec' in r;
}

function errors(r: ReturnType<typeof validateEcologySpec>): string[] {
  return 'errors' in r ? r.errors : [];
}

// ── Fixture validation ────────────────────────────────────────────────────────

{
  const plainsForest: Biome[] = ['plains', 'forest'];
  const alpine: Biome[] = ['alpine', 'mountain_forest'];

  // Fixture 0: plains/forest herds (rabbit, deer, horse)
  const r0 = validateEcologySpec(ECOLOGY_FIXTURES[0], plainsForest);
  check('fixture 0: validates against plains+forest', ok(r0), JSON.stringify(errors(r0)));

  // Fixture 1: alpine with bird + dragon
  const r1 = validateEcologySpec(ECOLOGY_FIXTURES[1], alpine);
  check('fixture 1: validates against alpine+mountain_forest', ok(r1), JSON.stringify(errors(r1)));

  // Verify version and mood bounds on fixtures
  check('fixture 0: version=1', ECOLOGY_FIXTURES[0].version === 1);
  check('fixture 1: version=1', ECOLOGY_FIXTURES[1].version === 1);
  check('fixture 0: mood length ok',
    ECOLOGY_FIXTURES[0].mood.length >= 1 && ECOLOGY_FIXTURES[0].mood.length <= 40);
  check('fixture 1: mood length ok',
    ECOLOGY_FIXTURES[1].mood.length >= 1 && ECOLOGY_FIXTURES[1].mood.length <= 40);

  // Herd count bounds
  for (const [fi, fix] of ECOLOGY_FIXTURES.entries()) {
    check(`fixture ${fi}: herds 0-5`, fix.herds.length >= 0 && fix.herds.length <= 5);
    for (const h of fix.herds) {
      check(`fixture ${fi}: herd ${h.species} count 1-6`,
        Number.isInteger(h.count) && h.count >= 1 && h.count <= 6);
    }
  }
}

// ── Version check ─────────────────────────────────────────────────────────────

check('ECOLOGY_PROMPT_VERSION === 1', ECOLOGY_PROMPT_VERSION === 1);

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
  check('fallback plains: 1-2 herds', fb1.herds.length >= 1 && fb1.herds.length <= 2);
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

// ── buildEcologyBrief ─────────────────────────────────────────────────────────

{
  const b1 = buildEcologyBrief(1337, 0, 0, ['plains', 'forest']);
  const b2 = buildEcologyBrief(1337, 0, 0, ['plains', 'forest']);
  check('brief: deterministic', JSON.stringify(b1) === JSON.stringify(b2));
  check('brief: two flavor words', b1.flavorWords.length === 2);
  check('brief: flavor words distinct', b1.flavorWords[0] !== b1.flavorWords[1]);
  check('brief: seed preserved', b1.seed === 1337);
  check('brief: ecx/ecz preserved', b1.ecx === 0 && b1.ecz === 0);
  check('brief: biomes preserved', JSON.stringify(b1.biomes) === JSON.stringify(['plains', 'forest']));

  // Different seed → different output
  const b3 = buildEcologyBrief(9999, 0, 0, ['plains', 'forest']);
  check('brief: different seed changes words',
    JSON.stringify(b1.flavorWords) !== JSON.stringify(b3.flavorWords));

  // Different cell coordinates → different output
  const b4 = buildEcologyBrief(1337, 5, -3, ['plains', 'forest']);
  check('brief: different cell changes words',
    JSON.stringify(b1.flavorWords) !== JSON.stringify(b4.flavorWords));

  // Flavor spread across cells
  const flavors = new Set<string>();
  for (let x = -3; x <= 3; x++) {
    for (let z = -3; z <= 3; z++) {
      const br = buildEcologyBrief(42, x, z, ['plains']);
      flavors.add(br.flavorWords[0]);
    }
  }
  check('brief: flavor spread over cells', flavors.size >= 4, `got ${flavors.size}`);
}

// ── buildEcologyMessages ──────────────────────────────────────────────────────

{
  const brief = buildEcologyBrief(1337, 0, 0, ['plains', 'forest']);
  const msgs = buildEcologyMessages(brief);

  check('messages: system+user pair', msgs.length === 2);
  check('messages: system role first', msgs[0].role === 'system');
  check('messages: user role second', msgs[1].role === 'user');
  check('messages: system mentions schema shape',
    msgs[0].content.includes('"version"') && msgs[0].content.includes('"herds"'));
  check('messages: system lists all species',
    msgs[0].content.includes('rabbit') && msgs[0].content.includes('sea_serpent') &&
    msgs[0].content.includes('dragon') && msgs[0].content.includes('griffin'));
  check('messages: system mentions rare rule',
    msgs[0].content.includes('RARE') || msgs[0].content.toLowerCase().includes('rare'));
  check('messages: system embeds fixture 0',
    msgs[0].content.includes(JSON.stringify(ECOLOGY_FIXTURES[0])));
  check('messages: system embeds fixture 1',
    msgs[0].content.includes(JSON.stringify(ECOLOGY_FIXTURES[1])));
  check('messages: user states cell biomes',
    msgs[1].content.includes('plains') && msgs[1].content.includes('forest'));
  check('messages: user states flavor words',
    msgs[1].content.includes(brief.flavorWords[0]) &&
    msgs[1].content.includes(brief.flavorWords[1]));
  check('messages: user demands json fence',
    msgs[1].content.includes('```json'));
}

// ── buildEcologyRetryMessage ──────────────────────────────────────────────────

{
  const retry = buildEcologyRetryMessage(['bad thing one', 'bad thing two']);
  check('retry: lists error one', retry.includes('bad thing one'));
  check('retry: lists error two', retry.includes('bad thing two'));
  check('retry: demands json fence', retry.includes('```json'));
}

// ── Golden prompt hash ────────────────────────────────────────────────────────

{
  const brief = buildEcologyBrief(1337, 0, 0, ['plains', 'forest']);
  const msgs = buildEcologyMessages(brief);
  const hash = fnv1a(new TextEncoder().encode(JSON.stringify(msgs)));

  if (GOLDEN_PROMPT_HASH === null) {
    console.log(`\ngolden prompt hash: 0x${hash.toString(16)} — paste into GOLDEN_PROMPT_HASH`);
  } else {
    check(
      'prompt: golden hash',
      hash === GOLDEN_PROMPT_HASH,
      `got 0x${hash.toString(16)}, want 0x${GOLDEN_PROMPT_HASH.toString(16)}`,
    );
    check('prompt: ECOLOGY_PROMPT_VERSION === 1', ECOLOGY_PROMPT_VERSION === 1);
  }
}

// ── Result ────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0 || (GOLDEN_PROMPT_HASH as number | null) === null) {
  if ((GOLDEN_PROMPT_HASH as number | null) === null) {
    console.error('GOLDEN_PROMPT_HASH not set — re-run after hard-coding the hash above');
  }
  process.exit(1);
}
