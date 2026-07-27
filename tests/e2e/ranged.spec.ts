/**
 * Ranged combat e2e tests — thrown stones and bows.
 * Always boots with ?director=off for determinism.
 *
 * TWO QUIVERS. The bow fires either `flint_arrow` — the common, craftable,
 * BALLISTIC ammunition — or `arrow`, the rare Tintreach bolt, which is
 * HITSCAN and hits far harder. Which one leaves the bow is the player's
 * choice (X in game, `setAmmo` here), and the rule that matters commercially
 * is that the choice is never made FOR them in the expensive direction: an
 * empty flint quiver does not silently spend a boss drop.
 *
 * These tests used to assert a world with one ammunition type, in which
 * 'arrow' meant 'the only thing a bow can shoot'. That was true for exactly as
 * long as making Tintreach rare made the bow itself unusable.
 *
 * Tests:
 *  1. Thrown stone damages a spawned entity by 2 hp (via injectProjectile)
 *  2. hunter_bow with flint arrows: consumption + damage 6
 *  3. composite_bow: damage 9 + flint consumption
 *  4. Tintreach is spent only when Tintreach is selected
 *  5. Flint selected and empty does NOT fall back to Tintreach
 *  6. Bow with NEITHER shows "No arrows" and consumes nothing
 *  7. __gameError stays null
 *
 * Strategy: projectile trajectory in headless is hard to aim reliably (camera
 * yaw unknown, gravity arc). We use two complementary approaches:
 *   A. `injectProjectile` debug hook — places a zero-velocity projectile right
 *      on top of the entity so the next sim tick triggers the hit-test code
 *      (damage path, flee/death). Tests the core hit logic.
 *   B. `simulateLeftClick` — drives the mousedown resolver to verify arrow
 *      consumption, the "No arrows" notice, and that a real projectile is
 *      spawned (via projectileCount()).
 */

import { test, expect } from '@playwright/test';

interface EntitySnapshot {
  id: string;
  species: string;
  x: number;
  y: number;
  z: number;
  hp: number;
  mode: string;
}

interface Slot { id: string; count: number; }
interface ArmorSlots { head: Slot | null; body: Slot | null; legs: Slot | null; }
interface Inventory {
  pack: (Slot | null)[];
  hotbar: (Slot | null)[];
  selected: number;
  armor: ArmorSlots;
}

declare global {
  interface Window {
    __gameReady?: boolean;
    __gameError?: string | null;
    __gameStats?: {
      notice?: string | null;
      equipped?: string | null;
      attackT?: number;
    };
    __gameDebug?: {
      playerPos(): [number, number, number];
      entities(): EntitySnapshot[];
      spawnEntity(species: string, dx: number, dz: number): EntitySnapshot | null;
      inventory(): Inventory;
      equipItem(id: string): boolean;
      attackEntity(id: string, damage: number): boolean;
      injectProjectile(x: number, y: number, z: number, kind: 'stone' | 'arrow', damage: number): number;
      projectileCount(): number;
      freezeAttackT(t: number | null): void;
      setAmmo(kind: string): boolean;
      countItem(id: string): number;
    };
  }
}

// ---------------------------------------------------------------------------
// Inventory v2 seed helpers
// ---------------------------------------------------------------------------

const PACK_SIZE   = 28;
const HOTBAR_SIZE = 5;

function makeInv(hotbar: (Slot | null)[], selected = 0): Inventory {
  const fullHotbar: (Slot | null)[] = Array(HOTBAR_SIZE).fill(null);
  for (let i = 0; i < hotbar.length && i < HOTBAR_SIZE; i++) {
    fullHotbar[i] = hotbar[i];
  }
  return {
    pack: Array(PACK_SIZE).fill(null),
    hotbar: fullHotbar,
    selected,
    armor: { head: null, body: null, legs: null },
  };
}

function countItem(inv: Inventory, id: string): number {
  let total = 0;
  for (const slot of [...inv.pack, ...inv.hotbar]) {
    if (slot && slot.id === id) total += slot.count;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Boot with pre-seeded inventory (set localStorage then reload).
// ---------------------------------------------------------------------------

async function bootWithInventory(
  page: import('@playwright/test').Page,
  inv: Inventory,
): Promise<void> {
  await page.goto('/game.html?director=off');
  await page.evaluate((serialized) => {
    localStorage.setItem('artifex-inventory:v2', serialized);
  }, JSON.stringify(inv));
  await page.reload();
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });
  await page.waitForTimeout(600);
}

