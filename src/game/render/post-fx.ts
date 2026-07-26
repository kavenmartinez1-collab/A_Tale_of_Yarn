/**
 * Offscreen render targets and the post-process chain.
 *
 * The scene no longer draws straight to the swapchain. It renders to a linear
 * HDR target plus a packed normal/ambient-ratio G-buffer and a sampleable
 * depth buffer, and this module turns that into the final image:
 *
 *   SSAO (half res) -> bilateral blur -> bloom (6-level down/up chain)
 *   -> god rays (quarter res) -> composite (AO + bloom + ACES + grade)
 *   -> FXAA -> swapchain
 *
 * Everything here is resolution-derived and rebuilt on resize.
 */

import ssaoWgsl from '../shaders/ssao.wgsl?raw';
import bloomWgsl from '../shaders/bloom.wgsl?raw';
import godraysWgsl from '../shaders/godrays.wgsl?raw';
import compositeWgsl from '../shaders/composite.wgsl?raw';
import fxaaWgsl from '../shaders/fxaa.wgsl?raw';
import { wgsl } from '../shaders/include';

export const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
export const NORMAL_FORMAT: GPUTextureFormat = 'rgba8unorm';
export const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';
const AO_FORMAT: GPUTextureFormat = 'r8unorm';
const LDR_FORMAT: GPUTextureFormat = 'rgba8unorm';

const BLOOM_LEVELS = 6;
const UBO_STRIDE = 256;

/** Tunables the game can drive per frame (weather, vitals, underwater). */
export interface PostSettings {
  exposure: number;
  bloomIntensity: number;
  bloomThreshold: number;
  aoStrength: number;
  vignette: number;
  grain: number;
  chromatic: number;
  saturation: number;
  contrast: number;
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
  /** 0 = above water, 1 = fully submerged. */
  underwater: number;
  /** 0..1 red damage pulse. */
  hurt: number;
  /** Sun position in UV space + visibility, from the caller's projection. */
  sunUV: [number, number];
  sunVisible: number;
  godrayStrength: number;
}

export const DEFAULT_POST: PostSettings = {
  exposure: 1.15,
  bloomIntensity: 0.055,
  bloomThreshold: 1.05,
  aoStrength: 0.85,
  vignette: 0.38,
  grain: 0.014,
  // Scaled by r^2 then applied as a UV offset — at 1600 px wide this is about
  // a pixel and a half of fringing in the corners, which is the most that
  // reads as a lens and not as a broken render target.
  chromatic: 0.006,
  saturation: 1.06,
  contrast: 1.04,
  shadowTint: [0.86, 0.94, 1.12],
  highlightTint: [1.08, 1.02, 0.92],
  underwater: 0,
  hurt: 0,
  sunUV: [0.5, 0.5],
  sunVisible: 0,
  godrayStrength: 1,
};

interface Target {
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
}

function makeTarget(
  device: GPUDevice, label: string, w: number, h: number,
  format: GPUTextureFormat, extraUsage = 0,
): Target {
  const texture = device.createTexture({
    label,
    size: { width: Math.max(1, w), height: Math.max(1, h) },
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      | extraUsage,
  });
  return { texture, view: texture.createView(), width: w, height: h };
}

export class PostFX {
  scene!: Target;
  normal!: Target;
  depth!: Target;
  private ao!: Target;
  private aoBlur!: Target;
  private bloom: Target[] = [];
  private rays!: Target;
  private ldr!: Target;
  private width = 0;
  private height = 0;

  private readonly linearSampler: GPUSampler;

  private readonly ssaoLayout: GPUBindGroupLayout;
  private readonly aoSrcLayout: GPUBindGroupLayout;
  private readonly bloomLayout: GPUBindGroupLayout;
  private readonly raysLayout: GPUBindGroupLayout;
  private readonly compositeLayout: GPUBindGroupLayout;
  private readonly fxaaLayout: GPUBindGroupLayout;

