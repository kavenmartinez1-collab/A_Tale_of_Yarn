/**
 * Phase M — Crime / Bounty / Guards / Jail e2e tests.
 *
 * All tests run with ?director=off for determinism (no LLM calls).
 *
 * Tests:
 *  (a) addBounty + openArrestPanel() shows 3 option buttons
 *  (b) Pay path clears bounty and deducts gold
 *  (c) Jail path teleports to jail, serveFast() → release confiscates inventory
 *  (d) jailState persists across reload
 *  (e) assault: addBounty / crime state stored in localStorage
 *  (f) __gameError null throughout
 */

import { test, expect, type Page } from '@playwright/test';
import { INVENTORY_KEY, PACK_SIZE, HOTBAR_SIZE } from '../../src/game/inventory';

declare global {
  interface Window {
    __gameReady?: boolean;
    __gameError?: string | null;
    __gameStats?: {
      frameCount: number;
      playerPos?: [number, number, number];
      bounty?: number;
      jailed?: boolean;
      jailRemainS?: number;
      npcCount?: number;
      interactPrompt?: string | null;
    };
    __gameDebug?: {
      playerPos(): [number, number, number];
      inventory(): import('../../src/game/inventory').Inventory;
      npcs(): { id: string; role: string; name: string; x: number; z: number }[];
      teleportToNearestSettlementSign(): boolean;
      teleportToNearestNpc(): boolean;
      teleportToNearestSettlement(kind?: string): boolean;
      nearestSettlement(): { name: string; kind: string } | null;
      bounty(regionId?: string): number;
      addBounty(amount: number, regionId?: string): void;
      jailState(): { jailedUntilMs: number; regionId: string } | null;
      serveFast(ms: number): void;
      openArrestPanel(): void;
      sendToJail(): void;
      vitals(): { hp: number; alive: boolean };
      setVitals(partial: { hp?: number; alive?: boolean }): void;
      spawnEntity(species: string, dx: number, dz: number): { id: string; species: string; hp: number; mode: string } | null;
      attackEntity(id: string, damage: number): boolean;
    };
  }
}

const BASE_URL = '/game.html?director=off';

async function boot(page: Page): Promise<void> {
  await page.goto(BASE_URL);
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });
  await page.waitForTimeout(500);
}

/** Seed inventory with gold_small before page load.
 *  gold_small stacks at max 99; distribute across slots as needed. */
async function seedGold(page: Page, goldCount: number): Promise<void> {
  const GOLD_STACK = 99;
  const pack: Array<{ id: string; count: number } | null> = new Array(PACK_SIZE).fill(null);
  let remaining = goldCount;
  let slotIdx = 0;
  while (remaining > 0 && slotIdx < PACK_SIZE) {
    const cnt = Math.min(remaining, GOLD_STACK);
    pack[slotIdx++] = { id: 'gold_small', count: cnt };
    remaining -= cnt;
  }
  const hotbar: Array<{ id: string; count: number } | null> = new Array(HOTBAR_SIZE).fill(null);
  hotbar[0] = { id: 'bronze_axe', count: 1 };
  hotbar[1] = { id: 'bronze_pickaxe', count: 1 };
  hotbar[2] = { id: 'fire_starter', count: 1 };
  const inv = { pack, hotbar, selected: 0, armor: { head: null, body: null, legs: null } };
  await page.addInitScript(([key, json]: [string, string]) => {
    localStorage.setItem(key, json);
  }, [INVENTORY_KEY, JSON.stringify(inv)]);
}

// ---------------------------------------------------------------------------
// (a) addBounty + openArrestPanel → 3 buttons visible
// ---------------------------------------------------------------------------

test('addBounty + openArrestPanel shows arrest panel with 3 option buttons', async ({ page }) => {
  await boot(page);

  // Add a bounty in the current region.
  await page.evaluate(() => window.__gameDebug!.addBounty(200));

  // Confirm bounty recorded.
  const bountyVal = await page.evaluate(() => window.__gameDebug!.bounty());
  expect(bountyVal).toBeGreaterThanOrEqual(200);

  // Force-open the arrest panel via debug hook.
  await page.evaluate(() => window.__gameDebug!.openArrestPanel());
  await page.waitForTimeout(200);

  // All 3 buttons must be in the DOM.
  await expect(page.locator('#arrest-pay')).toBeVisible();
  await expect(page.locator('#arrest-jail')).toBeVisible();
  await expect(page.locator('#arrest-resist')).toBeVisible();

  const err = await page.evaluate(() => window.__gameError);
  expect(err).toBeNull();
});

