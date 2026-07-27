/**
 * map-landmarks.ts — what is worth marking on the chart, per 512 m cell.
 *
 * Pure and node-testable: every landmark the map can show is already a pure
 * function of (seed, cell) in the world generator, so nothing here needs the
 * streaming managers, a GPU, or the player to be anywhere near. That is the
 * whole reason the map can draw a village you visited an hour ago and have
 * since walked 3 km away from.
 *
 * Deliberately NOT a discovery filter: this answers "what is in this cell",
 * and the caller only ever asks about cells it has already decided are
 * discovered. Keeping the fog test out of here is what stops a bug in the
 * landmark query from leaking undiscovered content onto the map.
 */

import { CASTLE_SITE } from '../castle/castle-site';
import { DUNGEON_FIXTURES } from '../dungeon/dungeon-fixtures';
import { entranceSiteAt } from '../dungeon/entrance-site';
import { mix32 } from '../dungeon/dungeon-layout';
import { layoutSettlement } from '../settlement/settlement-layout';
import { settlementSiteAt } from '../settlement/settlement-scatter';
import type { SettlementKind } from '../settlement/settlement-scatter';

export type LandmarkKind = 'settlement' | 'dungeon' | 'castle';

export interface Landmark {
  kind: LandmarkKind;
  /** For settlements, the scatter kind (ruins/ranch/village/town/castle). */
  sub: SettlementKind | null;
  name: string;
  x: number;
  z: number;
  /** Footprint radius (m); 0 for point landmarks like dungeon entrances. */
  radius: number;
}

/**
 * The one-off castle from the opening. It is a fixed landmark rather than a
 * scattered one, so it is not in any cell's scatter roll and has to be added
 * by hand. The name is prose in the source (castle-site.ts, castle-manager.ts)
 * rather than an exported constant, so it is spelled once, here.
 */
export const CASTLE_VHAERON: Landmark = {
  kind: 'castle',
  sub: null,
  name: 'Castle Vhaeron',
  x: CASTLE_SITE[0],
  z: CASTLE_SITE[1],
  radius: 62,
};

/**
 * Landmarks in one 512 m cell (which is simultaneously the settlement cell,
 * the dungeon cell and the map's storage tile — SCELL === DCELL === MAP_TILE).
 *
 * `heightAt` must be the BASE height field, never the road-carved one: the
 * scatters decided where things went using the base field, and feeding the
 * carved field back shifts a site by up to a cell in eight hundred. Placing a
 * village on the map a chunk away from where it actually is would be a very
 * hard bug to see and a very annoying one to walk into.
 */
export function landmarksInCell(
  seed: number, tx: number, tz: number,
  heightAt: (x: number, z: number) => number,
  out: Landmark[] = [],
): Landmark[] {
  const site = settlementSiteAt(seed, tx, tz, heightAt);
  if (site !== null) {
    out.push({
      kind: 'settlement',
      sub: site.kind,
      // layoutSettlement needs no heightfield — it is the cheap half of
      // resolveSettlement, and the name is all the map wants.
      name: layoutSettlement(site.kind, site.seed).name,
      x: site.x,
      z: site.z,
      radius: site.radius,
    });
  }
  const entrance = entranceSiteAt(seed, tx, tz, heightAt);
  if (entrance !== null) {
    out.push({
      kind: 'dungeon',
      sub: null,
      // The fixture fallback, which is what DungeonManager uses until (and
      // unless) the AI Director resolves a spec for this cell. Director names
      // arrive asynchronously into a private cache we cannot read, so a
      // Director-named dungeon will show its fixture name here. Deterministic
      // and always correct with ?director=off.
      name: DUNGEON_FIXTURES[mix32(seed, tx, tz) % DUNGEON_FIXTURES.length].name,
      x: entrance.x,
      z: entrance.z,
      radius: 0,
    });
  }
  return out;
}
