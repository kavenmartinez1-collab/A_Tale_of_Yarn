/**
 * controller-ui-check.mjs — can a controller actually drive the UI?
 *
 *   npx vite            # dev server on :5173
 *   node scripts/controller-ui-check.mjs [baseUrl] [outDir]
 *
 * THE BUG THIS EXISTS FOR. The pad was detected, `standard` mapping, gameplay
 * worked — and no panel could be navigated. Not one. The pause menu, the save
 * rail, the inventory, the hotbar, crafting: all mouse-only DOM. "Controller
 * support" was true of the character and false of the game.
 *
 * WHY A FAKE PAD IS A HONEST HARNESS HERE. Playwright cannot inject a real
 * gamepad, and Chrome exposes no debug protocol for one. But the layer under
 * test does exactly one thing with hardware: it calls
 * `navigator.getGamepads()` and reads axes and buttons. Overriding that
 * function with a scripted state object exercises every line of the mapping,
 * the repeat timer, the focus picker and every panel's real click handler. The
 * ONE thing it cannot answer is whether the browser Gamepad API is alive under
 * Steam Input on Chromium 150 (PORTING §2.5) — no software test can, that is
 * `scripts/gamepad-probe.mjs` on real hardware, and the 5-minute pad script in
 * the report covers the rest.
 *
 * Every beat is judged by reading GAME STATE back, never by "the button
 * existed". Pressing A on Save is not a passing save; the slot's contents
 * changing is.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const OUT = process.argv[3] ?? 'scripts/shots/controller-ui';
fs.mkdirSync(OUT, { recursive: true });

const findings = [];
const log = (s) => process.stdout.write(`${s}\n`);
const note = (severity, title, detail) => {
  findings.push({ severity, title, detail });
  log(`  ${severity === 'BUG' ? 'BUG ' : severity === 'skip' ? 'skip' : 'ok  '} ${title}`);
  if (detail) log(`       ${detail}`);
};
const say = (cond, title, detail) => note(cond ? 'ok' : 'BUG', title, detail);
const section = (n) => log(`\n${'─'.repeat(76)}\n${n}\n${'─'.repeat(76)}`);

// Standard-mapping indices, mirrored from src/game/input/gamepad.ts.
const B = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7,
  BACK: 8, START: 9, L3: 10, R3: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
};

// ─── The fake pad ────────────────────────────────────────────────────────────

const errors = [];
const consoleLog = [];

// A microphone permission is granted up front rather than by a fake-UI flag:
// this harness is not testing permission handling (steam-pack-check.mjs is,
// and deliberately withholds `--use-fake-ui-for-media-stream` to do it).
const VOICE_DIR = path.resolve('scripts/voice_fixture');
let voiceWav = null;
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(VOICE_DIR, 'manifest.json'), 'utf8'));
  const list = Array.isArray(manifest) ? manifest : (manifest.utterances ?? manifest.items ?? []);
  const pick = list.find((u) => /greenholm/i.test(u.text ?? '')) ?? list[0];
  if (pick && pick.file) voiceWav = path.join(VOICE_DIR, pick.file);
  if (voiceWav && !fs.existsSync(voiceWav)) voiceWav = null;
} catch { voiceWav = null; }

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--enable-unsafe-webgpu', '--use-angle=d3d11',
    '--use-fake-device-for-media-stream',
    ...(voiceWav ? [`--use-file-for-fake-audio-capture=${voiceWav}`] : []),
  ],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  permissions: ['microphone'],
});
const page = await context.newPage();
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 180)}`));
page.on('console', (m) => {
  const t = m.text();
  consoleLog.push(t);
  if (m.type() === 'error' && !t.includes('Failed to load resource')) {
    errors.push(`CONSOLE ${t.slice(0, 160)}`);
  }
});

/**
 * The pad itself, plus a stand-in for the Steam bridge.
 *
 * The bridge stub is how the on-screen-keyboard beat gets evidence: outside
 * Electron `window.steamBridge` is simply absent, so the game's OSK call has
 * nothing to land on and logs instead. Recording the call here proves the real
 * code path — `ui-focus.ts` → `steamBridge.showFloatingKeyboard(rect)` — is
 * the one that runs, which a console-line assertion alone could not.
 */
