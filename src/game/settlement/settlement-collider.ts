/**
 * Settlement collision — pure AABB solids derived from resolved pads (yaws
 * are 90°-quantized, so every obstacle is axis-aligned), plus a GroundQuery
 * wrapper that layers them over open terrain: walls block via the
 * axis-separated slide idiom (DungeonCollider), platform skirts and low
 * rubble are standable ground.
 */

import type { GroundQuery } from '../collision';
import { padHalfExtents, type ResolvedSettlement } from './settlement-layout';

export interface SolidBox {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Standable top (platforms) or wall top (blockers) in world y. */
  top: number;
}

export interface SettlementSolids {
  /** XZ footprints the capsule cannot enter. */
  blockers: SolidBox[];
  /** Standable tops (platform skirts, low rubble). */
  platforms: SolidBox[];
}

const SKIRT_MARGIN = 0.3;   // platform skirt overhang (settlement-mesh.ts)
const MIN_BLOCK_H = 0.8;    // lower ruins are rubble you can step on
const PIER_W = 2.2;         // gatehouse pier half-width (matches mesh)

/** Pure: one settlement's collision boxes. Memoize at the call site. */
export function buildSettlementSolids(s: ResolvedSettlement): SettlementSolids {
  const blockers: SolidBox[] = [];
  const platforms: SolidBox[] = [];
  for (const pad of s.pads) {
    const { hx, hz } = padHalfExtents(pad);
    const foot: SolidBox = {
      x0: pad.wx - hx, z0: pad.wz - hz,
      x1: pad.wx + hx, z1: pad.wz + hz,
      top: pad.wy + pad.h,
    };
    /** Blocker + the platform skirt that hides the downhill slope gap. */
    const solidWithSkirt = (): void => {
      blockers.push(foot);
      platforms.push({
        x0: foot.x0 - SKIRT_MARGIN, z0: foot.z0 - SKIRT_MARGIN,
        x1: foot.x1 + SKIRT_MARGIN, z1: foot.z1 + SKIRT_MARGIN,
        top: pad.wy + 0.08,
      });
    };
    switch (pad.type) {
      // Roofed structures: solid, and their skirt is standable.
      case 'house':
      case 'townhouse':
      case 'barn':
      case 'keep':
      case 'church':
      case 'tavern':
      case 'longhouse':
      case 'smithy':
      case 'mill':
      case 'granary':
      case 'tower':
      case 'wall':
      case 'stable':
        solidWithSkirt();
        break;
      // Solid furniture and clutter: block, but no standable top — a player
      // perched on a hay bale or a hedge looks worse than one walking round it.
      case 'well':
      case 'fence':
      case 'stall':
      case 'trough':
      case 'pillory':
      case 'shrine':
      case 'barrels':
      case 'hedge':
      case 'cart':
      case 'woodpile':
      case 'haystack':
      case 'brazier':
        blockers.push(foot);
        break;
      case 'ruin':
        if (pad.h >= MIN_BLOCK_H) blockers.push(foot);
        else platforms.push(foot); // rubble: step onto it
        break;
      // Poles, cloth and worked ground — walk straight through.
      case 'signpost':
      case 'lamp':
      case 'banner':
      case 'washline':
      case 'crops':
      case 'graves':
        break;
      case 'gatehouse': {
        // Two flanking piers; leave a 4.4 m passage in the center.
        // Left pier.
        blockers.push({
          x0: foot.x0, z0: foot.z0, x1: foot.x0 + (hx - PIER_W), z1: foot.z1,
          top: foot.top,
        });
        // Right pier.
        blockers.push({
          x0: foot.x1 - (hx - PIER_W), z0: foot.z0, x1: foot.x1, z1: foot.z1,
          top: foot.top,
        });
        // Lintel arch (above passage, no block at floor level).
        platforms.push({
          x0: foot.x0 - SKIRT_MARGIN, z0: foot.z0 - SKIRT_MARGIN,
          x1: foot.x1 + SKIRT_MARGIN, z1: foot.z1 + SKIRT_MARGIN,
          top: pad.wy + 0.08,
        });
        // Interior floor so player can walk inside.
        platforms.push({
          x0: foot.x0 + (hx - PIER_W), z0: foot.z0,
          x1: foot.x1 - (hx - PIER_W), z1: foot.z1,
          top: pad.wy + 0.08,
        });
        break;
      }
      case 'jail':
        // Jail is solid with a door gap on the -z face.
        // The gap is 1.1 m wide (±0.55); block the rest of the front face via
        // left/right flanks + back wall. For simplicity block the whole footprint;
        // the door gap is navigable because the player can walk through at ground level
        // (the door opening is 2.0 m tall — no ceiling blocker here).
        blockers.push(foot);
        platforms.push({
          x0: foot.x0 - SKIRT_MARGIN, z0: foot.z0 - SKIRT_MARGIN,
          x1: foot.x1 + SKIRT_MARGIN, z1: foot.z1 + SKIRT_MARGIN,
          top: pad.wy + 0.08,
        });
        // Interior floor pad so player can stand inside.
        platforms.push({
          x0: foot.x0 + 0.2, z0: foot.z0 + 0.2,
          x1: foot.x1 - 0.2, z1: foot.z1 - 0.2,
          top: pad.wy + 0.08,
        });
        break;
      default: {
        // Exhaustiveness guard. A new PadType with no case here would be
        // silently non-solid — the player walks through a new building and
        // nothing anywhere reports a problem. Make it a compile error.
        const unhandled: never = pad.type;
        void unhandled;
        break;
      }
    }
  }
  return { blockers, platforms };
}

