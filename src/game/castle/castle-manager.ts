/**
 * CastleManager — owns Castle Vhaeron's GPU buffers, its collision layer, the
 * starter chest, and the opening's alarm state.
 *
 * ## Why the castle is not an "interior"
 *
 * `DungeonManager` and `BuildingManager` teleport the player to a slot arena at
 * y = -300 and swap `controller.world` wholesale. That model cannot express
 * this opening: the player has to run *out* of the breach into the real
 * wilderness, and has to be able to look up and see a dragon circling the
 * towers while they do it. Both stop being possible the moment the castle is
 * somewhere else.
 *
 * So the castle is ordinary world geometry on a motte, and its collision is a
 * DECORATOR over the terrain `GroundQuery` — the same shape as
 * `settlementGround` in `settlement-collider.ts`, except height-aware. Nothing
 * in `main.ts`'s `inDungeon` gate needs to change, terrain keeps streaming, the
 * sky keeps rendering, and there is no mode to get stuck in.
 *
 * ## Buffer lifetime
 *
 * `SettlementManager` never evicts — a castle town is ~1.7 MB of vertex buffer
 * and every one ever visited stays resident (`settlement-manager.ts:9-11`).
 * This does not repeat that: every buffer, vertex and uniform alike, is
 * captured in `buffers` and destroyed on eviction. Eviction is deliberately far
 * outside the draw distance, because rebuilding costs a visible hitch and a
 * player pacing the boundary should not pay it twice a second.
 */

import type { Renderer, DungeonDraw } from '../renderer';
import { STRIDE_PROP, LIGHTS_BUFFER_SIZE } from '../renderer';
import type { GroundQuery } from '../collision';
import type { HeightField } from '../noise';
import type { PlayerController } from '../controller';
import type { OrbitCamera } from '../camera';
import type { Vec3 } from '../math';
import type { GameItemId } from '../items';

import {
  buildCastleLayout, fitBreachRamp, LEVEL_Y, OUTER_HX, OUTER_HZ, ARENA_Y,
} from './castle-layout';
import type { CastleLayout, CastleLight } from './castle-layout';
import { CastleCollider } from './castle-collider';
import { buildCastleMesh, castleVertexCount, CASTLE_VERTEX_FLOATS } from './castle-mesh';
import { CASTLE_SEED, resolveCastleSite } from './castle-site';
import type { CastleSite } from './castle-site';
import {
  createCastleState, stepCastleState, castleHostile, patrolPose, huntPose,
} from './castle-state';
import type { CastleState, CastleAlarm, FlightPose } from './castle-state';
import { castleGarrison } from './castle-garrison';
import type { GarrisonPost } from './castle-garrison';
import { createCastleFight } from './castle-fight';
import type { CastleFight } from './castle-fight';

/** Draw the castle within this range. It is 130 m across and 36 m tall. */
const DRAW_DIST = 620;
/** Free its buffers past this. Wide hysteresis: a rebuild is a visible hitch. */
const EVICT_DIST = 900;
/** Proximity for the chest prompt, matching the dungeon/building managers. */
const INTERACT_DIST = 3;
/**
 * Garrison streaming radii, from the keep centre.
 *
 * Wider than the draw distance would need, because a pinned entity costs a
 * distance test and nothing else, and narrower than `EVICT_DIST` so the mobs
 * are always gone before the geometry they stand on is. The hysteresis gap is
 * what stops a player pacing the boundary from re-spawning the courtyard
 * twice a second.
 */
const GARRISON_LIVE = 260;
const GARRISON_RELEASE = 340;

/** localStorage key for the opening's persistent state. */
export const CASTLE_STATE_KEY = 'artifex-castle:v1';

/**
 * What the escape chest holds.
 *
 * These are the ids `createInventory()` gives a fresh save (`inventory.ts:49`),
 * which is the point: the opening takes the starter kit away and makes the
 * player find it again. Typed `GameItemId[]`, not the dungeon's narrow
 * `ItemId`, because the basic tools are not in that 17-entry list.
 */
export const STARTER_KIT: GameItemId[] = [
  'bronze_axe', 'bronze_pickaxe', 'fire_starter', 'torch', 'healing_herb',
];

export interface CastleFlame { x: number; y: number; z: number; scale: number }

/** A light in world space, shaped for `renderer.setWorldLights`. */
export interface CastleWorldLight { pos: Vec3; color: Vec3; radius: number }

