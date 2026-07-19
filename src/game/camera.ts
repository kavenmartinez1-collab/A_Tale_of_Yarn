/**
 * Third-person orbit camera — yaw/pitch around a target point (the player's
 * head), scroll-wheel distance, eye clamped above the terrain.
 */

import { lookAt, type Mat4, type Vec3 } from './math';
import type { HeightField } from './noise';

export class OrbitCamera {
  yaw = 0;            // radians; 0 = camera behind player looking -Z
  pitch = 0.35;       // radians above horizontal, clamped
  distance = 6;       // meters, wheel-adjustable

  /** Interior camera collision (set while inside a dungeon, else terrain). */
  interior: { clampCameraEye(target: Vec3, desired: Vec3): Vec3 } | null = null;

  constructor(private readonly heightField: HeightField) {}

  onMouseMove(dx: number, dy: number) {
    this.yaw -= dx * 0.0025;
    this.pitch = Math.max(-0.1, Math.min(1.4, this.pitch + dy * 0.0025));
  }

  onWheel(deltaY: number) {
    this.distance = Math.max(3, Math.min(10, this.distance + deltaY * 0.005));
  }

  /** Unit vector from camera toward the target (the "look" direction). */
  forward(): Vec3 {
    const cp = Math.cos(this.pitch);
    return [-Math.sin(this.yaw) * cp, -Math.sin(this.pitch), -Math.cos(this.yaw) * cp];
  }

  eye(target: Vec3): Vec3 {
    const f = this.forward();
    const eye: Vec3 = [
      target[0] - f[0] * this.distance,
      target[1] - f[1] * this.distance,
      target[2] - f[2] * this.distance,
    ];
    // Interiors: march the eye out of walls + clamp under the ceiling.
    if (this.interior) return this.interior.clampCameraEye(target, eye);
    // Terrain: keep the camera above the ground (cheap camera collision).
    const minY = this.heightField.heightAt(eye[0], eye[2]) + 0.5;
    if (eye[1] < minY) eye[1] = minY;
    return eye;
  }

  viewMatrix(target: Vec3): { view: Mat4; eye: Vec3 } {
    const eye = this.eye(target);
    return { view: lookAt(eye, target, [0, 1, 0]), eye };
  }
}
