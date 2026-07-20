/**
 * Crime & bounty ledger — pure, deterministic, engine/DOM-free.
 *
 * Tracks per-region bounty and a capped crime log. Inspired by Skyrim's
 * bounty system: crimes are witnessed within a radius, each crime kind has a
 * fixed gold value, and bounty can be paid off or served as jail time.
 *
 * Persistence key: 'artifex-crime:v1'
 *
 * Phase G — no HUD, no main.ts wiring — those come later.
 */

// ---------------------------------------------------------------------------
// Constants (exported so tests and integration can reference them)
// ---------------------------------------------------------------------------

/** Horizontal witness radius in metres. */
export const WITNESS_RADIUS = 30;

/** Maximum crime log entries kept per region (oldest dropped beyond cap). */
export const CRIME_LOG_MAX = 20;

/** localStorage key for crime state persistence. */
export const CRIME_KEY = 'artifex-crime:v1';

/** Jail seconds accrued per 100 bounty gold. */
export const JAIL_SECONDS_PER_100_BOUNTY = 30;

/** Minimum jail sentence in seconds (applied when bounty > 0). */
export const JAIL_MIN_S = 20;

/** Maximum jail sentence in seconds. */
export const JAIL_MAX_S = 240;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CrimeKind =
  | 'theft'
  | 'horse_theft'
  | 'assault'
  | 'murder'
  | 'kill_owned_animal'
  | 'escape_jail'
  | 'threat';

/** Gold bounty value for each crime kind. */
export const BOUNTY_AMOUNTS: Record<CrimeKind, number> = {
  theft:             25,
  horse_theft:       50,
  assault:          200,
  murder:          1000,
  kill_owned_animal: 30,
  escape_jail:      100,
  threat:            15,
};

/** Per-region ledger: outstanding bounty and a capped, chronological log. */
export interface RegionLedger {
  /** Total gold owed in this region. */
  bounty: number;
  /** Capped log of committed crimes, newest last. */
  crimes: { kind: CrimeKind; t: number }[];
}

