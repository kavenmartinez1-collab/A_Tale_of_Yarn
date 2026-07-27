/** A pad-synthesised mouse button. Marked so main.ts's pointer-lock gate can
 * admit it: a pad player who never clicked the canvas holds no pointer lock,
 * and without the mark RT could not attack at all (found by the audio agent,
 * fixed here). `cancelable` for symmetry with the keyboard synthesis. */
function padMouse(type: 'mousedown' | 'mouseup'): MouseEvent {
  const ev = new MouseEvent(type, { button: 0, bubbles: true, cancelable: true });
  (ev as { __pad?: boolean }).__pad = true;
  return ev;
}

/**
 * Gamepad input — the code half of controller support.
 *
 * docs/PORTING.md §1.3 recorded zero Gamepad API usage anywhere in the repo,
 * and §3.2 makes controller support a hard Steam Deck Verified requirement
 * ("Players must not need to adjust any in-game settings in order to enable
 * controller support"). This module is the minimum that satisfies the code
 * side of that: poll `navigator.getGamepads()`, turn stick and button state
 * into the same intents the keyboard and mouse already produce, and do nothing
 * whatsoever when no pad is connected.
 *
 * ⚠️ THE THING THIS CANNOT SETTLE. PORTING §2.5: the browser Gamepad API is
 * reported dead under Steam Input on Chromium 114+ — "no gamepads work at all,
 * not even the steamdeck's own buttons" — and Electron 43 is Chromium 150. If
 * that reproduces, none of this code runs when Steam Input is active and the
 * input path has to become native Steam Input actions read in the main process
 * and forwarded over IPC (the `steamBridge` seam in app/steam/preload.cjs is
 * where that would land). Settling it needs a physical controller and a running
 * Steam client: run `node scripts/gamepad-probe.mjs`.
 *
 * DESIGN — why synthetic key events rather than a parallel input path.
 * `PlayerController` (controller.ts:46) holds a `Set<string>` of `e.code`
 * values, and main.ts's keydown handler owns a long priority chain for `KeyE`
 * (mount, enter building, talk, loot, …). Feeding synthesised `keydown`/`keyup`
 * through `window` inherits every one of those behaviours for free and keeps
 * the game-side wiring to a handful of lines. The exception is camera look,
 * which main.ts gates on `document.pointerLockElement === canvas`
 * (main.ts:7029) — a pad should still aim when the mouse never grabbed the
 * pointer, so look is delivered through a callback instead.
 *
 * DETERMINISM: no `Math.random`, no `Date.now`, no `new Date()`. The caller
 * supplies the frame delta; this module reads nothing but the pad.
 */

import type { UiAction } from './ui-focus';

/**
 * Standard-mapping button indices.
 * https://w3c.github.io/gamepad/#remapping — the layout every XInput pad,
 * DualSense and the Steam Deck's own controls report as `mapping: "standard"`.
 */
export const BUTTON = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  BACK: 8,
  START: 9,
  L3: 10,
  R3: 11,
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
} as const;

export interface GamepadConfig {
  /** Radial dead-zone on both sticks, 0..1. */
  deadzone: number;
  /** Right-stick look speed, in synthetic mouse pixels per second at full tilt. */
  lookSpeed: number;
  /** Invert the right stick's vertical axis. */
  invertY: boolean;
  /** Analog trigger press threshold (triggers report 0..1 on `value`). */
  triggerThreshold: number;
}

export const DEFAULT_CONFIG: GamepadConfig = {
  // 0.25 is a deliberately generous floor. Worn thumbsticks rest well off
  // centre, and a drifting stick that walks the player into the sea while they
  // read a dialogue box is a far worse bug than a slightly less precise walk.
  deadzone: 0.25,
  lookSpeed: 900,
  invertY: false,
  triggerThreshold: 0.5,
};

/** Minimal shape we need from a `Gamepad` — keeps the mapping unit-testable. */
export interface PadSnapshot {
  axes: readonly number[];
  /** Digital pressed state per button index. */
  buttons: readonly { pressed: boolean; value: number }[];
}

/**
 * Radial dead-zone with rescale.
 *
 * The naive per-axis dead-zone (`if (|x| < dz) x = 0`) leaves a square hole and
 * makes the stick snap to the axes near the centre. Doing it on the vector's
 * magnitude keeps the hole circular, and rescaling the remainder back onto
 * 0..1 means the first movement past the threshold starts at zero rather than
 * jumping straight to `dz`.
 */
