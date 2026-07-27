// Dungeon / props — the palette-batched pipeline. Serves underground
// interiors, settlement structures, resource nodes, fires, tents and building
// interiors, all batched by palette into a handful of draw calls.
//
// Material rides object.offset.w:  w >= 100 -> surface path (sun, shadows,
// fog);  w < 100 -> interior path (ambient + up to 32 torch point lights).
// (w % 100) selects the palette:
//   0 stone   1 wood        2 torch glow*  3 portal glow*  4 thatch roof
//   5 plaster 6 bush leaf   7 berry red    8 furniture wood
//   9 fabric  10 firebrick  11 wool/linen                  (* emissive)
// 12..22 were appended for building interiors and must stay append-only:
//  12 iron   13 blue wool  14 green wool  15 clay      16 leather
//  17 brass  18 soot       19 pale timber 20 beeswax   21 felt wall
//  22 window pane*
// 23..31 were appended for Castle Vhaeron, same rule:
//  23 ashlar 24 basalt     25 crimson felt 26 black felt 27 red glass*
//  28 slate  29 bone       30 voidstone    31 gravestone
// 30/31 are the castle's EXTERIOR pair: the mass and its dressings. They exist
// so the outside can be black without dragging the interiors down with it.
//
// lights.count.y is a "cozy interior" ambient floor: 0 = dungeon (faint
// ambient, dark dense fog), 1 = fully lifted. Building interiors pick a value
// per kind (see COZY in building/building-manager.ts) so a smithy stays dark
// enough for its forge to matter.

#include "common.wgsl"

struct Light {
  pos: vec4<f32>,         // xyz world position (w unused)
  colorRadius: vec4<f32>, // rgb colour, w radius (m)
}

struct Lights {
  count: vec4<f32>,       // x = active light count, y = cozy flag
  lights: array<Light, 32>,
}

@group(1) @binding(0) var<uniform> object: ObjectData;
@group(2) @binding(0) var<uniform> lights: Lights;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
}

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
) -> VSOut {
  let world = position + object.offset.xyz;
  var out: VSOut;
  out.pos = frame.viewProj * vec4<f32>(world, 1.0);
  out.worldPos = world;
  out.normal = normal;
  return out;
}

