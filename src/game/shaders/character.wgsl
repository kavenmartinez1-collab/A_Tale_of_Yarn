// Characters and animals — interleaved pos3 + normal3 + colour3, posed on the
// CPU each frame; the object uniform supplies the world offset and picks which
// material layer supplies surface detail (knit wool for humanoids, fur for
// animals) via object.color.w.
//
// The people are deliberately knitted dolls, so this shader is built around
// wool rather than skin: chunky stockinette stitches from the knit material,
// a fully matte response with no specular highlight, light bleeding through
// the yarn at the edges, and a broad fibre halo where loose strands catch the
// sky. Vertex colours stay the albedo authority — customisation lives there —
// and the material supplies only stitch normals, roughness and cavity AO.

#include "common.wgsl"

@group(1) @binding(0) var<uniform> object: ObjectData;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
  // Flat: the material ID is an integer index, and interpolating it across a
  // triangle whose corners disagree would sample a material that is neither.
  @location(3) @interpolate(flat) material: f32,
  @location(4) localPos: vec3<f32>,
}

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
  @location(3) material: f32,
) -> VSOut {
  let world = position + object.offset.xyz;
  var out: VSOut;
  out.pos = frame.viewProj * vec4<f32>(world, 1.0);
  out.worldPos = world;
  out.normal = normal;
  out.color = color;
  out.material = material;
  // Body-local position drives the triplanar projection, so stitches stay
  // pinned to the body instead of swimming across it as the creature walks.
  out.localPos = position;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> SceneOut {
  let n = normalize(in.normal);
  let matId = i32(in.material + 0.5);

  // Everything about how this surface shades — texture layer, scale,
  // roughness, metalness, translucency — comes from the material table row,
  // not from branches here. Adding a goblin's jerkin or a skeleton's ribs is
  // a table entry, not a shader edit.
  var out = shadeMaterialId(matId, in.color, in.worldPos, in.localPos, n, 1.0);

  let row = materialTable.rows[clamp(matId, 0, 31)];
  if (row.b.y > 0.0) { return out; }   // emissive materials are done

  // Fibre halo. Loose strands stand off a knitted surface, so a yarn figure is
  // fringed with light rather than edged with a hard specular rim — the
  // falloff is deliberately broad instead of the tight power a hard surface
  // would use. Driven by the material's translucency, so wool and cloth get
  // the full halo while iron and horn get almost none.
  let V = normalize(frame.cameraPos - in.worldPos);
  let ndv = clamp(dot(n, V), 0.0, 1.0);
  let fuzz = clamp(row.b.x, 0.0, 1.0);
  let haloPow = mix(3.4, 1.9, fuzz);
  let rim = pow(1.0 - ndv, haloPow);
  let skyFill = mix(frame.skyZenith, frame.skyHorizon, 0.4)
              * frame.ambient * 3.0;
  let sunUp = smoothstep(-0.08, 0.10, frame.sunDir.y);
  // Backlit fuzz: strongest with the sun directly behind the figure.
  let back = pow(clamp(dot(V, -frame.sunDir), 0.0, 1.0), 1.6);
  let shadow = sunShadow(in.worldPos, n, distance(in.worldPos, frame.cameraPos));
  let halo = in.color * rim * (0.35 + 1.9 * fuzz)
           * (skyFill * 0.55 + frame.sunColor * back * sunUp * 0.85 * shadow);

  // Re-fog the added halo so it does not punch through distance haze.
  out.color = vec4<f32>(
    out.color.rgb + applyFog(halo, in.worldPos, -V) * 0.85, 1.0);
  return out;
}
