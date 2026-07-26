/**
 * Stylized animal mesh builders — pure CPU, node-testable.
 *
 * One builder per body-plan (quadruped, bird, dragon, griffin, sea_serpent),
 * all sized relative to SPECIES_DEFS[species].size so larger species produce
 * proportionally taller/longer meshes.
 *
 * Vertex format: interleaved [x, y, z, nx, ny, nz, r, g, b, materialId] × N
 * (stride = 10 floats, 40 bytes) — identical to the character mesh pipeline
 * convention. materialId is a plain float holding a MAT.* constant
 * (render/material-table.ts), constant across a part but written per-vertex.
 * Geometry comes from the shared mesh-utils primitives (box, bevelBox,
 * sphere, capsule, cone, quad), which already bake correct LOCAL-space
 * normals into their output; posing rotates those normals through the same
 * pitch/twist/roll chain as the position (pivot offset omitted — normals are
 * directions, not points) so lit limbs shade correctly at every pose angle.
 * All chain rotations here are rigid (no scale), so re-using the position's
 * rotation matrix for the normal is exact; the result is re-normalized at
 * the very end purely to guard against float drift.
 *
 * Local space: base of the creature at y = 0, facing -Z at yaw 0.
 *
 * Imports the box/quad primitives from mesh-utils (shared with props and
 * the character mesh) rather than re-implementing them, so every part gets
 * real vertex normals for free; this file still never imports from — or
 * modifies — character-mesh.ts.
 */

import { taperedCapsule } from '../mesh-utils';
import type { Species } from './entity-types';
import { SPECIES_DEFS } from './entity-types';
import { MAT } from '../render/material-table';
import {
  footTarget, makeLegPlan, maxStride, solveLeg,
  GAIT_AMBLE, GAIT_BOUND, GAIT_WALK,
  type GaitPattern, type LegPlan,
} from '../anim/gait';

// Shared part/pose vocabulary and the poser (split out so body plans can be
// worked on independently); the dragon lives in its own module for the same
// reason. Re-exported below so existing importers of animal-mesh keep working.
import {
  applyVariant, assembleParts, makeBevelPart,
  makeBoxCapsulePart, makeBoxConePart, makeBoxConePartZ, makeBoxSpherePart,
  makeEarPart, makeEyeParts, makeFlatQuadPart, makePart, makeWingPart,
  pitch, rollZ, tint, twistY,
  ACCENT_COLORS, ANIMAL_IDLE_POSE, BASE_COLORS, BELLY_COLORS,
  type AnimalPose, type Color3, type Part, type Rot,
} from './creature-parts';
import { buildDragon } from './dragon-mesh';
import { buildWyvern } from './wyvern-mesh';
import { buildHumanoid, humanoidStride, isHumanoid } from './humanoid-mesh';

export { ANIMAL_IDLE_POSE };
export type { AnimalPose };
// ---------------------------------------------------------------------------
// Body plan: QUADRUPED
// Covers: rabbit, deer, horse, cow, donkey, wolf, bear
//
// Proportions driven by `s` (shoulder height = SPECIES_DEFS[species].size).
// Local space: bottom of legs at y=0; body spans legH..legH+bodyH.
//
// Torso is a non-uniform-scale sphere; legs, necks, muzzles and tails are
// capsules; horns/antlers are cones. Ears stay flat boxes (a capsule/sphere
// reads wrong for a flat blade shape).
// ---------------------------------------------------------------------------

/**
 * Body envelope — coefficients of `s` (shoulder height), one row per
 * quadruped species (RECTIFICATION_PLAN.md §5.1 "target proportions"
 * table). Replaces the old isRabbit/isHorse/isWolf/isBear ternary chain,
 * which silently resolved deer and cow (and horse/donkey's bodyW/bodyL/
 * legR) to the *same* numbers — confirmed problem #4, "deer and cow are
 * the identical mesh". `legGapMul` is Rule A (legs must break the
 * silhouette: legGap + legR > bodyW); `legR` combined with the leg length
 * below is Rule B (leg aspect floor).
 */
interface QuadrupedBody {
  legH: number; bodyH: number; bodyW: number; bodyL: number;
  legR: number; legGapMul: number;
}
type QuadrupedSpecies = 'rabbit' | 'deer' | 'cow' | 'wolf' | 'bear' | 'horse' | 'donkey';

const BODY_SHAPE: Record<QuadrupedSpecies, QuadrupedBody> = {
  rabbit: { legH: 0.34, bodyH: 0.44, bodyW: 0.24, bodyL: 0.34, legR: 0.048, legGapMul: 0.80 },
  // bodyH was 0.30, which gave a 1.2 m deer a 36 cm chest — a slab on stilts.
  // A deer's chest depth is a little over 0.4 of its shoulder height.
  deer:   { legH: 0.56, bodyH: 0.42, bodyW: 0.19, bodyL: 0.50, legR: 0.042, legGapMul: 0.92 },
  cow:    { legH: 0.42, bodyH: 0.58, bodyW: 0.24, bodyL: 0.58, legR: 0.055, legGapMul: 0.85 },
  // Was bodyW 0.18 / legR 0.042, which is a whippet, not a wolf: side-on it
  // read as a thin grey deer with a rod for a tail. A wolf is deep-chested and
  // heavy-boned for its height.
  wolf:   { legH: 0.52, bodyH: 0.42, bodyW: 0.21, bodyL: 0.64, legR: 0.056, legGapMul: 0.82 },
  // Broader, longer and thicker-limbed. The bear is the biggest land animal in
  // the game and was reading as a mid-size quadruped with a lump on its back —
  // mass is the whole point of the species.
  // LONG AND LOW. bodyH 0.56 with bodyL 0.56 gave a torso only 1.7x as long as
  // it was deep — a ball — and a ball with a dome on top of it is a camel, which
  // is what three rounds of head and hump work kept failing to shake. A brown
  // bear is roughly 2.5 body-depths long. Lengthening the barrel and dropping
  // its depth does more for the read than any single feature on the animal.
  bear:   { legH: 0.38, bodyH: 0.50, bodyW: 0.36, bodyL: 0.64, legR: 0.092, legGapMul: 0.68 },
  horse:  { legH: 0.57, bodyH: 0.43, bodyW: 0.23, bodyL: 0.60, legR: 0.053, legGapMul: 0.80 },
  donkey: { legH: 0.53, bodyH: 0.45, bodyW: 0.25, bodyL: 0.52, legR: 0.056, legGapMul: 0.80 },
};

/** Generic head — coefficients of `s`, width/depth/height. horse/donkey
 * build a dedicated head assembly below and don't use this table. `d`
 * (front-to-back) now exceeds `w` (side-to-side) for every species — the
 * old table had this backwards (headW > headD), so every herbivore head
 * was a pancake rotated 90° from correct (problem #2). */
const HEAD_SHAPE: Record<'rabbit' | 'deer' | 'cow' | 'wolf' | 'bear', { w: number; d: number; h: number }> = {
  rabbit: { w: 0.16,  d: 0.26, h: 0.20 },
  deer:   { w: 0.105, d: 0.32, h: 0.16 },
  cow:    { w: 0.14,  d: 0.30, h: 0.21 },
  wolf:   { w: 0.118, d: 0.28, h: 0.185 },
  // A bear's skull is SHORT and broad — d 0.30 made it as long as a horse's,
  // and with the neck's forward lean and the old long snout on the end of it
  // the whole head/neck assembly came out as one horizontal sausage sticking
  // off the chest. This is the single biggest reason the bear "looked wild".
  // NOTE `w` is a HALF-width while `d` and `h` are full extents, so a row is
  // wider than it is long whenever 2*w > d. Raising the bear's w to 0.21 while
  // cutting d to 0.24 made its skull 0.42 s across and 0.24 s deep — a pancake
  // rotated 90 degrees from correct, the very bug the table comment warns
  // about, which is why the head kept looking small side-on however big the
  // numbers got. A bear's skull is a shade longer than it is wide, and deep.
  bear:   { w: 0.158, d: 0.34, h: 0.28 },
};

/** Generic neck — length / lean (rad from vertical) / radius, coefficients
 * of `s`. horse/donkey already had a hand-authored neck (§10: "the only
 * quadrupeds with a real neck... the template the other five should
 * copy") and are excluded here; every other quadruped previously had NO
 * neck geometry at all — the head floated 22-53cm above the torso with
 * nothing connecting it (problem #1, the single biggest cause of the
 * "grey blob" read). */
/**
 * `rootZ` / `rootY` place the neck's base, and they matter as much as its
 * length. Previously every neck was rooted at a fixed z = -0.60·bodyL on the
 * TOP surface of the torso, i.e. sprouting vertically out of the shoulder
 * blades. On a wolf — a low, level-backed animal whose head carries barely
 * above its spine — that left no visible neck at all: the head sat straight on
 * the shoulders and the animal read as one continuous lump.
 *
 * A neck leaves the front of the CHEST, not the top of the back. `rootZ` is a
 * fraction of bodyL (more negative = further forward) and `rootY` a fraction
 * of bodyH above hipY, so a low root plus a large lean gives the horizontal
 * carriage a canid needs, and a high root plus a small lean gives the upright
 * carriage of a deer.
 */
const NECK_SHAPE: Record<'rabbit' | 'deer' | 'cow' | 'wolf' | 'bear',
  { len: number; lean: number; r: number; rootZ: number; rootY: number }> = {
  rabbit: { len: 0.10, lean: 0.50, r: 0.048, rootZ: -0.62, rootY: 0.80 },
  // Was len 0.38 / r 0.055 — long and pencil-thin, which read as a giraffe.
  deer:   { len: 0.32, lean: 0.52, r: 0.072, rootZ: -0.74, rootY: 0.84 },
  cow:    { len: 0.24, lean: 0.78, r: 0.088, rootZ: -0.80, rootY: 0.76 },
  // Long, low and thick: a wolf carries its head level with or below the
  // shoulder, which is why the lean is close to horizontal.
  wolf:   { len: 0.28, lean: 1.02, r: 0.098, rootZ: -0.78, rootY: 0.66 },
  // The bear's neck is the piece that decides whether it reads as a bear or a
  // camel, and the first two attempts both gave it a camel. Rooted low and
  // forward on the chest with a long lean, the head ends up out on the end of a
  // horizontal stalk with a clear valley between it and the shoulder hump —
  // which is a camel's silhouette exactly. A brown bear has almost no visible
  // neck: the skull, the massive neck and the hump are ONE unbroken line from
  // the nose to the middle of the back. So: rooted high (0.80 of body depth)
  // and well back, very short, and nearly as thick as the skull itself.
  bear:   { len: 0.13, lean: 0.80, r: 0.118, rootZ: -0.70, rootY: 0.80 },
};

/**
 * Ear geometry and — the part that actually carries the species — ear CARRIAGE.
 *
 * `w`/`h`/`d` are half-width, height and half-depth as coefficients of `s`.
 * `x` is the root offset as a fraction of headW and `z` the set-back as a
 * fraction of headD. `splay` rolls the blade outward from vertical and `rake`
 * pitches it (positive = tips forward, negative = tips back).
 *
 * The angles are the whole point. Every one of these used to be zero, because
 * every ear was an axis-aligned box, and a cow with its ears standing straight
 * up is not a cow — it is a goat. Sideways ears on the cow, buttons wide on the
 * bear's crown, outward scoops on the deer, tall back-raked blades on the
 * rabbit: those four silhouettes are recognisable with no other detail at all.
 */
const EAR_SHAPE: Record<'rabbit' | 'deer' | 'cow' | 'wolf' | 'bear',
  { w: number; h: number; d: number; x: number; z: number; splay: number; rake: number }> = {
  // Tall back-raked blades, the animal's entire read.
  rabbit: { w: 0.048, h: 0.40, d: 0.020, x: 0.52, z: 0.18, splay: 0.26, rake: -0.30 },
  // Big outward scoops — a deer's ears are held wide, like cupped hands.
  deer:   { w: 0.055, h: 0.20, d: 0.026, x: 0.80, z: 0.16, splay: 1.00, rake: -0.24 },
  // Nearly horizontal. This is the correction the user asked for by name.
  cow:    { w: 0.050, h: 0.19, d: 0.030, x: 0.78, z: 0.14, splay: 1.32, rake: -0.10 },
  // Stiff triangles, only slightly splayed; built as cones, not blades.
  wolf:   { w: 0.055, h: 0.17, d: 0.038, x: 0.62, z: 0.22, splay: 0.30, rake: -0.14 },
  // Round buttons set wide on the crown — with the short muzzle, the two cues
  // that make a bear a bear rather than a big dog.
  bear:   { w: 0.088, h: 0.145, d: 0.058, x: 0.80, z: 0.06, splay: 0.62, rake: -0.06 },
};

/** Eye colour. Near-black with a trace of warmth so it is not a dead hole. */
const EYE_COLOR: Color3 = [0.07, 0.055, 0.05];

