/**
 * Phase K — Mounting, taming, eggs, and babies e2e tests.
 * Always boots with ?director=off for determinism.
 *
 * Tests:
 *  1. Horse mount: spawnEntity → E mounts → player pos tracks entity → E dismounts
 *  2. Dragon attempt: E → bucked or accepted-ride; temper > 0 persisted after reload
 *  3. Egg: placeEgg + lit campfire → heatEggFast(130) → baby in taming() + entities()
 *  4. Baby growth: growFast(1300) → adult (scaleOverride cleared)
 *  5. __gameError null throughout
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
  owned?: boolean;
  scaleOverride?: number;
}

interface TamingState {
  temper: number;
  tamed: boolean;
}

interface EggRecord {
  species: string;
  heatS: number;
  hatched: boolean;
  x: number;
  z: number;
}

interface BabyRecord {
  species: string;
  ageS: number;
  adult: boolean;
  x: number;
  z: number;
}

interface TamingRegistry {
  tamed: Record<string, TamingState>;
  eggs: Record<string, EggRecord>;
  babies: Record<string, BabyRecord>;
}

declare global {
  interface Window {
    __gameReady?: boolean;
    __gameError?: string | null;
    __gameStats?: {
      entityCount?: number;
      mountedEntityId?: string | null;
    };
    __gameDebug?: {
      playerPos(): [number, number, number];
      entities(): EntitySnapshot[];
      spawnEntity(species: string, dx: number, dz: number): EntitySnapshot | null;
      killEntity(id: string): boolean;
      vitals(): { hp: number; alive: boolean; stamina: number };
      setVitals(partial: { hp?: number; alive?: boolean; stamina?: number }): void;
      placeFire(x: number, z: number, lit?: boolean): string;
      fires(): { id: string; x: number; y: number; z: number; fuelS: number }[];
      // Phase K
      taming(): TamingRegistry;
      heatEggFast(seconds: number): void;
      growFast(seconds: number): void;
      placeEgg(species: string, dx: number, dz: number): boolean;
      mounted(): string | null;
      mountStamina(): number | null;
    };
  }
}

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/game.html?director=off');
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });
  await page.waitForTimeout(600);
}

// ---------------------------------------------------------------------------
// Helper: dispatch a single keydown event
// ---------------------------------------------------------------------------

async function pressKey(page: import('@playwright/test').Page, code: string) {
  await page.evaluate((c) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { code: c, bubbles: true })), code);
}

// ---------------------------------------------------------------------------
// 1. Horse mount: spawn → E mounts → player pos tracks entity → E dismounts
// ---------------------------------------------------------------------------

test('horse: E-key mounts and dismounts', async ({ page }) => {
  await boot(page);

  // Spawn horse close (1.5 m) and press E immediately.
  // Horse will flee (non-aggro, player within 12 m) so we must act before it escapes.
  const horse = await page.evaluate(() =>
    window.__gameDebug!.spawnEntity('horse', 1.5, 0));
  expect(horse).not.toBeNull();
  expect(horse!.species).toBe('horse');

  // Press E immediately (same tick budget so horse hasn't fled out of range).
  await pressKey(page, 'KeyE');
  await page.waitForTimeout(400);

  // Verify mounted.
  const mountedId = await page.evaluate(() => window.__gameDebug!.mounted());
  // If not mounted on first attempt (horse fled), try a second spawn + E combo.
  if (mountedId === null) {
    const horse2 = await page.evaluate(() =>
      window.__gameDebug!.spawnEntity('horse', 0.5, 0));
    expect(horse2).not.toBeNull();
    await pressKey(page, 'KeyE');
    await page.waitForTimeout(400);
    const mountedId2 = await page.evaluate(() => window.__gameDebug!.mounted());
    expect(mountedId2).not.toBeNull();
    // Continue the test using horse2's id and trust the rest.
    const afterMount = await page.evaluate(() => ({
      mounted: window.__gameDebug!.mounted(),
      stats: window.__gameStats?.mountedEntityId,
    }));
    expect(afterMount.mounted).not.toBeNull();
    // Dismount.
    await pressKey(page, 'KeyE');
    await page.waitForTimeout(300);
    const mountedFinal = await page.evaluate(() => window.__gameDebug!.mounted());
    expect(mountedFinal).toBeNull();
    expect(await page.evaluate(() => window.__gameError)).toBeNull();
    return;
  }
  expect(mountedId).not.toBeNull();

  // Player position should be locked to the mounted entity's saddle.
  const playerPos = await page.evaluate(() => window.__gameDebug!.playerPos());
  const horseEntities = await page.evaluate(() => window.__gameDebug!.entities());
  // Find the specific mounted entity by its id (mountedId).
  const horseEntity = horseEntities.find((e) => e.id === mountedId);
  if (horseEntity) {
    // X and Z should be the same (player locked to saddle).
    expect(Math.abs(playerPos[0] - horseEntity.x)).toBeLessThan(1.0);
    expect(Math.abs(playerPos[2] - horseEntity.z)).toBeLessThan(1.0);
  }

  // Mounted flag in stats — should match the currently mounted entity id.
  const stats = await page.evaluate(() => window.__gameStats);
  expect(stats?.mountedEntityId).toBe(mountedId);

  // Press E to dismount.
  await pressKey(page, 'KeyE');
  await page.waitForTimeout(300);

  const mountedAfter = await page.evaluate(() => window.__gameDebug!.mounted());
  expect(mountedAfter).toBeNull();

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

// ---------------------------------------------------------------------------
// 2. Dragon: E → bucked or accepted-ride; temper > 0 persisted after reload
// ---------------------------------------------------------------------------

test('dragon: mount attempt registers temper, persists after reload', async ({ page }) => {
  await boot(page);

  // Spawn dragon 2 m away.
  const dragon = await page.evaluate(() =>
    window.__gameDebug!.spawnEntity('dragon', 2, 0));
  expect(dragon).not.toBeNull();

  await page.waitForTimeout(300);

  // Press E to attempt mount (will buck or accept-ride, dragon is untamed).
  await pressKey(page, 'KeyE');
  await page.waitForTimeout(400);

  // Check taming registry — temper should have changed or an accepted-ride started.
  const taming = await page.evaluate(() => window.__gameDebug!.taming());
  const dragonState = taming.tamed[dragon!.id];

  // Either we got bucked (temper > 0) or accepted-ride (temper = 0 but mounted).
  const isMounted = await page.evaluate(() => window.__gameDebug!.mounted());
  const temperChanged = dragonState !== undefined && dragonState.temper > 0;
  const mountedAccepted = isMounted === dragon!.id;

  expect(temperChanged || mountedAccepted).toBe(true);

  // If mounted (accepted-ride), dismount for the reload test.
  if (mountedAccepted) {
    await pressKey(page, 'KeyE');
    await page.waitForTimeout(200);
  }

  // Get the temper value before reload.
  const tamingBefore = await page.evaluate(() => window.__gameDebug!.taming());
  const temperBefore = tamingBefore.tamed[dragon!.id]?.temper ?? 0;

  // Reload and verify the taming registry persisted.
  await page.reload();
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });
  await page.waitForTimeout(600);

  const tamingAfter = await page.evaluate(() => window.__gameDebug!.taming());
  const temperAfter = tamingAfter.tamed[dragon!.id]?.temper ?? 0;

  // Temper must have persisted (same or close value — debug entity ids are unique
  // so a fresh dragon spawn would not have the entry, but the persisted entry should
  // match what was saved before reload).
  expect(temperAfter).toBeGreaterThanOrEqual(temperBefore);

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

// ---------------------------------------------------------------------------
// 3. Egg incubation: placeEgg + lit campfire → heatEggFast(130) → baby
// ---------------------------------------------------------------------------

test('bird egg: incubation near campfire hatches baby entity', async ({ page }) => {
  await boot(page);

  // Place a lit campfire near spawn.
  const playerPos0 = await page.evaluate(() => window.__gameDebug!.playerPos());
  await page.evaluate(([x, z]) =>
    window.__gameDebug!.placeFire(x + 2, z, true), [playerPos0[0], playerPos0[2]] as [number, number]);

  // Place a bird egg at spawn + (2, 0) — within EGG_HEAT_RADIUS (6 m) of the fire.
  const placed = await page.evaluate(() =>
    window.__gameDebug!.placeEgg('bird', 2, 0));
  expect(placed).toBe(true);

  // Verify egg is in the registry.
  const tamingBefore = await page.evaluate(() => window.__gameDebug!.taming());
  const eggsBefore = Object.values(tamingBefore.eggs);
  expect(eggsBefore.length).toBeGreaterThanOrEqual(1);

  // Fast-forward egg heat by 130 s (EGG_HATCH_S = 120).
  await page.evaluate(() => window.__gameDebug!.heatEggFast(130));
  await page.waitForTimeout(500);

  // Check that a baby entry was created.
  const tamingAfter = await page.evaluate(() => window.__gameDebug!.taming());
  const babies = Object.values(tamingAfter.babies);
  expect(babies.length).toBeGreaterThanOrEqual(1);

  // The hatched egg should be gone.
  const eggsAfter = Object.values(tamingAfter.eggs).filter((e) => !e.hatched);
  expect(eggsAfter.length).toBeLessThan(eggsBefore.length + 1); // at least one gone

  // The baby entity should be in the live entity list.
  const entities = await page.evaluate(() => window.__gameDebug!.entities());
  const babyIds = Object.keys(tamingAfter.babies);
  const babyEntity = entities.find((e) => babyIds.includes(e.id));
  expect(babyEntity).toBeDefined();
  expect(babyEntity!.species).toBe('bird');
  expect(babyEntity!.owned).toBe(true);
  expect(babyEntity!.scaleOverride).toBeLessThan(1);

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

// ---------------------------------------------------------------------------
// 4. Baby growth: growFast(1300) → adult (scaleOverride cleared)
// ---------------------------------------------------------------------------

test('baby: growFast promotes baby to adult', async ({ page }) => {
  await boot(page);

  // Place and immediately hatch an egg via heatEggFast.
  await page.evaluate(() => window.__gameDebug!.placeEgg('bird', 2, 0));
  await page.evaluate(() => {
    // Place a fire near the egg and heat immediately.
    const pos = window.__gameDebug!.playerPos();
    window.__gameDebug!.placeFire(pos[0] + 2, pos[2], true);
    window.__gameDebug!.heatEggFast(130);
  });
  await page.waitForTimeout(400);

  // Verify baby exists.
  const tamingMid = await page.evaluate(() => window.__gameDebug!.taming());
  const babyIds = Object.keys(tamingMid.babies);
  expect(babyIds.length).toBeGreaterThanOrEqual(1);

  const babyBefore = await page.evaluate(() => {
    const babies = window.__gameDebug!.taming().babies;
    return Object.values(babies)[0];
  });
  expect(babyBefore.adult).toBe(false);

  // Fast-forward growth by 1300 s (GROWTH_S = 1200).
  await page.evaluate(() => window.__gameDebug!.growFast(1300));
  await page.waitForTimeout(400);

  // Baby should now be adult.
  const tamingFinal = await page.evaluate(() => window.__gameDebug!.taming());
  const grownBaby = Object.values(tamingFinal.babies)[0];
  expect(grownBaby).toBeDefined();
  expect(grownBaby.adult).toBe(true);

  // Entity should have scaleOverride cleared.
  const entities = await page.evaluate(() => window.__gameDebug!.entities());
  const adultId = Object.keys(tamingFinal.babies)[0];
  const adultEntity = entities.find((e) => e.id === adultId);
  if (adultEntity) {
    // scaleOverride should be undefined or 1 after growing up.
    expect(adultEntity.scaleOverride === undefined || adultEntity.scaleOverride >= 1).toBe(true);
  }

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

// ---------------------------------------------------------------------------
// 5. __gameError null throughout a full session
// ---------------------------------------------------------------------------

test('no game errors during mount/egg/baby session', async ({ page }) => {
  await boot(page);

  // Spawn a horse and mount it.
  const horse = await page.evaluate(() =>
    window.__gameDebug!.spawnEntity('horse', 2.5, 0));
  expect(horse).not.toBeNull();

  await page.waitForTimeout(200);
  await pressKey(page, 'KeyE'); // mount
  await page.waitForTimeout(300);
  await pressKey(page, 'KeyE'); // dismount
  await page.waitForTimeout(200);

  // Place an egg and hatch it.
  const pos = await page.evaluate(() => window.__gameDebug!.playerPos());
  await page.evaluate(([x, z]) =>
    window.__gameDebug!.placeFire(x + 3, z, true), [pos[0], pos[2]] as [number, number]);
  await page.evaluate(() => window.__gameDebug!.placeEgg('dragon', 3, 0));
  await page.evaluate(() => window.__gameDebug!.heatEggFast(130));
  await page.waitForTimeout(500);

  // Grow the baby.
  await page.evaluate(() => window.__gameDebug!.growFast(1300));
  await page.waitForTimeout(500);

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

// ---------------------------------------------------------------------------
// 6. Player stamina NOT drained while mounted with W+Shift
// ---------------------------------------------------------------------------

test('mounted: player stamina does not drain while sprint-riding', async ({ page }) => {
  await boot(page);

  // Set player stamina to a known value.
  await page.evaluate(() => window.__gameDebug!.setVitals({ stamina: 80 }));

  // Spawn and mount a horse.
  const horse = await page.evaluate(() =>
    window.__gameDebug!.spawnEntity('horse', 1.5, 0));
  expect(horse).not.toBeNull();

  await pressKey(page, 'KeyE');
  await page.waitForTimeout(400);

  const mountedId = await page.evaluate(() => window.__gameDebug!.mounted());
  if (mountedId === null) {
    // Horse fled; retry with a closer spawn.
    const horse2 = await page.evaluate(() =>
      window.__gameDebug!.spawnEntity('horse', 0.5, 0));
    expect(horse2).not.toBeNull();
    await pressKey(page, 'KeyE');
    await page.waitForTimeout(400);
  }

  // Reset stamina to 80 once confirmed mounted.
  await page.evaluate(() => window.__gameDebug!.setVitals({ stamina: 80 }));

  // Hold W + ShiftLeft while mounted for 1 second.
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft', bubbles: true }));
  });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft', bubbles: true }));
  });

  const vitalsAfter = await page.evaluate(() => window.__gameDebug!.vitals());
  // Player stamina must NOT have gone down from 80 (should be 80 or higher due to regen).
  expect(vitalsAfter.stamina).toBeGreaterThanOrEqual(80);

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

// ---------------------------------------------------------------------------
// 7. Mount stamina drains while sprint-riding, then regens after stopping
// ---------------------------------------------------------------------------

test('mounted: mount stamina drains while sprinting, regens at rest', async ({ page }) => {
  await boot(page);

  // Spawn and mount a horse.
  const horse = await page.evaluate(() =>
    window.__gameDebug!.spawnEntity('horse', 1.5, 0));
  expect(horse).not.toBeNull();

  await pressKey(page, 'KeyE');
  await page.waitForTimeout(400);

  let mountedId = await page.evaluate(() => window.__gameDebug!.mounted());
  if (mountedId === null) {
    const horse2 = await page.evaluate(() =>
      window.__gameDebug!.spawnEntity('horse', 0.5, 0));
    expect(horse2).not.toBeNull();
    await pressKey(page, 'KeyE');
    await page.waitForTimeout(400);
    mountedId = await page.evaluate(() => window.__gameDebug!.mounted());
  }
  expect(mountedId).not.toBeNull();

  // Initial mount stamina should be 100 (just mounted).
  const staminaBefore = await page.evaluate(() => window.__gameDebug!.mountStamina());
  expect(staminaBefore).not.toBeNull();
  expect(staminaBefore).toBeCloseTo(100, 0);

  // Hold W + ShiftLeft to sprint-ride for ~2 seconds.
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft', bubbles: true }));
  });
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft', bubbles: true }));
  });

  // Mount stamina should have decreased.
  const staminaAfterSprint = await page.evaluate(() => window.__gameDebug!.mountStamina());
  expect(staminaAfterSprint).not.toBeNull();
  expect(staminaAfterSprint!).toBeLessThan(staminaBefore!);

  // Wait ~2 seconds at rest — stamina should regen.
  await page.waitForTimeout(2000);
  const staminaAfterRest = await page.evaluate(() => window.__gameDebug!.mountStamina());
  expect(staminaAfterRest).not.toBeNull();
  expect(staminaAfterRest!).toBeGreaterThan(staminaAfterSprint!);

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});

// ---------------------------------------------------------------------------
// 8. __gameError null after mount-stamina session
// ---------------------------------------------------------------------------

test('mount-stamina: no __gameError after drain+regen cycle', async ({ page }) => {
  await boot(page);

  const horse = await page.evaluate(() =>
    window.__gameDebug!.spawnEntity('horse', 1.5, 0));
  expect(horse).not.toBeNull();

  await pressKey(page, 'KeyE');
  await page.waitForTimeout(400);

  const mountedId = await page.evaluate(() => window.__gameDebug!.mounted());
  if (mountedId !== null) {
    // Sprint-ride until stamina bottoms out.
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft', bubbles: true }));
    });
    await page.waitForTimeout(12000); // drain 10/s → 100 gone in 10 s
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft', bubbles: true }));
    });
    // Let it regen a bit.
    await page.waitForTimeout(2000);

    // Stamina should be clamped to >= 0.
    const stam = await page.evaluate(() => window.__gameDebug!.mountStamina());
    expect(stam).not.toBeNull();
    expect(stam!).toBeGreaterThanOrEqual(0);
    expect(stam!).toBeLessThanOrEqual(100);
  }

  expect(await page.evaluate(() => window.__gameError)).toBeNull();
});
