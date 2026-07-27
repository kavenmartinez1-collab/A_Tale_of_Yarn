/**
 * controls-panel.ts — the binding table, in one place.
 *
 * ## Why this file exists
 *
 * The list of what every key and button does was written INLINE inside
 * `main.ts`'s KeyH handler, which made it the one part of the game with no
 * home: nothing imported it, nothing could re-use it, and the pause screen —
 * the place a player actually goes looking for controls — could not show it at
 * all. Worse, a table nobody can import is a table nobody re-reads, and it had
 * drifted: push-to-talk (`V`), the hotbar digits and every map key were missing
 * from it entirely (see "verified against" below).
 *
 * So the table lives here and is exported three ways:
 *
 *   `buildControlsContent()` — the bare table, no frame. Both hosts use this.
 *   `buildControlsPanel()`   — the free-standing panel, for main.ts's KeyH.
 *   (the pause sheet)        — map-panel.ts wraps the content in the chart.
 *
 * ONE source of truth. Change a binding, change it here, and both screens say
 * the same thing.
 *
 * ## Verified against the handlers, 2026-07
 *
 * Every row below was checked against the code that runs, not against the old
 * panel text. What the old panel had WRONG:
 *
 *   - `V` (push-to-talk) was absent from the keyboard list. It was listed for
 *     the pad ("LB — hold to speak") and nowhere else, so a keyboard player had
 *     no way to discover that speaking to villagers aloud existed at all.
 *     (`voice/voice-input.ts:231`)
 *   - The hotbar digits `1`-`5` were absent. (`main.ts:7500`)
 *   - Every map key was absent — Arrows, Home, `+`/`−` — even though the
 *     panel's own Esc row points at the chart. (`map/map-panel.ts:451-458`)
 *   - "Space / Q — Ascend / descend while flying" is incomplete: descend is
 *     also `Ctrl` and `C`. (`main.ts:4918-4921`)
 *   - "D-pad ←→" implied a live d-pad; up and down do nothing in gameplay,
 *     they only move the highlight in a menu. (`gamepad.ts:312`)
 *   - `X` (swap arrows) only fires with a bow equipped. (`main.ts:7405`)
 *   - `G` (mount bite) only exists on breath species — it is dead on a horse.
 *     (`main.ts:5440`)
 *
 * Bindings the old panel had RIGHT and are repeated here unchanged: lock-on is
 * `Z` and middle-click and LT; target cycling is Tab / Shift+Tab and a
 * right-stick flick; sprint is Shift and L3. There is no block, parry, dodge or
 * roll binding anywhere in the game, so none is listed.
 *
 * DETERMINISM: pure DOM construction, no clocks, no randomness.
 * RELEASE SAFE: reads no `__gameDebug`.
 */

const CREAM = '#f0e6c8';

/** `[key, what it does]`. */
type Binding = [string, string];

/**
 * Keyboard and mouse.
 *
 * Ordered by how soon a player needs it — moving, looking, hitting things —
 * rather than alphabetically or by key code.
 */
const KEYBOARD: Binding[] = [
  ['W A S D', 'Move'],
  ['Shift', 'Sprint'],
  ['Space', 'Jump — or paddle, while you are swimming'],
  ['Mouse', 'Look around'],
  ['Wheel', 'Pull the camera in and out'],
  ['Left-click', 'Gather, use, swing. With a bow: hold to draw, let go to loose'],
  ['Z  ·  Middle-click', 'Lock on to what you are facing. Again to let go'],
  ['Tab', 'While locked on: the next one along (Shift+Tab for the last)'],
  ['E', 'Interact — talk, enter, mount, loot, drink, eat, sleep'],
  ['V', 'Hold to speak aloud to a villager. Let go, then Enter to send it'],
  ['1 – 5', 'Choose what is in your hand. A torch burns while it is chosen'],
  ['X', 'With a bow: swap flint arrows for Tintreach'],
  ['P', 'Drop what you are holding (Shift for the whole stack)'],
  ['Right-click', 'Tell your animal to stay, or to follow'],
  // One row, because they are one idea — what the animal under you does — and
  // because listing them apart implies G works on a horse. It does not.
  ['F  ·  G', "Your mount's breath (or a stomp)  ·  its bite, on dragons and wyverns"],
  ['Space  ·  Q', 'Rise and fall while flying (Ctrl and C also take you down)'],
  ['Tab  ·  I', 'Your pack'],
  ['B', 'Crafting'],
  ['C', 'How you look'],
  ['M', 'Mute the sound'],
  ['H', 'This screen'],
  ['Esc', 'Pause — the chart, saving, and settings'],
];