export function applyDeadzone(x: number, y: number, deadzone: number): { x: number; y: number } {
  const mag = Math.hypot(x, y);
  if (mag <= deadzone) return { x: 0, y: 0 };
  if (mag === 0) return { x: 0, y: 0 };
  const scaled = Math.min(1, (mag - deadzone) / (1 - deadzone));
  return { x: (x / mag) * scaled, y: (y / mag) * scaled };
}

/**
 * Threshold on each component after the dead-zone, for turning an analog stick
 * into WASD. A stick held at 45° gives 0.707 on both components, so anything
 * below ~0.7 makes diagonals work; 0.35 also lets a half-pushed stick walk.
 */
const MOVE_THRESHOLD = 0.35;

/**
 * Threshold for the stick acting as a MENU cursor. Deliberately far above
 * MOVE_THRESHOLD: walking a step too far costs nothing, but a worn stick
 * resting at 0.4 that quietly steps the focus ring off "Save" and onto
 * "Delete" between the player looking down and pressing A is a lost save.
 */
const NAV_THRESHOLD = 0.6;

/**
 * Right-stick travel that counts as a target-cycle flick, and the travel it
 * must fall back below before another one can fire.
 *
 * Two thresholds, not one. The right stick is also the camera, so a player
 * swinging the view past a single threshold would cycle targets on the way out
 * AND on the way back; the gap is what makes a flick a deliberate gesture
 * rather than a side effect of looking around. 0.85 is far enough out that
 * ordinary camera work never reaches it.
 */
const FLICK_ON = 0.85;
const FLICK_OFF = 0.5;

/** Repeat rates for held menu navigation, in seconds. */
const NAV_FIRST_DELAY = 0.34;
const NAV_REPEAT = 0.13;

/**
 * Left stick → the `e.code` values `PlayerController` reads.
 *
 * Discrete keys lose nothing today: controller.ts:87-96 normalises the input
 * vector to unit length before applying speed, so analog magnitude is already
 * discarded. If walk-vs-run ever becomes continuous, this is the function that
 * has to grow an analog output — not the caller.
 *
 * Stick convention: +y is DOWN (toward the player), which is backwards in
 * world terms, hence `y < 0 → KeyW`.
 */
export function stickToMoveKeys(x: number, y: number): string[] {
  const keys: string[] = [];
  if (y < -MOVE_THRESHOLD) keys.push('KeyW');
  if (y > MOVE_THRESHOLD) keys.push('KeyS');
  if (x < -MOVE_THRESHOLD) keys.push('KeyA');
  if (x > MOVE_THRESHOLD) keys.push('KeyD');
  return keys;
}

/**
 * Focus-cursor direction for this poll, as a cardinal step.
 *
 * `allowStick` is false while the focused control wants the left stick as an
 * analog axis — the map pane. The d-pad still moves the ring in that case,
 * which is what lets the player leave the chart again.
 *
 * Diagonals are collapsed to horizontal. A menu has no diagonal neighbours, so
 * a d-pad pressed between two detents must pick one answer rather than fire
 * two moves and land somewhere the player did not aim.
 */
export function navDirection(
  pad: PadSnapshot,
  cfg: GamepadConfig = DEFAULT_CONFIG,
  allowStick = true,
): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;
  if (isDown(pad, BUTTON.DPAD_LEFT, cfg.triggerThreshold)) dx -= 1;
  if (isDown(pad, BUTTON.DPAD_RIGHT, cfg.triggerThreshold)) dx += 1;
  if (isDown(pad, BUTTON.DPAD_UP, cfg.triggerThreshold)) dy -= 1;
  if (isDown(pad, BUTTON.DPAD_DOWN, cfg.triggerThreshold)) dy += 1;
  if (dx === 0 && dy === 0 && allowStick) {
    const [lx = 0, ly = 0] = pad.axes;
    const s = applyDeadzone(lx, ly, cfg.deadzone);
    if (Math.abs(s.x) >= Math.abs(s.y)) {
      if (Math.abs(s.x) > NAV_THRESHOLD) dx = Math.sign(s.x);
    } else if (Math.abs(s.y) > NAV_THRESHOLD) {
      dy = Math.sign(s.y);
    }
  }
  if (dx !== 0 && dy !== 0) dy = 0;
  return { dx, dy };
}

