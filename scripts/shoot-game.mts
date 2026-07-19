/**
 * Visual QA harness — drives the game headless (same Chrome/WebGPU flags as
 * playwright.config.ts) and saves staged screenshots to scripts/shots/ so
 * meshes, poses, and UI can be reviewed without a headed session.
 *
 * Run:  npx tsx scripts/shoot-game.mts [name-filter]
 */

import { chromium, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:5173/game.html?director=off&tod=0.35&weather=clear';
const OUT = 'scripts/shots';

interface Shot {
  name: string;
  setup: (page: Page) => Promise<void>;
  /** Override the boot URL (e.g. night / rain pins). */
  url?: string;
}

/** Wait for boot + enough chunks/frames that the world is visible. */
async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__gameReady === true, undefined, {
    timeout: 30_000,
  });
  await page.waitForFunction(
    () => ((window as any).__gameStats?.chunkCount ?? 0) > 120, undefined,
    { timeout: 20_000 });
  await page.waitForTimeout(500); // resource meshes + a few frames
  await page.evaluate(() => {
    const o = document.getElementById('overlay');
    if (o !== null) o.style.display = 'none';
  });
}

const cam = (page: Page, yaw: number, pitch: number, dist: number) =>
  page.evaluate(([y, p, d]) =>
    (window as any).__gameDebug.setCamera(y, p, d), [yaw, pitch, dist]);

const equip = (page: Page, id: string) =>
  page.evaluate((i) => (window as any).__gameDebug.equipItem(i), id);

const freeze = (page: Page, t: number | null) =>
  page.evaluate((v) => (window as any).__gameDebug.freezeAttackT(v), t);

const teleport = (page: Page, type: string) =>
  page.evaluate((t) =>
    (window as any).__gameDebug.teleportToNearestResource(t), type);

const settle = (page: Page) => page.waitForTimeout(400);

const TOOLS = ['bronze_axe', 'bronze_pickaxe', 'iron_sword', 'hunter_bow', 'oak_staff'];

