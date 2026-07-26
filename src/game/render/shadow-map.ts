/**
 * Cascaded shadow maps.
 *
 * Three cascades over a 2048² depth array. Each cascade fits an orthographic
 * frustum to the bounding **sphere** of its slice of the view frustum, not to
 * the slice's corners: a sphere is rotation-invariant, so the projection's
 * size stays constant as the camera turns and the shadow edges do not crawl.
 *
 * The remaining shimmer — from translation — is removed by snapping the
 * projection origin to whole shadow texels. Without both of those, moving the
 * camera makes every shadow boundary swim, which reads worse than having no
 * shadows at all.
 */

import { lookAt, orthoZO, multiply, normalize, type Mat4, type Vec3 } from '../math';
import shadowWgsl from '../shaders/shadow.wgsl?raw';
import { wgsl } from '../shaders/include';

export const SHADOW_RESOLUTION = 2048;
export const CASCADE_COUNT = 3;

/** Cascade far distances in metres. Tuned for a third-person camera: the
 *  near cascade covers the player and their immediate surroundings. */
export const CASCADE_SPLITS: readonly number[] = [22, 65, 190];

/** Uniform slots must be 256-byte aligned to use dynamic offsets. */
const CASCADE_UBO_STRIDE = 256;

export interface ShadowCascade {
  viewProj: Mat4;
  /** World-space size of one shadow texel — drives normal-offset bias. */
  texelWorld: number;
}

export class ShadowMap {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly sampler: GPUSampler;
  readonly cascades: ShadowCascade[] = [];

  readonly frameLayout: GPUBindGroupLayout;
  readonly objectLayout: GPUBindGroupLayout;
  readonly instanceLayout: GPUBindGroupLayout;

  /**
   * Depth-only pipelines, keyed by the vertex stride they consume. The stride
   * MUST match the buffer being drawn: position lives at byte 0 of every
   * family, but the stride is how the pass walks from one vertex to the next,
   * so a mismatch reads every vertex after the first from the wrong offset and
   * the silhouette drifts into garbage. Characters/creatures went to 40 bytes
   * when the per-vertex material id landed and kept being drawn through the
   * 36-byte pipeline — their shadows were scrambled for exactly that reason.
   */
  readonly propPipeline24: GPURenderPipeline;
  readonly propPipeline36: GPURenderPipeline;
  readonly propPipeline40: GPURenderPipeline;
  readonly foliagePipeline: GPURenderPipeline;

  private readonly cascadeBuffer: GPUBuffer;
  private readonly cascadeData = new Float32Array(
    (CASCADE_UBO_STRIDE / 4) * CASCADE_COUNT);
  private readonly bindGroups: GPUBindGroup[] = [];
  private readonly layerViews: GPUTextureView[] = [];

  constructor(private readonly device: GPUDevice, frameBuffer: GPUBuffer) {
    this.texture = device.createTexture({
      label: 'shadow-cascades',
      size: {
        width: SHADOW_RESOLUTION,
        height: SHADOW_RESOLUTION,
        depthOrArrayLayers: CASCADE_COUNT,
      },
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.view = this.texture.createView({ dimension: '2d-array' });
    for (let i = 0; i < CASCADE_COUNT; i++) {
      this.layerViews.push(this.texture.createView({
        dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1,
      }));
    }

    this.sampler = device.createSampler({
      label: 'shadow-sampler',
      compare: 'less',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.cascadeBuffer = device.createBuffer({
      label: 'shadow-cascade-uniforms',
      size: CASCADE_UBO_STRIDE * CASCADE_COUNT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.frameLayout = device.createBindGroupLayout({
      label: 'shadow-frame-bgl',
      entries: [
        {
          binding: 0, visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1, visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 64 },
        },
      ],
    });
    this.objectLayout = device.createBindGroupLayout({
      label: 'shadow-object-bgl',
      entries: [{
        binding: 0, visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'uniform' },
      }],
    });
    this.instanceLayout = device.createBindGroupLayout({
      label: 'shadow-instance-bgl',
      entries: [{
        binding: 1, visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'read-only-storage' },
      }],
    });

    for (let i = 0; i < CASCADE_COUNT; i++) {
      this.bindGroups.push(device.createBindGroup({
        label: `shadow-frame-bg${i}`,
        layout: this.frameLayout,
        entries: [
          { binding: 0, resource: { buffer: frameBuffer } },
          { binding: 1, resource: { buffer: this.cascadeBuffer, size: 64 } },
        ],
      }));
    }

    const module = device.createShaderModule({
      label: 'shadow-shader', code: wgsl(shadowWgsl),
    });

    const makePipeline = (
      label: string, entryPoint: string, stride: number,
      group1: GPUBindGroupLayout,
    ) => device.createRenderPipeline({
      label,
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.frameLayout, group1],
      }),
      vertex: {
        module, entryPoint,
        buffers: [{
          arrayStride: stride,
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
        }],
      },
      // No fragment stage: depth-only is roughly twice as fast.
      primitive: {
        topology: 'triangle-list',
        // Front-face culling pushes acne to surfaces the camera cannot see.
        // Combined with normal-offset bias this removes peter-panning too.
        cullMode: 'front',
        frontFace: 'ccw',
      },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'less',
        // Kept small on purpose. Depth bias is in the cascade's own depth
        // units and the three cascades span ~187 m, ~318 m and ~699 m, so no
        // single constant is correct for all of them. The world-space
        // normal-offset in sunShadow() does the real work.
        depthBias: 1,
        depthBiasSlopeScale: 1.5,
        depthBiasClamp: 0.005,
      },
    });

