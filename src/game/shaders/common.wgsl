// ---------------------------------------------------------------------------
// common.wgsl — shared scene library, textually included by every scene shader
// via the `#include "common.wgsl"` directive resolved in shaders/include.ts.
//
// Owns: the Frame uniform (group 0), the procedural material texture arrays,
// cascaded shadow sampling, the stylized-PBR lighting model, triplanar
// material sampling, and atmospheric fog.
//
// Scene shaders output **linear HDR** to target 0 and a packed normal +
// ambient ratio to target 1. Tonemapping happens once, in post.wgsl.
// ---------------------------------------------------------------------------

#include "frame.wgsl"

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var shadowMap:     texture_depth_2d_array;
@group(0) @binding(2) var shadowSampler: sampler_comparison;
@group(0) @binding(3) var matAlbedo:     texture_2d_array<f32>;
@group(0) @binding(4) var matNormal:     texture_2d_array<f32>;
@group(0) @binding(5) var matSampler:    sampler;

/**
 * Nearby world point lights — campfires, forges, torches, lit windows.
 * Distinct from the dungeon pipeline's group-2 lights, which are interior-only
 * and rebuilt per resident room; this set follows the camera and is what lets
 * a campfire actually light the ground, the grass and whoever is standing
 * around it after dark.
 */
struct WorldLight {
  pos: vec4<f32>,          // xyz world position, w unused
  colorRadius: vec4<f32>,  // rgb colour x intensity, w radius (m)
}
struct WorldLights {
  count: vec4<f32>,        // x = active count
  lights: array<WorldLight, 16>,
}
@group(0) @binding(6) var<uniform> worldLights: WorldLights;

/**
 * The material table — one row per semantic surface, uploaded once from
 * render/material-table.ts. Meshes carry a material ID (per vertex on
 * characters and creatures, per draw on palette-batched props) and everything
 * about how that surface shades is looked up here rather than branched on in
 * shader code.
 */
struct MaterialDesc {
  // x = texture layer, y = texture scale, z = roughness mul, w = metallic
  a: vec4<f32>,
  // x = translucency, y = emissive, z = tint weight, w = detail contrast
  b: vec4<f32>,
}
struct MaterialTable {
  rows: array<MaterialDesc, 32>,
}
@group(0) @binding(7) var<uniform> materialTable: MaterialTable;

/**
 * Shade a surface from a material ID. This is the single path every scene
 * shader funnels through, so material behaviour cannot drift between them.
 *
 * `tint` is the per-vertex or per-palette colour; how much of it survives is
 * the material's own `tint` weight. `texPos` is the position the triplanar
 * projection samples at — world space for static geometry, body-local for
 * anything that moves, so the texture does not swim across it.
 */
fn shadeMaterialId(
  matId: i32, tint: vec3<f32>, worldPos: vec3<f32>, texPos: vec3<f32>,
  n: vec3<f32>, extraAo: f32,
) -> SceneOut {
  let row = materialTable.rows[clamp(matId, 0, 31)];
  let layer = i32(row.a.x);
  let surf = sampleMaterial(layer, texPos, n, row.a.y);

  // `tint` is ALWAYS a colour, never a multiplier — every caller must pass one
  // or the blend below reads as washed-out white. The material's tint weight
  // decides how much of the albedo that colour owns: 1 = the mesh colour is
  // the albedo and the texture only modulates its brightness (wool, cloth,
  // painted props); 0 = the baked texture colour wins outright (bone, horn).
  // `detail` (row.b.w) sets how far the texture's luminance swings the tint.
  // Wool needs a wide swing or the stitches wash out to flat colour; skin and
  // metal need a narrow one or they read as mottled.
  let lum = luminance(surf.albedo) / 0.34;
  let c = row.b.w;
  let painted = tint * clamp(1.0 - c * 0.5 + c * lum, 0.50, 1.45);
  let albedo = mix(surf.albedo, painted, row.b.z);

  var out: SceneOut;
  let emissive = row.b.y;
  if (emissive > 0.0) {
    out.color = vec4<f32>(albedo * emissive, 1.0);
    out.normal = packNormal(surf.normal, 0.0);
    return out;
  }

  let viewDist = distance(worldPos, frame.cameraPos);
  let shadow = sunShadow(worldPos, n, viewDist);
  let ao = surf.ao * extraAo;
  let lit = shadeSurface(albedo, surf.normal, worldPos,
                         clamp(surf.roughness * row.a.z, 0.03, 1.0),
                         row.a.w, ao, shadow, row.b.x);
  let torch = pointLights(worldPos, surf.normal, albedo,
                          surf.roughness * row.a.z);

  out.color = vec4<f32>(applyFog(lit.color + torch, worldPos,
                                 normalize(worldPos - frame.cameraPos)), 1.0);
  out.normal = packNormal(surf.normal, lit.ambientRatio);
  return out;
}

