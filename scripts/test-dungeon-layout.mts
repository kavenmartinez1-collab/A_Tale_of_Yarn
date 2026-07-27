/**
 * Deterministic unit tests for the dungeon spec validator + layout generator.
 * Pure CPU — no GPU, no server. Run:  npx tsx scripts/test-dungeon-layout.mts
 *
 * The golden FNV hash is the determinism tripwire: if layout output changes
 * for any reason (PRNG draw order, iteration order, algorithm tweak), this
 * fails and the change must be deliberate (update the constant in the same
 * commit and re-verify a dungeon in-game).
 */

import { validateSpec, FALLBACK_SPEC } from '../src/game/dungeon/dungeon-spec';
import type { DungeonSpec } from '../src/game/dungeon/dungeon-spec';
import {
  layoutDungeon, serpentineLayout, mix32,
  CELL_SOLID, CELL_DOOR,
} from '../src/game/dungeon/dungeon-layout';
import { buildTorchProps } from '../src/game/dungeon/dungeon-props';
import { POSN_FLOATS } from '../src/game/mesh-utils';
import type { DungeonLayout } from '../src/game/dungeon/dungeon-layout';
import { DUNGEON_FIXTURES } from '../src/game/dungeon/dungeon-fixtures';

/** Update ONLY on deliberate layout-algorithm changes (see header). */
const GOLDEN_HASH: number | null = 0xeaa69bdb;

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

function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** BFS over walkable cells (4-connected) from the spawn cell. */
function reachableSet(layout: DungeonLayout): Set<number> {
  const { w, h, cells, spawnCell } = layout;
  const seen = new Set<number>();
  const queue: number[] = [spawnCell[1] * w + spawnCell[0]];
  seen.add(queue[0]);
  while (queue.length > 0) {
    const cur = queue.pop()!;
    const x = cur % w;
    const z = (cur - x) / w;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const xx = x + dx;
      const zz = z + dz;
      if (xx < 0 || zz < 0 || xx >= w || zz >= h) continue;
      const idx = zz * w + xx;
      if (cells[idx] === CELL_SOLID || seen.has(idx)) continue;
      seen.add(idx);
      queue.push(idx);
    }
  }
  return seen;
}

function checkLayoutInvariants(name: string, spec: DungeonSpec, layout: DungeonLayout): void {
  const { w, h, cells, ceilY } = layout;
  check(`${name}: all rooms placed`, layout.rooms.length === spec.rooms.length);
  check(`${name}: entrance first`, layout.rooms[0].type === 'entrance');

  // Grid border must stay solid (walls always closed).
  let borderOk = true;
  for (let x = 0; x < w; x++) {
    if (cells[x] !== CELL_SOLID || cells[(h - 1) * w + x] !== CELL_SOLID) borderOk = false;
  }
  for (let z = 0; z < h; z++) {
    if (cells[z * w] !== CELL_SOLID || cells[z * w + (w - 1)] !== CELL_SOLID) borderOk = false;
  }
  check(`${name}: border solid`, borderOk);

  // Every walkable cell has a positive ceiling.
  let ceilOk = true;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== CELL_SOLID && ceilY[i] <= 0) ceilOk = false;
  }
  check(`${name}: walkable cells have ceilings`, ceilOk);

  // Everything the player must reach is reachable from spawn.
  const reach = reachableSet(layout);
  const at = (c: [number, number]) => reach.has(c[1] * w + c[0]);
  check(`${name}: all room centers reachable`,
    layout.rooms.every((r) => reach.has(r.cz * w + r.cx)));
  check(`${name}: exit portal reachable`, at(layout.exitPortalCell));
  check(`${name}: chests reachable`, layout.chests.every((c) => at(c.cell)),
    `${layout.chests.length} chests`);
  check(`${name}: torches reachable`, layout.torches.every((t) => at(t.cell)),
    `${layout.torches.length} torches`);
  check(`${name}: has torches`, layout.torches.length > 0);
  check(`${name}: torch wallDir valid`,
    layout.torches.every((t) => t.wallDir >= 0 && t.wallDir <= 3));

  // Treasure rooms must actually contain their loot.
  const lootedRooms = spec.rooms.filter((r) => r.type === 'treasure');
  const specLoot = lootedRooms.flatMap((r) => r.loot ?? []).sort();
  if (specLoot.length > 0 && !layout.fallback) {
    const placedLoot = layout.chests.flatMap((c) => c.items);
    check(`${name}: treasure loot placed`,
      specLoot.every((item) => placedLoot.includes(item)),
      `spec [${specLoot}] placed [${placedLoot}]`);
  }
}