    this.propPipeline24 = makePipeline(
      'shadow-prop-24', 'vs_prop', 24, this.objectLayout);
    this.propPipeline36 = makePipeline(
      'shadow-prop-36', 'vs_prop', 36, this.objectLayout);
    this.propPipeline40 = makePipeline(
      'shadow-prop-40', 'vs_prop', 40, this.objectLayout);
    this.foliagePipeline = makePipeline(
      'shadow-foliage', 'vs_foliage', 24, this.instanceLayout);
  }

  /**
   * Recompute all cascade matrices for this frame's camera and sun.
   * `sunDir` points TOWARD the sun.
   */
  update(
    cameraPos: Vec3, forward: Vec3, fovY: number, aspect: number,
    near: number, sunDir: Vec3,
  ): void {
    this.cascades.length = 0;
    const f = normalize(forward);
    // A sun exactly overhead makes lookAt's up vector degenerate.
    const up: Vec3 = Math.abs(sunDir[1]) > 0.985 ? [0, 0, 1] : [0, 1, 0];

    let sliceNear = near;
    for (let i = 0; i < CASCADE_COUNT; i++) {
      const sliceFar = CASCADE_SPLITS[i];
      const { center, radius } = frustumSlicesphere(
        cameraPos, f, fovY, aspect, sliceNear, sliceFar);

      // Put the light *at* the sun's side and look back along its rays.
      // `sunDir` points toward the sun, and lookAt's view direction is
      // (target - eye), so the eye must be offset along +sunDir — offsetting
      // the other way lights the scene from the anti-solar point and every
      // shadow falls on the wrong side of its caster.
      const back = radius + 120;
      const eye: Vec3 = [
        center[0] + sunDir[0] * back,
        center[1] + sunDir[1] * back,
        center[2] + sunDir[2] * back,
      ];
      const view = lookAt(eye, center, up);

      // Snap the projection to whole texels so shadows do not crawl as the
      // camera translates. The centre's light-space XY is quantised and the
      // residue folded into the ortho bounds.
      const texel = (radius * 2) / SHADOW_RESOLUTION;
      const cx = view[0] * center[0] + view[4] * center[1] + view[8] * center[2] + view[12];
      const cy = view[1] * center[0] + view[5] * center[1] + view[9] * center[2] + view[13];
      const ox = Math.round(cx / texel) * texel;
      const oy = Math.round(cy / texel) * texel;

      const proj = orthoZO(
        -radius + ox, radius + ox, -radius + oy, radius + oy,
        1, back + radius * 2);

      const viewProj = multiply(new Float32Array(16), proj, view);
      this.cascades.push({ viewProj, texelWorld: texel });

      // Overlap slices slightly so the blend region between cascades always
      // has valid depth on both sides.
      sliceNear = sliceFar * 0.92;
    }

    for (let i = 0; i < CASCADE_COUNT; i++) {
      this.cascadeData.set(
        this.cascades[i].viewProj, i * (CASCADE_UBO_STRIDE / 4));
    }
    this.device.queue.writeBuffer(this.cascadeBuffer, 0, this.cascadeData);
  }

  /** Begin the depth-only pass for one cascade. */
  beginPass(encoder: GPUCommandEncoder, cascade: number): GPURenderPassEncoder {
    const pass = encoder.beginRenderPass({
      label: `shadow-pass-${cascade}`,
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.layerViews[cascade],
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setBindGroup(0, this.bindGroups[cascade], [cascade * CASCADE_UBO_STRIDE]);
    return pass;
  }

  /** Shadow-texel world size of the near cascade (the bias reference). */
  get baseTexelWorld(): number {
    return this.cascades.length > 0 ? this.cascades[0].texelWorld : 0.02;
  }

  destroy(): void {
    this.texture.destroy();
    this.cascadeBuffer.destroy();
  }
}

/**
 * Bounding sphere of a view-frustum slice. Standard closed form: for a slice
 * [n, f] with half-diagonal slope k, the sphere either touches the far plane's
 * corners or is centred between the two planes.
 */
function frustumSlicesphere(
  cameraPos: Vec3, forward: Vec3, fovY: number, aspect: number,
  n: number, f: number,
): { center: Vec3; radius: number } {
  const t = Math.tan(fovY / 2);
  const k = Math.sqrt(1 + aspect * aspect) * t;
  const k2 = k * k;

  let centerDist: number;
  let radius: number;
  if (k2 >= (f - n) / (f + n)) {
    centerDist = f;
    radius = f * k;
  } else {
    centerDist = 0.5 * (f + n) * (1 + k2);
    radius = 0.5 * Math.sqrt(
      (f - n) * (f - n)
      + 2 * (f * f + n * n) * k2
      + (f + n) * (f + n) * k2 * k2);
  }

  return {
    center: [
      cameraPos[0] + forward[0] * centerDist,
      cameraPos[1] + forward[1] * centerDist,
      cameraPos[2] + forward[2] * centerDist,
    ],
    radius,
  };
}