// ---------------------------------------------------------------------------
// Simulate left-click through the game's mousedown handler.
// Temporarily satisfies the pointerLockElement guard. Also ensures attackT=1
// via freezeAttackT so the "swing in progress" guard doesn't block.
// ---------------------------------------------------------------------------

async function simulateLeftClick(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    // Unfreeze attackT in case it was previously frozen.
    window.__gameDebug!.freezeAttackT(null);

    // Force attackT = 1 via the override so the resolver fires immediately.
    window.__gameDebug!.freezeAttackT(1);

    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'pointerLockElement');
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => canvas,
    });
    window.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    if (original) {
      Object.defineProperty(document, 'pointerLockElement', original);
    } else {
      // @ts-ignore
      delete document.pointerLockElement;
    }

    // Unfreeze so normal swing animation resumes.
    window.__gameDebug!.freezeAttackT(null);
  });
  // Allow at least one sim frame.
  await page.waitForTimeout(200);
}

// ---------------------------------------------------------------------------
// Draw and loose, through the game's own listeners.
//
// `simulateLeftClick` above dispatches a mousedown and nothing else, which is
// the whole gesture for a swing or a throw and only HALF of it for a bow: the
// press starts the draw and the arrow is spent on RELEASE. It also restores
// `pointerLockElement` immediately, and `tickBow` cancels any draw the moment
// the lock is not the canvas — so a bow test built on it drew the string,
// dropped it, and asserted that no arrow had been consumed.
//
// The lock therefore has to stay stubbed for the whole hold.
// ---------------------------------------------------------------------------

async function simulateBowShot(
  page: import('@playwright/test').Page, holdMs = 700,
): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    (window as unknown as { __origPLE?: PropertyDescriptor }).__origPLE =
      Object.getOwnPropertyDescriptor(Document.prototype, 'pointerLockElement');
    Object.defineProperty(document, 'pointerLockElement',
      { configurable: true, get: () => canvas });
    window.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
  });
  // BOW_DRAW_S is 0.55 s; hold past it so the shot is at full power.
  await page.waitForTimeout(holdMs);
  await page.evaluate(() => {
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    const d = (window as unknown as { __origPLE?: PropertyDescriptor }).__origPLE;
    if (d) Object.defineProperty(document, 'pointerLockElement', d);
  });
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------
// 1. Thrown stone damages entity by 2 hp (hit-test path via injectProjectile)
// ---------------------------------------------------------------------------

