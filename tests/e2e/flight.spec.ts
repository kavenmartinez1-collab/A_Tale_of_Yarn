/**
 * Dragon flight e2e tests — Phase K flight extension.
 *
 * Uses the starter tamed dragon spawned at boot beside SPAWN_POS
 * (owned, follow mode, tamed — see main.ts ~line 1460).
 *
 * Tests:
 *  1. Mount dragon, hold Space 1.5 s → altitude rises well above terrain.
 *  2. Release Space, hold ControlLeft → altitude decreases; never below terrain.
 *  3. Dismount mid-air → player y decreases (falls) and approaches terrain.
 */

import { test, expect } from '@playwright/test';

declare global {
  interface Window {
    __gameReady?: boolean;
    __gameError?: string | null;
    __gameStats?: {
      playerPos?: [number, number, number];
      mountedEntityId?: string | null;
      mountAltitude?: number | null;
    };
    __gameDebug?: {
      playerPos(): [number, number, number];
      entities(): Array<{ id: string; species: string; x: number; y: number; z: number; mode: string; owned?: boolean }>;
      mounted(): string | null;
      mountStamina(): number | null;
      mountAltitude(): number | null;
      vitals(): { hp: number; alive: boolean; stamina: number };
      setVitals(partial: { hp?: number; alive?: boolean; stamina?: number }): void;
    };
  }
}

// ---------------------------------------------------------------------------
// Boot helper
// ---------------------------------------------------------------------------

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/game.html?director=off');
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });
  // Extra settle time so the starter dragon spawns and enters follow mode.
  await page.waitForTimeout(800);
}

// ---------------------------------------------------------------------------
// Helper: dispatch keydown
// ---------------------------------------------------------------------------

async function pressKey(page: import('@playwright/test').Page, code: string) {
  await page.evaluate((c) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { code: c, bubbles: true })), code);
}

// ---------------------------------------------------------------------------
// Helper: mount the starter tamed dragon (already at spawn+6,+6 in follow mode).
// The starter dragon is owned+tamed so DEMO_FREE_RIDE_RARES mounts it instantly.
// We press E close to it; if it walked away we locate it and teleport beside it
// by pressing E again after the dragon's follow mode brings it back.
// ---------------------------------------------------------------------------

async function mountStarterDragon(page: import('@playwright/test').Page): Promise<string | null> {
  // The starter dragon follows the player and should be within 3 m after settle.
  // Press E to mount.
  await pressKey(page, 'KeyE');
  await page.waitForTimeout(500);

  let mountedId = await page.evaluate(() => window.__gameDebug!.mounted());
  if (mountedId !== null) return mountedId;

  // Dragon may have wandered; wait a bit for follow-mode to bring it back.
  await page.waitForTimeout(1000);
  await pressKey(page, 'KeyE');
  await page.waitForTimeout(500);
  mountedId = await page.evaluate(() => window.__gameDebug!.mounted());
  return mountedId;
}

// ---------------------------------------------------------------------------
// 1. Mount dragon → hold Space 1.5 s → altitude rises above terrain
// ---------------------------------------------------------------------------

