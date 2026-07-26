// ---------------------------------------------------------------------------
// frame.wgsl — the per-frame uniform block and a few pure helpers, with no
// binding declarations of its own. Scene shaders get it transitively through
// common.wgsl (which binds it at group 0); post-process shaders include it
// directly and bind it wherever their own layout puts it.
//
// The byte offsets below are load-bearing: they must match FRAME_* packing in
// render/frame-uniforms.ts exactly.
// ---------------------------------------------------------------------------

struct Frame {
  viewProj:      mat4x4<f32>,   //   0
  invViewProj:   mat4x4<f32>,   //  64
  sunViewProj0:  mat4x4<f32>,   // 128  shadow cascade 0 (near)
  sunViewProj1:  mat4x4<f32>,   // 192  cascade 1 (mid)
  sunViewProj2:  mat4x4<f32>,   // 256  cascade 2 (far)
  cameraPos:     vec3<f32>,     // 320
  time:          f32,           // 332
  sunDir:        vec3<f32>,     // 336  normalized, points TOWARD the sun
  fogDensity:    f32,           // 348
  fogColor:      vec3<f32>,     // 352
  ambient:       f32,           // 364
  sunColor:      vec3<f32>,     // 368  tint x intensity
  starVis:       f32,           // 380  0 day -> 1 night
  skyZenith:     vec3<f32>,     // 384
  cloudCover:    f32,           // 396
  skyHorizon:    vec3<f32>,     // 400
  rainLevel:     f32,           // 412
  cascadeSplits: vec4<f32>,     // 416  xyz cascade far distances, w shadow strength
  screenSize:    vec4<f32>,     // 432  w, h, 1/w, 1/h
  params0:       vec4<f32>,     // 448  exposure, windTime, shadowTexelWorld, aoStrength
  moonDir:       vec3<f32>,     // 464
  moonPhase:     f32,           // 476
  // World size of one shadow texel per cascade (xyz). Each cascade fits a
  // different-sized ortho box, so their texels differ by ~9x end to end —
  // biasing them all off cascade 0's texel under-biases the far cascades and
  // they self-shadow in broad bands across open ground.
  cascadeTexel:  vec4<f32>,     // 480
}                                //      496 bytes total

struct ObjectData {
  // xyz: world-space offset of local (0,0,0)
  // w:   colour mode — 0 terrain bands, 1 vertex colours, >=100 palette index
  offset: vec4<f32>,
  color:  vec4<f32>,
}

/** Rebuild a world-space position from a depth-buffer sample. */
fn worldFromDepth(uv: vec2<f32>, depth: f32, invVP: mat4x4<f32>) -> vec3<f32> {
  let ndc = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let p = invVP * ndc;
  return p.xyz / p.w;
}

fn luminance(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// --- shared vertex-stage transforms -----------------------------------------
// These live here, rather than in the shaders that use them, because the
// shadow pass must reproduce the main pass's vertex positions *exactly*. Any
// drift between the two — a different wind phase, a different instance yaw —
// detaches every shadow from the object casting it.

/**
 * Wind displacement for trees, grass and cloth. `sway` scales the amplitude,
 * `phase` decorrelates neighbouring instances.
 */
fn windOffset(f: Frame, worldPos: vec3<f32>, sway: f32, phase: f32) -> vec3<f32> {
  let t = f.params0.y;
  // Two travelling gust waves at different scales plus a faster flutter, so
  // the canopy breathes instead of oscillating on a single sine.
  let g = sin(worldPos.x * 0.06 + worldPos.z * 0.045 + t * 0.55) * 0.5 + 0.5;
  let gust = 0.45 + 0.55 * g * (1.0 + f.rainLevel * 0.8);
  let a = t * 1.6 + phase;
  return vec3<f32>(
    (sin(a) * 0.7 + sin(a * 2.3 + 1.7) * 0.3) * sway * gust,
    sin(a * 1.7 + 0.9) * sway * 0.15 * gust,
    (cos(a * 0.83) * 0.7 + cos(a * 1.9) * 0.3) * sway * gust * 0.8,
  );
}

/** Deterministic per-instance variation hash (position-derived). */
fn instanceHash(inst: vec4<f32>) -> f32 {
  return fract(sin(inst.x * 12.9898 + inst.z * 78.233) * 43758.5453);
}

/**
 * Place a tree/foliage vertex: uniform scale, position-hash yaw, translate,
 * then wind sway that only affects the canopy. `trunkTop`/`crownTop` bound
 * the height range over which sway ramps in.
 */
fn foliageWorld(
  f: Frame, position: vec3<f32>, inst: vec4<f32>,
  trunkTop: f32, crownTop: f32,
) -> vec3<f32> {
  let h = instanceHash(inst);
  let yaw = h * 6.2831853;
  let s = sin(yaw);
  let c = cos(yaw);
  let local = position * inst.w;
  let rotated = vec3<f32>(local.x * c - local.z * s, local.y,
                          local.x * s + local.z * c);
  var world = rotated + inst.xyz;
  let leafFrac = smoothstep(trunkTop, crownTop, position.y);
  world = world + windOffset(f, inst.xyz, 0.13 * leafFrac * inst.w,
                             h * 6.2831853);
  return world;
}

/** Rotate a foliage normal by the same per-instance yaw as foliageWorld. */
fn foliageNormal(normal: vec3<f32>, inst: vec4<f32>) -> vec3<f32> {
  let yaw = instanceHash(inst) * 6.2831853;
  let s = sin(yaw);
  let c = cos(yaw);
  return vec3<f32>(normal.x * c - normal.z * s, normal.y,
                   normal.x * s + normal.z * c);
}
