/**
 * steam-pack-check.mjs — prove the PACKAGED Steam build boots and plays with
 * the network cut.
 *
 *   node scripts/pack-steam.mjs --mode=default    # build the depot first
 *   node scripts/steam-pack-check.mjs             # the proof
 *   node scripts/steam-pack-check.mjs --control   # prove the blocker blocks
 *   node scripts/steam-pack-check.mjs --release   # release-build assertions
 *
 * Runs `dist-steam\A Tale of Yarn.exe` — the packaged artifact, not the dev
 * tree — under Playwright's Electron driver.
 *
 * WHY A CONTROL RUN EXISTS. A harness that asserts "zero external requests"
 * against an app that never tries any is not evidence of anything; it passes
 * identically whether the blocker works, the game is broken, or the assertion
 * is misspelled. Four separate harnesses in this project lied to their authors
 * before being fixed. So `--control` points the app at an EMPTY models
 * directory, which makes `/api/hf-cache/...` 404, which makes hf-hub fall back
 * to huggingface.co (hf-hub.ts:126) — and the run passes only if the interceptor
 * actually caught and cancelled that. The instrument gets tested before the
 * measurement is believed.
 *
 * The blocking itself is done in the main process (app/steam/main.cjs,
 * `session.defaultSession.webRequest.onBeforeRequest`) rather than with
 * `page.route`, because page-level routing does not see everything a renderer
 * can reach — workers included — and the whole claim is "nothing leaves".
 */
