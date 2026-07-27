/**
 * The opening's state machine: the king circles his castle on a black dragon,
 * ignoring you, until you leave and come back. Then everything in the castle
 * wakes up.
 *
 * PURE — no GPU, no DOM, no timers. `step()` takes the player's position and
 * the sim clock and returns the new state, so `scripts/test-castle-state.mts`
 * can prove the whole arc without a browser, and the frame loop just calls it.
 *
 * ## The three phases
 *
 *   dormant   — spawn state. The dragon flies a slow circuit above the towers.
 *               Nothing in the castle is hostile. This is the escape window.
 *   departed  — the player has been more than LEAVE_RADIUS from the keep. The
 *               castle is behind them; the dragon keeps circling.
 *   hunting   — the player came back inside RETURN_RADIUS after departing. The
 *               king, the dragon and every goblin and skeleton go hostile, and
 *               they stay that way. Terminal.
 *
 * The radii are deliberately hysteretic (leave 190 m, return 130 m) so walking
 * a boundary cannot flicker the alarm, and so "left" means genuinely gone —
 * the breach foot is only ~95 m from the keep centre, and standing in the
 * rubble outside the wall must not count as having escaped.
 */

/** Alarm phase. Order matters: the machine only ever moves forward. */
export type CastleAlarm = 'dormant' | 'departed' | 'hunting';

/** Distance from the keep centre at which the player counts as gone. */
export const LEAVE_RADIUS = 190;
/** Distance at which a departed player counts as having come back. */
export const RETURN_RADIUS = 130;

export interface CastleState {
  alarm: CastleAlarm;
  /** True once the player has been outside the curtain wall at all. */
  escaped: boolean;
  /** simTime the alarm last changed; drives the roar and the notice. */
  changedAt: number;
  /** Farthest the player has been from the keep, metres. Diagnostics only. */
  maxDist: number;
}

export function createCastleState(): CastleState {
  return { alarm: 'dormant', escaped: false, changedAt: 0, maxDist: 0 };
}

/**
 * Advance the machine. Returns the phase it moved to, or null if unchanged —
 * the caller uses that to fire the one-shot roar and on-screen notice exactly
 * once per transition instead of every frame.
 */
export function stepCastleState(
  st: CastleState,
  playerX: number, playerZ: number,
  keepX: number, keepZ: number,
  outsideWall: boolean,
  simTime: number,
): CastleAlarm | null {
  const d = Math.hypot(playerX - keepX, playerZ - keepZ);
  if (d > st.maxDist) st.maxDist = d;
  if (outsideWall) st.escaped = true;

  if (st.alarm === 'dormant' && d > LEAVE_RADIUS) {
    st.alarm = 'departed';
    st.changedAt = simTime;
    return 'departed';
  }
  if (st.alarm === 'departed' && d < RETURN_RADIUS) {
    st.alarm = 'hunting';
    st.changedAt = simTime;
    return 'hunting';
  }
  return null;
}

/** True when castle mobs and the king should be hostile. */
export function castleHostile(st: CastleState): boolean {
  return st.alarm === 'hunting';
}

// --- the dragon's circuit --------------------------------------------------

/** Radius of the patrol circle around the keep, metres. */
export const PATROL_R = 86;
/** Height above the arena floor the patrol flies at. */
export const PATROL_ALT = 26;
/** Seconds for one full circuit. */
export const PATROL_PERIOD = 44;

export interface FlightPose {
  x: number; y: number; z: number;
  /** Mesh facing. Mesh forward is (sin yaw, -cos yaw) → atan2(dx, -dz). */
  yaw: number;
}

/**
 * Where the king and his dragon are at time `t`.
 *
 * While dormant or departed this is a steady banked circuit above the towers —
 * the thing the player looks up at while running for the breach. Once hunting,
 * the circuit tightens and drops toward the player, and the caller takes over
 * with real combat AI; this still gives a sane pose for the approach.
 *
 * Deterministic in `t` alone, so a screenshot harness can put the dragon in a
 * known place by pinning simTime.
 */
export function patrolPose(
  t: number, keepX: number, keepY: number, keepZ: number,
): FlightPose {
  const a = (t / PATROL_PERIOD) * Math.PI * 2;
  const x = keepX + Math.cos(a) * PATROL_R;
  const z = keepZ + Math.sin(a) * PATROL_R;
  // Gentle 4 m bob so the circuit never reads as a turntable.
  const y = keepY + PATROL_ALT + Math.sin(a * 2) * 4;
  // Tangent of the circle, in the direction of travel.
  const dx = -Math.sin(a);
  const dz = Math.cos(a);
  return { x, y, z, yaw: Math.atan2(dx, -dz) };
}

/**
 * Where the dragon should be when hunting: the same circuit, pulled in toward
 * the player and dropped to strike height. Blends over `closeT` seconds so the
 * transition out of the patrol is not a teleport.
 */
export function huntPose(
  t: number, keepX: number, keepY: number, keepZ: number,
  playerX: number, playerY: number, playerZ: number, sinceAlarm: number,
): FlightPose {
  const p = patrolPose(t, keepX, keepY, keepZ);
  const k = Math.min(1, sinceAlarm / 12);
  // Orbit the player instead of the keep, tightening as k rises.
  const a = (t / (PATROL_PERIOD * 0.45)) * Math.PI * 2;
  const r = PATROL_R * (1 - k) + 34 * k;
  const tx = playerX + Math.cos(a) * r;
  const tz = playerZ + Math.sin(a) * r;
  const ty = (keepY + PATROL_ALT) * (1 - k) + (playerY + 22) * k;
  const x = p.x * (1 - k) + tx * k;
  const z = p.z * (1 - k) + tz * k;
  const y = p.y * (1 - k) + ty * k;
  return { x, y, z, yaw: Math.atan2(playerX - x, -(playerZ - z)) };
}
