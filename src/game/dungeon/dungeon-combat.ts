/**
 * dungeon-combat.ts — whether a dungeon enemy can reach the player at all,
 * and how fast a room full of them is allowed to kill them.
 *
 * WHY THIS IS ITS OWN FILE
 *
 * The same reason `dungeon-enemies.ts` is: `dungeon-manager.ts` imports the
 * renderer, which imports `.wgsl?raw`, which `tsx` cannot load, so nothing in
 * the manager can be asserted in Node. The enemy tick used to live there, which
 * meant the single most consequential loop in the dungeon — the one that
 * decides when the player takes damage — had no unit test that could see it.
 * Everything here is pure: no DOM, no GPU, no renderer import, so
 * `scripts/test-dungeon-combat.mts` asserts against shipping code rather than
 * against a replica.
 *
 * WHAT WAS WRONG: HITS THROUGH WALLS
 *
 * `animal-ai` decides to attack on ONE number — `Math.hypot(dx, dz)` against a
 * species reach — and the dungeon fed it a straight line drawn through solid
 * rock. On a 1 m cell grid where a wall is exactly one cell, that is not a near
 * miss, it is routine:
 *
 *   - Two floor cells either side of a wall are 2.0 m apart, and the shared
 *     melee reach is 2.5 m. So ANY enemy standing against its room's edge hits
 *     a player standing against the other face of that wall, forever, on
 *     cadence, through a metre of stone.
 *   - The Dread King's `reachBonus` of 1.6 makes that 4.1 m — three cells. He
 *     hits you in the corridor outside his throne room.
 *   - The goblin archer's `rangedRange` is 16 m and its damage is applied at
 *     loose time, not on impact. It shot players through however many rooms
 *     happened to lie between them.
 *
 * And because enemies are hard-clamped to their spawn room with no pathfinding,
 * this was not even self-correcting: an enemy that cannot follow you out of the
 * room can still stand at the clamp edge and beat on you indefinitely.
 *
 * The aggro trigger had the same shape — 16 m of pure proximity — so walking
 * down a corridor woke every room beside it.
 *
 * THE FIX, AND WHY IT IS IN TWO PLACES
 *
 * `cellLineOfSight` (`interior-los.ts`) is the same test that gates the E-key
 * prompt; dungeons and building interiors share a cell encoding precisely so
 * there is one implementation. It is applied twice, for two different reasons:
 *
 *   1. A CACHED test feeds the AI a distance it is allowed to believe. Out of
 *      sight means "far away", which suppresses the aggro trigger and the
 *      archer's band without touching `animal-ai`. This is a behaviour fix and
 *      a stale answer costs nothing worse than a late reaction.
 *
 *   2. An EXACT, uncached test gates the damage callbacks themselves. This is
 *      the correctness guarantee — no HP moves through a wall, ever — and it
 *      must not be allowed to run on cached data. It is also free: a callback
 *      fires at most once per attack cadence (1.2–1.9 s), not once per frame.
 *
 * Faking the distance alone would NOT have worked, and that is worth recording:
 * `engage()` recomputes its own `Math.hypot` from the entity to the target and
 * never looks at `ctx.playerDist`, so an already-aggro'd enemy would have gone
 * on swinging through the wall regardless. The callback gate is the fix; the
 * distance is the polish.
 */

import { cellLineOfSight } from '../interior-los';
import type { EntityState } from '../entities/entity-manager';
import { CombatIndex, stepAnimal, type RangedShot } from '../entities/animal-ai';
import { MeleeTokenPool } from '../combat/attack-tokens';
import { SPECIES_DEFS, type Species } from '../entities/entity-types';
import type { Vec3 } from '../math';
import { mulberry32 } from '../mesh-utils';
import type { DungeonEnemy } from './dungeon-enemies';
import type { DungeonLayout } from './dungeon-layout';

