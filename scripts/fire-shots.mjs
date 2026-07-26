/**
 * Fire visual harness — before/after frames for every fire surface in the game.
 *
 *   node scripts/fire-shots.mjs <outDir> [sceneFilter]
 *
 * Requires the vite dev server on :5173 (npx vite). Writes one PNG per scene
 * plus a session.json (so `node scripts/contact-sheet.mjs <outDir>` works).
 *
 * Framing rule, learned the hard way: the orbit camera always looks AT the
 * player (or the portrait subject), so a subject placed at a random offset can
 * easily sit off-screen or behind the player's head. Every scene here puts the
 * subject on the camera->player axis, BETWEEN the eye and the player, and then
 * asserts via __gameDebug/__gameStats that the subject actually exists.
 */

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] ?? 'scripts/shots/fire/current';
const filter = process.argv[3] ?? '';
fs.mkdirSync(outDir, { recursive: true });

/** Flat, above-water ground near the demo spawn (same anchor as the portraits). */
const ANCHOR = [244, -304];

/**
 * Flat dry ground search, lifted from creature-portraits.mjs. Passed to the
 * page as source text: page.evaluate callbacks cannot close over module scope.
 */
const FLAT = `(g, ax, az) => {
  let best = null;
  for (let i = -6; i <= 6; i++) for (let j = -6; j <= 6; j++) {
    const x = ax + i * 9, z = az + j * 9;
    const h = g.heightAt(x, z);
    if (h < 1.5) continue;
    let dev = 0;
    for (const [ox, oz] of [[3,0],[-3,0],[0,3],[0,-3]]) {
      dev = Math.max(dev, Math.abs(g.heightAt(x + ox, z + oz) - h));
    }
    if (!best || dev < best.dev) best = { x, z, dev };
  }
  return best ?? { x: ax, z: az, dev: 0 };
}`;

const SCENES = [
  // --- campfires ---------------------------------------------------------
  { name: 'campfire-night', kind: 'fire', q: 'tod=0.02&weather=clear',
    yaw: 2.5, pitch: 0.22, dist: 6.5, lead: 3.0 },
  { name: 'campfire-night-wide', kind: 'fire', q: 'tod=0.02&weather=clear',
    yaw: 0.7, pitch: 0.24, dist: 8.0, lead: 3.2 },
  { name: 'campfire-day', kind: 'fire', q: 'tod=0.50&weather=clear',
    yaw: 2.5, pitch: 0.22, dist: 6.5, lead: 3.0 },
  { name: 'forge-night', kind: 'fire', forge: true, q: 'tod=0.02&weather=clear',
    yaw: 2.5, pitch: 0.22, dist: 6.5, lead: 3.0 },
  // --- burning vegetation ------------------------------------------------
  { name: 'burning-tree-day', kind: 'burn', q: 'tod=0.42&weather=clear',
    pitch: 0.14, dist: 7.0, standoff: 5 },
  { name: 'burning-tree-night', kind: 'burn', q: 'tod=0.03&weather=clear',
    pitch: 0.14, dist: 7.0, standoff: 5 },
  // --- dragon breath -----------------------------------------------------
  // Breath aims along the dragon's yaw (which converges on the camera yaw)
  // with the camera pitch as its elevation, so a slightly NEGATIVE pitch keeps
  // the whole 20 m jet above ground instead of burying its tail in the hill.
  // `offAxis` orbits a decoy entity instead of the rider. The breath always
  // fires along the CAMERA FORWARD vector (dragon yaw converges on the camera
  // yaw, elevation is the camera pitch), so from the saddle the whole 20 m jet
  // foreshortens onto the crosshair and you see a flare, not a jet. Orbiting a
  // point off to the side is the only way to photograph its real shape.
  { name: 'dragon-breath-day', kind: 'breath', q: 'tod=0.45&weather=clear',
    yaw: 0.0, pitch: 0.10, dist: 22, offAxis: [5, -4] },
  { name: 'dragon-breath-night', kind: 'breath', q: 'tod=0.03&weather=clear',
    yaw: 0.0, pitch: 0.10, dist: 22, offAxis: [5, -4] },
  // The honest over-the-saddle gameplay view, for comparison.
  { name: 'dragon-breath-saddle', kind: 'breath', q: 'tod=0.45&weather=clear',
    yaw: 0.0, pitch: 0.30, dist: 20 },
  // --- torches: settlement fixtures and interior fires --------------------
  { name: 'village-night', kind: 'village', q: 'tod=0.03&weather=clear',
    yaw: 0.0, pitch: 0.55, dist: 26 },
  { name: 'building-interior', kind: 'building', q: 'tod=0.30&weather=clear',
    yaw: 0.0, pitch: 0.10, dist: 5 },
  { name: 'dungeon-torches', kind: 'dungeon', q: 'tod=0.30&weather=clear',
    yaw: 0.0, pitch: 0.05, dist: 6 },
];

