/**
 * EntityRenderer — GPU buffer pool + per-frame mesh rebuild for live animals.
 *
 * Uses the same character pipeline (interleaved pos+color, 24-byte stride) and
 * createObjectBindGroup idiom as the player character.
 *
 * Dead entities are rendered as the idle pose sunk halfway into the ground
 * (y-offset = -size*0.5) for DEAD_SHOW_S seconds, then removed from view.
 * Choice rationale: buildAnimalMesh has no explicit 'dead' flag, so sinking
 * into the ground is the simplest visual without mesh builder changes.
 */

import { buildAnimalMesh, ANIMAL_MAX_VERTS, type AnimalPose } from './animal-mesh';
import { SPECIES_DEFS } from './entity-types';
import type { EntityState } from './entity-manager';
import type { Renderer } from '../renderer';
import type { TerrainDraw } from '../renderer';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum entities rendered per frame. */
export const MAX_DRAWN = 30;

/** Maximum view distance for rendering. */
const RENDER_DIST = 120; // m

/** Dead entities stay visible for this many game seconds (loot window). */
export const DEAD_SHOW_S = 20;

/** Dead entity sink depth (fraction of size). */
const DEAD_SINK_FRAC = 0.5;

// ---------------------------------------------------------------------------
// GPU buffer pool entry
// ---------------------------------------------------------------------------

interface PoolEntry {
  vertexBuffer: GPUBuffer;
  objectBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
}

// ---------------------------------------------------------------------------
// EntityRenderer
// ---------------------------------------------------------------------------

export class EntityRenderer {
  private readonly renderer: Renderer;

  /** Pre-allocated scratch buffer reused every frame (no per-frame alloc). */
  private readonly scratch = new Float32Array(ANIMAL_MAX_VERTS * 6);

  /** Pool of reusable GPU buffers (one per visible entity slot). */
  private pool: PoolEntry[] = [];

  /**
   * Per-frame jaw override for one entity (the mounted dragon breathing
   * fire). Set by main.ts each tick; null = all jaws closed.
   */
  jawOverride: { id: string; jawOpen: number } | null = null;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

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

    for (let i = 0; i < visible.length; i++) {
      const { e } = visible[i];
      const entry = this.pool[i];
      const def = SPECIES_DEFS[e.species];

      // Build pose.
      let yOffset = 0;
      let walkAmp = 0;
      let walkPhase = e.walkPhase;

      if (e.mode === 'dead') {
        // Sink into ground by half shoulder height.
        yOffset = -(def.size * DEAD_SINK_FRAC);
        walkAmp = 0;
        walkPhase = 0;
      } else if (e.mode === 'flee' || e.mode === 'aggro' || e.mode === 'wander') {
        walkAmp = 1;
      } else if (e.mode === 'graze') {
        walkAmp = 0.3;
      }

      // Owned stay/sit: sink toward the ground (belly rest) as sit eases 0->1.
      const sit = e.sit ?? 0;
      if (sit > 0 && e.mode !== 'dead') {
        yOffset -= def.size * 0.45 * sit;
        walkAmp *= 1 - sit;
      }

      const pose: AnimalPose = {
        yaw: e.yaw,
        walkPhase,
        walkAmp,
      };

      // Winged species beat their wings on a time-driven phase so they keep
      // moving even at rest (slow idle beat, full beat when walking).
      if (e.species === 'dragon' || e.species === 'griffin') {
        if (e.mode !== 'dead') {
          pose.flapPhase = simTime * (e.species === 'dragon' ? 2.4 : 3.4);
          pose.flapAmp = walkAmp > 0 ? 1 : 0.35;
        } else {
          pose.flapAmp = 0;
        }
      }

      // Fire-breath jaw (mounted dragon holding the attack key).
      if (this.jawOverride !== null && this.jawOverride.id === e.id) {
        pose.jawOpen = this.jawOverride.jawOpen;
      }

      // Write mesh into scratch (reuse Float32Array — no allocation).
      const { count } = buildAnimalMesh(e.species, pose, this.scratch, e.colorVariant);

      // Phase K: scale baby animals by scaleOverride.
      // We scale the vertex positions (x, y, z) in-place relative to entity
      // y-origin (y=0 in local space) so the animal sits on the ground correctly.
      const scale = (e as EntityState & { scaleOverride?: number }).scaleOverride;
      if (scale !== undefined && scale !== 1 && count > 0) {
        for (let vi = 0; vi < count; vi++) {
          const base = vi * 6;
          this.scratch[base]     *= scale; // x
          this.scratch[base + 1] *= scale; // y
          this.scratch[base + 2] *= scale; // z
          // color (r,g,b at base+3,4,5) is left unchanged
        }
      }

      // Upload vertex data.
      device.queue.writeBuffer(entry.vertexBuffer, 0, this.scratch, 0, count * 6);

      // Upload world offset (x, y+yOffset, z, colorMode=1 for fixed-color).
      device.queue.writeBuffer(
        entry.objectBuffer, 0,
        new Float32Array([e.x, e.y + yOffset, e.z, 1]),
      );

      draws.push({
        vertexBuffer: entry.vertexBuffer,
        indexBuffer: null,
        count,
        bindGroup: entry.bindGroup,
      });
    }

    return draws;
  }

  /** Destroy all GPU resources (called on shutdown). */
  destroy(): void {
    for (const entry of this.pool) {
      entry.vertexBuffer.destroy();
      entry.objectBuffer.destroy();
    }
    this.pool = [];
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _allocEntry(): PoolEntry {
    const vertexBuffer = this.renderer.device.createBuffer({
      label: 'animal-mesh',
      size: ANIMAL_MAX_VERTS * 24, // 6 floats × 4 bytes × ANIMAL_MAX_VERTS
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    const { bindGroup, buffer: objectBuffer } =
      this.renderer.createObjectBindGroup(0, 0, 0, 1);
    return { vertexBuffer, objectBuffer, bindGroup };
  }
}
