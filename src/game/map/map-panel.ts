/**
 * map-panel.ts — the pause screen: a cloth chart of everywhere you have been,
 * with the save menu bound in alongside it.
 *
 * ## Why the map IS the pause screen
 *
 * Escape is one press and one mental gesture — "stop, let me look at where I
 * am". Splitting that into a menu and a separate map key means the player
 * pauses to check the map and then has to leave the pause screen to do it.
 * So Escape stops the world and unrolls the chart, and Save/Load/New Game sit
 * in a rail beside it.
 *
 * ## Look
 *
 * A cloth chart, not a minimap. The ground is felt patches at 8 m per stitch;
 * unexplored world is the bare linen those patches are sewn onto; roads are a
 * running stitch in ochre thread; the border is a running stitch in the same
 * thread-cream as the bow reticle (#f0e6c8), over the same soft dark shadow.
 * The player is a gold knot with a needle for a heading. Nothing glows,
 * nothing has a neon edge, and the only pure white on screen is a highlight
 * on the knot.
 *
 * ## Cost
 *
 * Nothing while closed — the panel is built on open and destroyed on close,
 * and `MapTiles` only exists inside it. While open the game is paused, so the
 * whole frame is available; even so the raster is stitched in incrementally
 * (see map-tiles.ts) and the canvas is only redrawn when something changed.
 * Idle, an open map costs one `requestAnimationFrame` callback that returns
 * immediately.
 */

import type { BiomeField } from '../biome';
import type { HeightField } from '../noise';
import type { RoadNetwork } from '../world/roads';
import { buildGameMenuPanel } from '../ui/menu-panel';
import type { GameMenuOptions } from '../ui/menu-panel';
import { Discovery, MAP_CHUNK, MAP_TILE } from './discovery';
import type { Landmark } from './map-landmarks';
import { CLOTH, toCss } from './map-palette';
import { MapTiles, STITCH_M, TILE_PX, makeLinenPattern } from './map-tiles';
import {
  DEFAULT_ZOOM, clampView, maxZoomIndex, metresPerPixel, screenToWorld,
  viewRect, worldToScreen, zoomAbout,
} from './map-view';
import type { MapView } from './map-view';

/**
 * The open chart's view, or null when the pause screen is closed. Exists so
 * the play harness can assert the pan clamp numerically instead of a human
 * squinting at a screenshot to decide whether a drag went too far.
 */
let liveView: (() => {
  cx: number; cz: number; mPerPx: number; w: number; h: number;
  x0: number; z0: number; x1: number; z1: number;
}) | null = null;

export function getMapView(): ReturnType<NonNullable<typeof liveView>> | null {
  return liveView === null ? null : liveView();
}

/**
 * Per-frame cost of the open chart: `work` is tile baking, `draw` is the
 * canvas repaint, both in ms.
 *
 * Exists because opening any full-screen DOM overlay in this game costs the
 * browser a 70-100 ms paint frame (the shipped inventory panel measures 106),
 * and without a breakdown that frame gets blamed on whatever is new. The
 * numbers here are what let `map-look.mjs` state that the map's own work on
 * the slow frame is 0.0 ms rather than asserting it by assumption.
 */
export interface MapFrameCost {
  work: number;
  draw: number;
  pending: number;
}
const profile: MapFrameCost[] = [];
const PROFILE_FRAMES = 120;

function record(work: number, draw: number, pending: number): void {
  profile.push({ work, draw, pending });
  if (profile.length > PROFILE_FRAMES) profile.shift();
}

export function getMapProfile(): MapFrameCost[] {
  return profile.slice();
}

export function resetMapProfile(): void {
  profile.length = 0;
}

const THREAD = toCss(CLOTH.thread);
const GOLD = toCss(CLOTH.gold);
const INK = toCss(CLOTH.ink);
/** Ochre thread for roads — warm enough to sit on felt without shouting. */
const ROAD_THREAD = '#9a6636';
const ROAD_SHADOW = 'rgba(42, 33, 24, 0.45)';

