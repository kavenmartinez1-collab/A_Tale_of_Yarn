/**
 * castle-garrison.ts — who holds Castle Vhaeron, and where they stand.
 *
 * PURE. No GPU, no DOM, no renderer import, so `scripts/test-castle-fight.mts`
 * asserts on shipping code rather than on a replica — the same reason
 * `dungeon-enemies.ts` is its own file (see its header for the story of the
 * inline copy that could not have caught a change to the real spawner).
 *
 * ## Why these are ordinary entities and not a parallel list
 *
 * `DungeonManager` keeps its own `DungeonEnemy[]` because a dungeon is an
 * ARENA at y = -300: the overworld tick is replaced wholesale while you are
 * inside it (`main.ts` returns early from `tickEntities`), so a dungeon mob
 * could never be an `entityManager` entity without also being streamed,
 * capped and drawn out in the real world where it does not exist.
 *
 * The castle is not an arena. It is world geometry on a motte, the overworld
 * tick runs the whole time the player is in it, and so its garrison can be
 * plain `EntityState` — which buys rendering, animation LOD, the shared combat
 * index, morale, drops and death for nothing. The two things that had to be
 * added for it are a `pinned` flag (`entity-manager.ts`) so the live cap does
 * not quietly cull the throne room, and creature-probe collision queries
 * (`castle-collider.ts`) so they walk on the floor they are standing on
 * instead of the one the player is.
 *
 * ## No archers
 *
 * `goblin_archer` is deliberately absent. `main.ts`'s overworld `stepAnimal`
 * context has no `onRangedAttack`, so an archer outside a dungeon holds its
 * 16 m band and deals damage with no arrow drawn and nothing to dodge — damage
 * out of thin air. Until that is wired, the castle uses the two species that
 * work: goblins for numbers, skeletons for weight.
 *
 * ## Placement is validated, not asserted
 *
 * Every post is probed against the real collider before it is accepted (see
 * `CastleProbe`). A ring of candidate offsets is tried in a fixed order and
 * the first that is standable AND not inside a wall wins; a post that can
 * place nobody places nobody rather than dropping a goblin into masonry. That
 * is the whole defence against the failure this file could most easily have —
 * a roster that reads correctly and spawns half of itself inside a pier.
 */

import type { Species } from '../entities/entity-types';
import { mulberry32 } from '../mesh-utils';
import type { CastleLayout } from './castle-layout';

/**
 * The collider, as this module needs it. Castle-LOCAL coordinates.
 *
 * An interface rather than a `CastleCollider` import so the module stays pure
 * and so the test and the manager provably share one implementation of
 * "can something stand here" — the alternative was re-deriving the rule from
 * `layout.supports` here, which is how two copies of a rule drift apart.
 */
export interface CastleProbe {
  /**
   * Standable surface height at local (x, z) for a body whose feet are at
   * `y`, or null when the castle has no floor for it there.
   */
  ground(x: number, z: number, y: number, r: number): number | null;
  /** True when a body of radius `r` and height `h` at (x, z, y) is in a wall. */
  blocked(x: number, z: number, y: number, r: number, h: number): boolean;
}

/** One placed member of the garrison, in castle-LOCAL coordinates. */
export interface GarrisonPost {
  /** Stable id. Deterministic, and the prefix is what exempts it from the cap. */
  id: string;
  species: Species;
  x: number;
  y: number;
  z: number;
  /** Mesh facing — `atan2(dx, -dz)`, the OTHER convention from camera yaw. */
  yaw: number;
  colorVariant: number;
  /** The marker this post guards. Diagnostics, tests and the debug hook. */
  station: string;
}

/**
 * Id prefix for every garrison entity.
 *
 * Load-bearing three times over. `EntityManager.STREAMED_ID` only matches
 * `cx,cz:eN`, so this shape is exempt from distance release and cell unload;
 * `_enforceCap` is taught about it through the `pinned` flag rather than the
 * id; and `main.ts` uses the prefix to route these entities to castle-aware
 * collision instead of the terrain-only world every other animal gets.
 */
export const GARRISON_ID_PREFIX = 'castle:';

/** True for an entity id produced by this module. */
export function isGarrisonId(id: string): boolean {
  return id.startsWith(GARRISON_ID_PREFIX);
}

