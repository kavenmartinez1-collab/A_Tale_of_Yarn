/**
 * DungeonManager — scatters dungeon entrances across the world and owns the
 * enter/exit lifecycle of the single resident interior.
 *
 * Scattering: the world is tiled into 512 m dungeon cells. entranceAt() is a
 * pure function of (WORLD_SEED, dcx, dcz): 60 % of cells roll an entrance,
 * up to 6 jittered candidates each, accepted only above the sand line
 * (heightAt ≥ 3) on gentle slopes (Δh ≤ 2 m over ±2 m). A lazy 3×3-cell
 * registry around the player caches results.
 *
 * Lifecycle: entering builds the interior synchronously (layout → mesh →
 * buffers → collider), swaps controller.world, teleports the player to the
 * spawn cell, and points the orbit camera at the interior collider. Exiting
 * destroys every GPU buffer and restores terrain collision just outside the
 * entrance. Exactly ONE interior may be resident at a time — the slot-arena
 * origin below reuses positions and is only collision-safe under that rule.
 *
 * Interaction (v1): E at an entrance enters; E at the interior exit portal
 * leaves. main.ts polls `interactPrompt` for the HUD and forwards KeyE.
 */

import type { GroundQuery } from '../collision';
import type { Vec3 } from '../math';
import { cellLineOfSight } from '../interior-los';
import type { HeightField } from '../noise';
import type { OrbitCamera } from '../camera';
import type { PlayerController } from '../controller';
import { LIGHTS_BUFFER_SIZE, STRIDE_PROP, type DungeonDraw, type Renderer } from '../renderer';
import { DUNGEON_FIXTURES } from './dungeon-fixtures';
import { layoutDungeon, mix32, CELL_SOLID, type DungeonLayout } from './dungeon-layout';
import { buildInteriorMesh } from './dungeon-mesh';
import {
  buildChestMesh, buildEntranceGlowMesh, buildEntranceStoneMesh,
  buildPortalMesh, buildTorchProps,
} from './dungeon-props';
import { DungeonCollider } from './dungeon-collider';
import { DCELL, entranceSiteAt } from './entrance-site';
import { SPECIES_DEFS } from '../entities/entity-types';
import type { EntityState } from '../entities/entity-manager';
import {
  onEntityDamaged, type DamageSource, type RangedShot,
} from '../entities/animal-ai';
import { rollDrops } from '../entities/animal-drops';
import { itemDef, type GameItemId } from '../items';
import type { DungeonSpec } from './dungeon-spec';
import {
  spawnDungeonEnemies, type DungeonEnemy,
} from './dungeon-enemies';
import { DungeonCombat } from './dungeon-combat';
import { rollBossTintreach, saltChestLoot } from './dungeon-loot';

// Re-exported so `main.ts` (and anything else holding a manager) can keep
// importing the type from here. The spawner itself moved to `dungeon-enemies`
// because that module is pure and can therefore be unit-tested; this file
// imports the renderer and cannot.
export type { DungeonEnemy };
import { mulberry32 } from '../mesh-utils';
import { writeTorchLightSlot } from '../torch';

const INTERACT_DIST = 3;    // E-key reach (m, XZ)
const EXIT_OFFSET = 1.5;    // how far outside the entrance you reappear (m)

// Surface arches render within this range (m). MUST stay inside the terrain
// stream radius (LOAD_RADIUS 6 × 64 = 384 m guaranteed) or arches float in
// the sky over unloaded ground; 360 leaves margin for async chunk gen.
const ENTRANCE_DRAW_DIST = 360;
const NOTICE_MS = 4_000;    // "Found: …" HUD notice lifetime
const TORCH_COLOR: [number, number, number] = [1.0, 0.72, 0.4];
const TORCH_RADIUS = 7;     // point-light falloff radius (m)
/** Slots in the group-2 lights uniform (renderer.ts LIGHTS_BUFFER_SIZE). */
const MAX_INTERIOR_LIGHTS = (LIGHTS_BUFFER_SIZE - 16) / 32;

/**
 * Sync seam through which the AI Director supplies specs. Everything here
 * must be synchronous — the manager builds interiors in one frame. The
 * Director resolves specs asynchronously behind it and persists results;
 * `isReady` gates entry (the "wait at the door" rule) and `generation`
 * bumps let cached entrance names refresh once a spec resolves.
 */
export interface SpecProvider {
  specFor(dcx: number, dcz: number): DungeonSpec;
  /** True when entry is final: persisted spec, or provider gave up. */
  isReady(dcx: number, dcz: number): boolean;
  /** Player is waiting at this door — bump its generation priority. */
  prioritize(dcx: number, dcz: number): void;
  /** Player is entering NOW — freeze whatever spec currently resolves. */
  onMaterialize(dcx: number, dcz: number): void;
  readonly generation: number;
}

export interface Entrance {
  dcx: number;
  dcz: number;
  x: number;
  y: number;
  z: number;
  name: string;
}

interface ResidentChest {
  cell: [number, number];
  /**
   * Widened from `ItemId` to `GameItemId`: `ItemId` is the small hand-curated
   * set an AI Director may name in a spec, and `dungeon-loot.ts` adds things a
   * Director is deliberately not allowed to name — healing, and the Tintreach
   * arrows. `ItemId[]` is assignable to `GameItemId[]`, so the spec's own loot
   * still drops in unchanged.
   */
  items: GameItemId[];
  /** Object uniform buffer — w rewritten wood → stone when looted. */
  objectBuffer: GPUBuffer;
  opened: boolean;
}

