# Visual / Model / Animation Rectification Plan

Authoritative assessment of the art state of ArtifexWebGame as of 2026-07-24, with
prescriptions across five axes per element: **material**, **silhouette**, **model
quality**, **idle animation**, **action animation**.

Written to be executed directly. Every prescription carries numbers.

---

## 0. READ THIS FIRST — the build is currently broken

A per-part material system landed in the working tree **while this plan was being
written** (`src/game/render/material-table.ts`, `STRIDE_CREATURE = 40`,
`character.wgsl` reading `@location(3) material: f32`). The GPU half is done. The
**mesh-builder half is not**, and the two halves disagree:

| Layer | State | Evidence |
|---|---|---|
| `renderer.ts` | `STRIDE_CREATURE = 40` (pos3+normal3+colour3+**matId**), `creatureAttrs` has `@location(3)` at offset 36 | `renderer.ts:51, 344-353` |
| `character.wgsl` | reads per-vertex `material`, calls `shadeMaterialId()` | `character.wgsl:33, 51-57` |
| `material-table.ts` | 26 semantic materials, uploaded at `@group(0) @binding(7)` | `material-table.ts:52-121` |
| `entity-renderer.ts` | `ANIMAL_VERTEX_FLOATS = 10`, uploads `count * 10` floats | `entity-renderer.ts:24, 184` |
| `main.ts` | player + NPC buffers sized `* STRIDE_CREATURE`, count = `len / 10` | `main.ts:361-369, 2163, 5347` |
| **`animal-mesh.ts`** | **still emits 9 floats/vertex** — `new Float32Array(totalVerts * 9)` | `animal-mesh.ts:372, 1268` |
| **`character-mesh.ts`** | **still emits 9 floats/vertex** | `character-mesh.ts:609-610` |

`grep -c "MAT\." animal-mesh.ts character-mesh.ts` → **0, 0**.

Consequences right now: every creature's vertex stream is read at the wrong stride,
`count` is understated by 10%, and the tail of each buffer is uninitialised. Also
note `character.wgsl` no longer has the old `if (layer <= 0) { layer = MAT_KNIT; }`
fallback — a builder that emits nothing gets `MAT.DEFAULT = 0` = **CLOTH**, not knit.

**P0 below is not optional and not cosmetic. Nothing else in this plan can be
evaluated on screen until it is done.**

---

## 1. Prioritised master list

Ranked by *visible improvement per unit of work*. Do them in this order.

| # | Item | Effort | Why it ranks here |
|---|---|---|---|
| **1** | **Emit `matId` per vertex in `animal-mesh.ts` + `character-mesh.ts`** | M | Unbreaks the build **and** is the entire fix for "one MAT_FUR for everything". Antlers become horn, skeletons become bone, blades become iron — in one pass. §3 |
| **2** | **Free idle life: `headYaw` + breathing bob + tail sway** | **XS** | `AnimalPose.headYaw` is already plumbed through every builder and **nothing ever sets it**. Breathing costs 1 line in the object-uniform write, zero mesh cost. Turns 41 statues into 41 living things. §4.1 |
| **3** | **Quadruped silhouette surgery: thin legs, widen stance, add necks, narrow heads** | M | The measured cause of "unrecognisable grey blobs". Heads currently float in a 22–53 cm gap with no neck; legs are 2.0–2.8 aspect sausages hidden inside the body outline. §5.1 |
| **4** | **Give deer / cow / wolf distinct body proportions** | S | Deer and cow are *the identical mesh* at 1.167× scale. Confirmed: every proportion branch resolves the same. §5.1 |
| **5** | **`taperedCapsule` primitive + knee/hock joint split** | S | Constant-radius capsules are why every limb, neck, tail and antler is a uniform sausage. One primitive fixes all of them. §7 |
| **6** | **Double-side the flat-quad wings** | **XS** | Character pipeline is `cull: 'back'`; `makeFlatQuadPart` emits one winding. **Dragon, griffin and bird wings are invisible from below.** 3-line fix. §5.3 |
| **7** | **Tent: use the `gableRoof()` that already exists** | **XS** | The "sloped panels" are vertical slabs. A tent is currently a cuboid. `fire-mesh.ts:214-222` |
| **8** | **Fix `TRUNK_TOP = 2.0` shared across all 3 tree kinds** | S | Cactus is brown *bark* for its bottom 2.0 m of 3.5 m; jungle trunk is *leaf-green* for its top 1.2 m. Visible, embarrassing, cheap. §6.1 |
| **9** | **Animation architecture: joints + clips + blending** | **L** | Prerequisite for walk/run/attack/death per species and for all three enemies. The single most consequential call — see §2. |
| **10** | **Add a pine/conifer tree + a dead snag** | S | Alpine, mountain_forest, dense_forest and beach *all render oak*. Two new builders (~40 lines each) re-skin four biomes. §6.1 |

Everything below rank 10 is in §8 (cheap wins) and §9 (expensive work).

---

## 2. Animation architecture — the big call

### Recommendation: **extend into a real keyframe system. Do NOT build vertex skinning.**

#### The reasoning

The current system is described as "no skeleton, no keyframes, no blending". That is
half true, and the half that is false is the important half.

**It already has a skeleton.** A `Rot[]` chain like
`[pitch(chop.elbow, elbowY), pitch(shoulderPitch, shoulderY), pitch(chop.lean, hipY), twistY(chop.twist)]`
(`character-mesh.ts:430-436`) *is* a four-deep bone hierarchy. It is written as an
explicit flattened list instead of a parent-pointer tree, but the maths is identical.
Each part is bound to exactly one bone at weight 1.0.

**It already has keyframes.** `chopAt(t)` (`character-mesh.ts:266-277`) is a 3-key,
4-channel clip with per-segment easing (`smooth()` on windup, `s*s` on strike, `smooth()`
on recovery) and a lerp function (`lerpChop`). It is a working, well-authored animation
clip. There is exactly one of them, hardcoded.

**Rigid binding is *correct* for this art direction and must be preserved.** A knitted
yarn doll's arm is a separately knitted tube sewn at the shoulder. It *should* deform
rigidly and crease at the joint. Smooth skin weights — the thing a "real skeletal
system" would buy you — would make a yarn doll look like melting rubber. Building
vertex skinning here would be spending weeks to make the art worse.

So the gap is not skinning and not the rig. The gap is exactly four things:

1. **Joint vocabulary.** Humanoids expose 4 pose floats (`yaw, walkPhase, walkAmp, attackT`).
   You cannot express "head turns while walking while hurt" in 4 floats.
2. **Clip authoring.** One clip exists (chop). You need ~11 for humanoids and ~8 per
   animal body plan.
3. **Blending.** No crossfade, no additive layers. Every transition is a pop.
4. **Caching.** Every visible creature is rebuilt from scratch every frame with no
   dirty check, and humanoids allocate a fresh `Float32Array` per call (up to 151 KB
   × 13 = **~2 MB of garbage per frame, ~118 MB/s**). `character-mesh.ts:610`.

#### The prescribed architecture

New file `src/game/anim/rig.ts` (~200 lines):

