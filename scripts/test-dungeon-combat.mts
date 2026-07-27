/**
 * Unit tests for dungeon combat gating and dungeon loot.
 * Run: npx tsx scripts/test-dungeon-combat.mts
 *
 * WHY THIS FILE EXISTS
 *
 * Dungeon enemies decided to attack on `Math.hypot(dx, dz)` against a species
 * reach, on a 1 m cell grid where a wall is exactly one cell. Two floor cells
 * either side of a wall are 2.0 m apart and the shared melee reach is 2.5 m, so
 * every enemy pressed against its room's edge — which the room clamp guarantees
 * happens — beat on whatever stood on the other face of that wall, on cadence,
 * forever. The goblin archer's 16 m ranged attack applied its damage at loose
 * time and crossed any number of rooms.
 *
 * `DungeonCombat` (src/game/dungeon/dungeon-combat.ts) is the fix, and it is a
 * separate pure module precisely so this file can assert on SHIPPING code:
 * `DungeonManager` imports the renderer, which imports `.wgsl?raw`, which `tsx`
 * cannot load.
 *
 * THE SHAPE OF THE PROOF
 *
 * Every through-wall test is an A/B on ONE CELL. The same enemy, the same
 * position, the same distance, the same number of ticks — the only difference
 * between the two runs is whether a single grid cell is solid or floor. A test
 * that only asserted "no damage through a wall" would pass just as happily if
 * the fix had broken attacking altogether, which is why the open-doorway half
 * is not optional. There is no replica of the old code anywhere here; the
 * control is real geometry.
 *
 * Covers:
 *  1. Melee cannot cross a wall; the same blow lands through an opened doorway
 *  2. The boss's 4.1 m reach cannot cross a wall either
 *  3. The archer neither shoots nor damages through a wall; it does with sight
 *  4. An idle enemy does not aggro through a wall, and does when it is opened
 *  5. An enemy already fighting does NOT forget the player when sight breaks
 *  6. The grace window bounds how fast a crowd can kill
 *  7. Enemies stay inside their room clamp
 *  8. Loot: determinism, the Tintreach boss rate, and where it may not appear
 */

import {
  CELL_DOOR, CELL_FLOOR, CELL_SOLID, type DungeonLayout, type PlacedRoom,
} from '../src/game/dungeon/dungeon-layout';
import { DungeonCombat } from '../src/game/dungeon/dungeon-combat';
import { spawnDungeonEnemies, type DungeonEnemy } from '../src/game/dungeon/dungeon-enemies';
import {
  rollBossTintreach, saltChestLoot,
  TINTREACH_BOSS_MIN, TINTREACH_BOSS_MAX,
} from '../src/game/dungeon/dungeon-loot';
import { DUNGEON_FIXTURES } from '../src/game/dungeon/dungeon-fixtures';
import { layoutDungeon, mix32 } from '../src/game/dungeon/dungeon-layout';
import { SPECIES_DEFS, type Species } from '../src/game/entities/entity-types';
import { TINTREACH_ID } from '../src/game/items';
import type { DungeonSpec } from '../src/game/dungeon/dungeon-spec';

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

const ORIGIN: [number, number, number] = [0, -300, 0];
const DT = 1 / 60;

// ---------------------------------------------------------------------------
// A controlled two-room arena
//
// Hand-built rather than taken from a fixture, because the whole point is to
// control exactly where the wall is. Two 6x6 rooms, x 2..7 and x 9..14, sharing
// a single solid column at x = 8. `openDoor` turns one cell of that column into
// floor, and nothing else about the arena changes.
// ---------------------------------------------------------------------------

const AW = 20;
const AH = 10;

function arena(): DungeonLayout {
  const cells = new Uint8Array(AW * AH);
  const ceilY = new Float32Array(AW * AH);
  const carve = (x0: number, x1: number, z0: number, z1: number): void => {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        cells[z * AW + x] = CELL_FLOOR;
        ceilY[z * AW + x] = 4;
      }
    }
  };
  carve(2, 7, 2, 7);    // room A (the enemy's)
  carve(9, 14, 2, 7);   // room B (the player's)
  const rooms: PlacedRoom[] = [
    { id: 'a', type: 'combat', x: 2, z: 2, w: 6, d: 6, cx: 5, cz: 5, ceil: 4 },
    { id: 'b', type: 'entrance', x: 9, z: 2, w: 6, d: 6, cx: 12, cz: 5, ceil: 4 },
  ];
  return {
    w: AW, h: AH, cells, ceilY, rooms,
    spawnCell: [12, 4], exitPortalCell: [14, 7], exitWallDir: 1,
    chests: [], torches: [], fallback: false,
  };
}

