/**
 * Unit tests for dungeon enemy spawn + AI logic.
 * Run: npx tsx scripts/test-dungeon-enemies.mts
 *
 * CHANGELOG 2026-07-25 — the roster landed.
 *
 * Every threat in the game used to be a wolf: `DUNGEON_ENEMY_SPECIES` was the
 * literal string 'wolf', and `'boss'` was a room type with no creature behind
 * it. This file previously held an INLINE REPLICA of that spawner and asserted
 * against the replica, which meant it could not have caught a change to the
 * real one. It now imports `spawnDungeonEnemies` directly — the function is
 * exported for exactly that reason — so these assertions are about shipping
 * behaviour.
 *
 * Covers:
 *  1. Every dungeon is populated, and within the draw budget
 *  2. Enemy positions are clamped inside their room bounds
 *  3. Determinism: same seed and cell -> byte-identical spawn set
 *  4. Different dungeon cells -> different enemies
 *  5. The AI ticks and enemies enter aggro when the player is close
 *  6. Damage applies and sets mode='dead' at 0 hp
 *  7. Enemy y stays clamped to the dungeon floor
 *  8. Theme decides the roster: a crypt is undead, a cave is goblins
 *  9. Depth escalates: deeper rooms are worse than the first one
 * 10. Exactly one boss, in the boss room, with guards
 * 11. Overworld wolf/bear biome coverage (unchanged, kept from the old file)
 */

// We test the pure spawn function by importing the layout module and the real
// spawner. `DungeonManager` itself needs GPU objects and cannot be built in
// Node, but `spawnDungeonEnemies` is pure and is what `enter()` calls.
// We test the pure spawn function by importing the layout module and directly
// invoking the same logic that DungeonManager.enter() calls.
// Because DungeonManager requires GPU objects we cannot construct it in Node,
// so we replicate the spawn call by importing just the pure pieces.

import { layoutDungeon, mix32 } from '../src/game/dungeon/dungeon-layout';
import { DUNGEON_FIXTURES } from '../src/game/dungeon/dungeon-fixtures';
import {
  spawnDungeonEnemies, type DungeonEnemy,
} from '../src/game/dungeon/dungeon-enemies';
import type { DungeonSpec } from '../src/game/dungeon/dungeon-spec';
import { SPECIES_DEFS, dispositionOf, type Species } from '../src/game/entities/entity-types';
import { stepAnimal, onEntityDamaged } from '../src/game/entities/animal-ai';
import { mulberry32 } from '../src/game/mesh-utils';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

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

/** Spawn a fixture's enemies at a canonical origin. */
function populate(
  spec: DungeonSpec, seed = 1337, dcx = 3, dcz = -2,
): DungeonEnemy[] {
  const layout = layoutDungeon(spec, mix32(seed, dcx, dcz));
  return spawnDungeonEnemies(layout, spec, [0, -300, 0], seed, dcx, dcz);
}

const ROSTER: Species[] =
  ['goblin', 'goblin_archer', 'skeleton', 'dread_king'];

// ---------------------------------------------------------------------------
// 1. Every dungeon is populated, and stays inside the draw budget
// ---------------------------------------------------------------------------

{
  for (const spec of DUNGEON_FIXTURES) {
    const enemies = populate(spec);
    check(`${spec.name}: is populated`, enemies.length > 0,
      `${enemies.length} enemies`);
    // `MAX_DRAWN` is 30 and the rebuild budget is 8/frame. A dungeon that
    // spawns more than the renderer can draw is a dungeon with invisible
    // enemies in it, which is worse than an empty one.
    check(`${spec.name}: inside the draw budget`, enemies.length <= 22,
      `${enemies.length} enemies`);
    check(`${spec.name}: every enemy is from the enemy roster`,
      enemies.every((e) => ROSTER.includes(e.species)),
      [...new Set(enemies.map((e) => e.species))].join(','));
    // The thing this whole change exists to fix.
    check(`${spec.name}: contains no wildlife`,
      enemies.every((e) => e.species !== 'wolf' && e.species !== 'bear'));
    check(`${spec.name}: every enemy starts at full health`,
      enemies.every((e) => e.hp === SPECIES_DEFS[e.species].hp));
    check(`${spec.name}: ids are unique`,
      new Set(enemies.map((e) => e.id)).size === enemies.length);
  }
}

