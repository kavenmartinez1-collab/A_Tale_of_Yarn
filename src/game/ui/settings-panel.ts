/**
 * settings-panel.ts — the Settings sheet reached from the pause rail.
 *
 * ## What this is
 *
 * The player-facing face of `ui/game-settings.ts`. Every control here reads
 * `settings.get()` and writes `settings.set()`, and nothing here ever calls
 * `saveSettings` directly: `set()` persists AND fans out to the live listeners
 * in one step, which is what makes "the slider applies immediately" and "the
 * slider is still there after a reload" the same code path rather than two that
 * can drift apart.
 *
 * ## Why every control is a `<button>`
 *
 * `input/ui-focus.ts` — the layer that lets a controller touch the DOM — finds
 * its candidates with exactly one selector:
 *
 *     'button, input[type="text"], .pad-focusable'
 *
 * An `<input type=range>` matches none of that, so a slider would be a control
 * a pad player can see and never reach. Volumes are therefore `−` / value / `+`
 * steppers and switches are a single button that shows its own state. That is
 * not a compromise: on a pad a stepper is *better* than a slider (discrete,
 * repeatable, no analog hunting), the play harness can click one, and it needs
 * no key handling of its own.
 *
 * End-stop buttons are deliberately NOT disabled at the limits. `ui-focus`
 * SKIPS disabled controls, so a `−` that disables itself at 0 % would yank the
 * focus ring onto some other row the moment the player bottomed out a volume.
 * They stay enabled and clamp instead.
 *
 * ## Why there is no `settings.subscribe` here
 *
 * The panel is the only thing that writes settings while it is open, so after
 * each write it just refreshes its own labels. A subscription would need an
 * unsubscribe, and this sheet lives INSIDE `#pause-screen` — `PanelManager`
 * fires `panel-close` on the panel root, not on descendants, so a sheet has no
 * teardown event of its own to unbind on. No subscription, nothing to leak.
 *
 * Refreshing rewrites text and inline colours only; it never touches the DOM
 * structure. The focus ring therefore never jumps while you hold `+`.
 *
 * DETERMINISM: no `Math.random`, no `Date.now`, no `performance.now`.
 * RELEASE SAFE: reads no `__gameDebug`.
 */

import { settings } from './game-settings';

/** Thread cream, gold and the danger red — the chart's dye lot (map-palette). */
const CREAM = '#f0e6c8';
const GOLD = '#e8c35a';
const DANGER = '#e06c5a';
const DIM = 'rgba(240, 230, 200, 0.55)';
const STITCH = 'rgba(240, 230, 200, 0.42)';

/** Width of the control column, so every stepper lines up down the sheet. */
const CTL_W = 136;

/** Kill float drift: 0.6 + 0.05 must be 0.65, not 0.65000000000000002. */
const round2 = (v: number): number => Math.round(v * 100) / 100;

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const times = (v: number): string => `${(Math.round(v * 10) / 10).toFixed(1)}×`;

/** Every label that shows a live value registers one of these. */
type Refresh = () => void;

// ---------------------------------------------------------------------------
// Sheet furniture. Inline styles, matching the house style of menu-panel.ts and
// the help panel in main.ts — the wool-craft LOOK comes from map-panel.ts's
// `.stitch-btn` and the tokens above, not from a second stylesheet.
// ---------------------------------------------------------------------------

function heading(text: string, first = false): HTMLElement {
  const h = document.createElement('div');
  h.style.cssText = [
    'font:600 11px system-ui,sans-serif',
    'letter-spacing:0.10em',
    'text-transform:uppercase',
    'opacity:0.62',
    `margin:${first ? 0 : 20}px 0 4px`,
    'padding-bottom:6px',
    'border-bottom:1px dashed rgba(240,230,200,0.34)',
  ].join(';');
  h.textContent = text;
  return h;
}

/** One of the two columns the sheet splits into on a wide chart. */
function column(): HTMLElement {
  const c = document.createElement('div');
  c.style.cssText = 'flex:1 1 400px; min-width:0;';
  return c;
}

/**
 * One row: name (and an optional line of plain-English explanation) on the
 * left, its control group right-aligned in a fixed column. Returns the control
 * cell for the caller to fill.
 */
