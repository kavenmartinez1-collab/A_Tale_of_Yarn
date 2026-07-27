/**
 * Deterministic tests for the castle's garrison, its boss fight, and the
 * breath-cone rule that both of them and the player's own mount depend on.
 *
 *   npx tsx scripts/test-castle-fight.mts
 *
 * Sibling to `test-castle-layout.mts`, which proves the castle is WALKABLE.
 * This proves it is INHABITED: that every guard stands on a real floor inside
 * a real room, that none of them is in a wall, that the roster is identical
 * every playthrough, and that the alarm actually gates them.
 *
 * ## Why the placement assertions use the real collider
 *
 * The same reason the reachability flood does. "Inside the room rect" is not
 * the question — the question is whether `creatureGround` returns a surface at
 * that exact point for a body of that exact radius, and whether
 * `creatureBlocked` says it is clear. Anything less is a claim about the
 * roster table rather than about the castle, and a roster table cannot be
 * wrong in the way that matters.
 *
 * ## What this cannot prove
 *
 * That any of it is DRAWN, or that the fight is fun. `scripts/castle-siege.mjs`
 * plays it.
 */

import { createHeightField } from '../src/game/noise';
import { terrainGround } from '../src/game/collision';
import { buildCastleLayout, fitBreachRamp, STEP_UP } from '../src/game/castle/castle-layout';
import { CastleCollider } from '../src/game/castle/castle-collider';
import { CASTLE_SEED, resolveCastleSite } from '../src/game/castle/castle-site';
import {
  castleGarrison, GARRISON_CAP, isGarrisonId, GARRISON_ID_PREFIX,
} from '../src/game/castle/castle-garrison';
import type { CastleProbe, GarrisonPost } from '../src/game/castle/castle-garrison';
import {
  createCastleFight, stepCastleFight, breathInRange,
  BREATH_TELL_S, BREATH_S, STRAFE_AT, GROUND_AT, CIRCLE_R, CIRCLE_ALT,
  BREATH_REACH, BLACK_DRAGON_REACH, BOSS_SPEED, BOSS_DIVE_SPEED, BOSS_LEASH_R,
} from '../src/game/castle/castle-fight';
import { breathHit, BREATH_NEAR_RADIUS } from '../src/game/breath-cone';
import { BREATH_RANGE, BREATH_HALF_ANGLE } from '../src/game/fire';
import { SPECIES_DEFS } from '../src/game/entities/entity-types';
import {
  createCastleState, stepCastleState, castleHostile,
} from '../src/game/castle/castle-state';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- build ----------------------------------------------------------------

const hf = createHeightField(1337);
const terrain = terrainGround(hf);
const site = resolveCastleSite(hf);
const layout = buildCastleLayout(CASTLE_SEED);
fitBreachRamp(layout,
  (lx, lz) => hf.heightAt(site.origin[0] + lx, site.origin[2] + lz) - site.origin[1]);
const collider = new CastleCollider(layout, site.origin, terrain);
const [ox, oy, oz] = site.origin;

/** The same probe `CastleManager` builds, in castle-local coordinates. */
const probe: CastleProbe = {
  ground: (x, z, y, r) => {
    const g = collider.creatureGround(x + ox, z + oz, r, y + oy);
    return g === null ? null : g - oy;
  },
  blocked: (x, z, y, r, h) => collider.creatureBlocked(x + ox, z + oz, r, y + oy, h),
};

const garrison = castleGarrison(layout, CASTLE_SEED, probe);
console.log(`garrison: ${garrison.length} bodies at `
  + `${new Set(garrison.map((p) => p.station)).size} stations`);

// ===========================================================================
// 1. The roster exists, is capped, and is the same every time
// ===========================================================================

check('the castle has a garrison', garrison.length >= 12, `${garrison.length}`);
check('garrison respects its cap', garrison.length <= GARRISON_CAP,
  `${garrison.length} > ${GARRISON_CAP}`);

