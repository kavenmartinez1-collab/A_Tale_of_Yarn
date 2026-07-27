/**
 * test-boss-mesh.mts — the Evil King and the black dragon.
 *
 * Run:  npx tsx scripts/test-boss-mesh.mts
 *
 * Pure CPU — no GPU, no server.
 *
 * WHAT THIS FILE IS FOR, AND WHAT IT IS NOT FOR
 *
 * Every claim below is GEOMETRIC and stated in metres. That is deliberate, and
 * it is the rule this repo learned the hard way: a `griffin > bear` vertex-count
 * assertion once "proved" a wing existed, and a vertex count is not evidence of
 * a wing. So there is nothing here of the form "the boss has more vertices than
 * X". Instead: his head top is 2.000 x the player's; the crown sits ON the helm
 * with a measured gap of under 2 cm; the dragon's wing planform is wider than it
 * is long; the saddle pad's top surface is where the rider-placement API says it
 * is, to the centimetre.
 *
 * It still is not sufficient. Every check in here passed on a build where the
 * King's head was entirely inside his own chest and he read as a barrel with a
 * crown on it. Look at the models: `npx tsx scripts/_probe-boss.mts` for the
 * offline previews, `node scripts/boss-portraits.mjs` for the real renderer.
 */

import {
  ANIMAL_MAX_VERTS, buildAnimalMesh,
} from '../src/game/entities/animal-mesh';
import {
  buildCharacterMesh, CHARACTER_HEIGHT, DEFAULT_CUSTOMIZATION, IDLE_POSE,
} from '../src/game/character/character-mesh';
import {
  EVIL_KING_HEIGHT, EVIL_KING_HIP_Y, EVIL_KING_SIZE, KING_HELM_TOP_FRAC,
  kingRiderPlacement, kingRidingPose,
} from '../src/game/entities/king-mesh';
import {
  BLACK_DRAGON_SADDLE_Z, BLACK_DRAGON_SEAT_Y, BLACK_DRAGON_SIZE,
  blackDragonLandmarks,
} from '../src/game/entities/black-dragon-mesh';
import { SPECIES_DEFS, type Species } from '../src/game/entities/entity-types';
import { humanoidStride } from '../src/game/entities/humanoid-mesh';
import { animalStride } from '../src/game/entities/animal-mesh';
import { MAT } from '../src/game/render/material-table';
import type { AnimalPose } from '../src/game/entities/creature-parts';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Stride 10: pos3 (0..2) + normal3 (3..5) + color3 (6..8) + materialId (9).
const ST = 10;

function aabb(verts: Float32Array, count: number): { lo: number[]; hi: number[] } {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], verts[i * ST + k]);
      hi[k] = Math.max(hi[k], verts[i * ST + k]);
    }
  }
  return { lo, hi };
}

/** AABB of just the vertices carrying `material`. */
function matBox(
  verts: Float32Array, count: number, material: number,
): { lo: number[]; hi: number[]; n: number } {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  let n = 0;
  for (let i = 0; i < count; i++) {
    if (verts[i * ST + 9] !== material) continue;
    n++;
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], verts[i * ST + k]);
      hi[k] = Math.max(hi[k], verts[i * ST + k]);
    }
  }
  return { lo, hi, n };
}

/** Highest vertex within a horizontal radius of (x, z) — a "what is above me". */
function topNear(
  verts: Float32Array, count: number, x: number, z: number, r: number,
  material?: number,
): number {
  let top = -Infinity;
  for (let i = 0; i < count; i++) {
    const o = i * ST;
    if (material !== undefined && verts[o + 9] !== material) continue;
    if (Math.hypot(verts[o] - x, verts[o + 2] - z) > r) continue;
    if (verts[o + 1] > top) top = verts[o + 1];
  }
  return top;
}

/** Top of the crown — the highest vertex within a head's radius of the axis. */
function crownTopOf(verts: Float32Array, count: number): number {
  return topNear(verts, count, 0, 0, EVIL_KING_SIZE * 0.16);
}

const REST: AnimalPose = { yaw: 0, walkPhase: 0, walkAmp: 0 };
const WALK: AnimalPose = { yaw: 0.5, walkPhase: 1.0, walkAmp: 0.8 };
const FLY: AnimalPose = {
  yaw: 0, walkPhase: 0, walkAmp: 0, flapPhase: 0.6, flapAmp: 0.95,
};
const FURL: AnimalPose = {
  yaw: 0, walkPhase: 0, walkAmp: 0, flapPhase: 0, flapAmp: 0.10,
};

const king = buildAnimalMesh('evil_king', REST);
const kingBox = aabb(king.verts, king.count);
const dragon = buildAnimalMesh('black_dragon', REST);
const dragonFly = buildAnimalMesh('black_dragon', FLY);
const dragonFurl = buildAnimalMesh('black_dragon', FURL);

// ---------------------------------------------------------------------------
// The literal requirement: twice the player's height
// ---------------------------------------------------------------------------