await page.addInitScript(() => {
  const state = {
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
  window.__pad = state;
  const read = () => [{
    id: 'Fake Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)',
    index: 0,
    connected: true,
    mapping: 'standard',
    timestamp: performance.now(),
    axes: state.axes.slice(),
    buttons: state.buttons.map((b) => ({
      pressed: b.pressed, touched: b.touched, value: b.value,
    })),
    vibrationActuator: null,
    hapticActuators: [],
  }];
  try {
    Object.defineProperty(navigator, 'getGamepads', { value: read, configurable: true });
  } catch {
    navigator.getGamepads = read;
  }

  window.__oskCalls = [];
  window.steamBridge = {
    isSteamWrapper: false,
    showFloatingKeyboard: (rect) => {
      window.__oskCalls.push(rect);
      return Promise.resolve(true);
    },
  };
});

// Cut vite's HMR socket before anything loads. Other agents work in this repo
// while harnesses run, and every file they save makes vite push a full-page
// reload — which restarts the world in the middle of a beat and turns an
// assertion into a reading of a fresh spawn.
await page.routeWebSocket(/:5173\//, () => { /* swallow HMR */ });

await page.goto(`${BASE}/game.html?director=off&tod=0.45&weather=clear&wipe=1`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 90_000 });
await page.waitForTimeout(2000);

// Reload detection. A reload wipes the boot counter, and every beat after it
// would be measuring a fresh spawn instead of the state we set up.
await page.evaluate(() => { window.__padBoot = (window.__padBoot ?? 0) + 1; });
const bootOk = async (phase) => {
  const v = await page.evaluate(() => window.__padBoot ?? null);
  if (v !== 1) {
    log(`\n!! RUN INVALID — page reloaded during "${phase}" (boot counter ${v})`);
    await browser.close();
    process.exit(2);
  }
};
const D = async (fn, arg) => {
  const alive = await page.evaluate(() => typeof window.__gameDebug === 'object');
  if (!alive) {
    log('\n!! RUN INVALID — page reloaded mid-run (__gameDebug gone)');
    await browser.close();
    process.exit(2);
  }
  return page.evaluate(fn, arg);
};

// ─── Pad driving helpers ─────────────────────────────────────────────────────

/** Wait n animation frames, so the game's poll loop actually sees the state. */
const frames = (n) => page.evaluate((k) => new Promise((res) => {
  let i = 0;
  const step = () => { if (++i >= k) res(); else requestAnimationFrame(step); };
  requestAnimationFrame(step);
}), n);

const setPad = (patch) => page.evaluate((p) => {
  if (p.axes) window.__pad.axes = p.axes.slice();
  for (const i of p.down ?? []) {
    window.__pad.buttons[i].pressed = true;
    window.__pad.buttons[i].value = 1;
  }
  for (const i of p.up ?? []) {
    window.__pad.buttons[i].pressed = false;
    window.__pad.buttons[i].value = 0;
  }
}, patch);

const relax = () => page.evaluate(() => {
  window.__pad.axes = [0, 0, 0, 0];
  for (const b of window.__pad.buttons) { b.pressed = false; b.value = 0; }
});

/**
 * One press. Four frames down, four up.
 *
 * Short on purpose: the nav repeat delay is 0.34 s (~20 frames at 60 Hz), so a
 * four-frame press is guaranteed to be exactly ONE step. A harness that held
 * for a quarter second would have been measuring the repeat rate by accident
 * and every "moved one row" assertion would have been a coin toss.
 */
const tap = async (i) => {
  await setPad({ down: [i] });
  await frames(4);
  await setPad({ up: [i] });
  await frames(4);
};

const hold = async (i, f) => {
  await setPad({ down: [i] });
  await frames(f);
  await setPad({ up: [i] });
  await frames(4);
};

const stick = async (x, y, f) => {
  await setPad({ axes: [x, y, 0, 0] });
  await frames(f);
  await setPad({ axes: [0, 0, 0, 0] });
  await frames(3);
};

const focus = () => D(() => window.__gameDebug.padFocus());

/** Tap `dir` until the focus label/id matches, up to `max` presses. */
const focusUntil = async (dir, match, max = 24) => {
  const seen = [];
  for (let i = 0; i < max; i++) {
    const f = await focus();
    seen.push(f.label || f.id);
    if (match(f)) return { hit: true, f, steps: i, seen };
    await tap(dir);
  }
  const f = await focus();
  seen.push(f.label || f.id);
  return { hit: match(f), f, steps: max, seen };
};

/**
 * Two-dimensional seek: down a row at a time, scanning right across each.
 *
 * The save rail turned out NOT to be the plain vertical list it looks like —
 * Save/Load/Delete sit side by side in a flex row, so "down" steps a whole
 * slot and only "right" reaches Load and Delete. Which is exactly right for
 * the player and exactly wrong for a harness that only presses down; this
 * helper is what a person does with the pad in their hands.
 */
const seek = async (match, rows = 8, cols = 4) => {
  const seen = [];
  for (let r = 0; r <= rows; r++) {
    const rowStart = (await focus()).index;
    for (let c = 0; c <= cols; c++) {
      const f = await focus();
      const tag = f.label || f.id;
      if (seen[seen.length - 1] !== tag) seen.push(tag);
      if (match(f)) return { hit: true, f, seen };
      await tap(B.RIGHT);
      const nf = await focus();
      // Rows WRAP by design, so "did the index come back to where the row
      // started" is the end-of-row test, not "did it stop moving".
      if (nf.index === rowStart || nf.index === f.index) break;
    }
    for (let c = 0; c <= cols + 1; c++) {
      if ((await focus()).index === rowStart) break;
      await tap(B.LEFT);
    }
    await tap(B.DOWN);
  }
  const f = await focus();
  return { hit: match(f), f, seen };
};

const shot = async (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

/**
 * Put the game back in gameplay between sections.
 *
 * Deliberately a KEYBOARD Escape, not a pad press: if a pad binding is what
 * broke, using it to clean up would carry the breakage into the next section
 * and report six failures for one bug. The first run of this harness did
 * exactly that — X failed to close crafting, and the panel stayed up through
 * the chat and arrest sections, which then failed for a reason that had
 * nothing to do with them.
 */
const reset = async () => {
  // Top the player up first. Hunger, thirst and cold run while a panel is
  // open (only the pause screen stops the world), and the voice beat waits up
  // to 30 s with the chat panel up — long enough that the first run of this
  // harness starved to death inside the conversation and reported four
  // unrelated failures in the section after it.
  await D(() => { window.__gameDebug.healPlayer?.(); });
  for (let i = 0; i < 4; i++) {
    if ((await focus()).context === null) break;
    await page.evaluate(() => window.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Escape', bubbles: true })));
    await frames(8);
  }
  await relax();
  await frames(4);
};

// ═════════════════════════════════════════════════════════════════════════════
section('0. The pad is seen, and it is a standard-mapping pad');
// ═════════════════════════════════════════════════════════════════════════════

await frames(6);
const padSeen = await page.evaluate(() => {
  const p = navigator.getGamepads()[0];
  return p === null ? null : { mapping: p.mapping, axes: p.axes.length, buttons: p.buttons.length };
});
say(padSeen !== null && padSeen.mapping === 'standard',
  'fake pad reports standard mapping', JSON.stringify(padSeen));
const idle = await focus();
say(idle.context === null, 'in gameplay the focus layer is dormant',
  `context=${JSON.stringify(idle.context)}`);

// ═════════════════════════════════════════════════════════════════════════════
section('1. Gameplay is unchanged, except the d-pad');
// ═════════════════════════════════════════════════════════════════════════════

await D(() => { window.__gameDebug.healPlayer(); });
await frames(10);

// The control: the left stick must still walk, or every "did not move"
// assertion below would pass on a harness whose pad was not plugged in at all.
{
  const before = await D(() => window.__gameDebug.playerPos());
  await stick(0, -1, 45);
  const after = await D(() => window.__gameDebug.playerPos());
  const moved = Math.hypot(after[0] - before[0], after[2] - before[2]);
  say(moved > 0.5, 'left stick still walks (the harness really is driving)',
    `moved ${moved.toFixed(2)} m`);
}
{
  const before = await D(() => window.__gameDebug.playerPos());
  for (const b of [B.UP, B.DOWN, B.LEFT, B.RIGHT]) await hold(b, 22);
  const after = await D(() => window.__gameDebug.playerPos());
  const moved = Math.hypot(after[0] - before[0], after[2] - before[2]);
  say(moved < 0.5, 'the d-pad no longer mirrors WASD',
    `all four directions held: player moved ${moved.toFixed(3)} m`);
}
{
  const n = await D(() => window.__gameDebug.inventory().hotbar.length);
  const start = await D(() => window.__gameDebug.inventory().selected);
  await tap(B.RIGHT);
  const right = await D(() => window.__gameDebug.inventory().selected);
  say(right === (start + 1) % n, 'd-pad right advances the active hotbar slot',
    `selected ${start} → ${right}`);
  await tap(B.LEFT);
  const back = await D(() => window.__gameDebug.inventory().selected);
  say(back === start, 'd-pad left steps it back', `selected ${right} → ${back}`);
  // Wrap, because a hotbar you can only walk one way along is a bug report.
  for (let i = 0; i < n; i++) await tap(B.RIGHT);
  const wrapped = await D(() => window.__gameDebug.inventory().selected);
  say(wrapped === start, 'a full lap of the hotbar returns to where it started',
    `after ${n} presses: ${wrapped}`);
}
{
  // B still jumps. Measured on the player's height, which is the only thing
  // that proves the synthetic Space reached PlayerController.
  await D(() => { window.__gameDebug.healPlayer(); });
  await frames(30);
  const y0 = (await D(() => window.__gameDebug.playerPos()))[1];
  await setPad({ down: [B.B] });
  await frames(10);
  const y1 = (await D(() => window.__gameDebug.playerPos()))[1];
  await setPad({ up: [B.B] });
  await frames(30);
  say(y1 - y0 > 0.2, 'B still jumps in gameplay',
    `height ${y0.toFixed(2)} → ${y1.toFixed(2)} m`);
}
await bootOk('gameplay');

// ═════════════════════════════════════════════════════════════════════════════
section('2. The pause menu and the save rail');
// ═════════════════════════════════════════════════════════════════════════════

await tap(B.START);
await frames(10);
{
  const open = await page.evaluate(() => document.getElementById('pause-screen') !== null);
  const f = await focus();
  say(open, 'Start opens the pause screen');
  say(f.context === 'pause', 'the pad switches to panel context', `context=${f.context}`);
  say(/Resume/.test(f.label), 'the ring lands on Resume, not on the chart',
    `label=${JSON.stringify(f.label)} of ${f.count} controls`);
  await shot('01-pause-focus-resume');
}
{
  // Every enabled control must be reachable and every disabled one skipped.
  const dom = await page.evaluate(() => {
    const root = document.getElementById('pause-screen');
    const all = [...root.querySelectorAll('button, input[type="text"], .pad-focusable')];
    return {
      total: all.length,
      enabled: all.filter((e) => !e.disabled).length,
      disabled: all.filter((e) => e.disabled).map((e) => e.textContent.trim()),
    };
  });
  const f = await focus();
  say(f.count === dom.enabled, 'the candidate list is exactly the enabled controls',
    `focus sees ${f.count}, DOM has ${dom.enabled} enabled / ${dom.total} total`);
}
const beforeSave = await page.evaluate(() => [...document
  .querySelectorAll('#game-menu-panel .panel-row')].map((r) => r.textContent.trim().slice(0, 60)));
{
  const r = await focusUntil(B.DOWN, (f) => /^Save$/.test(f.label));
  say(r.hit, 'd-pad down reaches an empty slot\'s Save button',
    `${r.steps} presses, path: ${r.seen.join(' → ')}`);
  await shot('02-pause-focus-save');
  await tap(B.A);
  await frames(20);
}
{
  const closed = await page.evaluate(() => document.getElementById('pause-screen') === null);
  say(closed, 'A on Save fires the real handler (which closes the menu)');
  await tap(B.START);
  await frames(12);
  const afterSave = await page.evaluate(() => [...document
    .querySelectorAll('#game-menu-panel .panel-row')].map((r) => r.textContent.trim().slice(0, 60)));
  const changed = afterSave.filter((t, i) => t !== beforeSave[i]);
  say(changed.length > 0, 'the slot\'s contents actually changed',
    changed.length ? `now: ${changed[0]}` : `unchanged: ${afterSave.join(' | ')}`);
}
{
  // Save to a SECOND slot, so slot 1 has content and is no longer active —
  // which is the only configuration in which the two-step delete is reachable
  // AND an active-slot Delete exists to be skipped.
  const r = await focusUntil(B.DOWN, (f) => /^Save$/.test(f.label));
  if (r.hit) { await tap(B.A); await frames(20); await tap(B.START); await frames(12); }
  const dom = await page.evaluate(() => {
    const root = document.getElementById('pause-screen');
    const all = [...root.querySelectorAll('button')];
    return {
      deletes: all.filter((e) => /^Delete/.test(e.textContent)).length,
      disabledDeletes: all.filter((e) => /^Delete/.test(e.textContent) && e.disabled).length,
      enabled: all.filter((e) => !e.disabled).length + 1, // + the chart canvas
    };
  });
  const f = await focus();
  say(dom.disabledDeletes === 1,
    'the slot being played has a disabled Delete', `${dom.disabledDeletes} disabled of ${dom.deletes}`);
  say(f.count === dom.enabled,
    '…and the focus ring skips it rather than trapping on it',
    `focus sees ${f.count} controls, ${dom.enabled} are enabled`);
}
{
  const r = await seek((f) => /^Delete$/.test(f.label));
  say(r.hit, 'the ring reaches an enabled Delete',
    `path: ${r.seen.join(' → ')}`);
  if (r.hit) {
    await tap(B.A);
    await frames(12);
    const armed = await focus();
    say(/Click again/.test(armed.label),
      'A arms the two-step confirm, and the ring SURVIVES the row rebuild',
      `label=${JSON.stringify(armed.label)}`);
    await shot('03-pause-delete-armed');
    const before = await page.evaluate(() =>
      document.getElementById('game-menu-panel')?.textContent ?? '');
    await tap(B.A);
    await frames(14);
    const after = await page.evaluate(() =>
      document.getElementById('game-menu-panel')?.textContent ?? '');
    const n = (s) => (s.match(/Empty/g) ?? []).length;
    say(n(after) > n(before), 'the second A actually deletes the save',
      `"Empty" slots ${n(before)} → ${n(after)}`);
  }
}
await bootOk('save rail');

// ═════════════════════════════════════════════════════════════════════════════
section('3. The chart: stick pans, triggers zoom, A finds you');
// ═════════════════════════════════════════════════════════════════════════════

{
  const r = await focusUntil(B.LEFT, (f) => f.id.includes('pad-focusable'), 6);
  say(r.hit, 'd-pad left puts the ring on the chart itself',
    `id=${r.f.id}, ${r.steps} presses`);
  await shot('04-map-focused');
}
{
  const z0 = (await D(() => window.__gameDebug.mapView())).mPerPx;
  await tap(B.RT);
  await frames(8);
  const z1 = (await D(() => window.__gameDebug.mapView())).mPerPx;
  say(z1 < z0, 'right trigger zooms the chart in', `${z0} → ${z1} m/px`);
  await tap(B.LT);
  await frames(8);
  const z2 = (await D(() => window.__gameDebug.mapView())).mPerPx;
  say(z2 > z1, 'left trigger zooms it back out', `${z1} → ${z2} m/px`);
}
{
  // Zoom all the way in BEFORE testing the pan, because at the default zoom
  // the viewport is wider than everything this fresh save has discovered and
  // map-view.ts's clamp pins the centre — the first version of this beat read
  // "cx -352.0 → -352.0" and would have filed a working pan as a dead stick.
  for (let i = 0; i < 5; i++) { await tap(B.RT); }
  await frames(10);
  const v0 = await D(() => window.__gameDebug.mapView());
  await stick(0.95, 0, 16);
  const v1 = await D(() => window.__gameDebug.mapView());
  say(v1 !== null && v0 !== null && v1.cx > v0.cx + 1,
    'left stick pans the chart east',
    `cx ${v0?.cx.toFixed(1)} → ${v1?.cx.toFixed(1)} m at ${v0?.mPerPx} m/px`);
  await stick(0, -0.95, 16);
  const v2 = await D(() => window.__gameDebug.mapView());
  say(v2 !== null && v2.cz < v1.cz - 1,
    'left stick pans the chart north', `cz ${v1?.cz.toFixed(1)} → ${v2?.cz.toFixed(1)} m`);
}
{
  await stick(0.95, 0.95, 24);
  const pos = await D(() => window.__gameDebug.playerPos());
  const off = await D(() => window.__gameDebug.mapView());
  await tap(B.A);
  await frames(10);
  const home = await D(() => window.__gameDebug.mapView());
  const d = Math.hypot(home.cx - pos[0], home.cz - pos[2]);
  say(d < 1, 'A on the chart centres it on the player',
    `off by ${Math.hypot(off.cx - pos[0], off.cz - pos[2]).toFixed(0)} m → ${d.toFixed(2)} m`);
  await shot('05-map-recentred');
}
{
  // …and the rail's own button does the same thing, because a player who
  // never thinks to press A on a map still has to be able to find themselves.
  await stick(0.95, 0, 20);
  await tap(B.RIGHT); // off the chart, back into the rail
  const r = await seek((f) => /Centre on me/.test(f.label), 4, 3);
  say(r.hit, 'the "Centre on me" button is reachable', `path: ${r.seen.join(' → ')}`);
  if (r.hit) {
    const pos = await D(() => window.__gameDebug.playerPos());
    await tap(B.A);
    await frames(10);
    const v = await D(() => window.__gameDebug.mapView());
    say(Math.hypot(v.cx - pos[0], v.cz - pos[2]) < 1, '…and pressing it works',
      `centre is ${Math.hypot(v.cx - pos[0], v.cz - pos[2]).toFixed(2)} m from the player`);
  }
}
{
  await tap(B.B);
  await frames(12);
  const gone = await page.evaluate(() => document.getElementById('pause-screen') === null);
  say(gone, 'B closes the pause screen');
  const f = await focus();
  say(f.context === null, '…and the pad goes back to playing the game');
}
await bootOk('chart');

// ═════════════════════════════════════════════════════════════════════════════
section('4. The inventory: open it, move an item, drop one, close it');
// ═════════════════════════════════════════════════════════════════════════════

await reset();
await D(() => {
  window.__gameDebug.giveItem('logs', 5);
  window.__gameDebug.giveItem('stone', 3);
});
await frames(6);
await tap(B.Y);
await frames(12);
{
  const open = await page.evaluate(() => document.getElementById('inventory-panel') !== null);
  const f = await focus();
  say(open, 'Y opens the inventory (a pad could not do this at all before)');
  say(f.context === 'inventory', 'the pad is in the inventory context', `context=${f.context}`);
  await shot('06-inventory-focus');
}
// Two occupied slots, in different rows, holding different items — the move
// under test is a SWAP, which is unambiguous and always available. (An
// "into an empty slot" test looked simpler until the starting kit turned out
// to fill 26 of 28 pack slots and both remaining ones sat in the same row,
// leaving nothing for the vertical leg of the navigation to prove.)
const layout = await D(() => {
  const inv = window.__gameDebug.inventory();
  const src = inv.pack.findIndex((s) => s !== null);
  let dst = -1;
  for (let i = inv.pack.length - 1; i > src + 7; i--) {
    if (inv.pack[i] !== null && inv.pack[i].id !== inv.pack[src].id) { dst = i; break; }
  }
  return {
    src, dst,
    srcId: src >= 0 ? inv.pack[src].id : null,
    dstId: dst >= 0 ? inv.pack[dst].id : null,
  };
});
say(layout.src >= 0 && layout.dst >= 0, 'the pack holds two stacks to swap',
  `pack[${layout.src}]=${layout.srcId} ↔ pack[${layout.dst}]=${layout.dstId}`);
if (layout.src >= 0 && layout.dst >= 0) {
  // Candidate order is DOM order: 28 pack slots, then 5 hotbar, then armor,
  // then Drop — so the focus index IS the pack index inside the grid, which is
  // what makes this navigable by assertion rather than by guesswork.
  for (let i = 0; i < Math.floor(layout.src / 7); i++) await tap(B.DOWN);
  for (let i = 0; i < layout.src % 7; i++) await tap(B.RIGHT);
  const at = await focus();
  say(at.index === layout.src, 'the grid walks in straight lines to the target slot',
    `focus index ${at.index}, wanted ${layout.src}`);

  await tap(B.A);
  await frames(8);
  const picked = await page.evaluate((i) => {
    const el = document.querySelector(`#inventory-panel [data-area="pack"][data-index="${i}"]`);
    return el !== null && el.classList.contains('src');
  }, layout.src);
  say(picked, 'A picks the stack up (the panel\'s own two-click move)',
    `slot ${layout.src} shows the picked-up marker`);

  const dRow = Math.floor(layout.dst / 7) - Math.floor(layout.src / 7);
  const dCol = (layout.dst % 7) - (layout.src % 7);
  for (let i = 0; i < dRow; i++) await tap(B.DOWN);
  for (let i = 0; i < Math.abs(dCol); i++) await tap(dCol > 0 ? B.RIGHT : B.LEFT);
  const dstAt = await focus();
  say(dstAt.index === layout.dst, 'down and across walks the grid to the target slot',
    `focus index ${dstAt.index}, wanted ${layout.dst} (${dRow} down, ${dCol} across)`);
  await tap(B.A);
  await frames(10);
  const moved = await D((arg) => {
    const inv = window.__gameDebug.inventory();
    return { from: inv.pack[arg.src]?.id ?? null, to: inv.pack[arg.dst]?.id ?? null };
  }, layout);
  say(moved.from === layout.dstId && moved.to === layout.srcId,
    'A places it — the inventory MODEL changed, not just the DOM',
    `pack[${layout.src}] ${layout.srcId}→${moved.from}, `
    + `pack[${layout.dst}] ${layout.dstId}→${moved.to}`);
  await shot('07-inventory-moved');

  // X drops one, through the same contextmenu path the mouse uses.
  const held = (arg) => D((a) => window.__gameDebug.inventory().pack[a.dst]?.count ?? 0, arg);
  const beforeDrop = await held(layout);
  await tap(B.X);
  await frames(10);
  const afterDrop = await held(layout);
  say(afterDrop === beforeDrop - 1, 'X drops one from the focused slot',
    `count ${beforeDrop} → ${afterDrop}`);
}
{
  await tap(B.B);
  await frames(10);
  const gone = await page.evaluate(() => document.getElementById('inventory-panel') === null);
  say(gone, 'B closes the inventory');
  // …and B is a jump again the moment the panel is gone.
  await D(() => { window.__gameDebug.healPlayer(); });
  await frames(30);
  const y0 = (await D(() => window.__gameDebug.playerPos()))[1];
  await setPad({ down: [B.B] });
  await frames(10);
  const y1 = (await D(() => window.__gameDebug.playerPos()))[1];
  await relax();
  await frames(24);
  say(y1 - y0 > 0.2, 'B is a jump again immediately after the panel closes',
    `height ${y0.toFixed(2)} → ${y1.toFixed(2)} m`);
}
await bootOk('inventory');

// ═════════════════════════════════════════════════════════════════════════════
section('5. Crafting, and RB for pages');
// ═════════════════════════════════════════════════════════════════════════════

await reset();
await tap(B.X);
await frames(12);
{
  const open = await page.evaluate(() => document.getElementById('crafting-panel') !== null);
  say(open, 'X opens the crafting bench in gameplay');
  const first = await page.evaluate(() =>
    document.querySelector('#crafting-panel .craft-tab.active')?.dataset.category ?? null);
  await tap(B.RB);
  await frames(10);
  const second = await page.evaluate(() =>
    document.querySelector('#crafting-panel .craft-tab.active')?.dataset.category ?? null);
  say(first !== null && second !== null && first !== second,
    'RB turns the page', `${first} → ${second}`);
  const f = await focus();
  say(/tab/.test(f.id) || f.label.length > 0,
    'the ring lands on the new tab rather than on a destroyed recipe row',
    `id=${f.id} label=${JSON.stringify(f.label)}`);
  await shot('08-crafting-tab');
  // A recipe row must be reachable from the tab bar.
  const r = await focusUntil(B.DOWN, (f) => /Craft/.test(f.label), 6);
  note(r.hit ? 'ok' : 'skip',
    r.hit ? 'a craftable recipe is reachable from the tabs'
      : 'no craftable recipe on this page to focus (disabled rows are skipped by design)',
    `path: ${r.seen.join(' → ')}`);
  // ── The tier view, and locked rows ──────────────────────────────────────
  //
  // The panel now groups each page by the rung of the progression tree a
  // recipe sits on, and draws UNDISCOVERED recipes as greyed silhouettes with
  // their requirement instead of hiding them. That last part matters to the
  // pad specifically: `ui-focus.ts` SKIPS `disabled` controls by a deliberate
  // rule, so a locked row rendered as `disabled` would be invisible to the
  // ring and the player could never read WHY it is locked. Locked rows
  // therefore carry `.locked` + `aria-disabled` and stay focusable — and must
  // never craft when A is pressed on them.
  {
    // Walk to a page that actually has a locked row. Camp holds the loom tier,
    // which nothing in the starting pack can open.
    await page.evaluate(() => {
      document.querySelector('#crafting-panel .craft-tab[data-category="camp"]')?.click();
    });
    await frames(10);

    const layout = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#crafting-panel .recipe')];
      const heads = [...document.querySelectorAll('#crafting-panel .tier-head')];
      const locked = rows.filter((r) => r.dataset.locked === '1');
      return {
        tiers: heads.map((h) => h.querySelector('span')?.textContent ?? '?'),
        counts: heads.map((h) => h.querySelector('.tier-count')?.textContent ?? '?'),
        rows: rows.length,
        locked: locked.length,
        // A locked row must say why, and its button must NOT be `disabled`.
        sample: locked[0] === undefined ? null : {
          key: locked[0].dataset.recipe,
          req: locked[0].querySelector('.r-req')?.textContent ?? '',
          btnText: locked[0].querySelector('.r-craft')?.textContent ?? '',
          btnDisabled: locked[0].querySelector('.r-craft')?.disabled ?? null,
          aria: locked[0].querySelector('.r-craft')?.getAttribute('aria-disabled'),
        },
      };
    });
    say(layout.tiers.length >= 3, 'the page is grouped into tiers of the tree',
      `${layout.tiers.join(' / ')}  counts ${layout.counts.join(' ')}`);
    say(layout.locked > 0, 'undiscovered recipes are DRAWN, not hidden',
      `${layout.locked} of ${layout.rows} rows on this page are locked`);
    say(layout.sample !== null && layout.sample.req.length > 0,
      'and each says what would unlock it',
      `${layout.sample?.key}: ${JSON.stringify(layout.sample?.req)}`);
    say(layout.sample !== null && layout.sample.btnDisabled === false
      && layout.sample.aria === 'true',
      'a locked row is aria-disabled but NOT `disabled` — so the ring can reach it',
      `btn="${layout.sample?.btnText}" disabled=${layout.sample?.btnDisabled}`
      + ` aria-disabled=${layout.sample?.aria}`
      + ' (ui-focus.ts skips `disabled`, which would make locked rows unreadable)');

    // Drive the ring onto a locked row and press A. Nothing may be crafted.
    const r = await focusUntil(B.DOWN, (f) => /Locked/.test(f.label), 30);
    say(r.hit, 'the focus ring lands on a locked recipe',
      `path: ${r.seen.slice(-6).join(' → ')}`);
    if (r.hit) {
      const before = await D(() => window.__gameDebug.progressStats());
      const invBefore = await D(() => JSON.stringify(window.__gameDebug.inventory()));
      await tap(B.A);
      await frames(14);
      const after = await D(() => window.__gameDebug.progressStats());
      const invAfter = await D(() => JSON.stringify(window.__gameDebug.inventory()));
      say(after.crafted === before.crafted && invBefore === invAfter,
        'and A on it crafts NOTHING — it reads as locked and stays locked',
        `crafted ${before.crafted} → ${after.crafted}, inventory unchanged=`
        + `${invBefore === invAfter}`);
      say(await page.evaluate(() => document.getElementById('crafting-panel') !== null),
        'and the panel is still open (a dead press, not a dismissal)');
    }
    await shot('08b-crafting-tiers-locked');
  }

  await tap(B.X);
  await frames(10);
  const closed = await page.evaluate(() => document.getElementById('crafting-panel') === null);
  say(closed, 'X closes it again (the toggle a pad player expects)');
}
{
  // The last two panels that had no pad route at all.
  await tap(B.R3);
  await frames(12);
  const ch = await focus();
  say(ch.context === 'character', 'R3 opens the character sheet',
    `context=${ch.context}, ring on ${JSON.stringify(ch.id)}`);
  const r = await seek((f) => /Female|Male/.test(f.label), 3, 3);
  say(r.hit, 'its body/colour choices are reachable', `path: ${r.seen.join(' → ')}`);
  await tap(B.R3);
  await frames(10);
  say(await page.evaluate(() => document.getElementById('character-panel') === null),
    'R3 closes it again');

  await tap(B.BACK);
  await frames(12);
  const help = await page.evaluate(() => {
    const el = document.getElementById('help-panel');
    return el === null ? null : { pad: /Controller/.test(el.textContent) };
  });
  say(help !== null, 'Back opens the controls panel');
  say(help !== null && help.pad, '…and it lists the controller bindings, '
    + 'so the pad-only bindings are discoverable from the pad');
  await shot('14-help-controller');
  await tap(B.BACK);
  await frames(10);
  say(await page.evaluate(() => document.getElementById('help-panel') === null),
    'Back closes it again');
}
await bootOk('crafting');

// ═════════════════════════════════════════════════════════════════════════════
section('6. The chat panel, the on-screen keyboard, and the voice seam');
// ═════════════════════════════════════════════════════════════════════════════

await reset();
let chatOpened = false;
{
  let prompt = null;
  for (let i = 0; i < 14 && prompt === null; i++) {
    await D(() => window.__gameDebug.teleportToNearestNpc());
    if (i >= 5) {
      await D(() => {
        const n = window.__gameDebug.nearestNpc?.();
        if (n && n.id && window.__gameDebug.enterNpcHome?.(n.id)) {
          window.__gameDebug.buildingTeleportToBed?.();
          window.__gameDebug.healPlayer?.();
        }
      });
    }
    await page.waitForTimeout(600);
    const p = await D(() => window.__gameDebug.interactPrompt?.() ?? null);
    if (typeof p === 'string' && /talk to/i.test(p)) prompt = p;
  }
  say(prompt !== null, 'walked up to an NPC', prompt ?? 'no talk prompt appeared');

  // Opened with the PAD's A, not a synthetic key — the point is that A still
  // runs the whole KeyE interact chain when no panel is up.
  for (let i = 0; i < 6 && !chatOpened; i++) {
    await tap(B.A);
    try {
      await page.waitForFunction(() => window.__gameDebug.chatOpen() === true,
        undefined, { timeout: 6000 });
      chatOpened = true;
    } catch { /* try again */ }
  }
  say(chatOpened, 'pad A opens the conversation (the KeyE chain still runs)');
}
if (chatOpened) {
  await frames(10);
  const f = await focus();
  say(f.context === 'npc-chat' && f.id === 'npc-chat-input',
    'the ring starts on the chat input', `context=${f.context}, id=${f.id}`);
  await shot('09-chat-focus-input');

  const oskBefore = await page.evaluate(() => window.__oskCalls.length);
  await tap(B.A);
  await frames(8);
  const oskAfter = await page.evaluate(() => window.__oskCalls);
  const snap = await focus();
  say(oskAfter.length === oskBefore + 1,
    'A on the input calls steamBridge.showFloatingKeyboard',
    `calls=${oskAfter.length}, rect=${JSON.stringify(oskAfter[oskAfter.length - 1] ?? null)}`);
  say(snap.osk >= 1, '…and the game counts the attempt', `padFocus().osk=${snap.osk}`);
  const typed = await page.evaluate(() =>
    document.getElementById('npc-chat-input')?.value ?? '');
  say(typed === '', 'the synthesised KeyE did NOT leak into the box as a letter',
    `input value=${JSON.stringify(typed)}`);

  // The voice-confirm seam, asserted deterministically. voice-input.ts claims
  // the pad's A by calling preventDefault on the synthetic KeyE; the focus
  // layer only activates when NOBODY claimed it. This stands a claimant in
  // voice's place, so the fall-through is proven whether or not the speech
  // model is present on this machine.
  await page.evaluate(() => {
    window.__claimed = 0;
    window.__claim = (e) => {
      if (e.code === 'KeyE') { window.__claimed++; e.preventDefault(); }
    };
    window.addEventListener('keydown', window.__claim, true);
  });
  const oskPre = await page.evaluate(() => window.__oskCalls.length);
  await tap(B.A);
  await frames(8);
  const claim = await page.evaluate(() => ({
    claimed: window.__claimed, osk: window.__oskCalls.length,
  }));
  say(claim.claimed === 1 && claim.osk === oskPre,
    'when voice claims the pad\'s A, the focus layer stands down',
    `KeyE claimed ${claim.claimed}×, OSK calls unchanged at ${claim.osk}`);
  await page.evaluate(() => window.removeEventListener('keydown', window.__claim, true));

  // Push-to-talk. LB must survive the context switch — the chat panel is the
  // one place it matters most, and a context switch that swallowed it would
  // have killed voice input silently.
  const vBefore = await D(() => window.__gameDebug.voiceDebug?.() ?? null);
  await setPad({ down: [B.LB] });
  await page.waitForTimeout(1400);
  const vDuring = await D(() => window.__gameDebug.voiceDebug?.() ?? null);
  await setPad({ up: [B.LB] });
  say(vDuring !== null && vDuring.state !== 'idle' && vDuring.state !== (vBefore?.state ?? 'idle'),
    'LB still opens the microphone from inside the panel',
    `state ${JSON.stringify(vBefore?.state)} → ${JSON.stringify(vDuring?.state)}`);

  // Best-effort: the whole speak-then-confirm path, if a fixture and the
  // speech model are available on this machine.
  let filled = '';
  if (voiceWav) {
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(500);
      // Vitals keep ticking behind an open panel; without this the wait
      // itself kills the player and the beat after it measures a corpse.
      if (i % 6 === 0) await D(() => { window.__gameDebug.healPlayer?.(); });
      filled = await page.evaluate(() =>
        document.getElementById('npc-chat-input')?.value ?? '');
      if (filled.trim().length > 0) break;
    }
  }
  if (filled.trim().length > 0) {
    const msgs = () => page.evaluate(() =>
      document.querySelectorAll('#npc-chat-history .msg.user').length);
    const before = await msgs();
    await tap(B.A);
    await frames(20);
    const after = await msgs();
    say(after === before + 1, 'pad A sends the spoken transcript',
      `transcript=${JSON.stringify(filled.slice(0, 60))}, user messages ${before} → ${after}`);
  } else {
    const why = consoleLog.find((l) => /hf-cache|tokenizer|whisper/i.test(l)) ?? '';
    note('skip', 'the full speak-and-send path was not exercised here',
      voiceWav
        ? 'the microphone opened and recorded, but Whisper could not load: the '
          + 'dev server does not serve /api/hf-cache — only the packed depot\'s '
          + 'loopback server does. `npm run check:steam` drives that leg end to '
          + 'end against the depot (push-to-talk → transcript → held for '
          + `confirmation). ${why.slice(0, 90)}`
        : 'no scripts/voice_fixture — run `npm run voice:fixture` first.');
  }
  await shot('10-chat-voice');
  await tap(B.B);
  await frames(12);
  const gone = await D(() => window.__gameDebug.chatOpen() === false);
  say(gone, 'B closes the conversation');
}
await bootOk('chat');