/** Axis-separated capsule slide against blockers (2D XZ pushout). */
export function slideXZ(
  x: number, z: number, dx: number, dz: number, r: number,
  blockers: SolidBox[],
): [number, number] {
  let nx = x + dx;
  for (const b of blockers) {
    if (z > b.z0 - r && z < b.z1 + r && nx > b.x0 - r && nx < b.x1 + r) {
      nx = x >= (b.x0 + b.x1) / 2 ? b.x1 + r : b.x0 - r;
    }
  }
  let nz = z + dz;
  for (const b of blockers) {
    if (nx > b.x0 - r && nx < b.x1 + r && nz > b.z0 - r && nz < b.z1 + r) {
      nz = z >= (b.z0 + b.z1) / 2 ? b.z1 + r : b.z0 - r;
    }
  }
  return [nx, nz];
}

/**
 * Layer settlement solids over the open-terrain GroundQuery. `source` yields
 * the currently meshed settlements (SettlementManager.nearby); solids are
 * cached per settlement object.
 */
export function settlementGround(
  base: GroundQuery,
  source: () => ResolvedSettlement[],
): GroundQuery {
  const cache = new WeakMap<ResolvedSettlement, SettlementSolids>();
  const near = (x: number, z: number): SettlementSolids[] => {
    const out: SettlementSolids[] = [];
    for (const s of source()) {
      if (Math.hypot(x - s.site.x, z - s.site.z) > s.site.radius + 4) continue;
      let solids = cache.get(s);
      if (solids === undefined) {
        solids = buildSettlementSolids(s);
        cache.set(s, solids);
      }
      out.push(solids);
    }
    return out;
  };
  return {
    groundHeight(x, z, r) {
      let h = base.groundHeight(x, z, r);
      for (const { platforms } of near(x, z)) {
        for (const p of platforms) {
          if (x > p.x0 - r && x < p.x1 + r && z > p.z0 - r && z < p.z1 + r) {
            h = Math.max(h, p.top);
          }
        }
      }
      return h;
    },
    ceilingHeight(x, z) {
      return base.ceilingHeight(x, z);
    },
    moveXZ(x, z, dx, dz, r) {
      let [nx, nz] = base.moveXZ(x, z, dx, dz, r);
      for (const { blockers } of near(x, z)) {
        [nx, nz] = slideXZ(x, z, nx - x, nz - z, r, blockers);
      }
      return [nx, nz];
    },
  };
}
