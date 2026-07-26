// ---------------------------------------------------------------------------
// fxaa.wgsl — FXAA 3.11 (quality preset), the final pass to the swapchain.
//
// The scene is low-poly with long straight silhouettes, which is exactly the
// case that shows stair-stepping worst. MSAA would be the higher-quality fix
// but it forces a multisampled depth buffer, and SSAO and the water pass both
// need to *read* depth — so a post-resolve edge filter is the right trade.
// ---------------------------------------------------------------------------

#include "fullscreen.wgsl"

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var linSampler: sampler;

const EDGE_THRESHOLD_MIN: f32 = 0.0312;
const EDGE_THRESHOLD_MAX: f32 = 0.125;
const SUBPIXEL_QUALITY: f32 = 0.75;
const ITERATIONS: i32 = 12;

fn lum(uv: vec2<f32>) -> f32 {
  return luminance(textureSampleLevel(srcTex, linSampler, uv, 0.0).rgb);
}

/** Step lengths for the edge search — short near the origin, long far out. */
fn quality(i: i32) -> f32 {
  if (i < 5) { return 1.0; }
  if (i == 5) { return 1.5; }
  if (i < 10) { return 2.0; }
  if (i == 10) { return 4.0; }
  return 8.0;
}

@fragment
fn fs_fxaa(in: FSOut) -> @location(0) vec4<f32> {
  let dim = vec2<f32>(textureDimensions(srcTex, 0));
  let texel = 1.0 / dim;
  let uv = in.uv;

  let center = textureSampleLevel(srcTex, linSampler, uv, 0.0);
  let lumC = luminance(center.rgb);
  let lumD = lum(uv + vec2<f32>(0.0, texel.y));
  let lumU = lum(uv + vec2<f32>(0.0, -texel.y));
  let lumL = lum(uv + vec2<f32>(-texel.x, 0.0));
  let lumR = lum(uv + vec2<f32>(texel.x, 0.0));

  let lumMin = min(lumC, min(min(lumD, lumU), min(lumL, lumR)));
  let lumMax = max(lumC, max(max(lumD, lumU), max(lumL, lumR)));
  let range = lumMax - lumMin;

  // Flat enough to leave alone.
  if (range < max(EDGE_THRESHOLD_MIN, lumMax * EDGE_THRESHOLD_MAX)) {
    return center;
  }

  let lumDL = lum(uv + vec2<f32>(-texel.x, texel.y));
  let lumUR = lum(uv + vec2<f32>(texel.x, -texel.y));
  let lumUL = lum(uv + vec2<f32>(-texel.x, -texel.y));
  let lumDR = lum(uv + vec2<f32>(texel.x, texel.y));

  let lumDU = lumD + lumU;
  let lumLR = lumL + lumR;
  let lumLCorners = lumDL + lumUL;
  let lumDCorners = lumDL + lumDR;
  let lumRCorners = lumDR + lumUR;
  let lumUCorners = lumUR + lumUL;

  let edgeH = abs(-2.0 * lumL + lumLCorners)
            + abs(-2.0 * lumC + lumDU) * 2.0
            + abs(-2.0 * lumR + lumRCorners);
  let edgeV = abs(-2.0 * lumU + lumUCorners)
            + abs(-2.0 * lumC + lumLR) * 2.0
            + abs(-2.0 * lumD + lumDCorners);
  let isHorizontal = edgeH >= edgeV;

  let lum1 = select(lumL, lumD, isHorizontal);
  let lum2 = select(lumR, lumU, isHorizontal);
  let grad1 = lum1 - lumC;
  let grad2 = lum2 - lumC;
  let is1Steepest = abs(grad1) >= abs(grad2);
  let gradScaled = 0.25 * max(abs(grad1), abs(grad2));

  var stepLength = select(texel.x, texel.y, isHorizontal);
  var lumLocalAvg = 0.0;
  if (is1Steepest) {
    stepLength = -stepLength;
    lumLocalAvg = 0.5 * (lum1 + lumC);
  } else {
    lumLocalAvg = 0.5 * (lum2 + lumC);
  }

  var currentUv = uv;
  if (isHorizontal) { currentUv.y = currentUv.y + stepLength * 0.5; }
  else { currentUv.x = currentUv.x + stepLength * 0.5; }

  let offset = select(vec2<f32>(0.0, texel.y), vec2<f32>(texel.x, 0.0), isHorizontal);
  var uv1 = currentUv - offset;
  var uv2 = currentUv + offset;

  var lumEnd1 = lum(uv1) - lumLocalAvg;
  var lumEnd2 = lum(uv2) - lumLocalAvg;
  var reached1 = abs(lumEnd1) >= gradScaled;
  var reached2 = abs(lumEnd2) >= gradScaled;
  var reachedBoth = reached1 && reached2;

  if (!reached1) { uv1 = uv1 - offset; }
  if (!reached2) { uv2 = uv2 + offset; }

  if (!reachedBoth) {
    for (var i = 2; i < ITERATIONS; i = i + 1) {
      if (!reached1) { lumEnd1 = lum(uv1) - lumLocalAvg; }
      if (!reached2) { lumEnd2 = lum(uv2) - lumLocalAvg; }
      reached1 = abs(lumEnd1) >= gradScaled;
      reached2 = abs(lumEnd2) >= gradScaled;
      reachedBoth = reached1 && reached2;
      if (!reached1) { uv1 = uv1 - offset * quality(i); }
      if (!reached2) { uv2 = uv2 + offset * quality(i); }
      if (reachedBoth) { break; }
    }
  }

  let dist1 = select(uv.y - uv1.y, uv.x - uv1.x, isHorizontal);
  let dist2 = select(uv2.y - uv.y, uv2.x - uv.x, isHorizontal);
  let isDir1 = dist1 < dist2;
  let dist = min(dist1, dist2);
  let edgeThickness = dist1 + dist2;
  var pixelOffset = -dist / max(edgeThickness, 1e-5) + 0.5;

  // Reject the offset if the edge does not actually straddle this pixel.
  let isLumCSmaller = lumC < lumLocalAvg;
  let correctVariation =
    ((select(lumEnd2, lumEnd1, isDir1) < 0.0) != isLumCSmaller);
  var finalOffset = select(0.0, pixelOffset, correctVariation);

  // Sub-pixel antialiasing for thin features the edge search cannot resolve.
  let lumAvg = (1.0 / 12.0) * (2.0 * (lumDU + lumLR)
    + lumLCorners + lumRCorners);
  let subPixA = clamp(abs(lumAvg - lumC) / max(range, 1e-5), 0.0, 1.0);
  let subPixB = (-2.0 * subPixA + 3.0) * subPixA * subPixA;
  let subPixOffset = subPixB * subPixB * SUBPIXEL_QUALITY;
  finalOffset = max(finalOffset, subPixOffset);

  var finalUv = uv;
  if (isHorizontal) { finalUv.y = finalUv.y + finalOffset * stepLength; }
  else { finalUv.x = finalUv.x + finalOffset * stepLength; }

  return textureSampleLevel(srcTex, linSampler, finalUv, 0.0);
}