/** What one poll of a pad means, in the game's own vocabulary. */
export interface PadIntent {
  /** `e.code` values that should be held this frame. */
  heldKeys: Set<string>;
  /** Look delta in synthetic mouse pixels for this frame. */
  look: { dx: number; dy: number };
  /** True while the attack input is held (right trigger). */
  attack: boolean;
  /** Focus-cursor step for this poll — UI context only, else (0, 0). */
  nav: { dx: number; dy: number };
  /** Left stick post-dead-zone, for the map pane's analog pan. */
  stick: { x: number; y: number };
}

/** Digital state of every mapped button, for edge detection between polls. */
export type ButtonState = Record<number, boolean>;

function isDown(pad: PadSnapshot, index: number, threshold: number): boolean {
  const b = pad.buttons[index];
  if (b === undefined) return false;
  // Triggers are analog on XInput: `pressed` is set by the UA at its own
  // threshold, `value` is the real travel. Take either.
  return b.pressed || b.value >= threshold;
}

/**
 * Map one poll of a pad to an intent, plus the button state for the next poll.
 *
 * `dtSec` scales the look delta so camera speed does not depend on frame rate.
 *
 * `uiMode` is the context switch, and it is the whole reason this function
 * takes a flag rather than growing a second copy. With a panel open the pad
 * stops being a body and becomes a cursor: no walking, no jumping, no
 * sprinting, no swinging — the player is reading a menu and none of those are
 * things they asked for. Two bindings deliberately survive the switch, because
 * both are about leaving the menu rather than acting in the world: Start
 * (Escape) and LB (push-to-talk, which is the entire point of the chat panel).
 */
