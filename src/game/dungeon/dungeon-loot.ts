/**
 * dungeon-loot.ts — what a delve pays out beyond the Director's own spec.
 *
 * PURE. No DOM, no GPU, no renderer import, so `scripts/test-dungeon-combat.mts`
 * asserts the real tables rather than a replica of them.
 *
 * ## Why the Tintreach arrows live here and not in a drop table
 *
 * `entities/animal-drops.ts` keys drops off SPECIES, and species is the wrong
 * axis for this. A Dread King is not intrinsically carrying lightning; a Dread
 * King *at the bottom of a dungeon you fought through* is. Putting the roll
 * here also keeps the supply where the design wants it — behind a boss fight —
 * instead of behind "encountered a dread_king", which anything that ever
 * spawns one elsewhere would quietly become a second faucet for.
 *
 * It is deliberately NOT in `dungeon-spec.ts`'s `KNOWN_ITEMS` either. That list
 * is the set an AI Director may name in a spec, and a Director that can write
 * `loot: ['arrow']` into a starter room is a Director that can hand the best
 * weapon in the game to a player who has not earned it.
 *
 * ## The rate, and why it is this one
 *
 * Tintreach bolts are consumable now, and a full-draw bolt does 18 against a
 * game-wide ceiling of 9 — the hardest single hit available, ~10 of them to
 * kill a Dread King. The failure mode to avoid is not "too many"; it is a
 * player who finds the quiver once, is frightened to spend it, and never
 * experiences the weapon. So:
 *
 *   - A boss kill ALWAYS pays. Killing a Dread King is the hard part (170 hp,
 *     8 damage a swing, 4.1 m of reach against a 20 hp player); making the
 *     reward for it a coin flip on top of that is punishing a win.
 *   - It pays 5–9, which is roughly one more boss's worth of damage. Enough to
 *     be an afternoon rather than a moment, and the quantity — not the
 *     probability — is what decides whether the weapon gets used.
 *   - Everything else is a trickle: the boss's own chest, and treasure rooms
 *     buried at least `DEEP_TREASURE_DEPTH` doors from the entrance. Both are
 *     places a player only reaches by clearing the dungeon, so "mostly boss
 *     loot" stays true and the arrows stay hard to find.
 *
 * A dungeon with no boss room pays essentially nothing, which is the intended
 * contrast: a delve either has a set piece at the bottom of it or it does not.
 */

import type { GameItemId } from '../items';
import { TINTREACH_ID } from '../items';
import { mulberry32 } from '../mesh-utils';
import { roomDepths } from './dungeon-enemies';
import { mix32, type DungeonLayout, type PlacedRoom } from './dungeon-layout';
import type { DungeonSpec } from './dungeon-spec';

/** Arrows a slain dungeon boss always carries. Inclusive range. */
export const TINTREACH_BOSS_MIN = 5;
export const TINTREACH_BOSS_MAX = 9;

/** Chance the boss's own chest holds a cache too, and how big. */
const TINTREACH_BOSS_CHEST_CHANCE = 0.40;
const TINTREACH_BOSS_CHEST_MIN = 3;
const TINTREACH_BOSS_CHEST_MAX = 4;

/**
 * How many doors from the entrance a treasure room must be before it can hold
 * arrows. Most dungeons never get this deep, which is the point — this is the
 * "hard to find" path, not a second reliable source.
 */
const DEEP_TREASURE_DEPTH = 3;
const TINTREACH_DEEP_CHANCE = 0.30;
const TINTREACH_DEEP_MIN = 2;
const TINTREACH_DEEP_MAX = 3;

/**
 * A delve should also be survivable, which means it has to pay for the health
 * it costs. Rank-and-file dungeon drops are gold, bone and hide — nothing that
 * heals — so before this a player could clear a dungeon perfectly and still
 * arrive at the boss on whatever HP the corridor left them, with no decision
 * available except "walk all the way out". Every chest now carries a herb, and
 * the boss's carries a potion.
 *
 * This is the cheapest honest difficulty lever available: it does not weaken a
 * single enemy, it just makes retreating and recovering a real option instead
 * of a theoretical one.
 */
