/**
 * Shelter registry — placed tents and canopy detection.
 *
 * PlacedTent lifecycle:
 *   - Place consumes the tent item (fiber_tent / wool_tent / hide_tent).
 *   - Tiers: fiber=1, wool=2, hide=3.
 *   - Persist 'artifex-tents:v1'; cap 16.
 *
 * Canopy:
 *   - Under a tree crown within ~2.5 m horizontal AND player below crown height.
 *   - vitals.ts TempInputs.tentTier is discrete (0|1|2|3).
 *   - Canopy maps to tentTier 1 (same warmth as fiber tent = 0.5).
 *     Rationale: canopy is a partial shelter; mapping to tier 1 reuses the
 *     existing vitals model without adding new fields.
 *
 * API:
 *   tentTierAt(tents, x, z)  → 0|1|2|3  (best tent within 3 m)
 *   canopyAt(trees, x, y, z) → boolean  (under a tree crown)
 *   shelterTier(tents, trees, x, y, z) → 0|1|2|3  (combined: best of tent or canopy-1)
 */

export const TENTS_KEY = 'artifex-tents:v1';

/** Tent placement radius (m) — player must be within this to get shelter bonus. */
export const TENT_RADIUS = 3;
/** Max tents kept in persistence. */
export const MAX_TENTS = 16;
/** Horizontal canopy check radius (m) from tree centre. */
export const CANOPY_RADIUS = 2.5;

export type TentTier = 0 | 1 | 2 | 3;

export interface PlacedTent {
  id: string;
  x: number;
  y: number;
  z: number;
  tier: 1 | 2 | 3;
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

function genId(): string {
  return `tent_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

export function createTent(
  x: number,
  y: number,
  z: number,
  tier: 1 | 2 | 3,
): PlacedTent {
  return { id: genId(), x, y, z, tier };
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
    out.push({ id: o.id as string, x: o.x as number, y: o.y as number, z: o.z as number, tier: o.tier as 1 | 2 | 3 });
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
