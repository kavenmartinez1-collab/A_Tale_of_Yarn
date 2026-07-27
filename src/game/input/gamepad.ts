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

/** What one poll of a pad means, in the game's own vocabulary. */
export interface PadIntent {
  /** `e.code` values that should be held this frame. */
  heldKeys: Set<string>;
  /** Look delta in synthetic mouse pixels for this frame. */
  look: { dx: number; dy: number };
  /** True while the attack input is held (right trigger). */
  attack: boolean;
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
 */
export function mapPad(
  pad: PadSnapshot,
  dtSec: number,
  cfg: GamepadConfig = DEFAULT_CONFIG,
): { intent: PadIntent; buttons: ButtonState } {
  const [lx = 0, ly = 0, rx = 0, ry = 0] = pad.axes;

  const move = applyDeadzone(lx, ly, cfg.deadzone);
  const look = applyDeadzone(rx, ry, cfg.deadzone);

  const heldKeys = new Set(stickToMoveKeys(move.x, move.y));
  // D-pad mirrors the left stick so menus and precise nudges both work.
  if (isDown(pad, BUTTON.DPAD_UP, cfg.triggerThreshold)) heldKeys.add('KeyW');
  if (isDown(pad, BUTTON.DPAD_DOWN, cfg.triggerThreshold)) heldKeys.add('KeyS');
  if (isDown(pad, BUTTON.DPAD_LEFT, cfg.triggerThreshold)) heldKeys.add('KeyA');
  if (isDown(pad, BUTTON.DPAD_RIGHT, cfg.triggerThreshold)) heldKeys.add('KeyD');

  // Sprint on L3 or the left trigger — the two places every player's thumb
  // already looks for it. Jump on B: the brief specifies A for interact, and a
  // movement layer with no jump cannot clear a fence.
  if (isDown(pad, BUTTON.L3, cfg.triggerThreshold)
    || isDown(pad, BUTTON.LT, cfg.triggerThreshold)) heldKeys.add('ShiftLeft');
  if (isDown(pad, BUTTON.B, cfg.triggerThreshold)) heldKeys.add('Space');

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
      look: {
        dx: look.x * cfg.lookSpeed * dtSec,
        dy: look.y * cfg.lookSpeed * dtSec * sign,
      },
      attack: isDown(pad, BUTTON.RT, cfg.triggerThreshold),
    },
    buttons: {
      [BUTTON.A]: isDown(pad, BUTTON.A, cfg.triggerThreshold),
      [BUTTON.B]: isDown(pad, BUTTON.B, cfg.triggerThreshold),
      [BUTTON.X]: isDown(pad, BUTTON.X, cfg.triggerThreshold),
      [BUTTON.Y]: isDown(pad, BUTTON.Y, cfg.triggerThreshold),
      [BUTTON.START]: isDown(pad, BUTTON.START, cfg.triggerThreshold),
      [BUTTON.BACK]: isDown(pad, BUTTON.BACK, cfg.triggerThreshold),
      [BUTTON.RT]: isDown(pad, BUTTON.RT, cfg.triggerThreshold),
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
}

/**
 * Polls the first connected standard-mapping pad and drives the game.
 *
 * Synthesises the events the game already listens for, so nothing downstream
 * needs to know a pad exists:
 *   held sticks/d-pad/L3/B → `keydown`/`keyup` with the matching `e.code`
 *   A                      → `keydown`/`keyup` `KeyE`   (the interact chain)
 *   LB                     → `keydown`/`keyup` `KeyV`   (push-to-talk)
 *   Start                  → `keydown` `Escape`         (pause)
 *   right trigger          → `mousedown`/`mouseup` button 0 (attack, bow draw)
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
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
      this.attackHeld = false;
    }
    this.buttons = {};
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

    const { intent, buttons } = mapPad(pad, dtSec, this.cfg);

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
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
      } else if (b === BUTTON.START) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
      }
    }
    for (const b of releasedEdges(this.buttons, buttons)) {
      if (b === BUTTON.A) {
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE', bubbles: true }));
      } else if (b === BUTTON.START) {
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Escape', bubbles: true }));
      }
    }
    this.buttons = buttons;

    // Attack is press-and-hold, not an edge: a bow draws while the trigger is
    // down and looses on release (main.ts:9224/9234).
    if (intent.attack !== this.attackHeld) {
      window.dispatchEvent(new MouseEvent(
        intent.attack ? 'mousedown' : 'mouseup', { button: 0, bubbles: true }));
      this.attackHeld = intent.attack;
    }

    if (intent.look.dx !== 0 || intent.look.dy !== 0) {
      hooks.onLook(intent.look.dx, intent.look.dy);
    }
  }
}
