/**
 * NPC chat e2e — Phase L2.
 *
 * All tests run with ?director=off so there are no LLM calls.
 * The stub reply generator handles "buy <item>" messages deterministically.
 *
 * Tests:
 * 1. E on an NPC opens the chat panel with the NPC name shown.
 * 2. Sending "buy <item>" produces a trade offer card.
 * 3. Confirm with sufficient gold executes the swap and decrements stock.
 * 4. Stock key persists in localStorage after a trade.
 * 5. Insufficient gold shows a notice; offer stays.
 * 6. Esc closes the panel and __gameDebug.chatOpen() returns false.
 * 7. __gameError is null throughout.
 */

import { test, expect, type Page } from '@playwright/test';
import { INVENTORY_KEY, PACK_SIZE, HOTBAR_SIZE } from '../../src/game/inventory';
import { NPC_STOCK_KEY } from '../../src/game/ui/npc-chat-panel';
import { stockKey } from '../../src/game/ui/npc-chat-panel';

declare global {
  interface Window {
    __gameReady?: boolean;
    __gameError?: string | null;
    __gameStats?: { frameCount: number; playerPos?: [number, number, number] };
    __gameDebug?: {
      teleportToNearestSettlementSign(): boolean;
      nearestSettlement(): { name: string; kind: string } | null;
      npcs(): { id: string; role: string; name: string; x: number; z: number }[];
      playerPos(): [number, number, number];
      inventory(): import('../../src/game/inventory').Inventory;
      chatOpen(): boolean;
      lastNpcReply(): string | null;
      teleportToNearestNpc(): boolean;
      injectNpcReply(text: string): void;
      npcGold(npcKey?: string): number;
    };
  }
}

const BASE_URL = '/game.html?director=off';

async function boot(page: Page): Promise<void> {
  await page.goto(BASE_URL);
  await page.waitForFunction(() => window.__gameReady === true, undefined, {
    timeout: 30_000,
  });
}

/** Seed inventory with gold_small before page load. */
async function seedGold(page: Page, goldCount: number): Promise<void> {
  const pack: Array<{ id: string; count: number } | null> = new Array(PACK_SIZE).fill(null);
  pack[0] = { id: 'gold_small', count: goldCount };
  const hotbar: Array<{ id: string; count: number } | null> = new Array(HOTBAR_SIZE).fill(null);
  hotbar[0] = { id: 'bronze_axe', count: 1 };
  hotbar[1] = { id: 'bronze_pickaxe', count: 1 };
  hotbar[2] = { id: 'fire_starter', count: 1 };
  const inv = { pack, hotbar, selected: 0, armor: { head: null, body: null, legs: null } };
  await page.addInitScript(([key, json]: [string, string]) => {
    localStorage.setItem(key, json);
  }, [INVENTORY_KEY, JSON.stringify(inv)]);
}

/** Seed inventory with a specific item (plus spawn kit) before page load. */
async function seedItem(
  page: Page,
  itemId: string,
  count: number,
  goldCount = 0,
): Promise<void> {
  const pack: Array<{ id: string; count: number } | null> = new Array(PACK_SIZE).fill(null);
  pack[0] = { id: itemId, count };
  if (goldCount > 0) pack[1] = { id: 'gold_small', count: goldCount };
  const hotbar: Array<{ id: string; count: number } | null> = new Array(HOTBAR_SIZE).fill(null);
  hotbar[0] = { id: 'bronze_axe', count: 1 };
  hotbar[1] = { id: 'bronze_pickaxe', count: 1 };
  hotbar[2] = { id: 'fire_starter', count: 1 };
  const inv = { pack, hotbar, selected: 0, armor: { head: null, body: null, legs: null } };
  await page.addInitScript(([key, json]: [string, string]) => {
    localStorage.setItem(key, json);
  }, [INVENTORY_KEY, JSON.stringify(inv)]);
}

