/**
 * Pure settlement site selection — deterministic per 512 m cell, a function
 * of (seed, scx, scz) and the heightfield only (node-testable, memoize at
 * call sites like dungeon entrances).
 *
 * Roll order per cell: presence (45 %) → kind (ruins 26 / ranch 14 /
 * village 22 / town 19 / castle 19 %, see `rollKind` — the ACCEPTED mix is very
 * different, because acceptance falls off sharply with footprint size) → up to
 * `CANDIDATES` jittered candidates, accepted above the sand line, clear of any
 * river, on ground flat enough for the kind (disc of heightAt samples).
 * A candidate near the same cell's dungeon entrance is rejected so arches
 * never poke through buildings (cells are 512 m in both systems).
 */

import { mix32 } from '../dungeon/dungeon-layout';
import { mulberry32 } from '../mesh-utils';
import { entranceSiteAt } from '../dungeon/entrance-site';
import { createHeightField } from '../noise';

export const SCELL = 512;      // settlement-cell edge (m) — matches DCELL
const SALT = 0x5e77c0de;
const PRESENCE = 0.45;         // fraction of cells that attempt a settlement
// Raised from 8 when the flatness test became a whole-footprint spread check.
// The stricter test rejected far more sites, and with only 8 tries per cell
// that showed up as a density collapse — castles fell 7 -> 3 across a 576-cell
// sweep, which matters because the road network is rooted at castles and the
// player has to be able to FIND one. More attempts keeps the settlement count
// while keeping the ground genuinely flat; loosening the budget instead would
// have traded the whole point of the change for the same density.
// Raised again 40 -> 96 when the budgets tightened and the sampling got denser
// (below). This is what keeps the settlement count up as the acceptance test
// got stricter — over the 576-cell test sweep it went 192 -> 199 with the same
// 8 castles, because the extra tries more than pay for the extra rejections.
//
// Raised 96 -> 128 for the same reason when the river test landed. That test is
// a new acceptance cut on top of the flatness one, and on its own it cost
// 166 -> 162 settlements and 12 -> 10 castles across the 576-cell sweep. The
// castle number is the one that matters — the road network is a Dijkstra tree
// rooted at castle gates and `test-roads` guards `castles >= 8` — and the
// budget buys it back cheaply, measured on the same sweep:
//
//     96  ->  162 settlements, 10 castles, 20 ms
//     128 ->  168 settlements, 11 castles, 23 ms
//     160 ->  171 settlements, 11 castles, 27 ms
//     192 ->  174 settlements, 11 castles, 33 ms
//
// 128 restores the settlement count past where it started and takes the castle
// count back to within one of it; past that the castles stop coming and only
// the small kinds and the cost keep rising. Raising this is always safe for
// determinism: the candidate loop draws from `rng` in a fixed order, so a
// bigger budget can only append tries AFTER every one the old budget made —
// every site accepted at 96 is accepted at 128, in the same place.
const CANDIDATES = 128;
const MIN_HEIGHT = 3;          // stay above the sand line (m)
const ENTRANCE_CLEARANCE = 24; // extra gap beyond the settlement radius (m)
// 8 spokes was too coarse to enforce the budget it claimed: sampling a 68 m
// castle disc on 3 rings of 8 missed ridges between the spokes, and sites
// accepted under a 24 m budget measured up to 31.4 m when sampled densely.
const RING_SAMPLES = 14;

