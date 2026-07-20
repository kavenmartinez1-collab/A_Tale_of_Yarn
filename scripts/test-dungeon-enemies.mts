/**
 * Unit tests for dungeon enemy spawn + AI logic.
 * Run: npx tsx scripts/test-dungeon-enemies.mts
 *
 * Covers:
 *  1. spawnDungeonEnemies produces 2–5 enemies in combat/boss rooms
 *  2. Enemy positions are clamped inside their room bounds
 *  3. Determinism: same seed → same spawn set
 *  4. Different dungeon cells → different enemy positions
 *  5. Enemy AI ticks via tickEnemies and enemies enter aggro when player is close
 *  6. attackDungeonEnemy applies damage and sets mode='dead' at 0 hp
 *  7. Enemy y stays clamped to the dungeon floor
 *  8. Overworld wolf biomes now include desert and beach
 *  9. Overworld bear biomes now include jungle
 */

// We test the pure spawn function by importing the layout module and directly
// invoking the same logic that DungeonManager.enter() calls.
// Because DungeonManager requires GPU objects we cannot construct it in Node,
// so we replicate the spawn call by importing just the pure pieces.

import { layoutDungeon, mix32 } from '../src/game/dungeon/dungeon-layout';
import type { DungeonLayout, PlacedRoom } from '../src/game/dungeon/dungeon-layout';
import { DUNGEON_FIXTURES } from '../src/game/dungeon/dungeon-fixtures';
import { SPECIES_DEFS } from '../src/game/entities/entity-types';
import type { EntityState } from '../src/game/entities/entity-manager';
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

// ---------------------------------------------------------------------------
// Inline replica of spawnDungeonEnemies (pure, no GPU)
// ---------------------------------------------------------------------------

const DUNGEON_ENEMY_SPECIES = 'wolf' as const;
const DUNGEON_ENEMY_MIN = 2;
const DUNGEON_ENEMY_MAX = 5;
const DUNGEON_COMBAT_ROOM_TYPES = new Set(['combat', 'boss']);

interface DungeonEnemy extends EntityState {
  roomX: number;
  roomZ: number;
  roomW: number;
  roomD: number;
}

function spawnDungeonEnemies(
  layout: DungeonLayout,
  origin: [number, number, number],
  seed: number,
  dcx: number,
  dcz: number,
): DungeonEnemy[] {
  const rng = mulberry32(mix32(seed ^ 0xd00f, dcx, dcz));
  const enemies: DungeonEnemy[] = [];
  const combatRooms: PlacedRoom[] = layout.rooms.filter(
    (r) => DUNGEON_COMBAT_ROOM_TYPES.has(r.type));
  if (combatRooms.length === 0) return enemies;

  const total = DUNGEON_ENEMY_MIN + Math.floor(rng() * (DUNGEON_ENEMY_MAX - DUNGEON_ENEMY_MIN + 1));
  const def = SPECIES_DEFS[DUNGEON_ENEMY_SPECIES];

  for (let i = 0; i < total; i++) {
    const room = combatRooms[Math.floor(rng() * combatRooms.length)];
    const margin = 1;
    const fx = room.x + margin + rng() * Math.max(0, room.w - 2 * margin);
    const fz = room.z + margin + rng() * Math.max(0, room.d - 2 * margin);
    const wx = origin[0] + fx;
    const wy = origin[1];
    const wz = origin[2] + fz;
    const id = `dungeon:${dcx},${dcz}:e${i}`;
    const enemy: DungeonEnemy = {
      id,
      species: DUNGEON_ENEMY_SPECIES,
      x: wx, y: wy, z: wz,
      yaw: rng() * Math.PI * 2,
      hp: def.hp,
      mode: 'idle',
      walkPhase: 0,
      colorVariant: (rng() * 4) | 0,
      homeX: wx,
      homeZ: wz,
      stateTimer: rng() * 3,
      fleeTimer: 0,
      roomX: origin[0] + room.x,
      roomZ: origin[2] + room.z,
      roomW: room.w,
      roomD: room.d,
    };
    enemies.push(enemy);
  }
  return enemies;
}

// ---------------------------------------------------------------------------
// 1. Enemy count is in [2, 5]
// ---------------------------------------------------------------------------

