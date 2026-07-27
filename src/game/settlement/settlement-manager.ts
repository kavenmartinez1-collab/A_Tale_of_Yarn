/**
 * SettlementManager — discovers settlement sites near the player (same lazy
 * 3×3-cell memoized scan as dungeon entrances), resolves + meshes each one on
 * first approach, and serves its palette-batched draws through the dungeon
 * pipeline (surface mode, zeroed lights) within draw distance. One draw per
 * palette in use: 5 for a ruin, 9 for a castle town (settlement-palette.ts).
 *
 * Also the registry for collision + signpost interaction (C-M4/5): `nearby()`
 * exposes the resolved settlements around a position.
 *
 * ## Buffer lifetime
 *
 * A castle town is ~77k verts — 1.7 MB of vertex buffer across 9 palette
 * batches, plus a 32-byte object uniform each — and it used to be built once
 * and kept forever. Nothing was ever evicted, so a long tour accumulated every
 * settlement the player had ever walked near and never gave any of it back.
 * The 32-byte uniforms were not even held: `createObjectBindGroup` returns the
 * buffer it made and this dropped it on the floor, so it was unreachable AND
 * un-freeable.
 *
 * This now follows `CastleManager`: every buffer is captured in `Resident` and
 * destroyed past `EVICT_DIST`, and rebuilt on approach. Rebuilds are
 * bit-identical because `buildSettlementMeshes` is a pure function of the
 * `ResolvedSettlement`, which is itself a pure function of the site — there is
 * no accumulated state for a second build to differ on.
 *
 * The CPU side goes at `FORGET_DIST`, further out because it is cheap to hold
 * and dearer to rebuild. That tier is what bounds this class rather than the
 * buffers: `nearbyCache` is rebuilt over `active` and read by the settlement
 * collider for every moving NPC, twice per sim step, so an `active` map that
 * only grows is the term that limits how many people the world can hold.
 *
 * `scripts/settlement-evict-check.mjs` proves all of it against the real game,
 * with instrumentation that lives entirely in the harness — it patches
 * `GPUBuffer.destroy` and `GPUQueue.writeBuffer` from outside, so the frees are
 * counted independently of what this class believes, and the rebuild is
 * compared byte for byte on its way to the GPU. Measured over a 14-settlement
 * tour: 20.3 MB freed across 480 buffers, peak residency 5 towns / 4.5 MB
 * instead of all 17 at once, and every rebuilt buffer hashing identically.
 */

import type { Vec3 } from '../math';
import { createHeightField, type HeightField } from '../noise';
import { LIGHTS_BUFFER_SIZE, STRIDE_PROP, type DungeonDraw, type Renderer } from '../renderer';
import { settlementSiteAt, SCELL, type SettlementSite } from './settlement-scatter';
import { resolveSettlement, type ResolvedSettlement } from './settlement-layout';
import { buildSettlementMeshes, type SettlementFlame } from './settlement-mesh';
import {
  spawnSettlementNpcs, resolveNpcs, type ResolvedNpc,
} from '../npc/npc-spawn';
import { sharedRoadNetwork, type RoadNetwork } from '../world/roads';
import { travellersInCell } from '../world/road-travellers';

// Same reach as dungeon entrance arches (m) — must stay inside the terrain
// stream radius (384 m) so buildings never float over unloaded ground.
const SETTLEMENT_DRAW_DIST = 360;
const INTERACT_DIST = 3;          // E-key reach to a signpost (m, XZ)
const NOTICE_MS = 4000;