{
  // The comparison is head-top to head-top, both excluding headgear.
  // `CHARACTER_HEIGHT` is documented as "head top, without hair", and
  // `KING_HELM_TOP_FRAC` is where the King's helm dome closes over his skull.
  // Comparing full AABBs instead would compare a crown against a haircut.
  check('EVIL_KING_HEIGHT is exactly 2x CHARACTER_HEIGHT',
    Math.abs(EVIL_KING_HEIGHT - 2 * CHARACTER_HEIGHT) < 1e-9,
    `${EVIL_KING_HEIGHT} vs ${2 * CHARACTER_HEIGHT}`);
  check('the species size and the body plan agree on that height',
    Math.abs(SPECIES_DEFS.evil_king.size * KING_HELM_TOP_FRAC
      - 2 * CHARACTER_HEIGHT) < 1e-9,
    `size ${SPECIES_DEFS.evil_king.size} x frac ${KING_HELM_TOP_FRAC}`);

  // And now against the MESH, which is the claim that actually matters: the
  // two constants above could agree with each other and disagree with the
  // geometry. The helm is the iron directly over the skull, so measure the
  // highest MAT.BLACKSTEEL vertex within a skull radius of the head axis — the crown
  // spikes are iron too but they sit outside that radius, and the finials are
  // MAT.EMBER.
  const headR = EVIL_KING_SIZE * 0.108;
  const helmTop = topNear(king.verts, king.count, 0, 0, headR * 0.55, MAT.BLACKSTEEL);
  check('the built helm dome closes at exactly 2x the player height',
    Math.abs(helmTop - 2 * CHARACTER_HEIGHT) < 0.01,
    `measured ${helmTop.toFixed(4)} m, want ${(2 * CHARACTER_HEIGHT).toFixed(4)}`);

  // Full silhouette, crown included, against the player's full silhouette.
  //
  // The SWORD is excluded — he holds a 2.7 m blade point-up, and counting it
  // would say he is 2.6x the player, which is a fact about a weapon and not
  // about a man. Crown only: the highest vertex within a head's radius of his
  // own axis. Stated as a band rather than a point because a crown SHOULD add
  // height — the player's iron helm adds 3 cm over `CHARACTER_HEIGHT` — and
  // the claim is that it adds a crown's worth and not a stilt's worth.
  const crownTip = topNear(king.verts, king.count, 0, 0, EVIL_KING_SIZE * 0.16);
  const player = buildCharacterMesh(DEFAULT_CUSTOMIZATION, IDLE_POSE);
  const playerTop = aabb(player, player.length / ST).hi[1];
  const ratio = crownTip / playerTop;
  check('standing silhouette, crown included, is 2.0-2.3x the player\'s',
    ratio >= 2.0 && ratio <= 2.3,
    `king ${crownTip.toFixed(3)} / player ${playerTop.toFixed(3)} = ${ratio.toFixed(3)}`);
  console.log(`  height: king head ${helmTop.toFixed(3)} m, crown tip ` +
    `${crownTip.toFixed(3)} m, player ${playerTop.toFixed(3)} m ` +
    `(silhouette ratio ${ratio.toFixed(3)})`);
}

// ---------------------------------------------------------------------------
// Nothing floats, nothing is buried, nothing is underground
// ---------------------------------------------------------------------------