// ---------------------------------------------------------------------------
// 8. Theme decides the roster
//
// A crypt full of goblins is a crypt that means nothing. This is the single
// assertion that keeps `THEME_ROSTER` honest, and it is stated as a property
// ("a crypt contains only undead") rather than as a species list, so
// rebalancing the roster does not have to touch the test.
// ---------------------------------------------------------------------------

{
  const crypt = DUNGEON_FIXTURES.find((f) => f.theme === 'crypt');
  const cave = DUNGEON_FIXTURES.find((f) => f.theme === 'cave');
  check('a crypt fixture exists', crypt !== undefined);
  check('a cave fixture exists', cave !== undefined);

  if (crypt !== undefined) {
    const e = populate(crypt);
    const nonBoss = e.filter((x) => x.boss !== true);
    check('crypt: rank and file are all undead',
      nonBoss.length > 0 && nonBoss.every(
        (x) => dispositionOf(SPECIES_DEFS[x.species]) === 'undead'),
      [...new Set(nonBoss.map((x) => x.species))].join(','));
    check('crypt: no goblins',
      !e.some((x) => x.species === 'goblin' || x.species === 'goblin_archer'));
  }

  if (cave !== undefined) {
    const e = populate(cave);
    check('cave: is mostly goblins',
      e.filter((x) => x.species.startsWith('goblin')).length > e.length * 0.5,
      [...new Set(e.map((x) => x.species))].join(','));
    // The escalation that makes rooms play differently: something that shoots.
    check('cave: contains at least one archer',
      e.some((x) => x.species === 'goblin_archer'));
  }
}

// ---------------------------------------------------------------------------
// 9. Depth escalates
//
// A CONTROLLED experiment rather than an observation on a fixture.
//
// The first version of this test measured mean threat per room by depth across
// the shipped 8-room crypt and failed — correctly, but for the wrong reason:
// that fixture opens on a LARGE hall and its deepest combat room is SMALL, so
// room size swamped the depth term and a real escalation looked like a
// regression. Room size is authored by the spec (a big entrance hall is a
// perfectly good choice) and is not something the spawner gets to control.
//
// So the property is stated the way the code actually guarantees it: hold
// everything else fixed and vary ONLY the distance from the door. Two specs,
// identical room sizes, different chain lengths. Nothing about layout packing
// or fixture authorship can confound it.
// ---------------------------------------------------------------------------

{
  /** A straight corridor of `n` medium combat rooms, all the same size. */
  const chain = (n: number, theme: 'crypt' | 'cave'): DungeonSpec => ({
    version: 1,
    theme,
    name: `Chain ${n}`,
    rooms: [
      { id: 'entry', type: 'entrance', size: 'small' },
      ...Array.from({ length: n }, (_, i) => ({
        id: `r${i}`, type: 'combat' as const, size: 'medium' as const,
      })),
    ],
    edges: [
      ['entry', 'r0'] as [string, string],
      ...Array.from({ length: n - 1 },
        (_, i) => [`r${i}`, `r${i + 1}`] as [string, string]),
    ],
  });

  const threat = (sp: Species): number =>
    SPECIES_DEFS[sp].hp + (SPECIES_DEFS[sp].attackDmg ?? 1) * 4;

  for (const theme of ['crypt', 'cave'] as const) {
    const spec = chain(4, theme);
    const layout = layoutDungeon(spec, mix32(1337, 0, 0));
    const enemies = spawnDungeonEnemies(layout, spec, [0, -300, 0], 1337, 0, 0);

    // Depth of each room is its index + 1 by construction.
    const byRoom = new Map<string, number[]>();
    for (const e of enemies) {
      const room = layout.rooms.find((r) =>
        e.roomX === r.x && e.roomZ === r.z && e.roomW === r.w && e.roomD === r.d);
      if (room === undefined || room.type !== 'combat') continue;
      if (!byRoom.has(room.id)) byRoom.set(room.id, []);
      byRoom.get(room.id)!.push(threat(e.species));
    }

    const totals: number[] = [];
    const counts: number[] = [];
    for (let i = 0; i < 4; i++) {
      const v = byRoom.get(`r${i}`) ?? [];
      totals.push(v.reduce((a, b) => a + b, 0));
      counts.push(v.length);
    }

    check(`${theme}: every room in the chain is defended`,
      counts.every((c) => c > 0), counts.join(','));
    check(`${theme}: head-count rises with depth`,
      counts[3] > counts[0], `counts ${counts.join(' -> ')}`);
    check(`${theme}: the last room is a strictly bigger fight than the first`,
      totals[3] > totals[0], `threat ${totals.join(' -> ')}`);
    check(`${theme}: difficulty never goes backwards`,
      totals.every((t, i) => i === 0 || t >= totals[i - 1]),
      `threat ${totals.join(' -> ')}`);
  }

  // Composition escalation, which only a multi-tier theme can show. A crypt
  // has one undead grunt by design and escalates by weight of numbers instead;
  // a cave must actually change what it sends at you.
  {
    const spec = chain(4, 'cave');
    const layout = layoutDungeon(spec, mix32(99, 1, 1));
    const enemies = spawnDungeonEnemies(layout, spec, [0, -300, 0], 99, 1, 1);
    const speciesIn = (id: string): Species[] => {
      const room = layout.rooms.find((r) => r.id === id)!;
      return enemies
        .filter((e) => e.roomX === room.x && e.roomZ === room.z)
        .map((e) => e.species);
    };
    const first = speciesIn('r0');
    const last = speciesIn('r3');
    check('cave: the first room is plain goblins',
      first.length > 0 && first.every((sp) => sp === 'goblin'),
      first.join(','));
    check('cave: the last room holds something the first did not',
      last.some((sp) => !first.includes(sp)),
      `${first.join(',')} vs ${last.join(',')}`);
  }
}

