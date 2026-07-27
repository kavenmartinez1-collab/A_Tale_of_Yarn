/**
 * Third-person orbit camera — yaw/pitch around a target point (the player's
 * head), scroll-wheel distance, eye kept clear of the terrain.
 *
 * ## Sign convention
 *
 * `pitch` is POSITIVE DOWNWARD: `forward()` returns `-sin(pitch)` for Y, so
 * pitch +1.4 looks 80 deg at the floor and pitch -1.0 looks 57 deg at the sky.
 * Every clamp below reads backwards until you have that straight, and it cost
 * the game its entire upward aim range: the limit used to be
 * `max(-0.1, min(1.4, ...))`, which is 80.2 deg of down and **5.7 deg of up**.
 * You could not point at a bird, let alone at the dragon that circles the keep.
 *
 * ## Why looking up is hard for a rear orbit, and what is done about it
 *
 * The eye sits at `pivot - forward * distance`, so looking UP by `u` puts it
 * `sin(u) * distance` BELOW the pivot. The pivot is only ~1.45 m over the
 * player's feet, so at distance 6 the eye is underground past about 9 degrees
 * of up-pitch. There is no rear-orbit camera that looks steeply up from behind
 * without burying itself; every game that offers the shot moves the framing.
 *
 * Two things move here, both keyed only off UPWARD pitch so ordinary play and
 * the portrait/harness cameras (which all sit at pitch >= 0) are untouched:
 *
 *   - the pivot RISES (`AIM_LIFT`), which keeps the eye near its level height
 *     and fills the screen with sky rather than with the back of a head — the
 *     right framing for shooting at something overhead anyway;
 *   - the boom SHORTENS a little (`AIM_BOOM`), so the shot tightens instead of
 *     swinging the eye through a wide low arc.
 *
 * The pivot moving does not disturb aiming: the crosshair is screen centre,
 * screen centre is the `forward()` ray from the eye, and the shot converges on
 * whatever that ray hits. Framing and aim are independent.
 *
 * ## The eye clears the ground by SHORTENING, never by rising
 *
 * The old terrain rule pushed the eye up in Y until it cleared the ground.
 * That silently breaks the aim, because `lookAt(eye, pivot)` then points
 * somewhere that is no longer `forward()` — the crosshair and the ray the
 * shot uses stop agreeing, and the error is worst exactly when you are aiming
 * up a slope. Pulling the eye IN along the view ray instead keeps
 * `pivot - eye` parallel to `forward()` by construction, so `forward()` stays
 * the exact screen-centre direction no matter what the camera had to dodge.
 * This is also what `DungeonCollider`/`CastleCollider.clampCameraEye` already
 * do for interiors, so the two paths now behave the same way.
 *
 * ## First person
 *
 * `firstPerson` slides the boom to zero, which puts the eye exactly on the
 * anchor main.ts already passes in — `camAnchor()`, 1.445 m over the feet,
 * within 6 cm of where the character mesh puts its own eyes. Nothing else
 * about aiming changes, and that is the point: the crosshair was already the
 * `forward()` ray from `eye()`, so moving the eye ALONG that ray leaves the
 * reticle saying exactly what it said before.
 *
 * The one thing that genuinely breaks at zero boom is `lookAt(eye, pivot)` —
 * the eye IS the pivot, `normalize([0,0,0])` returns zeros in math.ts rather
 * than NaN, and the whole basis collapses silently to a black frame. So the
 * look target blends toward `eye + forward` as `firstPerson` rises. For any
 * boom the two targets sit on the same ray and produce an identical basis, so
 * third-person framing is bit-unchanged at `firstPerson === 0`.
 *
 * Level or below, the eye slides purely ALONG the view ray, so the crosshair
 * marks the same world point in both views and switching does not nudge your
 * aim. Looking UP it does move, because `AIM_LIFT` scales with the boom and a
 * zero boom has no downward swing left to cancel — the ray translates (never
 * rotates) as the lift is given up. At the full 71.6 deg of up-pitch that is a
 * 3.15 m pivot drop but only 0.99 m of it is across the ray, so the worst-case
 * crosshair walk over the whole transition is under a metre. Measured in
 * test-aim section 9 rather than asserted to be zero, because it is a real and
 * intended consequence of putting your eye where your head is.
 */

import { lookAt, type Mat4, type Vec3 } from './math';
import type { HeightField } from './noise';

/** Upward pitch limit, radians. 1.25 = 71.6 deg. */
const PITCH_UP = 1.25;
/** Downward pitch limit, radians. 1.4 = 80.2 deg — unchanged. */
const PITCH_DOWN = 1.4;

/**
 * How much of the eye's downward swing the rising pivot cancels, 0..1.
 *
 * At 1.0 the eye would hold a perfectly constant height and the player would
 * leave the bottom of the frame early. 0.85 keeps the eye comfortably above
 * ground while the player stays in shot up to ~45 deg of up-pitch, which is
 * where most shooting happens.
 */
const AIM_LIFT = 0.85;

/** Boom shrink at full up-pitch (0.35 = 35% closer). */
const AIM_BOOM = 0.35;

/** Ground clearance for the eye, metres. */
const EYE_CLEAR = 0.5;

/** Boom-shortening march step and floor, mirroring the interior colliders. */
const BOOM_STEP = 0.4;
const BOOM_MIN = 0.9;

export class OrbitCamera {
  yaw = 0;            // radians; 0 = camera behind player looking -Z
  pitch = 0.35;       // radians; POSITIVE IS DOWN (see header)
  distance = 6;       // meters, wheel-adjustable