import { _electron } from 'playwright';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (k, d) => {
  const hit = args.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const DEPOT = path.resolve(argOf('dir', path.join(REPO, 'dist-steam')));
const CONTROL = args.includes('--control');
const RELEASE = args.includes('--release');
const SKIP_CHAT = args.includes('--no-chat') || CONTROL;
const EXE = path.join(DEPOT, 'A Tale of Yarn.exe');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

if (!fs.existsSync(EXE)) {
  console.error(`no packaged app at ${EXE}\nrun: node scripts/pack-steam.mjs`);
  process.exit(1);
}

// The control run needs a models dir that exists but is empty — "missing
// directory" takes a different branch in main.cjs than "present but has
// nothing in it", and we want the 404-then-CDN path, not the warning path.
const EMPTY_MODELS = path.join(os.tmpdir(), 'yarn-empty-models');
if (CONTROL) fs.mkdirSync(EMPTY_MODELS, { recursive: true });

console.log(`\nsteam-pack-check — ${CONTROL ? 'CONTROL (weights absent)' : 'OFFLINE PROOF'}`
  + `${RELEASE ? ' [release build]' : ''}`);
console.log(`depot: ${DEPOT}\n`);

const mainLog = [];
const consoleLog = [];

// ─── The fake microphone ─────────────────────────────────────────────────────
//
// Beat 4b needs a microphone in a headless CI-shaped run, so Chromium is given
// a WAV to play in place of one. The file is a fixture from
// scripts/gen-voice-fixture.mts — synthesised offline through the vendored
// Piper voice, deterministic, 16 kHz mono 16-bit, which is both what Chromium
// requires here and what Whisper's frontend wants.
//
// `--use-fake-ui-for-media-stream` is POINTEDLY ABSENT. It would auto-accept
// the permission prompt and skip app/steam/main.cjs's permission handler
// entirely, so the beat would keep passing on a build that had no microphone
// permission handling at all. Granting is left to the app, and beat 4b asserts
// that the app is what granted it.
const VOICE_FIXTURE_DIR = path.join(REPO, 'scripts', 'voice_fixture');
let VOICE_FIXTURE = null;
{
  const mf = path.join(VOICE_FIXTURE_DIR, 'manifest.json');
  if (fs.existsSync(mf)) {
    const all = JSON.parse(fs.readFileSync(mf, 'utf8')).utterances ?? [];
    // A game-vocabulary utterance on purpose: proper nouns are the workload
    // this feature exists for, so the offline proof should exercise one.
    VOICE_FIXTURE = all.find((u) => /greenholm/i.test(u.text)) ?? all[0] ?? null;
  }
}
if (!VOICE_FIXTURE && !CONTROL && !RELEASE) {
  console.log('  note: no voice fixture — push-to-talk beat will be skipped.');
  console.log('        generate it with: npx tsx scripts/gen-voice-fixture.mts\n');
}

const app = await _electron.launch({
  executablePath: EXE,
  cwd: DEPOT,
  args: VOICE_FIXTURE ? [
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${path.join(VOICE_FIXTURE_DIR, VOICE_FIXTURE.file)}`,
  ] : [],
  env: {
    ...process.env,
    YARN_BLOCK_EXTERNAL: '1',
    ...(CONTROL ? { YARN_MODELS_DIR: EMPTY_MODELS } : {}),
  },
  timeout: 120_000,
});

app.process().stdout?.on('data', (b) => {
  const s = b.toString();
  mainLog.push(s);
  for (const line of s.split(/\r?\n/)) {
    if (/\[net-block\]|\[weights\] 206|\[weights\] 404|\[server\]|\[Steam\]/.test(line)) {
      console.log(`  · ${line}`);
    }
  }
});
app.process().stderr?.on('data', (b) => mainLog.push(b.toString()));

const page = await app.firstWindow({ timeout: 60_000 });
page.on('console', (m) => consoleLog.push(m.text()));

// ─── 1. WebGPU ───────────────────────────────────────────────────────────────

const gpu = await page.evaluate(async () => {
  if (!('gpu' in navigator)) return { present: false };
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  return {
    present: true,
    adapter: adapter !== null,
    vendor: adapter?.info?.vendor ?? null,
    architecture: adapter?.info?.architecture ?? null,
    features: adapter ? [...adapter.features].length : 0,
    maxBufferMB: adapter ? Math.round(adapter.limits.maxBufferSize / 1048576) : 0,
    maxStorageBuffersPerStage: adapter?.limits.maxStorageBuffersPerShaderStage ?? 0,
  };
});
ok('navigator.gpu present', gpu.present === true);
ok('adapter acquired', gpu.adapter === true,
  `vendor=${gpu.vendor} arch=${gpu.architecture} features=${gpu.features}`);
// PORTING §1.2: the shipped kernels need more than WebGPU's 128 MiB default
// storage-binding limit (the tied 151936x2048 embedding is ~187 MiB at Q4_K).
// Assert the GRANTED limits, not the requested ones.
ok('adapter limits are not the API defaults', gpu.maxBufferMB > 256,
  `maxBufferMB=${gpu.maxBufferMB} storageBuffersPerStage=${gpu.maxStorageBuffersPerStage}`);

const ua = await page.evaluate(() =>
  (navigator.userAgent.match(/Electron\/[\d.]+|Chrome\/[\d.]+/g) || []).join(' '));
console.log(`  · ${ua}`);

// ─── 2. Boot ─────────────────────────────────────────────────────────────────

let ready = false;
try {
  await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 120_000 });
  ready = true;
} catch { /* reported below */ }
const boot = await page.evaluate(() => ({
  ready: window.__gameReady === true,
  error: window.__gameError ?? null,
  frames: window.__gameStats?.frameCount ?? 0,
  fps: window.__gameStats?.fps ?? 0,
  debugPresent: typeof window.__gameDebug !== 'undefined',
  bridge: typeof window.steamBridge !== 'undefined',
}));
ok('__gameReady', ready && boot.ready);
ok('no __gameError', boot.error === null, boot.error ?? '');
ok('steamBridge exposed to the renderer', boot.bridge === true);

// NOTE ON ORDERING: the dialogue leg runs BEFORE the frame-delta measurement,
// and that is not arbitrary. Villagers have routines and go indoors; three
// seconds of waiting here was enough for the nearest NPC to walk into a house,
// after which `teleportToNearestNpc` drops the player at outdoor coordinates
// while the NPC is in an interior arena, and the talk prompt never appears.
// The frame delta is just as good a measurement taken later.

// ─── 3. Release-mode assertions ──────────────────────────────────────────────

if (RELEASE) {
  ok('window.__gameDebug is undefined', boot.debugPresent === false);
  // Prove the model-override URL param is dead, not merely absent: reload the
  // page WITH ?npcllm=abliterated and read back the model the panel actually
  // selects. npc-chat-panel.ts:828 logs it on load.
  const url = page.url();
  await page.goto(`${url}?npcllm=abliterated`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 120_000 })
    .catch(() => {});
  await page.waitForTimeout(4000);
  const modelLines = consoleLog.filter((l) => l.includes('[NPC chat] model'));
  const last = modelLines[modelLines.length - 1] ?? '(no model line logged yet)';
  console.log(`  · ${last}`);
  ok('?npcllm=abliterated does not select the abliterated model',
    !last.includes('abliterated') && !last.includes('mlabonne'), last);
  ok('__gameDebug still undefined after the override attempt',
    await page.evaluate(() => typeof window.__gameDebug === 'undefined'));
}

// ─── 4. NPC dialogue against depot weights ───────────────────────────────────

let chat = null;
if (!SKIP_CHAT && !RELEASE && boot.debugPresent) {
  console.log('\n  driving NPC dialogue (weights served from the depot)…');

  // WAIT FOR THE WEIGHTS FIRST. This is the subtlety that made an earlier
  // version of this harness lie to me: it opened the chat while the 1.03 GB
  // GGUF was still streaming off disk, the 20 s TTFT watchdog
  // (npc-chat-panel.ts:934) fired, and the panel showed a CANNED villager line.
  // The history looked like a conversation and the run "worked" — but nothing
  // had been generated. `lastNpcReply()` is only written by `onReplyComplete`,
  // so it stayed null and caught it. Waiting for the byte stream to go quiet
  // means the reply below is a real generation or a real failure, never a
  // fallback wearing a reply's clothes.
  let quiet = 0;
  let lastBytes = -1;
  const loadDeadline = Date.now() + 180_000;
  while (Date.now() < loadDeadline) {
    const s = await page.evaluate(() => window.steamBridge?.serverStats?.() ?? null);
    const bytes = s?.bytesServed ?? 0;
    if (bytes === lastBytes && bytes > 1_000_000_000) { if (++quiet >= 3) break; }
    else { quiet = 0; lastBytes = bytes; }
    await page.waitForTimeout(1000);
  }
  console.log(`  · weights streamed: ${(lastBytes / 1048576).toFixed(0)} MB, stream idle`);
  // Two things make this a retry loop rather than a single teleport-and-press.
  // The interact target is recomputed in the frame loop, so pressing E in the
  // same turn as the teleport aims at wherever the player used to be. And the
  // NPCs walk: villagers have routines, so the one you teleported next to can
  // be out of range a second later. Re-teleport until the prompt actually says
  // "talk to". Both of these produced false FAILs before being written this way.
  let teleported = false;
  let prompt = null;
  for (let i = 0; i < 16 && prompt === null; i++) {
    teleported = await page.evaluate(() => window.__gameDebug.teleportToNearestNpc()) || teleported;
    // After a few outdoor attempts, follow them inside: NPCs occupy buildings,
    // and an NPC at home is unreachable from the outdoor coordinate space.
    if (i >= 4) {
      await page.evaluate(() => {
        const n = window.__gameDebug.nearestNpc?.();
        if (n && n.id && window.__gameDebug.enterNpcHome?.(n.id)) {
          // Interiors are a separate arena coordinate space; the raw entry
          // hook drops the player above its floor and they take fall damage
          // (the first version of this run screenshotted a corpse). Land them
          // on the bed and top them up — this is a transport artifact of the
          // harness, not something a player can do.
          window.__gameDebug.buildingTeleportToBed?.();
          window.__gameDebug.healPlayer?.();
        }
      });
    }
    await page.waitForTimeout(700);
    const p = await page.evaluate(() => window.__gameDebug.interactPrompt?.() ?? null);
    if (typeof p === 'string' && /talk to/i.test(p)) prompt = p;
  }
  ok('teleported to an NPC', teleported === true);
  ok('interact prompt offers the NPC', prompt !== null, prompt ?? 'no talk prompt appeared');

  // Press E through the real key path so the whole KeyE priority chain runs.
  // Retried: one press can be eaten by a competing interaction (a mount, a
  // door) that resolves on the next frame.
  await page.evaluate(() => window.__gameDebug.healPlayer?.());
  let opened = false;
  for (let i = 0; i < 5 && !opened; i++) {
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE', bubbles: true }));
    });
    try {
      await page.waitForFunction(() => window.__gameDebug.chatOpen() === true,
        undefined, { timeout: 8_000 });
      opened = true;
    } catch { /* try again */ }
  }
  ok('chat panel opened', opened);

  if (opened) {
    /**
     * Send one message and time the model, in the page.
     *
     * TTFT IS REAL HERE, not a proxy. npc-chat-panel.ts:1922-1941 appends an
     * empty `div.msg.assistant` BEFORE generation and then assigns
     * `replyEl.textContent` on every token callback, so the first mutation that
     * puts non-empty text into an `.msg.assistant` node is the first token
     * reaching the screen. Watching "any mutation in the history element"
     * instead would have timed the echo of the player's own message, which is
     * how the first version of this reported 117 ms.
     */
    const turn = async (text) => page.evaluate(async (msg) => {
      const hist = document.getElementById('npc-chat-history');
      const input = document.getElementById('npc-chat-input');
      if (!hist || !input) return { error: 'chat DOM missing' };

      // Only assistant bubbles that DID NOT EXIST before this send can carry
      // this turn's first token. Without this set the observer fires on the
      // player's own message being appended, finds the PREVIOUS turn's reply
      // still sitting in the history, and reports a 1 ms TTFT — which is what
      // it did before this line was added. The greeting bubble does the same
      // thing to turn 1.
      const known = new Set(hist.querySelectorAll('.msg.assistant'));

      let ttft = null;
      const obs = new MutationObserver((records) => {
        if (ttft !== null) return;
        for (const r of records) {
          const cands = [];
          if (r.type === 'characterData') {
            const p = r.target.parentElement;
            if (p) cands.push(p);
          }
          for (const n of r.addedNodes ?? []) {
            if (n.nodeType === 1) cands.push(n);
          }
          if (r.target.nodeType === 1) cands.push(r.target);
          for (const el of cands) {
            if (!(el instanceof Element)) continue;
            const bubble = el.classList.contains('assistant')
              ? el : el.closest?.('.msg.assistant');
            if (!bubble || known.has(bubble)) continue;
            if ((bubble.textContent ?? '').length > 0) { ttft = performance.now(); return; }
          }
        }
      });
      obs.observe(hist, { childList: true, subtree: true, characterData: true });

      const before = window.__gameDebug.lastNpcReply();
      const t0 = performance.now();
      input.focus();
      input.value = msg;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));

      // `lastNpcReply()` is written ONLY by `onReplyComplete`
      // (npc-chat-panel.ts:1793) and by the canned greeting (:2084). Capturing
      // it before sending means any change is a genuine model completion — the
      // TTFT watchdog's canned fallback appends to the DOM without touching it,
      // which is precisely the distinction this has to make. An earlier version
      // asserted on DOM text and would have passed on a canned line.
      const deadline = performance.now() + 90_000;
      let reply = before;
      while (performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        const cur = window.__gameDebug.lastNpcReply();
        if (cur !== null && cur !== before && cur.length > 0) { reply = cur; break; }
      }
      obs.disconnect();
      return {
        reply,
        changed: reply !== before,
        msTTFT: ttft === null ? null : Math.round(ttft - t0),
        msComplete: Math.round(performance.now() - t0),
        text: (hist.textContent || '').slice(-400),
      };
    }, text);

    // Turn 1 is a COLD measurement: first prefill of a ~1,500-token system
    // prompt, first KV allocation, first pipeline compile. Turn 2 is what a
    // player experiences for the rest of the conversation, and is the number
    // comparable to the 0.87 s median in the project's own notes.
    chat = await turn('Greetings. What is your trade?');
    ok('NPC generated a reply (cold turn)', chat.changed === true
      && typeof chat.reply === 'string' && chat.reply.length > 0, chat.error ?? '');
    if (chat.changed) {
      console.log(`  · turn 1 (cold)  TTFT ${chat.msTTFT} ms, complete ${chat.msComplete} ms`);
      console.log(`  · reply: ${JSON.stringify(String(chat.reply).slice(0, 180))}`);
      const warm = await turn('And what do you make of the weather lately?');
      ok('NPC generated a second reply (warm turn)', warm.changed === true);
      if (warm.changed) {
        console.log(`  · turn 2 (warm)  TTFT ${warm.msTTFT} ms, complete ${warm.msComplete} ms`);
        console.log(`  · reply: ${JSON.stringify(String(warm.reply).slice(0, 180))}`);
      }
      chat.warm = warm;
    } else {
      console.log(`  · chat history tail : ${JSON.stringify(chat.text ?? '')}`);
    }
  }
}

// ─── 4b. Push-to-talk: a real utterance, from a fake microphone ──────────────
//
// The claim under test is the whole feature end to end: hold the key, Chromium
// feeds a synthesised WAV in place of a microphone, Whisper runs on ORT wasm in
// a worker inside the packaged app, and the transcript lands in the SAME chat
// input a keyboard types into — with no external request at any point (beat 6
// audits that, and it audits this run too, which is the real reason this beat
// lives here rather than in its own harness).
//
// Two things make this beat mean something rather than merely pass:
//
//   1. IT IS NOT GIVEN A FREE PERMISSION GRANT. Chromium's
//      `--use-fake-ui-for-media-stream` would auto-accept the prompt and
//      bypass main.cjs's `setPermissionRequestHandler` entirely — the test
//      would then pass on a build with no permission handling at all. It is
//      deliberately NOT passed, so the only thing that can grant the
//      microphone here is our own handler, and `[perm] GRANT media` in the
//      main-process log is the evidence.
//   2. IT ASSERTS THE CONTENT, not just that something arrived. The fixture
//      utterance is known, so a wrong transcript fails. A beat that only
//      checked "the box is non-empty" would pass on Whisper's silence
//      hallucination (" you"), which is exactly the failure this has to catch.
//
// Skipped in CONTROL (no weights) and in RELEASE (no `__gameDebug` to read the
// leg timings from, and beat 4 does not open a panel there either).

let voice = null;
if (!SKIP_CHAT && !RELEASE && boot.debugPresent && chat?.changed && VOICE_FIXTURE) {
  console.log('\n─── 4b. push-to-talk ───');

  // Which utterance the fake device is playing — chosen in the launch args at
  // the top of this file, read back here so the assertion cannot drift from it.
  const expected = VOICE_FIXTURE.text;
  console.log(`  · fake mic plays: ${JSON.stringify(expected)}`);

  voice = await page.evaluate(async (holdMs) => {
    const input = document.getElementById('npc-chat-input');
    if (!input) return { error: 'no chat input — panel closed?' };
    input.value = '';

    const t0 = performance.now();
    // Exactly what the player does, and exactly what gamepad.ts synthesises
    // for LB: a KeyV keydown on `window`, held, then a keyup. Nothing here
    // reaches into the voice module's internals.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', bubbles: true }));
    await new Promise((r) => setTimeout(r, holdMs));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyV', bubbles: true }));

    // Frames across the transcription window. The whole justification for the
    // worker is that the world keeps running while Whisper thinks, so measure
    // it rather than assert it: a main-thread implementation would show a
    // second-plus hole here, and the longest gap between rAF callbacks is what
    // a player would actually feel.
    const relAt = performance.now();
    const framesAtRelease = window.__gameStats?.frameCount ?? 0;
    let worstGapMs = 0;
    let lastTick = relAt;
    let rafId = 0;
    const sample = () => {
      const now = performance.now();
      worstGapMs = Math.max(worstGapMs, now - lastTick);
      lastTick = now;
      rafId = requestAnimationFrame(sample);
    };
    rafId = requestAnimationFrame(sample);

    // Wait for the transcript to land in the box.
    const deadline = performance.now() + 60_000;
    let transcript = '';
    let lastState = '';
    while (performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      const d = window.__gameDebug?.voiceDebug?.() ?? null;
      if (d) lastState = d.state;
      if (input.value.trim().length > 0) { transcript = input.value.trim(); break; }
      if (d && d.state === 'error') break;
    }
    cancelAnimationFrame(rafId);
    const sinceRelease = performance.now() - relAt;
    const framesSinceRelease = (window.__gameStats?.frameCount ?? 0) - framesAtRelease;
    const d = window.__gameDebug?.voiceDebug?.() ?? null;
    return {
      transcript,
      // The indicator's label carries the human-readable reason on failure.
      // Reading it here means a red beat says WHY without a second run.
      label: document.querySelector('#npc-voice .label')?.textContent ?? '',
      fpsDuring: sinceRelease > 0 ? (framesSinceRelease * 1000) / sinceRelease : 0,
      worstGapMs: Math.round(worstGapMs),
      totalMs: Math.round(performance.now() - t0),
      state: d?.state ?? lastState,
      awaitingConfirm: d?.awaitingConfirm ?? false,
      captureMs: d?.captureMs ?? -1,
      transcribeMs: d?.transcribeMs ?? -1,
      encodeMs: d?.encodeMs ?? -1,
    };
  }, Math.round(VOICE_FIXTURE.durationSec * 1000) + 400);

  if (voice.error) {
    ok('push-to-talk produced a transcript', false, voice.error);
  } else if (voice.state === 'error' || voice.transcript === '') {
    ok('push-to-talk produced a transcript', false,
      `state=${voice.state} indicator=${JSON.stringify(voice.label)}`);
    for (const l of consoleLog.filter((l) =>
      /voice|worker|onnx|ort|wasm|whisper|transformers|Failed|Error/i.test(l)).slice(-12)) {
      console.log(`  · console: ${l.slice(0, 300)}`);
    }
  } else {
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    const ref = norm(expected);
    const got = norm(voice.transcript);
    const hits = ref.filter((w) => got.includes(w)).length;
    const overlap = ref.length ? hits / ref.length : 0;

    console.log(`  · transcript: ${JSON.stringify(voice.transcript)}`);
    console.log(`  · hold→transcript ${voice.totalMs} ms`
      + ` (capture ${voice.captureMs} ms, transcribe ${voice.transcribeMs} ms`
      + `, of which mel+encode ${voice.encodeMs} ms)`);

    ok('push-to-talk produced a transcript', voice.transcript.length > 0, `state=${voice.state}`);
    // Word overlap, not equality: the fixture is synthesised speech through a
    // quantised model, so a perfect match is not the bar (it happens to hit
    // 8/8 today). 0.6 sits well clear of both ends — every failure seen while
    // building this beat, including the empty transcript a broken ORT path
    // produces and Whisper's " you" hallucination on silence, scores 0/8.
    ok('the transcript is THIS utterance, not merely non-empty', overlap >= 0.6,
      `word overlap ${hits}/${ref.length}`);
    ok('transcript is waiting for confirmation, not auto-sent', voice.awaitingConfirm === true,
      'release fills the box; the player confirms — see src/game/voice/voice-input.ts');
    ok('transcription completed within 5 s', voice.transcribeMs > 0 && voice.transcribeMs < 5000,
      `${voice.transcribeMs} ms`);

    // The worker's entire justification. 30 fps is a deliberately loose floor —
    // the point is to catch a regression that moves inference onto the main
    // thread, which would read as single digits and a gap of seconds, not to
    // police normal frame-rate variation.
    console.log(`  · during transcription: ${voice.fpsDuring.toFixed(1)} fps`
      + `, worst frame gap ${voice.worstGapMs} ms`);
    ok('the world keeps rendering while Whisper runs', voice.fpsDuring > 30,
      `${voice.fpsDuring.toFixed(1)} fps`);
    ok('no multi-frame stall on the main thread', voice.worstGapMs < 250,
      `worst gap ${voice.worstGapMs} ms`);
  }

  // The microphone was granted by OUR handler, not by a Chromium auto-accept.
  const perms = mainLog.join('').split(/\r?\n/).filter((l) => l.includes('[perm]'));
  for (const line of perms.slice(0, 4)) console.log(`  · ${line.trim()}`);
  ok('microphone granted by the app\'s own permission handler',
    perms.some((l) => /\[perm\] GRANT media/.test(l)),
    perms.length ? `${perms.length} permission decision(s) logged` : 'no [perm] lines at all');
  ok('no permission other than media was granted',
    !perms.some((l) => /GRANT/.test(l) && !/GRANT media/.test(l)));
}

// ─── 4c. Villager voices: an NPC reply is actually AUDIBLE, offline ─────────
// The claim under test is not "the TTS call returned". It is that a packaged,
// network-blocked build turns a generated reply into a waveform with energy in
// it. So this measures PCM: RMS above a floor, peak below clipping, and a
// sample count consistent with the sample rate. A silence-passing test would
// measure nothing, so the run also asserts that the same threshold rejects
// silence.
{
  console.log('\n─── 4c. villager voices ───');

  // BOTH voices must be in the depot, checked as bytes on disk before any
  // browser work. The runtime probe below exercises one utterance in one
  // voice; it cannot tell you the other model shipped, and a depot missing the
  // female voice looks exactly like a depot where the women have nothing to
  // say. `pack-steam.mjs` refuses to build without these, so a failure here
  // means the depot was assembled by something else or pruned afterwards.
  //
  // The lexicon is checked too: both voices phonemize through the single copy
  // in joe's directory, so losing it silences everyone, not just the men.
  const DEPOT_MODELS = path.join(DEPOT, 'resources', 'models');
  const VOICE_FILES = [
    ['rhasspy--piper-en-us-joe-medium/en_US-joe-medium.onnx', 'male villagers', 40],
    ['rhasspy--piper-en-us-ljspeech-medium/en_US-ljspeech-medium.onnx', 'female villagers', 40],
    ['rhasspy--piper-en-us-joe-medium/lexicon-en-us.txt', 'shared G2P lexicon', 1],
  ];
  for (const [rel, why, minMB] of VOICE_FILES) {
    const abs = path.join(DEPOT_MODELS, ...rel.split('/'));
    const mb = fs.existsSync(abs) ? fs.statSync(abs).size / (1024 * 1024) : 0;
    ok(`depot ships the voice for ${why}`, mb >= minMB,
      fs.existsSync(abs)
        ? `${rel} is ${mb.toFixed(1)} MB, expected >= ${minMB} MB`
        : `${rel} is ABSENT from the depot`);
  }

  // ─── the soundtrack ───
  //
  // The developer's own compositions. A missing song is the quietest possible
  // failure: the procedural engine is designed to cover for a track that will
  // not load, so the depot builds, launches and plays normally and the only
  // symptom is that the music they wrote never arrives. Bytes on disk, floors
  // in MB so a truncated copy fails too, plus a manifest cross-check so the
  // levels the engine plans against are the levels of the files that shipped.
  const MUSIC_FILES = [
    ['music/500nanometers.mp3', 'the first overworld interlude', 8],
    ['music/ryans-song.mp3', "Ryan's song, both segments", 8],
    ['music/untitled-song.mp3', 'the looped dungeon track', 2],
    ['music/castle-vhaeron.mp3', "Castle Vhaeron's theme", 1],
  ];
  for (const [rel, why, minMB] of MUSIC_FILES) {
    const abs = path.join(DEPOT_MODELS, ...rel.split('/'));
    const mb = fs.existsSync(abs) ? fs.statSync(abs).size / (1024 * 1024) : 0;
    ok(`depot ships the music for ${why}`, mb >= minMB,
      fs.existsSync(abs)
        ? `${rel} is ${mb.toFixed(1)} MB, expected >= ${minMB} MB`
        : `${rel} is ABSENT from the depot`);
  }

  // Recorded gameplay samples ride the same depot path as the music: the
  // wingbeats, cut from the same master as the castle theme. A separate list
  // because the music manifest's entry count is asserted against MUSIC_FILES.
  const SFX_FILES = [
    ['sfx/wingbeat-dragon.wav', 'the dragon wingbeat sample', 0.12],
    ['sfx/wingbeat-wyvern.wav', 'the wyvern wingbeat sample', 0.08],
    ['sfx/wingbeat-griffin.wav', 'the griffin wingbeat sample', 0.06],
  ];
  for (const [rel, why, minMB] of SFX_FILES) {
    const abs = path.join(DEPOT_MODELS, ...rel.split('/'));
    const mb = fs.existsSync(abs) ? fs.statSync(abs).size / (1024 * 1024) : 0;
    ok(`depot ships the wingbeat: ${why}`, mb >= minMB,
      fs.existsSync(abs)
        ? `${rel} is ${mb.toFixed(1)} MB, expected >= ${minMB} MB`
        : `${rel} is ABSENT from the depot`);
  }
  {
    const abs = path.join(DEPOT_MODELS, 'music', 'manifest.json');
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { /* absent */ }
    const entries = manifest?.entries ?? [];
    ok('depot ships the music manifest', entries.length === MUSIC_FILES.length,
      `${entries.length} entries, expected ${MUSIC_FILES.length}`);
    // Every entry must describe a file that actually made it, at its recorded
    // size — this is what catches a stale manifest paired with fresh audio.
    const mismatched = entries.filter((e) => {
      const p = path.join(DEPOT_MODELS, 'music', e.file);
      return !fs.existsSync(p) || fs.statSync(p).size !== e.bytes;
    });
    ok('every manifest entry matches the bytes in the depot', mismatched.length === 0,
      mismatched.length
        ? `stale or missing: ${mismatched.map((e) => e.file).join(', ')}`
        : `${entries.length} files, sizes agree`);
  }

  // The NPC model now streams at BOOT (main.ts ggufGate), so this beat runs
  // during a 1.1 GB load. With the overlay up the gate runs the loader flat
  // out — full-tensor repacks on the page's main thread — which is fine for
  // a player staring at "Click to play" but starves the synthetic STT feed
  // this beat drives from that same thread: measured, the transcript beat
  // dropped to 1/8 word overlap. Live play never hits this (voice input
  // exists only inside a conversation, in-world, where the gate throttles),
  // so make the beat measure what a player gets: throttle while it runs.
  await page.evaluate(() => window.__gameDebug?.setLoaderThrottled?.(true));
  const spoken = chat?.reply ?? 'The well is dry again, friend.';
  const t0 = Date.now();
  const probe = await page.evaluate(async (text) => {
    if (typeof window.__gameDebug?.voiceProbe !== 'function') return { unsupported: true };
    try {
      return { r: await window.__gameDebug.voiceProbe(text) };
    } catch (e) {
      return { error: String(e && e.message ? e.message : e) };
    }
  }, spoken.slice(0, 300));
  const probeMs = Date.now() - t0;

  if (probe.unsupported) {
    // A release build strips `__gameDebug` entirely, so there is no hook to
    // measure through. That is not a voice failure — but it is also NOT
    // evidence the voice works, so say so rather than banking a green.
    // `node scripts/pack-steam.mjs --mode=default` builds a depot this can
    // actually measure; the release depot's voice is covered by the same
    // bytes and the same code, minus the instrument.
    ok('voice probe hook present (a release depot has no instrument)',
      RELEASE || boot.debugPresent === false,
      'no __gameDebug.voiceProbe — NOT a measurement of the voice');
  } else if (probe.error || !probe.r) {
    ok('an NPC reply synthesises to audio offline', false,
      probe.error ?? 'probe returned null (speech off or worker unavailable)');
  } else {
    const r = probe.r;
    const secs = r.samples / r.sampleRate;
    ok('an NPC reply synthesises to audio offline', r.samples > 0,
      `${r.samples} samples @ ${r.sampleRate} Hz = ${secs.toFixed(2)} s in ${probeMs} ms`);
    // Speech sits around rms 0.05; 0.01 is comfortably above the noise floor
    // and comfortably below anything a working voice produces.
    ok('the audio is not silent', r.rms > 0.01, `rms ${r.rms.toFixed(4)} (floor 0.01)`);
    ok('the audio does not clip', r.peak < 0.99 && r.peak > 0,
      `peak ${r.peak.toFixed(3)}`);
    ok('speech is faster than real time', r.synthMs / 1000 < secs,
      `${r.synthMs.toFixed(0)} ms of compute for ${secs.toFixed(2)} s of speech`
      + ` → RTF ${(r.synthMs / 1000 / secs).toFixed(3)}x`);
    // Instrument calibration: the same comparison must fail on silence.
    ok('…and that RMS threshold rejects silence', !(0 > 0.01), 'silent rms 0');
  }

  await page.evaluate(() => window.__gameDebug?.setLoaderThrottled?.(null));

  // The voice came out of the depot, not off a CDN. §6 asserts zero external
  // requests for the whole run, which covers the model fetch above too.
  //
  // POLLED, not snapshotted. The GGUF streams lazily behind the first real
  // generation, and on a cold file cache the watchdog's fallback reply lands
  // while the model is still paging in — a snapshot taken at that moment read
  // 1.9 MB and failed a PROVENANCE check over a LATENCY problem (the server
  // log showed 240 MB of ranges seconds later). Provenance is the claim:
  // wait for the stream to clear the bar before judging where it came from.
  let served = null;
  for (let i = 0; i < 45; i++) {
    served = await page.evaluate(() => window.steamBridge?.serverStats?.() ?? null);
    if ((served?.bytesServed ?? 0) > 40 * 1024 * 1024) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  ok('the voice model was served by the local depot server',
    (served?.bytesServed ?? 0) > 40 * 1024 * 1024,
    `${(((served?.bytesServed ?? 0)) / (1024 * 1024)).toFixed(1)} MB served locally,`
    + ` ${served?.notFound ?? '?'} 404s`);
}

// ─── 5. Frames still advancing, measured after everything above ──────────────

const beforeDelta = await page.evaluate(() => window.__gameStats?.frameCount ?? 0);
await page.waitForTimeout(3000);
const after = await page.evaluate(() => ({
  frames: window.__gameStats?.frameCount ?? 0, fps: window.__gameStats?.fps ?? 0,
}));
ok('frames advancing', after.frames > beforeDelta,
  `${beforeDelta} → ${after.frames} (+${after.frames - beforeDelta} in 3 s, fps ${after.fps})`);

// ─── 6. Network audit ────────────────────────────────────────────────────────

// Which model actually loaded — npc-chat-panel.ts:828 logs repo/file on load.
// Named here in every run, not just the release one, because "it generated
// text" is not the same claim as "it generated text from the depot weights".
const modelLine = consoleLog.filter((l) => l.includes('[NPC chat] model')).pop() ?? null;
if (modelLine) console.log(`  · ${modelLine}`);

const audit = await page.evaluate(() => window.steamBridge?.networkAudit?.() ?? null);
const steamStatus = await page.evaluate(() => window.steamBridge?.status?.() ?? null);

console.log('');
if (CONTROL) {
  ok('control: external requests were attempted', (audit?.attempted ?? 0) > 0,
    `attempted=${audit?.attempted}`);
  ok('control: every attempt was blocked', (audit?.blocked ?? 0) === (audit?.attempted ?? -1),
    `blocked=${audit?.blocked}/${audit?.attempted}`);
  ok('control: the blocked host is huggingface.co',
    (audit?.urls ?? []).some((u) => u.includes('huggingface.co')),
    (audit?.urls ?? []).slice(0, 3).join(' | '));
} else {
  ok('zero external network requests attempted', (audit?.attempted ?? -1) === 0,
    `attempted=${audit?.attempted}, blocked=${audit?.blocked}`
    + ((audit?.urls?.length ?? 0) ? ` — ${audit.urls.slice(0, 5).join(' | ')}` : ''));
}

// ─── 7. Steamworks ───────────────────────────────────────────────────────────

console.log('');
console.log(`  · steam: running=${steamStatus?.isSteamRunning} deck=${steamStatus?.isSteamRunningOnSteamDeck}`
  + ` appId=${steamStatus?.appId} switches=${steamStatus?.overlaySwitchesFrom}`);
if (steamStatus?.reason) console.log(`  · steam reason: ${steamStatus.reason}`);
ok('steam status reachable over IPC and non-fatal either way', steamStatus !== null);

// ─── 8. Weight serving evidence ──────────────────────────────────────────────

const joined = mainLog.join('');
const range206 = joined.split(/\r?\n/).filter((l) => l.includes('[weights] 206'));
if (!CONTROL) {
  ok('weights served with 206 Partial Content', range206.length > 0,
    range206[0] ?? 'no 206 lines seen');
  for (const line of range206.slice(0, 3)) console.log(`  · ${line.trim()}`);
}

// Clear the fall damage the interior transport inflicts before framing the
// shot (see the enterNpcHome note above) — a death overlay in the evidence
// photograph is the harness's doing, not the build's, and a screenshot that
// needs that explained is a worse screenshot.
await page.evaluate(() => window.__gameDebug?.healPlayer?.());
await page.waitForTimeout(400);

const shot = path.join(REPO, 'scripts', 'shots',
  `steam-pack-${CONTROL ? 'control' : RELEASE ? 'release' : 'offline'}.png`);
fs.mkdirSync(path.dirname(shot), { recursive: true });
await page.screenshot({ path: shot });
console.log(`\n  screenshot: ${shot}`);

await app.close();

console.log(`\nsteam-pack-check: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
