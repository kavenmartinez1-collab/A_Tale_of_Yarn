/**
 * EntityManager — streams animal spawns for the 3×3 ECELL cells around the
 * player, materialises them into live EntityState objects, enforces a live cap,
 * and persists the killed-entity registry so corpses don't respawn for 10 min.
 *
 * Pure-ish core: cell math, killed-registry, respawn timing, and
 * serialize/deserialize are all DOM/GPU-free and node-testable.
 * The GPU / renderer coupling is done externally (entity-renderer.ts).
 */

import { mulberry32 } from '../mesh-utils';
import { mix32 } from '../dungeon/dungeon-layout';
import { entitiesForCell, type EntitySpawn } from './entity-scatter';
import { SPECIES_DEFS, ECELL, type Species } from './entity-types';
import type { Biome } from '../biome';
import type { EcologyDirector } from './ecology-director';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Dead entities don't respawn for this many real seconds (10 min). */
export const RESPAWN_S = 600;

/** Max live entities across all loaded cells. */
export const LIVE_CAP = 40;

/** Persistence keys. */
export const ENTITY_KILLED_KEY = 'artifex-entities:v1';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EntityMode = 'idle' | 'graze' | 'wander' | 'flee' | 'aggro' | 'dead' | 'follow';

export interface EntityState {
  id: string;
  species: Species;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  mode: EntityMode;
  walkPhase: number;
  colorVariant: number;
  homeX: number;
  homeZ: number;
  /** simTime (game seconds) at which this entity died, or undefined. */
  deadAtS?: number;
  /** Accumulator for AI state timers (used by animal-ai.ts). */
  stateTimer: number;
  /** Flee / aggro target cache. */
  fleeTimer: number;
  /**
   * Phase K: owned entities (hatched babies, tamed mounts).
   * Owned entities are never despawned by cell streaming or the live cap.
   */
  owned?: boolean;
  /**
   * Phase M: NPC-property flag. When true, mounting or killing this entity
   * is treated as horse_theft / kill_owned_animal by the crime system.
   */
  npcOwned?: boolean;
  /**
   * Phase K: scale multiplier for rendering baby animals (0 < scale ≤ 1).
   * Absent or 1 = full adult size.
   */
  scaleOverride?: number;
  /**
   * Mount stamina 0–100. Initialised to 100 when the entity is first mounted.
   * Persists on the entity object for the lifetime of the entity.
   */
  stamina?: number;
  /**
   * Owned entity told to stay put (right-click toggle). While true the
   * entity sits where it was left instead of following the player.
   */
  staying?: boolean;
  /** Eased sit amount 0..1 (0 = standing, 1 = fully sat). Drives draw-time sink. */
  sit?: number;
}

/** Serialized record for the killed registry. */
interface KilledRecord {
  killedAtS: number; // real wall-clock ms (Date.now())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cell indices from a world position. */
export function cellOf(x: number, z: number): [number, number] {
  return [Math.floor(x / ECELL), Math.floor(z / ECELL)];
}

/** Manhattan-ish distance in cells between two cell coordinates. */
function cellDist(ax: number, az: number, bx: number, bz: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(az - bz));
}

/** Centre-world coords of a cell. */
function cellCenter(cx: number, cz: number): [number, number] {
  return [cx * ECELL + ECELL / 2, cz * ECELL + ECELL / 2];
}

/**
 * Derive a stable colorVariant (0–3) from an entity id string.
 * Uses FNV-32a so it's deterministic without an extra rng draw.
 */
function variantFromId(id: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 3;
}

/**
 * A quick mulberry32 seeded from the entity id for per-entity decisions
 * (color, initial yaw) that need to be stable across re-materializations.
 */
function entityRng(id: string): () => number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return mulberry32(h);
}

// ---------------------------------------------------------------------------
// Killed-registry persistence
// ---------------------------------------------------------------------------

export function loadKilledRegistry(): Map<string, KilledRecord> {
  try {
    const raw = (typeof localStorage !== 'undefined')
      ? localStorage.getItem(ENTITY_KILLED_KEY)
      : null;
    if (raw === null) return new Map();
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return new Map();
    const map = new Map<string, KilledRecord>();
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'object' && v !== null && typeof (v as KilledRecord).killedAtS === 'number') {
        map.set(k, { killedAtS: (v as KilledRecord).killedAtS });
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

export function saveKilledRegistry(map: Map<string, KilledRecord>): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const obj: Record<string, KilledRecord> = {};
    for (const [k, v] of map) obj[k] = v;
    localStorage.setItem(ENTITY_KILLED_KEY, JSON.stringify(obj));
  } catch {
    // Storage quota exceeded — silently ignore.
  }
}

