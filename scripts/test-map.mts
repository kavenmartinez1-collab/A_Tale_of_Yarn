/**
 * test-map.mts — fog of war, its storage cost, and the pan clamp.
 *
 *   npx tsx scripts/test-map.mts
 *
 * Covers the parts of the world map that are pure: which chunks a walk
 * reveals, what that costs in localStorage after a very long session, that a
 * save/load round trip is lossless, and that panning cannot leave the
 * discovered world. The chart's appearance is not testable here — that is
 * `scripts/map-look.mjs`, and a human looking at the screenshot.
 */

import {
  Discovery, DISCOVERY_KEY, MAP_CHUNK, MAP_TILE, MAX_TILES, REVEAL_RADIUS,
  loadDiscovery, saveDiscovery,
} from '../src/game/map/discovery';
import {
  DEFAULT_ZOOM, PAN_MARGIN, ZOOM_LEVELS, clampView, screenToWorld, viewRect,
  worldToScreen, zoomAbout,
} from '../src/game/map/map-view';
import { RIVER_WATER, terrainColour } from '../src/game/map/map-palette';
import { landmarksInCell } from '../src/game/map/map-landmarks';
import { createHeightField } from '../src/game/noise';

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}
function eq(name: string, got: unknown, want: unknown): void {
  ok(name, Object.is(got, want), `got ${String(got)}, want ${String(want)}`);
}

// --- 1. revealing ----------------------------------------------------------
{
  const d = new Discovery();
  eq('a new map knows nothing', d.chunkCount, 0);
  eq('and has no bounds', d.bounds(), null);
  ok('nowhere is discovered', !d.has(0, 0));

  ok('first reveal changes something', d.reveal(0, 0, REVEAL_RADIUS));
  ok('standing still reveals nothing new', !d.reveal(0, 0, REVEAL_RADIUS));
  ok('the player\'s own chunk is on the map', d.has(0, 0));
  ok('so is one 100 m away', d.has(100, 0));
  ok('but not one 400 m away', !d.has(400, 0));
  ok('nor one 400 m behind', !d.has(-400, 0));

  // The reveal is a disc, not a square: a chunk touched only at the corner of
  // the bounding box must stay dark.
  ok('the corner of the bounding box is not revealed',
    !d.has(REVEAL_RADIUS + 10, REVEAL_RADIUS + 10));

  const b = d.bounds()!;
  ok('bounds cover the revealed disc',
    b.x0 <= -REVEAL_RADIUS && b.x1 >= REVEAL_RADIUS
    && b.z0 <= -REVEAL_RADIUS && b.z1 >= REVEAL_RADIUS,
    JSON.stringify(b));
  ok('bounds are chunk-aligned',
    b.x0 % MAP_CHUNK === 0 && b.x1 % MAP_CHUNK === 0, JSON.stringify(b));
}

// --- 2. negative coordinates (the classic floor-division bug) --------------
{
  const d = new Discovery();
  d.reveal(-1500.5, -2200.25, 40);
  ok('a negative position is on the map', d.has(-1500.5, -2200.25));
  ok('and its own chunk only', !d.has(-1500.5 + 300, -2200.25));
  const round = Discovery.parse(d.serialize());
  eq('negative tiles survive a round trip', round.chunkCount, d.chunkCount);
  ok('and land in the same place', round.has(-1500.5, -2200.25));
}

// --- 3. tile masks are per-chunk, not per-tile -----------------------------
{
  const d = new Discovery();
  d.reveal(4, 4, 1); // one chunk, at the very corner of tile 0,0
  eq('one chunk revealed', d.chunkCount, 1);
  eq('one tile stored', d.tileCount, 1);
  const m = d.tileMask(0, 0)!;
  eq('bit 0 set', m[0], 1);
  eq('high word clear', m[1], 0);
  ok('the neighbouring chunk in the same tile is dark', !d.has(MAP_CHUNK + 4, 4));
  ok('bit 63 addresses the far corner of the tile',
    (() => {
      const e = new Discovery();
      e.reveal(MAP_TILE - 4, MAP_TILE - 4, 1);
      const mm = e.tileMask(0, 0)!;
      return mm[0] === 0 && mm[1] === (1 << 31);
    })());
}

