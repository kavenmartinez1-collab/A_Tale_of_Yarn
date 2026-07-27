/**
 * Settlement capture harness — photographs every settlement kind from a
 * useful angle plus close passes through a town street and a castle
 * approach, so the community pass can actually be looked at.
 *
 *   node scripts/settlement-shots.mjs [outDir] [nameFilter]
 *
 * Requires the vite dev server on :5173 (npx vite).
 *
 * Anti-self-deception: every shot prints the settlement the game thinks the
 * player is standing in *after* the frame settles, the player's distance from
 * the intended centre, and the frame's fps/chunk count. A shot that reports
 * the wrong kind, or a distance that says the camera is pointing at empty
 * moorland, is a failed shot no matter how pretty the PNG is. (A portrait
 * harness in this repo once photographed the back of the player's head for a
 * whole session while reporting success; and reading nearestSettlement() in
 * the same tick as the teleport returns the settlement you *left*, because
 * SettlementManager only refreshes its cached position on the next update.)
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] || 'scripts/shots/settlements';
const filter = process.argv[3] || '';

/**
 * Exact site centres for world seed 1337 (main.ts:402), computed offline from
 * src/game/settlement/settlement-scatter. Hard coordinates beat a search:
 * `teleportToNearestSettlement(kind)` only sees cells already streamed in, so
 * hunting for the nearest town (2 km from spawn) by teleporting around either
 * misses it or silently lands somewhere else and reports success.
 */
// Re-resolved 2026-07-26 when settlement siting became river-aware: every one
// of these moved except the ruin, and the castle is the forced near-spawn pin,
// which changed cells outright. Coordinates are settlement CENTRES from
// `settlementSiteAt` on seed 1337 — re-derive them, do not nudge them by hand,
// or a shot ends up framed on empty ground next to the town it names.
const SITES = {
  ruins: [-151, 641],
  ranch: [-190, 239],
  village: [100, -660],
  town: [1172, -2674],
  castle: [-242, -320],
};

/**
 * off:   [dx, dz] from the settlement centre to stand at, or 'sign' to use
 *        the settlement's own signpost (village street mouth / town gate /
 *        castle-town entrance).
 * look:  'centre' aims the camera from the player toward the settlement
 *        centre; a number is an absolute yaw in degrees.
 * cam:   [pitchDeg, distance]. Positive pitch lifts the eye.
 */
const SHOTS = [
  { name: '01-ruins', kind: 'ruins', off: [0, 0], look: 30, cam: [42, 46], q: 'tod=0.62' },
  { name: '02-ranch', kind: 'ranch', off: [0, 0], look: 35, cam: [34, 56], q: 'tod=0.60' },
  { name: '03-village', kind: 'village', off: [0, 0], look: 40, cam: [34, 76], q: 'tod=0.58' },
  { name: '04-village-street', kind: 'village', off: 'sign', look: 'centre', cam: [6, 7], q: 'tod=0.60' },
  { name: '05-village-green', kind: 'village', off: [0, 0], look: 200, cam: [8, 11], q: 'tod=0.60' },
  { name: '06-town', kind: 'town', off: [0, 0], look: 40, cam: [36, 105], q: 'tod=0.56' },
  { name: '07-town-square', kind: 'town', off: [0, 7], look: 180, cam: [7, 12], q: 'tod=0.56' },
  { name: '08-town-street', kind: 'town', off: 'sign', look: 'centre', cam: [5, 8], q: 'tod=0.56' },
  { name: '09-castle', kind: 'castle', off: [0, -14], look: 25, cam: [34, 135], q: 'tod=0.55' },
  { name: '10-castle-approach', kind: 'castle', off: [0, -58], look: 'centre', cam: [6, 10], q: 'tod=0.55' },
  { name: '11-castle-town', kind: 'castle', off: [0, -48], look: 40, cam: [30, 62], q: 'tod=0.55' },
  { name: '12-castle-gate', kind: 'castle', off: [0, -40], look: 'centre', cam: [10, 14], q: 'tod=0.55' },
  { name: '13-castle-bailey', kind: 'castle', off: [0, -16], look: 'centre', cam: [26, 30], q: 'tod=0.55' },
  { name: '14-castle-keep', kind: 'castle', off: [-17, -9], look: 110, cam: [12, 20], q: 'tod=0.55' },
  { name: '15-village-night', kind: 'village', off: [0, 0], look: 40, cam: [22, 46], q: 'tod=0.02' },
  { name: '16-castle-night', kind: 'castle', off: [0, -40], look: 'centre', cam: [10, 22], q: 'tod=0.02' },
  { name: '18-town-fields', kind: 'town', off: [-24, -16], look: 250, cam: [16, 22], q: 'tod=0.56' },
  { name: '17-town-dawn', kind: 'town', off: [0, 22], look: 190, cam: [14, 34], q: 'tod=0.28' },
];

fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !t.includes('Failed to load resource')) {
    errors.push(t.slice(0, 200));
  }
});

let failures = 0;
for (const s of SHOTS) {
  if (filter && !s.name.includes(filter)) continue;
  process.stdout.write(`→ ${s.name} ... `);
  try {
    await page.goto(`http://localhost:5173/game.html?director=off&weather=clear&${s.q}`,
      { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 60_000 });
    await page.waitForTimeout(800);

    const [sx, sz] = SITES[s.kind];
    // Land on the settlement first and let it discover + mesh itself.
    await page.evaluate(([x, z]) => window.__gameDebug.teleport(x, z), [sx, sz]);
    await page.waitForTimeout(2_500);

    const info = await page.evaluate(async (shot) => {
      const dbg = window.__gameDebug;
      const [cx, cz] = shot.site;
      let px, pz;
      if (shot.off === 'sign') {
        dbg.teleportToNearestSettlementSign();
        const q = dbg.playerPos();
        px = q[0]; pz = q[2];
      } else {
        px = cx + shot.off[0];
        pz = cz + shot.off[1];
        dbg.teleport(px, pz);
      }
      let yaw;
      if (shot.look === 'centre') {
        const dx = cx - px, dz = cz - pz;
        const l = Math.hypot(dx, dz) || 1;
        yaw = Math.atan2(-dx / l, -dz / l);
      } else {
        yaw = shot.look * Math.PI / 180;
      }
      dbg.setCamera(yaw, shot.cam[0] * Math.PI / 180, shot.cam[1]);
      return { cx, cz, px, pz, dist: Math.hypot(px - cx, pz - cz) };
    }, { ...s, site: [sx, sz] });

    await page.waitForTimeout(4_500);
    const err = await page.evaluate(() => window.__gameError);
    if (err) { console.log(`GPU ERROR: ${err}`); failures++; continue; }
    // Read the settlement AFTER the settle: SettlementManager caches the
    // player position per tick, so an immediate read names the last one.
    const after = await page.evaluate(() => ({
      stats: window.__gameStats,
      site: window.__gameDebug.nearestSettlement(),
      pos: window.__gameDebug.playerPos(),
    }));
    await page.screenshot({ path: path.join(outDir, `${s.name}.png`) });
    const site = after.site;
    const drift = Math.hypot(after.pos[0] - info.px, after.pos[2] - info.pz);
    const kindOk = site && site.kind === s.kind;
    console.log(
      `${kindOk ? 'ok ' : 'WRONG KIND'} ${site ? `${site.name} (${site.kind})` : 'none'}` +
      `  stand ${info.px.toFixed(0)},${info.pz.toFixed(0)} (${info.dist.toFixed(0)} m from centre` +
      `, drift ${drift.toFixed(1)} m)  fps ${Math.round(after.stats?.fps ?? 0)}` +
      `  chunks ${after.stats?.chunkCount ?? 0}`);
    if (!kindOk) failures++;
  } catch (e) {
    console.log(`FAILED: ${String(e).split('\n')[0].slice(0, 200)}`);
    failures++;
  }
}

await browser.close();
if (errors.length) {
  console.log(`\n${errors.length} page error(s):`);
  for (const e of errors.slice(0, 8)) console.log('  ' + e);
} else {
  console.log('\nno page errors');
}
console.log(failures ? `${failures} shot(s) failed` : `all shots captured → ${outDir}`);
process.exit(failures ? 1 : 0);