/**
 * Distance reported to the AI for a player it cannot see.
 *
 * Must exceed `animal-ai`'s `AGGRO_TRIGGER_DIST` (16 m) so an unseen player
 * never provokes a fresh aggro, and the archer's 16 m band closes with it. It
 * must NOT exceed `LOD_SLOW_DIST` (80 m), or occluded enemies would drop to the
 * lazy update tier and stop wandering — a room of statues is its own bug.
 *
 * It is also deliberately below `AGGRO_TRIGGER_DIST * 2` (32 m, the de-aggro
 * threshold), so an enemy already fighting you does not forget you the instant
 * you step behind a pillar. It keeps coming to the doorway; it just cannot
 * land anything while the wall is in the way.
 *
 * `test-dungeon-combat.mts` asserts the two properties that pin this number
 * rather than the number itself, so a change to either constant in
 * `animal-ai.ts` fails there instead of silently un-fixing this.
 */
const OCCLUDED_DIST = 20;

/**
 * NOT narrowed further than `animal-ai`'s own 16 m, and that is a measured
 * decision rather than an oversight.
 *
 * A 10 m dungeon-local aggro radius was built and rejected. The theory was
 * good — 16 m is wider than most rooms, so a doorway wakes a large hall as one
 * block, and enemies that cannot path cannot flank, so the whole room simply
 * arrives together. Splitting the pull should have been strictly better.
 *
 * The delve simulation said otherwise. Holding everything else fixed, 10 m cost
 * 7 % MORE damage to clear (159.3 hp vs 149.0) and shaved the mean number of
 * simultaneous attackers by only 5 % (1.27 vs 1.34), with the peak unchanged at
 * 7. Enemies that stay asleep do not come to the player, so the player has to
 * walk further into the room to reach each one and spends longer inside the
 * reach of everything already awake. The benefit needs a player who
 * deliberately pulls and retreats; the cost lands on one who does not.
 *
 * It is recorded here rather than deleted silently because it is a plausible
 * idea that will be had again.
 */

/**
 * Beyond this, skip the line-of-sight march entirely and report the true
 * distance.
 *
 * Nothing in the roster can attack from further — the longest reach in a
 * dungeon is the archer's 16 m — so the answer cannot change any decision, and
 * this keeps the cost proportional to the fight rather than to the dungeon.
 */
const LOS_MAX_DIST = 20;

/**
 * How long a cached line-of-sight answer is trusted, in SIM seconds.
 *
 * The march is `ceil(dist / 0.2)` array reads, so 100 at worst; at the 22-enemy
 * cap that is ~2 200 reads a frame if every enemy tested every frame, which is
 * affordable but pointless. At 0.15 s the AI-facing test runs about 7 times a
 * second per enemy and the player (6 m/s at a sprint) can move at most 0.9 m
 * inside the window — under one cell. The damage gate never reads this cache.
 */
const LOS_REFRESH_S = 0.15;

/**
 * WHERE THE 0.8 s GRACE WINDOW WENT.
 *
 * This module used to own `PLAYER_HIT_GRACE_S = 0.8` — the minimum sim seconds
 * between two blows landing on the player — because seven skeletons swinging on
 * independent cooldowns could deal 35 damage inside one frame against 20 max HP,
 * and the first frame you were in reach was the last frame you were alive.
 *
 * That reasoning was right and the number survives unchanged. What was wrong was
 * the address. The defect it patched — nothing anywhere coordinates a pack — was
 * never a dungeon problem; the dungeon was just the only room crowded enough to
 * make it fatal. Six wolves in the overworld had the identical flaw and no cap at
 * all.
 *
 * It now lives in `combat/attack-tokens.ts` as `LANDING_FLOOR_S`, applies in both
 * places, and sits beside the concurrency limit that is the real fix. The two are
 * NOT redundant and neither replaces the other: tokens bound how many enemies may
 * swing at once, the floor bounds how fast blows may land. Two tokens against
 * goblins (1.2 s cadence) is a landed blow every 0.6 s — faster than this window
 * ever allowed — so deleting the floor when tokens arrived would have made
 * dungeons harder while making them look calmer.
 *
 * `blockedByGrace` below is still counted and still asserted by
 * `test-dungeon-combat.mts`; it is now sourced from the pool.
 */