/**
 * Per-species limb anatomy for the planted-foot rig (`../anim/gait`).
 *
 * The three numbers that actually matter, and why:
 *
 * **`cannon`** — the length of the lowest segment (metacarpus / metatarsus), as
 * a fraction of hip height. This is the single strongest species cue in a leg.
 * Ungulates run on elongated cannon bones and read as leggy and delicate; a
 * bear is plantigrade and walks on its whole foot, so its cannon is nearly
 * nothing and it reads as heavy.
 *
 * **`ankleSet`** — how far the ankle sits behind the foot, as a fraction of the
 * cannon. Near zero on a foreleg (the carpus stacks almost straight over the
 * foot); large on a hind leg, where it produces the hock-set-back Z zig-zag
 * that makes a deer or horse hind leg instantly recognisable.
 *
 * **`slack`** — total bone length over the standing hip-to-ankle gap. At 1.0
 * every joint locks straight and the animal stands like a table. It also caps
 * the stride, because a straight limb has no spare reach to step with (see
 * `maxStride`), so the crouched species that need long strides need the most
 * slack. That coupling is not a coincidence — it is why real sprinters are
 * built with deeply folded limbs.
 */
interface LegRig {
  gait: GaitPattern;
  /** Cannon length as a fraction of hip height: [fore, hind]. */
  cannon: [number, number];
  /** Ankle set-back as a fraction of cannon length: [fore, hind]. */
  ankleSet: [number, number];
  /** Bone length over standing gap; > 1 keeps a live bend. */
  slack: number;
  /** Upper bone's share of the two-bone chain: [fore, hind]. */
  upperFrac: [number, number];
}

const LEG_RIG: Record<QuadrupedSpecies, LegRig> = {
  // Bounds rather than walks — both forelegs together, both hind together,
  // with a genuine airborne phase. The long hind foot (cannon 0.46) and the
  // deeply folded hock are the rabbit silhouette.
  rabbit: { gait: GAIT_BOUND, cannon: [0.20, 0.46], ankleSet: [0.10, 0.70],
            slack: 1.26, upperFrac: [0.52, 0.48] },
  // Long cannons, minimal foreleg set-back, pronounced hock: the classic
  // cervid leg. Stands nearly straight, so it steps short and lightly.
  deer:   { gait: GAIT_AMBLE, cannon: [0.32, 0.35], ankleSet: [0.07, 0.56],
            slack: 1.11, upperFrac: [0.56, 0.50] },
  // Heavy and deliberate — lateral-sequence walk, shorter cannon than a deer.
  cow:    { gait: GAIT_WALK,  cannon: [0.26, 0.28], ankleSet: [0.09, 0.48],
            slack: 1.12, upperFrac: [0.55, 0.50] },
  // Digitigrade: walks on its toes, carried in a permanent crouch. High slack
  // buys both the crouch and the long, low-slung stride of a canid.
  wolf:   { gait: GAIT_AMBLE, cannon: [0.24, 0.30], ankleSet: [0.12, 0.62],
            slack: 1.19, upperFrac: [0.53, 0.48] },
  // Plantigrade: the whole foot contacts the ground, so the cannon almost
  // vanishes and the ankle sits nearly over the toes. Reads as mass.
  bear:   { gait: GAIT_WALK,  cannon: [0.16, 0.18], ankleSet: [0.06, 0.34],
            slack: 1.20, upperFrac: [0.54, 0.50] },
  horse:  { gait: GAIT_AMBLE, cannon: [0.33, 0.35], ankleSet: [0.06, 0.52],
            slack: 1.09, upperFrac: [0.57, 0.50] },
  donkey: { gait: GAIT_AMBLE, cannon: [0.30, 0.32], ankleSet: [0.07, 0.50],
            slack: 1.11, upperFrac: [0.56, 0.50] },
};

/**
 * Torso shape — chest and abdomen as two separate masses.
 *
 * A single ellipsoid is a barrel: the same depth and width from shoulder to
 * hip. Every quadruped in the game shared one, which is why a cow and a horse
 * differed mainly in colour. The two features that actually separate species
 * are both impossible to express with one mass:
 *
 *   - a DEEP CHEST carrying the shoulder, versus a shallow one
 *   - the ABDOMEN: tucked up hard on a runner (deer, wolf), dropped low and
 *     wide on a grazer (cow), level on a bear
 *
 * Each entry is [zFront, zBack, halfWidth, bottomY, topY]: z as fractions of
 * `bodyL` where -1 is the nose end, width of `bodyW`, and y of `bodyH` measured
 * from `hipY` (so 0 = belly line, 1 = top of the back). The two masses overlap
 * in z so they read as one animal rather than two beads.
 */
type TorsoMass = readonly [number, number, number, number, number];
interface TorsoShape {
  chest: TorsoMass;
  abdomen: TorsoMass;
  /** Withers lump height as a fraction of bodyH; 0 = none. */
  withers: number;
}

/**
 * The z-ranges overlap HEAVILY on purpose, and each mass is longer than it is
 * tall. The first version of this table gave the cow a chest spanning
 * [-1.00, -0.05] and an abdomen [-0.20, 1.00]: barely a sixth of the body
 * length in common, and since a cow's bodyH and bodyL are equal, each mass came
 * out a near-perfect sphere. It rendered as two balls joined at a pinch — worse
 * than the single barrel it replaced.
 *
 * The belly tuck does not come from separating the masses; it comes from the
 * abdomen being narrower and its underside sitting higher. They can share most
 * of their length and still describe completely different animals.
 */
const TORSO_SHAPE: Record<QuadrupedSpecies, TorsoShape> = {
  // Small front, powerful rear — the rabbit reads almost entirely by haunch.
  rabbit: { chest:   [-1.00, 0.25, 0.86, 0.06, 0.88],
            abdomen: [-0.30, 1.00, 1.04, -0.02, 1.04], withers: 0 },
  // Shallow slender chest with a hard belly tuck: the cervid runner's line.
  deer:   { chest:   [-1.00, 0.20, 1.02, -0.04, 1.02],
            abdomen: [-0.35, 1.00, 0.82, 0.24, 0.94], withers: 0.07 },
  // Huge dropped barrel. A dairy cow's belly hangs BELOW its brisket, which is
  // most of the silhouette and the thing no single ellipsoid could give it.
  cow:    { chest:   [-1.00, 0.35, 0.90, 0.00, 1.00],
            abdomen: [-0.40, 1.00, 1.08, -0.22, 0.94], withers: 0 },
  // Deep barrel chest, waist tucked hard — the canid's engine-and-whip build.
  wolf:   { chest:   [-1.00, 0.25, 1.12, -0.06, 1.06],
            abdomen: [-0.35, 1.00, 0.78, 0.26, 0.90], withers: 0.06 },
  // The grizzly topline: highest at the SHOULDER and sloping down to the rump.
  // Both masses used to top out level (1.06 / 0.96), which made a flat-backed
  // barrel with an isolated ball dropped on it — the hump read as a growth
  // rather than as the animal's own shape. The slope is what sells it, and the
  // hump below now only has to finish a line the torso already starts.
  bear:   { chest:   [-1.00, 0.40, 1.06, -0.05, 1.18],
            abdomen: [-0.25, 1.00, 0.98, -0.05, 0.76], withers: 0 },
  // Deep girth at the shoulder, barrel tapering to a sloping croup.
  horse:  { chest:   [-1.00, 0.35, 1.00, -0.06, 1.04],
            abdomen: [-0.25, 1.00, 0.92, -0.04, 0.88], withers: 0.11 },
  // Rounder belly and a flatter wither than a horse — part of the read.
  donkey: { chest:   [-1.00, 0.30, 0.96, -0.04, 1.00],
            abdomen: [-0.25, 1.00, 1.00, -0.12, 0.92], withers: 0.04 },
};

/** One creature's four solved limb plans plus the stride they imply. */
interface QuadrupedRig {
  fore: LegPlan;
  hind: LegPlan;
  gait: GaitPattern;
  /** Ground distance per gait cycle — bounded by limb reach, never exceeds it. */
  stride: number;
}

const RIG_CACHE = new Map<Species, QuadrupedRig>();

/**
 * Limb plans for a species. Memoized: these depend only on species constants,
 * so recomputing them for every creature every frame would be pure waste.
 */
function quadrupedRig(species: Species): QuadrupedRig {
  const cached = RIG_CACHE.get(species);
  if (cached !== undefined) return cached;

  const s = SPECIES_DEFS[species].size;
  const body = BODY_SHAPE[species as QuadrupedSpecies];
  const rig = LEG_RIG[species as QuadrupedSpecies];
  const legH = s * body.legH;
  const bodyL = s * body.bodyL;

  // Fore limbs break BACKWARD at the carpus, hind limbs FORWARD at the stifle.
  const fore = makeLegPlan(legH, -(bodyL * 0.65), legH * rig.cannon[0],
    rig.ankleSet[0], -1, rig.upperFrac[0], rig.slack);
  const hind = makeLegPlan(legH, bodyL * 0.65, legH * rig.cannon[1],
    rig.ankleSet[1], +1, rig.upperFrac[1], rig.slack);

  // The stride is whatever the SHORTER-reaching limb can manage, held just
  // inside the clamp boundary. Deriving it from the anatomy rather than
  // picking it independently is what guarantees no foot ever skates: a target
  // the limb cannot reach gets clamped, and a clamped foot slides.
  const stride = Math.min(maxStride(fore, rig.gait.duty), maxStride(hind, rig.gait.duty)) * 0.92;

  const out: QuadrupedRig = { fore, hind, gait: rig.gait, stride };
  RIG_CACHE.set(species, out);
  return out;
}

/**
 * Ground distance covered by one full gait cycle, for a species.
 *
 * Exported because the AI advances `walkPhase` by distance travelled and MUST
 * use the same number the mesh does. If the two disagree the feet skate in
 * proportion to the error, which is precisely the bug the rig removes — so
 * there is exactly one definition and both sides call it.
 */
export function animalStride(species: Species): number {
  // Humanoids derive their stride from limb reach, exactly as quadrupeds do.
  // A human-proportioned leg physically cannot cover 1.25 shoulder-heights per
  // cycle without the IK clamping, and a clamped foot slides — so the flat
  // size-proportional fallback below would reintroduce skating on the one body
  // plan the player gets closest to.
  if (isHumanoid(species)) return humanoidStride(species);
  if (!(species in BODY_SHAPE)) {
    // Non-quadruped body plans (bird, dragon, griffin, sea serpent) keep the
    // simple size-proportional stride; they either have two legs or none.
    return Math.max(0.25, SPECIES_DEFS[species].size * 1.25);
  }
  return quadrupedRig(species).stride;
}

/**
 * The gait a species walks with. Exported so tests and tools can reason about
 * footfall timing without duplicating the table.
 */
export function animalGait(species: Species): GaitPattern | null {
  if (!(species in BODY_SHAPE)) return null;
  return quadrupedRig(species).gait;
}

/**
 * How far the body sinks below rest height at this phase, in metres.
 *
 * Must be applied by the renderer to the object offset AND handed back to the
 * builder as `pose.bodyDrop`, or planted feet sink into the terrain with it.
 */
export function animalBodyDrop(
  species: Species, walkPhase: number, walkAmp: number,
): number {
  if (walkAmp <= 0 || !(species in BODY_SHAPE)) return 0;
  const rig = quadrupedRig(species);
  const beats = rig.gait === GAIT_BOUND ? 1 : 2;
  const dip = (Math.sin(walkPhase * beats + Math.PI * 0.5) - 1) * 0.5; // -1..0
  return dip * rig.fore.rootY * 0.045 * walkAmp;
}

