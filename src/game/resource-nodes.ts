/**
 * Harvested-node registry — pure model tracking which resource nodes
 * (rocks/bushes/trees) are currently gathered and when they respawn.
 * Node ids are deterministic ("cx,cz:r3" for resources, "cx,cz:t5" for
 * trees), so only the harvested set needs persisting.
 *
 * Respawn uses wall-clock ms so it survives reloads; stale entries are
 * pruned on load and on query.
 */

export const NODES_KEY = 'artifex-nodes:v1';
export const RESPAWN_MS = 3 * 60_000; // gathered nodes return after 3 min

export class NodeRegistry {
  /** node id → wall-clock ms when the node respawns. */
  private readonly harvested = new Map<string, number>();

  /** True while the node is gone (harvested and not yet respawned). */
  isHarvested(id: string, now: number): boolean {
    const until = this.harvested.get(id);
    if (until === undefined) return false;
    if (now >= until) {
      this.harvested.delete(id);
      return false;
    }
    return true;
  }

  /** Mark a node gathered. Returns false if it was already harvested. */
  harvest(id: string, now: number): boolean {
    if (this.isHarvested(id, now)) return false;
    this.harvested.set(id, now + RESPAWN_MS);
    return true;
  }

  /** Earliest wall-clock ms at which any harvested node respawns, or null. */
  nextRespawn(): number | null {
    let min: number | null = null;
    for (const until of this.harvested.values()) {
      if (min === null || until < min) min = until;
    }
    return min;
  }

  serialize(): string {
    return JSON.stringify(Object.fromEntries(this.harvested));
  }

  /** Load from JSON, dropping malformed and already-respawned entries. */
  static deserialize(json: string, now: number): NodeRegistry {
    const reg = new NodeRegistry();
    let x: unknown;
    try {
      x = JSON.parse(json);
    } catch {
      return reg;
    }
    if (typeof x !== 'object' || x === null || Array.isArray(x)) return reg;
    for (const [id, until] of Object.entries(x)) {
      if (typeof until === 'number' && Number.isFinite(until) && until > now) {
        reg.harvested.set(id, until);
      }
    }
    return reg;
  }
}

export function loadNodeRegistry(now = Date.now()): NodeRegistry {
  try {
    const raw = localStorage.getItem(NODES_KEY);
    if (raw !== null) return NodeRegistry.deserialize(raw, now);
  } catch { /* storage unavailable */ }
  return new NodeRegistry();
}

export function saveNodeRegistry(reg: NodeRegistry): void {
  try {
    localStorage.setItem(NODES_KEY, reg.serialize());
  } catch { /* storage unavailable */ }
}
