/**
 * Tests for the shield ladder, the frontal cone, and the parry window.
 * Run:  npx tsx scripts/test-shields.mts
 *
 * Three things here are worth more than the rest and are the reason the file
 * exists:
 *
 *  1. **The ladder RELATIONS.** Every tier's stamina cost must be ≤ the tier
 *     below and its fire mitigation ≥. A retune that inverts one of those
 *     type-checks fine, crashes nothing, and quietly makes the forge upgrade
 *     worse than the thing it replaced. Same guard `tintreach.ts` has.
 *
 *  2. **BOTH EDGES of the parry window.** A test that only proves
 *     `window − ε` parries is measuring nothing: an implementation that parried
 *     unconditionally would pass it. Every window assertion below has its
 *     matching `window + ε` case asserting an ORDINARY BLOCK, and the held-block
 *     case asserting the same.
 *
 *  3. **The cone at ±60° exactly.** Boundaries are where sign errors live, and
 *     the bearing is computed through `lockFacingYaw` precisely because this
 *     codebase has two yaw conventions that are negatives of each other. If the
 *     cone ever silently adopts the camera convention, the shield starts
 *     working only when your back is turned — and nothing else here would fail.
 */

import {
  LADDER, SHIELD_STATS, shieldTierOf, isShield, bestShieldTier,
  BLOCK_CONE_HALF, PARRY_WINDOW_S, PARRY_STAGGER_S, PARRY_STAGGER_BOSS_S,
  PARRY_REARM_S, BLOCK_MOVE_MUL,
  blockBearing, inBlockCone,
  createGuard, setGuardInput, dropGuard, parryReady,
  resolveBlock, blockSfx,
  type GuardContext, type IncomingAttack, type ShieldTier,
} from '../src/game/combat/shields';
import { lockFacingYaw, LOCK_ACQUIRE_CONE } from '../src/game/combat/lock-on';
import { MeleeTokenPool } from '../src/game/combat/attack-tokens';
import { ITEM_DEFS } from '../src/game/items';
import { RECIPES } from '../src/game/crafting';

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
const near = (a: number, b: number, tol = 1e-9): boolean => Math.abs(a - b) <= tol;

/** A defender at the origin facing -Z (mesh yaw 0), full stamina, guard down. */
function ctx(over: Partial<GuardContext> = {}): GuardContext {
  return {
    tier: 'iron', guard: createGuard(), nowS: 100, stamina: 100,
    facingYaw: 0, px: 0, pz: 0, ...over,
  };
}
/** A melee blow from directly in front (due -Z of a yaw-0 defender). */
function blow(over: Partial<IncomingAttack> = {}): IncomingAttack {
  return { kind: 'melee', x: 0, z: -2, boss: false, ...over };
}
/** A guard raised at `atS`, held ever since. */
function raisedAt(atS: number) {
  const g = createGuard();
  setGuardInput(g, true, atS);
  return g;
}

// ---------------------------------------------------------------------------
// 1. The ladder — relations, not numbers
// ---------------------------------------------------------------------------

