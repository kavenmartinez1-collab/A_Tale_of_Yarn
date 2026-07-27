/**
 * discovery.ts — fog of war for the world map. Pure, node-testable: no DOM,
 * no GPU, no clock. Deterministic given the same reveal calls.
 *
 * ## Granularity: 64 m chunks, stored 64-to-a-tile
 *
 * The world is procedural and effectively unbounded, so "which bits have I
 * seen" has to be stored at a resolution that is fine enough to be honest and
 * coarse enough to never blow out localStorage.
 *
 * The two units already in the code are the 64 m terrain chunk and the 512 m
 * settlement/dungeon cell (`SCELL` / `DCELL`). 512 m is far too coarse to be
 * the fog unit: a village is 56 m across, so stepping over a cell boundary
 * would reveal a quarter of a square kilometre you have not seen, including
 * whatever landmark sits in the far corner of it. 64 m is the right fog unit —
 * it is also exactly the terrain chunk the streamer built for you, so "I have
 * this on my map" means "the game actually generated this ground for me".
 *
 * But a `Set` of visited 64 m chunks costs ~8 bytes of JSON per chunk and
 * grows with PATH LENGTH: an hour of walking is thousands of entries. So the
 * fog is stored as a bitmap instead — one bit per chunk, 8x8 chunks packed
 * into the 512 m cell as a 64-bit mask, serialised as two base-36 integers.
 * That makes the cost grow with AREA covered rather than distance walked, at
 * ~20 bytes per 512 m cell — and a sparsely-clipped cell costs about 6. A
 * player who walks 180 km (ten hours at a jog) sweeps roughly 46 km² and pays
 * about 4 KB. `MAX_TILES` caps the worst case at ~40 KB regardless.
 *
 * Landmarks are deliberately NOT stored. A settlement is on the map when the
 * chunk it stands in is discovered — derived, so it cannot disagree with the
 * fog, and it costs nothing.
 */

/** localStorage key. Registered in save-game.ts so it belongs to the slot. */
export const DISCOVERY_KEY = 'artifex-map:v1';

/** Fog resolution (m). One terrain chunk — see CHUNK_SIZE in chunk-mesh.ts. */
export const MAP_CHUNK = 64;

/** Storage tile edge (m). 8x8 chunks = one 64-bit mask. Matches SCELL/DCELL. */
export const MAP_TILE = 512;

/** Chunks per tile edge. */
export const TILE_CHUNKS = MAP_TILE / MAP_CHUNK; // 8

/**
 * How much of the world one position reveals (m).
 *
 * Terrain streams to 384 m and settlements draw at 360 m, so anything inside
 * ~360 m has genuinely been rendered for the player. 128 m is deliberately
 * tighter than that: the map should read as "where I have been", and revealing
 * everything the horizon technically contained turns a walk down a valley into
 * a 720 m-wide swathe that includes hilltops you never saw over.
 */
export const REVEAL_RADIUS = 128;

/**
 * Hard cap on stored tiles (~40 KB serialised at the ~20 B/tile average).
 * Never expected to bite — see the header arithmetic — but an unbounded map is
 * an unbounded save file, and the save system has no quota guard of its own.
 * When it does bite, the tiles furthest from the player are dropped first.
 */
export const MAX_TILES = 2048;

function tileKey(tx: number, tz: number): string {
  return `${tx},${tz}`;
}

/** Floor-division that behaves for negative coordinates. */
function cellOf(v: number, size: number): number {
  return Math.floor(v / size);
}

interface Tile {
  tx: number;
  tz: number;
  /** Bits 0..31 = chunk rows 0..3, bits 32..63 = rows 4..7 (row-major, x fast). */
  lo: number;
  hi: number;
}

