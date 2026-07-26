/**
 * Procedural material atlas.
 *
 * The game ships no image assets, so all 20 surface materials are synthesised
 * on the GPU at boot into a pair of mipmapped rgba8 texture arrays (see
 * shaders/materials.wgsl). Baking once beats evaluating noise per pixel every
 * frame twice over: it is far cheaper at draw time, and hardware trilinear
 * filtering over real mips removes the shimmering that per-pixel procedural
 * detail always suffers from at distance.
 *
 * Every mip is generated analytically at its own resolution with the fine
 * octaves band-limited away, rather than box-filtered down from mip 0 — the
 * result stays crisp where a downsampled chain would turn to grey mush.
 */

import materialsWgsl from '../shaders/materials.wgsl?raw';

// Layer indices live in the pure material-layers module so the node-testable
// CPU mesh builders can reach them without pulling in this file's WGSL import.
export { MATERIAL_LAYERS as MATERIALS, MATERIAL_COUNT } from './material-layers';
import { MATERIAL_COUNT } from './material-layers';

const ATLAS_SIZE = 512;
/** UBO slots must be 256-byte aligned for dynamic offsets. */
const UBO_STRIDE = 256;

export class MaterialAtlas {
  readonly albedo: GPUTexture;
  readonly normal: GPUTexture;
  readonly albedoView: GPUTextureView;
  readonly normalView: GPUTextureView;
  readonly sampler: GPUSampler;
  readonly mipCount: number;

  constructor(private readonly device: GPUDevice) {
    this.mipCount = Math.floor(Math.log2(ATLAS_SIZE)) + 1;

    const desc: GPUTextureDescriptor = {
      size: { width: ATLAS_SIZE, height: ATLAS_SIZE, depthOrArrayLayers: MATERIAL_COUNT },
      format: 'rgba8unorm',
      mipLevelCount: this.mipCount,
      dimension: '2d',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    };
    this.albedo = device.createTexture({ ...desc, label: 'material-albedo' });
    this.normal = device.createTexture({ ...desc, label: 'material-normal' });

    this.albedoView = this.albedo.createView({ dimension: '2d-array' });
    this.normalView = this.normal.createView({ dimension: '2d-array' });

    this.sampler = device.createSampler({
      label: 'material-sampler',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      // Anisotropy is what keeps ground texture legible at grazing angles;
      // without it terrain smears into mush a few metres out.
      maxAnisotropy: 16,
    });

    this.bake();
  }

  /** Run the generator compute pass over every mip of every layer. */
  private bake(): void {
    const device = this.device;
    const module = device.createShaderModule({
      label: 'material-gen', code: materialsWgsl,
    });

    const layout = device.createBindGroupLayout({
      label: 'material-gen-bgl',
      entries: [
        {
          binding: 0, visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 },
        },
        {
          binding: 1, visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'write-only', format: 'rgba8unorm', viewDimension: '2d-array',
          },
        },
        {
          binding: 2, visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'write-only', format: 'rgba8unorm', viewDimension: '2d-array',
          },
        },
      ],
    });

    const pipeline = device.createComputePipeline({
      label: 'material-gen-pipeline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module, entryPoint: 'cs_main' },
    });

    // One 256-byte-aligned slot per mip so all levels bake in a single pass.
    const params = new Uint8Array(UBO_STRIDE * this.mipCount);
    const view = new DataView(params.buffer);
    for (let m = 0; m < this.mipCount; m++) {
      view.setFloat32(m * UBO_STRIDE, ATLAS_SIZE >> m, true);
    }
    const ubo = device.createBuffer({
      label: 'material-gen-params',
      size: params.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(ubo, 0, params);

    const encoder = device.createCommandEncoder({ label: 'material-bake' });
    const pass = encoder.beginComputePass({ label: 'material-bake-pass' });
    pass.setPipeline(pipeline);

    for (let m = 0; m < this.mipCount; m++) {
      const size = ATLAS_SIZE >> m;
      const bindGroup = device.createBindGroup({
        label: `material-gen-bg-mip${m}`,
        layout,
        entries: [
          { binding: 0, resource: { buffer: ubo, size: 16 } },
          {
            binding: 1,
            resource: this.albedo.createView({
              dimension: '2d-array', baseMipLevel: m, mipLevelCount: 1,
            }),
          },
          {
            binding: 2,
            resource: this.normal.createView({
              dimension: '2d-array', baseMipLevel: m, mipLevelCount: 1,
            }),
          },
        ],
      });
      pass.setBindGroup(0, bindGroup, [m * UBO_STRIDE]);
      const groups = Math.ceil(size / 8);
      pass.dispatchWorkgroups(groups, groups, MATERIAL_COUNT);
    }

    pass.end();
    device.queue.submit([encoder.finish()]);
    ubo.destroy();
  }

  destroy(): void {
    this.albedo.destroy();
    this.normal.destroy();
  }
}