/** Mounted play has one rule people get wrong; it earns a line of its own. */
const MOUNTED_NOTE = 'On a mount, left-click is still YOUR weapon or bow. '
  + 'F and G are the animal’s.';

/** The pause screen's own keys, which no help panel has ever listed. */
const CHART: Binding[] = [
  ['Drag  ·  Arrows', 'Move around the chart'],
  ['Wheel  ·  +  −', 'Zoom in and out'],
  ['Home', 'Find yourself again'],
];

/**
 * Controller.
 *
 * The pad can open this screen (Back) and can reach it from the pause rail, so
 * this is the only place a pad player can discover the two bindings they would
 * otherwise never guess: Y for the pack and X for the bench.
 */
const PAD: Binding[] = [
  ['Left stick', 'Move  ·  in a menu: move the highlight  ·  on the chart: pan'],
  ['Right stick', 'Look around'],
  ['Right stick flick', 'While locked on: the next one along'],
  ['A', 'Interact / talk  ·  in a menu: press the highlighted control'],
  ['B', 'Jump  ·  in a menu: back out'],
  ['X', 'Crafting  ·  in your pack: drop one from the highlighted slot'],
  ['Y', 'Your pack'],
  ['LB', 'Hold to speak aloud to a villager'],
  ['RB', 'Next page, in crafting'],
  ['LT', 'Lock on, and again to let go  ·  on the pause screen: zoom out'],
  ['RT', 'Attack — hold to draw a bow  ·  on the pause screen: zoom in'],
  ['L3', 'Sprint'],
  ['R3', 'How you look'],
  ['D-pad ← →', 'Change what is in your hand  ·  in a menu the whole d-pad moves the highlight'],
  ['Start', 'Pause — the chart, saving, and settings'],
  ['Back', 'This screen'],
];

/**
 * Still bound in a shipped build, still developer tools — so they are recorded,
 * but as one quiet line rather than a section with a heading of its own. A
 * player scanning for "how do I sprint" should not have to read past F9.
 */
const DEBUG_NOTE = 'Developer tools, still live in this build: '
  + 'R free-fly camera · F8 saves a debug snapshot · F9 saves one every 2 s.';

// ---------------------------------------------------------------------------
// Rendering. Inline styles, the house idiom for panel internals (menu-panel.ts,
// and the KeyH panel this replaces). The key chip is a running stitch — dashed,
// never solid — so the table is in the same hand as the chart it sits on.
// ---------------------------------------------------------------------------

function heading(text: string, first = false): HTMLElement {
  const h = document.createElement('div');
  h.style.cssText = [
    'font:600 11px system-ui,sans-serif',
    'letter-spacing:0.10em',
    'text-transform:uppercase',
    'opacity:0.62',
    `margin:${first ? 0 : 14}px 0 6px`,
    'padding-bottom:5px',
    'border-bottom:1px dashed rgba(240,230,200,0.34)',
  ].join(';');
  h.textContent = text;
  return h;
}

function bindingRow([key, desc]: Binding): HTMLElement {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex; gap:9px; align-items:baseline; margin:1px 0;';

  const chip = document.createElement('span');
  chip.style.cssText = [
    'font:600 10px system-ui,sans-serif',
    `color:${CREAM}`,
    'background:rgba(240,230,200,0.07)',
    'border:1px dashed rgba(240,230,200,0.42)',
    'border-radius:3px',
    'padding:1px 6px',
    'flex:0 0 104px',
    'text-align:center',
    'letter-spacing:0.02em',
  ].join(';');
  chip.textContent = key;

  const d = document.createElement('span');
  d.style.cssText = 'font:500 11px system-ui,sans-serif; line-height:1.38; opacity:0.82;';
  d.textContent = desc;

  row.append(chip, d);
  return row;
}