/**
 * Hard ceiling on the garrison.
 *
 * `MAX_DRAWN` is 30 and the rebuild budget is 8/frame, of which the King and
 * his dragon already take two (1.9 ms and 2.8 ms). Eighteen bodies spread over
 * four storeys and 130 m puts at most five or six in the near band at once,
 * which leaves the budget with headroom for the wildlife that also lives out
 * here. The dungeon cap is 22 for the same arithmetic against a fight that has
 * no boss flying over it.
 */
export const GARRISON_CAP = 18;

/**
 * Body height used for the wall test, as a multiple of species `size`.
 *
 * `SPECIES_DEFS.size` is a SHOULDER height (goblin 0.86 -> ~1.1 m standing),
 * so the standing height is roughly 1.27x it. Getting this wrong in the safe
 * direction only costs a rejected candidate; getting it wrong the other way
 * puts a skeleton's skull through a lintel.
 */
const BODY_H_PER_SIZE = 1.3;

/** Collision radius, mirroring `stepAnimal`'s `max(0.3, size * 0.45)`. */
function bodyRadius(size: number): number {
  return Math.max(0.3, size * 0.45);
}

/** Shoulder heights, mirrored from SPECIES_DEFS so this module stays pure. */
const BODY_SIZE: Record<string, number> = { goblin: 0.86, skeleton: 1.45 };

/**
 * A station: a marker, who stands there, and how far out they spread.
 *
 * Ordered deliberately — the rng is drawn station by station in this order, so
 * appending a station cannot reshuffle the ones before it, exactly as
 * `spawnDungeonEnemies` fixes its draw order per room.
 *
 * The choice of markers is the design: the way OUT is guarded (the undercroft
 * stair, the great hall, the front court, the breach end of the wall walk),
 * the way UP is guarded (both keep stairs), and the two ends of the castle
 * that mean something — the throne he sits on and the arena he lands on — are
 * held by skeletons, which do not break and cannot be waited out.
 */
interface Station {
  marker: string;
  /** Drawn from in order, cycling, so the mix is exact rather than random. */
  species: readonly Species[];
  count: number;
  /** Metres from the marker the ring of candidate positions sits at. */
  radius: number;
}

const STATIONS: readonly Station[] = [
  // The undercroft: one goblin between the player and the stair out. The cell
  // itself is deliberately empty — waking up next to a guard is a death, not
  // an opening.
  { marker: 'undercroftStairFoot', species: ['goblin'], count: 1, radius: 3.0 },
  // Level 1, the great hall the escape route crosses.
  { marker: 'L1hall', species: ['skeleton', 'goblin'], count: 2, radius: 5.5 },
  { marker: 'L1wing1', species: ['goblin'], count: 1, radius: 3.0 },
  // The stairs up. One each, so climbing is contested but not a wall.
  { marker: 'stair12', species: ['goblin'], count: 1, radius: 2.6 },
  { marker: 'stair23', species: ['skeleton'], count: 1, radius: 2.6 },
  // Level 2 and 3.
  { marker: 'L2hall', species: ['goblin', 'goblin'], count: 2, radius: 5.5 },
  { marker: 'L3hall', species: ['skeleton'], count: 1, radius: 5.0 },
  // The throne room. Undead, because the player will arrive here worn down and
  // a goblin's morale would hand them a free retreat.
  { marker: 'throne', species: ['skeleton', 'skeleton'], count: 2, radius: 4.5 },
  // The courtyards, which is where the escape is actually run.
  { marker: 'frontCourt', species: ['goblin', 'goblin'], count: 2, radius: 7.0 },
  { marker: 'backCourt', species: ['goblin', 'skeleton'], count: 2, radius: 7.0 },
  { marker: 'gatehouse', species: ['goblin'], count: 1, radius: 4.0 },
  // The tower. The last thing between the player and the fight.
  { marker: 'arena', species: ['skeleton', 'skeleton'], count: 2, radius: 6.0 },
];

/**
 * Candidate offsets around a station, tried in this order.
 *
 * Eight compass points plus the centre. Fixed rather than random so a rejected
 * candidate always falls back to the same next one — a random retry would make
 * the roster depend on how many candidates happened to fail, which is the kind
 * of determinism that holds until someone moves a wall.
 */
const RING: readonly [number, number][] = [
  [0, -1], [0.71, -0.71], [1, 0], [0.71, 0.71],
  [0, 1], [-0.71, 0.71], [-1, 0], [-0.71, -0.71],
];

