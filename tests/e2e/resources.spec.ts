/**
 * Resource-gathering e2e — berry picking by hand, tool requirements on
 * rocks/trees, drops landing in the inventory, and harvest persistence.
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
      interactPrompt?: string | null;
      notice?: string | null;
      equipped?: string | null;
      gathered?: number;
    };
    __gameError?: string | null;
    __gameDebug?: {
      inventory(): { pack: (Slot | null)[]; hotbar: (Slot | null)[]; selected: number };
      attackT(): number;
      teleportToNearestResource(type: string): boolean;
    };
  }
}

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/game.html?director=off');
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });
}

/** Lock the pointer so left-clicks reach the swing handler. */
async function lockPointer(page: import('@playwright/test').Page) {
  await page.click('#overlay');
  await page.waitForFunction(() => document.pointerLockElement !== null, undefined, {
    timeout: 5_000,
  });
}

/** One full left-click swing (0.35 s), waiting for it to settle. */
async function swing(page: import('@playwright/test').Page) {
  await page.mouse.down();
  await page.waitForFunction(() => window.__gameDebug!.attackT() < 1, undefined, {
    timeout: 5_000,
  });
  await page.mouse.up();
  await page.waitForFunction(() => window.__gameDebug!.attackT() === 1, undefined, {
    timeout: 5_000,
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

test('berries are hand-gathered in 3 swings and the harvest persists', async ({ page }) => {
  await boot(page);
  await lockPointer(page);

  expect(await page.evaluate(() =>
    window.__gameDebug!.teleportToNearestResource('bush'))).toBe(true);
  await page.waitForFunction(() =>
    window.__gameStats?.interactPrompt?.includes('berries'), undefined, {
    timeout: 5_000,
  });

  await swing(page);
  await swing(page);
  expect(await countItem(page, 'berries')).toBe(0); // not done yet
  await swing(page);

  await page.waitForFunction(() => (window.__gameStats?.gathered ?? 0) === 1, undefined, {
    timeout: 5_000,
  });
  expect(await countItem(page, 'berries')).toBe(3);
  // Node is gone: the gather prompt clears within the next HUD refresh.
  await page.waitForFunction(() =>
    !(window.__gameStats?.interactPrompt ?? '').includes('berries'), undefined, {
    timeout: 5_000,
  });
  expect(await page.evaluate(() => window.__gameError)).toBeNull();

  // Reload: berries stay in the inventory, harvested node stays recorded.
  await page.reload();
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });
  expect(await countItem(page, 'berries')).toBe(3);
  const saved = await page.evaluate(() => localStorage.getItem('artifex-nodes:v1'));
  expect(saved).toContain(':');
});

test('rocks require the pickaxe; mining drops stone and ore', async ({ page }) => {
  await boot(page);
  await lockPointer(page);

  expect(await page.evaluate(() =>
    window.__gameDebug!.teleportToNearestResource('rock'))).toBe(true);
  await page.waitForFunction(() =>
    window.__gameStats?.interactPrompt?.includes('rock'), undefined, {
    timeout: 5_000,
  });

  // Bronze axe (spawn selection) is the wrong tool.
  await page.waitForFunction(() => window.__gameStats?.equipped === 'bronze_axe');
  await swing(page);
  await page.waitForFunction(() =>
    window.__gameStats?.notice?.includes('pickaxe'), undefined, {
    timeout: 5_000,
  });
  expect(await countItem(page, 'stone')).toBe(0);

  // Key 2 equips the bronze pickaxe; three swings mine the rock.
  await page.keyboard.press('2');
  await page.waitForFunction(() => window.__gameStats?.equipped === 'bronze_pickaxe');
  await swing(page);
  await swing(page);
  await swing(page);
  await page.waitForFunction(() => (window.__gameStats?.gathered ?? 0) === 1, undefined, {
    timeout: 5_000,
  });
  expect(await countItem(page, 'stone')).toBe(2);
  expect(await countItem(page, 'ore')).toBe(1);
  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

test('trees are chopped with the axe and drop logs', async ({ page }) => {
  await boot(page);
  await lockPointer(page);

  expect(await page.evaluate(() =>
    window.__gameDebug!.teleportToNearestResource('tree'))).toBe(true);
  await page.waitForFunction(() =>
    window.__gameStats?.interactPrompt?.includes('tree'), undefined, {
    timeout: 5_000,
  });

  await page.waitForFunction(() => window.__gameStats?.equipped === 'bronze_axe');
  await swing(page);
  await swing(page);
  await swing(page);
  await page.waitForFunction(() => (window.__gameStats?.gathered ?? 0) === 1, undefined, {
    timeout: 5_000,
  });
  expect(await countItem(page, 'logs')).toBe(2);
  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});
