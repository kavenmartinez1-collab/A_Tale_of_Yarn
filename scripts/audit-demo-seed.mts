/**
 * Demo-seed content audit — reports where every integrated feature can be
 * found in the shipped world (seed 1337, spawn at (32, 32)).
 * Run: npx tsx scripts/audit-demo-seed.mts
 *
 * Pure read-only report; no goldens, no pass/fail (exit 0 always unless a
 * feature is entirely absent within the scan radius, then exit 1).
 */

import { createHeightField, SEA_LEVEL } from '../src/game/noise';
import { createBiomeField, type Biome } from '../src/game/biome';
import {
  settlementSiteAt, SCELL, type SettlementKind, type SettlementSite,
} from '../src/game/settlement/settlement-scatter';
import { resolveSettlement } from '../src/game/settlement/settlement-layout';
import { entitiesForCell } from '../src/game/entities/entity-scatter';
import { ECELL, type Species } from '../src/game/entities/entity-types';
import { nestsForCell, type NestKind } from '../src/game/entities/nest-scatter';

const SEED = 1337;
const SPAWN_X = 32;
const SPAWN_Z = 32;

const hf = createHeightField(SEED);
const bf = createBiomeField(SEED, hf);
const heightAt = (x: number, z: number) => hf.heightAt(x, z);
const biomeAt = (x: number, z: number) => bf.biomeAt(x, z);

const dist = (x: number, z: number) =>
  Math.hypot(x - SPAWN_X, z - SPAWN_Z);
const fmt = (x: number, z: number) =>
  `(${Math.round(x)}, ${Math.round(z)}) — ${Math.round(dist(x, z))} m`;

let missing = 0;

// ---------------------------------------------------------------------------
// Spiral cell order helper (nearest cells first)
// ---------------------------------------------------------------------------