```ts
// Joints are indices, not names, at runtime.
export const enum HJoint { Root, Hips, Spine, Chest, Neck, Head,
  ShoulderL, ElbowL, WristL, ShoulderR, ElbowR, WristR,
  HipL, KneeL, AnkleL, HipR, KneeR, AnkleR, COUNT }

export interface JointDef {
  parent: number;              // -1 for root
  pivot: [number, number, number];
  axes: (0|1|2)[];             // which of pitch/twist/roll this joint uses
}
export type Skeleton = JointDef[];
export type PoseBuffer = Float32Array;   // COUNT * 3 (pitch, twist, roll) radians
```

New file `src/game/anim/clip.ts` (~180 lines):

```ts
export interface Track { joint: number; axis: 0|1|2; keys: Float32Array; /* t,v pairs */ }
export interface Clip { name: string; duration: number; loop: boolean; tracks: Track[] }

export function sampleClip(c: Clip, t: number, out: PoseBuffer): void;
export function blendPose(a: PoseBuffer, b: PoseBuffer, w: number, out: PoseBuffer): void;
export function addPose(base: PoseBuffer, additive: PoseBuffer, w: number): void;
```

New file `src/game/anim/animator.ts` (~140 lines): per-entity state — `current`, `prev`,
`crossfadeT`, `crossfadeDur`, `speed`, `phase`, plus an always-on additive **idle layer**
(breathing / sway / head drift) driven by `simTime + hash(entityId)`.

Clip libraries as pure data: `src/game/anim/clips-humanoid.ts`,
`clips-quadruped.ts`, `clips-winged.ts`, `clips-serpent.ts`.

Mesh builders change from inline `Rot[]` literals to *joint references*: a part declares
`joint: HJoint.ElbowR` and the builder walks the skeleton to compose the chain. Same
maths, data-driven.

#### Two structural wins that come free with this

**a) Collapse the rotation chain to one matrix per part.** Today the inner loop runs
`for (const r of rs)` **per vertex** — a forearm with 4 rotations does 4 sequential
rotations across 252 vertices. Compose the chain into a single 3×4 matrix once per part,
then one multiply per vertex. Strictly cheaper, ~2–3× on the transform, and it is a
prerequisite for (b) anyway.

**b) Add a `jointId` float to the vertex — do it in the SAME pass as `matId`.**
`STRIDE_CREATURE 40 → 44` (pos3+normal3+colour3+matId+jointId). You are already touching
every part to annotate it with a material; annotating it with a joint at the same time is
nearly free. The payoff: the bind-pose mesh can be built **once** and posed on the GPU
from a bone-matrix storage buffer, eliminating the per-frame CPU rebuild entirely. Even
if GPU posing lands later, doing this now means you do not touch all six builders a
second time.

> **Strong advice:** land `matId` and `jointId` together. The cost delta is small; the
> cost of a second full pass over `character-mesh.ts` + `animal-mesh.ts` is not.

#### Cost

| Piece | Est. |
|---|---|
| `rig.ts` + `clip.ts` + `animator.ts` | ~520 lines, new |
| Convert `character-mesh.ts` to joint refs | ~200 lines changed |
| Convert `animal-mesh.ts` to joint refs (5 body plans) | ~400 lines changed |
| Humanoid clip library (11 clips) | ~250 lines of data |
| Quadruped + winged + serpent clips (~20) | ~350 lines of data |
| Driving code in `main.ts` / `entity-renderer.ts` | ~150 lines |
| **Total** | **~1,900 lines, ~3–4 focused days** |

Compare: a full skinned pipeline (skeleton + weights + GPU skinning + rewriting all six
builders to emit bind-pose + weights) is ~4,000–5,000 lines, ~2 weeks, and produces
*worse* results for knitted dolls.

#### Do it in this order

1. **§4.1 idle hacks first** (hours, not days). They are independent of the architecture
   and deliver most of the "feels alive" payoff immediately.
2. **Then the architecture**, before the enemies. The boss needs three distinct attacks;
   authoring those against a 4-float pose struct is not viable.

---

## 3. P0 — the material assignment map

Add a `mat: number` field to `Part` in both builders and a `mat` parameter to every
`make*Part` / `part` / `bpart` / `spherePart` / `capsulePart` / `limbPart` helper.
Widen the emit loop to 10 floats. Update `ANIMAL_MAX_VERTS` doc comment
(`animal-mesh.ts:1234` still says `* 9`) and the `mesh-utils.ts:6-8` header (still
documents the 36-byte character stride).

### Characters (`character-mesh.ts`)

| Part | Material | Note |
|---|---|---|
| Torso, arms, legs, head | `MAT.KNIT` | the yarn body |
| Hair (all styles) | `MAT.KNIT` | same layer; visually separated by colour |
| Eyes | `MAT.FELT` | see §5.4 — make them **button** spheres |
| Boots, belt, apron, skirt, hat | `MAT.FELT` | doll accessories are felt, not knit |
| Armour `fiber` | `MAT.CLOTH` | |
| Armour `leather` | `MAT.LEATHER` | |
| Armour `iron` + helmet | `MAT.IRON` | metallic 1.0 — first metal on a character |
| Armour `dragon` | `MAT.SCALE` | |
| `DRAGON_BONE` horns / spikes / ridge | `MAT.BONE` | tint weight 0.25, baked bone colour wins |
| Sword blade, crossguard, pommel; axe/pick heads | `MAT.IRON` | |
| All hafts / shafts (`WOOD` const) | `MAT.WOOD` | |
| Bow limbs + riser | `MAT.WOOD` | |
| Bowstring | `MAT.CLOTH` | |
| Staff shaft | `MAT.WOOD` |, knob → `MAT.GEM` (emissive 0.6 — instantly magical) |

### Animals (`animal-mesh.ts`)

| Species | Body | Belly | Accent parts |
|---|---|---|---|
| rabbit | `FUR` | `FUR` | ears `FUR`, tail-puff `FUR`, eyes `FELT` |
| deer | `FUR_SHORT` | `FUR_SHORT` | **antlers `HORN`**, hooves `HORN`, nose `LEATHER` |
| cow | `FUR_SHORT` | `FUR_SHORT` | **horns `HORN`**, hooves `HORN`, udder `SKIN`, muzzle `LEATHER` |
| horse / donkey | `FUR_SHORT` | `FUR_SHORT` | mane + tail `FUR` (long), **hooves `HORN`**, muzzle `LEATHER` |
| wolf | `FUR` | `FUR_SHORT` | **claws `HORN`**, nose `LEATHER`, eyes `FELT` |
| bear | `FUR` | `FUR` | **claws `HORN`**, nose `LEATHER`, paw pads `LEATHER` |
| bird | `FUR` @ high scale | `FUR` | **beak `HORN`**, legs `HORN`, wings `FUR` |
| dragon | **`SCALE`** | `SCALE` | horns / spikes / claws / ridge `HORN`, **membrane → new `MEMBRANE`** |
| griffin | front `FUR` / rear `FUR_SHORT` | `FUR` | **beak + talons `HORN`**, feather panels `FUR` |
| sea serpent | **`SCALE`** | `SCALE` | fins `HORN`, jaw `LEATHER` |

This table alone resolves known problem #2 *and* a large fraction of problem #1: today
a deer's antlers, hooves and nose all sample `MAT_FUR` at `texScale 5.5`, so the antlers
are furry and the whole animal is one uniform noise field.

