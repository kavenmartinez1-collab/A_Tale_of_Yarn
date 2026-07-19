/**
 * Tests for src/game/fire.ts — placed-fire registry.
 * Run: npx tsx scripts/test-fire.mts
 *
 * Style matches test-vitals.mts: check() + summary + exit 1 on failure.
 */

import {
  FIRES_KEY, FUEL_PER_LOG, FUEL_CAP, FUEL_DRAIN_PER_S, WARMTH_RADIUS,
  CRAFT_FIRE_RADIUS, MAX_FIRES,
  createFire, addFuel, drainFire, liveFuelAt, isLit, upgradeToForge,
  nearestFire, fireWarmthAt, nearCampfireOrForge, nearForge,
  serializeFires, deserializeFires,
  type PlacedFire,
} from '../src/game/fire';

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

check('FIRES_KEY', FIRES_KEY === 'artifex-fires:v1');
check('FUEL_PER_LOG == 90', FUEL_PER_LOG === 90);
check('FUEL_CAP == 600', FUEL_CAP === 600);
check('FUEL_DRAIN_PER_S == 1', FUEL_DRAIN_PER_S === 1);
check('WARMTH_RADIUS == 6', WARMTH_RADIUS === 6);
check('CRAFT_FIRE_RADIUS == 4', CRAFT_FIRE_RADIUS === 4);
check('MAX_FIRES == 64', MAX_FIRES === 64);

// ---------------------------------------------------------------------------
// 2. createFire defaults
// ---------------------------------------------------------------------------

{
  const f = createFire(10, 2, 20, 'campfire', 0, 0);
  check('createFire: kind campfire', f.kind === 'campfire');
  check('createFire: fuelS 0', f.fuelS === 0);
  check('createFire: id is string', typeof f.id === 'string' && f.id.length > 0);
  check('createFire: x/y/z', f.x === 10 && f.y === 2 && f.z === 20);
}

// ---------------------------------------------------------------------------
// 3. Fuel drain
// ---------------------------------------------------------------------------

{
  // Start with 300 s fuel at t=0.
  const f = createFire(0, 0, 0, 'campfire', 300, 0);
  check('liveFuelAt t=0: 300', liveFuelAt(f, 0) === 300);
  check('liveFuelAt t=100: 200', Math.abs(liveFuelAt(f, 100) - 200) < 1e-9);
  check('liveFuelAt t=300: 0 (drained)', liveFuelAt(f, 300) === 0);
  check('liveFuelAt t=400: 0 (clamped)', liveFuelAt(f, 400) === 0);
  check('isLit at t=100', isLit(f, 100));
  check('not isLit at t=300', !isLit(f, 300));
}

// ---------------------------------------------------------------------------
// 4. Fuel cap on addFuel
// ---------------------------------------------------------------------------

{
  const f = createFire(0, 0, 0, 'campfire', 0, 0);
  // Light with 1 log → 90 s
  addFuel(f, 1, 0);
  check('addFuel 1 log: fuelS 90', f.fuelS === 90);

  // Add 7 more logs at t=0 → cap 600
  addFuel(f, 7, 0);
  check('addFuel 8 logs total: capped at 600', f.fuelS === 600);

  // Attempt overflow → stays at 600
  addFuel(f, 100, 0);
  check('addFuel overflow: still 600', f.fuelS === 600);
}

// ---------------------------------------------------------------------------
// 5. drainFire materialises lazy drain
// ---------------------------------------------------------------------------

{
  const f = createFire(0, 0, 0, 'campfire', 200, 0);
  drainFire(f, 50);
  check('drainFire at t=50: fuelS=150', Math.abs(f.fuelS - 150) < 1e-9);
  check('drainFire: litUntilNow updated', f.litUntilNow === 50);

  drainFire(f, 200); // another 150 s drain → goes to 0
  check('drainFire to 0 then past: fuelS clamped to 0', f.fuelS === 0);
}

// ---------------------------------------------------------------------------
// 6. Refuelling a partially drained fire
// ---------------------------------------------------------------------------

{
  const f = createFire(0, 0, 0, 'campfire', 120, 0);
  // Drain 60 s
  addFuel(f, 1, 60); // drains first (60 s → 60 remain), then adds 90 → 150
  check('refuel after 60 s drain: fuelS 150', Math.abs(f.fuelS - 150) < 1e-9);
}

// ---------------------------------------------------------------------------
// 7. Forge upgrade
// ---------------------------------------------------------------------------

{
  // upgradeToForge requires lit campfire
  const unlit = createFire(0, 0, 0, 'campfire', 0, 0);
  check('upgradeToForge on unlit: false', !upgradeToForge(unlit, 0));
  check('kind still campfire after failed upgrade', unlit.kind === 'campfire');

  const lit = createFire(0, 0, 0, 'campfire', 200, 0);
  check('upgradeToForge on lit campfire: true', upgradeToForge(lit, 0));
  check('kind is now forge', lit.kind === 'forge');

  // upgradeToForge on already-forge: false
  check('upgradeToForge on forge: false', !upgradeToForge(lit, 0));
}

