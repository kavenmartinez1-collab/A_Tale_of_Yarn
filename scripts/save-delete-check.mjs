/**
 * Does deleting a save actually delete it?
 *
 *   node scripts/save-delete-check.mjs
 *
 * The unit test (`scripts/test-save-slots.mts`) proves the storage layer
 * against a shim. This drives the real pause screen and asks the question that
 * shim cannot: does a deleted save HAUNT the next new game?
 *
 * `GAME_STATE_KEYS` keeps growing — the castle opening was added recently, the
 * world map just now — and the failure mode is quiet and awful: you delete a
 * save, start fresh, and begin with a pre-explored map and an already-looted
 * starter chest. So the run plays a bit, saves, deletes, starts a genuinely
 * new game, and asserts the map is blank and the opening is back.
 *
 * It also checks the rule the user asked for: you cannot delete the save you
 * are playing, and the control for it is disabled rather than missing.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 180)}`));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !t.includes('Failed to load resource')) {
    errors.push(`CONSOLE ${t.slice(0, 160)}`);
  }
});

const findings = [];
const note = (severity, title, detail) => {
  findings.push({ severity, title, detail });
  process.stdout.write(`  ${severity === 'BUG' ? 'BUG ' : 'ok  '} ${title}\n`);
  if (detail) process.stdout.write(`       ${detail}\n`);
};

const URL = 'http://localhost:5173/game.html?director=off&tod=0.45&weather=clear';
await page.goto(`${URL}&wipe=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 60_000 });
await page.waitForTimeout(2500);

const D = async (fn, arg) => {
  const alive = await page.evaluate(() => typeof window.__gameDebug === 'object');
  if (!alive) {
    process.stdout.write('\n!! RUN INVALID — page reloaded mid-run (__gameDebug gone)\n');
    await browser.close();
    process.exit(2);
  }
  return page.evaluate(fn, arg);
};

/**
 * Open the pause screen and PROVE it is up before reading it.
 *
 * Saving closes the panel (`onSave` calls `panels.close()`), so every read
 * after a Save has to reopen first — and a read taken a beat too early comes
 * back as an empty button list, which looks exactly like "the Delete control
 * is missing". Three assertions in this file were reported as bugs in the
 * feature before it turned out they were bugs in the probe.
 */
const openMenu = async () => {
  for (let i = 0; i < 5; i++) {
    await D(() => { window.__gameDebug.setPaused(true); });
    await page.waitForTimeout(500);
    const up = await page.evaluate(
      () => document.querySelector('#pause-screen #game-menu-panel') !== null);
    if (up) return;
  }
  note('BUG', 'could not open the pause screen', 'the checks below prove nothing');
};
const closeMenu = async () => {
  await D(() => { window.__gameDebug.setPaused(false); });
  await page.waitForTimeout(500);
};
/** [{ label, disabled, title }] for every button in the slot rail. */
const slotButtons = () => page.evaluate(() => [...document.querySelectorAll(
  '#pause-screen #game-menu-panel .choice')].map((b) => ({
  label: b.textContent, disabled: b.disabled, title: b.title,
})));
const clickButton = (text) => page.evaluate((t) => {
  const b = [...document.querySelectorAll('#pause-screen #game-menu-panel .choice')]
    .find((x) => (x.textContent ?? '').startsWith(t) && !x.disabled);
  if (b === undefined) return false;
  b.click();
  return true;
}, text);

// ---------------------------------------------------------------------------
// Play a bit: explore so there is a map, and note the castle state.
// ---------------------------------------------------------------------------
for (const [x, z] of [[-200, 120], [-60, 240], [120, 300], [280, 200]]) {
  await D(([a, b]) => { window.__gameDebug.teleport(a, b); }, [x, z]);
  await page.waitForTimeout(500);
}
await page.waitForTimeout(1200);
const played = await D(() => ({
  map: window.__gameDebug.mapStats().chunks,
  castle: localStorage.getItem('artifex-castle:v1'),
}));
note(played.map > 40 ? 'ok' : 'BUG', 'played far enough to have a map',
  `${played.map} chunks charted`);

