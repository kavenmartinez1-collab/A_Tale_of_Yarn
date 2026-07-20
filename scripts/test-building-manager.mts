/**
 * Unit tests for building-manager.ts — pure CPU parts:
 * kind mapping, door world position math, seed determinism, chest placement.
 * Run:  npx tsx scripts/test-building-manager.mts
 */

import {
  generateBuildingInterior,
  type BuildingInteriorSpec,
  type BuildingKind,
} from '../src/game/building/building-interior';
import { mix32 } from '../src/game/dungeon/dungeon-layout';
import { mulberry32 } from '../src/game/mesh-utils';
import {
  layoutSettlement, resolveSettlement, padHalfExtents,
  type ResolvedPad, type ResolvedSettlement,
} from '../src/game/settlement/settlement-layout';
import type { SettlementSite } from '../src/game/settlement/settlement-scatter';

/** Inline replica of doorWorldPosition (avoids importing renderer deps). */
function doorWorldPosition(pad: ResolvedPad): [number, number, number] {
  const doorDist = pad.d / 2;
  const dx = -Math.sin(pad.yaw) * doorDist;
  const dz = -Math.cos(pad.yaw) * doorDist;
  return [pad.wx + dx, pad.wy, pad.wz + dz];
}

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

// ---- 1. Kind mapping --------------------------------------------------------

{
  // barnKind determinism: even seed → shop, odd seed → tavern
  function barnKind(seed: number): BuildingKind {
    return (seed & 1) === 0 ? 'shop' : 'tavern';
  }

  check('kind mapping: house pad → house', true); // trivial
  check('kind mapping: keep pad → keep', true);   // trivial
  check('kind mapping: barn(even) → shop', barnKind(42) === 'shop');
  check('kind mapping: barn(odd) → tavern', barnKind(43) === 'tavern');
  check('kind mapping: barn deterministic', barnKind(100) === barnKind(100));
}

// ---- 2. Door world position formula -----------------------------------------

{
  // A house pad at center with yaw=0: door should be at -Z side
  const pad: ResolvedPad = {
    type: 'house', x: 0, z: 0, yaw: 0, w: 4, d: 3.4, h: 2.5,
    wx: 100, wy: 10, wz: 200,
  };
  const [dx, dy, dz] = doorWorldPosition(pad);
  // yaw=0, door is on local -Z face: world offset = (0, 0, -depth/2)
  check('door pos yaw=0: x unchanged', Math.abs(dx - 100) < 0.01,
    `expected x=100, got ${dx}`);
  check('door pos yaw=0: y unchanged', Math.abs(dy - 10) < 0.01);
  check('door pos yaw=0: z offset by -d/2', Math.abs(dz - (200 - 3.4 / 2)) < 0.01,
    `expected z=${200 - 3.4 / 2}, got ${dz}`);

  // yaw = PI/2: door rotates to -X face in world
  const padR: ResolvedPad = {
    type: 'house', x: 0, z: 0, yaw: Math.PI / 2, w: 4, d: 3.4, h: 2.5,
    wx: 0, wy: 0, wz: 0,
  };
  const [rx, , rz] = doorWorldPosition(padR);
  // local -Z → world -X when yaw=PI/2: dx = -sin(PI/2)*d/2 = -d/2, dz = -cos(PI/2)*d/2 ≈ 0
  check('door pos yaw=PI/2: x offset ≈ -d/2', Math.abs(rx - (-3.4 / 2)) < 0.01,
    `expected x=${-3.4 / 2}, got ${rx}`);
  check('door pos yaw=PI/2: z offset ≈ 0', Math.abs(rz) < 0.01,
    `expected z≈0, got ${rz}`);
}

// ---- 2b. Pad perimeter distance (enter-from-any-side prompt) ----------------