interface Resident {
  entrance: Entrance;
  layout: DungeonLayout;
  collider: DungeonCollider;
  origin: Vec3;
  draws: DungeonDraw[];
  chests: ResidentChest[];
  buffers: GPUBuffer[];
  /** Enemies active in this dungeon; emptied when all are killed. */
  enemies: DungeonEnemy[];
  /**
   * World-space torch lights, in CPU form. The same data goes into the
   * group-2 uniform the dungeon pipeline reads, but characters and animals
   * render on their own pipelines and cannot see that buffer — without a
   * CPU-side copy to feed the renderer's world-light set, anything standing
   * in a dungeon renders as a pure black silhouette.
   */
  torchLights: WorldLight[];
  /**
   * The group-2 lights uniform and its CPU mirror, kept so a HELD torch can be
   * written into the spare slot every frame. Dungeon surfaces read only this
   * buffer — the world-light set lights characters underground but not the
   * walls — so without a live handle on it a carried torch lights the goblin
   * and leaves the corridor black. See torch.ts `writeTorchLightSlot`.
   */
  lightsBuffer: GPUBuffer;
  lightsData: Float32Array<ArrayBuffer>;
  /** Wall torches baked in on entry; the player's slot goes after these. */
  fixedLightCount: number;
  /** Whether the spare slot currently holds a light, so still frames skip. */
  playerTorchOn: boolean;
}

/** A point light in world space, shared with the renderer's world-light set. */
export interface WorldLight {
  pos: Vec3;
  color: Vec3;
  radius: number;
  /**
   * Size of the billboard flame render/fire-fx.ts should draw here: 1 is a
   * wall-torch head, ~0.4 a candle, ~1.7 a hearth. Omitted means "no visible
   * flame" (a lit window, say). Deriving it from `radius` instead was wrong —
   * a dungeon torch and a cottage hearth share a radius of 7.
   */
  flameScale?: number;
}

interface EntranceProps {
  stoneBuffer: GPUBuffer;
  stoneCount: number;
  glowBuffer: GPUBuffer;
  glowCount: number;
  lightsBindGroup: GPUBindGroup;
  /** Per-entrance draw pairs, keyed "dcx,dcz". */
  draws: Map<string, { entrance: Entrance; draws: DungeonDraw[] }>;
}

export class DungeonManager {
  private readonly cache = new Map<string, Entrance | null>();
  private resident: Resident | null = null;
  private prompt: { label: string; act: () => void } | null = null;
  private entranceProps: EntranceProps | null = null;
  /** Chests opened this session, keyed "dcx,dcz" → chest indices. */
  private readonly openedChests = new Map<string, Set<number>>();
  private notice: { text: string; until: number } | null = null;
  private lastProviderGeneration = 0;
  chestsOpened = 0;
  /**
   * Loot sink — chests AND enemy drops (main.ts deposits into the pack).
   *
   * Widened from `ItemId[]` to `GameItemId[]` so enemy drops can use the same
   * sink: `ItemId` is the small hand-curated set a Director may name in a
   * spec, while a drop table reaches the whole item catalogue. `ItemId[]` is
   * assignable to `GameItemId[]`, so the existing chest call site and the
   * existing `main.ts` handler are both unchanged.
   */
  onLoot: ((items: GameItemId[]) => void) | null = null;
  /**
   * A dungeon enemy is loosing a ranged attack. Optional: when unset, ranged
   * attackers still hit for their damage, they just have no visible arrow.
   * See the exact `main.ts` wiring in the handover notes.
   */
  onEnemyShot: ((e: EntityState, shot: RangedShot) => void) | null = null;

  /**
   * Line-of-sight gating, the player's damage grace window and the shared
   * mob-vs-mob index for the resident dungeon. See `dungeon-combat.ts`.
   */
  private readonly combat = new DungeonCombat();
  /**
   * Last sim time seen, so mob-vs-mob kills can stamp a corpse timer.
   *
   * Written by `tickEnemies` every frame the player is inside. It used to be
   * written ONLY by `attackDungeonEnemy` and `notifyPlayerKill` — both player
   * paths — so in a delve where the player had not yet killed anything it was
   * still 0. Every mob-vs-mob corpse was therefore stamped `deadAtS = 0`,
   * which the renderer's `simTime - deadAtS > DEAD_SHOW_S` test reads as
   * "died twenty seconds ago", and the body vanished on the frame it fell.
   * Two goblins fighting each other in front of the player produced a corpse
   * that was never once drawn.
   */
  private lastSimTime = 0;
  /** Corpses already paid out, so a kill cannot be banked twice. */
  private readonly paidKills = new Set<string>();

  constructor(
    private readonly renderer: Renderer,
    private readonly heightField: HeightField,
    private readonly terrain: GroundQuery,
    private readonly controller: PlayerController,
    private readonly camera: OrbitCamera,
    private readonly seed: number,
    private readonly specProvider: SpecProvider | null = null,
  ) {}

  /** Melee tokens currently held by dungeon enemies — the music engine's
   *  combat signal underground. The pool lives in dungeon-combat.ts behind
   *  this manager; without a passthrough, dungeon fights read as calm
   *  forever (MUSIC_HOOK.md's flagged gap). */
  get meleeHeld(): number { return this.combat.tokens.heldCount; }

