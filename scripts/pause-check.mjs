/**
 * Does Escape actually stop the world?
 *
 *   node scripts/pause-check.mjs
 *
 * Not "is the paused flag true" — a flag proves nothing, and this repo has a
 * long history of green checks over broken games. This drives the real thing
 * and measures whether anything MOVED:
 *
 *   1. Record every animal's position, every NPC's position, the player's
 *      vitals and the sim clock. Pause. Wait several real seconds. Assert not
 *      one of those numbers changed.
 *   2. Resume, and assert the first frame advances the sim by ONE step, not by
 *      the whole pause. That is the catch-up burst the fixed-timestep
 *      accumulator would otherwise produce, and it is the actual bug.
 *   3. Assert the same thing again for the wall-clock systems, which do not
 *      run on simTime at all: a jail sentence must not be served while paused.
 *   4. Assert the world resumes — a pause that never lets go is worse than no
 *      pause at all.
 *
 * Reported as numbers, not impressions.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 620 } });

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

await page.goto('http://localhost:5173/game.html?director=off&tod=0.45&weather=clear',
  { waitUntil: 'domcontentloaded' });
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

// ---------------------------------------------------------------------------
// Set the scene: get out of the castle undercroft into open world with
// wildlife, and put a few animals nearby so there is something to watch.
// ---------------------------------------------------------------------------
// Into a settlement, so there are NPCs on their routes to watch as well as
// wildlife — an "NPCs did not move" assertion over zero NPCs proves nothing.
await D(() => { window.__gameDebug.teleportToNearestSettlement(); });
await page.waitForTimeout(3500);
await D(() => {
  const p = window.__gameDebug.playerPos();
  for (const [dx, dz, s] of [[12, 6, 'deer'], [-14, 9, 'wolf'], [8, -15, 'boar'],
    [-9, -11, 'deer'], [18, 14, 'cow']]) {
    window.__gameDebug.placeEntity(s, p[0] + dx, p[1], p[2] + dz);
  }
});
await page.waitForTimeout(2500);

/** Everything a paused world must hold still. */
const snapshot = () => D(() => ({
  simTime: window.__gameDebug.simTime(),
  vitals: window.__gameDebug.vitals(),
  entities: window.__gameDebug.entities()
    .map((e) => `${e.id}:${e.x.toFixed(4)},${e.y.toFixed(4)},${e.z.toFixed(4)}:${e.mode}`)
    .sort(),
  npcs: window.__gameDebug.npcs()
    .map((n) => `${n.id}:${n.x.toFixed(4)},${n.z.toFixed(4)}`).sort(),
  projectiles: window.__gameDebug.projectiles().length,
  frames: window.__gameStats.frameCount,
  paused: window.__gameDebug.paused(),
}));

const diffCount = (a, b) => a.filter((v, i) => v !== b[i]).length;

// ---------------------------------------------------------------------------
// 1. Baseline — the world is demonstrably ALIVE before we pause it.
// ---------------------------------------------------------------------------
const live0 = await snapshot();
await page.waitForTimeout(3000);
const live1 = await snapshot();

const liveMoved = live0.entities.length === live1.entities.length
  ? diffCount(live0.entities, live1.entities) : -1;
const liveSim = live1.simTime - live0.simTime;
if (liveSim < 2.0) {
  note('BUG', 'the unpaused world is not running',
    `simTime advanced ${liveSim.toFixed(2)} s over 3 s of wall clock — `
    + 'this run cannot prove anything about pause');
} else {
  note('ok', 'baseline: the world runs',
    `simTime +${liveSim.toFixed(2)} s, ${liveMoved}/${live0.entities.length} `
    + `entities moved, ${live1.frames - live0.frames} frames`);
}
if (liveMoved === 0) {
  note('BUG', 'nothing moved even UNPAUSED',
    'the pause test below would pass trivially; the scene is not alive');
}

// ---------------------------------------------------------------------------
// 2. Pause and watch nothing happen.
// ---------------------------------------------------------------------------
await D(() => { window.__gameDebug.setPaused(true); });
await page.waitForTimeout(300);
const p0 = await snapshot();
note(p0.paused ? 'ok' : 'BUG', 'pause screen reports paused', `paused=${p0.paused}`);

const PAUSE_S = 6;
await page.waitForTimeout(PAUSE_S * 1000);
const p1 = await snapshot();

