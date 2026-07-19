/**
 * Minimal 3D math for the game renderer.
 *
 * Conventions (keep these everywhere):
 * - Mat4 is a Float32Array(16), COLUMN-MAJOR — matches WGSL mat4x4<f32>
 *   memory layout, so matrices upload to uniform buffers verbatim.
 * - Right-handed world (+Y up), camera looks down -Z in view space.
 * - Projection maps depth to [0, 1] clip-Z (WebGPU/D3D convention, NOT the
 *   OpenGL -1..1 variant).
 */

export type Vec3 = [number, number, number];
export type Mat4 = Float32Array;

// ---------------------------------------------------------------------------
// Vec3
// ---------------------------------------------------------------------------

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return [x, y, z];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len < 1e-8) return [0, 0, 0];
  return [a[0] / len, a[1] / len, a[2] / len];
}

export function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

// ---------------------------------------------------------------------------
// Mat4 (column-major)
// ---------------------------------------------------------------------------

export function identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function translation(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

/** out = a * b (column-major). Safe to pass out === a or out === b. */
export function multiply(out: Mat4, a: Mat4, b: Mat4): Mat4 {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let row = 0; row < 4; row++) {
      r[c * 4 + row] =
        a[row] * b[c * 4] +
        a[4 + row] * b[c * 4 + 1] +
        a[8 + row] * b[c * 4 + 2] +
        a[12 + row] * b[c * 4 + 3];
    }
  }
  out.set(r);
  return out;
}

/**
 * Right-handed perspective projection with [0, 1] clip-Z (WebGPU/D3D).
 * fovY in radians.
 */
export function perspectiveZO(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (far * near) / (near - far);
  return m;
}

/** General 4x4 inverse (adjugate method). Returns identity if singular. */
export function invert(a: Mat4): Mat4 {
  const b00 = a[0] * a[5] - a[1] * a[4];
  const b01 = a[0] * a[6] - a[2] * a[4];
  const b02 = a[0] * a[7] - a[3] * a[4];
  const b03 = a[1] * a[6] - a[2] * a[5];
  const b04 = a[1] * a[7] - a[3] * a[5];
  const b05 = a[2] * a[7] - a[3] * a[6];
  const b06 = a[8] * a[13] - a[9] * a[12];
  const b07 = a[8] * a[14] - a[10] * a[12];
  const b08 = a[8] * a[15] - a[11] * a[12];
  const b09 = a[9] * a[14] - a[10] * a[13];
  const b10 = a[9] * a[15] - a[11] * a[13];
  const b11 = a[10] * a[15] - a[11] * a[14];

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-12) return identity();
  det = 1 / det;

  const m = new Float32Array(16);
  m[0] = (a[5] * b11 - a[6] * b10 + a[7] * b09) * det;
  m[1] = (a[2] * b10 - a[1] * b11 - a[3] * b09) * det;
  m[2] = (a[13] * b05 - a[14] * b04 + a[15] * b03) * det;
  m[3] = (a[10] * b04 - a[9] * b05 - a[11] * b03) * det;
  m[4] = (a[6] * b08 - a[4] * b11 - a[7] * b07) * det;
  m[5] = (a[0] * b11 - a[2] * b08 + a[3] * b07) * det;
  m[6] = (a[14] * b02 - a[12] * b05 - a[15] * b01) * det;
  m[7] = (a[8] * b05 - a[10] * b02 + a[11] * b01) * det;
  m[8] = (a[4] * b10 - a[5] * b08 + a[7] * b06) * det;
  m[9] = (a[1] * b08 - a[0] * b10 - a[3] * b06) * det;
  m[10] = (a[12] * b04 - a[13] * b02 + a[15] * b00) * det;
  m[11] = (a[9] * b02 - a[8] * b04 - a[11] * b00) * det;
  m[12] = (a[5] * b07 - a[4] * b09 - a[6] * b06) * det;
  m[13] = (a[0] * b09 - a[1] * b07 + a[2] * b06) * det;
  m[14] = (a[13] * b01 - a[12] * b03 - a[14] * b00) * det;
  m[15] = (a[8] * b03 - a[9] * b01 + a[10] * b00) * det;
  return m;
}

/** Right-handed lookAt view matrix. */
export function lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const zAxis = normalize(sub(eye, target)); // camera looks down -Z
  const xAxis = normalize(cross(up, zAxis));
  const yAxis = cross(zAxis, xAxis);
  const m = new Float32Array(16);
  m[0] = xAxis[0]; m[1] = yAxis[0]; m[2] = zAxis[0]; m[3] = 0;
  m[4] = xAxis[1]; m[5] = yAxis[1]; m[6] = zAxis[1]; m[7] = 0;
  m[8] = xAxis[2]; m[9] = yAxis[2]; m[10] = zAxis[2]; m[11] = 0;
  m[12] = -dot(xAxis, eye);
  m[13] = -dot(yAxis, eye);
  m[14] = -dot(zAxis, eye);
  m[15] = 1;
  return m;
}
