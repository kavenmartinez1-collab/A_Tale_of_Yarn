// ---------------------------------------------------------------------------
// materials.wgsl — bakes the procedural material atlas at boot.
//
// The game ships no texture assets, so every surface is synthesised here into
// two mipmapped rgba8 texture arrays (MATERIAL_COUNT layers):
//   matAlbedo: rgb = base colour, a = roughness
//   matNormal: rg  = tangent-space normal xy, b = cavity AO, a = spec mask
//
// Every pattern is written against **tileable** noise (lattice coordinates are
// wrapped to a period) so triplanar sampling never shows a seam. Each mip is
// generated analytically rather than box-filtered from the level above: the
// `lod` parameter kills octaves finer than that mip's Nyquist limit, which
// keeps distant terrain crisp instead of mushy while still not aliasing.
// ---------------------------------------------------------------------------

struct GenParams {
  size: f32,   // edge length of the mip being written, in texels
  pad0: f32,
  pad1: f32,
  pad2: f32,
}

@group(0) @binding(0) var<uniform> gen: GenParams;
@group(0) @binding(1) var dstAlbedo: texture_storage_2d_array<rgba8unorm, write>;
@group(0) @binding(2) var dstNormal: texture_storage_2d_array<rgba8unorm, write>;

const PI: f32 = 3.14159265359;

// --- tileable noise ---------------------------------------------------------

fn wrap(p: vec2<f32>, period: f32) -> vec2<f32> {
  return p - floor(p / period) * period;
}