  get isInside(): boolean {
    return this.resident !== null;
  }

  /** Torch lights of the resident interior, for the renderer's world-light
   *  set — this is what lights characters and animals underground. */
  activeLights(): readonly WorldLight[] {
    return this.resident?.torchLights ?? [];
  }

  /**
   * Put the player's held torch into the interior's spare light slot (or clear
   * it). Called every frame while inside; a no-op when outside.
   */
  setPlayerTorch(light: { pos: Vec3; radius: number } | null): void {
    const r = this.resident;
    if (r === undefined || r === null) return;
    if (light === null && !r.playerTorchOn) return;
    writeTorchLightSlot(this.renderer.device, r.lightsBuffer, r.lightsData,
      r.fixedLightCount, MAX_INTERIOR_LIGHTS, light);
    r.playerTorchOn = light !== null;
  }

  get interactPrompt(): string | null {
    return this.prompt?.label ?? null;
  }

  /** Live enemies inside the current dungeon; empty when outside or all killed. */
  dungeonEnemies(): DungeonEnemy[] {
    return this.resident?.enemies ?? [];
  }

  // -------------------------------------------------------------------------
  // Geometry queries for the PLAYER'S attacks
  //
  // `dungeon-combat.ts` gates every blow an ENEMY throws on `cellLineOfSight`,
  // and it has done since the wall-hitting bug was found. Nothing gated the
  // blows going the other way: the player's 3.2 m melee swing was a distance
  // and a facing dot with no geometry test at all, and arrows were integrated
  // against a heightfield that reads -1e9 underground, so they flew through
  // walls, floors and ceilings alike and only ever stopped in a body.
  //
  // These three expose the resident dungeon's cells to `main.ts`, which owns
  // both of those call sites. They deliberately do NOT re-implement the sight
  // march — `seesFrom` is the same `cellLineOfSight` the enemy side uses, so
  // the two directions cannot drift apart. There is no third implementation.
  // -------------------------------------------------------------------------

  /** Floor plane of the resident dungeon, or null when outside. */
  get floorY(): number | null {
    return this.resident === null ? null : this.resident.origin[1];
  }

  /**
   * The sim time a mob-vs-mob corpse would be stamped with right now.
   *
   * Exposed because the defect it pins is otherwise invisible from outside.
   * `_hurtEnemy` stamps `deadAtS = lastSimTime`, and `lastSimTime` used to be
   * written ONLY by the player's own damage paths — so in a delve where the
   * player had not yet killed anything it was still 0, every mob-vs-mob corpse
   * was stamped "died at the start of the game", and the renderer's
   * `simTime - deadAtS > DEAD_SHOW_S` test culled the body on the frame it
   * fell. Staging a real mob-vs-mob kill needs two factions in one room, which
   * most generated dungeons do not have; this is the same fact, directly.
   */
  get corpseStampTime(): number {
    return this.lastSimTime;
  }

  /**
   * The resident cell grid, for harnesses. Null when outside.
   *
   * A probe that wants to prove "a swing through a wall does nothing, the same
   * swing through a doorway lands" has to be able to FIND a wall, and guessing
   * from screenshots is how a test ends up asserting the thing it happened to
   * hit rather than the thing it meant.
   */
  debugGrid(): { w: number; h: number; origin: Vec3; cells: Uint8Array } | null {
    const res = this.resident;
    return res === null ? null : {
      w: res.layout.w, h: res.layout.h,
      origin: res.origin, cells: res.layout.cells,
    };
  }

  /**
   * True when nothing solid stands between two WORLD-space XZ points.
   *
   * Returns true when there is no resident dungeon: outdoors there are no
   * cells to block anything, and a caller that forgot to check `isInside`
   * should get "no wall in the way", not "everything is walled off".
   */
  seesFrom(x0: number, z0: number, x1: number, z1: number): boolean {
    const res = this.resident;
    if (res === null) return true;
    const o = res.origin;
    return cellLineOfSight(
      res.layout.cells, res.layout.w, res.layout.h,
      x0 - o[0], z0 - o[2], x1 - o[0], z1 - o[2]);
  }

  /**
   * True when a world point is inside dungeon masonry — a wall cell, or above
   * this cell's ceiling.
   *
   * The FLOOR is deliberately not tested here. Projectiles already plant on the
   * ground through `heightAt`, which main.ts feeds `floorY` underground, and
   * having two mechanisms answer "you hit the floor" is how they end up
   * disagreeing about where the floor is.
   */
  solidAt(x: number, y: number, z: number): boolean {
    const res = this.resident;
    if (res === null) return false;
    const { layout, origin } = res;
    const cx = Math.floor(x - origin[0]);
    const cz = Math.floor(z - origin[2]);
    if (cx < 0 || cz < 0 || cx >= layout.w || cz >= layout.h) return true;
    if (layout.cells[cz * layout.w + cx] === CELL_SOLID) return true;
    return y > origin[1] + layout.ceilY[cz * layout.w + cx];
  }