// --- 4. THE STORAGE BOUND: what a very long session actually costs ---------
{
  // A deliberately punishing walk: 10 hours at a 5 m/s jog is 180 km. Sampled
  // every 16 m, the same interval main.ts re-reveals on.
  const d = new Discovery();
  const STEP = 16;
  const LEG = 180_000 / STEP;
  let x = 0;
  let z = 0;
  // A meander rather than a straight line — a straight walk revisits the same
  // 256 m-wide corridor and flatters the numbers.
  for (let i = 0; i < LEG; i++) {
    const ang = Math.sin(i * 0.0017) * 2.4 + Math.sin(i * 0.00031) * 3.1;
    x += Math.cos(ang) * STEP;
    z += Math.sin(ang) * STEP;
    d.reveal(x, z, REVEAL_RADIUS);
  }
  const bytes = d.serialize().length;
  const b = d.bounds()!;
  process.stdout.write(
    `  10 h walk (180 km): ${d.chunkCount} chunks, ${d.tileCount} tiles, `
    + `${(bytes / 1024).toFixed(1)} KB, `
    + `${((b.x1 - b.x0) / 1000).toFixed(1)}x${((b.z1 - b.z0) / 1000).toFixed(1)} km\n`);
  ok('a ten-hour walk fits well inside localStorage', bytes < 100_000, `${bytes} B`);
  ok('and inside the tile cap', d.tileCount <= MAX_TILES, `${d.tileCount}`);
  ok('bytes per tile stay small', bytes / d.tileCount < 40,
    `${(bytes / d.tileCount).toFixed(1)} B/tile`);
  // The point of the bitmap: cost tracks AREA, not path length.
  const areaKm2 = (d.chunkCount * MAP_CHUNK * MAP_CHUNK) / 1e6;
  ok('cost per km² is modest', bytes / areaKm2 < 1200,
    `${(bytes / areaKm2).toFixed(0)} B/km² over ${areaKm2.toFixed(1)} km²`);

  const round = Discovery.parse(d.serialize());
  eq('a long map round-trips exactly', round.chunkCount, d.chunkCount);
  const rb = round.bounds()!;
  ok('and keeps its bounds',
    rb.x0 === b.x0 && rb.x1 === b.x1 && rb.z0 === b.z0 && rb.z1 === b.z1,
    `${JSON.stringify(rb)} vs ${JSON.stringify(b)}`);
}

// --- 5. the cap actually caps ---------------------------------------------
{
  const d = new Discovery();
  // Walk far enough in a straight line to blow past MAX_TILES.
  for (let i = 0; i < MAX_TILES * 3; i++) d.reveal(i * MAP_TILE, 0, 8);
  ok('tile count is capped', d.tileCount <= MAX_TILES, `${d.tileCount}`);
  ok('and the cap kept the tiles near the player',
    d.has((MAX_TILES * 3 - 1) * MAP_TILE, 0),
    'the most recent position was evicted');
  ok('while dropping the far end', !d.has(0, 0));
  ok('bounds survive eviction', d.bounds() !== null);
  const round = Discovery.parse(d.serialize());
  eq('a capped map round-trips', round.chunkCount, d.chunkCount);
}

// --- 6. corrupt / missing input never throws ------------------------------
{
  for (const bad of [null, undefined, '', 'not json', '{}', '[]', '{"v":1}',
    '{"t":null}', '{"t":{"x":"y"}}', '{"t":{"1,2":"zz"}}', '{"t":{"1,2":123}}',
    '{"t":{"nope":"1.0"}}']) {
    let threw = false;
    let d: Discovery | null = null;
    try { d = Discovery.parse(bad as string | null); } catch { threw = true; }
    ok(`parse(${JSON.stringify(bad)}) does not throw`, !threw);
    ok(`parse(${JSON.stringify(bad)}) yields an empty map`, d !== null && d.chunkCount === 0);
  }
}

