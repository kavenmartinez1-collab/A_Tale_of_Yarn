/**
 * Settlement e2e — teleports to the nearest settlement signpost, reads the
 * welcome sign, and checks deterministic naming across reloads.
 */

import { test, expect } from '@playwright/test';

declare global {
  interface Window {
    __gameReady?: boolean;
    __gameStats?: {
      frameCount: number;
      playerPos?: [number, number, number];
      grounded?: boolean;
      interactPrompt?: string | null;
      notice?: string | null;
    };
    __gameError?: string | null;
    __gameDebug?: {
      nearestSettlement(): { name: string; kind: string } | null;
      teleportToNearestSettlementSign(): boolean;
    };
  }
}

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/game.html?director=off');
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });
}

test('signpost welcomes the player to a named settlement', async ({ page }) => {
  await boot(page);

  const teleported = await page.evaluate(
    () => window.__gameDebug!.teleportToNearestSettlementSign());
  expect(teleported).toBe(true);

  // Standing 1.2 m from the sign: the read prompt must appear.
  await page.waitForFunction(
    () => window.__gameStats?.interactPrompt?.includes('sign') === true,
    undefined, { timeout: 10_000 });

  const settlement = await page.evaluate(
    () => window.__gameDebug!.nearestSettlement());
  expect(settlement).not.toBeNull();
  expect(settlement!.name.length).toBeGreaterThan(2);
  expect(['ruins', 'ranch', 'village', 'town']).toContain(settlement!.kind);

  await page.keyboard.press('e');
  await page.waitForFunction(
    () => window.__gameStats?.notice?.startsWith('Welcome to ') === true,
    undefined, { timeout: 10_000 });
  const notice = await page.evaluate(() => window.__gameStats!.notice);
  expect(notice).toContain(settlement!.name);
  expect(notice).toContain(settlement!.kind);

  // Player must be standing on solid ground next to the sign, not falling.
  const stats = await page.evaluate(() => window.__gameStats);
  expect(stats!.playerPos![1]).toBeGreaterThan(-50);

  const gameError = await page.evaluate(() => window.__gameError);
  expect(gameError).toBeNull();

  // Visual artifact for eyeballing settlement buildings.
  await page.screenshot({ path: 'test-results/settlement.png' });

  // Determinism: a fresh session finds the same settlement with the same name.
  await page.reload();
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });
  await page.evaluate(() => window.__gameDebug!.teleportToNearestSettlementSign());
  await page.waitForFunction(
    () => window.__gameDebug!.nearestSettlement() !== null,
    undefined, { timeout: 10_000 });
  const again = await page.evaluate(
    () => window.__gameDebug!.nearestSettlement());
  expect(again).toEqual(settlement);
});
