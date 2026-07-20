/**
 * Deterministic unit tests for the building interior generator + mesh builder.
 * Pure CPU — no GPU, no server. Run:  npx tsx scripts/test-building-interior.mts
 *
 * Covers: determinism, door openings, furniture containment, per-kind differences,
 * spawn point validity, mesh vertex count/stride, and collider AABB well-formedness.
 */

import {
  generateBuildingInterior,
  type BuildingInteriorSpec,
  type BuildingInterior,
  type AABB,
  type BuildingKind,
} from '../src/game/building/building-interior';
import {
  buildBuildingInteriorMesh,
  buildFurnitureMeshes,
  buildLightProps,
  getColliderAABBs,
  VERTEX_STRIDE,
} from '../src/game/building/building-interior-mesh';

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

// ---- helper specs ---------------------------------------------------------

function makeSpec(kind: BuildingKind, width = 6, depth = 6): BuildingInteriorSpec {
  return {
    settlementName: 'TestTown',
    buildingIndex: 0,
    kind,
    width,
    depth,
  };
}

// ---- 1. Determinism -------------------------------------------------------

{
  const spec = makeSpec('house', 7, 7);
  const a = generateBuildingInterior(spec, 1337);
  const b = generateBuildingInterior(spec, 1337);

  // Cell grids must be byte-identical
  check('determinism: cells identical',
    a.cells.length === b.cells.length &&
    a.cells.every((v, i) => v === b.cells[i]));

  // Furniture arrays must be identical
  check('determinism: furniture identical',
    JSON.stringify(a.furniture) === JSON.stringify(b.furniture));

  // Lights must be identical
  check('determinism: lights identical',
    JSON.stringify(a.lights) === JSON.stringify(b.lights));

  // Spawn point identical
  check('determinism: spawn identical',
    JSON.stringify(a.spawnPoint) === JSON.stringify(b.spawnPoint));

  // Different seed produces different layout
  const c = generateBuildingInterior(spec, 42);
  const aCells = Array.from(a.cells).join(',');
  const cCells = Array.from(c.cells).join(',');
  // They should differ in furniture at minimum (cells might be same for same dims)
  check('different seed differs',
    JSON.stringify(a.furniture) !== JSON.stringify(c.furniture) || aCells !== cCells);
}

// ---- 2. Door opening exists -----------------------------------------------

function hasDoorOpening(interior: BuildingInterior): boolean {
  return interior.doorCells.length > 0 &&
    interior.doorCells.every(([x, z]) => {
      const idx = z * interior.gridW + x;
      return interior.cells[idx] === 2; // CELL_DOOR
    });
}

for (const kind of ['house', 'shop', 'tavern', 'keep'] as BuildingKind[]) {
  const spec = makeSpec(kind, 8, 8);
  const interior = generateBuildingInterior(spec, 99);
  check(`${kind}: door opening exists`, hasDoorOpening(interior),
    `doorCells: ${JSON.stringify(interior.doorCells)}`);
}

// ---- 3. Furniture stays inside walls (AABB containment) -------------------

function furnitureContained(interior: BuildingInterior): boolean {
  // All furniture AABBs must be within the walkable floor area
  for (const f of interior.furniture) {
    const { minX, minZ, maxX, maxZ, minY, maxY } = f.aabb;
    // Must be within grid bounds (excluding solid border)
    if (minX < 1 || minZ < 1 || maxX > interior.gridW - 1 || maxZ > interior.gridD - 1) {
      return false;
    }
    // Must be above floor and below ceiling
    if (minY < 0 || maxY > interior.ceilHeight) {
      return false;
    }
  }
  return true;
}

for (const kind of ['house', 'shop', 'tavern', 'keep'] as BuildingKind[]) {
  for (const seed of [1337, 42, 77777]) {
    const spec = makeSpec(kind, 8, 8);
    const interior = generateBuildingInterior(spec, seed);
    check(`${kind} seed ${seed}: furniture inside walls`, furnitureContained(interior));
  }
}

// ---- 4. Per-kind furniture differences ------------------------------------