export function mapPad(
  pad: PadSnapshot,
  dtSec: number,
  cfg: GamepadConfig = DEFAULT_CONFIG,
  uiMode = false,
  /** False while the focused control claims the left stick (the map pane). */
  navFromStick = true,
): { intent: PadIntent; buttons: ButtonState } {
  const [lx = 0, ly = 0, rx = 0, ry = 0] = pad.axes;

  const move = applyDeadzone(lx, ly, cfg.deadzone);
  const look = applyDeadzone(rx, ry, cfg.deadzone);

  const heldKeys = new Set<string>(uiMode ? [] : stickToMoveKeys(move.x, move.y));

  // The d-pad NO LONGER mirrors the left stick. Mirroring made it a second,
  // worse way to walk while the two things a d-pad is actually for — picking
  // an item and picking a menu entry — had no binding at all. In gameplay
  // left/right now step the hotbar (an edge, handled in poll()); in a panel
  // all four move the focus ring.
  if (!uiMode) {
    // Sprint on L3 ONLY.
    //
    // It used to be L3 *or* LT. LT is now Z-targeting (see the edge handler in
    // poll()), and a trigger that both locked on and sprinted would have made
    // every lock-on a sprint — which, since lock-on is the thing you press to
    // stand and fight, is exactly backwards. L3 keeps the binding every
    // player's thumb already looks for; LT was the redundant half of a pair.
    //
    // Jump on B: the brief specifies A for interact, and a movement layer with
    // no jump cannot clear a fence.
    if (isDown(pad, BUTTON.L3, cfg.triggerThreshold)) heldKeys.add('ShiftLeft');
    if (isDown(pad, BUTTON.B, cfg.triggerThreshold)) heldKeys.add('Space');
  }

  // Push-to-talk on LB, mapped to the same V the keyboard uses. Voice input
  // (src/game/voice) listens for KeyV on `window` and nowhere else, so the pad
  // needs no hook of its own — this is the "synthesise the events the game
  // already listens for" rule paying off again.
  //
  // It is deliberately a HELD key rather than an edge. The set-diff in poll()
  // then guarantees the matching keyup: a pad yanked out mid-sentence, or
  // `enabled` going false, runs releaseAll() and the microphone closes. An
  // edge-triggered latch would leave it open, and an open mic nobody asked for
  // is the one failure this feature must never have.
  //
  // LB because it is free (A interact, B jump, LT/L3 sprint, RT attack, Start
  // pause), it is a shoulder — reachable without leaving the sticks mid-
  // conversation — and it is where a decade of voice chat has trained people
  // to expect it.
  if (isDown(pad, BUTTON.LB, cfg.triggerThreshold)) heldKeys.add('KeyV');

  const sign = cfg.invertY ? -1 : 1;
  return {
    intent: {
      heldKeys,
      // The camera holds still behind a panel. main.ts's look hook already
      // refuses while `panels.isOpen`; zeroing it here also covers the death
      // card, which is not a panel and where a stick knocked by a startled
      // hand used to swing the camera under the "You Died" text.
      look: uiMode ? { dx: 0, dy: 0 } : {
        dx: look.x * cfg.lookSpeed * dtSec,
        dy: look.y * cfg.lookSpeed * dtSec * sign,
      },
      attack: !uiMode && isDown(pad, BUTTON.RT, cfg.triggerThreshold),
      nav: uiMode ? navDirection(pad, cfg, navFromStick) : { dx: 0, dy: 0 },
      stick: move,
    },
    buttons: {
      [BUTTON.A]: isDown(pad, BUTTON.A, cfg.triggerThreshold),
      [BUTTON.B]: isDown(pad, BUTTON.B, cfg.triggerThreshold),
      [BUTTON.X]: isDown(pad, BUTTON.X, cfg.triggerThreshold),
      [BUTTON.Y]: isDown(pad, BUTTON.Y, cfg.triggerThreshold),
      [BUTTON.START]: isDown(pad, BUTTON.START, cfg.triggerThreshold),
      [BUTTON.BACK]: isDown(pad, BUTTON.BACK, cfg.triggerThreshold),
      [BUTTON.RB]: isDown(pad, BUTTON.RB, cfg.triggerThreshold),
      [BUTTON.R3]: isDown(pad, BUTTON.R3, cfg.triggerThreshold),
      [BUTTON.LT]: isDown(pad, BUTTON.LT, cfg.triggerThreshold),
      [BUTTON.RT]: isDown(pad, BUTTON.RT, cfg.triggerThreshold),
      // The d-pad needs edge detection now that it is not a held movement key:
      // one press must step the hotbar by one, not by one per frame.
      [BUTTON.DPAD_UP]: isDown(pad, BUTTON.DPAD_UP, cfg.triggerThreshold),
      [BUTTON.DPAD_DOWN]: isDown(pad, BUTTON.DPAD_DOWN, cfg.triggerThreshold),
      [BUTTON.DPAD_LEFT]: isDown(pad, BUTTON.DPAD_LEFT, cfg.triggerThreshold),
      [BUTTON.DPAD_RIGHT]: isDown(pad, BUTTON.DPAD_RIGHT, cfg.triggerThreshold),
    },
  };
}

/** Buttons that went down between two polls. */
export function pressedEdges(prev: ButtonState, next: ButtonState): number[] {
  const out: number[] = [];
  for (const k of Object.keys(next)) {
    const i = Number(k);
    if (next[i] && !prev[i]) out.push(i);
  }
  return out;
}

/** Buttons that went up between two polls. */
export function releasedEdges(prev: ButtonState, next: ButtonState): number[] {
  const out: number[] = [];
  for (const k of Object.keys(next)) {
    const i = Number(k);
    if (!next[i] && prev[i]) out.push(i);
  }
  return out;
}

// ─── Runtime driver ──────────────────────────────────────────────────────────

export interface GamepadHooks {
  /** Camera look. Same units and sign as a pointer-locked `mousemove`. */
  onLook: (dx: number, dy: number) => void;
  /**
   * True while a DOM panel or overlay owns the pad. Everything below is the
   * panel half of the context switch and is only consulted when this is true.
   */
  uiActive?: () => boolean;
  /** True when the focused control claims the left stick (the map pane). */
  uiAnalog?: () => boolean;
  /**
   * One UI intent. See ui-focus.ts for what each one means. Returns whether
   * the panel consumed it — only X ever declines, so it can keep its gameplay
   * meaning when the ring is not on something droppable.
   */
  onUi?: (a: UiAction) => boolean;
  /** Gameplay d-pad left/right: step the active hotbar slot by `dir`. */
  onHotbar?: (dir: number) => void;
  /**
   * Right-stick flick while Z-targeting: step to the next target, `dir` -1 or
   * +1 (screen left / right).
   *
   * A hook rather than a synthesised key, following `onHotbar`. The keyboard's
   * cycle binding is Tab, and Tab with no lock held opens the pack — so a pad
   * flick routed through a synthetic Tab would open the inventory every time
   * the player nudged the camera stick while not locked on. There is no DOM
   * event that means this, so it does not pretend there is.
   */
  onLockCycle?: (dir: number) => void;
}