const log = [];
let failed = 0;

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('Failed to load resource')) {
    console.log(`  [console] ${m.text()}`);
  }
});

for (const s of SCENES) {
  if (filter && !s.name.includes(filter)) continue;
  process.stdout.write(`${s.name} ... `);
  try {
    await page.goto(`http://localhost:5173/game.html?director=off&wipe=1&${s.q}`,
      { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__gameReady === true, undefined,
      { timeout: 60_000 });
    await page.waitForTimeout(1_500);
    // Hide the UI chrome so the frame is all game.
    await page.addStyleTag({ content:
      '#hud,#overlay,#hotbar,#compass,#stats,#vitals,#crosshair{display:none!important}' });

    const arg = { anchor: ANCHOR, s, flat: FLAT };
    let info;
    if (s.kind === 'fire') info = await page.evaluate(placeFireScene, arg);
    else if (s.kind === 'burn') info = await page.evaluate(placeBurnScene, arg);
    else if (s.kind === 'breath') info = await page.evaluate(placeBreathScene, arg);
    else info = await page.evaluate(placePlaceScene, arg);
    // Stream terrain in around the new spot. The forge case needs longer: the
    // chimney geometry only appears on the 5 s periodic rebuildFireDraws tick.
    await page.waitForTimeout(s.forge ? 7_000 : 4_000);

    if (s.kind === 'breath') {
      // Mount, then hold F long enough for the jaw blend (dtS/0.15) to open.
      await page.keyboard.press('KeyE');
      await page.waitForTimeout(900);
      const mounted = await page.evaluate(() => window.__gameDebug.mounted());
      info.mounted = mounted;
      await page.evaluate((c) => {
        const g = window.__gameDebug;
        g.setVitals({ hp: 100, stamina: 100 });
        if (c.offAxis) {
          // Decoy subject to the side, so the camera is not looking straight
          // down the jet. Rabbits are harmless and setPortraitSubject pins
          // them to idle so it will not bolt out of frame.
          const decoy = g.spawnEntity('rabbit', c.offAxis[0], c.offAxis[1]);
          if (decoy) g.setPortraitSubject(decoy.id);
        }
        g.setCamera(c.yaw, c.pitch, c.dist);
      }, s);
      await page.keyboard.down('KeyF');
      await page.waitForTimeout(1_400);
    }

    // Top the player up and dismiss any panel right before the shot. Both a
    // death overlay and an NPC chat panel render as a near-black screen and
    // are very easy to mistake for a broken frame — this harness produced one
    // of each before the checks below were added.
    // Not during a breath scene: breath is gated on `!panels.isOpen`, so an
    // Escape here toggles the menu open and shuts the fire off mid-shot.
    if (s.kind !== 'breath') {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(120);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
    await page.evaluate(() => window.__gameDebug.setVitals(
      { hp: 100, stamina: 100, warmth: 60, hunger: 80, thirst: 80 }));
    const err = await page.evaluate(() => window.__gameError);
    const stats = await page.evaluate(() => window.__gameStats);
    const dead = await page.evaluate(() =>
      (window.__gameDebug.vitals()?.hp ?? 100) <= 0);
    if (dead) console.log('  !! player is dead — frame is the death overlay');
    const file = path.join(outDir, `${s.name}.png`);
    await page.screenshot({ path: file });
    if (s.kind === 'breath') await page.keyboard.up('KeyF');

    log.push({ shot: log.length, beat: s.name, ...info, fps: stats?.fps,
      lights: stats?.worldLightCount, burning: stats?.burningTreeCount,
      billboards: stats?.fireBillboards });
    if (err) { console.log(`GPU ERROR: ${err}`); failed++; }
    else {
      console.log(`ok (fps ${Math.round(stats?.fps ?? 0)}, lights ${stats?.worldLightCount ?? '?'
        }, burning ${stats?.burningTreeCount ?? 0}, billboards ${
        stats?.fireBillboards ?? '?'}${info.mounted ? ', mounted' : ''})`
        + (info.warn ? `  WARN: ${info.warn}` : ''));
    }
  } catch (e) {
    console.log(`FAILED: ${String(e).split('\n')[0]}`);
    failed++;
  }
}

fs.writeFileSync(path.join(outDir, 'session.json'), JSON.stringify(log, null, 2));
await browser.close();
console.log(failed ? `${failed} scene(s) failed` : `all scenes captured -> ${outDir}`);
process.exit(failed ? 1 : 0);

// --- page-side scene builders ----------------------------------------------
// These run inside the page, so they cannot close over module scope — the
// flat-ground search arrives as the `flat` source string (see FLAT above).

function placeFireScene({ anchor, s, flat }) {
  const g = window.__gameDebug;
  const spot = (0, eval)(flat)(g, anchor[0], anchor[1]);
  g.teleport(spot.x, spot.z);
  const p = g.playerPos();
  // Put the fire between the eye and the player: eye = player - fwd*dist, and
  // fwdXZ = (-sin(yaw), -cos(yaw)), so player + (sin,cos)*lead lands on the
  // camera->player axis, `lead` metres in front of the player's feet.
  const fx = p[0] + Math.sin(s.yaw) * s.lead;
  const fz = p[2] + Math.cos(s.yaw) * s.lead;
  const id = g.placeFire(fx, fz, true);
  // No debug hook flips a campfire to a forge; mutate the record and let the
  // 5 s periodic rebuildFireDraws pick it up (the caller waits for it).
  if (s.forge) {
    const f = g.fires().find((q) => q.id === id);
    if (f) f.kind = 'forge';
  }
  g.setCamera(s.yaw, s.pitch, s.dist);
  const n = g.fires().length;
  return { at: [Math.round(fx), Math.round(fz)], fires: n,
    warn: n === 0 ? 'no fire placed' : '' };
}

function placeBurnScene({ anchor, s }) {
  const g = window.__gameDebug;
  g.teleportToNearestResource('tree');
  // Strike a ring of offsets so at least one lands on a tree.
  for (const [dx, dz] of [[0, -6], [6, 0], [-6, 0], [0, 6], [4, 4], [-4, -4],
    [9, 2], [-9, -2], [2, 9], [-2, -9]]) {
    g.triggerStrike(dx, dz, 'survivor');
  }
  const burning = g.burningTrees();
  if (burning.length === 0) return { warn: 'nothing ignited', burning: 0 };
  // Frame the nearest burning item: stand 7 m off it and look straight at it.
  const p = g.playerPos();
  let best = burning[0], bd = Infinity;
  for (const b of burning) {
    const d = (b.x - p[0]) ** 2 + (b.z - p[2]) ** 2;
    if (d < bd) { bd = d; best = b; }
  }
  const ang = Math.atan2(best.x - p[0], best.z - p[2]);
  const off = s.standoff ?? 6;
  g.teleport(best.x - Math.sin(ang) * off, best.z - Math.cos(ang) * off);
  // forwardXZ = (-sin(yaw), -cos(yaw)) must point from player toward the tree.
  g.setCamera(Math.atan2(-Math.sin(ang), -Math.cos(ang)), s.pitch, s.dist);
  return { at: [Math.round(best.x), Math.round(best.z)], burning: burning.length };
}

/** Village / building interior / dungeon: teleport in and look around. */
function placePlaceScene({ s }) {
  const g = window.__gameDebug;
  if (s.kind === 'village') {
    // The signpost, not the settlement centre: teleportToNearestSettlement
    // drops you flush against a keep wall and the camera ends up inside it.
    g.teleportToNearestSettlementSign();
    // Wildlife wandering into a settlement mauled the photographer and the
    // first "black screen" here turned out to be the death overlay, not a
    // render bug. Clear the area before shooting.
    for (const e of g.entities()) g.killEntity(e.id);
  } else if (s.kind === 'building') {
    g.enterNearestBuilding();
  } else {
    g.enterNearestDungeon();
  }
  g.setCamera(s.yaw, s.pitch, s.dist);
  const p = g.playerPos();
  return { at: [Math.round(p[0]), Math.round(p[2])] };
}

function placeBreathScene({ anchor, s, flat }) {
  const g = window.__gameDebug;
  const spot = (0, eval)(flat)(g, anchor[0], anchor[1]);
  g.teleport(spot.x, spot.z);
  const d = g.spawnEntity('dragon', 2.0, 0.5);
  g.setCamera(s.yaw, s.pitch, s.dist);
  return { at: [Math.round(spot.x), Math.round(spot.z)],
    dragon: d?.id ?? null, warn: d ? '' : 'no dragon spawned' };
}
