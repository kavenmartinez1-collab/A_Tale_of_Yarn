// Trees — instanced stylized foliage. One shared mesh (tree-mesh.ts), one
// storage buffer of instances per chunk: vec4(x, y, z, scale). A cheap
// per-instance yaw derived from the position hash breaks up the repetition.
// Shading matches terrain.wgsl: flat dpdx/dpdy normals, half-Lambert sun,
// exponential fog.

// Keep in sync with terrain.wgsl and the packing in renderer.ts.
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

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<storage, read> instances: array<vec4<f32>>;

// Keep in sync with TRUNK_TOP in tree-mesh.ts.
const TRUNK_TOP: f32 = 2.0;

// --- procedural surface detail (matches terrain.wgsl helpers) ---------------

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

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) localY: f32,
  @location(2) tint: f32,
}

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @builtin(instance_index) ii: u32,
) -> VSOut {
  let inst = instances[ii];
  // Position-hash yaw + a small green-tint variation.
  let hash = fract(sin(inst.x * 12.9898 + inst.z * 78.233) * 43758.5453);
  let yaw = hash * 6.2831853;
  let s = sin(yaw);
  let c = cos(yaw);
  let local = position * inst.w;
  let rotated = vec3<f32>(local.x * c - local.z * s, local.y,
                          local.x * s + local.z * c);
  let world = rotated + inst.xyz;
  var out: VSOut;
  out.pos = frame.viewProj * vec4<f32>(world, 1.0);
  out.worldPos = world;
  out.localY = position.y;
  out.tint = hash;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  var n = normalize(cross(dpdx(in.worldPos), dpdy(in.worldPos)));
  // Face the normal toward the camera (boxes are watertight, either sign
  // occurs); terrain's flip-to-+Y trick doesn't work on vertical faces.
  if (dot(n, frame.cameraPos - in.worldPos) < 0.0) { n = -n; }

  let dist = distance(in.worldPos, frame.cameraPos);
  let detail = exp(-dist * 0.02); // fade texture with distance

  // Bark: vertical striations (noise stretched along Y).
  let streak = vnoise(vec2<f32>((in.worldPos.x + in.worldPos.z) * 4.0,
    in.worldPos.y * 0.7));
  let bark = vec3<f32>(0.38, 0.27, 0.18)
    * (1.0 + detail * (streak - 0.5) * 0.45);
  // Leaves: canopy clumps + fine texel dither.
  let clump = vnoise(in.worldPos.xz * 1.3
    + vec2<f32>(in.worldPos.y * 0.9, in.worldPos.y * 0.6));
  let g = hash2(floor(in.worldPos.xz * 5.0)
    + vec2<f32>(floor(in.worldPos.y * 5.0) * 7.31));
  let leafA = vec3<f32>(0.22, 0.42, 0.18);
  let leafB = vec3<f32>(0.32, 0.52, 0.20);
  let leaf = mix(leafA, leafB, in.tint)
    * (1.0 + detail * ((clump - 0.5) * 0.35 + (g - 0.5) * 0.18));
  let albedo = select(leaf, bark, in.localY < TRUNK_TOP);

  let diff = dot(n, frame.sunDir) * 0.5 + 0.5;
  var color = albedo * (frame.ambient + (0.30 * diff + 0.55 * diff * diff) * frame.sunColor);

  let fog = 1.0 - exp(-frame.fogDensity * dist);
  color = mix(color, frame.fogColor, fog);

  return vec4<f32>(color, 1.0);
}
