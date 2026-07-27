/**
 * EntityRenderer — GPU buffer pool + per-frame mesh rebuild for live animals.
 *
 * Uses the same character pipeline (interleaved pos3+normal3+colour3+materialId, 40-byte
 * stride) and createObjectBindGroup idiom as the player character.
 *
 * Dead entities are rendered as the idle pose sunk halfway into the ground
 * (y-offset = -size*0.5) for DEAD_SHOW_S seconds, then removed from view.
 * Choice rationale: buildAnimalMesh has no explicit 'dead' flag, so sinking
 * into the ground is the simplest visual without mesh builder changes.
 */

import { buildAnimalMesh, ANIMAL_MAX_VERTS } from './animal-mesh';
import { SPECIES_DEFS } from './entity-types';
import type { EntityState } from './entity-manager';
import { STRIDE_CREATURE, type Renderer, type TerrainDraw } from '../renderer';
import { MATERIALS } from '../render/materials';
import { CreatureAnimRegistry } from '../anim/creature-anim';
import type { AnimState } from '../anim/clip-set';
import type { AnimalPose } from './creature-parts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Floats per animal vertex: pos3 + normal3 + colour3 + materialId. */
const ANIMAL_VERTEX_FLOATS = STRIDE_CREATURE / 4;

/** Maximum entities rendered per frame. */
export const MAX_DRAWN = 30;

/** Maximum view distance for rendering. */
const RENDER_DIST = 120; // m

/** Dead entities stay visible for this many game seconds (loot window). */
export const DEAD_SHOW_S = 20;

/** Dead entity sink depth (fraction of size). */
const DEAD_SINK_FRAC = 0.5;

/** Stable 0..255 hash of an entity id, used to stagger LOD rebuilds. */
function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) & 0xff;
}

/**
 * Distance bands for animation LOD, in metres.
 *
 * The mesh rebuild is the dominant per-frame cost in a creature-heavy scene:
 * `buildAnimalMesh` re-transforms every vertex of every visible creature at
 * roughly 0.32 us/vertex, and the models run 4k-8.5k vertices. Thirty of them
 * is a large slice of the frame spent re-posing animals the player can barely
 * resolve, and it is why growing the meshes at all took the creatures scene
 * from 60 fps to the low 40s.
 */
const LOD_NEAR = 30;  // m — rebuild every frame
const LOD_MID  = 62;  // m — every 2nd
const LOD_FAR  = 95;  // m — every 3rd; beyond, every 4th

// ---------------------------------------------------------------------------
// GPU buffer pool entry
// ---------------------------------------------------------------------------

interface PoolEntry {
  vertexBuffer: GPUBuffer;
  objectBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  shadowBindGroup: GPUBindGroup;
  /**
   * Entity whose mesh is currently in `vertexBuffer`, or '' when unused.
   *
   * Pool slots are assigned in distance order, which changes as the player
   * moves, so slot `i` serves a different creature from one frame to the next.
   * Any mesh reuse MUST check this, or a wolf gets drawn wearing a cow's
   * vertices.
   */
  ownerId: string;
  /** Vertex count of the mesh currently in the buffer. */
  count: number;
  /** Frame index at which that mesh was built. */
  builtFrame: number;
}

// ---------------------------------------------------------------------------
// EntityRenderer
// ---------------------------------------------------------------------------

export class EntityRenderer {
  private readonly renderer: Renderer;

  /** Pre-allocated scratch buffer reused every frame (no per-frame alloc). */
  private readonly scratch =
    new Float32Array(ANIMAL_MAX_VERTS * ANIMAL_VERTEX_FLOATS);

  /** Pool of reusable GPU buffers (one per visible entity slot). */
  private pool: PoolEntry[] = [];

  /**
   * Per-entity clip playback. One animator per visible creature, pooled and
   * swept — see `creature-anim.ts`.
   */
  private readonly anim = new CreatureAnimRegistry();

  /**
   * Scratch for the object uniform. Previously this was
   * `new Float32Array([...])` per entity per frame: 30 allocations every frame,
   * 1800 a second, all four floats long and all immediately garbage.
   */
  private readonly objectScratch = new Float32Array(4);

  /** Monotonic frame counter, for the animation-LOD schedule. */
  private frameNo = 0;

  /**
   * Per-frame jaw override for one entity (the mounted dragon breathing
   * fire). Set by main.ts each tick; null = all jaws closed.
   *
   * Applied AFTER the clip system, so it wins over whatever the current clip
   * was doing with the jaw. A player holding the fire key must get an open
   * mouth even mid-attack-animation.
   */
  jawOverride: { id: string; jawOpen: number } | null = null;

