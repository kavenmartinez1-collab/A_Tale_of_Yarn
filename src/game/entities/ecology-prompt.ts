/**
 * Ecology prompt builder — pure functions, node-testable (no engine, no DOM).
 *
 * The prompt teaches the EcologySpec schema BY EXAMPLE (small models follow
 * examples better than JSON-Schema prose) and imports the species catalogue
 * and ECOLOGY_FIXTURES from their source-of-truth modules so the prompt can
 * never drift from the validator.
 *
 * All brief inputs are seed-derived (mix32) so the same (seed, ecx, ecz)
 * always produces the same prompt — with greedy decoding, the same ecology.
 */

import type { Biome } from '../biome';
import { SPECIES_DEFS } from './entity-types';
import {
  ECOLOGY_PROMPT_VERSION,
  ECOLOGY_FIXTURES,
} from './ecology-spec';
import { mix32 } from '../dungeon/dungeon-layout';

// Re-export so callers can wire extractSpecJson without touching this file.
export { extractSpecJson } from '../director/director-prompt';

/** Bump when the prompt changes materially — invalidates persisted specs. */
export { ECOLOGY_PROMPT_VERSION };

export interface ChatMessage {
  role: string;
  content: string;
}

export interface EcologyBrief {
  seed: number;
  ecx: number;
  ecz: number;
  /** Deduplicated biomes present in this cell. */
  biomes: Biome[];
  /** 2 seed-derived flavor words for variety under greedy decoding. */
  flavorWords: string[];
}

// ── Flavor word table (ecology-flavored, distinct from dungeon table) ────────

const FLAVOR_TABLE = [
  'verdant', 'parched', 'teeming', 'desolate', 'mist-shrouded', 'windswept',
  'sunbaked', 'overgrown', 'frost-touched', 'humid', 'barren', 'lush',
  'shadowed', 'storm-swept', 'tranquil', 'untamed',
];

// ── Brief builder ─────────────────────────────────────────────────────────────

export function buildEcologyBrief(
  seed: number,
  ecx: number,
  ecz: number,
  biomes: Biome[],
): EcologyBrief {
  const a = mix32(seed ^ 0xe0c010a1, ecx, ecz) % FLAVOR_TABLE.length;
  let b = mix32(seed ^ 0xe0c010a2, ecx, ecz) % (FLAVOR_TABLE.length - 1);
  if (b >= a) b++; // ensure distinct second word
  return {
    seed,
    ecx,
    ecz,
    biomes,
    flavorWords: [FLAVOR_TABLE[a], FLAVOR_TABLE[b]],
  };
}

// ── System prompt helpers ─────────────────────────────────────────────────────

/** Build the compact species-biome reference shown in the hard-rules section. */
function speciesReference(): string {
  const lines: string[] = [];
  for (const [sp, def] of Object.entries(SPECIES_DEFS)) {
    const rareTag = def.rare ? ' [RARE]' : '';
    lines.push(`  ${sp}${rareTag}: biomes=${def.biomes.join(',')}`);
  }
  return lines.join('\n');
}

function systemPrompt(): string {
  const exampleA = JSON.stringify(ECOLOGY_FIXTURES[0]);
  const exampleB = JSON.stringify(ECOLOGY_FIXTURES[1]);

  return `You are the AI Ecologist of an open-world game. You design the wildlife for map cells as JSON specs. You always reply with a single fenced \`\`\`json block and no other text.

An ecology spec has exactly this shape:
{"version": 1, "mood": "<1-40 char flavor string>", "herds": [{"species": "<species id>", "count": <1-6>}]}

Hard rules (specs that break them are rejected):
- version must be 1.
- mood: non-empty string, max 40 characters.
- herds: 0 to 5 entries; empty array is valid (barren cell).
- Each species must be from the list below; no duplicate species entries.
- count: integer 1–6 per herd; total individuals across all herds ≤ 14.
- RARE species (marked [RARE]): at most ONE rare herd per cell, count must be exactly 1.
- Every species must be admissible for at least one of the cell's biomes.
- sea_serpent is only admissible when "ocean" is among the cell biomes.

Species catalogue (species_id [RARE if rare]: biomes=admissible biomes):
${speciesReference()}

Example:
\`\`\`json
${exampleA}
\`\`\`

Example:
\`\`\`json
${exampleB}
\`\`\``;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Build the full message array for a fresh ecology request. */
export function buildEcologyMessages(brief: EcologyBrief): ChatMessage[] {
  const user =
    `Design the wildlife for this cell.\n` +
    `Biomes present: ${brief.biomes.join(', ')}\n` +
    `Flavor words: ${brief.flavorWords.join(', ')}\n` +
    `Reply with EXACTLY one fenced \`\`\`json block and nothing else.`;

  return [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: user },
  ];
}

/** Retry message fed back to the model after validation failure. */
export function buildEcologyRetryMessage(errors: string[]): string {
  return `Your ecology spec was rejected:\n` +
    `${errors.map((e) => `- ${e}`).join('\n')}\n` +
    `Fix every problem and reply again with EXACTLY one fenced \`\`\`json block and nothing else.`;
}
