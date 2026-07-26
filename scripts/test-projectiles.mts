/**
 * Tests for src/game/projectiles.ts + src/game/projectile-mesh.ts.
 * Run: npx tsx scripts/test-projectiles.mts
 *
 * Covers: pooling (no growth, reuse, eviction order), ballistics, terrain
 * planting, sticking to a moving body, expiry, and — the point of the whole
 * exercise — that a flying arrow actually produces visible geometry, oriented
 * along its flight, inside the buffer budget.
 */

import {
  createProjectilePool, spawnProjectile, stepProjectiles, followAnchors,
  releaseProjectile, inFlightCount, activeCount, orientToVelocity,
  PROJECTILE_CAPACITY, PROJECTILE_GRAVITY, ARROW_MAX_AGE_S,
  STUCK_BODY_S, STUCK_GROUND_S,
  type Projectile, type ProjectileHit,
} from '../src/game/projectiles';
import {
  buildProjectileMesh, buildArrow, projectileMeshFloats,
  PROJECTILE_MAX_VERTS, PROJECTILE_FLOATS_PER_VERT, ARROW_LEN,
} from '../src/game/projectile-mesh';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const FLAT = () => 0;
const NO_HIT = () => null;

/** Fire an arrow horizontally at 28 m/s from (0, 10, 0) toward -Z. */
function fireFlat(pool: ReturnType<typeof createProjectilePool>, nowS = 0): Projectile {
  return spawnProjectile(pool, {
    kind: 'arrow', x: 0, y: 10, z: 0, vx: 0, vy: 0, vz: -28,
    damage: 6, nowS,
  });
}

// ---------------------------------------------------------------------------
// 1. Pooling — fixed storage, reuse, no allocation growth
// ---------------------------------------------------------------------------
{
  const pool = createProjectilePool(8);
  check('pool pre-allocates its slots', pool.slots.length === 8);
  check('pool starts empty', activeCount(pool) === 0 && inFlightCount(pool) === 0);

  const a = fireFlat(pool);
  check('spawn activates a slot', a.active && activeCount(pool) === 1);
  check('slot array never grows', pool.slots.length === 8);

  releaseProjectile(a);
  check('release frees the slot', activeCount(pool) === 0);
  const b = fireFlat(pool);
  check('the freed slot is reused (same object identity)', b === a);
  check('slot array still 8 after reuse', pool.slots.length === 8);

  // Fill it completely, then overflow.
  for (let i = 0; i < 8; i++) fireFlat(pool, i);
  check('pool fills to capacity', activeCount(pool) === 8);
  const overflow = fireFlat(pool, 99);
  check('an overflowing shot still fires (never silently dropped)',
    overflow.active && activeCount(pool) === 8);
  check('the pool did not grow to accommodate it', pool.slots.length === 8);
}

// ---------------------------------------------------------------------------
// 2. Eviction prefers stuck scenery over a projectile still in flight
// ---------------------------------------------------------------------------
{
  const pool = createProjectilePool(3);
  const oldFlying = fireFlat(pool, 0);
  const newerFlying = fireFlat(pool, 1);
  const stuck = fireFlat(pool, 2);
  // Make the third one scenery.
  stepProjectiles(pool, 0.016, 3, {
    heightAt: () => 1e9, // ground above it → plants immediately
    resolveHit: NO_HIT,
  });
  check('a grounded arrow becomes stuck scenery', stuck.stuck && stuck.active);
  check('the two flying arrows also planted (flat ground test)',
    oldFlying.stuck && newerFlying.stuck);

  // Now with a mix: one flying, two stuck. The oldest STUCK must go first.
  const pool2 = createProjectilePool(2);
  const flying = spawnProjectile(pool2, {
    kind: 'arrow', x: 0, y: 100, z: 0, vx: 0, vy: 0, vz: -28, damage: 6, nowS: 0,
  });
  const scenery = spawnProjectile(pool2, {
    kind: 'arrow', x: 5, y: 0.1, z: 0, vx: 0, vy: -1, vz: 0, damage: 6, nowS: 1,
  });
  stepProjectiles(pool2, 0.5, 2, { heightAt: (x) => (x > 1 ? 0.2 : -1000), resolveHit: NO_HIT });
  check('setup: one flying, one stuck',
    !flying.stuck && scenery.stuck, `flying=${flying.stuck} scenery=${scenery.stuck}`);
  spawnProjectile(pool2, {
    kind: 'arrow', x: 0, y: 100, z: 0, vx: 0, vy: 0, vz: -28, damage: 6, nowS: 3,
  });
  check('eviction takes the stuck one, not the one in flight',
    flying.active && !flying.stuck, 'a projectile mid-flight was recycled');
}

