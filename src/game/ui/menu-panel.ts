/**
 * Game menu panel (Escape) — Save / Load / Delete over three save slots, plus
 * New Game. Pure DOM builder; all persistence lives in save-game.ts.
 *
 * Delete is the one irreversible action here, so it is guarded three ways:
 * a two-click confirm that names what is about to be destroyed, a disabled
 * control on the slot currently being played, and — because a disabled button
 * is a hint rather than a rule — a matching refusal inside `deleteSlot`
 * itself. A browser `confirm()` is deliberately not used: the game holds
 * pointer lock and a modal dialog blocks the event loop under it.
 */

import type { SlotInfo } from '../save-game';

export interface GameMenuOptions {
  slots: (SlotInfo | null)[];
  /** False while inside a dungeon — Save buttons disabled with a hint. */
  canSave: boolean;
  /**
   * The slot being played (last saved to or loaded from), or null. Its Delete
   * control is disabled rather than hidden: a missing button reads as a bug,
   * a disabled one with a reason reads as a rule.
   */
  activeSlot?: number | null;
  onSave: (slot: number) => void;
  onLoad: (slot: number) => void;
  onNew: () => void;
  /**
   * Erase a slot. Returns the refreshed slot list so the panel can re-render
   * without knowing anything about storage; returning the old list (or the
   * same one) is how a refusal is reported.
   */
  onDelete?: (slot: number) => (SlotInfo | null)[];
}

function formatPlaytime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/** What a slot holds, in words — for the row and for the delete confirmation. */
function describe(info: SlotInfo): string {
  return `${formatDate(info.savedAtMs)} · ${formatPlaytime(info.playtimeS)} played`;
}

export function buildGameMenuPanel(opts: GameMenuOptions): HTMLElement {
  const el = document.createElement('div');
  el.id = 'game-menu-panel';

  const h = document.createElement('h2');
  h.textContent = 'Game Menu';
  el.appendChild(h);

  const slotsBox = document.createElement('div');
  el.appendChild(slotsBox);

  /** Slot whose Delete is armed, or -1. Only ever one at a time. */
  let armed = -1;

  function renderSlots(slots: (SlotInfo | null)[]): void {
    slotsBox.textContent = '';
    for (let i = 0; i < slots.length; i++) {
      const info = slots[i];
      const isActive = opts.activeSlot === i;
      const row = document.createElement('div');
      row.className = 'panel-row';

      const label = document.createElement('div');
      label.className = 'row-label';
      label.textContent = isActive ? `Slot ${i + 1} · playing` : `Slot ${i + 1}`;
      row.appendChild(label);

      const meta = document.createElement('div');
      meta.style.cssText = 'font-size:12px; opacity:0.75; margin-bottom:5px;';
      meta.textContent = info === null ? 'Empty' : describe(info);
      row.appendChild(meta);

      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex; gap:6px; flex-wrap:wrap;';

      const saveBtn = document.createElement('button');
      saveBtn.className = 'choice';
      saveBtn.textContent = info === null ? 'Save' : 'Overwrite';
      saveBtn.disabled = !opts.canSave;
      if (!opts.canSave) saveBtn.style.opacity = '0.4';
      saveBtn.addEventListener('click', () => opts.onSave(i));
      btns.appendChild(saveBtn);

      if (info !== null) {
        const loadBtn = document.createElement('button');
        loadBtn.className = 'choice';
        loadBtn.textContent = 'Load';
        loadBtn.addEventListener('click', () => opts.onLoad(i));
        btns.appendChild(loadBtn);

        if (opts.onDelete !== undefined) {
          const delBtn = document.createElement('button');
          delBtn.className = 'choice';
          delBtn.disabled = isActive;
          if (isActive) {
            delBtn.textContent = 'Delete';
            delBtn.style.opacity = '0.4';
            delBtn.title = 'You are playing this save';
          } else if (armed === i) {
            // Name what is about to go. "Delete slot 2?" tells the player
            // nothing about which playthrough slot 2 actually is.
            delBtn.textContent = `Delete ${describe(info)}? Click again`;
            delBtn.style.borderColor = '#e06c5a';
            delBtn.style.color = '#e06c5a';
          } else {
            delBtn.textContent = 'Delete';
          }
          delBtn.addEventListener('click', () => {
            if (isActive) return; // belt and braces; the button is disabled too
            if (armed !== i) {
              armed = i; // arming one disarms any other
              renderSlots(slots);
              return;
            }
            armed = -1;
            renderSlots(opts.onDelete!(i));
          });
          btns.appendChild(delBtn);
        }
      }

      row.appendChild(btns);
      slotsBox.appendChild(row);
    }
  }
  renderSlots(opts.slots);

  // New Game — two-click confirm so a stray click can't wipe the run.
  const newRow = document.createElement('div');
  newRow.className = 'panel-row';
  newRow.style.cssText = 'margin-top:14px; border-top:1px solid rgba(205,214,228,0.15); padding-top:12px;';
  const newBtn = document.createElement('button');
  newBtn.className = 'choice';
  newBtn.textContent = 'New Game';
  let newArmed = false;
  newBtn.addEventListener('click', () => {
    if (!newArmed) {
      newArmed = true;
      newBtn.textContent = 'Really start over? (unsaved progress is lost)';
      newBtn.style.borderColor = '#e06c5a';
      return;
    }
    opts.onNew();
  });
  newRow.appendChild(newBtn);
  el.appendChild(newRow);

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = opts.canSave
    ? 'Esc to close · Delete cannot be undone · Save slots survive New Game'
    : 'Leave the dungeon to save · Esc to close';
  el.appendChild(hint);

  return el;
}