function row(parent: HTMLElement, label: string, note?: string): HTMLElement {
  const r = document.createElement('div');
  r.style.cssText = 'display:flex; align-items:center; gap:14px; margin:10px 0;';

  const left = document.createElement('div');
  left.style.cssText = 'flex:1; min-width:0;';
  const l = document.createElement('div');
  l.style.cssText = `font:600 12px system-ui,sans-serif; letter-spacing:0.03em; color:${CREAM};`;
  l.textContent = label;
  left.appendChild(l);
  if (note !== undefined) {
    const n = document.createElement('div');
    n.style.cssText = 'font:500 10px system-ui,sans-serif; opacity:0.5; line-height:1.45; margin-top:3px;';
    n.textContent = note;
    left.appendChild(n);
  }
  r.appendChild(left);

  const ctl = document.createElement('div');
  ctl.style.cssText = `flex:0 0 ${CTL_W}px; display:flex; gap:6px; align-items:center;`;
  r.appendChild(ctl);

  parent.appendChild(r);
  return ctl;
}

/**
 * `−` value `+`. `read`/`write` are the whole binding to the store, so a
 * stepper never holds a copy of the value it is editing.
 */
function stepper(
  ctl: HTMLElement,
  read: () => number,
  write: (v: number) => void,
  fmt: (v: number) => string,
  step: number,
  lo: number,
  hi: number,
  refresh: Refresh[],
): void {
  const nudge = (dir: number): void => {
    write(Math.min(hi, Math.max(lo, round2(read() + dir * step))));
    for (const f of refresh) f();
  };
  const btn = (glyph: string, dir: number, title: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = 'stitch-btn';
    b.textContent = glyph;
    b.title = title;
    b.style.cssText = 'text-align:center; padding:5px 0; flex:0 0 36px;';
    b.addEventListener('click', () => nudge(dir));
    return b;
  };
  const val = document.createElement('div');
  val.style.cssText = `flex:1; text-align:center; font:600 12px system-ui,sans-serif; color:${GOLD};`;
  refresh.push(() => { val.textContent = fmt(read()); });
  ctl.append(btn('−', -1, 'Less'), val, btn('+', +1, 'More'));
}

