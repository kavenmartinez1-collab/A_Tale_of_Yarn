/**
 * Inventory e2e — spawn kit in the hotbar, chest loot deposits into the pack,
 * click-to-move in the Tab panel, key selection, and persistence on reload.
 */

import { test, expect } from '@playwright/test';

interface Slot {
  id: string;
  count: number;
}

declare global {
  interface Window {
    __gameReady?: boolean;
    __gameStats?: {
      insideDungeon?: boolean;
      chestsOpened?: number;
      interactPrompt?: string | null;
      equipped?: string | null;
      attackT?: number;
    };
    __gameError?: string | null;
    __gameDebug?: {
      enterNearestDungeon(): boolean;
      teleportToNearestChest(): boolean;
      inventory(): { pack: (Slot | null)[]; hotbar: (Slot | null)[]; selected: number };
      attackT(): number;
    };
  }
}

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/game.html?director=off');
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });
}

test('spawn kit, chest loot, slot moves, and persistence', async ({ page }) => {
  await boot(page);

  // Spawn kit: axe + pickaxe in hotbar 1/2, axe selected.
  const inv0 = await page.evaluate(() => window.__gameDebug!.inventory());
  expect(inv0.hotbar[0]?.id).toBe('bronze_axe');
  expect(inv0.hotbar[1]?.id).toBe('bronze_pickaxe');
  expect(inv0.selected).toBe(0);
  await expect(page.locator('#hotbar .inv-slot')).toHaveCount(5);
  await expect(page.locator('#hotbar .inv-slot.sel')).toHaveCount(1);

  // Keys 1–5 change the selection.
  await page.keyboard.press('2');
  const sel = await page.evaluate(() => window.__gameDebug!.inventory().selected);
  expect(sel).toBe(1);

  // Loot a chest: items land in the pack.
  expect(await page.evaluate(() => window.__gameDebug!.enterNearestDungeon())).toBe(true);
  await page.waitForFunction(() => window.__gameStats?.insideDungeon === true);
  expect(await page.evaluate(() => window.__gameDebug!.teleportToNearestChest())).toBe(true);
  await page.waitForFunction(() =>
    window.__gameStats?.interactPrompt?.includes('open'), undefined, {
    timeout: 5_000,
  });
  await page.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE' })));
  await page.waitForFunction(() => (window.__gameStats?.chestsOpened ?? 0) > 0, undefined, {
    timeout: 10_000,
  });
  const looted = await page.evaluate(() =>
    window.__gameDebug!.inventory().pack.filter((s) => s !== null));
  expect(looted.length).toBeGreaterThan(0);
  const lootedId = looted[0]!.id;

  // Tab opens the panel; click the loot slot, then an empty hotbar slot.
  await page.keyboard.press('Tab');
  await expect(page.locator('#inventory-panel')).toBeVisible();
  const lootIdx = await page.evaluate(() =>
    window.__gameDebug!.inventory().pack.findIndex((s) => s !== null));
  await page.click(`#inventory-panel [data-area="pack"][data-index="${lootIdx}"]`);
  await page.click('#inventory-panel [data-area="hotbar"][data-index="4"]');
  const moved = await page.evaluate(() => window.__gameDebug!.inventory());
  expect(moved.hotbar[4]?.id).toBe(lootedId);
  expect(moved.pack[lootIdx]).toBeNull();

  // Tab closes; key 5 equips the moved item.
  await page.keyboard.press('Tab');
  await expect(page.locator('#inventory-panel')).toHaveCount(0);
  await page.keyboard.press('5');
  const inv1 = await page.evaluate(() => window.__gameDebug!.inventory());
  expect(inv1.selected).toBe(4);

  expect(await page.evaluate(() => window.__gameError)).toBeNull();

  // Reload: inventory (contents + selection) persists.
  await page.reload();
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });
  const inv2 = await page.evaluate(() => window.__gameDebug!.inventory());
  expect(inv2.hotbar[4]?.id).toBe(lootedId);
  expect(inv2.hotbar[0]?.id).toBe('bronze_axe');
  expect(inv2.selected).toBe(4);
});

test('equipped tool is reported and left-click swings it', async ({ page }) => {
  await boot(page);

  // Spawn kit: the bronze axe starts equipped.
  await page.waitForFunction(() => window.__gameStats?.equipped === 'bronze_axe');

  // Lock the pointer (overlay click), then left-click → one 0.35 s swing.
  await page.click('#overlay');
  await page.waitForFunction(() => document.pointerLockElement !== null, undefined, {
    timeout: 5_000,
  });
  await page.mouse.down();
  await page.waitForFunction(() => window.__gameDebug!.attackT() < 1, undefined, {
    timeout: 5_000,
  });
  await page.mouse.up();
  // The swing completes and settles back to idle.
  await page.waitForFunction(() => window.__gameDebug!.attackT() === 1, undefined, {
    timeout: 5_000,
  });

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});