function buildQuadruped(species: Species, pose: AnimalPose, variant: number): Part[] {
  const s = SPECIES_DEFS[species].size; // shoulder height in metres
  const bodyC  = applyVariant(BASE_COLORS[species], variant);
  const bellyC = BELLY_COLORS[species];
  const accentC = ACCENT_COLORS[species];

  const isRabbit = species === 'rabbit';
  const isHorse  = species === 'horse' || species === 'donkey';
  const isDonkey = species === 'donkey';
  const isDeer   = species === 'deer';
  const isCow    = species === 'cow';
  const isWolf   = species === 'wolf';
  const isBear   = species === 'bear';

  // Sleek short coats (deer, cow, horse, donkey) vs. long body fur (rabbit,
  // wolf, bear) — drives the body/head/leg material for this species. This
  // had wolf on FUR_SHORT and deer/cow on FUR, which is backwards from
  // RECTIFICATION_PLAN §3 and is why the cow rendered as a white sheep.
  const furMat = (isHorse || isDeer || isCow) ? MAT.FUR_SHORT : MAT.FUR;

  const body = BODY_SHAPE[species as QuadrupedSpecies];
  const legH = s * body.legH, bodyH = s * body.bodyH, bodyW = s * body.bodyW, bodyL = s * body.bodyL;
  const legR = s * body.legR;                    // leg capsule radius (hip end)
  const legGap = bodyW * body.legGapMul;          // lateral leg offset — Rule A

  const hipY   = legH;          // bottom of torso
  const bodyTop = legH + bodyH; // top of torso


  // Head yaw / pitch (optional). `headPitch` is positive = nose DOWN, which
  // is the opposite sense to `pitch()` (positive swings a below-pivot point
  // forward/-Z, i.e. nose UP for a head hanging off a neck), hence the negation
  // at each use site.
  const headTwist = pose.headYaw ?? 0;
  const headNod = pose.headPitch ?? 0;

  // Rotation pivots

  const noRots: Rot[] = [];

  // --- Torso masses: chest + abdomen (see TORSO_SHAPE) ---
  const torso = TORSO_SHAPE[species as QuadrupedSpecies];
  /** Resolve a TorsoMass row into a concrete ellipsoid in local space. */
  const ellip = (m: TorsoMass) => {
    const [z0, z1, w, y0, y1] = m;
    return {
      cz: (z0 + z1) * 0.5 * bodyL, rz: (z1 - z0) * 0.5 * bodyL,
      cy: hipY + (y0 + y1) * 0.5 * bodyH, ry: (y1 - y0) * 0.5 * bodyH,
      rx: w * bodyW,
    };
  };
  const chestE = ellip(torso.chest);
  const abdE   = ellip(torso.abdomen);

  // An ellipsoid's surface curves in from its bounding box everywhere except
  // the three axis poles, so anything anchored to the box floats: a portrait
  // pass caught a deer's tail hanging fully detached behind it, anchored at
  // z = bodyL (the rear *pole*) while sitting at hip height, where the real
  // surface has already curved forward. These solve the actual surface.
  //
  // Both now take the MAX over the two masses. Evaluating only one would put
  // the neck root inside the chest on a tuck-bellied deer, or the tail root
  // inside the barrel on a cow — reintroducing the exact detachment bug the
  // helpers exist to prevent, but only on some species.
  const surfaceOf = (
    e: { cz: number; rz: number; cy: number; ry: number; rx: number },
  ) => ({
    rearZ: (y: number): number => {
      const t = (y - e.cy) / e.ry;
      return e.cz + e.rz * Math.sqrt(Math.max(0, 1 - Math.min(1, t * t)));
    },
    top: (x: number, z: number): number => {
      const u = x / e.rx, v = (z - e.cz) / e.rz;
      const r2 = u * u + v * v;
      return e.cy + e.ry * Math.sqrt(Math.max(0, 1 - Math.min(1, r2)));
    },
  });
  const chestS = surfaceOf(chestE);
  const abdS   = surfaceOf(abdE);

  const rearZAt = (y: number): number =>
    Math.max(chestS.rearZ(y), abdS.rearZ(y)) * 0.97;
  /** Top of the torso surface at a given (x, z) — the same correction the
   *  tail needs, applied where the neck is rooted. */
  const torsoTopAt = (x: number, z: number): number =>
    Math.max(chestS.top(x, z), abdS.top(x, z));

  const parts: Part[] = [];

  // --- Body: two overlapping ellipsoids, chest and abdomen. ---
  // The chest carries more rings: it holds the shoulder and the neck root, so
  // it is where silhouette and shading are actually read.
  parts.push(makeBoxSpherePart(bodyC, noRots,
    -chestE.rx, chestE.cy - chestE.ry, chestE.cz - chestE.rz,
     chestE.rx, chestE.cy + chestE.ry, chestE.cz + chestE.rz,
    1, 9, 6, furMat));
  parts.push(makeBoxSpherePart(bodyC, noRots,
    -abdE.rx, abdE.cy - abdE.ry, abdE.cz - abdE.rz,
     abdE.rx, abdE.cy + abdE.ry, abdE.cz + abdE.rz,
    1, 8, 6, furMat));

  // --- Withers: the ridge over the shoulder blades. On a horse this is the
  // point height is measured to, and without it the neck appears to sprout
  // from a smooth barrel. ---
  if (torso.withers > 0) {
    const wz = chestE.cz + chestE.rz * 0.30;
    const wr = bodyW * 0.42;
    parts.push(makeBoxSpherePart(bodyC, noRots,
      -wr, torsoTopAt(0, wz) - bodyH * 0.18, wz - bodyL * 0.26,
       wr, torsoTopAt(0, wz) + bodyH * torso.withers, wz + bodyL * 0.24,
      0.85, 7, 5, furMat));
  }

  // --- Bear shoulder hump: the signature grizzly silhouette. ---
  // Seated on the real chest surface, not on `bodyTop` (the old bounding-box
  // lid): the chest ellipsoid's crown is below that line, so a hump anchored
  // to bodyTop hovers over the back with daylight under it.
  //
  // Moved forward from -0.25 to -0.40 bodyL — it belongs OVER the shoulder
  // blades, immediately behind the neck root, not in the middle of the back —
  // and its underside now sinks a third of the body depth into the chest so it
  // merges instead of perching. Rounded (squashY 0.90, an extra ring) because
  // a flattened dome caught the sun as a distinct facet.
  if (isBear) {
    // Long enough in z to reach forward under the neck root, so head, neck and
    // hump form one line rather than two masses with a saddle between them.
    const hz = -bodyL * 0.38;
    const hTop = torsoTopAt(0, hz);
    parts.push(makeBoxSpherePart(bodyC, noRots,
      -bodyW * 0.84, hTop - bodyH * 0.46, hz - bodyL * 0.50,
       bodyW * 0.84, hTop + s * 0.072,    hz + bodyL * 0.50,
      0.92, 7, 5, furMat));
  }

  // --- Wolf dorsal saddle: dark plate along the back. The base coat is
  // near-achromatic ([0.45,0.46,0.50], warmed below) — the literal "grey
  // blob" — so this plate is what actually carries silhouette contrast. ---
  if (isWolf) {
    // Follows the spine. As a single box spanning the whole back it floated
    // clear of the new chest/abdomen surface — a grey slab hovering above the
    // wolf — because the back is a curve and `bodyTop` is the box lid, not the
    // hide. Laid down as a run of short plates, each seated on the surface at
    // its own z, it hugs the topline whatever shape the body is.
    //
    // Widened from 0.50 to 0.72 of the half-width and dropped to three longer
    // plates: at the old width the saddle was a narrow stripe along the spine
    // that vanished from every angle except directly overhead, so the wolf went
    // right back to being a uniform grey shape. A wolf's dark saddle covers the
    // whole upper flank, and that two-tone break is what stops it reading as a
    // large grey dog.
    for (const f of [-0.36, 0, 0.36]) {
      const pz = bodyL * f;
      const py = torsoTopAt(0, pz);
      parts.push(makeBoxSpherePart(accentC, noRots,
        -bodyW * 0.72, py - bodyH * 0.24, pz - bodyL * 0.32,
         bodyW * 0.72, py + s * 0.030,    pz + bodyL * 0.32,
        0.62, 7, 4, furMat));
    }
    // Pale throat bib. A wolf's cream throat and chest is the counter-shading
    // that separates its head from its body at distance; without it the head,
    // neck and chest were one continuous grey mass.
    const bibZ = -bodyL * 0.74;
    parts.push(makeBoxSpherePart(bellyC, noRots,
      -bodyW * 0.62, hipY + bodyH * 0.26, bibZ - bodyL * 0.22,
       bodyW * 0.62, hipY + bodyH * 0.98, bibZ + bodyL * 0.24,
      0.85, 7, 4, furMat));
  }

  // --- Neck + head assembly ---
  // Horse/donkey get a dedicated build: forward-leaning neck capsule with a
  // mane crest, a squashed-sphere skull with a long capsule muzzle, and
  // tall ears for the donkey.
  if (isHorse) {
    // Forward lean from vertical. Was 0.38 rad (22 degrees), which is close
    // enough to straight up that the neck read as a periscope with a muzzle
    // on top — the animal looked like a llama, not a horse. A standing
    // equine carries its neck at roughly 45-55 degrees; the donkey a little
    // lower still, which is part of why a donkey reads as a donkey.
    const lean  = isDonkey ? 0.86 : 0.74;         // forward lean (radians)
    const neckW = s * 0.15;
    const neckD = s * 0.22;
    const nH    = isDonkey ? s * 0.34 : s * 0.42; // neck length along its axis
    const zc    = -(bodyL * 0.62);                // neck base centre
    const neckRot: Rot[] = [pitch(-lean, bodyTop, zc)];
    // Neck: capsule rooted just below the torso top so the joint never shows.
    parts.push(makeBoxCapsulePart(bodyC, neckRot,
      -neckW, bodyTop - s * 0.08, zc - neckD * 0.5,
       neckW, bodyTop + nH,       zc + neckD * 0.5, 6, furMat));
    // Mane crest along the back edge of the neck — longer, coarser hair than
    // the sleek body coat, so it deliberately uses FUR (not furMat/FUR_SHORT)
    // even on horse/donkey.
    //
    // Was a 7 cm-wide beveled blade half a metre tall standing on the neck's
    // trailing edge: side-on it presented its full face and read as a plank
    // strapped to the horse. A rounded crest that is WIDER than it is deep sits
    // on the neck like hair instead of like a fin.
    parts.push(makeBoxSpherePart(accentC, neckRot,
      -s * 0.050, bodyTop - s * 0.02, zc + neckD * 0.30,
       s * 0.050, bodyTop + nH + s * 0.06, zc + neckD * 0.30 + s * 0.15,
      1, 7, 5, MAT.FUR));
    // Neck top after the lean — head hangs off this point
    const nTopY = bodyTop + nH * Math.cos(lean);
    const nTopZ = zc - nH * Math.sin(lean);
    const hRots: Rot[] = [];
    if (headNod !== 0) hRots.push(pitch(-headNod, nTopY, nTopZ));
    if (headTwist !== 0) hRots.push(twistY(headTwist, 0, nTopZ));
    // Skull: squashed sphere.
    parts.push(makeBoxSpherePart(bodyC, hRots,
      -s * 0.11, nTopY - s * 0.10, nTopZ - s * 0.16,
       s * 0.11, nTopY + s * 0.14, nTopZ + s * 0.10, 0.92, 8, 6, furMat));
    // Muzzle: long, lower, forward capsule — the defining horse profile.
    // In `bellyC` it came out as a white sock on the end of the face; a horse's
    // muzzle is a shade DARKER than its coat, not lighter, with a dark nose.
    parts.push(makeBoxCapsulePart(tint(bodyC, -0.07, -0.06, -0.04), hRots,
      -s * 0.078, nTopY - s * 0.08, nTopZ - s * 0.40,
       s * 0.078, nTopY + s * 0.05, nTopZ - s * 0.14, 6, MAT.SKIN));
    parts.push(makeBoxSpherePart(accentC, hRots,
      -s * 0.055, nTopY - s * 0.065, nTopZ - s * 0.42,
       s * 0.055, nTopY + s * 0.020, nTopZ - s * 0.34, 1, 6, 4, MAT.LEATHER));
    // Ears (donkey: tall; horse: small and alert). Blades splayed outward,
    // not the pair of parallel boxes they were: a donkey's ears in particular
    // are held wide and are its single most recognisable feature, and two
    // rectangles standing dead vertical threw that away.
    const eH = isDonkey ? s * 0.30 : s * 0.16;
    const eW = s * 0.045;
    const eX = s * 0.075;
    const eY = nTopY + s * 0.12;
    for (const side of [-1, 1] as const) {
      parts.push(makeEarPart(accentC, hRots, side,
        side * eX, eY, nTopZ, eW, eH, s * 0.022,
        isDonkey ? 0.34 : 0.46, -0.10, MAT.SKIN));
    }
    // Eyes: set on the sides of the skull, well forward. The horse branch had
    // none at all, so a horse or donkey seen head-on was a blank sock.
    parts.push(...makeEyeParts(EYE_COLOR, hRots,
      s * 0.088, nTopY + s * 0.035, nTopZ - s * 0.14, s * 0.024));

    // --- Donkey dorsal stripe + shoulder cross stripe: the donkey's
    // signature marking (§5.1) — the one thing that reads "donkey" rather
    // than "small horse" at a glance. ---
    if (isDonkey) {
      parts.push(makePart(accentC, noRots,
        -s * 0.025, bodyTop - s * 0.01, -bodyL * 0.50,
         s * 0.025, bodyTop + s * 0.05,  bodyL * 0.50, MAT.FUR_SHORT));
      parts.push(makePart(accentC, noRots,
        -bodyW * 0.60, bodyTop - bodyH * 0.30, -bodyL * 0.08,
         bodyW * 0.60, bodyTop - bodyH * 0.18,  bodyL * 0.06, MAT.FUR_SHORT));
    }
  } else {
    // --- Neck: tapered capsule (taperedCapsule, §7) from the torso front
    // up to the skull base — thick at the shoulder, thin at the skull.
    // Every non-horse quadruped previously had NO neck geometry: the head
    // just floated at bodyTop+neckH with nothing connecting it (problem
    // #1). Built vertical in local space then pitched forward, same
    // pattern as the horse/donkey neck above. ---
    const neckShape = NECK_SHAPE[species as 'rabbit' | 'deer' | 'cow' | 'wolf' | 'bear'];
    const neckBaseZ = bodyL * neckShape.rootZ;
    // Root on the FRONT of the chest at the species' own carriage height,
    // clamped to stay inside the chest surface so the seam is buried.
    //
    // Every neck used to root at a fixed z = -0.60·bodyL on the torso's top
    // surface — i.e. straight up out of the shoulder blades. That is roughly
    // right for a deer and completely wrong for a wolf, which carries its head
    // level with its back: the neck emerged above the spine, the head sat on
    // the shoulders, and the animal read as one lump with a face on the end.
    const neckBaseY = Math.min(
      hipY + bodyH * neckShape.rootY,
      torsoTopAt(0, neckBaseZ) - s * 0.02);
    const neckLen = s * neckShape.len;
    const neckLean = neckShape.lean; // radians from vertical
    const neckR = s * neckShape.r;
    const neckRot: Rot[] = [pitch(-neckLean, neckBaseY, neckBaseZ)];
    {
      const nv: number[] = [];
      taperedCapsule(nv,
        0, neckBaseY, neckBaseZ,
        0, neckBaseY + neckLen, neckBaseZ,
        neckR, neckR * 0.72, 6);
      parts.push({ verts: nv, color: bodyC, material: furMat, rots: neckRot });
    }
    // Head hangs off the rotated neck tip (same pattern as the horse
    // branch's nTopY/nTopZ above).
    const headCY = neckBaseY + neckLen * Math.cos(neckLean);
    const headCZ = neckBaseZ - neckLen * Math.sin(neckLean);

    const headShape = HEAD_SHAPE[species as 'rabbit' | 'deer' | 'cow' | 'wolf' | 'bear'];
    const headW = s * headShape.w, headH = s * headShape.h, headD = s * headShape.d;
    // Head tilt. The bear is the only species that needs one, and it needs it
    // badly: with the muzzle held level the head/neck assembly is a horizontal
    // peg on the front of a humped body, which is a camel, and no amount of
    // reproportioning the parts fixed that as long as the axis stayed flat. A
    // brown bear carries its muzzle angled DOWN off a dished forehead — that
    // tilt is most of the difference between a bear's profile and a dog's.
    const headTilt = (isBear ? -0.34 : 0) - headNod;
    const headRots: Rot[] = [];
    if (headTilt !== 0) headRots.push(pitch(headTilt, headCY, headCZ));
    if (headTwist !== 0) headRots.push(twistY(headTwist, 0, headCZ));
    const noseZ = headCZ - headD; // front of the muzzle (faces -Z)

    // --- Head (generic): squashed sphere. headD now exceeds headW (was
    // reversed — problem #2, every herbivore head was a pancake rotated
    // 90° from correct). ---
    parts.push(makeBoxSpherePart(bodyC, headRots,
      -headW, headCY - headH * 0.5, noseZ,
       headW, headCY + headH * 0.5, headCZ, 0.92, 8, 6, furMat));

    // --- Ears. Blades of a flattened ellipsoid, splayed outward and raked
    // back (`makeEarPart`), except the wolf's triangular cones. ---
    //
    // These were axis-aligned boxes standing straight up on every species but
    // the wolf, and they were the loudest wrong note on the roster: from the
    // front a cow's read as two dark rectangles pasted on its skull, from the
    // side a rabbit's collapsed to a single black bar. The fix that matters is
    // not the shape, it is the ANGLE. A cow's ears stick out sideways, almost
    // horizontal. A bear's are round buttons set wide on the crown. A deer's
    // are big scoops facing outward. Straight up is wrong for all of them, and
    // ear carriage is legible from much further away than ear outline.
    const ear = EAR_SHAPE[species as 'rabbit' | 'deer' | 'cow' | 'wolf' | 'bear'];
    const earW = s * ear.w, earH = s * ear.h, earD = s * ear.d;
    const earX = headW * ear.x;
    const earBackZ = headCZ - headD * ear.z; // toward the skull's back, near the neck
    // The skull is an ellipsoid inscribed in its box (makeBoxSpherePart), so
    // its crown at the ear's offset position sits well below the box top —
    // the same bounding-box-vs-ellipsoid trap that left the legs and tails
    // hanging in air. Seat the ears on the actual skull surface instead, and
    // sink them slightly so the base of the ear disappears into the fur.
    const headSemiY = headH * 0.5 * 0.92; // squashY passed to the head sphere
    const headCZc = headCZ - headD * 0.5; // head ellipsoid centre, Z
    const skullTopAt = (x: number, z: number): number => {
      const u = x / headW, v = (z - headCZc) / (headD * 0.5);
      const r2 = u * u + v * v;
      return headCY + headSemiY * Math.sqrt(Math.max(0, 1 - Math.min(1, r2)));
    };
    const earTopY = skullTopAt(earX, earBackZ) - earH * 0.16;
    for (const side of [-1, 1] as const) {
      const ex = side * earX;
      // A rabbit's ear backs are its COAT, not the near-black `accentC` the
      // other species use for ear/tail tips: cast in accent they read as two
      // black horns on a cream animal.
      const earC: Color3 = isRabbit ? tint(bodyC, -0.06, -0.07, -0.06) : accentC;
      if (isWolf) {
        // A wolf's ears are stiff triangles, so they stay cones — but they now
        // splay outward with the rest, instead of standing parallel like a pair
        // of chess pieces.
        parts.push(makeBoxConePart(accentC,
          [rollZ(-side * ear.splay, ex, earTopY),
           pitch(ear.rake, earTopY, earBackZ), ...headRots],
          ex - earW, earTopY, earBackZ - earD,
          ex + earW, earTopY + earH, earBackZ + earD, 6, MAT.SKIN));
      } else {
        parts.push(makeEarPart(earC, headRots, side,
          ex, earTopY, earBackZ, earW, earH, earD,
          ear.splay, ear.rake, MAT.SKIN));
      }
    }
    // Rabbit inner ear: a paler blade sitting a hair proud of the front face.
    // The rabbit's ears ARE the rabbit, and a single flat colour wasted them.
    if (isRabbit) {
      for (const side of [-1, 1] as const) {
        parts.push(makeEarPart(tint(bellyC, -0.02, -0.16, -0.14), headRots, side,
          side * earX, earTopY + earH * 0.10, earBackZ - earD * 0.55,
          earW * 0.52, earH * 0.76, earD * 0.30,
          ear.splay, ear.rake, MAT.SKIN));
      }
    }

    // --- Eyes. Two small dark spheres set into the sides of the skull. ---
    // Every quadruped was blind. On a wool doll that is not a small omission:
    // a face with no eyes reads as a sack with a nose on it, which is most of
    // why the herbivores were interchangeable at conversational distance.
    {
      const eyeR = s * (isRabbit ? 0.030 : isBear ? 0.024 : 0.022);
      parts.push(...makeEyeParts(EYE_COLOR, headRots,
        headW * 0.80, headCY + headH * 0.14, headCZc - headD * 0.26, eyeR));
    }

    // --- Deer antlers (3 tines each side: main beam + 2 branches, up from
    // 2) + a dark nose sphere (deer had no muzzle geometry at all). ---
    if (isDeer) {
      // Bone, not the coat's dark brown: cast in `accentC` the rack read as a
      // dark smudge against the head from any distance, which is the opposite
      // of what a rack is for.
      const antlerC: Color3 = [0.70, 0.63, 0.49];
      const antW = s * 0.046;
      const antH = s * 0.34;
      const antBranchH = s * 0.15;
      // antX was headW * 0.6, which put the two beams 15 cm apart on a deer —
      // close enough that from any side-on angle they overlapped into a single
      // spike. Set them at the skull's full width and splay them outward and
      // back, which is both correct and what makes a rack read as a rack.
      const antX = headW * 0.95;
      const antY0 = earTopY + earH * 0.2;
      const antZ  = earBackZ - earD * 0.5;
      const antSplay = 0.40; // outward roll, radians
      const antSweep = 0.30; // backward pitch, radians
      for (const side of [-1, 1] as const) {
        const x0 = side < 0 ? -antX - antW : antX;
        const x1 = side < 0 ? -antX : antX + antW;
        const antRots: Rot[] = [
          rollZ(side < 0 ? antSplay : -antSplay, side * antX, antY0),
          pitch(-antSweep, antY0, antZ),
          ...headRots,
        ];
        parts.push(makeBoxConePart(antlerC, antRots,
          x0, antY0, antZ - antW, x1, antY0 + antH, antZ + antW, 6, MAT.HORN));
        const bx0 = side < 0 ? -antX - antW * 3 : antX;
        const bx1 = side < 0 ? -antX : antX + antW * 3;
        parts.push(makeBoxConePart(antlerC, antRots,
          bx0, antY0 + antH * 0.35, antZ - antW,
          bx1, antY0 + antH * 0.35 + antBranchH, antZ + antW, 6, MAT.HORN));
        parts.push(makeBoxConePart(antlerC, antRots,
          bx0, antY0 + antH * 0.66, antZ - antW,
          bx1, antY0 + antH * 0.66 + antBranchH * 0.8, antZ + antW, 6, MAT.HORN));
      }
      parts.push(makeBoxSpherePart(accentC, headRots,
        -s * 0.035, headCY - headH * 0.10, noseZ - s * 0.02,
         s * 0.035, headCY + headH * 0.05, noseZ + s * 0.05, 1, 6, 4, MAT.LEATHER));
    }

    // --- Muzzle: tapered snout protruding from the head front. ---
    //
    // Only wolf and bear had one; cow and rabbit got a bare ellipsoid for a
    // head, which is why the cow read as a blob on a stalk. A muzzle is the
    // single most identifying feature of a mammal's head, and the SHAPE of the
    // taper is what separates the species: a wolf comes to a point, a bear is
    // broad and blunt, and a cow barely tapers at all — its muzzle is famously
    // almost as wide as its skull, ending in a big flat nose pad.
    if (isWolf || isBear || isCow || isRabbit) {
      const snR0 = headW * (isCow ? 0.74 : isRabbit ? 0.50 : isBear ? 0.64
        : isWolf ? 0.66 : 0.55);
      // Was 0.28 of headW over s*0.26 of length: a pale needle projecting a
      // quarter of a metre off the face, which read as a stork's bill rather
      // than a wolf's muzzle. A canid muzzle is a wedge, not a spike.
      const snR1 = isWolf ? headW * 0.44
        : isBear ? headW * 0.54  // barely tapers either — a bear's muzzle is a
        : isCow ? headW * 0.66   // block, and the taper is what made it a snout
        : headW * 0.34;          // rabbit
      // The bear's snout was s*0.20 — 36 cm of muzzle on a 1.8 m animal, longer
      // than its whole skull is now. Stacked on the old long head and a
      // near-horizontal neck it produced the anteater tube the user reacted to.
      // A bear's muzzle is short, deep and square.
      const snD = isWolf ? s * 0.175 : isBear ? s * 0.075
        : isCow ? s * 0.055 : s * 0.045;
      const snY = headCY - headH * (isCow ? 0.06 : isBear ? 0.14 : 0.10);
      // The cow's `bellyC` is its dark piebald-patch brown, chosen for contrast
      // against a near-white hide — reusing it for the muzzle put a chocolate
      // sausage on the front of the face. A muzzle is a muted, slightly duskier
      // version of the coat, so derive it rather than borrowing a marking.
      // The bear needs the opposite treatment: its `bellyC` is only a shade off
      // the coat, so a short blunt muzzle in it vanished into the skull and the
      // head came out as a featureless brown ball with an eye on it. Brown
      // bears carry a distinctly paler tan mask around the muzzle.
      // The wolf's `bellyC` is a near-white grey meant for the throat; on the
      // muzzle it made the front third of the head glow against a mid-grey
      // coat. A wolf's muzzle is only a step lighter than its mask.
      const muzzleC: Color3 = isCow ? tint(bodyC, -0.10, -0.16, -0.18)
        : isBear ? tint(bodyC, 0.10, 0.09, 0.07)
        : isWolf ? tint(bodyC, 0.13, 0.13, 0.13) : bellyC;
      const sv: number[] = [];
      taperedCapsule(sv, 0, snY, noseZ + headD * 0.15, 0, snY, noseZ - snD, snR0, snR1, 6);
      parts.push({ verts: sv, color: muzzleC, material: MAT.SKIN, rots: headRots });

      // Lower jaw, hinged at the skull. Only emitted when the mouth is
      // actually open: closed, it would sit exactly inside the muzzle it was
      // cut from, so appearing at the threshold is invisible and every idle
      // creature keeps its previous vertex count.
      //
      // Until now `jawOpen` reached only the dragon and the wyvern, so a wolf
      // or a bear biting animated a jaw that did not exist — the head simply
      // lunged with its mouth shut.
      const jawOpen = pose.jawOpen ?? 0;
      if (jawOpen > 0.002 && (isWolf || isBear)) {
        const hingeY = snY - snR0 * 0.30;
        const hingeZ = noseZ + headD * 0.10;
        const jv: number[] = [];
        taperedCapsule(jv,
          0, hingeY, hingeZ,
          0, hingeY, noseZ - snD * 0.92,
          snR0 * 0.62, snR1 * 0.70, 5);
        // Positive pitch swings a forward-pointing tip DOWN about the hinge.
        parts.push({
          verts: jv, color: tint(muzzleC, -0.10, -0.09, -0.08),
          material: MAT.SKIN,
          rots: [pitch(jawOpen * 0.55, hingeY, hingeZ), ...headRots],
        });
      }

      // Brow ridge. A bear's forehead rises in a step above the muzzle root
      // (the "dished" profile); without it the skull and the snout are one
      // smooth cone and the head reads as a dog's.
      if (isBear) {
        parts.push(makeBoxSpherePart(bodyC, headRots,
          -headW * 0.86, snY + headH * 0.06, noseZ - s * 0.01,
           headW * 0.86, snY + headH * 0.46, noseZ + headD * 0.55,
          0.90, 7, 5, furMat));
      }
      // Nose pad — dark, flat, on the end of the muzzle. Kept small: sized off
      // the muzzle tip it became the largest feature on the animal.
      const npR = snR1 * (isCow ? 0.46 : 0.40);
      parts.push(makeBoxSpherePart(accentC, headRots,
        -npR, snY - npR * 0.72, noseZ - snD - npR * 0.10,
         npR, snY + npR * 0.72, noseZ - snD + npR * 0.55,
        1, 6, 4, MAT.LEATHER));
    }

    // --- Cow: horn nubs swept sideways (not up — "the cow's entire
    // identity" per §5.1), 2 piebald patches, and an udder. ---
    if (isCow) {
      const hornW = s * 0.045;
      const hornH = s * 0.16;
      const hornX = headW * 0.62;
      const hornY0 = headCY + headH * 0.30;
      const hornZ  = headCZ - headD * 0.42;
      // Was 0.85 rad — 49 degrees off vertical, which still reads as "horns
      // pointing up" and let them be mistaken for a goat's. A dairy cow's horn
      // buds come out of the poll almost horizontally before curving.
      const sweep = 1.24; // rad off vertical, toward horizontal
      parts.push(makeBoxConePart(accentC,
        [rollZ(sweep, -hornX, hornY0), ...headRots],
        -hornX - hornW, hornY0, hornZ - hornW,
        -hornX,         hornY0 + hornH, hornZ + hornW, 6, MAT.HORN));
      parts.push(makeBoxConePart(accentC,
        [rollZ(-sweep, hornX, hornY0), ...headRots],
         hornX,         hornY0, hornZ - hornW,
         hornX + hornW, hornY0 + hornH, hornZ + hornW, 6, MAT.HORN));

      // Piebald patches. These were boxes fitted to the torso's *bounding
      // box*, which put them almost entirely inside the inscribed ellipsoid —
      // they cleared the real hide by about 4 mm and the cow rendered plain
      // white. Mount each one centred on the actual torso surface instead, so
      // half the blob stands proud and reads as a patch of hide.
      // Each patch names the mass it sits on. The torso is two ellipsoids now
      // (deep brisket + dropped barrel), so a single shared parameterisation
      // would float the shoulder patches off the chest and bury the flank ones
      // inside the belly — the same bounding-box-vs-surface trap, one level up.
      type Mass = typeof chestE;
      const massSurf = (
        e: Mass, theta: number, phi: number,
      ): [number, number, number] => [
        e.rx * Math.sin(theta) * Math.cos(phi),
        e.cy + e.ry * Math.cos(theta),
        e.cz + e.rz * Math.sin(theta) * Math.sin(phi),
      ];
      //
      // SECOND PASS: the patches were correctly mounted and still invisible.
      // Three caps of radius 0.30-0.46 bodyW, sunk 15% and in a mid-brown, on a
      // hide of [0.88 0.85 0.80] — at gameplay distance the cow rendered white
      // and read as a sheep, which is exactly what the user reported. Markings
      // are most of a cow's identity, so they get treated as primary geometry:
      // roughly twice the radius, five of them wrapping the whole barrel,
      // sunk only 8% so the cap is broad rather than a dome, and the patch
      // colour taken much darker (see BELLY_COLORS.cow) for real contrast.
      const patches: [mass: Mass, theta: number, phi: number, r: number][] = [
        [chestE, 0.62, 2.40, 0.86], // left shoulder, riding over the withers
        [chestE, 1.34, 5.60, 0.60], // right side of the brisket
        [abdE,   0.90, 5.05, 0.88], // right flank, the big one
        [abdE,   0.46, 1.20, 0.72], // left rump, crossing the spine
        [abdE,   1.44, 2.30, 0.50], // low on the left belly
      ];
      for (const [mass, theta, phi, rMul] of patches) {
        const [sx, sy, sz] = massSurf(mass, theta, phi);
        // Sink the blob toward its mass's centre so only a shallow cap shows.
        // Centred exactly on the surface it bulges like a growth; a cow's
        // markings are flat against the hide.
        const sink = 0.08;
        const px = sx * (1 - sink);
        const py = mass.cy + (sy - mass.cy) * (1 - sink);
        const pz = mass.cz + (sz - mass.cz) * (1 - sink);
        const pr = bodyW * rMul;
        // 7x4 rather than 8x5: a patch is a shallow cap of a sphere, mostly
        // buried, and the cow is the heaviest species on the roster.
        parts.push(makeBoxSpherePart(bellyC, noRots,
          px - pr, py - pr * 0.62, pz - pr * 1.05,
          px + pr, py + pr * 0.62, pz + pr * 1.05, 0.85, 7, 4, furMat));
      }
      // Dark poll-and-cheek patch with the ears growing out of it. A Friesian's
      // head markings are as recognisable as the body ones and they stop the
      // head reading as a separate white object stuck on the front.
      parts.push(makeBoxSpherePart(bellyC, headRots,
        -headW * 1.02, headCY - headH * 0.10, headCZ - headD * 0.62,
         headW * 1.02, headCY + headH * 0.62, headCZ + headD * 0.10,
        0.92, 7, 5, furMat));
      // Udder — pink, not the piebald brown it used to borrow.
      parts.push(makeBoxSpherePart(tint(bodyC, -0.02, -0.22, -0.24), noRots,
        -bodyW * 0.30, hipY - s * 0.06, bodyL * 0.28,
         bodyW * 0.30, hipY + s * 0.10, bodyL * 0.66, 1, 6, 4, MAT.SKIN));
    }
  }

  // --- Legs (4): three-segment folding limbs on a planted-foot rig. ---
  //
  // Each limb is upper + lower + cannon, with the foot driven along a gait
  // trajectory and the joints solved by two-bone IK (../anim/gait). This
  // replaces a single rigid capsule pitched from the hip by sin(walkPhase),
  // which had no knee and let the foot skate and sink through the terrain —
  // between them, most of why a moving animal read as derpy.
  //
  // Fore and hind limbs are deliberately NOT mirror images: the foreleg's
  // carpus breaks backward and the hind leg's stifle breaks forward over a
  // set-back hock. Getting that backwards is the classic tell of a
  // programmer-authored quadruped, so it is encoded once in LEG_RIG.
  const rig = quadrupedRig(species);
  const legFZ = rig.fore.rootZ; // front leg longitudinal centre
  const legBZ = rig.hind.rootZ; // back leg longitudinal centre

  const hoofH = isHorse ? s * 0.07 : 0;
  // Feet are solved in body space, so a body that sinks takes its planted
  // feet with it unless the targets rise by the same amount.
  const footRise = -(pose.bodyDrop ?? 0);
  const stride = rig.stride * pose.walkAmp;
  const lift = rig.fore.rootY * rig.gait.lift * pose.walkAmp;

  const legDefs: [x: number, plan: LegPlan, phaseOff: number][] = [
    [-legGap, rig.fore, rig.gait.offsets[0]], // FL
    [ legGap, rig.fore, rig.gait.offsets[1]], // FR
    [-legGap, rig.hind, rig.gait.offsets[2]], // BL
    [ legGap, rig.hind, rig.gait.offsets[3]], // BR
  ];

  // The torso is an ellipsoid inscribed in its box, but Rule A deliberately
  // pushes the leg roots out to ~0.85-0.92 of the body half-width and 0.65 of
  // its half-length. Evaluate the ellipsoid there and it is *outside* the
  // surface for most species (deer: u^2+v^2 = 1.27), so a leg rooted at hipY
  // meets nothing at all — the bear's legs hung 35 cm clear of its belly and
  // the whole animal read as a floating blob with sticks under it.
  //
  // Two fixes, both of which real anatomy already uses: bury the top of the
  // limb inside the body rather than dangling it, and cover the join with a
  // shoulder/haunch mass. The muscle over the limb root is what actually makes
  // a quadruped read as one connected animal.
  const bury = bodyH * 0.42;

  // Clip-driven forelimb reach, added to whatever the gait is doing.
  //
  // Stride amplitude comes from measured speed, so it is exactly ZERO when a
  // creature plants itself to strike — which is when a bear's swipe or a
  // horse's rear needs its forelegs most. Nothing else can move a foreleg on a
  // stationary animal.
  const foreSwing = pose.foreSwing ?? 0;
  for (const [lx, plan, phaseOff] of legDefs) {
    const isFore = plan === rig.fore;
    const foot = footTarget(
      pose.walkPhase + phaseOff * Math.PI * 2,
      stride, lift, rig.gait.duty);
    foot.y += footRise;
    const sol = solveLeg(plan, foot);
    // Applied at the shoulder so the whole limb swings as one, rather than
    // re-solving the IK to an unreachable target and having it clamp.
    if (isFore && foreSwing !== 0) sol.upper += foreSwing;

    const lz = plan.rootZ;
    const hipRot  = pitch(sol.upper, plan.rootY, lz);
    const kneeRot = pitch(sol.lower, sol.kneeY, sol.kneeZ);
    const anklRot = pitch(sol.cannon, sol.ankleY, sol.ankleZ);
    const upperRots: Rot[] = [hipRot];
    const lowerRots: Rot[] = [kneeRot, hipRot];
    const cannonRots: Rot[] = [anklRot, kneeRot, hipRot];

    const kneeY = plan.rootY - plan.l1;
    const ankleY = kneeY - plan.l2;
    const toeY = ankleY - plan.cannon;

    // Taper down the limb: heaviest at the shoulder/haunch, finest at the
    // cannon — the same profile every running animal has.
    const rUp = legR * 1.18, rKnee = legR * 0.88;
    const rAnk = legR * 0.70, rToe = legR * 0.58;

    // 5 sides, not 6. The twelve leg capsules are 46% of a quadruped's whole
    // vertex count, so they are the only place where a segment step is worth
    // real money: it returns 432 verts per animal, which is more than this
    // pass's ears, eyes, claws and markings cost put together. A limb is a thin
    // tapered tube seen at gameplay distance and the facet is not visible on
    // it; the head and torso keep their ring counts precisely because they are
    // large, curved and looked at.
    const seg = (
      y0: number, y1: number, r0: number, r1: number, rots: Rot[],
    ): void => {
      const v: number[] = [];
      taperedCapsule(v, lx, y0, lz, lx, y1, lz, r0, r1, 5);
      parts.push({ verts: v, color: bodyC, material: furMat, rots });
    };

    seg(kneeY, plan.rootY + bury, rKnee, rUp, upperRots);
    seg(ankleY, kneeY, rAnk, rKnee, lowerRots);
    // Inset the cannon's axis by its own radius so the hemispherical end cap
    // lands ON the contact point rather than a radius below it (the same
    // reasoning as insetAxis — a capsule extends a full radius past its axis).
    seg(toeY + rToe, ankleY, rToe, rAnk, cannonRots);

    // Foot. Two things have to be right or the limb betrays itself:
    //
    // 1. The sole sits AT the solved contact point and the geometry is built
    //    upward from it. Hanging the hoof below the contact point instead
    //    buries it in the terrain by its own height at every step — the IK
    //    puts the toe exactly on the ground, so anything below the toe is
    //    underground.
    // 2. The chain angle is absolute, so cancelling the cannon's accumulated
    //    rotation is what keeps the sole flat instead of tilting with the
    //    pastern. A hoof pointing 30 degrees off the ground is one of the
    //    loudest tells that a leg is faked.
    const footFlat = pitch(
      -(sol.upper + sol.lower + sol.cannon), toeY, lz);
    const footRots: Rot[] = [footFlat, ...cannonRots];
    if (isHorse) {
      const hr = legR * 1.25;
      parts.push(makePart(accentC, footRots,
        lx - hr, toeY, lz - hr * 1.15,
        lx + hr, toeY + hoofH, lz + hr * 0.85, MAT.HORN));
    } else {
      // Paw: a flattened sphere reads as a foot without costing a separate toe
      // rig, and gives the limb somewhere to end. Bear paws are broad (it is a
      // plantigrade animal walking on its soles); wolf/bear get the dark accent.
      const pr = legR * (isBear ? 1.70 : 1.20);
      parts.push(makeBoxSpherePart(isWolf || isBear ? accentC : bodyC, footRots,
        lx - pr, toeY, lz - pr * 1.30,
        lx + pr, toeY + pr * 0.92, lz + pr * 0.80,
        0.85, 5, 3, furMat));
      // Bear front claws. A brown bear's forefoot claws are longer than its
      // toes and are the one detail that says "bear" and not "big dog" even
      // from behind. Three cones per forefoot, angled forward and down, in
      // pale horn against the dark paw. 108 verts for the pair of feet.
      if (isBear && isFore) {
        const cw = pr * 0.26;
        for (const t of [-1, 0, 1] as const) {
          parts.push(makeBoxConePart(tint(bodyC, 0.34, 0.32, 0.28),
            [pitch(-1.32, toeY + pr * 0.18, lz - pr * 1.15), ...footRots],
            lx + t * pr * 0.52 - cw, toeY + pr * 0.18, lz - pr * 1.15 - cw,
            lx + t * pr * 0.52 + cw, toeY + pr * 0.18 + pr * 0.72,
            lz - pr * 1.15 + cw, 5, MAT.HORN));
        }
      }
    }
  }

  // --- Shoulder and haunch masses: the muscle that bridges torso to leg.
  // Rabbit's rear pair is exaggerated ("the powerful rear IS the rabbit
  // silhouette", §5.1); every other species gets an anatomically ordinary
  // pair front and back, with the haunches larger than the shoulders. ---
  {
    const hauR = isRabbit ? s * 0.14 : Math.min(bodyW * 0.62, bodyH * 0.52);
    const shoR = isRabbit ? s * 0.10 : hauR * 0.82;
    // Pull the mass inboard of the leg so it spans the gap rather than
    // sitting on the leg like a bead.
    const inboard = 0.62;
    for (const side of [-1, 1] as const) {
      // 6x4 rather than the 8x5 used for the torso: most of each mass is
      // buried inside the body, and the exposed cap is a smooth bulge where
      // extra rings buy nothing visible.
      // Haunch (rear).
      parts.push(makeBoxSpherePart(bodyC, noRots,
        side * legGap * inboard - hauR, hipY - s * 0.02, legBZ - hauR * 0.85,
        side * legGap * inboard + hauR, hipY + hauR * 1.55, legBZ + hauR * 1.05,
        0.85, 6, 4, furMat));
      // Shoulder (front).
      parts.push(makeBoxSpherePart(bodyC, noRots,
        side * legGap * inboard - shoR, hipY - s * 0.01, legFZ - shoR * 1.05,
        side * legGap * inboard + shoR, hipY + shoR * 1.65, legFZ + shoR * 0.85,
        0.85, 6, 4, furMat));
    }
  }

  // --- Tail --- (horse/donkey and wolf tails are longer/coarser hair than
  // their sleek FUR_SHORT body coat, so they deliberately use MAT.FUR;
  // bear/rabbit/deer/cow tails just follow the body's furMat.)
  //
  // `tailSway` is a clip-driven side-to-side swing on top of whatever the tail
  // does naturally, pivoting at the rump. Without it a tail is dead the moment
  // the animal stops walking, and an attack has no counter-swing to sell its
  // weight. Shared by every tail variant below so none of them can forget it.
  const tailWag = pose.tailSway ?? 0;
  const tailRots: Rot[] = tailWag !== 0
    ? [twistY(tailWag, 0, rearZAt(hipY + bodyH * 0.5))] : noRots;
  if (isHorse) {
    // Hanging tail: drops well below the hip line. Rooted at the rump surface
    // for its upper end, which is the part that has to look sewn on.
    // Thickened: at 0.05 s across it was a wire, and a horse's tail is one of
    // the few parts of it that is visibly a mass of hair.
    const rootZ = rearZAt(hipY + bodyH * 0.80);
    parts.push(makeBoxCapsulePart(accentC, tailRots,
      -s * 0.078, hipY - s * 0.26, rootZ - s * 0.02,
       s * 0.078, hipY + bodyH * 0.80, rootZ + s * 0.14, 6, MAT.FUR));
  } else if (isWolf) {
    // Brush tail, carried LOW.
    //
    // This was pitched -0.45, which lifts the tip: the wolf ended up with a
    // straight horizontal rod sticking out of its rump like a broom handle,
    // which is what the user saw. A relaxed wolf's tail hangs down and back at
    // roughly 25-30 degrees below the line of the back, and it is thick — the
    // brush is nearly as deep as the animal's own body at the root. Two
    // segments with a kink between them so it is a curve, not a stick.
    const tailY = hipY + bodyH * 0.34;
    const rootZ = rearZAt(tailY);
    const drop = pitch(0.34, tailY, rootZ);
    const seg1: number[] = [];
    taperedCapsule(seg1,
      0, tailY, rootZ,
      0, tailY, rootZ + s * 0.30,
      s * 0.058, s * 0.104, 6);
    parts.push({ verts: seg1, color: accentC, material: MAT.FUR, rots: [drop] });
    const seg2: number[] = [];
    taperedCapsule(seg2,
      0, tailY, rootZ + s * 0.28,
      0, tailY, rootZ + s * 0.60,
      s * 0.104, s * 0.040, 6);
    parts.push({ verts: seg2, color: accentC, material: MAT.FUR,
      rots: [pitch(0.16, tailY, rootZ + s * 0.28), drop] });
  } else if (isBear) {
    // Stub tail
    const tailY = hipY + bodyH * 0.55;
    const rootZ = rearZAt(tailY);
    parts.push(makePart(accentC, noRots,
      -s * 0.05, tailY, rootZ,
       s * 0.05, tailY + s * 0.08, rootZ + s * 0.06, furMat));
  } else if (isCow) {
    // Long tail (0.5s) hanging well below the hip with a dark tuft at the
    // tip — distinguishes the silhouette from the deer's flag tail (§5.1).
    const tailLen = s * 0.50;
    const rootY = hipY + bodyH * 0.55;
    const rootZ = rearZAt(rootY);
    const tipY = rootY - tailLen;
    const tv: number[] = [];
    taperedCapsule(tv,
      0, rootY, rootZ,
      0, tipY, rootZ + s * 0.06,
      s * 0.045, s * 0.028, 6);
    parts.push({ verts: tv, color: bellyC, material: furMat, rots: noRots });
    parts.push(makeBoxSpherePart(accentC, noRots,
      -s * 0.045, tipY - s * 0.07, rootZ + s * 0.02,
       s * 0.045, tipY + s * 0.02, rootZ + s * 0.11, 1, 6, 4, furMat));
  } else if (isRabbit) {
    // Round sphere puff, not a capsule stub (§5.1).
    const tailR = s * 0.11;
    const rootY = hipY + bodyH * 0.20;
    const rootZ = rearZAt(rootY + tailR);
    parts.push(makeBoxSpherePart(bellyC, noRots,
      -tailR, rootY, rootZ - tailR * 0.3,
       tailR, rootY + tailR * 2, rootZ + tailR * 1.4, 1, 6, 5, furMat));
  } else {
    // Deer flag tail, over a pale rump patch. The flag only reads as a flag
    // against a light rump — that pairing is the whole signal a deer gives when
    // it turns away from you, and the tail alone was doing nothing.
    const tailW = s * 0.06, tailH = s * 0.16, tailD = s * 0.12;
    const tailY = hipY + bodyH * 0.70;
    const rootZ = rearZAt(tailY + tailH * 0.5);
    parts.push(makeBoxSpherePart(bellyC, noRots,
      -bodyW * 0.86, hipY + bodyH * 0.26, rootZ - bodyL * 0.30,
       bodyW * 0.86, hipY + bodyH * 0.86, rootZ + bodyL * 0.04,
      0.90, 7, 5, furMat));
    parts.push(makeBoxCapsulePart(bellyC, noRots,
      -tailW, tailY, rootZ, tailW, tailY + tailH, rootZ + tailD, 6, furMat));
  }

  return parts;
}