{
  check('four tiers, weakest first', LADDER.length === 4
    && LADDER[0] === 'wood' && LADDER[3] === 'dragonscale');

  for (let i = 1; i < LADDER.length; i++) {
    const lo = SHIELD_STATS[LADDER[i - 1]!];
    const hi = SHIELD_STATS[LADDER[i]!];
    check(`${hi.tier} costs no more stamina than ${lo.tier}`,
      hi.staminaPerBlock <= lo.staminaPerBlock,
      `${lo.staminaPerBlock} -> ${hi.staminaPerBlock}`);
    check(`${hi.tier} turns no less fire than ${lo.tier}`,
      hi.fireMitigation >= lo.fireMitigation,
      `${lo.fireMitigation} -> ${hi.fireMitigation}`);
    check(`${hi.tier} outranks ${lo.tier}`, hi.rank > lo.rank);
  }

  // The ladder must actually GO somewhere. Non-strict relations above would be
  // satisfied by four identical shields, which is a ladder with no rungs.
  const first = SHIELD_STATS[LADDER[0]!];
  const last = SHIELD_STATS[LADDER[LADDER.length - 1]!];
  check('the top rung is strictly cheaper to hold than the bottom',
    last.staminaPerBlock < first.staminaPerBlock,
    `${first.staminaPerBlock} vs ${last.staminaPerBlock}`);
  check('...and strictly better against fire',
    last.fireMitigation > first.fireMitigation,
    `${first.fireMitigation} vs ${last.fireMitigation}`);

  for (const t of LADDER) {
    const s = SHIELD_STATS[t];
    check(`${t}: rank matches its position in LADDER`, LADDER[s.rank] === t);
    check(`${t}: stamina cost is positive`, s.staminaPerBlock > 0);
    // Never 1: standing in a dragon's mouth has to cost something even at the
    // top of the ladder, or the last fight in the game has an off switch.
    check(`${t}: fire mitigation is in (0, 1)`,
      s.fireMitigation > 0 && s.fireMitigation < 1, `${s.fireMitigation}`);
    check(`${t}: its item exists`, s.itemId in ITEM_DEFS);
    check(`${t}: its item is kind 'shield'`,
      ITEM_DEFS[s.itemId].kind === 'shield');
    check(`${t}: its item is unstackable`, ITEM_DEFS[s.itemId].stack === 1);
    check(`${t}: it is craftable`,
      RECIPES.some((r) => r.output === s.itemId), s.itemId);
  }

  // Against a 100-stamina bar these are the blocks-per-bar figures the ladder
  // is actually tuned on. Printed, and pinned only as an ordering.
  const blocks = LADDER.map((t) => Math.floor(100 / SHIELD_STATS[t].staminaPerBlock));
  check('blocks-per-full-bar is non-decreasing up the ladder',
    blocks.every((n, i) => i === 0 || n >= blocks[i - 1]!), blocks.join(' -> '));
}

{
  // Lookup and ranking.
  check('shieldTierOf maps every item id back', LADDER.every(
    (t) => shieldTierOf(SHIELD_STATS[t].itemId) === t));
  check('shieldTierOf(null) is null', shieldTierOf(null) === null);
  check('a sword is not a shield', shieldTierOf('iron_sword') === null);
  check('isShield agrees with shieldTierOf',
    isShield('wood_shield') && !isShield('iron_sword') && !isShield(undefined));

  check('bestShieldTier over an empty bag is null', bestShieldTier([]) === null);
  check('bestShieldTier ignores non-shields',
    bestShieldTier(['iron_sword', 'torch', null]) === null);
  check('bestShieldTier picks the best of several',
    bestShieldTier(['wood_shield', 'iron_shield', 'bronze_shield']) === 'iron');
  check('...regardless of slot order',
    bestShieldTier(['iron_shield', 'wood_shield']) === 'iron');
  check('bestShieldTier finds a lone shield among junk',
    bestShieldTier([null, 'logs', 'dragonscale_shield', 'berries']) === 'dragonscale');
}

// ---------------------------------------------------------------------------
// 2. The cone — and the yaw convention it must share with lock-on
// ---------------------------------------------------------------------------

