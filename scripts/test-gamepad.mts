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
  BUTTON, DEFAULT_CONFIG, type PadSnapshot,
} from '../src/game/input/gamepad';

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
  const dpad = mapPad(padOf([0, 0, 0, 0], [BUTTON.DPAD_LEFT]), 1 / 60).intent.heldKeys;
  setEq('d-pad mirrors the left stick', dpad, ['KeyA']);
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

// ─── Report ──────────────────────────────────────────────────────────────────

process.stdout.write(`\ntest-gamepad: ${pass} passed, ${fail} failed\n`);
if (fail === 0) {
  process.stdout.write(
    'Mapping verified without hardware. The Steam-Input question (PORTING §2.5)\n'
    + 'still needs a physical pad: node scripts/gamepad-probe.mjs\n');
}
process.exit(fail === 0 ? 0 : 1);
