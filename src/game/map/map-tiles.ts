/**
 * map-tiles.ts — bakes discovered ground into little cloth patches.
 *
 * One baked tile is a 512 m cell rendered to a 64x64 offscreen canvas: 8 m per
 * stitch, 8x8 stitches per 64 m fog chunk. Undiscovered stitches are left
 * fully transparent so the linen weave painted behind the map shows through —
 * fog costs nothing to draw and can never be a colour that disagrees with the
 * border.
 *
 * ## Why it is incremental
 *
 * Measured on this machine: 4,096 samples of heightAt + riverFactor + biomeAt
 * is 3.3 ms, so a hundred discovered tiles is a third of a second of solid
 * work. Worse, the first road query into a region runs the road network's
 * Dijkstra domain build — 27-40 ms, once, cold. Doing all of that in the
 * frame the player presses Escape is a visible lock-up on the one input that
 * is supposed to make the game stop and relax.
 *
 * So the cache pumps: nearest-to-the-view tiles first, with a wall-clock
 * budget checked BEFORE each tile is started, and the map draws whatever is
 * ready. The chart stitches itself in over a few frames, which is both cheap
 * and — since the game is paused behind it — free.
 *
 * The budget is checked before a tile rather than during one because a tile is
 * the unit of consistency; the overrun is bounded by the single worst tile
 * (one cold road domain), and only one such tile can land per frame.
 */

import type { Biome, BiomeField } from '../biome';
import type { HeightField } from '../noise';
import type { RoadNetwork } from '../world/roads';
import { Discovery, MAP_TILE, TILE_CHUNKS } from './discovery';
import { CASTLE_VHAERON, landmarksInCell } from './map-landmarks';
import type { Landmark } from './map-landmarks';
import { linenColour, terrainColour } from './map-palette';

/** Stitches per tile edge. 64 over 512 m = 8 m per stitch, 8 px per fog chunk. */
export const TILE_PX = 64;
export const STITCH_M = MAP_TILE / TILE_PX;
/** Stitches per fog chunk edge. */
const CHUNK_PX = TILE_PX / TILE_CHUNKS;

/** Baked tiles held in memory. 64x64 RGBA is 16 KB each, so 400 is ~6.5 MB. */
const MAX_BAKED = 400;

/** Frames the chart gets to itself before the road pass starts. ~0.2 s. */
const ROAD_SETTLE_FRAMES = 12;

/** One run of road that lies inside discovered ground, as world x,z pairs. */
export interface RoadRun {
  /** Stable id so a road crossing two tiles is only stroked once. */
  key: string;
  /** Half-width (m) — trunk roads are wider and get a heavier stitch. */
  halfWidth: number;
  pts: Float32Array;
}

export interface BakedTile {
  tx: number;
  tz: number;
  canvas: HTMLCanvasElement;
  /** The fog this bake was made against; a change means it must be redone. */
  maskLo: number;
  maskHi: number;
  /** Null until the road pass reaches this tile — see the queue split below. */
  roads: RoadRun[] | null;
  landmarks: Landmark[];
}

export interface MapTilesOptions {
  seed: number;
  /** BASE height field — see the note in map-landmarks.ts. */
  height: HeightField;
  biome: BiomeField;
  roads: RoadNetwork;
  discovery: Discovery;
}

export class MapTiles {
  private readonly baked = new Map<string, BakedTile>();
  /**
   * Two queues, drained in order: ground first, roads second.
   *
   * They are split because their costs differ by an order of magnitude and
   * only one of them is predictable. A ground raster is ~3 ms every time. The
   * first road query into a region runs the road network's Dijkstra domain
   * build — measured at 27-40 ms, and it lands on whichever unlucky frame
   * asks first. Baked together, opening the map on new country cost a 95 ms
   * frame: a visible lurch on the one keypress that means "stop, let me
   * breathe". Split, the ground appears immediately at a steady few ms a
   * frame and the roads stitch themselves in behind it.
   */
  private rasterQueue: { tx: number; tz: number }[] = [];
  private roadQueue: BakedTile[] = [];
  /** Frames since the ground finished; roads wait for ROAD_SETTLE_FRAMES. */
  private settle = 0;
  private readonly opts: MapTilesOptions;
  /** Reused across bakes; allocating 16 KB per tile would churn the heap. */
  private readonly scratch: HTMLCanvasElement;
  private readonly scratchCtx: CanvasRenderingContext2D;

  constructor(opts: MapTilesOptions) {
    this.opts = opts;
    this.scratch = document.createElement('canvas');
    this.scratch.width = TILE_PX;
    this.scratch.height = TILE_PX;
    this.scratchCtx = this.scratch.getContext('2d')!;
  }

  get pending(): number {
    return this.rasterQueue.length + this.roadQueue.length;
  }

  get bakedCount(): number {
    return this.baked.size;
  }

  get(tx: number, tz: number): BakedTile | undefined {
    return this.baked.get(`${tx},${tz}`);
  }

