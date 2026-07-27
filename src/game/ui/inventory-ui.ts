/**
 * Inventory UI — the always-visible bottom-center hotbar (keys 1–5) and the
 * Tab/I inventory panel (28-slot pack grid + hotbar mirror, click-to-move).
 * Item icons are colored squares with the item's initial — no art assets.
 * Pure DOM; the model lives in inventory.ts, persistence in main.ts via
 * `onChange`.
 */

import { ITEM_DEFS, itemDef } from '../items';
import { itemIcon } from './item-icons';
import {
  moveSlot, dropSlot, equipArmor, unequipArmor, totalDefense,
  type Inventory, type Slot, type SlotRef,
} from '../inventory';

const UI_CSS = `
#hotbar {
  position: fixed;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  display: flex;
  gap: 6px;
  z-index: 15;
  user-select: none;
}
.inv-slot {
  position: relative;
  width: 44px;
  height: 44px;
  border-radius: 7px;
  background: rgba(10, 14, 20, 0.75);
  border: 2px solid rgba(205, 214, 228, 0.20);
  cursor: pointer;
  padding: 0;
}
.inv-slot.sel { border-color: #ffffff; }
.inv-slot.src { border-color: #e8c35a; }
.inv-slot .icon {
  position: absolute;
  inset: 7px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.85);
  font: 600 15px system-ui, sans-serif;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
}
.inv-slot .count {
  position: absolute;
  right: 2px;
  bottom: 1px;
  color: #f0e6c8;
  font: 600 10px system-ui, sans-serif;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
  pointer-events: none;
}
.inv-slot .key {
  position: absolute;
  left: 3px;
  top: 1px;
  color: rgba(205, 214, 228, 0.7);
  font: 600 9px system-ui, sans-serif;
  pointer-events: none;
}
#inventory-panel .inv-grid {
  display: grid;
  grid-template-columns: repeat(7, 44px);
  gap: 6px;
}
#inventory-panel .inv-hotbar-row {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}
#inventory-panel .armor-section {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 6px;
}
#inventory-panel .armor-slots {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
#inventory-panel .armor-slot-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
#inventory-panel .armor-label {
  color: rgba(205, 214, 228, 0.7);
  font: 600 10px system-ui, sans-serif;
  min-width: 30px;
}
#inventory-panel .defense-readout {
  margin-top: 4px;
  color: rgba(205, 214, 228, 0.8);
  font: 600 11px system-ui, sans-serif;
}
.drop-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.drop-btn {
  padding: 5px 14px;
  border-radius: 7px;
  border: 1px solid #a8443a;
  background: #3a1f1c;
  color: #f0cfc9;
  font: inherit;
  cursor: pointer;
}
.drop-btn:hover { background: #522a25; }
.drop-msg {
  font-size: 12px;
  color: #e8b9a5;
  min-height: 14px;
}
`;

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = UI_CSS;
  document.head.appendChild(style);
}

/** Fill a slot button with the item's pictogram icon + count badge. */
function renderSlot(btn: HTMLButtonElement, slot: Slot): void {
  btn.querySelector('.icon')?.remove();
  btn.querySelector('.count')?.remove();
  if (slot === null) {
    btn.title = '';
    return;
  }
  const def = ITEM_DEFS[slot.id];
  btn.title = def.name;
  const icon = document.createElement('div');
  icon.className = 'icon';
  icon.style.background =
    `url(${itemIcon(slot.id)}) center / contain no-repeat`;
  btn.appendChild(icon);
  if (slot.count > 1) {
    const count = document.createElement('div');
    count.className = 'count';
    count.textContent = String(slot.count);
    btn.appendChild(count);
  }
}

/** Always-visible bottom-center hotbar. Click or keys 1–5 select. */
export class Hotbar {
  private readonly buttons: HTMLButtonElement[] = [];

