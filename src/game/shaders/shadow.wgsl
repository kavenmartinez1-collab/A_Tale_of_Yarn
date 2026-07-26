// ---------------------------------------------------------------------------
// shadow.wgsl — depth-only vertex stages for the cascaded shadow pass.
//
// No fragment stage: the pass writes depth alone, which is roughly twice as
// fast as running an empty fragment shader.
//
// Every family puts position at byte offset 0 as float32x3, so one entry point
// serves terrain (stride 36), characters/creatures (40) and props (24) — only
// the pipeline's arrayStride differs, and it must MATCH the buffer or the pass
// walks to the wrong vertex every step. Instanced foliage needs its own entry point
// because it must reproduce the main pass's per-instance yaw and wind sway
// exactly, or its shadow slides off the trunk.
// ---------------------------------------------------------------------------

#include "frame.wgsl"

struct Cascade {
  viewProj: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<uniform> cascade: Cascade;
// Only one of these is statically used per entry point, so each pipeline's
// group-1 layout declares just the binding its own stage touches.
@group(1) @binding(0) var<uniform> object: ObjectData;
@group(1) @binding(1) var<storage, read> instances: array<vec4<f32>>;

@vertex
fn vs_prop(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  return cascade.viewProj * vec4<f32>(position + object.offset.xyz, 1.0);
}

@vertex
fn vs_foliage(
  @location(0) position: vec3<f32>,
  @builtin(instance_index) ii: u32,
) -> @builtin(position) vec4<f32> {
  let world = foliageWorld(frame, position, instances[ii], 2.0, 4.6);
  return cascade.viewProj * vec4<f32>(world, 1.0);
}
