// Terrain — triplanar-textured ground with biome tinting and cascaded shadows.
//
// Vertices carry a smooth height-field normal (chunk-mesh.ts computes it from
// the analytic gradient, seam-identical across chunk borders) plus the biome
// ground tint. Height and slope choose which two material layers blend, and
// the biome tint recolours the grass layer without flattening its pattern.
//
// Outputs linear HDR + the packed normal G-buffer; grading happens in post.

#include "common.wgsl"

@group(1) @binding(0) var<uniform> object: ObjectData;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) vtxTint: vec3<f32>,
  @location(3) road: f32,
}

/** Mean albedo of the baked grass layer — the reference the biome tint
 *  divides through, so tinting recolours rather than darkens. */
const GRASS_REF = vec3<f32>(0.215, 0.315, 0.125);

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) tint: vec3<f32>,
  @location(3) road: f32,
) -> VSOut {
  let world = position + object.offset.xyz;
  var out: VSOut;
  out.pos = frame.viewProj * vec4<f32>(world, 1.0);
  out.worldPos = world;
  out.normal = normal;
  out.vtxTint = tint;
  out.road = road;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> SceneOut {
  let n = normalize(in.normal);
  let h = in.worldPos.y;
  let slope = clamp(n.y, 0.0, 1.0);   // 1 = flat, 0 = vertical
  let viewDist = distance(in.worldPos, frame.cameraPos);

  // Which layer competes with grass here, and how strongly.
  let wSand = 1.0 - smoothstep(0.4, 3.6, h);
  let wSnow = smoothstep(74.0, 96.0, h);
  let wRock = 1.0 - smoothstep(0.52, 0.80, slope);

  var second = MAT_ROCK;
  var t = wRock;
  if (wSnow > t) { second = MAT_SNOW; t = wSnow; }
  if (wSand > t) { second = MAT_SAND; t = wSand; }

  // A stone road overrides the height/slope bands outright. MAT_BRICK is the
  // masonry layer the castles are built from — running-bond stone blocks in
  // mortar — so a road reads as *laid* flagstone rather than bare rock, and
  // ties visually to the castle it leads to. It wins the layer identity at any
  // strength; the weight is the stronger of the two claims, so a road crossing
  // a cliff face still gets a stone surface.
  let road = clamp(in.road, 0.0, 1.0);
  if (road > 0.002) {
    second = MAT_BRICK;
    t = max(t, road);
  }

  // Break the transition line with noise so bands never read as contours. The
  // road edge goes through the same jitter, which is what stops a 1 m vertex
  // grid from reading as a ruled line and gives the verge its worn, ragged
  // look — the edge a footpath actually has.
  let jitter = (fbm2(in.worldPos.xz * 0.09, 3) - 0.5) * 0.30;
  t = clamp(t + jitter * smoothstep(0.02, 0.5, t) * (1.0 - smoothstep(0.7, 1.0, t)),
            0.0, 1.0);

  // Two FIXED tiling rates — a ~4 m tile and a ~9 m tile.
  //
  // The rate must never depend on view distance. sampleMaterial2 builds its
  // UVs as worldPos.xz * scale, so a distance-varying scale re-maps every
  // point on the ground the instant the camera moves: walk forward and the
  // entire landscape slides and ripples underfoot like water. This used to be
  // mix(0.26, 0.10, smoothstep(25, 140, viewDist)) — a 2.6x re-map between
  // near and far — which is exactly what that artefact was.
  //
  // What *can* safely vary with distance is the blend between two world-locked
  // samples: the features stay pinned to the ground and only their mix ratio
  // changes, which the eye reads as detail fading rather than as motion.
  let scaleFine = 0.26;
  let scaleCoarse = 0.107;

  // De-tiling: two incommensurate scales, cross-faded by a low-frequency mask.
  // One tiled sample alone reads as a visible grid on long hillsides — grass
  // has a direction, and the eye finds the repeat immediately.
  let surfA = sampleMaterial2(MAT_GRASS, second, t, in.worldPos, n, scaleFine);
  let surfB = sampleMaterial2(MAT_GRASS, second, t,
    in.worldPos + vec3<f32>(31.7, 0.0, 17.3), n, scaleCoarse);
  // Up close the coarse sample is a half-weight partner that hides the repeat.
  // Far out it takes over, because there the fine tile is what would alias.
  let mask = smoothstep(0.35, 0.65, fbm2(in.worldPos.xz * 0.035, 3));
  let blend = mix(mask * 0.5, 0.82, smoothstep(25.0, 140.0, viewDist));
  var surf: Surface;
  surf.albedo = mix(surfA.albedo, surfB.albedo, blend);
  surf.normal = normalize(mix(surfA.normal, surfB.normal, blend));
  surf.roughness = mix(surfA.roughness, surfB.roughness, blend);
  surf.ao = mix(surfA.ao, surfB.ao, blend);

  // Biome tint recolours the grass share only.
  let tintMul = clamp(in.vtxTint / GRASS_REF, vec3<f32>(0.35), vec3<f32>(2.2));
  let grassShare = (1.0 - t);
  var albedo = surf.albedo * mix(vec3<f32>(1.0), tintMul, grassShare);

  // Large-scale patchiness so a hillside is not one flat hue.
  // ("patch" is a WGSL reserved keyword — hence the name.)
  let macroVariation = fbm2(in.worldPos.xz * 0.013, 3);
  albedo = albedo * (0.86 + 0.30 * macroVariation);

  // Worn paving: cooler and a shade darker than fresh masonry, with the
  // centreline scuffed paler where feet and cartwheels have polished it.
  let wear = 0.90 + 0.16 * fbm2(in.worldPos.xz * 0.21, 2);
  albedo = mix(albedo, albedo * vec3<f32>(0.88, 0.87, 0.84) * wear, road * 0.85);

  // Wet darkening around and below sea level.
  albedo = albedo * mix(0.46, 1.0, smoothstep(-1.6, 0.6, h));
  // Fixed-colour objects (preview props) skip the terrain bands entirely.
  albedo = mix(albedo, object.color.rgb, step(0.5, object.offset.w));

  // Damp ground near the waterline is smoother and reflects more.
  let wet = 1.0 - smoothstep(-0.5, 1.6, h);
  let roughness = mix(surf.roughness, 0.24, wet * 0.8);

  let shadow = sunShadow(in.worldPos, n, viewDist);
  let lit = shadeSurface(albedo, surf.normal, in.worldPos,
                         roughness, 0.0, surf.ao, shadow, 0.0);
  let torch = pointLights(in.worldPos, surf.normal, albedo, roughness);

  let viewDir = normalize(in.worldPos - frame.cameraPos);
  var out: SceneOut;
  out.color = vec4<f32>(applyFog(lit.color + torch, in.worldPos, viewDir), 1.0);
  out.normal = packNormal(surf.normal, lit.ambientRatio);
  return out;
}
