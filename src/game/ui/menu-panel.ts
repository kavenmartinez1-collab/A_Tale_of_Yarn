/**
 * Game menu panel (Escape) — Save / Load / New Game over three save slots.
 * Pure DOM builder for PanelManager; all persistence lives in save-game.ts.
 */

import type { SlotInfo } from '../save-game';

export interface GameMenuOptions {
  slots: (SlotInfo | null)[];
  /** False while inside a dungeon — Save buttons disabled with a hint. */
  canSave: boolean;
  onSave: (slot: number) => void;
  onLoad: (slot: number) => void;
  onNew: () => void;
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

export function buildGameMenuPanel(opts: GameMenuOptions): HTMLElement {
  const el = document.createElement('div');
  el.id = 'game-menu-panel';

  const h = document.createElement('h2');
  h.textContent = 'Game Menu';
  el.appendChild(h);

  for (let i = 0; i < opts.slots.length; i++) {
    const info = opts.slots[i];
    const row = document.createElement('div');
    row.className = 'panel-row';

    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = `Slot ${i + 1}`;
    row.appendChild(label);

    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:12px; opacity:0.75; margin-bottom:5px;';
    meta.textContent = info === null
      ? 'Empty'
      : `${formatDate(info.savedAtMs)} · ${formatPlaytime(info.playtimeS)} played`;
    row.appendChild(meta);

    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex; gap:6px;';

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
    }

    row.appendChild(btns);
    el.appendChild(row);
  }

  // New Game — two-click confirm so a stray click can't wipe the run.
  const newRow = document.createElement('div');
  newRow.className = 'panel-row';
  newRow.style.cssText = 'margin-top:14px; border-top:1px solid rgba(205,214,228,0.15); padding-top:12px;';
  const newBtn = document.createElement('button');
  newBtn.className = 'choice';
  newBtn.textContent = 'New Game';
  let armed = false;
  newBtn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
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
    ? 'Esc to close · Save slots survive New Game'
    : 'Leave the dungeon to save · Esc to close';
  el.appendChild(hint);

  return el;
}