const shots: Shot[] = [
  // Held-tool review: front / side / back, idle + mid-swing, close up.
  ...TOOLS.flatMap((id): Shot[] => [
    {
      name: `${id}-front`,
      setup: async (p) => {
        await equip(p, id);
        // Idle faces -Z (controller.yaw 0); camera yaw π looks +Z = face-on.
        await cam(p, Math.PI, 0.10, 3.2);
        await settle(p);
      },
    },
    {
      name: `${id}-right`,
      setup: async (p) => {
        await equip(p, id);
        await cam(p, Math.PI / 2, 0.10, 3.2);
        await settle(p);
      },
    },
    {
      name: `${id}-swing`,
      setup: async (p) => {
        await equip(p, id);
        await freeze(p, 0.40); // windup peak: arm cocked overhead
        await cam(p, Math.PI * 0.7, 0.15, 3.2);
        await settle(p);
      },
    },
    {
      name: `${id}-strike`,
      setup: async (p) => {
        await equip(p, id);
        await freeze(p, 0.60); // just before impact: arm slamming down
        await cam(p, Math.PI * 0.7, 0.15, 3.2);
        await settle(p);
      },
    },
  ]),
  {
    name: 'character-back',
    setup: async (p) => {
      await cam(p, 0, 0.25, 4.5);
      await settle(p);
    },
  },
  {
    name: 'world-overview',
    setup: async (p) => {
      await cam(p, Math.PI * 0.25, 0.55, 10);
      await settle(p);
    },
  },
  {
    name: 'near-rock',
    setup: async (p) => {
      await teleport(p, 'rock');
      await cam(p, Math.PI * 1.25, 0.15, 5);
      await p.waitForTimeout(800);
    },
  },
  {
    name: 'near-bush',
    setup: async (p) => {
      await teleport(p, 'bush');
      await cam(p, Math.PI * 1.25, 0.15, 5);
      await p.waitForTimeout(800);
    },
  },
  {
    name: 'near-tree',
    setup: async (p) => {
      await teleport(p, 'tree');
      await cam(p, Math.PI * 1.25, 0.15, 6);
      await p.waitForTimeout(800);
    },
  },
  {
    // Diag: idle character never turns — orbiting the camera to the front
    // shows the eyes staring at you even though the player did nothing.
    name: 'diag-idle-orbit-front',
    setup: async (p) => {
      await cam(p, Math.PI, 0.15, 4);
      await settle(p);
    },
  },
  {
    // Diag: hold D (camera behind at yaw 0, so +X = screen-right). The
    // character must end up facing screen-right — profile with the held
    // item on the camera side.
    name: 'diag-strafe-D',
    setup: async (p) => {
      await equip(p, 'bronze_axe');
      await cam(p, 0, 0.35, 5);
      await p.keyboard.down('d');
      await p.waitForTimeout(500);
      await p.keyboard.up('d');
      await settle(p);
    },
  },
  {
    // Diag: W+D diagonal — facing must split the difference (away-right),
    // not mirror to away-left.
    name: 'diag-move-WD',
    setup: async (p) => {
      await equip(p, 'bronze_axe');
      await cam(p, 0, 0.35, 5);
      await p.keyboard.down('w');
      await p.keyboard.down('d');
      await p.waitForTimeout(500);
      await p.keyboard.up('w');
      await p.keyboard.up('d');
      await settle(p);
    },
  },
  {
    // Diag: strafe so the body faces across the camera, then do a REAL
    // click-swing under pointer lock — the character must turn to face the
    // tree it chops (main.ts re-aims controller.yaw on swing).
    name: 'diag-chop-facing',
    setup: async (p) => {
      await teleport(p, 'tree');
      await equip(p, 'bronze_axe');
      await p.keyboard.down('a');
      await p.waitForTimeout(250);
      await p.keyboard.up('a');
      await p.evaluate(() => {
        const o = document.getElementById('overlay');
        if (o !== null) o.style.display = '';
      });
      await p.locator('#overlay').click();
      await p.waitForFunction(() => document.pointerLockElement !== null);
      await p.mouse.down();
      await p.mouse.up();
      await freeze(p, 0.60); // hold the swing just before impact for the shot
      await p.evaluate(() => {
        const o = document.getElementById('overlay');
        if (o !== null) o.style.display = 'none';
      });
      await cam(p, Math.PI * 1.5, 0.45, 6);
      await settle(p);
    },
  },
  {
    // Night + rain: stars, dark env, rain overlay in one look.
    name: 'scene-night-rain',
    url: 'http://localhost:5173/game.html?director=off&tod=0&weather=rain',
    setup: async (p) => {
      await cam(p, Math.PI * 0.25, 0.35, 8);
      await settle(p);
    },
  },
  {
    // Dusk: warm sun angle over the water.
    name: 'scene-dusk',
    url: 'http://localhost:5173/game.html?director=off&tod=0.72&weather=clear',
    setup: async (p) => {
      await cam(p, Math.PI * 0.25, 0.25, 8);
      await settle(p);
    },
  },
  {
    // Swim: walk into the sea until swimming, camera behind.
    name: 'scene-swim',
    setup: async (p) => {
      await cam(p, 0, 0.4, 7);
      await p.keyboard.down('w');
      await p.waitForTimeout(3500);
      await p.keyboard.up('w');
      await settle(p);
    },
  },
  {
    // Settlement: teleport to the nearest signpost.
    name: 'scene-settlement',
    setup: async (p) => {
      await p.evaluate(() =>
        (window as any).__gameDebug.teleportToNearestSettlementSign());
      await cam(p, Math.PI * 0.3, 0.35, 9);
      await p.waitForTimeout(1200);
    },
  },
  {
    name: 'panel-crafting',
    setup: async (p) => {
      await p.keyboard.press('b');
      await settle(p);
    },
  },
  {
    name: 'panel-inventory',
    setup: async (p) => {
      await p.keyboard.press('Tab');
      await settle(p);
    },
  },
];

const filter = process.argv[2] ?? '';

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  for (const shot of shots) {
    if (filter !== '' && !shot.name.includes(filter)) continue;
    await page.goto(shot.url ?? BASE);
    await ready(page);
    await shot.setup(page);
    const err = await page.evaluate(() => (window as any).__gameError);
    if (err !== null) throw new Error(`${shot.name}: __gameError = ${err}`);
    await page.screenshot({ path: `${OUT}/${shot.name}.png` });
    console.log(`shot: ${OUT}/${shot.name}.png`);
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
