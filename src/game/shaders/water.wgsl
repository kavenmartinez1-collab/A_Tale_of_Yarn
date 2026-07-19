// Water — one large camera-following quad at sea level (y = 0, keep in sync
// with SEA_LEVEL in noise.ts). Drawn AFTER the sky with depth test on and
// depth writes OFF: terrain above water occludes it, underwater terrain and
// horizon sky show through the alpha blend. Bufferless (6 verts from
// vertex_index); no cull so it reads from below while swimming.

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

// Directional wave field — four sine trains at different scales/speeds.
// Cheap, tileless, and gives a coherent normal for fresnel + sun glint.
fn waveH(p: vec2<f32>, t: f32) -> f32 {
  var h = sin(dot(p, vec2<f32>(0.140, 0.090)) + t * 0.90) * 0.50;
  h += sin(dot(p, vec2<f32>(-0.110, 0.190)) - t * 0.70) * 0.32;
  h += sin(dot(p, vec2<f32>(0.420, -0.310)) + t * 1.50) * 0.13;
  h += sin(dot(p, vec2<f32>(-0.730, -0.540)) - t * 2.10) * 0.07;
  return h;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let deep    = vec3<f32>(0.05, 0.21, 0.34);
  let shallow = vec3<f32>(0.13, 0.40, 0.48);

  let viewVec = in.worldPos - frame.cameraPos;
  let dist = length(viewVec);
  let dir = viewVec / max(dist, 0.001);

  // Wave normal via finite differences; rain roughens the surface with an
  // extra high-frequency shimmer, and waves flatten with distance so the
  // far sea doesn't sparkle into noise.
  let p = in.worldPos.xz;
  let t = frame.time;
  let e = 0.6;
  var h0 = waveH(p, t);
  var hx = waveH(p + vec2<f32>(e, 0.0), t);
  var hz = waveH(p + vec2<f32>(0.0, e), t);
  if (frame.rainLevel > 0.0) {
    // Irrational frequency ratio + phase drift kills the checkerboard read.
    let rip = sin(p.x * 2.13 + p.y * 0.71 + t * 9.0)
            * sin(p.y * 1.53 - p.x * 0.47 - t * 6.3);
    h0 += rip * 0.06 * frame.rainLevel;
  }
  let steep = 0.9 * exp(-dist * 0.004); // wave slope, fading with distance
  let n = normalize(vec3<f32>((h0 - hx) / e * steep, 1.0, (h0 - hz) / e * steep));

  // Water body: deep in the troughs, brighter on the crests.
  var color = mix(deep, shallow, clamp(0.5 + 0.45 * h0, 0.0, 1.0));

  // Fresnel: grazing angles mirror the sky, looking down shows the body.
  let cosV = max(dot(-dir, n), 0.0);
  let fres = 0.03 + 0.97 * pow(1.0 - cosV, 5.0);
  let skyRefl = mix(frame.skyZenith, frame.fogColor, 0.55);
  color = mix(color, skyRefl, clamp(fres * 0.85, 0.0, 1.0));

  // Sun glint: real specular off the wave normal, dimmed by rain overcast.
  let sunUp = max(frame.sunDir.y, 0.0);
  let spec = pow(max(dot(reflect(dir, n), frame.sunDir), 0.0), 90.0);
  color += frame.sunColor * spec * sunUp * (1.0 - frame.rainLevel * 0.6) * 0.9;

  // Night: darken the water body toward the sky.
  color *= mix(0.25, 1.0, clamp(frame.sunColor.g + 0.3, 0.0, 1.0));

  // More opaque at glancing angles, clearer looking straight down.
  var alpha = mix(0.60, 0.92, fres);

  // Distance fog: far water fades to the horizon color and turns opaque so
  // the quad rim never shows against the sky.
  let fog = 1.0 - exp(-frame.fogDensity * dist);
  color = mix(color, frame.fogColor, fog);
  alpha = mix(alpha, 1.0, fog);

  return vec4<f32>(color, alpha);
}
