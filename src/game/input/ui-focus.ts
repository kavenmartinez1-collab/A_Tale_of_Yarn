/**
 * ui-focus.ts — the controller's hands inside the DOM panels.
 *
 * WHY THIS EXISTS. gamepad.ts made the pad play the game by synthesising the
 * keyboard and mouse events the game already listens for. That works because
 * gameplay input HAS a keyboard equivalent to synthesise into. The panels do
 * not: inventory, crafting, the save rail, the chart and the chat box are
 * mouse-only DOM with no `tabindex`, no `:focus` styling and no key handling
 * of any kind (the map's arrow-key pan is the single exception). There was
 * nothing to synthesise into, which is exactly why a pad player could open
 * every panel in the game and then touch none of it.
 *
 * So this layer supplies the missing half — a focus cursor — and then goes
 * straight back to the same rule: it activates a control by dispatching a real
 * `click` on the real element, so every panel's existing handler runs
 * unchanged and not one of them had to learn what a gamepad is. The map pane
 * is driven the same way, by synthesising the Arrow/Home/+/− keys map-panel.ts
 * already claims in the capture phase.
 *
 * WHAT IT IS NOT. It is not a keyboard-navigation feature. It arms only when a
 * pad is connected (`tick(padPresent)`), so a mouse player never sees a focus
 * ring and nothing steals their focus. Keyboard and mouse behaviour is
 * untouched; this is purely additive.
 *
 * SPATIAL, NOT SCRIPTED. Every panel has a different shape — the save rail is
 * a column, the inventory is a 7-wide grid, crafting is a list with a tab bar,
 * the arrest panel is three stacked buttons. Rather than hand-author a focus
 * graph per panel (four graphs to keep in sync with four layouts, and a fifth
 * the day someone adds a panel), navigation is geometric: `pickInDirection`
 * scores candidates by how far they lie in the pressed direction against how
 * far they stray off-axis. A new panel gets navigation for free, and the grid
 * moves in straight lines because off-axis drift is penalised 3:1.
 *
 * DETERMINISM: no `Math.random`, no `Date.now`, no `performance.now`. The
 * repeat timing lives in gamepad.ts on the caller-supplied frame delta; this
 * module is a pure function of the DOM plus the actions it is handed.
 *
 * RELEASE SAFE: nothing here reads `__gameDebug`. It publishes a snapshot for
 * the harness to read, and works identically when that hook is absent.
 */

// ─── Geometry ────────────────────────────────────────────────────────────────

/** A candidate's box in viewport pixels. Kept plain so the picker is testable. */
export interface NavRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Off-axis penalty. A control 10 px further away in the pressed direction but
 * 200 px off to the side is the wrong answer; 3:1 is what makes a 7-wide grid
 * step along its row instead of cutting diagonally to a nearer neighbour.
 */
const CROSS_PENALTY = 3;

/**
 * Slack in pixels before a candidate counts as "actually in that direction".
 * Slightly negative so controls laid flush against each other (gap 0) still
 * count as neighbours.
 */
const ALONG_EPS = -1;

/**
 * Nearest candidate in a cardinal direction, or a wrap-around when there is
 * none.
 *
 * `dx`/`dy` are −1, 0 or 1 and exactly one is non-zero. Returns an index into
 * `rects`, or `from` when nothing else can be reached (a single-control panel).
 *
 * Wrapping is deliberate. On a controller the alternative to wrapping at the
 * end of a row is a dead press, and a dead press reads as a broken menu. It
 * fires only when the direction is genuinely empty, so it can never pre-empt a
 * real neighbour.
 */
