/**
 * Animal drop tables and drop-roll helper.
 *
 * Pure data module — no DOM, no GPU. Deterministic given a seeded rng.
 *
 * rollDrops rng draw order (document for callers):
 *   For each row in the table, in array order:
 *     1. One draw for the chance check (always consumed).
 *     2. If the chance check passes, one draw for the count.
 *   This fixed draw order means a seeded rng produces the same drops
 *   regardless of future changes to unrelated rows.
 */

import type { GameItemId } from '../items';
import type { Species } from './entity-types';

export interface DropRow {
  id: GameItemId;
  min: number;
  max: number;
  /** Probability in (0, 1]. A value of 1.0 means guaranteed. */
  chance: number;
}

export const DROP_TABLE: Record<Species, DropRow[]> = {
  rabbit: [
    { id: 'hide',     min: 1, max: 1, chance: 1.0 },
    { id: 'meat_raw', min: 1, max: 1, chance: 1.0 },
  ],
  deer: [
    { id: 'hide',     min: 1, max: 2, chance: 1.0 },
    { id: 'meat_raw', min: 1, max: 2, chance: 1.0 },
    { id: 'bone',     min: 1, max: 1, chance: 0.5 },
  ],
  bird: [
    { id: 'feather',  min: 1, max: 2, chance: 1.0  },
    { id: 'egg_bird', min: 1, max: 1, chance: 0.25 },
  ],
  horse: [
    { id: 'hide', min: 1, max: 2, chance: 1.0 },
  ],
  cow: [
    { id: 'hide',     min: 1, max: 2, chance: 1.0 },
    { id: 'meat_raw', min: 2, max: 3, chance: 1.0 },
  ],
  donkey: [
    { id: 'hide', min: 1, max: 2, chance: 1.0 },
  ],
  wolf: [
    { id: 'hide',     min: 1, max: 2, chance: 1.0  },
    { id: 'meat_raw', min: 1, max: 1, chance: 1.0  },
    { id: 'bone',     min: 1, max: 1, chance: 0.35 },
  ],
  bear: [
    { id: 'hide',     min: 2, max: 3, chance: 1.0 },
    { id: 'meat_raw', min: 2, max: 3, chance: 1.0 },
    { id: 'bone',     min: 1, max: 2, chance: 0.6 },
  ],
  dragon: [
    // 3-6 scales: a full dragonscale armor set (13 scales) ≈ 2-3 dragons.
    { id: 'dragon_scale', min: 3, max: 6, chance: 1.0  },
    { id: 'bone',         min: 1, max: 2, chance: 1.0  },
    { id: 'egg_dragon',   min: 1, max: 1, chance: 0.15 },
  ],
  griffin: [
    { id: 'griffin_feather', min: 2, max: 3, chance: 1.0  },
    { id: 'feather',         min: 2, max: 4, chance: 1.0  },
    { id: 'egg_griffin',     min: 1, max: 1, chance: 0.15 },
  ],
  sea_serpent: [
    { id: 'bone',     min: 2, max: 4, chance: 1.0 },
    { id: 'meat_raw', min: 3, max: 5, chance: 1.0 },
  ],
};

/**
 * Roll drops for a killed species using the supplied rng.
 *
 * Draw order per row (in table order):
 *   1. One rng() draw for the chance check — ALWAYS consumed.
 *   2. One rng() draw for the count     — consumed ONLY when the drop fires.
 *
 * count = clamp(min + floor(rng() * (max - min + 1)), min, max)
 */
export function rollDrops(
  species: Species,
  rng: () => number,
): { id: GameItemId; count: number }[] {
  const result: { id: GameItemId; count: number }[] = [];
  for (const row of DROP_TABLE[species]) {
    const roll = rng(); // chance draw — always taken
    if (roll < row.chance) {
      const raw = row.min + Math.floor(rng() * (row.max - row.min + 1));
      const count = Math.min(raw, row.max);
      result.push({ id: row.id, count });
    }
  }
  return result;
}