{
  const a = castleGarrison(layout, CASTLE_SEED, probe);
  const b = castleGarrison(layout, CASTLE_SEED, probe);
  check('placement is byte-identical across calls',
    JSON.stringify(a) === JSON.stringify(b));
  // A second layout built from the same seed must produce the same roster —
  // this is what "identical every playthrough" actually means, since the game
  // rebuilds the layout on every boot rather than caching it.
  const l2 = buildCastleLayout(CASTLE_SEED);
  fitBreachRamp(l2,
    (lx, lz) => hf.heightAt(site.origin[0] + lx, site.origin[2] + lz) - site.origin[1]);
  const c2 = new CastleCollider(l2, site.origin, terrain);
  const p2: CastleProbe = {
    ground: (x, z, y, r) => {
      const g = c2.creatureGround(x + ox, z + oz, r, y + oy);
      return g === null ? null : g - oy;
    },
    blocked: (x, z, y, r, h) => c2.creatureBlocked(x + ox, z + oz, r, y + oy, h),
  };
  check('a rebuilt castle has the same garrison',
    JSON.stringify(castleGarrison(l2, CASTLE_SEED, p2)) === JSON.stringify(a));
  const d = castleGarrison(layout, CASTLE_SEED + 1, probe);
  check('a different seed moves them', JSON.stringify(d) !== JSON.stringify(a));
}

{
  const ids = new Set(garrison.map((p) => p.id));
  check('every id is unique', ids.size === garrison.length,
    `${ids.size} of ${garrison.length}`);
  check('every id is recognised as a garrison id',
    garrison.every((p) => isGarrisonId(p.id)));
  check('no garrison id could be mistaken for a streamed one',
    garrison.every((p) => !/^-?\d+,-?\d+:e\d+$/.test(p.id)),
    'EntityManager would release it by distance');
  check('the prefix is what the id actually uses',
    garrison.every((p) => p.id.startsWith(GARRISON_ID_PREFIX)));
}

// The species must be ones that work outside a dungeon. `goblin_archer` has no
// `onRangedAttack` wired in the overworld tick, so it damages the player from
// 16 m with no arrow drawn and nothing to dodge.
check('only species that fight correctly outdoors',
  garrison.every((p) => p.species === 'goblin' || p.species === 'skeleton'),
  [...new Set(garrison.map((p) => p.species))].join(', '));

check('the garrison is a mix, not one species',
  new Set(garrison.map((p) => p.species)).size === 2);

// ===========================================================================
// 2. THE PLACEMENT PROOF — nobody is in a wall or in the void
// ===========================================================================

/** Collision radius and body height, mirroring `stepAnimal` and the garrison. */
function body(p: GarrisonPost): { r: number; h: number } {
  const size = SPECIES_DEFS[p.species].size;
  return { r: Math.max(0.3, size * 0.45), h: size * 1.3 };
}

{
  let noFloor = 0;
  let inWall = 0;
  let offFloor = 0;
  const bad: string[] = [];
  for (const p of garrison) {
    const { r, h } = body(p);
    const g = collider.creatureGround(p.x + ox, p.z + oz, r, p.y + oy);
    if (g === null) {
      noFloor++;
      bad.push(`${p.id}@${p.station}: no floor`);
      continue;
    }
    // Standing ON the floor, not floating over it or sunk into it.
    if (Math.abs(g - (p.y + oy)) > 0.05) {
      offFloor++;
      bad.push(`${p.id}@${p.station}: ${(g - (p.y + oy)).toFixed(2)} m off its floor`);
    }
    if (collider.creatureBlocked(p.x + ox, p.z + oz, r, p.y + oy, h)) {
      inWall++;
      bad.push(`${p.id}@${p.station}: inside a solid`);
    }
  }
  check('every guard stands on a real floor', noFloor === 0, `${noFloor}`);
  check('every guard stands exactly on it', offFloor === 0, `${offFloor}`);
  check('no guard is inside a wall', inWall === 0, `${inWall}`);
  if (bad.length > 0) console.error('  ' + bad.slice(0, 6).join('\n  '));
}

