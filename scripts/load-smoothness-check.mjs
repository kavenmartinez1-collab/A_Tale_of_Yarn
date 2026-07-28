/**
 * Load-smoothness check — the instrument behind the "weird slow loading" fix.
 *
 *   node scripts/load-smoothness-check.mjs
 *
 * What it proves, in order:
 *   1. boot() publishes phase timings (the stall map exists at all);
 *   2. the NPC model load STARTS AT BOOT — not at the first conversation,
 *      not at the 350 m settlement fence;
 *   3. under the throttled gate (the live-play mode), the load makes
 *      progress WITHOUT owning the frame: p95 frame time stays playable and
 *      the >100 ms spike count stays near zero. This is the beat that fails
 *      on the old single-shot loader, whose multi-hundred-MB main-thread
 *      repacks were the reported glitches;
 *   4. the load completes and the chat function goes 'ready' — the 11 s
 *      first-conversation stall has nowhere left to live.
 *
 * Needs the dev server on :5173 and a WebGPU-capable Chrome.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] || 'scripts/shots/load-smoothness';
fs.mkdirSync(outDir, { recursive: true });

let bugs = 0;
const note = (kind, what, detail = '') => {
  process.stdout.write(`  ${kind === 'ok' ? 'ok  ' : 'BUG '} ${what}\n`);
  if (detail) process.stdout.write(`       ${detail}\n`);
  if (kind !== 'ok') bugs++;
};

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11',
    '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 620 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`));

// deliberately NOT ?director=off — this check exists to watch the LLM load.
await page.goto('http://localhost:5173/game.html?tod=0.45&weather=clear',
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, null, { timeout: 90000 });
const D = (fn, arg) => page.evaluate(fn, arg);

process.stdout.write('\n=== 1. boot timings exist ===\n');
const marks = await D(() => window.__gameDebug.bootTimings());
if (!Array.isArray(marks) || marks.length < 3) {
  note('BUG', 'boot() published no phase timings', JSON.stringify(marks));
} else {
  const names = marks.map(([n]) => n);
  process.stdout.write(`       ${marks.map(([n, ms]) => `${n} ${ms}ms`).join(' → ')}\n`);
  note(names.includes('first-frame') ? 'ok' : 'BUG',
    'boot marks include first-frame', names.join(', '));
}

process.stdout.write('\n=== 2. model load starts at boot ===\n');
// Poll briefly: the preload fires inside boot(), before the first frame, but
// its first observable state transition can land a beat later.
let ml = null;
for (let i = 0; i < 20; i++) {
  ml = await D(() => window.__gameDebug.npcModelLoad());
  if (ml.state !== 'idle') break;
  await page.waitForTimeout(500);
}
if (ml.state === 'idle') {
  note('BUG', 'NPC model load never started at boot',
    'still idle 10 s after first frame — the cold start is back at first-talk');
} else {
  note('ok', `model load underway without any player action (${ml.state}, ${(ml.frac * 100).toFixed(0)}%)`);
}

process.stdout.write('\n=== 3. throttled load keeps the frame ===\n');
await D(() => window.__gameDebug.setLoaderThrottled(true));
const before = await D(() => window.__gameDebug.npcModelLoad());
if (before.state === 'ready') {
  process.stdout.write('       (load finished before the throttle window — machine too fast; skipping the frame beat)\n');
} else {
  // Sample real rAF deltas for 6 s while the throttled load runs.
  const stats = await D(() => new Promise((resolve) => {
    const deltas = [];
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      deltas.push(now - last);
      last = now;
      if (deltas.length >= 360) {
        deltas.sort((a, b) => a - b);
        resolve({
          n: deltas.length,
          p50: deltas[Math.floor(deltas.length * 0.5)],
          p95: deltas[Math.floor(deltas.length * 0.95)],
          worst: deltas[deltas.length - 1],
          over50: deltas.filter((d) => d > 50).length,
          over100: deltas.filter((d) => d > 100).length,
        });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  const after = await D(() => window.__gameDebug.npcModelLoad());
  process.stdout.write(`       ${stats.n} frames: p50 ${stats.p50.toFixed(1)}ms  p95 ${stats.p95.toFixed(1)}ms  `
    + `worst ${stats.worst.toFixed(0)}ms  >50ms: ${stats.over50}  >100ms: ${stats.over100}\n`);
  process.stdout.write(`       load progress through the window: ${(before.frac * 100).toFixed(0)}% → ${(after.frac * 100).toFixed(0)}%\n`);
  if (stats.over100 > 2) {
    note('BUG', 'loader owns the frame while throttled',
      `${stats.over100} frames over 100 ms in 6 s — the single-shot repack is back`);
  } else if (stats.p95 > 40) {
    note('BUG', 'throttled load p95 above playable', `${stats.p95.toFixed(1)} ms`);
  } else {
    note('ok', `frames stay playable under load (p95 ${stats.p95.toFixed(1)} ms, ${stats.over100} spikes)`);
  }
  if (after.state !== 'ready' && !(after.frac > before.frac)) {
    note('BUG', 'throttled loader made no progress',
      `${(before.frac * 100).toFixed(0)}% → ${(after.frac * 100).toFixed(0)}% in 6 s of granted frames`);
  } else {
    note('ok', 'loader progresses one slice per frame');
  }
}

process.stdout.write('\n=== 4. load completes; chat goes ready ===\n');
await D(() => window.__gameDebug.setLoaderThrottled(null));
let ready = null;
for (let i = 0; i < 240; i++) {
  ready = await D(() => window.__gameDebug.npcModelLoad());
  if (ready.state === 'ready' || ready.state === 'error') break;
  await page.waitForTimeout(1000);
}
if (ready.state !== 'ready') {
  note('BUG', 'model never reached ready', `state=${ready.state} frac=${ready.frac}`);
} else {
  note('ok', 'villager minds resident — first conversation pays no cold start');
}
await page.screenshot({ path: path.join(outDir, '01-after-load.png') });

process.stdout.write('\n--- summary ---\n');
process.stdout.write(`${bugs} bug(s), ${errors.length} page error(s)\n`);
for (const e of errors.slice(0, 5)) process.stdout.write(`  ${e}\n`);
await browser.close();
process.exit(bugs > 0 || errors.length > 0 ? 1 : 0);