let cssInjected = false;

const CSS = `
#pause-screen {
  position: fixed; inset: 0; right: 0; top: 0;
  transform: none; margin: 0; padding: 0;
  width: 100%; height: 100%; min-width: 0; max-width: none;
  background: rgba(8, 10, 14, 0.74);
  border: none; border-radius: 0;
  display: flex; align-items: center; justify-content: center;
  z-index: 22;
  color: #f0e6c8;
  font-family: system-ui, sans-serif;
}
/* The chart: linen bound into a dark backing cloth. */
#pause-screen .chart {
  display: flex; flex-direction: column;
  width: min(1180px, 94vw); height: min(800px, 92vh);
  background: #3b3122;
  border: 1px solid #211a12;
  border-radius: 4px;
  /* A tight shadow on purpose. A wide blur over a ~1180x800 box is a large
     first-paint cost, and this overlay goes up on a keypress that has to feel
     instant — measured 76 ms for the open frame, of which the map's own work
     was 0.0 ms (see scripts/map-look.mjs). Cloth sits on the table; it does
     not float above it. */
  box-shadow: 0 3px 10px rgba(8, 10, 14, 0.55);
  padding: 12px 14px 10px;
  box-sizing: border-box;
  contain: layout paint;
}
#pause-screen .chart-head {
  display: flex; align-items: baseline; gap: 12px;
  padding: 0 2px 9px;
  border-bottom: 1px dashed rgba(240, 230, 200, 0.34);
  margin-bottom: 10px;
}
#pause-screen .chart-title {
  font: 600 16px system-ui, sans-serif;
  letter-spacing: 0.10em; text-transform: uppercase;
  color: #f0e6c8;
  text-shadow: 0 1px 2px rgba(8, 10, 14, 0.9);
}
#pause-screen .chart-where { font: 500 12px system-ui, sans-serif; opacity: 0.72; }
#pause-screen .chart-count {
  margin-left: auto; font: 500 11px system-ui, sans-serif; opacity: 0.55;
}
#pause-screen .chart-body { display: flex; gap: 12px; flex: 1; min-height: 0; }
#pause-screen .chart-cloth {
  position: relative; flex: 1; min-width: 0;
  border: 1px solid #211a12;
  background: #b5a37c;
  overflow: hidden;
}
#pause-screen canvas { display: block; width: 100%; height: 100%; cursor: grab; }
#pause-screen canvas.dragging { cursor: grabbing; }

/* Right rail: the same cloth, a stitched seam apart. */
#pause-screen .rail {
  width: 236px; flex: 0 0 236px;
  display: flex; flex-direction: column; gap: 8px;
  overflow-y: auto;
  padding-left: 12px;
  border-left: 1px dashed rgba(240, 230, 200, 0.30);
}
#pause-screen .stitch-btn {
  font: 600 12px system-ui, sans-serif;
  color: #f0e6c8; background: rgba(240, 230, 200, 0.07);
  border: 1px dashed rgba(240, 230, 200, 0.42);
  border-radius: 3px; padding: 7px 10px; cursor: pointer;
  text-align: left; letter-spacing: 0.03em;
}
#pause-screen .stitch-btn:hover { background: rgba(240, 230, 200, 0.15); }
#pause-screen .stitch-btn.primary { border-color: #e8c35a; color: #e8c35a; }
#pause-screen .zoom-row { display: flex; gap: 6px; }
#pause-screen .zoom-row .stitch-btn { flex: 1; text-align: center; }

/* The save menu, re-dyed to match the cloth. */
#pause-screen #game-menu-panel { margin-top: 2px; }
#pause-screen #game-menu-panel h2 {
  font: 600 11px system-ui, sans-serif;
  letter-spacing: 0.10em; text-transform: uppercase;
  opacity: 0.62; margin: 4px 0 6px;
}
#pause-screen .panel-row { margin: 8px 0; }
#pause-screen .row-label { opacity: 0.62; }
#pause-screen .choice {
  background: rgba(240, 230, 200, 0.07);
  border: 1px dashed rgba(240, 230, 200, 0.42);
  border-radius: 3px; color: #f0e6c8;
  font: 600 11px system-ui, sans-serif; padding: 4px 9px;
}
#pause-screen .choice:hover { background: rgba(240, 230, 200, 0.15); }
#pause-screen .hint {
  margin-top: 10px; font: 500 10px system-ui, sans-serif;
  opacity: 0.5; line-height: 1.5;
}
#pause-screen .chart-foot {
  padding-top: 8px; margin-top: 8px;
  border-top: 1px dashed rgba(240, 230, 200, 0.34);
  font: 500 11px system-ui, sans-serif; opacity: 0.55;
}
`;