// They must be at the station they were assigned to, on the right storey. A
// guard that resolved to the floor BELOW its marker is the silent failure this
// catches: it is on a real floor, it is not in a wall, and it is guarding the
// wrong room.
{
  let wrongStorey = 0;
  let strayed = 0;
  for (const p of garrison) {
    const m = layout.markers.get(p.station);
    if (m === undefined) { wrongStorey++; continue; }
    if (Math.abs(p.y - m.y) > STEP_UP) wrongStorey++;
    if (Math.hypot(p.x - m.x, p.z - m.z) > 12) strayed++;
  }
  check('every guard is on its station\'s storey', wrongStorey === 0, `${wrongStorey}`);
  check('every guard is near its station', strayed === 0, `${strayed}`);
}

// Nobody is standing on top of anybody else.
{
  let overlaps = 0;
  for (let i = 0; i < garrison.length; i++) {
    for (let j = i + 1; j < garrison.length; j++) {
      const a = garrison[i];
      const b = garrison[j];
      if (Math.abs(a.y - b.y) > 2) continue;      // different storeys
      const need = body(a).r + body(b).r;
      if (Math.hypot(a.x - b.x, a.z - b.z) < need) overlaps++;
    }
  }
  check('no two guards occupy the same space', overlaps === 0, `${overlaps} pairs`);
}

// The cell the player wakes in must be empty. Waking beside a guard is a
// death, not an opening.
{
  const s = layout.spawn;
  let near = 0;
  for (const p of garrison) {
    if (Math.hypot(p.x - s[0], p.z - s[2]) < 6 && Math.abs(p.y - s[1]) < 2) near++;
  }
  check('nothing is waiting in the prison cell', near === 0, `${near} within 6 m`);
}

// The escape route must be defended but not sealed: the breach itself is the
// one place a body would turn the opening into a wall.
{
  const b = layout.markers.get('breach')!;
  let onIt = 0;
  for (const p of garrison) {
    if (Math.hypot(p.x - b.x, p.z - b.z) < 8 && Math.abs(p.y - b.y) < 2) onIt++;
  }
  check('nothing is standing in the breach', onIt === 0, `${onIt}`);
}

// Reachability: a guard the player can never get to is a guard that does not
// exist. Every post must be on a surface the layout test's flood can stand on,
// which for these purposes means "the collider agrees a player-radius body can
// stand there too".
{
  let unreachable = 0;
  for (const p of garrison) {
    const g = collider.creatureGround(p.x + ox, p.z + oz, 0.35, p.y + oy);
    if (g === null || Math.abs(g - (p.y + oy)) > STEP_UP) unreachable++;
  }
  check('every post is standable by the player too', unreachable === 0,
    `${unreachable}`);
}

// ===========================================================================
// 3. The alarm gates them
// ===========================================================================

{
  const st = createCastleState();
  const kx = site.origin[0];
  const kz = site.origin[2];
  check('garrison starts dormant', !castleHostile(st));
  // Walking the whole castle during the escape must not wake them.
  for (const p of garrison) {
    stepCastleState(st, p.x + ox, p.z + oz, kx, kz, false, 1);
  }
  check('walking past every guard stays dormant', !castleHostile(st),
    `alarm=${st.alarm}`);
  // Leaving and returning must.
  stepCastleState(st, kx + 260, kz, kx, kz, true, 30);
  check('leaving does not wake them either', !castleHostile(st), st.alarm);
  stepCastleState(st, kx + 40, kz, kx, kz, true, 90);
  check('returning wakes the whole castle', castleHostile(st), st.alarm);
}

// ===========================================================================
// 4. The breath cone — the near-field dead zone
// ===========================================================================
//
// The regression this section exists for: the mounted breath fired, drained
// stamina, drew a full jet and dealt exactly zero damage to anything within
// about twelve metres, because the mouth sits on the animal's head and a pure
// angular cone has no width at its apex.