/** Punch a doorway through the shared wall at row `z`. */
function openDoor(layout: DungeonLayout, z: number): void {
  layout.cells[z * AW + 8] = CELL_DOOR;
  layout.ceilY[z * AW + 8] = 3;
}

/** One enemy of `species` in room A, at (x, z), already clamped to room A. */
function makeEnemy(species: Species, x: number, z: number): DungeonEnemy {
  return {
    id: `dungeon:0,0:e0`,
    species,
    x, y: ORIGIN[1], z,
    yaw: 0,
    hp: SPECIES_DEFS[species].hp,
    mode: 'idle',
    walkPhase: 0,
    colorVariant: 0,
    homeX: x, homeZ: z,
    stateTimer: 0,
    fleeTimer: 0,
    roomX: 2, roomZ: 2, roomW: 6, roomD: 6,
  };
}

interface RunResult {
  damage: number;
  hits: number;
  shots: number;
  mode: string;
  blockedByWall: number;
  blockedByGrace: number;
}

/** Tick `enemies` against a stationary player for `seconds`. */
function run(
  layout: DungeonLayout, enemies: DungeonEnemy[],
  playerX: number, playerZ: number, seconds: number,
  wireProjectiles = false,
): RunResult {
  const combat = new DungeonCombat();
  let damage = 0;
  let hits = 0;
  let shots = 0;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    combat.tick(enemies, DT, playerX, playerZ, {
      layout, origin: ORIGIN,
      onAttackPlayer: (d) => { damage += d; hits++; },
      onAttackEntity: () => {},
      onRangedAttack: wireProjectiles ? () => { shots++; } : undefined,
    });
  }
  return {
    damage, hits, shots, mode: enemies[0].mode,
    blockedByWall: combat.blockedByWall,
    blockedByGrace: combat.blockedByGrace,
  };
}

// ---------------------------------------------------------------------------
// 1. Melee cannot cross a wall — and the identical blow lands once it is open
//
// Enemy at the centre of cell (7, 4), player at the centre of cell (9, 4).
// Exactly 2.0 m apart, through one solid cell, against a 2.5 m reach. The
// enemy starts ALREADY in aggro, so this tests the damage gate itself rather
// than the aggro suppression — an enemy the player shot from a doorway and
// then backed away from is in precisely this state.
// ---------------------------------------------------------------------------

{
  const dist = 2.0;
  check('arena: the through-wall shot is inside melee reach',
    dist < 2.5, `${dist} m vs reach 2.5 m`);

  for (const species of ['skeleton', 'goblin'] as Species[]) {
    // --- wall present ---
    const walled = arena();
    const e = makeEnemy(species, 7.5, 4.5);
    e.mode = 'aggro';
    const blocked = run(walled, [e], 9.5, 4.5, 4);
    check(`${species}: lands NOTHING through a 1 m wall at 2.0 m`,
      blocked.damage === 0,
      `${blocked.damage} damage in ${blocked.hits} hits`);
    check(`${species}: the blocked blows were actually attempted`,
      blocked.blockedByWall > 0,
      `${blocked.blockedByWall} suppressed`);

    // --- one cell opened, nothing else changed ---
    const opened = arena();
    openDoor(opened, 4);
    const e2 = makeEnemy(species, 7.5, 4.5);
    e2.mode = 'aggro';
    const lands = run(opened, [e2], 9.5, 4.5, 4);
    check(`${species}: the SAME blow lands through an opened doorway`,
      lands.damage > 0,
      `${lands.damage} damage in ${lands.hits} hits`);
    check(`${species}: the damage is the species' own`,
      lands.damage === lands.hits * (SPECIES_DEFS[species].attackDmg ?? 0),
      `${lands.damage} over ${lands.hits} hits, attackDmg=${SPECIES_DEFS[species].attackDmg}`);
  }
}