{
  check('the cone is a 120 degree arc', near(BLOCK_CONE_HALF, Math.PI / 3, 1e-12));

  // A yaw-0 defender faces -Z.
  check('dead ahead is bearing 0', near(blockBearing(0, 0, 0, 0, -5), 0));
  check('directly behind is bearing pi', near(blockBearing(0, 0, 0, 0, 5), Math.PI));
  check('due +X is a quarter turn', near(blockBearing(0, 0, 0, 5, 0), Math.PI / 2));
  check('due -X is a quarter turn', near(blockBearing(0, 0, 0, -5, 0), Math.PI / 2));

  // THE CONVENTION. `blockBearing` must be built on `lockFacingYaw` (mesh
  // facing, atan2(dx, -dz)) and not on the camera's, which is its negative.
  // Test it by turning the defender to face an off-axis attacker: with the
  // right convention the bearing collapses to 0, with the wrong one it does
  // not (and, worse, the shield would work backwards).
  for (const [ax, az] of [[3, 4], [-7, 2], [0.5, -9], [-2, -2], [8, 0]]) {
    const face = lockFacingYaw(0, 0, ax!, az!);
    check(`facing the attacker at (${ax},${az}) gives bearing 0`,
      near(blockBearing(face, 0, 0, ax!, az!), 0, 1e-9));
    check(`...and turning away from it gives bearing pi`,
      near(blockBearing(face + Math.PI, 0, 0, ax!, az!), Math.PI, 1e-9));
  }

  // Both EDGES, exactly. `inBlockCone` is inclusive at the boundary.
  const eps = 1e-6;
  for (const side of [1, -1]) {
    const at = (off: number) => {
      const a = side * off;
      // Place the attacker at bearing `a` from a yaw-0 defender: mesh forward
      // is (sin yaw, -cos yaw), so bearing a is (sin a, -cos a).
      return { x: Math.sin(a) * 5, z: -Math.cos(a) * 5 };
    };
    const inside = at(BLOCK_CONE_HALF - eps);
    const edge = at(BLOCK_CONE_HALF);
    const outside = at(BLOCK_CONE_HALF + eps);
    check(`${side > 0 ? '+' : '-'}60deg - eps is inside the cone`,
      inBlockCone(0, 0, 0, inside.x, inside.z));
    check(`${side > 0 ? '+' : '-'}60deg exactly is inside (inclusive edge)`,
      inBlockCone(0, 0, 0, edge.x, edge.z));
    check(`${side > 0 ? '+' : '-'}60deg + eps is OUTSIDE the cone`,
      !inBlockCone(0, 0, 0, outside.x, outside.z));
  }
  check('the flank at 90deg is outside', !inBlockCone(0, 0, 0, 5, 0));
  check('the rear is outside', !inBlockCone(0, 0, 0, 0, 5));

  // Degenerate: an attacker standing exactly on the defender. Returning NaN
  // here would make every comparison false and silently drop the guard.
  check('an attacker at zero distance counts as dead ahead',
    blockBearing(0, 0, 0, 0, 0) === 0 && inBlockCone(0, 0, 0, 0, 0));

  // The block arc and the lock-on acquire arc are meant to be the same arc, so
  // "lock on, then block" is one idea. Within a couple of degrees.
  check('the block cone matches the lock-on acquire cone',
    Math.abs(BLOCK_CONE_HALF - LOCK_ACQUIRE_CONE) < 0.05,
    `${BLOCK_CONE_HALF.toFixed(4)} vs ${LOCK_ACQUIRE_CONE}`);

  // The cone travels with the defender, not with the world origin.
  check('the cone is relative to the defender, not the origin',
    inBlockCone(0, 40, 40, 40, 35) && !inBlockCone(0, 40, 40, 40, 45));
}

// ---------------------------------------------------------------------------
// 3. The guard state machine — press edges and the anti-mash rule
// ---------------------------------------------------------------------------

{
  const g = createGuard();
  check('a fresh guard is down', !g.down && !g.armed);
  check('...and cannot parry', !parryReady(g, 0));

  check('the press edge returns true', setGuardInput(g, true, 10) === true);
  check('...and raises the guard', g.down && g.raisedAtS === 10);
  check('...and the FIRST raise of a session always arms', g.armed);
  check('...and the window is open immediately', parryReady(g, 10));

  check('holding it down is not an edge', setGuardInput(g, true, 10.05) === false);
  check('...and does NOT re-stamp raisedAtS', g.raisedAtS === 10);

  check('the window closes on time', !parryReady(g, 10 + PARRY_WINDOW_S + 1e-9));
  check('...and is still open at the last instant', parryReady(g, 10 + PARRY_WINDOW_S));

  // Held forever: the single most important negative in the file.
  for (const t of [10.5, 12, 30, 1000]) {
    check(`a guard held to t=${t} never parries`, !parryReady(g, t));
  }

  check('releasing is not an edge-true', setGuardInput(g, false, 40) === false);
  check('...and lowers the guard', !g.down && !g.armed && g.raisedAtS === -1);
}