  constructor(
    private readonly inv: Inventory,
    private readonly onChange: () => void,
  ) {
    injectCss();
    const el = document.createElement('div');
    el.id = 'hotbar';
    for (let i = 0; i < inv.hotbar.length; i++) {
      const b = document.createElement('button');
      b.className = 'inv-slot';
      const key = document.createElement('div');
      key.className = 'key';
      key.textContent = String(i + 1);
      b.appendChild(key);
      b.addEventListener('click', () => this.select(i));
      el.appendChild(b);
      this.buttons.push(b);
    }
    document.body.appendChild(el);
    this.refresh();
  }

  select(i: number): void {
    this.inv.selected = i;
    this.onChange();
  }

  /** Re-render all slots + selection ring from the model. */
  refresh(): void {
    this.buttons.forEach((b, i) => {
      renderSlot(b, this.inv.hotbar[i]);
      b.classList.toggle('sel', i === this.inv.selected);
    });
  }
}

/**
 * Inventory panel content for PanelManager. Click a slot to pick it up
 * (gold ring), click another to move/swap/merge; click again to cancel.
 */
export function buildInventoryPanel(
  inv: Inventory,
  onChange: () => void,
): HTMLElement {
  injectCss();
  const el = document.createElement('div');
  el.id = 'inventory-panel';
  const h = document.createElement('h2');
  h.textContent = 'Inventory';
  el.appendChild(h);

  let src: SlotRef | null = null;
  const buttons = new Map<string, HTMLButtonElement>();
  const refKey = (r: SlotRef) => `${r.area}:${r.index}`;

  const refresh = () => {
    for (const [key, b] of buttons) {
      const [area, idx] = key.split(':');
      const ref: SlotRef = { area: area as SlotRef['area'], index: Number(idx) };
      renderSlot(b, area === 'pack' ? inv.pack[ref.index] : inv.hotbar[ref.index]);
      b.classList.toggle('src', src !== null && refKey(src) === key);
    }
  };

  const slotButton = (ref: SlotRef): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = 'inv-slot';
    b.dataset.area = ref.area;
    b.dataset.index = String(ref.index);
    b.addEventListener('click', () => {
      const slot = ref.area === 'pack' ? inv.pack[ref.index] : inv.hotbar[ref.index];
      if (src === null) {
        if (slot !== null) src = ref; // pick up (only non-empty)
      } else if (refKey(src) === refKey(ref)) {
        src = null; // cancel
      } else {
        moveSlot(inv, src, ref);
        src = null;
        onChange();
      }
      refresh();
    });
    // Right-click discards straight from the slot: one item, or the whole
    // stack with Shift. The Drop button below is the discoverable route; this
    // is the fast one for clearing several slots in a row.
    b.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      const dropped = dropSlot(inv, ref, ev.shiftKey);
      if (dropped === null) return;
      src = null;
      announce(`Dropped ${dropped.count}× ${itemDef(dropped.id).name}`);
      onChange();
      refresh();
    });
    buttons.set(refKey(ref), b);
    return b;
  };

  const grid = document.createElement('div');
  grid.className = 'inv-grid';
  for (let i = 0; i < inv.pack.length; i++) {
    grid.appendChild(slotButton({ area: 'pack', index: i }));
  }
  el.appendChild(grid);

  const lab = document.createElement('div');
  lab.className = 'row-label';
  lab.style.marginTop = '10px';
  lab.textContent = 'Hotbar';
  el.appendChild(lab);
  const hotbarRow = document.createElement('div');
  hotbarRow.className = 'inv-hotbar-row';
  for (let i = 0; i < inv.hotbar.length; i++) {
    hotbarRow.appendChild(slotButton({ area: 'hotbar', index: i }));
  }
  el.appendChild(hotbarRow);

  // --- Armor slots ---
  const armorSection = document.createElement('div');
  armorSection.className = 'armor-section';

  const armorLab = document.createElement('div');
  armorLab.className = 'row-label';
  armorLab.textContent = 'Armor';
  armorSection.appendChild(armorLab);

  const armorSlots = document.createElement('div');
  armorSlots.className = 'armor-slots';

  const defenseReadout = document.createElement('div');
  defenseReadout.className = 'defense-readout';
  defenseReadout.id = 'defense-readout';

  const ARMOR_SLOT_KEYS = ['head', 'body', 'legs'] as const;
  const ARMOR_SLOT_LABELS: Record<string, string> = { head: 'Head', body: 'Body', legs: 'Legs' };

  /** Refresh armor slots + defense readout. */
  const refreshArmor = () => {
    // Update armor slot buttons.
    for (const key of ARMOR_SLOT_KEYS) {
      const el2 = document.getElementById(`armor-slot-${key}`) as HTMLButtonElement | null;
      if (el2) renderSlot(el2, inv.armor[key]);
    }
    defenseReadout.textContent = `Defense: ${totalDefense(inv)}`;
  };

  for (const key of ARMOR_SLOT_KEYS) {
    const row2 = document.createElement('div');
    row2.className = 'armor-slot-row';
    const label2 = document.createElement('div');
    label2.className = 'armor-label';
    label2.textContent = ARMOR_SLOT_LABELS[key];
    row2.appendChild(label2);
    const btn = document.createElement('button');
    btn.className = 'inv-slot';
    btn.id = `armor-slot-${key}`;
    btn.title = ARMOR_SLOT_LABELS[key] + ' armor slot';
    btn.addEventListener('click', () => {
      if (src !== null) {
        // Equip: move selected pack/hotbar slot into this armor slot.
        const ok = equipArmor(inv, src);
        if (ok) {
          src = null;
          refresh();
          refreshArmor();
          onChange();
        } else {
          src = null;
          refresh();
        }
      } else {
        // Unequip: move armor slot back to pack.
        const ok = unequipArmor(inv, key);
        if (ok) {
          refreshArmor();
          refresh();
          onChange();
        }
      }
    });
    row2.appendChild(btn);
    armorSlots.appendChild(row2);
  }
  armorSection.appendChild(armorSlots);
  el.appendChild(armorSection);
  el.appendChild(defenseReadout);

  // --- Drop target -----------------------------------------------------
  // Works like the armor slots: with a slot picked up, clicking here discards
  // it. A full pack is otherwise a dead end — crafting has nowhere to put its
  // output, so the player can neither craft nor make room.
  const dropRow = document.createElement('div');
  dropRow.className = 'drop-row';

  const dropBtn = document.createElement('button');
  dropBtn.className = 'drop-btn';
  dropBtn.textContent = 'Drop';
  dropBtn.title = 'Pick up a slot, then click here to discard the stack. '
    + 'Right-click any slot to drop one (Shift for all).';
  dropBtn.addEventListener('click', () => {
    if (src === null) {
      announce('Pick up a slot first, then click Drop');
      return;
    }
    const dropped = dropSlot(inv, src, true);
    src = null;
    if (dropped !== null) {
      announce(`Dropped ${dropped.count}× ${itemDef(dropped.id).name}`);
      onChange();
    }
    refresh();
  });
  dropRow.appendChild(dropBtn);

  const dropMsg = document.createElement('span');
  dropMsg.className = 'drop-msg';
  dropRow.appendChild(dropMsg);
  el.appendChild(dropRow);

  /** Transient feedback line. Discarding is irreversible, so it must be
   *  visibly acknowledged rather than silently swallowing the items. */
  let msgTimer = 0;
  function announce(text: string): void {
    dropMsg.textContent = text;
    window.clearTimeout(msgTimer);
    msgTimer = window.setTimeout(() => { dropMsg.textContent = ''; }, 2200);
  }

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'Click to pick up, click again to place · '
    + 'right-click a slot to drop one (Shift = whole stack) · P drops held · Tab to close';
  el.appendChild(hint);

  refresh();
  refreshArmor();
  return el;
}