// ---------------------------------------------------------------------------
// 2. The boss's reach is 4.1 m — three cells — and still cannot cross a wall
// ---------------------------------------------------------------------------

{
  const def = SPECIES_DEFS['dread_king'];
  const reach = 2.5 + (def.reachBonus ?? 0);
  check('dread king reaches further than one wall is thick', reach > 2.0,
    `${reach} m`);

  const walled = arena();
  const e = makeEnemy('dread_king', 7.5, 4.5);
  e.mode = 'aggro';
  const blocked = run(walled, [e], 10.5, 4.5, 6);   // 3.0 m apart, reach 4.1 m
  check('dread king: lands nothing through a wall at 3.0 m',
    blocked.damage === 0, `${blocked.damage} damage`);

  const opened = arena();
  openDoor(opened, 4);
  const e2 = makeEnemy('dread_king', 7.5, 4.5);
  e2.mode = 'aggro';
  const lands = run(opened, [e2], 10.5, 4.5, 6);
  check('dread king: lands through an opened doorway at 3.0 m',
    lands.damage > 0, `${lands.damage} damage`);
}

// ---------------------------------------------------------------------------
// 3. The archer: no arrow and no damage through rock, both through a doorway
//
// This is the worst of the three, because its damage was applied at loose time
// rather than on impact — so the arrow was decorative and the wall never had a
// chance to stop anything.
// ---------------------------------------------------------------------------

{
  const walled = arena();
  const e = makeEnemy('goblin_archer', 4.5, 4.5);
  e.mode = 'aggro';
  const blocked = run(walled, [e], 12.5, 4.5, 6, true);  // 8 m, range 16 m
  check('archer: fires no arrow through a wall at 8 m',
    blocked.shots === 0, `${blocked.shots} shots`);
  check('archer: deals no damage through a wall at 8 m',
    blocked.damage === 0, `${blocked.damage} damage`);
  check('archer: the suppressed shots were actually attempted',
    blocked.blockedByWall > 0, `${blocked.blockedByWall} suppressed`);

  const opened = arena();
  openDoor(opened, 4);
  const e2 = makeEnemy('goblin_archer', 4.5, 4.5);
  e2.mode = 'aggro';
  const lands = run(opened, [e2], 12.5, 4.5, 6, true);
  check('archer: shoots through an opened doorway', lands.shots > 0,
    `${lands.shots} shots`);
  check('archer: damages through an opened doorway', lands.damage > 0,
    `${lands.damage} damage`);
  check('archer: every arrow that flew also dealt its damage',
    lands.damage === lands.shots * (SPECIES_DEFS['goblin_archer'].rangedDmg ?? 0),
    `${lands.damage} over ${lands.shots} shots`);
}

// ---------------------------------------------------------------------------
// 4. An idle enemy does not wake through a wall
//
// The other half of the old fault: 16 m of pure proximity meant walking a
// corridor woke every room beside it, and the player arrived at a room that had
// already been standing at the door waiting.
// ---------------------------------------------------------------------------

{
  const walled = arena();
  const e = makeEnemy('skeleton', 7.5, 4.5);
  const asleep = run(walled, [e], 9.5, 4.5, 2);
  check('idle enemy does not aggro through a wall 2 m away',
    asleep.mode !== 'aggro', `mode=${asleep.mode}`);

  const opened = arena();
  openDoor(opened, 4);
  const e2 = makeEnemy('skeleton', 7.5, 4.5);
  const awake = run(opened, [e2], 9.5, 4.5, 2);
  check('the same enemy aggros the moment the doorway is opened',
    awake.mode === 'aggro', `mode=${awake.mode}`);
}

// ---------------------------------------------------------------------------
// 5. Breaking sight must not break the FIGHT
//
// The occluded distance is reported as a finite number, not infinity, on
// purpose: `animal-ai` de-aggros past AGGRO_TRIGGER_DIST * 2 (32 m), and an
// enemy that forgot the player every time they stepped behind a pillar would be
// a different bug. This pins that property rather than the constant, so a
// change to either number in animal-ai.ts fails HERE.
// ---------------------------------------------------------------------------