// ---------------------------------------------------------------------------
// 3. Ballistics — gravity, drop, and the arc actually being an arc
// ---------------------------------------------------------------------------
{
  const pool = createProjectilePool(4);
  const p = fireFlat(pool);
  const dt = 1 / 60;
  let t = 0;
  const zs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < 30; i++) {
    t += dt;
    stepProjectiles(pool, dt, t, { heightAt: () => -1000, resolveHit: NO_HIT });
    zs.push(p.z); ys.push(p.y);
  }
  check('the arrow travels forward', p.z < -10, `z=${p.z.toFixed(2)}`);
  check('the arrow drops under gravity', p.y < 10, `y=${p.y.toFixed(3)}`);
  // Drop after 0.5 s should be about ½gt² = 1.225 m (Euler overshoots slightly).
  const expectedDrop = 0.5 * PROJECTILE_GRAVITY * t * t;
  check('drop matches ½gt² within Euler error',
    Math.abs((10 - p.y) - expectedDrop) < expectedDrop * 0.15,
    `drop=${(10 - p.y).toFixed(3)} expected=${expectedDrop.toFixed(3)}`);
  // Each successive frame must drop MORE than the last — that is what makes it
  // an arc rather than a straight line with a constant tilt.
  const d1 = ys[1] - ys[2];
  const d2 = ys[27] - ys[28];
  check('the fall accelerates (a real arc, not a sloped line)', d2 > d1 * 1.5,
    `early=${d1.toFixed(4)} late=${d2.toFixed(4)}`);
  check('forward speed is unaffected by gravity',
    Math.abs((zs[1] - zs[0]) - (zs[28] - zs[27])) < 1e-6);

  // The shaft must tip downward as it falls — an arrow that stays level is the
  // giveaway that orientation is not tracking velocity.
  check('the shaft pitches down as the arrow falls', p.dy < -0.05,
    `dy=${p.dy.toFixed(4)}`);
  check('the direction stays a unit vector',
    Math.abs(Math.hypot(p.dx, p.dy, p.dz) - 1) < 1e-6);
}

// ---------------------------------------------------------------------------
// 4. Terrain: a miss plants in the ground and stays as scenery
// ---------------------------------------------------------------------------
{
  const pool = createProjectilePool(4);
  const p = spawnProjectile(pool, {
    kind: 'arrow', x: 0, y: 2, z: 0, vx: 0, vy: -5, vz: -10, damage: 6, nowS: 0,
  });
  stepProjectiles(pool, 0.5, 0.5, { heightAt: FLAT, resolveHit: NO_HIT });
  check('a missed arrow plants in the ground', p.stuck && p.active);
  check('it plants AT the surface, not under it', Math.abs(p.y - 0) < 1e-6,
    `y=${p.y}`);
  check('it has no anchor (it is in the dirt, not in a body)', p.anchorId === null);
  check('it keeps the angle it arrived at', p.dy < 0 && p.dz < 0);
  check('it stops moving', p.vx === 0 && p.vy === 0 && p.vz === 0);
  check('it is no longer counted as in flight', inFlightCount(pool) === 0);
  check('...but is still counted as active scenery', activeCount(pool) === 1);

  // Ground arrows last a long time, then go.
  stepProjectiles(pool, 0.1, 0.5 + STUCK_GROUND_S - 1, { heightAt: FLAT, resolveHit: NO_HIT });
  check('it is still there well before its expiry', p.active);
  stepProjectiles(pool, 0.1, 0.5 + STUCK_GROUND_S + 0.1, { heightAt: FLAT, resolveHit: NO_HIT });
  check('it is cleaned up after STUCK_GROUND_S', !p.active);
}

