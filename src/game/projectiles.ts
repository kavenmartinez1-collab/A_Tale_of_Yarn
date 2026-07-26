/**
 * Projectiles — pooled ballistic objects (arrows, thrown stones).
 *
 * Pure module: no DOM, no GPU, node-testable. The caller supplies terrain
 * height and hit resolution; this file owns storage, integration and the
 * stuck-in-something lifecycle.
 *
 * WHY A POOL. Arrows used to be plain objects pushed into an array and spliced
 * out on impact. That allocates one object per shot and leaves the garbage
 * collector to clean up mid-fight, which is exactly when a frame can least
 * afford it. Slots here are allocated once at construction and reused; a full
 * pool evicts the oldest *stuck* projectile rather than refusing the shot,
 * because a shot that silently does nothing is a bug the player can see and a
 * decoration that disappears early is not.
 *
 * WHY ARROWS STICK. A 28 m/s arrow crosses the screen in a handful of frames.
 * If it vanishes on contact the only evidence a shot happened is the damage
 * number, which is precisely the complaint that started this work ("arrows
 * can't be seen"). An arrow that stays in the deer it hit — moving with it —
 * or stands in the dirt where it missed turns a 4-frame event into a readable
 * few seconds of world state.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Gravity applied to projectiles (m/s²). Matches the old inline constant. */
export const PROJECTILE_GRAVITY = 9.8;

/**
 * Pool size. Player fire rate is one arrow per ~0.6 s and arrows live at most
 * ARROW_MAX_AGE_S in flight plus STUCK_GROUND_S planted, so 64 is generous
 * even with a squad of archers shooting back.
 */
export const PROJECTILE_CAPACITY = 64;

/** Seconds a flying arrow lives before giving up (~4 s ≈ 100 m of travel). */
export const ARROW_MAX_AGE_S = 4;
/** Seconds a thrown stone lives before giving up. */
export const STONE_MAX_AGE_S = 3;

/** Seconds an arrow stays stuck in a creature/NPC before falling away. */
export const STUCK_BODY_S = 8;
/** Seconds an arrow stays planted in the ground. */
export const STUCK_GROUND_S = 25;

export type ProjectileKind = 'arrow' | 'stone';

/**
 * Who fired it. Player projectiles test against creatures and NPCs; enemy
 * projectiles test against the player. Keeping this on the projectile rather
 * than in two parallel pools means one integration loop and one draw call.
 */
export type ProjectileTeam = 'player' | 'enemy';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Projectile {
  /** False when this slot is free. Never remove slots — reuse them. */
  active: boolean;
  kind: ProjectileKind;
  team: ProjectileTeam;
  /** World position. For a stuck projectile this is refreshed from its anchor. */
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Unit forward — the direction the shaft points. Frozen on impact. */
  dx: number; dy: number; dz: number;
  damage: number;
  /** simTime at spawn. */
  bornS: number;
  /** True once it has hit something and become scenery. */
  stuck: boolean;
  /** simTime at which the slot is freed (only meaningful while stuck). */
  expireS: number;
  /**
   * Id of the creature/NPC the projectile is embedded in, or null when it is
   * planted in the ground. The caller refreshes x/y/z from the anchor each
   * frame so an arrow rides the animal it hit.
   */
  anchorId: string | null;
  /** Offset from the anchor's origin, captured at the moment of impact. */
  ax: number; ay: number; az: number;
  /** Monotonic spawn counter — oldest-first eviction when the pool is full. */
  seq: number;
}

export interface ProjectilePool {
  readonly slots: Projectile[];
  /** Next spawn sequence number. */
  seq: number;
}

/** What a hit test found. `anchorId` null = terrain / static geometry. */
export interface ProjectileHit {
  anchorId: string | null;
  /** Origin of the thing that was hit, so the stick offset can be derived. */
  anchorX: number; anchorY: number; anchorZ: number;
}

