/**
 * dungeon-enemies-shot.mjs — photograph the enemy roster where it actually
 * lives: inside a dungeon, under torchlight, at the scale the player meets it.
 *
 * Usage:  node scripts/dungeon-enemies-shot.mjs [outDir]
 * Requires `npm run dev` (port 5173).
 *
 * WHY THIS EXISTS SEPARATELY FROM creature-portraits.mjs
 *
 * The portrait harness shoots on a hillside in daylight, which is the right
 * place to judge a MODEL and the wrong place to judge an ENEMY. Everything
 * that makes these four read — the emissive eyes, the bone against stone, a
 * goblin's size against a corridor, whether a torch-lit room is legible enough
 * to fight in — only exists underground.
 *
 * The distrust rule from the repo's other harnesses applies and is honoured
 * the same way: this script does not assume it photographed anything. It reads
 * back `__gameDebug.dungeonEntities()` after each shot and prints the species,
 * distance and screen-relevant state of what was actually in front of the
 * camera, so a frame of empty corridor is reported as a frame of empty
 * corridor rather than as a success.
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve(process.argv[2] ?? 'scripts/shots/dungeon-enemies');
mkdirSync(OUT, { recursive: true });

/** Camera distance for a given standing height, so every subject frames alike. */
const distFor = (size) => Math.max(2.4, 2.9 * size);

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

await page.goto('http://localhost:5173/game.html?tod=0.5&weather=clear');
await page.waitForFunction(() => window.__gameReady === true, { timeout: 60_000 });

const pending = [];
const report = [];

// Walk several dungeon cells until we find one with a boss in it — the boss
// room is the shot that matters most and not every spec has one.
let entered = false;
for (const [tx, tz] of [[240, -300], [1200, 400], [-800, 900], [3600, 60], [2000, -1500]]) {
  const ok = await page.evaluate(async ([x, z]) => {
    const g = window.__gameDebug;
    g.teleport(x, z);
    await new Promise((r) => setTimeout(r, 400));
    if (!g.teleportToNearestEntrance()) return false;
    await new Promise((r) => setTimeout(r, 400));
    return g.enterNearestDungeon();
  }, [tx, tz]);
  if (!ok) continue;
  await page.waitForTimeout(900);
  const has = await page.evaluate(() =>
    (window.__gameDebug.dungeonEntities() ?? []).length);
  if (has > 0) { entered = true; break; }
}

if (!entered) {
  console.error('FAILED: could not enter a populated dungeon');
  await browser.close();
  process.exit(1);
}

const roster = await page.evaluate(() =>
  window.__gameDebug.dungeonEntities().map((e) => ({
    id: e.id, species: e.species, x: e.x, y: e.y, z: e.z, hp: e.hp,
    boss: e.boss === true,
  })));
console.log(`dungeon holds ${roster.length}: ${
  [...new Set(roster.map((r) => r.species))].join(', ')}`);

// One shot per distinct species, plus the boss room.
const seen = new Set();
const wanted = [];
for (const r of roster) {
  if (r.boss) { wanted.push({ ...r, label: 'boss' }); continue; }
  if (seen.has(r.species)) continue;
  seen.add(r.species);
  wanted.push({ ...r, label: r.species });
}

const SIZE = { goblin: 1.2, goblin_archer: 1.2, skeleton: 1.9, dread_king: 2.7 };

