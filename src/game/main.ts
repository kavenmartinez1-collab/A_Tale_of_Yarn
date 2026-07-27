/**
 * Game entry point — bootstraps WebGPU, the renderer, and the frame loop.
 *
 * Milestone 4: walkable third person. Click to lock the pointer; WASD moves
 * the player (camera-relative), Shift sprints, Space jumps, mouse orbits the
 * camera, wheel zooms. R toggles the debug fly camera (WASD + Space/C).
 *
 * Exposes machine-readable state for the Playwright smoke test:
 *   window.__gameReady  — true after the first successfully rendered frame
 *   window.__gameStats  — { frameCount, fps, chunkCount }
 *   window.__gameError  — first fatal/uncaptured error message, else null
 */

import { initWebGPU } from '../engine/gpu-device';
import { reportError } from '../utils/metrics';
import { STEAM_RELEASE, debugParams } from './release-flags';
import { GamepadInput } from './input/gamepad';
import { UiFocus } from './input/ui-focus';
import {
  Renderer, LIGHTS_BUFFER_SIZE, DEFAULT_POST, STRIDE_CREATURE, STRIDE_PROP,
  MAX_WORLD_LIGHTS,
  type FrameUniforms, type TerrainDraw, type DungeonDraw,
} from './renderer';
import { MATERIALS } from './render/materials';
import { layoutDungeon, mix32 } from './dungeon/dungeon-layout';
import { buildInteriorMesh } from './dungeon/dungeon-mesh';
import { DUNGEON_FIXTURES } from './dungeon/dungeon-fixtures';
import { DungeonManager } from './dungeon/dungeon-manager';
import { BuildingManager } from './building/building-manager';
import { isEnterablePad } from './building/building-pads';
import { SettlementManager } from './settlement/settlement-manager';
import { settlementGround, buildSettlementSolids } from './settlement/settlement-collider';
import { DungeonDirector } from './director/director';
import { terrainGround } from './collision';
import { DAY_LENGTH_S, envAt } from './environment';
import {
  weatherAt, strikesForSegment, WEATHER_PRESETS, type Weather, type WeatherKind,
} from './weather';
import {
  buildCharacterMesh, CHARACTER_MAX_VERTS,
  type CharacterCustomization, type HeldItem,
} from './character/character-mesh';
import { loadCustomization, saveCustomization } from './character/customization';
import { isGameItemId, itemDef, ITEM_DEFS, type GameItemId } from './items';
import {
  loadVillageMemory, saveVillageMemory, recordVillageEvent, witnessesNear,
  spreadVillageNews, newsFor, dispositionFromNews,
} from './npc/village-memory';
import {
  loadVillageFacts, saveVillageFacts, factsFor, factLinesFor, advanceTasks,
} from './npc/village-facts';
import { loadNodeRegistry, saveNodeRegistry } from './resource-nodes';
import { ResourceManager, type WorldNode, type NodeType } from './resource-manager';
import { RESOURCE_DROPS, REQUIRES_PICKAXE } from './resource-scatter';
import {
  addItem, countItem, removeItem, dropSlot, equipped, loadInventory, saveInventory,
  totalWarmth, equipArmor, unequipArmor, totalDefense,
  type Inventory, type SlotRef,
} from './inventory';
import {
  createFire, addFuel, upgradeToForge, isLit, nearestFire,
  fireWarmthAt, nearCampfireOrForge, nearForge as nearForgeCheck,
  loadFires, saveFires,
  addBurningTree, tickBurningTrees, getBurningTrees,
  BUSH_BURN_S, FIRE_IGNITE_RADIUS, TORCH_IGNITE_RADIUS,
  FIRE_SPREAD_RADIUS, FIRE_SPREAD_CHANCE,
  BREATH_RANGE,
  type PlacedFire,
} from './fire';
import { inBreathCone, breathHit } from './breath-cone';
import { resolveAim, aimVelocity, type AimCandidate, type AimTarget } from './aim';
import {
  absoluteStrikeTimes, strikeTargetPoint, isExposed, resolvePlayerStrike,
  hasIronArmor,
  PLAYER_STRIKE_RADIUS, PLAYER_STRIKE_RADIUS_IRON, TREE_IGNITE_RADIUS, TREE_BURN_S,
  type ScheduledStrike,
} from './lightning';
import {
  createTent, tentTierAt, canopyAt,
  loadTents, saveTents,
  type PlacedTent,
} from './shelter';
import { buildFireMeshes, buildTentMeshes } from './fire-mesh';
import { emitWorldFire } from './render/fire-fx';
import { emitParrySpark, PARRY_SPARK_S } from './render/parry-fx';
import {
  fireTintreach, applyTintreachPost, loadTintreach, saveTintreach,
} from './tintreach';
import { Hotbar, buildInventoryPanel } from './ui/inventory-ui';
import { buildCraftingPanel } from './ui/crafting-ui';
import { PanelManager } from './ui/panel-manager';
import { consumeOwnRelease, releasePointerLock } from './ui/pointer-lock';
import { buildCharacterPanel } from './ui/character-panel';
import type { GameMenuOptions } from './ui/menu-panel';
import { SimClock } from './sim-clock';
import { loadDiscovery, saveDiscovery, MAP_TILE, REVEAL_RADIUS } from './map/discovery';
import { CASTLE_VHAERON, landmarksInCell } from './map/map-landmarks';
import { buildMapPanel, getMapProfile, getMapView, resetMapProfile } from './map/map-panel';
import {
  saveToSlot, loadSlot, listSlots, deleteSlot, activeSlot, newGame,
  consumeResume, saveAutoPos, readAutoPos,
} from './save-game';
import {
  buildNpcChatPanel, onNpcChatClosed, loadStockMap, saveStockMap,
  chatState, npcGoldFromMap, isNpcModelKey, preloadNpcChat, warmNpcApproach,
  voiceInput,
  type StockMap, setVoiceOut,
} from './ui/npc-chat-panel';
import {
  loadMemoryMap, getOrCreateMemory, adjustDisposition, saveMemoryMap,
  loadVisitedSet, saveVisitedSet, loadDeadNpcSet, saveDeadNpcSet,
  type MemoryMap,
} from './npc/npc-memory';
import { EcologyDirector } from './entities/ecology-director';
import { VitalsHud } from './ui/vitals-hud';
import { TorchBar } from './ui/torch-bar';
import { Reticle, type ReticleMode } from './ui/reticle';
import { LockIndicator } from './ui/lock-indicator';
import {
  burnTorch, torchFlamePos, TORCH_BURN_S, TORCH_FLAME_SCALE,
  TORCH_LIGHT_RADIUS, TORCH_LIGHT_SORT_KEY, TORCH_LIGHT_WORLD,
} from './torch';
import {
  createVitals, loadVitals, saveVitals,
  stepVitals, damagePlayer, healPlayer, drinkPlayer, drainStamina,
  CLIMB_SLOPE_DEG, CLIMB_DRAIN_PER_S, CLIMB_DRAIN_STAFF_PER_S, SPRINT_DRAIN_PER_S,
  STAMINA_REGEN_PER_S, MAX_STAMINA, MAX_HP,
  type Vitals, type StepEnv,
} from './vitals';
import {
  createEffects, applyItemEffects, stepEffects,
  effectWarmth, effectCooling, staminaRegenMult, serializeEffects, deserializeEffects,
  EFFECTS_STORAGE_KEY, type EffectsState,
} from './effects';
import {
  nestsForCell, nestEggItem, type NestSite,
} from './entities/nest-scatter';
import { add, multiply, normalize, perspectiveZO, type Vec3 } from './math';
import { createHeightField, SEA_LEVEL } from './noise';
import { createBiomeField } from './biome';
import { CHUNK_SIZE } from './terrain/chunk-mesh';
import { ChunkManager } from './terrain/chunk-manager';
import { FlyCamera } from './fly-camera';
import { OrbitCamera } from './camera';
import { PlayerController } from './controller';
import { DebugCapture } from './debug-capture';
import { castleGateLocal } from './settlement/settlement-layout';
import { EntityManager } from './entities/entity-manager';
import { EntityRenderer, DEAD_SHOW_S } from './entities/entity-renderer';
import {
  stepAnimal, onEntityDamaged, FOLLOW_RADIUS, DEFEND_GIVEUP_DIST,
  type DefendTarget,
  CombatIndex, wantsAirborne, staggerAnimal, staggerRemaining,
} from './entities/animal-ai';
import { MeleeTokenPool, isExempt } from './combat/attack-tokens';
import {
  bestShieldTier, createGuard, setGuardInput, dropGuard, resolveBlock, blockSfx,
  parryReady, SHIELD_STATS, BLOCK_MOVE_MUL,
  type ShieldTier, type IncomingKind, type BlockOutcome,
} from './combat/shields';
import {
  pickLockTarget, cycleLockTarget, lockBreakReason, lockCameraYaw,
  lockFacingYaw, easeAngle, indicatorFade, LOCK_EASE_PER_S,
  type LockCandidate,
} from './combat/lock-on';
import {
  createProjectilePool, spawnProjectile, stepProjectiles, followAnchors,
  releaseProjectile,
  inFlightCount, activeCount,
  PROJECTILE_CAPACITY, PROJECTILE_GRAVITY, type Projectile,
} from './projectiles';
import {
  buildProjectileMesh, projectileMeshFloats, PROJECTILE_FLOATS_PER_VERT,
} from './projectile-mesh';
import { routePlayerDamage, type RiderState } from './attack-routing';
import { SPECIES_DEFS, DRAGON_FLIGHT_ENABLED, ECELL, type Species } from './entities/entity-types';
import { rollDrops } from './entities/animal-drops';
import { box, mulberry32 } from './mesh-utils';
import {
  spawnSettlementNpcs, resolveNpcs, type ResolvedNpc,
} from './npc/npc-spawn';
import { npcGenderFor, buildNpcRelations, npcQuirkFor, buildSurroundingsFacts } from './npc/npc-prompt';
import { layoutSettlement } from './settlement/settlement-layout';
import {
  loadTamingRegistry, saveTamingRegistry,
  attemptMount, feed, feedBaby,
  heatEgg, growBaby, eggSpeciesFor,
  createTamedState, needsTaming,
  EGG_HEAT_RADIUS, TEMPER_PER_BUCK,
  type TamingRegistry, type TamedState,
} from './entities/taming';
import { isLit as isFireLit } from './fire';
import {
  createCrimeState, loadCrimeState, saveCrimeState,
  reportCrime, bountyIn, payBounty, serveSentence, escapeJail, jailSentenceS,
  WITNESS_RADIUS, BOUNTY_AMOUNTS,
  type CrimeState,
} from './crime';
import { GameAudio, type AmbienceState } from './audio/audio-engine';
import { settings, type GameSettings } from './ui/game-settings';
import { buildControlsPanel } from './ui/controls-panel';
import { VoiceOut } from './voice/voice-out';
import { CastleManager, castleWorld, CASTLE_STATE_KEY } from './castle/castle-manager';
// Arena floor height, so the boss's leash anchor and its flight home sit on
// the same circle `castleManager.flightPose` patrols at.
import { ARENA_Y } from './castle/castle-layout';
import { kingRiderPlacement, kingRidingPose } from './entities/king-mesh';
import { blackDragonLandmarks } from './entities/black-dragon-mesh';
import { LEAVE_RADIUS, RETURN_RADIUS } from './castle/castle-state';
import { isGarrisonId } from './castle/castle-garrison';
import {
  stepCastleFight, breathInRange, BREATH_TELL_S, BREATH_S,
} from './castle/castle-fight';

declare global {
  interface Window {
    __gameReady?: boolean;
    __gameStats?: {
      frameCount: number;
      fps: number;
      chunkCount: number;
      /** True while the pause screen is up and the simulation is stopped. */
      paused?: boolean;
      /** The sim clock (s). Must not move between two paused frames. */
      simTime?: number;
      /** Discovered 64 m map chunks. */
      mapChunks?: number;
      playerPos?: [number, number, number];
      grounded?: boolean;
      swimming?: boolean;
      weather?: string;
      insideDungeon?: boolean;
      dungeonCount?: number;
      interactPrompt?: string | null;
      chestsOpened?: number;
      notice?: string | null;
      directorStatus?: string | null;
      equipped?: string | null;
      attackT?: number;
      gathered?: number;
      burningTreeCount?: number;
      /** Fire billboards queued on the last frame (render/fire-fx.ts). */
      fireBillboards?: number;
      // Phase J
      entityCount?: number;
      entityDrawn?: number;
      // Phase K
      mountedEntityId?: string | null;
      /** Dragon flight altitude above terrain (m), null when not flying. */
      mountAltitude?: number | null;
      // Phase L
      npcCount?: number;
      /** Arrows/stones currently flying (visible as moving geometry). */
      projectilesInFlight?: number;
      /** Arrows currently stuck in the ground or in a body. */
      projectilesStuck?: number;
      /** Bow draw pose weight 0..1. */
      bowAim?: number;
      /** Hit points of the mount the player is riding, null when on foot. */
      mountHp?: number | null;
      // Phase M
      bounty?: number;
      jailed?: boolean;
      jailRemainS?: number;
      /** Ground-clutter instances currently submitted (graphics debugging). */
      grassInstances?: number;
      /** Point lights submitted to the world-light set (graphics debugging). */
      worldLightCount?: number;
    };
    __gameError?: string | null;
    __gameDebug?: {
      enterNearestDungeon(): boolean;
      /** True when the player's head is under castle masonry. */
      castleRoofedHere(): boolean;
      /** Eased 0..1 shelter weight — 1 fully covered. */
      shelterLevel(): number;
      /** Rain intensity actually handed to the renderer this frame. */
      frameRainLevel(): number;
      /** simTime a mob-vs-mob corpse would be stamped with right now. */
      dungeonCorpseStampTime(): number;
      /** Resident cell grid in grid-local metres (0 = solid). Null when outside. */
      dungeonGrid(): {
        w: number; h: number; origin: [number, number, number]; cells: number[];
      } | null;
      /** Stand the player at grid-local (lx, lz) on the dungeon FLOOR. */
      dungeonPlacePlayer(lx: number, lz: number): boolean;
      /** True when a world point is inside dungeon masonry. */
      dungeonSolidAt(x: number, y: number, z: number): boolean;
      /** True when nothing solid stands between two world XZ points. */
      dungeonSeesFrom(x0: number, z0: number, x1: number, z1: number): boolean;
      teleportToExitPortal(): void;
      teleportToNearestChest(): boolean;
      teleportToNearestEntrance(): boolean;
      nearestDungeonName(): string | null;
      directorGeneration(): number;
      playerPos(): [number, number, number];
      customization(): CharacterCustomization;
      inventory(): Inventory;
      attackT(): number;
      nearestSettlement(): { name: string; kind: string } | null;
      teleportToNearestSettlementSign(): boolean;
      nearestResource(): WorldNode | null;
      teleportToNearestResource(type: string): boolean;
      setCamera(yaw: number, pitch: number, distance: number): void;
      /**
       * Orbit the given entity instead of the player, hide the player mesh and
       * hold all animals at idle. Pass null to restore normal play.
       */
      setPortraitSubject(entityId: string | null): void;
      /** The ground as drawn (roads carved in) — what feet actually rest on. */
      groundHeightAt(x: number, z: number): number;
      /** Terrain height at a world XZ — lets harnesses find flat ground. */
      heightAt(x: number, z: number): number;
      /** Locomotion state — whether the player is grounded, swimming, falling. */
      playerMotion(): { grounded: boolean; swimming: boolean; velY: number; yaw: number };
      /** Equip/clear armor slots by item id (null clears) — character capture. */
      setArmor(slots: { head?: string | null; body?: string | null; legs?: string | null }): void;
      /** Patch the character customisation (hair style/colour, body, tones). */
      setCustomization(partial: Partial<CharacterCustomization>): void;
      /** Force sun shadows on/off, or null to restore automatic. */
      setShadows(on: boolean | null): void;
      /**
       * Melee turn-taking state — see `combat/attack-tokens.ts`.
       * `scripts/combat-feel-check.mjs` reads this to prove the cap holds.
       */
      attackTokens(): {
        contenders: number; held: number; capacity: number;
        peakHeld: number; deniedByToken: number; deniedByRate: number;
        enabled: boolean;
      };
      /**
       * Turn attack-token arbitration off, restoring the pre-token behaviour
       * where every aggro'd enemy swings on its own clock.
       *
       * Exists so a harness can measure BEFORE and AFTER in one world, on one
       * spawn, with one seed. Measuring "before" by checking out an older
       * revision compares two different worlds and proves nothing about this
       * one.
       */
      setAttackTokens(on: boolean): void;
      /**
       * The shield/guard state, including WHY the last blow resolved as it
       * did. HP alone cannot distinguish a parry from a block (both are zero
       * damage) or a flank from having no shield (both are full damage), so a
       * harness reading only vitals measures nothing.
       */
      guardState(): {
        shield: string | null; down: boolean; raised: boolean;
        parryWindow: boolean; armed: boolean; raisedAtS: number; blend: number;
        lastKind: string | null; lastReason: string | null;
        lastBearingDeg: number | null; lastStaggerS: number; sparks: number;
        blocked: number; parried: number; brokeGuard: number; flanked: number;
      };
      /** Seconds of parry-stagger left on an entity, or null if unknown. */
      staggerOf(id: string): number | null;
      /** Put a shield in hotbar slot 1 (never the selected slot). */
      giveShield(tier: string | null): boolean;
      /**
       * Land one blow through the real damage path, at a moment the harness
       * chooses. The only way to test a 0.18 s window from outside the page.
       */
      forceAttackOnPlayer(
        entityId: string | null, damage: number,
        kind?: 'melee' | 'projectile' | 'breath',
      ): {
        hit: boolean; heldS: number; hpLost: number; staminaSpent: number;
        kind: string | null; reason: string | null; staggerS: number;
        bearingDeg: number | null;
      };
      /** The shipped shield stat ladder, keyed by tier. */
      shieldLadder(): Record<string, {
        tier: string; rank: number; itemId: string;
        staminaPerBlock: number; fireMitigation: number;
      }>;
      /** Current Z-target id and its bearing, or null when not locked. */
      lockOn(): { id: string; x: number; z: number; dist: number } | null;
      /** Toggle/force Z-targeting. `null` toggles. Returns the resulting id. */
      setLockOn(on: boolean | null): string | null;
      /** Step to the next Z-target. Returns the resulting id. */
      cycleLockOn(dir: number): string | null;
      /**
       * Recent blows landed on the player: attacker id and sim time, oldest
       * first. Bounded ring; the harness derives simultaneous-attacker counts
       * and DPS from it rather than from a bar reading.
       */
      attackLog(): { id: string; t: number }[];
      freezeAttackT(t: number | null): void;
      equipItem(id: string, count?: number): boolean;
      vitals(): Vitals;
      setVitals(partial: Partial<Vitals>): void;
      tickVitals(seconds: number): void;
      /**
       * Held-torch state, for the burn/warmth harness. `flame` is the world
       * position the light and the billboard are actually at, so a harness can
       * assert the light exists where the torch is rather than trusting that
       * "a light was added to a list".
       */
      torchState(): {
        held: boolean; lit: boolean; fuelS: number; burnS: number;
        count: number; spare: number; flame: [number, number, number] | null;
      };
      /** Force the fuel in the torch in hand — jumps a burn test forward. */
      setTorchFuel(seconds: number): void;
      /** Live world point-light set, as uploaded this frame. */
      worldLights(): { pos: number[]; color: number[]; radius: number }[];
      /**
       * Pin the bow's first-person view on/off, or null to hand it back to the
       * draw. A harness cannot hold a mouse button through pointer lock, so
       * without this every aiming beat would silently be a third-person one.
       */
      setFirstPerson(on: boolean | null): void;
      /** Camera framing as rendered: blend, eye, boom, whether you are shown. */
      cameraState(): {
        firstPerson: number; eye: [number, number, number];
        forward: [number, number, number];
        boom: number; playerDrawn: boolean;
      };
      // Phase H
      placeFire(x: number, z: number, lit?: boolean): string;
      placeTent(x: number, z: number, tier?: 1 | 2 | 3): string;
      fires(): import('./fire').PlacedFire[];
      tents(): import('./shelter').PlacedTent[];
      nearCampfire(): boolean;
      nearForgeDebug(): boolean;
      // Phase I
      triggerStrike(dx: number, dz: number, forceOutcome?: 'death' | 'survivor'): void;
      burningTrees(): import('./fire').BurningTree[];
      // Phase J
      entities(): import('./entities/entity-manager').EntityState[];
      spawnEntity(species: string, dx: number, dz: number): import('./entities/entity-manager').EntityState | null;
      /** Place a creature at an exact (x, y, z) — no terrain snap. Returns its id. */
      placeEntity(species: string, x: number, y: number, z: number): string | null;
      /** Mount a creature by id, skipping reach/taming. For dismount probes. */
      mountEntity(id: string): boolean;
      /** Force a creature to hold position, so a probe measures aim not lead. */
      holdEntity(id: string, on?: boolean): boolean;
      /** Delete a probe creature outright — no corpse left to hit LIVE_CAP. */
      removeEntity(id: string): boolean;
      /** Step off the mount via `doDisMount`, bypassing the KeyE chain. */
      dismount(): boolean;
      /** Restore full health — for probes that run many trials in one session. */
      healPlayer(): boolean;
      /** What the crosshair is over right now, and the shot that would reach it. */
      aimTarget(): {
        point: [number, number, number]; dist: number;
        id: string | null; name: string | null; isTarget: boolean;
        eye: [number, number, number]; dir: [number, number, number];
        muzzle: [number, number, number];
        launch: [number, number, number] | null; speed: number;
        /** Which quiver a shot fired right now would spend; null when dry. */
        ammo: 'flint' | 'tintreach' | null;
        /** What the crosshair is currently SAYING — 'far' means it has told
         *  the player the arc falls short. Probes compare this against where
         *  the arrow actually lands. */
        reticleMode: import('./ui/reticle').ReticleMode;
        /** Live "does the arc reach", from the same code the crosshair uses. */
        reachable: boolean;
        /** Draw power a shot loosed this frame would carry, 0..1. */
        drawPower: number;
      };
      /** Force the selected quiver ('flint' | 'tintreach'). */
      setAmmo(kind: string): boolean;
      killEntity(id: string): boolean;
      attackEntity(id: string, damage: number): boolean;
      /** Enemies inside the current dungeon (empty when not inside). */
      dungeonEntities(): import('./dungeon/dungeon-manager').DungeonEnemy[];
      // Phase K
      taming(): import('./entities/taming').TamingRegistry;
      heatEggFast(seconds: number): void;
      growFast(seconds: number): void;
      placeEgg(species: string, dx: number, dz: number): boolean;
      mounted(): string | null;
      mountStamina(): number | null;
      /** Altitude of mounted dragon above terrain (m), or null if not mounted on flying mount. */
      mountAltitude(): number | null;
      // Ranged combat testing
      /**
       * Inject a projectile directly at world position (x, y, z) with zero
       * velocity so the next sim tick hits anything within range. Returns the
       * count of projectiles currently in flight after injection.
       */
      injectProjectile(x: number, y: number, z: number, kind: 'stone' | 'arrow', damage: number): number;
      /**
       * Last frame's NPC mesh-rebuild accounting. `wanted` is what the LOD
       * bands asked for, `spent` what the budget granted, `forced` the
       * uncapped rebuilds from a pool slot changing owner — the number that
       * tells you whether the slot keying is actually holding.
       */
      npcDrawCost(): {
        drawn: number; wanted: number; spent: number; forced: number; ms: number;
      };
      /** false reproduces the pre-LOD path: every drawn NPC, every frame. */
      setNpcLod(on: boolean): void;
      /** Free every projectile slot, flying or planted. */
      clearProjectiles(): void;
      /** Count of projectiles currently in flight. */
      projectileCount(): number;
      /** Count of arrows stuck in the ground or in a body. */
      stuckProjectileCount(): number;
      /**
       * Loose an arrow at an exact yaw/pitch (degrees) and draw power, without
       * needing a mouse or the fire-rate limiter. Harnesses cannot aim a bow
       * headlessly; this is how an arrow's flight gets photographed.
       */
      fireArrow(yawDeg: number, pitchDeg: number, power?: number): boolean;
      /** Draw and loose along the camera's current aim, without moving it. */
      looseArrow(power?: number): boolean;
      /** Force the castle alarm phase. */
      castleSetAlarm(alarm: 'dormant' | 'departed' | 'hunting'): string;
      /** The boss's body: position, speed, phase, leash state. */
      bossState(): {
        phase: string; returning: boolean; seeded: boolean;
        x: number; y: number; z: number; speed: number;
        entity: { x: number; y: number; z: number; hp: number } | null;
      };
      /** Every live projectile: position, direction, and whether it has stuck. */
      projectiles(): {
        kind: string; team: string; stuck: boolean;
        x: number; y: number; z: number;
        dx: number; dy: number; dz: number;
        anchorId: string | null;
      }[];
      /** Bow draw state — { drawing, t (seconds held), aim (0..1 pose weight) }. */
      bowDraw(): { drawing: boolean; t: number; aim: number };
      /** Pin the archer's draw pose for capture; null restores live behaviour. */
      freezeBowAim(a: number | null): void;
      /** Hold the string at 0..1 draw, or null to release it without firing. */
      bowDrawTo(power: number | null): void;
      /** Remove up to `count` of an item — the inverse of `giveItem`. */
      takeItem(id: string, count: number): number;
      /**
       * Point the player's body at a fixed yaw (radians, 0 = -Z). Capture only:
       * without it the only way to change the doll's facing is to orbit the
       * camera, which turns the doll with it and guarantees a back view.
       */
      facePlayer(yawRad: number): void;
      /**
       * Run the real left-click resolver (gather / bow draw / throw / swing).
       * The listener is gated on pointer lock, which headless Chrome will not
       * grant, so without this no automated check can exercise an attack.
       */
      leftClick(): void;
      /** Loose a bow that `leftClick` started drawing. */
      releaseBow(): void;
      // Phase L
      /** Nearby NPCs within 200 m — id, role, name, x, z, hp. */
      npcs(): { id: string; role: string; name: string; x: number; z: number; hp: number }[];
      /** Damage an NPC via the real combat path; false if missing/dead. */
      damageNpc(id: string, dmg: number): boolean;
      /** Blocker AABBs of nearby settlements (collision probes). */
      settlementBlockers(): { x0: number; z0: number; x1: number; z1: number; top: number }[];
      /** Add count of an item to the player inventory (probes). */
      giveItem(id: string, count: number): void;
      /** Count of an item in the player inventory (probes). */
      countItem(id: string): number;
      // Phase L2 NPC chat hooks
      /** Whether the NPC chat panel is currently open. */
      chatOpen(): boolean;
      /** Last NPC reply text, or null. */
      lastNpcReply(): string | null;
      /** Teleport player to within 1 m of the nearest NPC. Returns false if none in range. */
      teleportToNearestNpc(): boolean;
      /** Inject an NPC reply directly (drives the trade pipeline without LLM timing). */
      injectNpcReply(text: string): void;
      /**
       * Push-to-talk state, and the leg timings of the last utterance.
       *
       * The state and the transcript are both readable from the DOM (the
       * indicator's label, and `#npc-chat-input`), and the harness asserts
       * against those on purpose — they are what the player sees. This exists
       * for the one thing the DOM does not carry: where the milliseconds went.
       */
      voiceDebug(): {
        state: string;
        awaitingConfirm: boolean;
        captureMs: number; transcribeMs: number; encodeMs: number;
      } | null;
      // Phase M — crime / bounty / jail
      /** Regional bounty; regionId defaults to nearest settlement's stable id. */
      bounty(regionId?: string): number;
      /** Add bounty to the nearest-settlement region (for e2e seeding). */
      addBounty(amount: number, regionId?: string): void;
      /** Current jail state: { jailedUntilMs, regionId } or null if not jailed. */
      jailState(): { jailedUntilMs: number; regionId: string } | null;
      /** Teleport to nearest settlement of optional kind. Returns false if none found. */
      teleportToNearestSettlement(kind?: string): boolean;
      /** Accelerate jail sentence: advance jailed-until by subtracting ms. */
      serveFast(ms: number): void;
      /** Force-open the arrest panel (e2e). */
      openArrestPanel(): void;
      /** Force-send player to jail now (e2e). */
      sendToJail(): void;
      /** Teleport player to an arbitrary world (x, z) position (e2e). */
      teleport(x: number, z: number): void;
      /** True when the player is adjacent to drinkable fresh water (e2e). */
      nearFreshWaterDebug(): boolean;
      /** Directly set the player's vertical velocity (for fall-damage testing). */
      setVelY(v: number): void;
      /** Toggle audio mute. */
      toggleMute(): void;
      /** Returns true if audio is currently muted. */
      audioMuted(): boolean;
      /**
       * Synthesize a line through the real voice worker and return the
       * waveform's statistics, without playing it. Resolves null when speech
       * is off or unavailable. `scripts/steam-pack-check.mjs` uses this to
       * assert a packaged offline build makes actual sound.
       */
      voiceProbe(text: string): Promise<{
        samples: number; sampleRate: number; peak: number; rms: number; synthMs: number;
      } | null>;
      /** Whether the voice worker has the model resident. */
      voiceReady(): boolean;
      /**
       * The live settings store. `scripts/controller-ui-check.mjs` asserts
       * both halves of the contract through this: that a change made in the
       * panel applies immediately, and that it is still there after a reload.
       */
      settings(): Readonly<import('./ui/game-settings').GameSettings> & {
        set(patch: Partial<import('./ui/game-settings').GameSettings>): void;
        reset(): void;
      };
      /** Nearest npcOwned horse within given radius of (x, z), or null. */
      nearestNpcOwnedHorse(x: number, z: number, radius?: number): import('./entities/entity-manager').EntityState | null;
      /** Ownership flags of a live entity by id, or null (e2e). */
      entityFlags(id: string): { npcOwned: boolean; owned: boolean } | null;
      /** World positions of market stall pads in meshed settlements (e2e). */
      stallPads(): { wx: number; wz: number }[];
      /** Well pads in streamed settlements — drinking sources. */
      wellPads(): { wx: number; wz: number }[];
      /**
       * Return the current gold pool for a given NPC.
       * npcKey is "settlementName::npcId"; when omitted returns the active chat NPC's pool.
       */
      npcGold(npcKey?: string): number;
      // Phase 60 — nest / armor / effects / character debug hooks
      /** Streamed nest sites visible near the player. */
      nearestNest(): import('./entities/nest-scatter').NestSite | null;
      /** Set of looted nest ids. */
      lootedNestIds(): string[];
      /** Equip an armor item id into its slot from pack/hotbar. Returns false if not in inventory. */
      equipArmorById(id: string): boolean;
      /** Active effects state snapshot. */
      activeEffects(): import('./effects').ActiveEffect[];
      /** Apply an item's effect to the effects state (e.g. 'stamina_potion'). */
      applyEffect(itemId: string): void;
      /** Current character options passed to buildCharacterMesh (body + armor tiers). */
      characterOptions(): { body: string; armor: { head?: string; body?: string; legs?: string } };
      /** Current totalDefense value. */
      totalDefense(): number;
      // Building interiors
      /** Enter the nearest enterable building. Returns true on success. */
      enterNearestBuilding(): boolean;
      /** True when inside a building interior. */
      insideBuilding(): boolean;
      /** Every loaded NPC's home + indoor state. */
      npcHomes(): {
        id: string; name: string; role: string; settlement: string;
        pad: number; padType: string; indoors: boolean; inArena: boolean;
        x: number; z: number;
      }[];
      /** Enter the building this NPC calls home. */
      enterNpcHome(npcId: string): boolean;
      /** Which building the player is in, by NPC-home identity. */
      occupiedBuilding(): { settlementName: string; padIndex: number; kind: string } | null;
      /** The interaction line the HUD is currently showing. */
      interactPrompt(): string | null;
      /** Who the player could talk to right now. */
      nearestNpc(): { id: string; name: string; role: string } | null;
      /** Teleport to the exit zone inside a building. */
      buildingTeleportToExit(): void;
      /** Teleport to the nearest chest inside a building. */
      buildingTeleportToChest(): boolean;
      /** Teleport to a bed inside a building. */
      buildingTeleportToBed(): boolean;

      /**
       * The mounted breath as geometry: the aim ray plus, per nearby entity,
       * the axial/perpendicular distances that decide the hit. Null when not
       * mounted on something with a breath weapon.
       */
      breathProbe(): Record<string, unknown> | null;
      // --- pause + world map ---
      /** Is the simulation stopped? */
      paused(): boolean;
      /** Open (true) or close (false) the pause screen. */
      setPaused(on: boolean): void;
      /** The sim clock, in seconds. Frozen while paused. */
      simTime(): number;
      /**
       * How many fixed steps the last frame ran. The number a pause has to
       * keep at zero, and the one a resume must not spike.
       */
      lastFrameSteps(): number;
      /** Fog-of-war stats, including the serialised size in bytes. */
      mapStats(): {
        chunks: number; tiles: number; bytes: number;
        x0: number; z0: number; x1: number; z1: number;
      };
      /** Is this world position on the map? */
      mapHas(x: number, z: number): boolean;
      /**
       * The open chart's viewport in world coordinates, or null when closed.
       * Lets a harness assert the pan clamp with numbers instead of a human
       * deciding from a screenshot whether a drag went too far.
       */
      mapView(): {
        cx: number; cz: number; mPerPx: number; w: number; h: number;
        x0: number; z0: number; x1: number; z1: number;
      } | null;
      /** Per-frame chart cost (ms): tile baking and canvas repaint. */
      mapProfile(): { work: number; draw: number; pending: number }[];
      resetMapProfile(): void;
      /** Landmark names the chart would show right now. */
      mapLandmarks(): { kind: string; name: string; x: number; z: number }[];
      /**
       * Where the controller's focus ring is. Read-only, and nothing in
       * input/ui-focus.ts consults it — a release build with no `__gameDebug`
       * navigates identically. `osk` counts on-screen-keyboard attempts, which
       * is the only way to prove that beat outside a Deck.
       */
      padFocus(): {
        context: string | null; index: number; id: string;
        label: string; count: number; osk: number;
      };
      // --- Castle Vhaeron (the opening) ---
      /** Alarm phase, chest state, motte height, which storey you are on. */
      castle(): Record<string, unknown>;
      /** Every named point in the castle, for teleporting and screenshots. */
      castleMarkers(): string[];
      /**
       * World position of a named castle marker.
       *
       * Harnesses must read routes through this, NOT by teleporting and
       * sampling `__gameStats.playerPos` — that block is rebuilt on a 500 ms
       * timer, so a rapid teleport reads the PREVIOUS position and the route
       * silently walks to wherever the player already was.
       */
      castleMarkerPos(marker: string): [number, number, number] | null;
      /** Teleport to a named castle marker. False when the name is unknown. */
      castleTeleport(marker: string): boolean;
      /** True when a box (x±r, z±r, [y0,y1]) is inside castle masonry. */
      castleSolidAt(x: number, z: number, r: number, y0: number, y1: number): boolean;
      /**
       * The same question for settlements: would a flier of radius `r` with its
       * feet at `y0` be inside a wall, hut or fence here? `settlementBlockers`
       * hands back the raw boxes for a harness that wants to judge a result
       * against the collision volumes rather than by eye, and `flierSupport`
       * is what a descending flier will land on.
       */
      settlementSolidAt(x: number, z: number, r: number, y0: number): boolean;
      settlementSupportAt(
        x: number, z: number, r: number, y: number, reach?: number): number;
      /** Put the player back at the game-start spawn in the undercroft. */
      castleRespawnAtStart(): void;
      /** Take the starter kit without walking to the chest. */
      castleOpenChest(): void;
      /**
       * Drive the alarm directly. `'depart'` teleports far enough away to trip
       * the leave test; `'return'` brings you back. Used by the aggro proof so
       * it tests the real transition rather than a poked field.
       */
      castleAlarmStep(action: 'depart' | 'return'): string;
      /** The king's dragon: where it is and whether it is hostile. */
      castleDragon(): {
        id: string; x: number; y: number; z: number; yaw: number; mode: string;
      } | null;
      /** The Evil King himself, riding it. Same shape as castleDragon. */
      castleKing(): {
        id: string; x: number; y: number; z: number; yaw: number; mode: string;
      } | null;
      /**
       * Every garrison post: where it is, which marker it guards, whether it
       * is live in the world right now, and whether it has been killed.
       */
      castleGarrison(): Record<string, unknown>[];
      /**
       * The boss fight as numbers: phase, breath stage, the latched aim point,
       * both bosses' health, and the player's. Everything a harness needs to
       * assert that the fight is really happening rather than looking active.
       */
      castleFight(): Record<string, unknown>;
      /** Damage a boss through the real damage path. Returns its new hp. */
      castleDamageBoss(which: 'king' | 'dragon', amount: number): number | null;
      /** Last frame's creature-mesh rebuild accounting, against the budget. */
      entityFrameCost(): {
        drawn: number; wanted: number; spent: number; forced: number;
        ms: number; budget: number;
      };
      /** Move an entity to an exact position, including airborne. */
      setEntityPos(id: string, x: number, y: number, z: number): boolean;
    };
  }
}

const WORLD_SEED = 1337;
// The procedural score (src/game/music/**). Constructed on the first user
// gesture in resumeAudio(); state-driven from the frame loop's music mount.
import { createMusic, type MusicEngine } from './music';
import { SETTLEMENT_RADIUS } from './settlement/settlement-scatter';
import type { MusicState } from './music/state';
/**
 * Thirst restored by drinking at a settlement well. A river gives 40; drawn
 * water is clean and cold, so walking to a well is never the worse choice.
 */
const WELL_QUENCH = 55;
const SIM_DT = 1 / 60;      // fixed simulation timestep (s)
const MAX_ACCUM = 0.25;     // clamp after tab-switch stalls (s)

// Start the cycle mid-morning so the first minutes of play are in daylight.
const TOD_START = 0.30;
const PLAYER_HEIGHT = 1.7;
const DUNGEON_FOG: Vec3 = [0.02, 0.02, 0.03];
const DUNGEON_FOG_DENSITY = 0.05;
// Interiors ignore the day-night cycle: fixed neutral fill so the player
// mesh (terrain pipeline) stays visible regardless of surface time.
const DUNGEON_SUN_DIR: Vec3 = normalize([0.45, 0.8, 0.3]);
const DUNGEON_SUN: Vec3 = [0.55, 0.55, 0.58];
const DUNGEON_AMBIENT = 0.30;

/** Map biome + day/night to a temperature bias for the vitals model. */
function biomeOffsetFor(biome: import('./biome').Biome, isNight: boolean): number {
  switch (biome) {
    case 'desert':         return isNight ? -0.5 : 1.8;
    case 'jungle':         return 1.0;
    case 'alpine':         return -2.2;
    case 'mountain_forest':return -1.0;
    case 'beach':
    case 'ocean':          return 0.2;
    default:               return 0; // plains, forest, dense_forest
  }
}

function setError(context: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  if (window.__gameError == null) window.__gameError = `${context}: ${msg}`;
  reportError(`game-${context}`, err);
  console.error(`[game] ${context}:`, err);
}

/** Player character: CPU-posed blocky mesh in a persistent vertex buffer. */
function createPlayerCharacter(renderer: Renderer): {
  draw: TerrainDraw; vertexBuffer: GPUBuffer; objectBuffer: GPUBuffer;
} {
  const vertexBuffer = renderer.device.createBuffer({
    label: 'character-mesh',
    size: CHARACTER_MAX_VERTS * STRIDE_CREATURE, // pos3+normal3+colour3+materialId
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  const { bindGroup, buffer, shadowBindGroup } =
    renderer.createObjectBindGroup(0, 0, 0, 1, undefined, MATERIALS.KNIT);
  return {
    draw: { vertexBuffer, indexBuffer: null, count: 0, bindGroup, shadowBindGroup },
    vertexBuffer,
    objectBuffer: buffer,
  };
}

async function boot() {
  window.__gameError = null;
  window.__gameReady = false;
  window.__gameStats = { frameCount: 0, fps: 0, chunkCount: 0 };

  // ?wipe=1 — blank slate: delete EVERY artifex-* localStorage key (live game
  // state, all save slots, NPC memory/conversations, director caches, UI
  // prefs) before any system loads. Model weights in the Cache API are kept —
  // they're machine cache, not game data. The param is stripped afterwards so
  // a plain reload doesn't wipe again.
  if (debugParams().get('wipe') !== null) {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k !== null && k.startsWith('artifex-')) doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
    console.log(`[wipe] cleared ${doomed.length} artifex-* keys — blank slate`);
    const url = new URL(location.href);
    url.searchParams.delete('wipe');
    history.replaceState(null, '', url);
  }

  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  const hud = document.getElementById('hud')!;
  const overlay = document.getElementById('overlay')!;

  // --- pause + world map ---------------------------------------------------
  //
  // Declared up here, ahead of everything that reads them, because the very
  // first thing the chunk streamer does is ask `gameNowMs()` whether a tree is
  // still standing — `chunkManager.treeFilter` closes over it.
  //
  // One clock owns the accumulator AND the pause, because the two cannot be
  // separated without banking wall time behind the pause. See sim-clock.ts.
  const simClock = new SimClock(performance.now(), SIM_DT, MAX_ACCUM);
  /**
   * Wall-clock epoch ms with paused spans removed.
   *
   * `simTime` freezes on its own while paused because it only advances inside
   * the step loop, but the handful of systems on `Date.now()` — resource-node
   * respawn, jail sentences — would not: ten minutes on the pause screen would
   * respawn every ore vein and serve out any sentence. Every gameplay timer
   * reads this instead. Save-slot timestamps and UI animation still use
   * `Date.now()` directly, because those describe the real world outside the
   * game and should keep running while it does not.
   */
  const gameNowMs = (): number => Date.now() - simClock.lostMs;

  /** Fog of war: which 64 m chunks the player has been to. */
  const discovery = loadDiscovery();
  /** Re-reveal after this much movement (m). One reveal covers 128 m. */
  const REVEAL_STEP = 16;
  let lastRevealX = Infinity;
  let lastRevealZ = Infinity;
  let discoveryDirty = false;
  let lastDiscoverySaveMs = 0;

  const gpu = await initWebGPU();
  gpu.device.addEventListener('uncapturederror', (ev) => {
    setError('uncaptured', (ev as GPUUncapturedErrorEvent).error.message);
  });
  gpu.device.lost.then((info) => {
    if (info.reason !== 'destroyed') setError('device-lost', info.message);
  });

  const renderer = new Renderer(gpu, canvas);
  const heightField = createHeightField(WORLD_SEED);
  const biomeField = createBiomeField(WORLD_SEED, heightField);
  const chunkManager = new ChunkManager(renderer, heightField, biomeField);
  const player = createPlayerCharacter(renderer);

  // --- player, cameras, input ---------------------------------------------
  const mid = CHUNK_SIZE / 2;
  const SPAWN_POS: [number, number, number] = [mid, heightField.heightAt(mid, mid) + 2, mid];
  // Save/Load: a just-loaded save stages position + sim time under RESUME_KEY.
  // Fallback: the crash-recovery autosave (refreshed every few seconds while
  // playing) so an unexpected reload — GPU device loss, browser crash —
  // resumes in place instead of resetting to spawn.
  const resumeState = consumeResume() ?? readAutoPos();
  const settlementManager =
    new SettlementManager(renderer, heightField, WORLD_SEED);
  // Outdoor world = terrain + settlement walls/platforms layered on top.
  //
  // Ground CONTACT reads `chunkManager.ground`, the height field with roads
  // graded into it — not the base one. A road cuts and fills up to 2.5 m, and
  // against the uncarved field the player floats above or sinks into every
  // cutting (measured mean error 0.52-1.34 m, worst 3.24 m).
  //
  // `SettlementManager` above and the raw `heightField` deliberately keep the
  // BASE field. Feeding the carved one to settlement placement is circular:
  // `settlementSiteAt` accepts the first candidate clearing a height and
  // flatness budget, so 2.5 m of road fill can flip a previously-rejected
  // candidate and the game then places the settlement somewhere the road was
  // never built to. Measured at roughly 1 cell in 800 before the split.
  const terrainWorld = settlementGround(
    terrainGround(chunkManager.ground), () => settlementManager.nearby());

  // The opening: Castle Vhaeron. Its collider LAYERS OVER terrainWorld and is
  // what everything downstream collides against — including the dungeon and
  // building managers, which restore `controller.world = this.terrain` on exit
  // and would otherwise drop castle collision the moment you left a building.
  //
  // It is built before the controller because the controller needs a world,
  // and attached to the controller afterwards because the collider needs the
  // player's live height to know which storey they are standing on.
  const castleManager = new CastleManager(renderer, heightField, terrainWorld);
  const castleWorldQuery = castleWorld(castleManager);
  // A fresh game starts in the castle's undercroft, not in open wilderness.
  // A resumed one starts wherever the player was.
  const START_POS = castleManager.spawnPoint();
  const controller = new PlayerController(castleWorldQuery,
    resumeState !== null ? [resumeState.x, resumeState.y, resumeState.z] : START_POS);
  // Carved ground too: the camera clamps against terrain, and on the base
  // field it would clip into the walls of a road cutting.
  const orbitCam = new OrbitCamera(chunkManager.ground);
  castleManager.attach(controller, orbitCam);

  /**
   * The point the orbit camera hangs off the player.
   *
   * One function, two callers: the frame's view matrix and the aim resolve.
   * They must agree exactly — the crosshair sits on the ray the frame was
   * rendered from, and a second copy of `PLAYER_HEIGHT * 0.85` in the aim path
   * is a silent aiming error waiting for someone to retune the camera.
   */
  function camAnchor(): Vec3 {
    return add(controller.pos, [0, PLAYER_HEIGHT * 0.85, 0]);
  }
  const flyCam = new FlyCamera(add(controller.pos, [0, 20, 30]));
  let flyMode = false;

  // Portrait mode (debug/harness only): orbit a creature instead of the player,
  // hide the player mesh, and hold every animal at idle. Without it the capture
  // harness photographs the back of the player's head, and spawning a dragon
  // for its portrait mauls the photographer before the shutter fires.
  let portraitEntityId: string | null = null;

  // Character customization: persisted palette choices, panel on C.
  let custom = loadCustomization();

  // Player inventory: 28 pack + 5 hotbar slots, spawn kit on first run.
  const inventory = loadInventory();
  // The Tintreach shot counter — the seed every bolt's jitter is drawn from,
  // so persisting it is what makes bolt #7 look the same after a reload.
  loadTintreach();

  // Vitals: HP, thirst, stamina, temperature. Loaded from localStorage.
  let vitals: Vitals = loadVitals();
  let vitalsSaveAccum = 0; // throttled save every ~2 s
  const VITALS_SAVE_INTERVAL = 2;

  // -------------------------------------------------------------------------
  // Feature: Audio engine (Feature 10)
  // -------------------------------------------------------------------------
  const audio = new GameAudio();

  // Settings → audio buses. `subscribe` fires immediately, so this is also the
  // initial application: one path for "apply live" and "restore on boot", which
  // is what keeps the two from drifting.
  settings.subscribe((st) => {
    audio.setVolume(st.volMaster);
    audio.setBusVolume('music', st.volMusic);
    audio.setBusVolume('sfx', st.volSfx);
    audio.setBusVolume('voice', st.volVoice);
  });

  // ---- Villager voices (speech out) --------------------------------------
  // Synthesis runs in a worker on ORT wasm — never the GPU queue, which the
  // renderer and the NPC LLM already contend for. See src/game/voice/tts-worker.ts.
  const voiceOut = new VoiceOut({
    output: () => audio.voiceBus(),
    enabled: () => settings.get().voiceEnabled && !audio.muted,
  });
  setVoiceOut(voiceOut);
  // Turning speech off mid-sentence must actually stop the sentence.
  settings.subscribe((st) => { if (!st.voiceEnabled) voiceOut.stop(); });

  // ---- Music mount point (parallel work — src/game/music/**) --------------
  // The `music` bus above exists and is wired to the Settings slider already;
  // nothing routes into it yet. When the music engine lands it needs exactly
  // two things from this file: construction next to `audio` with
  // `audio.musicBus()` as its destination, and one `music.update(state)` call
  // per frame in the render loop (see the matching marker there). Deliberately
  // left as a comment rather than a stub object so there is no dead interface
  // to keep in sync.

  // Restore mute state from localStorage.
  const AUDIO_MUTE_KEY = 'artifex-audio-muted:v1';
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(AUDIO_MUTE_KEY);
      if (saved === 'true') audio.muted = true;
    }
  } catch { /* storage unavailable */ }

  // Resume on first user gesture (browser autoplay policy).
  let audioResumed = false;
  let music: MusicEngine | null = null;
  function resumeAudio() {
    if (audioResumed) return;
    audioResumed = true;
    audio.resume();
    // Seeded from the world seed: a given world always has the same score,
    // the same property every other generated thing here has. Routed into
    // the `music` bus so the Settings slider and the M mute both apply.
    const mb = audio.musicBus();
    if (mb) music = createMusic(mb.ctx, WORLD_SEED, { destination: mb.node });
  }
  document.addEventListener('pointerdown', resumeAudio, { once: true });
  document.addEventListener('keydown', resumeAudio, { once: true });

  // Track previous swim state to detect entry into water (for splash SFX).
  let prevSwimming = false;
  // Track previous grounded state for fall-damage landing detection.
  let prevGrounded = true;
  // Track previous velY to capture peak impact speed.
  let prevVelY = 0;
  // Footstep throttle: play every ~0.45 s of movement.
  let footstepAccum = 0;
  // Track previous dungeon state for entity aggro reset on exit.
  let prevInDungeon = false;

  // Phase N: timed effects (potions / dishes). Loaded from localStorage.
  function loadEffectsState(): EffectsState {
    try {
      const raw = localStorage.getItem(EFFECTS_STORAGE_KEY);
      if (raw !== null) {
        const s = deserializeEffects(raw);
        if (s !== null) return s;
      }
    } catch { /* storage unavailable */ }
    return createEffects();
  }
  function saveEffectsState(s: EffectsState): void {
    try { localStorage.setItem(EFFECTS_STORAGE_KEY, serializeEffects(s)); } catch { /* quota */ }
  }
  let effectsState: EffectsState = loadEffectsState();

  // Phase 60: looted nest id registry.
  const NESTS_KEY = 'artifex-nests:v1';
  function loadLootedNests(): Set<string> {
    try {
      const raw = localStorage.getItem(NESTS_KEY);
      if (raw !== null) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return new Set(arr as string[]);
      }
    } catch { /* storage unavailable */ }
    return new Set();
  }
  function saveLootedNests(s: Set<string>): void {
    try { localStorage.setItem(NESTS_KEY, JSON.stringify([...s])); } catch { /* quota */ }
  }
  const lootedNests: Set<string> = loadLootedNests();

  // -------------------------------------------------------------------------
  // Phase M: crime / bounty / jail state
  // -------------------------------------------------------------------------
  const JAIL_KEY = 'artifex-jail:v1';

  interface JailRecord {
    jailedUntilMs: number;
    regionId: string;
  }

  function loadJailState(): JailRecord | null {
    try {
      const raw = localStorage.getItem(JAIL_KEY);
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null) return null;
      const p = parsed as Record<string, unknown>;
      if (typeof p.jailedUntilMs !== 'number' || typeof p.regionId !== 'string') return null;
      return { jailedUntilMs: p.jailedUntilMs, regionId: p.regionId };
    } catch { return null; }
  }

  function saveJailState(rec: JailRecord | null): void {
    try {
      if (rec === null) { localStorage.removeItem(JAIL_KEY); }
      else { localStorage.setItem(JAIL_KEY, JSON.stringify(rec)); }
    } catch { /* quota */ }
  }

  let crimeState: CrimeState = loadCrimeState();
  /**
   * Spatial index of who is fighting whom, rebuilt once per tick.
   *
   * Shared by every entity's target selection so mob-to-mob combat is one
   * pass rather than an O(n^2) scan per creature per tick. The PLAYER is
   * deliberately absent from it — that is one of the two things stopping a
   * tamed mount from ever turning on its rider (the other is `isOwned`
   * short-circuiting the aggro path), and both are tested.
   */
  const combatIndex = new CombatIndex();

  /**
   * Melee turn-taking for everything that swings at the player above ground —
   * see `combat/attack-tokens.ts`.
   *
   * The dungeon has its own pool inside `DungeonCombat`, and the two never
   * both matter: `tickEntities` returns early while the player is underground,
   * so exactly one of them is advancing on any given tick.
   */
  const meleeTokens = new MeleeTokenPool();

  /**
   * Arbitration on/off, for A/B measurement only (`__gameDebug.setAttackTokens`).
   * Always true in play — nothing in the shipping game turns it off.
   */
  let meleeTokensOn = true;

  /**
   * Ring buffer of blows landed on the player: who, and when in sim time.
   *
   * Preallocated and overwritten in place rather than pushed to, because this
   * writes from the damage path. It is bounded at 256 entries — about a minute
   * of a losing fight — which is all any harness needs to compute a windowed
   * attacker count. The write is two stores and a modulo; it stays in the
   * shipping build so the numbers a harness reads come from the same code the
   * player runs, and `__gameDebug` (the only reader) is what strips in release.
   */
  // -------------------------------------------------------------------------
  // The guard — see `combat/shields.ts` for every rule; this is only the state.
  // -------------------------------------------------------------------------

  /** Press-edge bookkeeping for the parry window. Sim-timed, never wall-clock. */
  const guard = createGuard();

  /** 0..1 eased visual guard, so the arm swings up instead of snapping. */
  let guardBlend = 0;

  /** Counters the harnesses read. Not gameplay — nothing branches on these. */
  const guardStats = { blocked: 0, parried: 0, brokeGuard: 0, flanked: 0 };
  /** The most recent resolution, for `__gameDebug.guardState()`. */
  let lastBlock: BlockOutcome | null = null;

  /**
   * Sim time of the last parry, or -Infinity. Drives the thread-spark.
   *
   * A timestamp rather than a countdown so the effect is derived from the sim
   * clock instead of accumulating its own: a paused game freezes the spark
   * mid-burst for free, and there is no second timer to forget to tick.
   */
  let parrySparkAtS = -Infinity;

  /**
   * The best shield in the HOTBAR, or null.
   *
   * The hotbar, not the selected slot: a shield coexists with your weapon, so
   * requiring it to be selected would mean choosing between blocking and
   * hitting back, and the cost of the feature is meant to be the SLOT, not the
   * hand. The pack proper is excluded for the same reason a sword in your
   * backpack does not swing — five slots is the loadout, and reaching past it
   * would make the slot cost nothing.
   */
  function shieldTier(): ShieldTier | null {
    return bestShieldTier(inventory.hotbar.map((s) => s?.id ?? null));
  }

  /**
   * True when the shield is actually up: carrying one, holding the input, and
   * alive to hold it.
   *
   * AN OPEN PANEL IS DELIBERATELY NOT IN THIS LIST, and it was at first. The
   * gate belongs on RAISING the guard, not on holding it — the RMB listener
   * already refuses while a panel is open, because there the right button
   * belongs to the inventory. But a guard that was already up when you opened
   * your map has no business falling: the button is still down, the sim is
   * still running for anything that does not pause it, and a shield that
   * silently stops working because you glanced at the chart is a bug the player
   * would only ever discover by dying.
   *
   * It also keeps the parry window honest across a pause. The window is a
   * difference of two sim times; the sim clock stops; therefore pausing can
   * neither eat the window nor extend it. Dropping the guard on a panel would
   * have replaced that clean property with "pausing cancels your block", which
   * is a different rule wearing the same clothes.
   */
  function blocking(): boolean {
    return guard.down && shieldTier() !== null && vitals.alive && !flyMode;
  }

  const ATTACK_LOG_N = 256;
  const attackLogId: string[] = new Array<string>(ATTACK_LOG_N).fill('');
  const attackLogT = new Float64Array(ATTACK_LOG_N);
  let attackLogW = 0;
  const noteAttackOnPlayer = (id: string, t: number): void => {
    attackLogId[attackLogW] = id;
    attackLogT[attackLogW] = t;
    attackLogW = (attackLogW + 1) % ATTACK_LOG_N;
  };

  /** Shared, per-settlement memory of what the player did in front of whom. */
  const villageMemory = loadVillageMemory();
  /** Shared knowledge a settlement holds in common — lore, and its concerns. */
  const villageFacts = loadVillageFacts();
  let jailRecord: JailRecord | null = loadJailState();

  /** Stable region id from nearest settlement (name-based). */
  function nearestRegionId(): string {
    const info = settlementManager.nearestSettlement();
    return info ? info.name : 'wilderness';
  }

  /** Nearest settlement resolved data (for jail pad lookup). */
  function nearestResolvedSettlement(kind?: string): import('./settlement/settlement-layout').ResolvedSettlement | null {
    const site = settlementManager.findNearestSite(
      controller.pos[0], controller.pos[2], kind ? 6 : 4);
    if (site === null) return null;
    if (kind && site.kind !== kind) {
      // Try wider ring for a specific kind
      let best2: import('./settlement/settlement-scatter').SettlementSite | null = null;
      let bestD = Infinity;
      for (let dz = -6; dz <= 6; dz++) {
        for (let dx = -6; dx <= 6; dx++) {
          const scx = Math.floor(controller.pos[0] / 512) + dx;
          const scz = Math.floor(controller.pos[2] / 512) + dz;
          const s = settlementManager.findNearestSite(
            scx * 512 + 256, scz * 512 + 256, 1);
          if (s === null) continue;
          if (s.kind !== kind) continue;
          const d = Math.hypot(controller.pos[0] - s.x, controller.pos[2] - s.z);
          if (d < bestD) { bestD = d; best2 = s; }
        }
      }
      if (best2 === null) return null;
      const key = `${Math.floor(best2.x / 512)},${Math.floor(best2.z / 512)}`;
      return (settlementManager as unknown as {
        active: Map<string, { resolved: import('./settlement/settlement-layout').ResolvedSettlement }>;
      }).active.get(key)?.resolved ?? null;
    }
    const key = `${Math.floor(site.x / 512)},${Math.floor(site.z / 512)}`;
    return (settlementManager as unknown as {
      active: Map<string, { resolved: import('./settlement/settlement-layout').ResolvedSettlement }>;
    }).active.get(key)?.resolved ?? null;
  }

  /** Find the nearest jail pad world position; falls back to settlement center. */
  function findJailPad(regionId: string): [number, number, number] | null {
    // Walk all active settlements; find one whose name matches the regionId.
    const nearby = settlementManager.nearby();
    for (const res of nearby) {
      if (res.name !== regionId) continue;
      const jailPad = res.pads.find(p => p.type === 'jail');
      if (jailPad) {
        return [jailPad.wx, jailPad.wy + 0.1, jailPad.wz];
      }
      // No jail pad: place inside center of settlement
      return [res.site.x, heightField.heightAt(res.site.x, res.site.z) + 0.1, res.site.z];
    }
    // Fallback: use nearest settlement
    const info = settlementManager.nearestSettlement();
    if (info) {
      for (const res of nearby) {
        if (res.name !== info.name) continue;
        const jailPad = res.pads.find(p => p.type === 'jail');
        if (jailPad) return [jailPad.wx, jailPad.wy + 0.1, jailPad.wz];
      }
    }
    return null;
  }

  /** Confiscate player inventory and re-grant the spawn kit. */
  function confiscateInventory(): void {
    // Clear all pack slots
    for (let i = 0; i < inventory.pack.length; i++) inventory.pack[i] = null;
    // Clear all hotbar slots
    for (let i = 0; i < inventory.hotbar.length; i++) inventory.hotbar[i] = null;
    // Clear armor slots
    inventory.armor.head = null;
    inventory.armor.body = null;
    inventory.armor.legs = null;
    // Re-grant spawn kit
    inventory.hotbar[0] = { id: 'bronze_axe', count: 1 };
    inventory.hotbar[1] = { id: 'bronze_pickaxe', count: 1 };
    inventory.hotbar[2] = { id: 'fire_starter', count: 1 };
    saveInventory(inventory);
    hotbar.refresh();
  }

  // Guard enforcement constants
  const GUARD_APPROACH_DIST  = 40;   // m — guards start chasing at this range
  const GUARD_ARREST_DIST    = 2.5;  // m — arrest panel triggers at this range
  const GUARD_HOSTILE_SPEED  = 7;    // m/s when chasing
  const GUARD_MELEE_DMG      = 2;    // hp per hit
  const GUARD_MELEE_PERIOD   = 1.2;  // seconds between hits
  const GUARD_MELEE_DIST     = 2.5;  // m

  // --- guard archery -------------------------------------------------------
  // The world had no ranged attacker at all, which made "melee cannot reach a
  // mounted rider" a strictly-better deal with no downside: climb onto
  // anything and nothing in the world could touch you. A hostile guard who
  // cannot close now looses arrows instead, and an arrow reaches the saddle
  // (attack-routing.ts). That is what turns flight into a trade-off — you are
  // out of reach of teeth, and squarely in the open for anything with a bow.
  const GUARD_BOW_RANGE      = 34;   // m — max shooting distance
  const GUARD_BOW_MIN_RANGE  = 4;    // m — inside this a guard just swings
  const GUARD_BOW_PERIOD     = 2.4;  // seconds between shots per guard
  const GUARD_ARROW_DMG      = 3;    // hp per arrow
  const GUARD_ARROW_SPEED    = 30;   // m/s

  /** Whether any guard is currently hostile (after player resisted arrest). */
  let guardsHostile = false;
  /** Accumulator for guard melee cooldown. */
  let guardMeleeAccum = 0;
  /** Whether the arrest panel is currently showing. */
  let arrestPanelOpen = false;

  // Jail HUD (sentence countdown)
  const jailHud = (() => {
    const el = document.createElement('div');
    el.id = 'jail-hud';
    el.style.cssText = [
      'position:fixed', 'top:10px', 'right:10px', 'z-index:15',
      'background:rgba(10,14,20,0.82)',
      'color:#e8c97a',
      'font:600 13px system-ui,sans-serif',
      'padding:6px 14px',
      'border-radius:8px',
      'border:1px solid rgba(205,214,228,0.18)',
      'display:none',
      'user-select:none',
      'pointer-events:none',
    ].join(';');
    document.body.appendChild(el);
    return el;
  })();

  function updateJailHud(): void {
    if (jailRecord === null || gameNowMs() >= jailRecord.jailedUntilMs) {
      jailHud.style.display = 'none';
      return;
    }
    const remainS = Math.ceil((jailRecord.jailedUntilMs - gameNowMs()) / 1000);
    jailHud.textContent = `Jailed: ${remainS}s remaining`;
    jailHud.style.display = 'block';
  }

  /** Called each tick while the player is jailed. Handles release + position clamping. */
  function tickJail(): void {
    if (jailRecord === null) return;
    const now = gameNowMs();

    if (now >= jailRecord.jailedUntilMs) {
      // Sentence served: clear bounty, confiscate inventory, release.
      const rid = jailRecord.regionId;
      serveSentence(crimeState, rid);
      saveCrimeState(crimeState);
      confiscateInventory();
      guardsHostile = false;
      jailRecord = null;
      saveJailState(null);
      setGatherNotice('Sentence served. Your belongings were confiscated.');
      // Move player slightly outside the jail
      controller.pos[0] += 4;
      controller.velY = 0;
      return;
    }

    // Clamp player inside jail area (simple: keep within 5 m of jail pad)
    const jailPos = findJailPad(jailRecord.regionId);
    if (jailPos !== null) {
      const dx = controller.pos[0] - jailPos[0];
      const dz = controller.pos[2] - jailPos[2];
      const dist = Math.hypot(dx, dz);
      const JAIL_RADIUS = 5;
      if (dist > JAIL_RADIUS) {
        const scale = JAIL_RADIUS / dist;
        controller.pos[0] = jailPos[0] + dx * scale;
        controller.pos[2] = jailPos[2] + dz * scale;
        controller.velY = Math.min(0, controller.velY);
      }
    }
  }

  /** Try to open the arrest panel for a given guard runtime. */
  function openArrestPanel(rid: string, bounty: number): void {
    if (arrestPanelOpen || panels.isOpen) return;
    arrestPanelOpen = true;

    // Exit pointer lock so mouse can click buttons. Through the helper, or the
    // pointerlockchange handler reads it as an Escape and pauses on top of the
    // arrest panel.
    releasePointerLock();

    const el = document.createElement('div');
    el.id = 'arrest-panel';

    const ARREST_CSS = `
#arrest-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 280px;
}
#arrest-panel h2 {
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 700;
  color: #e04040;
}
#arrest-panel .arrest-info {
  font-size: 13px;
  color: #cdd6e4;
  margin-bottom: 4px;
}
#arrest-panel .arrest-btn {
  background: rgba(205,214,228,0.10);
  color: #cdd6e4;
  border: 1px solid rgba(205,214,228,0.25);
  border-radius: 6px;
  padding: 8px 14px;
  font: 600 13px system-ui,sans-serif;
  cursor: pointer;
  text-align: left;
}
#arrest-panel .arrest-btn:hover { opacity: 0.8; }
#arrest-panel .arrest-btn.pay { border-color: #4ad48a; color: #4ad48a; }
#arrest-panel .arrest-btn.jail { border-color: #e8c97a; color: #e8c97a; }
#arrest-panel .arrest-btn.resist { border-color: #e04040; color: #e04040; }
`;
    if (!document.getElementById('arrest-css')) {
      const style = document.createElement('style');
      style.id = 'arrest-css';
      style.textContent = ARREST_CSS;
      document.head.appendChild(style);
    }

    const title = document.createElement('h2');
    title.textContent = 'You are under arrest!';
    el.appendChild(title);

    const goldHave = countItem(inventory, 'gold_small');
    const info = document.createElement('div');
    info.className = 'arrest-info';
    info.id = 'arrest-info';
    info.textContent = `Bounty: ${bounty} gold  |  You have: ${goldHave} gold`;
    el.appendChild(info);

    function closeArrest(): void {
      panels.close();
      arrestPanelOpen = false;
    }

    const payBtn = document.createElement('button');
    payBtn.className = 'arrest-btn pay';
    payBtn.id = 'arrest-pay';
    payBtn.textContent = `Pay Bounty (${bounty} gold)`;
    if (goldHave < bounty) payBtn.disabled = true;
    payBtn.addEventListener('click', () => {
      const have = countItem(inventory, 'gold_small');
      if (have < bounty) return;
      removeItem(inventory, 'gold_small', bounty);
      invChanged();
      payBounty(crimeState, rid, bounty);
      saveCrimeState(crimeState);
      guardsHostile = false;
      setGatherNotice('Bounty paid. You are free to go.');
      closeArrest();
    });
    el.appendChild(payBtn);

    const jailBtn = document.createElement('button');
    jailBtn.className = 'arrest-btn jail';
    jailBtn.id = 'arrest-jail';
    jailBtn.textContent = `Go to Jail (${jailSentenceS(bounty).toFixed(0)}s)`;
    jailBtn.addEventListener('click', () => {
      sendToJail(rid, bounty);
      closeArrest();
    });
    el.appendChild(jailBtn);

    const resistBtn = document.createElement('button');
    resistBtn.className = 'arrest-btn resist';
    resistBtn.id = 'arrest-resist';
    resistBtn.textContent = 'Resist Arrest';
    resistBtn.addEventListener('click', () => {
      guardsHostile = true;
      setGatherNotice('Guards turn hostile!');
      closeArrest();
      // Re-lock pointer so player can fight
      canvas.requestPointerLock();
    });
    el.appendChild(resistBtn);

    panels.toggle('arrest', () => el);
  }

  /** Teleport player to jail and start the sentence timer. */
  function sendToJail(rid: string, bounty: number): void {
    const sentenceS = jailSentenceS(bounty);
    const nowMs = gameNowMs();
    jailRecord = { jailedUntilMs: nowMs + sentenceS * 1000, regionId: rid };
    saveJailState(jailRecord);
    // Clear bounty immediately (not on release — release confiscates instead)
    // Per spec: bounty cleared on release; here we just lock the player in.
    // Actually per spec: "on release: bounty cleared, ALL inventory confiscated"
    // So we keep bounty until release.

    // Teleport to jail pad
    const jailPos = findJailPad(rid);
    if (jailPos !== null) {
      controller.pos = [jailPos[0], jailPos[1], jailPos[2]];
      controller.velY = 0;
    }
    guardsHostile = false;
    setGatherNotice(`Jailed for ${sentenceS.toFixed(0)} seconds.`);

    // Add a rusty_key inside the jail for potential escape
    addItem(inventory, 'rusty_key', 1);
    invChanged();
    setGatherNotice(`Jailed for ${sentenceS.toFixed(0)} seconds. (A rusty key was left by a previous prisoner.)`);
  }

  /**
   * Loose an arrow from a hostile guard at the player.
   *
   * Aimed with a ballistic lead rather than a straight line: at 30 m the drop
   * over the flight is about 1.5 m, so a flat shot passes under a standing
   * player and a long way under a mounted one. Solving for the launch pitch
   * that lands on the target is what makes a guard on the ground a credible
   * threat to a rider in the air instead of a source of arrows in the dirt.
   */
  function fireGuardArrow(rt: NpcRuntime): void {
    const tx = controller.pos[0];
    const ty = controller.pos[1] + 1.0; // chest
    const tz = controller.pos[2];
    const sx = rt.wx;
    const sy = rt.wy + 1.3; // shoulder height
    const sz = rt.wz;
    const dx = tx - sx, dy = ty - sy, dz = tz - sz;
    const horiz = Math.hypot(dx, dz);
    if (horiz < 0.01) return;
    const v = GUARD_ARROW_SPEED;
    // Ballistic solution for the low-arc launch angle. Falls back to a direct
    // line when the target is out of the projectile's reach entirely.
    const g = 9.8;
    const disc = v * v * v * v - g * (g * horiz * horiz + 2 * dy * v * v);
    let pitch: number;
    if (disc >= 0) {
      pitch = Math.atan((v * v - Math.sqrt(disc)) / (g * horiz));
    } else {
      pitch = Math.atan2(dy, horiz);
    }
    const yaw = Math.atan2(dx / horiz, -(dz / horiz));
    const cp = Math.cos(pitch);
    rt.yaw = yaw;
    spawnProjectile(projectilePool, {
      kind: 'arrow',
      team: 'enemy',
      x: sx, y: sy, z: sz,
      vx: Math.sin(yaw) * cp * v,
      vy: Math.sin(pitch) * v,
      vz: -Math.cos(yaw) * cp * v,
      damage: GUARD_ARROW_DMG,
      nowS: simTime,
    });
    audio.play('swing', { dist: Math.hypot(dx, dz) });
  }

  /** Tick guard enforcement AI (called once per sim step). */
  function tickGuardEnforcement(dtS: number): void {
    if (jailRecord !== null) return; // Already jailed — skip enforcement
    const rid = nearestRegionId();
    const bounty = bountyIn(crimeState, rid);
    if (bounty <= 0 && !guardsHostile) return;

    const px = controller.pos[0];
    const pz = controller.pos[2];

    guardMeleeAccum += dtS;

    for (const rt of npcRuntimes) {
      if (rt.npc.role !== 'guard' || rt.hp <= 0) continue;
      const dist = Math.hypot(rt.wx - px, rt.wz - pz);

      if (guardsHostile) {
        // Chase player
        if (dist <= GUARD_APPROACH_DIST) {
          if (dist > 0.5) {
            const dx2 = px - rt.wx;
            const dz2 = pz - rt.wz;
            const len2 = Math.hypot(dx2, dz2);
            const step = Math.min(GUARD_HOSTILE_SPEED * dtS, len2);
            npcMove(rt, (dx2 / len2) * step, (dz2 / len2) * step);
            rt.yaw = Math.atan2(dx2, -dz2);
            rt.walkPhase += GUARD_HOSTILE_SPEED * dtS * 1.6;
            rt.walkAmp = 1;
          }
          // Melee hit
          // No hits while a panel is up — the player can't move or fight back.
          if (dist <= GUARD_MELEE_DIST && guardMeleeAccum >= GUARD_MELEE_PERIOD &&
              vitals.alive && !panels.isOpen) {
            guardMeleeAccum = 0;
            // Routed: a guard's sword cannot reach a rider in the saddle —
            // it lands on the mount instead (attack-routing.ts).
            // `rt.wy`, not a heightfield sample. The NPC's own foot height is
            // maintained by `npcMove` against `terrainWorld` — the CARVED
            // ground with settlement platforms layered on it — so it is both
            // free and correct. Sampling the raw field instead put the
            // attacker's feet wherever the land was BEFORE the road was cut
            // and the village terraced, which is up to 2.5 m out on a road
            // cutting; the routing test then decided a guard standing on a
            // causeway could not reach a rider it was standing next to.
            // No `id`/`entity`: guards are NPC runtimes, not entities, so there
            // is nothing `staggerAnimal` could be handed. Their blows are still
            // blockable and still parryable — the parry simply buys the zero
            // damage and not the stagger, which is the honest degradation.
            applyAttackOnPlayer(GUARD_MELEE_DMG, 'guard', 'melee', 1.7, rt.wy,
              { x: rt.wx, z: rt.wz, kind: 'melee' });
          }
          // Bow: the answer to a target the guard cannot reach — up a cliff,
          // sprinting away, or thirty metres up on a dragon.
          if (dist > GUARD_BOW_MIN_RANGE && dist <= GUARD_BOW_RANGE
              && vitals.alive && !panels.isOpen) {
            rt.bowCooldown = (rt.bowCooldown ?? Math.random() * GUARD_BOW_PERIOD) - dtS;
            if (rt.bowCooldown <= 0) {
              rt.bowCooldown = GUARD_BOW_PERIOD;
              fireGuardArrow(rt);
            }
          }
        }
      } else if (bounty > 0) {
        // Approach player to arrest
        if (dist <= GUARD_APPROACH_DIST) {
          if (dist > GUARD_ARREST_DIST + 0.3) {
            const dx2 = px - rt.wx;
            const dz2 = pz - rt.wz;
            const len2 = Math.hypot(dx2, dz2);
            const step = Math.min(NPC_WALK_SPEED * dtS * 2, len2);
            npcMove(rt, (dx2 / len2) * step, (dz2 / len2) * step);
            rt.yaw = Math.atan2(dx2, -dz2);
            rt.walkPhase += NPC_WALK_SPEED * dtS * 1.6;
            rt.walkAmp = 1;
          } else if (dist <= GUARD_ARREST_DIST && !panels.isOpen && vitals.alive) {
            // Trigger arrest
            openArrestPanel(rid, bounty);
          }
        }
      }
    }

    // If player died during guard combat → wake in jail
    if (!vitals.alive && guardsHostile && jailRecord === null) {
      // Respawn into jail (sentence served from current bounty)
      const jailBounty = bountyIn(crimeState, rid);
      if (jailBounty > 0) {
        vitals = createVitals();
        saveVitals(vitals);
        isDead = false;
        deathOverlay.style.display = 'none';
        vitalsHud.setVisible(true);
        // Same trap as doRespawn: being carted off to jail from inside a
        // building or dungeon has to tear the interior down first, or you serve
        // the sentence in a void. Both are no-ops when already outdoors.
        dungeonManager.forceExit();
        buildingManager.forceExit();
        sendToJail(rid, jailBounty);
      }
    }
  }

  /** Try rusty_key escape from jail via E key near jail pad door. */
  function tryJailEscape(): boolean {
    if (jailRecord === null) return false;
    if (countItem(inventory, 'rusty_key') < 1) return false;
    const jailPos = findJailPad(jailRecord.regionId);
    if (jailPos === null) return false;
    const dist = Math.hypot(
      controller.pos[0] - jailPos[0],
      controller.pos[2] - jailPos[2],
    );
    if (dist > 4) return false; // must be near jail door

    // Escape: add escape_jail bounty, keep inventory, become free
    const rid = jailRecord.regionId;
    escapeJail(crimeState, rid, simTime);
    saveCrimeState(crimeState);
    jailRecord = null;
    saveJailState(null);
    removeItem(inventory, 'rusty_key', 1);
    invChanged();
    guardsHostile = true; // guards immediately hostile after escape
    controller.pos[0] += 6; // escape outside
    controller.velY = 0;
    setGatherNotice(`Escaped jail! +${BOUNTY_AMOUNTS.escape_jail} bounty. Guards are alerted!`);
    return true;
  }

  // Placed fires and tents: loaded from localStorage, rebuilt into GPU draws when changed.
  const fires: PlacedFire[] = loadFires();
  const tents: PlacedTent[] = loadTents();
  // GPU draw batches for fires and tents (rebuilt on placement/change).
  let fireDraws: import('./renderer').DungeonDraw[] = [];
  let tentDraws: import('./renderer').DungeonDraw[] = [];
  // GPU buffers for fires/tents (destroyed + recreated on rebuild).
  let fireGpuBuffers: GPUBuffer[] = [];
  let tentGpuBuffers: GPUBuffer[] = [];
  // Shared zeroed lights buffer for fire/tent draws (surface mode needs group 2).
  let fireZeroLights: GPUBuffer | null = null;
  let fireZeroLightsBindGroup: GPUBindGroup | null = null;

  function getFireLightsBindGroup(): GPUBindGroup {
    if (fireZeroLightsBindGroup !== null) return fireZeroLightsBindGroup;
    fireZeroLights = renderer.device.createBuffer({
      label: 'fire-zero-lights',
      size: LIGHTS_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    fireZeroLightsBindGroup = renderer.createLightsBindGroup(fireZeroLights);
    return fireZeroLightsBindGroup;
  }

  /**
   * Rebuild GPU draw batches for all fires (called after any placement).
   * Hearth furniture only — stone ring, logs, forge chimney. Flames are
   * per-frame billboards from render/fire-fx.ts and never come through here,
   * so this no longer has to run when a fire merely lights or burns out.
   */
  function rebuildFireDraws(_nowS = 0): void {
    for (const b of fireGpuBuffers) b.destroy();
    fireGpuBuffers = [];
    fireDraws = [];
    const batches = buildFireMeshes(fires);
    const lg = getFireLightsBindGroup();
    for (const { palette, verts } of batches) {
      if (verts.length === 0) continue;
      const vb = renderer.device.createBuffer({
        label: `fire-pal${palette}`,
        size: verts.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      renderer.device.queue.writeBuffer(vb, 0, verts);
      const { bindGroup, shadowBindGroup } = renderer.createObjectBindGroup(0, 0, 0, 100 + palette);
      fireDraws.push({
        draw: { vertexBuffer: vb, indexBuffer: null, count: verts.length / (STRIDE_PROP / 4), bindGroup, shadowBindGroup },
        lightsBindGroup: lg,
      });
      fireGpuBuffers.push(vb);
    }
  }

  /**
   * Queue every flame in the world into the renderer's billboard system and
   * return the point lights they cast (nearest first). One call replaces the
   * old `updateBreathVfx` / `updateBurningVegVfx` per-frame vertex-buffer
   * rewrites and the hand-rolled campfire light list — see render/fire-fx.ts.
   */
  let lastFireBillboards = 0;
  /** Billboards the parry spark queued this frame. Diagnostics + harnesses. */
  let lastParrySparks = 0;
  function emitFireVfx(
    eye: Vec3, indoors: boolean,
    heldTorch: { pos: Vec3; radius: number } | null,
  ): ReturnType<typeof emitWorldFire> {
    renderer.fire.begin(simTime, eye);
    const ray = breathActive && breathJaw >= 0.25 ? getBreathRay() : null;
    // Which flier is breathing decides how the jet looks, not just how far it
    // reaches — see BREATH_SPEC.
    const mountedNow = mountedEntityId === null
      ? undefined : entityManager.entities.get(mountedEntityId);
    const breathVfxSpec = mountedNow === undefined
      ? undefined : BREATH_SPEC[mountedNow.species];
    const lights = emitWorldFire(renderer.fire, {
      fires: indoors ? [] : fires,
      burning: indoors ? [] : getBurningTrees(),
      breath: ray !== null ? {
        mouth: ray.mouth, dir: ray.dir, jaw: breathJaw,
        reach: breathVfxSpec?.reach ?? 1, spark: breathVfxSpec?.spark ?? false,
      } : null,
      // Wild fliers attacking, collected during this frame's AI pass.
      extraBreaths: indoors ? [] : wildBreaths,
      interiorLights: indoors
        ? (dungeonManager.isInside
          ? dungeonManager.activeLights()
          : buildingManager.activeLights())
        : null,
      settlementFlames: indoors
        ? []
        : [...settlementManager.flamePoints(), ...castleManager.flamePoints()],
      heldTorch: heldTorch === null ? null : {
        pos: heldTorch.pos,
        color: TORCH_LIGHT_WORLD,
        radius: heldTorch.radius,
        scale: TORCH_FLAME_SCALE,
        sortKey: TORCH_LIGHT_SORT_KEY,
      },
      nowS: simTime,
      eye,
    });
    // The parry spark, queued into the same billboard system between `begin`
    // and the frame's draw. Position is the SHIELD, not the attacker: the blow
    // was turned aside at the board, so that is where the seam pops. Left arm,
    // chest height, half a metre in front — `controller.yaw` is the mesh facing
    // convention, forward is `(sin yaw, -cos yaw)`, and left is that rotated a
    // quarter turn.
    const sparkAge = simTime - parrySparkAtS;
    if (sparkAge >= 0 && sparkAge < PARRY_SPARK_S) {
      const fy = Math.sin(controller.yaw);
      const fz = -Math.cos(controller.yaw);
      lastParrySparks = emitParrySpark(renderer.fire,
        controller.pos[0] + fy * 0.42 + fz * 0.30,
        controller.pos[1] + PLAYER_HEIGHT * 0.55,
        controller.pos[2] + fz * 0.42 - fy * 0.30,
        sparkAge,
        // Deterministic per parry: the sim time it happened at, quantised to
        // the sim step so every frame of one burst gets the SAME seed and the
        // threads fly along fixed paths instead of re-scattering each frame.
        Math.round(parrySparkAtS * 1000) >>> 0);
    } else {
      lastParrySparks = 0;
    }
    lastFireBillboards = renderer.fire.count;
    return lights;
  }

  /** Rebuild GPU draw batches for all tents (called after any placement). */
  function rebuildTentDraws(): void {
    for (const b of tentGpuBuffers) b.destroy();
    tentGpuBuffers = [];
    tentDraws = [];
    const batches = buildTentMeshes(tents);
    const lg = getFireLightsBindGroup();
    for (const { palette, verts } of batches) {
      if (verts.length === 0) continue;
      const vb = renderer.device.createBuffer({
        label: `tent-pal${palette}`,
        size: verts.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      renderer.device.queue.writeBuffer(vb, 0, verts);
      const { bindGroup, shadowBindGroup } = renderer.createObjectBindGroup(0, 0, 0, 100 + palette);
      tentDraws.push({
        draw: { vertexBuffer: vb, indexBuffer: null, count: verts.length / (STRIDE_PROP / 4), bindGroup, shadowBindGroup },
        lightsBindGroup: lg,
      });
      tentGpuBuffers.push(vb);
    }
  }

  // Initial build for any fires/tents loaded from persistence.
  rebuildFireDraws();
  rebuildTentDraws();
  // Periodically rebuild fire draws so flame shows/disappears as fuel drains.
  let fireRebuildAccum = 0;
  const FIRE_REBUILD_INTERVAL = 5; // seconds
  // Fire-spread proximity checks are throttled to ~1 s ticks.
  let fireSpreadAccum = 0;
  const FIRE_SPREAD_TICK_S = 1;

  // -------------------------------------------------------------------------
  // Phase I: Lightning strike scheduler
  // -------------------------------------------------------------------------
  /** Strikes that have been scheduled but not yet fired. */
  const pendingStrikes: ScheduledStrike[] = [];
  /** The last segment index we scheduled strikes for. */
  let lastStrikeSegment = -1;

  /** DOM flash overlay for lightning (reused each strike). */
  const lightningFlash = document.createElement('div');
  lightningFlash.id = 'lightning-flash';
  lightningFlash.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:90',
    'background:rgba(255,255,255,0)',
    'pointer-events:none', 'transition:background 0.12s ease-out',
  ].join(';');
  document.body.appendChild(lightningFlash);

  function triggerFlash(): void {
    lightningFlash.style.transition = 'none';
    lightningFlash.style.background = 'rgba(255,255,255,0.92)';
    // Force reflow so the 0→1 step is visible before fade begins.
    void lightningFlash.offsetWidth;
    lightningFlash.style.transition = 'background 0.12s ease-out';
    lightningFlash.style.background = 'rgba(255,255,255,0)';
    // Secondary dimmer echo at distance/340 s (visual thunder cue):
    // approximate with a delayed second pulse if target is > 40 m away.
    // (No audio system — visual only, as noted in task spec.)
  }

  /** Red vignette overlay pulsed whenever the player takes a physical hit. */
  const damageFlash = document.createElement('div');
  damageFlash.id = 'damage-flash';
  damageFlash.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:89',
    'background:radial-gradient(ellipse at center, rgba(200,0,0,0) 45%, rgba(180,0,0,0.55) 100%)',
    'opacity:0',
    'pointer-events:none', 'transition:opacity 0.35s ease-out',
  ].join(';');
  document.body.appendChild(damageFlash);

  function triggerDamageFlash(): void {
    damageFlash.style.transition = 'none';
    damageFlash.style.opacity = '1';
    void damageFlash.offsetWidth; // force reflow so the pulse always shows
    damageFlash.style.transition = 'opacity 0.35s ease-out';
    damageFlash.style.opacity = '0';
  }

  /**
   * Fire a lightning strike at absolute world position (tx, tz).
   * Handles tree ignition, player damage, and flash.
   * forceOutcome: optional override for deterministic testing.
   */
  function fireStrikeAt(
    tx: number,
    tz: number,
    strikeTimeS: number,
    forceOutcome?: 'death' | 'survivor',
  ): void {
    // --- Visual flash ---
    triggerFlash();
    // Feature 10: thunder SFX, attenuated by distance.
    const thunderDist = Math.hypot(tx - controller.pos[0], tz - controller.pos[2]);
    audio.play('thunder', { intensity: 1.0, dist: thunderDist });

    // --- Tree ignition: find nearest tree instance within TREE_IGNITE_RADIUS ---
    const nearTrees = resourceManager.nearbyTreeRefs(tx, tz, TREE_IGNITE_RADIUS, gameNowMs());
    if (nearTrees.length > 0) {
      const tree = nearTrees[0];
      addBurningTree({
        x: tree.x,
        y: tree.y,
        z: tree.z,
        untilS: simTime + TREE_BURN_S,
      });
    }

    // --- Player strike check ---
    const px = controller.pos[0];
    const pz = controller.pos[2];
    const playerDist = Math.hypot(px - tx, pz - tz);
    const ironArmor = hasIronArmor(inventory.armor);
    const strikeRadius = ironArmor ? PLAYER_STRIKE_RADIUS_IRON : PLAYER_STRIKE_RADIUS;

    if (playerDist <= strikeRadius) {
      // Check exposure
      const nearbyTreesForCanopy = resourceManager.nearbyTreeRefs(px, pz, 3, gameNowMs());
      const tentTierVal = tentTierAt(tents, px, pz);
      const underCanopy = tentTierVal === 0
        && canopyAt(nearbyTreesForCanopy, px, controller.pos[1], pz);
      const effectiveTentTier: 0 | 1 | 2 | 3 = underCanopy ? 1 : tentTierVal;

      const exposed = isExposed({
        // The castle roof counts as enclosure here for exactly the reason the
        // rain does: the castle is world geometry rather than an interior
        // arena, so nothing weather-driven ever asked whether there was a
        // ceiling overhead — and a player standing in the great hall under
        // three storeys of masonry could be struck by lightning. Same class of
        // bug as drops falling through the roof, same query answers it.
        //
        // Deliberately the RAW `underCastleRoof()` and not the eased `shelter`
        // used for the visuals: whether you are hit is a fact, not a fade.
        inDungeon: dungeonManager.isInside || buildingManager.isInside
          || underCastleRoof(),
        canopy: underCanopy,
        tentTier: effectiveTentTier,
        swimming: controller.swimming,
      });

      if (exposed && vitals.alive) {
        const outcome = forceOutcome ?? resolvePlayerStrike(strikeTimeS);
        if (outcome === 'death') {
          damagePlayer(vitals, vitals.hp, 'lightning');
        } else {
          // Survivor clamp: set hp to exactly 4 (only if hp > 4)
          if (vitals.hp > 4) {
            damagePlayer(vitals, vitals.hp - 4, 'lightning');
          }
          // If hp <= 4 already, a near-miss — no damage.
        }
        saveVitals(vitals);
      }
    }
  }

  /**
   * Each sim tick: schedule new strikes for the current segment if it's
   * a thunderstorm, then fire any pending strikes whose time has arrived.
   */
  function tickLightning(): void {
    // Determine current segment index (same formula as segStart approximation).
    const SEG_BASE_S = 270;
    const segIndex = Math.floor(simTime / SEG_BASE_S);
    const currentWeather = weatherPin ?? weatherAt(WORLD_SEED, simTime);

    // Schedule strikes for this segment (and the next) if not already done.
    for (const si of [segIndex, segIndex + 1]) {
      if (si <= lastStrikeSegment) continue;
      // Only schedule if this segment is/was thunderstorm at its midpoint.
      const segMidT = si * SEG_BASE_S + SEG_BASE_S / 2;
      const segWeather = weatherPin ?? weatherAt(WORLD_SEED, segMidT);
      if (segWeather.kind === 'thunderstorm') {
        const offsets = strikesForSegment(WORLD_SEED, si);
        const segStartAbsS = si * SEG_BASE_S; // approximate
        const absTimes = absoluteStrikeTimes(segStartAbsS, offsets);
        for (const t of absTimes) {
          if (t > simTime) {
            pendingStrikes.push({ fireAtS: t, segmentIndex: si });
          }
        }
      }
      lastStrikeSegment = si;
    }

    // Also schedule when weather pin is thunderstorm and no strikes yet queued.
    if (weatherPin?.kind === 'thunderstorm' && pendingStrikes.length === 0
        && lastStrikeSegment < segIndex) {
      const offsets = strikesForSegment(WORLD_SEED, segIndex);
      const absTimes = absoluteStrikeTimes(segIndex * 270, offsets);
      for (const t of absTimes) {
        if (t > simTime) pendingStrikes.push({ fireAtS: t, segmentIndex: segIndex });
      }
      lastStrikeSegment = segIndex;
    }

    // Fire any pending strikes that have matured.
    for (let i = pendingStrikes.length - 1; i >= 0; i--) {
      const s = pendingStrikes[i];
      if (simTime >= s.fireAtS) {
        pendingStrikes.splice(i, 1);
        // Only execute if weather is still thunderstorm-ish (blend midpoint).
        if (currentWeather.kind === 'thunderstorm' || weatherPin?.kind === 'thunderstorm') {
          const target = strikeTargetPoint(s.fireAtS, controller.pos[0], controller.pos[2]);
          fireStrikeAt(target.x, target.z, s.fireAtS);
        }
      }
    }

    // Expire old burning trees.
    tickBurningTrees(simTime);
  }

  /** Ignite all unburned trees/bushes within `radius` m of (x, z). */
  function igniteVegNear(x: number, z: number, radius: number): void {
    const burning = getBurningTrees(); // live ref — self-dedupes within the call
    const now = gameNowMs();
    for (const tr of resourceManager.nearbyTreeRefs(x, z, radius, now)) {
      if (burning.some(b => b.x === tr.x && b.z === tr.z)) continue;
      addBurningTree({ x: tr.x, y: tr.y, z: tr.z, untilS: simTime + TREE_BURN_S });
    }
    for (const bu of resourceManager.nearbyBushRefs(x, z, radius, now)) {
      if (burning.some(b => b.x === bu.x && b.z === bu.z)) continue;
      addBurningTree({
        x: bu.x, y: bu.y, z: bu.z, kind: 'bush', untilS: simTime + BUSH_BURN_S,
      });
    }
  }

  /**
   * Fire spreads to vegetation (throttled to ~1 s ticks): lit campfires and
   * forges ignite trees/bushes placed too close, a held torch ignites brush
   * you walk right against, and burning vegetation creeps to its neighbours
   * (chance-gated per tick; MAX_BURNING caps runaway forest fires).
   */
  function tickFireSpread(): void {
    // Feature 3: Rain suppresses vegetation ignition from campfires and reduces
    // burning-tree duration (2× burn-out speed during rain/thunderstorm).
    const currentWeatherForFire = weatherPin ?? weatherAt(WORLD_SEED, simTime);
    const isRaining = currentWeatherForFire.kind === 'rain' || currentWeatherForFire.kind === 'thunderstorm';

    // Burning trees burn out twice as fast in rain (handled by shortening untilS).
    if (isRaining) {
      const rainBurnExtra = FIRE_SPREAD_TICK_S; // extra seconds consumed per tick
      for (const bt of getBurningTrees() as import('./fire').BurningTree[]) {
        bt.untilS -= rainBurnExtra; // shorten lifetime
      }
    }

    for (const f of fires) {
      if (!isLit(f, simTime)) continue;
      // Campfires: not extinguished by rain (sheltered flame), but vegetation
      // ignition radius is disabled while raining.
      if (!isRaining) {
        igniteVegNear(f.x, f.z, FIRE_IGNITE_RADIUS);
      }
    }
    if (equipped(inventory) === 'torch' && vitals.alive && !isRaining) {
      igniteVegNear(controller.pos[0], controller.pos[2], TORCH_IGNITE_RADIUS);
    }
    const snapshot = [...getBurningTrees()];
    for (const b of snapshot) {
      // Fire spread from burning vegetation is suppressed during rain.
      if (!isRaining && Math.random() < FIRE_SPREAD_CHANCE) {
        igniteVegNear(b.x, b.z, FIRE_SPREAD_RADIUS);
      }
    }
  }

  // Vitals HUD (top-left): hearts, thirst, temp, stamina.
  const vitalsHud = new VitalsHud();

  // Held torch: the burn-down stitch above the hotbar, and the fuel behind it.
  //
  // `torchFuelS` is the fuel left in the torch CURRENTLY IN HAND, not a total
  // across the stack — the stack's size is the hotbar count. It is deliberately
  // NOT persisted: a save restores a fresh torch. Threading one more scalar
  // through the vitals save format to make quitting cost you 40 seconds of
  // pitch is not a trade worth making.
  const torchBar = new TorchBar();
  let torchFuelS = TORCH_BURN_S;
  /** Previous lit/unlit state of the held torch — drives the light/douse cue. */
  let prevTorchLit = false;
  /** Previous interior state — drives the door open/close cue. */
  let prevInsideForAudio = false;
  /**
   * Torches in the SELECTED SLOT — the stack that will actually relight.
   * Deliberately not `countItem(inventory, 'torch')`: the auto-relight pulls
   * from the slot in your hand, so a bar reading "x41" while the slot holds 5
   * would promise light that will not arrive. Spare torches in the pack are a
   * resupply you have to perform, not fuel.
   */
  const heldTorchCount = (): number => {
    const s = inventory.hotbar[inventory.selected];
    return s !== null && s.id === 'torch' ? s.count : 0;
  };
  /** Last frame's flame anchor and uploaded light set — debug hooks only. */
  let lastTorchFlame: Vec3 | null = null;
  let lastWorldLights: readonly { pos: Vec3; color: Vec3; radius: number }[] = [];

  // Mount stamina HUD — amber bar shown while mounted and stamina < 100.
  const mountStaminaHud = (() => {
    const wrap = document.createElement('div');
    wrap.id = 'mount-stamina-hud';
    wrap.style.cssText = [
      'position:fixed', 'top:10px', 'left:10px', 'z-index:14',
      'display:none', 'align-items:center', 'gap:5px',
      'font:600 12px system-ui,sans-serif',
      'pointer-events:none', 'user-select:none',
      // Offset below the vitals-hud; vitals-hud is ~90px tall with all bars.
      'margin-top:95px',
    ].join(';');
    const label = document.createElement('span');
    label.textContent = '\uD83D\uDC0E'; // horse emoji
    label.style.cssText = 'font-size:11px;min-width:14px';
    const track = document.createElement('div');
    track.style.cssText = [
      'width:90px', 'height:6px',
      'background:rgba(10,14,20,0.70)',
      'border-radius:3px',
      'border:1px solid rgba(205,214,228,0.18)',
      'overflow:hidden',
    ].join(';');
    const fill = document.createElement('div');
    fill.style.cssText = [
      'height:100%', 'border-radius:3px',
      'background:#d4941a',
      'transition:width 0.12s linear',
      'width:100%',
    ].join(';');
    track.appendChild(fill);
    wrap.appendChild(label);
    wrap.appendChild(track);
    document.body.appendChild(wrap);
    return { wrap, fill };
  })();

  /** Update the mount stamina HUD. Called at ~2 Hz alongside vitalsHud.update. */
  function updateMountStaminaHud(): void {
    if (mountedEntityId === null) {
      mountStaminaHud.wrap.style.display = 'none';
      return;
    }
    const me = entityManager.entities.get(mountedEntityId);
    if (!me || me.stamina === undefined) {
      mountStaminaHud.wrap.style.display = 'none';
      return;
    }
    const pct = Math.max(0, Math.min(100, me.stamina));
    if (pct >= 99.5) {
      mountStaminaHud.wrap.style.display = 'none';
      return;
    }
    mountStaminaHud.wrap.style.display = 'flex';
    mountStaminaHud.fill.style.width = `${pct.toFixed(1)}%`;
  }

  // Death overlay DOM (created once, shown/hidden).
  const deathOverlay = document.createElement('div');
  deathOverlay.id = 'death-overlay';
  deathOverlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:100',
    'background:rgba(0,0,0,0.82)',
    'display:none', 'flex-direction:column',
    'align-items:center', 'justify-content:center',
    'color:#cdd6e4', 'font:600 22px system-ui,sans-serif',
    'gap:18px', 'user-select:none',
  ].join(';');
  const deathTitle = document.createElement('div');
  deathTitle.id = 'death-title';
  deathTitle.textContent = 'You Died';
  deathTitle.style.cssText = 'font-size:36px;color:#e04040;text-shadow:0 0 24px rgba(220,40,40,0.7)';
  const deathCauseEl = document.createElement('div');
  deathCauseEl.id = 'death-cause';
  deathCauseEl.style.cssText = 'font-size:16px;opacity:0.75';
  const respawnBtn = document.createElement('button');
  respawnBtn.id = 'respawn-btn';
  respawnBtn.textContent = 'Respawn';
  respawnBtn.style.cssText = [
    'margin-top:8px', 'padding:10px 32px',
    'font:600 16px system-ui,sans-serif',
    'background:rgba(205,214,228,0.12)',
    'color:#cdd6e4', 'border:2px solid rgba(205,214,228,0.35)',
    'border-radius:8px', 'cursor:pointer',
  ].join(';');
  deathOverlay.appendChild(deathTitle);
  deathOverlay.appendChild(deathCauseEl);
  deathOverlay.appendChild(respawnBtn);
  document.body.appendChild(deathOverlay);
  let isDead = false;

  function doRespawn(): void {
    vitals = createVitals();
    saveVitals(vitals);
    // Leave any interior FIRST. Dying underground used to strand you in an
    // "ether realm": the position was moved to the surface spawn, but the
    // dungeon resident stayed loaded, so the renderer kept drawing in dungeon
    // mode, collision stayed bound to the dungeon mesh and the camera stayed in
    // interior mode — a void with no terrain and no sky. Both managers restore
    // `controller.world` and `camera.interior` as part of their teardown, which
    // is exactly what was being skipped. They also reposition the player, so
    // this has to happen before the spawn position is applied.
    dungeonManager.forceExit();
    buildingManager.forceExit();
    // Dying while mounted should not leave you riding a corpse across the map.
    if (mountedEntityId !== null) doDisMount();
    // Before the escape, death puts you back in the cell — respawning in open
    // wilderness would skip the entire opening. After it, the foot of the
    // breach ramp, because respawning inside a castle that is now hunting you
    // is a death loop.
    controller.pos = [...castleManager.respawnPoint()] as [number, number, number];
    controller.velY = 0;
    isDead = false;
    deathOverlay.style.display = 'none';
    vitalsHud.setVisible(true);
    canvas.requestPointerLock();
  }

  respawnBtn.addEventListener('click', doRespawn);

  // Persist vitals + effects on page unload.
  window.addEventListener('pagehide', () => {
    saveVitals(vitals);
    saveEffectsState(effectsState);
  });

  // -------------------------------------------------------------------------
  // Feature 6: Compass HUD (top-center strip)
  // -------------------------------------------------------------------------
  const compassEl = (() => {
    const el = document.createElement('div');
    el.id = 'compass-hud';
    el.style.cssText = [
      'position:fixed', 'top:10px', 'left:50%', 'transform:translateX(-50%)',
      'z-index:14', 'pointer-events:none', 'user-select:none',
      'background:rgba(10,14,20,0.60)',
      'border:1px solid rgba(205,214,228,0.15)',
      'border-radius:8px',
      'padding:3px 10px',
      'font:600 11px system-ui,sans-serif',
      'color:#cdd6e4',
      'display:flex', 'gap:8px', 'align-items:center',
      'min-width:180px', 'justify-content:center',
    ].join(';');
    document.body.appendChild(el);
    return el;
  })();
  let compassUpdateAccum = 0;
  function updateCompass(): void {
    // Throttle to ~5 Hz.
    compassUpdateAccum += SIM_DT;
    if (compassUpdateAccum < 0.2) return;
    compassUpdateAccum = 0;

    // Camera yaw: 0 = looking -Z (north by convention). Positive yaw = rotate right.
    const yaw = orbitCam.yaw; // radians
    // Heading angle: normalise to [0, 2π). 0=N, π/2=E, π=S, 3π/2=W.
    const heading = ((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const DIRS = ['N','NE','E','SE','S','SW','W','NW'];
    const idx = Math.round(heading / (Math.PI / 4)) % 8;
    const dirLabel = DIRS[idx];

    // Nearest settlement marker.
    const nearSite = settlementManager.findNearestSite(
      controller.pos[0], controller.pos[2]);
    let settlementText = '';
    if (nearSite !== null) {
      const dx = nearSite.x - controller.pos[0];
      const dz = nearSite.z - controller.pos[2];
      const distM = Math.round(Math.hypot(dx, dz));
      // Bearing to settlement in world space.
      const bearAngle = Math.atan2(dx, -dz); // 0=N in our coord sys
      const bearNorm = ((bearAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const bearIdx = Math.round(bearNorm / (Math.PI / 4)) % 8;
      const bearLabel = DIRS[bearIdx];
      settlementText = ` \u25B2${bearLabel} ${distM}m`;
    }

    compassEl.textContent = `\u{1F9ED} ${dirLabel}${settlementText}`;
  }

  // Phase N: effects icon row HUD (small colored squares with remaining seconds).
  const effectsHud = (() => {
    const el = document.createElement('div');
    el.id = 'effects-hud';
    el.style.cssText = [
      'position:fixed', 'top:10px', 'left:130px', 'z-index:14',
      'display:flex', 'gap:4px',
      'pointer-events:none', 'user-select:none',
      'font:600 10px system-ui,sans-serif',
    ].join(';');
    document.body.appendChild(el);
    return el;
  })();

  function updateEffectsHud(): void {
    const effects = effectsState.effects;
    if (effects.length === 0) {
      effectsHud.style.display = 'none';
      return;
    }
    effectsHud.style.display = 'flex';
    effectsHud.innerHTML = '';
    const COLOR: Record<string, string> = {
      heal:    '#e04040',
      warm:    '#e08030',
      cool:    '#4a88d4',
      stamina: '#4ad48a',
    };
    for (const ef of effects) {
      const icon = document.createElement('div');
      icon.style.cssText = [
        `background:${COLOR[ef.cls] ?? '#888'}`,
        'width:22px', 'height:22px', 'border-radius:4px',
        'display:flex', 'align-items:center', 'justify-content:center',
        'color:rgba(255,255,255,0.9)',
        'font:600 9px system-ui,sans-serif',
        'border:1px solid rgba(0,0,0,0.3)',
      ].join(';');
      icon.textContent = Math.ceil(ef.remainingS) + 's';
      icon.title = `${ef.cls} (${Math.ceil(ef.remainingS)}s)`;
      effectsHud.appendChild(icon);
    }
  }

  // Gatherable nodes: rocks/bushes/choppable trees; harvest state persists.
  const nodeRegistry = loadNodeRegistry();
  const resourceManager =
    new ResourceManager(renderer, heightField, WORLD_SEED, nodeRegistry, biomeField);
  chunkManager.treeFilter = (cx, cz, i) =>
    resourceManager.treeVisible(cx, cz, i, gameNowMs());
  resourceManager.onTreesChanged = (cx, cz) => chunkManager.refreshTrees(cx, cz);

  // ?tod=0.5 freezes the day-night cycle (screenshots, deterministic e2e).
  const todParam = debugParams().get('tod');
  const todFreeze =
    todParam !== null && Number.isFinite(Number(todParam))
      ? Number(todParam)
      : null;

  // ?weather=clear|overcast|rain pins the weather (same purpose as ?tod=).
  const weatherParam = debugParams().get('weather');
  const weatherPin: Weather | null =
    weatherParam !== null && weatherParam in WEATHER_PRESETS
      ? WEATHER_PRESETS[weatherParam as WeatherKind]
      : null;

  // AI Director: ON by default (proven in M0/M4).
  // Shares the game's GPU device; failures degrade to fixtures, never __gameError.
  //
  // Two ways off, and the second is the one that ships. `?director=off` is the
  // developer/harness route and `debugParams()` blanks it in a release build;
  // the Settings panel's toggle is the player's, because a packaged player has
  // no URL bar. release-flags.ts called for exactly this. Read once at boot on
  // purpose: the director owns GPU resources and an LLM session, and tearing
  // those down mid-session is a different and much larger change than a
  // checkbox — the panel says the setting applies on restart.
  const directorOff = debugParams().get('director') === 'off' || settings.get().directorOff;

  // NPC dialogue model: defaults to STOCK Qwen3-1.7B Q4_K_M (Apache-2.0), the
  // same model the Dungeon Director runs — one download, one set of resident
  // weights. ?npcllm=large picks the slower stock 4B (measured TTFT ~45s vs a
  // 20s watchdog — expect canned replies); ?npcllm=abliterated is for
  // comparison only and must not become the default. See NPC_MODELS in
  // npc-chat-panel.ts and docs/AI_GUARDRAILS.md.
  // In a Steam release build debugParams() is empty, so this is always null and
  // the model is always NPC_MODELS.fast — the abliterated path is unreachable.
  const npcLlmParam = debugParams().get('npcllm');
  const npcModelKey: import('./ui/npc-chat-panel').NpcModelKey =
    npcLlmParam !== null && isNpcModelKey(npcLlmParam) ? npcLlmParam : 'fast';
  if (npcLlmParam !== null && !isNpcModelKey(npcLlmParam)) {
    console.warn(`[NPC chat] unknown ?npcllm=${npcLlmParam} — using default`);
  }
  const director = !directorOff
    ? new DungeonDirector({
        seed: WORLD_SEED,
        gpu,
        // Carved ground: creatures walking a road should be ON it.
        heightAt: (x, z) => chunkManager.ground.heightAt(x, z),
      })
    : null;

  // The NPC chat model (multi-GB weights) loads only when the player first
  // nears a settlement — see the 500 ms gate in the frame loop. Boot stays
  // light and pure-wilderness sessions never pay the upload; the panel's
  // lazy-load path still covers a chat opened before the warm load finishes.
  let npcPreloadStarted = false;
  const NPC_PRELOAD_DIST = 350;

  // NPC trade stock — persisted across reloads per settlement+npc.
  const npcStockMap: StockMap = loadStockMap();

  // NPC persistent memory — met/disposition/facts per settlement+npc.
  const npcMemoryMap: MemoryMap = loadMemoryMap();
  // Phase N4: settlements the player has already been greeted/questioned in.
  const visitedSettlements: Set<string> = loadVisitedSet();
  // Killable NPCs: ids of permanently dead NPCs (never respawn).
  const deadNpcs: Set<string> = loadDeadNpcSet();

  // Ecology Director — deterministic procedural ecology specs per cell.
  const ecologyDirector = new EcologyDirector({
    seed: WORLD_SEED,
    disabled: directorOff,
  });

  const dungeonManager = new DungeonManager(
    renderer, heightField, castleWorldQuery, controller, orbitCam, WORLD_SEED,
    director);
  // Chest loot lands in the pack (leftovers vanish — chests are small).
  dungeonManager.onLoot = (items) => {
    for (const id of items) addItem(inventory, id);
    saveInventory(inventory);
    hotbar.refresh();
    audio.play('chest_open'); // Feature 10: chest open SFX
  };

  // The escape chest returns the kit the king's men confiscated, and the alarm
  // is what turns the opening from a walk into a boss fight.
  castleManager.onLoot = (items) => {
    for (const id of items) addItem(inventory, id);
    saveInventory(inventory);
    hotbar.refresh();
    audio.play('chest_open');
    setGatherNotice('Your gear. Now find a way out.');
    // The chest is a one-shot. Persist immediately rather than on the next
    // alarm transition, or a reload between opening it and leaving the castle
    // refills it and hands out a second starter kit.
    saveCastleState();
  };
  castleManager.onAlarm = (phase) => {
    if (phase === 'hunting') {
      audio.play('dragon_roar', { dist: 40 });
      setGatherNotice('The castle has seen you. The king is coming.');
    }
    saveCastleState();
  };

  /**
   * The opening's persistent state.
   *
   * Loaded before the first frame so a reload lands the player in the castle
   * they left rather than in a fresh one: alarm phase, whether they escaped,
   * whether the chest is empty, and which of the garrison are already dead.
   *
   * There is a deliberate ASYMMETRY with `resumeState`. The player's position
   * comes from `consumeResume() ?? readAutoPos()`, which only records outdoors
   * on solid ground — so a reload during the escape, inside the keep, restores
   * the alarm and the chest but drops the player at the last outdoor position,
   * which may be nowhere near the castle. `reconcileCastleResume` below is
   * what stops that being a half-state.
   */
  function saveCastleState(): void {
    try {
      localStorage.setItem(CASTLE_STATE_KEY, castleManager.serialize());
    } catch { /* quota */ }
  }
  {
    let raw: string | null = null;
    try { raw = localStorage.getItem(CASTLE_STATE_KEY); } catch { /* unavailable */ }
    if (raw !== null) castleManager.restore(raw);
  }

  /**
   * Decide where a reloaded player actually stands.
   *
   * Four cases, and only the last one is interesting:
   *
   *   no resume record at all      -> the cell. A new game.
   *   never escaped, resume inside -> honour it; they are mid-escape and the
   *                                   crash-recovery position is theirs.
   *   never escaped, resume far    -> the CELL, not the resume. `saveAutoPos`
   *                                   refuses to record indoors, so the only
   *                                   position a mid-escape reload can offer
   *                                   is a stale one from before the game
   *                                   started, or none. Honouring it teleports
   *                                   a player who has not yet opened the
   *                                   chest into open wilderness and silently
   *                                   skips the entire opening — the exact
   *                                   half-state this function exists for.
   *   escaped                      -> honour the resume. They are out; the
   *                                   world is theirs.
   */
  function reconcileCastleResume(): void {
    if (resumeState === null) return;
    if (castleManager.state.escaped) return;
    const d = castleManager.distanceTo(resumeState.x, resumeState.z);
    if (d < 200) return;               // inside or on the motte: it is real
    controller.pos = [...castleManager.spawnPoint()] as [number, number, number];
    controller.velY = 0;
  }
  reconcileCastleResume();

  // -------------------------------------------------------------------------
  // Building interiors (enterable settlement buildings)
  // -------------------------------------------------------------------------
  const buildingManager = new BuildingManager(
    renderer, heightField, castleWorldQuery, controller, orbitCam, WORLD_SEED);
  buildingManager.onLoot = (items) => {
    for (const id of items) addItem(inventory, id);
    saveInventory(inventory);
    hotbar.refresh();
    audio.play('chest_open'); // Feature 10: chest open SFX
  };
  buildingManager.onRest = () => {
    healPlayer(vitals, 6);
    vitals.stamina = Math.min(100, vitals.stamina + 40);
    saveVitals(vitals);
    vitalsHud.update(vitals);
  };

  // Bed rental (tavern guest rooms). BuildingManager owns the interaction and
  // the "rented until you sleep" state; these three seams give it the economy
  // and the clock. All three are optional — unwired, renting is free and
  // sleeping falls back to `onRest`, so it can never be a dead end.
  buildingManager.getGold = () => countItem(inventory, 'gold_small');
  buildingManager.spendGold = (amount: number) => {
    if (countItem(inventory, 'gold_small') < amount) return false;
    removeItem(inventory, 'gold_small', amount);
    invChanged();
    return true;
  };
  buildingManager.onSleep = () => {
    // Advance to ~07:00 and charge the night's thirst, so a full heal is not
    // also a free skipped night.
    const tod = (simTime / DAY_LENGTH_S + TOD_START) % 1;
    const frac = (0.29 - tod + 1) % 1;
    simTime += frac * DAY_LENGTH_S;
    vitals.thirst = Math.max(0, vitals.thirst - frac * 24 * 2.5);
    healPlayer(vitals, 999);
    vitals.stamina = 100;
    saveVitals(vitals);
    vitalsHud.update(vitals);
    audio.play('chest_open');
  };

  // -------------------------------------------------------------------------
  // Phase J: entity manager + renderer
  // -------------------------------------------------------------------------
  const entityManager = new EntityManager(
    WORLD_SEED,
    (x, z) => heightField.heightAt(x, z),
    (x, z) => biomeField.biomeAt(x, z),
  );
  entityManager.ecologyDirector = directorOff ? null : ecologyDirector;
  const entityRenderer = new EntityRenderer(renderer);
  // Lets winged creatures detect flight from height above ground rather than
  // from vertical velocity, so a dragon holding level altitude keeps beating
  // its wings instead of folding them because it happens not to be climbing.
  entityRenderer.terrainHeightAt = (x, z) => chunkManager.ground.heightAt(x, z);
  let entityDrawnCount = 0;

  // -------------------------------------------------------------------------
  // Phase L: NPC runtime state
  // -------------------------------------------------------------------------

  /** NPC role → base colour palette + role accessories. */
  const NPC_PALETTE: Record<string, {
    shirt: import('./character/character-mesh').Color3;
    pants: import('./character/character-mesh').Color3;
    hair: import('./character/character-mesh').Color3;
    skin: import('./character/character-mesh').Color3;
    /** If set, guards get iron armor look. */
    armor?: import('./character/character-mesh').ArmorOptions;
    /** Base accessories for the role (merged with per-NPC variations). */
    accessories?: import('./character/character-mesh').NpcAccessories;
  }> = {
    farmer:   { skin: [0.78, 0.60, 0.44], shirt: [0.55, 0.42, 0.22], pants: [0.30, 0.24, 0.14], hair: [0.22, 0.14, 0.08],
                accessories: { belt: [0.40, 0.28, 0.14], boots: [0.32, 0.22, 0.12], apron: [0.70, 0.62, 0.45] } },
    villager: { skin: [0.80, 0.62, 0.46], shirt: [0.28, 0.38, 0.60], pants: [0.22, 0.30, 0.50], hair: [0.35, 0.25, 0.14],
                accessories: { belt: [0.25, 0.20, 0.15], boots: [0.28, 0.20, 0.14] } },
    merchant: { skin: [0.76, 0.60, 0.44], shirt: [0.45, 0.20, 0.60], pants: [0.32, 0.22, 0.40], hair: [0.55, 0.45, 0.10],
                accessories: { hat: [0.50, 0.18, 0.55], belt: [0.60, 0.50, 0.12], boots: [0.22, 0.14, 0.08] } },
    guard:    { skin: [0.72, 0.56, 0.42], shirt: [0.38, 0.38, 0.40], pants: [0.26, 0.26, 0.28], hair: [0.18, 0.18, 0.20],
                armor: { head: 'iron', body: 'iron' },
                accessories: { belt: [0.30, 0.25, 0.10], boots: [0.20, 0.20, 0.22] } },
  };

  /**
   * Deterministic hash from a string (FNV-1a 32-bit) for per-NPC variety.
   * Returns a float in [0, 1).
   */
  function npcHashF(s: string, salt = 0): number {
    let h = 0x811c9dc5 ^ salt;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return ((h >>> 0) & 0x7fffffff) / 0x80000000;
  }

  /** Vary a color channel by ±range seeded from an NPC id + channel salt. */
  function varyColor(base: import('./character/character-mesh').Color3, id: string, range = 0.12): import('./character/character-mesh').Color3 {
    return [
      Math.max(0, Math.min(1, base[0] + (npcHashF(id, 1) - 0.5) * range * 2)),
      Math.max(0, Math.min(1, base[1] + (npcHashF(id, 2) - 0.5) * range * 2)),
      Math.max(0, Math.min(1, base[2] + (npcHashF(id, 3) - 0.5) * range * 2)),
    ];
  }

  /** Mutable runtime state for each NPC. */
  interface NpcRuntime {
    npc: ResolvedNpc;
    /** sim-time (s) at which a dead NPC may respawn (Feature 8). */
    respawnAtS?: number;
    wx: number;
    wy: number;
    wz: number;
    yaw: number;
    walkPhase: number;
    walkAmp: number;
    /** Index of the current patrol waypoint target. */
    wpIdx: number;
    /** Pause timer (s): NPC idles when > 0. */
    pauseS: number;
    /** Per-NPC rng for pause durations. */
    rng: () => number;
    /** Phase M: NPC hit points. */
    hp: number;
    /** Phase M: whether this NPC is fleeing after being hit. */
    fleeing: boolean;
    /** Phase N2: conversation-driven attitude toward the player. */
    attitude: 'calm' | 'hostile' | 'afraid' | 'approach';
    /** Phase N2: seconds until this NPC may melee again. */
    attackCooldown: number;
    /**
     * Pad type of this NPC's home building (''  if they have no home). Decides
     * whether they keep a shop/tavern by day or merely sleep somewhere by
     * night, and is resolved once per runtime rebuild rather than per frame.
     */
    homePadType: string;
    /**
     * True while this NPC has withdrawn into their home building. Indoor NPCs
     * are not drawn or simulated outdoors — the only way to reach them is to
     * open their door.
     */
    indoors: boolean;
    /**
     * Set while the player is inside this NPC's building. `wx/wy/wz` then hold
     * INTERIOR ARENA coordinates instead of world ones, which is the whole
     * trick: the player's own position is in that same arena while indoors, so
     * every existing distance test — talk range, melee, guard approach — keeps
     * working with no indoor special case.
     */
    inArena: boolean;
    /** Outdoor position, parked while `inArena` is true so it can be restored. */
    outdoorPos?: [number, number, number];
    /**
     * Seconds until this NPC may loose another arrow. Undefined until the
     * first shot so guards stagger themselves instead of volleying in unison.
     */
    bowCooldown?: number;
    /** Phase N8: convinced to walk with the player (companion follow). */
    following?: boolean;
    /** simTime (s) when this NPC died — drives the corpse-sink visual. */
    deadAtS?: number;
  }

  let npcRuntimes: NpcRuntime[] = [];
  /** When true, re-derive NpcRuntimes from settlementManager next tick. */
  let npcsDirty = true;

  /** GPU buffer pool for NPC draws (reused across frames). */
  interface NpcPoolEntry {
    vertexBuffer: GPUBuffer;
    objectBuffer: GPUBuffer;
    bindGroup: GPUBindGroup;
    shadowBindGroup: GPUBindGroup;
    /**
     * Whose vertices this buffer currently holds, or null when never written.
     *
     * The whole point of the LOD below. Slots used to be handed out by DRAW
     * RANK, so the same buffer held a different person whenever the sort order
     * shifted — which is every frame in a crowd — and that is precisely why
     * every mesh had to be rebuilt every frame: the alternative was drawing
     * the blacksmith wearing the baker.
     */
    ownerId: string | null;
    /** Vertex count last uploaded, so a skipped rebuild can still be drawn. */
    count: number;
  }
  const npcPool: NpcPoolEntry[] = [];
  /** Debug: force shadows on/off (null = follow weather). */
  let shadowOverride: boolean | null = null;
  /**
   * Scratch mesh buffers. buildCharacterMesh used to allocate a fresh array
   * per call — about 2 MB per character per frame, which at a settlement full
   * of NPCs was over 100 MB/s of pure GC garbage. NPCs build and upload one at
   * a time, so they can share one buffer.
   */
  /**
   * Clamp a character mesh to the GPU buffer it is about to be written into.
   *
   * These buffers are sized CHARACTER_MAX_VERTS and rewritten every frame. When
   * a mesh grew past that cap the writeBuffer overran its allocation and the
   * ENTIRE FRAME rendered black — a total, silent failure from a 6% budget
   * overshoot in one rare costume combination. test-character-mesh.mts now
   * sweeps the whole option space to stop that reaching here, but a dropped
   * limb is a far better failure than a black screen, so clamp anyway.
   */
  const FLOATS_PER_VERT = STRIDE_CREATURE / 4;
  let overflowWarned = false;
  function fitCharacterMesh(
    verts: Float32Array<ArrayBuffer>,
  ): Float32Array<ArrayBuffer> {
    const cap = CHARACTER_MAX_VERTS * FLOATS_PER_VERT;
    if (verts.length <= cap) return verts;
    if (!overflowWarned) {
      overflowWarned = true;
      console.error(`[character] mesh of ${verts.length / FLOATS_PER_VERT} verts ` +
        `exceeds CHARACTER_MAX_VERTS=${CHARACTER_MAX_VERTS}; truncating`);
    }
    // Whole triangles only — a partial triangle would render as garbage.
    return verts.subarray(0, Math.floor(cap / (3 * FLOATS_PER_VERT)) * 3 * FLOATS_PER_VERT);
  }

  const npcMeshScratch =
    new Float32Array(CHARACTER_MAX_VERTS * (STRIDE_CREATURE / 4));
  const playerMeshScratch =
    new Float32Array(CHARACTER_MAX_VERTS * (STRIDE_CREATURE / 4));

  const NPC_WALK_SPEED = 1.2;  // m/s
  const NPC_RENDER_DIST = 120; // m
  const NPC_SIM_DIST = 150;    // m (skip AI beyond this)
  const NPC_INTERACT_DIST = 3; // m (E-key reach)
  /**
   * Start prefilling an NPC's prompt at this range (m).
   *
   * Wide enough that walking the rest of the way covers most of a ~1,500-token
   * prefill. Overshooting is cheap: the warm is idempotent per NPC and a real
   * chat turn aborts it, and an aborted prefill keeps the chunks it already
   * did (engine/generate.ts), so nothing speculative is wasted.
   */
  const NPC_WARM_DIST = 25;
  const NPC_MAX_DRAWN = 12;

  function getNpcPoolEntry(i: number): NpcPoolEntry {
    while (npcPool.length <= i) {
      const vertexBuffer = renderer.device.createBuffer({
        label: `npc-mesh-${npcPool.length}`,
        size: CHARACTER_MAX_VERTS * STRIDE_CREATURE,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      const { bindGroup, buffer: objectBuffer, shadowBindGroup } =
        renderer.createObjectBindGroup(0, 0, 0, 1, undefined, MATERIALS.KNIT);
      npcPool.push({
        vertexBuffer, objectBuffer, bindGroup, shadowBindGroup,
        ownerId: null, count: 0,
      });
    }
    return npcPool[i];
  }

  // --- NPC animation LOD -----------------------------------------------------
  //
  // The same treatment `entity-renderer.ts` applies to creatures, and for the
  // same measured reason. This was the only draw path in the game with neither
  // a distance band nor a rebuild budget: `buildNpcDraws` re-posed every one of
  // the twelve drawn characters every frame at ~0.6 ms each, which is most of
  // why a castle ran at ~20 ms against a 16.7 ms budget.
  //
  // Two halves, and the first is what makes the second possible:
  //
  //  1. POOL SLOTS ARE KEYED BY NPC, NOT BY DRAW RANK. They were keyed by rank
  //     — `getNpcPoolEntry(i)` where `i` is the sort position — so the same
  //     buffer held a different person whenever the distance order shifted,
  //     which in a moving crowd is every frame. There was no such thing as a
  //     reusable mesh, so rebuilding everything was not a missing optimisation,
  //     it was forced. Each NPC now keeps its slot for as long as it stays
  //     drawn, and `ownerId` catches the case where it genuinely changes hands.
  //
  //  2. BANDS PLUS A HARD BUDGET. Bands express a preference; only a budget
  //     expresses a limit — see the long note in `entity-renderer.ts`, which
  //     also records that the real fix is the `number[].push()` in every mesh
  //     builder and that this bounds the damage until then.
  //
  // Only the vertex RE-POSE is rationed. Position, facing and the corpse sink
  // are uploaded every frame for every drawn NPC, so nobody slides or stutters;
  // it is the limb animation that drops to 30/20/15 Hz with distance, at which
  // point an NPC is a few dozen pixels tall.

  /** Rebuild every frame / 2nd / 3rd / 4th. Same bands as creatures. */
  const NPC_LOD_NEAR = 30;
  const NPC_LOD_MID  = 62;
  const NPC_LOD_FAR  = 95;

  /**
   * Meshes that may be rebuilt in one frame, spent nearest-first.
   *
   * Eight, matching `entity-renderer`. The two paths share a frame and each
   * has its own budget, which is deliberate: an NPC crowd and a herd are
   * different failure modes and capping their sum would let either starve the
   * other. Twelve NPCs spread over a castle want ~7 rebuilds, so this is a
   * backstop rather than the normal limit.
   */
  const NPC_REBUILD_BUDGET = 8;

  /** Stable 0..255 hash of an NPC id — staggers which frame each one rebuilds. */
  function npcIdHash(id: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0) & 0xff;
  }

  /**
   * Debug switch that reproduces the pre-LOD draw path: every drawn NPC
   * rebuilt every frame, no bands, no budget.
   *
   * It exists so the fix can be measured A/B in ONE run at ONE scene rather
   * than across two code versions on two runs. `scripts/fps-probe.mjs` records
   * why that matters here: a sequential before/after of this game reported a
   * 33 fps difference that turned out to be chunk streaming drifting under the
   * measurement, and the very next condition — with more load — ran clean.
   * Interleaving cancels drift; a real cost survives it.
   */
  let npcLodEnabled = true;

  /** Frame counter for the LOD stagger. Not a clock — it must not read time. */
  let npcFrameNo = 0;
  /** Slot each drawn candidate will use, and which slots are already claimed. */
  const npcSlotOf = new Int32Array(NPC_MAX_DRAWN);
  const npcSlotTaken = new Uint8Array(NPC_MAX_DRAWN);
  /** Reused object-uniform scratch: x, y, z, colorMode. */
  const npcObjScratch = new Float32Array(4);

  /**
   * Last frame's rebuild accounting, for perf harnesses. Mirrors
   * `EntityRenderer.lastFrameCost` — `forced` is the number to watch, because
   * those bypass the budget and a churning crowd can drive them arbitrarily
   * high.
   */
  const npcDrawCost = { drawn: 0, wanted: 0, spent: 0, forced: 0, ms: 0 };

  /**
   * Ensure 1-2 npcOwned horses are present near each stable pad of active
   * settlements (ranch, village, castle all have stables).  Called from
   * rebuildNpcRuntimes() which fires whenever the NPC set changes.
   * Uses the settlement seed for determinism; uses mix32 for a stable id
   * so the same horses are re-materialised on cell re-entry.
   */
  function ensureStableHorses(): void {
    const STABLE_HORSE_SALT = 0x5ab1e508; // "stable" phonetic
    for (const resolved of settlementManager.nearby()) {
      const site = resolved.site;
      for (const pad of resolved.pads) {
        if (pad.type !== 'stable') continue;
        // Deterministic count: 1 or 2 horses per stable (from site seed + pad).
        const padSeed = mix32(site.seed ^ STABLE_HORSE_SALT,
          Math.floor(pad.wx), Math.floor(pad.wz));
        const horseCount = 1 + (padSeed & 1); // 1 or 2
        for (let k = 0; k < horseCount; k++) {
          const horseId = `stable_horse_${padSeed >>> 0}_${k}`;
          if (entityManager.entities.has(horseId)) continue;
          // A previously-purchased stable horse (recorded in the taming
          // registry by the buy flow) re-materialises as the player's own.
          const purchased = tamingRegistry.tamed[horseId]?.tamed === true;
          // Deterministic spawn position within ~6 m of the stable.
          const hrng = mulberry32(mix32(padSeed, k, 0xabc));
          const angle = hrng() * Math.PI * 2;
          const dist = 2 + hrng() * 4; // 2..6 m
          const hx = pad.wx + Math.cos(angle) * dist;
          const hz = pad.wz + Math.sin(angle) * dist;
          const hy = heightField.heightAt(hx, hz);
          const e = {
            id: horseId,
            species: 'horse' as Species,
            x: hx,
            y: hy,
            z: hz,
            yaw: hrng() * Math.PI * 2,
            hp: SPECIES_DEFS['horse'].hp,
            mode: 'idle' as import('./entities/entity-manager').EntityMode,
            walkPhase: 0,
            colorVariant: Math.floor(hrng() * 4),
            homeX: hx,
            homeZ: hz,
            stateTimer: hrng() * 3,
            fleeTimer: 0,
            npcOwned: !purchased,
            owned: purchased,
          };
          entityManager.entities.set(horseId, e);
        }
      }
    }
  }

  /** Rebuild NPC runtimes from the settlement manager (cheap — pure CPU). */
  function rebuildNpcRuntimes(): void {
    ensureStableHorses();
    const resolved = settlementManager.nearbyNpcs()
      .filter((npc) => !deadNpcs.has(npc.id));
    // Home pad type per settlement, resolved once here instead of per frame.
    const padsByName = new Map<string, import('./settlement/settlement-layout').ResolvedPad[]>();
    for (const s of settlementManager.nearby()) padsByName.set(s.name, s.pads);
    npcRuntimes = resolved.map((npc, i) => {
      // Per-NPC deterministic rng seeded from npc id.
      let idHash = 0x811c9dc5 >>> 0;
      for (let c = 0; c < npc.id.length; c++) {
        idHash ^= npc.id.charCodeAt(c);
        idHash = Math.imul(idHash, 0x01000193) >>> 0;
      }
      const rng = mulberry32(idHash);
      const homePads = padsByName.get(npc.settlementName);
      const homePadType =
        homePads !== undefined && npc.homePadIndex >= 0 &&
        npc.homePadIndex < homePads.length
          ? homePads[npc.homePadIndex].type
          : '';
      return {
        npc,
        wx: npc.wx,
        wy: npc.wy,
        wz: npc.wz,
        yaw: rng() * Math.PI * 2,
        walkPhase: rng() * Math.PI * 2,
        walkAmp: 0,
        wpIdx: i % npc.wwaypoints.length,
        pauseS: rng() * 3,
        rng,
        hp: 10,
        fleeing: false,
        attitude: 'calm' as const,
        attackCooldown: 0,
        homePadType,
        indoors: false,
        inArena: false,
      };
    });
    npcsDirty = false;
  }

  /** How long a corpse stays visible while sinking into the ground (s). */
  const NPC_CORPSE_SINK_S = 6;
  /** 3 in-game minutes = 180 sim-seconds for NPC respawn (Feature 8). */
  const NPC_RESPAWN_S = 180;

  /**
   * Mark an NPC as dead with a respawn timer (Feature 8).
   * The NPC's id is NOT added to the permanent deadNpcs set — it will
   * revive at its home position after NPC_RESPAWN_S sim seconds.
   * (Guards killed by the player still respawn — jail is the permanent penalty.)
   */
  function onNpcKilled(rt: NpcRuntime): void {
    if (rt.deadAtS !== undefined) return;
    rt.deadAtS = simTime;
    rt.fleeing = false;
    rt.walkAmp = 0;
    rt.respawnAtS = simTime + NPC_RESPAWN_S;
    setGatherNotice(`${rt.npc.name} is dead.`);
  }

  /**
   * Collision-aware NPC step: slides along settlement solids like the player.
   * Returns the actual distance moved (for stuck detection).
   */
  function npcMove(rt: NpcRuntime, dx: number, dz: number): number {
    const ox = rt.wx;
    const oz = rt.wz;
    [rt.wx, rt.wz] = terrainWorld.moveXZ(ox, oz, dx, dz, 0.35);
    rt.wy = terrainWorld.groundHeight(rt.wx, rt.wz, 0.35);
    return Math.hypot(rt.wx - ox, rt.wz - oz);
  }

  // Phase N2: hostile-civilian combat (weaker than guards — brave, not deadly).
  // Phase N8: companion follow (NPC convinced to walk with the player).
  const NPC_FOLLOW_SPEED   = 3.2; // m/s — keeps up with a walking/jogging player
  const NPC_FOLLOW_STOP    = 3;   // m — close enough, stand and face the player
  const NPC_FOLLOW_GIVE_UP = 45;  // m — lost them, return to routine

  const CIVILIAN_HOSTILE_SPEED = 3;    // m/s chase
  const CIVILIAN_MELEE_DMG     = 1;    // hp per hit
  const CIVILIAN_MELEE_PERIOD  = 1.5;  // s between hits
  const CIVILIAN_MELEE_DIST    = 2.2;  // m
  const CIVILIAN_GIVE_UP_DIST  = 40;   // m — beyond this they go back to calm

  // Phase N4: first visit to a settlement — a guard walks up and questions
  // the newcomer (towns/castles); guard-less places hail from a distance.
  const APPROACH_WALK_SPEED  = 2.5;  // m/s — brisk, not hostile
  const APPROACH_QUESTION_DIST = 3;  // m — open the chat at this range
  const APPROACH_GIVE_UP_DIST = 60;  // m — player left; stop following
  let firstVisitAccum = 0;

  /** Scan for entry into an unvisited settlement (throttled to ~1 Hz). */
  function tickFirstVisit(): void {
    if (dungeonManager.isInside || buildingManager.isInside || panels.isOpen || mountedEntityId !== null) return;
    const px = controller.pos[0];
    const pz = controller.pos[2];
    for (const s of settlementManager.nearby()) {
      if (visitedSettlements.has(s.name)) continue;
      if (Math.hypot(px - s.site.x, pz - s.site.z) > s.site.radius) continue;
      visitedSettlements.add(s.name);
      saveVisitedSet(visitedSettlements);
      // Outlaws get the existing bounty flow, not a welcome.
      if (bountyIn(crimeState, s.name) > 0 || guardsHostile) continue;
      const inTown = (rt: NpcRuntime): boolean =>
        rt.hp > 0 && Math.hypot(rt.wx - s.site.x, rt.wz - s.site.z) <= s.site.radius + 20;
      const nearestOf = (list: NpcRuntime[]): NpcRuntime | null => {
        let best: NpcRuntime | null = null;
        let bestD = Infinity;
        for (const rt of list) {
          const d = Math.hypot(rt.wx - px, rt.wz - pz);
          if (d < bestD) { bestD = d; best = rt; }
        }
        return best;
      };
      const guard = nearestOf(npcRuntimes.filter((rt) => rt.npc.role === 'guard' && inTown(rt)));
      if (guard !== null) {
        guard.attitude = 'approach';
        setGatherNotice('A guard strides toward you…');
      } else {
        const civ = nearestOf(npcRuntimes.filter((rt) => rt.npc.role !== 'guard' && inTown(rt)));
        if (civ !== null) {
          setGatherNotice(`${civ.npc.name} waves: "New face! Welcome to ${s.name}."`);
          const rec = getOrCreateMemory(npcMemoryMap, `${s.name}::${civ.npc.id}`);
          adjustDisposition(rec, 5);
          saveMemoryMap(npcMemoryMap);
        }
      }
      break; // one settlement per scan
    }
  }

  /** Tick NPC movement AI (called once per sim step). */
  // --- NPCs inside buildings -------------------------------------------------
  //
  // Before this, every NPC lived on the street forever: `buildNpcDraws` filtered
  // on world XZ, interiors are built in a separate arena tens of thousands of
  // metres away, and every interaction path was gated on `!isInside`. So the
  // tavern keeper you paid for a bed was implied rather than present, and at
  // 3 a.m. a whole village stood outside in the rain.
  //
  // The model is: an NPC with a home may WITHDRAW indoors (schedule below).
  // While withdrawn they are simply absent outdoors. If the player then enters
  // that exact building, the NPC is teleported into the interior arena and
  // their runtime position becomes arena-space — which is the same space the
  // player is in while indoors, so no other system needs to know.

  /**
   * Public buildings somebody staffs all day. Deliberately excludes 'barn',
   * which resolves to shop/tavern/barn by per-building seed and so cannot be
   * predicted from the pad type, and excludes jail/keep/tower/gatehouse so the
   * watch stays on the street where the crime system needs them.
   */
  const WORKPLACE_PADS: ReadonlySet<string> = new Set([
    'tavern', 'church', 'smithy', 'longhouse',
  ]);

  /** Villagers turn in for the night outside these hours. Matches the sky. */
  const NIGHT_START = 0.78;
  const NIGHT_END = 0.24;

  /** Should this NPC currently be inside their home building? */
  function npcWantsIndoors(rt: NpcRuntime, tod: number): boolean {
    if (rt.hp <= 0) return false;
    if (rt.following === true) return false;       // walking with the player
    if (rt.attitude !== 'calm') return false;      // fleeing/hostile: not now
    if (rt.npc.homePadIndex < 0) return false;     // no home to go to
    // Never send anyone through a door that does not open, or they would be
    // unreachable for the rest of the game.
    if (!isEnterablePad(rt.homePadType)) return false;
    if (WORKPLACE_PADS.has(rt.homePadType)) return true;  // minding the shop
    if (rt.npc.role === 'guard') return false;            // guards keep watch
    return tod >= NIGHT_START || tod < NIGHT_END;
  }

  /**
   * Move NPCs in and out of their buildings, and in and out of the interior
   * arena as the player enters and leaves. Runs once per NPC tick.
   */
  function tickNpcHomes(): void {
    const tod = todFreeze ?? (simTime / DAY_LENGTH_S + TOD_START) % 1;
    const here = buildingManager.occupiedBuilding;

    // Who is in the room with the player, in stable id order so the spot each
    // NPC gets does not shuffle between frames.
    const present: NpcRuntime[] = [];
    if (here !== null) {
      for (const rt of npcRuntimes) {
        if (rt.hp <= 0) continue;
        if (rt.npc.settlementName !== here.settlementName) continue;
        if (rt.npc.homePadIndex !== here.padIndex) continue;
        present.push(rt);
      }
      present.sort((a, b) => (a.npc.id < b.npc.id ? -1 : 1));
    }
    const spots = present.length > 0
      ? buildingManager.interiorStandSpots(present.length)
      : [];

    for (const rt of npcRuntimes) {
      const wantsIn = npcWantsIndoors(rt, tod);
      const idx = present.indexOf(rt);
      // Present in the player's room AND due to be indoors → occupy the arena.
      const shouldOccupy = idx >= 0 && idx < spots.length && (wantsIn || rt.inArena);

      if (shouldOccupy) {
        if (!rt.inArena) {
          rt.outdoorPos = [rt.wx, rt.wy, rt.wz];
          rt.inArena = true;
        }
        const [sx, sy, sz] = spots[idx];
        rt.wx = sx; rt.wy = sy; rt.wz = sz;
        rt.indoors = true;
        rt.walkAmp = 0;
        // Face the player so they read as attentive rather than furniture.
        // Mesh forward is (sin yaw, -cos yaw) — see controller.ts — so facing
        // a delta (dx, dz) is atan2(dx, -dz). Using atan2(dx, dz) turns them
        // to face the opposite wall, which is how this first shipped.
        const dx = controller.pos[0] - rt.wx;
        const dz = controller.pos[2] - rt.wz;
        if (dx * dx + dz * dz > 0.04) rt.yaw = Math.atan2(dx, -dz);
        continue;
      }

      if (rt.inArena) {
        // Player left (or the NPC did): restore the street position.
        if (rt.outdoorPos !== undefined) {
          rt.wx = rt.outdoorPos[0];
          rt.wy = rt.outdoorPos[1];
          rt.wz = rt.outdoorPos[2];
          rt.outdoorPos = undefined;
        }
        rt.inArena = false;
      }
      rt.indoors = wantsIn;
    }
  }

  function tickNpcs(dtS: number): void {
    if (npcsDirty) rebuildNpcRuntimes();
    tickNpcHomes();
    firstVisitAccum -= dtS;
    if (firstVisitAccum <= 0) {
      firstVisitAccum = 1;
      tickFirstVisit();
    }
    const px = controller.pos[0];
    const pz = controller.pos[2];
    for (const rt of npcRuntimes) {
      // Feature 8: NPC respawn — revive after NPC_RESPAWN_S sim seconds.
      if (rt.hp <= 0 && rt.respawnAtS !== undefined && simTime >= rt.respawnAtS) {
        rt.hp = 10;
        rt.attitude = 'calm';
        rt.fleeing = false;
        rt.deadAtS = undefined;
        rt.respawnAtS = undefined;
        // Place back at home position (the npc's settlement waypoint).
        rt.wx = rt.npc.wx;
        rt.wz = rt.npc.wz;
        rt.wy = rt.npc.wy;
        continue;
      }
      // Dead NPCs stop ticking entirely (corpse handled in buildNpcDraws).
      if (rt.hp <= 0) { rt.walkAmp = 0; continue; }
      // Indoors: no street AI. Their patrol waypoints are outdoor world
      // coordinates, so running the usual movement would march them out of the
      // room and, when they are in the arena, several kilometres through a
      // wall. tickNpcHomes has already placed and oriented them.
      if (rt.indoors) { rt.walkAmp = 0; continue; }
      const dist = Math.hypot(rt.wx - px, rt.wz - pz);
      if (dist > NPC_SIM_DIST) continue;

      // Phase N4: guard walking up to question a newcomer.
      if (rt.attitude === 'approach' && rt.hp > 0) {
        if (dist <= APPROACH_QUESTION_DIST) {
          rt.attitude = 'calm';
          if (!panels.isOpen && mountedEntityId === null && !dungeonManager.isInside && !buildingManager.isInside) {
            const sName = settlementManager.nearestSettlement()?.name ?? 'these parts';
            openNpcChatFor(rt,
              `Halt, stranger. I don't know your face — what's your business in ${sName}?`);
          }
        } else if (dist > APPROACH_GIVE_UP_DIST) {
          rt.attitude = 'calm'; // player left — let them go
        } else {
          const adx = px - rt.wx;
          const adz = pz - rt.wz;
          const alen = Math.hypot(adx, adz) || 1;
          const step = Math.min(APPROACH_WALK_SPEED * dtS, alen);
          npcMove(rt, (adx / alen) * step, (adz / alen) * step);
          rt.yaw = Math.atan2(adx, -adz);
          rt.walkPhase += APPROACH_WALK_SPEED * dtS * 1.6;
          rt.walkAmp = 1;
          continue;
        }
      }

      // Phase N2: conversation-provoked hostile civilian (guards use
      // tickGuardEnforcement via the guardsHostile flag instead).
      if (rt.attitude === 'hostile' && rt.npc.role !== 'guard' && rt.hp > 0) {
        if (dist > CIVILIAN_GIVE_UP_DIST) {
          rt.attitude = 'calm'; // player got away — cold, but done chasing
        } else {
          rt.attackCooldown -= dtS;
          if (dist > CIVILIAN_MELEE_DIST * 0.8) {
            const cdx = px - rt.wx;
            const cdz = pz - rt.wz;
            const clen = Math.hypot(cdx, cdz) || 1;
            const step = Math.min(CIVILIAN_HOSTILE_SPEED * dtS, clen);
            npcMove(rt, (cdx / clen) * step, (cdz / clen) * step);
            rt.yaw = Math.atan2(cdx, -cdz);
            rt.walkPhase += CIVILIAN_HOSTILE_SPEED * dtS * 1.6;
            rt.walkAmp = 1;
          }
          // No hits while a panel is up — the player can't move or fight back.
          if (dist <= CIVILIAN_MELEE_DIST && rt.attackCooldown <= 0 && vitals.alive &&
              !panels.isOpen) {
            rt.attackCooldown = CIVILIAN_MELEE_PERIOD;
            // Carved ground via the NPC's own foot height — see the guard
            // melee site above for why the raw field was wrong here.
            applyAttackOnPlayer(CIVILIAN_MELEE_DMG, 'combat', 'melee', 1.7, rt.wy,
              { x: rt.wx, z: rt.wz, kind: 'melee' });
          }
          continue;
        }
      }

      // Phase M: flee behavior when hit
      if (rt.fleeing && rt.hp > 0) {
        const fleeSpeed = NPC_WALK_SPEED * 2.5;
        if (dist < 20) {
          // Run away from player
          const fdx = rt.wx - px;
          const fdz = rt.wz - pz;
          const flen = Math.hypot(fdx, fdz) || 1;
          npcMove(rt, (fdx / flen) * fleeSpeed * dtS, (fdz / flen) * fleeSpeed * dtS);
          rt.yaw = Math.atan2(fdx, -fdz);
          rt.walkPhase += fleeSpeed * dtS * 1.6;
          rt.walkAmp = 1;
        } else {
          rt.fleeing = false; // far enough, stop fleeing
          if (rt.attitude === 'afraid') rt.attitude = 'calm';
        }
        continue;
      }

      // Phase N8: companion NPC following the player.
      if (rt.following === true && rt.attitude === 'calm') {
        if (dist > NPC_FOLLOW_GIVE_UP) {
          rt.following = false; // lost them — back to the daily routine
          setGatherNotice(`${rt.npc.name} turns back.`);
        } else if (dist > NPC_FOLLOW_STOP) {
          const fdx = px - rt.wx;
          const fdz = pz - rt.wz;
          const flen = Math.hypot(fdx, fdz) || 1;
          const step = Math.min(NPC_FOLLOW_SPEED * dtS, flen);
          npcMove(rt, (fdx / flen) * step, (fdz / flen) * step);
          rt.yaw = Math.atan2(fdx, -fdz);
          rt.walkPhase += NPC_FOLLOW_SPEED * dtS * 1.6;
          rt.walkAmp = 1;
          continue;
        } else {
          // Close enough — stand facing the player.
          rt.yaw = Math.atan2(px - rt.wx, -(pz - rt.wz));
          rt.walkAmp += (0 - rt.walkAmp) * Math.min(1, 8 * dtS);
          continue;
        }
      }

      if (rt.pauseS > 0) {
        rt.pauseS -= dtS;
        rt.walkAmp += (0 - rt.walkAmp) * Math.min(1, 8 * dtS);
        continue;
      }

      const wps = rt.npc.wwaypoints;
      if (wps.length === 0) continue;
      const target = wps[rt.wpIdx % wps.length];
      const dx = target.x - rt.wx;
      const dz = target.z - rt.wz;
      const dist2 = Math.hypot(dx, dz);

      if (dist2 < 0.5) {
        // Reached waypoint — advance and pause.
        rt.wpIdx = (rt.wpIdx + 1) % wps.length;
        // Pause 2-6 s (deterministic via per-NPC rng).
        rt.pauseS = 2 + rt.rng() * 4;
        rt.walkAmp = 0;
        continue;
      }

      // Walk toward waypoint.
      const step = Math.min(NPC_WALK_SPEED * dtS, dist2);
      const moved = npcMove(rt, (dx / dist2) * step, (dz / dist2) * step);
      rt.yaw = Math.atan2(dx, -dz);
      rt.walkPhase += NPC_WALK_SPEED * dtS * 1.6;
      rt.walkAmp += (1 - rt.walkAmp) * Math.min(1, 8 * dtS);
      // Anti-stuck: blocked on a building corner — skip to the next waypoint.
      if (moved < step * 0.2) {
        rt.wpIdx = (rt.wpIdx + 1) % wps.length;
        rt.pauseS = 1 + rt.rng() * 2;
        rt.walkAmp = 0;
      }
    }
  }

  /** Build NPC TerrainDraws for this frame (within render distance, cap 12). */
  function buildNpcDraws(playerX: number, playerZ: number): import('./renderer').TerrainDraw[] {
    // Indoors the player is in the interior arena, so only the NPCs that have
    // been moved into that arena are drawable; outdoors it is the reverse.
    // Without this an indoor NPC would still be rendered standing in the street
    // outside their own front door.
    const inside = buildingManager.isInside;
    const candidates = npcRuntimes
      .filter((rt) => (inside ? rt.inArena : !rt.indoors))
      .map((rt) => ({ rt, dist: Math.hypot(rt.wx - playerX, rt.wz - playerZ) }))
      .filter((c) => c.dist <= NPC_RENDER_DIST)
      // Corpses stay drawn while sinking, then disappear for good.
      .filter((c) => c.rt.hp > 0 ||
        (c.rt.deadAtS !== undefined && simTime - c.rt.deadAtS < NPC_CORPSE_SINK_S))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, NPC_MAX_DRAWN);

    // --- stable slot assignment ---------------------------------------------
    //
    // Pass 1 hands each candidate back the slot it used last frame; pass 2
    // fills the rest from whatever is left. At most 12x12 string compares, and
    // it is what turns "every mesh is stale" into "almost none are".
    npcSlotTaken.fill(0);
    npcSlotOf.fill(-1);
    for (let i = 0; i < candidates.length; i++) {
      for (let j = 0; j < npcPool.length; j++) {
        if (npcSlotTaken[j] === 0 && npcPool[j].ownerId === candidates[i].rt.npc.id) {
          npcSlotOf[i] = j;
          npcSlotTaken[j] = 1;
          break;
        }
      }
    }
    for (let i = 0; i < candidates.length; i++) {
      if (npcSlotOf[i] !== -1) continue;
      let j = 0;
      // A slot beyond the current pool length is unclaimed by construction;
      // `getNpcPoolEntry` grows the pool to cover it below.
      while (j < npcPool.length && npcSlotTaken[j] === 1) j++;
      npcSlotOf[i] = j;
      if (j < NPC_MAX_DRAWN) npcSlotTaken[j] = 1;
    }

    npcFrameNo++;
    let budget = npcLodEnabled ? NPC_REBUILD_BUDGET : Infinity;
    npcDrawCost.drawn = candidates.length;
    npcDrawCost.wanted = 0;
    npcDrawCost.spent = 0;
    npcDrawCost.forced = 0;
    const npcCostT0 = performance.now();

    const draws: import('./renderer').TerrainDraw[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const { rt, dist } = candidates[i];
      const entry = getNpcPoolEntry(npcSlotOf[i]);

      // `candidates` is sorted by distance, so the budget is spent
      // nearest-first and a crowd degrades from the back, where it cannot be
      // seen. A slot that has changed hands is mandatory and NOT charged: it
      // still holds the previous occupant's vertices, so skipping it draws the
      // wrong person entirely.
      const interval = !npcLodEnabled ? 1
        : dist < NPC_LOD_NEAR ? 1 : dist < NPC_LOD_MID ? 2
          : dist < NPC_LOD_FAR ? 3 : 4;
      const mustRebuild = entry.ownerId !== rt.npc.id || entry.count === 0;
      const wants = interval === 1
        || ((npcFrameNo + npcIdHash(rt.npc.id)) % interval) === 0;
      if (wants) npcDrawCost.wanted++;
      if (mustRebuild) npcDrawCost.forced++;
      let rebuild = mustRebuild;
      if (!rebuild && wants && budget > 0) {
        rebuild = true;
        budget--;
        npcDrawCost.spent++;
      }

      // Corpse-sink and world position are uploaded every frame regardless —
      // 16 bytes, and skipping them is what would make an NPC slide.
      let drawY = rt.wy;
      if (rt.hp <= 0 && rt.deadAtS !== undefined) {
        const p = Math.min(1, (simTime - rt.deadAtS) / NPC_CORPSE_SINK_S);
        drawY = rt.wy - p * 1.9;
      }
      npcObjScratch[0] = rt.wx;
      npcObjScratch[1] = drawY;
      npcObjScratch[2] = rt.wz;
      npcObjScratch[3] = 1;
      renderer.device.queue.writeBuffer(entry.objectBuffer, 0, npcObjScratch);

      if (rebuild) {
        entry.count = buildNpcMesh(rt, entry);
        entry.ownerId = rt.npc.id;
      }

      draws.push({
        vertexBuffer: entry.vertexBuffer,
        indexBuffer: null,
        count: entry.count,
        bindGroup: entry.bindGroup,
        shadowBindGroup: entry.shadowBindGroup,
      });
    }
    npcDrawCost.ms = performance.now() - npcCostT0;
    return draws;
  }

  /**
   * Re-pose one NPC's character mesh and upload it. Returns the vertex count.
   *
   * Split out of `buildNpcDraws` so the LOD above reads as a schedule rather
   * than as a hundred lines of costume derivation with an `if` around it.
   */
  function buildNpcMesh(rt: NpcRuntime, entry: NpcPoolEntry): number {
    const pal = NPC_PALETTE[rt.npc.role] ?? NPC_PALETTE['villager'];
    const nid = rt.npc.id;
    // Gender is derived from the seeded name — women get the female body
    // plan and long hair so they read as female at a glance.
    const female = npcGenderFor(rt.npc.name) === 'female';

    // --- Per-NPC deterministic color variation (seeded from npc id) ---
    const skinVar   = varyColor(pal.skin,  nid, 0.08);
    const shirtVar  = varyColor(pal.shirt, nid, 0.10);
    const pantsVar  = varyColor(pal.pants, nid, 0.08);
    const hairVar   = varyColor(pal.hair,  nid, 0.14);

    // --- Hair style: women get 3 (flowing) or 2, men get 1 ---
    // Use a hash to give some women flowing hair vs just long.
    const hairChoice = npcHashF(nid, 7);
    const hairStyle = female ? (hairChoice > 0.45 ? 3 : 2) : 1;

    // --- Accessories: role base + female skirt/dress ---
    const baseAcc = pal.accessories ?? {};
    const acc: import('./character/character-mesh').NpcAccessories = { ...baseAcc };
    // Women get a skirt in the shirt color (creates a dress effect).
    if (female) {
      acc.skirt = shirtVar;
    }
    // Farmer women: lighter apron for a feminine rustic look
    if (female && rt.npc.role === 'farmer') {
      acc.apron = [0.82, 0.75, 0.60];
    }

    const custom2: import('./character/character-mesh').CharacterCustomization = {
      skinTone: skinVar,
      shirtColor: shirtVar,
      pantsColor: pantsVar,
      hairStyle,
      hairColor: hairVar,
      body: female ? 'female' : 'male',
      accessories: acc,
    };
    const opts: import('./character/character-mesh').CharacterOptions = {
      body: female ? 'female' : 'male',
      armor: pal.armor,
    };
    const verts = buildCharacterMesh(custom2, {
      yaw: rt.yaw,
      walkPhase: rt.walkPhase,
      walkAmp: rt.hp <= 0 ? 0 : rt.walkAmp,
      attackT: 1,
    }, null, opts, npcMeshScratch);
    const npcVerts = fitCharacterMesh(verts);
    renderer.device.queue.writeBuffer(entry.vertexBuffer, 0, npcVerts);
    return npcVerts.length / (STRIDE_CREATURE / 4);
  }

  /**
   * Can this NPC see what is happening where the player is standing?
   *
   * Someone who has withdrawn into a building the player is not in is behind a
   * wall, and their parked street position must not make them a witness to a
   * crime committed outside their own front door. When the player IS in the
   * room with them their position is arena-space, matching the player's, so
   * ordinary distance tests are correct again.
   */
  function npcCanWitness(rt: NpcRuntime): boolean {
    return !rt.indoors || rt.inArena;
  }

  /**
   * Indoors, does the nearest NPC beat the building's own prompt for the E key?
   *
   * The tavern bar has a chest beside it, so standing at the counter offered
   * "Press E to open the chest" while the keeper you came to talk to was 8 cm
   * away and unreachable — the building branch is tested first and, until now,
   * unconditionally. Whoever is nearer wins.
   */
  function npcBeatsBuilding(): boolean {
    if (!buildingManager.isInside) return false;
    const rt = nearestNpc();
    if (rt === null) return false;
    const d = Math.hypot(
      rt.wx - controller.pos[0], rt.wz - controller.pos[2]);
    return d < buildingManager.interactDist;
  }

  /** Nearest NPC within NPC_INTERACT_DIST from the player, or null. */
  function nearestNpc(): NpcRuntime | null {
    const px = controller.pos[0];
    const pz = controller.pos[2];
    let best: NpcRuntime | null = null;
    let bestD = NPC_INTERACT_DIST;
    for (const rt of npcRuntimes) {
      if (rt.hp <= 0) continue; // the dead don't chat
      // Someone shut in a building you are not in is behind a wall, even if
      // their parked street position happens to be a metre from you.
      if (rt.indoors && !rt.inArena) continue;
      const d = Math.hypot(rt.wx - px, rt.wz - pz);
      if (d < bestD) { bestD = d; best = rt; }
    }
    return best;
  }

  /** Market stall pad within reach of the player, or null. */
  function nearestStallPad(): { wx: number; wz: number } | null {
    const px = controller.pos[0];
    const pz = controller.pos[2];
    const STALL_REACH = 3.5;
    let best: { wx: number; wz: number } | null = null;
    let bestD = STALL_REACH;
    for (const resolved of settlementManager.nearby()) {
      for (const pad of resolved.pads) {
        if (pad.type !== 'stall') continue;
        const d = Math.hypot(pad.wx - px, pad.wz - pz);
        if (d < bestD) { bestD = d; best = { wx: pad.wx, wz: pad.wz }; }
      }
    }
    return best;
  }

  /**
   * Well within reach, or null.
   *
   * Wells were scenery: villages, towns and castles all place one and the
   * player could not do the one thing a well is for. Same shape as
   * `nearestStallPad`, and deliberately a slightly longer reach than the
   * 2.5 m used for a river — you drink at a well from its rim, and the pad
   * centre is 0.75 m inside that rim.
   */
  function nearestWellPad(): { wx: number; wz: number } | null {
    if (dungeonManager.isInside || buildingManager.isInside) return null;
    const px = controller.pos[0];
    const pz = controller.pos[2];
    const WELL_REACH = 3.0;
    let best: { wx: number; wz: number } | null = null;
    let bestD = WELL_REACH;
    for (const resolved of settlementManager.nearby()) {
      for (const pad of resolved.pads) {
        if (pad.type !== 'well') continue;
        const d = Math.hypot(pad.wx - px, pad.wz - pz);
        if (d < bestD) { bestD = d; best = { wx: pad.wx, wz: pad.wz }; }
      }
    }
    return best;
  }

  /**
   * E at a well: drink. Drawn water is cleaner than a river, so it quenches
   * more — a well the player walked to should never be the worse option.
   * Returns false when no well is in reach, so the E chain falls through.
   */
  function tryDrinkWell(): boolean {
    if (nearestWellPad() === null) return false;
    drinkPlayer(vitals, WELL_QUENCH);
    audio.play('eat_drink');
    saveVitals(vitals);
    setGatherNotice('You draw a bucket and drink deeply.');
    return true;
  }

  /**
   * E near a market stall: open chat with the merchant attending it (the
   * nearest live merchant within 25 m of the stall), or a notice when the
   * stall is unattended. Returns false when no stall is in reach.
   */
  function tryStallInteract(ev?: KeyboardEvent): boolean {
    const stall = nearestStallPad();
    if (stall === null) return false;
    let best: NpcRuntime | null = null;
    let bestD = 25;
    for (const rt of npcRuntimes) {
      if (rt.hp <= 0 || rt.npc.role !== 'merchant') continue;
      const d = Math.hypot(rt.wx - stall.wx, rt.wz - stall.wz);
      if (d < bestD) { bestD = d; best = rt; }
    }
    if (best === null) {
      setGatherNotice('The stall is unattended right now.');
      return true;
    }
    // Prevent the "e" from being typed into the auto-focused chat input.
    ev?.preventDefault();
    openNpcChatFor(best);
    return true;
  }

  /**
   * Open the NPC chat panel for a runtime (Phase L2/N4).
   * `openingLine` overrides the greeting for NPC-initiated dialogue.
   */
  function openNpcChatFor(npcRt: NpcRuntime, openingLine?: string): void {
    const settlementInfo = settlementManager.nearestSettlement();
    const settName = settlementInfo?.name ?? 'Unknown';
    // Phase M: pass real regional bounty to NPC persona
    const realBounty = bountyIn(crimeState, settName);

    // Settlement roster + relationships: same-settlement NPCs share the
    // "npc_<seed>_" id prefix.  Sort by spawn index so relation pairing is
    // deterministic regardless of runtime order.
    const idPrefix = npcRt.npc.id.slice(0, npcRt.npc.id.lastIndexOf('_') + 1);
    const settlers = npcRuntimes
      .filter((r) => r.hp > 0 && r.npc.id.startsWith(idPrefix))
      .map((r) => r.npc)
      .sort((a, b) =>
        Number(a.id.slice(idPrefix.length)) - Number(b.id.slice(idPrefix.length)));
    const relations = buildNpcRelations(settlers);
    const myRel = relations.get(npcRt.npc.id);
    // If this NPC married the player, their lore-spouse becomes a dear friend.
    const playerMarried = npcMemoryMap[`${settName}::${npcRt.npc.id}`]?.spouse === true;
    const neighbors = settlers
      .filter((n) => n.id !== npcRt.npc.id)
      .map((n) => {
        let relation = myRel?.get(n.id) ?? '';
        if (playerMarried && (relation === 'your wife' || relation === 'your husband')) {
          relation = 'your dear friend';
        }
        return { name: n.name, role: n.role, relation };
      });

    // A couple of concrete observations so the NPC knows its surroundings.
    const worldFacts: string[] = [];
    if (settlementInfo !== null) {
      worldFacts.push(`${settName} is a ${settlementInfo.kind}.`);
    }
    let stableHorses = 0;
    for (const e of entityManager.entities.values()) {
      if (e.npcOwned && e.species === 'horse' && e.hp > 0 &&
          Math.hypot(e.x - npcRt.wx, e.z - npcRt.wz) < 60) stableHorses++;
    }
    if (stableHorses > 0) {
      worldFacts.push(`${stableHorses === 1 ? 'A horse grazes' :
        `${stableHorses} horses graze`} by the settlement stable.`);
    }

    // Phase N6: live surroundings snapshot — time, weather, wildlife, fire,
    // and what the traveller visibly carries/wears/rode in on.
    const px = controller.pos[0];
    const pz = controller.pos[2];
    const wildlife: { name: string; aggro: boolean; dist: number }[] = [];
    let mountName: string | null = null;
    let mountDist = Infinity;
    for (const e of entityManager.entities.values()) {
      if (e.hp <= 0) continue;
      const def = SPECIES_DEFS[e.species];
      if (e.owned === true) {
        const d = Math.hypot(e.x - px, e.z - pz);
        if (def.mountable && d < 25 && d < mountDist) {
          mountDist = d;
          mountName = def.name;
        }
        continue;
      }
      if (e.npcOwned === true) continue; // stable horses already covered above
      const d = Math.hypot(e.x - npcRt.wx, e.z - npcRt.wz);
      if (d < 50) wildlife.push({ name: def.name, aggro: def.aggro, dist: d });
    }
    let burningNear = 0;
    for (const bt of getBurningTrees()) {
      if (Math.hypot(bt.x - npcRt.wx, bt.z - npcRt.wz) < 120) burningNear++;
    }
    const heldId = equipped(inventory);
    const armorTierWord = (() => {
      const ids = [inventory.armor.head?.id, inventory.armor.body?.id,
        inventory.armor.legs?.id];
      if (ids.some((id) => id?.startsWith('dragonscale_'))) return 'dragon-scale';
      if (ids.some((id) => id?.startsWith('iron_'))) return 'iron';
      if (ids.some((id) => id?.startsWith('leather_'))) return 'leather';
      if (ids.some((id) => id?.startsWith('fiber_'))) return 'woven fiber';
      return null;
    })();
    worldFacts.push(...buildSurroundingsFacts({
      tod: todFreeze ?? (simTime / DAY_LENGTH_S + TOD_START) % 1,
      weather: (weatherPin ?? weatherAt(WORLD_SEED, simTime)).kind,
      wildlife,
      burningTrees: burningNear,
      heldItem: heldId !== null ? itemDef(heldId).name : null,
      armor: armorTierWord,
      mount: mountName,
    }));

    // Let the village talk before this conversation starts. One pass per
    // opened conversation is a rate that feels like time passing: what you did
    // in front of one farmer has usually reached their spouse by the time you
    // reach the next house, but not the whole settlement at once.
    spreadVillageNews(villageMemory, settName,
      buildNpcRelations(npcRuntimes.map((r) => ({
        id: r.npc.id, name: r.npc.name, role: r.npc.role,
      }))), 1);
    saveVillageMemory(villageMemory);

    const persona: import('./npc/npc-prompt').NpcPersona = {
      role: npcRt.npc.role,
      name: npcRt.npc.name,
      settlement: settName,
      playerBounty: realBounty,
      neighbors,
      worldFacts,
      following: npcRt.following === true,
      quirk: npcQuirkFor(npcRt.npc.id),
      // What this NPC saw or has been told. `newsFor` puts firsthand first.
      villageNews: newsFor(villageMemory, settName, npcRt.npc.id)
        .map((n) => n.text),
      // Shared knowledge, generated once per settlement and then persistent —
      // so two NPCs cannot describe the same concern differently, and "ask
      // Nils" points at the NPC who actually owns it.
      villageFacts: factLinesFor(
        factsFor(villageFacts, settName, WORLD_SEED,
          npcRuntimes.map((r) => ({
            id: r.npc.id, name: r.npc.name, role: r.npc.role,
          })),
          [...new Set([...entityManager.entities.values()]
            .filter((e) => Math.hypot(e.x - npcRt.wx, e.z - npcRt.wz) < 220)
            .map((e) => e.species))]),
        npcRt.npc.id),
      // Witnessing a killing should sour someone regardless of how politely
      // the player has traded with them before, so this is added to the stored
      // dyadic disposition rather than replacing it.
      disposition: dispositionFromNews(villageMemory, settName, npcRt.npc.id),
    };
    panels.toggle('npc-chat', () => buildNpcChatPanel({
      persona,
      npcId: npcRt.npc.id,
      settlementName: settName,
      inventory,
      onInvChanged: invChanged,
      panels,
      stubMode: directorOff,
      gpu: directorOff ? undefined : gpu,
      npcModel: npcModelKey,
      stockMap: npcStockMap,
      memoryMap: npcMemoryMap,
      openingLine,
      onNpcAction: (actionNpcId, action) => {
        const rt = npcRuntimes.find((r) => r.npc.id === actionNpcId);
        if (rt === undefined) return;
        if (action === 'hostile') {
          if (rt.npc.role === 'guard') {
            guardsHostile = true; // guards respond as a unit
            setGatherNotice('The guards turn on you!');
          } else {
            rt.attitude = 'hostile';
            rt.attackCooldown = 2.0; // real beat of hesitation — time to run or draw
            setGatherNotice(`${rt.npc.name} turns hostile!`);
          }
        } else if (action === 'afraid') {
          rt.attitude = 'afraid';
          rt.fleeing = true;
          setGatherNotice(`${rt.npc.name} flees in fear!`);
        } else if (action === 'accept_proposal') {
          setGatherNotice(`You are now married to ${rt.npc.name}!`);
        } else if (action === 'follow') {
          rt.following = true;
          setGatherNotice(`${rt.npc.name} follows you. (say "stay here" to part ways)`);
        } else if (action === 'stay') {
          rt.following = false;
          setGatherNotice(`${rt.npc.name} stays behind.`);
        } else if (action === 'invite_home') {
          // Teleport the player into the NPC's (deterministic) home. The
          // chat panel stays open — the conversation continues by the hearth.
          const sett = settlementManager.nearby()
            .find((s) => s.name === settName) ?? null;
          const entered = sett !== null &&
            !dungeonManager.isInside && !buildingManager.isInside &&
            buildingManager.enterNpcHome(sett, actionNpcId, rt.npc.homePadIndex);
          setGatherNotice(entered
            ? `${rt.npc.name} welcomes you into their home.`
            : `${rt.npc.name} gestures toward their home.`);
        }
        // Threatening a civilian in front of a guard is a crime.
        if ((action === 'hostile' || action === 'afraid') && rt.npc.role !== 'guard') {
          const guardSaw = npcRuntimes.some((o) =>
            o !== rt && o.npc.role === 'guard' && npcCanWitness(o) &&
            Math.hypot(o.wx - rt.wx, o.wz - rt.wz) <= WITNESS_RADIUS);
          if (guardSaw) {
            reportCrime(crimeState, nearestRegionId(), 'threat', simTime);
            saveCrimeState(crimeState);
            setGatherNotice(`Threat witnessed! Bounty +${BOUNTY_AMOUNTS.threat}`);
          }
        }
      },
    }));
  }

  // -------------------------------------------------------------------------
  // Phase K: taming registry + mount state
  // -------------------------------------------------------------------------
  let tamingRegistry: TamingRegistry = loadTamingRegistry();

  // DEMO: starter tamed WYVERN at spawn (user request for testing).
  // Live entities are not persisted across reloads, so each boot re-ensures
  // one owned, fully-tamed flier beside the spawn point. Owned entities
  // follow the player, never aggro, and are exempt from cap/unload.
  //
  // Was a dragon. The wyvern is the better starter mount: it is the common
  // flier rather than the apex encounter, so handing the player one at spawn
  // does not give away the top of the ladder before they have climbed it.
  {
    // Waiting beyond the breach rather than at the old world spawn: the player
    // now starts in a cell, and a tame flier parked in the prison with them
    // would answer the escape before it is asked.
    const wyvernAt = castleManager.markerWorld('outside') ?? SPAWN_POS;
    const sd = entityManager.spawnEntity(
      'wyvern', wyvernAt[0] + 10, wyvernAt[2] + 8);
    if (sd !== null) {
      sd.owned = true;
      sd.mode = 'follow';
      tamingRegistry.tamed[sd.id] = { temper: 100, tamed: true };
      saveTamingRegistry(tamingRegistry);
    }
  }

  /**
   * The king's mount, circling the castle.
   *
   * `pinned = true` exempts the pair from `EntityManager`'s cell streaming and
   * live cap — without it the dragon vanishes the moment the player walks
   * 200 m away, which is exactly when they are meant to be looking back at it.
   *
   * They used to spawn `owned` for that, which was the only exemption at the
   * time. It stopped being safe when the boss fight started handing the King
   * to `stepAnimal`, where `owned` means "the player's pet": it forced him
   * into `follow` so he never swung, and main.ts's own owned-guard discarded
   * any blow that got through, so a dismounted King did exactly zero damage.
   * Two independent blockers from one overloaded word. `pinned` says only
   * what is meant — permanent, exempt from streaming — and carries no claim
   * about whose side he is on.
   *
   * The King rides it. He is a second entity pinned to the saddle every frame
   * rather than a part of the dragon's mesh, so the two can be fought,
   * damaged and dismounted independently later.
   */
  let kingDragonId: string | null = null;
  let evilKingId: string | null = null;
  {
    const perch = castleManager.markerWorld('dragonPerch');
    if (perch !== null) {
      const kd = entityManager.spawnEntity('black_dragon', perch[0], perch[2]);
      kd.pinned = true;
      kd.mode = 'idle';
      kd.y = perch[1];
      kingDragonId = kd.id;

      const ek = entityManager.spawnEntity('evil_king', perch[0], perch[2]);
      ek.pinned = true;
      ek.mode = 'idle';
      ek.y = perch[1];
      evilKingId = ek.id;
    }
  }

  // The King is a passenger, and the renderer has to be told so: without
  // `seat: 1` the humanoid rig runs its ground IK and he flies past the castle
  // standing bolt upright with his legs straight. `poseOverride` exists for
  // exactly this — it is applied last, after the animator, so a crossfade
  // cannot half-unseat him mid-flight.
  entityRenderer.poseOverride = (id, pose) => {
    if (id !== evilKingId) return;
    // Only while he is actually a passenger. Once the dragon is grounded or
    // dead he fights on foot, and `seat: 1` on a man walking at you leaves him
    // striding forward in a sitting position with his knees up.
    if (!kingIsMounted()) return;
    const mount = kingDragonId === null
      ? undefined : entityManager.entities.get(kingDragonId);
    kingRidingPose(pose, mount?.yaw ?? pose.yaw, mount?.walkPhase ?? 0, 1);
  };

  /**
   * Currently-mounted entity id, or null when not mounted.
   * When mounted: the player's position is locked to the entity's saddle,
   * movement input steers the entity using mountSpeed.
   */
  let mountedEntityId: string | null = null;

  /** Stable-horse purchase price (gold_small units). */
  const STABLE_HORSE_PRICE = 40;
  /** Pending E-to-confirm stable-horse purchase: entity id + expiry (ms). */
  let pendingHorseBuy: { id: string; until: number } | null = null;

  /**
   * Timer for 'accepted-ride' (8-second temporary ride before auto-buck).
   * -1 = not in an accepted-ride session.
   */
  let acceptedRideTimer = -1;
  const ACCEPTED_RIDE_S = 8;

  /**
   * DEMO: rares (dragon/griffin) mount instantly like commons — even big
   * wild adults accept riders. Taming (temper/feeding/eggs/babies) stays
   * functional underneath; set to false to restore the buck-and-tame gate.
   */
  const DEMO_FREE_RIDE_RARES = true;

  /** Sprint multiplier while mounted (Shift key). */
  const MOUNT_SPRINT_MUL = 1.3;

  /** Mount stamina drain rate (per second) while sprint-riding with movement. */
  const MOUNT_STAMINA_DRAIN_PER_S = 10;
  /** Mount stamina regen rate (per second) while not sprinting. */
  const MOUNT_STAMINA_REGEN_PER_S = 15;
  /** Sprint becomes available again once stamina recovers above this threshold. */
  const MOUNT_STAMINA_SPRINT_RESUME = 20;
  /**
   * Whether mount sprint is currently locked out due to exhaustion.
   * Cleared once mount stamina recovers above MOUNT_STAMINA_SPRINT_RESUME.
   */
  let mountSprintExhausted = false;

  /**
   * Current flight altitude of the dragon above the terrain directly below.
   * 0 = on the ground. Used to track the airborne state while mounted.
   * Only meaningful when mounted on a dragon with DRAGON_FLIGHT_ENABLED.
   */
  let dragonFlightY = 0;

  /**
   * True while riding a creature that can fly.
   *
   * The flight controls (Space ascend, Q/C/Ctrl descend) overlap keys that do
   * other things on foot, so several handlers need to stand down while a rider
   * is in the air. Kept as one predicate rather than repeating the lookup, so
   * a new flier cannot be added and quietly miss one of them.
   */
  function mountedOnFlier(): boolean {
    if (mountedEntityId === null) return false;
    const m = entityManager.entities.get(mountedEntityId);
    return m !== undefined && SPECIES_DEFS[m.species].canFly === true;
  }

  // -------------------------------------------------------------------------
  // Wild flier flight + breath
  //
  // Dragons, wyverns and griffins used to walk everywhere. Flight existed only
  // inside the mounted controller, so an untamed one was a very large lizard
  // that happened to have wings, and the wing-beat animation played over a
  // walking gait. Their breath had the same shape of problem: the pose opens
  // the jaw, but only the ridden path ever emitted fire or dealt damage.
  // -------------------------------------------------------------------------

  /** Cruise height above terrain while patrolling, in metres. */
  const FLY_CRUISE_MIN = 11;
  const FLY_CRUISE_MAX = 26;
  /** How high above the player a hunting flier holds before it strikes. */
  const FLY_STRIKE_ABOVE = 6;
  /** Vertical speed for wild fliers (slower than the ridden 6 m/s — a wild
   *  animal is not being urged). */
  const WILD_CLIMB_SPEED = 3.2;
  /** Seconds between a wild flier's breath attacks. */
  const WILD_BREATH_COOLDOWN_S = 4.5;
  /** How long one wild breath lasts. */
  const WILD_BREATH_S = 1.1;

  /** Per-entity flight/breath state, keyed by entity id. */
  interface FlierState {
    cruise: number; breathUntil: number; nextBreath: number;
    /**
     * Height above terrain, owned by this controller.
     *
     * Has to be state, not a delta applied to `e.y`. `moveToward` ends every
     * AI tick with `e.y = heightAt(x, z)`, so an incremental "+= climb * dt"
     * is wiped each tick and the creature hovers at exactly one frame's worth
     * of climb — measured at 0.1 m, which is what the first version did.
     */
    alt: number;
  }
  const flierState = new Map<string, FlierState>();

  /** Wild fliers currently breathing, rebuilt each frame for the VFX pass. */
  let wildBreaths: {
    mouth: [number, number, number]; dir: [number, number, number];
    jaw: number; reach: number; spark: boolean;
  }[] = [];

  /**
   * Give an un-ridden flier its altitude, and let it use its breath.
   *
   * Runs AFTER `stepAnimal`, which pins `e.y` to the terrain — see the call
   * site.
   *
   * TAMED fliers stay on the ground. The first version let them cruise too, on
   * the theory that a tamed wyvern jogging along behind the player looks
   * absurd — which is true, and completely beside the point. An owned flier
   * that drifts up to twenty metres is one the player cannot walk up to and
   * mount, so the animal they own spends its life out of reach. A companion
   * that is where you left it beats a companion that looks majestic.
   *
   * They still rise when the player does, so a tamed flier follows you up
   * while you are riding another one rather than being left on the ground.
   */
  /** True for tamed/owned animals (hatched babies, tamed mounts). */
  function isOwnedEntity(
    e: import('./entities/entity-manager').EntityState,
  ): boolean {
    return (e as import('./entities/entity-manager').EntityState
      & { owned?: boolean }).owned === true;
  }

  function tickWildFlier(
    e: import('./entities/entity-manager').EntityState,
    dtS: number, playerDist: number,
  ): void {
    const def = SPECIES_DEFS[e.species as Species];
    if (def.canFly !== true) return;
    if (e.id === mountedEntityId) return;   // the ridden controller owns it
    if (e.mode === 'dead') { flierState.delete(e.id); return; }
    // Out of sight is out of mind: no point flying something nobody can see,
    // and it keeps this off the per-frame budget for a whole map of creatures.
    if (playerDist > 160) return;

    let st = flierState.get(e.id);
    if (st === undefined) {
      // Deterministic cruise height per individual, so a flight of wyverns
      // stacks at different altitudes instead of forming a flat sheet.
      let h = 0x811c9dc5;
      for (let i = 0; i < e.id.length; i++) {
        h ^= e.id.charCodeAt(i); h = Math.imul(h, 0x01000193);
      }
      const u = ((h >>> 0) % 1000) / 1000;
      st = {
        cruise: FLY_CRUISE_MIN + u * (FLY_CRUISE_MAX - FLY_CRUISE_MIN),
        breathUntil: -1, nextBreath: simTime + u * WILD_BREATH_COOLDOWN_S,
        alt: Math.max(0, e.y - creatureGroundY(e, e.x, e.z, e.y)),
      };
      flierState.set(e.id, st);
    }

    // CARVED ground, with the castle's floors layered on it — the same query
    // the walking AI already uses (`creatureGroundY`). Everything in this
    // function works in HEIGHT ABOVE TERRAIN, so measuring it against the raw
    // generated land meant the whole altitude band was referenced to a surface
    // that is not the one drawn: fliers cruised down into road cuttings and
    // hovered inside terraced settlements, and their strike altitude over a
    // player standing on a causeway was off by the depth of the cut.
    const groundY = creatureGroundY(e, e.x, e.z, e.y);
    // Everything below works in HEIGHT ABOVE TERRAIN and writes `e.y` at the
    // end, so following ground that rises under the creature is free.
    let targetAlt: number;
    if (e.mode === 'aggro') {
      // Hunting: hold above the player and stoop. Measured against the
      // player's own height, not the terrain, so it stays overhead when they
      // are on a cliff or a roof.
      targetAlt = (controller.pos[1] - groundY) + FLY_STRIKE_ABOVE;
      // Close enough to bite: come all the way down, or it hovers out of reach
      // and the fight never resolves.
      if (playerDist < 7) targetAlt = Math.max(0, controller.pos[1] - groundY);
    } else if (isOwnedEntity(e)) {
      // Reachable, always. The only time an owned flier leaves the ground is
      // to keep up with a player who is already airborne on something else.
      const playerAlt = controller.pos[1] - chunkManager.ground.heightAt(
        controller.pos[0], controller.pos[2]);
      targetAlt = playerAlt > 6 ? Math.max(0, playerAlt - 1.5) : 0;
    } else if (e.mode === 'graze' || (e.sit ?? 0) > 0.3) {
      targetAlt = 0;       // feeding or resting animals are on the ground
    } else if (wantsAirborne(e)) {
      // The AI has committed this flier to crossing open ground — hunting
      // something at a distance, or leaving. It set the flag; this owns the
      // altitude. Neither side has to know how the other works, and
      // `wantsAirborne` is never true for an owned animal, which is what keeps
      // a tamed mount reachable.
      targetAlt = st.cruise;
    } else {
      targetAlt = st.cruise;
    }

    const dAlt = targetAlt - st.alt;
    const step = WILD_CLIMB_SPEED * dtS;
    st.alt += Math.abs(dAlt) <= step ? dAlt : Math.sign(dAlt) * step;
    if (st.alt < 0) st.alt = 0;
    e.y = groundY + st.alt;

    // --- breath ----------------------------------------------------------
    const spec = BREATH_SPEC[e.species as Species];
    if (spec === undefined || e.mode !== 'aggro' || !vitals.alive) return;
    const range = BREATH_RANGE * spec.reach;
    if (simTime >= st.nextBreath && playerDist < range * 0.8 && playerDist > 3) {
      st.breathUntil = simTime + WILD_BREATH_S;
      st.nextBreath = simTime + WILD_BREATH_COOLDOWN_S + WILD_BREATH_S;
      audio.play('dragon_roar', { dist: playerDist });
    }
    if (simTime < st.breathUntil) {
      const s = def.size;
      const fx = Math.sin(e.yaw), fz = -Math.cos(e.yaw);
      const mouth: [number, number, number] = [
        e.x + fx * s * spec.mouth[0],
        e.y + s * spec.mouth[1],
        e.z + fz * s * spec.mouth[0],
      ];
      // Aim at the player's chest rather than straight ahead, so a flier
      // overhead actually hits instead of breathing over their head.
      const tx = controller.pos[0] - mouth[0];
      const ty = (controller.pos[1] + PLAYER_HEIGHT * 0.5) - mouth[1];
      const tz = controller.pos[2] - mouth[2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      const dir: [number, number, number] = [tx / tl, ty / tl, tz / tl];
      wildBreaths.push({
        mouth, dir, jaw: 1, reach: spec.reach, spark: spec.spark,
      });
      entityRenderer.jawOverride = { id: e.id, jawOpen: 1 };
      // Damage on the same cadence the mounted breath uses.
      breathTickAccum += dtS;
      if (breathTickAccum >= BREATH_TICK_S) {
        breathTickAccum = 0;
        if (inBreathCone(mouth, dir,
          controller.pos[0], controller.pos[1] + PLAYER_HEIGHT * 0.5,
          controller.pos[2], spec.reach)) {
          // The MOUTH, not the body. A dragon is 4 m long and its head can be
          // well off the axis its centre sits on; the cone test asks "where did
          // this come from", and for a jet of fire that is the muzzle.
          applyAttackOnPlayer(
            Math.max(1, Math.round(BREATH_DMG_NPC * spec.dmg)),
            'animal', 'ranged', def.size, e.y,
            { x: mouth[0], z: mouth[2], kind: 'breath', id: e.id, entity: e });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // The last fight: the Evil King and his black dragon.
  //
  // Shape, phases and tuning live in `castle/castle-fight.ts`, which is pure.
  // Everything here is the wiring that pure module cannot do: writing the
  // entity, emitting the jet, landing the damage, and seating or unseating the
  // rider.
  // -------------------------------------------------------------------------

  /**
   * Damage one breath tick does to the player.
   *
   * NOT `BREATH_DMG_NPC * spec.dmg`, which is what `tickWildFlier` uses and
   * which would be 4 * 1.6 = 6 per tick — at `BREATH_TICK_S` = 0.25 s that is
   * 24 hp/s against a 20 hp player, i.e. death in under a second with no
   * counterplay whatsoever. 2 per tick is 8 hp/s: standing in a full 1.6 s jet
   * costs about 13 of 20, which is survivable exactly once and teaches the
   * lesson the tell exists to teach.
   */
  const BOSS_BREATH_DMG = 2;
  /** The boss's own tick accumulator. */
  let bossBreathAccum = 0;
  /** True while the fight owns the dragon's pose; false once it is grounded. */
  let bossHoldsTheDragon = true;
  /** Last cone test against the player, for `castleFight()`. */
  let bossBreathLast: import('./breath-cone').BreathHit | null = null;
  /** How many breath ticks have actually landed on the player. */
  let bossBreathHits = 0;
  /** Last phase announced, so the notice fires once per phase. */
  let bossPhaseShown: string | null = null;

  /**
   * Drive the king's dragon, and the King on its back.
   *
   * Replaces the old on-rails block. While the castle is not hunting this is
   * exactly what it was — the patrol circuit, written straight to the entity,
   * because `stepAnimal` + `tickWildFlier` cannot express it (`moveToward`
   * ends every tick with `e.y = heightAt(x, z)`, which pins a circling dragon
   * to the hillside).
   *
   * Once hunting, `stepCastleFight` owns the pose until it says `handOff`, at
   * which point the dragon is on the ground and becomes an ordinary hostile
   * creature — the same `stepAnimal` path a wolf takes, with its own bite, its
   * own morale exemption and its own death.
   */
  /**
   * The body-integration inputs for `stepCastleFight`.
   *
   * `cur*` is the animal's live position, used ONCE to seed the body. It has
   * to be the animal's and not the goal's: seeding from the orbit point puts
   * the dragon on station on frame one, which is the teleport the body exists
   * to remove. The keep centre is the leash anchor and the circuit it flies
   * home to, and matches the `ky` that `castleManager.flightPose` patrols at
   * so breaking off rejoins the same circle the dormant patrol uses.
   */
  function bossMotion(
    e: import('./entities/entity-manager').EntityState, dtS: number,
  ): import('./castle/castle-fight').BossMotion {
    return {
      dtS,
      curX: e.x, curY: e.y, curZ: e.z,
      keepX: castleManager.site.origin[0],
      keepY: castleManager.site.origin[1] + ARENA_Y,
      keepZ: castleManager.site.origin[2],
    };
  }

  function tickCastleBoss(dtS: number): boolean {
    const e = kingDragonId === null
      ? undefined : entityManager.entities.get(kingDragonId);
    if (e === undefined) return false;
    const playerDist = Math.hypot(
      e.x - controller.pos[0], e.y - controller.pos[1], e.z - controller.pos[2]);
    const king = evilKingId === null
      ? undefined : entityManager.entities.get(evilKingId);
    const dragonAlive = e.mode !== 'dead';

    // Wings out. Without this the dragon circles with them FOLDED: the
    // animator infers flight from vertical velocity, and a steady circuit at
    // constant altitude produces none, so it reads as a walking animal.
    if (dragonAlive) entityRenderer.flightOverride = { id: e.id, state: 'flap' };

    if (!dragonAlive) {
      // Still step the machine, with `dragonAlive` false, so it can reach
      // 'dismounted' — which is what tells `kingIsMounted` to let go of the
      // King. Returning early here left the phase stuck on 'grounded' forever
      // and the rider glued to his own corpse.
      entityRenderer.flightOverride = null;
      stepCastleFight(
        castleManager.fight, simTime, castleManager.state.alarm,
        controller.pos[0], controller.pos[1], controller.pos[2],
        playerDist, 0, false, creatureGroundY(e, e.x, e.z, e.y),
        bossMotion(e, dtS));
      return false;
    }

    if (!castleManager.hostile) {
      const pose = castleManager.flightPose(simTime, controller.pos);
      e.x = pose.x; e.y = pose.y; e.z = pose.z; e.yaw = pose.yaw;
      e.mode = 'idle';
      e.walkPhase += DRAGON_AIRBORNE_FLAP_RATE * dtS;
      seatTheKing(e, king);
      return true;
    }

    const maxHp = SPECIES_DEFS.black_dragon.hp;
    const cmd = stepCastleFight(
      castleManager.fight, simTime, castleManager.state.alarm,
      controller.pos[0], controller.pos[1], controller.pos[2],
      playerDist, e.hp / maxHp, dragonAlive,
      creatureGroundY(e, e.x, e.z, e.y),
      bossMotion(e, dtS));

    if (cmd.entered && cmd.phase !== bossPhaseShown) {
      bossPhaseShown = cmd.phase;
      audio.play('dragon_roar', { dist: playerDist });
      if (cmd.phase === 'strafe') setGatherNotice('The dragon comes lower.');
      else if (cmd.phase === 'grounded') setGatherNotice('It lands. Kill it now.');
    }

    if (!cmd.handOff) {
      e.x = cmd.x; e.y = cmd.y; e.z = cmd.z; e.yaw = cmd.yaw;
      e.mode = 'aggro';
      e.walkPhase += DRAGON_AIRBORNE_FLAP_RATE * dtS;
    } else {
      // Grounded: hand the animal to the ordinary AI. `flightOverride` has to
      // go with it or the clip system keeps it in a flap cycle while it walks.
      entityRenderer.flightOverride = null;
    }

    tickBossBreath(e, cmd.breath, cmd.aim, dtS, playerDist);
    // `handOff` means he is no longer a passenger — which `seatTheKing`'s own
    // docstring says and the code did not do. Calling it unconditionally kept
    // copying the dragon's `walkPhase` onto him after he had dismounted, so
    // his legs ran on the dragon's clock: measured 45.6/50.9/56.2 against the
    // dragon's 45.5/50.8/56.1 while he walked 12 m on foot. That is the
    // sliding gait the user reported.
    if (!cmd.handOff) seatTheKing(e, king);
    return !cmd.handOff;
  }

  /**
   * Put the King in the saddle, or leave him where he is once his mount is
   * down.
   *
   * `handOff` and death both mean "he is no longer a passenger": from then on
   * he is an ordinary melee enemy with 2.4 m of reachBonus, and pinning him to
   * a grounded or dead dragon would either drag him along behind it or leave
   * him standing on a corpse.
   */
  function seatTheKing(
    dragon: import('./entities/entity-manager').EntityState,
    king: import('./entities/entity-manager').EntityState | undefined,
  ): void {
    if (king === undefined || king.mode === 'dead') return;
    const seat = blackDragonLandmarks().saddle;
    const rp = kingRiderPlacement(
      dragon.x, dragon.y, dragon.z, dragon.yaw, seat[1], seat[2]);
    king.x = rp.x; king.y = rp.y; king.z = rp.z; king.yaw = rp.yaw;
    king.mode = dragon.mode === 'dead' ? king.mode : dragon.mode;
    king.walkPhase = dragon.walkPhase;
  }

  /** True while the King is still a passenger — drives his seated pose. */
  function kingIsMounted(): boolean {
    if (kingDragonId === null) return false;
    const d = entityManager.entities.get(kingDragonId);
    if (d === undefined || d.mode === 'dead') return false;
    return castleManager.fight.phase === 'circle'
      || castleManager.fight.phase === 'strafe'
      || !castleManager.hostile;
  }

  /**
   * The dragon's breath: the jet, the jaw, and the only thing here that can
   * take the player's health.
   *
   * Modelled on `tickWildFlier`'s breath block, with three deliberate
   * differences:
   *
   *   - the aim is the LATCHED point from the fight state machine, not the
   *     live player position. That is the entire mechanic — a cone that tracks
   *     you has nothing to dodge.
   *   - it has its own accumulator. `breathTickAccum` is shared between the
   *     mounted breath and the wild-flier breath already, and a third writer
   *     would let a wyvern overhead reset the boss's damage tick — which is
   *     the exact failure mode that once made a breath deal zero damage for
   *     its entire steady state while looking perfectly active.
   *   - `mouth` comes from `BREATH_SPEC.black_dragon`, which is read off the
   *     real mesh. Inheriting another species' numbers once put a wyvern's
   *     sparks around its RIDER's head.
   */
  function tickBossBreath(
    e: import('./entities/entity-manager').EntityState,
    stage: 'none' | 'tell' | 'burning',
    aim: [number, number, number],
    dtS: number, playerDist: number,
  ): void {
    const spec = BREATH_SPEC.black_dragon;
    if (spec === undefined || stage === 'none') { bossBreathAccum = 0; return; }
    const def = SPECIES_DEFS.black_dragon;
    const s = def.size;
    const fx = Math.sin(e.yaw);
    const fz = -Math.cos(e.yaw);
    const mouth: [number, number, number] = [
      e.x + fx * s * spec.mouth[0],
      e.y + s * spec.mouth[1],
      e.z + fz * s * spec.mouth[0],
    ];

    if (stage === 'tell') {
      // The wind-up: jaw cracking, no fire, no damage. Visible from the ground
      // and from 40 m up, which is the point.
      entityRenderer.jawOverride = { id: e.id, jawOpen: 0.35 };
      bossBreathAccum = 0;
      return;
    }

    const tx = aim[0] - mouth[0];
    const ty = (aim[1] + PLAYER_HEIGHT * 0.5) - mouth[1];
    const tz = aim[2] - mouth[2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    const dir: [number, number, number] = [tx / tl, ty / tl, tz / tl];
    wildBreaths.push({ mouth, dir, jaw: 1, reach: spec.reach, spark: spec.spark });
    entityRenderer.jawOverride = { id: e.id, jawOpen: 1 };

    // Keep the last cone test where a harness can read it. "The breath looks
    // active and deals zero damage" is this repo's signature failure and it has
    // now happened twice on this weapon; a number beats a theory.
    bossBreathLast = breathHit(mouth, dir, controller.pos[0],
      controller.pos[1] + PLAYER_HEIGHT * 0.5, controller.pos[2], spec.reach);

    bossBreathAccum += dtS;
    if (bossBreathAccum < BREATH_TICK_S) return;
    bossBreathAccum = 0;
    if (!vitals.alive) return;
    if (bossBreathLast.hit) {
      bossBreathHits++;
      // `boss: true` costs nothing here — breath is never parryable, so the
      // shorter boss stagger can never be reached down this path — but it is
      // set anyway, because a source struct that lies about what it is is a
      // struct that will be copied to somewhere the lie matters.
      applyAttackOnPlayer(BOSS_BREATH_DMG, 'animal', 'ranged', def.size, e.y,
        { x: mouth[0], z: mouth[2], kind: 'breath', id: e.id, entity: e, boss: true });
    }
    void playerDist;
  }

  /** Vertical ascent/descent speed (m/s) for dragon flight. */
  const DRAGON_FLIGHT_SPEED = 6;
  /** Minimum epsilon above terrain when on the ground (m). */
  const DRAGON_GROUND_EPSILON = 0.05;
  /**
   * Height above the raw heightfield at which a flier switches from the
   * walking collision path to the Y-aware flier one (m).
   *
   * Low on purpose. It is not "high enough to clear buildings" — that question
   * is now answered per box by the flier query — it only separates "standing
   * on something" from "in the air". Keeping the ground path for the first
   * half-metre preserves the ejecting slide, which is what unsticks a mount
   * that spawned inside a haystack; in the air there is nowhere to eject to.
   */
  const FLIER_AIRBORNE_Y = 0.5;
  /**
   * Slop on "is this roof at or below me" for the flier's landing query (m).
   * Deliberately tiny — see the clamp in tickMount for why a generous value
   * would be a levitation bug rather than a safety margin.
   */
  const ROOF_CATCH_EPS = 0.1;
  /** Idle wing-flap walkPhase advance rate while airborne but not moving horizontally (rad/s). */
  const DRAGON_AIRBORNE_FLAP_RATE = 3.0;
  /** Flight stamina drain rate per second while airborne (non-sprinting). */
  const DRAGON_FLIGHT_DRAIN_PER_S = 2;

  // -------------------------------------------------------------------------
  // Mount attack (hold F): dragon fire breath / ground-mount stomp.
  // Fire is aimed with the mouse — the cone follows the camera look direction.
  // -------------------------------------------------------------------------
  /** Stamina drain per second while breathing fire. */
  const BREATH_STAMINA_DRAIN_PER_S = 8;
  /** Breath cuts out below this stamina (prevents zero-cost spam). */
  const BREATH_MIN_STAMINA = 5;
  /**
   * Once the breath has guttered out it stays out until stamina climbs back to
   * here. Without this hysteresis the mechanic broke down completely after a
   * few seconds of holding F:
   *
   * mount stamina regenerates at 15/s but only while `!breathActive`, and the
   * breath drains 8/s — so at the 5-point floor the state flipped every frame
   * (below → regen → above → drain → below). The flame flickered on and off,
   * which is the visible "glitching", and because the `else` branch resets
   * `breathTickAccum`, the 0.25 s damage tick could never finish accumulating.
   * The breath looked like it was firing and did **zero** damage, indefinitely.
   *
   * Set well above the drain-per-second so the recovery is a real pause the
   * player can read, not a stutter.
   */
  const BREATH_RECOVER_STAMINA = 30;
  /** Damage applied per breath tick to animals / NPCs in the cone. */
  const BREATH_DMG_ENTITY = 3;
  const BREATH_DMG_NPC = 4;

  /**
   * Per-species mounted breath weapon.
   *
   * A wyvern is the common flier, not the apex one, and its breath should say
   * so before the damage numbers do: a short spray of sparks and embers rather
   * than the dragon's sustained jet. `reach` and `dmg` scale the shared cone,
   * and `spark` switches the VFX to hot fragments that scatter and die instead
   * of a coherent flame. Only the dragon sets vegetation alight.
   */
  const BREATH_SPEC: Partial<Record<Species, {
    reach: number; dmg: number; spark: boolean;
    /**
     * What the breath can set alight.
     *   'all'    — trees and brush; a dragon starts forest fires.
     *   'tinder' — brush only. Sparks landing in dry scrub catch; a standing
     *              tree does not go up from a shower of embers.
     *   'none'   — damage only.
     */
    ignites: 'all' | 'tinder' | 'none';
    /**
     * Where the breath leaves the head, as multiples of the species' `size`:
     * `[forward, up]` from the entity origin.
     *
     * Per species, because these are read off the actual mesh. They were
     * hardcoded to the dragon's 1.27/1.61, which on a wyvern put the origin a
     * full metre above its skull — the sparks appeared to burst around the
     * RIDER's head rather than come out of the animal's mouth. The wyvern's
     * snout tip is at 1.16 forward / 1.18 up (wyvern-mesh.ts: `snoutTip`,
     * `crY = headY + 0.008s`, `headY = 1.22s`).
     */
    mouth: [number, number];
  }>> = {
    dragon: { reach: 1.00, dmg: 1.00, spark: false, ignites: 'all',
              mouth: [1.27, 1.61] },
    wyvern: { reach: 0.42, dmg: 0.55, spark: true,  ignites: 'tinder',
              mouth: [1.16, 1.18] },
    // The boss. Reach and damage are above the wild dragon's because this is
    // the fight the game builds to, not a roaming encounter. `mouth` is read
    // off the actual mesh and asserted in test-boss-mesh.mts — the wyvern
    // above is the cautionary tale for guessing it, where inheriting the
    // dragon's numbers put the origin a metre over its skull so the sparks
    // burst around the RIDER's head instead of leaving the animal's mouth.
    black_dragon: { reach: 1.40, dmg: 1.60, spark: false, ignites: 'all',
                    mouth: [1.27, 1.61] },
  };

  /** Bite: both fliers have jaws, and a bite is the close-range answer when
   *  the breath is on cooldown or the target is already on top of you. */
  const BITE_DMG = 6;
  const BITE_RANGE = 4.0;
  const BITE_COOLDOWN_S = 0.9;
  const BITE_STAMINA = 4;
  let biteCooldown = 0;

  /**
   * The ridden mount fights back on its own.
   *
   * `animal-ai.ts` has a `defend` mode for owned animals, but it deliberately
   * excludes the mount the player is RIDING — a defender breaks off and
   * charges its target, and a mount doing that under you would fight the
   * reins. The line skipping it is in the AI loop.
   *
   * So a ridden mount retaliates instead of intercepting: it never moves, and
   * it never picks a fight. It only answers something that is already coming
   * for its rider and already close enough to reach. The player keeps the
   * steering; the animal keeps its teeth.
   */
  const RETALIATE_COOLDOWN_S = 1.5;
  /** Reach beyond the mount's own size. */
  const RETALIATE_REACH = 2.6;
  let retaliateCooldown = 0;
  /** Seconds between breath damage ticks. */
  const BREATH_TICK_S = 0.25;
  /** Non-dragon mount stomp attack (F): damage, reach, cost, cooldown. */
  const STOMP_DMG = 4;
  const STOMP_RANGE = 3.2;
  const STOMP_STAMINA = 5;
  const STOMP_COOLDOWN_S = 0.8;
  /** True while fire breath is being emitted this frame. */
  let breathActive = false;
  let prevBreathActive = false; // Feature 10: track breath start for dragon_roar SFX
  /** Breath has run dry and is locked out until BREATH_RECOVER_STAMINA. */
  let breathExhausted = false;
  /** Jaw-open blend 0..1 (eases in/out; drives the dragon mesh + VFX gate). */
  let breathJaw = 0;
  /** Accumulator for the periodic breath damage tick. */
  let breathTickAccum = 0;
  /** Remaining cooldown before the next stomp (seconds). */
  let stompCooldown = 0;

  /**
   * How close to the player a hostile must be before the player's owned
   * animals break off and intercept it.
   *
   * Kept comfortably inside animal-ai's DEFEND_GIVEUP_DIST so a defender never
   * accepts a target it will immediately abandon, and short enough that pets
   * guard their owner rather than roaming the map looking for a fight.
   */
  const DEFEND_CALL_RADIUS = Math.min(28, DEFEND_GIVEUP_DIST);

  /**
   * Saddle offset: player sits at entity's shoulder height.
   * Saddle y = entity.y + SPECIES_DEFS[species].size.
   */
  function saddleY(species: Species, entityY: number): number {
    return entityY + SPECIES_DEFS[species].size;
  }

  // -------------------------------------------------------------------------
  // Attack routing — who takes a hit aimed at the player (see attack-routing.ts)
  // -------------------------------------------------------------------------

  /** Snapshot the player's mounted state for the routing rules. */
  function riderState(): RiderState {
    const e = mountedEntityId !== null
      ? entityManager.entities.get(mountedEntityId) : undefined;
    if (e === undefined) return { mountId: null, mountBaseY: 0, mountSize: 0 };
    return {
      mountId: e.id,
      mountBaseY: e.y,
      mountSize: SPECIES_DEFS[e.species].size,
    };
  }

  /**
   * Put damage into the mount the player is riding. This is where a bear's
   * swipe at a mounted rider actually lands.
   *
   * A mount killed under its rider dismounts them — tickMount already
   * auto-dismounts on a dead mount, and a rider dropped from altitude takes
   * the fall like anyone else. That consequence is the point: mounts are no
   * longer free protection.
   */
  function damageMount(dmg: number): void {
    if (mountedEntityId === null) return;
    const e = entityManager.entities.get(mountedEntityId);
    if (e === undefined || e.mode === 'dead') return;
    e.hp = Math.max(0, e.hp - dmg);
    triggerDamageFlash();
    audio.play('hit');
    if (e.hp <= 0) {
      e.mode = 'dead';
      if (e.deadAtS === undefined) e.deadAtS = simTime;
      entityManager.killEntity(e.id);
      setGatherNotice(`Your ${SPECIES_DEFS[e.species].name} was killed under you!`);
    } else {
      setGatherNotice(`Your ${SPECIES_DEFS[e.species].name} takes the blow (${Math.round(e.hp)} hp)`);
    }
  }

  /**
   * Who is hitting you, and with what. Everything the shield needs and the
   * damage number cannot say.
   *
   * This exists because `applyAttackOnPlayer` used to take a damage figure, a
   * cause, a reach and the attacker's SIZE and HEIGHT — and nothing about where
   * the attacker was standing. Five of its six call sites had the position in
   * scope and threw it away at the boundary; the sixth (the dungeon) had lost
   * it three layers earlier. A frontal-cone block is unimplementable from that,
   * which is why widening this signature was the first thing the shield needed.
   */
  interface AttackSource {
    /** Attacker world X/Z. The cone test's entire input. */
    x: number;
    z: number;
    /** Which shield rule applies — only `melee` may be parried. */
    kind: IncomingKind;
    /** Entity id, when the attacker holds a token that a parry should free. */
    id?: string;
    /**
     * The attacker itself, when the caller has it.
     *
     * Passed rather than looked up by id because the dungeon's enemies do not
     * live in `entityManager` at all — they are owned by the resident dungeon —
     * so an id-only contract would have made underground parries silently
     * stagger nothing. Every caller that can stagger already has the object.
     */
    entity?: import('./entities/entity-manager').EntityState;
    /** True for the two boss species: half the parry stagger. */
    boss?: boolean;
    /** Pool holding the attacker's turn, so a parry can hand it straight back. */
    tokens?: MeleeTokenPool | null;
  }

  /**
   * Run an incoming blow through the guard and return the damage that survives.
   *
   * THE SINGLE SHIELD DECISION. Both damage paths call it — the melee/breath
   * one below and `resolveEnemyProjectileHit`, which does its own routing and
   * its own `damagePlayer` and would otherwise have been free to disagree with
   * this one about what a shield stops. Two paths that must agree and are not
   * forced to is how "arrows are blockable" ends up true in one of them.
   *
   * Applies every consequence EXCEPT the damage: stamina, the SFX, the spark,
   * the attacker's stagger, and handing its token back. The caller keeps the
   * damage because the two paths route it differently (mount vs player).
   */
  function guardIncoming(dmg: number, src: AttackSource): number {
    // A corpse does not block, and neither does a free-fly camera. Returned
    // before `resolveBlock` rather than folded into it so `lastBlock` keeps
    // meaning "why the guard decided what it decided" instead of picking up a
    // reason that is really about being dead.
    if (!vitals.alive || flyMode) return dmg;
    const out = resolveBlock({
      tier: shieldTier(),
      guard,
      nowS: simTime,
      stamina: vitals.stamina,
      // `controller.yaw` is the MESH facing convention, which is what
      // `blockBearing` expects. Feeding it `orbitCam.yaw` would have inverted
      // the cone — blocks would have worked only with your back to the enemy —
      // and nothing would have type-checked differently. See lock-on.ts's
      // header for why this codebase has two yaw conventions at all.
      facingYaw: controller.yaw,
      px: controller.pos[0],
      pz: controller.pos[2],
    }, { kind: src.kind, x: src.x, z: src.z, boss: src.boss === true });
    lastBlock = out;

    if (out.kind === 'through') {
      if (out.reason === 'flank') guardStats.flanked++;
      else if (out.reason === 'guard-break') guardStats.brokeGuard++;
      return dmg;
    }

    // One-shot drain: rate `cost` over 1 s, matching the swing's own
    // `drainStamina(vitals, 3, 1)`. It also stamps `sinceDrainS = 0`, so a
    // player under sustained attack never regenerates between blows — which is
    // what makes the per-tier stamina figure mean anything.
    if (out.staminaCost > 0) drainStamina(vitals, out.staminaCost, 1);

    const sfx = blockSfx(out);
    if (sfx !== null) audio.play(sfx);

    if (out.kind === 'parry') {
      guardStats.parried++;
      parrySparkAtS = simTime;
      const ent = src.entity ?? (src.id === undefined
        ? undefined : entityManager.entities.get(src.id));
      if (ent !== undefined) staggerAnimal(ent, out.staggerS);
      // Hand the turn back so the pack keeps rotating. A staggered enemy stops
      // asking and would fall out on `INTENT_TTL_S` anyway; saying it outright
      // is 0.35 s of the pack not standing around.
      if (src.id !== undefined) src.tokens?.releaseToken(src.id);
    } else {
      guardStats.blocked++;
    }
    return dmg * out.damageMul;
  }

  /**
   * Apply an attack aimed at the player through the routing rules.
   * Returns true when the player themself was hit.
   *
   * The guard runs AFTER the routing, not before, and that ordering is the
   * whole rule: `routePlayerDamage` can send a melee swing to the MOUNT you are
   * sitting on, and a shield on your arm does not cover a horse. Blocking first
   * would have made the shield protect the animal.
   */
  function applyAttackOnPlayer(
    dmg: number,
    cause: import('./vitals').DamageCause,
    reach: 'melee' | 'ranged',
    attackerSize: number,
    attackerY: number,
    src: AttackSource,
  ): boolean {
    const routing = routePlayerDamage(reach, { size: attackerSize, y: attackerY }, riderState());
    if (routing.target === 'player') {
      const landed = guardIncoming(dmg, src);
      // A fully-stopped blow is not a hit: no flash, no hurt cry, no vitals
      // write. `false` here also keeps it out of the "player was hit" bookkeeping
      // every caller does with the return value.
      if (landed <= 0) return false;
      damagePlayer(vitals, landed, cause, totalDefense(inventory));
      triggerDamageFlash();
      audio.play('hurt');
      saveVitals(vitals);
      return true;
    }
    if (routing.target === 'mount') damageMount(dmg);
    return false;
  }

  /** Dismount the player from the currently-mounted entity. */
  function doDisMount(): void {
    if (mountedEntityId === null) return;
    const e = entityManager.entities.get(mountedEntityId);
    if (e) {
      // Step off onto ground the player can actually stand on.
      //
      // This used to be `pos[0] = e.x + size + 0.5; pos[2] = e.z` — always due
      // EAST, with no collision query of any kind. Dismounting with a wall to
      // your east put you inside it, and that went from a curiosity to a real
      // problem the day the castle landed: the courtyards are ringed by a 9 m
      // curtain wall, the halls are 3 m from a pier in every direction, and the
      // tower arena is a 17 m disc with a parapet round the rim. Stepping off a
      // wyvern up there posted the player straight through the merlons.
      //
      // So: try eight sides in a fixed order, take the first that the world
      // says is free, and fall back to the mount's own position — standing
      // inside the animal you were just riding is survivable and never
      // geometry, whereas being inside a wall is neither.
      const offset = SPECIES_DEFS[e.species].size + 0.5;
      const feet = saddleY(e.species, e.y);
      const R = 0.35;                       // controller RADIUS

      // DROP THE PROBE TO THE MOUNT'S FEET BEFORE ASKING THE WORLD ANYTHING.
      //
      // `CastleCollider` is a Y-aware `GroundQuery`: a keep with four storeys
      // cannot answer "what is the floor at (x, z)" without knowing which
      // storey is being asked about, so it reads the player's live height out
      // of `probeY()` (castle-manager.ts binds it to `controller.pos[1]`).
      // Every query below therefore inherits whatever `pos[1]` happens to be
      // — and while mounted that is SADDLE height, which is the one height the
      // player is about to stop being at.
      //
      // Both queries were wrong because of it:
      //
      //   - `moveXZ` tested a body span of `saddle+0.6 .. saddle+1.7`. On a
      //     dragon that is 4.1-5.2 m above the floor, well over the arena's
      //     parapet and the courtyard merlons, so those sides read as FREE and
      //     the dismount happily stepped the rider over the wall.
      //   - `groundHeight` then resolved the storey around saddle height, and
      //     off the edge there is no castle surface at all, so it fell through
      //     to terrain ~40 m below. `feet - landing` blew past STEP_DOWN_MAX,
      //     the code kept saddle height as a "this is a real fall" case, and
      //     the player was left hanging in the air outside the tower.
      //
      // The rider is about to be standing where the ANIMAL is standing, so
      // that is the height the world must be asked about.
      controller.pos[1] = e.y;

      // The surface under the mount itself — the floor the rider is entitled
      // to end up on, and the reference every candidate side is judged
      // against below. `creatureGroundY` is the no-rescue creature query, so
      // "no castle here" comes back as terrain rather than as a 28 m snap.
      const mountGround = creatureGroundY(e, e.x, e.z, e.y);

      let ox = 0;
      let oz = 0;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const cx = Math.cos(a) * offset;
        const cz = Math.sin(a) * offset;
        const [mx, mz] = controller.world.moveXZ(e.x, e.z, cx, cz, R);
        // `moveXZ` slides rather than refusing, so "free" means it got most of
        // the way there rather than merely that it returned.
        if (Math.hypot(mx - e.x, mz - e.z) > offset * 0.8) { ox = mx - e.x; oz = mz - e.z; break; }
      }
      controller.pos[0] = e.x + ox;
      controller.pos[2] = e.z + oz;

      // Step DOWN onto the ground when there is ground to step onto; only keep
      // the saddle height when stepping off really is a fall.
      //
      // This was an unconditional `pos[1] = saddleY(...)`, which is right in
      // the air and wrong on the ground: stepping off a wyvern standing in a
      // field left the player 2.4 m up and falling, every single time. A probe
      // measured five dismount cycles in a row ending airborne at velY ~ -11.
      //
      // The test is the DROP from the saddle to the ground under the player's
      // feet, not whether the animal is technically airborne. An owned flier
      // bobs — `tickWildFlier` gives it an altitude target that tracks the
      // player's — so "is `e.y` above its own ground" flickers, and a probe
      // caught one dismount in five taking the airborne branch while the mount
      // hovered 0.6 m up. A rider stepping down two metres onto solid ground
      // should simply be standing on it; one bailing out at 25 m should fall,
      // and still does.
      /** How far below the mount's own footing a dismount may legitimately be. */
      const STEP_DOWN_MAX = 3.0;
      /**
       * How high the ANIMAL must be over its own ground before stepping off
       * counts as bailing out rather than climbing down.
       *
       * This replaces a test on `feet - landing`, the drop from the SADDLE,
       * which had a floor-through of its own hiding in it: a dragon's saddle is
       * `size` = 3.5 m above its feet, so `feet - landing` was 3.5 even with
       * the animal stood flat on level ground, that exceeded STEP_DOWN_MAX, and
       * every single dismount from a dragon left the rider at saddle height and
       * dropped them. On the keep it dropped them through the storey.
       *
       * Asking how high the ANIMAL is instead cannot be fooled by how tall it
       * is. 2.5 m is well clear of the bob on an owned flier — its altitude
       * target tracks the player and a probe once caught a dismount taking the
       * airborne branch while the animal hovered 0.6 m off the grass — and well
       * under any drop worth calling a fall.
       */
      const AIRBORNE_MIN = 2.5;
      const mountAir = e.y - mountGround;
      let landing = controller.world.groundHeight(
        controller.pos[0], controller.pos[2], R);

      // A candidate side can still be over a stairwell opening, a hatch, or
      // the lip of a floor — places where the honest ground answer really is
      // the storey below. Stepping off a horse must never post the rider over
      // a hole, so if the side we picked lands materially below the surface
      // the ANIMAL is standing on, it is the SIDE that is wrong, not the
      // height: retreat into the mount's own column, which is by definition
      // supported because something is standing in it.
      //
      // Comparing two ground samples rather than asking "is the mount
      // airborne?" is deliberate. That question flickers — an owned flier bobs
      // on an altitude target that tracks the player, and a probe once caught
      // one dismount in five taking the airborne branch while the animal
      // hovered 0.6 m off the grass.
      if (landing < mountGround - STEP_DOWN_MAX) {
        controller.pos[0] = e.x;
        controller.pos[2] = e.z;
        landing = mountGround;
      }
      // Stand on it unless the animal itself was in the air. A rider getting
      // off something that is standing on a floor ends up standing on that
      // floor, every time and whatever the animal's height; one bailing out at
      // 25 m falls, and still does.
      controller.pos[1] = mountAir > AIRBORNE_MIN ? feet : landing;
      controller.velY = 0;

      // When dismounting a flier, flag it for ground-return so `tickEntities`
      // eases it down instead of leaving it hovering.
      //
      // The gate was `dragonFlightY > 0`, and `dragonFlightY` is only written
      // by `tickMount`'s flight branch — so a flier the player mounted while
      // it was ALREADY airborne and never gave a climb input to was dismounted
      // with the flag unset, and stayed at altitude forever. Forever is not an
      // exaggeration: nothing else lowers it, and an unreachable flier cannot
      // be re-mounted, so the player's tamed animal is simply gone.
      //
      // Asking the entity's own altitude instead cannot miss that case, and it
      // is also the right question on the castle, where `dragonFlightY` reads
      // ~25 m for an animal standing flat on the courtyard.
      const canFly = SPECIES_DEFS[e.species].canFly === true;
      if (canFly && DRAGON_FLIGHT_ENABLED) {
        const landAt = creatureGroundY(e, e.x, e.z, e.y);
        if (e.y > landAt + DRAGON_GROUND_EPSILON * 2) {
          (e as import('./entities/entity-manager').EntityState & { _landingY?: number })
            ._landingY = landAt;
        }
      }
    }
    mountedEntityId = null;
    acceptedRideTimer = -1;
    mountSprintExhausted = false;
    dragonFlightY = 0;
  }

  /** Attempt to mount the nearest live mountable entity within 3 m. */
  function tryMount(): boolean {
    const px = controller.pos[0];
    const pz = controller.pos[2];
    const MOUNT_REACH = 3.0;
    /**
     * How far above or below the player the animal's FEET may be.
     *
     * There was no vertical test at all: the reach was `hypot(e.x - px,
     * e.z - pz)`, pure XZ, so a wyvern circling 25 m overhead was mountable
     * from the ground and the player was snapped up to it. A probe caught
     * exactly that across a 25 m gap. It went from odd to routine the day the
     * opening started the player 25 m up inside the keep, with the courtyard —
     * and anything standing on it — directly below.
     *
     * Feet to feet, NOT player-to-saddle. The saddle version was the first fix
     * and it needed `+ def.size` to stop a wyvern standing right beside you
     * reading as 2.4 m out of reach — which double-counts the animal's height
     * and made the real allowance 4.4 m for a wyvern and 5.5 m for a dragon.
     * A probe then mounted one 7.2 m below and it was, technically, working as
     * written. "Are we standing on the same ground" has nothing to do with how
     * tall the animal is, so it should not appear in the test.
     *
     * 2.5 m covers a mount on a slope, a low ledge or a step; it does not
     * cover a storey, a motte or anything airborne.
     */
    const MOUNT_REACH_Y = 2.5;
    const py = controller.pos[1];
    let best: import('./entities/entity-manager').EntityState | null = null;
    let bestDist = MOUNT_REACH;
    for (const e of entityManager.entities.values()) {
      if (e.mode === 'dead') continue;
      const def = SPECIES_DEFS[e.species];
      if (!def.mountable) continue;
      if (Math.abs(e.y - py) > MOUNT_REACH_Y) continue;
      const dist = Math.hypot(e.x - px, e.z - pz);
      if (dist < bestDist) {
        bestDist = dist;
        best = e;
      }
    }
    if (best === null) return false;

    const species = best.species;
    const entityId = best.id;

    // Stable horses (npcOwned) must be bought before riding: first E offers
    // the purchase, second E within the window completes it via gold_small.
    if (best.npcOwned) {
      const nowMs = performance.now();
      if (pendingHorseBuy !== null && pendingHorseBuy.id === entityId &&
          nowMs < pendingHorseBuy.until) {
        pendingHorseBuy = null;
        const gold = countItem(inventory, 'gold_small');
        if (gold < STABLE_HORSE_PRICE) {
          setGatherNotice(`Not enough gold — the horse costs ` +
            `${STABLE_HORSE_PRICE} gold (you have ${gold}).`);
          return true;
        }
        removeItem(inventory, 'gold_small', STABLE_HORSE_PRICE);
        invChanged();
        best.npcOwned = false;
        best.owned = true;
        // Record the purchase through the taming registry so the horse stays
        // player-owned across reloads (ensureStableHorses reads this back).
        tamingRegistry.tamed[entityId] = { temper: 100, tamed: true };
        saveTamingRegistry(tamingRegistry);
        setGatherNotice(
          `Horse purchased for ${STABLE_HORSE_PRICE} gold! (E to ride)`);
        return true;
      }
      pendingHorseBuy = { id: entityId, until: nowMs + 6000 };
      setGatherNotice(`This horse belongs to the stable — buy it first ` +
        `(${STABLE_HORSE_PRICE} gold). Press E again to buy.`);
      return true;
    }

    if (!needsTaming(species) || DEMO_FREE_RIDE_RARES) {
      // Common mountable (or demo free-ride): mount instantly.
      mountedEntityId = entityId;
      best.staying = false;
      best.sit = 0;
      acceptedRideTimer = -1;
      setGatherNotice(`Riding ${SPECIES_DEFS[species].name}. (E to dismount)`);
      // Crime: horse_theft if npcOwned and witnessed
      if (best.npcOwned) {
        const ridM2 = nearestRegionId();
        const witnessed2 = npcRuntimes.some(rt => {
          if (!npcCanWitness(rt)) return false;
          const d = Math.hypot(rt.wx - best!.x, rt.wz - best!.z);
          return d <= WITNESS_RADIUS;
        });
        if (witnessed2) {
          reportCrime(crimeState, ridM2, 'horse_theft', simTime);
          saveCrimeState(crimeState);
          setGatherNotice(`Horse theft! Bounty +${BOUNTY_AMOUNTS.horse_theft}`);
        }
      }
      return true;
    }

    // Rare mountable: needs taming. Get or create tamed state.
    const tamedState: TamedState = tamingRegistry.tamed[entityId] ?? createTamedState();
    const rng = () => Math.random();
    const result = attemptMount(tamedState, species, rng);
    tamingRegistry.tamed[entityId] = result.state;
    saveTamingRegistry(tamingRegistry);

    if (result.result === 'refused') {
      setGatherNotice(`The ${SPECIES_DEFS[species].name} refuses to be ridden.`);
      return true;
    }
    if (result.result === 'bucked') {
      // Knockback: push player away from entity.
      const dx = controller.pos[0] - best.x;
      const dz = controller.pos[2] - best.z;
      const len = Math.hypot(dx, dz) || 1;
      controller.pos[0] += (dx / len) * 2.5;
      controller.pos[2] += (dz / len) * 2.5;
      controller.velY = 5; // small upward toss
      setGatherNotice(
        `The ${SPECIES_DEFS[species].name} bucks you off! (temper ${result.state.temper}/${80})`
      );
      return true;
    }
    if (result.result === 'accepted-ride') {
      mountedEntityId = entityId;
      best.staying = false;
      best.sit = 0;
      acceptedRideTimer = ACCEPTED_RIDE_S;
      setGatherNotice(`The ${SPECIES_DEFS[species].name} accepts you for now… (${ACCEPTED_RIDE_S}s)`);
      return true;
    }
    if (result.result === 'mounted') {
      mountedEntityId = entityId;
      best.staying = false;
      best.sit = 0;
      acceptedRideTimer = -1;
      setGatherNotice(`Riding the ${SPECIES_DEFS[species].name}! (E to dismount)`);
      return true;
    }
    return false;
  }

  /** Try to feed a live animal within 3 m using the held item. */
  function tryFeedAnimal(): boolean {
    const heldId = equipped(inventory);
    if (heldId === null) return false;
    const px = controller.pos[0];
    const pz = controller.pos[2];
    const FEED_REACH = 3.0;

    for (const e of entityManager.entities.values()) {
      if (e.mode === 'dead') continue;
      const dist = Math.hypot(e.x - px, e.z - pz);
      if (dist > FEED_REACH) continue;
      const def = SPECIES_DEFS[e.species];
      if (def.favoriteFood !== heldId) continue;

      // Is this a baby in the growth registry?
      const babyEntry = tamingRegistry.babies[e.id];
      if (babyEntry !== undefined) {
        const gr = feedBaby(babyEntry, e.species, heldId);
        if (gr.accepted) {
          tamingRegistry.babies[e.id] = { ...gr.state, x: e.x, z: e.z };
          saveTamingRegistry(tamingRegistry);
          removeItem(inventory, heldId, 1);
          invChanged();
          setGatherNotice(`${SPECIES_DEFS[e.species].name} munches happily. (growth boost)`);
          return true;
        }
        return false;
      }

      // Normal taming feed for rare mountables.
      if (def.rare && def.mountable) {
        const current = tamingRegistry.tamed[e.id] ?? createTamedState();
        const res = feed(current, e.species, heldId);
        if (res.accepted) {
          tamingRegistry.tamed[e.id] = res.state;
          saveTamingRegistry(tamingRegistry);
          removeItem(inventory, heldId, 1);
          invChanged();
          setGatherNotice(
            `Fed ${SPECIES_DEFS[e.species].name}. Temper: ${res.state.temper}/80` +
            (res.state.tamed ? ' — TAMED!' : '')
          );
          return true;
        }
        return false;
      }

      // Non-taming species: just consume 1 item (friendly gesture).
      removeItem(inventory, heldId, 1);
      invChanged();
      setGatherNotice(`Fed the ${def.name}.`);
      return true;
    }
    return false;
  }

  /**
   * Tick the mounted entity: steer it with player input and lock player
   * position to the saddle. Returns the mount speed used (0 if not mounted).
   */
  /**
   * Pin the rider to the saddle.
   *
   * This must run on EVERY simulated frame the player is mounted, including
   * the ones where they are not steering. `controller.update` integrates
   * gravity independently and runs earlier in the same step, so a single
   * frame without this leaves the player falling — on the ground that is
   * invisible, and in flight it drops them through their own dragon.
   */
  function holdInSaddle(e: import('./entities/entity-manager').EntityState): void {
    controller.pos[0] = e.x;
    controller.pos[1] = saddleY(e.species, e.y);
    controller.pos[2] = e.z;
    controller.velY = 0;
    controller.yaw = e.yaw;
  }

  function tickMount(dtS: number): void {
    if (mountedEntityId === null) return;
    const e = entityManager.entities.get(mountedEntityId);
    if (!e || e.mode === 'dead') {
      doDisMount();
      return;
    }
    if (!vitals.alive) {
      doDisMount();
      return;
    }
    // Freeze the reins while a panel is up. WASD belongs to the panel then,
    // and steering a mount from behind an open inventory means typing a
    // quantity and flying into a mountain. The mount holds position rather
    // than dismounting — the player has not let go, they are just busy.
    //
    // STEERING only. The rider stays seated, and that distinction is the whole
    // bug this comment used to describe incorrectly: this was a bare `return`,
    // which skipped the saddle lock at the bottom of the function as well as
    // the reins. Pressing I or Tab in flight then handed the player to gravity
    // and they fell through the mount to their death. Being busy is not the
    // same as letting go.
    if (panels.isOpen) {
      holdInSaddle(e);
      return;
    }

    const def = SPECIES_DEFS[e.species];
    const baseSpeed = def.mountSpeed ?? def.speed;
    const shiftHeld = controller.heldKeys.has('ShiftLeft')
      || controller.heldKeys.has('ShiftRight');

    // Initialise mount stamina on first mount (entity may not have it yet).
    if (e.stamina === undefined) e.stamina = 100;

    // Hysteresis: sprint locked out at 0, resumes once above MOUNT_STAMINA_SPRINT_RESUME.
    if (mountSprintExhausted && e.stamina >= MOUNT_STAMINA_SPRINT_RESUME) {
      mountSprintExhausted = false;
    }

    // Read movement input (needed for stamina drain decision below).
    let ix = 0, iz = 0;
    if (controller.heldKeys.has('KeyW')) iz -= 1;
    if (controller.heldKeys.has('KeyS')) iz += 1;
    if (controller.heldKeys.has('KeyD')) ix += 1;
    if (controller.heldKeys.has('KeyA')) ix -= 1;
    const hasMovement = ix !== 0 || iz !== 0;

    const canMountSprint = shiftHeld && !mountSprintExhausted && e.stamina > 0;
    const isMountSprinting = canMountSprint && hasMovement;

    if (isMountSprinting) {
      e.stamina = Math.max(0, e.stamina - MOUNT_STAMINA_DRAIN_PER_S * dtS);
      if (e.stamina <= 0) mountSprintExhausted = true;
    } else if (!breathActive) {
      // No regen while breathing fire — the breath drain must actually bite.
      e.stamina = Math.min(100, e.stamina + MOUNT_STAMINA_REGEN_PER_S * dtS);
    }

    const speed = (shiftHeld && !mountSprintExhausted)
      ? baseSpeed * MOUNT_SPRINT_MUL
      : baseSpeed;

    // -----------------------------------------------------------------------
    // Dragon flight: Space = ascend, Q (or Ctrl/C) = descend. Only when
    // dragon + DRAGON_FLIGHT_ENABLED; all other mounts ignore vertical input.
    // -----------------------------------------------------------------------
    const isDragonFlight = SPECIES_DEFS[e.species].canFly === true && DRAGON_FLIGHT_ENABLED;

    if (isDragonFlight) {
      const spaceHeld = controller.heldKeys.has('Space');
      // Q is the primary descend key — Ctrl collides with browser shortcuts.
      const descendHeld = controller.heldKeys.has('KeyQ')
        || controller.heldKeys.has('ControlLeft')
        || controller.heldKeys.has('ControlRight')
        || controller.heldKeys.has('KeyC');

      // Compute terrain height under the dragon.
      const groundY = heightField.heightAt(e.x, e.z);

      // Vertical velocity from input.
      let vy = 0;
      if (spaceHeld) vy = DRAGON_FLIGHT_SPEED;
      else if (descendHeld) vy = -DRAGON_FLIGHT_SPEED;

      // Apply vertical movement.
      let newEntityY = e.y + vy * dtS;

      // Clamp: never below terrain + epsilon — nor below a ROOF you are over.
      //
      // The terrain clamp uses the raw heightfield, which knows nothing about
      // buildings, so a descending dragon used to sink through a barn and come
      // to rest in the street inside it.
      //
      // The candidate test runs on the PRE-move y and the clamp on the post-
      // move one, which is what makes this safe at any descent rate: a frame
      // that crosses a roofline necessarily started above it, so the roof is
      // always offered before it is passed, and `ROOF_CATCH_EPS` is slop
      // rather than a speed allowance. Making it large enough to "catch a fast
      // drop" would be the bug, not the fix — it would let a roof 3 m above a
      // dragon flying PAST the building count as ground and fire it upward.
      const roofY = terrainWorld.flierSupport(
        e.x, e.z, flierRadius(e), e.y, ROOF_CATCH_EPS);
      const minY = Math.max(groundY, roofY) + DRAGON_GROUND_EPSILON;
      if (newEntityY < minY) newEntityY = minY;
      // ...and never INTO the castle. Climbing has to stop under a floor slab
      // and descending has to stop on a roof, or "fly up" is a way through
      // the keep. Every flat floor in the layout carries a derived solid of
      // its own thickness (see castle-collider.ts), so one span test does both
      // ends without a separate ceiling query.
      if (vy !== 0 && flierHitsCastle(e, e.x, e.z, newEntityY)) newEntityY = e.y;
      e.y = newEntityY;

      // Update flight altitude tracker.
      dragonFlightY = e.y - groundY;

      // Flight stamina drain while airborne (never force a fall, just drain for budget).
      if (dragonFlightY > DRAGON_GROUND_EPSILON * 2) {
        e.stamina = Math.max(0, e.stamina - DRAGON_FLIGHT_DRAIN_PER_S * dtS);
      }
    }

    if (hasMovement) {
      // Where the animal was before this step, so a flier that ends up inside
      // masonry can be put back rather than resolved out of it.
      const preMoveX = e.x;
      const preMoveY = e.y;
      const preMoveZ = e.z;
      const len = Math.hypot(ix, iz);
      const camYaw = orbitCam.yaw;
      const sin = Math.sin(camYaw);
      const cos = Math.cos(camYaw);
      const dx = ((ix * cos + iz * sin) / len) * speed * dtS;
      const dz = ((-ix * sin + iz * cos) / len) * speed * dtS;
      // Collision. Airborne fliers get the Y-AWARE settlement query; everything
      // else keeps the ground path.
      //
      // The old split here was `dragonFlightY > 4`: above 4 m AGL settlement
      // collision was skipped entirely, because `slideXZ` never reads
      // `SolidBox.top` and every hut, fence and haystack was therefore an
      // infinitely tall prism that would have stopped a dragon dead over every
      // village in the world. That bypass is gone — the boxes are now read
      // with the mount's altitude in hand (settlement-collider.ts
      // `flierMoveXZ`), so a wall blocks you at wall height and does nothing
      // at all once you are over its roofline.
      //
      // The ground branch is unchanged and still uses the ejecting `slideXZ`:
      // on the ground, being pushed out of a haystack you spawned inside is
      // the right answer, while in the air there is nowhere to be pushed TO.
      if (isDragonFlight && dragonFlightY > FLIER_AIRBORNE_Y) {
        const fr = flierRadius(e);
        // Feet, not centre: a settlement box has no underside, so anything the
        // mount's lowest point has cleared cannot be hit by the rest of it.
        const [sx2, sz2] = terrainWorld.flierMoveXZ(e.x, e.z, dx, dz, fr, e.y);
        // Then the castle, the one collider with real Y extents on its solids.
        // Composed, not chosen between: a dragon can be over a village street
        // and under a castle floor slab at the same time.
        [e.x, e.z] = flierMoveXZ(e, sx2 - e.x, sz2 - e.z);
      } else {
        const mr = Math.max(0.4, SPECIES_DEFS[e.species].size * 0.45);
        const [bx, bz] = terrainWorld.moveXZ(e.x, e.z, dx, dz, mr);
        if (isDragonFlight) {
          // Grounded or barely off it, and still a flier — which over the
          // MOTTE is most of the castle, because `dragonFlightY` is measured
          // against the raw heightfield and the motte is a hill. `terrainWorld`
          // knows nothing about the keep, so this branch was the hole the first
          // fix left: approaches from the south and north came in low over the
          // mound and put the dragon 5 m from the middle of the keep, inside
          // the masonry for 44 of 75 samples.
          [e.x, e.z] = flierMoveXZ(e, bx - e.x, bz - e.z);
        } else {
          e.x = bx;
          e.z = bz;
        }
      }
      e.yaw = Math.atan2(dx, -dz);
      e.walkPhase += speed * dtS * 1.6;
      // Dragon flight: do NOT snap y to terrain — the flight logic above controls y.
      // Ground mounts: snap y to terrain as before.
      if (!isDragonFlight) {
        // The same ground the SAME animal stands on when nobody is riding it.
        // `creatureGroundY` is the carved field (roads graded in) with the
        // castle's floors layered over it; the raw heightfield is the land as
        // generated, before any of that. Riding a horse across a road cutting
        // used to sink it up to 2.5 m into the surface the player could see,
        // and mounting on a settlement platform dropped it to the dirt under
        // the terrace. Dismounting restored it, because the unridden AI has
        // used the carved query all along — the mount tick was the one place
        // that did not.
        e.y = creatureGroundY(e, e.x, e.z, e.y);
      } else {
        // After horizontal movement the terrain under us may have changed;
        // re-clamp so we don't clip through a hill.
        const newGroundY = heightField.heightAt(e.x, e.z);
        if (e.y < newGroundY + DRAGON_GROUND_EPSILON) {
          e.y = newGroundY + DRAGON_GROUND_EPSILON;
        }
        // That clamp is against the RAW heightfield, which inside the castle is
        // the bare motte tens of metres under the floors — so it can push the
        // flier up into a slab it was clear of. If the column it landed in is
        // masonry, refuse the whole horizontal step rather than resolve it: a
        // flier is a box in the air with nowhere to be ejected to, and being
        // flung out of a wall at altitude is worse than being stopped by it.
        if (flierHitsCastle(e, e.x, e.z, e.y)) {
          e.x = preMoveX;
          e.z = preMoveZ;
          e.y = preMoveY;
        }
        dragonFlightY = e.y - heightField.heightAt(e.x, e.z);
      }
    } else if (isDragonFlight && dragonFlightY > DRAGON_GROUND_EPSILON * 2) {
      // Airborne and not moving horizontally: keep walkPhase advancing for wing flap.
      e.walkPhase += DRAGON_AIRBORNE_FLAP_RATE * dtS;
    }

    holdInSaddle(e);

    // Tick accepted-ride countdown.
    if (acceptedRideTimer > 0) {
      acceptedRideTimer -= dtS;
      if (acceptedRideTimer <= 0) {
        // Auto-buck!
        const dx2 = controller.pos[0] - e.x;
        const dz2 = controller.pos[2] - e.z;
        const len2 = Math.hypot(dx2, dz2) || 1;
        controller.pos[0] = e.x + (dx2 / len2) * 2.5;
        controller.pos[2] = e.z + (dz2 / len2) * 2.5;
        // Carved ground: the player's grounding contract everywhere else is
        // `chunkManager.ground`, and being bucked onto the raw field drops you
        // through a paved approach.
        controller.pos[1] = chunkManager.ground.heightAt(
          controller.pos[0], controller.pos[2]);
        controller.velY = 5;
        mountedEntityId = null;
        acceptedRideTimer = -1;
        setGatherNotice('The creature bucks you off after a moment!');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Mount attack (F): fire breath (dragon) / stomp (other mounts)
  // -------------------------------------------------------------------------

  /**
   * Mouth position + aim direction for the dragon breath cone.
   * The cone always fires straight out of the dragon's mouth: the horizontal
   * direction is locked to the dragon's facing (never sideways/backwards),
   * with only the camera's pitch kept for up/down aim so you can rake the
   * ground from the air. The mouth sits at the dragon's actual snout tip,
   * derived from the mesh's neck-arc geometry (buildDragon: 4 neck segments
   * then skull + snout — head lands at local y ≈ 1.61·s, forward ≈ 1.27·s
   * from the body origin).
   */
  function getBreathRay(): {
    mouth: [number, number, number];
    dir: [number, number, number];
  } | null {
    if (mountedEntityId === null) return null;
    const e = entityManager.entities.get(mountedEntityId);
    if (!e || e.mode === 'dead') return null;
    const bs = BREATH_SPEC[e.species];
    if (bs === undefined) return null;
    // Sized AND offset from the mount's OWN species: hardcoding the dragon's
    // numbers put the wyvern's breath origin about a metre above its skull.
    const s = SPECIES_DEFS[e.species].size;
    const fx = Math.sin(e.yaw);   // dragon facing (mesh forward = local -Z)
    const fz = -Math.cos(e.yaw);
    const mouth: [number, number, number] = [
      e.x + fx * s * bs.mouth[0],
      e.y + s * bs.mouth[1],
      e.z + fz * s * bs.mouth[0],
    ];

    // CONVERGE the jet on what the player is looking at, rather than firing
    // parallel to the camera.
    //
    // This used to be `[fx * horiz, f[1], fz * horiz]` — the animal's facing
    // for the horizontal, the camera's pitch for the vertical. The pitch is
    // right and the ORIGIN is not: the ray starts at the animal's mouth, which
    // for a wyvern is 2.83 m up and 2.78 m forward of its feet, while the
    // player is aiming from a camera behind and above them. That parallax is
    // not a rounding error at close range — a deer six metres ahead sits 34.8
    // degrees below a level jet, against a cone half-angle of 18.3, so it was
    // geometrically impossible to hit. The breath drained stamina, drew a full
    // jet and dealt exactly zero damage to anything inside about twelve metres.
    // (Measured; `scripts/test-castle-fight.mts` keeps the number, and
    // `scripts/mount-air-check.mjs` plays it.)
    //
    // Aiming at a point along the player's look ray fixes the origin error the
    // way every offset-muzzle weapon does. The remaining question is HOW FAR
    // along, and a fixed distance is not good enough: converging at a flat
    // 14 m, a deer four metres ahead and two metres below the mouth still sat
    // 33 degrees off the axis, because the convergence point was ten metres
    // past it. Measured, that missed by `perp` 3.69 m against a 2.5 m jet.
    //
    // So when the player is looking DOWN, converge where their look ray meets
    // the ground — which is the thing they are looking at. That is the whole
    // of the close-range case: you point at something standing on the floor,
    // and the fire goes to the patch of floor it is standing on. Looking level
    // or up there is no ground intersection, and the fixed distance is right.
    const AIM_CONVERGE = 14;
    const f = orbitCam.forward(); // unit vector, camera → look target
    const eye: [number, number, number] = [
      controller.pos[0],
      controller.pos[1] + PLAYER_HEIGHT * 0.5,
      controller.pos[2],
    ];
    let converge = AIM_CONVERGE;
    if (f[1] < -0.05) {
      const groundY = chunkManager.ground.heightAt(eye[0], eye[2]);
      const drop = eye[1] - groundY;
      if (drop > 0) converge = Math.max(2, Math.min(AIM_CONVERGE, drop / -f[1]));
    }
    const ax = eye[0] + f[0] * converge - mouth[0];
    const ay = eye[1] + f[1] * converge - mouth[1];
    const az = eye[2] + f[2] * converge - mouth[2];
    const al = Math.hypot(ax, ay, az) || 1;
    const dir: [number, number, number] = [ax / al, ay / al, az / al];
    return { mouth, dir };
  }

  // The cone test now lives in `breath-cone.ts`, as a pure function with a
  // near-field radius. It was a private angular cone here, and it had a dead
  // zone that made the mounted breath deal literally zero damage to anything
  // within ~12 m — see that module's header for the measurement. Moved out so
  // `scripts/test-castle-fight.mts` can assert on the real rule rather than
  // on a copy of it.

  /**
   * Damage an animal entity from a mount attack (breath tick or stomp).
   * Mirrors the melee-swing consequence path: kill/flee/aggro + owned-animal
   * crimes when witnessed by an NPC.
   */
  function damageEntityFromMount(e: import('./entities/entity-manager').EntityState, dmg: number): void {
    const px = controller.pos[0];
    const pz = controller.pos[2];
    e.hp = Math.max(0, e.hp - dmg);
    if (e.hp <= 0) {
      e.mode = 'dead';
      if (e.deadAtS === undefined) e.deadAtS = simTime;
      entityManager.killEntity(e.id);
      setGatherNotice(`Killed ${SPECIES_DEFS[e.species].name}!`);
      if (e.npcOwned) {
        const witnessed = npcRuntimes.some(rt =>
          npcCanWitness(rt) && Math.hypot(rt.wx - px, rt.wz - pz) <= WITNESS_RADIUS);
        if (witnessed) {
          reportCrime(crimeState, nearestRegionId(), 'kill_owned_animal', simTime);
          saveCrimeState(crimeState);
          setGatherNotice(`You killed an owned animal! Bounty +${BOUNTY_AMOUNTS.kill_owned_animal}`);
        }
      }
    } else {
      onEntityDamaged(e);
      if (e.npcOwned) {
        const witnessed = npcRuntimes.some(rt =>
          npcCanWitness(rt) && Math.hypot(rt.wx - px, rt.wz - pz) <= WITNESS_RADIUS);
        if (witnessed) {
          reportCrime(crimeState, nearestRegionId(), 'assault', simTime);
          saveCrimeState(crimeState);
        }
      }
    }
  }

  /**
   * Damage an NPC from a mount attack. Mirrors the melee NPC path:
   * flee + murder/assault crime when another NPC witnesses it.
   */
  /**
   * Record something the player did where the village can see it.
   *
   * The crime system already asked "did anyone see this?" — but only as a
   * boolean, and then threw the answer away. It filed an anonymous
   * `{kind, t}` row against a REGION and raised a bounty, so no NPC could ever
   * say who did what to whom. Attack a farmer in the square and the farmer
   * beside them had no idea it had happened.
   *
   * This keeps the witness LIST, so the bystander remembers, the victim's
   * spouse hears about it, and both can speak about it in character.
   */
  /** Settlement a world position belongs to — the same key NPC memory uses. */
  function nearestSettlementName(x: number, z: number): string {
    for (const res of settlementManager.nearby()) {
      if (Math.hypot(res.site.x - x, res.site.z - z) < 90) return res.name;
    }
    return 'Unknown';
  }

  function recordDeed(
    kind: import('./npc/village-memory').VillageEventKind,
    x: number, z: number,
    subject?: { id: string; name: string },
  ): void {
    const settlement = nearestSettlementName(x, z);
    const witnessed = witnessesNear(
      npcRuntimes.filter((r) => r.hp > 0 && npcCanWitness(r))
        .map((r) => ({ id: r.npc.id, x: r.wx, z: r.wz })),
      x, z, WITNESS_RADIUS);
    recordVillageEvent(villageMemory, settlement, {
      // Time plus kind plus subject makes a stable id, so the same blow
      // reported down two code paths cannot be logged twice.
      id: `${Math.round(simTime * 10)}:${kind}:${subject?.id ?? '-'}`,
      t: simTime, kind,
      subjectId: subject?.id, subjectName: subject?.name,
      witnessed,
    });
    saveVillageMemory(villageMemory);
  }

  function damageNpcFromMount(rt: NpcRuntime, dmg: number): void {
    const px = controller.pos[0];
    const pz = controller.pos[2];
    rt.hp = Math.max(0, rt.hp - dmg);
    rt.fleeing = true;
    const killedNpc = rt.hp <= 0;
    if (killedNpc) onNpcKilled(rt);
    const crimeKind = killedNpc ? 'murder' as const : 'assault' as const;
    // The victim always knows, whoever else was watching.
    recordDeed(killedNpc ? 'killed_npc' : 'attacked_npc', rt.wx, rt.wz,
      { id: rt.npc.id, name: rt.npc.name });
    const witnessed = npcRuntimes.some(other => {
      if (other === rt || !npcCanWitness(other)) return false;
      return Math.hypot(other.wx - px, other.wz - pz) <= WITNESS_RADIUS;
    });
    if (witnessed) {
      reportCrime(crimeState, nearestRegionId(), crimeKind, simTime);
      saveCrimeState(crimeState);
      setGatherNotice(`${killedNpc ? 'Murder' : 'Assault'}! Bounty +${BOUNTY_AMOUNTS[crimeKind]}`);
    }
  }

  /** One breath damage tick: animals, NPCs, and trees inside the cone. */
  function applyBreathDamage(
    mouth: [number, number, number],
    dir: [number, number, number],
    spec: { reach: number; dmg: number; spark: boolean;
            ignites: 'all' | 'tinder' | 'none' },
  ): void {
    // Animals (skip the mount itself and the dead).
    for (const e of entityManager.entities.values()) {
      if (e.id === mountedEntityId || e.mode === 'dead') continue;
      const def = SPECIES_DEFS[e.species];
      if (!inBreathCone(mouth, dir, e.x, e.y + def.size * 0.5, e.z, spec.reach)) continue;
      damageEntityFromMount(e, Math.max(1, Math.round(BREATH_DMG_ENTITY * spec.dmg)));
    }
    // NPCs.
    for (const rt of npcRuntimes) {
      if (rt.hp <= 0) continue;
      // `rt.wy`, the carved-and-terraced ground the NPC is actually standing
      // on, not the raw generated land. A breath cone aimed at someone on a
      // village platform used to test a point up to a couple of metres under
      // their feet and miss them.
      const ny = rt.wy + 0.9;
      if (!inBreathCone(mouth, dir, rt.wx, ny, rt.wz, spec.reach)) continue;
      damageNpcFromMount(rt, Math.max(1, Math.round(BREATH_DMG_NPC * spec.dmg)));
    }
    // Ignition (reuses the lightning burning-tree system).
    if (spec.ignites === 'none') return;
    // Search radius follows the breath's OWN reach. Left at the dragon's, the
    // wyvern would have set light to brush more than twice as far away as its
    // sparks can actually fly.
    const searchR = BREATH_RANGE * spec.reach * 0.7;
    const midX = mouth[0] + dir[0] * BREATH_RANGE * spec.reach * 0.5;
    const midZ = mouth[2] + dir[2] * BREATH_RANGE * spec.reach * 0.5;
    const burning = getBurningTrees();
    // Standing trees only go up under a sustained jet — a shower of embers is
    // not enough to take hold on green timber.
    if (spec.ignites === 'all') {
      const trees = resourceManager.nearbyTreeRefs(midX, midZ, searchR, gameNowMs());
      for (const tr of trees) {
        if (!inBreathCone(mouth, dir, tr.x, tr.y + 2, tr.z, spec.reach)) continue;
        if (burning.some(b => b.x === tr.x && b.z === tr.z)) continue; // already alight
        addBurningTree({ x: tr.x, y: tr.y, z: tr.z, untilS: simTime + TREE_BURN_S });
      }
    }
    // Brush is tinder: it catches from sparks as readily as from flame.
    const bushes = resourceManager.nearbyBushRefs(midX, midZ, searchR, gameNowMs());
    for (const bu of bushes) {
      if (!inBreathCone(mouth, dir, bu.x, bu.y + 0.5, bu.z, spec.reach)) continue;
      if (burning.some(b => b.x === bu.x && b.z === bu.z)) continue;
      addBurningTree({
        x: bu.x, y: bu.y, z: bu.z, kind: 'bush', untilS: simTime + BUSH_BURN_S,
      });
    }
  }

  /**
   * Tick the mount attack. Dragon: hold F to breathe fire along the camera
   * aim (drains stamina, damages the cone, ignites trees). Other mounts:
   * F stomps — radial hoof/claw damage around the mount on a short cooldown.
   */
  function tickMountAttack(dtS: number): void {
    if (stompCooldown > 0) stompCooldown = Math.max(0, stompCooldown - dtS);

    breathActive = false;
    const mounted = mountedEntityId !== null
      ? entityManager.entities.get(mountedEntityId) : undefined;
    if (!mounted || mounted.mode === 'dead' || !vitals.alive || panels.isOpen) {
      breathJaw = Math.max(0, breathJaw - dtS / 0.25);
      entityRenderer.jawOverride = null;
      return;
    }

    const fHeld = controller.heldKeys.has('KeyF');
    if (mounted.stamina === undefined) mounted.stamina = 100;

    // --- the mount defends its rider ------------------------------------
    // Answers whatever is already attacking the player and already in reach.
    // Deliberately does NOT move or seek: the player is steering.
    retaliateCooldown = Math.max(0, retaliateCooldown - dtS);
    if (retaliateCooldown <= 0 && vitals.alive) {
      const mSize = SPECIES_DEFS[mounted.species].size;
      const reach = RETALIATE_REACH + mSize;
      let best: import('./entities/entity-manager').EntityState | null = null;
      let bestD2 = reach * reach;
      for (const h of entityManager.entities.values()) {
        // Only things hunting the player. A grazing deer beside the mount is
        // not a threat, and a mount that mauls passing wildlife turns every
        // journey into a massacre and every settlement into a crime scene.
        if (h.mode !== 'aggro' || h.owned === true) continue;
        if (h.id === mountedEntityId) continue;
        const dx = h.x - mounted.x, dz = h.z - mounted.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; best = h; }
      }
      if (best !== null) {
        retaliateCooldown = RETALIATE_COOLDOWN_S;
        // Reuse the manual bite's jaw snap so a retaliation looks exactly like
        // one — same animation path, no second visual to keep in sync.
        biteCooldown = BITE_COOLDOWN_S;
        const dmg = SPECIES_DEFS[mounted.species].attackDmg
          ?? Math.max(1, Math.round(mSize));
        damageEntityFromMount(best, dmg);
        audio.play('hit', { dist: Math.hypot(best.x - controller.pos[0],
          best.z - controller.pos[2]) });
        // Turn the head toward what it just bit, so the animal is visibly
        // reacting rather than snapping at the air in front of it.
        entityRenderer.jawOverride = { id: mounted.id, jawOpen: 1 };
      }
    }

    const breathSpec = BREATH_SPEC[mounted.species];
    if (breathSpec !== undefined) {
      // --- Breath weapon (dragon: fire jet; wyvern: sparks) ---
      // Recover out of the exhausted state only once there is a real reserve
      // again, so the breath cannot flicker back on for a single frame.
      if (breathExhausted && mounted.stamina >= BREATH_RECOVER_STAMINA) {
        breathExhausted = false;
      }
      if (fHeld && !breathExhausted && mounted.stamina > BREATH_MIN_STAMINA) {
        breathActive = true;
        // Feature 10: dragon_roar SFX when breath starts.
        if (!prevBreathActive) {
          audio.play('dragon_roar');
          // Land the first tick immediately. A short tap used to do nothing at
          // all, because damage only applied once a full BREATH_TICK_S had
          // accumulated since the button went down.
          breathTickAccum = BREATH_TICK_S;
        }
        prevBreathActive = true;
        mounted.stamina = Math.max(0, mounted.stamina - BREATH_STAMINA_DRAIN_PER_S * dtS);
        if (mounted.stamina <= BREATH_MIN_STAMINA) {
          breathExhausted = true;
          setGatherNotice(
            `The ${SPECIES_DEFS[mounted.species].name}'s breath gutters out.`);
        }
        breathJaw = Math.min(1, breathJaw + dtS / 0.15);
        // Turn the dragon toward the aim so the fire leaves its mouth.
        const f = orbitCam.forward();
        if (Math.hypot(f[0], f[2]) > 0.01) {
          const aimYaw = Math.atan2(f[0], -f[2]);
          let dYaw = aimYaw - mounted.yaw;
          while (dYaw > Math.PI) dYaw -= Math.PI * 2;
          while (dYaw < -Math.PI) dYaw += Math.PI * 2;
          mounted.yaw += dYaw * Math.min(1, 10 * dtS);
        }
        breathTickAccum += dtS;
        if (breathTickAccum >= BREATH_TICK_S) {
          breathTickAccum = 0;
          const ray = getBreathRay();
          if (ray !== null) applyBreathDamage(ray.mouth, ray.dir, breathSpec);
        }
      } else {
        breathJaw = Math.max(0, breathJaw - dtS / 0.25);
        breathTickAccum = 0;
        prevBreathActive = false; // Feature 10: reset for next breath start
      }
      // --- Bite (G) ---
      // Close-range answer when the breath is draining or a predator is
      // already on top of you. Snaps the jaw shut through the same override
      // the breath uses, so the two can never fight over the mouth.
      biteCooldown = Math.max(0, biteCooldown - dtS);
      let biteJaw = 0;
      if (controller.heldKeys.has('KeyG') && biteCooldown <= 0
          && mounted.stamina >= BITE_STAMINA) {
        biteCooldown = BITE_COOLDOWN_S;
        mounted.stamina = Math.max(0, mounted.stamina - BITE_STAMINA);
        const fx = Math.sin(mounted.yaw), fz = -Math.cos(mounted.yaw);
        const bx = mounted.x + fx * BITE_RANGE * 0.5;
        const bz = mounted.z + fz * BITE_RANGE * 0.5;
        let hit = false;
        for (const e2 of entityManager.entities.values()) {
          if (e2.id === mountedEntityId || e2.mode === 'dead') continue;
          if (Math.hypot(e2.x - bx, e2.z - bz) > BITE_RANGE * 0.75) continue;
          damageEntityFromMount(e2, BITE_DMG);
          hit = true;
        }
        for (const rt of npcRuntimes) {
          if (rt.hp <= 0) continue;
          if (Math.hypot(rt.wx - bx, rt.wz - bz) > BITE_RANGE * 0.75) continue;
          damageNpcFromMount(rt, BITE_DMG);
          hit = true;
        }
        audio.play('dragon_roar');
        if (hit) setGatherNotice(`The ${SPECIES_DEFS[mounted.species].name} bites!`);
      }
      // The bite snap: jaw opens fast at the start of the cooldown and shuts.
      if (biteCooldown > 0) {
        const u = 1 - biteCooldown / BITE_COOLDOWN_S;
        biteJaw = u < 0.35 ? u / 0.35 : Math.max(0, 1 - (u - 0.35) / 0.35);
      }
      const jaw = Math.max(breathJaw, biteJaw);
      entityRenderer.jawOverride = jaw > 0.01
        ? { id: mounted.id, jawOpen: jaw } : null;
    } else {
      // --- Stomp (hooves / claws) ---
      entityRenderer.jawOverride = null;
      breathJaw = 0;
      if (fHeld && stompCooldown <= 0 && mounted.stamina >= STOMP_STAMINA) {
        stompCooldown = STOMP_COOLDOWN_S;
        mounted.stamina = Math.max(0, mounted.stamina - STOMP_STAMINA);
        let hit = false;
        for (const e of entityManager.entities.values()) {
          if (e.id === mountedEntityId || e.mode === 'dead') continue;
          if (Math.hypot(e.x - mounted.x, e.z - mounted.z) > STOMP_RANGE) continue;
          damageEntityFromMount(e, STOMP_DMG);
          hit = true;
        }
        for (const rt of npcRuntimes) {
          if (rt.hp <= 0) continue;
          if (Math.hypot(rt.wx - mounted.x, rt.wz - mounted.z) > STOMP_RANGE) continue;
          damageNpcFromMount(rt, STOMP_DMG);
          hit = true;
        }
        if (hit) setGatherNotice(`The ${SPECIES_DEFS[mounted.species].name} lashes out!`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Phase 60: egg nest streaming + rendering
  // -------------------------------------------------------------------------

  /** Currently-visible NestSite objects (rebuilt when player cell changes). */
  let streamedNests: NestSite[] = [];
  /** Last cell (cx,cz) the nests were streamed for (avoids redundant rebuilds). */
  let nestStreamCellX = -99999;
  let nestStreamCellZ = -99999;
  /** GPU draw calls for nest props (rebuilt when streamedNests changes). */
  let nestDraws: import('./renderer').DungeonDraw[] = [];
  let nestGpuBuffers: GPUBuffer[] = [];

  /**
   * Build a twig-bowl mesh (flat cylinder-like stacked boxes) for a nest.
   * Position-only float32x3 — the layout the dungeon pipeline consumes
   * (stride 12); color comes from the surface wood palette (mode 101).
   */
  function buildNestMesh(
    site: NestSite,
  ): Float32Array {
    const verts: number[] = [];
    const x = site.x, y = site.y, z = site.z;
    // Size by kind: bird ~0.5 m, griffin ~1.5 m, dragon ~2 m
    const s = site.kind === 'dragon' ? 2.0 : site.kind === 'griffin' ? 1.5 : 0.5;
    // Layer 1 (base ring): flat wide box
    box(verts, x-s*0.5, y,          z-s*0.5, x+s*0.5, y+s*0.08, z+s*0.5);
    // Layer 2 (inner ring): slightly taller, narrower
    box(verts, x-s*0.38, y+s*0.08, z-s*0.38, x+s*0.38, y+s*0.16, z+s*0.38);
    // Layer 3 (cup): smallest
    box(verts, x-s*0.22, y+s*0.16, z-s*0.22, x+s*0.22, y+s*0.22, z+s*0.22);
    return new Float32Array(verts);
  }

  /** Rebuild GPU draws for currently-streamed nests (skipping looted ones). */
  function rebuildNestDraws(): void {
    for (const b of nestGpuBuffers) b.destroy();
    nestGpuBuffers = [];
    nestDraws = [];
    const lg = getFireLightsBindGroup();
    for (const site of streamedNests) {
      if (lootedNests.has(site.id)) continue; // already looted — invisible
      const verts = buildNestMesh(site);
      if (verts.length === 0) continue;
      const vb = renderer.device.createBuffer({
        label: `nest-${site.id}`,
        size: verts.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      renderer.device.queue.writeBuffer(vb, 0, verts.buffer as ArrayBuffer, 0, verts.byteLength);
      // 101 = surface wood palette: sunlit brown twigs.
      const { bindGroup, shadowBindGroup } = renderer.createObjectBindGroup(0, 0, 0, 101);
      nestDraws.push({
        draw: { vertexBuffer: vb, indexBuffer: null, count: verts.length / (STRIDE_PROP / 4), bindGroup, shadowBindGroup },
        lightsBindGroup: lg,
      });
      nestGpuBuffers.push(vb);
    }
  }

  /** Update the 3×3-cell nest stream when the player moves to a new cell. */
  function updateNestStream(): void {
    const px = controller.pos[0];
    const pz = controller.pos[2];
    const cx = Math.floor(px / ECELL);
    const cz = Math.floor(pz / ECELL);
    if (cx === nestStreamCellX && cz === nestStreamCellZ) return;
    nestStreamCellX = cx;
    nestStreamCellZ = cz;
    streamedNests = [];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nests = nestsForCell(
          WORLD_SEED,
          cx + dx, cz + dz,
          (x, z2) => heightField.heightAt(x, z2),
          (x, z2) => biomeField.biomeAt(x, z2),
        );
        streamedNests.push(...nests);
      }
    }
    rebuildNestDraws();
  }

  /** Try to loot a nest within 3 m of the player. Returns true if looted. */
  function tryLootNest(): boolean {
    const px = controller.pos[0];
    const pz = controller.pos[2];
    const NEST_REACH = 3.0;
    for (const site of streamedNests) {
      if (lootedNests.has(site.id)) continue;
      const dist = Math.hypot(site.x - px, site.z - pz);
      if (dist > NEST_REACH) continue;
      // Loot: give 1 egg of the nest's kind.
      const eggId = nestEggItem(site.kind);
      addItem(inventory, eggId, 1);
      invChanged();
      lootedNests.add(site.id);
      saveLootedNests(lootedNests);
      rebuildNestDraws(); // remove looted nest from draw list
      const kindName = site.kind.charAt(0).toUpperCase() + site.kind.slice(1);
      setGatherNotice(`Found a ${kindName} egg in the nest!`);
      return true;
    }
    return false;
  }

  /** Prompt text when a nest is within reach. */
  function nestPrompt(): string | null {
    const px = controller.pos[0];
    const pz = controller.pos[2];
    for (const site of streamedNests) {
      if (lootedNests.has(site.id)) continue;
      if (Math.hypot(site.x - px, site.z - pz) <= 3.0) {
        return `E — search ${site.kind} nest`;
      }
    }
    return null;
  }

  // Initial stream for spawn position.
  updateNestStream();

  // -------------------------------------------------------------------------
  // Phase K: egg rendering (simple ovoid box props via DungeonDraw idiom)
  // -------------------------------------------------------------------------
  /**
   * Rebuild GPU draw calls for all placed eggs.
   * Eggs are rendered as small axis-aligned boxes using the DungeonDraw
   * pipeline (same as fires/tents). The pipeline is position-only (stride
   * 12), so species color comes from the surface palette mode:
   *   bird   → 105 plaster (beige)
   *   dragon → 107 berry red
   *   griffin→ 104 thatch (gold)
   */
  let eggDraws: import('./renderer').DungeonDraw[] = [];
  let eggGpuBuffers: GPUBuffer[] = [];

  function buildEggMesh(x: number, y: number, z: number): Float32Array {
    // Simple box 0.3 × 0.45 × 0.3 centered at x,z, sitting on y.
    const W = 0.15, H = 0.45, D = 0.15;
    const verts: number[] = [];
    box(verts, x - W, y, z - D, x + W, y + H, z + D);
    return new Float32Array(verts);
  }

  function rebuildEggDraws(): void {
    for (const b of eggGpuBuffers) b.destroy();
    eggGpuBuffers = [];
    eggDraws = [];
    const lg = getFireLightsBindGroup();
    for (const [, egg] of Object.entries(tamingRegistry.eggs)) {
      if (egg.hatched) continue;
      let mode = 105; // bird → plaster (beige)
      if (egg.species === 'dragon')  mode = 107; // berry red
      if (egg.species === 'griffin') mode = 104; // thatch (gold)
      const y = heightField.heightAt(egg.x, egg.z);
      const verts = buildEggMesh(egg.x, y, egg.z);
      const vb = renderer.device.createBuffer({
        label: 'egg-prop',
        size: verts.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      renderer.device.queue.writeBuffer(vb, 0, verts.buffer as ArrayBuffer, 0, verts.byteLength);
      const { bindGroup, shadowBindGroup } = renderer.createObjectBindGroup(0, 0, 0, mode);
      eggDraws.push({
        draw: { vertexBuffer: vb, indexBuffer: null, count: verts.length / (STRIDE_PROP / 4), bindGroup, shadowBindGroup },
        lightsBindGroup: lg,
      });
      eggGpuBuffers.push(vb);
    }
  }
  rebuildEggDraws();

  // -------------------------------------------------------------------------
  // Phase K: egg incubation + baby growth tick
  // -------------------------------------------------------------------------
  function tickTaming(dtS: number): void {
    let changed = false;

    // --- Egg incubation ---
    for (const [eggId, egg] of Object.entries(tamingRegistry.eggs)) {
      if (egg.hatched) continue;
      // Check whether any lit fire is within EGG_HEAT_RADIUS.
      const nearLit = fires.some(
        f => isFireLit(f, simTime)
          && Math.hypot(f.x - egg.x, f.z - egg.z) <= EGG_HEAT_RADIUS
      );
      const updated = heatEgg(egg, dtS, nearLit);
      tamingRegistry.eggs[eggId] = { ...updated, x: egg.x, z: egg.z };
      changed = true;

      if (updated.hatched && !egg.hatched) {
        // Hatch! Spawn a live baby entity.
        const species = updated.species as Species;
        const babyEntity = entityManager.spawnEntity(species, egg.x, egg.z);
        babyEntity.owned = true;
        babyEntity.mode = 'follow';
        babyEntity.scaleOverride = 0.45;
        // Initialize taming state for dragon/griffin babies with empty state
        // (they start taming-eligible immediately via feeding).
        if (needsTaming(species)) {
          tamingRegistry.tamed[babyEntity.id] = createTamedState();
        }
        // Register baby in growth registry.
        tamingRegistry.babies[babyEntity.id] = {
          species,
          ageS: 0,
          adult: false,
          x: egg.x,
          z: egg.z,
        };
        // Remove the egg entry.
        delete tamingRegistry.eggs[eggId];
        // Rebuild egg draws so the visual disappears.
        rebuildEggDraws();
        setGatherNotice(`${SPECIES_DEFS[species].name} egg hatched!`);
      }
    }

    // --- Baby growth ---
    for (const [babyId, babyData] of Object.entries(tamingRegistry.babies)) {
      if (babyData.adult) continue;
      const updated = growBaby(babyData, dtS);
      tamingRegistry.babies[babyId] = { ...updated, x: babyData.x, z: babyData.z };
      changed = true;

      // Keep position in sync with entity.
      const entity = entityManager.entities.get(babyId);
      if (entity) {
        tamingRegistry.babies[babyId].x = entity.x;
        tamingRegistry.babies[babyId].z = entity.z;
      }

      if (updated.adult && !babyData.adult) {
        // Grown up! Remove scale override so it renders at full size.
        if (entity) {
          entity.scaleOverride = undefined;
          entity.mode = 'follow';
        }
        const species = updated.species;
        setGatherNotice(`${SPECIES_DEFS[species].name} has grown into an adult!`);
      }
    }

    if (changed) {
      saveTamingRegistry(tamingRegistry);
    }
  }

  // -------------------------------------------------------------------------
  // Phase K: place an egg from inventory at the aim point
  // -------------------------------------------------------------------------
  function tryPlaceEgg(): boolean {
    const heldId = equipped(inventory);
    if (heldId === null) return false;
    const eggSpecies = eggSpeciesFor(heldId);
    if (eggSpecies === null) return false;
    const pos = placementTarget();
    if (pos === null) return false;
    removeItem(inventory, heldId, 1);
    invChanged();
    const eggId = `egg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    tamingRegistry.eggs[eggId] = {
      species: eggSpecies,
      heatS: 0,
      hatched: false,
      x: pos[0],
      z: pos[2],
    };
    saveTamingRegistry(tamingRegistry);
    rebuildEggDraws();
    setGatherNotice(`${heldId.replace('egg_', '').replace('_', ' ')} egg placed. Keep it near a campfire!`);
    return true;
  }

  /** Monotonic id source for `__gameDebug.placeEntity`. See the note there. */
  let probeEntitySeq = 0;

  // Built as a local first, published to `window` only outside a Steam release
  // build (see the assignment after the closing brace). The explicit type
  // annotation is load-bearing: it restores the contextual typing the direct
  // `window.__gameDebug = {…}` assignment used to provide, so the 157 methods'
  // parameters stay inferred instead of becoming implicit `any`.
  const gameDebug: NonNullable<Window['__gameDebug']> = {
    enterNearestDungeon: () => dungeonManager.debugEnterNearest(),
    /**
     * The resident dungeon's cell grid, in grid-local metres. Null when
     * outside. Lets a harness FIND a wall instead of guessing at one.
     */
    dungeonCorpseStampTime: () => dungeonManager.corpseStampTime,
    /** True when the player's head is under castle masonry. */
    castleRoofedHere: () => underCastleRoof(),
    /** Eased 0..1 shelter weight — 1 fully covered. */
    shelterLevel: () => shelter,
    /** The rain intensity actually handed to the renderer this frame. */
    frameRainLevel: () => lastFrameRainLevel,
    dungeonGrid: () => {
      const g = dungeonManager.debugGrid();
      return g === null ? null
        : { w: g.w, h: g.h, origin: [...g.origin] as [number, number, number],
          cells: Array.from(g.cells) };
    },
    /**
     * Stand the player at grid-local (lx, lz) on the dungeon floor.
     *
     * NOT `teleport`, which snaps to TERRAIN height — a dungeon interior lives
     * at y = -300 in a slot arena far below the world, so `teleport` flings the
     * player to the surface while distance readbacks in dungeon-origin
     * coordinates go on reporting them next to the boss. That exact mistake has
     * produced false "melee does no damage" results twice.
     */
    dungeonPlacePlayer: (lx: number, lz: number) => {
      const g = dungeonManager.debugGrid();
      if (g === null) return false;
      controller.pos = [g.origin[0] + lx, g.origin[1], g.origin[2] + lz];
      controller.velY = 0;
      return true;
    },
    /** True when a world point is inside dungeon masonry. */
    dungeonSolidAt: (x: number, y: number, z: number) =>
      dungeonManager.solidAt(x, y, z),
    /** True when nothing solid stands between two world XZ points. */
    dungeonSeesFrom: (x0: number, z0: number, x1: number, z1: number) =>
      dungeonManager.seesFrom(x0, z0, x1, z1),
    teleportToExitPortal: () => dungeonManager.debugTeleportToExit(),
    teleportToNearestChest: () => dungeonManager.debugTeleportToNearestChest(),
    teleportToNearestEntrance: () => dungeonManager.debugTeleportToNearestEntrance(),
    nearestDungeonName: () => dungeonManager.debugNearestEntrance()?.name ?? null,
    directorGeneration: () => director?.generation ?? -1,
    playerPos: () => [controller.pos[0], controller.pos[1], controller.pos[2]],
    customization: () => custom,
    inventory: () => inventory,
    attackT: () => attackT,
    nearestSettlement: () => settlementManager.nearestSettlement(),
    nearestResource: () =>
      resourceManager.nearestNode(controller.pos, Infinity, gameNowMs(), 2),
    teleportToNearestResource: (type: string) => {
      const node = resourceManager.nearestNode(
        controller.pos, Infinity, gameNowMs(), 6,
        type as NodeType);
      if (node === null) return false;
      controller.pos = [node.x + 1.0, node.y + 1.0, node.z];
      controller.velY = 0;
      return true;
    },
    setShadows: (on: boolean | null) => { shadowOverride = on; },
    attackTokens: () => ({
      contenders: meleeTokens.contenderCount,
      held: meleeTokens.heldCount,
      capacity: meleeTokens.tokenCapacity,
      peakHeld: meleeTokens.peakHeld,
      deniedByToken: meleeTokens.deniedByToken,
      deniedByRate: meleeTokens.deniedByRate,
      enabled: meleeTokensOn,
    }),
    /**
     * The guard, as the sim sees it.
     *
     * `combat-feel-check.mjs` needs to prove that a blocked bite cost exactly
     * the tier's stamina and that a parry cost none, and neither claim is
     * visible from HP alone — a parry and an ordinary block look identical on
     * the health bar, which is precisely the trap a "parry test" falls into.
     * `lastReason` is what tells them apart, and `parried`/`blocked` are what
     * catch a test that is measuring nothing because the shield never engaged.
     *
     * Read-only. Nothing in the feature branches on any of it (see the release
     * rule): `__gameDebug` is stripped from a release build and blocking has to
     * behave identically with it gone.
     */
    guardState: () => ({
      shield: shieldTier(),
      down: guard.down,
      raised: blocking(),
      /** True right now — the window is open and a blow landing would parry. */
      parryWindow: parryReady(guard, simTime),
      /** Whether this raise was allowed to arm at all (the anti-mash rule). */
      armed: guard.armed,
      raisedAtS: guard.raisedAtS,
      blend: guardBlend,
      lastKind: lastBlock?.kind ?? null,
      lastReason: lastBlock?.reason ?? null,
      lastBearingDeg: lastBlock === null ? null : lastBlock.bearing * 180 / Math.PI,
      lastStaggerS: lastBlock?.staggerS ?? 0,
      sparks: lastParrySparks,
      ...guardStats,
    }),
    /** Seconds of parry-stagger left on an entity, or null when unknown. */
    staggerOf: (id: string) => {
      const e = entityManager.entities.get(id);
      return e === undefined ? null : staggerRemaining(e);
    },
    /**
     * Put a shield in hotbar slot 1 — NOT the selected slot.
     *
     * Slot 1 on purpose: the whole claim of the feature is that a shield
     * coexists with the weapon in your hand, so a harness that had to select
     * the shield to use it would be testing something the game does not do.
     * `null` clears the slot.
     */
    giveShield: (tier: string | null) => {
      if (tier === null) { inventory.hotbar[1] = null; invChanged(); return true; }
      const s = (SHIELD_STATS as Record<string, { itemId: string }>)[tier];
      if (s === undefined) return false;
      inventory.hotbar[1] = { id: s.itemId as GameItemId, count: 1 };
      invChanged();
      return true;
    },
    /**
     * Land one blow on the player RIGHT NOW, through the real damage path.
     *
     * The one thing a harness cannot otherwise do is choose WHEN a blow lands,
     * and the parry window is 0.18 s wide — so proving that `window − ε` parries
     * and `window + ε` does not is unreachable by waiting for a wolf to make up
     * its own mind. Everything else is real: this calls the same
     * `applyAttackOnPlayer` the wolf calls, builds the same source struct from
     * the same live entity, and the HP and stamina it moves are the real ones.
     * Only the clock is the harness's.
     *
     * Returns what the guard decided plus the exact `heldS` at impact, so a
     * timing assertion can report the margin it actually achieved rather than
     * the one it hoped for.
     */
    forceAttackOnPlayer: (
      entityId: string | null, damage: number,
      kind: 'melee' | 'projectile' | 'breath' = 'melee',
    ) => {
      const e = entityId === null ? undefined : entityManager.entities.get(entityId);
      const heldS = guard.down ? simTime - guard.raisedAtS : -1;
      const hpBefore = vitals.hp;
      const staBefore = vitals.stamina;
      const hit = applyAttackOnPlayer(damage,
        e === undefined ? 'combat' : 'animal',
        kind === 'melee' ? 'melee' : 'ranged',
        e === undefined ? 1.7 : SPECIES_DEFS[e.species].size,
        e === undefined ? controller.pos[1] : e.y,
        {
          x: e?.x ?? controller.pos[0],
          z: e?.z ?? (controller.pos[2] - 2),
          kind,
          id: e?.id,
          entity: e,
          boss: e === undefined ? false : isExempt(e.species),
          tokens: meleeTokensOn ? meleeTokens : null,
        });
      return {
        hit,
        heldS,
        hpLost: hpBefore - vitals.hp,
        staminaSpent: staBefore - vitals.stamina,
        kind: lastBlock?.kind ?? null,
        reason: lastBlock?.reason ?? null,
        staggerS: lastBlock?.staggerS ?? 0,
        bearingDeg: lastBlock === null ? null : lastBlock.bearing * 180 / Math.PI,
      };
    },
    /** The published ladder, so a harness asserts on the shipped numbers. */
    shieldLadder: () => SHIELD_STATS,
    lockOn: () => {
      const t = lockOnId === null ? undefined : lockedCandidate();
      if (t === undefined) return null;
      return {
        id: t.id, x: t.x, z: t.z,
        dist: Math.hypot(t.x - controller.pos[0], t.z - controller.pos[2]),
      };
    },
    setLockOn: (on: boolean | null) => {
      if (on === false) releaseLock();
      else if (on === true) { releaseLock(); toggleLock(); }
      else toggleLock();
      return lockOnId;
    },
    cycleLockOn: (dir: number) => { cycleLock(dir); return lockOnId; },
    setAttackTokens: (on: boolean) => {
      meleeTokensOn = on;
      // Clear on every flip so an A/B run's two halves cannot contaminate each
      // other through stale contenders or a half-elapsed landing floor.
      meleeTokens.reset();
    },
    attackLog: () => {
      const out: { id: string; t: number }[] = [];
      for (let i = 0; i < ATTACK_LOG_N; i++) {
        const k = (attackLogW + i) % ATTACK_LOG_N;
        if (attackLogId[k] !== '') out.push({ id: attackLogId[k]!, t: attackLogT[k]! });
      }
      return out;
    },
    setCamera: (yaw: number, pitch: number, distance: number) => {
      // A held lock re-eases the yaw every frame and would silently undo this
      // the moment the harness let go of it. `boss-kill-real.mjs` aims with
      // `setCamera` and fires 480 arrows through it; a lock-on that fought it
      // would have turned that harness into a coin toss.
      releaseLock();
      orbitCam.yaw = yaw;
      orbitCam.pitch = pitch;
      orbitCam.distance = distance;
    },
    setPortraitSubject: (entityId: string | null) => {
      portraitEntityId = entityId;
    },
    heightAt: (x: number, z: number) => heightField.heightAt(x, z),
    /**
     * The ground as DRAWN — roads graded in. `heightAt` above is the raw
     * generated land, which is the right answer for placement questions and
     * the wrong one for "where would a creature's feet be"; that distinction
     * has produced false bug reports twice, so both are exposed by name.
     */
    groundHeightAt: (x: number, z: number) => chunkManager.ground.heightAt(x, z),
    /** Every loaded NPC's home + indoor state — for the indoor-NPC harness. */
    npcHomes: () => npcRuntimes.map((rt) => ({
      id: rt.npc.id,
      name: rt.npc.name,
      role: rt.npc.role,
      settlement: rt.npc.settlementName,
      pad: rt.npc.homePadIndex,
      padType: rt.homePadType,
      indoors: rt.indoors,
      inArena: rt.inArena,
      x: rt.wx, z: rt.wz,
    })),
    /** Walk into the building this NPC calls home; true if we got in. */
    enterNpcHome: (npcId: string): boolean => {
      const rt = npcRuntimes.find((r) => r.npc.id === npcId);
      if (rt === undefined) return false;
      const sett = settlementManager.nearby()
        .find((s) => s.name === rt.npc.settlementName);
      if (sett === undefined) return false;
      return buildingManager.enterNpcHome(sett, npcId, rt.npc.homePadIndex);
    },
    /** Which building the player is standing in, by NPC-home identity. */
    occupiedBuilding: () => buildingManager.occupiedBuilding,
    /** The interaction line the HUD is currently showing. */
    interactPrompt: () => lastInteractPrompt,
    /** Who the player could talk to right now (indoors or out). */
    nearestNpc: () => {
      const rt = nearestNpc();
      return rt === null ? null : { id: rt.npc.id, name: rt.npc.name, role: rt.npc.role };
    },
    playerMotion: () => ({
      grounded: controller.grounded,
      swimming: controller.swimming,
      velY: controller.velY,
      /** Mesh facing, `atan2(dx, -dz)`. Z-targeting pins this at the target. */
      yaw: controller.yaw,
    }),
    setArmor: (slots) => {
      for (const slot of ['head', 'body', 'legs'] as const) {
        const id = slots[slot];
        if (id === undefined) continue;
        inventory.armor[slot] = id === null || !isGameItemId(id)
          ? null : { id, count: 1 };
      }
      invChanged();
    },
    setCustomization: (partial) => {
      custom = { ...custom, ...partial };
      saveCustomization(custom);
    },
    freezeAttackT: (t: number | null) => {
      attackTOverride = t;
    },
    equipItem: (id: string, count = 1) => {
      if (!isGameItemId(id)) return false;
      // `count` defaults to 1 for every caller that predates it. A stack size
      // matters for anything that CONSUMES what it holds: a torch harness that
      // equips the default 1 and then burns it out is testing "the last torch"
      // no matter which beat it thinks it is running.
      inventory.hotbar[inventory.selected] = { id, count };
      invChanged();
      return true;
    },
    teleportToNearestSettlementSign: () => {
      const site = settlementManager.findNearestSite(
        controller.pos[0], controller.pos[2]);
      if (site === null) return false;
      const [sx, sy, sz] = settlementManager.signWorldPos(site);
      controller.pos = [sx + 1.2, sy + 0.5, sz];
      controller.velY = 0;
      return true;
    },
    vitals: () => ({ ...vitals }),
    /**
     * Restore the player to full health.
     *
     * For probes that run many trials in one session next to something that
     * bites. The castle dismount harness places a wild dragon — `aggro: true`
     * — on each storey, and after four trials the accumulated mauling killed
     * the player; death auto-dismounts, so every remaining storey reported
     * "the mount did not hold" and read as a collision bug. The vitals dump is
     * what said `deathCause: "animal"`.
     */
    healPlayer: () => {
      vitals = createVitals();
      saveVitals(vitals);
      isDead = false;
      deathOverlay.style.display = 'none';
      return true;
    },
    setVitals: (partial: Partial<Vitals>) => {
      Object.assign(vitals, partial);
      // Healing above zero also clears the DEATH STATE, not just the number.
      //
      // `Object.assign` alone left `vitals.alive` false and `isDead` true, so a
      // harness that topped the player up after a death carried on driving a
      // frozen game: the controller is gated on `!isDead`, and every damage
      // source checks `vitals.alive`. A boss-fight probe read that as "the
      // dragon's breath stopped working" when what had actually happened was
      // that the player was still lying dead behind the overlay at 20 hp.
      if ((partial.hp ?? 0) > 0 && isDead) {
        vitals.alive = true;
        isDead = false;
        deathOverlay.style.display = 'none';
        vitalsHud.setVisible(true);
      }
    },
    placeFire: (x: number, z: number, lit = true) => {
      const y = heightField.heightAt(x, z);
      const fire = createFire(x, y, z, 'campfire', 0, simTime);
      if (lit) addFuel(fire, 4, simTime); // 360 s fuel
      fires.push(fire);
      saveFires(fires);
      rebuildFireDraws(simTime);
      return fire.id;
    },
    placeTent: (x: number, z: number, tier: 1 | 2 | 3 = 1) => {
      const y = heightField.heightAt(x, z);
      const tent = createTent(x, y, z, tier);
      tents.push(tent);
      saveTents(tents);
      rebuildTentDraws();
      return tent.id;
    },
    fires: () => fires.map(f => ({ ...f })),
    tents: () => tents.map(t => ({ ...t })),
    nearCampfire: () =>
      nearCampfireOrForge(fires, controller.pos[0], controller.pos[2], simTime),
    nearForgeDebug: () =>
      nearForgeCheck(fires, controller.pos[0], controller.pos[2], simTime),
    // Phase I
    triggerStrike: (dx: number, dz: number, forceOutcome?: 'death' | 'survivor') => {
      const tx = controller.pos[0] + dx;
      const tz = controller.pos[2] + dz;
      fireStrikeAt(tx, tz, simTime, forceOutcome);
    },
    burningTrees: () => [...getBurningTrees()],
    // Phase J
    entities: () => [
      ...entityManager.snapshot(),
      ...dungeonManager.dungeonEnemies(),
    ],
    spawnEntity: (species: string, dx: number, dz: number) => {
      if (!(species in SPECIES_DEFS)) return null;
      const px = controller.pos[0] + dx;
      const pz = controller.pos[2] + dz;
      return entityManager.spawnEntity(species as Species, px, pz);
    },
    /**
     * Put a creature at an EXACT world position, terrain snapping bypassed.
     *
     * `spawnEntity` drops the animal onto `heightAt`, which on the castle is
     * the motte hillside ~28 m under the keep floor. That makes every mount
     * probe inside the castle a no-op — the harness teleports onto a storey,
     * spawns a horse, and the horse is in the hill, so `mounted` never becomes
     * true and the run reports success having tested nothing. This is how
     * dismount-through-the-floor shipped: every dismount test in the repo ran
     * on open terrain with a single ground plane.
     */
    placeEntity: (species: string, x: number, y: number, z: number) => {
      if (!(species in SPECIES_DEFS)) return null;
      // Monotonic, NOT derived from `entities.size`. `placeEntity` is
      // idempotent on the id and a killed animal lingers as a corpse, so a
      // size-derived id repeated itself the moment a probe cleaned up after
      // itself — the second call returned the FIRST dragon, still standing on
      // the storey below, and the harness reported "never mounted" for the
      // eight storeys after it.
      const id = `probe_${species}_${probeEntitySeq++}`;
      const e = entityManager.placeEntity(id, species as Species, x, y, z, 0, 0);
      e.mode = 'idle';
      // PINNED, like the castle garrison. `_enforceCap` culls farthest-first
      // among everything that is not pinned or owned, and stops once the total
      // is back under `LIVE_CAP` — so inside the castle, where ~20 pinned
      // garrison bodies are loaded and almost nothing else is cullable, it
      // culls the entire cullable set. That deleted the probe's mount 250 ms
      // after it was placed, and seven castle storeys reported "never mounted"
      // with no visible cause.
      e.pinned = true;
      return e.id;
    },
    /**
     * Mount a specific creature outright, skipping reach, taming and flight.
     *
     * Pressing E is not usable for a dismount probe: a wild animal placed
     * beside the player flees on sight, and a horse put on the keep floor was
     * measured 14 m away and 8 m lower 1.5 s after placement — the harness was
     * dismounting nothing and reporting it as fine. The subject here is
     * `doDisMount`, so the mount half must not be able to fail silently.
     */
    /**
     * Delete a probe creature outright, corpse and all.
     *
     * `killEntity` leaves a body in the map, so a harness that places and
     * kills a mount on each of eleven castle storeys pushes `entities.size`
     * past `LIVE_CAP` and the cap starts culling. Probes should clean up
     * completely rather than leave litter that changes the next measurement.
     */
    removeEntity: (id: string) => {
      if (!entityManager.entities.has(id)) return false;
      if (mountedEntityId === id) mountedEntityId = null;
      entityManager.despawnEntity(id);
      return true;
    },
    /**
     * Hold a creature still — `stepAnimal`'s stay behaviour, forced.
     *
     * Separates two things a probe would otherwise conflate. A deer that runs
     * when it sees you is CORRECT, and an arrow arriving where the deer used
     * to be is a LEAD problem, which is a skill the player is meant to have
     * and the game must not solve for them. Whether the bow puts the arrow
     * where the crosshair was is a different question, and it can only be
     * asked of a target that stayed put. Measured before this existed: a deer
     * at 12 m fled fast enough that a dead-on shot passed 1.72 m behind it.
     */
    holdEntity: (id: string, on = true) => {
      const e = entityManager.entities.get(id);
      if (!e) return false;
      // `stepAnimal`'s stay branch is gated on `owned` as well as `staying` —
      // it is the tamed-pet sit, not a general freeze — so setting `staying`
      // alone did nothing and a probe deer went straight back to `flee` on the
      // next tick. Both flags, or this hook silently does not work.
      (e as typeof e & { owned?: boolean }).owned = on;
      e.staying = on;
      e.mode = 'idle';
      e.stateTimer = 0;
      return true;
    },
    /**
     * Step off the current mount, exactly as `doDisMount` does.
     *
     * Not the same as pressing E. The KeyE priority chain puts
     * `castleManager.tryInteract()` ABOVE dismounting, so inside the castle E
     * loots the escape chest instead — which raises the alarm, turns the
     * garrison hostile and gets the player shot. A dismount probe then ends
     * with `!vitals.alive`, which auto-dismounts for a completely different
     * reason, and seven storeys reported "the mount did not hold" with no
     * visible cause. A probe for `doDisMount` must call `doDisMount`.
     */
    dismount: () => {
      if (mountedEntityId === null) return false;
      doDisMount();
      return true;
    },
    mountEntity: (id: string) => {
      const e = entityManager.entities.get(id);
      if (!e || e.mode === 'dead' || !SPECIES_DEFS[e.species].mountable) return false;
      mountedEntityId = id;
      e.staying = false;
      e.sit = 0;
      acceptedRideTimer = -1;
      return true;
    },
    killEntity: (id: string) => {
      const e = entityManager.entities.get(id);
      if (!e) return false;
      e.hp = 0;
      e.mode = 'dead';
      if (e.deadAtS === undefined) e.deadAtS = simTime;
      entityManager.killEntity(id);
      return true;
    },
    attackEntity: (id: string, damage: number) => {
      // Try dungeon enemies first (when inside a dungeon).
      if (dungeonManager.isInside) {
        if (dungeonManager.attackDungeonEnemy(id, damage, simTime)) return true;
      }
      const e = entityManager.entities.get(id);
      if (!e || e.mode === 'dead') return false;
      e.hp = Math.max(0, e.hp - damage);
      if (e.hp <= 0) {
        e.mode = 'dead';
        if (e.deadAtS === undefined) e.deadAtS = simTime;
        entityManager.killEntity(id);
      } else {
        onEntityDamaged(e);
      }
      return true;
    },
    dungeonEntities: () => dungeonManager.dungeonEnemies(),
    // Phase K
    taming: () => ({
      tamed:  { ...tamingRegistry.tamed },
      eggs:   { ...tamingRegistry.eggs },
      babies: { ...tamingRegistry.babies },
    }),
    heatEggFast: (seconds: number) => {
      for (const [eggId, egg] of Object.entries(tamingRegistry.eggs)) {
        if (egg.hatched) continue;
        const updated = heatEgg(egg, seconds, true);
        tamingRegistry.eggs[eggId] = { ...updated, x: egg.x, z: egg.z };
        if (updated.hatched) {
          const species = updated.species as Species;
          const babyEntity = entityManager.spawnEntity(species, egg.x, egg.z);
          babyEntity.owned = true;
          babyEntity.mode = 'follow';
          babyEntity.scaleOverride = 0.45;
          if (needsTaming(species)) {
            tamingRegistry.tamed[babyEntity.id] = createTamedState();
          }
          tamingRegistry.babies[babyEntity.id] = {
            species, ageS: 0, adult: false, x: egg.x, z: egg.z,
          };
          delete tamingRegistry.eggs[eggId];
          rebuildEggDraws();
        }
      }
      saveTamingRegistry(tamingRegistry);
    },
    growFast: (seconds: number) => {
      for (const [babyId, babyData] of Object.entries(tamingRegistry.babies)) {
        if (babyData.adult) continue;
        const updated = growBaby(babyData, seconds);
        tamingRegistry.babies[babyId] = { ...updated, x: babyData.x, z: babyData.z };
        if (updated.adult) {
          const entity = entityManager.entities.get(babyId);
          if (entity) entity.scaleOverride = undefined;
        }
      }
      saveTamingRegistry(tamingRegistry);
    },
    placeEgg: (species: string, dx: number, dz: number) => {
      const eggSpecies = eggSpeciesFor(`egg_${species}`);
      if (eggSpecies === null) return false;
      const px = controller.pos[0] + dx;
      const pz = controller.pos[2] + dz;
      const eggId = `egg_debug_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      tamingRegistry.eggs[eggId] = {
        species: eggSpecies, heatS: 0, hatched: false, x: px, z: pz,
      };
      saveTamingRegistry(tamingRegistry);
      rebuildEggDraws();
      return true;
    },
    mounted: () => mountedEntityId,
    mountStamina: () => {
      if (mountedEntityId === null) return null;
      const me = entityManager.entities.get(mountedEntityId);
      return me?.stamina ?? null;
    },
    mountAltitude: () => {
      if (mountedEntityId === null) return null;
      const me = entityManager.entities.get(mountedEntityId);
      if (!me || me.species !== 'dragon' || !DRAGON_FLIGHT_ENABLED) return null;
      return dragonFlightY;
    },
    injectProjectile: (x: number, y: number, z: number, kind: 'stone' | 'arrow', damage: number) => {
      spawnProjectile(projectilePool, {
        kind, x, y, z, vx: 0, vy: 0, vz: 0, damage, nowS: simTime,
      });
      return inFlightCount(projectilePool);
    },
    npcDrawCost: () => ({ ...npcDrawCost }),
    /**
     * Empty the projectile pool.
     *
     * Arrows stay planted for STUCK_GROUND_S (25 s), so a probe firing a
     * sequence of shots sees the previous ones in `projectiles()` and cannot
     * tell which arrow is the one it just loosed. A tracker that grabbed the
     * first entry read a stale, already-stuck shaft, decided it had "settled"
     * on frame one, and reported a 46 m miss for an arrow that landed 0.21 m
     * from the mark.
     */
    clearProjectiles: () => {
      for (const p of projectilePool.slots) releaseProjectile(p);
    },
    setNpcLod: (on: boolean) => { npcLodEnabled = on; },
    projectileCount: () => inFlightCount(projectilePool),
    stuckProjectileCount: () => activeCount(projectilePool) - inFlightCount(projectilePool),
    /**
     * Draw and loose at the camera's CURRENT orientation.
     *
     * `fireArrow` takes its own yaw/pitch and negates the yaw, which made it
     * useless for checking that the shot agrees with the reticle: the reticle
     * reads the live camera, so the probe has to aim the live camera and then
     * fire without touching it. Existing harnesses keep `fireArrow`.
     */
    looseArrow: (power = 1) => {
      const heldId = equipped(inventory);
      if (heldId !== 'hunter_bow' && heldId !== 'composite_bow') return false;
      if (ammoInHand() === null) return false;
      bowDrawing = true;
      bowDrawT = BOW_DRAW_S * Math.max(0, Math.min(1, power));
      lastBowShotS = -999;             // the probe ignores the fire-rate limit
      releaseBowDraw();
      return true;
    },
    fireArrow: (yawDeg: number, pitchDeg: number, power = 1) => {
      const heldId = equipped(inventory);
      if (heldId !== 'hunter_bow' && heldId !== 'composite_bow') return false;
      if (ammoInHand() === null) return false;
      bowDrawing = true;
      bowDrawT = BOW_DRAW_S * Math.max(0, Math.min(1, power));
      const savedYaw = orbitCam.yaw;
      const savedPitch = orbitCam.pitch;
      orbitCam.yaw = -yawDeg * Math.PI / 180;
      orbitCam.pitch = pitchDeg * Math.PI / 180;
      lastBowShotS = -999; // debug hook ignores the fire-rate limiter
      releaseBowDraw();
      orbitCam.yaw = savedYaw;
      orbitCam.pitch = savedPitch;
      return true;
    },
    /**
     * The full aim solution, so a probe can check the crosshair against the
     * arrow instead of against a screenshot. `launch` is the unit velocity
     * `releaseBowDraw` would use, or null when the point is out of ballistic
     * reach at a full draw.
     */
    aimTarget: () => {
      const aim = resolveAimTarget();
      const eye = orbitCam.eye(camAnchor());
      const dir = orbitCam.forward();
      const muzzle = bowMuzzle();
      return {
        point: aim.point as [number, number, number],
        dist: aim.dist, id: aim.id, name: aim.name, isTarget: aim.isTarget,
        eye: [eye[0], eye[1], eye[2]] as [number, number, number],
        dir: [dir[0], dir[1], dir[2]] as [number, number, number],
        muzzle,
        launch: aimVelocity(muzzle, aim.point, ARROW_SPEED_MAX, PROJECTILE_GRAVITY),
        speed: ARROW_SPEED_MAX,
        // Which quiver a shot fired right now would spend, and whether the
        // reticle currently believes the arc reaches. Existing harnesses read
        // only the fields above; these are additive.
        ammo: ammoInHand(),
        reticleMode: lastAimMode,
        // The live answer, computed by the SAME function the crosshair uses.
        // `reticleMode` is the last thing the reticle actually drew and stalls
        // in headless (no pointer lock, so `updateReticle` early-outs); this
        // one is always current.
        reachable: shotReaches(aim, ammoInHand() ?? 'flint'),
        drawPower: currentDrawPower(),
      };
    },
    /** Force the selected quiver. Returns false for an unknown kind. */
    setAmmo: (kind: string) => {
      if (kind !== 'flint' && kind !== 'tintreach') return false;
      ammoPref = kind;
      return true;
    },
    projectiles: () => projectilePool.slots
      .filter(p => p.active)
      .map(p => ({
        kind: p.kind, team: p.team, stuck: p.stuck,
        x: p.x, y: p.y, z: p.z, dx: p.dx, dy: p.dy, dz: p.dz,
        anchorId: p.anchorId,
      })),
    bowDraw: () => ({ drawing: bowDrawing, t: bowDrawT, aim: bowAimAmount() }),
    freezeBowAim: (a: number | null) => { bowAimOverride = a; },
    /**
     * Hold the string at a given draw, or null to let go without firing.
     *
     * `freezeBowAim` pins the POSE and nothing else; the reticle's reach test
     * reads the real `bowDrawT`, so checking that the crosshair admits an
     * unreachable shot at a tap draw and clears it at a full one needs the
     * actual draw clock. Headless cannot hold a mouse button for 0.55 s
     * reliably enough to measure against.
     */
    bowDrawTo: (power: number | null) => {
      if (power === null) { bowDrawing = false; bowDrawT = 0; return; }
      bowDrawing = true;
      bowDrawT = BOW_DRAW_S * Math.max(0, Math.min(1, power));
    },
    facePlayer: (yawRad: number) => { controller.yaw = yawRad; },
    leftClick: () => { resolveLeftClick(); },
    releaseBow: () => { releaseBowDraw(); },
    // Phase L
    npcs: () => {
      const px = controller.pos[0];
      const pz = controller.pos[2];
      return npcRuntimes
        .filter((rt) => Math.hypot(rt.wx - px, rt.wz - pz) <= 200)
        .map((rt) => ({
          id: rt.npc.id,
          role: rt.npc.role,
          name: rt.npc.name,
          x: rt.wx,
          z: rt.wz,
          hp: rt.hp,
        }));
    },
    /** Damage an NPC through the real combat path (crime/death/persistence). */
    damageNpc: (id: string, dmg: number) => {
      const rt = npcRuntimes.find((r) => r.npc.id === id);
      if (rt === undefined || rt.hp <= 0) return false;
      damageNpcFromMount(rt, dmg);
      return true;
    },
    settlementBlockers: () =>
      settlementManager.nearby().flatMap((s) => buildSettlementSolids(s).blockers),
    giveItem: (id: string, count: number) => {
      addItem(inventory, id as import('./items').GameItemId, count);
      saveInventory(inventory);
    },
    takeItem: (id: string, count: number) => {
      const n = removeItem(inventory, id as import('./items').GameItemId, count);
      saveInventory(inventory);
      invChanged();
      return n;
    },
    countItem: (id: string) => countItem(inventory, id as import('./items').GameItemId),
    // Phase L2 NPC chat hooks
    chatOpen: () => chatState().open,
    lastNpcReply: () => chatState().lastReply,
    // Push-to-talk. Null whenever no chat panel is open, because the voice
    // controller lives and dies with the panel (npc-chat-panel.ts) — which is
    // itself the assertion that voice cannot be recording outside a
    // conversation.
    voiceDebug: () => {
      const v = voiceInput();
      if (!v) return null;
      const t = v.lastTimings;
      return {
        state: v.current,
        awaitingConfirm: v.awaitingConfirm,
        captureMs: t?.captureMs ?? -1,
        transcribeMs: t?.transcribeMs ?? -1,
        encodeMs: t?.encodeMs ?? -1,
      };
    },
    teleportToNearestNpc: () => {
      if (npcRuntimes.length === 0) return false;
      const px = controller.pos[0];
      const pz = controller.pos[2];
      // Find the nearest NPC within 200 m.
      let best: NpcRuntime | null = null;
      let bestD = Infinity;
      for (const rt of npcRuntimes) {
        const d = Math.hypot(rt.wx - px, rt.wz - pz);
        if (d < bestD) { bestD = d; best = rt; }
      }
      if (best === null) return false;
      controller.pos = [best.wx + 1.0, best.wy, best.wz];
      controller.velY = 0;
      return true;
    },
    injectNpcReply: (text: string) => {
      // Find the active chat history element and inject as if the NPC said it.
      const histEl = document.getElementById('npc-chat-history');
      if (histEl === null) return;
      const msg = document.createElement('div');
      msg.className = 'msg assistant';
      msg.textContent = text;
      histEl.appendChild(msg);
      histEl.scrollTop = histEl.scrollHeight;
      // Trigger trade offer pipeline by firing a custom DOM event.
      histEl.dispatchEvent(new CustomEvent('npc-reply', { detail: { text }, bubbles: true }));
    },
    // Phase M — crime / bounty / jail
    bounty: (regionId?: string) => {
      const rid = regionId ?? nearestRegionId();
      return bountyIn(crimeState, rid);
    },
    addBounty: (amount: number, regionId?: string) => {
      const rid = regionId ?? nearestRegionId();
      if (!crimeState.regions[rid]) {
        crimeState.regions[rid] = { bounty: 0, crimes: [] };
      }
      crimeState.regions[rid].bounty += amount;
      saveCrimeState(crimeState);
    },
    jailState: () => {
      if (jailRecord === null) return null;
      return { jailedUntilMs: jailRecord.jailedUntilMs, regionId: jailRecord.regionId };
    },
    teleportToNearestSettlement: (kind?: string) => {
      /**
       * Put the player somewhere sensible for the kind of place it is.
       *
       * `site.x + 5` was fine when a castle was 50 m across; it is now 68 m and
       * that lands the player INSIDE the keep's footprint. They get shoved out
       * sideways by wall sliding, which looks like a bug. Arriving at a castle
       * should mean arriving at its gate — which is also where the road
       * network delivers you, so the two agree.
       *
       * Ground height comes from the CARVED field, so landing on the paved
       * approach puts the player on the stones rather than under them.
       */
      const land = (site: { kind: string; x: number; z: number }): void => {
        const gate = site.kind === 'castle' ? castleGateLocal() : null;
        const x = site.x + (gate !== null ? gate.x : 5);
        const z = site.z + (gate !== null ? gate.z - 6 : 0);
        controller.pos = [x, chunkManager.ground.heightAt(x, z), z];
        controller.velY = 0;
      };
      const nearby = settlementManager.nearby();
      let best: import('./settlement/settlement-layout').ResolvedSettlement | null = null;
      let bestD = Infinity;
      for (const res of nearby) {
        if (kind && res.site.kind !== kind) continue;
        const d = Math.hypot(controller.pos[0] - res.site.x, controller.pos[2] - res.site.z);
        if (d < bestD) { bestD = d; best = res; }
      }
      if (best === null) {
        // Try finding via settlementManager wider scan
        const site = settlementManager.findNearestSite(
          controller.pos[0], controller.pos[2], 6);
        if (site === null) return false;
        if (kind && site.kind !== kind) return false;
        land(site);
        return true;
      }
      land(best.site);
      return true;
    },
    serveFast: (ms: number) => {
      if (jailRecord === null) return;
      jailRecord.jailedUntilMs -= ms;
      saveJailState(jailRecord);
    },
    /** Force-open the arrest panel for the current region (e2e only). */
    openArrestPanel: () => {
      const rid = nearestRegionId();
      const bounty = bountyIn(crimeState, rid);
      if (bounty > 0 && !panels.isOpen) {
        openArrestPanel(rid, bounty);
      }
    },
    /** Force-send player to jail for the current region (e2e only). */
    sendToJail: () => {
      const rid = nearestRegionId();
      const bounty = bountyIn(crimeState, rid);
      if (bounty > 0) sendToJail(rid, bounty);
    },
    torchState: () => ({
      held: equipped(inventory) === 'torch',
      lit: equipped(inventory) === 'torch' && torchFuelS > 0,
      fuelS: torchFuelS,
      burnS: TORCH_BURN_S,
      /** Torches in the selected slot — what will relight. */
      count: heldTorchCount(),
      /** Everything else in the pack — a resupply, not fuel. */
      spare: countItem(inventory, 'torch') - heldTorchCount(),
      flame: lastTorchFlame === null
        ? null
        : [lastTorchFlame[0], lastTorchFlame[1], lastTorchFlame[2]],
    }),
    setTorchFuel: (seconds: number) => { torchFuelS = Math.max(0, seconds); },
    setFirstPerson: (on: boolean | null) => { firstPersonOverride = on; },
    cameraState: () => {
      const a = camAnchor();
      const e = orbitCam.lastEye;
      const f = orbitCam.forward();
      return {
        firstPerson: orbitCam.firstPerson,
        eye: [e[0], e[1], e[2]] as [number, number, number],
        forward: [f[0], f[1], f[2]] as [number, number, number],
        boom: Math.hypot(e[0] - a[0], e[1] - a[1], e[2] - a[2]),
        playerDrawn: player.draw.count > 0,
      };
    },
    worldLights: () => lastWorldLights.map((l) => ({
      pos: [l.pos[0], l.pos[1], l.pos[2]],
      color: [l.color[0], l.color[1], l.color[2]],
      radius: l.radius,
    })),
    tickVitals: (seconds: number) => {
      // Build a minimal neutral env for the forced tick.
      const env: StepEnv = {
        biomeOffset: 0, altitude: controller.pos[1],
        night: false, campfireNear: false, heldTorch: false,
        tentTier: 0 as 0 | 1 | 2 | 3, armorWarmth: 0, swimming: false,
        hot: false, draining: false,
      };
      let remaining = seconds;
      const STEP = 1 / 60;
      while (remaining > 0) {
        const dt = Math.min(STEP, remaining);
        stepVitals(vitals, dt, env);
        remaining -= dt;
      }
    },
    // Generic teleport for e2e tests (pond detection, stable horse, etc.)
    teleport: (x: number, z: number) => {
      controller.pos = [x, heightField.heightAt(x, z) + 1.0, z];
      controller.velY = 0;
    },
    nearFreshWaterDebug: () => nearFreshWater(),
    // --- pause + world map ---
    paused: () => simClock.paused,
    setPaused: (on: boolean) => {
      if (on) openPauseScreen(false);
      else if (panels.openId === 'pause') panels.close();
    },
    simTime: () => simTime,
    lastFrameSteps: () => lastFrameSteps,
    mapStats: () => {
      const b = discovery.bounds();
      return {
        chunks: discovery.chunkCount,
        tiles: discovery.tileCount,
        bytes: discovery.serialize().length,
        x0: b?.x0 ?? 0, z0: b?.z0 ?? 0, x1: b?.x1 ?? 0, z1: b?.z1 ?? 0,
      };
    },
    mapHas: (x: number, z: number) => discovery.has(x, z),
    mapView: () => getMapView(),
    padFocus: () => uiFocus.snapshot(),
    mapProfile: () => getMapProfile(),
    resetMapProfile: () => { resetMapProfile(); },
    mapLandmarks: () => {
      const b = discovery.bounds();
      if (b === null) return [];
      const out: { kind: string; name: string; x: number; z: number }[] = [];
      for (let tz = Math.floor(b.z0 / MAP_TILE); tz <= Math.floor(b.z1 / MAP_TILE); tz++) {
        for (let tx = Math.floor(b.x0 / MAP_TILE); tx <= Math.floor(b.x1 / MAP_TILE); tx++) {
          for (const l of landmarksInCell(WORLD_SEED, tx, tz, heightField.heightAt)) {
            if (discovery.has(l.x, l.z)) {
              out.push({ kind: l.kind, name: l.name, x: l.x, z: l.z });
            }
          }
        }
      }
      if (discovery.has(CASTLE_VHAERON.x, CASTLE_VHAERON.z)) {
        out.push({
          kind: CASTLE_VHAERON.kind, name: CASTLE_VHAERON.name,
          x: CASTLE_VHAERON.x, z: CASTLE_VHAERON.z,
        });
      }
      return out;
    },
    setVelY: (v: number) => {
      controller.velY = v;
      // Force the player into the air so fall-damage detection works.
      controller.grounded = false;
      prevGrounded = false;
    },
    toggleMute: () => {
      audio.muted = !audio.muted;
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(AUDIO_MUTE_KEY, audio.muted ? 'true' : 'false');
        }
      } catch { /* quota */ }
    },
    audioMuted: () => audio.muted,
    voiceProbe: (text: string) => voiceOut.probe(text),
    voiceReady: () => voiceOut.ready,
    settings: () => Object.assign(
      {},
      settings.get(),
      { set: (p: Partial<GameSettings>) => settings.set(p), reset: () => settings.reset() },
    ),
    nearestNpcOwnedHorse: (x: number, z: number, radius = 50) => {
      let best: import('./entities/entity-manager').EntityState | null = null;
      let bestD = radius;
      for (const e of entityManager.entities.values()) {
        if (!e.npcOwned) continue;
        if (e.species !== 'horse') continue;
        const d = Math.hypot(e.x - x, e.z - z);
        if (d < bestD) { bestD = d; best = e; }
      }
      return best;
    },
    entityFlags: (id: string) => {
      const e = entityManager.entities.get(id);
      if (e === undefined) return null;
      return { npcOwned: e.npcOwned === true, owned: e.owned === true };
    },
    stallPads: () => {
      const out: { wx: number; wz: number }[] = [];
      for (const resolved of settlementManager.nearby()) {
        for (const pad of resolved.pads) {
          if (pad.type === 'stall') out.push({ wx: pad.wx, wz: pad.wz });
        }
      }
      return out;
    },
    wellPads: () => {
      const out: { wx: number; wz: number }[] = [];
      for (const resolved of settlementManager.nearby()) {
        for (const pad of resolved.pads) {
          if (pad.type === 'well') out.push({ wx: pad.wx, wz: pad.wz });
        }
      }
      return out;
    },
    npcGold: (npcKey?: string) => {
      if (npcKey !== undefined) {
        return npcGoldFromMap(npcStockMap, npcKey);
      }
      // Fall back to the active chat NPC's key.
      const key = chatState().activeStockKey;
      if (key === null) return 0;
      return npcGoldFromMap(npcStockMap, key);
    },
    // Phase 60 debug hooks
    nearestNest: () => {
      const px = controller.pos[0];
      const pz = controller.pos[2];
      let best: NestSite | null = null;
      let bestD = Infinity;
      for (const site of streamedNests) {
        const d = Math.hypot(site.x - px, site.z - pz);
        if (d < bestD) { bestD = d; best = site; }
      }
      return best;
    },
    lootedNestIds: () => [...lootedNests],
    equipArmorById: (id: string) => {
      if (!isGameItemId(id)) return false;
      // Find the item in pack or hotbar and equip it.
      for (let i = 0; i < inventory.pack.length; i++) {
        const s = inventory.pack[i];
        if (s !== null && s.id === id) {
          const ok = equipArmor(inventory, { area: 'pack', index: i });
          if (ok) { invChanged(); return true; }
        }
      }
      for (let i = 0; i < inventory.hotbar.length; i++) {
        const s = inventory.hotbar[i];
        if (s !== null && s.id === id) {
          const ok = equipArmor(inventory, { area: 'hotbar', index: i });
          if (ok) { invChanged(); return true; }
        }
      }
      return false;
    },
    activeEffects: () => [...effectsState.effects],
    applyEffect: (itemId: string) => {
      applyItemEffects(effectsState, itemId, ITEM_DEFS);
      saveEffectsState(effectsState);
    },
    characterOptions: () => {
      function tier(id: string | undefined): string | undefined {
        if (!id) return undefined;
        if (id.startsWith('fiber_'))   return 'fiber';
        if (id.startsWith('leather_')) return 'leather';
        if (id.startsWith('iron_'))    return 'iron';
        return undefined;
      }
      return {
        body: custom.body ?? 'male',
        armor: {
          head: tier(inventory.armor.head?.id),
          body: tier(inventory.armor.body?.id),
          legs: tier(inventory.armor.legs?.id),
        },
      };
    },
    totalDefense: () => totalDefense(inventory),
    // Building interiors
    enterNearestBuilding: () => buildingManager.debugEnterNearest(settlementManager.nearby()),
    insideBuilding: () => buildingManager.isInside,
    buildingTeleportToExit: () => buildingManager.debugTeleportToExit(),
    buildingTeleportToChest: () => buildingManager.debugTeleportToChest(),
    buildingTeleportToBed: () => buildingManager.debugTeleportToBed(),

    // --- Castle Vhaeron ---
    /**
     * The mounted breath, as geometry.
     *
     * "The breath does no damage" is not a bug report until it is a
     * measurement, and from inside the game the weapon looked perfect — full
     * jet, stamina draining, jaw open. This returns the aim ray and, for every
     * entity in range, the axial and perpendicular distances that decide the
     * hit, so the reason a target is missed is a number rather than a theory.
     */
    breathProbe: () => {
      const ray = getBreathRay();
      if (ray === null) return null;
      const mounted = mountedEntityId === null
        ? undefined : entityManager.entities.get(mountedEntityId);
      if (mounted === undefined) return null;
      const spec = BREATH_SPEC[mounted.species];
      if (spec === undefined) return null;
      const r3 = (n: number): number => Math.round(n * 100) / 100;
      const targets: Record<string, unknown>[] = [];
      for (const e of entityManager.entities.values()) {
        if (e.id === mountedEntityId || e.mode === 'dead') continue;
        const def = SPECIES_DEFS[e.species];
        const h = breathHit(ray.mouth, ray.dir, e.x, e.y + def.size * 0.5, e.z,
          spec.reach);
        if (h.dist > BREATH_RANGE * spec.reach + 6) continue;
        targets.push({
          id: e.id, species: e.species, hp: e.hp, hit: h.hit,
          dist: r3(h.dist), axial: r3(h.axial), perp: r3(h.perp),
          radius: r3(h.radius), angleDeg: r3(h.angleDeg),
        });
      }
      targets.sort((a, b) => (a.dist as number) - (b.dist as number));
      return {
        species: mounted.species,
        active: breathActive,
        jaw: r3(breathJaw),
        reach: spec.reach,
        mouth: ray.mouth.map(r3),
        dir: ray.dir.map(r3),
        targets,
      };
    },
    castle: () => castleManager.debugInfo(),
    castleMarkers: () => [...castleManager.layout.markers.keys()].sort(),
    castleMarkerPos: (marker) => castleManager.markerWorld(marker),
    castleTeleport: (marker) => {
      const p = castleManager.markerWorld(marker);
      if (p === null) return false;
      dungeonManager.forceExit();
      buildingManager.forceExit();
      // Land ON the floor of the target, not at the marker's nominal height:
      // markers sit at floor level, and arriving a hair low would have the
      // rescue clause in `groundHeight` haul the player to the storey below.
      controller.pos = [p[0], p[1] + 0.4, p[2]];
      controller.velY = 0;
      return true;
    },
    castleRespawnAtStart: () => {
      dungeonManager.forceExit();
      buildingManager.forceExit();
      controller.pos = [...castleManager.spawnPoint()] as [number, number, number];
      controller.velY = 0;
    },
    castleOpenChest: () => castleManager.tryInteract(),
    /**
     * True when a box of radius `r` spanning [y0, y1] is inside castle
     * masonry — the exact test the flying-mount collider uses.
     *
     * Exposed so `scripts/flight-collision-check.mjs` can judge "did the
     * dragon end up inside the keep" against the castle's own solid volumes
     * instead of by eye or against the raw heightfield, which knows nothing
     * about the building at all.
     */
    castleSolidAt: (x: number, z: number, r: number, y0: number, y1: number) =>
      castleManager.collider.inFootprint(x, z)
      && castleManager.collider.flierBlocked(x, z, r, y0, y1),
    settlementSolidAt: (x: number, z: number, r: number, y0: number) =>
      terrainWorld.flierBlocked(x, z, r, y0),
    settlementSupportAt: (x: number, z: number, r: number, y: number, reach = 0.5) =>
      terrainWorld.flierSupport(x, z, r, y, reach),
    /**
     * Force the castle's alarm phase.
     *
     * The only in-game route to `hunting` is looting the chest, which also
     * teleports the player, wakes the garrison and starts a fight — far too
     * much scenery for a probe that wants to measure one thing about the
     * dragon. `stepCastleState` still owns every other transition.
     */
    castleSetAlarm: (alarm: 'dormant' | 'departed' | 'hunting') => {
      castleManager.state.alarm = alarm;
      castleManager.state.changedAt = simTime;
      return alarm;
    },
    /** Where the boss is, where it is trying to be, and whether it broke off. */
    bossState: () => {
      const f = castleManager.fight;
      const e = kingDragonId === null
        ? undefined : entityManager.entities.get(kingDragonId);
      return {
        phase: f.phase, returning: f.returning, seeded: f.seeded,
        x: f.bx, y: f.by, z: f.bz,
        speed: Math.hypot(f.vx, f.vy, f.vz),
        entity: e === undefined ? null : { x: e.x, y: e.y, z: e.z, hp: e.hp },
      };
    },
    castleAlarmStep: (action) => {
      const c = castleManager.centre;
      // Teleport rather than poke the state: the point of the hook is to prove
      // the real distance test fires, not to set the field the test sets.
      const d = action === 'depart' ? LEAVE_RADIUS + 40 : RETURN_RADIUS - 30;
      const x = c[0] + d;
      const z = c[2];
      controller.pos = [x, chunkManager.ground.heightAt(x, z) + 0.5, z];
      controller.velY = 0;
      castleManager.update(controller.pos, simTime, false);
      return castleManager.state.alarm;
    },
    /** Last frame's creature-mesh rebuild accounting, against the budget of 8. */
    entityFrameCost: () => ({ ...entityRenderer.lastFrameCost, budget: 8 }),
    /**
     * Put an entity exactly where you want it, including in the air.
     *
     * `spawnEntity` snaps y to the terrain, so there was no way for a probe to
     * place a flier overhead — `scripts/mount-air-check.mjs` was calling this
     * hook optionally, finding it absent, and silently skipping the
     * overhead-reach test while still printing a verdict about it.
     */
    setEntityPos: (id: string, x: number, y: number, z: number) => {
      const e = entityManager.entities.get(id);
      if (e === undefined) return false;
      e.x = x; e.y = y; e.z = z;
      e.homeX = x; e.homeZ = z;
      return true;
    },
    castleGarrison: () => {
      const out: Record<string, unknown>[] = [];
      for (const p of castleManager.garrison) {
        const e = entityManager.entities.get(p.id);
        // LIVE position when it exists, the post only as a fallback.
        //
        // This reported the post every time at first, which is correct exactly
        // until the alarm goes up and they start walking. A harness aiming at
        // these numbers then swings at where the goblins were standing before
        // they charged — and reports that garrison members cannot be killed
        // while the player's own health falls by twelve.
        const r1 = (n: number): number => Math.round(n * 10) / 10;
        out.push({
          id: p.id, species: p.species, station: p.station,
          x: r1(e?.x ?? p.x),
          y: r1(e?.y ?? p.y),
          z: r1(e?.z ?? p.z),
          postX: r1(p.x), postY: r1(p.y), postZ: r1(p.z),
          live: e !== undefined,
          mode: e?.mode ?? null,
          hp: e?.hp ?? null,
          dead: castleManager.garrisonDead.has(p.id),
        });
      }
      return out;
    },
    castleFight: () => {
      const f = castleManager.fight;
      const d = kingDragonId === null
        ? undefined : entityManager.entities.get(kingDragonId);
      const k = evilKingId === null
        ? undefined : entityManager.entities.get(evilKingId);
      const since = simTime - f.breathAt;
      return {
        phase: f.phase,
        alarm: castleManager.state.alarm,
        breath: since >= 0 && since < BREATH_TELL_S ? 'tell'
          : since >= BREATH_TELL_S && since < BREATH_TELL_S + BREATH_S ? 'burning'
            : 'none',
        swooping: f.swoopAt >= 0,
        aim: [f.aimX, f.aimY, f.aimZ].map((n) => Math.round(n * 10) / 10),
        dragonHp: d?.hp ?? null,
        dragonMaxHp: SPECIES_DEFS.black_dragon.hp,
        dragonMode: d?.mode ?? null,
        kingHp: k?.hp ?? null,
        kingMode: k?.mode ?? null,
        kingMounted: kingIsMounted(),
        playerHp: vitals.hp,
        // The last cone test, and the running count of ticks that landed.
        // Without these "the breath does nothing" is a theory; with them it is
        // an axial distance and a radius that say which part is wrong.
        breathHits: bossBreathHits,
        breathGeom: bossBreathLast === null ? null : {
          hit: bossBreathLast.hit,
          dist: Math.round(bossBreathLast.dist * 10) / 10,
          axial: Math.round(bossBreathLast.axial * 10) / 10,
          perp: Math.round(bossBreathLast.perp * 10) / 10,
          radius: Math.round(bossBreathLast.radius * 10) / 10,
          range: Math.round(BREATH_RANGE * 1.4 * 10) / 10,
        },
      };
    },
    /**
     * Hurt the two bosses directly, so a harness can drive the fight through
     * its phases without simulating three minutes of swordplay.
     *
     * Deliberately routed through the same `damageEntityFromMount` the player's
     * own attacks use, so the death path, the kill notice and the registry are
     * the real ones — a hook that set `hp` directly would prove nothing about
     * what happens when the dragon actually dies.
     */
    castleDamageBoss: (which, amount) => {
      const id = which === 'king' ? evilKingId : kingDragonId;
      if (id === null) return null;
      const e = entityManager.entities.get(id);
      if (e === undefined) return null;
      damageEntityFromMount(e, amount);
      return e.hp;
    },
    castleKing: () => {
      if (evilKingId === null) return null;
      const e = entityManager.entities.get(evilKingId);
      if (e === undefined) return null;
      return {
        id: e.id,
        x: Math.round(e.x * 100) / 100,
        y: Math.round(e.y * 100) / 100,
        z: Math.round(e.z * 100) / 100,
        yaw: Math.round(e.yaw * 100) / 100,
        mode: e.mode,
      };
    },
    castleDragon: () => {
      if (kingDragonId === null) return null;
      const e = entityManager.entities.get(kingDragonId);
      if (e === undefined) return null;
      return {
        id: e.id,
        x: Math.round(e.x * 10) / 10,
        y: Math.round(e.y * 10) / 10,
        z: Math.round(e.z * 10) / 10,
        yaw: Math.round(e.yaw * 100) / 100,
        mode: e.mode,
      };
    },
  };

  // The whole debug surface, published or withheld in one place. Roughly a
  // third of the methods above are outright cheats reachable from a devtools
  // console (`giveItem`, `teleport`, `setVitals`, `castleDamageBoss`, …), so a
  // shipped build must not carry them. In the default build STEAM_RELEASE is
  // false and every harness keeps working unchanged; in a release build the
  // object is still constructed but never published, so `window.__gameDebug`
  // is undefined and there is no console route to any of it.
  if (!STEAM_RELEASE) window.__gameDebug = gameDebug;

  /**
   * `?spawn=<species>[&count=N]` — put creatures in front of the player.
   *
   * The console route (`__gameDebug.spawnEntity(...)`) works but is awkward in
   * practice: the game holds pointer lock, so reaching devtools means breaking
   * out of the game first, and calling it before `__gameReady` silently does
   * nothing. It also takes a raw dx/dz in world axes, so "10 metres away" lands
   * wherever north happens to be rather than in front of the camera.
   *
   * Called ONCE from the frame loop at the moment the game declares itself
   * ready — not at module scope. The first version ran inline here and crashed
   * boot outright with a temporal-dead-zone error, because `setGatherNotice`
   * writes to a HUD element declared further down the file. Anything that
   * touches the HUD has to wait until the HUD exists.
   */
  function debugSpawnFromUrl(): void {
    const params = debugParams();
    const want = params.get('spawn');
    if (want === null) return;
    if (!(want in SPECIES_DEFS)) {
      setGatherNotice(`Unknown species "${want}" — try: ${
        Object.keys(SPECIES_DEFS).join(', ')}`);
      return;
    }
    const sp = want as Species;
    const count = Math.min(8, Math.max(1, Number(params.get('count') ?? '1') || 1));
    // Ahead of where the camera is looking, fanned out a little so a group
    // does not stack into a single silhouette.
    const dist = 6 + SPECIES_DEFS[sp].size * 2.2;
    let spawned = 0;
    for (let i = 0; i < count; i++) {
      const spread = (i - (count - 1) / 2) * 3.5;
      const yaw = orbitCam.yaw;
      const dx = -Math.sin(yaw) * dist + Math.cos(yaw) * spread;
      const dz = -Math.cos(yaw) * dist - Math.sin(yaw) * spread;
      if (entityManager.spawnEntity(
        sp, controller.pos[0] + dx, controller.pos[2] + dz) !== null) spawned++;
    }
    setGatherNotice(spawned > 0
      ? `Spawned ${spawned}x ${SPECIES_DEFS[sp].name} in front of you`
      : `Could not spawn ${want} here — try flatter ground away from water`);
  }


  // --- ?dungeon=preview: fly around fixture 0's interior (M2 debug) --------
  // No collision/portals yet — fly cam only, dark fog, bright-ambient shader
  // fallback (zeroed lights buffer → count 0).
  const dungeonPreview = debugParams().get('dungeon') === 'preview';
  let dungeonDraws: DungeonDraw[] = [];
  if (dungeonPreview) {
    const layout = layoutDungeon(DUNGEON_FIXTURES[0], WORLD_SEED);
    const verts = buildInteriorMesh(layout);
    const vertexBuffer = renderer.device.createBuffer({
      label: 'dungeon-preview-mesh',
      size: verts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    renderer.device.queue.writeBuffer(vertexBuffer, 0, verts);
    const { bindGroup, shadowBindGroup } =
      renderer.createObjectBindGroup(0, -300, 0, 0);
    const lightsBuffer = renderer.device.createBuffer({
      label: 'dungeon-preview-lights',
      size: LIGHTS_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    dungeonDraws = [{
      draw: { vertexBuffer, indexBuffer: null, count: verts.length / (STRIDE_PROP / 4), bindGroup, shadowBindGroup },
      lightsBindGroup: renderer.createLightsBindGroup(lightsBuffer),
    }];
    flyMode = true;
    flyCam.pos = [
      layout.spawnCell[0] + 0.5,
      -300 + PLAYER_HEIGHT,
      layout.spawnCell[1] + 0.5,
    ];
  }

  // One-at-a-time DOM panels (character now; inventory/crafting later).
  // While a panel is open the overlay stays hidden despite the lost lock.
  const panels = new PanelManager(canvas, (open: boolean) => {
    overlay.classList.toggle(
      'hidden', document.pointerLockElement === canvas || panels.isOpen);
    // The pause screen is the ONE panel that stops the world. Inventory,
    // crafting, the character sheet and NPC chat deliberately do not: the
    // player opens those constantly mid-play and freezing the world under
    // every one of them would change how the game is played, which is not
    // what was asked for. Escape is the pause.
    simClock.setPaused(panels.openId === 'pause', performance.now());
    // Hard pause silences the villager. PanelManager allows one panel at a
    // time, so opening the pause screen has already closed the conversation —
    // carrying its audio over the map would be sound from a screen that is
    // gone, and the voice slider on that very screen would be unjudgeable with
    // someone mid-sentence. VoiceOut.stop() fades over 80 ms so it does not
    // click. Speech deliberately KEEPS playing while the chat panel is open;
    // that is the whole feature.
    if (panels.openId === 'pause') voiceOut.stop();
    if (!open) {
      // If the NPC chat panel was just closed, reset its state.
      onNpcChatClosed();
      // …and if it was the arrest panel, un-latch its re-entry guard. Escape
      // has always closed that panel straight through PanelManager, bypassing
      // `closeArrest()` and leaving this flag stuck true — after which
      // `openArrestPanel`'s first line refused to ever open it again and the
      // player was permanently un-arrestable. B closes panels now too, so a
      // latent bug on one key became a reachable one on two.
      arrestPanelOpen = false;
    }
  });

  /**
   * Escape: stop the world and unroll the map.
   *
   * `fromLockLoss` means the browser ate the Escape to release the pointer
   * lock, so the player never got a keydown to us — see ui/pointer-lock.ts.
   * In that case we know they were locked, and closing must re-lock.
   */
  function openPauseScreen(fromLockLoss: boolean): void {
    if (panels.openId === 'pause') return;
    audio.play('ui_click');
    panels.toggle('pause', () => buildMapPanel({
      seed: WORLD_SEED,
      // The BASE height field, matching what the scatters placed against.
      height: heightField,
      biome: biomeField,
      roads: chunkManager.roads,
      discovery,
      player: () => {
        const site = settlementManager.nearestSettlement();
        return {
          x: controller.pos[0],
          z: controller.pos[2],
          yaw: controller.yaw,
          indoors: dungeonManager.isInside || buildingManager.isInside,
          place: site !== null ? site.name : null,
        };
      },
      menu: pauseMenuOptions(),
      onResume: () => panels.close(),
    }), fromLockLoss);
  }

  /** Save / Load / New Game, as the pause screen's right-hand rail. */
  function pauseMenuOptions(): GameMenuOptions {
    return {
      slots: listSlots(),
      canSave: !dungeonManager.isInside && !buildingManager.isInside,
      activeSlot: activeSlot(),
      onDelete: (slot) => {
        // deleteSlot refuses the active slot and says so; the button for it is
        // disabled too, so this only fires if something got round the UI.
        if (!deleteSlot(slot)) {
          setGatherNotice('That is the save you are playing — load another first.');
        } else {
          setGatherNotice(`Slot ${slot + 1} deleted.`);
        }
        return listSlots();
      },
      onSave: (slot) => {
        // Flush the map before the snapshot: the fog is written on a 4 s
        // throttle, so without this a save taken right after exploring
        // somewhere new records the world as it was before the walk.
        saveDiscovery(discovery);
        discoveryDirty = false;
        const ok = saveToSlot(slot, {
          x: controller.pos[0], y: controller.pos[1], z: controller.pos[2],
          simTime,
        });
        panels.close();
        setGatherNotice(ok ? `Game saved to slot ${slot + 1}.` : 'Save failed (storage full?).');
      },
      onLoad: (slot) => {
        if (loadSlot(slot)) location.reload();
      },
      onNew: () => {
        newGame();
        location.reload();
      },
    };
  }

  // Always-visible hotbar; any model change persists + re-renders.
  const invChanged = () => {
    saveInventory(inventory);
    hotbar.refresh();
  };
  const hotbar = new Hotbar(inventory, invChanged);

  overlay.addEventListener('click', () => canvas.requestPointerLock());
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    overlay.classList.toggle('hidden', locked || panels.isOpen);
    const deliberate = consumeOwnRelease();
    // Losing a lock we did not give up IS the player pressing Escape — the
    // browser consumed that keydown to exit the lock, which is why pausing
    // used to take two presses. An alt-tab lands here too, and pausing on it
    // is exactly right.
    if (!locked && !deliberate && !panels.isOpen && window.__gameReady === true
        && !isDead) {
      openPauseScreen(true);
    }
  });
  // Backstop for the case the pointer lock was never held (the player is
  // reading a panel, or the harness never clicked the overlay): a hidden tab
  // gets no RAF, and un-hiding would otherwise dump MAX_ACCUM's worth of
  // catch-up steps into one frame.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && window.__gameReady === true
        && !panels.isOpen && !isDead) {
      openPauseScreen(document.pointerLockElement === canvas);
    }
  });
  window.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    if (flyMode) flyCam.onMouseMove(e.movementX, e.movementY);
    else orbitCam.onMouseMove(e.movementX, e.movementY);
  });
  window.addEventListener('wheel', (e) => {
    if (!flyMode) orbitCam.onWheel(e.deltaY);
  });
  window.addEventListener('keydown', (e) => {
    // Typing in a text field (NPC chat input) must not trigger game hotkeys.
    const t = e.target;
    if (t instanceof HTMLElement &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      return;
    }
    // Same collision as Q: C is a descend key on a flying mount, and opening
    // the character sheet mid-flight is not what the player asked for.
    if (e.code === 'KeyC' && !flyMode && !mountedOnFlier()) {
      audio.play('ui_click');
      panels.toggle('character', () => buildCharacterPanel(
        () => custom,
        (c) => { custom = c; saveCustomization(c); }));
      return;
    }
    // Tab CYCLES TARGETS while a lock is held, and only opens the pack
    // otherwise.
    //
    // Overloading it is deliberate. Tab is the binding a player reaches for to
    // cycle a target because every game with Z-targeting uses it, and the pack
    // has a second, unambiguous binding (I) that is unaffected. The overload is
    // strictly additive: with no lock, Tab does exactly what it always did, and
    // `test-gamepad`/`controller-ui-check` drive the pack through KeyI and pad
    // Y, neither of which routes through here.
    if (e.code === 'Tab' && lockOnId !== null && !flyMode && !panels.isOpen) {
      e.preventDefault();
      cycleLock(e.shiftKey ? -1 : 1);
      return;
    }
    if ((e.code === 'Tab' || e.code === 'KeyI') && !flyMode) {
      e.preventDefault();
      audio.play('ui_click');
      panels.toggle('inventory', () => buildInventoryPanel(inventory, invChanged));
      return;
    }
    // Z-targeting. Z for "Z-targeting" — the name the gesture already has, and
    // one of the few letters this keyboard layout had left.
    if (e.code === 'KeyZ' && !flyMode && !panels.isOpen) {
      e.preventDefault();
      toggleLock();
      return;
    }
    if (e.code === 'KeyB' && !flyMode) {
      // Build live station context from fire registry and player position.
      const buildCraftCtx = () => ({
        nearCampfire: nearCampfireOrForge(fires, controller.pos[0], controller.pos[2], simTime),
        nearForge: nearForgeCheck(fires, controller.pos[0], controller.pos[2], simTime),
        hasCookingPot: countItem(inventory, 'cooking_pot') > 0,
      });
      panels.toggle('crafting', () => {
        // Wrap invChanged to also play craft SFX (Feature 10).
        let craftPanelOpenMs = performance.now();
        const invChangedWithCraft = () => {
          // If called >50ms after panel open, it's a craft action (not initial render).
          if (performance.now() - craftPanelOpenMs > 50) audio.play('craft');
          invChanged();
        };
        craftPanelOpenMs = performance.now();
        return buildCraftingPanel(inventory, invChangedWithCraft, buildCraftCtx());
      });
      audio.play('ui_click');
      return;
    }
    // Feature 7: H — help panel.
    if (e.code === 'KeyH') {
      audio.play('ui_click');
      // One binding table, one place. This used to be ~95 lines of inline rows
      // that were the ONLY documentation of the pad bindings and had quietly gone
      // stale — no V push-to-talk, no 1-5 hotbar, no map keys. `controls-panel.ts`
      // is now the single source and the pause screen's Controls sheet renders the
      // same table, so the two cannot drift again.
      panels.toggle('help', buildControlsPanel);
      return;
    }
    // Feature 10: M — toggle audio mute.
    if (e.code === 'KeyM') {
      audio.muted = !audio.muted;
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(AUDIO_MUTE_KEY, audio.muted ? 'true' : 'false');
        }
      } catch { /* quota */ }
      setGatherNotice(audio.muted ? 'Audio muted (M to unmute)' : 'Audio unmuted');
      return;
    }
    if (e.code === 'Escape') {
      // While pointer-locked the browser consumes this keydown to release the
      // lock, so the press that actually opens the pause screen arrives at the
      // pointerlockchange handler instead. This path covers the rest: closing
      // a panel, and pausing when the lock was never taken.
      if (panels.isOpen) panels.close();
      else openPauseScreen(false);
      return;
    }
    // Live debug capture works even with a panel open (UI glitches too).
    if (e.code === 'F8') {
      e.preventDefault();
      capture.request();
      setGatherNotice('Snapshot saved (F8)');
      return;
    }
    if (e.code === 'F9') {
      e.preventDefault();
      setGatherNotice(capture.toggleAuto()
        ? 'Auto-capture ON (every 2 s, F9 to stop)' : 'Auto-capture OFF');
      return;
    }
    if (panels.isOpen) return; // game keybinds stay quiet under a panel
    if (e.code === 'KeyR') {
      flyMode = !flyMode;
      if (flyMode) flyCam.pos = orbitCam.eye(add(controller.pos, [0, PLAYER_HEIGHT, 0]));
    }
    // X — swap quivers. Bound only while a bow is in hand so the key is free
    // for anything else later, and so a stray press does nothing surprising.
    if (e.code === 'KeyX' && bowEquipped()) {
      toggleAmmo();
      return;
    }
    // T — tell the animal to stay or to follow. Unconditional, because the
    // right button that used to do this belongs to the shield the moment the
    // player crafts one (see the RMB handler), and a command that vanishes
    // when you pick up a piece of gear is a command that reads as broken.
    if (e.code === 'KeyT') {
      togglePetStay();
      return;
    }
    // P drops the held item — one, or the whole stack with Shift.
    //
    // A full pack is otherwise a dead end: crafting needs a free slot for its
    // output, so once all 33 slots are occupied the player can neither craft
    // nor make room.
    //
    // This was Q, which is also descend in fly mode and on a flying mount, so
    // a rider losing altitude threw their sword away at the same time. The fix
    // then was to suppress dropping whenever either of those was true — which
    // meant you could not drop anything at all from dragonback. P has no other
    // job, so the collision and the suppression are both gone: drop works
    // everywhere now, including in flight.
    if (e.code === 'KeyP') {
      const dropped = dropSlot(
        inventory, { area: 'hotbar', index: inventory.selected }, e.shiftKey);
      if (dropped !== null) {
        setGatherNotice(`Dropped: ${dropped.count}× ${itemDef(dropped.id).name}`);
        audio.play('pickup');
        invChanged();
      } else {
        setGatherNotice('Nothing in hand to drop');
      }
    }
    if (e.code === 'KeyE') {
      // Phase M: jail escape check first
      if (jailRecord !== null && tryJailEscape()) {
        // escape handled
      } else if (dungeonManager.interactPrompt !== null) {
        dungeonManager.tryInteract();
      } else if (!dungeonManager.isInside && !buildingManager.isInside
        && castleManager.interactPrompt !== null) {
        // The escape chest. Ranked above buildings and settlements because the
        // castle is the only place it exists, and below dungeons because the
        // two are never both in range.
        castleManager.tryInteract();
      } else if (buildingManager.interactPrompt !== null && !npcBeatsBuilding()) {
        buildingManager.tryInteract();
      } else if (!dungeonManager.isInside && !buildingManager.isInside && settlementManager.interactPrompt !== null) {
        settlementManager.tryInteract();
      } else if (mountedEntityId !== null) {
        // Phase K: E while mounted → dismount.
        doDisMount();
      } else if (!dungeonManager.isInside && !buildingManager.isInside && tryLootNest()) {
        // Phase 60: loot egg nest.
      } else if (!dungeonManager.isInside && !buildingManager.isInside && tryLootDeadAnimal()) {
        // Loot handled inside.
      } else if (!dungeonManager.isInside && !buildingManager.isInside && tryMount()) {
        // Phase K: E on live mountable → mount (or buck/accept-ride for rares).
      } else if (!dungeonManager.isInside && nearestNpc() !== null) {
        // Phase L2: E near an NPC → open NPC chat panel.
        // Deliberately NOT gated on being outdoors any more: the whole point of
        // NPCs having interiors is that you can walk into a tavern and talk to
        // the keeper. `nearestNpc` already excludes anyone shut in a building
        // the player is not standing in.
        // Prevent the "e" from being typed into the auto-focused chat input.
        e.preventDefault();
        openNpcChatFor(nearestNpc()!);
      } else if (!dungeonManager.isInside && !buildingManager.isInside && tryStallInteract(e)) {
        // Market stall: opens the attending merchant's chat (or a notice).
      } else if (tryDrinkWell()) {
        // Drink from a settlement well. Ranked directly above the river so a
        // well standing on a riverbank still reads as a well, and below the
        // stall/NPC cases so nobody loses a conversation to a bucket.
      } else if (!dungeonManager.isInside && !buildingManager.isInside && nearFreshWater()) {
        // Drink from river.
        drinkPlayer(vitals, 40);
        audio.play('eat_drink'); // Feature 10: drink SFX
        saveVitals(vitals);
      } else if (!dungeonManager.isInside && !buildingManager.isInside) {
        // E near a lit campfire with 8 stone → upgrade to forge.
        const fire = nearestFire(fires, controller.pos[0], controller.pos[2], GATHER_REACH);
        if (fire !== null && fire.kind === 'campfire' && isLit(fire, simTime)) {
          if (countItem(inventory, 'stone') >= 8) {
            removeItem(inventory, 'stone', 8);
            invChanged();
            upgradeToForge(fire, simTime);
            saveFires(fires);
            rebuildFireDraws(simTime);
            setGatherNotice('Campfire upgraded to Forge!');
          } else {
            setGatherNotice('Need 8 stone to upgrade to Forge.');
          }
        } else {
          // Eat/drink held item (no world interactable in range).
          tryConsumeHeldItem();
        }
      } else {
        // Eat/drink held item (no world interactable in range).
        tryConsumeHeldItem();
      }
    }
    if (e.code.startsWith('Digit')) {
      const n = Number(e.code.slice(5)) - 1; // Digit1 → hotbar 0
      if (n >= 0 && n < inventory.hotbar.length) hotbar.select(n);
    }
  });
  // --- gathering (E-M2): 3 swings on a node with the right tool ------------
  const GATHER_REACH = 2.5; // m, XZ
  const GATHER_HITS = 3;
  const gatherHits = new Map<string, number>();
  let gatherNotice: { text: string; until: number } | null = null;
  let gatheredCount = 0;

  function setGatherNotice(text: string): void {
    gatherNotice = { text, until: performance.now() + 4000 };
  }

  /** True when the player is near drinkable fresh water (river OR inland pond/lake). */
  function nearFreshWater(): boolean {
    const DRINK_RADIUS = 2.5;
    const px = controller.pos[0];
    const pz = controller.pos[2];
    // Reject coast/ocean: if the player's own biome is ocean or beach the
    // water around them is salt water and not drinkable.
    const playerBiome = biomeField.biomeAt(px, pz);
    if (playerBiome === 'ocean' || playerBiome === 'beach') return false;
    // A settlement footprint is never a water source. Siting rejects any site
    // whose footprint crosses a river (settlement-scatter.ts), so a river that
    // still reads as present here is one a town has been built over — and it is
    // drawn nowhere, because the world renders water only below sea level and
    // that same siting test keeps every footprint above it. Offering a drink
    // from it is the Greenholm bug: drinking in the middle of a market square.
    // The well is the in-town source, and it already outranks this.
    for (const s of settlementManager.nearby()) {
      if (Math.hypot(px - s.site.x, pz - s.site.z) <= s.site.radius) return false;
    }
    // Sample a few points within the radius (cardinal + self).
    const offsets: [number, number][] = [
      [0, 0], [DRINK_RADIUS, 0], [-DRINK_RADIUS, 0],
      [0, DRINK_RADIUS], [0, -DRINK_RADIUS],
    ];
    for (const [ox, oz] of offsets) {
      const sx = px + ox;
      const sz = pz + oz;
      // River check (existing).
      if (heightField.riverFactor(sx, sz) > 0) return true;
      // Inland pond/lake: a nearby sample is below sea level (the pond surface).
      if (heightField.heightAt(sx, sz) < 0 /* SEA_LEVEL */) return true;
    }
    return false;
  }

  /** Consume the selected hotbar item if edible or drinkable (non-container). */
  function tryConsumeHeldItem(): void {
    const heldId2 = equipped(inventory);
    if (heldId2 === null) return;
    const def2 = itemDef(heldId2);
    let consumed = false;
    if (def2.edible) {
      healPlayer(vitals, def2.edible.heal);
      consumed = true;
    }
    if (def2.drinkable && def2.kind !== 'container') {
      drinkPlayer(vitals, def2.drinkable.quench);
      consumed = true;
    }
    if (consumed) {
      // Phase N: apply timed effects for potions / dishes.
      const extraHeal = applyItemEffects(effectsState, heldId2, ITEM_DEFS);
      if (extraHeal > 0) healPlayer(vitals, extraHeal);
      saveEffectsState(effectsState);
      // Remove 1 from the selected hotbar slot.
      const slot = inventory.hotbar[inventory.selected];
      if (slot !== null) {
        slot.count -= 1;
        if (slot.count <= 0) inventory.hotbar[inventory.selected] = null;
        invChanged();
      }
      saveVitals(vitals);
    }
  }

  const LOOT_REACH = 3.0; // m (Phase J: loot dead animal range)

  /** Last interaction line handed to the HUD — read by the indoor-NPC harness. */
  let lastInteractPrompt: string | null = null;

  /** Prompt for the node in reach, or a placement/fire hint, or null. */
  function gatherPrompt(): string | null {
    // Phase K: mounted — show dismount hint.
    if (mountedEntityId !== null) {
      const me = entityManager.entities.get(mountedEntityId);
      if (me) return `E — dismount ${SPECIES_DEFS[me.species].name}`;
    }

    // Phase 60: nest loot prompt.
    const nestP = nestPrompt();
    if (nestP !== null) return nestP;

    // Dead animal loot prompt (Phase J).
    const px0 = controller.pos[0];
    const pz0 = controller.pos[2];
    for (const e of entityManager.entities.values()) {
      if (e.mode !== 'dead') continue;
      if (Math.hypot(e.x - px0, e.z - pz0) <= LOOT_REACH) {
        return `E — loot ${SPECIES_DEFS[e.species].name}`;
      }
    }

    // Phase K: mount hint for nearby mountable animals.
    for (const e of entityManager.entities.values()) {
      if (e.mode === 'dead') continue;
      if (!SPECIES_DEFS[e.species].mountable) continue;
      if (Math.hypot(e.x - px0, e.z - pz0) <= 3.0) {
        if (e.npcOwned) {
          return `E — buy ${SPECIES_DEFS[e.species].name} (${STABLE_HORSE_PRICE} gold)`;
        }
        return `E — ride ${SPECIES_DEFS[e.species].name}`;
      }
    }

    // Phase L: NPC talk hint.
    const npcNear = nearestNpc();
    if (npcNear !== null) {
      return `E — talk to ${npcNear.npc.name}`;
    }

    // Market stall hint (the merchant may be a few metres away).
    if (nearestStallPad() !== null) return 'E — browse the market stall';

    // Placement hints based on held item
    const heldForPrompt = equipped(inventory);
    if (heldForPrompt === 'campfire_kit') return 'Left click — place campfire';
    if (heldForPrompt === 'fiber_tent' || heldForPrompt === 'wool_tent' || heldForPrompt === 'hide_tent') {
      return 'Left click — place tent';
    }
    if (heldForPrompt !== null && eggSpeciesFor(heldForPrompt) !== null) {
      return 'Left click — place egg';
    }

    const node = resourceManager.nearestNode(
      controller.pos, GATHER_REACH, gameNowMs());
    if (node === null) {
      // Fire ignition hint
      if (heldForPrompt === 'fire_starter' || heldForPrompt === 'torch') {
        const nearFire = nearestFire(fires, controller.pos[0], controller.pos[2], GATHER_REACH);
        if (nearFire !== null && !isLit(nearFire, simTime)) return 'Left click — light fire';
        if (nearFire !== null && isLit(nearFire, simTime) && nearFire.kind === 'campfire') {
          return 'E — upgrade to Forge (8 stone)';
        }
        if (nearFire === null && heldForPrompt === 'fire_starter') {
          return 'Needs a placed campfire — craft a Campfire Kit';
        }
      }
      return null;
    }
    switch (node.type) {
      case 'tree':         return 'Chop the tree (axe, left-click)';
      case 'rock':         return 'Mine the rock (pickaxe, left-click)';
      case 'ore_rock':     return 'Mine the ore rock (pickaxe, left-click)';
      case 'bush':         return 'Pick berries (left-click)';
      case 'flax':         return 'Gather flax (left-click)';
      case 'mushroom':     return 'Pick mushroom (left-click)';
      case 'cooling_herb': return 'Gather cooling herb (left-click)';
      case 'warming_herb': return 'Gather warming herb (left-click)';
      case 'barrel_cactus':return 'Harvest cactus flesh (left-click)';
      case 'reeds':        return 'Gather reeds (left-click)';
      case 'gourd':        return 'Pick gourd (left-click)';
    }
  }

  function tryGather(): void {
    if (dungeonManager.isInside || buildingManager.isInside) return;
    const now = gameNowMs();
    const node = resourceManager.nearestNode(controller.pos, GATHER_REACH, now);
    if (node === null) return;
    // Turn to face the node being worked (RuneScape-style) so the swing
    // visibly connects — mesh forward is (sin yaw, -cos yaw).
    controller.yaw = Math.atan2(
      node.x - controller.pos[0], -(node.z - controller.pos[2]));
    const heldId2 = equipped(inventory);
    const tool = heldId2 === null ? undefined : itemDef(heldId2).tool;
    if (node.type === 'tree' && tool !== 'axe') {
      setGatherNotice('You need an axe to chop this tree.');
      return;
    }
    if (REQUIRES_PICKAXE[node.type as keyof typeof REQUIRES_PICKAXE] && tool !== 'pickaxe') {
      setGatherNotice('You need a pickaxe to mine this rock.');
      return;
    }
    const hits = (gatherHits.get(node.id) ?? 0) + 1;
    if (hits < GATHER_HITS) {
      gatherHits.set(node.id, hits);
      return;
    }
    gatherHits.delete(node.id);
    nodeRegistry.harvest(node.id, now);
    saveNodeRegistry(nodeRegistry);
    gatheredCount++;
    // Determine drops: trees use fixed drops; resource nodes use RESOURCE_DROPS table.
    let drops: [GameItemId, number][];
    if (node.type === 'tree') {
      drops = [['logs', 2]];
    } else {
      const dropTable = RESOURCE_DROPS[node.type as keyof typeof RESOURCE_DROPS];
      drops = dropTable
        ? dropTable
            .map(e => {
              const n = e.min + Math.floor(Math.random() * (e.max - e.min + 1));
              return [e.id, n] as [GameItemId, number];
            })
            .filter(([, n]) => n > 0)
        : [];
    }
    for (const [id, n] of drops) addItem(inventory, id, n);
    invChanged();
    audio.play('pickup'); // Feature 10: item gather SFX
    setGatherNotice(`Gathered: ${
      drops.map(([id, n]) => `${n}× ${itemDef(id).name}`).join(', ')}`);
  }

  // -------------------------------------------------------------------------
  // Phase J: loot dead animals within 3 m (E key)
  // -------------------------------------------------------------------------

  function tryLootDeadAnimal(): boolean {
    const px = controller.pos[0];
    const pz = controller.pos[2];
    for (const e of entityManager.entities.values()) {
      if (e.mode !== 'dead') continue;
      const dist = Math.hypot(e.x - px, e.z - pz);
      if (dist > LOOT_REACH) continue;
      // Roll drops with seeded rng (mix of entity id + kill time).
      let idHash = 0x811c9dc5 >>> 0;
      for (let i = 0; i < e.id.length; i++) {
        idHash ^= e.id.charCodeAt(i);
        idHash = Math.imul(idHash, 0x01000193) >>> 0;
      }
      const killMs = entityManager.killedRegistry.get(e.id)?.killedAtS ?? 0;
      const rngSeed = (idHash ^ (killMs >>> 0)) >>> 0;
      const lootRng = mulberry32(rngSeed);
      const drops = rollDrops(e.species, lootRng);
      for (const drop of drops) {
        addItem(inventory, drop.id, drop.count);
      }
      // Village concerns advance here rather than at the moment of death,
      // because looting is the point at which the player has actually gained
      // the thing — and it covers both 'kill' tasks and the 'bring' tasks the
      // drops satisfy, from one place.
      {
        const moved = [
          ...advanceTasks(villageFacts, 'kill', e.species, 1),
          ...drops.flatMap((d) => advanceTasks(villageFacts, 'bring', d.id, d.count)),
        ];
        if (moved.length > 0) {
          saveVillageFacts(villageFacts);
          const done = moved.filter((f) => f.task?.state === 'complete');
          if (done.length > 0 && done[0].ownerName !== undefined) {
            setGatherNotice(
              `That is what ${done[0].ownerName} asked for — go and tell them.`);
          }
        }
      }
      invChanged();
      if (drops.length > 0) {
        setGatherNotice(`Looted: ${drops.map(d => `${d.count}× ${d.id}`).join(', ')}`);
      } else {
        setGatherNotice('Nothing useful found.');
      }
      entityManager.despawnEntity(e.id);
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  /**
   * Ground height for a CREATURE at (x, z) whose feet are currently at `probeY`.
   *
   * This is the fix for "entities walk through castle walls", and it is a
   * different question from the one `chunkManager.ground.heightAt` answers.
   *
   * The AI has always been driven off the carved terrain heightfield, and
   * `stepAnimal`'s `moveXZ` off `terrainWorld` — deliberately, because
   * `castleWorldQuery.moveXZ` reads `CastleCollider.probeY()`, which is a
   * singleton bound to the PLAYER's height. Running an entity through it tests
   * that entity against whatever storey the player happens to be standing on,
   * so a goblin on the tower arena is blocked and unblocked by a player in the
   * courtyard 34 m below.
   *
   * The castle collider now has explicit-probe entry points for exactly this
   * (`creatureGround` / `creatureMoveXZ`), so each creature resolves against
   * its own storey. Two things fall out of it:
   *
   *   - the garrison walks on the floor it is standing on, up stairs, through
   *     doors, and not through walls;
   *   - wildlife that wanders onto the motte is no longer buried in it.
   *     `creatureGround` returns null rather than performing the player's
   *     anti-void rescue, so an animal at the foot of the hill gets terrain,
   *     and `creatureBlocked` treats the unreachable courtyard overhead as the
   *     cliff it visually is, so the animal walks around the motte instead of
   *     into it.
   *
   * Outside the footprint this is one AABB test and then the ordinary terrain
   * lookup, so nothing away from the castle pays for it.
   */
  function creatureGroundY(
    e: import('./entities/entity-manager').EntityState,
    x: number, z: number, probeY: number,
  ): number {
    const r = Math.max(0.3, SPECIES_DEFS[e.species].size * 0.45);
    // The base answer is the CARVED terrain — the surface the renderer draws,
    // with roads graded into it. The raw generated field is up to 2.5 m away
    // from it in a cutting, which is the whole of "the animals run where the
    // original land was, not where you see the road".
    //
    // `creatureGround` then layers a town's platforms and stoops on top, and
    // does it with the CREATURE's own feet as the probe rather than the
    // player's: a platform top only counts as ground within CREATURE_STEP of
    // where the animal is standing, so a street is standable and the 2.2 m
    // face of a terrace is a wall to walk around rather than a floor to snap
    // up onto. There is deliberately no anti-void rescue — see
    // settlement-collider.ts.
    const terrainY = chunkManager.ground.heightAt(x, z);
    const townY = terrainWorld.creatureGround(x, z, r, probeY, terrainY);
    if (!castleManager.collider.inFootprint(x, z)) return townY;
    const g = castleManager.collider.creatureGround(x, z, r, probeY);
    return g === null ? townY : g;
  }

  /** `moveXZ` for a creature, layered over the terrain/settlement world. */
  function creatureMoveXZ(
    e: import('./entities/entity-manager').EntityState,
    x: number, z: number, dx: number, dz: number, r: number,
  ): [number, number] {
    // The creature-aware slide, not the player's. `terrainWorld.moveXZ` tests
    // against a probe height bound to the PLAYER, so an animal was blocked and
    // unblocked by wherever the player happened to be standing.
    const [bx, bz] = terrainWorld.creatureMoveXZ(x, z, dx, dz, r, e.y);
    // Anything nowhere near the castle keeps exactly the behaviour it had.
    if (!castleManager.collider.inFootprint(x, z)
      && !castleManager.collider.inFootprint(bx, bz)) return [bx, bz];
    const h = SPECIES_DEFS[e.species].size * 1.3;
    // The base has already chosen a delta; the castle only ever refuses part
    // of it. Composing them the other way round (running the base again inside
    // the castle query) applies two slides and walks animals sideways along
    // walls they never touched.
    return castleManager.collider.creatureMoveXZ(
      x, z, bx - x, bz - z, r, e.y, h);
  }

  // --- flying mounts vs the castle -----------------------------------------

  /**
   * Collision radius of a flier, metres.
   *
   * Judgement call, and the two obvious answers are both wrong. The walking
   * radius (`size * 0.45`, 1.6 m on a dragon) is the body only, so the origin
   * clears a tower while the wings pass through it. The real half-wingspan is
   * ~2.2x size — 7.6 m on a dragon, 9.5 m on the boss's — which is honest
   * geometry and terrible play: nothing that wide fits between the towers or
   * down into the courtyard, so the flying mount stops being able to go
   * anywhere interesting.
   *
   * `size * 0.9` is body plus inner wing: 3.15 m on a dragon, 2.2 m on a
   * wyvern. It is wide enough that you cannot thread a wing through masonry
   * and narrow enough that the courtyard, the gate approach and the gaps
   * between towers all stay flyable.
   */
  function flierRadius(e: import('./entities/entity-manager').EntityState): number {
    return SPECIES_DEFS[e.species].size * 0.9;
  }

  /**
   * Vertical span of a flier's body, feet at `y`.
   *
   * Deliberately taller than the walking `size * 1.3`: the RIDER is locked to
   * the saddle at `y + size` and stands 1.7 m above that, and `tickMount`
   * assigns `controller.pos` straight from the mount with no collision query
   * of its own. If the span stopped at the animal's back, a low slab would
   * pass cleanly over the dragon and straight through the player sitting on
   * it — the mount would be resolved and its passenger extruded through a
   * floor. Covering the rider is what makes "the player cannot be pushed
   * through geometry by the mount" true rather than hoped for.
   */
  function flierSpan(
    e: import('./entities/entity-manager').EntityState, y: number,
  ): [number, number] {
    const s = SPECIES_DEFS[e.species].size;
    return [y, y + Math.max(s * 1.3, s + PLAYER_HEIGHT)];
  }

  /** True when a flier with feet at `y` would be inside castle masonry. */
  function flierHitsCastle(
    e: import('./entities/entity-manager').EntityState,
    x: number, z: number, y: number,
  ): boolean {
    if (!castleManager.collider.inFootprint(x, z)) return false;
    const [y0, y1] = flierSpan(e, y);
    return castleManager.collider.flierBlocked(x, z, flierRadius(e), y0, y1);
  }

  /**
   * Horizontal move for a flier at altitude: unobstructed everywhere except
   * inside the castle footprint, where it slides against the masonry.
   *
   * The early-out is what keeps "a flying mount can go anywhere" true. It is
   * one AABB test, and outside it the move is the same raw addition it always
   * was — no terrain query, no settlement query, no behaviour change over
   * open world, forest, village or sea.
   */
  function flierMoveXZ(
    e: import('./entities/entity-manager').EntityState, dx: number, dz: number,
  ): [number, number] {
    const nx = e.x + dx;
    const nz = e.z + dz;
    if (!castleManager.collider.inFootprint(e.x, e.z)
      && !castleManager.collider.inFootprint(nx, nz)) return [nx, nz];
    const [y0, y1] = flierSpan(e, e.y);
    return castleManager.collider.flierMoveXZ(
      e.x, e.z, dx, dz, flierRadius(e), y0, y1);
  }

  /**
   * Keep Castle Vhaeron's garrison in the world, and remember its dead.
   *
   * `placeEntity` is idempotent on the id, so calling this every frame neither
   * heals the wounded nor resurrects the killed — the roster is re-asserted,
   * not rebuilt. Deaths are moved into `castleManager.garrisonDead` and
   * persisted here rather than at each of the three places that can kill an
   * entity (melee, mount attack, mob-vs-mob), because a single sweep cannot be
   * the one that gets forgotten when a fourth is added.
   */
  function tickCastleGarrison(px: number, pz: number): void {
    let died = false;
    for (const p of castleManager.garrison) {
      const e = entityManager.entities.get(p.id);
      if (e === undefined || e.mode !== 'dead') continue;
      if (castleManager.markGarrisonDead(p.id)) died = true;
    }
    if (died) saveCastleState();

    castleManager.syncGarrison(
      (p) => {
        const e = entityManager.placeEntity(
          p.id, p.species, p.x, p.y, p.z, p.yaw, p.colorVariant);
        // Hold station while dormant. `placeEntity` only sets this on the
        // frame it creates the entity, and nothing else pins y for a creature
        // the AI is not stepping, so without this a garrison member spawned
        // before the castle mesh resident exists can drift.
        if (!castleManager.hostile) { e.x = p.x; e.y = p.y; e.z = p.z; e.yaw = p.yaw; }
      },
      (id) => { entityManager.entities.delete(id); },
      px, pz);
  }

  // Phase J: entity AI tick (called once per sim step)
  // -------------------------------------------------------------------------
  function tickEntities(dtS: number): void {
    const px = controller.pos[0];
    const pz = controller.pos[2];
    // Rebuilt every sim step by `tickWildFlier`. Without this it never
    // emptied: a single wyvern breathing pushed a jet per tick forever, and a
    // probe measured 2,278 live flame billboards against a normal peak of ~34.
    wildBreaths.length = 0;

    // Tick dungeon enemies when inside — replaces the normal overworld tick.
    if (dungeonManager.isInside) {
      dungeonManager.tickEnemies(dtS, px, pz, simTime, (damage, src, kind, tokens) => {
        // Mounts cannot be brought into a dungeon, so this always resolves to
        // the player — routed anyway so there is exactly one damage path.
        //
        // `reach` stays 'melee' even for the archer's shot: `routePlayerDamage`
        // is about whether a blow reaches a MOUNTED rider, and there are no
        // mounts down here. `kind` is the shield's question and it is the one
        // that has to be right — an underground arrow is blockable and never
        // parryable.
        applyAttackOnPlayer(damage, 'animal', 'melee', 1.0, controller.pos[1],
          { x: src.x, z: src.z, kind, id: src.id, entity: src, tokens });
      });
      return;
    }
    // Update cell streaming.
    entityManager.update(px, pz);
    tickCastleGarrison(px, pz);
    // BEFORE the entity loop, not inside it.
    //
    // It used to run inside, keyed on the dragon's id — which meant it was
    // gated behind the loop's `if (e.mode === 'dead') continue`, so the moment
    // the dragon died the fight's state machine stopped being stepped at all.
    // It could never reach 'dismounted', `kingIsMounted()` never went false,
    // and the King stayed welded to his own corpse in a seated pose.
    bossHoldsTheDragon = tickCastleBoss(dtS);

    // One arbitration per tick, before anything is stepped: expire finished
    // turns, decide how many tokens this crowd gets, and pick who is next up.
    meleeTokens.advance(dtS);

    // One scan per tick, shared by every creature's target selection.
    combatIndex.rebuild(
      entityManager.entities.values(),
      npcRuntimes.filter((r) => r.hp > 0)
        .map((r) => ({ id: r.npc.id, x: r.wx, z: r.wz })),
      px, pz);

    // Nominate a threat for the player's owned animals to intercept. One scan
    // per tick, shared by every defender: whoever is closest to the player and
    // currently coming after them. Only 'aggro' counts — a grazing bear is not
    // a threat and a pet that picks fights turns every walk into a brawl.
    // The ridden mount is deliberately NOT a defender: the player drives it
    // with F/G, and having it charge off on its own would fight the reins.
    let defendTarget: DefendTarget | null = null;
    {
      let bestD2 = DEFEND_CALL_RADIUS * DEFEND_CALL_RADIUS;
      for (const h of entityManager.entities.values()) {
        if (h.mode !== 'aggro' || h.owned || h.id === mountedEntityId) continue;
        const hx = h.x - px, hz = h.z - pz;
        const d2 = hx * hx + hz * hz;
        if (d2 < bestD2) { bestD2 = d2; defendTarget = { id: h.id, x: h.x, z: h.z }; }
      }
    }

    for (const e of entityManager.entities.values()) {
      if (e.mode === 'dead') continue;
      // Phase K: mounted entity is steered by tickMount, skip normal AI.
      if (e.id === mountedEntityId) continue;

      // The king's dragon: the patrol circuit, then the fight. Returns false
      // once it is on the ground, from which point it is an ordinary hostile
      // creature and falls through to `stepAnimal` like anything else.
      // The dragon is driven by `tickCastleBoss`, which ran before this loop.
      // It only falls through to `stepAnimal` once it is on the ground.
      if (e.id === kingDragonId && bossHoldsTheDragon) continue;
      // The King has no AI of his own WHILE MOUNTED; `tickCastleBoss` moves
      // him. Once his mount is down he fights on his own feet, so he falls
      // through — which is the whole of "the final fight" as far as he is
      // concerned: 3.24 m of him, 2.4 m of reachBonus, and no dragon.
      if (e.id === evilKingId && kingIsMounted()) continue;

      // Castle garrison: asleep at their posts until the alarm goes up.
      //
      // Dormant means NOT TICKED, not "ticked at idle". `stepAnimal` would
      // wander them off station and, more to the point, its aggro trigger
      // fires on proximity alone (16 m) with no notion of an alarm — so a
      // ticked-but-idle goblin attacks the player walking past it during the
      // escape, which is exactly the thing the opening must not do.
      if (isGarrisonId(e.id) && !castleManager.hostile) continue;

      // Dragon flight: if a dragon was just dismounted while airborne, ease it
      // back down to terrain over the next few seconds before handing off to
      // the normal follow-mode AI (which already ground-snaps via heightAt).
      if (DRAGON_FLIGHT_ENABLED && SPECIES_DEFS[e.species].canFly === true) {
        const eExt = e as import('./entities/entity-manager').EntityState & { _landingY?: number };
        if (eExt._landingY !== undefined) {
          // The creature's own ground, not the raw heightfield. On the castle
          // those differ by the whole height of the motte, and descending to
          // the raw value drives a dismounted flier down through the courtyard
          // slab and into the hillside underneath it.
          const groundY = creatureGroundY(e, e.x, e.z, e.y);
          if (e.y > groundY + DRAGON_GROUND_EPSILON) {
            // Descend at the same rate as powered descent (6 m/s).
            e.y = Math.max(groundY, e.y - DRAGON_FLIGHT_SPEED * dtS);
            eExt._landingY = groundY;
            // Advance wingPhase while descending so wings flap.
            e.walkPhase += DRAGON_AIRBORNE_FLAP_RATE * dtS;
            continue; // skip normal AI while landing
          } else {
            // Reached the ground.
            e.y = groundY;
            delete eExt._landingY;
          }
        }
      }

      const playerDist = Math.hypot(e.x - px, e.z - pz);
      const rng = mulberry32(
        ((e.walkPhase * 1000) | 0) ^ (e.id.charCodeAt(0) ?? 0)
      );
      // Feature 10: growl SFX when wolf/bear transitions to aggro.
      const prevMode = e.mode;
      // Portrait mode: hold everything at idle so the subject neither charges
      // the camera nor bolts out of frame.
      if (portraitEntityId !== null && (e.mode === 'aggro' || e.mode === 'flee')) {
        e.mode = 'idle';
        e.stateTimer = 0;
      }
      stepAnimal(e, dtS, {
        playerX: px,
        playerZ: pz,
        playerDist,
        // Vertical reach. `stepAnimal` treats an absent `playerY` as "no
        // vertical gate", which is exactly the old behaviour, so leaving this
        // out was a silent no-op — and the Evil King could hit a player
        // standing 10 m above him through a tower floor for 4.4-8.8 hp.
        playerY: controller.pos[1],
        rng,
        // Carved ground, so animals walk on a road rather than through it —
        // and, on the castle's footprint, the storey THIS creature is standing
        // on rather than the one the player is. See `creatureGroundY`.
        heightAt: (x, z) => creatureGroundY(e, x, z, e.y),
        moveXZ: (x, z, dx, dz, r) => creatureMoveXZ(e, x, z, dx, dz, r),
        speciesDef: SPECIES_DEFS[e.species],
        defendTarget: e.owned === true ? defendTarget : null,
        combat: combatIndex,
        onAttackNpc: (npcId: string, damage: number) => {
          const rt = npcRuntimes.find((r) => r.npc.id === npcId);
          if (rt === undefined || rt.hp <= 0) return;
          // Deliberately NOT damageNpcFromMount: that path reports a crime and
          // raises the player's bounty. A bear mauling a farmer is a tragedy,
          // not something the player should be fined for.
          rt.hp = Math.max(0, rt.hp - damage);
          rt.fleeing = true;
          if (rt.hp <= 0) onNpcKilled(rt);
          audio.play('hit', { dist: Math.hypot(rt.wx - px, rt.wz - pz) });
        },
        onAttackEntity: (targetId: string, damage: number) => {
          const t = entityManager.entities.get(targetId);
          if (t === undefined || t.mode === 'dead') return;
          damageEntityFromMount(t, damage);
          audio.play('hit', { dist: Math.hypot(t.x - px, t.z - pz) });
        },
        onAttackPlayer: (damage: number) => {
          if (portraitEntityId !== null) return; // portrait mode: no mauling
          // Phase K: cannot attack while the entity is owned (baby/tamed).
          if ((e as import('./entities/entity-manager').EntityState & { owned?: boolean }).owned) return;
          // Everything an animal does with teeth or claws is melee, so it can
          // never reach a rider in the saddle: it hits the mount, or nothing
          // at all if the mount is out of reach overhead (attack-routing.ts).
          noteAttackOnPlayer(e.id, simTime);
          // The overworld melee path, and the one the Evil King uses once he is
          // off his dragon — which is what makes him parryable. `isExempt`
          // rather than a species list so the boss stagger and the token
          // exemption can never come to disagree about who is a boss.
          applyAttackOnPlayer(damage, 'animal', 'melee',
            SPECIES_DEFS[e.species].size, e.y,
            {
              x: e.x, z: e.z, kind: 'melee', id: e.id, entity: e,
              boss: isExempt(e.species),
              tokens: meleeTokensOn ? meleeTokens : null,
            });
        },
        // Turn-taking, so a pack menaces instead of mobbing. Wildlife brawling
        // with each other is deliberately NOT arbitrated — see the pool.
        tokens: meleeTokensOn ? meleeTokens : null,
      });
      // Growl/roar on entering aggro (wolf, bear, dragon, etc.).
      if (prevMode !== 'aggro' && e.mode === 'aggro') {
        const def = SPECIES_DEFS[e.species];
        const sfxName = def.aggro && e.species === 'dragon' ? 'dragon_roar' : 'growl';
        audio.play(sfxName, { dist: playerDist });
      }
      // Airborne behaviour for wild fliers, AFTER the AI has run.
      //
      // Order is not incidental: `moveToward` ends with `e.y = heightAt(x, z)`,
      // pinning every entity to the terrain. Flight has to be applied on top of
      // that or the ground wins every frame — which is exactly why wild dragons,
      // wyverns and griffins have always walked everywhere while only the
      // MOUNTED controller could get one off the ground.
      tickWildFlier(e, dtS, playerDist);
    }
  }

  // -------------------------------------------------------------------------
  // Phase H: active projectiles (thrown stones + arrows)
  //
  // Storage, integration and the stuck-in-something lifecycle live in
  // projectiles.ts (pooled, zero per-shot allocation). What stays here is the
  // part that needs the world: which things can be hit, and what happens to
  // them — damage, kills, crime reports, audio.
  // -------------------------------------------------------------------------
  const projectilePool = createProjectilePool(PROJECTILE_CAPACITY);

  /** simTime of the last bow shot; enforces the fire-rate limit. */
  let lastBowShotS = -999;

  // --- projectile rendering -------------------------------------------------
  // ONE buffer, ONE draw call, sized for a completely full pool and rewritten
  // in place every frame. No per-shot GPU allocation, and no possibility of
  // overrunning the allocation (which would render the whole frame black — see
  // CHARACTER_MAX_VERTS's history): buildProjectileMesh is bounded by the same
  // constant this buffer is sized from and stops early regardless.
  const projectileScratch = new Float32Array(projectileMeshFloats(PROJECTILE_CAPACITY));
  const projectileVertexBuffer = renderer.device.createBuffer({
    label: 'projectiles',
    size: projectileScratch.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  const projectileBindGroups = renderer.createObjectBindGroup(0, 0, 0, 101); // 101 = wood
  const projectileDraw: import('./renderer').DungeonDraw = {
    draw: {
      vertexBuffer: projectileVertexBuffer,
      indexBuffer: null,
      count: 0,
      bindGroup: projectileBindGroups.bindGroup,
      shadowBindGroup: projectileBindGroups.shadowBindGroup,
    },
    lightsBindGroup: getFireLightsBindGroup(),
  };

  /** Rewrite the arrow buffer for this frame. Returns the vertex count. */
  function updateProjectileDraw(camX: number, camZ: number): number {
    const built = buildProjectileMesh(projectilePool, projectileScratch, camX, camZ, 160);
    // Clamp at the write site. `writeBuffer` takes its size through a WebIDL
    // [EnforceRange] unsigned long long, so a NaN or an over-long value does
    // not clip — it throws out of the frame loop and the game stops rendering.
    // Passing the typed array (element counts, not bytes) removes the byte
    // arithmetic that could produce one.
    const verts = Number.isFinite(built)
      ? Math.max(0, Math.min(
        Math.floor(built), Math.floor(projectileScratch.length / PROJECTILE_FLOATS_PER_VERT)))
      : 0;
    projectileDraw.draw.count = verts;
    if (verts > 0) {
      renderer.device.queue.writeBuffer(
        projectileVertexBuffer, 0, projectileScratch, 0,
        verts * PROJECTILE_FLOATS_PER_VERT);
    }
    return verts;
  }

  // -------------------------------------------------------------------------
  // Phase H: placement helpers
  // -------------------------------------------------------------------------

  /**
   * Compute the placement position 2.5 m ahead of the camera.
   * Returns null if the spot has too steep a slope (>20°) or is at water level.
   */
  function placementTarget(): [number, number, number] | null {
    const yaw = -orbitCam.yaw;
    const px = controller.pos[0] + Math.sin(yaw) * 2.5;
    const pz = controller.pos[2] - Math.cos(yaw) * 2.5;
    const py = heightField.heightAt(px, pz);
    // Reject water (heightAt ≤ 0)
    if (py <= 0.05) {
      setGatherNotice('Cannot place here (water).');
      return null;
    }
    // Reject steep slope: sample a ±0.5 m radius
    const dh = Math.max(
      Math.abs(py - heightField.heightAt(px + 0.5, pz)),
      Math.abs(py - heightField.heightAt(px - 0.5, pz)),
      Math.abs(py - heightField.heightAt(px, pz + 0.5)),
      Math.abs(py - heightField.heightAt(px, pz - 0.5)),
    );
    const slopeDeg = Math.atan2(dh, 0.5) * (180 / Math.PI);
    if (slopeDeg > 20) {
      setGatherNotice('Cannot place here (too steep).');
      return null;
    }
    return [px, py, pz];
  }

  /** Try to place a campfire_kit. Consumes 1 campfire_kit. */
  function tryPlaceCampfire(): boolean {
    if (countItem(inventory, 'campfire_kit') < 1) return false;
    const pos = placementTarget();
    if (pos === null) return false;
    removeItem(inventory, 'campfire_kit', 1);
    invChanged();
    const fire = createFire(pos[0], pos[1], pos[2], 'campfire', 0, simTime);
    fires.push(fire);
    saveFires(fires);
    rebuildFireDraws(simTime);
    setGatherNotice('Campfire placed. Use fire_starter + logs to light it.');
    return true;
  }

  /** Try to place a tent of the appropriate tier. */
  function tryPlaceTent(itemId: 'fiber_tent' | 'wool_tent' | 'hide_tent'): boolean {
    if (countItem(inventory, itemId) < 1) return false;
    const pos = placementTarget();
    if (pos === null) return false;
    removeItem(inventory, itemId, 1);
    invChanged();
    const tier: 1 | 2 | 3 = itemId === 'fiber_tent' ? 1 : itemId === 'wool_tent' ? 2 : 3;
    const tent = createTent(pos[0], pos[1], pos[2], tier);
    tents.push(tent);
    saveTents(tents);
    rebuildTentDraws();
    setGatherNotice(`Tent placed (tier ${tier}).`);
    return true;
  }

  /**
   * Try to ignite or relight the nearest unlit campfire within GATHER_REACH.
   * Requires fire_starter (tool, NOT consumed) OR torch held + 1 log from inventory.
   * Always costs 1 log to ignite (tinder).
   */
  function tryIgniteFire(): boolean {
    const heldId2 = equipped(inventory);
    const isIgnitor = heldId2 === 'fire_starter' || heldId2 === 'torch';
    if (!isIgnitor) return false;
    // Find nearest fire within reach
    const fire = nearestFire(fires, controller.pos[0], controller.pos[2], GATHER_REACH);
    if (fire === null) {
      if (heldId2 === 'fire_starter') {
        // Feedback instead of a silent melee swing — the starter only lights
        // a placed campfire, it cannot start a fire on bare ground.
        setGatherNotice('No campfire here — craft a Campfire Kit (3 logs, 2 sticks) and place it first.');
        return true;
      }
      return false;
    }
    if (isLit(fire, simTime)) {
      setGatherNotice('Fire is already burning.');
      return true; // consumed the action
    }
    // Need 1 log to ignite
    if (countItem(inventory, 'logs') < 1) {
      setGatherNotice('Need logs to light the fire.');
      return true;
    }
    removeItem(inventory, 'logs', 1);
    invChanged();
    addFuel(fire, 1, simTime); // lights it with 1 log (90 s)
    saveFires(fires);
    rebuildFireDraws(simTime);
    setGatherNotice('Fire lit! Add logs to keep it burning.');
    return true;
  }

  /**
   * Try to fill an empty container with fresh water (left-click at river).
   * Swaps empty → full variant.
   */
  function tryFillContainer(): boolean {
    if (!nearFreshWater()) return false;
    const heldId2 = equipped(inventory);
    if (heldId2 === null) return false;
    type FillMap = { empty: import('./items').GameItemId; full: import('./items').GameItemId };
    const fillMap: FillMap[] = [
      { empty: 'gourd_bottle', full: 'gourd_bottle_full' },
      { empty: 'waterskin',    full: 'waterskin_full'    },
      { empty: 'iron_flask',   full: 'iron_flask_full'   },
    ];
    const entry = fillMap.find(m => m.empty === heldId2);
    if (entry === undefined) return false;
    removeItem(inventory, entry.empty, 1);
    addItem(inventory, entry.full, 1);
    invChanged();
    setGatherNotice(`${itemDef(entry.full).name} filled.`);
    return true;
  }

  /**
   * Try to consume the held item (edible or drinkable full container).
   * Full containers revert to their empty variant on drink.
   */
  function tryConsumeHeldItemLeftClick(): boolean {
    const heldId2 = equipped(inventory);
    if (heldId2 === null) return false;
    const def2 = itemDef(heldId2);
    let consumed = false;

    if (def2.edible) {
      healPlayer(vitals, def2.edible.heal);
      audio.play('eat_drink'); // Feature 10: eat SFX
      consumed = true;
    }
    if (def2.drinkable) {
      drinkPlayer(vitals, def2.drinkable.quench);
      audio.play('eat_drink'); // Feature 10: drink SFX
      consumed = true;
      // Full containers: revert to empty on drink
      type RevertMap = { full: import('./items').GameItemId; empty: import('./items').GameItemId };
      const revertMap: RevertMap[] = [
        { full: 'gourd_bottle_full', empty: 'gourd_bottle' },
        { full: 'waterskin_full',    empty: 'waterskin'    },
        { full: 'iron_flask_full',   empty: 'iron_flask'   },
      ];
      const rev = revertMap.find(r => r.full === heldId2);
      if (rev !== undefined) {
        // Remove 1 full, add 1 empty.
        const slot = inventory.hotbar[inventory.selected];
        if (slot !== null) {
          slot.count -= 1;
          if (slot.count <= 0) inventory.hotbar[inventory.selected] = null;
        }
        addItem(inventory, rev.empty, 1);
        invChanged();
        saveVitals(vitals);
        return true;
      }
    }
    if (consumed && def2.kind !== 'container') {
      // Phase N: apply timed effects for potions / dishes.
      const extraHeal = applyItemEffects(effectsState, heldId2, ITEM_DEFS);
      if (extraHeal > 0) healPlayer(vitals, extraHeal);
      saveEffectsState(effectsState);
      // Non-container consume (potion, food): remove 1.
      const slot = inventory.hotbar[inventory.selected];
      if (slot !== null) {
        slot.count -= 1;
        if (slot.count <= 0) inventory.hotbar[inventory.selected] = null;
      }
      invChanged();
      saveVitals(vitals);
    }
    return consumed;
  }

  /**
   * Throw the held stone (or other throwable) as an arc projectile.
   * Initial speed 14 m/s at look direction +10° up.
   */
  function tryThrow(): boolean {
    const heldId2 = equipped(inventory);
    if (heldId2 === null) return false;
    if (!itemDef(heldId2).throwable) return false;
    if (countItem(inventory, heldId2) < 1) return false;
    removeItem(inventory, heldId2, 1);
    invChanged();

    const yaw = -orbitCam.yaw;
    const pitch = orbitCam.pitch + (10 * Math.PI / 180); // +10° upward arc
    const speed = 14;
    const vx = Math.sin(yaw) * Math.cos(pitch) * speed;
    const vy = Math.sin(pitch) * speed;
    const vz = -Math.cos(yaw) * Math.cos(pitch) * speed;
    spawnProjectile(projectilePool, {
      kind: 'stone',
      x: controller.pos[0],
      y: controller.pos[1] + 1.2, // launch from chest height
      z: controller.pos[2],
      vx, vy, vz,
      damage: 2,
      nowS: simTime,
    });
    attackT = 0; // play swing animation
    return true;
  }

  // -------------------------------------------------------------------------
  // Bow: hold to draw, release to loose
  //
  // A click used to fire instantly, which is a large part of why a shot was
  // unreadable — the arrow (invisible) and its cause (a generic axe chop)
  // happened in the same frame with nothing in between. Holding the button
  // draws the string: the archer's pose changes, an arrow appears nocked, and
  // the shot leaves on release. Power scales with how long it was held, so a
  // panicked tap is a weak lob and a held draw is a flat, fast shot.
  //
  // A tap still fires (at MIN_DRAW_POWER) rather than doing nothing — the
  // previous input was a tap and silently swallowing it would read as a bug.
  // -------------------------------------------------------------------------
  /** Seconds of holding for a full-power shot. */
  const BOW_DRAW_S = 0.55;
  /** Fraction of full power an instant tap delivers. */
  const MIN_DRAW_POWER = 0.35;
  /** Arrow muzzle speed at zero draw and at full draw (m/s). */
  const ARROW_SPEED_MIN = 19;
  const ARROW_SPEED_MAX = 36;
  /** Minimum seconds between loosed arrows (unchanged from the old limiter). */
  const BOW_REFIRE_S = 0.6;
  /** Seconds the loose/follow-through pose plays after release. */
  const BOW_LOOSE_S = 0.20;

  /** True while the string is being drawn. */
  let bowDrawing = false;
  /** Seconds the string has been held. */
  let bowDrawT = 0;
  /** Counts down through the follow-through after a loose. */
  let bowLooseT = 0;
  /** Draw power captured at the moment of release (drives the snap-back). */
  let bowLoosePower = 0;

  /** Is a bow the currently equipped item? */
  function bowEquipped(): boolean {
    const id = equipped(inventory);
    return id === 'hunter_bow' || id === 'composite_bow';
  }

  // -------------------------------------------------------------------------
  // Ammunition
  //
  // Two quivers, and which one leaves the bow is the player's choice, not a
  // rule the game applies behind their back.
  //
  // For a while there was only Tintreach, because making the lightning arrow
  // rare accidentally made the BOW rare — the weapon had nothing else to
  // shoot, so every squirrel cost a boss drop. `flint_arrow` is the everyday
  // ammunition that should always have been there, and it flies the ordinary
  // ballistic arc; Tintreach stays hitscan. They are genuinely different
  // weapons sharing a bow, which is why the choice is explicit (X) rather than
  // "whatever you have most of".
  //
  // The one automatic move is DOWNWARD only: run out of Tintreach mid-fight
  // and the bow falls back to flint rather than refusing to fire. It never
  // does the reverse. Spending a rare boss drop because the common quiver ran
  // dry is exactly the kind of silent theft that makes a player stop trusting
  // their own inventory.
  // -------------------------------------------------------------------------

  /** Which quiver is feeding the bow. */
  type AmmoKind = 'flint' | 'tintreach';

  const AMMO_ITEM: Record<AmmoKind, GameItemId> =
    { flint: 'flint_arrow', tintreach: 'arrow' };

  /** What the player last chose. Flint is the default: it is the ordinary one. */
  let ammoPref: AmmoKind = 'flint';

  /**
   * The quiver a shot loosed right now would actually spend, or null when both
   * are empty.
   *
   * Never silently upgrades flint → Tintreach; see the section note above.
   */
  function ammoInHand(): AmmoKind | null {
    if (countItem(inventory, AMMO_ITEM[ammoPref]) > 0) return ammoPref;
    if (ammoPref === 'tintreach' && countItem(inventory, AMMO_ITEM.flint) > 0) {
      return 'flint';
    }
    return null;
  }

  /** Player-facing name plus stock, for the notice and the HUD line. */
  function ammoLabel(k: AmmoKind): string {
    return `${itemDef(AMMO_ITEM[k]).name} ×${countItem(inventory, AMMO_ITEM[k])}`;
  }

  /**
   * Muzzle speed for a plain arrow at this draw. Tintreach has no muzzle speed
   * — it is at the mark on the frame it is fired — so this is flint only.
   */
  function arrowSpeed(power: number): number {
    return ARROW_SPEED_MIN + (ARROW_SPEED_MAX - ARROW_SPEED_MIN) * power;
  }

  /** Draw power a shot loosed on THIS frame would carry. */
  function currentDrawPower(): number {
    return Math.max(MIN_DRAW_POWER, Math.min(1, bowDrawT / BOW_DRAW_S));
  }

  /** X — swap quivers. A no-op notice when there is only one kind to swap to. */
  function toggleAmmo(): void {
    ammoPref = ammoPref === 'flint' ? 'tintreach' : 'flint';
    const have = countItem(inventory, AMMO_ITEM[ammoPref]);
    setGatherNotice(have > 0
      ? `Nocked: ${ammoLabel(ammoPref)}`
      : `No ${itemDef(AMMO_ITEM[ammoPref]).name.toLowerCase()} — X to switch back`);
    audio.play('ui_click');
  }

  /**
   * Debug pin for the draw pose. Headless harnesses cannot acquire pointer
   * lock, so they cannot hold the mouse button — and a 0.55 s draw is not
   * something a screenshot can be timed against anyway. Mirrors
   * `attackTOverride`, which exists for exactly the same reason.
   */
  let bowAimOverride: number | null = null;

  /** 0..1 archer pose weight — draw, then a fast snap back on release. */
  function bowAimAmount(): number {
    if (bowAimOverride !== null) return bowAimOverride;
    if (bowDrawing) return Math.min(1, bowDrawT / BOW_DRAW_S);
    if (bowLooseT > 0) return bowLoosePower * (bowLooseT / BOW_LOOSE_S) * 0.35;
    return 0;
  }

  /**
   * First person, but only while the string is actually back.
   *
   * The report was "first person view for bow to make aiming easier", and the
   * temptation is to switch the whole camera the moment a bow is selected.
   * That is the wrong trade for this game. The player is a knitted doll and
   * watching them is most of the point; walking a village, gathering and
   * talking to people from inside their own skull because a bow happens to be
   * in slot 4 would cost far more than the aim gains. Aiming is also the only
   * moment the third-person offset actually hurts — a boom 6 m back and to one
   * side is what makes a distant target ambiguous.
   *
   * So it engages on the DRAW and holds through the follow-through, which is
   * the familiar aim-down-sights move and needs no new input. `bowAimOverride`
   * deliberately does not trigger it: that pin exists so capture harnesses can
   * photograph the draw pose, and a harness that framed a shot and then got
   * moved inside the archer's head would photograph nothing at all.
   *
   * The ease is ~0.16 s to 90%. Slower reads as a lazy zoom that arrives after
   * you have already loosed; instantaneous reads as a teleport.
   */
  const FP_EASE_PER_S = 14;
  let fpLastMs = performance.now();
  /** Debug pin: true/false forces a view, null returns control to the draw. */
  let firstPersonOverride: boolean | null = null;

  function bowFirstPersonTarget(): number {
    if (firstPersonOverride !== null) return firstPersonOverride ? 1 : 0;
    // flyMode drives its own camera; portrait mode is framing a creature.
    if (flyMode || portraitEntityId !== null) return 0;
    return (bowDrawing || bowLooseT > 0) && bowEquipped() ? 1 : 0;
  }

  // ---------------------------------------------------------------------------
  // Z-targeting (lock-on) — see `combat/lock-on.ts` for the maths and for why
  // target-relative movement needs no code here.
  // ---------------------------------------------------------------------------

  /** Entity/NPC id currently locked onto, or null for free look. */
  let lockOnId: string | null = null;

  /** Rebuilt per query and reused, never reallocated. */
  const lockCands: LockCandidate[] = [];

  /**
   * Everything the player may lock onto right now.
   *
   * Deliberately NOT restricted to things that are angry: locking a deer to
   * line up a bow shot is the same gesture as locking a wolf that is already
   * biting you, and a targeting system that refuses the first one reads as
   * broken rather than as principled. What IS excluded is anything that must
   * never be a target — the player's own pets and mounts (`owned`), corpses,
   * and the mount currently being ridden.
   */
  function buildLockCandidates(): LockCandidate[] {
    lockCands.length = 0;
    // Corpses are INCLUDED, as non-hostile candidates, and that is load-bearing
    // rather than sloppy. `lockBreakReason` distinguishes "the thing you were
    // locked to died" from "it is no longer in the world at all", and only the
    // first hands you the next enemy. Filtering the dead out here collapsed
    // both cases into 'gone', so killing a target under your sword dropped you
    // into free look instead of passing you its friend — the exact moment the
    // handover exists for.
    if (dungeonManager.isInside) {
      for (const e of dungeonManager.dungeonEnemies()) {
        lockCands.push({ id: e.id, x: e.x, z: e.z, hostile: e.mode !== 'dead' && e.hp > 0 });
      }
      return lockCands;
    }
    for (const e of entityManager.entities.values()) {
      if (e.id === mountedEntityId) continue;
      if (e.owned === true) continue;
      lockCands.push({ id: e.id, x: e.x, z: e.z, hostile: e.mode !== 'dead' && e.hp > 0 });
    }
    // Hostile people, but never calm ones: a lock-on that snaps to the farmer
    // you are talking to would be actively harmful, since the same stick also
    // aims a bow.
    for (const rt of npcRuntimes) {
      if (rt.hp <= 0) continue;
      const angry = rt.attitude === 'hostile'
        || (guardsHostile && rt.npc.role === 'guard');
      if (!angry) continue;
      lockCands.push({ id: rt.npc.id, x: rt.wx, z: rt.wz, hostile: true });
    }
    return lockCands;
  }

  /** The locked candidate this frame, or undefined if it is gone. */
  function lockedCandidate(): LockCandidate | undefined {
    if (lockOnId === null) return undefined;
    const id = lockOnId;
    return buildLockCandidates().find((k) => k.id === id);
  }

  /** Drop the lock. Named so every exit reads the same at the call site. */
  function releaseLock(): void {
    // Only tick when a lock was actually held — releaseLock() is also called
    // defensively when the target dies or leaves range, and a tick with no
    // preceding lock reads as a phantom input.
    if (lockOnId !== null) audio.play('lock_off');
    lockOnId = null;
  }

  /**
   * Acquire, or release if already locked. Returns the new state.
   *
   * Silently does nothing when there is nothing to lock: a toggle that clears
   * your existing target because you pressed it while the next enemy was a
   * metre out of range would be worse than unresponsive.
   */
  function toggleLock(): boolean {
    if (lockOnId !== null) { releaseLock(); return false; }
    if (isDead || panels.isOpen || flyMode) return false;
    const picked = pickLockTarget(
      buildLockCandidates(), controller.pos[0], controller.pos[2], orbitCam.yaw);
    if (picked === null) return false;
    lockOnId = picked;
    audio.play('lock_on');
    return true;
  }

  /** Flick left/right through the live targets without dropping the lock. */
  function cycleLock(dir: number): void {
    if (lockOnId === null) return;
    const next = cycleLockTarget(
      buildLockCandidates(), lockOnId,
      controller.pos[0], controller.pos[2], orbitCam.yaw, dir);
    if (next !== null && next !== lockOnId) {
      lockOnId = next;
      audio.play('lock_on');
    }
  }

  /**
   * Per-FRAME (not per sim step): hold the camera on the target and decide
   * whether the lock survives.
   *
   * Wall-clock delta for the same reason `stepBowFirstPerson` uses one — this
   * is camera framing, not simulation, and easing it on SIM_DT would move the
   * camera at a different speed on a 30 fps machine than on a 144 fps one.
   */
  function stepLockOn(dtWall: number): void {
    if (lockOnId === null) return;
    if (isDead || flyMode) { releaseLock(); return; }

    const px = controller.pos[0], pz = controller.pos[2];
    const t = lockedCandidate();
    const why = lockBreakReason(t, px, pz);
    if (why !== null) {
      // A target that died under your sword should hand you the next one that
      // is already in your face, not dump you back into free look mid-swing.
      // Out of range or gone entirely is a real disengagement, so that breaks.
      const next = why === 'dead'
        ? pickLockTarget(buildLockCandidates(), px, pz, orbitCam.yaw)
        : null;
      lockOnId = next;
      if (next === null) return;
    }
    const cur = lockedCandidate();
    if (cur === undefined) { releaseLock(); return; }

    orbitCam.yaw = easeAngle(
      orbitCam.yaw, lockCameraYaw(px, pz, cur.x, cur.z), LOCK_EASE_PER_S, dtWall);
  }

  function stepBowFirstPerson(dtS: number): void {
    const want = bowFirstPersonTarget();
    const k = Math.min(1, FP_EASE_PER_S * dtS);
    orbitCam.firstPerson += (want - orbitCam.firstPerson) * k;
    // Snap the last sliver, or the boom sits at a few centimetres for ever and
    // the player mesh never quite decides whether it is drawn.
    if (Math.abs(orbitCam.firstPerson - want) < 0.004) orbitCam.firstPerson = want;
  }

  /** Abort a draw without spending an arrow (panel opened, lock lost, death). */
  function cancelBowDraw(): void {
    bowDrawing = false;
    bowDrawT = 0;
  }

  /**
   * Begin drawing. Returns false when the bow cannot shoot at all, so the
   * left-click priority chain falls through to the next step.
   */
  function tryStartBowDraw(): boolean {
    if (!bowEquipped()) return false;
    if (bowDrawing) return true;
    if (simTime - lastBowShotS < BOW_REFIRE_S) return true; // consumed; still cooling
    if (ammoInHand() === null) {
      // "No arrows" only when BOTH quivers are dry. `ammoInHand` already falls
      // back tintreach → flint, so a null here with Tintreach in the pack can
      // only mean "flint selected, flint empty" — a different mistake, and one
      // that gets its own line. "No arrows" with twelve bolts in the pack
      // reads as a bug rather than as an instruction.
      setGatherNotice(countItem(inventory, AMMO_ITEM.tintreach) > 0
        ? 'No flint arrows — X for Tintreach' : 'No arrows');
      return true; // consumed the action (show notice, no shot)
    }
    bowDrawing = true;
    bowDrawT = 0;
    audio.play('bow_draw');
    return true;
  }

  // -------------------------------------------------------------------------
  // Aiming (see aim.ts for the geometry and the measurements)
  // -------------------------------------------------------------------------

  /** How far the aim ray looks for something to converge on, metres. */
  const AIM_MAX_DIST = 160;

  /** Reused candidate buffer — the aim resolve runs ~15 Hz, never allocate. */
  const aimCandidates: AimCandidate[] = [];

  /**
   * What the crosshair is over, and how far away it is.
   *
   * The ray is the CAMERA's, because screen centre is the camera's forward
   * ray and nothing else. `orbitCam.eye()` is recomputed here rather than read
   * from the last frame so that `__gameDebug.fireArrow`, which sets a heading
   * and looses in the same tick, aims at the heading it just set instead of at
   * wherever the camera was pointing last frame.
   *
   * The candidate spheres deliberately mirror `resolveProjectileHit` exactly —
   * same centres, same radii, same skips. If they drift apart the reticle
   * starts naming something the arrow cannot hit, which is the one failure a
   * crosshair must never have.
   */
  function resolveAimTarget(): AimTarget {
    const dir = orbitCam.forward();
    const eye = orbitCam.eye(camAnchor());
    aimCandidates.length = 0;
    const targets: Iterable<import('./entities/entity-manager').EntityState> =
      dungeonManager.isInside
        ? dungeonManager.dungeonEnemies()
        : entityManager.entities.values();
    for (const e of targets) {
      if (e.mode === 'dead') continue;
      if (e.id === mountedEntityId) continue;   // never aim at your own mount
      const size = SPECIES_DEFS[e.species].size;
      aimCandidates.push({
        id: e.id,
        name: SPECIES_DEFS[e.species].name,
        x: e.x, y: e.y + size * 0.5, z: e.z,
        radius: 0.8 * Math.max(1, size),
      });
    }
    if (!dungeonManager.isInside) {
      for (const rt of npcRuntimes) {
        if (rt.hp <= 0) continue;
        aimCandidates.push({
          id: rt.npc.id, name: rt.npc.name,
          x: rt.wx, y: rt.wy + 0.9, z: rt.wz, radius: 0.7,
        });
      }
    }
    // The arrow's own floor test and the aim ray's must be the SAME test, or
    // the reticle marks a surface the arrow flies straight through. Outdoors
    // that is the raw heightfield; in a dungeon it is the dungeon's floor
    // plane — see the matching hook in `tickProjectiles`.
    //
    // Walls are handled by clamping the ray's reach rather than by a fourth
    // callback, and that placement is the whole fix: EVERY candidate test
    // inside `resolveAim` is bounded by `maxDist`, so one clamp stops the
    // crosshair naming a skeleton three rooms away through solid rock — and
    // therefore stops the Tintreach hitscan, which lands exactly where the
    // crosshair marked, from reaching it.
    const inDungeon = dungeonManager.isInside;
    const floorY = dungeonManager.floorY;
    const maxDist = inDungeon
      ? dungeonManager.rayWallDist(eye, dir, AIM_MAX_DIST)
      : AIM_MAX_DIST;
    return resolveAim(eye, dir, aimCandidates,
      inDungeon ? () => floorY ?? -1e9
        : (x, z) => chunkManager.ground.heightAt(x, z),
      maxDist);
  }

  /** Launch point for an arrow: the archer's chest, or the saddle when riding. */
  function bowMuzzle(): [number, number, number] {
    return [controller.pos[0], controller.pos[1] + 1.2, controller.pos[2]];
  }

  /**
   * Loose the arrow. Consumes 1 arrow. Damage and speed scale with draw.
   * Launch is from the player's chest — which, while mounted, is the saddle,
   * so a rider shoots from over the mount's shoulders rather than out of its
   * ribcage.
   *
   * The velocity is the BALLISTIC solve onto the aim point, not a copy of the
   * camera direction. Firing parallel to the camera was wrong twice over: it
   * left the ~0.25 m chest-to-pivot parallax in (worst up close, exactly like
   * the breath weapon's dead zone — see breath-cone.ts), and, far more
   * importantly, it ignored `PROJECTILE_GRAVITY` entirely. A full-draw arrow
   * falls 1.5 m over 20 m and 9.4 m over 50 m, so "point at the deer" was
   * never going to hit the deer and nothing on screen said so. Converging on
   * the look point fixes the first; solving the elevation fixes the second and
   * is what makes the reticle able to tell the truth.
   */
  function releaseBowDraw(): void {
    if (!bowDrawing) return;
    const power = currentDrawPower();
    bowDrawing = false;
    bowDrawT = 0;

    const heldId2 = equipped(inventory);
    if (heldId2 !== 'hunter_bow' && heldId2 !== 'composite_bow') return;
    const ammo = ammoInHand();
    if (ammo === null) { setGatherNotice('No arrows'); return; }

    const baseDamage = heldId2 === 'composite_bow' ? 9 : 6;
    const damage = Math.max(1, Math.round(baseDamage * (0.45 + 0.55 * power)));
    removeItem(inventory, AMMO_ITEM[ammo], 1);

    // NOTHING BELOW MAY REFUSE THE SHOT — sky, ground, a wall, or nothing at
    // all. Both branches converge on the point the reticle marked and neither
    // consults it for permission.
    const aim = resolveAimTarget();
    const muzzle = bowMuzzle();

    if (ammo === 'tintreach') {
      // Hitscan, not ballistic. There is no launch direction to solve and no
      // gravity to compensate: the bolt is AT the mark on the frame it is
      // loosed. The projectile spawns ON the aim point with 1 cm/s of
      // velocity, so the ordinary hit resolution finds the target on the next
      // sim step and damage, crime, audio and the stuck-shaft lifecycle all
      // come for free instead of being forked. See tintreach.ts.
      spawnProjectile(projectilePool, fireTintreach({
        muzzle, aimPoint: aim.point, onTarget: aim.isTarget, damage,
        nowS: simTime,
      }));
      saveTintreach();
      // Its own cue, not the weather's. The recipe's crack/sizzle/decay stages
      // are cut to STRIKE_S / BURN_S / LIFE_S from tintreach.ts, so the sound
      // and the light are the same event rather than two that nearly line up.
      audio.play('tintreach_bolt', { intensity: 1 });
    } else {
      // BALLISTIC. The velocity is the arc solve onto the aim point, not a copy
      // of the camera direction — firing parallel to the camera was wrong twice
      // over, and both mistakes are recorded in this function's doc comment and
      // in aim.ts. `aimVelocity` derives the direction from the REAL launch
      // point (so parallax cannot exist) and solves the elevation (so the ARC,
      // not the initial ray, passes through the mark).
      const speed = arrowSpeed(power);
      const solved = aimVelocity(muzzle, aim.point, speed, PROJECTILE_GRAVITY);
      // Null means no arc of this draw reaches that point. The answer is to
      // fire straight at it and let it fall short — the reticle already said
      // 'out of range', the player loosed anyway, and it costs them an arrow,
      // which is the correct price and theirs to pay. See aim.ts.
      const dir = solved ?? unitTo(muzzle, aim.point);
      spawnProjectile(projectilePool, {
        kind: 'arrow', team: 'player',
        x: muzzle[0], y: muzzle[1], z: muzzle[2],
        vx: dir[0] * speed, vy: dir[1] * speed, vz: dir[2] * speed,
        damage, nowS: simTime,
      });
      // The roster has a real bowstring now, so the ordinary shot no longer
      // borrows the sword's whoosh. Tintreach has `tintreach_bolt`, which is
      // the whole point of telling the two shots apart by ear.
      audio.play('bow_loose');
    }

    invChanged();

    lastBowShotS = simTime;
    bowLooseT = BOW_LOOSE_S;
    bowLoosePower = power;
  }

  /** Unit vector from `a` to `b`; +Z when they coincide (nothing to aim at). */
  function unitTo(
    a: readonly [number, number, number], b: readonly [number, number, number],
  ): [number, number, number] {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return [0, 0, 1];
    return [dx / len, dy / len, dz / len];
  }

  // -------------------------------------------------------------------------
  // Reticle
  // -------------------------------------------------------------------------

  /**
   * Will a shot loosed RIGHT NOW actually arrive at the point the crosshair is
   * marking?
   *
   * The reticle has to tell the truth about both quivers, and they are two
   * different truths.
   *
   * A Tintreach bolt has no arc and no drop, so nothing is ever out of range
   * and the reticle must never claim it is.
   *
   * A flint arrow falls. `aimVelocity` returns null when no arc of the CURRENT
   * draw reaches the mark — max range is `speed^2 / g`, so a tap draw at
   * 24.95 m/s tops out at 63.5 m and a full draw at 36 m/s at 132 m — which is
   * why the crosshair splays open as you look further out and closes again as
   * you pull the string. That is the readout the player had no way to get
   * before, and it is what makes the drop learnable rather than mysterious.
   *
   * It is a READOUT and never permission: `releaseBowDraw` fires regardless and
   * lets the arrow fall short. A separate function rather than an expression
   * inside `updateReticle` so `__gameDebug.aimTarget` can report the SAME
   * answer the crosshair is drawing — the alternative was a probe asserting
   * against `lastAimMode`, which headless never updates because there is no
   * pointer lock, so it read a stale 'aim' forever and scored it green.
   */
  function shotReaches(aim: AimTarget, ammo: AmmoKind): boolean {
    if (ammo === 'tintreach') return true;
    return aimVelocity(bowMuzzle(), aim.point,
      arrowSpeed(currentDrawPower()), PROJECTILE_GRAVITY) !== null;
  }

  const reticle = new Reticle();
  /** The Z-target marker. Positioned from the render matrices each frame. */
  const lockIndicator = new LockIndicator();
  /** Throttle for the aim resolve: the ray test is cheap, 60 Hz of it is not. */
  let reticleAccum = 0;
  const RETICLE_HZ = 15;

  /**
   * Show the aiming mark whenever a bow is in hand, and say what is under it.
   *
   * Only the aim RESOLVE is throttled; the show/hide decision runs every frame
   * so putting the bow away or opening a panel clears the crosshair instantly.
   */
  function updateReticle(dtS: number): void {
    const live = bowEquipped() && vitals.alive && !panels.isOpen
      && !flyMode && document.pointerLockElement === canvas;
    if (!live) { reticle.hide(); reticleAccum = 0; return; }
    const ammo = ammoInHand();
    if (ammo === null) {
      reticle.update('empty', false, null, 0);
      return;
    }
    reticleAccum += dtS;
    if (reticleAccum < 1 / RETICLE_HZ && lastAim !== null) {
      reticle.update(lastAimMode, bowDrawing, lastAim.name, lastAim.dist);
      return;
    }
    reticleAccum = 0;
    const aim = resolveAimTarget();
    const reachable = shotReaches(aim, ammo);
    lastAim = aim;
    // "Out of range" is only meaningful when the ray actually found something.
    // On a level look the ray runs to the horizon and finds nothing, and
    // flagging that would put a warning on screen most of the time the player
    // is simply looking ahead. It is a readout, not a permission: the shot
    // fires either way (see releaseBowDraw).
    lastAimMode = (!reachable && aim.kind !== 'none') ? 'far'
      : aim.isTarget ? 'target' : 'aim';
    reticle.update(lastAimMode, bowDrawing, aim.name, aim.dist);
  }

  let lastAim: AimTarget | null = null;
  let lastAimMode: ReticleMode = 'aim';
  let reticleLastMs = 0;

  /**
   * Eased 0..1 riding-seat weight for the player mesh. Mounting and
   * dismounting cross it in ~0.2 s so the rider folds into the saddle rather
   * than snapping between two frozen poses.
   */
  let seatBlend = 0;

  // -------------------------------------------------------------------------
  // Shelter — is there anything over the player's head?
  //
  // `inDungeon` covers the dungeon and building ARENAS, and the castle is
  // deliberately not one of those: it is ordinary world geometry so that
  // terrain keeps streaming under it and the sky keeps rendering over it. The
  // consequence nobody had joined up is that weather never asked about roofs,
  // so rain fell through three storeys of keep and drops landed on the floor of
  // the great hall.
  //
  // The test is "is there a ceiling above this point", NOT "is the player
  // inside the castle": the courtyard is inside the walls and open to the sky,
  // and it must stay wet. `CastleCollider.isRoofed` is the Y-aware per-storey
  // query that already answers this for the camera, and it early-outs on a
  // bucket lookup outside the castle footprint, so this costs nothing anywhere
  // else in the world.
  // -------------------------------------------------------------------------

  /** 0 = open sky, 1 = fully under cover. Eased, never stepped. */
  let shelter = 0;
  /**
   * The rain intensity actually handed to the renderer last frame.
   *
   * Recorded so a harness can assert on what was DRAWN rather than on what the
   * weather says. "It looks drier indoors" is not a number, and the rain
   * overlay's apparent density depends on where the camera is pointing.
   */
  let lastFrameRainLevel = 0;
  let shelterLastMs = performance.now();
  /**
   * Ease rate, matching the first-person bow blend — ~0.16 s to 90%.
   *
   * Fading rather than cutting is the whole difference between "the rain stops
   * as you step through the great door" and "the rain teleports". A hard cut on
   * a single frame reads as a rendering fault.
   */
  const SHELTER_EASE_PER_S = 14;

  /** True when the player's head is under castle masonry. */
  function underCastleRoof(): boolean {
    return castleManager.collider.isRoofed(
      controller.pos[0], controller.pos[1] + PLAYER_HEIGHT * 0.9, controller.pos[2]);
  }

  function stepShelter(inInterior: boolean, nowMs: number): void {
    const dtS = Math.min(0.1, (nowMs - shelterLastMs) / 1000);
    shelterLastMs = nowMs;
    const want = (inInterior || underCastleRoof()) ? 1 : 0;
    shelter += (want - shelter) * Math.min(1, SHELTER_EASE_PER_S * dtS);
    if (Math.abs(shelter - want) < 0.004) shelter = want;
  }

  /** Advance the draw / follow-through / seat clocks. Called once per sim step. */
  function tickBow(dtS: number): void {
    const seatTarget = mountedEntityId !== null ? 1 : 0;
    seatBlend += (seatTarget - seatBlend) * Math.min(1, dtS * 6);
    if (Math.abs(seatBlend - seatTarget) < 0.002) seatBlend = seatTarget;
    if (bowDrawing) {
      // Anything that takes the player's hands off the bow cancels the draw.
      if (!bowEquipped() || panels.isOpen || !vitals.alive
          || document.pointerLockElement !== canvas) {
        cancelBowDraw();
      } else {
        bowDrawT = Math.min(BOW_DRAW_S * 1.5, bowDrawT + dtS);
      }
    }
    if (bowLooseT > 0) bowLooseT = Math.max(0, bowLooseT - dtS);
  }

  // -------------------------------------------------------------------------
  // Projectile hit resolution (the world-aware half; storage is projectiles.ts)
  // -------------------------------------------------------------------------

  /**
   * Test an ENEMY projectile against the player, and route the damage.
   *
   * This is the one place a ranged attack can reach a mounted rider, which is
   * the whole point of ranged attackers existing: see attack-routing.ts.
   */
  function resolveEnemyProjectileHit(p: Projectile): import('./projectiles').ProjectileHit | null {
    if (!vitals.alive) return null;
    const px = controller.pos[0];
    const pz = controller.pos[2];
    // Player capsule: feet at pos[1], ~1.7 m tall, ~0.55 m hit radius.
    const dx = px - p.x;
    const dz = pz - p.z;
    if (dx * dx + dz * dz > 0.55 * 0.55) return null;
    const footY = controller.pos[1];
    if (p.y < footY - 0.2 || p.y > footY + PLAYER_HEIGHT + 0.2) return null;

    const routing = routePlayerDamage('ranged', { size: 1.7, y: p.y }, riderState());
    if (routing.target === 'player') {
      // ARROWS ARE BLOCKABLE, AND NOT PARRYABLE. Classic Zelda blocks a frontal
      // arrow and so does this: a shield you have to drop to deal with archers
      // is a shield that stops being a shield the moment a fight gets
      // interesting. It is `kind: 'projectile'`, so `resolveBlock` gives it the
      // cone test and the full stamina cost but never the parry window —
      // there is no windup on an arrow for the player to read, so a parry would
      // be a coin flip dressed as skill.
      //
      // `p.ox/p.oz` is where the shot was FIRED FROM, not where it is now. That
      // is the correct input to a cone test the player experiences as "which
      // way is it coming from": an arrow's own position is a point already
      // inside the player's capsule and its bearing is meaningless. It is also
      // what keeps this path in agreement with the melee one, which uses the
      // attacker's body.
      const landed = guardIncoming(p.damage, {
        x: p.ox, z: p.oz, kind: 'projectile',
      });
      if (landed > 0) {
        damagePlayer(vitals, landed, 'combat', totalDefense(inventory));
        triggerDamageFlash();
        audio.play('hurt');
        saveVitals(vitals);
      }
    } else if (routing.target === 'mount') {
      damageMount(p.damage);
    }
    return { anchorId: null, anchorX: p.x, anchorY: p.y, anchorZ: p.z };
  }

  /** Update projectiles in the sim loop (called each tick). */
  function tickProjectiles(dt: number): void {
    // Underground, `heightAt` used to return -1e9 — "there is no terrain here"
    // — which is true of the heightfield and disastrous as a floor: every
    // arrow that missed fell through the dungeon and out of the world, and no
    // arrow ever stopped on anything but a body. The floor is the dungeon's
    // own plane, and the walls and ceiling come through `solidAt`, which the
    // heightfield cannot express. See dungeon-manager's geometry-query note.
    const inDungeon = dungeonManager.isInside;
    const dFloor = dungeonManager.floorY;
    stepProjectiles(projectilePool, dt, simTime, {
      // CARVED, matching `resolveAimTarget` exactly. These two must name the
      // same surface or the reticle marks a road the arrow flies through — and
      // outdoors the surface the player can see is the one with the roads cut
      // into it, not the land as originally generated.
      heightAt: (x, z) =>
        (inDungeon ? (dFloor ?? -1e9) : chunkManager.ground.heightAt(x, z)),
      resolveHit: (p) => resolveProjectileHit(p),
      solidAt: inDungeon
        ? (x, y, z) => dungeonManager.solidAt(x, y, z)
        : undefined,
    });
    // Arrows stuck in a creature ride it; arrows in a corpse that has been
    // looted away go with it rather than hanging in the air.
    followAnchors(projectilePool, (id) => {
      const e = dungeonManager.isInside
        ? dungeonManager.dungeonEnemies().find(en => en.id === id)
        : entityManager.entities.get(id);
      if (e !== undefined) return { x: e.x, y: e.y, z: e.z };
      const rt = npcRuntimes.find(r => r.npc.id === id);
      if (rt !== undefined && rt.hp > 0) return { x: rt.wx, y: rt.wy, z: rt.wz };
      return null;
    });
  }

  /** One projectile's hit test + consequences. Returns the anchor it lodged in. */
  function resolveProjectileHit(p: Projectile): import('./projectiles').ProjectileHit | null {
    if (p.team === 'enemy') return resolveEnemyProjectileHit(p);
    {
      // Hit-radius per kind.
      const hitRadius = p.kind === 'arrow' ? 0.8 : 1.2;

      // Entity hit-test: check all live entities (dungeon or overworld) within hit radius.
      let hit: import('./projectiles').ProjectileHit | null = null;
      const projTargets: Iterable<import('./entities/entity-manager').EntityState> =
        dungeonManager.isInside
          ? dungeonManager.dungeonEnemies()
          : entityManager.entities.values();
      for (const e of projTargets) {
        if (e.mode === 'dead') continue;
        // Never shoot the animal you are sitting on. Without this, a mounted
        // archer's own arrow spawns inside the mount's hit sphere and kills it.
        if (e.id === mountedEntityId) continue;
        // ...and no damage through masonry, even when the projectile itself
        // was stopped by it. Stopping the arrow is not sufficient on its own:
        // the hit radius is `0.8 * max(1, size)`, which for a Dread King is
        // 2.16 m, so an arrow still on the near side of a wall is already
        // inside the hit sphere of something standing against the far side.
        // Measured — a boss 2.24 m away behind solid rock lost 9 hp to a flint
        // arrow and 18 to a bolt, neither of which ever left the room.
        //
        // Tested from where the shot was FIRED, not from where the arrow is
        // now. `cellLineOfSight` ignores solid cells within 0.75 m of either
        // endpoint — a deliberate concession so a chest in a corner stays
        // reachable — so by the time an arrow has crossed most of a 2 m gap it
        // is too close to its target for the test to see the wall between them.
        // The shooter's position is the question that has a stable answer, and
        // it is the same line the melee gate uses.
        if (dungeonManager.isInside
            && !dungeonManager.seesFrom(p.ox, p.oz, e.x, e.z)) continue;
        const specSize = SPECIES_DEFS[e.species].size;
        // Scale hit radius by entity size (larger targets easier to hit).
        const effectiveRadius = hitRadius * Math.max(1, specSize);
        const dx = e.x - p.x;
        const dz = e.z - p.z;
        const dy = e.y + specSize * 0.5 - p.y; // aim for body centre
        const dist3 = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist3 > effectiveRadius) continue;

        hit = { anchorId: e.id, anchorX: e.x, anchorY: e.y, anchorZ: e.z };

        // Apply damage via the same path as melee.
        e.hp = Math.max(0, e.hp - p.damage);
        if (e.hp <= 0) {
          e.mode = 'dead';
          if (e.deadAtS === undefined) e.deadAtS = simTime;
          if (dungeonManager.isInside) {
            setGatherNotice(`Killed ${SPECIES_DEFS[e.species].name}!`);
            // Pay the kill out. `attackDungeonEnemy` does this too, but its
            // only caller is __gameDebug — a real arrow finds the enemy in
            // `dungeonEnemies()` and decrements hp right here, so without this
            // line a dungeon cleared by shooting it dropped nothing at all.
            dungeonManager.notifyPlayerKill(e.id, simTime);
          } else {
            entityManager.killEntity(e.id);
            setGatherNotice(`Killed ${SPECIES_DEFS[e.species].name}!`);
            // Crime: kill_owned_animal if npcOwned
            if (e.npcOwned) {
              const ridP = nearestRegionId();
              const witnessedP = npcRuntimes.some(rt => {
                if (!npcCanWitness(rt)) return false;
                const d = Math.hypot(rt.wx - controller.pos[0], rt.wz - controller.pos[2]);
                return d <= WITNESS_RADIUS;
              });
              if (witnessedP) {
                reportCrime(crimeState, ridP, 'kill_owned_animal', simTime);
                saveCrimeState(crimeState);
              }
            }
          }
        } else {
          onEntityDamaged(e);
          if (!dungeonManager.isInside && e.npcOwned) {
            const ridP = nearestRegionId();
            const witnessedP = npcRuntimes.some(rt => {
              if (!npcCanWitness(rt)) return false;
              const d = Math.hypot(rt.wx - controller.pos[0], rt.wz - controller.pos[2]);
              return d <= WITNESS_RADIUS;
            });
            if (witnessedP) {
              reportCrime(crimeState, ridP, 'assault', simTime);
              saveCrimeState(crimeState);
            }
          }
        }
        break; // one hit per projectile
      }

      // Feature 4: Projectiles also hit NPC runtimes (overworld only).
      if (hit === null && !dungeonManager.isInside) {
        const npcHitRadius = p.kind === 'arrow' ? 0.7 : 1.0;
        for (const rt of npcRuntimes) {
          if (rt.hp <= 0) continue;
          const dx4 = rt.wx - p.x;
          const dz4 = rt.wz - p.z;
          const dy4 = rt.wy + 0.9 - p.y; // aim for body centre
          const dist4 = Math.sqrt(dx4 * dx4 + dy4 * dy4 + dz4 * dz4);
          if (dist4 > npcHitRadius) continue;
          hit = { anchorId: rt.npc.id, anchorX: rt.wx, anchorY: rt.wy, anchorZ: rt.wz };
          // Apply damage.
          rt.hp = Math.max(0, rt.hp - p.damage);
          audio.play('hit');
          if (rt.hp <= 0) {
            onNpcKilled(rt);
          } else {
            // Non-lethal hit: civilians become afraid, not flee.
            if (rt.npc.role === 'guard') {
              rt.attitude = 'hostile';
            } else {
              rt.attitude = 'afraid';
              rt.fleeing = true;
            }
          }
          // Crime detection: assault/murder witnessed by another NPC.
          const ridProj = nearestRegionId();
          const killedByProj = rt.hp <= 0;
          const crimeKindProj = killedByProj ? 'murder' as const : 'assault' as const;
          const witnessedProj = npcRuntimes.some(other => {
            if (other === rt || !npcCanWitness(other)) return false;
            const d = Math.hypot(other.wx - controller.pos[0], other.wz - controller.pos[2]);
            return d <= WITNESS_RADIUS;
          });
          if (witnessedProj) {
            reportCrime(crimeState, ridProj, crimeKindProj, simTime);
            saveCrimeState(crimeState);
            setGatherNotice(`${killedByProj ? 'Murder' : 'Assault'}! Bounty +${BOUNTY_AMOUNTS[crimeKindProj]}`);
          }
          break;
        }
      }

      return hit;
    }
  }

  // -------------------------------------------------------------------------
  // Left-click: 8-step priority resolver (Phase H + ranged combat)
  // -------------------------------------------------------------------------
  // Left-click while locked in — priority chain (first match wins):
  //  1. Gather node in range              } skipped in the saddle
  //  2. Placeable selected (campfire_kit, tent items)
  //  3. Fill container at fresh water
  //  4. Consume edible/drinkable
  //  5. Ignite fire (fire_starter or torch aimed at unlit campfire)
  //  6. Bow draw (hunter_bow / composite_bow) — hold to draw, release to loose
  //  7. Throw stone (or other throwable)
  //  8. Attack swing (fallback)
  //
  // MOUNTED INPUT SCHEME. Left-click is the RIDER's attack, mounted or not —
  // the same button, the same weapons, the same feel; nothing to relearn when
  // you climb into a saddle. The MOUNT's own weapons stay where they were, on
  // F (breath / stomp) and G (bite), so the two can never contend for an
  // input: one button belongs to the person, two keys belong to the animal,
  // and you can loose an arrow mid-fire-breath because they are separate
  // hands. Steps 1–5 are world interactions that make no sense at saddle
  // height (you cannot chop a tree or fill a waterskin from a flying dragon)
  // and are skipped while mounted so they can never swallow the attack.
  /**
   * Toggle stay/sit on the nearest owned animal. Extracted so it has a home on
   * `T` as well as on the right button — see the RMB handler below for why it
   * needed one.
   */
  function togglePetStay(): void {
    let bestStay: import('./entities/entity-manager').EntityState | null = null;
    let bestStayDist = 4;
    for (const ent of entityManager.entities.values()) {
      if (ent.owned !== true || ent.mode === 'dead') continue;
      if (ent.id === mountedEntityId) continue;
      const d = Math.hypot(ent.x - controller.pos[0], ent.z - controller.pos[2]);
      if (d < bestStayDist) { bestStayDist = d; bestStay = ent; }
    }
    if (bestStay === null) return;
    bestStay.staying = bestStay.staying !== true;
    const stayName = SPECIES_DEFS[bestStay.species].name;
    setGatherNotice(bestStay.staying
      ? `The ${stayName} sits and stays here. (T to call)`
      : `The ${stayName} follows you again.`);
  }

  // -------------------------------------------------------------------------
  // Right button: RAISE THE SHIELD, or — when you are not carrying one — the
  // old pet stay/follow toggle.
  //
  // Every mouse button was already taken when shields arrived: left is
  // gather/attack/draw, middle is Z-targeting, right was the pet toggle. One of
  // them had to give, and it is not a close call — blocking is a core combat
  // verb used several times a second in every fight, and telling a tamed wolf
  // to sit is a convenience used a handful of times a session.
  //
  // So the right button is CONDITIONAL, and deliberately so rather than simply
  // reassigned: a player with no shield in their hotbar — which is every player
  // before they craft one, and the whole of the existing save-game population —
  // sees no change at all. The pet toggle also gains an unconditional home on
  // `T`, so it is never unreachable for the shield-carrying player; the
  // notice text above says T rather than right-click for that reason.
  //
  // `__pad` bypasses the pointer-lock gate exactly as the left-button handler
  // does: a pad player never acquires pointer lock, and without it RB could
  // not block at all — the same defect RT once had.
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 2 || flyMode || panels.isOpen) return;
    if (document.pointerLockElement !== canvas
      && !(e as { __pad?: boolean }).__pad) return;
    if (shieldTier() !== null) {
      if (!vitals.alive) return;
      // The press EDGE is the parry window's origin. `setGuardInput` ignores
      // anything that is not a transition, so a key-repeat-style storm of
      // mousedowns cannot re-arm it.
      setGuardInput(guard, true, simTime);
      return;
    }
    togglePetStay();
  });
  window.addEventListener('mouseup', (e) => {
    // Unconditional, and NOT gated on pointer lock or on still carrying a
    // shield. Releasing the button must always drop the guard: dropping a
    // shield from the hotbar mid-block, or letting go with the cursor outside
    // the canvas, would otherwise leave it raised with no way to lower it.
    if (e.button !== 2) return;
    setGuardInput(guard, false, simTime);
  });
  window.addEventListener('contextmenu', (e) => {
    if (document.pointerLockElement === canvas) e.preventDefault();
  });

  //
  // Extracted from the listener so it can be exercised without a mouse.
  // Pointer lock is unobtainable in headless Chrome, so the listener body was
  // unreachable to every automated check — a mounted melee swing could have
  // been broken and nothing would have caught it.
  function resolveLeftClick(): void {
    if (attackT < 1) return; // swing still in progress
    // BLOCK AND ATTACK ARE MUTUALLY EXCLUSIVE, in this direction only.
    //
    // You cannot swing behind a raised shield — that is the cost that stops
    // blocking from being strictly free, and the reason a fight has a rhythm
    // rather than being "hold RMB, click forever". The other direction is
    // deliberately open: raising the guard mid-swing is allowed, because a
    // shield that refuses to come up for the third of a second an axe takes to
    // recover feels like the game ignoring the button, and a swing that is
    // already out cannot be un-thrown anyway.
    //
    // The gate is here rather than in the listener so the pad's synthesised
    // click, the mouse, and any harness driving `resolveLeftClick` all obey it.
    if (blocking()) return;

    const heldId2 = equipped(inventory);
    const isMounted = mountedEntityId !== null;

    // The bow is checked BEFORE the swing bookkeeping: drawing a string is not
    // a swing, and stamping attackT here would start a chop under the aim pose.
    if (bowEquipped()) {
      if (tryStartBowDraw()) return;
    }

    attackT = 0;
    // Mounted, the mount's facing is the body's facing (tickMount owns yaw) —
    // snapping the rider to the camera would spin them in the saddle.
    if (!isMounted) controller.yaw = -orbitCam.yaw;
    audio.play('swing'); // Feature 10: melee swing SFX

    // Steps 1-5 are ground interactions. From the saddle they are either
    // impossible or actively harmful (placing a campfire under a flying
    // dragon), and every one of them would eat the click before the attack.
    if (!isMounted) {
      // 1. Gather node in range
      const node = resourceManager.nearestNode(controller.pos, GATHER_REACH, gameNowMs());
      if (node !== null) {
        tryGather();
        return;
      }

      // Phase K: 1b. Feed animal if held item matches favorite food
      if (tryFeedAnimal()) return;

      // 2. Placeables
      if (heldId2 === 'campfire_kit') {
        tryPlaceCampfire();
        return;
      }
      if (heldId2 === 'fiber_tent' || heldId2 === 'wool_tent' || heldId2 === 'hide_tent') {
        tryPlaceTent(heldId2 as 'fiber_tent' | 'wool_tent' | 'hide_tent');
        return;
      }
      // Phase K: 2b. Place egg
      if (heldId2 !== null && eggSpeciesFor(heldId2) !== null) {
        tryPlaceEgg();
        return;
      }

      // 3. Fill container at fresh water
      if (tryFillContainer()) return;

      // 4. Consume edible/drinkable
      if (heldId2 !== null) {
        const def2 = itemDef(heldId2);
        if (def2.edible || def2.drinkable) {
          tryConsumeHeldItemLeftClick();
          return;
        }
      }

      // 5. Ignite fire (fire_starter or torch + unlit campfire in range)
      if (tryIgniteFire()) return;
    }

    // 7. Throw stone or throwable
    if (tryThrow()) return;

    // 8. Fallback: hit-test entities, then attack swing animation.
    // Entity hit: within 3.2 m and roughly facing (dot > 0.3).
    {
      // Every melee swing costs stamina (one-shot drain: 3 × 1 s).
      drainStamina(vitals, 3, 1);
      // From a saddle the rider swings from higher up and further out, so the
      // reach grows with the mount. A rider on a dragon (size 3.5) has to be
      // able to hit what is standing beside its shoulder, not just what is
      // pressed against its ribs.
      const mountedOn = isMounted && mountedEntityId !== null
        ? entityManager.entities.get(mountedEntityId) : undefined;
      const ENTITY_HIT_DIST = 3.2
        + (mountedOn !== undefined ? SPECIES_DEFS[mountedOn.species].size : 0);
      // Vertical gate: a rider 30 m up cannot swing a sword at the ground.
      //
      // Measured from the MOUNT'S BASE, not from the saddle — the same
      // reference attack-routing.ts uses for blows coming the other way. The
      // first version measured from the rider's seat, which put a dragon's
      // saddle 3.5 m above a deer's chest and 2.9 m of that against a 3.7 m
      // budget: it worked on flat ground and silently missed on any slope.
      // If the mount is standing next to something, its rider can hit it.
      const MELEE_VERTICAL_REACH = 2.5;
      const meleeOriginY = mountedOn !== undefined
        ? controller.pos[1] - SPECIES_DEFS[mountedOn.species].size
        : controller.pos[1];
      const px7 = controller.pos[0];
      const pz7 = controller.pos[2];
      const facingX = Math.sin(controller.yaw);
      const facingZ = -Math.cos(controller.yaw);

      // Weapon damage table by held kind.
      const heldKind7 = heldId2 !== null ? itemDef(heldId2).held : undefined;
      let weaponDmg = 1; // bare hand
      if (heldKind7 === 'sword')    weaponDmg = 4;
      else if (heldKind7 === 'axe')    weaponDmg = 3;
      else if (heldKind7 === 'pickaxe') weaponDmg = 3;
      else if (heldKind7 === 'staff')   weaponDmg = 5; // spear archetype

      let hitSomething = false;
      // When inside a dungeon, hit-test dungeon enemies; otherwise overworld entities.
      const meleeTargets: Iterable<import('./entities/entity-manager').EntityState> =
        dungeonManager.isInside
          ? dungeonManager.dungeonEnemies()
          : entityManager.entities.values();
      for (const e of meleeTargets) {
        if (e.mode === 'dead') continue;
        // Never swing at the animal you are riding.
        if (e.id === mountedEntityId) continue;
        const ex = e.x - px7;
        const ez = e.z - pz7;
        const dist7 = Math.hypot(ex, ez);
        if (dist7 > ENTITY_HIT_DIST) continue;
        // Height gate — symmetric with the rule that stops a bear reaching a
        // rider: a sword swung from 30 m up reaches nothing on the ground.
        if (Math.abs((e.y + SPECIES_DEFS[e.species].size * 0.5) - meleeOriginY)
            > MELEE_VERTICAL_REACH + SPECIES_DEFS[e.species].size) continue;
        // Facing check: dot product of facing vector and direction to entity.
        const dot7 = (dist7 > 0.001)
          ? (facingX * ex / dist7 + facingZ * ez / dist7)
          : 1;
        if (dot7 < 0.3) continue;
        // ...and the wall. A distance plus a facing dot is exactly what the
        // ENEMY side did before `dungeon-combat.ts` gated it, and it was wrong
        // for exactly the same reason: two floor cells either side of a 1 m
        // wall are 2.0 m apart against a 3.2 m reach, so any player standing
        // against a room's edge could beat on whatever was on the other face
        // of it, forever, through a metre of stone. Same `cellLineOfSight`,
        // reached through the manager — there is no second implementation.
        if (dungeonManager.isInside
            && !dungeonManager.seesFrom(px7, pz7, e.x, e.z)) continue;

        // Apply damage.
        e.hp = Math.max(0, e.hp - weaponDmg);
        audio.play('hit'); // Feature 10: entity hit SFX

        // KNOCKBACK, capped so a hit can never push its target out of the
        // reach that just landed it.
        //
        // A flat 1.2 m shove deadlocked the boss fight, and the arithmetic is
        // worth keeping because it is not obvious. The player's reach is 3.2 m;
        // a Dread King's is 4.1 m (2.5 shared + 1.6 reachBonus), and `engage`
        // stops closing the moment the target is inside its OWN reach. So:
        // swing at 2.0 m, he lands at 3.2; swing again, he lands at 4.4; he
        // walks back to 4.1 and stops — 0.9 m outside the player's reach,
        // still comfortably inside his. Two hits and then a permanent
        // stalemate in which he can hit the player and the player cannot hit
        // him, broken only by walking forward into the next 8-damage swing.
        //
        // The cap is the fix rather than a smaller constant because the
        // failure is RELATIVE: any shove at all, applied at the edge of reach,
        // does this. Up close — where a shove is meant to interrupt a charge —
        // the full 1.2 m still lands.
        const KNOCKBACK = 1.2;
        const KNOCKBACK_MARGIN = 0.35; // leaves the next swing clearly in range
        const shove = Math.min(
          KNOCKBACK, Math.max(0, ENTITY_HIT_DIST - KNOCKBACK_MARGIN - dist7));
        if (dist7 > 0.001 && shove > 0) {
          const sx = e.x + (ex / dist7) * shove;
          const sz = e.z + (ez / dist7) * shove;
          // Never shove a body into masonry: this writes x/z directly and so
          // bypasses the collider that would otherwise stop it.
          if (!dungeonManager.isInside || !dungeonManager.solidAt(sx, e.y + 0.5, sz)) {
            e.x = sx;
            e.z = sz;
          }
        }
        if (e.hp <= 0) {
          e.mode = 'dead';
          if (e.deadAtS === undefined) e.deadAtS = simTime;
          if (dungeonManager.isInside) {
            // Dungeon kill: just mark dead (no persistence needed — respawn on re-entry).
            setGatherNotice(`Killed ${SPECIES_DEFS[e.species].name}!`);
            // ...and pay it out — same reason as the projectile site above.
            dungeonManager.notifyPlayerKill(e.id, simTime);
          } else {
            entityManager.killEntity(e.id);
            setGatherNotice(`Killed ${SPECIES_DEFS[e.species].name}!`);
            // Crime: kill_owned_animal if npcOwned
            if (e.npcOwned) {
              const ridM = nearestRegionId();
              const witnessedKill = npcRuntimes.some(rt => {
                if (!npcCanWitness(rt)) return false;
                const d = Math.hypot(rt.wx - px7, rt.wz - pz7);
                return d <= WITNESS_RADIUS;
              });
              if (witnessedKill) {
                reportCrime(crimeState, ridM, 'kill_owned_animal', simTime);
                saveCrimeState(crimeState);
                setGatherNotice(`You killed an owned animal! Bounty +${BOUNTY_AMOUNTS.kill_owned_animal}`);
              }
            }
          }
        } else {
          onEntityDamaged(e);
          // Crime: assault on npcOwned animal (treated as assault if witnessed)
          if (!dungeonManager.isInside && e.npcOwned) {
            const ridM = nearestRegionId();
            const witnessed = npcRuntimes.some(rt => {
              if (!npcCanWitness(rt)) return false;
              const d = Math.hypot(rt.wx - px7, rt.wz - pz7);
              return d <= WITNESS_RADIUS;
            });
            if (witnessed) {
              reportCrime(crimeState, ridM, 'assault', simTime);
              saveCrimeState(crimeState);
            }
          }
        }
        hitSomething = true;
        break; // one hit per swing
      }
      if (hitSomething) return;

      // Phase M: also hit NPC runtimes (non-guard or guard when hostile)
      for (const rt of npcRuntimes) {
        if (rt.hp <= 0) continue;
        const nx = rt.wx - px7;
        const nz = rt.wz - pz7;
        const ndist = Math.hypot(nx, nz);
        if (ndist > ENTITY_HIT_DIST) continue;
        if (Math.abs(rt.wy + 0.9 - meleeOriginY) > MELEE_VERTICAL_REACH + 1.5) continue;
        const ndot = ndist > 0.001 ? (facingX * nx / ndist + facingZ * nz / ndist) : 1;
        if (ndot < 0.3) continue;

        rt.hp = Math.max(0, rt.hp - weaponDmg);
        rt.fleeing = true;
        // Crime detection
        const ridNpc = nearestRegionId();
        const killedNpc = rt.hp <= 0;
        if (killedNpc) onNpcKilled(rt);
        const crimeKind = killedNpc ? 'murder' as const : 'assault' as const;
        // Witness: another NPC within radius
        const witnessedNpc = npcRuntimes.some(other => {
          if (other === rt || !npcCanWitness(other)) return false;
          const d = Math.hypot(other.wx - px7, other.wz - pz7);
          return d <= WITNESS_RADIUS;
        });
        if (witnessedNpc) {
          reportCrime(crimeState, ridNpc, crimeKind, simTime);
          saveCrimeState(crimeState);
          setGatherNotice(`${killedNpc ? 'Murder' : 'Assault'}! Bounty +${BOUNTY_AMOUNTS[crimeKind]}`);
        }
        break;
      }
    }
    // (attackT was already set to 0 above)
  }

  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || flyMode || panels.isOpen) return;
    // The pad synthesises this event, and a pad-only player never acquires
    // pointer lock — without the __pad pass RT cannot attack (audio agent's
    // find). Real mice still need the lock so overlay clicks don't swing.
    if (document.pointerLockElement !== canvas
      && !(e as { __pad?: boolean }).__pad) return;
    resolveLeftClick();
  });

  // Releasing the left button looses a drawn arrow. Bound on `window` rather
  // than the canvas so letting go outside the canvas still fires instead of
  // leaving the string drawn forever; `pointerlockchange` covers the case
  // where focus is lost while held (tickBow cancels it).
  // Middle mouse toggles Z-targeting. The one genuinely free mouse button:
  // left is gather/attack/draw and right is the pet stay/follow toggle.
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 1 || flyMode || panels.isOpen) return;
    if (document.pointerLockElement !== canvas) return;
    e.preventDefault();
    toggleLock();
  });

  window.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    if (!bowDrawing) return;
    if (panels.isOpen || !vitals.alive) { cancelBowDraw(); return; }
    releaseBowDraw();
  });

  // Live debug capture (F8 snapshot / F9 auto) — see debug-capture.ts.
  const capture = new DebugCapture();

  // --- frame loop: RAF + fixed-timestep accumulator ------------------------
  let simTime = resumeState?.simTime ?? 0; // resumes the day/night clock on load

  let walkPhase = 0; // character walk cycle (radians, advances with distance)
  let walkAmp = 0;   // 0 idle → 1 full stride, smoothed
  let attackT = 1;   // 0→1 = one right-arm swing; 1 = idle (sin(π) = 0)
  let attackTOverride: number | null = null; // debug pose freeze (screenshots)
  /** Steps run by the last frame — what proves a pause did not bank time. */
  let lastFrameSteps = 0;
  let last = performance.now();
  let lastAutoPosMs = 0;
  let frameCount = 0;
  let fpsFrames = 0;
  let fpsLast = last;
  let fps = 0;

  // Idle gate for background dreaming: the Director only generates while the
  // player has been still for a while — moving/riding/fighting gets the GPU
  // to itself (fixtures cover any door reached before its spec resolves).
  const IDLE_DREAM_MS = 8000;
  let idleSince = last;
  let idleLastX = 0;
  let idleLastZ = 0;

  // Slope-gradient tracking for climb detection (two samples ~0.5 m apart).
  const SLOPE_SAMPLE = 0.5;


  /**
   * Controller support (src/game/input/gamepad.ts). Auto-detects — Steam Deck
   * Verified requires that "players must not need to adjust any in-game
   * settings in order to enable controller support" (PORTING §3.2), so the
   * only switch is an opt-OUT, and it is a dev one. A real settings toggle is
   * the follow-up; a release build has no URL bar to reach this with.
   *
   * With no pad connected `poll()` reads one array and returns.
   */
  const gamepad = new GamepadInput();
  gamepad.enabled = debugParams().get('gamepad') !== 'off';

  /**
   * The pad's hands inside the panels (src/game/input/ui-focus.ts).
   *
   * `context()` is the whole context switch in five lines: whatever it returns
   * is what the pad is driving. Death first because the death card is NOT a
   * PanelManager panel — it is a plain overlay main.ts shows by hand, and it
   * is the one screen a player MUST be able to leave, so it outranks
   * everything. Otherwise it is simply whichever panel is open.
   */
  const uiFocus = new UiFocus({
    context: () => {
      if (isDead) return { id: 'death', root: deathOverlay };
      const el = panels.openEl;
      return el === null || panels.openId === null
        ? null : { id: panels.openId, root: el };
    },
    close: () => {
      // B backs out of a panel. It does NOT back out of dying: the death card
      // has one exit and it is the Respawn button.
      if (isDead || !panels.isOpen) return false;
      // One level at a time. The pause screen can have a Settings/Controls/Help
      // sheet swapped into its body (map-panel.ts `openSheet`); B there means
      // "back to the chart", not "resume the game" — backing out two levels
      // from one press is how a player loses a screen they were reading.
      // The sheet marks its own Back button, so this is one query rather than
      // any shared state between the two files.
      const sheetBack = panels.openEl?.querySelector<HTMLElement>('[data-sheet-back]');
      if (sheetBack) {
        audio.play('ui_click');
        sheetBack.click();
        return true;
      }
      audio.play('ui_click');
      panels.close();
      return true;
    },
  });

  const gamepadHooks = {
    onLook: (dx: number, dy: number) => {
      // The same sink as a pointer-locked mousemove (see the listener above),
      // minus the pointer-lock gate: a pad player may never have clicked to
      // grab the mouse, and their camera still has to work.
      if (panels.isOpen) return;
      if (flyMode) flyCam.onMouseMove(dx, dy);
      else orbitCam.onMouseMove(dx, dy);
    },
    uiActive: () => uiFocus.active,
    uiAnalog: () => uiFocus.wantsAnalog,
    onUi: (a: Parameters<UiFocus['handle']>[0]) => uiFocus.handle(a),
    /**
     * D-pad left/right in gameplay: step the active hotbar slot.
     *
     * A hook rather than a synthesised `Digit3`, because cycling needs to
     * know where the selection IS and gamepad.ts deliberately holds no game
     * state — the same reason `onLook` is a hook. `hotbar.select` is the
     * exact call the digit keys and a mouse click already make, so the save
     * and the re-render come along for free.
     */
    onHotbar: (dir: number) => {
      const n = inventory.hotbar.length;
      if (n === 0) return;
      hotbar.select(((inventory.selected + dir) % n + n) % n);
      audio.play('ui_click');
    },
    onLockCycle: (dir: number) => {
      // No-op unless a lock is held — `cycleLock` guards that itself, which is
      // why the pad can afford to fire this on every flick without knowing
      // whether the player is targeting.
      if (!panels.isOpen) cycleLock(dir);
    },
  };

  /** 'village' when standing inside a settlement's radius, else null.
   *  Ruins and ranches are too small to earn their own cue; they read as
   *  wilds. findNearestSite, NOT nearestSettlement() — the latter resolves a
   *  full layout and is too heavy per-frame (MUSIC_HOOK.md). */
  function musicSettlementKind(): 'village' | null {
    const site = settlementManager.findNearestSite(
      controller.pos[0], controller.pos[2], 2);
    if (!site) return null;
    const dx = controller.pos[0] - site.x;
    const dz = controller.pos[2] - site.z;
    const r = SETTLEMENT_RADIUS[site.kind];
    if (dx * dx + dz * dz > r * r) return null;
    return site.kind === 'village' || site.kind === 'town' ? 'village' : null;
  }

  /** The music engine's view of the world, derived once per frame.
   *  Interiors FIRST: dungeon/building arenas sit at y=-300 with x/z
   *  unrelated to world space, so any XZ test below would read garbage. */
  function musicState(tod: number, wx: Weather, paused: boolean): MusicState {
    const region: MusicState['region'] =
      dungeonManager.isInside ? 'dungeon'
      : buildingManager.isInside ? 'interior'
      : castleManager.collider.inFootprint(controller.pos[0], controller.pos[2]) ? 'castle'
      : musicSettlementKind() ?? 'wilds';
    // Dungeon melee holds its own token pool (dungeon-combat.ts) — without
    // the passthrough, underground fights would read as calm forever.
    const inCombat = (dungeonManager.isInside
      ? dungeonManager.meleeHeld : meleeTokens.heldCount) > 0 || lockOnId !== null;
    const intensity: MusicState['intensity'] =
      castleManager.hostile ? 'boss' : inCombat ? 'combat' : 'calm';
    return { region, intensity, tod, weather: wx.rainLevel, paused };
  }

  function tick(now: number) {
    // The clock, not the stepping, is what pause stops — see sim-clock.ts for
    // why banking wall time behind a pause is a catch-up burst waiting to
    // happen. `steps` is 0 for every frame the game is paused.
    let steps = simClock.advance(now);
    const paused = simClock.paused;
    lastFrameSteps = steps;
    // Polled on the WALL clock, not sim steps: the camera has to keep moving
    // while the sim is paused, and a pad held down through a pause must not
    // bank input. Clamped so an alt-tab does not fling the camera on return.
    gamepad.poll(Math.min(0.1, Math.max(0, (now - last) / 1000)), gamepadHooks);
    // After the poll, so a panel opened by this frame's Start press is picked
    // up on this frame. Armed by `connected`: with no pad attached the focus
    // layer paints nothing and steals no focus, which is what keeps the
    // mouse-and-keyboard experience byte-for-byte what it was.
    uiFocus.tick(gamepad.connected);
    last = now;
    // Crash-recovery autosave: position + sim clock every 5 s while playing
    // outdoors on solid ground (interiors use arena coordinates; mid-flight
    // positions would drop the player from the sky on resume). Skipped while
    // paused: nothing it records can have changed, and the throttle would fire
    // on the resume frame anyway, which is when it becomes true again.
    if (!paused && now - lastAutoPosMs > 5000 && !isDead && mountedEntityId === null
        && !dungeonManager.isInside && !buildingManager.isInside && controller.grounded) {
      lastAutoPosMs = now;
      saveAutoPos({
        x: controller.pos[0], y: controller.pos[1], z: controller.pos[2], simTime,
      });
    }
    while (steps-- > 0) {
      // Block movement while dead.
      if (!isDead) {
        if (flyMode) flyCam.update(SIM_DT);
        else {
          // While locked, the body points at the target instead of at its own
          // direction of travel — otherwise strafing a circle shows the enemy
          // your shoulder for the whole orbit. Movement is untouched: it is
          // already camera-relative, and the camera is already on the target.
          const lt = lockOnId === null ? undefined : lockedCandidate();
          const faceYaw = lt === undefined ? null
            : lockFacingYaw(controller.pos[0], controller.pos[2], lt.x, lt.z);
          // BLOCKING COSTS SPEED — half of it. Applied by pulling the step
          // back toward where it started rather than by scaling `SIM_DT` or by
          // adding a multiplier to `PlayerController`: scaling the timestep
          // would halve gravity too (you would fall slower behind a shield),
          // and the shortened step still ends between two positions the
          // controller's own `moveXZ` already resolved as legal, so no
          // collision is skipped. `moveSpeed` is scaled with it so the walk
          // cycle slows to match instead of sliding.
          //
          // Not while mounted: `tickMount` owns the rider's position there, and
          // an animal does not walk slower because the person on it is holding
          // a shield.
          const bx = controller.pos[0];
          const bz = controller.pos[2];
          controller.update(SIM_DT, orbitCam.yaw, faceYaw);
          if (blocking() && mountedEntityId === null) {
            controller.pos[0] = bx + (controller.pos[0] - bx) * BLOCK_MOVE_MUL;
            controller.pos[2] = bz + (controller.pos[2] - bz) * BLOCK_MOVE_MUL;
            controller.moveSpeed *= BLOCK_MOVE_MUL;
          }
        }
      }
      // The guard's own bookkeeping, once per SIM step so it freezes with the
      // clock. Dropping it here rather than hooking three separate transitions
      // (death, fly mode, the shield leaving the hotbar) keeps the rule in one
      // place and makes it idempotent. A panel is NOT one of them — see
      // `blocking()`.
      if (!vitals.alive || flyMode || shieldTier() === null) dropGuard(guard);
      // Eased so the arm swings up over ~0.12 s rather than teleporting. The
      // GAMEPLAY guard is `guard.down` and is instant — the visual lag must
      // never gate the mechanic, or the parry window would start before the
      // shield looked like it existed.
      {
        const target = blocking() ? 1 : 0;
        guardBlend += (target - guardBlend) * Math.min(1, SIM_DT / 0.12);
        if (Math.abs(guardBlend - target) < 0.004) guardBlend = target;
      }
      // Walk cycle: phase advances with distance, amplitude eases in/out.
      walkPhase += controller.moveSpeed * SIM_DT * 1.6;
      const ampTarget = controller.moveSpeed > 0 ? 1 : 0;
      walkAmp += (ampTarget - walkAmp) * Math.min(1, 12 * SIM_DT);
      attackT = attackTOverride
        ?? Math.min(1, attackT + SIM_DT / 0.5); // 0.5 s windup→strike→recover

      // --- Vitals tick -------------------------------------------------------
      if (!isDead) {
        const tod = todFreeze ?? (simTime / DAY_LENGTH_S + TOD_START) % 1;
        const isNight = tod < 0.26 || tod >= 0.74; // matches environment.ts keys
        const biome = biomeField.biomeAt(controller.pos[0], controller.pos[2]);
        const biomeOffset = biomeOffsetFor(biome, isNight);
        const hot = biomeOffset >= 1.5 || (biome === 'desert' && !isNight);

        // Sprint: Shift held while moving.
        const shiftHeld = controller.heldKeys.has('ShiftLeft')
          || controller.heldKeys.has('ShiftRight');
        const isSprinting = !controller.swimming
          && controller.moveSpeed > 0
          && shiftHeld
          && vitals.stamina > 0;
        // Climb: moving uphill on slope > CLIMB_SLOPE_DEG.
        const forwardH = heightField.heightAt(
          controller.pos[0] + Math.sin(controller.yaw) * SLOPE_SAMPLE,
          controller.pos[2] - Math.cos(controller.yaw) * SLOPE_SAMPLE);
        const backH = heightField.heightAt(
          controller.pos[0] - Math.sin(controller.yaw) * SLOPE_SAMPLE,
          controller.pos[2] + Math.cos(controller.yaw) * SLOPE_SAMPLE);
        const slopeDeg = Math.atan2(
          Math.abs(forwardH - backH), SLOPE_SAMPLE * 2) * (180 / Math.PI);
        const movingUphill = controller.moveSpeed > 0
          && controller.grounded
          && forwardH > backH;
        const isClimbing = movingUphill && slopeDeg >= CLIMB_SLOPE_DEG && vitals.stamina > 0;

        const heldId = equipped(inventory);
        const isHoldingStaff = heldId === 'oak_staff';
        const isHoldingTorch = heldId === 'torch';

        // Torch light/douse cues. The hand IS the switch (see the burn note
        // below), so "lit" is holding a torch with fuel in it, and the edges of
        // that predicate are exactly the moments the player sees the light
        // change. Driven off the edge rather than off the swap so that a torch
        // that burns out, a torch put away and a torch drawn all sound right
        // with one rule.
        const torchIsLit = isHoldingTorch && torchFuelS > 0;
        if (torchIsLit !== prevTorchLit) {
          audio.play(torchIsLit ? 'torch_light' : 'torch_douse');
          prevTorchLit = torchIsLit;
        }

        // Held torch burns down. This runs inside the fixed-step loop, so the
        // clock is `simTime` and a paused game burns nothing — the leak the
        // pause work closed for resource respawn and jail sentences.
        //
        // Deselecting a torch PAUSES its burn rather than resetting it: the
        // hand is the only lit/unlit switch there is, and a stack that drains
        // in your pack while you chop wood would be a nasty surprise. Swap
        // back and you resume the same stub.
        if (isHoldingTorch) {
          const t = burnTorch(torchFuelS, SIM_DT);
          torchFuelS = t.fuelS;
          if (t.spent) {
            // Burned out. Take this one off the stack; if any are left the
            // next lights off the stub (torchFuelS already carries its fuel).
            // If that was the last one, the slot empties, `equipped` goes
            // null next step and the light simply goes out.
            const slot = inventory.hotbar[inventory.selected];
            if (slot !== null) {
              slot.count -= 1;
              if (slot.count > 0) {
                setGatherNotice('You light another torch.');
              } else {
                // Slot empty. Restock from the pack before giving up: "the
                // next torch lights" has to mean the next torch you OWN. Going
                // suddenly dark with twenty torches in your bag reads as a bug,
                // not as an invitation to open the inventory panel.
                inventory.hotbar[inventory.selected] = null;
                const pulled = removeItem(inventory, 'torch', itemDef('torch').stack);
                if (pulled > 0) {
                  inventory.hotbar[inventory.selected] = { id: 'torch', count: pulled };
                  setGatherNotice('You take another torch from your pack.');
                } else {
                  torchFuelS = 0;
                  setGatherNotice('Your last torch burns out.');
                }
              }
              invChanged();
            }
          }
        }
        // Warm and lit are the same condition: an unlit stub is a stick.
        const torchLit = isHoldingTorch && torchFuelS > 0;

        let draining = false;
        // While mounted, the player's stamina is not drained — the mount's
        // stamina is managed by tickMount instead.
        if (mountedEntityId === null) {
          if (isSprinting) {
            drainStamina(vitals, SPRINT_DRAIN_PER_S, SIM_DT);
            draining = true;
          }
          if (isClimbing) {
            const climbRate = isHoldingStaff ? CLIMB_DRAIN_STAFF_PER_S : CLIMB_DRAIN_PER_S;
            drainStamina(vitals, climbRate, SIM_DT);
            draining = true;
          }

          // Block uphill movement when exhausted on steep slope.
          if (movingUphill && slopeDeg >= CLIMB_SLOPE_DEG && vitals.stamina <= 0) {
            // Undo the uphill XZ advance by pulling the player back a tiny bit.
            // We can't undo moveXZ directly — instead zero the uphill velocity.
            controller.velY = Math.min(0, controller.velY);
          }
        }

        // Feature 1: Fall damage — detect landing (airborne → grounded transition).
        // Safe threshold: 12 m/s impact speed. Dragons in flight exempt; water exempt.
        const FALL_SAFE_THRESHOLD = 12; // m/s
        const FALL_DAMAGE_SCALE   = 0.5;  // hp per m/s above threshold
        const wasAirborne = !prevGrounded;
        const justLanded  = wasAirborne && controller.grounded;
        if (justLanded) {
          const impactSpeed = Math.abs(prevVelY); // velocity just before ground snap
          const inWater = controller.swimming
            || biomeField.biomeAt(controller.pos[0], controller.pos[2]) === 'ocean'
            || biomeField.biomeAt(controller.pos[0], controller.pos[2]) === 'beach';
          const onDragonInFlight = mountedEntityId !== null
            && (() => {
              const me = entityManager.entities.get(mountedEntityId ?? '');
              return me !== undefined && SPECIES_DEFS[me.species].canFly === true
                && dragonFlightY > 0.5;
            })();
          if (!inWater && !onDragonInFlight && impactSpeed > FALL_SAFE_THRESHOLD) {
            const excess = impactSpeed - FALL_SAFE_THRESHOLD;
            const dmg = Math.ceil(excess * FALL_DAMAGE_SCALE);
            damagePlayer(vitals, dmg, 'fall');
            triggerDamageFlash();
            setGatherNotice(`Hard landing! -${dmg} HP`);
            audio.play('hurt');
            saveVitals(vitals);
          }
        }
        // Update prevVelY before ground snap zeros it (capture the in-flight value).
        // controller.update already ran above; velY is now the post-snap value.
        // We sample it here so next frame's prevVelY is accurate.
        prevVelY    = controller.velY;
        prevGrounded = controller.grounded;

        // Feature 2: Swim stamina drain — drain stamina while swimming (not wading).
        // Wading = grounded && at sea level; swimming = controller.swimming.
        const SWIM_STAMINA_DRAIN_PER_S = 6; // stamina/s
        const SWIM_HP_DRAIN_PER_S      = 2; // hp/s when stamina == 0
        if (controller.swimming && mountedEntityId === null) {
          drainStamina(vitals, SWIM_STAMINA_DRAIN_PER_S, SIM_DT);
          draining = true;
          if (vitals.stamina <= 0) {
            // Drowning: drain HP at 2/s when stamina is exhausted.
            damagePlayer(vitals, SWIM_HP_DRAIN_PER_S * SIM_DT, 'drowning');
            triggerDamageFlash();
            saveVitals(vitals);
            // HUD notice (throttle to ~1/s).
            if (Math.floor(simTime) !== Math.floor(simTime - SIM_DT)) {
              setGatherNotice('Drowning! Reach the shore!');
            }
          }
        }

        // Detect swim entry for splash SFX.
        if (controller.swimming && !prevSwimming) {
          audio.play('splash');
        }
        prevSwimming = controller.swimming;

        // Fire warmth and tent/canopy shelter (Phase H).
        const px = controller.pos[0];
        const pz = controller.pos[2];
        const py = controller.pos[1];
        const campfireNearVal = fireWarmthAt(fires, px, pz, simTime);
        const nearbyTrees = resourceManager.nearbyTreeRefs(px, pz, 3, gameNowMs());
        const tentTierVal = tentTierAt(tents, px, pz);
        const underCanopy = tentTierVal === 0 && canopyAt(nearbyTrees, px, py, pz);
        // Canopy maps to tier 1 (fiber tent warmth = 0.5); see shelter.ts rationale.
        const effectiveTentTier: 0 | 1 | 2 | 3 = underCanopy ? 1 : tentTierVal;

        // Phase N: effects contribute warmth/cooling to temperature model.
        const effWarm = effectWarmth(effectsState);
        const effCool = effectCooling(effectsState);

        const env: StepEnv = {
          biomeOffset,
          altitude:     py,
          night:        isNight,
          campfireNear: campfireNearVal,
          heldTorch:    torchLit,
          tentTier:     effectiveTentTier,
          // Armor warmth + effect warmth both feed into the max-not-sum model
          // via armorWarmth (temperatureAt takes the max across all warm sources).
          armorWarmth:  Math.max(totalWarmth(inventory), effWarm),
          swimming:     controller.swimming,
          hot,
          draining,
          coolingBonus: effCool,
        };
        stepVitals(vitals, SIM_DT, env);

        // Phase N: step timed effects; also scale stamina regen by mult.
        stepEffects(effectsState, SIM_DT);
        // Stamina regen multiplier: apply the bonus fraction on top of what
        // stepVitals already added (which uses mult=1 baseline).
        if (!draining && vitals.sinceDrainS >= 2) {
          const mult = staminaRegenMult(effectsState);
          if (mult > 1) {
            vitals.stamina = Math.min(MAX_STAMINA,
              vitals.stamina + STAMINA_REGEN_PER_S * SIM_DT * (mult - 1));
          }
        }

        // Death transition.
        if (!vitals.alive) {
          isDead = true;
          releasePointerLock(); // ours, not an Escape — see ui/pointer-lock.ts
          deathOverlay.style.display = 'flex';
          vitalsHud.setVisible(false);
          const causeText: Record<string, string> = {
            thirst: 'You died of thirst.',
            cold: 'You froze to death.',
            heat: 'You died of heat.',
            drowning: 'You drowned.',
            lightning: 'You were struck by lightning.',
            fall: 'You fell to your death.',
            combat: 'You were slain.',
            guard: 'You were executed by a guard.',
            animal: 'You were mauled by an animal.',
          };
          deathCauseEl.textContent =
            causeText[vitals.deathCause ?? ''] ?? 'Cause unknown.';
        }

        // Throttled save.
        vitalsSaveAccum += SIM_DT;
        if (vitalsSaveAccum >= VITALS_SAVE_INTERVAL) {
          vitalsSaveAccum = 0;
          saveVitals(vitals);
        }
      }

      tickBow(SIM_DT);
      tickProjectiles(SIM_DT);
      tickEntities(SIM_DT);
      tickMount(SIM_DT);
      tickMountAttack(SIM_DT);
      tickTaming(SIM_DT);
      tickNpcs(SIM_DT);
      tickGuardEnforcement(SIM_DT);
      tickJail();
      tickLightning();
      fireSpreadAccum += SIM_DT;
      if (fireSpreadAccum >= FIRE_SPREAD_TICK_S) {
        fireSpreadAccum = 0;
        tickFireSpread();
      }
      // Periodic fire-draw rebuild (for flame appearing/disappearing as fuel drains).
      fireRebuildAccum += SIM_DT;
      if (fireRebuildAccum >= FIRE_REBUILD_INTERVAL) {
        fireRebuildAccum = 0;
        rebuildFireDraws(simTime);
      }
      simTime += SIM_DT;
      // Fog of war. Only outdoors: inside a dungeon or a building the
      // controller is standing in an ARENA at y=-300 whose x/z have nothing to
      // do with the world, and marking those would scatter discovered chunks
      // around the origin. Gated on real movement so a player standing still
      // pays one distance check per step and nothing else.
      if (!dungeonManager.isInside && !buildingManager.isInside) {
        const dx = controller.pos[0] - lastRevealX;
        const dz = controller.pos[2] - lastRevealZ;
        if (dx * dx + dz * dz > REVEAL_STEP * REVEAL_STEP) {
          lastRevealX = controller.pos[0];
          lastRevealZ = controller.pos[2];
          if (discovery.reveal(lastRevealX, lastRevealZ, REVEAL_RADIUS)) {
            discoveryDirty = true;
          }
        }
      }
    }

    // Persist the map on the same throttle as vitals — writing it on every
    // newly-revealed chunk would serialise the whole bitmap several times a
    // second while walking.
    if (discoveryDirty && now - lastDiscoverySaveMs > 4000) {
      lastDiscoverySaveMs = now;
      discoveryDirty = false;
      saveDiscovery(discovery);
    }

    dungeonManager.update(controller.pos);
    buildingManager.update(controller.pos, settlementManager.nearby(), dungeonManager.isInside);
    const inDungeon = dungeonPreview || dungeonManager.isInside || buildingManager.isInside;
    // The castle is world geometry, not an interior, so it deliberately does
    // NOT feed `inDungeon` — terrain keeps streaming under it and the sky keeps
    // rendering over it. It only wants the camera while the player is under one
    // of its roofs, and only when no real interior owns the camera already.
    castleManager.update(controller.pos, simTime, inDungeon);
    stepShelter(inDungeon, now);
    controller.swimEnabled = !inDungeon; // interiors sit at y=-300, no sea there
    // Keep the orbit camera above the waterline while surface-swimming, so a
    // swim looks like a swim instead of a drowning (see OrbitCamera.minEyeY).
    orbitCam.minEyeY = controller.swimming ? SEA_LEVEL + 0.35 : null;

    // Feature 9: reset overworld entity aggro on dungeon/building exit.
    if (prevInDungeon && !inDungeon) {
      for (const e of entityManager.entities.values()) {
        if (e.mode === 'aggro' || e.mode === 'flee') {
          e.mode = 'idle';
          e.stateTimer = 0;
        }
      }
    }
    prevInDungeon = inDungeon;

    // Feature 6: Compass HUD update. Its own accumulator is fed SIM_DT once
    // per FRAME (a pre-existing frame-rate dependency), so left alone it would
    // keep spinning through a pause; the bearing cannot change anyway.
    if (!paused) updateCompass();
    // The aiming mark. Fed the real frame delta rather than SIM_DT so the
    // throttle is wall-clock 15 Hz whatever the frame rate is doing.
    updateReticle(Math.min(0.1, (now - reticleLastMs) / 1000));
    reticleLastMs = now;

    // First-person while the bow is drawn (see `bowFirstPerson`). Fed the real
    // frame delta, not SIM_DT: this is camera framing, not simulation, and on a
    // 30 fps frame a SIM_DT ease would move half as far as it should.
    stepBowFirstPerson(Math.min(0.1, (now - fpLastMs) / 1000));
    // Z-targeting rides the same wall-clock delta and the same reasoning.
    // Deliberately AFTER the bow ease and BEFORE the camera is read below, so
    // one frame's yaw is decided in one place.
    if (!paused) stepLockOn(Math.min(0.1, (now - fpLastMs) / 1000));
    fpLastMs = now;

    // Camera + streaming follow the active viewpoint. In portrait mode the
    // orbit centre is the subject creature, framed at half its standing height.
    const portraitEnt = portraitEntityId === null
      ? undefined : entityManager.entities.get(portraitEntityId);
    const target = portraitEnt !== undefined
      ? [portraitEnt.x,
         portraitEnt.y + (SPECIES_DEFS[portraitEnt.species]?.size ?? 1) * 0.5,
         portraitEnt.z] as [number, number, number]
      : camAnchor();
    const { view, eye } = flyMode
      ? { view: flyCam.viewMatrix(), eye: flyCam.pos }
      : orbitCam.viewMatrix(target);
    // Terrain stays resident while inside (instant exit) — just stop streaming.
    if (!inDungeon) chunkManager.update(eye[0], eye[2]);

    // Player mesh: repose on the CPU, then move its world offset.
    const p = controller.pos;
    const heldId = equipped(inventory);
    const heldDef = heldId === null ? null : itemDef(heldId);
    const held: HeldItem | null = heldDef?.held !== undefined
      ? { kind: heldDef.held, color: [...heldDef.color] }
      : null;
    // Recomputed here rather than carried out of the fixed-step loop: a frame
    // can run zero sim steps (a long frame after a stall, or the very first
    // one), and a stale flag there means a light and a flame for one frame
    // after the torch went out.
    const heldTorchLit = heldId === 'torch' && torchFuelS > 0;
    // Per frame, not on the 2 Hz vitals gate: the bar has to vanish the
    // instant you press another hotbar key, and its own change detection means
    // a still frame costs two comparisons and touches no DOM.
    torchBar.update(
      heldTorchLit && !isDead ? torchFuelS / TORCH_BURN_S : null,
      heldTorchCount());
    // Phase K: while mounted, freeze walkAmp=0 (riding pose, no leg animation).
    const effectiveWalkAmp = mountedEntityId !== null ? 0 : walkAmp;

    // Phase 57: derive armor tier from equipped armor ids.
    function armorTierOf(itemId: string | undefined): import('./character/character-mesh').ArmorTier | undefined {
      if (!itemId) return undefined;
      if (itemId.startsWith('fiber_'))       return 'fiber';
      if (itemId.startsWith('leather_'))     return 'leather';
      if (itemId.startsWith('iron_'))        return 'iron';
      if (itemId.startsWith('dragonscale_')) return 'dragon';
      return undefined;
    }
    const charOptions: import('./character/character-mesh').CharacterOptions = {
      body: custom.body ?? 'male',
      armor: {
        head: armorTierOf(inventory.armor.head?.id),
        body: armorTierOf(inventory.armor.body?.id),
        legs: armorTierOf(inventory.armor.legs?.id),
      },
      // From the HOTBAR, not an equip slot — the same query the damage path
      // uses, so what is drawn on the arm is always the shield that would
      // actually stop the next blow. Two separate lookups here would be a way
      // for the picture and the mechanic to disagree.
      shield: shieldTier() ?? undefined,
    };
    // An archer looks where the arrow is going. Unmounted the controller yaw
    // already tracks the camera; MOUNTED it tracks the animal's body, so a
    // rider shooting off to the side would be firing over their own shoulder
    // with their chest square to the front. Blend the mesh yaw toward the aim
    // by the draw amount — the turn then happens over the draw, not as a snap.
    const aimNow = bowAimAmount();
    let meshYaw = controller.yaw;
    // Only a LIVE draw turns the body. `freezeBowAim` pins the pose for
    // capture and must not also hijack the facing, or every camera angle a
    // harness picks ends up behind the archer's head — which is exactly how a
    // previous harness in this repo photographed the back of the player's
    // head for an entire session.
    if (aimNow > 0.01 && (bowDrawing || bowLooseT > 0)) {
      let d = (-orbitCam.yaw) - controller.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      meshYaw = controller.yaw + d * Math.min(1, aimNow * 1.6);
    }
    const charVerts = buildCharacterMesh(custom, {
      yaw: meshYaw, walkPhase, walkAmp: effectiveWalkAmp, attackT,
      aim: aimNow, seat: seatBlend, block: guardBlend,
    }, held, charOptions, playerMeshScratch);
    const playerVerts = fitCharacterMesh(charVerts);
    renderer.device.queue.writeBuffer(player.vertexBuffer, 0, playerVerts);
    // Hide the player when the camera has come far enough forward to be inside
    // them. Tested on the EYE, not on `orbitCam.firstPerson`: the boom is also
    // shortened by terrain and by interior colliders, and what decides whether
    // you are looking at the inside of a skull is where the eye ended up, not
    // why it went there. 0.85 m is comfortably outside the head (radius ~0.15)
    // and comfortably inside the third-person floor (BOOM_MIN 0.9).
    const eyeToHead = Math.hypot(
      eye[0] - p[0], eye[1] - (p[1] + PLAYER_HEIGHT * 0.85), eye[2] - p[2]);
    const inHead = orbitCam.firstPerson > 0 && eyeToHead < 0.85 && !flyMode;
    player.draw.count = (portraitEntityId !== null || inHead)
      ? 0 : playerVerts.length / (STRIDE_CREATURE / 4);
    renderer.device.queue.writeBuffer(
      player.objectBuffer, 0, new Float32Array([p[0], p[1], p[2], 1]));

    const tod = todFreeze ?? (simTime / DAY_LENGTH_S + TOD_START) % 1;
    const env = envAt(tod);
    const wx = weatherPin ?? weatherAt(WORLD_SEED, simTime);

    // Feature 10: per-frame ambience + SFX wiring. Silenced while paused —
    // the footstep accumulator is fed SIM_DT per frame, so a paused player
    // frozen mid-stride would otherwise keep walking audibly on the spot.
    if (!isDead && !paused) {
      const isNightForAudio = tod < 0.26 || tod >= 0.74;
      const fireNearIntensity = nearCampfireOrForge(fires, controller.pos[0], controller.pos[2], simTime)
        ? 1.0
        : (fireWarmthAt(fires, controller.pos[0], controller.pos[2], simTime) ? 0.5 : 0);
      const ambienceState: AmbienceState = {
        // Wind drops further than rain under cover: a roof does far more to
        // stop a draught than it does to stop the noise of a storm.
        wind:     wx.cloudCover * (1 - shelter * 0.85),
        // MUFFLED, not silenced. Rain on a roof you are standing under is one
        // of the better sounds a castle can make, and cutting it to zero makes
        // the great hall feel like a vacuum the moment the drops stop. 0.45 is
        // the judgement: clearly quieter and unmistakably still raining.
        rain:     wx.rainLevel * (1 - shelter * 0.55),
        night:    isNightForAudio,
        interior: inDungeon,
        fireNear: fireNearIntensity,
        // Under a roof the open-sky rain bed is ducked and the on-a-roof bed
        // comes up in its place. `shelter` is the eased value the rain/wind
        // mixes already use, so the beds cross-fade with them rather than
        // snapping a beat apart from the sound they are replacing.
        sheltered: shelter > 0.5,
        // Room tone. A dungeon and a castle great hall are the two interiors
        // big enough to have a voice of their own.
        dungeon: inDungeon ? 1 : 0,
        castle: underCastleRoof() ? 1 : 0,
      };
      audio.setAmbience(ambienceState);
      // The score. Runs OUTSIDE the pause gate on purpose: music keeps
      // playing (ducked) under the pause chart, so it takes wall-clock
      // `now`, not simTime, which freezes there. Ducks under NPC speech —
      // idempotent per the bus contract, so calling every frame is the API.
      music?.update(musicState(tod, wx, paused), now / 1000);
      music?.duck(voiceOut.pending > 0 ? 1 : 0);

      // Door cue on the interior edge. Buildings and dungeons are both entered
      // through a door the player never explicitly "opens" — crossing the
      // threshold IS the interaction — so the transition is the event.
      const insideNow = buildingManager.isInside || dungeonManager.isInside;
      if (insideNow !== prevInsideForAudio) {
        audio.play(insideNow ? 'door_open' : 'door_close');
        prevInsideForAudio = insideNow;
      }

      // Footstep SFX: tick accumulator while moving on ground.
      if (controller.grounded && controller.moveSpeed > 0 && !flyMode) {
        footstepAccum += SIM_DT;
        if (footstepAccum >= 0.45) {
          footstepAccum = 0;
          // Surface type, which the roster can finally express. The order is
          // most-specific-first: a dungeon floor and a plank floor are both
          // "indoors" but they are not the same sound, and a beach inside the
          // desert biome is still sand underfoot.
          const biomeHere = biomeField.biomeAt(controller.pos[0], controller.pos[2]);
          const surface = inDungeon ? 'footstep_stone'
            : buildingManager.isInside ? 'footstep_wood'
              : (biomeHere === 'beach' || biomeHere === 'desert') ? 'footstep_sand'
                : (biomeHere === 'mountain_forest' || biomeHere === 'alpine') ? 'footstep_stone'
                  : 'footstep_grass';
          audio.play(surface);
        }
      } else {
        footstepAccum = 0;
      }
    }

    const sunColor: Vec3 = [
      env.sunColor[0] * wx.sunDim,
      env.sunColor[1] * wx.sunDim,
      env.sunColor[2] * wx.sunDim,
    ];
    const FOV_Y = Math.PI / 3;
    const NEAR = 0.1;
    const proj = perspectiveZO(FOV_Y, renderer.aspect, NEAR, 1200);
    // Camera forward from the view matrix's third rotation row (lookAt puts
    // the camera's -Z along the look direction). Shadow cascades fit to it.
    const cameraForward: Vec3 = [-view[2], -view[6], -view[10]];

    // Z-target marker. Projected here rather than in the sim loop because this
    // is the frame the matrices belong to — projecting against last frame's
    // camera puts the ring a frame behind the thing it marks, which at a run
    // is a visible lag between the enemy and its own halo.
    {
      const lt = lockOnId === null ? undefined : lockedCandidate();
      if (lt === undefined || panels.isOpen || isDead) {
        lockIndicator.hide();
      } else {
        const px = controller.pos[0], pz = controller.pos[2];
        const dist = Math.hypot(lt.x - px, lt.z - pz);
        // Mark the body, not the feet: `groundHeightAt` plus a little over half
        // a person. Anything anchored at ground level reads as marking the
        // floor in front of the enemy on a slope.
        // `chunkManager.ground`, not the raw height field: carved ground is
        // what creatures actually stand on, and inside a dungeon the raw field
        // is the hillside overhead.
        const ty = (dungeonManager.isInside ? controller.pos[1]
          : chunkManager.ground.heightAt(lt.x, lt.z)) + 1.1;
        const cx = view[0] * lt.x + view[4] * ty + view[8] * lt.z + view[12];
        const cy = view[1] * lt.x + view[5] * ty + view[9] * lt.z + view[13];
        const cz = view[2] * lt.x + view[6] * ty + view[10] * lt.z + view[14];
        const cw = view[3] * lt.x + view[7] * ty + view[11] * lt.z + view[15];
        const clipX = proj[0] * cx + proj[4] * cy + proj[8] * cz + proj[12] * cw;
        const clipY = proj[1] * cx + proj[5] * cy + proj[9] * cz + proj[13] * cw;
        const clipW = proj[3] * cx + proj[7] * cy + proj[11] * cz + proj[15] * cw;
        // Behind the eye: no marker. Dividing by a negative w mirrors the point
        // onto the wrong side of the screen, which is worse than hiding it.
        if (clipW <= 0.001) {
          lockIndicator.hide();
        } else {
          const rect = canvas.getBoundingClientRect();
          const sx = rect.left + (clipX / clipW * 0.5 + 0.5) * rect.width;
          const sy = rect.top + (0.5 - clipY / clipW * 0.5) * rect.height;
          lockIndicator.update(sx, sy, indicatorFade(dist));
        }
      }
    }

    // Moon: roughly opposite the sun but on a slightly inclined orbit, so it
    // drifts across the sky over successive nights instead of sitting fixed.
    const moonT = simTime / DAY_LENGTH_S;
    const moonSwing = moonT * 0.21;
    const moonDir = normalize([
      -env.sunDir[0] * Math.cos(moonSwing) - env.sunDir[2] * Math.sin(moonSwing),
      Math.abs(env.sunDir[1]) * 0.94 + 0.16,
      -env.sunDir[2] * Math.cos(moonSwing) + env.sunDir[0] * Math.sin(moonSwing),
    ]);
    // Illuminated fraction over an 8-day cycle.
    const moonPhase = 0.5 - 0.5 * Math.cos(moonT * (Math.PI * 2 / 8));

    // Overcast skies scatter the sun into a soft dome — shadows weaken with
    // cloud cover and rain rather than staying knife-sharp in a downpour.
    let shadowStrength = inDungeon
      ? 0
      : Math.max(0, 1 - wx.cloudCover * 0.55 - wx.rainLevel * 0.25);
    if (shadowOverride !== null) shadowStrength = shadowOverride ? 1 : 0;

    const frame: FrameUniforms = {
      viewProj: multiply(proj, proj, view),
      cameraPos: eye,
      sunDir: inDungeon ? DUNGEON_SUN_DIR : env.sunDir,
      fogColor: inDungeon ? DUNGEON_FOG : env.fogColor,
      fogDensity: inDungeon ? DUNGEON_FOG_DENSITY : env.fogDensity * wx.fogMul,
      time: simTime,
      sunColor: inDungeon ? DUNGEON_SUN : sunColor,
      ambient: inDungeon ? DUNGEON_AMBIENT : env.ambient,
      skyZenith: inDungeon ? DUNGEON_FOG : env.skyZenith,
      starVis: inDungeon ? 0 : env.starVis,
      cloudCover: inDungeon ? 0 : wx.cloudCover,
      // The VISIBLE drops, and the one thing shelter fully suppresses. Under a
      // roof there is nothing falling past your face, so this goes to zero —
      // eased, so walking out of the great hall ramps the downpour back up
      // over ~0.16 s instead of switching it on in one frame.
      rainLevel: lastFrameRainLevel =
        inDungeon ? 0 : wx.rainLevel * (1 - shelter),
      cameraForward,
      fovY: FOV_Y,
      near: NEAR,
      shadowStrength,
      moonDir,
      moonPhase,
      windTime: simTime,
    };

    // Held torch. Anchored to the flame on the MESH, not to the player's feet
    // — the head of the torch rides the right arm's walk swing, and a light
    // pinned to the body centre visibly comes adrift from its own flame at a
    // run. `heldTorchLight` is null unless a torch is both selected and lit.
    const torchFlame = heldTorchLit
      ? torchFlamePos(p[0], p[1], p[2], meshYaw,
        Math.sin(walkPhase) * effectiveWalkAmp)
      : null;
    const heldTorchLight = torchFlame === null
      ? null : { pos: torchFlame, radius: TORCH_LIGHT_RADIUS };
    lastTorchFlame = torchFlame;
    // Interiors read their own group-2 uniform for every wall and floor, so a
    // carried torch has to be written into that too — the world set below only
    // reaches characters and animals underground.
    dungeonManager.setPlayerTorch(heldTorchLight);
    buildingManager.setPlayerTorch(heldTorchLight);

    // Queue every flame billboard for this frame and collect the point lights
    // they cast. Doing both in one pass is deliberate: they used to be
    // computed in unrelated places, which is how burning trees ended up
    // blazing away while lighting absolutely nothing.
    const fireLights = emitFireVfx(eye, inDungeon, heldTorchLight);

    let worldLightCount = 0;
    // Outdoor point lights: lit fires near the camera, brightest-first, so a
    // campfire actually lights the ground, the grass and whoever stands round
    // it. Interiors keep their own group-2 torch set, so skip this inside.
    if (inDungeon) {
      // Indoors the sun and sky contribute nothing, and the interior's torch
      // set lives in a group-2 uniform only the dungeon pipeline can read —
      // so feed the same lights into the world set, or characters and animals
      // render as unlit black silhouettes underground.
      // `fireLights` is not empty indoors: emitWorldFire runs the Tintreach
      // bolt and the player's own torch before its interior early-return.
      // This used to throw the whole list away, which would leave a carried
      // torch lighting the walls (group 2) but not the goblin standing in
      // front of them. The sort is by distance to the eye and a torch in your
      // own hand is about a metre from it, so it always survives the slice.
      const interiorLights = dungeonManager.isInside
        ? dungeonManager.activeLights()
        : buildingManager.activeLights();
      worldLightCount = interiorLights.length + fireLights.length;
      const nearest = [...fireLights, ...interiorLights]
        .sort((a, b) =>
          (a.pos[0] - eye[0]) ** 2 + (a.pos[1] - eye[1]) ** 2 + (a.pos[2] - eye[2]) ** 2
          - ((b.pos[0] - eye[0]) ** 2 + (b.pos[1] - eye[1]) ** 2 + (b.pos[2] - eye[2]) ** 2))
        .slice(0, MAX_WORLD_LIGHTS);
      renderer.setWorldLights(nearest);
      lastWorldLights = nearest;
    } else {
      // Castle halls carry flameless fill lights as well as torches. Without
      // them a 54 x 48 m keep lit only by wall sconces is a black pit, and
      // anyone standing in it renders as an unlit silhouette — the same
      // failure the building interiors hit and fixed the same way.
      const castleFill = castleManager.fillPoints();
      const merged = castleFill.length === 0
        ? fireLights
        : [...fireLights, ...castleFill.map((l) => ({ ...l, d2: 0 }))]
          .sort((a, b) =>
            ((a.pos[0] - eye[0]) ** 2 + (a.pos[1] - eye[1]) ** 2 + (a.pos[2] - eye[2]) ** 2)
            - ((b.pos[0] - eye[0]) ** 2 + (b.pos[1] - eye[1]) ** 2 + (b.pos[2] - eye[2]) ** 2));
      worldLightCount = Math.min(merged.length, MAX_WORLD_LIGHTS);
      const shown = merged.slice(0, MAX_WORLD_LIGHTS);
      renderer.setWorldLights(shown);
      lastWorldLights = shown;
    }

    // Post-process state that follows gameplay rather than the environment.
    {
      const post = renderer.postSettings;
      // Submerged: driven by the camera eye, not the player's feet, and
      // capped short of 1 — full absorption reads as an opaque blue screen.
      post.underwater = inDungeon
        ? 0
        : Math.max(0, Math.min(0.85, (SEA_LEVEL - eye[1]) * 1.1));
      // Red pulse as health runs out.
      const hpFrac = vitals.hp / MAX_HP;
      post.hurt = Math.max(0, 1 - hpFrac / 0.34) * 0.55;
      // Night lifts exposure a little so the world stays readable without
      // washing the daylight out.
      post.exposure = DEFAULT_POST.exposure
        * (inDungeon ? 1.30 : 1 + (env.starVis) * 0.22);
      post.godrayStrength = inDungeon ? 0 : 1 - wx.cloudCover * 0.5;
      post.bloomIntensity = DEFAULT_POST.bloomIntensity
        * (inDungeon ? 1.8 : 1 + wx.rainLevel * 0.5);
      // Damp air scatters more: haze up the vignette in the rain.
      post.vignette = DEFAULT_POST.vignette + wx.rainLevel * 0.10;
      // The lightning arrow. Dips the whole frame's exposure and floods the
      // bloom while its bolt burns, so the bolt reads as genuinely blinding
      // rather than as a bright line drawn over an ordinary scene.
      applyTintreachPost(post, simTime);
    }

    if (!inDungeon) {
      const prevNpcCount = settlementManager.nearbyNpcs().length;
      settlementManager.update(controller.pos);
      if (settlementManager.nearbyNpcs().length !== prevNpcCount) npcsDirty = true;
      resourceManager.update(controller.pos, gameNowMs());
      updateNestStream();
    }
    const draws = inDungeon ? [] : chunkManager.draws();
    // Copy, do not extend in place. `DungeonManager.draws()` returns its own
    // `resident.draws` array by reference while the player is inside a
    // dungeon, so every `push` here appends to the manager's permanent list
    // and it grows without bound frame after frame. The existing pushes below
    // have the same hazard; taking a copy fixes all of them at once.
    const dDraws = [...(dungeonPreview ? dungeonDraws : dungeonManager.draws())];
    dDraws.push(...buildingManager.draws());
    if (!inDungeon) {
      dDraws.push(...castleManager.draws());
      dDraws.push(...settlementManager.draws());
      dDraws.push(...resourceManager.draws());
      // Fire pits only (stone, logs, chimney). Flames, embers, smoke and coals
      // are billboards already queued by emitFireVfx above.
      dDraws.push(...fireDraws);
      dDraws.push(...tentDraws);
      dDraws.push(...eggDraws);
      dDraws.push(...nestDraws);
    }
    // Arrows in flight and arrows stuck where they landed. One draw for the
    // whole pool; skipped entirely when nothing is in the air.
    if (updateProjectileDraw(eye[0], eye[2]) > 0) dDraws.push(projectileDraw);
    const treeDraws = inDungeon ? [] : chunkManager.treeDraws();
    const grassDraws = inDungeon ? [] : chunkManager.grassDraws();
    // Build entity draws (animals): overworld OR dungeon enemies.
    const entityDraws = inDungeon
      ? entityRenderer.buildDraws(dungeonManager.dungeonEnemies(), eye[0], eye[2], simTime)
      : entityRenderer.buildDraws(entityManager.entities.values(), eye[0], eye[2], simTime);
    entityDrawnCount = entityDraws.length;

    // Build NPC draws (humanoids).
    //
    // `inDungeon` lumps dungeons and building interiors together, and skipping
    // NPCs wholesale is right for a dungeon (nobody lives there) but was what
    // kept every building empty: the occupant was placed in the room, was the
    // target of the E prompt, and was simply never rendered. Indoors we draw
    // the arena occupants; buildNpcDraws already picks the right set.
    const npcDraws = dungeonManager.isInside || dungeonPreview
      ? [] : buildNpcDraws(eye[0], eye[2]);

    if (renderer.renderFrame(
      frame, draws, dDraws, !inDungeon, treeDraws,
      [player.draw, ...entityDraws, ...npcDraws], grassDraws)) {
      frameCount++;
      fpsFrames++;
      if (!window.__gameReady) {
        window.__gameReady = true;
        debugSpawnFromUrl();
      }
      // Same-task canvas read-back for the live debug channel (F8/F9).
      capture.maybeCapture(canvas, now, () => ({
        stats: window.__gameStats,
        error: window.__gameError,
        camera: {
          yaw: orbitCam.yaw, pitch: orbitCam.pitch, distance: orbitCam.distance,
        },
        controller: {
          pos: [...controller.pos], yaw: controller.yaw,
          grounded: controller.grounded, swimming: controller.swimming,
          moveSpeed: controller.moveSpeed,
        },
        pose: { walkPhase, walkAmp, attackT },
        tod, weather: wx.kind, flyMode, panelOpen: panels.isOpen,
        equipped: heldId,
      }));
    }

    if (now - fpsLast >= 500) {
      fps = (fpsFrames * 1000) / (now - fpsLast);
      // HUD refresh at ~2/s (piggybacking on the existing 500 ms gate).
      if (!isDead) vitalsHud.update(vitals);
      updateMountStaminaHud();
      updateJailHud();
      updateEffectsHud();
      // NPC chat gets exclusive GPU time, and background dreaming only runs
      // once the player has been still for IDLE_DREAM_MS (fixtures serve
      // instantly either way — the LLM waits on the game, never the reverse).
      const npcChatOpen = chatState().open;
      const movedSq = (controller.pos[0] - idleLastX) ** 2
        + (controller.pos[2] - idleLastZ) ** 2;
      idleLastX = controller.pos[0];
      idleLastZ = controller.pos[2];
      const playerActive = movedSq > 0.25 // > ~0.5 m per 500 ms tick
        || controller.heldKeys.has('KeyW') || controller.heldKeys.has('KeyA')
        || controller.heldKeys.has('KeyS') || controller.heldKeys.has('KeyD')
        || controller.heldKeys.has('Space');
      if (playerActive) idleSince = now;
      director?.setPaused(npcChatOpen || now - idleSince < IDLE_DREAM_MS);
      // Deferred NPC model load: start the warm load the first time the
      // player comes within NPC_PRELOAD_DIST of a settlement.
      if (!npcPreloadStarted && !directorOff && !inDungeon) {
        const site = settlementManager.findNearestSite(
          controller.pos[0], controller.pos[2], 1);
        if (site !== null && Math.hypot(
          controller.pos[0] - site.x, controller.pos[2] - site.z) < NPC_PRELOAD_DIST) {
          npcPreloadStarted = true;
          void preloadNpcChat(gpu, npcModelKey);
        }
      }

      // Start prefilling the nearest NPC's prompt while the player is still
      // WALKING UP, rather than when they press E. The system prompt is ~1,500
      // tokens and prefill runs at ~70-100 tok/s with the renderer sharing the
      // GPU, so the panel-open warm on its own loses the race against anyone
      // who reads the greeting quickly. Measured with scripts/_probe-npc-
      // latency.mts: first-turn time-to-first-token 12.1 s without this, 1.4 s
      // with it.
      //
      // Deliberately NOT the real persona. Assembling that runs
      // spreadVillageNews(), which is meant to fire once per opened
      // conversation, not once per passer-by. A partial persona still prefills
      // a true PREFIX of the real prompt because npc-prompt.ts orders its
      // sections stable-first, and the engine keeps the common prefix.
      if (!inDungeon && !directorOff && !npcChatOpen) {
        const wx = controller.pos[0];
        const wz = controller.pos[2];
        let approaching: NpcRuntime | null = null;
        let warmD = NPC_WARM_DIST;
        for (const rt of npcRuntimes) {
          if (rt.hp <= 0) continue;
          if (rt.indoors && !rt.inArena) continue;   // behind a wall — same test as nearestNpc()
          const d = Math.hypot(rt.wx - wx, rt.wz - wz);
          if (d < warmD) { warmD = d; approaching = rt; }
        }
        if (approaching !== null) {
          warmNpcApproach({
            id: approaching.npc.id,
            name: approaching.npc.name,
            role: approaching.npc.role,
            settlement: approaching.npc.settlementName,
            playerBounty: bountyIn(crimeState, approaching.npc.settlementName),
            // Passing these two pushes the cached prefix further down, through
            // the FOLLOWING / HOSPITALITY / ROMANCE rules, which branch on them.
            disposition: dispositionFromNews(
              villageMemory, approaching.npc.settlementName, approaching.npc.id),
            following: approaching.following === true,
          });
        }
      }
      fpsFrames = 0;
      fpsLast = now;
      // Drinking prompt. The well is checked first so the label matches the
      // E chain, which ranks a well above a river. Both are suppressed behind
      // anything with its own prompt, and behind the pause screen — the world
      // is frozen there and E does nothing, so offering it would be a lie.
      const drinkPrompt = (!inDungeon && !paused
        && settlementManager.interactPrompt === null
        && dungeonManager.interactPrompt === null
        && buildingManager.interactPrompt === null)
        ? (nearestWellPad() !== null ? 'E — drink from the well'
          : nearFreshWater() ? 'E — drink' : null)
        : null;
      // The indoor NPC has to win the LABEL as well as the key, or the HUD
      // offers the chest while E talks to the keeper.
      const indoorNpc = npcBeatsBuilding() ? nearestNpc() : null;
      // Display order must match the KeyE chain above, or the HUD offers one
      // thing and the key does another.
      const prompt = paused ? null : (dungeonManager.interactPrompt
        ?? (inDungeon ? null : castleManager.interactPrompt)
        ?? (indoorNpc !== null ? `E — talk to ${indoorNpc.npc.name}` : null)
        ?? buildingManager.interactPrompt
        ?? (inDungeon ? null
          : settlementManager.interactPrompt
            ?? drinkPrompt
            ?? gatherPrompt()));
      lastInteractPrompt = prompt;
      const notice = dungeonManager.noticeText ?? buildingManager.noticeText
        ?? settlementManager.noticeText
        ?? (gatherNotice !== null && now < gatherNotice.until ? gatherNotice.text : null);
      hud.textContent =
        `fps ${fps.toFixed(0)}  |  ${canvas.width}x${canvas.height}` +
        `${flyMode ? '  |  FLY (R to exit)' : ''}` +
        `${dungeonManager.isInside ? '  |  DUNGEON' : ''}${buildingManager.isInside ? '  |  BUILDING' : ''}\n` +
        `frames ${frameCount}  |  chunks ${chunkManager.count}\n` +
        `pos ${p[0].toFixed(1)}, ${p[1].toFixed(1)}, ${p[2].toFixed(1)}` +
        `${controller.grounded ? '' : '  (air)'}` +
        `${director ? `\nDirector: ${director.statusText}` : ''}` +
        // Which quiver is nocked, whenever a bow is in hand. The bow has two
        // ammunition types with completely different behaviour (an arc vs a
        // hitscan) and one of them is irreplaceable, so "which one am I about
        // to spend" must be answerable without opening the pack.
        `${bowEquipped() ? `\nArrows: ${ammoLabel(ammoInHand() ?? ammoPref)}  (X)` : ''}` +
        `${prompt ? `\n${prompt}` : ''}` +
        `${notice ? `\n${notice}` : ''}`;
      window.__gameStats = {
        frameCount,
        fps,
        paused: simClock.paused,
        simTime,
        mapChunks: discovery.chunkCount,
        chunkCount: chunkManager.count,
        grassInstances: grassDraws.reduce((n, g) => n + g.instanceCount, 0),
        worldLightCount,
        playerPos: [p[0], p[1], p[2]],
        grounded: controller.grounded,
        swimming: controller.swimming,
        weather: wx.kind,
        insideDungeon: dungeonManager.isInside || buildingManager.isInside,
        dungeonCount: dungeonManager.dungeonCount,
        interactPrompt: prompt,
        chestsOpened: dungeonManager.chestsOpened + buildingManager.chestsOpened,
        notice,
        directorStatus: director?.status ?? null,
        equipped: heldId,
        attackT,
        gathered: gatheredCount,
        burningTreeCount: getBurningTrees().length,
        fireBillboards: lastFireBillboards,
        entityCount: entityManager.entities.size,
        entityDrawn: entityDrawnCount,
        mountedEntityId,
        mountAltitude: (mountedEntityId !== null && DRAGON_FLIGHT_ENABLED)
          ? dragonFlightY
          : null,
        npcCount: npcRuntimes.length,
        projectilesInFlight: inFlightCount(projectilePool),
        projectilesStuck: activeCount(projectilePool) - inFlightCount(projectilePool),
        bowAim: bowAimAmount(),
        mountHp: (() => {
          const m = mountedEntityId !== null
            ? entityManager.entities.get(mountedEntityId) : undefined;
          return m !== undefined ? m.hp : null;
        })(),
        // Phase M
        bounty: bountyIn(crimeState, nearestRegionId()),
        jailed: jailRecord !== null && gameNowMs() < jailRecord.jailedUntilMs,
        jailRemainS: jailRecord !== null
          ? Math.max(0, (jailRecord.jailedUntilMs - gameNowMs()) / 1000)
          : 0,
      };
    }

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

boot().catch((err) => {
  setError('boot', err);
  const hud = document.getElementById('hud');
  if (hud) hud.textContent = `FAILED: ${window.__gameError}`;
});
