/**
 * Fire VFX — every flame in the game in one instanced, additive draw call.
 *
 * WHY THIS EXISTS
 * Fire used to be opaque emissive boxes on the dungeon pipeline: three stacked
 * cubes for a campfire, 32 jittered cubes for the dragon's breath, four per
 * burning tree. Boxes cannot be soft, cannot be dense at the core and thin at
 * the edge, and cannot be cheap at forty-simultaneous-fires scale. This
 * replaces all of it.
 *
 * THE LOOK — see the long note at the top of shaders/flame.wgsl. Short form:
 * this is a knitted/felted world, so its fire is cut and stitched rather than
 * gaseous. Felt tongues with a crisp scalloped edge and a loose-fibre halo,
 * posterised into five colour bands like stacked felt, embroidered with a
 * running stitch, tips curling into yarn loops; embers are wool fluff-balls,
 * smoke is grey roving, coals are felted charcoal with hot seams.
 *
 * HOW IT WORKS
 * - One pipeline, one buffer, one `draw(6, instanceCount)`. No vertex buffer:
 *   the quad comes from `vertex_index` and everything else rides a storage
 *   buffer. That is also why no shadow pipeline is needed — there is no vertex
 *   stride to key one off, and flames are deliberately excluded from the
 *   shadow cascades (an emissive volume that casts a shadow is a bug).
 * - Particles are ANALYTIC, not simulated: a particle's position is a pure
 *   function of (emitter seed, index, time). No per-frame state, no pooling,
 *   no allocation, frame-rate independent, and a fire that scrolls out of
 *   range and back looks identical rather than restarting.
 * - Every emitter is distance-culled and LOD'd. Worst case is MAX_BURNING (40)
 *   burning trees plus campfires plus a breath jet; the instance cap is
 *   enforced at the write site in `push`, because overrunning a GPU buffer in
 *   this engine does not glitch — it turns the whole frame black.
 */

import flameWgsl from '../shaders/flame.wgsl?raw';
import { wgsl } from '../shaders/include';
import { HDR_FORMAT, NORMAL_FORMAT, DEPTH_FORMAT } from './post-fx';
import {
  BREATH_HALF_ANGLE, BREATH_RANGE, liveFuelAt,
  type BurningTree, type PlacedFire,
} from '../fire';

/**
 * Hard cap on billboards per frame. 4096 x 48 B = 192 KB re-uploaded per
 * frame, and only the used prefix is actually written.
 */
export const FIRE_MAX_INSTANCES = 4096;
/** vec4 a + vec4 b + vec4 c — keep in sync with FireInstance in flame.wgsl. */
const FLOATS_PER_INSTANCE = 12;

const K_FLAME = 0;
const K_EMBER = 1;
const K_SMOKE = 2;
const K_COAL = 3;
const TAU = Math.PI * 2;

/** Beyond this the fire is a light source and nothing else. */
const CULL_FAR = 110;