### One new material row to add

`material-table.ts` — append (never reorder):

```ts
MEMBRANE: 26,
/* MEMBRANE */ M(LAYER.HIDE, 8.0, 0.75, 0.0, 0.70, 0, 1.0),
```

Translucency 0.70 makes dragon and griffin wings glow when backlit. `MAX_MATERIALS` is
32 and 26 rows are used — there is room.

---

## 4. Idle animation — the "feels alive" pass

### 4.1 Three changes that cost almost nothing

**(a) `headYaw` is already plumbed and nobody sets it.** `AnimalPose.headYaw` is honoured
by the quadruped, horse, bird, dragon and griffin builders. `entity-renderer.ts:142-146`
builds `{ yaw, walkPhase, walkAmp }` and never touches it.

In `entity-renderer.ts`, inside the per-entity loop:

```ts
const hash = (e.id.charCodeAt(0) * 37 + e.id.length * 11) % 100 / 100;
if (e.mode === 'idle' || e.mode === 'graze') {
  // Slow scan plus an occasional sharper check — prey animals never hold still.
  const t = simTime * 0.45 + hash * 6.28;
  pose.headYaw = Math.sin(t) * 0.38 + Math.sin(t * 2.7) * 0.10;
} else if (e.mode === 'aggro' || e.mode === 'flee') {
  pose.headYaw = 0;                    // locked on / locked forward
}
```

**One block. Every animal in the world starts looking around.**

**(b) Breathing costs zero mesh work.** `entity-renderer.ts:187-190` already writes the
world offset every frame. Add the bob there:

```ts
const breath = Math.sin(simTime * (1.6 - def.size * 0.18) + hash * 6.28)
             * def.size * 0.006;
device.queue.writeBuffer(entry.objectBuffer, 0,
  new Float32Array([e.x, e.y + yOffset + breath, e.z, 1]));
```

Big animals breathe slower (`1.6 - size*0.18` → dragon ≈ 0.97 rad/s, rabbit ≈ 1.53) and
the amplitude scales with size (rabbit 2.4 mm, dragon 21 mm). Do the same at `main.ts:5343`
for the player and `main.ts:2142` for NPCs. **No mesh rebuild, no vertex cost.**

**(c) Tail sway.** Non-horse/wolf/bear tails use `noRots` — completely static
(`animal-mesh.ts:680`). Wolf has a fixed `-0.45` pitch and no motion. Add:

```ts
const tailSway = Math.sin(pose.t * 1.1 + 0.7) * 0.14 + swing * 0.25;
// ...pass [twistY(tailSway, 0, bodyL)] instead of noRots
```

Requires adding `t: number` (sim time) to `AnimalPose` and `Pose`. Do this once; it is the
carrier for every time-driven idle from here on.

### 4.2 Per-species idle specification

| Species | Idle behaviour |
|---|---|
| rabbit | nose twitch (head pitch ±0.05 @ 4 Hz), **ear flick** — one ear rolls 0.30 rad every 3–6 s, sits back on haunches occasionally |
| deer | head scan 0.38 rad, ear rotate independently, tail flick every 4 s, weight shift between fore legs every ~6 s |
| cow | slow head-down graze cycle (head pitch 0 → 0.7 rad over 4 s, hold 3 s), continuous tail swat 0.22 rad @ 0.8 Hz, ear twitch |
| horse | head bob (pitch ±0.10 @ 0.4 Hz), tail swish 0.18 rad, occasional hoof paw (one fore leg pitches 0.25 and returns over 0.8 s) |
| donkey | as horse, plus long-ear rotation ±0.25 rad — the ears *are* the donkey |
| wolf | head low and scanning, ears swivel toward the player, tail low sway 0.12 rad, panting (jaw 0 → 0.15 @ 2 Hz) |
| bear | heavy weight shift (whole-body roll ±0.04 rad @ 0.3 Hz), head sway, snout lift-and-sniff every 5 s |
| bird | head flick (twist ±0.5 rad, **stepped not smooth** — birds move in discrete jerks), tail bob, wing settle every 4 s |
| dragon | already flaps at rest (`flapAmp 0.35`). Add: slow neck arc, tail curl, jaw 0 → 0.12 breathing, **eye-glow pulse** if eyes get `GEM` emissive |
| griffin | head flicks bird-style, tail lash lion-style, wings shift |
| sea serpent | **vertical** body undulation at `walkAmp 0.25` even when stationary — a serpent at rest still rides the swell |

### 4.3 Humanoid idle

Player and NPCs are **bit-identical static meshes** when standing — the code relies on it
(`character-mesh.ts:424-426`). NPCs stand *perfectly frozen* for 2–6 s at every waypoint
(`main.ts:2062-2068`).

Minimum viable idle, as an additive layer:

| Channel | Amplitude | Rate |
|---|---|---|
| Chest pitch (breathing) | ±0.018 rad | 0.30 Hz |
| Whole-body y bob | ±0.010 m | 0.30 Hz (in phase with chest) |
| Spine twist (weight shift) | ±0.035 rad | 0.11 Hz |
| Head twist (look around) | ±0.30 rad | 0.19 Hz + noise |
| Arm sway (follows spine) | ±0.05 rad | 0.11 Hz |

Add a per-NPC phase offset from the NPC id hash so a crowd does not breathe in unison —
this is the single most important detail; synchronised idle reads as *more* robotic than
no idle.

---

## 5. Models — per-element prescriptions

### 5.1 Quadrupeds — why they are grey blobs

Measured from `buildQuadruped` (`animal-mesh.ts:457-686`):

| Species | Leg L / R | Leg aspect | Body W×H×L | Leg outer vs body half-W | **Neck gap** | Head W×H×D |
|---|---|---|---|---|---|---|
| rabbit | 0.16 / 0.040 | 2.0 | 0.24 × 0.20 × 0.26 | 0.100 < 0.120 | 0.05 m | 0.22 × 0.13 × 0.10 |
| deer | 0.60 / 0.120 | **2.5** | 0.67 × 0.48 × 1.06 | 0.288 < 0.336 | **0.29 m** | **0.58 × 0.33 × 0.34** |
| cow | 0.70 / 0.140 | **2.5** | 0.78 × 0.56 × 1.23 | 0.336 < 0.392 | **0.34 m** | 0.67 × 0.39 × 0.39 |
| wolf | 0.50 / 0.090 | **2.8** | 0.43 × 0.36 × 0.94 | 0.198 < 0.216 | **0.22 m** | 0.43 × 0.25 × 0.25 |
| bear | 0.72 / 0.180 | 2.0 | 1.30 × 0.99 × 1.80 | 0.504 < 0.648 | **0.53 m** | 0.86 × 0.50 × 0.50 |

Five specific, confirmed failures:

**(1) There is no neck.** Only horse and donkey build one (`animal-mesh.ts:526-562`). Every
other quadruped takes the `else` branch, which places the head at
`headY = bodyTop + neckH` with **no connecting geometry**. The head literally floats —
29 cm above the torso on a deer, 53 cm on a bear. At 20 m this reads as one blob with a
second blob near it, which is exactly the reported symptom.

