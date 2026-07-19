/**
 * Probe — reproduce the user's "Click to play does nothing" report.
 * Stock Chrome (NO --enable-unsafe-webgpu / angle flags), headed, real click.
 * Reports: __gameReady/__gameError, HUD text, overlay state, pointer lock
 * result, pointerlockerror events, console errors.
 *
 * Run: npx tsx scripts/probe-clicktoplay.mts
 */
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ channel: 'chrome', headless: false });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`console.${m.type()}: ${m.text()}`);
  });
  await page.addInitScript(
    'document.addEventListener("pointerlockerror", () => { globalThis.__plError = true; });');

  await page.goto('http://127.0.0.1:5173/game.html');

  // Wait up to 30 s for init; report whichever state we land in.
  const ready = await page
    .waitForFunction('window.__gameReady === true', undefined, { timeout: 30_000 })
    .then(() => true).catch(() => false);
  console.log(`__gameReady: ${ready}`);
  console.log(`__gameError: ${await page.evaluate('window.__gameError')}`);
  console.log(`HUD: ${JSON.stringify(await page.evaluate(
    'document.getElementById("hud")?.textContent'))}`);

  // Real click in the middle of the overlay.
  const vp = page.viewportSize()!;
  await page.mouse.click(vp.width / 2, vp.height / 2);
  await page.waitForTimeout(1500);

  console.log(`pointerLockElement: ${await page.evaluate(
    'document.pointerLockElement?.id ?? null')}`);
  console.log(`pointerlockerror fired: ${await page.evaluate('globalThis.__plError === true')}`);
  console.log(`overlay hidden: ${await page.evaluate(
    'document.getElementById("overlay")?.classList.contains("hidden")')}`);
  console.log(`errors:\n${errors.length ? errors.join('\n') : '  (none)'}`);
} finally {
  await browser.close();
}
