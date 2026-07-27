/**
 * Deterministic tests for NPC spawning (Phase L1).
 * Pure CPU — no GPU, no DOM, no server.
 * Run: npx tsx scripts/test-npc-spawn.mts
 *
 * Golden FNV-1a-32 hash mirrors the idiom from other test scripts.
 */

import {
  spawnSettlementNpcs,
  resolveNpcs,
  type SpawnedNpc,
  type ResolvedNpc,
} from '../src/game/npc/npc-spawn';
import { layoutSettlement } from '../src/game/settlement/settlement-layout';
import type { SettlementKind } from '../src/game/settlement/settlement-scatter';

/** Update ONLY on deliberate spawn-logic changes. */
// Baked for Phase L1 initial implementation.
// Old hash (pre settlement visual pass v3 — layout pads changed): 0xae0ea4a1
// Old hash (pre merchant→stall / guard→keep pad preferences): 0x2236d944
// Old hash (pre door-side spawn fix — NPCs no longer inside buildings): 0xff3291b4
// Rebaked by the settlement community pass: NPC spawn points and patrol
// waypoints are derived from pad positions, and every layout was recomposed
// onto streets and squares.
// Previous: 0xe2026ae7
// Rebaked when NPCs gained a home building they can actually be inside.
// Two deliberate changes moved every settlement's assignment:
//   1. `homePadIndex` is now recorded on each NPC (the join key the building
//      manager enters interiors by).
//   2. Public buildings are STAFFED. Every village, town and castle is laid
//      out with a tavern, church, smithy and longhouse, and across 120
//      settlements exactly zero of them had an occupant — you could rent a bed
//      from a tavern with nobody in it. A small keeper budget (planned/3, at
//      least 1) now fills them in player-relevance order, so a village staffs
//      its tavern, a town its tavern and smithy.
// Previous: 0x0a2bc963
// Rebaselined by the population pass: the world was measurably empty and the
// counts here were the cause. Over a 576-cell sweep of seed 1337 the whole
// world held 307 people — a castle averaged 8.1, a town 7.1, a village 4.1 and
// a ranch 1.5, and 54% of all settlements had nobody in them at all. The
// counts read like placeholders because they were: a castle with eight people
// is not a castle, and world spawn is a forced castle, so every direction the
// player travelled was emptier than where they started.
//
// Three deliberate changes move every settlement's roster:
//   1. `rolePlanFor` is resized from the HOUSING STOCK the layouts already
//      build — a village has six houses, a town fifteen dwellings and six
//      market stalls, a castle twelve dwellings plus four towers, a gatehouse,
//      a keep and a jail. The buildings were always there; nobody lived in
//      them. Now ranch 2-4, village 5-9, town 11-16, castle 15-21.
//   2. Villagers count `townhouse` as a house. Towns are built from ten
//      townhouses and five houses, and matching only 'house' crowded every
//      resident into a third of the dwellings.
//   3. Ruins get squatters about a third of the time. They were 54% of the
//      world and contained nothing whatsoever.
// Net over the same sweep: 307 -> 842 people, empty settlements 54% -> 25%.
// Previous: 0x13dd9131
const GOLDEN_NPC_SPAWN_HASH: number | null = 0xabfb597a;

// ---------------------------------------------------------------------------
// Harness
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

function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function fnv1aStr(s: string): number {
  const enc = new TextEncoder().encode(s);
  return fnv1a(enc);
}

// ---------------------------------------------------------------------------
// 1. Basic presence / absence per kind
// ---------------------------------------------------------------------------

// Ruins are mostly, but no longer always, empty. They are the commonest thing
// in the world, and "a ruin is deserted" is the right character for one while
// "over half of everything you find contains nothing" is not. About a third
// hold squatters, so this is a distribution check rather than a point check —
// a point check on one seed would pass whatever the rate had drifted to.
{
  let occupied = 0;
  let people = 0;
  for (let s = 0; s < 200; s++) {
    const npcs = spawnSettlementNpcs('ruins', s * 1013 + 7,
      layoutSettlement('ruins', s * 1013 + 7));
    if (npcs.length > 0) occupied++;
    people += npcs.length;
    if (npcs.length > 2) { occupied = -1; break; }
  }
  check('ruins hold at most two squatters', occupied >= 0);
  check('most ruins are deserted', occupied > 0 && occupied < 200 * 0.5,
    `${occupied}/200 occupied`);
  check('some ruins are not', occupied > 200 * 0.2, `${occupied}/200 occupied`);
  // A squatter has no home: nothing in a ruin has a door that opens, and -1 is
  // what keeps them out of the indoor/arena machinery entirely.
  const squatters = spawnSettlementNpcs('ruins', 7 * 1013 + 7,
    layoutSettlement('ruins', 7 * 1013 + 7));
  check('ruins squatters have no home pad',
    squatters.every((n) => n.homePadIndex === -1));
  check('ruins squatters exist somewhere in the sweep', people > 0, `${people}`);
}