export function pickInDirection(
  rects: readonly NavRect[],
  from: number,
  dx: number,
  dy: number,
): number {
  if (rects.length === 0) return -1;
  const cur = rects[from];
  if (cur === undefined) return 0;

  let best = -1;
  let bestScore = Infinity;
  let wrap = -1;
  let wrapScore = -Infinity;

  for (let i = 0; i < rects.length; i++) {
    if (i === from) continue;
    const r = rects[i];
    // BOTH distances are edge-to-edge, and the "along" one being edge-to-edge
    // rather than centre-to-centre is the fix for a real bug: in the save
    // rail every button shares a left edge but they are different widths, so
    // centre-to-centre made the narrow "Delete" two rows down look like a
    // left-hand neighbour of "Overwrite". Pressing left jumped a row.
    const along = dx < 0 ? cur.x - (r.x + r.w)
      : dx > 0 ? r.x - (cur.x + cur.w)
        : dy < 0 ? cur.y - (r.y + r.h)
          : r.y - (cur.y + cur.h);
    // Overlapping boxes score 0, so a wide button beside a narrow one is not
    // punished for a misalignment the player cannot see.
    const cross = dx !== 0
      ? Math.max(0, r.y - (cur.y + cur.h), cur.y - (r.y + r.h))
      : Math.max(0, r.x - (cur.x + cur.w), cur.x - (r.x + r.w));

    // A control that extends past this one on BOTH sides of the cross axis is
    // a PANE you are standing inside, not a neighbour in your row. The pause
    // screen is what taught this: the full-height chart canvas overlaps every
    // button in the rail, so it won every horizontal wrap — pressing right at
    // the end of the save row jumped to the map instead of back to Overwrite,
    // and a walk of the rail bounced between Resume and the chart forever. It
    // is still a perfectly good LEFT neighbour, which is why this excludes it
    // from wrapping only and not from ordinary movement.
    const engulfs = dx !== 0
      ? (r.y < cur.y - 1 && r.y + r.h > cur.y + cur.h + 1)
      : (r.x < cur.x - 1 && r.x + r.w > cur.x + cur.w + 1);

    if (along > ALONG_EPS) {
      const score = along + cross * CROSS_PENALTY;
      if (score < bestScore) { bestScore = score; best = i; }
    } else if (cross === 0 && !engulfs) {
      // Wrap candidate: the far end of THIS row or column, and only this one.
      // Restricting the wrap to controls that actually line up is what stops
      // "left" in a single-column rail from teleporting to another row —
      // pressing left in a column should do nothing, and nothing is what a
      // player reads as "this column has no left".
      if (-along > wrapScore) { wrapScore = -along; wrap = i; }
    }
  }

  if (best >= 0) return best;
  return wrap >= 0 ? wrap : from;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

/** One thing the pad asked the UI to do. Produced by gamepad.ts. */
export type UiAction =
  | { kind: 'nav'; dx: number; dy: number }
  | { kind: 'activate' }
  | { kind: 'back' }
  | { kind: 'tab'; dir: number }
  | { kind: 'secondary' }
  | { kind: 'pan'; dx: number; dy: number }
  | { kind: 'zoom'; dir: number };

/** The panel (or overlay) that currently owns the pad. */
export interface UiFocusContext {
  /** `PanelManager.openId`, or a synthetic id for a non-panel overlay. */
  id: string;
  root: HTMLElement;
}

export interface UiFocusOptions {
  /** What owns the pad right now, or null for gameplay. */
  context: () => UiFocusContext | null;
  /** Close the open panel. Returns false when the context refuses to close. */
  close: () => boolean;
}

// ─── The focus ring ──────────────────────────────────────────────────────────

/**
 * Running stitch in thread cream, the same #f0e6c8 the reticle and the chart
 * are drawn in — a dashed outline is literally a row of stitches, so the idiom
 * costs nothing and needs no extra element.
 *
 * `outline`, not a `::after` box: outlines do not affect layout, do not need
 * `position: relative` on controls that may not want it, and — the deciding
 * reason — pseudo-elements are never generated for replaced elements, so an
 * `::after` ring would have been invisible on the map's `<canvas>`.
 *
 * 3 px at 3 px offset with a dark backing halo. Deck Verified asks for legible
 * text and controls at 1280×800 on a handheld; a 1 px hairline is what that
 * criterion exists to catch, so the ring is deliberately heavier than a
 * desktop focus ring and it breathes so the eye finds it on a busy chart.
 *
 * THE FOCUSED CONTROL ALSO LIGHTS UP, the way `:hover` does in these panels,
 * and that is not decoration. The pause rail already draws every one of its
 * own buttons with a 1 px dashed cream border (map-panel.ts's `.stitch-btn`),
 * so at 1280×800 a dashed ring on its own read as "one more button" rather
 * than "the one you are on". The fill says live; the ring says which.
 *
 * The fill is an INSET `box-shadow`, not a background, and the reason is worth
 * recording. `background-color` was tried first and did nothing whatsoever:
 * `#pause-screen .stitch-btn` carries an id in its selector and outranks any
 * plain class. The obvious escalation to `!important` would then have beaten
 * the INLINE backgrounds that carry the character panel's colour swatches and
 * the pack's item icons, turning every focused swatch cream. An inset shadow
 * paints above the background and below the content, wins no specificity
 * fight because it needs none, and nothing else in the game puts a box-shadow
 * on a control.
 *
 * NOTE FOR EDITORS: this is a template literal. A backtick in a comment INSIDE
 * it ends the string, and the build fails with a syntax error pointing at CSS.
 * Prose about the CSS belongs here, above it.
 */
const FOCUS_CSS = `
.pad-focus,
.pad-focus:focus,
.pad-focus:focus-visible {
  outline: 3px dashed #f0e6c8;
  outline-offset: 3px;
  animation: pad-focus-ebb 1.5s ease-in-out infinite;
}
@keyframes pad-focus-ebb {
  0%, 100% { outline-color: #f0e6c8; }
  50%      { outline-color: rgba(240, 230, 200, 0.52); }
}
/* A dark seam plus a warm halo, so the ring survives both the linen chart and
   a snow-lit scene behind a translucent panel. box-shadow composites; a filter
   would create a stacking context on every focused control. */
/* A dark seam, a warm halo, and a lit fill. See the note above FOCUS_CSS. */
.pad-focus {
  box-shadow:
    inset 0 0 0 100px rgba(240, 230, 200, 0.17),
    0 0 0 1px rgba(8, 10, 14, 0.9),
    0 0 14px rgba(240, 230, 200, 0.32);
}
/* The chart cloth clips its canvas (overflow: hidden), so this one ring is
   stitched on the inside or it would not be drawn at all. */
#pause-screen canvas.pad-focus { outline-offset: -5px; }
/* The chat input already has a border; the ring sits clear of it. */
#npc-chat-input.pad-focus { outline-offset: 2px; }
`;

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.id = 'pad-focus-css';
  style.textContent = FOCUS_CSS;
  document.head.appendChild(style);
}