/**
 * Firelight flicker, keyed on the light's WORLD POSITION rather than its index
 * in the array. The array is re-sorted by distance every frame, so an
 * index-keyed flicker made a fire's brightness jump the moment another fire
 * overtook it in the sort. Three incommensurate rates: a slow breathe, a
 * mid-rate wander and a fast crackle, so it never settles into a visible beat.
 */
fn fireFlicker(pos: vec3<f32>, amount: f32) -> f32 {
  let p = pos.x * 0.7 + pos.y * 1.3 + pos.z * 0.9;
  let slow = sin(frame.time * 1.9 + p);
  let mid  = sin(frame.time * 5.3 + p * 1.7);
  let fast = sin(frame.time * 13.1 + p * 2.9);
  let f = slow * 0.45 + mid * 0.35 + fast * 0.20;
  return 1.0 - amount * (0.5 - 0.5 * f);
}

/**
 * Accumulate the nearby point lights at a surface. Inverse-square falloff
 * windowed to a finite radius so a light never contributes past its bound,
 * plus a flicker that keeps firelight alive.
 */
fn pointLights(
  worldPos: vec3<f32>, n: vec3<f32>, albedo: vec3<f32>, rough: f32,
) -> vec3<f32> {
  let count = u32(worldLights.count.x);
  if (count == 0u) { return vec3<f32>(0.0); }

  let V = normalize(frame.cameraPos - worldPos);
  var sum = vec3<f32>(0.0);
  for (var i = 0u; i < count; i = i + 1u) {
    let L = worldLights.lights[i];
    let toLight = L.pos.xyz - worldPos;
    let d2 = dot(toLight, toLight);
    let radius = max(L.colorRadius.w, 0.001);
    if (d2 >= radius * radius) { continue; }
    let d = sqrt(d2);
    let dir = toLight / max(d, 1e-4);
    let window = pow(clamp(1.0 - pow(d / radius, 4.0), 0.0, 1.0), 2.0);
    let atten = window / (1.0 + d2 * 0.28);
    // Wrapped diffuse: firelight is a volume, not a point, so the terminator
    // around a campfire should be soft.
    let ndl = clamp((dot(n, dir) + 0.25) / 1.25, 0.0, 1.0);
    let flicker = fireFlicker(L.pos.xyz, 0.30);
    let H = normalize(dir + V);
    let spec = distGGX(max(dot(n, H), 0.0), max(rough, 0.16)) * 0.04;
    sum = sum + L.colorRadius.rgb * ((albedo * ndl + vec3<f32>(spec))
        * atten * flicker);
  }
  return sum;
}

// Material layer indices — keep in sync with MATERIALS in render/materials.ts.
const MAT_GRASS:  i32 = 0;
const MAT_DIRT:   i32 = 1;
const MAT_ROCK:   i32 = 2;
const MAT_SAND:   i32 = 3;
const MAT_SNOW:   i32 = 4;
const MAT_BARK:   i32 = 5;
const MAT_LEAF:   i32 = 6;
const MAT_PLANK:  i32 = 7;
const MAT_BRICK:  i32 = 8;
const MAT_THATCH: i32 = 9;
const MAT_CLOTH:  i32 = 10;
const MAT_HIDE:   i32 = 11;
const MAT_SKIN:   i32 = 12;
const MAT_FUR:    i32 = 13;
const MAT_METAL:  i32 = 14;
const MAT_GEM:    i32 = 15;
const MAT_KNIT:   i32 = 16;
const MAT_FELT:   i32 = 17;
const MAT_BONE:   i32 = 18;
const MAT_HORN:   i32 = 19;
const MAT_QUILT:  i32 = 20;