function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.id = 'pause-screen-css';
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** Where the player is, read fresh each redraw. */
export interface MapPlayerState {
  x: number;
  z: number;
  /** Character facing (rad). Forward is (sin yaw, -cos yaw) — controller.ts. */
  yaw: number;
  /** True in a dungeon or a building interior, where x/z are ARENA coords. */
  indoors: boolean;
  /** Human-readable "where am I", for the header. */
  place: string | null;
}

export interface MapPanelOptions {
  seed: number;
  /** BASE height field, not the road-carved one. See map-landmarks.ts. */
  height: HeightField;
  biome: BiomeField;
  roads: RoadNetwork;
  discovery: Discovery;
  player: () => MapPlayerState;
  menu: GameMenuOptions;
  onResume: () => void;
}

/**
 * Build the pause screen. The returned element self-manages: it starts a RAF
 * loop that stops as soon as it is detached, and unbinds its window listeners
 * on the `panel-close` event PanelManager fires just before removal.
 */
export function buildMapPanel(opts: MapPanelOptions): HTMLElement {
  injectCss();

  const root = document.createElement('div');
  root.id = 'pause-screen';

  const chart = document.createElement('div');
  chart.className = 'chart';
  root.appendChild(chart);

  // --- header -------------------------------------------------------------
  const head = document.createElement('div');
  head.className = 'chart-head';
  const title = document.createElement('div');
  title.className = 'chart-title';
  title.textContent = 'Paused';
  const where = document.createElement('div');
  where.className = 'chart-where';
  const count = document.createElement('div');
  count.className = 'chart-count';
  head.append(title, where, count);
  chart.appendChild(head);

  const body = document.createElement('div');
  body.className = 'chart-body';
  chart.appendChild(body);

  const cloth = document.createElement('div');
  cloth.className = 'chart-cloth';
  const canvas = document.createElement('canvas');
  cloth.appendChild(canvas);
  body.appendChild(cloth);

  const rail = document.createElement('div');
  rail.className = 'rail';
  body.appendChild(rail);

  const foot = document.createElement('div');
  foot.className = 'chart-foot';
  foot.textContent = 'Drag to pan · Wheel or +/− to zoom · Arrows to scroll '
    + '· Home to find yourself · Esc to resume';
  chart.appendChild(foot);

  // --- view state ---------------------------------------------------------
  const start = opts.player();
  let view: MapView = {
    cx: start.indoors ? 0 : start.x,
    cz: start.indoors ? 0 : start.z,
    zoom: DEFAULT_ZOOM,
  };
  let dirty = true;
  let linen: CanvasPattern | null = null;
  let linenStitchPx = -1;

  const tiles = new MapTiles({
    seed: opts.seed,
    height: opts.height,
    biome: opts.biome,
    roads: opts.roads,
    discovery: opts.discovery,
  });

  const ctx = canvas.getContext('2d')!;
  let viewW = 0;
  let viewH = 0;

  /** Pull the view back inside the discovered world, and inside the zoom range. */
  function clamp(): void {
    const bounds = opts.discovery.bounds();
    const maxZoom = maxZoomIndex(bounds, viewW, viewH);
    if (view.zoom > maxZoom) view = { ...view, zoom: maxZoom };
    view = clampView(view, bounds, viewW, viewH);
  }

  let sized = false;
  function resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(64, Math.round(cloth.clientWidth));
    const h = Math.max(64, Math.round(cloth.clientHeight));
    if (viewW === w && viewH === h && canvas.width === Math.round(w * dpr)) return;
    viewW = w;
    viewH = h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!sized) {
      // First sizing: pick the opening zoom now the viewport is known. Start
      // at the readable default, unless the discovered world is small enough
      // that a tighter level already shows all of it.
      sized = true;
      view = {
        ...view,
        zoom: Math.min(DEFAULT_ZOOM, maxZoomIndex(opts.discovery.bounds(), w, h)),
      };
    }
    clamp();
    dirty = true;
  }

  // --- rail ---------------------------------------------------------------
  const resumeBtn = document.createElement('button');
  resumeBtn.className = 'stitch-btn primary';
  resumeBtn.textContent = 'Resume  (Esc)';
  resumeBtn.addEventListener('click', () => opts.onResume());
  rail.appendChild(resumeBtn);

  const centreBtn = document.createElement('button');
  centreBtn.className = 'stitch-btn';
  centreBtn.textContent = 'Centre on me  (Home)';
  centreBtn.addEventListener('click', () => recentre());
  rail.appendChild(centreBtn);

  const zoomRow = document.createElement('div');
  zoomRow.className = 'zoom-row';
  const zoomOut = document.createElement('button');
  zoomOut.className = 'stitch-btn';
  zoomOut.textContent = '−';
  zoomOut.title = 'Zoom out';
  zoomOut.addEventListener('click', () => zoomBy(1));
  const zoomIn = document.createElement('button');
  zoomIn.className = 'stitch-btn';
  zoomIn.textContent = '+';
  zoomIn.title = 'Zoom in';
  zoomIn.addEventListener('click', () => zoomBy(-1));
  zoomRow.append(zoomOut, zoomIn);
  rail.appendChild(zoomRow);

  rail.appendChild(buildGameMenuPanel(opts.menu));

  // --- interaction --------------------------------------------------------
  function recentre(): void {
    const p = opts.player();
    if (p.indoors) return; // arena coordinates are not world coordinates
    view = { cx: p.x, cz: p.z, zoom: view.zoom };
    clamp();
    dirty = true;
  }

  function zoomBy(delta: number): void {
    view = zoomAbout(view, viewW, viewH, delta, viewW / 2, viewH / 2);
    clamp();
    dirty = true;
  }

  let dragging = false;
  let dragX = 0;
  let dragZ = 0;
  let dragCx = 0;
  let dragCz = 0;

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    dragX = e.clientX;
    dragZ = e.clientY;
    dragCx = view.cx;
    dragCz = view.cz;
    canvas.classList.add('dragging');
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const mpp = metresPerPixel(view);
    view = {
      cx: dragCx - (e.clientX - dragX) * mpp,
      cz: dragCz - (e.clientY - dragZ) * mpp,
      zoom: view.zoom,
    };
    clamp();
    dirty = true;
  });
  const endDrag = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove('dragging');
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    view = zoomAbout(view, viewW, viewH, e.deltaY > 0 ? 1 : -1,
      e.clientX - r.left, e.clientY - r.top);
    clamp();
    dirty = true;
  }, { passive: false });

  /**
   * Keys are taken in the CAPTURE phase so the ones the map owns never reach
   * the game's own keydown handler on `window`. Escape deliberately is NOT
   * claimed: it has to fall through to close the panel.
   */
  function onKey(e: KeyboardEvent): void {
    const t = e.target;
    if (t instanceof HTMLElement
        && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      return;
    }
    const step = 0.22 * Math.max(viewW, viewH) * metresPerPixel(view);
    let handled = true;
    switch (e.code) {
      case 'ArrowLeft':  view = { ...view, cx: view.cx - step }; break;
      case 'ArrowRight': view = { ...view, cx: view.cx + step }; break;
      case 'ArrowUp':    view = { ...view, cz: view.cz - step }; break;
      case 'ArrowDown':  view = { ...view, cz: view.cz + step }; break;
      case 'Home':       recentre(); break;
      case 'Equal': case 'NumpadAdd':      zoomBy(-1); break;
      case 'Minus': case 'NumpadSubtract': zoomBy(1); break;
      default: handled = false;
    }
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
    clamp();
    dirty = true;
  }
  window.addEventListener('keydown', onKey, true);
  const onResize = () => { resize(); };
  window.addEventListener('resize', onResize);
  liveView = () => {
    const r = viewRect(view, viewW, viewH);
    return {
      cx: view.cx, cz: view.cz, mPerPx: metresPerPixel(view), w: viewW, h: viewH,
      x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1,
    };
  };
  root.addEventListener('panel-close', () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    liveView = null;
  });

  // --- drawing ------------------------------------------------------------
  function draw(): void {
    const mpp = metresPerPixel(view);
    const rect = viewRect(view, viewW, viewH);

    // 1. The cloth. World-locked so the weave pans with the chart rather than
    //    sitting still under a sliding map, which reads as a broken parallax.
    const stitchPx = Math.max(1, Math.round(STITCH_M / mpp));
    if (linen === null || linenStitchPx !== stitchPx) {
      linen = makeLinenPattern(ctx, stitchPx);
      linenStitchPx = stitchPx;
    }
    const period = 8 * stitchPx;
    const offX = -(((view.cx / mpp - viewW / 2) % period) + period) % period;
    const offZ = -(((view.cz / mpp - viewH / 2) % period) + period) % period;
    ctx.save();
    ctx.translate(offX, offZ);
    ctx.fillStyle = linen;
    ctx.fillRect(0, 0, viewW - offX + period, viewH - offZ + period);
    ctx.restore();

    // 2. Felt patches. Nearest-neighbour while magnifying so the stitches stay
    //    square; smoothed when shrinking, where nearest would just alias.
    ctx.imageSmoothingEnabled = mpp > STITCH_M;
    const tileSizePx = MAP_TILE / mpp;
    const tx0 = Math.floor(rect.x0 / MAP_TILE);
    const tx1 = Math.floor(rect.x1 / MAP_TILE);
    const tz0 = Math.floor(rect.z0 / MAP_TILE);
    const tz1 = Math.floor(rect.z1 / MAP_TILE);
    const roadsSeen = new Set<string>();
    const visible: Landmark[] = [];
    for (let tz = tz0; tz <= tz1; tz++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const tile = tiles.get(tx, tz);
        if (tile === undefined) continue;
        const s = worldToScreen(view, viewW, viewH, tx * MAP_TILE, tz * MAP_TILE);
        // Round to whole pixels: a half-pixel destination makes drawImage
        // resample even with smoothing off, and the stitches go fuzzy.
        ctx.drawImage(tile.canvas, Math.round(s.sx), Math.round(s.sy),
          Math.round(tileSizePx), Math.round(tileSizePx));
        for (const l of tile.landmarks) visible.push(l);
      }
    }
    ctx.imageSmoothingEnabled = true;

    // 3. Roads, as a running stitch over a soft shadow.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass === 0 ? ROAD_SHADOW : ROAD_THREAD;
      for (let tz = tz0; tz <= tz1; tz++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const tile = tiles.get(tx, tz);
          if (tile === undefined) continue;
          for (const run of tile.roads ?? []) {
            if (pass === 0) {
              if (roadsSeen.has(run.key)) continue;
              roadsSeen.add(run.key);
            }
            const w = Math.max(1.1, Math.min(4.5, (run.halfWidth * 2) / mpp));
            ctx.lineWidth = pass === 0 ? w + 1.4 : w;
            ctx.setLineDash(pass === 0 ? [] : [Math.max(2.5, w * 2), Math.max(2, w * 1.4)]);
            ctx.beginPath();
            for (let i = 0; i < run.pts.length; i += 2) {
              const s = worldToScreen(view, viewW, viewH, run.pts[i], run.pts[i + 1]);
              if (i === 0) ctx.moveTo(s.sx, s.sy + (pass === 0 ? 1 : 0));
              else ctx.lineTo(s.sx, s.sy + (pass === 0 ? 1 : 0));
            }
            ctx.stroke();
          }
        }
      }
      // Pass 1 re-walks the same runs; the dedupe set is filled on pass 0.
      if (pass === 0) roadsSeen.clear();
    }
    ctx.setLineDash([]);

    // 4. Landmarks, then labels (labels last so a glyph never covers a name).
    for (const l of visible) {
      const s = worldToScreen(view, viewW, viewH, l.x, l.z);
      if (s.sx < -40 || s.sy < -40 || s.sx > viewW + 40 || s.sy > viewH + 40) continue;
      drawLandmark(ctx, l, s.sx, s.sy);
    }
    const taken: number[] = []; // x0,y0,x1,y1 quads of placed labels
    for (const l of visible) {
      const s = worldToScreen(view, viewW, viewH, l.x, l.z);
      if (s.sx < 0 || s.sy < 0 || s.sx > viewW || s.sy > viewH) continue;
      // Small ruins and dungeons only earn a name once the chart is zoomed in;
      // at 32 m/px every label in a province would land on top of every other.
      const major = l.kind === 'castle' || l.sub === 'town' || l.sub === 'village';
      if (!major && mpp > 8) continue;
      if (mpp > 16 && !major) continue;
      drawLabel(ctx, l.name, s.sx, s.sy + glyphRadius(l) + 4, taken);
    }

    // 5. The player: a gold knot, four stitches, and a needle for a heading.
    const p = opts.player();
    if (!p.indoors) {
      const s = worldToScreen(view, viewW, viewH, p.x, p.z);
      drawPlayer(ctx, s.sx, s.sy, p.yaw);
    }

    // 6. Compass rose and the bound edge, both in thread-cream.
    drawCompass(ctx, viewW - 30, 30);
    ctx.save();
    ctx.strokeStyle = 'rgba(42, 33, 24, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(6.5, 7.5, viewW - 13, viewH - 13);
    ctx.strokeStyle = THREAD;
    ctx.strokeRect(6.5, 6.5, viewW - 13, viewH - 13);
    ctx.restore();

    if (opts.discovery.chunkCount === 0) {
      ctx.fillStyle = INK;
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Nothing charted yet — go and look.', viewW / 2, viewH / 2);
      ctx.textAlign = 'left';
    }
  }

  // --- frame loop ---------------------------------------------------------
  let lastRev = -1;
  function frame(): void {
    if (!root.isConnected) return; // detached: stop, and let the closure go
    requestAnimationFrame(frame);
    resize();
    if (opts.discovery.rev !== lastRev) {
      lastRev = opts.discovery.rev;
      dirty = true;
    }
    // 6 ms is a third of a frame; the game is paused behind this, so the only
    // thing it competes with is the map's own redraw.
    const t0 = performance.now();
    tiles.request(opts.discovery.tileCoords(), view.cx, view.cz,
      viewRect(view, viewW, viewH));
    if (tiles.pump(6) > 0) dirty = true;
    const t1 = performance.now();
    if (!dirty) {
      record(t1 - t0, 0, tiles.pending);
      return;
    }
    dirty = false;
    draw();
    record(t1 - t0, performance.now() - t1, tiles.pending);
    const p = opts.player();
    where.textContent = p.place !== null
      ? p.place
      : `${Math.round(p.x)}, ${Math.round(p.z)}`;
    const km2 = (opts.discovery.chunkCount * MAP_CHUNK * MAP_CHUNK) / 1e6;
    count.textContent = `${opts.discovery.chunkCount} chunks charted`
      + ` · ${km2.toFixed(2)} km²`
      + (tiles.pending > 0 ? ' · stitching…' : '');
  }
  requestAnimationFrame(frame);

  return root;
}

