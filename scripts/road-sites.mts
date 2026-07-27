/**
 * Picks camera sites for the road screenshots straight out of the road graph,
 * so the harness photographs roads that provably exist rather than coordinates
 * someone guessed. Writes scripts/road-sites.json.
 *
 *   npx tsx scripts/road-sites.mts
 *
 * Every site is placed ON a road polyline and looks ALONG it, and every site
 * carries a `verify` list of (x, z, expected mask) probes. The harness prints
 * those, so a shot that framed empty grass is visible in the report instead of
 * being taken on trust — the first version of this script aimed at a castle's
 * gate axis on the assumption the road ran down it, and photographed a hillside
 * 33 m from the nearest paving.
 */

import fs from 'node:fs';
import { createHeightField } from '../src/game/noise';
import { createRoadNetwork, type RoadEdge } from '../src/game/world/roads';

const WORLD_SEED = 1337;
const base = createHeightField(WORLD_SEED);
const roads = createRoadNetwork(WORLD_SEED, base);

// Near spawn first: the forced castle at (-219, -346) is where a player starts.
const g = roads.graphIn(-4000, -4000, 4000, 4000);

interface Site {
  name: string;
  at: [number, number];
  look: [number, number];
  note: string;
  /** [x, z, expectedMask] probes the harness reports back. */
  verify: [number, number, number][];
}
const sites: Site[] = [];

const dist = (ax: number, az: number, bx: number, bz: number): number =>
  Math.hypot(ax - bx, az - bz);

/** Point on `e` at arc length `s` from the `a` end, plus the tangent there. */
function along(e: RoadEdge, s: number): { x: number; z: number; tx: number; tz: number } {
  let acc = 0;
  for (let i = 3; i < e.pts.length; i += 3) {
    const x0 = e.pts[i - 3];
    const z0 = e.pts[i - 2];
    const x1 = e.pts[i];
    const z1 = e.pts[i + 1];
    const L = Math.hypot(x1 - x0, z1 - z0);
    if (acc + L >= s || i + 3 >= e.pts.length) {
      const t = L > 0 ? Math.min(1, (s - acc) / L) : 0;
      return { x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t, tx: (x1 - x0) / (L || 1), tz: (z1 - z0) / (L || 1) };
    }
    acc += L;
  }
  return { x: e.pts[0], z: e.pts[1], tx: 1, tz: 0 };
}

function edgeLength(e: RoadEdge): number {
  let L = 0;
  for (let i = 3; i < e.pts.length; i += 3) {
    L += Math.hypot(e.pts[i] - e.pts[i - 3], e.pts[i + 1] - e.pts[i - 2]);
  }
  return L;
}

/** Probe the mask at the site and a few metres along the view direction. */
function probes(x: number, z: number, dx: number, dz: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const d of [0, 10, 25, 45]) {
    const px = x + dx * d;
    const pz = z + dz * d;
    out.push([Number(px.toFixed(1)), Number(pz.toFixed(1)),
      Number(roads.maskAt(px, pz).toFixed(3))]);
  }
  return out;
}

function push(name: string, x: number, z: number, dx: number, dz: number, note: string): void {
  const n = Math.hypot(dx, dz) || 1;
  sites.push({
    name,
    at: [Number(x.toFixed(1)), Number(z.toFixed(1))],
    look: [Number((x + (dx / n) * 60).toFixed(1)), Number((z + (dz / n) * 60).toFixed(1))],
    note,
    verify: probes(x, z, dx / n, dz / n),
  });
}

// --- 1. castle gates, nearest to spawn first ------------------------------
// Stand ON the approach road and look back at the castle, so the shot shows the
// road running out of the gate rather than a wall from an arbitrary angle.
const castles = g.nodes
  .filter((n) => n.kind === 'castle')
  .sort((p, q) => dist(p.x, p.z, 0, 0) - dist(q.x, q.z, 0, 0));

