/**
 * Tintreach — the pure half, asserted in Node.
 *
 *   npx tsx scripts/test-tintreach.mts
 *
 * Four things are provable without a GPU, and all four are things a screenshot
 * would happily lie about:
 *
 *   1. The bolt ENDS at the aim point and STARTS at the bow, whatever the
 *      jitter does in between. This is the claim the weapon lives or dies on:
 *      the reticle marks a point and the bolt must terminate there.
 *   2. It is deterministic. Same shot index, same seam, byte for byte — so the
 *      thing that "looks random" is reproducible and a capture is repeatable.
 *   3. The flash envelope is bounded and returns to exactly 1.0. An exposure
 *      dip that does not close leaves the whole game permanently dark, which is
 *      the sort of bug that reads as "the renderer broke".
 *   4. Nothing in the game can produce a second quiver. Enumerated against the
 *      real tables, not asserted in prose.
 */

import { readFileSync } from 'node:fs';
import {
  boltPath, boltBranches, makeBranchBuffer, boltIntensity, dipEnvelope,
  applyTintreachPost, fireTintreach, currentBolt, resetTintreach, strikePhase,
  boltLights, makeLightBuffer, tintreachShots, tintreachActive,
  BOLT_POINTS, BRANCH_POINTS, LIFE_S, STRIKE_S, DIP_RECOVER_S, DIP_DEPTH,
  TINTREACH_STACK, TINTREACH_DAMAGE_MUL, TINTREACH_DAMAGE_FLOOR,
} from '../src/game/tintreach';
import {
  addItem, countItem, createInventory, createStarterInventory,
  removeItem, PACK_SIZE, deserializeInventory,
} from '../src/game/inventory';
import { itemDef, TINTREACH_ID } from '../src/game/items';
import { RECIPES } from '../src/game/crafting';
import { DROP_TABLE } from '../src/game/entities/animal-drops';
import { TRADE_CATALOG } from '../src/game/npc/npc-trade';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const P = (x: number, y: number, z: number) => [x, y, z] as [number, number, number];

// ---------------------------------------------------------------------------
// 1. The seam starts at the bow and ends at the mark
// ---------------------------------------------------------------------------
{
  const path = new Float32Array(BOLT_POINTS * 3);
  // Sweep a range of geometries: point blank, mid, the 160 m sky shot, straight
  // up (the basis-degenerate case), and straight down.
  const cases: [ReturnType<typeof P>, ReturnType<typeof P>, string][] = [
    [P(0, 1.2, 0), P(0, 1.4, -5), '5 m level'],
    [P(0, 1.2, 0), P(12, 3, -16), '20 m across'],
    [P(0, 1.2, 0), P(0, 2, -50), '50 m level'],
    [P(0, 1.2, 0), P(0, 161.2, 0), '160 m straight up'],
    [P(0, 40, 0), P(0, 0, 0), '40 m straight down'],
    [P(-300, 11, 220), P(-260, 24, 180), 'off-origin diagonal'],
    [P(0, 1.2, 0), P(0, 1.2, 0), 'degenerate zero-length'],
  ];
  let worstStart = 0;
  let worstEnd = 0;
  let finite = true;
  let maxWander = 0;
  // The path buffer is Float32Array, so an endpoint written from a float64
  // world coordinate comes back rounded. `fround` is what "exactly" means here
  // — anything looser would hide a real off-by-a-metre.
  const f = Math.fround;
  for (const [from, to, label] of cases) {
    let caseWander = 0;
    for (let shot = 1; shot <= 40; shot++) {
      boltPath(path, BOLT_POINTS, shot, from, to, 0.055);
      for (let i = 0; i < BOLT_POINTS * 3; i++) {
        if (!Number.isFinite(path[i])) { finite = false; }
      }
      const s = Math.hypot(
        path[0] - f(from[0]), path[1] - f(from[1]), path[2] - f(from[2]));
      const L = (BOLT_POINTS - 1) * 3;
      const e = Math.hypot(
        path[L] - f(to[0]), path[L + 1] - f(to[1]), path[L + 2] - f(to[2]));
      worstStart = Math.max(worstStart, s);
      worstEnd = Math.max(worstEnd, e);
      // Lateral wander must stay bounded — an unclamped midpoint displacement
      // wanders further the longer the shot and stops reading as one bolt.
      //
      // PERPENDICULAR distance from the bow-to-mark LINE, not distance from a
      // uniformly-parameterised point on it: vertex spacing is deliberately
      // warped toward the bow (see `boltPath`), so comparing vertex i against
      // the point at i/(n-1) measures the warp, not the wander, and reported
      // 22 m of "drift" on a bolt that never leaves 3 m of the line.
      const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
      const ux = (to[0] - from[0]) / (len || 1);
      const uy = (to[1] - from[1]) / (len || 1);
      const uz = (to[2] - from[2]) / (len || 1);
      for (let i = 1; i < BOLT_POINTS - 1; i++) {
        const vx = path[i * 3] - from[0];
        const vy = path[i * 3 + 1] - from[1];
        const vz = path[i * 3 + 2] - from[2];
        const along = vx * ux + vy * uy + vz * uz;
        caseWander = Math.max(caseWander, Math.hypot(
          vx - ux * along, vy - uy * along, vz - uz * along));
      }
      if (len === 0 && caseWander > 1e-6) {
        check(`${label}: zero-length bolt stays a point`, false);
      }
    }
    maxWander = Math.max(maxWander, caseWander);
  }
  check('every bolt starts exactly at the bow', worstStart === 0,
    `worst ${worstStart}`);
  check('every bolt ends exactly at the mark', worstEnd === 0,
    `worst ${worstEnd}`);
  check('no NaN or Infinity anywhere in the path', finite);
  check('lateral wander stays bounded', maxWander <= 6.6,
    `worst ${maxWander.toFixed(2)} m`);
}

