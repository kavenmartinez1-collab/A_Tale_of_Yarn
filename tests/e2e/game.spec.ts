/**
 * Game smoke test — loads /game.html headless and asserts the render loop
 * is alive and error-free. Catches WGSL compile/validation errors via the
 * uncapturederror → window.__gameError hook (tsc cannot validate WGSL).
 *
 * Deliberately independent of pointer lock (no user gesture headless).
 */

import { test, expect } from '@playwright/test';

declare global {
  interface Window {
    __gameReady?: boolean;
    __gameStats?: {
      frameCount: number;
      fps: number;
      chunkCount: number;
      playerPos?: [number, number, number];
      grounded?: boolean;
      weather?: string;
    };
    __gameError?: string | null;
    __gameDebug?: {
      customization(): { shirtColor: [number, number, number] };
    };
  }
}

test('game renders frames without GPU errors', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto('/game.html?director=off');

  // First successful frame sets __gameReady (device init + pipeline compile).
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });

  const statsA = await page.evaluate(() => window.__gameStats);
  await page.waitForTimeout(2_000);
  const statsB = await page.evaluate(() => window.__gameStats);
  const gameError = await page.evaluate(() => window.__gameError);

  expect(gameError).toBeNull();
  expect(pageErrors).toEqual([]);
  expect(statsA).toBeTruthy();
  expect(statsB!.frameCount).toBeGreaterThan(statsA!.frameCount);
  // Terrain chunks must be streaming in.
  expect(statsB!.chunkCount).toBeGreaterThan(0);

  // Visual artifact for eyeballing render output.
  await page.screenshot({ path: 'test-results/game-frame.png' });
});

test('night rain renders without GPU errors', async ({ page }) => {
  // ?tod=0 (midnight: stars path) + ?weather=rain (rain overlay pipeline) —
  // the only coverage of these draw paths; default sessions start clear/day.
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto('/game.html?director=off&tod=0&weather=rain');
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });

  const statsA = await page.evaluate(() => window.__gameStats);
  await page.waitForTimeout(1_500);
  const statsB = await page.evaluate(() => window.__gameStats);
  const gameError = await page.evaluate(() => window.__gameError);

  expect(gameError).toBeNull();
  expect(pageErrors).toEqual([]);
  expect(statsB!.frameCount).toBeGreaterThan(statsA!.frameCount);
  expect(statsB!.weather).toBe('rain');

  await page.screenshot({ path: 'test-results/game-night-rain.png' });
});

test('character customization persists across reload', async ({ page }) => {
  await page.goto('/game.html?director=off');
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });

  const defaultShirt = await page.evaluate(
    () => window.__gameDebug!.customization().shirtColor);

  // C opens the panel (window-level keybind, no pointer lock needed).
  await page.keyboard.press('c');
  await expect(page.locator('#character-panel')).toBeVisible();

  // Pick the second shirt swatch (red — differs from the default blue).
  await page.click('[data-row="shirt"] .swatch:nth-child(2)');
  const changedShirt = await page.evaluate(
    () => window.__gameDebug!.customization().shirtColor);
  expect(changedShirt).not.toEqual(defaultShirt);

  // C again closes the panel.
  await page.keyboard.press('c');
  await expect(page.locator('#character-panel')).toHaveCount(0);

  // Reload: choice must come back from localStorage.
  await page.reload();
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });
  const reloadedShirt = await page.evaluate(
    () => window.__gameDebug!.customization().shirtColor);
  expect(reloadedShirt).toEqual(changedShirt);

  const gameError = await page.evaluate(() => window.__gameError);
  expect(gameError).toBeNull();
});

test('player walks on terrain without falling through', async ({ page }) => {
  await page.goto('/game.html?director=off');
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });

  // Wait for the spawn drop to settle on the ground.
  await page.waitForFunction(() => window.__gameStats?.grounded === true, undefined, {
    timeout: 10_000,
  });
  const before = await page.evaluate(() => window.__gameStats!.playerPos!);

  // Walk forward ~3 s (input listeners are window-level, no pointer lock needed).
  await page.keyboard.down('w');
  await page.waitForTimeout(3_000);
  await page.keyboard.up('w');
  await page.waitForTimeout(600); // let stats refresh + land

  const after = await page.evaluate(() => window.__gameStats!.playerPos!);
  const grounded = await page.evaluate(() => window.__gameStats!.grounded);
  const gameError = await page.evaluate(() => window.__gameError);

  const horiz = Math.hypot(after[0] - before[0], after[2] - before[2]);
  expect(gameError).toBeNull();
  expect(horiz).toBeGreaterThan(5);     // actually moved (~18 m at 6 m/s)
  expect(grounded).toBe(true);          // still on the ground
  expect(after[1]).toBeGreaterThan(-50); // never fell through the world
});