/**
 * Prune entries older than RESPAWN_S from the registry.
 * Returns the number of entries pruned.
 */
export function pruneKilledRegistry(
  map: Map<string, KilledRecord>,
  nowMs: number,
): number {
  let pruned = 0;
  for (const [id, rec] of map) {
    if (nowMs - rec.killedAtS >= RESPAWN_S * 1000) {
      map.delete(id);
      pruned++;
    }
  }
  return pruned;
}

// ---------------------------------------------------------------------------
// EntityManager
// ---------------------------------------------------------------------------

export class EntityManager {
  /** All currently live entities, keyed by id. */
  readonly entities = new Map<string, EntityState>();

  /** Set of cell keys ("cx,cz") currently loaded. */
  private loadedCells = new Set<string>();

  /** Killed registry: id → { killedAtS (wall-clock ms) }. */
  readonly killedRegistry: Map<string, KilledRecord>;

  private readonly seed: number;
  private readonly heightAt: (x: number, z: number) => number;
  private readonly biomeAt: (x: number, z: number) => Biome;
  /** Optional ecology director; when present, LLM specs drive cell spawning. */
  ecologyDirector: EcologyDirector | null = null;

  constructor(
    seed: number,
    heightAt: (x: number, z: number) => number,
    biomeAt: (x: number, z: number) => Biome,
  ) {
    this.seed = seed;
    this.heightAt = heightAt;
    this.biomeAt = biomeAt;
    this.killedRegistry = loadKilledRegistry();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Call each frame (or whenever the player moves).  Streams in/out the 3×3
   * cell neighbourhood, enforces the live cap, and prunes the killed registry.
   */
  update(playerX: number, playerZ: number): void {
    const nowMs = Date.now();
    pruneKilledRegistry(this.killedRegistry, nowMs);

    const [pcx, pcz] = cellOf(playerX, playerZ);

    // Collect the 3×3 neighbourhood keys.
    const needed = new Set<string>();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        needed.add(`${pcx + dx},${pcz + dz}`);
      }
    }

    // Unload cells no longer in range.
    for (const key of this.loadedCells) {
      if (!needed.has(key)) {
        this._unloadCell(key);
      }
    }

    // Load cells newly in range.
    for (const key of needed) {
      if (!this.loadedCells.has(key)) {
        const [cx, cz] = key.split(',').map(Number) as [number, number];
        this._loadCell(cx, cz);
      }
    }