**(2) Heads are wider than they are long.** `headW = s*0.24` is a *half*-width, so the deer
head is **0.58 m wide × 0.34 m deep** — a pancake oriented across the body. A deer head is
~0.14 m wide × 0.40 m long. Every herbivore head is rotated 90° from correct.

**(3) Legs are stubs and hidden.** Leg aspect (length / diameter) is 2.0–2.8 across the
board; real quadruped legs are 8–15. And `legGap = bodyW * 0.5` with `legR = s * 0.10`
puts `legOuter < bodyW` for **every species** — head-on, not one millimetre of leg
protrudes past the body outline.

**(4) Deer and cow are the same model.** Every proportion branch resolves identically:
`legH = s*0.50`, `bodyH = s*0.40`, `bodyW = s*0.28`, `bodyL = s*0.44`, `headW = s*0.24`,
`headH = s*0.30`, `headD = s*0.28`, same tail. They differ *only* in ear height
(`s*0.18` vs `s*0.12`), antlers vs horn nubs, colour — and a **1.167× scale**. That is the
whole difference between a deer and a cow.

**(5) One material at one scale.** Everything is `MAT_FUR` at `texScale 5.5` — antlers,
hooves, noses, eyes, horns. Fixed by §3.

#### The two rules to apply

> **Rule A — legs must break the silhouette.** `legGap + legR > bodyW`. Target
> `legGap = bodyW * 0.85` and cut `legR` per the table below.
>
> **Rule B — leg aspect floor.** `legH / (2 * legR) ≥ 6` for ungulates (deer, cow, horse,
> donkey), `≥ 5` for canids, `≥ 4` for bear and rabbit.

#### Target proportions

Coefficients of `s`. Change these in `buildQuadruped`; they are all already
species-branched, so this is edits to existing ternaries.

| Scalar | rabbit | deer | cow | wolf | bear | horse | donkey |
|---|---|---|---|---|---|---|---|
| `legH` | 0.40 → **0.34** | 0.50 → **0.56** | 0.50 → **0.42** | 0.55 → **0.56** | 0.40 (keep) | 0.58 (keep) | 0.58 → **0.54** |
| `bodyH` | 0.50 → **0.44** | 0.40 → **0.30** | 0.40 → **0.58** | 0.40 → **0.32** | 0.55 (keep) | 0.38 (keep) | 0.38 → **0.42** |
| `bodyW` | 0.30 → **0.24** | 0.28 → **0.19** | 0.28 → **0.24** | 0.24 → **0.18** | 0.36 → **0.32** | 0.28 → **0.22** | 0.28 → **0.24** |
| `bodyL` | 0.32 → **0.34** | 0.44 → **0.50** | 0.44 → **0.58** | 0.52 → **0.58** | 0.50 (keep) | 0.55 (keep) | 0.55 → **0.48** |
| `legR` | 0.10 → **0.048** | 0.10 → **0.042** | 0.10 → **0.055** | 0.10 → **0.042** | 0.10 → **0.075** | 0.10 → **0.048** | 0.10 → **0.052** |
| `legGap` mul | 0.5 → **0.80** | 0.5 → **0.92** | 0.5 → **0.85** | 0.5 → **0.85** | 0.5 → **0.70** | 0.5 → **0.80** | 0.5 → **0.80** |
| `headW` | 0.28 → **0.16** | 0.24 → **0.105** | 0.24 → **0.13** | 0.24 → **0.115** | 0.24 → **0.15** | (own) | (own) |
| `headD` | 0.26 → **0.30** | 0.28 → **0.34** | 0.28 → **0.30** | 0.28 → **0.30** | 0.28 → **0.30** | (own) | (own) |
| `headH` | 0.34 → **0.20** | 0.30 → **0.16** | 0.30 → **0.20** | 0.30 → **0.17** | 0.30 → **0.22** | (own) | (own) |

Sanity check on deer: leg aspect becomes `0.672 / (2 × 0.0504)` = **6.7**; `legOuter`
= `0.228 × 0.92 + 0.050` = **0.260** vs `bodyW` 0.228 — legs clear the body by 3.2 cm
per side. Head becomes 0.25 wide × 0.41 long × 0.19 tall.

#### Add a generic neck (the highest-value single edit in §5)

Extract the horse/donkey neck code into a shared path and give every quadruped one:

| Species | Length (`× s`) | Lean (rad from vertical) | Radius (`× s`) | Reads as |
|---|---|---|---|---|
| deer | 0.38 | 0.60 | 0.055 | alert, head high and forward |
| cow | 0.20 | 0.85 | 0.085 | low, heavy, head near ground |
| wolf | 0.26 | **1.05** | 0.070 | head *level with or below* the shoulder — the defining canid cue |
| bear | 0.14 | 0.75 | 0.115 | short, thick, head thrust forward |
| rabbit | 0.08 | 0.45 | 0.045 | barely a neck; keeps the head tucked |

Use `taperedCapsule` (§7): thick at the shoulder, thin at the skull.

#### Per-species distinguishing features to add