// ---------------------------------------------------------------------------
// 2. Determinism
// ---------------------------------------------------------------------------
{
  const a = new Float32Array(BOLT_POINTS * 3);
  const b = new Float32Array(BOLT_POINTS * 3);
  boltPath(a, BOLT_POINTS, 12345, P(1, 2, 3), P(40, 9, -12), 0.055);
  boltPath(b, BOLT_POINTS, 12345, P(1, 2, 3), P(40, 9, -12), 0.055);
  let same = true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) same = false;
  check('the same shot draws the same seam', same);

  boltPath(b, BOLT_POINTS, 12346, P(1, 2, 3), P(40, 9, -12), 0.055);
  let differs = false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differs = true;
  check('a different shot draws a different seam', differs);

  // No nondeterministic source anywhere in the CODE. Comments are stripped
  // first — both files talk about `Math.random` in prose to explain why they do
  // not use it, and a naive substring scan fails on its own documentation.
  const code = (p: string): string => readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const p of ['src/game/tintreach.ts', 'src/game/render/bolt-fx.ts']) {
    const src = code(p);
    check(`no Math.random in ${p}`, !src.includes('Math.random'));
    check(`no wall-clock in ${p}`, !/Date\.now|new Date\(\)|performance\.now/.test(src));
  }
}

// ---------------------------------------------------------------------------
// 3. Forks
// ---------------------------------------------------------------------------
{
  const path = new Float32Array(BOLT_POINTS * 3);
  boltPath(path, BOLT_POINTS, 7, P(0, 1.2, 0), P(0, 2, -50), 0.055);
  const br = makeBranchBuffer();
  const n = boltBranches(br, path, BOLT_POINTS, 7);
  check('four forks', n === 4);
  let rootsInside = true;
  let finite = true;
  let reachesMark = false;
  for (let i = 0; i < n; i++) {
    if (br[i].root < 2 || br[i].root > BOLT_POINTS - 3) rootsInside = false;
    for (const v of [br[i].toX, br[i].toY, br[i].toZ]) {
      if (!Number.isFinite(v)) finite = false;
    }
    // A fork that reaches the mark reads as a second shot.
    if (Math.hypot(br[i].toX - 0, br[i].toY - 2, br[i].toZ + 50) < 1.5) reachesMark = true;
  }
  check('forks root inside the channel, never at either end', rootsInside);
  check('fork endpoints are finite', finite);
  check('no fork reaches the mark', !reachesMark);
}

