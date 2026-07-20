/**
 * EcologyDirector — synchronous, seeded EcologySpec authoring for entity
 * cells.
 *
 * Formerly an LLM pipeline (queue, retries, localStorage persistence). Herd
 * composition is invisible background data the player never reads, so a
 * deterministic generator gives the same variety at zero GPU cost and zero
 * latency — the model now serves NPC dialogue and dungeon dreaming only.
 *
 * Determinism makes persistence unnecessary: the same (seed, ecx, ecz)
 * always yields the same spec, on every visit and reload.
 *
 * ?director=off → ECOLOGY_FALLBACK everywhere (used by deterministic E2E
 * probes that assert exact entity counts).
 */

import {
  type EcologySpec, ECOLOGY_FALLBACK, proceduralEcologySpec,
} from './ecology-spec';
import type { Biome } from '../biome';

export interface EcologyDirectorOptions {
  seed: number;
  disabled?: boolean;
}

export class EcologyDirector {
  private readonly seed: number;
  private readonly disabled: boolean;

  constructor(opts: EcologyDirectorOptions) {
    this.seed = opts.seed;
    this.disabled = opts.disabled ?? false;
  }

  /** Return the deterministic EcologySpec for this cell. */
  specFor(ecx: number, ecz: number, biomes: Biome[]): EcologySpec {
    if (this.disabled) return ECOLOGY_FALLBACK(biomes);
    return proceduralEcologySpec(this.seed, ecx, ecz, biomes);
  }
}