// ---------------------------------------------------------------------------
// Save into two slots, so one is active and one is deletable.
// ---------------------------------------------------------------------------
await openMenu();
await clickButton('Save');           // slot 0
await page.waitForTimeout(900);
await openMenu();
// The second row's Save is the second "Save"/"Overwrite" control (slot 0 now
// reads "Overwrite").
const savedSecond = await page.evaluate(() => {
  const all = [...document.querySelectorAll('#pause-screen #game-menu-panel .choice')];
  const saves = all.filter((b) => /^(Save|Overwrite)$/.test(b.textContent ?? ''));
  if (saves[1] === undefined) return false;
  saves[1].click();                  // slot 1
  return true;
});
await page.waitForTimeout(900);
note(savedSecond ? 'ok' : 'BUG', 'a second slot could be saved into');

await openMenu();
const state = await page.evaluate(() => ({
  active: localStorage.getItem('artifex-active-slot:v1'),
  slot0: localStorage.getItem('artifex-save:v1:0') !== null,
  slot1: localStorage.getItem('artifex-save:v1:1') !== null,
}));
note(state.slot0 && state.slot1 ? 'ok' : 'BUG', 'two slots saved',
  `slot0=${state.slot0} slot1=${state.slot1}`);
note(state.active === '1' ? 'ok' : 'BUG', 'the last save is the active slot',
  `active=${state.active}`);

// ---------------------------------------------------------------------------
// The active slot's Delete must be present, disabled and explained.
// ---------------------------------------------------------------------------
await page.screenshot({ path: 'scripts/shots/map/09-pause-menu-slots.png' });
const buttons = await slotButtons();
const deletes = buttons.filter((b) => (b.label ?? '').startsWith('Delete'));
note(deletes.length === 2 ? 'ok' : 'BUG', 'both saved slots offer Delete',
  `${deletes.length} Delete control(s): ${JSON.stringify(deletes)}`);
const disabled = deletes.filter((b) => b.disabled);
note(disabled.length === 1 ? 'ok' : 'BUG',
  'exactly one Delete is disabled — the slot being played',
  `${disabled.length} disabled; title "${disabled[0]?.title ?? ''}"`);
note((disabled[0]?.title ?? '').toLowerCase().includes('playing') ? 'ok' : 'BUG',
  'and it says why rather than just being dead',
  `title: ${JSON.stringify(disabled[0]?.title)}`);

// Clicking the disabled one must do nothing.
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#pause-screen #game-menu-panel .choice')]
    .find((x) => (x.textContent ?? '').startsWith('Delete') && x.disabled);
  b?.click();
});
await page.waitForTimeout(500);
const stillThere = await page.evaluate(
  () => localStorage.getItem('artifex-save:v1:1') !== null);
note(stillThere ? 'ok' : 'BUG', 'clicking the disabled Delete does nothing');

// And the storage layer refuses it even if the UI is bypassed.
const refused = await page.evaluate(() => {
  const before = localStorage.getItem('artifex-save:v1:1');
  // Simulate a UI bypass by driving the same code path the button would.
  const btns = [...document.querySelectorAll('#pause-screen #game-menu-panel .choice')];
  const del = btns.find((x) => (x.textContent ?? '').startsWith('Delete') && x.disabled);
  if (del !== undefined) { del.disabled = false; del.click(); del.click(); }
  return before !== null && localStorage.getItem('artifex-save:v1:1') !== null;
});
note(refused ? 'ok' : 'BUG',
  'and re-enabling the button by hand still cannot delete the active slot');

// ---------------------------------------------------------------------------
// Deleting the OTHER slot: two clicks, and the running game is undisturbed.
// ---------------------------------------------------------------------------
await openMenu();
const beforeDelete = await D(() => ({
  map: window.__gameDebug.mapStats().chunks,
  pos: window.__gameDebug.playerPos(),
}));
const armed = await clickButton('Delete');
await page.waitForTimeout(400);
const afterOneClick = await page.evaluate(
  () => localStorage.getItem('artifex-save:v1:0') !== null);
note(armed && afterOneClick ? 'ok' : 'BUG',
  'one click arms the delete but does not do it',
  `slot 0 still present: ${afterOneClick}`);
