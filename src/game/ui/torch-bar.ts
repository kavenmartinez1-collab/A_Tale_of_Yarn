/**
 * torch-bar.ts — how much is left of the torch in your hand.
 *
 * Sits at the bottom of the screen, directly above the hotbar, because that is
 * where the torch itself is and because the vitals HUD in the opposite corner
 * is about the BODY — hearts, thirst, warmth. This is about a consumable, and
 * putting it up there would have implied it was a fifth vital.
 *
 * ## Look
 *
 * A run of stitches being consumed, not a rectangle draining. Same idiom as
 * the bow reticle (ui/reticle.ts): thread cream `#f0e6c8`, `stroke-dasharray:
 * 2.6 2.2`, round caps, a soft dark drop shadow so it reads against snow and
 * against a night sky. The unburnt length is a faint ghost of the same
 * stitch, so the bar looks like thread that has been unpicked rather than a
 * gauge that has emptied. Under a fifth it warms to ember and the whole thing
 * breathes — the one moment it is allowed to ask for attention.
 *
 * The count on the right is torches REMAINING IN THE STACK INCLUDING THIS ONE,
 * so `3` means "this one and two more"; when it reads 1 the next burnout is
 * the last of the light.
 */

const CSS = `
#torch-bar {
  position: fixed;
  left: 50%;
  bottom: 70px;
  transform: translateX(-50%);
  z-index: 15;
  pointer-events: none;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 7px;
  opacity: 0;
  transition: opacity 0.18s ease-out;
}
#torch-bar.on { opacity: 0.92; }
#torch-bar svg {
  display: block;
  overflow: visible;
  filter: drop-shadow(0 1px 1.5px rgba(8,10,14,0.85));
}
#torch-bar line {
  stroke-dasharray: 2.6 2.2;
  stroke-linecap: round;
  stroke-width: 2.6;
  fill: none;
}
/* The unburnt run: the same stitch, barely there. */
#torch-bar .ghost { stroke: rgba(240, 230, 200, 0.20); }
#torch-bar .lit    { stroke: #f0e6c8; }
#torch-bar.low .lit { stroke: #e8934a; animation: torch-ebb 1.15s ease-in-out infinite; }
@keyframes torch-ebb {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.55; }
}
#torch-bar .count {
  font: 600 11px system-ui, sans-serif;
  color: #f0e6c8;
  letter-spacing: 0.3px;
  text-shadow: 0 1px 2px rgba(8,10,14,0.9);
  min-width: 16px;
}
#torch-bar.low .count { color: #e8934a; }
`;

/** Stitch run length in px. Matches the hotbar's 5x44 + 4x6 = 244 loosely. */
const RUN = 150;
/** Fraction below which the bar warms and breathes. */
const LOW_FRAC = 0.2;

export class TorchBar {
  private readonly root: HTMLDivElement;
  private readonly lit: SVGLineElement;
  private readonly countEl: HTMLSpanElement;
  /** Last applied state — the hot path only touches the DOM on a change. */
  private shown = false;
  private low = false;
  private litPx = -1;
  private countText = '';

  constructor() {
    const style = document.createElement('style');
    style.id = 'torch-bar-css';
    style.textContent = CSS;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.id = 'torch-bar';
    this.root.innerHTML = `<svg width="${RUN + 4}" height="8" viewBox="0 0 ${RUN + 4} 8">
      <line class="ghost" x1="2" y1="4" x2="${RUN + 2}" y2="4" />
      <line class="lit"   x1="2" y1="4" x2="${RUN + 2}" y2="4" />
    </svg><span class="count"></span>`;
    document.body.appendChild(this.root);
    this.lit = this.root.querySelector('.lit') as SVGLineElement;
    this.countEl = this.root.querySelector('.count') as HTMLSpanElement;
  }

  /**
   * `frac` is fuel remaining 0..1 in the torch currently lit; `count` is how
   * many torches are left in the stack including that one. Pass `null` to hide
   * — not holding a torch, dead, panel open.
   */
  update(frac: number | null, count: number): void {
    if (frac === null) {
      if (this.shown) {
        this.shown = false;
        this.root.className = '';
      }
      return;
    }
    const f = Math.max(0, Math.min(1, frac));
    const low = f <= LOW_FRAC;
    if (!this.shown || low !== this.low) {
      this.shown = true;
      this.low = low;
      this.root.className = low ? 'on low' : 'on';
    }
    // Quantised to the pixel: at 180 s over 150 px the raw value changes every
    // frame and every change is a layout the browser did not need to do.
    const px = Math.round(2 + RUN * f);
    if (px !== this.litPx) {
      this.litPx = px;
      this.lit.setAttribute('x2', String(px));
      // A zero-length stitch still paints a round cap, which reads as a full
      // stitch left when there is none.
      this.lit.style.visibility = px <= 2 ? 'hidden' : '';
    }
    const text = `x${count}`;
    if (text !== this.countText) {
      this.countText = text;
      this.countEl.textContent = text;
    }
  }

  hide(): void {
    this.update(null, 0);
  }
}
