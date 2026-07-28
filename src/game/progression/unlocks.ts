/**
 * Discovery state for the crafting/building tree — which recipes the player
 * has found, and the rules that reveal the next one.
 *
 * WHY A SEPARATE MODULE. `crafting.ts` is a table: it says what a recipe costs
 * and which rung of the tree it sits on. This is the part that changes as you
 * play, and it is the part that has to survive a reload, travel with a save
 * slot and be wiped by a delete. Keeping the mutable half out of the table is
 * what lets `scripts/test-progression.mts` flood the whole tree from a fresh
 * start without touching localStorage or a browser.
 *
 * DETERMINISM. There is no RNG here and there is no clock here. A recipe is
 * revealed by exactly two kinds of fact — "I have held this item" and "I have
 * made this recipe" — and both are monotone: nothing ever re-hides. Two saves
 * that did the same things in a different order have the same tree, which is
 * the property that makes "why did that appear?" answerable.
 *
 * FIXPOINT, NOT ONE STEP. Recording one acquisition can unlock a recipe whose
 * unlocking satisfies another recipe's `made(...)` — no, it cannot, because
 * `made` needs an actual craft. But recording a CRAFT can cascade (making the
 * hood reveals the tunic, and the tunic's own reveal is not conditional on
 * anything else), and a future trigger kind might. `propagate` therefore loops
 * to a fixpoint rather than assuming depth 1, which costs one extra pass over
 * 68 rows on the rare frames anything changes at all.
 */

import {
  RECIPES,
  type Recipe,
  type UnlockGate,
  type UnlockTrigger,
} from '../crafting';
import { ITEM_DEFS, type GameItemId } from '../items';
import type { Inventory } from '../inventory';

/**
 * Per-save discovery record. Listed in `save-game.ts` GAME_STATE_KEYS, so it
 * is snapshotted into a slot, restored by a load, and — the beat
 * `save-delete-check.mjs` proves — removed by New Game.
 */
export const PROGRESS_KEY = 'artifex-progress:v1';