  /**
   * Distance along a ray to the first masonry surface, or `maxDist`.
   *
   * The aim ray needs this for the same reason the arrow does: `resolveAim`
   * marches to 160 m and picks the first creature it passes, and underground
   * that let the crosshair name — and the Tintreach hitscan then hit — a
   * skeleton three rooms away through solid rock. Clamping the ray's own
   * `maxDist` to the wall is enough to fix both, because every candidate test
   * inside `resolveAim` is bounded by it.
   *
   * 0.2 m step, matching `cellLineOfSight`: cells are 1 m, so this cannot step
   * over one. It runs at the reticle's 15 Hz, not per frame.
   */
  rayWallDist(
    origin: readonly [number, number, number],
    dir: readonly [number, number, number],
    maxDist: number,
  ): number {
    if (this.resident === null) return maxDist;
    const STEP = 0.2;
    const n = Math.ceil(maxDist / STEP);
    for (let i = 1; i <= n; i++) {
      const t = Math.min(maxDist, i * STEP);
      if (this.solidAt(
        origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t)) {
        // Back off one step so the returned point is in open air, not inside
        // the wall — the caller converges a shot on it.
        return Math.max(0, t - STEP);
      }
    }
    return maxDist;
  }

  /**
   * Advance all dungeon enemy AIs by dtS seconds.
   * Call from main.ts when dungeonManager.isInside.
   * Enemies are clamped to their room bounds so they can't escape through walls.
   *
   * `simTime` is not used by the tick itself — it is here so `lastSimTime` is
   * always current when a mob-vs-mob kill needs to stamp a corpse. See
   * `_hurtEnemy`.
   */
  tickEnemies(
    dtS: number,
    playerX: number,
    playerZ: number,
    simTime: number,
    onAttackPlayer: (damage: number) => void,
  ): void {
    const res = this.resident;
    if (res === null) return;
    this.lastSimTime = simTime;
    // The loop itself lives in `dungeon-combat.ts` because this file imports
    // the renderer and therefore cannot be unit-tested in Node — and the loop
    // that decides when the player takes damage is the last thing that should
    // be untestable. Everything below is adapter: turning the pure module's
    // callbacks back into this class's own damage bookkeeping.
    this.combat.tick(res.enemies, dtS, playerX, playerZ, {
      layout: res.layout,
      origin: res.origin,
      onAttackPlayer,
      onAttackEntity: (src, targetId, damage) => {
        const t = res.enemies.find((en) => en.id === targetId);
        if (t === undefined || t.mode === 'dead') return;
        this._hurtEnemy(t, damage,
          { id: src.id, kind: 'entity', x: src.x, z: src.z });
      },
      // Ranged attackers (the goblin archer) route through here. When the
      // caller has not wired a projectile renderer, `onRangedAttack` is absent
      // and `animal-ai` falls back to `onAttackPlayer` — so the archer is a
      // working enemy before a single arrow is drawn.
      onRangedAttack: this.onEnemyShot === null ? undefined : (src, shot) => {
        this.onEnemyShot?.(src, shot);
      },
    });
  }

  /** Apply damage to a dungeon enemy from another creature (never the player). */
  private _hurtEnemy(
    e: DungeonEnemy, damage: number, from: DamageSource,
  ): void {
    e.hp = Math.max(0, e.hp - damage);
    if (e.hp <= 0) {
      e.mode = 'dead';
      // A corpse timer but NO drops: a mob-vs-mob kill is not the player's, so
      // it must not pay them — but it must still leave a body that lies there
      // for the loot window like any other. `lastSimTime` is now written every
      // tick rather than only by the player's own damage paths; see its
      // declaration for what that was costing.
      e.deadAtS = this.lastSimTime;
      return;
    }
    onEntityDamaged(e, from);
  }

  /**
   * Apply damage to a dungeon enemy by id.
   * Returns true if the entity was found and alive.
   */
  attackDungeonEnemy(id: string, damage: number, simTime: number): boolean {
    const res = this.resident;
    if (res === null) return false;
    this.lastSimTime = simTime;
    const e = res.enemies.find((en) => en.id === id);
    if (!e || e.mode === 'dead') return false;
    e.hp = Math.max(0, e.hp - damage);
    if (e.hp <= 0) {
      e.mode = 'dead';
      e.deadAtS = simTime;
      this.paidKills.add(e.id);
      this._onEnemyKilled(e);
    } else {
      // No `from` — this is the player's blow, so the reaction is the original
      // one: it turns on the player rather than starting a mob-vs-mob hunt.
      onEntityDamaged(e);
    }
    return true;
  }

  /**
   * The player killed a dungeon enemy somewhere other than through
   * `attackDungeonEnemy`. Pay it out.
   *
   * WHY THIS EXISTS: `attackDungeonEnemy` is the only path that pays a kill,
   * and in real gameplay NOTHING CALLS IT. Its one call site is inside
   * `window.__gameDebug`. The player's actual melee and the player's actual
   * arrows both find the enemy in `dungeonManager.dungeonEnemies()` and
   * decrement `e.hp` in place, so `_onEnemyKilled` never ran during play:
   * dungeon corpses paid nothing, the "cleared" notice never appeared, and
   * neither did the boss's Tintreach arrows. Every drop table pointing at a
   * dungeon species was dead weight.
   *
   * Fixing it properly means routing those two call sites through the manager,
   * which lives in `main.ts`. This is the seam that lets that be a one-line
   * change at each site rather than a restructure.
   *
   * Idempotent: calling it twice for the same corpse pays once. Two call sites
   * that both fire on an overkill frame is exactly the kind of thing that
   * silently doubles loot.
   */
  notifyPlayerKill(id: string, simTime: number): void {
    const res = this.resident;
    if (res === null) return;
    if (this.paidKills.has(id)) return;
    const e = res.enemies.find((en) => en.id === id);
    if (e === undefined || e.mode !== 'dead') return;
    this.paidKills.add(id);
    this.lastSimTime = simTime;
    this._onEnemyKilled(e);
  }