// ---------------------------------------------------------------------------
// Glyphs. All of them are stroked, dashed where the thing is a ruin, and sat
// on a soft dark shadow — the same construction as the bow reticle.
// ---------------------------------------------------------------------------

function glyphRadius(l: Landmark): number {
  if (l.kind === 'castle') return 9;
  if (l.kind === 'dungeon') return 6;
  switch (l.sub) {
    case 'town': return 8;
    case 'castle': return 8;
    case 'village': return 6.5;
    case 'ranch': return 5.5;
    default: return 5;
  }
}

function drawLandmark(
  ctx: CanvasRenderingContext2D, l: Landmark, x: number, y: number,
): void {
  const r = glyphRadius(l);
  ctx.save();
  ctx.translate(x, y);
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Shadow pass, one pixel down — the reticle's drop-shadow, done by hand
  // because a canvas filter would cost a full-surface blur per frame.
  for (let pass = 0; pass < 2; pass++) {
    ctx.strokeStyle = pass === 0 ? 'rgba(8, 10, 14, 0.55)' : glyphColour(l);
    ctx.setLineDash(l.sub === 'ruins' ? [2.2, 2] : []);
    ctx.save();
    if (pass === 0) ctx.translate(0, 1);
    ctx.beginPath();
    if (l.kind === 'dungeon') {
      // A doorway: two jambs and an arch.
      ctx.moveTo(-r * 0.7, r * 0.7);
      ctx.lineTo(-r * 0.7, -r * 0.1);
      ctx.arc(0, -r * 0.1, r * 0.7, Math.PI, 0);
      ctx.lineTo(r * 0.7, r * 0.7);
    } else if (l.kind === 'castle' || l.sub === 'castle') {
      // Crenellations over a block.
      ctx.moveTo(-r, r * 0.8);
      ctx.lineTo(-r, -r * 0.2);
      ctx.lineTo(-r * 0.6, -r * 0.2);
      ctx.lineTo(-r * 0.6, -r * 0.75);
      ctx.lineTo(-r * 0.2, -r * 0.75);
      ctx.lineTo(-r * 0.2, -r * 0.2);
      ctx.lineTo(r * 0.2, -r * 0.2);
      ctx.lineTo(r * 0.2, -r * 0.75);
      ctx.lineTo(r * 0.6, -r * 0.75);
      ctx.lineTo(r * 0.6, -r * 0.2);
      ctx.lineTo(r, -r * 0.2);
      ctx.lineTo(r, r * 0.8);
      ctx.closePath();
    } else {
      // A house: gable over a square. Towns get a second, taller gable.
      ctx.moveTo(-r, r * 0.75);
      ctx.lineTo(-r, -r * 0.1);
      ctx.lineTo(0, -r * 0.85);
      ctx.lineTo(r, -r * 0.1);
      ctx.lineTo(r, r * 0.75);
      ctx.closePath();
      if (l.sub === 'town') {
        ctx.moveTo(r * 0.35, r * 0.75);
        ctx.lineTo(r * 0.35, -r * 0.95);
        ctx.lineTo(r * 1.15, -r * 0.95);
        ctx.lineTo(r * 1.15, r * 0.75);
      }
    }
    ctx.stroke();
    ctx.restore();
  }
  ctx.setLineDash([]);
  ctx.restore();
}