// ═════════════════════════════════════════════════════════════════════════════
section('7. The overlays a player cannot afford to be stuck behind');
// ═════════════════════════════════════════════════════════════════════════════

await reset();
{
  await D(() => {
    window.__gameDebug.addBounty(400);
    window.__gameDebug.openArrestPanel();
  });
  await frames(14);
  const f = await focus();
  say(f.context === 'arrest', 'the arrest panel takes the pad', `context=${f.context}`);
  const reach = await focusUntil(B.DOWN, (x) => /Resist/.test(x.label), 6);
  say(reach.hit, 'every arrest choice is reachable', `path: ${reach.seen.join(' → ')}`);
  await shot('11-arrest-focus');
  await tap(B.B);
  await frames(12);
  const closed = await D(() => window.__gameDebug.padFocus().context === null);
  say(closed, 'B backs out of the arrest panel');
  // The latch that used to make this a one-shot panel forever.
  await D(() => window.__gameDebug.openArrestPanel());
  await frames(14);
  const again = await page.evaluate(() => document.getElementById('arrest-panel') !== null);
  say(again, 'and it can be opened again afterwards (the re-entry latch is cleared)');
  await tap(B.B);
  await frames(10);
}
{
  await D(() => { window.__gameDebug.setVitals({ hp: 0, alive: false }); });
  await page.waitForTimeout(1200);
  const shown = await page.evaluate(() =>
    getComputedStyle(document.getElementById('death-overlay')).display !== 'none');
  const f = await focus();
  say(shown, 'the death card is up');
  say(f.context === 'death' && f.id === 'respawn-btn',
    'the pad takes the death card, ring on Respawn', `context=${f.context}, id=${f.id}`);
  await shot('12-death-focus');
  // B must NOT dismiss death — the card has exactly one exit.
  await tap(B.B);
  await frames(10);
  const still = await page.evaluate(() =>
    getComputedStyle(document.getElementById('death-overlay')).display !== 'none');
  say(still, 'B does not back out of dying');
  await tap(B.A);
  await page.waitForTimeout(1200);
  const alive = await D(() => window.__gameDebug.vitals().alive);
  const hidden = await page.evaluate(() =>
    getComputedStyle(document.getElementById('death-overlay')).display === 'none');
  say(alive && hidden, 'A respawns', `alive=${alive}, overlay hidden=${hidden}`);
}
await bootOk('overlays');