// ---------------------------------------------------------------------------
// Body plan: BIRD
//
// Rebuilt. The old one was a sphere with a sphere on top — head radius s*0.30
// against a body half-width of s*0.32, so the head was as big as the body — a
// cone for a beak, and two flat panels held out sideways like aeroplane wings
// whatever the bird was doing. At gameplay distance it read as a blue ball,
// and there was nothing about it that said "bird" except that it was small.
//
// What actually reads as a bird, in order: the FOLDED WING lying along the
// flank (a bird at rest is a wing-shaped silhouette, not a sphere), a swept
// tail projecting behind, a small head with a beak set well forward of a plump
// chest, and a forward lean. All four are geometry the old one did not have.
// ---------------------------------------------------------------------------

function buildBird(species: Species, pose: AnimalPose, variant: number): Part[] {
  const s = SPECIES_DEFS[species].size;
  const bodyC   = applyVariant(BASE_COLORS[species], variant);
  const bellyC  = BELLY_COLORS[species];
  const accentC = ACCENT_COLORS[species];

  const legH  = s * 0.30;
  const bodyW = s * 0.30;   // half-width
  const bodyH = s * 0.40;   // full height of the body mass
  const bodyL = s * 0.60;   // full length, nose end to rump

  const hipY  = legH;
  const bodyCY = hipY + bodyH * 0.46;
  const bodyCZ = s * 0.04;

  const headR  = s * 0.185;
  const headCY = hipY + bodyH * 0.90;
  const headCZ = -bodyL * 0.42;

  // WING AMPLITUDE COMES FROM EITHER CHANNEL, deliberately.
  //
  // `anim/clips-winged.ts` drives the bird's wings on `WalkAmp` (idle 0.07,
  // run 0.92) because the old builder hardwired them to `walkPhase`, and it
  // documents that as a rig limitation waiting on a mesh change. Reading
  // `flapAmp` alone would therefore have frozen every bird's wings shut, and
  // reading `walkAmp` alone would keep the limitation alive. Taking the max
  // honours the clips that exist today and needs no change on the day the
  // anim side moves the bird onto the real wing channel.
  const flapPhase = pose.flapPhase !== undefined && pose.flapAmp !== undefined
    && pose.flapAmp > 0 ? pose.flapPhase : pose.walkPhase;
  const flapAmp = Math.max(pose.flapAmp ?? 0, pose.walkAmp);
  // Wing and tail tips: a darker shade of the bird's own colour. They used to
  // take `accentC`, which is the beak/leg gold — a small bird with gold legs,
  // a gold beak, gold wingtips AND a gold tail is a bird made of beak.
  const tipC: Color3 = tint(bodyC, -0.15, -0.19, -0.16);

  const headYaw = pose.headYaw ?? 0;
  const headRots: Rot[] = headYaw !== 0 ? [twistY(headYaw, 0, headCZ)] : [];

  const parts: Part[] = [];

  // --- Legs: thin scaly capsules with a toed foot.
  //
  // Deliberately NOT animated. `walkPhase` is the bird's wing clock, not a step
  // clock (see the flap note above), so swinging the legs from it would make a
  // perched bird pedal at 1.7 Hz. `anim/creature-anim.ts` states the contract
  // explicitly: bird legs have an empty rotation chain and there is no
  // planted-foot contract to honour. ---
  const legR = s * 0.045;
  const legX = bodyW * 0.34;
  for (const side of [-1, 1] as const) {
    parts.push(makeBoxCapsulePart(accentC, [],
      side * legX - legR, 0, -legR,
      side * legX + legR, hipY + s * 0.04, legR, 5, MAT.HORN));
    // Foot: a small toed pad. A capsule ending in nothing looks amputated.
    parts.push(makePart(accentC, [],
      side * legX - legR * 1.5, 0, -legR * 3.0,
      side * legX + legR * 1.5, legR * 0.7, legR * 1.4, MAT.HORN));
  }

  // --- Body: a plump egg, deepest at the chest, tapering to the rump. ---
  parts.push(makeBoxSpherePart(bodyC, [],
    -bodyW, bodyCY - bodyH * 0.5, bodyCZ - bodyL * 0.5,
     bodyW, bodyCY + bodyH * 0.5, bodyCZ + bodyL * 0.5, 1, 7, 5, MAT.FUR_SHORT));
  // Pale breast, sunk into the front underside — the counter-shading that makes
  // a small bird legible against both sky and ground.
  parts.push(makeBoxSpherePart(bellyC, [],
    -bodyW * 0.72, bodyCY - bodyH * 0.52, bodyCZ - bodyL * 0.46,
     bodyW * 0.72, bodyCY + bodyH * 0.06, bodyCZ + bodyL * 0.10,
    1, 6, 4, MAT.FUR_SHORT));

  // --- Head + beak + eyes. Seated so it overlaps the chest: at this scale a
  // visible neck would be a bead on a string. ---
  // A 0.3 m bird never subtends enough pixels for the extra rings to show, and
  // there are usually several of them on screen at once.
  parts.push(makeBoxSpherePart(bodyC, headRots,
    -headR, headCY - headR, headCZ - headR,
     headR, headCY + headR, headCZ + headR, 0.94, 7, 5, MAT.FUR_SHORT));
  const beakD = s * 0.15;
  parts.push(makeBoxConePartZ(accentC, headRots,
    -s * 0.045, headCY - s * 0.015, headCZ - headR * 0.55 - beakD,
     s * 0.045, headCY + s * 0.055, headCZ - headR * 0.55, 6, MAT.HORN));
  parts.push(...makeEyeParts(EYE_COLOR, headRots,
    headR * 0.74, headCY + headR * 0.30, headCZ - headR * 0.44, s * 0.034));

  // --- Wings. Folded along the flank at rest, opening with the flap.
  //
  // This is the change that makes it a bird. The panels are rolled hard DOWN
  // (a big negative dihedral) so they lie against the body pointing back and
  // slightly down — the closed-wing silhouette — and `flapAmp` rolls them back
  // up through horizontal and beyond. Held permanently out to the sides, as
  // they were, a perched bird looks like a paper aeroplane.
  const shoulderY = bodyCY + bodyH * 0.22;
  const shoulderZ = -bodyL * 0.12;
  // Opening a wing is TWO rotations, and doing only one of them was why the
  // "folded" wing still stuck out sideways like a dart. A closed wing lies
  // along the flank pointing at the tail: dropped almost vertical AND swept
  // right back. Sweep and drop therefore both run off the same openness.
  const open = Math.min(1, flapAmp * 1.5);
  const fold = -0.98 + open * (1.06 + Math.sin(flapPhase) * 0.72);
  const sweep = (1 - open) * 1.30;
  for (const side of [-1, 1] as const) {
    const roll: Rot[] = [
      rollZ(side * fold, side * bodyW * 0.78, shoulderY),
      twistY(side * sweep, side * bodyW * 0.78, shoulderZ),
    ];
    const st = (x: number, l: number, t: number) =>
      [side * (bodyW * 0.78 + x), shoulderY, shoulderZ + l, shoulderZ + t] as const;
    const stations = [
      st(0,        -s * 0.17, s * 0.12),
      st(s * 0.17, -s * 0.16, s * 0.24),
      st(s * 0.35, -s * 0.06, s * 0.32),
      st(s * 0.52,  s * 0.11, s * 0.36),
    ];
    parts.push(makeWingPart(bodyC, roll, stations.slice(0, 3), MAT.FUR_SHORT));
    parts.push(makeWingPart(tipC,  roll, stations.slice(2, 4), MAT.FUR_SHORT));
    // Leading edge: the folded wing's top line, and the only part with volume.
    parts.push(makeBoxCapsulePart(bodyC, roll,
      side < 0 ? -bodyW * 0.78 - s * 0.18 : bodyW * 0.78 - s * 0.02,
      shoulderY - s * 0.03, shoulderZ - s * 0.15,
      side < 0 ? -bodyW * 0.78 + s * 0.02 : bodyW * 0.78 + s * 0.18,
      shoulderY + s * 0.03, shoulderZ + s * 0.03, 6, MAT.FUR_SHORT));
  }

  // --- Tail: a swept fan carried up and back off the rump. Two overlapping
  // quads rather than the old single beveled plate, so the outline is a wedge
  // and not a rectangle. ---
  const tailY = bodyCY + bodyH * 0.10;
  const tailZ = bodyCZ + bodyL * 0.42;
  const tailRot: Rot[] = [pitch(-0.34, tailY, tailZ)];
  parts.push(makeFlatQuadPart(bodyC, tailRot,
    -s * 0.16, tailY - s * 0.01, tailZ,
     s * 0.16, tailY + s * 0.01, tailZ + s * 0.34, MAT.FUR_SHORT));
  parts.push(makeFlatQuadPart(tipC, [pitch(-0.44, tailY, tailZ)],
    -s * 0.10, tailY - s * 0.008, tailZ + s * 0.26,
     s * 0.10, tailY + s * 0.008, tailZ + s * 0.50, MAT.FUR_SHORT));

  return parts;
}