export interface ProgressState {
  /** Recipe keys currently visible and craftable. */
  unlocked: Set<string>;
  /** Recipe keys crafted at least once. Outlives consuming the output. */
  crafted: Set<string>;
  /** Item ids ever held. Outlives spending them. */
  seen: Set<GameItemId>;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** A virgin tree: only the recipes with no unlock conditions at all. */
export function createProgress(): ProgressState {
  const state: ProgressState = {
    unlocked: new Set<string>(),
    crafted: new Set<string>(),
    seen: new Set<GameItemId>(),
  };
  propagate(state);
  return state;
}

// ---------------------------------------------------------------------------
// Trigger evaluation
// ---------------------------------------------------------------------------

function triggerMet(t: UnlockTrigger, state: ProgressState): boolean {
  return t.kind === 'acquire' ? state.seen.has(t.item) : state.crafted.has(t.recipe);
}

/** True when every trigger on the recipe is satisfied (AND, and `[]` is true). */
export function unlockMet(recipe: Recipe, state: ProgressState): boolean {
  for (const t of recipe.unlock) if (!triggerMet(t, state)) return false;
  return true;
}

/**
 * Reveal everything whose conditions now hold. Returns the keys revealed by
 * THIS call, in table order, so the caller can toast them.
 */
function propagate(state: ProgressState): string[] {
  const revealed: string[] = [];
  for (;;) {
    let any = false;
    for (const r of RECIPES) {
      if (state.unlocked.has(r.key)) continue;
      if (!unlockMet(r, state)) continue;
      state.unlocked.add(r.key);
      revealed.push(r.key);
      any = true;
    }
    if (!any) return revealed;
  }
}

// ---------------------------------------------------------------------------
// Recording what the player did
// ---------------------------------------------------------------------------

/**
 * Record that the player is holding these items. Returns newly revealed keys.
 *
 * Cheap on the common path: the early-out is a Set hit per id, and the
 * fixpoint pass only runs when something is genuinely new, so calling this on
 * every inventory change costs a handful of Set lookups on almost every call.
 */
export function noteItems(state: ProgressState, ids: Iterable<GameItemId>): string[] {
  let fresh = false;
  for (const id of ids) {
    if (state.seen.has(id)) continue;
    state.seen.add(id);
    fresh = true;
  }
  return fresh ? propagate(state) : [];
}

/** Record a completed craft. Returns newly revealed keys. */
export function noteCraft(state: ProgressState, key: string): string[] {
  if (state.crafted.has(key)) return [];
  state.crafted.add(key);
  return propagate(state);
}

/**
 * Sweep the whole inventory into `seen`. Called on every inventory change:
 * items arrive from gathering, loot, trade, a dropped stack picked back up and
 * the starting pack, and chasing each of those call sites individually is how
 * a tree ends up with a hole in it that only one player ever finds.
 */
export function observeInventory(state: ProgressState, inv: Inventory): string[] {
  const ids: GameItemId[] = [];
  for (const slot of inv.pack) if (slot !== null) ids.push(slot.id);
  for (const slot of inv.hotbar) if (slot !== null) ids.push(slot.id);
  for (const slot of Object.values(inv.armor)) if (slot != null) ids.push(slot.id);
  return noteItems(state, ids);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function isUnlocked(state: ProgressState, key: string): boolean {
  return state.unlocked.has(key);
}

/**
 * The state as the gate `canCraft`/`craft` take. A tiny adapter rather than
 * passing the state itself, so `crafting.ts` never has to import this module.
 */
export function unlockGate(state: ProgressState): UnlockGate {
  return { has: (key: string) => state.unlocked.has(key) };
}

/**
 * Why a locked recipe is locked, in one short player-facing line.
 *
 * Names the FIRST unmet trigger rather than all of them: a locked row has room
 * for one line, and a player who satisfies the first condition gets a new line
 * telling them the next one, which reads as progress instead of as a wall.
 */
export function requirementText(recipe: Recipe, state: ProgressState): string {
  for (const t of recipe.unlock) {
    if (triggerMet(t, state)) continue;
    if (t.kind === 'acquire') return `Discover: ${ITEM_DEFS[t.item].name}`;
    const prereq = RECIPES.find((r) => r.key === t.recipe);
    return `Craft first: ${prereq === undefined ? t.recipe : ITEM_DEFS[prereq.output].name}`;
  }
  return 'Unknown';
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface ProgressJson {
  u?: unknown;
  c?: unknown;
  s?: unknown;
}

export function serializeProgress(state: ProgressState): string {
  // Sorted, so the stored string is a function of the state and not of the
  // order the player happened to do things in. Two identical trees produce
  // identical bytes, which is what makes a harness able to diff them.
  return JSON.stringify({
    u: [...state.unlocked].sort(),
    c: [...state.crafted].sort(),
    s: [...state.seen].sort(),
  });
}

function stringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  for (const x of v) if (typeof x !== 'string') return null;
  return v as string[];
}

/**
 * Parse a stored record, or null if it is not one.
 *
 * Unknown recipe keys and unknown item ids are DROPPED rather than rejected:
 * a save written by a build that had a recipe this build does not is a real
 * situation (a player rolling back), and losing one row of discovery is a far
 * better outcome than refusing the whole record and wiping the tree.
 */
export function deserializeProgress(json: string): ProgressState | null {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return null; }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as ProgressJson;
  const u = stringArray(o.u ?? []);
  const c = stringArray(o.c ?? []);
  const s = stringArray(o.s ?? []);
  if (u === null || c === null || s === null) return null;

  const known = new Set(RECIPES.map((r) => r.key));
  const state: ProgressState = {
    unlocked: new Set(u.filter((k) => known.has(k))),
    crafted: new Set(c.filter((k) => known.has(k))),
    seen: new Set(s.filter((id): id is GameItemId =>
      Object.prototype.hasOwnProperty.call(ITEM_DEFS, id))),
  };
  // Re-derive rather than trust: `unlocked` is a cache of what `seen` and
  // `crafted` imply, and re-running the fixpoint on load is what lets a build
  // that ADDS a recipe hand it to an existing save the moment its conditions
  // were already met, with no migration step.
  propagate(state);
  return state;
}

export function loadProgress(): ProgressState {
  try {
    if (typeof localStorage === 'undefined') return createProgress();
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (raw !== null) {
      const state = deserializeProgress(raw);
      if (state !== null) return state;
    }
  } catch { /* storage unavailable */ }
  return createProgress();
}

export function saveProgress(state: ProgressState): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(PROGRESS_KEY, serializeProgress(state));
  } catch { /* quota */ }
}
