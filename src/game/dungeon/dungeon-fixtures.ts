/**
 * Hand-written dungeon specs — stand-ins for AI Director output until the
 * LLM loop (MVP step 2, second half) is wired. Typed consts, no fetch:
 * fixtures load synchronously and deterministically.
 *
 * Every fixture must pass validateSpec() — enforced by
 * scripts/test-dungeon-layout.mts.
 */

import type { DungeonSpec } from './dungeon-spec';

export const DUNGEON_FIXTURES: DungeonSpec[] = [
  {
    version: 1,
    theme: 'crypt',
    name: 'The Sunken Crypt',
    rooms: [
      { id: 'entry', type: 'entrance', size: 'small' },
      { id: 'hall', type: 'combat', size: 'large' },
      { id: 'vault', type: 'treasure', size: 'small', loot: ['gold_small', 'healing_herb'] },
      { id: 'throne', type: 'boss', size: 'large', loot: ['ancient_relic'] },
    ],
    edges: [
      ['entry', 'hall'],
      ['hall', 'vault'],
      ['hall', 'throne'],
    ],
  },
  {
    version: 1,
    theme: 'cave',
    name: 'Howling Hollow',
    rooms: [
      { id: 'mouth', type: 'entrance', size: 'medium' },
      { id: 'tunnel1', type: 'combat', size: 'small' },
      { id: 'tunnel2', type: 'combat', size: 'small' },
      { id: 'grotto', type: 'treasure', size: 'medium', loot: ['gold_large', 'torch_oil'] },
      { id: 'den', type: 'boss', size: 'large', loot: ['iron_sword'] },
      { id: 'pool', type: 'combat', size: 'medium' },
    ],
    edges: [
      ['mouth', 'tunnel1'],
      ['tunnel1', 'grotto'],
      ['mouth', 'tunnel2'],
      ['tunnel2', 'den'],
      ['grotto', 'den'],
      ['tunnel1', 'pool'],
    ],
  },
  {
    version: 1,
    theme: 'ruin',
    name: 'Fallen Watchtower',
    rooms: [
      { id: 'gate', type: 'entrance', size: 'small' },
      { id: 'court', type: 'combat', size: 'medium' },
      { id: 'cellar', type: 'treasure', size: 'small', loot: ['rusty_key', 'old_bone'] },
    ],
    edges: [
      ['gate', 'court'],
      ['court', 'cellar'],
    ],
  },
  {
    version: 1,
    theme: 'crypt',
    name: 'Halls of the Pale King',
    rooms: [
      { id: 'gate', type: 'entrance', size: 'small' },
      { id: 'gallery', type: 'combat', size: 'large' },
      { id: 'ossuary', type: 'combat', size: 'medium' },
      { id: 'reliquary', type: 'treasure', size: 'small', loot: ['ancient_relic', 'gold_small'] },
      { id: 'barracks', type: 'combat', size: 'medium' },
      { id: 'treasury', type: 'treasure', size: 'medium', loot: ['gold_large', 'gold_small', 'iron_sword'] },
      { id: 'antechamber', type: 'combat', size: 'small' },
      { id: 'throne', type: 'boss', size: 'large', loot: ['ancient_relic'] },
    ],
    edges: [
      ['gate', 'gallery'],
      ['gallery', 'ossuary'],
      ['ossuary', 'reliquary'],
      ['gallery', 'barracks'],
      ['barracks', 'treasury'],
      ['gallery', 'antechamber'],
      ['antechamber', 'throne'],
      ['ossuary', 'barracks'],
    ],
  },
];
