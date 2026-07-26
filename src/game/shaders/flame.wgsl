// ---------------------------------------------------------------------------
// flame.wgsl — every fire surface in the game, drawn as instanced billboards
// in a single additive draw call. Fed by render/fire-fx.ts.
//
// ART DIRECTION — the deliberate decision, stated once, here.
// This world is knitted and felted (see project_art_direction_yarn), so its
// fire is CUT AND STITCHED, not gaseous. A realistic turbulent plume would be
// the one object in the world that wasn't hand-made. So:
//
//   * a flame is a FELT TONGUE with a crisp cut silhouette — felt has an edge,
//     smoke does not — wrapped in a loose-fibre halo. The halo is what makes
//     it bloom and what keeps the crisp edge from aliasing;
//   * that edge is SCALLOPED at a regular frequency, as if cut with pinking
//     shears, instead of wobbled with fractal noise;
//   * the colour ramp is POSTERISED into five bands, so a tongue reads as
//     stacked layers of felt (hottest on top) rather than a smooth gradient;
//   * a RUNNING STITCH of dashes is embroidered up each tongue, and the tip
//     curls into a YARN LOOP;
//   * embers are fuzzy wool fluff-balls with a fibre halo, not sharp sparks;
//   * smoke is loose grey roving with a visible twist;
//   * the coal bed is felted charcoal with hot seams glowing between the
//     lumps — the same "light through the gaps in the stitches" read the
//     characters use.
//
// Palette is craft-store saturated (madder red -> vermilion -> tangerine ->
// marigold -> buttercream), not photographic blackbody.
//
// BLENDING: premultiplied-alpha over (`one, one-minus-src-alpha`). One
// pipeline covers both jobs — alpha 0 gives pure additive (flame, ember,
// coal), alpha > 0 gives a normal over-blend (smoke).
//
// The pass is depth-TESTED against the opaque scene but never depth-WRITING,
// and flames are deliberately excluded from the shadow cascades: they are
// emissive volumes and a fire that casts a shadow is a bug, not a feature.
// That is also why this needs no shadow pipeline despite being a new vertex
// path — it has no vertex buffer at all. The quad is generated from
// vertex_index and everything else rides a storage buffer.
// ---------------------------------------------------------------------------

#include "common.wgsl"

struct FireInstance {
  /** xyz world anchor, w half-height along the tongue axis (metres). */
  a: vec4<f32>,
  /** x life 0..1 (0 = newborn/hottest, 1 = spent), y seed, z kind, w power. */
  b: vec4<f32>,
  /** xyz tongue axis (unit length; all-zero means world up), w width/height. */
  c: vec4<f32>,
}

@group(1) @binding(0) var<storage, read> fireInstances: array<FireInstance>;
@group(2) @binding(0) var sceneDepth: texture_depth_2d;

const TAU: f32 = 6.2831853;
const PI_: f32 = 3.14159265;

struct VSOut {
  @builtin(position) pos:     vec4<f32>,
  @location(0)       uv:      vec2<f32>,
  /** life, seed, kind, power — flat across the quad. */
  @location(1)       parm:    vec4<f32>,
  @location(2)       eyeDist: f32,
}

