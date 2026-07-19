/**
 * Debug fly camera — WASD + mouse look (pointer lock), Shift = fast,
 * Space/C = up/down. Used for terrain verification before the third-person
 * controller exists, and kept afterwards as a noclip debug tool.
 */

import { add, lookAt, normalize, scale, type Mat4, type Vec3 } from './math';

export class FlyCamera {
  pos: Vec3;
  yaw = 0;          // radians, 0 = looking toward -Z
  pitch = -0.3;     // radians, clamped

  private readonly keys = new Set<string>();

  constructor(pos: Vec3) {
    this.pos = [...pos] as Vec3;
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Feed pointer-lock mouse deltas. */
  onMouseMove(dx: number, dy: number) {
    this.yaw -= dx * 0.0025;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - dy * 0.0025));
  }

  forward(): Vec3 {
    const cp = Math.cos(this.pitch);
    return [-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp];
  }

  /** Advance one fixed timestep. */
  update(dt: number) {
    const fwd = this.forward();
    const right: Vec3 = normalize([-fwd[2], 0, fwd[0]]);
    let move: Vec3 = [0, 0, 0];
    if (this.keys.has('KeyW')) move = add(move, fwd);
    if (this.keys.has('KeyS')) move = add(move, scale(fwd, -1));
    if (this.keys.has('KeyD')) move = add(move, right);
    if (this.keys.has('KeyA')) move = add(move, scale(right, -1));
    if (this.keys.has('Space')) move = add(move, [0, 1, 0]);
    if (this.keys.has('KeyC')) move = add(move, [0, -1, 0]);
    const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 60 : 15;
    this.pos = add(this.pos, scale(normalize(move), speed * dt));
  }

  viewMatrix(): Mat4 {
    return lookAt(this.pos, add(this.pos, this.forward()), [0, 1, 0]);
  }
}