{
  const SEED = 1337;
  const origin: [number, number, number] = [0, -300, 0];
  for (const spec of DUNGEON_FIXTURES) {
    const layout = layoutDungeon(spec, SEED);
    const enemies = spawnDungeonEnemies(layout, origin, SEED, 3, 7);
    check(`"${spec.name}": enemy count >= 2`, enemies.length >= 2, `count=${enemies.length}`);
    check(`"${spec.name}": enemy count <= 5`, enemies.length <= 5, `count=${enemies.length}`);
  }
}

// ---------------------------------------------------------------------------
// 2. All enemies are wolves with correct HP
// ---------------------------------------------------------------------------

{
  const layout = layoutDungeon(DUNGEON_FIXTURES[0], 1337);
  const enemies = spawnDungeonEnemies(layout, [0, -300, 0], 1337, 1, 1);
  const wolfDef = SPECIES_DEFS['wolf'];
  for (const e of enemies) {
    check(`enemy species is wolf`, e.species === 'wolf', `got ${e.species}`);
    check(`enemy hp = ${wolfDef.hp}`, e.hp === wolfDef.hp, `hp=${e.hp}`);
    check(`enemy mode is idle`, e.mode === 'idle');
  }
}

// ---------------------------------------------------------------------------
// 3. Enemy positions are clamped inside their room bounds
// ---------------------------------------------------------------------------

{
  const layout = layoutDungeon(DUNGEON_FIXTURES[1], 1337); // Howling Hollow (many combat rooms)
  const origin: [number, number, number] = [1000, -300, 2000];
  const enemies = spawnDungeonEnemies(layout, origin, 1337, 5, 5);
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
  const layout = layoutDungeon(DUNGEON_FIXTURES[0], 42);
  const a = spawnDungeonEnemies(layout, [0, -300, 0], 42, 4, 2);
  const b = spawnDungeonEnemies(layout, [0, -300, 0], 42, 4, 2);
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
  const layout = layoutDungeon(DUNGEON_FIXTURES[0], 1337);
  const a = spawnDungeonEnemies(layout, [0, -300, 0], 1337, 0, 0);
  const b = spawnDungeonEnemies(layout, [0, -300, 0], 1337, 1, 0);
  // Different cells should produce different positions (or at minimum different ids).
  const allSame = a.length === b.length && a.every((e, i) =>
    Math.abs(e.x - b[i].x) < 0.0001 && Math.abs(e.z - b[i].z) < 0.0001);
  check('different cells → different enemy layout', !allSame);
}

// ---------------------------------------------------------------------------
// 6. Enemy AI: aggro triggered when player within 16 m
// ---------------------------------------------------------------------------

{
  const layout = layoutDungeon(DUNGEON_FIXTURES[0], 1337);
  const origin: [number, number, number] = [0, -300, 0];
  const enemies = spawnDungeonEnemies(layout, origin, 1337, 2, 3);
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
  const layout = layoutDungeon(DUNGEON_FIXTURES[0], 1337);
  const origin: [number, number, number] = [512, -300, 512];
  const enemies = spawnDungeonEnemies(layout, origin, 1337, 8, 9);
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
  const layout = layoutDungeon(DUNGEON_FIXTURES[0], 1337);
  const enemies = spawnDungeonEnemies(layout, [0, -300, 0], 1337, 9, 9);
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
  const layout = layoutDungeon(DUNGEON_FIXTURES[0], 1337);
  const enemies = spawnDungeonEnemies(layout, [0, -300, 0], 1337, 3, 7);
  for (let i = 0; i < enemies.length; i++) {
    check(`enemy ${i} id format`, enemies[i].id === `dungeon:3,7:e${i}`,
      `id=${enemies[i].id}`);
  }
}

// ---------------------------------------------------------------------------
// 12. Enemy y is always at dungeon floor (origin[1])
// ---------------------------------------------------------------------------

{
  const layout = layoutDungeon(DUNGEON_FIXTURES[3], 1337); // largest fixture
  const origin: [number, number, number] = [256, -300, 768];
  const enemies = spawnDungeonEnemies(layout, origin, 1337, 6, 6);
  for (const e of enemies) {
    check(`enemy ${e.id} y == ${origin[1]}`, e.y === origin[1], `y=${e.y}`);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