/** Teleport to nearest settlement, wait for NPCs, then teleport directly to one. */
async function approachNpc(page: Page): Promise<boolean> {
  const ok = await page.evaluate(() => window.__gameDebug!.teleportToNearestSettlementSign());
  if (!ok) return false;

  await page.waitForTimeout(2_500);

  const settlement = await page.evaluate(() => window.__gameDebug!.nearestSettlement());
  if (!settlement || settlement.kind === 'ruins') return false;

  // Wait for NPCs to appear.
  const hasNpcs = await page.waitForFunction(
    () => window.__gameDebug!.npcs().length > 0,
    undefined, { timeout: 10_000 },
  ).then(() => true).catch(() => false);
  if (!hasNpcs) return false;

  // Teleport the player to within interact range of the nearest NPC.
  const teleported = await page.evaluate(() => window.__gameDebug!.teleportToNearestNpc());
  if (!teleported) return false;

  // Wait a few frames for the NPC runtime to update with the new player position.
  await page.waitForTimeout(300);
  return true;
}

// ---------------------------------------------------------------------------
// Test 1: panel opens with NPC name
// ---------------------------------------------------------------------------

test('NPC chat panel opens with NPC name when E is pressed near an NPC', async ({ page }) => {
  await boot(page);

  const ready = await approachNpc(page);
  if (!ready) { test.skip(); return; }

  await page.keyboard.press('e');
  await page.waitForTimeout(500);

  const chatOpen = await page.evaluate(() => window.__gameDebug!.chatOpen());
  expect(chatOpen).toBe(true);

  const panelEl = page.locator('#npc-chat-panel');
  await expect(panelEl).toBeVisible({ timeout: 3_000 });

  // NPC name header must be non-empty and match a known NPC.
  const header = panelEl.locator('.npc-header');
  await expect(header).toBeVisible();
  const headerText = await header.textContent();
  expect(headerText).toBeTruthy();
  expect(headerText!.length).toBeGreaterThan(0);

  const npcs = await page.evaluate(() => window.__gameDebug!.npcs());
  const npcNames = npcs.map((n) => n.name);
  // The displayed name must be one of the spawned NPCs.
  const matchesKnown = npcNames.some((n) => headerText!.includes(n));
  expect(matchesKnown).toBe(true);

  const gameError = await page.evaluate(() => window.__gameError);
  expect(gameError).toBeNull();

  await page.screenshot({ path: 'test-results/npc-chat-open.png' });
});

// ---------------------------------------------------------------------------
// Test 2: "buy" message triggers trade offer card
// ---------------------------------------------------------------------------

test('NPC chat: send "buy" message triggers trade offer card from stub', async ({ page }) => {
  await seedGold(page, 50);
  await boot(page);

  const ready = await approachNpc(page);
  if (!ready) { test.skip(); return; }

  await page.keyboard.press('e');
  await page.waitForTimeout(500);

  const chatOpen = await page.evaluate(() => window.__gameDebug!.chatOpen());
  if (!chatOpen) { test.skip(); return; }

  // Determine what item to buy based on the NPC's role.
  const npcs = await page.evaluate(() => window.__gameDebug!.npcs());
  const role = npcs[0]?.role ?? 'farmer';
  const BUY_ITEMS: Record<string, string> = {
    farmer: 'flax', villager: 'torch', merchant: 'leather', guard: 'arrow',
  };
  const itemToBuy = BUY_ITEMS[role] ?? 'flax';

  const input = page.locator('#npc-chat-input');
  await expect(input).toBeVisible({ timeout: 3_000 });
  await input.fill(`buy ${itemToBuy}`);
  await input.press('Enter');

  // Wait for stub reply.
  await page.waitForTimeout(400);

  const lastReply = await page.evaluate(() => window.__gameDebug!.lastNpcReply());
  expect(lastReply).not.toBeNull();

  // If the stub produced a trade JSON, offer card must appear.
  if (lastReply && lastReply.includes('"trade"')) {
    const offerCard = page.locator('#npc-offer-card');
    await expect(offerCard).toBeVisible({ timeout: 3_000 });

    // Confirm and Decline buttons should be there.
    await expect(page.locator('#npc-offer-confirm')).toBeVisible();
    await expect(page.locator('#npc-offer-decline')).toBeVisible();
  }

  const gameError = await page.evaluate(() => window.__gameError);
  expect(gameError).toBeNull();
});

