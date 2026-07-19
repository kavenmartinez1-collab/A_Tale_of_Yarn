/**
 * Timed-effects (buffs) model — pure, deterministic, engine/DOM-free.
 *
 * Tracks active timed effects applied by consuming potions and dishes.
 * Integrates with items.ts (EffectClass, ITEM_DEFS) and composes with
 * vitals.ts: query helpers return contributions that the caller feeds
 * into temperatureAt / stepVitals, matching the BOTW max-not-sum style
 * already used for warm sources.
 *
 * Persistence key: 'artifex-effects:v1'
 *
 * Phase N — no HUD, no main.ts wiring — those come later.
 */

import { type EffectClass, type GameItemId, ITEM_DEFS } from './items.js';

// ---------------------------------------------------------------------------
// Re-export EffectClass so consumers need only import from effects.ts
// ---------------------------------------------------------------------------

export type { EffectClass };

// ---------------------------------------------------------------------------
// Tuning table
//
// items.ts does not carry explicit duration/magnitude on ItemDef, so we
// provide sensible defaults keyed by (itemId, effectClass).  Balance passes
// adjust only this table without touching game logic.
//
// Duration is in seconds.  Magnitude semantics per class:
//   heal    — applied instantly; magnitude is extra HP on top of edible.heal
//             (heal potions / hearty stew get a small regen bonus of 0 here
//              since the instant heal already covers the number — the class
//              marker exists to prevent double-stacking from two heal items).
//   warm    — warmth source contribution fed into temperatureAt() as an
//             additional warm source (on par with torchWarm=0.3, campfire=1.2).
//             A warm buff of 1.0 is strong; 0.6 is a mid-tier potion.
//   cool    — coolingBonus fed into temperatureAt().  A cooling potion
//             of 1.0 fully counters a +1.0 desert environment.
//   stamina — staminaRegenMult(state) returns (1 + magnitude) while active,
//             so magnitude 0.5 = 50 % faster regen.
//
// Items not listed fall back to CLASS_DEFAULTS.
// ---------------------------------------------------------------------------

export interface EffectTuning {
  /** Duration of the timed effect in seconds. */
  durationS: number;
  /**
   * Effect magnitude.  For 'heal' this is the *instant* HP bonus applied on
   * top of whatever edible.heal already provides; timed heal is not really
   * useful so magnitude is 0 by default (the class is purely a "no-stack"
   * sentinel for heal items).
   */
  magnitude: number;
}

/** Per-class fallback tuning used when an item has no explicit entry. */
export const CLASS_DEFAULTS: Record<EffectClass, EffectTuning> = {
  // Instant: no duration needed, magnitude 0 (edible.heal covers the restore)
  heal:    { durationS: 0,   magnitude: 0   },
  // Warming potion: ~1 minute, moderate warmth contribution
  warm:    { durationS: 60,  magnitude: 0.6 },
  // Cooling potion: ~1 minute, moderate cooling contribution
  cool:    { durationS: 60,  magnitude: 0.6 },
  // Stamina potion: 45 s, 50 % faster regen
  stamina: { durationS: 45,  magnitude: 0.5 },
};

/**
 * Per-item tuning overrides.  Only entries that differ from CLASS_DEFAULTS
 * need to be listed.
 */
export const EFFECT_TUNING: Partial<Record<GameItemId, EffectTuning>> = {
  // healing_potion: instant heal of 8 hp (from edible) + no timed bonus
  healing_potion: { durationS: 0,  magnitude: 0   },
  // hearty_stew: instant heal of 10 hp (from edible) + no timed bonus
  hearty_stew:    { durationS: 0,  magnitude: 0   },
  // warming_potion: standard warm (uses CLASS_DEFAULTS)
  warming_potion: { durationS: 60, magnitude: 0.6 },
  // cooling_potion: standard cool (uses CLASS_DEFAULTS)
  cooling_potion: { durationS: 60, magnitude: 0.6 },
  // stamina_potion: standard stamina (uses CLASS_DEFAULTS)
  stamina_potion: { durationS: 45, magnitude: 0.5 },
};

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export interface ActiveEffect {
  cls:        EffectClass;
  magnitude:  number;
  remainingS: number;
  totalS:     number;
}

export interface EffectsState {
  effects: ActiveEffect[];
}

// ---------------------------------------------------------------------------
// Persistence key (module exports the key; module does NOT touch localStorage)
// ---------------------------------------------------------------------------

export const EFFECTS_STORAGE_KEY = 'artifex-effects:v1';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEffects(): EffectsState {
  return { effects: [] };
}

// ---------------------------------------------------------------------------
// applyItemEffects
//
// Looks up the item's effectClass and tuning, then:
//   - 'heal' class: applied instantly; returns the extra heal amount for
//     the caller to pass to healPlayer().  The effect is NOT pushed onto
//     the active list (heal is instant, not timed).
//   - Other classes (warm / cool / stamina): pushes or refreshes an
//     ActiveEffect.  Same-class re-application keeps the STRONGEST magnitude
//     and refreshes duration to the new item's totalS (BOTW-style, no
//     stacking).  Returns 0 (no instant heal).
//
// Returns: instant heal HP the caller should pass to healPlayer(), or 0.
// Unknown items (not in ITEM_DEFS) are silently ignored and return 0.
// Items without effectClass are silently ignored.
// ---------------------------------------------------------------------------