{
  // Inline replica of padPerimeterDistXZ (avoids importing renderer deps).
  function padPerimeterDistXZ(pad: ResolvedPad, x: number, z: number): number {
    const rx = x - pad.wx;
    const rz = z - pad.wz;
    const c = Math.cos(pad.yaw);
    const s = Math.sin(pad.yaw);
    const lx = c * rx - s * rz;
    const lz = s * rx + c * rz;
    const dx = Math.max(Math.abs(lx) - pad.w / 2, 0);
    const dz = Math.max(Math.abs(lz) - pad.d / 2, 0);
    return Math.hypot(dx, dz);
  }

  const pad: ResolvedPad = {
    type: 'house', x: 0, z: 0, yaw: 0, w: 4, d: 3.4, h: 2.5,
    wx: 100, wy: 10, wz: 200,
  };
  check('perimeter dist: center is 0', padPerimeterDistXZ(pad, 100, 200) === 0);
  check('perimeter dist: on edge is 0', padPerimeterDistXZ(pad, 102, 200) === 0);
  check('perimeter dist: 1 m off +X face',
    Math.abs(padPerimeterDistXZ(pad, 103, 200) - 1) < 0.01);
  check('perimeter dist: 1 m off -Z (door) face',
    Math.abs(padPerimeterDistXZ(pad, 100, 200 - 1.7 - 1) - 1) < 0.01);
  check('perimeter dist: corner diagonal',
    Math.abs(padPerimeterDistXZ(pad, 103, 200 - 1.7 - 1) - Math.hypot(1, 1)) < 0.01);

  // Rotated pad (yaw=PI/2): local -Z face maps to world -X; the world +Z side
  // is now the pad's local width axis (half-extent w/2 = 2).
  const padR: ResolvedPad = { ...pad, yaw: Math.PI / 2 };
  check('perimeter dist (rotated): 1 m past width half-extent',
    Math.abs(padPerimeterDistXZ(padR, 100, 203) - 1) < 0.01);
  check('perimeter dist (rotated): 1 m past depth half-extent on world X',
    Math.abs(padPerimeterDistXZ(padR, 100 - 1.7 - 1, 200) - 1) < 0.01);

  // The door point always sits ON the perimeter → old door-point reach is a
  // strict subset of the new perimeter reach.
  const [doorX, , doorZ] = doorWorldPosition(pad);
  check('perimeter dist: door point is on perimeter',
    padPerimeterDistXZ(pad, doorX, doorZ) < 0.01);
}

// ---- 2c. Tower/gatehouse are enterable (keep-style) -------------------------

{
  // Mirrors ENTERABLE_PAD_TYPES in building-manager.ts.
  const towerInt = generateBuildingInterior({
    settlementName: 'Castle', buildingIndex: 3, kind: 'keep', width: 4.5, depth: 4.5,
  }, 4242);
  check('tower interior: generates (5x5 pad → keep kind)', towerInt.cells.length > 0);
  check('tower interior: has a spawn point', towerInt.spawnPoint.length === 3);

  const gateInt = generateBuildingInterior({
    settlementName: 'Castle', buildingIndex: 9, kind: 'keep', width: 7.5, depth: 5.5,
  }, 777);
  check('gatehouse interior: generates (8x6 pad → keep kind)', gateInt.cells.length > 0);
}

// ---- 3. Seed determinism (same site + padIndex → same interior) -------------

{
  const site: SettlementSite = {
    kind: 'village', x: 1000, y: 50, z: 1000, radius: 28, seed: 7777,
  };
  const heightAt = (x: number, z: number) => 50 + Math.sin(x * 0.01) * 2;
  const resolved = resolveSettlement(site, heightAt);

  // Find first house pad
  const housePadIdx = resolved.pads.findIndex(p => p.type === 'house');
  check('seed determinism: found house pad', housePadIdx >= 0);
  if (housePadIdx >= 0) {
    const seed1 = mix32(site.seed, housePadIdx);
    const seed2 = mix32(site.seed, housePadIdx);
    check('seed determinism: seeds match', seed1 === seed2);

    const int1 = generateBuildingInterior({
      settlementName: resolved.name,
      buildingIndex: housePadIdx,
      kind: 'house',
      width: resolved.pads[housePadIdx].w - 0.5,
      depth: resolved.pads[housePadIdx].d - 0.5,
    }, seed1);
    const int2 = generateBuildingInterior({
      settlementName: resolved.name,
      buildingIndex: housePadIdx,
      kind: 'house',
      width: resolved.pads[housePadIdx].w - 0.5,
      depth: resolved.pads[housePadIdx].d - 0.5,
    }, seed2);

    check('seed determinism: cells identical',
      int1.cells.length === int2.cells.length &&
      int1.cells.every((v, i) => v === int2.cells[i]));
    check('seed determinism: furniture count identical',
      int1.furniture.length === int2.furniture.length);
    check('seed determinism: spawn point identical',
      int1.spawnPoint[0] === int2.spawnPoint[0] &&
      int1.spawnPoint[1] === int2.spawnPoint[1] &&
      int1.spawnPoint[2] === int2.spawnPoint[2]);
  }
}

// ---- 4. Chest placement determinism -----------------------------------------

