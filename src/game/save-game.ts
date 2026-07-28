/**
 * Save / Load / New Game — save-slot system over localStorage.
 *
 * All persistent game state already lives in localStorage under known
 * `artifex-*` keys (inventory, vitals, NPC memory, fires, crime, …). A save
 * slot is a snapshot of those keys plus a small "resume" record (player
 * position + sim time, which are not otherwise persisted). Loading a slot
 * clears the live keys, writes the snapshot back, and stores the resume
 * record under RESUME_KEY; the caller then reloads the page so every system
 * re-boots from the restored keys. consumeResume() is read once at boot to
 * override the spawn position and sim clock.
 *
 * Deliberately NOT part of a slot (shared across saves):
 *   - artifex-director:* — seed-keyed LLM content caches,
 *     deterministic per world seed; re-usable by every save and expensive to
 *     regenerate.
 *   - artifex-ui:* / hf-token / model caches — machine settings, not game state.
 *
 * Pure localStorage module — no DOM, no GPU. Node-testable with a storage shim.
 */

/** Every localStorage key that constitutes game state (snapshotted per slot). */
export const GAME_STATE_KEYS: readonly string[] = [
  'artifex-inventory:v2',
  'artifex-inventory:v1', // legacy migration source — cleared too so an old save can't leak in
  'artifex-vitals:v1',
  'artifex-character:v1',
  'artifex-npc-stock:v1',
  'artifex-npc-memory:v1',
  'artifex-visited:v1',
  'artifex-npc-dead:v1',
  'artifex-fires:v1',
  'artifex-tents:v1',
  'artifex-taming:v1',
  'artifex-entities:v1',
  'artifex-crime:v1',
  'artifex-jail:v1',
  'artifex-nests:v1',
  'artifex-nodes:v1',
  'artifex-effects:v1',
  // The opening. Alarm phase, whether the player escaped, whether the starter
  // chest is empty, and which of the castle garrison are already dead. Without
  // it a reload restarts the opening on top of a save that has moved past it:
  // the chest refills, the alarm drops back to dormant, and every guard the
  // player fought through is standing up again.
  'artifex-castle:v1',
  // The world map's fog of war — which 64 m chunks the player has been to.
  // Belongs to the slot rather than the machine: loading an old save should
  // restore the map that save had, not leak everywhere a later run explored.
  'artifex-map:v1',
  // The Tintreach shot counter: one artifact per save, and the seed every bolt
  // is drawn from, so it has to travel with the slot.
  'artifex-tintreach:v1',
  // The crafting tree's discovery record — which recipes this save has found
  // and which it has made. Same argument as the map: loading an old save must
  // restore the tree that save had, and a New Game must show a virgin one, or
  // "discovery" is a machine-wide setting rather than a thing you did.
  'artifex-progress:v1',
  // Placed looms — the T3 station. Alongside 'artifex-fires:v1' and
  // 'artifex-tents:v1' for the same reason: a station you built is part of the
  // save you built it in.
  'artifex-looms:v1',
];

export const SAVE_SLOT_COUNT = 3;
export const RESUME_KEY = 'artifex-resume:v1';
/**
 * Crash-recovery position record, refreshed every few seconds while playing
 * outdoors. All other game state (inventory, vitals, …) already persists live
 * under the artifex-* keys, so after an unexpected reload (GPU device loss,
 * browser crash) restoring position + sim clock resumes play in place instead
 * of resetting to spawn. An explicit slot-load (RESUME_KEY) takes priority.
 */
export const AUTOPOS_KEY = 'artifex-autopos:v1';

/**
 * Which slot the player is currently in — the last one saved to or loaded
 * from. Deliberately NOT in GAME_STATE_KEYS: it describes which save you are
 * playing, so snapshotting it into a save would be circular.
 *
 * It has to be persisted rather than held in a variable because loading a slot
 * reloads the page. A session-scoped "active slot" would therefore be null
 * immediately after a load, which is exactly the moment the delete guard is
 * for. A game that has never touched a slot has no active slot and every slot
 * is deletable.
 */
export const ACTIVE_SLOT_KEY = 'artifex-active-slot:v1';

function slotKey(slot: number): string {
  return `artifex-save:v1:${slot}`;
}

