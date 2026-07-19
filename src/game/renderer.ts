/**
 * Game renderer — WebGPU render pipelines on the shared engine device.
 *
 * Owns the canvas context, depth buffer, per-frame uniform buffer, and the
 * terrain pipeline. Reuses the GPUContext singleton from src/engine/gpu-device
 * so terrain rendering and (future) LLM inference share one VRAM pool.
 */

import type { GPUContext } from '../engine/gpu-device';
import { invert, type Mat4, type Vec3 } from './math';
import terrainWgsl from './shaders/terrain.wgsl?raw';
import skyWgsl from './shaders/sky.wgsl?raw';
import dungeonWgsl from './shaders/dungeon.wgsl?raw';
import waterWgsl from './shaders/water.wgsl?raw';
import treeWgsl from './shaders/tree.wgsl?raw';
import rainWgsl from './shaders/rain.wgsl?raw';
import characterWgsl from './shaders/character.wgsl?raw';

export interface FrameUniforms {
  viewProj: Mat4;
  cameraPos: Vec3;
  sunDir: Vec3;     // normalized, points toward the sun
  fogColor: Vec3;
  fogDensity: number;
  time: number;
  sunColor: Vec3;   // direct sunlight tint × intensity (environment.ts)
  ambient: number;  // flat ambient floor
  skyZenith: Vec3;  // sky color straight up
  starVis: number;  // 0 day → 1 night
  cloudCover: number; // 0 clear → 1 overcast (sky.wgsl FBM threshold)
  rainLevel: number;  // 0 dry → 1 downpour (rain overlay intensity)
}

/** One terrain draw: a chunk mesh + its origin bind group (group 1). */
export interface TerrainDraw {
  vertexBuffer: GPUBuffer;
  /** uint16 index buffer; null → non-indexed draw. */
  indexBuffer: GPUBuffer | null;
  /** Index count (indexed) or vertex count (non-indexed). */
  count: number;
  bindGroup: GPUBindGroup;
}

/** One dungeon-pipeline draw: mesh + object group 1 + torch lights group 2. */
export interface DungeonDraw {
  draw: TerrainDraw;
  lightsBindGroup: GPUBindGroup;
}

/** One instanced tree draw: shared mesh + a chunk's instance bind group. */
export interface TreeDraw {
  vertexBuffer: GPUBuffer;
  vertexCount: number;
  instanceBindGroup: GPUBindGroup;
  instanceCount: number;
}

/** Byte size of the group-2 lights uniform: vec4 count + 32 × 32 B lights. */
export const LIGHTS_BUFFER_SIZE = 16 + 32 * 32;

// Frame uniform layout (WGSL std alignment) — 240 bytes:
//   [0..64)     viewProj mat4x4f
//   [64..128)   invViewProj mat4x4f
//   [128..140)  cameraPos vec3f (+4 pad)
//   [144..156)  sunDir vec3f (+4 pad)
//   [160..172)  fogColor vec3f
//   [172..176)  fogDensity f32 (packs into vec3 padding)
//   [176..180)  time f32 (+12 pad — next vec3 aligns to 16)
//   [192..204)  sunColor vec3f
//   [204..208)  ambient f32 (packs into vec3 padding)
//   [208..220)  skyZenith vec3f
//   [220..224)  starVis f32 (packs into vec3 padding)
//   [224..228)  cloudCover f32
//   [228..232)  rainLevel f32 (+8 pad — envPad vec2 rounds the struct to 240)
const FRAME_UNIFORM_FLOATS = 60;

export class Renderer {
  readonly device: GPUDevice;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: GPUCanvasContext;
  private readonly format: GPUTextureFormat;

  private readonly frameBuffer: GPUBuffer;
  private readonly frameData = new Float32Array(FRAME_UNIFORM_FLOATS);
  private readonly frameBindGroup: GPUBindGroup;
  private readonly chunkBindGroupLayout: GPUBindGroupLayout;
  private readonly lightsBindGroupLayout: GPUBindGroupLayout;
  private readonly terrainPipeline: GPURenderPipeline;
  private readonly dungeonPipeline: GPURenderPipeline;
  private readonly skyPipeline: GPURenderPipeline;
  private readonly waterPipeline: GPURenderPipeline;
  private readonly treePipeline: GPURenderPipeline;
  private readonly rainPipeline: GPURenderPipeline;
  private readonly characterPipeline: GPURenderPipeline;
  private readonly treeInstanceBindGroupLayout: GPUBindGroupLayout;

