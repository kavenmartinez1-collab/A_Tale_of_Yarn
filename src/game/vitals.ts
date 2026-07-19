/**
 * Vitals model — pure, deterministic, engine/DOM-free.
 *
 * Tracks HP, thirst, stamina, temperature, alive state, and death cause.
 * Temperature uses a BOTW-flavoured max-not-sum model: the strongest single
 * warming source dominates (campfire / torch / tent / armorWarmth), with a
 * small +0.2 bonus when 2+ warm sources are active. Environmental challenges
 * (biome offset, altitude, night, swimming) are additive on the cold side.
 *
 * Persistence key: 'artifex-vitals:v1'
 *
 * Phase G — no HUD, no main.ts wiring — those come later.
 */

// ---------------------------------------------------------------------------
// Constants (exported so tests and integration can reference them)
// ---------------------------------------------------------------------------

export const MAX_HP      = 20;   // 10 hearts at half-heart granularity
export const MAX_THIRST  = 100;
export const MAX_STAMINA = 100;

/** Thirst drain per second at normal conditions (~1.2 per minute). */
export const THIRST_DRAIN_PER_S = 1.2 / 60;

/** Temperature range (inclusive). */
export const TEMP_MIN = -3;
export const TEMP_MAX =  3;

/** Slope angle at which climbing begins draining stamina. */
export const CLIMB_SLOPE_DEG = 42;

/** Stamina drain rates (per second). */
export const CLIMB_DRAIN_PER_S       = 20;
export const CLIMB_DRAIN_STAFF_PER_S = 14;
export const SPRINT_DRAIN_PER_S      = 15;

/** Stamina regen rate (per second, when regen delay has elapsed). */
export const STAMINA_REGEN_PER_S = 12;

/** Seconds of inactivity before stamina begins regenerating. */
export const STAMINA_REGEN_DELAY_S = 1.5;

/**
 * Temperature band boundary: at |temp| >= TEMP_DAMAGE_THRESHOLD the player
 * takes periodic damage (1 hp per 4 s at the threshold and beyond).
 */
export const TEMP_DAMAGE_THRESHOLD = 2.5;

/** Temperature damage period (seconds between ticks). */
export const TEMP_DAMAGE_PERIOD_S = 4;

/** Thirst damage period (seconds between ticks when thirst is 0). */
export const THIRST_DAMAGE_PERIOD_S = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DamageCause =
  | 'thirst'
  | 'cold'
  | 'heat'
  | 'drowning'
  | 'lightning'
  | 'fall'
  | 'combat'
  | 'guard'
  | 'animal';

export interface Vitals {
  hp:          number;
  thirst:      number;
  stamina:     number;
  temperature: number;
  alive:       boolean;
  /** Cause of death; set when hp first reaches 0. */
  deathCause:  DamageCause | null;
  /**
   * Accumulated fractional seconds since thirst hit 0.
   * Used internally to fire thirst damage ticks deterministically.
   */
  thirstTickAccum: number;
  /**
   * Accumulated fractional seconds since temperature left the safe band.
   * Tracks cold/heat damage timing.
   */
  tempTickAccum: number;
  /**
   * Seconds elapsed since the last draining action.
   * Stamina only regens when this >= STAMINA_REGEN_DELAY_S.
   */
  sinceDrainS: number;
}

export interface TempInputs {
  /**
   * Biome base heat/cold offset. Caller derives this from biomeAt().
   * Examples: desert daytime +1.5, alpine −2, jungle +1, night in temperate −0.5.
   */
  biomeOffset:  number;
  /** Metres above sea level; penalty = −0.015 per metre above 20 m. */
  altitude:     number;
  /** True when it is night (additive −0.8 on top of biomeOffset). */
  night:        boolean;
  /** True when a campfire is within 6 m of the player. */
  campfireNear: boolean;
  /** True when the player is holding a torch. */
  heldTorch:    boolean;
  /** Tent tier in use (0 = no tent, 1 = fiber, 2 = wool, 3 = hide). */
  tentTier:     0 | 1 | 2 | 3;
  /** Warmth from equipped armor (inventory.totalWarmth()). */
  armorWarmth:  number;
  /** True when the player is swimming (additive −1.0). */
  swimming:     boolean;
  /**
   * Additional cooling applied when in extreme heat (reserved for future
   * cooling-herb / cooling-potion effects). Defaults to 0.
   */
  coolingBonus?: number;
}

