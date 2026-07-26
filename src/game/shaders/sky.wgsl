// Sky — atmosphere, sun, moon, stars and two cloud decks.
//
// Drawn as a fullscreen triangle at far depth after the opaque geometry, so it
// only fills pixels nothing else claimed. The view ray comes from unprojecting
// NDC through invViewProj.
//
// The zenith/horizon/sun colours still come from environment.ts's authored
// day-night keyframes — this shader adds the structure those keyframes cannot
// express: Mie forward-scatter around the sun, horizon warming, a limb-
// darkened sun disc, a phased moon, a twinkling star field with a Milky Way
// band, and lit, self-shadowed clouds.
//
// Emits linear HDR: the sun disc is deliberately ~200x mid-grey so the bloom
// chain has something real to bloom.

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
  // z = 1 puts it at the far plane; the pipeline uses less-equal depth.
  out.pos = vec4<f32>(x, y, 1.0, 1.0);
  out.ndc = vec2<f32>(x, y);
  return out;
}

// --- star field -------------------------------------------------------------

fn hash31(p: vec3<f32>) -> f32 {
  var q = fract(p * 0.3183099 + vec3<f32>(0.1, 0.1, 0.1));
  q = q * 17.0;
  return fract(q.x * q.y * q.z * (q.x + q.y + q.z));
}

/** Point stars on a direction-space lattice, plus a Milky Way band. */
fn starField(dir: vec3<f32>) -> vec3<f32> {
  var total = vec3<f32>(0.0);

  // Two lattice densities so the field holds both bright and faint stars.
  for (var layer = 0; layer < 2; layer = layer + 1) {
    let density = select(140.0, 78.0, layer == 0);
    let cell = dir * density;
    let id = floor(cell);
    let f = fract(cell) - 0.5;

    let r = hash31(id);
    if (r > 0.965) {   // only a fraction of cells hold a star
      let jitter = vec3<f32>(hash31(id + 1.7), hash31(id + 3.1),
                             hash31(id + 5.3)) - 0.5;
      let d = length(f - jitter * 0.6);
      let mag = fract(r * 91.7);
      // Two detuned sines so the twinkle period never reads as regular.
      let tw = 0.72 + 0.28 * sin(frame.time * (1.4 + mag * 3.1) + r * 62.0)
                    * sin(frame.time * 0.77 + r * 21.0);
      let core = smoothstep(0.10, 0.0, d) * (0.35 + mag * 1.5) * tw;
      // Cool blue-white through warm orange, by "spectral class".
      let tint = mix(vec3<f32>(0.72, 0.82, 1.10), vec3<f32>(1.10, 0.86, 0.66),
                     fract(r * 37.3));
      total = total + tint * core;
    }
  }

  // Milky Way: a soft dusty band tilted off the celestial equator.
  let band = dir.y * 0.82 + dir.x * 0.42 + dir.z * 0.38;
  let bandMask = exp(-band * band * 13.0);
  let dust = fbm2(vec2<f32>(dir.x, dir.z) * 3.6 + vec2<f32>(dir.y * 2.0), 4);
  total = total + vec3<f32>(0.34, 0.36, 0.50) * bandMask * (0.10 + dust * 0.30);

  return total;
}

// --- clouds -----------------------------------------------------------------

/** Domain-warped fBm density for one cloud deck. */
fn cloudDensity(p: vec2<f32>, coverage: f32, warpAmt: f32) -> f32 {
  let w = vec2<f32>(fbm2(p * 0.5 + vec2<f32>(1.7, 9.2), 3),
                    fbm2(p * 0.5 + vec2<f32>(8.3, 2.8), 3)) - 0.5;
  let q = p + w * warpAmt;
  let d = fbm2(q, 5);
  // Coverage remaps the threshold: 0 -> nearly clear, 1 -> solid overcast.
  // fBm output clusters around 0.5, so the clear end of the range has to sit
  // well above that or a "clear" sky still comes out half covered.
  let thresh = mix(0.76, 0.26, coverage);
  return smoothstep(thresh, thresh + 0.26, d);
}