// --- 1. validator accepts fixtures + fallback ------------------------------

for (const spec of DUNGEON_FIXTURES) {
  check(`validate fixture "${spec.name}"`, 'spec' in validateSpec(spec));
}
check('validate FALLBACK_SPEC', 'spec' in validateSpec(FALLBACK_SPEC));

// --- 2. validator rejects malformed specs ----------------------------------

const base = DUNGEON_FIXTURES[0];
const bad: [string, unknown][] = [
  ['null spec', null],
  ['empty object', {}],
  ['no entrance', { ...base, rooms: base.rooms.map((r) => ({ ...r, type: 'combat' })) }],
  ['two entrances', { ...base, rooms: base.rooms.map((r) => ({ ...r, type: 'entrance' })) }],
  ['duplicate ids', { ...base, rooms: base.rooms.map((r) => ({ ...r, id: 'same' })) }],
  ['unknown loot item', {
    ...base,
    rooms: [...base.rooms.slice(0, 3), { ...base.rooms[3], loot: ['excalibur'] }],
  }],
  ['edge to unknown id', { ...base, edges: [...base.edges, ['entry', 'nowhere']] }],
  ['self-loop edge', { ...base, edges: [...base.edges, ['entry', 'entry']] }],
  ['disconnected graph', { ...base, edges: base.edges.slice(0, 1) }],
  ['too many rooms', {
    ...base,
    rooms: Array.from({ length: 13 }, (_, i) => ({
      id: `r${i}`, type: i === 0 ? 'entrance' : 'combat', size: 'small',
    })),
    edges: Array.from({ length: 12 }, (_, i) => [`r${i}`, `r${i + 1}`]),
  }],
];
for (const [name, spec] of bad) {
  const result = validateSpec(spec);
  check(`reject ${name}`, 'errors' in result);
}

// --- 3. layout invariants for every fixture x seed -------------------------

const SEEDS = [1337, 20260717];
for (const spec of DUNGEON_FIXTURES) {
  for (const seed of SEEDS) {
    checkLayoutInvariants(`"${spec.name}" seed ${seed}`, spec, layoutDungeon(spec, seed));
  }
}

// --- 4. determinism: byte-identical reruns ---------------------------------

{
  const a = layoutDungeon(DUNGEON_FIXTURES[1], 1337);
  const b = layoutDungeon(DUNGEON_FIXTURES[1], 1337);
  check('determinism: cells byte-equal', fnv1a(a.cells) === fnv1a(b.cells));
  check('determinism: decoration identical',
    JSON.stringify({ r: a.rooms, c: a.chests, t: a.torches, p: a.exitPortalCell }) ===
    JSON.stringify({ r: b.rooms, c: b.chests, t: b.torches, p: b.exitPortalCell }));
  const c = layoutDungeon(DUNGEON_FIXTURES[1], 42);
  check('different seed differs', fnv1a(a.cells) !== fnv1a(c.cells));
}

// --- 5. golden hash tripwire -----------------------------------------------

{
  const hash = fnv1a(layoutDungeon(DUNGEON_FIXTURES[0], 1337).cells);
  if (GOLDEN_HASH === null) {
    console.log(`golden hash candidate (fixture 0, seed 1337): 0x${hash.toString(16)}`);
    check('golden hash set', false, 'fill GOLDEN_HASH with the candidate above');
  } else {
    check('golden hash', hash === GOLDEN_HASH,
      `got 0x${hash.toString(16)}, want 0x${GOLDEN_HASH.toString(16)}`);
  }
}

// --- 6. fallback path ------------------------------------------------------

{
  const spec = DUNGEON_FIXTURES[3]; // largest fixture
  const layout = serpentineLayout(spec);
  layout.spawnCell = [layout.rooms[0].cx, layout.rooms[0].cz];
  const reach = reachableSet(layout);
  check('fallback: all rooms placed', layout.rooms.length === spec.rooms.length);
  check('fallback: chain fully reachable',
    layout.rooms.every((r) => reach.has(r.cz * layout.w + r.cx)));
  check('fallback: flagged', layout.fallback);
}

// --- 7. seed mixing sanity -------------------------------------------------

check('mix32 deterministic', mix32(1337, 4, 2) === mix32(1337, 4, 2));
check('mix32 varies by args',
  mix32(1337, 4, 2) !== mix32(1337, 4, 3) && mix32(1337, 4, 2) !== mix32(1337, 5, 2));