// Material *table* row indices — distinct from the MAT_* texture layers above.
// Keep in sync with the `MAT` enum in render/material-table.ts.
const MAT_ID_KNIT:    i32 = 1;
const MAT_ID_FELT:    i32 = 2;
const MAT_ID_LEATHER: i32 = 6;
const MAT_ID_BONE:    i32 = 7;
const MAT_ID_HORN:    i32 = 8;
const MAT_ID_IRON:    i32 = 10;
const MAT_ID_GOLD:    i32 = 11;
const MAT_ID_CLOTH:   i32 = 12;
const MAT_ID_WOOD:    i32 = 13;
const MAT_ID_BARK:    i32 = 14;
const MAT_ID_LEAF:    i32 = 15;
const MAT_ID_STONE:   i32 = 16;
const MAT_ID_MASONRY: i32 = 17;
const MAT_ID_THATCH:  i32 = 18;
const MAT_ID_GRASS:   i32 = 21;
const MAT_ID_EMBER:   i32 = 24;
const MAT_ID_PORTAL:  i32 = 25;
const MAT_ID_GLASS_HOT: i32 = 27;
const MAT_ID_CRAFTSTONE: i32 = 29;
const MAT_ID_CRAFTSLATE: i32 = 30;

// --- small noise toolkit ----------------------------------------------------

fn hash2(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn hash3(p: vec3<f32>) -> f32 {
  return fract(sin(dot(p, vec3<f32>(127.1, 311.7, 74.7))) * 43758.5453);
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

fn fbm2(p: vec2<f32>, octaves: i32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var q = p;
  for (var i = 0; i < octaves; i = i + 1) {
    sum = sum + vnoise(q) * amp;
    q = q * 2.03;
    amp = amp * 0.5;
  }
  return sum;
}

// --- cascaded shadow maps ---------------------------------------------------

fn cascadeIndex(viewDist: f32) -> i32 {
  if (viewDist < frame.cascadeSplits.x) { return 0; }
  if (viewDist < frame.cascadeSplits.y) { return 1; }
  return 2;
}

fn cascadeMatrix(idx: i32) -> mat4x4<f32> {
  if (idx == 0) { return frame.sunViewProj0; }
  if (idx == 1) { return frame.sunViewProj1; }
  return frame.sunViewProj2;
}

// 3x3 PCF in one cascade. Returns 1 = lit, 0 = fully shadowed.
fn sampleCascade(idx: i32, worldPos: vec3<f32>, texel: f32) -> f32 {
  let lp = cascadeMatrix(idx) * vec4<f32>(worldPos, 1.0);
  let ndc = lp.xyz / lp.w;
  if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0 || ndc.z > 1.0 || ndc.z < 0.0) {
    return 1.0;
  }
  let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  // Wider kernel on distant cascades keeps the penumbra roughly constant
  // in screen space instead of hardening with distance.
  let spread = texel * (1.0 + f32(idx) * 0.6);
  var sum = 0.0;
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      let o = vec2<f32>(f32(x), f32(y)) * spread;
      sum = sum + textureSampleCompareLevel(
        shadowMap, shadowSampler, uv + o, idx, ndc.z);
    }
  }
  return sum / 9.0;
}

/**
 * Sun visibility at a world position. `n` is the shading normal — it drives
 * the normal-offset bias, which pushes the lookup off the surface along the
 * normal and is far more robust against acne than depth bias alone.
 */