/**
 * The river oracle, derived from the seed rather than passed in.
 *
 * Rivers are a SEPARATE LAYER from the height this function is handed. They are
 * carved into `heightAt` (noise.ts: `h - riverFactor * 3.5`), but the carve is
 * shallow and enormously wide — the band is |riverNoise| < 0.04 at a 1800 m
 * wavelength, which measures ~140 m across on the ground, wider than a castle
 * town's whole 136 m footprint. So a 3.5 m carve spread over 70 m is a 5 %
 * grade: it costs almost nothing against `MAX_SITE_SPREAD` and passes
 * `MIN_HEIGHT` outright wherever the surrounding ground is above the sand line.
 * Nothing in the height test could ever have caught it, and 18 of the 166
 * settlements in the 576-cell sweep were sitting on a river.
 *
 * That mattered because the three layers that read a river do not agree:
 *
 *   - the world map paints water at `riverFactor > 0.45` (map-palette.ts);
 *   - the 3D world draws water from ONE flat quad at y = 0 (water.wgsl), so a
 *     river only holds visible water where the carve reaches sea level — 3.7 %
 *     of all river area, measured. Everywhere else it is a dry gully;
 *   - `nearFreshWater()` drinks at `riverFactor > 0`, the widest predicate of
 *     the three.
 *
 * A settlement on a river therefore showed a blue thread through the town on
 * the map, no water at all in-world (the site test's own `MIN_HEIGHT` floor
 * GUARANTEES the footprint is above sea level, so the visible-water case is the
 * one place a settlement can never be), and let the player drink standing in
 * the market square. That is the Greenholm bug.
 *
 * Taken from the seed and memoised rather than added as a parameter so that
 * every caller — the manager, the road network, the tree and resource scatters,
 * the map's landmark index — is answered by the same oracle and none of them
 * can forget to pass it. A river test that only some callers applied would put
 * buildings where the tree scatter had not cleared a clearing, which is the
 * same two-layers-disagree failure this test exists to remove.
 *
 * One entry is the whole cache: a world has one seed, and the tests that sweep
 * several re-derive on each change, which costs five Perlin shuffles.
 */
let riverSeed = NaN;
let riverOf: (x: number, z: number) => number = () => 0;
function riverFactorFor(seed: number): (x: number, z: number) => number {
  if (seed !== riverSeed) {
    riverSeed = seed;
    riverOf = createHeightField(seed).riverFactor;
  }
  return riverOf;
}

export type SettlementKind = 'ruins' | 'ranch' | 'village' | 'town' | 'castle';

/**
 * Footprint radius per kind. This is not decoration: tree and resource
 * scatter carve a clearing of `radius + 3`, so it has to cover the furthest
 * pad or a mill ends up inside an oak. The castle grew from 50 to 68 when it
 * gained a *town* outside its north gate — the approach street, market and
 * churchyard now reach ~66 m from the centre.
 */
export const SETTLEMENT_RADIUS: Record<SettlementKind, number> = {
  ruins: 10, ranch: 20, village: 28, town: 40, castle: 68,
};

/** Max |Δh| across the footprint ring. Generous — buildings sit on platform
 * skirts (C-M3), so big kinds get a bigger budget for their bigger ring.
 * The castle's ring is sampled at 0.7·68 = 47.6 m, over ground that is
 * naturally less flat than a 35 m ring, so its budget rose with its radius:
 * every pad is grounded independently, so undulation costs nothing but the
 * skirt depth. */
/**
 * Max height SPREAD (highest minus lowest sample) across the whole footprint.
 *
 * Not the same measure as the old `MAX_RING_DH`, which was |sample - centre|
 * on one ring: a spread budget is roughly twice as strict as the same number
 * used as a deviation, because it catches both sides of a slope at once.
 * These are set to keep settlement density about where it was while making
 * the ground genuinely flat — buildings sit on platform skirts, so mild
 * undulation costs only skirt depth, but a settlement draped over a ridge
 * looks wrong however well each pad is grounded.
 */
const MAX_SITE_SPREAD: Record<SettlementKind, number> = {
  ruins: 7, ranch: 7, village: 9, town: 9,
  // Castles stay the loosest — a fortress belongs on commanding ground — but
  // 24 was too loose in practice and the user reported castle and town
  // placements reading as glitchy. Tightened 24 -> 20.
  //
  // 20 is not a preference, it is close to the floor. A 68 m-radius footprint
  // is very large, and the sweep is unambiguous about what this terrain can
  // actually supply (625 cells, seed 1337):
  //
  //     budget 24  ->  8 castles, spread p50 18.7 max 31.4
  //     budget 20  ->  8 castles, spread p50 17.9 max 20.8
  //     budget 18  ->  7 castles, spread p50 16.3 max 18.8
  //     budget 16  ->  5 castles
  //     budget 12  ->  1 castle, even at 160 candidates per cell
  //
  // Below ~16 the world effectively stops having castles, and since the road
  // network is a Dijkstra tree ROOTED at castle gates, that does not just
  // remove a building — it removes the roads. test-roads.mts guards on
  // `castles >= 8`, and 18 trips it; 20 is the tightest budget that holds the
  // castle count while still cutting the worst-case spread by a third.
  //
  // The remaining slope is meant to be handled by terracing and steps, not by
  // rejecting the site: the user's own framing is that a settlement built into
  // a mountain is good *provided you can move through it*.
  castle: 20,
};