  /**
   * Queue every tile in `coords` that is missing or stale, nearest to
   * (`cx`, `cz`) first so the ground under the player stitches in before the
   * far corners. Cheap enough to call every frame the map is open.
   *
   * `rect` is the world-space viewport, padded by a tile. Only what is on
   * screen is queued: the cost of opening the map is then proportional to what
   * the player can actually see rather than to how far they have ever walked,
   * and — more to the point — the number of cold road-domain builds that can
   * land in the opening second is bounded by the screen instead of by the
   * save file.
   */
  request(
    coords: { tx: number; tz: number }[], cx: number, cz: number,
    rect: { x0: number; z0: number; x1: number; z1: number },
  ): void {
    const wantRaster: { tx: number; tz: number; d2: number }[] = [];
    const wantRoads: { tile: BakedTile; d2: number }[] = [];
    const tx0 = Math.floor(rect.x0 / MAP_TILE) - 1;
    const tx1 = Math.floor(rect.x1 / MAP_TILE) + 1;
    const tz0 = Math.floor(rect.z0 / MAP_TILE) - 1;
    const tz1 = Math.floor(rect.z1 / MAP_TILE) + 1;
    for (const c of coords) {
      if (c.tx < tx0 || c.tx > tx1 || c.tz < tz0 || c.tz > tz1) continue;
      const mask = this.opts.discovery.tileMask(c.tx, c.tz);
      if (mask === null) continue;
      const dx = (c.tx + 0.5) * MAP_TILE - cx;
      const dz = (c.tz + 0.5) * MAP_TILE - cz;
      const d2 = dx * dx + dz * dz;
      const have = this.baked.get(`${c.tx},${c.tz}`);
      if (have === undefined || have.maskLo !== mask[0] || have.maskHi !== mask[1]) {
        wantRaster.push({ tx: c.tx, tz: c.tz, d2 });
      } else if (have.roads === null) {
        wantRoads.push({ tile: have, d2 });
      }
    }
    wantRaster.sort((a, b) => a.d2 - b.d2);
    wantRoads.sort((a, b) => a.d2 - b.d2);
    this.rasterQueue = wantRaster.map((w) => ({ tx: w.tx, tz: w.tz }));
    this.roadQueue = wantRoads.map((w) => w.tile);
  }

  /**
   * Bake queued work until `budgetMs` of wall clock is gone. Returns how many
   * items were finished. Ground before roads; the budget is checked BEFORE
   * each item, so one cold road domain can overrun it but nothing can join it
   * in the same frame.
   *
   * Wall clock is legitimate here: this is frame pacing for UI work, not
   * simulation — nothing it produces feeds gameplay or generation.
   */
  pump(budgetMs: number): number {
    if (this.rasterQueue.length === 0 && this.roadQueue.length === 0) return 0;
    const start = performance.now();
    let done = 0;
    while (this.rasterQueue.length > 0 && performance.now() - start < budgetMs) {
      const next = this.rasterQueue.shift()!;
      this.bake(next.tx, next.tz);
      done++;
    }
    // Roads only once the ground is down AND the chart has had a couple of
    // frames to present itself. A cold road domain is ~40 ms whenever it is
    // paid; paying it on the third frame after Escape means the map stalls
    // while the player is still reading it, which is exactly the moment that
    // must feel instant. Waiting lets the ground, the labels and the player
    // mark all land first, so the one slow frame falls on a chart that is
    // already legible and still.
    if (this.rasterQueue.length > 0) {
      this.settle = 0;
    } else if (this.settle < ROAD_SETTLE_FRAMES) {
      this.settle++;
    } else if (this.roadQueue.length > 0) {
      // One per frame regardless of remaining budget: the cost is dominated by
      // whether the domain is cached, so "how much budget is left" says
      // nothing useful about whether a second one would fit.
      const tile = this.roadQueue.shift()!;
      tile.roads = this.roadsIn(tile.tx, tile.tz);
      done++;
    }
    if (this.baked.size > MAX_BAKED) this.evict();
    return done;
  }

  /** Drop the least recently requested tiles. Re-baking them is cheap. */
  private evict(): void {
    // Map preserves insertion order, and `bake` re-inserts, so the oldest
    // entries are the ones the player has not looked at for longest.
    const over = this.baked.size - MAX_BAKED;
    let i = 0;
    for (const key of this.baked.keys()) {
      if (i++ >= over) break;
      this.baked.delete(key);
    }
  }

