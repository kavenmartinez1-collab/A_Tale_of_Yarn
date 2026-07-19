// Rain — screen-space streak overlay. Fullscreen triangle drawn LAST (after
// the water), alpha-blended, depth compare 'always' so it covers everything.
// Two layers of hash-gated falling dashes; density and opacity scale with
// frame.rainLevel (0 → fully transparent; main.ts skips the draw entirely).

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

@group(0) @binding(0) var<uniform> frame: Frame;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) ndc: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  // Oversized triangle covering the screen: (-1,-1) (3,-1) (-1,3)
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  var out: VSOut;
  out.pos = vec4<f32>(x, y, 0.0, 1.0);
  out.ndc = vec2<f32>(x, y);
  return out;
}

// One layer of falling dashes: columns hashed, only a rainLevel-scaled
// fraction active, each with its own speed/phase. Returns streak alpha.
fn layer(ndc: vec2<f32>, cols: f32, vfreq: f32, speed: f32, salt: f32) -> f32 {
  let x = ndc.x * cols + salt;
  let col = floor(x);
  let h = fract(sin(col * 127.1 + salt * 311.7) * 43758.5453);
  // Column gate: more columns rain as rainLevel rises.
  if (h > frame.rainLevel * 0.85) { return 0.0; }
  // Thin vertical streak within the column.
  let fx = abs(fract(x) - 0.5);
  let thin = 1.0 - smoothstep(0.03, 0.10, fx);
  // Falling dash along y: occupies ~a third of each period.
  let y = fract(ndc.y * vfreq + frame.time * (speed + h * 1.2) + h * 7.0);
  let dash = smoothstep(0.0, 0.10, y) * smoothstep(0.45, 0.20, y);
  return thin * dash;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  var a = layer(in.ndc, 70.0, 0.9, 2.6, 0.0) * 0.5;   // near: fast, sparse
  a += layer(in.ndc, 110.0, 1.4, 1.8, 5.0) * 0.35;    // far: slower, finer
  a *= frame.rainLevel * 0.55;
  // Cool grey-blue streaks; premult-style output with straight alpha blend.
  return vec4<f32>(0.65, 0.70, 0.78, a);
}
