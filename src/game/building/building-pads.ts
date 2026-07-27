/**
 * Which settlement pads have a door the player can open, and what kind of
 * interior lies behind it.
 *
 * Split out of `building-manager.ts` because this is data, not rendering: NPC
 * scheduling has to consult the same table (sending someone indoors through a
 * door that does not exist would delete them from the world), and importing the
 * manager for it would drag the whole WebGPU renderer into pure CPU code and
 * every node-side test.
 */

import type { BuildingKind } from './building-interior';

export const ENTERABLE_PAD_TYPES: ReadonlyMap<string, BuildingKind | 'varied'> = new Map([
  ['house', 'house'],
  ['barn', 'varied'],       // barn → shop / tavern / barn, by per-building seed
  ['stable', 'barn'],
  ['keep', 'keep'],
  ['tower', 'guardhouse'],
  ['gatehouse', 'guardhouse'],
  ['church', 'church'],
  ['tavern', 'tavern'],
  ['longhouse', 'longhouse'],
  ['smithy', 'smithy'],
  // jail is explicitly excluded — entering would break the jail/crime flow
]);

/** Can the player open this pad's door? */
export function isEnterablePad(padType: string): boolean {
  return ENTERABLE_PAD_TYPES.has(padType);
}

/** Map a 'varied' pad to a concrete kind based on seed determinism. */
export function variedKind(seed: number): BuildingKind {
  const pick = (seed >>> 3) % 3;
  return pick === 0 ? 'shop' : pick === 1 ? 'tavern' : 'barn';
}