function note(text: string): HTMLElement {
  const n = document.createElement('div');
  n.style.cssText = 'font:500 10px system-ui,sans-serif; opacity:0.5; '
    + 'line-height:1.5; margin:8px 0 0; padding-left:2px;';
  n.textContent = text;
  return n;
}

function column(): HTMLElement {
  const c = document.createElement('div');
  c.style.cssText = 'flex:1 1 320px; min-width:0;';
  return c;
}

/**
 * The binding table with no frame around it.
 *
 * Two columns that fall back to one when the host is narrow, so the same
 * element reads correctly inside the 1180 px chart AND inside the free-standing
 * panel main.ts puts up on KeyH.
 */
export function buildControlsContent(): HTMLElement {
  const root = document.createElement('div');
  root.id = 'controls-content';

  const cols = document.createElement('div');
  cols.style.cssText = `display:flex; flex-wrap:wrap; gap:14px 34px; color:${CREAM};`;

  const left = column();
  left.appendChild(heading('Keyboard and mouse', true));
  for (const b of KEYBOARD) left.appendChild(bindingRow(b));
  left.appendChild(note(MOUNTED_NOTE));

  const right = column();
  right.appendChild(heading('Controller', true));
  for (const b of PAD) right.appendChild(bindingRow(b));
  right.appendChild(note('A pad plays the whole game, menus included — '
    + 'you never need to reach for the keyboard.'));
  right.appendChild(heading('On the chart'));
  for (const b of CHART) right.appendChild(bindingRow(b));

  cols.append(left, right);
  root.append(cols, note(DEBUG_NOTE));
  return root;
}

/**
 * The free-standing panel — what `main.ts`'s KeyH should show.
 *
 * `PanelManager` adds `.game-panel`, whose dark blue-grey belongs to the old
 * UI; the inline styles here re-dye it as cloth so the controls screen matches
 * the chart it also appears inside. It also caps its height and scrolls, which
 * the inline version never did — the table is longer than an 800 px window and
 * the last rows simply ran off the bottom of the screen.
 */
export function buildControlsPanel(): HTMLElement {
  const el = document.createElement('div');
  // `help-panel`, NOT `controls-panel`, and deliberately so. This is a drop-in
  // for the block main.ts builds inline on KeyH, and
  // `scripts/controller-ui-check.mjs` asserts on that id twice (it presses Back
  // and looks for `#help-panel`, then presses Back again and requires it gone).
  // Keeping the id means main.ts can swap `panels.toggle('help',
  // buildControlsPanel)` straight in with no harness change at all. The panel
  // id PanelManager uses is likewise still 'help'.
  el.id = 'help-panel';
  el.style.cssText = [
    'background:#3b3122',
    'border:1px dashed rgba(240,230,200,0.42)',
    'border-radius:4px',
    `color:${CREAM}`,
    'width:min(760px, 92vw)',
    'max-height:86vh',
    'overflow-y:auto',
    'padding:14px 18px',
    'right:50%',
    'transform:translate(50%, -50%)',
  ].join(';');

  const h = document.createElement('h2');
  h.style.cssText = 'font:600 14px system-ui,sans-serif; letter-spacing:0.10em; '
    + `text-transform:uppercase; color:${CREAM}; margin:0 0 12px;`;
  h.textContent = 'Controls';
  el.appendChild(h);

  el.appendChild(buildControlsContent());

  const hint = document.createElement('div');
  hint.style.cssText = 'margin-top:14px; padding-top:10px; '
    + 'border-top:1px dashed rgba(240,230,200,0.34); '
    + 'font:500 10px system-ui,sans-serif; opacity:0.5;';
  hint.textContent = 'H, Back or Esc to close';
  el.appendChild(hint);

  return el;
}
