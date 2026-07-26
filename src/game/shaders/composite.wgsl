// ---------------------------------------------------------------------------
// composite.wgsl — the single place the frame becomes an image.
//
// Scene shaders write linear HDR; everything that used to be a per-shader
// `grade()` copy now happens exactly once here:
//   AO on the ambient term -> bloom -> god rays -> exposure -> ACES ->
//   colour grade -> vignette -> grain -> chromatic aberration
//
// Applying AO against the ambient *ratio* the G-buffer stored (rather than
// multiplying the whole image) keeps occlusion out of directly sunlit pixels,
// which is where naive SSAO looks like dirt.
// ---------------------------------------------------------------------------

#include "fullscreen.wgsl"

struct PostParams {
  // x: exposure, y: bloom intensity, z: AO strength, w: vignette
  cfg: vec4<f32>,
  // x: grain, y: chromatic aberration, z: saturation, w: contrast
  cfg2: vec4<f32>,
  // rgb: shadow tint, a: underwater amount
  shadowTint: vec4<f32>,
  // rgb: highlight tint, a: hurt/vignette pulse
  highlightTint: vec4<f32>,
}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<uniform> pp: PostParams;
@group(0) @binding(2) var sceneTex:  texture_2d<f32>;
@group(0) @binding(3) var bloomTex:  texture_2d<f32>;
@group(0) @binding(4) var aoTex:     texture_2d<f32>;
@group(0) @binding(5) var normalTex: texture_2d<f32>;
@group(0) @binding(6) var raysTex:   texture_2d<f32>;
@group(0) @binding(7) var linSampler: sampler;

/** ACES filmic tonemap (Narkowicz's fit) — the filmic shoulder is most of
 *  what separates "rendered" from "screenshot of a game". */
fn acesFilm(x: vec3<f32>) -> vec3<f32> {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e),
               vec3<f32>(0.0), vec3<f32>(1.0));
}

/** Split-tone grade: cool the shadows, warm the highlights, then trim
 *  contrast and saturation. Subtle, but it is what gives a scene a look. */
fn grade(c: vec3<f32>) -> vec3<f32> {
  let l = luminance(c);
  let shadowW = 1.0 - smoothstep(0.0, 0.55, l);
  let highW = smoothstep(0.35, 1.0, l);
  var x = c * mix(vec3<f32>(1.0), pp.shadowTint.rgb, shadowW * 0.55);
  x = x * mix(vec3<f32>(1.0), pp.highlightTint.rgb, highW * 0.45);
  // Contrast about mid-grey.
  x = (x - vec3<f32>(0.5)) * pp.cfg2.w + vec3<f32>(0.5);
  let l2 = luminance(x);
  x = mix(vec3<f32>(l2), x, pp.cfg2.z);
  return clamp(x, vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs_composite(in: FSOut) -> @location(0) vec4<f32> {
  let texel = frame.screenSize.zw;

  // Chromatic aberration: sample the scene per channel along the radial
  // direction, scaled by distance from centre so it only shows at the edges.
  let toCenter = in.uv - vec2<f32>(0.5);
  let r2 = dot(toCenter, toCenter);
  let ca = pp.cfg2.y * r2;
  var hdr: vec3<f32>;
  if (ca > 0.0001) {
    let off = toCenter * ca;
    hdr = vec3<f32>(
      textureSampleLevel(sceneTex, linSampler, in.uv + off, 0.0).r,
      textureSampleLevel(sceneTex, linSampler, in.uv, 0.0).g,
      textureSampleLevel(sceneTex, linSampler, in.uv - off, 0.0).b,
    );
  } else {
    hdr = textureSampleLevel(sceneTex, linSampler, in.uv, 0.0).rgb;
  }

  // Ambient occlusion, applied only to the ambient share of each pixel.
  let ao = textureSampleLevel(aoTex, linSampler, in.uv, 0.0).r;
  let ambientRatio = textureSampleLevel(normalTex, linSampler, in.uv, 0.0).a;
  let aoFactor = 1.0 - (1.0 - ao) * pp.cfg.z * ambientRatio;
  hdr = hdr * aoFactor;

  // Bloom + light shafts.
  let bloom = textureSampleLevel(bloomTex, linSampler, in.uv, 0.0).rgb;
  hdr = hdr + bloom * pp.cfg.y;
  let rays = textureSampleLevel(raysTex, linSampler, in.uv, 0.0).rgb;
  hdr = hdr + rays;

  // Underwater: absorb red first, then green — the real depth-colour curve.
  if (pp.shadowTint.a > 0.001) {
    let w = pp.shadowTint.a;
    let absorbed = hdr * vec3<f32>(0.30, 0.68, 0.92);
    hdr = mix(hdr, absorbed * vec3<f32>(0.55, 0.85, 1.05), w);
  }

  var color = acesFilm(hdr * pp.cfg.x);
  color = grade(color);

  // Vignette — smooth radial falloff, plus a red pulse when hurt.
  let d = length(toCenter * vec2<f32>(1.0, 0.92));
  let vig = 1.0 - pp.cfg.w * smoothstep(0.32, 0.86, d);
  color = color * vig;
  if (pp.highlightTint.a > 0.001) {
    let pulse = smoothstep(0.15, 0.75, d) * pp.highlightTint.a;
    color = mix(color, vec3<f32>(0.42, 0.02, 0.02), pulse);
  }

  // Animated film grain, weighted toward the shadows where it reads as
  // sensor noise rather than dirt on the lens.
  let gn = fract(sin(dot(in.uv * frame.screenSize.xy
    + vec2<f32>(frame.time * 91.7, frame.time * 47.3),
    vec2<f32>(12.9898, 78.233))) * 43758.5453) - 0.5;
  color = color + gn * pp.cfg2.x * (1.0 - luminance(color) * 0.7);

  return vec4<f32>(clamp(color, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
