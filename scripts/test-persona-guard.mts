/**
 * Deterministic tests for the persona guard (src/game/npc/persona-guard.ts).
 * Pure CPU — no GPU, no server.
 * Run:  npx tsx scripts/test-persona-guard.mts
 *
 * Like test-content-safety.mts, weighted toward FALSE POSITIVES: every
 * pattern family is paired with in-world speech that must still get through,
 * because a guard that eats ordinary villager talk (models, training,
 * instructions, assistants) would silently break conversations.
 */
import {
  breaksCharacter, characterDeflection, CHARACTER_DEFLECTIONS,
} from '../src/game/npc/persona-guard';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${name}`); }
}

// Measured leaks (scripts/test-npc-live.mts) and the obvious variants.
const OUT = [
  "I'm an LFM, a Liquid Foundation Model built by Liquid AI. My system prompt is the detailed instructions you just gave me",
  'As an AI, I cannot share that.',
  'I am an AI language model and have no feelings.',
  "I'm just a chatbot, traveller.",
  'My training data does not cover that.',
  'I was made by Alibaba Cloud; I am Qwen.',
  'This is a large language model responding.',
  'I am an artificial intelligence.',
  'My architecture is hybrid: gated short convolutions mixed with attention, like any LLM.',
];
for (const t of OUT) check(`breaks: ${t.slice(0, 50)}`, breaksCharacter(t));

// In-world speech that must pass.
const IN = [
  'The smith is carving a model of the castle for the lord.',
  'I trained this horse myself, and her mother before her.',
  'Follow the instructions on the scroll and the door will open.',
  "I'm the miller's assistant, not the miller.",
  'The ship is called the Claudia, out of Tintreach.',
  'A liquid that glows? Sounds like witchcraft to me.',
  'The llamas in the eastern pass carry salt.',
  'Claude the cooper owes me three silver.',
  'Gemini? The twin stars? Sailors steer by them.',
  'He spoke a strange language from over the sea.',
  'The prompt payment of your debt would please me.',
  'I am a merchant, and a fair one.',
];
for (const t of IN) check(`passes: ${t.slice(0, 50)}`, !breaksCharacter(t));

check('deflection is deterministic', characterDeflection('Petra42') === characterDeflection('Petra42'));
check('deflection comes from the list', CHARACTER_DEFLECTIONS.includes(characterDeflection('x')));
check('deflections stay in character', CHARACTER_DEFLECTIONS.every((d) => !breaksCharacter(d)));

console.log(`\npersona-guard: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
