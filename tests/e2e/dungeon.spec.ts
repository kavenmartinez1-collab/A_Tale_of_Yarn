/**
 * Dungeon e2e — validates the dungeon WGSL/pipeline on a real GPU (tsc
 * cannot validate WGSL; uncapturederror → window.__gameError is the gate).
 *
 * M2: preview mode renders the interior without GPU errors.
 * M3: enter → walk (wall collision) → exit round trip via __gameDebug hooks.
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
      insideDungeon?: boolean;
      interactPrompt?: string | null;
      chestsOpened?: number;
    };
    __gameError?: string | null;
    __gameDebug?: {
      enterNearestDungeon(): boolean;
      teleportToExitPortal(): void;
      teleportToNearestChest(): boolean;
      playerPos(): [number, number, number];
    };
  }
}

test('dungeon preview renders interior without GPU errors', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto('/game.html?dungeon=preview&director=off');
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

  // Visual artifact: interior from the spawn cell (fly cam).
  await page.screenshot({ path: 'test-results/dungeon-preview.png' });
});

test('enter, walk, and exit a dungeon', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto('/game.html?director=off');
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });

  // Enter the nearest scattered entrance (deterministic from WORLD_SEED).
  const entered = await page.evaluate(() => window.__gameDebug!.enterNearestDungeon());
  expect(entered).toBe(true);
  await page.waitForFunction(() => window.__gameStats?.insideDungeon === true);

  // Spawned on the interior floor at the slot arena (y = -300).
  const spawnPos = await page.evaluate(() => window.__gameDebug!.playerPos());
  expect(spawnPos[1]).toBeLessThan(-250);

  // Walk forward for 1 s: must move but stay on the flat interior floor.
  await page.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' })));
  await page.waitForTimeout(1_000);
  await page.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' })));
  const walkedPos = await page.evaluate(() => window.__gameDebug!.playerPos());
  const moved = Math.hypot(walkedPos[0] - spawnPos[0], walkedPos[2] - spawnPos[2]);
  expect(moved).toBeGreaterThan(0.5);
  expect(Math.abs(walkedPos[1] - spawnPos[1])).toBeLessThan(0.01);

  // Visual artifact: third-person interior with collision-clamped camera.
  await page.screenshot({ path: 'test-results/dungeon-inside.png' });

  // Keep walking into the wall: slide must never escape the interior. The
  // entrance room is ≤13 cells wide, so 3 s at 6 m/s guarantees wall contact.
  await page.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' })));
  await page.waitForTimeout(3_000);
  await page.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' })));
  const stillInside = await page.evaluate(() => window.__gameStats?.insideDungeon);
  expect(stillInside).toBe(true);

  // Teleport onto the exit portal cell, let a frame refresh the prompt, E out.
  await page.evaluate(() => window.__gameDebug!.teleportToExitPortal());
  await page.waitForFunction(() =>
    window.__gameStats?.interactPrompt?.includes('leave'), undefined, {
    timeout: 5_000,
  });
  await page.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE' })));
  await page.waitForFunction(() => window.__gameStats?.insideDungeon === false);

  // Back on the surface near the entrance.
  const surfacePos = await page.evaluate(() => window.__gameDebug!.playerPos());
  expect(surfacePos[1]).toBeGreaterThan(-50);

  // Visual artifact: sun-lit entrance arch (surface shader path).
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/dungeon-entrance.png' });

  const gameError = await page.evaluate(() => window.__gameError);
  expect(gameError).toBeNull();
  expect(pageErrors).toEqual([]);
});

test('torch lighting renders and a chest can be looted', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto('/game.html?director=off');
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });

  const entered = await page.evaluate(() => window.__gameDebug!.enterNearestDungeon());
  expect(entered).toBe(true);
  await page.waitForFunction(() => window.__gameStats?.insideDungeon === true);

  // Visual artifact: torch-lit interior mood.
  await page.screenshot({ path: 'test-results/dungeon-torchlit.png' });

  // Every fixture has a treasure room, so a chest always exists.
  const atChest = await page.evaluate(() =>
    window.__gameDebug!.teleportToNearestChest());
  expect(atChest).toBe(true);
  await page.waitForFunction(() =>
    window.__gameStats?.interactPrompt?.includes('open'), undefined, {
    timeout: 5_000,
  });
  await page.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE' })));
  await page.waitForFunction(() => (window.__gameStats?.chestsOpened ?? 0) > 0);

  // The opened chest no longer prompts (palette swapped, marked opened).
  await page.waitForFunction(() =>
    !window.__gameStats?.interactPrompt?.includes('open'));

  const gameError = await page.evaluate(() => window.__gameError);
  expect(gameError).toBeNull();
  expect(pageErrors).toEqual([]);
});