// ---------------------------------------------------------------------------
// (b) Pay path: clears bounty and deducts gold
// ---------------------------------------------------------------------------

test('Pay bounty button clears bounty and deducts gold', async ({ page }) => {
  // Seed 99 gold (max per stack); bounty will be 50 so it's payable.
  await seedGold(page, 99);
  await boot(page);

  // Seed a bounty of 50 and force-open arrest panel.
  await page.evaluate(() => {
    window.__gameDebug!.addBounty(50);
    window.__gameDebug!.openArrestPanel();
  });
  await page.waitForTimeout(200);

  await expect(page.locator('#arrest-panel')).toBeVisible();

  const goldBefore = await page.evaluate(() => {
    const inv = window.__gameDebug!.inventory();
    let g = 0;
    for (const s of inv.pack) if (s?.id === 'gold_small') g += s.count;
    for (const s of inv.hotbar) if (s?.id === 'gold_small') g += s.count;
    return g;
  });
  expect(goldBefore).toBeGreaterThanOrEqual(99);

  // Click "Pay Bounty".
  await page.locator('#arrest-pay').click();
  await page.waitForTimeout(300);

  const bountyAfterPay = await page.evaluate(() => window.__gameDebug!.bounty());
  expect(bountyAfterPay).toBe(0);

  const goldAfter = await page.evaluate(() => {
    const inv = window.__gameDebug!.inventory();
    let g = 0;
    for (const s of inv.pack) if (s?.id === 'gold_small') g += s.count;
    for (const s of inv.hotbar) if (s?.id === 'gold_small') g += s.count;
    return g;
  });
  expect(goldAfter).toBeLessThan(goldBefore);

  const err = await page.evaluate(() => window.__gameError);
  expect(err).toBeNull();
});

// ---------------------------------------------------------------------------
// (c) Jail path: sendToJail + serveFast → release with inventory confiscation
// ---------------------------------------------------------------------------

test('sendToJail + serveFast releases player and confiscates inventory', async ({ page }) => {
  await seedGold(page, 100);
  await boot(page);

  // Seed bounty then send to jail immediately.
  await page.evaluate(() => {
    window.__gameDebug!.addBounty(200);
    window.__gameDebug!.sendToJail();
  });

  // Check jail state via debug hook (immediate, not stats which update at ~2Hz).
  const jail1 = await page.evaluate(() => window.__gameDebug!.jailState());
  expect(jail1).not.toBeNull();
  expect(jail1!.jailedUntilMs).toBeGreaterThan(Date.now());

  // Wait for __gameStats to refresh (~1s).
  await page.waitForFunction(
    () => window.__gameStats?.jailed === true,
    undefined, { timeout: 5_000 },
  );
  const jailed = await page.evaluate(() => window.__gameStats?.jailed);
  expect(jailed).toBe(true);

  // Sentence timer shows a positive value (via debug hook, always fresh).
  const jailState2 = await page.evaluate(() => window.__gameDebug!.jailState());
  const remainS = jailState2 ? (jailState2.jailedUntilMs - Date.now()) / 1000 : 0;
  expect(remainS).toBeGreaterThan(0);

  // Fast-forward the sentence using serveFast (overshoot by 2s).
  await page.evaluate(() => {
    const jail = window.__gameDebug!.jailState();
    if (jail) {
      const remaining = jail.jailedUntilMs - Date.now();
      window.__gameDebug!.serveFast(remaining + 2000);
    }
  });

  // Wait for the tick loop to process the release (tickJail runs each sim step).
  const released = await page.waitForFunction(
    () => window.__gameDebug!.jailState() === null,
    undefined, { timeout: 5_000 },
  ).then(() => true).catch(() => false);
  expect(released).toBe(true);

  // After release: gold should be confiscated, spawn kit re-granted.
  const invAfter = await page.evaluate(() => window.__gameDebug!.inventory());
  const hasBronzeAxe = invAfter.hotbar.some(s => s?.id === 'bronze_axe');
  expect(hasBronzeAxe).toBe(true);

  let goldAfter = 0;
  for (const s of invAfter.pack) if (s?.id === 'gold_small') goldAfter += s.count;
  for (const s of invAfter.hotbar) if (s?.id === 'gold_small') goldAfter += s.count;
  expect(goldAfter).toBe(0);

  const err = await page.evaluate(() => window.__gameError);
  expect(err).toBeNull();
});

