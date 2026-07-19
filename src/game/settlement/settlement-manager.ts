/**
 * SettlementManager — discovers settlement sites near the player (same lazy
 * 3×3-cell memoized scan as dungeon entrances), resolves + meshes each one on
 * first approach, and serves its ≤ 4 palette-batched draws through the
 * dungeon pipeline (surface mode, zeroed lights) within draw distance.
 *
 * Also the registry for collision + signpost interaction (C-M4/5): `nearby()`
 * exposes the resolved settlements around a position.
 */

import type { Vec3 } from '../math';
import type { HeightField } from '../noise';
import { LIGHTS_BUFFER_SIZE, type DungeonDraw, type Renderer } from '../renderer';
import { settlementSiteAt, SCELL, type SettlementSite } from './settlement-scatter';
import { resolveSettlement, type ResolvedSettlement } from './settlement-layout';
import { buildSettlementMeshes } from './settlement-mesh';
import {
  spawnSettlementNpcs, resolveNpcs, type ResolvedNpc,
} from '../npc/npc-spawn';

// Same reach as dungeon entrance arches (m) — must stay inside the terrain
// stream radius (384 m) so buildings never float over unloaded ground.
const SETTLEMENT_DRAW_DIST = 360;
const INTERACT_DIST = 3;          // E-key reach to a signpost (m, XZ)
const NOTICE_MS = 4000;

interface Active {
  resolved: ResolvedSettlement;
  draws: DungeonDraw[];
  npcs: ResolvedNpc[];
}

export class SettlementManager {
  private readonly cache = new Map<string, SettlementSite | null>();
  private readonly active = new Map<string, Active>();
  private lightsBindGroup: GPUBindGroup | null = null;
  private pos: Vec3 = [0, 0, 0];
  private prompt: { label: string; act: () => void } | null = null;
  private notice: { text: string; until: number } | null = null;

  constructor(
    private readonly renderer: Renderer,
    private readonly heightField: HeightField,
    private readonly seed: number,
  ) {}

  /** Number of discovered (cached, present) settlements so far. */
  get settlementCount(): number {
    let n = 0;
    for (const s of this.cache.values()) if (s !== null) n++;
    return n;
  }

  get interactPrompt(): string | null {
    return this.prompt?.label ?? null;
  }

  /** Transient HUD notice ("Welcome to …"), or null once expired. */
  get noticeText(): string | null {
    if (this.notice !== null && performance.now() < this.notice.until) {
      return this.notice.text;
    }
    return null;
  }

  /** Fire the current prompt's action (bound to KeyE in main.ts). */
  tryInteract(): void {
    this.prompt?.act();
  }