  private readonly ssaoPipeline: GPURenderPipeline;
  private readonly blurPipeline: GPURenderPipeline;
  private readonly prefilterPipeline: GPURenderPipeline;
  private readonly downPipeline: GPURenderPipeline;
  private readonly upPipeline: GPURenderPipeline;
  private readonly raysPipeline: GPURenderPipeline;
  private readonly compositePipeline: GPURenderPipeline;
  private readonly fxaaPipeline: GPURenderPipeline;

  private readonly ssaoParams: GPUBuffer;
  private readonly bloomParams: GPUBuffer;
  private readonly rayParams: GPUBuffer;
  private readonly postParams: GPUBuffer;
  private readonly bloomData = new Float32Array((UBO_STRIDE / 4) * 12);

  // Bind groups are rebuilt on resize, not per frame.
  private ssaoBG: GPUBindGroup | null = null;
  private blurXBG: GPUBindGroup | null = null;
  private blurYBG: GPUBindGroup | null = null;
  private bloomBGs: GPUBindGroup[] = [];
  private raysBG: GPUBindGroup | null = null;
  private compositeBG: GPUBindGroup | null = null;
  private fxaaBG: GPUBindGroup | null = null;

  constructor(
    private readonly device: GPUDevice,
    private readonly frameBuffer: GPUBuffer,
    private readonly outputFormat: GPUTextureFormat,
  ) {
    this.linearSampler = device.createSampler({
      label: 'post-linear',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    const uniform = (visibility: number, hasDynamicOffset = false, min = 16) =>
      ({ buffer: { type: 'uniform' as const, hasDynamicOffset, minBindingSize: min } });
    const tex = () => ({ texture: { sampleType: 'float' as const } });
    const F = GPUShaderStage.FRAGMENT;

    this.ssaoLayout = device.createBindGroupLayout({
      label: 'ssao-bgl',
      entries: [
        { binding: 0, visibility: F, ...uniform(F, false, 496) },
        { binding: 1, visibility: F, ...uniform(F, true, 16) },
        { binding: 2, visibility: F, texture: { sampleType: 'depth' } },
        { binding: 3, visibility: F, ...tex() },
        { binding: 4, visibility: F, sampler: { type: 'filtering' } },
      ],
    });
    // Blur source in its own group — see the note in ssao.wgsl.
    this.aoSrcLayout = device.createBindGroupLayout({
      label: 'ssao-src-bgl',
      entries: [{ binding: 0, visibility: F, ...tex() }],
    });
    this.bloomLayout = device.createBindGroupLayout({
      label: 'bloom-bgl',
      entries: [
        { binding: 0, visibility: F, ...uniform(F, true, 32) },
        { binding: 1, visibility: F, ...tex() },
        { binding: 2, visibility: F, sampler: { type: 'filtering' } },
      ],
    });
    this.raysLayout = device.createBindGroupLayout({
      label: 'rays-bgl',
      entries: [
        { binding: 0, visibility: F, ...uniform(F, false, 496) },
        { binding: 1, visibility: F, ...uniform(F, false, 32) },
        { binding: 2, visibility: F, ...tex() },
        { binding: 3, visibility: F, texture: { sampleType: 'depth' } },
        { binding: 4, visibility: F, sampler: { type: 'filtering' } },
      ],
    });
    this.compositeLayout = device.createBindGroupLayout({
      label: 'composite-bgl',
      entries: [
        { binding: 0, visibility: F, ...uniform(F, false, 496) },
        { binding: 1, visibility: F, ...uniform(F, false, 64) },
        { binding: 2, visibility: F, ...tex() },
        { binding: 3, visibility: F, ...tex() },
        { binding: 4, visibility: F, ...tex() },
        { binding: 5, visibility: F, ...tex() },
        { binding: 6, visibility: F, ...tex() },
        { binding: 7, visibility: F, sampler: { type: 'filtering' } },
      ],
    });
    this.fxaaLayout = device.createBindGroupLayout({
      label: 'fxaa-bgl',
      entries: [
        { binding: 0, visibility: F, ...tex() },
        { binding: 1, visibility: F, sampler: { type: 'filtering' } },
      ],
    });

    const fsPipeline = (
      label: string, code: string, layouts: GPUBindGroupLayout[],
      entry: string, format: GPUTextureFormat, blend?: GPUBlendState,
    ) => {
      const module = device.createShaderModule({ label, code: wgsl(code) });
      return device.createRenderPipeline({
        label,
        layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: {
          module, entryPoint: entry,
          targets: [{ format, blend }],
        },
        primitive: { topology: 'triangle-list' },
      });
    };

    this.ssaoPipeline = fsPipeline(
      'ssao', ssaoWgsl, [this.ssaoLayout], 'fs_ao', AO_FORMAT);
    this.blurPipeline = fsPipeline(
      'ssao-blur', ssaoWgsl, [this.ssaoLayout, this.aoSrcLayout], 'fs_blur',
      AO_FORMAT);
    this.prefilterPipeline = fsPipeline(
      'bloom-prefilter', bloomWgsl, [this.bloomLayout], 'fs_prefilter', HDR_FORMAT);
    this.downPipeline = fsPipeline(
      'bloom-down', bloomWgsl, [this.bloomLayout], 'fs_down', HDR_FORMAT);
    // Upsample accumulates into the level below, so it blends additively.
    this.upPipeline = fsPipeline(
      'bloom-up', bloomWgsl, [this.bloomLayout], 'fs_up', HDR_FORMAT, {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      });
    this.raysPipeline = fsPipeline(
      'godrays', godraysWgsl, [this.raysLayout], 'fs_rays', HDR_FORMAT);
    this.compositePipeline = fsPipeline(
      'composite', compositeWgsl, [this.compositeLayout], 'fs_composite', LDR_FORMAT);
    this.fxaaPipeline = fsPipeline(
      'fxaa', fxaaWgsl, [this.fxaaLayout], 'fs_fxaa', outputFormat);

    this.ssaoParams = device.createBuffer({
      label: 'ssao-params', size: UBO_STRIDE * 3,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bloomParams = device.createBuffer({
      label: 'bloom-params', size: UBO_STRIDE * 12,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.rayParams = device.createBuffer({
      label: 'ray-params', size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.postParams = device.createBuffer({
      label: 'post-params', size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /** (Re)allocate every size-dependent target. Cheap no-op if unchanged. */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.destroyTargets();

    const d = this.device;
    // COPY_SRC: the transparent pass snapshots the opaque result so water can
    // refract it.
    this.scene = makeTarget(d, 'hdr-scene', width, height, HDR_FORMAT,
      GPUTextureUsage.COPY_SRC);
    this.normal = makeTarget(d, 'gbuffer-normal', width, height, NORMAL_FORMAT);
    this.depth = makeTarget(d, 'scene-depth', width, height, DEPTH_FORMAT);
    this.ao = makeTarget(d, 'ssao', width >> 1, height >> 1, AO_FORMAT);
    this.aoBlur = makeTarget(d, 'ssao-blur', width >> 1, height >> 1, AO_FORMAT);
    this.rays = makeTarget(d, 'godrays', width >> 2, height >> 2, HDR_FORMAT);
    this.ldr = makeTarget(d, 'ldr', width, height, LDR_FORMAT);

    this.bloom = [];
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const w = Math.max(1, width >> (i + 1));
      const h = Math.max(1, height >> (i + 1));
      this.bloom.push(makeTarget(d, `bloom-${i}`, w, h, HDR_FORMAT));
    }

    this.writeStaticParams();
    this.rebuildBindGroups();
  }

  private writeStaticParams(): void {
    // SSAO: radius, intensity, bias, blur axis.
    const ao = new Float32Array((UBO_STRIDE / 4) * 3);
    ao.set([0.85, 1.05, 0.022, 0], 0);
    ao.set([0.85, 1.05, 0.022, 0], UBO_STRIDE / 4);       // blur X
    ao.set([0.85, 1.05, 0.022, 1], (UBO_STRIDE / 4) * 2); // blur Y
    this.device.queue.writeBuffer(this.ssaoParams, 0, ao);
  }

  private rebuildBindGroups(): void {
    const d = this.device;
    const S = this.linearSampler;

    this.ssaoBG = d.createBindGroup({
      label: 'ssao-bg', layout: this.ssaoLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: { buffer: this.ssaoParams, size: 16 } },
        { binding: 2, resource: this.depth.view },
        { binding: 3, resource: this.normal.view },
        { binding: 4, resource: S },
      ],
    });
    // Blur X reads `ao` writes `aoBlur`; blur Y reads `aoBlur` writes `ao`.
    this.blurXBG = d.createBindGroup({
      label: 'ssao-src-ao', layout: this.aoSrcLayout,
      entries: [{ binding: 0, resource: this.ao.view }],
    });
    this.blurYBG = d.createBindGroup({
      label: 'ssao-src-blur', layout: this.aoSrcLayout,
      entries: [{ binding: 0, resource: this.aoBlur.view }],
    });

    // Bloom chain: slot 0 = prefilter (source = scene), 1..5 = downsample,
    // 6..10 = upsample.
    this.bloomBGs = [];
    const bloomBG = (src: GPUTextureView, label: string) => d.createBindGroup({
      label, layout: this.bloomLayout,
      entries: [
        { binding: 0, resource: { buffer: this.bloomParams, size: 32 } },
        { binding: 1, resource: src },
        { binding: 2, resource: S },
      ],
    });
    this.bloomBGs.push(bloomBG(this.scene.view, 'bloom-prefilter-bg'));
    for (let i = 1; i < BLOOM_LEVELS; i++) {
      this.bloomBGs.push(bloomBG(this.bloom[i - 1].view, `bloom-down-${i}-bg`));
    }
    for (let i = BLOOM_LEVELS - 1; i >= 1; i--) {
      this.bloomBGs.push(bloomBG(this.bloom[i].view, `bloom-up-${i}-bg`));
    }

    this.raysBG = d.createBindGroup({
      label: 'rays-bg', layout: this.raysLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: { buffer: this.rayParams } },
        { binding: 2, resource: this.bloom[1].view },
        { binding: 3, resource: this.depth.view },
        { binding: 4, resource: S },
      ],
    });

    this.compositeBG = d.createBindGroup({
      label: 'composite-bg', layout: this.compositeLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: { buffer: this.postParams } },
        { binding: 2, resource: this.scene.view },
        { binding: 3, resource: this.bloom[0].view },
        { binding: 4, resource: this.ao.view },
        { binding: 5, resource: this.normal.view },
        { binding: 6, resource: this.rays.view },
        { binding: 7, resource: S },
      ],
    });

    this.fxaaBG = d.createBindGroup({
      label: 'fxaa-bg', layout: this.fxaaLayout,
      entries: [
        { binding: 0, resource: this.ldr.view },
        { binding: 1, resource: S },
      ],
    });

    // Bloom per-level params: source texel size + threshold/knee/intensity.
    const bd = this.bloomData;
    bd.fill(0);
    const slot = (i: number) => i * (UBO_STRIDE / 4);
    // Prefilter samples the full-res scene.
    bd.set([1 / this.width, 1 / this.height, 0, 0], slot(0));
    for (let i = 1; i < BLOOM_LEVELS; i++) {
      const s = this.bloom[i - 1];
      bd.set([1 / s.width, 1 / s.height, 0, 0], slot(i));
    }
    for (let i = BLOOM_LEVELS - 1, k = BLOOM_LEVELS; i >= 1; i--, k++) {
      const s = this.bloom[i];
      // w doubles as the tent radius on upsample.
      bd.set([1 / s.width, 1 / s.height, 0, 1.35], slot(k));
      bd.set([1.0, 0, 0, 0], slot(k) + 4);
    }
    this.device.queue.writeBuffer(this.bloomParams, 0, bd);
  }

  /** Push per-frame threshold/knee into the prefilter slot. */
  private updateBloomThreshold(threshold: number): void {
    const buf = new Float32Array(8);
    buf.set([1 / this.width, 1 / this.height, threshold, threshold * 0.6], 0);
    buf.set([1, 0, 0, 0], 4);
    this.device.queue.writeBuffer(this.bloomParams, 0, buf);
  }

  /** Run the whole post chain and present into `swapchainView`. */
  render(
    encoder: GPUCommandEncoder, swapchainView: GPUTextureView,
    s: PostSettings,
  ): void {
    this.updateBloomThreshold(s.bloomThreshold);

    this.device.queue.writeBuffer(this.rayParams, 0, new Float32Array([
      s.sunUV[0], s.sunUV[1], s.sunVisible, 0.965,
      0.85, 0.55 * s.godrayStrength, 1, 0,
    ]));
    this.device.queue.writeBuffer(this.postParams, 0, new Float32Array([
      s.exposure, s.bloomIntensity, s.aoStrength, s.vignette,
      s.grain, s.chromatic, s.saturation, s.contrast,
      s.shadowTint[0], s.shadowTint[1], s.shadowTint[2], s.underwater,
      s.highlightTint[0], s.highlightTint[1], s.highlightTint[2], s.hurt,
    ]));

    const draw = (
      label: string, view: GPUTextureView, pipeline: GPURenderPipeline,
      bindGroup: GPUBindGroup, offsets?: number[], load: GPULoadOp = 'clear',
      group1?: GPUBindGroup,
    ) => {
      const pass = encoder.beginRenderPass({
        label,
        colorAttachments: [{
          view,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: load,
          storeOp: 'store',
        }],
      });
      pass.setPipeline(pipeline);
      // Omit the third argument entirely when there are no dynamic offsets.
      // setBindGroup is overloaded on it, and passing `undefined` explicitly
      // makes some Chrome builds try the Uint32Array overload and throw
      // "The provided value cannot be converted to a sequence" — which kills
      // the whole frame and presents black. Other builds tolerate it, so this
      // reproduces on some machines and not others.
      if (offsets !== undefined) {
        pass.setBindGroup(0, bindGroup, offsets);
      } else {
        pass.setBindGroup(0, bindGroup);
      }
      if (group1) pass.setBindGroup(1, group1);
      pass.draw(3);
      pass.end();
    };

    // --- ambient occlusion (half res, separable depth-aware blur) --------
    draw('ssao', this.ao.view, this.ssaoPipeline, this.ssaoBG!, [0]);
    draw('ssao-blur-x', this.aoBlur.view, this.blurPipeline, this.ssaoBG!,
      [UBO_STRIDE], 'clear', this.blurXBG!);
    draw('ssao-blur-y', this.ao.view, this.blurPipeline, this.ssaoBG!,
      [UBO_STRIDE * 2], 'clear', this.blurYBG!);

    // --- bloom ----------------------------------------------------------
    draw('bloom-prefilter', this.bloom[0].view, this.prefilterPipeline,
      this.bloomBGs[0], [0]);
    for (let i = 1; i < BLOOM_LEVELS; i++) {
      draw(`bloom-down-${i}`, this.bloom[i].view, this.downPipeline,
        this.bloomBGs[i], [i * UBO_STRIDE]);
    }
    for (let i = BLOOM_LEVELS - 1, k = BLOOM_LEVELS; i >= 1; i--, k++) {
      // Additive blend onto the level below — hence loadOp 'load'.
      draw(`bloom-up-${i}`, this.bloom[i - 1].view, this.upPipeline,
        this.bloomBGs[k], [k * UBO_STRIDE], 'load');
    }

    // --- light shafts ---------------------------------------------------
    draw('godrays', this.rays.view, this.raysPipeline, this.raysBG!);

    // --- tonemap + grade, then edge AA to the swapchain ------------------
    draw('composite', this.ldr.view, this.compositePipeline, this.compositeBG!);
    draw('fxaa', swapchainView, this.fxaaPipeline, this.fxaaBG!);
  }

  private destroyTargets(): void {
    for (const t of [this.scene, this.normal, this.depth, this.ao, this.aoBlur,
      this.rays, this.ldr, ...this.bloom]) {
      t?.texture.destroy();
    }
    this.bloom = [];
  }

  destroy(): void {
    this.destroyTargets();
    this.ssaoParams.destroy();
    this.bloomParams.destroy();
    this.rayParams.destroy();
    this.postParams.destroy();
  }
}