for (const w of wanted) {
  // Bring the SUBJECT to the camera, not the camera to the subject.
  //
  // The obvious way round is `teleport(x, z)` — and it silently ruins the
  // shot, which is worth recording because the first version of this script
  // did exactly that and reported success. `teleport` snaps the player to
  // TERRAIN height; a dungeon interior lives at y = -300 in a slot arena far
  // below the world. So the player was flung to the surface while the readback
  // — which measures XZ distance in dungeon-origin coordinates — happily
  // reported the boss "4.1 m away". Every frame was ceiling and sky.
  //
  // `dungeonEntities()` hands back the LIVE enemy array, so an enemy can be
  // walked to a spot in front of the camera instead, with its mode pinned to
  // idle so the room clamp never gets a chance to drag it home.
  const d = distFor(SIZE[w.species] ?? 1.5);
  const state = await page.evaluate(async ([dist, id]) => {
    const g = window.__gameDebug;
    const p = g.playerPos();
    const ents = g.dungeonEntities();
    const me = ents.find((e) => e.id === id);
    if (me === undefined) return { found: false, near: [] };
    // Park everything else well out of frame so the subject is unambiguous.
    // Their room rects are widened too, or the clamp walks them straight back
    // into shot.
    for (const e of ents) {
      if (e === me) continue;
      e.roomX = p[0] + 300; e.roomZ = p[2] + 300; e.roomW = 60; e.roomD = 60;
      e.x = p[0] + 330;
      e.z = p[2] + 330;
      e.mode = 'idle';
      e.stateTimer = 999;
    }
    // Enemies are hard-clamped to their spawn room by `tickEnemies` — that is
    // a feature (it is what makes a room a fight) and it is also why simply
    // assigning a position does not stick: the very next tick drags them home,
    // and the second version of this script filmed a boss 15.6 m away while
    // reporting that it had placed him at 4. Widening the rect around the
    // CAMERA lets him legitimately walk into frame instead, and then his own
    // aggro AI parks him at attack range, which is the distance the player
    // actually fights him at.
    //
    // Placement copies `creature-portraits.mjs` exactly — subject on +X,
    // camera yaw 90 — because that pairing is KNOWN to frame a subject in
    // this engine. Deriving the orbit camera's yaw convention from first
    // principles is how the previous attempt ended up photographing a blank
    // wall while its own readback cheerfully reported the boss 4.7 m away.
    me.roomX = p[0] - 30; me.roomZ = p[2] - 30; me.roomW = 60; me.roomD = 60;
    me.x = p[0] + dist * 2;
    me.z = p[2];
    me.mode = 'aggro';
    me.stateTimer = 999;   // no swinging while it walks in
    g.setPortraitSubject(me.id);
    // Camera on the OPPOSITE side from the subject, or the orbit arm puts the
    // lens inside his chest — which is what a 2.8 m arm did against a boss
    // standing at 4.5 m, and the resulting frame is a wall of back-faces that
    // looks like a shader bug rather than a framing mistake.
    g.setCamera(-Math.PI / 2, 0.10, Math.max(2.0, dist * 0.5));
    await new Promise((r) => setTimeout(r, 2600));
    const p2 = g.playerPos();
    const now = g.dungeonEntities().find((e) => e.id === id);
    return {
      playerPos: p2,
      found: now !== undefined,
      dist: now ? Math.hypot(now.x - p2[0], now.z - p2[2]) : -1,
      mode: now?.mode ?? null,
      hp: now?.hp ?? null,
      near: g.dungeonEntities()
        .filter((e) => Math.hypot(e.x - p2[0], e.z - p2[2]) < dist * 2.2)
        .map((e) => `${e.species}@${Math.hypot(e.x - p2[0], e.z - p2[2]).toFixed(1)}m`),
    };
  }, [d, w.id]);

  const buf = await page.screenshot();
  pending.push([`${w.label}.png`, buf]);
  report.push({ label: w.label, species: w.species, ...state });
  console.log(`  ${w.label.padEnd(14)} ${state.found ? 'in room' : 'MISSING'} `
    + `d=${state.dist.toFixed(1)}m mode=${state.mode} `
    + `visible: ${state.near.join(' ') || 'NOTHING'}`);
}

await browser.close();
for (const [name, buf] of pending) writeFileSync(resolve(OUT, name), buf);
writeFileSync(resolve(OUT, 'session.json'),
  JSON.stringify({ roster, report, pageErrors }, null, 1));

console.log(`\n${pending.length} shots -> ${OUT}`);
if (pageErrors.length > 0) {
  console.error(`PAGE ERRORS (${pageErrors.length}):`);
  for (const e of pageErrors.slice(0, 5)) console.error('  ' + e);
  process.exitCode = 1;
}
const blind = report.filter((r) => r.near.length === 0);
if (blind.length > 0) {
  console.error(`WARNING: ${blind.length} shot(s) had nothing in range — `
    + 'those frames are empty corridor, not evidence.');
  process.exitCode = 1;
}
