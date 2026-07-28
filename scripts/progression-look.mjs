/**
 * What the crafting tree LOOKS like, in five frames.
 *
 *   node scripts/progression-look.mjs [baseUrl] [outDir]
 *
 * A companion to the assertions in `test-progression.mts` and the beats in
 * `save-delete-check.mjs` / `controller-ui-check.mjs`. Those prove the tree is
 * correct; this is the part a person has to look at, because "the locked rows
 * read as a tree with things left to find" and "the unlock notice is legible"
 * are judgements no assertion makes.
 *
 * Shots:
 *   01-tree-locked      the Camp page on a fresh save — tiers, silhouettes,
 *                       requirement lines
 *   02-loom-unlocked    the same page after forging a loom kit
 *   03-unlock-toast     THE TOAST, caught in the ~4 s it is up, right after
 *                       weaving the first cloth
 *   04-loom-placed      the station itself, in the world
 *   05-loom-tier-open   the loom tier open, with the canvas tent in it
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const OUT = process.argv[3] ?? 'scripts/shots/progression';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const findings = [];
const note = (severity, title, detail) => {
  findings.push({ severity, title, detail });
  process.stdout.write(`  ${severity === 'BUG' ? 'BUG ' : 'ok  '} ${title}\n`);
  if (detail) process.stdout.write(`       ${detail}\n`);
};

await page.routeWebSocket(/:5173\//, () => { /* swallow HMR */ });
await page.goto(`${BASE}/game.html?director=off&tod=0.45&weather=clear&wipe=1`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 90_000 });
await page.waitForTimeout(3000);

const D = async (fn, arg) => {
  const alive = await page.evaluate(() => typeof window.__gameDebug === 'object');
  if (!alive) {
    process.stdout.write('\n!! RUN INVALID — page reloaded mid-run\n');
    await browser.close();
    process.exit(2);
  }
  return page.evaluate(fn, arg);
};
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

const openPanel = async (category) => {
  await page.keyboard.press('KeyB');
  await page.waitForTimeout(650);
  await page.evaluate((c) => {
    document.querySelector(`#crafting-panel .craft-tab[data-category="${c}"]`)?.click();
  }, category);
  await page.waitForTimeout(350);
};
const closePanel = async () => {
  await page.keyboard.press('KeyB');
  await page.waitForTimeout(450);
};

// ---------------------------------------------------------------------------
// 1. A fresh tree
// ---------------------------------------------------------------------------
await D(() => window.__gameDebug.teleportToNearestSettlement('village'));
await page.waitForTimeout(8000);

await openPanel('camp');
const fresh = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#crafting-panel .recipe')];
  return {
    tiers: [...document.querySelectorAll('#crafting-panel .tier-head')]
      .map((h) => `${h.querySelector('span')?.textContent} ${h.querySelector('.tier-count')?.textContent}`),
    locked: rows.filter((r) => r.dataset.locked === '1').length,
    total: rows.length,
    // Does the panel actually fit on screen now that locked rows are drawn?
    fits: (() => {
      const el = document.getElementById('crafting-panel');
      const r = el.getBoundingClientRect();
      return r.top >= -1 && r.bottom <= window.innerHeight + 1;
    })(),
  };
});
await shot('01-tree-locked');
note(fresh.locked > 0 ? 'ok' : 'BUG', 'a fresh save shows a tree with things left to find',
  `${fresh.locked}/${fresh.total} locked · ${fresh.tiers.join(' · ')}`);
note(fresh.fits ? 'ok' : 'BUG',
  'and the panel fits on screen despite the extra rows',
  fresh.fits ? 'within the viewport' : 'the panel overflows — locked rows doubled the page');
await closePanel();

// ---------------------------------------------------------------------------
// 2. Build up to the loom
// ---------------------------------------------------------------------------
await D(() => {
  const g = window.__gameDebug;
  // Free pack slots — the starting kit fills all but one, and `craft` is
  // atomic, so with no room the output silently fails to appear.
  for (const id of ['dragon_scale', 'berries', 'healing_herb', 'meat_cooked',
    'coal', 'hide', 'gold_small']) g.takeItem(id, 99);
  g.giveItem('planks', 12);
  g.giveItem('iron_ingot', 8);
  g.giveItem('rope', 8);
  g.giveItem('wool_yarn', 9);
  const p = g.playerPos();
  g.placeFire(p[0] + 1.2, p[2], true);
});
await page.waitForTimeout(900);
await D(() => {
  const g = window.__gameDebug;
  const f = g.fires()[g.fires().length - 1];
  g.teleport(f.x, f.z);
});
await page.waitForTimeout(900);
await D(() => { window.__gameDebug.upgradeNearestFire(); });
await page.waitForTimeout(700);

await openPanel('camp');
const loomClick = await page.evaluate(() => {
  const row = document.querySelector('#crafting-panel .recipe[data-recipe="loom_kit"]');
  if (row === null) return 'no-row';
  if (row.dataset.locked === '1') return 'locked';
  const b = row.querySelector('.r-craft');
  if (b.disabled) return 'disabled';
  b.click();
  return 'clicked';
});
await page.waitForTimeout(700);
await shot('02-loom-unlocked');
note(loomClick === 'clicked' ? 'ok' : 'BUG', 'the loom kit forges', `panel: ${loomClick}`);
await closePanel();