// ---------------------------------------------------------------------------
// Body plan: GRIFFIN - eagle front / lion rear with spread feathered wings
//
// The split was supposed to be carried by MATERIAL (FUR_SHORT feathers in
// front, FUR fur behind) over a single tawny body colour. It does not read:
// two fur variants of the same gold at gameplay distance are one gold animal,
// so the griffin came out as a tawny lion with panels bolted to it - exactly
// the failure this pass was asked to check for. The eagle half now differs in
// VALUE, not just in material: a pale cream hood over the head, neck and
// breast, meeting the tawny lion coat at a raised ruff. That boundary line IS
// the hybrid, and it is the one thing about a griffin that has to be legible.
//
// The wings were the other half of the problem. Base dihedral 0.34 rad plus a
// 0.45 flap and a further +0.38 of progressive outboard roll put the outermost
// primary 67 degrees above horizontal, and since the renderer beats the wings
// even at rest, the resting pose was the worst one: side-on, the griffin was a
// totem pole of vertical billboards. Span costs cos(angle), so all that roll
// also threw away most of the width it was supposedly buying. Held near flat
// with a shallow beat and swept BACK instead of up, the same feathers finally
// span something.
// ---------------------------------------------------------------------------

function buildGriffin(species: Species, pose: AnimalPose, variant: number): Part[] {
  const s = SPECIES_DEFS[species].size;
  const bodyC   = applyVariant(BASE_COLORS[species], variant); // tawny lion
  const accentC = ACCENT_COLORS[species];                      // bright gold
  // Eagle plumage: pale cream, several values lighter than the lion coat.
  const eagleC: Color3 = tint(bodyC, 0.20, 0.30, 0.54);
  const eagleD: Color3 = tint(bodyC, 0.02, 0.10, 0.28);        // shadowed cream

  const legH  = s * 0.46;
  const bodyH = s * 0.36;
  const bodyW = s * 0.27;
  const bodyL = s * 0.54;
  const hipY    = legH;
  const bodyTop = legH + bodyH;

  const swing = Math.sin(pose.walkPhase) * pose.walkAmp;

  const parts: Part[] = [];

  // ----- Torso: feathered breast in front, lion hindquarters behind. -----
  parts.push(makeBoxSpherePart(eagleC, [],
    -bodyW, hipY, -bodyL,
     bodyW, bodyTop, bodyL * 0.16, 1, 8, 6, MAT.FUR_SHORT));
  parts.push(makeBoxSpherePart(bodyC, [],
    -bodyW * 0.94, hipY - s * 0.01, -bodyL * 0.10,
     bodyW * 0.94, bodyTop - s * 0.02, bodyL, 1, 8, 6, MAT.FUR));
  parts.push(makeBevelPart(eagleD, [],
    -bodyW * 0.70, hipY - s * 0.05, -bodyL * 0.82,
     bodyW * 0.70, hipY + s * 0.05, bodyL * 0.06, 0.03, MAT.FUR_SHORT));

  // ----- Neck up to the head, and the ruff where feather meets fur. -----
  const lean = 0.42;
  const neckLen = s * 0.34;
  const neckZ = -bodyL * 0.70;
  const neckY = bodyTop - s * 0.05;
  parts.push(makeBoxCapsulePart(eagleC, [pitch(-lean, neckY, neckZ)],
    -s * 0.12, neckY - s * 0.03, neckZ - s * 0.14,
     s * 0.12, neckY + neckLen, neckZ + s * 0.14, 6, MAT.FUR_SHORT));
  // The ruff: a shaggy collar standing proud where the cream hood ends. On any
  // griffin illustration this is the loudest line on the animal.
  parts.push(makeBoxSpherePart(eagleD, [],
    -bodyW * 0.94, bodyTop - bodyH * 0.74, neckZ - s * 0.10,
     bodyW * 0.94, bodyTop + s * 0.07,     neckZ + s * 0.16,
    0.92, 8, 5, MAT.FUR_SHORT));

  const headY = neckY + neckLen * Math.cos(lean) - s * 0.02;
  const headZ = neckZ - neckLen * Math.sin(lean);
  const headYaw = pose.headYaw ?? 0;
  const headRots: Rot[] = headYaw !== 0 ? [twistY(headYaw, 0, headZ)] : [];

  // ----- Eagle head: skull, hooked beak, eyes, swept ear tufts. -----
  const headR = s * 0.155;
  parts.push(makeBoxSpherePart(eagleC, headRots,
    -headR, headY, headZ - headR * 1.35,
     headR, headY + headR * 2.0, headZ + headR, 0.94, 8, 6, MAT.FUR_SHORT));
  parts.push(makeBoxConePartZ(accentC, headRots,
    -s * 0.055, headY + headR * 0.62, headZ - headR * 1.35 - s * 0.19,
     s * 0.055, headY + headR * 1.16, headZ - headR * 1.35 + s * 0.02,
    6, MAT.HORN));
  // A hooked beak needs the hook: a small down-turned tip under the cone.
  parts.push(makeBoxConePart(accentC,
    [pitch(2.60, headY + headR * 0.72, headZ - headR * 1.35 - s * 0.15),
     ...headRots],
    -s * 0.040, headY + headR * 0.72, headZ - headR * 1.35 - s * 0.19,
     s * 0.040, headY + headR * 0.72 + s * 0.10,
    headZ - headR * 1.35 - s * 0.11, 6, MAT.HORN));
  // Gold iris with a black pupil in front of it - a raptor's stare is the
  // cheapest 240 verts of character on the whole roster.
  parts.push(...makeEyeParts([0.95, 0.72, 0.10], headRots,
    headR * 0.80, headY + headR * 1.26, headZ - headR * 0.82, s * 0.036));
  parts.push(...makeEyeParts(EYE_COLOR, headRots,
    headR * 0.84, headY + headR * 1.26, headZ - headR * 0.96, s * 0.020));
  for (const side of [-1, 1] as const) {
    parts.push(makeBoxConePart(eagleD,
      [rollZ(-side * 0.50, side * headR * 0.62, headY + headR * 1.9),
       pitch(-0.55, headY + headR * 1.9, headZ), ...headRots],
      side * headR * 0.62 - s * 0.035, headY + headR * 1.9, headZ - s * 0.035,
      side * headR * 0.62 + s * 0.035, headY + headR * 1.9 + s * 0.15,
      headZ + s * 0.035, 6, MAT.FUR_SHORT));
  }

  // ----- Legs: eagle talons in front, lion legs behind. Two different animals
  // from the knee down is the other half of the hybrid read. -----
  const legR = s * 0.085;
  const legDefs: [x: number, z: number, a: number, fore: boolean][] = [
    [-bodyW * 0.62, -bodyL * 0.58,  swing * 0.5, true],
    [ bodyW * 0.62, -bodyL * 0.58, -swing * 0.5, true],
    [-bodyW * 0.66,  bodyL * 0.60, -swing * 0.5, false],
    [ bodyW * 0.66,  bodyL * 0.60,  swing * 0.5, false],
  ];
  for (const [lx, lz, la, fore] of legDefs) {
    const rot: Rot[] = [pitch(la, hipY, lz)];
    const r = fore ? legR * 0.86 : legR * 1.05;
    parts.push(makeBoxCapsulePart(fore ? eagleD : bodyC, rot,
      lx - r, fore ? s * 0.10 : 0, lz - r,
      lx + r, hipY + s * 0.06, lz + r, 6, fore ? MAT.SKIN : MAT.FUR));
    if (fore) {
      // Scaly yellow foot with three forward toes.
      parts.push(makeBoxSpherePart(accentC, rot,
        lx - r * 1.1, 0, lz - r * 1.3,
        lx + r * 1.1, s * 0.11, lz + r * 1.1, 0.8, 6, 4, MAT.HORN));
      for (const t of [-1, 0, 1] as const) {
        parts.push(makeBoxConePart(accentC,
          [pitch(1.50, s * 0.03, lz - r * 1.0), ...rot],
          lx + t * r * 0.78 - r * 0.24, s * 0.03, lz - r * 1.0 - r * 0.24,
          lx + t * r * 0.78 + r * 0.24, s * 0.03 + r * 1.5,
          lz - r * 1.0 + r * 0.24, 5, MAT.HORN));
      }
    } else {
      parts.push(makeBoxSpherePart(bodyC, rot,
        lx - r * 1.15, 0, lz - r * 1.35,
        lx + r * 1.15, r * 1.1, lz + r * 0.9, 0.85, 6, 4, MAT.FUR));
    }
  }
  // Lion haunches - the rear has to look powered, or the back half is a barrel.
  for (const side of [-1, 1] as const) {
    const hr = bodyW * 0.62;
    parts.push(makeBoxSpherePart(bodyC, [],
      side * bodyW * 0.42 - hr, hipY - s * 0.01, bodyL * 0.60 - hr * 0.9,
      side * bodyW * 0.42 + hr, hipY + hr * 1.5, bodyL * 0.60 + hr * 1.0,
      0.85, 6, 4, MAT.FUR));
  }

  // ----- Wings: humerus + four swept feather panels, held near flat. -----
  const shoulderY = bodyTop - s * 0.04;
  const shoulderZ = -bodyL * 0.22;
  const flapPhase = pose.flapPhase ?? pose.walkPhase;
  const flapAmp = pose.flapAmp ?? pose.walkAmp;
  const raise = 0.10 + Math.sin(flapPhase) * flapAmp * 0.30;
  // Dark primaries: a raptor's wingtip is always several values below its
  // coverts, and that gradient is what stops a spread wing reading as a sheet.
  const primC: Color3 = tint(bodyC, -0.26, -0.24, -0.12);
  for (const side of [-1, 1] as const) {
    const flap: Rot[] = [rollZ(side * raise, side * bodyW, shoulderY)];
    // Spanwise stations: [x, y, leading z, trailing z]. Sweep and taper are
    // BAKED IN rather than produced by per-panel rotations, which is what
    // guarantees the surface is continuous — see makeWingPart.
    const st = (x: number, y: number, l: number, t: number) =>
      [side * x, shoulderY + y, shoulderZ + l, shoulderZ + t] as const;
    const stations = [
      st(bodyW * 0.90,     0,         -s * 0.17, s * 0.42),
      st(bodyW + s * 0.55, s * 0.030, -s * 0.17, s * 0.53),
      st(bodyW + s * 1.10, s * 0.055, -s * 0.02, s * 0.50),
      st(bodyW + s * 1.58, s * 0.070,  s * 0.20, s * 0.42),
      st(bodyW + s * 1.98, s * 0.078,  s * 0.40, s * 0.50),
    ];
    parts.push(makeWingPart(eagleC, flap, stations.slice(0, 3), MAT.FUR_SHORT));
    parts.push(makeWingPart(eagleD, flap, stations.slice(2, 4), MAT.FUR_SHORT));
    parts.push(makeWingPart(primC,  flap, stations.slice(3, 5), MAT.FUR_SHORT));
    // Leading-edge arm: the only part of a wing with real volume, and what
    // keeps the surface from reading as a sheet of paper edge-on.
    const [h0, h1] = side < 0
      ? [-bodyW - s * 0.62, -bodyW + s * 0.04] : [bodyW - s * 0.04, bodyW + s * 0.62];
    parts.push(makeBoxCapsulePart(eagleD, flap,
      h0, shoulderY - s * 0.045, shoulderZ - s * 0.15,
      h1, shoulderY + s * 0.055, shoulderZ + s * 0.05, 6, MAT.FUR_SHORT));
  }

  // ----- Lion tail with a dark terminal tuft. -----
  const tailSway = Math.sin(pose.walkPhase + 0.8) * pose.walkAmp * 0.35;
  const tailRot: Rot[] = [twistY(tailSway, 0, bodyL * 0.9),
    pitch(0.30, hipY + bodyH * 0.52, bodyL * 0.9)];
  parts.push(makeBoxCapsulePart(bodyC, tailRot,
    -s * 0.045, hipY + bodyH * 0.46, bodyL * 0.9,
     s * 0.045, hipY + bodyH * 0.58, bodyL * 0.9 + s * 0.42, 6, MAT.FUR));
  parts.push(makeBoxSpherePart(eagleD, tailRot,
    -s * 0.085, hipY + bodyH * 0.40, bodyL * 0.9 + s * 0.36,
     s * 0.085, hipY + bodyH * 0.62, bodyL * 0.9 + s * 0.58,
    1, 6, 4, MAT.FUR));

  return parts;
}