/**
 * Place the garrison.
 *
 * Deterministic in `seed` and the layout alone: the rng only chooses the
 * jitter and the colour variant, and the candidate order is fixed. Two calls
 * with the same arguments return byte-identical arrays, which
 * `test-castle-fight.mts` asserts, because "the same door leads to the same
 * fight" has to be true of the opening as well as of a dungeon.
 */
export function castleGarrison(
  layout: CastleLayout, seed: number, probe: CastleProbe,
): GarrisonPost[] {
  const rng = mulberry32(seed ^ 0x9a12b0);
  const out: GarrisonPost[] = [];
  let n = 0;

  for (const st of STATIONS) {
    const m = layout.markers.get(st.marker);
    if (m === undefined) continue;   // a marker the layout no longer defines
    for (let i = 0; i < st.count; i++) {
      if (out.length >= GARRISON_CAP) return out;
      const species = st.species[i % st.species.length];
      const size = BODY_SIZE[species] ?? 1;
      const r = bodyRadius(size);
      const h = size * BODY_H_PER_SIZE;

      // The rng is drawn ONCE per body, before any candidate is tried, so the
      // number of rejected candidates cannot change the stream for the next
      // body. Drawing inside the retry loop is the classic way a placement
      // function stops being deterministic under a layout edit.
      const spin = rng();
      const jitter = 0.75 + rng() * 0.5;
      const colorVariant = (rng() * 4) | 0;

      const placed = tryPlace(
        probe, m.x, m.y, m.z, st.radius * jitter,
        Math.floor(spin * RING.length), r, h, out);
      if (placed === null) continue;

      out.push({
        id: `${GARRISON_ID_PREFIX}${n++}`,
        species,
        x: placed[0], y: placed[1], z: placed[2],
        // Facing the marker's centre: a guard looks at what it is guarding.
        // Mesh facing is `atan2(dx, -dz)` — the opposite convention from the
        // camera's, and getting it backwards turns the whole garrison round.
        yaw: Math.atan2(m.x - placed[0], -(m.z - placed[2])),
        colorVariant,
        station: st.marker,
      });
    }
  }
  return out;
}

/**
 * First standable, unblocked point on the ring, starting at `from`.
 *
 * Returns local (x, y, z) or null. The probe is asked for the surface at the
 * MARKER's height, not at the candidate's, because the whole point is to keep
 * a guard on the storey it was assigned to: without that clamp a candidate
 * that overhangs a stairwell resolves to the floor below and the throne room's
 * guard is standing in the hall under it.
 */
function tryPlace(
  probe: CastleProbe,
  mx: number, my: number, mz: number,
  radius: number, from: number, r: number, h: number,
  placed: readonly GarrisonPost[],
): [number, number, number] | null {
  // The centre is tried LAST, not first: a marker is where the reachability
  // proof stands the player, and putting a body exactly on it is the one
  // position guaranteed to be in the way.
  for (let k = 0; k <= RING.length; k++) {
    const isCentre = k === RING.length;
    const d = RING[(from + k) % RING.length];
    const x = isCentre ? mx : mx + d[0] * radius;
    const z = isCentre ? mz : mz + d[1] * radius;
    const y = probe.ground(x, z, my, r);
    if (y === null) continue;
    // Same storey. STEP_UP is 0.6, so anything inside that is the same floor
    // plus a threshold; anything beyond it is a different one.
    if (Math.abs(y - my) > 0.6) continue;
    if (probe.blocked(x, z, y, r, h)) continue;
    // ...and not on top of somebody already standing there.
    //
    // The collider cannot answer this — it knows about walls, not about the
    // guard placed two lines ago. Two stations 11 m apart with a 7 m scatter
    // radius each can and did put a goblin and a skeleton inside one another,
    // which renders as one creature wearing another and makes both unhittable
    // separately. Only same-storey neighbours count: a body directly overhead
    // on the next floor is not a conflict.
    let clash = false;
    for (const p of placed) {
      if (Math.abs(p.y - y) > 2) continue;
      const need = r + Math.max(0.3, (BODY_SIZE[p.species] ?? 1) * 0.45);
      if (Math.hypot(p.x - x, p.z - z) < need) { clash = true; break; }
    }
    if (clash) continue;
    return [x, y, z];
  }
  return null;
}
