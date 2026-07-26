// Grass — instanced ground clutter over the near terrain.
//
// Two vec4s per instance: (x, y, z, scale) and (tintRGB, phase). Blades bend
// rather than tilt: the wind offset is weighted by height^2 up the blade, so
// the base stays rooted and the tip travels, which is what reads as grass
// rather than as a swinging card.
//
// Tufts shrink to nothing past the fade distance instead of alpha-fading, so
// no blending or sorting is needed anywhere in the pass.

#include "common.wgsl"

@group(1) @binding(0) var<storage, read> instances: array<vec4<f32>>;

const FADE_START: f32 = 30.0;
const FADE_END: f32 = 46.0;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) tint: vec3<f32>,
  @location(3) heightFrac: f32,
}

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @builtin(instance_index) ii: u32,
) -> VSOut {
  let base = instances[ii * 2u];
  let look = instances[ii * 2u + 1u];

  // Distance fade: collapse the tuft to a degenerate point past FADE_END.
  let d = distance(base.xyz, frame.cameraPos);
  var scale = base.w * (1.0 - smoothstep(FADE_START, FADE_END, d));

  // Per-instance yaw from the phase so neighbouring tufts differ.
  let yaw = look.w;
  let s = sin(yaw);
  let c = cos(yaw);
  let local = vec3<f32>(position.x, position.y, position.z) * scale;
  let rotated = vec3<f32>(local.x * c - local.z * s, local.y,
                          local.x * s + local.z * c);

  // Bend weighted by height^2 — the root holds, the tip swings.
  let hFrac = clamp(position.y, 0.0, 1.5);
  let bend = hFrac * hFrac;
  let sway = windOffset(frame, base.xyz, 0.30 * scale, look.w);

  var world = rotated + base.xyz + sway * bend;

  var out: VSOut;
  out.pos = frame.viewProj * vec4<f32>(world, 1.0);
  out.worldPos = world;
  out.normal = vec3<f32>(normal.x * c - normal.z * s, normal.y,
                         normal.x * s + normal.z * c);
  out.tint = look.rgb;
  out.heightFrac = hFrac;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> SceneOut {
  var n = normalize(in.normal);
  // Blades are single quads drawn double-sided.
  if (dot(n, frame.cameraPos - in.worldPos) < 0.0) { n = -n; }

  let viewDist = distance(in.worldPos, frame.cameraPos);

  // Darker and cooler at the root, brighter and warmer at the tip — the
  // vertical gradient does more for the read of depth in a field than any
  // amount of per-blade detail.
  let up = clamp(in.heightFrac, 0.0, 1.0);
  var albedo = in.tint * mix(0.62, 1.14, up * up * 0.6 + up * 0.4);

  // Self-shadowing inside the tuft: ambient occlusion falls off with height.
  let selfAo = mix(0.66, 1.0, up);

  let shadow = sunShadow(in.worldPos, n, viewDist);
  // Thin blades transmit a lot of light — this is what makes a backlit field
  // glow at low sun angles.
  let lit = shadeSurface(albedo, n, in.worldPos, 0.80, 0.0,
                         selfAo, shadow, 1.05);
  let torch = pointLights(in.worldPos, n, albedo, 0.80);

  let viewDir = normalize(in.worldPos - frame.cameraPos);
  var out: SceneOut;
  out.color = vec4<f32>(applyFog(lit.color + torch, in.worldPos, viewDir), 1.0);
  out.normal = packNormal(n, lit.ambientRatio);
  return out;
}
