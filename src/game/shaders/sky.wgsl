// Sky — fullscreen triangle drawn LAST at far depth (z = 1, depthCompare
// less-equal, depth writes off) so it only fills pixels terrain didn't touch.
// The fragment reconstructs the per-pixel world-space view ray by
// unprojecting far-plane NDC through invViewProj.

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

// --- 2D value-noise FBM for clouds ------------------------------------------

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

// Gentle filmic-ish grade — keep identical to the scene shaders so the
// horizon fog line still matches terrain exactly.
fn grade(c: vec3<f32>) -> vec3<f32> {
  let x = max(c, vec3<f32>(0.0));
  let toned = x * (vec3<f32>(1.25) + x * 0.45)
            / (vec3<f32>(1.0) + x * (vec3<f32>(0.90) + x * 0.45));
  let l = dot(toned, vec3<f32>(0.2126, 0.7152, 0.0722));
  return mix(vec3<f32>(l), toned, 1.10);
}

fn fbm(p: vec2<f32>) -> f32 {
  var v = 0.0;
  var amp = 0.5;
  var q = p;
  for (var i = 0; i < 6; i = i + 1) {
    v += amp * vnoise(q);
    q = q * 2.03 + vec2<f32>(17.3, 9.1);
    amp *= 0.5;
  }
  return v;
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  // Oversized triangle covering the screen: (-1,-1) (3,-1) (-1,3)
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  var out: VSOut;
  out.pos = vec4<f32>(x, y, 1.0, 1.0); // far plane
  out.ndc = vec2<f32>(x, y);
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let far = frame.invViewProj * vec4<f32>(in.ndc, 1.0, 1.0);
  let dir = normalize(far.xyz / far.w - frame.cameraPos);

  // Horizon = fog color (matches terrain fog), zenith from the environment.
  let t = pow(clamp(dir.y, 0.0, 1.0), 0.55);
  var color = mix(frame.fogColor, frame.skyZenith, t);

  // Sun disc + warm glow, tinted/dimmed by the day-night cycle.
  let sd = dot(dir, frame.sunDir);
  color += frame.sunColor * smoothstep(0.9993, 0.9998, sd) * 2.0;
  color += frame.sunColor * pow(max(sd, 0.0), 180.0) * 0.35;

  // Stars: hashed cell points on the sky dome, faded in by starVis.
  // Two size classes: a dense field of faint stars + sparse bright ones.
  if (frame.starVis > 0.0 && dir.y > 0.0) {
    let cell = floor(dir * 220.0);
    let h = fract(sin(dot(cell, vec3<f32>(12.9898, 78.233, 37.719))) * 43758.5453);
    let horizonFade = frame.starVis * smoothstep(0.0, 0.15, dir.y);
    let bright = step(0.9982, h);
    let faint  = step(0.9930, h) * (1.0 - bright) * 0.35;
    let twinkle = 0.7 + 0.3 * sin(frame.time * 2.0 + h * 40.0);
    color += vec3<f32>(0.9, 0.93, 1.0) * (bright + faint) * horizonFade * twinkle;

    // Moon: pale disc opposite the sun (same mirrored direction the scene
    // shaders use for the night fill light), with a soft cool glow.
    let moonDir = normalize(vec3<f32>(-frame.sunDir.x, abs(frame.sunDir.y), -frame.sunDir.z));
    let md = dot(dir, moonDir);
    color += vec3<f32>(0.82, 0.86, 0.95) * smoothstep(0.99955, 0.99985, md) * frame.starVis;
    color += vec3<f32>(0.30, 0.35, 0.50) * pow(max(md, 0.0), 350.0) * 0.35 * frame.starVis;
  }

  // Clouds: FBM sampled on a virtual dome plane, drifting with time and
  // slightly with camera XZ (parallax). Drawn after stars so cover hides them.
  // Cloud color follows the cycle: white day, orange dusk, near-black night.
  if (frame.cloudCover > 0.0 && dir.y > 0.02) {
    let uv = dir.xz / (dir.y + 0.15) * 1.6
           + frame.cameraPos.xz * 0.002
           + vec2<f32>(frame.time * 0.008, frame.time * 0.003);
    let thr = 1.0 - frame.cloudCover;
    let cov = smoothstep(thr, thr + 0.25, fbm(uv))
            * smoothstep(0.02, 0.18, dir.y); // fade into the horizon fog
    let cloudCol = frame.sunColor * 0.85
                 + vec3<f32>(0.10, 0.10, 0.12) * (frame.ambient * 2.0);
    color = mix(color, cloudCol, cov * 0.85);
  }

  return vec4<f32>(grade(color), 1.0);
}
