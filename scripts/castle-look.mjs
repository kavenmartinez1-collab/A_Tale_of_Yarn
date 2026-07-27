/**
 * Film every room of Castle Vhaeron, and the castle from four points outside
 * it, without playing the opening. ~2 minutes.
 *
 *   node scripts/castle-look.mjs [outDir]        (default scripts/shots/castle-look)
 *
 * ## Why this exists alongside castle-escape.mjs
 *
 * `castle-escape.mjs` is the route proof and it stays the route proof. But it
 * has to trip the alarm to demonstrate the aggro transition, and once the
 * castle is hunting, the walk back past the garrison gets the player killed —
 * reliably, in both runs of the art pass. Every beat from 19 on then comes back
 * behind a full-screen "You Died" overlay at about 15 % brightness, which is
 * useless as a picture of a room. This harness never leaves the footprint and
 * never teleports out, so the alarm stays dormant and the shots stay lit.
 *
 * ## Camera conventions, which have cost this repo hours
 *
 * The orbit camera sits BEHIND the player, so `yaw` here is "which way is the
 * player facing", not "which way is the camera looking": forward is
 * `(-sin yaw, -cos yaw)`, and to look at (tx, tz) from (px, pz) the yaw is
 * `atan2(-(tx - px), -(tz - pz))`. Indoors keep the distance under about 11 m
 * and the pitch small and positive — a camera set side-on in a 22 m hall ends
 * up outside the wall photographing the cladding, and one set at 8 m behind a
 * throne on a dais ends up inside the wall behind it.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const outDir = process.argv[2] || 'scripts/shots/castle-look';
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
// Other agents edit this repo live; every file they save pushes a vite HMR
// reload that would otherwise wipe __gameDebug mid-tour. This harness never
// re-navigates after the first `goto` below, so one reload anywhere in the
// ~2 minute run would silently blank every room shot after it.
await page.routeWebSocket(/:5173\//, () => { /* swallow HMR */ });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`));

await page.goto('http://localhost:5173/game.html?wipe=1&director=off&tod=0.34&weather=clear',
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 90_000 });
await page.waitForTimeout(2500);

let n = 0;
async function snap(name, note) {
  await page.waitForTimeout(700);
  const file = `${outDir}/${String(n++).padStart(2, '0')}-${name}.png`;
  fs.writeFileSync(file, await page.screenshot());
  const p = await page.evaluate(() => window.__gameDebug.playerPos());
  const st = await page.evaluate(() => window.__gameStats ?? {});
  console.log(`${file.split('/').pop().padEnd(30)} pos [${p.map((v) => v.toFixed(0))}] `
    + `fps=${st.fps ?? '?'} ${note ?? ''}`);
}

// Interiors: `castleTeleport` puts the player at the marker; the camera is set
// per room. Positive pitch (~0.4) at 5-7 m works indoors — a side-on camera in a
// 22 m hall ends up outside the wall photographing the cladding.
const ROOMS = [
  ['spawn', -1.5708, 0.16, 5.5],
  ['chest', 1.5708, 0.18, 6.0],
  ['L1hall', 0.0, 0.14, 11.0],
  ['L2hall', 3.14, 0.14, 11.0],
  ['throne', 0.0, 0.06, 10.0],
  ['keepRoof', 0.0, -0.22, 15.0],
  ['towerBase', -1.5708, -0.05, 11.0],
  ['arena', -1.735, -0.14, 15.0],
  ['frontCourt', 3.14, -0.20, 20.0],
  ['gatehouse', 3.14, -0.18, 22.0],
  ['backCourt', 0.0, -0.10, 18.0],
];
for (const [m, yaw, pitch, d] of ROOMS) {
  const ok = await page.evaluate((mm) => window.__gameDebug.castleTeleport(mm), m);
  if (!ok) { console.log(`  !! no marker ${m}`); continue; }
  await page.waitForTimeout(500);
  await page.evaluate(([y, p, dd]) => window.__gameDebug.setCamera(y, p, dd),
    [yaw, pitch, d]);
  await snap(m, ok ? '' : 'MISSING');
}

// Outside: stand off the castle at four distances and look back at it.
//
// There is no `castleCentre()` hook — calling it silently returned `undefined`
// (optional-chained), so this always fell through to a hardcoded
// `[-320, 0, 40]` that happened to be right for this seed and would go stale
// the moment the site moved. Derive it from a marker instead:
// `castle-layout.ts`'s own header says local space is centred ON THE KEEP, and
// `scripts/_probe-castle-centre.mjs` confirmed `L1hall`/`L2hall`/`L3hall` all
// report world X/Z `-320.0, 40.0` — bit-identical to the old literal, because
// they sit stacked on that very central axis. `L1hall` is already used above
// as a room marker, so it is guaranteed to exist.
const centre = await page.evaluate(() => window.__gameDebug.castleMarkerPos('L1hall'));
if (centre === null) throw new Error('no L1hall marker — cannot find the castle centre');
for (const [name, dx, dz, dist, pitch] of [
  ['hillside-e', 180, 60, 26, -0.10],
  ['hillside-ne', 150, -150, 30, -0.12],
  ['near-gate', 30, -150, 22, -0.16],
  ['far-se', 320, 260, 40, -0.06],
]) {
  const tx = centre[0] + dx; const tz = centre[2] + dz;
  await page.evaluate(([x, z]) => window.__gameDebug.teleport(x, z), [tx, tz]);
  await page.waitForTimeout(2200);
  await page.evaluate(([cx, cz, p, d]) => {
    const [px, , pz] = window.__gameDebug.playerPos();
    window.__gameDebug.setCamera(Math.atan2(-(cx - px), -(cz - pz)), p, d);
  }, [centre[0], centre[2], pitch, dist]);
  await snap(name);
}

if (errors.length > 0) console.log(`\n${errors.length} error(s):`, errors.slice(0, 5));
else console.log('\nno page errors');
await browser.close();
