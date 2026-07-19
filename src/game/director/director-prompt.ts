/**
 * Director prompt builder — pure functions, node-testable (no engine, no DOM).
 *
 * The prompt teaches the DungeonSpec schema BY EXAMPLE (small models follow
 * examples better than JSON-Schema prose) and imports the enum lists and
 * KNOWN_ITEMS from dungeon-spec.ts so the prompt can never drift from the
 * validator. Few-shots are reused from DUNGEON_FIXTURES (guaranteed valid).
 *
 * All brief inputs are seed-derived (mix32) so the same (seed, dcx, dcz)
 * always produces the same prompt — with greedy decoding, the same dungeon.
 */

import { KNOWN_ITEMS, type DungeonTheme } from '../dungeon/dungeon-spec';
import { DUNGEON_FIXTURES } from '../dungeon/dungeon-fixtures';
import { mix32 } from '../dungeon/dungeon-layout';

/** Bump when the prompt changes materially — invalidates persisted specs. */
export const PROMPT_VERSION = 3;

export interface ChatMessage {
  role: string;
  content: string;
}

export interface DungeonBrief {
  seed: number;
  dcx: number;
  dcz: number;
  /** Seed-derived theme suggestion (the model may keep or change it). */
  themeHint: DungeonTheme;
  /** 2 seed-derived inspiration words for variety under greedy decoding. */
  flavorWords: string[];
  /** Terrain height at the entrance (meters above sea level). */
  entranceHeight: number;
}

const THEME_TABLE: DungeonTheme[] = ['crypt', 'cave', 'ruin'];

const FLAVOR_TABLE = [
  'ashen', 'drowned', 'whispering', 'shattered', 'gilded', 'frozen',
  'feral', 'hollow', 'forsaken', 'ember', 'moonlit', 'buried',
  'rusted', 'silent', 'blighted', 'crowned',
];

export function buildBrief(
  seed: number, dcx: number, dcz: number, entranceY: number,
): DungeonBrief {
  const themeHint = THEME_TABLE[mix32(seed ^ 0xd1ec7031, dcx, dcz) % THEME_TABLE.length];
  const a = mix32(seed ^ 0xf1a70a01, dcx, dcz) % FLAVOR_TABLE.length;
  let b = mix32(seed ^ 0xf1a70a02, dcx, dcz) % (FLAVOR_TABLE.length - 1);
  if (b >= a) b++; // distinct second word
  return {
    seed, dcx, dcz, themeHint,
    flavorWords: [FLAVOR_TABLE[a], FLAVOR_TABLE[b]],
    entranceHeight: entranceY,
  };
}

function terrainNote(h: number): string {
  if (h >= 20) return 'high in the windswept hills';
  if (h >= 8) return 'on rolling grassland';
  return 'in the lowlands near the shore';
}

/** System prompt: role + schema-by-example + validator hard rules + few-shots. */
function systemPrompt(): string {
  // One small (4-room crypt) and one larger (6-room cave) few-shot.
  const exampleA = JSON.stringify(DUNGEON_FIXTURES[0]);
  const exampleB = JSON.stringify(DUNGEON_FIXTURES[1]);
  return `You are the AI Director of an open-world adventure game. You design dungeons as JSON specs. You always reply with a single fenced \`\`\`json block and no other text.

A dungeon spec has exactly this shape:
{"version": 1, "theme": "<crypt|cave|ruin>", "name": "<evocative name>", "rooms": [{"id": "<short id>", "type": "<entrance|combat|treasure|boss>", "size": "<small|medium|large>", "loot": ["<item id>"]}], "edges": [["<idA>", "<idB>"]]}

Hard rules (specs that break them are rejected):
- 2 to 12 rooms; every id unique, max 24 chars; name max 60 chars.
- Exactly one room of type "entrance"; at most one "boss".
- "loot" is optional, max 4 items per room, item ids only from: ${KNOWN_ITEMS.join(', ')}.
- "edges" connect existing room ids; no self-loops, no duplicate edges; every room must be reachable from the entrance.

Example:
\`\`\`json
${exampleA}
\`\`\`

Example:
\`\`\`json
${exampleB}
\`\`\``;
}

export function buildDirectorMessages(brief: DungeonBrief): ChatMessage[] {
  const user = `Design one new dungeon.
Theme: ${brief.themeHint}
Inspiration words: ${brief.flavorWords.join(', ')}
Location: the entrance stands ${terrainNote(brief.entranceHeight)}.
Invent an evocative name and 3 to 9 rooms with interesting connections and loot.
Reply with EXACTLY one fenced \`\`\`json block and nothing else.`;
  return [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: user },
  ];
}

export function buildRetryMessage(errors: string[]): string {
  return `Your spec was rejected:
${errors.map((e) => `- ${e}`).join('\n')}
Fix every problem and reply again with EXACTLY one fenced \`\`\`json block and nothing else.`;
}

/**
 * Pull candidate spec JSON out of a model reply. Takes the LAST fenced block
 * (skips leaked <think> prose and echoed examples); tolerates a missing
 * closing fence (max_length truncation surfaces as a parse error). When no
 * fence exists at all, falls back to the last balanced {...} in the text.
 */
export function extractSpecJson(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const fences = [...text.matchAll(/```[a-zA-Z_]*[ \t]*\r?\n([\s\S]*?)(?:```|$)/g)];
  if (fences.length > 0) {
    const body = fences[fences.length - 1][1].trim();
    try {
      return { ok: true, value: JSON.parse(body) };
    } catch (err) {
      return { ok: false, error: `fenced block is not valid JSON: ${err}` };
    }
  }
  // No fence: scan for the last balanced top-level {...} that parses.
  let last: unknown;
  let found = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            last = JSON.parse(text.slice(i, j + 1));
            found = true;
          } catch { /* not JSON — keep scanning */ }
          i = j;
          break;
        }
      }
    }
  }
  if (found) return { ok: true, value: last };
  return { ok: false, error: 'reply contains no ```json block and no parseable JSON object' };
}
