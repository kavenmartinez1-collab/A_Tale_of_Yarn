/**
 * reticle.ts — the aiming mark for the bow.
 *
 * The game had no crosshair of any kind, which is half of the "difficult to
 * know what I am aiming at" report; the other half was that there was nothing
 * truthful to point at, because the arrow did not go where the camera looked.
 * That is fixed in `aim.ts`, and this draws the answer.
 *
 * ## Why it is a fixed centred element and not a projected impact marker
 *
 * Because after `aimVelocity` the arrow's ARC passes through the point under
 * screen centre, so screen centre IS the impact point. Projecting a marched
 * trajectory to screen would draw the same pixel at the cost of a world-to-
 * screen transform and a ballistic march every frame, in a renderer already
 * spending 8.5-10.8 ms of a 16.7 ms budget. The only per-frame work here is a
 * class swap on two nodes, and the aim resolve behind it is throttled.
 *
 * A reticle that lies is worse than no reticle — it turns a controls problem
 * into a trust problem — so the two states that would lie are called out
 * instead of drawn as a normal aim: `out of range` (the ballistic solve found
 * no arc, the arrow will fall short) and `no arrow`.
 *
 * ## Look
 *
 * Four running stitches around a knot, in thread cream rather than HUD slate,
 * with a soft dark shadow so it reads against snow and sky alike. It closes in
 * and warms to gold over a living target, and splays open and dims when the
 * shot cannot reach. No brackets, no hit markers, no dynamic spread bloom —
 * this is a doll made of wool holding a bow.
 */

const CSS = `
#aim-reticle {
  position: fixed; left: 50%; top: 50%;
  width: 46px; height: 46px; margin: -23px 0 0 -23px;
  z-index: 16; pointer-events: none; user-select: none;
  opacity: 0; transition: opacity 0.14s ease-out;
}
#aim-reticle.on { opacity: 0.78; }
#aim-reticle.drawn { opacity: 1; }
#aim-reticle svg { display: block; overflow: visible;
  filter: drop-shadow(0 1px 1.5px rgba(8,10,14,0.85)); }
#aim-reticle line, #aim-reticle circle {
  stroke: #f0e6c8; fill: none;
  stroke-width: 1.6; stroke-linecap: round;
  transition: transform 0.12s ease-out, stroke 0.12s linear;
}
/* Each arm is a short run of stitches, not a solid tick. */
#aim-reticle line { stroke-dasharray: 2.6 2.2; }
#aim-reticle .knot { stroke-width: 1.3; }
/* Arms sit further out at rest, draw in over a target, splay when unreachable. */
#aim-reticle .arm { transform: scale(1); transform-origin: 23px 23px; }
#aim-reticle.target .arm { transform: scale(0.72); }
#aim-reticle.target line, #aim-reticle.target circle { stroke: #e8c35a; }
#aim-reticle.far .arm { transform: scale(1.34); }
#aim-reticle.far line, #aim-reticle.far circle { stroke: rgba(240,230,200,0.45); }

#aim-reticle-label {
  position: fixed; left: 50%; top: 50%;
  margin: 26px 0 0 0; transform: translateX(-50%);
  z-index: 16; pointer-events: none; user-select: none;
  font: 600 11px system-ui, sans-serif;
  color: #f0e6c8; letter-spacing: 0.3px; white-space: nowrap;
  text-shadow: 0 1px 2px rgba(8,10,14,0.9);
  opacity: 0; transition: opacity 0.14s ease-out;
}
#aim-reticle-label.on { opacity: 0.9; }
#aim-reticle-label .dist { opacity: 0.55; font-weight: 500; margin-left: 5px; }
#aim-reticle-label.far { color: rgba(240,230,200,0.6); }
`;

/** What the reticle is currently saying. */
export type ReticleMode = 'off' | 'aim' | 'target' | 'far' | 'empty';

export class Reticle {
  private readonly root: HTMLDivElement;
  private readonly label: HTMLDivElement;
  /** Last applied state, so the hot path only touches the DOM on a change. */
  private mode: ReticleMode = 'off';
  private drawn = false;
  private text = '';

  constructor() {
    const style = document.createElement('style');
    style.id = 'aim-reticle-css';
    style.textContent = CSS;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.id = 'aim-reticle';
    // Arms at N/E/S/W around a 46-box centred on (23, 23); the gap in the
    // middle is what makes it an aiming mark rather than a plus sign.
    this.root.innerHTML = `<svg width="46" height="46" viewBox="0 0 46 46">
      <g class="arm">
        <line x1="23" y1="6"  x2="23" y2="16" />
        <line x1="23" y1="30" x2="23" y2="40" />
        <line x1="6"  y1="23" x2="16" y2="23" />
        <line x1="30" y1="23" x2="40" y2="23" />
      </g>
      <circle class="knot" cx="23" cy="23" r="1.5" />
    </svg>`;
    document.body.appendChild(this.root);

    this.label = document.createElement('div');
    this.label.id = 'aim-reticle-label';
    document.body.appendChild(this.label);
  }

  /**
   * `name` labels what the ray is over; `dist` is metres to it. Both are
   * ignored unless the mode wants them.
   */
  update(mode: ReticleMode, drawn: boolean, name: string | null, dist: number): void {
    if (mode !== this.mode || drawn !== this.drawn) {
      this.mode = mode;
      this.drawn = drawn;
      this.root.className = mode === 'off' ? '' : `${drawn ? 'on drawn' : 'on'}`
        + (mode === 'target' ? ' target' : mode === 'far' ? ' far' : '');
    }
    const want = mode === 'off' ? ''
      : mode === 'empty' ? 'no arrows'
        : mode === 'far' ? `out of range<span class="dist">${dist.toFixed(0)} m</span>`
          : name !== null ? `${name}<span class="dist">${dist.toFixed(0)} m</span>`
            : '';
    if (want !== this.text) {
      this.text = want;
      this.label.innerHTML = want;
      this.label.className = want === '' ? ''
        : (mode === 'far' ? 'on far' : 'on');
    }
  }

  /** Hide everything — panel open, dead, pointer lock lost, bow put away. */
  hide(): void {
    this.update('off', false, null, 0);
  }
}