/**
 * Polls the first connected standard-mapping pad and drives the game.
 *
 * Synthesises the events the game already listens for, so nothing downstream
 * needs to know a pad exists. GAMEPLAY:
 *   held stick/L3/LT/B     → `keydown`/`keyup` with the matching `e.code`
 *   A                      → `keydown`/`keyup` `KeyE`   (the interact chain)
 *   LB                     → `keydown`/`keyup` `KeyV`   (push-to-talk)
 *   Start                  → `keydown` `Escape`         (pause)
 *   right trigger          → `mousedown`/`mouseup` button 0 (attack, bow draw)
 *   d-pad left/right       → `onHotbar(±1)`             (active item)
 *   X                      → `keydown` `KeyB`           (crafting)
 *   LT                     → `keydown` `KeyZ`           (Z-targeting toggle)
 *   right stick flick      → `onLockCycle(±1)`          (next target)
 *
 * PANEL (`hooks.uiActive()`), where the pad becomes a cursor:
 *   d-pad / left stick     → `onUi({kind:'nav'})`, repeat-rated
 *   A                      → `KeyE` first (voice confirm), then activate
 *   B                      → `onUi({kind:'back'})`       (close, NOT jump)
 *   X                      → `onUi({kind:'secondary'})`  (drop, in the pack)
 *   RB                     → `onUi({kind:'tab'})`        (crafting pages)
 *   triggers               → `onUi({kind:'zoom'})`       (the chart)
 *   LB, Start              → unchanged; both are ways OUT of the panel
 *
 * BOTH: Y → `KeyI` (inventory), Back → `KeyH` (controls), R3 → `KeyC`
 * (character), so the toggle that opens a panel is the one that closes it.
 *
 * Does nothing at all — not even an allocation past the first — when no pad is
 * connected, so this is safe to call unconditionally from the frame loop.
 */
export class GamepadInput {
  enabled = true;
  cfg: GamepadConfig = { ...DEFAULT_CONFIG };

  private held = new Set<string>();
  private buttons: ButtonState = {};
  private attackHeld = false;
  /** Index of the pad we are following, or -1. */
  private padIndex = -1;
  /** Focus-cursor direction currently held, and time to the next repeat. */
  private navDx = 0;
  private navDy = 0;
  private navTimer = 0;
  /**
   * Latch for the right-stick target-cycle flick.
   *
   * True while the stick is past `FLICK_ON`; the cycle fires on the rising
   * edge only. Without the latch a held stick would cycle once per frame and
   * run through the whole target list in a fifth of a second.
   */
  private flickLatched = false;

  /** True when a pad has been seen this session — for the HUD/glyph work. */
  get connected(): boolean { return this.padIndex >= 0; }