fn sunShadow(worldPos: vec3<f32>, n: vec3<f32>, viewDist: f32) -> f32 {
  let idx = cascadeIndex(viewDist);
  // World size of one shadow texel in THIS cascade, supplied by the CPU.
  // Deriving it from cascade 0 with a guessed multiplier leaves the far
  // cascades under-biased and they shadow themselves.
  var worldTexel = frame.cascadeTexel.x;
  if (idx == 1) { worldTexel = frame.cascadeTexel.y; }
  else if (idx == 2) { worldTexel = frame.cascadeTexel.z; }
  let ndl = clamp(dot(n, frame.sunDir), 0.0, 1.0);
  // Slope-scaled offset: grazing light needs a bigger push.
  let offset = worldTexel * (1.2 + 2.2 * (1.0 - ndl));
  let p = worldPos + n * offset;
  let texel = 1.0 / 2048.0;

  var s = sampleCascade(idx, p, texel);

  // Blend across the split so the resolution change is not a visible line.
  var splitFar = frame.cascadeSplits.x;
  if (idx == 1) { splitFar = frame.cascadeSplits.y; }
  if (idx == 2) { splitFar = frame.cascadeSplits.z; }
  let fadeStart = splitFar * 0.85;
  if (idx < 2 && viewDist > fadeStart) {
    let t = clamp((viewDist - fadeStart) / max(splitFar - fadeStart, 0.001), 0.0, 1.0);
    let s2 = sampleCascade(idx + 1, p, texel);
    s = mix(s, s2, t);
  }
  // Fade shadows out at the far plane rather than popping.
  let far = frame.cascadeSplits.z;
  s = mix(s, 1.0, smoothstep(far * 0.8, far, viewDist));
  return mix(1.0, s, frame.cascadeSplits.w);
}

// --- triplanar material sampling -------------------------------------------

struct Surface {
  albedo:    vec3<f32>,
  normal:    vec3<f32>,
  roughness: f32,
  ao:        f32,
}

fn triplanarWeights(n: vec3<f32>) -> vec3<f32> {
  var w = abs(n);
  w = max(w - 0.28, vec3<f32>(0.0));
  w = w * w;
  return w / max(w.x + w.y + w.z, 0.0001);
}

/**
 * Triplanar-sample one material layer at world position `p` with geometric
 * normal `n`. `scale` is texture repeats per world metre. Returns albedo,
 * a world-space perturbed normal, roughness and baked cavity AO.
 *
 * Normals are blended with the "whiteout" method: the tangent-space normal of
 * each plane is added to the geometric normal's swizzle, which needs no
 * tangent vectors and stays stable on curved surfaces.
 */
fn sampleMaterial(layer: i32, p: vec3<f32>, n: vec3<f32>, scale: f32) -> Surface {
  let w = triplanarWeights(n);
  let uvX = p.zy * scale;
  let uvY = p.xz * scale;
  let uvZ = p.xy * scale;

  let aX = textureSample(matAlbedo, matSampler, uvX, layer);
  let aY = textureSample(matAlbedo, matSampler, uvY, layer);
  let aZ = textureSample(matAlbedo, matSampler, uvZ, layer);
  let nX = textureSample(matNormal, matSampler, uvX, layer);
  let nY = textureSample(matNormal, matSampler, uvY, layer);
  let nZ = textureSample(matNormal, matSampler, uvZ, layer);

  var out: Surface;
  let a = aX * w.x + aY * w.y + aZ * w.z;
  out.albedo = a.rgb;
  out.roughness = a.a;
  out.ao = nX.b * w.x + nY.b * w.y + nZ.b * w.z;

  // Whiteout normal blend.
  let tX = nX.rg * 2.0 - 1.0;
  let tY = nY.rg * 2.0 - 1.0;
  let tZ = nZ.rg * 2.0 - 1.0;
  let sgn = sign(n + vec3<f32>(1e-6));
  let bX = vec3<f32>(0.0, tX.y, tX.x * sgn.x);
  let bY = vec3<f32>(tY.x, 0.0, tY.y * sgn.y);
  let bZ = vec3<f32>(tZ.x * sgn.z, tZ.y, 0.0);
  out.normal = normalize(n + bX * w.x + bY * w.y + bZ * w.z);
  return out;
}

/** Cheap albedo-only triplanar fetch for cases that do not need a normal. */
fn sampleAlbedo(layer: i32, p: vec3<f32>, n: vec3<f32>, scale: f32) -> vec4<f32> {
  let w = triplanarWeights(n);
  return textureSample(matAlbedo, matSampler, p.zy * scale, layer) * w.x
       + textureSample(matAlbedo, matSampler, p.xz * scale, layer) * w.y
       + textureSample(matAlbedo, matSampler, p.xy * scale, layer) * w.z;
}

/**
 * Blend two material layers in one triplanar evaluation — terrain needs this
 * constantly (grass into rock, sand into grass) and computing the projection
 * weights once instead of twice halves the ALU cost of the blend.
 */