const framesDuringPause = p1.frames - p0.frames;
note(framesDuringPause > 60 ? 'ok' : 'BUG', 'rendering continues while paused',
  `${framesDuringPause} frames drawn over ${PAUSE_S} s `
  + '(a paused game must still draw, or the menu sits on a frozen buffer)');

const simDrift = p1.simTime - p0.simTime;
note(simDrift === 0 ? 'ok' : 'BUG', 'the sim clock is frozen',
  `simTime moved ${simDrift.toFixed(6)} s over ${PAUSE_S} s paused`);

const movedWhilePaused = p0.entities.length === p1.entities.length
  ? diffCount(p0.entities, p1.entities) : -1;
note(movedWhilePaused === 0 ? 'ok' : 'BUG', 'no animal moved',
  `${movedWhilePaused} of ${p0.entities.length} entity positions/modes changed`);

const npcMoved = p0.npcs.length === p1.npcs.length
  ? diffCount(p0.npcs, p1.npcs) : -1;
if (p0.npcs.length === 0) {
  note('BUG', 'no NPCs to watch',
    'the "no NPC moved" assertion is vacuous — the run did not land in a settlement');
} else {
  note(npcMoved === 0 ? 'ok' : 'BUG', 'no NPC moved',
    `${npcMoved} of ${p0.npcs.length} NPC positions changed`);
}

// The real field names from src/game/vitals.ts. Named explicitly rather than
// iterated, so a typo shows up as "undefined" in the report instead of
// silently reducing the assertion to nothing.
const vitalKeys = ['hp', 'thirst', 'stamina', 'temperature',
  'thirstTickAccum', 'tempTickAccum'];
const vitalDelta = vitalKeys
  .filter((k) => typeof p0.vitals[k] === 'number')
  .map((k) => [k, p1.vitals[k] - p0.vitals[k]])
  .filter(([, d]) => Math.abs(d) > 1e-9);
const vitalsWatched = vitalKeys.filter((k) => typeof p0.vitals[k] === 'number');
if (vitalsWatched.length < vitalKeys.length) {
  note('BUG', 'vitals field names are wrong in this harness',
    `only found ${vitalsWatched.join(', ')} — the rest of the assertion is empty`);
}
note(vitalDelta.length === 0 ? 'ok' : 'BUG', 'vitals do not drain while paused',
  vitalDelta.length === 0
    ? `${vitalsWatched.length} fields held: thirst ${p1.vitals.thirst?.toFixed(3)}, `
      + `stamina ${p1.vitals.stamina?.toFixed(3)}, `
      + `thirstTickAccum ${p1.vitals.thirstTickAccum?.toFixed(4)}`
    : vitalDelta.map(([k, d]) => `${k} ${d > 0 ? '+' : ''}${d.toFixed(4)}`).join(', '));

// ---------------------------------------------------------------------------
// 3. The wall-clock systems. A jail sentence is on Date.now(), not simTime,
//    so it is the one thing a naive pause silently keeps running.
// ---------------------------------------------------------------------------
await D(() => { window.__gameDebug.setPaused(false); });
await page.waitForTimeout(400);
// A sentence is proportional to the bounty, so without one `sendToJail` files
// a zero-second sentence and the assertion below proves nothing.
await D(() => {
  window.__gameDebug.addBounty(600);
  window.__gameDebug.sendToJail();
});
await page.waitForTimeout(1200);
const jail0 = await D(() => window.__gameStats.jailRemainS ?? null);
await D(() => { window.__gameDebug.setPaused(true); });
await page.waitForTimeout(5000);
const jail1 = await D(() => window.__gameStats.jailRemainS ?? null);
await D(() => { window.__gameDebug.setPaused(false); });
if (jail0 === null || jail1 === null || jail0 < 10) {
  note('BUG', 'jail timer never started',
    `jailRemainS=${jail0} — the wall-clock pause assertion below is vacuous`);
} else {
  const served = jail0 - jail1;
  note(Math.abs(served) < 0.75 ? 'ok' : 'BUG',
    'a jail sentence is not served while paused',
    `${served.toFixed(2)} s of a ${jail0.toFixed(0)} s sentence elapsed over 5 s paused`);
}
await D(() => { window.__gameDebug.serveFast(10 * 60_000); });

// ---------------------------------------------------------------------------
// 4. THE CATCH-UP BURST. After a long pause the first resumed frame must run
//    ONE step, not the whole pause. This is the failure the whole design is
//    built around.
// ---------------------------------------------------------------------------
await D(() => { window.__gameDebug.setPaused(true); });
await page.waitForTimeout(400);
const beforeResume = await D(() => ({
  simTime: window.__gameDebug.simTime(),
  frames: window.__gameStats.frameCount,
}));
const LONG_PAUSE_S = 12;
await page.waitForTimeout(LONG_PAUSE_S * 1000);