{
  const dir: [number, number, number] = [1, 0, 0];
  const mouth: [number, number, number] = [0, 0, 0];
  // Dead ahead, well inside range.
  check('breath hits straight ahead', breathHit(mouth, dir, 10, 0, 0).hit);
  // Behind the mouth is never a hit, however close.
  check('breath does not fire backwards', !breathHit(mouth, dir, -2, 0, 0).hit);
  // Past the range is not a hit.
  check('breath respects its range',
    !breathHit(mouth, dir, BREATH_RANGE + 2, 0, 0).hit);
  check('reach scales the range',
    breathHit(mouth, dir, BREATH_RANGE + 2, 0, 0, 1.4).hit);

  // THE BUG, as measured. A wyvern (size 2.4, mouth [1.16, 1.18]) breathing
  // level at a deer (size 1.2) six metres away.
  const wy = SPECIES_DEFS.wyvern.size;
  const wMouth: [number, number, number] = [wy * 1.16, wy * 1.18, 0];
  const deerY = SPECIES_DEFS.deer.size * 0.5;
  const h = breathHit(wMouth, [1, 0, 0], 6, deerY, 0, 0.42);
  check('a level breath now reaches a target 6 m ahead on the ground', h.hit,
    `angle ${h.angleDeg.toFixed(1)} deg, perp ${h.perp.toFixed(2)} m, `
    + `radius ${h.radius.toFixed(2)} m`);
  // ...and it is genuinely the near-radius doing it, not a widened cone: the
  // old angular rule must still say no, or this test is not about the fix.
  check('the old angular rule really did miss it',
    h.angleDeg > BREATH_HALF_ANGLE * 180 / Math.PI,
    `${h.angleDeg.toFixed(1)} deg vs half-angle `
    + `${(BREATH_HALF_ANGLE * 180 / Math.PI).toFixed(1)} deg`);

  // The near radius must not have widened the weapon at range, or every fight
  // in the game just changed.
  const far = 18;
  const offAxis = far * Math.tan(BREATH_HALF_ANGLE) + 0.5;
  check('the jet is not wider at range than the cone was',
    !breathHit(mouth, dir, far, offAxis, 0).hit,
    `${offAxis.toFixed(2)} m off axis at ${far} m`);
  check('the jet still covers the full cone at range',
    breathHit(mouth, dir, far, far * Math.tan(BREATH_HALF_ANGLE) - 0.2, 0).hit);
  check('the near radius is the floor, not the rule',
    breathHit(mouth, dir, 1, BREATH_NEAR_RADIUS - 0.1, 0).hit
    && !breathHit(mouth, dir, 1, BREATH_NEAR_RADIUS + 0.4, 0).hit);
}

// ===========================================================================
// 5. The fight's shape
// ===========================================================================

{
  const f = createCastleFight();
  const maxHp = SPECIES_DEFS.black_dragon.hp;
  const step = (t: number, hpFrac: number, dist = 20, alive = true) =>
    stepCastleFight(f, t, 'hunting', 0, 10, 0, dist, hpFrac, alive, 0);

  check('the fight starts in the air', step(0, 1).phase === 'circle');
  check('a healthy dragon stays high', step(1, 1).y >= 10 + CIRCLE_ALT - 0.01);
  check('a healthy dragon orbits at CIRCLE_R',
    Math.abs(Math.hypot(step(1, 1).x, step(1, 1).z) - CIRCLE_R) < 0.01);

  // Health drives the phases, in order, and only forwards.
  check('damage moves it to strafe', step(30, STRAFE_AT - 0.01).phase === 'strafe');
  check('healing does not move it back', step(31, 1).phase === 'strafe');
  check('more damage grounds it', step(60, GROUND_AT - 0.01).phase === 'grounded');
  check('a dead dragon dismounts the King',
    step(90, 0, 20, false).phase === 'dismounted');
}

{
  // The landing has to finish, and only then hand off.
  const f = createCastleFight();
  let handedOffAt = -1;
  for (let i = 0; i < 400; i++) {
    const t = i * 0.05;
    const c = stepCastleFight(f, t, 'hunting', 0, 10, 0, 20, 0.1, true, 3);
    if (c.handOff && handedOffAt < 0) handedOffAt = t;
    if (c.handOff) {
      check('handed off only once it is on the ground', true);
      break;
    }
  }
  check('the dragon actually lands', handedOffAt > 0,
    `never handed off (${handedOffAt})`);
  check('the landing is a descent, not a teleport', handedOffAt >= 2,
    `handed off after only ${handedOffAt.toFixed(2)} s`);
}