{
  const houseInt = generateBuildingInterior(makeSpec('house', 7, 7), 100);
  const shopInt = generateBuildingInterior(makeSpec('shop', 7, 7), 100);
  const tavernInt = generateBuildingInterior(makeSpec('tavern', 8, 8), 100);
  const keepInt = generateBuildingInterior(makeSpec('keep', 12, 12), 100);

  const types = (int: BuildingInterior) => new Set(int.furniture.map(f => f.type));

  // House has bed
  check('house has bed', types(houseInt).has('bed'));
  // House has hearth
  check('house has hearth', types(houseInt).has('hearth'));
  // Shop has counter or shelf
  check('shop has counter or shelf', types(shopInt).has('counter') || types(shopInt).has('shelf'));
  // Tavern has counter (bar) or table
  check('tavern has counter or table', types(tavernInt).has('counter') || types(tavernInt).has('table'));
  // Keep has throne or brazier or banner
  check('keep has throne/brazier/banner',
    types(keepInt).has('throne') || types(keepInt).has('brazier') || types(keepInt).has('banner'));

  // Kinds produce genuinely different furniture sets
  const houseTypes = JSON.stringify([...types(houseInt)].sort());
  const shopTypes = JSON.stringify([...types(shopInt)].sort());
  const tavernTypes = JSON.stringify([...types(tavernInt)].sort());
  check('house != shop furniture', houseTypes !== shopTypes);
  check('shop != tavern furniture', shopTypes !== tavernTypes);
}

// ---- 5. Spawn point inside and clear of colliders -------------------------

function spawnValid(interior: BuildingInterior): { inside: boolean; clearOfColliders: boolean } {
  const [sx, sy, sz] = interior.spawnPoint;
  // Must be within grid bounds (walkable area)
  const inside = sx >= 1 && sx <= interior.gridW - 1 &&
                 sz >= 1 && sz <= interior.gridD - 1 &&
                 sy >= 0 && sy <= interior.ceilHeight;

  // Must not overlap any collider (with player capsule radius ~0.35)
  const playerR = 0.35;
  const playerAABB: AABB = {
    minX: sx - playerR, minY: sy, minZ: sz - playerR,
    maxX: sx + playerR, maxY: sy + 1.8, maxZ: sz + playerR,
  };
  let clear = true;
  for (const c of interior.colliders) {
    if (playerAABB.minX < c.maxX && playerAABB.maxX > c.minX &&
        playerAABB.minY < c.maxY && playerAABB.maxY > c.minY &&
        playerAABB.minZ < c.maxZ && playerAABB.maxZ > c.minZ) {
      clear = false;
      break;
    }
  }
  return { inside, clearOfColliders: clear };
}

for (const kind of ['house', 'shop', 'tavern', 'keep'] as BuildingKind[]) {
  for (const seed of [1337, 42, 99999]) {
    const spec = makeSpec(kind, 8, 8);
    const interior = generateBuildingInterior(spec, seed);
    const { inside, clearOfColliders } = spawnValid(interior);
    check(`${kind} seed ${seed}: spawn inside`, inside,
      `spawn=${JSON.stringify(interior.spawnPoint)} grid=${interior.gridW}x${interior.gridD}`);
    check(`${kind} seed ${seed}: spawn clear of colliders`, clearOfColliders);
  }
}

// ---- 6. Mesh vertex count > 0 and multiple of vertex stride ---------------

