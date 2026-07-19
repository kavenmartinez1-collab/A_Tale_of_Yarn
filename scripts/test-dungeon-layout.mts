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
  CELL_SOLID,
} from '../src/game/dungeon/dungeon-layout';
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

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
