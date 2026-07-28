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

// ---------------------------------------------------------------------------
// ...and DISCOVER something, so the crafting tree has moved too.
//
// The map proves a save carries where you have been. The tree has to prove a
// save carries what you have LEARNED, and that is a different key with a
// different lifecycle — 'artifex-progress:v1'. Unlock the loom tier for real:
// weave a cloth, which requires having crafted a loom kit first, which is the
// tree's own rule and not something this probe can shortcut.
//
// The rungs watched below are chosen because the STARTING PACK cannot reach
// them: it contains no cloth, no loom and no forged armour, so tier 3 and the
// dragonscale summit are shut on a fresh game no matter how generous the kit
// is. If they were open at spawn this beat would be vacuous, and §"virgin
// tree" at the end asserts exactly that they are shut.
// ---------------------------------------------------------------------------
const treeBefore = await D(() => window.__gameDebug.progressStats());
await D(() => {
  const g = window.__gameDebug;
  // FREE SOME SLOTS FIRST. The starting pack fills 27 of 28 pack slots, and
  // `craft` is atomic: with nowhere to put the output it restores the inputs
  // and returns false, so the button clicks and nothing happens. That cost a
  // round of this probe reading "the loom kit can be forged: clicked" beside
  // "crafted: 0".
  for (const id of ['dragon_scale', 'berries', 'healing_herb',
    'meat_cooked', 'coal', 'hide', 'gold_small']) {
    g.takeItem(id, 99);
  }
  // Materials for a loom kit, then the kit itself, then cloth.
  g.giveItem('planks', 12);
  g.giveItem('iron_ingot', 8);
  g.giveItem('rope', 8);
  g.giveItem('wool_yarn', 9);
  // A lit hearth, and the 8 stone that turns one into a forge — the loom kit
  // is a FORGE recipe, which is the whole reason tier 3 sits above tier 2.
  g.giveItem('stone', 8);
  const p = g.playerPos();
  g.placeFire(p[0] + 1, p[2], true);
});
await page.waitForTimeout(900);
await D(() => {
  const g = window.__gameDebug;
  const f = g.fires()[g.fires().length - 1];
  g.teleport(f.x, f.z);
});
await page.waitForTimeout(800);
// The 8-stone upgrade through the model rather than the E key: E is a long
// else-if chain and an NPC, a well or a nest within reach outranks the hearth,
// so pressing it here would silently be testing "is anything else standing
// nearby". `upgradeNearestFire` calls exactly what the key handler calls.
await D(() => { window.__gameDebug.upgradeNearestFire(); });
await page.waitForTimeout(900);
const forgeUp = await D(() => {
  const g = window.__gameDebug;
  const f = g.fires()[g.fires().length - 1];
  return { near: g.nearForgeDebug(), kind: f?.kind ?? null, fire: f?.id ?? null };
});
note(forgeUp.near && forgeUp.kind === 'forge' ? 'ok' : 'BUG',
  'a forge is lit to craft at', `fire=${forgeUp.fire} kind=${forgeUp.kind}`);

/**
 * Craft by clicking the row's button in the real panel.
 *
 * The tab switch is not optional: rows live in one category tab at a time and
 * the panel opens on Tools, so a query for a `camp` recipe finds nothing and
 * reports "no-row" — which reads exactly like the recipe being missing.
 */
const craftInPanel = async (recipeKey, category) => {
  await page.keyboard.press('KeyB');
  await page.waitForTimeout(700);
  await page.evaluate((c) => {
    document.querySelector(`#crafting-panel .craft-tab[data-category="${c}"]`)?.click();
  }, category);
  await page.waitForTimeout(350);
  const hit = await page.evaluate((k) => {
    const row = document.querySelector(`#crafting-panel .recipe[data-recipe="${k}"]`);
    if (row === null) return 'no-row';
    if (row.dataset.locked === '1') return 'locked';
    const btn = row.querySelector('.r-craft');
    if (btn === null || btn.disabled) return 'disabled';
    btn.click();
    return 'clicked';
  }, recipeKey);
  await page.waitForTimeout(600);
  await page.keyboard.press('KeyB');
  await page.waitForTimeout(500);
  return hit;
};

await page.keyboard.press('KeyB');
await page.waitForTimeout(700);
await page.evaluate(() => {
  document.querySelector('#crafting-panel .craft-tab[data-category="camp"]')?.click();
});
await page.waitForTimeout(350);
const loomRowState = await page.evaluate(() => {
  const row = document.querySelector('#crafting-panel .recipe[data-recipe="loom_kit"]');
  const cloth = document.querySelector('#crafting-panel .recipe[data-recipe="cloth_wool"]');
  return {
    loom: row === null ? null : row.dataset.locked,
    cloth: cloth === null ? null : cloth.dataset.locked,
    clothReq: cloth?.querySelector('.r-req')?.textContent ?? null,
    tiers: [...document.querySelectorAll('#crafting-panel .tier-head span:first-child')]
      .map((s) => s.textContent),
  };
});
await page.keyboard.press('KeyB');
await page.waitForTimeout(400);
note(loomRowState.tiers.length > 0 ? 'ok' : 'BUG',
  'the crafting panel groups recipes by tier',
  `headings: ${JSON.stringify(loomRowState.tiers)}`);
