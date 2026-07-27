/**
 * Can you drink at a well?
 *
 *   node scripts/well-drink-check.mjs
 *
 * Wells were placed in every village, town and castle and did nothing. This
 * drives the real game to a real well and asks:
 *
 *   1. Does the HUD offer it, and does E do what the HUD said? The interact
 *      chain in main.ts has a documented history of the prompt and the key
 *      disagreeing — the building prompt used to beat an NPC standing 8 cm
 *      away — so the label and the effect are checked as one thing.
 *   2. Does it actually quench? Measured as a thirst delta, not "no error".
 *   3. Is it at least as good as a river? A well the player walked to must
 *      never be the worse option.
 *   4. Does it stay off when it should — away from the well, and while paused.
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
// Find a well. Villages, towns and castles place them; ruins and ranches may
// not, so try settlements until one has one.
// ---------------------------------------------------------------------------
let well = null;
let where = null;
for (const kind of ['village', 'town', 'castle', undefined]) {
  await D((k) => { window.__gameDebug.teleportToNearestSettlement(k); }, kind);
  await page.waitForTimeout(3000);
  const pads = await D(() => window.__gameDebug.wellPads());
  if (pads.length > 0) {
    well = pads[0];
    where = await D(() => window.__gameDebug.nearestSettlement());
    break;
  }
}
if (well === null) {
  note('BUG', 'no well found in any nearby settlement',
    'wells are placed by settlement-plans.ts in village/town/castle layouts');
  process.stdout.write('\nwell-drink-check: 1 bugs, 0 ok\n');
  await browser.close();
  process.exit(1);
}
note('ok', 'found a well', `${where?.name ?? '?'} (${where?.kind ?? '?'}) `
  + `at ${well.wx.toFixed(1)}, ${well.wz.toFixed(1)}`);

// ---------------------------------------------------------------------------
// Away from it, nothing is offered.
// ---------------------------------------------------------------------------
await D((w) => { window.__gameDebug.teleport(w.wx + 40, w.wz + 40); }, well);
await page.waitForTimeout(1400);
const farPrompt = await D(() => window.__gameStats.interactPrompt ?? null);
note(!(farPrompt ?? '').includes('well') ? 'ok' : 'BUG',
  '40 m away the well is not offered', `prompt: ${JSON.stringify(farPrompt)}`);

// ---------------------------------------------------------------------------
// At the rim: the HUD offers it.
// ---------------------------------------------------------------------------
await D((w) => { window.__gameDebug.teleport(w.wx + 1.6, w.wz); }, well);
await page.waitForTimeout(1400);
const prompt = await D(() => window.__gameStats.interactPrompt ?? null);
note((prompt ?? '').includes('well') ? 'ok' : 'BUG',
  'standing at the well, the HUD offers it', `prompt: ${JSON.stringify(prompt)}`);

// ---------------------------------------------------------------------------
// And E does what the HUD said.
// ---------------------------------------------------------------------------
await D(() => { window.__gameDebug.setVitals({ thirst: 20 }); });
await page.waitForTimeout(300);
const before = await D(() => window.__gameDebug.vitals().thirst);
await page.keyboard.press('KeyE');
await page.waitForTimeout(700);
const after = await D(() => window.__gameDebug.vitals().thirst);
const gained = after - before;
note(gained > 30 ? 'ok' : 'BUG', 'E at a well quenches thirst',
  `thirst ${before.toFixed(1)} -> ${after.toFixed(1)} (+${gained.toFixed(1)})`);
note(gained >= 40 ? 'ok' : 'BUG', 'a well is at least as good as a river',
  `well +${gained.toFixed(1)}, river is +40`);

// The HUD notice line is shared, and the dungeon/building/settlement managers
// all outrank a gather notice on it — a guard killing someone in the square
// will occupy it for four seconds. So retry rather than reading it once and
// calling a pre-existing precedence chain a bug in the well.
let notice = null;
for (let i = 0; i < 6; i++) {
  await D(() => { window.__gameDebug.setVitals({ thirst: 20 }); });
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(500);
  notice = await D(() => window.__gameStats.notice ?? null);
  if ((notice ?? '').toLowerCase().includes('drink')) break;
  await page.waitForTimeout(1500);
}
note((notice ?? '').toLowerCase().includes('drink') ? 'ok' : 'BUG',
  'and the HUD says so', `notice: ${JSON.stringify(notice)}`
  + ' (the notice line is shared; a manager notice outranks it)');

// Thirst must clamp, not overflow.
await D(() => { window.__gameDebug.setVitals({ thirst: 98 }); });
await page.waitForTimeout(300);
await page.keyboard.press('KeyE');
await page.waitForTimeout(600);
const full = await D(() => window.__gameDebug.vitals().thirst);
note(full <= 100.001 ? 'ok' : 'BUG', 'drinking cannot push thirst over full',
  `thirst ${full.toFixed(2)}`);

// ---------------------------------------------------------------------------
// Paused: no prompt, and E does nothing to a frozen world.
// ---------------------------------------------------------------------------
await D(() => { window.__gameDebug.setVitals({ thirst: 30 }); });
await page.waitForTimeout(300);
await D(() => { window.__gameDebug.setPaused(true); });
await page.waitForTimeout(900);
const pausedPrompt = await D(() => window.__gameStats.interactPrompt ?? null);
note(pausedPrompt === null ? 'ok' : 'BUG',
  'the well prompt is withdrawn while paused', `prompt: ${JSON.stringify(pausedPrompt)}`);
const thirstBeforePausedE = await D(() => window.__gameDebug.vitals().thirst);
await page.keyboard.press('KeyE');
await page.waitForTimeout(600);
const thirstAfterPausedE = await D(() => window.__gameDebug.vitals().thirst);
note(thirstAfterPausedE === thirstBeforePausedE ? 'ok' : 'BUG',
  'and E does nothing while paused',
  `thirst ${thirstBeforePausedE.toFixed(2)} -> ${thirstAfterPausedE.toFixed(2)}`);
await D(() => { window.__gameDebug.setPaused(false); });
await page.waitForTimeout(600);

// ---------------------------------------------------------------------------
// The well must not have stolen anything more important. An NPC standing at
// the well still wins E — the chain ranks conversation above a bucket.
// ---------------------------------------------------------------------------
const npc = await D(() => window.__gameDebug.nearestNpc());
if (npc !== null) {
  const p = await D(() => window.__gameDebug.interactPrompt());
  note((p ?? '').includes('talk') ? 'ok' : 'BUG',
    'an NPC within reach still outranks the well', `prompt: ${JSON.stringify(p)}`);
} else {
  note('ok', 'no NPC at the well to test precedence against',
    'the chain places the well below NPC chat and market stalls by construction');
}

// ---------------------------------------------------------------------------
for (const e of errors.slice(0, 6)) note('BUG', 'page error', e);
const bugs = findings.filter((f) => f.severity === 'BUG');
process.stdout.write(`\nwell-drink-check: ${bugs.length} bugs, `
  + `${findings.length - bugs.length} ok\n`);
await browser.close();
process.exit(bugs.length === 0 ? 0 : 1);