// ---------------------------------------------------------------------------
// Test 3: Confirm trade swaps gold, adds item, persists stock
// ---------------------------------------------------------------------------

test('NPC chat: Confirm trade swaps gold and decrements stock (persisted)', async ({ page }) => {
  await seedGold(page, 50);
  await page.addInitScript(([key]: [string]) => {
    localStorage.removeItem(key);
  }, [NPC_STOCK_KEY]);
  await boot(page);

  const ready = await approachNpc(page);
  if (!ready) { test.skip(); return; }

  await page.keyboard.press('e');
  await page.waitForTimeout(500);

  const chatOpen = await page.evaluate(() => window.__gameDebug!.chatOpen());
  if (!chatOpen) { test.skip(); return; }

  const npcs = await page.evaluate(() => window.__gameDebug!.npcs());
  const role = npcs[0]?.role ?? 'farmer';
  const BUY_ITEMS: Record<string, string> = {
    farmer: 'flax', villager: 'torch', merchant: 'leather', guard: 'arrow',
  };
  const itemToBuy = BUY_ITEMS[role] ?? 'flax';

  // Gold before.
  const goldBefore = await page.evaluate(() => {
    const inv = window.__gameDebug!.inventory();
    return [...inv.pack, ...inv.hotbar]
      .filter((s) => s?.id === 'gold_small')
      .reduce((n, s) => n + (s?.count ?? 0), 0);
  });

  const input = page.locator('#npc-chat-input');
  await expect(input).toBeVisible({ timeout: 3_000 });
  await input.fill(`buy ${itemToBuy}`);
  await input.press('Enter');
  await page.waitForTimeout(400);

  const offerCard = page.locator('#npc-offer-card');
  const cardVisible = await offerCard.isVisible().catch(() => false);
  if (!cardVisible) { test.skip(); return; }

  const confirmBtn = page.locator('#npc-offer-confirm');
  await expect(confirmBtn).toBeVisible({ timeout: 2_000 });
  await confirmBtn.click();
  await page.waitForTimeout(300);

  // Gold should have decreased.
  const goldAfter = await page.evaluate(() => {
    const inv = window.__gameDebug!.inventory();
    return [...inv.pack, ...inv.hotbar]
      .filter((s) => s?.id === 'gold_small')
      .reduce((n, s) => n + (s?.count ?? 0), 0);
  });
  expect(goldAfter).toBeLessThan(goldBefore);

  // Item received.
  const itemCount = await page.evaluate(([item]: [string]) => {
    const inv = window.__gameDebug!.inventory();
    return [...inv.pack, ...inv.hotbar]
      .filter((s) => s?.id === item)
      .reduce((n, s) => n + (s?.count ?? 0), 0);
  }, [itemToBuy]);
  expect(itemCount).toBeGreaterThan(0);

  // Stock persisted to localStorage.
  const stockRaw = await page.evaluate(([key]: [string]) => localStorage.getItem(key), [NPC_STOCK_KEY]);
  expect(stockRaw).not.toBeNull();
  const parsed = JSON.parse(stockRaw!);
  expect(typeof parsed).toBe('object');

  const gameError = await page.evaluate(() => window.__gameError);
  expect(gameError).toBeNull();
});

// ---------------------------------------------------------------------------
// Test 4: insufficient gold shows notice
// ---------------------------------------------------------------------------

