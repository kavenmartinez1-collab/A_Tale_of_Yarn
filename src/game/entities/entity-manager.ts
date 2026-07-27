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

/** Max live entities across all loaded cells. Safety net, not the main limiter. */
export const LIVE_CAP = 40;

/**
 * Entities are materialised within this radius of the player and released
 * beyond it.
 *
 * This used to be whole-cell: loading a cell instantiated every spawn in its
 * 512 m square, and the live cap then culled back to 40 farthest-first. Two
 * things went wrong with that. The 3x3 neighbourhood is 2.36 km2, so the
 * entire 40-entity budget was spread over a ~690 m radius while the renderer
 * only draws to 120 m — measured, 90% of land positions had no animal within
 * 60 m and the median nearest was 146 m. And because a cell was only ever
 * populated once, on load, anything the cap culled while it was distant never
 * came back as the player walked toward it.
 *
 * Materialising by distance instead spends the budget where it can be seen,
 * and makes the population continuously correct as the player moves. Sits
 * comfortably outside the renderer's 120 m RENDER_DIST so nothing pops into
 * existence inside the visible window.
 */
export const LIVE_RADIUS = 170;

/** Hysteresis on release, so pacing back and forth over the edge doesn't thrash. */
export const RELEASE_RADIUS = LIVE_RADIUS * 1.3;

/**
 * Matches a streamed scatter id ("cx,cz:e{i}"). Only these can be released by
 * distance — a debug-spawned entity has no spawn record to rebuild it from.
 */
const STREAMED_ID = /^-?\d+,-?\d+:e\d+$/;

/** Persistence keys. */
export const ENTITY_KILLED_KEY = 'artifex-entities:v1';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * 'defend' is the owned-animal counterpart of 'aggro': a tamed mount or pet
 * intercepting something that is coming after its owner. It is deliberately
 * separate from 'aggro' so nothing that reads "is this creature hostile to the
 * player" (crime, taming, loot) ever mistakes a bodyguard for a threat.
 */
/**
 * 'hunt' is mob-vs-mob combat: this creature is fighting another creature or
 * an NPC, not the player. Kept separate from 'aggro' for exactly the reason
 * 'defend' is — everything that asks "is this thing hostile to the PLAYER"
 * (crime, taming, loot, the mount-defence scan) must not mistake a wolf eating
 * a deer for a threat to anyone. See `animal-ai.ts`.
 */
