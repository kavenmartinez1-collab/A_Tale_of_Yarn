/**
 * Vitals e2e — boots with ?director=off, exercises the vitals model wired
 * into the live game: default state check, thirst/damage over time, heal via
 * edible item, death overlay, and respawn with inventory intact.
 */

import { test, expect } from '@playwright/test';

interface VitalsSnapshot {
  hp: number;
  thirst: number;
  stamina: number;
  temperature: number;
  alive: boolean;
  deathCause: string | null;
}

interface Slot {
  id: string;
  count: number;
}

interface InventorySnapshot {
  pack: (Slot | null)[];
  hotbar: (Slot | null)[];
  selected: number;
}

declare global {
  interface Window {
    __gameReady?: boolean;
    __gameError?: string | null;
    __gameDebug?: {
      vitals(): VitalsSnapshot;
      setVitals(partial: Partial<VitalsSnapshot>): void;
      tickVitals(seconds: number): void;
      inventory(): InventorySnapshot;
      equipItem(id: string): boolean;
    };
  }
}

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/game.html?director=off');
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });
  // Wait for grounded to settle.
  await page.waitForTimeout(500);
}

// ---------------------------------------------------------------------------
// 1. Sane defaults after boot
// ---------------------------------------------------------------------------

test('vitals defaults are full HP, thirst, stamina at boot', async ({ page }) => {
  await boot(page);

  const v = await page.evaluate(() => window.__gameDebug!.vitals());
  expect(v.hp).toBe(20);
  // Thirst drains slowly (~0.02/s), so after boot it's still very close to 100.
  expect(v.thirst).toBeGreaterThan(99);
  expect(v.stamina).toBe(100);
  expect(v.alive).toBe(true);
  expect(v.deathCause).toBeNull();
  // Temperature should be near 0 at spawn (neutral biome).
  expect(Math.abs(v.temperature)).toBeLessThan(3);

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

// ---------------------------------------------------------------------------
// 2. HUD is rendered
// ---------------------------------------------------------------------------

test('vitals HUD elements are present in the DOM', async ({ page }) => {
  await boot(page);

  await expect(page.locator('#vitals-hud')).toBeVisible();
  // 10 heart elements.
  await expect(page.locator('#vitals-hud .heart')).toHaveCount(10);
  // Thirst track.
  await expect(page.locator('#vitals-hud .bar-fill.thirst')).toHaveCount(1);
  // Temperature track.
  await expect(page.locator('#vitals-hud .temp-track')).toHaveCount(1);

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

// ---------------------------------------------------------------------------
// 3. Thirst drains to 0 and causes HP loss via tickVitals
// ---------------------------------------------------------------------------

test('thirst drains and causes HP damage when at 0', async ({ page }) => {
  await boot(page);

  // Force thirst to 2 (near empty) and tick 600 s.
  await page.evaluate(() => {
    window.__gameDebug!.setVitals({ thirst: 2 });
    window.__gameDebug!.tickVitals(600);
  });

  const v = await page.evaluate(() => window.__gameDebug!.vitals());
  expect(v.thirst).toBe(0);
  // 600 s at 1 hp per 5 s = up to 120 damage — player should be dead or severely hurt.
  expect(v.hp).toBeLessThan(20);

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

// ---------------------------------------------------------------------------
// 4. Eating an edible item heals HP
// ---------------------------------------------------------------------------

test('eating a healing_herb restores HP', async ({ page }) => {
  // Seed inventory with healing_herb in hotbar slot 0 (v2 format) before boot.
  await page.goto('/game.html?director=off');

  // Seed localStorage before the page fully initialises game logic.
  await page.evaluate(() => {
    const pack = new Array(28).fill(null);
    const hotbar = new Array(5).fill(null);
    hotbar[0] = { id: 'healing_herb', count: 5 };
    hotbar[1] = { id: 'bronze_pickaxe', count: 1 };
    localStorage.setItem('artifex-inventory:v2',
      JSON.stringify({
        pack, hotbar, selected: 0,
        armor: { head: null, body: null, legs: null },
      }));
  });
  await page.reload();
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });
  await page.waitForTimeout(400);

  // Set HP low.
  await page.evaluate(() => window.__gameDebug!.setVitals({ hp: 8 }));

  const before = await page.evaluate(() => window.__gameDebug!.vitals());
  expect(before.hp).toBe(8);

  // Press E (no world interactable at spawn) — should consume the herb.
  await page.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE' })));
  await page.waitForTimeout(200);

  const after = await page.evaluate(() => window.__gameDebug!.vitals());
  // healing_herb.edible.heal = 2 → hp should be 10.
  expect(after.hp).toBeGreaterThan(before.hp);

  // One herb consumed.
  const inv = await page.evaluate(() => window.__gameDebug!.inventory());
  const herbSlot = inv.hotbar[0];
  expect(herbSlot?.id).toBe('healing_herb');
  expect(herbSlot?.count).toBe(4);

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

// ---------------------------------------------------------------------------
// 5. Death overlay shown, Respawn restores vitals, inventory intact
// ---------------------------------------------------------------------------

test('death overlay appears and Respawn restores vitals with inventory intact', async ({ page }) => {
  // Seed inventory with a recognisable item before boot.
  await page.goto('/game.html?director=off');
  await page.evaluate(() => {
    const pack = new Array(28).fill(null);
    pack[0] = { id: 'logs', count: 7 };
    const hotbar = new Array(5).fill(null);
    hotbar[0] = { id: 'bronze_axe', count: 1 };
    hotbar[1] = { id: 'bronze_pickaxe', count: 1 };
    localStorage.setItem('artifex-inventory:v2',
      JSON.stringify({
        pack, hotbar, selected: 0,
        armor: { head: null, body: null, legs: null },
      }));
  });
  await page.reload();
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });
  await page.waitForTimeout(400);

  // Force near-death and tick past the thirst damage threshold.
  await page.evaluate(() => {
    window.__gameDebug!.setVitals({ hp: 1, thirst: 0 });
    window.__gameDebug!.tickVitals(10); // 2 × 5 s thirst ticks = dead
  });

  // Death overlay should now be visible.
  await expect(page.locator('#death-overlay')).toBeVisible({ timeout: 3_000 });

  // Vitals model: alive should be false.
  const deadV = await page.evaluate(() => window.__gameDebug!.vitals());
  expect(deadV.alive).toBe(false);
  expect(deadV.hp).toBe(0);

  // Inventory should still have the pre-death items.
  const invDead = await page.evaluate(() => window.__gameDebug!.inventory());
  const logsSlot = invDead.pack.find((s) => s?.id === 'logs');
  expect(logsSlot?.count).toBe(7);

  // Click Respawn.
  await page.locator('#respawn-btn').click();
  await expect(page.locator('#death-overlay')).toBeHidden({ timeout: 3_000 });

  // Vitals reset to full.
  const aliveV = await page.evaluate(() => window.__gameDebug!.vitals());
  expect(aliveV.alive).toBe(true);
  expect(aliveV.hp).toBe(20);

  // Inventory intact after respawn.
  const invAlive = await page.evaluate(() => window.__gameDebug!.inventory());
  const logsAfter = invAlive.pack.find((s) => s?.id === 'logs');
  expect(logsAfter?.count).toBe(7);

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});