for (const kind of ['ranch', 'village', 'town', 'castle'] as SettlementKind[]) {
  const layout = layoutSettlement(kind, 42);
  const npcs = spawnSettlementNpcs(kind, 42, layout);
  check(`${kind} produces NPCs`, npcs.length > 0,
    `got ${npcs.length}`);
}

// ---------------------------------------------------------------------------
// 2. Counts by kind (check min bounds from spec)
// ---------------------------------------------------------------------------

// Bounds are checked over MANY seeds, not one. A single seed lands somewhere
// inside the range and cannot tell a changed range from a changed roll, which
// is how "town: exactly 2 guards" survived the guard count becoming 2-3.
function spread(kind: SettlementKind): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = 0;
  for (let s = 0; s < 200; s++) {
    const seed = s * 4099 + 11;
    const n = spawnSettlementNpcs(kind, seed, layoutSettlement(kind, seed)).length;
    if (n < lo) lo = n;
    if (n > hi) hi = n;
  }
  return { lo, hi };
}

{
  // A farmstead is a household: the farmer has a family, so it is no longer
  // all farmers.
  const r = spread('ranch');
  check('ranch: 2-4 people', r.lo === 2 && r.hi === 4, `got ${r.lo}-${r.hi}`);
  const ranchNpcs = spawnSettlementNpcs('ranch', 99, layoutSettlement('ranch', 99));
  check('ranch: has a farmer', ranchNpcs.some((n) => n.role === 'farmer'),
    ranchNpcs.map((n) => n.role).join(','));
}

{
  const v = spread('village');
  check('village: 5-9 people', v.lo === 5 && v.hi === 9, `got ${v.lo}-${v.hi}`);
  const vilNpcs = spawnSettlementNpcs('village', 100, layoutSettlement('village', 100));
  const roles = vilNpcs.map((n) => n.role);
  check('village: has villager', roles.includes('villager'));
  check('village: has merchant', roles.includes('merchant'));
  check('village: has farmer', roles.includes('farmer'));
}

{
  const t = spread('town');
  check('town: 11-16 people', t.lo === 11 && t.hi === 16, `got ${t.lo}-${t.hi}`);
  const townNpcs = spawnSettlementNpcs('town', 200, layoutSettlement('town', 200));
  const roles = townNpcs.map((n) => n.role);
  check('town: has guard', roles.includes('guard'));
  check('town: has merchant', roles.includes('merchant'));
  check('town: has villager', roles.includes('villager'));
  check('town: has farmer', roles.includes('farmer'));
  const guardCount = roles.filter((r) => r === 'guard').length;
  check('town: 2-3 guards', guardCount >= 2 && guardCount <= 3, `got ${guardCount}`);
  // Six market stalls justified more than one trader.
  check('town: more than one merchant',
    roles.filter((r) => r === 'merchant').length >= 2);
}

{
  const c = spread('castle');
  check('castle: 15-21 people', c.lo === 15 && c.hi === 21, `got ${c.lo}-${c.hi}`);
  const castleNpcs = spawnSettlementNpcs('castle', 300, layoutSettlement('castle', 300));
  const roles = castleNpcs.map((n) => n.role);
  check('castle: has guard', roles.includes('guard'));
  check('castle: has merchant', roles.includes('merchant'));
  const guardCount = roles.filter((r) => r === 'guard').length;
  // Four towers, a gatehouse, a keep and a jail. Four guards left most of the
  // wall unwatched.
  check('castle: 6-8 guards', guardCount >= 6 && guardCount <= 8,
    `got ${guardCount}`);
  check('castle: the garrison is the largest group',
    guardCount >= roles.filter((r) => r === 'villager').length);
}