  private depthTexture: GPUTexture | null = null;
  private depthView: GPUTextureView | null = null;

  constructor(gpu: GPUContext, canvas: HTMLCanvasElement) {
    this.device = gpu.device;
    this.canvas = canvas;

    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('Failed to get WebGPU canvas context');
    this.context = context;

    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'opaque',
    });

    // Track CSS size → device pixels (DPR clamped to 2; the 4K-at-DPR-3 case
    // isn't worth the fill cost for a stylized game).
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    };
    resize();
    new ResizeObserver(resize).observe(canvas);

    // --- bind group layouts ---------------------------------------------
    const frameLayout = this.device.createBindGroupLayout({
      label: 'game-frame-bgl',
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      }],
    });
    this.chunkBindGroupLayout = this.device.createBindGroupLayout({
      label: 'game-object-bgl',
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      }],
    });
    this.treeInstanceBindGroupLayout = this.device.createBindGroupLayout({
      label: 'game-tree-instances-bgl',
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'read-only-storage' },
      }],
    });
    this.lightsBindGroupLayout = this.device.createBindGroupLayout({
      label: 'game-lights-bgl',
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      }],
    });

    this.frameBuffer = this.device.createBuffer({
      label: 'game-frame-uniforms',
      size: FRAME_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.frameBindGroup = this.device.createBindGroup({
      label: 'game-frame-bg',
      layout: frameLayout,
      entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }],
    });

    // --- terrain pipeline -------------------------------------------------
    const module = this.device.createShaderModule({
      label: 'terrain-shader',
      code: terrainWgsl,
    });
    this.terrainPipeline = this.device.createRenderPipeline({
      label: 'terrain-pipeline',
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [frameLayout, this.chunkBindGroupLayout],
      }),
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 24, // pos float32x3 (12 B) + tint float32x3 (12 B)
          attributes: [
            { shaderLocation: 0, offset: 0,  format: 'float32x3' }, // pos
            { shaderLocation: 1, offset: 12, format: 'float32x3' }, // tint
          ],
        }],
      },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{ format: this.format }],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back',
        frontFace: 'ccw', // mesh gen emits up-facing CCW triangles
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
    });

    // --- dungeon pipeline (interiors + entrance props, torch lights) -------
    const dungeonModule = this.device.createShaderModule({
      label: 'dungeon-shader',
      code: dungeonWgsl,
    });
    this.dungeonPipeline = this.device.createRenderPipeline({
      label: 'dungeon-pipeline',
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [frameLayout, this.chunkBindGroupLayout, this.lightsBindGroupLayout],
      }),
      vertex: {
        module: dungeonModule,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
        }],
      },
      fragment: {
        module: dungeonModule,
        entryPoint: 'fs_main',
        targets: [{ format: this.format }],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back',
        frontFace: 'ccw', // dungeon-mesh winds normals into the interior
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
    });

    // --- sky pipeline (fullscreen triangle at far depth, drawn last) -------
    const skyModule = this.device.createShaderModule({
      label: 'sky-shader',
      code: skyWgsl,
    });
    this.skyPipeline = this.device.createRenderPipeline({
      label: 'sky-pipeline',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [frameLayout] }),
      vertex: { module: skyModule, entryPoint: 'vs_main' },
      fragment: {
        module: skyModule,
        entryPoint: 'fs_main',
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: false,
        depthCompare: 'less-equal', // pass only where depth is still cleared to 1
      },
    });

    // --- water pipeline (sea-level quad, alpha-blended after the sky) ------
    const waterModule = this.device.createShaderModule({
      label: 'water-shader',
      code: waterWgsl,
    });
    this.waterPipeline = this.device.createRenderPipeline({
      label: 'water-pipeline',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [frameLayout] }),
      vertex: { module: waterModule, entryPoint: 'vs_main' },
      fragment: {
        module: waterModule,
        entryPoint: 'fs_main',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' }, // seen from below too
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: false, // translucent: test against terrain, never write
        depthCompare: 'less',
      },
    });

    // --- tree pipeline (instanced foliage, opaque like terrain) ------------
    const treeModule = this.device.createShaderModule({
      label: 'tree-shader',
      code: treeWgsl,
    });
    this.treePipeline = this.device.createRenderPipeline({
      label: 'tree-pipeline',
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [frameLayout, this.treeInstanceBindGroupLayout],
      }),
      vertex: {
        module: treeModule,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
        }],
      },
      fragment: {
        module: treeModule,
        entryPoint: 'fs_main',
        targets: [{ format: this.format }],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none', // per-instance yaw flips winding; normals fix in fs
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
    });

    // --- rain pipeline (screen-space streak overlay, drawn last) -----------
    const rainModule = this.device.createShaderModule({
      label: 'rain-shader',
      code: rainWgsl,
    });
    this.rainPipeline = this.device.createRenderPipeline({
      label: 'rain-pipeline',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [frameLayout] }),
      vertex: { module: rainModule, entryPoint: 'vs_main' },
      fragment: {
        module: rainModule,
        entryPoint: 'fs_main',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: false,
        depthCompare: 'always', // overlay: ignores scene depth entirely
      },
    });

    // --- character pipeline (interleaved pos+color soup, opaque) -----------
    const characterModule = this.device.createShaderModule({
      label: 'character-shader',
      code: characterWgsl,
    });
    this.characterPipeline = this.device.createRenderPipeline({
      label: 'character-pipeline',
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [frameLayout, this.chunkBindGroupLayout],
      }),
      vertex: {
        module: characterModule,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
          ],
        }],
      },
      fragment: {
        module: characterModule,
        entryPoint: 'fs_main',
        targets: [{ format: this.format }],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back',
        frontFace: 'ccw', // box() winds outward; pose rotations preserve it
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
    });
  }

  /**
   * Create a group-1 bind group: world offset of the object's local origin,
   * color mode (0 = terrain bands, >0.5 = fixed object color; dungeon
   * pipeline reads it as its palette selector), and the fixed color used by
   * the terrain pipeline's object path. Update later via queue.writeBuffer
   * on the returned buffer (vec4 x,y,z,mode + vec4 r,g,b,unused).
   */
  createObjectBindGroup(
    x: number, y: number, z: number, colorMode = 0,
    color: Vec3 = [0.78, 0.30, 0.24],
  ): { bindGroup: GPUBindGroup; buffer: GPUBuffer } {
    const buffer = this.device.createBuffer({
      label: `object-offset(${x},${y},${z})`,
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, new Float32Array(
      [x, y, z, colorMode, color[0], color[1], color[2], 0]));
    const bindGroup = this.device.createBindGroup({
      label: 'object-bg',
      layout: this.chunkBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer } }],
    });
    return { bindGroup, buffer };
  }

  /** Bind a vec4-per-instance storage buffer as tree group 1. */
  createTreeInstanceBindGroup(buffer: GPUBuffer): GPUBindGroup {
    return this.device.createBindGroup({
      label: 'tree-instances-bg',
      layout: this.treeInstanceBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer } }],
    });
  }

  /** Bind a LIGHTS_BUFFER_SIZE uniform buffer as dungeon group 2. */
  createLightsBindGroup(buffer: GPUBuffer): GPUBindGroup {
    return this.device.createBindGroup({
      label: 'lights-bg',
      layout: this.lightsBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer } }],
    });
  }

  /** Recreate the depth texture when the canvas size changed. */
  private ensureDepth(width: number, height: number): GPUTextureView {
    if (!this.depthTexture || this.depthTexture.width !== width || this.depthTexture.height !== height) {
      this.depthTexture?.destroy();
      this.depthTexture = this.device.createTexture({
        label: 'game-depth',
        size: { width, height },
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.depthView = this.depthTexture.createView();
    }
    return this.depthView!;
  }

  /** Render one frame. Returns false if skipped (zero-size canvas). */
  renderFrame(
    frame: FrameUniforms,
    draws: TerrainDraw[],
    dungeonDraws: DungeonDraw[] = [],
    drawWater = false,
    treeDraws: TreeDraw[] = [],
    characterDraws: TerrainDraw[] = [],
  ): boolean {
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w === 0 || h === 0) return false; // minimized window

    // Pack + upload frame uniforms.
    const d = this.frameData;
    d.set(frame.viewProj, 0);
    d.set(invert(frame.viewProj), 16);
    d[32] = frame.cameraPos[0]; d[33] = frame.cameraPos[1]; d[34] = frame.cameraPos[2];
    d[36] = frame.sunDir[0]; d[37] = frame.sunDir[1]; d[38] = frame.sunDir[2];
    d[40] = frame.fogColor[0]; d[41] = frame.fogColor[1]; d[42] = frame.fogColor[2];
    d[43] = frame.fogDensity;
    d[44] = frame.time;
    d[48] = frame.sunColor[0]; d[49] = frame.sunColor[1]; d[50] = frame.sunColor[2];
    d[51] = frame.ambient;
    d[52] = frame.skyZenith[0]; d[53] = frame.skyZenith[1]; d[54] = frame.skyZenith[2];
    d[55] = frame.starVis;
    d[56] = frame.cloudCover;
    d[57] = frame.rainLevel;
    this.device.queue.writeBuffer(this.frameBuffer, 0, d);

    const depthView = this.ensureDepth(w, h);
    const encoder = this.device.createCommandEncoder({ label: 'game-frame' });
    const pass = encoder.beginRenderPass({
      label: 'game-pass',
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: {
          r: frame.fogColor[0],
          g: frame.fogColor[1],
          b: frame.fogColor[2],
          a: 1,
        },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });

    pass.setPipeline(this.terrainPipeline);
    pass.setBindGroup(0, this.frameBindGroup);
    for (const draw of draws) {
      pass.setBindGroup(1, draw.bindGroup);
      pass.setVertexBuffer(0, draw.vertexBuffer);
      if (draw.indexBuffer) {
        pass.setIndexBuffer(draw.indexBuffer, 'uint16');
        pass.drawIndexed(draw.count);
      } else {
        pass.draw(draw.count);
      }
    }

    // Characters (interleaved pos+color, opaque).
    if (characterDraws.length > 0) {
      pass.setPipeline(this.characterPipeline);
      pass.setBindGroup(0, this.frameBindGroup);
      for (const draw of characterDraws) {
        pass.setBindGroup(1, draw.bindGroup);
        pass.setVertexBuffer(0, draw.vertexBuffer);
        pass.draw(draw.count);
      }
    }

    // Instanced trees (opaque, before the sky fills leftover pixels).
    if (treeDraws.length > 0) {
      pass.setPipeline(this.treePipeline);
      pass.setBindGroup(0, this.frameBindGroup);
      for (const t of treeDraws) {
        pass.setBindGroup(1, t.instanceBindGroup);
        pass.setVertexBuffer(0, t.vertexBuffer);
        pass.draw(t.vertexCount, t.instanceCount);
      }
    }

    // Dungeon geometry (interiors + entrance props) uses its own pipeline.
    if (dungeonDraws.length > 0) {
      pass.setPipeline(this.dungeonPipeline);
      pass.setBindGroup(0, this.frameBindGroup);
      for (const { draw, lightsBindGroup } of dungeonDraws) {
        pass.setBindGroup(1, draw.bindGroup);
        pass.setBindGroup(2, lightsBindGroup);
        pass.setVertexBuffer(0, draw.vertexBuffer);
        if (draw.indexBuffer) {
          pass.setIndexBuffer(draw.indexBuffer, 'uint16');
          pass.drawIndexed(draw.count);
        } else {
          pass.draw(draw.count);
        }
      }
    }

    // Sky last: fills only pixels still at cleared depth.
    pass.setPipeline(this.skyPipeline);
    pass.setBindGroup(0, this.frameBindGroup);
    pass.draw(3);

    // Water after sky: alpha-blends over underwater terrain and horizon sky.
    if (drawWater) {
      pass.setPipeline(this.waterPipeline);
      pass.setBindGroup(0, this.frameBindGroup);
      pass.draw(6);
    }

    // Rain overlay last, covering everything (screen-space streaks).
    if (frame.rainLevel > 0) {
      pass.setPipeline(this.rainPipeline);
      pass.setBindGroup(0, this.frameBindGroup);
      pass.draw(3);
    }
    pass.end();

    this.device.queue.submit([encoder.finish()]);
    return true;
  }

  get aspect(): number {
    return this.canvas.width / Math.max(1, this.canvas.height);
  }
}