/**
 * Build well before the town is visible, free long after it is not.
 *
 * `BUILD_DIST` is deliberately about twice `SETTLEMENT_DRAW_DIST`. Meshing a
 * castle town is 13.9 ms of solid CPU — most of a frame — so the one place it
 * must not happen is the moment the town comes into view. At 700 m the player
 * still has the better part of a minute of walking before the first roof
 * appears, and the cost lands where nothing on screen is changing.
 *
 * `EVICT_DIST` is then wide of that, not of the draw distance. The gap has to
 * be big enough that ordinary play cannot oscillate across it: 400 m is a long
 * walk back and forth, and a player who does pace it pays one rebuild, not one
 * a second. It also sits just outside the 3x3 cell scan's reach (a settlement
 * in a diagonal neighbour cell can be ~1086 m away), so a site that is
 * discovered but too far to build is never built and then freed either — it
 * simply never becomes resident.
 *
 * ## Why there are two eviction distances
 *
 * Measured on a castle town in node, the two halves of a rebuild cost very
 * differently:
 *
 *     resolveSettlement       8.3 ms   (layout, plans, the street solver)
 *     buildSettlementMeshes  13.9 ms   (77k verts across 9 palette batches)
 *     spawn + resolve NPCs    0.2 ms
 *
 * The GPU buffers are 1.97 MB and the thing actually worth reclaiming; the
 * resolved layout is CPU objects and cheap to hold. So `EVICT_DIST` frees the
 * buffers and keeps the layout, and `FORGET_DIST` drops the layout too, so that
 * nothing is unbounded.
 *
 * That split is worth its complexity, measured in the real game by
 * `settlement-evict-check.mjs` as the worst frame spanning a 100 m step across
 * `BUILD_DIST`, against a control that steps the same 100 m with nothing left
 * to build:
 *
 *     control (nothing to build)   21.0 ms
 *     warm  (past EVICT_DIST)      39.4 ms   -> 18.4 ms of rebuild
 *     cold  (past FORGET_DIST)     47.3 ms   -> 26.3 ms of rebuild
 *
 * Keeping the layout halves the cost of coming back. Neither is free, and this
 * is honest about that: a rebuild IS a dropped frame. What `BUILD_DIST` buys is
 * where it lands — 680 m out, with the town still 320 m short of drawing, on a
 * frame where nothing on screen is changing. The old code paid the same price
 * once per settlement per session and called it "a one-off hitch on first
 * approach"; this pays it again only after the player has walked 1.1 km away.
 */
const BUILD_DIST = 700;
const EVICT_DIST = 1100;
const FORGET_DIST = 3000;

/** GPU-resident half of a settlement. Null once evicted; rebuilt identically. */
interface Resident {
  draws: DungeonDraw[];
  /** Every buffer this settlement owns — vertex and object uniform alike. */
  buffers: GPUBuffer[];
  verts: number;
}

interface Active {
  resolved: ResolvedSettlement;
  npcs: ResolvedNpc[];
  /** World-space brazier / gate-torch / lantern anchors for the fire system. */
  flames: SettlementFlame[];
  resident: Resident | null;
}

export class SettlementManager {
  private readonly cache = new Map<string, SettlementSite | null>();
  private readonly active = new Map<string, Active>();
  private lightsBindGroup: GPUBindGroup | null = null;
  private zeroLights: GPUBuffer | null = null;
  private pos: Vec3 = [0, 0, 0];
  private prompt: { label: string; act: () => void } | null = null;
  private notice: { text: string; until: number } | null = null;

  /**
   * Road travellers, keyed by the settlement cell that owns their station.
   * Built once per cell on first approach and kept, the same as settlements —
   * a party is a pure function of the road under it, so a cached cell can never
   * disagree with a fresh one.
   */
  private readonly travellers = new Map<string, ResolvedNpc[]>();
  /** The 3x3 cell window whose travellers are currently live, as a cell key. */
  private travellerWindow = '';
  private liveTravellers: ResolvedNpc[] = [];
  private roadsLazy: RoadNetwork | null = null;

  /**
   * Cached view of `active`, rebuilt only when a settlement is added.
   *
   * Not a micro-optimisation. `nearby()` is the source for the settlement
   * collider, which every moving NPC hits twice per sim step through
   * `npcMove` -> `moveXZ`/`groundHeight`. Building two arrays over every
   * settlement ever visited, per NPC, per tick, at 60 Hz is the term that
   * actually limits how many people the world can hold — and nothing is ever
   * evicted from `active`, so it grows for the whole session.
   */
  private nearbyCache: ResolvedSettlement[] = [];
  /** Cached `nearbyNpcs()` result, keyed by which settlements are in range. */
  private npcsCache: ResolvedNpc[] | null = null;
  private npcsSig = '';

  constructor(
    private readonly renderer: Renderer,
    private readonly heightField: HeightField,
    private readonly seed: number,
  ) {}