/** Radii, as fractions of the settlement radius, sampled for flatness.
 *  Five rings rather than three: with three, nothing between 0.45 and 0.75 of
 *  the radius was ever tested, which on a castle is a 20 m annulus. */
const RING_FRACTIONS = [0.3, 0.5, 0.7, 0.85, 1.0];

export interface SettlementSite {
  kind: SettlementKind;
  x: number;
  y: number;
  z: number;
  radius: number;
  /** Stable per-settlement seed for layout + naming (C-M2). */
  seed: number;
  /** Pinned display name (forced sites only) — overrides the seed-derived one. */
  name?: string;
}

/**
 * What a cell builds, given one rng draw.
 *
 * These are ROLL shares, and the accepted mix is nothing like them, because
 * acceptance is a strong function of footprint size. Measured over a
 * 1600-cell sweep of seed 1337:
 *
 *     ruins 92%   ranch 75%   village 63%   castle 33%   town 24%
 *
 * A 10 m ruin fits almost anywhere; a 40 m town has to find ground flat to
 * within 9 m across its whole footprint and mostly cannot. So the old roll of
 * 40/22/15/13/10 produced an accepted mix of 54/25/14/4/4 — the two kinds that
 * feel inhabited were 8% of the world, and 54% of everything the player found
 * was rubble with nobody in it.
 *
 * Rebalanced to 26/14/22/19/19. The shares are chosen so that the ACCEPTED mix
 * comes out near 40/19/25/9/7, which roughly halves the ruins share and nearly
 * doubles the villages while holding the invariants the rest of the world
 * depends on:
 *
 *   - ruins stay the commonest kind (they are 92% accepted, so they always
 *     will be) and ranch stays commoner than castle;
 *   - castles stay no commoner than towns, which is why town's share is only
 *     equal to castle's despite being wanted more often: it is accepted a
 *     third as readily;
 *   - castles rise 7 -> 11 in the 576-cell window. That direction matters and
 *     the other one is dangerous: the road network is a Dijkstra tree ROOTED at
 *     castle gates, `test-roads` guards `castles >= 8`, and fewer castles does
 *     not remove some buildings, it removes the roads.
 *
 * Total settlements fall 199 -> 166 in the same window, which is the price of
 * moving roll mass onto kinds that get rejected more often. It buys a world
 * with a third more people in it, and a road network with more castles on it.
 */
function rollKind(r: number): SettlementKind {
  if (r < 0.26) return 'ruins';
  if (r < 0.40) return 'ranch';
  if (r < 0.62) return 'village';
  if (r < 0.81) return 'town';
  return 'castle';
}