{
  // The anti-mash rule. Without it, a 5 Hz masher gets a fresh window on every
  // press and parries everything without reading a single tell.
  // Base at 0 rather than at a round wall-clock-looking number: `0.6 + 100`
  // minus `100` is 0.5999999999999943 in binary floating point, and a boundary
  // test written that way measures the FPU rather than the rule.
  const g = createGuard();
  setGuardInput(g, true, 0);
  check('first raise arms', g.armed);
  setGuardInput(g, false, 0.05);
  setGuardInput(g, true, 0.10);
  check('a re-raise inside the re-arm window still RAISES the shield', g.down);
  check('...but is NOT armed, so it cannot parry', !g.armed);
  check('...and parryReady agrees', !parryReady(g, 0.10));

  setGuardInput(g, false, PARRY_REARM_S - 0.05);
  setGuardInput(g, true, PARRY_REARM_S - 1e-6);
  check('a hair BEFORE the re-arm interval still does not arm', !g.armed);

  setGuardInput(g, false, PARRY_REARM_S);
  setGuardInput(g, true, PARRY_REARM_S);
  check('a re-raise at the re-arm interval arms again', g.armed);
  check('...and its window opens', parryReady(g, PARRY_REARM_S));

  // Duty cycle: mashing can cover at most window/rearm of the timeline.
  check('mashing cannot cover more than a third of the time',
    PARRY_WINDOW_S / PARRY_REARM_S <= 0.34,
    `${(PARRY_WINDOW_S / PARRY_REARM_S * 100).toFixed(0)}%`);
}

{
  // dropGuard must not be a cheaper release. If it reset `lastArmedAtS`, dying
  // (or opening a panel) would hand out a free re-arm.
  const g = createGuard();
  setGuardInput(g, true, 200);
  dropGuard(g);
  check('dropGuard lowers the guard', !g.down && !g.armed);
  setGuardInput(g, true, 200.1);
  check('...and does not reset the re-arm clock', !g.armed);
}

// ---------------------------------------------------------------------------
// 4. resolveBlock — the whole decision, at both edges of everything
// ---------------------------------------------------------------------------

{
  // Nothing carried.
  const noShield = resolveBlock(ctx({ tier: null, guard: raisedAt(100) }), blow());
  check('no shield: the blow goes through', noShield.kind === 'through'
    && noShield.reason === 'no-shield' && noShield.damageMul === 1);
  check('no shield: it costs no stamina', noShield.staminaCost === 0);

  // Carried but not raised.
  const down = resolveBlock(ctx(), blow());
  check('shield down: the blow goes through', down.kind === 'through'
    && down.reason === 'not-raised' && down.damageMul === 1);
}

{
  // FRONT vs REAR — the pair that proves the cone is load-bearing.
  const front = resolveBlock(ctx({ guard: raisedAt(90) }), blow({ x: 0, z: -2 }));
  check('a frontal blow behind a raised shield is BLOCKED',
    front.kind === 'block' && front.reason === 'blocked');
  check('...for zero damage', front.damageMul === 0);
  check('...at the tier stamina cost',
    front.staminaCost === SHIELD_STATS.iron.staminaPerBlock,
    `${front.staminaCost}`);

  const rear = resolveBlock(ctx({ guard: raisedAt(90) }), blow({ x: 0, z: 2 }));
  check('the SAME blow from behind lands in full',
    rear.kind === 'through' && rear.reason === 'flank' && rear.damageMul === 1);
  check('...and costs no stamina (you never braced)', rear.staminaCost === 0);

  const flank = resolveBlock(ctx({ guard: raisedAt(90) }), blow({ x: 2, z: 0 }));
  check('a flank at 90deg lands in full',
    flank.kind === 'through' && flank.reason === 'flank');
}