// ---------------------------------------------------------------------------
// 4. The flash envelope opens and, crucially, CLOSES
// ---------------------------------------------------------------------------
{
  resetTintreach();
  check('no bolt before the first shot', currentBolt() === null);
  check('exposure untouched with no bolt', (() => {
    const post = { exposure: 1.15, bloomIntensity: 0.055 };
    applyTintreachPost(post, 10);
    return post.exposure === 1.15 && post.bloomIntensity === 0.055;
  })());

  const spawn = fireTintreach({
    muzzle: P(0, 1.2, 0), aimPoint: P(0, 2, -50), onTarget: true,
    damage: 9, nowS: 100,
  });
  check('the spawn sits ON the aim point',
    spawn.x === 0 && spawn.y === 2 && spawn.z === -50);
  check('the spawn barely moves before the hit test',
    Math.hypot(spawn.vx, spawn.vy, spawn.vz) < 0.02);
  // Tintreach is the hardest-hitting attack in the game and deliberately NOT a
  // one-shot: the user reversed that once the arrows became rare loot rather
  // than a unique artifact. Asserted as a RELATION to the old ceiling and to
  // the toughest enemy, so retuning the bow cannot silently demote the arrow,
  // and a future damage bump cannot silently restore the one-shot.
  const OLD_CEILING = 9;          // composite bow, full draw
  const TOUGHEST_IN_GAME = 300;   // the Evil King; his dragon is 260
  check('a full-draw bolt beats every other weapon',
    spawn.damage > OLD_CEILING, `${spawn.damage} vs ${OLD_CEILING}`);
  check('a bolt does NOT one-shot the toughest thing in the game',
    spawn.damage < TOUGHEST_IN_GAME, `${spawn.damage} vs ${TOUGHEST_IN_GAME}`);
  check('a full-draw bolt is the multiplied damage',
    spawn.damage === Math.max(TINTREACH_DAMAGE_FLOOR, 9 * TINTREACH_DAMAGE_MUL),
    `${spawn.damage}`);
  check('the shot counter advanced', tintreachShots() === 1);

  let peakDip = 0;
  let minExposure = 99;
  let lastActive = -1;
  for (let i = 0; i <= 400; i++) {
    const t = 100 + i * 0.005;
    const env = boltIntensity(t);
    const dip = dipEnvelope(t);
    if (env < 0 || env > 1) check('intensity stays in 0..1', false, `${env} at ${t}`);
    if (dip < 0 || dip > 1) check('dip stays in 0..1', false, `${dip} at ${t}`);
    peakDip = Math.max(peakDip, dip);
    const post = { exposure: 1.15, bloomIntensity: 0.055 };
    applyTintreachPost(post, t);
    minExposure = Math.min(minExposure, post.exposure);
    if (post.bloomIntensity < 0.055 - 1e-9) {
      check('bloom is never reduced', false);
    }
    if (tintreachActive(t)) lastActive = t;
  }
  check('the flash reaches full depth', Math.abs(peakDip - 1) < 1e-9);
  check('exposure is pulled down hard at peak',
    Math.abs(minExposure - 1.15 * (1 - DIP_DEPTH)) < 1e-6,
    `min ${minExposure.toFixed(4)}`);
  check('the bolt is gone by LIFE_S', lastActive < 100 + LIFE_S + 1e-9,
    `last active ${(lastActive - 100).toFixed(3)} s`);

  const after = 100 + Math.max(LIFE_S, STRIKE_S + DIP_RECOVER_S) + 0.001;
  check('intensity is exactly zero afterwards', boltIntensity(after) === 0);
  check('the dip closes exactly', dipEnvelope(after) === 0);
  const post = { exposure: 1.15, bloomIntensity: 0.055 };
  applyTintreachPost(post, after);
  check('exposure returns to exactly what it was',
    post.exposure === 1.15 && post.bloomIntensity === 0.055);
  // The one bug that would darken the whole game forever.
  check('exposure is untouched an hour later', (() => {
    const p2 = { exposure: 1.15, bloomIntensity: 0.055 };
    applyTintreachPost(p2, 100 + 3600);
    return p2.exposure === 1.15;
  })());

  // The re-strike phase must advance and then FREEZE, so the ghost is still.
  const phases = [0, 0.02, 0.11, 0.22, 0.33, 0.6, 1.0].map((d) => strikePhase(100 + d));
  check('the seam re-strikes while it burns', phases[3] > phases[0]);
  check('the seam freezes once it stops burning',
    phases[4] === phases[5] && phases[5] === phases[6],
    phases.join(','));

  // Lights: two, cold, and only while it burns.
  const lb = makeLightBuffer();
  check('two lights at the strike', boltLights(lb, 100.01) === 2);
  check('lights outrank every campfire', lb[0].d2 < 0 && lb[1].d2 < 0);
  check('the light is cold, not fire-coloured', lb[0].color[2] > lb[0].color[0]);
  check('no lights once it is over', boltLights(lb, after) === 0);
}