@vertex
fn vs_main(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
) -> VSOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0,  1.0), vec2<f32>(-1.0,  1.0));
  let q = corners[vi];

  let inst = fireInstances[ii];
  let anchor = inst.a.xyz;
  let halfH = inst.a.w;
  let kind = inst.b.z;

  var up = vec3<f32>(0.0, 1.0, 0.0);
  var right = vec3<f32>(1.0, 0.0, 0.0);
  var centre = anchor;
  var halfUp = halfH;

  if (kind > 2.5) {
    // Coal bed: a disc lying flat in the fire pit, not a billboard at all.
    up = vec3<f32>(0.0, 0.0, 1.0);
    right = vec3<f32>(1.0, 0.0, 0.0);
  } else {
    let toEye = frame.cameraPos - anchor;
    let l2 = dot(toEye, toEye);
    let toCam = select(vec3<f32>(0.0, 0.0, 1.0),
                       toEye * inverseSqrt(max(l2, 1e-12)), l2 > 1e-10);

    var axis = vec3<f32>(0.0, 1.0, 0.0);
    if (dot(inst.c.xyz, inst.c.xyz) > 1e-6) { axis = normalize(inst.c.xyz); }

    // Axis-stretched billboard. `right` is perpendicular to BOTH the tongue
    // axis and the view ray; `up` is then the tongue axis projected into the
    // screen plane. Taking `up` straight from the axis instead is what made
    // the dragon's jet vanish: the jet is always aimed along the camera's
    // forward vector, so its quads ended up exactly edge-on.
    var r = cross(axis, toCam);
    let rl = length(r);
    if (rl < 1e-3) {
      // Sighting straight down the axis: any perpendicular will do, and the
      // collapse factor below has already shrunk this to a round sprite.
      r = normalize(cross(toCam, vec3<f32>(0.0, 1.0, 0.37)));
    } else {
      r = r / rl;
    }
    right = r;
    up = cross(toCam, right);

    // How much of the axis survives projection: 1 side-on, 0 straight down it.
    // Foreshortening the length by this turns a jet aimed at the camera into a
    // round fireball instead of a stretched streak seen end-on.
    halfUp = max(halfH * abs(rl), halfH * inst.c.w);

    if (kind < 0.5) {
      // A flame tongue GROWS UP from its anchor, so its base stays on the
      // fuel however tall the tongue gets.
      centre = anchor + up * halfUp;
    }
  }

  let world = centre + right * (q.x * halfH * inst.c.w) + up * (q.y * halfUp);

  var out: VSOut;
  out.pos = frame.viewProj * vec4<f32>(world, 1.0);
  out.uv = q;
  out.parm = vec4<f32>(inst.b.x, inst.b.y, kind, inst.b.w);
  out.eyeDist = distance(world, frame.cameraPos);
  return out;
}

// --- craft palette ----------------------------------------------------------

/** madder -> vermilion -> tangerine -> marigold -> buttercream. */
fn yarnFireRamp(k: f32) -> vec3<f32> {
  let t = clamp(k, 0.0, 1.0);
  // c0 is a deep madder red, NOT magenta: with additive blending a blue-shifted
  // base plus a whitish stitch highlight turned the whole flame pink.
  let c0 = vec3<f32>(0.62, 0.04, 0.04);
  let c1 = vec3<f32>(0.98, 0.13, 0.03);
  let c2 = vec3<f32>(1.00, 0.36, 0.03);
  let c3 = vec3<f32>(1.00, 0.70, 0.11);
  let c4 = vec3<f32>(1.00, 0.95, 0.70);
  if (t < 0.25) { return mix(c0, c1, t * 4.0); }
  if (t < 0.50) { return mix(c1, c2, (t - 0.25) * 4.0); }
  if (t < 0.75) { return mix(c2, c3, (t - 0.50) * 4.0); }
  return mix(c3, c4, (t - 0.75) * 4.0);
}

/**
 * Soft-particle fade. Without it every billboard cuts a hard straight line
 * into the ground it overlaps and the whole effect reads as cardboard.
 * Uses textureLoad on the read-only depth attachment, so it needs no sampler.
 */
fn softFade(fragPos: vec4<f32>, eyeDist: f32, softness: f32) -> f32 {
  let d = textureLoad(sceneDepth, vec2<i32>(fragPos.xy), 0);
  if (d >= 0.99999) { return 1.0; }  // sky behind: nothing to intersect
  let uv = fragPos.xy * frame.screenSize.zw;
  let w = worldFromDepth(uv, d, frame.invViewProj);
  return clamp((distance(w, frame.cameraPos) - eyeDist) / softness, 0.0, 1.0);
}

// --- the felt tongue --------------------------------------------------------

struct Tongue {
  cut:    f32,  // crisp cut-felt coverage
  fibre:  f32,  // loose fibres outside the cut edge
  h:      f32,  // 0 at the fuel .. 1 at the tip
  radial: f32,  // 0 on the spine .. 1 at the cut edge
  stitch: f32,  // running-stitch dashes
}