function glyphColour(l: Landmark): string {
  if (l.kind === 'castle') return GOLD;
  if (l.kind === 'dungeon') return '#d9c9a6';
  return THREAD;
}

function drawLabel(
  ctx: CanvasRenderingContext2D, text: string, x: number, y: number,
  taken: number[],
): void {
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const w = ctx.measureText(text).width;
  const x0 = x - w / 2 - 2;
  const x1 = x + w / 2 + 2;
  const y1 = y + 13;
  // Cheap declutter: skip a name that would land on one already placed.
  for (let i = 0; i < taken.length; i += 4) {
    if (x0 < taken[i + 2] && x1 > taken[i] && y < taken[i + 3] && y1 > taken[i + 1]) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      return;
    }
  }
  taken.push(x0, y, x1, y1);
  // Cream halo, ink letters: legible over felt and over water alike.
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(240, 230, 200, 0.85)';
  ctx.lineJoin = 'round';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = INK;
  ctx.fillText(text, x, y);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

/**
 * The player mark. A knot of gold thread with the reticle's four running
 * stitches around it, and a needle laid along the direction they are facing.
 * Forward is (sin yaw, -cos yaw), and canvas rotation of a glyph drawn along
 * -Y matches that exactly, so the yaw goes straight into ctx.rotate.
 *
 * Drawn large. The first version was 20 px across and standing in a village
 * put it inside the settlement glyph, where it read as a smudge on the roof;
 * "where am I" is the first question anyone opens a map to answer, so the
 * player mark outranks everything else on the chart and is sized to say so.
 * The dark shell underneath is what keeps it readable over snow and sand as
 * well as over water.
 */