/** Deterministic 0..1 hash. Same integer mixer as the old jitter01. */
function hash01(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

/** Stable per-emitter seed from a world position (survives array reordering). */
export function fireSeed(x: number, z: number): number {
  return (Math.round(x * 16) ^ (Math.round(z * 16) << 11)) | 0;
}

export class FireFX {
  private readonly instanceLayout: GPUBindGroupLayout;
  private readonly depthLayout: GPUBindGroupLayout;
  private readonly pipeline: GPURenderPipeline;
  private readonly instanceBuffer: GPUBuffer;
  private readonly instanceBindGroup: GPUBindGroup;
  private depthBindGroup: GPUBindGroup | null = null;

  private readonly data = new Float32Array(FIRE_MAX_INSTANCES * FLOATS_PER_INSTANCE);
  private n = 0;
  private t = 0;
  private cx = 0;
  private cy = 0;
  private cz = 0;
  /** True when an emitter hit the cap this frame (surfaced in __gameStats). */
  droppedThisFrame = false;

  constructor(
    private readonly device: GPUDevice,
    sceneLayout: GPUBindGroupLayout,
  ) {
    this.instanceLayout = device.createBindGroupLayout({
      label: 'flame-instances-bgl',
      entries: [{
        binding: 0, visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'read-only-storage' },
      }],
    });
    // The scene depth buffer, read with textureLoad for the soft-particle
    // fade. textureLoad needs no sampler, which keeps this to one binding and
    // sidesteps the "can't filter a depth texture" rule entirely.
    this.depthLayout = device.createBindGroupLayout({
      label: 'flame-depth-bgl',
      entries: [{
        binding: 0, visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'depth' },
      }],
    });

    this.instanceBuffer = device.createBuffer({
      label: 'flame-instances',
      size: FIRE_MAX_INSTANCES * FLOATS_PER_INSTANCE * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.instanceBindGroup = device.createBindGroup({
      label: 'flame-instances-bg',
      layout: this.instanceLayout,
      entries: [{ binding: 0, resource: { buffer: this.instanceBuffer } }],
    });

    const module = device.createShaderModule({
      label: 'flame-shader', code: wgsl(flameWgsl),
    });
    this.pipeline = device.createRenderPipeline({
      label: 'flame-shader',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [sceneLayout, this.instanceLayout, this.depthLayout],
      }),
      vertex: { module, entryPoint: 'vs_main' },
      fragment: {
        module, entryPoint: 'fs_main',
        targets: [
          {
            format: HDR_FORMAT,
            // Premultiplied-alpha over. Emitting alpha 0 makes this pure
            // additive (flames, embers, coals); emitting alpha > 0 makes it a
            // normal over-blend (smoke). One pipeline, both behaviours.
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
          // Fire must not write the normal G-buffer or SSAO darkens it.
          { format: NORMAL_FORMAT, writeMask: 0 },
        ],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      // Depth-tested against the opaque scene, never depth-writing.
      depthStencil: {
        format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'less',
      },
    });
  }

  /** Rebind after the depth target is reallocated (resize). */
  setDepthView(view: GPUTextureView): void {
    this.depthBindGroup = this.device.createBindGroup({
      label: 'flame-depth-bg',
      layout: this.depthLayout,
      entries: [{ binding: 0, resource: view }],
    });
  }

  /** Start a frame: clears the instance list and latches time + camera. */
  begin(time: number, camera: readonly number[]): void {
    this.n = 0;
    this.t = time;
    this.cx = camera[0];
    this.cy = camera[1];
    this.cz = camera[2];
    this.droppedThisFrame = false;
  }

  get count(): number { return this.n; }

  /** Upload the used prefix and record the draw. Group 0 must already be set. */
  draw(pass: GPURenderPassEncoder): void {
    if (this.n === 0 || this.depthBindGroup === null) return;
    this.device.queue.writeBuffer(
      this.instanceBuffer, 0, this.data, 0, this.n * FLOATS_PER_INSTANCE);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(1, this.instanceBindGroup);
    pass.setBindGroup(2, this.depthBindGroup);
    pass.draw(6, this.n);
  }

  /** Drop everything queued (called after the draw, and on a skipped frame). */
  endFrame(): void { this.n = 0; }

  // --- instance emission ----------------------------------------------------

  private dist2(x: number, y: number, z: number): number {
    const dx = x - this.cx, dy = y - this.cy, dz = z - this.cz;
    return dx * dx + dy * dy + dz * dz;
  }

  /**
   * Append one billboard. The `n >= cap` guard is the whole reason this is a
   * method: writing past the buffer blacks out the entire frame, so the clamp
   * lives at the write site rather than being reasoned about per emitter.
   */
  private push(
    x: number, y: number, z: number, halfH: number,
    life: number, seed: number, kind: number, power: number,
    ax: number, ay: number, az: number, aspect: number,
  ): void {
    if (this.n >= FIRE_MAX_INSTANCES) { this.droppedThisFrame = true; return; }
    const o = this.n * FLOATS_PER_INSTANCE;
    const d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = halfH;
    d[o + 4] = life; d[o + 5] = seed; d[o + 6] = kind; d[o + 7] = power;
    d[o + 8] = ax; d[o + 9] = ay; d[o + 10] = az; d[o + 11] = aspect;
    this.n++;
  }

  /**
   * A campfire or forge. `power` 0..1 dims the whole fire as its fuel runs
   * out, so a dying fire visibly sinks back into its coals instead of
   * switching off between two 5-second mesh rebuilds.
   */
  campfire(
    x: number, y: number, z: number, forge: boolean, power: number, seed: number,
  ): void {
    const d2 = this.dist2(x, y + 0.5, z);
    if (d2 > CULL_FAR * CULL_FAR) return;
    const lod = d2 < 24 * 24 ? 2 : d2 < 55 * 55 ? 1 : 0;
    const t = this.t;
    const s = forge ? 1.22 : 1.0;
    const p = (0.4 + 0.6 * power) * (forge ? 1.25 : 1.0);

    // Smoke first: premultiplied alpha is order-dependent and the column sits
    // above everything else this emitter draws.
    const smokeN = lod === 2 ? 5 : lod === 1 ? 3 : 0;
    for (let i = 0; i < smokeN; i++) {
      const sd = hash01(seed, 191 + i);
      const ph = ((t / 3.6) + i / smokeN + sd * 0.13) % 1;
      const drift = ph * ph;
      this.push(
        x + Math.sin(sd * TAU + t * 0.33) * 0.55 * drift * s + 0.3 * drift * s,
        y + 0.66 * s + ph * 2.6 * s,
        z + Math.cos(sd * TAU + t * 0.27) * 0.55 * drift * s,
        s * (0.20 + ph * 0.75), ph, sd, K_SMOKE, power * 0.9, 0, 0, 0, 1);
    }

    // Coal bed — flat discs in the pit, the thing that makes the logs read as
    // burning rather than as two sticks with a flame balanced on them.
    const coalN = lod >= 1 ? 2 : 1;
    for (let i = 0; i < coalN; i++) {
      this.push(x, y + 0.045 + 0.012 * i, z, (0.40 + 0.10 * i) * s,
        0, hash01(seed, 3 + i), K_COAL, p, 0, 0, 0, 1);
    }

    // Body tongues: the persistent shape of the fire. These never die, they
    // only breathe — a fire made purely of spawning particles has no form.
    const bodyN = lod === 2 ? 4 : lod === 1 ? 3 : 2;
    for (let i = 0; i < bodyN; i++) {
      const sd = hash01(seed, 11 + i);
      const ang = sd * TAU;
      const r = 0.11 * s * hash01(seed, 21 + i);
      const breathe = 0.80 + 0.20 * Math.sin(t * (2.0 + sd * 1.9) + sd * TAU);
      this.push(
        x + Math.cos(ang) * r, y + 0.03, z + Math.sin(ang) * r,
        s * (0.46 + 0.20 * hash01(seed, 31 + i)) * breathe,
        0.10, sd, K_FLAME, p, 0, 0, 0, 0.72);
    }

    // Licks that break off the body and rise.
    const lickN = lod === 2 ? 6 : lod === 1 ? 3 : 0;
    for (let i = 0; i < lickN; i++) {
      const sd = hash01(seed, 61 + i);
      const ph = ((t / (0.55 + sd * 0.5)) + sd) % 1;
      const ang = hash01(seed, 71 + i) * TAU;
      const r = (0.07 + 0.13 * ph) * s;
      this.push(
        x + Math.cos(ang) * r, y + 0.18 * s + ph * 0.55 * s, z + Math.sin(ang) * r,
        s * (0.24 + 0.13 * hash01(seed, 81 + i)) * (1 - ph * 0.5),
        ph, sd, K_FLAME, p, 0, 0, 0, 0.78);
    }

    // Embers, spiralling up on the draught.
    const emberN = lod === 2 ? 8 : lod === 1 ? 4 : 0;
    for (let i = 0; i < emberN; i++) {
      const sd = hash01(seed, 131 + i);
      const ph = ((t / (1.7 + sd * 1.5)) + sd) % 1;
      const ang = hash01(seed, 141 + i) * TAU + ph * 2.6;
      const r = (0.05 + 0.36 * ph) * s;
      this.push(
        x + Math.cos(ang) * r, y + 0.22 * s + ph * 2.0 * s, z + Math.sin(ang) * r,
        s * 0.022 * (1 - ph * 0.45), ph, sd, K_EMBER, p, 0, 0, 0, 1);
    }
  }

  /**
   * A small standing flame — wall torches, sconces, candles, brazier bowls.
   * `scale` 1 is a torch head; candles pass ~0.45, braziers ~1.6.
   */
  torch(x: number, y: number, z: number, scale: number, seed: number): void {
    const d2 = this.dist2(x, y, z);
    if (d2 > 60 * 60) return;
    const lod = d2 < 16 * 16 ? 1 : 0;
    const t = this.t;
    const s = scale;
    for (let i = 0; i < (lod ? 3 : 2); i++) {
      const sd = hash01(seed, 401 + i);
      const breathe = 0.78 + 0.22 * Math.sin(t * (2.6 + sd * 2.4) + sd * TAU);
      this.push(
        x + (sd - 0.5) * 0.05 * s, y, z + (hash01(seed, 411 + i) - 0.5) * 0.05 * s,
        s * (0.20 + 0.09 * sd) * breathe, 0.12, sd, K_FLAME, 1, 0, 0, 0, 0.60);
    }
    if (lod === 0) return;
    for (let i = 0; i < 3; i++) {
      const sd = hash01(seed, 431 + i);
      const ph = ((t / (1.5 + sd)) + sd) % 1;
      this.push(
        x + Math.cos(sd * TAU + ph * 2.2) * 0.06 * s,
        y + 0.14 * s + ph * 0.75 * s,
        z + Math.sin(sd * TAU + ph * 2.2) * 0.06 * s,
        s * 0.022 * (1 - ph * 0.4), ph, sd, K_EMBER, 1, 0, 0, 0, 1);
    }
  }

  /**
   * Burning vegetation. Flames CLIMB the trunk into the canopy rather than
   * bobbing in place, which is the single cue that reads as "spreading".
   * `power` 0..1 lets a fire that is about to burn out die down first.
   */
  burningVeg(
    x: number, y: number, z: number, bush: boolean, power: number, seed: number,
  ): void {
    const top = bush ? 1.1 : 4.6;
    const d2 = this.dist2(x, y + top * 0.5, z);
    // A burning tree is a landmark — keep it visible further out than a
    // campfire, but strip it to a couple of tongues at that range.
    if (d2 > 150 * 150) return;
    const lod = d2 < 30 * 30 ? 2 : d2 < 70 * 70 ? 1 : 0;
    const t = this.t;
    const s = bush ? 0.62 : 1.0;
    const wide = bush ? 0.34 : 0.75;
    // A burning tree stacks a dozen overlapping tongues into one column, and
    // additive blending turns that into a solid white pillar. Dividing the
    // per-tongue power by the LOD's tongue count keeps the summed brightness
    // roughly constant whatever the LOD, and keeps the colour bands alive.
    const overlap = lod === 2 ? 0.34 : lod === 1 ? 0.55 : 0.9;
    const p = (0.55 + 0.45 * power) * overlap;

    const smokeN = lod === 2 ? 6 : lod === 1 ? 3 : 0;
    for (let i = 0; i < smokeN; i++) {
      const sd = hash01(seed, 611 + i);
      const ph = ((t / 4.2) + i / smokeN + sd * 0.11) % 1;
      const drift = ph * ph;
      this.push(
        x + Math.sin(sd * TAU + t * 0.3) * 1.7 * drift + 1.1 * drift,
        y + top * 0.8 + ph * 7.5 * s,
        z + Math.cos(sd * TAU + t * 0.24) * 1.7 * drift,
        0.8 + ph * 2.6 * s, ph, sd, K_SMOKE, power, 0, 0, 0, 1);
    }

    // Ash bed at the foot of the trunk.
    if (lod >= 1) {
      this.push(x, y + 0.05, z, wide * 1.5, 0, hash01(seed, 5), K_COAL, p,
        0, 0, 0, 1);
    }

    // Standing body of flame. Spread up the trunk and flaring outward into the
    // crown, so the fire takes the shape of the thing it is consuming instead
    // of being one fat column parked on top of it.
    const bodyN = lod === 2 ? (bush ? 3 : 6) : lod === 1 ? 3 : 2;
    for (let i = 0; i < bodyN; i++) {
      const sd = hash01(seed, 701 + i);
      const f = i / Math.max(1, bodyN - 1);
      const ang = sd * TAU;
      const r = wide * (0.2 + 0.8 * hash01(seed, 711 + i)) * (0.45 + f);
      const breathe = 0.78 + 0.22 * Math.sin(t * (1.9 + sd * 2.1) + sd * TAU);
      this.push(
        x + Math.cos(ang) * r, y + 0.08 + f * top * 0.62, z + Math.sin(ang) * r,
        (bush ? 0.36 : 0.60) * (0.7 + 0.6 * hash01(seed, 721 + i)) * breathe,
        0.06 + f * 0.26, sd, K_FLAME, p, 0, 0, 0, 0.72);
    }

    // Licks climbing the trunk — born low, spent at the crown. This is the
    // whole "the fire is spreading upward" read.
    const lickN = lod === 2 ? (bush ? 4 : 9) : lod === 1 ? 4 : 0;
    for (let i = 0; i < lickN; i++) {
      const sd = hash01(seed, 761 + i);
      const ph = ((t / (0.8 + sd * 0.7)) + sd) % 1;
      const ang = hash01(seed, 771 + i) * TAU + ph * 1.3;
      const r = wide * (0.2 + 1.0 * ph) * (0.4 + 0.6 * hash01(seed, 781 + i));
      this.push(
        x + Math.cos(ang) * r, y + 0.2 + ph * top, z + Math.sin(ang) * r,
        (bush ? 0.28 : 0.46) * (0.6 + 0.7 * sd) * (1 - ph * 0.4),
        ph, sd, K_FLAME, p, 0, 0, 0, 0.80);
    }

    const emberN = lod === 2 ? 10 : lod === 1 ? 5 : 0;
    for (let i = 0; i < emberN; i++) {
      const sd = hash01(seed, 831 + i);
      const ph = ((t / (2.2 + sd * 1.8)) + sd) % 1;
      const ang = hash01(seed, 841 + i) * TAU + ph * 3.0;
      const r = wide * (0.3 + 2.2 * ph);
      this.push(
        x + Math.cos(ang) * r, y + top * 0.4 + ph * 6.0 * s, z + Math.sin(ang) * r,
        0.055 * (1 - ph * 0.4), ph, sd, K_EMBER, p, 0, 0, 0, 1);
    }
  }

  /**
   * The dragon's jet. A dense hot core at the jaws that widens, slows and
   * cools toward the tip, with the tongues stretched ALONG the axis (the
   * billboard's "up" is the jet direction) so the whole thing reads as
   * something being thrown rather than a cone of blobs sitting in the air.
   */
  breath(
    mouth: readonly number[], dir: readonly number[], jaw: number, seed: number,
    reach = 1, spark = false,
  ): void {
    const [mx, my, mz] = [mouth[0], mouth[1], mouth[2]];
    const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const dx = dir[0] / dl, dy = dir[1] / dl, dz = dir[2] / dl;
    // Two axes spanning the jet cross-section.
    const hl = Math.hypot(dx, dz) || 1;
    const rx = -dz / hl, ry = 0, rz = dx / hl;
    const ux = -dy * (dx / hl), uy = hl, uz = -dy * (dz / hl);

    const t = this.t;
    const jetLen = BREATH_RANGE * reach * jaw;

    // --- spark spray (wyvern) -------------------------------------------
    //
    // Not a small flame jet — a different weapon. Independent bright streaks,
    // each with its OWN direction inside the cone and its own short life, so
    // they read as sparks thrown from the mouth rather than as a coherent
    // plume. The dragon's tongues below are evenly spaced along one axis and
    // spiral together, which is exactly what makes that one look like a jet;
    // doing the same thing smaller just looked like a weak jet.
    //
    // Each streak is stretched along its own travel direction and made very
    // thin (`aspect` scales width against length), which is what turns a
    // billboard into a line.
    if (spark) {
      const N = 34;
      for (let i = 0; i < N; i++) {
        const sd = hash01(seed, i);
        const sa = hash01(seed, 400 + i);
        const sr = hash01(seed, 800 + i);
        // Own lifetime, so they are born and die independently instead of
        // marching outward in lockstep.
        const life = 0.20 + sd * 0.22;
        const ph = ((t / life) + sa) % 1;

        // A direction uniformly distributed over the cone's disc. sqrt() on
        // the radius keeps them from bunching along the axis.
        const ang = sa * TAU;
        const rad = Math.sqrt(sr) * Math.tan(BREATH_HALF_ANGLE) * 1.25;
        const ca = Math.cos(ang), sn = Math.sin(ang);
        let tx = dx + (rx * ca + ux * sn) * rad;
        let ty = dy + (ry * ca + uy * sn) * rad;
        let tz = dz + (rz * ca + uz * sn) * rad;
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl; ty /= tl; tz /= tl;

        // Travels outward over its life, decelerating and dropping slightly.
        const travel = ph * (1 - ph * 0.25);
        const dist = 0.30 + travel * (jetLen - 0.30);
        const px = mx + tx * dist;
        const py = my + ty * dist - ph * ph * 0.55;
        const pz = mz + tz * dist;

        // Bright hairline streak. Length and power were both raised after a
        // daylight capture: against a bright sky the first pass read as faint
        // orange specks, because a thin additive line has very little area to
        // carry brightness with. `aspect` scales width against length, so
        // 0.05 is what makes it a LINE rather than a sliver of flame.
        const halfL = 0.30 + sd * 0.45;
        const fade = ph < 0.7 ? 1 : 1 - (ph - 0.7) / 0.3;
        this.push(px, py, pz, halfL, ph * 0.22, sd, K_FLAME,
          3.4 * fade, tx, ty, tz, 0.05);
      }
      return; // no tongues, no ember shower, no smoke column
    }

    const N = 30;
    for (let i = 0; i < N; i++) {
      const f = (i + 0.5) / N;
      const sd = hash01(seed, i);
      // Flow: the whole jet marches outward, so the tongues travel rather
      // than sitting in fixed slots being re-jittered.
      const flow = t * 2.6 + sd * TAU;
      const dist = 0.35 + f * (jetLen - 0.35);
      const spread = Math.tan(BREATH_HALF_ANGLE) * dist * 0.78;
      const wa = Math.sin(flow + f * 5.5) * spread * 0.5;
      const wb = Math.cos(flow * 0.83 + f * 4.1) * spread * 0.5;
      const px = mx + dx * dist + rx * wa + ux * wb;
      const py = my + dy * dist + ry * wa + uy * wb;
      const pz = mz + dz * dist + rz * wa + uz * wb;
      // Long thin tongues at the jaws, short fat ones at the tip.
      const halfL = 0.55 + f * 1.9;
      const aspect = (0.28 + f * 0.85) * (0.8 + 0.4 * sd);
      this.push(px, py, pz, halfL, f * 0.88, sd, K_FLAME, 1.35 - f * 0.4,
        dx, dy, dz, aspect);
    }
    // Embers shed sideways off the jet.
    for (let i = 0; i < 14; i++) {
      const sd = hash01(seed, 900 + i);
      const ph = ((t / (0.6 + sd * 0.5)) + sd) % 1;
      const dist = 1.0 + ph * (reach - 1.0);
      const spread = Math.tan(BREATH_HALF_ANGLE) * dist * (1.0 + ph * 1.4);
      const ang = sd * TAU + ph * 3.4;
      const wa = Math.cos(ang) * spread, wb = Math.sin(ang) * spread;
      this.push(
        mx + dx * dist + rx * wa + ux * wb,
        my + dy * dist + uy * wb - ph * ph * 1.2,
        mz + dz * dist + rz * wa + uz * wb,
        0.075 * (1 - ph * 0.4), ph, sd, K_EMBER, 1.2, 0, 0, 0, 1);
    }
    // A puff of smoke trailing the jet.
    for (let i = 0; i < 4; i++) {
      const sd = hash01(seed, 950 + i);
      const ph = ((t / 1.6) + i * 0.25) % 1;
      const dist = reach * (0.35 + 0.6 * ph);
      this.push(
        mx + dx * dist, my + dy * dist + ph * 2.4, mz + dz * dist,
        1.0 + ph * 3.0, ph, sd, K_SMOKE, 0.8, 0, 0, 0, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// One call the game loop makes per frame.
// ---------------------------------------------------------------------------

/** Point light the caller feeds to Renderer.setWorldLights. */
export interface FireLight {
  pos: [number, number, number];
  color: [number, number, number];
  radius: number;
  d2: number;
}

export interface WorldFireInput {
  /** Placed campfires and forges (unlit ones are skipped here). */
  fires: readonly PlacedFire[];
  /** Burning trees and bushes. */
  burning: readonly BurningTree[];
  /** Dragon fire-breath, or null. `jaw` is the 0..1 jaw-open blend. */
  breath: {
    mouth: readonly number[]; dir: readonly number[]; jaw: number;
    /** Jet length multiplier — the wyvern's spark spray is much shorter. */
    reach?: number;
    /** Hot scattering fragments instead of a coherent flame jet. */
    spark?: boolean;
  } | null;
  /**
   * Additional breath jets — wild fliers attacking. Separate from `breath`
   * because that one is the RIDDEN mount's and is driven by held input; these
   * are AI-driven, there can be several at once, and none of them should be
   * able to displace the player's own.
   */
  extraBreaths?: readonly {
    mouth: readonly number[]; dir: readonly number[]; jaw: number;
    reach?: number; spark?: boolean;
  }[];
  /** Interior torch/hearth/candle fixtures when the player is indoors. */
  interiorLights:
    | readonly { pos: readonly number[]; radius: number; flameScale?: number }[]
    | null;
  /** Settlement braziers, gate torches and lamp-post lanterns. */
  settlementFlames: readonly { x: number; y: number; z: number; scale: number }[];
  /** Current sim time, for fuel drain and burn-out ramps. */
  nowS: number;
  /** Camera eye, for distance culling and light sorting. */
  eye: readonly number[];
}

/** Fuel below this many seconds and the fire visibly dies down. */
const DYING_FUEL_S = 30;
/** Burn time remaining below this and burning vegetation dies down. */
const DYING_BURN_S = 6;
/** Grid cell (m) burning-vegetation point lights are merged into. */
const BURN_LIGHT_CELL = 14;
/**
 * Hard cap on point lights the fire system contributes. Every extra light is
 * another iteration of the `pointLights` loop for every lit fragment on
 * screen, and grass alone is ~35k instances.
 */
const MAX_FIRE_LIGHTS = 8;

/**
 * Emit every flame in the world and return the point lights they cast, nearest
 * first. The caller truncates to MAX_WORLD_LIGHTS.
 *
 * Lights and billboards are produced together on purpose: they used to be
 * computed in two unrelated places, which is how burning trees ended up
 * glowing brightly while lighting nothing at all.
 */
export function emitWorldFire(fx: FireFX, input: WorldFireInput): FireLight[] {
  const { eye, nowS } = input;
  const lights: FireLight[] = [];
  const d2of = (x: number, y: number, z: number): number =>
    (x - eye[0]) ** 2 + (y - eye[1]) ** 2 + (z - eye[2]) ** 2;

  if (input.interiorLights !== null) {
    // Indoors: the interior generator already placed and culled these, and
    // each one carries the size of flame it wants.
    for (const l of input.interiorLights) {
      const scale = l.flameScale ?? 0;
      if (scale <= 0) continue;
      fx.torch(l.pos[0], l.pos[1], l.pos[2], scale, fireSeed(l.pos[0], l.pos[2]));
    }
    return lights; // interiors keep their own light set; caller handles it
  }

  for (const f of input.fires) {
    const fuel = liveFuelAt(f, nowS);
    if (fuel <= 0) continue;
    const power = Math.min(1, fuel / DYING_FUEL_S);
    const forge = f.kind === 'forge';
    fx.campfire(f.x, f.y, f.z, forge, power, fireSeed(f.x, f.z));
    const d2 = d2of(f.x, f.y, f.z);
    if (d2 <= 80 * 80) {
      const k = 0.45 + 0.55 * power;
      lights.push({
        // Lifted clear of the logs: a light sitting inside the fuel blows the
        // logs out to bone-white at point-blank inverse-square range.
        pos: [f.x, f.y + (forge ? 1.15 : 0.78), f.z],
        // Forges burn hotter and whiter than an open campfire. Firelight is
        // much more orange than a naive 2:1 red:green ratio suggests — too
        // much green and the grass round the fire goes radioactive.
        color: forge ? [2.9 * k, 1.62 * k, 0.62 * k] : [2.5 * k, 1.10 * k, 0.34 * k],
        radius: forge ? 13 : 10.5,
        d2,
      });
    }
  }

  // Burning vegetation. The billboards are per item, but the LIGHTS are
  // CLUSTERED on a coarse grid: `pointLights` runs its whole loop for every
  // terrain, grass, tree and character fragment on screen, so handing it
  // sixteen individual burning trees cost ~19 fps in a lightning storm. A
  // forest fire is spatially clustered anyway, and one brighter light per
  // ~14 m cell looks the same as sixteen overlapping ones.
  const clusters = new Map<number, {
    wx: number; wy: number; wz: number; w: number; n: number;
  }>();
  for (const b of input.burning) {
    const bush = b.kind === 'bush';
    const power = Math.min(1, Math.max(0, (b.untilS - nowS) / DYING_BURN_S));
    fx.burningVeg(b.x, b.y, b.z, bush, power, fireSeed(b.x, b.z));
    if (d2of(b.x, b.y, b.z) > 85 * 85) continue;
    const key = (Math.floor(b.x / BURN_LIGHT_CELL) * 4093
      + Math.floor(b.z / BURN_LIGHT_CELL)) | 0;
    const w = (bush ? 0.45 : 1) * (0.5 + 0.5 * power);
    const c = clusters.get(key);
    if (c === undefined) {
      clusters.set(key, {
        wx: b.x * w, wy: (b.y + (bush ? 0.7 : 2.4)) * w, wz: b.z * w, w, n: 1,
      });
    } else {
      c.wx += b.x * w; c.wy += (b.y + (bush ? 0.7 : 2.4)) * w;
      c.wz += b.z * w; c.w += w; c.n++;
    }
  }
  for (const c of clusters.values()) {
    const x = c.wx / c.w, y = c.wy / c.w, z = c.wz / c.w;
    // Brightness grows sub-linearly with the number of items in the cell, so a
    // dense blaze is brighter than one tree without becoming a white sun.
    const k = Math.min(2.2, Math.sqrt(c.w));
    lights.push({
      pos: [x, y, z],
      color: [3.0 * k, 1.55 * k, 0.55 * k],
      radius: Math.min(24, 12 + 3 * Math.sqrt(c.n)),
      d2: d2of(x, y, z),
    });
  }

  // Settlement fixtures. These get a light too — a lamp post that lights
  // nothing is just a glowing box on a stick.
  for (const f of input.settlementFlames) {
    fx.torch(f.x, f.y, f.z, f.scale, fireSeed(f.x, f.z));
    const d2 = d2of(f.x, f.y, f.z);
    if (d2 <= 55 * 55) {
      const s = f.scale;
      lights.push({
        pos: [f.x, f.y + 0.18 * s, f.z],
        color: [1.9 * s, 0.95 * s, 0.34 * s],
        radius: 5 + 4 * s,
        d2,
      });
    }
  }

  const br = input.breath;
  if (br !== null && br.jaw > 0.2) {
    fx.breath(br.mouth, br.dir, br.jaw, 0x5eed, br.reach ?? 1, br.spark ?? false);
    // One bright light riding the jet, a third of the way down it.
    const dl = Math.hypot(br.dir[0], br.dir[1], br.dir[2]) || 1;
    const r = BREATH_RANGE * br.jaw * 0.33;
    const lx = br.mouth[0] + (br.dir[0] / dl) * r;
    const ly = br.mouth[1] + (br.dir[1] / dl) * r;
    const lz = br.mouth[2] + (br.dir[2] / dl) * r;
    lights.push({
      pos: [lx, ly, lz],
      color: [5.0 * br.jaw, 2.6 * br.jaw, 0.9 * br.jaw],
      radius: 20,
      d2: -1, // always the highest-priority light while it is firing
    });
  }

  // Wild fliers attacking. Seeded per index so two wyverns breathing at once
  // do not produce visibly cloned jets, and each gets its own light so a
  // night attack from above actually illuminates the ground under it.
  let wbi = 0;
  for (const wb of input.extraBreaths ?? []) {
    if (wb.jaw <= 0.2) continue;
    fx.breath(wb.mouth, wb.dir, wb.jaw, 0x9f00 + wbi * 7919,
      wb.reach ?? 1, wb.spark ?? false);
    const dl = Math.hypot(wb.dir[0], wb.dir[1], wb.dir[2]) || 1;
    const r = BREATH_RANGE * (wb.reach ?? 1) * wb.jaw * 0.33;
    lights.push({
      pos: [
        wb.mouth[0] + (wb.dir[0] / dl) * r,
        wb.mouth[1] + (wb.dir[1] / dl) * r,
        wb.mouth[2] + (wb.dir[2] / dl) * r,
      ],
      color: [4.2 * wb.jaw, 2.2 * wb.jaw, 0.8 * wb.jaw],
      radius: 16,
      d2: 0,
    });
    wbi++;
  }

  lights.sort((a, b) => a.d2 - b.d2);
  // Nearest-first, then truncated well below MAX_WORLD_LIGHTS. A village at
  // night can offer twenty torches and a forest fire a dozen clusters; the
  // eight nearest carry the scene and the rest stay purely emissive.
  return lights.length > MAX_FIRE_LIGHTS
    ? lights.slice(0, MAX_FIRE_LIGHTS) : lights;
}
