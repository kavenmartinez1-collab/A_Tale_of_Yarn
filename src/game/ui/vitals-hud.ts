/**
 * Vitals HUD — top-left overlay showing HP hearts, thirst bar, temperature
 * gauge, and a stamina bar (visible only while draining/recovering).
 *
 * Injected CSS matches the repo's UI style: system-ui font, rgba dark panels.
 * Updated at ~10 Hz from main.ts — caller calls vitalsHud.update(vitals).
 */

import type { Vitals } from '../vitals';
import { MAX_HP, MAX_THIRST, MAX_STAMINA, TEMP_MIN, TEMP_MAX, TEMP_DAMAGE_THRESHOLD } from '../vitals';

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const HUD_CSS = `
#vitals-hud {
  position: fixed;
  top: 10px;
  left: 10px;
  z-index: 14;
  user-select: none;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font: 600 12px system-ui, sans-serif;
}

/* Hearts row */
#vitals-hud .hearts {
  display: flex;
  gap: 2px;
  align-items: center;
}
#vitals-hud .heart {
  width: 14px;
  height: 14px;
  position: relative;
  display: inline-block;
}
#vitals-hud .heart svg {
  width: 14px;
  height: 14px;
  display: block;
}

/* Thirst bar */
#vitals-hud .thirst-wrap {
  display: flex;
  align-items: center;
  gap: 5px;
}
#vitals-hud .thirst-label {
  color: rgba(160, 200, 240, 0.85);
  font-size: 10px;
  min-width: 14px;
}
#vitals-hud .bar-track {
  width: 90px;
  height: 6px;
  background: rgba(10, 14, 20, 0.70);
  border-radius: 3px;
  border: 1px solid rgba(205, 214, 228, 0.18);
  overflow: hidden;
}
#vitals-hud .bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.12s linear;
}
#vitals-hud .bar-fill.thirst { background: #4a9fd4; }
#vitals-hud .bar-fill.stamina { background: #4ad48a; }

/* Temperature gauge */
#vitals-hud .temp-wrap {
  display: flex;
  align-items: center;
  gap: 5px;
}
#vitals-hud .temp-label {
  font-size: 10px;
  min-width: 14px;
}
#vitals-hud .temp-track {
  position: relative;
  width: 90px;
  height: 8px;
  border-radius: 4px;
  border: 1px solid rgba(205, 214, 228, 0.18);
  overflow: visible;
}
#vitals-hud .temp-gradient {
  position: absolute;
  inset: 0;
  border-radius: 4px;
  background: linear-gradient(to right,
    #4a88d4 0%,
    #9ab8e0 35%,
    #f0f0f0 50%,
    #e8b060 65%,
    #d46030 100%
  );
}
#vitals-hud .temp-needle {
  position: absolute;
  top: -2px;
  width: 3px;
  height: 12px;
  background: #ffffff;
  border-radius: 2px;
  border: 1px solid rgba(0,0,0,0.5);
  transform: translateX(-50%);
  transition: left 0.15s linear;
}
#vitals-hud .temp-center {
  position: absolute;
  top: -1px;
  left: 50%;
  transform: translateX(-50%);
  width: 1px;
  height: 10px;
  background: rgba(255,255,255,0.35);
}

/* Stamina bar — only shown when not full */
#vitals-hud .stamina-wrap {
  display: flex;
  align-items: center;
  gap: 5px;
  transition: opacity 0.4s ease;
}
#vitals-hud .stamina-wrap.hidden-bar {
  opacity: 0;
  pointer-events: none;
}
#vitals-hud .stamina-label {
  color: rgba(74, 212, 138, 0.85);
  font-size: 10px;
  min-width: 14px;
}

@keyframes temp-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
#vitals-hud .temp-wrap.pulsing .temp-track {
  animation: temp-pulse 0.9s ease-in-out infinite;
}
`;

// ---------------------------------------------------------------------------
// Heart SVG helper (full, half, empty)
// ---------------------------------------------------------------------------

function heartSvg(fill: 'full' | 'half' | 'empty'): string {
  // Simple heart path, scaled 0-14.
  const path =
    'M7 12.5 C7 12.5 1.5 8.5 1.5 5 C1.5 3.07 3.07 1.5 5 1.5 C6.04 1.5 6.97 1.97 7 2 C7.03 1.97 7.96 1.5 9 1.5 C10.93 1.5 12.5 3.07 12.5 5 C12.5 8.5 7 12.5 7 12.5Z';

  if (fill === 'empty') {
    return `<svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg">
      <path d="${path}" fill="rgba(60,20,20,0.5)" stroke="rgba(200,80,80,0.4)" stroke-width="0.8"/>
    </svg>`;
  }
  if (fill === 'full') {
    return `<svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg">
      <path d="${path}" fill="#e04040" stroke="rgba(0,0,0,0.3)" stroke-width="0.5"/>
    </svg>`;
  }
  // Half: clip the right side.
  return `<svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <clipPath id="hh"><rect x="0" y="0" width="7" height="14"/></clipPath>
    </defs>
    <path d="${path}" fill="rgba(60,20,20,0.5)" stroke="rgba(200,80,80,0.4)" stroke-width="0.8"/>
    <path d="${path}" fill="#e04040" stroke="rgba(0,0,0,0.3)" stroke-width="0.5" clip-path="url(#hh)"/>
  </svg>`;
}

// ---------------------------------------------------------------------------
// VitalsHud class
// ---------------------------------------------------------------------------

export class VitalsHud {
  private readonly el: HTMLDivElement;
  private readonly heartEls: HTMLSpanElement[] = [];
  private readonly thirstFill: HTMLDivElement;
  private readonly tempNeedle: HTMLDivElement;
  private readonly tempWrap: HTMLDivElement;
  private readonly staminaFill: HTMLDivElement;
  private readonly staminaWrap: HTMLDivElement;