/** Top-level crime state keyed by opaque region id strings (e.g. "3,-2"). */
export interface CrimeState {
  regions: Record<string, RegionLedger>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Returns a fresh crime state with no bounties. */
export function createCrimeState(): CrimeState {
  return { regions: {} };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the actor at horizontal offset (dx, dz) is within
 * WITNESS_RADIUS metres AND has line-of-sight to the crime location.
 * LOS computation lives in the caller; this function only combines the inputs.
 */
export function isWitnessed(dx: number, dz: number, hasLineOfSight: boolean): boolean {
  const dist = Math.sqrt(dx * dx + dz * dz);
  return dist <= WITNESS_RADIUS && hasLineOfSight;
}

/**
 * Record a witnessed crime in `region`.
 * Creates the region ledger on first use.
 * Appends the crime to the log (dropping oldest when cap is exceeded).
 * Returns the new bounty total for that region.
 */
export function reportCrime(
  state: CrimeState,
  region: string,
  kind: CrimeKind,
  t: number,
): number {
  if (!state.regions[region]) {
    state.regions[region] = { bounty: 0, crimes: [] };
  }
  const ledger = state.regions[region];
  ledger.bounty += BOUNTY_AMOUNTS[kind];
  ledger.crimes.push({ kind, t });
  if (ledger.crimes.length > CRIME_LOG_MAX) {
    ledger.crimes.splice(0, ledger.crimes.length - CRIME_LOG_MAX);
  }
  return ledger.bounty;
}

/** Returns the current bounty in `region`, or 0 when the region is unknown. */
export function bountyIn(state: CrimeState, region: string): number {
  return state.regions[region]?.bounty ?? 0;
}

/** Returns the sum of all regional bounties. */
export function totalBounty(state: CrimeState): number {
  let total = 0;
  for (const ledger of Object.values(state.regions)) {
    total += ledger.bounty;
  }
  return total;
}

/**
 * Pay up to `gold` towards the bounty in `region`.
 * Pays min(gold, bounty). When bounty reaches 0 the crime log is cleared.
 * Returns `{ paid, remaining }` where `remaining` is the bounty left after payment.
 */
export function payBounty(
  state: CrimeState,
  region: string,
  gold: number,
): { paid: number; remaining: number } {
  const ledger = state.regions[region];
  if (!ledger || ledger.bounty <= 0) {
    return { paid: 0, remaining: 0 };
  }
  const paid = Math.min(gold, ledger.bounty);
  ledger.bounty -= paid;
  if (ledger.bounty <= 0) {
    ledger.bounty = 0;
    ledger.crimes = [];
  }
  return { paid, remaining: ledger.bounty };
}

/**
 * Compute jail sentence length in seconds for a given bounty amount.
 * Returns 0 when bounty <= 0; otherwise bounty/100 * JAIL_SECONDS_PER_100_BOUNTY,
 * clamped to [JAIL_MIN_S, JAIL_MAX_S].
 */
export function jailSentenceS(bounty: number): number {
  if (bounty <= 0) return 0;
  const raw = (bounty / 100) * JAIL_SECONDS_PER_100_BOUNTY;
  return Math.max(JAIL_MIN_S, Math.min(JAIL_MAX_S, raw));
}

/**
 * Serve a jail sentence for `region`: clears that region's bounty and crime log.
 * Inventory confiscation is handled by the caller.
 */
export function serveSentence(state: CrimeState, region: string): void {
  if (state.regions[region]) {
    state.regions[region].bounty = 0;
    state.regions[region].crimes = [];
  }
}

/**
 * Convenience: record an escape_jail crime in `region` at time `t`.
 * Returns the new region bounty.
 */
export function escapeJail(state: CrimeState, region: string, t: number): number {
  return reportCrime(state, region, 'escape_jail', t);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const VALID_CRIME_KINDS: ReadonlySet<string> = new Set<CrimeKind>([
  'theft', 'horse_theft', 'assault', 'murder', 'kill_owned_animal', 'escape_jail',
  'threat',
]);

export function serializeCrimeState(s: CrimeState): string {
  return JSON.stringify(s);
}

/**
 * Deserialize a CrimeState from JSON.
 * Returns null on any validation failure; caller should fall back to createCrimeState().
 *
 * Rejects:
 *  - non-object / null top-level value
 *  - missing or non-object `regions`
 *  - any region ledger that is not an object
 *  - NaN, negative, or infinite bounty
 *  - crimes not an array
 *  - any crime entry whose `kind` is not a known CrimeKind
 *  - any crime entry whose `t` is not a finite number
 */
export function deserializeCrimeState(json: string): CrimeState | null {
  let x: unknown;
  try {
    x = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;

  const top = x as Record<string, unknown>;
  if (typeof top.regions !== 'object' || top.regions === null || Array.isArray(top.regions)) {
    return null;
  }

  const regionsRaw = top.regions as Record<string, unknown>;
  const regions: Record<string, RegionLedger> = {};

  for (const [regionId, ledgerRaw] of Object.entries(regionsRaw)) {
    if (typeof ledgerRaw !== 'object' || ledgerRaw === null || Array.isArray(ledgerRaw)) {
      return null;
    }
    const l = ledgerRaw as Record<string, unknown>;

    // Validate bounty.
    if (typeof l.bounty !== 'number') return null;
    if (isNaN(l.bounty) || l.bounty < 0 || !isFinite(l.bounty)) return null;

    // Validate crimes array.
    if (!Array.isArray(l.crimes)) return null;
    const crimes: { kind: CrimeKind; t: number }[] = [];
    for (const entry of l.crimes) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
      const e = entry as Record<string, unknown>;
      if (typeof e.kind !== 'string' || !VALID_CRIME_KINDS.has(e.kind)) return null;
      if (typeof e.t !== 'number' || !isFinite(e.t)) return null;
      crimes.push({ kind: e.kind as CrimeKind, t: e.t });
    }

    regions[regionId] = { bounty: l.bounty, crimes };
  }

  return { regions };
}

export function loadCrimeState(): CrimeState {
  try {
    if (typeof localStorage === 'undefined') return createCrimeState();
    const raw = localStorage.getItem(CRIME_KEY);
    if (raw !== null) {
      const s = deserializeCrimeState(raw);
      if (s !== null) return s;
    }
  } catch { /* storage unavailable */ }
  return createCrimeState();
}

export function saveCrimeState(s: CrimeState): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(CRIME_KEY, serializeCrimeState(s));
  } catch { /* storage unavailable */ }
}