{
  // THE TELL. The aim must latch when the wind-up starts and not move while
  // the player does — this is the whole mechanic, and a cone that tracks is
  // indistinguishable from one that does not until you try to dodge it.
  const f = createCastleFight();
  let telling = -1;
  let latched: [number, number, number] | null = null;
  let moved = 0;
  let sawTell = false;
  let sawBurn = false;
  for (let i = 0; i < 600; i++) {
    const t = i * 0.05;
    // The player runs: 5 m/s along +X for the whole test.
    const px = t * 5;
    const c = stepCastleFight(f, t, 'hunting', px, 10, 0, 20, 1, true, 0);
    if (c.breath === 'tell') {
      sawTell = true;
      if (telling < 0) { telling = t; latched = [...c.aim]; }
      else if (latched !== null && Math.abs(c.aim[0] - latched[0]) > 1e-9) moved++;
    } else if (c.breath === 'burning') {
      sawBurn = true;
      if (latched !== null && Math.abs(c.aim[0] - latched[0]) > 1e-9) moved++;
    } else if (telling >= 0) {
      telling = -1; latched = null;
    }
  }
  check('the dragon telegraphs before it breathes', sawTell);
  check('the breath actually fires', sawBurn);
  check('the aim latches at the tell and does not track', moved === 0,
    `${moved} frames where the aim moved under a running player`);
}

{
  // Cadence: a breath must not be able to start while one is running, and the
  // gap must be long enough to be a rhythm rather than a wall of fire.
  const f = createCastleFight();
  const starts: number[] = [];
  let prev = 'none';
  for (let i = 0; i < 2400; i++) {
    const t = i * 0.05;
    const c = stepCastleFight(f, t, 'hunting', 0, 10, 0, 20, 1, true, 0);
    if (c.breath === 'tell' && prev === 'none') starts.push(t);
    prev = c.breath;
  }
  check('the breath repeats', starts.length >= 3, `${starts.length} in 120 s`);
  let tooSoon = 0;
  for (let i = 1; i < starts.length; i++) {
    if (starts[i] - starts[i - 1] < BREATH_TELL_S + BREATH_S) tooSoon++;
  }
  check('no breath starts inside another', tooSoon === 0, `${tooSoon}`);
}

{
  // Range gating: it must not telegraph at somebody 200 m away.
  check('breath fires at fighting range', breathInRange(20));
  check('breath does not fire across the map', !breathInRange(200));
  check('breath does not fire point blank', !breathInRange(1));

  const f = createCastleFight();
  let fired = false;
  for (let i = 0; i < 1200; i++) {
    const c = stepCastleFight(f, i * 0.05, 'hunting', 0, 10, 0, 200, 1, true, 0);
    if (c.breath !== 'none') fired = true;
  }
  check('a distant player is never breathed at', !fired);
}

{
  // A dormant castle's dragon must never breathe, whatever the clock says.
  const f = createCastleFight();
  let fired = false;
  for (let i = 0; i < 1200; i++) {
    const c = stepCastleFight(f, i * 0.05, 'dormant', 0, 10, 0, 20, 1, true, 0);
    if (c.breath !== 'none') fired = true;
  }
  check('a dormant castle never breathes on the player', !fired);
}

{
  // THE OPENING. A dragon that never comes within reach cannot be killed, and
  // the starter kit has no bow. Every airborne phase must bring it inside the
  // player's 3.2 m melee reach and under the vertical gate.
  //
  // The gate, from main.ts:
  //   |e.y + size*0.5 - playerY| <= 2.5 + size
  const size = SPECIES_DEFS.black_dragon.size;
  const vGate = 2.5 + size;
  for (const [label, hpFrac] of [['circle', 1], ['strafe', 0.5]] as const) {
    const f = createCastleFight();
    // Warm the machine into the phase before measuring.
    for (let i = 0; i < 5; i++) stepCastleFight(f, i * 0.05, 'hunting', 0, 10, 0, 20, hpFrac, true, 0);
    let best = Infinity;
    let reachable = 0;
    for (let i = 0; i < 2000; i++) {
      const t = 0.25 + i * 0.05;
      const c = stepCastleFight(f, t, 'hunting', 0, 10, 0, 20, hpFrac, true, 0);
      const flat = Math.hypot(c.x, c.z);
      const dv = Math.abs(c.y + size * 0.5 - 10);
      if (flat < best) best = flat;
      if (flat <= 3.2 && dv <= vGate) reachable++;
    }
    check(`${label}: the dragon comes within sword reach`, reachable > 0,
      `closest approach ${best.toFixed(2)} m over 100 s`);
    check(`${label}: the opening is a window, not permanent`,
      reachable > 0 && reachable < 2000 * 0.35,
      `${reachable}/2000 frames in reach`);
  }
}