fn sampleMaterial2(
  layerA: i32, layerB: i32, t: f32,
  p: vec3<f32>, n: vec3<f32>, scale: f32,
) -> Surface {
  let w = triplanarWeights(n);
  let uvX = p.zy * scale;
  let uvY = p.xz * scale;
  let uvZ = p.xy * scale;

  let aX = mix(textureSample(matAlbedo, matSampler, uvX, layerA),
               textureSample(matAlbedo, matSampler, uvX, layerB), t);
  let aY = mix(textureSample(matAlbedo, matSampler, uvY, layerA),
               textureSample(matAlbedo, matSampler, uvY, layerB), t);
  let aZ = mix(textureSample(matAlbedo, matSampler, uvZ, layerA),
               textureSample(matAlbedo, matSampler, uvZ, layerB), t);
  let nX = mix(textureSample(matNormal, matSampler, uvX, layerA),
               textureSample(matNormal, matSampler, uvX, layerB), t);
  let nY = mix(textureSample(matNormal, matSampler, uvY, layerA),
               textureSample(matNormal, matSampler, uvY, layerB), t);
  let nZ = mix(textureSample(matNormal, matSampler, uvZ, layerA),
               textureSample(matNormal, matSampler, uvZ, layerB), t);

  var out: Surface;
  let a = aX * w.x + aY * w.y + aZ * w.z;
  out.albedo = a.rgb;
  out.roughness = a.a;
  out.ao = nX.b * w.x + nY.b * w.y + nZ.b * w.z;

  let tX = nX.rg * 2.0 - 1.0;
  let tY = nY.rg * 2.0 - 1.0;
  let tZ = nZ.rg * 2.0 - 1.0;
  let sgn = sign(n + vec3<f32>(1e-6));
  let bX = vec3<f32>(0.0, tX.y, tX.x * sgn.x);
  let bY = vec3<f32>(tY.x, 0.0, tY.y * sgn.y);
  let bZ = vec3<f32>(tZ.x * sgn.z, tZ.y, 0.0);
  out.normal = normalize(n + bX * w.x + bY * w.y + bZ * w.z);
  return out;
}

// --- lighting ---------------------------------------------------------------

/** Trowbridge-Reitz (GGX) normal distribution. */
fn distGGX(ndh: f32, rough: f32) -> f32 {
  let a = rough * rough;
  let a2 = a * a;
  let d = ndh * ndh * (a2 - 1.0) + 1.0;
  return a2 / max(3.14159265 * d * d, 1e-5);
}

fn fresnelSchlick(cosT: f32, f0: vec3<f32>) -> vec3<f32> {
  return f0 + (vec3<f32>(1.0) - f0) * pow(clamp(1.0 - cosT, 0.0, 1.0), 5.0);
}

/**
 * Sky ambient: a hemisphere probe built from the current sky colours. Cool
 * zenith light from above, warm bounced ground light from below, with the
 * horizon band in between — this is what stops surfaces reading as flat
 * plastic under a single directional light.
 */
fn skyAmbient(n: vec3<f32>) -> vec3<f32> {
  let up = n.y * 0.5 + 0.5;
  let ground = frame.fogColor * vec3<f32>(0.55, 0.50, 0.44);
  let horizon = mix(ground, frame.skyHorizon, 0.6);
  let lower = mix(ground, horizon, smoothstep(0.0, 0.5, up));
  let upper = mix(horizon, frame.skyZenith, smoothstep(0.5, 1.0, up));
  return select(lower, upper, up > 0.5) * frame.ambient * 3.4;
}

struct LitResult {
  color:      vec3<f32>,
  ambientRatio: f32,
}

/**
 * The scene's one lighting model. Stylized PBR: energy-ish diffuse with a
 * touch of wrap for softness, GGX sun specular, hemisphere sky ambient with a
 * fresnel-weighted specular probe, a cool moon fill at night, and an optional
 * translucency term for foliage.
 *
 * `translucency` > 0 adds back-lighting (leaves and cloth glowing when the sun
 * is behind them). `shadow` is the sun visibility from sunShadow().
 */