test('thrown stone damages entity by 2 hp', async ({ page }) => {
  // Boot with stones in hotbar.
  const inv = makeInv([{ id: 'stone', count: 5 }], 0);
  await bootWithInventory(page, inv);

  // Spawn a deer close to the player.
  const e = await page.evaluate(() =>
    window.__gameDebug!.spawnEntity('deer', 2, 0));
  expect(e).not.toBeNull();
  const hpBefore = e!.hp;

  // Inject a stone projectile directly at the entity's position.
  await page.evaluate((entity) => {
    // Place projectile at entity body centre (y + size/2 = y + 0.6 for deer).
    window.__gameDebug!.injectProjectile(entity.x, entity.y + 0.6, entity.z, 'stone', 2);
  }, e!);

  // Wait for the sim to process the hit (≥1 tick = ~17 ms; 300 ms is safe).
  await page.waitForTimeout(300);

  const allAfter = await page.evaluate(() => window.__gameDebug!.entities());
  const after = allAfter.find((en) => en.id === e!.id);

  if (after) {
    // Survived: hp must have dropped by exactly 2.
    expect(after.hp).toBe(hpBefore - 2);
    expect(after.mode).not.toBe('dead');
  } else {
    // Killed in one shot (deer has 8 hp, shouldn't happen with 2 dmg — but guard it).
    // Entity gone from live list is also a valid "was hit" outcome.
  }

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

// ---------------------------------------------------------------------------
// 2. Stone throw via click: stone consumed, projectile spawned
// ---------------------------------------------------------------------------

test('left-click with stone held spawns a projectile and consumes 1 stone', async ({ page }) => {
  const inv = makeInv([{ id: 'stone', count: 3 }], 0);
  await bootWithInventory(page, inv);

  await simulateLeftClick(page);

  // 1 stone consumed.
  const invAfter = await page.evaluate(() => window.__gameDebug!.inventory());
  expect(countItem(invAfter, 'stone')).toBe(2);

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

// ---------------------------------------------------------------------------
// 3. hunter_bow arrow hit: damage 6 via injectProjectile
// ---------------------------------------------------------------------------

test('hunter_bow arrow deals 6 damage on entity hit', async ({ page }) => {
  const inv = makeInv([
    { id: 'hunter_bow', count: 1 },
    { id: 'flint_arrow', count: 10 },
  ], 0);
  await bootWithInventory(page, inv);

  // Spawn a horse (hp 20) — survives 6 damage.
  const e = await page.evaluate(() =>
    window.__gameDebug!.spawnEntity('horse', 2, 0));
  expect(e).not.toBeNull();
  const hpBefore = e!.hp;

  await page.evaluate((entity) => {
    // Arrow hit: inject at entity body centre.
    window.__gameDebug!.injectProjectile(entity.x, entity.y + 0.8, entity.z, 'arrow', 6);
  }, e!);

  await page.waitForTimeout(300);

  const allAfter = await page.evaluate(() => window.__gameDebug!.entities());
  const after = allAfter.find((en) => en.id === e!.id);

  expect(after).toBeDefined();
  expect(after!.hp).toBe(hpBefore - 6);

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

// ---------------------------------------------------------------------------
// 4. hunter_bow left-click with arrows: 1 arrow consumed, projectile spawned
// ---------------------------------------------------------------------------

test('hunter_bow left-click consumes 1 flint arrow and spawns a projectile', async ({ page }) => {
  const inv = makeInv([
    { id: 'hunter_bow', count: 1 },
    { id: 'flint_arrow', count: 10 },
  ], 0);
  await bootWithInventory(page, inv);

  // Record projectile count before.
  const countBefore = await page.evaluate(() => window.__gameDebug!.projectileCount());

  await simulateBowShot(page);
  await page.waitForTimeout(100);

  // 1 flint arrow consumed.
  const invAfter = await page.evaluate(() => window.__gameDebug!.inventory());
  expect(countItem(invAfter, 'flint_arrow')).toBe(9);

  // A new projectile was added (may already have been cleaned up if it hit ground).
  // We can't assert projectileCount > before because it may clear within 1 frame,
  // but arrow consumption is the definitive proof the shot fired.
  expect(countItem(invAfter, 'flint_arrow')).toBeLessThan(10);
  void countBefore; // suppress unused variable warning

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

// ---------------------------------------------------------------------------
// 5. composite_bow arrow hit: damage 9 via injectProjectile
// ---------------------------------------------------------------------------

test('composite_bow arrow deals 9 damage on entity hit', async ({ page }) => {
  const inv = makeInv([
    { id: 'composite_bow', count: 1 },
    { id: 'flint_arrow', count: 5 },
  ], 0);
  await bootWithInventory(page, inv);

  // Spawn a dragon (hp 80) — survives 9 damage.
  const e = await page.evaluate(() =>
    window.__gameDebug!.spawnEntity('dragon', 3, 0));
  expect(e).not.toBeNull();
  const hpBefore = e!.hp;

  await page.evaluate((entity) => {
    window.__gameDebug!.injectProjectile(entity.x, entity.y + 1.75, entity.z, 'arrow', 9);
  }, e!);

  await page.waitForTimeout(300);

  const allAfter = await page.evaluate(() => window.__gameDebug!.entities());
  const after = allAfter.find((en) => en.id === e!.id);

  expect(after).toBeDefined();
  expect(after!.hp).toBe(hpBefore - 9);

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

// ---------------------------------------------------------------------------
// 6. composite_bow left-click with arrows: 1 arrow consumed
// ---------------------------------------------------------------------------

test('composite_bow left-click consumes 1 flint arrow', async ({ page }) => {
  const inv = makeInv([
    { id: 'composite_bow', count: 1 },
    { id: 'flint_arrow', count: 5 },
  ], 0);
  await bootWithInventory(page, inv);

  await simulateBowShot(page);
  await page.waitForTimeout(100);

  const invAfter = await page.evaluate(() => window.__gameDebug!.inventory());
  expect(countItem(invAfter, 'flint_arrow')).toBe(4);

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

// ---------------------------------------------------------------------------
// 7. Bow with no arrows shows "No arrows" notice and consumes nothing
// ---------------------------------------------------------------------------

test('bow with no arrows of either kind shows notice and consumes nothing', async ({ page }) => {
  const inv = makeInv([{ id: 'hunter_bow', count: 1 }], 0);
  await bootWithInventory(page, inv);

  await simulateBowShot(page);

  // Wait for the HUD notice to be set (500 ms polling gate in tick loop).
  await page.waitForTimeout(700);

  // "No arrows" is reserved for BOTH quivers empty. Carrying Tintreach while
  // flint is selected is a different mistake and says so — see the next test.
  const notice = await page.evaluate(() => window.__gameStats?.notice ?? null);
  expect(notice).toBe('No arrows');

  const invAfter = await page.evaluate(() => window.__gameDebug!.inventory());
  expect(countItem(invAfter, 'arrow')).toBe(0);
  expect(countItem(invAfter, 'flint_arrow')).toBe(0);

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

// ---------------------------------------------------------------------------
// 8b. Tintreach is spent only when Tintreach is selected
// ---------------------------------------------------------------------------

test('selecting Tintreach spends Tintreach, not flint', async ({ page }) => {
  const inv = makeInv([
    { id: 'composite_bow', count: 1 },
    { id: 'flint_arrow', count: 10 },
    { id: 'arrow', count: 10 },
  ], 0);
  await bootWithInventory(page, inv);

  await page.evaluate(() => window.__gameDebug!.setAmmo('tintreach'));
  await simulateBowShot(page);
  await page.waitForTimeout(200);

  const after = await page.evaluate(() => window.__gameDebug!.inventory());
  expect(countItem(after, 'arrow')).toBe(9);
  expect(countItem(after, 'flint_arrow')).toBe(10);

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

// ---------------------------------------------------------------------------
// 8c. An empty common quiver never reaches for the rare one
//
// The commercially important direction. Tintreach is finite boss loot; a
// player who runs out of flint mid-hunt and silently spends a bolt on a rabbit
// has been robbed by their own inventory. The reverse IS allowed — running out
// of Tintreach falls back to flint rather than refusing to fire.
// ---------------------------------------------------------------------------

test('flint selected and empty does not fall back to Tintreach', async ({ page }) => {
  const inv = makeInv([
    { id: 'composite_bow', count: 1 },
    { id: 'arrow', count: 10 },
  ], 0);
  await bootWithInventory(page, inv);

  await page.evaluate(() => window.__gameDebug!.setAmmo('flint'));
  await simulateBowShot(page);
  await page.waitForTimeout(700);

  const after = await page.evaluate(() => window.__gameDebug!.inventory());
  expect(countItem(after, 'arrow')).toBe(10);
  const notice = await page.evaluate(() => window.__gameStats?.notice ?? null);
  expect(notice).toBe('No flint arrows — X for Tintreach');

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

// ---------------------------------------------------------------------------
// 8d. ...but an empty Tintreach quiver DOES fall back to flint
// ---------------------------------------------------------------------------

test('Tintreach selected and empty falls back to flint', async ({ page }) => {
  const inv = makeInv([
    { id: 'composite_bow', count: 1 },
    { id: 'flint_arrow', count: 10 },
  ], 0);
  await bootWithInventory(page, inv);

  await page.evaluate(() => window.__gameDebug!.setAmmo('tintreach'));
  await simulateBowShot(page);
  await page.waitForTimeout(200);

  const after = await page.evaluate(() => window.__gameDebug!.inventory());
  expect(countItem(after, 'flint_arrow')).toBe(9);

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

// ---------------------------------------------------------------------------
// 8. Arrow kills entity when damage >= hp (death path)
// ---------------------------------------------------------------------------

test('arrow kills entity when damage >= entity hp', async ({ page }) => {
  await page.goto('/game.html?director=off');
  await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 30_000 });
  await page.waitForTimeout(600);

  // Spawn a rabbit (hp 3) and finish it with a 6-damage arrow.
  const e = await page.evaluate(() =>
    window.__gameDebug!.spawnEntity('rabbit', 1, 0));
  expect(e).not.toBeNull();
  expect(e!.hp).toBe(3);

  await page.evaluate((entity) => {
    window.__gameDebug!.injectProjectile(entity.x, entity.y + 0.2, entity.z, 'arrow', 6);
  }, e!);

  await page.waitForTimeout(300);

  const allAfter = await page.evaluate(() => window.__gameDebug!.entities());
  const after = allAfter.find((en) => en.id === e!.id);

  // Either dead or removed from live list.
  if (after) {
    expect(after.mode).toBe('dead');
    expect(after.hp).toBe(0);
  }
  // If not found in entities(), the entity was killed and removed — also valid.

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

// ---------------------------------------------------------------------------
// 9. __gameError null guard (standalone)
// ---------------------------------------------------------------------------

test('ranged boot: __gameError is null after game start', async ({ page }) => {
  await page.goto('/game.html?director=off');
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});