// ─── Candidate discovery ─────────────────────────────────────────────────────

/**
 * Everything a pad may land on. Native `<button>` covers all four panels plus
 * both overlays; `.pad-focusable` is the opt-in for the things that are not
 * buttons (currently the map canvas, tagged in map-panel.ts).
 */
const FOCUSABLE_SEL = 'button, input[type="text"], .pad-focusable';

/**
 * Where the ring should start when a panel opens, per context id.
 *
 * DOM order is the wrong default for exactly one panel and it is the most
 * important one: the chart canvas precedes the rail, so an unhinted pause
 * screen would open with the map focused and Resume three presses away.
 */
const INITIAL_SEL: Record<string, string> = {
  pause: '.stitch-btn.primary',
  'npc-chat': '#npc-chat-input',
  inventory: '.inv-grid .inv-slot',
  crafting: '.craft-tab.active',
  arrest: '#arrest-pay',
  death: '#respawn-btn',
};

export class UiFocus {
  /** Candidates in DOM order, refreshed whenever the panel's DOM changes. */
  private items: HTMLElement[] = [];
  private index = -1;
  private ctxId: string | null = null;
  private ctxRoot: HTMLElement | null = null;
  private dirty = true;
  private observer: MutationObserver | null = null;
  private ringed: HTMLElement | null = null;
  /** Count of on-screen-keyboard attempts, for the harness. */
  private osk = 0;

  constructor(private readonly opts: UiFocusOptions) {
    injectCss();
  }

  /** True while a panel or overlay owns the pad. */
  get active(): boolean {
    return this.ctxRoot !== null;
  }

  /**
   * True when the focused control wants the left stick as an analog axis
   * rather than as a focus cursor — the map pane, and nothing else.
   */
  get wantsAnalog(): boolean {
    return this.focused() instanceof HTMLCanvasElement;
  }

