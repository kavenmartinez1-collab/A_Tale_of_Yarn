/**
 * Smoke test for the live debug-capture channel (F8/F9 → /api/capture →
 * scripts/shots/live/). Boots the game headless, presses F8, and asserts a
 * png+json pair landed. Requires the dev server on :5173.
 *
 * Run:  npx tsx scripts/test-live-capture.mts
 */

import { chromium } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://localhost:5173/game.html?director=off&tod=0.35&weather=clear');
await page.waitForFunction(() => (window as any).__gameReady === true, undefined,
  { timeout: 30_000 });
await page.waitForTimeout(500);
await page.keyboard.press('F8');
await page.waitForTimeout(1500);

const list: string[] = await page.evaluate(() =>
  fetch('/api/capture').then((r) => r.json()));
await browser.close();

if (list.length === 0) throw new Error('no captures listed by /api/capture');
const latest = `scripts/shots/live/${list[0]}`;
const json = latest.replace(/\.png$/, '.json');
if (!existsSync(latest) || !existsSync(json)) {
  throw new Error(`capture files missing: ${latest}`);
}
const state = JSON.parse(readFileSync(json, 'utf-8'));
if (state?.stats?.frameCount === undefined) {
  throw new Error('state json missing stats.frameCount');
}
const pngBytes = readFileSync(latest);
if (pngBytes.length < 10_000) {
  throw new Error(`png suspiciously small (${pngBytes.length} B) — blank canvas?`);
}
console.log(`ok: ${latest} (${pngBytes.length} B), state tag=${state.equipped}, ` +
  `pos=${state.controller.pos.map((n: number) => n.toFixed(1)).join(',')}`);