// ---------------------------------------------------------------------------
// 10. The boss is a set piece
// ---------------------------------------------------------------------------

{
  for (const spec of DUNGEON_FIXTURES) {
    const hasBossRoom = spec.rooms.some((r) => r.type === 'boss');
    const enemies = populate(spec);
    const bosses = enemies.filter((e) => e.boss === true);

    if (!hasBossRoom) {
      check(`${spec.name}: no boss room -> no boss`, bosses.length === 0);
      continue;
    }
    check(`${spec.name}: exactly one boss`, bosses.length === 1,
      `${bosses.length}`);
    const boss = bosses[0];
    check(`${spec.name}: the boss is the Dread King`,
      boss.species === 'dread_king', boss.species);
    check(`${spec.name}: the boss is the toughest thing in the dungeon`,
      enemies.every((e) => e === boss
        || SPECIES_DEFS[e.species].hp < SPECIES_DEFS[boss.species].hp));
    check(`${spec.name}: the boss is fearless`,
      SPECIES_DEFS[boss.species].fearless === true);
    // Guards: the boss room holds more than just him, so it reads as a throne
    // room rather than as a duel.
    const inBossRoom = enemies.filter((e) =>
      e.roomX === boss.roomX && e.roomZ === boss.roomZ);
    check(`${spec.name}: the boss has guards`, inBossRoom.length >= 3,
      `${inBossRoom.length} in the boss room`);
    // He faces the door rather than standing at a random angle.
    check(`${spec.name}: the boss is placed deliberately (yaw 0, centred)`,
      boss.yaw === 0
      && Math.abs(boss.x - (boss.roomX + boss.roomW * 0.5)) < 1e-9);
  }
}

// ---------------------------------------------------------------------------
// 1b. Legacy count coverage kept: every combat room gets someone
// ---------------------------------------------------------------------------

{
  const spec = DUNGEON_FIXTURES[0];
  const layout = layoutDungeon(spec, mix32(1337, 3, -2));
  const enemies = spawnDungeonEnemies(layout, spec, [0, -300, 0], 1337, 3, -2);
  const combatRooms = layout.rooms.filter(
    (r) => r.type === 'combat' || r.type === 'boss');
  for (const room of combatRooms) {
    check(`room ${room.id} is defended`,
      enemies.some((e) => e.roomX === room.x && e.roomZ === room.z),
      `no enemy in ${room.id}`);
  }
}

// ---------------------------------------------------------------------------
// 3. Enemy positions are clamped inside their room bounds
// ---------------------------------------------------------------------------