| Species | Add | Cost |
|---|---|---|
| deer | 3–4 swept-back antler tines (currently 2), white flag tail in `BELLY` colour, dark nose sphere | 5 parts |
| cow | **2–3 piebald patch ellipsoids** on the torso (the cow's entire identity), udder ellipsoid under the rear belly, long tail 0.5·s with a tuft, horns swept **sideways** not up | 7 parts |
| wolf | **pointed ear cones** (currently flat boxes), dark dorsal saddle part, taper the snout, thicker tapered brush tail | 5 parts |
| bear | paw boxes with 3 claw cones each, squashed-sphere hump (currently a plain box) | 9 parts |
| rabbit | **haunch ellipsoids** (r `0.14·s`) over the hind legs — the powerful rear *is* the rabbit silhouette; sphere tail-puff | 3 parts |
| horse | split legs at knee/hock (§7), fetlock tufts, taper the tail hair | 8 parts |
| donkey | shorter rounder body (above), dark dorsal stripe + shoulder cross stripe (2 thin boxes) — the donkey's signature marking | 2 parts |

Colour note: wolf base is `[0.45, 0.46, 0.50]` — near-achromatic, which is the literal
"grey blob". Warm and darken to `[0.42, 0.40, 0.38]` and rely on the new dark saddle part
for contrast.

### 5.2 Bird

Model is small and mostly acceptable, but:
- **Wings are single flat quads** (`makeFlatQuadPartXY`) — see §5.3, they are invisible
  from one side. Rebuild as griffin-style: humerus capsule + 2 feather quads.
- `legH = s * 0.55` on a `s = 0.3` bird = 0.165 m stilts. Reduce to `s * 0.34`.
- Birds never fly: `animal-ai.ts` has no airborne mode, so they walk everywhere.
  Cheap fix: add a `perched`/`hop` state and a `flee → short flight arc` (2 s, +3 m
  altitude, full flap) — the single most convincing bird behaviour.
- Head flicks should be **stepped**, not sinusoidal. Quantise `headYaw` to 0.25 rad steps
  held for 0.4–1.2 s.

### 5.3 Winged rigs — confirmed one-sided-geometry bug

`makeFlatQuadPart` / `makeFlatQuadPartXY` emit a **single** `quad()`, which produces one
face normal (`mesh-utils.ts:38-48`). The character pipeline culls back faces
(`renderer.ts:352-353`). Therefore:

- dragon: 3 membrane panels × 2 wings = **6 invisible-from-below surfaces**
- griffin: 3 feather panels × 2 wings = **6 more**
- bird: 2 wings
- griffin tail fan, bird tail fan

A dragon flying overhead has **transparent wings**. Fix in `mesh-utils.ts`:

```ts
export function quad2(verts: number[], a: P3, b: P3, c: P3, d: P3): void {
  quad(verts, a, b, c, d);
  quad(verts, d, c, b, a);   // reverse winding, opposite normal
}
```

Use it in both flat-quad part builders. Cost: doubles those parts' vertices
(6 → 12 each, ~14 parts, ~84 extra verts on the dragon) — negligible against
`ANIMAL_MAX_VERTS = 9200`.

Otherwise the **dragon rig is genuinely good and should be left alone**: 54 parts,
4-segment tapering neck arc, 6-segment tail with lateral sway, bat wings with humerus +
4 fingers + 3 membranes, twin horn pairs, spine ridge, hinged jaw. Same for the griffin.
Their problem is materials (§3) and one-sided quads, not geometry.

### 5.4 Player character

The rig is sound: capsule limbs, rotation chains, bevelled torso, squashed-sphere head,
armour tiers, five held items, a real keyframed chop. **Do not rebuild it.** Make it a
*better doll*:

| Change | Numbers | Why |
|---|---|---|
| **Button eyes** | Replace the two flat boxes at `y 1.47–1.53, z -0.16..-0.14` with spheres `r = 0.028`, centres `(±0.06, 1.50, -0.145)`, material `FELT`, near-black | The single most characterful cheap change available. Flat dark rectangles read as a texture error; buttons read as a doll. |
| **Mitten hands** | Sphere `r = 0.075` at the wrist end of each forearm, `(±0.32, 0.72, 0)`, `MAT.KNIT`, skin colour | Forearms currently just stop. Yarn dolls have mitten hands. |
| **Felt feet** | Box `x ±0.10, y 0..0.06, z -0.14..0.10` on each leg, `MAT.FELT` | Legs currently end in a bare capsule cap at `y = 0`. |
| **Seams** | 6 thin boxes (`0.012` wide) down the outside of each limb and around each shoulder join, `MAT.FELT`, colour ×0.75 | Reads instantly as "sewn together". |
| **Neck** | Capsule `r = 0.055` from `y 1.28` to `1.36` | Head currently nearly abuts the torso. |
| Head size | `r 0.15 → 0.165`, `headScaleY 0.90 → 0.95` | Slightly oversized heads read as "doll", not "person". |

Held items:

| Item | Current | Fix |
|---|---|---|
| sword | 4 parts; blade box `0.05 × 0.07 × 0.63` | Fine. Taper the last 0.12 m to a point (2 extra verts via a wedge). Blade `IRON`, grip `LEATHER`, pommel `GOLD`. |
| axe | blade is a plain box `0.12 × 0.30 × 0.24` | A rectangle, no edge curve. Replace with a tapered wedge: back `0.12` thick → edge `0.02` thick, and add a beard (lower front corner extended 0.06). |
| pickaxe | "twin spikes" is **one box** `0.11 × 0.45 × 0.12` | Reads as a slab. Replace with 2 cones (`r 0.045`, length 0.22) sweeping from a central head box in opposite directions. |
| bow | straight box limbs | Split each limb into 2 segments with a 0.25 rad break → a recurve profile. |
| staff | shaft + knob | Knob → `MAT.GEM`, emissive 0.6. Add 2 small `GEM` spheres orbiting on a time-driven twist. |

### 5.5 NPCs

Same builder, same fixes. Two accessory bugs:

- **Hat brim is a square box** `0.48 × 0.04 × 0.48` (`character-mesh.ts:555-557`). Replace
  with `cylinder(r = 0.24, h = 0.04, seg = 10)` — a one-call change, and a round brim
  reads as a hat rather than a floating plank.
- **Skirt is a straight box.** Replace with `cylinder(rBottom = legO + 0.10, rTop = legO - 0.02,
  h = hipY * 0.76, seg = 10)` — flare is what makes a skirt read.

Behavioural gap worth flagging: NPCs pass `attackT: 1` hardcoded (`main.ts:2142-2147`), so
an NPC that is meleeing the player **never swings**. One-line fix once NPCs carry an
animator.

### 5.6 The three planned enemies

**Build all three from one parameterised humanoid builder.** Refactor
`buildCharacterMesh` to take a `BodyPlan` and make `MALE` / `FEMALE` / `GOBLIN` /
`SKELETON` / `BOSS` five data rows. This is the highest-leverage structural change for
the enemy roadmap — otherwise you write three more 700-line builders.

```ts
interface BodyPlan {
  height: number;
  hipFrac: number; torsoTopFrac: number; shoulderFrac: number; elbowFrac: number;
  torsoHalfW: number; limbR: number; headR: number; headScaleY: number;
  armLenMul: number; legLenMul: number;
  postureLean: number;   // constant forward pitch at the hips
  legSplay: number;      // constant outward roll at the hips
}
```

#### Goblin

| Axis | Spec |
|---|---|
| **Proportion** | `height 1.15`, effective standing height ~0.98 after `postureLean 0.25`. `headR 0.17` (**15% of height** vs 9% for the player — oversized head is the whole read). `torsoHalfW 0.20`, `limbR 0.055`, `armLenMul 1.30` (knuckles near the knee), `legLenMul 0.72`, `legSplay 0.14` (bandy) |
| **Parts** | ~22. Torso + belly sphere (`r 0.16` at `y 0.55`), head, 2 swept-back ear cones (length `0.22`, sweep 0.9 rad), nose cone (length `0.10`, `SKIN`), 4 limb segments, 2 mitten hands, 2 feet, jerkin, loincloth, weapon |
| **Material** | `SKIN` tinted `[0.35, 0.48, 0.24]`; jerkin `LEATHER`; loincloth `CLOTH`; crude cleaver `IRON` + `WOOD` haft; teeth + claws `HORN` |
| **Silhouette** | Reads at 20 m from: huge head, long dangling arms, hunch, ears. Must be unmistakably *shorter than the player* — the size contrast is the primary cue |
| **Idle** | Twitchy: head flicks every 1–2 s (stepped), shoulder hunch pulse, weight shift 0.5 Hz — 2–3× faster than human idle |
| **Actions** | `walk` (scuttling, high cadence — walkPhase rate ×1.6), `run`, `attack_slash` (wide horizontal, 0.35 s — fast and cheap), `attack_lunge`, `hurt` (recoil 0.25 s), `death` (fall backward, 0.6 s), `taunt` |

#### Skeleton — the one that needs real new geometry

Cannot reuse solid limb capsules. **The gaps between the bones are the entire point;
do not fill the torso.**

| Axis | Spec |
|---|---|
| **Proportion** | `height 1.70`, `limbR 0.032` (vs player 0.09 — 2.8× thinner), `torsoHalfW` unused (no solid torso) |
| **Parts** | ~32. Skull sphere `r 0.11` + jaw box + 2 recessed eye-socket spheres `r 0.035` at `z -0.08`; **6 rib pairs** as tapered capsules arced around the spine (`r 0.018`, arc radius 0.13 → 0.16 descending); 5 spine spheres `r 0.035`; pelvis bevelBox `0.22 × 0.12 × 0.14`; clavicles; humerus/radius/femur/tibia capsules; hand and foot boxes |
| **Material** | `BONE` throughout (tint weight 0.25 — the baked bone texture wins, so it will *not* pick up a body colour). Eye sockets: near-black, or `GEM` emissive 0.4 for a menacing variant |
| **Silhouette** | Read at 20 m comes from the rib cage reading as *stripes with sky between them* and the thinness of the limbs. If you cannot see through the torso, it has failed |
| **Idle** | Loose and rattling: small independent per-bone jitter (each limb ±0.02 rad at a **different** frequency, 3–6 Hz) — the "held together by nothing" look. Skull tilt |
| **Actions** | `walk` (stiff, minimal knee bend, arms swing wide), `attack_chop` (reuse the existing chop clip), `attack_stab`, `hurt` (jitter burst), **`death` = collapse into a heap** — pose all joints toward a ragdoll-ish target over 0.5 s, then sink. Highest-payoff death animation in the game |
| **Effort** | **The most expensive new model here.** ~250 lines. Budget it as its own task |

#### Boss ("basically Ganondorf")

| Axis | Spec |
|---|---|
| **Proportion** | `height 2.35` (1.45× the player — must dwarf everything). `torsoHalfW 0.42`, `limbR 0.14`, `headR 0.19`, `shoulderFrac` raised so the shoulders sit wide and high |
| **Parts** | ~40. Breastplate bevelBox, 2 pauldron squashed spheres (`r 0.24`, `scaleY 0.6`), gorget, greaves, gauntlets, crown of 5 `HORN`+`GOLD` spikes, cape (4 quads, double-sided, hanging from `y 1.95`), 2-handed sword |
| **Material** | Armour `IRON`; trim, crown and sword guard `GOLD`; cape `CLOTH` (translucency 0.30 so it glows at the edges); face `SKIN` tinted `[0.42, 0.44, 0.36]`; **eyes `GEM` emissive 0.6** — reads as evil from 50 m and costs 2 spheres |
| **Weapon** | 1.9 m two-hander: `IRON` blade `0.14` wide tapering to `0.05`, `GOLD` crossguard `0.42` span, `GEM` pommel emissive |
| **Silhouette** | Wide shoulders, cape, crown, oversized weapon. Test: black-fill the silhouette at 50 m — it must be identifiable |
| **Idle** | Slow and heavy. Breathing at 0.18 Hz (half human rate), cape wave (time-driven, 0.5 Hz, amplitude increasing toward the hem), slow head sweep, weapon shoulder-rest with a slight settle |
| **Actions** | **Three distinct attacks** — this is why §2 must land first: `sweep` (wide horizontal 180°, 0.9 s, telegraphed 0.4 s), `slam` (overhead, 1.2 s, ground shockwave VFX on impact), `guard_break` (two-handed thrust, 0.7 s). Plus `walk` (slow, 0.7× cadence), `hurt` (barely flinches — 0.1 rad recoil, sells weight), `stagger` (at HP thresholds), `death` (2.5 s: to knees → forward collapse → fade) |
| **Effort** | ~300 lines of mesh + 6 clips |

---

## 6. World props

### 6.1 Trees

Three kinds total (`oak`, `cactus`, `jungle`). Alpine, mountain_forest, dense_forest,
forest, plains and beach **all render oak** (`tree-scatter.ts:57-69`).

**Confirmed bug — one shared `TRUNK_TOP`.** `tree.wgsl:18` hardcodes `TRUNK_TOP = 2.0`
and line 52 does `let isBark = in.localY < TRUNK_TOP;`. All three kinds share one pipeline.

- Cactus column runs `y 0 → 3.5` → its **bottom 2.0 m renders as brown `MAT_BARK`**. 57% of a saguaro is bark.
- Jungle trunk runs `y 0 → 3.2` → its **top 1.2 m renders as green `MAT_LEAF`** with 0.85 translucency.

Fix: trees are already drawn in per-kind buckets (`chunk-manager.ts:248`), so add
`trunkTop` to the tree instance bind group as a per-draw scalar. Set oak 2.0,
cactus 3.6 (all bark), jungle 3.2. Also raise `CROWN_TOP` (currently 4.6, tuned for oak)
for jungle, whose canopy tops at 5.4 m.

**Variety.** `frame.wgsl:79-104` derives **yaw and tint from the same hash** — every
north-facing tree is the same shade of green. And scale is uniform-only
(`local = position * inst.w`). Two one-line shader fixes:

```wgsl
fn instanceHash2(inst: vec4<f32>) -> f32 {
  return fract(sin(inst.x * 39.3468 + inst.z * 11.1357) * 24634.6345);
}
// ...
let h2 = instanceHash2(inst);
local.y *= 0.82 + h2 * 0.40;    // 0.82–1.22 height variation, free
out.tint = h2;                   // decorrelate colour from facing
```

**Two new tree builders (~40 lines each, highest world-art value per line):**

| Kind | Geometry | Biomes |
|---|---|---|
| **pine** | Trunk `cylinder(r 0.16 → 0.08, h 5.4, seg 7)`; 5 stacked cones, radii `1.35 / 1.15 / 0.92 / 0.66 / 0.38`, at `y 1.6 / 2.6 / 3.5 / 4.3 / 4.9`, each `h 1.2` | alpine, mountain_forest, dense_forest |
| **dead snag** | Trunk `cylinder(r 0.20 → 0.05, h 3.8, seg 6)` + 3 bare tapered branch capsules (`r 0.07 → 0.02`, length 1.1–1.6, pitched 0.7–1.1 rad); **no canopy**, all `BARK` | dense_forest, alpine, scattered everywhere at 4% |

Oak itself is fine: 4 overlapping squashed spheres (`r 1.15 / 0.85 / 0.80 / 0.70`) — this
is *not* the "single sphere canopy" case. Its one weakness is zero branches; adding 3
tapered capsules from `y 1.6–2.2` out to the canopy blobs (~12 verts each) closes the
visual gap between trunk and crown.

**No LOD and no billboards anywhere** — full 189-tri oaks and 416-tri cacti to the 832 m
load radius. The cactus's two `capsule(seg 8)` arms alone are 1,152 verts (92% of its
mesh) for a shape a 5-segment capsule would render identically at this distance. Drop
cactus capsule segments 8 → 5 for a 37% cut with no visible change.