export interface StepEnv extends TempInputs {
  /** When true, thirst drains ×2.5 (desert heat). */
  hot?: boolean;
  /** When true, the player is currently draining stamina this step
   *  (sprinting / climbing). Suppresses stamina regen. */
  draining?: boolean;
}

// ---------------------------------------------------------------------------
// Persistence key
// ---------------------------------------------------------------------------

export const VITALS_KEY = 'artifex-vitals:v1';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Full HP / thirst / stamina, temperature 0, alive. */
export function createVitals(): Vitals {
  return {
    hp:              MAX_HP,
    thirst:          MAX_THIRST,
    stamina:         MAX_STAMINA,
    temperature:     0,
    alive:           true,
    deathCause:      null,
    thirstTickAccum: 0,
    tempTickAccum:   0,
    sinceDrainS:     0,
  };
}

// ---------------------------------------------------------------------------
// Temperature calculation
// ---------------------------------------------------------------------------

const TENT_WARMTH: Record<0 | 1 | 2 | 3, number> = {
  0: 0,
  1: 0.5,
  2: 0.8,
  3: 1.1,
};

/**
 * Compute the temperature value for the given environment inputs.
 *
 * Environment challenge (additive, can push temp negative/positive):
 *   biomeOffset + altitude penalty + night penalty + swimming penalty
 *
 * Protection (max-not-sum, BOTW-flavoured):
 *   effective_warm = max(campfire, torch, tent, armorWarmth)
 *   if 2+ warm sources active → +0.2 bonus
 *   The effective warm value is subtracted from cold (negative) challenge or
 *   added to warm (positive) situations so the player stays safe.
 *
 * For heat: a coolingBonus is subtracted (heat challenge reduced).
 *
 * Final result is clamped to [TEMP_MIN, TEMP_MAX].
 */
export function temperatureAt(inp: TempInputs): number {
  // --- Environmental challenge (additive) ---
  const altitudePenalty = inp.altitude > 20 ? (inp.altitude - 20) * (-0.015) : 0;
  const nightPenalty    = inp.night ? -0.8 : 0;
  const swimPenalty     = inp.swimming ? -1.0 : 0;
  const envTemp = inp.biomeOffset + altitudePenalty + nightPenalty + swimPenalty;

  // --- Protection sources (max-not-sum) ---
  const campfireWarm = inp.campfireNear ? 1.2 : 0;
  const torchWarm    = inp.heldTorch    ? 0.3 : 0;
  const tentWarm     = TENT_WARMTH[inp.tentTier];
  const armorWarm    = inp.armorWarmth > 0 ? inp.armorWarmth : 0;

  const strongestWarm = Math.max(campfireWarm, torchWarm, tentWarm, armorWarm);

  // Count active warm sources for the 2+ bonus.
  let activeSources = 0;
  if (campfireWarm > 0) activeSources++;
  if (torchWarm    > 0) activeSources++;
  if (tentWarm     > 0) activeSources++;
  if (armorWarm    > 0) activeSources++;

  const effectiveWarm = strongestWarm + (activeSources >= 2 ? 0.2 : 0);

  // Cooling bonus (for heat resist from potions/herbs — future use).
  const cooling = inp.coolingBonus ?? 0;

  // The warm protection offsets cold challenge (brings temp toward 0 from
  // negative side). Cooling offsets heat challenge (brings temp toward 0 from
  // positive side). They are independent axes.
  let finalTemp: number;
  if (envTemp < 0) {
    // Cold side: protection adds back warmth (reduces magnitude of cold).
    finalTemp = envTemp + effectiveWarm;
  } else {
    // Warm/hot side: cooling reduces temperature.
    finalTemp = envTemp - cooling;
  }

  return Math.max(TEMP_MIN, Math.min(TEMP_MAX, finalTemp));
}