fn feltTongue(uv: vec2<f32>, seed: f32, t: f32, px: f32) -> Tongue {
  let h = clamp(uv.y * 0.5 + 0.5, 0.0, 1.0);
  let phase = seed * TAU;

  // Whip: anchored on the fuel, the tip wags. Two frequencies so it never
  // reads as a single sine.
  let wag = sin(t * 3.3 + phase) * 0.42 + sin(t * 5.9 + phase * 1.7) * 0.20;
  let x = uv.x - wag * h * h * 0.85;

  // Silhouette: a broad low belly drawn up to a point. The 0.46 exponent
  // pushes the widest part right down onto the fuel, which is what makes it
  // read as a tongue of cloth rather than a party hat.
  // The smoothstep pinches the very bottom: without it the crisp cut edge
  // wraps right round the base and every tongue reads as a balloon.
  var w = sin(pow(h, 0.52) * PI_) * 0.96 * smoothstep(0.0, 0.13, h);
  // Pinking-shear scallops. Deliberately REGULAR and deliberately LARGE:
  // fractal noise here reads as gas, and at campfire size on screen a subtle
  // wobble is simply invisible. Two harmonics an octave apart give the
  // hand-cut look without tipping over into turbulence.
  let scal = sin(h * 6.5 - t * 2.4 + phase) * 0.74
           + sin(h * 13.0 - t * 3.9 + phase * 1.6) * 0.26;
  w = max(w + 0.105 * scal * (1.0 - h * 0.35), 0.0);

  let d = abs(x) - w;
  var o: Tongue;
  o.cut = smoothstep(px, -px, d);
  // Fibre skirt: soft exponential falloff with striations, so the crisp cut
  // edge sits inside a halo of loose wool instead of ending in a hard line.
  let striate = 0.66 + 0.34 * sin(x * 30.0 + h * 9.0 + phase * 3.0);
  o.fibre = exp(-max(d, 0.0) * 7.5) * striate;
  o.h = h;
  o.radial = clamp(abs(x) / max(w, 1e-3), 0.0, 1.0);
  // Running stitch marching up the tongue, inset from the cut edge.
  let band = abs(o.radial - 0.62);
  let dash = step(0.42, fract(h * 9.0 - t * 1.4 + seed * 3.0));
  o.stitch = smoothstep(0.13, 0.0, band) * dash * o.cut;
  return o;
}

// --- fragment ---------------------------------------------------------------

