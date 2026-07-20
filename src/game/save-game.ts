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

function slotKey(slot: number): string {
  return `artifex-save:v1:${slot}`;
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
  try {
    localStorage.setItem(slotKey(slot), JSON.stringify(rec));
    return true;
  } catch {
    return false; // quota exceeded
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
  return true;
}

export function deleteSlot(slot: number): void {
  localStorage.removeItem(slotKey(slot));
}

/** Wipe live game state (slots survive). Caller must reload the page. */
export function newGame(): void {
  for (const key of GAME_STATE_KEYS) localStorage.removeItem(key);
  localStorage.removeItem(RESUME_KEY);
  localStorage.removeItem(AUTOPOS_KEY);
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
