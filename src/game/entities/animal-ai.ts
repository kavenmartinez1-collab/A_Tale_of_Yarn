/**
 * Animal AI — per-entity state machine stepped each simulation tick.
 *
 * Pure module: no DOM, no GPU. Node-testable.
 *
 * LOD tiers (by playerDist):
 *   > 200 m  → skip (no update)
 *   80–200 m → slow wander: drift around home, walkAmp low
 *   < 80 m   → full state machine
 *
 * Modes:
 *   idle    — stand still for 2–6 s, then transition to graze or wander
 *   graze   — slow random micro-steps, stays near home
 *   wander  — pick a point within 24 m of home, walk to it
 *   flee    — non-aggro species when player < 12 m or after taking damage:
 *             run at speed×1.4 away from player for 4 s
 *   aggro   — aggro species when player < 16 m or after taking damage:
 *             walk toward player; attack every 1.2 s when within 2.5 m
 *   dead    — no AI
 */

import { SPECIES_DEFS, type Species, type SpeciesDef } from './entity-types';
import type { EntityState } from './entity-manager';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOD_SKIP_DIST   = 200; // m — no update beyond this
const LOD_SLOW_DIST   = 80;  // m — slow wander between 80–200 m

const FLEE_TRIGGER_DIST  = 12;  // m — non-aggro flees when closer
const AGGRO_TRIGGER_DIST = 16;  // m — aggro attacks when closer
const ATTACK_DIST        = 2.5; // m — melee contact distance
const FLEE_SPEED_MUL     = 1.4; // flee speed multiplier
const FLEE_DURATION_S    = 4;   // s

const ATTACK_COOLDOWN_S  = 1.2; // s between bite/swipe ticks

const WANDER_RADIUS      = 24;  // m around home
const IDLE_MIN_S         = 2;
const IDLE_MAX_S         = 6;

const TERRAIN_STEP_DIST  = 0.5; // m — how far we probe terrain ahead

/** Phase K: owned babies follow the player within this radius. */
export const FOLLOW_RADIUS = 30; // m
/** Phase K: owned babies stop walking when this close to the player. */
const FOLLOW_STOP_DIST = 2.5;   // m

// ---------------------------------------------------------------------------
// Context passed in from main.ts
// ---------------------------------------------------------------------------

export interface AnimalAICtx {
  playerX: number;
  playerZ: number;
  playerDist: number;   // pre-computed Math.hypot distance
  rng: () => number;
  heightAt: (x: number, z: number) => number;
  speciesDef: SpeciesDef;
  onAttackPlayer: (damage: number) => void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Attack damage for a species: max(1, round(size)) for aggro species. */
export function aggroDamage(species: Species): number {
  const def = SPECIES_DEFS[species];
  return Math.max(1, Math.round(def.size));
}

/** Move entity toward (tx, tz) at given speed, clamped to terrain. */
function moveToward(
  e: EntityState,
  tx: number,
  tz: number,
  speed: number,
  dtS: number,
  heightAt: (x: number, z: number) => number,
  isWater: boolean,
): void {
  const dx = tx - e.x;
  const dz = tz - e.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.05) return;

  const nx = dx / dist;
  const nz = dz / dist;
  const step = speed * dtS;
  const newX = e.x + nx * step;
  const newZ = e.z + nz * step;

  e.x = newX;
  e.z = newZ;
  e.yaw = Math.atan2(nx, -nz); // facing direction: yaw 0 = -Z
  e.walkPhase += speed * dtS * 1.6;

  // Clamp y to terrain.
  if (isWater) {
    e.y = -0.5;
  } else {
    e.y = heightAt(newX, newZ);
  }
}

/** Move entity away from (fx, fz) at given speed. */
function moveAway(
  e: EntityState,
  fx: number,
  fz: number,
  speed: number,
  dtS: number,
  heightAt: (x: number, z: number) => number,
  isWater: boolean,
): void {
  const dx = e.x - fx;
  const dz = e.z - fz;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.01) {
    // Exactly on top: flee in +X direction.
    moveToward(e, e.x + 10, e.z, speed, dtS, heightAt, isWater);
    return;
  }
  const nx = dx / dist;
  const nz = dz / dist;
  moveToward(e, e.x + nx * 100, e.z + nz * 100, speed, dtS, heightAt, isWater);
}