  /**
   * The road graph, for placing travellers. Shared per seed with the chunk
   * manager, which has normally built and warmed it long before this runs.
   *
   * Built from a fresh BASE field rather than the one handed to this manager,
   * because a road network must never be derived from a carved one — see
   * `carveRoads`. `sharedRoadNetwork` keys on the seed, so in practice this
   * returns the chunk manager's instance and the field is never consulted.
   */
  private get roads(): RoadNetwork {
    if (this.roadsLazy === null) {
      this.roadsLazy = sharedRoadNetwork(this.seed, createHeightField(this.seed));
    }
    return this.roadsLazy;
  }

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

  /** Per-tick: discover + mesh settlements in the 3×3 cells around pos, and
   *  free the ones the player has walked away from. */
  update(pos: Vec3): void {
    this.pos = pos;
    const scx = Math.floor(pos[0] / SCELL);
    const scz = Math.floor(pos[2] / SCELL);
    // At most one settlement per tick. Building a castle town is ~35 ms and
    // three can enter build range together where cells cluster; serialising
    // them turns one 100 ms stall into three ordinary frames, at the cost of
    // two frames of latency 700 m from anything the player can see.
    let built = false;
    for (let dz = -1; dz <= 1 && !built; dz++) {
      for (let dx = -1; dx <= 1 && !built; dx++) {
        const s = this.site(scx + dx, scz + dz);
        if (s === null || this.distanceTo(s.x, s.z) > BUILD_DIST) continue;
        built = this.ensureDraws(s);
      }
    }
    this.evictFar();
    this.updateTravellers(scx, scz);
    this.prompt = this.findSignInteraction(pos);
  }

  private distanceTo(x: number, z: number): number {
    return Math.hypot(this.pos[0] - x, this.pos[2] - z);
  }

  /**
   * Free buffers past `EVICT_DIST`, and whole entries past `FORGET_DIST`.
   *
   * Walks the whole map rather than the 3x3 window, because the entry that
   * needs freeing is by definition the one the player has left: it is no longer
   * in any cell this tick looks at. `active` is at most a few dozen entries, so
   * this is a handful of distance tests.
   *
   * Everything dropped at either tier is a pure function of the site, so a
   * re-approach cannot produce a different town — which is the whole reason
   * eviction is safe here and would not be for anything the player can change.
   */
  private evictFar(): void {
    let dropped = false;
    for (const [key, a] of this.active) {
      const d = this.distanceTo(a.resolved.site.x, a.resolved.site.z);
      if (d <= EVICT_DIST) continue;
      if (this.free(a)) dropped = true;
      if (d > FORGET_DIST) {
        this.active.delete(key);
        dropped = true;
      }
    }
    if (dropped) this.refreshViews();
  }

  /** Destroy a settlement's GPU buffers. Idempotent; true if anything went. */
  private free(a: Active): boolean {
    if (a.resident === null) return false;
    for (const b of a.resident.buffers) b.destroy();
    a.resident = null;
    return true;
  }

  /**
   * Rebuild the views derived from `active`.
   *
   * `nearbyCache` lists only RESIDENT settlements, not every entry. It is the
   * source for the settlement collider, which every moving NPC hits twice per
   * sim step, so its length is the term that limits how many people the world
   * can hold — and a non-resident settlement is at least 1.1 km away, far
   * outside the `radius + 4` the collider filters on, so it could never have
   * contributed anything but a distance test.
   */
  private refreshViews(): void {
    const out: ResolvedSettlement[] = [];
    for (const a of this.active.values()) {
      if (a.resident !== null) out.push(a.resolved);
    }
    this.nearbyCache = out;
    this.npcsCache = null;
    this.publishDebug();
  }

  /**
   * Free every settlement and the shared zero-lights buffer. Teardown only —
   * `EVICT_DIST` handles the steady state.
   */
  dispose(): void {
    for (const a of this.active.values()) this.free(a);
    this.active.clear();
    this.zeroLights?.destroy();
    this.zeroLights = null;
    this.lightsBindGroup = null;
    this.refreshViews();
  }