  /**
   * Snapshot for the harness. Nothing in this module reads it, and it is never
   * required for navigation — a release build with no `__gameDebug` behaves
   * identically.
   *
   * `label` is here because `id` and `className` do not identify a control in
   * this codebase: every save-rail button is `class="choice"` with no id, so a
   * harness asserting "the ring is on Delete" has nothing else to go on.
   */
  snapshot(): {
    context: string | null; index: number; id: string;
    label: string; count: number; osk: number;
  } {
    const el = this.focused();
    return {
      context: this.ctxId,
      index: this.index,
      id: el === null ? '' : (el.id || el.className || el.tagName.toLowerCase()),
      // Long enough to hold the armed-delete label in full ("Delete <date> ·
      // <playtime> played? Click again"), which is the one label a harness
      // needs to read the END of.
      label: el === null ? '' : (el.textContent ?? '').trim().slice(0, 72),
      count: this.items.length,
      osk: this.osk,
    };
  }

  /**
   * One frame. Cheap: a context compare and, only when the DOM actually
   * changed, a re-scan.
   *
   * `padPresent` is the arming switch. With no pad connected this layer is
   * completely inert — no ring, no `focus()` calls, nothing a mouse player can
   * see. That is what keeps "keyboard/mouse untouched" true rather than
   * merely intended.
   */
  tick(padPresent: boolean): void {
    const ctx = padPresent ? this.opts.context() : null;
    const id = ctx === null ? null : ctx.id;
    const root = ctx === null ? null : ctx.root;
    if (root !== this.ctxRoot || id !== this.ctxId) {
      this.detach();
      this.ctxId = id;
      this.ctxRoot = root;
      if (root !== null) this.attach(root);
    }
    if (this.ctxRoot !== null && this.dirty) this.rescan();
  }

  /**
   * Apply one pad action.
   *
   * Returns whether the panel CONSUMED it. Only `secondary` (X) can decline,
   * and it does so everywhere except an inventory slot — which is what lets X
   * keep its gameplay meaning of "open the bench" while a panel is up, so the
   * button that opened crafting is also the button that closes it.
   */
  handle(a: UiAction): boolean {
    if (this.ctxRoot === null) return false;
    if (this.dirty) this.rescan();
    switch (a.kind) {
      case 'nav': this.move(a.dx, a.dy); return true;
      case 'activate': this.activate(); return true;
      case 'back': return this.opts.close();
      case 'tab': return this.cycleTab(a.dir);
      case 'secondary': return this.secondary();
      case 'pan': this.pan(a.dx, a.dy); return true;
      case 'zoom': this.zoom(a.dir); return true;
      default: return false;
    }
  }

  // ── context lifecycle ──────────────────────────────────────────────────────