/**
 * Shade one cloud deck. Two extra density taps toward the sun approximate
 * optical depth, which is what gives clouds volume and the bright rim.
 */
fn shadeCloud(
  p: vec2<f32>, sunOffset: vec2<f32>, coverage: f32, warp: f32,
  baseTint: vec3<f32>,
) -> vec4<f32> {
  let d = cloudDensity(p, coverage, warp);
  if (d <= 0.001) { return vec4<f32>(0.0); }

  let s1 = cloudDensity(p + sunOffset, coverage, warp);
  let s2 = cloudDensity(p + sunOffset * 2.4, coverage, warp);
  let shadow = clamp(1.0 - (s1 * 0.55 + s2 * 0.30), 0.0, 1.0);

  // Thin edges scatter forward and glow.
  let rim = smoothstep(0.75, 0.05, d);
  let sunUp = smoothstep(-0.10, 0.12, frame.sunDir.y);

  let lit = frame.sunColor * (0.35 + 1.05 * shadow) * sunUp;
  let amb = mix(frame.fogColor, frame.skyZenith, 0.45)
          * (0.55 + 0.45 * frame.ambient * 3.0);
  var c = baseTint * (lit + amb);
  c = c + frame.sunColor * rim * shadow * 1.35 * sunUp;
  // At night clouds go dark and slightly blue rather than vanishing.
  c = mix(c, vec3<f32>(0.030, 0.038, 0.062), frame.starVis * 0.80);
  return vec4<f32>(c, d);
}

// --- main -------------------------------------------------------------------