note(loomRowState.cloth === '1' ? 'ok' : 'BUG',
  'and cloth is drawn as a LOCKED row with its requirement, not hidden',
  `loom_kit locked=${loomRowState.loom}, cloth locked=${loomRowState.cloth},`
  + ` requirement text ${JSON.stringify(loomRowState.clothReq)}`);

const madeLoom = await craftInPanel('loom_kit', 'camp');
note(madeLoom === 'clicked' ? 'ok' : 'BUG', 'the loom kit can be forged',
  `panel said: ${madeLoom}`);
await D(() => {
  const p = window.__gameDebug.playerPos();
  window.__gameDebug.placeLoom(p[0] + 1.5, p[2], 0);
});
await page.waitForTimeout(800);
const madeCloth = await craftInPanel('cloth_wool', 'camp');
note(madeCloth === 'clicked' ? 'ok' : 'BUG',
  'and once the loom is up, cloth is unlocked and weaves',
  `panel said: ${madeCloth}`);

const played = await D(() => ({
  map: window.__gameDebug.mapStats().chunks,
  castle: localStorage.getItem('artifex-castle:v1'),
  tree: window.__gameDebug.progressStats(),
  progressKey: localStorage.getItem('artifex-progress:v1'),
  loomKey: localStorage.getItem('artifex-looms:v1'),
  quilted: window.__gameDebug.recipeUnlocked('quilted_hood'),
  canvas: window.__gameDebug.recipeUnlocked('canvas_tent'),
}));
note(played.map > 40 ? 'ok' : 'BUG', 'played far enough to have a map',
  `${played.map} chunks charted`);
note(played.tree.unlocked > treeBefore.unlocked ? 'ok' : 'BUG',
  'and learned enough to have moved the crafting tree',
  `${treeBefore.unlocked} recipes known at spawn -> ${played.tree.unlocked}`
  + ` of ${played.tree.total}, ${played.tree.crafted} crafted`);
note(played.quilted && played.canvas ? 'ok' : 'BUG',
  'weaving cloth opened the rest of the loom tier',
  `quilted_hood=${played.quilted} canvas_tent=${played.canvas}`);
note(played.progressKey !== null ? 'ok' : 'BUG',
  'the tree is in localStorage under its own key',
  `artifex-progress:v1 is ${played.progressKey?.length ?? 0} chars`);
note(played.loomKey !== null ? 'ok' : 'BUG',
  'and the placed loom is under its own key too',
  `artifex-looms:v1 is ${played.loomKey?.length ?? 0} chars`);

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
  tree: window.__gameDebug.progressStats(),
  looms: window.__gameDebug.looms().length,
  quilted: window.__gameDebug.recipeUnlocked('quilted_hood'),
  canvas: window.__gameDebug.recipeUnlocked('canvas_tent'),
  cloth: window.__gameDebug.recipeUnlocked('cloth_wool'),
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

// --- and the crafting tree is virgin again ---------------------------------
//
// The map's version of this test tolerates a fraction ("blank means only what
// this session walked"). The tree does not get that latitude on the rungs
// below, because they are exactly the ones the starting pack cannot reach: no
// cloth, no loom kit, no forged armour is in the kit, so a new game MUST have
// them shut. A leaked progress key shows up here as "you already know how to
// weave" on a character who has never seen a loom.
note(!fresh.cloth && !fresh.quilted && !fresh.canvas ? 'ok' : 'BUG',
  'a new game does not remember how to weave',
  `cloth=${fresh.cloth} quilted_hood=${fresh.quilted} canvas_tent=${fresh.canvas}`
  + ` (all three were unlocked in the deleted save)`);
note(fresh.tree.unlocked < played.tree.unlocked ? 'ok' : 'BUG',
  'the tree shrank back to a starting-pack tree',
  `${played.tree.unlocked} recipes known in the deleted save`
  + ` -> ${fresh.tree.unlocked} now (of ${fresh.tree.total})`);
note(fresh.tree.crafted === 0 ? 'ok' : 'BUG',
  'and a new game has crafted nothing',
  `crafted=${fresh.tree.crafted} (was ${played.tree.crafted})`);
note(fresh.looms === 0 ? 'ok' : 'BUG',
  'the loom the deleted save built is gone with it',
  `${fresh.looms} looms in the world`);

// ---------------------------------------------------------------------------
for (const e of errors.slice(0, 6)) note('BUG', 'page error', e);
const bugs = findings.filter((f) => f.severity === 'BUG');
process.stdout.write(`\nsave-delete-check: ${bugs.length} bugs, `
  + `${findings.length - bugs.length} ok\n`);
await browser.close();
process.exit(bugs.length === 0 ? 0 : 1);
