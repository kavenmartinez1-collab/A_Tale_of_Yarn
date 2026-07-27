/**
 * Shared DOM panel manager — one game panel open at a time (character panel,
 * inventory, crafting…). Handles the pointer-lock dance: opening a panel
 * releases the lock so the mouse can click swatches/slots; closing re-locks
 * if the panel took the lock away. Game keybinds consult `isOpen` to stay
 * quiet while a panel is up. Injects its stylesheet once.
 */

import { releasePointerLock } from './pointer-lock';

const PANEL_CSS = `
.game-panel {
  position: fixed;
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
  background: rgba(10, 14, 20, 0.90);
  color: #cdd6e4;
  padding: 14px 18px;
  border-radius: 10px;
  border: 1px solid rgba(205, 214, 228, 0.15);
  font-size: 13px;
  min-width: 230px;
  z-index: 20;
  user-select: none;
}
.game-panel h2 {
  margin: 0 0 10px;
  font-size: 15px;
  font-weight: 600;
}
.game-panel .panel-row { margin: 10px 0; }
.game-panel .row-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.7;
  margin-bottom: 4px;
}
.game-panel .swatches { display: flex; gap: 6px; flex-wrap: wrap; }
.game-panel .swatch {
  width: 24px;
  height: 24px;
  border-radius: 5px;
  border: 2px solid transparent;
  cursor: pointer;
  padding: 0;
}
.game-panel .swatch.sel { border-color: #ffffff; }
.game-panel .choice {
  background: rgba(205, 214, 228, 0.12);
  color: inherit;
  border: 2px solid transparent;
  border-radius: 5px;
  padding: 3px 10px;
  cursor: pointer;
  font: inherit;
}
.game-panel .choice.sel { border-color: #ffffff; }
.game-panel .hint { margin-top: 12px; font-size: 11px; opacity: 0.55; }
`;

export class PanelManager {
  private openEl: HTMLElement | null = null;
  private relock = false;
  /** Id of the open panel, or null. */
  openId: string | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    /** Called after any open/close so main can sync overlay visibility. */
    private readonly onToggle?: (open: boolean) => void,
  ) {
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    document.head.appendChild(style);
  }

  get isOpen(): boolean {
    return this.openId !== null;
  }

  /**
   * Open the panel (closing any other), or close it if already open.
   *
   * `forceRelock` is for the panel the browser opens on our behalf: the first
   * Escape out of pointer lock never reaches the page, so by the time the
   * pause screen goes up the lock is already gone and the usual "did I take
   * the lock?" test says no. Closing would then dump the player onto the
   * click-to-play overlay after every pause. The caller who KNOWS the player
   * was locked a moment ago passes true.
   */
  toggle(id: string, build: () => HTMLElement, forceRelock = false): void {
    if (this.openId === id) {
      this.close();
      return;
    }
    this.removeCurrent();
    const el = build();
    el.classList.add('game-panel');
    document.body.appendChild(el);
    this.openEl = el;
    this.openId = id;
    const held = document.pointerLockElement === this.canvas;
    this.relock = held || forceRelock;
    // Via the helper so main's pointerlockchange handler knows this release was
    // deliberate and does not read it as the player pressing Escape.
    if (held) releasePointerLock();
    this.onToggle?.(true);
  }

  close(): void {
    if (this.openId === null) return;
    this.removeCurrent();
    if (this.relock) {
      // Chrome refuses a re-lock for about a second after the user left one
      // with Escape, and rejects the returned promise. Unhandled, that lands
      // in the console as an error — which the play harnesses count as a bug.
      // The overlay reappears on its own in that case, so a refusal is fine.
      try {
        const r = this.canvas.requestPointerLock() as unknown;
        if (r instanceof Promise) r.catch(() => { /* refused; overlay shows */ });
      } catch { /* refused; overlay shows */ }
    }
    this.onToggle?.(false);
  }

  private removeCurrent(): void {
    // Panels that bound listeners outside their own subtree (the map takes
    // arrow keys on `window` in the capture phase) get one event to unbind on.
    // Without it those listeners outlive the element and keep eating keys.
    this.openEl?.dispatchEvent(new CustomEvent('panel-close'));
    this.openEl?.remove();
    this.openEl = null;
    this.openId = null;
  }
}