/** A switch: one button that says what it currently is. */
function toggle(
  ctl: HTMLElement,
  read: () => boolean,
  write: (v: boolean) => void,
  refresh: Refresh[],
  labels: [on: string, off: string] = ['On', 'Off'],
): void {
  const b = document.createElement('button');
  b.className = 'stitch-btn';
  b.style.cssText = 'text-align:center; padding:5px 0; flex:1;';
  b.addEventListener('click', () => {
    write(!read());
    for (const f of refresh) f();
  });
  refresh.push(() => {
    const on = read();
    b.textContent = on ? labels[0] : labels[1];
    b.style.color = on ? GOLD : DIM;
    b.style.borderColor = on ? GOLD : STITCH;
  });
  ctl.appendChild(b);
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

/**
 * Build the Settings content.
 *
 * Returns a bare block; the host supplies the frame. On the pause screen that
 * is `map-panel.ts`'s `openSheet`, which adds the Back button and re-titles the
 * chart.
 *
 * TWO COLUMNS, collapsing to one when the host is narrow. A single 640 px
 * column was the first cut and it was wrong twice over: it left two thirds of
 * an 1180 px chart empty, and it ran 130 px past the bottom of the body at
 * 1280x800 — so "Restore defaults" was below the fold on the exact resolution
 * Deck Verified is judged at.
 */
export function buildSettingsContent(): HTMLElement {
  const root = document.createElement('div');
  root.id = 'settings-sheet';
  root.style.cssText = `max-width:1000px; color:${CREAM};`;

  const cols = document.createElement('div');
  cols.style.cssText = 'display:flex; flex-wrap:wrap; gap:4px 44px;';
  const colA = column();
  const colB = column();
  cols.append(colA, colB);
  root.appendChild(cols);

  const refresh: Refresh[] = [];
  const s = () => settings.get();

  // --- Sound --------------------------------------------------------------
  colA.appendChild(heading('Sound', true));
  stepper(row(colA, 'Master volume'),
    () => s().volMaster, (v) => settings.set({ volMaster: v }), pct, 0.05, 0, 1, refresh);
  // The music bus is named and mixed before anything routes into it. Listed
  // without apology: a level the player sets now is the level music arrives at.
  stepper(row(colA, 'Music'),
    () => s().volMusic, (v) => settings.set({ volMusic: v }), pct, 0.05, 0, 1, refresh);
  stepper(row(colA, 'Sound effects'),
    () => s().volSfx, (v) => settings.set({ volSfx: v }), pct, 0.05, 0, 1, refresh);
  stepper(row(colA, 'Villager voices'),
    () => s().volVoice, (v) => settings.set({ volVoice: v }), pct, 0.05, 0, 1, refresh);
  toggle(row(colA, 'Speak dialogue aloud',
    'Villagers read their lines out loud. Their words are always written down too.'),
  () => s().voiceEnabled, (v) => settings.set({ voiceEnabled: v }), refresh);

  // --- Controls -----------------------------------------------------------
  colB.appendChild(heading('Controls', true));
  stepper(row(colB, 'Mouse sensitivity'),
    () => s().mouseSensitivity, (v) => settings.set({ mouseSensitivity: v }),
    times, 0.1, 0.2, 3, refresh);
  // The warning is not padding. This is the one control in the game that can
  // take away the hands holding it: a pad player who switches it off cannot
  // switch it back on, because the switch stops reading the pad. Rather than
  // hide it or guard it with a confirm nobody reads, it says so on the row.
  toggle(row(colB, 'Controller',
    'Off ignores a connected controller completely — you would need a mouse '
    + 'or a keyboard to turn it back on.'),
  () => s().gamepadEnabled, (v) => settings.set({ gamepadEnabled: v }), refresh);

  // --- Graphics -----------------------------------------------------------
  colB.appendChild(heading('Graphics'));
  stepper(row(colB, 'Render scale',
    'Draws the world smaller and stretches it to fit the window. '
    + 'Lower is softer to look at and much kinder to a tired graphics card.'),
  () => s().renderScale, (v) => settings.set({ renderScale: v }), pct, 0.05, 0.5, 1, refresh);

  // --- Performance --------------------------------------------------------
  colB.appendChild(heading('Performance'));
  // `?director=off` becoming a real switch. Named for the player, not for the
  // code: nobody outside this repo knows what a "director" flag is, but
  // everybody understands "written as you play" versus "written already".
  toggle(row(colB, 'AI Director',
    'On, the game writes its own dungeons and villager replies as you play. '
    + 'Off, it uses ones written in advance — the same game, a lot less work '
    + 'for your graphics card.'),
  () => !s().directorOff, (v) => settings.set({ directorOff: !v }), refresh);

  // --- Restore defaults ---------------------------------------------------
  const foot = document.createElement('div');
  foot.style.cssText = 'margin-top:20px; padding-top:14px; '
    + 'border-top:1px dashed rgba(240,230,200,0.34);';
  const reset = document.createElement('button');
  reset.className = 'stitch-btn';
  reset.textContent = 'Restore defaults';
  // Full width, like the Back bars, and for the same navigation reason: the
  // row controls are right-aligned in a column, so a compact button down here
  // shares nothing but its left edge with them. ui-focus.ts's 3:1 off-axis
  // penalty then scored the full-width Back BELOW it as the nearer neighbour
  // and pressing down walked straight past Restore. Page-level actions span
  // the sheet; row controls sit in their column. That rule is what keeps the
  // pad walking the page in the order a reader sees it.
  reset.style.display = 'block';
  reset.style.width = '100%';
  // Two-click confirm, the same guard menu-panel.ts puts on New Game and
  // Delete. Cheap to undo is not the same as impossible to do by accident, and
  // on a pad this button sits one press below the last thing you were changing.
  let armed = false;
  reset.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      reset.textContent = 'Put every setting back the way it came? Click again';
      reset.style.borderColor = DANGER;
      reset.style.color = DANGER;
      return;
    }
    armed = false;
    reset.textContent = 'Restore defaults';
    reset.style.borderColor = '';
    reset.style.color = '';
    settings.reset();
    for (const f of refresh) f();
  });
  foot.appendChild(reset);

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.style.cssText = 'margin-top:12px; font:500 10px system-ui,sans-serif; '
    + 'opacity:0.5; line-height:1.5;';
  hint.textContent = 'Changes apply straight away and are remembered between sessions. '
    + 'They belong to this machine, not to your save — loading an old game will not undo them.';
  foot.appendChild(hint);
  root.appendChild(foot);

  for (const f of refresh) f();
  return root;
}