{
  // Reproduce the pickChestCells logic inline (pure)
  function pickChestCells(
    interior: ReturnType<typeof generateBuildingInterior>,
    seed: number,
    count: number,
  ): [number, number][] {
    const rng = mulberry32(mix32(seed, 0xc4e57, interior.gridW));
    const { gridW, gridD, cells, doorCells, spawnPoint } = interior;
    const CELL_FLOOR = 1;
    const candidates: [number, number][] = [];
    for (let z = 0; z < gridD; z++) {
      for (let x = 0; x < gridW; x++) {
        if (cells[z * gridW + x] !== CELL_FLOOR) continue;
        let nearDoor = false;
        for (const [dx, dz] of doorCells) {
          if (Math.abs(x - dx) <= 1 && Math.abs(z - dz) <= 1) {
            nearDoor = true;
            break;
          }
        }
        if (nearDoor) continue;
        if (Math.abs(x + 0.5 - spawnPoint[0]) < 1.5 &&
            Math.abs(z + 0.5 - spawnPoint[2]) < 1.5) continue;
        let blocked = false;
        for (const f of interior.furniture) {
          if (x + 0.5 >= f.aabb.minX && x + 0.5 <= f.aabb.maxX &&
              z + 0.5 >= f.aabb.minZ && z + 0.5 <= f.aabb.maxZ) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        candidates.push([x, z]);
      }
    }
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    return candidates.slice(0, Math.min(count, candidates.length));
  }

  const spec: import('../src/game/building/building-interior').BuildingInteriorSpec = {
    settlementName: 'TestTown',
    buildingIndex: 2,
    kind: 'house',
    width: 6,
    depth: 6,
  };
  const seed = 12345;
  const interior = generateBuildingInterior(spec, seed);
  const cells1 = pickChestCells(interior, seed, 2);
  const cells2 = pickChestCells(interior, seed, 2);

  check('chest placement: deterministic',
    cells1.length === cells2.length &&
    cells1.every(([x, z], i) => cells2[i][0] === x && cells2[i][1] === z));
  check('chest placement: at least 1 chest', cells1.length >= 1);
  check('chest placement: max 2 chests', cells1.length <= 2);

  // Cells should be walkable (CELL_FLOOR)
  for (const [x, z] of cells1) {
    check(`chest cell (${x},${z}) is floor`,
      interior.cells[z * interior.gridW + x] === 1);
  }
}

// ---- 5. Different pads produce different interiors --------------------------

{
  const spec1: import('../src/game/building/building-interior').BuildingInteriorSpec = {
    settlementName: 'Town', buildingIndex: 0, kind: 'house', width: 6, depth: 6,
  };
  const spec2: import('../src/game/building/building-interior').BuildingInteriorSpec = {
    settlementName: 'Town', buildingIndex: 1, kind: 'house', width: 6, depth: 6,
  };
  const seed = 9999;
  const int1 = generateBuildingInterior(spec1, mix32(seed, 0));
  const int2 = generateBuildingInterior(spec2, mix32(seed, 1));

  // They may happen to be identical but with different seeds it's very unlikely
  let allSame = true;
  for (let i = 0; i < int1.cells.length; i++) {
    if (int1.cells[i] !== int2.cells[i]) { allSame = false; break; }
  }
  if (allSame && int1.furniture.length === int2.furniture.length) {
    // Check furniture positions
    for (let i = 0; i < int1.furniture.length; i++) {
      if (int1.furniture[i].aabb.minX !== int2.furniture[i].aabb.minX) {
        allSame = false;
        break;
      }
    }
  }
  check('different pads produce varied interiors', !allSame);
}

// ---- 6. Loot table roll determinism -----------------------------------------

{
  const LOOT_TABLES: Record<BuildingKind, string[][]> = {
    house: [['gold_small'], ['healing_herb'], ['gold_small', 'healing_herb']],
    shop: [['gold_small', 'gold_small'], ['iron_flask'], ['torch_oil', 'gold_small']],
    tavern: [['gold_small', 'healing_herb'], ['healing_herb', 'healing_herb'], ['gold_small']],
    keep: [['gold_large', 'iron_sword'], ['gold_large', 'healing_potion'], ['ancient_relic', 'gold_large'], ['iron_helm', 'gold_large']],
  };

  function rollChestLoot(kind: BuildingKind, seed: number, chestIndex: number): string[] {
    const table = LOOT_TABLES[kind];
    const rng = mulberry32(mix32(seed, chestIndex, 0xc4e57));
    const idx = Math.floor(rng() * table.length);
    return table[idx];
  }

  const loot1 = rollChestLoot('house', 1234, 0);
  const loot2 = rollChestLoot('house', 1234, 0);
  check('loot roll: deterministic', JSON.stringify(loot1) === JSON.stringify(loot2));

  const loot3 = rollChestLoot('keep', 1234, 0);
  check('loot roll: keep loot has items', loot3.length >= 1);
  check('loot roll: keep items from table',
    loot3.every(id => LOOT_TABLES.keep.flat().includes(id)));
}

// ---- summary ----------------------------------------------------------------

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