{
  const walled = arena();
  const e = makeEnemy('skeleton', 7.5, 4.5);
  e.mode = 'aggro';
  const r = run(walled, [e], 9.5, 4.5, 5);
  check('an enemy already fighting keeps its aggro when sight is lost',
    r.mode === 'aggro', `mode=${r.mode}`);
  check('...while still landing nothing', r.damage === 0, `${r.damage} damage`);
}

// ---------------------------------------------------------------------------
// 6. The grace window bounds how fast a crowd can kill
//
// Five skeletons in reach with nothing staggering them deal 25 damage the
// instant their independent cooldowns line up, against 20 max HP. The window
// does not weaken any single blow — it caps how many can land per second.
// ---------------------------------------------------------------------------

{
  const opened = arena();
  for (let z = 2; z <= 7; z++) openDoor(opened, z);
  const crowd: DungeonEnemy[] = [];
  for (let i = 0; i < 5; i++) {
    const e = makeEnemy('skeleton', 7.5, 2.5 + i);
    e.id = `dungeon:0,0:e${i}`;
    e.mode = 'aggro';
    crowd.push(e);
  }
  const seconds = 4;
  const r = run(opened, crowd, 9.5, 4.5, seconds);
  const maxHits = Math.ceil(seconds / 0.8) + 1;
  check('a crowd cannot land more than one blow per grace window',
    r.hits <= maxHits, `${r.hits} hits in ${seconds}s (ceiling ${maxHits})`);
  check('...and the crowd really was trying to land more',
    r.blockedByGrace > 0, `${r.blockedByGrace} suppressed`);
  check('...but every enemy still fights (the window is not a mute button)',
    r.hits > 0, `${r.hits} hits`);
  // Without the window this is 5 x 5 damage every 1.45 s.
  const unstaggered = 5 * 5 * Math.floor(seconds / 1.45);
  check('the crowd deals materially less than an unstaggered one would',
    r.damage < unstaggered, `${r.damage} vs ${unstaggered}`);
}

// ---------------------------------------------------------------------------
// 7. Enemies stay inside their room. The clamp is what makes sight matter.
// ---------------------------------------------------------------------------

{
  const opened = arena();
  for (let z = 2; z <= 7; z++) openDoor(opened, z);
  const e = makeEnemy('goblin', 4.5, 4.5);
  e.mode = 'aggro';
  run(opened, [e], 13.5, 4.5, 10);   // player deep in the far room
  check('an aggro enemy never leaves its room rect (x)',
    e.x >= 2.5 - 1e-6 && e.x <= 7.5 + 1e-6, `x=${e.x}`);
  check('an aggro enemy never leaves its room rect (z)',
    e.z >= 2.5 - 1e-6 && e.z <= 7.5 + 1e-6, `z=${e.z}`);
  check('an aggro enemy stays on the dungeon floor', e.y === ORIGIN[1],
    `y=${e.y}`);
}

// ---------------------------------------------------------------------------
// 8. Loot
// ---------------------------------------------------------------------------

