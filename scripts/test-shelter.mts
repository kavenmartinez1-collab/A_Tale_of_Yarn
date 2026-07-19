/**
 * Tests for src/game/shelter.ts — tent + canopy shelter model.
 * Run: npx tsx scripts/test-shelter.mts
 *
 * Style matches test-vitals.mts: check() + summary + exit 1 on failure.
 */

import {
  TENTS_KEY, TENT_RADIUS, MAX_TENTS, CANOPY_RADIUS,
  createTent, tentTierAt, canopyAt, shelterTier,
  serializeTents, deserializeTents,
  type PlacedTent, type TreeRef,
} from '../src/game/shelter';

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

// ---------------------------------------------------------------------------
// 1. Constants exported
// ---------------------------------------------------------------------------

check('TENTS_KEY', TENTS_KEY === 'artifex-tents:v1');
check('TENT_RADIUS == 3', TENT_RADIUS === 3);
check('MAX_TENTS == 16', MAX_TENTS === 16);
check('CANOPY_RADIUS == 2.5', CANOPY_RADIUS === 2.5);

// ---------------------------------------------------------------------------
// 2. createTent
// ---------------------------------------------------------------------------

{
  const t = createTent(5, 1, 10, 2);
  check('createTent: tier 2', t.tier === 2);
  check('createTent: x/y/z', t.x === 5 && t.y === 1 && t.z === 10);
  check('createTent: id is string', typeof t.id === 'string' && t.id.length > 0);
}

// ---------------------------------------------------------------------------
// 3. tentTierAt — tier lookup + radius boundary
// ---------------------------------------------------------------------------

{
  const tents: PlacedTent[] = [
    createTent(0, 0, 0, 1),
    createTent(10, 0, 0, 3),
  ];

  // At tent 1 (fiber)
  check('tentTierAt at fiber tent: 1', tentTierAt(tents, 0, 0) === 1);
  // At tent 2 (hide)
  check('tentTierAt at hide tent: 3', tentTierAt(tents, 10, 0) === 3);
  // Boundary: exactly 3 m from fiber tent → still in range
  check('tentTierAt at 3m boundary: 1', tentTierAt(tents, 3, 0) === 1);
  // Just outside 3 m → 0
  check('tentTierAt at 3.1m: 0', tentTierAt(tents, 3.1, 0) === 0);
  // No tents → 0
  check('tentTierAt empty: 0', tentTierAt([], 0, 0) === 0);
  // Two tents overlapping: picks the best (max tier)
  const overlap: PlacedTent[] = [
    createTent(0, 0, 0, 1),
    createTent(1, 0, 0, 2),
  ];
  check('tentTierAt overlapping: returns max tier (2)', tentTierAt(overlap, 0.5, 0) === 2);
}

// ---------------------------------------------------------------------------
// 4. canopyAt — under tree crown
// ---------------------------------------------------------------------------

{
  const trees: TreeRef[] = [
    { x: 0, y: 0, z: 0, scale: 1.0 },
    { x: 10, y: 0, z: 0, scale: 1.5 },
  ];

  // Under first tree crown: crown top = 3.5 * 1.0 = 3.5 m
  check('canopyAt under tree1: true', canopyAt(trees, 0, 1.7, 0));
  // Above crown top: not under
  check('canopyAt above crown: false', !canopyAt(trees, 0, 4.0, 0));
  // Within horizontal radius but above crown
  check('canopyAt in radius but above: false', !canopyAt(trees, 1.0, 4.5, 0));

  // Horizontal boundary: CANOPY_RADIUS = 2.5
  check('canopyAt at 2.4m XZ: true', canopyAt(trees, 2.4, 1.0, 0));
  check('canopyAt at 2.6m XZ: false', !canopyAt(trees, 2.6, 1.0, 0));

  // Larger tree (scale 1.5): crown top = 3.5 * 1.5 = 5.25 m
  check('canopyAt under big tree at y=4: true', canopyAt(trees, 10, 4.0, 0));
  check('canopyAt above big tree crown: false', !canopyAt(trees, 10, 5.3, 0));

  // No trees → false
  check('canopyAt no trees: false', !canopyAt([], 0, 1.0, 0));
}

// ---------------------------------------------------------------------------
// 5. shelterTier — combined tent + canopy
// ---------------------------------------------------------------------------

{
  const tents: PlacedTent[] = [createTent(0, 0, 0, 2)];
  const trees: TreeRef[] = [{ x: 20, y: 0, z: 0, scale: 1.0 }];

  // In tent: returns tent tier
  check('shelterTier in tent: 2', shelterTier(tents, trees, 0, 1, 0) === 2);
  // Under tree canopy only: returns 1
  check('shelterTier under canopy: 1', shelterTier([], trees, 20, 1.0, 0) === 1);
  // Neither: 0
  check('shelterTier neither: 0', shelterTier([], [], 100, 1.0, 0) === 0);
  // Tent + canopy: tent wins (max)
  const tents2: PlacedTent[] = [createTent(20, 0, 0, 3)];
  check('shelterTier tent+canopy: 3', shelterTier(tents2, trees, 20, 1.0, 0) === 3);
}