  /**
   * Pay out a player kill and check whether the dungeon is finished.
   *
   * Dungeon enemies used to drop nothing at all: `tryLootDeadAnimal` in
   * `main.ts` is gated behind `!dungeonManager.isInside`, so clearing a room
   * paid exactly zero and the only reason to fight anything was that it was in
   * the way. Drops are rolled here instead, through the same `rollDrops`
   * table the overworld uses and straight into the existing chest-loot sink,
   * so no new plumbing crosses into `main.ts`.
   */
  private _onEnemyKilled(e: DungeonEnemy): void {
    const res = this.resident;
    if (res === null) return;
    // Seeded off the entity id so a given goblin always drops the same thing —
    // consistent with every other deterministic roll in the dungeon.
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < e.id.length; i++) {
      h ^= e.id.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    const drops = rollDrops(e.species, mulberry32(h));
    const items: GameItemId[] = [];
    for (const d of drops) {
      for (let i = 0; i < d.count; i++) items.push(d.id);
    }
    // The Tintreach arrows. Rolled here rather than in `animal-drops.ts`
    // because the table there keys off SPECIES, and what earns these is not
    // "was a dread_king" but "was the thing at the bottom of a dungeon" — see
    // `dungeon-loot.ts` for the rate and the reasoning behind it.
    if (e.boss === true) items.push(...rollBossTintreach(e.id));
    if (items.length > 0) this.onLoot?.(items);

    const name = SPECIES_DEFS[e.species].name;
    if (e.boss === true) {
      this.notice = {
        text: `${name} slain — ${res.entrance.name} is broken`,
        until: performance.now() + NOTICE_MS * 2,
      };
      return;
    }
    // "Cleared" is a real state worth telling the player about: it is the
    // difference between a dungeon being a corridor with loot in it and being
    // somewhere you finished.
    const alive = res.enemies.filter((en) => en.mode !== 'dead').length;
    if (alive === 0) {
      this.notice = {
        text: `${res.entrance.name} cleared`,
        until: performance.now() + NOTICE_MS,
      };
    }
  }

  /** Live enemies remaining, and the total spawned. For the HUD and tests. */
  enemyCounts(): { alive: number; total: number; bossAlive: boolean } {
    const res = this.resident;
    if (res === null) return { alive: 0, total: 0, bossAlive: false };
    let alive = 0;
    let bossAlive = false;
    for (const e of res.enemies) {
      if (e.mode === 'dead') continue;
      alive++;
      if (e.boss === true) bossAlive = true;
    }
    return { alive, total: res.enemies.length, bossAlive };
  }

  /** Number of discovered (cached, present) entrances so far. */
  get dungeonCount(): number {
    let n = 0;
    for (const e of this.cache.values()) if (e !== null) n++;
    return n;
  }

  /** Transient HUD notice ("Found: …"), or null once expired. */
  get noticeText(): string | null {
    if (this.notice !== null && performance.now() < this.notice.until) {
      return this.notice.text;
    }
    return null;
  }

  /** Inside: interior + props. Outside: nearby surface entrance arches. */
  draws(): DungeonDraw[] {
    if (this.resident !== null) return this.resident.draws;
    if (this.entranceProps === null) return [];
    const p = this.controller.pos;
    const out: DungeonDraw[] = [];
    for (const { entrance, draws } of this.entranceProps.draws.values()) {
      if (Math.hypot(p[0] - entrance.x, p[2] - entrance.z) <= ENTRANCE_DRAW_DIST) {
        out.push(...draws);
      }
    }
    return out;
  }