// ═════════════════════════════════════════════════════════════════════════════
section('7b. Settings, Controls and Help — reachable and usable with a pad only');
// ═════════════════════════════════════════════════════════════════════════════

await reset();
{
  await tap(B.START);
  await frames(12);
  say((await focus()).context === 'pause', 'the pause screen is up');

  // ---- the three buttons exist on the rail and the pad can reach them ------
  const railBtns = await D(() => [...document.querySelectorAll('#pause-screen .rail button')]
    .map((b) => (b.textContent || '').trim().split('\n')[0].trim()));
  say(railBtns.some((t) => /^Settings/i.test(t)), 'a Settings button is on the pause rail',
    railBtns.join(' | ').slice(0, 150));
  say(railBtns.some((t) => /^Controls/i.test(t)), 'a Controls button is on the pause rail');
  say(railBtns.some((t) => /^How to play|^Help/i.test(t)), 'a Help button is on the pause rail');

  // ---- Settings opens by pad, and the world is STILL paused ---------------
  const beforeSim = await D(() => window.__gameDebug.simTime());
  const toSettings = await seek((f) => /^Settings/i.test(f.label || ''));
  say(toSettings.hit, 'the pad can reach Settings', `${toSettings.steps} steps`);
  await tap(B.A);
  await frames(14);

  const inSettings = await D(() => ({
    sheet: !!document.querySelector('#pause-screen .chart-sheet'),
    settings: !!document.getElementById('settings-sheet'),
    title: (document.querySelector('#pause-screen .chart-title') || {}).textContent || '',
    paused: window.__gameDebug.paused(),
    context: window.__gameDebug.padFocus().context,
  }));
  say(inSettings.sheet && inSettings.settings,
    'Settings opened inside the pause screen', JSON.stringify(inSettings).slice(0, 150));
  // The whole reason for swapping the chart body instead of opening a new
  // panel id: a settings screen reached from pause must not restart the world.
  say(inSettings.paused === true, 'the world is STILL paused behind Settings');
  say(inSettings.context === 'pause', 'the pad focus context is still `pause`');

  await frames(30);
  const simDrift = (await D(() => window.__gameDebug.simTime())) - beforeSim;
  say(simDrift === 0, 'the sim clock did not advance while Settings was open',
    `drift ${simDrift}`);

  // ---- a setting APPLIES LIVE ---------------------------------------------
  const KEYS = ['volMaster', 'volMusic', 'volSfx', 'volVoice', 'mouseSensitivity', 'renderScale'];
  const before = await D(() => {
    const o = window.__gameDebug.settings();
    return { volMaster: o.volMaster, volMusic: o.volMusic, volSfx: o.volSfx,
      volVoice: o.volVoice, mouseSensitivity: o.mouseSensitivity, renderScale: o.renderScale };
  });
  // Walk the ring onto a stepper rather than clicking it directly — the claim
  // is that a PAD can change a setting, so the pad has to be what changes it.
  const bump = await seek((f) => {
    const t = (f.label || '').trim();
    return t === '−' || t === '+';
  }, 12, 6);
  say(bump.hit, 'the pad can land on a volume stepper', `${bump.steps} steps`);
  await tap(B.A);
  await frames(8);
  const after0 = await D(() => {
    const o = window.__gameDebug.settings();
    return { volMaster: o.volMaster, volMusic: o.volMusic, volSfx: o.volSfx,
      volVoice: o.volVoice, mouseSensitivity: o.mouseSensitivity, renderScale: o.renderScale };
  });
  const live = await D(() => window.__gameDebug.settings());
  const stored = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('artifex-settings:v1') || 'null'); }
    catch { return null; }
  });
  const diverged = stored ? KEYS.filter((k) => Math.abs(stored[k] - live[k]) > 1e-9) : KEYS;
  // WHICH slider the ring lands on depends on the geometry of the sheet, and
  // pinning it to one would make this beat a test of the layout rather than of
  // the pad. The claim is that a pad press moves a setting; name whichever one
  // moved so a regression still says what broke.
  const moved = KEYS.filter((k) => Math.abs(before[k] - after0[k]) > 1e-9);
  say(moved.length > 0, 'pressing A on a stepper moves a value',
    moved.length ? moved.map((k) => `${k} ${before[k]} → ${after0[k]}`).join(', ')
      : `nothing moved (${JSON.stringify(before)})`);
  // The contract that matters: whatever the panel shows, storage agrees. One
  // code path writes both, so a mismatch means the panel and the save drifted.
  say(stored !== null && diverged.length === 0,
    'the live settings and the persisted settings agree',
    diverged.length ? `diverged: ${diverged.join(', ')}` : 'all numeric fields match');

  // ---- Controls and Help are reachable and have real content --------------
  await reset();
  await tap(B.START);
  await frames(12);
  const toControls = await seek((f) => /^Controls/i.test(f.label || ''));
  say(toControls.hit, 'the pad can reach Controls');
  await tap(B.A);
  await frames(14);
  const controls = await D(() => {
    const body = document.querySelector('#pause-screen .chart-body');
    const txt = body ? body.textContent || '' : '';
    // Read the key CHIPS as elements. `textContent` on the container joins
    // every node with no separator, so "…craftingLTLock on…" defeats any word
    // boundary — an earlier version of this beat reported a false failure that
    // way, which is exactly the kind of green-that-means-nothing this project
    // keeps finding.
    const leaves = [...(body ? body.querySelectorAll('*') : [])]
      .filter((e) => e.children.length === 0);
    const chips = leaves.map((e) => (e.textContent || '').trim());
    const rowFor = (key) => {
      const el = leaves.find((e) => (e.textContent || '').trim() === key);
      return el && el.parentElement ? (el.parentElement.textContent || '') : '';
    };
    const zChip = chips.find((c) => c.indexOf('Z') === 0);
    return {
      chars: txt.length,
      hasLT: chips.indexOf('LT') !== -1,
      hasL3: chips.indexOf('L3') !== -1,
      ltSaysLock: /lock on/i.test(rowFor('LT')),
      l3SaysSprint: /sprint/i.test(rowFor('L3')),
      zLock: !!zChip && /lock on/i.test(rowFor(zChip)),
      paused: window.__gameDebug.paused(),
    };
  });
  say(controls.chars > 300, 'Controls has real content', `${controls.chars} chars`);
  // The bindings that changed most recently — the panel is the only place a
  // player can learn them, so stale text here is a real defect.
  say(controls.hasLT && controls.ltSaysLock, 'Controls documents LT = lock on',
    `chip=${controls.hasLT}, row mentions lock on=${controls.ltSaysLock}`);
  say(controls.hasL3 && controls.l3SaysSprint, 'Controls documents L3 = sprint',
    `chip=${controls.hasL3}, row mentions sprint=${controls.l3SaysSprint}`);
  say(controls.zLock, 'Controls documents Z / middle-click = lock on');
  say(controls.paused === true, 'the world is still paused behind Controls');

  await reset();
  await tap(B.START);
  await frames(12);
  const toHelp = await seek((f) => /^How to play|^Help/i.test(f.label || ''));
  say(toHelp.hit, 'the pad can reach Help');
  await tap(B.A);
  await frames(14);
  const help = await D(() => {
    const body = document.querySelector('#pause-screen .chart-body');
    const txt = body ? body.textContent || '' : '';
    return {
      chars: txt.length,
      castle: /castle/i.test(txt),
      thirst: /thirst|drink/i.test(txt),
      paused: window.__gameDebug.paused(),
    };
  });
  say(help.chars > 200, 'Help has real content', `${help.chars} chars`);
  say(help.castle && help.thirst, 'Help covers escaping the castle and staying alive');
  say(help.paused === true, 'the world is still paused behind Help');

  // ---- B backs out of a sheet, not straight out of the pause screen -------
  await tap(B.B);
  await frames(14);
  const afterBack = await D(() => ({
    context: window.__gameDebug.padFocus().context,
    hasChart: !!document.querySelector('#pause-screen .chart-cloth canvas'),
  }));
  say(afterBack.context === 'pause' && afterBack.hasChart,
    'B returns to the map rather than closing the pause screen',
    JSON.stringify(afterBack));
}
await bootOk('settings/controls/help');

