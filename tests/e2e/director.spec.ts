/**
 * Director e2e — mocked LLM (window.__DIRECTOR_MOCK__), real GPU. The real
 * model is never loaded here (2.4 GB + ~1 min generations = flaky CI); the
 * mock exercises the full pipeline downstream of the model: extraction →
 * validation → persistence → entrance rename → blocked-door gate → entry.
 *
 * The Director defaults ON (?director=off to opt out); the dungeon/game
 * suites opt out so they keep exercising the deterministic fixture path.
 */

import { test, expect } from '@playwright/test';

const MOCK_SPEC = {
  version: 1,
  theme: 'ruin',
  name: 'Spire of Mocked Dreams',
  rooms: [
    { id: 'gate', type: 'entrance', size: 'small' },
    { id: 'hall', type: 'combat', size: 'medium' },
    { id: 'vault', type: 'treasure', size: 'small', loot: ['gold_small'] },
  ],
  edges: [['gate', 'hall'], ['hall', 'vault']],
};

test('director generates, renames the entrance, persists across reload', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // Mock LLM: replays the canned spec — unless the test flips it to throw
  // (post-reload), proving resolution comes from localStorage, not the model.
  await page.addInitScript((specJson: string) => {
    (window as unknown as Record<string, unknown>).__DIRECTOR_MOCK__ = () => {
      if (sessionStorage.getItem('__mockMode') === 'throw') {
        throw new Error('mock disabled after reload');
      }
      return '```json\n' + specJson + '\n```';
    };
  }, JSON.stringify(MOCK_SPEC));

  await page.goto('/game.html?director=on');
  await page.waitForFunction(() => (window as any).__gameReady === true, undefined, {
    timeout: 30_000,
  });

  // Discover the nearest entrance (enqueues generation for its cell). The
  // instant mock may have already resolved by now, so no fixture-name check.
  const firstName = await page.evaluate(() =>
    (window as any).__gameDebug.nearestDungeonName());
  expect(firstName).not.toBeNull();

  // The mocked generation resolves and the cached entrance renames.
  await page.waitForFunction(() =>
    (window as any).__gameDebug.directorGeneration() > 0, undefined, {
    timeout: 10_000,
  });
  await page.waitForFunction((name: string) =>
    (window as any).__gameDebug.nearestDungeonName() === name, MOCK_SPEC.name, {
    timeout: 10_000,
  });

  // Spec persisted for determinism.
  const hasKey = await page.evaluate(() =>
    Object.keys(localStorage).some((k) => k.startsWith('artifex-director:')));
  expect(hasKey).toBe(true);

  // Entering builds the interior from the LLM-authored spec.
  const entered = await page.evaluate(() =>
    (window as any).__gameDebug.enterNearestDungeon());
  expect(entered).toBe(true);
  await page.waitForFunction(() =>
    (window as any).__gameStats?.insideDungeon === true);

  // Reload with the mock throwing: the same dungeon must resolve from
  // storage without a single model call.
  await page.evaluate(() => sessionStorage.setItem('__mockMode', 'throw'));
  await page.reload();
  await page.waitForFunction(() => (window as any).__gameReady === true, undefined, {
    timeout: 30_000,
  });
  const nameAfterReload = await page.evaluate(() =>
    (window as any).__gameDebug.nearestDungeonName());
  expect(nameAfterReload).toBe(MOCK_SPEC.name);
  const genAfterReload = await page.evaluate(() =>
    (window as any).__gameDebug.directorGeneration());
  expect(genAfterReload).toBe(0);

  const gameError = await page.evaluate(() => (window as any).__gameError);
  expect(gameError).toBeNull();
  expect(pageErrors).toEqual([]);
});

test('door stays shut while the director dreams', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // Mock LLM that never resolves: every spec stays pending forever.
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__DIRECTOR_MOCK__ =
      () => new Promise(() => {});
  });

  await page.goto('/game.html?director=on');
  await page.waitForFunction(() => (window as any).__gameReady === true, undefined, {
    timeout: 30_000,
  });

  const atEntrance = await page.evaluate(() =>
    (window as any).__gameDebug.teleportToNearestEntrance());
  expect(atEntrance).toBe(true);
  await page.waitForFunction(() =>
    (window as any).__gameStats?.interactPrompt?.includes('enter'), undefined, {
    timeout: 5_000,
  });

  // E at the door: blocked with the "dreams" notice, still outside.
  await page.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE' })));
  await page.waitForFunction(() =>
    (window as any).__gameStats?.notice?.includes('Director dreams'), undefined, {
    timeout: 5_000,
  });
  expect(await page.evaluate(() =>
    (window as any).__gameStats?.insideDungeon)).toBe(false);
  expect(await page.evaluate(() =>
    (window as any).__gameStats?.directorStatus)).toBe('dreaming');

  const gameError = await page.evaluate(() => (window as any).__gameError);
  expect(gameError).toBeNull();
  expect(pageErrors).toEqual([]);
});
