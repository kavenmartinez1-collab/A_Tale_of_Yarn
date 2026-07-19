/**
 * Crafting e2e — B opens the panel, recipes gate on materials, crafting
 * consumes inputs and the product persists across reload.
 */

import { test, expect } from '@playwright/test';

interface Slot {
  id: string;
  count: number;
}

declare global {
  interface Window {
    __gameReady?: boolean;
    __gameError?: string | null;
    __gameDebug?: {
      inventory(): { pack: (Slot | null)[]; hotbar: (Slot | null)[]; selected: number };
    };
  }
}

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/game.html?director=off');
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });
}

function countItem(page: import('@playwright/test').Page, id: string) {
  return page.evaluate((wanted) => {
    const inv = window.__gameDebug!.inventory();
    let n = 0;
    for (const s of [...inv.pack, ...inv.hotbar]) {
      if (s !== null && s.id === wanted) n += s.count;
    }
    return n;
  }, id);
}

test('crafting an oak staff from gathered logs', async ({ page }) => {
  await boot(page);

  // Seed a save with 3 logs (plus the spawn kit) and reboot on it.
  await page.evaluate(() => {
    const pack = new Array(28).fill(null);
    pack[0] = { id: 'logs', count: 3 };
    const hotbar = new Array(5).fill(null);
    hotbar[0] = { id: 'bronze_axe', count: 1 };
    hotbar[1] = { id: 'bronze_pickaxe', count: 1 };
    localStorage.setItem('artifex-inventory:v1',
      JSON.stringify({ pack, hotbar, selected: 0 }));
  });
  await page.reload();
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });
  expect(await countItem(page, 'logs')).toBe(3);

  // B opens the crafting panel on the Tools tab; the staff is craftable,
  // the iron axe (forge-gated, no ingots) is not.
  await page.keyboard.press('b');
  await expect(page.locator('#crafting-panel')).toBeVisible();
  const staffBtn = page.locator('#crafting-panel [data-output="oak_staff"] .r-craft');
  await expect(staffBtn).toBeEnabled();
  await expect(
    page.locator('#crafting-panel [data-output="iron_axe"] .r-craft')).toBeDisabled();

  // Tab bar: Weapons tab shows the hunter bow (missing healing herb).
  await page.click('#crafting-panel .craft-tab[data-category="weapons"]');
  await expect(
    page.locator('#crafting-panel [data-output="hunter_bow"] .r-craft')).toBeDisabled();
  await expect(staffBtn).toHaveCount(0); // tools rows swapped out
  await page.click('#crafting-panel .craft-tab[data-category="tools"]');
  await expect(staffBtn).toBeEnabled();

  // Craft: logs consumed, staff produced, button goes dead.
  await staffBtn.click();
  expect(await countItem(page, 'logs')).toBe(0);
  expect(await countItem(page, 'oak_staff')).toBe(1);
  await expect(staffBtn).toBeDisabled();

  // B again closes the panel.
  await page.keyboard.press('b');
  await expect(page.locator('#crafting-panel')).toHaveCount(0);
  expect(await page.evaluate(() => window.__gameError)).toBeNull();

  // The crafted staff survives a reload.
  await page.reload();
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });
  expect(await countItem(page, 'oak_staff')).toBe(1);
  expect(await countItem(page, 'logs')).toBe(0);
});