function* spiralCells(maxR: number): Generator<[number, number]> {
  yield [0, 0];
  for (let r = 1; r <= maxR; r++) {
    for (let cx = -r; cx <= r; cx++) {
      for (let cz = -r; cz <= r; cz++) {
        if (Math.max(Math.abs(cx), Math.abs(cz)) === r) yield [cx, cz];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Biomes — nearest sample of each
// ---------------------------------------------------------------------------

console.log('=== Biomes (nearest sample, 32 m grid, radius 6 km) ===');
{
  const found = new Map<Biome, [number, number]>();
  const all: Biome[] = ['ocean', 'beach', 'desert', 'plains', 'forest',
    'dense_forest', 'jungle', 'mountain_forest', 'alpine'];
  // Ring sweep out from spawn so first hit is nearest.
  outer:
  for (let r = 0; r <= 6000; r += 32) {
    const steps = Math.max(1, Math.floor((2 * Math.PI * r) / 32));
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      const x = SPAWN_X + Math.cos(a) * r;
      const z = SPAWN_Z + Math.sin(a) * r;
      const b = biomeAt(x, z);
      if (!found.has(b)) {
        found.set(b, [x, z]);
        if (found.size === all.length) break outer;
      }
    }
  }
  for (const b of all) {
    const p = found.get(b);
    if (p) console.log(`  ${b.padEnd(16)} ${fmt(p[0], p[1])}`);
    else { console.log(`  ${b.padEnd(16)} NOT FOUND within 6 km`); missing++; }
  }
}

// ---------------------------------------------------------------------------
// 2. Fresh water (river or sub-sea non-ocean-biome) — nearest
// ---------------------------------------------------------------------------

console.log('=== Fresh water ===');
{
  let river: [number, number] | null = null;
  let pond: [number, number] | null = null;
  for (let r = 0; r <= 6000 && (river === null || pond === null); r += 24) {
    const steps = Math.max(1, Math.floor((2 * Math.PI * r) / 24));
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      const x = SPAWN_X + Math.cos(a) * r;
      const z = SPAWN_Z + Math.sin(a) * r;
      const b = biomeAt(x, z);
      if (b === 'ocean' || b === 'beach') continue;
      // Same condition the in-game drink check uses: any positive river carve.
      if (river === null && hf.riverFactor(x, z) > 0) river = [x, z];
      if (pond === null && heightAt(x, z) < SEA_LEVEL) pond = [x, z];
    }
  }
  if (river) console.log(`  river water     ${fmt(river[0], river[1])}`);
  else { console.log('  river water     NOT FOUND within 6 km'); missing++; }
  if (pond) console.log(`  inland sub-sea  ${fmt(pond[0], pond[1])}`);
  else console.log('  inland sub-sea  none within 6 km (rivers are the fresh source)');
}

// ---------------------------------------------------------------------------
// 3. Settlements — nearest of each kind (radius 20 cells ≈ 10 km)
// ---------------------------------------------------------------------------

console.log('=== Settlements (nearest of each kind, radius ~10 km) ===');
{
  const kinds: SettlementKind[] = ['ruins', 'ranch', 'village', 'town', 'castle'];
  const best = new Map<SettlementKind, SettlementSite>();
  const spawnCx = Math.floor(SPAWN_X / SCELL);
  const spawnCz = Math.floor(SPAWN_Z / SCELL);
  for (const [dx, dz] of spiralCells(20)) {
    const site = settlementSiteAt(SEED, spawnCx + dx, spawnCz + dz, heightAt);
    if (site === null) continue;
    const cur = best.get(site.kind);
    if (!cur || dist(site.x, site.z) < dist(cur.x, cur.z)) best.set(site.kind, site);
  }
  for (const kind of kinds) {
    const s = best.get(kind);
    if (!s) { console.log(`  ${kind.padEnd(8)} NOT FOUND within 10 km`); missing++; continue; }
    const resolved = resolveSettlement(s, heightAt);
    const padTypes = new Set(resolved.pads.map((p) => p.type));
    console.log(`  ${kind.padEnd(8)} "${resolved.name}" ${fmt(s.x, s.z)}`
      + `  pads: ${[...padTypes].join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// 4. Rare creatures — nearest spawn of dragon / griffin / sea_serpent
// ---------------------------------------------------------------------------

console.log('=== Creatures (nearest spawn per species, radius ~10 km) ===');
{
  const wanted: Species[] = ['rabbit', 'deer', 'bird', 'horse', 'cow', 'donkey',
    'dragon', 'griffin', 'sea_serpent'];
  const best = new Map<Species, [number, number]>();
  const spawnCx = Math.floor(SPAWN_X / ECELL);
  const spawnCz = Math.floor(SPAWN_Z / ECELL);
  for (const [dx, dz] of spiralCells(20)) {
    if (best.size === wanted.length) break;
    const spawns = entitiesForCell(SEED, spawnCx + dx, spawnCz + dz, heightAt, biomeAt);
    for (const sp of spawns) {
      const cur = best.get(sp.species);
      if (!cur || dist(sp.x, sp.z) < dist(cur[0], cur[1])) {
        best.set(sp.species, [sp.x, sp.z]);
      }
    }
  }
  for (const s of wanted) {
    const p = best.get(s);
    if (p) console.log(`  ${s.padEnd(12)} ${fmt(p[0], p[1])}`);
    else { console.log(`  ${s.padEnd(12)} NOT FOUND within 10 km`); missing++; }
  }
}

// ---------------------------------------------------------------------------
// 5. Egg nests — nearest of each kind
// ---------------------------------------------------------------------------

console.log('=== Egg nests (nearest per kind, radius ~10 km) ===');
{
  const kinds: NestKind[] = ['bird', 'dragon', 'griffin'];
  const best = new Map<NestKind, [number, number]>();
  const spawnCx = Math.floor(SPAWN_X / ECELL);
  const spawnCz = Math.floor(SPAWN_Z / ECELL);
  for (const [dx, dz] of spiralCells(20)) {
    if (best.size === kinds.length) break;
    for (const n of nestsForCell(SEED, spawnCx + dx, spawnCz + dz, heightAt, biomeAt)) {
      const cur = best.get(n.kind);
      if (!cur || dist(n.x, n.z) < dist(cur[0], cur[1])) best.set(n.kind, [n.x, n.z]);
    }
  }
  for (const k of kinds) {
    const p = best.get(k);
    if (p) console.log(`  ${k.padEnd(8)} ${fmt(p[0], p[1])}`);
    else { console.log(`  ${k.padEnd(8)} NOT FOUND within 10 km`); missing++; }
  }
}

// ---------------------------------------------------------------------------

console.log(missing === 0
  ? 'ALL features present in demo seed.'
  : `${missing} feature(s) missing within scan radius.`);
process.exit(missing === 0 ? 0 : 1);