// Resume and sample the very next frames. Sampling happens INSIDE the page —
// one evaluate for the whole window — because a per-frame round trip through
// CDP stretches some frames to 50 ms, and a 50 ms frame legitimately runs
// three steps. Timing every frame is what tells a real burst (steps far ahead
// of elapsed wall clock) from a slow harness (steps tracking it exactly).
const burst = await page.evaluate(async () => {
  const dbg = window.__gameDebug;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  dbg.setPaused(false);
  const samples = [];
  let prev = performance.now();
  for (let i = 0; i < 20; i++) {
    await raf();
    const now = performance.now();
    samples.push({ steps: dbg.lastFrameSteps(), ms: now - prev, simTime: dbg.simTime() });
    prev = now;
  }
  return samples;
});
const SIM_HZ = 60;
// Per frame: a frame may never step more than its own elapsed wall time
// allows, +1 for the accumulator remainder it carried in.
const overruns = burst.filter((s) => s.steps > Math.ceil(s.ms / (1000 / SIM_HZ)) + 1);
const totalSteps = burst.reduce((n, s) => n + s.steps, 0);
const totalMs = burst.reduce((n, s) => n + s.ms, 0);
const owed = totalMs / (1000 / SIM_HZ);
note(overruns.length === 0 ? 'ok' : 'BUG',
  `no frame catches up after a ${LONG_PAUSE_S} s pause`,
  `${totalSteps} steps over ${totalMs.toFixed(0)} ms of resumed frames `
  + `(${owed.toFixed(1)} owed) — a banked pause would owe ${Math.round(LONG_PAUSE_S * SIM_HZ)}`
  + (overruns.length > 0
    ? `; worst frame ${Math.max(...overruns.map((s) => s.steps))} steps in `
      + `${Math.max(...overruns.map((s) => s.ms)).toFixed(0)} ms`
    : ''));
note(Math.abs(totalSteps - owed) < 3 ? 'ok' : 'BUG',
  'resumed steps track wall clock exactly',
  `${totalSteps} steps vs ${owed.toFixed(1)} owed by elapsed time`);
note(burst[0].steps <= 1 ? 'ok' : 'BUG', 'the first resumed frame steps at most once',
  `${burst[0].steps} step(s) in ${burst[0].ms.toFixed(1)} ms`);
const totalSim = burst[burst.length - 1].simTime - beforeResume.simTime;
note(totalSim < 0.8 ? 'ok' : 'BUG', 'the pause did not leak into the sim clock',
  `simTime advanced ${totalSim.toFixed(4)} s across ${burst.length} frames `
  + `after ${LONG_PAUSE_S} s paused`);

// ---------------------------------------------------------------------------
// 5. And the world starts again.
// ---------------------------------------------------------------------------
const r0 = await snapshot();
await page.waitForTimeout(3000);
const r1 = await snapshot();
const resumedMoved = r0.entities.length === r1.entities.length
  ? diffCount(r0.entities, r1.entities) : -1;
const resumedSim = r1.simTime - r0.simTime;
note(resumedSim > 2.0 && resumedMoved > 0 ? 'ok' : 'BUG', 'the world resumes',
  `simTime +${resumedSim.toFixed(2)} s, ${resumedMoved}/${r0.entities.length} entities moved`);
note(r1.paused === false ? 'ok' : 'BUG', 'and is not still paused', `paused=${r1.paused}`);

