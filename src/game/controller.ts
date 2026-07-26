/**
 * Third-person character controller — point-with-radius kinematics against a
 * GroundQuery world. No physics engine: gravity + ground snap + ceiling clamp.
 * Swap `world` (terrain ↔ dungeon collider) to change collision modes.
 *
 * Movement is camera-relative (WASD in the camera's yaw frame), walk 6 m/s,
 * sprint 10 m/s (Shift), jump (Space) with 25 m/s² gravity.
 */

import type { GroundQuery } from './collision';
import type { Vec3 } from './math';
import { SEA_LEVEL } from './noise';

const WALK_SPEED = 6;
const SPRINT_SPEED = 10;
const GRAVITY = 25;
const JUMP_SPEED = 8;
const RADIUS = 0.35; // capsule radius for ground sampling and wall slide
const HEIGHT = 1.7;  // capsule height for the ceiling clamp (= PLAYER_HEIGHT)

// Swim-lite: buoyant drift once the water is chest-deep, no dive controls.
const SWIM_SPEED = 3;     // horizontal speed while swimming (m/s)
const SWIM_SINK = 1.1;    // feet float this far below the surface (m)
const BUOYANCY = 6;       // spring toward the float line (1/s²-ish)
const WATER_DRAG = 2.5;   // vertical velocity damping (1/s)
const SWIM_UP_SPEED = 2.5; // Space paddles upward (m/s)

/** True when the event targets a text-entry element (chat input etc.). */
function isTextEntry(t: EventTarget | null): boolean {
  return t instanceof HTMLElement &&
    (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

export class PlayerController {
  pos: Vec3;
  velY = 0;
  grounded = false;
  swimming = false;
  /** Water exists only on the surface — main.ts clears this inside dungeons. */
  swimEnabled = true;
  /** Facing direction (radians) — follows movement for the player mesh. */
  yaw = 0;
  /** Horizontal speed this step (m/s, 0 when idle) — drives the walk cycle. */
  moveSpeed = 0;

  private readonly keys = new Set<string>();
  /** Read-only view of currently held keys (for external systems like vitals). */
  get heldKeys(): ReadonlySet<string> { return this.keys; }

  constructor(public world: GroundQuery, spawn: Vec3) {
    this.pos = [...spawn] as Vec3;
    window.addEventListener('keydown', (e) => {
      // Ignore keystrokes typed into text fields (NPC chat input) so WASD/
      // Space while typing don't drive the character.
      if (isTextEntry(e.target)) return;
      this.keys.add(e.code);
    });
    // Keyup always clears — even from a text field — so keys never stick.
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Advance one fixed timestep. cameraYaw orients WASD input. */
  update(dt: number, cameraYaw: number) {
    // Camera-relative move input.
    let ix = 0;
    let iz = 0;
    if (this.keys.has('KeyW')) iz -= 1;
    if (this.keys.has('KeyS')) iz += 1;
    if (this.keys.has('KeyD')) ix += 1;
    if (this.keys.has('KeyA')) ix -= 1;

    const floatY = SEA_LEVEL - SWIM_SINK;
    // You float when the water is deep enough to lift you — whether or not
    // your feet can still reach the bottom.
    //
    // This used to also require !grounded, which meant that wading down a
    // shelving seabed never started a swim: every step landed you back on the
    // bottom, so `grounded` stayed true and you walked along the sea floor
    // fully submerged while the screen filled with blue. Deciding on water
    // depth instead makes entering the sea a swim, and leaves genuinely
    // shallow water (bed above the float line) as ordinary wading.
    const bed = this.world.groundHeight(this.pos[0], this.pos[2], RADIUS);
    this.swimming = this.swimEnabled && bed < floatY && this.pos[1] < SEA_LEVEL;

    if (ix !== 0 || iz !== 0) {
      const len = Math.hypot(ix, iz);
      const speed = this.swimming ? SWIM_SPEED
        : this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')
          ? SPRINT_SPEED : WALK_SPEED;
      // Rotate input by camera yaw (yaw 0 = looking -Z):
      // right = [cos, 0, -sin], forward(-Z local) = [-sin, 0, -cos].
      const sin = Math.sin(cameraYaw);
      const cos = Math.cos(cameraYaw);
      const dx = ((ix * cos + iz * sin) / len) * speed;
      const dz = ((-ix * sin + iz * cos) / len) * speed;
      [this.pos[0], this.pos[2]] =
        this.world.moveXZ(this.pos[0], this.pos[2], dx * dt, dz * dt, RADIUS);
      // Mesh forward is (sin yaw, -cos yaw) — atan2(dx, -dz) faces movement.
      this.yaw = Math.atan2(dx, -dz);
      this.moveSpeed = speed;
    } else {
      this.moveSpeed = 0;
    }

    // Swimming takes precedence: touching the sea bed mid-stroke should still
    // paddle (handled below), not fire a jump.
    if (this.grounded && !this.swimming && this.keys.has('Space')) {
      this.velY = JUMP_SPEED;
      this.grounded = false;
    }

    if (this.swimming) {
      // Buoyant spring toward the float line + drag; Space paddles up.
      this.velY += Math.min(floatY - this.pos[1], 4) * BUOYANCY * dt;
      this.velY *= Math.exp(-WATER_DRAG * dt);
      if (this.keys.has('Space')) this.velY = SWIM_UP_SPEED;
    } else {
      this.velY -= GRAVITY * dt;
    }
    this.pos[1] += this.velY * dt;

    // Head bonk: stop upward motion at the ceiling (Infinity outdoors).
    const ceil = this.world.ceilingHeight(this.pos[0], this.pos[2]);
    if (this.pos[1] + HEIGHT > ceil) {
      this.pos[1] = ceil - HEIGHT;
      if (this.velY > 0) this.velY = 0;
    }

    const ground = this.world.groundHeight(this.pos[0], this.pos[2], RADIUS);
    if (this.pos[1] <= ground) {
      this.pos[1] = ground;
      this.velY = 0;
      this.grounded = true;
    } else if (this.pos[1] > ground + 0.01) {
      this.grounded = false;
    }
  }
}
