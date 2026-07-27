/**
 * Held torch — burn model, where the flame sits, and how it gets into the two
 * different light sets the game has.
 *
 * Before this, `torch` was half a feature: it warmed you (vitals.ts reads
 * `heldTorch`), it set fire to brush and it lit campfires, but it emitted no
 * light of its own and never ran out. Holding one at midnight was identical to
 * holding a stick.
 *
 * ## Three decisions worth knowing about
 *
 * **Fuel burns only while the torch is the selected item.** A stack quietly
 * draining in your pack while you swing an axe is a nasty surprise, and there
 * is no lit/unlit toggle in the game to make that legible. Selected = lit,
 * deselected = out, and the bar disappears with it. Time comes from `simTime`,
 * which only advances inside the fixed-step loop, so a paused game burns no
 * fuel — the same property that fixed resource respawn and jail sentences.
 *
 * **TORCH_BURN_S is 180, not the 60 on the item def.** `ItemDef.fuel` means
 * something else (seconds of *campfire* burn if you feed the thing to a fire,
 * the same units as logs' 120) and nothing has ever read it. 60 s of hand-burn
 * would be six torches per night at DAY_LENGTH_S = 900 with night about 40% of
 * it — the bar would never be still and the player would spend the night in
 * the hotbar. At 180 s one torch is half a night, a full stack of 20 is about
 * four nights, and a dungeon run costs one or two.
 *
 * **The flame is anchored to the mesh, not to the player's feet.** The head of
 * the torch rides the right arm's swing, so a light pinned to the body centre
 * visibly separates from its own flame at a run. TORCH_HEAD is the body-local
 * point the character mesh puts the burning end at, and `torchFlamePos` walks
 * it through the same shoulder pitch and body yaw the mesh builder uses.
 */

import type { Vec3 } from './math';

// ---------------------------------------------------------------------------
// Burn model
// ---------------------------------------------------------------------------

/** Seconds one torch burns while held. See the header for why not 60. */
export const TORCH_BURN_S = 180;

export interface TorchTick {
  /** Fuel remaining after the step, seconds. Never negative. */
  fuelS: number;
  /**
   * True on the step that consumed the last of this torch. The caller takes
   * one torch out of the stack and, if any remain, hands back a full one —
   * carrying the overshoot so a long frame cannot silently eat fuel.
   */
  spent: boolean;
}

/**
 * Advance a burning torch by `dtS` seconds of SIM time.
 *
 * On burnout the remainder rolls into the next torch rather than being
 * discarded: at 1/60 s steps that is at most 17 ms, but the same function runs
 * in the harness at coarse steps and losing a slice per torch there would make
 * a measured burn rate disagree with TORCH_BURN_S for no visible reason.
 */
export function burnTorch(fuelS: number, dtS: number): TorchTick {
  const left = fuelS - dtS;
  if (left > 0) return { fuelS: left, spent: false };
  // `left` is <= 0; -left is the overshoot to carry into the next torch.
  return { fuelS: Math.max(0, TORCH_BURN_S + left), spent: true };
}

// ---------------------------------------------------------------------------
// Where the flame is
// ---------------------------------------------------------------------------

/**
 * Body-local position of the burning head, in the same frame `heldParts` in
 * character/character-mesh.ts builds the torch in (right fist outboard face,
 * x 0.27..0.37, y 0.72..1.30). The mesh's rag wrap spans y 1.46..1.60; the
 * flame sits just above it.
 *
 * KEEP IN SYNC with the `case 'torch'` arm of `heldParts`.
 */
const TORCH_HEAD: Vec3 = [0.405, 1.52, -0.10];

/** Right shoulder pivot — character-mesh.ts SHOULDER_Y. */
const SHOULDER_Y = 1.24;

/**
 * World position of the flame.
 *
 * `meshYaw` is the character mesh's yaw (the `atan2(dx, -dz)` convention, i.e.
 * `controller.yaw`, NOT the camera's). `swing` is the walk swing the mesh
 * builder computes as `sin(walkPhase) * walkAmp`; the right shoulder pitches
 * by half of it, and the held item rides that joint.
 *
 * The attack chop and the bow draw also move this arm and are deliberately not
 * modelled — you cannot draw a bow with a torch in hand, and a chop is a third
 * of a second. The walk swing is the one that runs for minutes at a time.
 */