  constructor() {
    injectCss();

    const el = document.createElement('div');
    el.id = 'vitals-hud';

    // --- Hearts row (10 hearts = 20 hp) ------------------------------------
    const heartsRow = document.createElement('div');
    heartsRow.className = 'hearts';
    for (let i = 0; i < 10; i++) {
      const span = document.createElement('span');
      span.className = 'heart';
      span.innerHTML = heartSvg('full');
      heartsRow.appendChild(span);
      this.heartEls.push(span);
    }
    el.appendChild(heartsRow);

    // --- Thirst bar --------------------------------------------------------
    const thirstWrap = document.createElement('div');
    thirstWrap.className = 'thirst-wrap';
    const thirstLabel = document.createElement('span');
    thirstLabel.className = 'thirst-label';
    thirstLabel.textContent = '\u{1F4A7}'; // droplet (fallback: text)
    thirstLabel.style.fontSize = '11px';
    thirstWrap.appendChild(thirstLabel);
    const thirstTrack = document.createElement('div');
    thirstTrack.className = 'bar-track';
    const thirstFill = document.createElement('div');
    thirstFill.className = 'bar-fill thirst';
    thirstFill.style.width = '100%';
    thirstTrack.appendChild(thirstFill);
    thirstWrap.appendChild(thirstTrack);
    el.appendChild(thirstWrap);
    this.thirstFill = thirstFill;

    // --- Temperature gauge -------------------------------------------------
    const tempWrap = document.createElement('div');
    tempWrap.className = 'temp-wrap';
    const tempLabel = document.createElement('span');
    tempLabel.className = 'temp-label';
    tempLabel.textContent = '\u2603'; // snowman icon as cold indicator
    tempLabel.style.fontSize = '11px';
    tempWrap.appendChild(tempLabel);
    const tempTrack = document.createElement('div');
    tempTrack.className = 'temp-track';
    const tempGrad = document.createElement('div');
    tempGrad.className = 'temp-gradient';
    tempTrack.appendChild(tempGrad);
    const tempCenter = document.createElement('div');
    tempCenter.className = 'temp-center';
    tempTrack.appendChild(tempCenter);
    const tempNeedle = document.createElement('div');
    tempNeedle.className = 'temp-needle';
    tempTrack.appendChild(tempNeedle);
    tempWrap.appendChild(tempTrack);
    el.appendChild(tempWrap);
    this.tempNeedle = tempNeedle;
    this.tempWrap = tempWrap;

    // --- Stamina bar (hidden when full) ------------------------------------
    const staminaWrap = document.createElement('div');
    staminaWrap.className = 'stamina-wrap hidden-bar';
    const staminaLabel = document.createElement('span');
    staminaLabel.className = 'stamina-label';
    staminaLabel.textContent = '\u26A1'; // lightning bolt
    staminaLabel.style.fontSize = '11px';
    staminaWrap.appendChild(staminaLabel);
    const staminaTrack = document.createElement('div');
    staminaTrack.className = 'bar-track';
    const staminaFill = document.createElement('div');
    staminaFill.className = 'bar-fill stamina';
    staminaFill.style.width = '100%';
    staminaTrack.appendChild(staminaFill);
    staminaWrap.appendChild(staminaTrack);
    el.appendChild(staminaWrap);
    this.staminaFill = staminaFill;
    this.staminaWrap = staminaWrap;

    document.body.appendChild(el);
    this.el = el;
  }

  /** Update the HUD from the current vitals snapshot. Call at ~10 Hz. */
  update(v: Vitals): void {
    // HP hearts: 10 hearts, each heart = 2 hp, half-heart granularity.
    const hp = Math.max(0, Math.min(MAX_HP, v.hp));
    for (let i = 0; i < 10; i++) {
      const heartHp = hp - i * 2;
      let fill: 'full' | 'half' | 'empty';
      if (heartHp >= 2) fill = 'full';
      else if (heartHp >= 1) fill = 'half';
      else fill = 'empty';
      this.heartEls[i].innerHTML = heartSvg(fill);
    }

    // Thirst bar.
    const thirstPct = Math.max(0, Math.min(100, v.thirst)) / MAX_THIRST * 100;
    this.thirstFill.style.width = `${thirstPct.toFixed(1)}%`;

    // Temperature needle: map [TEMP_MIN, TEMP_MAX] → [0%, 100%] on track.
    const tempRange = TEMP_MAX - TEMP_MIN; // 6
    const tempPct = (v.temperature - TEMP_MIN) / tempRange * 100;
    this.tempNeedle.style.left = `${Math.max(0, Math.min(100, tempPct)).toFixed(1)}%`;
    // Pulse when in the damage band (|temp| >= 2.5).
    const extremeTemp = Math.abs(v.temperature) >= TEMP_DAMAGE_THRESHOLD;
    this.tempWrap.classList.toggle('pulsing', extremeTemp);

    // Stamina bar: hide at full, show while draining/recovering.
    const staminaPct = Math.max(0, Math.min(MAX_STAMINA, v.stamina)) / MAX_STAMINA * 100;
    this.staminaFill.style.width = `${staminaPct.toFixed(1)}%`;
    const staminaFull = v.stamina >= MAX_STAMINA - 0.5;
    this.staminaWrap.classList.toggle('hidden-bar', staminaFull);
  }

  /** Show or hide the entire HUD (e.g. while dead). */
  setVisible(visible: boolean): void {
    this.el.style.display = visible ? 'flex' : 'none';
  }
}

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = HUD_CSS;
  document.head.appendChild(style);
}