// ---------------------------------------------------------------------------
// 8. nearestFire
// ---------------------------------------------------------------------------

{
  const fires: PlacedFire[] = [
    createFire(0, 0, 0, 'campfire', 100, 0),
    createFire(10, 0, 0, 'campfire', 100, 0),
    createFire(5, 0, 5, 'campfire', 100, 0),
  ];
  const n = nearestFire(fires, 4.5, 4.5, 10);
  check('nearestFire: finds the closest', n !== null && Math.hypot(n.x - 5, n.z - 5) < 1);

  // Outside radius
  check('nearestFire: null when all out of range', nearestFire(fires, 100, 100, 5) === null);
}

// ---------------------------------------------------------------------------
// 9. fireWarmthAt — warmth radius boundary
// ---------------------------------------------------------------------------

{
  const fires: PlacedFire[] = [
    createFire(0, 0, 0, 'campfire', 100, 0),
  ];
  // At distance 5.9 (within 6 m) → warm
  check('warmth at 5.9 m: true', fireWarmthAt(fires, 5.9, 0, 0));
  // At distance 6.0 (boundary) → warm (≤)
  check('warmth at 6.0 m (boundary): true', fireWarmthAt(fires, 6.0, 0, 0));
  // At distance 6.1 → not warm
  check('warmth at 6.1 m: false', !fireWarmthAt(fires, 6.1, 0, 0));

  // Unlit fire: no warmth
  const unlit: PlacedFire[] = [createFire(0, 0, 0, 'campfire', 0, 0)];
  check('unlit fire: no warmth', !fireWarmthAt(unlit, 1, 0, 0));
}

// ---------------------------------------------------------------------------
// 10. nearCampfireOrForge + nearForge
// ---------------------------------------------------------------------------

{
  const campfire = createFire(0, 0, 0, 'campfire', 100, 0);
  const forge = createFire(10, 0, 0, 'forge', 100, 0);

  check('nearCampfireOrForge at campfire: true',
    nearCampfireOrForge([campfire, forge], 0, 0, 0));
  check('nearCampfireOrForge at forge: true',
    nearCampfireOrForge([campfire, forge], 10, 0, 0));
  check('nearForge only at forge: true',
    nearForge([campfire, forge], 10, 0, 0));
  check('nearForge at campfire: false',
    !nearForge([campfire, forge], 0, 0, 0));

  // Unlit fire: never counts
  const unlit = createFire(0, 0, 0, 'campfire', 0, 0);
  check('nearCampfireOrForge unlit: false',
    !nearCampfireOrForge([unlit], 0, 0, 0));
}

// ---------------------------------------------------------------------------
// 11. Persistence round-trip
// ---------------------------------------------------------------------------

{
  const fires: PlacedFire[] = [
    createFire(5, 1, 10, 'campfire', 120, 0),
    createFire(20, 2, 30, 'forge', 300, 50),
  ];
  const json = serializeFires(fires);
  const restored = deserializeFires(json);
  check('round-trip: not null', restored !== null);
  check('round-trip: count matches', restored !== null && restored.length === 2);
  if (restored !== null) {
    check('round-trip: first fire x', restored[0].x === 5);
    check('round-trip: second fire kind forge', restored[1].kind === 'forge');
    check('round-trip: fuelS preserved', Math.abs(restored[0].fuelS - 120) < 1e-9);
    check('round-trip: litUntilNow preserved', restored[1].litUntilNow === 50);
  }
}

// ---------------------------------------------------------------------------
// 12. deserializeFires — defensive parse
// ---------------------------------------------------------------------------

check('rejects malformed JSON', deserializeFires('{nope') === null);
check('rejects empty string', deserializeFires('') === null);
check('rejects null', deserializeFires('null') === null);
check('rejects object (not array)', deserializeFires('{}') === null);

// Missing required field
{
  const bad = JSON.stringify([{ x: 0, y: 0, z: 0, kind: 'campfire', fuelS: 0 }]); // no id
  check('rejects entry without id', deserializeFires(bad) === null);
}

// Bad kind
{
  const bad = JSON.stringify([{ id: 'a', x: 0, y: 0, z: 0, kind: 'oven', fuelS: 0 }]);
  check('rejects bad kind', deserializeFires(bad) === null);
}

// NaN fuelS
{
  const bad = JSON.stringify([{ id: 'a', x: 0, y: 0, z: 0, kind: 'campfire', fuelS: NaN }]);
  check('rejects NaN fuelS', deserializeFires(bad) === null);
}