export interface ProjectileHooks {
  /** Terrain height under a world XZ. */
  heightAt(x: number, z: number): number;
  /**
   * Resolve a hit for this projectile at its current position and apply its
   * consequences (damage, crime, audio). Return the anchor to stick to, or
   * null when nothing was hit.
   */
  resolveHit(p: Projectile): ProjectileHit | null;
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

function blankSlot(): Projectile {
  return {
    active: false, kind: 'arrow', team: 'player',
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, dx: 0, dy: 0, dz: -1,
    damage: 0, bornS: 0, stuck: false, expireS: 0,
    anchorId: null, ax: 0, ay: 0, az: 0, seq: 0,
  };
}

export function createProjectilePool(capacity = PROJECTILE_CAPACITY): ProjectilePool {
  const slots: Projectile[] = new Array(capacity);
  for (let i = 0; i < capacity; i++) slots[i] = blankSlot();
  return { slots, seq: 1 };
}

export interface SpawnInit {
  kind: ProjectileKind;
  team?: ProjectileTeam;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  damage: number;
  nowS: number;
}

/**
 * Claim a slot. Prefers a free one; if every slot is busy it evicts the oldest
 * *stuck* projectile (scenery), and only if there is none does it evict the
 * oldest projectile outright. A shot must never be silently dropped.
 */
export function spawnProjectile(pool: ProjectilePool, init: SpawnInit): Projectile {
  let slot: Projectile | null = null;
  for (const s of pool.slots) {
    if (!s.active) { slot = s; break; }
  }
  if (slot === null) {
    let oldestStuck: Projectile | null = null;
    let oldestAny: Projectile | null = null;
    for (const s of pool.slots) {
      if (s.stuck && (oldestStuck === null || s.seq < oldestStuck.seq)) oldestStuck = s;
      if (oldestAny === null || s.seq < oldestAny.seq) oldestAny = s;
    }
    slot = oldestStuck ?? oldestAny!;
  }

  slot.active = true;
  slot.kind = init.kind;
  slot.team = init.team ?? 'player';
  slot.x = init.x; slot.y = init.y; slot.z = init.z;
  slot.vx = init.vx; slot.vy = init.vy; slot.vz = init.vz;
  slot.damage = init.damage;
  slot.bornS = init.nowS;
  slot.stuck = false;
  slot.expireS = 0;
  slot.anchorId = null;
  slot.ax = 0; slot.ay = 0; slot.az = 0;
  slot.seq = pool.seq++;
  // Reset the heading before orienting: a zero-velocity spawn (the
  // `injectProjectile` debug hook does exactly this) leaves orientToVelocity
  // with nothing to work from, and a recycled slot would otherwise keep the
  // previous occupant's angle.
  slot.dx = 0; slot.dy = 0; slot.dz = -1;
  orientToVelocity(slot);
  return slot;
}

/** Free a slot (anchor despawned, arrow expired, caller cancelled it). */
export function releaseProjectile(p: Projectile): void {
  p.active = false;
  p.stuck = false;
  p.anchorId = null;
}

/** Point the shaft along the current velocity; a stalled slot keeps its angle. */
export function orientToVelocity(p: Projectile): void {
  const len = Math.hypot(p.vx, p.vy, p.vz);
  if (len < 1e-4) return;
  p.dx = p.vx / len;
  p.dy = p.vy / len;
  p.dz = p.vz / len;
}

/** Number of projectiles still flying (excludes stuck scenery). */
export function inFlightCount(pool: ProjectilePool): number {
  let n = 0;
  for (const s of pool.slots) if (s.active && !s.stuck) n++;
  return n;
}

/** Number of slots in use, flying or stuck. */
export function activeCount(pool: ProjectilePool): number {
  let n = 0;
  for (const s of pool.slots) if (s.active) n++;
  return n;
}

/** Max lifetime in flight for a kind. */
export function maxAgeFor(kind: ProjectileKind): number {
  return kind === 'arrow' ? ARROW_MAX_AGE_S : STONE_MAX_AGE_S;
}

/**
 * Turn a flying projectile into scenery at its current position.
 *
 * A stone does not stick — it is a rock, it lands and is gone. An arrow buries
 * its head and stays: in a body if `hit.anchorId` names one (and then travels
 * with it), otherwise upright in the dirt.
 */
export function stickProjectile(
  p: Projectile,
  hit: ProjectileHit | null,
  nowS: number,
): void {
  if (p.kind !== 'arrow') { releaseProjectile(p); return; }
  p.stuck = true;
  p.vx = 0; p.vy = 0; p.vz = 0;
  if (hit !== null && hit.anchorId !== null) {
    p.anchorId = hit.anchorId;
    p.ax = p.x - hit.anchorX;
    p.ay = p.y - hit.anchorY;
    p.az = p.z - hit.anchorZ;
    p.expireS = nowS + STUCK_BODY_S;
  } else {
    p.anchorId = null;
    p.ax = 0; p.ay = 0; p.az = 0;
    p.expireS = nowS + STUCK_GROUND_S;
  }
}

/**
 * Advance every active projectile by dtS.
 *
 * Integration is a plain forward Euler step, which is what the previous inline
 * loop did and is accurate enough over a 4 s flight. The ground test is done
 * AFTER the step against the new position, so an arrow fired downhill plants
 * where it meets the slope rather than sailing through it.
 */
export function stepProjectiles(
  pool: ProjectilePool,
  dtS: number,
  nowS: number,
  hooks: ProjectileHooks,
): void {
  for (const p of pool.slots) {
    if (!p.active) continue;

    if (p.stuck) {
      if (nowS >= p.expireS) releaseProjectile(p);
      continue;
    }

    p.vy -= PROJECTILE_GRAVITY * dtS;
    p.x += p.vx * dtS;
    p.y += p.vy * dtS;
    p.z += p.vz * dtS;
    orientToVelocity(p);

    const hit = hooks.resolveHit(p);
    if (hit !== null) {
      stickProjectile(p, hit, nowS);
      continue;
    }

    const groundY = hooks.heightAt(p.x, p.z);
    if (p.y <= groundY) {
      // Plant it where it met the ground, not below it.
      p.y = groundY;
      stickProjectile(p, null, nowS);
      continue;
    }

    if (nowS - p.bornS > maxAgeFor(p.kind)) releaseProjectile(p);
  }
}

/**
 * Refresh stuck-to-a-body projectiles from their anchor's current position.
 * `anchorAt` returns null when the anchor is gone (killed, looted, streamed
 * out), in which case the arrow goes with it rather than hanging in mid-air.
 */
export function followAnchors(
  pool: ProjectilePool,
  anchorAt: (id: string) => { x: number; y: number; z: number } | null,
): void {
  for (const p of pool.slots) {
    if (!p.active || !p.stuck || p.anchorId === null) continue;
    const a = anchorAt(p.anchorId);
    if (a === null) { releaseProjectile(p); continue; }
    p.x = a.x + p.ax;
    p.y = a.y + p.ay;
    p.z = a.z + p.az;
  }
}
