// Water — one large camera-following quad at sea level (y = 0; keep in sync
// with SEA_LEVEL in noise.ts). Runs in the transparent pass, after the opaque
// scene has been copied, so it can sample what is behind it.
//
// What that copy buys, versus the old flat alpha-blended quad:
//   - refraction: the seabed bends through the wave normal
//   - depth-based absorption: red goes first, then green, over path length
//   - shoreline foam from the *actual* geometry depth, not a height guess
//   - caustics projected onto whatever the light reaches
// Plus Fresnel sky reflection, GGX sun glitter, and crest sub-surface glow.

#include "common.wgsl"

@group(1) @binding(0) var sceneCopy: texture_2d<f32>;
@group(1) @binding(1) var sceneDepth: texture_depth_2d;
@group(1) @binding(2) var sceneSampler: sampler;

const SEA_LEVEL: f32 = 0.0;
const EXTENT: f32 = 1400.0; // beyond the far-fog horizon

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0),
  );
  let c = corners[vi];
  let world = vec3<f32>(
    frame.cameraPos.x + c.x * EXTENT,
    SEA_LEVEL,
    frame.cameraPos.z + c.y * EXTENT,
  );
  var out: VSOut;
  out.pos = frame.viewProj * vec4<f32>(world, 1.0);
  out.worldPos = world;
  return out;
}

/**
 * Directional wave field — six sine trains at different scales and speeds,
 * with a sharpening exponent so crests are pointed and troughs are broad the
 * way real gravity waves are.
 */
fn waveH(p: vec2<f32>, t: f32) -> f32 {
  var h = sin(dot(p, vec2<f32>(0.140, 0.090)) + t * 0.90) * 0.50;
  h = h + sin(dot(p, vec2<f32>(-0.110, 0.190)) - t * 0.70) * 0.32;
  h = h + sin(dot(p, vec2<f32>(0.420, -0.310)) + t * 1.50) * 0.13;
  h = h + sin(dot(p, vec2<f32>(-0.730, -0.540)) - t * 2.10) * 0.07;
  h = h + sin(dot(p, vec2<f32>(1.310, 0.870)) + t * 2.90) * 0.035;
  h = h + sin(dot(p, vec2<f32>(-1.910, 1.470)) - t * 3.70) * 0.020;
  return h;
}

/** Animated caustic pattern — two counter-rotating Voronoi-ish interferences. */
fn caustics(p: vec2<f32>, t: f32) -> f32 {
  let a = sin(p.x * 1.9 + t * 0.9) * sin(p.y * 2.1 - t * 0.7);
  let b = sin((p.x + p.y) * 1.3 - t * 1.1) * sin((p.x - p.y) * 1.7 + t * 0.8);
  let v = a * b;
  return pow(clamp(v * 0.5 + 0.5, 0.0, 1.0), 5.0);
}

