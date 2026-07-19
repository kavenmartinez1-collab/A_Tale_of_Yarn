// Dungeon: torch-lit stylized flat shading for underground interiors and
// their surface entrance structures.
//
// Differences from terrain.wgsl (do NOT merge them):
// - Flat normals from dpdx/dpdy are flipped TOWARD THE CAMERA, not to +Y —
//   ceilings legitimately face down. With back-face culling every visible
//   fragment's true geometric normal faces the camera, so this is exact.
// - Group 2 carries up to 32 torch point lights (interiors are sunless).
// - Material rides object.offset.w:  w >= 100 -> surface path (sun + fog,
//   entrance structures);  w < 100 -> interior path (ambient + torches).
//   (w % 100) selects the palette: 0 stone, 1 wood, 2 torch glow (emissive),
//   3 portal glow (emissive), 4 thatch roof, 5 plaster wall (settlement
//   buildings), 6 bush leaf, 7 berry red (resource nodes) — 4..7 are lit.

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
  offset: vec4<f32>, // xyz world offset, w material mode (see header)
}

struct Light {
  pos: vec4<f32>,         // xyz world position (w unused)
  colorRadius: vec4<f32>, // rgb color, w radius (m)
}

struct Lights {
  count: vec4<f32>,       // x = active light count (0 -> bright-ambient debug)
  lights: array<Light, 32>,
}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> object: ObjectData;
@group(2) @binding(0) var<uniform> lights: Lights;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
}

@vertex
fn vs_main(@location(0) position: vec3<f32>) -> VSOut {
  let world = position + object.offset.xyz;
  var out: VSOut;
  out.pos = frame.viewProj * vec4<f32>(world, 1.0);
  out.worldPos = world;
  return out;
}

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

/** Per-palette brightness modulation; emissives (2/3) never reach this. */
fn texFactor(palIndex: f32, wp: vec3<f32>, detail: f32) -> f32 {
  let g = hash2(floor(wp.xz * 6.0) + vec2<f32>(floor(wp.y * 6.0) * 7.31));
  var f = 0.0;
  if (palIndex < 0.5) {         // stone: strata + speckle
    f = (vnoise(vec2<f32>((wp.x + wp.z) * 0.8, wp.y * 0.9)) - 0.5) * 0.30
      + (g - 0.5) * 0.12;
  } else if (palIndex < 1.5) {  // wood: vertical grain streaks
    f = (vnoise(vec2<f32>((wp.x + wp.z) * 3.0, wp.y * 0.7)) - 0.5) * 0.35;
  } else if (palIndex < 4.5) {  // thatch: packed horizontal rows
    f = (vnoise(vec2<f32>((wp.x + wp.z) * 0.7, wp.y * 7.0)) - 0.5) * 0.35;
  } else if (palIndex < 5.5) {  // plaster: soft mottle
    f = (vnoise(wp.xz * 0.9 + vec2<f32>(wp.y, 0.0)) - 0.5) * 0.12;
  } else if (palIndex < 6.5) {  // bush leaves: clumps + dither
    f = (vnoise(wp.xz * 1.6 + vec2<f32>(wp.y * 1.1, 0.0)) - 0.5) * 0.35
      + (g - 0.5) * 0.15;
  } else {                      // berries: subtle speckle
    f = (g - 0.5) * 0.10;
  }
  return 1.0 + detail * f;
}

fn palette(index: f32) -> vec3<f32> {
  if (index < 0.5) { return vec3<f32>(0.42, 0.40, 0.44); } // stone
  if (index < 1.5) { return vec3<f32>(0.45, 0.31, 0.18); } // wood
  if (index < 2.5) { return vec3<f32>(1.00, 0.75, 0.35); } // torch glow
  if (index < 3.5) { return vec3<f32>(0.45, 0.75, 1.00); } // portal glow
  if (index < 4.5) { return vec3<f32>(0.66, 0.54, 0.26); } // thatch roof
  if (index < 5.5) { return vec3<f32>(0.80, 0.76, 0.68); } // plaster wall
  if (index < 6.5) { return vec3<f32>(0.30, 0.48, 0.20); } // bush leaf
  return vec3<f32>(0.62, 0.16, 0.22);                      // berry red
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  // Flat face normal; derivative handedness varies by backend, so flip
  // toward the camera (exact for every visible cull-back fragment).
  var n = normalize(cross(dpdx(in.worldPos), dpdy(in.worldPos)));
  if (dot(n, frame.cameraPos - in.worldPos) < 0.0) { n = -n; }

  let mode = object.offset.w;
  let surface = mode >= 100.0;
  let palIndex = mode - select(0.0, 100.0, surface);
  var albedo = palette(palIndex);

  // Emissive palettes (torch/portal glow) skip lighting entirely.
  if (palIndex >= 1.5 && palIndex < 3.5) {
    let flicker = select(1.0, 0.9 + 0.1 * sin(frame.time * 9.0), palIndex < 2.5);
    return vec4<f32>(albedo * flicker, 1.0);
  }

  // Per-pixel material detail, faded with distance (no shimmer far away).
  let dist = distance(in.worldPos, frame.cameraPos);
  albedo *= texFactor(palIndex, in.worldPos, exp(-dist * 0.02));

  var color: vec3<f32>;
  if (surface) {
    // Entrance structures stand in daylight: same look as terrain objects.
    let diff = dot(n, frame.sunDir) * 0.5 + 0.5;
    color = albedo * (frame.ambient + (0.30 * diff + 0.55 * diff * diff) * frame.sunColor);
  } else {
    let count = u32(lights.count.x);
    if (count == 0u) {
      // Debug/preview fallback: no torches uploaded yet -> flat bright,
      // with a touch of sun shading so faces stay distinguishable.
      let diff = dot(n, frame.sunDir) * 0.5 + 0.5;
      color = albedo * (0.55 + 0.45 * diff);
    } else {
      var lit = vec3<f32>(0.10, 0.10, 0.11); // faint interior ambient
      for (var i = 0u; i < count; i = i + 1u) {
        let light = lights.lights[i];
        let toLight = light.pos.xyz - in.worldPos;
        let dist = length(toLight);
        let atten = pow(clamp(1.0 - dist / light.colorRadius.w, 0.0, 1.0), 2.0);
        if (atten <= 0.0) { continue; }
        let diff = max(dot(n, toLight / max(dist, 1e-4)), 0.0);
        let flicker = 0.85 + 0.15 * sin(frame.time * 7.0 + f32(i) * 1.7);
        lit += light.colorRadius.rgb * (diff * atten * flicker);
      }
      color = albedo * lit;
    }
  }

  // Exponential distance fog (dark + dense inside, set per-frame by main).
  let fog = 1.0 - exp(-frame.fogDensity * dist);
  color = mix(color, frame.fogColor, fog);
  return vec4<f32>(color, 1.0);
}