  private attach(root: HTMLElement): void {
    this.dirty = true;
    // Panels rebuild their own DOM with no event to hook: arming a Delete
    // wipes and re-renders every save button (menu-panel.ts), switching a
    // crafting tab calls replaceChildren on the whole recipe list. An observer
    // is the only way to notice from outside without editing four panels.
    this.observer = new MutationObserver((records) => {
      for (const r of records) {
        // Text-node churn is not a layout change. The chart header rewrites
        // its "where am I" line on every dirty frame; treating that as a
        // rebuild would re-scan the DOM at the map's redraw rate.
        if (hasElement(r.addedNodes) || hasElement(r.removedNodes)) {
          this.dirty = true;
          return;
        }
        if (r.type === 'attributes') { this.dirty = true; return; }
      }
    });
    this.observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'hidden', 'style', 'class'],
    });
    // The mouse and the ring must agree, or a click lands somewhere the player
    // is not looking. Hover moves the ring only — it deliberately does not
    // take DOM focus, so hovering past the chat box cannot swallow a keystroke.
    root.addEventListener('pointerover', this.onPointerOver, true);
  }

  private detach(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.ctxRoot?.removeEventListener('pointerover', this.onPointerOver, true);
    this.clearRing();
    this.items = [];
    this.index = -1;
    this.ctxId = null;
    this.ctxRoot = null;
    this.dirty = true;
  }

  private readonly onPointerOver = (e: Event): void => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (this.dirty) this.rescan();
    const el = t.closest(FOCUSABLE_SEL);
    if (!(el instanceof HTMLElement)) return;
    const i = this.items.indexOf(el);
    if (i >= 0 && i !== this.index) {
      this.index = i;
      this.paint(false);
    }
  };

  // ── scanning ───────────────────────────────────────────────────────────────

  private rescan(): void {
    this.dirty = false;
    const root = this.ctxRoot;
    if (root === null) { this.items = []; this.index = -1; return; }

    const was = this.focused();
    const wasIndex = this.index;
    const next: HTMLElement[] = [];
    for (const el of root.querySelectorAll<HTMLElement>(FOCUSABLE_SEL)) {
      // Disabled controls are SKIPPED, not focused-and-inert. The save rail's
      // Delete on the slot you are playing is the case that decided it: it is
      // permanently disabled, so a ring parked on it is a dead end the player
      // has to press out of. Skipping is the "do not trap" answer, and the row
      // still reads as disabled because its Save and Load remain reachable.
      if (el.hasAttribute('disabled')) continue;
      if ((el as HTMLButtonElement).disabled === true) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      next.push(el);
    }
    this.items = next;

    if (next.length === 0) { this.index = -1; this.clearRing(); return; }

    // Restore, in order of how much the player would notice losing it:
    // the same element, then whatever already had DOM focus (the chat panel
    // focuses its own input on open), then the panel's preferred landing spot,
    // then the same slot in a rebuilt list, then the first control.
    let i = was === null ? -1 : next.indexOf(was);
    if (i < 0) {
      const act = document.activeElement;
      if (act instanceof HTMLElement) i = next.indexOf(act);
    }
    if (i < 0 && wasIndex < 0) {
      const sel = this.ctxId === null ? undefined : INITIAL_SEL[this.ctxId];
      if (sel !== undefined) {
        const pref = root.querySelector<HTMLElement>(sel);
        if (pref !== null) i = next.indexOf(pref);
      }
    }
    if (i < 0 && wasIndex >= 0) i = Math.min(wasIndex, next.length - 1);
    this.index = i < 0 ? 0 : i;
    this.paint(false);
  }

  private focused(): HTMLElement | null {
    return this.index >= 0 && this.index < this.items.length ? this.items[this.index] : null;
  }

  // ── actions ────────────────────────────────────────────────────────────────

  private move(dx: number, dy: number): void {
    if (this.items.length === 0) return;
    if (this.index < 0) { this.index = 0; this.paint(true); return; }
    const rects: NavRect[] = this.items.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    const next = pickInDirection(rects, this.index, dx, dy);
    if (next < 0 || next === this.index) return;
    this.index = next;
    this.paint(true);
  }

  private activate(): void {
    const el = this.focused();
    if (el === null) return;
    if (el instanceof HTMLInputElement) { this.openKeyboard(el); return; }
    if (el instanceof HTMLCanvasElement) {
      // The chart has no "control" to press. A on it means the one thing a
      // player pressing A on a map ever wants: find me. Home is the key
      // map-panel.ts already claims for that, so this stays a synthesis.
      key('Home');
      return;
    }
    el.click();
  }

  /**
   * X — the secondary verb. Inventory only, where it is Drop.
   *
   * The panel's existing right-click handler already drops one from a slot
   * (Shift for the stack), so X synthesises `contextmenu` rather than
   * reaching into the inventory model: same code path as the mouse, same
   * announce line, nothing new to keep in sync.
   */
  private secondary(): boolean {
    const el = this.focused();
    if (el === null) return false;
    if (!el.classList.contains('inv-slot')) return false;
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    return true;
  }

  /** RB — next page. Only crafting has tabs; everywhere else this is inert. */
  private cycleTab(dir: number): boolean {
    const root = this.ctxRoot;
    if (root === null) return false;
    const tabs = [...root.querySelectorAll<HTMLElement>('.craft-tab')];
    if (tabs.length === 0) return false;
    const at = tabs.findIndex((t) => t.classList.contains('active'));
    const n = tabs.length;
    const next = ((at < 0 ? 0 : at) + (dir >= 0 ? 1 : n - 1)) % n;
    tabs[next].click();
    // replaceChildren has just destroyed every recipe row. Land the ring on
    // the tab itself so the player can see which page they are on; the rescan
    // the observer schedules will keep it there.
    this.dirty = true;
    this.rescan();
    const i = this.items.indexOf(tabs[next]);
    if (i >= 0) { this.index = i; this.paint(true); }
    return true;
  }

  /** Left stick over the chart. Synthesises the arrows map-panel.ts claims. */
  private pan(dx: number, dy: number): void {
    if (!(this.focused() instanceof HTMLCanvasElement)) return;
    // One key press per poll per axis. map-panel.ts's step is already scaled
    // by zoom (0.22 of the viewport in metres), so a per-frame press gives a
    // smooth scroll that stays sensible at every zoom level, and a light push
    // moves nothing because the dead-zone already zeroed it.
    if (dx < 0) key('ArrowLeft');
    else if (dx > 0) key('ArrowRight');
    if (dy < 0) key('ArrowUp');
    else if (dy > 0) key('ArrowDown');
  }

  /** Triggers over the chart. `dir` < 0 zooms in. */
  private zoom(dir: number): void {
    if (!(this.focused() instanceof HTMLCanvasElement)) {
      // Off the chart the triggers still zoom, because a player who has just
      // pressed Resume-adjacent buttons should not have to hunt back to the
      // canvas to change scale. The panel's own +/− keys do the work.
      if (this.ctxId !== 'pause') return;
    }
    key(dir < 0 ? 'Equal' : 'Minus');
  }

  /**
   * A on a text field — hand it to Steam's on-screen keyboard.
   *
   * `ShowFloatingGamepadTextInput` types straight into the focused DOM input
   * (PORTING §3.3), so there is nothing to plumb back: focus the field, ask
   * Steam for the keyboard, done. Outside the Steam wrapper `steamBridge` is
   * absent, and the failure must be LOUD rather than silent — a keyboard that
   * quietly does not appear is indistinguishable from a dead button.
   *
   * Voice is the other half of this and the better half: LB is already push-
   * to-talk into this same field.
   */
  private openKeyboard(el: HTMLInputElement): void {
    this.osk++;
    el.focus();
    const bridge = (window as unknown as { steamBridge?: SteamBridgeLike }).steamBridge;
    const r = el.getBoundingClientRect();
    const rect = {
      x: Math.round(r.left), y: Math.round(r.top),
      width: Math.round(r.width), height: Math.round(r.height),
    };
    if (bridge === undefined || typeof bridge.showFloatingKeyboard !== 'function') {
      // eslint-disable-next-line no-console
      console.info('[pad] on-screen keyboard unavailable outside the Steam '
        + 'wrapper — hold LB to speak, or type. rect=', rect);
      return;
    }
    try {
      const p = bridge.showFloatingKeyboard(rect) as unknown;
      if (p instanceof Promise) {
        p.then((shown) => {
          if (shown !== true) {
            // eslint-disable-next-line no-console
            console.info('[pad] Steam declined the on-screen keyboard '
              + '(Steam not running, or not in Big Picture/Deck).');
          }
        }).catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.info(`[pad] on-screen keyboard failed: ${String(err)}`);
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.info(`[pad] on-screen keyboard threw: ${String(err)}`);
    }
  }

  // ── ring ───────────────────────────────────────────────────────────────────

  private paint(takeFocus: boolean): void {
    const el = this.focused();
    if (this.ringed !== null && this.ringed !== el) {
      this.ringed.classList.remove('pad-focus');
    }
    this.ringed = el;
    if (el === null) return;
    el.classList.add('pad-focus');
    if (takeFocus) {
      // Real DOM focus as well as the ring: it is what makes A-on-the-chat-box
      // put the caret where the on-screen keyboard and the voice transcript
      // both expect it, and it keeps Enter/Space working for anyone who has a
      // keyboard next to the pad.
      try { el.focus({ preventScroll: true }); } catch { /* not focusable */ }
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  private clearRing(): void {
    this.ringed?.classList.remove('pad-focus');
    this.ringed = null;
  }
}

interface SteamBridgeLike {
  showFloatingKeyboard?: (rect: { x: number; y: number; width: number; height: number })
  => Promise<boolean>;
}

/** True when the list holds at least one Element (vs. only text nodes). */
function hasElement(list: NodeList): boolean {
  for (let i = 0; i < list.length; i++) {
    if (list[i].nodeType === 1) return true;
  }
  return false;
}

/**
 * One synthetic key press on `window`, matching what gamepad.ts dispatches.
 * `cancelable` so a capture-phase handler that claims it (map-panel.ts calls
 * `preventDefault`) is telling the truth rather than talking to a no-op.
 */
function key(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
}
