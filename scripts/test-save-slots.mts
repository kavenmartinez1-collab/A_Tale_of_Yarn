/**
 * test-save-slots.mts — save / load / delete over the slot system.
 *
 *   npx tsx scripts/test-save-slots.mts
 *
 * The interesting case is DELETE, because it is the only irreversible action
 * in the menu and because a slot is a snapshot of a growing list of keys
 * (`GAME_STATE_KEYS` picked up the castle opening recently and the world map
 * just now). The failure to be afraid of is a "deleted" save that haunts the
 * next new game — a pre-explored map, an already-looted starter chest — so
 * that is asserted key by key rather than by trusting the function.
 *
 * The other rule under test is that you cannot delete the save you are
 * playing, enforced in the storage layer and not only in the button.
 */

import {
  GAME_STATE_KEYS, SAVE_SLOT_COUNT, ACTIVE_SLOT_KEY, RESUME_KEY, AUTOPOS_KEY,
  activeSlot, deleteSlot, listSlots, loadSlot, newGame, saveToSlot,
  consumeResume,
} from '../src/game/save-game';

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}
function eq(name: string, got: unknown, want: unknown): void {
  ok(name, Object.is(got, want), `got ${String(got)}, want ${String(want)}`);
}

// --- storage shim ----------------------------------------------------------
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
  get length() { return store.size; },
  key: (i: number) => [...store.keys()][i] ?? null,
};

/** A recognisable live game: one value per state key. */
function seedLiveState(tag: string): void {
  for (const key of GAME_STATE_KEYS) store.set(key, `${tag}:${key}`);
}
function liveStateTag(): string[] {
  return GAME_STATE_KEYS.map((k) => store.get(k) ?? '(absent)');
}

// --- 1. save / list / load round trip --------------------------------------
{
  store.clear();
  seedLiveState('runA');
  ok('saving succeeds', saveToSlot(0, { x: 1, y: 2, z: 3, simTime: 400 }));
  const slots = listSlots();
  eq('the slot list has one entry per slot', slots.length, SAVE_SLOT_COUNT);
  ok('slot 0 is populated', slots[0] !== null);
  eq('and reports its playtime', slots[0]?.playtimeS, 400);
  ok('the other slots are empty', slots[1] === null && slots[2] === null);

  // Move the live game on, then load slot 0 back.
  seedLiveState('runB');
  ok('loading succeeds', loadSlot(0));
  ok('the live keys came back from the slot',
    liveStateTag().every((v) => v.startsWith('runA:')),
    liveStateTag().slice(0, 2).join(', '));
  const resume = consumeResume();
  eq('and so did the position', resume?.x, 1);
  eq('and the sim clock', resume?.simTime, 400);
  eq('the crash-recovery position was cleared', store.get(AUTOPOS_KEY), undefined);
}

// --- 2. the active slot ----------------------------------------------------
{
  store.clear();
  eq('a fresh game is in no slot', activeSlot(), null);
  seedLiveState('runC');
  saveToSlot(2, { x: 0, y: 0, z: 0, simTime: 10 });
  eq('saving makes that slot active', activeSlot(), 2);
  saveToSlot(1, { x: 0, y: 0, z: 0, simTime: 20 });
  eq('saving elsewhere moves it', activeSlot(), 1);
  loadSlot(2);
  eq('loading makes that slot active', activeSlot(), 2);
  store.set(ACTIVE_SLOT_KEY, 'nonsense');
  eq('a corrupt active-slot value reads as none', activeSlot(), null);
  store.set(ACTIVE_SLOT_KEY, String(SAVE_SLOT_COUNT + 5));
  eq('an out-of-range one does too', activeSlot(), null);
  newGame();
  eq('a new game clears it', activeSlot(), null);
}

// --- 3. DELETE, and the rule that you cannot delete what you are playing ----
{
  store.clear();
  seedLiveState('runD');
  saveToSlot(0, { x: 0, y: 0, z: 0, simTime: 1 });
  saveToSlot(1, { x: 0, y: 0, z: 0, simTime: 2 });
  eq('slot 1 is now the active one', activeSlot(), 1);

  ok('deleting the active slot is refused', deleteSlot(1) === false);
  ok('and it is still there', listSlots()[1] !== null);

  ok('deleting another slot succeeds', deleteSlot(0) === true);
  ok('and it reads as empty afterwards', listSlots()[0] === null);
  ok('while the other slot is untouched', listSlots()[1] !== null);

  // Deleting a slot must not disturb the game currently being played.
  ok('the live game is undisturbed by the delete',
    liveStateTag().every((v) => v.startsWith('runD:')));
  eq('and the active slot is unchanged', activeSlot(), 1);

  ok('deleting an already-empty slot is harmless', deleteSlot(0) === true);
  ok('deleting a never-used slot is harmless', deleteSlot(2) === true);
}

// --- 4. THE HAUNTING: a deleted save must not leak into a new game ----------
{
  store.clear();
  // Play far enough to have a map, an opened castle chest and a full pack.
  store.set('artifex-map:v1', '{"v":1,"t":{"0,0":"ffffffff.ffffffff"}}');
  store.set('artifex-castle:v1', '{"alarm":"hunting","chestOpen":true}');
  store.set('artifex-inventory:v2', '{"hotbar":["sword"]}');
  saveToSlot(0, { x: 900, y: 12, z: -400, simTime: 9000 });

  // Load it into another slot's place, then leave that slot so it is deletable.
  saveToSlot(1, { x: 0, y: 0, z: 0, simTime: 1 });
  ok('slot 0 is deletable once we are playing slot 1', deleteSlot(0) === true);
  eq('slot 0 is gone', listSlots()[0], null);
  eq('and its record is really out of storage',
    store.get('artifex-save:v1:0'), undefined);

  newGame();
  // Every key a slot owns must be gone from the live game.
  const survivors = GAME_STATE_KEYS.filter((k) => store.has(k));
  ok('a new game leaves no game-state key behind', survivors.length === 0,
    `survived: ${survivors.join(', ')}`);
  eq('specifically, the world map is blank', store.get('artifex-map:v1'), undefined);
  eq('and the castle opening is reset', store.get('artifex-castle:v1'), undefined);
  eq('and there is no staged resume', store.get(RESUME_KEY), undefined);
  eq('and no crash-recovery position', store.get(AUTOPOS_KEY), undefined);

  // The map key must actually be registered, or none of the above means
  // anything — this is the assertion that catches somebody adding a new
  // persisted key and forgetting save-game.ts.
  ok('the world map is registered as slot state',
    GAME_STATE_KEYS.includes('artifex-map:v1'));
  ok('so is the castle opening',
    GAME_STATE_KEYS.includes('artifex-castle:v1'));
}

// --- 5. hostile storage ----------------------------------------------------
{
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => { throw new Error('nope'); },
    setItem: () => { throw new Error('quota'); },
    removeItem: () => { throw new Error('nope'); },
  };
  let threw = false;
  try {
    activeSlot();
    saveToSlot(0, { x: 0, y: 0, z: 0, simTime: 0 });
    listSlots();
    deleteSlot(0);
  } catch { threw = true; }
  ok('a hostile localStorage does not throw', !threw);
  eq('and a save into it reports failure',
    saveToSlot(0, { x: 0, y: 0, z: 0, simTime: 0 }), false);
  eq('and so does a delete', deleteSlot(0), false);
}

process.stdout.write(`\nsave-slots: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
