// ---------------------------------------------------------------------------
// bloom.wgsl — Call-of-Duty-style progressive bloom.
//
//   prefilter -> mip0     soft-knee threshold + Karis-averaged 13-tap box
//   down      -> mip1..N  13-tap box downsample (stable, no fireflies)
//   up        -> mip N-1  9-tap tent upsample, additively blended
//
// Every pass shares one binding layout (one source texture + params), so the
// whole chain runs off a single pipeline trio.
// ---------------------------------------------------------------------------

#include "fullscreen.wgsl"

struct BloomParams {
  // xy: source texel size, z: threshold, w: knee / upsample radius
  cfg: vec4<f32>,
  // x: intensity, yzw: spare
  cfg2: vec4<f32>,
}

@group(0) @binding(0) var<uniform> bp: BloomParams;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var linSampler: sampler;

fn tap(uv: vec2<f32>) -> vec3<f32> {
  return textureSampleLevel(srcTex, linSampler, uv, 0.0).rgb;
}

/** Karis weighting — averages by inverse luma so one hot pixel cannot
 *  dominate a whole downsample tile and flicker between frames. */
fn karis(c: vec3<f32>) -> f32 {
  return 1.0 / (1.0 + luminance(c));
}

fn box13(uv: vec2<f32>, t: vec2<f32>, weighted: bool) -> vec3<f32> {
  let a = tap(uv + vec2<f32>(-t.x * 2.0,  t.y * 2.0));
  let b = tap(uv + vec2<f32>( 0.0,        t.y * 2.0));
  let c = tap(uv + vec2<f32>( t.x * 2.0,  t.y * 2.0));
  let d = tap(uv + vec2<f32>(-t.x * 2.0,  0.0));
  let e = tap(uv);
  let f = tap(uv + vec2<f32>( t.x * 2.0,  0.0));
  let g = tap(uv + vec2<f32>(-t.x * 2.0, -t.y * 2.0));
  let h = tap(uv + vec2<f32>( 0.0,       -t.y * 2.0));
  let i = tap(uv + vec2<f32>( t.x * 2.0, -t.y * 2.0));
  let j = tap(uv + vec2<f32>(-t.x, t.y));
  let k = tap(uv + vec2<f32>( t.x, t.y));
  let l = tap(uv + vec2<f32>(-t.x, -t.y));
  let m = tap(uv + vec2<f32>( t.x, -t.y));

  if (weighted) {
    // Four overlapping 2x2 groups, each Karis-averaged.
    let g0 = (j + k + l + m) * 0.25; let w0 = karis(g0);
    let g1 = (a + b + d + e) * 0.25; let w1 = karis(g1);
    let g2 = (b + c + e + f) * 0.25; let w2 = karis(g2);
    let g3 = (d + e + g + h) * 0.25; let w3 = karis(g3);
    let g4 = (e + f + h + i) * 0.25; let w4 = karis(g4);
    let wsum = w0 * 0.5 + (w1 + w2 + w3 + w4) * 0.125;
    return (g0 * w0 * 0.5 + (g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) * 0.125)
         / max(wsum, 1e-5);
  }
  var r = e * 0.125;
  r = r + (a + c + g + i) * 0.03125;
  r = r + (b + d + f + h) * 0.0625;
  r = r + (j + k + l + m) * 0.125;
  return r;
}

/** Soft-knee threshold: a gradual roll-in avoids a hard bloom edge. */
@fragment
fn fs_prefilter(in: FSOut) -> @location(0) vec4<f32> {
  let c = box13(in.uv, bp.cfg.xy, true);
  let br = max(c.r, max(c.g, c.b));
  let knee = max(bp.cfg.w, 1e-4);
  let soft = clamp(br - bp.cfg.z + knee, 0.0, 2.0 * knee);
  let contrib = max(soft * soft / (4.0 * knee), br - bp.cfg.z) / max(br, 1e-5);
  return vec4<f32>(c * contrib, 1.0);
}

@fragment
fn fs_down(in: FSOut) -> @location(0) vec4<f32> {
  return vec4<f32>(box13(in.uv, bp.cfg.xy, false), 1.0);
}

/** 9-tap tent filter — the wide, soft kernel that gives bloom its glow. */
@fragment
fn fs_up(in: FSOut) -> @location(0) vec4<f32> {
  let t = bp.cfg.xy * bp.cfg.w;
  var r = tap(in.uv + vec2<f32>(-t.x,  t.y)) * 1.0;
  r = r + tap(in.uv + vec2<f32>( 0.0,  t.y)) * 2.0;
  r = r + tap(in.uv + vec2<f32>( t.x,  t.y)) * 1.0;
  r = r + tap(in.uv + vec2<f32>(-t.x,  0.0)) * 2.0;
  r = r + tap(in.uv)                         * 4.0;
  r = r + tap(in.uv + vec2<f32>( t.x,  0.0)) * 2.0;
  r = r + tap(in.uv + vec2<f32>(-t.x, -t.y)) * 1.0;
  r = r + tap(in.uv + vec2<f32>( 0.0, -t.y)) * 2.0;
  r = r + tap(in.uv + vec2<f32>( t.x, -t.y)) * 1.0;
  return vec4<f32>(r * (1.0 / 16.0) * bp.cfg2.x, 1.0);
}