interface Resident {
  draws: DungeonDraw[];
  buffers: GPUBuffer[];
  verts: number;
}

export class CastleManager {
  readonly site: CastleSite;
  readonly layout: CastleLayout;
  readonly collider: CastleCollider;
  readonly state: CastleState = createCastleState();

  /** World position of the keep's centre. */
  readonly centre: Vec3;

  private resident: Resident | null = null;
  private lightsBindGroup: GPUBindGroup | null = null;
  private zeroLights: GPUBuffer | null = null;
  private prompt: { label: string; act: () => void } | null = null;

  /** Set once the player opens the chest. Persisted — see `serialize()`. */
  chestOpened = false;

  /**
   * The garrison, in WORLD coordinates, resolved once at construction.
   *
   * Built here rather than in `main.ts` because it needs the collider to
   * validate every post, and the collider is this class's. World coordinates
   * rather than local because every consumer — the entity manager, the tests,
   * the debug hooks — works in world space and converting at four call sites
   * is four chances to forget.
   */
  readonly garrison: readonly GarrisonPost[];

  /** Ids of garrison members already killed. Persisted, so a corpse stays dead. */
  readonly garrisonDead = new Set<string>();

  /** The boss fight's state machine. Advanced by `main.ts` once hunting. */
  readonly fight: CastleFight = createCastleFight();
  /** Loot sink — main.ts wires this to the inventory, as it does for chests. */
  onLoot: ((items: GameItemId[]) => void) | null = null;
  /** Fired once per alarm transition, for the roar and the on-screen notice. */
  onAlarm: ((phase: CastleAlarm) => void) | null = null;

  /** Cached world-space flame points and fill lights (built once). */
  private readonly flames: CastleFlame[] = [];
  private readonly fillLights: CastleWorldLight[] = [];

  /**
   * The controller and camera are attached AFTER construction, not injected.
   *
   * They cannot be constructor arguments: the controller needs a world to
   * collide against, that world is this manager's collider, and the collider
   * needs the controller's live height to resolve which storey the player is
   * on. Something has to break the cycle, and the collider is the thing that
   * exists first.
   */
  private controller!: PlayerController;
  private camera!: OrbitCamera;

  constructor(
    private readonly renderer: Renderer,
    heightField: HeightField,
    terrain: GroundQuery,
  ) {
    this.site = resolveCastleSite(heightField);
    this.layout = buildCastleLayout(CASTLE_SEED);
    fitBreachRamp(this.layout, (lx, lz) =>
      heightField.heightAt(this.site.origin[0] + lx, this.site.origin[2] + lz)
      - this.site.origin[1]);
    this.collider = new CastleCollider(this.layout, this.site.origin, terrain);
    this.centre = [...this.site.origin] as Vec3;

    const [ox, oy, oz] = this.site.origin;

    // The garrison is placed in LOCAL space against the real collider, then
    // translated once. Probing in local space means the pure module never sees
    // the world origin, which is what lets `test-castle-fight.mts` place the
    // same roster without resolving a site.
    this.garrison = castleGarrison(this.layout, CASTLE_SEED, {
      ground: (x, z, y, r) => {
        const g = this.collider.creatureGround(x + ox, z + oz, r, y + oy);
        return g === null ? null : g - oy;
      },
      blocked: (x, z, y, r, h) =>
        this.collider.creatureBlocked(x + ox, z + oz, r, y + oy, h),
    }).map((p) => ({ ...p, x: p.x + ox, y: p.y + oy, z: p.z + oz }));
    for (const l of this.layout.lights) {
      if (l.flameScale > 0) {
        this.flames.push({ x: l.x + ox, y: l.y + oy, z: l.z + oz, scale: l.flameScale });
      } else {
        // Flameless fill: a big hall with only wall torches reads as a black
        // pit, and characters in it render as silhouettes.
        this.fillLights.push({
          pos: [l.x + ox, l.y + oy, l.z + oz],
          color: [0.50, 0.42, 0.36],
          radius: l.radius,
        });
      }
    }
  }

  /** Wire up the player once both exist. Must be called before the first tick. */
  attach(controller: PlayerController, camera: OrbitCamera): void {
    this.controller = controller;
    this.camera = camera;
    // The collider must read the player's LIVE height, not a value latched once
    // a frame: the controller queries `groundHeight` again after gravity, and a
    // stale probe lets a long fall tunnel straight through a floor.
    this.collider.probeY = () => controller.pos[1];
  }