{
  // --- the boss always pays, in a bounded quantity ---
  for (const id of ['dungeon:0,0:e0', 'dungeon:3,-2:e0', 'dungeon:-9,4:e7']) {
    const drop = rollBossTintreach(id);
    check(`boss ${id}: always drops Tintreach arrows`, drop.length > 0);
    check(`boss ${id}: every item is an arrow`,
      drop.every((x) => x === TINTREACH_ID), drop.join(','));
    check(`boss ${id}: quantity inside [${TINTREACH_BOSS_MIN}, ${TINTREACH_BOSS_MAX}]`,
      drop.length >= TINTREACH_BOSS_MIN && drop.length <= TINTREACH_BOSS_MAX,
      `${drop.length}`);
    check(`boss ${id}: the roll is deterministic`,
      rollBossTintreach(id).length === drop.length);
  }
  // Different bosses do not all pay the same, or the range is decorative.
  {
    const counts = new Set<number>();
    for (let i = 0; i < 40; i++) {
      counts.add(rollBossTintreach(`dungeon:${i},0:e0`).length);
    }
    check('boss drops vary across dungeons', counts.size > 1,
      `${[...counts].sort((a, b) => a - b).join(',')}`);
  }

  // --- chest salting ---
  for (const spec of DUNGEON_FIXTURES) {
    const layout = layoutDungeon(spec, mix32(1337, 3, -2));
    const a = saltChestLoot(layout, spec, 1337, 3, -2);
    const b = saltChestLoot(layout, spec, 1337, 3, -2);
    check(`${spec.name}: chest salt is deterministic`,
      JSON.stringify(a) === JSON.stringify(b));
    check(`${spec.name}: one salt entry per chest`,
      a.length === layout.chests.length,
      `${a.length} vs ${layout.chests.length}`);
    check(`${spec.name}: every chest carries something that heals`,
      a.every((items) => items.some(
        (x) => x === 'healing_herb' || x === 'healing_potion')),
      a.map((x) => x.join('+')).join(' | '));

    // Tintreach may only appear in a boss room or a DEEP treasure room.
    const roomOf = (cx: number, cz: number): PlacedRoom | undefined =>
      layout.rooms.find((r) =>
        cx >= r.x && cx < r.x + r.w && cz >= r.z && cz < r.z + r.d);
    layout.chests.forEach((c, i) => {
      if (!a[i].includes(TINTREACH_ID)) return;
      const room = roomOf(c.cell[0], c.cell[1]);
      check(`${spec.name}: chest Tintreach only in boss/treasure rooms`,
        room?.type === 'boss' || room?.type === 'treasure',
        `found in ${room?.id ?? 'corridor'} (${room?.type})`);
    });
  }

  // A dungeon with no boss room hands out no boss arrows at all.
  {
    const noBoss = DUNGEON_FIXTURES.find((f) => !f.rooms.some((r) => r.type === 'boss'));
    check('a fixture without a boss room exists', noBoss !== undefined);
    if (noBoss !== undefined) {
      const layout = layoutDungeon(noBoss, mix32(1337, 3, -2));
      const salt = saltChestLoot(layout, noBoss, 1337, 3, -2);
      check('a bossless dungeon has no boss chest cache',
        salt.every((items) => !items.includes(TINTREACH_ID)),
        salt.map((x) => x.join('+')).join(' | '));
    }
  }

  // A shallow treasure room must NOT hold arrows — the depth gate is the
  // "hard to find" half of the design and a silent regression there would
  // quietly turn the trickle into a faucet.
  {
    const shallow: DungeonSpec = {
      version: 1, theme: 'crypt', name: 'Shallow Vault',
      rooms: [
        { id: 'entry', type: 'entrance', size: 'small' },
        { id: 'vault', type: 'treasure', size: 'small', loot: ['gold_small'] },
      ],
      edges: [['entry', 'vault']],
    };
    let sawArrow = false;
    for (let cell = 0; cell < 24; cell++) {
      const layout = layoutDungeon(shallow, mix32(1337, cell, 0));
      const salt = saltChestLoot(layout, shallow, 1337, cell, 0);
      if (salt.some((items) => items.includes(TINTREACH_ID))) sawArrow = true;
    }
    check('a treasure room one door in never holds Tintreach arrows', !sawArrow);
  }
}

// ---------------------------------------------------------------------------
// 9. Real fixtures still fight: the fix must not have muted the dungeon
//
// Every assertion above is about damage NOT happening. This one is the
// counterweight — a shipped dungeon, its real geometry, its real spawns, and a
// player standing in the middle of a populated room must take damage.
// ---------------------------------------------------------------------------

{
  for (const spec of DUNGEON_FIXTURES) {
    const layout = layoutDungeon(spec, mix32(1337, 3, -2));
    const enemies = spawnDungeonEnemies(layout, spec, ORIGIN, 1337, 3, -2);
    check(`${spec.name}: is populated`, enemies.length > 0);
    if (enemies.length === 0) continue;
    // Stand on top of the first enemy — same room, guaranteed sight.
    const target = enemies[0];
    const r = run(layout, enemies, target.x, target.z, 6);
    check(`${spec.name}: a player standing in a populated room takes damage`,
      r.damage > 0, `${r.damage} damage in ${r.hits} hits`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