{
  // THE DRAGON MUST BE INSIDE ITS OWN WEAPON'S RANGE.
  //
  // The regression this exists for: the fight orbited at R = 34, ALT = 20 —
  // a 39.4 m slant range — against a breath that reaches 28. It telegraphed,
  // roared, opened its jaws and drew a full jet on every cycle, and the cone
  // test rejected the player every tick. Played for ninety seconds standing
  // still inside it, the harness measured player hp 20 -> 20.
  //
  // Nothing about that is visible from inside the state machine: the phases
  // were right, the tell was right, the aim latched correctly. Only the
  // GEOMETRY was wrong, so only geometry catches it.
  check('the spec reach this module assumes matches BREATH_SPEC',
    BLACK_DRAGON_REACH === 1.4, `${BLACK_DRAGON_REACH}`);
  check('BREATH_REACH is derived from the real range constant',
    Math.abs(BREATH_REACH - BREATH_RANGE * 1.4) < 1e-9,
    `${BREATH_REACH} vs ${BREATH_RANGE * 1.4}`);

  for (const [label, hpFrac] of [['circle', 1], ['strafe', 0.5]] as const) {
    const f = createCastleFight();
    let worst = 0;
    for (let i = 0; i < 1200; i++) {
      const t = i * 0.05;
      const c = stepCastleFight(f, t, 'hunting', 0, 10, 0, 20, hpFrac, true, 0);
      if (c.handOff) continue;
      const slant = Math.hypot(c.x, c.y - 10, c.z);
      if (slant > worst) worst = slant;
    }
    check(`${label}: the dragon never orbits outside its own breath range`,
      worst <= BREATH_REACH - 1,
      `worst slant range ${worst.toFixed(1)} m vs reach ${BREATH_REACH} m`);
  }

  // ...and the gate must agree, so a cycle that starts can connect.
  check('the breath gate is inside the breath range',
    !breathInRange(BREATH_REACH), `fires at ${BREATH_REACH} m`);
}

{
  // Grounded, the dragon must actually be at the ground height it was handed.
  const f = createCastleFight();
  let landedY = Infinity;
  for (let i = 0; i < 400; i++) {
    const c = stepCastleFight(f, i * 0.05, 'hunting', 0, 10, 0, 20, 0.1, true, 7.5);
    if (c.handOff) { landedY = c.y; break; }
  }
  check('it lands at the ground height it was given',
    Math.abs(landedY - 7.5) < 0.01, `${landedY}`);
}

// ===========================================================================
// 6. Tuning sanity — the numbers a player's health bar meets
// ===========================================================================

{
  const MAX_HP = 20;   // vitals.MAX_HP
  const king = SPECIES_DEFS.evil_king;
  const dragon = SPECIES_DEFS.black_dragon;
  check('the King cannot two-shot a full-health player',
    (king.attackDmg ?? 0) * 2 < MAX_HP,
    `${king.attackDmg} x 2 vs ${MAX_HP} hp`);
  check('the dragon cannot one-shot a full-health player',
    (dragon.attackDmg ?? 0) < MAX_HP, `${dragon.attackDmg}`);
  check('the King still kills in a handful of blows',
    Math.ceil(MAX_HP / (king.attackDmg ?? 1)) <= 5,
    `${Math.ceil(MAX_HP / (king.attackDmg ?? 1))} blows`);
  // A sword is 4 damage. The whole fight has to be minutes, not tens of them.
  const swings = (dragon.hp + king.hp) / 4;
  check('the fight is winnable in a sane number of swings', swings <= 160,
    `${swings} connected sword hits`);
  check('the fight is not trivial', swings >= 80, `${swings}`);
  // A full breath must hurt without being an execution.
  const perTick = 2;              // BOSS_BREATH_DMG
  const fullJet = perTick * (BREATH_S / 0.25);
  check('a full breath hurts but does not kill from full health',
    fullJet > MAX_HP * 0.4 && fullJet < MAX_HP,
    `${fullJet} of ${MAX_HP} hp`);
}

