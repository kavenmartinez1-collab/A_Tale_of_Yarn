/**
 * Steamworks scaffold — init, overlay switches, and the IPC-facing surface.
 *
 * The governing rule: **the game must run perfectly when Steam is not running.**
 * Every failure mode here (module missing, native binding missing, Steam client
 * not running, wrong app id) resolves to the same thing — a logged reason, a
 * `state` object saying `available: false`, and the game boots normally. There
 * is no dialog, no throw, no early exit anywhere in this file.
 *
 * Dependency provenance (docs/PORTING.md §2.6): `steamworks.js` is installed
 * FROM GIT (`github:ceifa/steamworks.js`), not npm — npm's `latest` is 0.4.0
 * from 2024-08-06 while the repo is active. The git checkout ships JS and
 * typings only; `dist/<platform>/*.node` is produced by `npm run build` in the
 * package dir and needs a Rust toolchain plus the MSVC C++ build tools. Until
 * that build is run on a machine that has them, `require('steamworks.js')`
 * throws MODULE_NOT_FOUND for the .node and we take the degraded path below —
 * which is exactly the path a player without Steam takes, so it is not a
 * special case, just an earlier one.
 */

/** @type {{available: boolean, reason: string|null, appId: number|null, onSteamDeck: boolean, overlaySwitchesFrom: string}} */
const state = {
  available: false,
  reason: 'not initialised',
  appId: null,
  onSteamDeck: false,
  overlaySwitchesFrom: 'none',
};

/** The steamworks.js module handle, or null when it could not be loaded. */
let sw = null;
/** The client API object returned by `init()`, or null. */
let client = null;

function load() {
  if (sw !== null) return sw;
  try {
    // eslint-disable-next-line global-require
    sw = require('steamworks.js');
  } catch (err) {
    sw = false;
    state.reason = `steamworks.js unavailable: ${err && err.message ? err.message.split('\n')[0] : err}`;
    console.warn(`[Steam] ${state.reason}`);
  }
  return sw;
}

/**
 * Apply the Chromium switches the Steam overlay needs, without duplicating
 * them.
 *
 * docs/PORTING.md §2.4: the overlay needs `--in-process-gpu` (so
 * SteamAPI_Init can hook device creation — it cannot reach into a separate GPU
 * process) plus `--disable-direct-composition`. WebGPU survives both on this
 * machine [MEASURED-HERE], which is what makes the overlay affordable at all.
 *
 * `steamworks.electronEnableSteamOverlay()` appends exactly those two switches
 * itself, and — unless you pass `true` — also attaches a 60 Hz
 * `webContents.invalidate()` to every window. That forced repaint is pure
 * overhead for a game that already paints every frame (§2.4), so we always
 * pass `true`.
 *
 * Reconciliation: we call steamworks' version when the module loaded, and only
 * append the switches ourselves when it did not. Either way the command line
 * ends up with one copy of each.
 *
 * MUST be called before `app.whenReady()` — Chromium reads its command line
 * once, at GPU/browser start-up.
 *
 * @param {import('electron').App} app
 */
function applyOverlaySwitches(app) {
  const mod = load();
  if (mod) {
    try {
      mod.electronEnableSteamOverlay(true); // true = no 60 Hz forced invalidate
      state.overlaySwitchesFrom = 'steamworks.js';
    } catch (err) {
      console.warn(`[Steam] electronEnableSteamOverlay failed: ${err}`);
    }
  }
  if (state.overlaySwitchesFrom !== 'steamworks.js') {
    app.commandLine.appendSwitch('in-process-gpu');
    app.commandLine.appendSwitch('disable-direct-composition');
    state.overlaySwitchesFrom = 'fallback';
  }
}

/**
 * Initialise the Steam client. Returns the state object; never throws.
 *
 * @param {number} appId Valve's Spacewar test id (480) until partner setup.
 */
function init(appId) {
  const mod = load();
  if (!mod) return state;
  try {
    client = mod.init(appId);
    state.available = true;
    state.reason = null;
    try { state.appId = client.utils.getAppId(); } catch { state.appId = appId; }
    try { state.onSteamDeck = client.utils.isSteamRunningOnSteamDeck(); } catch { /* older binding */ }
    console.log(`[Steam] initialised — appId=${state.appId} deck=${state.onSteamDeck}`);
  } catch (err) {
    // The overwhelmingly common case: the player launched the exe directly and
    // the Steam client is not running. Not an error condition for us.
    state.available = false;
    state.reason = `init failed (Steam not running?): ${err && err.message ? err.message.split('\n')[0] : err}`;
    console.warn(`[Steam] ${state.reason} — continuing without Steam`);
  }
  return state;
}

/** Snapshot for the renderer. Cheap; safe to call every frame if you must. */
function status() {
  return {
    isSteamRunning: state.available,
    isSteamRunningOnSteamDeck: state.available ? state.onSteamDeck : false,
    appId: state.appId,
    reason: state.reason,
    overlaySwitchesFrom: state.overlaySwitchesFrom,
  };
}

/**
 * Floating on-screen keyboard, for the Deck.
 *
 * docs/PORTING.md §3.3: `ShowFloatingGamepadTextInput` "sends OS keyboard keys
 * directly to the game", and the NPC chat field is a real DOM `<input>`
 * (npc-chat-panel.ts:1310) — so the synthesised keystrokes land in it with no
 * custom text widget needed. The rectangle is in window pixels and only
 * positions the keyboard so it does not cover the field.
 *
 * This is plumbing for the Deck tier, not a Tier-1 feature: it is wired,
 * reachable from the renderer, and completely untested on hardware.
 *
 * @returns {Promise<boolean>} true if the keyboard was shown.
 */
async function showFloatingKeyboard({ x = 0, y = 0, width = 0, height = 0, mode = 0 } = {}) {
  if (!state.available || !client) return false;
  try {
    return await client.utils.showFloatingGamepadTextInput(mode, x, y, width, height);
  } catch (err) {
    console.warn(`[Steam] showFloatingGamepadTextInput failed: ${err}`);
    return false;
  }
}

/** Big Picture modal text entry — the fallback when the floating one is unavailable. */
async function showGamepadTextInput({ description = '', maxCharacters = 256, existingText = '' } = {}) {
  if (!state.available || !client) return null;
  try {
    return await client.utils.showGamepadTextInput(0, 0, description, maxCharacters, existingText);
  } catch (err) {
    console.warn(`[Steam] showGamepadTextInput failed: ${err}`);
    return null;
  }
}

module.exports = {
  applyOverlaySwitches,
  init,
  status,
  showFloatingKeyboard,
  showGamepadTextInput,
  get client() { return client; },
};