{
  // THE PARRY WINDOW, BOTH EDGES. `window − ε` and `window + ε` against the
  // same shield, the same blow, the same bearing — only the timing differs.
  const eps = 1e-4;
  const g = raisedAt(50);

  const early = resolveBlock(ctx({ guard: g, nowS: 50 + PARRY_WINDOW_S - eps }), blow());
  check('window - eps: PARRY', early.kind === 'parry' && early.reason === 'parried');
  check('...zero damage', early.damageMul === 0);
  check('...zero stamina', early.staminaCost === 0);
  check('...and the attacker is staggered',
    near(early.staggerS, PARRY_STAGGER_S), `${early.staggerS}`);

  const late = resolveBlock(ctx({ guard: g, nowS: 50 + PARRY_WINDOW_S + eps }), blow());
  check('window + eps: ORDINARY BLOCK',
    late.kind === 'block' && late.reason === 'blocked');
  check('...still zero damage (a block is a block)', late.damageMul === 0);
  check('...but it COSTS stamina', late.staminaCost > 0, `${late.staminaCost}`);
  check('...and staggers nobody', late.staggerS === 0);

  // The pair, stated as the difference it is supposed to make.
  check('the window is the only difference between the two',
    early.staminaCost === 0 && late.staminaCost > 0
    && early.staggerS > 0 && late.staggerS === 0);

  // Exactly on the boundary is a parry (inclusive).
  const edge = resolveBlock(ctx({ guard: g, nowS: 50 + PARRY_WINDOW_S }), blow());
  check('exactly at the window edge: parry', edge.kind === 'parry');
}

{
  // UNIFORM ACROSS TIERS. Parry is the skill axis; gear is the attrition axis.
  const at = (tier: ShieldTier, dt: number) =>
    resolveBlock(ctx({ tier, guard: raisedAt(0), nowS: dt }), blow());
  for (const t of LADDER) {
    check(`${t}: parries at window - eps`, at(t, PARRY_WINDOW_S - 1e-4).kind === 'parry');
    check(`${t}: does NOT parry at window + eps`,
      at(t, PARRY_WINDOW_S + 1e-4).kind === 'block');
    check(`${t}: the parry costs nothing at every tier`,
      at(t, 0.01).staminaCost === 0 && at(t, 0.01).damageMul === 0);
    check(`${t}: the parry stagger is the same at every tier`,
      near(at(t, 0.01).staggerS, PARRY_STAGGER_S));
  }
}

{
  // A parry needs the CONE too. A perfectly timed press against a blow from
  // behind is still a blow from behind.
  const back = resolveBlock(ctx({ guard: raisedAt(0), nowS: 0.05 }), blow({ x: 0, z: 5 }));
  check('a perfectly-timed parry from behind does not save you',
    back.kind === 'through' && back.reason === 'flank');

  // ...and it needs the guard to be ARMED.
  const g = createGuard();
  setGuardInput(g, true, 0);
  setGuardInput(g, false, 0.05);
  setGuardInput(g, true, 0.10);      // inside PARRY_REARM_S -> not armed
  const mashed = resolveBlock(ctx({ guard: g, nowS: 0.12 }), blow());
  check('a mashed re-raise blocks but does not parry',
    mashed.kind === 'block' && mashed.staminaCost > 0);
}

{
  // Bosses: parryable, but the stagger is halved-and-then-some.
  const boss = resolveBlock(ctx({ guard: raisedAt(0), nowS: 0.05 }), blow({ boss: true }));
  check('a boss IS parryable', boss.kind === 'parry');
  check('...for the short stagger',
    near(boss.staggerS, PARRY_STAGGER_BOSS_S), `${boss.staggerS}`);
  check('the boss stagger is less than half the ordinary one',
    PARRY_STAGGER_BOSS_S < PARRY_STAGGER_S / 2,
    `${PARRY_STAGGER_BOSS_S} vs ${PARRY_STAGGER_S}`);
}

{
  // BREATH: mitigated, never stopped, never parried.
  for (const t of LADDER) {
    const s = SHIELD_STATS[t];
    const fire = resolveBlock(ctx({ tier: t, guard: raisedAt(0), nowS: 0.05 }),
      blow({ kind: 'breath' }));
    check(`${t}: breath is mitigated, not parried`,
      fire.kind === 'block' && fire.reason === 'mitigated');
    check(`${t}: breath mitigation matches the ladder`,
      near(fire.damageMul, 1 - s.fireMitigation), `${fire.damageMul}`);
    check(`${t}: some fire always gets through`, fire.damageMul > 0);
    check(`${t}: bracing against fire costs stamina`,
      fire.staminaCost === s.staminaPerBlock);
  }
  // The headline number: the same jet, wood vs dragonscale.
  const wood = resolveBlock(ctx({ tier: 'wood', guard: raisedAt(0), nowS: 0.05 }),
    blow({ kind: 'breath' })).damageMul;
  const ds = resolveBlock(ctx({ tier: 'dragonscale', guard: raisedAt(0), nowS: 0.05 }),
    blow({ kind: 'breath' })).damageMul;
  check('dragonscale turns at least three times as much fire as wood',
    wood / ds >= 3, `wood x${wood.toFixed(2)} vs dragonscale x${ds.toFixed(2)}`);

  // Breath from behind still burns you.
  check('breath from behind is not mitigated',
    resolveBlock(ctx({ guard: raisedAt(0), nowS: 0.05 }),
      blow({ kind: 'breath', x: 0, z: 5 })).damageMul === 1);
}