/**
 * Private per-enemy line-of-sight cache.
 *
 * The house idiom from `animal-ai.ts`: an `EntityState &` alias local to the
 * module that owns the fields, every field optional, absent meaning "not
 * measured yet". Nothing is added to the shared `EntityState` interface, so an
 * enemy that has never been near a player carries no extra state at all.
 */
type LosState = DungeonEnemy & {
  /** Last line-of-sight answer for the player. */
  _losSeen?: boolean;
  /** Sim seconds until `_losSeen` goes stale. */
  _losIn?: number;
};

/** Everything the tick needs from the resident dungeon. */
export interface DungeonTickCtx {
  layout: DungeonLayout;
  origin: Vec3;
  /**
   * Land a blow on the player. Already gated on sight and on the grace window.
   *
   * `source` and `tokens` exist for the SHIELD. Blocking is a frontal-cone test
   * against the attacker's world position, and a parry has to stagger the
   * attacker and hand its token back — none of which is expressible from a
   * damage number. This callback used to be `(damage: number) => void`, which
   * made the dungeon the one place in the game where the defender could not
   * tell which direction it was being hit from; `onAttackEntity` and
   * `onRangedAttack` below always passed their source, and only this one
   * dropped it.
   *
   * `kind` distinguishes a swing (parryable) from an arrow (blockable by the
   * cone, never parryable) — the archer's shot arrives through this same
   * callback when no projectile renderer is wired.
   */
  onAttackPlayer: (
    damage: number, source: DungeonEnemy, kind: 'melee' | 'projectile',
    tokens: MeleeTokenPool,
  ) => void;
  /** Land a blow on another dungeon enemy. Already gated on sight. */
  onAttackEntity: (source: DungeonEnemy, targetId: string, damage: number) => void;
  /**
   * A ranged attacker is loosing. Absent means no projectile renderer is wired,
   * in which case `animal-ai` falls back to `onAttackPlayer` and the archer is
   * still a working enemy — just an invisible one.
   */
  onRangedAttack?: (source: DungeonEnemy, shot: RangedShot) => void;
}

/**
 * Per-dungeon combat state: the shared mob-vs-mob index and the melee
 * turn-taking pool for this dungeon's enemies.
 *
 * LIFETIME. One of these is held by `DungeonManager` for the manager's whole
 * life, not per delve — which contradicted this comment for as long as the
 * comment has existed, and quietly leaked `hitGrace` and both counters across
 * every dungeon the player entered. `reset()` now exists and `exit()` calls it,
 * so the claim is true rather than aspirational.
 */
export class DungeonCombat {
  /** Shared per-tick combat index, rebuilt once for the whole dungeon. */
  readonly index = new CombatIndex();

  /**
   * Melee turn-taking for this dungeon. Its own instance rather than one
   * shared with the overworld: `tickEntities` returns early underground, so
   * the two enemy sets are disjoint and never contend for the same tokens.
   */
  readonly tokens = new MeleeTokenPool();

  /** Blows suppressed because a wall was in the way. Diagnostics only. */
  blockedByWall = 0;

  /**
   * Blows suppressed because they arrived inside the landing floor.
   *
   * Sourced from the pool, which owns the floor now. Kept under the old name
   * because it is what `test-dungeon-combat.mts` asserts on, and that
   * assertion's job — proving the crowd really was trying to land more, so the
   * rate ceiling is not passing vacuously — is unchanged by where the timer
   * lives.
   */
  get blockedByGrace(): number { return this.tokens.deniedByRate; }

  /** Swings never thrown because every attack token was taken. */
  get blockedByToken(): number { return this.tokens.deniedByToken; }

  /** Most enemies ever committed to a swing at once. See `peakHeld`. */
  get peakAttackers(): number { return this.tokens.peakHeld; }