### 6.2 Resource nodes

`resource-mesh.ts` never imports `appendYaw`, so **no node has any rotation** — every
bush's berries face the same compass direction across the entire world, every boulder's
big lump points +X. Adding `appendYaw` with a per-node hash is a ~6-line change and the
single best variety-per-effort fix in the world props.

| Node | Current | Fix |
|---|---|---|
| **bush** | **one sphere `r 0.46`** | 3 overlapping spheres `r 0.30` at offsets `(0, 0.30, 0)`, `(-0.18, 0.22, 0.14)`, `(0.16, 0.26, -0.12)` + 2 twig capsules `r 0.02` at the base. Berries `GEM`, leaves `LEAF` |
| **cooling_herb / warming_herb** | **geometrically byte-identical** — same cylinder, same sphere, only palette 3 vs 4 differs | cooling: 3 broad flat leaf quads, blue-green. warming: 3 spiky cones, red-orange. They must not be the same plant |
| rock / ore_rock | 3 spheres (good) + 3 raw cube flecks | Flecks → small spheres `r 0.07`, material `GEM`; boulder `STONE` |
| mushroom | cylinder + squashed sphere, 6 seg | Cap segments 6 → 9 (a hexagonal mushroom cap is very visible); add gill quads underneath |
| reeds | 3 cylinders + 3 stretched spheres | Add 3 more stems at jittered angles; make them lean (they currently stand perfectly vertical) |
| flax, barrel_cactus, gourd | acceptable | Leave alone |