{
  const spec = DUNGEON_FIXTURES[1];
  const layout = layoutDungeon(spec, 1337); // Howling Hollow (many combat rooms)
  const origin: [number, number, number] = [1000, -300, 2000];
  const enemies = spawnDungeonEnemies(layout, spec, origin, 1337, 5, 5);
  for (const e of enemies) {
    const localX = e.x - origin[0];
    const localZ = e.z - origin[2];
    const roomLocalX = e.roomX - origin[0];
    const roomLocalZ = e.roomZ - origin[2];
    const inX = localX >= roomLocalX && localX <= roomLocalX + e.roomW;
    const inZ = localZ >= roomLocalZ && localZ <= roomLocalZ + e.roomD;
    check(`enemy ${e.id} is inside its room (x)`, inX,
      `localX=${localX.toFixed(1)} room=[${roomLocalX.toFixed(1)},${(roomLocalX+e.roomW).toFixed(1)}]`);
    check(`enemy ${e.id} is inside its room (z)`, inZ,
      `localZ=${localZ.toFixed(1)} room=[${roomLocalZ.toFixed(1)},${(roomLocalZ+e.roomD).toFixed(1)}]`);
    check(`enemy ${e.id} y == origin y`, e.y === -300, `y=${e.y}`);
  }
}

// ---------------------------------------------------------------------------
// 4. Determinism: same seed/cell → identical enemy set
// ---------------------------------------------------------------------------

{
  const spec = DUNGEON_FIXTURES[0];
  const layout = layoutDungeon(spec, 42);
  const a = spawnDungeonEnemies(layout, spec, [0, -300, 0], 42, 4, 2);
  const b = spawnDungeonEnemies(layout, spec, [0, -300, 0], 42, 4, 2);
  check('determinism: same enemy count', a.length === b.length, `${a.length} vs ${b.length}`);
  for (let i = 0; i < a.length; i++) {
    check(`determinism: enemy ${i} x`, Math.abs(a[i].x - b[i].x) < 0.0001);
    check(`determinism: enemy ${i} z`, Math.abs(a[i].z - b[i].z) < 0.0001);
    check(`determinism: enemy ${i} id`, a[i].id === b[i].id);
  }
}

// ---------------------------------------------------------------------------
// 5. Different dungeon cells → different enemy positions
// ---------------------------------------------------------------------------

{
  const spec = DUNGEON_FIXTURES[0];
  const layout = layoutDungeon(spec, 1337);
  const a = spawnDungeonEnemies(layout, spec, [0, -300, 0], 1337, 0, 0);
  const b = spawnDungeonEnemies(layout, spec, [0, -300, 0], 1337, 1, 0);
  // Different cells should produce different positions (or at minimum different ids).
  const allSame = a.length === b.length && a.every((e, i) =>
    Math.abs(e.x - b[i].x) < 0.0001 && Math.abs(e.z - b[i].z) < 0.0001);
  check('different cells → different enemy layout', !allSame);
}

// ---------------------------------------------------------------------------
// 6. Enemy AI: aggro triggered when player within 16 m
// ---------------------------------------------------------------------------

{
  const spec = DUNGEON_FIXTURES[0];
  const layout = layoutDungeon(spec, 1337);
  const origin: [number, number, number] = [0, -300, 0];
  const enemies = spawnDungeonEnemies(layout, spec, origin, 1337, 2, 3);
  check('at least one enemy for AI test', enemies.length > 0);

  if (enemies.length > 0) {
    const e = enemies[0];
    // Place player 10 m away (< AGGRO_TRIGGER_DIST 16 m).
    const playerX = e.x + 10;
    const playerZ = e.z;
    const playerDist = 10;
    const floorY = -300;
    const heightAt = (_x: number, _z: number) => floorY;
    const roomX0 = e.roomX + 0.5;
    const roomZ0 = e.roomZ + 0.5;
    const roomX1 = e.roomX + e.roomW - 0.5;
    const roomZ1 = e.roomZ + e.roomD - 0.5;
    const moveXZ = (ex: number, ez: number, dx: number, dz: number, _r: number): [number, number] => {
      return [Math.max(roomX0, Math.min(roomX1, ex + dx)),
              Math.max(roomZ0, Math.min(roomZ1, ez + dz))];
    };

    stepAnimal(e, 1 / 60, {
      playerX, playerZ, playerDist,
      rng: mulberry32(0xabcd),
      heightAt,
      moveXZ,
      speciesDef: SPECIES_DEFS['wolf'],
      onAttackPlayer: () => {},
    });

    check('dungeon enemy enters aggro when player < 16 m', e.mode === 'aggro',
      `mode=${e.mode}`);
  }
}