export interface DiscoveryBounds {
  /** World-space AABB of the discovered chunks, inclusive of chunk extent. */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export class Discovery {
  private readonly tiles = new Map<string, Tile>();
  /** Chunk-index AABB, maintained on insert and rebuilt after eviction. */
  private cx0 = 0;
  private cz0 = 0;
  private cx1 = 0;
  private cz1 = 0;
  private boundsDirty = false;
  private chunks = 0;
  /** Bumped whenever a new chunk is revealed, so views can cheaply re-check. */
  private revision = 0;

  /** Discovered 64 m chunks. */
  get chunkCount(): number {
    return this.chunks;
  }

  /** Stored 512 m tiles — the thing that costs bytes. */
  get tileCount(): number {
    return this.tiles.size;
  }

  /** Increments on every newly-revealed chunk; a cheap "has the map changed". */
  get rev(): number {
    return this.revision;
  }

  /** Is the 64 m chunk containing this world position discovered? */
  has(x: number, z: number): boolean {
    const cx = cellOf(x, MAP_CHUNK);
    const cz = cellOf(z, MAP_CHUNK);
    return this.hasChunk(cx, cz);
  }

  hasChunk(cx: number, cz: number): boolean {
    const tile = this.tiles.get(
      tileKey(cellOf(cx, TILE_CHUNKS), cellOf(cz, TILE_CHUNKS)));
    if (tile === undefined) return false;
    const lx = cx - cellOf(cx, TILE_CHUNKS) * TILE_CHUNKS;
    const lz = cz - cellOf(cz, TILE_CHUNKS) * TILE_CHUNKS;
    const bit = lz * TILE_CHUNKS + lx;
    return bit < 32
      ? (tile.lo & (1 << bit)) !== 0
      : (tile.hi & (1 << (bit - 32))) !== 0;
  }

  /**
   * The 64-bit mask for a 512 m tile as [lo, hi], or null if nothing in it is
   * discovered. Lets the renderer read a whole tile's fog with one lookup
   * instead of 64 — it bakes per tile and tests per pixel.
   */
  tileMask(tx: number, tz: number): [number, number] | null {
    const tile = this.tiles.get(tileKey(tx, tz));
    return tile === undefined ? null : [tile.lo, tile.hi];
  }

  /** Every discovered tile's coordinates, for the renderer to walk. */
  tileCoords(): { tx: number; tz: number }[] {
    const out: { tx: number; tz: number }[] = new Array(this.tiles.size);
    let i = 0;
    for (const t of this.tiles.values()) out[i++] = { tx: t.tx, tz: t.tz };
    return out;
  }

  /**
   * Reveal everything within `radius` of (x, z). Returns true if any chunk was
   * newly revealed, which is the caller's cue that the map bitmap changed.
   *
   * Marks a chunk when the disc touches its footprint at all, not when it
   * covers the centre — a player standing on a chunk boundary has certainly
   * seen both chunks.
   */
  reveal(x: number, z: number, radius = REVEAL_RADIUS): boolean {
    const r2 = radius * radius;
    const cx0 = cellOf(x - radius, MAP_CHUNK);
    const cx1 = cellOf(x + radius, MAP_CHUNK);
    const cz0 = cellOf(z - radius, MAP_CHUNK);
    const cz1 = cellOf(z + radius, MAP_CHUNK);
    let changed = false;
    for (let cz = cz0; cz <= cz1; cz++) {
      const z0 = cz * MAP_CHUNK;
      const nz = z < z0 ? z0 : z > z0 + MAP_CHUNK ? z0 + MAP_CHUNK : z;
      const dz = nz - z;
      for (let cx = cx0; cx <= cx1; cx++) {
        const x0 = cx * MAP_CHUNK;
        const nx = x < x0 ? x0 : x > x0 + MAP_CHUNK ? x0 + MAP_CHUNK : x;
        const dx = nx - x;
        if (dx * dx + dz * dz > r2) continue;
        if (this.set(cx, cz)) changed = true;
      }
    }
    if (changed && this.tiles.size > MAX_TILES) this.evictFarthest(x, z);
    return changed;
  }

  /** Set one chunk bit. Returns true if it was not already set. */
  private set(cx: number, cz: number): boolean {
    const tx = cellOf(cx, TILE_CHUNKS);
    const tz = cellOf(cz, TILE_CHUNKS);
    const key = tileKey(tx, tz);
    let tile = this.tiles.get(key);
    if (tile === undefined) {
      tile = { tx, tz, lo: 0, hi: 0 };
      this.tiles.set(key, tile);
    }
    const bit = (cz - tz * TILE_CHUNKS) * TILE_CHUNKS + (cx - tx * TILE_CHUNKS);
    if (bit < 32) {
      const m = 1 << bit;
      if ((tile.lo & m) !== 0) return false;
      tile.lo |= m;
    } else {
      const m = 1 << (bit - 32);
      if ((tile.hi & m) !== 0) return false;
      tile.hi |= m;
    }
    this.chunks++;
    this.revision++;
    if (this.chunks === 1) {
      this.cx0 = this.cx1 = cx;
      this.cz0 = this.cz1 = cz;
    } else {
      if (cx < this.cx0) this.cx0 = cx;
      if (cx > this.cx1) this.cx1 = cx;
      if (cz < this.cz0) this.cz0 = cz;
      if (cz > this.cz1) this.cz1 = cz;
    }
    return true;
  }

  /** Drop the tiles furthest from (x, z) until back under the cap. */
  private evictFarthest(x: number, z: number): void {
    const scored: { key: string; d2: number; bits: number }[] = [];
    for (const [key, t] of this.tiles) {
      const cxm = (t.tx + 0.5) * MAP_TILE - x;
      const czm = (t.tz + 0.5) * MAP_TILE - z;
      scored.push({
        key, d2: cxm * cxm + czm * czm, bits: popcount(t.lo) + popcount(t.hi),
      });
    }
    scored.sort((a, b) => b.d2 - a.d2);
    let over = this.tiles.size - MAX_TILES;
    for (let i = 0; i < scored.length && over > 0; i++, over--) {
      this.tiles.delete(scored[i].key);
      this.chunks -= scored[i].bits;
    }
    this.boundsDirty = true;
    this.revision++;
  }

  /** World AABB covering every discovered chunk, or null if nothing is known. */
  bounds(): DiscoveryBounds | null {
    if (this.chunks === 0) return null;
    if (this.boundsDirty) this.rebuildBounds();
    return {
      x0: this.cx0 * MAP_CHUNK,
      z0: this.cz0 * MAP_CHUNK,
      x1: (this.cx1 + 1) * MAP_CHUNK,
      z1: (this.cz1 + 1) * MAP_CHUNK,
    };
  }

  private rebuildBounds(): void {
    this.boundsDirty = false;
    let first = true;
    for (const t of this.tiles.values()) {
      for (let bit = 0; bit < 64; bit++) {
        const on = bit < 32
          ? (t.lo & (1 << bit)) !== 0 : (t.hi & (1 << (bit - 32))) !== 0;
        if (!on) continue;
        const cx = t.tx * TILE_CHUNKS + (bit % TILE_CHUNKS);
        const cz = t.tz * TILE_CHUNKS + Math.floor(bit / TILE_CHUNKS);
        if (first) {
          first = false;
          this.cx0 = this.cx1 = cx;
          this.cz0 = this.cz1 = cz;
        } else {
          if (cx < this.cx0) this.cx0 = cx;
          if (cx > this.cx1) this.cx1 = cx;
          if (cz < this.cz0) this.cz0 = cz;
          if (cz > this.cz1) this.cz1 = cz;
        }
      }
    }
  }

  /**
   * Compact JSON: `{"v":1,"t":{"tx,tz":"<lo36>.<hi36>"}}`. Base 36 because the
   * save system JSON-stringifies the stored string a SECOND time when it goes
   * into a slot, so every quote in the payload costs two characters — an
   * alphanumeric encoding pays nothing for that.
   */
  serialize(): string {
    const t: Record<string, string> = {};
    for (const tile of this.tiles.values()) {
      t[tileKey(tile.tx, tile.tz)] =
        `${(tile.lo >>> 0).toString(36)}.${(tile.hi >>> 0).toString(36)}`;
    }
    return JSON.stringify({ v: 1, t });
  }

  /** Tolerant parse — a corrupt map costs fog, never a failed boot. */
  static parse(raw: string | null | undefined): Discovery {
    const d = new Discovery();
    if (raw === null || raw === undefined || raw === '') return d;
    try {
      const rec = JSON.parse(raw) as { v?: number; t?: Record<string, string> };
      if (rec === null || typeof rec !== 'object' || typeof rec.t !== 'object'
          || rec.t === null) {
        return d;
      }
      for (const [key, value] of Object.entries(rec.t)) {
        const comma = key.indexOf(',');
        if (comma < 0 || typeof value !== 'string') continue;
        const tx = Number(key.slice(0, comma));
        const tz = Number(key.slice(comma + 1));
        if (!Number.isFinite(tx) || !Number.isFinite(tz)) continue;
        const dot = value.indexOf('.');
        if (dot < 0) continue;
        const lo = parseInt(value.slice(0, dot), 36);
        const hi = parseInt(value.slice(dot + 1), 36);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
        if (lo === 0 && hi === 0) continue;
        d.tiles.set(tileKey(tx, tz), { tx, tz, lo: lo | 0, hi: hi | 0 });
        d.chunks += popcount(lo | 0) + popcount(hi | 0);
      }
    } catch {
      return new Discovery();
    }
    d.boundsDirty = true;
    d.revision++;
    return d;
  }
}

function popcount(v: number): number {
  let x = v - ((v >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >> 24;
}

/** Read the persisted map (missing/corrupt → an empty one). */
export function loadDiscovery(): Discovery {
  try {
    if (typeof localStorage === 'undefined') return new Discovery();
    return Discovery.parse(localStorage.getItem(DISCOVERY_KEY));
  } catch {
    return new Discovery();
  }
}

/** Persist the map. Silent on quota, like every other artifex-* writer. */
export function saveDiscovery(d: Discovery): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(DISCOVERY_KEY, d.serialize());
  } catch { /* quota */ }
}
