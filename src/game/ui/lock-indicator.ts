/**
 * lock-indicator.ts — the running-stitch ring that marks a Z-target.
 *
 * Built in the same idiom as `reticle.ts`, and deliberately so: one injected
 * `<style>`, one `id`'d div holding inline SVG, and an `update` that only
 * touches the DOM when something actually changed. The HUD is DOM everywhere
 * in this game except the map chart; a WebGPU quad here would have been a
 * second rendering path to keep in sync with the first for no visible gain.
 *
 * ## THE CRAFT
 *
 * A lock-on marker in most games is a hard bracket or a glowing diamond, and
 * either would look like it had been pasted in from a different game. This one
 * is a ring of running stitch — the same `stroke-dasharray` signature as the
 * reticle's arms, the torch bar and the recording indicator — with a single
 * chevron tacked above it like a stitched arrowhead. It turns slowly, which is
 * what stops a dashed circle from reading as a loading spinner: a spinner
 * whips, embroidery does not.
 *
 * Colour is the reticle's own `#e8c35a` warm gold, which already means "over a
 * living target" in this HUD, on the `#f0e6c8` thread-cream family.
 *
 * ## WHY IT FADES
 *
 * A lock breaks at 30 m. A marker that is fully solid at 29.9 m and gone at
 * 30.1 m reads as a bug; the fade over the last third of the range is the only
 * warning the player gets that they are about to lose the target, and it costs
 * one opacity write.
 */

const CSS = `
#lock-ring {
  position: fixed;
  left: 0; top: 0;
  width: 64px; height: 64px;
  margin-left: -32px; margin-top: -32px;
  pointer-events: none;
  z-index: 46;
  display: none;
  filter: drop-shadow(0 1px 1.5px rgba(8,10,14,0.85));
  transition: opacity 0.14s linear;
}
#lock-ring.on { display: block; }
#lock-ring circle, #lock-ring path {
  fill: none;
  stroke: #e8c35a;
  stroke-width: 2;
  stroke-linecap: round;
}
/* The running stitch: the same signature as the reticle's arms. */
#lock-ring circle {
  stroke-dasharray: 4.2 3.4;
  transform-origin: 32px 32px;
  animation: lock-stitch 9s linear infinite;
}
/* Slow. A dashed ring that spins fast is a loading spinner. */
@keyframes lock-stitch {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
/* The chevron sits above the ring, pointing down at what is marked. */
#lock-ring path { stroke-width: 2.4; }
@media (prefers-reduced-motion: reduce) {
  #lock-ring circle { animation: none; }
}
`;

export class LockIndicator {
  private readonly root: HTMLDivElement;
  private shown = false;
  private lastX = -1;
  private lastY = -1;
  private lastFade = -1;

  constructor() {
    const style = document.createElement('style');
    style.id = 'lock-ring-css';
    style.textContent = CSS;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.id = 'lock-ring';
    this.root.innerHTML = `<svg width="64" height="64" viewBox="0 0 64 64">
      <circle cx="32" cy="32" r="19" />
      <path d="M26 9 L32 15 L38 9" />
    </svg>`;
    document.body.appendChild(this.root);
  }

  /**
   * Place the ring at a screen position. `fade` is 0..1; 0 hides it.
   *
   * Positions are written with `transform` rather than `left`/`top` so the
   * browser can keep this on the compositor — this moves every frame a target
   * moves, which is most of them.
   */
  update(screenX: number, screenY: number, fade: number): void {
    if (fade <= 0) { this.hide(); return; }
    if (!this.shown) { this.shown = true; this.root.classList.add('on'); }
    const x = Math.round(screenX);
    const y = Math.round(screenY);
    if (x !== this.lastX || y !== this.lastY) {
      this.lastX = x; this.lastY = y;
      this.root.style.transform = `translate(${x}px, ${y}px)`;
    }
    // Quantised, so a target drifting slowly does not rewrite the style every
    // single frame for a change nobody can see.
    const q = Math.round(fade * 20) / 20;
    if (q !== this.lastFade) {
      this.lastFade = q;
      this.root.style.opacity = String(q);
    }
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.root.classList.remove('on');
  }
}