// ---------------------------------------------------------------------------
// 5. A stone does NOT stick — it is a rock, it lands and is gone
// ---------------------------------------------------------------------------
{
  const pool = createProjectilePool(4);
  const s = spawnProjectile(pool, {
    kind: 'stone', x: 0, y: 2, z: 0, vx: 0, vy: -5, vz: 0, damage: 2, nowS: 0,
  });
  stepProjectiles(pool, 0.5, 0.5, { heightAt: FLAT, resolveHit: NO_HIT });
  check('a stone that lands is released, not planted', !s.active && !s.stuck);
}

// ---------------------------------------------------------------------------
// 6. Sticking into a body, and riding it as it moves
// ---------------------------------------------------------------------------
{
  const pool = createProjectilePool(4);
  const deer = { id: 'deer-1', x: 0, y: 5, z: -10 };
  const p = spawnProjectile(pool, {
    kind: 'arrow', x: 0, y: 6, z: -9.6, vx: 0, vy: 0, vz: -28, damage: 6, nowS: 0,
  });
  const hit: ProjectileHit = {
    anchorId: deer.id, anchorX: deer.x, anchorY: deer.y, anchorZ: deer.z,
  };
  stepProjectiles(pool, 1 / 60, 0.017, { heightAt: () => -1000, resolveHit: () => hit });
  check('an arrow that hits a body sticks in it', p.stuck && p.anchorId === 'deer-1');
  const relY = p.ay;
  check('the offset from the body is captured', Math.abs(relY - 1) < 0.01,
    `ay=${p.ay}`);

  // Move the deer; the arrow must go with it.
  deer.x += 12; deer.z -= 7; deer.y += 0.5;
  followAnchors(pool, (id) => (id === deer.id ? deer : null));
  check('the arrow rides the animal it hit',
    Math.abs(p.x - (deer.x + p.ax)) < 1e-9
    && Math.abs(p.y - (deer.y + p.ay)) < 1e-9
    && Math.abs(p.z - (deer.z + p.az)) < 1e-9);
  check('...and is actually somewhere new', p.x > 11);

  // The corpse gets looted away: the arrow must not hang in mid-air.
  followAnchors(pool, () => null);
  check('an arrow whose anchor is gone is released too', !p.active);

  // Body arrows expire sooner than ground arrows.
  const p2 = spawnProjectile(pool, {
    kind: 'arrow', x: 0, y: 6, z: 0, vx: 0, vy: 0, vz: -28, damage: 6, nowS: 100,
  });
  stepProjectiles(pool, 1 / 60, 100.017, {
    heightAt: () => -1000,
    resolveHit: () => ({ anchorId: 'x', anchorX: 0, anchorY: 0, anchorZ: 0 }),
  });
  check('body arrows expire sooner than ground arrows', STUCK_BODY_S < STUCK_GROUND_S);
  stepProjectiles(pool, 0.1, 100.017 + STUCK_BODY_S + 0.1, {
    heightAt: () => -1000, resolveHit: NO_HIT,
  });
  check('a body arrow falls away after STUCK_BODY_S', !p2.active);
}

// ---------------------------------------------------------------------------
// 7. Max age — an arrow fired at the sky does not live forever
// ---------------------------------------------------------------------------
{
  const pool = createProjectilePool(4);
  const p = spawnProjectile(pool, {
    kind: 'arrow', x: 0, y: 0, z: 0, vx: 0, vy: 400, vz: 0, damage: 6, nowS: 0,
  });
  stepProjectiles(pool, 0.1, ARROW_MAX_AGE_S - 0.5, { heightAt: () => -1e9, resolveHit: NO_HIT });
  check('still alive before max age', p.active);
  stepProjectiles(pool, 0.1, ARROW_MAX_AGE_S + 0.1, { heightAt: () => -1e9, resolveHit: NO_HIT });
  check('retired after max age', !p.active);
}