fn shadeSurface(
  albedo: vec3<f32>, n: vec3<f32>, worldPos: vec3<f32>,
  roughness: f32, metallic: f32, ao: f32, shadow: f32, translucency: f32,
) -> LitResult {
  let V = normalize(frame.cameraPos - worldPos);
  let L = frame.sunDir;
  let H = normalize(V + L);
  let ndl = dot(n, L);
  let ndv = max(dot(n, V), 1e-4);
  let ndh = max(dot(n, H), 0.0);
  let vdh = max(dot(V, H), 0.0);

  let f0 = mix(vec3<f32>(0.04), albedo, metallic);
  let diffuseAlbedo = albedo * (1.0 - metallic);

  // Wrapped diffuse — a narrow terminator wrap keeps the low-poly forms from
  // going abruptly black without washing the whole shading out.
  let wrap = 0.18;
  let diff = max((ndl + wrap) / (1.0 + wrap), 0.0);
  // Sun above the horizon only; fade the last few degrees smoothly.
  let sunUp = smoothstep(-0.10, 0.06, frame.sunDir.y);
  let sunLight = frame.sunColor * sunUp * shadow;

  var direct = diffuseAlbedo * diff * sunLight;

  // Sun specular.
  let D = distGGX(ndh, max(roughness, 0.045));
  let k = roughness * roughness * 0.5;
  let gv = ndv / (ndv * (1.0 - k) + k);
  let gl = max(ndl, 0.0) / (max(ndl, 0.0) * (1.0 - k) + k);
  let F = fresnelSchlick(vdh, f0);
  let spec = D * gv * gl * F / (4.0 * ndv * max(ndl, 1e-4) + 1e-4);
  direct = direct + spec * sunLight * max(ndl, 0.0);

  // Foliage / thin-material translucency: light bleeding through from behind.
  if (translucency > 0.0) {
    let back = pow(clamp(dot(V, -L), 0.0, 1.0), 3.0);
    direct = direct + albedo * back * translucency * sunLight * 0.65;
    // Plus a little uniform wrap-around so shaded leaves are never dead.
    direct = direct + albedo * translucency * 0.12 * sunLight * max(-ndl, 0.0);
  }

  // Ambient: hemisphere diffuse + a horizon-weighted specular probe.
  let amb = skyAmbient(n) * ao;
  var ambient = diffuseAlbedo * amb;
  let fAmb = fresnelSchlick(ndv, f0) * (1.0 - roughness * 0.85);
  ambient = ambient + fAmb * mix(frame.skyHorizon, frame.skyZenith, 0.5)
          * frame.ambient * 2.2 * ao;

  // Night moon fill — cool, soft, and gated on starVis so it never shows by day.
  let moonNdl = max(dot(n, frame.moonDir), 0.0);
  let moon = albedo * moonNdl * frame.starVis
           * vec3<f32>(0.055, 0.070, 0.115) * frame.moonPhase * mix(0.4, 1.0, shadow);

  var out: LitResult;
  out.color = direct + ambient + moon;
  let dl = dot(direct, vec3<f32>(0.2126, 0.7152, 0.0722));
  let al = dot(ambient, vec3<f32>(0.2126, 0.7152, 0.0722));
  out.ambientRatio = al / max(dl + al, 1e-4);
  return out;
}

/**
 * Cheap analytic sky probe — the same gradient sky.wgsl paints, minus the
 * stars, discs and clouds. Used for water reflections and specular ambient,
 * where a full sky evaluation would be wasted on a blurred result.
 */
fn skyProbe(dir: vec3<f32>) -> vec3<f32> {
  let up = clamp(dir.y, -1.0, 1.0);
  let t = pow(clamp(up * 0.5 + 0.5, 0.0, 1.0), 0.42);
  let horizonBand = pow(1.0 - abs(up), 5.0);
  var sky = mix(frame.skyHorizon, frame.skyZenith, smoothstep(0.30, 0.95, t));
  sky = mix(sky, frame.fogColor * 1.16, horizonBand * 0.65);

  let cosSun = dot(dir, frame.sunDir);
  let sunUp = smoothstep(-0.12, 0.10, frame.sunDir.y);
  let glow = pow(max(cosSun, 0.0), 8.0);
  sky = sky + frame.sunColor * glow * (0.40 + horizonBand * 1.2) * sunUp;
  // Overcast flattens the whole dome toward the fog colour.
  sky = mix(sky, frame.fogColor, frame.cloudCover * 0.45);
  return max(sky, vec3<f32>(0.0));
}

