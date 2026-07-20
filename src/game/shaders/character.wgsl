// Character — interleaved pos3+color3 triangle soup (character-mesh.ts),
// posed on the CPU each frame; the object uniform supplies the world offset.
// Flat dpdx/dpdy shading like tree.wgsl (normal flipped toward the camera —
// boxes have vertical faces), half-Lambert sun + ambient, exponential fog.

// Keep in sync with the packing in renderer.ts (same 240-byte Frame).
struct Frame {
  viewProj: mat4x4<f32>,
  invViewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  sunDir: vec3<f32>,
  fogColor: vec3<f32>,
  fogDensity: f32,
  time: f32,
  sunColor: vec3<f32>,
  ambient: f32,
  skyZenith: vec3<f32>,
  starVis: f32,
  cloudCover: f32,
  rainLevel: f32,
  envPad: vec2<f32>,
}

struct ObjectData {
  offset: vec4<f32>, // xyz world offset (w unused here)
  color: vec4<f32>,  // unused — the character bakes vertex colors
}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> object: ObjectData;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) color: vec3<f32>,
}

// --- shared stylized lighting helpers (keep identical across scene shaders) --

// Hemispheric ambient (cool sky above, warm bounce below) + half-Lambert sun
// + a weak cool moon fill at night (starVis-gated, mirrored sun direction).
fn sceneLight(albedo: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
  let up = n.y * 0.5 + 0.5;
  let ambTint = mix(vec3<f32>(1.06, 0.98, 0.88), vec3<f32>(0.86, 0.96, 1.14), up);
  let diff = dot(n, frame.sunDir) * 0.5 + 0.5;
  let sun = (0.26 * diff + 0.62 * diff * diff) * frame.sunColor;
  let moonDir = normalize(vec3<f32>(-frame.sunDir.x, abs(frame.sunDir.y), -frame.sunDir.z));
  let moon = max(dot(n, moonDir), 0.0) * frame.starVis * vec3<f32>(0.05, 0.06, 0.10);
  return albedo * (frame.ambient * ambTint + sun + moon);
}

// Gentle filmic-ish grade: lifts shadows, rolls off highlights, +10% sat.
fn grade(c: vec3<f32>) -> vec3<f32> {
  let x = max(c, vec3<f32>(0.0));
  let toned = x * (vec3<f32>(1.25) + x * 0.45)
            / (vec3<f32>(1.0) + x * (vec3<f32>(0.90) + x * 0.45));
  let l = dot(toned, vec3<f32>(0.2126, 0.7152, 0.0722));
  return mix(vec3<f32>(l), toned, 1.10);
}

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) color: vec3<f32>,
) -> VSOut {
  let world = position + object.offset.xyz;
  var out: VSOut;
  out.pos = frame.viewProj * vec4<f32>(world, 1.0);
  out.worldPos = world;
  out.color = color;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  var n = normalize(cross(dpdx(in.worldPos), dpdy(in.worldPos)));
  if (dot(n, frame.cameraPos - in.worldPos) < 0.0) { n = -n; }

  var color = sceneLight(in.color, n);

  let dist = distance(in.worldPos, frame.cameraPos);
  let fog = 1.0 - exp(-frame.fogDensity * dist);
  color = mix(color, frame.fogColor, fog);

  return vec4<f32>(grade(color), 1.0);
}