// ---------------------------------------------------------------------------
// 3. THE TOAST — weave the first cloth and catch the notice while it is up
// ---------------------------------------------------------------------------
//
// `setGatherNotice` holds a line for 4 s, so the shot has to be taken inside
// that window. It renders into the HUD element, so the text can be read back
// as well as photographed — a screenshot alone cannot tell a present toast
// from an absent one at this resolution.
await D(() => {
  const p = window.__gameDebug.playerPos();
  window.__gameDebug.placeLoom(p[0] + 1.6, p[2], Math.PI);
});
await page.waitForTimeout(900);
await openPanel('camp');
const clothClick = await page.evaluate(() => {
  const row = document.querySelector('#crafting-panel .recipe[data-recipe="cloth_wool"]');
  if (row === null) return 'no-row';
  if (row.dataset.locked === '1') return 'locked';
  const b = row.querySelector('.r-craft');
  if (b.disabled) return 'disabled';
  b.click();
  return 'clicked';
});
await page.waitForTimeout(300);
// Close the panel so the toast is not behind it, and shoot inside the 4 s.
await closePanel();
const toast = await page.evaluate(() => {
  const hud = document.getElementById('hud');
  const lines = (hud?.textContent ?? '').split('\n');
  return lines.find((l) => /Recipe unlocked/.test(l)) ?? null;
});
await shot('03-unlock-toast');
note(clothClick === 'clicked' ? 'ok' : 'BUG', 'the first cloth weaves', `panel: ${clothClick}`);
note(toast !== null ? 'ok' : 'BUG',
  'and the unlock notice is on screen while it happens',
  toast === null ? 'no "Recipe unlocked" line in the HUD' : JSON.stringify(toast));

// ---------------------------------------------------------------------------
// 4. The station, in the world
// ---------------------------------------------------------------------------
// Framed on open ground rather than in the village lane it was woven in: the
// camera sits over the player's shoulder, so a loom straight ahead is a loom
// directly behind the character's own head, and a village wall behind that.
// A clear patch and a yaw that puts the station off-centre is the only way to
// actually see the thing.
const loomSite = await D(() => {
  const g = window.__gameDebug;
  const p = g.playerPos();
  let best = null;
  for (let dx = -140; dx <= 140; dx += 10) {
    for (let dz = -140; dz <= 140; dz += 10) {
      const x = Math.round(p[0] + dx);
      const z = Math.round(p[2] + dz);
      const h = g.groundHeightAt(x, z);
      if (h < 4) continue;
      const flat = Math.max(
        Math.abs(h - g.groundHeightAt(x + 3, z)),
        Math.abs(h - g.groundHeightAt(x, z + 3)));
      const away = Math.hypot(dx, dz);
      if (away < 60) continue;                 // out of the village
      if (best === null || flat < best.flat) best = { x, z, flat };
    }
  }
  return best;
});
await D(([x, z]) => {
  const g = window.__gameDebug;
  g.teleport(x, z);
  g.placeLoom(x - 2.6, z - 2.6, Math.PI * 0.25);
}, [loomSite.x, loomSite.z]);
await page.waitForTimeout(2600);
await D(() => {
  // Look down the diagonal at it, then swing 0.5 rad off so the loom clears
  // the character silhouette.
  window.__gameDebug.setCamera(Math.PI / 4 - 0.5, 0.12, 5.0);
});
await page.waitForTimeout(1800);
await shot('04-loom-placed');
const loomSeen = await D(() => window.__gameDebug.looms().length);
note(loomSeen > 0 ? 'ok' : 'BUG', 'the loom is standing in the world', `${loomSeen} placed`);

// ---------------------------------------------------------------------------
// 5. The tier it opened
// ---------------------------------------------------------------------------
await openPanel('armor');
await page.waitForTimeout(400);
const armorPage = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#crafting-panel .recipe')];
  const q = rows.find((r) => r.dataset.recipe === 'quilted_hood');
  return {
    tiers: [...document.querySelectorAll('#crafting-panel .tier-head')]
      .map((h) => `${h.querySelector('span')?.textContent} ${h.querySelector('.tier-count')?.textContent}`),
    quilted: q?.dataset.locked ?? null,
  };
});
await shot('05-loom-tier-open');
note(armorPage.quilted === '0' ? 'ok' : 'BUG',
  'and the quilted armour it unlocked is open on the Armor page',
  `quilted_hood locked=${armorPage.quilted} · ${armorPage.tiers.join(' · ')}`);
await closePanel();

const bugs = findings.filter((f) => f.severity === 'BUG');
process.stdout.write(`\nprogression-look: ${bugs.length} bugs, ${findings.length - bugs.length} ok\n`);
process.stdout.write(`shots in ${OUT}\n`);
await browser.close();
process.exit(bugs.length > 0 ? 1 : 0);