  private bake(tx: number, tz: number): void {
    const { discovery, height, biome, seed } = this.opts;
    const mask = discovery.tileMask(tx, tz);
    if (mask === null) return;
    const [lo, hi] = mask;

    const img = this.scratchCtx.createImageData(TILE_PX, TILE_PX);
    const data = img.data;
    const originX = tx * MAP_TILE;
    const originZ = tz * MAP_TILE;

    for (let py = 0; py < TILE_PX; py++) {
      const wz = originZ + (py + 0.5) * STITCH_M;
      const cz = (py / CHUNK_PX) | 0;
      const rowBit = cz * TILE_CHUNKS;
      // The fog byte for this stitch row: 8 chunk bits, read once per row
      // instead of once per stitch.
      const rowMask = rowBit < 32
        ? (lo >>> rowBit) & 0xff
        : (hi >>> (rowBit - 32)) & 0xff;
      let o = py * TILE_PX * 4;
      if (rowMask === 0) {
        // Whole row undiscovered — createImageData is already zeroed, so the
        // stitches stay transparent and the linen behind shows through.
        continue;
      }
      for (let px = 0; px < TILE_PX; px++, o += 4) {
        if ((rowMask & (1 << ((px / CHUNK_PX) | 0))) === 0) continue;
        const wx = originX + (px + 0.5) * STITCH_M;
        const h = height.heightAt(wx, wz);
        const river = height.riverFactor(wx, wz);
        // biomeAt costs another heightAt plus five octaves of FBM, and only
        // the 4-45 m band actually uses the answer — above that it is rock and
        // snow, below it is water and shoal.
        const b: Biome | null = (h >= 1 && h < 45) ? biome.biomeAt(wx, wz) : null;
        const rgb = terrainColour(h, river, b, (wx / STITCH_M) | 0, (wz / STITCH_M) | 0);
        data[o] = (rgb >> 16) & 0xff;
        data[o + 1] = (rgb >> 8) & 0xff;
        data[o + 2] = rgb & 0xff;
        data[o + 3] = 255;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = TILE_PX;
    canvas.height = TILE_PX;
    canvas.getContext('2d')!.putImageData(img, 0, 0);

    const tile: BakedTile = {
      tx, tz, canvas, maskLo: lo, maskHi: hi,
      roads: null, // filled by the road pass; see the queue split above
      landmarks: this.landmarksIn(seed, tx, tz),
    };
    this.baked.delete(`${tx},${tz}`); // re-insert to refresh eviction order
    this.baked.set(`${tx},${tz}`, tile);
  }

  /**
   * Road runs inside this tile, clipped to discovered chunks.
   *
   * Clipped point-by-point rather than by bounding box: a road that leaves the
   * fog and comes back should show two stretches with a gap, exactly as the
   * player experienced it. The gap is where they turned off the road.
   */
  private roadsIn(tx: number, tz: number): RoadRun[] {
    const { roads, discovery } = this.opts;
    const x0 = tx * MAP_TILE;
    const z0 = tz * MAP_TILE;
    const graph = roads.graphIn(x0, z0, x0 + MAP_TILE, z0 + MAP_TILE);
    const out: RoadRun[] = [];
    for (const edge of graph.edges) {
      const pts = edge.pts; // x,z,y triples
      const n = (pts.length / 3) | 0;
      let runStart = -1;
      let runCount = 0;
      let part = 0;
      const flush = () => {
        if (runCount >= 2) {
          const arr = new Float32Array(runCount * 2);
          for (let i = 0; i < runCount; i++) {
            arr[i * 2] = pts[(runStart + i) * 3];
            arr[i * 2 + 1] = pts[(runStart + i) * 3 + 1];
          }
          out.push({ key: `${edge.a}|${edge.b}|${part++}`, halfWidth: edge.halfWidth, pts: arr });
        }
        runStart = -1;
        runCount = 0;
      };
      for (let i = 0; i < n; i++) {
        if (discovery.has(pts[i * 3], pts[i * 3 + 1])) {
          if (runStart < 0) runStart = i;
          runCount++;
        } else {
          flush();
        }
      }
      flush();
    }
    return out;
  }

  /** Landmarks in this cell whose own chunk the player has discovered. */
  private landmarksIn(seed: number, tx: number, tz: number): Landmark[] {
    const { discovery, height } = this.opts;
    const all = landmarksInCell(seed, tx, tz, height.heightAt);
    if (Math.floor(CASTLE_VHAERON.x / MAP_TILE) === tx
        && Math.floor(CASTLE_VHAERON.z / MAP_TILE) === tz) {
      all.push(CASTLE_VHAERON);
    }
    return all.filter((l) => discovery.has(l.x, l.z));
  }
}

/**
 * The linen the whole chart is drawn on: a 2x2-stitch weave, tiled. Built once
 * per zoom level because the weave has to stay pinned to the cloth, not to the
 * world — it is the fabric, not the terrain.
 */
export function makeLinenPattern(
  ctx: CanvasRenderingContext2D, stitchPx: number,
): CanvasPattern {
  const n = 8;
  const c = document.createElement('canvas');
  const s = Math.max(1, Math.round(stitchPx));
  c.width = n * s;
  c.height = n * s;
  const cc = c.getContext('2d')!;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const rgb = linenColour(x, y);
      cc.fillStyle = `rgb(${(rgb >> 16) & 0xff},${(rgb >> 8) & 0xff},${rgb & 0xff})`;
      cc.fillRect(x * s, y * s, s, s);
    }
  }
  return ctx.createPattern(c, 'repeat')!;
}