// ---------------------------------------------------------------------------
// Damage / heal / drink choke points
// ---------------------------------------------------------------------------

/** Physical damage causes that are reduced by armor defense. */
const PHYSICAL_CAUSES = new Set<DamageCause>(['combat', 'guard', 'animal']);

/**
 * Single choke point for all damage. Clamps hp to [0, MAX_HP], sets
 * alive=false and deathCause on first kill, never goes below 0.
 *
 * Optional `defense` (default 0): each defense point reduces physical damage
 * by 4%, capped at 60% total reduction. Only affects physical causes
 * (combat / guard / animal). Environmental causes (thirst / temp / drowning /
 * lightning / fall) are NOT reduced.
 */
export function damagePlayer(
  v: Vitals,
  amount: number,
  cause: DamageCause,
  defense = 0,
): Vitals {
  if (!v.alive) return v;
  let effective = amount;
  if (defense > 0 && PHYSICAL_CAUSES.has(cause)) {
    const reduction = Math.min(0.60, defense * 0.04);
    effective = amount * Math.max(0.40, 1 - reduction);
  }
  v.hp -= effective;
  if (v.hp <= 0) {
    v.hp = 0;
    v.alive = false;
    v.deathCause = cause;
  }
  return v;
}

/** Heal the player, clamping to MAX_HP. No effect when dead. */
export function healPlayer(v: Vitals, amount: number): Vitals {
  if (!v.alive) return v;
  v.hp = Math.min(MAX_HP, v.hp + amount);
  return v;
}

/** Restore thirst (drinking), clamping to MAX_THIRST. */
export function drinkPlayer(v: Vitals, quench: number): Vitals {
  v.thirst = Math.min(MAX_THIRST, v.thirst + quench);
  return v;
}

/**
 * Drain stamina at `perS` for `dtS` seconds. Stamps `sinceDrainS = 0`.
 * Returns false when the player is exhausted (stamina was already 0 at the
 * start of this call) — caller should treat this as the exhausted state.
 */
export function drainStamina(v: Vitals, perS: number, dtS: number): boolean {
  const wasExhausted = v.stamina <= 0;
  v.sinceDrainS = 0;
  v.stamina -= perS * dtS;
  if (v.stamina < 0) v.stamina = 0;
  return !wasExhausted;
}

// ---------------------------------------------------------------------------
// Step — advance vitals by dtS seconds
// ---------------------------------------------------------------------------

/**
 * Advance the vitals model by `dtS` seconds in the given environment.
 * Mutates `v` in place and returns it (matches inventory model style).
 *
 * Side effects (in order):
 *  1. Compute new temperature.
 *  2. Drain thirst; if zero, accumulate damage tick.
 *  3. If |temperature| >= TEMP_DAMAGE_THRESHOLD, accumulate damage tick.
 *  4. Regen stamina when not draining and regen delay has elapsed.
 */