export type EntityMode =
  'idle' | 'graze' | 'wander' | 'flee' | 'aggro' | 'dead' | 'follow' | 'defend'
  | 'hunt';

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
   * Placed by a script rather than by cell streaming: exempt from the live
   * cap, and never released by distance.
   *
   * `owned` and `npcOwned` were the only two exemptions, and both mean
   * something else entirely — `owned` is "the player's", which makes
   * `stepAnimal` refuse to let the creature aggro or attack, and `npcOwned` is
   * "a villager's property", which turns killing it into a crime. Castle
   * Vhaeron's garrison is neither: it has to be permanent AND hostile AND free
   * to kill, and there was no flag that meant only "permanent".
   *
   * (The King and his dragon spawn wearing `owned` for this, which was safe
   * while their AI was bypassed entirely — and stopped being safe when the
   * fight started handing them to `stepAnimal`, where an owned boss is a pet
   * that cannot aggro and whose blows the caller discards. `stepAnimal` now
   * trades their `owned` for this flag on first contact; see the boss-handoff
   * shed there.)
   */
  pinned?: boolean;
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

  /**
   * Spawn points for each loaded cell, keyed "cx,cz". Holding the spawn list
   * separately from the live entities is what lets an animal be released when
   * it is far away and rebuilt when the player comes back — the old code threw
   * the spawn list away after materialising it once.
   */
  private cellSpawns = new Map<string, EntitySpawn[]>();

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
   * Call each frame (or whenever the player moves). Keeps spawn lists for the
   * 3×3 cell neighbourhood, materialises every spawn within LIVE_RADIUS,
   * releases live entities past RELEASE_RADIUS, and prunes the killed registry.
   */
  update(playerX: number, playerZ: number): void {
    const nowMs = Date.now();
    pruneKilledRegistry(this.killedRegistry, nowMs);

    const [pcx, pcz] = cellOf(playerX, playerZ);

    // Collect the 3×3 neighbourhood keys. At 512 m per cell this always
    // contains everything within LIVE_RADIUS of the player.
    const needed = new Set<string>();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        needed.add(`${pcx + dx},${pcz + dz}`);
      }
    }

    // Unload cells no longer in range.
    for (const key of [...this.cellSpawns.keys()]) {
      if (!needed.has(key)) {
        this._unloadCell(key);
      }
    }

    // Compute spawn lists for cells newly in range. This is position maths
    // only — no entity objects are built here.
    for (const key of needed) {
      if (!this.cellSpawns.has(key)) {
        const [cx, cz] = key.split(',').map(Number) as [number, number];
        this.cellSpawns.set(key, this._spawnsForCell(cx, cz));
      }
    }

    this._materialiseNear(playerX, playerZ, nowMs);
    this._releaseFar(playerX, playerZ);
    // Backstop only — distance selection normally keeps the count well under.
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
   * Place a scripted entity at an exact position under a caller-chosen id.
   *
   * `spawnEntity` cannot be used for anything that has to be reproducible: it
   * bakes `Date.now()` and `Math.random()` into the id, and it snaps y to the
   * terrain heightfield — which is 28 m below the floor for anything standing
   * inside Castle Vhaeron, and wrong by the height of the motte for anything
   * standing on it. This takes the whole placement from the caller and asks
   * the world nothing.
   *
   * Returns the existing entity untouched if the id is already live, so a
   * caller can re-assert its roster every frame without resurrecting the dead
   * or resetting the wounded.
   */
  placeEntity(
    id: string, species: Species,
    x: number, y: number, z: number,
    yaw: number, colorVariant: number,
  ): EntityState {
    const existing = this.entities.get(id);
    if (existing !== undefined) return existing;
    const e: EntityState = {
      id, species,
      x, y, z, yaw,
      hp: SPECIES_DEFS[species].hp,
      mode: 'idle',
      walkPhase: 0,
      colorVariant,
      homeX: x,
      homeZ: z,
      stateTimer: 0,
      fleeTimer: 0,
      pinned: true,
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

  /** Spawn points for a cell — EcologySpec herds when a director is attached,
   *  else the deterministic scatter. No entity objects are created. */
  private _spawnsForCell(cx: number, cz: number): EntitySpawn[] {
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
    return spawns;
  }

  /** Bring every not-yet-live spawn inside LIVE_RADIUS into existence. */
  private _materialiseNear(playerX: number, playerZ: number, nowMs: number): void {
    const r2 = LIVE_RADIUS * LIVE_RADIUS;
    for (const spawns of this.cellSpawns.values()) {
      for (const spawn of spawns) {
        const dx = spawn.x - playerX, dz = spawn.z - playerZ;
        if (dx * dx + dz * dz > r2) continue;
        if (this.entities.has(spawn.id)) continue;
        // Skip if in killed registry and not yet expired.
        const killed = this.killedRegistry.get(spawn.id);
        if (killed !== undefined && nowMs - killed.killedAtS < RESPAWN_S * 1000) continue;

        const rng = entityRng(spawn.id);
        const y = this._yFor(spawn.species, spawn.x, spawn.z);
        this.entities.set(spawn.id, {
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
        });
      }
    }
  }

  /** Release streamed entities that have fallen well outside the live window. */
  private _releaseFar(playerX: number, playerZ: number): void {
    const r2 = RELEASE_RADIUS * RELEASE_RADIUS;
    for (const [id, e] of this.entities) {
      // Owned (babies / tamed), npcOwned (stable horses) and pinned (scripted
      // placements like the castle garrison) entities are never streamed out;
      // debug spawns have no spawn record to rebuild them from.
      if (e.owned || e.npcOwned || e.pinned) continue;
      if (!STREAMED_ID.test(id)) continue;
      const dx = e.x - playerX, dz = e.z - playerZ;
      if (dx * dx + dz * dz > r2) this.entities.delete(id);
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

      // A herd is a population of the cell, not a single huddle. Giving each
      // herd one anchor made every 512 m cell 2–3 tight ±12 m blobs with
      // hundreds of empty metres between them — coverage, not headcount, is
      // what made the map read as dead. Break the herd into subgroups that
      // graze apart from one another.
      let remaining = herd.count;
      while (remaining > 0) {
        const n = Math.min(remaining, 1 + Math.floor(rng() * 3)); // 1–3
        remaining -= n;
        // Give the subgroup a few tries at ground it can actually stand on.
        // A single uniform draw meant coastal cells lost most of their
        // wildlife to the habitat test below — see entity-scatter.ts.
        let ax = 0, az = 0, sited = false;
        for (let attempt = 0; attempt < 5; attempt++) {
          ax = cx * ECELL + rng() * ECELL;
          az = cz * ECELL + rng() * ECELL;
          const h = this.heightAt(ax, az);
          if (def.water ? h < -8 : h >= 1) { sited = true; break; }
        }
        if (!sited) continue;

        for (let k = 0; k < n; k++) {
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
      // Scripted placements outlive the cell they happen to stand in.
      if (e.pinned) continue;
      if (id.startsWith(key + ':')) {
        this.entities.delete(id);
      }
    }
    this.cellSpawns.delete(key);
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
      // Scripted placements. Without this the cap culls FARTHEST FIRST, which
      // in a castle means the throne room and the tower arena — the two rooms
      // the player has not reached yet — quietly empty themselves while they
      // are fighting through the courtyard, and the boss floor is deserted.
      if (e.pinned) continue;
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
