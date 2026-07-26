/**
 * Game renderer — the WebGPU render graph.
 *
 * Per frame:
 *   1. three cascaded shadow passes (depth only)
 *   2. opaque pass -> linear HDR colour + packed normal/ambient G-buffer
 *      + sampleable depth, ending with the sky
 *   3. colour copy, then a transparent pass (water, rain) that samples the
 *      opaque result for refraction and depth-based shoreline effects
 *   4. post: SSAO -> bloom -> god rays -> ACES composite -> FXAA -> swapchain
 *
 * Scene shaders emit *linear HDR only*. Tonemapping, grading and AA all
 * happen once, in post-fx.ts — there is deliberately no per-shader grade().
 *
 * Shares the GPUContext singleton from src/engine/gpu-device so rendering and
 * LLM inference draw from one VRAM pool.
 */

import type { GPUContext } from '../engine/gpu-device';
import {
  invert, normalize, sub, type Mat4, type Vec3,
} from './math';
import { wgsl } from './shaders/include';
import terrainWgsl from './shaders/terrain.wgsl?raw';
import skyWgsl from './shaders/sky.wgsl?raw';
import dungeonWgsl from './shaders/dungeon.wgsl?raw';
import waterWgsl from './shaders/water.wgsl?raw';
import treeWgsl from './shaders/tree.wgsl?raw';
import rainWgsl from './shaders/rain.wgsl?raw';
import characterWgsl from './shaders/character.wgsl?raw';
import grassWgsl from './shaders/grass.wgsl?raw';
import { MaterialAtlas } from './render/materials';
import { packMaterialTable, MAX_MATERIALS, MATERIAL_ROW_FLOATS } from './render/material-table';
import { ShadowMap, CASCADE_SPLITS } from './render/shadow-map';
import { FireFX } from './render/fire-fx';
import {
  PostFX, DEFAULT_POST, HDR_FORMAT, NORMAL_FORMAT, DEPTH_FORMAT,
  type PostSettings,
} from './render/post-fx';

export type { PostSettings } from './render/post-fx';
export { DEFAULT_POST } from './render/post-fx';

/** Vertex strides, one per geometry family. Keep in sync with mesh-utils. */
export const STRIDE_PROP = 24;   // pos3 + normal3
export const STRIDE_RICH = 36;   // pos3 + normal3 + tint3            (terrain)
/**
 * pos3 + normal3 + colour3 + materialId1. Creatures carry the material ID
 * *per vertex* rather than per draw, so one skeleton can be bone at the ribs,
 * leather at the belt and iron at the blade in a single draw call.
 */
export const STRIDE_CREATURE = 40;

export interface FrameUniforms {
  viewProj: Mat4;
  cameraPos: Vec3;
  sunDir: Vec3;     // normalized, points toward the sun
  fogColor: Vec3;
  fogDensity: number;
  time: number;
  sunColor: Vec3;   // direct sunlight tint × intensity (environment.ts)
  ambient: number;  // ambient probe intensity
  skyZenith: Vec3;  // sky color straight up
  starVis: number;  // 0 day → 1 night
  cloudCover: number; // 0 clear → 1 overcast (sky.wgsl FBM threshold)
  rainLevel: number;  // 0 dry → 1 downpour (rain overlay intensity)

  // --- optional; sensible defaults are derived when omitted --------------
  /** Sky colour at the horizon. Defaults to a lift of fogColor. */
  skyHorizon?: Vec3;
  /** Moon direction. Defaults to the mirrored sun. */
  moonDir?: Vec3;
  /** 0..1 illuminated fraction of the moon. */
  moonPhase?: number;
  /** 0 disables sun shadows entirely (dungeon interiors). */
  shadowStrength?: number;
  /** Camera forward, for shadow cascade fitting. Derived if omitted. */
  cameraForward?: Vec3;
  /** Vertical field of view in radians (cascade fitting). */
  fovY?: number;
  /** Camera near plane (cascade fitting). */
  near?: number;
  /** Wind clock; defaults to `time`. */
  windTime?: number;
}

