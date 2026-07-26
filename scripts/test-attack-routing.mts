/**
 * Tests for src/game/attack-routing.ts — who takes a hit aimed at the player.
 * Run: npx tsx scripts/test-attack-routing.mts
 *
 * These are the three rules the owner reported as bugs, stated as assertions:
 *   1. a melee hit on a mounted player damages the MOUNT, not the player
 *   2. a ranged hit on a mounted player damages the PLAYER
 *   3. an unmounted player takes melee normally
 * plus the height rule that decides whether a ground melee attack connects at
 * all, and the negative cases that would let each rule pass vacuously.
 */

import {
  routePlayerDamage, routeSpeciesAttack, meleeReachHeight, saddleHeight,
  MIN_MELEE_REACH_HEIGHT, MELEE_REACH_SIZE_MUL,
  type RiderState,
} from '../src/game/attack-routing';
import { SPECIES_DEFS, type Species } from '../src/game/entities/entity-types';

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
// Helpers
// ---------------------------------------------------------------------------

const ON_FOOT: RiderState = { mountId: null, mountBaseY: 0, mountSize: 0 };

/** A rider on `species`, whose mount's base sits `altitude` above ground 0. */
function riding(species: Species, altitude = 0): RiderState {
  return {
    mountId: `mount:${species}`,
    mountBaseY: altitude,
    mountSize: SPECIES_DEFS[species].size,
  };
}

/** An attacker of a given species standing on the ground at y = 0. */
function attacker(species: Species, y = 0) {
  return { size: SPECIES_DEFS[species].size, y };
}

// ---------------------------------------------------------------------------
// 1. Unmounted: melee lands on the player, exactly as before this existed
// ---------------------------------------------------------------------------
{
  for (const sp of ['wolf', 'bear', 'dragon'] as Species[]) {
    const r = routePlayerDamage('melee', attacker(sp), ON_FOOT);
    check(`unmounted player takes ${sp} melee`,
      r.target === 'player' && r.reason === 'unmounted', `got ${r.target}`);
  }
  const ranged = routePlayerDamage('ranged', { size: 1.7, y: 0 }, ON_FOOT);
  check('unmounted player takes ranged', ranged.target === 'player');
  // Height must NOT matter when the player is on foot — an attacker standing
  // on a hill above them still connects.
  const uphill = routePlayerDamage('melee', attacker('bear', 40), ON_FOOT);
  check('unmounted routing ignores height entirely', uphill.target === 'player');
}

// ---------------------------------------------------------------------------
// 2. THE BUG: a bear mauling a player on a grounded dragon hits the DRAGON
// ---------------------------------------------------------------------------
{
  const r = routePlayerDamage('melee', attacker('bear'), riding('dragon', 0));
  check('bear melee on a grounded dragon rider hits the MOUNT',
    r.target === 'mount', `got ${r.target} (${r.reason})`);
  check('...and explicitly NOT the player', r.target !== 'player');

  // Same for every mount and every melee attacker, on the ground.
  const mounts: Species[] = ['horse', 'cow', 'donkey', 'dragon', 'wyvern', 'griffin'];
  const biters: Species[] = ['wolf', 'bear', 'dragon', 'griffin'];
  let allMount = true;
  for (const m of mounts) {
    for (const b of biters) {
      if (routePlayerDamage('melee', attacker(b), riding(m, 0)).target !== 'mount') {
        allMount = false;
        console.error(`  ${b} vs rider on ${m} did not route to the mount`);
      }
    }
  }
  check('every grounded mount x melee attacker routes to the mount', allMount);

  // A human attacker (guard, hostile villager) is the same rule.
  const guard = routePlayerDamage('melee', { size: 1.7, y: 0 }, riding('horse', 0));
  check('a guard\'s sword on a horseman hits the horse', guard.target === 'mount');
}