/**
 * Forced sites: cells whose settlement is pinned to an exact kind + position,
 * replacing whatever the cell would roll. Used to guarantee a castle town
 * within walking distance of world spawn so every feature (guards, crime,
 * trade, first-visit questioning...) is testable right at the start.
 *
 * ## The pin moved, because the old one was in a river
 *
 * It was cell '-1,0' at (-191, 166), validated when the flatness test was a
 * single ring measured against the centre and the budget was 9. That position
 * has `riverFactor` 0.996 at its centre and 66 % of its 68 m footprint inside
 * the river band — it was the worst case of the bug the river test above now
 * rejects, and it is why the player could drink anywhere in town.
 *
 * Re-validated offline against seed 1337 by the same process as the original,
 * with the river and Castle Vhaeron tests added (`scripts/_probe-pin*.mts`,
 * throwaway). The search is worth recording because it is tighter than it
 * looks. Sweeping every metre of the old cell '-1,0' for a site that clears the
 * sand line across a 68 m footprint, holds spread <= 20, stays off Vhaeron's
 * grounds and out of every river returns ZERO positions: 69 % of that cell is
 * below the sand line (it is coastal), a third of the rest is river, and the
 * 170 positions that survive everything else are all inside Castle Vhaeron's
 * own footprint. The cell simply cannot carry a castle town, so the pin had to
 * change cells.
 *
 * (-242, -320) in cell '-1,-1' measures, against the acceptance test below:
 *
 *     centre h        20.5 m            (MIN_HEIGHT 3)
 *     footprint spread 19.2 m           (castle budget 20)
 *     max riverFactor  0.0              (nearest river 406 m away)
 *     dungeon entrance 127 m clear      (needs radius + 24 = 92)
 *     Castle Vhaeron   368 m, no footprint sample on its grounds
 *     cell inset       x, z both inside [-380, -132]
 *
 * A forced site must satisfy the inset like any rolled one, which rules out the
 * closest accepted ground. There are sites only 160 m from Vhaeron, but every
 * one sits within 93 m of a cell boundary, and `test-settlement-scatter` guards
 * `inset = 64 + radius` precisely so two settlements in adjacent cells can
 * never crowd each other.
 *
 * ## The site had to be WALKED, not just measured
 *
 * The first pin chosen here was (-219, -346), on the flattest ground anywhere
 * within 520 m — 12.7 m of footprint spread against this one's 19.2. Every
 * offline number preferred it, including the ground-pop check in
 * `test-settlement-paths`. `test-settlement-paths-ingame` then drove the actual
 * player up its streets and he got 30 m up a 14 m climb before sticking, with
 * 150 stalled ticks against a budget of 12.
 *
 * Flat ground does not imply a walkable town, because the street network is
 * laid over the pads rather than the terrain, and it is `slideXZ` — where every
 * blocker is an infinite prism — that the player actually walks against. Six
 * candidates were driven end to end before one arrived: the four with the
 * smallest street climb all stuck within 7-31 m of the top junction, and this
 * one, with a LARGER climb of 7.7 m, walks it with zero stalls and finishes
 * 1.8 m short. Do not re-pick this pin from the offline metrics alone.
 *
 * Distances are from Castle Vhaeron, because that is where a new game actually
 * starts (`CastleManager.spawnPoint`); the old comment measured from (32, 32),
 * which no longer means anything. Cell '-1,-1' rolled no settlement of its own,
 * so nothing was displaced to make room, and the vacated cell '-1,0' now rolls
 * the ranch it always would have — which is also where the NAME went: the town
 * near spawn is generated from its cell, so it is now Ashfield, and Greenholm
 * is the ranch back at the old pin's cell.
 */
const FORCED_SITES = new Map<string, {
  kind: SettlementKind; x: number; z: number;
  /** Pinned display name. Names normally derive from the cell seed, so when
   *  the spawn pin moved cells (river fix, 2026-07-26) the town silently
   *  became "Ashfield" — but the player has known it as Greenholm through
   *  every session and bug report, and the ranch that inherited the old
   *  cell's name is "Greenholm Ranch", which reads as the town's outlying
   *  farm rather than a collision. Identity follows the pin, not the cell. */
  name?: string;
}>([
  ['-1,-1', { kind: 'castle', x: -242, z: -320, name: 'Greenholm' }],
]);

