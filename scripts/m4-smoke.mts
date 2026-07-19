/**
 * M4 — live Director smoke in the real game (real model, no mocks).
 * Requires `npm run dev`. Drives game.html?director=on end to end:
 *
 *   ready → entrance discovered (fixture name) → model loads → spec resolves
 *   (generation > 0, entrance renamed) → enter dungeon → reload → same name
 *   from localStorage with zero generations → no __gameError / pageerrors.
 *
 * Samples __gameStats.fps every 500 ms so the load/prefill/decode phases get
 * a quantitative frame-rate record (headless numbers are indicative only).
 *
 * Run: npx tsx scripts/m4-smoke.mts [--headed]
 */
import { chromium } from '@playwright/test';

const BASE = 'http://127.0.0.1:5173';
const headed = process.argv.includes('--headed');

const browser = await chromium.launch({
  channel: 'chrome', headless: !headed,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

try {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (/\[Director\]|error/i.test(t)) console.log(`[page] ${t}`);
  });
  await page.addInitScript('globalThis.__name = (f) => f;');

  await page.goto(`${BASE}/game.html?director=on`);
  await page.waitForFunction('window.__gameReady === true', undefined, { timeout: 30_000 });

  // fps sampler (phase-tagged by director status).
  const samples: { fps: number; status: string }[] = [];
  const sampler = setInterval(() => {
    void page.evaluate(
      '({ fps: window.__gameStats?.fps ?? null, status: window.__gameStats?.directorStatus })',
    ).then((s) => {
      const v = s as { fps: number | null; status: string };
      if (typeof v.fps === 'number') samples.push({ fps: v.fps, status: v.status });
    }).catch(() => {});
  }, 500);

  const firstName = await page.evaluate('window.__gameDebug.nearestDungeonName()');
  check('entrance discovered', firstName !== null, String(firstName));

  // Walk up to the door and press E: blocked with the "dreams" notice, and the
  // nearest cell's job jumps to the queue front (the real player flow).
  const atDoor = await page.evaluate('window.__gameDebug.teleportToNearestEntrance()');
  check('teleported to entrance', atDoor === true);
  await page.waitForFunction(
    'window.__gameStats?.interactPrompt?.includes("enter")', undefined, { timeout: 5_000 });
  await page.evaluate(
    'window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyE" }))');
  await page.waitForFunction(
    'window.__gameStats?.notice?.includes("Director dreams")', undefined, { timeout: 5_000 });
  check('door blocked while dreaming', true);

  console.log('waiting for the real model to load and this cell\'s spec to resolve…');
  const t0 = Date.now();
  await page.waitForFunction(
    `window.__gameDebug.nearestDungeonName() !== ${JSON.stringify(firstName)}`, undefined, {
    timeout: 240_000, polling: 1000,
  });
  const genSecs = (Date.now() - t0) / 1000;
  const llmName = await page.evaluate('window.__gameDebug.nearestDungeonName()');
  check('entrance renamed by LLM', true, `${genSecs.toFixed(0)}s: ${firstName} → "${llmName}"`);

  const stored = await page.evaluate(
    'Object.keys(localStorage).filter((k) => k.startsWith("artifex-director:")).length');
  check('spec persisted', (stored as number) > 0, `${stored} key(s)`);

  const entered = await page.evaluate('window.__gameDebug.enterNearestDungeon()');
  check('entered dungeon', entered === true);
  await page.waitForFunction('window.__gameStats?.insideDungeon === true');

  clearInterval(sampler);

  // Reload: same dungeon, from storage, no generation.
  await page.reload();
  await page.waitForFunction('window.__gameReady === true', undefined, { timeout: 30_000 });
  await page.waitForTimeout(2000); // give a wrong-path generation a chance to start
  const nameAfter = await page.evaluate('window.__gameDebug.nearestDungeonName()');
  check('reload keeps LLM name', nameAfter === llmName, String(nameAfter));
  const genAfter = await page.evaluate('window.__gameDebug.directorGeneration()');
  check('no regeneration after reload', genAfter === 0, `generation=${genAfter}`);

  const gameError = await page.evaluate('window.__gameError');
  check('no __gameError', gameError === null, String(gameError));
  check('no pageerrors', pageErrors.length === 0, pageErrors.join('; '));

  // fps report by phase.
  const phases = new Map<string, number[]>();
  for (const s of samples) {
    const arr = phases.get(s.status) ?? [];
    arr.push(s.fps);
    phases.set(s.status, arr);
  }
  console.log('\nfps by director phase (headless — indicative):');
  for (const [status, fps] of phases) {
    const avg = fps.reduce((a, b) => a + b, 0) / fps.length;
    console.log(`  ${status}: avg ${avg.toFixed(0)}, min ${Math.min(...fps).toFixed(0)} (${fps.length} samples)`);
  }

  console.log(`\n${failures === 0 ? 'M4 smoke PASS' : `M4 smoke FAIL (${failures})`}`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await browser.close();
}