    // Enforce live cap: remove entities from farthest cells first.
    this._enforceCap(playerX, playerZ);
  }

  /**
   * Mark an entity as killed. Records the kill in the registry and sets its
   * mode to 'dead'.
   */
  killEntity(id: string, nowMs = Date.now()): void {
    const e = this.entities.get(id);
    if (e) {
      e.mode = 'dead';
      e.hp = 0;
    }
    this.killedRegistry.set(id, { killedAtS: nowMs });
    saveKilledRegistry(this.killedRegistry);
  }

  /**
   * Despawn a dead entity (after loot is taken).
   */
  despawnEntity(id: string): void {
    this.entities.delete(id);
  }

  /**
   * Force-spawn an entity near a given world position (for debug / tests).
   * Returns the new EntityState.
   */
  spawnEntity(species: Species, x: number, z: number): EntityState {
    const id = `debug:${species}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const y = this._yFor(species, x, z);
    const rng = mulberry32(mix32(this.seed ^ 0xdeb9, Math.floor(x), Math.floor(z)));
    const e: EntityState = {
      id,
      species,
      x, y, z,
      yaw: rng() * Math.PI * 2,
      hp: SPECIES_DEFS[species].hp,
      mode: 'idle',
      walkPhase: 0,
      colorVariant: Math.floor(rng() * 4),
      homeX: x,
      homeZ: z,
      stateTimer: 0,
      fleeTimer: 0,
    };
    this.entities.set(id, e);
    return e;
  }

  /**
   * Snapshot for __gameDebug.entities().
   */
  snapshot(): EntityState[] {
    return [...this.entities.values()];
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _loadCell(cx: number, cz: number): void {
    const key = `${cx},${cz}`;
    if (this.loadedCells.has(key)) return;
    this.loadedCells.add(key);

    // Determine spawns: use EcologySpec herds when available, else deterministic scatter.
    let spawns: EntitySpawn[];
    if (this.ecologyDirector !== null) {
      // Sample the cell's dominant biome from its centre.
      const centerX = cx * ECELL + ECELL / 2;
      const centerZ = cz * ECELL + ECELL / 2;
      // Collect a small set of biome samples across the cell for variety.
      const biomeSamples: Biome[] = [];
      const sampleOffsets: [number, number][] = [
        [0.25, 0.25], [0.75, 0.25], [0.5, 0.5], [0.25, 0.75], [0.75, 0.75],
      ];
      for (const [ox, oz] of sampleOffsets) {
        const b = this.biomeAt(cx * ECELL + ox * ECELL, cz * ECELL + oz * ECELL);
        if (!biomeSamples.includes(b)) biomeSamples.push(b);
      }
      const biomes: Biome[] = biomeSamples.length > 0 ? biomeSamples : [this.biomeAt(centerX, centerZ)];

      const spec = this.ecologyDirector.specFor(cx, cz, biomes);
      // Convert EcologySpec herds to EntitySpawns deterministically.
      spawns = this._spawnsFromSpec(cx, cz, spec);
    } else {
      spawns = entitiesForCell(this.seed, cx, cz, this.heightAt, this.biomeAt);
    }

    const nowMs = Date.now();
    for (const spawn of spawns) {
      // Skip if in killed registry and not yet expired.
      const killed = this.killedRegistry.get(spawn.id);
      if (killed !== undefined && nowMs - killed.killedAtS < RESPAWN_S * 1000) continue;

      if (this.entities.has(spawn.id)) continue;

      const rng = entityRng(spawn.id);
      const y = this._yFor(spawn.species, spawn.x, spawn.z);
      const e: EntityState = {
        id: spawn.id,
        species: spawn.species,
        x: spawn.x,
        y,
        z: spawn.z,
        yaw: rng() * Math.PI * 2,
        hp: SPECIES_DEFS[spawn.species].hp,
        mode: 'idle',
        walkPhase: 0,
        colorVariant: variantFromId(spawn.id),
        homeX: spawn.x,
        homeZ: spawn.z,
        stateTimer: rng() * 3, // stagger timers so they don't all act at once
        fleeTimer: 0,
      };
      this.entities.set(spawn.id, e);
    }
  }

  /**
   * Convert an EcologySpec's herd list to EntitySpawns.
   * Uses a seeded rng so positions are deterministic given the same spec.
   */
  private _spawnsFromSpec(cx: number, cz: number, spec: import('./ecology-spec').EcologySpec): EntitySpawn[] {
    const SALT = 0xec01e0a1;
    const rng = mulberry32(mix32(this.seed ^ SALT, cx, cz));
    const spawns: EntitySpawn[] = [];
    const prefix = `${cx},${cz}:e`;

    for (const herd of spec.herds) {
      const species = herd.species as Species;
      const def = SPECIES_DEFS[species];
      // Anchor point for the herd within the cell.
      const ax = cx * ECELL + rng() * ECELL;
      const az = cz * ECELL + rng() * ECELL;

      for (let k = 0; k < herd.count; k++) {
        const jx = ax + (rng() * 2 - 1) * 12;
        const jz = az + (rng() * 2 - 1) * 12;
        const h = this.heightAt(jx, jz);
        if (def.water) {
          if (h >= -8) continue;
        } else {
          if (h < 1) continue;
        }
        spawns.push({ id: `${prefix}${spawns.length}`, species, x: jx, z: jz });
      }
    }
    return spawns;
  }

  private _unloadCell(key: string): void {
    // Remove entities that belong to this cell (id starts with "cx,cz:e").
    for (const [id, e] of this.entities) {
      // Phase K: owned entities (babies / tamed) are never streamed out.
      if (e.owned) continue;
      // Phase M: npcOwned entities (stable horses) are never streamed out.
      if (e.npcOwned) continue;
      if (id.startsWith(key + ':')) {
        this.entities.delete(id);
      }
    }
    this.loadedCells.delete(key);
  }

  private _enforceCap(playerX: number, playerZ: number): void {
    if (this.entities.size <= LIVE_CAP) return;

    // Score each entity by distance to player (farther = higher priority to cull).
    const scored: [number, string][] = [];
    for (const [id, e] of this.entities) {
      // Phase K: owned entities (babies / tamed) are exempt from the live cap.
      if (e.owned) continue;
      // Phase M: npcOwned entities (stable horses) are exempt from the live cap.
      if (e.npcOwned) continue;
      const dist = Math.hypot(e.x - playerX, e.z - playerZ);
      scored.push([dist, id]);
    }
    scored.sort((a, b) => b[0] - a[0]); // farthest first

    let count = this.entities.size;
    for (const [, id] of scored) {
      if (count <= LIVE_CAP) break;
      // Don't cull entities that were debug-spawned with the player nearby.
      this.entities.delete(id);
      count--;
    }
  }

  /** Compute terrain y for an entity (water species float at -0.5). */
  private _yFor(species: Species, x: number, z: number): number {
    const def = SPECIES_DEFS[species];
    if (def.water) return -0.5;
    return this.heightAt(x, z);
  }
}