// ---------------------------------------------------------------------------
// Body plan: SEA SERPENT
//
// Rebuilt. The old one was four capsules laid end to end with the axis inset
// by the radius at both ends, so consecutive links did not touch: side-on it
// read as a row of loose teal beads floating in a line, with a fifth detached
// bead in front of them for a head. It had no face, no jaw, no eyes, no neck
// and three small fins near the front, and nothing about it undulated except a
// small yaw wobble per bead.
//
// The rebuild is a proper articulated CHAIN: each segment carries the rotation
// of every segment ahead of it, so the body stays welded together however it
// bends, and the links overlap by a fifth of their length so the joins are
// buried. Bending happens in two planes — a lateral sweep for swimming, and a
// vertical arch that lifts alternate sections clear of the water. Those humps
// breaking the surface are the entire iconography of a sea serpent, and they
// are visible from much further away than any amount of head detail.
// ---------------------------------------------------------------------------

function buildSeaSerpent(species: Species, pose: AnimalPose, variant: number): Part[] {
  const s = SPECIES_DEFS[species].size;
  const bodyC   = applyVariant(BASE_COLORS[species], variant);
  const bellyC  = BELLY_COLORS[species];
  const accentC = ACCENT_COLORS[species];

  // Serpent runs along Z; head at -Z (forward). Local y = 0 is the entity
  // origin, which the entity manager pins half a metre under the waterline.
  const baseY = s * 0.14;

  const headW = s * 0.20, headH = s * 0.22, headD = s * 0.34;
  const headY = s * 0.68;   // reared clear of the surface
  const headZ = -s * 0.30;  // skull centre

  const parts: Part[] = [];
  const headYaw = pose.headYaw ?? 0;
  const headRots: Rot[] = headYaw !== 0 ? [twistY(headYaw, 0, headZ)] : [];

  // ----- Head: skull, tapering snout, lower jaw, eyes, brow horns. -----
  parts.push(makeBoxSpherePart(bodyC, headRots,
    -headW, headY - headH * 0.5, headZ - headD * 0.5,
     headW, headY + headH * 0.5, headZ + headD * 0.5, 0.94, 8, 6, MAT.SCALE));
  {
    const sv: number[] = [];
    taperedCapsule(sv,
      0, headY - headH * 0.08, headZ - headD * 0.14,
      0, headY - headH * 0.20, headZ - headD * 0.5 - s * 0.20,
      headW * 0.72, headW * 0.34, 6);
    parts.push({ verts: sv, color: bodyC, material: MAT.SCALE, rots: headRots });
  }
  // Pale lower jaw — the value break that turns a smooth cone into a mouth.
  parts.push(makeBevelPart(bellyC, headRots,
    -headW * 0.52, headY - headH * 0.42, headZ - headD * 0.5 - s * 0.17,
     headW * 0.52, headY - headH * 0.20, headZ + headD * 0.18,
    s * 0.02, MAT.SCALE));
  parts.push(...makeEyeParts([0.92, 0.78, 0.16], headRots,
    headW * 0.82, headY + headH * 0.22, headZ - headD * 0.24, s * 0.030));
  for (const side of [-1, 1] as const) {
    parts.push(makeBoxConePart(accentC,
      [rollZ(-side * 0.42, side * headW * 0.7, headY + headH * 0.30),
       pitch(-0.62, headY + headH * 0.30, headZ), ...headRots],
      side * headW * 0.7 - s * 0.026, headY + headH * 0.30, headZ - s * 0.026,
      side * headW * 0.7 + s * 0.026, headY + headH * 0.30 + s * 0.20,
      headZ + s * 0.026, 6, MAT.HORN));
  }

  // ----- Neck: two tapered links arcing from the head down into the body. -----
  const neckZ0 = headZ + headD * 0.30;
  const neckZ1 = neckZ0 + s * 0.44;
  {
    const nv: number[] = [];
    taperedCapsule(nv, 0, headY - headH * 0.10, neckZ0,
      0, baseY + s * 0.14, neckZ1, headW * 0.66, headW * 0.92, 6);
    parts.push({ verts: nv, color: bodyC, material: MAT.SCALE, rots: [] });
  }

  // ----- Body: a chain of tapering links that bends in two planes. -----
  const N = 6;
  // Every phase-driven term is scaled by walkAmp, so a serpent at walkAmp 0
  // is a fixed shape whatever walkPhase says. That is a hard invariant the
  // mesh test asserts for every species, and for good reason: walkPhase only
  // advances with distance travelled, so a standing creature that reads it
  // twitches whenever anything else nudges the phase. The standing coil below
  // is a CONSTANT, not an animation, which is what lets an idle serpent still
  // look like a serpent. (Its idle clip holds walkAmp at 0.22, so it undulates
  // gently at rest in play regardless.)
  const waveAmp = 0.50 * pose.walkAmp;
  let z = neckZ1 - s * 0.08;
  let chain: Rot[] = [];
  const segY = baseY + s * 0.14;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    // Taper: thickest just behind the neck, whip-thin at the tail.
    const r0 = s * (0.20 - 0.145 * t);
    const r1 = s * (0.20 - 0.145 * Math.min(1, t + 1 / (N - 1)));
    const len = s * (0.42 - 0.10 * t);
    // Lateral sweep and vertical arch. The arch has a standing component so an
    // idle serpent still coils — a straight log lying on the sea is not one.
    const sway = Math.sin(pose.walkPhase * 0.8 + i * 0.85) * waveAmp * 0.55;
    const arch = Math.sin(pose.walkPhase * 0.8 + i * 1.25 + 0.6) * 0.30 * pose.walkAmp
      + (i % 2 === 0 ? 0.16 : -0.20);
    const own: Rot[] = [twistY(sway, 0, z), pitch(arch, segY, z)];
    const rots: Rot[] = [...own, ...chain];
    const sv: number[] = [];
    taperedCapsule(sv, 0, segY, z, 0, segY, z + len, r0, r1, 6);
    parts.push({ verts: sv, color: i < N - 1 ? bodyC : bellyC,
      material: MAT.SCALE, rots });
    // Two dorsal spikes per link, riding on that link's own rotation chain so
    // they stay planted on the back through every bend.
    for (const f of [0.28, 0.70]) {
      const fz = z + len * f;
      const fr = r0 + (r1 - r0) * f;
      parts.push(makeBoxConePart(accentC, rots,
        -s * 0.030, segY + fr * 0.86, fz - s * 0.034,
         s * 0.030, segY + fr * 0.86 + s * (0.19 - 0.11 * t), fz + s * 0.034,
        6, MAT.HORN));
    }
    chain = rots;
    z += len * 0.80;   // 20% overlap: the joins have to be buried
  }

  // ----- Tail fluke: a flat double-sided fan on the last link's chain. -----
  parts.push(makeFlatQuadPart(bellyC, chain,
    -s * 0.16, segY - s * 0.004, z - s * 0.04,
     s * 0.16, segY + s * 0.004, z + s * 0.30, MAT.SCALE));

  return parts;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Build the posed, colored triangle soup for `species` into `out` (if
 * provided) or a freshly allocated Float32Array.
 *
 * Returns vertex count (not float count).  Callers must ensure
 * `out.length >= ANIMAL_MAX_VERTS * 10`.
 */
