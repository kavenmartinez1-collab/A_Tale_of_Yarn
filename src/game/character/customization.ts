/**
 * Character customization — curated palettes + versioned localStorage
 * persistence. Pure data + storage; the panel UI lives in ui/character-panel.
 */

import {
  DEFAULT_CUSTOMIZATION, type CharacterCustomization, type Color3,
} from './character-mesh';

export type BodyShape = 'male' | 'female';

export const SKIN_TONES: Color3[] = [
  [0.98, 0.84, 0.70], [0.85, 0.65, 0.48], [0.72, 0.51, 0.35],
  [0.55, 0.38, 0.26], [0.38, 0.26, 0.18],
];
export const SHIRT_COLORS: Color3[] = [
  [0.30, 0.42, 0.58], [0.58, 0.20, 0.20], [0.24, 0.46, 0.26],
  [0.55, 0.45, 0.20], [0.40, 0.28, 0.50], [0.35, 0.35, 0.38],
];
export const PANTS_COLORS: Color3[] = [
  [0.35, 0.28, 0.22], [0.22, 0.26, 0.34], [0.30, 0.34, 0.30],
  [0.45, 0.38, 0.28], [0.20, 0.20, 0.22],
];
export const HAIR_COLORS: Color3[] = [
  [0.30, 0.20, 0.12], [0.10, 0.08, 0.07], [0.75, 0.60, 0.30],
  [0.55, 0.30, 0.15], [0.55, 0.55, 0.58],
];
export const HAIR_STYLE_NAMES = ['Bald', 'Crop', 'Long'];

const KEY = 'artifex-character:v1';

function asColor(v: unknown, fallback: Color3): Color3 {
  return Array.isArray(v) && v.length === 3 &&
    v.every((n) => typeof n === 'number' && n >= 0 && n <= 1)
    ? [v[0], v[1], v[2]]
    : fallback;
}

/** Load the saved customization, falling back per-field to the default. */
export function loadCustomization(): CharacterCustomization {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_CUSTOMIZATION };
    const p = JSON.parse(raw) as Record<string, unknown>;
    const d = DEFAULT_CUSTOMIZATION;
    return {
      skinTone: asColor(p.skinTone, d.skinTone),
      shirtColor: asColor(p.shirtColor, d.shirtColor),
      pantsColor: asColor(p.pantsColor, d.pantsColor),
      hairColor: asColor(p.hairColor, d.hairColor),
      hairStyle:
        typeof p.hairStyle === 'number' && p.hairStyle >= 0 && p.hairStyle < HAIR_STYLE_NAMES.length
          ? Math.floor(p.hairStyle)
          : d.hairStyle,
      body: (p.body === 'male' || p.body === 'female') ? p.body : (d.body ?? 'male'),
    };
  } catch {
    return { ...DEFAULT_CUSTOMIZATION };
  }
}

export function saveCustomization(c: CharacterCustomization): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    // Storage unavailable (private mode) — customization is session-only.
  }
}
