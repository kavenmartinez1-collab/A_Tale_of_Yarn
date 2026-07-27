/**
 * Where Castle Vhaeron stands, and how high its motte is.
 *
 * PURE — takes a `HeightField` and returns numbers, so the reachability proof
 * can resolve the same site the game does without booting a renderer.
 *
 * ## Choosing the site
 *
 * A sweep of the landmass (`scripts/_probe-castle-site.mts`, throwaway) found:
 *   - the world is roughly half ocean, with the land west and north-west of
 *     the origin;
 *   - there is NO flat ground: the flattest 120 x 108 m footprint anywhere
 *     within 400 m still varies by ~16 m;
 *   - settlements and dungeon entrances sit on a 512 m cell grid, and the
 *     flattest spots are exactly where the settlement generator also wants to
 *     build — the first site picked had a village 10 m away.
 *
 * (-320, 40) is the flattest footprint that is more than 110 m clear of every
 * settlement and dungeon entrance, is entirely above sea level, and sits in
 * forest rather than on a beach.
 *
 * ## The motte
 *
 * `baseY` is the courtyard height, set to the highest terrain anywhere under
 * the castle OR under the breach ramp, plus a metre. That single rule is what
 * guarantees terrain can never poke up through a courtyard floor, and that the
 * escape ramp always starts above the hillside rather than inside it.
 */

import type { HeightField } from '../noise';
import type { Vec3 } from '../math';
import { KEEP_HX, KEEP_HZ, LEVEL_Y, OUTER_HX, OUTER_HZ, SLAB_T } from './castle-layout';

/** Fixed seed for the castle. The opening must be identical every playthrough. */
export const CASTLE_SEED = 0x5caff1e;

/** World XZ of the keep's centre. */
export const CASTLE_SITE: [number, number] = [-320, 40];

/** Clearance the motte top keeps above the highest terrain it covers. */
const MOTTE_MARGIN = 1.0;

/** How far past the east wall the breach ramp may run; sampled for baseY too. */
const RAMP_ZONE = 48;

/**
 * Is (x, z) on the castle's grounds?
 *
 * Used by the tree and resource scatters to keep the motte bare. It is a pure
 * function of two constants on purpose — the scatters run per chunk during
 * streaming and must not need a heightfield sample or a manager instance.
 *
 * The margin covers the plinth skirt and the breach causeway: a tree rooted on
 * the hillside grows 5-8 m, which is enough to push its canopy up through a
 * courtyard slab, and an ore node on the motte face floats in mid-air.
 */
export function onCastleGrounds(x: number, z: number, pad = 0): boolean {
  const dx = Math.abs(x - CASTLE_SITE[0]);
  const dz = Math.abs(z - CASTLE_SITE[1]);
  // Asymmetric in +X: the breach causeway runs east down the crag.
  const east = x - CASTLE_SITE[0];
  const limX = east > 0 ? OUTER_HX + RAMP_ZONE + pad : OUTER_HX + 14 + pad;
  return dx <= limX && dz <= OUTER_HZ + 14 + pad;
}

export interface CastleSite {
  /** World-space translation applied to every local coordinate. */
  origin: Vec3;
  minTerrain: number;
  maxTerrain: number;
}

export function resolveCastleSite(hf: HeightField): CastleSite {
  const [cx, cz] = CASTLE_SITE;
  let min = Infinity;
  let max = -Infinity;
  let keepMax = -Infinity;
  // Footprint, generously padded so the plinth skirt is covered too.
  const hx = OUTER_HX + 10;
  const hz = OUTER_HZ + 10;
  for (let z = -hz; z <= hz; z += 2) {
    for (let x = -hx; x <= hx; x += 2) {
      const h = hf.heightAt(cx + x, cz + z);
      if (h < min) min = h;
      if (h > max) max = h;
      // The keep alone, because the undercroft is carved BELOW the courtyard
      // and only has to clear the ground under the keep.
      if (Math.abs(x) <= KEEP_HX + 4 && Math.abs(z) <= KEEP_HZ + 4 && h > keepMax) {
        keepMax = h;
      }
    }
  }
  // The breach ramp corridor east of the wall. Terrain here must also sit
  // below the courtyard or the ramp starts underground.
  for (let x = hx; x <= OUTER_HX + RAMP_ZONE; x += 2) {
    for (let z = -10; z <= 10; z += 2) {
      const h = hf.heightAt(cx + x, cz + z);
      if (h > max) max = h;
      if (h < min) min = h;
    }
  }
  // Two constraints, and the motte has to satisfy the tighter one:
  //
  //   1. The courtyard slab's UNDERSIDE (baseY - SLAB_T) must clear the highest
  //      terrain anywhere in the footprint, or a knoll pokes up through the
  //      courtyard and the player walks over a hill growing out of the flags.
  //   2. The undercroft's floor slab underside (baseY + LEVEL_Y[0] - SLAB_T)
  //      must clear the terrain under the keep. Miss this and the prison is
  //      below ground level, which in this engine means grass grows through
  //      the cell floor — which is exactly what the first build did.
  const forCourtyard = max + MOTTE_MARGIN + SLAB_T;
  const forUndercroft = keepMax + MOTTE_MARGIN + SLAB_T - LEVEL_Y[0];
  const baseY = Math.max(forCourtyard, forUndercroft);
  return {
    origin: [cx, baseY, cz],
    minTerrain: min,
    maxTerrain: max,
  };
}