// ═════════════════════════════════════════════════════════════════════════════
section('7c. Settings survive a reload');
// ═════════════════════════════════════════════════════════════════════════════

{
  // Write a value that is nothing like the default, reload, and read it back
  // through the live store — not through localStorage, which would only prove
  // the write happened and not that the game applies it on boot.
  await D(() => { window.__gameDebug.settings().set({ volVoice: 0.23, voiceEnabled: false }); });
  await frames(6);
  const wrote = await D(() => window.__gameDebug.settings());
  say(wrote && Math.abs(wrote.volVoice - 0.23) < 1e-9 && wrote.voiceEnabled === false,
    'a setting can be written through the store', JSON.stringify(wrote).slice(0, 120));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 120_000 });
  await page.evaluate(() => { window.__padBoot = 1; }); // this reload is deliberate
  await frames(10);

  const after = await page.evaluate(() => window.__gameDebug.settings());
  say(after && Math.abs(after.volVoice - 0.23) < 1e-9 && after.voiceEnabled === false,
    'and it is still there after a reload', JSON.stringify(after).slice(0, 120));

  // Put it back so the rest of the run (and the next run) starts clean.
  await page.evaluate(() => { window.__gameDebug.settings().reset(); });
}

// ═════════════════════════════════════════════════════════════════════════════
section('8. The mouse must still work, and must not desync the ring');
// ═════════════════════════════════════════════════════════════════════════════