{
  // ARROWS: blockable by the cone, never parryable. The decision is documented
  // in main.ts's projectile path; this is where it is pinned.
  const shot = resolveBlock(ctx({ guard: raisedAt(0), nowS: 0.05 }),
    blow({ kind: 'projectile' }));
  check('a frontal arrow is BLOCKED even inside the parry window',
    shot.kind === 'block' && shot.reason === 'blocked');
  check('...for zero damage', shot.damageMul === 0);
  check('...at the tier cost', shot.staminaCost === SHIELD_STATS.iron.staminaPerBlock);
  check('an arrow from the flank lands',
    resolveBlock(ctx({ guard: raisedAt(0), nowS: 0.05 }),
      blow({ kind: 'projectile', x: 5, z: 0 })).damageMul === 1);
}

{
  // GUARD BREAK: you must have the stamina BEFORE the blow.
  const cost = SHIELD_STATS.iron.staminaPerBlock;
  const just = resolveBlock(ctx({ guard: raisedAt(0), nowS: 5, stamina: cost }), blow());
  check('exactly enough stamina still blocks', just.kind === 'block');
  const shy = resolveBlock(
    ctx({ guard: raisedAt(0), nowS: 5, stamina: cost - 1e-6 }), blow());
  check('a hair short of enough breaks the guard',
    shy.kind === 'through' && shy.reason === 'guard-break' && shy.damageMul === 1);
  check('a broken guard costs no stamina (there was none to spend)',
    shy.staminaCost === 0);

  // But a PARRY is free, so an exhausted player who reads the tell is rewarded.
  const brokeButTimed = resolveBlock(
    ctx({ guard: raisedAt(0), nowS: 0.05, stamina: 0 }), blow());
  check('at zero stamina, a correctly-timed parry still works',
    brokeButTimed.kind === 'parry' && brokeButTimed.damageMul === 0);

  // ...and dragonscale is the tier that can still guard when wood cannot.
  const low = 2;
  check('at 2 stamina wood breaks but iron holds',
    resolveBlock(ctx({ tier: 'wood', guard: raisedAt(0), nowS: 5, stamina: low }),
      blow()).reason === 'guard-break'
    && resolveBlock(ctx({ tier: 'iron', guard: raisedAt(0), nowS: 5, stamina: low }),
      blow()).kind === 'block');
}

{
  // Bearing is reported on every outcome, including the ones that go through —
  // the HUD and the harnesses both read it, and a `through` with no bearing
  // would make "why did that land" unanswerable.
  const r = resolveBlock(ctx({ tier: null }), blow({ x: 5, z: 0 }));
  check('bearing is reported even when nothing is carried',
    near(r.bearing, Math.PI / 2));
}

{
  // The SFX mapping, in one place so the two damage paths cannot disagree.
  check('a parry sounds like a parry',
    blockSfx(resolveBlock(ctx({ guard: raisedAt(0), nowS: 0.05 }), blow()))
    === 'shield_parry');
  check('a block sounds like a block',
    blockSfx(resolveBlock(ctx({ guard: raisedAt(0), nowS: 5 }), blow()))
    === 'shield_block');
  check('a blow that lands is silent (the hurt cry covers it)',
    blockSfx(resolveBlock(ctx({ tier: null }), blow())) === null);
}

// ---------------------------------------------------------------------------
// 5. Token interaction — a parry must not stall the rotation
// ---------------------------------------------------------------------------

