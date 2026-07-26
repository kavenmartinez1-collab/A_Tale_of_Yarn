// ---------------------------------------------------------------------------
// godrays.wgsl — screen-space crepuscular rays at quarter resolution.
//
// Builds an occlusion mask (sky = bright, geometry = black, weighted by how
// close the pixel is to the sun) and radially blurs it outward from the sun's
// screen position. Composite adds the result back additively.
//
// Cheap, and it is the effect that sells "sunlight coming through trees" more
// than any amount of extra geometry would.
// ---------------------------------------------------------------------------

#include "fullscreen.wgsl"

struct RayParams {
  // xy: sun position in UV space, z: sun visibility (0 = behind camera/below
  // horizon), w: decay per step
  cfg: vec4<f32>,
  // x: density, y: weight, z: exposure, w: unused
  cfg2: vec4<f32>,
}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<uniform> rp: RayParams;
@group(0) @binding(2) var sceneTex: texture_2d<f32>;
@group(0) @binding(3) var depthTex: texture_depth_2d;
@group(0) @binding(4) var linSampler: sampler;

const STEPS: i32 = 24;

/** Bright where the sky shows through, black where geometry occludes it. */
fn occlusionAt(uv: vec2<f32>) -> vec3<f32> {
  let dim = vec2<f32>(textureDimensions(depthTex, 0));
  let d = textureLoad(depthTex, vec2<i32>(clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)) * dim), 0);
  if (d < 0.99999) { return vec3<f32>(0.0); }   // solid geometry blocks the ray
  let c = textureSampleLevel(sceneTex, linSampler, uv, 0.0).rgb;
  // Only genuinely bright sky contributes; dim overcast should not streak.
  let l = luminance(c);
  return c * smoothstep(0.9, 3.5, l);
}

@fragment
fn fs_rays(in: FSOut) -> @location(0) vec4<f32> {
  if (rp.cfg.z <= 0.001) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }

  let sunUV = rp.cfg.xy;
  var uv = in.uv;
  let delta = (uv - sunUV) * (rp.cfg2.x / f32(STEPS));

  var color = vec3<f32>(0.0);
  var illum = 1.0;
  // Per-pixel jitter breaks the concentric banding a fixed step count causes.
  let jitter = fract(sin(dot(in.pos.xy, vec2<f32>(12.9898, 78.233))) * 43758.5453);
  uv = uv - delta * jitter;

  for (var i = 0; i < STEPS; i = i + 1) {
    uv = uv - delta;
    color = color + occlusionAt(uv) * illum;
    illum = illum * rp.cfg.w;
  }

  color = color * (rp.cfg2.y / f32(STEPS)) * rp.cfg.z;
  // Fade out as the sun leaves the frame so rays cannot pop at the edge.
  let edge = max(abs(sunUV.x - 0.5), abs(sunUV.y - 0.5));
  color = color * (1.0 - smoothstep(0.5, 1.15, edge));
  return vec4<f32>(color, 1.0);
}