// ---------------------------------------------------------------------------
// 8. THE POINT: a flying arrow produces visible, correctly-oriented geometry
// ---------------------------------------------------------------------------
{
  const pool = createProjectilePool(PROJECTILE_CAPACITY);
  const scratch = new Float32Array(projectileMeshFloats(PROJECTILE_CAPACITY));

  check('an empty pool draws nothing', buildProjectileMesh(pool, scratch) === 0);

  const p = fireFlat(pool);
  const n = buildProjectileMesh(pool, scratch);
  check('one arrow in flight produces geometry', n > 0, `verts=${n}`);
  check('an arrow is exactly PROJECTILE_MAX_VERTS', n === PROJECTILE_MAX_VERTS,
    `verts=${n}`);
  check('the vertex count is whole triangles', n % 3 === 0);

  // The geometry must be AT the arrow and ALONG its flight.
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < n * PROJECTILE_FLOATS_PER_VERT; i += PROJECTILE_FLOATS_PER_VERT) {
    minX = Math.min(minX, scratch[i]); maxX = Math.max(maxX, scratch[i]);
    minY = Math.min(minY, scratch[i + 1]); maxY = Math.max(maxY, scratch[i + 1]);
    minZ = Math.min(minZ, scratch[i + 2]); maxZ = Math.max(maxZ, scratch[i + 2]);
  }
  check('the mesh is centred on the projectile',
    Math.abs((minX + maxX) / 2 - p.x) < 0.05
    && Math.abs((minY + maxY) / 2 - p.y) < 0.05
    && Math.abs((minZ + maxZ) / 2 - p.z) < 0.05,
    `centre=(${((minX + maxX) / 2).toFixed(2)},${((minY + maxY) / 2).toFixed(2)},` +
    `${((minZ + maxZ) / 2).toFixed(2)}) p=(${p.x},${p.y},${p.z})`);
  check('the arrow is LONG along its flight axis (-Z)',
    (maxZ - minZ) > ARROW_LEN * 0.9, `zSpan=${(maxZ - minZ).toFixed(3)}`);
  check('...and thin across it',
    (maxX - minX) < 0.2 && (maxY - minY) < 0.2,
    `x=${(maxX - minX).toFixed(3)} y=${(maxY - minY).toFixed(3)}`);
  check('the arrow is longer than one frame of travel at 28 m/s (no strobing)',
    ARROW_LEN > 28 / 60);

  // Fire one straight up: the singular case for a yaw/pitch representation.
  const pool2 = createProjectilePool(4);
  const up = spawnProjectile(pool2, {
    kind: 'arrow', x: 3, y: 1, z: -2, vx: 0, vy: 40, vz: 0, damage: 6, nowS: 0,
  });
  const n2 = buildProjectileMesh(pool2, scratch);
  check('a vertical arrow builds without degenerating', n2 === PROJECTILE_MAX_VERTS);
  let vMinY = Infinity, vMaxY = -Infinity, vMinX = Infinity, vMaxX = -Infinity;
  let bad = false;
  for (let i = 0; i < n2 * PROJECTILE_FLOATS_PER_VERT; i += PROJECTILE_FLOATS_PER_VERT) {
    vMinY = Math.min(vMinY, scratch[i + 1]); vMaxY = Math.max(vMaxY, scratch[i + 1]);
    vMinX = Math.min(vMinX, scratch[i]); vMaxX = Math.max(vMaxX, scratch[i]);
    for (let k = 0; k < 6; k++) if (!Number.isFinite(scratch[i + k])) bad = true;
  }
  check('no NaN/Infinity in a vertical arrow', !bad);
  check('a vertical arrow is long in Y', (vMaxY - vMinY) > ARROW_LEN * 0.9,
    `ySpan=${(vMaxY - vMinY).toFixed(3)}`);
  check('...and thin in X', (vMaxX - vMinX) < 0.2);
  check('unused direction still points along the velocity', up.dy > 0.99);

  // Every normal must be unit length — a zero normal renders black.
  {
    const pool3 = createProjectilePool(4);
    let worst = 0;
    for (const dir of [
      [0, 0, -1], [1, 0, 0], [0, 1, 0], [0, -1, 0],
      [0.577, 0.577, 0.577], [-0.267, 0.535, -0.802],
    ]) {
      pool3.slots.forEach(releaseProjectile);
      spawnProjectile(pool3, {
        kind: 'arrow', x: 0, y: 0, z: 0,
        vx: dir[0] * 30, vy: dir[1] * 30, vz: dir[2] * 30, damage: 6, nowS: 0,
      });
      const cnt = buildProjectileMesh(pool3, scratch);
      for (let i = 0; i < cnt * PROJECTILE_FLOATS_PER_VERT; i += PROJECTILE_FLOATS_PER_VERT) {
        const len = Math.hypot(scratch[i + 3], scratch[i + 4], scratch[i + 5]);
        worst = Math.max(worst, Math.abs(len - 1));
      }
    }
    check('every normal is unit length at every flight angle', worst < 1e-4,
      `worst deviation=${worst}`);
  }
}