  /**
   * Per-entity pose patch, applied AFTER the clip system and after
   * `jawOverride`.
   *
   * This exists because some pose channels are not, and should not be,
   * animation. `AnimalPose.seat` is the case it was written for: the Evil King
   * astride the black dragon needs `seat: 1` for as long as he is mounted, and
   * "mounted" is a fact about the world that the clip sampler has no way to
   * know and no business interpolating. Routing it through a clip channel
   * would mean a seat that crossfades — a King who half-stands mid-flight
   * every time his state machine changes clips.
   *
   * The callback receives the live pose the mesh is about to be built from and
   * may write any `AnimalPose` field on it. It runs on every visible entity,
   * so keep it to a map lookup and a couple of assignments.
   *
   * Whoever owns the boss fight sets this; nothing else does.
   */
  poseOverride: ((id: string, pose: AnimalPose) => void) | null = null;

  /**
   * Optional per-entity flight state (`flap` / `glide` / `land`), for callers
   * that actually know a creature is airborne. Automatic detection from
   * vertical velocity is deliberately conservative because running over a hill
   * produces the same signal; see `CreatureAnim.setFlight`.
   *
   * Set by `main.ts`'s `tickCastleBoss` for the king's black dragon, which is
   * the case it was written for: the dragon flies a steady circuit at constant
   * altitude, so it has no vertical velocity at all and the automatic detector
   * reads it as a walking animal — it circled the towers with its wings folded.
   * Cleared again the moment the fight grounds it, or the clip system keeps it
   * flapping while it walks.
   */
  flightOverride: { id: string; state: AnimState | null } | null = null;