const CHEST_HERBS_MIN = 1;
const CHEST_HERBS_MAX = 2;

/** Inclusive integer draw. */
function range(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/**
 * Arrows carried by a slain boss.
 *
 * Seeded off the entity id so a given Dread King always drops the same number —
 * consistent with every other deterministic roll in the dungeon, and it means a
 * player cannot reload to reroll the payout.
 */
export function rollBossTintreach(enemyId: string): GameItemId[] {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < enemyId.length; i++) {
    h ^= enemyId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // A second, differently-mixed stream from the one `_onEnemyKilled` uses for
  // the species drop table, so the two rolls cannot correlate.
  const rng = mulberry32(mix32(h, 0x7117bea7, 0x5eed));
  const n = range(rng, TINTREACH_BOSS_MIN, TINTREACH_BOSS_MAX);
  const out: GameItemId[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = TINTREACH_ID;
  return out;
}

/**
 * Extra items to fold into each of `layout.chests`, by index.
 *
 * Returns one array per chest, in `layout.chests` order, so the caller can
 * concatenate without matching anything up. Deterministic in
 * `(seed, dcx, dcz)`, so re-entering a dungeon finds the same cache.
 *
 * Depth comes from `roomDepths`, the SAME function that decides which enemies
 * a room holds — the alternative was a second BFS over the same graph that
 * could drift from it, and "deep enough to be dangerous" and "deep enough to be
 * rewarding" must be the same statement about the same room.
 */
export function saltChestLoot(
  layout: DungeonLayout,
  spec: DungeonSpec,
  seed: number,
  dcx: number,
  dcz: number,
): GameItemId[][] {
  const rng = mulberry32(mix32(seed ^ 0x10071, dcx, dcz));
  const depths = roomDepths(spec);
  const out: GameItemId[][] = new Array(layout.chests.length);

  for (let i = 0; i < layout.chests.length; i++) {
    const [cx, cz] = layout.chests[i].cell;
    const room = roomAt(layout.rooms, cx, cz);
    const extra: GameItemId[] = [];

    // Every chest carries something that heals. The boss's is worth more,
    // because the fight after it is the one you need it for.
    const isBoss = room?.type === 'boss';
    if (isBoss) {
      extra.push('healing_potion');
    } else {
      const herbs = range(rng, CHEST_HERBS_MIN, CHEST_HERBS_MAX);
      for (let k = 0; k < herbs; k++) extra.push('healing_herb');
    }

    // Tintreach: the boss's chest, or a treasure room deep enough to have cost
    // something to reach.
    const depth = room === undefined ? 0 : (depths.get(room.id) ?? 0);
    if (isBoss) {
      if (rng() < TINTREACH_BOSS_CHEST_CHANCE) {
        pushN(extra, TINTREACH_ID,
          range(rng, TINTREACH_BOSS_CHEST_MIN, TINTREACH_BOSS_CHEST_MAX));
      }
    } else if (room?.type === 'treasure' && depth >= DEEP_TREASURE_DEPTH) {
      if (rng() < TINTREACH_DEEP_CHANCE) {
        pushN(extra, TINTREACH_ID,
          range(rng, TINTREACH_DEEP_MIN, TINTREACH_DEEP_MAX));
      }
    }

    out[i] = extra;
  }
  return out;
}

function pushN(out: GameItemId[], id: GameItemId, n: number): void {
  for (let i = 0; i < n; i++) out.push(id);
}

/** The placed room containing a cell, or undefined for a corridor cell. */
function roomAt(
  rooms: readonly PlacedRoom[], x: number, z: number,
): PlacedRoom | undefined {
  for (const r of rooms) {
    if (x >= r.x && x < r.x + r.w && z >= r.z && z < r.z + r.d) return r;
  }
  return undefined;
}
