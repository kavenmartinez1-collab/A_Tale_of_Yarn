/**
 * map-view.ts — where the map is looking. Pure maths, node-testable.
 *
 * The view is a world-space centre plus a scale in metres-per-pixel. Panning
 * moves the centre; zooming changes the scale about the cursor (or the centre)
 * so the world point under the pointer stays put. Everything is clamped to the
 * discovered area plus a margin, because the whole world is procedural and an
 * unclamped map lets the player pan for a hundred kilometres into identical
 * blank cloth and lose the bit they had explored.
 */

import type { DiscoveryBounds } from './discovery';

/**
 * Metres per screen pixel, fine to coarse.
 *
 * Every level is a power of two away from the tile raster's 8 m stitch, so a
 * baked 64x64 tile always lands on an exact 8x/4x/2x/1x/... pixel box. At any
 * other ratio nearest-neighbour upscaling gives stitches of uneven width,
 * which reads as a rendering fault rather than as needlework.
 */
export const ZOOM_LEVELS = [1, 2, 4, 8, 16, 32] as const;
export const DEFAULT_ZOOM = 2; // 4 m/px — ~3.6 km across a 900 px chart

/** Slack around the discovered area the player may pan into (m). */
export const PAN_MARGIN = 400;

export interface MapView {
  /** World XZ at the centre of the viewport. */
  cx: number;
  cz: number;
  /** Index into ZOOM_LEVELS. */
  zoom: number;
}

export function metresPerPixel(view: MapView): number {
  return ZOOM_LEVELS[clampInt(view.zoom, 0, ZOOM_LEVELS.length - 1)];
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Pull the centre back inside the discovered area (+ margin).
 *
 * When the discovered world is smaller than the viewport the axis is pinned to
 * the middle of it instead of clamped, otherwise the two bounds cross and the
 * map jitters between them as the player drags.
 */
export function clampView(
  view: MapView, bounds: DiscoveryBounds | null,
  viewW: number, viewH: number, margin = PAN_MARGIN,
): MapView {
  const zoom = clampInt(view.zoom, 0, ZOOM_LEVELS.length - 1);
  if (bounds === null) return { cx: view.cx, cz: view.cz, zoom };
  const mpp = ZOOM_LEVELS[zoom];
  const halfW = (viewW * mpp) / 2;
  const halfH = (viewH * mpp) / 2;
  const minX = bounds.x0 - margin + halfW;
  const maxX = bounds.x1 + margin - halfW;
  const minZ = bounds.z0 - margin + halfH;
  const maxZ = bounds.z1 + margin - halfH;
  return {
    cx: minX > maxX ? (bounds.x0 + bounds.x1) / 2 : clamp(view.cx, minX, maxX),
    cz: minZ > maxZ ? (bounds.z0 + bounds.z1) / 2 : clamp(view.cz, minZ, maxZ),
    zoom,
  };
}

/**
 * World XZ → viewport pixels. North (-Z) is up, east (+X) is right, which is
 * the orientation the compass HUD already uses.
 */
export function worldToScreen(
  view: MapView, viewW: number, viewH: number, x: number, z: number,
): { sx: number; sy: number } {
  const mpp = metresPerPixel(view);
  return {
    sx: viewW / 2 + (x - view.cx) / mpp,
    sy: viewH / 2 + (z - view.cz) / mpp,
  };
}

/** Viewport pixels → world XZ. */
export function screenToWorld(
  view: MapView, viewW: number, viewH: number, sx: number, sy: number,
): { x: number; z: number } {
  const mpp = metresPerPixel(view);
  return {
    x: view.cx + (sx - viewW / 2) * mpp,
    z: view.cz + (sy - viewH / 2) * mpp,
  };
}

/**
 * Zoom by `delta` steps, keeping the world point under (`sx`, `sy`) fixed.
 * Pass the viewport centre to zoom about the middle.
 */
export function zoomAbout(
  view: MapView, viewW: number, viewH: number,
  delta: number, sx: number, sy: number,
): MapView {
  const next = clampInt(view.zoom + delta, 0, ZOOM_LEVELS.length - 1);
  if (next === view.zoom) return view;
  const anchor = screenToWorld(view, viewW, viewH, sx, sy);
  const mpp = ZOOM_LEVELS[next];
  // Solve for the centre that puts `anchor` back under the same pixel.
  return {
    cx: anchor.x - (sx - viewW / 2) * mpp,
    cz: anchor.z - (sy - viewH / 2) * mpp,
    zoom: next,
  };
}

/**
 * The coarsest zoom worth offering: the first level at which the whole
 * discovered world plus its margin already fits the viewport.
 *
 * Without this the zoom-out button keeps working long after there is anything
 * left to reveal, and a player who taps it twice is looking at a speck of
 * chart in an ocean of blank linen with no obvious way back. The map is of a
 * procedural world, so "fully zoomed out" has to mean "all of it", not some
 * fixed number of metres.
 */
export function maxZoomIndex(
  bounds: DiscoveryBounds | null, viewW: number, viewH: number,
  margin = PAN_MARGIN,
): number {
  if (bounds === null) return ZOOM_LEVELS.length - 1;
  const w = bounds.x1 - bounds.x0 + margin * 2;
  const h = bounds.z1 - bounds.z0 + margin * 2;
  for (let i = 0; i < ZOOM_LEVELS.length; i++) {
    if (viewW * ZOOM_LEVELS[i] >= w && viewH * ZOOM_LEVELS[i] >= h) return i;
  }
  return ZOOM_LEVELS.length - 1;
}

/** The world-space rectangle the viewport currently shows. */
export function viewRect(
  view: MapView, viewW: number, viewH: number,
): { x0: number; z0: number; x1: number; z1: number } {
  const mpp = metresPerPixel(view);
  const halfW = (viewW * mpp) / 2;
  const halfH = (viewH * mpp) / 2;
  return {
    x0: view.cx - halfW, z0: view.cz - halfH,
    x1: view.cx + halfW, z1: view.cz + halfH,
  };
}
