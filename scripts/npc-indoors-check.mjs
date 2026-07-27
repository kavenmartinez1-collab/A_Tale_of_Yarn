/**
 * In-game verification that NPCs have an inside to their buildings.
 *
 *   node scripts/npc-indoors-check.mjs [outDir]
 *
 * Why this exists rather than another unit test: the unit tests prove the join
 * key is consistent and the standing spots are geometrically sound, but they
 * cannot prove the person is actually THERE when you open the door. That needs
 * the real settlement stream, the real building manager, and the real draw
 * path — the three things that were previously wired so that no NPC could ever
 * appear indoors.
 *
 * It checks, at night and at midday:
 *   1. somebody withdraws indoors at all,
 *   2. they stop being drawn on the street when they do,
 *   3. entering their building puts them in the room with you,
 *   4. and they are close enough to talk to.
 *
 * Screenshots are written so the result can be looked at, not just counted.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] || 'scripts/shots/npc-indoors';
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 300)}`));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !t.includes('Failed to load resource')) {
    errors.push(`CONSOLE ${t.slice(0, 200)}`);
  }
});

let failures = 0;
const say = (ok, msg) => {
  if (!ok) failures++;
  process.stdout.write(`${ok ? '  ok  ' : '  FAIL'} ${msg}\n`);
};

/** tod 0.90 is deep night; 0.50 is midday. */
for (const [label, tod] of [['night', 0.90], ['midday', 0.50]]) {
  process.stdout.write(`\n=== ${label} (tod=${tod}) ===\n`);

  await page.goto(`http://localhost:5173/game.html?director=off&tod=${tod}&weather=clear`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__gameReady === true, undefined,
    { timeout: 60_000 });
  await page.waitForTimeout(1200);

  await page.evaluate(() => window.__gameDebug.teleportToNearestSettlementSign());
  // Let the settlement stream in and the schedule settle.
  await page.waitForTimeout(2500);

  const outside = await page.evaluate(() => ({
    homes: window.__gameDebug.npcHomes(),
    inside: window.__gameDebug.insideBuilding(),
    settlement: window.__gameDebug.nearestSettlement()?.name ?? null,
  }));

  say(outside.homes.length > 0,
    `${outside.homes.length} NPCs loaded near ${outside.settlement}`);
  say(!outside.inside, 'starts outdoors');

  const withHome = outside.homes.filter((h) => h.pad >= 0);
  say(withHome.length > 0, `${withHome.length} have a home pad`);

  const indoors = outside.homes.filter((h) => h.indoors);
  process.stdout.write(
    `       indoors: ${indoors.length}/${outside.homes.length}` +
    ` — ${indoors.slice(0, 4).map((h) => `${h.name}(${h.padType})`).join(', ') || 'none'}\n`);

  if (label === 'night') {
    // The whole point: at night the street empties into the houses.
    say(indoors.length > 0, 'somebody is indoors at night');
  } else {
    // By day only shopkeepers should be in; the street should still be busy.
    say(indoors.length < outside.homes.length,
      `most NPCs are still outdoors at midday (${outside.homes.length - indoors.length} out)`);
  }

  // Nobody indoors may be standing in the street being drawn.
  say(indoors.every((h) => !h.inArena),
    'nobody is flagged in-arena while the player is outside');

  await page.screenshot({ path: path.join(outDir, `${label}-street.png`) });

  // --- open a door and see who is home -------------------------------------
  // Only NPCs whose home has a door are candidates. Guards are stationed at
  // jail/tower pads, and jail is deliberately not enterable — visiting one of
  // those falls back to a hash-chosen house and tests nothing.
  const ENTERABLE = new Set(['house', 'barn', 'stable', 'keep', 'tower',
    'gatehouse', 'church', 'tavern', 'longhouse', 'smithy']);
  const visitable = (h) => h.pad >= 0 && ENTERABLE.has(h.padType);
  // Prefer a keeper of a public building — that is the case the whole feature
  // exists for (walk into the tavern, the keeper is behind the bar), and it is
  // the one that has to hold at midday as well as at night.
  const WORK = new Set(['tavern', 'smithy', 'church', 'longhouse']);
  const target = indoors.find((h) => visitable(h) && WORK.has(h.padType))
    ?? indoors.find(visitable)
    ?? withHome.find(visitable);
  if (target === undefined) {
    say(false, 'no NPC with an enterable home to visit');
    continue;
  }

  const entered = await page.evaluate(
    (id) => window.__gameDebug.enterNpcHome(id), target.id);
  say(entered, `entered ${target.name}'s ${target.padType}`);
  await page.waitForTimeout(1500);

  const inside = await page.evaluate(() => ({
    inside: window.__gameDebug.insideBuilding(),
    building: window.__gameDebug.occupiedBuilding(),
    homes: window.__gameDebug.npcHomes(),
    near: window.__gameDebug.nearestNpc(),
    pos: window.__gameDebug.playerPos(),
  }));

  say(inside.inside, 'player is inside a building');
  say(inside.building !== null &&
      inside.building.padIndex === target.pad &&
      inside.building.settlementName === target.settlement,
    `the building is ${target.name}'s own` +
    ` (pad ${inside.building?.padIndex} vs home ${target.pad})`);

  const inRoom = inside.homes.filter((h) => h.inArena);
  process.stdout.write(
    `       in the room: ${inRoom.map((h) => h.name).join(', ') || 'nobody'}` +
    ` (${inside.building?.kind})\n`);

  // An empty house at midday is the CORRECT answer, not a failure — the owner
  // is out working. Only assert presence when the target was actually indoors.
  const targetWasIn = target.indoors;
  if (targetWasIn) {
    say(inRoom.length > 0, 'somebody is in the room with the player');
    say(inRoom.some((h) => h.id === target.id),
      `${target.name} specifically is in the room`);
  } else {
    say(inRoom.length === 0,
      `${target.name} is out, so their ${target.padType} is correctly empty`);
    process.stdout.write('       (nobody home by day — the owner is out; this is expected)\n');
  }

  const occupant = targetWasIn ? inRoom.find((h) => h.id === target.id) : undefined;
  if (occupant !== undefined) {
    const d0 = Math.hypot(occupant.x - inside.pos[0], occupant.z - inside.pos[2]);
    process.stdout.write(`       ${target.name} is ${d0.toFixed(2)} m from the door\n`);
    // An interior is at most ~16 m across; anything beyond that means the NPC
    // landed in a different building's arena slot, not this room.
    say(d0 < 20, `${target.name} is in this room, not a neighbouring arena slot`);

    await page.screenshot({ path: path.join(outDir, `${label}-indoors-entry.png`) });

    // The headline claim: you open the door and the person is right there,
    // already close enough to press E on. This is what the door-distance
    // ranking in standingSpots() exists to guarantee.
    say(inside.near !== null && inside.near.id === target.id,
      `${target.name} is talkable the moment you walk in` +
      ` (E targets ${inside.near?.name ?? 'nobody'})`);

    // And moving around indoors must not break it. Walk toward them and check
    // the prompt still holds. Forward is (-sin yaw, -cos yaw) in the camera
    // frame — see controller.ts; getting this backwards walks you away.
    await page.evaluate(([ox, oz]) => {
      const p = window.__gameDebug.playerPos();
      window.__gameDebug.setCamera(Math.atan2(-(ox - p[0]), -(oz - p[2])), -0.12, 4.2);
    }, [occupant.x, occupant.z]);
    await page.keyboard.down('KeyW');
    let reached = false;
    for (let step = 0; step < 24 && !reached; step++) {
      await page.waitForTimeout(250);
      reached = await page.evaluate((id) => {
        const n = window.__gameDebug.nearestNpc();
        return n !== null && n.id === id;
      }, target.id);
    }
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(300);

    const after = await page.evaluate(() => ({
      near: window.__gameDebug.nearestNpc(),
      pos: window.__gameDebug.playerPos(),
      inside: window.__gameDebug.insideBuilding(),
      prompt: window.__gameDebug.interactPrompt(),
    }));
    const d1 = Math.hypot(occupant.x - after.pos[0], occupant.z - after.pos[2]);
    process.stdout.write(`       walked to ${d1.toFixed(2)} m\n`);
    say(after.inside, 'still inside after walking (did not fall out of the room)');
    say(after.near !== null && after.near.id === target.id,
      `walked up to ${target.name} and can talk (E targets ${after.near?.name ?? 'nobody'})`);

    // The HUD has to agree with the key. A tavern bar has a chest beside it,
    // and the building's prompt used to win unconditionally — so the screen
    // read "Press E to open the chest" while standing on the keeper.
    process.stdout.write(`       HUD says: ${JSON.stringify(after.prompt)}\n`);
    say(after.prompt !== null && after.prompt.includes(target.name),
      `the HUD offers ${target.name} rather than the furniture`);

    // A shot you can actually judge.
    //
    // The orbit camera sits BEHIND the player, so a screenshot taken at eye
    // level while facing the NPC is a screenshot of the player's back with the
    // NPC hidden behind it — the same trap that had an earlier harness here
    // filing back views as portraits. Orbiting side-on does not help either:
    // in a 9x7 m room the camera ends up outside the wall looking at cladding.
    // Looking DOWN over the player's shoulder (positive pitch) is the framing
    // that shows both of them in the room. This is how the NPC turned out not
    // to be rendered at all, with every counter reading green.
    await page.evaluate(([ox, oz]) => {
      const p = window.__gameDebug.playerPos();
      window.__gameDebug.setCamera(
        Math.atan2(-(ox - p[0]), -(oz - p[2])), 0.55, 4.5);
    }, [occupant.x, occupant.z]);
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(outDir, `${label}-occupant.png`) });
  }

  await page.screenshot({ path: path.join(outDir, `${label}-indoors.png`) });
}

await browser.close();

if (errors.length > 0) {
  process.stdout.write(`\n${errors.length} console/page errors:\n`);
  for (const e of errors.slice(0, 10)) process.stdout.write(`  ${e}\n`);
  failures += errors.length;
}

process.stdout.write(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — shots in ${outDir}\n`);
process.exit(failures > 0 ? 1 : 0);