/** Per-cell settlement roll. Deterministic; memoize at the call site. */
export function settlementSiteAt(
  seed: number,
  scx: number,
  scz: number,
  heightAt: (x: number, z: number) => number,
): SettlementSite | null {
  const forced = FORCED_SITES.get(`${scx},${scz}`);
  if (forced !== undefined) {
    return {
      kind: forced.kind,
      x: forced.x,
      y: heightAt(forced.x, forced.z),
      z: forced.z,
      radius: SETTLEMENT_RADIUS[forced.kind],
      seed: mix32(seed ^ SALT, scz, scx),
      name: forced.name,
    };
  }
  const rng = mulberry32(mix32(seed ^ SALT, scx, scz));
  if (rng() >= PRESENCE) return null;
  const kind = rollKind(rng());
  const radius = SETTLEMENT_RADIUS[kind];
  const inset = 64 + radius;
  const entrance = entranceSiteAt(seed, scx, scz, heightAt);
  const riverFactor = riverFactorFor(seed);

  for (let i = 0; i < CANDIDATES; i++) {
    const x = scx * SCELL + inset + rng() * (SCELL - 2 * inset);
    const z = scz * SCELL + inset + rng() * (SCELL - 2 * inset);
    const h = heightAt(x, z);
    if (h < MIN_HEIGHT) continue;
    // Centre on a river: dead before the disc is worth sampling. One Perlin
    // lookup, and it is the single commonest way a candidate is on water.
    if (riverFactor(x, z) > 0) continue;

    // Flatness over the WHOLE footprint, not one ring.
    //
    // This used to sample a single ring at 0.7*radius and compare each sample
    // to the CENTRE. Three things got through:
    //
    //  1. Nothing outside 0.7*radius was checked at all. On a 68 m castle that
    //     leaves the outer 20 m untested, which is how settlements ended up
    //     with their far edge below the waterline.
    //  2. Measuring against the centre halves the apparent tilt. A site
    //     sloping uniformly, +5 m on one side and -5 m on the other, scores 5
    //     against a budget it should be failing at 10 — the ground across the
    //     footprint actually spans 10 m.
    //  3. `MIN_HEIGHT` was a centre-only test, so a site could pass with its
    //     rim in the sea.
    //
    // Now: sample a disc (centre plus three rings out to the full radius) and
    // judge on the true SPREAD, max minus min. Also require the LOWEST sample
    // to clear the sand line, so no part of the footprint is underwater.
    // Sampled outermost ring FIRST and abandoned the moment the site is
    // disqualified. Most candidates fail, and the rim is where they fail — so
    // checking it first, and bailing on the first bad sample, turns a 25-sample
    // test into a 2-3 sample one for the common case. Without this, raising
    // the candidate count to 40 made every settlement-cell lookup ~14x more
    // expensive and showed up as a 20% regression in terrain chunk build.
    const budget = MAX_SITE_SPREAD[kind];
    let lo = h, hi = h, ok = true;
    for (let ri = RING_FRACTIONS.length - 1; ri >= 0 && ok; ri--) {
      const rf = RING_FRACTIONS[ri];
      for (let k = 0; k < RING_SAMPLES; k++) {
        // Offset alternate rings by half a step so the samples do not all fall
        // along the same spokes and miss a ridge between them.
        const a = ((k + (ri & 1) * 0.5) / RING_SAMPLES) * Math.PI * 2;
        const px = x + Math.cos(a) * radius * rf;
        const pz = z + Math.sin(a) * radius * rf;
        const hr = heightAt(px, pz);
        if (hr < lo) lo = hr;
        if (hr > hi) hi = hr;
        // No part of the footprint in the sea, and the spread stays in budget.
        if (lo < MIN_HEIGHT || hi - lo > budget) { ok = false; break; }
        // …and no part of it on a river. Tested at exactly the same points as
        // the flatness disc — the rings reach the full radius and the widest
        // angular gap on the outermost one is 30 m on a castle, against a river
        // band ~140 m across, so a channel cannot hide between two samples.
        // Sampled AFTER the height budget because `heightAt` has already been
        // paid for at this point and most candidates die on flatness first.
        // The predicate is `> 0`, the same one `nearFreshWater()` drinks on
        // rather than the map's 0.45 — matching the loosest reader is what
        // makes "inside a settlement footprint" and "drinkable" disjoint by
        // construction instead of by coincidence.
        if (riverFactor(px, pz) > 0) { ok = false; break; }
      }
    }
    if (!ok) continue;
    // Keep clear of this cell's dungeon entrance arch.
    if (entrance !== null &&
        Math.hypot(x - entrance.x, z - entrance.z) < radius + ENTRANCE_CLEARANCE) {
      continue;
    }
    return { kind, x, y: h, z, radius, seed: mix32(seed ^ SALT, scz, scx) };
  }
  return null;
}
