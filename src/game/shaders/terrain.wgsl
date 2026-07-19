// Terrain: stylized low-poly flat shading with biome-tinted ground colors.
//
// - Flat per-face normals from dpdx/dpdy of the interpolated world position —
//   no normals in the vertex buffer (position + tint, 24 B/vertex).
// - Each vertex carries a biome tint (float32x3) baked by the CPU mesh
//   builder; it replaces the mid-band grass color while slope-rock, snow,
//   beach-sand, and wet-darkening layers are preserved.
// - Height + slope color bands (sand/grass/rock/snow), half-Lambert sun,
//   exponential distance fog toward the sky color.
// - Vertex positions are chunk-local; the chunk world XZ origin comes from a
//   tiny per-chunk uniform (group 1).

// Keep in sync with sky.wgsl and the packing in renderer.ts (240 bytes).
struct Frame {
  viewProj: mat4x4<f32>,     // offset 0
  invViewProj: mat4x4<f32>,  // offset 64 (used by sky.wgsl)
  cameraPos: vec3<f32>,      // offset 128
  sunDir: vec3<f32>,         // offset 144 (normalized, points TOWARD the sun)
  fogColor: vec3<f32>,       // offset 160
  fogDensity: f32,           // offset 172 (packs into vec3 padding)
  time: f32,                 // offset 176 (+12 pad)
  sunColor: vec3<f32>,       // offset 192 (environment.ts day/night)
  ambient: f32,              // offset 204
  skyZenith: vec3<f32>,      // offset 208
  starVis: f32,              // offset 220
  cloudCover: f32,           // offset 224 (used by sky.wgsl)
  rainLevel: f32,            // offset 228 (used by rain overlay)
  envPad: vec2<f32>,         // offset 232 (struct size 240)
}

struct ObjectData {
  // xyz: world-space offset of local (0,0,0); w: 0 = terrain bands,
  // >0.5 = fixed object color (player placeholder etc.)
  offset: vec4<f32>,
  // rgb: the fixed object color (w unused). 32 B total — keep in sync with
  // createObjectBindGroup in renderer.ts.
  color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> object: ObjectData;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) vtxTint: vec3<f32>,
}

// --- procedural surface detail (no texture assets) --------------------------

fn hash2(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn vnoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash2(i);
  let b = hash2(i + vec2<f32>(1.0, 0.0));
  let c = hash2(i + vec2<f32>(0.0, 1.0));
  let d = hash2(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) tint: vec3<f32>,
) -> VSOut {
  let world = position + object.offset.xyz;
  var out: VSOut;
  out.pos = frame.viewProj * vec4<f32>(world, 1.0);
  out.worldPos = world;
  out.vtxTint = tint;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  // Flat face normal. Derivative handedness varies by backend; heightmap
  // terrain never faces down, so flipping to +Y is always correct.
  var n = normalize(cross(dpdx(in.worldPos), dpdy(in.worldPos)));
  if (n.y < 0.0) { n = -n; }

  let h = in.worldPos.y;
  let slope = n.y; // 1 = flat, 0 = vertical

  // Per-pixel material detail, faded with distance so far terrain keeps the
  // clean low-poly bands (and never shimmers).
  let dist = distance(in.worldPos, frame.cameraPos);
  let detail = exp(-dist * 0.012);
  let p = in.worldPos.xz;
  let mottle = vnoise(p * 0.11) * 0.65 + vnoise(p * 0.45) * 0.35; // patches
  let grain = hash2(floor(p * 6.0)); // ~17 cm texel cells, blocky-game look

  let sand = vec3<f32>(0.76, 0.70, 0.50)
    * (1.0 + detail * ((grain - 0.5) * 0.12 + (mottle - 0.5) * 0.10));

  // Grass / biome ground color: blend the vertex tint from the biome field
  // against a two-tone patchwork + blade-scale grain — same visual richness
  // as before, but hue driven by the biome.
  let grassTone = mix(in.vtxTint * 0.85, in.vtxTint * 1.10,
    clamp(mottle, 0.0, 1.0));
  let grass = mix(in.vtxTint, grassTone, detail)
    * (1.0 + detail * (grain - 0.5) * 0.16);

  // Rock: horizontal strata + speckle.
  let strata = vnoise(vec2<f32>((p.x + p.y) * 0.30, in.worldPos.y * 1.3));
  let rock = vec3<f32>(0.46, 0.43, 0.41)
    * (1.0 + detail * ((strata - 0.5) * 0.28 + (grain - 0.5) * 0.10));
  let snow = vec3<f32>(0.92, 0.94, 0.97)
    * (1.0 + detail * (grain - 0.5) * 0.06);

  // Base albedo: sand band → biome-tinted grass → snow at altitude.
  var albedo = mix(sand, grass, smoothstep(1.0, 4.0, h));
  // Above ~90 m (alpine) blend toward snow regardless of biome tint.
  albedo = mix(albedo, snow, smoothstep(80.0, 95.0, h));
  // Steep faces become rock regardless of height band.
  albedo = mix(rock, albedo, smoothstep(0.55, 0.75, slope));
  // Wet sand / lakebed darkening around and below sea level (y = 0).
  albedo *= mix(0.5, 1.0, smoothstep(-1.5, 0.5, h));
  // Fixed-color objects (player, props) skip the terrain bands.
  albedo = mix(albedo, object.color.rgb, step(0.5, object.offset.w));

  // Half-Lambert sun + flat ambient — soft stylized lighting, no shadows yet.
  let diff = dot(n, frame.sunDir) * 0.5 + 0.5;
  var color = albedo * (frame.ambient + (0.30 * diff + 0.55 * diff * diff) * frame.sunColor);

  // Exponential distance fog toward the sky/horizon color.
  let fog = 1.0 - exp(-frame.fogDensity * dist);
  color = mix(color, frame.fogColor, fog);

  return vec4<f32>(color, 1.0);
}