  // --- placement -----------------------------------------------------------

  /** Where a new game starts: the forced cell in the undercroft. */
  spawnPoint(): Vec3 {
    const [ox, oy, oz] = this.site.origin;
    const s = this.layout.spawn;
    return [s[0] + ox, s[1] + oy + 0.05, s[2] + oz];
  }

  /**
   * Where death sends the player.
   *
   * Before the escape that is the cell they woke in — dying in the undercroft
   * and reappearing in open wilderness would skip the whole opening. After it,
   * the foot of the breach ramp, because respawning back inside a castle that
   * is now hunting you is a death loop.
   */
  respawnPoint(): Vec3 {
    if (!this.state.escaped) return this.spawnPoint();
    const foot = this.markerWorld('breachFoot');
    if (foot === null) return this.spawnPoint();
    return [foot[0] + 6, foot[1] + 0.6, foot[2]];
  }

  /** World position of a named marker, or null. */
  markerWorld(id: string): Vec3 | null {
    const m = this.layout.markers.get(id);
    if (m === undefined) return null;
    return [m.x + this.site.origin[0], m.y + this.site.origin[1], m.z + this.site.origin[2]];
  }

  /** True when the player is outside the curtain wall (drives `escaped`). */
  outsideWall(x: number, z: number): boolean {
    const dx = Math.abs(x - this.site.origin[0]);
    const dz = Math.abs(z - this.site.origin[2]);
    return dx > OUTER_HX + 1 || dz > OUTER_HZ + 1;
  }

  /** Distance from the keep centre, metres. */
  distanceTo(x: number, z: number): number {
    return Math.hypot(x - this.site.origin[0], z - this.site.origin[2]);
  }

  // --- per-frame -----------------------------------------------------------

  /**
   * Stream, advance the alarm, and refresh the interact prompt.
   *
   * `interiorMode` tells the caller whether the camera should collide against
   * the castle: true when the player is under one of its roofs. Handing the
   * orbit camera to the collider unconditionally would also clamp it out in
   * the open courtyard, where terrain clamping is the right behaviour.
   */
  update(pos: Vec3, simTime: number, otherInteriorActive: boolean): void {
    const d = this.distanceTo(pos[0], pos[2]);
    if (d > EVICT_DIST) this.evict();
    else if (d < DRAW_DIST && this.resident === null) this.build();

    const phase = stepCastleState(
      this.state, pos[0], pos[2], this.site.origin[0], this.site.origin[2],
      this.outsideWall(pos[0], pos[2]), simTime);
    if (phase !== null) this.onAlarm?.(phase);

    // Hand the camera to the collider anywhere on the castle's footprint, not
    // just under a roof.
    //
    // It was gated on `isRoofed` at first, which left the third-person camera
    // unclamped in the courtyards — and a courtyard is ringed by a 9 m curtain
    // wall and a 26 m keep, so tilting up put the eye straight inside the
    // masonry and filled the screen with the underside of a wall.
    // `clampCameraEye` marches out of solids and clamps to the floor under the
    // eye, which is the right behaviour on both sides of a door.
    //
    // Never while a real interior owns the camera: the dungeon and building
    // managers park the player at y = -300 and set `camera.interior` themselves.
    if (!otherInteriorActive) {
      const onGrounds = d < 200 && this.collider.inFootprint(pos[0], pos[2]);
      if (onGrounds) this.camera.interior = this.collider;
      else if (this.camera.interior === this.collider) this.camera.interior = null;
    }

    this.prompt = this.findInteraction(pos);
  }

  private findInteraction(pos: Vec3): { label: string; act: () => void } | null {
    if (this.chestOpened) return null;
    const c = this.layout.chest;
    const cx = c.x + this.site.origin[0];
    const cy = c.y + this.site.origin[1];
    const cz = c.z + this.site.origin[2];
    if (Math.abs(pos[1] - cy) > 3) return null;   // right room, not the one above
    if (Math.hypot(pos[0] - cx, pos[2] - cz) > INTERACT_DIST) return null;
    return {
      label: 'Press E to take your gear back',
      act: () => this.openChest(),
    };
  }

  get interactPrompt(): string | null { return this.prompt?.label ?? null; }

  tryInteract(): void { this.prompt?.act(); }

  private openChest(): void {
    if (this.chestOpened) return;
    this.chestOpened = true;
    this.prompt = null;
    this.onLoot?.(STARTER_KIT);
  }