  /** Per-tick: discover + mesh settlements in the 3×3 cells around pos. */
  update(pos: Vec3): void {
    this.pos = pos;
    const scx = Math.floor(pos[0] / SCELL);
    const scz = Math.floor(pos[2] / SCELL);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const s = this.site(scx + dx, scz + dz);
        if (s !== null) this.ensureDraws(s);
      }
    }
    this.prompt = this.findSignInteraction(pos);
  }

  /** Nearest signpost within reach → welcome-notice prompt. */
  private findSignInteraction(
    pos: Vec3,
  ): { label: string; act: () => void } | null {
    let best: { label: string; act: () => void } | null = null;
    let bestD = INTERACT_DIST;
    for (const { resolved } of this.active.values()) {
      for (const pad of resolved.pads) {
        if (pad.type !== 'signpost') continue;
        const d = Math.hypot(pos[0] - pad.wx, pos[2] - pad.wz);
        if (d <= bestD) {
          bestD = d;
          best = {
            label: 'Press E to read the sign',
            act: () => {
              this.notice = {
                text: `Welcome to ${resolved.name} (${resolved.site.kind})`,
                until: performance.now() + NOTICE_MS,
              };
            },
          };
        }
      }
    }
    return best;
  }

  /** Draw batches for settlements within draw distance. */
  draws(): DungeonDraw[] {
    const out: DungeonDraw[] = [];
    for (const { resolved, draws } of this.active.values()) {
      const d = Math.hypot(
        this.pos[0] - resolved.site.x, this.pos[2] - resolved.site.z);
      if (d <= SETTLEMENT_DRAW_DIST) out.push(...draws);
    }
    return out;
  }

  /** Resolved settlements meshed so far (collision + signposts). */
  nearby(): ResolvedSettlement[] {
    return [...this.active.values()].map((a) => a.resolved);
  }

  /** All resolved NPCs from meshed settlements within draw distance. */
  nearbyNpcs(): ResolvedNpc[] {
    const out: ResolvedNpc[] = [];
    for (const { resolved, npcs } of this.active.values()) {
      const d = Math.hypot(
        this.pos[0] - resolved.site.x, this.pos[2] - resolved.site.z);
      if (d <= SETTLEMENT_DRAW_DIST) out.push(...npcs);
    }
    return out;
  }

  // --- debug hooks (e2e) ---------------------------------------------------

  /** Nearest settlement site within ±`rings` cells of (x, z). */
  findNearestSite(x: number, z: number, rings = 4): SettlementSite | null {
    const scx0 = Math.floor(x / SCELL);
    const scz0 = Math.floor(z / SCELL);
    let best: SettlementSite | null = null;
    let bestD = Infinity;
    for (let dz = -rings; dz <= rings; dz++) {
      for (let dx = -rings; dx <= rings; dx++) {
        const s = this.site(scx0 + dx, scz0 + dz);
        if (s === null) continue;
        const d = Math.hypot(x - s.x, z - s.z);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
    }
    return best;
  }

  /** World position of a site's signpost (resolves the layout on the CPU). */
  signWorldPos(site: SettlementSite): [number, number, number] {
    const key = `${Math.floor(site.x / SCELL)},${Math.floor(site.z / SCELL)}`;
    const resolved = this.active.get(key)?.resolved
      ?? resolveSettlement(site, (x, z) => this.heightField.heightAt(x, z));
    const sign = resolved.pads.find((p) => p.type === 'signpost')!;
    return [sign.wx, sign.wy, sign.wz];
  }

  /** Name + kind of the nearest settlement (debug/e2e). */
  nearestSettlement(): { name: string; kind: string } | null {
    const site = this.findNearestSite(this.pos[0], this.pos[2]);
    if (site === null) return null;
    const key = `${Math.floor(site.x / SCELL)},${Math.floor(site.z / SCELL)}`;
    const resolved = this.active.get(key)?.resolved
      ?? resolveSettlement(site, (x, z) => this.heightField.heightAt(x, z));
    return { name: resolved.name, kind: site.kind };
  }

  /** Pure per-cell roll (settlement-scatter.ts); memoized. */
  private site(scx: number, scz: number): SettlementSite | null {
    const key = `${scx},${scz}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const found = settlementSiteAt(this.seed, scx, scz,
      (x, z) => this.heightField.heightAt(x, z));
    this.cache.set(key, found);
    return found;
  }

  private ensureDraws(site: SettlementSite): void {
    const key = `${Math.floor(site.x / SCELL)},${Math.floor(site.z / SCELL)}`;
    if (this.active.has(key)) return;
    if (this.lightsBindGroup === null) {
      // Surface shading never reads lights, but group 2 must be bound.
      const zero = this.renderer.device.createBuffer({
        label: 'settlement-zero-lights',
        size: LIGHTS_BUFFER_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.lightsBindGroup = this.renderer.createLightsBindGroup(zero);
    }
    const resolved = resolveSettlement(site,
      (x, z) => this.heightField.heightAt(x, z));
    const draws: DungeonDraw[] = buildSettlementMeshes(resolved).map(
      ({ palette, verts }) => {
        const vertexBuffer = this.renderer.device.createBuffer({
          label: `settlement-${key}-pal${palette}`,
          size: verts.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.renderer.device.queue.writeBuffer(vertexBuffer, 0, verts);
        // Meshes are world-space: zero offset, surface material 100+palette.
        const { bindGroup } =
          this.renderer.createObjectBindGroup(0, 0, 0, 100 + palette);
        return {
          draw: { vertexBuffer, indexBuffer: null, count: verts.length / 3, bindGroup },
          lightsBindGroup: this.lightsBindGroup!,
        };
      });
    // Spawn NPCs (settlement-local → world space).
    const spawnedNpcs = spawnSettlementNpcs(site.kind, site.seed, resolved);
    const npcs = resolveNpcs(
      spawnedNpcs, site.x, site.z,
      (x, z) => this.heightField.heightAt(x, z),
    );
    this.active.set(key, { resolved, draws, npcs });
  }
}