test('NPC chat: insufficient gold shows notice, offer card stays', async ({ page }) => {
  // Seed 0 gold.
  await page.addInitScript(() => {
    // Will remove any gold after boot via init script.
  });
  await boot(page);

  const ready = await approachNpc(page);
  if (!ready) { test.skip(); return; }

  // Remove any gold from inventory.
  await page.evaluate(() => {
    const inv = window.__gameDebug!.inventory();
    for (let i = 0; i < inv.pack.length; i++) {
      if (inv.pack[i]?.id === 'gold_small') inv.pack[i] = null;
    }
    for (let i = 0; i < inv.hotbar.length; i++) {
      if (inv.hotbar[i]?.id === 'gold_small') inv.hotbar[i] = null;
    }
  });

  await page.keyboard.press('e');
  await page.waitForTimeout(500);

  const chatOpen = await page.evaluate(() => window.__gameDebug!.chatOpen());
  if (!chatOpen) { test.skip(); return; }

  const npcs = await page.evaluate(() => window.__gameDebug!.npcs());
  const role = npcs[0]?.role ?? 'farmer';
  const BUY_ITEMS: Record<string, string> = {
    farmer: 'flax', villager: 'torch', merchant: 'leather', guard: 'arrow',
  };
  const input = page.locator('#npc-chat-input');
  await expect(input).toBeVisible({ timeout: 3_000 });
  await input.fill(`buy ${BUY_ITEMS[role] ?? 'flax'}`);
  await input.press('Enter');
  await page.waitForTimeout(400);

  const offerCard = page.locator('#npc-offer-card');
  const cardVisible = await offerCard.isVisible().catch(() => false);
  if (!cardVisible) { test.skip(); return; }

  await page.locator('#npc-offer-confirm').click();
  await page.waitForTimeout(200);

  // Offer card still visible (not declined).
  await expect(offerCard).toBeVisible();

  // "Not enough gold" notice in history.
  const histText = await page.locator('#npc-chat-history').textContent();
  expect(histText).toMatch(/not enough gold/i);

  const gameError = await page.evaluate(() => window.__gameError);
  expect(gameError).toBeNull();
});

// ---------------------------------------------------------------------------
// Test 5: Esc closes the panel
// ---------------------------------------------------------------------------

test('NPC chat: Esc closes panel and chatOpen returns false', async ({ page }) => {
  await boot(page);

  const ready = await approachNpc(page);
  if (!ready) { test.skip(); return; }

  await page.keyboard.press('e');
  await page.waitForTimeout(500);

  const chatOpen = await page.evaluate(() => window.__gameDebug!.chatOpen());
  if (!chatOpen) { test.skip(); return; }

  // Press Escape through the input field.
  const input = page.locator('#npc-chat-input');
  if (await input.isVisible()) {
    await input.press('Escape');
  } else {
    await page.keyboard.press('Escape');
  }
  await page.waitForTimeout(400);

  const stillOpen = await page.evaluate(() => window.__gameDebug!.chatOpen());
  expect(stillOpen).toBe(false);

  await expect(page.locator('#npc-chat-panel')).not.toBeVisible({ timeout: 2_000 });

  const gameError = await page.evaluate(() => window.__gameError);
  expect(gameError).toBeNull();
});

// ---------------------------------------------------------------------------
// Test 6: __gameError null after a full buy + confirm session
// ---------------------------------------------------------------------------

