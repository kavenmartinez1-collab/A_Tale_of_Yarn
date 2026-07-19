/**
 * Tests for the harvested-node registry (pure model, fake clocks).
 * Run:  npx tsx scripts/test-resource-nodes.mts
 */

import { NodeRegistry, RESPAWN_MS } from '../src/game/resource-nodes';

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

const T0 = 1_000_000;

// Harvest / query lifecycle.
{
  const reg = new NodeRegistry();
  check('fresh node is not harvested', !reg.isHarvested('0,0:r0', T0));
  check('harvest returns true first time', reg.harvest('0,0:r0', T0));
  check('harvest returns false when already gone', !reg.harvest('0,0:r0', T0 + 1));
  check('node is harvested right after', reg.isHarvested('0,0:r0', T0 + 1));
  check('still harvested just before respawn',
    reg.isHarvested('0,0:r0', T0 + RESPAWN_MS - 1));
  check('respawned exactly at deadline', !reg.isHarvested('0,0:r0', T0 + RESPAWN_MS));
  check('harvestable again after respawn', reg.harvest('0,0:r0', T0 + RESPAWN_MS));
  check('other ids unaffected', !reg.isHarvested('0,0:t3', T0 + RESPAWN_MS));
}

// nextRespawn.
{
  const reg = new NodeRegistry();
  check('nextRespawn null when empty', reg.nextRespawn() === null);
  reg.harvest('a', T0 + 500);
  reg.harvest('b', T0);
  check('nextRespawn is the earliest deadline',
    reg.nextRespawn() === T0 + RESPAWN_MS, `got ${reg.nextRespawn()}`);
}

// Serialize round-trip.
{
  const reg = new NodeRegistry();
  reg.harvest('1,2:r3', T0);
  reg.harvest('-4,5:t0', T0 + 100);
  const back = NodeRegistry.deserialize(reg.serialize(), T0 + 200);
  check('round-trip keeps live entries',
    back.isHarvested('1,2:r3', T0 + 200) && back.isHarvested('-4,5:t0', T0 + 200));
  check('round-trip deadlines intact',
    back.nextRespawn() === T0 + RESPAWN_MS, `got ${back.nextRespawn()}`);
}

// Deserialize drops expired entries.
{
  const reg = new NodeRegistry();
  reg.harvest('old', T0);
  reg.harvest('new', T0 + RESPAWN_MS);
  const back = NodeRegistry.deserialize(reg.serialize(), T0 + RESPAWN_MS + 1);
  check('expired entries pruned on load', !back.isHarvested('old', T0 + RESPAWN_MS + 1));
  check('live entries survive load', back.isHarvested('new', T0 + RESPAWN_MS + 1));
}

// Malformed input.
{
  const cases: [string, string][] = [
    ['garbage', 'not json {{{'],
    ['array', '[1,2,3]'],
    ['null', 'null'],
    ['string values', '{"a":"soon"}'],
    ['infinite value', '{"a":null}'],
  ];
  for (const [name, json] of cases) {
    const reg = NodeRegistry.deserialize(json, T0);
    check(`malformed input tolerated: ${name}`,
      reg.nextRespawn() === null && !reg.isHarvested('a', T0));
  }
  // Mixed valid + invalid entries: keep only the valid one.
  const mixed = NodeRegistry.deserialize(`{"good":${T0 + 9999},"bad":"x"}`, T0);
  check('mixed entries: valid kept, invalid dropped',
    mixed.isHarvested('good', T0) && !mixed.isHarvested('bad', T0));
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