function drawPlayer(
  ctx: CanvasRenderingContext2D, x: number, y: number, yaw: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  // A soft shadowed disc first: it separates the mark from whatever felt it
  // happens to land on, without a glow.
  ctx.fillStyle = 'rgba(20, 16, 11, 0.30)';
  ctx.beginPath();
  ctx.arc(0, 1, 12, 0, Math.PI * 2);
  ctx.fill();
  for (let pass = 0; pass < 2; pass++) {
    ctx.save();
    if (pass === 0) ctx.translate(0, 1.4);
    const colour = pass === 0 ? 'rgba(20, 16, 11, 0.85)' : GOLD;
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Needle: a long stitch pointing where the player faces.
    ctx.save();
    ctx.rotate(yaw);
    ctx.lineWidth = pass === 0 ? 3.4 : 2.4;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(0, -5);
    ctx.lineTo(0, -19);
    ctx.moveTo(-4.6, -13.4);
    ctx.lineTo(0, -19.8);
    ctx.lineTo(4.6, -13.4);
    ctx.stroke();
    ctx.restore();
    // Four running stitches around the knot — the bow reticle, in miniature.
    ctx.lineWidth = pass === 0 ? 2.6 : 1.8;
    ctx.setLineDash([2.6, 2.2]);
    ctx.beginPath();
    for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
      ctx.moveTo(dx * 7.5, dz * 7.5);
      ctx.lineTo(dx * 12, dz * 12);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // The knot.
    ctx.beginPath();
    ctx.arc(0, 0, pass === 0 ? 4.8 : 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

function drawCompass(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.save();
  ctx.translate(x, y);
  for (let pass = 0; pass < 2; pass++) {
    ctx.save();
    if (pass === 0) ctx.translate(0, 1);
    ctx.strokeStyle = pass === 0 ? 'rgba(8, 10, 14, 0.55)' : THREAD;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.setLineDash([2.6, 2.2]);
    ctx.beginPath();
    ctx.moveTo(0, 14);
    ctx.lineTo(0, -6);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(-4, -3);
    ctx.lineTo(0, -11);
    ctx.lineTo(4, -3);
    ctx.closePath();
    ctx.stroke();
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', 0, -14);
    ctx.textAlign = 'left';
    ctx.restore();
  }
  ctx.restore();
}

/** Exported for the harness: the raster resolution the chart bakes at. */
export const MAP_TILE_PX = TILE_PX;
export { Discovery };