  /** Interior camera collision (set while inside a dungeon, else terrain). */
  interior: { clampCameraEye(target: Vec3, desired: Vec3): Vec3 } | null = null;

  /**
   * Hard floor for the camera eye in world Y, or null for none. main.ts raises
   * this to just above the waterline while the player swims at the surface:
   * the eye position is what drives the underwater post effect, and a
   * third-person camera orbiting a floating swimmer otherwise dips below the
   * surface and fills the screen with blue — which reads as drowning rather
   * than as swimming. The terrain rule below cannot cover this, because
   * under water the terrain is the sea bed.
   */
  minEyeY: number | null = null;

  /**
   * First-person blend, 0 = the usual orbit, 1 = the eye on the player's head.
   *
   * Driven by main.ts from the bow draw and eased, not switched: at 1 the
   * boom is zero, and jumping a camera 6 m forward in one frame reads as a
   * teleport. Everything between is a real camera position on the same view
   * ray, so there is no state in which the reticle means something different
   * from what it means at either end.
   */
  firstPerson = 0;

  /**
   * Eye from the last `viewMatrix` call, and the pivot it was looking at.
   *
   * The aim code needs the eye the frame was actually rendered from — that is
   * the origin of the ray the crosshair sits on. Recomputing it would be
   * cheap, but it would also be a second copy of the framing rules, and the
   * two drifting apart is precisely the class of bug that made a reticle
   * necessary in the first place.
   */
  readonly lastEye: Vec3 = [0, 0, 0];
  readonly lastPivot: Vec3 = [0, 0, 0];

  constructor(private readonly heightField: HeightField) {}

  onMouseMove(dx: number, dy: number) {
    this.yaw -= dx * 0.0025;
    this.pitch = Math.max(-PITCH_UP, Math.min(PITCH_DOWN, this.pitch + dy * 0.0025));
  }

  onWheel(deltaY: number) {
    this.distance = Math.max(3, Math.min(10, this.distance + deltaY * 0.005));
  }

  /**
   * Unit vector from camera toward the target — and, because the eye is only
   * ever moved ALONG this vector, the exact direction of the screen centre.
   * The crosshair, the aim ray and this function are one thing.
   */
  forward(): Vec3 {
    const cp = Math.cos(this.pitch);
    return [-Math.sin(this.yaw) * cp, -Math.sin(this.pitch), -Math.cos(this.yaw) * cp];
  }

  /** Upward look in radians, 0 when level or looking down. */
  private aimUp(): number {
    return this.pitch < 0 ? -this.pitch : 0;
  }

  /** Boom length after the up-pitch shrink and the first-person collapse. */
  private boom(): number {
    const fp = Math.max(0, Math.min(1, this.firstPerson));
    return this.distance * (1 - AIM_BOOM * (this.aimUp() / PITCH_UP)) * (1 - fp);
  }

  /**
   * The point the camera orbits and looks at: the caller's anchor, raised
   * while aiming up so the eye does not swing into the ground.
   */
  pivot(target: Vec3): Vec3 {
    const up = this.aimUp();
    if (up <= 0) return [target[0], target[1], target[2]];
    return [target[0], target[1] + Math.sin(up) * this.boom() * AIM_LIFT, target[2]];
  }

  eye(target: Vec3): Vec3 {
    const p = this.pivot(target);
    const f = this.forward();
    const dist = this.boom();
    // Interiors march themselves; hand them the un-shortened desired eye.
    if (this.interior) {
      const desired: Vec3 = [p[0] - f[0] * dist, p[1] - f[1] * dist, p[2] - f[2] * dist];
      return this.interior.clampCameraEye(p, desired);
    }
    // Terrain: pull the eye IN along the view ray until it clears the ground.
    // Never lift it in Y — that would bend the look direction away from
    // `forward()` and quietly decouple the crosshair from the shot.
    let t = dist;
    let ex = p[0] - f[0] * t;
    let ey = p[1] - f[1] * t;
    let ez = p[2] - f[2] * t;
    while (t > BOOM_MIN && ey < this.heightField.heightAt(ex, ez) + EYE_CLEAR) {
      t -= BOOM_STEP;
      ex = p[0] - f[0] * t;
      ey = p[1] - f[1] * t;
      ez = p[2] - f[2] * t;
    }
    // Waterline exception only — a deliberate Y clamp, see `minEyeY`.
    if (this.minEyeY !== null && ey < this.minEyeY) ey = this.minEyeY;
    return [ex, ey, ez];
  }

  viewMatrix(target: Vec3): { view: Mat4; eye: Vec3 } {
    const p = this.pivot(target);
    const eye = this.eye(target);
    this.lastEye[0] = eye[0]; this.lastEye[1] = eye[1]; this.lastEye[2] = eye[2];
    this.lastPivot[0] = p[0]; this.lastPivot[1] = p[1]; this.lastPivot[2] = p[2];
    // Look target blends from the pivot to a point one metre down `forward()`.
    // Both lie on the view ray for any boom, so the rotation is the same and
    // third person is untouched; the blend exists solely so that at zero boom
    // — where the eye and the pivot are the same point — `lookAt` still has
    // two distinct points to build a basis from.
    const fp = Math.max(0, Math.min(1, this.firstPerson));
    let aim = p;
    if (fp > 0) {
      const f = this.forward();
      aim = [
        p[0] * (1 - fp) + (eye[0] + f[0]) * fp,
        p[1] * (1 - fp) + (eye[1] + f[1]) * fp,
        p[2] * (1 - fp) + (eye[2] + f[2]) * fp,
      ];
    }
    return { view: lookAt(eye, aim, [0, 1, 0]), eye };
  }
}