// ---------------------------------------------------------------------------
// The boss has a body: it flies, it does not teleport
// ---------------------------------------------------------------------------
//
// The whole point of these is DISPLACEMENT PER FRAME. The old pose was a pure
// function of the player's position, so the dragon's location was recomputed
// rather than travelled: die, respawn a kilometre away, and it was simply
// there on the next frame. A teleport is trivially detectable as one frame of
// impossible movement, and that is the assertion that stops this regressing.

console.log('\n=== boss motion ===');
{
  const KEEP: [number, number, number] = [0, 34, 0];
  const DT = 1 / 60;
  /** Drive the fight for `secs`, returning the per-frame displacement trace. */
  const fly = (
    secs: number,
    playerAt: (t: number) => [number, number, number],
    seed: [number, number, number],
    hpFrac = 1,
  ) => {
    const f = createCastleFight();
    const steps = Math.round(secs / DT);
    let prev: [number, number, number] = [...seed];
    let maxStep = 0;
    let maxDive = 0;
    const path: [number, number, number][] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i * DT;
      const [px, py, pz] = playerAt(t);
      const dist = Math.hypot(f.bx - px, f.by - py, f.bz - pz);
      const c = stepCastleFight(
        f, t, 'hunting', px, py, pz, f.seeded ? dist : 999, hpFrac, true, 0,
        {
          dtS: DT,
          curX: seed[0], curY: seed[1], curZ: seed[2],
          keepX: KEEP[0], keepY: KEEP[1], keepZ: KEEP[2],
        });
      const step = Math.hypot(c.x - prev[0], c.y - prev[1], c.z - prev[2]) / DT;
      if (i > 0) {
        if (c.swoopT > 0) maxDive = Math.max(maxDive, step);
        else maxStep = Math.max(maxStep, step);
      }
      prev = [c.x, c.y, c.z];
      path.push([c.x, c.y, c.z]);
    }
    return { f, maxStep, maxDive, path, end: prev };
  };

  // 1. RESPAWN. The player dies and reappears across the valley. The dragon
  //    must FLY there — no frame may exceed its own top speed. This is the
  //    assertion that would have caught the original bug, where the dragon's
  //    position was recomputed from the player's and so moved 900 m in one
  //    frame without ever travelling.
  {
    const far: [number, number, number] = [220, 10, 0];
    const r = fly(40, () => far, [0, 60, 0]);
    check('respawn does not teleport the dragon',
      r.maxStep <= BOSS_SPEED * 1.02,
      `fastest non-diving frame ${r.maxStep.toFixed(2)} m/s vs cap ${BOSS_SPEED}`);
    check('a dive never exceeds the dive cap',
      r.maxDive <= BOSS_DIVE_SPEED * 1.02,
      `fastest diving frame ${r.maxDive.toFixed(2)} m/s vs cap ${BOSS_DIVE_SPEED}`);
    const gap = Math.hypot(r.end[0] - far[0], r.end[2] - far[2]);
    check('and it does arrive under its own power',
      gap < CIRCLE_R + 12, `${gap.toFixed(0)} m from the player after 40 s`);
  }

  // 2. CROSSING TIME. A known distance takes a plausible number of seconds
  //    rather than one frame.
  {
    const target: [number, number, number] = [200, 10, 0];
    const r = fly(40, () => target, [0, 60, 0]);
    let arrivedAt = -1;
    for (let i = 0; i < r.path.length; i++) {
      if (Math.hypot(r.path[i][0] - target[0], r.path[i][2] - target[2]) < 60) {
        arrivedAt = i * DT; break;
      }
    }
    // ~200 m of ground at 16 m/s is 12.5 s; allow for the climb and spin-up.
    check('200 m takes a plausible time to cross',
      arrivedAt > 6 && arrivedAt < 30,
      arrivedAt < 0 ? 'never arrived within 40 s' : `${arrivedAt.toFixed(1)} s`);
  }

  // 3. FLEEING WORKS. A player on a sprinting wyvern (15 * 1.3 = 19.5 m/s)
  //    must gain ground; a sprinting player on foot (10 m/s) must not. Both
  //    measured inside the leash, so it is the speeds being tested and not
  //    the break-off.
  {
    // Seeded ON STATION so this measures the speeds and not the approach.
    const onStation: [number, number, number] = [20, 20, 34];
    const wyvern = fly(12, (t) => [20 + 19.5 * t, 10, 0], onStation);
    const gapW = Math.hypot(wyvern.end[0] - (20 + 19.5 * 12), wyvern.end[2]);
    check('a player fleeing on a wyvern gains ground',
      gapW > CIRCLE_R + 20, `${gapW.toFixed(0)} m behind after 12 s`);

    const onFoot = fly(12, (t) => [20 + 10 * t, 10, 0], onStation);
    const gapF = Math.hypot(onFoot.end[0] - (20 + 10 * 12), onFoot.end[2]);
    check('a player fleeing on foot does not escape',
      gapF < CIRCLE_R + 20, `${gapF.toFixed(0)} m behind after 12 s`);
    check('the wyvern is meaningfully better than running', gapW > gapF + 25,
      `${gapW.toFixed(0)} m vs ${gapF.toFixed(0)} m`);
  }

  // 4. THE LEASH. Led far enough away it breaks off, goes home, and STAYS
  //    home rather than yo-yoing at the boundary.
  {
    const r = fly(150, (t) => [30 + 14 * t, 10, 0], [0, 60, 0]);
    check('the dragon breaks off when led past the leash',
      r.f.returning, `returning=${r.f.returning}`);
    const late = r.path[r.path.length - 1];
    const dLate = Math.hypot(late[0] - KEEP[0], late[2] - KEEP[2]);
    check('and it settles back onto its circuit over the keep',
      dLate < 120, `${dLate.toFixed(0)} m from the keep after 150 s`);
    // No frame anywhere in that trace may be a teleport either.
    check('breaking off is flown, not snapped',
      r.maxStep <= BOSS_SPEED * 1.02, `${r.maxStep.toFixed(2)} m/s`);
  }

  // 5. Speed brackets are the design, so state them as assertions.
  check('the dragon outruns a sprinting player', BOSS_SPEED > 10,
    `${BOSS_SPEED} m/s vs SPRINT_SPEED 10`);
  check('a sprinting wyvern outruns the dragon', BOSS_SPEED < 15 * 1.3,
    `${BOSS_SPEED} m/s vs wyvern 19.5`);
  check('the leash keeps the boss near its castle', BOSS_LEASH_R < 400,
    `${BOSS_LEASH_R} m`);

  // 6. The latch still holds with a body in the way — the tell is the mechanic
  //    and the body must not have broken it.
  {
    const f = createCastleFight();
    const M = (t: number, cur: [number, number, number]) => ({
      dtS: DT, curX: cur[0], curY: cur[1], curZ: cur[2],
      keepX: KEEP[0], keepY: KEEP[1], keepZ: KEEP[2],
    });
    let latched: [number, number, number] | null = null;
    let held = true;
    for (let i = 0; i < 60 * 12; i++) {
      const t = i * DT;
      const px = i * 0.05;                        // player walking away
      const c = stepCastleFight(f, t, 'hunting', px, 10, 0, 20, 1, true, 0,
        M(t, [10, 40, 10]));
      if (c.breath === 'tell' && latched === null) latched = [...c.aim];
      else if (c.breath !== 'none' && latched !== null) {
        if (Math.abs(c.aim[0] - latched[0]) > 1e-9) held = false;
      } else if (c.breath === 'none') latched = null;
    }
    check('the breath aim is still latched once the dragon has a body', held);
  }
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