test('dragon flight: Space held raises altitude', async ({ page }) => {
  await boot(page);

  const mountedId = await mountStarterDragon(page);
  expect(mountedId).not.toBeNull();

  // Record starting altitude (should be ~0 — on the ground).
  const altBefore = await page.evaluate(() => window.__gameDebug!.mountAltitude());
  // altBefore may be null if not a dragon mount; it will be 0 or very small if on ground.
  // It should be a number since we're on a dragon.
  expect(altBefore).not.toBeNull();
  const startAlt = altBefore ?? 0;

  // Hold Space to ascend for 1.5 seconds.
  await page.keyboard.down('Space');
  await page.waitForTimeout(1500);
  await page.keyboard.up('Space');

  // Altitude should now be well above ground (at 6 m/s × 1.5 s ≈ 9 m).
  const altAfter = await page.evaluate(() => window.__gameDebug!.mountAltitude());
  expect(altAfter).not.toBeNull();
  expect(altAfter!).toBeGreaterThan(startAlt + 3); // at least 3 m above where we started

  // Player y should also be elevated.
  const playerPos = await page.evaluate(() => window.__gameDebug!.playerPos());
  const entities = await page.evaluate(() => window.__gameDebug!.entities());
  const dragon = entities.find((e) => e.id === mountedId);
  if (dragon) {
    // Player should be at saddle height: dragon.y + 3.5
    expect(playerPos[1]).toBeGreaterThan(dragon.y);
  }

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

// ---------------------------------------------------------------------------
// 2. Release Space, hold Ctrl → altitude decreases, never below terrain
// ---------------------------------------------------------------------------

test('dragon flight: Ctrl descends; y never below terrain', async ({ page }) => {
  await boot(page);

  const mountedId = await mountStarterDragon(page);
  expect(mountedId).not.toBeNull();

  // First ascend to get airborne.
  await page.keyboard.down('Space');
  await page.waitForTimeout(1200);
  await page.keyboard.up('Space');

  const altMid = await page.evaluate(() => window.__gameDebug!.mountAltitude());
  expect(altMid).not.toBeNull();
  expect(altMid!).toBeGreaterThan(1); // must be airborne

  // Now descend with Ctrl.
  await page.keyboard.down('ControlLeft');
  await page.waitForTimeout(1500);
  await page.keyboard.up('ControlLeft');

  const altAfter = await page.evaluate(() => window.__gameDebug!.mountAltitude());
  expect(altAfter).not.toBeNull();
  // Altitude should have decreased from the mid point.
  expect(altAfter!).toBeLessThan(altMid!);

  // Player y should never be below terrain (altitude >= 0).
  expect(altAfter!).toBeGreaterThanOrEqual(0);

  // Player y should be positive (not clipped into the ground).
  const playerPos = await page.evaluate(() => window.__gameDebug!.playerPos());
  expect(playerPos[1]).toBeGreaterThan(0);

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

// ---------------------------------------------------------------------------
// 3. Dismount mid-air → player falls and approaches terrain
// ---------------------------------------------------------------------------

test('dragon flight: dismount mid-air causes player to fall', async ({ page }) => {
  await boot(page);

  const mountedId = await mountStarterDragon(page);
  expect(mountedId).not.toBeNull();

  // Ascend to a decent altitude.
  await page.keyboard.down('Space');
  await page.waitForTimeout(1500);
  await page.keyboard.up('Space');

  const altBeforeDismount = await page.evaluate(() => window.__gameDebug!.mountAltitude());
  expect(altBeforeDismount).not.toBeNull();
  expect(altBeforeDismount!).toBeGreaterThan(2);

  // Record player y before dismount.
  const posBefore = await page.evaluate(() => window.__gameDebug!.playerPos());

  // Dismount (E).
  await pressKey(page, 'KeyE');
  await page.waitForTimeout(200);

  // Confirm dismounted.
  const mountedAfter = await page.evaluate(() => window.__gameDebug!.mounted());
  expect(mountedAfter).toBeNull();

  // Player starts falling — record y right after dismount.
  const posAfterDismount = await page.evaluate(() => window.__gameDebug!.playerPos());

  // Wait for player to fall.
  await page.waitForTimeout(1500);

  const posFalling = await page.evaluate(() => window.__gameDebug!.playerPos());

  // Player should have fallen: y at 1.5 s should be less than y right after dismount
  // OR player has already landed near terrain level (y ≈ terrain height, typically 1-10 m).
  // Either the y is lower, or the player has landed (y grounded near terrain).
  const hasFallen = posFalling[1] < posAfterDismount[1] || posFalling[1] < 5;
  expect(hasFallen).toBe(true);

  // Player must still be alive.
  const vitals = await page.evaluate(() => window.__gameDebug!.vitals());
  expect(vitals.alive).toBe(true);

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});
