/**
 * Character customization panel content — swatch rows for skin/shirt/pants/
 * hair colors and hair-style choice buttons. Pure DOM builder; PanelManager
 * handles open/close and pointer-lock, main.ts wires persistence via `set`.
 */

import type { CharacterCustomization, Color3 } from '../character/character-mesh';
import {
  SKIN_TONES, SHIRT_COLORS, PANTS_COLORS, HAIR_COLORS, HAIR_STYLE_NAMES,
} from '../character/customization';

function cssColor(c: Color3): string {
  const to255 = (v: number) => Math.round(v * 255);
  return `rgb(${to255(c[0])}, ${to255(c[1])}, ${to255(c[2])})`;
}

function sameColor(a: Color3, b: Color3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

type ColorField = 'skinTone' | 'shirtColor' | 'pantsColor' | 'hairColor';

function swatchRow(
  label: string, dataRow: string, palette: Color3[], field: ColorField,
  get: () => CharacterCustomization,
  set: (c: CharacterCustomization) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'panel-row';
  const lab = document.createElement('div');
  lab.className = 'row-label';
  lab.textContent = label;
  row.appendChild(lab);
  const swatches = document.createElement('div');
  swatches.className = 'swatches';
  swatches.dataset.row = dataRow;
  const buttons: HTMLButtonElement[] = [];
  const refresh = () => {
    const cur = get()[field];
    buttons.forEach((b, i) =>
      b.classList.toggle('sel', sameColor(palette[i], cur)));
  };
  for (const color of palette) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = cssColor(color);
    b.addEventListener('click', () => {
      set({ ...get(), [field]: color });
      refresh();
    });
    swatches.appendChild(b);
    buttons.push(b);
  }
  refresh();
  row.appendChild(swatches);
  return row;
}

function styleRow(
  get: () => CharacterCustomization,
  set: (c: CharacterCustomization) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'panel-row';
  const lab = document.createElement('div');
  lab.className = 'row-label';
  lab.textContent = 'Hair style';
  row.appendChild(lab);
  const wrap = document.createElement('div');
  wrap.className = 'swatches';
  wrap.dataset.row = 'hairStyle';
  const buttons: HTMLButtonElement[] = [];
  const refresh = () => {
    const cur = get().hairStyle;
    buttons.forEach((b, i) => b.classList.toggle('sel', i === cur));
  };
  HAIR_STYLE_NAMES.forEach((name, i) => {
    const b = document.createElement('button');
    b.className = 'choice';
    b.textContent = name;
    b.addEventListener('click', () => {
      set({ ...get(), hairStyle: i });
      refresh();
    });
    wrap.appendChild(b);
    buttons.push(b);
  });
  refresh();
  row.appendChild(wrap);
  return row;
}

function bodyRow(
  get: () => CharacterCustomization,
  set: (c: CharacterCustomization) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'panel-row';
  const lab = document.createElement('div');
  lab.className = 'row-label';
  lab.textContent = 'Body';
  row.appendChild(lab);
  const wrap = document.createElement('div');
  wrap.className = 'swatches';
  wrap.dataset.row = 'body';
  const options: Array<'male' | 'female'> = ['male', 'female'];
  const buttons: HTMLButtonElement[] = [];
  const refresh = () => {
    const cur = get().body ?? 'male';
    buttons.forEach((b, i) => b.classList.toggle('sel', options[i] === cur));
  };
  for (const opt of options) {
    const b = document.createElement('button');
    b.className = 'choice';
    b.id = `body-choice-${opt}`;
    b.textContent = opt.charAt(0).toUpperCase() + opt.slice(1);
    b.addEventListener('click', () => {
      set({ ...get(), body: opt });
      refresh();
    });
    wrap.appendChild(b);
    buttons.push(b);
  }
  refresh();
  row.appendChild(wrap);
  return row;
}

/** Build the panel element (PanelManager adds the .game-panel class). */
export function buildCharacterPanel(
  get: () => CharacterCustomization,
  set: (c: CharacterCustomization) => void,
): HTMLElement {
  const el = document.createElement('div');
  el.id = 'character-panel';
  const h = document.createElement('h2');
  h.textContent = 'Character';
  el.appendChild(h);
  el.appendChild(bodyRow(get, set));
  el.appendChild(swatchRow('Skin', 'skin', SKIN_TONES, 'skinTone', get, set));
  el.appendChild(swatchRow('Shirt', 'shirt', SHIRT_COLORS, 'shirtColor', get, set));
  el.appendChild(swatchRow('Pants', 'pants', PANTS_COLORS, 'pantsColor', get, set));
  el.appendChild(swatchRow('Hair', 'hair', HAIR_COLORS, 'hairColor', get, set));
  el.appendChild(styleRow(get, set));
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'C to close';
  el.appendChild(hint);
  return el;
}