// ---------------------------------------------------------------------------
// 9. Buffer safety — a completely full pool must not overrun its allocation
// ---------------------------------------------------------------------------
{
  const pool = createProjectilePool(PROJECTILE_CAPACITY);
  for (let i = 0; i < PROJECTILE_CAPACITY; i++) {
    spawnProjectile(pool, {
      kind: 'arrow', x: i, y: 10, z: 0, vx: 1, vy: 0, vz: -28, damage: 6, nowS: 0,
    });
  }
  const scratch = new Float32Array(projectileMeshFloats(PROJECTILE_CAPACITY));
  const n = buildProjectileMesh(pool, scratch);
  check('a full pool fits its buffer exactly',
    n * PROJECTILE_FLOATS_PER_VERT <= scratch.length,
    `floats=${n * PROJECTILE_FLOATS_PER_VERT} cap=${scratch.length}`);
  check('a full pool draws every arrow', n === PROJECTILE_CAPACITY * PROJECTILE_MAX_VERTS);

  // An UNDERSIZED buffer must be refused, not overrun — an overrun here turns
  // the whole frame black (see CHARACTER_MAX_VERTS's history).
  const tiny = new Float32Array(PROJECTILE_MAX_VERTS * PROJECTILE_FLOATS_PER_VERT * 4);
  const nTiny = buildProjectileMesh(pool, tiny);
  check('an undersized buffer is not overrun',
    nTiny * PROJECTILE_FLOATS_PER_VERT <= tiny.length,
    `wrote=${nTiny * PROJECTILE_FLOATS_PER_VERT} cap=${tiny.length}`);
  check('...and it still drew something', nTiny > 0);

  // Distance culling keeps a distant pool off the GPU.
  const near = buildProjectileMesh(pool, scratch, 1000, 0, 50);
  check('projectiles beyond the view distance are culled', near === 0);
}

// ---------------------------------------------------------------------------
// 10. Direct buildArrow contract (offset arithmetic)
// ---------------------------------------------------------------------------
{
  const buf = new Float32Array(PROJECTILE_MAX_VERTS * PROJECTILE_FLOATS_PER_VERT * 2);
  const after1 = buildArrow(buf, 0, 0, 0, 0, 0, 0, -1);
  check('buildArrow writes exactly PROJECTILE_MAX_VERTS',
    after1 === PROJECTILE_MAX_VERTS * PROJECTILE_FLOATS_PER_VERT, `o=${after1}`);
  const after2 = buildArrow(buf, after1, 5, 0, 0, 1, 0, 0);
  check('buildArrow appends at the given offset',
    after2 === after1 * 2, `o=${after2}`);
  check('the second arrow is where it was asked to be',
    Math.abs(buf[after1] - 5) < ARROW_LEN);
}

// ---------------------------------------------------------------------------
// 11. orientToVelocity leaves a stalled projectile's angle alone
// ---------------------------------------------------------------------------
{
  const pool = createProjectilePool(2);
  const p = spawnProjectile(pool, {
    kind: 'arrow', x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: -28, damage: 6, nowS: 0,
  });
  const before = { dx: p.dx, dy: p.dy, dz: p.dz };
  p.vx = 0; p.vy = 0; p.vz = 0;
  orientToVelocity(p);
  check('a stalled projectile keeps its last heading',
    p.dx === before.dx && p.dy === before.dy && p.dz === before.dz);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