  /**
   * Advance every live enemy by `dtS` sim seconds.
   *
   * Enemies are clamped to their spawn room's floor rect — they have no
   * pathfinding and never leave the room they were placed in. That clamp is
   * what makes the sight test load-bearing rather than cosmetic: an enemy
   * pinned against its own wall by the clamp used to keep hitting whatever
   * stood on the far side of it.
   */
  tick(
    enemies: DungeonEnemy[],
    dtS: number,
    playerX: number,
    playerZ: number,
    ctx: DungeonTickCtx,
  ): void {
    const { layout, origin } = ctx;
    // Once per tick, before any enemy is stepped — the same contract the
    // combat index below has.
    this.tokens.advance(dtS);

    // Grid-local player position. `cellLineOfSight` works in the same metres
    // `dungeon-mesh` draws with, where cell (i, j) spans [i, i+1] x [j, j+1].
    const plx = playerX - origin[0];
    const plz = playerZ - origin[2];

    // Rebuilt once for the whole room, not once per enemy — see
    // `combat-targeting.ts` for why that is the difference between O(n) and
    // O(n²) here. It costs one pass over at most 22 entities.
    this.index.rebuild(enemies, null, playerX, playerZ);

    for (const e of enemies) {
      if (e.mode === 'dead') continue;
      // Per-enemy, NOT hoisted. It used to be `SPECIES_DEFS['wolf']` fetched
      // once outside the loop and handed to every enemy, so the instant this
      // dungeon held two different species they would all have moved at the
      // wolf's speed, taken the wolf's damage and used the wolf's size for
      // collision. That was invisible while there was only ever one species.
      const def = SPECIES_DEFS[e.species];
      const trueDist = Math.hypot(e.x - playerX, e.z - playerZ);
      const rng = mulberry32(((e.walkPhase * 1000) | 0) ^ e.id.charCodeAt(8));

      // The AI-facing answer: cached, and allowed to be a little stale.
      const seen = this._seesPlayer(e, dtS, trueDist, plx, plz, layout, origin);

      // The damage-facing answer: exact, and recomputed at the moment of the
      // blow, because the enemy may have moved during `stepAnimal`.
      const seesNow = (): boolean => cellLineOfSight(
        layout.cells, layout.w, layout.h,
        e.x - origin[0], e.z - origin[2], plx, plz);

      // moveXZ clamps movement to the enemy's room rect in world coords.
      const roomX0 = e.roomX + 0.5;
      const roomZ0 = e.roomZ + 0.5;
      const roomX1 = e.roomX + e.roomW - 0.5;
      const roomZ1 = e.roomZ + e.roomD - 0.5;
      const moveXZ = (
        ex: number, ez: number, dx: number, dz: number, _r: number,
      ): [number, number] => [
        Math.max(roomX0, Math.min(roomX1, ex + dx)),
        Math.max(roomZ0, Math.min(roomZ1, ez + dz)),
      ];

      // Flat dungeon floor: heightAt always returns the dungeon y-origin.
      const floorY = origin[1];
      const heightAt = (_x: number, _z: number): number => floorY;

      stepAnimal(e, dtS, {
        playerX,
        playerZ,
        // A player behind a wall is reported as unreachably far. This is what
        // stops a corridor waking every room beside it, and what keeps the
        // archer from opening its band on someone it cannot see.
        playerDist: seen ? trueDist : Math.max(trueDist, OCCLUDED_DIST),
        rng,
        heightAt,
        moveXZ,
        speciesDef: def,
        onAttackPlayer: (damage: number) => {
          // `false`: the landing floor was already consulted in `engage`,
          // before the swing was allowed out. Consulting it twice would eat
          // every second blow.
          this._hitPlayer(damage, seesNow, ctx, null, e, 'melee');
        },
        combat: this.index,
        tokens: this.tokens,
        onAttackEntity: (targetId: string, damage: number) => {
          // Same rule in the other direction. Two enemies in the same room
          // always have sight of each other — a room is a solid rect of floor —
          // so this only ever fires for the across-a-wall case that was wrong.
          if (!this._seesEntity(e, targetId, ctx)) return;
          ctx.onAttackEntity(e, targetId, damage);
        },
        onRangedAttack: ctx.onRangedAttack === undefined ? undefined : (_src, shot) => {
          if (shot.kind === 'player') {
            // Suppress the ARROW as well as the damage: a bolt that leaves the
            // bow, flies through a wall and hurts nobody is a worse artefact
            // than no shot at all.
            if (!seesNow()) { this.blockedByWall++; return; }
            ctx.onRangedAttack?.(e, shot);
            // The arrow still flies inside the landing floor — it reads as a
            // near miss — but it does not land. `true` because ranged never
            // passes through the token gate: an archer holds its distance and
            // its cadence is already sparse, so it is not part of the
            // shoulder-to-shoulder problem tokens exist to solve. The floor is
            // therefore still this call's own job.
            this._hitPlayer(shot.damage, () => true, ctx, e.species, e, 'projectile');
            return;
          }
          if (shot.kind === 'entity' && shot.id !== undefined) {
            if (!this._seesEntity(e, shot.id, ctx)) return;
            ctx.onRangedAttack?.(e, shot);
            ctx.onAttackEntity(e, shot.id, shot.damage);
          }
        },
      });

      // Clamp y to floor (stepAnimal may set it via heightAt, but belt+braces).
      e.y = floorY;
    }
  }