  /** Pick the first pad reporting the standard mapping and any activity. */
  private pick(): PadSnapshot | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    if (this.padIndex >= 0) {
      const cur = pads[this.padIndex];
      if (cur && cur.connected) return cur;
      this.padIndex = -1;
      this.releaseAll();
    }
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (p && p.connected) { this.padIndex = i; return p; }
    }
    return null;
  }

  /** Drop every synthetic key/button we are holding. */
  private releaseAll(): void {
    for (const code of this.held) {
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
    }
    this.held.clear();
    if (this.attackHeld) {
      window.dispatchEvent(padMouse('mouseup'));
      this.attackHeld = false;
    }
    this.buttons = {};
    this.navDx = 0;
    this.navDy = 0;
    this.navTimer = 0;
    this.flickLatched = false;
  }

  /**
   * One frame. `dtSec` is the real frame delta in seconds.
   *
   * Called from the RAF loop, so it must stay cheap: two allocations and a
   * handful of set operations when a pad is present, one array read when not.
   */
  poll(dtSec: number, hooks: GamepadHooks): void {
    if (!this.enabled) { if (this.held.size) this.releaseAll(); return; }
    const pad = this.pick();
    if (pad === null) { if (this.held.size) this.releaseAll(); return; }

    const ui = hooks.uiActive?.() === true;
    const analog = ui && hooks.uiAnalog?.() === true;
    const { intent, buttons } = mapPad(pad, dtSec, this.cfg, ui, !analog);

    // Keys: diff against what we are already holding so each transition fires
    // exactly one event. `PlayerController` keys off `keydown`/`keyup` pairs
    // and a missed `keyup` sticks the player walking into a wall forever.
    for (const code of intent.heldKeys) {
      if (!this.held.has(code)) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      }
    }
    for (const code of this.held) {
      if (!intent.heldKeys.has(code)) {
        window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
      }
    }
    this.held = intent.heldKeys;

    // Edge-triggered buttons.
    for (const b of pressedEdges(this.buttons, buttons)) {
      if (b === BUTTON.A) {
        // A always dispatches KeyE on `window` FIRST, in both contexts, and
        // this ordering is load-bearing rather than incidental.
        //
        // voice-input.ts:224 tells a pad's A from a typed "e" by the event's
        // target: the pad's is `window`, a keyboard's is the focused input.
        // That is how "hold LB, speak, press A to send" works, and routing A
        // straight to the focus ring instead would have broken it silently —
        // the ring would have clicked Send only when Send happened to be
        // focused, and done something else entirely when it was not.
        //
        // So the panel case is a FALL-THROUGH, not a replacement: dispatch the
        // key, and treat the panel activation as what happens when nobody
        // claimed it. `preventDefault` is the claim, which is why these events
        // became cancelable (they were not, so voice's preventDefault was
        // talking to a no-op and only worked by accident of ordering).
        const ev = new KeyboardEvent('keydown',
          { code: 'KeyE', bubbles: true, cancelable: true });
        window.dispatchEvent(ev);
        if (ui && !ev.defaultPrevented) hooks.onUi?.({ kind: 'activate' });
      } else if (b === BUTTON.START) {
        window.dispatchEvent(new KeyboardEvent('keydown',
          { code: 'Escape', bubbles: true, cancelable: true }));
      } else if (b === BUTTON.Y) {
        // The panels a pad could not previously even OPEN. Y and Back are the
        // buttons gameplay was not using, and each is a plain synthesis of the
        // key the game already binds — so opening the inventory from a pad
        // needed no game-side wiring at all, only a binding nobody had made.
        // This was half the original complaint: "no moving the cursor …
        // select, inventory, active item, craft".
        //
        // Deliberately NOT gated on context: main.ts handles I/H above its
        // `if (panels.isOpen) return` gate, so the same press that opens the
        // inventory closes it again, and swaps straight from crafting to
        // inventory without a trip through B. That is what a toggle should do.
        window.dispatchEvent(new KeyboardEvent('keydown',
          { code: 'KeyI', bubbles: true, cancelable: true }));
      } else if (b === BUTTON.BACK) {
        window.dispatchEvent(new KeyboardEvent('keydown',
          { code: 'KeyH', bubbles: true, cancelable: true }));
      } else if (b === BUTTON.R3) {
        // The character sheet, on the last free button. Not a natural home for
        // it — but the alternative was the one panel in the game with no pad
        // route at all, which is the exact complaint this work exists to
        // answer, and "fully navigable once you find a keyboard" is not an
        // answer. The help panel (Back) is where a player learns it.
        window.dispatchEvent(new KeyboardEvent('keydown',
          { code: 'KeyC', bubbles: true, cancelable: true }));
      } else if (b === BUTTON.X) {
        // X is the secondary verb for whatever is on screen: drop the stack
        // when the ring is on a pack slot, otherwise open (or close) the
        // crafting bench. The panel gets first refusal and declines everywhere
        // except an inventory slot, so X stays a working toggle — otherwise
        // the button that opened crafting could not close it and the player
        // had to learn a second one.
        const claimed = ui && hooks.onUi?.({ kind: 'secondary' }) === true;
        if (!claimed) {
          window.dispatchEvent(new KeyboardEvent('keydown',
            { code: 'KeyB', bubbles: true, cancelable: true }));
        }
      } else if (ui && b === BUTTON.B) {
        hooks.onUi?.({ kind: 'back' });
      } else if (ui && b === BUTTON.RB) {
        hooks.onUi?.({ kind: 'tab', dir: 1 });
      } else if (ui && (b === BUTTON.LT || b === BUTTON.RT)) {
        hooks.onUi?.({ kind: 'zoom', dir: b === BUTTON.RT ? -1 : 1 });
      } else if (!ui && b === BUTTON.LT) {
        // Z-targeting, as a TOGGLE rather than a hold.
        //
        // Hold-to-lock is the older convention, but a hold needs held-key
        // state, and held state on a pad has exactly one failure mode that
        // matters: yank the controller mid-fight and the flag never clears.
        // `releaseAll()` covers synthesised held KEYS; it would not have
        // covered a lock flag without a second mechanism. A toggle has no such
        // state to leak, and it matches the keyboard's Z exactly, so the two
        // input paths cannot drift apart.
        window.dispatchEvent(new KeyboardEvent('keydown',
          { code: 'KeyZ', bubbles: true, cancelable: true }));
      } else if (!ui && b === BUTTON.DPAD_LEFT) {
        hooks.onHotbar?.(-1);
      } else if (!ui && b === BUTTON.DPAD_RIGHT) {
        hooks.onHotbar?.(1);
      }
    }
    // Right-stick flick → next target. Gameplay only: in a panel the right
    // stick does nothing and the same motion must not cycle anything.
    if (!ui) {
      const rx = pad.axes[2] ?? 0;
      if (!this.flickLatched && Math.abs(rx) >= FLICK_ON) {
        this.flickLatched = true;
        hooks.onLockCycle?.(rx > 0 ? 1 : -1);
      } else if (this.flickLatched && Math.abs(rx) <= FLICK_OFF) {
        this.flickLatched = false;
      }
    } else {
      this.flickLatched = false;
    }

    for (const b of releasedEdges(this.buttons, buttons)) {
      if (b === BUTTON.A) {
        window.dispatchEvent(new KeyboardEvent('keyup',
          { code: 'KeyE', bubbles: true, cancelable: true }));
      } else if (b === BUTTON.START) {
        window.dispatchEvent(new KeyboardEvent('keyup',
          { code: 'Escape', bubbles: true, cancelable: true }));
      }
    }
    this.buttons = buttons;

    // Focus cursor: fire once on the press, then repeat while held. Both
    // constants are wall-clock seconds off the caller's frame delta, so the
    // ring walks a list at the same rate on a 30 fps handheld as on a 144 Hz
    // desktop — and it keeps ticking while the sim clock is paused, which is
    // precisely when every one of these panels is open.
    if (intent.nav.dx !== this.navDx || intent.nav.dy !== this.navDy) {
      this.navDx = intent.nav.dx;
      this.navDy = intent.nav.dy;
      this.navTimer = NAV_FIRST_DELAY;
      if (this.navDx !== 0 || this.navDy !== 0) {
        hooks.onUi?.({ kind: 'nav', dx: this.navDx, dy: this.navDy });
      }
    } else if (this.navDx !== 0 || this.navDy !== 0) {
      this.navTimer -= dtSec;
      // `while`, not `if`: one long frame (an alt-tab, a shader compile) must
      // not swallow a repeat and make a held direction feel like it stalled.
      while (this.navTimer <= 0) {
        hooks.onUi?.({ kind: 'nav', dx: this.navDx, dy: this.navDy });
        this.navTimer += NAV_REPEAT;
      }
    }

    // The map pane takes the left stick as an analog axis while it is focused.
    if (analog && (intent.stick.x !== 0 || intent.stick.y !== 0)) {
      hooks.onUi?.({ kind: 'pan', dx: intent.stick.x, dy: intent.stick.y });
    }

    // Attack is press-and-hold, not an edge: a bow draws while the trigger is
    // down and looses on release (main.ts:9224/9234).
    if (intent.attack !== this.attackHeld) {
      window.dispatchEvent(padMouse(intent.attack ? 'mousedown' : 'mouseup'));
      this.attackHeld = intent.attack;
    }

    if (intent.look.dx !== 0 || intent.look.dy !== 0) {
      hooks.onLook(intent.look.dx, intent.look.dy);
    }
  }
}