{
  check('the King stands ON the ground (no part below y = 0)',
    kingBox.lo[1] >= -0.005, `lowest vertex ${kingBox.lo[1].toFixed(4)} m`);
  check('the King is not sunk (his soles reach the ground)',
    kingBox.lo[1] < 0.02, `lowest vertex ${kingBox.lo[1].toFixed(4)} m`);

  // The crown sits ON the helm.
  //
  // The trap this is written against: `makeBoxSpherePart` inscribes an
  // ELLIPSOID, so the surface is inside the box everywhere except the three
  // axis poles. A crown seated at the box lid floats; a crown seated on the
  // ellipse does not. Measure the gap directly — the lowest crown vertex
  // against the helm surface directly beneath it.
  const emberBox = matBox(king.verts, king.count, MAT.EMBER);
  const helmAtAxis = topNear(king.verts, king.count, 0, 0,
    EVIL_KING_SIZE * 0.108 * 0.55, MAT.BLACKSTEEL);
  // The crown band is felt and rings the helm; its underside must be below the
  // helm's apex or it is a halo rather than a band.
  const feltTop = matBox(king.verts, king.count, MAT.FELT);
  check('the crown band overlaps the helm rather than hovering over it',
    feltTop.hi[1] > helmAtAxis - EVIL_KING_SIZE * 0.14
      && feltTop.hi[1] < helmAtAxis + EVIL_KING_SIZE * 0.02,
    `felt top ${feltTop.hi[1].toFixed(3)} vs helm apex ${helmAtAxis.toFixed(3)}`);
  check('the emissive crown finials are above the helm, not inside it',
    emberBox.lo[1] < helmAtAxis && emberBox.hi[1] > helmAtAxis,
    `ember y ${emberBox.lo[1].toFixed(3)}..${emberBox.hi[1].toFixed(3)}, helm ${helmAtAxis.toFixed(3)}`);

  // The face has to be OUTSIDE the chest. This is the defect the first build
  // shipped with and no count-based check would ever have found: the shared
  // frame's chest ellipsoid reaches 1.236 x size and the head only 1.296, so
  // the skull was inside the torso and he had no face at any distance.
  const face = matBox(king.verts, king.count, MAT.KNIT);
  // The chest's top surface, on his own axis — not the global iron AABB, which
  // is the sword. If the face's top is not above the chest's, his head is
  // inside his own ribcage.
  const chestTop = (() => {
    let t = -Infinity;
    for (let i = 0; i < king.count; i++) {
      const o = i * ST;
      if (king.verts[o + 9] !== MAT.BLACKSTEEL) continue;
      if (Math.abs(king.verts[o]) > EVIL_KING_SIZE * 0.12) continue;
      if (king.verts[o + 1] > EVIL_KING_HEIGHT * 0.80) continue; // skip helm
      t = Math.max(t, king.verts[o + 1]);
    }
    return t;
  })();
  check('the head clears the chest — the skull is not inside the torso',
    face.hi[1] > chestTop + EVIL_KING_SIZE * 0.10,
    `face/knit top ${face.hi[1].toFixed(3)}, chest top ${chestTop.toFixed(3)}`);
  // The eyes are gems and must be proud of the face, i.e. further forward
  // (more negative Z) than the face's own front surface is deep.
  const eyes = matBox(king.verts, king.count, MAT.GEM);
  check('the eyes are on the front of the head, not inside it',
    eyes.n > 0 && eyes.lo[2] < -EVIL_KING_SIZE * 0.09,
    `gem z ${eyes.lo[2].toFixed(3)}`);
  check('the eyes are at head height',
    eyes.lo[1] > EVIL_KING_HEIGHT * 0.80,
    `gem y ${eyes.lo[1].toFixed(3)} vs head ${EVIL_KING_HEIGHT.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// The wedge, the cape, the sword
// ---------------------------------------------------------------------------

{
  // Shoulders wider than hips, by a real margin: that is the whole silhouette
  // brief, and it is a planform claim rather than a part count.
  // Measured on his LEFT (-X) only, and with MAT.CLOTH skipped. Two things
  // otherwise poison it: the cape flares to 1.5x the chest by hip height, so
  // measuring through it says the hips are as wide as the shoulders; and the
  // greatsword hangs on his right at hip height, so measuring both sides
  // reports the blade as part of his pelvis. The claim is about the BODY.
  // Armour plate only (MAT.BLACKSTEEL) and on his LEFT (-X) only. Three things
  // otherwise poison it: the cape flares to 1.5x the chest by hip height; the
  // greatsword hangs on his right at hip height, so a two-sided measure
  // reports the blade as part of his pelvis; and his arms hang beside his
  // waist, as everyone's do, so a material-blind measure calls the forearms
  // the waistline.
  let shoulderW = 0, hipW = 0, widest = 0, widestY = 0;
  const shoulderY = EVIL_KING_SIZE * 0.985;
  const hipY = EVIL_KING_HIP_Y;
  // Pelvis band taken just ABOVE the hip joint, because his gauntlets hang at
  // hip height — as everyone's fists do — and iron gauntlets at hip height are
  // iron in the hip band. This window (the tassets) is the plate that actually
  // describes his pelvis.
  const pelvisLo = hipY + EVIL_KING_SIZE * 0.03;
  const pelvisHi = hipY + EVIL_KING_SIZE * 0.07;
  for (let i = 0; i < king.count; i++) {
    const o = i * ST;
    const x = king.verts[o], y = king.verts[o + 1];
    if (king.verts[o + 9] === MAT.BLACKSTEEL && x < 0) {
      if (Math.abs(y - shoulderY) < 0.10) shoulderW = Math.max(shoulderW, -x);
      if (y >= pelvisLo && y <= pelvisHi) hipW = Math.max(hipW, -x);
    }
    if (king.verts[o + 9] !== MAT.CLOTH && Math.abs(x) > widest) {
      widest = Math.abs(x); widestY = y;
    }
  }
  check('the outline is a wedge — the pauldrons are at least 1.5x the hips',
    shoulderW > hipW * 1.5,
    `shoulder half-width ${shoulderW.toFixed(3)}, hip ${hipW.toFixed(3)}`);
  check('the widest point of the figure is at the shoulders',
    Math.abs(widestY - shoulderY) < EVIL_KING_SIZE * 0.20,
    `widest ${widest.toFixed(3)} m at y ${widestY.toFixed(3)}, shoulders at ${shoulderY.toFixed(3)}`);
  console.log(`  wedge: shoulders ${(shoulderW * 2).toFixed(2)} m across, ` +
    `hips ${(hipW * 2).toFixed(2)} m; widest point y ${widestY.toFixed(2)} m`);

  // The cape is BEHIND him and reaches his shins. A cape that stops at the
  // waist is a cape nobody sees from the front, which is where he is at the
  // moment the player first meets him.
  const cape = matBox(king.verts, king.count, MAT.CLOTH);
  check('the cape hangs behind the King (+Z at yaw 0)',
    cape.hi[2] > 0.15, `cape z max ${cape.hi[2].toFixed(3)}`);
  check('the cape reaches at least to the knee',
    cape.lo[1] < hipY * 0.62,
    `cape hem ${cape.lo[1].toFixed(3)} m, hip ${hipY.toFixed(3)} m`);

  // The greatsword. Its reach is real — `reachBonus` on the species def is
  // authored against this blade — so the geometry has to carry it. The blade
  // lives on his right (+X), inboard of the pauldron and above the legs, which
  // is the only iron in the model that is none of crown, pauldron or greave.
  let bladeTop = -Infinity, bladeBot = Infinity;
  for (let i = 0; i < king.count; i++) {
    const o = i * ST;
    if (king.verts[o + 9] !== MAT.BLACKSTEEL) continue;
    const x = king.verts[o], y = king.verts[o + 1];
    if (x < EVIL_KING_SIZE * 0.17 || x > EVIL_KING_SIZE * 0.32) continue;
    if (y < EVIL_KING_SIZE * 0.45) continue;
    bladeTop = Math.max(bladeTop, y);
    bladeBot = Math.min(bladeBot, y);
  }
  check('the greatsword is the tallest thing in the silhouette',
    bladeTop > crownTopOf(king.verts, king.count),
    `blade top ${bladeTop.toFixed(3)}, crown ${crownTopOf(king.verts, king.count).toFixed(3)}`);
  check('the greatsword is longer than the player is tall',
    bladeTop - bladeBot > CHARACTER_HEIGHT,
    `blade span ${(bladeTop - bladeBot).toFixed(2)} m vs player ${CHARACTER_HEIGHT} m`);
  console.log(`  greatsword: ${(bladeTop - bladeBot).toFixed(2)} m of steel, ` +
    `tip at ${bladeTop.toFixed(2)} m`);
}

// ---------------------------------------------------------------------------
// The dragon
// ---------------------------------------------------------------------------

{
  const rest = aabb(dragon.verts, dragon.count);
  const fly = aabb(dragonFly.verts, dragonFly.count);
  const furl = aabb(dragonFurl.verts, dragonFurl.count);

  const span = fly.hi[0] - fly.lo[0];
  const bodyLen = fly.hi[2] - fly.lo[2];
  console.log(`  dragon: wingspan ${span.toFixed(2)} m, length ` +
    `${bodyLen.toFixed(2)} m, standing ${rest.hi[1].toFixed(2)} m`);

  // "It has wings" as a PLANFORM claim, not a vertex count. A wing is wider
  // than the animal is long, and it FOLDS — a wingspan that does not change
  // between furled and spread is a pair of fins.
  check('the spread wingspan exceeds the body length',
    span > bodyLen, `span ${span.toFixed(2)} vs length ${bodyLen.toFixed(2)}`);
  check('the wings actually fold — furled span is under 60% of spread',
    (furl.hi[0] - furl.lo[0]) < span * 0.60,
    `furled ${(furl.hi[0] - furl.lo[0]).toFixed(2)} vs spread ${span.toFixed(2)}`);
  check('the wing membranes are the red accent, not the body colour',
    (() => {
      const m = matBox(dragonFly.verts, dragonFly.count, MAT.LEATHER);
      if (m.n === 0) return false;
      // Sample one membrane vertex's colour.
      for (let i = 0; i < dragonFly.count; i++) {
        const o = i * ST;
        if (dragonFly.verts[o + 9] !== MAT.LEATHER) continue;
        const r = dragonFly.verts[o + 6], g = dragonFly.verts[o + 7];
        return r > 0.30 && r > g * 3;
      }
      return false;
    })(), 'membrane vertices should be strongly red');
  check('the membranes span the full wing, not a patch near the body',
    matBox(dragonFly.verts, dragonFly.count, MAT.LEATHER).hi[0] > span * 0.40,
    `membrane x max ${matBox(dragonFly.verts, dragonFly.count, MAT.LEATHER).hi[0].toFixed(2)}`);

  check('the dragon stands on the ground',
    Math.abs(rest.lo[1]) < 0.005, `lowest vertex ${rest.lo[1].toFixed(4)}`);
  check('the black dragon is bigger than the wild dragon',
    BLACK_DRAGON_SIZE > SPECIES_DEFS.dragon.size,
    `${BLACK_DRAGON_SIZE} vs ${SPECIES_DEFS.dragon.size}`);

  const lm = blackDragonLandmarks();
  check('reported wingspan matches the measured mesh (within 2%)',
    Math.abs(lm.wingspan - span) < span * 0.02,
    `reported ${lm.wingspan.toFixed(2)}, measured ${span.toFixed(2)}`);
  check('reported standing height matches the measured mesh (within 2%)',
    Math.abs(lm.standingHeight - rest.hi[1]) < rest.hi[1] * 0.02,
    `reported ${lm.standingHeight.toFixed(2)}, measured ${rest.hi[1].toFixed(2)}`);

  // The snout is pinned: `main.ts:getBreathRay` fires from a hardcoded local
  // (forward 1.27 * size, up 1.61 * size). If the mesh's snout ever leaves
  // that point the fire cone starts in mid-air beside the head.
  let snoutZ = Infinity;
  for (let i = 0; i < dragon.count; i++) {
    const o = i * ST;
    if (Math.abs(dragon.verts[o]) < BLACK_DRAGON_SIZE * 0.06
      && dragon.verts[o + 1] > BLACK_DRAGON_SIZE * 1.4) {
      snoutZ = Math.min(snoutZ, dragon.verts[o + 2]);
    }
  }
  check('the snout tip is at -1.27 * size, as main.ts:getBreathRay assumes',
    Math.abs(snoutZ + 1.27 * BLACK_DRAGON_SIZE) < BLACK_DRAGON_SIZE * 0.05,
    `snout z ${snoutZ.toFixed(3)}, want ${(-1.27 * BLACK_DRAGON_SIZE).toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// The saddle, and putting the King in it
// ---------------------------------------------------------------------------

{
  // BLACK_DRAGON_SEAT_Y is a measured constant. Assert it against the actual
  // felt pad in the built mesh, so it cannot drift when the body proportions
  // move underneath it.
  const padTop = topNear(dragon.verts, dragon.count,
    0, BLACK_DRAGON_SADDLE_Z, BLACK_DRAGON_SIZE * 0.03, MAT.FELT);
  check('BLACK_DRAGON_SEAT_Y matches the saddle pad in the mesh',
    Math.abs(padTop - BLACK_DRAGON_SEAT_Y) < 0.02,
    `pad top ${padTop.toFixed(4)}, constant ${BLACK_DRAGON_SEAT_Y.toFixed(4)}`);

  // The pad sits ON the hide, not above it. `torsoTopAt` vs the bounding lid
  // is exactly the ellipsoid trap, and a floating saddle is its signature.
  const lm = blackDragonLandmarks();
  const padBot = (() => {
    let lo = Infinity;
    for (let i = 0; i < dragon.count; i++) {
      const o = i * ST;
      if (dragon.verts[o + 9] !== MAT.FELT) continue;
      if (Math.abs(dragon.verts[o]) > BLACK_DRAGON_SIZE * 0.05) continue;
      lo = Math.min(lo, dragon.verts[o + 1]);
    }
    return lo;
  })();
  check('the saddle pad is seated on the back, not hovering over it',
    padBot < lm.bodyTop + 0.03,
    `pad bottom ${padBot.toFixed(3)}, body top ${lm.bodyTop.toFixed(3)}`);

  // The rider API lands his hips on the pad.
  const place = kingRiderPlacement(0, 0, 0, 0, lm.saddle[1], lm.saddle[2]);
  const hipWorld = place.y + EVIL_KING_HIP_Y;
  check('kingRiderPlacement puts the King\'s hips on the saddle (within 8 cm)',
    Math.abs(hipWorld - padTop) < 0.08,
    `hips at ${hipWorld.toFixed(3)}, pad at ${padTop.toFixed(3)}`);
  check('kingRiderPlacement seats him at the withers, not the hips of the mount',
    place.z < 0, `seat z ${place.z.toFixed(3)}`);

  // Yaw handling: at 90 degrees the forward seat offset must move to -X.
  const turned = kingRiderPlacement(0, 0, 0, Math.PI / 2, lm.saddle[1], lm.saddle[2]);
  check('the seat offset rotates with the mount\'s yaw',
    Math.abs(turned.x - -lm.saddle[2]) < 1e-6 && Math.abs(turned.z) < 1e-6,
    `x ${turned.x.toFixed(4)} z ${turned.z.toFixed(4)}`);

  // Seated, the legs must leave the ground IK behind. The tell is the feet:
  // standing, the soles are at y = 0; seated, they hang well above his own
  // origin and well below his hips.
  const seated = buildAnimalMesh('evil_king', kingRidingPose(
    { yaw: 0, walkPhase: 0, walkAmp: 0 }, 0, 0, 0));
  const seatedBox = aabb(seated.verts, seated.count);
  // The BOOTS, not the cape hem — the hem hangs to 0.06 of his height whether
  // he is standing or seated, so the whole-AABB minimum reads the cloth.
  const seatedBoot = matBox(seated.verts, seated.count, MAT.BLACKSTEEL).lo[1];
  const standBoot = matBox(king.verts, king.count, MAT.BLACKSTEEL).lo[1];
  check('seated, the King\'s boots come off the floor',
    seatedBoot > standBoot + EVIL_KING_SIZE * 0.12,
    `seated sole ${seatedBoot.toFixed(3)} vs standing ${standBoot.toFixed(3)}`);
  check('seated, his knees are forward of his hips',
    seatedBox.lo[2] < -EVIL_KING_SIZE * 0.22,
    `most-forward vertex z ${seatedBox.lo[2].toFixed(3)}`);
  // The straddle: seated, his legs must be wider apart than standing, or he is
  // sitting on the dragon the way a doll sits on a shelf.
  const standWidth = (() => {
    let w = 0;
    for (let i = 0; i < king.count; i++) {
      const o = i * ST;
      if (king.verts[o + 1] < EVIL_KING_SIZE * 0.10
        || king.verts[o + 1] > EVIL_KING_SIZE * 0.34) continue;
      w = Math.max(w, Math.abs(king.verts[o]));
    }
    return w;
  })();
  const seatWidth = (() => {
    let w = 0;
    for (let i = 0; i < seated.count; i++) {
      const o = i * ST;
      if (seated.verts[o + 1] < EVIL_KING_SIZE * 0.10
        || seated.verts[o + 1] > EVIL_KING_SIZE * 0.34) continue;
      w = Math.max(w, Math.abs(seated.verts[o]));
    }
    return w;
  })();
  check('seated, he straddles — the legs are wider apart than standing',
    seatWidth > standWidth * 1.15,
    `seated ${seatWidth.toFixed(3)} vs standing ${standWidth.toFixed(3)}`);
  console.log(`  seat: origin ${place.y.toFixed(3)} m above the mount's base, ` +
    `hips ${hipWorld.toFixed(3)} m, pad ${padTop.toFixed(3)} m`);

  // And the whole point of the API: mounted, the King's crown must clear the
  // dragon's back so he is visible from the ground.
  const dragonBack = lm.bodyTop;
  check('mounted, the King rises well clear of the dragon\'s back',
    place.y + seatedBox.hi[1] > dragonBack + EVIL_KING_HEIGHT * 0.45,
    `crown at ${(place.y + seatedBox.hi[1]).toFixed(2)}, back at ${dragonBack.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// Materials — the yarn is not optional
// ---------------------------------------------------------------------------

{
  const mats = (v: Float32Array, n: number): Set<number> => {
    const s = new Set<number>();
    for (let i = 0; i < n; i++) s.add(v[i * ST + 9]);
    return s;
  };
  const km = mats(king.verts, king.count);
  check('the King has knit wool on him (MAT.KNIT)', km.has(MAT.KNIT));
  check('the King has felt trim (MAT.FELT)', km.has(MAT.FELT));
  check('the King has blackened plate (MAT.BLACKSTEEL)', km.has(MAT.BLACKSTEEL));
  check('the King wears no plain MAT.IRON — it mirrors the sky navy blue',
    !km.has(MAT.IRON));
  check('the King has a cloth cape (MAT.CLOTH)', km.has(MAT.CLOTH));
  check('the King has emissive eyes (MAT.GEM)', km.has(MAT.GEM));
  check('the King has an emissive crown/blade core (MAT.EMBER)', km.has(MAT.EMBER));
  check('the King uses NO gold — the Dread King\'s chroma, not his',
    !km.has(MAT.GOLD));

  const dm = mats(dragon.verts, dragon.count);
  check('the dragon has scale hide (MAT.SCALE)', dm.has(MAT.SCALE));
  check('the dragon has membranes (MAT.LEATHER)', dm.has(MAT.LEATHER));
  check('the dragon has horn (MAT.HORN)', dm.has(MAT.HORN));
  check('the dragon has a felt saddle (MAT.FELT)', dm.has(MAT.FELT));
  check('the dragon has blackened tack (MAT.BLACKSTEEL)', dm.has(MAT.BLACKSTEEL));
  check('the dragon has an emissive eye/throat (MAT.EMBER)', dm.has(MAT.EMBER));

  // Black means black. The vertex colours have to actually be dark or the
  // brief is not met, and "it looked dark in a preview" is not a check.
  const darkest = (v: Float32Array, n: number, m: number): number => {
    let lum = Infinity;
    for (let i = 0; i < n; i++) {
      if (v[i * ST + 9] !== m) continue;
      lum = Math.min(lum,
        0.2126 * v[i * ST + 6] + 0.7152 * v[i * ST + 7] + 0.0722 * v[i * ST + 8]);
    }
    return lum;
  };
  check('the King\'s wool is genuinely black (luma < 0.12)',
    darkest(king.verts, king.count, MAT.KNIT) < 0.12,
    `luma ${darkest(king.verts, king.count, MAT.KNIT).toFixed(3)}`);
  check('the King\'s plate is genuinely black (luma < 0.18)',
    darkest(king.verts, king.count, MAT.BLACKSTEEL) < 0.18,
    `luma ${darkest(king.verts, king.count, MAT.BLACKSTEEL).toFixed(3)}`);
  check('the dragon\'s hide is genuinely black (luma < 0.12)',
    darkest(dragon.verts, dragon.count, MAT.SCALE) < 0.12,
    `luma ${darkest(dragon.verts, dragon.count, MAT.SCALE).toFixed(3)}`);
  // The felt trim has to be RED, not merely "not black".
  const feltRed = (() => {
    for (let i = 0; i < king.count; i++) {
      const o = i * ST;
      if (king.verts[o + 9] !== MAT.FELT) continue;
      return king.verts[o + 6] > 0.35 && king.verts[o + 6] > king.verts[o + 7] * 4;
    }
    return false;
  })();
  check('the King\'s felt trim is red', feltRed);
}

// ---------------------------------------------------------------------------
// Budget, determinism, and the rest of the registration
// ---------------------------------------------------------------------------

{
  const POSES: [string, AnimalPose][] = [
    ['rest', REST], ['walk', WALK], ['fly', FLY], ['furl', FURL],
    ['seat', kingRidingPose({ yaw: 0, walkPhase: 0, walkAmp: 0 }, 0, 1.2, 0.9)],
    ['attack', { yaw: 0, walkPhase: 0, walkAmp: 0, foreSwing: 1.05, tailSway: -0.4, headPitch: 0.3 }],
    ['jaw', { yaw: 0, walkPhase: 0, walkAmp: 0, jawOpen: 1, flapAmp: 0.9, flapPhase: 2 }],
  ];
  let worst = 0, worstDesc = '';
  for (const sp of ['evil_king', 'black_dragon'] as Species[]) {
    for (const [pname, pose] of POSES) {
      for (let variant = 0; variant < 4; variant++) {
        const m = buildAnimalMesh(sp, pose, undefined, variant);
        if (m.count > worst) { worst = m.count; worstDesc = `${sp} ${pname} v${variant}`; }
        check(`${sp}/${pname}/v${variant} emits whole triangles`,
          m.count % 3 === 0, `${m.count}`);
        check(`${sp}/${pname}/v${variant} fits ANIMAL_MAX_VERTS`,
          m.count <= ANIMAL_MAX_VERTS, `${m.count} > ${ANIMAL_MAX_VERTS}`);
      }
    }
  }
  console.log(`  vertex-budget sweep: worst = ${worst} verts (${worstDesc}), ` +
    `cap ${ANIMAL_MAX_VERTS}`);
  check('ANIMAL_MAX_VERTS is not wildly oversized (<= 1.6x the boss worst case)',
    ANIMAL_MAX_VERTS <= Math.ceil(worst * 1.6),
    `worst ${worst}, cap ${ANIMAL_MAX_VERTS}`);

  // Out-buffer parity: the renderer always passes its scratch, so the scratch
  // path is the one that ships and it must be float-identical to the fresh one.
  const scratch = new Float32Array(ANIMAL_MAX_VERTS * ST);
  for (const sp of ['evil_king', 'black_dragon'] as Species[]) {
    const fresh = buildAnimalMesh(sp, WALK, undefined, 1);
    const into = buildAnimalMesh(sp, WALK, scratch, 1);
    let same = fresh.count === into.count;
    for (let i = 0; same && i < fresh.count * ST; i++) {
      if (fresh.verts[i] !== into.verts[i]) same = false;
    }
    check(`${sp} builds identically into a scratch buffer`, same);
  }

  // Determinism: same input, same bytes. No Math.random, no Date.now.
  for (const sp of ['evil_king', 'black_dragon'] as Species[]) {
    const a = buildAnimalMesh(sp, WALK, undefined, 2);
    const b = buildAnimalMesh(sp, WALK, undefined, 2);
    check(`${sp} is deterministic`,
      fnv1a(new Uint8Array(a.verts.buffer)) === fnv1a(new Uint8Array(b.verts.buffer)));
  }

  // Colours in range, normals unit length.
  for (const sp of ['evil_king', 'black_dragon'] as Species[]) {
    const m = buildAnimalMesh(sp, WALK);
    let colourOk = true, normalOk = true;
    for (let i = 0; i < m.count; i++) {
      const o = i * ST;
      for (let k = 6; k < 9; k++) {
        if (!(m.verts[o + k] >= 0 && m.verts[o + k] <= 1)) colourOk = false;
      }
      const n = Math.hypot(m.verts[o + 3], m.verts[o + 4], m.verts[o + 5]);
      if (Math.abs(n - 1) > 1e-3) normalOk = false;
    }
    check(`${sp} colours are all in [0,1]`, colourOk);
    check(`${sp} normals are unit length`, normalOk);
  }

  // The gait identity: `animalStride` MUST equal `humanoidStride` for the
  // King, because the AI advances walkPhase by distance / animalStride while
  // the mesh sweeps its stance over humanoidStride * duty. Disagreement makes
  // the feet skate by the ratio and no still frame shows it.
  check('animalStride(evil_king) === humanoidStride(evil_king)',
    animalStride('evil_king') === humanoidStride('evil_king'),
    `${animalStride('evil_king')} vs ${humanoidStride('evil_king')}`);

  // Seated, the gait must be OFF. A rider whose walkAmp survives is a rider
  // pedalling in mid-air in time with the mount.
  const seatWalk = buildAnimalMesh('evil_king', {
    yaw: 0, walkPhase: 1.0, walkAmp: 1.0, seat: 1,
  });
  const seatStill = buildAnimalMesh('evil_king', {
    yaw: 0, walkPhase: 2.7, walkAmp: 1.0, seat: 1,
  });
  let identical = true;
  for (let i = 0; identical && i < seatWalk.count * ST; i++) {
    if (seatWalk.verts[i] !== seatStill.verts[i]) identical = false;
  }
  check('at seat = 1 the walk cycle no longer moves anything',
    identical, 'walkPhase still drives the seated mesh');

  // `seat` is opt-in: leaving it undefined must reproduce the old output bit
  // for bit, or every existing species\' golden hash moves.
  const noSeat = buildAnimalMesh('dread_king', WALK);
  const zeroSeat = buildAnimalMesh('dread_king', { ...WALK, seat: 0 });
  let unchanged = noSeat.count === zeroSeat.count;
  for (let i = 0; unchanged && i < noSeat.count * ST; i++) {
    if (noSeat.verts[i] !== zeroSeat.verts[i]) unchanged = false;
  }
  check('seat = 0 is bit-identical to seat = undefined (golden-hash safe)',
    unchanged);
}

// ---------------------------------------------------------------------------
// Golden hash — a change tripwire, not a correctness claim
// ---------------------------------------------------------------------------
//
// Its own hash rather than widening `test-animal-mesh.mts`'s ALL_SPECIES list:
// widening that list moves a hash two other workstreams depend on. Rebaseline
// only after LOOKING at the models, and say here what visual defect moved it.
//
// History, newest first:
//   0xf4eb981f — first bake, after `node scripts/boss-portraits.mjs`. Covers the
//                silhouette pass that gave the King a capped chest with its
//                own surface solver (the frame's chest closed over his skull
//                and he read as a barrel with a crown on it), a neck, a brow
//                bar, a V chevron, a high collar, a surcoat, human arm
//                proportions and hip-based saddle seating; gave the dragon a
//                three-horn swept crest and an oxblood accent (a five-horn red
//                crest made the head a firework); and moved every plate onto
//                `MAT.BLACKSTEEL`, because `MAT.IRON` is a full mirror and a
//                black mirror outdoors is a navy-blue mirror.
// 2026-07-26  0xf4eb981f -> 0x50f3e75c. Legibility pass on the mounted read:
//             the King is first seen at 150 m circling his own castle on the
//             black dragon, and there he was a dark lump. Crown spikes 1.70 ->
//             2.06 head-radii with an emissive tip on all seven instead of
//             three (the ratio check above still holds at 2.277 of 2.30); the
//             cape lifted to the King's accent red, because at 0.34 it was
//             DARKER than the dragon's own 0.46 membrane and rider and mount
//             dissolved into one red shape; a near-black pale down the cape's
//             centre; red felt on the crown of each pauldron as well as under
//             its lip; a seated cape that streams back along the spine instead
//             of hanging 2.3 m through the animal; a stitched V of a mouth; and
//             `MAT.HORN` -> `MAT.HORN_DARK` on his spikes and the dragon's
//             crest, whose 0.35 tint weight was rendering both pale tan.
const BOSS_GOLDEN: number | null = 0xe058ef68;

{
  const CANON: AnimalPose = { yaw: 0.5, walkPhase: 1.0, walkAmp: 0.8 };
  const bytes: number[] = [];
  for (const sp of ['evil_king', 'black_dragon'] as Species[]) {
    const { verts, count } = buildAnimalMesh(sp, CANON, undefined, 0);
    const b = new Uint8Array(verts.buffer, 0, count * 40);
    for (let i = 0; i < b.length; i++) bytes.push(b[i]);
  }
  const h = fnv1a(new Uint8Array(bytes));
  if (BOSS_GOLDEN === null) {
    console.log(`\n  golden hash (evil_king + black_dragon): 0x${h.toString(16).padStart(8, '0')}`);
    check('the boss golden hash is baked', false, 'set BOSS_GOLDEN above');
  } else {
    check('golden hash matches the two boss meshes',
      h === BOSS_GOLDEN,
      `got 0x${h.toString(16)} want 0x${BOSS_GOLDEN.toString(16)}`);
  }
}

// ---------------------------------------------------------------------------
// Rebuild cost against the renderer's 8-per-frame budget
// ---------------------------------------------------------------------------

{
  const timeOf = (sp: Species, pose: AnimalPose): number => {
    const scratch = new Float32Array(ANIMAL_MAX_VERTS * ST);
    for (let i = 0; i < 30; i++) buildAnimalMesh(sp, pose, scratch);  // warm
    const t0 = process.hrtime.bigint();
    const N = 200;
    for (let i = 0; i < N; i++) buildAnimalMesh(sp, pose, scratch);
    return Number(process.hrtime.bigint() - t0) / (N * 1e6);
  };
  const kms = timeOf('evil_king', WALK);
  const dms = timeOf('black_dragon', FLY);
  console.log(`  rebuild: evil_king ${kms.toFixed(2)} ms, ` +
    `black_dragon ${dms.toFixed(2)} ms ` +
    `(entity-renderer budget: 8 rebuilds/frame)`);
  // Generous by ~2x against what was measured, so this is a regression
  // tripwire and not a benchmark that fails on a busy machine. Two bosses on
  // screen at once is the worst case the fight can produce, and even then they
  // are 2 of the 8 rebuilds a frame is allowed.
  check('evil_king rebuilds in under 6 ms', kms < 6, `${kms.toFixed(2)} ms`);
  check('black_dragon rebuilds in under 8 ms', dms < 8, `${dms.toFixed(2)} ms`);
  check('the pair fits inside one frame\'s rebuild budget (< 8 ms combined)',
    kms + dms < 8, `${(kms + dms).toFixed(2)} ms`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