// ---------------------------------------------------------------------------
// 6. Persistence round-trip
// ---------------------------------------------------------------------------

{
  const tents: PlacedTent[] = [
    createTent(5, 1, 10, 1),
    createTent(20, 2, 30, 3),
  ];
  const json = serializeTents(tents);
  const restored = deserializeTents(json);
  check('round-trip: not null', restored !== null);
  check('round-trip: count matches', restored !== null && restored.length === 2);
  if (restored !== null) {
    check('round-trip: first tent x', restored[0].x === 5);
    check('round-trip: second tent tier 3', restored[1].tier === 3);
    check('round-trip: id preserved', typeof restored[0].id === 'string');
  }
}

// ---------------------------------------------------------------------------
// 7. deserializeTents — defensive parse
// ---------------------------------------------------------------------------

check('rejects malformed JSON', deserializeTents('{nope') === null);
check('rejects empty string', deserializeTents('') === null);
check('rejects null', deserializeTents('null') === null);
check('rejects object (not array)', deserializeTents('{}') === null);

// Missing id
{
  const bad = JSON.stringify([{ x: 0, y: 0, z: 0, tier: 1 }]);
  check('rejects entry without id', deserializeTents(bad) === null);
}

// Bad tier
{
  const bad = JSON.stringify([{ id: 'a', x: 0, y: 0, z: 0, tier: 4 }]);
  check('rejects bad tier (4)', deserializeTents(bad) === null);
  const bad0 = JSON.stringify([{ id: 'a', x: 0, y: 0, z: 0, tier: 0 }]);
  check('rejects tier 0', deserializeTents(bad0) === null);
}

// NaN coordinate
{
  const bad = JSON.stringify([{ id: 'a', x: NaN, y: 0, z: 0, tier: 1 }]);
  check('rejects NaN x', deserializeTents(bad) === null);
}

// Empty array valid
check('empty array valid', Array.isArray(deserializeTents('[]')) && deserializeTents('[]')!.length === 0);

// ---------------------------------------------------------------------------
// 8. FNV-32 golden
// ---------------------------------------------------------------------------

function fnv32a(str: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// Deterministic scenario
const tentsGolden: PlacedTent[] = [
  { id: 'tent_g_1', x: 0, y: 0, z: 0, tier: 1 },
  { id: 'tent_g_2', x: 10, y: 0, z: 0, tier: 3 },
];
const treesGolden: TreeRef[] = [
  { x: 5, y: 0, z: 5, scale: 1.0 },
];

const goldenSnapshot = {
  tierChecks: [
    tentTierAt(tentsGolden, 0, 0),
    tentTierAt(tentsGolden, 3, 0),
    tentTierAt(tentsGolden, 3.1, 0),
    tentTierAt(tentsGolden, 10, 0),
  ],
  canopyChecks: [
    canopyAt(treesGolden, 5, 1, 5),
    canopyAt(treesGolden, 7.5, 1, 5),
    canopyAt(treesGolden, 7.6, 1, 5),
  ],
  shelterChecks: [
    shelterTier(tentsGolden, treesGolden, 0, 1.7, 0),
    shelterTier(tentsGolden, treesGolden, 5, 1.7, 5),
    shelterTier([], treesGolden, 5, 1.7, 5),
    shelterTier(tentsGolden, treesGolden, 100, 1.7, 100),
  ],
};

const goldenJson = JSON.stringify(goldenSnapshot);
const goldenHash = fnv32a(goldenJson);
const EXPECTED_HASH = fnv32a(JSON.stringify({
  tierChecks: [1, 1, 0, 3],
  canopyChecks: [true, true, false],
  shelterChecks: [1, 1, 1, 0],
}));

check('golden tier checks correct', JSON.stringify(goldenSnapshot.tierChecks) === JSON.stringify([1, 1, 0, 3]));
check('golden canopy checks correct', JSON.stringify(goldenSnapshot.canopyChecks) === JSON.stringify([true, true, false]));
check('golden shelter checks correct', JSON.stringify(goldenSnapshot.shelterChecks) === JSON.stringify([1, 1, 1, 0]));
check(
  `FNV-32 golden matches 0x${EXPECTED_HASH.toString(16).padStart(8, '0')}`,
  goldenHash === EXPECTED_HASH,
  `got 0x${goldenHash.toString(16).padStart(8, '0')} — json: ${goldenJson}`,
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