// --- 8. prop placement, swept over every fixture x 40 seeds ----------------

// Layout-level: nothing decorative may sit in a wall, in a doorway, on the
// spawn, on top of another prop, or promise loot it has nowhere to put.
{
  const faults = new Map<string, string>();
  const fault = (what: string, where: string): void => {
    if (!faults.has(what)) faults.set(what, where);
  };
  let dungeons = 0;
  let torchCount = 0;
  let chestCount = 0;

  for (const spec of [...DUNGEON_FIXTURES, FALLBACK_SPEC]) {
    for (let seed = 0; seed < 40; seed++) {
      const L = layoutDungeon(spec, 1000 + seed);
      dungeons++;
      const tag = `${spec.name}#${seed}`;
      const cell = (x: number, z: number): number =>
        x < 0 || z < 0 || x >= L.w || z >= L.h ? CELL_SOLID : L.cells[z * L.w + x];
      const nbOf = (x: number, z: number, dir: number): [number, number] =>
        dir === 0 ? [x, z - 1] : dir === 1 ? [x + 1, z] : dir === 2 ? [x, z + 1] : [x - 1, z];

      // A room whose spec carries loot must end up with somewhere to put it,
      // or the Director's promise silently evaporates.
      for (const rs of spec.rooms) {
        const loot = rs.loot ?? [];
        if (loot.length === 0) continue;
        const room = L.rooms.find((r) => r.id === rs.id);
        if (room === undefined) { fault('room in the spec has no rect', `${tag} ${rs.id}`); continue; }
        const here = L.chests.filter((c) =>
          c.cell[0] >= room.x && c.cell[0] < room.x + room.w
          && c.cell[1] >= room.z && c.cell[1] < room.z + room.d);
        if (here.length === 0) {
          fault('room with loot got no chest', `${tag} ${rs.id} (${loot.join(',')})`);
        } else {
          const got = new Set(here.flatMap((c) => c.items));
          for (const item of loot) {
            if (!got.has(item)) fault('loot item vanished', `${tag} ${rs.id} ${item}`);
          }
        }
      }

      const occupied = new Set<string>();
      for (const t of L.torches) {
        torchCount++;
        const [x, z] = t.cell;
        // A torch is drawn hugging the wall in `wallDir`. If that neighbour is
        // not solid the whole fitting hangs off the middle of the room.
        const [nbx, nbz] = nbOf(x, z, t.wallDir);
        if (cell(nbx, nbz) !== CELL_SOLID) {
          fault('torch wall direction has no wall', `${tag} cell ${x},${z} dir ${t.wallDir}`);
        }
        if (cell(x, z) === CELL_SOLID) fault('torch inside a wall', `${tag} ${x},${z}`);
        const k = `${x},${z}`;
        if (occupied.has(k)) fault('two props in one cell', `${tag} ${k}`);
        occupied.add(k);
      }
      for (const c of L.chests) {
        chestCount++;
        const [x, z] = c.cell;
        if (cell(x, z) === CELL_SOLID) fault('chest inside a wall', `${tag} ${x},${z}`);
        if (cell(x, z) === CELL_DOOR) fault('chest in a doorway', `${tag} ${x},${z}`);
        if (x === L.spawnCell[0] && z === L.spawnCell[1]) fault('chest on the spawn cell', tag);
        const k = `${x},${z}`;
        if (occupied.has(k)) fault('two props in one cell', `${tag} ${k}`);
        occupied.add(k);
      }
      {
        const [x, z] = L.exitPortalCell;
        const [nbx, nbz] = nbOf(x, z, L.exitWallDir);
        if (cell(nbx, nbz) !== CELL_SOLID) {
          fault('exit portal has no wall behind it', `${tag} ${x},${z} dir ${L.exitWallDir}`);
        }
        if (cell(x, z) === CELL_SOLID) fault('exit portal inside a wall', `${tag} ${x},${z}`);
      }
      if (cell(L.spawnCell[0], L.spawnCell[1]) === CELL_SOLID) fault('spawn cell is solid', tag);
    }
  }

  console.log(`  prop sweep: ${dungeons} dungeons, ${torchCount} torches, ${chestCount} chests`);
  for (const [what, where] of faults) console.error(`    ${what} -- ${where}`);
  check(`prop placement clean over ${dungeons} dungeons`, faults.size === 0,
    `${faults.size} distinct faults`);
}