let gateShots = 0;
for (const c of castles) {
  if (gateShots >= 3) break;
  // The approach edge is the one that ends at this castle and is not the gate
  // stub (whose two ends are both the castle).
  const app = g.edges
    .filter((e) => e.a !== e.b && (e.a === c.id || e.b === c.id))
    .sort((p, q) => edgeLength(q) - edgeLength(p))[0];
  if (app === undefined) continue;
  // Orient so index 0 is the castle end.
  const fromCastle: RoadEdge = app.b === c.id
    ? { ...app, pts: reverse(app.pts), a: app.b, b: app.a }
    : app;
  const L = edgeLength(fromCastle);
  const p = along(fromCastle, Math.min(80, L * 0.5));
  // Look back down the road toward the castle.
  push(`castle-gate-${gateShots}`, p.x, p.z, -p.tx, -p.tz,
    `looking down the approach road into the gate of the castle at `
    + `(${(c.x).toFixed(0)}, ${(c.z + 58).toFixed(0)})`);
  gateShots++;
}

function reverse(pts: Float32Array): Float32Array {
  const n = pts.length / 3;
  const out = new Float32Array(pts.length);
  for (let i = 0; i < n; i++) {
    const s = (n - 1 - i) * 3;
    out[i * 3] = pts[s];
    out[i * 3 + 1] = pts[s + 1];
    out[i * 3 + 2] = pts[s + 2];
  }
  return out;
}

// --- 2. wilderness forks --------------------------------------------------
// A junction is a fork the terrain chose. Rank by distance from any settlement
// so we photograph a fork in genuinely open ground.
const places = g.nodes.filter((n) => n.kind !== 'junction');
const junctions = g.nodes
  .filter((n) => n.kind === 'junction')
  .map((j) => {
    let nearest = Infinity;
    for (const p of places) nearest = Math.min(nearest, dist(j.x, j.z, p.x, p.z));
    return { j, nearest };
  })
  .sort((p, q) => q.nearest - p.nearest);

let forkShots = 0;
for (const { j, nearest } of junctions) {
  if (forkShots >= 3) break;
  // Approach the junction along one of its branches so both other branches are
  // in frame, diverging away from the camera.
  const branch = g.edges.find((e) => e.a === j.id && e.a !== e.b);
  if (branch === undefined) continue;
  const p = along(branch, Math.min(40, edgeLength(branch) * 0.6));
  push(`fork-${forkShots}`, p.x, p.z, j.x - p.x, j.z - p.z,
    `wilderness fork, nearest settlement ${nearest.toFixed(0)} m`);
  forkShots++;
}

// --- 3. roads across varied terrain --------------------------------------
const relief = g.edges
  .filter((e) => e.a !== e.b && e.pts.length >= 30)
  .map((e) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 2; i < e.pts.length; i += 3) {
      lo = Math.min(lo, e.pts[i]);
      hi = Math.max(hi, e.pts[i]);
    }
    return { e, relief: hi - lo };
  })
  .sort((p, q) => q.relief - p.relief);

for (const [i, { e, relief: r }] of relief.slice(0, 3).entries()) {
  const p = along(e, edgeLength(e) * 0.45);
  push(`terrain-${i}`, p.x, p.z, p.tx, p.tz, `road over ${r.toFixed(0)} m of relief`);
}

// --- 4. the flattest stretch there is, for the surface itself -------------
const gentle = relief[relief.length - 1];
if (gentle !== undefined) {
  const p = along(gentle.e, edgeLength(gentle.e) * 0.4);
  push('surface', p.x, p.z, p.tx, p.tz,
    'gentle stretch — look at the paving, the verge and the grass edge');
}

fs.writeFileSync('scripts/road-sites.json', JSON.stringify(sites, null, 1), 'utf-8');
console.log(`${sites.length} sites → scripts/road-sites.json`);
for (const s of sites) {
  const masks = s.verify.map((v) => v[2].toFixed(2)).join(' ');
  console.log(`  ${s.name.padEnd(16)} at ${s.at.join(',').padEnd(18)} `
    + `mask@0/10/25/45m: ${masks}   ${s.note}`);
}
const bad = sites.filter((s) => s.verify[0][2] < 0.5);
if (bad.length > 0) {
  console.error(`\n${bad.length} site(s) are NOT on paved ground: `
    + bad.map((s) => s.name).join(', '));
  process.exit(1);
}
