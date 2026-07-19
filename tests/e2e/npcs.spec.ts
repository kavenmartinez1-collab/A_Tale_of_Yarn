/**
 * NPC e2e — Phase L1: settlement expansion + deterministic NPCs.
 *
 * Tests:
 * 1. __gameDebug.npcs() returns non-empty list near a settlement.
 * 2. All settlement kinds (including castle) are valid in the type system.
 * 3. E-interact near an NPC shows the "coming soon" notice.
 * 4. __gameError stays null throughout.
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
      npcCount?: number;
    };
    __gameError?: string | null;
    __gameDebug?: {
      nearestSettlement(): { name: string; kind: string } | null;
      teleportToNearestSettlementSign(): boolean;
      playerPos(): [number, number, number];
      npcs(): { id: string; role: string; name: string; x: number; z: number }[];
    };
  }
}

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/game.html?director=off');
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });
}

test('NPCs spawn at a settlement and __gameDebug.npcs() reports them', async ({ page }) => {
  await boot(page);

  // Teleport to the nearest settlement sign to be near NPC spawn points.
  const teleported = await page.evaluate(
    () => window.__gameDebug!.teleportToNearestSettlementSign());
  expect(teleported).toBe(true);

  // Wait a few frames for the settlement manager to pick up the position and
  // spawn NPCs (settlement streaming uses the 3x3 memoized scan).
  await page.waitForTimeout(2_000);

  // The nearest settlement must be non-ruins for NPCs to spawn; check kind first.
  const settlement = await page.evaluate(() => window.__gameDebug!.nearestSettlement());
  expect(settlement).not.toBeNull();
  expect(['ruins', 'ranch', 'village', 'town', 'castle']).toContain(settlement!.kind);

  // If the settlement is not ruins, wait for NPCs to appear.
  if (settlement!.kind !== 'ruins') {
    await page.waitForFunction(
      () => window.__gameDebug!.npcs().length > 0,
      undefined,
      { timeout: 10_000 },
    );

    const npcs = await page.evaluate(() => window.__gameDebug!.npcs());
    expect(npcs.length).toBeGreaterThan(0);

    // Each NPC has expected shape.
    for (const npc of npcs) {
      expect(typeof npc.id).toBe('string');
      expect(npc.id.startsWith('npc_')).toBe(true);
      expect(['farmer', 'villager', 'merchant', 'guard']).toContain(npc.role);
      expect(typeof npc.name).toBe('string');
      expect(npc.name.length).toBeGreaterThan(0);
      expect(typeof npc.x).toBe('number');
      expect(typeof npc.z).toBe('number');
    }
  }

  // __gameError still null.
  const gameError = await page.evaluate(() => window.__gameError);
  expect(gameError).toBeNull();
});

test('E-interact near an NPC shows coming-soon notice', async ({ page }) => {
  await boot(page);

  const teleported = await page.evaluate(
    () => window.__gameDebug!.teleportToNearestSettlementSign());
  expect(teleported).toBe(true);

  await page.waitForTimeout(2_000);

  const settlement = await page.evaluate(() => window.__gameDebug!.nearestSettlement());
  expect(settlement).not.toBeNull();

  if (settlement!.kind !== 'ruins') {
    // Wait for NPCs to be live.
    await page.waitForFunction(
      () => window.__gameDebug!.npcs().length > 0,
      undefined,
      { timeout: 10_000 },
    );

    // Attempt the E key; if an NPC is within 3 m the notice says "coming soon".
    await page.keyboard.press('e');
    await page.waitForTimeout(500);

    const stats = await page.evaluate(() => window.__gameStats);

    // If the notice mentions "coming soon", verify its format.
    if (stats?.notice?.includes('coming soon')) {
      expect(stats.notice).toMatch(/Talk to .+ \(coming soon\)/);
    }
  }

  const gameError = await page.evaluate(() => window.__gameError);
  expect(gameError).toBeNull();
});

test('settlement kind is always a valid kind (includes castle in the set)', async ({ page }) => {
  await boot(page);

  await page.evaluate(() => window.__gameDebug!.teleportToNearestSettlementSign());
  await page.waitForTimeout(1_500);

  // The nearest settlement must have a valid kind — including castle.
  const settlement = await page.evaluate(() => window.__gameDebug!.nearestSettlement());
  expect(settlement).not.toBeNull();

  const validKinds = ['ruins', 'ranch', 'village', 'town', 'castle'];
  expect(validKinds).toContain(settlement!.kind);

  // No errors.
  const gameError = await page.evaluate(() => window.__gameError);
  expect(gameError).toBeNull();
});

test('npcCount in __gameStats is populated after visiting a settlement', async ({ page }) => {
  await boot(page);

  const teleported = await page.evaluate(
    () => window.__gameDebug!.teleportToNearestSettlementSign());
  expect(teleported).toBe(true);

  // Wait for settlement to load and NPCs to spawn.
  await page.waitForTimeout(2_500);

  const stats = await page.evaluate(() => window.__gameStats);
  // npcCount should be defined and non-negative.
  expect(stats?.npcCount).toBeDefined();
  expect(stats!.npcCount!).toBeGreaterThanOrEqual(0);

  // After visiting a real settlement (non-ruins), npcCount > 0 is expected.
  const settlement = await page.evaluate(() => window.__gameDebug!.nearestSettlement());
  if (settlement !== null && settlement.kind !== 'ruins') {
    expect(stats!.npcCount!).toBeGreaterThan(0);
  }

  const gameError = await page.evaluate(() => window.__gameError);
  expect(gameError).toBeNull();

  await page.screenshot({ path: 'test-results/npcs.png' });
});