// Negative fuelS
{
  const bad = JSON.stringify([{ id: 'a', x: 0, y: 0, z: 0, kind: 'campfire', fuelS: -1 }]);
  check('rejects negative fuelS', deserializeFires(bad) === null);
}

// Empty array is valid
check('empty array valid', Array.isArray(deserializeFires('[]')) && deserializeFires('[]')!.length === 0);

// Missing litUntilNow defaults to 0 (graceful)
{
  const partial = JSON.stringify([{ id: 'x', x: 1, y: 0, z: 2, kind: 'campfire', fuelS: 60 }]);
  const r = deserializeFires(partial);
  check('missing litUntilNow defaults to 0', r !== null && r[0].litUntilNow === 0);
}

// ---------------------------------------------------------------------------
// 13. FNV-32 golden over a deterministic scenario
// ---------------------------------------------------------------------------

function fnv32a(str: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function runGoldenScenario(): { fires: PlacedFire[]; warmthChecks: boolean[] } {
  const fires: PlacedFire[] = [];
  const baseTime = 0;

  // Place two campfires at known positions
  const f1 = createFire(0, 0, 0, 'campfire', 0, baseTime);
  f1.id = 'fire_golden_1'; // deterministic id for golden
  const f2 = createFire(20, 0, 0, 'campfire', 0, baseTime);
  f2.id = 'fire_golden_2';
  fires.push(f1, f2);

  // Light f1 with 2 logs at t=0
  addFuel(f1, 2, 0);
  // Add 5 more logs (total 7 → 630 capped to 600)
  addFuel(f1, 5, 0);

  // Drain 200 s
  drainFire(f1, 200);

  // Upgrade f2 to forge (must be lit first)
  addFuel(f2, 1, 0);
  upgradeToForge(f2, 0);

  // Check warmth at various points.
  // Signature: fireWarmthAt(fires, x, z, nowS)
  // After drainFire(f1, 200): f1.fuelS=400, f1.litUntilNow=200
  //   liveFuel at t=200: 400 - (200-200)*1 = 400 → still lit
  // After addFuel(f2,1,0): f2.fuelS=90, f2.litUntilNow=0
  //   liveFuel at t=50: 90 - (50-0)*1 = 40 → still lit
  const warmthChecks = [
    fireWarmthAt(fires, 0, 0, 200),    // at f1 (0,0), t=200 → true
    fireWarmthAt(fires, 6, 0, 200),    // 6 m from f1 → true (boundary)
    fireWarmthAt(fires, 7, 0, 200),    // 7 m from f1 → false
    fireWarmthAt(fires, 20, 0, 50),    // at f2 forge (20,0), t=50 → true
    fireWarmthAt(fires, 27, 0, 50),    // 7 m from f2 at t=50 → false
  ];

  return { fires, warmthChecks };
}

const { fires: gFires, warmthChecks: gChecks } = runGoldenScenario();

// Snapshot: sort ids for stability, then hash.
const snapshot = JSON.stringify({
  fires: gFires.map(f => ({
    id: f.id, x: f.x, y: f.y, z: f.z, kind: f.kind,
    fuelS: f.fuelS, litUntilNow: f.litUntilNow,
  })),
  warmth: gChecks,
});

const goldenHash = fnv32a(snapshot);
// Baked hash — computed from the deterministic scenario above.
const GOLDEN_HASH = fnv32a(snapshot); // self-baking: first run sets the baseline

// Validate scenario outcomes directly instead of a baked hash
// (because id generation uses Date.now() we made ids deterministic above):
check('golden: f1 fuel after drain 200 s from 600', Math.abs(gFires[0].fuelS - 400) < 1e-6,
  `fuelS=${gFires[0].fuelS}`);
check('golden: f2 is forge', gFires[1].kind === 'forge');
check('golden warmth[0]: at f1 lit t=200 → true', gChecks[0]);
check('golden warmth[1]: 6m from f1 t=200 → true', gChecks[1]);
check('golden warmth[2]: 7m from f1 → false', !gChecks[2]);
check('golden warmth[3]: at f2 forge t=50 → true', gChecks[3]);
check('golden warmth[4]: 7m from f2 at t=50 → false', !gChecks[4]);

// Hash for regression (uses the snapshot built from deterministic ids)
const EXPECTED_HASH = fnv32a(JSON.stringify({
  fires: [
    { id: 'fire_golden_1', x: 0, y: 0, z: 0, kind: 'campfire', fuelS: 400, litUntilNow: 200 },
    { id: 'fire_golden_2', x: 20, y: 0, z: 0, kind: 'forge', fuelS: 90, litUntilNow: 0 },
  ],
  warmth: [true, true, false, true, false],
}));
check(
  `FNV-32 golden matches 0x${EXPECTED_HASH.toString(16).padStart(8, '0')}`,
  goldenHash === EXPECTED_HASH,
  `got 0x${goldenHash.toString(16).padStart(8, '0')}`,
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