### 6.3 Settlement structures

The best-looking area of the game already: `bevelBox` chamfers throughout, real
`gableRoof` prisms split across two palettes, skirts hiding slope gaps, merlon counts
scaling with pad width. **Leave the overall approach alone.** Three targeted fixes:

1. **No window or door openings anywhere.** Every door and window is a flat plate 0.06–0.08 m
   *proud of* the wall. Fix the house at minimum: build the front wall as 3 boxes
   (left of door / above door / right of door) leaving a real 0.9 × 1.8 m hole, and set
   the door plate 0.04 m *inside* it. That single change transforms how a village reads.
2. **Roofs have zero thickness** — `gableRoof` is a 4-face prism. Add a 0.08 m fascia board
   along each eave (2 boxes per roof) — cheap depth cue at the most-seen silhouette edge.
3. **Well ring wall is 3 cm thick** (`r 0.75` outer → `0.72` inner). Will z-fight and alias
   badly. Take it to `0.75 → 0.66`.

`ruin` being a single `bevelBox` is a genuine gap — make it 3 broken wall boxes at
different heights (1.4 / 0.8 / 2.1 m) with a rubble pile.

### 6.4 Building interiors

Genuinely furnished — hearth, bed (9 parts), table + 4 cylinder legs, brazier, and real
room-aware placement with overlap rejection. Good work; keep it.

The gap: **chair, shelf, crate and counter are one `bevelBox` each.**

| Item | Fix | Cost |
|---|---|---|
| **chair** | 4 cylinder legs (`r 0.028`, `h 0.42`) + seat slab (`0.40 × 0.05 × 0.40`) + back (`0.40 × 0.42 × 0.05` at the rear) + 2 back posts | 8 parts, ~14 lines. Highest-impact interior fix — a chair is the most-seen piece of furniture |
| **shelf** | 2 side panels + 3 horizontal boards + a back panel | 6 parts |
| **crate** | keep the box, add 4 corner batten strips + 2 face slats | 7 parts |
| **counter** | keep the box, add a top slab overhanging 0.04 and a kick recess | 3 parts |
| **rug** | currently a 0.03 m box slab | Make it a flat quad pair at 0.005 m; a rug is not a plinth |
| barrel | `cylinder` with slight taper | Add 3 hoop rings (thin cylinders at `y 0.15 / 0.45 / 0.75`) |

### 6.5 Dungeon interiors

**The weakest area in the game.** `buildInteriorMesh` uses only `quad()`. The entire prop
catalogue is 5 items, all raw `box()` — torch (2 boxes), chest (2 boxes), portal (1 quad),
arch (3 boxes), glow (2 quads). Zero pillars, zero rubble, zero sarcophagi, zero
stalagmites, and **no visual difference between the `crypt`, `cave` and `ruin` themes**.

Ranked below animals and characters because it is the least-visited space, but the cheap
wins are very cheap:

1. **Wall-base trim**: one extra quad band `0.12 m` tall at every wall/floor junction, one
   palette darker. ~10 lines, and it removes the "untextured box" read instantly.
2. **Pillars**: every 6th floor cell in rooms ≥ 5×5, `cylinder(r 0.28, h = ceiling, seg 8)`
   + a capital box. ~20 lines.
3. **Rubble piles**: 4 boxes at jittered angles/scales, 2–5 per room. ~15 lines.
4. **Theme differentiation**: `cave` → replace wall quads with 2-segment jittered quads
   (irregular rock) and add 4–8 stalagmite cones per room; `crypt` → add wall niches
   and 1–2 sarcophagus boxes; `ruin` → add rubble and broken pillars.
5. Torch → `bevelBox` handle + `cone` flame with `MAT.EMBER`.

### 6.6 Fires, tents, water, terrain, grass

| Element | Assessment | Fix |
|---|---|---|
| **Tent** | **Broken.** The two "sloped panels" are vertical slabs (`fire-mesh.ts:214-222`); the result is a 2.4 × 1.7 × 1.6 m cuboid with a bump. `gableRoof()` exists in `mesh-utils.ts:351` and is not used | Replace the 2 panel boxes with one `gableRoof(x-1.2, z-0.8, x+1.2, z+0.8, y, 1.6)`. Add a guy-rope capsule at each end and a 0.3 m door flap. **~10 lines, huge payoff** |
| **Campfire stones** | 4 stones at cardinal points = a plus sign | 7 stones at `angle = i/7 * 2π + hash*0.6`, radius `0.35 + hash*0.06`, scale jitter ±20% |
| **Campfire flame** | 3 static boxes rebuilt every **5 s** | Rebuild per frame (the infrastructure exists — breath and burning-veg already do 20 Hz). 4 tapered cones, heights `0.36 / 0.28 / 0.20 / 0.13`, each twisting at a different rate, `MAT.EMBER`. Add 3 ember spheres rising on a sawtooth |
| **Terrain** | Already good — 2-layer material blending, de-tiling second sample at `scale * 0.413`, distance-based scale ramp | **Leave alone** |
| **Grass** | Already good — per-blade baked variation (yaw, lean, height, width, fan radius), per-instance tint + wind phase + independent yaw, 30→46 m collapse fade | Only gap: one archetype. Add a `flower` variant (2 extra quads, bright tint, 12% of instances) and a `dry stalk` variant for desert/plains |
| **Water** | Not audited in depth; no reported issues | Leave alone |
| **Breath cone / burning veg** | Per-frame, 20 Hz jitter, already lively | Leave alone |

---

## 7. New primitives needed in `mesh-utils.ts`

| Primitive | Signature | Why it matters |
|---|---|---|
| **`taperedCapsule`** | `(verts, x0,y0,z0, x1,y1,z1, r0, r1, seg)` | **The single most valuable addition.** Every limb, neck, tail, antler, horn and finger in the game is currently a *constant-radius* sausage. `cylinder` already supports `rBottom/rTop`; `capsule` already builds the orthonormal frame — this is a ~20-line merge of the two, with hemispherical caps scaled to each end's radius. It alone raises the quality of ~60% of all creature parts |
| **`quad2`** | `(verts, a, b, c, d)` | Double-sided quad. Fixes the invisible wings (§5.3). 4 lines |
| **`disc`** | `(verts, cx, cy, cz, r, seg, up)` | Hat brims, mushroom gills, shield faces, rug. Trivially a `cylinder` with `h = 0` |
| **`arc`** | `(verts, cx,cy,cz, radius, a0, a1, tubeR, seg)` | Rib cage bars, barrel hoops, well ring. Needed for the skeleton |