fn palette(index: f32) -> vec3<f32> {
  if (index < 0.5) { return vec3<f32>(0.42, 0.40, 0.44); } // stone
  if (index < 1.5) { return vec3<f32>(0.45, 0.31, 0.18); } // wood
  if (index < 2.5) { return vec3<f32>(1.00, 0.75, 0.35); } // torch glow
  if (index < 3.5) { return vec3<f32>(0.45, 0.75, 1.00); } // portal glow
  if (index < 4.5) { return vec3<f32>(0.66, 0.54, 0.26); } // thatch roof
  if (index < 5.5) { return vec3<f32>(0.80, 0.76, 0.68); } // plaster wall
  if (index < 6.5) { return vec3<f32>(0.30, 0.48, 0.20); } // bush leaf
  if (index < 7.5) { return vec3<f32>(0.62, 0.16, 0.22); } // berry red
  if (index < 8.5) { return vec3<f32>(0.34, 0.22, 0.12); } // furniture wood
  if (index < 9.5) { return vec3<f32>(0.55, 0.18, 0.16); } // fabric/blanket red
  if (index < 10.5) { return vec3<f32>(0.30, 0.28, 0.27); } // hearth firebrick
  if (index < 11.5) { return vec3<f32>(0.78, 0.72, 0.62); } // wool/linen
  // 12..20: building interiors. Appended, never reordered — the CPU mirror in
  // render/material-table.ts and building-interior-mesh.ts index these by name.
  if (index < 12.5) { return vec3<f32>(0.31, 0.33, 0.37); } // dark iron
  if (index < 13.5) { return vec3<f32>(0.24, 0.31, 0.45); } // blue-dyed wool
  if (index < 14.5) { return vec3<f32>(0.27, 0.38, 0.25); } // green-dyed wool
  if (index < 15.5) { return vec3<f32>(0.58, 0.35, 0.24); } // terracotta clay
  if (index < 16.5) { return vec3<f32>(0.42, 0.29, 0.18); } // tanned leather
  if (index < 17.5) { return vec3<f32>(0.76, 0.60, 0.26); } // brass / gold
  if (index < 18.5) { return vec3<f32>(0.12, 0.11, 0.11); } // soot / charcoal
  if (index < 19.5) { return vec3<f32>(0.60, 0.49, 0.34); } // pale limewashed timber
  if (index < 20.5) { return vec3<f32>(0.87, 0.78, 0.50); } // beeswax / tallow
  if (index < 21.5) { return vec3<f32>(0.84, 0.78, 0.68); } // limewashed felt wall
  // Emissive, so this value is pre-multiplier: x4 lands near 1.0 and blooms
  // gently, where palette 3 punches a white hole through the wall.
  if (index < 22.5) { return vec3<f32>(0.24, 0.31, 0.40); } // daylight window pane
  // 23..29: Castle Vhaeron. Appended, never reordered — the CPU mirror in
  // render/material-table.ts and castle/castle-layout.ts index these by name.
  // Ashlar is now an INTERIOR value: it faces the halls, the wings and every
  // floor slab, and none of that is seen through 200 m of haze. It reads a
  // shade under the old 0.355 only because CRAFTSTONE's tint weight went 0.8 ->
  // 0.94, which took away the baked layer's contribution to the same total.
  if (index < 23.5) { return vec3<f32>(0.322, 0.310, 0.344); } // ashlar
  if (index < 24.5) { return vec3<f32>(0.105, 0.098, 0.118); } // black basalt
  if (index < 25.5) { return vec3<f32>(0.430, 0.050, 0.068); } // crimson felt
  if (index < 26.5) { return vec3<f32>(0.072, 0.062, 0.078); } // black felt
  // Emissive; x1.9 lands a touch over 1.0 so the lancets bloom at dusk.
  if (index < 27.5) { return vec3<f32>(0.780, 0.135, 0.075); } // red glass
  // Slate went with the mass. Spires that stayed at 0.190 while the walls under
  // them dropped to 0.078 read as pale hats on a black keep.
  if (index < 28.5) { return vec3<f32>(0.108, 0.106, 0.140); } // slate
  if (index < 29.5) { return vec3<f32>(0.760, 0.730, 0.640); } // bone
  // 30..31: the castle's EXTERIOR palette, and the reason it exists.
  //
  // Every exterior surface used to be ashlar, which is an interior value seen
  // in daylight through aerial haze — from the hillside that reads as a royal
  // palace in light grey, not as the fortress of a man in black armour. These
  // two are only ever used outdoors, so they can be pitched for the far view
  // without making a single torch-lit room murkier.
  //
  // Overshot deliberately. Haze lifts distant geometry toward the sky value, so
  // a value chosen to look right at the gate is pale again at 260 m; 0.078 is
  // near-black up close, which is what it takes to still be black from the
  // hillside. What keeps it from being a silhouette is `gravestone`, three
  // times its value, on every course, corbel, merlon cap and door surround.
  if (index < 30.5) { return vec3<f32>(0.078, 0.074, 0.094); } // voidstone
  // Gravestone is 2.7x voidstone and no more. It was 0.238 and from up on the
  // keep roof — where the machicolation corbels fill half the frame — that read
  // as a grey castle with black inserts rather than the other way round. It is
  // also the open decks (wall-walk aside), and a deck takes the whole sky.
  return vec3<f32>(0.208, 0.199, 0.230);                       // gravestone
}