// --- atmosphere -------------------------------------------------------------

/**
 * Aerial perspective. Exponential extinction toward the horizon colour, with
 * a height falloff so valleys pool haze and peaks stay clear, plus forward
 * Mie inscattering that flares the fog toward the sun — the single cue that
 * most reads as "outdoor daylight" rather than "grey soup".
 */
fn applyFog(color: vec3<f32>, worldPos: vec3<f32>, viewDir: vec3<f32>) -> vec3<f32> {
  let dist = distance(worldPos, frame.cameraPos);
  // Height-attenuated optical depth: haze pools in valleys and thins with
  // altitude. Both endpoints must use the SAME reference height — clamping
  // one and not the other invents a huge fake altitude difference.
  let hFalloff = 0.022;
  let camH = frame.cameraPos.y;
  let dy = worldPos.y - camH;
  var heightFactor: f32;
  if (abs(dy) < 0.1) {
    heightFactor = exp(-hFalloff * camH);
  } else {
    heightFactor = exp(-hFalloff * camH)
                 * (1.0 - exp(-hFalloff * dy)) / (hFalloff * dy);
  }
  // Interiors live in a slot arena at y = -300, where an exponential altitude
  // model evaluates to ~700x and buries everything in fog at point-blank
  // range. The factor is a stylistic modulation, not physics — clamp it to a
  // band around 1 so no altitude can produce a nonsense result.
  heightFactor = clamp(heightFactor, 0.25, 1.8);
  var f = 1.0 - exp(-frame.fogDensity * heightFactor * dist);
  f = clamp(f, 0.0, 1.0);

  // Mie forward scattering toward the sun. The phase function spikes hard as
  // cosT approaches 1, so it is clamped — unclamped it turns the haze around
  // the sun into a solid white wall.
  let cosT = clamp(dot(viewDir, frame.sunDir), 0.0, 1.0);
  let g = 0.70;
  let mie = min((1.0 - g * g) / (4.0 * 3.14159265
          * pow(1.0 + g * g - 2.0 * g * cosT, 1.5)), 1.4);
  let sunUp = smoothstep(-0.08, 0.10, frame.sunDir.y);
  let scatter = frame.sunColor * mie * 0.55 * sunUp;
  let fog = frame.fogColor + scatter;

  return mix(color, fog, f);
}

// --- G-buffer packing -------------------------------------------------------

struct SceneOut {
  @location(0) color:  vec4<f32>,
  @location(1) normal: vec4<f32>,
}

/** Pack the shading normal + ambient ratio for the SSAO / composite passes. */
fn packNormal(n: vec3<f32>, ambientRatio: f32) -> vec4<f32> {
  return vec4<f32>(n * 0.5 + 0.5, clamp(ambientRatio, 0.0, 1.0));
}

/**
 * Full surface shade: material lookup, shadow, lighting, fog, and the packed
 * G-buffer normal — the path every opaque scene shader funnels through so
 * they cannot drift apart.
 */
fn shadeStandard(
  layer: i32, tint: vec3<f32>, worldPos: vec3<f32>, n: vec3<f32>,
  texScale: f32, metallic: f32, translucency: f32, extraAo: f32,
) -> SceneOut {
  let viewDist = distance(worldPos, frame.cameraPos);
  let surf = sampleMaterial(layer, worldPos, n, texScale);
  let albedo = surf.albedo * tint;
  let shadow = sunShadow(worldPos, n, viewDist);
  let lit = shadeSurface(albedo, surf.normal, worldPos, surf.roughness,
                         metallic, surf.ao * extraAo, shadow, translucency);
  let torch = pointLights(worldPos, surf.normal, albedo, surf.roughness);
  let viewDir = normalize(worldPos - frame.cameraPos);
  var out: SceneOut;
  out.color = vec4<f32>(applyFog(lit.color + torch, worldPos, viewDir), 1.0);
  out.normal = packNormal(surf.normal, lit.ambientRatio);
  return out;
}