`cone()` exists in `mesh-utils.ts:195` and is **never called anywhere in the world-prop
code** — the pine, stalagmites, claws and spikes above all want it.

---

## 8. Cheap wins (do these first — hours, not days)

| # | Change | Files | Lines |
|---|---|---|---|
| 1 | Set `pose.headYaw` from `simTime + hash` for idle/graze animals | `entity-renderer.ts` | ~6 |
| 2 | Breathing bob in the object-uniform write (animals, player, NPCs) | `entity-renderer.ts`, `main.ts` ×2 | ~9 |
| 3 | `quad2` + use it in both flat-quad part builders — **fixes invisible wings** | `mesh-utils.ts`, `animal-mesh.ts` | ~8 |
| 4 | Tent → `gableRoof()` | `fire-mesh.ts` | ~10 |
| 5 | Campfire: 7 jittered stones instead of 4 cardinal | `fire-mesh.ts` | ~5 |
| 6 | `instanceHash2` — decorrelate tree tint from yaw, add non-uniform height | `frame.wgsl`, `tree.wgsl` | ~6 |
| 7 | Per-kind `trunkTop` uniform — **fixes brown cactus / green jungle trunk** | `tree.wgsl`, `chunk-manager.ts` | ~12 |
| 8 | `appendYaw` on all resource nodes | `resource-mesh.ts` | ~6 |
| 9 | Button eyes + mitten hands + felt feet on the player | `character-mesh.ts` | ~18 |
| 10 | Hat brim box → cylinder; skirt box → flared cylinder | `character-mesh.ts` | ~6 |
| 11 | Chair: 1 box → 8 parts | `building-interior-mesh.ts` | ~14 |
| 12 | Wolf base colour `[0.45,0.46,0.50]` → `[0.42,0.40,0.38]` + dark saddle part | `animal-mesh.ts` | ~4 |
| 13 | Well ring wall 3 cm → 9 cm | `settlement-mesh.ts` | 1 |
| 14 | Cactus capsule segments 8 → 5 (37% vert cut, no visible change) | `tree-mesh-variants.ts` | 4 |
| 15 | Scratch buffer for `buildCharacterMesh` (kills ~118 MB/s of GC garbage) | `character-mesh.ts`, `main.ts` | ~15 |

**Total: ~125 lines for the majority of the perceptible improvement.**

## 9. Expensive work (days)

| Item | Est. | Notes |
|---|---|---|
| P0 `matId` emission across both builders | 0.5–1 day | Blocking; must be first |
| Quadruped silhouette surgery + generic neck + per-species features | 1.5 days | Fixes problem #1 |
| Animation architecture (§2) | 3–4 days | Do before enemies |
| `taperedCapsule` + knee/hock leg split across 7 quadrupeds | 1 day | Do with the surgery |
| Skeleton enemy model | 1 day | ~32 parts, ribs are fiddly |
| Boss model + 6 clips | 1.5 days | |
| Goblin model | 0.5 day | Cheapest of the three if `BodyPlan` lands first |
| `BodyPlan` refactor of `buildCharacterMesh` | 0.5 day | Prerequisite for goblin + boss; pays for itself |
| Dungeon theme differentiation | 1 day | Lowest priority |
| Pine + dead snag + biome remap | 0.5 day | High value for the cost |

## 10. Leave alone — already good

Do **not** touch these; they are working and any change risks regression.

- **The material bake** — 20 procedural materials, GPU-baked at boot into two mipmapped
  rgba8 arrays, triplanar with whiteout blending. Excellent. The knit material in
  particular (`materials.wgsl:414-470`) is the art direction working correctly.
- **The dragon rig** — 54 parts, segmented neck arc, 6-segment swaying tail, bat wings
  with humerus + 4 fingers + 3 membranes, hinged jaw, spine ridge. Only fix its materials
  and the one-sided quads.
- **The griffin rig** — same verdict.
- **The bear** — the only quadruped with a genuinely differentiated body plan (shoulder
  hump, short legs, deep body). Needs the neck and thinner legs, nothing more.
- **Horse / donkey head-and-neck assembly** — the only quadrupeds with a real neck, mane
  crest, muzzle capsule and hooves. This is the template the other five should copy.
- **The chop keyframe animation** (`chopAt`, windup → strike → recover with per-segment
  easing) — well authored. It is the *model* for the clip system, not something to replace.
- **Terrain shading** — 2-layer blend, de-tiling, distance-ramped scale.
- **Grass** — per-blade baked variation plus per-instance yaw/tint/phase and a collapse fade.
- **Oak canopy** (4 overlapping squashed spheres) and **boulder** (3 spheres) — these are
  already the "several blobs, not one" solution.
- **Settlement `bevelBox` treatment**, real gable roofs, width-scaled merlons, terrain skirts.
- **Bed (9 parts), hearth (5 parts), table/stool with real cylinder legs, brazier.**
- **Room-aware furniture placement** with overlap and door-margin rejection.
- **The whole post chain** — cascaded shadows, SSAO, bloom, god rays, ACES, FXAA.

## 11. Performance notes to keep in view

- **~13 humanoids + 30 animals rebuilt on the CPU every frame**, no dirty check, no LOD
  on mesh detail. `buildCharacterMesh` allocates a fresh `Float32Array` per call — up to
  151 KB × 13 = **~2 MB/frame, ~118 MB/s of GC garbage**. Animals already reuse a scratch
  buffer; characters must too (cheap win #15).
- **Do not add a pose-dirty check** as the caching strategy — once idle animation lands,
  no pose is ever static and the check becomes dead weight. Instead: (a) drive breathing
  through the **object uniform**, not the mesh (§4.1b), and (b) rebuild the idle-animated
  mesh at **15 Hz** rather than 60 for entities beyond ~25 m. Imperceptible; 4× cheaper.
- **Collapse the `Rot[]` chain to one 3×4 matrix per part** before the vertex loop. Today
  the chain is re-applied per vertex. ~2–3× on the transform, and it is a prerequisite for
  GPU posing.
- Adding `jointId` takes `STRIDE_CREATURE` 40 → 44: `9200 × 44 = 405 KB` per animal buffer
  × 30 = 12 MB. Comfortable against the ~2.0–2.5 GB render budget in `GAME_PLAN.md:45-54`.
- The only stated frame target (`docs/ENGINEERING_LOG.md:1039-1041`, "~1.4 M tris, 60 fps")
  predates grass, water, SSAO, bloom, god rays, shadows, NPCs, settlements and creatures.
  **There is no current frame-time instrumentation** — only an FPS counter. Adding a
  per-system CPU timer before the animation work would be worth an hour.

## 12. Suggested execution order

1. **P0** — `matId` (+ `jointId`, same pass) in both mesh builders. Unbreaks the build.
2. **Cheap wins 1–15** (§8). ~125 lines, most of the perceptible gain.
3. **`taperedCapsule`** (§7), then quadruped silhouette surgery + necks (§5.1).
4. **Animation architecture** (§2) — joints, clips, blending, animator.
5. **`BodyPlan` refactor**, then **goblin → skeleton → boss**.
6. **World props** — pine + snag, bush, tent already done in step 2, dungeon last.