  // --- the king and his dragon --------------------------------------------

  /** Where the dragon is right now. Pure function of the clock and the alarm. */
  flightPose(simTime: number, player: Vec3): FlightPose {
    const ky = this.site.origin[1] + ARENA_Y;
    if (this.state.alarm === 'hunting') {
      return huntPose(simTime, this.site.origin[0], ky, this.site.origin[2],
        player[0], player[1], player[2], simTime - this.state.changedAt);
    }
    return patrolPose(simTime, this.site.origin[0], ky, this.site.origin[2]);
  }

  /** True once the castle has gone hostile. */
  get hostile(): boolean { return castleHostile(this.state); }

  // --- the garrison --------------------------------------------------------

  /**
   * Bring the garrison into the world, or take it out again.
   *
   * Called every frame from `main.ts`. Spawning is idempotent — `placeEntity`
   * returns the live entity untouched when the id already exists — so this can
   * re-assert the roster without healing anything, and a member that has been
   * killed stays killed because its id is in `garrisonDead`.
   *
   * The radius is deliberately wide of `EntityManager.LIVE_RADIUS` (170 m):
   * these are pinned, so they cost nothing to keep, and a goblin that pops
   * into existence in front of the player at 170 m is worse than one that was
   * always there. Beyond `RELEASE`, they go — a castle full of bodies is 18
   * entries in the combat index and 18 distance tests per frame, and there is
   * no reason to pay that from the far side of the map.
   */
  syncGarrison(
    place: (p: GarrisonPost) => void,
    remove: (id: string) => void,
    playerX: number, playerZ: number,
  ): void {
    const d = this.distanceTo(playerX, playerZ);
    if (d < GARRISON_LIVE) {
      for (const p of this.garrison) {
        if (this.garrisonDead.has(p.id)) continue;
        place(p);
      }
    } else if (d > GARRISON_RELEASE) {
      for (const p of this.garrison) remove(p.id);
    }
  }

  /** Record a garrison death so it survives a reload. Returns true if new. */
  markGarrisonDead(id: string): boolean {
    if (this.garrisonDead.has(id)) return false;
    this.garrisonDead.add(id);
    return true;
  }

  /** How many of the garrison are still alive. */
  get garrisonAlive(): number {
    return this.garrison.length - this.garrisonDead.size;
  }

  // --- persistence ---------------------------------------------------------

  /**
   * The opening's state, for `artifex-castle:v1`.
   *
   * Alarm phase and `chestOpened` were session-only, so a reload restarted the
   * opening: the chest refilled, the alarm reset to dormant, and a player who
   * had already fought their way to the tower found an empty castle and a
   * dragon back on its patrol circuit. The garrison's dead list is here for
   * the same reason — without it, reloading resurrects every guard the player
   * has already killed, which is worse than restarting because it looks like
   * progress until the bodies come back.
   *
   * `maxDist` is deliberately NOT saved. It is a diagnostic, and persisting it
   * would let a save round-trip change nothing but still look different in the
   * debug block, which costs more confusion than it is worth.
   */
  serialize(): string {
    return JSON.stringify({
      v: 1,
      alarm: this.state.alarm,
      escaped: this.state.escaped,
      chest: this.chestOpened,
      dead: [...this.garrisonDead],
    });
  }