@fragment
fn fs_main(in: VSOut) -> SceneOut {
  let viewVec = in.worldPos - frame.cameraPos;
  let dist = length(viewVec);
  let dir = viewVec / max(dist, 0.001);
  let underwater = frame.cameraPos.y < SEA_LEVEL;

  // --- wave normal ---
  let p = in.worldPos.xz;
  let t = frame.time;
  let e = 0.6;
  var h0 = waveH(p, t);
  let hx = waveH(p + vec2<f32>(e, 0.0), t);
  let hz = waveH(p + vec2<f32>(0.0, e), t);
  if (frame.rainLevel > 0.0) {
    // Irrational frequency ratio + phase drift kills the checkerboard read.
    let rip = sin(p.x * 2.13 + p.y * 0.71 + t * 9.0)
            * sin(p.y * 1.53 - p.x * 0.47 - t * 6.3);
    h0 = h0 + rip * 0.06 * frame.rainLevel;
  }
  // Flatten waves with distance so the far sea does not sparkle into noise.
  let steep = 0.9 * exp(-dist * 0.004);
  var n = normalize(vec3<f32>((h0 - hx) / e * steep, 1.0, (h0 - hz) / e * steep));
  if (underwater) { n = -n; }

  // --- what is behind the water ---
  let screenUV = in.pos.xy * frame.screenSize.zw;
  let dim = vec2<f32>(textureDimensions(sceneDepth, 0));
  let bgDepth = textureLoad(sceneDepth, vec2<i32>(screenUV * dim), 0);
  let bgWorld = worldFromDepth(screenUV, bgDepth, frame.invViewProj);
  // Path length through water from the surface to whatever is behind it.
  var waterDepth = select(distance(bgWorld, in.worldPos), 60.0, bgDepth >= 0.99999);
  waterDepth = clamp(waterDepth, 0.0, 60.0);

  // Refraction: displace the lookup along the wave normal, scaled by depth so
  // shallow water (where the offset would sample above the shoreline and
  // smear the beach) barely bends at all.
  let refrAmt = clamp(waterDepth * 0.06, 0.0, 1.0) * 0.035
              * clamp(40.0 / max(dist, 1.0), 0.0, 1.0);
  let refrUV = clamp(screenUV + n.xz * refrAmt, vec2<f32>(0.001), vec2<f32>(0.999));
  // Re-test the displaced sample: if it landed on something *above* the water
  // the bend is invalid, so fall back to the straight-through sample.
  let refrDepth = textureLoad(sceneDepth, vec2<i32>(refrUV * dim), 0);
  let refrWorld = worldFromDepth(refrUV, refrDepth, frame.invViewProj);
  let validRefr = refrWorld.y < SEA_LEVEL + 0.15;
  let sampleUV = select(screenUV, refrUV, validRefr);
  var behind = textureSampleLevel(sceneCopy, sceneSampler, sampleUV, 0.0).rgb;

  // Caustics on the lit seabed, strongest in shallow water.
  let sunUp = smoothstep(-0.05, 0.15, frame.sunDir.y);
  let caust = caustics(bgWorld.xz * 1.1, t) * exp(-waterDepth * 0.22) * sunUp;
  behind = behind + frame.sunColor * caust * 0.55;

  // Beer-Lambert absorption: red extinguishes fastest, blue survives longest.
  let extinction = vec3<f32>(0.46, 0.115, 0.062);
  let transmit = exp(-extinction * waterDepth);
  // Scattered light in the body of the water, tinted by the sun.
  let scatterColor = vec3<f32>(0.045, 0.190, 0.215)
                   * (frame.ambient * 3.0 + frame.sunColor * 0.55 * sunUp);
  var color = behind * transmit + scatterColor * (1.0 - transmit);

  // --- reflection ---
  let R = reflect(dir, n);
  var reflected = skyProbe(R);
  // Grazing reflections pick up the horizon haze; steep ones see open sky.
  reflected = mix(reflected, frame.fogColor, smoothstep(0.35, 0.0, R.y) * 0.5);

  let cosV = clamp(dot(-dir, n), 0.0, 1.0);
  // Schlick with water's F0 = 0.02.
  var fres = 0.02 + 0.98 * pow(1.0 - cosV, 5.0);
  if (underwater) {
    // Seen from below, past the critical angle the surface mirrors entirely.
    fres = clamp(smoothstep(0.30, 0.10, cosV), 0.0, 1.0);
    reflected = mix(color, scatterColor * 2.0, 0.5);
  }
  color = mix(color, reflected, fres);

  // --- specular glitter ---
  let H = normalize(-dir + frame.sunDir);
  let ndh = max(dot(n, H), 0.0);
  let rough = mix(0.055, 0.18, clamp(frame.rainLevel + dist * 0.002, 0.0, 1.0));
  let D = distGGX(ndh, rough);
  color = color + frame.sunColor * D * 0.045 * sunUp * (1.0 - frame.rainLevel * 0.6);

  // --- foam ---
  // Shoreline: where the water is shallow against the geometry behind it.
  let shore = 1.0 - smoothstep(0.0, 1.35, waterDepth);
  // Break the band up so it is a surf line, not a contour.
  let surf = fbm2(p * 1.7 + vec2<f32>(t * 0.35, -t * 0.22), 3);
  let shoreFoam = smoothstep(0.30, 0.95, shore) * (0.45 + 0.85 * surf);
  // Crest foam on the tops of waves.
  let fnoise = sin(p.x * 1.71 + t * 1.1) * sin(p.y * 1.37 - t * 0.9);
  let crestFoam = smoothstep(0.55, 0.95, h0)
                * clamp(0.5 + 0.5 * fnoise, 0.0, 1.0)
                * exp(-dist * 0.010);
  let foam = clamp(shoreFoam + crestFoam * 0.55, 0.0, 1.0);
  let foamLit = vec3<f32>(0.90, 0.94, 0.96)
              * (frame.ambient * 3.0 + frame.sunColor * 0.85 * sunUp);
  color = mix(color, foamLit, foam * 0.85);

  // Sub-surface glow: backlit crests scatter green-blue toward the viewer.
  let back = pow(clamp(dot(dir, frame.sunDir), 0.0, 1.0), 4.0);
  color = color + vec3<f32>(0.10, 0.34, 0.30) * back * smoothstep(0.1, 0.8, h0)
        * frame.sunColor * 0.5 * sunUp;

  // --- opacity + fog ---
  // Deep water is opaque; shallow water lets the beach read through so the
  // shoreline is a soft gradient rather than a hard cut.
  var alpha = mix(0.30, 1.0, clamp(waterDepth * 0.75, 0.0, 1.0));
  alpha = max(alpha, fres * 0.95);
  alpha = max(alpha, foam * 0.9);

  color = applyFog(color, in.worldPos, dir);
  let fogAmt = 1.0 - exp(-frame.fogDensity * dist);
  alpha = mix(alpha, 1.0, fogAmt);

  var out: SceneOut;
  out.color = vec4<f32>(color, clamp(alpha, 0.0, 1.0));
  out.normal = packNormal(n, 0.5);
  return out;
}