export function stepVitals(v: Vitals, dtS: number, env: StepEnv): Vitals {
  if (!v.alive) return v;

  // 1. Temperature.
  v.temperature = temperatureAt(env);

  // 2. Thirst drain.
  const drainRate = THIRST_DRAIN_PER_S * (env.hot ? 2.5 : 1);
  v.thirst -= drainRate * dtS;
  if (v.thirst < 0) v.thirst = 0;

  // Thirst damage ticks: accumulate time at zero thirst; 1 hp per 5 s.
  if (v.thirst <= 0) {
    v.thirstTickAccum += dtS;
    while (v.thirstTickAccum >= THIRST_DAMAGE_PERIOD_S) {
      v.thirstTickAccum -= THIRST_DAMAGE_PERIOD_S;
      damagePlayer(v, 1, 'thirst');
    }
  } else {
    v.thirstTickAccum = 0;
  }

  // 3. Temperature damage ticks: 1 hp per 4 s when |temp| >= 2.5.
  if (Math.abs(v.temperature) >= TEMP_DAMAGE_THRESHOLD) {
    v.tempTickAccum += dtS;
    while (v.tempTickAccum >= TEMP_DAMAGE_PERIOD_S) {
      v.tempTickAccum -= TEMP_DAMAGE_PERIOD_S;
      const cause: DamageCause = v.temperature < 0 ? 'cold' : 'heat';
      damagePlayer(v, 1, cause);
    }
  } else {
    v.tempTickAccum = 0;
  }

  // 4. Stamina regen (only when not draining this step).
  if (env.draining) {
    v.sinceDrainS = 0;
  } else {
    v.sinceDrainS += dtS;
    if (v.sinceDrainS >= STAMINA_REGEN_DELAY_S) {
      v.stamina += STAMINA_REGEN_PER_S * dtS;
      if (v.stamina > MAX_STAMINA) v.stamina = MAX_STAMINA;
    }
  }

  return v;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function serializeVitals(v: Vitals): string {
  return JSON.stringify(v);
}

/** Returns null on any validation failure; caller should fall back to createVitals(). */
export function deserializeVitals(json: string): Vitals | null {
  let x: unknown;
  try {
    x = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof x !== 'object' || x === null) return null;
  const o = x as Record<string, unknown>;

  // Validate each field strictly.
  if (typeof o.hp !== 'number' || isNaN(o.hp) || o.hp < 0 || o.hp > MAX_HP)                return null;
  if (typeof o.thirst !== 'number' || isNaN(o.thirst) || o.thirst < 0 || o.thirst > MAX_THIRST) return null;
  if (typeof o.stamina !== 'number' || isNaN(o.stamina) || o.stamina < 0 || o.stamina > MAX_STAMINA) return null;
  if (typeof o.temperature !== 'number' || isNaN(o.temperature) || o.temperature < TEMP_MIN || o.temperature > TEMP_MAX) return null;
  if (typeof o.alive !== 'boolean')                                                         return null;
  if (o.deathCause !== null) {
    if (typeof o.deathCause !== 'string') return null;
    const validCauses: DamageCause[] = [
      'thirst','cold','heat','drowning','lightning','fall','combat','guard','animal',
    ];
    if (!validCauses.includes(o.deathCause as DamageCause)) return null;
  }
  const thirstTickAccum = typeof o.thirstTickAccum === 'number' && !isNaN(o.thirstTickAccum) ? o.thirstTickAccum : 0;
  const tempTickAccum   = typeof o.tempTickAccum   === 'number' && !isNaN(o.tempTickAccum)   ? o.tempTickAccum   : 0;
  const sinceDrainS     = typeof o.sinceDrainS     === 'number' && !isNaN(o.sinceDrainS)     ? o.sinceDrainS     : 0;

  return {
    hp:              o.hp          as number,
    thirst:          o.thirst      as number,
    stamina:         o.stamina     as number,
    temperature:     o.temperature as number,
    alive:           o.alive       as boolean,
    deathCause:      o.deathCause  as DamageCause | null,
    thirstTickAccum,
    tempTickAccum,
    sinceDrainS,
  };
}

export function loadVitals(): Vitals {
  try {
    // Guard for environments without localStorage (Node.js tests).
    if (typeof localStorage === 'undefined') return createVitals();
    const raw = localStorage.getItem(VITALS_KEY);
    if (raw !== null) {
      const v = deserializeVitals(raw);
      if (v !== null) return v;
    }
  } catch { /* storage unavailable */ }
  return createVitals();
}

export function saveVitals(v: Vitals): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(VITALS_KEY, serializeVitals(v));
  } catch { /* storage unavailable */ }
}
