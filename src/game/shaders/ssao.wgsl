// ---------------------------------------------------------------------------
// ssao.wgsl — screen-space ambient occlusion at half resolution.
//
// World-space hemisphere sampling: each tap is placed on a hemisphere around
// the shaded point, projected to screen, and tested against the depth buffer.
// Working in world space (rather than scaling a screen-space radius by 1/z)
// keeps the occlusion radius physically constant, so contact shadows do not
// swell as the camera pulls back.
//
// fs_ao writes raw AO; fs_blur is a depth-aware separable blur that removes
// the per-pixel rotation noise without bleeding occlusion across silhouettes.
// ---------------------------------------------------------------------------

#include "fullscreen.wgsl"

struct AoParams {
  // x: radius (m), y: intensity, z: bias (m), w: blur direction (0 = x, 1 = y)
  cfg: vec4<f32>,
}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<uniform> ao: AoParams;
@group(0) @binding(2) var depthTex:  texture_depth_2d;
@group(0) @binding(3) var normalTex: texture_2d<f32>;
@group(0) @binding(4) var linSampler: sampler;
// The blur source lives in its own group: the AO pass renders *into* the
// texture the blur reads, and a resource cannot be an attachment and a bound
// texture in the same pass. Separate groups keep the two passes disjoint.
@group(1) @binding(0) var aoTex: texture_2d<f32>;

const TAPS: i32 = 14;
const GOLDEN: f32 = 2.39996323;

/** Interleaved gradient noise — cheap, well-distributed per-pixel rotation. */
fn ign(p: vec2<f32>) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715))));
}

fn loadDepth(pix: vec2<i32>, dim: vec2<i32>) -> f32 {
  let c = clamp(pix, vec2<i32>(0), dim - vec2<i32>(1));
  return textureLoad(depthTex, c, 0);
}

@fragment
fn fs_ao(in: FSOut) -> @location(0) f32 {
  let dim = vec2<i32>(textureDimensions(depthTex, 0));
  // This pass runs at half res; map to the nearest full-res texel.
  let full = vec2<i32>(in.uv * vec2<f32>(dim));
  let d = loadDepth(full, dim);
  if (d >= 0.99999) { return 1.0; }   // sky: never occluded

  let P = worldFromDepth(in.uv, d, frame.invViewProj);
  let nSample = textureLoad(normalTex, full, 0);
  let N = normalize(nSample.xyz * 2.0 - 1.0);
  let viewDist = distance(P, frame.cameraPos);

  let radius = ao.cfg.x;
  let bias = ao.cfg.z;

  // Build a tangent frame around N.
  var up = vec3<f32>(0.0, 1.0, 0.0);
  if (abs(N.y) > 0.95) { up = vec3<f32>(1.0, 0.0, 0.0); }
  let T = normalize(cross(up, N));
  let B = cross(N, T);

  let rot = ign(in.pos.xy) * 6.2831853;
  var occ = 0.0;

  for (var i = 0; i < TAPS; i = i + 1) {
    // Golden-angle spiral: even hemisphere coverage with no repeating pattern.
    let fi = (f32(i) + 0.5) / f32(TAPS);
    let ang = f32(i) * GOLDEN + rot;
    // sqrt keeps samples area-uniform; cube-root biases them toward the
    // centre, which weights near-contact occlusion more heavily.
    let r = radius * pow(fi, 0.65);
    let cosT = sqrt(1.0 - fi * 0.85);
    let sinT = sqrt(1.0 - cosT * cosT);
    let dir = T * (cos(ang) * sinT) + B * (sin(ang) * sinT) + N * cosT;
    let sp = P + dir * r;

    let clip = frame.viewProj * vec4<f32>(sp, 1.0);
    if (clip.w <= 0.0) { continue; }
    let ndc = clip.xyz / clip.w;
    if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) { continue; }
    let suv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);

    let sd = loadDepth(vec2<i32>(suv * vec2<f32>(dim)), dim);
    if (sd >= 0.99999) { continue; }
    let sw = worldFromDepth(suv, sd, frame.invViewProj);
    let sampleDist = distance(sw, frame.cameraPos);
    let tapDist = distance(sp, frame.cameraPos);

    // Occluded when real geometry sits in front of the sample point.
    let delta = tapDist - sampleDist;
    if (delta > bias) {
      // Range check stops distant background from occluding foreground.
      let range = smoothstep(0.0, 1.0, radius / max(delta, 1e-3));
      occ = occ + range;
    }
  }

  var v = 1.0 - (occ / f32(TAPS)) * ao.cfg.y;
  // Fade AO out with distance — it is a contact cue, and keeping it far away
  // only adds noise where the depth buffer has no precision left.
  v = mix(v, 1.0, smoothstep(60.0, 150.0, viewDist));
  return clamp(v, 0.0, 1.0);
}

/** Depth-aware separable blur over the raw AO buffer. */
@fragment
fn fs_blur(in: FSOut) -> @location(0) f32 {
  let dim = vec2<i32>(textureDimensions(aoTex, 0));
  let fullDim = vec2<i32>(textureDimensions(depthTex, 0));
  let pix = vec2<i32>(in.uv * vec2<f32>(dim));
  let step = select(vec2<i32>(1, 0), vec2<i32>(0, 1), ao.cfg.w > 0.5);

  let centerDepth = loadDepth(vec2<i32>(in.uv * vec2<f32>(fullDim)), fullDim);
  let centerW = worldFromDepth(in.uv, centerDepth, frame.invViewProj);
  let centerDist = distance(centerW, frame.cameraPos);

  var sum = 0.0;
  var wsum = 0.0;
  for (var i = -3; i <= 3; i = i + 1) {
    let p = clamp(pix + step * i, vec2<i32>(0), dim - vec2<i32>(1));
    let uv = (vec2<f32>(p) + 0.5) / vec2<f32>(dim);
    let dSample = loadDepth(vec2<i32>(uv * vec2<f32>(fullDim)), fullDim);
    let w2 = worldFromDepth(uv, dSample, frame.invViewProj);
    let dist = distance(w2, frame.cameraPos);
    // Gaussian in screen space, gated by a depth similarity term.
    let gs = exp(-f32(i * i) / 8.0);
    let gd = exp(-abs(dist - centerDist) * 2.4);
    let w = gs * gd;
    sum = sum + textureLoad(aoTex, p, 0).r * w;
    wsum = wsum + w;
  }
  return sum / max(wsum, 1e-4);
}
