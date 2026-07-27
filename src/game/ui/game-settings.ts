/**
 * Player settings — the machine-level preferences the pause screen edits.
 *
 * WHY THIS EXISTS. Until now the game had exactly one persisted preference
 * (`artifex-audio-muted:v1`, toggled by KeyM) and every other knob was a URL
 * parameter. A packaged Steam player has no URL bar, so `?director=off` — which
 * README.md advertises as *the* performance escape hatch — is unreachable in the
 * shipped build. `release-flags.ts` says so in as many words:
 *
 *   "in a packaged build the player has no URL bar, so if that escape hatch is
 *    still wanted it needs to become a real settings toggle rather than a query
 *    parameter."
 *
 * This is that toggle, plus the audio buses and input preferences that came with
 * the Settings panel.
 *
 * WHY NOT IN `GAME_STATE_KEYS`. Deliberately not snapshotted into save slots.
 * These describe the machine and the player's ears, not the run: loading a save
 * made on a desktop should not force a Steam Deck back to director-on, and
 * `save-game.ts` already draws that line for `artifex-ui:*` and the model
 * caches. It follows `AUDIO_MUTE_KEY`'s precedent — one key, machine-scoped,
 * survives `newGame()` and slot loads.
 *
 * WHY ONE KEY RATHER THAN ONE PER SETTING. `?wipe=1` and the slot machinery
 * iterate `artifex-*` keys; a single blob is one thing to reason about, one
 * quota failure mode, and one version number to migrate. The read is tolerant
 * in the house style — a corrupt blob costs your settings, never a failed boot.
 */

/** localStorage key. NOT in GAME_STATE_KEYS — see the file comment. */
export const SETTINGS_KEY = 'artifex-settings:v1';

export interface GameSettings {
  /** Master output level, 0..1. Multiplies every bus. */
  volMaster: number;
  /** Music bus level, 0..1. The bus exists before any music does — see below. */
  volMusic: number;
  /** Sound-effects bus level, 0..1. */
  volSfx: number;
  /** Villager-voice (TTS) bus level, 0..1. */
  volVoice: number;
  /** Speak NPC dialogue aloud. Text is always primary; this is additive. */
  voiceEnabled: boolean;
  /**
   * The AI Director — LLM dungeon generation, ecology, live NPC replies.
   * `true` here is the same thing `?director=off` used to buy: fixtures and
   * canned dialogue instead of generation, for machines that cannot afford it.
   */
  directorOff: boolean;
  /** Mouse look sensitivity multiplier. 1 = the previous hard-coded rate. */
  mouseSensitivity: number;
  /** Read the gamepad at all. Off means a connected pad is ignored entirely. */
  gamepadEnabled: boolean;
  /**
   * Render-scale multiplier, 0.5..1. The renderer resolves its backbuffer at
   * this fraction of the CSS size and upscales — the cheapest real graphics
   * knob on a fill-bound machine.
   */
  renderScale: number;
}

export const DEFAULT_SETTINGS: GameSettings = {
  volMaster: 0.6,   // matches GameAudio's historical hard-coded 0.6
  volMusic: 0.5,
  volSfx: 0.8,
  volVoice: 0.9,
  voiceEnabled: true,
  directorOff: false,
  mouseSensitivity: 1,
  gamepadEnabled: true,
  renderScale: 1,
};

const clamp01 = (v: unknown, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : dflt;

const clampRange = (v: unknown, lo: number, hi: number, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt;

const asBool = (v: unknown, dflt: boolean): boolean =>
  typeof v === 'boolean' ? v : dflt;

/**
 * Coerce anything into a valid settings object.
 *
 * Every field is clamped rather than validated-and-rejected: a slider that
 * persisted 1e9 should come back as 1, not throw away the other eight settings.
 */
export function normalizeSettings(raw: unknown): GameSettings {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    volMaster: clamp01(o.volMaster, DEFAULT_SETTINGS.volMaster),
    volMusic: clamp01(o.volMusic, DEFAULT_SETTINGS.volMusic),
    volSfx: clamp01(o.volSfx, DEFAULT_SETTINGS.volSfx),
    volVoice: clamp01(o.volVoice, DEFAULT_SETTINGS.volVoice),
    voiceEnabled: asBool(o.voiceEnabled, DEFAULT_SETTINGS.voiceEnabled),
    directorOff: asBool(o.directorOff, DEFAULT_SETTINGS.directorOff),
    mouseSensitivity: clampRange(o.mouseSensitivity, 0.2, 3, DEFAULT_SETTINGS.mouseSensitivity),
    gamepadEnabled: asBool(o.gamepadEnabled, DEFAULT_SETTINGS.gamepadEnabled),
    renderScale: clampRange(o.renderScale, 0.5, 1, DEFAULT_SETTINGS.renderScale),
  };
}

/** Read the persisted settings (missing/corrupt → defaults). */
export function loadSettings(): GameSettings {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_SETTINGS };
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw === null) return { ...DEFAULT_SETTINGS };
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persist the settings. Silent on quota, like every other artifex-* writer. */
export function saveSettings(s: GameSettings): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch { /* quota */ }
}

// ---------------------------------------------------------------------------
// Live store
// ---------------------------------------------------------------------------

type Listener = (s: GameSettings) => void;

/**
 * The one live copy, plus change notification.
 *
 * The panel writes through `set()`, which persists AND fans out, so "applies
 * live" and "persists across reload" are the same code path rather than two
 * that can drift. `scripts/controller-ui-check.mjs` asserts both halves.
 */
class SettingsStore {
  private s: GameSettings = loadSettings();
  private listeners = new Set<Listener>();

  get(): Readonly<GameSettings> { return this.s; }

  /** Apply a partial change: persist, then notify. */
  set(patch: Partial<GameSettings>): void {
    this.s = normalizeSettings({ ...this.s, ...patch });
    saveSettings(this.s);
    for (const l of this.listeners) {
      try { l(this.s); } catch { /* a bad listener must not block the others */ }
    }
  }

  /** Subscribe; returns an unsubscribe. Fires immediately with current state. */
  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    l(this.s);
    return () => { this.listeners.delete(l); };
  }

  /** Restore defaults (the panel's "Reset" affordance). */
  reset(): void { this.set({ ...DEFAULT_SETTINGS }); }
}

export const settings = new SettingsStore();