/** One terrain draw: a chunk mesh + its origin bind group (group 1). */
export interface TerrainDraw {
  vertexBuffer: GPUBuffer;
  /** uint16 index buffer; null → non-indexed draw. */
  indexBuffer: GPUBuffer | null;
  /** Index count (indexed) or vertex count (non-indexed). */
  count: number;
  bindGroup: GPUBindGroup;
  /** Shadow-pass bind group for the same object uniform. */
  shadowBindGroup?: GPUBindGroup;
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
  /** Shadow-pass bind group over the same instance buffer. */
  shadowBindGroup?: GPUBindGroup;
}

/** Byte size of the group-2 lights uniform: vec4 count + 32 × 32 B lights. */
export const LIGHTS_BUFFER_SIZE = 16 + 32 * 32;

/** Max simultaneous outdoor point lights (campfires, forges, torches). */
export const MAX_WORLD_LIGHTS = 16;
/** vec4 count + MAX_WORLD_LIGHTS × 32 B. */
export const WORLD_LIGHTS_BUFFER_SIZE = 16 + MAX_WORLD_LIGHTS * 32;

/** Frame uniform: 496 bytes. Layout documented in shaders/frame.wgsl. */
const FRAME_UNIFORM_FLOATS = 124;

export class Renderer {
  readonly device: GPUDevice;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: GPUCanvasContext;
  private readonly format: GPUTextureFormat;

  private readonly frameBuffer: GPUBuffer;
  private readonly frameData = new Float32Array(FRAME_UNIFORM_FLOATS);
  private readonly worldLightsBuffer: GPUBuffer;
  private readonly materialTableBuffer: GPUBuffer;
  private readonly worldLightsData =
    new Float32Array(WORLD_LIGHTS_BUFFER_SIZE / 4);
  private readonly sceneBindGroup: GPUBindGroup;
  private readonly sceneLayout: GPUBindGroupLayout;
  private readonly chunkBindGroupLayout: GPUBindGroupLayout;
  private readonly lightsBindGroupLayout: GPUBindGroupLayout;
  private readonly treeInstanceBindGroupLayout: GPUBindGroupLayout;
  private readonly refractLayout: GPUBindGroupLayout;
  private refractBindGroup: GPUBindGroup | null = null;

  private readonly terrainPipeline: GPURenderPipeline;
  private readonly dungeonPipeline: GPURenderPipeline;
  private readonly skyPipeline: GPURenderPipeline;
  private readonly waterPipeline: GPURenderPipeline;
  private readonly treePipeline: GPURenderPipeline;
  private readonly rainPipeline: GPURenderPipeline;
  private readonly characterPipeline: GPURenderPipeline;
  private readonly grassPipeline: GPURenderPipeline;

  private readonly materials: MaterialAtlas;
  private readonly shadows: ShadowMap;
  private readonly post: PostFX;

  /**
   * Every flame in the game, as one instanced additive billboard draw. The
   * game fills this each frame (see render/fire-fx.ts `emitWorldFire`) and
   * renderFrame draws it after the transparent pass, before post — so flames
   * depth-test against the scene and feed the bloom chain.
   */
  readonly fire: FireFX;

  /** Post-process tunables; the game mutates these per frame. */
  readonly postSettings: PostSettings = { ...DEFAULT_POST };

  private sceneCopy: GPUTexture | null = null;
  private sceneCopyView: GPUTextureView | null = null;
  private viewW = 0;
  private viewH = 0;

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