  /**
   * Apply a blow to the player, if the wall — and, for callers that have not
   * already asked, the pool's landing floor — both allow.
   *
   * `rateGate` null means the caller consulted `MeleeArbiter.mayLand` itself
   * before committing the swing (melee does); otherwise it is the attacker's
   * species, which the floor needs in order to let bosses through.
   *
   * Note the ordering consequence for melee: the floor is consulted in
   * `engage`, so a blow that then turns out to be wall-blocked has already
   * stamped the floor. That costs the enemies a fraction of a second of
   * pressure they would otherwise have had, which is the direction an error
   * here should point.
   */
  private _hitPlayer(
    damage: number, seesNow: () => boolean, ctx: DungeonTickCtx,
    rateGate: Species | null,
    source: DungeonEnemy, kind: 'melee' | 'projectile',
  ): void {
    if (!seesNow()) { this.blockedByWall++; return; }
    if (rateGate !== null && !this.tokens.mayLand(rateGate)) return;
    ctx.onAttackPlayer(damage, source, kind, this.tokens);
  }

  /**
   * Forget everything about the delve just left.
   *
   * Called from `DungeonManager.exit()`. Without it the token pool would carry
   * contenders that no longer exist into the next dungeon, and the diagnostic
   * counters would accumulate for the whole session — which is exactly what
   * the old `hitGrace` and its counters silently did.
   */
  reset(): void {
    this.tokens.reset();
    this.blockedByWall = 0;
  }

  /** Cached line of sight from `e` to the player. */
  private _seesPlayer(
    e: DungeonEnemy, dtS: number, trueDist: number,
    plx: number, plz: number, layout: DungeonLayout, origin: Vec3,
  ): boolean {
    const s = e as LosState;
    s._losIn = (s._losIn ?? 0) - dtS;
    if (s._losSeen === undefined || s._losIn <= 0) {
      s._losIn = LOS_REFRESH_S;
      // Nothing can act on the answer past LOS_MAX_DIST, so do not pay for it.
      // Reporting `false` there is harmless: the true distance already exceeds
      // every trigger in the roster, and `playerDist` takes the max of the two.
      s._losSeen = trueDist > LOS_MAX_DIST ? false : cellLineOfSight(
        layout.cells, layout.w, layout.h,
        e.x - origin[0], e.z - origin[2], plx, plz);
    }
    return s._losSeen;
  }

  /** Exact line of sight from `e` to another enemy, by id. */
  private _seesEntity(
    e: DungeonEnemy, targetId: string, ctx: DungeonTickCtx,
  ): boolean {
    const t = this.index.get(targetId);
    if (t === null) return false;
    const { layout, origin } = ctx;
    const ok = cellLineOfSight(
      layout.cells, layout.w, layout.h,
      e.x - origin[0], e.z - origin[2],
      t.x - origin[0], t.z - origin[2]);
    if (!ok) this.blockedByWall++;
    return ok;
  }
}

/** Re-exported so callers do not need a second import for the shot shape. */
export type { RangedShot, EntityState };
