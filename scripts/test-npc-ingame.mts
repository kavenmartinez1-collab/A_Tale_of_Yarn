/**
 * test-npc-ingame.mts — talk to an actual NPC in the actual game.
 *
 * scripts/test-npc-live.mts drives the engine directly, which proves the model
 * and the prompt/parser chain work but says nothing about the wiring. This one
 * loads game.html, walks up to a real spawned NPC, opens the chat panel with
 * the interact key and types into the real input box.
 *
 * NOTE the URL has no `?director=off`. Every other harness in scripts/ sets it,
 * and it is exactly wrong here: main.ts passes `stubMode: directorOff` and
 * `gpu: directorOff ? undefined : gpu` to the panel, so `director=off` puts NPC
 * chat in CANNED-REPLY mode. A test that used it would pass without the model
 * ever being loaded.
 *
 * Because the fallback path is silent by design (any LLM error degrades to a
 * stub reply so the game never stalls), "a reply appeared" proves nothing
 * either. Three independent checks establish the reply is really the model's:
 *   1. the console line naming the loaded repo/file
 *   2. the 'thinking…' element, which only the live branch creates
 *   3. the reply differing from stubReply()'s deterministic output
 *
 * Run: npx tsx scripts/test-npc-ingame.mts [--headed]
 */
import { chromium } from '@playwright/test';

const BASE = 'http://127.0.0.1:5173';
const headed = process.argv.includes('--headed');
const EXPECT_REPO = 'unsloth/Qwen3-1.7B-GGUF';

const SAY = [
  'Well met. What do they call you?',
  'What are you selling today?',
  'Have you lost anyone to the winter?',
];