export function buildAnimalMesh(
  species: Species,
  pose: AnimalPose,
  out?: Float32Array,
  colorVariant = 0,
): { verts: Float32Array; count: number } {
  let parts: Part[];
  switch (species) {
    case 'rabbit':
    case 'deer':
    case 'horse':
    case 'cow':
    case 'donkey':
    case 'wolf':
    case 'bear':
      parts = buildQuadruped(species, pose, colorVariant);
      break;
    case 'bird':
      parts = buildBird(species, pose, colorVariant);
      break;
    case 'dragon':
      parts = buildDragon(species, pose, colorVariant);
      break;
    case 'wyvern':
      parts = buildWyvern(species, pose, colorVariant);
      break;
    case 'griffin':
      parts = buildGriffin(species, pose, colorVariant);
      break;
    case 'sea_serpent':
      parts = buildSeaSerpent(species, pose, colorVariant);
      break;
    // Dungeon enemies. A separate file per body-plan family, matching the
    // dragon/wyvern precedent — see humanoid-mesh.ts's header for why these
    // are here on the animal rig rather than on the character rig.
    case 'goblin':
    case 'goblin_archer':
    case 'skeleton':
    case 'dread_king':
      parts = buildHumanoid(species, pose, colorVariant);
      break;
  }

  // Assembles directly into `out` when given one — no intermediate array and
  // no copy. See assembleParts.
  return assembleParts(parts, pose, out);
}

// ---------------------------------------------------------------------------
// Budget constant
// ---------------------------------------------------------------------------

/**
 * Largest vertex count possible across all species. Capsule/sphere/cone
 * primitives cost far more verts per part than the old 36-vert box (a
 * 6-segment capsule alone is 252 verts), so — as with CHARACTER_MAX_VERTS —
 * this was measured directly off buildAnimalMesh for every species (all 11,
 * swept across colorVariant 0-3 and both idle and fully-animated poses)
 * rather than hand-summed. The dragon (54-part rig, now with ~24 capsule/
 * taperedCapsule bones) is the worst case by a wide margin, measured at
 * 6852 verts after the RECTIFICATION_PLAN §5.1/§5.3/§7 pass (necks, tapered
 * legs/tails/snouts, double-sided wing membranes, per-species accents on
 * the 7 quadrupeds — dragon itself only gained the +36 verts from its
 * membranes going double-sided); this constant carries ~34% headroom above
 * that measured max, so it was left unchanged.
 */
export const ANIMAL_MAX_VERTS = 9200;
