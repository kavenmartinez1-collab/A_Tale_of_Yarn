/**
 * Shelter registry — placed tents and canopy detection.
 *
 * PlacedTent lifecycle:
 *   - Place consumes the tent item (fiber_tent / wool_tent / hide_tent /
 *     canvas_tent).
 *   - Tiers: fiber=1, wool=2, hide=3, canvas=3.
 *   - Persist 'artifex-tents:v1'; cap 16.
 *
 * TWO KINDS OF SHELTER, AND THEY ARE NOT THE SAME QUESTION.
 *
 *   WARMTH is by PROXIMITY (`tentTierAt`, TENT_RADIUS = 3 m). Huddling beside
 *   a tent out of the wind is worth something, and it always was.
 *
 *   A ROOF is by VOLUME (`tentRoofAt`, the tent's own box). Rain does not stop
 *   because you are standing near a tent; it stops because there is canvas
 *   between you and the sky. Keying the rain draw on the warmth radius would
 *   have dried out a 6 m circle of open ground around every tent, which is the
 *   same class of bug the castle had when weather ignored ceilings — and it is
 *   why `TENT_BOX` is the one table both the mesh builder and the roof test
 *   read from. A tent you can see over the top of is not a tent you can shelter
 *   under, and geometry that disagrees with the query is exactly how that ships.
 *
 * Canopy:
 *   - Under a tree crown within ~2.5 m horizontal AND player below crown height.
 *   - vitals.ts TempInputs.tentTier is discrete (0|1|2|3).
 *   - Canopy maps to tentTier 1 (same warmth as fiber tent = 0.5).
 *     Rationale: canopy is a partial shelter; mapping to tier 1 reuses the
 *     existing vitals model without adding new fields.
 *
 * API:
 *   tentTierAt(tents, x, z)  → 0|1|2|3  (best tent within 3 m — WARMTH)
 *   tentRoofAt(tents, x, y, z) → boolean (inside a tent's box — RAIN)
 *   tentAt(tents, x, y, z)   → PlacedTent | null (which one you are inside)
 *   canopyAt(trees, x, y, z) → boolean  (under a tree crown)
 *   shelterTier(tents, trees, x, y, z) → 0|1|2|3  (combined: best of tent or canopy-1)
 */

export const TENTS_KEY = 'artifex-tents:v1';

/** Tent WARMTH radius (m) — proximity, not containment. See the header. */
export const TENT_RADIUS = 3;
/** Max tents kept in persistence. */
export const MAX_TENTS = 16;
/** Horizontal canopy check radius (m) from tree centre. */
export const CANOPY_RADIUS = 2.5;

export type TentTier = 0 | 1 | 2 | 3;

/**
 * A tent's footprint class.
 *
 * 'small' is the original bedroll-sized shelter: 2.4 m × 1.8 m and 1.7 m at the
 * ridge, which you crawl into. 'walkin' is the canvas tent — a room with a
 * door, and the answer to "we can build tents but the character can't go
 * inside", because at 4.4 m × 3.4 m and 2.4 m tall there is finally an INSIDE
 * to go to: floor enough to stand up, turn round, and set a campfire down.
 */
export type TentShape = 'small' | 'walkin';

/** Half-extents (X, Z) and ridge height of each tent shape, in metres. */
export interface TentBox {
  hx: number;
  hz: number;
  h: number;
}

/**
 * THE ONE TABLE. `fire-mesh.ts` builds the canvas from these numbers and
 * `tentRoofAt` tests against them, so the shelter you get is the shelter you
 * can see. Change a number here and both move together.
 */
export const TENT_BOX: Record<TentShape, TentBox> = {
  small:  { hx: 1.2, hz: 0.9, h: 1.7 },
  walkin: { hx: 2.2, hz: 1.7, h: 2.4 },
};

/**
 * How far below a tent's own ground height still counts as under it. Tents sit
 * on sampled terrain and the player's feet sample it again a step away; without
 * a little slack, standing inside a tent pitched on a gentle slope flickers in
 * and out of shelter as you walk, and the rain strobes.
 */
export const TENT_FLOOR_SLACK = 1.0;

export interface PlacedTent {
  id: string;
  x: number;
  y: number;
  z: number;
  tier: 1 | 2 | 3;
  /**
   * Footprint class. Optional, and absent means 'small' — records written
   * before the canvas tent existed are small tents, and a stored save must not
   * lose its shelter because a field was added.
   */
  shape?: TentShape;
}

/** The footprint of a tent, defaulting a shapeless (legacy) record to small. */
export function tentBox(tent: PlacedTent): TentBox {
  return TENT_BOX[tent.shape ?? 'small'];
}

// Minimal tree shape for canopy check (from tree-scatter TreeInstance).
export interface TreeRef {
  x: number;
  y: number;
  z: number;
  scale: number;
}