/** Pick a random wander target within WANDER_RADIUS of home. */
function randomWanderTarget(
  homeX: number,
  homeZ: number,
  rng: () => number,
): [number, number] {
  const angle = rng() * Math.PI * 2;
  const r = rng() * WANDER_RADIUS;
  return [homeX + Math.cos(angle) * r, homeZ + Math.sin(angle) * r];
}

// ---------------------------------------------------------------------------
// stepAnimal
// ---------------------------------------------------------------------------

/**
 * Advance one entity's AI by dtS seconds.
 * Returns true if the entity performed a player-attack this tick.
 */
export function stepAnimal(
  e: EntityState,
  dtS: number,
  ctx: AnimalAICtx,
): void {
  if (e.mode === 'dead') return;

  const { playerX, playerZ, playerDist, rng, heightAt, speciesDef, onAttackPlayer } = ctx;
  const isWater = speciesDef.water === true;
  const speed   = speciesDef.speed;

  // ---- LOD: skip if too far ------------------------------------------------
  if (playerDist > LOD_SKIP_DIST) return;

  // ---- LOD: slow wander if moderately far ----------------------------------
  if (playerDist > LOD_SLOW_DIST) {
    // Drift slowly back toward home, low walk amplitude.
    const distHome = Math.hypot(e.x - e.homeX, e.z - e.homeZ);
    if (distHome > 8) {
      moveToward(e, e.homeX, e.homeZ, speed * 0.3, dtS, heightAt, isWater);
    }
    // Keep y synced.
    e.y = isWater ? -0.5 : heightAt(e.x, e.z);
    return;
  }

  // ---- Full state machine (playerDist <= LOD_SLOW_DIST) --------------------

  // Phase K: owned entities (babies) only follow the player — never flee or aggro.
  const isOwned = (e as EntityState & { owned?: boolean }).owned === true;

  if (isOwned) {
    // Force follow mode and skip the flee/aggro logic.
    e.mode = 'follow';
  } else {
    // --- Check flee/aggro triggers (transition override) ----------------------
    // (mode !== 'dead' already guaranteed by the early return above)
    if (speciesDef.aggro) {
      // Aggro species: enter aggro when player close enough.
      if ((e.mode === 'idle' || e.mode === 'graze' || e.mode === 'wander')
          && playerDist <= AGGRO_TRIGGER_DIST) {
        e.mode = 'aggro';
        e.stateTimer = 0;
      }
    } else {
      // Non-aggro species: flee when player close.
      if ((e.mode === 'idle' || e.mode === 'graze' || e.mode === 'wander')
          && playerDist <= FLEE_TRIGGER_DIST) {
        e.mode = 'flee';
        e.fleeTimer = FLEE_DURATION_S;
      }
    }
  }

  // --- Per-mode behaviour ---------------------------------------------------
  switch (e.mode) {
    case 'idle': {
      // Stand still; count down stateTimer.
      e.stateTimer -= dtS;
      if (e.stateTimer <= 0) {
        // Transition to graze or wander.
        if (rng() < 0.4) {
          e.mode = 'graze';
          e.stateTimer = IDLE_MIN_S + rng() * (IDLE_MAX_S - IDLE_MIN_S);
        } else {
          e.mode = 'wander';
          const [wx, wz] = randomWanderTarget(e.homeX, e.homeZ, rng);
          // Store wander target in stateTimer-adjacent fields by repurposing them.
          // We encode target as offset to avoid extra fields: store as property extension.
          (e as EntityState & { _wanderTX?: number; _wanderTZ?: number })._wanderTX = wx;
          (e as EntityState & { _wanderTX?: number; _wanderTZ?: number })._wanderTZ = wz;
          e.stateTimer = 8; // max wander time (safety timeout)
        }
      }
      e.y = isWater ? -0.5 : heightAt(e.x, e.z);
      break;
    }

    case 'graze': {
      // Slow micro-steps.
      e.stateTimer -= dtS;
      if (e.stateTimer <= 0) {
        e.mode = 'idle';
        e.stateTimer = IDLE_MIN_S + rng() * (IDLE_MAX_S - IDLE_MIN_S);
        break;
      }
      // Occasional tiny step.
      if (rng() < 0.015) {
        const angle = rng() * Math.PI * 2;
        const dist = 0.5 + rng() * 1.5;
        const tx = e.x + Math.cos(angle) * dist;
        const tz = e.z + Math.sin(angle) * dist;
        // Don't stray too far from home.
        if (Math.hypot(tx - e.homeX, tz - e.homeZ) < WANDER_RADIUS * 0.5) {
          moveToward(e, tx, tz, speed * 0.3, dtS * 8, heightAt, isWater);
        }
      }
      e.y = isWater ? -0.5 : heightAt(e.x, e.z);
      break;
    }

    case 'wander': {
      const ext = e as EntityState & { _wanderTX?: number; _wanderTZ?: number };
      const tx = ext._wanderTX ?? e.homeX;
      const tz = ext._wanderTZ ?? e.homeZ;
      const distToTarget = Math.hypot(e.x - tx, e.z - tz);

      e.stateTimer -= dtS;
      if (distToTarget < 1.0 || e.stateTimer <= 0) {
        e.mode = 'idle';
        e.stateTimer = IDLE_MIN_S + rng() * (IDLE_MAX_S - IDLE_MIN_S);
        break;
      }

      moveToward(e, tx, tz, speed * 0.6, dtS, heightAt, isWater);
      break;
    }

    case 'flee': {
      e.fleeTimer -= dtS;
      if (e.fleeTimer <= 0) {
        e.mode = 'idle';
        e.stateTimer = IDLE_MIN_S + rng() * (IDLE_MAX_S - IDLE_MIN_S);
        break;
      }
      moveAway(e, playerX, playerZ, speed * FLEE_SPEED_MUL, dtS, heightAt, isWater);
      break;
    }

    case 'aggro': {
      // Walk toward player.
      if (playerDist > AGGRO_TRIGGER_DIST * 2) {
        // Player escaped — return to idle.
        e.mode = 'idle';
        e.stateTimer = IDLE_MIN_S + rng() * (IDLE_MAX_S - IDLE_MIN_S);
        break;
      }

      if (playerDist <= ATTACK_DIST) {
        // In melee range: tick attack cooldown.
        e.stateTimer -= dtS;
        if (e.stateTimer <= 0) {
          const dmg = aggroDamage(e.species);
          onAttackPlayer(dmg);
          e.stateTimer = ATTACK_COOLDOWN_S;
        }
        // Still face the player.
        const aggroDx = playerX - e.x;
        const aggroDz = playerZ - e.z;
        e.yaw = Math.atan2(aggroDx, -aggroDz);
      } else {
        // Move toward player.
        moveToward(e, playerX, playerZ, speed, dtS, heightAt, isWater);
      }
      break;
    }

    case 'follow': {
      // Phase K: owned babies follow the player within FOLLOW_RADIUS.
      // Stop when already close enough; home tracks player to prevent drift.
      if (playerDist > FOLLOW_RADIUS) {
        // Teleport to near the player so they don't get left behind.
        e.x = playerX + (e.x - playerX) * (FOLLOW_RADIUS / Math.max(playerDist, 0.001));
        e.z = playerZ + (e.z - playerZ) * (FOLLOW_RADIUS / Math.max(playerDist, 0.001));
        e.y = isWater ? -0.5 : heightAt(e.x, e.z);
      } else if (playerDist > FOLLOW_STOP_DIST) {
        moveToward(e, playerX, playerZ, speed * 0.7, dtS, heightAt, isWater);
      } else {
        // Close enough: stand still, keep y synced.
        e.y = isWater ? -0.5 : heightAt(e.x, e.z);
      }
      // Update home so it doesn't try to return to original spawn.
      e.homeX = e.x;
      e.homeZ = e.z;
      break;
    }

    default:
      break;
  }

  // Water species must not leave deep water.
  if (isWater) {
    e.y = -0.5;
    // Prevent wandering onto land (h >= -2).
    const h = heightAt(e.x, e.z);
    if (h > -2) {
      // Push back toward home.
      e.x = e.homeX;
      e.z = e.homeZ;
      e.y = -0.5;
    }
  }
}

/**
 * Trigger flee on a non-aggro entity or aggro on an aggro entity
 * when it takes damage.
 */
export function onEntityDamaged(e: EntityState): void {
  if (e.mode === 'dead') return;
  const def = SPECIES_DEFS[e.species];
  if (def.aggro) {
    e.mode = 'aggro';
    e.stateTimer = 0;
  } else {
    e.mode = 'flee';
    e.fleeTimer = FLEE_DURATION_S;
  }
}