fn phash(p: vec2<f32>, period: f32) -> f32 {
  let q = wrap(p, period);
  return fract(sin(dot(q, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn phash2(p: vec2<f32>, period: f32) -> vec2<f32> {
  let q = wrap(p, period);
  return fract(sin(vec2<f32>(dot(q, vec2<f32>(127.1, 311.7)),
                             dot(q, vec2<f32>(269.5, 183.3)))) * 43758.5453);
}

/** Value noise with a wrapped lattice — tiles exactly every `period` cells. */
fn pnoise(p: vec2<f32>, period: f32) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = phash(i, period);
  let b = phash(i + vec2<f32>(1.0, 0.0), period);
  let c = phash(i + vec2<f32>(0.0, 1.0), period);
  let d = phash(i + vec2<f32>(1.0, 1.0), period);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/**
 * Tileable fBm. `lod` is the mip's texel size in UV units; octaves whose
 * feature size falls below ~2 texels are faded out to stay band-limited.
 */
fn pfbm(uv: vec2<f32>, baseFreq: f32, octaves: i32, lod: f32) -> f32 {
  var sum = 0.0;
  var norm = 0.0;
  var freq = baseFreq;
  var amp = 1.0;
  for (var i = 0; i < octaves; i = i + 1) {
    let featureUV = 1.0 / freq;
    let band = smoothstep(lod * 1.0, lod * 3.0, featureUV);
    sum = sum + pnoise(uv * freq, freq) * amp * band;
    norm = norm + amp * band;
    freq = freq * 2.0;
    amp = amp * 0.5;
  }
  return select(0.5, sum / norm, norm > 1e-4);
}

/** Tileable Worley/Voronoi. Returns (F1 distance, cell id, F2 - F1). */
fn pvoronoi(p: vec2<f32>, period: f32) -> vec3<f32> {
  let ip = floor(p);
  let fp = fract(p);
  var f1 = 8.0;
  var f2 = 8.0;
  var id = 0.0;
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      let g = vec2<f32>(f32(x), f32(y));
      let o = phash2(ip + g, period);
      let r = g + o - fp;
      let d = dot(r, r);
      if (d < f1) {
        f2 = f1; f1 = d;
        id = phash(ip + g, period);
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return vec3<f32>(sqrt(f1), id, sqrt(f2) - sqrt(f1));
}

// --- material description ---------------------------------------------------

struct MatSample {
  albedo: vec3<f32>,
  rough:  f32,
  height: f32,   // drives the normal map
  ao:     f32,   // baked cavity occlusion
  spec:   f32,
}

fn mk(albedo: vec3<f32>, rough: f32, height: f32, ao: f32, spec: f32) -> MatSample {
  var m: MatSample;
  m.albedo = albedo; m.rough = rough; m.height = height; m.ao = ao; m.spec = spec;
  return m;
}

// 0 — grass: clumped blades over patchy soil showing through.
fn matGrass(uv: vec2<f32>, lod: f32) -> MatSample {
  let clump = pfbm(uv, 6.0, 4, lod);
  // Blade streaks: stretched noise, slightly sheared so it is not a grid.
  // Kept deliberately coarse — at the tiling rate terrain.wgsl uses, a finer
  // blade frequency turns into shimmering static a few metres out.
  let blades = pnoise(vec2<f32>(uv.x * 52.0 + uv.y * 9.0, uv.y * 30.0), 52.0);
  let fine = pfbm(uv, 26.0, 3, lod);
  let dry = smoothstep(0.55, 0.82, clump);

  let deep  = vec3<f32>(0.128, 0.205, 0.088);
  let lush  = vec3<f32>(0.222, 0.352, 0.132);
  let straw = vec3<f32>(0.372, 0.372, 0.186);
  var c = mix(deep, lush, clump);
  c = mix(c, straw, dry * 0.50);
  c = c * (0.88 + 0.24 * blades) * (0.94 + 0.12 * fine);
  // Soil peeking through the thinnest patches.
  let bare = smoothstep(0.28, 0.10, clump);
  c = mix(c, vec3<f32>(0.216, 0.169, 0.118), bare * 0.50);

  let h = blades * 0.34 + clump * 0.66;
  let ao = mix(0.70, 1.0, clump * 0.7 + blades * 0.3);
  return mk(c, mix(0.82, 0.96, dry), h, ao, 0.08);
}

// 1 — dirt: granular soil with embedded pebbles.
fn matDirt(uv: vec2<f32>, lod: f32) -> MatSample {
  let grain = pfbm(uv, 24.0, 4, lod);
  let coarse = pfbm(uv, 5.0, 3, lod);
  let peb = pvoronoi(uv * 22.0, 22.0);
  let pebble = smoothstep(0.32, 0.16, peb.x);

  var c = mix(vec3<f32>(0.192, 0.145, 0.102),
              vec3<f32>(0.325, 0.255, 0.180), coarse);
  c = c * (0.85 + 0.30 * grain);
  c = mix(c, vec3<f32>(0.40, 0.38, 0.35) * (0.7 + 0.6 * peb.y), pebble * 0.7);

  let h = coarse * 0.5 + grain * 0.3 + pebble * 0.45;
  return mk(c, 0.94 - pebble * 0.15, h, mix(0.70, 1.0, h), 0.06);
}

// 2 — rock: fractured strata with mineral speckle.
fn matRock(uv: vec2<f32>, lod: f32) -> MatSample {
  let cell = pvoronoi(uv * 7.0, 7.0);
  // Crack mask from the F2-F1 ridge between cells.
  let crack = 1.0 - smoothstep(0.0, 0.085, cell.z);
  let strata = pfbm(vec2<f32>(uv.x * 1.4, uv.y * 9.0), 3.0, 4, lod);
  let speck = pfbm(uv, 48.0, 3, lod);

  var c = mix(vec3<f32>(0.290, 0.278, 0.267),
              vec3<f32>(0.470, 0.450, 0.420), strata);
  c = c * (0.80 + 0.35 * cell.y);          // per-block tonal variety
  c = c * (0.88 + 0.24 * speck);
  c = mix(c, vec3<f32>(0.130, 0.122, 0.118), crack * 0.85);

  let h = (1.0 - crack) * (0.55 + 0.30 * strata + 0.15 * speck);
  return mk(c, mix(0.88, 0.62, speck), h, mix(0.42, 1.0, 1.0 - crack), 0.14);
}

// 3 — sand: fine grain with wind ripples.
fn matSand(uv: vec2<f32>, lod: f32) -> MatSample {
  let warp = pfbm(uv, 3.0, 3, lod);
  let ripple = sin((uv.x * 34.0 + uv.y * 9.0) * PI * 2.0 + warp * 7.0) * 0.5 + 0.5;
  let grain = pfbm(uv, 64.0, 3, lod);
  let dune = pfbm(uv, 4.0, 3, lod);

  var c = mix(vec3<f32>(0.639, 0.565, 0.400),
              vec3<f32>(0.815, 0.745, 0.565), dune * 0.6 + ripple * 0.4);
  c = c * (0.93 + 0.14 * grain);

  let h = ripple * 0.55 + dune * 0.45;
  return mk(c, 0.90, h, mix(0.80, 1.0, h), 0.16);
}

// 4 — snow: soft drifts with sparkling ice crystals.
fn matSnow(uv: vec2<f32>, lod: f32) -> MatSample {
  let drift = pfbm(uv, 5.0, 4, lod);
  let grain = pfbm(uv, 70.0, 2, lod);
  let sparkleCell = pvoronoi(uv * 90.0, 90.0);
  let sparkle = smoothstep(0.16, 0.0, sparkleCell.x) * step(0.82, sparkleCell.y);

  var c = mix(vec3<f32>(0.780, 0.820, 0.900),
              vec3<f32>(0.960, 0.975, 1.000), drift);
  c = c * (0.96 + 0.08 * grain);
  c = c + vec3<f32>(sparkle * 0.5);

  let h = drift * 0.8 + grain * 0.2;
  return mk(c, mix(0.55, 0.20, sparkle), h, mix(0.86, 1.0, drift), 0.35 + sparkle);
}

// 5 — bark: deep vertical fissures.
fn matBark(uv: vec2<f32>, lod: f32) -> MatSample {
  // Stretch the lattice hard along V so grooves run with the trunk.
  let warp = pfbm(vec2<f32>(uv.x * 3.0, uv.y * 0.6), 4.0, 3, lod);
  let p = vec2<f32>(uv.x * 16.0 + warp * 1.6, uv.y * 2.2);
  let fissure = pnoise(p, 16.0);
  let ridge = 1.0 - abs(fissure * 2.0 - 1.0);
  let fine = pfbm(vec2<f32>(uv.x * 5.0, uv.y * 1.2), 24.0, 3, lod);
  let knot = smoothstep(0.72, 0.95, pfbm(uv, 3.0, 2, lod));

  let dark = vec3<f32>(0.128, 0.092, 0.062);
  let light = vec3<f32>(0.375, 0.290, 0.200);
  var c = mix(dark, light, pow(ridge, 1.6));
  c = c * (0.86 + 0.28 * fine);
  c = mix(c, dark * 0.8, knot * 0.6);

  let h = pow(ridge, 1.5) * 0.85 + fine * 0.15;
  return mk(c, 0.92, h, mix(0.38, 1.0, h), 0.05);
}

// 6 — leaves: overlapping blades with a central vein.
fn matLeaf(uv: vec2<f32>, lod: f32) -> MatSample {
  let cell = pvoronoi(uv * 11.0, 11.0);
  let leafShade = 0.65 + 0.55 * cell.y;
  // Vein running through each cell.
  let vein = smoothstep(0.10, 0.0, abs(cell.z - 0.10));
  let clump = pfbm(uv, 4.0, 3, lod);
  let edge = smoothstep(0.0, 0.06, cell.z);

  let deep = vec3<f32>(0.098, 0.196, 0.075);
  let bright = vec3<f32>(0.290, 0.470, 0.145);
  var c = mix(deep, bright, clamp(leafShade * (0.6 + 0.6 * clump), 0.0, 1.0));
  c = mix(c, c * 1.35 + vec3<f32>(0.04, 0.06, 0.0), vein * 0.5);
  c = c * mix(0.72, 1.0, edge);

  let h = (1.0 - cell.x) * 0.7 + vein * 0.3;
  return mk(c, 0.78, h, mix(0.55, 1.0, edge), 0.20);
}

// 7 — planks: sawn boards with grain, gaps and end joints.
fn matPlank(uv: vec2<f32>, lod: f32) -> MatSample {
  let rows = 6.0;
  let ry = uv.y * rows;
  let row = floor(ry);
  let fy = fract(ry);
  // Stagger each row's end joints.
  let stagger = phash(vec2<f32>(row, 3.0), rows) * 0.9;
  let cols = 2.0;
  let rx = uv.x * cols + stagger;
  let col = floor(rx);
  let fx = fract(rx);

  let boardId = phash(vec2<f32>(col, row), 64.0);
  // Grain follows the board's long axis with a per-board phase.
  let grain = pnoise(vec2<f32>(uv.x * 34.0, ry * 3.0 + boardId * 20.0), 34.0);
  let fine = pfbm(vec2<f32>(uv.x * 8.0, uv.y * 2.0), 30.0, 3, lod);

  let gapY = smoothstep(0.0, 0.035, fy) * smoothstep(1.0, 0.965, fy);
  let gapX = smoothstep(0.0, 0.012, fx) * smoothstep(1.0, 0.988, fx);
  let gap = gapY * gapX;

  var c = mix(vec3<f32>(0.325, 0.230, 0.145),
              vec3<f32>(0.545, 0.400, 0.255), boardId);
  c = c * (0.80 + 0.36 * grain) * (0.92 + 0.16 * fine);
  c = mix(vec3<f32>(0.075, 0.055, 0.038), c, gap);

  // Nail heads near the board ends.
  let nail = smoothstep(0.030, 0.012,
    length(vec2<f32>(fract(rx * 1.0 + 0.5) - 0.5, fy - 0.5) * vec2<f32>(1.0, 2.6)));
  c = mix(c, vec3<f32>(0.24, 0.23, 0.22), nail * 0.8);

  let h = gap * (0.55 + 0.35 * grain) - nail * 0.3;
  return mk(c, mix(0.95, 0.80, grain), h, mix(0.35, 1.0, gap), 0.08 + nail * 0.5);
}

// 8 — masonry: running-bond stone blocks in mortar.
fn matBrick(uv: vec2<f32>, lod: f32) -> MatSample {
  let rows = 7.0;
  let ry = uv.y * rows;
  let row = floor(ry);
  let fy = fract(ry);
  let offset = select(0.0, 0.5, fract(row * 0.5) > 0.25);
  let cols = 4.0;
  let rx = uv.x * cols + offset;
  let col = floor(rx);
  let fx = fract(rx);

  let id = phash(vec2<f32>(col, row), 64.0);
  let mortarY = smoothstep(0.0, 0.055, fy) * smoothstep(1.0, 0.945, fy);
  let mortarX = smoothstep(0.0, 0.030, fx) * smoothstep(1.0, 0.970, fx);
  let block = mortarY * mortarX;

  // Per-block surface: pitted, slightly domed.
  let pit = pfbm(uv, 40.0, 3, lod);
  let face = pfbm(uv * 1.0 + vec2<f32>(id * 7.0), 9.0, 3, lod);
  var c = mix(vec3<f32>(0.310, 0.300, 0.288),
              vec3<f32>(0.520, 0.505, 0.478), id * 0.7 + face * 0.3);
  c = c * (0.88 + 0.22 * pit);
  let mortar = vec3<f32>(0.400, 0.388, 0.360) * (0.85 + 0.25 * pit);
  c = mix(mortar, c, block);

  let dome = block * (0.55 + 0.30 * face) * (1.0 - 0.35 * pit);
  return mk(c, mix(0.96, 0.86, block), dome, mix(0.48, 1.0, block), 0.09);
}

// 9 — thatch: bundled straw laid in courses.
fn matThatch(uv: vec2<f32>, lod: f32) -> MatSample {
  let courses = 9.0;
  let cy = uv.y * courses;
  let course = floor(cy);
  let fy = fract(cy);
  let jitter = phash(vec2<f32>(course, 1.0), courses);
  // Straws run along U within each course.
  let straw = pnoise(vec2<f32>(uv.x * 130.0 + jitter * 40.0, course * 3.0), 130.0);
  let bundle = pnoise(vec2<f32>(uv.x * 20.0 + jitter * 9.0, course), 20.0);
  let lip = smoothstep(0.72, 1.0, fy);   // overhanging edge of each course

  var c = mix(vec3<f32>(0.360, 0.275, 0.130),
              vec3<f32>(0.720, 0.605, 0.330), straw * 0.65 + bundle * 0.35);
  c = c * mix(1.0, 0.55, lip);           // shadow under the overlap

  let h = straw * 0.5 + bundle * 0.4 + fy * 0.3;
  return mk(c, 0.97, h, mix(0.40, 1.0, 1.0 - lip * 0.8), 0.04);
}

// 10 — cloth: plain woven weave.
fn matCloth(uv: vec2<f32>, lod: f32) -> MatSample {
  let f = 74.0;
  let warpT = sin(uv.x * f * PI * 2.0) * 0.5 + 0.5;
  let weftT = sin(uv.y * f * PI * 2.0) * 0.5 + 0.5;
  // Over-under checker so the weave interlocks instead of forming a grid.
  let checker = step(0.5, fract(floor(uv.x * f) * 0.5 + floor(uv.y * f) * 0.5));
  let weave = mix(warpT, weftT, checker);
  let fuzz = pfbm(uv, 50.0, 3, lod);
  let dye = pfbm(uv, 3.0, 3, lod);

  var c = mix(vec3<f32>(0.400, 0.150, 0.145),
              vec3<f32>(0.640, 0.280, 0.245), dye);
  c = c * (0.78 + 0.34 * weave) * (0.93 + 0.14 * fuzz);

  return mk(c, 0.95, weave * 0.7 + fuzz * 0.3, mix(0.68, 1.0, weave), 0.05);
}

// 11 — hide: pebbled leather grain.
fn matHide(uv: vec2<f32>, lod: f32) -> MatSample {
  let cell = pvoronoi(uv * 40.0, 40.0);
  let pebble = smoothstep(0.55, 0.05, cell.x);
  let crease = smoothstep(0.0, 0.05, cell.z);
  let wear = pfbm(uv, 5.0, 3, lod);

  var c = mix(vec3<f32>(0.230, 0.150, 0.095),
              vec3<f32>(0.430, 0.300, 0.190), wear);
  c = c * (0.82 + 0.30 * pebble);

  return mk(c, mix(0.82, 0.60, pebble), pebble * 0.8 + wear * 0.2,
            mix(0.60, 1.0, crease), 0.22);
}

// 12 — skin: soft, faintly pored.
fn matSkin(uv: vec2<f32>, lod: f32) -> MatSample {
  let pore = pfbm(uv, 90.0, 2, lod);
  let blotch = pfbm(uv, 6.0, 3, lod);
  var c = mix(vec3<f32>(0.760, 0.560, 0.440),
              vec3<f32>(0.900, 0.720, 0.600), blotch);
  c = c * (0.96 + 0.08 * pore);
  return mk(c, 0.62, pore * 0.6 + blotch * 0.4, mix(0.90, 1.0, blotch), 0.30);
}

// 13 — fur: directional strands.
fn matFur(uv: vec2<f32>, lod: f32) -> MatSample {
  let flow = pfbm(uv, 4.0, 3, lod);
  let strand = pnoise(vec2<f32>(uv.x * 150.0 + flow * 26.0, uv.y * 20.0), 150.0);
  let tuft = pfbm(uv, 14.0, 3, lod);
  var c = mix(vec3<f32>(0.180, 0.140, 0.105),
              vec3<f32>(0.480, 0.390, 0.300), tuft * 0.6 + flow * 0.4);
  c = c * (0.78 + 0.40 * strand);
  return mk(c, 0.88, strand * 0.6 + tuft * 0.4, mix(0.55, 1.0, strand), 0.08);
}

// 14 — metal: brushed, lightly pitted.
fn matMetal(uv: vec2<f32>, lod: f32) -> MatSample {
  let brush = pnoise(vec2<f32>(uv.x * 190.0, uv.y * 5.0), 190.0);
  let pit = pvoronoi(uv * 26.0, 26.0);
  let dent = smoothstep(0.24, 0.06, pit.x);
  let tarnish = pfbm(uv, 7.0, 3, lod);

  var c = mix(vec3<f32>(0.480, 0.500, 0.535),
              vec3<f32>(0.700, 0.720, 0.760), brush);
  c = mix(c, vec3<f32>(0.300, 0.290, 0.265), tarnish * 0.35 + dent * 0.3);

  return mk(c, mix(0.28, 0.62, tarnish * 0.6 + dent * 0.4),
            brush * 0.3 - dent * 0.6, mix(0.70, 1.0, 1.0 - dent), 0.95);
}

// 15 — gem: faceted crystal.
fn matGem(uv: vec2<f32>, lod: f32) -> MatSample {
  let cell = pvoronoi(uv * 9.0, 9.0);
  let facet = cell.y;
  let edge = smoothstep(0.0, 0.045, cell.z);
  var c = mix(vec3<f32>(0.120, 0.360, 0.520),
              vec3<f32>(0.420, 0.780, 0.880), facet);
  c = c * mix(1.55, 1.0, edge);
  return mk(c, mix(0.30, 0.10, facet), (1.0 - cell.x) * 0.9,
            mix(0.55, 1.0, edge), 0.85);
}

// 16 — knit: chunky stockinette wool. Characters are made of this.
//
// Real stockinette reads as rows of interlocking V's, each row offset half a
// stitch from the one below, with deep valleys between stitches and a halo of
// loose fibre over the whole surface. The V's are the load-bearing detail —
// get their tilt and the row offset right and it reads as hand-knitted at a
// glance; get them wrong and it is just noise.
fn matKnit(uv: vec2<f32>, lod: f32) -> MatSample {
  let cols = 9.0;
  let rows = 11.0;
  let gx = uv.x * cols;
  let gy = uv.y * rows;
  let row = floor(gy);
  let fy = fract(gy);
  // Alternate rows sit half a stitch over — the offset is what stops the
  // pattern reading as a woven grid.
  let off = select(0.0, 0.5, fract(row * 0.5) > 0.25);
  let a = fract(gx + off) - 0.5;
  let b = fy - 0.5;

  // Two strands leaning opposite ways form the V of one stitch. Both legs
  // are zero-distance at a = 0 when b = -0.5, so they meet cleanly at the
  // bottom of the row into a V rather than crossing into an X.
  let t = b + 0.5;                    // 0 at the row's base, 1 at its top
  let lean = 0.62;
  let dl = abs(a + lean * t);
  let dr = abs(a - lean * t);
  let legL = smoothstep(0.30, 0.03, dl);
  let legR = smoothstep(0.30, 0.03, dr);
  var strand = max(legL, legR);
  // Round the cross-section, and let the legs fade as they run off the top of
  // the row into the stitch above.
  strand = strand * (1.0 - abs(b) * 0.35) * smoothstep(1.06, 0.86, t);

  // Loose fibre over the top, plus per-stitch thickness variation — no two
  // hand-knitted stitches pull exactly the same.
  let fuzz = pfbm(uv, 110.0, 3, lod);
  let slub = phash(vec2<f32>(floor(gx + off), row), 64.0);
  let h = clamp(strand * (0.82 + 0.30 * slub) + fuzz * 0.16, 0.0, 1.4);

  // The gaps between stitches are where the shadow lives; the crowns catch
  // the light. Both are carried in albedo as well as height so the knit still
  // reads at distances where the normal map has mipped away.
  let valley = 1.0 - strand;
  var c = vec3<f32>(0.90, 0.88, 0.85);
  c = c * (0.58 + 0.52 * strand);
  c = c * (0.94 + 0.12 * fuzz);
  c = c * (0.92 + 0.16 * slub);

  // Wool is matte; the only sheen is where fibre lies flat along a crown.
  let rough = mix(0.99, 0.86, strand);
  let ao = mix(0.42, 1.0, strand) * (1.0 - valley * 0.18);
  return mk(c, rough, h, ao, 0.03);
}

// 17 — felt: dense matted fibre, for the parts of a doll that are not knitted
// (patches, boot soles, satchels).
fn matFelt(uv: vec2<f32>, lod: f32) -> MatSample {
  let mat = pfbm(uv, 34.0, 4, lod);
  let fibre = pnoise(vec2<f32>(uv.x * 120.0 + mat * 22.0, uv.y * 96.0), 120.0);
  let press = pfbm(uv, 7.0, 3, lod);
  var c = vec3<f32>(0.86, 0.84, 0.80) * (0.86 + 0.24 * mat) * (0.94 + 0.12 * fibre);
  c = c * (0.92 + 0.14 * press);
  return mk(c, 0.99, mat * 0.6 + fibre * 0.4, mix(0.72, 1.0, mat), 0.02);
}

// 18 — bone: porous, chalky, faintly cracked. Skeletons, antlers' cores, skulls.
fn matBone(uv: vec2<f32>, lod: f32) -> MatSample {
  let grain = pfbm(uv, 18.0, 4, lod);
  let pore = pvoronoi(uv * 46.0, 46.0);
  let pitted = smoothstep(0.40, 0.06, pore.x);
  // Hairline cracks along the grain direction.
  let crack = 1.0 - smoothstep(0.0, 0.045, abs(
    pnoise(vec2<f32>(uv.x * 6.0, uv.y * 1.6), 6.0) - 0.5));
  let stain = pfbm(uv, 4.0, 3, lod);

  var c = mix(vec3<f32>(0.700, 0.672, 0.596),
              vec3<f32>(0.902, 0.882, 0.820), grain);
  c = c * (0.94 + 0.12 * pore.y);
  // Age staining pools in the low spots.
  c = mix(c, vec3<f32>(0.520, 0.470, 0.372), stain * 0.30 + crack * 0.35);

  let h = grain * 0.55 - pitted * 0.35 - crack * 0.30;
  return mk(c, mix(0.86, 0.70, grain), h,
            mix(0.58, 1.0, 1.0 - pitted * 0.7 - crack * 0.5), 0.16);
}

// 19 — horn/keratin: banded growth rings, semi-glossy. Antlers, hooves, beaks,
// claws, and the boss's regalia.
fn matHorn(uv: vec2<f32>, lod: f32) -> MatSample {
  // Growth rings run across the horn's length.
  let warp = pfbm(uv, 5.0, 3, lod);
  let rings = sin((uv.y * 26.0 + warp * 3.0) * PI * 2.0) * 0.5 + 0.5;
  let fibre = pnoise(vec2<f32>(uv.x * 8.0, uv.y * 70.0), 70.0);
  let blotch = pfbm(uv, 3.0, 3, lod);

  var c = mix(vec3<f32>(0.216, 0.180, 0.140),
              vec3<f32>(0.492, 0.432, 0.336), blotch * 0.65 + rings * 0.35);
  c = c * (0.92 + 0.16 * fibre);

  let h = rings * 0.6 + fibre * 0.4;
  return mk(c, mix(0.52, 0.34, rings), h, mix(0.78, 1.0, rings), 0.55);
}

// 20 — quilted ashlar: blocks of pressed felt whipped together at the joints.
//
// Castle Vhaeron is the one building every player sees first and last, and it
// was the only thing in a world of knitted dolls that read as photographed
// masonry. This lays down the SAME running bond `matBrick` does — so from the
// hillside it is still a coursed wall and still a fortress — with the two marks
// that make a thing hand-made: the joints are seams with a cross-stitch across
// them instead of mortar, and the block faces are matted fibre with a slub in
// them instead of pitted rock.
//
// The mean luminance is held near `matBrick`'s on purpose. The interior path in
// dungeon.wgsl scales albedo by `luminance(surf) / 0.33`, so a darker bake here
// would have quietly halved every torch-lit room in the castle — the exact
// "getting both would want a separate interior palette" trap. Darkness comes
// from the palette value, not from the texture.
fn matQuilt(uv: vec2<f32>, lod: f32) -> MatSample {
  let rows = 6.0;
  let cols = 3.0;
  let ry = uv.y * rows;
  let row = floor(ry);
  let fy = fract(ry);
  let offset = select(0.0, 0.5, fract(row * 0.5) > 0.25);
  let rx = uv.x * cols + offset;
  let col = floor(rx);
  let fx = fract(rx);
  let id = phash(vec2<f32>(col, row), 64.0);

  // Seam channels. Wider and softer-edged than `matBrick`'s mortar, because a
  // sewn joint is the valley between two stuffed panels, not a flat band of a
  // different substance laid between them.
  let seamY = smoothstep(0.0, 0.090, fy) * smoothstep(1.0, 0.910, fy);
  let seamX = smoothstep(0.0, 0.052, fx) * smoothstep(1.0, 0.948, fx);
  let block = seamY * seamX;

  // Cross-stitches over the seams: a dash every 1/sN of the joint, running
  // across it. Band-limited out of the coarse mips — a hard dash left in a mip
  // where it is finer than a texel is what turns a seam into crawling static at
  // distance, which is the same lesson `pfbm` encodes for its octaves.
  let sN = 13.0;
  let sBand = smoothstep(lod * 1.5, lod * 4.5, 1.0 / (cols * sN));
  let dashH = smoothstep(0.34, 0.13, abs(fract(rx * sN) - 0.5))
    * (1.0 - seamY) * seamX;
  let dashV = smoothstep(0.34, 0.13, abs(fract(ry * sN * 0.55) - 0.5))
    * (1.0 - seamX);
  let stitch = clamp(dashH + dashV, 0.0, 1.0) * sBand;

  // The face of one block: pressed fibre, a slub, and a slight pillow across
  // the middle. `matte` also drives the per-block tone so no two panels in a
  // course were cut from the same bolt.
  let matte = pfbm(uv, 26.0, 4, lod);
  let fibre = pnoise(vec2<f32>(uv.x * 96.0 + id * 30.0, uv.y * 84.0), 96.0);

  var c = mix(vec3<f32>(0.300, 0.292, 0.286),
              vec3<f32>(0.530, 0.516, 0.492), id * 0.62 + matte * 0.38);
  c = c * (0.90 + 0.20 * fibre);
  let seamCol = vec3<f32>(0.150, 0.144, 0.148) * (0.85 + 0.30 * matte);
  c = mix(seamCol, c, block);
  // Thread lies flat across the joint, so it is the one thing here that catches
  // a highlight — which is what stops the stitches reading as painted marks.
  c = mix(c, vec3<f32>(0.640, 0.622, 0.586) * (0.86 + 0.24 * fibre),
          stitch * 0.80);

  let dome = block * (0.55 + 0.28 * matte) * (1.0 - 0.22 * fibre);
  let h = dome + stitch * 0.40;
  return mk(c, mix(0.99, 0.90, block) - stitch * 0.10, h,
            mix(0.44, 1.0, block), 0.03 + stitch * 0.10);
}

fn evalMaterial(layer: u32, uv: vec2<f32>, lod: f32) -> MatSample {
  switch (layer) {
    case 0u:  { return matGrass(uv, lod); }
    case 1u:  { return matDirt(uv, lod); }
    case 2u:  { return matRock(uv, lod); }
    case 3u:  { return matSand(uv, lod); }
    case 4u:  { return matSnow(uv, lod); }
    case 5u:  { return matBark(uv, lod); }
    case 6u:  { return matLeaf(uv, lod); }
    case 7u:  { return matPlank(uv, lod); }
    case 8u:  { return matBrick(uv, lod); }
    case 9u:  { return matThatch(uv, lod); }
    case 10u: { return matCloth(uv, lod); }
    case 11u: { return matHide(uv, lod); }
    case 12u: { return matSkin(uv, lod); }
    case 13u: { return matFur(uv, lod); }
    case 14u: { return matMetal(uv, lod); }
    case 15u: { return matGem(uv, lod); }
    case 16u: { return matKnit(uv, lod); }
    case 17u: { return matFelt(uv, lod); }
    case 18u: { return matBone(uv, lod); }
    case 19u: { return matHorn(uv, lod); }
    default:  { return matQuilt(uv, lod); }
  }
}

// --- bake -------------------------------------------------------------------

// One invocation per texel; the dispatch's z dimension walks the 16 layers so
// the whole atlas mip bakes in a single dispatch.
@compute @workgroup_size(8, 8, 1)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = gen.size;
  if (f32(gid.x) >= size || f32(gid.y) >= size) { return; }

  let layer = gid.z;
  let texel = 1.0 / size;
  let uv = (vec2<f32>(f32(gid.x), f32(gid.y)) + 0.5) * texel;

  let c = evalMaterial(layer, uv, texel);
  // Central differences on the height field give the tangent-space normal.
  // Sampling one texel out keeps the bump amplitude consistent across mips.
  let hx = evalMaterial(layer, uv + vec2<f32>(texel, 0.0), texel).height;
  let hy = evalMaterial(layer, uv + vec2<f32>(0.0, texel), texel).height;

  // Enough relief to catch grazing light without turning every surface into
  // sandpaper; the triplanar blend already exaggerates whatever is here.
  let strength = 1.55;
  var n = normalize(vec3<f32>((c.height - hx) * strength,
                              (c.height - hy) * strength, 1.0));

  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  textureStore(dstAlbedo, coord, i32(layer),
    vec4<f32>(c.albedo, clamp(c.rough, 0.03, 1.0)));
  textureStore(dstNormal, coord, i32(layer),
    vec4<f32>(n.x * 0.5 + 0.5, n.y * 0.5 + 0.5, clamp(c.ao, 0.0, 1.0),
              clamp(c.spec, 0.0, 1.0)));
}