// ---------------------------------------------------------------------------
// 5. Rare, finite, and still unbuyable. Every faucet, enumerated.
// ---------------------------------------------------------------------------
//
// This section used to prove "only one Tintreach quiver can ever exist in a
// save". That rule is gone: the user asked for the arrows to be rare, finite
// loot found mostly on dungeon bosses rather than a unique artifact with an
// infinite quiver, so they now deplete, accumulate and stack like any other
// item. See the header of tintreach.ts.
//
// The enumeration is kept because the half that still holds is the half worth
// guarding: rare means rare, and the faucets that were closed stay closed.
// What changed is the assertions about how many can exist at once.
{
  check('no crafting recipe outputs the arrows',
    RECIPES.every((r) => r.output !== TINTREACH_ID));

  let inDrops = false;
  for (const table of Object.values(DROP_TABLE)) {
    for (const d of table) if (d.id === TINTREACH_ID) inDrops = true;
  }
  check('no ordinary animal drops them', !inDrops);

  let inStock = false;
  for (const list of Object.values(TRADE_CATALOG)) {
    for (const e of list) if (e.id === TINTREACH_ID) inStock = true;
  }
  check('no merchant stocks them', !inStock);

  // The starter kit is a HANDFUL now, not a quiver. Twelve is enough to learn
  // what the weapon does; 99 made every other weapon pointless.
  const starter = createStarterInventory();
  const starting = countItem(starter, TINTREACH_ID);
  check('the starter kit grants a handful, not a full stack',
    starting > 0 && starting <= 20, `${starting}`);
  check('and it is well under the stack cap', starting < TINTREACH_STACK,
    `${starting} of ${TINTREACH_STACK}`);

  // They ACCUMULATE. The old `addItem` chokepoint collapsed every grant into a
  // single slot and threw the remainder away; boss loot has to be able to pile
  // up across stacks like anything else.
  const inv = createInventory();
  addItem(inv, TINTREACH_ID, TINTREACH_STACK);
  const left = addItem(inv, TINTREACH_ID, 40);
  check('a second grant is kept, not discarded', left === 0, `${left} left over`);
  check('and it opens a second stack once the first is full',
    [...inv.pack, ...inv.hotbar].filter((s) => s?.id === TINTREACH_ID).length === 2);
  check('the total is what was granted',
    countItem(inv, TINTREACH_ID) === TINTREACH_STACK + 40,
    `${countItem(inv, TINTREACH_ID)}`);

  // Repeated boss drops keep adding up rather than being silently eaten.
  const hoard = createInventory();
  let granted = 0;
  for (let i = 0; i < 40; i++) {
    const n = 5 + (i % 5);            // the boss drop range, 5..9
    granted += n - addItem(hoard, TINTREACH_ID, n);
  }
  check('forty boss drops all land',
    countItem(hoard, TINTREACH_ID) === granted && granted > 200,
    `${countItem(hoard, TINTREACH_ID)} of ${granted} granted`);

  // They DEPLETE. Nothing puts the loosed arrow back any more.
  const spend = createInventory();
  addItem(spend, TINTREACH_ID, 10);
  for (let i = 0; i < 10; i++) removeItem(spend, TINTREACH_ID, 1);
  check('ten shots empty a stack of ten',
    countItem(spend, TINTREACH_ID) === 0, `${countItem(spend, TINTREACH_ID)}`);
  check('and the empty slot is released',
    [...spend.pack, ...spend.hotbar].every((s) => s?.id !== TINTREACH_ID));

  // A save holding several stacks is now legal and must survive a round trip
  // intact — the load path used to collapse it back to one.
  const many = createInventory();
  many.pack[0] = { id: TINTREACH_ID, count: 99 };
  many.pack[5] = { id: TINTREACH_ID, count: 40 };
  many.hotbar[2] = { id: TINTREACH_ID, count: 12 };
  const round = deserializeInventory(JSON.stringify(many));
  check('several stacks survive a save/load round trip',
    round !== null && countItem(round, TINTREACH_ID) === 151
    && [...round.pack, ...round.hotbar].filter((s) => s?.id === TINTREACH_ID).length === 3,
    round === null ? 'load failed' : `${countItem(round, TINTREACH_ID)} arrows`);

  // A full pack must still refuse rather than corrupt.
  const packed = createInventory();
  for (let i = 0; i < PACK_SIZE; i++) packed.pack[i] = { id: 'stone', count: 99 };
  check('a full pack refuses rather than corrupts', addItem(packed, TINTREACH_ID, 5) === 5);

  check('the item is named for what it is',
    itemDef(TINTREACH_ID).name === 'Tintreach Arrows',
    itemDef(TINTREACH_ID).name);
}

// ---------------------------------------------------------------------------
// Snap shot: the weakest bolt must still be the best hit available
// ---------------------------------------------------------------------------
//
// Deliberately last, and after a reset: `fireTintreach` advances the shot
// counter and leaves a bolt burning, so firing one mid-file breaks every
// lifecycle assertion after it. It did exactly that once.
{
  resetTintreach();
  const OLD_CEILING = 9;
  const snap = fireTintreach({
    muzzle: P(0, 1.2, 0), aimPoint: P(0, 2, -50), onTarget: true,
    damage: Math.round(6 * 0.45),   // hunter bow, minimum draw
    nowS: 500,
  });
  check('even a snap shot beats the old ceiling',
    snap.damage > OLD_CEILING, `${snap.damage} vs ${OLD_CEILING}`);
  resetTintreach();
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
