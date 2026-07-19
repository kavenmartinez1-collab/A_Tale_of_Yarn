/**
 * M0 helper — prints the real Director prompts (seed 1337, five cells with
 * varied flavor/terrain) so they can be pasted into the index.html chat app
 * for the coherence gate. Run: npx tsx scripts/print-m0-prompts.mts
 */

import { buildBrief, buildDirectorMessages } from '../src/game/director/director-prompt';

const WORLD_SEED = 1337; // src/game/main.ts:63

// dcx, dcz, entranceY — heights chosen to hit all three terrain notes.
const CELLS: [number, number, number][] = [
  [0, 1, 25],   // hills
  [2, -3, 12],  // grassland
  [-1, 4, 3],   // shore
  [5, 5, 30],   // hills
  [-4, -2, 9],  // grassland
];

const system = buildDirectorMessages(buildBrief(WORLD_SEED, 0, 1, 25))[0].content;
console.log('=== SYSTEM PROMPT (paste once, or prepend to each trial) ===\n');
console.log(system);

for (const [dcx, dcz, y] of CELLS) {
  const msgs = buildDirectorMessages(buildBrief(WORLD_SEED, dcx, dcz, y));
  console.log(`\n=== TRIAL user prompt — cell ${dcx},${dcz} (y=${y}) ===\n`);
  console.log(msgs[1].content);
}