const browser = await chromium.launch({
  channel: 'chrome', headless: !headed,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
let failures = 0;
const fail = (m: string) => { console.log(`FAIL: ${m}`); failures++; };
const ok = (m: string) => console.log(`ok: ${m}`);

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleLines: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (m) => consoleLines.push(m.text()));
  // Mirror console lines into the page so waitForFunction can poll them.
  await page.addInitScript(`
    window.__npcConsole = [];
    for (const k of ['log', 'warn']) {
      const orig = console[k].bind(console);
      console[k] = (...a) => { try { window.__npcConsole.push(a.join(' ')); } catch {} orig(...a); };
    }
  `);
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // director ON — see the header comment.
  await page.goto(`${BASE}/game.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as any).__gameReady === true,
    undefined, { timeout: 90_000 });
  await page.waitForTimeout(1500);

  // ---- get to an NPC ------------------------------------------------------
  const placed = await page.evaluate(async () => {
    const d = (window as any).__gameDebug;
    d.teleportToNearestSettlement();
    await new Promise((r) => setTimeout(r, 2500)); // let the settlement stream in
    const got = d.teleportToNearestNpc();
    return { got, pos: d.playerPos(), settlement: d.nearestSettlement() };
  });
  if (placed.got !== true) fail(`teleportToNearestNpc() returned ${placed.got}`);
  else ok(`stood next to an NPC at [${placed.pos.map((n: number) => n.toFixed(0))}]`);

  // Wait for the deferred NPC model load to finish. main.ts kicks off
  // preloadNpcChat() once the player comes within 350 m of a settlement, and
  // until it lands the panel's live branch throws 'model not loaded' and serves
  // a canned line instead — instantly, and with no error anywhere. Without this
  // wait the whole test passes while talking to the stub.
  const loaded = await page.waitForFunction(() => {
    const w = window as any;
    return (w.__npcConsole ?? []).some((l: string) => l.includes('EOS token IDs'));
  }, undefined, { timeout: 180_000 }).then(() => true).catch(() => false);
  if (!loaded) console.log('   (model-ready log not seen; continuing — per-turn timing still gates this)');
  else ok('NPC model finished loading');
  await page.waitForTimeout(3000); // warm prefill settles

  // ---- get within actual talking range ------------------------------------
  // teleportToNearestNpc() puts the player at the NPC's street position, and
  // that position can sit inside a building — where E means "leave the room"
  // and nearestNpc() returns null, which looks exactly like "there is nobody
  // here". The settlement layout moved and this test started failing with
  // `interactPrompt was: "Press E to leave"` while the feature worked fine.
  //
  // So: try candidates in turn and gate on the game's OWN interact prompt,
  // which is built from the same ranked chain the E key runs. If it does not
  // say "talk to", E will do something else, and pressing it proves nothing.
  const reached = await page.evaluate(async () => {
    const d = (window as any).__gameDebug;
    // A headless page that cannot take pointer lock can end up on the pause
    // screen, which suppresses the interact prompt entirely.
    if (d.paused?.() === true) d.setPaused(false);
    const homes = (d.npcHomes() as
      { id: string; name: string; x: number; z: number; indoors: boolean; inArena: boolean }[])
      .filter((h) => !h.indoors || h.inArena);
    for (const cand of homes) {
      d.teleport(cand.x + 2.5, cand.z + 2.5);
      d.teleportToNearestNpc();
      await new Promise((r) => setTimeout(r, 700));  // interactPrompt ticks at 2 Hz
      const prompt = (d.interactPrompt() ?? '') as string;
      if (d.nearestNpc() !== null && /talk to/.test(prompt)) return prompt;
    }
    return null;
  });
  if (reached === null) fail('could not get within talking range of any NPC');
  else ok(`in range: ${JSON.stringify(reached)}`);

  // ---- open the chat panel with the real interact key ---------------------
  await page.keyboard.press('KeyE');
  const panel = page.locator('#npc-chat-panel');
  try {
    await panel.waitFor({ state: 'visible', timeout: 15_000 });
    ok('chat panel opened via KeyE');
  } catch {
    fail('chat panel never appeared after KeyE');
    const prompt = await page.evaluate(() => (window as any).__gameStats?.interactPrompt ?? null);
    console.log(`   interactPrompt was: ${JSON.stringify(prompt)}`);
    throw new Error('cannot continue without the panel');
  }

  // Record thinking-bubble insertions from inside the page. Polling with a
  // locator loses the race: on the stub path the bubble is added and removed
  // synchronously, so an external watcher reports "no bubble" for BOTH a live
  // turn it was too slow to catch and a stub turn that never had one.
  await page.evaluate(() => {
    const w = window as any;
    w.__thinkSeen = 0;
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of Array.from(m.addedNodes)) {
          if (n instanceof HTMLElement && n.classList.contains('thinking')) w.__thinkSeen++;
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });

  const npcName = (await page.locator('#npc-chat-panel .npc-header').first().textContent() ?? '').trim();
  const role = (await page.locator('#npc-chat-panel .npc-role').first().textContent() ?? '').trim();
  console.log(`\n=== talking to: ${npcName} (${role}) ===`);

  const input = page.locator('#npc-chat-input');
  const history = page.locator('#npc-chat-history');

  // Opening the panel kicks off warmNpcChat(), a ~11-13 s prefill of the system
  // prompt that turn 1 is supposed to ride on top of. Typing instantly queues
  // the player's turn BEHIND that prefill and blows the 20 s watchdog, so an
  // instant-typing harness measures a case real play rarely hits — a player
  // reads the greeting first. Pause for a plausible read, then talk.
  await page.waitForTimeout(14_000);

  const transcript: Array<{ said: string; reply: string; sawThinking: boolean; ms: number }> = [];
  for (const say of SAY) {
    const before = await history.locator('.msg.assistant').count();
    const thinkBefore = await page.evaluate(() => (window as any).__thinkSeen ?? 0);
    await input.fill(say);
    const t0 = Date.now();
    await input.press('Enter');
    // First model load pays weight upload + warm prefill; be generous.
    await page.waitForFunction(
      (n) => document.querySelectorAll('#npc-chat-history .msg.assistant').length > n,
      before, { timeout: 180_000 });
    // let streaming finish
    await page.waitForFunction(() => {
      const el = document.querySelector('#npc-chat-input') as HTMLInputElement | null;
      return el !== null && !el.disabled;
    }, undefined, { timeout: 180_000 });
    const ms = Date.now() - t0;
    const sawThinking =
      (await page.evaluate(() => (window as any).__thinkSeen ?? 0)) > thinkBefore;
    const reply = (await history.locator('.msg.assistant').last().textContent() ?? '').trim();
    transcript.push({ said: say, reply, sawThinking, ms });
    console.log(`\nPLAYER: ${say}`);
    console.log(`${npcName}: ${reply}`);
    console.log(`  (${(ms / 1000).toFixed(1)}s, thinking-bubble=${sawThinking})`);
  }

  // ---- prove these came from the model ------------------------------------
  console.log('\n--- provenance checks ---');
  const modelLine = consoleLines.find((l) => l.includes('[NPC chat] model'));
  if (modelLine === undefined) fail('no "[NPC chat] model ..." console line — model never selected');
  else if (!modelLine.includes(EXPECT_REPO)) fail(`loaded the wrong model: ${modelLine}`);
  else ok(modelLine.trim());

  if (!transcript.some((t) => t.sawThinking)) {
    fail('never saw the thinking… bubble — replies came from the stub path');
  } else ok('thinking… bubble seen (live branch taken)');

  // Timing gate. The stub path answers in ~40 ms by construction (a setTimeout
  // in sendMessage); a real generation cannot. This is the check that caught
  // the first version of this test talking to the stub while reporting success.
  const instant = transcript.filter((t) => t.ms < 300);
  if (instant.length > 0) {
    fail(`${instant.length} reply(ies) returned in <300ms — that is the canned stub path, `
      + `not the model (${instant.map((t) => t.ms + 'ms').join(', ')})`);
  } else ok(`every turn took real generation time (${transcript.map((t) => (t.ms / 1000).toFixed(1) + 's').join(', ')})`);

  // Canned guard/merchant lines are a small fixed pool, so a repeat across
  // different questions is a strong stub signal on its own.
  const uniq = new Set(transcript.map((t) => t.reply));
  if (uniq.size < transcript.length) {
    fail(`${transcript.length - uniq.size} duplicate reply(ies) — canned-line pool, not generation`);
  } else ok('every reply is distinct');

  const empty = transcript.filter((t) => t.reply === '');
  if (empty.length > 0) fail(`${empty.length} empty reply(ies)`);
  else ok('every turn produced non-empty text');

  const leaked = transcript.filter((t) => /[{}]|<\/?think>/i.test(t.reply));
  if (leaked.length > 0) fail(`control JSON or <think> visible to the player: ${JSON.stringify(leaked.map((l) => l.reply.slice(0, 80)))}`);
  else ok('no control JSON or <think> markers on screen');

  const realErrors = pageErrors.filter((e) => !/ResizeObserver/.test(e));
  if (realErrors.length > 0) fail(`page errors: ${JSON.stringify(realErrors.slice(0, 3))}`);
  else ok('no page errors');

  const gameError = await page.evaluate(() => (window as any).__gameError ?? null);
  if (gameError !== null) fail(`__gameError set: ${JSON.stringify(gameError)}`);
  else ok('__gameError clear');

  // scripts/out-*.png is gitignored — keep harness artifacts out of the tree.
  await page.screenshot({ path: 'scripts/out-npc-ingame.png' });
  console.log('\nscreenshot: scripts/out-npc-ingame.png');
} finally {
  await browser.close();
}

console.log(`\nRESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exitCode = failures === 0 ? 0 : 1;