  /** Per-tick: refresh the entrance registry + the current interact prompt. */
  update(pos: Vec3): void {
    // Director specs resolve async: refresh cached entrance names on bump.
    if (this.specProvider !== null
        && this.specProvider.generation !== this.lastProviderGeneration) {
      this.lastProviderGeneration = this.specProvider.generation;
      for (const e of this.cache.values()) {
        if (e !== null) e.name = this.specFor(e.dcx, e.dcz).name;
      }
    }
    if (this.resident === null) {
      const dcx = Math.floor(pos[0] / DCELL);
      const dcz = Math.floor(pos[2] / DCELL);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const e = this.entrance(dcx + dx, dcz + dz);
          if (e !== null) this.ensureEntranceDraws(e);
        }
      }
    }
    this.prompt = this.findInteraction(pos);
  }

  /** Fire the current prompt's action (bound to KeyE in main.ts). */
  tryInteract(): void {
    this.prompt?.act();
  }

  // --- scattering ----------------------------------------------------------

  /** Pure per-cell entrance roll (entrance-site.ts); memoized in `cache`. */
  private entrance(dcx: number, dcz: number): Entrance | null {
    const key = `${dcx},${dcz}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;

    const site = entranceSiteAt(this.seed, dcx, dcz,
      (x, z) => this.heightField.heightAt(x, z));
    const found: Entrance | null = site === null ? null
      : { dcx, dcz, ...site, name: this.specFor(dcx, dcz).name };
    this.cache.set(key, found);
    return found;
  }

  private specFor(dcx: number, dcz: number): DungeonSpec {
    return this.specProvider?.specFor(dcx, dcz)
      ?? DUNGEON_FIXTURES[mix32(this.seed, dcx, dcz) % DUNGEON_FIXTURES.length];
  }

  /** Lazily create the shared arch meshes + this entrance's draw pair. */
  private ensureEntranceDraws(e: Entrance): void {
    if (this.entranceProps === null) {
      const stone = buildEntranceStoneMesh();
      const glow = buildEntranceGlowMesh();
      const make = (label: string, data: Float32Array<ArrayBuffer>) => {
        const buffer = this.renderer.device.createBuffer({
          label,
          size: data.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.renderer.device.queue.writeBuffer(buffer, 0, data);
        return buffer;
      };
      // Zeroed lights: the surface shader path never reads them, but the
      // dungeon pipeline still requires a group-2 binding.
      const zeroLights = this.renderer.device.createBuffer({
        label: 'entrance-zero-lights',
        size: LIGHTS_BUFFER_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.entranceProps = {
        stoneBuffer: make('entrance-stone', stone),
        stoneCount: stone.length / (STRIDE_PROP / 4),
        glowBuffer: make('entrance-glow', glow),
        glowCount: glow.length / (STRIDE_PROP / 4),
        lightsBindGroup: this.renderer.createLightsBindGroup(zeroLights),
        draws: new Map(),
      };
    }
    const key = `${e.dcx},${e.dcz}`;
    const p = this.entranceProps;
    if (p.draws.has(key)) return;
    const stone = this.renderer.createObjectBindGroup(e.x, e.y, e.z, 100);
    const glow = this.renderer.createObjectBindGroup(e.x, e.y, e.z, 103);
    p.draws.set(key, {
      entrance: e,
      draws: [
        {
          draw: {
            vertexBuffer: p.stoneBuffer, indexBuffer: null, count: p.stoneCount,
            bindGroup: stone.bindGroup, shadowBindGroup: stone.shadowBindGroup,
          },
          lightsBindGroup: p.lightsBindGroup,
        },
        {
          draw: {
            vertexBuffer: p.glowBuffer, indexBuffer: null, count: p.glowCount,
            bindGroup: glow.bindGroup, shadowBindGroup: glow.shadowBindGroup,
          },
          lightsBindGroup: p.lightsBindGroup,
        },
      ],
    });
  }

  // --- interaction ---------------------------------------------------------

  private findInteraction(pos: Vec3): { label: string; act: () => void } | null {
    if (this.resident !== null) {
      const { layout, origin, chests } = this.resident;
      // Nearest of: exit portal + unopened chests, within reach.
      let best: { label: string; act: () => void } | null = null;
      let bestD = INTERACT_DIST;
      // Reach is XZ distance AND line of sight. Cells are 1 m and a wall is one
      // cell, so a 3 m radius reaches straight through two of them: a chest one
      // room over prompted, and opening it worked, because neither the prompt
      // nor the action ever looked at the layout.
      const lx = pos[0] - origin[0];
      const lz = pos[2] - origin[2];
      const sees = (tx: number, tz: number): boolean =>
        cellLineOfSight(layout.cells, layout.w, layout.h, lx, lz, tx, tz);

      const px = layout.exitPortalCell[0] + 0.5;
      const pz = layout.exitPortalCell[1] + 0.5;
      const portalD = Math.hypot(lx - px, lz - pz);
      if (portalD <= bestD && sees(px, pz)) {
        bestD = portalD;
        best = { label: 'Press E to leave the dungeon', act: () => this.exit() };
      }
      for (const chest of chests) {
        if (chest.opened) continue;
        const cx = chest.cell[0] + 0.5;
        const cz = chest.cell[1] + 0.5;
        const d = Math.hypot(lx - cx, lz - cz);
        if (d <= bestD && sees(cx, cz)) {
          bestD = d;
          best = { label: 'Press E to open the chest', act: () => this.openChest(chest) };
        }
      }
      return best;
    }
    for (const e of this.cache.values()) {
      if (e === null) continue;
      if (Math.hypot(pos[0] - e.x, pos[2] - e.z) <= INTERACT_DIST) {
        return {
          label: `Press E to enter ${e.name}`,
          act: () => {
            // Wait at the door until the Director's spec is final.
            if (this.specProvider !== null
                && !this.specProvider.isReady(e.dcx, e.dcz)) {
              this.specProvider.prioritize(e.dcx, e.dcz);
              this.notice = {
                text: 'The Director dreams… (the door will open soon)',
                until: performance.now() + NOTICE_MS,
              };
              return;
            }
            this.enter(e);
          },
        };
      }
    }
    return null;
  }

  private openChest(chest: ResidentChest): void {
    if (this.resident === null || chest.opened) return;
    chest.opened = true;
    this.chestsOpened++;
    const e = this.resident.entrance;
    const key = `${e.dcx},${e.dcz}`;
    let opened = this.openedChests.get(key);
    if (opened === undefined) {
      opened = new Set();
      this.openedChests.set(key, opened);
    }
    opened.add(this.resident.chests.indexOf(chest));
    // Palette swap wood → stone: the looted chest turns dull.
    const [x, z] = chest.cell;
    const o = this.resident.origin;
    this.renderer.device.queue.writeBuffer(chest.objectBuffer, 0,
      new Float32Array([o[0] + x + 0.5, o[1], o[2] + z + 0.5, 0]));
    // Display names, not ids. `chest.items` now carries things whose id reads
    // badly raw — "arrow" for a quiver of Tintreach bolts, in particular — and
    // repeats are collapsed to a count so a boss cache does not print the same
    // word nine times.
    const tally = new Map<GameItemId, number>();
    for (const id of chest.items) tally.set(id, (tally.get(id) ?? 0) + 1);
    const found = [...tally].map(([id, n]) =>
      n > 1 ? `${itemDef(id).name} x${n}` : itemDef(id).name).join(', ');
    this.notice = { text: `Found: ${found}`, until: performance.now() + NOTICE_MS };
    this.onLoot?.(chest.items);
  }

  // --- lifecycle -----------------------------------------------------------

  private enter(e: Entrance): void {
    if (this.resident !== null) return;
    // Freeze the spec for this cell so re-entry reproduces this dungeon.
    this.specProvider?.onMaterialize(e.dcx, e.dcz);
    const spec = this.specFor(e.dcx, e.dcz);
    const layout = layoutDungeon(spec, mix32(this.seed, e.dcx, e.dcz));

    // Slot arena: float32-safe origins that never meet streamed terrain.
    // Reuse across (dcx, dcz) is safe ONLY because one interior is resident.
    const origin: Vec3 = [
      (((e.dcx % 8) + 8) % 8) * DCELL,
      -300,
      (((e.dcz % 8) + 8) % 8) * DCELL,
    ];

    const buffers: GPUBuffer[] = [];
    const makeVerts = (label: string, data: Float32Array<ArrayBuffer>): GPUBuffer => {
      const buffer = this.renderer.device.createBuffer({
        label,
        size: data.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.renderer.device.queue.writeBuffer(buffer, 0, data);
      buffers.push(buffer);
      return buffer;
    };
    const makeObject = (w: number, x = origin[0], y = origin[1], z = origin[2]) => {
      const { bindGroup, buffer, shadowBindGroup } = this.renderer.createObjectBindGroup(x, y, z, w);
      buffers.push(buffer);
      return { bindGroup, buffer, shadowBindGroup };
    };

    // Torch point lights: count + pos/colorRadius per torch (shader group 2).
    const torches = buildTorchProps(layout);
    const lightsData = new Float32Array(LIGHTS_BUFFER_SIZE / 4);
    lightsData[0] = torches.lights.length;
    const torchLights: WorldLight[] = [];
    torches.lights.forEach(([lx, ly, lz], i) => {
      const base = 4 + i * 8;
      const wx = origin[0] + lx, wy = origin[1] + ly, wz = origin[2] + lz;
      lightsData[base + 0] = wx;
      lightsData[base + 1] = wy;
      lightsData[base + 2] = wz;
      lightsData.set(TORCH_COLOR, base + 4);
      lightsData[base + 7] = TORCH_RADIUS;
      torchLights.push({
        pos: [wx, wy, wz],
        // The world-light path has no ambient floor behind it, so torches
        // need more punch here than the dungeon shader's own copy.
        color: [TORCH_COLOR[0] * 2.4, TORCH_COLOR[1] * 2.4, TORCH_COLOR[2] * 2.4],
        radius: TORCH_RADIUS,
        flameScale: 1,   // every dungeon light is a wall torch
      });
    });
    const lightsBuffer = this.renderer.device.createBuffer({
      label: 'dungeon-lights',
      size: LIGHTS_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.renderer.device.queue.writeBuffer(lightsBuffer, 0, lightsData);
    buffers.push(lightsBuffer);
    const lightsBindGroup = this.renderer.createLightsBindGroup(lightsBuffer);

    // Interior shell + per-palette prop batches, all sharing the lights BG.
    const draws: DungeonDraw[] = [];
    const addDraw = (
      data: Float32Array<ArrayBuffer>, label: string,
      obj: { bindGroup: GPUBindGroup; shadowBindGroup: GPUBindGroup },
    ) => {
      if (data.length === 0) return;
      draws.push({
        draw: {
          vertexBuffer: makeVerts(label, data),
          indexBuffer: null,
          count: data.length / (STRIDE_PROP / 4),
          bindGroup: obj.bindGroup,
          shadowBindGroup: obj.shadowBindGroup,
        },
        lightsBindGroup,
      });
    };
    addDraw(buildInteriorMesh(layout), `dungeon-mesh(${e.dcx},${e.dcz})`, makeObject(0));
    addDraw(torches.wood, 'dungeon-torch-wood', makeObject(1));
    addDraw(torches.flame, 'dungeon-torch-flame', makeObject(2));
    addDraw(buildPortalMesh(layout), 'dungeon-exit-portal', makeObject(3));

    // Chests: shared mesh, per-chest object uniform (position + palette).
    const dkey = `${e.dcx},${e.dcz}`;
    const chestVerts = buildChestMesh();
    const chestBuffer = layout.chests.length > 0
      ? makeVerts('dungeon-chest', chestVerts) : null;
    // Healing, and the Tintreach cache. Deterministic in (seed, dcx, dcz), so
    // re-entering a dungeon finds the same chest holding the same thing.
    const salt = saltChestLoot(layout, spec, this.seed, e.dcx, e.dcz);
    const chests: ResidentChest[] = layout.chests.map((c, i) => {
      const opened = this.openedChests.get(dkey)?.has(i) ?? false;
      const { bindGroup, buffer, shadowBindGroup } = makeObject(
        opened ? 0 : 1,
        origin[0] + c.cell[0] + 0.5, origin[1], origin[2] + c.cell[1] + 0.5);
      draws.push({
        draw: {
          vertexBuffer: chestBuffer!,
          indexBuffer: null,
          count: chestVerts.length / (STRIDE_PROP / 4),
          bindGroup,
          shadowBindGroup,
        },
        lightsBindGroup,
      });
      return {
        cell: c.cell,
        items: [...c.items, ...(salt[i] ?? [])],
        objectBuffer: buffer,
        opened,
      };
    });

    const collider = new DungeonCollider(layout, origin);
    const enemies = spawnDungeonEnemies(layout, spec, origin, this.seed, e.dcx, e.dcz);
    this.resident = {
      entrance: e, layout, collider, origin, draws, chests, buffers, enemies,
      torchLights,
      lightsBuffer, lightsData,
      fixedLightCount: torches.lights.length,
      playerTorchOn: false,
    };

    this.controller.world = collider;
    this.controller.pos = [
      origin[0] + layout.spawnCell[0] + 0.5,
      origin[1],
      origin[2] + layout.spawnCell[1] + 0.5,
    ];
    this.controller.velY = 0;
    this.camera.interior = collider;
  }

  /**
   * Tear down the interior and put the player back on the surface, whether or
   * not they walked out. Death used to skip this: `doRespawn` moved the player
   * to the spawn point but left `resident` set, so the renderer stayed in
   * dungeon mode, `controller.world` stayed bound to dungeon collision and the
   * camera stayed in interior mode — you respawned into an empty void with no
   * terrain and no sky. The caller may override the position afterwards.
   */
  forceExit(): void {
    this.exit();
  }

  private exit(): void {
    if (this.resident === null) return;
    const e = this.resident.entrance;
    // Clear enemy state on exit — re-entry will respawn fresh enemies, so the
    // paid-kill ledger has to go with them or the same ids would be refused a
    // payout on the next delve.
    this.resident.enemies = [];
    this.paidKills.clear();
    // Same reasoning one line up, applied to the combat state: attack tokens
    // are keyed by enemy id, and those ids die with the delve. `DungeonCombat`
    // is held for the manager's whole life (not per dungeon, whatever its old
    // comment claimed), so without this the next delve inherits contenders for
    // enemies that no longer exist.
    this.combat.reset();
    for (const b of this.resident.buffers) b.destroy();
    this.resident = null;

    this.controller.world = this.terrain;
    const ex = e.x;
    const ez = e.z + EXIT_OFFSET;
    this.controller.pos = [ex, this.heightField.heightAt(ex, ez) + 0.1, ez];
    this.controller.velY = 0;
    this.camera.interior = null;
  }

  // --- debug hooks (e2e) ---------------------------------------------------

  /** Nearest discovered/discoverable entrance within ±5 dungeon cells. */
  debugNearestEntrance(): Entrance | null {
    const p = this.controller.pos;
    const dcx0 = Math.floor(p[0] / DCELL);
    const dcz0 = Math.floor(p[2] / DCELL);
    let best: Entrance | null = null;
    let bestD = Infinity;
    for (let dz = -5; dz <= 5; dz++) {
      for (let dx = -5; dx <= 5; dx++) {
        const e = this.entrance(dcx0 + dx, dcz0 + dz);
        if (e === null) continue;
        const d = Math.hypot(p[0] - e.x, p[2] - e.z);
        if (d < bestD) {
          bestD = d;
          best = e;
        }
      }
    }
    return best;
  }

  /** Enter the nearest entrance within ±5 dungeon cells. Returns success. */
  debugEnterNearest(): boolean {
    if (this.resident !== null) return true;
    const best = this.debugNearestEntrance();
    if (best === null) return false;
    this.enter(best);
    return true;
  }

  /** Teleport the player to the nearest surface entrance (E-key reach). */
  debugTeleportToNearestEntrance(): boolean {
    if (this.resident !== null) return false;
    const best = this.debugNearestEntrance();
    if (best === null) return false;
    this.controller.pos = [best.x, best.y + 0.1, best.z];
    this.controller.velY = 0;
    return true;
  }

  /** Teleport next to the nearest unopened chest. Returns success. */
  debugTeleportToNearestChest(): boolean {
    if (this.resident === null) return false;
    const { chests, origin } = this.resident;
    const p = this.controller.pos;
    let best: ResidentChest | null = null;
    let bestD = Infinity;
    for (const chest of chests) {
      if (chest.opened) continue;
      const d = Math.hypot(
        p[0] - (origin[0] + chest.cell[0] + 0.5),
        p[2] - (origin[2] + chest.cell[1] + 0.5));
      if (d < bestD) {
        bestD = d;
        best = chest;
      }
    }
    if (best === null) return false;
    this.controller.pos = [
      origin[0] + best.cell[0] + 0.5,
      origin[1],
      origin[2] + best.cell[1] + 0.5,
    ];
    this.controller.velY = 0;
    return true;
  }

  /** Teleport the player onto the resident interior's exit portal cell. */
  debugTeleportToExit(): void {
    if (this.resident === null) return;
    const { layout, origin } = this.resident;
    this.controller.pos = [
      origin[0] + layout.exitPortalCell[0] + 0.5,
      origin[1],
      origin[2] + layout.exitPortalCell[1] + 0.5,
    ];
    this.controller.velY = 0;
  }
}