for (const kind of ['house', 'shop', 'tavern', 'keep'] as BuildingKind[]) {
  const spec = makeSpec(kind, 8, 8);
  const interior = generateBuildingInterior(spec, 42);
  const mesh = buildBuildingInteriorMesh(interior);

  check(`${kind}: mesh vertex count > 0`, mesh.length > 0);
  check(`${kind}: mesh length multiple of stride`,
    mesh.length % VERTEX_STRIDE === 0,
    `length=${mesh.length} stride=${VERTEX_STRIDE}`);

  // Each vertex must be a group of 3 floats (triangle, so count divisible by 3 verts)
  const vertexCount = mesh.length / VERTEX_STRIDE;
  check(`${kind}: vertex count divisible by 3 (triangles)`,
    vertexCount % 3 === 0,
    `vertexCount=${vertexCount}`);

  // Furniture meshes
  const furnitureMeshes = buildFurnitureMeshes(interior);
  for (const [palette, fmesh] of furnitureMeshes) {
    check(`${kind}: furniture palette ${palette} length multiple of stride`,
      fmesh.length % VERTEX_STRIDE === 0);
    check(`${kind}: furniture palette ${palette} vertex count div 3`,
      (fmesh.length / VERTEX_STRIDE) % 3 === 0);
  }

  // Light props. Wood geometry only exists for kinds that need a holder
  // (torch sconce, candle stick, hearth logs) — braziers are flame-only.
  const lightProps = buildLightProps(interior);
  if (interior.lights.length > 0) {
    const needsWood = interior.lights.some(
      (l) => l.kind === 'torch' || l.kind === 'candle' || l.kind === 'hearth');
    check(`${kind}: light wood mesh has verts`,
      !needsWood || lightProps.wood.length > 0);
    check(`${kind}: light flame mesh has verts`, lightProps.flame.length > 0);
    check(`${kind}: light wood stride`, lightProps.wood.length % VERTEX_STRIDE === 0);
    check(`${kind}: light flame stride`, lightProps.flame.length % VERTEX_STRIDE === 0);
    check(`${kind}: light positions count`, lightProps.lights.length === interior.lights.length);
  }
}

// ---- 7. Collider AABBs well-formed (min < max) ----------------------------

for (const kind of ['house', 'shop', 'tavern', 'keep'] as BuildingKind[]) {
  const spec = makeSpec(kind, 8, 8);
  const interior = generateBuildingInterior(spec, 1337);
  const aabbs = getColliderAABBs(interior);

  check(`${kind}: has colliders`, aabbs.length > 0);

  let allWellFormed = true;
  for (const aabb of aabbs) {
    if (aabb.minX >= aabb.maxX || aabb.minY >= aabb.maxY || aabb.minZ >= aabb.maxZ) {
      allWellFormed = false;
      break;
    }
  }
  check(`${kind}: all collider AABBs well-formed (min < max)`, allWellFormed);
}

// ---- 8. Keep has multiple rooms -------------------------------------------

{
  const spec = makeSpec('keep', 12, 12);
  const interior = generateBuildingInterior(spec, 1337);
  check('keep: multiple rooms', interior.rooms.length >= 2,
    `rooms=${interior.rooms.length}`);
  check('keep: has throne room',
    interior.rooms.some(r => r.label === 'throne'));
  check('keep: has hall',
    interior.rooms.some(r => r.label === 'hall'));
}

// ---- 9. Varying footprint scales interior ---------------------------------

{
  const small = generateBuildingInterior(makeSpec('house', 4, 4), 50);
  const large = generateBuildingInterior(makeSpec('house', 12, 12), 50);
  check('footprint scaling: larger house has more cells',
    large.gridW * large.gridD > small.gridW * small.gridD);

  const smallMesh = buildBuildingInteriorMesh(small);
  const largeMesh = buildBuildingInteriorMesh(large);
  check('footprint scaling: larger house has more verts',
    largeMesh.length > smallMesh.length);
}

// ---- 10. Exit zone is at door and well-formed -----------------------------

for (const kind of ['house', 'shop', 'tavern', 'keep'] as BuildingKind[]) {
  const spec = makeSpec(kind, 8, 8);
  const interior = generateBuildingInterior(spec, 777);
  const ez = interior.exitZone;
  check(`${kind}: exitZone well-formed`,
    ez.minX < ez.maxX && ez.minY < ez.maxY && ez.minZ < ez.maxZ);
  // Exit zone should be near a door cell
  const doorCenters = interior.doorCells.map(([x, z]) => [x + 0.5, z + 0.5]);
  const ezCenter = [(ez.minX + ez.maxX) / 2, (ez.minZ + ez.maxZ) / 2];
  const nearDoor = doorCenters.some(([dx, dz]) =>
    Math.abs(dx - ezCenter[0]) < 2 && Math.abs(dz - ezCenter[1]) < 2);
  check(`${kind}: exitZone near door`, nearDoor);
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
