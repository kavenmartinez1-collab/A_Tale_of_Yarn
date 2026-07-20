/**
 * Deterministic tests for the save/load/new-game slot system.
 * Pure CPU — shims localStorage with an in-memory Map.
 * Run: npx tsx scripts/test-save-game.mts
 */

// localStorage shim must exist before the module under test touches it.
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};

const {
  GAME_STATE_KEYS, SAVE_SLOT_COUNT, RESUME_KEY, AUTOPOS_KEY,
  saveToSlot, listSlots, loadSlot, deleteSlot, newGame, consumeResume,
  saveAutoPos, readAutoPos,
} = await import('../src/game/save-game');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Empty state
// ---------------------------------------------------------------------------
{
  const slots = listSlots();
  check('listSlots: SAVE_SLOT_COUNT entries', slots.length === SAVE_SLOT_COUNT);
  check('listSlots: all empty initially', slots.every((s) => s === null));
  check('loadSlot on empty slot returns false', loadSlot(0) === false);
  check('consumeResume: null when nothing staged', consumeResume() === null);
}

// ---------------------------------------------------------------------------
// 2. Save → list → load round-trip
// ---------------------------------------------------------------------------
{
  store.set('artifex-inventory:v2', '{"pack":["stone"]}');
  store.set('artifex-vitals:v1', '{"hp":73}');
  store.set('artifex-npc-dead:v1', '["npc_5_2"]');

  const ok = saveToSlot(1, { x: 12.5, y: 30, z: -44, simTime: 321 });
  check('saveToSlot returns true', ok);

  const slots = listSlots();
  check('slot 1 occupied after save', slots[1] !== null);
  check('slot 0/2 still empty', slots[0] === null && slots[2] === null);
  check('slot meta playtime = simTime', slots[1]?.playtimeS === 321);
  check('slot meta has timestamp', (slots[1]?.savedAtMs ?? 0) > 0);

  // Mutate live state after saving, then load — snapshot must win.
  store.set('artifex-inventory:v2', '{"pack":["MUTATED"]}');
  store.set('artifex-crime:v1', '{"bounty":999}'); // key absent at save time
  store.delete('artifex-npc-dead:v1');             // key removed after save

  check('loadSlot returns true', loadSlot(1));
  check('load restores inventory', store.get('artifex-inventory:v2') === '{"pack":["stone"]}');
  check('load restores vitals', store.get('artifex-vitals:v1') === '{"hp":73}');
  check('load restores deleted key', store.get('artifex-npc-dead:v1') === '["npc_5_2"]');
  check('load clears keys absent at save time', !store.has('artifex-crime:v1'));

  const resume = consumeResume();
  check('resume staged by load', resume !== null);
  check('resume position round-trips',
    resume?.x === 12.5 && resume?.y === 30 && resume?.z === -44);
  check('resume simTime round-trips', resume?.simTime === 321);
  check('consumeResume is one-shot', consumeResume() === null);
  check('RESUME_KEY removed after consume', !store.has(RESUME_KEY));
}

// ---------------------------------------------------------------------------
// 3. New game wipes state but keeps slots
// ---------------------------------------------------------------------------
{
  store.set(RESUME_KEY, '{"x":0,"y":0,"z":0,"simTime":0}');
  newGame();
  check('newGame clears all game-state keys',
    GAME_STATE_KEYS.every((k) => !store.has(k)));
  check('newGame clears staged resume', !store.has(RESUME_KEY));
  check('newGame keeps save slots', listSlots()[1] !== null);
}

// ---------------------------------------------------------------------------
// 4. Delete slot + corrupt slot tolerance
// ---------------------------------------------------------------------------
{
  deleteSlot(1);
  check('deleteSlot empties the slot', listSlots()[1] === null);

  store.set('artifex-save:v1:2', 'not json {{{');
  check('corrupt slot listed as empty', listSlots()[2] === null);
  check('loadSlot on corrupt slot returns false', loadSlot(2) === false);

  store.set(RESUME_KEY, '{"x":"bad"}');
  check('consumeResume rejects malformed record', consumeResume() === null);
}

// ---------------------------------------------------------------------------
// 5. Crash-recovery autosave (autopos)
// ---------------------------------------------------------------------------
{
  check('readAutoPos: null when never saved', readAutoPos() === null);

  saveAutoPos({ x: 5, y: 21.5, z: -8, simTime: 640 });
  const a = readAutoPos();
  check('autopos round-trips', a?.x === 5 && a?.y === 21.5 && a?.z === -8 && a?.simTime === 640);
  check('readAutoPos is non-consuming', readAutoPos() !== null);

  store.set(AUTOPOS_KEY, '{"x":"bad"}');
  check('readAutoPos rejects malformed record', readAutoPos() === null);

  // loadSlot must discard the stale autopos (RESUME_KEY takes over).
  store.set('artifex-inventory:v2', '{"pack":[]}');
  saveToSlot(0, { x: 1, y: 2, z: 3, simTime: 4 });
  saveAutoPos({ x: 99, y: 99, z: 99, simTime: 99 });
  check('loadSlot succeeds', loadSlot(0));
  check('loadSlot clears autopos', !store.has(AUTOPOS_KEY));
  check('resume staged by load wins', consumeResume()?.x === 1);

  // newGame wipes autopos too.
  saveAutoPos({ x: 7, y: 7, z: 7, simTime: 7 });
  newGame();
  check('newGame clears autopos', !store.has(AUTOPOS_KEY));
}

// ---------------------------------------------------------------------------
console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
