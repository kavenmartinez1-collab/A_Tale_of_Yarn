/**
 * Deterministic unit tests for the building interior generator + mesh builder.
 * Pure CPU — no GPU, no server. Run:  npx tsx scripts/test-building-interior.mts
 *
 * Covers: determinism, door openings, furniture containment, per-kind differences,
 * spawn point validity, mesh vertex count/stride, and collider AABB well-formedness.
 */

import {
  generateBuildingInterior,
  reachableFloorCells,
  BUILDING_KINDS,
  MAX_INTERIOR_LIGHTS,
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

const ALL_KINDS = BUILDING_KINDS as readonly BuildingKind[];

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

for (const kind of ALL_KINDS) {
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

for (const kind of ALL_KINDS) {
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

for (const kind of ALL_KINDS) {
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

for (const kind of ALL_KINDS) {
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

  // Light props. Only fixtures with their own holder emit wood (torch sconce,
  // hearth logs); candles and lanterns are decor props that carry their own
  // wick, braziers and forges are coal beds, and a daylight window emits
  // nothing at all. What is invariant is the one-entry-per-light contract.
  const lightProps = buildLightProps(interior);
  if (interior.lights.length > 0) {
    const kinds = new Set(interior.lights.map((l) => l.kind));
    const needsWood = kinds.has('torch') || kinds.has('hearth');
    const needsFlame = needsWood || kinds.has('brazier') || kinds.has('forge');
    check(`${kind}: light wood mesh has verts`,
      !needsWood || lightProps.wood.length > 0);
    check(`${kind}: light flame mesh has verts`,
      !needsFlame || lightProps.flame.length > 0);
    check(`${kind}: light wood stride`, lightProps.wood.length % VERTEX_STRIDE === 0);
    check(`${kind}: light flame stride`, lightProps.flame.length % VERTEX_STRIDE === 0);
    check(`${kind}: light positions count`, lightProps.lights.length === interior.lights.length);
  }
}

// ---- 7. Collider AABBs well-formed (min < max) ----------------------------

for (const kind of ALL_KINDS) {
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

for (const kind of ALL_KINDS) {
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

// ---- 11. Every kind is furnished, decorated and lit ------------------------

const SIGNATURE: Partial<Record<BuildingKind, readonly string[]>> = {
  house: ['bed', 'hearth', 'table'],
  shop: ['counter', 'shelf'],
  tavern: ['counter', 'hearth', 'bed'],
  keep: ['throne', 'brazier', 'dais'],
  church: ['altar', 'pew', 'dais'],
  longhouse: ['firetrench', 'sleepbench', 'throne'],
  smithy: ['forge', 'anvil', 'workbench'],
  barn: ['haybale', 'trough'],
  guardhouse: ['bunk', 'weaponrack'],
};

for (const kind of ALL_KINDS) {
  for (const seed of [7, 1337, 60013]) {
    const interior = generateBuildingInterior(makeSpec(kind, 9, 8), seed);
    const have = new Set(interior.furniture.map((f) => f.type));
    for (const want of SIGNATURE[kind] ?? []) {
      check(`${kind} seed ${seed}: has ${want}`, have.has(want as never),
        `types=${[...have].join(',')}`);
    }
    // "Inhabited" is not optional: an interior with no clutter is a set.
    check(`${kind} seed ${seed}: has decor`, interior.decor.length >= 12,
      `decor=${interior.decor.length}`);
    check(`${kind} seed ${seed}: has furniture`, interior.furniture.length >= 6,
      `furniture=${interior.furniture.length}`);
    // Point lights are the expensive thing; the budget is a hard cap.
    check(`${kind} seed ${seed}: within light budget`,
      interior.lights.length > 0 && interior.lights.length <= MAX_INTERIOR_LIGHTS,
      `lights=${interior.lights.length}`);
  }
}

// ---- 12. Nothing is stranded and nothing wedges the player -----------------
//
// The strongest guarantee in this file: walk the interior on the same
// sub-cell rules the collider uses and confirm the player can reach the
// furniture that matters. Getting wedged on a barrel is worse than clipping
// through one, so this runs for every kind at several seeds.

for (const kind of ALL_KINDS) {
  for (const seed of [3, 1337, 90210]) {
    const interior = generateBuildingInterior(makeSpec(kind, 9, 9), seed);
    const reachable = reachableFloorCells(interior);
    const reach = new Set(reachable.map(([x, z]) => `${x},${z}`));
    const floorCells: [number, number][] = [];
    for (let z = 0; z < interior.gridD; z++) {
      for (let x = 0; x < interior.gridW; x++) {
        if (interior.cells[z * interior.gridW + x] === 1) floorCells.push([x, z]);
      }
    }
    check(`${kind} seed ${seed}: most floor reachable`,
      reachable.length >= floorCells.length * 0.45,
      `reachable=${reachable.length}/${floorCells.length}`);

    // Everything the player must interact with — and the focal point every
    // layout composes toward — has a standable cell beside it.
    const FOCAL = new Set(['bed', 'bunk', 'sleepbench', 'throne', 'altar',
      'forge', 'anvil', 'counter', 'hearth', 'firetrench']);
    const mustReach = interior.furniture.filter(
      (f) => FOCAL.has(f.type) || f.tag === 'keeper');
    for (const f of mustReach) {
      const cx = (f.aabb.minX + f.aabb.maxX) / 2;
      const cz = (f.aabb.minZ + f.aabb.maxZ) / 2;
      let ok = false;
      for (const [x, z] of reachable) {
        if (Math.hypot(x + 0.5 - cx, z + 0.5 - cz) <= 2.9) { ok = true; break; }
      }
      check(`${kind} seed ${seed}: ${f.type}${f.tag ? `/${f.tag}` : ''} reachable`, ok,
        `at ${cx.toFixed(1)},${cz.toFixed(1)}`);
    }

    // The spawn itself must be standable.
    const [sx, , sz] = interior.spawnPoint;
    check(`${kind} seed ${seed}: spawn cell reachable`,
      reach.has(`${Math.floor(sx)},${Math.floor(sz)}`),
      `spawn=${sx},${sz}`);
  }
}

// ---- 12b. The player can move the instant they arrive ---------------------
//
// Replays the collider's own rule at the spawn point. A partition wall two
// cells from a centred door once put the spawn inside the wall's inflated
// footprint, and `moveXZ` then rejected every direction: wedged solid on
// entry, with no way out but the exit prompt. This is the regression guard.

const PLAYER_R = 0.35;
for (const kind of ALL_KINDS) {
  for (let seed = 0; seed < 24; seed++) {
    const interior = generateBuildingInterior(makeSpec(kind, 9, 9), seed * 7919 + 11);
    const [sx, , sz] = interior.spawnPoint;
    // Rule 1: no solid cell inside the radius box (BuildingCollider.blocked).
    let wedged = false;
    for (let cz = Math.floor(sz - PLAYER_R); cz <= Math.floor(sz + PLAYER_R); cz++) {
      for (let cx = Math.floor(sx - PLAYER_R); cx <= Math.floor(sx + PLAYER_R); cx++) {
        if (cx < 0 || cz < 0 || cx >= interior.gridW || cz >= interior.gridD
            || interior.cells[cz * interior.gridW + cx] === 0) wedged = true;
      }
    }
    // Rule 2: no furniture AABB overlapping (BuildingCollider.furnitureBlocked).
    for (const f of interior.furniture) {
      if (f.aabb.maxY <= 0.3) continue;
      if (sx + PLAYER_R > f.aabb.minX && sx - PLAYER_R < f.aabb.maxX &&
          sz + PLAYER_R > f.aabb.minZ && sz - PLAYER_R < f.aabb.maxZ) wedged = true;
    }
    check(`${kind} seed#${seed}: not wedged at spawn`, !wedged,
      `spawn=${sx.toFixed(2)},${sz.toFixed(2)} grid=${interior.gridW}x${interior.gridD}`);
    // And the exit has to be reachable from there, or the player is trapped.
    const cells = reachableFloorCells(interior);
    check(`${kind} seed#${seed}: has walkable floor`, cells.length >= 6,
      `reachable=${cells.length}`);
  }
}

// ---- 13. Furniture does not intersect other furniture ----------------------

for (const kind of ALL_KINDS) {
  for (const seed of [11, 1337]) {
    const interior = generateBuildingInterior(makeSpec(kind, 10, 9), seed);
    const solid = interior.furniture.filter((f) => f.type !== 'rug' && f.type !== 'dais');
    let clash: string | null = null;
    for (let i = 0; i < solid.length && clash === null; i++) {
      for (let j = i + 1; j < solid.length; j++) {
        const a = solid[i].aabb, b = solid[j].aabb;
        if (a.minX < b.maxX - 1e-6 && a.maxX > b.minX + 1e-6 &&
            a.minZ < b.maxZ - 1e-6 && a.maxZ > b.minZ + 1e-6 &&
            a.minY < b.maxY - 1e-6 && a.maxY > b.minY + 1e-6) {
          clash = `${solid[i].type} x ${solid[j].type}`;
          break;
        }
      }
    }
    check(`${kind} seed ${seed}: no furniture overlap`, clash === null, clash ?? '');
  }
}

// ---- 14. Furniture respects the ceiling over its own cells -----------------

for (const kind of ALL_KINDS) {
  const interior = generateBuildingInterior(makeSpec(kind, 10, 10), 4242);
  let bad: string | null = null;
  for (const f of interior.furniture) {
    const x0 = Math.floor(f.aabb.minX + 1e-3), x1 = Math.ceil(f.aabb.maxX - 1e-3) - 1;
    const z0 = Math.floor(f.aabb.minZ + 1e-3), z1 = Math.ceil(f.aabb.maxZ - 1e-3) - 1;
    for (let z = z0; z <= z1 && bad === null; z++) {
      for (let x = x0; x <= x1; x++) {
        const c = interior.ceilY[z * interior.gridW + x];
        if (interior.cells[z * interior.gridW + x] === 0) { bad = `${f.type} in a wall`; break; }
        if (f.aabb.maxY > c + 1e-3) { bad = `${f.type} ${f.aabb.maxY} > ceil ${c}`; break; }
      }
    }
  }
  check(`${kind}: furniture under its own ceiling`, bad === null, bad ?? '');
}

// ---- 15. Tavern bed rental fixtures ----------------------------------------

for (const seed of [1, 5, 1337, 88888]) {
  const tavern = generateBuildingInterior(makeSpec('tavern', 9, 8), seed);
  const rentBeds = tavern.furniture.filter((f) => f.tag === 'rent');
  const keeper = tavern.furniture.filter((f) => f.tag === 'keeper');
  check(`tavern seed ${seed}: has a rentable bed`, rentBeds.length >= 1,
    `rent=${rentBeds.length}`);
  check(`tavern seed ${seed}: has a keeper post`, keeper.length === 1,
    `keeper=${keeper.length}`);
  check(`tavern seed ${seed}: rentable beds are beds`,
    rentBeds.every((f) => f.type === 'bed'));
  check(`tavern seed ${seed}: guest room exists`,
    tavern.rooms.some((r) => r.label === 'guest room'));
  // Only taverns rent.
  for (const kind of ALL_KINDS) {
    if (kind === 'tavern') continue;
    const other = generateBuildingInterior(makeSpec(kind, 9, 8), seed);
    check(`${kind} seed ${seed}: no rentable beds`,
      other.furniture.every((f) => f.tag !== 'rent'));
  }
}

// ---- 16. Gables are well-formed and match their ceiling --------------------

for (const kind of ALL_KINDS) {
  const interior = generateBuildingInterior(makeSpec(kind, 10, 12), 606);
  const g = interior.gable;
  if (g === null) continue;
  check(`${kind}: gable rect well-formed`, g.x1 > g.x0 && g.z1 > g.z0);
  check(`${kind}: gable ridge above eaves`, g.ridge > g.eaves);
  check(`${kind}: ceilHeight covers the ridge`, interior.ceilHeight >= g.ridge);
  let matches = true;
  for (let z = Math.floor(g.z0); z < g.z1; z++) {
    for (let x = Math.floor(g.x0); x < g.x1; x++) {
      const i = z * interior.gridW + x;
      if (interior.cells[i] === 1 && Math.abs(interior.ceilY[i] - g.eaves) > 1e-3) matches = false;
    }
  }
  check(`${kind}: gable cells sit at the eaves height`, matches);
}
check('some kind uses a gable roof',
  ALL_KINDS.some((k) => generateBuildingInterior(makeSpec(k, 10, 12), 606).gable !== null));

// ---- 17. Determinism across every kind, including decor --------------------

for (const kind of ALL_KINDS) {
  const spec = makeSpec(kind, 9, 10);
  const a = generateBuildingInterior(spec, 24601);
  const b = generateBuildingInterior(spec, 24601);
  check(`${kind}: deterministic furniture`,
    JSON.stringify(a.furniture) === JSON.stringify(b.furniture));
  check(`${kind}: deterministic decor`,
    JSON.stringify(a.decor) === JSON.stringify(b.decor));
  check(`${kind}: deterministic lights`,
    JSON.stringify(a.lights) === JSON.stringify(b.lights));
  const ma = buildFurnitureMeshes(a);
  const mb = buildFurnitureMeshes(b);
  check(`${kind}: deterministic prop mesh palettes`,
    JSON.stringify([...ma.keys()].sort()) === JSON.stringify([...mb.keys()].sort()));
  let identical = true;
  for (const [pal, verts] of ma) {
    const other = mb.get(pal);
    if (other === undefined || other.length !== verts.length) { identical = false; break; }
  }
  check(`${kind}: deterministic prop mesh sizes`, identical);
}

// ---- 18. Draw-call and vertex budget ---------------------------------------
//
// One draw per palette used, so the palette count IS the draw count for props.
// The whole interior (shell 2 + fixtures 2 + props + chests) must stay well
// inside a sane per-frame budget — there is no frustum culling on these.

for (const kind of ALL_KINDS) {
  const interior = generateBuildingInterior(makeSpec(kind, 12, 12), 31337);
  const props = buildFurnitureMeshes(interior);
  const shellV = buildBuildingInteriorMesh(interior, 'walls').length
    + buildBuildingInteriorMesh(interior, 'floor').length;
  let propV = 0;
  for (const v of props.values()) propV += v.length;
  const totalVerts = (shellV + propV) / VERTEX_STRIDE;
  const drawCalls = props.size + 4 + 2; // props + shell(2) + fixtures(2) + chests(2)
  check(`${kind}: prop palettes <= 18`, props.size <= 18, `palettes=${props.size}`);
  check(`${kind}: total draws <= 24`, drawCalls <= 24, `draws=${drawCalls}`);
  check(`${kind}: total verts <= 160k`, totalVerts <= 160_000,
    `verts=${Math.round(totalVerts)}`);
  check(`${kind}: props are stride-aligned`,
    [...props.values()].every((v) => v.length % VERTEX_STRIDE === 0
      && (v.length / VERTEX_STRIDE) % 3 === 0));
}

// ---- 19. Build cost --------------------------------------------------------
//
// Interiors are generated on entry, so generation is on the critical path
// between the E press and the first frame inside.

{
  const worst = { kind: '' as BuildingKind, ms: 0 };
  for (const kind of ALL_KINDS) {
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) {
      const interior = generateBuildingInterior(makeSpec(kind, 12, 12), 1000 + i);
      buildFurnitureMeshes(interior);
      buildBuildingInteriorMesh(interior);
    }
    const ms = (performance.now() - t0) / 10;
    if (ms > worst.ms) { worst.kind = kind; worst.ms = ms; }
  }
  check(`build time under 25 ms/interior (worst ${worst.kind} ${worst.ms.toFixed(1)} ms)`,
    worst.ms < 25, `${worst.ms.toFixed(2)} ms`);
  console.log(`  slowest interior build: ${worst.kind} ${worst.ms.toFixed(2)} ms`);
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
