/**
 * test-gamepad.mts — the pad→intent mapping, exercised without a pad.
 *
 *   npx tsx scripts/test-gamepad.mts
 *
 * Hardware verification is explicitly NOT what this is. A physical controller
 * plus a running Steam client is the only way to answer the question in
 * PORTING §2.5 (is the browser Gamepad API dead under Steam Input on Chromium
 * 114+), and that test is `node scripts/gamepad-probe.mjs`.
 *
 * What IS testable here is every decision the mapping makes: dead-zone edges,
 * the diagonal that must produce two keys, the drifting stick that must
 * produce none, frame-rate independence of the look delta, and the button
 * edges — because a missed `keyup` edge sticks the player walking into a wall
 * until they alt-tab, and that is the failure mode a pure unit test can
 * actually catch.
 */

import {
  applyDeadzone, stickToMoveKeys, mapPad, pressedEdges, releasedEdges,
  navDirection, BUTTON, DEFAULT_CONFIG, type PadSnapshot,
} from '../src/game/input/gamepad';
import { pickInDirection, type NavRect } from '../src/game/input/ui-focus';
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else { fail++; process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`); }
}

function eq(name: string, got: unknown, want: unknown): void {
  ok(name, Object.is(got, want), `got ${String(got)}, want ${String(want)}`);
}

function near(name: string, got: number, want: number, tol = 1e-9): void {
  ok(name, Math.abs(got - want) <= tol, `got ${got}, want ${want} ±${tol}`);
}

function setEq(name: string, got: Iterable<string>, want: string[]): void {
  const g = [...got].sort().join(',');
  const w = [...want].sort().join(',');
  ok(name, g === w, `got [${g}], want [${w}]`);
}

/** A pad with everything at rest, then whatever the caller overrides. */
function padOf(axes: number[] = [0, 0, 0, 0], down: number[] = [],
  analog: Record<number, number> = {}): PadSnapshot {
  const buttons = Array.from({ length: 16 }, (_, i) => ({
    pressed: down.includes(i),
    value: analog[i] ?? (down.includes(i) ? 1 : 0),
  }));
  return { axes, buttons };
}

// ─── Dead-zone ───────────────────────────────────────────────────────────────

const DZ = DEFAULT_CONFIG.deadzone; // 0.25

{
  const z = applyDeadzone(0, 0, DZ);
  eq('centred stick → x 0', z.x, 0);
  eq('centred stick → y 0', z.y, 0);
}
{
  // Exactly ON the threshold is inside it. `<=` not `<`, so a stick resting at
  // precisely the dead-zone radius does not creep.
  const z = applyDeadzone(DZ, 0, DZ);
  eq('at the dead-zone edge → still zero', z.x, 0);
}
{
  // The rescale is the whole point: just past the edge must start near zero,
  // not jump to 0.25. Without rescaling, the first perceptible movement is a
  // lurch.
  const z = applyDeadzone(DZ + 1e-6, 0, DZ);
  ok('just past the edge starts near zero', z.x > 0 && z.x < 1e-5, `x=${z.x}`);
}
{
  const z = applyDeadzone(1, 0, DZ);
  near('full tilt → magnitude 1', Math.hypot(z.x, z.y), 1);
}
{
  // Radial, not per-axis: a stick at (0.2, 0.2) has magnitude 0.283, which is
  // OUTSIDE a 0.25 radius even though neither axis passes 0.25 on its own. A
  // square dead-zone would wrongly zero this and make the stick snap to the
  // axes near centre.
  const z = applyDeadzone(0.2, 0.2, DZ);
  ok('diagonal inside both axes but outside the radius survives',
    z.x > 0 && z.y > 0, `x=${z.x}, y=${z.y}`);
  near('…and stays on its diagonal', z.x, z.y);
}
{
  // Magnitude can exceed 1 on a real pad (the stick gate is not a perfect
  // circle); the result must still be clamped or a corner-pushed stick would
  // move faster than a straight one.
  const z = applyDeadzone(1, 1, DZ);
  near('over-range diagonal clamps to magnitude 1', Math.hypot(z.x, z.y), 1);
}

// ─── Stick → WASD ────────────────────────────────────────────────────────────

setEq('stick up → W', stickToMoveKeys(0, -1), ['KeyW']);
setEq('stick down → S', stickToMoveKeys(0, 1), ['KeyS']);
setEq('stick left → A', stickToMoveKeys(-1, 0), ['KeyA']);
setEq('stick right → D', stickToMoveKeys(1, 0), ['KeyD']);
setEq('centred → nothing', stickToMoveKeys(0, 0), []);
{
  // 45° gives 0.707 per component — both keys must fire, or diagonals become
  // a stutter between two cardinal directions.
  const d = Math.SQRT1_2;
  setEq('up-left diagonal → W + A', stickToMoveKeys(-d, -d), ['KeyW', 'KeyA']);
  setEq('down-right diagonal → S + D', stickToMoveKeys(d, d), ['KeyS', 'KeyD']);
}
setEq('half-pushed stick still walks', stickToMoveKeys(0, -0.4), ['KeyW']);
setEq('barely-off-centre does not', stickToMoveKeys(0, -0.3), []);

// ─── Full mapping ────────────────────────────────────────────────────────────

{
  const { intent } = mapPad(padOf([0, -1, 0, 0]), 1 / 60);
  setEq('left stick forward → KeyW held', intent.heldKeys, ['KeyW']);
  eq('…and no look', intent.look.dx, 0);
  eq('…and no attack', intent.attack, false);
}
{
  // A worn stick resting at 0.15 is the single most common real-world input,
  // and it must produce absolutely nothing.
  const { intent } = mapPad(padOf([0.15, 0.15, 0.1, -0.1]), 1 / 60);
  setEq('drifting sticks → no movement', intent.heldKeys, []);
  eq('drifting sticks → no look dx', intent.look.dx, 0);
  eq('drifting sticks → no look dy', intent.look.dy, 0);
}
{
  const { intent } = mapPad(padOf([0, 0, 1, 0]), 1 / 60);
  near('right stick full right → look speed × dt',
    intent.look.dx, DEFAULT_CONFIG.lookSpeed / 60, 1e-9);
}
{
  // Frame-rate independence: the same stick over the same wall time must turn
  // the camera the same amount whether that is one 30 Hz frame or two 60 Hz
  // frames.
  const a = mapPad(padOf([0, 0, 1, 0]), 1 / 30).intent.look.dx;
  const b = mapPad(padOf([0, 0, 1, 0]), 1 / 60).intent.look.dx * 2;
  near('look delta is frame-rate independent', a, b, 1e-9);
}
{
  const inv = { ...DEFAULT_CONFIG, invertY: true };
  const up = mapPad(padOf([0, 0, 0, -1]), 1 / 60, inv).intent.look.dy;
  const norm = mapPad(padOf([0, 0, 0, -1]), 1 / 60).intent.look.dy;
  near('invertY flips the vertical look', up, -norm);
}
{
  const { intent } = mapPad(padOf([0, 0, 0, 0], [BUTTON.RT]), 1 / 60);
  eq('right trigger → attack held', intent.attack, true);
}
{
  // Analog triggers report travel on `value` even when the UA has not set
  // `pressed` yet. Half-pull must not fire; a firm pull must.
  const soft = mapPad(padOf([0, 0, 0, 0], [], { [BUTTON.RT]: 0.3 }), 1 / 60);
  eq('trigger at 0.3 → no attack', soft.intent.attack, false);
  const firm = mapPad(padOf([0, 0, 0, 0], [], { [BUTTON.RT]: 0.8 }), 1 / 60);
  eq('trigger at 0.8 → attack', firm.intent.attack, true);
}
{
  const l3 = mapPad(padOf([0, -1, 0, 0], [BUTTON.L3]), 1 / 60).intent.heldKeys;
  setEq('L3 while walking → sprint', l3, ['KeyW', 'ShiftLeft']);
  const lt = mapPad(padOf([0, -1, 0, 0], [BUTTON.LT]), 1 / 60).intent.heldKeys;
  setEq('left trigger also sprints', lt, ['KeyW', 'ShiftLeft']);
}
{
  const jump = mapPad(padOf([0, 0, 0, 0], [BUTTON.B]), 1 / 60).intent.heldKeys;
  setEq('B → Space (jump)', jump, ['Space']);
}
{
  // The d-pad NO LONGER walks. It used to mirror the left stick, which made it
  // a second and worse way to do the one thing the pad already did well, while
  // the two jobs a d-pad exists for — pick an item, pick a menu entry — had no
  // binding at all. This is the regression guard for that reassignment.
  for (const b of [BUTTON.DPAD_LEFT, BUTTON.DPAD_RIGHT, BUTTON.DPAD_UP, BUTTON.DPAD_DOWN]) {
    const keys = mapPad(padOf([0, 0, 0, 0], [b]), 1 / 60).intent.heldKeys;
    setEq(`d-pad ${b} no longer walks`, keys, []);
  }
  // …but it must still be tracked, or the hotbar step has no edge to fire on.
  const left = mapPad(padOf([0, 0, 0, 0], [BUTTON.DPAD_LEFT]), 1 / 60);
  eq('d-pad left is in the button state', left.buttons[BUTTON.DPAD_LEFT], true);
  eq('d-pad right is in the button state',
    mapPad(padOf([0, 0, 0, 0], [BUTTON.DPAD_RIGHT]), 1 / 60).buttons[BUTTON.DPAD_RIGHT], true);
  const rest = mapPad(padOf(), 1 / 60).buttons;
  setEq('one d-pad press is one hotbar step',
    pressedEdges(rest, left.buttons).map(String), [String(BUTTON.DPAD_LEFT)]);
  setEq('holding the d-pad does not walk the hotbar',
    pressedEdges(left.buttons, left.buttons).map(String), []);
}
{
  // Push-to-talk on LB → the same KeyV the keyboard uses, so src/game/voice
  // needs no pad-specific path. HELD, not edged: poll()'s set-diff is what
  // guarantees the matching keyup, and a missed keyup here means a microphone
  // that never closes.
  const lb = mapPad(padOf([0, 0, 0, 0], [BUTTON.LB]), 1 / 60);
  setEq('LB → KeyV (push-to-talk)', lb.intent.heldKeys, ['KeyV']);
  eq('LB does not attack', lb.intent.attack, false);

  // Talking while walking has to keep working — a player backing away from a
  // wolf mid-sentence should not stop doing either.
  const walkTalk = mapPad(padOf([0, -1, 0, 0], [BUTTON.LB]), 1 / 60).intent.heldKeys;
  setEq('LB while walking → both', walkTalk, ['KeyW', 'KeyV']);

  // LT and LB are adjacent and both are on the left hand. Sprint must not
  // open the microphone, and push-to-talk must not make the player run.
  const lt = mapPad(padOf([0, 0, 0, 0], [BUTTON.LT]), 1 / 60).intent.heldKeys;
  ok('left trigger does not open the mic', !lt.has('KeyV'));
  ok('LB does not sprint', !lb.intent.heldKeys.has('ShiftLeft'));

  // Released → the key must leave the set, which is what produces the keyup.
  const released = mapPad(padOf([0, 0, 0, 0], []), 1 / 60).intent.heldKeys;
  ok('releasing LB drops KeyV', !released.has('KeyV'));

  // Analog half-pull: LB is digital on every standard pad, but isDown() reads
  // `value` too, so pin the threshold behaviour the same way RT is pinned.
  const half = mapPad(padOf([0, 0, 0, 0], [], { [BUTTON.LB]: 0.3 }), 1 / 60).intent.heldKeys;
  ok('LB at 0.3 does not open the mic', !half.has('KeyV'));
  const most = mapPad(padOf([0, 0, 0, 0], [], { [BUTTON.LB]: 0.8 }), 1 / 60).intent.heldKeys;
  ok('LB at 0.8 opens the mic', most.has('KeyV'));
}
{
  // A is interact and must NOT leak into the held-key set — it is edge
  // triggered, because main.ts's KeyE chain fires once per press.
  const a = mapPad(padOf([0, 0, 0, 0], [BUTTON.A]), 1 / 60);
  setEq('A produces no held movement key', a.intent.heldKeys, []);
  eq('A is reported in the button state', a.buttons[BUTTON.A], true);
}

// ─── Button edges ────────────────────────────────────────────────────────────

{
  const rest = mapPad(padOf(), 1 / 60).buttons;
  const held = mapPad(padOf([0, 0, 0, 0], [BUTTON.A]), 1 / 60).buttons;

  setEq('press edge fires once', pressedEdges(rest, held).map(String), [String(BUTTON.A)]);
  setEq('holding fires no further press edge', pressedEdges(held, held).map(String), []);
  setEq('release edge fires once', releasedEdges(held, rest).map(String), [String(BUTTON.A)]);
  setEq('staying released fires no edge', releasedEdges(rest, rest).map(String), []);
}
{
  // The one that matters: a pad yanked out mid-press must not leave a phantom
  // held key. `releasedEdges` against an EMPTY previous state is what the
  // driver's disconnect path relies on, so it must be safe.
  const held = mapPad(padOf([0, 0, 0, 0], [BUTTON.START]), 1 / 60).buttons;
  setEq('release edges against an empty prev state', releasedEdges({}, held).map(String), []);
  setEq('press edges from an empty prev state fire',
    pressedEdges({}, held).map(String), [String(BUTTON.START)]);
}
{
  const start = mapPad(padOf([0, 0, 0, 0], [BUTTON.START]), 1 / 60);
  eq('Start is tracked for the pause edge', start.buttons[BUTTON.START], true);
}

// ─── Degenerate input ────────────────────────────────────────────────────────

{
  // A pad reporting fewer axes than standard mapping (some adapters do) must
  // not throw or produce NaN.
  const { intent } = mapPad({ axes: [0.9], buttons: [] }, 1 / 60);
  setEq('short axes array → right stick reads as centred', intent.heldKeys, ['KeyD']);
  eq('…and look stays finite', Number.isFinite(intent.look.dx), true);
  eq('…and no attack from a missing button', intent.attack, false);
}
{
  const { intent } = mapPad({ axes: [], buttons: [] }, 1 / 60);
  setEq('no axes at all → nothing held', intent.heldKeys, []);
  eq('no axes at all → no look', intent.look.dx, 0);
}

// ─── The panel context switch ────────────────────────────────────────────────

{
  // With a panel open the pad stops being a body. Everything that moves,
  // jumps, sprints or swings has to go quiet, or the player is walking into
  // the sea while they read their inventory.
  const walking = padOf([0, -1, 0, 0], [BUTTON.B, BUTTON.L3, BUTTON.RT]);
  const play = mapPad(walking, 1 / 60, DEFAULT_CONFIG, false);
  const ui = mapPad(walking, 1 / 60, DEFAULT_CONFIG, true);
  setEq('gameplay: stick + B + L3 → walk, jump, sprint',
    play.intent.heldKeys, ['KeyW', 'Space', 'ShiftLeft']);
  eq('gameplay: RT attacks', play.intent.attack, true);
  setEq('panel: the same input holds nothing', ui.intent.heldKeys, []);
  eq('panel: RT does not attack', ui.intent.attack, false);
  eq('panel: the camera holds still', ui.intent.look.dx, 0);
}
{
  // The two bindings that MUST survive the switch, because both are ways out
  // of the panel rather than actions in the world. LB especially: the chat
  // panel is the one place push-to-talk matters most, and the context switch
  // going through it would have silently killed voice input.
  const lb = mapPad(padOf([0, 0, 0, 0], [BUTTON.LB]), 1 / 60, DEFAULT_CONFIG, true);
  setEq('panel: LB still opens the mic', lb.intent.heldKeys, ['KeyV']);
  const start = mapPad(padOf([0, 0, 0, 0], [BUTTON.START]), 1 / 60, DEFAULT_CONFIG, true);
  eq('panel: Start is still tracked for Escape', start.buttons[BUTTON.START], true);
}
{
  // Every panel the pad can open must have a tracked button behind it, or the
  // binding silently does nothing. R3 in particular: the character sheet was
  // the last panel with no pad route at all.
  for (const [name, b] of [['Y (inventory)', BUTTON.Y], ['Back (help)', BUTTON.BACK],
    ['R3 (character)', BUTTON.R3], ['X (crafting)', BUTTON.X]] as const) {
    eq(`${name} is tracked for its edge`,
      mapPad(padOf([0, 0, 0, 0], [b]), 1 / 60).buttons[b], true);
  }
  const right = mapPad(padOf([0, 0, 0, 0], [BUTTON.RB]), 1 / 60, DEFAULT_CONFIG, true);
  eq('RB is tracked for the tab cycle', right.buttons[BUTTON.RB], true);
  const lt = mapPad(padOf([0, 0, 0, 0], [BUTTON.LT]), 1 / 60, DEFAULT_CONFIG, true);
  eq('LT is tracked for the chart zoom', lt.buttons[BUTTON.LT], true);
  setEq('panel: LT does not sprint', lt.intent.heldKeys, []);
}

// ─── Focus-cursor direction ──────────────────────────────────────────────────

{
  eq('d-pad up → nav up',
    navDirection(padOf([0, 0, 0, 0], [BUTTON.DPAD_UP])).dy, -1);
  eq('d-pad down → nav down',
    navDirection(padOf([0, 0, 0, 0], [BUTTON.DPAD_DOWN])).dy, 1);
  eq('d-pad left → nav left',
    navDirection(padOf([0, 0, 0, 0], [BUTTON.DPAD_LEFT])).dx, -1);
  eq('d-pad right → nav right',
    navDirection(padOf([0, 0, 0, 0], [BUTTON.DPAD_RIGHT])).dx, 1);
  const rest = navDirection(padOf());
  eq('nothing pressed → no nav dx', rest.dx, 0);
  eq('nothing pressed → no nav dy', rest.dy, 0);
}
{
  // A menu has no diagonal neighbours. A d-pad caught between two detents must
  // pick ONE answer, or a single press moves the ring twice and lands
  // somewhere the player never aimed at.
  const d = navDirection(padOf([0, 0, 0, 0], [BUTTON.DPAD_UP, BUTTON.DPAD_LEFT]));
  eq('diagonal d-pad collapses to horizontal (dx)', d.dx, -1);
  eq('diagonal d-pad collapses to horizontal (dy)', d.dy, 0);
}
{
  // The nav threshold is deliberately far above the WALK threshold. A stick
  // resting at 0.4 walks — costs nothing — but a stick at 0.4 that quietly
  // steps the ring from Save onto Delete between the player looking down and
  // pressing A is a lost save.
  eq('stick at 0.4 walks', stickToMoveKeys(0, -0.4).length, 1);
  eq('…but does not move the focus ring', navDirection(padOf([0, -0.4, 0, 0])).dy, 0);
  eq('stick at 0.9 does move the ring', navDirection(padOf([0, -0.9, 0, 0])).dy, -1);
}
{
  // Diagonal stick picks the dominant axis, same reasoning as the d-pad.
  const d = navDirection(padOf([0.9, -0.75, 0, 0]));
  eq('diagonal stick picks the dominant axis (dx)', d.dx, 1);
  eq('diagonal stick picks the dominant axis (dy)', d.dy, 0);
}
{
  // While the chart is focused the left stick is an analog pan, so it must not
  // ALSO walk the ring — but the d-pad still has to, or the player can never
  // leave the map.
  const held = padOf([0.9, 0, 0, 0], [BUTTON.DPAD_DOWN]);
  eq('chart focused: stick does not move the ring',
    navDirection(padOf([0.9, 0, 0, 0]), DEFAULT_CONFIG, false).dx, 0);
  eq('chart focused: d-pad still moves the ring',
    navDirection(held, DEFAULT_CONFIG, false).dy, 1);
  const ui = mapPad(padOf([0.9, 0.4, 0, 0]), 1 / 60, DEFAULT_CONFIG, true, false);
  near('chart focused: the stick is still reported for the pan', ui.intent.stick.x,
    (0.9 / Math.hypot(0.9, 0.4)) * ((Math.hypot(0.9, 0.4) - DZ) / (1 - DZ)), 1e-9);
}

// ─── Spatial navigation ──────────────────────────────────────────────────────

{
  // The inventory pack: 7 columns × 4 rows of 44 px cells, 6 px gap — the real
  // layout from inventory-ui.ts, because a picker that works on a synthetic
  // grid and not on this one is worthless.
  const grid: NavRect[] = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 7; c++) grid.push({ x: 100 + c * 50, y: 200 + r * 50, w: 44, h: 44 });
  }
  eq('grid: right steps one column', pickInDirection(grid, 0, 1, 0), 1);
  eq('grid: down steps one ROW, not one cell', pickInDirection(grid, 0, 0, 1), 7);
  eq('grid: up from row 1 returns to row 0', pickInDirection(grid, 7, 0, -1), 0);
  eq('grid: left from mid-row', pickInDirection(grid, 10, -1, 0), 9);
  // The straight-line property: from the middle of the grid, down must land on
  // the cell directly below and never drift a column sideways.
  eq('grid: down from the middle stays in its column',
    pickInDirection(grid, 10, 0, 1), 17);
  // Wrapping, so the end of a row is never a dead press.
  eq('grid: right at the end of a row wraps to its start',
    pickInDirection(grid, 6, 1, 0), 0);
  eq('grid: down on the last row wraps to the top of its column',
    pickInDirection(grid, 24, 0, 1), 3);
}
{
  // The save rail: a single column of buttons of differing widths, which is
  // what the edge-to-edge cross measure exists for — centre-to-centre would
  // punish "Overwrite" for being wider than "Load".
  const rail: NavRect[] = [
    { x: 900, y: 100, w: 200, h: 28 },
    { x: 900, y: 140, w: 90, h: 24 },
    { x: 900, y: 176, w: 140, h: 24 },
    { x: 900, y: 212, w: 60, h: 24 },
  ];
  eq('rail: down steps one row', pickInDirection(rail, 0, 0, 1), 1);
  eq('rail: up steps back', pickInDirection(rail, 2, 0, -1), 1);
  eq('rail: down at the bottom wraps to the top', pickInDirection(rail, 3, 0, 1), 0);
  eq('rail: left with nowhere to go stays put', pickInDirection(rail, 1, -1, 0), 1);
}
{
  // A row of three buttons side by side — the arrest panel and the save row.
  const row: NavRect[] = [
    { x: 10, y: 50, w: 60, h: 22 },
    { x: 80, y: 50, w: 60, h: 22 },
    { x: 150, y: 50, w: 60, h: 22 },
  ];
  eq('row: right', pickInDirection(row, 0, 1, 0), 1);
  eq('row: left', pickInDirection(row, 2, -1, 0), 1);
  eq('row: right at the end wraps', pickInDirection(row, 2, 1, 0), 0);
  eq('row: left at the start wraps', pickInDirection(row, 0, -1, 0), 2);
}
{
  eq('empty candidate list is not a crash', pickInDirection([], 0, 1, 0), -1);
  eq('a single control has nowhere to go',
    pickInDirection([{ x: 0, y: 0, w: 10, h: 10 }], 0, 0, 1), 0);
  eq('an out-of-range index falls back to the first',
    pickInDirection([{ x: 0, y: 0, w: 10, h: 10 }], 9, 0, 1), 0);
}

// ─── Release safety ──────────────────────────────────────────────────────────

{
  // A release build never publishes `__gameDebug` (release-flags.ts), so an
  // input layer that reached for it would navigate in dev and be dead on
  // Steam — the worst shape a bug can take, because every harness would stay
  // green. Static, not behavioural, on purpose: this has to hold for code
  // paths no test happens to walk.
  const files = ['../src/game/input/gamepad.ts', '../src/game/input/ui-focus.ts'];
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    // Strip comments first — the modules are allowed to TALK about the hook.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok(`${f.split('/').pop()} never reads __gameDebug`, !code.includes('__gameDebug'));
  }
}

// ─── Report ──────────────────────────────────────────────────────────────────

process.stdout.write(`\ntest-gamepad: ${pass} passed, ${fail} failed\n`);
if (fail === 0) {
  process.stdout.write(
    'Mapping verified without hardware. The Steam-Input question (PORTING §2.5)\n'
    + 'still needs a physical pad: node scripts/gamepad-probe.mjs\n');
}
process.exit(fail === 0 ? 0 : 1);