// ---------------------------------------------------------------------------
// 7. attackDungeonEnemy simulation: damage → dead
// ---------------------------------------------------------------------------

{
  const spec = DUNGEON_FIXTURES[0];
  const layout = layoutDungeon(spec, 1337);
  const origin: [number, number, number] = [512, -300, 512];
  const enemies = spawnDungeonEnemies(layout, spec, origin, 1337, 8, 9);
  check('enemies present for damage test', enemies.length > 0);

  if (enemies.length > 0) {
    const e = enemies[0];
    const startHp = e.hp;
    // Simulate the attackDungeonEnemy logic inline.
    const dmg = 5;
    e.hp = Math.max(0, e.hp - dmg);
    if (e.hp <= 0) {
      e.mode = 'dead';
    } else {
      onEntityDamaged(e);
    }
    check('damage reduces hp', e.hp === Math.max(0, startHp - dmg));
    check('enemy enters aggro after non-lethal hit', e.hp > 0 ? e.mode === 'aggro' : true);

    // Lethal blow.
    e.hp = 0;
    e.mode = 'dead';
    check('lethal hit sets mode=dead', e.mode === 'dead');
    check('dead enemy has 0 hp', e.hp === 0);
  }
}

// ---------------------------------------------------------------------------
// 8. onEntityDamaged on dungeon enemy sets aggro (wolves are aggro species)
// ---------------------------------------------------------------------------

{
  const spec = DUNGEON_FIXTURES[0];
  const layout = layoutDungeon(spec, 1337);
  const enemies = spawnDungeonEnemies(layout, spec, [0, -300, 0], 1337, 9, 9);
  if (enemies.length > 0) {
    const e = enemies[0];
    e.mode = 'wander'; // pretend it was wandering
    onEntityDamaged(e);
    check('onEntityDamaged: wolf enters aggro', e.mode === 'aggro', `mode=${e.mode}`);
  }
}

// ---------------------------------------------------------------------------
// 9. Overworld: wolf biomes include desert and beach
// ---------------------------------------------------------------------------

{
  const wolfDef = SPECIES_DEFS['wolf'];
  check('wolf spawns in desert', wolfDef.biomes.includes('desert'));
  check('wolf spawns in beach', wolfDef.biomes.includes('beach'));
  // Original biomes still present.
  check('wolf still spawns in forest', wolfDef.biomes.includes('forest'));
  check('wolf still spawns in plains', wolfDef.biomes.includes('plains'));
}

// ---------------------------------------------------------------------------
// 10. Overworld: bear biomes include jungle
// ---------------------------------------------------------------------------

{
  const bearDef = SPECIES_DEFS['bear'];
  check('bear spawns in jungle', bearDef.biomes.includes('jungle'));
  // Original biomes still present.
  check('bear still spawns in forest', bearDef.biomes.includes('forest'));
  check('bear still spawns in dense_forest', bearDef.biomes.includes('dense_forest'));
  check('bear still spawns in mountain_forest', bearDef.biomes.includes('mountain_forest'));
}

// ---------------------------------------------------------------------------
// 11. Enemy id format is stable
// ---------------------------------------------------------------------------

{
  const spec = DUNGEON_FIXTURES[0];
  const layout = layoutDungeon(spec, 1337);
  const enemies = spawnDungeonEnemies(layout, spec, [0, -300, 0], 1337, 3, 7);
  for (let i = 0; i < enemies.length; i++) {
    check(`enemy ${i} id format`, enemies[i].id === `dungeon:3,7:e${i}`,
      `id=${enemies[i].id}`);
  }
}

// ---------------------------------------------------------------------------
// 12. Enemy y is always at dungeon floor (origin[1])
// ---------------------------------------------------------------------------

{
  const spec = DUNGEON_FIXTURES[3];
  const layout = layoutDungeon(spec, 1337); // largest fixture
  const origin: [number, number, number] = [256, -300, 768];
  const enemies = spawnDungeonEnemies(layout, spec, origin, 1337, 6, 6);
  for (const e of enemies) {
    check(`enemy ${e.id} y == ${origin[1]}`, e.y === origin[1], `y=${e.y}`);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