export function applyItemEffects(
  state: EffectsState,
  itemId: string,
  // Accept the full ITEM_DEFS map so the caller controls the registry
  // (also makes unit testing trivial without module-level mocking).
  defs: typeof ITEM_DEFS,
): number {
  // Validate item exists
  if (!Object.prototype.hasOwnProperty.call(defs, itemId)) return 0;
  const def = (defs as Record<string, (typeof ITEM_DEFS)[keyof typeof ITEM_DEFS]>)[itemId];
  if (!def) return 0;

  const cls = (def as { effectClass?: EffectClass }).effectClass;
  if (!cls) return 0;

  // Resolve tuning: per-item override → class default
  const tuning: EffectTuning =
    (EFFECT_TUNING as Record<string, EffectTuning | undefined>)[itemId] ??
    CLASS_DEFAULTS[cls];

  // Instant heal: no timed effect; return instant heal to caller
  if (cls === 'heal') {
    return tuning.magnitude;
  }

  // Timed effect: push or refresh
  const existing = state.effects.find(e => e.cls === cls);
  if (existing) {
    // BOTW-style: keep strongest magnitude, refresh duration
    existing.magnitude  = Math.max(existing.magnitude, tuning.magnitude);
    existing.remainingS = tuning.durationS;
    existing.totalS     = tuning.durationS;
  } else {
    state.effects.push({
      cls,
      magnitude:  tuning.magnitude,
      remainingS: tuning.durationS,
      totalS:     tuning.durationS,
    });
  }

  return 0;
}

// ---------------------------------------------------------------------------
// stepEffects — tick down remainingS, remove expired effects
// ---------------------------------------------------------------------------

export function stepEffects(state: EffectsState, dtS: number): void {
  for (const e of state.effects) {
    e.remainingS -= dtS;
  }
  state.effects = state.effects.filter(e => e.remainingS > 0);
}

// ---------------------------------------------------------------------------
// Query helpers
//
// These return the contribution the caller feeds into vitals / temperature
// computation each frame.
// ---------------------------------------------------------------------------

/**
 * Returns the warmth-source contribution from any active 'warm' effect.
 * Feed this as an additional warm source into temperatureAt() — the
 * max-not-sum logic in vitals.ts handles the rest.
 * Returns 0 when no warm effect is active.
 */
export function effectWarmth(state: EffectsState): number {
  const e = state.effects.find(ef => ef.cls === 'warm');
  return e ? e.magnitude : 0;
}

/**
 * Returns the coolingBonus from any active 'cool' effect.
 * Feed this as `coolingBonus` into TempInputs for temperatureAt().
 * Returns 0 when no cool effect is active.
 */
export function effectCooling(state: EffectsState): number {
  const e = state.effects.find(ef => ef.cls === 'cool');
  return e ? e.magnitude : 0;
}

/**
 * Returns the stamina regen multiplier.
 * 1.0 = no buff; 1 + magnitude when a stamina effect is active.
 * Multiply STAMINA_REGEN_PER_S by this value each step.
 */
export function staminaRegenMult(state: EffectsState): number {
  const e = state.effects.find(ef => ef.cls === 'stamina');
  return e ? 1 + e.magnitude : 1;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface SerializedEffects {
  v: 1;
  effects: ActiveEffect[];
}

export function serializeEffects(state: EffectsState): string {
  const payload: SerializedEffects = { v: 1, effects: state.effects };
  return JSON.stringify(payload);
}

/**
 * Returns null on any validation failure; caller should fall back to
 * createEffects().
 */
export function deserializeEffects(json: string): EffectsState | null {
  let x: unknown;
  try {
    x = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;

  if (o['v'] !== 1) return null;
  if (!Array.isArray(o['effects'])) return null;

  const VALID_CLASSES = new Set<string>(['heal', 'warm', 'cool', 'stamina']);

  const effects: ActiveEffect[] = [];
  for (const item of o['effects']) {
    if (typeof item !== 'object' || item === null) return null;
    const e = item as Record<string, unknown>;

    if (typeof e['cls'] !== 'string' || !VALID_CLASSES.has(e['cls'])) return null;
    if (typeof e['magnitude'] !== 'number'  || isNaN(e['magnitude'] as number))  return null;
    if (typeof e['remainingS'] !== 'number' || isNaN(e['remainingS'] as number) || (e['remainingS'] as number) < 0) return null;
    if (typeof e['totalS'] !== 'number'     || isNaN(e['totalS'] as number)     || (e['totalS'] as number) < 0) return null;

    effects.push({
      cls:        e['cls'] as EffectClass,
      magnitude:  e['magnitude'] as number,
      remainingS: e['remainingS'] as number,
      totalS:     e['totalS'] as number,
    });
  }

  return { effects };
}