/**
 * Palette index -> material ID. Mirrors `paletteMaterial()` in
 * render/material-table.ts — keep the two in sync. It lives in both places
 * because props batch by palette through the object uniform (mode = 100 +
 * palette), so the CPU never resolves the material itself.
 *
 * `surface` is the one case where a palette index means two different things:
 * rough boulders outdoors, cut masonry underground.
 */
fn paletteMaterialId(index: f32, surface: bool) -> i32 {
  if (index < 0.5)  { return select(MAT_ID_MASONRY, MAT_ID_STONE, surface); }
  if (index < 1.5)  { return MAT_ID_WOOD; }
  if (index < 2.5)  { return MAT_ID_EMBER; }
  if (index < 3.5)  { return MAT_ID_PORTAL; }
  if (index < 4.5)  { return MAT_ID_THATCH; }
  if (index < 5.5)  { return MAT_ID_MASONRY; }
  if (index < 7.5)  { return MAT_ID_LEAF; }
  if (index < 8.5)  { return MAT_ID_WOOD; }
  if (index < 9.5)  { return MAT_ID_CLOTH; }
  if (index < 10.5) { return MAT_ID_MASONRY; }
  if (index < 11.5) { return MAT_ID_CLOTH; }
  if (index < 12.5) { return MAT_ID_IRON; }
  if (index < 14.5) { return MAT_ID_CLOTH; }        // dyed wools
  if (index < 15.5) { return MAT_ID_MASONRY; }      // fired clay
  if (index < 16.5) { return MAT_ID_LEATHER; }
  if (index < 17.5) { return MAT_ID_GOLD; }
  if (index < 18.5) { return MAT_ID_STONE; }        // soot on rough rock
  if (index < 19.5) { return MAT_ID_WOOD; }
  if (index < 20.5) { return MAT_ID_CLOTH; }        // wax reads as matte tallow
  if (index < 21.5) { return MAT_ID_FELT; }         // interior walls are felt
  if (index < 22.5) { return MAT_ID_PORTAL; }       // window pane: soft daylight
  // 23..31: Castle Vhaeron. Every stone tone it owns samples the one QUILT
  // layer and differs only in palette value — five stone tones for the price of
  // one baked layer, which is the whole point of the material table. They are
  // NOT MASONRY: brick-in-mortar is right for a settlement wall and it was the
  // only surface in a world of knitted dolls that read as photographed stone.
  if (index < 24.5) { return MAT_ID_CRAFTSTONE; }   // ashlar / black basalt
  if (index < 26.5) { return MAT_ID_FELT; }         // crimson / black felt
  if (index < 27.5) { return MAT_ID_GLASS_HOT; }    // red glass in the lancets
  if (index < 28.5) { return MAT_ID_CRAFTSLATE; }   // slate roofs and spires
  if (index < 29.5) { return MAT_ID_BONE; }         // the dragon's feeding yard
  return MAT_ID_CRAFTSTONE;                         // voidstone / gravestone
}

/** Torch point lights: inverse-square falloff windowed to a finite radius. */
fn torchLighting(worldPos: vec3<f32>, n: vec3<f32>, V: vec3<f32>, rough: f32) -> vec3<f32> {
  let count = u32(lights.count.x);
  var lit = vec3<f32>(0.0);
  for (var i = 0u; i < count; i = i + 1u) {
    let light = lights.lights[i];
    let toLight = light.pos.xyz - worldPos;
    let d = length(toLight);
    let radius = max(light.colorRadius.w, 0.001);
    if (d >= radius) { continue; }
    let L = toLight / max(d, 1e-4);
    // Physical 1/d^2 with a smooth window so it reaches zero at the radius.
    let window = pow(clamp(1.0 - pow(d / radius, 4.0), 0.0, 1.0), 2.0);
    let atten = window / (1.0 + d * d * 0.35);
    let ndl = max(dot(n, L), 0.0);
    // Firelight flicker, keyed on world position (see common.wgsl) so it
    // matches the same torch's contribution to the world-light set exactly.
    let flicker = fireFlicker(light.pos.xyz, 0.28);
    let H = normalize(L + V);
    let spec = distGGX(max(dot(n, H), 0.0), max(rough, 0.12)) * 0.05;
    lit = lit + light.colorRadius.rgb * ((ndl + spec) * atten * flicker * 3.2);
  }
  return lit;
}

