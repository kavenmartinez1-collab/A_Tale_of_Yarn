/**
 * Task B — NPC-owned horses at stables e2e test.
 *
 * The nearest settlement with a stable to spawn (CHUNK_SIZE*4 = 256, 256) is
 * a ranch at approx (142, 309) with a stable pad at approx (153, 307).
 * The test teleports there via teleportToNearestSettlement('ranch') and then
 * asserts that an npcOwned horse is present nearby.
 *
 * Secondary: mounting the npcOwned horse when an NPC is within 30 m should
 * register a horse_theft crime — but we just verify the entity exists and
 * has npcOwned === true; the crime path is already covered by crime.ts.
 */

import { test, expect, type Page } from '@playwright/test';

declare global {
  interface Window {
    __gameReady?: boolean;
    __gameError?: string | null;
    __gameDebug?: {
      playerPos(): [number, number, number];
      teleport(x: number, z: number): void;
      teleportToNearestSettlement(kind?: string): boolean;
      nearestSettlement(): { name: string; kind: string } | null;
      entities(): EntitySnapshot[];
      nearestNpcOwnedHorse(x: number, z: number, radius?: number): EntitySnapshot | null;
      mounted(): string | null;
      vitals(): { hp: number; alive: boolean };
      bounty(regionId?: string): number;
    };
    __gameStats?: {
      npcCount?: number;
      entityCount?: number;
    };
  }
}

interface EntitySnapshot {
  id: string;
  species: string;
  x: number;
  y: number;
  z: number;
  hp: number;
  mode: string;
  owned?: boolean;
  npcOwned?: boolean;
}

const BASE_URL = '/game.html?director=off';

async function boot(page: Page): Promise<void> {
  await page.goto(BASE_URL);
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });
  await page.waitForTimeout(600);
}

// ---------------------------------------------------------------------------
// 1. npcOwned horse is present near the stable after teleporting to a ranch
// ---------------------------------------------------------------------------

test('ranch stable spawns npcOwned horse(s)', async ({ page }) => {
  await boot(page);

  // Teleport to the nearest ranch (which has a stable).
  const teleported = await page.evaluate(() =>
    window.__gameDebug!.teleportToNearestSettlement('ranch'));
  expect(teleported).toBe(true);

  // Give the settlement-manager a couple of frames to activate and spawn horses.
  await page.waitForTimeout(1500);

  // Check player position is near a ranch.
  const pos = await page.evaluate(() => window.__gameDebug!.playerPos());

  // Look for an npcOwned horse within 80 m of the player.
  const horse = await page.evaluate(([px, pz]) =>
    window.__gameDebug!.nearestNpcOwnedHorse(px, pz, 80),
    [pos[0], pos[2]] as [number, number]);

  expect(horse).not.toBeNull();
  expect(horse!.species).toBe('horse');
  expect(horse!.npcOwned).toBe(true);
  expect(horse!.owned).toBeFalsy(); // not player-owned

  const err = await page.evaluate(() => window.__gameError);
  expect(err).toBeNull();
});

// ---------------------------------------------------------------------------
// 2. teleportToNearestSettlement('village') — village stable horses
// ---------------------------------------------------------------------------

test('village stable spawns npcOwned horse(s)', async ({ page }) => {
  await boot(page);

  const teleported = await page.evaluate(() =>
    window.__gameDebug!.teleportToNearestSettlement('village'));

  if (!teleported) {
    // Village may not be near spawn in this seed — skip gracefully.
    console.log('No village found near spawn — skipping village stable test.');
    return;
  }

  await page.waitForTimeout(1500);

  const pos = await page.evaluate(() => window.__gameDebug!.playerPos());
  const horse = await page.evaluate(([px, pz]) =>
    window.__gameDebug!.nearestNpcOwnedHorse(px, pz, 120),
    [pos[0], pos[2]] as [number, number]);

  expect(horse).not.toBeNull();
  expect(horse!.species).toBe('horse');
  expect(horse!.npcOwned).toBe(true);

  const err = await page.evaluate(() => window.__gameError);
  expect(err).toBeNull();
});

// ---------------------------------------------------------------------------
// 3. npcOwned horses are included in entities() snapshot
// ---------------------------------------------------------------------------

test('npcOwned horses appear in entities() debug snapshot', async ({ page }) => {
  await boot(page);

  // Teleport to ranch to ensure horses are spawned.
  await page.evaluate(() => window.__gameDebug!.teleportToNearestSettlement('ranch'));
  await page.waitForTimeout(1500);

  const allEntities = await page.evaluate(() => window.__gameDebug!.entities());
  const npcHorses = allEntities.filter(e => e.npcOwned && e.species === 'horse');

  expect(npcHorses.length).toBeGreaterThanOrEqual(1);

  // Verify they are not player-owned.
  for (const h of npcHorses) {
    expect(h.owned).toBeFalsy();
    expect(h.npcOwned).toBe(true);
  }

  const err = await page.evaluate(() => window.__gameError);
  expect(err).toBeNull();
});

// ---------------------------------------------------------------------------
// 4. No __gameError during stable-horse session
// ---------------------------------------------------------------------------

test('no __gameError during stable-horse session', async ({ page }) => {
  await boot(page);

  await page.evaluate(() => window.__gameDebug!.teleportToNearestSettlement('ranch'));
  await page.waitForTimeout(1500);

  // Just read the debug state — no actions needed.
  const pos = await page.evaluate(() => window.__gameDebug!.playerPos());
  const horse = await page.evaluate(([px, pz]) =>
    window.__gameDebug!.nearestNpcOwnedHorse(px, pz, 80),
    [pos[0], pos[2]] as [number, number]);

  // The stable should have horses.
  expect(horse).not.toBeNull();

  const err = await page.evaluate(() => window.__gameError);
  expect(err).toBeNull();
});
