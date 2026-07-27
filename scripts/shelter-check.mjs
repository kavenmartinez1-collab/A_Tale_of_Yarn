/**
 * Two "the world disagrees with itself" fixes, measured.
 *
 *   node scripts/shelter-check.mjs [baseUrl]
 *
 * 1. RAIN INDOORS. The castle is ordinary world geometry, not an interior
 *    arena, so nothing weather-driven ever asked whether there was a roof
 *    overhead: rain fell through three storeys of keep. The fix keys on
 *    `CastleCollider.isRoofed` — a CEILING test, not a "inside the castle
 *    bounds" test — so the courtyard, which is inside the walls and open to
 *    the sky, must stay wet. That beat is the one that catches the wrong fix.
 *
 * 2. CREATURES ON THE DRAWN GROUND. Entity ground contact read the RAW
 *    generated heightfield while the renderer draws the CARVED one (roads
 *    graded in, up to 2.5 m of cut and fill). Animals therefore stood on land
 *    that is not there any more. Measured as |entity.y - carvedGround| for
 *    every creature near a road, which is the error the player sees as feet
 *    sunk into the tarmac or floating above it.
 *
 * `__gameDebug.heightAt` is the RAW field and `groundHeightAt` is the CARVED
 * one. Using the wrong one here has produced false bug reports twice, so both
 * are read by name and both are printed.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const OUT = 'scripts/shots/shelter';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 560 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 180)}`));

const findings = [];
const note = (severity, title, detail) => {
  findings.push({ severity, title, detail });
  process.stdout.write(`  ${severity === 'BUG' ? 'BUG ' : 'ok  '} ${title}\n`);
  if (detail) process.stdout.write(`       ${detail}\n`);
};

await page.routeWebSocket(/:5173\//, () => { /* swallow HMR */ });
await page.goto(`${BASE}/game.html?director=off&tod=0.42&weather=rain`,
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

// ===========================================================================
process.stdout.write('=== 1. does rain stop at the roof (and only at the roof)? ===\n');
// ===========================================================================
const markers = await D(() => window.__gameDebug.castleMarkers());

/**
 * Roofed state and the rain level actually being handed to the renderer.
 *
 * `rainLevel` is read from the frame uniform the game builds, not inferred
 * from a screenshot: "it looks drier" is not a number, and the rain overlay is
 * a full-screen shader whose visible density at a given intensity depends on
 * where the camera is pointing.
 */
const readAt = async (marker) => {
  await D((m) => window.__gameDebug.castleTeleport(m), marker);
  await page.waitForTimeout(1400);   // the shelter blend eases over ~0.16 s
  return D(() => ({
    roofed: window.__gameDebug.castleRoofedHere(),
    rain: window.__gameDebug.frameRainLevel(),
    shelter: window.__gameDebug.shelterLevel(),
    pos: window.__gameDebug.playerPos(),
  }));
};

// Indoors: a hall with three storeys over it. Outdoors-but-inside-the-walls:
// the courtyard / front court, which is open to the sky.
const indoorMarkers = ['throne', 'L1hall', 'undercroftStairFoot']
  .filter((m) => markers.includes(m));
const openMarkers = ['frontCourt', 'wallDeckE', 'keepRoof']
  .filter((m) => markers.includes(m));

for (const m of indoorMarkers) {
  const r = await readAt(m);
  note(r.roofed && r.rain < 0.05 ? 'ok' : 'BUG',
    `${m}: under a roof, no rain drawn`,
    `roofed=${r.roofed} shelter=${r.shelter.toFixed(2)} rainLevel=${r.rain.toFixed(3)}`);
  writeFileSync(`${OUT}/in-${m}.png`, await page.screenshot());
}
for (const m of openMarkers) {
  const r = await readAt(m);
  // The wrong fix — keying on "inside the castle" rather than "under a
  // ceiling" — passes every indoor beat above and fails here.
  note(!r.roofed && r.rain > 0.9 ? 'ok' : 'BUG',
    `${m}: open to the sky, still raining`,
    `roofed=${r.roofed} shelter=${r.shelter.toFixed(2)} rainLevel=${r.rain.toFixed(3)}`);
  writeFileSync(`${OUT}/out-${m}.png`, await page.screenshot());
}

// The transition must RAMP, not cut.
if (indoorMarkers.length > 0 && openMarkers.length > 0) {
  await D((m) => window.__gameDebug.castleTeleport(m), indoorMarkers[0]);
  await page.waitForTimeout(1500);
  const trace = await page.evaluate(async (m) => {
    const g = window.__gameDebug;
    g.castleTeleport(m);
    const out = [];
    for (let i = 0; i < 40; i++) {
      out.push(g.frameRainLevel());
      await new Promise((r) => requestAnimationFrame(r));
    }
    return out;
  }, openMarkers[0]);
  const jumps = trace.slice(1).map((v, i) => Math.abs(v - trace[i]));
  const worst = Math.max(...jumps);
  note(worst < 0.5 ? 'ok' : 'BUG',
    'stepping out of the keep RAMPS the rain rather than cutting it',
    `largest single-frame change ${worst.toFixed(3)}`
    + ` (${trace[0].toFixed(2)} -> ${trace[trace.length - 1].toFixed(2)})`);
}

// ===========================================================================
process.stdout.write('\n=== 2. do creatures stand on the ground that is drawn? ===\n');
// ===========================================================================
{
  // FIND THE CUTTING, do not hope to wander onto one.
  //
  // The first version teleported to a village and measured whatever wildlife
  // happened to be near: 27 creatures, none of them standing anywhere the
  // ground had been carved by more than a centimetre, so it proved nothing and
  // said so. A road cutting is exactly "carved minus raw", and both fields are
  // exposed by name, so the disagreement can simply be searched for.
  await D(() => window.__gameDebug.teleportToNearestSettlement('village'));
  await page.waitForTimeout(9000);

  const spot = await D(() => {
    const g = window.__gameDebug;
    const p = g.playerPos();
    let best = null;
    for (let dx = -260; dx <= 260; dx += 4) {
      for (let dz = -260; dz <= 260; dz += 4) {
        const x = p[0] + dx;
        const z = p[2] + dz;
        const carved = g.groundHeightAt(x, z);
        if (carved < 1) continue;                       // not in the sea
        const carve = Math.abs(carved - g.heightAt(x, z));
        if (best === null || carve > best.carve) best = { x, z, carve, carved };
      }
    }
    return best;
  });
  process.stdout.write(`       deepest carve found nearby: ${spot.carve.toFixed(2)} m`
    + ` at ${spot.x.toFixed(0)}, ${spot.z.toFixed(0)}\n`);

  if (spot.carve < 0.3) {
    note('BUG', 'no road cutting deep enough to measure against near this village',
      `worst |carved - raw| ${spot.carve.toFixed(2)} m`);
  } else {
    await D(([x, z]) => window.__gameDebug.teleport(x, z), [spot.x, spot.z]);
    await page.waitForTimeout(6000);

    // Put creatures ON the cutting and let their own tick decide where their
    // feet go. Placement is at the RAW height on purpose — that is where the
    // old code would have left them, so anything that moves them onto the
    // carved surface is the tick doing its job rather than the probe's setup.
    const ids = await D(([x, z]) => {
      const g = window.__gameDebug;
      const out = [];
      for (let i = 0; i < 5; i++) {
        const ox = x + (i - 2) * 1.5;
        const id = g.placeEntity('deer', ox, g.heightAt(ox, z), z);
        if (id !== null) { g.holdEntity(id, true); out.push(id); }
      }
      return out;
    }, [spot.x, spot.z]);
    await page.waitForTimeout(2500);   // several ticks of ground contact

    const rows = await D((eids) => {
      const g = window.__gameDebug;
      return eids.map((id) => {
        const e = g.entities().find((q) => q.id === id);
        if (e === undefined) return null;
        return {
          y: e.y,
          carved: g.groundHeightAt(e.x, e.z),
          raw: g.heightAt(e.x, e.z),
        };
      }).filter((r) => r !== null);
    }, ids);
    await D((eids) => { for (const id of eids) window.__gameDebug.removeEntity(id); }, ids);

    if (rows.length === 0) {
      note('BUG', 'could not place creatures on the cutting');
    } else {
      const offCarved = rows.map((r) => Math.abs(r.y - r.carved));
      const offRaw = rows.map((r) => Math.abs(r.y - r.raw));
      const worstCarved = Math.max(...offCarved);
      const worstRaw = Math.max(...offRaw);
      const carve = Math.max(...rows.map((r) => Math.abs(r.carved - r.raw)));
      note(worstCarved < 0.2 && worstRaw > worstCarved ? 'ok' : 'BUG',
        'creatures settle onto the CARVED surface, the one the renderer draws',
        `${rows.length} deer on a ${carve.toFixed(2)} m cutting:`
        + ` worst |y - carved| ${worstCarved.toFixed(3)} m,`
        + ` worst |y - RAW| ${worstRaw.toFixed(3)} m`
        + ` (before the fix those two would be the other way round)`);
    }
  }
}

const bugs = findings.filter((f) => f.severity === 'BUG');
process.stdout.write(`\n${bugs.length} bug(s), ${findings.length - bugs.length} ok\n`);
if (errors.length) process.stdout.write(`page errors: ${errors.slice(0, 4).join(' | ')}\n`);
await browser.close();
process.exit(bugs.length > 0 ? 1 : 0);