// ---------------------------------------------------------------------------
// 3. THE OTHER BUG: nothing on the ground reaches a rider 30 m up
// ---------------------------------------------------------------------------
{
  const high = routePlayerDamage('melee', attacker('bear'), riding('dragon', 30));
  check('bear melee cannot reach a dragon 30 m up',
    high.target === 'none' && high.reason === 'out-of-reach', `got ${high.target}`);

  // Not even another dragon on the ground (the largest melee reach in the game).
  const bigA = routePlayerDamage('melee', attacker('dragon'), riding('dragon', 30));
  check('not even a ground dragon reaches 30 m', bigA.target === 'none');

  // The boundary is real and is where the reach formula says it is.
  const bearReach = meleeReachHeight(SPECIES_DEFS['bear'].size);
  check('bear reach is 2x its size (3.6 m)',
    Math.abs(bearReach - SPECIES_DEFS['bear'].size * MELEE_REACH_SIZE_MUL) < 1e-9,
    `reach=${bearReach}`);
  const justIn = routePlayerDamage('melee', attacker('bear'),
    riding('dragon', bearReach - 0.01));
  const justOut = routePlayerDamage('melee', attacker('bear'),
    riding('dragon', bearReach + 0.01));
  check('just inside a bear\'s reach still hits the mount', justIn.target === 'mount');
  check('just outside a bear\'s reach hits nothing', justOut.target === 'none');

  // Small attackers get a floor so they are not useless against a low mount.
  check('a wolf gets the reach floor, not 2x its 0.9 m size',
    Math.abs(meleeReachHeight(SPECIES_DEFS['wolf'].size) - MIN_MELEE_REACH_HEIGHT) < 1e-9);
  check('a wolf can still reach a horse\'s flank',
    routePlayerDamage('melee', attacker('wolf'), riding('horse', 0)).target === 'mount');

  // Height is measured relative to the ATTACKER, not to sea level: a bear on
  // a ledge level with a hovering dragon connects again.
  const level = routePlayerDamage('melee', attacker('bear', 30), riding('dragon', 30));
  check('a bear level with the flying mount reaches it again',
    level.target === 'mount', `got ${level.target}`);
  // ...and an attacker BELOW the mount by more than its reach still misses,
  // while one above it connects (negative rise is always in reach).
  const above = routePlayerDamage('melee', attacker('bear', 50), riding('dragon', 30));
  check('an attacker above the mount reaches it', above.target === 'mount');
}

// ---------------------------------------------------------------------------
// 4. Ranged always reaches the rider — at every altitude, on every mount
// ---------------------------------------------------------------------------
{
  let allPlayer = true;
  for (const m of ['horse', 'dragon', 'wyvern', 'griffin'] as Species[]) {
    for (const alt of [0, 5, 30, 200]) {
      const r = routePlayerDamage('ranged', { size: 1.7, y: 0 }, riding(m, alt));
      if (r.target !== 'player' || r.reason !== 'ranged-reaches-rider') {
        allPlayer = false;
        console.error(`  ranged vs ${m} at ${alt} m routed to ${r.target}`);
      }
    }
  }
  check('ranged reaches the rider on any mount at any altitude', allPlayer);

  // The distinguishing assertion: the SAME attacker at the SAME position gets
  // a different answer purely from the reach classification. Without this, a
  // routing function that always returned 'player' would pass section 4.
  const st = riding('dragon', 30);
  const a = { size: 1.7, y: 0 };
  check('reach is what decides, not position',
    routePlayerDamage('melee', a, st).target === 'none'
    && routePlayerDamage('ranged', a, st).target === 'player');
}

// ---------------------------------------------------------------------------
// 5. routeSpeciesAttack agrees with routePlayerDamage
// ---------------------------------------------------------------------------
{
  const st = riding('dragon', 0);
  const viaSpecies = routeSpeciesAttack('bear', 0, st);
  const viaDirect = routePlayerDamage('melee', attacker('bear'), st);
  check('routeSpeciesAttack matches routePlayerDamage',
    viaSpecies.target === viaDirect.target && viaSpecies.reason === viaDirect.reason);
  check('routeSpeciesAttack defaults to melee', viaSpecies.target === 'mount');
  check('routeSpeciesAttack honours an explicit ranged reach',
    routeSpeciesAttack('bear', 0, riding('dragon', 30), 'ranged').target === 'player');
}

// ---------------------------------------------------------------------------
// 6. Saddle height agrees with main.ts's saddleY (entityY + species size)
// ---------------------------------------------------------------------------
{
  for (const sp of ['horse', 'dragon', 'wyvern'] as Species[]) {
    check(`saddleHeight(${sp}) = species size`,
      Math.abs(saddleHeight(SPECIES_DEFS[sp].size) - SPECIES_DEFS[sp].size) < 1e-9);
  }
  // The routing uses the mount's BASE, not the saddle. A dragon is 3.5 m tall,
  // so if the bar were the saddle a grounded bear (3.6 m reach) would only
  // barely clear it and a grounded wolf never would — which would silently
  // turn "melee hits the mount" into "melee usually hits nothing".
  check('a wolf reaches a grounded dragon (bar is the base, not the saddle)',
    routePlayerDamage('melee', attacker('wolf'), riding('dragon', 0)).target === 'mount');
}

// ---------------------------------------------------------------------------
// 7. Determinism / purity
// ---------------------------------------------------------------------------
{
  const st = riding('wyvern', 3);
  const a = attacker('bear');
  const first = routePlayerDamage('melee', a, st);
  const second = routePlayerDamage('melee', a, st);
  check('routing is deterministic',
    first.target === second.target && first.reason === second.reason);
  check('routing does not mutate its inputs',
    st.mountBaseY === 3 && a.y === 0 && a.size === SPECIES_DEFS['bear'].size);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