  /**
   * Road travellers for the 3x3 cells around the player.
   *
   * Membership is deliberately snapped to the cell grid rather than filtered by
   * distance. main.ts sets `npcsDirty` whenever the nearby-NPC *count* changes,
   * and a rebuild restores every NPC — settlers included — to their spawn
   * position. A per-traveller distance test would trip that every few seconds
   * on a road, and every visible NPC would twitch each time. Snapping to cells
   * makes it once per 512 m of travel instead, which is the cadence the world
   * already streams at.
   */
  private updateTravellers(scx: number, scz: number): void {
    const window = `${scx},${scz}`;
    if (window === this.travellerWindow) return;
    this.travellerWindow = window;
    const live: ResolvedNpc[] = [];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const key = `${scx + dx},${scz + dz}`;
        let cell = this.travellers.get(key);
        if (cell === undefined) {
          cell = travellersInCell(this.seed, scx + dx, scz + dz, this.roads);
          this.travellers.set(key, cell);
        }
        for (const t of cell) live.push(t);
      }
    }
    this.liveTravellers = live;
    this.npcsCache = null;
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
    for (const { resolved, resident } of this.active.values()) {
      if (resident === null) continue;
      const d = Math.hypot(
        this.pos[0] - resolved.site.x, this.pos[2] - resolved.site.z);
      if (d <= SETTLEMENT_DRAW_DIST) out.push(...resident.draws);
    }
    return out;
  }

  // --- debug hooks (e2e / eviction harness) --------------------------------

  /**
   * What the manager is holding right now, for
   * `scripts/settlement-evict-check.mjs`.
   *
   * Republished whenever residency changes rather than polled, following
   * `BuildingManager.publishDebug` — so it costs nothing per frame, and a
   * harness that reads it between teleports always sees a settled answer
   * rather than a half-built one.
   *
   * `bytes` is the number that matters: it is the sum of `GPUBuffer.size` over
   * everything this class would have to destroy, which is exactly what leaked.
   */
  private publishDebug(): void {
    let buffers = 0, bytes = 0, resident = 0, verts = 0;
    const towns: { key: string; kind: string; bytes: number }[] = [];
    for (const [key, a] of this.active) {
      if (a.resident === null) continue;
      resident++;
      verts += a.resident.verts;
      let b = 0;
      for (const buf of a.resident.buffers) b += buf.size;
      buffers += a.resident.buffers.length;
      bytes += b;
      towns.push({ key, kind: a.resolved.site.kind, bytes: b });
    }
    (globalThis as { __settlementDebug?: unknown }).__settlementDebug = {
      /** Settlements with GPU buffers held. */
      resident,
      /** Settlements whose CPU layout is kept (resident or merely remembered). */
      remembered: this.active.size,
      buffers,
      bytes,
      verts,
      towns,
    };
  }

  /**
   * Brazier / gate-torch / lantern anchors within draw distance, for the
   * billboard fire system. Culled the same way `draws()` is.
   */
  flamePoints(): SettlementFlame[] {
    const out: SettlementFlame[] = [];
    for (const { resolved, flames, resident } of this.active.values()) {
      if (resident === null || flames.length === 0) continue;
      const d = Math.hypot(
        this.pos[0] - resolved.site.x, this.pos[2] - resolved.site.z);
      if (d <= SETTLEMENT_DRAW_DIST) out.push(...flames);
    }
    return out;
  }

  /** Resolved settlements meshed so far (collision + signposts). */
  nearby(): ResolvedSettlement[] {
    return this.nearbyCache;
  }

  /**
   * Everyone near the player: the NPCs of settlements within draw distance,
   * plus the road travellers of the live 3x3 cell window.
   *
   * Cached on the set of in-range settlements. This is called twice per frame
   * by main.ts purely to compare its length against last frame's, and the
   * result was a fresh array plus a spread per settlement, 120 times a second.
   * The cache is only invalidated when the answer would actually differ, so
   * those two calls now cost a handful of distance tests.
   */
  nearbyNpcs(): ResolvedNpc[] {
    // Membership signature: which settlements are in range right now. Built
    // from the insertion-ordered map, so equal membership always gives an
    // equal signature. Keys are joined with a separator that cannot occur in a
    // cell key, so no key can be a substring of another's run.
    let sig = '';
    for (const [key, { resolved }] of this.active) {
      const dx = this.pos[0] - resolved.site.x;
      const dz = this.pos[2] - resolved.site.z;
      if (dx * dx + dz * dz <= SETTLEMENT_DRAW_DIST * SETTLEMENT_DRAW_DIST) {
        sig += `${key}|`;
      }
    }
    if (this.npcsCache !== null && sig === this.npcsSig) return this.npcsCache;
    const out: ResolvedNpc[] = [];
    for (const { resolved, npcs } of this.active.values()) {
      const dx = this.pos[0] - resolved.site.x;
      const dz = this.pos[2] - resolved.site.z;
      if (dx * dx + dz * dz > SETTLEMENT_DRAW_DIST * SETTLEMENT_DRAW_DIST) continue;
      for (const n of npcs) out.push(n);
    }
    for (const t of this.liveTravellers) out.push(t);
    this.npcsSig = sig;
    this.npcsCache = out;
    return out;
  }

  /** How many road travellers are live in the current cell window (debug). */
  get travellerCount(): number {
    return this.liveTravellers.length;
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

  /** Build (or rebuild) a settlement's GPU half. True if it did any work. */
  private ensureDraws(site: SettlementSite): boolean {
    const key = `${Math.floor(site.x / SCELL)},${Math.floor(site.z / SCELL)}`;
    const hit = this.active.get(key);
    if (hit !== undefined && hit.resident !== null) return false;
    if (this.lightsBindGroup === null) {
      // Surface shading never reads lights, but group 2 must be bound. One
      // zeroed buffer serves every settlement, so it outlives eviction and is
      // freed only by `dispose()`.
      this.zeroLights = this.renderer.device.createBuffer({
        label: 'settlement-zero-lights',
        size: LIGHTS_BUFFER_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.lightsBindGroup = this.renderer.createLightsBindGroup(this.zeroLights);
    }
    // Within `FORGET_DIST` the resolved layout survived eviction, so a rebuild
    // reuses it: same object, so the collider's solids cache (a WeakMap keyed
    // on it) survives the round trip too, and the 8.3 ms street solver is not
    // paid twice. Past it there is nothing kept and this resolves afresh —
    // which lands on exactly the same layout, because it is a pure function of
    // the site.
    const flames: SettlementFlame[] = [];
    const resolved = hit?.resolved ?? resolveSettlement(site,
      (x, z) => this.heightField.heightAt(x, z));
    const buffers: GPUBuffer[] = [];
    let verts = 0;
    const draws: DungeonDraw[] = buildSettlementMeshes(resolved, flames).map(
      (part) => {
        const vertexBuffer = this.renderer.device.createBuffer({
          label: `settlement-${key}-pal${part.palette}`,
          size: part.verts.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.renderer.device.queue.writeBuffer(vertexBuffer, 0, part.verts);
        buffers.push(vertexBuffer);
        verts += part.verts.length / (STRIDE_PROP / 4);
        // Meshes are world-space: zero offset, surface material 100+palette.
        // The object uniform is captured too — it is only 32 bytes, but one per
        // palette per settlement forever is still a leak, and it used to be
        // dropped here unreferenced, which made it impossible to free at all.
        const { bindGroup, buffer, shadowBindGroup } =
          this.renderer.createObjectBindGroup(0, 0, 0, 100 + part.palette);
        buffers.push(buffer);
        return {
          draw: {
            vertexBuffer, indexBuffer: null,
            count: part.verts.length / (STRIDE_PROP / 4),
            bindGroup, shadowBindGroup,
          },
          lightsBindGroup: this.lightsBindGroup!,
        };
      });
    const resident: Resident = { draws, buffers, verts };
    if (hit !== undefined) {
      hit.resident = resident;
      hit.flames = flames;
    } else {
      // Spawn NPCs (settlement-local → world space).
      const spawnedNpcs = spawnSettlementNpcs(site.kind, site.seed, resolved);
      const npcs = resolveNpcs(
        spawnedNpcs, site.x, site.z,
        (x, z) => this.heightField.heightAt(x, z),
        resolved.name,
      );
      this.active.set(key, { resolved, npcs, flames, resident });
    }
    // Residency changed either way, and `nearbyCache` lists only residents.
    this.refreshViews();
    return true;
  }
}