// --- 7. save/load round trip through the storage shim ----------------------
{
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    get length() { return store.size; },
    key: (i: number) => [...store.keys()][i] ?? null,
  };
  eq('an empty store loads an empty map', loadDiscovery().chunkCount, 0);

  const d = new Discovery();
  d.reveal(1234, -5678, REVEAL_RADIUS);
  d.reveal(9000, 9000, REVEAL_RADIUS);
  saveDiscovery(d);
  ok('the map is stored under its own key', store.has(DISCOVERY_KEY));

  const back = loadDiscovery();
  eq('reloaded chunk count matches', back.chunkCount, d.chunkCount);
  ok('reloaded map remembers where you walked', back.has(1234, -5678));
  ok('and the second place too', back.has(9000, 9000));
  ok('and still nothing in between', !back.has(5000, 2000));

  // A quota failure must be silent, not fatal.
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => { throw new Error('nope'); },
    setItem: () => { throw new Error('quota'); },
    removeItem: () => {},
  };
  let threw = false;
  try { saveDiscovery(d); loadDiscovery(); } catch { threw = true; }
  ok('a hostile localStorage does not throw', !threw);
  delete (globalThis as { localStorage?: unknown }).localStorage;
}

// --- 8. the pan clamp -----------------------------------------------------
{
  const W = 900;
  const H = 640;
  const d = new Discovery();
  // A small discovered patch, much smaller than the viewport at DEFAULT_ZOOM.
  d.reveal(0, 0, REVEAL_RADIUS);
  const small = d.bounds()!;
  const centred = clampView({ cx: 50_000, cz: -50_000, zoom: DEFAULT_ZOOM }, small, W, H);
  ok('a viewport bigger than the world pins to the middle of it',
    Math.abs(centred.cx - (small.x0 + small.x1) / 2) < 0.001
    && Math.abs(centred.cz - (small.z0 + small.z1) / 2) < 0.001,
    JSON.stringify(centred));

  // A big discovered region, so the clamp is a real clamp.
  const big = new Discovery();
  for (let i = 0; i < 400; i++) big.reveal(i * 100, i * 40, REVEAL_RADIUS);
  const bb = big.bounds()!;
  const zoomedIn = 0; // 1 m/px, the tightest — viewport is far smaller than bb
  for (const [cx, cz] of [[-1e6, -1e6], [1e6, 1e6], [0, 0], [20_000, 8000]]) {
    const v = clampView({ cx, cz, zoom: zoomedIn }, bb, W, H);
    const r = viewRect(v, W, H);
    ok(`pan from (${cx}, ${cz}) stays inside the discovered world + margin`,
      r.x0 >= bb.x0 - PAN_MARGIN - 0.001 && r.x1 <= bb.x1 + PAN_MARGIN + 0.001
      && r.z0 >= bb.z0 - PAN_MARGIN - 0.001 && r.z1 <= bb.z1 + PAN_MARGIN + 0.001,
      JSON.stringify(r));
  }
  ok('a null bounds leaves the view alone',
    clampView({ cx: 7, cz: 9, zoom: 1 }, null, W, H).cx === 7);
  const zClamped = clampView({ cx: 0, cz: 0, zoom: 99 }, bb, W, H);
  eq('an out-of-range zoom index is clamped', zClamped.zoom, ZOOM_LEVELS.length - 1);
}