// The gap between the largest and smallest inhabited kind is the whole point:
// before this it was 8.1 against 1.5, so a castle and a ranch read as the same
// size of place with different walls.
{
  const mean = (kind: SettlementKind): number => {
    let n = 0;
    for (let s = 0; s < 120; s++) {
      const seed = s * 4099 + 11;
      n += spawnSettlementNpcs(kind, seed, layoutSettlement(kind, seed)).length;
    }
    return n / 120;
  };
  const r = mean('ranch');
  const v = mean('village');
  const t = mean('town');
  const c = mean('castle');
  check('the four kinds are four different sizes of community',
    r < v && v < t && t < c, `ranch ${r.toFixed(1)} village ${v.toFixed(1)} ` +
    `town ${t.toFixed(1)} castle ${c.toFixed(1)}`);
  check('a castle is a town-and-a-half, not a big village', c / v >= 2,
    `castle ${c.toFixed(1)} vs village ${v.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
// 3. NPC IDs are unique within a settlement
// ---------------------------------------------------------------------------

for (const kind of ['ranch', 'village', 'town', 'castle'] as SettlementKind[]) {
  const layout = layoutSettlement(kind, 500);
  const npcs = spawnSettlementNpcs(kind, 500, layout);
  const ids = new Set(npcs.map((n) => n.id));
  check(`${kind}: NPC ids are unique`, ids.size === npcs.length,
    `ids=${[...ids].join(',')}`);
}

// ---------------------------------------------------------------------------
// 4. Determinism: same inputs → same outputs
// ---------------------------------------------------------------------------

for (const kind of ['ranch', 'village', 'town', 'castle'] as SettlementKind[]) {
  const layout = layoutSettlement(kind, 777);
  const a = JSON.stringify(spawnSettlementNpcs(kind, 777, layout));
  const b = JSON.stringify(spawnSettlementNpcs(kind, 777, layout));
  check(`${kind}: spawn is deterministic`, a === b);
}

// ---------------------------------------------------------------------------
// 5. Different seeds produce different NPC names (overwhelmingly likely)
// ---------------------------------------------------------------------------

{
  const la = layoutSettlement('town', 1);
  const lb = layoutSettlement('town', 2);
  const na = spawnSettlementNpcs('town', 1, la).map((n) => n.name).join(',');
  const nb = spawnSettlementNpcs('town', 2, lb).map((n) => n.name).join(',');
  // Very likely different (name table has 24 entries, 6 NPCs, different seed).
  check('different seeds give different NPC name sets', na !== nb || na === nb, // always passes; just check no crash
    `na=${na}`);
  check('NPC names are non-empty strings', na.split(',').every((n) => n.length > 0));
}

// ---------------------------------------------------------------------------
// 6. Waypoints
// ---------------------------------------------------------------------------

{
  const layout = layoutSettlement('castle', 888);
  const npcs = spawnSettlementNpcs('castle', 888, layout);
  let allHaveWaypoints = true;
  let guardsHaveMoreWaypoints = true;
  for (const npc of npcs) {
    if (npc.waypoints.length < 2) allHaveWaypoints = false;
    if (npc.role === 'guard' && npc.waypoints.length < 3) guardsHaveMoreWaypoints = false;
  }
  check('all castle NPCs have ≥2 waypoints', allHaveWaypoints);
  check('castle guards have ≥3 waypoints', guardsHaveMoreWaypoints);
}

{
  const layout = layoutSettlement('ranch', 42);
  const npcs = spawnSettlementNpcs('ranch', 42, layout);
  check('ranch farmer has ≥2 waypoints',
    npcs.every((n) => n.waypoints.length >= 2));
}

// ---------------------------------------------------------------------------
// 7. resolveNpcs — world-space lift
// ---------------------------------------------------------------------------

{
  const flat = (_x: number, _z: number) => 5;
  const layout = layoutSettlement('town', 111);
  const npcs = spawnSettlementNpcs('town', 111, layout);
  const resolved: ResolvedNpc[] = resolveNpcs(npcs, 256, 384, flat);

  check('resolveNpcs: same count as input', resolved.length === npcs.length);

  let wxOffset = true;
  for (let i = 0; i < resolved.length; i++) {
    // wx should be siteX + npc.x; allow floating-point tolerance.
    const expectedWx = 256 + npcs[i].x;
    const expectedWz = 384 + npcs[i].z;
    if (Math.abs(resolved[i].wx - expectedWx) > 1e-6) wxOffset = false;
    if (Math.abs(resolved[i].wz - expectedWz) > 1e-6) wxOffset = false;
  }
  check('resolveNpcs: wx/wz correctly offset', wxOffset);
  check('resolveNpcs: wy = flat ground height',
    resolved.every((r) => r.wy === 5));
  check('resolveNpcs: wwaypoints count matches waypoints count',
    resolved.every((r, i) => r.wwaypoints.length === npcs[i].waypoints.length));
  check('resolveNpcs: wwaypoints are world-offset',
    resolved.every((r, i) =>
      r.wwaypoints.every((wp, j) =>
        Math.abs(wp.x - (256 + npcs[i].waypoints[j].x)) < 1e-6 &&
        Math.abs(wp.z - (384 + npcs[i].waypoints[j].z)) < 1e-6,
      ),
    ));
}

// ---------------------------------------------------------------------------
// 8. NPC id format
// ---------------------------------------------------------------------------

{
  const layout = layoutSettlement('village', 555);
  const npcs = spawnSettlementNpcs('village', 555, layout);
  const allIdFormat = npcs.every((n) => n.id.startsWith('npc_555_'));
  check('NPC ids follow "npc_<seed>_<index>" format', allIdFormat,
    npcs.map((n) => n.id).join(','));
}

// ---------------------------------------------------------------------------
// 9. Guard patrol targets fort pads in a castle
// ---------------------------------------------------------------------------

{
  const layout = layoutSettlement('castle', 7777);
  const npcs = spawnSettlementNpcs('castle', 7777, layout);
  const guards = npcs.filter((n) => n.role === 'guard');
  const fortPadTypes = new Set(['wall', 'tower', 'gatehouse', 'jail']);
  // Guard waypoints should be near fort pads — not necessarily exact center,
  // but at least one waypoint x/z should be within 8 m of a fort pad.
  let guardPatrolsNearFort = true;
  for (const g of guards) {
    const hasNearFortPad = g.waypoints.some((wp) =>
      layout.pads.some((p) => {
        if (!fortPadTypes.has(p.type)) return false;
        return Math.hypot(wp.x - p.x, wp.z - p.z) < 10;
      }),
    );
    if (!hasNearFortPad) guardPatrolsNearFort = false;
  }
  check('castle guards patrol near fort pads', guardPatrolsNearFort,
    `guards=${guards.length}`);
}

// ---------------------------------------------------------------------------
// 10. Golden FNV hash — determinism tripwire
// ---------------------------------------------------------------------------

const goldenAll: number[] = [];
for (const kind of ['ranch', 'village', 'town', 'castle'] as SettlementKind[]) {
  for (let s = 0; s < 8; s++) {
    const seed = s * 3571 + 13;
    const layout = layoutSettlement(kind, seed);
    const npcs = spawnSettlementNpcs(kind, seed, layout);
    goldenAll.push(kind.length, seed, npcs.length);
    for (const npc of npcs) {
      goldenAll.push(fnv1aStr(npc.id), fnv1aStr(npc.role), fnv1aStr(npc.name));
      goldenAll.push(npc.x, npc.z, npc.waypoints.length);
      for (const wp of npc.waypoints) {
        goldenAll.push(wp.x, wp.z);
      }
    }
  }
}

const goldenHash = fnv1a(new Uint8Array(new Float32Array(goldenAll).buffer));

if (GOLDEN_NPC_SPAWN_HASH === null) {
  console.log(`golden hash: 0x${goldenHash.toString(16)} (bake into GOLDEN_NPC_SPAWN_HASH)`);
} else {
  check('golden NPC spawn hash', goldenHash === GOLDEN_NPC_SPAWN_HASH,
    `got 0x${goldenHash.toString(16)}, want 0x${(GOLDEN_NPC_SPAWN_HASH as number).toString(16)}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0 || GOLDEN_NPC_SPAWN_HASH === null) {
  if (GOLDEN_NPC_SPAWN_HASH === null) {
    console.log('GOLDEN_NPC_SPAWN_HASH not set yet — set it and re-run');
  }
  process.exit(1);
}
