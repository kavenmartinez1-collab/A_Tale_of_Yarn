/**
 * Persisted Director specs — localStorage keyed by (spec version, prompt
 * version, world seed, dungeon cell). Persistence is what upholds the
 * determinism contract with a nondeterministic author: once a spec resolves
 * for a cell (LLM or fallback), re-entry and reloads reproduce it.
 *
 * Version bumps change the key, so stale entries simply never match again.
 * Reads re-run validateSpec — corrupt/stale entries degrade to null, never
 * crash. Storage is injectable for node unit tests.
 */

import { validateSpec, type DungeonSpec } from '../dungeon/dungeon-spec';
import { PROMPT_VERSION } from './director-prompt';

export const STORE_PREFIX = 'artifex-director:';

/** Matches DungeonSpec.version — part of the key for invalidation. */
const SPEC_VERSION = 1;

export interface StoredSpec {
  spec: DungeonSpec;
  source: 'llm' | 'fallback';
  savedAt: number;
}

export interface SpecStore {
  load(seed: number, dcx: number, dcz: number): StoredSpec | null;
  save(seed: number, dcx: number, dcz: number, entry: StoredSpec): void;
}

export function storeKey(seed: number, dcx: number, dcz: number): string {
  return `${STORE_PREFIX}v${SPEC_VERSION}.${PROMPT_VERSION}:${seed >>> 0}:${dcx},${dcz}`;
}

export function createSpecStore(storage?: Storage): SpecStore {
  const backing = storage
    ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  return {
    load(seed, dcx, dcz) {
      if (!backing) return null;
      let raw: string | null;
      try {
        raw = backing.getItem(storeKey(seed, dcx, dcz));
      } catch {
        return null;
      }
      if (raw === null) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }
      if (typeof parsed !== 'object' || parsed === null) return null;
      const o = parsed as Record<string, unknown>;
      if (o.source !== 'llm' && o.source !== 'fallback') return null;
      const result = validateSpec(o.spec);
      if ('errors' in result) return null;
      return {
        spec: result.spec,
        source: o.source,
        savedAt: typeof o.savedAt === 'number' ? o.savedAt : 0,
      };
    },
    save(seed, dcx, dcz, entry) {
      if (!backing) return;
      try {
        backing.setItem(storeKey(seed, dcx, dcz), JSON.stringify(entry));
      } catch {
        // Quota or privacy mode — specs regenerate next session; not fatal.
      }
    },
  };
}