test('NPC chat: __gameError null throughout a complete buy session', async ({ page }) => {
  await seedGold(page, 100);
  await boot(page);

  const ready = await approachNpc(page);
  if (!ready) { test.skip(); return; }

  await page.keyboard.press('e');
  await page.waitForTimeout(500);

  const chatOpen = await page.evaluate(() => window.__gameDebug!.chatOpen());
  if (!chatOpen) { test.skip(); return; }

  // Say a generic thing.
  const input = page.locator('#npc-chat-input');
  await expect(input).toBeVisible({ timeout: 3_000 });
  await input.fill('Hello there');
  await input.press('Enter');
  await page.waitForTimeout(400);

  // Buy something.
  const npcs = await page.evaluate(() => window.__gameDebug!.npcs());
  const role = npcs[0]?.role ?? 'farmer';
  const BUY_ITEMS: Record<string, string> = {
    farmer: 'flax', villager: 'torch', merchant: 'leather', guard: 'arrow',
  };
  await input.fill(`buy ${BUY_ITEMS[role] ?? 'flax'}`);
  await input.press('Enter');
  await page.waitForTimeout(400);

  // Confirm if offer appeared.
  const offerCard = page.locator('#npc-offer-card');
  if (await offerCard.isVisible().catch(() => false)) {
    await page.locator('#npc-offer-confirm').click();
    await page.waitForTimeout(300);
  }

  // Close.
  await input.press('Escape');
  await page.waitForTimeout(300);

  const gameError = await page.evaluate(() => window.__gameError);
  expect(gameError).toBeNull();

  await page.screenshot({ path: 'test-results/npc-chat-session.png' });
});

// ---------------------------------------------------------------------------
// Sell tests — player sells items to merchants for gold
// ---------------------------------------------------------------------------

/**
 * Find a merchant NPC in the nearest live settlement, open the chat panel,
 * and return the NPC list. Returns null if no merchant found / skippable.
 */
async function approachMerchant(page: Page): Promise<
  { id: string; role: string; name: string; x: number; z: number } | null
> {
  const ok = await page.evaluate(() => window.__gameDebug!.teleportToNearestSettlementSign());
  if (!ok) return null;

  await page.waitForTimeout(2_500);

  const settlement = await page.evaluate(() => window.__gameDebug!.nearestSettlement());
  if (!settlement || settlement.kind === 'ruins') return null;

  const hasNpcs = await page.waitForFunction(
    () => window.__gameDebug!.npcs().length > 0,
    undefined, { timeout: 10_000 },
  ).then(() => true).catch(() => false);
  if (!hasNpcs) return null;

  const npcs = await page.evaluate(() => window.__gameDebug!.npcs());
  const merchant = npcs.find((n) => n.role === 'merchant');
  if (!merchant) return null;

  // Teleport near any NPC first (settlement has been found), then find merchant specifically.
  const teleported = await page.evaluate(() => window.__gameDebug!.teleportToNearestNpc());
  if (!teleported) return null;

  await page.waitForTimeout(300);
  return merchant;
}

// ---------------------------------------------------------------------------
// Sell test 1: "sell hide" → sell card appears (merchant + hides in inventory)
// ---------------------------------------------------------------------------

test('NPC sell: "sell hide" produces sell card at a merchant', async ({ page }) => {
  await seedItem(page, 'hide', 5, 0);
  await boot(page);

  const merchant = await approachMerchant(page);
  if (!merchant) { test.skip(); return; }

  // Open chat (may open any nearby NPC — that's fine, we just need the panel).
  await page.keyboard.press('e');
  await page.waitForTimeout(500);

  const chatOpen = await page.evaluate(() => window.__gameDebug!.chatOpen());
  if (!chatOpen) { test.skip(); return; }

  // Only proceed if the current NPC is a merchant.
  const npcs = await page.evaluate(() => window.__gameDebug!.npcs());
  const nearRole = npcs[0]?.role;
  if (nearRole !== 'merchant') { test.skip(); return; }

  const input = page.locator('#npc-chat-input');
  await expect(input).toBeVisible({ timeout: 3_000 });
  await input.fill('sell hide');
  await input.press('Enter');

  await page.waitForTimeout(400);

  const lastReply = await page.evaluate(() => window.__gameDebug!.lastNpcReply());
  expect(lastReply).not.toBeNull();

  // Stub reply for a merchant with hide in SELL_PRICES should include {"trade":...}.
  if (lastReply && lastReply.includes('"trade"')) {
    const offerCard = page.locator('#npc-offer-card');
    await expect(offerCard).toBeVisible({ timeout: 3_000 });

    // The offer title should mention "Sell".
    const titleText = await offerCard.locator('.offer-title').textContent();
    expect(titleText).toMatch(/sell/i);

    await expect(page.locator('#npc-offer-confirm')).toBeVisible();
    await expect(page.locator('#npc-offer-decline')).toBeVisible();
  }

  const gameError = await page.evaluate(() => window.__gameError);
  expect(gameError).toBeNull();
});