  /**
   * Restore from `serialize()`. Unknown or corrupt input leaves a fresh state,
   * which is the right failure: a new opening beats a half-restored one.
   *
   * `changedAt` is reset to 0 rather than restored, because the sim clock it
   * was measured against does not survive the reload either — `huntPose`
   * blends over `simTime - changedAt`, and a stale timestamp from an hour of
   * play makes that blend instantaneous. Zero means "the transition happened
   * long ago", which is exactly true of a reload.
   */
  restore(raw: string): boolean {
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      if (o === null || typeof o !== 'object' || o.v !== 1) return false;
      const alarm = o.alarm;
      if (alarm !== 'dormant' && alarm !== 'departed' && alarm !== 'hunting') return false;
      this.state.alarm = alarm;
      this.state.escaped = o.escaped === true;
      this.state.changedAt = 0;
      this.chestOpened = o.chest === true;
      this.garrisonDead.clear();
      if (Array.isArray(o.dead)) {
        for (const id of o.dead) if (typeof id === 'string') this.garrisonDead.add(id);
      }
      // A restored hunting castle must not have to re-trip the alarm to become
      // dangerous, and a restored departed one must not be able to trip
      // 'departed' a second time. `stepCastleState` only moves forward, so
      // both fall out of simply having the phase back.
      return true;
    } catch {
      return false;
    }
  }

  // --- rendering -----------------------------------------------------------

  draws(): DungeonDraw[] {
    if (this.resident === null) return [];
    const d = this.distanceTo(this.controller.pos[0], this.controller.pos[2]);
    return d > DRAW_DIST ? [] : this.resident.draws;
  }

  /** Torch and brazier billboards, for `emitWorldFire`'s settlementFlames. */
  flamePoints(): readonly CastleFlame[] {
    if (this.resident === null) return [];
    return this.flames;
  }

  /** Flameless fill lights, merged into the world light set by main.ts. */
  fillPoints(): readonly CastleWorldLight[] {
    if (this.resident === null) return [];
    return this.fillLights;
  }

  get vertexCount(): number { return this.resident?.verts ?? 0; }
  get isBuilt(): boolean { return this.resident !== null; }

  private build(): void {
    if (this.resident !== null) return;
    const device = this.renderer.device;
    const buffers: GPUBuffer[] = [];

    if (this.lightsBindGroup === null) {
      // Surface shading never reads group 2, but the pipeline layout requires
      // it bound. One zeroed buffer serves every palette.
      this.zeroLights = device.createBuffer({
        label: 'castle-zero-lights',
        size: LIGHTS_BUFFER_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.lightsBindGroup = this.renderer.createLightsBindGroup(this.zeroLights);
    }

    const parts = buildCastleMesh(this.layout);
    const draws: DungeonDraw[] = [];
    for (const part of parts) {
      const vertexBuffer = device.createBuffer({
        label: `castle-pal${part.palette}`,
        size: part.verts.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(vertexBuffer, 0, part.verts);
      buffers.push(vertexBuffer);
      // The mesh is authored around the castle's local origin; the object
      // uniform carries the world translation. Surface shading is 100+palette.
      const { bindGroup, buffer, shadowBindGroup } = this.renderer.createObjectBindGroup(
        this.site.origin[0], this.site.origin[1], this.site.origin[2],
        100 + part.palette);
      buffers.push(buffer);
      draws.push({
        draw: {
          vertexBuffer,
          indexBuffer: null,
          count: part.verts.length / CASTLE_VERTEX_FLOATS,
          bindGroup,
          shadowBindGroup,
        },
        lightsBindGroup: this.lightsBindGroup,
      });
    }
    this.resident = { draws, buffers, verts: castleVertexCount(parts) };
  }

  private evict(): void {
    if (this.resident === null) return;
    for (const b of this.resident.buffers) b.destroy();
    this.resident = null;
  }

  /** Free everything. Only for teardown; the castle is normally always up. */
  dispose(): void {
    this.evict();
    this.zeroLights?.destroy();
    this.zeroLights = null;
    this.lightsBindGroup = null;
  }

  // --- debug ---------------------------------------------------------------

  debugInfo(): Record<string, unknown> {
    const p = this.controller.pos;
    return {
      alarm: this.state.alarm,
      hostile: this.hostile,
      escaped: this.state.escaped,
      chestOpened: this.chestOpened,
      dist: Math.round(this.distanceTo(p[0], p[2]) * 10) / 10,
      maxDist: Math.round(this.state.maxDist),
      built: this.resident !== null,
      verts: this.vertexCount,
      baseY: Math.round(this.site.origin[1] * 100) / 100,
      undercroftY: Math.round((this.site.origin[1] + LEVEL_Y[0]) * 100) / 100,
      roofed: this.collider.isRoofed(p[0], p[1], p[2]),
      insideFootprint: this.collider.inFootprint(p[0], p[2]),
      garrison: this.garrison.length,
      garrisonAlive: this.garrisonAlive,
      fight: this.fight.phase,
    };
  }
}

/**
 * The castle's collider IS the composed world query — it delegates to the base
 * (`settlementGround(terrainGround(…))`) everywhere it has no geometry, so
 * there is no separate decorator to keep in sync. Pass this to the controller
 * AND to DungeonManager/BuildingManager as their `terrain`: both restore
 * `controller.world = this.terrain` on exit, and handing them the bare terrain
 * would silently drop castle collision the first time the player left a
 * building.
 */
export function castleWorld(m: CastleManager): GroundQuery {
  return m.collider;
}
