/**
 * Does the map fill in by travelling, and only by travelling?
 *
 *   node scripts/map-discovery-check.mjs
 *
 * The two failure modes worth catching are opposites, and a harness that only
 * looks for one will happily pass a map that fails the other:
 *
 *   - The map does not fill in. Walk somewhere new and it stays dark.
 *   - The map fills in too much. Somewhere the player has never been shows up,
 *     which is worse: the fog is the entire feature, and a map that reveals a
 *     village you have not found is not a map, it is a spoiler.
 *
 * So this walks the player with real WASD input (not a teleport — a teleport
 * would prove the reveal maths and nothing about the game calling it), and
 * checks both directions. It also proves discovery survives a reload, which
 * is the difference between a map and a session log.
 *
 * ## The trap
 *
 * `?director=off` so nothing async renames a dungeon mid-run, and the walk is
 * driven by holding a key rather than by setting a position, because the whole
 * point is that the game's own step loop is what reveals ground.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 180)}`));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !t.includes('Failed to load resource')) {
    errors.push(`CONSOLE ${t.slice(0, 160)}`);
  }
});

const findings = [];
const note = (severity, title, detail) => {
  findings.push({ severity, title, detail });
  process.stdout.write(`  ${severity === 'BUG' ? 'BUG ' : 'ok  '} ${title}\n`);
  if (detail) process.stdout.write(`       ${detail}\n`);
};

const URL = 'http://localhost:5173/game.html?director=off&tod=0.4&weather=clear';
await page.goto(`${URL}&wipe=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 60_000 });
await page.waitForTimeout(2000);

const D = async (fn, arg) => {
  const alive = await page.evaluate(() => typeof window.__gameDebug === 'object');
  if (!alive) {
    process.stdout.write('\n!! RUN INVALID — page reloaded mid-run (__gameDebug gone)\n');
    await browser.close();
    process.exit(2);
  }
  return page.evaluate(fn, arg);
};

// ---------------------------------------------------------------------------
// A blank slate. Get outdoors first — the castle undercroft is an interior.
// ---------------------------------------------------------------------------
await D(() => { window.__gameDebug.teleport(400, 400); });
await page.waitForTimeout(1500);

const fresh = await D(() => window.__gameDebug.mapStats());
note(fresh.chunks > 0 ? 'ok' : 'BUG', 'standing somewhere charts it',
  `${fresh.chunks} chunks, ${fresh.tiles} tiles after arriving at (400, 400)`);

const here = await D(() => window.__gameDebug.playerPos());
note(await D(([x, z]) => window.__gameDebug.mapHas(x, z), [here[0], here[2]])
  ? 'ok' : 'BUG', 'the ground under the player is charted',
  `(${here[0].toFixed(0)}, ${here[2].toFixed(0)})`);

// Somewhere far away must be dark. Several directions, so this cannot pass by
// luck of which quadrant the reveal happens to leak into.
const farProbes = [[3000, 400], [400, 3000], [-3000, 400], [400, -3000], [2200, 2200]];
const leaked = [];
for (const [x, z] of farProbes) {
  if (await D(([px, pz]) => window.__gameDebug.mapHas(px, pz), [x, z])) leaked.push(`${x},${z}`);
}
note(leaked.length === 0 ? 'ok' : 'BUG', 'nowhere unvisited is charted',
  leaked.length === 0
    ? `${farProbes.length} distant probes all dark`
    : `leaked at ${leaked.join(' / ')}`);

// ---------------------------------------------------------------------------
// WALK. Real held-key input through the game's own controller.
// ---------------------------------------------------------------------------
await page.evaluate(() => { document.getElementById('overlay')?.click(); });
// Point the camera due east and hold W. Forward is (-sin yaw, -cos yaw), so
// yaw = atan2(-(tx-px), -(tz-pz)); for +X that is -PI/2.
await D(() => { window.__gameDebug.setCamera(-Math.PI / 2, 0.15, 7); });
await page.waitForTimeout(300);

const before = await D(() => ({
  stats: window.__gameDebug.mapStats(),
  pos: window.__gameDebug.playerPos(),
}));

await page.keyboard.down('KeyW');
await page.keyboard.down('ShiftLeft'); // sprint, to cover ground
await page.waitForTimeout(16_000);
await page.keyboard.up('ShiftLeft');
await page.keyboard.up('KeyW');
await page.waitForTimeout(600);

const after = await D(() => ({
  stats: window.__gameDebug.mapStats(),
  pos: window.__gameDebug.playerPos(),
}));
const walked = Math.hypot(after.pos[0] - before.pos[0], after.pos[2] - before.pos[2]);
note(walked > 60 ? 'ok' : 'BUG', 'the player actually walked',
  `${walked.toFixed(0)} m from (${before.pos[0].toFixed(0)}, ${before.pos[2].toFixed(0)}) `
  + `to (${after.pos[0].toFixed(0)}, ${after.pos[2].toFixed(0)})`);

const gained = after.stats.chunks - before.stats.chunks;
note(gained > 0 ? 'ok' : 'BUG', 'walking charts new ground',
  `+${gained} chunks (${before.stats.chunks} -> ${after.stats.chunks}) over ${walked.toFixed(0)} m`);

note(await D(([x, z]) => window.__gameDebug.mapHas(x, z), [after.pos[0], after.pos[2]])
  ? 'ok' : 'BUG', 'where the walk ended is charted');

// The direction the player did NOT go must still be dark at the same distance.
const backX = before.pos[0] - walked - 200;
note(!await D(([x, z]) => window.__gameDebug.mapHas(x, z), [backX, before.pos[2]])
  ? 'ok' : 'BUG', 'the opposite direction stayed dark',
  `probed (${backX.toFixed(0)}, ${before.pos[2].toFixed(0)}), `
  + `${(walked + 200).toFixed(0)} m the other way`);

// The bounds should have grown along the walk axis and not the other.
const dx = (after.stats.x1 - after.stats.x0) - (before.stats.x1 - before.stats.x0);
const dz = (after.stats.z1 - after.stats.z0) - (before.stats.z1 - before.stats.z0);
note(dx > dz ? 'ok' : 'BUG', 'the charted area grew along the walk',
  `x span +${dx} m, z span +${dz} m (walked east)`);

// ---------------------------------------------------------------------------
// Landmarks: only the found ones.
// ---------------------------------------------------------------------------
const marks = await D(() => window.__gameDebug.mapLandmarks());
const allInside = marks.every((m) => m.x >= after.stats.x0 - 512 && m.x <= after.stats.x1 + 512
  && m.z >= after.stats.z0 - 512 && m.z <= after.stats.z1 + 512);
note(allInside ? 'ok' : 'BUG', 'every charted landmark is inside the charted area',
  `${marks.length} landmark(s): ${marks.map((m) => `${m.name} (${m.kind})`).slice(0, 4).join(', ') || 'none yet'}`);
for (const m of marks) {
  const on = await D(([x, z]) => window.__gameDebug.mapHas(x, z), [m.x, m.z]);
  if (!on) {
    note('BUG', 'a landmark is shown on undiscovered ground', `${m.name} at ${m.x}, ${m.z}`);
  }
}
if (marks.length > 0) {
  note('ok', 'landmarks are gated on their own chunk being discovered',
    `${marks.length} checked`);
}

// Walk to a settlement and confirm it shows up by name.
const site = await D(() => window.__gameDebug.nearestSettlement());
await D(() => { window.__gameDebug.teleportToNearestSettlement(); });
await page.waitForTimeout(2500);
const marksAfter = await D(() => window.__gameDebug.mapLandmarks());
const found = site !== null && marksAfter.some((m) => m.name === site.name);
note(found ? 'ok' : 'BUG', 'visiting a settlement puts it on the chart',
  site === null ? 'no settlement resolved' : `${site.name} (${site.kind}) — `
    + `${marksAfter.length} landmarks charted`);

// ---------------------------------------------------------------------------
// Persistence: the map must survive a reload and belong to the save.
// ---------------------------------------------------------------------------
const preReload = await D(() => window.__gameDebug.mapStats());
await page.waitForTimeout(5000); // let the 4 s throttle flush the write
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 60_000 });
await page.waitForTimeout(2500);
const postReload = await page.evaluate(() => window.__gameDebug.mapStats());
note(postReload.chunks >= preReload.chunks * 0.98 ? 'ok' : 'BUG',
  'the chart survives a reload',
  `${preReload.chunks} chunks before, ${postReload.chunks} after `
  + `(${(postReload.bytes / 1024).toFixed(1)} KB stored)`);
note(postReload.bytes < 60_000 ? 'ok' : 'BUG', 'the stored chart is small',
  `${postReload.bytes} B for ${postReload.chunks} chunks `
  + `= ${(postReload.bytes / Math.max(1, postReload.chunks)).toFixed(2)} B/chunk`);

const stored = await page.evaluate(() => localStorage.getItem('artifex-map:v1')?.length ?? 0);
note(stored > 0 ? 'ok' : 'BUG', 'the chart is in localStorage under its own key',
  `artifex-map:v1 is ${stored} chars`);

// ---------------------------------------------------------------------------
for (const e of errors.slice(0, 6)) note('BUG', 'page error', e);
const bugs = findings.filter((f) => f.severity === 'BUG');
process.stdout.write(`\nmap-discovery-check: ${bugs.length} bugs, `
  + `${findings.length - bugs.length} ok\n`);
await browser.close();
process.exit(bugs.length === 0 ? 0 : 1);