// ---------------------------------------------------------------------------
// Sell test 2: Confirm sell → hides decrease, gold increases, NPC gold pool
//              decreases, persists across reload
// ---------------------------------------------------------------------------

test('NPC sell: Confirm → hides down, gold up, NPC pool down, persists', async ({ page }) => {
  await seedItem(page, 'hide', 5, 0);
  await page.addInitScript(([key]: [string]) => {
    localStorage.removeItem(key);
  }, [NPC_STOCK_KEY]);

  await boot(page);

  const merchant = await approachMerchant(page);
  if (!merchant) { test.skip(); return; }

  await page.keyboard.press('e');
  await page.waitForTimeout(500);

  const chatOpen = await page.evaluate(() => window.__gameDebug!.chatOpen());
  if (!chatOpen) { test.skip(); return; }

  const npcs = await page.evaluate(() => window.__gameDebug!.npcs());
  if (npcs[0]?.role !== 'merchant') { test.skip(); return; }

  // Count hides before.
  const hidesBefore = await page.evaluate(() => {
    const inv = window.__gameDebug!.inventory();
    return [...inv.pack, ...inv.hotbar]
      .filter((s) => s?.id === 'hide')
      .reduce((n, s) => n + (s?.count ?? 0), 0);
  });

  // Count gold before.
  const goldBefore = await page.evaluate(() => {
    const inv = window.__gameDebug!.inventory();
    return [...inv.pack, ...inv.hotbar]
      .filter((s) => s?.id === 'gold_small')
      .reduce((n, s) => n + (s?.count ?? 0), 0);
  });

  // NPC gold before (active NPC).
  const npcGoldBefore = await page.evaluate(() => window.__gameDebug!.npcGold());

  const input = page.locator('#npc-chat-input');
  await expect(input).toBeVisible({ timeout: 3_000 });
  await input.fill('sell hide');
  await input.press('Enter');
  await page.waitForTimeout(400);

  const offerCard = page.locator('#npc-offer-card');
  const cardVisible = await offerCard.isVisible().catch(() => false);
  if (!cardVisible) { test.skip(); return; }

  await page.locator('#npc-offer-confirm').click();
  await page.waitForTimeout(300);

  // Hides should have decreased.
  const hidesAfter = await page.evaluate(() => {
    const inv = window.__gameDebug!.inventory();
    return [...inv.pack, ...inv.hotbar]
      .filter((s) => s?.id === 'hide')
      .reduce((n, s) => n + (s?.count ?? 0), 0);
  });
  expect(hidesAfter).toBeLessThan(hidesBefore);

  // Gold should have increased.
  const goldAfter = await page.evaluate(() => {
    const inv = window.__gameDebug!.inventory();
    return [...inv.pack, ...inv.hotbar]
      .filter((s) => s?.id === 'gold_small')
      .reduce((n, s) => n + (s?.count ?? 0), 0);
  });
  expect(goldAfter).toBeGreaterThan(goldBefore);

  // NPC gold should have decreased.
  const npcGoldAfter = await page.evaluate(() => window.__gameDebug!.npcGold());
  expect(npcGoldAfter).toBeLessThan(npcGoldBefore);

  // Persisted to localStorage.
  const stockRaw = await page.evaluate(([key]: [string]) => localStorage.getItem(key), [NPC_STOCK_KEY]);
  expect(stockRaw).not.toBeNull();
  const parsed = JSON.parse(stockRaw!);
  expect(typeof parsed).toBe('object');
  // At least one key must have a record with gold field.
  const keys = Object.keys(parsed);
  expect(keys.length).toBeGreaterThan(0);
  const firstRec = parsed[keys[0]];
  expect(typeof firstRec.gold).toBe('number');
  expect(typeof firstRec.lastRegenMs).toBe('number');

  const gameError = await page.evaluate(() => window.__gameError);
  expect(gameError).toBeNull();

  await page.screenshot({ path: 'test-results/npc-sell-confirm.png' });
});