    this.frameBuffer = this.device.createBuffer({
      label: 'game-frame-uniforms',
      size: FRAME_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.worldLightsBuffer = this.device.createBuffer({
      label: 'game-world-lights',
      size: WORLD_LIGHTS_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // The material table is static for the session — upload once.
    this.materialTableBuffer = this.device.createBuffer({
      label: 'game-material-table',
      size: MAX_MATERIALS * MATERIAL_ROW_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(
      this.materialTableBuffer, 0, packMaterialTable());

    this.materials = new MaterialAtlas(this.device);
    this.shadows = new ShadowMap(this.device, this.frameBuffer);
    this.post = new PostFX(this.device, this.frameBuffer, this.format);

    // --- bind group layouts ---------------------------------------------
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.sceneLayout = this.device.createBindGroupLayout({
      label: 'game-scene-bgl',
      entries: [
        { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
        {
          binding: 1, visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'depth', viewDimension: '2d-array' },
        },
        {
          binding: 2, visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'comparison' },
        },
        {
          binding: 3, visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d-array' },
        },
        {
          binding: 4, visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d-array' },
        },
        {
          binding: 5, visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
        {
          binding: 6, visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        {
          binding: 7, visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });
    this.chunkBindGroupLayout = this.device.createBindGroupLayout({
      label: 'game-object-bgl',
      entries: [{ binding: 0, visibility: VF, buffer: { type: 'uniform' } }],
    });
    this.treeInstanceBindGroupLayout = this.device.createBindGroupLayout({
      label: 'game-tree-instances-bgl',
      entries: [{
        binding: 0, visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'read-only-storage' },
      }],
    });
    this.lightsBindGroupLayout = this.device.createBindGroupLayout({
      label: 'game-lights-bgl',
      entries: [{
        binding: 0, visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      }],
    });
    // Water samples the opaque scene copy + the read-only depth buffer.
    this.refractLayout = this.device.createBindGroupLayout({
      label: 'game-refract-bgl',
      entries: [
        {
          binding: 0, visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
        {
          binding: 1, visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'depth' },
        },
        {
          binding: 2, visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
      ],
    });

    this.sceneBindGroup = this.device.createBindGroup({
      label: 'game-scene-bg',
      layout: this.sceneLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: this.shadows.view },
        { binding: 2, resource: this.shadows.sampler },
        { binding: 3, resource: this.materials.albedoView },
        { binding: 4, resource: this.materials.normalView },
        { binding: 5, resource: this.materials.sampler },
        { binding: 6, resource: { buffer: this.worldLightsBuffer } },
        { binding: 7, resource: { buffer: this.materialTableBuffer } },
      ],
    });

    // --- scene pipelines --------------------------------------------------
    const mrtTargets: GPUColorTargetState[] = [
      { format: HDR_FORMAT }, { format: NORMAL_FORMAT },
    ];
    const depthState = (write: boolean, compare: GPUCompareFunction): GPUDepthStencilState => ({
      format: DEPTH_FORMAT, depthWriteEnabled: write, depthCompare: compare,
    });

    const opaque = (
      label: string, code: string, stride: number,
      attrs: GPUVertexAttribute[], group1: GPUBindGroupLayout,
      extraGroups: GPUBindGroupLayout[] = [], cullMode: GPUCullMode = 'back',
    ) => {
      const module = this.device.createShaderModule({ label, code: wgsl(code) });
      return this.device.createRenderPipeline({
        label,
        layout: this.device.createPipelineLayout({
          bindGroupLayouts: [this.sceneLayout, group1, ...extraGroups],
        }),
        vertex: {
          module, entryPoint: 'vs_main',
          buffers: [{ arrayStride: stride, attributes: attrs }],
        },
        fragment: { module, entryPoint: 'fs_main', targets: mrtTargets },
        primitive: { topology: 'triangle-list', cullMode, frontFace: 'ccw' },
        depthStencil: depthState(true, 'less'),
      });
    };

    // pos3 + normal3 + (tint|colour)3
    const richAttrs: GPUVertexAttribute[] = [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32x3' },
    ];
    // pos3 + normal3
    const propAttrs: GPUVertexAttribute[] = [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
    ];
    // pos3 + normal3 + colour3 + materialId
    const creatureAttrs: GPUVertexAttribute[] = [
      ...richAttrs,
      { shaderLocation: 3, offset: 36, format: 'float32' },
    ];

    // Terrain is 40 B — pos3 + normal3 + tint3 + road weight — so it reuses
    // `creatureAttrs` verbatim and, crucially, the existing 40 B shadow
    // pipeline. `STRIDE_RICH` stays for anything still on the 36 B layout.
    this.terrainPipeline = opaque('terrain-shader', terrainWgsl,
      STRIDE_CREATURE, creatureAttrs, this.chunkBindGroupLayout);
    this.characterPipeline = opaque('character-shader', characterWgsl,
      STRIDE_CREATURE, creatureAttrs, this.chunkBindGroupLayout);
    this.dungeonPipeline = opaque('dungeon-shader', dungeonWgsl,
      STRIDE_PROP, propAttrs, this.chunkBindGroupLayout,
      [this.lightsBindGroupLayout]);
    // Per-instance yaw flips winding, so foliage cannot cull.
    this.treePipeline = opaque('tree-shader', treeWgsl,
      STRIDE_PROP, propAttrs, this.treeInstanceBindGroupLayout, [], 'none');
    // Grass blades are single quads — visible from both sides.
    this.grassPipeline = opaque('grass-shader', grassWgsl,
      STRIDE_PROP, propAttrs, this.treeInstanceBindGroupLayout, [], 'none');

    // --- bufferless passes ------------------------------------------------
    const fullscreen = (
      label: string, code: string, targets: GPUColorTargetState[],
      depth: GPUDepthStencilState, groups: GPUBindGroupLayout[],
    ) => {
      const module = this.device.createShaderModule({ label, code: wgsl(code) });
      return this.device.createRenderPipeline({
        label,
        layout: this.device.createPipelineLayout({ bindGroupLayouts: groups }),
        vertex: { module, entryPoint: 'vs_main' },
        fragment: { module, entryPoint: 'fs_main', targets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: depth,
      });
    };

    // Sky fills only pixels still at cleared depth, and leaves the normal
    // G-buffer alone so SSAO treats it as background.
    this.skyPipeline = fullscreen('sky-shader', skyWgsl,
      [{ format: HDR_FORMAT }, { format: NORMAL_FORMAT, writeMask: 0 }],
      depthState(false, 'less-equal'), [this.sceneLayout]);

    const alphaBlend: GPUBlendState = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    };
    this.waterPipeline = fullscreen('water-shader', waterWgsl,
      [{ format: HDR_FORMAT, blend: alphaBlend },
       { format: NORMAL_FORMAT, writeMask: 0 }],
      depthState(false, 'less'), [this.sceneLayout, this.refractLayout]);
    this.rainPipeline = fullscreen('rain-shader', rainWgsl,
      [{ format: HDR_FORMAT, blend: alphaBlend },
       { format: NORMAL_FORMAT, writeMask: 0 }],
      depthState(false, 'always'), [this.sceneLayout]);

    // Owns its own pipeline, instance buffer and bind groups; only needs the
    // scene layout for group 0.
    this.fire = new FireFX(this.device, this.sceneLayout);
  }

  /**
   * Create a group-1 bind group: world offset of the object's local origin,
   * colour mode (0 = terrain bands, 1 = vertex colours, >=100 = palette
   * index + 100), and a fixed colour for the palette-free paths. Update later
   * via queue.writeBuffer on the returned buffer.
   */
  createObjectBindGroup(
    x: number, y: number, z: number, colorMode = 0,
    color: Vec3 = [0.78, 0.30, 0.24],
    materialId = 0,
  ): { bindGroup: GPUBindGroup; buffer: GPUBuffer; shadowBindGroup: GPUBindGroup } {
    const buffer = this.device.createBuffer({
      label: `object-offset(${x},${y},${z})`,
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // color.w carries the character pipeline's detail-material layer.
    this.device.queue.writeBuffer(buffer, 0, new Float32Array(
      [x, y, z, colorMode, color[0], color[1], color[2], materialId]));
    const bindGroup = this.device.createBindGroup({
      label: 'object-bg',
      layout: this.chunkBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer } }],
    });
    const shadowBindGroup = this.device.createBindGroup({
      label: 'object-shadow-bg',
      layout: this.shadows.objectLayout,
      entries: [{ binding: 0, resource: { buffer } }],
    });
    return { bindGroup, buffer, shadowBindGroup };
  }

  /** Bind a vec4-per-instance storage buffer as tree group 1. */
  createTreeInstanceBindGroup(buffer: GPUBuffer): GPUBindGroup {
    return this.device.createBindGroup({
      label: 'tree-instances-bg',
      layout: this.treeInstanceBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer } }],
    });
  }

  /** Shadow-pass counterpart of createTreeInstanceBindGroup. */
  createTreeShadowBindGroup(buffer: GPUBuffer): GPUBindGroup {
    return this.device.createBindGroup({
      label: 'tree-shadow-bg',
      layout: this.shadows.instanceLayout,
      entries: [{ binding: 1, resource: { buffer } }],
    });
  }

  /**
   * Replace the outdoor point-light set for this frame. `lights` is read up to
   * MAX_WORLD_LIGHTS entries; the caller is responsible for having already
   * culled to the nearest and brightest.
   */
  setWorldLights(
    lights: readonly { pos: Vec3; color: Vec3; radius: number }[],
  ): void {
    const d = this.worldLightsData;
    const n = Math.min(lights.length, MAX_WORLD_LIGHTS);
    d[0] = n;
    for (let i = 0; i < n; i++) {
      const l = lights[i];
      const o = 4 + i * 8;
      d[o] = l.pos[0]; d[o + 1] = l.pos[1]; d[o + 2] = l.pos[2]; d[o + 3] = 0;
      d[o + 4] = l.color[0]; d[o + 5] = l.color[1]; d[o + 6] = l.color[2];
      d[o + 7] = l.radius;
    }
    this.device.queue.writeBuffer(this.worldLightsBuffer, 0, d, 0, 4 + n * 8);
  }

  /** Bind a LIGHTS_BUFFER_SIZE uniform buffer as dungeon group 2. */
  createLightsBindGroup(buffer: GPUBuffer): GPUBindGroup {
    return this.device.createBindGroup({
      label: 'lights-bg',
      layout: this.lightsBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer } }],
    });
  }

  /** Rebuild size-dependent resources when the canvas changed. */
  private ensureTargets(width: number, height: number): void {
    if (width === this.viewW && height === this.viewH) return;
    this.viewW = width;
    this.viewH = height;
    this.post.resize(width, height);

    this.sceneCopy?.destroy();
    this.sceneCopy = this.device.createTexture({
      label: 'scene-copy',
      size: { width, height },
      format: HDR_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.sceneCopyView = this.sceneCopy.createView();

    this.refractBindGroup = this.device.createBindGroup({
      label: 'refract-bg',
      layout: this.refractLayout,
      entries: [
        { binding: 0, resource: this.sceneCopyView },
        { binding: 1, resource: this.post.depth.view },
        { binding: 2, resource: this.materials.sampler },
      ],
    });

    // Flames read the depth buffer for their soft-particle fade.
    this.fire.setDepthView(this.post.depth.view);
  }

  /** Pack + upload the per-frame uniform block. */
  private writeFrameUniforms(frame: FrameUniforms, w: number, h: number): void {
    const d = this.frameData;
    const invVP = invert(frame.viewProj);
    d.set(frame.viewProj, 0);
    d.set(invVP, 16);
    for (let i = 0; i < 3; i++) {
      d.set(this.shadows.cascades[i]?.viewProj ?? IDENTITY, 32 + i * 16);
    }

    d[80] = frame.cameraPos[0]; d[81] = frame.cameraPos[1]; d[82] = frame.cameraPos[2];
    d[83] = frame.time;
    d[84] = frame.sunDir[0]; d[85] = frame.sunDir[1]; d[86] = frame.sunDir[2];
    d[87] = frame.fogDensity;
    d[88] = frame.fogColor[0]; d[89] = frame.fogColor[1]; d[90] = frame.fogColor[2];
    d[91] = frame.ambient;
    d[92] = frame.sunColor[0]; d[93] = frame.sunColor[1]; d[94] = frame.sunColor[2];
    d[95] = frame.starVis;
    d[96] = frame.skyZenith[0]; d[97] = frame.skyZenith[1]; d[98] = frame.skyZenith[2];
    d[99] = frame.cloudCover;

    // Horizon sky: a warmer, lighter lift of the fog colour when not supplied.
    const hz = frame.skyHorizon ?? [
      frame.fogColor[0] * 1.05 + 0.04,
      frame.fogColor[1] * 1.02 + 0.03,
      frame.fogColor[2] * 0.98 + 0.02,
    ];
    d[100] = hz[0]; d[101] = hz[1]; d[102] = hz[2];
    d[103] = frame.rainLevel;

    d[104] = CASCADE_SPLITS[0];
    d[105] = CASCADE_SPLITS[1];
    d[106] = CASCADE_SPLITS[2];
    d[107] = frame.shadowStrength ?? 1;

    d[108] = w; d[109] = h; d[110] = 1 / w; d[111] = 1 / h;

    d[112] = this.postSettings.exposure;
    d[113] = frame.windTime ?? frame.time;
    d[114] = this.shadows.baseTexelWorld;
    d[115] = this.postSettings.aoStrength;

    const moon = frame.moonDir
      ?? normalize([-frame.sunDir[0], Math.abs(frame.sunDir[1]), -frame.sunDir[2]]);
    d[116] = moon[0]; d[117] = moon[1]; d[118] = moon[2];
    d[119] = frame.moonPhase ?? 1;

    // Real per-cascade texel sizes — the shadow bias is derived from these.
    for (let i = 0; i < 3; i++) {
      d[120 + i] = this.shadows.cascades[i]?.texelWorld ?? 0.02;
    }

    this.device.queue.writeBuffer(this.frameBuffer, 0, d);
  }

  /** Project the sun onto the screen for the god-ray pass. */
  private sunScreenPos(frame: FrameUniforms): { uv: [number, number]; visible: number } {
    const p: Vec3 = [
      frame.cameraPos[0] + frame.sunDir[0] * 4000,
      frame.cameraPos[1] + frame.sunDir[1] * 4000,
      frame.cameraPos[2] + frame.sunDir[2] * 4000,
    ];
    const m = frame.viewProj;
    const cw = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (cw <= 0) return { uv: [0.5, 0.5], visible: 0 };
    const cx = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const cy = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const uv: [number, number] = [cx / cw * 0.5 + 0.5, 0.5 - cy / cw * 0.5];
    // Only shaft when the sun is above the horizon and roughly on screen.
    const above = Math.max(0, Math.min(1, (frame.sunDir[1] + 0.02) * 8));
    const onScreen = Math.max(0, 1 - Math.max(
      Math.abs(uv[0] - 0.5), Math.abs(uv[1] - 0.5)) / 1.1);
    return { uv, visible: above * onScreen * (1 - frame.cloudCover * 0.55) };
  }

  /** Render one frame. Returns false if skipped (zero-size canvas). */
  renderFrame(
    frame: FrameUniforms,
    draws: TerrainDraw[],
    dungeonDraws: DungeonDraw[] = [],
    drawWater = false,
    treeDraws: TreeDraw[] = [],
    characterDraws: TerrainDraw[] = [],
    grassDraws: TreeDraw[] = [],
  ): boolean {
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w === 0 || h === 0) return false; // minimized window

    this.ensureTargets(w, h);

    // Camera basis for cascade fitting: pull the view ray out of the inverse
    // view-projection rather than requiring the caller to pass it.
    const forward = frame.cameraForward ?? this.deriveForward(frame);
    const shadowStrength = frame.shadowStrength ?? 1;
    if (shadowStrength > 0) {
      this.shadows.update(
        frame.cameraPos, forward, frame.fovY ?? (60 * Math.PI / 180),
        w / Math.max(1, h), frame.near ?? 0.1, frame.sunDir);
    }

    this.writeFrameUniforms(frame, w, h);

    const encoder = this.device.createCommandEncoder({ label: 'game-frame' });

    // --- 1. shadow cascades ---------------------------------------------
    if (shadowStrength > 0) {
      for (let c = 0; c < 3; c++) {
        const pass = this.shadows.beginPass(encoder, c);
        // Terrain moved to 40 B when the per-vertex road weight landed. The
        // shadow pass reads only position (byte 0), but the STRIDE is how it
        // walks vertex to vertex, so it has to match the buffer being drawn.
        pass.setPipeline(this.shadows.propPipeline40);
        for (const d of draws) {
          if (!d.shadowBindGroup) continue;
          pass.setBindGroup(1, d.shadowBindGroup);
          pass.setVertexBuffer(0, d.vertexBuffer);
          if (d.indexBuffer) {
            pass.setIndexBuffer(d.indexBuffer, 'uint16');
            pass.drawIndexed(d.count);
          } else {
            pass.draw(d.count);
          }
        }
        // Characters and creatures are STRIDE_CREATURE (40), not 36. Drawing
        // them through the 36-byte pipeline walked their vertex buffer at the
        // wrong step, so every creature cast a scrambled shadow that looked
        // nothing like its body.
        pass.setPipeline(this.shadows.propPipeline40);
        for (const d of characterDraws) {
          if (!d.shadowBindGroup) continue;
          pass.setBindGroup(1, d.shadowBindGroup);
          pass.setVertexBuffer(0, d.vertexBuffer);
          pass.draw(d.count);
        }
        pass.setPipeline(this.shadows.propPipeline24);
        for (const { draw } of dungeonDraws) {
          if (!draw.shadowBindGroup) continue;
          pass.setBindGroup(1, draw.shadowBindGroup);
          pass.setVertexBuffer(0, draw.vertexBuffer);
          if (draw.indexBuffer) {
            pass.setIndexBuffer(draw.indexBuffer, 'uint16');
            pass.drawIndexed(draw.count);
          } else {
            pass.draw(draw.count);
          }
        }
        pass.setPipeline(this.shadows.foliagePipeline);
        for (const t of treeDraws) {
          if (!t.shadowBindGroup) continue;
          pass.setBindGroup(1, t.shadowBindGroup);
          pass.setVertexBuffer(0, t.vertexBuffer);
          pass.draw(t.vertexCount, t.instanceCount);
        }
        pass.end();
      }
    }

    // --- 2. opaque pass ---------------------------------------------------
    const pass = encoder.beginRenderPass({
      label: 'opaque-pass',
      colorAttachments: [
        {
          view: this.post.scene.view,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear', storeOp: 'store',
        },
        {
          view: this.post.normal.view,
          clearValue: { r: 0.5, g: 0.5, b: 0.5, a: 0 },
          loadOp: 'clear', storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.post.depth.view,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setBindGroup(0, this.sceneBindGroup);

    pass.setPipeline(this.terrainPipeline);
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

    if (characterDraws.length > 0) {
      pass.setPipeline(this.characterPipeline);
      for (const draw of characterDraws) {
        pass.setBindGroup(1, draw.bindGroup);
        pass.setVertexBuffer(0, draw.vertexBuffer);
        pass.draw(draw.count);
      }
    }

    if (treeDraws.length > 0) {
      pass.setPipeline(this.treePipeline);
      for (const t of treeDraws) {
        pass.setBindGroup(1, t.instanceBindGroup);
        pass.setVertexBuffer(0, t.vertexBuffer);
        pass.draw(t.vertexCount, t.instanceCount);
      }
    }

    // Grass after trees: it is the densest, smallest-triangle geometry in the
    // frame, so it benefits most from the depth buffer already being filled.
    if (grassDraws.length > 0) {
      pass.setPipeline(this.grassPipeline);
      for (const g of grassDraws) {
        pass.setBindGroup(1, g.instanceBindGroup);
        pass.setVertexBuffer(0, g.vertexBuffer);
        pass.draw(g.vertexCount, g.instanceCount);
      }
    }

    if (dungeonDraws.length > 0) {
      pass.setPipeline(this.dungeonPipeline);
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
    pass.draw(3);
    pass.end();

    // --- 3. transparent pass ---------------------------------------------
    if (drawWater || frame.rainLevel > 0) {
      // Water refracts what is behind it, so snapshot the opaque result.
      encoder.copyTextureToTexture(
        { texture: this.post.scene.texture },
        { texture: this.sceneCopy! },
        { width: w, height: h });

      const tpass = encoder.beginRenderPass({
        label: 'transparent-pass',
        colorAttachments: [
          { view: this.post.scene.view, loadOp: 'load', storeOp: 'store' },
          { view: this.post.normal.view, loadOp: 'load', storeOp: 'store' },
        ],
        // Read-only depth lets water depth-test against the opaque scene and
        // sample that same buffer for shoreline depth in one pass.
        depthStencilAttachment: {
          view: this.post.depth.view,
          depthReadOnly: true,
        },
      });
      tpass.setBindGroup(0, this.sceneBindGroup);
      if (drawWater) {
        tpass.setPipeline(this.waterPipeline);
        tpass.setBindGroup(1, this.refractBindGroup!);
        tpass.draw(6);
      }
      if (frame.rainLevel > 0) {
        tpass.setPipeline(this.rainPipeline);
        tpass.draw(3);
      }
      tpass.end();
    }

    // --- 3b. fire ---------------------------------------------------------
    // Its own pass rather than an extension of the transparent one: fire also
    // burns underground and in interiors, where `drawWater` is false and there
    // is no rain, so the transparent pass never begins. Read-only depth means
    // flames test against the opaque scene without writing it, and running
    // before post is what feeds them into bloom.
    if (this.fire.count > 0) {
      const fpass = encoder.beginRenderPass({
        label: 'fire-pass',
        colorAttachments: [
          { view: this.post.scene.view, loadOp: 'load', storeOp: 'store' },
          { view: this.post.normal.view, loadOp: 'load', storeOp: 'store' },
        ],
        depthStencilAttachment: {
          view: this.post.depth.view,
          depthReadOnly: true,
        },
      });
      fpass.setBindGroup(0, this.sceneBindGroup);
      this.fire.draw(fpass);
      fpass.end();
    }
    this.fire.endFrame();

    // --- 4. post ----------------------------------------------------------
    const sun = this.sunScreenPos(frame);
    this.postSettings.sunUV = sun.uv;
    this.postSettings.sunVisible = sun.visible;
    this.post.render(
      encoder, this.context.getCurrentTexture().createView(), this.postSettings);

    this.device.queue.submit([encoder.finish()]);
    return true;
  }

  /** Camera forward from the inverse view-projection's centre ray. */
  private deriveForward(frame: FrameUniforms): Vec3 {
    const inv = invert(frame.viewProj);
    const x = inv[8] * 0.5 + inv[12];
    const y = inv[9] * 0.5 + inv[13];
    const z = inv[10] * 0.5 + inv[14];
    const w = inv[11] * 0.5 + inv[15];
    if (Math.abs(w) < 1e-9) return [0, 0, -1];
    return normalize(sub([x / w, y / w, z / w], frame.cameraPos));
  }

  get aspect(): number {
    return this.canvas.width / Math.max(1, this.canvas.height);
  }
}

const IDENTITY = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]);