// ---------------------------------------------------------------------------
// 6. One Escape, not two. The browser eats the first Escape to release the
//    pointer lock, so this is the press that used to do nothing.
// ---------------------------------------------------------------------------
await page.evaluate(() => {
  document.getElementById('overlay')?.click();
});
await page.waitForTimeout(600);
const locked = await page.evaluate(() => document.pointerLockElement !== null);
if (!locked) {
  note('ok', 'single-Escape path not exercised',
    'headless Chrome refused the pointer lock — covered by map-look.mjs instead');
} else {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  const afterOne = await D(() => ({
    paused: window.__gameDebug.paused(),
    panel: document.getElementById('pause-screen') !== null,
  }));
  note(afterOne.paused && afterOne.panel ? 'ok' : 'BUG',
    'ONE Escape pauses and opens the map',
    `paused=${afterOne.paused} pauseScreen=${afterOne.panel}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  const afterTwo = await D(() => window.__gameDebug.paused());
  note(afterTwo === false ? 'ok' : 'BUG', 'and Escape again resumes', `paused=${afterTwo}`);
}

// ---------------------------------------------------------------------------
// 6b. Only Escape pauses. Inventory, crafting, the character sheet and NPC
//     chat are opened constantly mid-play; freezing the world under every one
//     of them would change how the game is played, and was not what was asked
//     for. Asserted rather than assumed, because "one panel is special" is
//     exactly the kind of rule that quietly becomes "all panels are".
// ---------------------------------------------------------------------------
for (const [key, name] of [['KeyI', 'inventory'], ['KeyB', 'crafting'], ['KeyC', 'character']]) {
  await page.keyboard.press(key);
  await page.waitForTimeout(500);
  const st = await D(() => ({
    open: window.__gameStats.panelOpen ?? null,
    paused: window.__gameDebug.paused(),
    sim: window.__gameDebug.simTime(),
  }));
  await page.waitForTimeout(1200);
  const st2 = await D(() => window.__gameDebug.simTime());
  note(!st.paused && st2 > st.sim ? 'ok' : 'BUG',
    `the ${name} panel does not pause the world`,
    `paused=${st.paused}, simTime +${(st2 - st.sim).toFixed(2)} s while it was open`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}

// ---------------------------------------------------------------------------
// 7. A save taken WHILE PAUSED must reload sanely. `simTime` is written into
//    the slot and read back at boot, so a pause that let the clock drift — or
//    one that survived the reload — would show up here.
// ---------------------------------------------------------------------------
await D(() => { window.__gameDebug.setPaused(true); });
await page.waitForTimeout(600);
const atSave = await D(() => ({
  simTime: window.__gameDebug.simTime(),
  pos: window.__gameDebug.playerPos(),
  map: window.__gameDebug.mapStats().chunks,
}));
// Click Save into slot 1 through the pause screen's own rail, not a debug hook
// — the point is that the button a player presses works while the world is
// stopped.
const saved = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('#pause-screen #game-menu-panel .choice')];
  const save = btns.find((b) => /save|overwrite/i.test(b.textContent ?? ''));
  if (save === undefined) return false;
  save.click();
  return true;
});
await page.waitForTimeout(1000);
note(saved ? 'ok' : 'BUG', 'the pause screen can save', 'clicked Slot 1 Save');
const slotWritten = await page.evaluate(
  () => localStorage.getItem('artifex-save:v1:0') !== null);
note(slotWritten ? 'ok' : 'BUG', 'and the slot was written');

await page.evaluate(() => {
  const rec = JSON.parse(localStorage.getItem('artifex-save:v1:0'));
  localStorage.setItem('artifex-resume:v1', JSON.stringify(rec.resume));
});
await page.goto('http://localhost:5173/game.html?director=off&tod=0.45&weather=clear',
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 60_000 });
await page.waitForTimeout(2500);
const afterLoad = await page.evaluate(() => ({
  simTime: window.__gameDebug.simTime(),
  paused: window.__gameDebug.paused(),
  pos: window.__gameDebug.playerPos(),
  map: window.__gameDebug.mapStats().chunks,
}));
note(Math.abs(afterLoad.simTime - atSave.simTime) < 6 ? 'ok' : 'BUG',
  'the sim clock resumes where the paused save left it',
  `saved at ${atSave.simTime.toFixed(2)} s, reloaded at ${afterLoad.simTime.toFixed(2)} s`);
note(afterLoad.paused === false ? 'ok' : 'BUG',
  'and the game is not still paused after the reload', `paused=${afterLoad.paused}`);
const moved = Math.hypot(afterLoad.pos[0] - atSave.pos[0], afterLoad.pos[2] - atSave.pos[2]);
note(moved < 3 ? 'ok' : 'BUG', 'and the player is where they were saved',
  `${moved.toFixed(2)} m from the saved position`);
note(afterLoad.map >= atSave.map ? 'ok' : 'BUG', 'and the map came back with it',
  `${atSave.map} chunks saved, ${afterLoad.map} after the reload`);

// ---------------------------------------------------------------------------
for (const e of errors.slice(0, 6)) note('BUG', 'page error', e);
const bugs = findings.filter((f) => f.severity === 'BUG');
process.stdout.write(`\npause-check: ${bugs.length} bugs, `
  + `${findings.length - bugs.length} ok\n`);
await browser.close();
process.exit(bugs.length === 0 ? 0 : 1);