// --- 9. torch GEOMETRY reaches the wall it is bracketed to -----------------

// Not "the torch is at the right cell" -- that was already true while the prop
// was a 8 x 8 cm stick floating in mid-air with an 8 cm gap behind it and
// nothing underneath, which is what "floating torches" meant when it came back
// from play. This measures the emitted vertices against the wall plane: some
// geometry must come within 3 cm of the plane (so it is fixed to the wall),
// none may cross it (so nothing is buried in the masonry), and the wood must
// be continuous from the plane out to the flame with no gap wider than 4 cm.
{
  const worst = { gapToWall: 0, behind: 0, biggestHole: 0, verts: 0, where: '' };
  for (const spec of DUNGEON_FIXTURES) {
    for (let seed = 0; seed < 10; seed++) {
      const L = layoutDungeon(spec, 2000 + seed);
      const props = buildTorchProps(L);
      worst.verts = Math.max(worst.verts, props.wood.length / POSN_FLOATS);
      for (const t of L.torches) {
        const [x, z] = t.cell;
        // Wall plane and the inward normal, in dungeon-local metres.
        const dir = t.wallDir;
        const plane = dir === 0 ? z : dir === 1 ? x + 1 : dir === 2 ? z + 1 : x;
        const alongX = dir === 1 || dir === 3;
        const n = dir === 0 || dir === 1 ? (dir === 0 ? 1 : -1) : (dir === 2 ? -1 : 1);
        // Depth intervals, ONE PER TRIANGLE. A vertex list only tells you where
        // the corners are — a solid box 7 cm deep has no vertices in the middle
        // of it, so measuring the spacing between sorted vertex depths reports
        // a 7 cm hole through solid wood. Triangles carry the spans.
        const spans: [number, number][] = [];
        const depthOf = (i: number): number =>
          ((alongX ? props.wood[i] : props.wood[i + 2]) - plane) * n;
        for (let i = 0; i < props.wood.length; i += POSN_FLOATS * 3) {
          const vx = props.wood[i];
          const vz = props.wood[i + 2];
          // Only triangles in this torch's own cell.
          if (vx < x - 0.05 || vx > x + 1.05 || vz < z - 0.05 || vz > z + 1.05) continue;
          const a = depthOf(i);
          const b = depthOf(i + POSN_FLOATS);
          const c = depthOf(i + POSN_FLOATS * 2);
          spans.push([Math.min(a, b, c), Math.max(a, b, c)]);
        }
        if (spans.length === 0) { worst.where = `no wood at ${x},${z}`; worst.gapToWall = 99; continue; }
        spans.sort((p, q) => p[0] - q[0]);
        const nearest = spans[0][0];
        if (nearest < -1e-6 && -nearest > worst.behind) {
          worst.behind = -nearest;
          worst.where = `${spec.name}#${seed} cell ${x},${z}`;
        }
        if (nearest > worst.gapToWall) {
          worst.gapToWall = nearest;
          worst.where = `${spec.name}#${seed} cell ${x},${z}`;
        }
        // Merge the spans and take the biggest hole in the union: that is a
        // real stretch of air between the wall and the flame.
        let hole = 0;
        let reach = spans[0][1];
        for (const [lo, hi] of spans) {
          if (lo > reach && lo - reach > hole) hole = lo - reach;
          if (hi > reach) reach = hi;
        }
        if (hole > worst.biggestHole) worst.biggestHole = hole;
      }
    }
  }
  console.log(`  torch fitting: nearest vertex ${worst.gapToWall.toFixed(3)} m off the wall, `
    + `${worst.behind.toFixed(3)} m behind it, biggest gap ${worst.biggestHole.toFixed(3)} m, `
    + `${worst.verts} wood verts`);
  check('torch geometry touches its wall', worst.gapToWall <= 0.03, `${worst.gapToWall} m ${worst.where}`);
  check('torch geometry is not buried in the wall', worst.behind <= 1e-6,
    `${worst.behind} m ${worst.where}`);
  check('torch fitting has no gap in it', worst.biggestHole <= 0.04, `${worst.biggestHole} m`);
  // The bracket took a torch from 36 verts to 144. 32 is MAX_TORCHES, so this
  // caps the whole prop buffer at ~5k verts, which is nothing next to the
  // interior shell -- but it is the number that grows if somebody reaches for
  // a capsule, and a 6-segment capsule per part put it at 540.
  check('torch props stay under 8k verts', worst.verts < 8000, `${worst.verts}`);
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