@fragment
fn fs_main(in: VSOut) -> SceneOut {
  var n = normalize(in.normal);
  // Dungeon interiors wind their normals inward and props outward; either way
  // every visible back-face-culled fragment faces the camera.
  if (dot(n, frame.cameraPos - in.worldPos) < 0.0) { n = -n; }

  let mode = object.offset.w;
  let surface = mode >= 100.0;
  let palIndex = mode - select(0.0, 100.0, surface);
  let baseColor = palette(palIndex);
  let matId = paletteMaterialId(palIndex, surface);
  let row = materialTable.rows[clamp(matId, 0, 31)];
  var out: SceneOut;

  // Emissive materials (torch and portal glow) skip lighting entirely and sit
  // well above 1.0 so the bloom chain catches them. These are wicks and ember
  // beds now — the visible flame on top is a billboard from render/fire-fx.ts.
  // The flicker is world-position keyed, so every emissive surface in the
  // scene no longer pulses in perfect lockstep the way a global sin(time) made
  // them, and each wick matches the light its own fixture casts.
  if (row.b.y > 0.0) {
    let flicker = select(1.0, fireFlicker(in.worldPos, 0.26), palIndex < 2.5);
    out.color = vec4<f32>(baseColor * row.b.y * flicker, 1.0);
    out.normal = packNormal(n, 0.0);
    return out;
  }

  // Outdoors, the shared material path handles everything.
  if (surface) {
    return shadeMaterialId(matId, baseColor, in.worldPos, in.worldPos, n, 1.0);
  }

  // Interiors keep their own lighting: the group-2 torch set holds up to 32
  // lights (twice the world set) and the ambient/fog are tuned per interior
  // kind. Only the *material* comes from the table here.
  let surf = sampleMaterial(i32(row.a.x), in.worldPos, n, row.a.y);
  let albedo = baseColor * clamp(luminance(surf.albedo) / 0.33, 0.62, 1.45);
  let V = normalize(frame.cameraPos - in.worldPos);
  let viewDist = distance(in.worldPos, frame.cameraPos);
  let rough = clamp(surf.roughness * row.a.z, 0.03, 1.0);

  var color: vec3<f32>;
  var ambientRatio = 1.0;
  let count = u32(lights.count.x);
  if (count == 0u) {
    // Preview fallback: no torches uploaded yet, so keep faces readable.
    color = albedo * (0.55 + 0.45 * (dot(n, frame.sunDir) * 0.5 + 0.5));
  } else {
    // Faint for dungeons, warm and lifted for cozy building interiors.
    let cozy = clamp(lights.count.y, 0.0, 1.0);
    let base = mix(vec3<f32>(0.085, 0.085, 0.095),
                   vec3<f32>(0.30, 0.26, 0.22), cozy);
    let torch = torchLighting(in.worldPos, surf.normal, V, rough);
    color = albedo * (base * surf.ao + torch * surf.ao);
    // Torchlight is direct, so keep SSAO mostly off the lit areas.
    ambientRatio = clamp(1.0 - luminance(torch), 0.15, 1.0);
  }

  let cozy = clamp(lights.count.y, 0.0, 1.0);
  let fogDensity = frame.fogDensity * mix(1.0, 0.35, cozy);
  let fogCol = mix(frame.fogColor, vec3<f32>(0.16, 0.12, 0.08), cozy);
  color = mix(color, fogCol, 1.0 - exp(-fogDensity * viewDist));

  out.color = vec4<f32>(color, 1.0);
  out.normal = packNormal(surf.normal, ambientRatio);
  return out;
}