export function torchFlamePos(
  px: number, py: number, pz: number, meshYaw: number, swing: number,
): Vec3 {
  // Shoulder pitch about X through (y = SHOULDER_Y, z = 0), matching
  // character-mesh.ts `pitch(rShoulderPitch, shoulderY)` with
  // rShoulderPitch = -armPitch = swing * 0.5.
  const a = swing * 0.5;
  const s = Math.sin(a);
  const c = Math.cos(a);
  const dy = TORCH_HEAD[1] - SHOULDER_Y;
  const dz = TORCH_HEAD[2];
  const lx = TORCH_HEAD[0];
  const ly = SHOULDER_Y + dy * c - dz * s;
  const lz = dy * s + dz * c;
  // Body yaw about Y — the same twistY the mesh applies, so mesh forward is
  // (sin yaw, -cos yaw).
  const sy = Math.sin(meshYaw);
  const cy = Math.cos(meshYaw);
  return [px + lx * cy - lz * sy, py + ly, pz + lx * sy + lz * cy];
}

// ---------------------------------------------------------------------------
// Light
// ---------------------------------------------------------------------------

/**
 * Colour for the group-2 interior set (dungeons and building interiors). That
 * shader path multiplies by 3.2 and sits on an ambient floor, so the raw
 * numbers are small — this is the same scale as the wall torches in
 * dungeon-manager.ts (TORCH_COLOR [1.0, 0.72, 0.4]), pulled down a little
 * because a brand in your fist is not a sconce with a reflector behind it.
 */
export const TORCH_LIGHT_INTERIOR: Vec3 = [0.85, 0.58, 0.28];

/**
 * Colour for the renderer's world set (outdoors, the castle, and characters /
 * animals everywhere — those pipelines cannot see group 2). No ambient floor
 * and no 3.2 gain behind it, so it needs real HDR punch; the campfire next
 * door is [2.5, 1.10, 0.34] at radius 10.5 and a torch should read as clearly
 * the smaller fire.
 */
export const TORCH_LIGHT_WORLD: Vec3 = [1.55, 0.72, 0.24];

/** Metres. Short enough that the player's own body is the brightest thing. */
export const TORCH_LIGHT_RADIUS = 8.5;

/**
 * Billboard flame size passed to render/fire-fx.ts `torch()`. Wall sconces
 * pass 1 and candles ~0.45; a brand sits between them, and much below 0.8 the
 * flame stops covering the head of the torch and floats off the end of it.
 */
export const TORCH_FLAME_SCALE = 0.85;

/**
 * Sort key handed to the world-light set. Negative so the nearest-first
 * truncation can never drop it: standing in a village at night there are more
 * than MAX_FIRE_LIGHTS lamps around, and the one light the player is
 * personally carrying going dark because a lamp post was 30 cm closer is the
 * single most confusing failure this feature could have. The Tintreach bolt
 * (-3 .. -2) and dragon breath (-1) still outrank it.
 */
export const TORCH_LIGHT_SORT_KEY = -0.5;

// ---------------------------------------------------------------------------
// Interior uniform slot
// ---------------------------------------------------------------------------

/**
 * Write the player's torch into the spare slot of a group-2 lights uniform.
 *
 * Dungeon and building interiors bake their fixture lights once on entry and
 * never touch the buffer again. The dungeon shader's surfaces read ONLY that
 * uniform — the world-light set lights characters underground but not the
 * walls — so a held torch that is not in here lights the dwarf standing next
 * to you and leaves the corridor pitch black.
 *
 * The player takes index `fixedCount`, which is normally free. A dungeon that
 * has used all 32 (MAX_TORCHES in dungeon-layout.ts is exactly 32) instead
 * loses its last wall torch's LIGHT while the player's torch is lit — the prop
 * still renders, and swapping one distant sconce for the light in your hand is
 * the right trade in a room already carrying thirty-one others.
 *
 * Returns true when it wrote, so callers can skip the upload on a still frame.
 */
export function writeTorchLightSlot(
  device: GPUDevice,
  buffer: GPUBuffer,
  data: Float32Array<ArrayBuffer>,
  fixedCount: number,
  maxLights: number,
  light: { pos: Vec3; radius: number } | null,
): boolean {
  const slot = Math.min(fixedCount, maxLights - 1);
  const count = light === null ? fixedCount : Math.min(fixedCount + 1, maxLights);
  data[0] = count;
  if (light !== null) {
    const base = 4 + slot * 8;
    data[base + 0] = light.pos[0];
    data[base + 1] = light.pos[1];
    data[base + 2] = light.pos[2];
    data[base + 4] = TORCH_LIGHT_INTERIOR[0];
    data[base + 5] = TORCH_LIGHT_INTERIOR[1];
    data[base + 6] = TORCH_LIGHT_INTERIOR[2];
    data[base + 7] = light.radius;
  }
  // Only the header and the slots actually in use — the tail is stale data the
  // shader's count keeps it from reading.
  device.queue.writeBuffer(buffer, 0, data, 0, 4 + count * 8);
  return true;
}