await reset();
{
  await tap(B.START);
  await frames(12);
  const before = await focus();
  const box = await page.evaluate(() => {
    const b = [...document.querySelectorAll('#pause-screen .stitch-btn')]
      .find((e) => /Centre on me/.test(e.textContent));
    if (b === undefined) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: b.textContent.trim() };
  });
  say(box !== null, 'the pause screen is up for the mouse test');
  if (box !== null) {
    await page.mouse.move(box.x, box.y);
    await frames(6);
    const after = await focus();
    say(after.label === box.label && before.label !== after.label,
      'the ring follows the mouse, so a click never lands where the ring is not',
      `${JSON.stringify(before.label)} → ${JSON.stringify(after.label)}`);
    await shot('13-hover-sync');
  }
  await tap(B.B);
  await frames(10);
}
{
  // With no pad attached the layer must be completely invisible.
  await page.evaluate(() => {
    window.__padOff = () => [];
    Object.defineProperty(navigator, 'getGamepads',
      { value: window.__padOff, configurable: true });
  });
  await frames(20);
  const off = await focus();
  const rings = await page.evaluate(() => document.querySelectorAll('.pad-focus').length);
  say(off.context === null && rings === 0,
    'unplugging the pad removes the ring entirely (mouse players see nothing)',
    `context=${off.context}, rings in DOM=${rings}`);
}

// ─── Report ──────────────────────────────────────────────────────────────────

for (const e of errors.slice(0, 8)) note('BUG', 'page error', e);
const bugs = findings.filter((f) => f.severity === 'BUG');
const skips = findings.filter((f) => f.severity === 'skip');
log(`\ncontroller-ui-check: ${bugs.length} bugs, `
  + `${findings.length - bugs.length - skips.length} ok, ${skips.length} skipped`);
log(`shots in ${OUT}`);
await browser.close();
process.exit(bugs.length === 0 ? 0 : 1);
