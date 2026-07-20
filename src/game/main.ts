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
import {
  Renderer, LIGHTS_BUFFER_SIZE,
  type FrameUniforms, type TerrainDraw, type DungeonDraw,
} from './renderer';
import { layoutDungeon, mix32 } from './dungeon/dungeon-layout';
import { buildInteriorMesh } from './dungeon/dungeon-mesh';
import { DUNGEON_FIXTURES } from './dungeon/dungeon-fixtures';
import { DungeonManager } from './dungeon/dungeon-manager';
import { BuildingManager } from './building/building-manager';
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
import { loadNodeRegistry, saveNodeRegistry } from './resource-nodes';
import { ResourceManager, type WorldNode, type NodeType } from './resource-manager';
import { RESOURCE_DROPS, REQUIRES_PICKAXE } from './resource-scatter';
import {
  addItem, countItem, removeItem, equipped, loadInventory, saveInventory, totalWarmth,
  equipArmor, unequipArmor, totalDefense,
  type Inventory, type SlotRef,
} from './inventory';
import {
  createFire, addFuel, upgradeToForge, isLit, nearestFire,
  fireWarmthAt, nearCampfireOrForge, nearForge as nearForgeCheck,
  loadFires, saveFires,
  addBurningTree, tickBurningTrees, getBurningTrees,
  BUSH_BURN_S, FIRE_IGNITE_RADIUS, TORCH_IGNITE_RADIUS,
  FIRE_SPREAD_RADIUS, FIRE_SPREAD_CHANCE,
  type PlacedFire,
} from './fire';
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
import {
  buildFireMeshes, buildTentMeshes, buildBreathMesh, buildBurningVegMesh,
  BREATH_RANGE, BREATH_HALF_ANGLE, BREATH_MAX_FLOATS, BURNING_VEG_MAX_FLOATS,
  PAL_FIRE_FLAME,
} from './fire-mesh';
import { Hotbar, buildInventoryPanel } from './ui/inventory-ui';
import { buildCraftingPanel } from './ui/crafting-ui';
import { PanelManager } from './ui/panel-manager';
import { buildCharacterPanel } from './ui/character-panel';
import { buildGameMenuPanel } from './ui/menu-panel';
import { saveToSlot, loadSlot, listSlots, newGame, consumeResume, saveAutoPos, readAutoPos } from './save-game';
import {
  buildNpcChatPanel, onNpcChatClosed, loadStockMap, saveStockMap,
  chatState, npcGoldFromMap, isNpcModelKey, preloadNpcChat,
  type StockMap,
} from './ui/npc-chat-panel';
import {
  loadMemoryMap, getOrCreateMemory, adjustDisposition, saveMemoryMap,
  loadVisitedSet, saveVisitedSet, loadDeadNpcSet, saveDeadNpcSet,
  type MemoryMap,
} from './npc/npc-memory';
import { EcologyDirector } from './entities/ecology-director';
import { VitalsHud } from './ui/vitals-hud';
import {
  createVitals, loadVitals, saveVitals,
  stepVitals, damagePlayer, healPlayer, drinkPlayer, drainStamina,
  CLIMB_SLOPE_DEG, CLIMB_DRAIN_PER_S, CLIMB_DRAIN_STAFF_PER_S, SPRINT_DRAIN_PER_S,
  STAMINA_REGEN_PER_S, MAX_STAMINA,
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
import { createHeightField } from './noise';
import { createBiomeField } from './biome';
import { CHUNK_SIZE } from './terrain/chunk-mesh';
import { ChunkManager } from './terrain/chunk-manager';
import { FlyCamera } from './fly-camera';
import { OrbitCamera } from './camera';
import { PlayerController } from './controller';
import { DebugCapture } from './debug-capture';
import { EntityManager } from './entities/entity-manager';
import { EntityRenderer, DEAD_SHOW_S } from './entities/entity-renderer';
import { stepAnimal, onEntityDamaged, FOLLOW_RADIUS } from './entities/animal-ai';
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

declare global {
  interface Window {
    __gameReady?: boolean;
    __gameStats?: {
      frameCount: number;
      fps: number;
      chunkCount: number;
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
      // Phase J
      entityCount?: number;
      entityDrawn?: number;
      // Phase K
      mountedEntityId?: string | null;
      /** Dragon flight altitude above terrain (m), null when not flying. */
      mountAltitude?: number | null;
      // Phase L
      npcCount?: number;
      // Phase M
      bounty?: number;
      jailed?: boolean;
      jailRemainS?: number;
    };
    __gameError?: string | null;
    __gameDebug?: {
      enterNearestDungeon(): boolean;
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
      freezeAttackT(t: number | null): void;
      equipItem(id: string): boolean;
      vitals(): Vitals;
      setVitals(partial: Partial<Vitals>): void;
      tickVitals(seconds: number): void;
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
      /** Count of projectiles currently in flight. */
      projectileCount(): number;
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
      /** Nearest npcOwned horse within given radius of (x, z), or null. */
      nearestNpcOwnedHorse(x: number, z: number, radius?: number): import('./entities/entity-manager').EntityState | null;
      /** Ownership flags of a live entity by id, or null (e2e). */
      entityFlags(id: string): { npcOwned: boolean; owned: boolean } | null;
      /** World positions of market stall pads in meshed settlements (e2e). */
      stallPads(): { wx: number; wz: number }[];
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
      /** Teleport to the exit zone inside a building. */
      buildingTeleportToExit(): void;
      /** Teleport to the nearest chest inside a building. */
      buildingTeleportToChest(): boolean;
      /** Teleport to a bed inside a building. */
      buildingTeleportToBed(): boolean;
    };
  }
}

const WORLD_SEED = 1337;
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
    size: CHARACTER_MAX_VERTS * 24, // interleaved pos3+color3
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  const { bindGroup, buffer } = renderer.createObjectBindGroup(0, 0, 0, 1);
  return {
    draw: { vertexBuffer, indexBuffer: null, count: 0, bindGroup },
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
  if (new URLSearchParams(location.search).get('wipe') !== null) {
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
  const terrainWorld = settlementGround(
    terrainGround(heightField), () => settlementManager.nearby());
  const controller = new PlayerController(terrainWorld,
    resumeState !== null ? [resumeState.x, resumeState.y, resumeState.z] : SPAWN_POS);
  const orbitCam = new OrbitCamera(heightField);
  const flyCam = new FlyCamera(add(controller.pos, [0, 20, 30]));
  let flyMode = false;

  // Character customization: persisted palette choices, panel on C.
  let custom = loadCustomization();

  // Player inventory: 28 pack + 5 hotbar slots, spawn kit on first run.
  const inventory = loadInventory();

  // Vitals: HP, thirst, stamina, temperature. Loaded from localStorage.
  let vitals: Vitals = loadVitals();
  let vitalsSaveAccum = 0; // throttled save every ~2 s
  const VITALS_SAVE_INTERVAL = 2;

  // -------------------------------------------------------------------------
  // Feature: Audio engine (Feature 10)
  // -------------------------------------------------------------------------
  const audio = new GameAudio();
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
  function resumeAudio() {
    if (audioResumed) return;
    audioResumed = true;
    audio.resume();
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
    if (jailRecord === null || Date.now() >= jailRecord.jailedUntilMs) {
      jailHud.style.display = 'none';
      return;
    }
    const remainS = Math.ceil((jailRecord.jailedUntilMs - Date.now()) / 1000);
    jailHud.textContent = `Jailed: ${remainS}s remaining`;
    jailHud.style.display = 'block';
  }

  /** Called each tick while the player is jailed. Handles release + position clamping. */
  function tickJail(): void {
    if (jailRecord === null) return;
    const now = Date.now();

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

    // Exit pointer lock so mouse can click buttons.
    document.exitPointerLock();

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
    const nowMs = Date.now();
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
            damagePlayer(vitals, GUARD_MELEE_DMG, 'guard', totalDefense(inventory));
            triggerDamageFlash();
            saveVitals(vitals);
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

  /** Rebuild GPU draw batches for all fires (called after any placement/fuel change). */
  function rebuildFireDraws(nowS = 0): void {
    for (const b of fireGpuBuffers) b.destroy();
    fireGpuBuffers = [];
    fireDraws = [];
    const litSet = new Set<string>(fires.filter(f => isLit(f, nowS)).map(f => f.id));
    const batches = buildFireMeshes(fires, litSet);
    const lg = getFireLightsBindGroup();
    for (const { palette, verts } of batches) {
      if (verts.length === 0) continue;
      const vb = renderer.device.createBuffer({
        label: `fire-pal${palette}`,
        size: verts.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      renderer.device.queue.writeBuffer(vb, 0, verts);
      const { bindGroup } = renderer.createObjectBindGroup(0, 0, 0, 100 + palette);
      fireDraws.push({
        draw: { vertexBuffer: vb, indexBuffer: null, count: verts.length / 3, bindGroup },
        lightsBindGroup: lg,
      });
      fireGpuBuffers.push(vb);
    }
  }

  // --- Dragon fire-breath VFX: one fixed-size buffer rewritten per frame ----
  let breathVb: GPUBuffer | null = null;
  let breathBindGroup: GPUBindGroup | null = null;
  /** Vertex count to draw this frame (0 = breath not visible). */
  let breathVertCount = 0;

  /**
   * Rebuild the breath-cone mesh for this frame (jittered emissive boxes,
   * torch-glow palette). Cheap: one writeBuffer into a pre-sized buffer.
   */
  function updateBreathVfx(): void {
    breathVertCount = 0;
    if (!breathActive || breathJaw < 0.3) return;
    const ray = getBreathRay();
    if (ray === null) return;
    if (breathVb === null) {
      breathVb = renderer.device.createBuffer({
        label: 'dragon-breath',
        size: BREATH_MAX_FLOATS * 4,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      breathBindGroup = renderer.createObjectBindGroup(0, 0, 0, 100 + PAL_FIRE_FLAME).bindGroup;
    }
    const verts = buildBreathMesh(ray.mouth, ray.dir, simTime);
    renderer.device.queue.writeBuffer(breathVb, 0, verts);
    breathVertCount = verts.length / 3;
  }

  // --- Burning-vegetation flames: one fixed-size buffer rewritten per frame -
  let burnVegVb: GPUBuffer | null = null;
  let burnVegBindGroup: GPUBindGroup | null = null;
  let burnVegVertCount = 0;

  /** Rebuild flame boxes over every burning tree/bush (cheap writeBuffer). */
  function updateBurningVegVfx(): void {
    burnVegVertCount = 0;
    const burning = getBurningTrees();
    if (burning.length === 0) return;
    if (burnVegVb === null) {
      burnVegVb = renderer.device.createBuffer({
        label: 'burning-veg',
        size: BURNING_VEG_MAX_FLOATS * 4,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      burnVegBindGroup = renderer.createObjectBindGroup(0, 0, 0, 100 + PAL_FIRE_FLAME).bindGroup;
    }
    const verts = buildBurningVegMesh(burning, simTime);
    renderer.device.queue.writeBuffer(burnVegVb, 0, verts);
    burnVegVertCount = verts.length / 3;
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
      const { bindGroup } = renderer.createObjectBindGroup(0, 0, 0, 100 + palette);
      tentDraws.push({
        draw: { vertexBuffer: vb, indexBuffer: null, count: verts.length / 3, bindGroup },
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
    const nearTrees = resourceManager.nearbyTreeRefs(tx, tz, TREE_IGNITE_RADIUS, Date.now());
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
      const nearbyTreesForCanopy = resourceManager.nearbyTreeRefs(px, pz, 3, Date.now());
      const tentTierVal = tentTierAt(tents, px, pz);
      const underCanopy = tentTierVal === 0
        && canopyAt(nearbyTreesForCanopy, px, controller.pos[1], pz);
      const effectiveTentTier: 0 | 1 | 2 | 3 = underCanopy ? 1 : tentTierVal;

      const exposed = isExposed({
        inDungeon: dungeonManager.isInside || buildingManager.isInside,
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
    const now = Date.now();
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
    controller.pos = [...SPAWN_POS] as [number, number, number];
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
    resourceManager.treeVisible(cx, cz, i, Date.now());
  resourceManager.onTreesChanged = (cx, cz) => chunkManager.refreshTrees(cx, cz);

  // ?tod=0.5 freezes the day-night cycle (screenshots, deterministic e2e).
  const todParam = new URLSearchParams(location.search).get('tod');
  const todFreeze =
    todParam !== null && Number.isFinite(Number(todParam))
      ? Number(todParam)
      : null;

  // ?weather=clear|overcast|rain pins the weather (same purpose as ?tod=).
  const weatherParam = new URLSearchParams(location.search).get('weather');
  const weatherPin: Weather | null =
    weatherParam !== null && weatherParam in WEATHER_PRESETS
      ? WEATHER_PRESETS[weatherParam as WeatherKind]
      : null;

  // AI Director: ON by default (proven in M0/M4) — opt out with ?director=off.
  // Shares the game's GPU device; failures degrade to fixtures, never __gameError.
  const directorOff = new URLSearchParams(location.search).get('director') === 'off';

  // NPC dialogue model: defaults to the abliterated Qwen3-1.7B Q4_K_M —
  // conversations can go anywhere without safety boilerplate, and the small
  // model keeps replies snappy. ?npcllm=abliterated picks the smarter/slower
  // 4B; ?npcllm=default reuses the Director model. See NPC_MODELS in
  // npc-chat-panel.ts.
  const npcLlmParam = new URLSearchParams(location.search).get('npcllm');
  const npcModelKey: import('./ui/npc-chat-panel').NpcModelKey =
    npcLlmParam !== null && isNpcModelKey(npcLlmParam) ? npcLlmParam : 'fast';
  if (npcLlmParam !== null && !isNpcModelKey(npcLlmParam)) {
    console.warn(`[NPC chat] unknown ?npcllm=${npcLlmParam} — using default`);
  }
  const director = !directorOff
    ? new DungeonDirector({
        seed: WORLD_SEED,
        gpu,
        heightAt: (x, z) => heightField.heightAt(x, z),
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
    renderer, heightField, terrainWorld, controller, orbitCam, WORLD_SEED,
    director);
  // Chest loot lands in the pack (leftovers vanish — chests are small).
  dungeonManager.onLoot = (items) => {
    for (const id of items) addItem(inventory, id);
    saveInventory(inventory);
    hotbar.refresh();
    audio.play('chest_open'); // Feature 10: chest open SFX
  };

  // -------------------------------------------------------------------------
  // Building interiors (enterable settlement buildings)
  // -------------------------------------------------------------------------
  const buildingManager = new BuildingManager(
    renderer, heightField, terrainWorld, controller, orbitCam, WORLD_SEED);
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
  }
  const npcPool: NpcPoolEntry[] = [];

  const NPC_WALK_SPEED = 1.2;  // m/s
  const NPC_RENDER_DIST = 120; // m
  const NPC_SIM_DIST = 150;    // m (skip AI beyond this)
  const NPC_INTERACT_DIST = 3; // m (E-key reach)
  const NPC_MAX_DRAWN = 12;

  function getNpcPoolEntry(i: number): NpcPoolEntry {
    while (npcPool.length <= i) {
      const vertexBuffer = renderer.device.createBuffer({
        label: `npc-mesh-${npcPool.length}`,
        size: CHARACTER_MAX_VERTS * 24,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      const { bindGroup, buffer: objectBuffer } =
        renderer.createObjectBindGroup(0, 0, 0, 1);
      npcPool.push({ vertexBuffer, objectBuffer, bindGroup });
    }
    return npcPool[i];
  }

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
    npcRuntimes = resolved.map((npc, i) => {
      // Per-NPC deterministic rng seeded from npc id.
      let idHash = 0x811c9dc5 >>> 0;
      for (let c = 0; c < npc.id.length; c++) {
        idHash ^= npc.id.charCodeAt(c);
        idHash = Math.imul(idHash, 0x01000193) >>> 0;
      }
      const rng = mulberry32(idHash);
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
  function tickNpcs(dtS: number): void {
    if (npcsDirty) rebuildNpcRuntimes();
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
            damagePlayer(vitals, CIVILIAN_MELEE_DMG, 'combat', totalDefense(inventory));
            triggerDamageFlash();
            saveVitals(vitals);
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
    const candidates = npcRuntimes
      .map((rt) => ({ rt, dist: Math.hypot(rt.wx - playerX, rt.wz - playerZ) }))
      .filter((c) => c.dist <= NPC_RENDER_DIST)
      // Corpses stay drawn while sinking, then disappear for good.
      .filter((c) => c.rt.hp > 0 ||
        (c.rt.deadAtS !== undefined && simTime - c.rt.deadAtS < NPC_CORPSE_SINK_S))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, NPC_MAX_DRAWN);

    const draws: import('./renderer').TerrainDraw[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const { rt } = candidates[i];
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
      }, null, opts);
      // Corpse-sink: dead NPCs slide below ground over NPC_CORPSE_SINK_S.
      let drawY = rt.wy;
      if (rt.hp <= 0 && rt.deadAtS !== undefined) {
        const p = Math.min(1, (simTime - rt.deadAtS) / NPC_CORPSE_SINK_S);
        drawY = rt.wy - p * 1.9;
      }
      const entry = getNpcPoolEntry(i);
      renderer.device.queue.writeBuffer(entry.vertexBuffer, 0, verts);
      renderer.device.queue.writeBuffer(
        entry.objectBuffer, 0,
        new Float32Array([rt.wx, drawY, rt.wz, 1]),
      );
      draws.push({
        vertexBuffer: entry.vertexBuffer,
        indexBuffer: null,
        count: verts.length / 6,
        bindGroup: entry.bindGroup,
      });
    }
    return draws;
  }

  /** Nearest NPC within NPC_INTERACT_DIST from the player, or null. */
  function nearestNpc(): NpcRuntime | null {
    const px = controller.pos[0];
    const pz = controller.pos[2];
    let best: NpcRuntime | null = null;
    let bestD = NPC_INTERACT_DIST;
    for (const rt of npcRuntimes) {
      if (rt.hp <= 0) continue; // the dead don't chat
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

    const persona: import('./npc/npc-prompt').NpcPersona = {
      role: npcRt.npc.role,
      name: npcRt.npc.name,
      settlement: settName,
      playerBounty: realBounty,
      neighbors,
      worldFacts,
      following: npcRt.following === true,
      quirk: npcQuirkFor(npcRt.npc.id),
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
            buildingManager.enterNpcHome(sett, actionNpcId);
          setGatherNotice(entered
            ? `${rt.npc.name} welcomes you into their home.`
            : `${rt.npc.name} gestures toward their home.`);
        }
        // Threatening a civilian in front of a guard is a crime.
        if ((action === 'hostile' || action === 'afraid') && rt.npc.role !== 'guard') {
          const guardSaw = npcRuntimes.some((o) =>
            o !== rt && o.npc.role === 'guard' &&
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

  // DEMO: starter tamed dragon at spawn (user request for testing).
  // Live entities are not persisted across reloads, so each boot re-ensures
  // one owned, fully-tamed dragon beside the spawn point. Owned entities
  // follow the player, never aggro, and are exempt from cap/unload.
  {
    const sd = entityManager.spawnEntity(
      'dragon', SPAWN_POS[0] + 6, SPAWN_POS[2] + 6);
    if (sd !== null) {
      sd.owned = true;
      sd.mode = 'follow';
      tamingRegistry.tamed[sd.id] = { temper: 100, tamed: true };
      saveTamingRegistry(tamingRegistry);
    }
  }

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

  /** Vertical ascent/descent speed (m/s) for dragon flight. */
  const DRAGON_FLIGHT_SPEED = 6;
  /** Minimum epsilon above terrain when on the ground (m). */
  const DRAGON_GROUND_EPSILON = 0.05;
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
  /** Damage applied per breath tick to animals / NPCs in the cone. */
  const BREATH_DMG_ENTITY = 3;
  const BREATH_DMG_NPC = 4;
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
  /** Jaw-open blend 0..1 (eases in/out; drives the dragon mesh + VFX gate). */
  let breathJaw = 0;
  /** Accumulator for the periodic breath damage tick. */
  let breathTickAccum = 0;
  /** Remaining cooldown before the next stomp (seconds). */
  let stompCooldown = 0;

  /**
   * Saddle offset: player sits at entity's shoulder height.
   * Saddle y = entity.y + SPECIES_DEFS[species].size.
   */
  function saddleY(species: Species, entityY: number): number {
    return entityY + SPECIES_DEFS[species].size;
  }

  /** Dismount the player from the currently-mounted entity. */
  function doDisMount(): void {
    if (mountedEntityId === null) return;
    const e = entityManager.entities.get(mountedEntityId);
    if (e) {
      // Place player beside the entity (same x/z offset, at the current entity y).
      const offset = SPECIES_DEFS[e.species].size + 0.5;
      controller.pos[0] = e.x + offset;
      controller.pos[2] = e.z;
      // Mid-air dismount: preserve altitude so player falls from current height.
      // controller.y is set to current saddle height; player controller's gravity
      // will take over and bring them back to terrain.
      controller.pos[1] = saddleY(e.species, e.y);
      controller.velY = 0;

      // When dismounting a flying dragon, mark its target y as ground so the
      // entity's follow-mode AI (which uses heightAt) will lerp it down naturally.
      // We store the target as a property on the entity so tickEntities can
      // ease it down; if dragonFlightY > 0 the entity is airborne.
      if (e.species === 'dragon' && DRAGON_FLIGHT_ENABLED && dragonFlightY > 0) {
        // Dragon starts descending immediately: set its own velY-like descent
        // by flagging it for ground-return.
        (e as import('./entities/entity-manager').EntityState & { _landingY?: number })._landingY =
          heightField.heightAt(e.x, e.z);
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
    let best: import('./entities/entity-manager').EntityState | null = null;
    let bestDist = MOUNT_REACH;
    for (const e of entityManager.entities.values()) {
      if (e.mode === 'dead') continue;
      const def = SPECIES_DEFS[e.species];
      if (!def.mountable) continue;
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
    const isDragonFlight = e.species === 'dragon' && DRAGON_FLIGHT_ENABLED;

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

      // Clamp: never below terrain + epsilon.
      const minY = groundY + DRAGON_GROUND_EPSILON;
      if (newEntityY < minY) newEntityY = minY;
      e.y = newEntityY;

      // Update flight altitude tracker.
      dragonFlightY = e.y - groundY;

      // Flight stamina drain while airborne (never force a fall, just drain for budget).
      if (dragonFlightY > DRAGON_GROUND_EPSILON * 2) {
        e.stamina = Math.max(0, e.stamina - DRAGON_FLIGHT_DRAIN_PER_S * dtS);
      }
    }

    if (hasMovement) {
      const len = Math.hypot(ix, iz);
      const camYaw = orbitCam.yaw;
      const sin = Math.sin(camYaw);
      const cos = Math.cos(camYaw);
      const dx = ((ix * cos + iz * sin) / len) * speed * dtS;
      const dz = ((-ix * sin + iz * cos) / len) * speed * dtS;
      // Collision: slide along settlement solids like the player, except when
      // the dragon is flying high enough to clear walls.
      if (isDragonFlight && dragonFlightY > 4) {
        e.x += dx;
        e.z += dz;
      } else {
        const mr = Math.max(0.4, SPECIES_DEFS[e.species].size * 0.45);
        [e.x, e.z] = terrainWorld.moveXZ(e.x, e.z, dx, dz, mr);
      }
      e.yaw = Math.atan2(dx, -dz);
      e.walkPhase += speed * dtS * 1.6;
      // Dragon flight: do NOT snap y to terrain — the flight logic above controls y.
      // Ground mounts: snap y to terrain as before.
      if (!isDragonFlight) {
        e.y = heightField.heightAt(e.x, e.z);
      } else {
        // After horizontal movement the terrain under us may have changed;
        // re-clamp so we don't clip through a hill.
        const newGroundY = heightField.heightAt(e.x, e.z);
        if (e.y < newGroundY + DRAGON_GROUND_EPSILON) {
          e.y = newGroundY + DRAGON_GROUND_EPSILON;
        }
        dragonFlightY = e.y - newGroundY;
      }
    } else if (isDragonFlight && dragonFlightY > DRAGON_GROUND_EPSILON * 2) {
      // Airborne and not moving horizontally: keep walkPhase advancing for wing flap.
      e.walkPhase += DRAGON_AIRBORNE_FLAP_RATE * dtS;
    }

    // Lock player to saddle.
    controller.pos[0] = e.x;
    controller.pos[1] = saddleY(e.species, e.y);
    controller.pos[2] = e.z;
    controller.velY = 0;
    controller.yaw = e.yaw;

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
        controller.pos[1] = heightField.heightAt(controller.pos[0], controller.pos[2]);
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
    if (!e || e.species !== 'dragon' || e.mode === 'dead') return null;
    const s = SPECIES_DEFS.dragon.size;
    const fx = Math.sin(e.yaw);   // dragon facing (mesh forward = local -Z)
    const fz = -Math.cos(e.yaw);
    const f = orbitCam.forward(); // unit vector, camera → look target
    const horiz = Math.hypot(f[0], f[2]); // camera pitch split: cos(pitch)
    const dir: [number, number, number] = [fx * horiz, f[1], fz * horiz];
    const mouth: [number, number, number] = [
      e.x + fx * s * 1.27,
      e.y + s * 1.61,
      e.z + fz * s * 1.27,
    ];
    return { mouth, dir };
  }

  /** True if world point (x, y, z) lies inside the breath cone. */
  function inBreathCone(
    mouth: [number, number, number],
    dir: [number, number, number],
    x: number, y: number, z: number,
  ): boolean {
    const vx = x - mouth[0];
    const vy = y - mouth[1];
    const vz = z - mouth[2];
    const dist = Math.hypot(vx, vy, vz);
    if (dist > BREATH_RANGE || dist < 0.001) return false;
    const dot = (vx * dir[0] + vy * dir[1] + vz * dir[2]) / dist;
    return dot >= Math.cos(BREATH_HALF_ANGLE);
  }

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
          Math.hypot(rt.wx - px, rt.wz - pz) <= WITNESS_RADIUS);
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
          Math.hypot(rt.wx - px, rt.wz - pz) <= WITNESS_RADIUS);
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
  function damageNpcFromMount(rt: NpcRuntime, dmg: number): void {
    const px = controller.pos[0];
    const pz = controller.pos[2];
    rt.hp = Math.max(0, rt.hp - dmg);
    rt.fleeing = true;
    const killedNpc = rt.hp <= 0;
    if (killedNpc) onNpcKilled(rt);
    const crimeKind = killedNpc ? 'murder' as const : 'assault' as const;
    const witnessed = npcRuntimes.some(other => {
      if (other === rt) return false;
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
  ): void {
    // Animals (skip the mount itself and the dead).
    for (const e of entityManager.entities.values()) {
      if (e.id === mountedEntityId || e.mode === 'dead') continue;
      const def = SPECIES_DEFS[e.species];
      if (!inBreathCone(mouth, dir, e.x, e.y + def.size * 0.5, e.z)) continue;
      damageEntityFromMount(e, BREATH_DMG_ENTITY);
    }
    // NPCs.
    for (const rt of npcRuntimes) {
      if (rt.hp <= 0) continue;
      const ny = heightField.heightAt(rt.wx, rt.wz) + 0.9;
      if (!inBreathCone(mouth, dir, rt.wx, ny, rt.wz)) continue;
      damageNpcFromMount(rt, BREATH_DMG_NPC);
    }
    // Trees ignite (reuses the lightning burning-tree system).
    const midX = mouth[0] + dir[0] * BREATH_RANGE * 0.5;
    const midZ = mouth[2] + dir[2] * BREATH_RANGE * 0.5;
    const trees = resourceManager.nearbyTreeRefs(midX, midZ, BREATH_RANGE * 0.7, Date.now());
    const burning = getBurningTrees();
    for (const tr of trees) {
      if (!inBreathCone(mouth, dir, tr.x, tr.y + 2, tr.z)) continue;
      if (burning.some(b => b.x === tr.x && b.z === tr.z)) continue; // already alight
      addBurningTree({ x: tr.x, y: tr.y, z: tr.z, untilS: simTime + TREE_BURN_S });
    }
    // Bushes in the cone catch too (quick tinder, shorter burn).
    const bushes = resourceManager.nearbyBushRefs(midX, midZ, BREATH_RANGE * 0.7, Date.now());
    for (const bu of bushes) {
      if (!inBreathCone(mouth, dir, bu.x, bu.y + 0.5, bu.z)) continue;
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

    if (mounted.species === 'dragon') {
      // --- Fire breath ---
      if (fHeld && mounted.stamina > BREATH_MIN_STAMINA) {
        breathActive = true;
        // Feature 10: dragon_roar SFX when breath starts.
        if (!prevBreathActive) audio.play('dragon_roar');
        prevBreathActive = true;
        mounted.stamina = Math.max(0, mounted.stamina - BREATH_STAMINA_DRAIN_PER_S * dtS);
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
          if (ray !== null) applyBreathDamage(ray.mouth, ray.dir);
        }
      } else {
        breathJaw = Math.max(0, breathJaw - dtS / 0.25);
        breathTickAccum = 0;
        prevBreathActive = false; // Feature 10: reset for next breath start
      }
      entityRenderer.jawOverride = breathJaw > 0.01
        ? { id: mounted.id, jawOpen: breathJaw } : null;
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
      const { bindGroup } = renderer.createObjectBindGroup(0, 0, 0, 101);
      nestDraws.push({
        draw: { vertexBuffer: vb, indexBuffer: null, count: verts.length / 3, bindGroup },
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
      const { bindGroup } = renderer.createObjectBindGroup(0, 0, 0, mode);
      eggDraws.push({
        draw: { vertexBuffer: vb, indexBuffer: null, count: verts.length / 3, bindGroup },
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

  window.__gameDebug = {
    enterNearestDungeon: () => dungeonManager.debugEnterNearest(),
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
      resourceManager.nearestNode(controller.pos, Infinity, Date.now(), 2),
    teleportToNearestResource: (type: string) => {
      const node = resourceManager.nearestNode(
        controller.pos, Infinity, Date.now(), 6,
        type as NodeType);
      if (node === null) return false;
      controller.pos = [node.x + 1.0, node.y + 1.0, node.z];
      controller.velY = 0;
      return true;
    },
    setCamera: (yaw: number, pitch: number, distance: number) => {
      orbitCam.yaw = yaw;
      orbitCam.pitch = pitch;
      orbitCam.distance = distance;
    },
    freezeAttackT: (t: number | null) => {
      attackTOverride = t;
    },
    equipItem: (id: string) => {
      if (!isGameItemId(id)) return false;
      inventory.hotbar[inventory.selected] = { id, count: 1 };
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
    setVitals: (partial: Partial<Vitals>) => {
      Object.assign(vitals, partial);
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
      projectiles.push({ x, y, z, vx: 0, vy: 0, vz: 0, born: simTime, kind, damage });
      return projectiles.length;
    },
    projectileCount: () => projectiles.length,
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
    countItem: (id: string) => countItem(inventory, id as import('./items').GameItemId),
    // Phase L2 NPC chat hooks
    chatOpen: () => chatState().open,
    lastNpcReply: () => chatState().lastReply,
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
        controller.pos = [site.x + 5, heightField.heightAt(site.x + 5, site.z), site.z];
        controller.velY = 0;
        return true;
      }
      controller.pos = [best.site.x + 5, heightField.heightAt(best.site.x + 5, best.site.z), best.site.z];
      controller.velY = 0;
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
  };

  // --- ?dungeon=preview: fly around fixture 0's interior (M2 debug) --------
  // No collision/portals yet — fly cam only, dark fog, bright-ambient shader
  // fallback (zeroed lights buffer → count 0).
  const dungeonPreview =
    new URLSearchParams(location.search).get('dungeon') === 'preview';
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
    const { bindGroup } = renderer.createObjectBindGroup(0, -300, 0, 0);
    const lightsBuffer = renderer.device.createBuffer({
      label: 'dungeon-preview-lights',
      size: LIGHTS_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    dungeonDraws = [{
      draw: { vertexBuffer, indexBuffer: null, count: verts.length / 3, bindGroup },
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
    if (!open) {
      // If the NPC chat panel was just closed, reset its state.
      onNpcChatClosed();
    }
  });

  // Always-visible hotbar; any model change persists + re-renders.
  const invChanged = () => {
    saveInventory(inventory);
    hotbar.refresh();
  };
  const hotbar = new Hotbar(inventory, invChanged);

  overlay.addEventListener('click', () => canvas.requestPointerLock());
  document.addEventListener('pointerlockchange', () => {
    overlay.classList.toggle(
      'hidden', document.pointerLockElement === canvas || panels.isOpen);
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
    if (e.code === 'KeyC' && !flyMode) {
      audio.play('ui_click');
      panels.toggle('character', () => buildCharacterPanel(
        () => custom,
        (c) => { custom = c; saveCustomization(c); }));
      return;
    }
    if ((e.code === 'Tab' || e.code === 'KeyI') && !flyMode) {
      e.preventDefault();
      audio.play('ui_click');
      panels.toggle('inventory', () => buildInventoryPanel(inventory, invChanged));
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
      panels.toggle('help', () => {
        const el = document.createElement('div');
        el.id = 'help-panel';
        const title = document.createElement('h2');
        title.textContent = 'Controls';
        el.appendChild(title);
        const controls: [string, string][] = [
          ['WASD',       'Move / strafe'],
          ['Shift',      'Sprint'],
          ['Space',      'Jump (or paddle while swimming)'],
          ['Mouse',      'Orbit camera / aim'],
          ['Wheel',      'Zoom camera'],
          ['Left-click', 'Gather / attack / use / shoot'],
          ['Right-click','Toggle pet stay/follow'],
          ['E',          'Interact / talk / eat / drink / mount'],
          ['F',          'Dragon fire breath / mount stomp'],
          ['I / Tab',    'Inventory'],
          ['B',          'Crafting'],
          ['C',          'Character customization'],
          ['R',          'Toggle fly camera (debug)'],
          ['M',          'Toggle mute audio'],
          ['H',          'Help (this panel)'],
          ['Esc',        'Close panel / game menu'],
          ['F8',         'Debug snapshot'],
          ['F9',         'Toggle auto-snapshot'],
        ];
        for (const [key, desc] of controls) {
          const row = document.createElement('div');
          row.className = 'panel-row';
          row.style.cssText = 'display:flex;gap:8px;align-items:baseline';
          const keyEl = document.createElement('span');
          keyEl.style.cssText = [
            'font:600 11px system-ui,sans-serif',
            'background:rgba(205,214,228,0.12)',
            'border:1px solid rgba(205,214,228,0.25)',
            'border-radius:4px',
            'padding:1px 6px',
            'min-width:80px',
            'text-align:center',
            'flex-shrink:0',
          ].join(';');
          keyEl.textContent = key;
          const descEl = document.createElement('span');
          descEl.style.cssText = 'font:400 11px system-ui,sans-serif;opacity:0.8';
          descEl.textContent = desc;
          row.appendChild(keyEl);
          row.appendChild(descEl);
          el.appendChild(row);
        }
        const hint = document.createElement('div');
        hint.className = 'hint';
        hint.textContent = 'Press H or Esc to close';
        el.appendChild(hint);
        return el;
      });
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
      if (panels.isOpen) {
        panels.close();
      } else {
        // Game menu: Save / Load / New Game. (While pointer-locked the browser
        // consumes the first Esc to exit the lock, so it's Esc, Esc — fine.)
        panels.toggle('menu', () => buildGameMenuPanel({
          slots: listSlots(),
          canSave: !dungeonManager.isInside && !buildingManager.isInside,
          onSave: (slot) => {
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
        }));
      }
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
    if (e.code === 'KeyE') {
      // Phase M: jail escape check first
      if (jailRecord !== null && tryJailEscape()) {
        // escape handled
      } else if (dungeonManager.interactPrompt !== null) {
        dungeonManager.tryInteract();
      } else if (buildingManager.interactPrompt !== null) {
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
      } else if (!dungeonManager.isInside && !buildingManager.isInside && nearestNpc() !== null) {
        // Phase L2: E near an NPC → open NPC chat panel.
        // Prevent the "e" from being typed into the auto-focused chat input.
        e.preventDefault();
        openNpcChatFor(nearestNpc()!);
      } else if (!dungeonManager.isInside && !buildingManager.isInside && tryStallInteract(e)) {
        // Market stall: opens the attending merchant's chat (or a notice).
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
      controller.pos, GATHER_REACH, Date.now());
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
    const now = Date.now();
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
  // Phase J: entity AI tick (called once per sim step)
  // -------------------------------------------------------------------------
  function tickEntities(dtS: number): void {
    const px = controller.pos[0];
    const pz = controller.pos[2];

    // Tick dungeon enemies when inside — replaces the normal overworld tick.
    if (dungeonManager.isInside) {
      dungeonManager.tickEnemies(dtS, px, pz, (damage: number) => {
        damagePlayer(vitals, damage, 'animal', totalDefense(inventory));
        triggerDamageFlash();
        saveVitals(vitals);
      });
      return;
    }
    // Update cell streaming.
    entityManager.update(px, pz);

    for (const e of entityManager.entities.values()) {
      if (e.mode === 'dead') continue;
      // Phase K: mounted entity is steered by tickMount, skip normal AI.
      if (e.id === mountedEntityId) continue;

      // Dragon flight: if a dragon was just dismounted while airborne, ease it
      // back down to terrain over the next few seconds before handing off to
      // the normal follow-mode AI (which already ground-snaps via heightAt).
      if (DRAGON_FLIGHT_ENABLED && e.species === 'dragon') {
        const eExt = e as import('./entities/entity-manager').EntityState & { _landingY?: number };
        if (eExt._landingY !== undefined) {
          const groundY = heightField.heightAt(e.x, e.z);
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
      stepAnimal(e, dtS, {
        playerX: px,
        playerZ: pz,
        playerDist,
        rng,
        heightAt: (x, z) => heightField.heightAt(x, z),
        moveXZ: (x, z, dx, dz, r) => terrainWorld.moveXZ(x, z, dx, dz, r),
        speciesDef: SPECIES_DEFS[e.species],
        onAttackPlayer: (damage: number) => {
          // Phase K: cannot attack while the entity is owned (baby/tamed).
          if ((e as import('./entities/entity-manager').EntityState & { owned?: boolean }).owned) return;
          damagePlayer(vitals, damage, 'animal', totalDefense(inventory));
          triggerDamageFlash();
          audio.play('hurt'); // Feature 10: player hurt SFX
          saveVitals(vitals);
        },
      });
      // Growl/roar on entering aggro (wolf, bear, dragon, etc.).
      if (prevMode !== 'aggro' && e.mode === 'aggro') {
        const def = SPECIES_DEFS[e.species];
        const sfxName = def.aggro && e.species === 'dragon' ? 'dragon_roar' : 'growl';
        audio.play(sfxName, { dist: playerDist });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Phase H: active projectiles (thrown stones + arrows)
  // -------------------------------------------------------------------------
  interface Projectile {
    x: number; y: number; z: number;
    vx: number; vy: number; vz: number;
    born: number; // simTime at spawn
    /** 'stone' | 'arrow' — determines hit radius and damage */
    kind: 'stone' | 'arrow';
    /** Damage dealt on entity hit. */
    damage: number;
  }
  const projectiles: Projectile[] = [];

  /** simTime of the last bow shot; enforces 0.6 s fire-rate limit. */
  let lastBowShotS = -999;

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
    projectiles.push({
      x: controller.pos[0],
      y: controller.pos[1] + 1.2, // launch from chest height
      z: controller.pos[2],
      vx, vy, vz,
      born: simTime,
      kind: 'stone',
      damage: 2,
    });
    attackT = 0; // play swing animation
    return true;
  }

  /**
   * Fire an arrow from the held bow (hunter_bow or composite_bow).
   * Requires ≥1 arrow in inventory; consumes 1. Enforces 0.6 s fire-rate.
   * Arrow: ~28 m/s, slight gravity arc, max range ~40 m or terrain hit.
   * Damage: hunter_bow 6, composite_bow 9.
   */
  function tryFireBow(): boolean {
    const heldId2 = equipped(inventory);
    if (heldId2 !== 'hunter_bow' && heldId2 !== 'composite_bow') return false;

    // Fire-rate limit: 0.6 s between shots.
    if (simTime - lastBowShotS < 0.6) return false;

    // Require and consume 1 arrow.
    if (countItem(inventory, 'arrow') < 1) {
      setGatherNotice('No arrows');
      return true; // consumed the action (show notice, no shot)
    }
    removeItem(inventory, 'arrow', 1);
    invChanged();

    const damage = heldId2 === 'composite_bow' ? 9 : 6;
    const yaw = -orbitCam.yaw;
    // Flat trajectory: fire at camera pitch (near-flat), slight gravity handles arc.
    const pitch = orbitCam.pitch;
    const speed = 28;
    const vx = Math.sin(yaw) * Math.cos(pitch) * speed;
    const vy = Math.sin(pitch) * speed;
    const vz = -Math.cos(yaw) * Math.cos(pitch) * speed;
    projectiles.push({
      x: controller.pos[0],
      y: controller.pos[1] + 1.2, // launch from chest height
      z: controller.pos[2],
      vx, vy, vz,
      born: simTime,
      kind: 'arrow',
      damage,
    });
    lastBowShotS = simTime;
    attackT = 0; // draw/release animation feedback
    return true;
  }

  // Update projectiles in the sim loop (called each tick).
  function tickProjectiles(dt: number): void {
    const GRAVITY = 9.8;
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      p.vy -= GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      // Hit-radius and max-lifetime per kind.
      const hitRadius = p.kind === 'arrow' ? 0.8 : 1.2;
      // Arrows: max range ~40 m (at 28 m/s → ~1.43 s); stones: 3 s max.
      const maxAge = p.kind === 'arrow' ? 1.5 : 3;

      // Entity hit-test: check all live entities (dungeon or overworld) within hit radius.
      let hit = false;
      const projTargets: Iterable<import('./entities/entity-manager').EntityState> =
        dungeonManager.isInside
          ? dungeonManager.dungeonEnemies()
          : entityManager.entities.values();
      for (const e of projTargets) {
        if (e.mode === 'dead') continue;
        const specSize = SPECIES_DEFS[e.species].size;
        // Scale hit radius by entity size (larger targets easier to hit).
        const effectiveRadius = hitRadius * Math.max(1, specSize);
        const dx = e.x - p.x;
        const dz = e.z - p.z;
        const dy = e.y + specSize * 0.5 - p.y; // aim for body centre
        const dist3 = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist3 > effectiveRadius) continue;

        // Apply damage via the same path as melee.
        e.hp = Math.max(0, e.hp - p.damage);
        if (e.hp <= 0) {
          e.mode = 'dead';
          if (e.deadAtS === undefined) e.deadAtS = simTime;
          if (dungeonManager.isInside) {
            setGatherNotice(`Killed ${SPECIES_DEFS[e.species].name}!`);
          } else {
            entityManager.killEntity(e.id);
            setGatherNotice(`Killed ${SPECIES_DEFS[e.species].name}!`);
            // Crime: kill_owned_animal if npcOwned
            if (e.npcOwned) {
              const ridP = nearestRegionId();
              const witnessedP = npcRuntimes.some(rt => {
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
              const d = Math.hypot(rt.wx - controller.pos[0], rt.wz - controller.pos[2]);
              return d <= WITNESS_RADIUS;
            });
            if (witnessedP) {
              reportCrime(crimeState, ridP, 'assault', simTime);
              saveCrimeState(crimeState);
            }
          }
        }
        hit = true;
        break; // one hit per projectile
      }

      // Feature 4: Projectiles also hit NPC runtimes (overworld only).
      if (!hit && !dungeonManager.isInside) {
        const npcHitRadius = p.kind === 'arrow' ? 0.7 : 1.0;
        for (const rt of npcRuntimes) {
          if (rt.hp <= 0) continue;
          const dx4 = rt.wx - p.x;
          const dz4 = rt.wz - p.z;
          const dy4 = rt.wy + 0.9 - p.y; // aim for body centre
          const dist4 = Math.sqrt(dx4 * dx4 + dy4 * dy4 + dz4 * dz4);
          if (dist4 > npcHitRadius) continue;
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
            if (other === rt) return false;
            const d = Math.hypot(other.wx - controller.pos[0], other.wz - controller.pos[2]);
            return d <= WITNESS_RADIUS;
          });
          if (witnessedProj) {
            reportCrime(crimeState, ridProj, crimeKindProj, simTime);
            saveCrimeState(crimeState);
            setGatherNotice(`${killedByProj ? 'Murder' : 'Assault'}! Bounty +${BOUNTY_AMOUNTS[crimeKindProj]}`);
          }
          hit = true;
          break;
        }
      }

      // Despawn on entity hit, terrain hit, or max age.
      const groundY = heightField.heightAt(p.x, p.z);
      if (hit || p.y <= groundY || simTime - p.born > maxAge) {
        projectiles.splice(i, 1);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Left-click: 8-step priority resolver (Phase H + ranged combat)
  // -------------------------------------------------------------------------
  // Left-click while locked in — priority chain (first match wins):
  //  1. Gather node in range
  //  2. Placeable selected (campfire_kit, tent items)
  //  3. Fill container at fresh water
  //  4. Consume edible/drinkable
  //  5. Ignite fire (fire_starter or torch aimed at unlit campfire)
  //  6. Bow shot (hunter_bow / composite_bow) — shoots arrow, consumes 1 arrow
  //  7. Throw stone (or other throwable)
  //  8. Attack swing (fallback)
  // Right click: toggle stay/sit on a nearby owned animal (mounts, pets).
  // A staying animal sits where it was left and stops following the player.
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 2 || flyMode || panels.isOpen) return;
    if (document.pointerLockElement !== canvas) return;
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
      ? `The ${stayName} sits and stays here. (right-click to call)`
      : `The ${stayName} follows you again.`);
  });
  window.addEventListener('contextmenu', (e) => {
    if (document.pointerLockElement === canvas) e.preventDefault();
  });

  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || flyMode || panels.isOpen) return;
    if (document.pointerLockElement !== canvas) return;
    if (attackT < 1) return; // swing still in progress

    // Phase K: attacking is disabled while mounted.
    if (mountedEntityId !== null) return;

    attackT = 0;
    controller.yaw = -orbitCam.yaw;
    audio.play('swing'); // Feature 10: melee swing SFX

    const heldId2 = equipped(inventory);

    // 1. Gather node in range
    const node = resourceManager.nearestNode(controller.pos, GATHER_REACH, Date.now());
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

    // 6. Bow shot (hunter_bow / composite_bow): shoots arrow, trumps throw and swing.
    if (tryFireBow()) return;

    // 7. Throw stone or throwable
    if (tryThrow()) return;

    // 8. Fallback: hit-test entities, then attack swing animation.
    // Entity hit: within 3.2 m and roughly facing (dot > 0.3).
    {
      // Every melee swing costs stamina (one-shot drain: 3 × 1 s).
      drainStamina(vitals, 3, 1);
      const ENTITY_HIT_DIST = 3.2;
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
        const ex = e.x - px7;
        const ez = e.z - pz7;
        const dist7 = Math.hypot(ex, ez);
        if (dist7 > ENTITY_HIT_DIST) continue;
        // Facing check: dot product of facing vector and direction to entity.
        const dot7 = (dist7 > 0.001)
          ? (facingX * ex / dist7 + facingZ * ez / dist7)
          : 1;
        if (dot7 < 0.3) continue;

        // Apply damage.
        e.hp = Math.max(0, e.hp - weaponDmg);
        audio.play('hit'); // Feature 10: entity hit SFX
        // Knockback shove — strong enough to visibly interrupt a charge.
        if (dist7 > 0.001) {
          e.x += (ex / dist7) * 1.2;
          e.z += (ez / dist7) * 1.2;
        }
        if (e.hp <= 0) {
          e.mode = 'dead';
          if (e.deadAtS === undefined) e.deadAtS = simTime;
          if (dungeonManager.isInside) {
            // Dungeon kill: just mark dead (no persistence needed — respawn on re-entry).
            setGatherNotice(`Killed ${SPECIES_DEFS[e.species].name}!`);
          } else {
            entityManager.killEntity(e.id);
            setGatherNotice(`Killed ${SPECIES_DEFS[e.species].name}!`);
            // Crime: kill_owned_animal if npcOwned
            if (e.npcOwned) {
              const ridM = nearestRegionId();
              const witnessedKill = npcRuntimes.some(rt => {
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
          if (other === rt) return false;
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
  });

  // Live debug capture (F8 snapshot / F9 auto) — see debug-capture.ts.
  const capture = new DebugCapture();

  // --- frame loop: RAF + fixed-timestep accumulator ------------------------
  let simTime = resumeState?.simTime ?? 0; // resumes the day/night clock on load

  let walkPhase = 0; // character walk cycle (radians, advances with distance)
  let walkAmp = 0;   // 0 idle → 1 full stride, smoothed
  let attackT = 1;   // 0→1 = one right-arm swing; 1 = idle (sin(π) = 0)
  let attackTOverride: number | null = null; // debug pose freeze (screenshots)
  let accum = 0;
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

  function tick(now: number) {
    accum = Math.min(accum + (now - last) / 1000, MAX_ACCUM);
    last = now;
    // Crash-recovery autosave: position + sim clock every 5 s while playing
    // outdoors on solid ground (interiors use arena coordinates; mid-flight
    // positions would drop the player from the sky on resume).
    if (now - lastAutoPosMs > 5000 && !isDead && mountedEntityId === null
        && !dungeonManager.isInside && !buildingManager.isInside && controller.grounded) {
      lastAutoPosMs = now;
      saveAutoPos({
        x: controller.pos[0], y: controller.pos[1], z: controller.pos[2], simTime,
      });
    }
    while (accum >= SIM_DT) {
      // Block movement while dead.
      if (!isDead) {
        if (flyMode) flyCam.update(SIM_DT);
        else controller.update(SIM_DT, orbitCam.yaw);
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
              return me !== undefined && me.species === 'dragon' && dragonFlightY > 0.5;
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
        const nearbyTrees = resourceManager.nearbyTreeRefs(px, pz, 3, Date.now());
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
          heldTorch:    isHoldingTorch,
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
          document.exitPointerLock();
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
      accum -= SIM_DT;
    }

    dungeonManager.update(controller.pos);
    buildingManager.update(controller.pos, settlementManager.nearby(), dungeonManager.isInside);
    const inDungeon = dungeonPreview || dungeonManager.isInside || buildingManager.isInside;
    controller.swimEnabled = !inDungeon; // interiors sit at y=-300, no sea there

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

    // Feature 6: Compass HUD update.
    updateCompass();

    // Camera + streaming follow the active viewpoint.
    const target = add(controller.pos, [0, PLAYER_HEIGHT * 0.85, 0]);
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
    };
    const charVerts = buildCharacterMesh(custom, {
      yaw: controller.yaw, walkPhase, walkAmp: effectiveWalkAmp, attackT,
    }, held, charOptions);
    renderer.device.queue.writeBuffer(player.vertexBuffer, 0, charVerts);
    player.draw.count = charVerts.length / 6;
    renderer.device.queue.writeBuffer(
      player.objectBuffer, 0, new Float32Array([p[0], p[1], p[2], 1]));

    const tod = todFreeze ?? (simTime / DAY_LENGTH_S + TOD_START) % 1;
    const env = envAt(tod);
    const wx = weatherPin ?? weatherAt(WORLD_SEED, simTime);

    // Feature 10: per-frame ambience + SFX wiring.
    if (!isDead) {
      const isNightForAudio = tod < 0.26 || tod >= 0.74;
      const fireNearIntensity = nearCampfireOrForge(fires, controller.pos[0], controller.pos[2], simTime)
        ? 1.0
        : (fireWarmthAt(fires, controller.pos[0], controller.pos[2], simTime) ? 0.5 : 0);
      const ambienceState: AmbienceState = {
        wind:     wx.cloudCover,
        rain:     wx.rainLevel,
        night:    isNightForAudio,
        interior: inDungeon,
        fireNear: fireNearIntensity,
      };
      audio.setAmbience(ambienceState);

      // Footstep SFX: tick accumulator while moving on ground.
      if (controller.grounded && controller.moveSpeed > 0 && !flyMode) {
        footstepAccum += SIM_DT;
        if (footstepAccum >= 0.45) {
          footstepAccum = 0;
          // Grass everywhere for now (surface type detection deferred).
          audio.play(inDungeon ? 'footstep_stone' : 'footstep_grass');
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
    const proj = perspectiveZO(Math.PI / 3, renderer.aspect, 0.1, 1200);
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
      rainLevel: inDungeon ? 0 : wx.rainLevel,
    };

    if (!inDungeon) {
      const prevNpcCount = settlementManager.nearbyNpcs().length;
      settlementManager.update(controller.pos);
      if (settlementManager.nearbyNpcs().length !== prevNpcCount) npcsDirty = true;
      resourceManager.update(controller.pos, Date.now());
      updateNestStream();
    }
    const draws = inDungeon ? [] : chunkManager.draws();
    const dDraws = dungeonPreview ? dungeonDraws : dungeonManager.draws();
    dDraws.push(...buildingManager.draws());
    if (!inDungeon) {
      dDraws.push(...settlementManager.draws());
      dDraws.push(...resourceManager.draws());
      dDraws.push(...fireDraws);
      updateBreathVfx();
      if (breathVertCount > 0 && breathVb !== null && breathBindGroup !== null) {
        dDraws.push({
          draw: {
            vertexBuffer: breathVb, indexBuffer: null,
            count: breathVertCount, bindGroup: breathBindGroup,
          },
          lightsBindGroup: getFireLightsBindGroup(),
        });
      }
      updateBurningVegVfx();
      if (burnVegVertCount > 0 && burnVegVb !== null && burnVegBindGroup !== null) {
        dDraws.push({
          draw: {
            vertexBuffer: burnVegVb, indexBuffer: null,
            count: burnVegVertCount, bindGroup: burnVegBindGroup,
          },
          lightsBindGroup: getFireLightsBindGroup(),
        });
      }
      dDraws.push(...tentDraws);
      dDraws.push(...eggDraws);
      dDraws.push(...nestDraws);
    }
    const treeDraws = inDungeon ? [] : chunkManager.treeDraws();
    // Build entity draws (animals): overworld OR dungeon enemies.
    const entityDraws = inDungeon
      ? entityRenderer.buildDraws(dungeonManager.dungeonEnemies(), eye[0], eye[2], simTime)
      : entityRenderer.buildDraws(entityManager.entities.values(), eye[0], eye[2], simTime);
    entityDrawnCount = entityDraws.length;

    // Build NPC draws (humanoids).
    const npcDraws = inDungeon ? [] : buildNpcDraws(eye[0], eye[2]);

    if (renderer.renderFrame(
      frame, draws, dDraws, !inDungeon, treeDraws, [player.draw, ...entityDraws, ...npcDraws])) {
      frameCount++;
      fpsFrames++;
      if (!window.__gameReady) window.__gameReady = true;
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
      fpsFrames = 0;
      fpsLast = now;
      const riverDrinkPrompt = (!inDungeon && nearFreshWater()
        && settlementManager.interactPrompt === null
        && dungeonManager.interactPrompt === null
        && buildingManager.interactPrompt === null)
        ? 'E — drink' : null;
      const prompt = dungeonManager.interactPrompt
        ?? buildingManager.interactPrompt
        ?? (inDungeon ? null
          : settlementManager.interactPrompt
            ?? riverDrinkPrompt
            ?? gatherPrompt());
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
        `${prompt ? `\n${prompt}` : ''}` +
        `${notice ? `\n${notice}` : ''}`;
      window.__gameStats = {
        frameCount,
        fps,
        chunkCount: chunkManager.count,
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
        entityCount: entityManager.entities.size,
        entityDrawn: entityDrawnCount,
        mountedEntityId,
        mountAltitude: (mountedEntityId !== null && DRAGON_FLIGHT_ENABLED)
          ? dragonFlightY
          : null,
        npcCount: npcRuntimes.length,
        // Phase M
        bounty: bountyIn(crimeState, nearestRegionId()),
        jailed: jailRecord !== null && Date.now() < jailRecord.jailedUntilMs,
        jailRemainS: jailRecord !== null
          ? Math.max(0, (jailRecord.jailedUntilMs - Date.now()) / 1000)
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