  /**
   * Terrain height lookup, set by main.ts once the heightfield exists.
   *
   * Supplied so winged creatures can tell they are airborne from their height
   * above the ground instead of from vertical velocity. Velocity gets level
   * flight wrong — a dragon cruising at constant altitude has zero climb rate,
   * so it read as landed and folded its wings in mid-air, beating them only
   * while the ascend key was held. Altitude is unambiguous, and it applies to
   * every flier equally: mounted or wild, dragon, griffin or wyvern.
   */
  terrainHeightAt: ((x: number, z: number) => number) | null = null;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
    // Dev hook. `window.__gameDebug` lives in main.ts and belongs to a
    // different workstream, but a capture harness has to be able to reach
    // `poseOverride` and `flightOverride` — a boss photographed with his legs
    // straight and his wings furled is a photograph of something the game
    // never shows. One property, no behaviour, and it is the only reference
    // the module keeps.
    if (typeof window !== 'undefined') {
      (window as unknown as { __entityRenderer?: EntityRenderer })
        .__entityRenderer = this;
    }
  }

  /** Current number of live animators. Diagnostics only. */
  get animatorCount(): number { return this.anim.size; }

  /**
   * Last frame's rebuild accounting, for perf harnesses.
   *
   * The budget is a hard cap and the interesting question is whether a scene
   * SATURATES it — a crowd that wants 20 rebuilds and gets 8 is animating at a
   * third rate, which is a deliberate degradation but one worth knowing about.
   * `wanted` counts everything that asked; `spent` is what the budget allowed;
   * `forced` is the mandatory rebuilds that bypass it entirely (a pool slot
   * changing owner), and it is the number to watch, because those are NOT
   * capped and a churning crowd can drive them arbitrarily high.
   */
  readonly lastFrameCost = { drawn: 0, wanted: 0, spent: 0, forced: 0, ms: 0 };

  /**
   * Build draw calls for all entities within range and on the live/dead
   * render list.  Called once per frame from main.ts.
   *
   * @param entities   All live EntityState objects.
   * @param playerX    Camera/player X.
   * @param playerZ    Camera/player Z.
   * @param simTime    Current game simulation time (seconds).
   * @returns          Array of TerrainDraw ready for renderFrame characterDraws.
   */
  buildDraws(
    entities: Iterable<EntityState>,
    playerX: number,
    playerZ: number,
    simTime: number,
  ): TerrainDraw[] {
    // Collect candidate entities.
    const candidates: { e: EntityState; dist: number }[] = [];
    for (const e of entities) {
      if (e.mode === 'dead') {
        // Show dead entity only for DEAD_SHOW_S after it died.
        if (e.deadAtS === undefined) continue;
        if (simTime - e.deadAtS > DEAD_SHOW_S) continue;
      }
      const dist = Math.hypot(e.x - playerX, e.z - playerZ);
      if (dist > RENDER_DIST) continue;
      candidates.push({ e, dist });
    }

    // Sort by distance, keep closest MAX_DRAWN.
    candidates.sort((a, b) => a.dist - b.dist);
    const visible = candidates.slice(0, MAX_DRAWN);

    // Grow pool if needed (never shrink — amortizes allocs).
    while (this.pool.length < visible.length) {
      this.pool.push(this._allocEntry());
    }

    const draws: TerrainDraw[] = [];
    const device = this.renderer.device;

    // --- animation --------------------------------------------------------
    //
    // Everything below used to be inline `Math.sin` calls against `simTime`:
    // an idle head scan, a breathing bob, a wing beat and a mode-keyed step
    // function for stride amplitude. Each was individually reasonable and
    // collectively they could not be combined, sequenced or crossfaded — a
    // grazing animal could not also be breathing hard, and every mode change
    // was a hard cut. They are now clips (`anim/clips-*.ts`) plus an always-on
    // additive idle layer, played through a per-entity animator that
    // crossfades. See `anim/creature-anim.ts` for why gait phase moved with
    // them rather than staying on the entity.
    this.anim.beginFrame();
    this.frameNo++;

    // --- rebuild budget ---------------------------------------------------
    //
    // A hard cap on how many creature meshes may be rebuilt this frame.
    //
    // Distance bands alone are not enough. Measured: one rebuild costs ~1.8 ms
    // (~5100 vertices at ~0.36 us each), so a herd standing INSIDE the near
    // band — which is where a player naturally is — asks for 29 x 1.8 = 53 ms
    // against a 16.7 ms budget, and the scene halves to 30 fps no matter what
    // the bands say. A band expresses a preference; only a budget expresses a
    // limit.
    //
    // The underlying cost is not the transform, it is that every mesh-utils
    // primitive builds its part with `number[].push()`. Measured against
    // indexed writes into a pre-sized array, push is 17x slower — that is the
    // real fix and it is a refactor across every mesh builder in the game.
    // Until then this bounds the damage: animation rate degrades gracefully
    // under crowding instead of the frame rate collapsing.
    //
    // Eight is ~14 ms of rebuild in the pathological case and comfortably
    // under it in every normal one, where most creatures are outside the near
    // band and not due anyway.
    let rebuildBudget = 8;
    const cost = this.lastFrameCost;
    cost.drawn = visible.length;
    cost.wanted = 0;
    cost.spent = 0;
    cost.forced = 0;
    const costT0 = performance.now();

    for (let i = 0; i < visible.length; i++) {
      const { e, dist } = visible[i];
      const entry = this.pool[i];
      const def = SPECIES_DEFS[e.species];

      const driver = this.anim.get(e.id, e.species);
      if (this.flightOverride !== null && this.flightOverride.id === e.id) {
        driver.setFlight(this.flightOverride.state);
      }
      // Ground height under the creature, when the caller can supply it. This
      // is what lets winged species detect flight from ALTITUDE rather than
      // from vertical velocity — see `CreatureAnim.update`. Only sampled for
      // fliers: it is a terrain lookup per entity per frame and no other
      // species can use the answer.
      const groundY = this.terrainHeightAt !== null && driver.wantsGroundHeight
        ? this.terrainHeightAt(e.x, e.z)
        : undefined;
      const frame = driver.update(e, simTime, dist, groundY);
      const pose = frame.pose;

      // --- animation LOD ---------------------------------------------------
      //
      // How often this creature's MESH is rebuilt. Its position, its animator
      // and its gait phase still update every frame — only the vertex re-pose
      // is rationed, so movement stays perfectly smooth and it is the limb
      // animation that drops to 30/20/15 Hz with distance. At 60 m a deer is
      // a few dozen pixels tall.
      //
      // Staggered by a hash of the entity id. Without that, every creature in
      // a band rebuilds on the same frame, which does not reduce the peak cost
      // at all — it concentrates it into every other frame, trading a lower
      // average for a visible judder.
      const interval = dist < LOD_NEAR ? 1 : dist < LOD_MID ? 2
        : dist < LOD_FAR ? 3 : 4;

      // Mandatory, and NOT charged against the budget:
      //  - a slot now serving a different creature still holds the previous
      //    one's vertices, so skipping here draws a wolf wearing a cow;
      //  - the ridden mount's jaw follows held input and must answer at once.
      const mustRebuild = entry.ownerId !== e.id
        || entry.count === 0
        || (this.jawOverride !== null && this.jawOverride.id === e.id);

      // Wants a rebuild on its own schedule — granted while budget remains.
      // `visible` is sorted by distance, so the budget is spent nearest-first
      // and a crowd degrades from the back, where it cannot be seen.
      const wants = interval === 1
        || ((this.frameNo + hashId(e.id)) % interval) === 0;

      if (wants) cost.wanted++;
      if (mustRebuild) cost.forced++;

      let rebuild = mustRebuild;
      if (!rebuild && wants && rebuildBudget > 0) {
        rebuild = true;
        rebuildBudget--;
        cost.spent++;
      }

      // Dead creatures sink into the ground for the loot window. Kept out of
      // the clip system on purpose: it is a rendering convention for "this
      // corpse is about to disappear", not a pose.
      const yOffset = e.mode === 'dead'
        ? frame.yOffset - def.size * DEAD_SINK_FRAC
        : frame.yOffset;

      // Fire-breath jaw (mounted dragon holding the attack key). Overrides the
      // clip so the player's input always wins.
      if (this.jawOverride !== null && this.jawOverride.id === e.id) {
        pose.jawOpen = this.jawOverride.jawOpen;
      }
      // Non-animation pose facts (the King's `seat`). Last, so it wins.
      if (this.poseOverride !== null) this.poseOverride(e.id, pose);

      let count = entry.count;
      if (rebuild) {
        // Write mesh into scratch (reuse Float32Array — no allocation).
        ({ count } = buildAnimalMesh(e.species, pose, this.scratch, e.colorVariant));

        // Phase K: scale baby animals by scaleOverride.
        // We scale the vertex positions (x, y, z) in-place relative to entity
        // y-origin (y=0 in local space) so the animal sits on the ground correctly.
        const scale = (e as EntityState & { scaleOverride?: number }).scaleOverride;
        if (scale !== undefined && scale !== 1 && count > 0) {
          for (let vi = 0; vi < count; vi++) {
            const base = vi * ANIMAL_VERTEX_FLOATS;
            this.scratch[base]     *= scale; // x
            this.scratch[base + 1] *= scale; // y
            this.scratch[base + 2] *= scale; // z
            // Uniform scaling leaves normals (base+3..5) and colours
            // (base+6..8) unchanged.
          }
        }

        // Upload vertex data.
        device.queue.writeBuffer(
          entry.vertexBuffer, 0, this.scratch, 0, count * ANIMAL_VERTEX_FLOATS);
        entry.ownerId = e.id;
        entry.count = count;
        entry.builtFrame = this.frameNo;
      }

      // Upload world offset (x, y+yOffset, z, colorMode=1 for fixed-color).
      //
      // `frame.yOffset` already carries the gait bob, the clip's body sink and
      // the additive layer's breathing. Breathing rides here rather than in the
      // mesh because the whole body should rise and fall together — which is
      // what a resting animal actually does, and costs one float instead of a
      // CPU rebuild. The gait-bob half of it is the same number the builder was
      // handed as `pose.bodyDrop`; that identity is what keeps planted feet out
      // of the terrain.
      const obj = this.objectScratch;
      obj[0] = e.x;
      obj[1] = e.y + yOffset;
      obj[2] = e.z;
      obj[3] = 1;
      device.queue.writeBuffer(entry.objectBuffer, 0, obj);

      draws.push({
        vertexBuffer: entry.vertexBuffer,
        indexBuffer: null,
        count,
        bindGroup: entry.bindGroup,
        shadowBindGroup: entry.shadowBindGroup,
      });
    }

    this.anim.endFrame();
    cost.ms = performance.now() - costT0;
    return draws;
  }

  /** Destroy all GPU resources (called on shutdown). */
  destroy(): void {
    for (const entry of this.pool) {
      entry.vertexBuffer.destroy();
      entry.objectBuffer.destroy();
    }
    this.pool = [];
    this.anim.clear();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _allocEntry(): PoolEntry {
    const vertexBuffer = this.renderer.device.createBuffer({
      label: 'animal-mesh',
      size: ANIMAL_MAX_VERTS * STRIDE_CREATURE, // pos3+normal3+colour3+materialId
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    // Animals take their surface detail from the fur layer rather than the
    // woven cloth humanoids use.
    const { bindGroup, buffer: objectBuffer, shadowBindGroup } =
      this.renderer.createObjectBindGroup(
        0, 0, 0, 1, undefined, MATERIALS.FUR);
    return {
      vertexBuffer, objectBuffer, bindGroup, shadowBindGroup,
      ownerId: '', count: 0, builtFrame: -1,
    };
  }
}