{
  // A blocked attacker finishes its turn normally: no free extra swings.
  const pool = new MeleeTokenPool();
  pool.advance(0.1);
  check('the attacker takes a token', pool.requestSwing('wolf-a', 'wolf'));
  check('...and holds it', pool.holds('wolf-a') && pool.heldCount === 1);
  // Blocking changes nothing about the token economy — the swing still went
  // out, it just did not land.
  pool.noteSwing('wolf-a');
  check('after a blocked swing it still holds (follow-through)',
    pool.holds('wolf-a'));
  let t = 0;
  while (t < 0.5 && pool.holds('wolf-a')) { pool.requestSwing('wolf-a', 'wolf'); pool.advance(0.05); t += 0.05; }
  check('...and the follow-through releases it on schedule',
    !pool.holds('wolf-a') && t <= 0.5, `t=${t.toFixed(2)}`);
}

{
  // A PARRY hands the token back at once, so the pack keeps rotating rather
  // than going quiet for the whole stagger.
  const pool = new MeleeTokenPool();
  pool.advance(0.1);
  pool.requestSwing('wolf-a', 'wolf');
  check('the parried attacker held a token', pool.holds('wolf-a')
    && pool.heldCount === 1);
  pool.releaseToken('wolf-a');
  check('releaseToken frees it immediately',
    !pool.holds('wolf-a') && pool.heldCount === 0);

  // ...and the next enemy can take the freed token on the very next tick.
  pool.requestSwing('wolf-b', 'wolf');
  pool.advance(0.05);
  const gotIt = pool.requestSwing('wolf-b', 'wolf');
  check('the rotation continues: someone else takes the freed token', gotIt);

  // Releasing twice must not go negative or hand out a phantom token.
  pool.releaseToken('wolf-b');
  pool.releaseToken('wolf-b');
  pool.releaseToken('nobody');
  check('a double release does not corrupt the pool', pool.heldCount === 0);
}

{
  // The parried enemy must NOT be promoted back to the front of the queue —
  // punishing it and then giving it the next turn is backwards.
  const pool = new MeleeTokenPool();
  pool.advance(0.1);
  pool.requestSwing('a', 'wolf');   // a takes the token, waitedS -> 0
  pool.requestSwing('b', 'wolf');   // b contends, denied
  pool.requestSwing('c', 'wolf');
  pool.releaseToken('a');           // parried
  // Keep everyone contending and see who gets the next grant.
  let winner = '';
  for (let i = 0; i < 3 && winner === ''; i++) {
    pool.advance(0.05);
    for (const id of ['a', 'b', 'c']) {
      if (pool.requestSwing(id, 'wolf') && pool.holds(id)) { winner = id; break; }
    }
  }
  check('the parried enemy does not jump the queue', winner !== 'a', `winner=${winner}`);
}

// ---------------------------------------------------------------------------
// 6. Tuning sanity against the game's own numbers
// ---------------------------------------------------------------------------

{
  check('blocking costs half your speed', BLOCK_MOVE_MUL === 0.5);
  // Short enough that it cannot be reached by reacting to the blow itself
  // (human visual reaction ~0.25 s) — the player must read the WINDUP.
  check('the parry window is shorter than human reaction time',
    PARRY_WINDOW_S < 0.25, `${PARRY_WINDOW_S}`);
  check('...but longer than two frames at 60 fps',
    PARRY_WINDOW_S > 2 / 60, `${PARRY_WINDOW_S}`);
  // A stagger shorter than the fastest cadence in the roster would buy nothing.
  check('the ordinary stagger outlasts a goblin cadence (1.2 s)',
    PARRY_STAGGER_S >= 1.2);
  check('the re-arm interval is longer than the window',
    PARRY_REARM_S > PARRY_WINDOW_S);
}

console.log(`${passed} passed, ${failed} failed`);
console.log('  ladder: ' + LADDER.map((t) => {
  const s = SHIELD_STATS[t];
  return `${t} ${s.staminaPerBlock}sta/${(s.fireMitigation * 100).toFixed(0)}%fire`;
}).join('  ·  '));
if (failed > 0) process.exit(1);