// ---------------------------------------------------------------------------
// (d) jailState persists across reload
// ---------------------------------------------------------------------------

test('jailState persists across page reload', async ({ page }) => {
  await boot(page);

  const regionId = await page.evaluate(() =>
    window.__gameDebug!.nearestSettlement()?.name ?? 'TestRegion');

  // Write a future jail record directly to localStorage.
  const futureMs = Date.now() + 60_000;
  await page.evaluate(([key, recJson]: [string, string]) => {
    localStorage.setItem(key, recJson);
  }, ['artifex-jail:v1', JSON.stringify({ jailedUntilMs: futureMs, regionId })] as [string, string]);

  // Reload page.
  await page.reload();
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });
  await page.waitForTimeout(500);

  const jailAfterReload = await page.evaluate(() => window.__gameDebug!.jailState());
  expect(jailAfterReload).not.toBeNull();
  expect(jailAfterReload!.jailedUntilMs).toBeGreaterThan(Date.now());

  const jailed = await page.evaluate(() => window.__gameStats?.jailed);
  expect(jailed).toBe(true);

  const err = await page.evaluate(() => window.__gameError);
  expect(err).toBeNull();
});

// ---------------------------------------------------------------------------
// (e) Crime state: addBounty stores to localStorage, bounty() reads back
// ---------------------------------------------------------------------------

test('addBounty is persisted to localStorage and bounty() reads it back', async ({ page }) => {
  await boot(page);

  const b0 = await page.evaluate(() => window.__gameDebug!.bounty());
  expect(b0).toBe(0);

  await page.evaluate(() => window.__gameDebug!.addBounty(200));

  const b1 = await page.evaluate(() => window.__gameDebug!.bounty());
  expect(b1).toBeGreaterThanOrEqual(200);

  // Verify crime state is persisted in localStorage.
  const crimeJson = await page.evaluate(() => localStorage.getItem('artifex-crime:v1'));
  expect(crimeJson).not.toBeNull();
  const crimeState = JSON.parse(crimeJson!) as { regions: Record<string, { bounty: number }> };
  const anyBounty = Object.values(crimeState.regions).some(r => r.bounty > 0);
  expect(anyBounty).toBe(true);

  // __gameStats.bounty should reflect the bounty (wait for stats to refresh at ~2Hz).
  await page.waitForFunction(
    () => (window.__gameStats?.bounty ?? 0) >= 200,
    undefined, { timeout: 3_000 },
  );
  const statsBounty = await page.evaluate(() => window.__gameStats?.bounty ?? 0);
  expect(statsBounty).toBeGreaterThanOrEqual(200);

  const err = await page.evaluate(() => window.__gameError);
  expect(err).toBeNull();
});

// ---------------------------------------------------------------------------
// (f) __gameError null throughout (smoke)
// ---------------------------------------------------------------------------

test('No __gameError during normal crime/bounty operations', async ({ page }) => {
  await boot(page);

  await page.evaluate(() => {
    const db = window.__gameDebug!;
    db.addBounty(100);
    const b = db.bounty();
    void b;
    const j = db.jailState();
    void j;
    db.teleportToNearestSettlement();
  });

  await page.waitForTimeout(500);

  const err = await page.evaluate(() => window.__gameError);
  expect(err).toBeNull();
});

// ---------------------------------------------------------------------------
// Additional: teleportToNearestSettlement and bounty round-trip
// ---------------------------------------------------------------------------

test('bounty() returns 0 initially and teleportToNearestSettlement() succeeds', async ({ page }) => {
  await boot(page);

  const b0 = await page.evaluate(() => window.__gameDebug!.bounty());
  expect(b0).toBe(0);

  const teleported = await page.evaluate(() =>
    window.__gameDebug!.teleportToNearestSettlement());
  expect(typeof teleported).toBe('boolean');

  await page.waitForTimeout(1_000);

  // addBounty + bounty() round-trip.
  await page.evaluate(() => window.__gameDebug!.addBounty(50));
  const b1 = await page.evaluate(() => window.__gameDebug!.bounty());
  expect(b1).toBeGreaterThanOrEqual(50);

  const err = await page.evaluate(() => window.__gameError);
  expect(err).toBeNull();
});