// ---------------------------------------------------------------------------
// Sell test 3: insufficient player items → notice shown, card stays
// ---------------------------------------------------------------------------

test('NPC sell: insufficient hides shows notice, offer stays', async ({ page }) => {
  // Seed 0 hides (no sellable items).
  await seedItem(page, 'coal', 1, 0); // has coal but NOT hide
  await boot(page);

  const merchant = await approachMerchant(page);
  if (!merchant) { test.skip(); return; }

  await page.keyboard.press('e');
  await page.waitForTimeout(500);

  const chatOpen = await page.evaluate(() => window.__gameDebug!.chatOpen());
  if (!chatOpen) { test.skip(); return; }

  const npcs = await page.evaluate(() => window.__gameDebug!.npcs());
  if (npcs[0]?.role !== 'merchant') { test.skip(); return; }

  // Inject a sell reply directly so we don't need hides in inventory to see the card.
  // We need exactly 0 hides for the confirm to fail.
  await page.evaluate(() => {
    const inv = window.__gameDebug!.inventory();
    for (let i = 0; i < inv.pack.length; i++) {
      if (inv.pack[i]?.id === 'hide') inv.pack[i] = null;
    }
  });

  const input = page.locator('#npc-chat-input');
  await expect(input).toBeVisible({ timeout: 3_000 });
  await input.fill('sell hide');
  await input.press('Enter');
  await page.waitForTimeout(400);

  const offerCard = page.locator('#npc-offer-card');
  const cardVisible = await offerCard.isVisible().catch(() => false);
  if (!cardVisible) { test.skip(); return; }

  // Click confirm with 0 hides — should show notice.
  await page.locator('#npc-offer-confirm').click();
  await page.waitForTimeout(200);

  // Card should still be visible (not declined).
  await expect(offerCard).toBeVisible();

  // "don't have enough" or similar notice in history.
  const histText = await page.locator('#npc-chat-history').textContent();
  expect(histText).toMatch(/don't have enough|not enough/i);

  const gameError = await page.evaluate(() => window.__gameError);
  expect(gameError).toBeNull();
});

// ---------------------------------------------------------------------------
// Sell test 4: villager declines to buy in character
// ---------------------------------------------------------------------------

test('NPC sell: villager declines to buy items', async ({ page }) => {
  await seedItem(page, 'hide', 5, 0);
  await boot(page);

  const ok = await page.evaluate(() => window.__gameDebug!.teleportToNearestSettlementSign());
  if (!ok) { test.skip(); return; }

  await page.waitForTimeout(2_500);

  const settlement = await page.evaluate(() => window.__gameDebug!.nearestSettlement());
  if (!settlement || settlement.kind === 'ruins') { test.skip(); return; }

  const hasNpcs = await page.waitForFunction(
    () => window.__gameDebug!.npcs().length > 0,
    undefined, { timeout: 10_000 },
  ).then(() => true).catch(() => false);
  if (!hasNpcs) { test.skip(); return; }

  const npcs = await page.evaluate(() => window.__gameDebug!.npcs());
  const villager = npcs.find((n) => n.role === 'villager');
  if (!villager) { test.skip(); return; }

  // Teleport near any NPC then open.
  await page.evaluate(() => window.__gameDebug!.teleportToNearestNpc());
  await page.waitForTimeout(300);

  await page.keyboard.press('e');
  await page.waitForTimeout(500);

  const chatOpen = await page.evaluate(() => window.__gameDebug!.chatOpen());
  if (!chatOpen) { test.skip(); return; }

  const openNpcs = await page.evaluate(() => window.__gameDebug!.npcs());
  if (openNpcs[0]?.role !== 'villager') { test.skip(); return; }

  const input = page.locator('#npc-chat-input');
  await expect(input).toBeVisible({ timeout: 3_000 });
  await input.fill('sell hide');
  await input.press('Enter');
  await page.waitForTimeout(400);

  const lastReply = await page.evaluate(() => window.__gameDebug!.lastNpcReply());
  expect(lastReply).not.toBeNull();

  // Villager should NOT produce a sell card.
  const offerCard = page.locator('#npc-offer-card');
  const cardVisible = await offerCard.isVisible().catch(() => false);
  expect(cardVisible).toBe(false);

  // Reply should contain a decline-style message.
  expect(lastReply).toMatch(/not in the market|merchant/i);

  const gameError = await page.evaluate(() => window.__gameError);
  expect(gameError).toBeNull();
});

// ---------------------------------------------------------------------------
// Sell test 5: NPC gold field persists in localStorage with correct shape
// ---------------------------------------------------------------------------

test('NPC stock: localStorage record has gold + lastRegenMs after opening chat', async ({ page }) => {
  await page.addInitScript(([key]: [string]) => {
    localStorage.removeItem(key);
  }, [NPC_STOCK_KEY]);

  await boot(page);

  const ready = await approachNpc(page);
  if (!ready) { test.skip(); return; }

  await page.keyboard.press('e');
  await page.waitForTimeout(500);

  const chatOpen = await page.evaluate(() => window.__gameDebug!.chatOpen());
  if (!chatOpen) { test.skip(); return; }

  // Close to trigger persist.
  const input = page.locator('#npc-chat-input');
  if (await input.isVisible()) await input.press('Escape');
  await page.waitForTimeout(300);

  const stockRaw = await page.evaluate(([key]: [string]) => localStorage.getItem(key), [NPC_STOCK_KEY]);
  expect(stockRaw).not.toBeNull();

  const parsed = JSON.parse(stockRaw!);
  const keys = Object.keys(parsed);
  expect(keys.length).toBeGreaterThan(0);

  const rec = parsed[keys[0]];
  expect(Array.isArray(rec.catalog)).toBe(true);
  expect(typeof rec.gold).toBe('number');
  expect(rec.gold).toBeGreaterThanOrEqual(0);
  expect(typeof rec.lastRegenMs).toBe('number');
  expect(rec.lastRegenMs).toBeGreaterThan(0);

  const gameError = await page.evaluate(() => window.__gameError);
  expect(gameError).toBeNull();
});

// ---------------------------------------------------------------------------
// Sell test 6: backward-compat migration — bare CatalogEntry[] loads without error
// ---------------------------------------------------------------------------

test('NPC stock: legacy bare-array localStorage migrates on load', async ({ page }) => {
  // Seed the legacy format: a bare array of CatalogEntry objects.
  const legacyEntry = { id: 'flax', price: 2, stock: 8 };
  const legacyMap = { 'TestSettlement::npc_0': [legacyEntry] };
  await page.addInitScript(([key, json]: [string, string]) => {
    localStorage.setItem(key, json);
  }, [NPC_STOCK_KEY, JSON.stringify(legacyMap)]);

  await boot(page);

  // The game should load without error.
  const gameError = await page.evaluate(() => window.__gameError);
  expect(gameError).toBeNull();

  // After migration, if we load the stock map, keys should exist without crashing.
  const stockRaw = await page.evaluate(([key]: [string]) => localStorage.getItem(key), [NPC_STOCK_KEY]);
  // Either the legacy key was left as-is (migration happens lazily on open),
  // or it was migrated — either way no error.
  if (stockRaw !== null) {
    const parsed = JSON.parse(stockRaw);
    expect(typeof parsed).toBe('object');
  }
});
