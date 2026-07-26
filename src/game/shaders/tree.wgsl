// Trees — instanced foliage. One shared mesh (tree-mesh.ts), one storage
// buffer of instances per chunk: vec4(x, y, z, scale). A per-instance yaw and
// tint from the position hash break up the repetition.
//
// Vertices now carry real normals, so the trunk shades as a round cylinder and
// the canopy blobs as spheres rather than as flat-lit boxes. Leaves get a
// translucency term — sunlight bleeding through a canopy is most of what makes
// a forest read as alive.
//
// The vertex transform lives in frame.wgsl's foliageWorld() so the shadow pass
// can reproduce it exactly; if the two drift, shadows slide off their trunks.

#include "common.wgsl"

@group(1) @binding(0) var<storage, read> instances: array<vec4<f32>>;

// Keep in sync with TRUNK_TOP in tree-mesh.ts.
const TRUNK_TOP: f32 = 2.0;
const CROWN_TOP: f32 = 4.6;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) localY: f32,
  @location(3) tint: f32,
}

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @builtin(instance_index) ii: u32,
) -> VSOut {
  let inst = instances[ii];
  let world = foliageWorld(frame, position, inst, TRUNK_TOP, CROWN_TOP);
  var out: VSOut;
  out.pos = frame.viewProj * vec4<f32>(world, 1.0);
  out.worldPos = world;
  out.normal = foliageNormal(normal, inst);
  out.localY = position.y;
  out.tint = instanceHash(inst);
  return out;
}

@fragment
fn fs_main(in: VSOut) -> SceneOut {
  var n = normalize(in.normal);
  let isBark = in.localY < TRUNK_TOP;

  // Foliage is double-sided (per-instance yaw flips winding), so face the
  // normal toward the viewer before lighting.
  if (dot(n, frame.cameraPos - in.worldPos) < 0.0) { n = -n; }

  // Colours, not multipliers — shadeMaterialId treats `tint` as the surface
  // colour. Per-instance hash shifts the hue so a stand of trees is not one
  // repeated green.
  var matId = MAT_ID_LEAF;
  var tint = mix(vec3<f32>(0.170, 0.310, 0.115),
                 vec3<f32>(0.268, 0.330, 0.128), in.tint);
  var ao = 1.0;
  if (isBark) {
    matId = MAT_ID_BARK;
    tint = mix(vec3<f32>(0.245, 0.180, 0.122),
               vec3<f32>(0.330, 0.258, 0.170), in.tint);
  } else {
    // Canopy self-shading: the underside of a crown must be noticeably darker
    // than the top, which a shadow map at this scale cannot resolve.
    let capsule = smoothstep(TRUNK_TOP, CROWN_TOP, in.localY);
    ao = mix(0.58, 1.04, capsule * 0.55 + (n.y * 0.5 + 0.5) * 0.45);
  }

  // Trees sample in world space on purpose: bark and leaf texture should stay
  // pinned to the world so a swaying canopy does not drag its texture along.
  return shadeMaterialId(matId, tint, in.worldPos, in.worldPos, n, ao);
}
