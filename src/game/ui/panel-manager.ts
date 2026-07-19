/**
 * Shared DOM panel manager — one game panel open at a time (character panel,
 * inventory, crafting…). Handles the pointer-lock dance: opening a panel
 * releases the lock so the mouse can click swatches/slots; closing re-locks
 * if the panel took the lock away. Game keybinds consult `isOpen` to stay
 * quiet while a panel is up. Injects its stylesheet once.
 */

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

  /** Open the panel (closing any other), or close it if already open. */
  toggle(id: string, build: () => HTMLElement): void {
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
    this.relock = document.pointerLockElement === this.canvas;
    if (this.relock) document.exitPointerLock();
    this.onToggle?.(true);
  }

  close(): void {
    if (this.openId === null) return;
    this.removeCurrent();
    if (this.relock) this.canvas.requestPointerLock();
    this.onToggle?.(false);
  }

  private removeCurrent(): void {
    this.openEl?.remove();
    this.openEl = null;
    this.openId = null;
  }
}
