/**
 * Grab game screenshots for visual debugging.
 * Run:  npx tsx scripts/screenshot-game.mts [tod] [outName] [x] [z] [camYaw] [camPitch] [camDist]
 * Requires the dev server on :5173 (npm run dev).
 */
import { chromium } from '@playwright/test';

const tod = process.argv[2] ?? '0.5';
const out = process.argv[3] ?? `shot-tod${tod}`;
const x = process.argv[4];
const z = process.argv[5];
const camYaw = process.argv[6];
const camPitch = process.argv[7];
const camDist = process.argv[8];

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => {
  if (m.type() === 'error') console.error('[page]', m.text());
});
await page.goto(`http://localhost:5173/game.html?tod=${tod}`);
await page.waitForFunction('window.__gameReady === true', null, { timeout: 30_000 });
if (x !== undefined && z !== undefined) {
  await page.evaluate(
    ([tx, tz]) => (window as any).__gameDebug.teleport(tx, tz),
    [Number(x), Number(z)],
  );
}
if (camYaw !== undefined && camPitch !== undefined && camDist !== undefined) {
  await page.evaluate(
    ([cy, cp, cd]) => (window as any).__gameDebug.setCamera(cy, cp, cd),
    [Number(camYaw), Number(camPitch), Number(camDist)],
  );
}
// Let chunks stream in and the frame loop settle.
await page.waitForTimeout(9000);
await page.screenshot({ path: `test-results/${out}.png` });
await browser.close();
console.log(`saved test-results/${out}.png`);