@fragment
fn fs_main(in: VSOut) -> SceneOut {
  let life = clamp(in.parm.x, 0.0, 1.0);
  let seed = in.parm.y;
  let kind = in.parm.z;
  let power = in.parm.w;
  let t = frame.time;
  // Derivative first: `discard` below makes control flow non-uniform.
  let px = max(fwidth(in.uv.x), 0.0035);

  var rgb = vec3<f32>(0.0);
  var alpha = 0.0;

  if (kind < 0.5) {
    // ---- felt flame tongue ------------------------------------------------
    let g = feltTongue(in.uv, seed, t, px);
    if (g.cut + g.fibre < 0.004) { discard; }

    // Heat: hottest on the spine near the fuel, cooling to the cut edge and
    // to the tip. `life` cools the whole tongue as it is spent, which is also
    // what makes the far end of the dragon's jet go red. The radial term is
    // raised to a power so only a NARROW spine goes white — a linear falloff
    // blows the whole tongue out and every colour band with it.
    let heat = clamp((1.0 - g.h * 0.70)
                   * pow(1.0 - g.radial, 1.9)
                   * (1.0 - life * 0.55), 0.0, 1.0);
    // Posterise into five felt layers, then blend part-way back so the bands
    // read as a style rather than as quantisation error.
    let k = mix(heat, floor(heat * 5.0 + 0.5) * 0.2, 0.7);

    var col = yarnFireRamp(k);
    // Chunky stockinette across the body of the tongue: a coarse knit grid
    // that keeps even the flat regions reading as cloth.
    let weave = 0.90 + 0.10 * sin(fract(g.radial * 4.5 + g.h * 1.5) * TAU)
                             * sin(fract(g.h * 11.0) * TAU);
    col = col * weave;
    // Embroidered running stitch. Kept deliberately faint: at 0.65 it read as
    // two bright dotted chevrons drawn ON the flame rather than as stitching
    // in it, and additive blending pushed those dots pink.
    col = col + vec3<f32>(1.00, 0.72, 0.34) * g.stitch * 0.20;
    // Yarn-loop curl at the tip.
    let ring = abs(length(vec2<f32>(in.uv.x * 2.0, (g.h - 0.86) * 3.2)) - 0.42);
    let curl = smoothstep(0.24, 0.0, ring) * smoothstep(0.52, 0.86, g.h);
    col = col + vec3<f32>(1.00, 0.64, 0.24) * curl * 0.28;

    let body = g.cut * 0.92 + g.fibre * 0.26;
    let fade = smoothstep(1.0, 0.62, life);
    // Cool bands stay under the bloom threshold, the core goes well over it.
    // It has to be this hot to survive daylight exposure + ACES; at night the
    // core simply clips to white, which is what a campfire core does.
    rgb = col * body * fade * power * (1.6 + 6.8 * k)
        * softFade(in.pos, in.eyeDist, 0.45);

  } else if (kind < 1.5) {
    // ---- ember: a fuzzy wool fluff-ball -----------------------------------
    let r = length(in.uv);
    if (r > 1.0) { discard; }
    let ang = atan2(in.uv.y, in.uv.x);
    let fibres = 0.55 + 0.45 * sin(ang * 9.0 + seed * 37.0);
    let core = smoothstep(0.85, 0.10, r);
    let halo = exp(-r * 2.8) * fibres;
    let twinkle = 0.55 + 0.45 * sin(t * (11.0 + seed * 9.0) + seed * TAU);
    let fade = smoothstep(1.0, 0.55, life);
    // Newborn embers are near-white; they cool to vermilion as they climb.
    let hot = mix(vec3<f32>(1.0, 0.97, 0.86), vec3<f32>(1.0, 0.42, 0.10),
                  smoothstep(0.0, 0.5, life));
    rgb = mix(hot, yarnFireRamp(0.86 - life * 0.7), 0.45)
        * (core * 1.7 + halo * 0.7) * fade * twinkle * power * 4.0
        * softFade(in.pos, in.eyeDist, 0.22);

  } else if (kind < 2.5) {
    // ---- smoke: a twisted hank of grey roving ------------------------------
    let r = length(in.uv);
    if (r > 1.0) { discard; }
    // Streaks run ALONG the puff, like the fibres in a rope of carded wool.
    // (A radial/angular twist here produced a perfect n-fold rosette in the
    // sky, which read as a mandala rather than as smoke.)
    let strand = 0.72 + 0.28 * sin(in.uv.x * 8.0 + in.uv.y * 2.6 + seed * 31.0
                                   + t * 0.35);
    let lump = fbm2(in.uv * 1.9 + vec2<f32>(seed * 41.0, seed * 23.0 - t * 0.2), 2);
    let puff = smoothstep(1.0, 0.05, r) * strand * (0.55 + 0.9 * lump);
    // Leaves the fire glowing and cools to grey as it climbs.
    let warm = smoothstep(0.40, 0.0, life);
    let grey = mix(vec3<f32>(0.19, 0.18, 0.18), frame.fogColor, 0.55);
    let col = mix(grey, vec3<f32>(0.72, 0.33, 0.12), warm * 0.7);
    let cover = puff * smoothstep(0.0, 0.20, life) * smoothstep(1.0, 0.45, life)
              * 0.17 * power;
    alpha = clamp(cover * softFade(in.pos, in.eyeDist, 0.8), 0.0, 1.0);
    rgb = col * alpha;  // premultiplied

  } else {
    // ---- coal bed: felted charcoal with hot seams -------------------------
    let r = length(in.uv);
    if (r > 1.0) { discard; }
    let disc = smoothstep(1.0, 0.12, r);
    let cell = fbm2(in.uv * 3.1 + vec2<f32>(seed * 17.0, seed * 23.0), 3);
    let seam = smoothstep(0.42, 0.62, cell);
    // Slow double-sine breathing: coals glow, they do not strobe.
    let breathe = (0.72 + 0.28 * sin(t * 1.7 + seed * TAU))
                * (0.72 + 0.28 * sin(t * 0.83 + seed * 3.1));
    rgb = yarnFireRamp(0.20 + seam * 0.52) * disc * (0.25 + seam * 1.45)
        * breathe * power * 3.0
        * softFade(in.pos, in.eyeDist, 0.30);
  }

  var out: SceneOut;
  out.color = vec4<f32>(max(rgb, vec3<f32>(0.0)), alpha);
  // Masked off by the pipeline (writeMask 0) — fire must not pollute SSAO.
  out.normal = vec4<f32>(0.5, 0.5, 0.5, 0.0);
  return out;
}
