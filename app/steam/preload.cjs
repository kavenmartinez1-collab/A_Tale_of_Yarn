/**
 * Renderer bridge — the thin IPC seam between the game and the main process.
 *
 * docs/PORTING.md §2.6 notes steamworks.js "needs contextIsolation: false,
 * nodeIntegration: true to call from the renderer". We deliberately do NOT do
 * that: everything Steam-shaped stays in the main process and the renderer sees
 * only the four calls below through a contextBridge. Turning off context
 * isolation would hand full Node to a page that runs a 1.7B language model's
 * output through the DOM, which is not a trade worth making for convenience.
 *
 * `window.steamBridge` is absent when the game runs in a normal browser, so
 * every consumer must feature-detect. Nothing in the game requires it.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('steamBridge', {
  /** Wrapper identity — lets the game tell "packaged Steam build" from "a tab". */
  isSteamWrapper: true,

  /**
   * @returns {Promise<{isSteamRunning: boolean, isSteamRunningOnSteamDeck: boolean,
   *                    appId: number|null, reason: string|null,
   *                    overlaySwitchesFrom: string}>}
   */
  status: () => ipcRenderer.invoke('steam:status'),

  /**
   * Deck on-screen keyboard. Pass the chat field's rectangle in window pixels
   * so Steam can place the keyboard without covering it. No-op (false) when
   * Steam is not running.
   * @param {{x?: number, y?: number, width?: number, height?: number, mode?: number}} rect
   * @returns {Promise<boolean>}
   */
  showFloatingKeyboard: (rect) => ipcRenderer.invoke('steam:floatingKeyboard', rect),

  /** Big Picture modal text entry. Resolves to the entered string, or null. */
  showTextInput: (opts) => ipcRenderer.invoke('steam:textInput', opts),

  /** Window control — the game's own settings UI can drive these later. */
  setFullscreen: (on) => ipcRenderer.invoke('window:setFullscreen', !!on),
  isFullscreen: () => ipcRenderer.invoke('window:isFullscreen'),

  /**
   * Count of external (non-loopback) network requests seen since launch, and
   * how many were cancelled. Exists so the offline proof can assert zero
   * attempts from inside the app rather than trusting a page-level route hook.
   * @returns {Promise<{attempted: number, blocked: number, urls: string[]}>}
   */
  networkAudit: () => ipcRenderer.invoke('net:audit'),

  /**
   * Loopback server counters: {requests, ranges, bytesServed, notFound}.
   * The only in-app signal for "are the weights still streaming off disk" —
   * a 1.03 GB GGUF takes real seconds, and both a support ticket and the
   * packaging harness need to tell "still loading" from "stuck".
   */
  serverStats: () => ipcRenderer.invoke('server:stats'),
});