// --- 9. projection round trip and zoom anchoring --------------------------
{
  const W = 900;
  const H = 640;
  const v = { cx: 1234, cz: -567, zoom: DEFAULT_ZOOM };
  for (const [x, z] of [[1234, -567], [0, 0], [2000, -2000], [-9999, 12345]]) {
    const s = worldToScreen(v, W, H, x, z);
    const back = screenToWorld(v, W, H, s.sx, s.sy);
    ok(`world->screen->world round trips at (${x}, ${z})`,
      Math.abs(back.x - x) < 1e-6 && Math.abs(back.z - z) < 1e-6,
      `${back.x}, ${back.z}`);
  }
  // North is up, east is right.
  const north = worldToScreen(v, W, H, v.cx, v.cz - 100);
  const east = worldToScreen(v, W, H, v.cx + 100, v.cz);
  ok('north (-Z) is up the screen', north.sy < H / 2, `${north.sy}`);
  ok('east (+X) is right', east.sx > W / 2, `${east.sx}`);

  // Zooming about a point keeps that point under the cursor.
  const anchorX = 700;
  const anchorY = 120;
  const before = screenToWorld(v, W, H, anchorX, anchorY);
  const zoomed = zoomAbout(v, W, H, -1, anchorX, anchorY);
  const after = screenToWorld(zoomed, W, H, anchorX, anchorY);
  ok('zoom keeps the world point under the cursor',
    Math.abs(before.x - after.x) < 1e-6 && Math.abs(before.z - after.z) < 1e-6,
    `${before.x},${before.z} -> ${after.x},${after.z}`);
  ok('zooming in reduces metres per pixel',
    ZOOM_LEVELS[zoomed.zoom] < ZOOM_LEVELS[v.zoom]);
  eq('zoom cannot go past the finest level',
    zoomAbout({ cx: 0, cz: 0, zoom: 0 }, W, H, -1, 0, 0).zoom, 0);
  eq('nor past the coarsest',
    zoomAbout({ cx: 0, cz: 0, zoom: ZOOM_LEVELS.length - 1 }, W, H, 1, 0, 0).zoom,
    ZOOM_LEVELS.length - 1);
}

// --- 10. the palette classifies the things a map must not get wrong -------
{
  const deep = terrainColour(-30, 0, null, 0, 0);
  const land = terrainColour(20, 0, 'plains', 0, 0);
  const snow = terrainColour(120, 0, null, 0, 0);
  const blueness = (c: number) => (c & 0xff) - ((c >> 16) & 0xff);
  ok('deep water is blue', blueness(deep) > 20, `${deep.toString(16)}`);
  ok('grassland is not blue', blueness(land) < 0, `${land.toString(16)}`);
  ok('summits are pale', ((snow >> 16) & 0xff) > 190, `${snow.toString(16)}`);
  ok('a river cutting through a hillside still reads as water',
    blueness(terrainColour(25, RIVER_WATER + 0.1, 'forest', 0, 0)) > 20);
  eq('the palette is deterministic',
    terrainColour(20, 0, 'plains', 17, -4), terrainColour(20, 0, 'plains', 17, -4));
  ok('neighbouring stitches differ (wool is mottled)',
    terrainColour(20, 0, 'plains', 17, -4) !== terrainColour(20, 0, 'plains', 18, -4));
}

// --- 11. landmarks are pure and reproduce the world's own placement -------
{
  const hf = createHeightField(1337);
  // Cell (-1, -1) is the forced castle-town near spawn. It moved here from
  // (-1, 0) when settlement siting became river-aware: the old pin was sitting
  // in a river, and no position in that cell can carry a castle town at all.
  const a = landmarksInCell(1337, -1, -1, hf.heightAt);
  const b = landmarksInCell(1337, -1, -1, hf.heightAt);
  eq('the same cell yields the same landmarks', JSON.stringify(a), JSON.stringify(b));
  const town = a.find((l) => l.kind === 'settlement');
  ok('the pinned settlement near spawn is found', town !== undefined);
  ok('it is the castle town', town?.sub === 'castle', `${town?.sub}`);
  ok('it has a name', (town?.name.length ?? 0) > 0, `${town?.name}`);
  ok('it sits where the scatter put it',
    Math.abs((town?.x ?? 0) - -242) < 1 && Math.abs((town?.z ?? 0) - -320) < 1,
    `${town?.x}, ${town?.z}`);
}

process.stdout.write(`\nmap: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