/** The slot being played, or null for a game that has not used one. */
export function activeSlot(): number | null {
  try {
    const raw = localStorage.getItem(ACTIVE_SLOT_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n < SAVE_SLOT_COUNT ? n : null;
  } catch {
    return null;
  }
}

function setActiveSlot(slot: number | null): void {
  try {
    if (slot === null) localStorage.removeItem(ACTIVE_SLOT_KEY);
    else localStorage.setItem(ACTIVE_SLOT_KEY, String(slot));
  } catch { /* quota */ }
}

/** Player position + sim clock — state not covered by the artifex-* keys. */
export interface ResumeState {
  x: number;
  y: number;
  z: number;
  simTime: number;
}

interface SaveSlotRecord {
  meta: { savedAtMs: number; playtimeS: number };
  resume: ResumeState;
  /** key → raw localStorage value, for keys present at save time. */
  state: Record<string, string>;
}

export interface SlotInfo {
  slot: number;
  savedAtMs: number;
  playtimeS: number;
}

/** Snapshot current game state into a slot. Returns false on quota/parse failure. */
export function saveToSlot(slot: number, resume: ResumeState): boolean {
  // The READS are inside the try as well as the write. localStorage throws on
  // access — not just on write — when storage is disabled outright (private
  // mode, blocked site data), and the gather loop used to sit outside the
  // catch, so this function could throw despite documenting that it returns
  // false. A save that explodes takes the keypress handler with it.
  try {
    const state: Record<string, string> = {};
    for (const key of GAME_STATE_KEYS) {
      const raw = localStorage.getItem(key);
      if (raw !== null) state[key] = raw;
    }
    const rec: SaveSlotRecord = {
      meta: { savedAtMs: Date.now(), playtimeS: resume.simTime },
      resume,
      state,
    };
    localStorage.setItem(slotKey(slot), JSON.stringify(rec));
    setActiveSlot(slot); // you are now playing this save
    return true;
  } catch {
    return false; // quota exceeded, or storage unavailable
  }
}

function readSlot(slot: number): SaveSlotRecord | null {
  try {
    const raw = localStorage.getItem(slotKey(slot));
    if (raw === null) return null;
    const rec = JSON.parse(raw) as SaveSlotRecord;
    if (typeof rec !== 'object' || rec === null || typeof rec.state !== 'object') return null;
    return rec;
  } catch {
    return null;
  }
}

/** Metadata for each slot (null = empty), for the menu UI. */
export function listSlots(): (SlotInfo | null)[] {
  const out: (SlotInfo | null)[] = [];
  for (let i = 0; i < SAVE_SLOT_COUNT; i++) {
    const rec = readSlot(i);
    out.push(rec === null ? null : {
      slot: i,
      savedAtMs: rec.meta?.savedAtMs ?? 0,
      playtimeS: rec.meta?.playtimeS ?? 0,
    });
  }
  return out;
}

/**
 * Restore a slot: wipe live game-state keys, write the snapshot back, and
 * stage the resume record. Returns false if the slot is empty/corrupt.
 * Caller must reload the page afterwards.
 */
export function loadSlot(slot: number): boolean {
  const rec = readSlot(slot);
  if (rec === null) return false;
  for (const key of GAME_STATE_KEYS) localStorage.removeItem(key);
  for (const [key, value] of Object.entries(rec.state)) {
    try { localStorage.setItem(key, value); } catch { /* quota */ }
  }
  try { localStorage.setItem(RESUME_KEY, JSON.stringify(rec.resume)); } catch { /* quota */ }
  localStorage.removeItem(AUTOPOS_KEY); // stale pre-load position must not survive the reload
  setActiveSlot(slot);
  return true;
}

/**
 * Erase a save slot. Refuses the slot currently being played and returns
 * false; there is no undo, and "delete the game you are in" has no sane
 * meaning — the live state would carry on regardless, so the player would
 * appear to still be in a save that no longer exists.
 *
 * The guard is here as well as on the button because a disabled control is a
 * hint, not a rule: a future menu rewrite, a stray keyboard activation or a
 * debug hook must all hit the same refusal.
 *
 * Deleting any OTHER slot touches nothing but that slot's own record. The live
 * `artifex-*` keys — inventory, castle alarm, map discovery — are the running
 * game's, not the deleted slot's, so the game you are in is undisturbed.
 */
export function deleteSlot(slot: number): boolean {
  if (activeSlot() === slot) return false;
  // Same contract as saveToSlot: it returns a boolean, so it must not throw.
  try {
    localStorage.removeItem(slotKey(slot));
    return true;
  } catch {
    return false;
  }
}

/** Wipe live game state (slots survive). Caller must reload the page. */
export function newGame(): void {
  for (const key of GAME_STATE_KEYS) localStorage.removeItem(key);
  localStorage.removeItem(RESUME_KEY);
  localStorage.removeItem(AUTOPOS_KEY);
  // A new game is not in any slot, so every slot becomes deletable again.
  setActiveSlot(null);
}

/** Refresh the crash-recovery position record (throttled by the caller). */
export function saveAutoPos(resume: ResumeState): void {
  try { localStorage.setItem(AUTOPOS_KEY, JSON.stringify(resume)); } catch { /* quota */ }
}

/**
 * Read the crash-recovery position (non-consuming — refreshed while playing).
 * Used at boot as a fallback when no explicit slot-load resume is staged.
 */
export function readAutoPos(): ResumeState | null {
  try {
    const raw = localStorage.getItem(AUTOPOS_KEY);
    if (raw === null) return null;
    const r = JSON.parse(raw) as ResumeState;
    if (typeof r?.x !== 'number' || typeof r.y !== 'number' ||
        typeof r.z !== 'number' || typeof r.simTime !== 'number') return null;
    return r;
  } catch {
    return null;
  }
}

/**
 * One-shot boot read of the staged resume record (position + sim time).
 * Removes the key so a plain refresh afterwards behaves normally.
 */
export function consumeResume(): ResumeState | null {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    if (raw === null) return null;
    localStorage.removeItem(RESUME_KEY);
    const r = JSON.parse(raw) as ResumeState;
    if (typeof r?.x !== 'number' || typeof r.y !== 'number' ||
        typeof r.z !== 'number' || typeof r.simTime !== 'number') return null;
    return r;
  } catch {
    return null;
  }
}