@fragment
fn fs_main(in: VSOut) -> SceneOut {
  let near = frame.invViewProj * vec4<f32>(in.ndc, 0.0, 1.0);
  let far = frame.invViewProj * vec4<f32>(in.ndc, 1.0, 1.0);
  let dir = normalize(far.xyz / far.w - near.xyz / near.w);

  let up = clamp(dir.y, -1.0, 1.0);
  let cosSun = dot(dir, frame.sunDir);
  let sunUp = smoothstep(-0.12, 0.10, frame.sunDir.y);

  // --- base atmosphere ---
  // The exponent compresses colour toward the horizon the way real optical
  // depth does, instead of a linear zenith-to-horizon ramp.
  let t = pow(clamp(up * 0.5 + 0.5, 0.0, 1.0), 0.42);
  let horizonBand = pow(1.0 - abs(up), 5.0);
  var sky = mix(frame.skyHorizon, frame.skyZenith, smoothstep(0.30, 0.95, t));
  sky = mix(sky, frame.fogColor * 1.02, horizonBand * 0.50);

  // Mie forward scattering: the broad bright halo around the sun.
  let g = 0.62;
  let mie = (1.0 - g * g)
          / (4.0 * 3.14159265 * pow(1.0 + g * g - 2.0 * g * max(cosSun, 0.0), 1.5));
  sky = sky + frame.sunColor * mie * 0.55 * sunUp;
  // Broader glow, strongest near the horizon at golden hour.
  let glow = pow(max(cosSun, 0.0), 6.0);
  sky = sky + frame.sunColor * glow * (0.45 + horizonBand * 1.5) * sunUp;
  // A little opposition brightening keeps the anti-solar sky from going flat.
  sky = sky + frame.skyZenith * pow(max(-cosSun, 0.0), 3.0) * 0.10;

  // --- night sky ---
  if (frame.starVis > 0.001) {
    sky = sky + starField(dir) * frame.starVis * smoothstep(-0.06, 0.10, up);

    let cosMoon = dot(dir, frame.moonDir);
    let moonHalo = pow(max(cosMoon, 0.0), 900.0) * 0.6
                 + pow(max(cosMoon, 0.0), 40.0) * 0.05;
    let discMask = smoothstep(0.99955, 0.99975, cosMoon);
    if (discMask > 0.0) {
      // Phase terminator: shade by position across the disc. moonPhase is the
      // illuminated fraction, so phase 1 must light the whole disc — hence
      // the edge sweeps from +1 (new) to -1 (full).
      let right = normalize(cross(frame.moonDir, vec3<f32>(0.0, 1.0, 0.0)));
      let local = dot(normalize(dir - frame.moonDir * cosMoon), right);
      let phaseEdge = 1.0 - frame.moonPhase * 2.0;
      let lit = smoothstep(phaseEdge - 0.18, phaseEdge + 0.18, local);
      // Faint maria mottling so it is not a flat white circle.
      let maria = 0.86 + 0.14 * fbm2(dir.xz * 260.0, 3);
      sky = sky + vec3<f32>(0.92, 0.93, 0.88) * discMask * lit * maria
          * 3.2 * frame.starVis;
    }
    sky = sky + vec3<f32>(0.60, 0.66, 0.85) * moonHalo * frame.starVis;
  }

  // --- sun disc (angular radius ~0.27 deg) ---
  let discEdge = smoothstep(0.99986, 0.99994, cosSun);
  if (discEdge > 0.0 && frame.sunDir.y > -0.09) {
    // Limb darkening: the rim of the disc is dimmer than the centre.
    let r = clamp((1.0 - cosSun) / 0.00014, 0.0, 1.0);
    let limb = 0.42 + 0.58 * sqrt(max(1.0 - r * r, 0.0));
    sky = sky + frame.sunColor * discEdge * limb * 220.0 * sunUp;
  }

  // --- cloud decks (planes the upward ray intersects) ---
  if (dir.y > 0.008) {
    let wind = frame.params0.y;
    let sunOff = normalize(vec2<f32>(frame.sunDir.x, frame.sunDir.z)
                           + vec2<f32>(1e-4)) * 0.055;

    // Low cumulus.
    let pLow = (frame.cameraPos.xz + dir.xz * (620.0 / dir.y)) * 0.00075
             + vec2<f32>(wind * 0.010, wind * 0.004);
    let low = shadeCloud(pLow, sunOff, frame.cloudCover, 1.05,
      mix(vec3<f32>(1.02, 1.00, 0.98), vec3<f32>(0.52, 0.54, 0.58),
          frame.rainLevel * 0.85));

    // High cirrus: thinner, stretched, faster.
    let pHigh = (frame.cameraPos.xz + dir.xz * (2200.0 / dir.y))
              * vec2<f32>(0.00030, 0.00090)
              + vec2<f32>(wind * 0.022, wind * 0.006);
    // Cirrus stays sparse: a high deck that covers the whole dome reads as
    // haze, not as weather, and greys out an otherwise blue sky.
    let high = shadeCloud(pHigh, sunOff * 0.6,
      clamp(frame.cloudCover * 0.42, 0.0, 1.0), 0.55,
      vec3<f32>(1.05, 1.02, 1.00));

    // Both decks fade into horizon haze rather than ending in a hard line.
    let fadeLow = smoothstep(0.008, 0.10, dir.y);
    let fadeHigh = smoothstep(0.020, 0.16, dir.y);
    sky = mix(sky, high.rgb, clamp(high.a * 0.40 * fadeHigh, 0.0, 1.0));
    sky = mix(sky, low.rgb, clamp(low.a * fadeLow, 0.0, 1.0));
  }

  // Rays pointing below the horizon (past the water quad) get ground haze.
  sky = mix(sky, frame.fogColor * 0.86, smoothstep(0.0, -0.12, up));

  var out: SceneOut;
  out.color = vec4<f32>(max(sky, vec3<f32>(0.0)), 1.0);
  // Target 1 is write-masked off for the sky pipeline, but WGSL still
  // requires the struct be fully populated.
  out.normal = vec4<f32>(0.5, 0.5, 0.5, 0.0);
  return out;
}