/** Crown height above the trunk base for a tree of given scale. */
function crownHeightFor(scale: number): number {
  // Oak crown top ~3.5 * scale above ground; jungle/cactus similar scale factor.
  return 3.5 * scale;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Returns the best tent tier within TENT_RADIUS of (x, z), or 0.
 */
export function tentTierAt(tents: PlacedTent[], x: number, z: number): TentTier {
  let best: TentTier = 0;
  const r2 = TENT_RADIUS * TENT_RADIUS;
  for (const t of tents) {
    const d2 = (t.x - x) ** 2 + (t.z - z) ** 2;
    if (d2 <= r2 && t.tier > best) best = t.tier as TentTier;
  }
  return best;
}

/**
 * The tent whose volume contains (x, y, z), or null.
 *
 * Axis-aligned: tents are built axis-aligned by `buildTentMeshes`, so an AABB
 * is not an approximation of the canvas, it IS the canvas. When two overlap the
 * first in the list wins — they are the same answer to the only question asked
 * of this ("is there something over me"), so there is nothing to choose between.
 *
 * Deterministic and allocation-free: a handful of compares over at most
 * MAX_TENTS records, called once a frame.
 */
export function tentAt(
  tents: readonly PlacedTent[],
  px: number,
  py: number,
  pz: number,
): PlacedTent | null {
  for (const t of tents) {
    const b = tentBox(t);
    if (px < t.x - b.hx || px > t.x + b.hx) continue;
    if (pz < t.z - b.hz || pz > t.z + b.hz) continue;
    if (py < t.y - TENT_FLOOR_SLACK || py > t.y + b.h) continue;
    return t;
  }
  return null;
}

/** True when there is tent canvas over this point. Feeds the rain draw. */
export function tentRoofAt(
  tents: readonly PlacedTent[],
  px: number,
  py: number,
  pz: number,
): boolean {
  return tentAt(tents, px, py, pz) !== null;
}

/**
 * True when the player is under a tree crown.
 * Crown: horizontal distance from trunk < CANOPY_RADIUS AND player y < trunk.y + crownHeight.
 */
export function canopyAt(trees: TreeRef[], px: number, py: number, pz: number): boolean {
  const r2 = CANOPY_RADIUS * CANOPY_RADIUS;
  for (const t of trees) {
    const d2 = (t.x - px) ** 2 + (t.z - pz) ** 2;
    if (d2 > r2) continue;
    const crownTop = t.y + crownHeightFor(t.scale);
    if (py <= crownTop) return true;
  }
  return false;
}

/**
 * Combined shelter tier:
 *   - If inside a tent → use tent tier.
 *   - If under canopy (and no tent) → tier 1.
 *   - Otherwise → 0.
 * Returns the MAXIMUM of tent tier or canopy-equivalent.
 */
export function shelterTier(
  tents: PlacedTent[],
  trees: TreeRef[],
  px: number,
  py: number,
  pz: number,
): TentTier {
  const tTier = tentTierAt(tents, px, pz);
  if (tTier > 0) return tTier;
  if (canopyAt(trees, px, py, pz)) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Per-session placement counter behind the id.
 *
 * This used to be `Date.now()` and `Math.random()`, which made a placed tent
 * the one world object a harness could not name twice and put two forbidden
 * calls in a module the determinism rule covers. Position plus sequence gives
 * the same uniqueness (you cannot place two tents in one spot in one step) and
 * replays identically.
 */
let tentSeq = 0;

/** Reset the id sequence. Tests only. */
export function resetTentIds(): void {
  tentSeq = 0;
}

function mixPos(x: number, z: number, n: number): number {
  let h = (Math.round(x * 100) | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (Math.round(z * 100) | 0), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13) ^ n, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function createTent(
  x: number,
  y: number,
  z: number,
  tier: 1 | 2 | 3,
  shape: TentShape = 'small',
): PlacedTent {
  const id = `tent_${mixPos(x, z, tentSeq).toString(36)}_${tentSeq}`;
  tentSeq++;
  return { id, x, y, z, tier, shape };
}

export function serializeTents(tents: PlacedTent[]): string {
  return JSON.stringify(tents);
}

export function deserializeTents(json: string): PlacedTent[] | null {
  let x: unknown;
  try { x = JSON.parse(json); } catch { return null; }
  if (!Array.isArray(x)) return null;
  const out: PlacedTent[] = [];
  for (const item of x) {
    if (typeof item !== 'object' || item === null) return null;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== 'string') return null;
    if (typeof o.x !== 'number' || !Number.isFinite(o.x)) return null;
    if (typeof o.y !== 'number' || !Number.isFinite(o.y)) return null;
    if (typeof o.z !== 'number' || !Number.isFinite(o.z)) return null;
    if (o.tier !== 1 && o.tier !== 2 && o.tier !== 3) return null;
    // A missing or unrecognised shape is a small tent, never a rejection: the
    // stored key predates the field, and refusing the record would delete a
    // player's camp to gain nothing.
    const shape: TentShape = o.shape === 'walkin' ? 'walkin' : 'small';
    out.push({
      id: o.id as string,
      x: o.x as number, y: o.y as number, z: o.z as number,
      tier: o.tier as 1 | 2 | 3,
      shape,
    });
  }
  return out;
}

export function loadTents(): PlacedTent[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(TENTS_KEY);
    if (raw !== null) {
      const tents = deserializeTents(raw);
      if (tents !== null) return tents;
    }
  } catch { /* storage unavailable */ }
  return [];
}

export function saveTents(tents: PlacedTent[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const capped = tents.length > MAX_TENTS
      ? tents.slice(tents.length - MAX_TENTS)
      : tents;
    localStorage.setItem(TENTS_KEY, serializeTents(capped));
  } catch { /* storage unavailable */ }
}
