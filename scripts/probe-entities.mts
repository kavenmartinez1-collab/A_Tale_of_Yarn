/**
 * Probe live entities near a position for visual debugging.
 * Run:  npx tsx scripts/probe-entities.mts [x] [z]
 */
import { chromium } from '@playwright/test';

const x = Number(process.argv[2] ?? 300);
const z = Number(process.argv[3] ?? 300);

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://localhost:5173/game.html?tod=0.5');
await page.waitForFunction('window.__gameReady === true', null, { timeout: 30_000 });
await page.evaluate(([tx, tz]) => (window as any).__gameDebug.teleport(tx, tz), [x, z]);
await page.waitForTimeout(4000);
const ents = await page.evaluate(() => (window as any).__gameDebug.entities());
for (const e of ents) {
  const pos = e.pos ?? [e.x, e.y, e.z];
  console.log(JSON.stringify({ species: e.species, pos, state: e.state ?? e.mode }));
}
console.log(`total: ${ents.length}`);
await browser.close();