const confirmLabel = (await slotButtons())
  .map((b) => b.label).find((l) => (l ?? '').startsWith('Delete') && l.includes('?'));
note(confirmLabel !== undefined && /played/.test(confirmLabel) ? 'ok' : 'BUG',
  'and the confirmation names what is being destroyed',
  `label: ${JSON.stringify(confirmLabel)}`);

await clickButton('Delete');
await page.waitForTimeout(600);
const gone = await page.evaluate(
  () => localStorage.getItem('artifex-save:v1:0') === null);
note(gone ? 'ok' : 'BUG', 'the second click deletes it');
const listNow = await slotButtons();
note(listNow.filter((b) => (b.label ?? '').startsWith('Delete')).length === 1
  ? 'ok' : 'BUG', 'and the list refreshes to show the slot empty',
  `${listNow.filter((b) => (b.label ?? '').startsWith('Delete')).length} Delete control(s) left`);

const afterDelete = await D(() => ({
  map: window.__gameDebug.mapStats().chunks,
  pos: window.__gameDebug.playerPos(),
}));
note(afterDelete.map === beforeDelete.map
  && Math.hypot(afterDelete.pos[0] - beforeDelete.pos[0],
    afterDelete.pos[2] - beforeDelete.pos[2]) < 0.5 ? 'ok' : 'BUG',
  'deleting another slot does not disturb the running game',
  `map ${beforeDelete.map} -> ${afterDelete.map} chunks, player unmoved`);

// Save into the now-empty slot to prove it behaves as empty.
await openMenu();
await page.evaluate(() => {
  const saves = [...document.querySelectorAll('#pause-screen #game-menu-panel .choice')]
    .filter((b) => /^(Save|Overwrite)$/.test(b.textContent ?? ''));
  saves[0]?.click();
});
await page.waitForTimeout(800);
const resaved = await page.evaluate(
  () => localStorage.getItem('artifex-save:v1:0') !== null);
note(resaved ? 'ok' : 'BUG', 'a deleted slot can be saved into again');

// ---------------------------------------------------------------------------
// THE HAUNTING TEST. Delete everything, start a genuinely new game, and check
// the world is actually fresh — blank map, castle opening reset.
// ---------------------------------------------------------------------------
await openMenu();
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('#pause-screen #game-menu-panel .choice')]
    .find((b) => b.textContent === 'New Game');
  btn?.click();
  btn?.click(); // two-click confirm
});
await page.waitForTimeout(2500);
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 60_000 });
await page.waitForTimeout(2500);

const fresh = await page.evaluate(() => ({
  map: window.__gameDebug.mapStats().chunks,
  mapKey: localStorage.getItem('artifex-map:v1'),
  castle: localStorage.getItem('artifex-castle:v1'),
  active: localStorage.getItem('artifex-active-slot:v1'),
  slotsKept: [0, 1, 2].map((i) => localStorage.getItem(`artifex-save:v1:${i}`) !== null),
}));
// A brand new game charts its own spawn immediately, so "blank" means "only
// what this session has walked", not literally zero.
note(fresh.map < played.map / 2 ? 'ok' : 'BUG',
  'a new game starts with a blank map, not the deleted save\'s',
  `${fresh.map} chunks now vs ${played.map} in the deleted save`);
note(fresh.castle === null || fresh.castle !== played.castle ? 'ok' : 'BUG',
  'and the castle opening is reset',
  `castle key: ${fresh.castle === null ? 'absent' : 'present and changed'}`);
note(fresh.active === null ? 'ok' : 'BUG',
  'and a new game is in no slot, so every slot is deletable again',
  `active=${fresh.active}`);
note(fresh.slotsKept.some((v) => v) ? 'ok' : 'BUG',
  'while surviving save slots are kept (New Game is not Delete All)',
  `slots present: ${JSON.stringify(fresh.slotsKept)}`);

// ---------------------------------------------------------------------------
for (const e of errors.slice(0, 6)) note('BUG', 'page error', e);
const bugs = findings.filter((f) => f.severity === 'BUG');
process.stdout.write(`\nsave-delete-check: ${bugs.length} bugs, `
  + `${findings.length - bugs.length} ok\n`);
await browser.close();
process.exit(bugs.length === 0 ? 0 : 1);
