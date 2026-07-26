// Rain — screen-space streak overlay. Fullscreen triangle drawn last in the
// transparent pass, alpha-blended, depth compare 'always' so it covers
// everything. Three layers of hash-gated falling dashes at different depths;
// density and opacity scale with frame.rainLevel (main.ts skips the draw at 0).
//
// Streaks are lit by the scene's own light so a downpour at dusk goes warm and
// a night storm stays near-black, instead of the flat grey the overlay used
// to paint regardless of time of day.

#include "common.wgsl"

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

/**
 * One layer of falling dashes: columns are hashed, only a rainLevel-scaled
 * fraction is active, and each active column gets its own speed and phase.
 * `slant` shears the fall so heavy rain drives at an angle.
 */
fn layer(ndc: vec2<f32>, cols: f32, vfreq: f32, speed: f32, salt: f32,
         slant: f32) -> f32 {
  let x = (ndc.x + ndc.y * slant) * cols + salt;
  let col = floor(x);
  let h = fract(sin(col * 127.1 + salt * 311.7) * 43758.5453);
  if (h > frame.rainLevel * 0.85) { return 0.0; }
  // Thin vertical streak within the column.
  let fx = abs(fract(x) - 0.5);
  let thin = 1.0 - smoothstep(0.03, 0.10, fx);
  // Falling dash along y, occupying about a third of each period.
  let y = fract(ndc.y * vfreq + frame.time * (speed + h * 1.2) + h * 7.0);
  let dash = smoothstep(0.0, 0.10, y) * smoothstep(0.45, 0.20, y);
  return thin * dash;
}

@fragment
fn fs_main(in: VSOut) -> SceneOut {
  let slant = 0.10 + 0.14 * frame.rainLevel;
  var a = layer(in.ndc, 70.0, 0.9, 2.6, 0.0, slant) * 0.50;   // near
  a = a + layer(in.ndc, 110.0, 1.4, 1.8, 5.0, slant) * 0.35;  // mid
  a = a + layer(in.ndc, 170.0, 2.1, 1.2, 11.0, slant) * 0.22; // far haze
  a = a * frame.rainLevel * 0.55;

  // Streaks scatter whatever light the scene has, so they track time of day.
  let sunUp = smoothstep(-0.05, 0.15, frame.sunDir.y);
  let lightCol = frame.sunColor * 0.35 * sunUp
               + mix(frame.fogColor, frame.skyZenith, 0.5) * frame.ambient * 3.0;
  let streak = vec3<f32>(0.80, 0.86, 0.95) * lightCol;

  var out: SceneOut;
  out.color = vec4<f32>(streak, a);
  out.normal = vec4<f32>(0.5, 0.5, 0.5, 0.0);
  return out;
}
